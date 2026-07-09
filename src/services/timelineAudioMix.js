// Mix down the timeline's program audio (video clips' audio tracks + audio-only
// clips) into a single mono 16 kHz WAV Blob suitable for ASR transcription.
//
// Two execution paths, same return shape:
//   1. (Preferred) Electron + FFmpeg via the `captions:mixTimelineAudio` IPC.
//      The mix happens in the main process, which is the only safe place to
//      decode long / multi-hundred-MB video containers. Doing this in the
//      renderer via OfflineAudioContext.decodeAudioData caused Chromium
//      renderer crashes (black screen) on real-world timelines — mp4 decode
//      buffers the whole container in V8 heap before extracting the audio.
//   2. (Fallback) Renderer-side Web Audio mix, used in browsers / dev envs
//      where the IPC isn't available. This path keeps the original logic but
//      is best-effort only — it will still OOM on very large video sources.
//
// Why mono 16 kHz:
//   Qwen3-ASR is trained at 16 kHz mono. Matching those settings gives the
//   best inference speed, smallest upload payload, and cleanest model input.
//
// What we include / exclude:
//   * `video` clips whose asset has audio enabled (not `hasAudio === false`
//     and not `audioEnabled === false`) — source material's dialogue.
//   * `audio` clips (voiceover, music, etc.) respecting track mute / volume.
//   * Clip trims, timeline positions, and track mute/visibility flags are
//     honoured so the mix matches what the viewer hears on playback.

import { useTimelineStore } from '../stores/timelineStore'
import { useAssetsStore } from '../stores/assetsStore'
import { useProjectStore } from '../stores/projectStore'
import { audioBufferToWav } from './exporter'
import { applySoloAsMute, hasAudioSolo, isAudioTrackAudible } from '../utils/audioTrackAudibility'

// Qwen3-ASR native rate. Sticking to 16k saves ~2/3 of the upload size vs
// 44.1/48k without losing any transcription accuracy.
const ASR_SAMPLE_RATE = 16000
const ASR_CHANNELS = 1

// Cap the mix duration we'll ASR so a user who accidentally sits on an
// hour-long timeline doesn't upload 100 MB of audio. 20 minutes is well above
// any real short-form video; long-form users can still work around this by
// transcribing timeline ranges once we expose range selection.
const MAX_TRANSCRIBE_SECONDS = 20 * 60

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function clipHasUsableAudio(clip, asset) {
  if (!asset) return false
  if (clip.type === 'audio') return true
  if (clip.type !== 'video') return false
  if (asset.hasAudio === false) return false
  if (asset.audioEnabled === false) return false
  // Clip-level audio mute overrides asset level.
  if (clip.audioEnabled === false) return false
  return true
}

function computeProgramDuration(clips) {
  let end = 0
  for (const clip of clips) {
    const start = Number(clip.startTime) || 0
    const dur = Math.max(0, Number(clip.duration) || 0)
    if (start + dur > end) end = start + dur
  }
  return end
}

/**
 * Gather the clip / track / asset metadata we send to the FFmpeg IPC. We keep
 * the payload minimal (no DOM refs, no functions) so structured clone is cheap
 * and no unexpected references leak into the main process.
 */
