import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import { getAnimatedTransform } from './keyframes'
import {
  applyClipCrop,
  applyClipTransform,
  drawText,
  getBaseDrawRect,
} from '../services/exporter'

/**
 * Get the topmost video or image clip at the given time (for capture).
 * Returns { clip, track } or null.
 */
export function getTopmostVideoOrImageClipAtTime(time) {
  try {
    if (time == null || typeof time !== 'number' || Number.isNaN(time)) return null
    const timelineState = useTimelineStore.getState()
    if (!timelineState || typeof timelineState.getActiveClipsAtTime !== 'function') return null
    const tracks = timelineState.tracks
    if (!Array.isArray(tracks)) return null
    const activeClips = timelineState.getActiveClipsAtTime(time)
    if (!Array.isArray(activeClips)) return null
    // Video 1 = top; lower track index = higher in stack
    const videoLayerClips = activeClips
      .filter(({ track }) => track && track.type === 'video')
      .sort((a, b) => {
        const indexA = tracks.findIndex((t) => t && t.id === a.track.id)
        const indexB = tracks.findIndex((t) => t && t.id === b.track.id)
        return indexA - indexB
      })
    const top = videoLayerClips.find(({ clip }) => clip?.type === 'video' || clip?.type === 'image')
    if (!top || !top.clip) return null
    const { clip } = top
    if (clip.type === 'video' || clip.type === 'image') return top
    return null
  } catch (_) {
    return null
  }
}

/**
 * Extract source time (in seconds) for a clip at the given timeline time.
 */
export function getSourceTimeForClip(clip, timelineTime) {
  const clipTime = timelineTime - clip.startTime
  const baseScale = clip.sourceTimeScale || (clip.timelineFps && clip.sourceFps
    ? clip.timelineFps / clip.sourceFps
    : 1)
  const speed = Number(clip.speed)
  const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
  const timeScale = baseScale * speedScale
  const trimStart = clip.trimStart || 0
  const reverse = !!clip.reverse
  const trimEnd = clip.trimEnd ?? clip.sourceDuration ?? trimStart
  const rawSourceTime = reverse
    ? trimEnd - clipTime * timeScale
    : trimStart + clipTime * timeScale
  const maxSourceTime = clip.sourceDuration ?? clip.duration ?? trimEnd
  return Math.max(0, Math.min(rawSourceTime, maxSourceTime - 0.001))
}

async function renderTimelineCompositeStill(time, canvas, width, height) {
  const timelineState = useTimelineStore.getState()
  const assetsState = useAssetsStore.getState()
  if (!timelineState || !assetsState || typeof timelineState.getActiveClipsAtTime !== 'function') {
    return false
  }

  const activeClips = timelineState.getActiveClipsAtTime(time)
  if (!Array.isArray(activeClips) || activeClips.length === 0) return false

  const tracks = timelineState.tracks || []
  const visualClips = activeClips
    .filter(({ track }) => track && track.type === 'video')
    .sort((a, b) => {
      const indexA = tracks.findIndex((track) => track && track.id === a.track.id)
      const indexB = tracks.findIndex((track) => track && track.id === b.track.id)
      return indexB - indexA
    })

  if (visualClips.length === 0) return false

  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return false

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.filter = 'none'
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, width, height)

  let drewSomething = false
  const cleanups = []

  try {
    for (const { clip } of visualClips) {
      if (!clip) continue

      const clipTime = time - (clip.startTime || 0)
      const clipTransform = getAnimatedTransform(clip, clipTime) || clip.transform || {}
      const opacity = typeof clipTransform.opacity === 'number' ? clipTransform.opacity / 100 : 1
      const blendMode = clipTransform.blendMode || 'normal'

      if (clip.type === 'text') {
        const rect = getBaseDrawRect(width, height, width, height)
        ctx.save()
        ctx.globalAlpha = opacity
        ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode
        ctx.filter = clipTransform.blur > 0 ? `blur(${clipTransform.blur}px)` : 'none'
        applyClipTransform(ctx, rect, clipTransform, null)
        applyClipCrop(ctx, rect, clipTransform)
        drawText(ctx, rect, clip, 1)
        ctx.restore()
        drewSomething = true
        continue
      }

      if (clip.type !== 'video' && clip.type !== 'image') continue
      const asset = assetsState.getAssetById(clip.assetId)
      if (!asset?.url) continue

      const loaded = await loadClipSourceAtTime(clip, asset, time)
      if (!loaded?.element) continue
      cleanups.push(loaded.cleanup)

      const sourceWidth = loaded.width || width
      const sourceHeight = loaded.height || height
      const rect = getBaseDrawRect(sourceWidth, sourceHeight, width, height)

      ctx.save()
      ctx.globalAlpha = opacity
      ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode
      ctx.filter = clipTransform.blur > 0 ? `blur(${clipTransform.blur}px)` : 'none'
      applyClipTransform(ctx, rect, clipTransform, null)
      applyClipCrop(ctx, rect, clipTransform)
      ctx.drawImage(loaded.element, 0, 0, rect.width, rect.height)
      ctx.restore()
      drewSomething = true
    }
  } finally {
    for (const cleanup of cleanups) {
      try { cleanup?.() } catch (_) { /* ignore cleanup failures */ }
    }
  }

  return drewSomething
}

