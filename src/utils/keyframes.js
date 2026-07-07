/**
 * Keyframe utilities for animation interpolation
 * 
 * Keyframe structure:
 * {
 *   time: number,      // Time in seconds (relative to clip start)
 *   value: number,     // The value at this keyframe
 *   easing: string,    // Easing: 'linear', 'easeIn', 'easeOut', 'easeInOut', 'hold', or cubicBezier(x1,y1,x2,y2)
 * }
 */

import {
  DEFAULT_ADJUSTMENT_SETTINGS,
  GLOBAL_ADJUSTMENT_KEYS,
  TONAL_ADJUSTMENT_GROUP_KEYS,
  TONAL_ADJUSTMENT_PROPERTY_IDS,
  getAdjustmentValue,
  normalizeAdjustmentSettings,
  setAdjustmentValue,
} from './adjustments'
import { normalizeShapeProperties } from './shapes'

// Easing functions (t is normalized 0-1)
export const easingFunctions = {
  linear: (t) => t,
  
  easeIn: (t) => t * t,
  
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  
  easeInOut: (t) => t < 0.5 
    ? 2 * t * t 
    : 1 - Math.pow(-2 * t + 2, 2) / 2,
  
  // Cubic versions (smoother)
  easeInCubic: (t) => t * t * t,
  
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
  
  easeInOutCubic: (t) => t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2,
  
  // Hold - no interpolation, jump to value
  hold: () => 0,
}

function clampUnit(value) {
  return Math.max(0, Math.min(1, value))
}

export const DEFAULT_KEYFRAME_TIME_TOLERANCE = 0.05

/**
 * Frame-rate-aware keyframe matching tolerance: half a frame at the given
 * fps, capped at the legacy 0.05s window. A fixed 0.05s is wider than one
 * frame at 24/30fps, which made adjacent-frame keyframes overwrite each other.
 *
 * @param {number} fps - Timeline frames per second
 * @returns {number} - Tolerance in seconds
 */
export function getKeyframeTimeTolerance(fps) {
  const parsedFps = Number(fps)
  if (!Number.isFinite(parsedFps) || parsedFps <= 0) return DEFAULT_KEYFRAME_TIME_TOLERANCE
  return Math.min(DEFAULT_KEYFRAME_TIME_TOLERANCE, 0.5 / parsedFps)
}

export function parseCubicBezierEasing(easing) {
  const match = String(easing || '').trim().match(/^cubic-?bezier\(\s*(-?(?:\d+\.?\d*|\.\d+))\s*,\s*(-?(?:\d+\.?\d*|\.\d+))\s*,\s*(-?(?:\d+\.?\d*|\.\d+))\s*,\s*(-?(?:\d+\.?\d*|\.\d+))\s*\)$/i)
  if (!match) return null

  const [, x1Raw, y1Raw, x2Raw, y2Raw] = match
  const x1 = Number(x1Raw)
  const y1 = Number(y1Raw)
  const x2 = Number(x2Raw)
  const y2 = Number(y2Raw)
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null

  // CSS cubic-bezier curves require x handles between 0 and 1 so time moves forward.
  return {
    x1: clampUnit(x1),
    y1: Math.max(-10, Math.min(10, y1)),
    x2: clampUnit(x2),
    y2: Math.max(-10, Math.min(10, y2)),
  }
}

function cubicBezierAt(t, p1, p2) {
  const inverseT = 1 - t
  return 3 * inverseT * inverseT * t * p1
    + 3 * inverseT * t * t * p2
    + t * t * t
}

function cubicBezierDerivativeAt(t, p1, p2) {
  const inverseT = 1 - t
  return 3 * inverseT * inverseT * p1
    + 6 * inverseT * t * (p2 - p1)
    + 3 * t * t * (1 - p2)
}

function createCubicBezierEasing({ x1, y1, x2, y2 }) {
  return (time) => {
    const x = clampUnit(time)
    let curveT = x

    for (let i = 0; i < 8; i++) {
      const estimate = cubicBezierAt(curveT, x1, x2) - x
      const derivative = cubicBezierDerivativeAt(curveT, x1, x2)
      if (Math.abs(estimate) < 0.000001 || Math.abs(derivative) < 0.000001) break
      curveT = clampUnit(curveT - estimate / derivative)
    }

    let low = 0
    let high = 1
    for (let i = 0; i < 12 && Math.abs(cubicBezierAt(curveT, x1, x2) - x) > 0.000001; i++) {
      if (cubicBezierAt(curveT, x1, x2) < x) low = curveT
      else high = curveT
      curveT = (low + high) / 2
    }

    return cubicBezierAt(curveT, y1, y2)
  }
}

