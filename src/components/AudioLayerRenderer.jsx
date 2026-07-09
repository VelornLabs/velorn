import { useEffect, useRef, useMemo } from 'react'
import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import { getAudioClipFadeGain } from '../utils/audioClipFades'
import { getAudioClipLinearGain } from '../utils/audioClipGain'
import {
  hasAudioSolo,
  isAudioTrackAudible,
  trackVolumeToLinearGain,
} from '../utils/audioTrackAudibility'
import { getAudioInsertsSignature } from '../utils/audioInserts'
import { buildInsertChain } from '../services/audioInsertChain'
import {
  registerMixerGraph,
  unregisterMixerGraph,
  setTrackAnalyser,
  removeTrackAnalyser,
  setInsertMeters,
} from '../services/audioMixerGraph'

/**
 * AudioLayerRenderer - Manages audio playback for audio clips on the timeline
 *
 * This component handles:
 * - Playing audio clips that are active at the current playhead position
 * - Syncing audio playback with timeline position
 * - Respecting track muting, solo, and visibility
 * - Handling multiple overlapping audio clips
 *
 * Graph topology (desk order — inserts BEFORE the fader; the mixer reads its
 * meters from this graph via audioMixerGraph; audioInsertChain.js is the
 * shared DSP that export mixdowns run too):
 *
 *   clip source → clip gain (clip gain × fades)
 *     → track bus input → track inserts → track fader → track analyser
 *       → master bus input → master inserts
 *         → program gain (master fader, part of the program: export applies it too)
 *           → master analyser → monitor gain (app volume knob, preview-only)
 *             → destination
 */
