import { useEffect, useRef, useCallback, useState, useMemo, useLayoutEffect, memo } from 'react'
import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import videoCache from '../services/videoCache'
import renderCacheService from '../services/renderCache'
import { getAnimatedTransform, getAnimatedAdjustmentSettings } from '../utils/keyframes'
import { loadRenderCache, saveRenderCache } from '../services/fileSystem'
import { getSpriteFramePosition } from '../services/thumbnailSprites'
import {
  buildCssFilterFromAdjustments,
  getAdjustmentSvgFilterStages,
  getTonalMaskTableValues,
  hasAdjustmentEffect,
  hasTonalAdjustmentEffect,
  normalizeAdjustmentSettings,
  scaleAdjustmentSettings,
  TONAL_ADJUSTMENT_GROUP_KEYS,
} from '../utils/adjustments'
import {
  applyEffectsToTransform,
  buildLetterboxOverlayStyles,
  buildVignetteOverlayStyle,
  getActiveLetterboxEffect,
  getActiveVignetteEffect,
  getClipEffectFilterId,
  hasLetterboxEffect,
  hasPixelFilterEffect,
  hasVignetteEffect,
} from '../utils/effects'
import { canUseGlslEffects, hasGlslEffect, snapshotAdjustmentGlslEffectsForOverlay } from '../utils/glslEffects'
import { cullVisualLayerEntries } from '../utils/layerCompositing'
import ClipEffectSvgFilter from './effects/ClipEffectSvgFilter'
import GlslEffectCanvas from './effects/GlslEffectCanvas'

function sanitizeAdjustmentFilterId(value) {
  return String(value || 'adjustment-filter').replace(/[^a-zA-Z0-9_-]/g, '_')
}

function buildSvgAdjustmentStageNodes(stages, inputName, prefix) {
  const nodes = []
  let currentInput = inputName

  stages.forEach((stage, index) => {
    const resultName = `${prefix}-${stage.type}-${index}`
    if (stage.type === 'linear') {
      nodes.push(
        <feComponentTransfer in={currentInput} result={resultName} key={resultName}>
          <feFuncR type="linear" slope={stage.slope} intercept={stage.intercept} />
          <feFuncG type="linear" slope={stage.slope} intercept={stage.intercept} />
          <feFuncB type="linear" slope={stage.slope} intercept={stage.intercept} />
        </feComponentTransfer>
      )
    } else if (stage.type === 'saturate') {
      nodes.push(
        <feColorMatrix
          in={currentInput}
          type="saturate"
          values={stage.value}
          result={resultName}
          key={resultName}
        />
      )
    } else if (stage.type === 'hueRotate') {
      nodes.push(
        <feColorMatrix
          in={currentInput}
          type="hueRotate"
          values={stage.value}
          result={resultName}
          key={resultName}
        />
      )
    } else if (stage.type === 'gaussianBlur') {
      nodes.push(
        <feGaussianBlur
          in={currentInput}
          stdDeviation={stage.stdDeviation}
          result={resultName}
          key={resultName}
        />
      )
    }
    currentInput = resultName
  })

  return { nodes, result: currentInput }
}

const AdjustmentSvgFilter = memo(function AdjustmentSvgFilter({ filterId, settings }) {
  const normalized = normalizeAdjustmentSettings(settings)
  const globalStages = getAdjustmentSvgFilterStages(normalized, { includeBlur: false })
  const globalStageData = buildSvgAdjustmentStageNodes(globalStages, 'SourceGraphic', `${filterId}-global`)
  const globalResult = globalStageData.result || 'SourceGraphic'
  const nodes = [...globalStageData.nodes]
  let currentResult = globalResult

  for (const groupKey of TONAL_ADJUSTMENT_GROUP_KEYS) {
    if (!hasAdjustmentEffect(normalized[groupKey])) continue

    const groupStages = getAdjustmentSvgFilterStages(normalized[groupKey], { includeBlur: false })
    const adjustedStageData = buildSvgAdjustmentStageNodes(groupStages, globalResult, `${filterId}-${groupKey}`)
    const adjustedResult = adjustedStageData.result || globalResult
    const luminanceResult = `${filterId}-${groupKey}-luma`
    const maskResult = `${filterId}-${groupKey}-mask`
    const maskedResult = `${filterId}-${groupKey}-masked`
    const compositeResult = `${filterId}-${groupKey}-composite`

    nodes.push(...adjustedStageData.nodes)
    nodes.push(
      <feColorMatrix
        in={globalResult}
        type="luminanceToAlpha"
        result={luminanceResult}
        key={luminanceResult}
      />
    )
    nodes.push(
      <feComponentTransfer in={luminanceResult} result={maskResult} key={maskResult}>
        <feFuncA type="table" tableValues={getTonalMaskTableValues(groupKey)} />
      </feComponentTransfer>
    )
    nodes.push(
      <feComposite
        in={adjustedResult}
        in2={maskResult}
        operator="in"
        result={maskedResult}
        key={maskedResult}
      />
    )
    nodes.push(
      <feComposite
        in={maskedResult}
        in2={currentResult}
        operator="over"
        result={compositeResult}
        key={compositeResult}
      />
    )
    currentResult = compositeResult
  }

  if (normalized.blur > 0) {
    const blurResult = `${filterId}-blur`
    nodes.push(
      <feGaussianBlur
        in={currentResult}
        stdDeviation={normalized.blur}
        result={blurResult}
        key={blurResult}
      />
    )
    currentResult = blurResult
  }

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute h-0 w-0 overflow-hidden"
      focusable="false"
    >
      <defs>
        <filter
          id={filterId}
          x="-25%"
          y="-25%"
          width="150%"
          height="150%"
          colorInterpolationFilters="sRGB"
        >
          {nodes}
          {currentResult === 'SourceGraphic' ? (
            <feComponentTransfer in="SourceGraphic">
              <feFuncA type="identity" />
            </feComponentTransfer>
          ) : null}
        </filter>
      </defs>
    </svg>
  )
})

/**
 * Get scaled sprite style that fills the container while showing the correct frame
 * Returns style for an inner div that will be absolutely positioned and scaled
 */
function getScaledSpriteStyle(spriteData, time) {
  if (!spriteData || !spriteData.frames || !spriteData.url) return null

  const framePos = getSpriteFramePosition(spriteData, time)
  if (!framePos) return null

  // Just return the original sprite style - we'll handle scaling differently
  return {
    spriteUrl: spriteData.url,
    frameX: framePos.x,
    frameY: framePos.y,
    frameWidth: framePos.width,
    frameHeight: framePos.height,
    spriteWidth: spriteData.width,
    spriteHeight: spriteData.height,
  }
}

function getCenteredMediaFitStyle() {
  return {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    display: 'block',
    backgroundColor: 'transparent',
  }
}

function getClipPlaybackTimeAtTimeline(clip, timelineTime, endOffset = 0.01) {
  if (!clip) return 0
  const baseScale = clip.sourceTimeScale || (clip.timelineFps && clip.sourceFps
    ? clip.timelineFps / clip.sourceFps
    : 1)
  const speed = Number(clip.speed)
  const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
  const timeScale = baseScale * speedScale
  const reverse = !!clip.reverse
  const trimStart = clip.trimStart || 0
  const rawTrimEnd = clip.trimEnd ?? clip.sourceDuration ?? (trimStart + (clip.duration || 0) * timeScale)
  const trimEnd = Number.isFinite(rawTrimEnd) ? rawTrimEnd : trimStart
  const minTime = Math.min(trimStart, trimEnd)
  const maxTime = Math.max(trimStart, trimEnd)
  const sourceTime = reverse
    ? trimEnd - (timelineTime - (clip.startTime || 0)) * timeScale
    : trimStart + (timelineTime - (clip.startTime || 0)) * timeScale
  return Math.max(minTime, Math.min(sourceTime, Math.max(minTime, maxTime - endOffset)))
}

const CUT_FRAME_CACHE_LIMIT = 64
const CUT_FRAME_TIME_TOLERANCE = 0.04
const cutFrameCanvasCache = new Map()

function getCutFrameKey(clip, url) {
  if (!clip?.id || !url) return null
  return `${clip.id}|${url}`
}

function cloneVideoFrameToCanvas(video) {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas
  } catch (_) {
    return null
  }
}

function storeCutFrameCanvas(clip, url, video) {
  const key = getCutFrameKey(clip, url)
  if (!key) return false
  const canvas = cloneVideoFrameToCanvas(video)
  if (!canvas) return false
  cutFrameCanvasCache.set(key, { canvas, lastUsed: Date.now() })
  if (cutFrameCanvasCache.size > CUT_FRAME_CACHE_LIMIT) {
    const oldest = [...cutFrameCanvasCache.entries()]
      .sort((a, b) => (a[1]?.lastUsed || 0) - (b[1]?.lastUsed || 0))[0]?.[0]
    if (oldest) cutFrameCanvasCache.delete(oldest)
  }
  return true
}

function getCutFrameCanvas(clip, url) {
  const key = getCutFrameKey(clip, url)
  if (!key) return null
  const entry = cutFrameCanvasCache.get(key)
  if (!entry?.canvas) return null
  entry.lastUsed = Date.now()
  return entry.canvas
}

function drawCutFrameToCanvas(targetCanvas, sourceCanvas) {
  if (!targetCanvas || !sourceCanvas) return false
  const ctx = targetCanvas.getContext('2d')
  if (!ctx) return false
  targetCanvas.width = sourceCanvas.width
  targetCanvas.height = sourceCanvas.height
  ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height)
  ctx.drawImage(sourceCanvas, 0, 0, targetCanvas.width, targetCanvas.height)
  return true
}

function scheduleCutFrameCapture(clip, url, video, targetTime) {
  if (!clip || !url || !video) return
  const capture = () => {
    if (Math.abs((video.currentTime || 0) - targetTime) > CUT_FRAME_TIME_TOLERANCE) return
    storeCutFrameCanvas(clip, url, video)
  }
  const captureAfterDecodedFrame = () => {
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(capture)
    } else if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(capture)
    } else {
      setTimeout(capture, 16)
    }
  }
  if (video.readyState >= 2 && !video.seeking && Math.abs((video.currentTime || 0) - targetTime) <= CUT_FRAME_TIME_TOLERANCE) {
    captureAfterDecodedFrame()
    return
  }
  const onSeeked = () => {
    video.removeEventListener('seeked', onSeeked)
    captureAfterDecodedFrame()
  }
  video.addEventListener('seeked', onSeeked, { once: true })
}

/**
 * Track which clips are currently being loaded from disk to prevent duplicate loads
 */
const loadingCacheFromDisk = new Set()

/**
 * Cache of loaded blob URLs from disk (clipId -> blobUrl)
 * This persists across re-renders until the blob is explicitly revoked
 */
const diskCacheUrls = new Map()

/**
 * Helper to check if a blob URL is still valid
 * Blob URLs become invalid after page refresh
 */
function isBlobUrlValid(url) {
  if (!url || !url.startsWith('blob:')) return false
  // We can't truly validate a blob URL without fetching it,
  // but we can check if it's in our known-good map
  return diskCacheUrls.has(url) || false
}

/**
 * Hook to load render cache from disk when needed
 * This handles the case where a clip has cachePath but stale/invalid cacheUrl
 */
function useDiskCacheLoader(clip) {
  const currentProjectHandle = useProjectStore(state => state.currentProjectHandle)
  const setCacheUrl = useTimelineStore(state => state.setCacheUrl)
  const [loadedUrl, setLoadedUrl] = useState(null)

  useEffect(() => {
    // Only proceed if:
    // 1. We have a clip with a cachePath (saved to disk)
    // 2. The clip is marked as cached but cacheUrl is missing or might be stale
    // 3. We have a project handle to read from disk
    // 4. We're not already loading this clip
    if (!clip || !clip.cachePath || !currentProjectHandle) return
    if (loadingCacheFromDisk.has(clip.id)) return

    // Check if we already have a valid loaded URL for this clip
    const existingUrl = diskCacheUrls.get(clip.id)
    if (existingUrl) {
      setLoadedUrl(existingUrl)
      return
    }

    // Check if the current cacheUrl looks valid (not a stale blob URL)
    // After page refresh, blob URLs become invalid
    if (clip.cacheUrl && !clip.cacheUrl.startsWith('blob:')) {
      // Non-blob URL, probably fine
      return
    }

    // If cacheStatus is 'cached' but we don't have a verified URL, we need to reload
    // This happens after page refresh when blob URLs become invalid
    const needsReload = clip.cachePath && (
      !clip.cacheUrl ||
      (clip.cacheStatus === 'cached' && clip.cacheUrl?.startsWith('blob:') && !diskCacheUrls.has(clip.id))
    )

    if (!needsReload) return

    // Mark as loading to prevent duplicate loads
    loadingCacheFromDisk.add(clip.id)

    // Load from disk
    const loadFromDisk = async () => {
      try {
        console.log(`Loading render cache from disk for clip ${clip.id}: ${clip.cachePath}`)
        const result = await loadRenderCache(currentProjectHandle, clip.cachePath)

        if (result && result.url) {
          // Store in our local map for future reference
          diskCacheUrls.set(clip.id, result.url)

          // Update the clip's cacheUrl in the store
          setCacheUrl(clip.id, result.url, clip.cachePath)
          setLoadedUrl(result.url)

          console.log(`Successfully loaded render cache for clip ${clip.id}`)
        } else {
          console.warn(`Failed to load render cache for clip ${clip.id}: no URL returned`)
        }
      } catch (err) {
        console.error(`Error loading render cache for clip ${clip.id}:`, err)
      } finally {
        loadingCacheFromDisk.delete(clip.id)
      }
    }

    loadFromDisk()
  }, [clip?.id, clip?.cachePath, clip?.cacheUrl, clip?.cacheStatus, currentProjectHandle, setCacheUrl])

  return loadedUrl
}

/**
 * Hook to get the current valid URL for a clip
 * Falls back to clip.url if asset not found (for backwards compatibility)
 * Returns cached render URL if available and valid
 * Now also handles loading stale cache URLs from disk
 */