/**
 * Serialize bezier control points to the easing-string form the engine parses.
 *
 * @param {{ x1: number, y1: number, x2: number, y2: number }} points
 * @returns {string}
 */
export function formatCubicBezierEasing({ x1, y1, x2, y2 }) {
  const fmt = (value) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Number(parsed.toFixed(3)) : 0
  }
  return `cubic-bezier(${fmt(x1)}, ${fmt(y1)}, ${fmt(x2)}, ${fmt(y2)})`
}

export function getEasingFunction(easing) {
  const key = String(easing || 'linear').trim()
  if (easingFunctions[key]) return easingFunctions[key]
  const cubicBezier = parseCubicBezierEasing(key)
  return cubicBezier ? createCubicBezierEasing(cubicBezier) : easingFunctions.linear
}

/**
 * Available easing options for UI
 */
export const EASING_OPTIONS = [
  { id: 'linear', label: 'Linear', icon: '/' },
  { id: 'easeIn', label: 'Ease In', icon: '⌒' },
  { id: 'easeOut', label: 'Ease Out', icon: '⌓' },
  { id: 'easeInOut', label: 'Ease In/Out', icon: '∿' },
  { id: 'hold', label: 'Hold', icon: '▭' },
]

/**
 * Properties that can be keyframed
 */
export const KEYFRAMEABLE_PROPERTIES = [
  // 'speed' drives time remapping (see utils/timeRemap.js), not the visual
  // transform — getAnimatedTransform skips it.
  { id: 'speed', label: 'Speed', group: 'time', unit: 'x' },
  { id: 'positionX', label: 'Position X', group: 'position', unit: 'px' },
  { id: 'positionY', label: 'Position Y', group: 'position', unit: 'px' },
  { id: 'positionZ', label: 'Position Z', group: 'position', unit: 'px' },
  { id: 'scaleX', label: 'Scale X', group: 'scale', unit: '%' },
  { id: 'scaleY', label: 'Scale Y', group: 'scale', unit: '%' },
  { id: 'rotationX', label: 'Rotate X', group: 'rotation', unit: 'deg' },
  { id: 'rotationY', label: 'Rotate Y', group: 'rotation', unit: 'deg' },
  { id: 'perspective', label: 'Perspective', group: 'perspective', unit: 'px' },
  { id: 'rotation', label: 'Rotation', group: 'rotation', unit: '°' },
  { id: 'opacity', label: 'Opacity', group: 'opacity', unit: '%' },
  { id: 'blur', label: 'Blur', group: 'effects', unit: 'px' },
  { id: 'anchorX', label: 'Anchor X', group: 'anchor', unit: '%' },
  { id: 'anchorY', label: 'Anchor Y', group: 'anchor', unit: '%' },
  { id: 'cropTop', label: 'Crop Top', group: 'crop', unit: '%' },
  { id: 'cropBottom', label: 'Crop Bottom', group: 'crop', unit: '%' },
  { id: 'cropLeft', label: 'Crop Left', group: 'crop', unit: '%' },
  { id: 'cropRight', label: 'Crop Right', group: 'crop', unit: '%' },
  { id: 'cornerPinTLX', label: 'Pin TL X', group: 'cornerPin', unit: 'px' },
  { id: 'cornerPinTLY', label: 'Pin TL Y', group: 'cornerPin', unit: 'px' },
  { id: 'cornerPinTRX', label: 'Pin TR X', group: 'cornerPin', unit: 'px' },
  { id: 'cornerPinTRY', label: 'Pin TR Y', group: 'cornerPin', unit: 'px' },
  { id: 'cornerPinBLX', label: 'Pin BL X', group: 'cornerPin', unit: 'px' },
  { id: 'cornerPinBLY', label: 'Pin BL Y', group: 'cornerPin', unit: 'px' },
  { id: 'cornerPinBRX', label: 'Pin BR X', group: 'cornerPin', unit: 'px' },
  { id: 'cornerPinBRY', label: 'Pin BR Y', group: 'cornerPin', unit: 'px' },
  { id: 'brightness', label: 'Exposure', group: 'adjustments', unit: '' },
  { id: 'contrast', label: 'Contrast', group: 'adjustments', unit: '' },
  { id: 'saturation', label: 'Saturation', group: 'adjustments', unit: '' },
  { id: 'gain', label: 'Gain', group: 'adjustments', unit: '' },
  { id: 'gamma', label: 'Gamma', group: 'adjustments', unit: '' },
  { id: 'offset', label: 'Offset', group: 'adjustments', unit: '' },
  { id: 'hue', label: 'Hue', group: 'adjustments', unit: 'deg' },
  ...TONAL_ADJUSTMENT_GROUP_KEYS.flatMap((groupKey) => [
    { id: `${groupKey}.brightness`, label: `${groupKey.charAt(0).toUpperCase() + groupKey.slice(1)} Exposure`, group: 'adjustments', unit: '' },
    { id: `${groupKey}.contrast`, label: `${groupKey.charAt(0).toUpperCase() + groupKey.slice(1)} Contrast`, group: 'adjustments', unit: '' },
    { id: `${groupKey}.saturation`, label: `${groupKey.charAt(0).toUpperCase() + groupKey.slice(1)} Saturation`, group: 'adjustments', unit: '' },
    { id: `${groupKey}.gain`, label: `${groupKey.charAt(0).toUpperCase() + groupKey.slice(1)} Gain`, group: 'adjustments', unit: '' },
    { id: `${groupKey}.gamma`, label: `${groupKey.charAt(0).toUpperCase() + groupKey.slice(1)} Gamma`, group: 'adjustments', unit: '' },
    { id: `${groupKey}.offset`, label: `${groupKey.charAt(0).toUpperCase() + groupKey.slice(1)} Offset`, group: 'adjustments', unit: '' },
    { id: `${groupKey}.hue`, label: `${groupKey.charAt(0).toUpperCase() + groupKey.slice(1)} Hue`, group: 'adjustments', unit: 'deg' },
  ]),
]

