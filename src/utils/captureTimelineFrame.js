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
 * Encode a file:// URL so the <video> / <img> element can decode it.
 *
 * Electron's getFileUrlDirect returns the absolute path with literal
 * characters — a filename like `▶️_00007.mp4` produces a src the browser
 * rejects with no further error detail (just "video decode failed").
 * We percent-encode every path segment after the leading `file://` so
 * the URL is safe to set on a media element.
 */
export function encodeFileUrl(url) {
  if (!url || typeof url !== 'string') return url
  if (!url.startsWith('file://')) return url
  // Strip the prefix, split on /, encode each segment, re-join.
  // file:///path/to/file → prefix = 'file:///', rest = ['path','to','file']
  const rest = url.slice('file://'.length)
  const parts = rest.split('/').map((seg) => {
    try {
      return encodeURIComponent(decodeURIComponent(seg))
    } catch (_) {
      return seg
    }
  })
  return 'file://' + parts.join('/')
}

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
      const src = encodeFileUrl(asset.url)
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
      // file:// URLs from Electron's getFileUrlDirect are NOT URL-encoded,
      // so a filename with non-ASCII characters (e.g. "▶️_00007.mp4")
      // produces a src the <video> element can't decode — onerror fires
      // with no further detail. Encode the path components before setting src.
      const safeSrc = encodeFileUrl(src)
      console.log('[loadClipSourceAtTime] video', {
        srcPrefix: String(safeSrc).slice(0, 80),
        sourceTime,
        duration: clip.duration,
        timelineFps: clip.timelineFps,
        trimStart: clip.trimStart,
        trimEnd: clip.trimEnd,
      })
      const video = document.createElement('video')
      video.crossOrigin = 'anonymous'
      video.muted = true
      video.preload = 'auto'
      video.src = safeSrc
      const result = await new Promise((resolve, reject) => {
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
      }).catch((err) => {
        console.log('[loadClipSourceAtTime] video load failed', err?.message || err)
        throw err
      })
      console.log('[loadClipSourceAtTime] video ok', { videoWidth: video.videoWidth, videoHeight: video.videoHeight })
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

/**
 * Capture a single frame from a SINGLE clip at a given timeline time.
 *
 * Unlike captureTimelineFrameAt (which composites the full timeline),
 * this only loads the named clip's source and draws it to the canvas.
 * Use this for FLF2V gap-fill where we want one frame from the clip
 * immediately before / after the gap.
 *
 * @param {object} clip   Clip record (with type, startTime, assetId, ...)
 * @param {object} asset  Asset record (with url)
 * @param {number} time   Timeline time to seek to (seconds)
 * @returns Promise<{ blobUrl, file } | null>
 */
export async function captureSingleClipFrame(clip, asset, time) {
  if (!clip || !asset?.url) return null
  console.log('[captureSingleClipFrame] starting', {
    clipType: clip.type,
    clipId: clip?.id,
    time,
    urlPrefix: String(asset.url).slice(0, 80),
  })
  try {
    const projectState = useProjectStore.getState?.()
    const settings = projectState?.getCurrentTimelineSettings?.()
      || projectState?.currentProject?.settings
      || {}
    const width = Math.max(16, Math.min(7680, Number(settings.width) || 1920))
    const height = Math.max(16, Math.min(4320, Number(settings.height) || 1080))

    let loaded
    try {
      loaded = await loadClipSourceAtTime(clip, asset, time)
    } catch (innerErr) {
      console.log('[captureSingleClipFrame] loadClipSourceAtTime threw', innerErr?.message || innerErr)
      throw innerErr
    }
    console.log('[captureSingleClipFrame] loaded', { hasLoaded: !!loaded, hasElement: !!(loaded && loaded.element) })
    if (!loaded?.element) return null
    try {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) return null
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(loaded.element, 0, 0, width, height)
      const blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
      if (!blob) return null
      const file = new File([blob], `gapfill_frame_${Date.now()}.png`, { type: 'image/png' })
      const blobUrl = URL.createObjectURL(blob)
      return { blobUrl, file }
    } finally {
      try { loaded.cleanup?.() } catch (_) { /* ignore */ }
    }
  } catch (err) {
    console.warn('[captureSingleClipFrame] failed:', err?.message || err)
    return null
  }
}

/**
 * Capture the last frame of the before-clip and the first frame of the
 * after-clip for an FLF2V gap fill.
 *
 * Each capture seeks STRICTLY INSIDE the source clip's [start, start+duration]
 * range, so we never depend on getActiveClipsAtTime returning the clip at
 * a point past its edge (the bug that broke gap #2 fill: the composite
 * renderTimelineCompositeStill returned false because no clip was active
 * at firstFrameTime = gap.endTime + eps).
 *
 * @param {object} beforeClip  { clip, track } — clip immediately before the gap
 * @param {object} afterClip   { clip, track } — clip immediately after the gap
 * @returns Promise<{ start: {blobUrl, file} | null, end: {blobUrl, file} | null }>
 */
export async function captureGapBoundaryFrames(beforeClip, afterClip) {
  const fps = Math.max(
    1,
    Number(beforeClip?.clip?.timelineFps) || Number(afterClip?.clip?.timelineFps) || 24
  )
  const eps = 1 / fps

  let startResult = null
  let endResult = null

  if (beforeClip?.clip) {
    const assetsState = useAssetsStore.getState()
    const asset = assetsState?.getAssetById?.(beforeClip.clip.assetId)
    console.log('[FillGap FLF2V] before-clip capture', {
      clipId: beforeClip.clip.id,
      assetId: beforeClip.clip.assetId,
      hasAsset: !!asset,
      hasUrl: !!asset?.url,
      start: beforeClip.clip.startTime,
      duration: beforeClip.clip.duration,
    })
    if (asset?.url) {
      const start = Number(beforeClip.clip.startTime) || 0
      const dur = Number(beforeClip.clip.duration) || 0
      // Seek to last frame (start + duration - eps), but never before start.
      const t = Math.max(start + eps, start + dur - eps)
      startResult = await captureSingleClipFrame(beforeClip.clip, asset, t)
      console.log('[FillGap FLF2V] before-clip capture result', { ok: !!startResult, t })
    }
  } else {
    console.log('[FillGap FLF2V] no before-clip entry')
  }

  if (afterClip?.clip) {
    const assetsState = useAssetsStore.getState()
    const asset = assetsState?.getAssetById?.(afterClip.clip.assetId)
    console.log('[FillGap FLF2V] after-clip capture', {
      clipId: afterClip.clip.id,
      assetId: afterClip.clip.assetId,
      hasAsset: !!asset,
      hasUrl: !!asset?.url,
      start: afterClip.clip.startTime,
      duration: afterClip.clip.duration,
    })
    if (asset?.url) {
      const start = Number(afterClip.clip.startTime) || 0
      // Seek to first frame after the clip's start edge.
      const t = start + eps
      endResult = await captureSingleClipFrame(afterClip.clip, asset, t)
      console.log('[FillGap FLF2V] after-clip capture result', { ok: !!endResult, t })
    }
  } else {
    console.log('[FillGap FLF2V] no after-clip entry')
  }

  return { start: startResult, end: endResult }
}
