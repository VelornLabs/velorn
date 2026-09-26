import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import { getCompoundRenderState, getClipPlaybackWindow, isClipInPlaybackWindow } from '../utils/compoundPlayback.mjs'
import { hasUsableProxy } from './proxyCache'
import { shouldUseWebCodecsForAsset, supportsTransparentExport } from '../utils/alphaMedia.mjs'
import { getAnimatedTransform, getAnimatedAdjustmentSettings, getAnimatedTextProperties, getAnimatedShapeProperties, getAnimatedShapeMask } from '../utils/keyframes'
import {
  applyAdjustmentSettingsToImageData,
  buildCssFilterFromAdjustments,
  hasAdjustmentEffect,
  hasTonalAdjustmentEffect,
  hasTransformingAdjustmentTransform,
  needsAdvancedColorPass,
  normalizeAdjustmentSettings,
} from '../utils/adjustments'
import { loadLutLibrary } from './lutLibrary'
import { getShapeMaskCanvases, getShapeMaskSignature } from '../utils/shapeMask'
import { getRenderAdjustments, getRenderEffects, isClipBypassed } from '../utils/clipBypass'
import { drawLiveCaptionsFrame } from '../utils/captionRenderer'
import { getAudioClipFadeGain, getAudioClipFadeValues } from '../utils/audioClipFades'
import { getAudioClipLinearGain, normalizeAudioClipGainDb } from '../utils/audioClipGain'
import { normalizeAudioVolumeEnvelope } from '../utils/audioVolumeEnvelope.mjs'
import { scheduleAudioVolumeEnvelope } from '../utils/audioVolumeAutomation.mjs'
import { normalizeAudioEq } from '../utils/audioEq.mjs'
import { createAudioEqChain } from './audioEqChain'
import { clampTrackVolume, hasAudioSolo, isAudioTrackAudible, trackPanToStereoPosition, trackVolumeToLinearGain } from '../utils/audioTrackAudibility'
import { collectAudioMixClips, countExpectedAudioMixClips } from '../../electron/audioMixEligibility.mjs'
import { getEnabledAudioInserts, hasEnabledAudioInserts } from '../utils/audioInserts'
import { buildInsertChain } from './audioInsertChain'
import {
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
import { applyGlslEffectsToCanvas, hasGlslEffect } from '../utils/glslEffects'
import { cullVisualLayerEntries, getTransitionClipIds } from '../utils/layerCompositing'
import { parseTrackMatte, resolveTrackMatteAssignments, applyTrackMatteToCanvas } from '../utils/trackMatte'
import { getRenderableVideoClipIds } from '../utils/exportVideoClipEligibility'
import { hasActiveCornerPin, applyCornerPinToQuad } from '../utils/cornerPin'
import { drawShape, getShapeCanvasRect } from '../utils/shapes'
import { quoteCssFontFamily } from '../utils/fontFamily'
import { getMotionBlurSamples, getVelocityMotionBlurOptions } from '../utils/motionBlur'
import { applyVelocityMotionBlurToCanvas, buildVelocityBlurUniformValues, canUseVelocityMotionBlur } from '../utils/velocityMotionBlur'
import {
  createClipFrameCursor,
  getFrameSourceStats,
  getWebCodecsExportFallbackReason,
  isWebCodecsExportEnabled,
  needsWebCodecsSourcePreparation,
  resetFrameSourceStats,
} from './exportFrameSource'
import { applyTransitionClip, getFadeOverlayInfo, getTransitionCanvasStyle } from '../utils/transitionStyles'
import { isFullBakeFresh } from '../utils/clipBakeSignature'
import { getClipPlaybackTimeAtTimeline, getClipPlaybackTimingAtTimeline } from '../utils/clipPlaybackTiming'
import {
  FRAME_SAMPLING_MODE,
  getClipMinimumSpeed,
  getOpticalFlowSourceSignature,
  getOpticalFlowCacheUsability,
  getRequiredOpticalFlowHandleSeconds,
  isSafeOpticalFlowCachePath,
  mapOriginalSourceTimeToOpticalFlowCache,
  normalizeFrameSamplingMode,
} from '../utils/frameSampling'
import { createGpuCompositor, isGpuExportEnabled } from './gpuCompositor'
import { isAbsoluteRecordedPath } from './assetRelinkFallback'
import { createExportScheduler } from './exportScheduler.mjs'
import {
  cleanupCompletedPngSequenceTemp,
  getPngSequenceFrameFilename,
  getPngSequenceFramePattern,
  sanitizePngSequenceBaseName,
  withOwnedPngSequenceOutput,
} from './pngSequenceExport.mjs'

const DEFAULT_SAMPLE_RATE = 44100
const AUDIO_FETCH_TIMEOUT_MS = 15000
const AUDIO_DECODE_TIMEOUT_MS = 30000
const AUDIO_MIX_TIMEOUT_MS = 120000

const EXPORT_STATUS = {
  preparing: 'Preparing export...',
  rendering: 'Rendering frames...',
  audio: 'Mixing audio...',
  encoding: 'Encoding video...',
  done: 'Export complete',
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const degToRad = (degrees) => (degrees * Math.PI) / 180

const getLocalStorageFlag = (key) => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

// Kill switch: localStorage 'comfystudio-export-pipeline' = '0' restores
// lockstep pipe writes and synchronous GPU readback.
const isExportPipelineEnabled = () => {
  try {
    return typeof localStorage === 'undefined' || localStorage.getItem('comfystudio-export-pipeline') !== '0'
  } catch {
    return true
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

const isElectron = () => typeof window !== 'undefined' && window.electronAPI != null

/** Resolve asset to a stable file:// URL for export when in Electron to avoid blob URL invalidation / OOM */
async function getExportAssetUrl(asset, projectHandle) {
  if (!asset?.url) return null
  if (isElectron() && asset.absolutePath) {
    try {
      return await window.electronAPI.getFileUrlDirect(asset.absolutePath)
    } catch (e) {
      console.warn('Export: could not resolve absolute file URL for asset:', asset.name, e)
    }
  }
  if (isElectron() && asset.path) {
    try {
      const filePath = isAbsoluteRecordedPath(asset.path)
        ? asset.path
        : projectHandle
          ? await window.electronAPI.pathJoin(projectHandle, asset.path)
          : null
      if (!filePath) return asset.url
      return await window.electronAPI.getFileUrlDirect(filePath)
    } catch (e) {
      console.warn('Export: could not resolve file URL for asset, using blob:', asset.name, e)
    }
  }
  return asset.url
}

async function getExportAssetPath(asset, projectHandle) {
  if (!isElectron() || !asset) return null
  if (typeof asset.absolutePath === 'string' && asset.absolutePath.trim()) {
    return asset.absolutePath
  }
  if (asset.path) {
    try {
      if (isAbsoluteRecordedPath(asset.path)) return asset.path
      if (typeof projectHandle === 'string') {
        return await window.electronAPI.pathJoin(projectHandle, asset.path)
      }
    } catch (err) {
      console.warn('Export: could not resolve local asset path:', asset.name, err)
    }
  }
  return null
}

async function getExportAssetSignature(asset, projectHandle) {
  const sourcePath = await getExportAssetPath(asset, projectHandle)
  if (!sourcePath || !window.electronAPI?.getFileInfo) return null
  const result = await window.electronAPI.getFileInfo(sourcePath)
  if (result?.success === false) return null
  return getOpticalFlowSourceSignature(result)
}

async function getExportProxyUrl(asset, projectHandle) {
  if (!asset || asset.type !== 'video') return null
  if (!hasUsableProxy(asset)) return null
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
  video.preload = 'auto'
  
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
    if (playPromise) await playPromise.catch(() => {})
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

const seekVideo = async (video, time, fastSeek = true) => {
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

export const getBaseDrawRect = (assetWidth, assetHeight, canvasWidth, canvasHeight, fitMode = 'fit') => {
  if (!assetWidth || !assetHeight) {
    return {
      width: canvasWidth,
      height: canvasHeight,
      x: 0,
      y: 0,
    }
  }
  const scale = fitMode === 'fill'
    ? Math.max(canvasWidth / assetWidth, canvasHeight / assetHeight)
    : Math.min(canvasWidth / assetWidth, canvasHeight / assetHeight)
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
    positionZ = 0,
    scaleX = 100,
    scaleY = 100,
    rotation = 0,
    rotationX = 0,
    rotationY = 0,
    perspective = 1200,
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
  const safePerspective = clamp(Number(perspective) || 1200, 100, 10000)
  const safePositionZ = clamp(Number(positionZ) || 0, -20000, safePerspective - 100)
  const depthScale = clamp(safePerspective / Math.max(100, safePerspective - safePositionZ), 0.05, 12)
  const safeRotationX = clamp(Number(rotationX) || 0, -89, 89)
  const safeRotationY = clamp(Number(rotationY) || 0, -89, 89)
  
  ctx.translate(translateX, translateY)
  if (rotation) {
    ctx.rotate((rotation * Math.PI) / 180)
  }
  if (safeRotationX || safeRotationY) {
    const tiltXRad = (safeRotationX * Math.PI) / 180
    const tiltYRad = (safeRotationY * Math.PI) / 180
    const tiltScaleX = Math.max(0.05, Math.cos(tiltYRad))
    const tiltScaleY = Math.max(0.05, Math.cos(tiltXRad))
    const perspectiveSkewX = Math.sin(tiltYRad) * 0.22
    const perspectiveSkewY = -Math.sin(tiltXRad) * 0.22
    ctx.transform(tiltScaleX, perspectiveSkewY, perspectiveSkewX, tiltScaleY, 0, 0)
  }
  ctx.scale(scaleFactorX * depthScale, scaleFactorY * depthScale)
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
  // Opposing crops can sum past 100%: a negative-size ctx.rect traces the
  // rectangle inverted, which would UN-crop a slice instead of hiding all.
  ctx.rect(left, top, Math.max(0, rect.width - left - right), Math.max(0, rect.height - top - bottom))
  ctx.clip()
}

export const hasPerspectiveClipTransform = (transform = {}) => (
  Math.abs(Number(transform?.rotationX) || 0) > 0.001
  || Math.abs(Number(transform?.rotationY) || 0) > 0.001
)

const getVisibleLocalRect = (rect, transform = {}, transitionStyle = null) => {
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

  left = clamp(left, 0, rect.width)
  right = clamp(right, left, rect.width)
  top = clamp(top, 0, rect.height)
  bottom = clamp(bottom, top, rect.height)

  return { left, right, top, bottom, width: right - left, height: bottom - top }
}

const projectClipCorner = (x, y, rect, transform = {}, transitionStyle = null) => {
  const anchorX = Number.isFinite(Number(transform.anchorX)) ? Number(transform.anchorX) : 50
  const anchorY = Number.isFinite(Number(transform.anchorY)) ? Number(transform.anchorY) : 50
  const anchorPxX = rect.width * (anchorX / 100)
  const anchorPxY = rect.height * (anchorY / 100)
  const perspective = clamp(Number(transform.perspective) || 1200, 100, 10000)
  const positionZ = clamp(Number(transform.positionZ) || 0, -20000, perspective - 100)
  const transitionScale = transitionStyle?.scale || 1
  const scaleX = ((Number(transform.scaleX) || 100) / 100) * (transform.flipH ? -1 : 1) * transitionScale
  const scaleY = ((Number(transform.scaleY) || 100) / 100) * (transform.flipV ? -1 : 1) * transitionScale
  const rotation = degToRad(Number(transform.rotation) || 0)
  const rotationX = degToRad(clamp(Number(transform.rotationX) || 0, -89, 89))
  const rotationY = degToRad(clamp(Number(transform.rotationY) || 0, -89, 89))

  let px = (x - anchorPxX) * scaleX
  let py = (y - anchorPxY) * scaleY
  let pz = 0

  if (rotationX) {
    const cos = Math.cos(rotationX)
    const sin = Math.sin(rotationX)
    const nextY = py * cos - pz * sin
    const nextZ = py * sin + pz * cos
    py = nextY
    pz = nextZ
  }

  if (rotationY) {
    const cos = Math.cos(rotationY)
    const sin = Math.sin(rotationY)
    const nextX = px * cos + pz * sin
    const nextZ = -px * sin + pz * cos
    px = nextX
    pz = nextZ
  }

  if (rotation) {
    const cos = Math.cos(rotation)
    const sin = Math.sin(rotation)
    const nextX = px * cos - py * sin
    const nextY = px * sin + py * cos
    px = nextX
    py = nextY
  }

  pz += positionZ
  const projection = clamp(perspective / Math.max(100, perspective - pz), 0.05, 12)
  const centerX = rect.x + anchorPxX + (Number(transform.positionX) || 0) + (transitionStyle?.translateX || 0) * rect.width
  const centerY = rect.y + anchorPxY + (Number(transform.positionY) || 0) + (transitionStyle?.translateY || 0) * rect.height

  return {
    x: centerX + px * projection,
    y: centerY + py * projection,
    projection,
  }
}

const projectClipPoint = (x, y, rect, transform = {}, transitionStyle = null) => {
  const corner = projectClipCorner(x, y, rect, transform, transitionStyle)
  return { x: corner.x, y: corner.y }
}

/**
 * Quad corner data for the GPU compositor: the visible (crop + transition
 * inset) window of a clip projected through the same math as
 * projectClipPoint, with w = 1/projection so the GPU interpolates with true
 * perspective instead of the affine-triangle approximation. Corner order is
 * TL, TR, BL, BR (triangle-strip order). Returns null when nothing is
 * visible.
 */
export const getClipQuadCorners = (rect, transform = {}, transitionStyle = null) => {
  const visible = getVisibleLocalRect(rect, transform, transitionStyle)
  if (visible.width <= 0.01 || visible.height <= 0.01) return null
  const localCorners = [
    [visible.left, visible.top],
    [visible.right, visible.top],
    [visible.left, visible.bottom],
    [visible.right, visible.bottom],
  ]
  const corners = localCorners.map(([localX, localY]) => {
    const projected = projectClipCorner(localX, localY, rect, transform, transitionStyle)
    return {
      x: projected.x,
      y: projected.y,
      u: localX / rect.width,
      v: localY / rect.height,
      w: 1 / projected.projection,
    }
  })
  // Corner pin: offset the projected corners and rebuild the projective
  // weights for the pinned shape (GPU paths only — 2D fallbacks ignore it).
  if (hasActiveCornerPin(transform)) {
    return applyCornerPinToQuad(corners, transform)
  }
  return corners
}

/**
 * Mean device-space scale of a clip transform. Canvas 2D filters (ctx.filter)
 * scale with the transform they're drawn under, so the GPU path — which blurs
 * post-transform in device space — multiplies blur radii by this to match.
 * Anisotropic scales get the isotropic mean; exact for the uniform scales
 * transitions use.
 */
export const getApproxTransformScale = (transform = {}, transitionStyle = null) => {
  const perspective = clamp(Number(transform.perspective) || 1200, 100, 10000)
  const positionZ = clamp(Number(transform.positionZ) || 0, -20000, perspective - 100)
  const depthScale = clamp(perspective / Math.max(100, perspective - positionZ), 0.05, 12)
  const transitionScale = transitionStyle?.scale || 1
  const scaleX = Math.abs((Number(transform.scaleX) || 100) / 100) * transitionScale * depthScale
  const scaleY = Math.abs((Number(transform.scaleY) || 100) / 100) * transitionScale * depthScale
  return (scaleX + scaleY) / 2
}

/**
 * Route color/blur onto the GPU layer chain slots per the 2D recipe a clip
 * would have taken. Shared by the exporter's GPU block and the live
 * preview's GPU path so the routing can never drift between them:
 * - tonal clips: tonal pass post-accumulation, then ONE summed gaussian
 *   (device px, exact — the 2D path blurred at identity transform);
 * - masked clips: color + adjustment blur at composite time (post-mask);
 * - plain clips: per-sample color, adjustment+transform blur stacked as
 *   sqrt(a²+b²) pre-velocity/pre-managed, scaled to device space
 *   (ctx.filter blur scales with the transform it is drawn under).
 */
export const routeGpuLayerColorBlur = ({
  usesTonalAdjustments,
  hasMask,
  adjustmentSettings,
  colorSettings,
  adjustmentBlur,
  transformBlur,
  deviceScale,
}) => {
  if (usesTonalAdjustments) {
    const totalBlur = adjustmentBlur + transformBlur
    return {
      tonalSettings: adjustmentSettings,
      blurPx: totalBlur > 0 ? totalBlur : null,
    }
  }
  if (hasMask) {
    return {
      postColorSettings: colorSettings,
      postBlurPx: adjustmentBlur > 0 ? adjustmentBlur : null,
    }
  }
  const combinedBlur = Math.sqrt(adjustmentBlur * adjustmentBlur + transformBlur * transformBlur)
  return {
    colorSettings,
    preBlurPx: combinedBlur > 0 ? combinedBlur * deviceScale : null,
  }
}

const drawAffineTriangle = (ctx, source, sourceWidth, sourceHeight, s0, s1, s2, d0, d1, d2) => {
  const overlapPx = 1.25
  const centroid = {
    x: (d0.x + d1.x + d2.x) / 3,
    y: (d0.y + d1.y + d2.y) / 3,
  }
  const expand = (point) => {
    const dx = point.x - centroid.x
    const dy = point.y - centroid.y
    const length = Math.hypot(dx, dy) || 1
    return {
      x: point.x + (dx / length) * overlapPx,
      y: point.y + (dy / length) * overlapPx,
    }
  }
  const p0 = expand(d0)
  const p1 = expand(d1)
  const p2 = expand(d2)
  const det = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y)
  if (Math.abs(det) < 0.000001) return

  const a = (p0.x * (s1.y - s2.y) + p1.x * (s2.y - s0.y) + p2.x * (s0.y - s1.y)) / det
  const b = (p0.y * (s1.y - s2.y) + p1.y * (s2.y - s0.y) + p2.y * (s0.y - s1.y)) / det
  const c = (p0.x * (s2.x - s1.x) + p1.x * (s0.x - s2.x) + p2.x * (s1.x - s0.x)) / det
  const d = (p0.y * (s2.x - s1.x) + p1.y * (s0.x - s2.x) + p2.y * (s1.x - s0.x)) / det
  const e = (p0.x * (s1.x * s2.y - s2.x * s1.y) + p1.x * (s2.x * s0.y - s0.x * s2.y) + p2.x * (s0.x * s1.y - s1.x * s0.y)) / det
  const f = (p0.y * (s1.x * s2.y - s2.x * s1.y) + p1.y * (s2.x * s0.y - s0.x * s2.y) + p2.y * (s0.x * s1.y - s1.x * s0.y)) / det

  ctx.save()
  ctx.beginPath()
  ctx.moveTo(p0.x, p0.y)
  ctx.lineTo(p1.x, p1.y)
  ctx.lineTo(p2.x, p2.y)
  ctx.closePath()
  ctx.clip()
  ctx.setTransform(a, b, c, d, e, f)
  ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight)
  ctx.restore()
}

export const drawPerspectiveClipSource = (ctx, source, rect, transform = {}, transitionStyle = null, options = {}) => {
  const sourceWidth = options.sourceWidth || rect.width
  const sourceHeight = options.sourceHeight || rect.height
  const visible = getVisibleLocalRect(rect, transform, transitionStyle)
  if (visible.width <= 0.001 || visible.height <= 0.001) return

  const columns = clamp(Math.ceil(visible.width / 48), 8, 40)
  const rows = clamp(Math.ceil(visible.height / 48), 8, 32)
  const stepX = visible.width / columns
  const stepY = visible.height / rows
  const smoothing = ctx.imageSmoothingEnabled
  ctx.imageSmoothingEnabled = true

  for (let row = 0; row < rows; row += 1) {
    const y0 = visible.top + row * stepY
    const y1 = row === rows - 1 ? visible.bottom : y0 + stepY
    for (let col = 0; col < columns; col += 1) {
      const x0 = visible.left + col * stepX
      const x1 = col === columns - 1 ? visible.right : x0 + stepX
      const s00 = { x: x0, y: y0 }
      const s10 = { x: x1, y: y0 }
      const s11 = { x: x1, y: y1 }
      const s01 = { x: x0, y: y1 }
      const d00 = projectClipPoint(x0, y0, rect, transform, transitionStyle)
      const d10 = projectClipPoint(x1, y0, rect, transform, transitionStyle)
      const d11 = projectClipPoint(x1, y1, rect, transform, transitionStyle)
      const d01 = projectClipPoint(x0, y1, rect, transform, transitionStyle)

      drawAffineTriangle(ctx, source, sourceWidth, sourceHeight, s00, s10, s11, d00, d10, d11)
      drawAffineTriangle(ctx, source, sourceWidth, sourceHeight, s00, s11, s01, d00, d11, d01)
    }
  }

  ctx.imageSmoothingEnabled = smoothing
}

const hasManagedPixelOrVignetteEffect = (clip, clipTime) => {
  if (!clip) return false
  const effects = getRenderEffects(clip)
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
  const effects = getRenderEffects(clip)
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

export const drawText = (ctx, rect, clip, textScale = 1, clipTime = null) => {
  const inheritedAlpha = Number.isFinite(ctx.globalAlpha) ? ctx.globalAlpha : 1
  const textProps = clipTime == null
    ? (clip.textProperties || {})
    : getAnimatedTextProperties(clip, clipTime)
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
  
  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${quoteCssFontFamily(fontFamily)}`
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
    ctx.globalAlpha = inheritedAlpha * clamp(textProps.backgroundOpacity, 0, 1)
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight)
    ctx.restore()
  }
  
  ctx.fillStyle = textProps.textColor || '#FFFFFF'
  ctx.globalAlpha = inheritedAlpha
  
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

const getMaskFrameInfo = (clip, maskAsset, time, allowHandles = false) => {
  if (!maskAsset) return null
  // Mask sequences are indexed in the original asset's time domain. Never
  // use cache-relative Optical Flow seconds here, or a slowed/ramped clip's
  // picture and mask drift apart.
  const sourceTime = getClipPlaybackTimeAtTimeline(clip, time, 0.001, {
    useFrameSampling: false,
    allowHandles,
  })
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

/**
 * Approximate source time for a clip at a timeline time — same math as the
 * draw loop's inline computation (minus the video-element duration
 * fallback). Used only to warm frame cursors in parallel before the serial
 * draw loop; the draw loop's own computation stays authoritative.
 */
const getPreSeekSourceTime = (
  clip,
  timelineTime,
  usingCached,
  opticalFlowCache = null,
  allowHandles = false
) => {
  const clipTime = timelineTime - (clip.startTime || 0)
  if (usingCached) {
    return clamp(clipTime, 0, Math.max(0, (Number(clip.duration) || 0) - 0.01))
  }
  const clampedSourceTime = getClipPlaybackTimeAtTimeline(clip, timelineTime, 0.001, {
    useFrameSampling: false,
    allowHandles,
  })
  if (opticalFlowCache) {
    const mapping = mapOriginalSourceTimeToOpticalFlowCache(clip, clampedSourceTime, {
      requireUrl: false,
      endOffset: 0.001,
      handleSeconds: opticalFlowCache.handleSeconds,
    })
    if (mapping) return mapping.time
  }
  return clampedSourceTime
}

// ---------------------------------------------------------------------------
// Audio mix payload builders — shared by the audio-only export, the
// pre-render audio validation, and the full export's mix call. One source of
// truth on purpose: if the payload the validator checks ever drifted from the
// payload the mix receives, the fail-fast would approve exports the real mix
// then breaks.
const serializeAudioClipForMix = (clip) => ({
  id: clip.id,
  assetId: clip.assetId,
  trackId: clip.trackId,
  // Audio-track placement is authoritative for legacy split fragments whose
  // persisted clip type was accidentally changed to "video".
  type: 'audio',
  startTime: clip.startTime,
  duration: clip.duration,
  playbackWindowStart: clip.playbackWindowStart,
  playbackWindowEnd: clip.playbackWindowEnd,
  trimStart: clip.trimStart || 0,
  sourceTimeScale: clip.sourceTimeScale,
  timelineFps: clip.timelineFps,
  sourceFps: clip.sourceFps,
  speed: clip.speed,
  reverse: clip.reverse,
  gainDb: normalizeAudioClipGainDb(clip.gainDb),
  fadeIn: clip.fadeIn ?? 0,
  fadeOut: clip.fadeOut ?? 0,
  volumeEnvelope: normalizeAudioVolumeEnvelope(clip.volumeEnvelope),
  audioEq: normalizeAudioEq(clip.audioEq),
  url: clip.url || null,
})

const serializeAudioAssetsForMix = (assets) => (assets || []).map(asset => ({
  id: asset.id,
  type: asset.type,
  name: asset.name || null,
  path: asset.path || null,
  url: asset.url || null,
}))

const serializeAudioTracksForMix = (tracks) => (tracks || [])
  .filter(track => track.type === 'audio')
  .map(track => ({
    id: track.id,
    type: track.type,
    muted: !!track.muted,
    visible: track.visible !== false,
    channels: track.channels || 'stereo',
    volume: track.volume ?? 100,
    pan: track.pan ?? 0,
  }))

const collectEligibleAudioMix = (timelineState) => {
  const audioClips = collectAudioMixClips(timelineState.clips, timelineState.tracks)
  const anyAudioSolo = hasAudioSolo(timelineState.tracks)
  const activeTracks = timelineState.tracks.filter(t => t.type === 'audio' && isAudioTrackAudible(t, anyAudioSolo))
  const activeTrackIds = new Set(activeTracks.map(track => track.id))
  const eligibleAudioClips = audioClips.filter(clip => activeTrackIds.has(clip.trackId))
  return { audioClips, activeTracks, eligibleAudioClips }
}

// Human-readable verdict for clips the FFmpeg mix dropped. Only `problem`
// skips are listed — a reversed or out-of-range clip is expected to be
// absent. "Audio mix included 38 of 50 clips" cost a real user a support
// session; file names make the fix self-serve.
const AUDIO_MIX_SKIP_LABELS = {
  'file-not-found': 'file not found — relink or restore it',
  'missing-asset-record': 'asset record missing from the project',
  'track-not-audible': 'track state disagreement',
  'invalid-time-scale': 'invalid speed/time scale',
  'zero-source-duration': 'no source audio in range',
}
const formatAudioMixDropError = (skipped, includedCount, expectedCount) => {
  const problems = (Array.isArray(skipped) ? skipped : []).filter(entry => entry?.problem)
  const grouped = new Map()
  for (const entry of problems) {
    const label = AUDIO_MIX_SKIP_LABELS[entry.reason] || entry.reason
    const key = `${entry.assetName || 'unknown clip'} (${label})`
    grouped.set(key, (grouped.get(key) || 0) + 1)
  }
  const details = Array.from(grouped.entries())
    .map(([key, count]) => (count > 1 ? `${count} clips of ${key}` : key))
  const head = `Audio mix included ${includedCount} of ${expectedCount} clips.`
  if (details.length === 0) return head
  return `${head} Dropped: ${details.join('; ')}`
}

const runExportTimeline = async (options, onProgress, scheduler) => {
  // Compound children are a read-only render view. Preserve their original
  // local clocks; parent trims limit visibility rather than slicing media.
  const timelineState = getCompoundRenderState(useTimelineStore.getState())
  if (timelineState.compoundRenderErrors?.length > 0) {
    throw new Error(`Cannot export: ${timelineState.compoundRenderErrors.join(' ')}`)
  }
  const assetsState = useAssetsStore.getState()
  const projectState = useProjectStore.getState()
  // LUT grades read the in-memory library synchronously mid-frame; make sure
  // it is primed before the first frame composites (no-op after first load).
  await loadLutLibrary()
  
  const {
    fps = 24,
    width = 1920,
    height = 1080,
    rangeStart = 0,
    rangeEnd = timelineState.getTimelineEndTime(),
    format = 'mp4',
    includeAudio: requestedIncludeAudio = true,
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
    normalizeAudio = false,
    loudnessTarget = -14,
    useCachedRenders = true,
    useProxyMedia = false,
    fastSeek = true,
    useDirectFramePipe: requestedDirectFramePipe = true,
    deliveryFraming = 'fit',
    glslQualityScale = 1,
    // Final exports sample each frame at its temporal center (pairs with
    // the centered-shutter motion blur). Preview substitutes (In→Out
    // flattens, chunk cache, timeline proxies) pass false so animated
    // values match live playback frame-for-frame — half a frame of motion
    // is a visible position shift on moving elements.
    sampleAtFrameCenter = true,
    signal = null,
    // Per-clip render bakes: render ONLY these clips (no neighbors, no
    // transitions) over the range, onto a transparent canvas so the baked
    // file still composites over lower layers.
    soloClipIds = null,
    transparent: requestedTransparency = false,
  } = options
  const pngSequenceExport = format === 'png-seq'
  const gifExport = format === 'gif'
  const losslessFrameDelivery = pngSequenceExport || gifExport
  // Image sequences and animated GIFs are visual-only deliveries. GIF uses
  // the lossless PNG-frame path deliberately: a global palette on the live
  // raw pipe buffers the entire animation and can consume multiple GB.
  const includeAudio = losslessFrameDelivery ? false : requestedIncludeAudio
  const useDirectFramePipe = losslessFrameDelivery ? false : requestedDirectFramePipe
  // Image-sequence and GIF transparency remain separate follow-up work.
  // V1 delivery supports WebM and ProRes 4444 only.
  const transparent = losslessFrameDelivery ? false : requestedTransparency
  if (transparent && !supportsTransparentExport({ format, proresProfile })) {
    throw new Error('Transparent export requires WebM (VP9) or ProRes 4444.')
  }
  const pngSequenceBaseName = pngSequenceExport
    ? sanitizePngSequenceBaseName(filename)
    : null
  const expandedSoloClipIds = Array.isArray(soloClipIds) && soloClipIds.length > 0
    ? timelineState.clips
      .filter((clip) => soloClipIds.includes(clip.id) || soloClipIds.includes(clip.compoundParentId))
      .map((clip) => clip.id)
    : null
  const soloClipSet = expandedSoloClipIds
    ? new Set(expandedSoloClipIds)
    : null
  if (soloClipSet?.size === 0) {
    throw new Error('The requested export clips have no available contents. Review the selection before exporting.')
  }
  const throwIfCancelled = () => {
    if (signal?.aborted) {
      throw new Error('Export cancelled')
    }
  }
  
  const totalDuration = Math.max(0, rangeEnd - rangeStart)
  const totalFrames = Math.ceil(totalDuration * fps)
  if (losslessFrameDelivery && (!Number.isFinite(Number(fps)) || Number(fps) <= 0 || totalFrames <= 0)) {
    throw new Error(`The ${gifExport ? 'GIF' : 'PNG sequence'} export range must contain at least one frame at a valid FPS.`)
  }
  if (losslessFrameDelivery && (!Number.isFinite(Number(width)) || Number(width) <= 0 || !Number.isFinite(Number(height)) || Number(height) <= 0)) {
    throw new Error(`The ${gifExport ? 'GIF' : 'PNG sequence'} export dimensions must be greater than zero.`)
  }
  const normalizedDeliveryFraming = ['fill', 'cover', 'center_crop', 'center-crop'].includes(String(deliveryFraming || '').toLowerCase())
    ? 'fill'
    : 'fit'
  const sourceWidthForFraming = Math.max(1, Number(sourceTimelineWidth) || width)
  const sourceHeightForFraming = Math.max(1, Number(sourceTimelineHeight) || height)
  const fillTransformScale = Math.max(width / sourceWidthForFraming, height / sourceHeightForFraming)
  const transformScaleX = normalizedDeliveryFraming === 'fill' ? fillTransformScale : width / sourceWidthForFraming
  const transformScaleY = normalizedDeliveryFraming === 'fill' ? fillTransformScale : height / sourceHeightForFraming
  const textStyleScale = Math.min(transformScaleX, transformScaleY)
  const scaleTransformToExport = (transform = {}) => ({
    ...transform,
    // Position is stored in timeline pixels. When exporting at half/quarter
    // resolution, scale those offsets into the smaller export canvas so clips
    // stay in the same visual location instead of moving off-frame.
    positionX: (Number(transform.positionX) || 0) * transformScaleX,
    positionY: (Number(transform.positionY) || 0) * transformScaleY,
    // Corner pin offsets are timeline pixels too.
    cornerPinTLX: (Number(transform.cornerPinTLX) || 0) * transformScaleX,
    cornerPinTLY: (Number(transform.cornerPinTLY) || 0) * transformScaleY,
    cornerPinTRX: (Number(transform.cornerPinTRX) || 0) * transformScaleX,
    cornerPinTRY: (Number(transform.cornerPinTRY) || 0) * transformScaleY,
    cornerPinBLX: (Number(transform.cornerPinBLX) || 0) * transformScaleX,
    cornerPinBLY: (Number(transform.cornerPinBLY) || 0) * transformScaleY,
    cornerPinBRX: (Number(transform.cornerPinBRX) || 0) * transformScaleX,
    cornerPinBRY: (Number(transform.cornerPinBRY) || 0) * transformScaleY,
  })
  
  if (!projectState.currentProjectHandle || typeof projectState.currentProjectHandle !== 'string') {
    throw new Error('Project folder not available for export.')
  }
  
  const outputFolder = await window.electronAPI.pathJoin(projectState.currentProjectHandle, 'renders')
  if (!pngSequenceExport) {
    await window.electronAPI.createDirectory(outputFolder)
  }

  const audioOnlyExport = format === 'audio'
  const outputExtension = audioOnlyExport
    ? (audioCodec === 'mp3' ? 'mp3' : (audioCodec === 'wav' ? 'wav' : 'm4a'))
    : (gifExport ? 'gif' : (format === 'webm' ? 'webm' : (format === 'prores' ? 'mov' : 'mp4')))
  let outputPath = options.outputPath
  if (pngSequenceExport && !outputPath) {
    throw new Error('Choose an output folder for the PNG sequence.')
  }
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

  // The wrapper creates and owns the fresh sequence directory. Temporary
  // prepared sources live under that owned directory so a failed/cancelled
  // export can remove everything without ever touching the selected parent.
  const tempFolder = pngSequenceExport
    ? await window.electronAPI.pathJoin(outputPath, '.velorn-export-temp')
    : await window.electronAPI.pathJoin(outputFolder, `export_${Date.now()}`)
  if (pngSequenceExport) {
    const tempFolderResult = await window.electronAPI.createDirectory(tempFolder, { recursive: false })
    if (!tempFolderResult?.success) {
      throw new Error(tempFolderResult?.error || 'Failed to create the export temporary folder.')
    }
  } else {
    await window.electronAPI.createDirectory(tempFolder)
  }
  let gifTempCleanupAttempted = false
  const cleanupGifTempFolder = async () => {
    gifTempCleanupAttempted = true
    try {
      const cleanup = await window.electronAPI.deleteDirectory(tempFolder, { recursive: true })
      return cleanup?.success === false
        ? (cleanup.error || 'Unknown temporary-folder cleanup error.')
        : null
    } catch (error) {
      return error?.message || String(error)
    }
  }
  try {
  const framesFolder = pngSequenceExport
    ? outputPath
    : await window.electronAPI.pathJoin(tempFolder, 'frames')
  if (!pngSequenceExport) {
    await window.electronAPI.createDirectory(framesFolder)
  }

  const framePattern = await window.electronAPI.pathJoin(
    framesFolder,
    pngSequenceExport ? getPngSequenceFramePattern(pngSequenceBaseName) : 'frame_%06d.png'
  )
  const audioPath = await window.electronAPI.pathJoin(tempFolder, 'audio.wav')

  // ---- Audio-only export: the exact program mix a video export bakes in,
  // written straight to an audio file. No canvas, no frame pipe — a timeline
  // whose video takes an hour to render delivers its audio in about a minute.
  if (audioOnlyExport) {
    const audioStartTime = Date.now()
    const updateAudioStatus = (message, progress) => {
      const elapsed = ((Date.now() - audioStartTime) / 1000).toFixed(1)
      onProgress({ status: `Mixing audio (${elapsed}s) • ${message}`, progress })
    }
    try {
      if (!window.electronAPI?.mixAudio) {
        throw new Error('Audio-only export requires the desktop app.')
      }
      const { audioClips, activeTracks, eligibleAudioClips } = collectEligibleAudioMix(timelineState)
      if (audioClips.length === 0 || activeTracks.length === 0 || eligibleAudioClips.length === 0) {
        throw new Error('No audible audio clips to export — unmute or solo an audio track first.')
      }
      const expectedMixClipCount = countExpectedAudioMixClips(eligibleAudioClips, rangeStart, rangeEnd)
      if (expectedMixClipCount === 0) {
        throw new Error('No audio clips inside the export range.')
      }
      // Mixer insert effects (EQ etc.) run through the stem path, which is
      // not wired into this branch yet. Refuse loudly rather than deliver
      // audio that does not match playback.
      const enabledMasterInserts = getEnabledAudioInserts(timelineState.masterAudioInserts)
      const anyInsertEffects = enabledMasterInserts.length > 0
        || activeTracks.some(track => hasEnabledAudioInserts(track.inserts))
      if (anyInsertEffects) {
        throw new Error('Audio-only export does not support mixer insert effects yet — bypass them or use a video export.')
      }

      const masterAudioGain = clampTrackVolume(timelineState.masterAudioVolume) / 100
      const wavIsFinal = outputExtension === 'wav' && !normalizeAudio
      const mixTarget = wavIsFinal ? outputPath : audioPath
      updateAudioStatus('Preparing FFmpeg audio mix…', 10)
      const mixResult = await window.electronAPI.mixAudio({
        projectPath: projectState.currentProjectHandle,
        outputPath: mixTarget,
        rangeStart,
        rangeEnd,
        sampleRate: audioSampleRate || DEFAULT_SAMPLE_RATE,
        channels: audioChannels || 2,
        masterVolume: masterAudioGain * 100,
        timeoutMs: AUDIO_MIX_TIMEOUT_MS,
        clips: eligibleAudioClips.map(serializeAudioClipForMix),
        tracks: serializeAudioTracksForMix(timelineState.tracks),
        assets: serializeAudioAssetsForMix(assetsState.assets),
      })
      console.log('[audio-mix] FFmpeg result', JSON.stringify(mixResult))
      if (!mixResult?.success) {
        throw new Error(mixResult?.error || 'FFmpeg audio mix failed')
      }
      if (mixResult.clipCount !== expectedMixClipCount) {
        throw new Error(formatAudioMixDropError(mixResult.skipped, mixResult.clipCount || 0, expectedMixClipCount))
      }
      if (!wavIsFinal) {
        updateAudioStatus(`Encoding ${outputExtension.toUpperCase()}…`, 80)
        const encodeResult = await window.electronAPI.encodeAudioFile({
          inputPath: mixTarget,
          outputPath,
          audioCodec: outputExtension === 'mp3' ? 'mp3' : (outputExtension === 'wav' ? 'wav' : 'aac'),
          audioBitrateKbps,
          audioSampleRate: audioSampleRate || DEFAULT_SAMPLE_RATE,
          audioChannels: audioChannels || 2,
          normalizeAudio,
          loudnessTarget,
        })
        if (!encodeResult?.success) {
          throw new Error(encodeResult?.error || 'Audio encode failed')
        }
      }
      onProgress({ status: EXPORT_STATUS.done, progress: 100 })
      return {
        outputPath,
        encoderUsed: outputExtension,
        hardwareFallback: false,
        frameSources: null,
        perf: null,
      }
    } finally {
      try {
        await window.electronAPI.deleteDirectory(tempFolder, { recursive: true })
      } catch (err) {
        console.warn('Failed to clean export temp folder:', err)
      }
    }
  }

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

  // Fail fast: validate the audio mix inputs BEFORE rendering any frames.
  // The dropped-clip class of failure (missing or unlinked files) is
  // knowable in milliseconds; discovering it after the frame render wasted
  // 95 minutes on a real user's hour-long timeline. validateOnly runs the
  // mixer's exact per-clip filter without touching FFmpeg.
  if (includeAudio && window.electronAPI?.mixAudio) {
    const { audioClips, activeTracks, eligibleAudioClips } = collectEligibleAudioMix(timelineState)
    if (audioClips.length > 0 && activeTracks.length > 0 && eligibleAudioClips.length > 0) {
      const expectedMixClipCount = countExpectedAudioMixClips(eligibleAudioClips, rangeStart, rangeEnd)
      if (expectedMixClipCount > 0) {
        onProgress({ status: 'Checking audio sources...', progress: 3 })
        const audioCheck = await window.electronAPI.mixAudio({
          validateOnly: true,
          projectPath: projectState.currentProjectHandle,
          rangeStart,
          rangeEnd,
          clips: eligibleAudioClips.map(serializeAudioClipForMix),
          tracks: serializeAudioTracksForMix(timelineState.tracks),
          assets: serializeAudioAssetsForMix(assetsState.assets),
        })
        // An older main process without validateOnly answers with a mix
        // error about the missing output path — only act on a clean
        // validation verdict and let the real mix decide otherwise.
        if (audioCheck?.success && audioCheck.validateOnly && audioCheck.clipCount !== expectedMixClipCount) {
          throw new Error(formatAudioMixDropError(audioCheck.skipped, audioCheck.clipCount || 0, expectedMixClipCount))
        }
      }
    }
  }

  let framePipeSessionId = null
  let framePipeEncoderUsed = null
  let framePipeHardwareFallback = null
  let framePipeHardwareFfmpeg = null
  
  onProgress({ status: EXPORT_STATUS.preparing, progress: 2 })
  
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: !!transparent })
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
  const failedVideoSourceNames = new Map()
  const imageElements = new Map()
  const maskElements = new Map()
  const maskRenderBuffers = new Map()
  const cachedVideoSources = new Map()
  const opticalFlowSources = new Map()
  const resolvedClipSourceUrls = new Map()
  const webCodecsEnabled = isWebCodecsExportEnabled()

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
  
  // Full render bakes (cacheKind 'full') turn any clip type — including
  // text/shape — into a video source, so they ride the video loading path.
  // Stale bakes (content signature mismatch) are excluded and render live.
  const videoClips = timelineState.clips.filter(c => (
    c.type === 'video'
    || (useCachedRenders && isFullBakeFresh(c))
  ))
  const imageClips = timelineState.clips.filter(c => c.type === 'image')

  // Optical Flow is an explicit export dependency, but only for clips that
  // can actually contribute to this render. Hidden, disabled, out-of-range,
  // and non-solo clips must not block an unrelated In→Out or solo export.
  // Between-transition participants are included for their spill range even
  // when their nominal clip interval does not overlap the export range.
  const renderableVideoClipIds = getRenderableVideoClipIds({
    clips: timelineState.clips,
    tracks: timelineState.tracks,
    transitions: timelineState.transitions,
    rangeStart,
    rangeEnd,
    soloClipIds: soloClipSet ? [...soloClipSet] : null,
  })
  const renderableVideoClips = videoClips.filter((clip) => renderableVideoClipIds.has(clip.id))
  const renderableImageClips = imageClips.filter((clip) => !clip.compoundParentId || renderableVideoClipIds.has(clip.id))

  if (useCachedRenders) {
    for (const clip of renderableVideoClips) {
      if (clip.cacheStatus !== 'cached') continue
      if (
        clip.cacheKind !== 'full'
        && normalizeFrameSamplingMode(clip.frameSampling) === FRAME_SAMPLING_MODE.OPTICAL_FLOW
      ) continue
      // Full bakes must match the clip's current content; legacy (mask)
      // bakes keep the old status-only contract.
      if (clip.cacheKind === 'full' && !isFullBakeFresh(clip)) continue
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

  for (const clip of renderableVideoClips) {
    if (clip.type !== 'video' || cachedVideoSources.has(clip.id)) continue
    if (normalizeFrameSamplingMode(clip.frameSampling) !== FRAME_SAMPLING_MODE.OPTICAL_FLOW) continue
    const handleSeconds = getRequiredOpticalFlowHandleSeconds(
      clip,
      timelineState.transitions,
      timelineState.clips
    )
    const usability = getOpticalFlowCacheUsability(clip, {
      requireUrl: false,
      timelineFps: Number(clip.timelineFps) || Number(timelineState.timelineFps) || 24,
      sourceFps: clip.sourceFps,
      handleSeconds,
    })
    if (!usability.usable) {
      throw new Error(
        `Cannot export — Optical Flow is selected for "${clip.name || clip.id}", but its cache is not ready or no longer covers this edit. `
        + 'Build or rebuild Optical Flow in the Inspector, or choose Frame sampling.'
      )
    }
    if (!isSafeOpticalFlowCachePath(usability.cache.path)) {
      throw new Error(`Cannot export — the Optical Flow cache path for "${clip.name || clip.id}" is invalid. Rebuild it from the Inspector.`)
    }
    if (typeof projectState.currentProjectHandle !== 'string' || !projectState.currentProjectHandle) {
      throw new Error('Cannot export Optical Flow from an unsaved project. Save the project and rebuild the cache.')
    }
    const sourceAsset = assetsState.getAssetById(clip.assetId)
    const currentSourceSignature = await getExportAssetSignature(
      sourceAsset,
      projectState.currentProjectHandle
    )
    if (
      !usability.cache.sourceSignature
      || !currentSourceSignature
      || currentSourceSignature !== usability.cache.sourceSignature
    ) {
      throw new Error(
        `Cannot export — the source media for "${clip.name || clip.id}" changed or is offline. `
        + 'Relink it if needed, then rebuild Optical Flow in the Inspector.'
      )
    }
    let cachePath = null
    try {
      cachePath = await window.electronAPI.pathJoin(projectState.currentProjectHandle, usability.cache.path)
    } catch (error) {
      throw new Error(`Cannot export — the Optical Flow cache path for "${clip.name || clip.id}" could not be resolved (${getMediaErrorMessage(error)}).`)
    }
    if (!window.electronAPI?.exists || !(await window.electronAPI.exists(cachePath))) {
      throw new Error(
        `Cannot export — the Optical Flow cache file for "${clip.name || clip.id}" is missing. `
        + 'Rebuild Optical Flow in the Inspector.'
      )
    }
    try {
      const cacheUrl = usability.cache.url || await window.electronAPI.getFileUrlDirect(cachePath)
      if (!cacheUrl) throw new Error('cache URL unavailable')
      opticalFlowSources.set(clip.id, { ...usability.cache, url: cacheUrl, handleSeconds })
    } catch (error) {
      throw new Error(`Cannot export — the Optical Flow cache for "${clip.name || clip.id}" could not be opened (${getMediaErrorMessage(error)}).`)
    }
  }
  
  const projectHandle = projectState.currentProjectHandle
  const resolvedAssetUrls = new Map()
  const resolvedVideoInputPaths = new Map()
  for (const clip of [...renderableVideoClips, ...renderableImageClips]) {
    const overrideUrl = cachedVideoSources.get(clip.id) || opticalFlowSources.get(clip.id)?.url || null
    const asset = assetsState.getAssetById(clip.assetId)
    // Baked text/shape clips have no asset; their only source is the bake.
    if (!asset?.url && !overrideUrl) continue
    const proxyUrl = clip.type === 'video' && useProxyMedia && asset
      ? await getExportProxyUrl(asset, projectHandle)
      : null
    const resolvedUrl = proxyUrl || (asset?.url ? await getExportAssetUrl(asset, projectHandle) : null)
    if (!resolvedUrl && !overrideUrl) continue
    if (resolvedUrl && clip.assetId) resolvedAssetUrls.set(clip.assetId, resolvedUrl)
    if (clip.type === 'video' || overrideUrl) {
      const sourceUrl = overrideUrl || resolvedUrl
      if (!sourceUrl) continue
      resolvedClipSourceUrls.set(clip.id, sourceUrl)
      if (!overrideUrl && !resolvedVideoInputPaths.has(sourceUrl)) {
        let inputPath = null
        if (proxyUrl && asset?.proxyPath) {
          try {
            inputPath = await window.electronAPI.pathJoin(projectHandle, asset.proxyPath)
          } catch (err) {
            console.warn('Export: could not resolve local proxy path:', asset.name, err)
          }
        } else {
          inputPath = await getExportAssetPath(asset, projectHandle)
        }
        if (inputPath) resolvedVideoInputPaths.set(sourceUrl, inputPath)
      }
      if (!videoElements.has(sourceUrl) && !failedVideoSources.has(sourceUrl)) {
        try {
          const video = await loadVideo(sourceUrl)
          if (!video.videoWidth || !video.videoHeight) {
            throw new Error('Source has no decodable video stream')
          }
          videoElements.set(sourceUrl, video)
        } catch (err) {
          failedVideoSources.add(sourceUrl)
          failedVideoSourceNames.set(sourceUrl, {
            name: asset?.name || sourceUrl,
            reason: getMediaErrorMessage(err),
          })
          console.warn('[Export] Undecodable video source:', sourceUrl, getMediaErrorMessage(err))
        }
      }
    } else if (clip.type === 'image') {
      if (!imageElements.has(resolvedUrl)) {
        imageElements.set(resolvedUrl, await loadImage(resolvedUrl))
      }
    }
  }

  // Long sources and clips with deep source in-points need one extra safety
  // step before the sequential decoder can use them. The main process first
  // checks whether the movie index is already at the front; when it is not,
  // FFmpeg makes a temporary video-only stream copy with no quality loss.
  // Preparation is per source (not per clip), and any failure keeps the
  // conservative video-element path available.
  const preparedFrameSourceUrls = new Map()
  const sourcePreparation = { candidates: 0, reused: 0, remuxed: 0, transcoded: 0, failed: 0 }
  if (webCodecsEnabled && window.electronAPI?.prepareVideoSourceForExport) {
    const candidates = new Map()
    for (const clip of renderableVideoClips) {
      if (clip.type !== 'video' || clip.reverse || cachedVideoSources.has(clip.id) || opticalFlowSources.has(clip.id)) continue
      const asset = assetsState.getAssetById(clip.assetId)
      if (asset?.settings?.hasAlpha === true) continue
      const sourceUrl = resolvedClipSourceUrls.get(clip.id)
      const sourceVideo = sourceUrl ? videoElements.get(sourceUrl) : null
      if (!sourceUrl || !sourceVideo || candidates.has(sourceUrl)) continue
      const cursorStartTime = Math.max(0, (Number(clip.trimStart) || 0) - 1.5)
      const needsPreparation = needsWebCodecsSourcePreparation({
        sourceDuration: sourceVideo.duration,
        startTime: cursorStartTime,
      })
      if (!needsPreparation) continue
      candidates.set(sourceUrl, {
        sourceUrl,
        inputPath: resolvedVideoInputPaths.get(sourceUrl) || null,
        sourceName: asset?.name || `clip ${clip.id}`,
        mode: 'remux',
      })
    }

    // Sources the renderer cannot decode at all (ProRes, DNx, ...) become
    // transcode candidates: a one-time visually-transparent H.264
    // intermediate in the export temp folder stands in for them. This
    // overrides a long-source remux candidacy — a stream copy of an
    // undecodable codec would still be undecodable.
    for (const clip of renderableVideoClips) {
      if (clip.type !== 'video' || cachedVideoSources.has(clip.id) || opticalFlowSources.has(clip.id)) continue
      const asset = assetsState.getAssetById(clip.assetId)
      if (asset?.settings?.hasAlpha === true) continue
      const sourceUrl = resolvedClipSourceUrls.get(clip.id)
      if (!sourceUrl || !failedVideoSourceNames.has(sourceUrl)) continue
      if (candidates.get(sourceUrl)?.mode === 'transcode') continue
      candidates.set(sourceUrl, {
        sourceUrl,
        inputPath: resolvedVideoInputPaths.get(sourceUrl) || null,
        sourceName: asset?.name || `clip ${clip.id}`,
        mode: 'transcode',
      })
    }

    sourcePreparation.candidates = candidates.size
    let sourceIndex = 0
    for (const candidate of candidates.values()) {
      sourceIndex += 1
      throwIfCancelled()
      if (!candidate.inputPath) {
        sourcePreparation.failed += 1
        console.warn(`[Export] Cannot prepare ${candidate.sourceName}: no local source path is available`)
        continue
      }

      onProgress({
        status: `Preparing source ${sourceIndex}/${candidates.size}: ${candidate.sourceName}`,
        progress: 3,
      })
      const preparedPath = await window.electronAPI.pathJoin(tempFolder, `prepared_source_${sourceIndex}.mp4`)
      let result = null
      try {
        result = await window.electronAPI.prepareVideoSourceForExport({
          inputPath: candidate.inputPath,
          outputPath: preparedPath,
          mode: candidate.mode || 'remux',
        })
      } catch (err) {
        result = { success: false, error: getMediaErrorMessage(err) }
      }

      if (!result?.success) {
        sourcePreparation.failed += 1
        console.warn(`[Export] Could not prepare ${candidate.sourceName}; standard decoder remains available: ${result?.error || 'unknown error'}`)
        continue
      }

      if (result.prepared) {
        const preparedUrl = await window.electronAPI.getFileUrlDirect(result.outputPath || preparedPath)
        preparedFrameSourceUrls.set(candidate.sourceUrl, preparedUrl)
        if (candidate.mode === 'transcode') {
          // The original stays undecodable for the element path, so point
          // every downstream consumer (element fallback, duration reads) at
          // the intermediate as well; only then clear the failure record.
          try {
            const video = await loadVideo(preparedUrl)
            if (!video.videoWidth || !video.videoHeight) {
              throw new Error('Prepared intermediate has no decodable video stream')
            }
            videoElements.set(candidate.sourceUrl, video)
            failedVideoSources.delete(candidate.sourceUrl)
            failedVideoSourceNames.delete(candidate.sourceUrl)
            sourcePreparation.transcoded += 1
            console.log(`[Export] Prepared ${candidate.sourceName} as an H.264 intermediate (source codec is not decodable in the renderer)`)
          } catch (err) {
            sourcePreparation.failed += 1
            console.warn(`[Export] Prepared intermediate for ${candidate.sourceName} did not load: ${getMediaErrorMessage(err)}`)
          }
          continue
        }
        sourcePreparation.remuxed += 1
        console.log(`[Export] Prepared ${candidate.sourceName} for fast sequential decoding with a lossless stream copy`)
      } else {
        preparedFrameSourceUrls.set(candidate.sourceUrl, candidate.sourceUrl)
        sourcePreparation.reused += 1
        console.log(`[Export] ${candidate.sourceName} is already optimized for fast sequential decoding`)
      }
    }
  }

  // Fail loudly on any source still undecodable after preparation (or when
  // preparation is unavailable: web build, WebCodecs kill switch, missing
  // local path, failed transcode) — its clips would silently render black
  // through the whole export while the audio mix still works.
  if (failedVideoSourceNames.size > 0) {
    const affected = []
    for (const clip of renderableVideoClips) {
      if (clip.type !== 'video') continue
      const clipUrl = resolvedClipSourceUrls.get(clip.id)
      const failure = clipUrl ? failedVideoSourceNames.get(clipUrl) : null
      if (failure && !affected.some((entry) => entry.name === failure.name)) {
        affected.push(failure)
      }
    }
    if (affected.length > 0) {
      throw new Error(
        `Cannot export — ${affected.length === 1 ? 'a source' : `${affected.length} sources`} on the timeline cannot be decoded and would render black: `
        + affected.map((entry) => `${entry.name} (${entry.reason})`).join('; ')
        + '. Convert to H.264, or remove/disable the affected clips.'
      )
    }
  }
  
  // WebCodecs sequential decode (see exportFrameSource.js). Random-access
  // <video> seeks dominate export time; qualifying clips route through a
  // per-clip sequential decoder instead, falling back to the element path
  // per clip on any doubt. Kill switch: localStorage
  // 'comfystudio-export-webcodecs' = '0'.
  const FRAME_CURSOR_PREFETCH_SEC = 3
  // Per-phase wall-clock accumulators, surfaced in the completion payload so
  // a single export run shows where render time actually goes.
  const exportPerf = { progressYieldMs: 0, taskYieldMs: 0, layersMs: 0, sampleMs: 0, readbackMs: 0, pipeMs: 0, preSeekBatches: 0, preSeekClips: 0 }
  resetFrameSourceStats()
  // Pipe writes stack up to a small in-flight depth so the renderer's
  // structured-clone serialize, the main process's handling, and FFmpeg's
  // stdin write overlap across frames instead of running as one serial
  // round trip per frame. Order into FFmpeg's stdin is preserved: writes
  // fire and settle strictly FIFO, and Electron delivers same-channel
  // messages in send order. invoke() serializes its arguments
  // synchronously, so a queued frame's buffer may be reused as soon as the
  // call returns.
  const exportPipelineEnabled = isExportPipelineEnabled()
  const maxInFlightPipeWrites = exportPipelineEnabled ? 3 : 1
  const inFlightPipeWrites = []
  const pendingGpuReadbacks = []
  const settleOldestPipeWrite = async () => {
    const result = await inFlightPipeWrites.shift()
    if (!result?.success) {
      throw new Error(result?.error || 'Failed to write frame to FFmpeg pipe.')
    }
  }
  const sendFrameToPipe = async (frameBuffer) => {
    const pipeWriteStart = performance.now()
    while (inFlightPipeWrites.length >= maxInFlightPipeWrites) {
      await settleOldestPipeWrite()
    }
    inFlightPipeWrites.push(window.electronAPI.writeFrameToPipe(framePipeSessionId, frameBuffer))
    exportPerf.pipeMs += performance.now() - pipeWriteStart
  }
  // GPU frames are collected one frame late (fence + PBO in the compositor)
  // so the loop never blocks on the GPU finishing the frame it just
  // composited.
  const sendOldestGpuReadback = async () => {
    const readbackStart = performance.now()
    const pixels = await gpu.resolveFrameReadback(pendingGpuReadbacks.shift())
    exportPerf.readbackMs += performance.now() - readbackStart
    await sendFrameToPipe(pixels.buffer)
  }
  const clipFrameCursors = new Map() // clipId -> { promise, cursor, settled, clipEnd }
  const standardDecoderClipIds = new Set()
  const loggedStandardDecoderSources = new Set()
  let webCodecsClipCount = 0
  let elementPathClipCount = 0
  const countedClipPaths = new Set()
  const countClipPath = (clipId, usedCursor) => {
    if (countedClipPaths.has(clipId)) return
    countedClipPaths.add(clipId)
    if (usedCursor) webCodecsClipCount += 1
    else elementPathClipCount += 1
  }

  const getClipCursorEntry = (clip) => {
    if (!webCodecsEnabled || clip.type !== 'video' || clip.reverse || standardDecoderClipIds.has(clip.id)) return null
    const asset = assetsState.getAssetById(clip.assetId)
    // The WebCodecs cursor composites into an opaque canvas. Chromium's
    // HTMLVideoElement path is required for VP9's separate alpha plane.
    if (!shouldUseWebCodecsForAsset(asset)) return null
    const existing = clipFrameCursors.get(clip.id)
    if (existing) return existing
    const cachedUrl = cachedVideoSources.get(clip.id)
    const opticalFlow = opticalFlowSources.get(clip.id) || null
    const sourceUrl = resolvedClipSourceUrls.get(clip.id)
    if (!sourceUrl || failedVideoSources.has(sourceUrl)) return null
    const preparedSourceUrl = preparedFrameSourceUrls.get(sourceUrl) || null
    const sourcePrepared = preparedFrameSourceUrls.has(sourceUrl)
    const usingCached = !!cachedUrl
    const trimStart = usingCached
      ? 0
      : opticalFlow
        ? Math.max(0, (Number(clip.trimStart) || 0) - Number(opticalFlow.sourceStart || 0))
        : (clip.trimStart || 0)
    const cursorStartTime = opticalFlow ? 0 : Math.max(0, trimStart - 1.5)
    const sourceVideo = videoElements.get(sourceUrl)
    const fallbackReason = getWebCodecsExportFallbackReason({
      sourceDuration: sourceVideo?.duration,
      startTime: cursorStartTime,
      sourcePrepared,
    })
    if (fallbackReason) {
      standardDecoderClipIds.add(clip.id)
      if (!loggedStandardDecoderSources.has(sourceUrl)) {
        loggedStandardDecoderSources.add(sourceUrl)
        const asset = assetsState.getAssetById(clip.assetId)
        const sourceName = asset?.name || `clip ${clip.id}`
        console.warn(`[Export] Using standard video decoder for ${sourceName}: ${fallbackReason}`)
      }
      return null
    }
    const rawTrimEnd = clip.trimEnd ?? clip.sourceDuration
    const sourceEnd = usingCached
      ? (Number(clip.duration) || null)
      : opticalFlow
        ? Math.max(0, Number(opticalFlow.sourceEnd) - Number(opticalFlow.sourceStart))
        : (Number.isFinite(Number(rawTrimEnd)) && Number(rawTrimEnd) > trimStart ? Number(rawTrimEnd) : null)
    const entry = {
      cursor: null,
      settled: false,
      clipEnd: getClipPlaybackWindow(clip).end,
    }
    entry.promise = createClipFrameCursor({
      url: preparedSourceUrl || sourceUrl,
      // Transitions sample source handles beyond the trim window
      // (allowHandles), so decode from a bit before the in-point.
      startTime: cursorStartTime,
      endTime: sourceEnd,
      label: `clip ${clip.id} (${assetsState.getAssetById(clip.assetId)?.name || 'unnamed source'})`,
    }).then((cursor) => {
      entry.cursor = cursor
      entry.settled = true
      return cursor
    }).catch(() => {
      entry.settled = true
      return null
    })
    clipFrameCursors.set(clip.id, entry)
    return entry
  }

  const closeClipCursorEntry = (entry) => {
    if (!entry) return
    if (entry.cursor) {
      try { entry.cursor.close() } catch { /* ignore */ }
      entry.cursor = null
    } else if (entry.promise) {
      entry.promise.then((cursor) => {
        try { cursor?.close() } catch { /* ignore */ }
      })
    }
  }

  const closeAllFrameCursors = () => {
    for (const entry of clipFrameCursors.values()) closeClipCursorEntry(entry)
    clipFrameCursors.clear()
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

  if (canUseDirectFramePipe) {
    onProgress({ status: 'Starting fast FFmpeg pipe...', progress: 4 })
    const pipeStart = await window.electronAPI.startFramePipe({
      width,
      height,
      fps,
      outputPath: pipedVideoPath,
      format: outputExtension,
      duration: totalDuration,
      alpha: !!transparent,
      alphaCache: Boolean(soloClipSet),
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
      if (pipeStart.hardwareFallback) {
        // The hardware encoder failed its runtime probe (missing from this
        // ffmpeg build, or the driver refused it) — say so instead of
        // silently exporting with software, and keep it for the result.
        framePipeHardwareFallback = pipeStart.hardwareFallback
        console.warn(`[Export] Hardware encoder unavailable (${framePipeHardwareFallback.requestedEncoder}): ${framePipeHardwareFallback.reason} — exporting with ${framePipeHardwareFallback.fallbackEncoder}.`)
        onProgress({ status: `Hardware encoder unavailable — exporting with ${framePipeHardwareFallback.fallbackEncoder}`, progress: 4 })
      }
      framePipeHardwareFfmpeg = pipeStart.hardwareFfmpeg || null
    } else if (pipeStart?.code === 'ffmpeg-missing' || pipeStart?.code === 'spawn-failed') {
      // The PNG fallback needs the same FFmpeg binary for its encode step,
      // so an unstartable FFmpeg would only fail again after rendering
      // every frame.
      throw new Error(pipeStart?.error || 'FFmpeg could not be started for export.')
    } else {
      console.warn('[Export] Fast FFmpeg pipe unavailable; falling back to PNG frame sequence:', pipeStart?.error)
      onProgress({ status: 'Fast pipe unavailable - using PNG frame sequence...', progress: 4 })
    }
  }

  // GPU compositing (WebGL2). Replaces the per-clip canvas-2D composite
  // chain; clips that need not-yet-ported features (tonal adjustments,
  // masks, GLSL/managed effects, velocity blur, text raster) still render
  // through the 2D helpers and composite as GPU textures. Only engages on
  // the frame-pipe path (the PNG fallback keeps the 2D compositor). Kill
  // switch: localStorage 'comfystudio-export-gpu' = '0'.
  let gpu = null
  if (framePipeSessionId && isGpuExportEnabled()) {
    gpu = createGpuCompositor({ width, height, transparent: !!transparent })
    if (gpu) {
      console.log('[Export] GPU compositor active (WebGL2). Set localStorage comfystudio-export-gpu=0 to use the 2D compositor.')
    } else {
      console.warn('[Export] WebGL2 unavailable; using the 2D compositor.')
    }
  }
  const gpuFullFrameCorners = gpu
    ? [
      { x: 0, y: 0, u: 0, v: 0, w: 1 },
      { x: width, y: 0, u: 1, v: 0, w: 1 },
      { x: 0, y: height, u: 0, v: 1, w: 1 },
      { x: width, y: height, u: 1, v: 1, w: 1 },
    ]
    : null
  // Composite a 2D-rendered full-frame canvas (the legacy offscreen path)
  // onto the GPU stage.
  const gpuDrawCanvasLayer = (sourceCanvas, sourceKey, sourceVersion, opacity, blendMode, colorSettings = null, blurPx = null, corners = null, matte = null) => {
    gpu.drawLayer({
      samples: [{ source: sourceCanvas, sourceKey, sourceVersion, corners: corners || gpuFullFrameCorners, weight: 1 }],
      colorSettings,
      blurPx,
      matte,
      opacity,
      blendMode: blendMode === 'normal' ? 'normal' : blendMode,
    })
  }

  // Track matte raster: draw the consumed layer above into a full-frame
  // canvas with its own animated transform/crop/opacity. Base content only
  // — the matte's own effects/masks are out of scope, matching the preview.
  const rasterExportMatteClip = async (matteEntry, time, allowHandles = false) => {
    const matteClip = matteEntry?.clip
    if (!matteClip) return null
    let buffers = maskRenderBuffers.get('__track-matte__')
    if (!buffers) {
      const offCanvas = document.createElement('canvas')
      offCanvas.width = width
      offCanvas.height = height
      const offCtx = offCanvas.getContext('2d', { willReadFrequently: true })
      buffers = { offCanvas, offCtx }
      maskRenderBuffers.set('__track-matte__', buffers)
    }
    const matteCanvas = buffers.offCanvas
    const matteCtx = buffers.offCtx
    matteCtx.setTransform(1, 0, 0, 1, 0, 0)
    matteCtx.clearRect(0, 0, width, height)

    const matteClipTime = time - (matteClip.startTime || 0)
    const matteTransform = scaleTransformToExport(
      applyEffectsToTransform(getAnimatedTransform(matteClip, matteClipTime) || matteClip.transform || {}, getRenderEffects(matteClip), matteClipTime)
    )
    const matteOpacity = typeof matteTransform.opacity === 'number' ? matteTransform.opacity / 100 : 1
    if (matteOpacity <= 0.001) return matteCanvas

    matteCtx.save()
    matteCtx.globalAlpha = matteOpacity
    matteCtx.globalCompositeOperation = 'source-over'
    matteCtx.filter = 'none'

    try {
      if (matteClip.type === 'text' || matteClip.type === 'shape') {
        const isShapeClip = matteClip.type === 'shape'
        const animatedShapeProperties = isShapeClip ? getAnimatedShapeProperties(matteClip, matteClipTime) : null
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
          drawText(matteCtx, rect, matteClip, textStyleScale, matteClipTime)
        }
        return matteCanvas
      }

      if (matteClip.type === 'video') {
        const sourceUrl = resolvedClipSourceUrls.get(matteClip.id)
        const video = sourceUrl && !failedVideoSources.has(sourceUrl) ? videoElements.get(sourceUrl) : null
        if (!video) return matteCanvas
        const usingCachedRender = !!cachedVideoSources.get(matteClip.id)
        const opticalFlowCache = opticalFlowSources.get(matteClip.id) || null
        const sourceTiming = usingCachedRender
          ? {
              time: clamp(matteClipTime, 0, Math.max(0, (Number(matteClip.duration) || 0) - 0.001)),
              maxTime: Number(matteClip.duration) || 0,
            }
          : getClipPlaybackTimingAtTimeline(matteClip, time, 0.001, {
              useFrameSampling: false,
              allowHandles,
            })
        const originalSourceTime = sourceTiming.time
        const opticalMapping = opticalFlowCache
          ? mapOriginalSourceTimeToOpticalFlowCache(matteClip, originalSourceTime, {
              requireUrl: false,
              endOffset: 0.001,
              handleSeconds: opticalFlowCache.handleSeconds,
            })
          : null
        const sourceTime = opticalMapping ? opticalMapping.time : originalSourceTime

        let matteSource = null
        let cursor = null
        const cursorEntry = getClipCursorEntry(matteClip)
        if (cursorEntry) {
          cursor = cursorEntry.settled ? cursorEntry.cursor : await cursorEntry.promise
          if (cursor?.dead || cursor?.closed) cursor = null
        }
        try {
          if (cursor) {
            await cursor.seek(sourceTime)
            matteSource = cursor.drawSource
          } else {
            await seekVideo(video, sourceTime, fastSeek)
            matteSource = video
          }
        } catch (err) {
          console.warn('[Export] Track matte video sample failed; using empty matte:', getMediaErrorMessage(err))
          return matteCanvas
        }
        const sourceWidth = matteSource === video
          ? (video.videoWidth || width)
          : (matteSource.width || video.videoWidth || width)
        const sourceHeight = matteSource === video
          ? (video.videoHeight || height)
          : (matteSource.height || video.videoHeight || height)
        const rect = getBaseDrawRect(sourceWidth, sourceHeight, width, height, normalizedDeliveryFraming)
        applyClipTransform(matteCtx, rect, matteTransform, null)
        applyClipCrop(matteCtx, rect, matteTransform)
        matteCtx.drawImage(matteSource, 0, 0, rect.width, rect.height)
        return matteCanvas
      }

      if (matteClip.type === 'image') {
        const imageUrl = resolvedAssetUrls.get(matteClip.assetId) || assetsState.getAssetById(matteClip.assetId)?.url
        const image = imageUrl ? imageElements.get(imageUrl) : null
        if (!image) return matteCanvas
        const rect = getBaseDrawRect(image.naturalWidth || width, image.naturalHeight || height, width, height, normalizedDeliveryFraming)
        applyClipTransform(matteCtx, rect, matteTransform, null)
        applyClipCrop(matteCtx, rect, matteTransform)
        matteCtx.drawImage(image, 0, 0, rect.width, rect.height)
        return matteCanvas
      }

      return matteCanvas
    } finally {
      matteCtx.restore()
    }
  }
  onProgress({ status: EXPORT_STATUS.rendering, progress: 5 })
  
  const frameDuration = fps > 0 ? 1 / fps : 0
  const halfFrame = frameDuration / 2
  const frameSampleOffset = sampleAtFrameCenter ? halfFrame : 0

  try {
  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
    throwIfCancelled()
    // Foreground direct exports allow periodic UI paints. The dedicated
    // offscreen worker uses a task boundary instead, never a display-refresh
    // callback: RAF can stall in a never-shown window despite visible state.
    if (frameIndex % 4 === 0) {
      const yieldStart = performance.now()
      await scheduler.yieldForProgress()
      exportPerf.progressYieldMs += performance.now() - yieldStart
    }
    throwIfCancelled()
    const targetTime = rangeStart + frameIndex * frameDuration + frameSampleOffset
    const safeEnd = Math.max(rangeStart, rangeEnd - halfFrame)
    const time = Math.min(targetTime, safeEnd)
    // Solo bakes render the clip clean — transitions stay live and are
    // composited over the baked file at playback/export time.
    const transitionInfo = soloClipSet ? null : timelineState.getTransitionAtTime(time)

    if (gpu?.isContextLost()) {
      throw new Error('GPU compositor context lost mid-export. Re-run the export (set localStorage comfystudio-export-gpu=0 to force the 2D compositor).')
    }
    if (gpu) {
      gpu.beginFrame()
    } else if (transparent) {
      ctx.clearRect(0, 0, width, height)
    } else {
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, width, height)
    }

    const layersStart = performance.now()
    const activeClipsUnfiltered = timelineState.getActiveClipsAtTime(time)
      .filter(({ clip }) => !clip.compoundParentId || isClipInPlaybackWindow(clip, time))
    const activeClips = soloClipSet
      ? activeClipsUnfiltered.filter(({ clip }) => soloClipSet.has(clip.id))
      : activeClipsUnfiltered
    const rawVisualLayerClips = activeClips
      .filter(({ track }) => track.type === 'video')
      .sort((a, b) => {
        const indexA = timelineState.tracks.findIndex(t => t.id === a.track.id)
        const indexB = timelineState.tracks.findIndex(t => t.id === b.track.id)
        return indexB - indexA
      })
    // Track mattes: pair matted clips with the layer above and hide the
    // consumed matte layers BEFORE culling, so a full-frame matte source
    // can't cull the layers beneath it.
    const { matteEntryByClipId, consumedClipIds } = resolveTrackMatteAssignments(rawVisualLayerClips)
    const matteVisibleLayerClips = consumedClipIds.size > 0
      ? rawVisualLayerClips.filter((layerEntry) => !consumedClipIds.has(layerEntry.clip?.id))
      : rawVisualLayerClips
    const transitionClipIds = getTransitionClipIds(transitionInfo)
    const visualLayerClips = cullVisualLayerEntries(matteVisibleLayerClips, {
      time,
      getAssetById: assetsState.getAssetById,
      transitionClipIds,
      timelineWidth: width,
      timelineHeight: height,
    })

    // Warm every visible layer's decoder in parallel before the serial draw
    // loop: per-layer decode waits overlap instead of accumulating (the
    // dominant cost on multi-layer timelines). The authoritative per-clip
    // sample below then hits an already-decoded frame. Failures are ignored
    // here — the draw loop's sample handles fallback per clip.
    if (webCodecsEnabled && visualLayerClips.length > 1) {
      const preSeekStart = performance.now()
      const preSeeks = []
      for (const { clip } of visualLayerClips) {
        if (!clip || clip.type !== 'video' || clip.reverse) continue
        const cursor = clipFrameCursors.get(clip.id)?.cursor
        if (!cursor || cursor.dead) continue
        const preTarget = getPreSeekSourceTime(
          clip,
          time,
          cachedVideoSources.has(clip.id),
          opticalFlowSources.get(clip.id) || null,
          transitionClipIds.has(clip.id)
        )
        preSeeks.push(cursor.seek(preTarget).catch(() => {}))
      }
      if (preSeeks.length > 1) {
        exportPerf.preSeekBatches += 1
        exportPerf.preSeekClips += preSeeks.length
        await Promise.all(preSeeks)
      }
      exportPerf.sampleMs += performance.now() - preSeekStart
    }

    for (const { clip } of visualLayerClips) {
      if (clip.type === 'adjustment') {
        const clipTime = time - clip.startTime
        const adjustmentSettings = normalizeAdjustmentSettings(
          getRenderAdjustments(clip, clipTime)
        )
        const baseClipTransform = getAnimatedTransform(clip, clipTime) || clip.transform || {}
        // Apply camera shake / transform-affecting effects to the adjustment
        // layer so shake propagates to every clip beneath.
        const clipTransform = scaleTransformToExport(applyEffectsToTransform(baseClipTransform, getRenderEffects(clip), clipTime))
        const usesManagedPixelEffects = hasManagedPixelOrVignetteEffect(clip, clipTime)
        const adjustmentIsActive = hasAdjustmentEffect(adjustmentSettings)
        // Transform-only adjustment layers must still composite (they draw
        // the transformed stage copy back over the stage) — export parity
        // with the preview renderer.
        const transformIsActive = hasTransformingAdjustmentTransform(clipTransform)

        if (gpu) {
          if (!adjustmentIsActive && !usesManagedPixelEffects && !transformIsActive) continue
          const rect = getBaseDrawRect(width, height, width, height)
          const corners = getClipQuadCorners(rect, clipTransform, null)
          if (!corners) continue
          const baseOpacity = typeof clipTransform.opacity === 'number' ? clipTransform.opacity / 100 : 1
          const blendMode = clipTransform?.blendMode || 'normal'
          // Fully native: color/tonal/blur plus the entire managed chain
          // (pixel effects, glow, GLSL, vignette, letterbox) — no per-frame
          // stage snapshot readback.
          gpu.drawAdjustment({
            corners,
            colorSettings: adjustmentSettings,
            blurPx: adjustmentSettings.blur > 0 ? adjustmentSettings.blur : null,
            managedPasses: usesManagedPixelEffects
              ? buildManagedEffectGpuPasses(getRenderEffects(clip), clipTime, frameIndex, width, height)
              : null,
            opacity: baseOpacity,
            blendMode,
          })
          continue
        }

        if (adjustmentCtx && (adjustmentIsActive || usesManagedPixelEffects || transformIsActive)) {
          const usesTonalAdjustments = needsAdvancedColorPass(adjustmentSettings)
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
          } else if (usesManagedPixelEffects || transformIsActive) {
            // No color adjustment, but either managed effects apply to the
            // stage snapshot, or a transform-only adjustment draws the plain
            // snapshot back transformed.
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

      // Track matte: raster the consumed layer above once per frame. A
      // missing/empty matte means invisible unless inverted.
      const matteInfo = parseTrackMatte(clip.trackMatte)
      let matteCanvas2d = null
      let matteSpec = null
      if (matteInfo) {
        const matteEntry = matteEntryByClipId.get(clip.id) || null
        if (!matteEntry) {
          if (!matteInfo.invert) continue
        } else {
          matteCanvas2d = await rasterExportMatteClip(
            matteEntry,
            time,
            transitionClipIds.has(matteEntry.clip?.id)
          )
          if (matteCanvas2d && gpu) {
            matteSpec = {
              source: matteCanvas2d,
              sourceKey: `${clip.id}:trackmatte`,
              sourceVersion: frameIndex,
              corners: gpuFullFrameCorners,
              channel: matteInfo.channel,
              invert: matteInfo.invert,
            }
          }
          if (!matteCanvas2d && !matteInfo.invert) continue
        }
      }

      // Full render bakes (cacheKind 'full') carry transform, effects,
      // adjustments, masks, speed, and text animation inside the baked
      // file; only opacity + blend mode (and transitions) stay live.
      const fullBakeUrl = cachedVideoSources.get(clip.id) || null
      const isFullBake = !!fullBakeUrl && clip.cacheKind === 'full'
      const resolveClipTransformAtTime = (sampleClipTime) => scaleTransformToExport(
        applyEffectsToTransform(getAnimatedTransform(clip, sampleClipTime) || clip.transform || {}, getRenderEffects(clip), sampleClipTime)
      )
      const liveClipTransform = resolveClipTransformAtTime(clipTime)
      const clipTransform = isFullBake
        ? { opacity: liveClipTransform.opacity, blendMode: liveClipTransform.blendMode }
        : liveClipTransform
      const clipAdjustmentSettings = normalizeAdjustmentSettings(
        isFullBake ? {} : getRenderAdjustments(clip, clipTime)
      )
      const usesTonalAdjustments = needsAdvancedColorPass(clipAdjustmentSettings)
      const clipAdjustmentFilter = buildCssFilterFromAdjustments(clipAdjustmentSettings)
      const clipAdjustmentFilterValue = clipAdjustmentFilter !== 'none' ? clipAdjustmentFilter : null
      const usesManagedPixelEffects = !isFullBake && hasManagedPixelOrVignetteEffect(clip, clipTime)
      const velocityMotionBlur = (!isFullBake && canUseVelocityMotionBlur())
        ? getVelocityMotionBlurOptions(clip, clipTime, fps, resolveClipTransformAtTime)
        : null
      const motionBlurSamples = (velocityMotionBlur || isFullBake)
        ? [{ clipTime, weight: 1 }]
        : getMotionBlurSamples(clip, clipTime, fps, 'export')
      const hasMotionBlurSamples = motionBlurSamples.length > 1
      if ((clip.type === 'text' || clip.type === 'shape' || clip.type === 'captions') && !isFullBake) {
        const isShapeClip = clip.type === 'shape'
        const isCaptionsClip = clip.type === 'captions'
        const baseOpacity = typeof clipTransform.opacity === 'number' ? clipTransform.opacity / 100 : 1
        const clipOpacity = (transitionStyle?.opacity ?? 1) * baseOpacity
        const blendMode = clipTransform.blendMode || 'normal'
        const blurPx = transitionStyle?.blur ?? (clipTransform?.blur > 0 ? clipTransform.blur : null)
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
            drawText(targetCtx, rect, clip, textStyleScale, sampleClipTime)
          }
        }
        const drawTextShapeSample = (targetCtx, sample, targetFilter = 'none', alphaScale = 1, compositeOperation = 'source-over') => {
          const sampleTransform = resolveClipTransformAtTime(sample.clipTime)
          const { shapeClip, rect } = getTextShapeFrame(sample.clipTime)
          targetCtx.save()
          targetCtx.globalAlpha = alphaScale * sample.weight
          targetCtx.globalCompositeOperation = compositeOperation
          targetCtx.filter = targetFilter
          applyClipTransform(targetCtx, rect, sampleTransform, transitionStyle)
          applyClipCrop(targetCtx, rect, sampleTransform)
          applyTransitionClip(targetCtx, rect, transitionStyle)
          drawNativeClip(targetCtx, rect, shapeClip, sample.clipTime)
          targetCtx.restore()
        }

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
          for (const sample of motionBlurSamples) {
            drawTextShapeSample(offCtx, sample)
          }
          if (velocityMotionBlur) {
            applyVelocityMotionBlurToCanvas(offCanvas, offCtx, width, height, velocityMotionBlur)
          }

          const processedCanvasForText = applyAdvancedAdjustmentsToCanvas(offCanvas, clipAdjustmentSettings, blurPx)

          if (usesManagedPixelEffects) {
            const outCtx = processedCanvasForText.getContext('2d')
            applyClipManagedEffectsToOffCanvas(processedCanvasForText, outCtx, width, height, clip, clipTime, frameIndex, glslQualityScale)
          }

          if (gpu) {
            gpuDrawCanvasLayer(processedCanvasForText, `${clip.id}:2d`, frameIndex, clipOpacity, blendMode, null, null, null, matteSpec)
            continue
          }
          if (matteInfo && matteCanvas2d) {
            applyTrackMatteToCanvas(processedCanvasForText.getContext('2d'), matteCanvas2d, matteInfo, width, height)
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
          const filterPartsInner = []
          if (clipAdjustmentFilterValue) filterPartsInner.push(clipAdjustmentFilterValue)
          if (blurPx != null) filterPartsInner.push(`blur(${blurPx}px)`)
          const sampleFilter = filterPartsInner.length > 0 ? filterPartsInner.join(' ') : 'none'
          for (const sample of motionBlurSamples) {
            drawTextShapeSample(offCtx, sample, sampleFilter)
          }
          if (velocityMotionBlur) {
            applyVelocityMotionBlurToCanvas(offCanvas, offCtx, width, height, velocityMotionBlur)
          }

          applyClipManagedEffectsToOffCanvas(offCanvas, offCtx, width, height, clip, clipTime, frameIndex, glslQualityScale)

          if (gpu) {
            gpuDrawCanvasLayer(offCanvas, `${clip.id}:2d`, frameIndex, clipOpacity, blendMode, null, null, null, matteSpec)
            continue
          }
          if (matteInfo && matteCanvas2d) {
            applyTrackMatteToCanvas(offCtx, matteCanvas2d, matteInfo, width, height)
          }
          ctx.save()
          ctx.globalAlpha = clipOpacity
          ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode
          ctx.filter = 'none'
          ctx.drawImage(offCanvas, 0, 0)
          ctx.restore()
          continue
        }

        const filterParts = []
        if (clipAdjustmentFilterValue) filterParts.push(clipAdjustmentFilterValue)
        if (blurPx != null) filterParts.push(`blur(${blurPx}px)`)
        const sampleFilter = filterParts.length > 0 ? filterParts.join(' ') : 'none'
        if (velocityMotionBlur || (matteInfo && matteCanvas2d && !gpu)) {
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
          for (const sample of motionBlurSamples) {
            drawTextShapeSample(offCtx, sample, sampleFilter)
          }
          if (velocityMotionBlur) {
            applyVelocityMotionBlurToCanvas(offCanvas, offCtx, width, height, velocityMotionBlur)
          }

          if (gpu) {
            gpuDrawCanvasLayer(offCanvas, `${clip.id}:2d`, frameIndex, clipOpacity, blendMode, null, null, null, matteSpec)
            continue
          }
          if (matteInfo && matteCanvas2d) {
            applyTrackMatteToCanvas(offCtx, matteCanvas2d, matteInfo, width, height)
          }
          ctx.save()
          ctx.globalAlpha = clipOpacity
          ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode
          ctx.filter = 'none'
          ctx.drawImage(offCanvas, 0, 0)
          ctx.restore()
          continue
        }
        if (gpu) {
          // Simple text/shape: raster through the shared 2D helpers (vector
          // sharpness at the final transform), composite on the GPU stage.
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
          for (const sample of motionBlurSamples) {
            drawTextShapeSample(offCtx, sample, sampleFilter)
          }
          gpuDrawCanvasLayer(offCanvas, `${clip.id}:2d`, frameIndex, clipOpacity, blendMode, null, null, null, matteSpec)
          continue
        }
        for (const sample of motionBlurSamples) {
          drawTextShapeSample(ctx, sample, sampleFilter, clipOpacity, blendMode === 'normal' ? 'source-over' : blendMode)
        }
        continue
      }
      const asset = assetsState.getAssetById(clip.assetId)
      const cachedSourceUrl = cachedVideoSources.get(clip.id)
      const usingCachedRender = !!cachedSourceUrl
      const opticalFlowCache = opticalFlowSources.get(clip.id) || null
      // Parametric shape masks synthesize a mask effect with the feathered
      // raster pre-baked (invert included), so the three mask bodies below
      // run byte-identical logic for shapes and AI raster masks alike. The
      // OPAQUE luminance encoding is the one every export path reads —
      // coverage must live in RGB here, not alpha (see utils/shapeMask.js).
      const maskBypassed = isClipBypassed(clip, 'mask')
      const animatedShapeMask = (!usingCachedRender && !maskBypassed) ? getAnimatedShapeMask(clip, clipTime) : null
      const shapeMaskCanvases = animatedShapeMask ? getShapeMaskCanvases(animatedShapeMask) : null
      const maskEffect = shapeMaskCanvases
        ? { type: 'mask', enabled: true, invertMask: false, shapeCanvas: shapeMaskCanvases.luma, shapeSignature: getShapeMaskSignature(animatedShapeMask) }
        : (!usingCachedRender && !maskBypassed && (clip.effects || []).find(effect => effect.type === 'mask' && effect.enabled))
      
      let sourceWidth = width
      let sourceHeight = height
      let drawSource = null
      let videoElement = null
      let sampleVideoSourceAt = null
      let sourceFps = null
      let maxSourceTime = null
      let sourceTime = null
      let shouldBlend = false
      
      if (clip.type === 'video' || isFullBake) {
        const sourceUrl = resolvedClipSourceUrls.get(clip.id) || asset?.url
        if (sourceUrl && failedVideoSources.has(sourceUrl)) {
          continue
        }
        const video = sourceUrl ? videoElements.get(sourceUrl) : null
        if (!video) continue
        
        const sourceTiming = usingCachedRender
          ? {
              time: clamp(clipTime, 0, Math.max(0, (Number(clip.duration) || 0) - 0.001)),
              maxTime: Number(clip.duration) || 0,
            }
          : getClipPlaybackTimingAtTimeline(clip, time, 0.001, {
              useFrameSampling: false,
              allowHandles: !!transitionStyle,
            })
        maxSourceTime = sourceTiming.maxTime
        const originalSourceTime = sourceTiming.time
        const opticalMapping = opticalFlowCache
          ? mapOriginalSourceTimeToOpticalFlowCache(clip, originalSourceTime, {
              requireUrl: false,
              endOffset: 0.001,
              handleSeconds: opticalFlowCache.handleSeconds,
            })
          : null
        if (opticalMapping) maxSourceTime = opticalMapping.maxTime
        const clampedSourceTime = opticalMapping ? opticalMapping.time : originalSourceTime
        sourceTime = clampedSourceTime
        videoElement = video
        const assetFps = Number(asset?.settings?.fps ?? asset?.fps ?? clip.sourceFps)
        sourceFps = opticalFlowCache
          ? Number(opticalFlowCache.targetFps)
          : (Number.isFinite(assetFps) && assetFps > 0 ? assetFps : null)
        const preserveGifFrameHolds = asset?.settings?.gifSource?.animated === true
        const frameBlendRequested = normalizeFrameSamplingMode(clip.frameSampling) === FRAME_SAMPLING_MODE.BLEND
          && (getClipMinimumSpeed(clip) < 0.999 || !!(sourceFps && sourceFps < fps - 0.5))

        // Matted clips on the 2D path skip low-fps frame blending — the
        // matte needs the buffered draw, which the blend path bypasses.
        shouldBlend = !preserveGifFrameHolds
          && !isFullBake
          && !opticalFlowCache
          && !!(sourceFps && frameBlendRequested && !maskEffect && !hasMotionBlurSamples && !velocityMotionBlur)
          && !(matteInfo && !gpu)

        // Prefer the WebCodecs sequential frame cursor; any doubt (or a
        // mid-clip cursor failure) falls back to the element seek path.
        let frameCursor = null
        const cursorEntry = getClipCursorEntry(clip)
        if (cursorEntry) {
          frameCursor = cursorEntry.settled ? cursorEntry.cursor : await cursorEntry.promise
          if (frameCursor?.dead || frameCursor?.closed) frameCursor = null
        }
        countClipPath(clip.id, !!frameCursor)
        sampleVideoSourceAt = async (t) => {
          const sampleStart = performance.now()
          try {
            if (frameCursor) {
              try {
                await frameCursor.seek(t)
                return frameCursor.drawSource
              } catch (err) {
                console.warn('[Export] WebCodecs frame source failed mid-clip; using video element:', getMediaErrorMessage(err))
                try { frameCursor.close() } catch { /* ignore */ }
                frameCursor = null
              }
            }
            await seekVideo(video, t, fastSeek)
            return video
          } finally {
            exportPerf.sampleMs += performance.now() - sampleStart
          }
        }

        if (!shouldBlend) {
          try {
            drawSource = await sampleVideoSourceAt(clampedSourceTime)
          } catch (err) {
            if (sourceUrl) failedVideoSources.add(sourceUrl)
            console.warn('[Export] Failed to seek source video, skipping clip frame:', getMediaErrorMessage(err))
            continue
          }
        } else {
          // Blend paths sample per sub-frame through sampleVideoSourceAt.
          drawSource = video
        }
        if (drawSource !== video) {
          sourceWidth = drawSource.width || video.videoWidth || sourceWidth
          sourceHeight = drawSource.height || video.videoHeight || sourceHeight
        } else {
          sourceWidth = video.videoWidth || sourceWidth
          sourceHeight = video.videoHeight || sourceHeight
        }
      } else if (clip.type === 'image') {
        const imageUrl = resolvedAssetUrls.get(clip.assetId) || asset?.url
        const image = imageUrl ? imageElements.get(imageUrl) : null
        if (!image) continue
        sourceWidth = image.naturalWidth || sourceWidth
        sourceHeight = image.naturalHeight || sourceHeight
        drawSource = image
      }
      
      if (!drawSource) continue
      
      const rect = getBaseDrawRect(sourceWidth, sourceHeight, width, height, normalizedDeliveryFraming)
      const baseOpacity = typeof clipTransform.opacity === 'number' ? clipTransform.opacity / 100 : 1
      const clipOpacity = (transitionStyle?.opacity ?? 1) * baseOpacity
      const blurPx = transitionStyle?.blur ?? (clipTransform?.blur > 0 ? clipTransform.blur : null)
      const blendMode = clipTransform?.blendMode || 'normal'
      const drawMediaTransformSample = (targetCtx, sample, targetFilter = 'none', alphaScale = 1, compositeOperation = 'source-over', source = drawSource) => {
        const sampleTransform = resolveClipTransformAtTime(sample.clipTime)
        targetCtx.save()
        targetCtx.globalAlpha = alphaScale * sample.weight
        targetCtx.globalCompositeOperation = compositeOperation
        targetCtx.filter = targetFilter
        applyClipTransform(targetCtx, rect, sampleTransform, transitionStyle)
        applyClipCrop(targetCtx, rect, sampleTransform)
        applyTransitionClip(targetCtx, rect, transitionStyle)
        targetCtx.drawImage(source, 0, 0, rect.width, rect.height)
        targetCtx.restore()
      }

      // GPU-native eligibility: everything runs in the compositor now
      // except masked clips with velocity blur (the one remaining 2D
      // combination); text/shape rasterization stays canvas 2D by design.
      const gpuNativeMedia = gpu && !(velocityMotionBlur && maskEffect)

      if (usesTonalAdjustments && !gpuNativeMedia) {
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
        if (hasMotionBlurSamples) {
          for (const sample of motionBlurSamples) {
            drawMediaTransformSample(offCtx, sample)
          }
        } else {
          applyClipTransform(offCtx, rect, clipTransform, transitionStyle)
          applyClipCrop(offCtx, rect, clipTransform)
          applyTransitionClip(offCtx, rect, transitionStyle)
        }

        if (!hasMotionBlurSamples && shouldBlend && sourceTime !== null) {
          const sourceFrameDuration = 1 / sourceFps
          const baseIndex = Math.floor(sourceTime / sourceFrameDuration)
          const baseTime = baseIndex * sourceFrameDuration
          const nextTime = Math.min(baseTime + sourceFrameDuration, (maxSourceTime ?? sourceTime) - 0.001)
          const blend = clamp((sourceTime - baseTime) / sourceFrameDuration, 0, 1)

          try {
            const baseSource = await sampleVideoSourceAt(baseTime)
            offCtx.globalAlpha = 1 - blend
            offCtx.drawImage(baseSource, 0, 0, rect.width, rect.height)

            if (blend > 0.001 && nextTime > baseTime + 1e-6) {
              const nextSource = await sampleVideoSourceAt(nextTime)
              offCtx.globalAlpha = blend
              offCtx.drawImage(nextSource, 0, 0, rect.width, rect.height)
            }
          } catch (err) {
            console.warn('[Export] Failed blended seek/draw, skipping clip frame:', getMediaErrorMessage(err))
            if (clip.type === 'video') {
              const badSourceUrl = resolvedClipSourceUrls.get(clip.id) || asset?.url
              if (badSourceUrl) failedVideoSources.add(badSourceUrl)
            }
            offCtx.restore()
            continue
          }
        } else if (!hasMotionBlurSamples) {
          offCtx.drawImage(drawSource, 0, 0, rect.width, rect.height)
        }
        offCtx.restore()
        if (velocityMotionBlur) {
          applyVelocityMotionBlurToCanvas(offCanvas, offCtx, width, height, velocityMotionBlur)
        }

        let advancedOutputCanvas = offCanvas
        if (maskEffect) {
          const maskAsset = maskEffect.shapeCanvas ? null : assetsState.getAssetById(maskEffect.maskAssetId)
          const maskFrameUrl = maskEffect.shapeCanvas
            ? null
            : getMaskFrameInfo(clip, maskAsset, time, !!transitionStyle)
          const maskImageMap = maskEffect.shapeCanvas ? null : maskElements.get(maskAsset?.id)
          const maskImage = maskEffect.shapeCanvas || maskImageMap?.get(maskFrameUrl)

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

        if (gpu) {
          gpuDrawCanvasLayer(advancedOutputCanvas, `${clip.id}:2d`, frameIndex, clipOpacity, blendMode, null, null, null, matteSpec)
          continue
        }
        if (matteInfo && matteCanvas2d) {
          applyTrackMatteToCanvas(advancedOutputCanvas.getContext('2d'), matteCanvas2d, matteInfo, width, height)
        }
        ctx.save()
        ctx.globalAlpha = clipOpacity
        ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode
        ctx.filter = 'none'
        ctx.drawImage(advancedOutputCanvas, 0, 0)
        ctx.restore()
        continue
      }

      if ((usesManagedPixelEffects || (matteInfo && matteCanvas2d)) && !maskEffect && !gpu) {
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
        const sampleFilter = filterPartsInner.length > 0 ? filterPartsInner.join(' ') : 'none'
        offCtx.filter = sampleFilter
        if (hasMotionBlurSamples) {
          for (const sample of motionBlurSamples) {
            drawMediaTransformSample(offCtx, sample, sampleFilter)
          }
        } else {
          applyClipTransform(offCtx, rect, clipTransform, transitionStyle)
          applyClipCrop(offCtx, rect, clipTransform)
          applyTransitionClip(offCtx, rect, transitionStyle)
        }

        if (!hasMotionBlurSamples && shouldBlend && sourceTime !== null) {
          const sourceFrameDuration = 1 / sourceFps
          const baseIndex = Math.floor(sourceTime / sourceFrameDuration)
          const baseTime = baseIndex * sourceFrameDuration
          const nextTime = Math.min(baseTime + sourceFrameDuration, (maxSourceTime ?? sourceTime) - 0.001)
          const blend = clamp((sourceTime - baseTime) / sourceFrameDuration, 0, 1)
          try {
            const baseSource = await sampleVideoSourceAt(baseTime)
            offCtx.globalAlpha = 1 - blend
            offCtx.drawImage(baseSource, 0, 0, rect.width, rect.height)
            if (blend > 0.001 && nextTime > baseTime + 1e-6) {
              const nextSource = await sampleVideoSourceAt(nextTime)
              offCtx.globalAlpha = blend
              offCtx.drawImage(nextSource, 0, 0, rect.width, rect.height)
            }
          } catch (err) {
            console.warn('[Export] Failed blended seek/draw, skipping clip frame:', getMediaErrorMessage(err))
            if (clip.type === 'video') {
              const badSourceUrl = resolvedClipSourceUrls.get(clip.id) || asset?.url
              if (badSourceUrl) failedVideoSources.add(badSourceUrl)
            }
            offCtx.restore()
            continue
          }
        } else if (!hasMotionBlurSamples) {
          offCtx.drawImage(drawSource, 0, 0, rect.width, rect.height)
        }
        offCtx.restore()
        if (velocityMotionBlur) {
          applyVelocityMotionBlurToCanvas(offCanvas, offCtx, width, height, velocityMotionBlur)
        }

        if (usesManagedPixelEffects) {
          applyClipManagedEffectsToOffCanvas(offCanvas, offCtx, width, height, clip, clipTime, frameIndex, glslQualityScale)
        }
        if (matteInfo && matteCanvas2d) {
          applyTrackMatteToCanvas(offCtx, matteCanvas2d, matteInfo, width, height)
        }

        if (gpu) {
          gpuDrawCanvasLayer(offCanvas, `${clip.id}:2d`, frameIndex, clipOpacity, blendMode)
          continue
        }
        ctx.save()
        ctx.globalAlpha = clipOpacity
        ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode
        ctx.filter = 'none'
        ctx.drawImage(offCanvas, 0, 0)
        ctx.restore()
        continue
      }

      if (gpu) {
        const gpuColorSettings = clipAdjustmentFilterValue ? clipAdjustmentSettings : null
        const gpuAdjustmentBlur = clipAdjustmentSettings.blur > 0 ? clipAdjustmentSettings.blur : 0
        const gpuTransformBlur = blurPx != null ? blurPx : 0
        const gpuManagedPasses = usesManagedPixelEffects
          ? buildManagedEffectGpuPasses(clip.effects, clipTime, frameIndex, width, height)
          : null
        const gpuVelocity = velocityMotionBlur ? buildVelocityBlurUniformValues(velocityMotionBlur) : null

        let gpuMaskHandled = false
        let gpuMaskSpec = null
        if (maskEffect) {
          const maskAsset = maskEffect.shapeCanvas ? null : assetsState.getAssetById(maskEffect.maskAssetId)
          const maskFrameUrl = maskEffect.shapeCanvas
            ? null
            : getMaskFrameInfo(clip, maskAsset, time, !!transitionStyle)
          const maskImageMap = maskEffect.shapeCanvas ? null : maskElements.get(maskAsset?.id)
          const maskImage = maskEffect.shapeCanvas || maskImageMap?.get(maskFrameUrl)
          // Masks run natively unless the clip also has velocity blur —
          // the one combination still on the 2D path (their 2D ordering,
          // velocity after mask, differs from the native chain's).
          const needs2dMask = !!velocityMotionBlur
          if (maskImage && !needs2dMask) {
            const maskCorners = getClipQuadCorners(rect, clipTransform, transitionStyle)
            if (maskCorners) {
              gpuMaskSpec = {
                source: maskImage,
                sourceKey: `${clip.id}:mask`,
                sourceVersion: maskEffect.shapeSignature || maskFrameUrl,
                corners: maskCorners,
                invert: !!maskEffect.invertMask,
                // The 2D mask path blurs media+mask at draw time inside the
                // transform; approximate post-accumulation in device space.
                // The tonal recipe draws both unfiltered.
                blurPx: (!usesTonalAdjustments && blurPx != null)
                  ? blurPx * getApproxTransformScale(clipTransform, transitionStyle)
                  : null,
              }
            }
          } else if (maskImage) {
            let buffers = maskRenderBuffers.get(clip.id)
            if (!buffers || !buffers.maskCanvas) {
              const offCanvas = buffers?.offCanvas || document.createElement('canvas')
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
            const blurPxMask = transitionStyle?.blur ?? (clipTransform?.blur > 0 ? clipTransform.blur : null)

            offCtx.clearRect(0, 0, width, height)
            offCtx.save()
            offCtx.globalAlpha = 1
            offCtx.filter = blurPxMask != null ? `blur(${blurPxMask}px)` : 'none'
            applyClipTransform(offCtx, rect, clipTransform, transitionStyle)
            applyClipCrop(offCtx, rect, clipTransform)
            applyTransitionClip(offCtx, rect, transitionStyle)
            offCtx.drawImage(drawSource, 0, 0, rect.width, rect.height)
            offCtx.restore()

            maskCtx.clearRect(0, 0, width, height)
            maskCtx.save()
            maskCtx.filter = blurPxMask != null ? `blur(${blurPxMask}px)` : 'none'
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

            if (velocityMotionBlur) {
              applyVelocityMotionBlurToCanvas(offCanvas, offCtx, width, height, velocityMotionBlur)
            }
            if (usesManagedPixelEffects) {
              applyClipManagedEffectsToOffCanvas(offCanvas, offCtx, width, height, clip, clipTime, frameIndex, glslQualityScale)
            }
            // Color + adjustment blur composite once here (the 2D path
            // applies them via ctx.filter at this identity-transform draw).
            gpuDrawCanvasLayer(offCanvas, `${clip.id}:2d`, frameIndex, clipOpacity, blendMode, gpuColorSettings, gpuAdjustmentBlur > 0 ? gpuAdjustmentBlur : null, null, matteSpec)
            gpuMaskHandled = true
          }
          // No usable mask image: fall through to the plain draw, matching
          // the 2D path.
        }
        if (gpuMaskHandled) continue

        const gpuSamples = []
        if (gpuMaskSpec && !usesTonalAdjustments) {
          // The 2D mask branch draws a single sample (motion-blur samples
          // are ignored for masked clips); the tonal recipe accumulates.
          const corners = getClipQuadCorners(rect, clipTransform, transitionStyle)
          if (corners) {
            gpuSamples.push({
              source: drawSource,
              sourceKey: clip.id,
              sourceVersion: clip.type === 'image' ? 'static' : frameIndex,
              corners,
              weight: 1,
            })
          }
        } else if (hasMotionBlurSamples) {
          for (const sample of motionBlurSamples) {
            const corners = getClipQuadCorners(rect, resolveClipTransformAtTime(sample.clipTime), transitionStyle)
            if (corners) {
              gpuSamples.push({ source: drawSource, sourceKey: clip.id, sourceVersion: frameIndex, corners, weight: sample.weight })
            }
          }
        } else if (shouldBlend && sourceTime !== null) {
          const corners = getClipQuadCorners(rect, clipTransform, transitionStyle)
          if (corners) {
            const sourceFrameDuration = 1 / sourceFps
            const baseIndex = Math.floor(sourceTime / sourceFrameDuration)
            const baseTime = baseIndex * sourceFrameDuration
            const nextTime = Math.min(baseTime + sourceFrameDuration, (maxSourceTime ?? sourceTime) - 0.001)
            const blend = clamp((sourceTime - baseTime) / sourceFrameDuration, 0, 1)
            try {
              const baseSource = await sampleVideoSourceAt(baseTime)
              gpuSamples.push({ source: baseSource, sourceKey: `${clip.id}:a`, sourceVersion: frameIndex, corners, weight: 1 - blend })
              if (blend > 0.001 && nextTime > baseTime + 1e-6) {
                const nextSource = await sampleVideoSourceAt(nextTime)
                gpuSamples.push({ source: nextSource, sourceKey: `${clip.id}:b`, sourceVersion: frameIndex, corners, weight: blend })
              }
            } catch (err) {
              console.warn('[Export] Failed blended seek/draw, skipping clip frame:', getMediaErrorMessage(err))
              if (clip.type === 'video') {
                const badSourceUrl = resolvedClipSourceUrls.get(clip.id) || asset?.url
                if (badSourceUrl) failedVideoSources.add(badSourceUrl)
              }
              continue
            }
          }
        } else {
          const corners = getClipQuadCorners(rect, clipTransform, transitionStyle)
          if (corners) {
            gpuSamples.push({
              source: drawSource,
              sourceKey: clip.id,
              sourceVersion: clip.type === 'image' ? 'static' : frameIndex,
              corners,
              weight: 1,
            })
          }
        }
        // Route color/blur per the 2D recipe the clip would have taken
        // (shared with the preview's GPU path — see routeGpuLayerColorBlur).
        const routed = routeGpuLayerColorBlur({
          usesTonalAdjustments,
          hasMask: !!gpuMaskSpec,
          adjustmentSettings: clipAdjustmentSettings,
          colorSettings: gpuColorSettings,
          adjustmentBlur: gpuAdjustmentBlur,
          transformBlur: gpuTransformBlur,
          deviceScale: getApproxTransformScale(clipTransform, transitionStyle),
        })
        if (gpuSamples.length > 0) {
          gpu.drawLayer({
            samples: gpuSamples,
            velocity: gpuVelocity,
            mask: gpuMaskSpec,
            matte: matteSpec,
            managedPasses: gpuManagedPasses,
            ...routed,
            opacity: clipOpacity,
            blendMode,
          })
        }
        continue
      }

      ctx.save()
      ctx.globalAlpha = clipOpacity
      const filterParts = []
      if (clipAdjustmentFilterValue) filterParts.push(clipAdjustmentFilterValue)
      if (blurPx != null) filterParts.push(`blur(${blurPx}px)`)
      const sampleFilter = filterParts.length > 0 ? filterParts.join(' ') : 'none'
      ctx.filter = sampleFilter
      // Blend mode (CSS mix-blend-mode → canvas globalCompositeOperation)
      ctx.globalCompositeOperation = blendMode === 'normal' ? 'source-over' : blendMode

      if (hasMotionBlurSamples && !maskEffect && !shouldBlend && !(matteInfo && matteCanvas2d)) {
        for (const sample of motionBlurSamples) {
          drawMediaTransformSample(ctx, sample, sampleFilter, clipOpacity, blendMode === 'normal' ? 'source-over' : blendMode)
        }
        ctx.restore()
        continue
      }

      if ((velocityMotionBlur || (matteInfo && matteCanvas2d)) && !maskEffect && !shouldBlend) {
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
        const bufferedSamples = velocityMotionBlur ? [{ clipTime, weight: 1 }] : motionBlurSamples
        for (const sample of bufferedSamples) {
          drawMediaTransformSample(offCtx, sample, sampleFilter)
        }
        if (velocityMotionBlur) {
          applyVelocityMotionBlurToCanvas(offCanvas, offCtx, width, height, velocityMotionBlur)
        }
        if (matteInfo && matteCanvas2d) {
          applyTrackMatteToCanvas(offCtx, matteCanvas2d, matteInfo, width, height)
        }
        // The samples were already drawn with sampleFilter inside offCtx —
        // clear it here so the buffered composite doesn't filter twice.
        ctx.filter = 'none'
        ctx.drawImage(offCanvas, 0, 0)
        ctx.restore()
        continue
      }

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
          const baseSource = await sampleVideoSourceAt(baseTime)
          ctx.globalAlpha = clipOpacity * (1 - blend)
          ctx.drawImage(baseSource, 0, 0, rect.width, rect.height)

          if (blend > 0.001 && nextTime > baseTime + 1e-6) {
            const nextSource = await sampleVideoSourceAt(nextTime)
            ctx.globalAlpha = clipOpacity * blend
            ctx.drawImage(nextSource, 0, 0, rect.width, rect.height)
          }
        } catch (err) {
          console.warn('[Export] Failed blended seek/draw, skipping clip frame:', getMediaErrorMessage(err))
          if (clip.type === 'video') {
            const badSourceUrl = resolvedClipSourceUrls.get(clip.id) || asset?.url
            if (badSourceUrl) failedVideoSources.add(badSourceUrl)
          }
          ctx.restore()
          continue
        }

        ctx.restore()
        continue
      }
      if (maskEffect) {
        const maskAsset = maskEffect.shapeCanvas ? null : assetsState.getAssetById(maskEffect.maskAssetId)
        const maskFrameUrl = maskEffect.shapeCanvas
          ? null
          : getMaskFrameInfo(clip, maskAsset, time, !!transitionStyle)
        const maskImageMap = maskEffect.shapeCanvas ? null : maskElements.get(maskAsset?.id)
        const maskImage = maskEffect.shapeCanvas || maskImageMap?.get(maskFrameUrl)

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
          if (velocityMotionBlur) {
            applyVelocityMotionBlurToCanvas(offCanvas, offCtx, width, height, velocityMotionBlur)
          }

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
    
    const fadeOverlay = getFadeOverlayInfo(transitionInfo)
    if (fadeOverlay && fadeOverlay.opacity > 0.001) {
      if (gpu) {
        gpu.drawFill(fadeOverlay.color, Math.min(1, fadeOverlay.opacity))
      } else {
        ctx.save()
        ctx.globalAlpha = Math.min(1, fadeOverlay.opacity)
        ctx.fillStyle = fadeOverlay.color
        ctx.fillRect(0, 0, width, height)
        ctx.restore()
      }
    }
    exportPerf.layersMs += performance.now() - layersStart

    if (framePipeSessionId) {
      if (gpu && exportPipelineEnabled) {
        const readbackStart = performance.now()
        pendingGpuReadbacks.push(gpu.beginFrameReadback())
        exportPerf.readbackMs += performance.now() - readbackStart
        if (pendingGpuReadbacks.length > 1) {
          await sendOldestGpuReadback()
        }
      } else {
        const readbackStart = performance.now()
        let frameBuffer
        if (gpu) {
          frameBuffer = gpu.readFramePixels().buffer
        } else {
          const frameData = ctx.getImageData(0, 0, width, height)
          const pixelData = frameData.data
          frameBuffer = pixelData.byteOffset === 0 && pixelData.byteLength === pixelData.buffer.byteLength
            ? pixelData.buffer
            : pixelData.buffer.slice(pixelData.byteOffset, pixelData.byteOffset + pixelData.byteLength)
        }
        exportPerf.readbackMs += performance.now() - readbackStart
        await sendFrameToPipe(frameBuffer)
      }
      // Real task-queue yield while the write is in flight: decoder output
      // callbacks are event-loop tasks, and this loop is otherwise mostly
      // synchronous — without yielding, decoded frames sit undelivered
      // until the next seek is forced to wait for them.
      const taskYieldStart = performance.now()
      await scheduler.yieldTask()
      exportPerf.taskYieldMs += performance.now() - taskYieldStart
    } else {
      const frameBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      if (!frameBlob) {
        throw new Error(`Failed to encode PNG frame ${frameIndex + 1}.`)
      }
      const frameBuffer = await frameBlob.arrayBuffer()
      const frameFilename = pngSequenceExport
        ? getPngSequenceFrameFilename(pngSequenceBaseName, frameIndex + 1)
        : `frame_${formatFrameNumber(frameIndex + 1)}.png`
      const framePath = await window.electronAPI.pathJoin(framesFolder, frameFilename)
      const writeResult = await window.electronAPI.writeFileFromArrayBuffer(framePath, frameBuffer)
      if (!writeResult?.success) {
        throw new Error(writeResult?.error || `Failed to write PNG frame ${frameIndex + 1}.`)
      }
    }
    
    if (frameIndex % 5 === 0) {
      const progress = pngSequenceExport
        ? Math.max(1, Math.min(99, Math.floor(((frameIndex + 1) / totalFrames) * 99)))
        : 5 + Math.floor((frameIndex / totalFrames) * 70)
      onProgress({
        status: pngSequenceExport ? 'Writing PNG image sequence...' : EXPORT_STATUS.rendering,
        progress,
        frame: frameIndex + 1,
        totalFrames,
        ...(pngSequenceExport
          ? {
            frameCount: totalFrames,
            fps,
            width,
            height,
            dimensions: { width, height },
            framePattern,
          }
          : {}),
      })
    }
    if (frameIndex > 0 && frameIndex % 10 === 0) {
      const taskYieldStart = performance.now()
      await scheduler.yieldTask()
      exportPerf.taskYieldMs += performance.now() - taskYieldStart
    }

    // Frame-cursor lifecycle: warm decoders for clips that start soon so
    // cuts don't pay init latency, and release decoders (a scarce hardware
    // resource) for clips the playhead has passed.
    if (webCodecsEnabled) {
      for (const clip of renderableVideoClips) {
        if (clipFrameCursors.has(clip.id)) continue
        const { start: clipStart } = getClipPlaybackWindow(clip)
        if (clipStart > time && clipStart <= time + FRAME_CURSOR_PREFETCH_SEC) {
          getClipCursorEntry(clip)
        }
      }
      for (const [clipId, entry] of clipFrameCursors) {
        if (time > entry.clipEnd + 0.25) {
          closeClipCursorEntry(entry)
          clipFrameCursors.delete(clipId)
        }
      }
    }
  }
  while (pendingGpuReadbacks.length > 0) {
    await sendOldestGpuReadback()
  }
  while (inFlightPipeWrites.length > 0) {
    await settleOldestPipeWrite()
  }
  if (webCodecsEnabled) {
    console.log(
      `[Export] Frame sources: ${webCodecsClipCount} clip(s) via WebCodecs, ${elementPathClipCount} via video element; `
      + `source preparation ${sourcePreparation.remuxed} remuxed, ${sourcePreparation.transcoded} transcoded, ${sourcePreparation.reused} reused, ${sourcePreparation.failed} failed`
    )
  }
  closeAllFrameCursors()
  gpu?.dispose()
  } catch (err) {
    closeAllFrameCursors()
    gpu?.dispose()
    pendingGpuReadbacks.length = 0
    for (const write of inFlightPipeWrites) {
      Promise.resolve(write).catch(() => {})
    }
    inFlightPipeWrites.length = 0
    if (framePipeSessionId) {
      try {
        await window.electronAPI.abortFramePipe(framePipeSessionId)
      } catch {
        // ignore abort errors
      }
      framePipeSessionId = null
    }
    throw err
  }

  if (pngSequenceExport) {
    throwIfCancelled()
    const cleanupWarning = await cleanupCompletedPngSequenceTemp({
      api: window.electronAPI,
      tempFolder,
    })
    if (cleanupWarning) {
      console.warn('PNG sequence frames completed, but temporary files could not be removed:', cleanupWarning)
    }
    const completion = {
      status: EXPORT_STATUS.done,
      progress: 100,
      frame: totalFrames,
      totalFrames,
      frameCount: totalFrames,
      fps,
      width,
      height,
      dimensions: { width, height },
      framePattern,
    }
    onProgress(completion)
    const perFrameMs = (ms) => (totalFrames > 0 ? Number((ms / totalFrames).toFixed(2)) : 0)
    return {
      format: 'png-seq',
      outputPath,
      encoderUsed: 'png-sequence',
      frameCount: totalFrames,
      fps,
      width,
      height,
      dimensions: { width, height },
      framePattern,
      cleanupWarning: cleanupWarning
        ? `PNG frames were saved, but temporary files could not be removed: ${cleanupWarning}`
        : null,
      hardwareFallback: false,
      hardwareFfmpeg: null,
      frameSources: webCodecsEnabled
        ? {
          webcodecs: webCodecsClipCount,
          element: elementPathClipCount,
          sourcePreparation,
        }
        : null,
      perf: {
        frames: totalFrames,
        gpuCompositing: false,
        scheduling: scheduler.mode,
        perFrameMs: {
          mediaSample: perFrameMs(exportPerf.sampleMs),
          layerComposite: perFrameMs(exportPerf.layersMs - exportPerf.sampleMs),
          readback: perFrameMs(exportPerf.readbackMs),
          pipeWrite: 0,
          uiYield: perFrameMs(exportPerf.progressYieldMs + exportPerf.taskYieldMs),
          progressYield: perFrameMs(exportPerf.progressYieldMs),
          taskYield: perFrameMs(exportPerf.taskYieldMs),
        },
        preSeek: { batches: exportPerf.preSeekBatches, clips: exportPerf.preSeekClips },
        frameSource: getFrameSourceStats(),
      },
    }
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
    const { audioClips, activeTracks, eligibleAudioClips } = collectEligibleAudioMix(timelineState)
    // Program master gain from the mixer; part of the program, so it must be
    // baked into the export mix (unlike the preview-only monitor volume).
    const masterAudioGain = clampTrackVolume(timelineState.masterAudioVolume) / 100

    if (audioClips.length > 0 && activeTracks.length > 0) {
      const sampleRate = audioSampleRate || DEFAULT_SAMPLE_RATE
      const channelCount = audioChannels || 2

      // Shared module-level builders (see above exportTimeline) so the
      // pre-render validation, the audio-only export, and this mix can
      // never drift apart.
      const serializeClipForMix = serializeAudioClipForMix
      const serializeAssetsForMix = () => serializeAudioAssetsForMix(assetsState.assets)
      const countExpectedMixClips = (clips) => countExpectedAudioMixClips(clips, rangeStart, rangeEnd)
      console.log('[audio-mix] export payload', JSON.stringify({
        rangeStart,
        rangeEnd,
        totalDuration,
        activeTrackIds: activeTracks.map(track => track.id),
        clips: eligibleAudioClips.map(clip => ({
          id: clip.id,
          trackId: clip.trackId,
          startTime: clip.startTime,
          duration: clip.duration,
          trimStart: clip.trimStart || 0,
          assetId: clip.assetId,
        })),
      }))

      // Parses the RIFF/WAVE files our own FFmpeg stem mixes produce
      // (pcm_s16le, with float32 tolerated) into an AudioBuffer WITHOUT
      // Chromium's native decodeAudioData — which hard-crashes the export
      // worker's renderer (access violation 0xC0000005, observed on
      // Electron 28 with an ordinary 16-bit stem). A dead renderer can't
      // run its own timeout fallbacks, so that crash presented as an export
      // frozen forever on "Applying mixer effects…".
      const parseWavToAudioBuffer = (arrayBuffer, context) => {
        const view = new DataView(arrayBuffer)
        if (view.byteLength < 44
          || view.getUint32(0, false) !== 0x52494646 // 'RIFF'
          || view.getUint32(8, false) !== 0x57415645 // 'WAVE'
        ) {
          throw new Error('Stem is not a RIFF/WAVE file')
        }
        let offset = 12
        let fmt = null
        let dataOffset = -1
        let dataLength = 0
        while (offset + 8 <= view.byteLength) {
          const chunkId = view.getUint32(offset, false)
          const chunkSize = view.getUint32(offset + 4, true)
          const body = offset + 8
          if (chunkId === 0x666d7420 && body + 16 <= view.byteLength) { // 'fmt '
            fmt = {
              format: view.getUint16(body, true),
              channels: view.getUint16(body + 2, true),
              sampleRate: view.getUint32(body + 4, true),
              bitsPerSample: view.getUint16(body + 14, true),
            }
          } else if (chunkId === 0x64617461) { // 'data'
            dataOffset = body
            dataLength = Math.min(chunkSize, view.byteLength - body)
          }
          offset = body + chunkSize + (chunkSize % 2) // chunks are word-aligned
        }
        if (!fmt || dataOffset < 0) throw new Error('Stem WAV is missing fmt/data chunks')
        const { channels, sampleRate, bitsPerSample } = fmt
        const isFloat32 = (fmt.format === 3 || fmt.format === 0xfffe) && bitsPerSample === 32
        const isPcm16 = (fmt.format === 1 || fmt.format === 0xfffe) && bitsPerSample === 16
        if (!isFloat32 && !isPcm16) {
          throw new Error(`Unsupported stem WAV: format ${fmt.format}, ${bitsPerSample}-bit`)
        }
        if (!channels || channels > 8 || !sampleRate) {
          throw new Error(`Unsupported stem WAV layout: ${channels}ch @ ${sampleRate}Hz`)
        }
        const bytesPerSample = bitsPerSample / 8
        const frameCount = Math.floor(dataLength / (bytesPerSample * channels))
        if (frameCount <= 0) throw new Error('Stem WAV has no samples')
        // AudioBufferSourceNode resamples automatically if the WAV rate ever
        // differs from the offline context rate.
        const buffer = context.createBuffer(channels, frameCount, sampleRate)
        for (let ch = 0; ch < channels; ch++) {
          const out = buffer.getChannelData(ch)
          if (isFloat32) {
            for (let i = 0; i < frameCount; i++) {
              out[i] = view.getFloat32(dataOffset + (i * channels + ch) * 4, true)
            }
          } else {
            for (let i = 0; i < frameCount; i++) {
              out[i] = view.getInt16(dataOffset + (i * channels + ch) * 2, true) / 32768
            }
          }
        }
        return buffer
      }

      // Mixer insert effects (compressor/limiter/reverb) path: FFmpeg renders
      // one flat stem per track (clip gains/fades baked, fader EXCLUDED —
      // desk order puts the fader after inserts), then the SAME insert chains
      // the preview plays through (audioInsertChain) run in an
      // OfflineAudioContext: stem → track inserts → track fader →
      // master inserts → master gain. Parity by construction; never mirror
      // these effects in FFmpeg filters.
      const enabledMasterInserts = getEnabledAudioInserts(timelineState.masterAudioInserts)
      const anyInsertEffects = enabledMasterInserts.length > 0
        || activeTracks.some(track => hasEnabledAudioInserts(track.inserts))
      if (
        anyInsertEffects
        && window.electronAPI?.mixAudio
        && window.electronAPI?.readFileAsBuffer
        && eligibleAudioClips.length > 0
      ) {
        const stemPaths = []
        try {
          const stems = []
          for (const track of activeTracks) {
            const trackClips = eligibleAudioClips.filter(clip => clip.trackId === track.id)
            if (trackClips.length === 0) continue
            updateAudioStatus(`Rendering stem: ${track.name || track.id}`, 81)
            console.log(`[mixerfx] rendering stem for track ${track.id} (${trackClips.length} clips)`)
            const stemStart = Date.now()
            const stemPath = `${audioPath}.stem-${stems.length}.wav`
            const stemResult = await window.electronAPI.mixAudio({
              projectPath: projectHandle,
              outputPath: stemPath,
              rangeStart,
              rangeEnd,
              sampleRate,
              channels: channelCount,
              masterVolume: 100,
              timeoutMs: AUDIO_MIX_TIMEOUT_MS,
              clips: trackClips.map(serializeClipForMix),
              // volume 100 / pan 0: fader and pan apply post-inserts below
              tracks: [{
                id: track.id,
                type: track.type,
                muted: false,
                visible: true,
                channels: track.channels || 'stereo',
                volume: 100,
                pan: 0,
              }],
              assets: serializeAssetsForMix(),
            })
            if (!stemResult?.success) {
              throw new Error(stemResult?.error || `Stem mix failed for track ${track.id}`)
            }
            const expectedStemClipCount = countExpectedMixClips(trackClips)
            if (stemResult.clipCount !== expectedStemClipCount) {
              throw new Error(
                `Stem mix for ${track.name || track.id} included ${stemResult.clipCount || 0} of ${expectedStemClipCount} clips`
              )
            }
            stemPaths.push(stemPath)
            const readResult = await window.electronAPI.readFileAsBuffer(stemPath)
            if (!readResult?.success || !readResult.data) {
              throw new Error(readResult?.error || `Failed to read stem for track ${track.id}`)
            }
            stems.push({ track, data: readResult.data })
            console.log(`[mixerfx] stem done in ${Date.now() - stemStart}ms (${readResult.data?.byteLength ?? readResult.data?.length ?? '?'} bytes)`)
          }

          if (stems.length === 0) {
            throw new Error('No stems produced for insert-effects mix.')
          }

          updateAudioStatus('Applying mixer effects…', 85)
          const totalSamples = Math.ceil(totalDuration * sampleRate)
          console.log(`[mixerfx] offline ctx: ch=${channelCount} samples=${totalSamples} rate=${sampleRate} dur=${totalDuration}s stems=${stems.length}`)
          const offlineContext = new OfflineAudioContext(channelCount, totalSamples, sampleRate)

          const masterChain = buildInsertChain(offlineContext, enabledMasterInserts)
          const masterGainNode = offlineContext.createGain()
          masterGainNode.gain.value = masterAudioGain
          masterChain.output.connect(masterGainNode)
          masterGainNode.connect(offlineContext.destination)

          for (const stem of stems) {
            const bytes = stem.data
            const arrayBuffer = bytes instanceof ArrayBuffer
              ? bytes
              : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
            console.log(`[mixerfx] parsing stem for track ${stem.track.id} (${arrayBuffer.byteLength} bytes)`)
            const decodeStart = Date.now()
            const stemBuffer = parseWavToAudioBuffer(arrayBuffer, offlineContext)
            console.log(`[mixerfx] parsed in ${Date.now() - decodeStart}ms: ${stemBuffer.duration.toFixed(2)}s ${stemBuffer.numberOfChannels}ch @ ${stemBuffer.sampleRate}Hz`)
            const stemDurationTolerance = Math.max(2 / sampleRate, 0.002)
            if (stemBuffer.duration + stemDurationTolerance < totalDuration) {
              throw new Error(
                `Stem for ${stem.track.name || stem.track.id} is incomplete (${stemBuffer.duration.toFixed(3)}s of ${totalDuration.toFixed(3)}s)`
              )
            }
            const source = offlineContext.createBufferSource()
            source.buffer = stemBuffer
            const trackChain = buildInsertChain(offlineContext, stem.track.inserts)
            const faderGain = offlineContext.createGain()
            faderGain.gain.value = trackVolumeToLinearGain(stem.track.volume ?? 100)
            source.connect(trackChain.input)
            trackChain.output.connect(faderGain)
            let trackOutput = faderGain
            if (channelCount >= 2 && typeof offlineContext.createStereoPanner === 'function') {
              faderGain.channelCount = 2
              faderGain.channelCountMode = 'explicit'
              const panner = offlineContext.createStereoPanner()
              panner.pan.value = trackPanToStereoPosition(stem.track.pan)
              faderGain.connect(panner)
              trackOutput = panner
            }
            trackOutput.connect(masterChain.input)
            source.start(0)
          }

          console.log('[mixerfx] startRendering…')
          const renderStart = Date.now()
          const mixedBuffer = await withTimeout(
            offlineContext.startRendering(),
            AUDIO_MIX_TIMEOUT_MS,
            'Insert effects mix'
          )
          console.log(`[mixerfx] rendered in ${Date.now() - renderStart}ms`)
          updateAudioStatus('Writing WAV…', 88)
          const wavData = audioBufferToWav(mixedBuffer)
          await window.electronAPI.writeFileFromArrayBuffer(audioPath, wavData)
          audioFilePath = audioPath
          updateAudioStatus('Audio mix complete (mixer effects applied)', 89)
        } catch (err) {
          console.warn('Mixer effects mix failed, falling back to mix WITHOUT insert effects:', err)
          onProgress({ status: 'Mixer effects failed — exporting without insert effects', progress: 82 })
          audioFilePath = null
        } finally {
          if (window.electronAPI?.deleteFile) {
            for (const stemPath of stemPaths) {
              window.electronAPI.deleteFile(stemPath).catch(() => { /* temp file; ignore */ })
            }
          }
        }
      }

      // Preferred path: mix in main process with FFmpeg (avoids renderer OfflineAudioContext hangs).
      let mainProcessMixAttempted = false
      let mainProcessMixError = null
      if (!audioFilePath && window.electronAPI?.mixAudio && eligibleAudioClips.length > 0) {
        let ffmpegMixHeartbeat = null
        try {
          mainProcessMixAttempted = true
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
            masterVolume: masterAudioGain * 100,
            timeoutMs: AUDIO_MIX_TIMEOUT_MS,
            clips: eligibleAudioClips.map(serializeClipForMix),
            tracks: serializeAudioTracksForMix(timelineState.tracks),
            assets: serializeAssetsForMix(),
          })
          console.log('[audio-mix] FFmpeg result', JSON.stringify(mixResult))
          if (ffmpegMixHeartbeat) clearInterval(ffmpegMixHeartbeat)
          if (mixResult?.success) {
            const expectedMixClipCount = countExpectedMixClips(eligibleAudioClips)
            if (mixResult.clipCount !== expectedMixClipCount) {
              throw new Error(
                formatAudioMixDropError(mixResult.skipped, mixResult.clipCount || 0, expectedMixClipCount)
              )
            }
            audioFilePath = audioPath
            updateAudioStatus('Audio mix complete', 89)
          } else {
            throw new Error(mixResult?.error || 'FFmpeg audio mix failed')
          }
        } catch (err) {
          if (ffmpegMixHeartbeat) clearInterval(ffmpegMixHeartbeat)
          console.warn('FFmpeg audio mix failed:', err)
          mainProcessMixError = err
          audioFilePath = null
        }
      }

      // Fallback path for environments where FFmpeg mix IPC is unavailable.
      if (!audioFilePath) {
        // Chromium's native decoder can crash the hidden export renderer on
        // ordinary FLAC/WAV inputs (0xC0000005). When main-process FFmpeg was
        // available but failed, surface that failure instead of entering the
        // unsafe decoder fallback and taking the worker down.
        if (mainProcessMixAttempted) {
          throw new Error(mainProcessMixError?.message || 'Main-process audio mix failed.')
        }
        const totalSamples = Math.ceil(totalDuration * sampleRate)
        const offlineContext = new OfflineAudioContext(channelCount, totalSamples, sampleRate)
        const decodedAudioCache = new Map()
        const resolvedAudioUrlCache = new Map()

        // Mirror of the live graph's desk topology: clip gain → track inserts
        // → track fader → master inserts → master gain (mixer master fader).
        const offlineMasterGain = offlineContext.createGain()
        offlineMasterGain.gain.value = masterAudioGain
        offlineMasterGain.connect(offlineContext.destination)
        const offlineMasterChain = buildInsertChain(offlineContext, timelineState.masterAudioInserts)
        offlineMasterChain.output.connect(offlineMasterGain)

        const offlineTrackBuses = new Map()
        const getOfflineTrackBus = (track) => {
          let bus = offlineTrackBuses.get(track.id)
          if (!bus) {
            const chain = buildInsertChain(offlineContext, track.inserts)
            const fader = offlineContext.createGain()
            fader.gain.value = trackVolumeToLinearGain(track.volume ?? 100)
            chain.output.connect(fader)
            let output = fader
            if (channelCount >= 2 && typeof offlineContext.createStereoPanner === 'function') {
              fader.channelCount = 2
              fader.channelCountMode = 'explicit'
              const panner = offlineContext.createStereoPanner()
              panner.pan.value = trackPanToStereoPosition(track.pan)
              fader.connect(panner)
              output = panner
            }
            output.connect(offlineMasterChain.input)
            bus = { input: chain.input }
            offlineTrackBuses.set(track.id, bus)
          }
          return bus
        }

        for (let index = 0; index < eligibleAudioClips.length; index++) {
          const clip = eligibleAudioClips[index]
          const track = timelineState.tracks.find(t => t.id === clip.trackId)
          // eligibleAudioClips already applies the shared mute/solo/visibility
          // predicate; only guard against a concurrently removed track here.
          if (!track) continue
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
            const playbackWindow = getClipPlaybackWindow(clip)
            const visibleStart = Math.max(rangeStart, playbackWindow.start)
            const visibleEnd = Math.min(rangeEnd, playbackWindow.end)
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
            // Track volume applies at the bus fader (after inserts), not here
            const baseGain = getAudioClipLinearGain(clip)
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

            const envelopeGainNode = offlineContext.createGain()
            scheduleAudioVolumeEnvelope(envelopeGainNode.gain, clip, {
              localTime: startClipTime, contextTime: startOffset,
              endLocalTime: endClipTime,
            })
            source.playbackRate.value = timeScale
            const eqChain = createAudioEqChain(offlineContext, clip.audioEq)
            source.connect(eqChain.input)
            eqChain.output.connect(gainNode)
            gainNode.connect(envelopeGainNode)
            envelopeGainNode.connect(getOfflineTrackBus(track).input)
            source.start(startOffset, sourceOffset, playDuration)
          } catch (err) {
            console.warn('Failed to decode audio clip for export:', err)
            updateAudioStatus(`Failed clip ${index + 1}/${eligibleAudioClips.length} (skipped)`, 82)
          }
          await scheduler.yieldTask()
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
  
  onProgress({
    status: gifExport ? 'Building optimized 256-color GIF...' : EXPORT_STATUS.encoding,
    progress: 90,
  })
  await scheduler.yieldForProgress()

  let encodeResult = null
  if (gifExport) {
    if (!window.electronAPI?.encodeGif || !window.electronAPI?.abortGifEncode) {
      throw new Error('GIF export requires the Velorn desktop app. Restart Velorn and try again.')
    }
    throwIfCancelled()
    const gifEncodeSessionId = globalThis.crypto?.randomUUID?.()
      || `gif-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const abortNativeGifEncode = () => {
      Promise.resolve(window.electronAPI.abortGifEncode(gifEncodeSessionId)).catch(() => {
        // The main process may already have observed cancellation or exited.
      })
    }
    signal?.addEventListener?.('abort', abortNativeGifEncode, { once: true })
    try {
      throwIfCancelled()
      encodeResult = await window.electronAPI.encodeGif({
        sessionId: gifEncodeSessionId,
        framePattern,
        fps,
        outputPath,
      })
    } finally {
      signal?.removeEventListener?.('abort', abortNativeGifEncode)
    }
  } else if (framePipeEncoderUsed) {
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
        normalizeAudio,
        loudnessTarget,
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
      normalizeAudio,
      loudnessTarget,
      alpha: !!transparent,
      alphaCache: Boolean(soloClipSet),
    })
  }
  
  if (!encodeResult?.success) {
    throw new Error(encodeResult?.error || 'Failed to encode export.')
  }
  if (encodeResult.encoderUsed) {
    console.log(`Export encoded with: ${encodeResult.encoderUsed}`)
  }

  // Cleanup temp render files. GIF scratch is never retained, but a cleanup
  // failure is surfaced with the otherwise successful delivery.
  let gifTempCleanupError = null
  if (gifExport) {
    gifTempCleanupError = await cleanupGifTempFolder()
    if (gifTempCleanupError) {
      console.warn('Failed to clean GIF export temp folder:', gifTempCleanupError)
    }
  } else if (getLocalStorageFlag('exportKeepFrames')) {
    console.log('[Export] Keeping temp frame folder for diagnostics:', tempFolder)
  } else {
    try {
      await window.electronAPI.deleteDirectory(tempFolder, { recursive: true })
    } catch (err) {
      console.warn('Failed to clean export temp folder:', err)
    }
  }
  
  onProgress({ status: EXPORT_STATUS.done, progress: 100 })
  
  const perFrameMs = (ms) => (totalFrames > 0 ? Number((ms / totalFrames).toFixed(2)) : 0)
  return {
    ...(gifExport ? { format: 'gif' } : {}),
    outputPath,
    encoderUsed: encodeResult.encoderUsed || null,
    ...(gifExport ? {
      frameCount: totalFrames,
      fps,
      width,
      height,
      dimensions: { width, height },
      cleanupWarning: [
        encodeResult.cleanupWarning,
        gifTempCleanupError
          ? `The GIF was saved, but temporary render frames could not be removed: ${gifTempCleanupError}`
          : null,
      ].filter(Boolean).join(' ') || null,
    } : {}),
    // Set when a requested hardware encoder failed its runtime probe and the
    // export fell back to software ({requestedEncoder, fallbackEncoder,
    // reason}); surfaced in the worker-complete log and MCP export results.
    hardwareFallback: framePipeHardwareFallback || encodeResult.hardwareFallback || null,
    hardwareFfmpeg: framePipeHardwareFfmpeg || encodeResult.hardwareFfmpeg || null,
    // Surfaced in the main window's '[ExportPanel] Worker export complete'
    // log — the export runs in a hidden worker window whose own console
    // isn't visible in normal devtools captures.
    frameSources: webCodecsEnabled
      ? {
        webcodecs: webCodecsClipCount,
        element: elementPathClipCount,
        sourcePreparation,
      }
      : null,
    perf: {
      frames: totalFrames,
      gpuCompositing: !!gpu,
      scheduling: scheduler.mode,
      perFrameMs: {
        mediaSample: perFrameMs(exportPerf.sampleMs),
        layerComposite: perFrameMs(exportPerf.layersMs - exportPerf.sampleMs),
        readback: perFrameMs(exportPerf.readbackMs),
        pipeWrite: perFrameMs(exportPerf.pipeMs),
        uiYield: perFrameMs(exportPerf.progressYieldMs + exportPerf.taskYieldMs),
        progressYield: perFrameMs(exportPerf.progressYieldMs),
        taskYield: perFrameMs(exportPerf.taskYieldMs),
      },
      preSeek: { batches: exportPerf.preSeekBatches, clips: exportPerf.preSeekClips },
      frameSource: getFrameSourceStats(),
    },
  }
  } finally {
    // GIF scratch is never a user-owned delivery. Remove its lossless frames
    // after success, failure, or cancellation; the native encoder separately
    // owns and cleans its palette/staged output files.
    if (gifExport && !gifTempCleanupAttempted) {
      const cleanupError = await cleanupGifTempFolder()
      if (cleanupError) console.warn('Failed to clean GIF export temp folder:', cleanupError)
    }
  }
}

/**
 * PNG sequences are written into a new, caller-selected child directory.
 * This wrapper is the ownership boundary: it creates that directory with an
 * exclusive mkdir and removes exactly that directory if any later step fails
 * or is cancelled. Existing folders (including the selected parent) are
 * rejected and are never cleanup targets.
 */
export const exportTimeline = async (options = {}, onProgress = () => {}, runtime = {}) => {
  // Runtime-only context, not a saved preset or user-controllable job option.
  const scheduler = createExportScheduler({ offscreen: runtime.offscreen === true })
  try {
    if (options.format !== 'png-seq') {
      return await runExportTimeline(options, onProgress, scheduler)
    }

    const api = typeof window !== 'undefined' ? window.electronAPI : null
    if (!api?.exists || !api?.createDirectory || !api?.deleteDirectory || !api?.pathJoin || !api?.writeFileFromArrayBuffer) {
      throw new Error('PNG sequence export requires the Velorn desktop app.')
    }

    return await withOwnedPngSequenceOutput({
      api,
      outputPath: options.outputPath,
      run: outputPath => runExportTimeline({ ...options, outputPath }, onProgress, scheduler),
    })
  } finally {
    scheduler.dispose()
  }
}

export default exportTimeline