function useClipUrl(clip) {
  // Subscribe to the global proxy-preference toggle so the preview switches
  // tier live when the user flips it, without remounting components.
  const useProxyPlaybackForAssets = useTimelineStore(state => state.useProxyPlaybackForAssets)
  // Subscribe to this asset's URL so we re-render when playback cache is set (getAssetUrl alone doesn't trigger re-render)
  const assetUrl = useAssetsStore(state => {
    if (!clip?.assetId) return null
    const asset = state.assets.find(a => a.id === clip.assetId)
    if (!asset) return null
    // Tier preference for PREVIEW (not export):
    //   1. proxy (low-res, small decode cost) — only when user opted in
    //   2. playback cache (same-res H.264)
    //   3. source URL
    // Each tier is only used when its status is not 'failed' and the URL
    // is actually populated. A cache in 'encoding' state is ignored until
    // it flips to 'ready'.
    const useProxy = useProxyPlaybackForAssets && !!asset.proxyUrl && asset.proxyStatus !== 'failed'
    if (useProxy) return asset.proxyUrl
    const usePlaybackCache = !!asset.playbackCacheUrl && asset.playbackCacheStatus !== 'failed'
    return usePlaybackCache ? asset.playbackCacheUrl : (asset.url || null)
  })

  // This hook will trigger loading from disk if needed and return the loaded URL
  const diskLoadedUrl = useDiskCacheLoader(clip)

  return useMemo(() => {
    if (!clip) return { url: null, isCached: false }
    // For text clips, there's no URL
    if (clip.type === 'text') return { url: null, isCached: false }

    // Check if we have a valid cached render
    // Priority: diskLoadedUrl (freshly loaded) > clip.cacheUrl (from store)
    if (clip.cacheStatus === 'cached') {
      // Use disk-loaded URL if available (this is guaranteed fresh)
      if (diskLoadedUrl) {
        return { url: diskLoadedUrl, isCached: true }
      }
      // Use clip.cacheUrl if it's in our verified map
      if (clip.cacheUrl && diskCacheUrls.has(clip.id)) {
        return { url: clip.cacheUrl, isCached: true }
      }
      // Use clip.cacheUrl if it exists (might be from current session)
      if (clip.cacheUrl) {
        return { url: clip.cacheUrl, isCached: true }
      }
    }

    // Use URL from assets store (includes playback cache when ready — subscription above ensures we re-render when it's set)
    if (clip.assetId && assetUrl) {
      return { url: assetUrl, isCached: false }
    }
    // Fallback to clip's stored URL (may be stale after refresh)
    return { url: clip.url, isCached: false }
  }, [clip, clip?.assetId, clip?.cacheStatus, clip?.cacheUrl, clip?.id, diskLoadedUrl, assetUrl])
}

/**
 * Module-level cache of decoded mask-frame images.
 *
 * Rationale (and change history):
 *
 * The original live-preview path applied masks via CSS
 * `mask-image: url(<comfyui /view URL>)` on a div wrapping the video element
 * and swapped that URL to a different PNG on every tick of the PNG sequence.
 * That approach had a string of problems that turned out to be unfixable
 * without getting off the CSS-mask primitive entirely:
 *
 *   1. Every URL change made Chrome re-resolve the mask-image asset. Until
 *      that resolved (even from the CSS image cache), the element painted
 *      with no mask at all — the visible "flash to unmasked video".
 *   2. Even holding the URL constant, any state update in the app that
 *      caused React to re-spread the styles object onto the div (e.g. the
 *      ComfyUI WebSocket reconnect that fires every 5s on a dead
 *      connection, or any polling interval that happens to cascade into
 *      VideoLayer) made Chrome re-evaluate mask-image and occasionally
 *      drop it for a paint. User report: "it flashes every 5 seconds" while
 *      the playhead was parked.
 *   3. CSS mask-image puts the video layer onto a slow software paint path
 *      in Chromium; GPU-accelerated video layers and mask compositing don't
 *      play well together, so even the steady-state case was doing extra
 *      work on the CPU for no reason.
 *
 * The export path (`exporter.js`) has always composited masks on a canvas
 * via `globalCompositeOperation = 'destination-in'` and has never had any
 * of these issues because it's an atomic per-frame paint. MaskedVideoCanvas
 * below is the same algorithm running live. This module-level Map stores
 * the decoded `<img>` elements it needs; every entry is keyed by
 * `maskAsset.id` and carries a cheap `version` token so we rebuild when
 * the mask is regenerated but reuse when the same asset is applied to
 * another clip.
 *
 * Note: we still call the preloader for image-layer masks (which continue
 * to use CSS mask-image — different element, no flashing reported there).
 * Canvas compositing is video-only for now; images can follow if needed.
 */
// maskAsset.id -> { version, entries: Array<HTMLCanvasElement | null> }
// Each entry is the alpha-encoded processed canvas for one frame of the
// mask PNG sequence (see processMaskImageToAlphaCanvas), or null if that
// frame hasn't finished loading + processing yet.
const maskFramePreloadCache = new Map()

function collectMaskFrameUrls(maskAsset) {
  if (!maskAsset) return []
  const frames = Array.isArray(maskAsset.maskFrames) ? maskAsset.maskFrames : []
  const urls = frames.map((f) => f?.url).filter(Boolean)
  if (urls.length > 0) return urls
  return maskAsset.url ? [maskAsset.url] : []
}

/**
 * Turn a raw grayscale SAM3 mask PNG into a canvas whose ALPHA channel
 * encodes the mask. This is the piece CSS `mask-mode: luminance` does for
 * us behind the scenes; on canvas we have to do it explicitly because
 * `globalCompositeOperation = 'destination-in'` operates on the source's
 * alpha channel only. SAM3 PNGs ship as RGB (alpha=255 everywhere), so
 * without this pass `destination-in` would keep the whole frame.
 *
 * Runs once per frame at preload time, not per paint, so the ~10ms cost
 * of a per-pixel loop on a 1080p mask is paid once and then the render
 * loop stays free.
 */
function processMaskImageToAlphaCanvas(img) {
  const w = img?.naturalWidth
  const h = img?.naturalHeight
  if (!w || !h) return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, w, h)
    const pixels = data.data
    for (let i = 0; i < pixels.length; i += 4) {
      // Luminance → alpha. RGB can be anything afterwards since
      // destination-in only samples alpha; we set them white for clarity
      // while debugging (e.g. temporarily compositing onto a red bg).
      const lum = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3
      pixels[i] = 255
      pixels[i + 1] = 255
      pixels[i + 2] = 255
      pixels[i + 3] = lum
    }
    ctx.putImageData(data, 0, 0)
    return canvas
  } catch (err) {
    // SecurityError here means the image was cross-origin without CORS
    // headers — drawImage succeeded but getImageData tainted. Shouldn't
    // happen against ComfyUI's /view (open CORS) but we log so the
    // failure mode is findable if a user ever hits it.
    console.warn('[mask] failed to process mask image into alpha canvas', err)
    return null
  }
}

function ensureMaskFramesPreloaded(maskAsset) {
  if (!maskAsset?.id) return
  const urls = collectMaskFrameUrls(maskAsset)
  if (urls.length === 0) return
  // Version key invalidates the cache when the mask asset's frame list
  // changes (regeneration). We intentionally don't hash every URL — the
  // frame count flip plus first/last URLs is enough signal and keeps this
  // O(1) per mount.
  const version = `${urls.length}:${urls[0]}:${urls[urls.length - 1]}`
  const existing = maskFramePreloadCache.get(maskAsset.id)
  if (existing && existing.version === version) return

  // Entries start as null (not yet loaded + processed) and get filled in
  // when each Image's onload fires. The renderer treats null as "not
  // ready; draw video unmasked for this frame", so the user briefly sees
  // the raw clip for a paint or two and then the mask pops in — no more
  // disruptive than the mask itself appearing.
  const entries = urls.map(() => null)
  const record = { version, entries }
  maskFramePreloadCache.set(maskAsset.id, record)

  urls.forEach((url, idx) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => {
      // Guard against stale completions: if the record was replaced while
      // we were downloading (user regenerated the mask), drop the result.
      if (maskFramePreloadCache.get(maskAsset.id) !== record) return
      record.entries[idx] = processMaskImageToAlphaCanvas(img)
    }
    img.onerror = () => {
      if (maskFramePreloadCache.get(maskAsset.id) !== record) return
      // Leave as null; renderer will fall back to unmasked for this frame.
    }
    img.src = url
  })
}

function useMaskFramePreloader(maskAsset) {
  useEffect(() => {
    if (!maskAsset) return
    ensureMaskFramesPreloaded(maskAsset)
  }, [maskAsset?.id, maskAsset?.frameCount, maskAsset?.maskFrames?.length])
}

/**
 * Look up a preloaded, alpha-encoded mask canvas for a given frame index.
 * Returns null if the frame hasn't finished decoding + processing yet —
 * callers should either draw the unmasked video or skip the draw.
 */
function getPreloadedMaskFrame(maskAsset, frameIndex) {
  if (!maskAsset?.id) return null
  const entry = maskFramePreloadCache.get(maskAsset.id)
  if (!entry || !Array.isArray(entry.entries) || entry.entries.length === 0) return null
  const clamped = Math.max(0, Math.min(frameIndex | 0, entry.entries.length - 1))
  return entry.entries[clamped] || null
}

/**
 * Hook that figures out the *active* mask for a clip and the correct
 * frame index within it, without producing any CSS styles.
 *
 * Used by:
 *   - `MaskedVideoCanvas` to know what to paint.
 *   - `VideoLayer` to decide whether to render the canvas compositor at all.
 *
 * Deliberately split from `useMaskEffectStyle` below: image layers still
 * go through CSS mask (works fine there, no flashing reported), video layers
 * go through the canvas compositor (no CSS mask at all).
 */
function useMaskFrameSelection(clip, playheadPosition, isCachedRender = false) {
  const getAssetById = useAssetsStore(state => state.getAssetById)

  // Identity-only memo: only recomputes when the clip's effect list changes
  // or a new mask asset is assigned. Does NOT depend on playheadPosition.
  const meta = useMemo(() => {
    if (isCachedRender || !clip || !clip.effects) return { isActive: false }
    const maskEffects = clip.effects.filter((e) => e.type === 'mask' && e.enabled)
    if (maskEffects.length === 0) return { isActive: false }
    const effect = maskEffects[0]
    const asset = getAssetById(effect.maskAssetId)
    if (!asset) return { isActive: false }
    const sourceAsset = asset.sourceAssetId ? getAssetById(asset.sourceAssetId) : null
    return {
      isActive: true,
      maskAsset: asset,
      invertMask: !!effect.invertMask,
      maskFrameCount: asset.frameCount || asset.maskFrames?.length || 1,
      sourceDuration:
        clip.sourceDuration
        || sourceAsset?.duration
        || sourceAsset?.settings?.duration
        || asset?.settings?.duration
        || clip.duration,
    }
  }, [clip, clip?.effects, isCachedRender, getAssetById])

  // Kick off preloading for the mask's PNG sequence as soon as it's bound
  // to a clip. Harmless if already cached.
  useMaskFramePreloader(meta.maskAsset)

  // The only piece of state that changes as the playhead moves.
  const frameIndex = useMemo(() => {
    if (!meta.isActive || !meta.maskAsset) return 0
    if (!Array.isArray(meta.maskAsset.maskFrames) || meta.maskAsset.maskFrames.length <= 1) return 0
    const clipTime = playheadPosition - clip.startTime
    const rawTimeScale = clip?.sourceTimeScale || (clip?.timelineFps && clip?.sourceFps
      ? clip.timelineFps / clip.sourceFps
      : 1)
    const speed = Number(clip?.speed)
    const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
    const timeScale = rawTimeScale * speedScale
    const reverse = !!clip?.reverse
    const trimStart = clip.trimStart || 0
    const rawTrimEnd = clip.trimEnd ?? meta.sourceDuration ?? trimStart
    const trimEnd = Number.isFinite(rawTrimEnd) ? rawTrimEnd : trimStart
    const sourceTime = reverse
      ? trimEnd - clipTime * timeScale
      : trimStart + clipTime * timeScale
    const sourceProgress = meta.sourceDuration > 0
      ? Math.max(0, Math.min(1, sourceTime / meta.sourceDuration))
      : 0
    return Math.min(
      Math.max(0, Math.floor(sourceProgress * meta.maskFrameCount)),
      meta.maskFrameCount - 1,
    )
  }, [
    meta.isActive,
    meta.maskAsset,
    meta.maskFrameCount,
    meta.sourceDuration,
    clip?.startTime,
    clip?.sourceTimeScale,
    clip?.timelineFps,
    clip?.sourceFps,
    clip?.speed,
    clip?.reverse,
    clip?.trimStart,
    clip?.trimEnd,
    playheadPosition,
  ])

  return {
    isActive: !!meta.isActive,
    maskAsset: meta.maskAsset || null,
    invertMask: !!meta.invertMask,
    frameIndex,
    maskFrameCount: meta.maskFrameCount || 0,
  }
}

/**
 * Legacy CSS-mask hook.
 *
 * Kept ONLY for image layers; video layers no longer touch CSS mask
 * because it flashes whenever any unrelated state update causes the
 * styles object to be re-spread onto the div (see the comment on
 * `maskFramePreloadCache`). Video layers use `<MaskedVideoCanvas>`
 * instead.
 *
 * When called on a video clip this returns `{}` so callers that still
 * spread `...maskStyles` are no-ops. That's the cheapest way to disarm
 * the CSS path without surgery at every call site.
 */
function useMaskEffectStyle(clip, playheadPosition, isCachedRender = false) {
  const getAssetById = useAssetsStore(state => state.getAssetById)

  // Always keep the preloader warm if a mask is bound, even on video
  // clips — MaskedVideoCanvas reads from the same cache.
  const resolvedMaskAsset = useMemo(() => {
    if (isCachedRender || !clip?.effects) return null
    const effects = clip.effects.filter((e) => e.type === 'mask' && e.enabled)
    if (effects.length === 0) return null
    return getAssetById(effects[0].maskAssetId) || null
  }, [clip, clip?.effects, isCachedRender, getAssetById])
  useMaskFramePreloader(resolvedMaskAsset)

  return useMemo(() => {
    if (isCachedRender) return {}
    // Video clips: canvas compositor handles it. Don't fight it from CSS.
    if (clip?.type === 'video') return {}
    if (!resolvedMaskAsset) return {}

    const maskFrameCount = resolvedMaskAsset.frameCount || resolvedMaskAsset.maskFrames?.length || 1
    const sourceAsset = resolvedMaskAsset.sourceAssetId ? getAssetById(resolvedMaskAsset.sourceAssetId) : null
    const sourceDuration = clip.sourceDuration
      || sourceAsset?.duration
      || sourceAsset?.settings?.duration
      || resolvedMaskAsset?.settings?.duration
      || clip.duration

    let maskUrl = resolvedMaskAsset.url
    let frameIndex = 0
    if (Array.isArray(resolvedMaskAsset.maskFrames) && resolvedMaskAsset.maskFrames.length > 1) {
      const clipTime = playheadPosition - clip.startTime
      const rawTimeScale = clip?.sourceTimeScale || (clip?.timelineFps && clip?.sourceFps
        ? clip.timelineFps / clip.sourceFps
        : 1)
      const speed = Number(clip?.speed)
      const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
      const timeScale = rawTimeScale * speedScale
      const reverse = !!clip?.reverse
      const trimStart = clip.trimStart || 0
      const rawTrimEnd = clip.trimEnd ?? sourceDuration ?? trimStart
      const trimEnd = Number.isFinite(rawTrimEnd) ? rawTrimEnd : trimStart
      const sourceTime = reverse
        ? trimEnd - clipTime * timeScale
        : trimStart + clipTime * timeScale
      const sourceProgress = sourceDuration > 0
        ? Math.max(0, Math.min(1, sourceTime / sourceDuration))
        : 0
      frameIndex = Math.min(
        Math.max(0, Math.floor(sourceProgress * maskFrameCount)),
        maskFrameCount - 1,
      )
      maskUrl = resolvedMaskAsset.maskFrames[frameIndex]?.url || maskUrl
    }
    if (!maskUrl) return {}

    const invertMask = !!clip.effects.find((e) => e.type === 'mask' && e.enabled)?.invertMask

    const maskStyles = {
      WebkitMaskImage: `url(${maskUrl})`,
      maskImage: `url(${maskUrl})`,
      WebkitMaskSize: 'contain',
      maskSize: 'contain',
      WebkitMaskPosition: 'center',
      maskPosition: 'center',
      WebkitMaskRepeat: 'no-repeat',
      maskRepeat: 'no-repeat',
      WebkitMaskMode: 'luminance',
      maskMode: 'luminance',
    }

    if (invertMask) {
      maskStyles.filter = 'invert(1)'
    }

    return maskStyles
  }, [isCachedRender, clip, clip?.type, clip?.effects, clip?.startTime, clip?.sourceDuration, clip?.duration, clip?.sourceTimeScale, clip?.timelineFps, clip?.sourceFps, clip?.speed, clip?.reverse, clip?.trimStart, clip?.trimEnd, resolvedMaskAsset, playheadPosition, getAssetById])
}

