/**
 * Project thumbnail capture.
 *
 * On every save (manual or autosave), we render a composite frame of the
 * current timeline at the playhead and drop it next to project.comfystudio
 * as `project.thumbnail.webp`. The welcome screen can then show real
 * content for each recent project instead of an empty placeholder — same
 * pattern DaVinci Resolve uses for its project browser.
 *
 * We reuse the draw helpers from `services/exporter.js` so the thumbnail
 * composition matches final export output for video, image, and text
 * layers (transforms, opacity, blend modes). Advanced effects that aren't
 * critical at thumbnail size — color adjustments, transitions, masks,
 * cached-render swapping — are intentionally skipped to keep saves fast.
 * The resulting filename (relative to the project directory) is returned
 * so the caller can stamp it into the project JSON.
 */

import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import { loadClipSourceAtTime } from './captureTimelineFrame'
import {
  getBaseDrawRect,
  applyClipTransform,
  applyClipCrop,
  drawText,
} from '../services/exporter'
import { getAnimatedTransform } from './keyframes'

export const PROJECT_THUMBNAIL_FILENAME = 'project.thumbnail.webp'

const THUMB_WIDTH = 480
const THUMB_HEIGHT = 270
const THUMB_QUALITY = 0.78

/**
 * Render a composite frame of the current timeline at `time` to the given
 * canvas. Supports:
 *   - Multiple video/image layers with transforms, opacity, blend modes
 *   - Text layers (fonts, stroke, shadow, background)
 *
 * Deliberately skips: adjustments, transitions, masks, cached renders. If
 * nothing renders (empty timeline, playhead over a gap), returns false so
 * the caller can skip writing a thumbnail.
 */
async function renderCompositeFrameAt(time, canvas, renderWidth, renderHeight) {
  const timelineState = useTimelineStore.getState?.()
  const assetsState = useAssetsStore.getState?.()
  if (!timelineState || !assetsState || typeof timelineState.getActiveClipsAtTime !== 'function') {
    return false
  }

  const activeClips = timelineState.getActiveClipsAtTime(time)
  if (!Array.isArray(activeClips) || activeClips.length === 0) return false

  // Render the same visual layers the exporter considers (video-type
  // tracks only), sorted so lower tracks paint first (bottom-up), matching
  // the exporter's top-track-wins convention.
  const tracks = timelineState.tracks || []
  const visual = activeClips
    .filter(({ track }) => track && track.type === 'video')
    .sort((a, b) => {
      const ia = tracks.findIndex((t) => t && t.id === a.track.id)
      const ib = tracks.findIndex((t) => t && t.id === b.track.id)
      return ib - ia
    })

  if (visual.length === 0) return false

  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return false
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, renderWidth, renderHeight)

  let drewSomething = false
  const cleanups = []

  try {
    for (const { clip } of visual) {
      const clipTime = time - clip.startTime
      const clipTransform = getAnimatedTransform(clip, clipTime) || clip.transform || {}
      const baseOpacity = typeof clipTransform.opacity === 'number' ? clipTransform.opacity / 100 : 1
      const blendMode = clipTransform.blendMode || 'normal'

      // Text clips: no source to seek; draw directly.
      if (clip.type === 'text') {
        const rect = getBaseDrawRect(renderWidth, renderHeight, renderWidth, renderHeight)
        ctx.save()
        ctx.globalAlpha = baseOpacity
        ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode
        ctx.filter = 'none'
        applyClipTransform(ctx, rect, clipTransform, null)
        applyClipCrop(ctx, rect, clipTransform)
        try { drawText(ctx, rect, clip, 1, clipTime) } catch (_) { /* ignore bad text state */ }
        ctx.restore()
        drewSomething = true
        continue
      }

      // Video/image clips: load a frame from the source.
      if (clip.type !== 'video' && clip.type !== 'image') continue
      const asset = assetsState.getAssetById?.(clip.assetId)
      if (!asset?.url) continue

      let loaded = null
      try {
        loaded = await loadClipSourceAtTime(clip, asset, time)
      } catch (_) {
        loaded = null
      }
      if (!loaded?.element) continue
      cleanups.push(loaded.cleanup)

      const sourceW = loaded.width || renderWidth
      const sourceH = loaded.height || renderHeight
      const rect = getBaseDrawRect(sourceW, sourceH, renderWidth, renderHeight)

      ctx.save()
      ctx.globalAlpha = baseOpacity
      ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode
      ctx.filter = 'none'
      applyClipTransform(ctx, rect, clipTransform, null)
      applyClipCrop(ctx, rect, clipTransform)
      try {
        ctx.drawImage(loaded.element, 0, 0, rect.width, rect.height)
        drewSomething = true
      } catch (_) {
        // Source wasn't drawable (e.g., video never produced a frame);
        // skip this layer quietly.
      }
      ctx.restore()
    }
  } finally {
    for (const fn of cleanups) {
      try { fn?.() } catch (_) { /* ignore */ }
    }
  }

  return drewSomething
}

/**
 * Encode a canvas to a cover-fitted 480x270 webp blob.
 */
