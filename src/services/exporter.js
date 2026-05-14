import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import { getAnimatedTransform, getAnimatedAdjustmentSettings } from '../utils/keyframes'
import {
  applyAdjustmentSettingsToImageData,
  buildCssFilterFromAdjustments,
  hasAdjustmentEffect,
  hasTonalAdjustmentEffect,
  normalizeAdjustmentSettings,
} from '../utils/adjustments'
import { getAudioClipFadeGain, getAudioClipFadeValues } from '../utils/audioClipFades'
import { getAudioClipLinearGain, normalizeAudioClipGainDb } from '../utils/audioClipGain'
import {
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
import { applyGlslEffectsToCanvas, hasGlslEffect } from '../utils/glslEffects'
import { cullVisualLayerEntries, getTransitionClipIds } from '../utils/layerCompositing'

const DEFAULT_SAMPLE_RATE = 44100
const AUDIO_FETCH_TIMEOUT_MS = 15000
const AUDIO_DECODE_TIMEOUT_MS = 30000
const AUDIO_MIX_TIMEOUT_MS = 120000
const EXPORT_VIDEO_CACHE_LIMIT = 4
const EXPORT_IMAGE_CACHE_LIMIT = 12
const EXPORT_SEEK_TIMEOUT_MS = 5000

const EXPORT_STATUS = {
  preparing: 'Preparing export...',
  rendering: 'Rendering frames...',
  audio: 'Mixing audio...',
  encoding: 'Encoding video...',
  done: 'Export complete',
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const getLocalStorageFlag = (key) => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

const withTimeout = (promise, timeoutMs, label = 'Operation') => {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs))
  ])
}

const fetchWithTimeout = async (url, timeoutMs) => {
  if (typeof AbortController === 'undefined') {
    return await withTimeout(fetch(url), timeoutMs, 'Audio fetch')
  }
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timeoutId)
  }
}

const waitForEvent = (target, eventName) => new Promise((resolve, reject) => {
  const onSuccess = () => {
    cleanup()
    resolve()
  }
  const onError = (err) => {
    cleanup()
    reject(err)
  }
  const cleanup = () => {
    target.removeEventListener(eventName, onSuccess)
    target.removeEventListener('error', onError)
  }
  target.addEventListener(eventName, onSuccess, { once: true })
  target.addEventListener('error', onError, { once: true })
})

const getMediaErrorMessage = (err) => {
  if (!err) return 'Unknown media error'
  if (typeof err === 'string') return err
  if (err?.message) return err.message
  const targetError = err?.target?.error
  if (targetError?.message) return targetError.message
  if (targetError?.code != null) return `Media error code ${targetError.code}`
  if (err?.type) return `Media event: ${err.type}`
  return String(err)
}

/** Yield to the event loop so the UI can repaint and avoid the window going black during export */
const yieldToMain = () => new Promise(resolve => {
  const hiddenDocument = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  if (hiddenDocument || typeof requestAnimationFrame !== 'function') {
    setTimeout(resolve, 0)
    return
  }
  requestAnimationFrame(resolve)
})

/** Stronger yield: give the event loop a full time slice (helps prevent renderer crash under heavy export) */
const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0))

const isElectron = () => typeof window !== 'undefined' && window.electronAPI != null

/** Resolve asset to a stable file:// URL for export when in Electron to avoid blob URL invalidation / OOM */
async function getExportAssetUrl(asset, projectHandle) {
  if (!asset?.url) return null
  if (isElectron() && projectHandle && asset.path) {
    try {
      const filePath = await window.electronAPI.pathJoin(projectHandle, asset.path)
      return await window.electronAPI.getFileUrlDirect(filePath)
    } catch (e) {
      console.warn('Export: could not resolve file URL for asset, using blob:', asset.name, e)
    }
  }
  return asset.url
}

async function getExportProxyUrl(asset, projectHandle) {
  if (!asset || asset.type !== 'video') return null
  if (asset.proxyStatus !== 'ready' || !asset.proxyPath) return null
  if (isElectron() && projectHandle && asset.proxyPath) {
    try {
      const filePath = await window.electronAPI.pathJoin(projectHandle, asset.proxyPath)
      return await window.electronAPI.getFileUrlDirect(filePath)
    } catch (e) {
      console.warn('Export: could not resolve proxy URL, using original:', asset.name, e)
    }
  }
  return asset.proxyUrl || null
}

const loadImage = async (url) => {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = url
  if (img.complete && img.naturalWidth > 0) {
    return img
  }
  await waitForEvent(img, 'load')
  return img
}

const loadVideo = async (url) => {
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.src = url
  video.muted = true
  video.playsInline = true
  video.preload = 'metadata'
  
  // Add timeout to prevent infinite hang if video never loads
  const loadPromise = waitForEvent(video, 'loadedmetadata')
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error(`Video load timeout for: ${url}`)), 30000)
  )
  
  await Promise.race([loadPromise, timeoutPromise])
  console.log(`Loaded video: ${url}, duration: ${video.duration}s`)
  return video
}

// Diagnostics for the cut-boundary stale-frame race. Enable by running the
// app with `localStorage.setItem('exportSeekDebug', '1')` in DevTools; on
// reload, every seekVideo call logs which path it took and whether the
// decoder actually confirmed a fresh presentation. Rate-limited so we don't
// drown the console on large exports.
const SEEK_DEBUG_ENABLED = (() => {
  return getLocalStorageFlag('exportSeekDebug')
})()
let seekDebugLogCount = 0
const SEEK_DEBUG_LIMIT = 120
const seekDebug = (...args) => {
  if (!SEEK_DEBUG_ENABLED) return
  if (seekDebugLogCount >= SEEK_DEBUG_LIMIT) return
  seekDebugLogCount += 1
  console.log('[Export:seek]', ...args)
  if (seekDebugLogCount === SEEK_DEBUG_LIMIT) {
    console.log('[Export:seek] further seek logs suppressed (limit reached)')
  }
}

/**
 * Force the <video> element to present a fresh frame to the compositor and
 * resolve only after the rVFC callback fires (or a conservative timeout).
 *
 * Why this is the real fix for the cut-boundary flash:
 *   - drawImage(video) reads from the compositor's currently-presented frame.
 *   - 'seeked' fires on demux completion, NOT on presentation.
 *   - play()'s returned promise resolves on the play-state transition, NOT
 *     on presentation. If you call pause() immediately after awaiting it,
 *     Chromium often never commits a new frame at all, because the
 *     decoder/compositor pipeline was torn down before producing one.
 *   - rVFC is the only public API that actually fires on a genuine
 *     presentation event. Staying in the playing state while we await it
 *     guarantees the pipeline completes at least one present.
 *
 * Sequence:
 *   1. Register an rVFC callback that records the first real presentation.
 *   2. Call play() and await its state-transition promise.
 *   3. Wait up to `maxPlayMs` in the playing state for the rVFC to fire.
 *   4. Pause. (Always — even on timeout.)
 *   5. Return whether a presentation was confirmed.
 *
 * If rVFC is unavailable, we sleep `maxPlayMs` while playing as a
 * best-effort. That's worse than rVFC but strictly better than pausing
 * immediately.
 */
const presentFreshFrame = async (video, { maxPlayMs = 600, expectedTime = null } = {}) => {
  const hasRVFC = typeof video.requestVideoFrameCallback === 'function'
  let confirmed = false
  let rvfcHandle = null
  const expected = Number(expectedTime)
  const shouldConfirmMediaTime = Number.isFinite(expected)
  const mediaTimeTolerance = Math.max(0.08, (1 / 24) * 2)

  const presentedPromise = hasRVFC
    ? new Promise((resolve) => {
        let done = false
        const callback = (_now, metadata = {}) => {
          if (done) return
          const mediaTime = Number(metadata.mediaTime)
          const matchesExpected = !shouldConfirmMediaTime
            || (Number.isFinite(mediaTime) && Math.abs(mediaTime - expected) <= mediaTimeTolerance)
          if (matchesExpected) {
            done = true
            confirmed = true
            resolve()
            return
          }
          try {
            rvfcHandle = video.requestVideoFrameCallback(callback)
          } catch {
            done = true
            resolve()
          }
        }
        try {
          rvfcHandle = video.requestVideoFrameCallback(callback)
        } catch {
          done = true
          resolve()
        }
        setTimeout(() => {
          if (done) return
          done = true
          resolve()
        }, maxPlayMs)
      })
    : new Promise((resolve) => setTimeout(resolve, maxPlayMs))

  try {
    video.muted = true
    const playPromise = video.play()
    if (playPromise) {
      await Promise.race([
        playPromise.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, maxPlayMs)),
      ])
    }
  } catch {
    // If play() outright throws, we still await the timer to give the
    // decoder a chance. Better than returning immediately.
  }

  await presentedPromise

  try {
    video.pause()
  } catch {
    // non-fatal
  }

  if (!confirmed && rvfcHandle != null && typeof video.cancelVideoFrameCallback === 'function') {
    try { video.cancelVideoFrameCallback(rvfcHandle) } catch { /* ignore */ }
  }

  return confirmed
}

// Per-element memory of the last requested source time. A "large seek" —
// meaning a jump that's outside the decoder's natural frame-to-frame
// continuity — is the specific condition that produces the cut-boundary
// stale-frame race, because the decoder has to reset to a new GOP and the
// compositor may still be showing the prior clip's frame by the time
// drawImage reads. Sequential within-clip frames advance by ~1/fps (16–42ms)
// and never hit that race; doing the heavy play+rVFC dance on them would
// just slow exports down without benefit.
const lastSeekTimeByVideo = new WeakMap()
const LARGE_SEEK_THRESHOLD_SEC = 0.3