function buildIpcPayload({ duration }) {
  const timelineState = useTimelineStore.getState()
  const assetsState = useAssetsStore.getState()

  const clips = (timelineState.clips || []).map((clip) => ({
    id: clip.id,
    assetId: clip.assetId,
    trackId: clip.trackId,
    type: clip.type,
    startTime: clip.startTime,
    duration: clip.duration,
    trimStart: clip.trimStart || 0,
    sourceTimeScale: clip.sourceTimeScale,
    timelineFps: clip.timelineFps,
    sourceFps: clip.sourceFps,
    speed: clip.speed,
    reverse: !!clip.reverse,
    enabled: clip.enabled !== false,
    audioEnabled: clip.audioEnabled,
    url: clip.url || null,
  }))

  // Fold solo into muted so the FFmpeg IPC (which only understands mute)
  // hears the same tracks the preview graph plays.
  const tracks = applySoloAsMute(timelineState.tracks || []).map((track) => ({
    id: track.id,
    type: track.type,
    muted: !!track.muted,
    visible: track.visible !== false,
  }))

  const assets = (assetsState.assets || []).map((asset) => ({
    id: asset.id,
    type: asset.type,
    path: asset.path || null,
    absolutePath: asset.absolutePath || null,
    url: asset.url || null,
    hasAudio: asset.hasAudio,
    audioEnabled: asset.audioEnabled,
  }))

  return { clips, tracks, assets, duration }
}

/**
 * Preferred path: ask the main process (FFmpeg) to produce the WAV file, then
 * read the result back into a Blob. Runs with flat memory regardless of input
 * video size.
 */
async function mixViaFFmpeg({ duration, report }) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.mixTimelineAudioForCaptions || !api?.readFileAsBuffer) return null

  const projectHandle = useProjectStore.getState().currentProjectHandle
  const projectPath = typeof projectHandle === 'string' ? projectHandle : ''

  // FFmpeg gives us no structured progress events here — emit a heartbeat so
  // the UI doesn't look frozen while the mix runs.
  let heartbeat = null
  try {
    report('Mixing timeline audio (FFmpeg)…', 15)
    let tick = 15
    heartbeat = setInterval(() => {
      tick = Math.min(75, tick + 4)
      report('Mixing timeline audio (FFmpeg)…', tick)
    }, 1500)

    const payload = buildIpcPayload({ duration })
    const mixResult = await api.mixTimelineAudioForCaptions({
      projectPath,
      duration,
      sampleRate: ASR_SAMPLE_RATE,
      ...payload,
    })

    clearInterval(heartbeat)
    heartbeat = null

    if (!mixResult?.success) {
      throw new Error(mixResult?.error || 'FFmpeg audio mix failed')
    }

    report('Loading mixed audio…', 88)
    const readResult = await api.readFileAsBuffer(mixResult.outputPath)
    if (!readResult?.success || !readResult.data) {
      throw new Error(readResult?.error || 'Failed to read mixed audio file')
    }

    // Best-effort cleanup — if the delete fails (e.g. AV scanner) we don't care,
    // the OS temp dir gets swept up on reboot.
    if (api.deleteFile && mixResult.outputPath) {
      api.deleteFile(mixResult.outputPath).catch(() => { /* ignore */ })
    }

    report('Mix complete', 100)
    const blob = new Blob([readResult.data], { type: 'audio/wav' })
    return {
      blob,
      duration,
      sampleRate: ASR_SAMPLE_RATE,
      channels: ASR_CHANNELS,
    }
  } catch (err) {
    if (heartbeat) clearInterval(heartbeat)
    console.warn('[timelineAudioMix] FFmpeg path failed, falling back to Web Audio:', err)
    return null
  }
}

/**
 * Fallback path: mix in the renderer using OfflineAudioContext. Used for the
 * web build and for Electron envs where the IPC isn't available. This can OOM
 * on large video sources — that's why the FFmpeg path exists.
 */