export const ADJUSTMENT_KEYFRAME_PROPERTIES = [...GLOBAL_ADJUSTMENT_KEYS, ...TONAL_ADJUSTMENT_PROPERTY_IDS]

export const SHAPE_KEYFRAMEABLE_PROPERTIES = [
  { id: 'width', label: 'Shape Width', group: 'shape', unit: 'px' },
  { id: 'height', label: 'Shape Height', group: 'shape', unit: 'px' },
  { id: 'fillOpacity', label: 'Fill Opacity', group: 'shape', unit: '%' },
  { id: 'gradientAngle', label: 'Gradient Angle', group: 'shape', unit: 'deg' },
  { id: 'gradientCenterX', label: 'Gradient Center X', group: 'shape', unit: '%' },
  { id: 'gradientCenterY', label: 'Gradient Center Y', group: 'shape', unit: '%' },
  { id: 'gradientRadius', label: 'Gradient Radius', group: 'shape', unit: '%' },
  { id: 'strokeWidth', label: 'Stroke Width', group: 'shape', unit: 'px' },
  { id: 'strokeOpacity', label: 'Stroke Opacity', group: 'shape', unit: '%' },
  { id: 'cornerRadius', label: 'Corner Radius', group: 'shape', unit: 'px' },
  { id: 'sides', label: 'Polygon Sides', group: 'shape', unit: '' },
]

/**
 * Get the value of a property at a specific time, interpolating between keyframes
 * 
 * @param {Array} keyframes - Array of keyframes for this property, sorted by time
 * @param {number} time - Time in seconds (relative to clip start)
 * @param {number} defaultValue - Default value if no keyframes exist
 * @returns {number} - Interpolated value at the given time
 */
