import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import videoCache from '../services/videoCache'
import { hasUsablePlaybackCache } from '../services/playbackCache'
import { getAnimatedAdjustmentSettings, getAnimatedTransform, getAnimatedShapeProperties } from '../utils/keyframes'
import {
  applyAdjustmentSettingsToImageData,
  buildCssFilterFromAdjustments,
  hasAdjustmentEffect,
  hasTonalAdjustmentEffect,
  normalizeAdjustmentSettings,
} from '../utils/adjustments'
import { applyAdjustmentSettingsToCanvasGpu } from '../utils/adjustmentsGpu'
import {
  applyBlurPassesToCanvas,
  applyEffectsToTransform,
  applyGlowPassesToCanvas,
  applyPixelEffectsToImageData,
  drawLetterboxOverlay,
  drawVignetteOverlay,
  getActiveLetterboxEffect,
  getActiveVignetteEffect,
  hasGlowEffect,
  hasLetterboxEffect,
  hasPixelFilterEffect,
  hasVignetteEffect,
} from '../utils/effects'
import { applyGlslEffectsToCanvas, canUseGlslEffects, getGlslPreviewQualityScale, hasGlslEffect } from '../utils/glslEffects'
import { cullVisualLayerEntries, getTransitionClipIds } from '../utils/layerCompositing'
import { applyTransitionClip, getFadeOverlayInfo, getTransitionStyleForClip } from '../utils/transitionStyles'
import { isFullBakeFresh } from '../utils/clipBakeSignature'
import { getMotionBlurSamples, getVelocityMotionBlurOptions } from '../utils/motionBlur'
import { applyVelocityMotionBlurToCanvas, canUseVelocityMotionBlur } from '../utils/velocityMotionBlur'
import {
  applyClipCrop,
  applyClipTransform,
  drawPerspectiveClipSource,
  drawText,
  getBaseDrawRect,
  hasPerspectiveClipTransform,
} from '../services/exporter'
import { drawShape, getShapeCanvasRect } from '../utils/shapes'

const PRELOAD_LOOKAHEAD = 2.5
const PLAYBACK_DIAG_KEY = 'comfystudio-playback-diag'
const SCRUB_ACTIVE_WINDOW_MS = 220
const SCRUB_SETTLE_DELAY_MS = SCRUB_ACTIVE_WINDOW_MS + 45
const SCRUB_READY_TOLERANCE = 0.18
// If a scrub seek never presents a frame (element evicted, src cleared),
// allow a replacement seek after this long instead of blocking the element.
const SCRUB_SEEK_STALL_MS = 400
// How long playback may hold the previous frame while a visible clip's
// media is not yet drawable (cold element at a cut, mid-seek decoder dip)
// before black is allowed through.
const PLAYBACK_UNREADY_HOLD_MS = 400

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

function getNowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function isPlaybackDiagEnabled() {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(PLAYBACK_DIAG_KEY) === '1'
}

function logCanvasDiag(event, payload = {}) {
  if (!isPlaybackDiagEnabled()) return
  const nowSeconds = typeof performance !== 'undefined'
    ? Number((performance.now() / 1000).toFixed(3))
    : null
  console.log(`[CanvasPreview] ${event}`, { t: nowSeconds, ...payload })
}

function getClipPlaybackTimingAtTimeline(clip, timelineTime, endOffset = 0.01, options = {}) {
  if (!clip) return { time: 0, rawTime: 0, clamped: false, minTime: 0, maxTime: 0 }
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
  const sourceDuration = Number(clip.sourceDuration)
  const allowHandles = !!options.allowHandles && Number.isFinite(sourceDuration) && sourceDuration > 0
  const minTime = allowHandles ? 0 : Math.min(trimStart, trimEnd)
  const maxTime = allowHandles ? sourceDuration : Math.max(trimStart, trimEnd)
  const sourceTime = reverse
    ? trimEnd - (timelineTime - (clip.startTime || 0)) * timeScale
    : trimStart + (timelineTime - (clip.startTime || 0)) * timeScale
  const safeMaxTime = Math.max(minTime, maxTime - endOffset)
  const clampedTime = Math.max(minTime, Math.min(sourceTime, safeMaxTime))
  return {
    time: clampedTime,
    rawTime: sourceTime,
    clamped: Math.abs(clampedTime - sourceTime) > 0.001,
    minTime,
    maxTime,
  }
}

function getClipPlaybackTimeAtTimeline(clip, timelineTime, endOffset = 0.01, options = {}) {
  return getClipPlaybackTimingAtTimeline(clip, timelineTime, endOffset, options).time
}

function resolvePreviewUrl(clip, getAssetById, useProxyPlaybackForAssets) {
  if (!clip) return null
  // Render caches: legacy (mask) bakes apply to video clips; full bakes
  // (cacheKind 'full') turn any clip type into a video source but are only
  // used while their content signature is fresh.
  if (clip.cacheStatus === 'cached' && clip.cacheUrl) {
    if (clip.cacheKind === 'full') {
      if (isFullBakeFresh(clip)) return clip.cacheUrl
    } else if (clip.type === 'video') {
      return clip.cacheUrl
    }
  }
  const asset = clip.assetId ? getAssetById(clip.assetId) : null
  if (clip.type === 'video') {
    const useProxy = useProxyPlaybackForAssets && !!asset?.proxyUrl && asset?.proxyStatus !== 'failed'
    if (useProxy) return asset.proxyUrl
    const usePlaybackCache = !!asset?.playbackCacheUrl && hasUsablePlaybackCache(asset)
    return (usePlaybackCache ? asset?.playbackCacheUrl : null) || asset?.url || clip.url || null
  }
  return asset?.url || clip.url || null
}

// Transition style math lives in ../utils/transitionStyles — shared with the
// exporter so preview and export can never drift.

function hasManagedCanvasEffect(clip, clipTime) {
  if (!clip) return false
  const effects = clip.effects || []
  return hasPixelFilterEffect(effects, clipTime)
    || hasGlslEffect(effects)
    || hasVignetteEffect(effects, clipTime)
    || hasLetterboxEffect(effects, clipTime)
}

function applyManagedCanvasEffects(canvas, ctx, width, height, clip, clipTime, frameIndex, glslQualityScale = 1) {
  if (!clip) return
  const effects = clip.effects || []
  const hasImageDataEffects = effects.some((e) => (
    e
    && e.enabled !== false
    && (
      e.type === 'chromaticAberration'
      || e.type === 'sharpen'
      || e.type === 'filmGrain'
      || e.type === 'vhsDamage'
    )
  ))
  if (hasImageDataEffects) {
    const imageData = ctx.getImageData(0, 0, width, height)
    applyPixelEffectsToImageData(imageData, effects, clipTime, frameIndex)
    ctx.putImageData(imageData, 0, 0)
  }
  if (hasGlowEffect(effects)) {
    applyGlowPassesToCanvas(canvas, ctx, width, height, effects, clipTime)
  }
  applyBlurPassesToCanvas(canvas, ctx, width, height, effects, clipTime)
  if (canUseGlslEffects() && hasGlslEffect(effects)) {
    applyGlslEffectsToCanvas(canvas, ctx, width, height, effects, clipTime, glslQualityScale)
  }
  const vignetteEffect = getActiveVignetteEffect(effects, clipTime)
  if (vignetteEffect) {
    drawVignetteOverlay(ctx, width, height, vignetteEffect, clipTime, {
      compositeOperation: 'source-atop',
    })
  }
  const letterboxEffect = getActiveLetterboxEffect(effects, clipTime)
  if (letterboxEffect) {
    drawLetterboxOverlay(ctx, width, height, letterboxEffect, clipTime, {
      compositeOperation: 'source-atop',
    })
  }
}