/**
 * Canvas compositor for masked video clips.
 *
 * Draws `<video>` frames + the matching mask PNG into a canvas every tick,
 * using `globalCompositeOperation = 'destination-in'` (or 'destination-out'
 * for inverted masks) to punch out the unmasked areas. This is the same
 * algorithm `exporter.js` uses when baking the render cache — we're just
 * running it live.
 *
 * Why not CSS `mask-image`: see the big block comment on
 * `maskFramePreloadCache` above. Tl;dr: it flashes. This component does
 * not.
 *
 * What it does NOT own:
 *   - Keeping the `<video>` element loaded / seeking / playback / audio.
 *     That's still `VideoLayer`'s job via `videoCache`. We just peek at
 *     the element and sample whatever frame it currently has decoded.
 *   - Hold-frame behavior during clip-src transitions. For masked clips
 *     there's a brief unmasked frame at cuts; acceptable since the render
 *     cache exists exactly for this case.
 *
 * What it DOES own:
 *   - A single `<canvas>` element positioned where the video would have
 *     painted, with the same CSS transforms / filters / opacity applied.
 *   - A RAF-driven draw loop that paints only when something has changed
 *     (video frame time, mask frame index, or mask invert). Idle cost is
 *     a per-RAF dirty check — a few microseconds.
 *   - Drawing the source video unmasked as a fallback when the mask frame
 *     hasn't finished decoding yet. That one-frame "unmasked flash" on
 *     very first paint is the only failure mode that survived the
 *     rewrite, and it disappears as soon as the preloader finishes.
 */
const MaskedVideoCanvas = memo(function MaskedVideoCanvas({
  clip,
  layerIndex,
  transformStyle,
  combinedFilter,
  opacity,
  maskAsset,
  frameIndex,
  invertMask,
}) {
  const canvasRef = useRef(null)
  const getAssetById = useAssetsStore(state => state.getAssetById)

  // Hot inputs live in refs so the RAF loop sees the latest values without
  // the effect tearing down on every frame-index bump.
  const maskAssetRef = useRef(maskAsset)
  const frameIndexRef = useRef(frameIndex)
  const invertMaskRef = useRef(invertMask)
  useEffect(() => { maskAssetRef.current = maskAsset }, [maskAsset])
  useEffect(() => { frameIndexRef.current = frameIndex }, [frameIndex])
  useEffect(() => { invertMaskRef.current = invertMask }, [invertMask])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return
    let disposed = false
    let rafId = null

    // Previous-paint signature. We only actually draw when something has
    // changed, so a paused playhead with a loaded mask costs O(1) per RAF
    // (one object-prop compare) and stays stable at ~60fps budget.
    const last = {
      maskAssetId: null,
      frame: -1,
      videoTime: -1,
      invert: null,
      w: 0,
      h: 0,
      hadMask: null,
    }

    const getVideo = () => {
      const resolvedUrl = resolvePlaybackUrl(clip, getAssetById)
      if (!resolvedUrl) return null
      // videoCache keys on a { ...clip, url } shape. We build the same shape
      // rather than mutating the caller's clip object.
      const clipWithUrl = { ...clip, url: resolvedUrl }
      return videoCache.getVideoElement(clipWithUrl)
    }

    const tick = () => {
      if (disposed) return
      const video = getVideo()
      if (video && video.videoWidth && video.videoHeight && video.readyState >= 2) {
        const vw = video.videoWidth
        const vh = video.videoHeight
        const maskAssetCur = maskAssetRef.current
        // maskCanvas is the alpha-encoded canvas produced by
        // processMaskImageToAlphaCanvas; null if the PNG hasn't finished
        // loading yet or if SAM3 handed us something we can't process.
        const maskCanvas = getPreloadedMaskFrame(maskAssetCur, frameIndexRef.current)
        const currentTime = video.currentTime
        const hadMask = !!maskCanvas
        const invert = !!invertMaskRef.current
        const maskAssetId = maskAssetCur?.id || null

        const changed =
          last.w !== vw ||
          last.h !== vh ||
          last.maskAssetId !== maskAssetId ||
          last.frame !== frameIndexRef.current ||
          Math.abs(last.videoTime - currentTime) > 0.0001 ||
          last.invert !== invert ||
          last.hadMask !== hadMask

        if (changed) {
          if (canvas.width !== vw) canvas.width = vw
          if (canvas.height !== vh) canvas.height = vh

          ctx.globalCompositeOperation = 'source-over'
          ctx.clearRect(0, 0, vw, vh)
          try {
            ctx.drawImage(video, 0, 0, vw, vh)
          } catch (_) {
            // drawImage throws if the video element is in a weird interim
            // state (readyState 2 but no decoded frame yet on some codecs).
            // Swallow and try again next tick.
          }

          if (maskCanvas) {
            // destination-in / destination-out sample the SOURCE's alpha
            // channel only. processMaskImageToAlphaCanvas pre-baked the
            // mask's luminance into its alpha channel, so these ops do
            // what the user expects: keep the video where the mask is
            // bright (or where it's dark, if invertMask is on).
            ctx.globalCompositeOperation = invert ? 'destination-out' : 'destination-in'
            try {
              ctx.drawImage(maskCanvas, 0, 0, vw, vh)
            } catch (_) { /* same rationale as drawImage(video) above */ }
            ctx.globalCompositeOperation = 'source-over'
          }
          // When maskCanvas is null we intentionally leave the unmasked
          // video on the canvas. That's a better failure mode than
          // showing a black hole while the first PNG decodes.

          last.maskAssetId = maskAssetId
          last.frame = frameIndexRef.current
          last.videoTime = currentTime
          last.invert = invert
          last.w = vw
          last.h = vh
          last.hadMask = hadMask
        }
      }
      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => {
      disposed = true
      if (rafId) cancelAnimationFrame(rafId)
    }
    // Intentionally keyed on clip identity only — everything else runs
    // through refs. A render that flips the clip (different source) tears
    // the loop down and rebuilds it against the new video element.
  }, [clip?.id, clip?.assetId, getAssetById])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none bg-transparent"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100%',
        height: '100%',
        // Keep aspect when the canvas backing store != element size.
        // The backing store is the video's natural size; the element is
        // sized to the preview area. This maps to the same behavior as
        // `object-fit: contain` on a <video>.
        objectFit: 'contain',
        zIndex: layerIndex + 4, // above hold-frame + container
        opacity,
        ...transformStyle,
        filter: combinedFilter,
      }}
      aria-hidden="true"
    />
  )
})

/**
 * VideoLayerRenderer - Renders video layers with preloading for seamless playback
 *
 * This component handles:
 * - Preloading upcoming clips before they're needed
 * - Seamless transitions between adjacent clips (no black flicker)
 * - Multi-layer compositing with cached videos
 * - Proper sync between timeline position and video playback
 */

// How far ahead to preload (in seconds)
const PRELOAD_LOOKAHEAD = 2.5
// Give the incoming clip a little extra time to warm up before a transition
// becomes visible. This helps avoid the first-frame flash at the seam.
const TRANSITION_PREROLL_LOOKAHEAD = 0.4
const PLAYBACK_DIAG_KEY = 'comfystudio-playback-diag'

function isPlaybackDiagEnabled() {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(PLAYBACK_DIAG_KEY) === '1'
}

function shortPlaybackUrl(url) {
  if (!url) return null
  const asString = String(url)
  return asString.length > 72 ? `${asString.slice(0, 72)}...` : asString
}

function normalizeTransitionSplit(split = null) {
  const clipA = Number(split?.clipA)
  const clipB = Number(split?.clipB)
  const hasClipA = Number.isFinite(clipA) && clipA >= 0
  const hasClipB = Number.isFinite(clipB) && clipB >= 0
  if (hasClipA && hasClipB) {
    const total = clipA + clipB
    if (total > 0) {
      return { clipA: clipA / total, clipB: clipB / total }
    }
  }
  return { clipA: 0.5, clipB: 0.5 }
}

function logPlaybackDiag(event, payload = {}) {
  if (!isPlaybackDiagEnabled()) return
  const nowSeconds = typeof performance !== 'undefined'
    ? Number((performance.now() / 1000).toFixed(3))
    : null
  console.log(`[PlaybackDiag] ${event}`, { t: nowSeconds, ...payload })
}

function resolvePlaybackUrl(clip, getAssetById, options = {}) {
  if (!clip || clip.type !== 'video') return null
  if (clip.cacheStatus === 'cached' && clip.cacheUrl) {
    return clip.cacheUrl
  }
  const asset = clip.assetId ? getAssetById(clip.assetId) : null
  // Tier chain (preview only): proxy → playback cache → source.
  // If callers don't explicitly pass the preference (e.g. a RAF tick inside
  // a useEffect that doesn't subscribe to the store), we read it directly
  // from timelineStore. The outer components that DO subscribe to the
  // preference will re-render and rebuild these closures when the toggle
  // flips, so the RAF loops naturally pick up the new tier.
  const useProxyPreference = Object.prototype.hasOwnProperty.call(options, 'useProxyPlaybackForAssets')
    ? Boolean(options.useProxyPlaybackForAssets)
    : Boolean(useTimelineStore.getState().useProxyPlaybackForAssets)
  const useProxy = useProxyPreference && !!asset?.proxyUrl && asset?.proxyStatus !== 'failed'
  if (useProxy) return asset.proxyUrl
  const usePlaybackCache = !!asset?.playbackCacheUrl && asset?.playbackCacheStatus !== 'failed'
  return (usePlaybackCache ? asset?.playbackCacheUrl : null) || asset?.url || clip.url || null
}

/**
 * Single video layer component - renders one video with transforms
 */
