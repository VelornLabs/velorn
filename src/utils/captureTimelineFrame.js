import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import { getAnimatedTransform } from './keyframes'
import {
  applyClipCrop,
  applyClipTransform,
  drawPerspectiveClipSource,
  drawText,
  getBaseDrawRect,
  hasPerspectiveClipTransform,
} from '../services/exporter'
import { getLivePreviewCapture } from '../services/previewFrameBridge'

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
        if (hasPerspectiveClipTransform(clipTransform)) {
          const textCanvas = document.createElement('canvas')
          textCanvas.width = Math.max(1, Math.ceil(rect.width))
          textCanvas.height = Math.max(1, Math.ceil(rect.height))
          const textCtx = textCanvas.getContext('2d', { alpha: true })
          drawText(textCtx, { x: 0, y: 0, width: rect.width, height: rect.height }, clip, 1, clipTime)
          drawPerspectiveClipSource(ctx, textCanvas, rect, clipTransform, null)
        } else {
          applyClipTransform(ctx, rect, clipTransform, null)
          applyClipCrop(ctx, rect, clipTransform)
          drawText(ctx, rect, clip, 1, clipTime)
        }
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
      if (hasPerspectiveClipTransform(clipTransform)) {
        drawPerspectiveClipSource(ctx, loaded.element, rect, clipTransform, null)
      } else {
        applyClipTransform(ctx, rect, clipTransform, null)
        applyClipCrop(ctx, rect, clipTransform)
        ctx.drawImage(loaded.element, 0, 0, rect.width, rect.height)
      }
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
 * Try the live preview pipeline first: TRUE render parity with playback
 * (track mattes, corner pin, speed ramps, GLSL, motion blur). Moves the
 * playhead to seek, so it restores it afterwards unless the caller batches
 * captures and restores once itself (restorePlayhead: false). Returns null
 * when unavailable (preview unmounted, playing, empty region, timeout) —
 * the caller falls back to the legacy offscreen still renderer.
 */
async function captureLiveComposite(time, captureOptions = {}) {
  if (captureOptions.renderer === 'legacy') return null
  const liveCapture = getLivePreviewCapture()
  if (!liveCapture) return null

  const timelineState = useTimelineStore.getState()
  if (timelineState.isPlaying) return null

  // Preserve the legacy "nothing visible here" null signal for empty
  // regions instead of returning a black frame.
  const activeClips = timelineState.getActiveClipsAtTime?.(time) || []
  const hasVisualClip = activeClips.some(({ track }) => track?.type === 'video')
  if (!hasVisualClip) return null

  const previousPlayhead = timelineState.playheadPosition
  try {
    return await liveCapture(time, { timeoutMs: captureOptions.timeoutMs })
  } catch (_) {
    return null
  } finally {
    if (captureOptions.restorePlayhead !== false) {
      useTimelineStore.getState().setPlayheadPosition(previousPlayhead, { snap: false })
    }
  }
}

/**
 * Capture the composed timeline frame at the given timeline time.
 * Returns Promise<{ blobUrl, file, width, height, mimeType, time, renderer }> or Promise<null> if no visual clip or error.
 */
export async function captureTimelineFrameAt(time, options = {}) {
  try {
    const captureOptions = options && typeof options === 'object' ? options : {}
    const projectState = useProjectStore.getState?.()
    const settings = projectState?.getCurrentTimelineSettings?.()
      || projectState?.currentProject?.settings
      || {}
    const sourceWidth = Math.max(16, Math.min(7680, Number(settings.width) || 1920))
    const sourceHeight = Math.max(16, Math.min(4320, Number(settings.height) || 1080))
    const maxWidth = Number(captureOptions.maxWidth)
    const maxHeight = Number(captureOptions.maxHeight)
    const widthScale = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth / sourceWidth : 1
    const heightScale = Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight / sourceHeight : 1
    const scale = Math.min(1, widthScale, heightScale)
    const width = Math.max(16, Math.round(sourceWidth * scale))
    const height = Math.max(16, Math.round(sourceHeight * scale))
    const requestedMimeType = String(captureOptions.mimeType || 'image/png').toLowerCase()
    const mimeType = requestedMimeType === 'image/jpeg' || requestedMimeType === 'image/webp'
      ? requestedMimeType
      : 'image/png'
    const requestedQuality = Number(captureOptions.quality)
    const quality = Number.isFinite(requestedQuality)
      ? Math.max(0.1, Math.min(1, requestedQuality))
      : undefined

    // Prefer the live preview pipeline (true render parity); fall back to
    // the simplified offscreen compositor when the preview isn't available.
    let canvas = await captureLiveComposite(time, captureOptions)
    const renderer = canvas ? 'live' : 'legacy'
    if (!canvas) {
      // Composite at full project resolution so pixel-space transform values
      // (positionX/Y, blur) land where preview and export put them, then
      // downscale the finished frame to the requested capture size.
      canvas = document.createElement('canvas')
      canvas.width = sourceWidth
      canvas.height = sourceHeight
      const rendered = await renderTimelineCompositeStill(time, canvas, sourceWidth, sourceHeight)
      if (!rendered) return null
    }

    let outputCanvas = canvas
    if (canvas.width !== width || canvas.height !== height) {
      outputCanvas = document.createElement('canvas')
      outputCanvas.width = width
      outputCanvas.height = height
      const outputCtx = outputCanvas.getContext('2d', { alpha: false })
      if (!outputCtx) return null
      outputCtx.imageSmoothingEnabled = true
      outputCtx.imageSmoothingQuality = 'high'
      outputCtx.drawImage(canvas, 0, 0, width, height)
    }

    const blob = await new Promise((resolve) => outputCanvas.toBlob((nextBlob) => resolve(nextBlob), mimeType, quality))
    if (!blob) return null

    const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
    const file = new File([blob], `timeline_frame_${Date.now()}.${extension}`, { type: mimeType })
    const blobUrl = captureOptions.createBlobUrl === false ? '' : URL.createObjectURL(blob)
    return {
      blobUrl,
      file,
      width,
      height,
      mimeType,
      time: Number(time) || 0,
      renderer,
    }
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
