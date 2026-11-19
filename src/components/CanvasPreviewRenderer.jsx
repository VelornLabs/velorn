import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useTimelineStore from '../stores/timelineStore'
import { useShallow } from 'zustand/react/shallow'
import useAssetsStore from '../stores/assetsStore'
import { getCompoundRenderState, isClipInPlaybackWindow } from '../utils/compoundPlayback.mjs'
import videoCache from '../services/videoCache'
import { hasUsablePlaybackCache } from '../services/playbackCache'
import { hasUsableProxy } from '../services/proxyCache'
import { getAnimatedAdjustmentSettings, getAnimatedTransform, getAnimatedShapeProperties, getAnimatedShapeMask } from '../utils/keyframes'
import {
  applyAdjustmentSettingsToImageData,
  buildCssFilterFromAdjustments,
  hasAdjustmentEffect,
  hasTonalAdjustmentEffect,
  hasTransformingAdjustmentTransform,
  needsAdvancedColorPass,
  normalizeAdjustmentSettings,
} from '../utils/adjustments'
import { applyAdjustmentSettingsToCanvasGpu } from '../utils/adjustmentsGpu'
import { LUTS_CHANGED_EVENT } from '../services/lutLibrary'
import { registerPreviewFrameSource, unregisterPreviewFrameSource } from '../services/previewFrameTap'
import { getShapeMaskCanvases, getShapeMaskSignature } from '../utils/shapeMask'
import { getRenderAdjustments, getRenderEffects, isClipBypassed } from '../utils/clipBypass'
import { drawLiveCaptionsFrame } from '../utils/captionRenderer'
import {
  applyBlurPassesToCanvas,
  applyEffectsToTransform,
  applyGlowPassesToCanvas,
  applyPixelEffectsToImageData,
  buildManagedEffectGpuPasses,
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
import { parseTrackMatte, resolveTrackMatteAssignments, applyTrackMatteToCanvas } from '../utils/trackMatte'
import { applyTransitionClip, getFadeOverlayInfo, getTransitionStyleForClip } from '../utils/transitionStyles'
import { isFullBakeFresh } from '../utils/clipBakeSignature'
import { getMotionBlurSamples, getVelocityMotionBlurOptions } from '../utils/motionBlur'
import { hasSpeedRamp, getRampedSpeedAtTime } from '../utils/timeRemap'
import {
  FRAME_SAMPLING_MODE,
  getOpticalFlowCacheUsability,
  getRequiredOpticalFlowHandleSeconds,
  normalizeFrameSamplingMode,
} from '../utils/frameSampling'
import { getClipPlaybackTimeAtTimeline, getClipPlaybackTimingAtTimeline } from '../utils/clipPlaybackTiming'
import {
  doesPresentedVideoFrameMatchTarget,
  getPreciseVideoSeekFps,
  getTargetVideoFrameIndex,
  getVideoFrameSeekTime,
  isSameVideoFrameSeekTime,
  isFrameStepSeekIntentAtTime,
  isSamePreciseVideoSeekTarget,
  shouldIssuePreciseVideoSeek,
} from '../utils/previewVideoSeeking'
import { registerLivePreviewCapture, unregisterLivePreviewCapture } from '../services/previewFrameBridge'
import { createScrubVideoPresentation } from '../utils/scrubVideoPresentation.mjs'
import { getClipPreviewPreloadPlan } from '../utils/previewPreloadPlan.mjs'
import { getCurrentPlaybackJump } from '../utils/playbackJump.mjs'
import { landPlaybackJumpVideo } from '../utils/playbackJumpVideo.mjs'
import { applyVelocityMotionBlurToCanvas, buildVelocityBlurUniformValues, canUseVelocityMotionBlur } from '../utils/velocityMotionBlur'
import {
  applyClipCrop,
  applyClipTransform,
  drawPerspectiveClipSource,
  drawText,
  getApproxTransformScale,
  getBaseDrawRect,
  getClipQuadCorners,
  hasPerspectiveClipTransform,
  routeGpuLayerColorBlur,
} from '../services/exporter'
import { createGpuCompositor } from '../services/gpuCompositor'
import { drawShape, getShapeCanvasRect } from '../utils/shapes'

const PRELOAD_LOOKAHEAD = 2.5
const PLAYBACK_DIAG_KEY = 'comfystudio-playback-diag'
const SCRUB_ACTIVE_WINDOW_MS = 220
const SCRUB_SETTLE_DELAY_MS = SCRUB_ACTIVE_WINDOW_MS + 45
const PRECISE_SEEK_STALL_MS = 750
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

function getOpticalFlowContextOptions(clip) {
  const timelineState = getCompoundRenderState(useTimelineStore.getState())
  return {
    handleSeconds: getRequiredOpticalFlowHandleSeconds(
      clip,
      timelineState.transitions,
      timelineState.clips
    ),
  }
}

// Exported for Match Frame (Timeline.jsx): maps a timeline time to the clip's
// source time with the same speed/ramp/reverse/trim math the preview uses.
function resolvePreviewUrl(clip, getAssetById, useProxyPlaybackForAssets) {
  if (!clip) return null
  // Render caches: legacy (mask) bakes apply to video clips; full bakes
  // (cacheKind 'full') turn any clip type into a video source but are only
  // used while their content signature is fresh.
  if (clip.cacheStatus === 'cached' && clip.cacheUrl) {
    if (clip.cacheKind === 'full') {
      if (isFullBakeFresh(clip)) return clip.cacheUrl
    } else if (
      clip.type === 'video'
      && normalizeFrameSamplingMode(clip.frameSampling) !== FRAME_SAMPLING_MODE.OPTICAL_FLOW
    ) {
      return clip.cacheUrl
    }
  }
  const asset = clip.assetId ? getAssetById(clip.assetId) : null
  if (clip.type === 'video') {
    const opticalFlow = getOpticalFlowCacheUsability(clip, {
      requireUrl: true,
      ...getOpticalFlowContextOptions(clip),
    })
    if (opticalFlow.usable) return opticalFlow.cache.url
    const useProxy = useProxyPlaybackForAssets && !!asset?.proxyUrl && hasUsableProxy(asset)
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
  const effects = getRenderEffects(clip)
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

// One off-screen composite surface per visible preview canvas, reused for
// every frame. Allocating a fresh timeline-sized canvas on each draw (up to
// the screen's refresh rate during playback) churned a full frame of memory
// per draw. `reset()` returns the context to its initial state, including
// any unbalanced save/clip a clip draw left behind, so a reused surface
// starts each frame exactly as a new one would. Without `reset()` support a
// fresh canvas is still created per frame.
const stageCanvasByOutput = new WeakMap()

function acquireStageCanvas(outputCanvas, width, height) {
  let stageCanvas = stageCanvasByOutput.get(outputCanvas)
  let stageCtx = stageCanvas ? stageCanvas.getContext('2d', { alpha: false }) : null
  if (!stageCtx || typeof stageCtx.reset !== 'function') {
    stageCanvas = document.createElement('canvas')
    ensureCanvasSize(stageCanvas, width, height)
    stageCtx = stageCanvas.getContext('2d', { alpha: false })
    if (stageCtx && typeof stageCtx.reset === 'function') stageCanvasByOutput.set(outputCanvas, stageCanvas)
    return { stageCanvas, stageCtx }
  }
  ensureCanvasSize(stageCanvas, width, height)
  stageCtx.reset()
  return { stageCanvas, stageCtx }
}

function ensureCanvasSize(canvas, width, height) {
  if (!canvas) return
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
}

function getVisualLayerClips(state, time) {
  const activeClips = state.getActiveClipsAtTime(time)
  return activeClips
    .filter(({ clip, track }) => track.type === 'video' && (!clip.compoundParentId || isClipInPlaybackWindow(clip, time)))
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

function getMaskInfo(clip, getAssetById, time, isCachedRender = false, allowHandles = false) {
  if (isClipBypassed(clip, 'mask')) return null
  if (isCachedRender) return null
  // Parametric shape mask (clip.shapeMask) wins over a raster mask effect
  // for now — the AI/raster masks fold into the same home later. Feather
  // and invert are baked into the rasters, so consumers treat it as a plain
  // non-inverted matte: the 2D path composites the alpha encoding, the GPU
  // path samples the opaque luminance encoding.
  const animatedShapeMask = getAnimatedShapeMask(clip, time - (clip?.startTime || 0))
  const shapeCanvases = getShapeMaskCanvases(animatedShapeMask)
  if (shapeCanvases) {
    return {
      shapeCanvasAlpha: shapeCanvases.alpha,
      shapeCanvasLuma: shapeCanvases.luma,
      shapeSignature: getShapeMaskSignature(animatedShapeMask),
      invertMask: false,
    }
  }
  if (!clip?.effects) return null
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
    const sourceTime = getClipPlaybackTimeAtTimeline(clip, time, 0.001, {
      useFrameSampling: false,
      allowHandles,
    })
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

const selectCanvasPreviewSlice = (rawState) => {
  const state = getCompoundRenderState(rawState)
  return {
    clips: state.clips,
    tracks: state.tracks,
    transitions: state.transitions,
    isPlaying: state.isPlaying,
    playheadPosition: state.isPlaying ? null : state.playheadPosition,
    playheadSeekIntent: state.isPlaying ? null : state.playheadSeekIntent,
    playbackRate: state.playbackRate,
    useProxyPlaybackForAssets: state.useProxyPlaybackForAssets,
    glslPreviewQuality: state.glslPreviewQuality,
    compoundRenderErrors: state.compoundRenderErrors,
  }
}

function CanvasPreviewRenderer({
  timelineWidth = 1920,
  timelineHeight = 1080,
  timelineFps = 30,
  onClipPointerDown,
  onClipDoubleClick,
  playbackStatsRef = null,
}) {
  const canvasRef = useRef(null)
  const imageCacheRef = useRef(new Map())
  const maskCacheRef = useRef(new Map())
  const buffersRef = useRef({})
  const lastFrameCanvasRef = useRef(null)
  const lastCommittedFrameTimeRef = useRef(null)
  const frameCommitSerialRef = useRef(0)
  const latestRef = useRef({})
  const drawFrameRef = useRef(null)
  const deferredDrawTimerRef = useRef(0)
  const deferredDrawRafRef = useRef(0)
  const scrubSettleTimerRef = useRef(0)
  const scrubPreviewStateRef = useRef({ lastPlayhead: 0, activeUntil: 0 })
  const scrubPresentationRef = useRef(null)
  if (!scrubPresentationRef.current) {
    scrubPresentationRef.current = createScrubVideoPresentation({ requestDraw: () => drawFrameRef.current?.() })
  }
  const scrubContextRef = useRef(null)
  const preciseVideoSeeksRef = useRef(new Map())
  const preciseSeekSerialRef = useRef(0)
  const playbackJumpVideosRef = useRef(new Map())
  const playbackJumpTokenRef = useRef(null)
  const unreadyHoldUntilRef = useRef(0)
  const hasPaintedFrameRef = useRef(false)
  const lastPreloadTimeRef = useRef(0)
  const lastDrawTimeRef = useRef(null)
  const loopSeekHoldUntilRef = useRef(0)
  const wasPlayingRef = useRef(false)
  const rasterSourceRevisionRef = useRef(0)
  const rasterSourceInputsRef = useRef({
    clips: null,
    tracks: null,
    transitions: null,
    assets: null,
  })
  const [assetRevision, setAssetRevision] = useState(0)

  // Subscribe to exactly what this component's render and effects consume.
  // During playback the animation-frame loop below reads the live store
  // itself, so the playhead is left out of the slice while playing: React
  // then has nothing to re-render on each playhead write. Paused, the exact
  // playhead is included so scrubbing and stepping repaint as before.
  const {
    clips,
    tracks,
    transitions,
    isPlaying,
    playheadPosition,
    playheadSeekIntent,
    playbackRate,
    useProxyPlaybackForAssets,
    glslPreviewQuality,
    compoundRenderErrors,
  } = useTimelineStore(useShallow(selectCanvasPreviewSlice))
  const assets = useAssetsStore(state => state.assets)

  const previousRasterInputs = rasterSourceInputsRef.current
  if (
    previousRasterInputs.clips !== clips
    || previousRasterInputs.tracks !== tracks
    || previousRasterInputs.transitions !== transitions
    || previousRasterInputs.assets !== assets
  ) {
    rasterSourceRevisionRef.current += 1
    rasterSourceInputsRef.current = { clips, tracks, transitions, assets }
  }

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
    playheadSeekIntent,
    playbackRate,
    useProxyPlaybackForAssets,
    glslPreviewQuality,
    rasterSourceRevision: rasterSourceRevisionRef.current,
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

  const clearPreciseVideoSeek = useCallback((video) => {
    if (!video) return
    const pendingSeeks = preciseVideoSeeksRef.current
    const state = pendingSeeks.get(video)
    if (!state) return
    if (state.frameCallbackId != null && typeof video.cancelVideoFrameCallback === 'function') {
      try { video.cancelVideoFrameCallback(state.frameCallbackId) } catch (_) { /* element may be detached */ }
    }
    if (state.seekedListener) video.removeEventListener('seeked', state.seekedListener)
    pendingSeeks.delete(video)
  }, [])

  // Exact paused stepping cannot trust video.currentTime: Chromium updates
  // that property as soon as a seek is requested, before the newly decoded
  // picture reaches the compositor. Keep a per-element target/token and only
  // let drawFrame proceed after rVFC confirms the requested encoded frame (or
  // after seeked on the compatibility path). Until then the existing canvas
  // remains untouched, so a stale frame can never be committed under the new
  // timeline time.
  const ensurePreciseVideoSeekReady = useCallback((video, targetTime, targetFps, sourceKey = '') => {
    if (!video || video.readyState < 1) return false
    const normalizedTarget = Math.max(0, Number(targetTime) || 0)
    const normalizedFps = Number(targetFps)
    const seekTime = getVideoFrameSeekTime(normalizedTarget, normalizedFps, video.duration)
    const resolvedSourceKey = sourceKey || video.currentSrc || video.src || ''
    const pendingSeeks = preciseVideoSeeksRef.current
    let previous = pendingSeeks.get(video)

    if (previous && previous.sourceKey !== resolvedSourceKey) {
      clearPreciseVideoSeek(video)
      previous = null
    }

    if (
      previous?.settledTargetTime != null
      && isSamePreciseVideoSeekTarget(previous.settledTargetTime, normalizedTarget)
      && previous.settledFrameIndex === getTargetVideoFrameIndex(normalizedTarget, normalizedFps)
      && isSameVideoFrameSeekTime(video.currentTime, previous.settledSeekTime, normalizedFps)
      && !video.seeking
    ) {
      return true
    }

    const nowMs = getNowMs()
    const pendingMatches = previous?.pendingTargetTime != null
      && isSamePreciseVideoSeekTarget(previous.pendingTargetTime, normalizedTarget)
    if (pendingMatches && nowMs - (previous.issuedAt || 0) < PRECISE_SEEK_STALL_MS) {
      return false
    }

    // A cold element that is already settled exactly at the target has a
    // drawable current frame without needing a no-op seek (which some engines
    // do not acknowledge with rVFC while paused).
    if (
      !previous
      && video.readyState >= 2
      && video.videoWidth
      && video.videoHeight
      && !video.seeking
      && (isSameVideoFrameSeekTime(video.currentTime, seekTime, normalizedFps)
        || (video.currentTime === 0 && getTargetVideoFrameIndex(normalizedTarget, normalizedFps) === 0))
    ) {
      pendingSeeks.set(video, {
        sourceKey: resolvedSourceKey,
        pendingTargetTime: null,
        settledTargetTime: normalizedTarget,
        settledSeekTime: video.currentTime,
        settledFrameIndex: getTargetVideoFrameIndex(normalizedTarget, normalizedFps),
        presentedMediaTime: Number(video.currentTime) || 0,
        issuedAt: nowMs,
      })
      return true
    }

    const settledTargetIsStillPresented = previous?.settledTargetTime != null
      && !video.seeking
      && isSameVideoFrameSeekTime(video.currentTime, previous.settledSeekTime, normalizedFps)
      && previous.settledFrameIndex === getTargetVideoFrameIndex(normalizedTarget, normalizedFps)
    if (!shouldIssuePreciseVideoSeek({
      targetTime: normalizedTarget,
      pendingTargetTime: pendingMatches ? previous.pendingTargetTime : null,
      settledTargetTime: settledTargetIsStillPresented ? previous.settledTargetTime : null,
    }) && !pendingMatches) {
      return false
    }

    if (previous) clearPreciseVideoSeek(video)
    const requestId = ++preciseSeekSerialRef.current
    const targetFrameIndex = getTargetVideoFrameIndex(normalizedTarget, normalizedFps)
    const request = {
      sourceKey: resolvedSourceKey,
      requestId,
      issuedAt: nowMs,
      pendingTargetTime: normalizedTarget,
      pendingFrameIndex: targetFrameIndex,
      settledTargetTime: previous?.settledTargetTime ?? null,
      settledSeekTime: previous?.settledSeekTime ?? null,
      settledFrameIndex: previous?.settledFrameIndex ?? null,
      presentedMediaTime: previous?.presentedMediaTime ?? null,
      frameCallbackId: null,
      seekedListener: null,
    }
    pendingSeeks.set(video, request)

    const isCurrentRequest = () => {
      const current = preciseVideoSeeksRef.current.get(video)
      return current?.requestId === requestId
        && current.sourceKey === resolvedSourceKey
        && isSamePreciseVideoSeekTarget(current.pendingTargetTime, normalizedTarget)
    }
    const settle = (mediaTime) => {
      if (!isCurrentRequest()) return
      if (request.frameCallbackId != null && typeof video.cancelVideoFrameCallback === 'function') {
        try { video.cancelVideoFrameCallback(request.frameCallbackId) } catch (_) { /* callback may have fired */ }
      }
      if (request.seekedListener) video.removeEventListener('seeked', request.seekedListener)
      request.frameCallbackId = null
      request.seekedListener = null
      request.pendingTargetTime = null
      request.pendingFrameIndex = null
      request.settledTargetTime = normalizedTarget
      request.settledSeekTime = seekTime
      request.settledFrameIndex = targetFrameIndex
      request.presentedMediaTime = mediaTime != null && Number.isFinite(Number(mediaTime))
        ? Number(mediaTime)
        : (targetFrameIndex / normalizedFps)
      drawFrameRef.current?.()
    }

    const armFrameCallback = () => {
      if (!isCurrentRequest() || typeof video.requestVideoFrameCallback !== 'function') return
      try {
        request.frameCallbackId = video.requestVideoFrameCallback((_now, metadata = {}) => {
          request.frameCallbackId = null
          if (!isCurrentRequest()) return
          if (doesPresentedVideoFrameMatchTarget({
            mediaTime: metadata.mediaTime,
            targetTime: normalizedTarget,
            fps: normalizedFps,
          })) {
            settle(metadata.mediaTime)
            return
          }
          // A callback queued just before currentTime changed can report the old
          // picture. Keep holding the canvas and wait for the seek's real frame.
          armFrameCallback()
        })
      } catch (_) {
        request.frameCallbackId = null
      }
    }

    request.seekedListener = () => {
      if (!isCurrentRequest()) return
      if (typeof video.requestVideoFrameCallback !== 'function') {
        settle(video.currentTime)
        return
      }
      // Seeking to another timestamp inside the same encoded frame may not
      // produce a second presentation callback. The already-confirmed frame
      // is exactly the one this target maps to, so seek completion is enough.
      if (previous?.settledFrameIndex === targetFrameIndex) {
        settle(previous.presentedMediaTime)
      }
    }
    video.addEventListener('seeked', request.seekedListener)
    armFrameCallback()
    try {
      video.currentTime = seekTime
    } catch (_) {
      clearPreciseVideoSeek(video)
      return false
    }
    return false
  }, [clearPreciseVideoSeek])

  const clearAllPreciseVideoSeeks = useCallback(() => {
    for (const video of preciseVideoSeeksRef.current.keys()) clearPreciseVideoSeek(video)
  }, [clearPreciseVideoSeek])

  const clearPlaybackJumpVideos = useCallback(() => {
    for (const record of playbackJumpVideosRef.current.values()) record.landing?.cancel()
    playbackJumpVideosRef.current.clear()
  }, [])

  const ensurePlaybackJumpVideoReady = useCallback((video, targetTime, fps, sourceKey, jump) => {
    const records = playbackJumpVideosRef.current
    let record = records.get(video)
    if (record && (record.token !== jump.token || record.sourceKey !== sourceKey
      || record.targetTime !== targetTime || record.fps !== fps
      || (record.presented && !record.landing.isReady()))) {
      record.landing.cancel()
      records.delete(video)
      record = null
    }
    if (!record) {
      record = { token: jump.token, sourceKey, targetTime, fps, presented: false, landing: null }
      records.set(video, record)
      record.landing = landPlaybackJumpVideo(video, { targetTime, fps,
        onReady: () => {
          if (records.get(video) !== record || getCurrentPlaybackJump(useTimelineStore.getState())?.token !== jump.token) return
          record.presented = true
          scheduleDeferredDraw('playback-jump-picture-ready')
        },
        onError: message => {
          if (records.get(video) === record) useTimelineStore.getState().failPlaybackJump(jump.token, message)
        },
      })
    }
    return record.landing.isReady()
  }, [scheduleDeferredDraw])

  useEffect(() => useTimelineStore.subscribe((next, previous) => {
    if (getCurrentPlaybackJump(next)?.token !== getCurrentPlaybackJump(previous)?.token) {
      clearPlaybackJumpVideos()
      if (getCurrentPlaybackJump(next)) {
        videoCache.pauseAll()
        clearAllPreciseVideoSeeks()
      }
    }
  }), [clearPlaybackJumpVideos, clearAllPreciseVideoSeeks])

  // A queued decoder callback must never outlive its timeline/compound or
  // preempt explicit frame stepping. Subscription invalidation is synchronous,
  // so it also covers a callback arriving before React runs the next effect.
  useEffect(() => useTimelineStore.subscribe((next, previous) => {
    const contextChanged = next.timelineSessionId !== previous.timelineSessionId
      || next.compoundEditContext !== previous.compoundEditContext
      || next.timelineFps !== previous.timelineFps
    if (contextChanged || next.isPlaying || isFrameStepSeekIntentAtTime(next.playheadSeekIntent, next.playheadPosition)) {
      scrubPresentationRef.current.cancelAll()
      if (contextChanged) {
        clearAllPreciseVideoSeeks()
        scrubPreviewStateRef.current.lastPlayhead = next.playheadPosition
        scrubPreviewStateRef.current.activeUntil = 0
      }
    }
  }), [clearAllPreciseVideoSeeks])

  // Phase 4: the live preview composites through the same WebGL2 compositor
  // as export (previewCompositorMode 'gpu', the default; 'canvas' is the 2D
  // fallback / kill switch). One compositor instance per timeline size;
  // WebGL2 init failure or context loss falls back to the 2D path.
  const gpuPreviewRef = useRef({ compositor: null, width: 0, height: 0, failed: false })
  useEffect(() => () => {
    gpuPreviewRef.current.compositor?.dispose()
    gpuPreviewRef.current.compositor = null
  }, [])
  const getGpuStage = useCallback((width, height, mode) => {
    if (mode !== 'gpu' || !width || !height) return null
    const holder = gpuPreviewRef.current
    if (holder.failed) return null
    if (holder.compositor && (holder.width !== width || holder.height !== height)) {
      holder.compositor.dispose()
      holder.compositor = null
    }
    if (holder.compositor?.isContextLost()) {
      // GL calls on a lost context are silently ignored, so dispose is safe;
      // this frame renders 2D and the next frame rebuilds.
      holder.compositor.dispose()
      holder.compositor = null
      return null
    }
    if (!holder.compositor) {
      holder.compositor = createGpuCompositor({ width, height, transparent: false })
      holder.width = width
      holder.height = height
      if (holder.compositor) {
        console.log('[Preview] GPU compositor active (WebGL2). setPreviewCompositorMode("canvas") for the 2D compositor.')
      } else {
        holder.failed = true
        console.warn('[Preview] WebGL2 unavailable; using the 2D compositor.')
      }
    }
    return holder.compositor
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

  // Raster a track-matte source clip (the consumed layer above) into a
  // full-frame canvas with its own animated transform/crop/opacity. Base
  // content only — the matte's own effects/masks stay out of scope.
  // Returns null while a matte video is not yet drawable.
  const rasterMatteClip = useCallback((matteEntry, time, state) => {
    const matteClip = matteEntry?.clip
    if (!matteClip) return null
    const width = state.width
    const height = state.height
    const getAssetById = useAssetsStore.getState().getAssetById
    const buffers = buffersRef.current
    if (!buffers.trackMatteCanvas) {
      buffers.trackMatteCanvas = document.createElement('canvas')
    }
    ensureCanvasSize(buffers.trackMatteCanvas, width, height)
    const matteCtx = buffers.trackMatteCanvas.getContext('2d', { willReadFrequently: true })
    if (!matteCtx) return null
    matteCtx.setTransform(1, 0, 0, 1, 0, 0)
    matteCtx.clearRect(0, 0, width, height)

    const clipTime = time - (matteClip.startTime || 0)
    const matteTransform = applyEffectsToTransform(
      getAnimatedTransform(matteClip, clipTime) || matteClip.transform || {},
      getRenderEffects(matteClip),
      clipTime
    )
    const matteOpacity = typeof matteTransform.opacity === 'number' ? matteTransform.opacity / 100 : 1
    if (matteOpacity <= 0.001) return buffers.trackMatteCanvas

    matteCtx.save()
    matteCtx.globalAlpha = matteOpacity
    matteCtx.globalCompositeOperation = 'source-over'
    matteCtx.filter = 'none'

    if (matteClip.type === 'text' || matteClip.type === 'shape') {
      const isShapeClip = matteClip.type === 'shape'
      const animatedShapeProperties = isShapeClip ? getAnimatedShapeProperties(matteClip, clipTime) : null
      const shapeClip = isShapeClip
        ? { ...matteClip, shapeProperties: animatedShapeProperties || matteClip.shapeProperties }
        : matteClip
      const rect = isShapeClip
        ? getShapeCanvasRect(shapeClip.shapeProperties, width, height)
        : getBaseDrawRect(width, height, width, height)
      applyClipTransform(matteCtx, rect, matteTransform, null)
      applyClipCrop(matteCtx, rect, matteTransform)
      if (isShapeClip) {
        drawShape(matteCtx, { x: 0, y: 0, width: rect.width, height: rect.height }, shapeClip)
      } else {
        drawText(matteCtx, rect, matteClip, 1, clipTime)
      }
      matteCtx.restore()
      return buffers.trackMatteCanvas
    }

    if (matteClip.type === 'video' || matteClip.type === 'image') {
      const clipUrl = resolvePreviewUrl(matteClip, getAssetById, state.useProxyPlaybackForAssets)
      if (!clipUrl) {
        matteCtx.restore()
        return buffers.trackMatteCanvas
      }
      let source = null
      let sourceWidth = width
      let sourceHeight = height
      if (matteClip.type === 'video') {
        const video = videoCache.getVideoElement({ ...matteClip, url: clipUrl })
        if (!video) {
          matteCtx.restore()
          scheduleDeferredDraw('track-matte-video-missing')
          return null
        }
        const targetTime = getClipPlaybackTimingAtTimeline(matteClip, time, 0.01, {
          ...getOpticalFlowContextOptions(matteClip),
        }).time
        const timeDiff = Math.abs((video.currentTime || 0) - targetTime)
        const seekThreshold = state.isPlaying ? 0.16 : 0.025
        if (!state.isPlaybackJump && !state.isScrubbingPreview && !state.isPreciseFrameStep && video.readyState >= 1 && timeDiff > seekThreshold) {
          video.currentTime = targetTime
        }
        if (state.isPlaying && !state.isPlaybackJump && video.readyState >= 2) {
          const baseScale = matteClip.sourceTimeScale || (matteClip.timelineFps && matteClip.sourceFps
            ? matteClip.timelineFps / matteClip.sourceFps
            : 1)
          const speed = Number(matteClip.speed)
          const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
          const playbackSpeed = Math.max(0.01, Math.abs(baseScale * speedScale))
          if (Math.abs((video.playbackRate || 1) - playbackSpeed) > 0.001) {
            video.playbackRate = playbackSpeed
          }
          if (video.paused) video.play().catch(() => {})
        } else if ((!state.isPlaying || state.isPlaybackJump) && !video.paused) {
          video.pause()
        }
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
          matteCtx.restore()
          scheduleDeferredDraw('track-matte-video-frame')
          return null
        }
        source = video
        sourceWidth = video.videoWidth
        sourceHeight = video.videoHeight
      } else {
        const image = getImageForUrl(clipUrl)
        if (!image) {
          matteCtx.restore()
          return imageCacheRef.current.get(clipUrl)?.failed ? buffers.trackMatteCanvas : null
        }
        source = image
        sourceWidth = image.naturalWidth || width
        sourceHeight = image.naturalHeight || height
      }
      const rect = getBaseDrawRect(sourceWidth, sourceHeight, width, height)
      applyClipTransform(matteCtx, rect, matteTransform, null)
      applyClipCrop(matteCtx, rect, matteTransform)
      matteCtx.drawImage(source, 0, 0, rect.width, rect.height)
      matteCtx.restore()
      return buffers.trackMatteCanvas
    }

    matteCtx.restore()
    return buffers.trackMatteCanvas
  }, [getImageForUrl, scheduleDeferredDraw])

  const matteRasterSerialRef = useRef(0)

  const drawVisualClip = useCallback((ctx, entry, time, transitionInfo, state, frameIndex, matteEntry = null) => {
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
      applyEffectsToTransform(getAnimatedTransform(clip, sampleClipTime) || clip.transform || {}, getRenderEffects(clip), sampleClipTime)
    )
    const liveClipTransform = resolveClipTransformAtTime(clipTime)
    const clipTransform = isFullBake
      ? { opacity: liveClipTransform.opacity, blendMode: liveClipTransform.blendMode }
      : liveClipTransform
    const baseOpacity = typeof clipTransform.opacity === 'number' ? clipTransform.opacity / 100 : 1
    const clipOpacity = (transitionStyle?.opacity ?? 1) * baseOpacity
    if (clipOpacity <= 0.001 || transitionStyle?.display === false) return

    // Track matte: raster the consumed layer above; missing matte layer
    // means an empty matte (invisible unless inverted).
    const matteInfo = parseTrackMatte(clip.trackMatte)
    let matteSpec = null
    let matteCanvasForLayer = null
    if (matteInfo) {
      if (!matteEntry) {
        if (!matteInfo.invert) return
      } else {
        const matteCanvas = rasterMatteClip(matteEntry, time, state)
        if (!matteCanvas) return 'unready'
        matteCanvasForLayer = matteCanvas
        matteRasterSerialRef.current += 1
        matteSpec = {
          source: matteCanvas,
          sourceKey: `${clip.id}:trackmatte`,
          sourceVersion: matteRasterSerialRef.current,
          corners: [
            { x: 0, y: 0, u: 0, v: 0, w: 1 },
            { x: width, y: 0, u: 1, v: 0, w: 1 },
            { x: 0, y: height, u: 0, v: 1, w: 1 },
            { x: width, y: height, u: 1, v: 1, w: 1 },
          ],
          channel: matteInfo.channel,
          invert: matteInfo.invert,
        }
      }
    }

    const blendMode = clipTransform?.blendMode || 'normal'
    const blurPx = transitionStyle?.blur ?? (clipTransform?.blur > 0 ? clipTransform.blur : null)
    const adjustmentSettings = normalizeAdjustmentSettings(
      isFullBake ? {} : getRenderAdjustments(clip, clipTime)
    )
    const usesTonalAdjustments = needsAdvancedColorPass(adjustmentSettings)
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

    if ((clip.type === 'text' || clip.type === 'shape' || clip.type === 'captions') && !isFullBake) {
      const isShapeClip = clip.type === 'shape'
      const isCaptionsClip = clip.type === 'captions'
      const getTextShapeFrame = (sampleClipTime) => {
        const animatedShapeProperties = isShapeClip ? getAnimatedShapeProperties(clip, sampleClipTime) : null
        const shapeClip = isShapeClip ? { ...clip, shapeProperties: animatedShapeProperties || clip.shapeProperties } : clip
        const rect = isShapeClip
          ? getShapeCanvasRect(shapeClip.shapeProperties, width, height)
          : getBaseDrawRect(width, height, width, height)
        return { shapeClip, rect }
      }
      const drawNativeClip = (targetCtx, rect, shapeClip, sampleClipTime) => {
        if (isCaptionsClip) {
          drawLiveCaptionsFrame(targetCtx, rect.width, rect.height, clip.captions, sampleClipTime)
        } else if (isShapeClip) {
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
          ...getOpticalFlowContextOptions(clip),
        })
        const targetTime = isCachedRender
          ? clamp(clipTime, 0, Math.max(0, clip.duration - 0.01))
          : transitionPlayback.time
        const timeDiff = Math.abs((video.currentTime || 0) - targetTime)
        const seekDriven = isSeekDrivenPlayback(state, clip)
        const isTransitionClip = !!transitionStyle
        const shouldHoldTransitionFrame = isTransitionClip && transitionPlayback.clamped
        const seekThreshold = state.isPlaying ? (seekDriven ? 0.12 : (shouldHoldTransitionFrame ? 0.025 : 0.16)) : 0.025
        if (!state.isPlaybackJump && !state.isScrubbingPreview && !state.isPreciseFrameStep && video.readyState >= 1 && timeDiff > seekThreshold) {
          video.currentTime = targetTime
        }
        if (state.isPlaying && !state.isPlaybackJump && !seekDriven && video.readyState >= 2 && !shouldHoldTransitionFrame) {
          const baseScale = clip.sourceTimeScale || (clip.timelineFps && clip.sourceFps
            ? clip.timelineFps / clip.sourceFps
            : 1)
          // Speed ramps: drive the element at the instantaneous keyframed
          // speed; the seek-threshold correction above absorbs drift.
          const speed = Number(clip.speed)
          const speedScale = hasSpeedRamp(clip)
            ? getRampedSpeedAtTime(clip, clipTime)
            : (Number.isFinite(speed) && speed > 0 ? speed : 1)
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

      // GPU compositor path: native transforms/masks/effects, mirroring the
      // exporter's GPU block. Masked clips with velocity blur keep the 2D
      // path (same exclusion as export).
      const gpuStage = state.gpuStage
      const gpuMaskInfo = gpuStage
        ? getMaskInfo(clip, getAssetById, time, isCachedRender, !!transitionStyle)
        : null
      if (gpuStage && !(velocityMotionBlur && gpuMaskInfo)) {
        offCtx.restore()
        const rect = getBaseDrawRect(sourceWidth, sourceHeight, width, height)
        // Full bakes carry the transform inside the baked pixels — draw
        // them neutral, same contract as the exporter.
        const sampleTransformFor = (sampleClipTime) => (
          isFullBake ? clipTransform : resolveClipTransformAtTime(sampleClipTime)
        )
        const gpuSamples = []
        for (const sample of motionBlurSamples) {
          const corners = getClipQuadCorners(rect, sampleTransformFor(sample.clipTime), transitionStyle)
          if (corners) {
            gpuSamples.push({
              source: drawSource,
              sourceKey: clip.id,
              sourceVersion: `${clipUrl}|${Number(drawSource.currentTime) || 0}`,
              corners,
              weight: sample.weight,
            })
          }
        }
        if (gpuSamples.length === 0) return

        let gpuMaskSpec = null
        if (gpuMaskInfo?.shapeCanvasLuma || gpuMaskInfo?.url) {
          const maskSource = gpuMaskInfo.shapeCanvasLuma || getImageForUrl(gpuMaskInfo.url)
          if (maskSource) {
            const maskCorners = getClipQuadCorners(rect, sampleTransformFor(clipTime), transitionStyle)
            if (maskCorners) {
              gpuMaskSpec = {
                source: maskSource,
                sourceKey: `${clip.id}:mask`,
                sourceVersion: gpuMaskInfo.shapeSignature || gpuMaskInfo.url,
                corners: maskCorners,
                invert: !!gpuMaskInfo.invertMask,
                blurPx: (!usesTonalAdjustments && blurPx != null)
                  ? blurPx * getApproxTransformScale(clipTransform, transitionStyle)
                  : null,
              }
            }
          }
        }

        const routed = routeGpuLayerColorBlur({
          usesTonalAdjustments,
          hasMask: !!gpuMaskSpec,
          adjustmentSettings,
          colorSettings: clipAdjustmentFilterValue ? adjustmentSettings : null,
          adjustmentBlur: adjustmentSettings.blur > 0 ? adjustmentSettings.blur : 0,
          transformBlur: blurPx != null ? blurPx : 0,
          deviceScale: getApproxTransformScale(clipTransform, transitionStyle),
        })
        gpuStage.drawLayer({
          samples: gpuSamples,
          velocity: velocityMotionBlur ? buildVelocityBlurUniformValues(velocityMotionBlur) : null,
          mask: gpuMaskSpec,
          matte: matteSpec,
          managedPasses: usesManagedEffects
            ? buildManagedEffectGpuPasses(clip.effects, clipTime, frameIndex, width, height)
            : null,
          ...routed,
          opacity: clipOpacity,
          blendMode,
        })
        return
      }

      const rect = getBaseDrawRect(sourceWidth, sourceHeight, width, height)
      // Full bakes carry the transform INSIDE the baked pixels — drawing
      // them with the live transform applies it twice (scale 162% became
      // ~262%, keyframed moves re-animated on top of the baked motion).
      // Legacy mask bakes keep the live transform by contract.
      const getSampleTransform = (sampleClipTime) => (
        isFullBake ? clipTransform : resolveClipTransformAtTime(sampleClipTime)
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

      const maskInfo = getMaskInfo(clip, getAssetById, time, isCachedRender, !!transitionStyle)
      if (maskInfo) {
        const maskCanvas = maskInfo.shapeCanvasAlpha || getProcessedMaskForUrl(maskInfo.url)
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

    // GPU compositor path for clips that rastered through the 2D helpers
    // above (text/shape, and masked+velocity media): the full-frame raster
    // becomes a GPU layer; tonal + managed effects run as native passes.
    if (state.gpuStage) {
      const totalTonalBlur = adjustmentSettings.blur + (blurPx != null ? blurPx : 0)
      state.gpuStage.drawLayer({
        samples: [{
          source: buffers.offCanvas,
          sourceKey: `${clip.id}:2d`,
          // The same timeline frame can be repainted after a paused edit.
          // Include the visual-state revision so the GPU uploads the fresh
          // text/shape/caption raster instead of reusing the old texture.
          sourceVersion: `${frameIndex}:${state.rasterSourceRevision || 0}`,
          corners: [
            { x: 0, y: 0, u: 0, v: 0, w: 1 },
            { x: width, y: 0, u: 1, v: 0, w: 1 },
            { x: 0, y: height, u: 0, v: 1, w: 1 },
            { x: width, y: height, u: 1, v: 1, w: 1 },
          ],
          weight: 1,
        }],
        matte: matteSpec,
        tonalSettings: usesTonalAdjustments ? adjustmentSettings : null,
        blurPx: usesTonalAdjustments && totalTonalBlur > 0 ? totalTonalBlur : null,
        managedPasses: usesManagedEffects
          ? buildManagedEffectGpuPasses(clip.effects, clipTime, frameIndex, width, height)
          : null,
        opacity: clipOpacity,
        blendMode,
      })
      return
    }

    if (matteInfo && matteCanvasForLayer) {
      applyTrackMatteToCanvas(offCtx, matteCanvasForLayer, matteInfo, width, height)
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
  }, [applyAdvancedAdjustmentsToCanvas, getImageForUrl, getProcessedMaskForUrl, rasterMatteClip])

  const applyAdjustmentLayer = useCallback((ctx, clip, time, frameIndex, state) => {
    const width = state.width
    const height = state.height
    const clipTime = time - (clip.startTime || 0)
    const adjustmentSettings = normalizeAdjustmentSettings(
      getRenderAdjustments(clip, clipTime)
    )
    const baseTransform = getAnimatedTransform(clip, clipTime) || clip.transform || {}
    const clipTransform = applyEffectsToTransform(baseTransform, getRenderEffects(clip), clipTime)
    const usesManagedEffects = hasManagedCanvasEffect(clip, clipTime)
    const adjustmentIsActive = hasAdjustmentEffect(adjustmentSettings)
    // A transform-only adjustment layer (e.g. scale 110% to push everything
    // in) still composites: it draws the transformed stage copy back over
    // the stage, matching Premiere-style adjustment-layer transforms.
    const transformIsActive = hasTransformingAdjustmentTransform(clipTransform)
    const glslQualityScale = getGlslPreviewQualityScale(state.glslPreviewQuality)
    if (!adjustmentIsActive && !usesManagedEffects && !transformIsActive) return

    // GPU compositor path: fully native adjustment layer (color/tonal/blur
    // grade of the stage + managed chain), mirroring the exporter.
    if (state.gpuStage) {
      const rect = getBaseDrawRect(width, height, width, height)
      const corners = getClipQuadCorners(rect, clipTransform, null)
      if (!corners) return
      const opacity = typeof clipTransform.opacity === 'number' ? clipTransform.opacity / 100 : 1
      const blendMode = clipTransform.blendMode || 'normal'
      state.gpuStage.drawAdjustment({
        corners,
        colorSettings: adjustmentSettings,
        blurPx: adjustmentSettings.blur > 0 ? adjustmentSettings.blur : null,
        managedPasses: usesManagedEffects
          ? buildManagedEffectGpuPasses(clip.effects, clipTime, frameIndex, width, height)
          : null,
        opacity,
        blendMode,
      })
      return
    }

    const buffers = buffersRef.current
    if (!buffers.adjustmentCanvas) buffers.adjustmentCanvas = document.createElement('canvas')
    ensureCanvasSize(buffers.adjustmentCanvas, width, height)
    const adjustmentCtx = buffers.adjustmentCanvas.getContext('2d', { willReadFrequently: true })
    adjustmentCtx.clearRect(0, 0, width, height)
    adjustmentCtx.drawImage(ctx.canvas, 0, 0)

    let outputCanvas = buffers.adjustmentCanvas
    if (needsAdvancedColorPass(adjustmentSettings)) {
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
    const videoTrackIds = new Set(state.tracks.filter(t => t.type === 'video').map(t => t.id))
    state.clips.forEach((clip) => {
      if (!videoTrackIds.has(clip.trackId) || clip.type !== 'video' || clip.enabled === false) return
      const plan = getClipPreviewPreloadPlan({ ...state, clip, time, lookahead: PRELOAD_LOOKAHEAD })
      if (!plan) return
      const url = resolvePreviewUrl(clip, getAssetById, state.useProxyPlaybackForAssets)
      if (!url) return
      const video = videoCache.getVideoElement({ ...clip, url }, true)
      // Transition handles are already visible outside the nominal clip bounds.
      // Only the compositor may seek those elements. Scrubbing and exact paused
      // stepping likewise own presentation; preloading may load, but never park.
      if (!video || plan.active || state.isScrubbingPreview || state.isPreciseFrameStep || state.isPlaybackJump) return
      const targetTime = getClipPlaybackTimeAtTimeline(
        clip,
        plan.targetTimelineTime,
        0.01,
        { ...getOpticalFlowContextOptions(clip), allowHandles: plan.allowHandles }
      )
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
          const current = getCompoundRenderState(useTimelineStore.getState())
          const currentClip = current.clips.find(item => item.id === clip.id)
          if (!canvasRef.current
            || current.timelineSessionId !== state.timelineSessionId
            || current.compoundEditContext !== state.compoundEditContext
            || !currentClip
            || resolvePreviewUrl(currentClip, getAssetById, current.useProxyPlaybackForAssets) !== url
            || getCurrentPlaybackJump(current)
            || (!current.isPlaying && isFrameStepSeekIntentAtTime(current.playheadSeekIntent, current.playheadPosition))
            || getNowMs() < scrubPreviewStateRef.current.activeUntil
            || scrubPresentationRef.current.hasPending()) return
          // Metadata can arrive after the direction, trims or transition have
          // changed. Recompute both decoder ownership and the source-time target.
          const currentPlan = getClipPreviewPreloadPlan({
            ...current, clip: currentClip, time: current.playheadPosition, lookahead: PRELOAD_LOOKAHEAD,
          })
          if (!currentPlan || currentPlan.active) return
          const currentTargetTime = getClipPlaybackTimeAtTimeline(
            currentClip,
            currentPlan.targetTimelineTime,
            0.01,
            { ...getOpticalFlowContextOptions(currentClip), allowHandles: currentPlan.allowHandles }
          )
          if (Math.abs((video.currentTime || 0) - currentTargetTime) > 0.03) {
            video.currentTime = currentTargetTime
          }
        }, { once: true })
      }
    })
  }, [])

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const drawStartMs = getNowMs()
    const state = {
      ...latestRef.current,
      ...getCompoundRenderState(useTimelineStore.getState()),
    }
    const width = latestRef.current.width || safeWidth
    const height = latestRef.current.height || safeHeight
    const fps = latestRef.current.fps || safeFps
    const time = state.playheadPosition || 0
    const playbackJump = getCurrentPlaybackJump(state)
    state.isPlaybackJump = Boolean(playbackJump)
    if (playbackJumpTokenRef.current !== (playbackJump?.token ?? null)) {
      clearPlaybackJumpVideos()
      playbackJumpTokenRef.current = playbackJump?.token ?? null
      if (playbackJump) videoCache.pauseAll()
    }
    const scrubPresentation = scrubPresentationRef.current
    const previousContext = scrubContextRef.current
    if (previousContext && (previousContext.session !== state.timelineSessionId
      || previousContext.compound !== state.compoundEditContext || previousContext.fps !== fps)) {
      scrubPresentation.cancelAll()
      clearAllPreciseVideoSeeks()
    }
    scrubContextRef.current = { session: state.timelineSessionId, compound: state.compoundEditContext, fps }
    const nowMs = getNowMs()
    const previousDrawTime = lastDrawTimeRef.current
    const loopJumpThreshold = Math.max(0.08, 2 / Math.max(1, fps))
    const loopedBackward = state.isPlaying
      && Number.isFinite(previousDrawTime)
      && time < previousDrawTime - loopJumpThreshold
    lastDrawTimeRef.current = time
    if (!state.isPlaying || playbackJump) {
      loopSeekHoldUntilRef.current = 0
    } else if (loopedBackward) {
      loopSeekHoldUntilRef.current = nowMs + 500
      logCanvasDiag('loop-seek-hold:start', {
        from: Number(previousDrawTime.toFixed(3)),
        to: Number(time.toFixed(3)),
      })
    }
    const loopSeekHoldActive = state.isPlaying && nowMs < loopSeekHoldUntilRef.current
    const isPreciseFrameStep = !state.isPlaying
      && isFrameStepSeekIntentAtTime(state.playheadSeekIntent, time)
    const isScrubbingPreview = !state.isPlaying
      && !isPreciseFrameStep
      && (nowMs < (scrubPreviewStateRef.current.activeUntil || 0) || scrubPresentation.hasPending())
    state.isScrubbingPreview = isScrubbingPreview
    state.isPreciseFrameStep = isPreciseFrameStep
    if (isScrubbingPreview) scrubPresentation.beginPass()
    else scrubPresentation.cancelAll()
    let scrubPainted = false
    try {
      const transitionInfo = state.getTransitionAtTime(time)
      const transitionClipIds = getTransitionClipIds(transitionInfo)
      const frameIndex = Math.floor(time * fps)
      const getAssetById = useAssetsStore.getState().getAssetById
      // Track mattes: pair matted clips with the layer above and hide the
      // consumed matte layers from normal output BEFORE culling, so a
      // full-frame matte source can't obscure the layers beneath it.
      const layeredEntries = getVisualLayerClips(state, time)
      const { matteEntryByClipId, consumedClipIds } = resolveTrackMatteAssignments(layeredEntries)
      const visibleEntries = consumedClipIds.size > 0
        ? layeredEntries.filter((layerEntry) => !consumedClipIds.has(layerEntry.clip?.id))
        : layeredEntries
      const visualClips = cullVisualLayerEntries(visibleEntries, {
        time,
        getAssetById,
        transitionClipIds,
        timelineWidth: width,
        timelineHeight: height,
      })

      preloadVideosAroundTime(state, time)

      // Iterable exact-seek ownership enables cancellation on project changes,
      // but must not keep evicted decoder elements alive during paused editing.
      const cachedVideos = new Set([...videoCache.cache.values()].map((entry) => entry.videoElement))
      for (const video of preciseVideoSeeksRef.current.keys()) {
        if (!cachedVideos.has(video)) clearPreciseVideoSeek(video)
      }

      const videoReadinessEntries = visualClips.map(({ clip }) => ({
        clip,
        allowHandles: transitionClipIds.has(clip?.id),
        role: 'picture',
      }))
      const readinessClipIds = new Set(videoReadinessEntries.map(({ clip }) => clip?.id).filter(Boolean))
      for (const { clip } of visualClips) {
        const matteClip = matteEntryByClipId.get(clip?.id)?.clip
        if (!matteClip?.id || readinessClipIds.has(matteClip.id)) continue
        videoReadinessEntries.push({ clip: matteClip, allowHandles: false, role: 'track-matte' })
        readinessClipIds.add(matteClip.id)
      }

      const shouldGateVideoReadiness = !state.isPlaying
        || playbackJump
        || transitionClipIds.size > 0
        || loopSeekHoldActive
        || visualClips.some(({ clip }) => clip?.type === 'video' && isSeekDrivenPlayback(state, clip))

      let scrubPicturesReady = true
      let jumpPicturesReady = true
      const jumpVideos = new Set()
      if (shouldGateVideoReadiness) {
        for (const { clip, allowHandles, role } of videoReadinessEntries) {
          if (!clip || (clip.type !== 'video' && !isFullBakeFresh(clip))) continue
          const seekDriven = isSeekDrivenPlayback(state, clip)
          const isTransitionClip = role === 'picture' && !!allowHandles
          if (state.isPlaying && !playbackJump && !seekDriven && !isTransitionClip && !loopSeekHoldActive) continue
          const clipUrl = resolvePreviewUrl(clip, getAssetById, state.useProxyPlaybackForAssets)
          if (!clipUrl) {
            if (playbackJump) {
              state.failPlaybackJump(playbackJump.token, `The media for “${clip.name || 'this clip'}” is unavailable.`)
              return
            }
            continue
          }
          const video = videoCache.getVideoElement({ ...clip, url: clipUrl })
          if (!video) {
            scheduleDeferredDraw(seekDriven ? 'seek-video-missing' : 'paused-video-missing')
            if (isScrubbingPreview) { scrubPicturesReady = false; continue }
            return
          }
          const isCachedRender = clip.cacheStatus === 'cached' && clip.cacheUrl && clipUrl === clip.cacheUrl
          const clipTime = time - (clip.startTime || 0)
          const transitionPlayback = getClipPlaybackTimingAtTimeline(clip, time, 0.01, {
            allowHandles,
            ...getOpticalFlowContextOptions(clip),
          })
          const targetTime = isCachedRender
            ? clamp(clipTime, 0, Math.max(0, clip.duration - 0.01))
            : transitionPlayback.time

          if (playbackJump) {
            jumpVideos.add(video)
            const asset = clip.assetId ? getAssetById(clip.assetId) : null
            const targetFps = getPreciseVideoSeekFps({
              usingOpticalFlow: !isCachedRender && transitionPlayback.usingOpticalFlow,
              opticalFlowFps: clip.opticalFlowCache?.targetFps,
              isTimelineCache: isCachedRender, timelineFps: fps, clipSourceFps: clip.sourceFps,
              assetFps: asset?.settings?.fps ?? asset?.fps ?? asset?.metadata?.fps,
            })
            clearPreciseVideoSeek(video)
            if (!ensurePlaybackJumpVideoReady(video, targetTime, targetFps, clipUrl, playbackJump)) jumpPicturesReady = false
            // Start every visible picture/matte concurrently at the frozen
            // destination; no early-layer return may starve a later decoder.
            continue
          }

          if (isScrubbingPreview) {
            const asset = clip.assetId ? getAssetById(clip.assetId) : null
            const targetFps = getPreciseVideoSeekFps({
              usingOpticalFlow: !isCachedRender && transitionPlayback.usingOpticalFlow,
              opticalFlowFps: clip.opticalFlowCache?.targetFps,
              isTimelineCache: isCachedRender,
              timelineFps: fps,
              clipSourceFps: clip.sourceFps,
              assetFps: asset?.settings?.fps ?? asset?.fps ?? asset?.metadata?.fps,
            })
            clearPreciseVideoSeek(video)
            const picture = scrubPresentation.observe(video, { sourceKey: clipUrl, targetTime, fps: targetFps })
            if (!picture.ready) scrubPicturesReady = false
            // Observe every layer and its matte even if an earlier video is still
            // decoding. A ready picture waits for the whole composite to consume it.
            continue
          }

          if (video.readyState < 1) {
            scheduleDeferredDraw(seekDriven ? 'seek-video-metadata' : 'paused-video-metadata')
            return
          }

          if (state.isPreciseFrameStep) {
            const asset = clip.assetId ? getAssetById(clip.assetId) : null
            const targetFps = getPreciseVideoSeekFps({
              usingOpticalFlow: !isCachedRender && transitionPlayback.usingOpticalFlow,
              opticalFlowFps: clip.opticalFlowCache?.targetFps,
              isTimelineCache: isCachedRender,
              timelineFps: fps,
              clipSourceFps: clip.sourceFps,
              assetFps: asset?.settings?.fps ?? asset?.fps ?? asset?.metadata?.fps,
            })
            if (!ensurePreciseVideoSeekReady(video, targetTime, targetFps, clipUrl)) {
              scheduleDeferredDraw(role === 'track-matte'
                ? 'precise-track-matte-video-seek'
                : 'precise-video-seek')
              return
            }
            if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
              scheduleDeferredDraw(role === 'track-matte'
                ? 'precise-track-matte-video-frame'
                : 'precise-video-frame')
              return
            }
            continue
          }

          const readyTolerance = seekDriven ? 0.12 : ((isTransitionClip && state.isPlaying && !loopSeekHoldActive) ? 0.16 : 0.025)
          if (Math.abs((video.currentTime || 0) - targetTime) > readyTolerance) {
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

      if (playbackJump) {
        for (const [video, record] of playbackJumpVideosRef.current) {
          if (!jumpVideos.has(video)) { record.landing.cancel(); playbackJumpVideosRef.current.delete(video) }
        }
        if (!jumpPicturesReady) { scheduleDeferredDraw('playback-jump-pending'); return }
        for (const { clip } of visualClips) {
          if (clip.type !== 'image') continue
          const url = resolvePreviewUrl(clip, getAssetById, state.useProxyPlaybackForAssets)
          if (!url || imageCacheRef.current.get(url)?.failed) {
            state.failPlaybackJump(playbackJump.token, `The image for “${clip.name || 'this clip'}” is unavailable.`)
            return
          }
        }
      }

      if (!scrubPicturesReady) {
        scheduleDeferredDraw('scrub-picture-pending')
        return
      }

      ensureCanvasSize(canvas, width, height)
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) return

      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      ctx.filter = 'none'
      // Keep the visible canvas intact until the staged composite is complete.

      const { stageCanvas, stageCtx } = acquireStageCanvas(canvas, width, height)
      if (!stageCtx) return
      stageCtx.imageSmoothingEnabled = true
      stageCtx.imageSmoothingQuality = 'high'
      stageCtx.setTransform(1, 0, 0, 1, 0, 0)
      stageCtx.globalAlpha = 1
      stageCtx.globalCompositeOperation = 'source-over'
      stageCtx.filter = 'none'
      stageCtx.fillStyle = '#000000'
      stageCtx.fillRect(0, 0, width, height)

      // GPU compositing: clips draw into the WebGL2 stage instead of
      // stageCtx; the finished frame blits into stageCanvas below so all the
      // hold/blit/last-frame logic stays identical.
      const gpuStage = getGpuStage(width, height, state.previewCompositorMode)
      if (gpuStage) gpuStage.beginFrame()
      const clipState = { ...state, width, height, fps, gpuStage }

      let sawUnreadyVisual = false
      for (const entry of visualClips) {
        const { clip } = entry
        if (!clip) continue
        if (clip.type === 'adjustment') {
          applyAdjustmentLayer(stageCtx, clip, time, frameIndex, clipState)
          continue
        }
        if (clip.type === 'video' || clip.type === 'image' || clip.type === 'text' || clip.type === 'shape' || clip.type === 'captions') {
          const status = drawVisualClip(stageCtx, entry, time, transitionInfo, clipState, frameIndex, matteEntryByClipId.get(clip.id) || null)
          if (status === 'unready') sawUnreadyVisual = true
        }
      }

      const fadeOverlay = getFadeOverlayInfo(transitionInfo)
      if (fadeOverlay && fadeOverlay.opacity > 0.001) {
        if (gpuStage) {
          gpuStage.drawFill(fadeOverlay.color, Math.min(1, fadeOverlay.opacity))
        } else {
          stageCtx.save()
          stageCtx.globalAlpha = Math.min(1, fadeOverlay.opacity)
          stageCtx.fillStyle = fadeOverlay.color
          stageCtx.fillRect(0, 0, width, height)
          stageCtx.restore()
        }
      }

      if (gpuStage) {
        gpuStage.present()
        stageCtx.drawImage(gpuStage.canvas, 0, 0)
      }

      // A clip that should be visible couldn't draw yet (cold element at a
      // cut, mid-seek decoder dip, image still decoding). Blitting now would
      // flash the black stage and poison the held frame, so keep the previous
      // frame on screen briefly — the rAF loop retries every tick while
      // playing. Bounded so a permanently broken source degrades to black
      // instead of freezing playback on a stale frame.
      if ((isScrubbingPreview || playbackJump) && sawUnreadyVisual) {
        scheduleDeferredDraw('scrub-composite-pending')
        return
      }
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
      // Commit bookkeeping for the live-capture bridge: which timeline time
      // this frame represents, and a serial so captures can insist on a FRESH
      // commit (post-edit) rather than a stale frame at the same time.
      lastCommittedFrameTimeRef.current = time
      frameCommitSerialRef.current += 1
      scrubPainted = isScrubbingPreview
      // The transport and audio may resume only after the target's complete
      // picture is published. A stale/newer click cannot acknowledge this one.
      if (playbackJump) state.completePlaybackJump(playbackJump.token)
      // Playback fps meter: `presented` counts unique timeline frames committed
      // (a 60Hz commit loop on a 24fps timeline presents 24/s). Counted
      // unconditionally — the badge only displays while playing, and gating on
      // play state here would tie the meter to where that flag happens to live.
      const playbackStats = playbackStatsRef?.current
      if (playbackStats) {
        playbackStats.commits += 1
        // (|| 0) heals a stats object born before drawMs existed (HMR keeps refs).
        playbackStats.drawMs = (playbackStats.drawMs || 0) + (getNowMs() - drawStartMs)
        const frameIndex = Math.floor(time * fps + 0.000001)
        if (frameIndex !== playbackStats.lastFrameIndex) {
          playbackStats.lastFrameIndex = frameIndex
          playbackStats.presented += 1
        }
      }
      if (loopSeekHoldActive) {
        loopSeekHoldUntilRef.current = 0
      }
    } finally {
      // Only a successful final blit may release the decoded pictures and
      // request newer targets. Never retarget a video in its completion draw
      // before the compositor has had a chance to show that picture.
      if (isScrubbingPreview) scrubPresentation.endPass({ painted: scrubPainted })
    }
  }, [applyAdjustmentLayer, clearAllPreciseVideoSeeks, clearPlaybackJumpVideos, clearPreciseVideoSeek, drawVisualClip, ensurePlaybackJumpVideoReady, ensurePreciseVideoSeekReady, preloadVideosAroundTime, safeFps, safeHeight, safeWidth, scheduleDeferredDraw])

  drawFrameRef.current = drawFrame

  // Live-capture bridge: seek the playhead to a target time, drive draws
  // until a frame for exactly that time commits (videos seeked/decoded, GPU
  // composite done), then hand back a copy. This is what gives MCP frame
  // inspection true render parity with the preview. Callers restore the
  // playhead; playback must be paused (seek-and-settle can't chase a moving
  // playhead).
  const captureLiveFrameAt = useCallback(async (targetTime, { timeoutMs = 5000 } = {}) => {
    const timelineState = useTimelineStore.getState()
    if (timelineState.isPlaying) return null
    const parsedTime = Number(targetTime)
    if (!Number.isFinite(parsedTime)) return null

    timelineState.setPlayheadPosition(parsedTime, { snap: true })
    const startSerial = frameCommitSerialRef.current
    const deadline = getNowMs() + Math.max(500, Number(timeoutMs) || 5000)

    while (getNowMs() < deadline) {
      if (useTimelineStore.getState().isPlaying) return null
      // Force strict seek tolerances — scrub mode would accept video frames
      // up to ~a frame away from the target.
      scrubPreviewStateRef.current.activeUntil = 0
      scrubPresentationRef.current.cancelAll()
      drawFrameRef.current?.()
      const currentPlayhead = useTimelineStore.getState().playheadPosition
      const committedTime = lastCommittedFrameTimeRef.current
      if (
        frameCommitSerialRef.current > startSerial
        && Number.isFinite(committedTime)
        && Math.abs(committedTime - currentPlayhead) < 0.0005
        && lastFrameCanvasRef.current
      ) {
        const source = lastFrameCanvasRef.current
        const copy = document.createElement('canvas')
        copy.width = source.width
        copy.height = source.height
        const copyCtx = copy.getContext('2d')
        if (!copyCtx) return null
        copyCtx.drawImage(source, 0, 0)
        return copy
      }
      await new Promise((resolve) => { window.setTimeout(resolve, 60) })
    }
    return null
  }, [])

  useEffect(() => {
    registerLivePreviewCapture(captureLiveFrameAt)
    return () => unregisterLivePreviewCapture(captureLiveFrameAt)
  }, [captureLiveFrameAt])

  // Scopes tap (pull model): expose the committed frame + serial. The getter
  // costs nothing unless something polls it — the render loop stays clean.
  useEffect(() => {
    const getter = () => ({
      canvas: lastFrameCanvasRef.current,
      serial: frameCommitSerialRef.current,
      time: lastCommittedFrameTimeRef.current,
    })
    registerPreviewFrameSource(getter)
    return () => unregisterPreviewFrameSource(getter)
  }, [])

  useEffect(() => {
    const scrubState = scrubPreviewStateRef.current

    if (isPlaying) {
      wasPlayingRef.current = true
      scrubState.activeUntil = 0
      // Native playback advances cached videos outside the exact seek gate.
      // Drop settled targets so the first paused frame-step must establish a
      // fresh decoder presentation instead of trusting pre-playback state.
      clearAllPreciseVideoSeeks()
      if (scrubSettleTimerRef.current) {
        window.clearTimeout(scrubSettleTimerRef.current)
        scrubSettleTimerRef.current = 0
      }
      return
    }

    const currentPlayhead = Number(playheadPosition) || 0
    if (wasPlayingRef.current) {
      // First paused pass after playback: the playhead was not tracked here
      // while playing, so stopping must not be mistaken for a scrub move.
      wasPlayingRef.current = false
      clearAllPreciseVideoSeeks()
      scrubState.lastPlayhead = currentPlayhead
      scrubState.activeUntil = 0
      if (scrubSettleTimerRef.current) {
        window.clearTimeout(scrubSettleTimerRef.current)
        scrubSettleTimerRef.current = 0
      }
      return
    }

    if (isFrameStepSeekIntentAtTime(playheadSeekIntent, currentPlayhead)) {
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
  }, [clearAllPreciseVideoSeeks, isPlaying, playheadPosition, playheadSeekIntent])

  // Timeline dispatches this on scrub mouseup. Exit scrub mode and run the
  // strict-tolerance draw immediately instead of waiting out the settle
  // timer, so the released frame commits as fast as the seek can resolve.
  useEffect(() => {
    const handleScrubEnd = () => {
      scrubPresentationRef.current.cancelAll()
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
    scrubPresentationRef.current.cancelAll()
    clearPlaybackJumpVideos()
    clearAllPreciseVideoSeeks()
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
  }, [clearAllPreciseVideoSeeks, clearPlaybackJumpVideos])

  // LUT library changes (import finishing, boot load completing) alter what
  // runColorPass can resolve — repaint the paused frame so a newly imported
  // LUT shows up without a nudge.
  useEffect(() => {
    const handleLutsChanged = () => {
      if (!useTimelineStore.getState().isPlaying) drawFrameRef.current?.()
    }
    window.addEventListener(LUTS_CHANGED_EVENT, handleLutsChanged)
    return () => window.removeEventListener(LUTS_CHANGED_EVENT, handleLutsChanged)
  }, [])

  useEffect(() => {
    if (!isPlaying) drawFrame()
  }, [
    // A cold image/mask can finish decoding after a paused frame-step has
    // already painted. Its load revision must invalidate that same frame.
    assetRevision,
    assets,
    clips,
    drawFrame,
    isPlaying,
    playheadPosition,
    playheadSeekIntent,
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

    const rawState = useTimelineStore.getState()
    const state = getCompoundRenderState(rawState)
    const time = state.playheadPosition || 0
    const transitionInfo = state.getTransitionAtTime(time)
    const transitionClipIds = getTransitionClipIds(transitionInfo)
    const getAssetById = useAssetsStore.getState().getAssetById
    // Matte-consumed layers are invisible, so exclude them from hit-testing
    // the same way the draw loop does.
    const layeredEntries = getVisualLayerClips(state, time)
    const { consumedClipIds } = resolveTrackMatteAssignments(layeredEntries)
    const visualClips = cullVisualLayerEntries(
      consumedClipIds.size > 0
        ? layeredEntries.filter((layerEntry) => !consumedClipIds.has(layerEntry.clip?.id))
        : layeredEntries,
      {
        time,
        getAssetById,
        transitionClipIds,
        timelineWidth: width,
        timelineHeight: height,
      }
    )

    for (let index = visualClips.length - 1; index >= 0; index -= 1) {
      const clip = visualClips[index]?.clip
      if (!clip || !['video', 'image', 'text', 'shape'].includes(clip.type)) continue

      const clipTime = time - (clip.startTime || 0)
      const transitionStyle = getTransitionStyleForClip(transitionInfo, clip)
      const baseTransform = getAnimatedTransform(clip, clipTime) || clip.transform || {}
      const clipTransform = applyEffectsToTransform(baseTransform, getRenderEffects(clip), clipTime)
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
        // Render-only children never enter selection or transform gestures.
        // Their editable identity in this view is the containing parent.
        return clip.compoundParentId
          ? rawState.clips.find((candidate) => candidate.id === clip.compoundParentId) || null
          : clip
      }
    }

    return null
  }, [safeHeight, safeWidth])

  return (
    <>
    <canvas
      ref={canvasRef}
      data-preview-popout-source="canvas"
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
    {compoundRenderErrors?.length > 0 && <div
      role="alert"
      data-testid="compound-preview-error"
      className="absolute inset-x-2 top-2 z-20 rounded border border-red-400/60 bg-black/90 p-2 text-xs text-red-200"
    >{compoundRenderErrors.join(' ')}</div>}
    </>
  )
}

export default memo(CanvasPreviewRenderer)
