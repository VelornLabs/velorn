export const DEFAULT_MOTION_BLUR_ENABLED = false
export const DEFAULT_MOTION_BLUR_SAMPLES = 8
export const DEFAULT_MOTION_BLUR_SHUTTER = 180
export const DEFAULT_MOTION_BLUR_MODE = 'auto'

export const MOTION_BLUR_MODES = ['auto', 'velocity', 'sampled']

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
const numberOr = (value, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function normalizeMotionBlurSettings(transform = {}) {
  const enabled = transform?.motionBlurEnabled === true || transform?.motionBlur === true
  const mode = normalizeMotionBlurMode(transform?.motionBlurMode)
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

  return { enabled, mode, samples, shutter }
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

  const totalRawWeight = temporalSamples.reduce((sum, sample) => sum + sample.rawWeight, 0) || 1
  return temporalSamples.map(({ clipTime: sampleClipTime, rawWeight, isCurrent }) => {
    return {
      clipTime: sampleClipTime,
      weight: Math.min(
        1,
        (rawWeight / totalRawWeight) * MOTION_BLUR_FALLBACK_EXPOSURE_ALPHA
          + (isCurrent ? MOTION_BLUR_FALLBACK_SHARP_ALPHA : 0)
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
  const previousClipTime = clipDuration > 0
    ? clamp(safeClipTime - shutterDuration, 0, clipDuration)
    : Math.max(0, safeClipTime - shutterDuration)

  if (Math.abs(previousClipTime - safeClipTime) < 0.000001) return null

  const resolveTransform = typeof resolveTransformAtTime === 'function'
    ? resolveTransformAtTime
    : () => (clip?.transform || {})
  const currentTransform = resolveTransform(safeClipTime) || {}
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
  }
}

export function hasMotionBlurEnabled(clip) {
  return normalizeMotionBlurSettings(clip?.transform || {}).enabled
}