const seekVideoImpl = async (video, time, fastSeek = true) => {
  const targetTime = clamp(time, 0, video.duration || time)
  const prevTime = lastSeekTimeByVideo.get(video)
  // First seek on this element OR a jump larger than threshold (= cut
  // boundary, or any discontinuity that requires a decoder reset) = we must
  // force-and-confirm a fresh presentation.
  const isLargeSeek = prevTime == null || Math.abs(targetTime - prevTime) > LARGE_SEEK_THRESHOLD_SEC
  lastSeekTimeByVideo.set(video, targetTime)

  if (fastSeek && typeof video.fastSeek === 'function') {
    video.fastSeek(targetTime)
  } else {
    video.currentTime = targetTime
  }

  if (video.seeking) {
    try {
      await Promise.race([
        waitForEvent(video, 'seeked'),
        new Promise((resolve) => setTimeout(resolve, 2000))
      ])
    } catch (err) {
      // Some media elements dispatch transient demux/decode errors while
      // seeking. Keep export running and let the draw step decide whether to
      // skip this frame.
      console.warn('[Export] Seek warning:', getMediaErrorMessage(err))
    }
  }

  if (fastSeek) {
    // Fast path: callers opted into keyframe-accurate seeks, so we don't try
    // to force a presentation. Give the decoder a short settling window.
    await new Promise((resolve) => setTimeout(resolve, 15))
    seekDebug('fastSeek', { targetTime, prevTime })
    return
  }

  if (!isLargeSeek) {
    // Small forward seek on a decoder that already has continuity. No
    // stale-frame risk — the next frame has naturally followed. Keep it
    // fast; the old 20ms settle is fine for this case.
    await new Promise((resolve) => setTimeout(resolve, 20))
    seekDebug('small-seek', { targetTime, prevTime })
    return
  }

  // Large seek: this is the condition that causes the cut-boundary flash.
  // Force and confirm a presentation so drawImage doesn't pull the previous
  // clip's frame out of the compositor buffer.
  const confirmed = await presentFreshFrame(video, { maxPlayMs: 600, expectedTime: targetTime })

  if (!confirmed) {
    seekDebug('large-seek NO rVFC confirm, fallback delay', { targetTime, prevTime, currentTime: video.currentTime })
    // 600ms of playing already happened above — stale frame risk is now
    // very low even without explicit confirmation. Small extra settle for
    // safety.
    await new Promise((resolve) => setTimeout(resolve, 40))
  } else {
    seekDebug('large-seek confirmed', { targetTime, prevTime, currentTime: video.currentTime })
  }
}

const seekVideo = async (video, time, fastSeek = true) => withTimeout(
  seekVideoImpl(video, time, fastSeek),
  EXPORT_SEEK_TIMEOUT_MS,
  'Video seek'
)

const getTransitionCanvasStyle = (transitionInfo, isVideoA) => {
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
        // Keep outgoing clip fully opaque and fade incoming over it.
        // Fading both layers in source-over darkens the midpoint.
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

const getFadeOverlayOpacity = (transitionInfo) => {
  if (!transitionInfo) return null
  
  const { transition, progress } = transitionInfo
  const type = transition?.type
  const edgeMode = transition?.kind === 'edge'
  const edge = transitionInfo?.edge
  
  if (edgeMode && (type === 'fade-black' || type === 'fade-white')) {
    return edge === 'in' ? (1 - progress) : progress
  }
  
  if (type === 'fade-black' || type === 'fade-white') {
    return progress < 0.5 ? progress * 2 : (1 - progress) * 2
  }
  
  return null
}

export const getBaseDrawRect = (assetWidth, assetHeight, canvasWidth, canvasHeight) => {
  if (!assetWidth || !assetHeight) {
    return {
      width: canvasWidth,
      height: canvasHeight,
      x: 0,
      y: 0,
    }
  }
  const scale = Math.min(canvasWidth / assetWidth, canvasHeight / assetHeight)
  const width = assetWidth * scale
  const height = assetHeight * scale
  const x = (canvasWidth - width) / 2
  const y = (canvasHeight - height) / 2
  return { width, height, x, y }
}

export const applyClipTransform = (ctx, rect, transform, transitionStyle) => {
  const {
    positionX = 0,
    positionY = 0,
    scaleX = 100,
    scaleY = 100,
    rotation = 0,
    anchorX = 50,
    anchorY = 50,
    flipH = false,
    flipV = false,
  } = transform || {}
  
  const anchorPxX = rect.width * (anchorX / 100)
  const anchorPxY = rect.height * (anchorY / 100)
  const translateX = rect.x + anchorPxX + positionX + (transitionStyle?.translateX || 0) * rect.width
  const translateY = rect.y + anchorPxY + positionY + (transitionStyle?.translateY || 0) * rect.height
  const scaleFactorX = (scaleX / 100) * (flipH ? -1 : 1) * (transitionStyle?.scale || 1)
  const scaleFactorY = (scaleY / 100) * (flipV ? -1 : 1) * (transitionStyle?.scale || 1)
  
  ctx.translate(translateX, translateY)
  if (rotation) {
    ctx.rotate((rotation * Math.PI) / 180)
  }
  ctx.scale(scaleFactorX, scaleFactorY)
  ctx.translate(-anchorPxX, -anchorPxY)
}

export const applyClipCrop = (ctx, rect, transform) => {
  const cropTop = transform?.cropTop || 0
  const cropBottom = transform?.cropBottom || 0
  const cropLeft = transform?.cropLeft || 0
  const cropRight = transform?.cropRight || 0
  if (cropTop === 0 && cropBottom === 0 && cropLeft === 0 && cropRight === 0) {
    return
  }
  const left = rect.width * (cropLeft / 100)
  const right = rect.width * (cropRight / 100)
  const top = rect.height * (cropTop / 100)
  const bottom = rect.height * (cropBottom / 100)
  ctx.beginPath()
  ctx.rect(left, top, rect.width - left - right, rect.height - top - bottom)
  ctx.clip()
}

const hasManagedPixelOrVignetteEffect = (clip, clipTime) => {
  if (!clip) return false
  const effects = clip.effects || []
  return hasPixelFilterEffect(effects, clipTime)
    || hasGlslEffect(effects)
    || hasVignetteEffect(effects, clipTime)
    || hasLetterboxEffect(effects, clipTime)
}

/**
 * Apply a clip's managed pixel effects (chromatic aberration, film grain) and
 * vignette to an offscreen canvas that already contains the clip content at
 * its final transformed position. Pixel effects run in-place on the canvas's
 * ImageData. Vignette is composited with `source-atop` so it only darkens
 * the clip's rendered pixels, keeping surrounding transparent areas clean.
 */
const applyClipManagedEffectsToOffCanvas = (offCanvas, offCtx, width, height, clip, clipTime, frameIndex, glslQualityScale = 1) => {
  if (!clip) return
  const effects = clip.effects || []
  // Channel shifts, sharpening, grain, and analog damage are ImageData passes.
  // Glow stays separate because it needs canvas blur + screen blending.
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
    const imageData = offCtx.getImageData(0, 0, width, height)
    applyPixelEffectsToImageData(imageData, effects, clipTime, frameIndex)
    offCtx.putImageData(imageData, 0, 0)
  }
  // Glow runs as a canvas pass because blur + screen-blend needs the canvas
  // filter API and globalCompositeOperation.
  if (hasGlowEffect(effects)) {
    applyGlowPassesToCanvas(offCanvas, offCtx, width, height, effects, clipTime)
  }
  if (hasGlslEffect(effects)) {
    applyGlslEffectsToCanvas(offCanvas, offCtx, width, height, effects, clipTime, glslQualityScale)
  }
  const vignetteEffect = getActiveVignetteEffect(effects, clipTime)
  if (vignetteEffect) {
    drawVignetteOverlay(offCtx, width, height, vignetteEffect, clipTime, {
      compositeOperation: 'source-atop',
    })
  }
  const letterboxEffect = getActiveLetterboxEffect(effects, clipTime)
  if (letterboxEffect) {
    drawLetterboxOverlay(offCtx, width, height, letterboxEffect, clipTime, {
      compositeOperation: 'source-atop',
    })
  }
}