async function mixViaWebAudio({ report }) {
  const timelineState = useTimelineStore.getState()
  const assetsState = useAssetsStore.getState()

  const clips = Array.isArray(timelineState.clips) ? timelineState.clips : []
  const tracks = Array.isArray(timelineState.tracks) ? timelineState.tracks : []

  const enabledClips = clips
    .filter((clip) => clip.enabled !== false)
    .filter((clip) => clip.type === 'video' || clip.type === 'audio')

  if (enabledClips.length === 0) {
    throw new Error('The timeline has no audio-producing clips to transcribe.')
  }

  const trackById = new Map(tracks.map((t) => [t.id, t]))
  const anySolo = hasAudioSolo(tracks)
  const audibleClips = enabledClips.filter((clip) => {
    const track = trackById.get(clip.trackId)
    if (!track) return false
    if (track.type === 'audio' && !isAudioTrackAudible(track, anySolo)) return false
    if (track.type !== 'audio' && (track.muted || track.visible === false)) return false
    const asset = assetsState.getAssetById(clip.assetId)
    return clipHasUsableAudio(clip, asset)
  })

  if (audibleClips.length === 0) {
    throw new Error('No audible clips on the timeline — unmute a track or enable a clip\'s audio.')
  }

  const rawDuration = computeProgramDuration(enabledClips)
  if (rawDuration <= 0) {
    throw new Error('Timeline duration is zero — nothing to transcribe.')
  }
  const duration = Math.min(rawDuration, MAX_TRANSCRIBE_SECONDS)
  if (rawDuration > MAX_TRANSCRIBE_SECONDS) {
    console.warn(`[timelineAudioMix] Truncating transcription to ${MAX_TRANSCRIBE_SECONDS}s (timeline is ${rawDuration.toFixed(1)}s)`)
  }

  const totalSamples = Math.ceil(duration * ASR_SAMPLE_RATE)
  const OfflineCtx = typeof OfflineAudioContext !== 'undefined'
    ? OfflineAudioContext
    : (typeof webkitOfflineAudioContext !== 'undefined' ? webkitOfflineAudioContext : null) // eslint-disable-line no-undef
  if (!OfflineCtx) {
    throw new Error('This environment does not support OfflineAudioContext — audio mixing unavailable.')
  }

  const context = new OfflineCtx(ASR_CHANNELS, totalSamples, ASR_SAMPLE_RATE)
  const decodedCache = new Map()

  const resolveUrl = async (asset) => {
    if (asset.url) return asset.url
    if (asset.absolutePath && typeof window !== 'undefined' && window.electronAPI?.getFileUrl) {
      try {
        const r = await window.electronAPI.getFileUrl(asset.absolutePath)
        if (r?.success && r?.url) return r.url
      } catch { /* fall through */ }
    }
    return null
  }

  for (let i = 0; i < audibleClips.length; i++) {
    const clip = audibleClips[i]
    const asset = assetsState.getAssetById(clip.assetId)
    if (!asset) continue

    report(
      `Mixing ${asset.name || 'clip'} (${i + 1}/${audibleClips.length})…`,
      5 + Math.round(70 * (i / audibleClips.length))
    )

    try {
      const url = await resolveUrl(asset)
      if (!url) continue

      let buffer = decodedCache.get(url)
      if (!buffer) {
        const response = await fetch(url)
        if (!response.ok) continue
        const arrayBuffer = await response.arrayBuffer()
        buffer = await context.decodeAudioData(arrayBuffer)
        decodedCache.set(url, buffer)
      }

      let sourceBuffer = buffer
      if (buffer.numberOfChannels > 1) {
        const mono = context.createBuffer(1, buffer.length, buffer.sampleRate)
        const out = mono.getChannelData(0)
        const channels = []
        for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))
        const gain = 1 / channels.length
        for (let s = 0; s < buffer.length; s++) {
          let sum = 0
          for (let c = 0; c < channels.length; c++) sum += channels[c][s]
          out[s] = sum * gain
        }
        sourceBuffer = mono
      }

      const clipStart = Number(clip.startTime) || 0
      const clipDuration = Math.max(0, Number(clip.duration) || 0)
      if (clipDuration <= 0) continue
      const clipEnd = clipStart + clipDuration

      const visibleStart = Math.max(0, clipStart)
      const visibleEnd = Math.min(duration, clipEnd)
      if (visibleEnd <= visibleStart) continue

      const source = context.createBufferSource()
      source.buffer = sourceBuffer

      const baseScale = clip.sourceTimeScale
        || (clip.timelineFps && clip.sourceFps ? clip.timelineFps / clip.sourceFps : 1)
      const speed = Number(clip.speed)
      const timeScale = (Number.isFinite(speed) && speed > 0 ? speed : 1) * baseScale
      const trimStart = Math.max(0, Number(clip.trimStart) || 0)
      const clipOffset = visibleStart - clipStart
      const sourceOffset = trimStart + clipOffset * timeScale
      const visibleDuration = visibleEnd - visibleStart
      const playDuration = clamp(
        visibleDuration * timeScale,
        0,
        Math.max(0, sourceBuffer.duration - sourceOffset)
      )
      if (playDuration <= 0) continue

      source.connect(context.destination)
      source.start(visibleStart, sourceOffset, playDuration)
    } catch (err) {
      console.warn('[timelineAudioMix] failed to include clip:', clip.id, err)
    }
  }

  report('Rendering offline mix…', 80)
  const rendered = await context.startRendering()

  report('Encoding WAV…', 94)
  const wavArrayBuffer = audioBufferToWav(rendered)
  const blob = new Blob([wavArrayBuffer], { type: 'audio/wav' })
  report('Mix complete', 100)

  return {
    blob,
    duration,
    sampleRate: ASR_SAMPLE_RATE,
    channels: ASR_CHANNELS,
  }
}