function ensureCanvasSize(canvas, width, height) {
  if (!canvas) return
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
}

function getVisualLayerClips(state, time) {
  const activeClips = state.getActiveClipsAtTime(time)
  return activeClips
    .filter(({ track }) => track.type === 'video')
    .sort((a, b) => {
      const indexA = state.tracks.findIndex(t => t.id === a.track.id)
      const indexB = state.tracks.findIndex(t => t.id === b.track.id)
      return indexB - indexA
    })
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value)
    if (Number.isFinite(number) && number > 0) return number
  }
  return null
}

function getAssetMediaDimensions(asset) {
  return {
    width: firstPositiveNumber(asset?.settings?.width, asset?.width, asset?.metadata?.width, asset?.mediaInfo?.width),
    height: firstPositiveNumber(asset?.settings?.height, asset?.height, asset?.metadata?.height, asset?.mediaInfo?.height),
  }
}

function getClipHitSourceDimensions({ clip, clipTime = 0, state, getAssetById, imageCacheRef, canvasWidth, canvasHeight }) {
  if (clip?.type === 'text') {
    return { width: canvasWidth, height: canvasHeight }
  }
  if (clip?.type === 'shape') {
    const shapeProperties = getAnimatedShapeProperties(clip, clipTime) || clip.shapeProperties
    const rect = getShapeCanvasRect(shapeProperties, canvasWidth, canvasHeight)
    return { width: rect.width, height: rect.height }
  }

  const asset = clip?.assetId ? getAssetById(clip.assetId) : null
  if (clip?.type === 'image') {
    const clipUrl = resolvePreviewUrl(clip, getAssetById, state.useProxyPlaybackForAssets)
    const cachedImage = clipUrl ? imageCacheRef.current.get(clipUrl) : null
    const loadedImage = cachedImage?.loaded ? cachedImage.image : null
    return {
      width: firstPositiveNumber(loadedImage?.naturalWidth, loadedImage?.width, asset?.settings?.width, asset?.width),
      height: firstPositiveNumber(loadedImage?.naturalHeight, loadedImage?.height, asset?.settings?.height, asset?.height),
    }
  }

  if (clip?.type === 'video') {
    const dimensions = getAssetMediaDimensions(asset)
    return {
      width: firstPositiveNumber(dimensions.width, clip?.sourceWidth, clip?.width),
      height: firstPositiveNumber(dimensions.height, clip?.sourceHeight, clip?.height),
    }
  }

  return { width: null, height: null }
}

function getVisibleHitRect(rect, transform = {}, transitionStyle = null) {
  const cropTop = clamp(Number(transform?.cropTop) || 0, 0, 100)
  const cropBottom = clamp(Number(transform?.cropBottom) || 0, 0, 100)
  const cropLeft = clamp(Number(transform?.cropLeft) || 0, 0, 100)
  const cropRight = clamp(Number(transform?.cropRight) || 0, 0, 100)
  let left = rect.width * (cropLeft / 100)
  let right = rect.width - rect.width * (cropRight / 100)
  let top = rect.height * (cropTop / 100)
  let bottom = rect.height - rect.height * (cropBottom / 100)

  if (transitionStyle?.clipInset) {
    const inset = transitionStyle.clipInset
    left = Math.max(left, rect.width * (Number(inset.left) || 0))
    right = Math.min(right, rect.width - rect.width * (Number(inset.right) || 0))
    top = Math.max(top, rect.height * (Number(inset.top) || 0))
    bottom = Math.min(bottom, rect.height - rect.height * (Number(inset.bottom) || 0))
  }

  return {
    left: clamp(left, 0, rect.width),
    right: clamp(right, 0, rect.width),
    top: clamp(top, 0, rect.height),
    bottom: clamp(bottom, 0, rect.height),
  }
}

function clipContainsCanvasPoint(point, clip, rect, transform = {}, transitionStyle = null) {
  if (!point || !clip || !rect) return false
  if (transitionStyle?.display === false) return false

  const opacity = ((transitionStyle?.opacity ?? 1) * ((Number(transform?.opacity) || 100) / 100))
  if (opacity <= 0.001) return false

  const anchorX = Number.isFinite(Number(transform?.anchorX)) ? Number(transform.anchorX) : 50
  const anchorY = Number.isFinite(Number(transform?.anchorY)) ? Number(transform.anchorY) : 50
  const anchorPxX = rect.width * (anchorX / 100)
  const anchorPxY = rect.height * (anchorY / 100)
  const transitionScale = Number(transitionStyle?.scale) || 1
  const scaleX = ((Number(transform?.scaleX) || 100) / 100) * (transform?.flipH ? -1 : 1) * transitionScale
  const scaleY = ((Number(transform?.scaleY) || 100) / 100) * (transform?.flipV ? -1 : 1) * transitionScale
  if (Math.abs(scaleX) < 0.0001 || Math.abs(scaleY) < 0.0001) return false

  const centerX = rect.x + anchorPxX + (Number(transform?.positionX) || 0) + (transitionStyle?.translateX || 0) * rect.width
  const centerY = rect.y + anchorPxY + (Number(transform?.positionY) || 0) + (transitionStyle?.translateY || 0) * rect.height
  const rotation = ((Number(transform?.rotation) || 0) * Math.PI) / 180
  const cos = Math.cos(-rotation)
  const sin = Math.sin(-rotation)
  const dx = point.x - centerX
  const dy = point.y - centerY
  const rotatedX = dx * cos - dy * sin
  const rotatedY = dx * sin + dy * cos
  const localX = rotatedX / scaleX + anchorPxX
  const localY = rotatedY / scaleY + anchorPxY
  const visible = getVisibleHitRect(rect, transform, transitionStyle)

  return (
    localX >= visible.left
    && localX <= visible.right
    && localY >= visible.top
    && localY <= visible.bottom
  )
}

function getMaskInfo(clip, getAssetById, time, isCachedRender = false) {
  if (isCachedRender || !clip?.effects) return null
  const effect = clip.effects.find((entry) => entry?.type === 'mask' && entry.enabled)
  if (!effect) return null
  const maskAsset = getAssetById(effect.maskAssetId)
  if (!maskAsset) return null
  const sourceAsset = maskAsset.sourceAssetId ? getAssetById(maskAsset.sourceAssetId) : null
  const maskFrameCount = maskAsset.frameCount || maskAsset.maskFrames?.length || 1
  const sourceDuration = clip.sourceDuration
    || sourceAsset?.duration
    || sourceAsset?.settings?.duration
    || maskAsset?.settings?.duration
    || clip.duration
  let frameIndex = 0
  let url = maskAsset.url
  if (Array.isArray(maskAsset.maskFrames) && maskAsset.maskFrames.length > 1) {
    const sourceTime = getClipPlaybackTimeAtTimeline(clip, time, 0.001)
    const sourceProgress = sourceDuration > 0 ? clamp(sourceTime / sourceDuration, 0, 1) : 0
    frameIndex = Math.min(Math.max(0, Math.floor(sourceProgress * maskFrameCount)), maskFrameCount - 1)
    url = maskAsset.maskFrames[frameIndex]?.url || url
  }
  if (!url) return null
  return {
    url,
    invertMask: !!effect.invertMask,
  }
}