const VideoLayer = memo(function VideoLayer({
  clip,
  track,
  layerIndex,
  totalLayers,
  playheadPosition,
  isPlaying,
  buildVideoTransform,
  getClipTransform,
  onClipPointerDown,
  isInTransition = false, // Whether this clip is part of a transition
}) {
  const containerRef = useRef(null)   // Container we attach the cached video element to
  const videoElementRef = useRef(null) // Cached video element we display (avoids black flash at cuts)
  const holdFrameRef = useRef(null) // Canvas to hold last frame during src changes
  const lastPlaybackDebugRef = useRef(0) // Throttle playback debug logs
  const [isReady, setIsReady] = useState(false)
  const [showHoldFrame, setShowHoldFrame] = useState(false)
  const [showSprite, setShowSprite] = useState(false)
  const [spriteContainerSize, setSpriteContainerSize] = useState({ width: 0, height: 0 })
  const [glslRendered, setGlslRendered] = useState(false)
  const lastSyncTime = useRef(0)
  const lastSeekTime = useRef(0)
  const seekDebounceRef = useRef(null)
  const isScrubbing = useRef(false)
  const lastPlayheadRef = useRef(playheadPosition)
  const lastClipUrlRef = useRef(null) // Track src changes for hold frame
  const diagEventTimesRef = useRef({})
  const attemptedPlaybackFallbackRef = useRef(false)

  // Get the current valid URL (may be cached render or original)
  const { url: clipUrl, isCached: isCachedRender } = useClipUrl(clip)

  // Get sprite data for this clip's asset
  const getAssetSprite = useAssetsStore(state => state.getAssetSprite)
  const getAssetById = useAssetsStore(state => state.getAssetById)
  const markPlaybackCacheBroken = useAssetsStore(state => state.markPlaybackCacheBroken)
  const spriteData = clip?.assetId ? getAssetSprite(clip.assetId) : null
  const asset = clip?.assetId ? getAssetById(clip.assetId) : null
  const assetId = asset?.id || null
  const assetPlaybackCacheUrl = asset?.playbackCacheUrl || null
  const assetSourceUrl = asset?.url || null

  // Feature flag: Enable/disable sprite sheet scrubbing for real-time preview
  // Set to false to disable sprite scrubbing (will use video seeking instead)
  const ENABLE_SPRITE_SCRUBBING = false

  const useSpriteScrub = ENABLE_SPRITE_SCRUBBING && !!spriteData?.url && !isCachedRender

  // Mask effect selection. Video clips use the canvas compositor (see
  // MaskedVideoCanvas + the big comment on maskFramePreloadCache for why).
  // useMaskEffectStyle returns `{}` for video clips, so the legacy style
  // spread below is a harmless no-op — we keep it there to avoid touching
  // every JSX site for this change.
  const maskSelection = useMaskFrameSelection(clip, playheadPosition, isCachedRender)
  const maskStyles = useMaskEffectStyle(clip, playheadPosition, isCachedRender)
  // Sprite overlay is behind a feature flag that's currently off
  // (ENABLE_SPRITE_SCRUBBING = false), so this is also an inert `{}` for
  // video clips. Kept for parity with the existing spread sites.
  const spriteMaskStyles = useMaskEffectStyle(clip, playheadPosition, false)

  // Calculate clip-relative time for keyframe evaluation
  const clipTime = playheadPosition - (clip?.startTime || 0)
  const rawTimeScale = clip?.sourceTimeScale || (clip?.timelineFps && clip?.sourceFps
    ? clip.timelineFps / clip.sourceFps
    : 1)
  const speed = Number(clip?.speed)
  const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
  const timeScale = isCachedRender ? 1 : rawTimeScale * speedScale
  const reverse = !!clip?.reverse
  const trimStart = clip?.trimStart || 0
  const rawTrimEnd = clip?.trimEnd ?? clip?.sourceDuration ?? (trimStart + (clip?.duration || 0) * timeScale)
  const trimEnd = Number.isFinite(rawTrimEnd) ? rawTrimEnd : trimStart
  const minTime = Math.min(trimStart, trimEnd)
  const maxTime = Math.max(trimStart, trimEnd)

  // Calculate source time for sprite frame lookup
  const sourceTime = reverse
    ? trimEnd - clipTime * timeScale
    : trimStart + clipTime * timeScale

  const logLayerDiag = useCallback((event, payload = {}, throttleMs = 0) => {
    if (!isPlaybackDiagEnabled()) return
    if (throttleMs > 0) {
      const now = Date.now()
      const last = diagEventTimesRef.current[event] || 0
      if (now - last < throttleMs) return
      diagEventTimesRef.current[event] = now
    }
    logPlaybackDiag(event, {
      clipId: clip?.id,
      trackId: track?.id,
      ...payload,
    })
  }, [clip?.id, track?.id])

  useEffect(() => {
    attemptedPlaybackFallbackRef.current = false
  }, [clip?.id, clipUrl])

  const attemptPlaybackCacheFallback = useCallback((reason, details = {}) => {
    if (attemptedPlaybackFallbackRef.current) return false
    if (!clip?.id || !clip?.assetId || !assetId) return false

    const usingRenderCache = Boolean(clip.cacheStatus === 'cached' && clip.cacheUrl && clipUrl === clip.cacheUrl)
    if (usingRenderCache) return false

    const playbackCacheUrl = assetPlaybackCacheUrl
    const sourceUrl = assetSourceUrl
    const usingPlaybackCache = Boolean(playbackCacheUrl && clipUrl && clipUrl === playbackCacheUrl)
    const canFallbackToSource = Boolean(sourceUrl && sourceUrl !== playbackCacheUrl)
    if (!usingPlaybackCache || !canFallbackToSource) return false

    attemptedPlaybackFallbackRef.current = true

    logLayerDiag('playback-cache:fallback', {
      reason,
      fromUrl: shortPlaybackUrl(playbackCacheUrl),
      toUrl: shortPlaybackUrl(sourceUrl),
      ...details,
    })

    if (typeof localStorage !== 'undefined' && localStorage.getItem('comfystudio-debug-playback') === '1') {
      console.warn('[PlaybackCache] Falling back to source media', {
        clipId: clip.id,
        assetId: asset.id,
        reason,
      })
    }

    markPlaybackCacheBroken(assetId, reason)
    videoCache.invalidateClipSource(clip.id, playbackCacheUrl)
    setIsReady(false)
    return true
  }, [
    assetId,
    assetPlaybackCacheUrl,
    assetSourceUrl,
    clip?.assetId,
    clip?.cacheStatus,
    clip?.cacheUrl,
    clip?.id,
    clipUrl,
    logLayerDiag,
    markPlaybackCacheBroken,
  ])

  // Get animated transform (with keyframes applied) and fold in any
  // camera-shake effect offsets so handheld motion survives export/preview
  // parity.
  const animatedTransform = useMemo(() => {
    if (!clip) return null
    const base = getAnimatedTransform(clip, clipTime)
    return applyEffectsToTransform(base, clip?.effects, clipTime)
  }, [clip, clipTime])

  // Get sprite frame info for current time (memoized to prevent recalculations)
  const spriteInfo = useMemo(() => {
    if (!spriteData || !spriteData.url) return null
    return getScaledSpriteStyle(spriteData, sourceTime)
  }, [spriteData, sourceTime])

  const updateSpriteContainerSize = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const width = Math.round(rect.width)
    const height = Math.round(rect.height)
    setSpriteContainerSize(prev => (
      prev.width === width && prev.height === height ? prev : { width, height }
    ))
  }, [])

  useLayoutEffect(() => {
    let ro
    let rafId

    const tryAttach = () => {
      const el = containerRef.current
      if (!el) {
        rafId = requestAnimationFrame(tryAttach)
        return
      }
      updateSpriteContainerSize()
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(updateSpriteContainerSize)
        ro.observe(el)
      } else {
        window.addEventListener('resize', updateSpriteContainerSize)
      }
    }

    tryAttach()

    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      if (ro) ro.disconnect()
      window.removeEventListener('resize', updateSpriteContainerSize)
    }
  }, [updateSpriteContainerSize])

  const spriteOverlayStyle = useMemo(() => {
    if (!spriteInfo || !spriteContainerSize.width || !spriteContainerSize.height) return null
    const scale = Math.min(
      spriteContainerSize.width / spriteInfo.frameWidth,
      spriteContainerSize.height / spriteInfo.frameHeight
    )
    const scaledSpriteWidth = spriteInfo.spriteWidth * scale
    const scaledSpriteHeight = spriteInfo.spriteHeight * scale
    const offsetX = (spriteContainerSize.width - spriteInfo.frameWidth * scale) / 2 - (spriteInfo.frameX * scale)
    const offsetY = (spriteContainerSize.height - spriteInfo.frameHeight * scale) / 2 - (spriteInfo.frameY * scale)

    return {
      backgroundImage: `url(${spriteInfo.spriteUrl})`,
      backgroundRepeat: 'no-repeat',
      backgroundSize: `${scaledSpriteWidth}px ${scaledSpriteHeight}px`,
      backgroundPosition: `${offsetX}px ${offsetY}px`,
    }
  }, [spriteInfo, spriteContainerSize])

  const captureHoldFrame = useCallback((video) => {
    const canvas = holdFrameRef.current
    if (!canvas || !video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return true
  }, [])

  // Attach the cache's video element to our container so we show the preloaded element at cuts (no black flash)
  useEffect(() => {
    if (!clipUrl || !clip?.id || !containerRef.current) return

    const currentPlayhead = useTimelineStore.getState().playheadPosition
    const previousUrl = lastClipUrlRef.current
    const hasSourceChange = Boolean(previousUrl && previousUrl !== clipUrl)
    logLayerDiag('layer:attach:start', {
      playhead: Number(currentPlayhead.toFixed(3)),
      url: shortPlaybackUrl(clipUrl),
      previousUrl: shortPlaybackUrl(previousUrl),
      hasSourceChange,
      inTransition: isInTransition,
    })
    if (!isInTransition && hasSourceChange && captureHoldFrame(videoElementRef.current)) {
      setShowHoldFrame(true)
      logLayerDiag('layer:hold-frame:capture', {
        fromUrl: shortPlaybackUrl(previousUrl),
        toUrl: shortPlaybackUrl(clipUrl),
      })
    }
    lastClipUrlRef.current = clipUrl

    const clipWithUrl = { id: clip.id, url: clipUrl }
    const cachedVideo = videoCache.getVideoElement(clipWithUrl)
    if (!cachedVideo) {
      logLayerDiag('layer:attach:cache-miss', {
        url: shortPlaybackUrl(clipUrl),
      })
      return
    }

    const container = containerRef.current
    const previousLayerVideo = videoElementRef.current
    if (previousLayerVideo && previousLayerVideo !== cachedVideo && previousLayerVideo.parentNode === container) {
      previousLayerVideo.pause()
      container.removeChild(previousLayerVideo)
      logLayerDiag('layer:replace-video', {
        oldCurrentTime: Number((previousLayerVideo.currentTime || 0).toFixed(3)),
        newCurrentTime: Number((cachedVideo.currentTime || 0).toFixed(3)),
      })
    }
    if (cachedVideo.parentNode !== container) {
      container.appendChild(cachedVideo)
      logLayerDiag('layer:attach:reparent', {
        readyState: cachedVideo.readyState,
        currentTime: Number((cachedVideo.currentTime || 0).toFixed(3)),
      })
    }

    // Style the video to fill the container (cache already set muted, playsInline, etc.)
    Object.assign(cachedVideo.style, {
      ...getCenteredMediaFitStyle(),
      objectFit: 'contain',
    })

    let pendingPreciseSeek = false
    let revealFrameRequest = 0
    let revealRaf = 0
    let cutFrameReleaseFrameRequest = 0
    let cutFrameReleaseTimeout = 0

    const releaseCutFrameOverlay = () => {
      cutFrameReleaseFrameRequest = 0
      cutFrameReleaseTimeout = 0
      setShowHoldFrame(false)
    }

    const scheduleCutFrameOverlayRelease = () => {
      if (cutFrameReleaseFrameRequest || cutFrameReleaseTimeout) return
      if (typeof cachedVideo.requestVideoFrameCallback === 'function') {
        cutFrameReleaseFrameRequest = cachedVideo.requestVideoFrameCallback(() => {
          cutFrameReleaseTimeout = setTimeout(releaseCutFrameOverlay, 24)
        })
      } else {
        cutFrameReleaseTimeout = setTimeout(releaseCutFrameOverlay, 80)
      }
    }

    const maybeShowCachedCutFrameOverlay = () => {
      if (isInTransition) return false
      const cutFrameCanvas = getCutFrameCanvas(clip, clipUrl)
      if (!cutFrameCanvas) return false
      if (!drawCutFrameToCanvas(holdFrameRef.current, cutFrameCanvas)) return false
      setShowHoldFrame(true)
      scheduleCutFrameOverlayRelease()
      return true
    }

    const revealReadyFrame = (reason) => {
      setIsReady(true)
      if (!isInTransition && !cutFrameReleaseFrameRequest && !cutFrameReleaseTimeout) {
        setShowHoldFrame(false)
      }
      logLayerDiag('layer:ready', {
        reason,
        readyState: cachedVideo.readyState,
        networkState: cachedVideo.networkState,
        currentTime: Number((cachedVideo.currentTime || 0).toFixed(3)),
      })
    }

    const revealAfterDecodedFrame = (reason) => {
      if (typeof cachedVideo.requestVideoFrameCallback === 'function') {
        revealFrameRequest = cachedVideo.requestVideoFrameCallback(() => {
          revealFrameRequest = 0
          revealReadyFrame(reason)
        })
        return
      }
      revealRaf = requestAnimationFrame(() => {
        revealRaf = 0
        revealReadyFrame(reason)
      })
    }

    const syncVideoToCurrentPlayhead = (reason) => {
      const livePlayhead = useTimelineStore.getState().playheadPosition
      const targetTime = getClipPlaybackTimeAtTimeline(clip, livePlayhead)
      const beforeTime = cachedVideo.currentTime || 0
      const timeDelta = Math.abs(beforeTime - targetTime)
      const seekNeeded = timeDelta > 0.001
      if (seekNeeded) {
        pendingPreciseSeek = true
        setIsReady(false)
        if (cachedVideo.readyState >= 1) {
          cachedVideo.currentTime = targetTime
        }
      } else if (cachedVideo.readyState >= 2) {
        pendingPreciseSeek = false
        revealReadyFrame(`${reason}-within-frame`)
      }
      logLayerDiag('layer:seek', {
        reason,
        livePlayhead: Number(livePlayhead.toFixed(3)),
        from: Number(beforeTime.toFixed(3)),
        to: Number(targetTime.toFixed(3)),
        delta: Number(timeDelta.toFixed(3)),
        readyState: cachedVideo.readyState,
      }, reason === 'sync' ? 180 : 0)
      return { targetTime, seekNeeded }
    }

    let attachSync = { targetTime: 0, seekNeeded: false }

    const markReady = (reason) => {
      if (cachedVideo.readyState >= 2) {
        if (pendingPreciseSeek) return
        revealReadyFrame(reason)
      }
    }

    const onLoadedData = () => {
      const sync = syncVideoToCurrentPlayhead('loadeddata')
      if (!sync.seekNeeded) markReady('loadeddata')
    }
    const onCanPlay = () => {
      const sync = syncVideoToCurrentPlayhead('canplay')
      if (!sync.seekNeeded) markReady('canplay')
    }
    const onWaiting = () => {
      logLayerDiag('video:waiting', { readyState: cachedVideo.readyState, networkState: cachedVideo.networkState }, 220)
      if (cachedVideo.readyState === 0 && cachedVideo.networkState === 3) {
        attemptPlaybackCacheFallback('waiting-network-no-source', {
          readyState: cachedVideo.readyState,
          networkState: cachedVideo.networkState,
        })
      }
    }
    const onStalled = () => logLayerDiag('video:stalled', { readyState: cachedVideo.readyState, networkState: cachedVideo.networkState }, 220)
    const onSeeking = () => logLayerDiag('video:seeking', { currentTime: Number((cachedVideo.currentTime || 0).toFixed(3)) }, 160)
    const onSeeked = () => {
      logLayerDiag('video:seeked', { currentTime: Number((cachedVideo.currentTime || 0).toFixed(3)) }, 160)
      if (pendingPreciseSeek && cachedVideo.readyState >= 2) {
        pendingPreciseSeek = false
        revealAfterDecodedFrame('seeked')
      }
    }
    const onPlaying = () => logLayerDiag('video:playing', { currentTime: Number((cachedVideo.currentTime || 0).toFixed(3)) }, 220)
    const onPaused = () => logLayerDiag('video:pause', { currentTime: Number((cachedVideo.currentTime || 0).toFixed(3)) }, 220)
    const onError = () => {
      const errorCode = cachedVideo.error?.code || null
      logLayerDiag('video:error', { code: errorCode })
      attemptPlaybackCacheFallback(`video-error-${errorCode || 'unknown'}`, {
        code: errorCode,
        readyState: cachedVideo.readyState,
        networkState: cachedVideo.networkState,
      })
    }
    cachedVideo.addEventListener('waiting', onWaiting)
    cachedVideo.addEventListener('stalled', onStalled)
    cachedVideo.addEventListener('seeking', onSeeking)
    cachedVideo.addEventListener('seeked', onSeeked)
    cachedVideo.addEventListener('playing', onPlaying)
    cachedVideo.addEventListener('pause', onPaused)
    cachedVideo.addEventListener('error', onError)

    const showedCutFrameOverlay = maybeShowCachedCutFrameOverlay()
    attachSync = syncVideoToCurrentPlayhead('attach')
    if (!isInTransition && attachSync.seekNeeded) {
      scheduleCutFrameCapture(clip, clipUrl, cachedVideo, attachSync.targetTime)
    } else if (!isInTransition && !showedCutFrameOverlay && cachedVideo.readyState >= 2) {
      scheduleCutFrameCapture(clip, clipUrl, cachedVideo, attachSync.targetTime)
    }

    if (cachedVideo.readyState >= 2 && !attachSync.seekNeeded) {
      markReady('already-ready')
    } else {
      setIsReady(false)
      cachedVideo.addEventListener('loadeddata', onLoadedData, { once: true })
      cachedVideo.addEventListener('canplay', onCanPlay, { once: true })
    }

    videoElementRef.current = cachedVideo

    if (typeof localStorage !== 'undefined' && localStorage.getItem('comfystudio-debug-playback') === '1') {
      console.log('[PlaybackCache] VideoLayer attached:', { clipId: clip?.id, readyState: cachedVideo.readyState, srcHint: (clipUrl || '').slice(0, 50) + '...' })
    }

    return () => {
      cachedVideo.removeEventListener('loadeddata', onLoadedData)
      cachedVideo.removeEventListener('canplay', onCanPlay)
      cachedVideo.removeEventListener('waiting', onWaiting)
      cachedVideo.removeEventListener('stalled', onStalled)
      cachedVideo.removeEventListener('seeking', onSeeking)
      cachedVideo.removeEventListener('seeked', onSeeked)
      cachedVideo.removeEventListener('playing', onPlaying)
      cachedVideo.removeEventListener('pause', onPaused)
      cachedVideo.removeEventListener('error', onError)
      if (revealFrameRequest && typeof cachedVideo.cancelVideoFrameCallback === 'function') {
        cachedVideo.cancelVideoFrameCallback(revealFrameRequest)
      }
      if (cutFrameReleaseFrameRequest && typeof cachedVideo.cancelVideoFrameCallback === 'function') {
        cachedVideo.cancelVideoFrameCallback(cutFrameReleaseFrameRequest)
      }
      if (revealRaf) cancelAnimationFrame(revealRaf)
      if (cutFrameReleaseTimeout) clearTimeout(cutFrameReleaseTimeout)
      logLayerDiag('layer:detach', {
        readyState: cachedVideo.readyState,
        currentTime: Number((cachedVideo.currentTime || 0).toFixed(3)),
      })
      if (videoElementRef.current === cachedVideo) {
        videoElementRef.current = null
      }
    }
  }, [
    attemptPlaybackCacheFallback,
    clipUrl,
    clip?.id,
    clip?.startTime,
    clip?.duration,
    clip?.trimStart,
    clip?.trimEnd,
    clip?.sourceDuration,
    clip?.sourceTimeScale,
    clip?.timelineFps,
    clip?.sourceFps,
    clip?.speed,
    clip?.reverse,
    clip?.cacheStatus,
    clip?.cacheUrl,
    captureHoldFrame,
    isInTransition,
    logLayerDiag,
  ])

  // Detect scrubbing (rapid playhead changes while paused)
  useEffect(() => {
    if (isPlaying) {
      isScrubbing.current = false
      if (showSprite) setShowSprite(false)
      return
    }

    const playheadDelta = Math.abs(playheadPosition - lastPlayheadRef.current)
    lastPlayheadRef.current = playheadPosition

    // If playhead moved significantly while paused, we're scrubbing
    if (playheadDelta > 0.01) {
      isScrubbing.current = true
      // Show sprite during scrubbing if available (only set if not already showing)
      if (useSpriteScrub && !showSprite) {
        setShowSprite(true)
      }

      // Reset scrubbing flag after user stops for 150ms
      if (seekDebounceRef.current) {
        clearTimeout(seekDebounceRef.current)
      }
      seekDebounceRef.current = setTimeout(() => {
        isScrubbing.current = false
        setShowSprite(false)
        // Force a final precise seek when scrubbing stops
        const video = videoElementRef.current
        if (video && clip) {
          const currentPlayhead = useTimelineStore.getState().playheadPosition
          const sourceTime = reverse
            ? trimEnd - (currentPlayhead - clip.startTime) * timeScale
            : trimStart + (currentPlayhead - clip.startTime) * timeScale
          const clampedTime = Math.max(minTime, Math.min(sourceTime, maxTime))
          video.currentTime = clampedTime
        }
      }, 150)
    }

    return () => {
      if (seekDebounceRef.current) {
        clearTimeout(seekDebounceRef.current)
      }
    }
  }, [playheadPosition, isPlaying]) // Removed spriteData and clip from deps to prevent loops

  // If cached render becomes available, hide sprite overlay
  useEffect(() => {
    if (isCachedRender && showSprite) {
      setShowSprite(false)
    }
  }, [isCachedRender, showSprite])

  // Sync video playback with timeline
  useEffect(() => {
    const video = videoElementRef.current
    if (!video || !clip) return
    const sourceTime = reverse
      ? trimEnd - clipTime * timeScale
      : trimStart + clipTime * timeScale

    // Clamp sourceTime to valid range
    const clampedTime = Math.max(minTime, Math.min(sourceTime, maxTime - 0.01)) // Stay slightly before end

    // Calculate time difference
    const timeDiff = Math.abs(video.currentTime - clampedTime)
    const debugPlayback = (
      (typeof localStorage !== 'undefined' && localStorage.getItem('comfystudio-debug-playback') === '1')
      || isPlaybackDiagEnabled()
    )

    // Use different sync strategies for playing vs paused vs scrubbing
    if (isPlaying) {
      // Debug: log when playing but video not ready (common cause of black during play)
      if (debugPlayback && video.readyState < 2) {
        const now = Date.now()
        if (now - lastPlaybackDebugRef.current > 1000) {
          lastPlaybackDebugRef.current = now
          console.warn('[PlaybackCache] Playing but video not ready — can cause black:', { clipId: clip.id, readyState: video.readyState, networkState: video.networkState })
          logLayerDiag('sync:not-ready', {
            readyState: video.readyState,
            networkState: video.networkState,
            currentTime: Number((video.currentTime || 0).toFixed(3)),
            targetTime: Number(clampedTime.toFixed(3)),
          }, 500)
        }
      }

      if (video.readyState === 0 && video.networkState === 3) {
        const fallbackTriggered = attemptPlaybackCacheFallback('sync-network-no-source', {
          readyState: video.readyState,
          networkState: video.networkState,
          currentTime: Number((video.currentTime || 0).toFixed(3)),
        })
        if (fallbackTriggered) {
          return
        }
      }

      // When playing: Let the video play naturally, only correct large drifts
      // During transitions, use a larger threshold to avoid fighting between two videos
      const speedMismatch = Math.abs(timeScale - 1) > 0.001
      const driftThreshold = isInTransition
        ? 0.25
        : (speedMismatch ? 0.9 : 0.7)
      const boundaryEpsilon = 0.03
      const nearForwardEnd = !reverse && clampedTime >= (maxTime - boundaryEpsilon)
      const nearReverseStart = reverse && clampedTime <= (minTime + boundaryEpsilon)

      if (reverse) {
        // Reverse playback: seek-only (no native reverse playback)
        if (timeDiff > 0.02) {
          logLayerDiag('sync:reverse-seek', {
            timeDiff: Number(timeDiff.toFixed(3)),
            from: Number((video.currentTime || 0).toFixed(3)),
            to: Number(clampedTime.toFixed(3)),
          }, 140)
          video.currentTime = clampedTime
          lastSyncTime.current = playheadPosition
        }
        if (nearReverseStart) {
          if (!video.paused) {
            video.pause()
          }
          logLayerDiag('sync:freeze-at-start', {
            currentTime: Number((video.currentTime || 0).toFixed(3)),
            minTime: Number(minTime.toFixed(3)),
          }, 180)
        }
        if (!video.paused) {
          video.pause()
        }
      } else {
        if (timeDiff > driftThreshold) {
          if (debugPlayback && Date.now() - lastPlaybackDebugRef.current > 1000) {
            lastPlaybackDebugRef.current = Date.now()
            console.log('[PlaybackCache] Seek during playback (drift correction):', { clipId: clip.id, timeDiff: timeDiff.toFixed(2), clampedTime: clampedTime.toFixed(2) })
          }
          logLayerDiag('sync:drift-seek', {
            timeDiff: Number(timeDiff.toFixed(3)),
            threshold: Number(driftThreshold.toFixed(3)),
            from: Number((video.currentTime || 0).toFixed(3)),
            to: Number(clampedTime.toFixed(3)),
            inTransition: isInTransition,
          }, 120)
          video.currentTime = clampedTime
          lastSyncTime.current = playheadPosition
        }

        // Ensure playback rate matches clip time scale
        const playbackSpeed = Math.max(0.01, Math.abs(timeScale))
        if (Number.isFinite(playbackSpeed) && Math.abs(video.playbackRate - playbackSpeed) > 0.001) {
          video.playbackRate = playbackSpeed
        }

        if (nearForwardEnd) {
          if (timeDiff > 0.01) {
            video.currentTime = clampedTime
          }
          if (!video.paused) {
            video.pause()
          }
          logLayerDiag('sync:freeze-at-end', {
            currentTime: Number((video.currentTime || 0).toFixed(3)),
            maxTime: Number(maxTime.toFixed(3)),
            clampedTime: Number(clampedTime.toFixed(3)),
          }, 180)
          return
        }

        // Start playing if paused and ready (don't wait for canplay - seek immediately)
        if (video.paused) {
          if (video.readyState >= 2) {
            // Video has enough data to play - seek first, then play
            if (timeDiff > 0.02) {
              video.currentTime = clampedTime
            }
            logLayerDiag('sync:play', {
              currentTime: Number((video.currentTime || 0).toFixed(3)),
              playbackRate: Number((video.playbackRate || 0).toFixed(3)),
              timeDiff: Number(timeDiff.toFixed(3)),
            }, 240)
            video.play().catch(() => {})
          }
        }
      }
    } else if (isScrubbing.current) {
      // When scrubbing with sprite: skip video seeking entirely (sprite handles display)
      // When scrubbing without sprite: use throttled seeking
      if (!useSpriteScrub) {
        const now = performance.now()
        if (now - lastSeekTime.current > 50) { // 50ms = 20 fps during scrub
          // Use fastSeek if available (seeks to nearest keyframe - much faster)
          if (video.fastSeek && typeof video.fastSeek === 'function') {
            video.fastSeek(clampedTime)
          } else {
            video.currentTime = clampedTime
          }
          lastSeekTime.current = now
        }
      }

      // Ensure video is paused
      if (!video.paused) {
        video.pause()
      }
    } else {
      // When paused (not scrubbing): Use tight threshold for precise positioning
      // Seek immediately if video is ready, don't wait
      if (video.readyState >= 1 && timeDiff > 0.05) {
        logLayerDiag('sync:paused-seek', {
          timeDiff: Number(timeDiff.toFixed(3)),
          from: Number((video.currentTime || 0).toFixed(3)),
          to: Number(clampedTime.toFixed(3)),
        }, 150)
        video.currentTime = clampedTime
        lastSyncTime.current = playheadPosition
      }

      // Ensure video is paused
      if (!video.paused) {
        video.pause()
      }
    }
  }, [clip, clipTime, playheadPosition, isPlaying, spriteData, isInTransition, timeScale, useSpriteScrub, logLayerDiag, attemptPlaybackCacheFallback])

  if (!clip) return null

  // Use animated transform instead of base transform
  const transformStyle = buildVideoTransform(animatedTransform)
  const adjustmentSettings = useMemo(() => (
    normalizeAdjustmentSettings(getAnimatedAdjustmentSettings(clip, clipTime) || clip?.adjustments || {})
  ), [clip, clipTime])
  const hasTonalAdjustments = useMemo(
    () => hasTonalAdjustmentEffect(adjustmentSettings),
    [adjustmentSettings]
  )
  const adjustmentFilterId = useMemo(
    () => `clip-adjustment-${sanitizeAdjustmentFilterId(clip?.id)}-video`,
    [clip?.id]
  )
  const adjustmentFilterValue = useMemo(() => {
    if (hasTonalAdjustments) {
      return `url(#${adjustmentFilterId})`
    }
    const filterValue = buildCssFilterFromAdjustments(adjustmentSettings)
    return filterValue !== 'none' ? filterValue : undefined
  }, [adjustmentFilterId, adjustmentSettings, hasTonalAdjustments])
  const hasClipPixelEffects = hasPixelFilterEffect(clip?.effects)
  const hasClipGlslEffects = hasGlslEffect(clip?.effects)
  const clipEffectsFilterId = useMemo(
    () => getClipEffectFilterId(clip?.id, 'video'),
    [clip?.id]
  )
  const clipEffectsFilterValue = hasClipPixelEffects ? `url(#${clipEffectsFilterId})` : undefined
  const vignetteEffect = useMemo(
    () => (hasVignetteEffect(clip?.effects) ? getActiveVignetteEffect(clip?.effects, clipTime) : null),
    [clip?.effects, clipTime]
  )
  const vignetteOverlayStyle = useMemo(
    () => (vignetteEffect ? buildVignetteOverlayStyle(vignetteEffect, clipTime) : null),
    [vignetteEffect, clipTime]
  )
  const letterboxEffect = useMemo(
    () => (hasLetterboxEffect(clip?.effects) ? getActiveLetterboxEffect(clip?.effects, clipTime) : null),
    [clip?.effects, clipTime]
  )
  const letterboxOverlayStyles = useMemo(
    () => (letterboxEffect ? buildLetterboxOverlayStyles(letterboxEffect, clipTime) : null),
    [letterboxEffect, clipTime]
  )
  // Combine adjustment filter, effect filter, transform blur, and mask filter.
  const combinedFilter = [clipEffectsFilterValue, adjustmentFilterValue, transformStyle.filter, maskStyles.filter].filter(Boolean).join(' ') || undefined
  const spriteCombinedFilter = [clipEffectsFilterValue, adjustmentFilterValue, transformStyle.filter, spriteMaskStyles.filter].filter(Boolean).join(' ') || undefined

  // When a mask is active we hand visible rendering off to
  // MaskedVideoCanvas (below). The container div still hosts the <video>
  // element (needed for playback timing, seeking, and audio) but with
  // opacity:0 so we don't see the unmasked frame through the mask. Same
  // for the hold-frame canvas — during a cut on a masked clip we accept
  // a brief frame of unmasked content rather than try to apply the mask
  // to the hold-frame layer (render cache covers that use case better).
  const maskActive = maskSelection.isActive
  const glslPreviewActive = hasClipGlslEffects && !maskActive && canUseGlslEffects()
  // During transitions, a clip can briefly render as black before its first
  // decoded frame is available. Keep transition participants hidden until
  // ready so the outgoing clip remains stable on first playback pass.
  const transitionWaitingForFrame = isInTransition && !isReady
  const containerOpacity = maskActive
    ? 0
    : (glslRendered || (showSprite && spriteInfo) || showHoldFrame || transitionWaitingForFrame ? 0 : 1)

  useEffect(() => {
    if (!glslPreviewActive) setGlslRendered(false)
  }, [glslPreviewActive])

  return (
    <>
      {hasTonalAdjustments && (
        <AdjustmentSvgFilter filterId={adjustmentFilterId} settings={adjustmentSettings} />
      )}
      {hasClipPixelEffects && (
        <ClipEffectSvgFilter
          filterId={clipEffectsFilterId}
          effects={clip?.effects}
          clipTime={clipTime}
        />
      )}
      {/* Container for cached video element (displaying cache = no black flash at cuts) */}
      <div
        ref={containerRef}
        className="bg-transparent w-full h-full"
        onPointerDown={(e) => {
          if (typeof onClipPointerDown === 'function') {
            onClipPointerDown(clip, e)
          }
        }}
        style={{
          position: layerIndex === 0 ? 'relative' : 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: layerIndex + 1,
          opacity: containerOpacity,
          ...transformStyle,
          ...maskStyles,
          filter: combinedFilter,
        }}
      >
        {vignetteOverlayStyle && (
          <div aria-hidden style={vignetteOverlayStyle} />
        )}
        {letterboxOverlayStyles && (
          <div aria-hidden style={letterboxOverlayStyles.wrapper}>
            <div style={letterboxOverlayStyles.inner} />
          </div>
        )}
      </div>

      {glslPreviewActive && (
        <div
          className="pointer-events-none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: layerIndex + 2,
            overflow: 'hidden',
            ...transformStyle,
            ...maskStyles,
            filter: combinedFilter,
          }}
        >
          <GlslEffectCanvas
            sourceRef={videoElementRef}
            effects={clip?.effects}
            clipTime={clipTime}
            onRenderState={setGlslRendered}
            style={{
              ...getCenteredMediaFitStyle(),
              objectFit: 'contain',
            }}
          />
          {vignetteOverlayStyle && (
            <div aria-hidden style={vignetteOverlayStyle} />
          )}
          {letterboxOverlayStyles && (
            <div aria-hidden style={letterboxOverlayStyles.wrapper}>
              <div style={letterboxOverlayStyles.inner} />
            </div>
          )}
        </div>
      )}

      {/* Masked video compositor. Rendered only when a mask effect is
          active on this clip; reads the same video element as the
          container above via videoCache and paints a per-frame composite
          onto its own canvas. See MaskedVideoCanvas header for details. */}
      {maskActive && (
        <MaskedVideoCanvas
          clip={clip}
          layerIndex={layerIndex}
          transformStyle={transformStyle}
          combinedFilter={combinedFilter}
          opacity={1}
          maskAsset={maskSelection.maskAsset}
          frameIndex={maskSelection.frameIndex}
          invertMask={maskSelection.invertMask}
        />
      )}

      {/* Hold frame canvas - shows last frame during video src transition to prevent black flicker */}
      <div
        className="pointer-events-none"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: layerIndex + 3,
          display: showHoldFrame && !maskActive ? 'block' : 'none',
          ...transformStyle,
          ...maskStyles,
          filter: combinedFilter,
        }}
      >
        <canvas
          ref={holdFrameRef}
          style={getCenteredMediaFitStyle()}
        />
      </div>

      {/* Sprite overlay (shown during fast scrubbing) */}
      {showSprite && spriteOverlayStyle && !maskActive && (
        <div
          className="pointer-events-none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: layerIndex + 2,
            overflow: 'hidden',
            ...spriteOverlayStyle,
            ...transformStyle,
            ...spriteMaskStyles,
            filter: spriteCombinedFilter,
          }}
        />
      )}
    </>
  )
})