/**
 * Mix the current timeline's program audio to a WAV Blob.
 *
 * @param {{ onProgress?: (status: string, pct: number) => void }} [options]
 * @returns {Promise<{ blob: Blob, duration: number, sampleRate: number, channels: number }>}
 */
export async function mixTimelineAudioToWav({ onProgress } = {}) {
  const timelineState = useTimelineStore.getState()
  const assetsState = useAssetsStore.getState()
  const clips = Array.isArray(timelineState.clips) ? timelineState.clips : []
  const tracks = Array.isArray(timelineState.tracks) ? timelineState.tracks : []

  const report = (status, pct) => {
    if (typeof onProgress === 'function') onProgress(status, clamp(pct, 0, 100))
  }
  report('Inspecting timeline…', 2)

  // Pre-flight: make sure there's actually audio to mix (gives nicer errors
  // than whatever FFmpeg would emit).
  const enabledClips = clips
    .filter((clip) => clip.enabled !== false)
    .filter((clip) => clip.type === 'video' || clip.type === 'audio')
  if (enabledClips.length === 0) {
    throw new Error('The timeline has no audio-producing clips to transcribe.')
  }
  const trackById = new Map(tracks.map((t) => [t.id, t]))
  const anySolo = hasAudioSolo(tracks)
  const hasAudibleClip = enabledClips.some((clip) => {
    const track = trackById.get(clip.trackId)
    if (!track) return false
    if (track.type === 'audio' && !isAudioTrackAudible(track, anySolo)) return false
    if (track.type !== 'audio' && (track.muted || track.visible === false)) return false
    const asset = assetsState.getAssetById(clip.assetId)
    return clipHasUsableAudio(clip, asset)
  })
  if (!hasAudibleClip) {
    throw new Error('No audible clips on the timeline — unmute a track or enable a clip\'s audio.')
  }

  const rawDuration = computeProgramDuration(enabledClips)
  if (rawDuration <= 0) {
    throw new Error('Timeline duration is zero — nothing to transcribe.')
  }
  const duration = Math.min(rawDuration, MAX_TRANSCRIBE_SECONDS)
  if (rawDuration > MAX_TRANSCRIBE_SECONDS) {
    console.warn(`[timelineAudioMix] Truncating transcription to ${MAX_TRANSCRIBE_SECONDS}s (timeline is ${rawDuration.toFixed(1)}s)`)
  }

  const ffmpegResult = await mixViaFFmpeg({ duration, report })
  if (ffmpegResult) return ffmpegResult

  return mixViaWebAudio({ report })
}
