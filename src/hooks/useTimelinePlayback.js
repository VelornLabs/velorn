import { useEffect, useRef, useCallback } from 'react'
import useTimelineStore from '../stores/timelineStore'
import { getCurrentPlaybackJump, PLAYBACK_JUMP_TIMEOUT_MS } from '../utils/playbackJump.mjs'
import { getCurrentPlayAround } from '../utils/playAround.mjs'
import { getPlaybackReviewRange } from '../utils/playbackReviewRange.mjs'
import { selectFramePlayhead } from '../utils/framePlayhead.mjs'

const selectIsPlaying = (state) => state.isPlaying
const selectSetPlayheadPosition = (state) => state.setPlayheadPosition
const selectTogglePlay = (state) => state.togglePlay
const selectShuttlePause = (state) => state.shuttlePause
const selectGetActiveClipAtTime = (state) => state.getActiveClipAtTime
const selectGetTransitionAtTime = (state) => state.getTransitionAtTime
const selectGetTimelineEndTime = (state) => state.getTimelineEndTime
const selectClips = (state) => state.clips
const selectTracks = (state) => state.tracks
const selectTransitions = (state) => state.transitions

const getSelectedLoopRange = (clips, selectedClipIds) => {
  if (!Array.isArray(clips) || clips.length === 0) return null
  if (!Array.isArray(selectedClipIds) || selectedClipIds.length === 0) return null

  const selectedSet = new Set(selectedClipIds)
  const selectedClips = clips.filter((clip) => selectedSet.has(clip.id))
  if (selectedClips.length === 0) return null

  let start = Infinity
  let end = -Infinity
  for (const clip of selectedClips) {
    const clipStart = Number(clip.startTime)
    const clipDuration = Math.max(0, Number(clip.duration) || 0)
    if (!Number.isFinite(clipStart)) continue
    const clipEnd = clipStart + clipDuration
    start = Math.min(start, clipStart)
    end = Math.max(end, clipEnd)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return { start: Math.max(0, start), end: Math.max(0, end) }
}

/**
 * Hook to manage timeline playback
 * Advances the playhead and provides playback state
 */
export function useTimelinePlayback({ playbackRange = null, cancelPlayAroundOnUnmount = true } = {}) {
  const animationFrameRef = useRef(null)
  const lastTimeRef = useRef(performance.now())
  const activeClipRef = useRef(null)
  const optionsRef = useRef(null)
  optionsRef.current = { playbackRange, cancelPlayAroundOnUnmount }
  
  // The transport loop below reads the live store itself. What this hook
  // returns for display follows playback one timeline frame at a time rather
  // than on every animation-frame write, so its host is not re-rendered on
  // each of those writes. Plain per-field selectors keep this file free of
  // React-only helpers (its tests run it against a stub store).
  const isPlaying = useTimelineStore(selectIsPlaying)
  const setPlayheadPosition = useTimelineStore(selectSetPlayheadPosition)
  const togglePlay = useTimelineStore(selectTogglePlay)
  const shuttlePause = useTimelineStore(selectShuttlePause)
  const getActiveClipAtTime = useTimelineStore(selectGetActiveClipAtTime)
  const getTransitionAtTime = useTimelineStore(selectGetTransitionAtTime)
  const getTimelineEndTime = useTimelineStore(selectGetTimelineEndTime)
  const playheadPosition = useTimelineStore(selectFramePlayhead)
  // Subscribed so the active clip returned below is recomputed after an edit.
  useTimelineStore(selectClips)
  useTimelineStore(selectTracks)
  useTimelineStore(selectTransitions)

  // Get active clip info at current position
  const getPlaybackState = useCallback((time) => {
    const activeClip = getActiveClipAtTime(time)
    const transitionInfo = getTransitionAtTime(time)
    const endTime = getTimelineEndTime()
    const baseScale = activeClip?.sourceTimeScale || (activeClip?.timelineFps && activeClip?.sourceFps
      ? activeClip.timelineFps / activeClip.sourceFps
      : 1)
    const speed = Number(activeClip?.speed)
    const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
    const timeScale = baseScale * speedScale
    const reverse = !!activeClip?.reverse
    const trimStart = activeClip?.trimStart || 0
    const rawTrimEnd = activeClip?.trimEnd ?? activeClip?.sourceDuration ?? trimStart
    const trimEnd = Number.isFinite(rawTrimEnd) ? rawTrimEnd : trimStart
    
    return {
      activeClip,
      transitionInfo,
      endTime,
      // Calculate the time within the source video
      sourceTime: activeClip 
        ? (reverse
          ? trimEnd - (time - activeClip.startTime) * timeScale
          : trimStart + (time - activeClip.startTime) * timeScale)
        : 0
    }
  }, [getActiveClipAtTime, getTransitionAtTime, getTimelineEndTime])

  // Track ping-pong direction (1 = forward, -1 = reverse)
  const pingPongDirectionRef = useRef(1)

  // Reset synchronously on request/release, not after a React render. Decoder
  // wait time must never become a large first transport step after landing.
  // The watchdog also covers a missing renderer or a cache video that errors
  // before any presentation callback; the request token makes old timers inert.
  useEffect(() => {
    let timeout = null
    let watchedToken = null
    const observe = (state, previous = null) => {
      // Authored edits, direct replacements and range/context changes retire
      // the audition without seeking back into a document the user has left.
      if (state.playAround && !getCurrentPlayAround(state)) {
        state.cancelPlayAround(state.playAround.token)
        return
      }
      const request = getCurrentPlaybackJump(state)
      const previousRequest = getCurrentPlaybackJump(previous)
      if (request !== previousRequest || state.isPlaying !== previous?.isPlaying
        || state.playbackRate !== previous?.playbackRate || state.timelineSessionId !== previous?.timelineSessionId) {
        lastTimeRef.current = performance.now()
      }
      if ((request?.token || null) === watchedToken) return
      if (timeout !== null) clearTimeout(timeout)
      timeout = null
      watchedToken = request?.token || null
      if (request) {
        const remaining = Math.max(0, PLAYBACK_JUMP_TIMEOUT_MS - (Date.now() - request.requestedAt))
        timeout = setTimeout(() => {
          timeout = null
          useTimelineStore.getState().failPlaybackJump(request.token,
            'The requested playback frame did not become ready.')
        }, remaining)
      }
    }
    observe(useTimelineStore.getState())
    const unsubscribe = useTimelineStore.subscribe(observe)
    return () => {
      unsubscribe()
      if (timeout !== null) clearTimeout(timeout)
      if (optionsRef.current.cancelPlayAroundOnUnmount) useTimelineStore.getState().cancelPlayAround?.()
    }
  }, [])

  // Main playback loop with JKL shuttle support and loop modes
  const tick = useCallback(() => {
    const now = performance.now()
    const deltaMs = now - lastTimeRef.current
    lastTimeRef.current = now
    
    // Convert to seconds and apply playback rate (supports reverse with negative rate)
    const state = useTimelineStore.getState()
    if (!state.isPlaying) return
    if (getCurrentPlaybackJump(state)) {
      animationFrameRef.current = requestAnimationFrame(tick)
      return
    }
    // A review surface plays its requested output range once, independently
    // of editor loop/selection preferences. It uses the same clock and jump
    // readiness barrier above, without changing any authored timeline state.
    if (optionsRef.current.playbackRange) {
      const range = getPlaybackReviewRange(optionsRef.current.playbackRange, state.getTimelineEndTime(),
        optionsRef.current.playbackRange.fps || state.timelineFps)
      const rate = Number(state.playbackRate) || 1
      const nextPosition = state.playheadPosition + (deltaMs / 1000) * rate
      if (range.duration <= 0 || (rate > 0 && nextPosition >= range.end) || (rate < 0 && nextPosition <= range.start)) {
        setPlayheadPosition(rate < 0 ? range.start : range.lastFrame, { source: 'transport' })
        shuttlePause()
        return
      }
      setPlayheadPosition(Math.max(range.start, nextPosition), { source: 'transport' })
      if (useTimelineStore.getState().isPlaying) animationFrameRef.current = requestAnimationFrame(tick)
      return
    }
    const audition = getCurrentPlayAround(state)
    if (audition) {
      const nextPosition = state.playheadPosition + deltaMs / 1000
      if (nextPosition >= audition.endTime) {
        state.finishPlayAround(audition.token)
        return
      }
      setPlayheadPosition(nextPosition, { source: 'transport' })
      if (useTimelineStore.getState().isPlaying) animationFrameRef.current = requestAnimationFrame(tick)
      return
    }
    const { loopMode, inPoint, outPoint } = state
    const selectionLoopRange = getSelectedLoopRange(state.clips, state.selectedClipIds)
    const effectiveLoopMode = loopMode === 'loop-selection' && !selectionLoopRange
      ? 'normal'
      : loopMode
    
    // For ping-pong mode, apply direction
    let effectiveRate = state.playbackRate
    if (effectiveLoopMode === 'ping-pong') {
      effectiveRate = Math.abs(state.playbackRate) * pingPongDirectionRef.current
    }
    
    const deltaSeconds = (deltaMs / 1000) * effectiveRate
    let newPosition = state.playheadPosition + deltaSeconds
    let discontinuity = false
    const endTime = state.getTimelineEndTime()
    
    // Determine loop boundaries
    const loopStart = effectiveLoopMode === 'loop-selection'
      ? selectionLoopRange.start
      : ((effectiveLoopMode === 'loop-in-out' && inPoint !== null) ? inPoint : 0)
    const loopEnd = effectiveLoopMode === 'loop-selection'
      ? selectionLoopRange.end
      : ((effectiveLoopMode === 'loop-in-out' && outPoint !== null) ? outPoint : endTime)
    
    // Handle end of timeline (forward playback)
    if (newPosition >= loopEnd && loopEnd > 0 && effectiveRate > 0) {
      switch (effectiveLoopMode) {
        case 'loop':
        case 'loop-in-out':
        case 'loop-selection':
          // Loop back to start
          newPosition = loopStart
          discontinuity = true
          break
        case 'ping-pong':
          // Reverse direction
          pingPongDirectionRef.current = -1
          newPosition = loopEnd - (newPosition - loopEnd)
          break
        default:
          // Normal mode - stop at end
          setPlayheadPosition(loopEnd, { source: 'transport' })
          if (state.isPlaying) {
            shuttlePause()
          }
          return
      }
    }
    
    // Handle start of timeline (reverse playback)
    if (newPosition <= loopStart && effectiveRate < 0) {
      switch (effectiveLoopMode) {
        case 'loop':
        case 'loop-in-out':
        case 'loop-selection':
          // Loop to end
          newPosition = loopEnd
          discontinuity = true
          break
        case 'ping-pong':
          // Reverse direction
          pingPongDirectionRef.current = 1
          newPosition = loopStart + (loopStart - newPosition)
          break
        default:
          // Normal mode - stop at start
          setPlayheadPosition(loopStart, { source: 'transport' })
          if (state.isPlaying) {
            shuttlePause()
          }
          return
      }
    }
    
    setPlayheadPosition(Math.max(loopStart, Math.min(loopEnd, newPosition)), { source: 'transport', discontinuity })
    
    // Continue loop if still playing
    if (useTimelineStore.getState().isPlaying) {
      animationFrameRef.current = requestAnimationFrame(tick)
    }
  }, [setPlayheadPosition, shuttlePause])

  // Start/stop playback loop based on isPlaying
  useEffect(() => {
    if (isPlaying) {
      lastTimeRef.current = performance.now()
      animationFrameRef.current = requestAnimationFrame(tick)
    } else {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
    
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [isPlaying, tick])

  // Sync video element with timeline position
  const syncVideoToTimeline = useCallback((videoRef, clip, currentTime) => {
    if (!videoRef || !clip) return
    
    const baseScale = clip.sourceTimeScale || (clip.timelineFps && clip.sourceFps
      ? clip.timelineFps / clip.sourceFps
      : 1)
    const speed = Number(clip.speed)
    const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
    const timeScale = baseScale * speedScale
    const reverse = !!clip.reverse
    const trimStart = clip.trimStart || 0
    const rawTrimEnd = clip.trimEnd ?? clip.sourceDuration ?? trimStart
    const trimEnd = Number.isFinite(rawTrimEnd) ? rawTrimEnd : trimStart
    const sourceTime = reverse
      ? trimEnd - (currentTime - clip.startTime) * timeScale
      : trimStart + (currentTime - clip.startTime) * timeScale
    
    // Only seek if difference is significant (> 0.1s) to avoid constant seeking
    if (Math.abs(videoRef.currentTime - sourceTime) > 0.1) {
      videoRef.currentTime = sourceTime
    }
  }, [])

  // Get current playback info
  const playbackInfo = getPlaybackState(playheadPosition)

  return {
    isPlaying,
    playheadPosition,
    activeClip: playbackInfo.activeClip,
    transitionInfo: playbackInfo.transitionInfo,
    sourceTime: playbackInfo.sourceTime,
    endTime: playbackInfo.endTime,
    syncVideoToTimeline,
    togglePlay,
  }
}

export default useTimelinePlayback