/**
 * Image layer component - renders static image with transforms
 */
const ImageLayer = memo(function ImageLayer({
  clip,
  track,
  layerIndex,
  totalLayers,
  playheadPosition,
  buildVideoTransform,
  getClipTransform,
  onClipPointerDown,
}) {
  const imageElementRef = useRef(null)
  const [glslRendered, setGlslRendered] = useState(false)
  // Get the current valid URL (may be cached render or original)
  const { url: clipUrl, isCached: isCachedRender } = useClipUrl(clip)

  // Get mask effect styles if any (skip if using cached render)
  const maskStyles = useMaskEffectStyle(clip, playheadPosition, isCachedRender)

  if (!clipUrl) return null

  // Calculate clip-relative time for keyframe evaluation
  const clipTime = playheadPosition - (clip?.startTime || 0)

  // Get animated transform (with keyframes applied) + camera shake offsets
  const animatedTransform = useMemo(() => {
    const base = getAnimatedTransform(clip, clipTime)
    return applyEffectsToTransform(base, clip?.effects, clipTime)
  }, [clip, clipTime])

  const transformStyle = buildVideoTransform(animatedTransform)
  const adjustmentSettings = useMemo(() => (
    normalizeAdjustmentSettings(getAnimatedAdjustmentSettings(clip, clipTime) || clip?.adjustments || {})
  ), [clip, clipTime])
  const hasTonalAdjustments = useMemo(
    () => hasTonalAdjustmentEffect(adjustmentSettings),
    [adjustmentSettings]
  )
  const adjustmentFilterId = useMemo(
    () => `clip-adjustment-${sanitizeAdjustmentFilterId(clip?.id)}-image`,
    [clip?.id]
  )
  const adjustmentFilterValue = useMemo(() => {
    if (hasTonalAdjustments) {
      return `url(#${adjustmentFilterId})`
    }
    const filterValue = buildCssFilterFromAdjustments(adjustmentSettings)
    return filterValue !== 'none' ? filterValue : undefined
  }, [adjustmentFilterId, adjustmentSettings, hasTonalAdjustments])
  const hasClipPixelEffects = hasPixelFilterEffect(clip?.effects)
  const hasClipGlslEffects = hasGlslEffect(clip?.effects)
  const glslPreviewActive = hasClipGlslEffects && canUseGlslEffects()
  useEffect(() => {
    if (!glslPreviewActive) setGlslRendered(false)
  }, [glslPreviewActive])
  const clipEffectsFilterId = useMemo(
    () => getClipEffectFilterId(clip?.id, 'image'),
    [clip?.id]
  )
  const clipEffectsFilterValue = hasClipPixelEffects ? `url(#${clipEffectsFilterId})` : undefined
  const vignetteEffect = useMemo(
    () => (hasVignetteEffect(clip?.effects) ? getActiveVignetteEffect(clip?.effects, clipTime) : null),
    [clip?.effects, clipTime]
  )
  const vignetteOverlayStyle = useMemo(
    () => (vignetteEffect ? buildVignetteOverlayStyle(vignetteEffect, clipTime) : null),
    [vignetteEffect, clipTime]
  )
  const letterboxEffect = useMemo(
    () => (hasLetterboxEffect(clip?.effects) ? getActiveLetterboxEffect(clip?.effects, clipTime) : null),
    [clip?.effects, clipTime]
  )
  const letterboxOverlayStyles = useMemo(
    () => (letterboxEffect ? buildLetterboxOverlayStyles(letterboxEffect, clipTime) : null),
    [letterboxEffect, clipTime]
  )
  const combinedFilter = [clipEffectsFilterValue, adjustmentFilterValue, transformStyle.filter, maskStyles.filter].filter(Boolean).join(' ') || undefined

  return (
    <>
      {hasTonalAdjustments && (
        <AdjustmentSvgFilter filterId={adjustmentFilterId} settings={adjustmentSettings} />
      )}
      {hasClipPixelEffects && (
        <ClipEffectSvgFilter
          filterId={clipEffectsFilterId}
          effects={clip?.effects}
          clipTime={clipTime}
        />
      )}
      <div
        className="bg-transparent w-full h-full"
        style={{
          position: layerIndex === 0 ? 'relative' : 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: layerIndex + 1,
          ...transformStyle,
          ...maskStyles,
          filter: combinedFilter,
        }}
        onPointerDown={(e) => {
          if (typeof onClipPointerDown === 'function') {
            onClipPointerDown(clip, e)
          }
        }}
      >
        <img
          ref={imageElementRef}
          src={clipUrl}
          alt={clip.name || 'Image'}
          className="bg-transparent"
          style={{
            ...getCenteredMediaFitStyle(),
            objectFit: 'contain',
            opacity: glslRendered ? 0 : 1,
            zIndex: 1,
          }}
          onContextMenu={(e) => e.preventDefault()}
          draggable={false}
        />
        {glslPreviewActive && (
          <GlslEffectCanvas
            sourceRef={imageElementRef}
            sourceUrl={clipUrl}
            effects={clip?.effects}
            clipTime={clipTime}
            onRenderState={setGlslRendered}
            style={{
              ...getCenteredMediaFitStyle(),
              objectFit: 'contain',
              zIndex: 2,
            }}
          />
        )}
        {vignetteOverlayStyle && (
          <div aria-hidden style={vignetteOverlayStyle} />
        )}
        {letterboxOverlayStyles && (
          <div aria-hidden style={letterboxOverlayStyles.wrapper}>
            <div style={letterboxOverlayStyles.inner} />
          </div>
        )}
      </div>
    </>
  )
})