export function getValueAtTime(keyframes, time, defaultValue = 0) {
  // No keyframes - return default
  if (!keyframes || keyframes.length === 0) {
    return defaultValue
  }
  
  // Single keyframe - return its value
  if (keyframes.length === 1) {
    return keyframes[0].value
  }
  
  // Sort keyframes by time (should already be sorted, but just in case)
  const sorted = [...keyframes].sort((a, b) => a.time - b.time)
  
  // Before first keyframe - return first value
  if (time <= sorted[0].time) {
    return sorted[0].value
  }
  
  // After last keyframe - return last value
  if (time >= sorted[sorted.length - 1].time) {
    return sorted[sorted.length - 1].value
  }
  
  // Find surrounding keyframes
  let prevKeyframe = sorted[0]
  let nextKeyframe = sorted[1]
  
  for (let i = 0; i < sorted.length - 1; i++) {
    if (time >= sorted[i].time && time <= sorted[i + 1].time) {
      prevKeyframe = sorted[i]
      nextKeyframe = sorted[i + 1]
      break
    }
  }
  
  // Calculate normalized time between keyframes (0-1)
  const duration = nextKeyframe.time - prevKeyframe.time
  if (duration === 0) return prevKeyframe.value
  
  const t = (time - prevKeyframe.time) / duration
  
  // Apply easing function from the previous keyframe
  const easingFn = getEasingFunction(prevKeyframe.easing)
  
  // Handle 'hold' easing - no interpolation
  if (prevKeyframe.easing === 'hold') {
    return prevKeyframe.value
  }
  
  const easedT = easingFn(t)
  
  // Linear interpolation with eased time
  return prevKeyframe.value + (nextKeyframe.value - prevKeyframe.value) * easedT
}

