import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import videoCache from '../services/videoCache'
import { getAnimatedAdjustmentSettings, getAnimatedTransform } from '../utils/keyframes'
import {
  applyAdjustmentSettingsToImageData,
  buildCssFilterFromAdjustments,
  hasAdjustmentEffect,
  hasTonalAdjustmentEffect,
  normalizeAdjustmentSettings,
} from '../utils/adjustments'
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
import {
  applyClipCrop,
  applyClipTransform,
  drawText,
  getBaseDrawRect,
} from '../services/exporter'

const PRELOAD_LOOKAHEAD = 2.5
const PLAYBACK_DIAG_KEY = 'comfystudio-playback-diag'
const SCRUB_ACTIVE_WINDOW_MS = 220
const SCRUB_SETTLE_DELAY_MS = SCRUB_ACTIVE_WINDOW_MS + 45
const SCRUB_SEEK_MIN_INTERVAL_MS = 75
const SCRUB_READY_TOLERANCE = 0.18

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

function resolvePreviewUrl(clip, getAssetById, useProxyPlaybackForAssets) {
  if (!clip) return null
  if (clip.type === 'video' && clip.cacheStatus === 'cached' && clip.cacheUrl) {
    return clip.cacheUrl
  }
  const asset = clip.assetId ? getAssetById(clip.assetId) : null
  if (clip.type === 'video') {
    const useProxy = useProxyPlaybackForAssets && !!asset?.proxyUrl && asset?.proxyStatus !== 'failed'
    if (useProxy) return asset.proxyUrl
    const usePlaybackCache = !!asset?.playbackCacheUrl && asset?.playbackCacheStatus !== 'failed'
    return (usePlaybackCache ? asset?.playbackCacheUrl : null) || asset?.url || clip.url || null
  }
  return asset?.url || clip.url || null
}

function getTransitionCanvasStyle(transitionInfo, isVideoA) {
  if (!transitionInfo) {
    return { opacity: isVideoA ? 1 : 0, display: isVideoA }
  }

  const { transition, progress } = transitionInfo
  const type = transition?.type || 'dissolve'
  const zoomAmount = transition?.settings?.zoomAmount ?? 0.1
  const blurAmount = transition?.settings?.blurAmount ?? 8
  const edgeMode = transition?.kind === 'edge'
  const edge = transitionInfo?.edge
  const effectiveIsVideoA = edgeMode ? edge === 'out' : isVideoA

  const base = {
    opacity: 1,
    translateX: 0,
    translateY: 0,
    scale: 1,
    clipInset: null,
    blur: 0,
    display: true,
  }

  if (edgeMode && (type === 'fade-black' || type === 'fade-white')) {
    const opacity = effectiveIsVideoA ? 1 - progress : progress
    return { ...base, opacity }
  }

  if (effectiveIsVideoA) {
    switch (type) {
      case 'dissolve':
        return { ...base, opacity: 1 }
      case 'fade-black':
      case 'fade-white':
        return { ...base, opacity: progress < 0.5 ? 1 - progress * 2 : 0 }
      case 'wipe-left':
        return { ...base, clipInset: { top: 0, right: progress, bottom: 0, left: 0 } }
      case 'wipe-right':
        return { ...base, clipInset: { top: 0, right: 0, bottom: 0, left: progress } }
      case 'wipe-up':
        return { ...base, clipInset: { top: 0, right: 0, bottom: progress, left: 0 } }
      case 'wipe-down':
        return { ...base, clipInset: { top: progress, right: 0, bottom: 0, left: 0 } }
      case 'slide-left':
        return { ...base, translateX: -progress }
      case 'slide-right':
        return { ...base, translateX: progress }
      case 'slide-up':
        return { ...base, translateY: -progress }
      case 'slide-down':
        return { ...base, translateY: progress }
      case 'zoom-in':
        return { ...base, scale: 1 + progress * zoomAmount, opacity: 1 - progress }
      case 'zoom-out':
        return { ...base, scale: 1 - progress * zoomAmount, opacity: 1 - progress }
      case 'blur':
        return { ...base, blur: progress * blurAmount, opacity: 1 - progress }
      default:
        return { ...base, opacity: 1 - progress }
    }
  }

  switch (type) {
    case 'dissolve':
      return { ...base, opacity: progress }
    case 'fade-black':
    case 'fade-white':
      return { ...base, opacity: progress > 0.5 ? (progress - 0.5) * 2 : 0 }
    case 'wipe-left':
      return { ...base, clipInset: { top: 0, right: 0, bottom: 0, left: 1 - progress } }
    case 'wipe-right':
      return { ...base, clipInset: { top: 0, right: 1 - progress, bottom: 0, left: 0 } }
    case 'wipe-up':
      return { ...base, clipInset: { top: 1 - progress, right: 0, bottom: 0, left: 0 } }
    case 'wipe-down':
      return { ...base, clipInset: { top: 0, right: 0, bottom: 1 - progress, left: 0 } }
    case 'slide-left':
      return { ...base, translateX: 1 - progress }
    case 'slide-right':
      return { ...base, translateX: -(1 - progress) }
    case 'slide-up':
      return { ...base, translateY: 1 - progress }
    case 'slide-down':
      return { ...base, translateY: -(1 - progress) }
    case 'zoom-in':
      return { ...base, scale: 1 - zoomAmount + progress * zoomAmount, opacity: progress }
    case 'zoom-out':
      return { ...base, scale: 1 + zoomAmount - progress * zoomAmount, opacity: progress }
    case 'blur':
      return { ...base, blur: (1 - progress) * blurAmount, opacity: progress }
    default:
      return { ...base, opacity: progress }
  }
}