/**
 * Text layer component - renders text overlay with transforms
 */
const TextLayer = memo(function TextLayer({
  clip,
  track,
  layerIndex,
  totalLayers,
  playheadPosition,
  buildVideoTransform,
  getClipTransform,
  onClipPointerDown,
  onClipDoubleClick,
  previewScale = 1,
}) {
  if (!clip || clip.type !== 'text') return null

  // Calculate clip-relative time for keyframe evaluation
  const clipTime = playheadPosition - (clip?.startTime || 0)

  // Get animated transform (with keyframes applied) + camera shake offsets
  const animatedTransform = useMemo(() => {
    const base = getAnimatedTransform(clip, clipTime)
    return applyEffectsToTransform(base, clip?.effects, clipTime)
  }, [clip, clipTime])

  const transformStyle = buildVideoTransform(animatedTransform)
  const adjustmentSettings = useMemo(() => (
    normalizeAdjustmentSettings(getAnimatedAdjustmentSettings(clip, clipTime) || clip?.adjustments || {})
  ), [clip, clipTime])
  const hasTonalAdjustments = useMemo(
    () => hasTonalAdjustmentEffect(adjustmentSettings),
    [adjustmentSettings]
  )
  const adjustmentFilterId = useMemo(
    () => `clip-adjustment-${sanitizeAdjustmentFilterId(clip?.id)}-text`,
    [clip?.id]
  )
  const adjustmentFilterValue = useMemo(() => {
    if (hasTonalAdjustments) {
      return `url(#${adjustmentFilterId})`
    }
    const filterValue = buildCssFilterFromAdjustments(adjustmentSettings)
    return filterValue !== 'none' ? filterValue : undefined
  }, [adjustmentFilterId, adjustmentSettings, hasTonalAdjustments])
  const hasClipPixelEffects = hasPixelFilterEffect(clip?.effects)
  const clipEffectsFilterId = useMemo(
    () => getClipEffectFilterId(clip?.id, 'text'),
    [clip?.id]
  )
  const clipEffectsFilterValue = hasClipPixelEffects ? `url(#${clipEffectsFilterId})` : undefined
  const vignetteEffect = useMemo(
    () => (hasVignetteEffect(clip?.effects) ? getActiveVignetteEffect(clip?.effects, clipTime) : null),
    [clip?.effects, clipTime]
  )
  const vignetteOverlayStyle = useMemo(
    () => (vignetteEffect ? buildVignetteOverlayStyle(vignetteEffect, clipTime) : null),
    [vignetteEffect, clipTime]
  )
  const letterboxEffect = useMemo(
    () => (hasLetterboxEffect(clip?.effects) ? getActiveLetterboxEffect(clip?.effects, clipTime) : null),
    [clip?.effects, clipTime]
  )
  const letterboxOverlayStyles = useMemo(
    () => (letterboxEffect ? buildLetterboxOverlayStyles(letterboxEffect, clipTime) : null),
    [letterboxEffect, clipTime]
  )
  const combinedFilter = [clipEffectsFilterValue, adjustmentFilterValue, transformStyle.filter].filter(Boolean).join(' ') || undefined
  const textProps = clip.textProperties || {}
  const safePreviewScale = Number.isFinite(previewScale) && previewScale > 0 ? previewScale : 1
  const scaledFontSize = (textProps.fontSize || 64) * safePreviewScale
  const scaledStrokeWidth = (textProps.strokeWidth || 0) * safePreviewScale
  const scaledShadowOffsetX = (textProps.shadowOffsetX || 2) * safePreviewScale
  const scaledShadowOffsetY = (textProps.shadowOffsetY || 2) * safePreviewScale
  const scaledShadowBlur = (textProps.shadowBlur || 4) * safePreviewScale

  // Build text styles from textProperties
  const textStyle = {
    fontFamily: textProps.fontFamily || 'Inter',
    fontSize: `${scaledFontSize}px`,
    fontWeight: textProps.fontWeight || 'bold',
    fontStyle: textProps.fontStyle || 'normal',
    color: textProps.textColor || '#FFFFFF',
    textAlign: textProps.textAlign || 'center',
    letterSpacing: textProps.letterSpacing ? `${textProps.letterSpacing * safePreviewScale}px` : 'normal',
    lineHeight: textProps.lineHeight || 1.2,
    // Text stroke
    WebkitTextStroke: textProps.strokeWidth > 0
      ? `${scaledStrokeWidth}px ${textProps.strokeColor || '#000000'}`
      : 'none',
    paintOrder: 'stroke fill',
    // Text shadow
    textShadow: textProps.shadow
      ? `${scaledShadowOffsetX}px ${scaledShadowOffsetY}px ${scaledShadowBlur}px ${textProps.shadowColor || 'rgba(0,0,0,0.5)'}`
      : 'none',
  }

  // Background style
  const backgroundStyle = textProps.backgroundOpacity > 0
    ? {
        backgroundColor: textProps.backgroundColor || '#000000',
        opacity: textProps.backgroundOpacity / 100,
        padding: `${(textProps.backgroundPadding || 20) * safePreviewScale}px`,
        borderRadius: `${8 * safePreviewScale}px`,
      }
    : {}

  // Vertical alignment
  const getVerticalAlign = () => {
    switch (textProps.verticalAlign) {
      case 'top': return 'flex-start'
      case 'bottom': return 'flex-end'
      default: return 'center'
    }
  }

  return (
    <>
      {hasTonalAdjustments && (
        <AdjustmentSvgFilter filterId={adjustmentFilterId} settings={adjustmentSettings} />
      )}
      {hasClipPixelEffects && (
        <ClipEffectSvgFilter
          filterId={clipEffectsFilterId}
          effects={clip?.effects}
          clipTime={clipTime}
        />
      )}
      <div
        className="absolute inset-0 flex items-center justify-center"
        onPointerDown={(e) => {
          if (typeof onClipPointerDown === 'function') {
            onClipPointerDown(clip, e)
          }
        }}
        onDoubleClick={(e) => {
          if (typeof onClipDoubleClick === 'function') {
            onClipDoubleClick(clip, e)
          }
        }}
        style={{
          zIndex: layerIndex + 1,
          alignItems: getVerticalAlign(),
          ...transformStyle,
          filter: combinedFilter,
        }}
      >
        <div
          className="relative"
          style={backgroundStyle}
        >
          <span
            style={textStyle}
            className="whitespace-pre-wrap"
          >
            {textProps.text || 'Sample Text'}
          </span>
        </div>
        {vignetteOverlayStyle && (
          <div aria-hidden style={vignetteOverlayStyle} />
        )}
        {letterboxOverlayStyles && (
          <div aria-hidden style={letterboxOverlayStyles.wrapper}>
            <div style={letterboxOverlayStyles.inner} />
          </div>
        )}
      </div>
    </>
  )
})

/**
 * AdjustmentWrapper wraps all layers below an adjustment clip so that
 * CSS `filter` (brightness/contrast/etc.) applies to the composited content
 * and CSS `transform` (position/scale/rotation/flip/crop/anchor) correctly
 * transforms the entire composited output.
 *
 * Opacity and blend-mode are handled via an inner backdrop-filter element
 * so they composite against the original (unfiltered) content, matching
 * the export-path behaviour.
 */