function parseHexColor(value) {
  const raw = String(value || '').trim()
  const shortMatch = raw.match(/^#([0-9a-fA-F]{3})$/)
  if (shortMatch) {
    const [r, g, b] = shortMatch[1].split('').map((part) => parseInt(`${part}${part}`, 16))
    return { r, g, b }
  }

  const match = raw.match(/^#([0-9a-fA-F]{6})$/)
  if (!match) return null
  return {
    r: parseInt(match[1].slice(0, 2), 16),
    g: parseInt(match[1].slice(2, 4), 16),
    b: parseInt(match[1].slice(4, 6), 16),
  }
}

function colorChannelToHex(value) {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
}

function rgbToHex({ r, g, b }) {
  return `#${colorChannelToHex(r)}${colorChannelToHex(g)}${colorChannelToHex(b)}`
}

/**
 * Get an interpolated hex color at a specific time.
 *
 * @param {Array} keyframes - Color keyframes with #RRGGBB values
 * @param {number} time - Time in seconds (relative to clip start)
 * @param {string} defaultValue - Default hex color
 * @returns {string}
 */
export function getColorAtTime(keyframes, time, defaultValue = '#ffffff') {
  const fallback = parseHexColor(defaultValue) ? String(defaultValue).trim() : '#ffffff'
  const parsedTime = Number(time)
  if (!Number.isFinite(parsedTime)) return fallback
  if (!keyframes || keyframes.length === 0) return fallback

  const sorted = [...keyframes]
    .filter((keyframe) => Number.isFinite(Number(keyframe?.time)) && parseHexColor(keyframe?.value))
    .sort((a, b) => a.time - b.time)

  if (sorted.length === 0) return fallback
  if (sorted.length === 1) return String(sorted[0].value).trim()
  if (parsedTime <= sorted[0].time) return String(sorted[0].value).trim()
  if (parsedTime >= sorted[sorted.length - 1].time) return String(sorted[sorted.length - 1].value).trim()

  let prevKeyframe = sorted[0]
  let nextKeyframe = sorted[1]
  for (let i = 0; i < sorted.length - 1; i++) {
    if (parsedTime >= sorted[i].time && parsedTime <= sorted[i + 1].time) {
      prevKeyframe = sorted[i]
      nextKeyframe = sorted[i + 1]
      break
    }
  }

  if (prevKeyframe.easing === 'hold') {
    return String(prevKeyframe.value).trim()
  }

  const duration = nextKeyframe.time - prevKeyframe.time
  if (duration === 0) return String(prevKeyframe.value).trim()

  const t = (parsedTime - prevKeyframe.time) / duration
  const easingFn = getEasingFunction(prevKeyframe.easing)
  const easedT = easingFn(t)
  const from = parseHexColor(prevKeyframe.value)
  const to = parseHexColor(nextKeyframe.value)
  if (!from || !to) return fallback

  return rgbToHex({
    r: from.r + (to.r - from.r) * easedT,
    g: from.g + (to.g - from.g) * easedT,
    b: from.b + (to.b - from.b) * easedT,
  })
}

export function getAnimatedTextProperties(clip, clipTime) {
  const textProperties = { ...(clip?.textProperties || {}) }
  const textColorKeyframes = clip?.keyframes?.textColor
  if (textColorKeyframes && textColorKeyframes.length > 0) {
    textProperties.textColor = getColorAtTime(
      textColorKeyframes,
      clipTime,
      textProperties.textColor || '#ffffff'
    )
  }
  return textProperties
}

export function getAnimatedShapeProperties(clip, clipTime) {
  if (!clip) return null

  const baseShapeProperties = normalizeShapeProperties(clip.shapeProperties || {})
  const keyframes = clip.keyframes || {}
  const animatedShapeProperties = { ...baseShapeProperties }

  for (const prop of SHAPE_KEYFRAMEABLE_PROPERTIES) {
    const propKeyframes = keyframes[prop.id]
    if (propKeyframes && propKeyframes.length > 0) {
      animatedShapeProperties[prop.id] = getValueAtTime(
        propKeyframes,
        clipTime,
        baseShapeProperties[prop.id]
      )
    }
  }

  return normalizeShapeProperties(animatedShapeProperties)
}

// ==================== MOTION PATHS ====================
// Spatial position interpolation: when positionX and positionY keyframes
// share the same times and the clip opts in (transform.motionPathMode =
// 'smooth'), position interpolates along a Catmull-Rom spline through the
// keyframe points (curved arcs) instead of independent per-axis scalars
// (straight lines). Timing along each segment still follows the X
// keyframe's easing.

const MOTION_PATH_TIME_EPSILON = 0.0005

/**
 * Paired position keyframes as spatial points, or null when positionX/Y
 * keyframes don't line up (different counts or times).
 *
 * @returns {Array<{ time, x, y, easing }>|null}
 */
export function getPositionKeyframePoints(clip) {
  const xKeyframes = clip?.keyframes?.positionX
  const yKeyframes = clip?.keyframes?.positionY
  if (!Array.isArray(xKeyframes) || !Array.isArray(yKeyframes)) return null
  if (xKeyframes.length < 2 || xKeyframes.length !== yKeyframes.length) return null

  const sortedX = [...xKeyframes].sort((a, b) => a.time - b.time)
  const sortedY = [...yKeyframes].sort((a, b) => a.time - b.time)
  const points = []
  for (let index = 0; index < sortedX.length; index += 1) {
    if (Math.abs(sortedX[index].time - sortedY[index].time) > MOTION_PATH_TIME_EPSILON) return null
    points.push({
      time: sortedX[index].time,
      x: Number(sortedX[index].value) || 0,
      y: Number(sortedY[index].value) || 0,
      easing: sortedX[index].easing || 'linear',
    })
  }
  return points
}

export function isMotionPathSmooth(clip) {
  return (clip?.transform?.motionPathMode || 'linear') === 'smooth'
}

function evalSmoothMotionPath(points, time) {
  const count = points.length
  if (time <= points[0].time) return { x: points[0].x, y: points[0].y }
  if (time >= points[count - 1].time) return { x: points[count - 1].x, y: points[count - 1].y }

  let segment = 0
  for (let index = 0; index < count - 1; index += 1) {
    if (time >= points[index].time && time <= points[index + 1].time) {
      segment = index
      break
    }
  }

  const from = points[segment]
  const to = points[segment + 1]
  if (from.easing === 'hold') return { x: from.x, y: from.y }

  const duration = to.time - from.time
  if (duration <= 0) return { x: from.x, y: from.y }
  const s = getEasingFunction(from.easing)((time - from.time) / duration)

  // Catmull-Rom neighbors -> cubic bezier control points (After Effects'
  // "auto bezier" shape). End segments clamp to their own endpoint.
  const prev = points[Math.max(0, segment - 1)]
  const next = points[Math.min(count - 1, segment + 2)]
  const c1x = from.x + (to.x - prev.x) / 6
  const c1y = from.y + (to.y - prev.y) / 6
  const c2x = to.x - (next.x - from.x) / 6
  const c2y = to.y - (next.y - from.y) / 6

  const inv = 1 - s
  const b0 = inv * inv * inv
  const b1 = 3 * inv * inv * s
  const b2 = 3 * inv * s * s
  const b3 = s * s * s
  return {
    x: b0 * from.x + b1 * c1x + b2 * c2x + b3 * to.x,
    y: b0 * from.y + b1 * c1y + b2 * c2y + b3 * to.y,
  }
}

/**
 * Spatial position at a clip time, or null when the clip doesn't qualify
 * (mode not 'smooth', or unpaired position keyframes).
 */
export function getMotionPathPositionAtTime(clip, clipTime) {
  if (!isMotionPathSmooth(clip)) return null
  const points = getPositionKeyframePoints(clip)
  if (!points) return null
  return evalSmoothMotionPath(points, clipTime)
}

/**
 * Get all animated transform values at a specific time
 *
 * @param {Object} clip - The clip object with transform and keyframes
 * @param {number} clipTime - Time relative to clip start (in seconds)
 * @returns {Object} - Transform object with interpolated values
 */
export function getAnimatedTransform(clip, clipTime) {
  if (!clip) return null
  
  const baseTransform = clip.transform || {}
  const keyframes = clip.keyframes || {}
  
  // Start with base transform values
  const animatedTransform = { ...baseTransform }
  
  // Override with keyframed values
  for (const prop of KEYFRAMEABLE_PROPERTIES) {
    if (prop.group === 'time') continue // speed remaps time, not the transform
    const propKeyframes = keyframes[prop.id]
    if (propKeyframes && propKeyframes.length > 0) {
      animatedTransform[prop.id] = getValueAtTime(
        propKeyframes,
        clipTime,
        baseTransform[prop.id]
      )
    }
  }

  // Smooth motion path: curved spatial interpolation replaces the per-axis
  // straight-line position when the clip opts in.
  const spatialPosition = getMotionPathPositionAtTime(clip, clipTime)
  if (spatialPosition) {
    animatedTransform.positionX = spatialPosition.x
    animatedTransform.positionY = spatialPosition.y
  }

  return animatedTransform
}

/**
 * Get keyframed adjustment values at a specific time.
 *
 * @param {Object} clip - Clip containing adjustments and keyframes
 * @param {number} clipTime - Time relative to clip start (seconds)
 * @returns {Object} - Adjustment values including tonal groups
 */
export function getAnimatedAdjustmentSettings(clip, clipTime) {
  if (!clip) return null

  const baseAdjustments = normalizeAdjustmentSettings(clip.adjustments || {})
  const keyframes = clip.keyframes || {}
  let animatedAdjustments = { ...baseAdjustments }

  for (const propertyId of ADJUSTMENT_KEYFRAME_PROPERTIES) {
    const propertyKeyframes = keyframes[propertyId]
    const baseValue = getAdjustmentValue(baseAdjustments, propertyId) ?? 0
    if (propertyKeyframes && propertyKeyframes.length > 0) {
      animatedAdjustments = setAdjustmentValue(
        animatedAdjustments,
        propertyId,
        getValueAtTime(propertyKeyframes, clipTime, baseValue)
      )
    } else if (getAdjustmentValue(animatedAdjustments, propertyId) == null) {
      animatedAdjustments = setAdjustmentValue(animatedAdjustments, propertyId, baseValue)
    }
  }

  return normalizeAdjustmentSettings(animatedAdjustments)
}

/**
 * Check if a property has a keyframe at a specific time
 * 
 * @param {Array} keyframes - Keyframes for the property
 * @param {number} time - Time to check
 * @param {number} tolerance - Time tolerance for matching; pass getKeyframeTimeTolerance(fps) for frame-accurate matching
 * @returns {Object|null} - The keyframe if found, null otherwise
 */
export function getKeyframeAtTime(keyframes, time, tolerance = DEFAULT_KEYFRAME_TIME_TOLERANCE) {
  if (!keyframes || keyframes.length === 0) return null
  
  return keyframes.find(kf => Math.abs(kf.time - time) <= tolerance) || null
}

/**
 * Check if a property has any keyframes
 * 
 * @param {Object} keyframes - All keyframes for a clip
 * @param {string} propertyId - Property to check
 * @returns {boolean}
 */
export function hasKeyframes(keyframes, propertyId) {
  return keyframes?.[propertyId]?.length > 0
}

/**
 * Add or update a keyframe
 * 
 * @param {Array} keyframes - Existing keyframes for the property
 * @param {number} time - Time for the keyframe
 * @param {number} value - Value at this keyframe
 * @param {string} easing - Easing function (default: 'easeInOut')
 * @param {number} tolerance - Match tolerance; pass getKeyframeTimeTolerance(fps) for frame-accurate placement
 * @returns {Array} - New keyframes array
 */
export function setKeyframe(keyframes, time, value, easing = 'easeInOut', tolerance = DEFAULT_KEYFRAME_TIME_TOLERANCE) {
  const newKeyframes = [...(keyframes || [])]

  // Find existing keyframe at this time
  const existingIndex = newKeyframes.findIndex(kf => Math.abs(kf.time - time) < tolerance)
  
  if (existingIndex >= 0) {
    // Update existing keyframe
    newKeyframes[existingIndex] = { ...newKeyframes[existingIndex], value, easing }
  } else {
    // Add new keyframe
    newKeyframes.push({ time, value, easing })
  }
  
  // Sort by time
  newKeyframes.sort((a, b) => a.time - b.time)
  
  return newKeyframes
}

/**
 * Remove a keyframe at a specific time
 * 
 * @param {Array} keyframes - Existing keyframes
 * @param {number} time - Time of keyframe to remove
 * @param {number} tolerance - Time tolerance for matching
 * @returns {Array} - New keyframes array without the removed keyframe
 */
export function removeKeyframe(keyframes, time, tolerance = DEFAULT_KEYFRAME_TIME_TOLERANCE) {
  if (!keyframes) return []
  return keyframes.filter(kf => Math.abs(kf.time - time) > tolerance)
}

/**
 * Get all keyframe times for a clip (across all properties)
 * Useful for displaying keyframes on the timeline
 * 
 * @param {Object} keyframes - All keyframes for a clip
 * @returns {Array} - Array of { time, properties } objects
 */
export function getAllKeyframeTimes(keyframes) {
  if (!keyframes) return []
  
  const timeMap = new Map()
  
  for (const [propId, propKeyframes] of Object.entries(keyframes)) {
    if (!propKeyframes) continue
    
    for (const kf of propKeyframes) {
      const roundedTime = Math.round(kf.time * 100) / 100 // Round to avoid floating point issues
      
      if (!timeMap.has(roundedTime)) {
        timeMap.set(roundedTime, { time: roundedTime, properties: [] })
      }
      timeMap.get(roundedTime).properties.push(propId)
    }
  }
  
  return Array.from(timeMap.values()).sort((a, b) => a.time - b.time)
}

/**
 * Copy keyframes from one property to another (useful for linked scale)
 * 
 * @param {Array} sourceKeyframes - Source keyframes
 * @returns {Array} - Copied keyframes array
 */
export function copyKeyframes(sourceKeyframes) {
  if (!sourceKeyframes) return []
  return sourceKeyframes.map(kf => ({ ...kf }))
}

/**
 * Quantize a time value to the nearest frame boundary.
 *
 * @param {number} time - Time value in seconds
 * @param {number} fps - Frames per second
 * @returns {number} - Quantized time
 */
export function quantizeTimeToFrame(time, fps) {
  const parsedTime = Number(time)
  if (!Number.isFinite(parsedTime)) return 0

  const parsedFps = Number(fps)
  if (!Number.isFinite(parsedFps) || parsedFps <= 0) return parsedTime

  const frameDuration = 1 / parsedFps
  return Math.round(parsedTime / frameDuration) * frameDuration
}

export default {
  easingFunctions,
  getEasingFunction,
  parseCubicBezierEasing,
  formatCubicBezierEasing,
  DEFAULT_KEYFRAME_TIME_TOLERANCE,
  getKeyframeTimeTolerance,
  EASING_OPTIONS,
  KEYFRAMEABLE_PROPERTIES,
  ADJUSTMENT_KEYFRAME_PROPERTIES,
  SHAPE_KEYFRAMEABLE_PROPERTIES,
  getValueAtTime,
  getColorAtTime,
  getPositionKeyframePoints,
  getMotionPathPositionAtTime,
  isMotionPathSmooth,
  getAnimatedShapeProperties,
  getAnimatedTransform,
  getAnimatedAdjustmentSettings,
  getAnimatedTextProperties,
  getKeyframeAtTime,
  hasKeyframes,
  setKeyframe,
  removeKeyframe,
  getAllKeyframeTimes,
  copyKeyframes,
  quantizeTimeToFrame,
}