const applyTransitionClip = (ctx, rect, transitionStyle) => {
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

export const drawText = (ctx, rect, clip, textScale = 1) => {
  const textProps = clip.textProperties || {}
  const lines = String(textProps.text || '').split('\n')
  const scale = Number.isFinite(textScale) && textScale > 0 ? textScale : 1
  const fontSize = (textProps.fontSize || 48) * scale
  const fontFamily = textProps.fontFamily || 'Inter'
  const fontWeight = textProps.fontWeight || 'normal'
  const fontStyle = textProps.fontStyle || 'normal'
  const lineHeight = (textProps.lineHeight || 1.2) * fontSize
  const textAlign = textProps.textAlign || 'center'
  const verticalAlign = textProps.verticalAlign || 'center'
  const padding = (textProps.backgroundPadding || 20) * scale
  
  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`
  ctx.textAlign = textAlign
  ctx.textBaseline = 'middle'
  
  let baseY = rect.y + rect.height / 2
  if (verticalAlign === 'top') {
    baseY = rect.y + padding + (lineHeight * lines.length) / 2
  } else if (verticalAlign === 'bottom') {
    baseY = rect.y + rect.height - padding - (lineHeight * lines.length) / 2
  }
  
  let baseX = rect.x + rect.width / 2
  if (textAlign === 'left') {
    baseX = rect.x + padding
  } else if (textAlign === 'right') {
    baseX = rect.x + rect.width - padding
  }
  
  if (textProps.shadow) {
    ctx.shadowColor = textProps.shadowColor || 'rgba(0,0,0,0.5)'
    ctx.shadowBlur = (textProps.shadowBlur || 4) * scale
    ctx.shadowOffsetX = (textProps.shadowOffsetX || 2) * scale
    ctx.shadowOffsetY = (textProps.shadowOffsetY || 2) * scale
  } else {
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
  }
  
  if (textProps.backgroundOpacity > 0) {
    ctx.save()
    const totalHeight = lineHeight * lines.length
    const maxLineWidth = Math.max(...lines.map(line => ctx.measureText(line).width), 0)
    const boxWidth = maxLineWidth + padding * 2
    const boxHeight = totalHeight + padding * 2
    let boxX = baseX - boxWidth / 2
    if (textAlign === 'left') {
      boxX = baseX - padding
    } else if (textAlign === 'right') {
      boxX = baseX - boxWidth + padding
    }
    const boxY = baseY - boxHeight / 2
    ctx.fillStyle = textProps.backgroundColor || '#000000'
    ctx.globalAlpha = clamp(textProps.backgroundOpacity, 0, 1)
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight)
    ctx.restore()
  }
  
  ctx.fillStyle = textProps.textColor || '#FFFFFF'
  ctx.globalAlpha = 1
  
  if (textProps.strokeWidth > 0) {
    ctx.lineWidth = textProps.strokeWidth * scale
    ctx.strokeStyle = textProps.strokeColor || '#000000'
  }
  
  lines.forEach((line, index) => {
    const y = baseY + (index - (lines.length - 1) / 2) * lineHeight
    if (textProps.strokeWidth > 0) {
      ctx.strokeText(line, baseX, y)
    }
    ctx.fillText(line, baseX, y)
  })
}

const getMaskFrameInfo = (clip, maskAsset, time) => {
  if (!maskAsset) return null
  const sourceTime = time - clip.startTime + (clip.trimStart || 0)
  const sourceDuration = clip.sourceDuration || maskAsset.settings?.duration || clip.duration
  const progress = sourceDuration > 0 ? clamp(sourceTime / sourceDuration, 0, 1) : 0
  const frames = maskAsset.maskFrames || []
  if (frames.length > 0) {
    const frameIndex = clamp(Math.floor(progress * frames.length), 0, frames.length - 1)
    return frames[frameIndex]?.url || maskAsset.url
  }
  return maskAsset.url
}

export const audioBufferToWav = (buffer) => {
  const numChannels = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const numFrames = buffer.length
  const bytesPerSample = 2
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = numFrames * blockAlign
  const bufferSize = 44 + dataSize
  
  const arrayBuffer = new ArrayBuffer(bufferSize)
  const view = new DataView(arrayBuffer)
  
  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i))
    }
  }
  
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)
  
  let offset = 44
  for (let i = 0; i < numFrames; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const sample = buffer.getChannelData(channel)[i] || 0
      const clipped = clamp(sample, -1, 1)
      view.setInt16(offset, clipped * 0x7fff, true)
      offset += 2
    }
  }
  
  return arrayBuffer
}

const formatFrameNumber = (index) => String(index).padStart(6, '0')


const releaseVideoElement = (video) => {
  if (!video) return
  try { video.pause() } catch { /* ignore */ }
  try { video.removeAttribute('src') } catch { /* ignore */ }
  try { video.load() } catch { /* ignore */ }
}

const touchCacheEntry = (cache, key, value) => {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, value)
  return value
}

const trimVideoCache = (cache, limit) => {
  while (cache.size > limit) {
    const [oldestKey, oldestVideo] = cache.entries().next().value || []
    if (!oldestKey) break
    cache.delete(oldestKey)
    releaseVideoElement(oldestVideo)
  }
}

const trimImageCache = (cache, limit) => {
  while (cache.size > limit) {
    const [oldestKey] = cache.entries().next().value || []
    if (!oldestKey) break
    cache.delete(oldestKey)
  }
}

export const exportTimeline = async (options = {}, onProgress = () => {}) => {
  const timelineState = useTimelineStore.getState()
  const assetsState = useAssetsStore.getState()
  const projectState = useProjectStore.getState()
  
  const {
    fps = 24,
    width = 1920,
    height = 1080,
    rangeStart = 0,
    rangeEnd = timelineState.getTimelineEndTime(),
    format = 'mp4',
    includeAudio = true,
    filename = 'export',
    videoCodec = 'h264',
    audioCodec = 'aac',
    proresProfile = '3',
    useHardwareEncoder = false,
    nvencPreset = 'p5',
    preset = 'medium',
    qualityMode = 'crf',
    crf = 18,
    bitrateKbps = 8000,
    keyframeInterval = null,
    sourceTimelineWidth = width,
    sourceTimelineHeight = height,
    audioBitrateKbps = 192,
    audioSampleRate = DEFAULT_SAMPLE_RATE,
    audioChannels = 2,
    useCachedRenders = true,
    useProxyMedia = false,
    fastSeek = true,
    useDirectFramePipe = false,
    glslQualityScale = 1,
    signal = null,
  } = options
  const throwIfCancelled = () => {
    if (signal?.aborted) {
      throw new Error('Export cancelled')
    }
  }
  
  const totalDuration = Math.max(0, rangeEnd - rangeStart)
  const totalFrames = Math.ceil(totalDuration * fps)
  const transformScaleX = width / Math.max(1, Number(sourceTimelineWidth) || width)
  const transformScaleY = height / Math.max(1, Number(sourceTimelineHeight) || height)
  const textStyleScale = Math.min(transformScaleX, transformScaleY)
  const scaleTransformToExport = (transform = {}) => ({
    ...transform,
    // Position is stored in timeline pixels. When exporting at half/quarter
    // resolution, scale those offsets into the smaller export canvas so clips
    // stay in the same visual location instead of moving off-frame.
    positionX: (Number(transform.positionX) || 0) * transformScaleX,
    positionY: (Number(transform.positionY) || 0) * transformScaleY,
  })
  
  if (!projectState.currentProjectHandle || typeof projectState.currentProjectHandle !== 'string') {
    throw new Error('Project folder not available for export.')
  }
  
  const outputFolder = await window.electronAPI.pathJoin(projectState.currentProjectHandle, 'renders')
  await window.electronAPI.createDirectory(outputFolder)
  
  const tempFolder = await window.electronAPI.pathJoin(outputFolder, `export_${Date.now()}`)
  await window.electronAPI.createDirectory(tempFolder)
  const framesFolder = await window.electronAPI.pathJoin(tempFolder, 'frames')
  await window.electronAPI.createDirectory(framesFolder)
  
  const outputExtension = format === 'webm' ? 'webm' : (format === 'prores' ? 'mov' : 'mp4')
  let outputPath = options.outputPath
  if (!outputPath) {
    const defaultOutputPath = await window.electronAPI.pathJoin(
      outputFolder,
      `${filename}.${outputExtension}`
    )
    const saveDialog = await window.electronAPI.saveFileDialog({
      title: 'Export Timeline',
      defaultPath: defaultOutputPath,
      filters: [
        { name: outputExtension.toUpperCase(), extensions: [outputExtension] },
      ],
    })
    if (!saveDialog) {
      throw new Error('Export cancelled')
    }
    outputPath = saveDialog
  }
  const framePattern = await window.electronAPI.pathJoin(framesFolder, 'frame_%06d.png')
  const audioPath = await window.electronAPI.pathJoin(tempFolder, 'audio.wav')
  const canUseDirectFramePipe = Boolean(
    useDirectFramePipe
    && window.electronAPI?.startFramePipe
    && window.electronAPI?.writeFrameToPipe
    && window.electronAPI?.finishFramePipe
    && window.electronAPI?.abortFramePipe
  )
  const pipedVideoPath = canUseDirectFramePipe && includeAudio
    ? await window.electronAPI.pathJoin(tempFolder, `video_only.${outputExtension}`)
    : outputPath
  let framePipeSessionId = null
  let framePipeEncoderUsed = null
  
  onProgress({ status: EXPORT_STATUS.preparing, progress: 2 })
  
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  const adjustmentCanvas = document.createElement('canvas')
  adjustmentCanvas.width = width
  adjustmentCanvas.height = height
  const adjustmentCtx = adjustmentCanvas.getContext('2d')
  const processedCanvas = document.createElement('canvas')
  processedCanvas.width = width
  processedCanvas.height = height
  const processedCtx = processedCanvas.getContext('2d')
  
  const videoElements = new Map()
  const failedVideoSources = new Set()
  const imageElements = new Map()
  const maskElements = new Map()
  const maskRenderBuffers = new Map()
  const cachedVideoSources = new Map()

  const applyAdvancedAdjustmentsToCanvas = (sourceCanvas, settings, extraBlurPx = null) => {
    const normalizedSettings = normalizeAdjustmentSettings(settings)
    processedCtx.clearRect(0, 0, width, height)
    processedCtx.filter = 'none'
    processedCtx.drawImage(sourceCanvas, 0, 0)

    const frameData = processedCtx.getImageData(0, 0, width, height)
    applyAdjustmentSettingsToImageData(frameData, normalizedSettings)
    processedCtx.putImageData(frameData, 0, 0)

    const totalBlur = Math.max(0, normalizedSettings.blur + (Number(extraBlurPx) || 0))
    if (totalBlur > 0) {
      adjustmentCtx.clearRect(0, 0, width, height)
      adjustmentCtx.save()
      adjustmentCtx.filter = `blur(${totalBlur}px)`
      adjustmentCtx.drawImage(processedCanvas, 0, 0)
      adjustmentCtx.restore()
      return adjustmentCanvas
    }

    return processedCanvas
  }
  
  const visibleVideoTrackIds = new Set(
    (timelineState.tracks || [])
      .filter((track) => track?.type === 'video' && track.visible !== false && !track.muted)
      .map((track) => track.id)
  )
  const isOnVisibleVideoTrack = (clip) => visibleVideoTrackIds.has(clip?.trackId)
  const videoClips = timelineState.clips.filter(c => c.type === 'video' && isOnVisibleVideoTrack(c))
  const imageClips = timelineState.clips.filter(c => c.type === 'image' && isOnVisibleVideoTrack(c))
  const isVisibleTransition = (transitionInfo) => {
    if (!transitionInfo) return false
    const data = transitionInfo
    const trackIds = [data.clip?.trackId, data.clipA?.trackId, data.clipB?.trackId].filter(Boolean)
    return trackIds.length === 0 || trackIds.some((trackId) => visibleVideoTrackIds.has(trackId))
  }

  if (useCachedRenders) {
    for (const clip of videoClips) {
      if (clip.cacheStatus !== 'cached') continue
      if (clip.cacheUrl) {
        cachedVideoSources.set(clip.id, clip.cacheUrl)
        continue
      }
      if (clip.cachePath && typeof projectState.currentProjectHandle === 'string') {
        try {
          const filePath = await window.electronAPI.pathJoin(projectState.currentProjectHandle, clip.cachePath)
          const fileUrl = await window.electronAPI.getFileUrlDirect(filePath)
          if (fileUrl) {
            cachedVideoSources.set(clip.id, fileUrl)
          }
        } catch (err) {
          console.warn('Failed to load cached render for export:', err)
        }
      }
    }
  }
  
  const projectHandle = projectState.currentProjectHandle
  const resolvedAssetUrls = new Map()
  for (const clip of [...videoClips, ...imageClips]) {
    const asset = assetsState.getAssetById(clip.assetId)
    if (!asset?.url) continue
    const proxyUrl = clip.type === 'video' && useProxyMedia
      ? await getExportProxyUrl(asset, projectHandle)
      : null
    const resolvedUrl = proxyUrl || await getExportAssetUrl(asset, projectHandle)
    if (!resolvedUrl) continue
    resolvedAssetUrls.set(clip.assetId, resolvedUrl)
    if (clip.type === 'video') {
      const overrideUrl = cachedVideoSources.get(clip.id)
      const sourceUrl = overrideUrl || resolvedUrl
      if (!sourceUrl) continue
      resolvedAssetUrls.set(`video:${clip.id}`, sourceUrl)
    }
  }
  
  const maskAssets = assetsState.assets.filter(asset => asset.type === 'mask')
  for (const mask of maskAssets) {
    if (!mask?.url && (!mask.maskFrames || mask.maskFrames.length === 0)) continue
    if (!maskElements.has(mask.id)) {
      const images = new Map()
      if (mask.maskFrames?.length) {
        for (const frame of mask.maskFrames) {
          if (frame.url && !images.has(frame.url)) {
            images.set(frame.url, await loadImage(frame.url))
          }
        }
      } else if (mask.url) {
        images.set(mask.url, await loadImage(mask.url))
      }
      maskElements.set(mask.id, images)
    }
  }

  const getVideoElement = async (sourceUrl) => {
    if (!sourceUrl || failedVideoSources.has(sourceUrl)) return null
    const existing = videoElements.get(sourceUrl)
    if (existing) return touchCacheEntry(videoElements, sourceUrl, existing)
    try {
      const video = await loadVideo(sourceUrl)
      if (!video.videoWidth || !video.videoHeight) {
        throw new Error('Source has no decodable video stream')
      }
      touchCacheEntry(videoElements, sourceUrl, video)
      trimVideoCache(videoElements, EXPORT_VIDEO_CACHE_LIMIT)
      return video
    } catch (err) {
      failedVideoSources.add(sourceUrl)
      console.warn('[Export] Skipping undecodable video source:', sourceUrl, getMediaErrorMessage(err))
      return null
    }
  }

  const getImageElement = async (imageUrl) => {
    if (!imageUrl) return null
    const existing = imageElements.get(imageUrl)
    if (existing) return touchCacheEntry(imageElements, imageUrl, existing)
    const image = await loadImage(imageUrl)
    touchCacheEntry(imageElements, imageUrl, image)
    trimImageCache(imageElements, EXPORT_IMAGE_CACHE_LIMIT)
    return image
  }

  if (canUseDirectFramePipe) {
    onProgress({ status: 'Starting fast FFmpeg pipe...', progress: 4 })
    const pipeStart = await window.electronAPI.startFramePipe({
      width,
      height,
      fps,
      outputPath: pipedVideoPath,
      format: outputExtension,
      duration: totalDuration,
      videoCodec,
      proresProfile: format === 'prores' ? proresProfile : undefined,
      useHardwareEncoder,
      nvencPreset,
      preset,
      qualityMode,
      crf,
      bitrateKbps,
      keyframeInterval,
    })
    if (pipeStart?.success && pipeStart.sessionId) {
      framePipeSessionId = pipeStart.sessionId
      framePipeEncoderUsed = pipeStart.encoderUsed || null
      console.log(`Export frame pipe started with: ${framePipeEncoderUsed || 'unknown encoder'}`)
    } else {
      console.warn('[Export] Fast FFmpeg pipe unavailable; falling back to PNG frame sequence:', pipeStart?.error)
      onProgress({ status: 'Fast pipe unavailable - using PNG frame sequence...', progress: 4 })
    }
  }
  
  onProgress({ status: EXPORT_STATUS.rendering, progress: 5 })
  
  const frameDuration = fps > 0 ? 1 / fps : 0
  const halfFrame = frameDuration / 2

  try {
  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
    throwIfCancelled()
    await yieldToMain()
    throwIfCancelled()
    const targetTime = rangeStart + frameIndex * frameDuration + halfFrame
    const safeEnd = Math.max(rangeStart, rangeEnd - halfFrame)
    const time = Math.min(targetTime, safeEnd)
    const rawTransitionInfo = timelineState.getTransitionAtTime(time)
    const transitionInfo = isVisibleTransition(rawTransitionInfo) ? rawTransitionInfo : null
    
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, width, height)
    
    const activeClips = timelineState.getActiveClipsAtTime(time)
    const rawVisualLayerClips = activeClips
      .filter(({ track }) => track.type === 'video')
      .sort((a, b) => {
        const indexA = timelineState.tracks.findIndex(t => t.id === a.track.id)
        const indexB = timelineState.tracks.findIndex(t => t.id === b.track.id)
        return indexB - indexA
      })
    const visualLayerClips = cullVisualLayerEntries(rawVisualLayerClips, {
      time,
      getAssetById: assetsState.getAssetById,
      transitionClipIds: getTransitionClipIds(transitionInfo),
      timelineWidth: width,
      timelineHeight: height,
    })
    
    for (const { clip } of visualLayerClips) {
      if (clip.type === 'adjustment') {
        const clipTime = time - clip.startTime
        const adjustmentSettings = normalizeAdjustmentSettings(
          getAnimatedAdjustmentSettings(clip, clipTime) || clip.adjustments || {}
        )
        const baseClipTransform = getAnimatedTransform(clip, clipTime) || clip.transform || {}
        // Apply camera shake / transform-affecting effects to the adjustment
        // layer so shake propagates to every clip beneath.
        const clipTransform = scaleTransformToExport(applyEffectsToTransform(baseClipTransform, clip.effects, clipTime))
        const usesManagedPixelEffects = hasManagedPixelOrVignetteEffect(clip, clipTime)
        const adjustmentIsActive = hasAdjustmentEffect(adjustmentSettings)

        if (adjustmentCtx && (adjustmentIsActive || usesManagedPixelEffects)) {
          const usesTonalAdjustments = hasTonalAdjustmentEffect(adjustmentSettings)
          let adjustmentOutputCanvas = null

          if (usesTonalAdjustments) {
            adjustmentCtx.clearRect(0, 0, width, height)
            adjustmentCtx.drawImage(canvas, 0, 0)
            adjustmentOutputCanvas = applyAdvancedAdjustmentsToCanvas(adjustmentCanvas, adjustmentSettings)
          } else if (adjustmentIsActive) {
            const adjustmentFilter = buildCssFilterFromAdjustments(adjustmentSettings)
            if (adjustmentFilter !== 'none') {
              adjustmentCtx.clearRect(0, 0, width, height)
              adjustmentCtx.save()
              adjustmentCtx.filter = adjustmentFilter
              adjustmentCtx.drawImage(canvas, 0, 0)
              adjustmentCtx.restore()
              adjustmentOutputCanvas = adjustmentCanvas
            }
          } else if (usesManagedPixelEffects) {
            // No color adjustment but there are managed effects to apply to
            // the composited layers beneath this adjustment clip.
            adjustmentCtx.clearRect(0, 0, width, height)
            adjustmentCtx.drawImage(canvas, 0, 0)
            adjustmentOutputCanvas = adjustmentCanvas
          }

          if (adjustmentOutputCanvas && usesManagedPixelEffects) {
            // Apply managed pixel effects and vignette to the adjusted
            // snapshot before drawing it back.
            let managedCanvas = adjustmentOutputCanvas
            let managedCtx = managedCanvas.getContext('2d')
            if (!managedCtx || managedCanvas === canvas) {
              managedCanvas = document.createElement('canvas')
              managedCanvas.width = width
              managedCanvas.height = height
              managedCtx = managedCanvas.getContext('2d')
              managedCtx.drawImage(adjustmentOutputCanvas, 0, 0)
            }
            applyClipManagedEffectsToOffCanvas(managedCanvas, managedCtx, width, height, clip, clipTime, frameIndex, glslQualityScale)
            adjustmentOutputCanvas = managedCanvas
          }

          if (adjustmentOutputCanvas) {
            const rect = getBaseDrawRect(width, height, width, height)
            const baseOpacity = typeof clipTransform.opacity === 'number' ? clipTransform.opacity / 100 : 1
            const blendMode = clipTransform?.blendMode || 'normal'

            ctx.save()
            ctx.globalAlpha = baseOpacity
            ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode
            ctx.filter = 'none'
            applyClipTransform(ctx, rect, clipTransform, null)
            applyClipCrop(ctx, rect, clipTransform)
            ctx.drawImage(adjustmentOutputCanvas, 0, 0, rect.width, rect.height)
            ctx.restore()
          }
        }
        continue
      }

      const isVideoA = transitionInfo?.clipA?.id === clip.id || (transitionInfo?.clip?.id === clip.id && transitionInfo?.edge === 'out')
      const isVideoB = transitionInfo?.clipB?.id === clip.id || (transitionInfo?.clip?.id === clip.id && transitionInfo?.edge === 'in')
      const transitionStyle = (isVideoA || isVideoB) ? getTransitionCanvasStyle(transitionInfo, isVideoA) : null
      
      const clipTime = time - clip.startTime
      const baseClipTransform = getAnimatedTransform(clip, clipTime) || clip.transform || {}
      const clipTransform = scaleTransformToExport(applyEffectsToTransform(baseClipTransform, clip.effects, clipTime))
      const clipAdjustmentSettings = normalizeAdjustmentSettings(
        getAnimatedAdjustmentSettings(clip, clipTime) || clip.adjustments || {}
      )
      const usesTonalAdjustments = hasTonalAdjustmentEffect(clipAdjustmentSettings)
      const clipAdjustmentFilter = buildCssFilterFromAdjustments(clipAdjustmentSettings)
      const clipAdjustmentFilterValue = clipAdjustmentFilter !== 'none' ? clipAdjustmentFilter : null
      const usesManagedPixelEffects = hasManagedPixelOrVignetteEffect(clip, clipTime)
      if (clip.type === 'text') {
        const rect = getBaseDrawRect(width, height, width, height)
        const baseOpacity = typeof clipTransform.opacity === 'number' ? clipTransform.opacity / 100 : 1
        const clipOpacity = (transitionStyle?.opacity ?? 1) * baseOpacity
        const blendMode = clipTransform.blendMode || 'normal'
        const blurPx = transitionStyle?.blur ?? (clipTransform?.blur > 0 ? clipTransform.blur : null)

        if (usesTonalAdjustments) {
          let buffers = maskRenderBuffers.get(clip.id)
          if (!buffers) {
            const offCanvas = document.createElement('canvas')
            offCanvas.width = width
            offCanvas.height = height
            const offCtx = offCanvas.getContext('2d')
            const maskCanvas = document.createElement('canvas')
            maskCanvas.width = width
            maskCanvas.height = height
            const maskCtx = maskCanvas.getContext('2d')
            buffers = { offCanvas, offCtx, maskCanvas, maskCtx }
            maskRenderBuffers.set(clip.id, buffers)
          }
          const { offCanvas, offCtx } = buffers

          offCtx.clearRect(0, 0, width, height)
          offCtx.save()
          offCtx.globalAlpha = 1
          offCtx.filter = 'none'
          offCtx.globalCompositeOperation = 'source-over'
          applyClipTransform(offCtx, rect, clipTransform, transitionStyle)
          applyClipCrop(offCtx, rect, clipTransform)
          applyTransitionClip(offCtx, rect, transitionStyle)
          drawText(offCtx, rect, clip, textStyleScale)
          offCtx.restore()

          const processedCanvasForText = applyAdvancedAdjustmentsToCanvas(offCanvas, clipAdjustmentSettings, blurPx)

          if (usesManagedPixelEffects) {
            const outCtx = processedCanvasForText.getContext('2d')
            applyClipManagedEffectsToOffCanvas(processedCanvasForText, outCtx, width, height, clip, clipTime, frameIndex, glslQualityScale)
          }

          ctx.save()
          ctx.globalAlpha = clipOpacity
          ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode
          ctx.filter = 'none'
          ctx.drawImage(processedCanvasForText, 0, 0)
          ctx.restore()
          continue
        }

        if (usesManagedPixelEffects) {
          let buffers = maskRenderBuffers.get(clip.id)
          if (!buffers) {
            const offCanvas = document.createElement('canvas')
            offCanvas.width = width
            offCanvas.height = height
            const offCtx = offCanvas.getContext('2d')
            buffers = { offCanvas, offCtx }
            maskRenderBuffers.set(clip.id, buffers)
          }
          const { offCanvas, offCtx } = buffers
          offCtx.clearRect(0, 0, width, height)
          offCtx.save()
          const filterPartsInner = []
          if (clipAdjustmentFilterValue) filterPartsInner.push(clipAdjustmentFilterValue)
          if (blurPx != null) filterPartsInner.push(`blur(${blurPx}px)`)
          offCtx.filter = filterPartsInner.length > 0 ? filterPartsInner.join(' ') : 'none'
          applyClipTransform(offCtx, rect, clipTransform, transitionStyle)
          applyClipCrop(offCtx, rect, clipTransform)
          applyTransitionClip(offCtx, rect, transitionStyle)
          drawText(offCtx, rect, clip, textStyleScale)
          offCtx.restore()

          applyClipManagedEffectsToOffCanvas(offCanvas, offCtx, width, height, clip, clipTime, frameIndex, glslQualityScale)

          ctx.save()
          ctx.globalAlpha = clipOpacity
          ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode
          ctx.filter = 'none'
          ctx.drawImage(offCanvas, 0, 0)
          ctx.restore()
          continue
        }

        ctx.save()
        ctx.globalAlpha = clipOpacity
        ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode
        const filterParts = []
        if (clipAdjustmentFilterValue) filterParts.push(clipAdjustmentFilterValue)
        if (blurPx != null) filterParts.push(`blur(${blurPx}px)`)
        ctx.filter = filterParts.length > 0 ? filterParts.join(' ') : 'none'
        applyClipTransform(ctx, rect, clipTransform, transitionStyle)
        applyClipCrop(ctx, rect, clipTransform)
        applyTransitionClip(ctx, rect, transitionStyle)
        drawText(ctx, rect, clip, textStyleScale)
        ctx.restore()
        continue
      }
      const asset = assetsState.getAssetById(clip.assetId)
      const cachedSourceUrl = cachedVideoSources.get(clip.id)
      const usingCachedRender = !!cachedSourceUrl
      const maskEffect = (!usingCachedRender && (clip.effects || []).find(effect => effect.type === 'mask' && effect.enabled))
      
      let sourceWidth = width
      let sourceHeight = height
      let drawSource = null
      let videoElement = null
      let sourceFps = null
      let maxSourceTime = null
      let sourceTime = null
      let shouldBlend = false
      
      if (clip.type === 'video') {
        const sourceUrl = cachedSourceUrl || resolvedAssetUrls.get(clip.assetId) || asset?.url
        if (sourceUrl && failedVideoSources.has(sourceUrl)) {
          continue
        }
        const video = sourceUrl ? await getVideoElement(sourceUrl) : null
        if (!video) continue
        
        // Calculate source time matching preview logic
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
        const rawSourceTime = usingCachedRender
          ? clipTime
          : (reverse
            ? trimEnd - clipTime * timeScale
            : trimStart + clipTime * timeScale)
        
        // Clamp to valid range (matching VideoLayerRenderer behavior)
        maxSourceTime = usingCachedRender 
          ? clip.duration 
          : (clip.sourceDuration || clip.trimEnd || video.duration || trimEnd)
        const clampedSourceTime = Math.max(0, Math.min(rawSourceTime, maxSourceTime - 0.001))
        sourceTime = clampedSourceTime
        videoElement = video
        const assetFps = Number(asset?.settings?.fps)
        sourceFps = Number.isFinite(assetFps) && assetFps > 0 ? assetFps : null

        shouldBlend = !!(sourceFps && sourceFps < fps - 0.5 && !maskEffect)
        if (!shouldBlend) {
          try {
            await seekVideo(video, clampedSourceTime, fastSeek)
          } catch (err) {
            if (sourceUrl) failedVideoSources.add(sourceUrl)
            console.warn('[Export] Failed to seek source video, skipping clip frame:', getMediaErrorMessage(err))
            continue
          }
        }
        sourceWidth = video.videoWidth || sourceWidth
        sourceHeight = video.videoHeight || sourceHeight
        drawSource = video
      } else if (clip.type === 'image') {
        const imageUrl = resolvedAssetUrls.get(clip.assetId) || asset?.url
        const image = imageUrl ? await getImageElement(imageUrl) : null
        if (!image) continue
        sourceWidth = image.naturalWidth || sourceWidth
        sourceHeight = image.naturalHeight || sourceHeight
        drawSource = image
      }
      
      if (!drawSource) continue
      
      const rect = getBaseDrawRect(sourceWidth, sourceHeight, width, height)
      const baseOpacity = typeof clipTransform.opacity === 'number' ? clipTransform.opacity / 100 : 1
      const clipOpacity = (transitionStyle?.opacity ?? 1) * baseOpacity
      const blurPx = transitionStyle?.blur ?? (clipTransform?.blur > 0 ? clipTransform.blur : null)
      const blendMode = clipTransform?.blendMode || 'normal'

      if (usesTonalAdjustments) {
        let buffers = maskRenderBuffers.get(clip.id)
        if (!buffers) {
          const offCanvas = document.createElement('canvas')
          offCanvas.width = width
          offCanvas.height = height
          const offCtx = offCanvas.getContext('2d')
          const maskCanvas = document.createElement('canvas')
          maskCanvas.width = width
          maskCanvas.height = height
          const maskCtx = maskCanvas.getContext('2d')
          buffers = { offCanvas, offCtx, maskCanvas, maskCtx }
          maskRenderBuffers.set(clip.id, buffers)
        }
        const { offCanvas, offCtx, maskCanvas, maskCtx } = buffers

        offCtx.clearRect(0, 0, width, height)
        offCtx.save()
        offCtx.globalAlpha = 1
        offCtx.filter = 'none'
        offCtx.globalCompositeOperation = 'source-over'
        applyClipTransform(offCtx, rect, clipTransform, transitionStyle)
        applyClipCrop(offCtx, rect, clipTransform)
        applyTransitionClip(offCtx, rect, transitionStyle)

        if (shouldBlend && sourceTime !== null) {
          const sourceFrameDuration = 1 / sourceFps
          const baseIndex = Math.floor(sourceTime / sourceFrameDuration)
          const baseTime = baseIndex * sourceFrameDuration
          const nextTime = Math.min(baseTime + sourceFrameDuration, (maxSourceTime ?? sourceTime) - 0.001)
          const blend = clamp((sourceTime - baseTime) / sourceFrameDuration, 0, 1)

          try {
            offCtx.globalAlpha = 1 - blend
            await seekVideo(videoElement, baseTime, fastSeek)
            offCtx.drawImage(videoElement, 0, 0, rect.width, rect.height)

            if (blend > 0.001 && nextTime > baseTime + 1e-6) {
              offCtx.globalAlpha = blend
              await seekVideo(videoElement, nextTime, fastSeek)
              offCtx.drawImage(videoElement, 0, 0, rect.width, rect.height)
            }
          } catch (err) {
            console.warn('[Export] Failed blended seek/draw, skipping clip frame:', getMediaErrorMessage(err))
            if (clip.type === 'video') {
              const badSourceUrl = cachedVideoSources.get(clip.id) || resolvedAssetUrls.get(clip.assetId) || asset?.url
              if (badSourceUrl) failedVideoSources.add(badSourceUrl)
            }
            offCtx.restore()
            continue
          }
        } else {
          offCtx.drawImage(drawSource, 0, 0, rect.width, rect.height)
        }
        offCtx.restore()

        let advancedOutputCanvas = offCanvas
        if (maskEffect) {
          const maskAsset = assetsState.getAssetById(maskEffect.maskAssetId)
          const maskFrameUrl = getMaskFrameInfo(clip, maskAsset, time)
          const maskImageMap = maskElements.get(maskAsset?.id)
          const maskImage = maskImageMap?.get(maskFrameUrl)

          if (maskImage) {
            maskCtx.clearRect(0, 0, width, height)
            maskCtx.save()
            maskCtx.filter = 'none'
            applyClipTransform(maskCtx, rect, clipTransform, transitionStyle)
            applyClipCrop(maskCtx, rect, clipTransform)
            applyTransitionClip(maskCtx, rect, transitionStyle)
            maskCtx.drawImage(maskImage, 0, 0, rect.width, rect.height)
            maskCtx.restore()

            const frameData = offCtx.getImageData(0, 0, width, height)
            const maskData = maskCtx.getImageData(0, 0, width, height)
            const framePixels = frameData.data
            const maskPixels = maskData.data

            for (let i = 0; i < framePixels.length; i += 4) {
              const luminance = (maskPixels[i] + maskPixels[i + 1] + maskPixels[i + 2]) / 3
              const alpha = maskEffect.invertMask ? (255 - luminance) : luminance
              framePixels[i + 3] = alpha
            }

            offCtx.putImageData(frameData, 0, 0)
          }
        }

        advancedOutputCanvas = applyAdvancedAdjustmentsToCanvas(advancedOutputCanvas, clipAdjustmentSettings, blurPx)

        if (usesManagedPixelEffects) {
          const outCtx = advancedOutputCanvas.getContext('2d')
          applyClipManagedEffectsToOffCanvas(advancedOutputCanvas, outCtx, width, height, clip, clipTime, frameIndex, glslQualityScale)
        }

        ctx.save()
        ctx.globalAlpha = clipOpacity
        ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode
        ctx.filter = 'none'
        ctx.drawImage(advancedOutputCanvas, 0, 0)
        ctx.restore()
        continue
      }
      
      if (usesManagedPixelEffects && !maskEffect) {
        let buffers = maskRenderBuffers.get(clip.id)
        if (!buffers) {
          const offCanvas = document.createElement('canvas')
          offCanvas.width = width
          offCanvas.height = height
          const offCtx = offCanvas.getContext('2d')
          buffers = { offCanvas, offCtx }
          maskRenderBuffers.set(clip.id, buffers)
        }
        const { offCanvas, offCtx } = buffers
        offCtx.clearRect(0, 0, width, height)

        offCtx.save()
        const filterPartsInner = []
        if (clipAdjustmentFilterValue) filterPartsInner.push(clipAdjustmentFilterValue)
        if (blurPx != null) filterPartsInner.push(`blur(${blurPx}px)`)
        offCtx.filter = filterPartsInner.length > 0 ? filterPartsInner.join(' ') : 'none'
        applyClipTransform(offCtx, rect, clipTransform, transitionStyle)
        applyClipCrop(offCtx, rect, clipTransform)
        applyTransitionClip(offCtx, rect, transitionStyle)

        if (shouldBlend && sourceTime !== null) {
          const sourceFrameDuration = 1 / sourceFps
          const baseIndex = Math.floor(sourceTime / sourceFrameDuration)
          const baseTime = baseIndex * sourceFrameDuration
          const nextTime = Math.min(baseTime + sourceFrameDuration, (maxSourceTime ?? sourceTime) - 0.001)
          const blend = clamp((sourceTime - baseTime) / sourceFrameDuration, 0, 1)
          try {
            offCtx.globalAlpha = 1 - blend
            await seekVideo(videoElement, baseTime, fastSeek)
            offCtx.drawImage(videoElement, 0, 0, rect.width, rect.height)
            if (blend > 0.001 && nextTime > baseTime + 1e-6) {
              offCtx.globalAlpha = blend
              await seekVideo(videoElement, nextTime, fastSeek)
              offCtx.drawImage(videoElement, 0, 0, rect.width, rect.height)
            }
          } catch (err) {
            console.warn('[Export] Failed blended seek/draw, skipping clip frame:', getMediaErrorMessage(err))
            if (clip.type === 'video') {
              const badSourceUrl = cachedVideoSources.get(clip.id) || resolvedAssetUrls.get(clip.assetId) || asset?.url
              if (badSourceUrl) failedVideoSources.add(badSourceUrl)
            }
            offCtx.restore()
            continue
          }
        } else {
          offCtx.drawImage(drawSource, 0, 0, rect.width, rect.height)
        }
        offCtx.restore()

        applyClipManagedEffectsToOffCanvas(offCanvas, offCtx, width, height, clip, clipTime, frameIndex, glslQualityScale)

        ctx.save()
        ctx.globalAlpha = clipOpacity
        ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode
        ctx.filter = 'none'
        ctx.drawImage(offCanvas, 0, 0)
        ctx.restore()
        continue
      }

      ctx.save()
      ctx.globalAlpha = clipOpacity
      const filterParts = []
      if (clipAdjustmentFilterValue) filterParts.push(clipAdjustmentFilterValue)
      if (blurPx != null) filterParts.push(`blur(${blurPx}px)`)
      ctx.filter = filterParts.length > 0 ? filterParts.join(' ') : 'none'
      // Blend mode (CSS mix-blend-mode → canvas globalCompositeOperation)
      ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode

      applyClipTransform(ctx, rect, clipTransform, transitionStyle)
      applyClipCrop(ctx, rect, clipTransform)
      applyTransitionClip(ctx, rect, transitionStyle)
      
      if (shouldBlend && sourceTime !== null) {
        const sourceFrameDuration = 1 / sourceFps
        const baseIndex = Math.floor(sourceTime / sourceFrameDuration)
        const baseTime = baseIndex * sourceFrameDuration
        const nextTime = Math.min(baseTime + sourceFrameDuration, (maxSourceTime ?? sourceTime) - 0.001)
        const blend = clamp((sourceTime - baseTime) / sourceFrameDuration, 0, 1)

        try {
          ctx.globalAlpha = clipOpacity * (1 - blend)
          await seekVideo(videoElement, baseTime, fastSeek)
          ctx.drawImage(videoElement, 0, 0, rect.width, rect.height)

          if (blend > 0.001 && nextTime > baseTime + 1e-6) {
            ctx.globalAlpha = clipOpacity * blend
            await seekVideo(videoElement, nextTime, fastSeek)
            ctx.drawImage(videoElement, 0, 0, rect.width, rect.height)
          }
        } catch (err) {
          console.warn('[Export] Failed blended seek/draw, skipping clip frame:', getMediaErrorMessage(err))
          if (clip.type === 'video') {
            const badSourceUrl = cachedVideoSources.get(clip.id) || resolvedAssetUrls.get(clip.assetId) || asset?.url
            if (badSourceUrl) failedVideoSources.add(badSourceUrl)
          }
          ctx.restore()
          continue
        }

        ctx.restore()
        continue
      }
      if (maskEffect) {
        const maskAsset = assetsState.getAssetById(maskEffect.maskAssetId)
        const maskFrameUrl = getMaskFrameInfo(clip, maskAsset, time)
        const maskImageMap = maskElements.get(maskAsset?.id)
        const maskImage = maskImageMap?.get(maskFrameUrl)
        
        if (maskImage) {
          let buffers = maskRenderBuffers.get(clip.id)
          if (!buffers) {
            const offCanvas = document.createElement('canvas')
            offCanvas.width = width
            offCanvas.height = height
            const offCtx = offCanvas.getContext('2d')
            const maskCanvas = document.createElement('canvas')
            maskCanvas.width = width
            maskCanvas.height = height
            const maskCtx = maskCanvas.getContext('2d')
            buffers = { offCanvas, offCtx, maskCanvas, maskCtx }
            maskRenderBuffers.set(clip.id, buffers)
          }
          const { offCanvas, offCtx, maskCanvas, maskCtx } = buffers
          
          offCtx.clearRect(0, 0, width, height)
          offCtx.save()
          offCtx.globalAlpha = clipOpacity
          const blurPxMask = transitionStyle?.blur ?? (clipTransform?.blur > 0 ? clipTransform.blur : null)
          offCtx.filter = blurPxMask != null ? `blur(${blurPxMask}px)` : 'none'
          applyClipTransform(offCtx, rect, clipTransform, transitionStyle)
          applyClipCrop(offCtx, rect, clipTransform)
          applyTransitionClip(offCtx, rect, transitionStyle)
          offCtx.drawImage(drawSource, 0, 0, rect.width, rect.height)
          offCtx.restore()
          
          maskCtx.clearRect(0, 0, width, height)
          maskCtx.save()
          const blurPxMask2 = transitionStyle?.blur ?? (clipTransform?.blur > 0 ? clipTransform.blur : null)
          maskCtx.filter = blurPxMask2 != null ? `blur(${blurPxMask2}px)` : 'none'
          applyClipTransform(maskCtx, rect, clipTransform, transitionStyle)
          applyClipCrop(maskCtx, rect, clipTransform)
          applyTransitionClip(maskCtx, rect, transitionStyle)
          maskCtx.drawImage(maskImage, 0, 0, rect.width, rect.height)
          maskCtx.restore()
          
          const frameData = offCtx.getImageData(0, 0, width, height)
          const maskData = maskCtx.getImageData(0, 0, width, height)
          const framePixels = frameData.data
          const maskPixels = maskData.data
          
          for (let i = 0; i < framePixels.length; i += 4) {
            const luminance = (maskPixels[i] + maskPixels[i + 1] + maskPixels[i + 2]) / 3
            const alpha = maskEffect.invertMask ? (255 - luminance) : luminance
            framePixels[i + 3] = alpha
          }
          
          offCtx.putImageData(frameData, 0, 0)

          if (usesManagedPixelEffects) {
            applyClipManagedEffectsToOffCanvas(offCanvas, offCtx, width, height, clip, clipTime, frameIndex, glslQualityScale)
          }

          ctx.drawImage(offCanvas, 0, 0)
          ctx.restore()
          continue
        }
      }
      
      ctx.drawImage(drawSource, 0, 0, rect.width, rect.height)
      ctx.restore()
    }
    
    const overlayOpacity = getFadeOverlayOpacity(transitionInfo)
    if (overlayOpacity !== null) {
      const type = transitionInfo?.transition?.type
      ctx.save()
      ctx.globalAlpha = overlayOpacity
      ctx.fillStyle = type === 'fade-white' ? '#FFFFFF' : '#000000'
      ctx.fillRect(0, 0, width, height)
      ctx.restore()
    }
    
    if (framePipeSessionId) {
      const frameData = ctx.getImageData(0, 0, width, height)
      const pixelData = frameData.data
      const frameBuffer = pixelData.byteOffset === 0 && pixelData.byteLength === pixelData.buffer.byteLength
        ? pixelData.buffer
        : pixelData.buffer.slice(pixelData.byteOffset, pixelData.byteOffset + pixelData.byteLength)
      const writeResult = await window.electronAPI.writeFrameToPipe(framePipeSessionId, frameBuffer)
      if (!writeResult?.success) {
        throw new Error(writeResult?.error || 'Failed to write frame to FFmpeg pipe.')
      }
    } else {
      const frameBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      const frameBuffer = await frameBlob.arrayBuffer()
      const framePath = await window.electronAPI.pathJoin(framesFolder, `frame_${formatFrameNumber(frameIndex + 1)}.png`)
      await window.electronAPI.writeFileFromArrayBuffer(framePath, frameBuffer)
    }
    
    if (frameIndex % 5 === 0) {
      const progress = 5 + Math.floor((frameIndex / totalFrames) * 70)
      onProgress({ 
        status: EXPORT_STATUS.rendering, 
        progress,
        frame: frameIndex + 1,
        totalFrames
      })
    }
    if (frameIndex > 0 && frameIndex % 10 === 0) {
      await yieldToEventLoop()
    }
  }
  } catch (err) {
    if (framePipeSessionId) {
      try {
        await window.electronAPI.abortFramePipe(framePipeSessionId)
      } catch {
        // ignore abort errors
      }
      framePipeSessionId = null
    }
    for (const video of videoElements.values()) releaseVideoElement(video)
    videoElements.clear()
    imageElements.clear()
    maskElements.clear()
    maskRenderBuffers.clear()
    throw err
  }

  if (framePipeSessionId) {
    if (signal?.aborted) {
      try {
        await window.electronAPI.abortFramePipe(framePipeSessionId)
      } catch {
        // ignore abort errors
      }
      framePipeSessionId = null
      throw new Error('Export cancelled')
    }
    onProgress({ status: 'Finalizing fast FFmpeg pipe...', progress: 78 })
    const pipeFinish = await window.electronAPI.finishFramePipe(framePipeSessionId)
    framePipeSessionId = null
    if (!pipeFinish?.success) {
      throw new Error(pipeFinish?.error || 'Failed to finish FFmpeg frame pipe.')
    }
    framePipeEncoderUsed = pipeFinish.encoderUsed || framePipeEncoderUsed
  }
  
  let audioFilePath = null
  if (includeAudio) {
    const audioStartTime = Date.now()
    const updateAudioStatus = (message, progress = 80) => {
      const elapsed = ((Date.now() - audioStartTime) / 1000).toFixed(1)
      onProgress({ status: `Mixing audio (${elapsed}s) • ${message}`, progress })
    }
    updateAudioStatus('Preparing audio clips', 80)
    const audioClips = timelineState.clips.filter(clip => clip.type === 'audio' && clip.enabled !== false)
    const activeTracks = timelineState.tracks.filter(t => t.type === 'audio' && t.visible && !t.muted)
    
    if (audioClips.length > 0 && activeTracks.length > 0) {
      const sampleRate = audioSampleRate || DEFAULT_SAMPLE_RATE
      const channelCount = audioChannels || 2
      const activeTrackIds = new Set(activeTracks.map(track => track.id))
      const eligibleAudioClips = audioClips.filter(clip => activeTrackIds.has(clip.trackId))

      // Preferred path: mix in main process with FFmpeg (avoids renderer OfflineAudioContext hangs).
      if (window.electronAPI?.mixAudio && eligibleAudioClips.length > 0) {
        let ffmpegMixHeartbeat = null
        try {
          updateAudioStatus('Preparing FFmpeg audio mix…', 82)
          ffmpegMixHeartbeat = setInterval(() => {
            updateAudioStatus('Mixing audio…', 86)
          }, 5000)
          const mixResult = await window.electronAPI.mixAudio({
            projectPath: projectHandle,
            outputPath: audioPath,
            rangeStart,
            rangeEnd,
            sampleRate,
            channels: channelCount,
            timeoutMs: AUDIO_MIX_TIMEOUT_MS,
            clips: eligibleAudioClips.map(clip => ({
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
              reverse: clip.reverse,
              gainDb: normalizeAudioClipGainDb(clip.gainDb),
              fadeIn: clip.fadeIn ?? 0,
              fadeOut: clip.fadeOut ?? 0,
              url: clip.url || null,
            })),
            tracks: timelineState.tracks
              .filter(track => track.type === 'audio')
              .map(track => ({
                id: track.id,
                type: track.type,
                muted: !!track.muted,
                visible: track.visible !== false,
                channels: track.channels || 'stereo',
                volume: track.volume ?? 100,
              })),
            assets: assetsState.assets
              .map(asset => ({
                id: asset.id,
                type: asset.type,
                path: asset.path || null,
                url: asset.url || null,
              })),
          })
          if (ffmpegMixHeartbeat) clearInterval(ffmpegMixHeartbeat)
          if (mixResult?.success) {
            audioFilePath = audioPath
            updateAudioStatus('Audio mix complete', 89)
          } else {
            throw new Error(mixResult?.error || 'FFmpeg audio mix failed')
          }
        } catch (err) {
          if (ffmpegMixHeartbeat) clearInterval(ffmpegMixHeartbeat)
          console.warn('FFmpeg audio mix failed, falling back to WebAudio mix:', err)
          audioFilePath = null
        }
      }

      // Fallback path for environments where FFmpeg mix IPC is unavailable.
      if (!audioFilePath) {
        const totalSamples = Math.ceil(totalDuration * sampleRate)
        const offlineContext = new OfflineAudioContext(channelCount, totalSamples, sampleRate)
        const decodedAudioCache = new Map()
        const resolvedAudioUrlCache = new Map()
        
        for (let index = 0; index < eligibleAudioClips.length; index++) {
          const clip = eligibleAudioClips[index]
          const track = timelineState.tracks.find(t => t.id === clip.trackId)
          if (!track || track.muted || !track.visible) continue
          const asset = assetsState.getAssetById(clip.assetId)
          if (!asset?.url) continue
          let audioUrl = resolvedAudioUrlCache.get(asset.id)
          if (!audioUrl) {
            audioUrl = await getExportAssetUrl(asset, projectHandle) || asset.url
            resolvedAudioUrlCache.set(asset.id, audioUrl)
          }
          try {
            updateAudioStatus(`Loading clip ${index + 1}/${eligibleAudioClips.length}: ${asset.name || asset.id}`, 81)
            let audioBuffer = decodedAudioCache.get(audioUrl)
            if (!audioBuffer) {
              const response = await withTimeout(
                fetchWithTimeout(audioUrl, AUDIO_FETCH_TIMEOUT_MS),
                AUDIO_FETCH_TIMEOUT_MS + 2000,
                'Audio fetch'
              )
              const arrayBuffer = await withTimeout(response.arrayBuffer(), AUDIO_FETCH_TIMEOUT_MS, 'Audio buffer')
              updateAudioStatus(`Decoding clip ${index + 1}/${eligibleAudioClips.length}`, 82)
              audioBuffer = await withTimeout(
                offlineContext.decodeAudioData(arrayBuffer),
                AUDIO_DECODE_TIMEOUT_MS,
                'Audio decode'
              )
              decodedAudioCache.set(audioUrl, audioBuffer)
            }
            
            // Mono track: downmix stereo (or multi) to one channel so the track is truly mono
            const isMonoTrack = track.channels === 'mono'
            if (isMonoTrack && audioBuffer.numberOfChannels >= 2) {
              const monoBuffer = offlineContext.createBuffer(1, audioBuffer.length, audioBuffer.sampleRate)
              const left = audioBuffer.getChannelData(0)
              const right = audioBuffer.getChannelData(1)
              const mono = monoBuffer.getChannelData(0)
              for (let i = 0; i < audioBuffer.length; i++) {
                mono[i] = (left[i] + right[i]) / 2
              }
              audioBuffer = monoBuffer
            } else if (isMonoTrack && audioBuffer.numberOfChannels === 1) {
              // Already mono, use as-is (will play to both L/R of output)
            }
            
            const source = offlineContext.createBufferSource()
            source.buffer = audioBuffer

            const clipStart = Number(clip.startTime) || 0
            const clipDuration = Math.max(0, Number(clip.duration) || 0)
            const clipEnd = clipStart + clipDuration
            const visibleStart = Math.max(rangeStart, clipStart)
            const visibleEnd = Math.min(rangeEnd, clipEnd)
            if (visibleEnd <= visibleStart) continue

            const clipOffsetOnTimeline = visibleStart - clipStart
            const baseScale = clip.sourceTimeScale || (clip.timelineFps && clip.sourceFps
              ? clip.timelineFps / clip.sourceFps
              : 1)
            const speed = Number(clip.speed)
            const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
            const timeScale = baseScale * speedScale
            const startOffset = Math.max(0, visibleStart - rangeStart)
            const sourceOffset = Math.max(0, (clip.trimStart || 0) + clipOffsetOnTimeline * timeScale)
            const visibleDuration = visibleEnd - visibleStart
            const playDuration = clamp(visibleDuration * timeScale, 0, audioBuffer.duration - sourceOffset)
            if (playDuration <= 0) continue

            const gainNode = offlineContext.createGain()
            const { fadeIn, fadeOut } = getAudioClipFadeValues(clip)
            const trackGain = track.volume !== undefined
              ? Math.max(0, Number(track.volume) || 0) / 100
              : 1
            const baseGain = getAudioClipLinearGain(clip) * trackGain
            const endClipTime = Math.min(clipDuration, clipOffsetOnTimeline + visibleDuration)
            const startClipTime = Math.max(0, clipOffsetOnTimeline)
            const segmentEndTime = startOffset + visibleDuration
            const startGain = baseGain * getAudioClipFadeGain(clip, startClipTime)
            const endGain = baseGain * getAudioClipFadeGain(clip, endClipTime)

            gainNode.gain.setValueAtTime(startGain, startOffset)

            if (fadeIn > 0) {
              const fadeInBoundary = fadeIn - startClipTime
              if (fadeInBoundary > 0 && fadeInBoundary < visibleDuration) {
                gainNode.gain.linearRampToValueAtTime(baseGain, startOffset + fadeInBoundary)
              }
            }

            if (fadeOut > 0) {
              const fadeOutStart = Math.max(0, clipDuration - fadeOut)
              const fadeOutBoundary = fadeOutStart - startClipTime
              if (fadeOutBoundary > 0 && fadeOutBoundary < visibleDuration) {
                gainNode.gain.setValueAtTime(baseGain, startOffset + fadeOutBoundary)
                gainNode.gain.linearRampToValueAtTime(endGain, segmentEndTime)
              } else if (startClipTime >= fadeOutStart) {
                gainNode.gain.linearRampToValueAtTime(endGain, segmentEndTime)
              } else if (fadeIn <= 0) {
                gainNode.gain.setValueAtTime(baseGain, startOffset)
              }
            } else if (fadeIn > 0 && startClipTime >= fadeIn) {
              gainNode.gain.setValueAtTime(baseGain, startOffset)
            }

            source.connect(gainNode)
            gainNode.connect(offlineContext.destination)
            source.start(startOffset, sourceOffset, playDuration)
          } catch (err) {
            console.warn('Failed to decode audio clip for export:', err)
            updateAudioStatus(`Failed clip ${index + 1}/${eligibleAudioClips.length} (skipped)`, 82)
          }
          await yieldToEventLoop()
        }

        let renderHeartbeat = null
        try {
          updateAudioStatus('Rendering offline mix…', 86)
          renderHeartbeat = setInterval(() => {
            updateAudioStatus('Rendering offline mix…', 86)
          }, 5000)
          const mixedBuffer = await withTimeout(
            offlineContext.startRendering(),
            AUDIO_MIX_TIMEOUT_MS,
            'Audio mix'
          )
          if (renderHeartbeat) clearInterval(renderHeartbeat)
          updateAudioStatus('Writing WAV…', 88)
          const wavData = audioBufferToWav(mixedBuffer)
          await window.electronAPI.writeFileFromArrayBuffer(audioPath, wavData)
          audioFilePath = audioPath
          updateAudioStatus('Audio mix complete', 89)
        } catch (err) {
          if (renderHeartbeat) clearInterval(renderHeartbeat)
          console.warn('Audio mix failed or timed out, exporting video only:', err)
          onProgress({ status: 'Audio mix failed — exporting video only', progress: 85 })
          audioFilePath = null
        }
      }
    } else {
      updateAudioStatus('No audio clips to mix', 85)
    }
  }
  
  onProgress({ status: EXPORT_STATUS.encoding, progress: 90 })
  await yieldToMain()

  let encodeResult = null
  if (framePipeEncoderUsed) {
    if (audioFilePath && pipedVideoPath !== outputPath) {
      onProgress({ status: 'Muxing fast-pipe video with audio...', progress: 92 })
      const muxResult = await window.electronAPI.muxAudioVideo({
        videoPath: pipedVideoPath,
        audioPath: audioFilePath,
        outputPath,
        format: outputExtension,
        duration: totalDuration,
        audioCodec,
        audioBitrateKbps,
        audioSampleRate,
      })
      if (!muxResult?.success) {
        throw new Error(muxResult?.error || 'Failed to mux audio onto fast-pipe export.')
      }
    } else if (pipedVideoPath !== outputPath) {
      const copyResult = await window.electronAPI.copyFile(pipedVideoPath, outputPath)
      if (!copyResult?.success) {
        throw new Error(copyResult?.error || 'Failed to copy fast-pipe export to output path.')
      }
    }
    encodeResult = { success: true, encoderUsed: framePipeEncoderUsed }
  } else {
    encodeResult = await window.electronAPI.encodeVideo({
      framePattern,
      fps,
      outputPath,
      audioPath: audioFilePath,
      format: outputExtension,
      duration: totalDuration,
      videoCodec,
      audioCodec,
      proresProfile: format === 'prores' ? proresProfile : undefined,
      useHardwareEncoder,
      nvencPreset,
      preset,
      qualityMode,
      crf,
      bitrateKbps,
      keyframeInterval,
      audioBitrateKbps,
      audioSampleRate,
    })
  }
  
  if (!encodeResult?.success) {
    throw new Error(encodeResult?.error || 'Failed to encode export.')
  }
  if (encodeResult.encoderUsed) {
    console.log(`Export encoded with: ${encodeResult.encoderUsed}`)
  }

  for (const video of videoElements.values()) releaseVideoElement(video)
  videoElements.clear()
  imageElements.clear()
  maskElements.clear()
  maskRenderBuffers.clear()

  // Cleanup temp render files
  if (getLocalStorageFlag('exportKeepFrames')) {
    console.log('[Export] Keeping temp frame folder for diagnostics:', tempFolder)
  } else {
    try {
      await window.electronAPI.deleteDirectory(tempFolder, { recursive: true })
    } catch (err) {
      console.warn('Failed to clean export temp folder:', err)
    }
  }
  
  onProgress({ status: EXPORT_STATUS.done, progress: 100 })
  
  return {
    outputPath,
    encoderUsed: encodeResult.encoderUsed || null,
  }
}

export default exportTimeline