const AdjustmentWrapper = memo(function AdjustmentWrapper({ clip, playheadPosition, buildVideoTransform, children }) {
  const clipTime = playheadPosition - (clip?.startTime || 0)

  const adjustmentSettings = useMemo(() => {
    const animated = getAnimatedAdjustmentSettings(clip, clipTime) || clip?.adjustments || {}
    return normalizeAdjustmentSettings(animated)
  }, [clip, clipTime])

  // Compose camera shake (and any other transform-affecting effects) onto
  // the adjustment clip's transform so it shakes all layers beneath.
  const effectsTransform = useMemo(() => {
    const base = getAnimatedTransform(clip, clipTime) || clip?.transform || {}
    return applyEffectsToTransform(base, clip?.effects, clipTime)
  }, [clip, clipTime])

  const wrapperStyle = useMemo(() => {
    const t = effectsTransform || clip?.transform || {}
    const opacity = typeof t.opacity === 'number' ? t.opacity : 100
    const opacityFactor = Math.max(0, Math.min(1, opacity / 100))

    // Scale adjustment values by opacity so 50% opacity = half-strength filter.
    // Mathematically correct for linear filters (brightness, contrast, saturation)
    // and a close approximation for hue-rotate and blur.
    const scaledSettings = scaleAdjustmentSettings(adjustmentSettings, opacityFactor)
    const cssFilter = buildCssFilterFromAdjustments(scaledSettings)
    const effectiveFilter = cssFilter !== 'none' ? cssFilter : null
    const hasEffect = hasAdjustmentEffect(scaledSettings)

    // Use buildVideoTransform to get properly scaled CSS styles (position,
    // scale, rotation, anchor, crop, blend mode — all preview-scale aware).
    const baseStyle = buildVideoTransform(effectsTransform) || {}

    const ws = {
      position: 'absolute',
      top: 0, left: 0, right: 0, bottom: 0,
    }
    if (baseStyle.transform) ws.transform = baseStyle.transform
    if (baseStyle.transformOrigin) ws.transformOrigin = baseStyle.transformOrigin
    if (baseStyle.clipPath) ws.clipPath = baseStyle.clipPath
    if (baseStyle.mixBlendMode) ws.mixBlendMode = baseStyle.mixBlendMode
    // Don't apply baseStyle.opacity — opacity is folded into filter strength.
    // Don't apply baseStyle.filter — that's the transform blur; adjustment
    // filter is the one we care about.

    if (effectiveFilter) {
      ws.filter = effectiveFilter
      ws.WebkitFilter = effectiveFilter
    }

    ws._hasVisualEffect = hasEffect
    return ws
  }, [clip, buildVideoTransform, adjustmentSettings, effectsTransform])

  const scaledAdjustmentSettings = useMemo(() => {
    const t = effectsTransform || clip?.transform || {}
    const opacity = typeof t.opacity === 'number' ? t.opacity : 100
    const opacityFactor = Math.max(0, Math.min(1, opacity / 100))
    return scaleAdjustmentSettings(adjustmentSettings, opacityFactor)
  }, [adjustmentSettings, effectsTransform, clip])

  const hasTonalAdjustments = useMemo(
    () => hasTonalAdjustmentEffect(scaledAdjustmentSettings),
    [scaledAdjustmentSettings]
  )
  const adjustmentFilterId = useMemo(
    () => `clip-adjustment-${sanitizeAdjustmentFilterId(clip?.id)}-adjustment`,
    [clip?.id]
  )
  const hasClipPixelEffects = hasPixelFilterEffect(clip?.effects)
  const clipEffectsFilterId = useMemo(
    () => getClipEffectFilterId(clip?.id, 'adjustment'),
    [clip?.id]
  )
  const clipEffectsFilterValue = hasClipPixelEffects ? `url(#${clipEffectsFilterId})` : undefined
  const vignetteEffect = useMemo(
    () => (hasVignetteEffect(clip?.effects) ? getActiveVignetteEffect(clip?.effects, clipTime) : null),
    [clip?.effects, clipTime]
  )
  const vignetteOverlayStyle = useMemo(
    () => (vignetteEffect ? buildVignetteOverlayStyle(vignetteEffect, clipTime) : null),
    [vignetteEffect, clipTime]
  )
  const letterboxEffect = useMemo(
    () => (hasLetterboxEffect(clip?.effects) ? getActiveLetterboxEffect(clip?.effects, clipTime) : null),
    [clip?.effects, clipTime]
  )
  const letterboxOverlayStyles = useMemo(
    () => (letterboxEffect ? buildLetterboxOverlayStyles(letterboxEffect, clipTime) : null),
    [letterboxEffect, clipTime]
  )

  const hasTransform = wrapperStyle.transform || wrapperStyle.clipPath
  const hasAnyClipEffect = hasClipPixelEffects || !!vignetteOverlayStyle || !!letterboxOverlayStyles
  if (!wrapperStyle._hasVisualEffect && !hasTransform && !hasAnyClipEffect) {
    return <>{children}</>
  }

  const style = { ...wrapperStyle }
  delete style._hasVisualEffect

  const combinedFilter = [
    clipEffectsFilterValue,
    hasTonalAdjustments ? `url(#${adjustmentFilterId})` : null,
    style.filter,
  ].filter(Boolean).join(' ') || undefined

  return (
    <>
      {hasTonalAdjustments && (
        <AdjustmentSvgFilter filterId={adjustmentFilterId} settings={scaledAdjustmentSettings} />
      )}
      {hasClipPixelEffects && (
        <ClipEffectSvgFilter
          filterId={clipEffectsFilterId}
          effects={clip?.effects}
          clipTime={clipTime}
        />
      )}
      <div
        style={{
          ...style,
          ...(combinedFilter ? {
            filter: combinedFilter,
            WebkitFilter: combinedFilter,
          } : null),
        }}
      >
        {children}
        {vignetteOverlayStyle && (
          <div aria-hidden style={vignetteOverlayStyle} />
        )}
        {letterboxOverlayStyles && (
          <div aria-hidden style={letterboxOverlayStyles.wrapper}>
            <div style={letterboxOverlayStyles.inner} />
          </div>
        )}
      </div>
    </>
  )
})

/**
 * Main VideoLayerRenderer component
 */