async function canvasToThumbWebp(sourceCanvas) {
  try {
    // If the source is already our target size, encode directly.
    if (sourceCanvas.width === THUMB_WIDTH && sourceCanvas.height === THUMB_HEIGHT) {
      return await new Promise((resolve) => {
        sourceCanvas.toBlob((b) => resolve(b), 'image/webp', THUMB_QUALITY)
      })
    }
    // Otherwise downsample with cover-fit.
    const dst = document.createElement('canvas')
    dst.width = THUMB_WIDTH
    dst.height = THUMB_HEIGHT
    const dstCtx = dst.getContext('2d', { alpha: false })
    if (!dstCtx) return null
    dstCtx.fillStyle = '#000'
    dstCtx.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT)

    const srcAspect = sourceCanvas.width / sourceCanvas.height
    const dstAspect = THUMB_WIDTH / THUMB_HEIGHT
    let sx = 0, sy = 0, sw = sourceCanvas.width, sh = sourceCanvas.height
    if (srcAspect > dstAspect) {
      const newSw = sourceCanvas.height * dstAspect
      sx = Math.max(0, (sourceCanvas.width - newSw) / 2)
      sw = newSw
    } else if (srcAspect < dstAspect) {
      const newSh = sourceCanvas.width / dstAspect
      sy = Math.max(0, (sourceCanvas.height - newSh) / 2)
      sh = newSh
    }
    dstCtx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, THUMB_WIDTH, THUMB_HEIGHT)

    return await new Promise((resolve) => {
      dst.toBlob((b) => resolve(b), 'image/webp', THUMB_QUALITY)
    })
  } catch (_) {
    return null
  }
}

/**
 * Capture and persist a thumbnail for the current project at the current
 * playhead. Returns the relative filename on success, or null if we had
 * nothing to capture (empty timeline, playhead over a gap, etc.) or
 * couldn't write it. Designed to be safe to call unconditionally during
 * save — failures are never thrown.
 *
 * @param {string|FileSystemDirectoryHandle} projectHandleOrPath
 */
export async function captureAndSaveProjectThumbnail(projectHandleOrPath) {
  try {
    if (!projectHandleOrPath) return null

    const timelineState = useTimelineStore.getState?.()
    const time = Number(timelineState?.playheadPosition) || 0

    // Render at project resolution so transforms line up correctly, then
    // downsample once at the end for clean cover-fitting.
    const projectState = useProjectStore.getState?.()
    const settings = projectState?.currentProject?.settings || {}
    const projectW = Math.max(16, Math.min(3840, Number(settings.width) || 1920))
    const projectH = Math.max(16, Math.min(2160, Number(settings.height) || 1080))

    const canvas = document.createElement('canvas')
    canvas.width = projectW
    canvas.height = projectH
    const rendered = await renderCompositeFrameAt(time, canvas, projectW, projectH)
    if (!rendered) return null

    const webp = await canvasToThumbWebp(canvas)
    if (!webp) return null

    // Electron: string path.
    if (typeof projectHandleOrPath === 'string' && typeof window !== 'undefined' && window.electronAPI) {
      try {
        const destPath = await window.electronAPI.pathJoin(projectHandleOrPath, PROJECT_THUMBNAIL_FILENAME)
        const arrayBuffer = await webp.arrayBuffer()
        const result = await window.electronAPI.writeFileFromArrayBuffer(destPath, arrayBuffer)
        if (!result?.success) return null
        return PROJECT_THUMBNAIL_FILENAME
      } catch (err) {
        console.warn('[projectThumbnail] electron write failed:', err?.message || err)
        return null
      }
    }

    // Web: FileSystemDirectoryHandle.
    if (projectHandleOrPath && typeof projectHandleOrPath === 'object' && projectHandleOrPath.kind === 'directory') {
      try {
        const fileHandle = await projectHandleOrPath.getFileHandle(PROJECT_THUMBNAIL_FILENAME, { create: true })
        const writable = await fileHandle.createWritable()
        await writable.write(webp)
        await writable.close()
        return PROJECT_THUMBNAIL_FILENAME
      } catch (err) {
        console.warn('[projectThumbnail] web write failed:', err?.message || err)
        return null
      }
    }

    return null
  } catch (err) {
    console.warn('[projectThumbnail] capture failed:', err?.message || err)
    return null
  }
}

/**
 * Resolve a stored thumbnail pointer into a URL that <img> can show.
 * Returns null when we can't produce one (web mode without file access,
 * missing file, non-Electron, etc.).
 *
 * @param {string|FileSystemDirectoryHandle} projectHandleOrPath
 * @param {string} thumbnailPointer — relative filename stored in project JSON
 */
export async function resolveThumbnailUrl(projectHandleOrPath, thumbnailPointer) {
  const pointer = String(thumbnailPointer || '').trim()
  if (!pointer) return null

  // Electron: use the comfystudio:// file protocol so the <img> can stream
  // from disk without base64 overhead.
  if (typeof projectHandleOrPath === 'string' && typeof window !== 'undefined' && window.electronAPI) {
    try {
      const fullPath = await window.electronAPI.pathJoin(projectHandleOrPath, pointer)
      const exists = await window.electronAPI.exists(fullPath)
      if (!exists) return null
      // Append a cache-buster based on the file's mtime so updates after
      // save show up without waiting for a full app reload.
      let suffix = ''
      try {
        const info = await window.electronAPI.getFileInfo(fullPath)
        const mtime = info?.info?.modified || info?.info?.mtimeMs
        if (mtime) suffix = `?t=${new Date(mtime).valueOf()}`
      } catch (_) { /* ignore */ }
      const url = await window.electronAPI.getFileUrl(fullPath)
      if (!url) return null
      return suffix ? `${url}${suffix}` : url
    } catch (err) {
      console.warn('[projectThumbnail] resolve failed:', err?.message || err)
      return null
    }
  }

  // Web: read through the directory handle, return a data URL.
  if (projectHandleOrPath && typeof projectHandleOrPath === 'object' && projectHandleOrPath.kind === 'directory') {
    try {
      const fileHandle = await projectHandleOrPath.getFileHandle(pointer)
      const file = await fileHandle.getFile()
      return URL.createObjectURL(file)
    } catch (_) {
      return null
    }
  }

  return null
}
