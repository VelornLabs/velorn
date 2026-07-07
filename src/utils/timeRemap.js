/**
 * Speed ramps (time remapping): keyframed clip speed via clip.keyframes.speed.
 *
 * With a ramp, the source time consumed by clip time t is
 *   sourceTime(t) = trimStart + baseScale * INTEGRAL(0..t) speed(u) du
 * instead of the constant-speed trimStart + t * baseScale * speed.
 *
 * The integral is precomputed at a fixed sample step and cached per clip
 * OBJECT — the store replaces clip objects immutably on every change, so a
 * WeakMap gives exact invalidation for free.
 *
 * Scope: video ramping only. Reverse clips and linked audio keep constant
 * speed. Timeline duration stays fixed; running past the trimmed source
 * clamps (freeze on the last frame). Kill switch:
 * localStorage 'comfystudio-speed-ramp' = '0'.
 */

import { getValueAtTime } from './keyframes'

const SPEED_RAMP_FLAG_KEY = 'comfystudio-speed-ramp'
const INTEGRAL_SAMPLES_PER_SECOND = 240
const MIN_RAMP_SPEED = 0.05
const MAX_RAMP_SPEED = 16

const integralCache = new WeakMap()

export const isSpeedRampEnabled = () => {
  try {
    return window.localStorage.getItem(SPEED_RAMP_FLAG_KEY) !== '0'
  } catch (_) {
    return true
  }
}

const clampSpeed = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 1
  return Math.max(MIN_RAMP_SPEED, Math.min(MAX_RAMP_SPEED, parsed))
}

/**
 * True when the clip has an active speed ramp the renderers should honor.
 */
export function hasSpeedRamp(clip) {
  if (!clip || clip.reverse) return false
  const speedKeyframes = clip.keyframes?.speed
  if (!Array.isArray(speedKeyframes) || speedKeyframes.length === 0) return false
  return isSpeedRampEnabled()
}

/**
 * Instantaneous ramped speed at a clip time (multiplier, without baseScale).
 */
export function getRampedSpeedAtTime(clip, clipTime) {
  const baseSpeed = Number(clip?.speed) > 0 ? Number(clip.speed) : 1
  return clampSpeed(getValueAtTime(clip?.keyframes?.speed, clipTime, baseSpeed))
}

function buildSpeedIntegral(clip) {
  const duration = Math.max(0, Number(clip?.duration) || 0)
  const sampleCount = Math.max(2, Math.ceil(duration * INTEGRAL_SAMPLES_PER_SECOND) + 1)
  const step = duration > 0 ? duration / (sampleCount - 1) : 0
  const cumulative = new Float64Array(sampleCount)

  let previousSpeed = getRampedSpeedAtTime(clip, 0)
  for (let index = 1; index < sampleCount; index += 1) {
    const t = index * step
    const speed = getRampedSpeedAtTime(clip, t)
    // Trapezoid rule over the eased speed curve.
    cumulative[index] = cumulative[index - 1] + ((previousSpeed + speed) / 2) * step
    previousSpeed = speed
  }

  return { cumulative, step, duration }
}

function getSpeedIntegral(clip) {
  let entry = integralCache.get(clip)
  if (!entry) {
    entry = buildSpeedIntegral(clip)
    integralCache.set(clip, entry)
  }
  return entry
}

/**
 * Source-time seconds consumed from clip start to clipTime, in clip-speed
 * units (multiply by the clip's baseScale for source seconds when the source
 * fps differs from the timeline).
 *
 * Times outside [0, duration] extrapolate linearly with the edge speed so
 * transition handles keep working.
 */
export function getRampedSourceOffset(clip, clipTime) {
  const parsedTime = Number(clipTime)
  if (!Number.isFinite(parsedTime)) return 0

  const { cumulative, step, duration } = getSpeedIntegral(clip)

  if (parsedTime <= 0) {
    return parsedTime * getRampedSpeedAtTime(clip, 0)
  }
  if (parsedTime >= duration || step <= 0) {
    const overshoot = parsedTime - duration
    return cumulative[cumulative.length - 1] + overshoot * getRampedSpeedAtTime(clip, duration)
  }

  const exactIndex = parsedTime / step
  const lowerIndex = Math.min(cumulative.length - 2, Math.floor(exactIndex))
  const blend = exactIndex - lowerIndex
  return cumulative[lowerIndex] + (cumulative[lowerIndex + 1] - cumulative[lowerIndex]) * blend
}
