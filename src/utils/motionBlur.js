export const DEFAULT_MOTION_BLUR_ENABLED = false
export const DEFAULT_MOTION_BLUR_SAMPLES = 8
export const DEFAULT_MOTION_BLUR_SHUTTER = 180
export const DEFAULT_MOTION_BLUR_MODE = 'auto'
// 'center' = real-camera shutter centered on the frame (Resolve/AE default):
// symmetric blur, energy-conserving box weights. 'trail' = the original
// behind-the-frame echo look with a boosted sharp current frame.
export const DEFAULT_MOTION_BLUR_POSITION = 'center'
// 0 = physically correct (no unblurred frame mixed back in). Raising it
// blends a crisp copy of the frame over the smear for readability.
export const DEFAULT_MOTION_BLUR_SHARPNESS = 0

export const MOTION_BLUR_MODES = ['auto', 'velocity', 'sampled']
export const MOTION_BLUR_POSITIONS = ['center', 'trail']

export const MOTION_BLUR_SAMPLE_LIMITS = {
  preview: 48,
  export: 48,
}

const MOTION_BLUR_TRAIL_WEIGHT_EXPONENT = 0.9
const MOTION_BLUR_FALLBACK_EXPOSURE_ALPHA = 0.85
const MOTION_BLUR_FALLBACK_SHARP_ALPHA = 0.42
const MOTION_BLUR_VECTOR_EPSILON = 0.25

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const normalizeMotionBlurMode = (mode) => {
  const normalized = String(mode || DEFAULT_MOTION_BLUR_MODE).trim().toLowerCase()
  return MOTION_BLUR_MODES.includes(normalized) ? normalized : DEFAULT_MOTION_BLUR_MODE
}
const normalizeMotionBlurPosition = (position) => {
  const normalized = String(position || DEFAULT_MOTION_BLUR_POSITION).trim().toLowerCase()
  return MOTION_BLUR_POSITIONS.includes(normalized) ? normalized : DEFAULT_MOTION_BLUR_POSITION
}
const numberOr = (value, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function normalizeMotionBlurSettings(transform = {}) {
  const enabled = transform?.motionBlurEnabled === true || transform?.motionBlur === true
  const mode = normalizeMotionBlurMode(transform?.motionBlurMode)
  const position = normalizeMotionBlurPosition(transform?.motionBlurPosition)
  const samples = clamp(
    Math.round(Number(transform?.motionBlurSamples) || DEFAULT_MOTION_BLUR_SAMPLES),
    2,
    48
  )
  const shutter = clamp(
    Number(transform?.motionBlurShutter) || DEFAULT_MOTION_BLUR_SHUTTER,
    1,
    360
  )
  const sharpnessRaw = Number(transform?.motionBlurSharpness)
  const sharpness = clamp(
    Number.isFinite(sharpnessRaw) ? sharpnessRaw : DEFAULT_MOTION_BLUR_SHARPNESS,
    0,
    1
  )

  return { enabled, mode, position, samples, shutter, sharpness }
}

export function getMotionBlurSamples(clip, clipTime, fps = 24, mode = 'preview') {
  const settings = normalizeMotionBlurSettings(clip?.transform || {})
  const safeFps = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : 24
  const maxSamples = MOTION_BLUR_SAMPLE_LIMITS[mode] || MOTION_BLUR_SAMPLE_LIMITS.preview
  const sampleCount = settings.enabled ? Math.min(settings.samples, maxSamples) : 1
  const clipDuration = Math.max(0, Number(clip?.duration) || 0)
  const safeClipTime = clipDuration > 0
    ? clamp(Number(clipTime) || 0, 0, clipDuration)
    : Math.max(0, Number(clipTime) || 0)

  if (!settings.enabled || settings.mode === 'velocity' || sampleCount <= 1) {
    return [{ clipTime: safeClipTime, weight: 1 }]
  }

  const frameDuration = 1 / safeFps
  const shutterDuration = frameDuration * (settings.shutter / 360)

  if (settings.position === 'center') {
    // Real-camera shutter: samples span symmetrically around the frame time
    // with uniform (box) weights normalized to unit exposure. No boosted
    // sharp frame — the symmetric window keeps the subject centered instead
    // of echo-trailing behind the motion.
    const centeredSamples = []
    for (let index = 0; index < sampleCount; index += 1) {
      const progress = sampleCount > 1 ? index / (sampleCount - 1) : 0.5
      const t = safeClipTime + shutterDuration * (progress - 0.5)
      if (t < 0 || (clipDuration > 0 && t > clipDuration)) continue
      centeredSamples.push(t)
    }
    if (centeredSamples.length === 0) {
      return [{ clipTime: safeClipTime, weight: 1 }]
    }
    const uniformWeight = 1 / centeredSamples.length
    return centeredSamples.map((sampleClipTime) => ({
      clipTime: sampleClipTime,
      weight: uniformWeight,
    }))
  }

  const temporalSamples = []
  for (let index = 0; index < sampleCount; index += 1) {
    const progress = index / (sampleCount - 1)
    const t = safeClipTime - shutterDuration * (1 - progress)
    if (t < 0 || (clipDuration > 0 && t > clipDuration)) continue
    temporalSamples.push({
      clipTime: t,
      isCurrent: index === sampleCount - 1,
      rawWeight: Math.pow(Math.max(0.025, progress), MOTION_BLUR_TRAIL_WEIGHT_EXPONENT),
    })
  }

  // Sharpness scales the boosted crisp current frame (and the exposure
  // headroom reserved for it). At 0 the trail is a pure normalized decay —
  // no readable copy riding on the smear.
  const sharpBoost = MOTION_BLUR_FALLBACK_SHARP_ALPHA * settings.sharpness
  const exposureAlpha = 1 - (1 - MOTION_BLUR_FALLBACK_EXPOSURE_ALPHA) * settings.sharpness
  const totalRawWeight = temporalSamples.reduce((sum, sample) => sum + sample.rawWeight, 0) || 1
  return temporalSamples.map(({ clipTime: sampleClipTime, rawWeight, isCurrent }) => {
    return {
      clipTime: sampleClipTime,
      weight: Math.min(
        1,
        (rawWeight / totalRawWeight) * exposureAlpha
          + (isCurrent ? sharpBoost : 0)
      ),
    }
  })
}

export function getVelocityMotionBlurOptions(clip, clipTime, fps = 24, resolveTransformAtTime = null) {
  const settings = normalizeMotionBlurSettings(clip?.transform || {})
  if (!settings.enabled || settings.mode === 'sampled' || settings.samples <= 1) return null

  const safeFps = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : 24
  const frameDuration = 1 / safeFps
  const shutterDuration = frameDuration * (settings.shutter / 360)
  const clipDuration = Math.max(0, Number(clip?.duration) || 0)
  const safeClipTime = clipDuration > 0
    ? clamp(Number(clipTime) || 0, 0, clipDuration)
    : Math.max(0, Number(clipTime) || 0)
  const centered = settings.position === 'center'
  // Centered shutter measures velocity across [t - s/2, t + s/2]; trail
  // keeps the historical behind-the-frame window.
  const windowStart = centered ? safeClipTime - shutterDuration / 2 : safeClipTime - shutterDuration
  const windowEnd = centered ? safeClipTime + shutterDuration / 2 : safeClipTime
  const previousClipTime = clipDuration > 0
    ? clamp(windowStart, 0, clipDuration)
    : Math.max(0, windowStart)
  const nextClipTime = clipDuration > 0
    ? clamp(windowEnd, 0, clipDuration)
    : Math.max(0, windowEnd)

  if (Math.abs(nextClipTime - previousClipTime) < 0.000001) return null

  const resolveTransform = typeof resolveTransformAtTime === 'function'
    ? resolveTransformAtTime
    : () => (clip?.transform || {})
  const currentTransform = resolveTransform(nextClipTime) || {}
  const previousTransform = resolveTransform(previousClipTime) || {}
  const velocityX = numberOr(currentTransform.positionX) - numberOr(previousTransform.positionX)
  const velocityY = numberOr(currentTransform.positionY) - numberOr(previousTransform.positionY)
  const length = Math.hypot(velocityX, velocityY)

  if (length < MOTION_BLUR_VECTOR_EPSILON) return null

  return {
    velocityX,
    velocityY,
    samples: settings.samples,
    shutter: settings.shutter,
    sharpness: settings.sharpness,
    centered,
  }
}

export function hasMotionBlurEnabled(clip) {
  return normalizeMotionBlurSettings(clip?.transform || {}).enabled
}