function isSeekDrivenPlayback(state, clip) {
  if (!state?.isPlaying || !clip) return false
  const timelineRate = Number(state.playbackRate)
  // Chromium can present native 1x/2x playback cleanly enough for canvas
  // sampling. At 4x/8x it often starves the hidden video element and exposes
  // black decoder frames, so shuttle speeds become seek-driven and the canvas
  // holds the last good frame until a new target frame is drawable.
  return timelineRate < 0 || Math.abs(timelineRate) >= 3.5 || !!clip.reverse
}

function CanvasPreviewRenderer({
  timelineWidth = 1920,
  timelineHeight = 1080,
  timelineFps = 30,
  onClipPointerDown,
  onClipDoubleClick,
}) {
  const canvasRef = useRef(null)
  const imageCacheRef = useRef(new Map())
  const maskCacheRef = useRef(new Map())
  const buffersRef = useRef({})
  const lastFrameCanvasRef = useRef(null)
  const latestRef = useRef({})
  const drawFrameRef = useRef(null)
  const deferredDrawTimerRef = useRef(0)
  const deferredDrawRafRef = useRef(0)
  const scrubSettleTimerRef = useRef(0)
  const scrubPreviewStateRef = useRef({ lastPlayhead: 0, activeUntil: 0 })
  const scrubPendingSeeksRef = useRef(new WeakMap())
  const unreadyHoldUntilRef = useRef(0)
  const hasPaintedFrameRef = useRef(false)
  const lastPreloadTimeRef = useRef(0)
  const lastDrawTimeRef = useRef(null)
  const loopSeekHoldUntilRef = useRef(0)
  const [, setAssetRevision] = useState(0)

  const {
    clips,
    tracks,
    transitions,
    isPlaying,
    playheadPosition,
    playbackRate,
    useProxyPlaybackForAssets,
    glslPreviewQuality,
  } = useTimelineStore()
  const assets = useAssetsStore(state => state.assets)

  const safeWidth = Math.max(1, Math.round(Number(timelineWidth) || 1920))
  const safeHeight = Math.max(1, Math.round(Number(timelineHeight) || 1080))
  const safeFps = Math.max(1, Number(timelineFps) || 30)

  const bumpAssetRevision = useCallback(() => {
    setAssetRevision((value) => (value + 1) % 100000)
  }, [])

  const getImageForUrl = useCallback((url) => {
    if (!url) return null
    const cache = imageCacheRef.current
    const existing = cache.get(url)
    if (existing) return existing.loaded ? existing.image : null

    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.decoding = 'async'
    const entry = { image, loaded: false, failed: false }
    cache.set(url, entry)
    image.onload = () => {
      entry.loaded = true
      bumpAssetRevision()
    }
    image.onerror = () => {
      entry.failed = true
      bumpAssetRevision()
    }
    image.src = url
    return null
  }, [bumpAssetRevision])

  const getProcessedMaskForUrl = useCallback((url) => {
    if (!url) return null
    const cache = maskCacheRef.current
    const existing = cache.get(url)
    if (existing) return existing.loaded ? existing.canvas : null

    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.decoding = 'async'
    const entry = { canvas: null, loaded: false, failed: false }
    cache.set(url, entry)
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth || 1
        canvas.height = image.naturalHeight || 1
        const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true })
        ctx.drawImage(image, 0, 0)
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const pixels = data.data
        for (let i = 0; i < pixels.length; i += 4) {
          const luminance = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3
          pixels[i] = 255
          pixels[i + 1] = 255
          pixels[i + 2] = 255
          pixels[i + 3] = luminance
        }
        ctx.putImageData(data, 0, 0)
        entry.canvas = canvas
        entry.loaded = true
      } catch (error) {
        console.warn('[CanvasPreview] failed to process mask frame', error)
        entry.failed = true
      }
      bumpAssetRevision()
    }
    image.onerror = () => {
      entry.failed = true
      bumpAssetRevision()
    }
    image.src = url
    return null
  }, [bumpAssetRevision])

  latestRef.current = {
    clips,
    tracks,
    transitions,
    isPlaying,
    playheadPosition,
    playbackRate,
    useProxyPlaybackForAssets,
    glslPreviewQuality,
    width: safeWidth,
    height: safeHeight,
    fps: safeFps,
  }

  const scheduleDeferredDraw = useCallback((reason = 'media-ready') => {
    if (deferredDrawTimerRef.current || deferredDrawRafRef.current) return
    logCanvasDiag('schedule-redraw', { reason })
    deferredDrawTimerRef.current = window.setTimeout(() => {
      deferredDrawTimerRef.current = 0
      deferredDrawRafRef.current = requestAnimationFrame(() => {
        deferredDrawRafRef.current = 0
        drawFrameRef.current?.()
      })
    }, 40)
  }, [])

  // Completion-driven scrub seeking: at most one in-flight seek per video
  // element. Assigning currentTime restarts an in-flight seek, so a fixed
  // throttle re-issued per mousemove starves frame presentation whenever
  // per-seek decode latency exceeds the throttle interval — the preview
  // freezes for the whole drag. Waiting for the seek to present, repainting,
  // and letting the next drawFrame retarget tracks the playhead at whatever
  // rate the decoder can actually sustain. 'seeked' fires on demux, not
  // presentation, so prefer requestVideoFrameCallback (same pattern as
  // exporter.js).
  const issueScrubSeek = useCallback((video, targetTime) => {
    const pendingSeeks = scrubPendingSeeksRef.current
    const pending = pendingSeeks.get(video)
    const nowMs = getNowMs()
    if (pending && nowMs - pending.issuedAt < SCRUB_SEEK_STALL_MS) return
    pendingSeeks.set(video, { issuedAt: nowMs })
    const finish = () => {
      pendingSeeks.delete(video)
      drawFrameRef.current?.()
    }
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => finish())
    } else {
      video.addEventListener('seeked', finish, { once: true })
    }
    video.currentTime = targetTime
  }, [])

  const applyAdvancedAdjustmentsToCanvas = useCallback((sourceCanvas, settings, width, height, extraBlurPx = null) => {
    const buffers = buffersRef.current
    if (!buffers.processedCanvas) {
      buffers.processedCanvas = document.createElement('canvas')
      buffers.adjustmentCanvas = document.createElement('canvas')
    }
    ensureCanvasSize(buffers.processedCanvas, width, height)
    ensureCanvasSize(buffers.adjustmentCanvas, width, height)
    const adjustmentCtx = buffers.adjustmentCanvas.getContext('2d')
    const normalizedSettings = normalizeAdjustmentSettings(settings)

    // GPU grade first — the same shader the export compositor uses. The
    // CPU pixel loop below is the no-WebGL2 fallback only; it is far too
    // slow for playback (full-frame getImageData + per-pixel JS per clip
    // per frame). The GPU output canvas is kept separate from
    // processedCanvas so the fallback's willReadFrequently hint never
    // forces the fast path's canvases into CPU backing.
    let gradedCanvas = null
    if (!buffers.gpuGradeCanvas) {
      buffers.gpuGradeCanvas = document.createElement('canvas')
    }
    ensureCanvasSize(buffers.gpuGradeCanvas, width, height)
    const gpuGradeCtx = buffers.gpuGradeCanvas.getContext('2d')
    if (applyAdjustmentSettingsToCanvasGpu(sourceCanvas, gpuGradeCtx, width, height, normalizedSettings)) {
      gradedCanvas = buffers.gpuGradeCanvas
    } else {
      const processedCtx = buffers.processedCanvas.getContext('2d', { willReadFrequently: true })
      processedCtx.clearRect(0, 0, width, height)
      processedCtx.filter = 'none'
      processedCtx.globalAlpha = 1
      processedCtx.globalCompositeOperation = 'source-over'
      processedCtx.drawImage(sourceCanvas, 0, 0)
      const frameData = processedCtx.getImageData(0, 0, width, height)
      applyAdjustmentSettingsToImageData(frameData, normalizedSettings)
      processedCtx.putImageData(frameData, 0, 0)
      gradedCanvas = buffers.processedCanvas
    }

    const totalBlur = Math.max(0, normalizedSettings.blur + (Number(extraBlurPx) || 0))
    if (totalBlur > 0) {
      adjustmentCtx.clearRect(0, 0, width, height)
      adjustmentCtx.save()
      adjustmentCtx.filter = `blur(${totalBlur}px)`
      adjustmentCtx.drawImage(gradedCanvas, 0, 0)
      adjustmentCtx.restore()
      return buffers.adjustmentCanvas
    }

    return gradedCanvas
  }, [])

  const drawVisualClip = useCallback((ctx, entry, time, transitionInfo, state, frameIndex) => {
    const { clip } = entry
    const width = state.width
    const height = state.height
    const getAssetById = useAssetsStore.getState().getAssetById
    const clipTime = time - (clip.startTime || 0)
    // Full render bakes carry transform/effects/adjustments/masks/speed and
    // text animation inside the baked file; only opacity + blend mode (and
    // transitions) stay live. Stale bakes (content edited since render)
    // automatically fall back to the live path.
    const isFullBake = isFullBakeFresh(clip)
    const transitionStyle = getTransitionStyleForClip(transitionInfo, clip)
    const resolveClipTransformAtTime = (sampleClipTime) => (
      applyEffectsToTransform(getAnimatedTransform(clip, sampleClipTime) || clip.transform || {}, clip.effects, sampleClipTime)
    )
    const liveClipTransform = resolveClipTransformAtTime(clipTime)
    const clipTransform = isFullBake
      ? { opacity: liveClipTransform.opacity, blendMode: liveClipTransform.blendMode }
      : liveClipTransform
    const baseOpacity = typeof clipTransform.opacity === 'number' ? clipTransform.opacity / 100 : 1
    const clipOpacity = (transitionStyle?.opacity ?? 1) * baseOpacity
    if (clipOpacity <= 0.001 || transitionStyle?.display === false) return

    const blendMode = clipTransform?.blendMode || 'normal'
    const blurPx = transitionStyle?.blur ?? (clipTransform?.blur > 0 ? clipTransform.blur : null)
    const adjustmentSettings = normalizeAdjustmentSettings(
      isFullBake ? {} : (getAnimatedAdjustmentSettings(clip, clipTime) || clip.adjustments || {})
    )
    const usesTonalAdjustments = hasTonalAdjustmentEffect(adjustmentSettings)
    const adjustmentFilter = buildCssFilterFromAdjustments(adjustmentSettings)
    const clipAdjustmentFilterValue = adjustmentFilter !== 'none' ? adjustmentFilter : null
    const usesManagedEffects = !isFullBake && hasManagedCanvasEffect(clip, clipTime)
    const glslQualityScale = getGlslPreviewQualityScale(state.glslPreviewQuality)
    const timelineFps = state.timelineFps || state.fps || 24
    const velocityMotionBlur = (!isFullBake && canUseVelocityMotionBlur())
      ? getVelocityMotionBlurOptions(clip, clipTime, timelineFps, resolveClipTransformAtTime)
      : null
    const motionBlurSamples = (velocityMotionBlur || isFullBake)
      ? [{ clipTime, weight: 1 }]
      : getMotionBlurSamples(clip, clipTime, timelineFps, 'preview')
    const hasMotionBlurSamples = motionBlurSamples.length > 1

    const buffers = buffersRef.current
    if (!buffers.offCanvas) {
      buffers.offCanvas = document.createElement('canvas')
      buffers.maskCanvas = document.createElement('canvas')
      buffers.perspectiveCanvas = document.createElement('canvas')
    }
    ensureCanvasSize(buffers.offCanvas, width, height)
    ensureCanvasSize(buffers.maskCanvas, width, height)
    // Tonal grades read pixels on the GPU now; only the managed ImageData
    // effects still read this canvas back on the CPU.
    const offCtx = buffers.offCanvas.getContext('2d', { willReadFrequently: usesManagedEffects })
    const maskCtx = buffers.maskCanvas.getContext('2d', { willReadFrequently: true })
    offCtx.clearRect(0, 0, width, height)
    offCtx.save()
    offCtx.globalAlpha = 1
    offCtx.globalCompositeOperation = 'source-over'
    const filterParts = []
    if (!usesTonalAdjustments && clipAdjustmentFilterValue) filterParts.push(clipAdjustmentFilterValue)
    if (blurPx != null) filterParts.push(`blur(${blurPx}px)`)
    offCtx.filter = filterParts.length > 0 ? filterParts.join(' ') : 'none'

    if ((clip.type === 'text' || clip.type === 'shape') && !isFullBake) {
      const isShapeClip = clip.type === 'shape'
      const getTextShapeFrame = (sampleClipTime) => {
        const animatedShapeProperties = isShapeClip ? getAnimatedShapeProperties(clip, sampleClipTime) : null
        const shapeClip = isShapeClip ? { ...clip, shapeProperties: animatedShapeProperties || clip.shapeProperties } : clip
        const rect = isShapeClip
          ? getShapeCanvasRect(shapeClip.shapeProperties, width, height)
          : getBaseDrawRect(width, height, width, height)
        return { shapeClip, rect }
      }
      const drawNativeClip = (targetCtx, rect, shapeClip, sampleClipTime) => {
        if (isShapeClip) {
          drawShape(targetCtx, { x: 0, y: 0, width: rect.width, height: rect.height }, shapeClip)
        } else {
          drawText(targetCtx, rect, clip, 1, sampleClipTime)
        }
      }
      const drawTextShapeSample = (targetCtx, sample, targetFilter = 'none') => {
        const sampleTransform = resolveClipTransformAtTime(sample.clipTime)
        const { shapeClip, rect } = getTextShapeFrame(sample.clipTime)
        targetCtx.save()
        targetCtx.globalAlpha = sample.weight
        targetCtx.filter = targetFilter
        targetCtx.globalCompositeOperation = 'source-over'
        if (hasPerspectiveClipTransform(sampleTransform)) {
          ensureCanvasSize(buffers.perspectiveCanvas, Math.max(1, Math.ceil(rect.width)), Math.max(1, Math.ceil(rect.height)))
          const nativeCtx = buffers.perspectiveCanvas.getContext('2d', { alpha: true })
          nativeCtx.clearRect(0, 0, buffers.perspectiveCanvas.width, buffers.perspectiveCanvas.height)
          nativeCtx.save()
          drawNativeClip(nativeCtx, { x: 0, y: 0, width: rect.width, height: rect.height }, shapeClip, sample.clipTime)
          nativeCtx.restore()
          drawPerspectiveClipSource(targetCtx, buffers.perspectiveCanvas, rect, sampleTransform, transitionStyle)
        } else {
          applyClipTransform(targetCtx, rect, sampleTransform, transitionStyle)
          applyClipCrop(targetCtx, rect, sampleTransform)
          applyTransitionClip(targetCtx, rect, transitionStyle)
          drawNativeClip(targetCtx, rect, shapeClip, sample.clipTime)
        }
        targetCtx.restore()
      }
      const drawTextShapeSamplesToOffCanvas = (targetFilter = 'none') => {
        offCtx.clearRect(0, 0, width, height)
        for (const sample of motionBlurSamples) {
          drawTextShapeSample(offCtx, sample, targetFilter)
        }
      }
      if (hasPerspectiveClipTransform(clipTransform)) {
        // Perspective clips render through a temporary source canvas. Treat
        // that path like motion blur so the perspective sample can be rebuilt
        // for each sub-frame before post-processing.
        drawTextShapeSamplesToOffCanvas(offCtx.filter)
        offCtx.restore()
      } else if (hasMotionBlurSamples) {
        drawTextShapeSamplesToOffCanvas(offCtx.filter)
        offCtx.restore()
      } else {
        const { shapeClip, rect } = getTextShapeFrame(clipTime)
        applyClipTransform(offCtx, rect, clipTransform, transitionStyle)
        applyClipCrop(offCtx, rect, clipTransform)
        applyTransitionClip(offCtx, rect, transitionStyle)
        drawNativeClip(offCtx, rect, shapeClip, clipTime)
        offCtx.restore()
      }
      if (velocityMotionBlur) {
        applyVelocityMotionBlurToCanvas(buffers.offCanvas, offCtx, width, height, velocityMotionBlur)
      }
    } else {
      const clipUrl = resolvePreviewUrl(clip, getAssetById, state.useProxyPlaybackForAssets)
      if (!clipUrl) {
        offCtx.restore()
        return
      }

      let drawSource = null
      let sourceWidth = width
      let sourceHeight = height
      const isCachedRender = clip.cacheStatus === 'cached' && clip.cacheUrl && clipUrl === clip.cacheUrl
      if (clip.type === 'video' || isFullBake) {
        const video = videoCache.getVideoElement({ ...clip, url: clipUrl })
        if (!video) {
          offCtx.restore()
          return 'unready'
        }
        const transitionPlayback = getClipPlaybackTimingAtTimeline(clip, time, 0.01, {
          allowHandles: !!transitionStyle,
        })
        const targetTime = isCachedRender
          ? clamp(clipTime, 0, Math.max(0, clip.duration - 0.01))
          : transitionPlayback.time
        const timeDiff = Math.abs((video.currentTime || 0) - targetTime)
        const seekDriven = isSeekDrivenPlayback(state, clip)
        const isTransitionClip = !!transitionStyle
        const shouldHoldTransitionFrame = isTransitionClip && transitionPlayback.clamped
        const seekThreshold = state.isScrubbingPreview
          ? SCRUB_READY_TOLERANCE
          : (state.isPlaying ? (seekDriven ? 0.12 : (shouldHoldTransitionFrame ? 0.025 : 0.16)) : 0.025)
        if (!state.isScrubbingPreview && video.readyState >= 1 && timeDiff > seekThreshold) {
          video.currentTime = targetTime
        }
        if (state.isPlaying && !seekDriven && video.readyState >= 2 && !shouldHoldTransitionFrame) {
          const baseScale = clip.sourceTimeScale || (clip.timelineFps && clip.sourceFps
            ? clip.timelineFps / clip.sourceFps
            : 1)
          const speed = Number(clip.speed)
          const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
          const timelineRate = Number(state.playbackRate)
          const timelineRateScale = Number.isFinite(timelineRate) && timelineRate !== 0
            ? Math.abs(timelineRate)
            : 1
          const playbackSpeed = Math.max(0.01, Math.abs(baseScale * speedScale * timelineRateScale))
          if (Math.abs((video.playbackRate || 1) - playbackSpeed) > 0.001) {
            video.playbackRate = playbackSpeed
          }
          if (video.paused) video.play().catch(() => {})
        } else if (!video.paused) {
          video.pause()
        }
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
          offCtx.restore()
          return 'unready'
        }
        sourceWidth = video.videoWidth || width
        sourceHeight = video.videoHeight || height
        drawSource = video
      } else if (clip.type === 'image') {
        const image = getImageForUrl(clipUrl)
        if (!image) {
          offCtx.restore()
          // Still decoding → hold; permanently failed → let it stay absent.
          return imageCacheRef.current.get(clipUrl)?.failed ? undefined : 'unready'
        }
        sourceWidth = image.naturalWidth || width
        sourceHeight = image.naturalHeight || height
        drawSource = image
      }

      if (!drawSource) {
        offCtx.restore()
        return
      }

      const rect = getBaseDrawRect(sourceWidth, sourceHeight, width, height)
      const getSampleTransform = (sampleClipTime) => (
        resolveClipTransformAtTime(sampleClipTime)
      )
      const drawMediaSample = (targetCtx, source, sample, targetFilter = 'none') => {
        const sampleTransform = getSampleTransform(sample.clipTime)
        targetCtx.save()
        targetCtx.globalAlpha = sample.weight
        targetCtx.globalCompositeOperation = 'source-over'
        targetCtx.filter = targetFilter
        if (hasPerspectiveClipTransform(sampleTransform)) {
          drawPerspectiveClipSource(targetCtx, source, rect, sampleTransform, transitionStyle)
        } else {
          applyClipTransform(targetCtx, rect, sampleTransform, transitionStyle)
          applyClipCrop(targetCtx, rect, sampleTransform)
          applyTransitionClip(targetCtx, rect, transitionStyle)
          targetCtx.drawImage(source, 0, 0, rect.width, rect.height)
        }
        targetCtx.restore()
      }
      offCtx.clearRect(0, 0, width, height)
      for (const sample of motionBlurSamples) {
        drawMediaSample(offCtx, drawSource, sample, offCtx.filter)
      }
      offCtx.restore()

      const maskInfo = getMaskInfo(clip, getAssetById, time, isCachedRender)
      if (maskInfo) {
        const maskCanvas = getProcessedMaskForUrl(maskInfo.url)
        if (maskCanvas) {
          maskCtx.clearRect(0, 0, width, height)
          for (const sample of motionBlurSamples) {
            drawMediaSample(maskCtx, maskCanvas, sample, blurPx != null ? `blur(${blurPx}px)` : 'none')
          }

          offCtx.save()
          offCtx.globalCompositeOperation = maskInfo.invertMask ? 'destination-out' : 'destination-in'
          offCtx.drawImage(buffers.maskCanvas, 0, 0)
          offCtx.restore()
        }
      }
      if (velocityMotionBlur) {
        applyVelocityMotionBlurToCanvas(buffers.offCanvas, offCtx, width, height, velocityMotionBlur)
      }
    }

    let outputCanvas = buffers.offCanvas
    if (usesTonalAdjustments) {
      outputCanvas = applyAdvancedAdjustmentsToCanvas(buffers.offCanvas, adjustmentSettings, width, height, blurPx)
    }
    if (usesManagedEffects) {
      const outputCtx = outputCanvas.getContext('2d', { willReadFrequently: true })
      applyManagedCanvasEffects(outputCanvas, outputCtx, width, height, clip, clipTime, frameIndex, glslQualityScale)
    }

    ctx.save()
    ctx.globalAlpha = clipOpacity
    ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode
    ctx.filter = 'none'
    ctx.drawImage(outputCanvas, 0, 0)
    ctx.restore()
  }, [applyAdvancedAdjustmentsToCanvas, getImageForUrl, getProcessedMaskForUrl])

  const applyAdjustmentLayer = useCallback((ctx, clip, time, frameIndex, state) => {
    const width = state.width
    const height = state.height
    const clipTime = time - (clip.startTime || 0)
    const adjustmentSettings = normalizeAdjustmentSettings(
      getAnimatedAdjustmentSettings(clip, clipTime) || clip.adjustments || {}
    )
    const baseTransform = getAnimatedTransform(clip, clipTime) || clip.transform || {}
    const clipTransform = applyEffectsToTransform(baseTransform, clip.effects, clipTime)
    const usesManagedEffects = hasManagedCanvasEffect(clip, clipTime)
    const adjustmentIsActive = hasAdjustmentEffect(adjustmentSettings)
    const glslQualityScale = getGlslPreviewQualityScale(state.glslPreviewQuality)
    if (!adjustmentIsActive && !usesManagedEffects) return

    const buffers = buffersRef.current
    if (!buffers.adjustmentCanvas) buffers.adjustmentCanvas = document.createElement('canvas')
    ensureCanvasSize(buffers.adjustmentCanvas, width, height)
    const adjustmentCtx = buffers.adjustmentCanvas.getContext('2d', { willReadFrequently: true })
    adjustmentCtx.clearRect(0, 0, width, height)
    adjustmentCtx.drawImage(ctx.canvas, 0, 0)

    let outputCanvas = buffers.adjustmentCanvas
    if (hasTonalAdjustmentEffect(adjustmentSettings)) {
      outputCanvas = applyAdvancedAdjustmentsToCanvas(buffers.adjustmentCanvas, adjustmentSettings, width, height)
    } else if (adjustmentIsActive) {
      const filter = buildCssFilterFromAdjustments(adjustmentSettings)
      if (filter !== 'none') {
        if (!buffers.processedCanvas) buffers.processedCanvas = document.createElement('canvas')
        ensureCanvasSize(buffers.processedCanvas, width, height)
        const processedCtx = buffers.processedCanvas.getContext('2d')
        processedCtx.clearRect(0, 0, width, height)
        processedCtx.save()
        processedCtx.filter = filter
        processedCtx.drawImage(buffers.adjustmentCanvas, 0, 0)
        processedCtx.restore()
        outputCanvas = buffers.processedCanvas
      }
    }

    if (usesManagedEffects) {
      const outputCtx = outputCanvas.getContext('2d', { willReadFrequently: true })
      applyManagedCanvasEffects(outputCanvas, outputCtx, width, height, clip, clipTime, frameIndex, glslQualityScale)
    }

    const rect = getBaseDrawRect(width, height, width, height)
    const opacity = typeof clipTransform.opacity === 'number' ? clipTransform.opacity / 100 : 1
    const blendMode = clipTransform.blendMode || 'normal'
    ctx.save()
    ctx.globalAlpha = opacity
    ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode
    ctx.filter = 'none'
    if (hasPerspectiveClipTransform(clipTransform)) {
      drawPerspectiveClipSource(ctx, outputCanvas, rect, clipTransform, null)
    } else {
      applyClipTransform(ctx, rect, clipTransform, null)
      applyClipCrop(ctx, rect, clipTransform)
      ctx.drawImage(outputCanvas, 0, 0, rect.width, rect.height)
    }
    ctx.restore()
  }, [applyAdvancedAdjustmentsToCanvas])

  const preloadVideosAroundTime = useCallback((state, time) => {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (now - lastPreloadTimeRef.current < 250) return
    lastPreloadTimeRef.current = now
    const getAssetById = useAssetsStore.getState().getAssetById
    const isForward = state.playbackRate >= 0
    const lookaheadEnd = time + (isForward ? PRELOAD_LOOKAHEAD : -PRELOAD_LOOKAHEAD)
    const videoTrackIds = new Set(state.tracks.filter(t => t.type === 'video').map(t => t.id))
    state.clips.forEach((clip) => {
      if (!videoTrackIds.has(clip.trackId) || clip.type !== 'video' || clip.enabled === false) return
      const clipStart = Number(clip.startTime) || 0
      const clipDuration = Number(clip.duration) || 0
      const clipEnd = clipStart + clipDuration
      const isActive = time >= clipStart && time < clipEnd
      const isUpcoming = isForward
        ? clipStart > time && clipStart <= lookaheadEnd
        : clipEnd < time && clipEnd >= lookaheadEnd
      if (!isActive && !isUpcoming) return
      const url = resolvePreviewUrl(clip, getAssetById, state.useProxyPlaybackForAssets)
      if (!url) return
      const video = videoCache.getVideoElement({ ...clip, url }, true)
      if (!video || isActive) return
      const targetTimelineTime = isForward ? clipStart : clipEnd
      const targetTime = getClipPlaybackTimeAtTimeline(clip, targetTimelineTime)
      if (video.readyState >= 1) {
        if (Math.abs((video.currentTime || 0) - targetTime) > 0.03) {
          video.currentTime = targetTime
        }
      } else if (video.dataset.parkSeekPending !== '1') {
        // Cold element: park it at the clip's entry frame the moment its
        // metadata arrives instead of waiting for a later 250ms preload
        // pass — by then the cut may already be on screen.
        video.dataset.parkSeekPending = '1'
        video.addEventListener('loadedmetadata', () => {
          delete video.dataset.parkSeekPending
          if (Math.abs((video.currentTime || 0) - targetTime) > 0.03) {
            video.currentTime = targetTime
          }
        }, { once: true })
      }
    })
  }, [])

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const state = {
      ...latestRef.current,
      ...useTimelineStore.getState(),
    }
    const width = latestRef.current.width || safeWidth
    const height = latestRef.current.height || safeHeight
    const fps = latestRef.current.fps || safeFps
    const time = state.playheadPosition || 0
    const nowMs = getNowMs()
    const previousDrawTime = lastDrawTimeRef.current
    const loopJumpThreshold = Math.max(0.08, 2 / Math.max(1, fps))
    const loopedBackward = state.isPlaying
      && Number.isFinite(previousDrawTime)
      && time < previousDrawTime - loopJumpThreshold
    lastDrawTimeRef.current = time
    if (!state.isPlaying) {
      loopSeekHoldUntilRef.current = 0
    } else if (loopedBackward) {
      loopSeekHoldUntilRef.current = nowMs + 500
      logCanvasDiag('loop-seek-hold:start', {
        from: Number(previousDrawTime.toFixed(3)),
        to: Number(time.toFixed(3)),
      })
    }
    const loopSeekHoldActive = state.isPlaying && nowMs < loopSeekHoldUntilRef.current
    const isScrubbingPreview = !state.isPlaying
      && nowMs < (scrubPreviewStateRef.current.activeUntil || 0)
    state.isScrubbingPreview = isScrubbingPreview
    const transitionInfo = state.getTransitionAtTime(time)
    const transitionClipIds = getTransitionClipIds(transitionInfo)
    const frameIndex = Math.floor(time * fps)
    const getAssetById = useAssetsStore.getState().getAssetById
    const visualClips = cullVisualLayerEntries(getVisualLayerClips(state, time), {
      time,
      getAssetById,
      transitionClipIds,
      timelineWidth: width,
      timelineHeight: height,
    })

    preloadVideosAroundTime(state, time)

    const shouldGateVideoReadiness = !state.isPlaying
      || transitionClipIds.size > 0
      || loopSeekHoldActive
      || visualClips.some(({ clip }) => clip?.type === 'video' && isSeekDrivenPlayback(state, clip))

    if (shouldGateVideoReadiness) {
      for (const { clip } of visualClips) {
        if (!clip || (clip.type !== 'video' && !isFullBakeFresh(clip))) continue
        const seekDriven = isSeekDrivenPlayback(state, clip)
        const isTransitionClip = transitionClipIds.has(clip.id)
        if (state.isPlaying && !seekDriven && !isTransitionClip && !loopSeekHoldActive) continue
        const clipUrl = resolvePreviewUrl(clip, getAssetById, state.useProxyPlaybackForAssets)
        if (!clipUrl) continue
        const video = videoCache.getVideoElement({ ...clip, url: clipUrl })
        if (!video) {
          scheduleDeferredDraw(seekDriven ? 'seek-video-missing' : 'paused-video-missing')
          return
        }
        const isCachedRender = clip.cacheStatus === 'cached' && clip.cacheUrl && clipUrl === clip.cacheUrl
        const clipTime = time - (clip.startTime || 0)
        const transitionPlayback = getClipPlaybackTimingAtTimeline(clip, time, 0.01, {
          allowHandles: isTransitionClip,
        })
        const targetTime = isCachedRender
          ? clamp(clipTime, 0, Math.max(0, clip.duration - 0.01))
          : transitionPlayback.time

        if (video.readyState < 1) {
          scheduleDeferredDraw(seekDriven ? 'seek-video-metadata' : 'paused-video-metadata')
          return
        }

        const readyTolerance = state.isScrubbingPreview
          ? SCRUB_READY_TOLERANCE
          : (seekDriven ? 0.12 : ((isTransitionClip && state.isPlaying && !loopSeekHoldActive) ? 0.16 : 0.025))
        if (Math.abs((video.currentTime || 0) - targetTime) > readyTolerance) {
          if (state.isScrubbingPreview) {
            issueScrubSeek(video, targetTime)
            scheduleDeferredDraw('scrub-video-seek')
            if (video.readyState >= 2 && video.videoWidth && video.videoHeight) continue
            return
          }
          video.currentTime = targetTime
          scheduleDeferredDraw(seekDriven ? 'seek-video-seek' : 'paused-video-seek')
          // If we already have a good frame, preserve it while the parked
          // seek resolves. Reverse playback is seek-driven too, so holding
          // the canvas here prevents stale decoder frames from leaking.
          if (hasPaintedFrameRef.current || video.readyState < 2) return
        }

        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
          scheduleDeferredDraw(seekDriven ? 'seek-video-frame' : 'paused-video-frame')
          return
        }
      }
    }

    ensureCanvasSize(canvas, width, height)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    const shouldHoldLastFrame = state.isPlaying && hasPaintedFrameRef.current
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.filter = 'none'
    const lastFrameCanvas = lastFrameCanvasRef.current
    if (shouldHoldLastFrame && lastFrameCanvas) {
      ctx.drawImage(lastFrameCanvas, 0, 0, width, height)
    } else {
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, width, height)
    }

    const stageCanvas = document.createElement('canvas')
    ensureCanvasSize(stageCanvas, width, height)
    const stageCtx = stageCanvas.getContext('2d', { alpha: false })
    if (!stageCtx) return
    stageCtx.imageSmoothingEnabled = true
    stageCtx.imageSmoothingQuality = 'high'
    stageCtx.setTransform(1, 0, 0, 1, 0, 0)
    stageCtx.globalAlpha = 1
    stageCtx.globalCompositeOperation = 'source-over'
    stageCtx.filter = 'none'
    stageCtx.fillStyle = '#000000'
    stageCtx.fillRect(0, 0, width, height)

    let sawUnreadyVisual = false
    for (const entry of visualClips) {
      const { clip } = entry
      if (!clip) continue
      if (clip.type === 'adjustment') {
        applyAdjustmentLayer(stageCtx, clip, time, frameIndex, { ...state, width, height, fps })
        continue
      }
      if (clip.type === 'video' || clip.type === 'image' || clip.type === 'text' || clip.type === 'shape') {
        const status = drawVisualClip(stageCtx, entry, time, transitionInfo, { ...state, width, height, fps }, frameIndex)
        if (status === 'unready') sawUnreadyVisual = true
      }
    }

    const fadeOverlay = getFadeOverlayInfo(transitionInfo)
    if (fadeOverlay && fadeOverlay.opacity > 0.001) {
      stageCtx.save()
      stageCtx.globalAlpha = Math.min(1, fadeOverlay.opacity)
      stageCtx.fillStyle = fadeOverlay.color
      stageCtx.fillRect(0, 0, width, height)
      stageCtx.restore()
    }

    // A clip that should be visible couldn't draw yet (cold element at a
    // cut, mid-seek decoder dip, image still decoding). Blitting now would
    // flash the black stage and poison the held frame, so keep the previous
    // frame on screen briefly — the rAF loop retries every tick while
    // playing. Bounded so a permanently broken source degrades to black
    // instead of freezing playback on a stale frame.
    if (state.isPlaying && sawUnreadyVisual && hasPaintedFrameRef.current && lastFrameCanvasRef.current) {
      if (!unreadyHoldUntilRef.current) {
        unreadyHoldUntilRef.current = nowMs + PLAYBACK_UNREADY_HOLD_MS
        logCanvasDiag('unready-hold:start', { time: Number(time.toFixed(3)) })
      }
      if (nowMs < unreadyHoldUntilRef.current) return
    } else if (!sawUnreadyVisual && unreadyHoldUntilRef.current) {
      unreadyHoldUntilRef.current = 0
    }

    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(stageCanvas, 0, 0)
    if (!lastFrameCanvasRef.current) {
      lastFrameCanvasRef.current = document.createElement('canvas')
    }
    ensureCanvasSize(lastFrameCanvasRef.current, width, height)
    const lastCtx = lastFrameCanvasRef.current.getContext('2d', { alpha: false })
    if (lastCtx) {
      lastCtx.clearRect(0, 0, width, height)
      lastCtx.drawImage(stageCanvas, 0, 0)
    }
    hasPaintedFrameRef.current = true
    if (loopSeekHoldActive) {
      loopSeekHoldUntilRef.current = 0
    }
  }, [applyAdjustmentLayer, drawVisualClip, issueScrubSeek, preloadVideosAroundTime, safeFps, safeHeight, safeWidth, scheduleDeferredDraw])

  drawFrameRef.current = drawFrame

  useEffect(() => {
    const currentPlayhead = Number(playheadPosition) || 0
    const scrubState = scrubPreviewStateRef.current

    if (isPlaying) {
      scrubState.lastPlayhead = currentPlayhead
      scrubState.activeUntil = 0
      if (scrubSettleTimerRef.current) {
        window.clearTimeout(scrubSettleTimerRef.current)
        scrubSettleTimerRef.current = 0
      }
      return
    }

    const playheadChanged = Math.abs(currentPlayhead - (Number(scrubState.lastPlayhead) || 0)) > 0.0005
    scrubState.lastPlayhead = currentPlayhead
    if (!playheadChanged) return

    const nowMs = getNowMs()
    scrubState.activeUntil = nowMs + SCRUB_ACTIVE_WINDOW_MS

    if (scrubSettleTimerRef.current) window.clearTimeout(scrubSettleTimerRef.current)
    scrubSettleTimerRef.current = window.setTimeout(() => {
      scrubSettleTimerRef.current = 0
      drawFrameRef.current?.()
    }, SCRUB_SETTLE_DELAY_MS)
  }, [isPlaying, playheadPosition])

  // Timeline dispatches this on scrub mouseup. Exit scrub mode and run the
  // strict-tolerance draw immediately instead of waiting out the settle
  // timer, so the released frame commits as fast as the seek can resolve.
  useEffect(() => {
    const handleScrubEnd = () => {
      scrubPreviewStateRef.current.activeUntil = 0
      if (scrubSettleTimerRef.current) {
        window.clearTimeout(scrubSettleTimerRef.current)
        scrubSettleTimerRef.current = 0
      }
      drawFrameRef.current?.()
    }
    window.addEventListener('comfystudio:timeline-scrub-end', handleScrubEnd)
    return () => window.removeEventListener('comfystudio:timeline-scrub-end', handleScrubEnd)
  }, [])

  useEffect(() => {
    let animationFrame = 0
    if (!isPlaying) {
      videoCache.pauseAll()
      drawFrame()
      return undefined
    }

    const tick = () => {
      drawFrame()
      animationFrame = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      if (animationFrame) cancelAnimationFrame(animationFrame)
    }
  }, [drawFrame, isPlaying])

  useEffect(() => () => {
    if (deferredDrawTimerRef.current) {
      window.clearTimeout(deferredDrawTimerRef.current)
      deferredDrawTimerRef.current = 0
    }
    if (deferredDrawRafRef.current) {
      cancelAnimationFrame(deferredDrawRafRef.current)
      deferredDrawRafRef.current = 0
    }
    if (scrubSettleTimerRef.current) {
      window.clearTimeout(scrubSettleTimerRef.current)
      scrubSettleTimerRef.current = 0
    }
  }, [])

  useEffect(() => {
    if (!isPlaying) drawFrame()
  }, [
    assets,
    clips,
    drawFrame,
    isPlaying,
    playheadPosition,
    safeFps,
    safeHeight,
    safeWidth,
    tracks,
    transitions,
    useProxyPlaybackForAssets,
    glslPreviewQuality,
  ])

  const getSelectableClipAtPointerEvent = useCallback((event) => {
    const canvas = canvasRef.current
    if (!canvas || !event) return null

    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null

    const width = latestRef.current.width || safeWidth
    const height = latestRef.current.height || safeHeight
    const point = {
      x: ((event.clientX - rect.left) / rect.width) * width,
      y: ((event.clientY - rect.top) / rect.height) * height,
    }

    const state = useTimelineStore.getState()
    const time = state.playheadPosition || 0
    const transitionInfo = state.getTransitionAtTime(time)
    const transitionClipIds = getTransitionClipIds(transitionInfo)
    const getAssetById = useAssetsStore.getState().getAssetById
    const visualClips = cullVisualLayerEntries(getVisualLayerClips(state, time), {
      time,
      getAssetById,
      transitionClipIds,
      timelineWidth: width,
      timelineHeight: height,
    })

    for (let index = visualClips.length - 1; index >= 0; index -= 1) {
      const clip = visualClips[index]?.clip
      if (!clip || !['video', 'image', 'text', 'shape'].includes(clip.type)) continue

      const clipTime = time - (clip.startTime || 0)
      const transitionStyle = getTransitionStyleForClip(transitionInfo, clip)
      const baseTransform = getAnimatedTransform(clip, clipTime) || clip.transform || {}
      const clipTransform = applyEffectsToTransform(baseTransform, clip.effects, clipTime)
      const { width: sourceWidth, height: sourceHeight } = getClipHitSourceDimensions({
        clip,
        clipTime,
        state,
        getAssetById,
        imageCacheRef,
        canvasWidth: width,
        canvasHeight: height,
      })
      const animatedShapeProperties = clip.type === 'shape'
        ? getAnimatedShapeProperties(clip, clipTime) || clip.shapeProperties
        : null
      const drawRect = clip.type === 'shape'
        ? getShapeCanvasRect(animatedShapeProperties, width, height)
        : getBaseDrawRect(sourceWidth || width, sourceHeight || height, width, height)

      if (clipContainsCanvasPoint(point, clip, drawRect, clipTransform, transitionStyle)) {
        return clip
      }
    }

    return null
  }, [safeHeight, safeWidth])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full bg-black"
      width={safeWidth}
      height={safeHeight}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        const selectableClip = getSelectableClipAtPointerEvent(event)
        if (selectableClip && typeof onClipPointerDown === 'function') {
          onClipPointerDown(selectableClip, event)
        }
      }}
      onDoubleClick={(event) => {
        const selectableClip = getSelectableClipAtPointerEvent(event)
        if (selectableClip?.type === 'text' && typeof onClipDoubleClick === 'function') {
          onClipDoubleClick(selectableClip, event)
        }
      }}
      style={{
        display: 'block',
      }}
    />
  )
}

export default memo(CanvasPreviewRenderer)