function VideoLayerRenderer({
  buildVideoTransform,
  getClipTransform,
  transitionInfo,
  getTransitionStyles,
  getTransitionOverlay,
  onClipPointerDown,
  onClipDoubleClick,
  previewScale = 1,
}) {
  const containerRef = useRef(null)
  const preloadTimerRef = useRef(null)
  const pauseTimerRef = useRef(null)
  const lastPreloadPosition = useRef(0)
  const lastTopClipRef = useRef(null)
  const lastActiveSetRef = useRef('')

  // Track preloaded clip URL keys per clipId to avoid stale-preload bugs.
  const preloadedClips = useRef(new Map())
  const warmedTransitionClips = useRef(new Set())

  const {
    clips,
    tracks,
    isPlaying,
    playheadPosition,
    playbackRate,
    getActiveClipsAtTime,
    getEnabledEffects,
    setCacheStatus,
    setCacheUrl,
  } = useTimelineStore()

  const getAssetById = useAssetsStore(state => state.getAssetById)
  const currentProjectHandle = useProjectStore(state => state.currentProjectHandle)
  const timelineSettings = useProjectStore(state => state.getCurrentTimelineSettings?.())
  // Subscribe to the proxy-preference toggle so preload/pre-seek effects
  // re-run when the user flips it, which refreshes the video-cache URLs
  // keyed to `resolvePlaybackUrl`. Included in dep arrays below.
  const useProxyPlaybackForAssets = useTimelineStore(state => state.useProxyPlaybackForAssets)

  // Keep videoCache's LRU cap in sync with the timeline's layer count.
  // At the old hardcoded cap (12), a 4-layer timeline would constantly
  // evict recently-preloaded elements to make room for the next preload,
  // causing black frames at cuts whose downstream <video> had already
  // been dropped from the pool. The formula gives each video track a
  // generous slot budget (active clip + ~2s preload window + LRU grace),
  // with a floor of 32 so single-layer timelines also benefit.
  const videoTrackCount = useMemo(
    () => tracks.filter(t => t.type === 'video').length,
    [tracks]
  )
  useEffect(() => {
    const target = Math.max(32, videoTrackCount * 12)
    videoCache.setMaxCacheSize(target)
  }, [videoTrackCount])

  /**
   * Get clips that should be preloaded based on current position
   */
  const getClipsToPreload = useCallback((currentTime) => {
    const isForward = playbackRate >= 0
    const lookaheadEnd = currentTime + (isForward ? PRELOAD_LOOKAHEAD : -PRELOAD_LOOKAHEAD)

    // Find video clips that:
    // 1. Are currently active
    // 2. Will become active within lookahead window
    const videoTracks = tracks.filter(t => t.type === 'video')
    const videoTrackIds = new Set(videoTracks.map(t => t.id))

    const relevantClips = clips.filter(clip => {
      if (!videoTrackIds.has(clip.trackId) || clip.type !== 'video' || clip.enabled === false) return false

      const clipEnd = clip.startTime + clip.duration

      // Currently active
      if (currentTime >= clip.startTime && currentTime < clipEnd) {
        return true
      }

      // Will become active soon (forward)
      if (isForward && clip.startTime > currentTime && clip.startTime <= lookaheadEnd) {
        return true
      }

      // Will become active soon (reverse)
      if (!isForward && clipEnd < currentTime && clipEnd >= lookaheadEnd) {
        return true
      }

      return false
    })

    return relevantClips
  }, [clips, tracks, playbackRate])

  const getTransitionClipsToPreload = useCallback((currentTime) => {
    const state = useTimelineStore.getState()
    const transitionInfo = state.getTransitionAtTime(currentTime)
    const ids = new Set()

    if (transitionInfo && transitionInfo.transition?.kind === 'between') {
      for (const id of getTransitionClipIds(transitionInfo)) {
        ids.add(id)
      }
    }

    const nextTransition = state.transitions
      .filter((transition) => transition?.kind === 'between')
      .map((transition) => {
        const clipA = state.clips.find((clip) => clip.id === transition.clipAId)
        const clipB = state.clips.find((clip) => clip.id === transition.clipBId)
        if (!clipA || !clipB || clipA.trackId !== clipB.trackId) return null
        const split = normalizeTransitionSplit(transition?.settings?.split, transition?.settings?.alignment || 'center')
        const duration = Math.max(0, Number(transition.duration) || 0)
        const editPoint = Number.isFinite(Number(transition.editPoint))
          ? Number(transition.editPoint)
          : (clipA.startTime + clipA.duration)
        const start = editPoint - (duration * split.clipA)
        const end = editPoint + (duration * split.clipB)
        return { transition, clipA, clipB, start, end }
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start)
      .find((entry) => entry.start >= currentTime && entry.start - currentTime <= TRANSITION_PREROLL_LOOKAHEAD)

    if (nextTransition) {
      ids.add(nextTransition.clipA.id)
      ids.add(nextTransition.clipB.id)
    }

    if (ids.size === 0) return []
    return clips.filter((clip) => ids.has(clip.id) && clip.type === 'video' && clip.enabled !== false)
  }, [clips])

  const autoCacheClip = useCallback(async (clip) => {
    if (!clip || clip.type !== 'video') return
    if (clip.cacheStatus === 'cached' || renderCacheService.isRendering(clip.id)) return

    const enabledEffects = getEnabledEffects(clip.id)
    const maskEffects = (enabledEffects || []).filter(e => e.type === 'mask' && e.enabled)
    if (maskEffects.length === 0) return

    const asset = getAssetById(clip.assetId)
    const videoUrl = asset?.url || clip.url
    if (!videoUrl) return

    setCacheStatus(clip.id, 'rendering', 0)

    try {
      const { blobUrl, blob } = await renderCacheService.renderClipWithEffects(
        clip,
        videoUrl,
        enabledEffects,
        getAssetById,
        {
          fps: 30,
          onProgress: (progress) => {
            if (progress.progress !== undefined) {
              setCacheStatus(clip.id, 'rendering', progress.progress)
            }
          }
        }
      )

      let cachePath = null
      if (currentProjectHandle && blob) {
        try {
          cachePath = await saveRenderCache(currentProjectHandle, clip.id, blob, {
            clipId: clip.id,
            duration: clip.duration,
            effects: enabledEffects.map(e => ({ id: e.id, type: e.type })),
          })
        } catch (saveErr) {
          console.warn('Failed to save cache to disk:', saveErr)
        }
      }

      setCacheUrl(clip.id, blobUrl, cachePath)
    } catch (err) {
      console.error('Auto render cache failed:', err)
      setCacheStatus(clip.id, 'none', 0)
    }
  }, [currentProjectHandle, getAssetById, getEnabledEffects, setCacheStatus, setCacheUrl])

  /**
   * Preload upcoming clips
   */
  const preloadUpcoming = useCallback(() => {
    const clipsToPreload = [
      ...getClipsToPreload(playheadPosition, isPlaying),
      ...getTransitionClipsToPreload(playheadPosition),
    ]

    clipsToPreload.forEach(clip => {
      const resolvedUrl = resolvePlaybackUrl(clip, getAssetById)
      if (!resolvedUrl) {
        logPlaybackDiag('preload:skip-no-url', {
          clipId: clip.id,
          playhead: Number(playheadPosition.toFixed(3)),
        })
        return
      }
      const preloadKey = `${clip.id}|${resolvedUrl}`
      if (preloadedClips.current.get(clip.id) === preloadKey) return
      logPlaybackDiag('preload:request', {
        clipId: clip.id,
        playhead: Number(playheadPosition.toFixed(3)),
        url: shortPlaybackUrl(resolvedUrl),
      })
      const cachedVideo = videoCache.getVideoElement({ ...clip, url: resolvedUrl }, true)
      const clipStart = Number(clip.startTime) || 0
      const clipEnd = clipStart + (Number(clip.duration) || 0)
      const isCurrentlyActive = playheadPosition >= clipStart && playheadPosition < clipEnd
      const transitionInfo = useTimelineStore.getState().getTransitionAtTime(playheadPosition)
      const isTransitionIncomingClip = Boolean(
        transitionInfo?.transition?.kind === 'between' &&
        transitionInfo?.clipB?.id === clip.id
      )
      if (cachedVideo && cachedVideo.readyState >= 1 && (!isPlaying || !isCurrentlyActive || isTransitionIncomingClip)) {
        const targetTimelineTime = playheadPosition >= clipStart && playheadPosition < clipEnd
          ? playheadPosition
          : playbackRate >= 0 ? clipStart : clipEnd
        const targetTime = getClipPlaybackTimeAtTimeline(clip, targetTimelineTime)
        const prerollTargetTime = isTransitionIncomingClip
          ? Math.max(0, targetTime - 0.04)
          : targetTime
        if (Math.abs((cachedVideo.currentTime || 0) - prerollTargetTime) > 0.03) {
          cachedVideo.currentTime = prerollTargetTime
        }
        scheduleCutFrameCapture(clip, resolvedUrl, cachedVideo, targetTime)
        if (isPlaying && isTransitionIncomingClip && !isCurrentlyActive && cachedVideo.readyState >= 2) {
          const warmKey = `${clip.id}|${resolvedUrl}`
          if (!warmedTransitionClips.current.has(warmKey)) {
            warmedTransitionClips.current.add(warmKey)
            const warmFrame = () => {
              if (!cachedVideo.paused) return
              const playPromise = cachedVideo.play()
              if (playPromise && typeof playPromise.then === 'function') {
                playPromise
                  .then(() => {
                    if (typeof cachedVideo.requestVideoFrameCallback === 'function') {
                      cachedVideo.requestVideoFrameCallback(() => {
                        cachedVideo.pause()
                      })
                    } else {
                      setTimeout(() => cachedVideo.pause(), 24)
                    }
                  })
                  .catch(() => {})
              }
            }
            warmFrame()
          }
        }
      }
      preloadedClips.current.set(clip.id, preloadKey)
    })

    lastPreloadPosition.current = playheadPosition
  }, [playheadPosition, playbackRate, isPlaying, getClipsToPreload, getTransitionClipsToPreload, getAssetById, useProxyPlaybackForAssets])

  // Auto-render cache for clips with mask effects (smooth playback)
  useEffect(() => {
    const candidates = getClipsToPreload(playheadPosition)
    candidates.forEach(clip => {
      void autoCacheClip(clip)
    })
  }, [playheadPosition, getClipsToPreload, autoCacheClip])

  // Derive active layer clips synchronously to avoid one-frame stale ghosts/flicker.
  const activeLayerClips = useMemo(() => {
    const allActiveClips = getActiveClipsAtTime(playheadPosition)
    const videoClips = allActiveClips.filter(({ track }) => track.type === 'video')

    // Sort by track index (higher index = lower in stack, first rendered)
    // Video 1 on top of Video 2
    const sortedClips = [...videoClips].sort((a, b) => {
      const indexA = tracks.findIndex(t => t.id === a.track.id)
      const indexB = tracks.findIndex(t => t.id === b.track.id)
      return indexB - indexA
    })
    return sortedClips
  }, [playheadPosition, getActiveClipsAtTime, tracks, clips])

  // Playback diagnostics: track active clip-set and top-clip swaps at cuts.
  useEffect(() => {
    if (!isPlaybackDiagEnabled()) return
    const activeIds = activeLayerClips.map(({ clip }) => clip.id)
    const activeSetKey = activeIds.join(',')
    const topClipId = activeIds[0] || null
    if (activeSetKey !== lastActiveSetRef.current) {
      logPlaybackDiag('cut:active-set-change', {
        playhead: Number(playheadPosition.toFixed(3)),
        activeClipIds: activeIds,
      })
      lastActiveSetRef.current = activeSetKey
    }
    if (topClipId !== lastTopClipRef.current) {
      logPlaybackDiag('cut:top-clip-change', {
        playhead: Number(playheadPosition.toFixed(3)),
        fromClipId: lastTopClipRef.current,
        toClipId: topClipId,
        transitionType: transitionInfo?.transition?.type || null,
        transitionProgress: transitionInfo ? Number(transitionInfo.progress.toFixed(3)) : null,
      })
      lastTopClipRef.current = topClipId
    }
  }, [activeLayerClips, playheadPosition, transitionInfo])

  // Preload on position change (throttled)
  useEffect(() => {
    // Preload when position changes by more than 0.3 seconds
    if (Math.abs(playheadPosition - lastPreloadPosition.current) > 0.3) {
      preloadUpcoming()
    }
  }, [playheadPosition, preloadUpcoming])

  // Set up preload interval during playback
  useEffect(() => {
    if (isPlaying) {
      if (pauseTimerRef.current) {
        clearTimeout(pauseTimerRef.current)
        pauseTimerRef.current = null
      }
      // Preload frequently during playback
      preloadTimerRef.current = setInterval(() => {
        preloadUpcoming()
      }, 250)

      // Initial preload
      preloadUpcoming()
    } else {
      if (preloadTimerRef.current) {
        clearInterval(preloadTimerRef.current)
        preloadTimerRef.current = null
      }
      // Pause all cached videos when timeline stops
      // But first ensure current active clips are properly positioned to avoid black frames
      const allActiveClips = getActiveClipsAtTime(playheadPosition)
      const videoClips = allActiveClips.filter(({ track }) => track.type === 'video')

      // Pre-seek all active videos before pausing to prevent black frames
      videoClips.forEach(({ clip }) => {
        const resolvedUrl = resolvePlaybackUrl(clip, getAssetById)
        if (!resolvedUrl) return
        const clipWithUrl = { ...clip, url: resolvedUrl }
        const cachedVideo = videoCache.getVideoElement(clipWithUrl)
        if (cachedVideo && cachedVideo.readyState >= 1) {
          const baseScale = clip.sourceTimeScale || (clip.timelineFps && clip.sourceFps
            ? clip.timelineFps / clip.sourceFps
            : 1)
          const speed = Number(clip.speed)
          const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
          const timeScale = baseScale * speedScale
          const reverse = !!clip.reverse
          const trimStart = clip.trimStart || 0
          const rawTrimEnd = clip.trimEnd ?? clip.sourceDuration ?? (trimStart + (clip.duration || 0) * timeScale)
          const trimEnd = Number.isFinite(rawTrimEnd) ? rawTrimEnd : trimStart
          const minTime = Math.min(trimStart, trimEnd)
          const maxTime = Math.max(trimStart, trimEnd)
          const sourceTime = reverse
            ? trimEnd - (playheadPosition - clip.startTime) * timeScale
            : trimStart + (playheadPosition - clip.startTime) * timeScale
          const clampedTime = Math.max(minTime, Math.min(sourceTime, maxTime - 0.01))
          cachedVideo.currentTime = clampedTime
        }
      })

      // Small delay before pausing to ensure seeks complete
      pauseTimerRef.current = setTimeout(() => {
        videoCache.pauseAll()
        pauseTimerRef.current = null
      }, 10)
    }

    return () => {
      if (preloadTimerRef.current) {
        clearInterval(preloadTimerRef.current)
      }
      if (pauseTimerRef.current) {
        clearTimeout(pauseTimerRef.current)
        pauseTimerRef.current = null
      }
    }
  }, [isPlaying, preloadUpcoming, getActiveClipsAtTime, playheadPosition, getAssetById])

  // Clean up preloaded set periodically to allow re-preloading
  useEffect(() => {
    const cleanup = setInterval(() => {
      // Keep only clips that are within a larger window
      const keepWindow = PRELOAD_LOOKAHEAD * 3
      preloadedClips.current = new Map(
        [...preloadedClips.current.entries()].filter(([clipId]) => {
          const clip = clips.find(c => c.id === clipId)
          if (!clip) return false
          const clipEnd = clip.startTime + clip.duration
          return (
            Math.abs(clip.startTime - playheadPosition) < keepWindow ||
            Math.abs(clipEnd - playheadPosition) < keepWindow
          )
        })
      )
      const validWarmKeys = new Set(
        [...preloadedClips.current.values()]
      )
      warmedTransitionClips.current = new Set(
        [...warmedTransitionClips.current].filter((key) => validWarmKeys.has(key))
      )
    }, 5000)

    return () => clearInterval(cleanup)
  }, [clips, playheadPosition])

  // Combined video and image layers (both render in the same z-order space)
  const allMediaClips = activeLayerClips.filter(({ clip }) => clip.type === 'video' || clip.type === 'image')

  const transitionReady = useMemo(() => {
    if (!transitionInfo) return false
    if (transitionInfo.transition?.kind !== 'between') return true
    const clipAId = transitionInfo.clipA?.id
    const clipBId = transitionInfo.clipB?.id
    if (!clipAId || !clipBId) return false
    return videoCache.isReady(clipAId) && videoCache.isReady(clipBId)
  }, [transitionInfo, playheadPosition])

  const getTransitionStyleForClip = (clip) => {
    if (!transitionInfo || !clip) return null
    if (typeof getTransitionStyles !== 'function') return null

    if (transitionInfo.transition?.kind === 'edge') {
      if (transitionInfo.clip?.id !== clip.id) return null
      const isOutgoing = transitionInfo.edge === 'out'
      return getTransitionStyles(transitionInfo, isOutgoing)
    }

    // For between-clip transitions, defer transition activation entirely
    // until both clips have decoded enough to render cleanly.
    if (!transitionReady) return null

    if (transitionInfo.clipA?.id === clip.id) {
      return getTransitionStyles(transitionInfo, true)
    }

    if (transitionInfo.clipB?.id === clip.id) {
      return getTransitionStyles(transitionInfo, false)
    }

    return null
  }

  // Precompute transition styles so culling and rendering share the same transition membership.
  const transitionStyleByClipId = useMemo(() => {
    const styleMap = new Map()
    for (const { clip } of allMediaClips) {
      const style = getTransitionStyleForClip(clip)
      if (style) {
        styleMap.set(clip.id, style)
      }
    }
    return styleMap
  }, [allMediaClips, transitionInfo, getTransitionStyles])

  // Per-clip lower-layer compositing. Active clips are ordered bottom -> top,
  // so the shared culler scans from the top and drops anything underneath a
  // clip that either fully covers the frame in Auto mode or has compositing
  // forced Off in the Inspector.
  const transitionClipIds = useMemo(
    () => new Set(transitionStyleByClipId.keys()),
    [transitionStyleByClipId]
  )
  const compositedVisualClips = useMemo(() => cullVisualLayerEntries(activeLayerClips, {
    time: playheadPosition,
    getAssetById,
    transitionClipIds,
    timelineWidth: timelineSettings?.width || 1920,
    timelineHeight: timelineSettings?.height || 1080,
  }), [
    activeLayerClips,
    getAssetById,
    playheadPosition,
    timelineSettings?.height,
    timelineSettings?.width,
    transitionClipIds,
  ])

  // Push adjustment-layer GLSL effects down onto each underlying media clip
  // for the preview pipeline. The export path runs these on the composited
  // canvas via `applyClipManagedEffectsToOffCanvas`, but the live preview
  // composes layers via CSS, so there is no canvas to sample. As a
  // pragmatic preview, we snapshot each adjustment's GLSL settings at the
  // current playhead and append them to the effects list of every video/
  // image clip beneath that adjustment. This is preview-only — it never
  // mutates timeline state — so adjustments remain a single source of truth.
  // For single-layer scenes the result matches export; multi-layer scenes
  // get a per-layer approximation rather than a true post-composite pass.
  const previewVisualClips = useMemo(() => {
    if (!Array.isArray(compositedVisualClips) || compositedVisualClips.length === 0) {
      return compositedVisualClips
    }
    const list = compositedVisualClips
    // compositedVisualClips is ordered bottom -> top, so adjustments
    // affecting a media clip appear AFTER it in the array. Walk top-to-
    // bottom and accumulate snapshots; flush onto media clips as we go.
    const accumulatedOverlays = []
    const overlaysByIndex = new Array(list.length)
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const { clip } = list[i]
      if (!clip) continue
      if (clip.type === 'adjustment') {
        if (hasGlslEffect(clip.effects)) {
          const adjClipTime = playheadPosition - (clip.startTime || 0)
          const snaps = snapshotAdjustmentGlslEffectsForOverlay(clip.effects, adjClipTime)
          if (snaps.length > 0) accumulatedOverlays.push(...snaps)
        }
      } else if (clip.type === 'video' || clip.type === 'image') {
        if (accumulatedOverlays.length > 0) {
          overlaysByIndex[i] = accumulatedOverlays.slice()
        }
      }
    }
    if (overlaysByIndex.every((entry) => !entry)) return list
    return list.map((entry, index) => {
      const overlays = overlaysByIndex[index]
      if (!overlays || overlays.length === 0) return entry
      const baseEffects = Array.isArray(entry.clip.effects) ? entry.clip.effects : []
      return {
        ...entry,
        clip: {
          ...entry.clip,
          effects: [...baseEffects, ...overlays],
        },
      }
    })
  }, [compositedVisualClips, playheadPosition])

  // Build the layer tree. Adjustment layers wrap all content below them so
  // that CSS filter + transform apply to the composited result.
  const layerElements = useMemo(() => {
    let accumulated = []

    const renderClip = (clip, track, visualIndex) => {
      if (clip.type === 'text') {
        return (
          <TextLayer
            key={`text-${track.id}-${clip.id}`}
            clip={clip}
            track={track}
            layerIndex={visualIndex}
            totalLayers={compositedVisualClips.length}
            playheadPosition={playheadPosition}
            buildVideoTransform={buildVideoTransform}
            getClipTransform={getClipTransform}
            onClipPointerDown={onClipPointerDown}
            onClipDoubleClick={onClipDoubleClick}
            previewScale={previewScale}
          />
        )
      }
      if (clip.type === 'image') {
        return (
          <ImageLayer
            key={`img-${track.id}-${clip.id}`}
            clip={clip}
            track={track}
            layerIndex={visualIndex}
            totalLayers={compositedVisualClips.length}
            playheadPosition={playheadPosition}
            buildVideoTransform={(transform) => {
              const transitionStyle = transitionStyleByClipId.get(clip.id) || null
              return transitionStyle
                ? { ...buildVideoTransform(transform), ...transitionStyle }
                : buildVideoTransform(transform)
            }}
            getClipTransform={getClipTransform}
            onClipPointerDown={onClipPointerDown}
          />
        )
      }
      return (
        <VideoLayer
          key={`vid-${track.id}-${clip.id}`}
          clip={clip}
          track={track}
          layerIndex={visualIndex}
          totalLayers={compositedVisualClips.length}
          playheadPosition={playheadPosition}
          isPlaying={isPlaying}
          isInTransition={transitionStyleByClipId.has(clip.id)}
          buildVideoTransform={(transform) => {
            const transitionStyle = transitionStyleByClipId.get(clip.id) || null
            return transitionStyle
              ? { ...buildVideoTransform(transform), ...transitionStyle }
              : buildVideoTransform(transform)
          }}
          getClipTransform={getClipTransform}
          onClipPointerDown={onClipPointerDown}
        />
      )
    }

    previewVisualClips.forEach(({ clip, track }, visualIndex) => {
      if (clip.type === 'adjustment') {
        accumulated = [
          <AdjustmentWrapper
            key={`adj-${track.id}-${clip.id}`}
            clip={clip}
            playheadPosition={playheadPosition}
            buildVideoTransform={buildVideoTransform}
          >
            {accumulated}
          </AdjustmentWrapper>
        ]
      } else {
        accumulated.push(renderClip(clip, track, visualIndex))
      }
    })

    return accumulated
  }, [previewVisualClips, playheadPosition, isPlaying, buildVideoTransform, getClipTransform, onClipPointerDown, onClipDoubleClick, previewScale, transitionStyleByClipId])

  // Render multi-layer composition (including transitions)
  return (
    <div ref={containerRef} className="relative w-full h-full">
      {activeLayerClips.length === 0 && !transitionInfo
        ? <div className="absolute inset-0 bg-black" />
        : layerElements}
      {/* Transition overlay (for fade effects) */}
      {transitionInfo && transitionReady ? getTransitionOverlay(transitionInfo) : null}
    </div>
  )
}

/**
 * Clear a clip's entry from the disk cache URL map
 * Call this when clearing a clip's render cache
 */
export function clearDiskCacheUrl(clipId) {
  const url = diskCacheUrls.get(clipId)
  if (url) {
    URL.revokeObjectURL(url)
    diskCacheUrls.delete(clipId)
  }
}

export default memo(VideoLayerRenderer)