function getFadeOverlayOpacity(transitionInfo) {
  if (!transitionInfo) return null
  const type = transitionInfo.transition?.type
  if (type !== 'fade-black' && type !== 'fade-white') return null
  const progress = transitionInfo.progress ?? 0
  if (transitionInfo.transition?.kind === 'edge') return null
  return progress < 0.5 ? progress * 2 : (1 - progress) * 2
}

function applyTransitionClip(ctx, rect, transitionStyle) {
  if (!transitionStyle?.clipInset) return
  const { top, right, bottom, left } = transitionStyle.clipInset
  const insetTop = rect.height * top
  const insetRight = rect.width * right
  const insetBottom = rect.height * bottom
  const insetLeft = rect.width * left
  ctx.beginPath()
  ctx.rect(insetLeft, insetTop, rect.width - insetLeft - insetRight, rect.height - insetTop - insetBottom)
  ctx.clip()
}

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

function getTransitionStyleForClip(transitionInfo, clip) {
  if (!transitionInfo || !clip) return null
  if (transitionInfo.transition?.kind === 'edge') {
    if (transitionInfo.clip?.id !== clip.id) return null
    return getTransitionCanvasStyle(transitionInfo, transitionInfo.edge === 'out')
  }
  if (transitionInfo.clipA?.id === clip.id) return getTransitionCanvasStyle(transitionInfo, true)
  if (transitionInfo.clipB?.id === clip.id) return getTransitionCanvasStyle(transitionInfo, false)
  return null
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
  const scrubSeekThrottleRef = useRef(new Map())
  const hasPaintedFrameRef = useRef(false)
  const lastPreloadTimeRef = useRef(0)
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

  const applyAdvancedAdjustmentsToCanvas = useCallback((sourceCanvas, settings, width, height, extraBlurPx = null) => {
    const buffers = buffersRef.current
    if (!buffers.processedCanvas) {
      buffers.processedCanvas = document.createElement('canvas')
      buffers.adjustmentCanvas = document.createElement('canvas')
    }
    ensureCanvasSize(buffers.processedCanvas, width, height)
    ensureCanvasSize(buffers.adjustmentCanvas, width, height)
    const processedCtx = buffers.processedCanvas.getContext('2d', { willReadFrequently: true })
    const adjustmentCtx = buffers.adjustmentCanvas.getContext('2d')
    processedCtx.clearRect(0, 0, width, height)
    processedCtx.filter = 'none'
    processedCtx.globalAlpha = 1
    processedCtx.globalCompositeOperation = 'source-over'
    processedCtx.drawImage(sourceCanvas, 0, 0)

    const normalizedSettings = normalizeAdjustmentSettings(settings)
    const frameData = processedCtx.getImageData(0, 0, width, height)
    applyAdjustmentSettingsToImageData(frameData, normalizedSettings)
    processedCtx.putImageData(frameData, 0, 0)

    const totalBlur = Math.max(0, normalizedSettings.blur + (Number(extraBlurPx) || 0))
    if (totalBlur > 0) {
      adjustmentCtx.clearRect(0, 0, width, height)
      adjustmentCtx.save()
      adjustmentCtx.filter = `blur(${totalBlur}px)`
      adjustmentCtx.drawImage(buffers.processedCanvas, 0, 0)
      adjustmentCtx.restore()
      return buffers.adjustmentCanvas
    }

    return buffers.processedCanvas
  }, [])

  const drawVisualClip = useCallback((ctx, entry, time, transitionInfo, state, frameIndex) => {
    const { clip } = entry
    const width = state.width
    const height = state.height
    const getAssetById = useAssetsStore.getState().getAssetById
    const clipTime = time - (clip.startTime || 0)
    const transitionStyle = getTransitionStyleForClip(transitionInfo, clip)
    const baseTransform = getAnimatedTransform(clip, clipTime) || clip.transform || {}
    const clipTransform = applyEffectsToTransform(baseTransform, clip.effects, clipTime)
    const baseOpacity = typeof clipTransform.opacity === 'number' ? clipTransform.opacity / 100 : 1
    const clipOpacity = (transitionStyle?.opacity ?? 1) * baseOpacity
    if (clipOpacity <= 0.001 || transitionStyle?.display === false) return

    const blendMode = clipTransform?.blendMode || 'normal'
    const blurPx = transitionStyle?.blur ?? (clipTransform?.blur > 0 ? clipTransform.blur : null)
    const adjustmentSettings = normalizeAdjustmentSettings(
      getAnimatedAdjustmentSettings(clip, clipTime) || clip.adjustments || {}
    )
    const usesTonalAdjustments = hasTonalAdjustmentEffect(adjustmentSettings)
    const adjustmentFilter = buildCssFilterFromAdjustments(adjustmentSettings)
    const clipAdjustmentFilterValue = adjustmentFilter !== 'none' ? adjustmentFilter : null
    const usesManagedEffects = hasManagedCanvasEffect(clip, clipTime)
    const glslQualityScale = getGlslPreviewQualityScale(state.glslPreviewQuality)

    const buffers = buffersRef.current
    if (!buffers.offCanvas) {
      buffers.offCanvas = document.createElement('canvas')
      buffers.maskCanvas = document.createElement('canvas')
    }
    ensureCanvasSize(buffers.offCanvas, width, height)
    ensureCanvasSize(buffers.maskCanvas, width, height)
    const offCtx = buffers.offCanvas.getContext('2d', { willReadFrequently: usesTonalAdjustments || usesManagedEffects })
    const maskCtx = buffers.maskCanvas.getContext('2d', { willReadFrequently: true })
    offCtx.clearRect(0, 0, width, height)
    offCtx.save()
    offCtx.globalAlpha = 1
    offCtx.globalCompositeOperation = 'source-over'
    const filterParts = []
    if (!usesTonalAdjustments && clipAdjustmentFilterValue) filterParts.push(clipAdjustmentFilterValue)
    if (blurPx != null) filterParts.push(`blur(${blurPx}px)`)
    offCtx.filter = filterParts.length > 0 ? filterParts.join(' ') : 'none'

    let rect = getBaseDrawRect(width, height, width, height)
    if (clip.type === 'text') {
      applyClipTransform(offCtx, rect, clipTransform, transitionStyle)
      applyClipCrop(offCtx, rect, clipTransform)
      applyTransitionClip(offCtx, rect, transitionStyle)
      drawText(offCtx, rect, clip, 1)
      offCtx.restore()
    } else {
      const clipUrl = resolvePreviewUrl(clip, getAssetById, state.useProxyPlaybackForAssets)
      if (!clipUrl) {
        offCtx.restore()
        return
      }

      let drawSource = null
      let sourceWidth = width
      let sourceHeight = height
      const isCachedRender = clip.type === 'video' && clip.cacheStatus === 'cached' && clip.cacheUrl && clipUrl === clip.cacheUrl
      if (clip.type === 'video') {
        const video = videoCache.getVideoElement({ ...clip, url: clipUrl })
        if (!video) {
          offCtx.restore()
          return
        }
        const targetTime = isCachedRender ? clamp(clipTime, 0, Math.max(0, clip.duration - 0.01)) : getClipPlaybackTimeAtTimeline(clip, time)
        const timeDiff = Math.abs((video.currentTime || 0) - targetTime)
        const seekDriven = isSeekDrivenPlayback(state, clip)
        const seekThreshold = state.isScrubbingPreview
          ? SCRUB_READY_TOLERANCE
          : (state.isPlaying ? (seekDriven ? 0.12 : 0.16) : 0.025)
        if (!state.isScrubbingPreview && video.readyState >= 1 && timeDiff > seekThreshold) {
          video.currentTime = targetTime
        }
        if (state.isPlaying && !seekDriven && video.readyState >= 2) {
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
          return
        }
        sourceWidth = video.videoWidth || width
        sourceHeight = video.videoHeight || height
        drawSource = video
      } else if (clip.type === 'image') {
        const image = getImageForUrl(clipUrl)
        if (!image) {
          offCtx.restore()
          return
        }
        sourceWidth = image.naturalWidth || width
        sourceHeight = image.naturalHeight || height
        drawSource = image
      }

      if (!drawSource) {
        offCtx.restore()
        return
      }

      rect = getBaseDrawRect(sourceWidth, sourceHeight, width, height)
      applyClipTransform(offCtx, rect, clipTransform, transitionStyle)
      applyClipCrop(offCtx, rect, clipTransform)
      applyTransitionClip(offCtx, rect, transitionStyle)
      offCtx.drawImage(drawSource, 0, 0, rect.width, rect.height)
      offCtx.restore()

      const maskInfo = getMaskInfo(clip, getAssetById, time, isCachedRender)
      if (maskInfo) {
        const maskCanvas = getProcessedMaskForUrl(maskInfo.url)
        if (maskCanvas) {
          maskCtx.clearRect(0, 0, width, height)
          maskCtx.save()
          maskCtx.filter = blurPx != null ? `blur(${blurPx}px)` : 'none'
          applyClipTransform(maskCtx, rect, clipTransform, transitionStyle)
          applyClipCrop(maskCtx, rect, clipTransform)
          applyTransitionClip(maskCtx, rect, transitionStyle)
          maskCtx.drawImage(maskCanvas, 0, 0, rect.width, rect.height)
          maskCtx.restore()

          offCtx.save()
          offCtx.globalCompositeOperation = maskInfo.invertMask ? 'destination-out' : 'destination-in'
          offCtx.drawImage(buffers.maskCanvas, 0, 0)
          offCtx.restore()
        }
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
    applyClipTransform(ctx, rect, clipTransform, null)
    applyClipCrop(ctx, rect, clipTransform)
    ctx.drawImage(outputCanvas, 0, 0, rect.width, rect.height)
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
      if (!video || video.readyState < 1 || isActive) return
      const targetTimelineTime = isForward ? clipStart : clipEnd
      const targetTime = getClipPlaybackTimeAtTimeline(clip, targetTimelineTime)
      if (Math.abs((video.currentTime || 0) - targetTime) > 0.03) {
        video.currentTime = targetTime
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
    const isScrubbingPreview = !state.isPlaying
      && nowMs < (scrubPreviewStateRef.current.activeUntil || 0)
    state.isScrubbingPreview = isScrubbingPreview
    const transitionInfo = state.getTransitionAtTime(time)
    const frameIndex = Math.floor(time * fps)
    const getAssetById = useAssetsStore.getState().getAssetById
    const visualClips = cullVisualLayerEntries(getVisualLayerClips(state, time), {
      time,
      getAssetById,
      transitionClipIds: getTransitionClipIds(transitionInfo),
      timelineWidth: width,
      timelineHeight: height,
    })

    preloadVideosAroundTime(state, time)

    const shouldGateVideoReadiness = !state.isPlaying
      || visualClips.some(({ clip }) => clip?.type === 'video' && isSeekDrivenPlayback(state, clip))

    if (shouldGateVideoReadiness) {
      for (const { clip } of visualClips) {
        if (!clip || clip.type !== 'video') continue
        const seekDriven = isSeekDrivenPlayback(state, clip)
        if (state.isPlaying && !seekDriven) continue
        const clipUrl = resolvePreviewUrl(clip, getAssetById, state.useProxyPlaybackForAssets)
        if (!clipUrl) continue
        const video = videoCache.getVideoElement({ ...clip, url: clipUrl })
        if (!video) {
          scheduleDeferredDraw(seekDriven ? 'seek-video-missing' : 'paused-video-missing')
          return
        }
        const isCachedRender = clip.cacheStatus === 'cached' && clip.cacheUrl && clipUrl === clip.cacheUrl
        const clipTime = time - (clip.startTime || 0)
        const targetTime = isCachedRender
          ? clamp(clipTime, 0, Math.max(0, clip.duration - 0.01))
          : getClipPlaybackTimeAtTimeline(clip, time)

        if (video.readyState < 1) {
          scheduleDeferredDraw(seekDriven ? 'seek-video-metadata' : 'paused-video-metadata')
          return
        }

        const readyTolerance = state.isScrubbingPreview
          ? SCRUB_READY_TOLERANCE
          : (seekDriven ? 0.12 : 0.025)
        if (Math.abs((video.currentTime || 0) - targetTime) > readyTolerance) {
          if (state.isScrubbingPreview) {
            const throttleKey = clip.id || clip.assetId || clipUrl
            const lastSeekAt = scrubSeekThrottleRef.current.get(throttleKey) || 0
            if (nowMs - lastSeekAt >= SCRUB_SEEK_MIN_INTERVAL_MS) {
              video.currentTime = targetTime
              scrubSeekThrottleRef.current.set(throttleKey, nowMs)
            }
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

    for (const entry of visualClips) {
      const { clip } = entry
      if (!clip) continue
      if (clip.type === 'adjustment') {
        applyAdjustmentLayer(stageCtx, clip, time, frameIndex, { ...state, width, height, fps })
        continue
      }
      if (clip.type === 'video' || clip.type === 'image' || clip.type === 'text') {
        drawVisualClip(stageCtx, entry, time, transitionInfo, { ...state, width, height, fps }, frameIndex)
      }
    }

    const overlayOpacity = getFadeOverlayOpacity(transitionInfo)
    if (overlayOpacity !== null) {
      const type = transitionInfo?.transition?.type
      stageCtx.save()
      stageCtx.globalAlpha = overlayOpacity
      stageCtx.fillStyle = type === 'fade-white' ? '#FFFFFF' : '#000000'
      stageCtx.fillRect(0, 0, width, height)
      stageCtx.restore()
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
  }, [applyAdjustmentLayer, drawVisualClip, preloadVideosAroundTime, safeFps, safeHeight, safeWidth, scheduleDeferredDraw])

  drawFrameRef.current = drawFrame

  useEffect(() => {
    const currentPlayhead = Number(playheadPosition) || 0
    const scrubState = scrubPreviewStateRef.current

    if (isPlaying) {
      scrubState.lastPlayhead = currentPlayhead
      scrubState.activeUntil = 0
      scrubSeekThrottleRef.current.clear()
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

  const activeSelectableClip = useMemo(() => {
    const state = useTimelineStore.getState()
    const visualClips = getVisualLayerClips(state, playheadPosition)
    for (let index = visualClips.length - 1; index >= 0; index -= 1) {
      const clip = visualClips[index]?.clip
      if (clip && (clip.type === 'video' || clip.type === 'image' || clip.type === 'text')) {
        return clip
      }
    }
    return null
  }, [clips, tracks, playheadPosition])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full bg-black"
      width={safeWidth}
      height={safeHeight}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (activeSelectableClip && typeof onClipPointerDown === 'function') {
          onClipPointerDown(activeSelectableClip, event)
        }
      }}
      onDoubleClick={(event) => {
        if (activeSelectableClip?.type === 'text' && typeof onClipDoubleClick === 'function') {
          onClipDoubleClick(activeSelectableClip, event)
        }
      }}
      style={{
        display: 'block',
      }}
    />
  )
}

export default memo(CanvasPreviewRenderer)