/**
 * Capture the composed timeline frame at the given timeline time.
 * Returns Promise<{ blobUrl, file }> or Promise<null> if no visual clip or error.
 */
export async function captureTimelineFrameAt(time) {
  try {
    const projectState = useProjectStore.getState?.()
    const settings = projectState?.getCurrentTimelineSettings?.()
      || projectState?.currentProject?.settings
      || {}
    const width = Math.max(16, Math.min(7680, Number(settings.width) || 1920))
    const height = Math.max(16, Math.min(4320, Number(settings.height) || 1080))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const rendered = await renderTimelineCompositeStill(time, canvas, width, height)
    if (!rendered) return null

    const blob = await new Promise((resolve) => canvas.toBlob((nextBlob) => resolve(nextBlob), 'image/png'))
    if (!blob) return null

    const file = new File([blob], `timeline_frame_${Date.now()}.png`, { type: 'image/png' })
    const blobUrl = URL.createObjectURL(blob)
    return { blobUrl, file }
  } catch (err) {
    console.warn('[captureTimelineFrame] failed to capture timeline composite:', err?.message || err)
    return null
  }
}

/**
 * Load a single clip's source frame into an element that `drawImage` can
 * consume. For images we return an `<img>`; for videos we spin up a headless
 * `<video>` and seek it to the correct source time.
 *
 * Returns an object `{ element, width, height, cleanup }` or null. The
 * caller is responsible for invoking `cleanup()` when done (it revokes
 * object URLs and releases video elements).
 *
 * This is intentionally split out so the thumbnail compositor can reuse
 * the same decoding path per-layer without reimplementing the seek dance.
 */
export async function loadClipSourceAtTime(clip, asset, time) {
  if (!clip || !asset) return null
  try {
    if (clip.type === 'image') {
      const src = asset.url
      if (!src) return null
      const img = await new Promise((resolve, reject) => {
        const el = new Image()
        el.crossOrigin = 'anonymous'
        el.onload = () => resolve(el)
        el.onerror = () => reject(new Error('image load failed'))
        el.src = src
      })
      return {
        element: img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        cleanup: () => {},
      }
    }

    if (clip.type === 'video') {
      const src = asset.url
      if (!src) return null
      const sourceTime = getSourceTimeForClip(clip, time)
      const video = document.createElement('video')
      video.crossOrigin = 'anonymous'
      video.muted = true
      video.preload = 'auto'
      video.src = src
      await new Promise((resolve, reject) => {
        let settled = false
        const finish = (ok, err) => {
          if (settled) return
          settled = true
          ok ? resolve() : reject(err)
        }
        video.onloadedmetadata = () => {
          try {
            video.currentTime = Math.min(sourceTime, Math.max(0, (video.duration || 0) - 0.01))
          } catch (err) {
            finish(false, err)
          }
        }
        video.onseeked = () => finish(true)
        video.onerror = () => finish(false, new Error('video decode failed'))
        // Hard ceiling so a hung load never stalls a save.
        setTimeout(() => finish(false, new Error('video seek timeout')), 4000)
      })
      return {
        element: video,
        width: video.videoWidth,
        height: video.videoHeight,
        cleanup: () => {
          try { video.removeAttribute('src'); video.load() } catch (_) { /* ignore */ }
        },
      }
    }

    return null
  } catch (_) {
    return null
  }
}