function AudioLayerRenderer() {
  const audioElementsRef = useRef(new Map()) // clipId -> { element, currentSrc, sourceNode, gainNode, trackId }
  const trackBusesRef = useRef(new Map()) // trackId -> { input, chain, chainSignature, fader, analyser }
  const isPlayingRef = useRef(false)
  const audioContextRef = useRef(null)
  const masterBusInputRef = useRef(null)
  const masterChainRef = useRef(null)
  const masterChainSignatureRef = useRef(null)
  const programGainRef = useRef(null)
  const monitorGainRef = useRef(null)

  const {
    clips,
    tracks,
    isPlaying,
    playheadPosition,
    playbackRate,
    masterAudioVolume,
    masterAudioInserts,
    getActiveClipsAtTime,
  } = useTimelineStore()

  const getAssetById = useAssetsStore(state => state.getAssetById)
  const volume = useAssetsStore(state => state.volume) // Monitor volume from assets store

  // Keep isPlayingRef in sync so event handlers always have current value
  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])

  useEffect(() => {
    let audioContext = null
    try {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext
      if (!AudioContextCtor) return undefined

      audioContext = new AudioContextCtor()
      const masterBusInput = audioContext.createGain()
      const programGain = audioContext.createGain()
      const masterAnalyser = audioContext.createAnalyser()
      masterAnalyser.fftSize = 2048
      masterAnalyser.smoothingTimeConstant = 0.2
      const monitorGain = audioContext.createGain()

      // Master insert chain is wired between masterBusInput and programGain
      // by syncMasterChain() in the main effect below.
      programGain.connect(masterAnalyser)
      masterAnalyser.connect(monitorGain)
      monitorGain.connect(audioContext.destination)

      audioContextRef.current = audioContext
      masterBusInputRef.current = masterBusInput
      programGainRef.current = programGain
      monitorGainRef.current = monitorGain
      masterChainRef.current = null
      masterChainSignatureRef.current = null
      registerMixerGraph({ context: audioContext, masterAnalyser })
    } catch (err) {
      console.warn('Failed to initialize preview audio context:', err)
    }

    return () => {
      unregisterMixerGraph(audioContext)
      masterChainRef.current?.dispose?.()
      masterChainRef.current = null
      masterChainSignatureRef.current = null
      trackBusesRef.current.forEach((bus) => bus.chain?.dispose?.())
      trackBusesRef.current.clear()
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {})
      }
      audioContextRef.current = null
      masterBusInputRef.current = null
      programGainRef.current = null
      monitorGainRef.current = null
    }
  }, [])

  useEffect(() => {
    const audioContext = audioContextRef.current
    if (audioContext && audioContext.state === 'suspended' && isPlaying) {
      audioContext.resume().catch(() => {})
    }
  }, [isPlaying])

  // (Re)build the master insert chain when masterAudioInserts change
  const syncMasterChain = () => {
    const audioContext = audioContextRef.current
    const masterBusInput = masterBusInputRef.current
    const programGain = programGainRef.current
    if (!audioContext || !masterBusInput || !programGain) return

    const signature = getAudioInsertsSignature(masterAudioInserts)
    if (signature === masterChainSignatureRef.current) return

    try {
      masterBusInput.disconnect()
    } catch (_) {}
    masterChainRef.current?.dispose?.()

    try {
      const chain = buildInsertChain(audioContext, masterAudioInserts)
      masterBusInput.connect(chain.input)
      chain.output.connect(programGain)
      masterChainRef.current = chain
      masterChainSignatureRef.current = signature
      setInsertMeters('master', chain.meters)
    } catch (err) {
      console.warn('Failed to build master insert chain, bypassing:', err)
      masterBusInput.connect(programGain)
      masterChainRef.current = null
      masterChainSignatureRef.current = signature
      setInsertMeters('master', [])
    }
  }

  // Lazily create the per-track bus (insert chain + fader gain + meter analyser)
  const ensureTrackBus = (trackId) => {
    const audioContext = audioContextRef.current
    const masterBusInput = masterBusInputRef.current
    if (!audioContext || !masterBusInput || !trackId) return null

    let bus = trackBusesRef.current.get(trackId)
    if (bus) return bus

    try {
      const input = audioContext.createGain()
      const fader = audioContext.createGain()
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.2
      // Insert chain wired between input and fader by syncTrackChain
      fader.connect(analyser)
      analyser.connect(masterBusInput)
      bus = { input, chain: null, chainSignature: null, fader, analyser }
      trackBusesRef.current.set(trackId, bus)
      setTrackAnalyser(trackId, analyser)
      return bus
    } catch (err) {
      console.warn('Failed to create track audio bus:', err)
      return null
    }
  }

  // (Re)build a track's insert chain when its inserts change
  const syncTrackChain = (bus, track) => {
    const audioContext = audioContextRef.current
    if (!audioContext || !bus) return

    const signature = getAudioInsertsSignature(track.inserts)
    if (signature === bus.chainSignature) return

    try {
      bus.input.disconnect()
    } catch (_) {}
    bus.chain?.dispose?.()

    try {
      const chain = buildInsertChain(audioContext, track.inserts)
      bus.input.connect(chain.input)
      chain.output.connect(bus.fader)
      bus.chain = chain
      bus.chainSignature = signature
      setInsertMeters(track.id, chain.meters)
    } catch (err) {
      console.warn('Failed to build track insert chain, bypassing:', err)
      bus.input.connect(bus.fader)
      bus.chain = null
      bus.chainSignature = signature
      setInsertMeters(track.id, [])
    }
  }

  // Drop buses for tracks that no longer exist
  useEffect(() => {
    const liveTrackIds = new Set((tracks || []).filter(t => t.type === 'audio').map(t => t.id))
    for (const [trackId, bus] of trackBusesRef.current.entries()) {
      if (!liveTrackIds.has(trackId)) {
        bus.chain?.dispose?.()
        try {
          bus.input.disconnect()
          bus.fader.disconnect()
          bus.analyser.disconnect()
        } catch (_) {}
        trackBusesRef.current.delete(trackId)
        removeTrackAnalyser(trackId)
        setInsertMeters(trackId, [])
      }
    }
  }, [tracks])

  // Get active audio clips at current playhead position (solo-aware)
  const activeAudioClips = useMemo(() => {
    const anySolo = hasAudioSolo(tracks)
    const allActive = getActiveClipsAtTime(playheadPosition)
    return allActive
      .filter(({ track }) => track.type === 'audio' && isAudioTrackAudible(track, anySolo))
      .map(({ clip, track }) => ({ clip, track }))
  }, [playheadPosition, getActiveClipsAtTime, tracks])

  // Create/update audio elements for active clips
  useEffect(() => {
    const audioEntries = audioElementsRef.current

    // Remove audio elements for clips that are no longer active
    const activeClipIds = new Set(activeAudioClips.map(({ clip }) => clip.id))
    for (const [clipId, entry] of audioEntries.entries()) {
      if (!activeClipIds.has(clipId)) {
        entry.element.pause()
        entry.element.src = ''
        entry.sourceNode?.disconnect()
        entry.gainNode?.disconnect()
        audioEntries.delete(clipId)
      }
    }

    syncMasterChain()

    // Keep bus chains + faders in sync with track state (also covers fader
    // moves and insert edits while nothing on the track is playing).
    for (const track of tracks || []) {
      if (track.type !== 'audio') continue
      const bus = trackBusesRef.current.get(track.id)
      if (bus) {
        syncTrackChain(bus, track)
        bus.fader.gain.value = trackVolumeToLinearGain(track.volume ?? 100)
      }
    }

    if (programGainRef.current) {
      programGainRef.current.gain.value = trackVolumeToLinearGain(masterAudioVolume ?? 100)
    }
    if (monitorGainRef.current && Number.isFinite(volume)) {
      monitorGainRef.current.gain.value = Math.max(0, volume)
    }

    // Create/update audio elements for active clips
    activeAudioClips.forEach(({ clip, track }) => {
      const asset = getAssetById(clip.assetId)
      if (!asset?.url) return

      let entry = audioEntries.get(clip.id)

      if (!entry) {
        const audioEl = new Audio()
        audioEl.preload = 'auto'
        audioEl.crossOrigin = 'anonymous'
        entry = {
          element: audioEl,
          currentSrc: null,
          sourceNode: null,
          gainNode: null,
          trackId: null,
        }

        const audioContext = audioContextRef.current
        const bus = ensureTrackBus(track.id)
        if (audioContext && bus) {
          try {
            syncTrackChain(bus, track)
            const sourceNode = audioContext.createMediaElementSource(audioEl)
            const gainNode = audioContext.createGain()
            sourceNode.connect(gainNode)
            gainNode.connect(bus.input)
            entry.sourceNode = sourceNode
            entry.gainNode = gainNode
            entry.trackId = track.id
          } catch (err) {
            console.warn('Failed to connect preview audio through Web Audio:', err)
          }
        }

        audioEntries.set(clip.id, entry)
      } else if (entry.gainNode && entry.trackId !== track.id) {
        // Clip moved to a different audio track: reroute through the new bus
        const bus = ensureTrackBus(track.id)
        if (bus) {
          try {
            syncTrackChain(bus, track)
            entry.gainNode.disconnect()
            entry.gainNode.connect(bus.input)
            entry.trackId = track.id
          } catch (err) {
            console.warn('Failed to reroute clip audio to new track bus:', err)
          }
        }
      }

      const audioEl = entry.element

      // Check if src actually changed (compare against our tracked src, not browser-resolved URL)
      const srcChanged = entry.currentSrc !== asset.url
      if (srcChanged) {
        audioEl.src = asset.url
        entry.currentSrc = asset.url
      }

      // Calculate source time within the audio file (with speed/reverse)
      const clipTime = playheadPosition - clip.startTime
      const speed = Number(clip.speed)
      const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
      const reverse = !!clip.reverse
      const trimStart = clip.trimStart || 0
      const rawTrimEnd = clip.trimEnd ?? clip.sourceDuration ?? trimStart
      const trimEnd = Number.isFinite(rawTrimEnd) ? rawTrimEnd : trimStart
      const minTime = Math.min(trimStart, trimEnd)
      const maxTime = Math.max(trimStart, trimEnd)
      const sourceTime = reverse
        ? trimEnd - clipTime * speedScale
        : trimStart + clipTime * speedScale
      const clampedTime = Math.max(minTime, Math.min(sourceTime, maxTime - 0.01))

      // Check if we're within the clip's active range
      const clipEnd = clip.startTime + clip.duration
      const isWithinClip = playheadPosition >= clip.startTime && playheadPosition < clipEnd

      // Reverse audio not supported with HTMLAudioElement; keep silent
      if (reverse) {
        audioEl.pause()
        return
      }

      const effectiveRate = Math.abs(playbackRate) * speedScale

      if (srcChanged) {
        // Remove any prior loadeddata handlers to avoid stale closures
        const onLoadedData = () => {
          // Read from ref to get current isPlaying state (not stale closure)
          const currentlyPlaying = isPlayingRef.current
          if (isWithinClip && currentlyPlaying) {
            audioEl.currentTime = clampedTime
            audioEl.playbackRate = effectiveRate
            audioEl.play().catch(err => {
              console.warn('Failed to play audio clip:', err)
            })
          }
        }
        // Use { once: true } to auto-remove the listener
        audioEl.addEventListener('loadeddata', onLoadedData, { once: true })
      } else if (audioEl.readyState >= 2) {
        // Audio is loaded - sync position
        const timeDiff = Math.abs(audioEl.currentTime - clampedTime)
        if (timeDiff > 0.1) {
          audioEl.currentTime = clampedTime
        }

        // Set playback rate
        if (Math.abs(audioEl.playbackRate - effectiveRate) > 0.01) {
          audioEl.playbackRate = effectiveRate
        }

        // Play/pause based on timeline state and clip boundaries
        if (isPlaying && isWithinClip) {
          if (audioEl.paused) {
            audioEl.play().catch(err => {
              console.warn('Failed to play audio clip:', err)
            })
          }
        } else {
          if (!audioEl.paused) {
            audioEl.pause()
          }
        }
      }

      const fadeGain = getAudioClipFadeGain(clip, clipTime)
      const clipGain = getAudioClipLinearGain(clip) * fadeGain

      if (entry.gainNode) {
        entry.gainNode.gain.value = Math.max(0, clipGain)
        audioEl.volume = 1
      } else {
        // No Web Audio: approximate the whole chain on the element itself
        // (inserts can't run here — gain staging only)
        const trackGain = trackVolumeToLinearGain(track.volume ?? 100)
        const masterGain = trackVolumeToLinearGain(masterAudioVolume ?? 100)
        const fallbackVolume = Math.max(0, Math.min(1, volume * clipGain * trackGain * masterGain))
        audioEl.volume = fallbackVolume
      }
    })
  }, [activeAudioClips, playheadPosition, isPlaying, playbackRate, getAssetById, clips, tracks, volume, masterAudioVolume, masterAudioInserts])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const audioEntries = audioElementsRef.current
      for (const entry of audioEntries.values()) {
        entry.element.pause()
        entry.element.src = ''
        entry.sourceNode?.disconnect()
        entry.gainNode?.disconnect()
      }
      audioEntries.clear()
    }
  }, [])

  // This component doesn't render anything visible
  return null
}

export default AudioLayerRenderer
