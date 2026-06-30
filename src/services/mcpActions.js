import useTimelineStore from '../stores/timelineStore'
import useProjectStore from '../stores/projectStore'
import useAssetsStore from '../stores/assetsStore'
import { useFrameForAIStore } from '../stores/frameForAIStore'
import { captureTimelineFrameAt, getTopmostVideoOrImageClipAtTime } from '../utils/captureTimelineFrame'
import { generateColorMatteBlob } from '../utils/overlayGenerators'
import { DEFAULT_SHAPE_PROPERTIES, getShapeDisplayName, normalizeShapeProperties } from '../utils/shapes'
import { saveLocalComfyConnectionPort } from './localComfyConnection'
import { writeGeneratedOverlayToProject } from './fileSystem'

export const MCP_ACTION_BRIDGE_VERSION = 2

function normalizeClipLabelColor(color) {
  const value = String(color || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : ''
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return normalizeStringArray(value)
  const raw = String(value || '').trim()
  if (!raw) return []
  return raw.split(',').map((item) => item.trim()).filter(Boolean)
}

function summarizeClip(clip) {
  return {
    id: clip.id,
    name: clip.name || clip.assetName || clip.id,
    type: clip.type || 'unknown',
    trackId: clip.trackId || null,
    startTime: Number(clip.startTime) || 0,
    duration: Number(clip.duration) || 0,
    labelColor: clip.labelColor || '',
  }
}

function safeClone(value) {
  if (value === null || typeof value === 'undefined') return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

function getNextMcpClipCounter(clips = [], currentCounter = 1) {
  const maxClipNumber = clips.reduce((max, clip) => {
    const match = /^clip-(\d+)$/.exec(String(clip?.id || ''))
    if (!match) return max
    return Math.max(max, Number(match[1]) || 0)
  }, 0)
  return Math.max(Number(currentCounter) || 1, maxClipNumber + 1, 1)
}

function normalizeMarkerColor(color) {
  const value = String(color || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : '#f5c451'
}

function normalizeOptionalMarkerColor(color) {
  const value = String(color || '').trim()
  if (!value) return ''
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase()
  throw new Error('Invalid marker color. Use a hex color like #f97316, or an empty string to clear marker color.')
}

function roundToTimelineFrame(time, fps = 24) {
  const safeFps = Math.max(1, Number(fps) || 24)
  return Math.max(0, Math.round((Number(time) || 0) * safeFps) / safeFps)
}

function makeEvenDimension(value) {
  return Math.max(2, Math.round((Number(value) || 2) / 2) * 2)
}

function normalizeMcpGenerationResolution(value) {
  if (!value || typeof value !== 'object') return null
  const width = Number(value.width)
  const height = Number(value.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return {
    width: Math.max(16, Math.round(width)),
    height: Math.max(16, Math.round(height)),
  }
}

function resolveMcpGenerationResolution(payload = {}) {
  return normalizeMcpGenerationResolution({
    width: payload.width ?? payload.outputWidth,
    height: payload.height ?? payload.outputHeight,
  }) || normalizeMcpGenerationResolution(payload.resolution || payload.outputResolution || payload.size)
}

function sanitizeExportBaseName(value) {
  return String(value || 'ComfyStudio_Timeline')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120)
    || 'ComfyStudio_Timeline'
}

function summarizeMarker(marker) {
  return {
    id: marker.id,
    time: Number(marker.time) || 0,
    label: marker.label || '',
    color: marker.color || '',
  }
}

function summarizeTrack(track) {
  return {
    id: track.id,
    name: track.name || track.id,
    type: track.type || 'unknown',
    muted: !!track.muted,
    locked: !!track.locked,
    visible: track.visible !== false,
    role: track.role || null,
    channels: track.channels || null,
  }
}

function normalizeTrackType(type) {
  const value = String(type || '').trim().toLowerCase()
  if (value === 'audio') return 'audio'
  return 'video'
}

function normalizeAudioChannels(channels) {
  return String(channels || '').trim().toLowerCase() === 'mono' ? 'mono' : 'stereo'
}

const MCP_ASSET_BATCH_MAX_ITEMS = 24

const TEXT_STYLE_KEYS = [
  'text',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'textColor',
  'backgroundColor',
  'backgroundOpacity',
  'backgroundPadding',
  'textAlign',
  'verticalAlign',
  'strokeColor',
  'strokeWidth',
  'letterSpacing',
  'lineHeight',
  'shadow',
  'shadowColor',
  'shadowBlur',
  'shadowOffsetX',
  'shadowOffsetY',
]

const TEXT_TRANSFORM_KEYS = [
  'positionX',
  'positionY',
  'positionZ',
  'scaleX',
  'scaleY',
  'scaleLinked',
  'rotation',
  'rotationX',
  'rotationY',
  'perspective',
  'anchorX',
  'anchorY',
  'opacity',
  'blur',
  'cropTop',
  'cropBottom',
  'cropLeft',
  'cropRight',
  'flipH',
  'flipV',
  'motionBlurEnabled',
  'motionBlurMode',
  'motionBlurSamples',
  'motionBlurShutter',
  'blendMode',
]

const TEXT_KEYFRAME_PROPERTIES = new Set([
  'opacity',
  'positionX',
  'positionY',
  'positionZ',
  'scaleX',
  'scaleY',
  'rotation',
  'rotationX',
  'rotationY',
  'perspective',
  'blur',
  'cropTop',
  'cropBottom',
  'cropLeft',
  'cropRight',
  'textColor',
])

const TEXT_TRANSFORM_NUMBER_FIELDS = {
  positionX: [0, -20000, 20000],
  positionY: [0, -20000, 20000],
  positionZ: [0, -20000, 20000],
  scaleX: [100, 1, 2000],
  scaleY: [100, 1, 2000],
  rotation: [0, -3600, 3600],
  rotationX: [0, -89, 89],
  rotationY: [0, -89, 89],
  perspective: [1200, 100, 10000],
  anchorX: [50, -1000, 1000],
  anchorY: [50, -1000, 1000],
  opacity: [100, 0, 100],
  blur: [0, 0, 50],
  cropTop: [0, 0, 100],
  cropBottom: [0, 0, 100],
  cropLeft: [0, 0, 100],
  cropRight: [0, 0, 100],
  motionBlurSamples: [8, 2, 48],
  motionBlurShutter: [180, 1, 360],
}

const TRANSFORM_BLEND_MODES = new Set([
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
])

const CLIP_VISUAL_KEYFRAME_TYPES = new Set(['video', 'image', 'text', 'shape', 'adjustment', 'caption', 'captions'])

const SHAPE_KEYFRAME_NUMBER_FIELDS = {
  width: [DEFAULT_SHAPE_PROPERTIES.width, 1, 20000],
  height: [DEFAULT_SHAPE_PROPERTIES.height, 1, 20000],
  fillOpacity: [DEFAULT_SHAPE_PROPERTIES.fillOpacity, 0, 100],
  gradientAngle: [DEFAULT_SHAPE_PROPERTIES.gradientAngle, -3600, 3600],
  gradientCenterX: [DEFAULT_SHAPE_PROPERTIES.gradientCenterX, -100, 200],
  gradientCenterY: [DEFAULT_SHAPE_PROPERTIES.gradientCenterY, -100, 200],
  gradientRadius: [DEFAULT_SHAPE_PROPERTIES.gradientRadius, 1, 400],
  strokeWidth: [DEFAULT_SHAPE_PROPERTIES.strokeWidth, 0, 2000],
  strokeOpacity: [DEFAULT_SHAPE_PROPERTIES.strokeOpacity, 0, 100],
  cornerRadius: [DEFAULT_SHAPE_PROPERTIES.cornerRadius, 0, 10000],
  sides: [DEFAULT_SHAPE_PROPERTIES.sides, 3, 64],
}
const SHAPE_KEYFRAME_PROPERTIES = new Set(Object.keys(SHAPE_KEYFRAME_NUMBER_FIELDS))

const CLIP_KEYFRAME_NUMBER_FIELDS = {
  ...TEXT_TRANSFORM_NUMBER_FIELDS,
  ...SHAPE_KEYFRAME_NUMBER_FIELDS,
  brightness: [0, -100, 100],
  contrast: [0, -100, 100],
  saturation: [0, -100, 100],
  gain: [0, -100, 100],
  gamma: [0, -100, 100],
  offset: [0, -100, 100],
  hue: [0, -180, 180],
}

for (const group of ['shadows', 'midtones', 'highlights']) {
  for (const property of ['brightness', 'contrast', 'saturation', 'gain', 'gamma', 'offset']) {
    CLIP_KEYFRAME_NUMBER_FIELDS[`${group}.${property}`] = [0, -100, 100]
  }
  CLIP_KEYFRAME_NUMBER_FIELDS[`${group}.hue`] = [0, -180, 180]
}

const CLIP_KEYFRAME_PROPERTIES = new Set(Object.keys(CLIP_KEYFRAME_NUMBER_FIELDS))

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key)
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function normalizeHexColor(value, { allowTransparent = false } = {}) {
  const raw = String(value || '').trim()
  if (allowTransparent && raw.toLowerCase() === 'transparent') return 'transparent'
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase()
  return ''
}

function normalizeTextStyleUpdates(payload = {}) {
  const source = {
    ...(payload.style && typeof payload.style === 'object' ? payload.style : {}),
    ...(payload.textProperties && typeof payload.textProperties === 'object' ? payload.textProperties : {}),
  }

  for (const key of TEXT_STYLE_KEYS) {
    if (hasOwn(payload, key)) source[key] = payload[key]
  }
  if (hasOwn(payload, 'color')) source.textColor = payload.color
  if (hasOwn(payload, 'fill')) source.textColor = payload.fill
  if (hasOwn(payload, 'background')) source.backgroundColor = payload.background

  const updates = {}
  if (hasOwn(source, 'text')) updates.text = String(source.text || '').slice(0, 2000)
  if (hasOwn(source, 'fontFamily')) updates.fontFamily = String(source.fontFamily || 'Inter').slice(0, 120)
  if (hasOwn(source, 'fontWeight')) updates.fontWeight = String(source.fontWeight || 'bold').slice(0, 40)
  if (hasOwn(source, 'fontStyle')) updates.fontStyle = String(source.fontStyle || 'normal').slice(0, 40)
  if (hasOwn(source, 'textAlign')) {
    const value = String(source.textAlign || '').toLowerCase()
    if (['left', 'center', 'right'].includes(value)) updates.textAlign = value
  }
  if (hasOwn(source, 'verticalAlign')) {
    const value = String(source.verticalAlign || '').toLowerCase()
    if (['top', 'center', 'bottom'].includes(value)) updates.verticalAlign = value
  }

  const numberFields = {
    fontSize: [64, 8, 300],
    backgroundOpacity: [0, 0, 100],
    backgroundPadding: [20, 0, 300],
    strokeWidth: [0, 0, 50],
    letterSpacing: [0, -50, 200],
    lineHeight: [1.2, 0.5, 4],
    shadowBlur: [4, 0, 200],
    shadowOffsetX: [2, -500, 500],
    shadowOffsetY: [2, -500, 500],
  }
  for (const [key, [fallback, min, max]] of Object.entries(numberFields)) {
    if (hasOwn(source, key)) updates[key] = clampNumber(source[key], fallback, min, max)
  }

  if (hasOwn(source, 'shadow')) updates.shadow = source.shadow === true
  if (hasOwn(source, 'textColor')) {
    const color = normalizeHexColor(source.textColor)
    if (!color) throw new Error('Invalid text color. Use a hex color like #ffffff.')
    updates.textColor = color
  }
  if (hasOwn(source, 'strokeColor')) {
    const color = normalizeHexColor(source.strokeColor)
    if (!color) throw new Error('Invalid stroke color. Use a hex color like #000000.')
    updates.strokeColor = color
  }
  if (hasOwn(source, 'shadowColor')) {
    updates.shadowColor = String(source.shadowColor || 'rgba(0,0,0,0.5)').slice(0, 120)
  }
  if (hasOwn(source, 'backgroundColor')) {
    const color = normalizeHexColor(source.backgroundColor, { allowTransparent: true })
    if (!color) throw new Error('Invalid background color. Use #000000 or transparent.')
    updates.backgroundColor = color
  }

  return updates
}

function normalizeShapeStyleUpdates(payload = {}) {
  const source = {
    ...(payload.style && typeof payload.style === 'object' ? payload.style : {}),
    ...(payload.shapeProperties && typeof payload.shapeProperties === 'object' ? payload.shapeProperties : {}),
  }

  for (const key of ['shapeType', 'width', 'height', 'sizeLinked', 'fillType', 'gradientType', 'fillColor', 'fillColorB', 'fillB', 'gradientColor', 'gradientColorB', 'colorB', 'gradientFill', 'fillOpacity', 'gradientAngle', 'gradientCenterX', 'gradientCenterY', 'gradientRadius', 'strokeColor', 'strokeOpacity', 'strokeWidth', 'cornerRadius', 'sides', 'polygonSides']) {
    if (hasOwn(payload, key)) source[key] = payload[key]
  }
  if (hasOwn(payload, 'linkSize')) source.sizeLinked = payload.linkSize
  if (hasOwn(payload, 'linkedSize')) source.sizeLinked = payload.linkedSize
  if (hasOwn(payload, 'lockAspectRatio')) source.sizeLinked = payload.lockAspectRatio
  if (hasOwn(payload, 'type')) source.shapeType = payload.type
  if (hasOwn(payload, 'color')) source.fillColor = payload.color
  if (hasOwn(payload, 'fill')) source.fillColor = payload.fill
  if (hasOwn(payload, 'fillB')) source.fillColorB = payload.fillB
  if (hasOwn(payload, 'gradientFill')) source.fillColorB = payload.gradientFill
  if (hasOwn(payload, 'stroke')) source.strokeColor = payload.stroke
  if (hasOwn(payload, 'opacity')) source.fillOpacity = payload.opacity
  if (hasOwn(source, 'polygonSides') && !hasOwn(source, 'sides')) source.sides = source.polygonSides
  if (hasOwn(source, 'gradientType') && !hasOwn(source, 'fillType')) source.fillType = source.gradientType
  if (hasOwn(source, 'gradientColor') && !hasOwn(source, 'fillColorB')) source.fillColorB = source.gradientColor
  if (hasOwn(source, 'gradientColorB') && !hasOwn(source, 'fillColorB')) source.fillColorB = source.gradientColorB
  if (hasOwn(source, 'colorB') && !hasOwn(source, 'fillColorB')) source.fillColorB = source.colorB
  if (hasOwn(source, 'fillB') && !hasOwn(source, 'fillColorB')) source.fillColorB = source.fillB
  if (hasOwn(source, 'gradientFill') && !hasOwn(source, 'fillColorB')) source.fillColorB = source.gradientFill

  const updates = {}
  if (hasOwn(source, 'shapeType')) {
    const normalizedTypeOnly = normalizeShapeProperties({ shapeType: source.shapeType })
    updates.shapeType = normalizedTypeOnly.shapeType
    if (normalizedTypeOnly.shapeType === 'polygon' && !hasOwn(source, 'sides') && !hasOwn(source, 'polygonSides')) {
      updates.sides = normalizedTypeOnly.sides
    }
  }
  if (hasOwn(source, 'sizeLinked')) updates.sizeLinked = source.sizeLinked !== false
  if (hasOwn(source, 'fillType')) {
    updates.fillType = normalizeShapeProperties({ fillType: source.fillType }).fillType
  }

  const numberFields = {
    width: [DEFAULT_SHAPE_PROPERTIES.width, 1, 20000],
    height: [DEFAULT_SHAPE_PROPERTIES.height, 1, 20000],
    fillOpacity: [100, 0, 100],
    gradientAngle: [DEFAULT_SHAPE_PROPERTIES.gradientAngle, -3600, 3600],
    gradientCenterX: [DEFAULT_SHAPE_PROPERTIES.gradientCenterX, -100, 200],
    gradientCenterY: [DEFAULT_SHAPE_PROPERTIES.gradientCenterY, -100, 200],
    gradientRadius: [DEFAULT_SHAPE_PROPERTIES.gradientRadius, 1, 400],
    strokeOpacity: [100, 0, 100],
    strokeWidth: [0, 0, 2000],
    cornerRadius: [24, 0, 10000],
    sides: [DEFAULT_SHAPE_PROPERTIES.sides, 3, 64],
  }
  for (const [key, [fallback, min, max]] of Object.entries(numberFields)) {
    if (hasOwn(source, key)) {
      const nextValue = clampNumber(source[key], fallback, min, max)
      updates[key] = key === 'sides' ? Math.round(nextValue) : nextValue
    }
  }

  if (hasOwn(source, 'fillColor')) {
    const color = normalizeHexColor(source.fillColor)
    if (!color) throw new Error('Invalid fill color. Use a hex color like #38bdf8.')
    updates.fillColor = color
  }
  if (hasOwn(source, 'fillColorB')) {
    const color = normalizeHexColor(source.fillColorB)
    if (!color) throw new Error('Invalid second fill color. Use a hex color like #a855f7.')
    updates.fillColorB = color
  }
  if (hasOwn(source, 'strokeColor')) {
    const color = normalizeHexColor(source.strokeColor)
    if (!color) throw new Error('Invalid stroke color. Use a hex color like #ffffff.')
    updates.strokeColor = color
  }

  return updates
}

function normalizeTransformUpdates(payload = {}) {
  const source = {
    ...(payload.transform && typeof payload.transform === 'object' ? payload.transform : {}),
    ...(payload.crop && typeof payload.crop === 'object' ? payload.crop : {}),
  }
  const deltaSource = {
    ...(payload.transformDelta && typeof payload.transformDelta === 'object' ? payload.transformDelta : {}),
    ...(payload.deltaTransform && typeof payload.deltaTransform === 'object' ? payload.deltaTransform : {}),
  }

  for (const key of TEXT_TRANSFORM_KEYS) {
    if (hasOwn(payload, key)) source[key] = payload[key]
  }
  if (hasOwn(payload, 'x')) source.positionX = payload.x
  if (hasOwn(payload, 'y')) source.positionY = payload.y
  if (hasOwn(payload, 'moveX')) deltaSource.positionX = payload.moveX
  if (hasOwn(payload, 'moveY')) deltaSource.positionY = payload.moveY
  if (hasOwn(payload, 'rotateBy')) deltaSource.rotation = payload.rotateBy

  const updates = {}
  const deltas = {}
  for (const [key, [fallback, min, max]] of Object.entries(TEXT_TRANSFORM_NUMBER_FIELDS)) {
    if (hasOwn(source, key)) updates[key] = clampNumber(source[key], fallback, min, max)
    if (hasOwn(deltaSource, key)) deltas[key] = clampNumber(deltaSource[key], 0, -20000, 20000)
  }
  for (const key of ['scaleLinked', 'flipH', 'flipV', 'motionBlurEnabled']) {
    if (hasOwn(source, key)) updates[key] = source[key] === true
  }
  if (hasOwn(source, 'motionBlurMode')) {
    const mode = String(source.motionBlurMode || '').trim().toLowerCase()
    updates.motionBlurMode = ['auto', 'velocity', 'sampled'].includes(mode) ? mode : 'auto'
  }
  if (hasOwn(source, 'blendMode')) {
    const mode = String(source.blendMode || '').trim().toLowerCase()
    updates.blendMode = TRANSFORM_BLEND_MODES.has(mode) ? mode : 'normal'
  }

  return { updates, deltas }
}

function buildTextClipSummary(clip) {
  if (!clip) return null
  return {
    ...summarizeClip(clip),
    enabled: clip.enabled !== false,
    textProperties: clip.textProperties || {},
    transform: clip.transform || {},
    titleAnimation: clip.titleAnimation || null,
    keyframes: clip.keyframes || {},
  }
}

function getTextClipById(state, clipId) {
  const id = String(clipId || '').trim()
  if (!id) throw new Error('No text clip ID provided.')
  const clip = (state.clips || []).find((candidate) => candidate.id === id)
  if (!clip) throw new Error(`Text clip ${id} was not found.`)
  if (clip.type !== 'text') throw new Error(`Clip ${id} is a ${clip.type || 'unknown'} clip, not a text clip.`)
  return clip
}

function buildShapeClipSummary(clip) {
  if (!clip) return null
  return {
    ...summarizeClip(clip),
    enabled: clip.enabled !== false,
    shapeProperties: clip.shapeProperties || {},
    transform: clip.transform || {},
    keyframes: clip.keyframes || {},
  }
}

function getShapeClipById(state, clipId) {
  const id = String(clipId || '').trim()
  if (!id) throw new Error('No shape clip ID provided.')
  const clip = (state.clips || []).find((candidate) => candidate.id === id)
  if (!clip) throw new Error(`Shape clip ${id} was not found.`)
  if (clip.type !== 'shape') throw new Error(`Clip ${id} is a ${clip.type || 'unknown'} clip, not a shape clip.`)
  return clip
}

function findDefaultTextTrack(state, requestedTrackId = '') {
  const trackId = String(requestedTrackId || '').trim()
  const tracks = Array.isArray(state.tracks) ? state.tracks : []
  if (trackId) {
    const track = tracks.find((candidate) => candidate.id === trackId)
    if (!track || track.type !== 'video') throw new Error(`Track ${trackId} is not a video track.`)
    if (track.locked) throw new Error(`Track ${trackId} is locked.`)
    return track
  }
  const track = tracks.find((candidate) => candidate.type === 'video' && candidate.locked !== true)
  if (!track) throw new Error('No unlocked video track is available for a text clip.')
  return track
}

function normalizeTextKeyframes(payload = {}) {
  const rawKeyframes = Array.isArray(payload.keyframes) ? payload.keyframes : []
  return rawKeyframes.map((entry) => {
    const property = String(entry?.property || '').trim()
    if (!TEXT_KEYFRAME_PROPERTIES.has(property)) {
      throw new Error(`Unsupported text keyframe property "${property}".`)
    }
    const timeSeconds = Number(entry?.timeSeconds ?? entry?.time)
    let value = entry?.value
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0) {
      throw new Error(`Invalid keyframe time for ${property}.`)
    }
    if (property === 'textColor') {
      value = normalizeHexColor(value)
      if (!value) {
        throw new Error('Invalid textColor keyframe value. Use a hex color like #ffffff.')
      }
    } else {
      value = Number(value)
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid keyframe value for ${property}.`)
      }
    }
    return {
      property,
      timeSeconds,
      value,
      easing: String(entry?.easing || 'easeInOut').slice(0, 120),
    }
  })
}

function resolveNextTransform(currentTransform = {}, transformUpdates = {}, transformDeltas = {}) {
  const next = { ...(currentTransform || {}) }
  for (const [key, value] of Object.entries(transformUpdates || {})) {
    next[key] = value
  }
  for (const [key, value] of Object.entries(transformDeltas || {})) {
    const [, min = -20000, max = 20000] = TEXT_TRANSFORM_NUMBER_FIELDS[key] || []
    next[key] = clampNumber((Number(next[key]) || 0) + value, Number(next[key]) || 0, min, max)
  }
  return next
}

function clearTextKeyframes(clipId, clearKeyframes) {
  if (!clearKeyframes) return []
  const requested = clearKeyframes === true || clearKeyframes === 'all'
    ? [...TEXT_KEYFRAME_PROPERTIES]
    : Array.isArray(clearKeyframes)
      ? clearKeyframes.map((item) => String(item || '').trim()).filter(Boolean)
      : []
  const properties = requested.filter((property) => TEXT_KEYFRAME_PROPERTIES.has(property))
  if (properties.length === 0) return []

  useTimelineStore.setState((currentState) => ({
    clips: (currentState.clips || []).map((clip) => {
      if (clip.id !== clipId || clip.type !== 'text') return clip
      const nextKeyframes = { ...(clip.keyframes || {}) }
      for (const property of properties) {
        delete nextKeyframes[property]
      }
      return { ...clip, keyframes: nextKeyframes }
    }),
  }))
  return properties
}

function applyTextKeyframes(state, clipId, keyframes = [], replaceKeyframes = false) {
  if (keyframes.length === 0) return []
  const replaceProperties = replaceKeyframes
    ? [...new Set(keyframes.map((keyframe) => keyframe.property))]
    : []
  if (replaceProperties.length > 0) {
    clearTextKeyframes(clipId, replaceProperties)
  }
  for (const keyframe of keyframes) {
    state.setKeyframe?.(clipId, keyframe.property, keyframe.timeSeconds, keyframe.value, keyframe.easing, { saveHistory: false })
  }
  return keyframes
}

function normalizeClipKeyframes(payload = {}, clip = null) {
  const rawKeyframes = Array.isArray(payload.keyframes) ? payload.keyframes : []
  return rawKeyframes.map((entry) => {
    const property = String(entry?.property || '').trim()
    const [fallback, min, max] = CLIP_KEYFRAME_NUMBER_FIELDS[property] || []
    if (!CLIP_KEYFRAME_PROPERTIES.has(property)) {
      throw new Error(`Unsupported clip keyframe property "${property}".`)
    }
    if (SHAPE_KEYFRAME_PROPERTIES.has(property) && clip?.type !== 'shape') {
      throw new Error(`Shape keyframe property "${property}" can only be used on shape clips.`)
    }
    const timeSeconds = Number(entry?.timeSeconds ?? entry?.time)
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0) {
      throw new Error(`Invalid keyframe time for ${property}.`)
    }
    const rawValue = Number(entry?.value)
    if (!Number.isFinite(rawValue)) {
      throw new Error(`Invalid keyframe value for ${property}.`)
    }
    const clampedValue = clampNumber(rawValue, fallback, min, max)
    const value = property === 'sides' ? Math.round(clampedValue) : clampedValue
    return {
      property,
      timeSeconds,
      value,
      easing: String(entry?.easing || 'easeInOut').slice(0, 120),
    }
  })
}

function getClipByIdForKeyframes(state, clipId) {
  const id = String(clipId || '').trim()
  if (!id) throw new Error('No clip ID provided.')
  const clip = (state.clips || []).find((candidate) => candidate.id === id)
  if (!clip) throw new Error(`Clip ${id} was not found.`)
  const clipType = String(clip.type || '').toLowerCase()
  if (!CLIP_VISUAL_KEYFRAME_TYPES.has(clipType)) {
    throw new Error(`Clip ${id} is a ${clip.type || 'unknown'} clip. set_clip_keyframes currently supports visual clips, not audio clips.`)
  }
  return clip
}

function buildClipKeyframeSummary(clip) {
  if (!clip) return null
  return {
    ...summarizeClip(clip),
    enabled: clip.enabled !== false,
    transform: clip.transform || {},
    textProperties: clip.type === 'text' ? (clip.textProperties || {}) : undefined,
    shapeProperties: clip.type === 'shape' ? (clip.shapeProperties || {}) : undefined,
    keyframes: clip.keyframes || {},
  }
}

function validateClipKeyframePropertyForClip(property, clip = null) {
  if (clip && SHAPE_KEYFRAME_PROPERTIES.has(property) && clip.type !== 'shape') {
    throw new Error(`Shape keyframe property "${property}" can only be used on shape clips.`)
  }
}

function resolveClipKeyframeClearProperties(clearKeyframes, clip = null) {
  if (!clearKeyframes) return []
  const allPropertiesForClip = clip?.type === 'shape'
    ? [...CLIP_KEYFRAME_PROPERTIES]
    : CLIP_KEYFRAME_PROPERTIES.filter((property) => !SHAPE_KEYFRAME_PROPERTIES.has(property))
  const requested = clearKeyframes === true || clearKeyframes === 'all'
    ? allPropertiesForClip
    : Array.isArray(clearKeyframes)
      ? clearKeyframes.map((item) => String(item || '').trim()).filter(Boolean)
      : []
  for (const property of requested) {
    if (!CLIP_KEYFRAME_PROPERTIES.has(property)) {
      throw new Error(`Unsupported clip keyframe property "${property}".`)
    }
    validateClipKeyframePropertyForClip(property, clip)
  }
  return [...new Set(requested)]
}

function clearClipKeyframes(clipId, clearKeyframes, clip = null) {
  const targetClip = clip || (useTimelineStore.getState().clips || []).find((candidate) => candidate.id === clipId) || null
  const properties = resolveClipKeyframeClearProperties(clearKeyframes, targetClip)
  if (properties.length === 0) return []

  useTimelineStore.setState((currentState) => ({
    clips: (currentState.clips || []).map((clip) => {
      if (clip.id !== clipId) return clip
      const nextKeyframes = { ...(clip.keyframes || {}) }
      for (const property of properties) {
        delete nextKeyframes[property]
      }
      return { ...clip, keyframes: nextKeyframes }
    }),
  }))
  return properties
}

function applyClipKeyframes(state, clipId, keyframes = [], replaceKeyframes = false) {
  if (keyframes.length === 0) return []
  const replaceProperties = replaceKeyframes
    ? [...new Set(keyframes.map((keyframe) => keyframe.property))]
    : []
  if (replaceProperties.length > 0) {
    clearClipKeyframes(clipId, replaceProperties)
  }
  for (const keyframe of keyframes) {
    state.setKeyframe?.(clipId, keyframe.property, keyframe.timeSeconds, keyframe.value, keyframe.easing, { saveHistory: false })
  }
  return keyframes
}

function handleSetClipKeyframes(payload = {}) {
  const state = useTimelineStore.getState()
  const currentClip = getClipByIdForKeyframes(state, payload.clipId)
  const keyframes = normalizeClipKeyframes(payload, currentClip)
  const clearKeyframes = payload.clearKeyframes || payload.clearKeyframesForProperties
  const clearProperties = resolveClipKeyframeClearProperties(clearKeyframes, currentClip)

  if (keyframes.length === 0 && clearProperties.length === 0) {
    throw new Error('Provide at least one keyframe or clearKeyframes property.')
  }

  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      action: 'set_clip_keyframes',
      message: 'Clip keyframe plan only. No timeline change was made.',
      clip: buildClipKeyframeSummary(currentClip),
      requested: {
        keyframes,
        clearKeyframes: clearProperties,
        replaceKeyframes: payload.replaceKeyframes === true,
      },
    }
  }

  state.saveToHistory?.()
  const clearedKeyframes = clearClipKeyframes(currentClip.id, clearProperties, currentClip)
  const appliedKeyframes = applyClipKeyframes(useTimelineStore.getState(), currentClip.id, keyframes, payload.replaceKeyframes === true)
  const updatedClip = (useTimelineStore.getState().clips || []).find((clip) => clip.id === currentClip.id)

  return {
    updated: true,
    action: 'set_clip_keyframes',
    clip: buildClipKeyframeSummary(updatedClip),
    requested: {
      clearedKeyframes,
      appliedKeyframes,
      replaceKeyframes: payload.replaceKeyframes === true,
    },
  }
}

function getUpdatedTextClip(clipId) {
  return (useTimelineStore.getState().clips || []).find((clip) => clip.id === clipId) || null
}

function handleSetClipLabelColor(payload = {}) {
  const rawColor = String(payload.color || '').trim()
  const color = normalizeClipLabelColor(rawColor)
  if (rawColor && !color) {
    throw new Error('Invalid label color. Use a hex color like #f97316, or an empty string to clear labels.')
  }

  const clipIds = Array.isArray(payload.clipIds)
    ? [...new Set(payload.clipIds.map((clipId) => String(clipId || '').trim()).filter(Boolean))]
    : []
  if (clipIds.length === 0) {
    throw new Error('No clip IDs provided.')
  }

  const state = useTimelineStore.getState()
  const clipsById = new Map((state.clips || []).map((clip) => [clip.id, clip]))
  const targetClips = clipIds.map((clipId) => clipsById.get(clipId)).filter(Boolean)
  const foundIds = new Set(targetClips.map((clip) => clip.id))
  const missingClipIds = clipIds.filter((clipId) => !foundIds.has(clipId))

  if (targetClips.length === 0) {
    throw new Error('No matching clips found.')
  }

  state.setClipLabelColor(targetClips.map((clip) => clip.id), color)

  return {
    color,
    cleared: !color,
    clipCount: targetClips.length,
    missingClipIds,
    clips: targetClips.map(summarizeClip),
  }
}

function handleSetClipsEnabled(payload = {}) {
  if (typeof payload.enabled !== 'boolean') {
    throw new Error('Provide enabled=true or enabled=false.')
  }

  const clipIds = Array.isArray(payload.clipIds)
    ? [...new Set(payload.clipIds.map((clipId) => String(clipId || '').trim()).filter(Boolean))]
    : []
  if (clipIds.length === 0) {
    throw new Error('No clip IDs provided.')
  }

  const state = useTimelineStore.getState()
  const clipsById = new Map((state.clips || []).map((clip) => [clip.id, clip]))
  const targetClips = clipIds.map((clipId) => clipsById.get(clipId)).filter(Boolean)
  const foundIds = new Set(targetClips.map((clip) => clip.id))
  const missingClipIds = clipIds.filter((clipId) => !foundIds.has(clipId))

  if (targetClips.length === 0) {
    throw new Error('No matching clips found.')
  }

  state.setClipsEnabled(targetClips.map((clip) => clip.id), payload.enabled)

  return {
    enabled: payload.enabled,
    clipCount: targetClips.length,
    missingClipIds,
    clips: targetClips.map((clip) => ({
      ...summarizeClip(clip),
      wasEnabled: clip.enabled !== false,
      nextEnabled: payload.enabled,
    })),
  }
}

async function handlePrepareGenerationFromTimelineContext(payload = {}) {
  const state = useTimelineStore.getState()
  const mode = String(payload.mode || 'extend').trim().toLowerCase() === 'keyframe' ? 'keyframe' : 'extend'
  const workflowId = String(payload.workflowId || 'ltx23-i2v').trim() || 'ltx23-i2v'
  const category = String(payload.category || 'video').trim().toLowerCase() || 'video'
  const prompt = String(payload.prompt || '').trim().slice(0, 5000)
  const negativePrompt = String(payload.negativePrompt || '').trim().slice(0, 2000)
  const requestedResolution = resolveMcpGenerationResolution(payload)
  const timeSeconds = Number(payload.timeSeconds ?? payload.time)
  const frame = Number(payload.frame)
  const fps = Number(state.timelineFps) || 24
  const captureTime = roundToTimelineFrame(
    Number.isFinite(timeSeconds)
      ? timeSeconds
      : Number.isFinite(frame)
        ? frame / fps
        : Number(state.playheadPosition) || 0,
    fps
  )

  const top = getTopmostVideoOrImageClipAtTime(captureTime)
  if (!top?.clip) {
    throw new Error('No visible image or video clip is available at that timeline time.')
  }

  const captured = await captureTimelineFrameAt(captureTime, {
    mimeType: payload.mimeType || 'image/png',
    createBlobUrl: true,
  })
  if (!captured?.file) {
    throw new Error('Could not capture the timeline frame for Generate.')
  }

  const framePayload = {
    ...captured,
    mode,
    workflowId,
    prompt,
    negativePrompt,
    source: 'mcp',
    sourceClipId: top.clip.id,
    sourceTrackId: top.track?.id || null,
    capturedAt: captureTime,
    preparedAt: new Date().toISOString(),
  }
  useFrameForAIStore.getState().setFrame(framePayload)

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('comfystudio-mcp-prepare-generation', {
      detail: {
        mode,
        workflowId,
        category,
        prompt,
        negativePrompt,
        duration: Number.isFinite(Number(payload.durationSeconds ?? payload.duration))
          ? Number(payload.durationSeconds ?? payload.duration)
          : null,
        fps: Number.isFinite(Number(payload.fps)) ? Number(payload.fps) : null,
        resolution: requestedResolution,
        sourceClipId: top.clip.id,
        sourceTrackId: top.track?.id || null,
        capturedAt: captureTime,
      },
    }))
    if (payload.openGenerateTab !== false) {
      window.dispatchEvent(new CustomEvent('comfystudio-open-generate-with-frame'))
    }
  }

  return {
    success: true,
    action: 'prepare_generation_from_timeline_context',
    message: 'Timeline frame captured and sent to the Generate tab. No generation was queued.',
    mode,
    workflowId,
    category,
    promptApplied: Boolean(prompt),
    negativePromptApplied: Boolean(negativePrompt),
    openedGenerateTab: payload.openGenerateTab !== false,
    capturedFrame: {
      timeSeconds: captureTime,
      width: captured.width,
      height: captured.height,
      mimeType: captured.mimeType,
      size: captured.file?.size || 0,
    },
    sourceClip: summarizeClip(top.clip),
    sourceTrack: top.track ? summarizeTrack(top.track) : null,
  }
}

async function handleQueuePreparedGeneration(payload = {}) {
  if (typeof window === 'undefined') {
    throw new Error('Generate queue bridge is only available in the renderer.')
  }

  const timeoutMs = Math.min(30000, Math.max(1000, Number(payload.timeoutMs) || 10000))
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback(value)
    }

    const timeout = setTimeout(() => {
      finish(reject, new Error('Generate workspace did not respond to the MCP queue request. Open the Generate tab and try again.'))
    }, timeoutMs)

    window.dispatchEvent(new CustomEvent('comfystudio-mcp-queue-prepared-generation', {
      detail: {
        ...payload,
        respond: (result = {}) => {
          if (result?.success === false) {
            finish(reject, new Error(result.error || result.message || 'Could not queue the prepared generation.'))
            return
          }
          finish(resolve, result)
        },
      },
    }))
  })
}

async function handleQueueTimelineGenerationBatch(payload = {}) {
  if (typeof window === 'undefined') {
    throw new Error('Generate batch queue bridge is only available in the renderer.')
  }

  const jobs = Array.isArray(payload.jobs) ? payload.jobs : []
  if (jobs.length === 0) {
    throw new Error('No generation jobs were provided for the timeline batch.')
  }

  const firstJob = jobs[0] || {}
  const generationSettings = payload.generationSettings || {}
  const requestedResolution = resolveMcpGenerationResolution(generationSettings) || resolveMcpGenerationResolution(payload)
  const prepared = await handlePrepareGenerationFromTimelineContext({
    ...payload,
    workflowId: firstJob.workflowId || payload.workflowId || 'ltx23-i2v',
    category: 'video',
    mode: payload.mode || 'extend',
    timeSeconds: payload.frame?.timeSeconds ?? payload.timeSeconds ?? payload.time,
    frame: payload.frame?.frame ?? payload.frameNumber,
    prompt: firstJob.prompt ?? payload.prompt,
    negativePrompt: firstJob.negativePrompt ?? payload.negativePrompt,
    durationSeconds: generationSettings.durationSeconds ?? payload.durationSeconds ?? payload.duration,
    fps: generationSettings.fps ?? payload.fps,
    resolution: requestedResolution,
    openGenerateTab: payload.openGenerateTab === true,
    previewOnly: false,
  })

  const timeoutMs = Math.min(120000, Math.max(1000, Number(payload.timeoutMs) || 30000))
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback(value)
    }

    const timeout = setTimeout(() => {
      finish(reject, new Error('Generate workspace did not respond to the MCP batch queue request. Open the Generate tab and try again.'))
    }, timeoutMs)

    window.dispatchEvent(new CustomEvent('comfystudio-mcp-queue-timeline-generation-batch', {
      detail: {
        ...payload,
        capturedFrame: prepared?.capturedFrame || null,
        respond: (result = {}) => {
          if (result?.success === false) {
            finish(reject, new Error(result.error || result.message || 'Could not queue the timeline generation batch.'))
            return
          }
          finish(resolve, result)
        },
      },
    }))
  })
}

async function handleQueuePromptGenerationBatch(payload = {}) {
  if (typeof window === 'undefined') {
    throw new Error('Prompt generation batch queue bridge is only available in the renderer.')
  }

  const jobs = Array.isArray(payload.jobs) ? payload.jobs : []
  if (jobs.length === 0) {
    throw new Error('No generation jobs were provided for the prompt batch.')
  }

  const timeoutMs = Math.min(120000, Math.max(1000, Number(payload.timeoutMs) || 30000))
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback(value)
    }

    const timeout = setTimeout(() => {
      finish(reject, new Error('Generate workspace did not respond to the MCP prompt batch queue request. Open the Generate tab and try again.'))
    }, timeoutMs)

    window.dispatchEvent(new CustomEvent('comfystudio-mcp-queue-prompt-generation-batch', {
      detail: {
        ...payload,
        respond: (result = {}) => {
          if (result?.success === false) {
            finish(reject, new Error(result.error || result.message || 'Could not queue the prompt generation batch.'))
            return
          }
          finish(resolve, result)
        },
      },
    }))
  })
}

function handleAddTimelineMarkers(payload = {}) {
  const rawMarkers = Array.isArray(payload.markers) ? payload.markers : []
  if (rawMarkers.length === 0) {
    throw new Error('No markers provided.')
  }

  const state = useTimelineStore.getState()
  const fps = Number(state.timelineFps) || 24
  const duration = Math.max(0, Number(state.duration) || 0)
  const markerCounter = Math.max(1, Number(state.markerCounter) || 1)
  const markers = rawMarkers.map((entry, index) => {
    const timeSeconds = Number(entry?.timeSeconds ?? entry?.time)
    const frame = Number(entry?.frame)
    const rawTime = Number.isFinite(timeSeconds)
      ? timeSeconds
      : Number.isFinite(frame)
        ? frame / fps
        : Number(state.playheadPosition) || 0
    const markerTime = roundToTimelineFrame(Math.max(0, Math.min(duration, rawTime)), fps)
    return {
      id: `marker-${markerCounter + index}`,
      time: markerTime,
      label: String(entry?.label || entry?.name || '').trim().slice(0, 160),
      color: normalizeMarkerColor(entry?.color),
    }
  })

  if (markers.length === 0) {
    throw new Error('No valid markers provided.')
  }

  state.saveToHistory?.()
  useTimelineStore.setState((currentState) => ({
    markers: [...(currentState.markers || []), ...markers].sort((a, b) => a.time - b.time),
    markerCounter: markerCounter + markers.length,
    selectedMarkerId: markers[markers.length - 1]?.id || currentState.selectedMarkerId,
    selectedClipIds: [],
    selectedTransitionId: null,
    selectedGap: null,
  }))

  return {
    markerCount: markers.length,
    markers: markers.map(summarizeMarker),
  }
}

function handleRemoveTimelineMarkers(payload = {}) {
  const markerIds = Array.isArray(payload.markerIds)
    ? [...new Set(payload.markerIds.map((markerId) => String(markerId || '').trim()).filter(Boolean))]
    : []

  const state = useTimelineStore.getState()
  const markers = state.markers || []
  let targetMarkers = []

  if (payload.all === true) {
    targetMarkers = markers
  } else if (markerIds.length > 0) {
    const markerIdsSet = new Set(markerIds)
    targetMarkers = markers.filter((marker) => markerIdsSet.has(marker.id))
  }

  if (targetMarkers.length === 0) {
    return {
      markerCount: 0,
      removedMarkerIds: [],
      missingMarkerIds: markerIds.filter((markerId) => !markers.some((marker) => marker.id === markerId)),
      markers: [],
    }
  }

  const targetIds = new Set(targetMarkers.map((marker) => marker.id))
  state.saveToHistory?.()
  useTimelineStore.setState((currentState) => ({
    markers: (currentState.markers || []).filter((marker) => !targetIds.has(marker.id)),
    selectedMarkerId: targetIds.has(currentState.selectedMarkerId) ? null : currentState.selectedMarkerId,
  }))

  return {
    markerCount: targetMarkers.length,
    removedMarkerIds: [...targetIds],
    missingMarkerIds: markerIds.filter((markerId) => !markers.some((marker) => marker.id === markerId)),
    markers: targetMarkers.map(summarizeMarker),
  }
}

function handleSetTimelineMarkerProperties(payload = {}) {
  const updates = Array.isArray(payload.updates) ? payload.updates : []
  if (updates.length === 0) {
    throw new Error('No marker updates provided.')
  }

  const state = useTimelineStore.getState()
  const markers = state.markers || []
  const markersById = new Map(markers.map((marker) => [marker.id, marker]))
  const fps = Number(state.timelineFps) || 24
  const duration = Math.max(0, Number(state.duration) || 0)
  const normalizedUpdates = []
  const missingMarkerIds = []

  for (const entry of updates) {
    const id = String(entry?.id || '').trim()
    if (!id) continue
    const current = markersById.get(id)
    if (!current) {
      missingMarkerIds.push(id)
      continue
    }

    const rawTime = Number(entry?.timeSeconds ?? entry?.time)
    const frame = Number(entry?.frame)
    const nextTime = Number.isFinite(rawTime)
      ? rawTime
      : Number.isFinite(frame)
        ? frame / fps
        : Number(current.time) || 0
    normalizedUpdates.push({
      id,
      time: roundToTimelineFrame(Math.max(0, Math.min(duration, nextTime)), fps),
      label: Object.prototype.hasOwnProperty.call(entry, 'label')
        ? String(entry.label || '').trim().slice(0, 160)
        : (current.label || ''),
      color: Object.prototype.hasOwnProperty.call(entry, 'color')
        ? normalizeOptionalMarkerColor(entry.color)
        : (current.color || ''),
    })
  }

  if (normalizedUpdates.length === 0) {
    return {
      markerCount: 0,
      missingMarkerIds,
      markers: [],
    }
  }

  const updatesById = new Map(normalizedUpdates.map((entry) => [entry.id, entry]))
  state.saveToHistory?.()
  useTimelineStore.setState((currentState) => ({
    markers: (currentState.markers || [])
      .map((marker) => {
        const update = updatesById.get(marker.id)
        return update ? { ...marker, ...update } : marker
      })
      .sort((a, b) => a.time - b.time),
  }))

  return {
    markerCount: normalizedUpdates.length,
    missingMarkerIds,
    markers: normalizedUpdates.map(summarizeMarker),
  }
}

function handleAddTrack(payload = {}) {
  const state = useTimelineStore.getState()
  const type = normalizeTrackType(payload.type || payload.trackType)
  const options = {}
  const name = String(payload.name || '').trim().slice(0, 80)
  if (name) options.name = name
  if (type === 'audio') options.channels = normalizeAudioChannels(payload.channels)

  state.saveToHistory?.()
  const track = state.addTrack?.(type, options)
  if (!track) throw new Error('Could not create track.')

  const nextState = useTimelineStore.getState()
  return {
    created: true,
    track: summarizeTrack(track),
    trackCount: (nextState.tracks || []).length,
    videoTrackCount: (nextState.tracks || []).filter((candidate) => candidate.type === 'video').length,
    audioTrackCount: (nextState.tracks || []).filter((candidate) => candidate.type === 'audio').length,
  }
}

function normalizeTimelineName(value, fallback = 'New Sequence') {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120)
  return normalized || fallback
}

function createUniqueTimelineName(name, timelines = []) {
  const usedNames = new Set((timelines || []).map((timeline) => String(timeline?.name || '').trim().toLowerCase()))
  if (!usedNames.has(name.toLowerCase())) return name

  let index = 2
  let candidate = `${name} ${index}`
  while (usedNames.has(candidate.toLowerCase())) {
    index += 1
    candidate = `${name} ${index}`
  }
  return candidate
}

function normalizeTimelineDimension(value, fallback) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return Math.max(1, Math.round(parsed))
  return Math.max(1, Math.round(Number(fallback) || 1920))
}

function normalizeTimelineFps(value, fallback) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(240, Math.max(1, parsed))
  const fallbackFps = Number(fallback)
  return Number.isFinite(fallbackFps) && fallbackFps > 0 ? fallbackFps : 24
}

function normalizeOptionalTimelineColor(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase()
  throw new Error('Invalid timeline color. Use a hex color like #38bdf8 or omit it.')
}

function summarizeTimeline(timeline, projectSettings = {}) {
  if (!timeline) return null
  const tracks = Array.isArray(timeline.tracks) ? timeline.tracks : []
  const clips = Array.isArray(timeline.clips) ? timeline.clips : []
  return {
    id: timeline.id,
    name: timeline.name || timeline.id,
    width: Number(timeline.width || projectSettings.width || 1920),
    height: Number(timeline.height || projectSettings.height || 1080),
    fps: Number(timeline.fps || projectSettings.fps || 24),
    duration: Number(timeline.duration) || 0,
    trackCount: tracks.length,
    clipCount: clips.length,
    color: timeline.color || null,
    folderId: timeline.folderId || null,
  }
}

function buildCreateTimelinePlan(payload = {}) {
  const projectState = useProjectStore.getState()
  const project = projectState.currentProject
  if (!project) throw new Error('Open a saved project before creating a sequence.')

  const timelines = project.timelines || []
  const currentSettings = typeof projectState.getCurrentTimelineSettings === 'function'
    ? projectState.getCurrentTimelineSettings()
    : null
  const projectSettings = project.settings || {}
  const copySettingsFromCurrent = payload.copySettingsFromCurrent !== false
  const settingsSource = copySettingsFromCurrent ? (currentSettings || projectSettings) : projectSettings
  const requestedName = normalizeTimelineName(payload.name || payload.timelineName || payload.sequenceName)
  const name = payload.allowDuplicateName === true
    ? requestedName
    : createUniqueTimelineName(requestedName, timelines)
  const requestedDuration = Number(payload.durationSeconds ?? payload.duration)
  const durationSeconds = Number.isFinite(requestedDuration) && requestedDuration > 0
    ? roundToTimelineFrame(requestedDuration, normalizeTimelineFps(payload.fps, settingsSource?.fps || 24))
    : 60

  return {
    action: 'create_timeline',
    previewOnly: payload.previewOnly !== false,
    requestedName,
    name,
    nameAdjusted: name !== requestedName,
    width: normalizeTimelineDimension(payload.width, settingsSource?.width || projectSettings.width || 1920),
    height: normalizeTimelineDimension(payload.height, settingsSource?.height || projectSettings.height || 1080),
    fps: normalizeTimelineFps(payload.fps, settingsSource?.fps || projectSettings.fps || 24),
    durationSeconds,
    color: normalizeOptionalTimelineColor(payload.color),
    folderId: String(payload.folderId || '').trim() || null,
    copySettingsFromCurrent,
    switchToTimeline: payload.switchToTimeline !== false && payload.activate !== false && payload.makeActive !== false,
    existingTimelineCount: timelines.length,
  }
}

async function handleCreateTimeline(payload = {}) {
  const projectState = useProjectStore.getState()
  const plan = buildCreateTimelinePlan(payload)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'create_timeline',
      message: 'Sequence creation plan only. No timeline was created.',
      plan,
    }
  }

  const timeline = projectState.createTimeline?.({
    name: plan.name,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    durationSeconds: plan.durationSeconds,
    color: plan.color,
    folderId: plan.folderId,
  })
  if (!timeline) throw new Error('Could not create the sequence.')

  let switched = false
  if (plan.switchToTimeline && timeline.id) {
    switched = await useProjectStore.getState().switchTimeline?.(timeline.id)
  }

  const nextProjectState = useProjectStore.getState()
  const createdTimeline = (nextProjectState.currentProject?.timelines || []).find((candidate) => candidate.id === timeline.id) || timeline
  return {
    created: true,
    action: 'create_timeline',
    timeline: summarizeTimeline(createdTimeline, nextProjectState.currentProject?.settings || {}),
    switchToTimeline: plan.switchToTimeline,
    switched,
    currentTimelineId: nextProjectState.currentTimelineId || null,
    timelineCount: (nextProjectState.currentProject?.timelines || []).length,
  }
}

function summarizeAssetFolder(folder = null) {
  if (!folder) return null
  return {
    id: folder.id,
    name: folder.name || folder.id,
    parentId: folder.parentId || null,
    color: folder.color || null,
    createdAt: folder.createdAt || folder.created || null,
  }
}

function normalizeAssetFolderName(value, fallback = 'New Folder') {
  const normalized = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return normalized || fallback
}

function splitAssetFolderPathInput(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeAssetFolderName(entry, '')).filter(Boolean)
  }
  const raw = String(value || '').trim()
  if (!raw) return []
  return raw
    .split(/[\\/]+/)
    .map((entry) => normalizeAssetFolderName(entry, ''))
    .filter(Boolean)
}

function findAssetFolderByName(folders = [], parentId = null, name = '') {
  const key = String(name || '').trim().toLowerCase()
  if (!key) return null
  return (folders || []).find((folder) => (
    (folder?.parentId || null) === (parentId || null)
    && String(folder?.name || '').trim().toLowerCase() === key
  )) || null
}

function makeUniqueAssetFolderName(name, folders = [], parentId = null) {
  const usedNames = new Set(
    (folders || [])
      .filter((folder) => (folder?.parentId || null) === (parentId || null))
      .map((folder) => String(folder?.name || '').trim().toLowerCase())
  )
  if (!usedNames.has(name.toLowerCase())) return name

  let index = 2
  let candidate = `${name} ${index}`
  while (usedNames.has(candidate.toLowerCase())) {
    index += 1
    candidate = `${name} ${index}`
  }
  return candidate
}

function getAssetFolderPathSegments(folders = [], folderId = null) {
  const segments = []
  let cursor = folderId || null
  const seen = new Set()
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const folder = (folders || []).find((entry) => entry?.id === cursor)
    if (!folder) break
    segments.unshift(folder.name || folder.id)
    cursor = folder.parentId || null
  }
  return segments
}

function resolveAssetFolderParent(payload = {}, folders = []) {
  const parentId = String(payload.parentId || payload.parentFolderId || '').trim() || null
  const parentPath = splitAssetFolderPathInput(payload.parentPath || payload.parentFolderPath || [])

  if (parentId) {
    const parent = folders.find((folder) => folder?.id === parentId) || null
    if (!parent) throw new Error(`Parent folder ${parentId} was not found.`)
    return {
      parentId,
      parentPath: getAssetFolderPathSegments(folders, parentId),
    }
  }

  if (parentPath.length === 0) return { parentId: null, parentPath: [] }

  let cursor = null
  for (const segment of parentPath) {
    const folder = findAssetFolderByName(folders, cursor, segment)
    if (!folder) {
      throw new Error(`Parent folder path "${parentPath.join(' / ')}" was not found. Use path/folderPath to create missing folders.`)
    }
    cursor = folder.id
  }

  return { parentId: cursor, parentPath }
}

function buildCreateAssetFolderPlan(payload = {}) {
  const project = useProjectStore.getState().currentProject
  if (!project) throw new Error('Open a saved project before creating an asset folder.')

  const folders = useAssetsStore.getState().folders || []
  const rawPath = payload.path ?? payload.folderPath ?? payload.segments ?? payload.folderSegments
  const pathSegments = splitAssetFolderPathInput(rawPath)
  const nameSegments = pathSegments.length > 0
    ? pathSegments
    : [normalizeAssetFolderName(payload.name || payload.folderName)]

  if (nameSegments.length === 0) throw new Error('Provide a folder name or folder path.')

  const parent = resolveAssetFolderParent(payload, folders)
  const reuseExisting = payload.reuseExisting !== false
  const allowDuplicateName = payload.allowDuplicateName === true
  const rawColor = String(payload.color || '').trim()
  const color = rawColor ? normalizeClipLabelColor(rawColor) : null
  if (rawColor && !color) throw new Error('Invalid folder color. Use a hex color like #38bdf8 or omit it.')

  const simulatedFolders = [...folders]
  const steps = []
  let cursor = parent.parentId || null
  for (const segment of nameSegments) {
    const existing = findAssetFolderByName(simulatedFolders, cursor, segment)
    if (existing && reuseExisting) {
      steps.push({
        action: 'reuse',
        name: existing.name || segment,
        folderId: existing.id,
        parentId: cursor,
        folder: summarizeAssetFolder(existing),
      })
      cursor = existing.id
      continue
    }

    const name = existing && !allowDuplicateName
      ? makeUniqueAssetFolderName(segment, simulatedFolders, cursor)
      : segment
    const plannedId = `planned-folder-${steps.length + 1}`
    steps.push({
      action: 'create',
      name,
      requestedName: segment,
      nameAdjusted: name !== segment,
      parentId: cursor,
      folder: {
        id: null,
        name,
        parentId: cursor,
        color: null,
      },
    })
    simulatedFolders.push({
      id: plannedId,
      name,
      parentId: cursor,
      color: null,
    })
    cursor = plannedId
  }

  const lastStep = steps[steps.length - 1] || null
  const leafExistingFolder = lastStep?.action === 'reuse'
    ? folders.find((folder) => folder?.id === lastStep.folderId) || null
    : null

  return {
    action: 'create_asset_folder',
    previewOnly: payload.previewOnly !== false,
    path: [...parent.parentPath, ...nameSegments],
    requestedPath: nameSegments,
    parentId: parent.parentId || null,
    reuseExisting,
    allowDuplicateName,
    color,
    setColorOnExisting: payload.setColorOnExisting === true,
    steps,
    createdCount: steps.filter((step) => step.action === 'create').length,
    reusedCount: steps.filter((step) => step.action === 'reuse').length,
    leafFolder: summarizeAssetFolder(leafExistingFolder),
    leafFolderId: leafExistingFolder?.id || null,
  }
}

async function handleCreateAssetFolder(payload = {}) {
  const plan = buildCreateAssetFolderPlan(payload)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'create_asset_folder',
      message: plan.createdCount === 0
        ? 'Asset folder already exists. No project change was made.'
        : `Asset folder plan only. ${plan.createdCount} folder${plan.createdCount === 1 ? '' : 's'} would be created.`,
      plan,
    }
  }

  const createdFolders = []
  let cursor = plan.parentId || null
  let leafFolder = null

  for (const step of plan.steps) {
    if (step.action === 'reuse') {
      leafFolder = (useAssetsStore.getState().folders || []).find((folder) => folder?.id === step.folderId) || null
      cursor = leafFolder?.id || cursor
      continue
    }

    const state = useAssetsStore.getState()
    if (typeof state.addFolder !== 'function') throw new Error('Asset folder creation is not available.')
    const folder = state.addFolder({
      name: step.name,
      parentId: cursor,
      color: null,
    })
    if (!folder) throw new Error(`Could not create asset folder "${step.name}".`)
    createdFolders.push(folder)
    leafFolder = folder
    cursor = folder.id
  }

  if (plan.color && leafFolder?.id && (createdFolders.some((folder) => folder.id === leafFolder.id) || plan.setColorOnExisting)) {
    useAssetsStore.getState().setFolderColor?.(leafFolder.id, plan.color)
    leafFolder = {
      ...leafFolder,
      color: plan.color,
    }
  }

  const folders = useAssetsStore.getState().folders || []
  const savedProject = typeof useProjectStore.getState().saveProject === 'function'
    ? await useProjectStore.getState().saveProject()
    : null

  return {
    created: createdFolders.length > 0,
    action: 'create_asset_folder',
    message: createdFolders.length > 0
      ? `Created ${createdFolders.length} asset folder${createdFolders.length === 1 ? '' : 's'}.`
      : 'Asset folder already existed.',
    folder: summarizeAssetFolder(leafFolder),
    folderId: leafFolder?.id || null,
    path: getAssetFolderPathSegments(folders, leafFolder?.id || null),
    createdCount: createdFolders.length,
    reusedCount: plan.reusedCount,
    createdFolders: createdFolders.map(summarizeAssetFolder),
    savedProject: Boolean(savedProject),
  }
}

function resolveAssetFolderPathToId(folders = [], pathSegments = []) {
  const segments = Array.isArray(pathSegments) ? pathSegments : []
  let cursor = null
  for (const segment of segments) {
    const folder = findAssetFolderByName(folders, cursor, segment)
    if (!folder) return null
    cursor = folder.id
  }
  return cursor
}

function getDescendantAssetFolderIds(folders = [], folderId = null) {
  const ids = new Set()
  if (!folderId) return ids
  ids.add(folderId)
  let changed = true
  while (changed) {
    changed = false
    for (const folder of folders || []) {
      if (!folder?.id || ids.has(folder.id)) continue
      if (ids.has(folder.parentId || null)) {
        ids.add(folder.id)
        changed = true
      }
    }
  }
  return ids
}

function getAssetMoveCreatedTime(asset) {
  const raw = asset?.createdAt || asset?.imported || asset?.created || asset?.modified || ''
  const parsed = raw ? Date.parse(raw) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function isMcpSolidColorAsset(asset = {}) {
  const settings = asset.settings || {}
  const sourceTool = String(asset.sourceTool || settings.sourceTool || '').trim().toLowerCase()
  const overlayKind = String(asset.overlayKind || settings.overlayKind || '').trim().toLowerCase()
  const generatedBy = String(asset.generatedBy || settings.generatedBy || '').trim().toLowerCase()
  const solidColor = String(asset.solidColor || settings.solidColor || settings.color || asset.color || '').trim()
  const name = String(asset.name || '').trim().toLowerCase()
  return sourceTool === 'add_solid_color'
    || (overlayKind === 'color' && (generatedBy === 'mcp' || /^#[0-9a-fA-F]{6}$/.test(solidColor)))
    || (String(asset.type || '').toLowerCase() === 'image' && name.includes('solid') && /^#[0-9a-fA-F]{6}$/.test(solidColor))
}

function resolveAssetMoveTarget(payload = {}) {
  const folders = useAssetsStore.getState().folders || []
  const wantsRoot = payload.targetRoot === true
    || payload.root === true
    || ['root', 'none', 'null'].includes(String(payload.targetFolderPath || payload.folderPath || payload.targetFolderName || payload.folderName || '').trim().toLowerCase())
  if (wantsRoot) {
    return {
      targetFolderId: null,
      targetFolder: null,
      targetFolderPath: [],
      targetWillBeCreated: false,
      createPlan: null,
    }
  }

  const targetFolderId = String(payload.targetFolderId || payload.folderId || '').trim()
  if (targetFolderId) {
    const folder = folders.find((candidate) => candidate?.id === targetFolderId) || null
    if (!folder) throw new Error(`Target folder ${targetFolderId} was not found.`)
    return {
      targetFolderId,
      targetFolder: summarizeAssetFolder(folder),
      targetFolderPath: getAssetFolderPathSegments(folders, targetFolderId),
      targetWillBeCreated: false,
      createPlan: null,
    }
  }

  const rawPath = payload.targetFolderPath ?? payload.folderPath ?? payload.targetPath ?? payload.path ?? payload.targetFolderName ?? payload.folderName ?? payload.name
  const targetPath = splitAssetFolderPathInput(rawPath)
  if (targetPath.length === 0) throw new Error('Provide targetFolderId, targetFolderPath, folderName, or targetRoot=true.')

  const existingFolderId = resolveAssetFolderPathToId(folders, targetPath)
  if (existingFolderId) {
    const folder = folders.find((candidate) => candidate?.id === existingFolderId) || null
    return {
      targetFolderId: existingFolderId,
      targetFolder: summarizeAssetFolder(folder),
      targetFolderPath: getAssetFolderPathSegments(folders, existingFolderId),
      targetWillBeCreated: false,
      createPlan: null,
    }
  }

  const createPlan = buildCreateAssetFolderPlan({
    path: targetPath,
    color: payload.targetFolderColor || payload.folderColor || payload.color || '',
    reuseExisting: payload.reuseExisting !== false,
    allowDuplicateName: payload.allowDuplicateName === true,
    previewOnly: true,
  })

  return {
    targetFolderId: createPlan.leafFolderId || null,
    targetFolder: createPlan.leafFolder || null,
    targetFolderPath: createPlan.path || targetPath,
    targetWillBeCreated: createPlan.createdCount > 0,
    createPlan,
  }
}

function resolveAssetMoveSource(payload = {}) {
  const folders = useAssetsStore.getState().folders || []
  if (payload.rootOnly === true || payload.sourceRoot === true || payload.fromRoot === true) {
    return { mode: 'root', folderIds: new Set([null]), sourceFolderPath: [] }
  }

  const sourceFolderId = String(payload.sourceFolderId || payload.fromFolderId || '').trim()
  const sourceFolderPath = splitAssetFolderPathInput(payload.sourceFolderPath || payload.fromFolderPath || [])
  let resolvedSourceFolderId = null

  if (sourceFolderId) {
    const folder = folders.find((candidate) => candidate?.id === sourceFolderId) || null
    if (!folder) throw new Error(`Source folder ${sourceFolderId} was not found.`)
    resolvedSourceFolderId = sourceFolderId
  } else if (sourceFolderPath.length > 0) {
    resolvedSourceFolderId = resolveAssetFolderPathToId(folders, sourceFolderPath)
    if (!resolvedSourceFolderId) throw new Error(`Source folder path "${sourceFolderPath.join(' / ')}" was not found.`)
  }

  if (!resolvedSourceFolderId) return { mode: 'all', folderIds: null, sourceFolderPath: [] }

  const includeSubfolders = payload.includeSubfolders !== false
  return {
    mode: includeSubfolders ? 'sourceFolderWithSubfolders' : 'sourceFolder',
    folderIds: includeSubfolders
      ? getDescendantAssetFolderIds(folders, resolvedSourceFolderId)
      : new Set([resolvedSourceFolderId]),
    sourceFolderPath: getAssetFolderPathSegments(folders, resolvedSourceFolderId),
  }
}

function summarizeAssetForMove(asset = {}) {
  const folders = useAssetsStore.getState().folders || []
  const folderId = asset.folderId || null
  const settings = asset.settings || {}
  return {
    id: asset.id,
    name: asset.name || asset.id,
    type: asset.type || 'unknown',
    folderId,
    folderPath: folderId ? getAssetFolderPathSegments(folders, folderId) : [],
    workflowId: asset.workflowId || settings.workflowId || '',
    workflowName: asset.workflowName || settings.workflowName || '',
    sourceTool: asset.sourceTool || settings.sourceTool || '',
    overlayKind: asset.overlayKind || settings.overlayKind || '',
    generatedBy: asset.generatedBy || settings.generatedBy || '',
    solidColor: asset.solidColor || settings.solidColor || settings.color || asset.color || '',
    createdAt: asset.createdAt || asset.imported || null,
  }
}

function resolveAssetsForFolderMove(payload = {}, target = {}) {
  const assets = useAssetsStore.getState().assets || []
  const source = resolveAssetMoveSource(payload)
  const explicitEntries = []
  if (Array.isArray(payload.assets)) explicitEntries.push(...payload.assets)
  if (payload.assetId) explicitEntries.push(payload.assetId)
  for (const assetId of normalizeStringList(payload.assetIds)) explicitEntries.push({ assetId })
  for (const assetName of normalizeStringList(payload.assetNames || payload.assetName)) explicitEntries.push({ assetName })

  let candidates = []
  const missingAssetIds = []
  const missingAssetNames = []

  if (explicitEntries.length > 0) {
    const byId = new Map(assets.map((asset) => [asset?.id, asset]).filter(([id]) => id))
    const seen = new Set()
    for (const rawEntry of explicitEntries) {
      const entry = typeof rawEntry === 'string' ? { assetId: rawEntry } : (rawEntry || {})
      const assetId = String(entry.assetId || entry.id || '').trim()
      const assetName = String(entry.assetName || entry.name || '').trim().toLowerCase()
      let asset = assetId ? byId.get(assetId) : null
      if (!asset && assetName) {
        asset = assets.find((candidate) => String(candidate?.name || '').trim().toLowerCase() === assetName)
          || assets.find((candidate) => String(candidate?.name || '').trim().toLowerCase().includes(assetName))
      }
      if (!asset) {
        if (assetId) missingAssetIds.push(assetId)
        if (assetName) missingAssetNames.push(entry.assetName || entry.name)
        continue
      }
      if (!seen.has(asset.id)) {
        candidates.push(asset)
        seen.add(asset.id)
      }
    }
  } else {
    candidates = assets.slice()
  }

  const typeFilters = normalizeStringList(payload.types || payload.type || payload.assetType).map((type) => type.toLowerCase())
  if (typeFilters.length > 0) {
    candidates = candidates.filter((asset) => typeFilters.includes(String(asset?.type || '').toLowerCase()))
  }

  const workflowIds = normalizeStringList(payload.workflowIds || payload.workflowId).map((id) => id.toLowerCase())
  if (workflowIds.length > 0) {
    candidates = candidates.filter((asset) => workflowIds.includes(getAssetWorkflowId(asset)))
  }

  const query = String(payload.nameIncludes || payload.nameContains || payload.search || payload.query || '').trim().toLowerCase()
  if (query) {
    candidates = candidates.filter((asset) => String(asset?.name || '').toLowerCase().includes(query))
  }

  const filter = String(payload.filter || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  const solidColorsOnly = payload.solidColorsOnly === true
    || payload.constantsOnly === true
    || payload.solidOnly === true
    || ['solid', 'solids', 'solidcolor', 'solidcolors', 'constant', 'constants'].includes(filter)
  if (solidColorsOnly) candidates = candidates.filter(isMcpSolidColorAsset)
  if (filter === 'generated') candidates = candidates.filter((asset) => asset?.isImported !== true)
  if (filter === 'imported') candidates = candidates.filter((asset) => asset?.isImported === true)

  if (source.folderIds) {
    candidates = candidates.filter((asset) => source.folderIds.has(asset?.folderId || null))
  }

  const statuses = normalizeStringList(payload.statuses || payload.status).map((status) => status.toLowerCase())
  if (statuses.length > 0) {
    candidates = candidates.filter((asset) => statuses.includes(String(asset?.generationStatus || asset?.status || 'none').toLowerCase()))
  }

  const order = String(payload.order || payload.sortOrder || 'oldest_first').trim().toLowerCase()
  candidates = candidates
    .filter((asset) => asset?.id)
    .sort((a, b) => order === 'newest_first'
      ? getAssetMoveCreatedTime(b) - getAssetMoveCreatedTime(a)
      : getAssetMoveCreatedTime(a) - getAssetMoveCreatedTime(b))

  const targetFolderId = target.targetWillBeCreated ? '__new_target_folder__' : (target.targetFolderId || null)
  const unchangedAssets = target.targetWillBeCreated
    ? []
    : candidates.filter((asset) => (asset?.folderId || null) === targetFolderId)
  const assetsToMove = target.targetWillBeCreated
    ? candidates
    : candidates.filter((asset) => (asset?.folderId || null) !== targetFolderId)

  return {
    source,
    candidates,
    assetsToMove,
    unchangedAssets,
    missingAssetIds,
    missingAssetNames,
    mode: explicitEntries.length > 0 ? 'explicit' : 'filter',
    filters: {
      typeFilters,
      workflowIds,
      query,
      filter,
      solidColorsOnly,
      statuses,
    },
  }
}

function buildMoveAssetsToFolderPlan(payload = {}) {
  if (!useProjectStore.getState().currentProject) {
    throw new Error('Open a saved project before moving assets.')
  }

  const target = resolveAssetMoveTarget(payload)
  const resolvedAssets = resolveAssetsForFolderMove(payload, target)
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(payload.limit) || 100)))
  if (resolvedAssets.assetsToMove.length > limit) {
    throw new Error(`Matched ${resolvedAssets.assetsToMove.length} assets to move, above limit ${limit}. Pass a higher limit intentionally if this is expected.`)
  }

  return {
    action: 'move_assets_to_folder',
    previewOnly: payload.previewOnly !== false,
    mode: resolvedAssets.mode,
    targetFolderId: target.targetFolderId,
    targetFolder: target.targetFolder,
    targetFolderPath: target.targetFolderPath,
    targetRoot: target.targetFolderId === null && !target.targetWillBeCreated,
    targetWillBeCreated: target.targetWillBeCreated,
    createTargetFolderPlan: target.createPlan,
    sourceMode: resolvedAssets.source.mode,
    sourceFolderPath: resolvedAssets.source.sourceFolderPath || [],
    filters: resolvedAssets.filters,
    candidateCount: resolvedAssets.candidates.length,
    moveCount: resolvedAssets.assetsToMove.length,
    unchangedCount: resolvedAssets.unchangedAssets.length,
    missingAssetIds: resolvedAssets.missingAssetIds,
    missingAssetNames: resolvedAssets.missingAssetNames,
    assets: resolvedAssets.assetsToMove.map(summarizeAssetForMove),
    unchangedAssets: resolvedAssets.unchangedAssets.slice(0, 50).map(summarizeAssetForMove),
  }
}

async function handleMoveAssetsToFolder(payload = {}) {
  const plan = buildMoveAssetsToFolderPlan(payload)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'move_assets_to_folder',
      message: plan.moveCount === 0
        ? 'No matching assets need to move.'
        : `Asset move plan only. ${plan.moveCount} asset${plan.moveCount === 1 ? '' : 's'} would move.`,
      plan,
    }
  }

  if (plan.moveCount === 0) {
    return {
      success: false,
      action: 'move_assets_to_folder',
      message: 'No matching assets need to move.',
      plan,
    }
  }

  let targetFolderId = plan.targetFolderId || null
  if (plan.targetWillBeCreated) {
    const created = await handleCreateAssetFolder({
      path: plan.targetFolderPath,
      color: payload.targetFolderColor || payload.folderColor || payload.color || '',
      previewOnly: false,
    })
    targetFolderId = created.folderId || null
  }

  const assetIds = plan.assets.map((asset) => asset.id).filter(Boolean)
  if (assetIds.length === 0) throw new Error('No asset IDs were available to move.')
  const state = useAssetsStore.getState()
  if (typeof state.moveAssetsToFolder !== 'function') throw new Error('Asset folder moving is not available.')
  state.moveAssetsToFolder(assetIds, targetFolderId)
  const savedProject = typeof useProjectStore.getState().saveProject === 'function'
    ? await useProjectStore.getState().saveProject()
    : null
  const nextFolders = useAssetsStore.getState().folders || []

  return {
    success: true,
    action: 'move_assets_to_folder',
    movedCount: assetIds.length,
    assetIds,
    targetFolderId,
    targetFolderPath: targetFolderId ? getAssetFolderPathSegments(nextFolders, targetFolderId) : [],
    targetRoot: !targetFolderId,
    createdTargetFolder: plan.targetWillBeCreated,
    savedProject: Boolean(savedProject),
  }
}

function summarizeAsset(asset) {
  return {
    id: asset.id,
    name: asset.name || asset.id,
    type: asset.type || 'unknown',
    folderId: asset.folderId || null,
    duration: Number(asset.duration ?? asset.settings?.duration) || null,
    width: Number(asset.width ?? asset.settings?.width) || null,
    height: Number(asset.height ?? asset.settings?.height) || null,
    workflowId: asset.workflowId || asset.settings?.workflowId || '',
    workflowName: asset.workflowName || asset.settings?.workflowName || '',
    sourceTool: asset.sourceTool || asset.settings?.sourceTool || '',
    overlayKind: asset.overlayKind || asset.settings?.overlayKind || '',
    generatedBy: asset.generatedBy || asset.settings?.generatedBy || '',
    solidColor: asset.solidColor || asset.settings?.solidColor || asset.settings?.color || asset.color || '',
    hasAudio: typeof asset.hasAudio === 'boolean' ? asset.hasAudio : null,
    audioEnabled: typeof asset.audioEnabled === 'boolean' ? asset.audioEnabled : null,
    generationStatus: asset.generationStatus || asset.status || 'none',
    createdAt: asset.createdAt || asset.imported || null,
  }
}

function normalizeAssetTimelinePlacement(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (['selectedclipstart', 'selectionstart', 'selectedstart'].includes(normalized)) return 'selected_clip_start'
  if (['selectedclipend', 'selectionend', 'selectedend', 'afterselectedclip', 'afterselection'].includes(normalized)) return 'selected_clip_end'
  if (['timelineend', 'end', 'append'].includes(normalized)) return 'timeline_end'
  if (['trackend', 'endoftrack'].includes(normalized)) return 'track_end'
  return 'playhead'
}

function getAssetCreatedTime(asset) {
  const raw = asset?.createdAt || asset?.imported || asset?.created || asset?.modified || ''
  const parsed = raw ? Date.parse(raw) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function resolveMcpTimelineAsset(payload = {}) {
  const assets = useAssetsStore.getState().assets || []
  const assetId = String(payload.assetId || payload.id || '').trim()
  const assetName = String(payload.assetName || payload.name || '').trim().toLowerCase()
  const type = String(payload.type || payload.assetType || '').trim().toLowerCase()
  const workflowId = String(payload.workflowId || '').trim().toLowerCase()
  const latest = payload.latest === true || payload.latestGenerated === true || payload.latestAsset === true

  let candidates = assets.filter((asset) => asset?.id)
  if (type) candidates = candidates.filter((asset) => String(asset.type || '').toLowerCase() === type)
  if (workflowId) {
    candidates = candidates.filter((asset) => (
      String(asset.workflowId || asset.settings?.workflowId || '').trim().toLowerCase() === workflowId
    ))
  }

  if (assetId) {
    const asset = assets.find((candidate) => candidate?.id === assetId)
    if (!asset) throw new Error(`Asset ${assetId} was not found.`)
    return asset
  }

  if (assetName) {
    const exact = candidates.find((asset) => String(asset.name || '').trim().toLowerCase() === assetName)
    if (exact) return exact
    const partial = candidates.find((asset) => String(asset.name || '').trim().toLowerCase().includes(assetName))
    if (partial) return partial
    throw new Error(`No asset matched "${payload.assetName || payload.name}".`)
  }

  if (latest || candidates.length > 0) {
    const allowedStatuses = new Set(['none', 'done', 'complete', 'completed', 'success', ''])
    const latestCandidate = candidates
      .filter((asset) => allowedStatuses.has(String(asset.generationStatus || asset.status || 'none').toLowerCase()))
      .sort((a, b) => getAssetCreatedTime(b) - getAssetCreatedTime(a))[0]
    if (latestCandidate) return latestCandidate
  }

  throw new Error('No matching asset was found. Provide assetId, assetName, or latestGenerated=true.')
}

function getAssetWorkflowId(asset) {
  return String(asset?.workflowId || asset?.settings?.workflowId || '').trim().toLowerCase()
}

function normalizeMcpStringList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
  }
  const raw = String(value || '').trim()
  if (!raw) return []
  return [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))]
}

function isMcpPlaceableTimelineAsset(asset) {
  return ['video', 'image', 'audio'].includes(String(asset?.type || '').toLowerCase())
}

function resolveMcpTimelineAssets(payload = {}) {
  const assets = useAssetsStore.getState().assets || []
  const explicitEntries = []

  if (Array.isArray(payload.assets)) {
    explicitEntries.push(...payload.assets)
  }
  if (Array.isArray(payload.assetIds)) {
    explicitEntries.push(...payload.assetIds.map((assetId) => ({ assetId })))
  }
  if (Array.isArray(payload.assetNames)) {
    explicitEntries.push(...payload.assetNames.map((assetName) => ({ assetName })))
  }

  if (explicitEntries.length > 0) {
    const seen = new Set()
    const items = []
    for (const rawEntry of explicitEntries) {
      const entry = typeof rawEntry === 'string' ? { assetId: rawEntry } : (rawEntry || {})
      const asset = resolveMcpTimelineAsset({ ...payload, ...entry })
      if (!isMcpPlaceableTimelineAsset(asset)) {
        throw new Error(`Asset ${asset?.name || asset?.id || ''} cannot be placed on the timeline yet.`)
      }
      if (!asset.id || seen.has(asset.id)) continue
      seen.add(asset.id)
      items.push({ asset, entry })
    }
    if (items.length === 0) throw new Error('No unique placeable assets were resolved for batch placement.')
    if (items.length > MCP_ASSET_BATCH_MAX_ITEMS) throw new Error(`Batch placement is limited to ${MCP_ASSET_BATCH_MAX_ITEMS} assets.`)
    return items
  }

  const type = String(payload.type || payload.assetType || '').trim().toLowerCase()
  const workflowIds = normalizeMcpStringList(payload.workflowIds || payload.workflowId).map((id) => id.toLowerCase())
  const requestedStatuses = normalizeMcpStringList(payload.statuses || payload.status).map((status) => status.toLowerCase())
  const allowedStatuses = requestedStatuses.length > 0
    ? new Set(requestedStatuses)
    : new Set(['none', 'done', 'complete', 'completed', 'success', ''])

  let candidates = assets.filter(isMcpPlaceableTimelineAsset)
  if (type) candidates = candidates.filter((asset) => String(asset.type || '').toLowerCase() === type)
  if (workflowIds.length > 0) {
    candidates = candidates.filter((asset) => workflowIds.includes(getAssetWorkflowId(asset)))
  }
  candidates = candidates.filter((asset) => allowedStatuses.has(String(asset.generationStatus || asset.status || 'none').toLowerCase()))
  if (candidates.length === 0) throw new Error('No matching placeable assets were found for batch placement.')

  const requestedCount = Number(payload.latestCount ?? payload.count ?? payload.limit)
  const count = Number.isFinite(requestedCount) && requestedCount > 0
    ? Math.min(MCP_ASSET_BATCH_MAX_ITEMS, Math.floor(requestedCount))
    : Math.min(6, candidates.length, MCP_ASSET_BATCH_MAX_ITEMS)
  const newestFirst = candidates
    .slice()
    .sort((a, b) => getAssetCreatedTime(b) - getAssetCreatedTime(a))
    .slice(0, count)
  const order = String(payload.order || payload.sortOrder || 'oldest_first').trim().toLowerCase()
  const selected = order === 'newest_first' ? newestFirst : newestFirst.reverse()

  return selected.map((asset) => ({ asset, entry: {} }))
}

function getCompatibleTrackTypeForAsset(asset) {
  const type = String(asset?.type || '').toLowerCase()
  if (type === 'audio') return 'audio'
  if (type === 'video' || type === 'image') return 'video'
  throw new Error(`Asset ${asset?.name || asset?.id || ''} has unsupported type "${asset?.type || 'unknown'}" for timeline placement.`)
}

function shouldAddLinkedVideoAudio(asset, payload = {}) {
  if (String(asset?.type || '').toLowerCase() !== 'video') return false
  if (payload.includeAudio === false || payload.includeEmbeddedAudio === false) return false
  if (asset.audioEnabled === false) return false
  if (asset.hasAudio === false) return false
  return true
}

function shouldAddBatchLinkedVideoAudio(payload = {}, layout = '') {
  if (payload.includeAudio === true || payload.includeEmbeddedAudio === true) return true
  if (payload.includeAudio === false || payload.includeEmbeddedAudio === false) return false
  return layout === 'sequential'
}

function getAvailableMcpAudioTrack(state) {
  return (state.tracks || []).find((track) => (
    track.type === 'audio' &&
    track.locked !== true &&
    track.visible !== false
  )) || null
}

function makeMcpLinkGroupId(asset, prefix = 'asset') {
  const safeAssetId = String(asset?.id || 'asset').replace(/[^a-zA-Z0-9_-]+/g, '_')
  return `link-mcp-${prefix}-${safeAssetId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function buildLinkedAudioPlan(state, asset, payload = {}) {
  if (!shouldAddLinkedVideoAudio(asset, payload)) return null
  const track = getAvailableMcpAudioTrack(state)
  return {
    createTrack: !track,
    track: summarizeTrack(track || {
      id: null,
      name: String(payload.audioTrackName || '').trim() || 'MCP Linked Audio',
      type: 'audio',
      muted: false,
      locked: false,
      visible: true,
      channels: normalizeAudioChannels(payload.channels),
    }),
  }
}

function resolveMcpTimelineTrack(state, asset, payload = {}) {
  const targetType = getCompatibleTrackTypeForAsset(asset)
  const trackId = String(payload.trackId || '').trim()
  const createTrack = payload.createTrack === true || payload.newTrack === true || ['new', 'newtop', 'newtrack', 'newtoptrack'].includes(String(payload.trackStrategy || payload.placementTrack || '').trim().toLowerCase().replace(/[\s_-]+/g, ''))

  if (trackId) {
    const track = (state.tracks || []).find((candidate) => candidate.id === trackId)
    if (!track) throw new Error(`Track ${trackId} was not found.`)
    if (track.type !== targetType) throw new Error(`Asset ${asset.name || asset.id} is ${asset.type}; it needs a ${targetType} track.`)
    if (track.locked) throw new Error(`Track ${trackId} is locked.`)
    return { track, createTrack: false, targetType }
  }

  if (createTrack) {
    return { track: null, createTrack: true, targetType }
  }

  const track = (state.tracks || []).find((candidate) => (
    candidate.type === targetType &&
    candidate.locked !== true &&
    candidate.visible !== false &&
    candidate.role !== 'captions'
  ))
  if (!track) {
    return { track: null, createTrack: true, targetType }
  }
  return { track, createTrack: false, targetType }
}

function resolveMcpAssetPlacementStart(state, trackId, payload = {}) {
  const fps = Number(state.timelineFps) || 24
  const explicitStart = Number(payload.startSeconds ?? payload.startTime)
  if (Number.isFinite(explicitStart)) return roundToTimelineFrame(Math.max(0, explicitStart), fps)

  const placement = normalizeAssetTimelinePlacement(payload.at || payload.placement || payload.position)
  const selectedIds = Array.isArray(state.selectedClipIds) ? state.selectedClipIds : []
  const selectedClip = selectedIds.length > 0
    ? (state.clips || []).find((clip) => clip.id === selectedIds[0])
    : null

  if (placement === 'selected_clip_start' && selectedClip) {
    return roundToTimelineFrame(Math.max(0, Number(selectedClip.startTime) || 0), fps)
  }
  if (placement === 'selected_clip_end' && selectedClip) {
    return roundToTimelineFrame(Math.max(0, (Number(selectedClip.startTime) || 0) + (Number(selectedClip.duration) || 0)), fps)
  }
  if (placement === 'track_end' && trackId) {
    const end = (state.clips || [])
      .filter((clip) => clip.trackId === trackId)
      .reduce((max, clip) => Math.max(max, (Number(clip.startTime) || 0) + (Number(clip.duration) || 0)), 0)
    return roundToTimelineFrame(end, fps)
  }
  if (placement === 'timeline_end') {
    const end = (state.clips || [])
      .reduce((max, clip) => Math.max(max, (Number(clip.startTime) || 0) + (Number(clip.duration) || 0)), 0)
    return roundToTimelineFrame(end, fps)
  }

  return roundToTimelineFrame(Math.max(0, Number(state.playheadPosition) || 0), fps)
}

function normalizeSolidColor(value) {
  const raw = String(value || '#000000').trim()
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase()
  throw new Error('Invalid solid color. Use a hex color like #000000 or #ff0000.')
}

function normalizeSolidTrackPlacement(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (['top', 'newtop', 'newtoptrack', 'above'].includes(normalized)) return 'top'
  return 'bottom'
}

function buildSolidColorAssetPlan(payload = {}) {
  const projectState = useProjectStore.getState()
  const timelineState = useTimelineStore.getState()
  const timelineSettings = typeof projectState.getCurrentTimelineSettings === 'function'
    ? projectState.getCurrentTimelineSettings()
    : null
  const color = normalizeSolidColor(payload.color || payload.fill || payload.solidColor || '#000000')
  const width = Math.max(1, Math.round(Number(payload.width || timelineSettings?.width || projectState.currentProject?.settings?.width || 1920)))
  const height = Math.max(1, Math.round(Number(payload.height || timelineSettings?.height || projectState.currentProject?.settings?.height || 1080)))
  const fps = Number(timelineState.timelineFps || timelineSettings?.fps || projectState.currentProject?.settings?.fps || 24) || 24
  const duration = Number(payload.durationSeconds ?? payload.duration)
  const durationSeconds = Number.isFinite(duration) && duration > 0
    ? roundToTimelineFrame(duration, fps)
    : 5
  const name = String(payload.name || payload.assetName || '').trim()
    || `${color === '#000000' ? 'Black' : 'Color'} solid ${width}x${height}`
  const placeOnTimeline = payload.placeOnTimeline !== false && payload.addToTimeline !== false
  const createTrack = payload.createTrack !== false && payload.newTrack !== false && !payload.trackId
  const trackPlacement = normalizeSolidTrackPlacement(payload.trackPlacement || payload.trackPosition || payload.placementTrackPosition)
  const pseudoAsset = {
    id: '__mcp_solid_preview__',
    name,
    type: 'image',
    settings: {
      width,
      height,
      overlayKind: 'color',
      color,
      generatedBy: 'mcp',
    },
  }
  const target = placeOnTimeline
    ? resolveMcpTimelineTrack(timelineState, pseudoAsset, {
      ...payload,
      createTrack,
      newTrack: createTrack,
      trackName: payload.trackName || `${color === '#000000' ? 'Black' : 'Color'} solid`,
    })
    : null
  const plannedTrack = target
    ? (target.track || {
      id: null,
      name: String(payload.trackName || '').trim() || `${color === '#000000' ? 'Black' : 'Color'} solid`,
      type: 'video',
      locked: false,
      muted: false,
      visible: true,
      placement: trackPlacement,
    })
    : null
  const startSeconds = placeOnTimeline
    ? resolveMcpAssetPlacementStart(timelineState, target?.track?.id || '', payload)
    : null

  return {
    action: 'add_solid_color',
    previewOnly: payload.previewOnly !== false,
    asset: {
      name,
      type: 'image',
      width,
      height,
      color,
      duration: durationSeconds,
    },
    placeOnTimeline,
    track: plannedTrack ? summarizeTrack(plannedTrack) : null,
    createTrack: placeOnTimeline ? target?.createTrack === true : false,
    trackPlacement: placeOnTimeline && target?.createTrack === true ? trackPlacement : null,
    startSeconds,
    durationSeconds,
    resolveOverlaps: payload.resolveOverlaps === true,
    selectAfterAdd: payload.selectAfterAdd !== false,
    transform: payload.transform && typeof payload.transform === 'object' ? safeClone(payload.transform) : null,
  }
}

async function handleAddSolidColor(payload = {}) {
  const projectState = useProjectStore.getState()
  const projectPath = projectState.currentProjectHandle
  if (typeof projectPath !== 'string' || !projectPath) {
    throw new Error('Open a saved desktop project before creating a solid color asset.')
  }

  const plan = buildSolidColorAssetPlan(payload)
  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'add_solid_color',
      message: 'Solid color asset plan only. No asset or timeline clip was created.',
      plan,
    }
  }

  const blob = await generateColorMatteBlob(plan.asset.width, plan.asset.height, plan.asset.color)
  const persisted = await writeGeneratedOverlayToProject(
    projectPath,
    blob,
    plan.asset.name,
    'image',
    {
      width: plan.asset.width,
      height: plan.asset.height,
      sourceTool: 'add_solid_color',
      overlayKind: 'color',
      solidColor: plan.asset.color,
      color: plan.asset.color,
      generatedBy: 'mcp',
    }
  )
  const asset = useAssetsStore.getState().addAsset?.({
    ...persisted,
    settings: {
      ...(persisted.settings || {}),
      duration: plan.durationSeconds,
      width: plan.asset.width,
      height: plan.asset.height,
      sourceTool: 'add_solid_color',
      overlayKind: 'color',
      solidColor: plan.asset.color,
      color: plan.asset.color,
      generatedBy: 'mcp',
    },
    duration: plan.durationSeconds,
    width: plan.asset.width,
    height: plan.asset.height,
  })
  if (!asset) throw new Error('Could not add the solid color asset to the project.')

  let clip = null
  let createdTrack = null
  if (plan.placeOnTimeline) {
    const timelineState = useTimelineStore.getState()
    let track = plan.track?.id
      ? (timelineState.tracks || []).find((candidate) => candidate.id === plan.track.id)
      : null
    const options = {
      selectAfterAdd: plan.selectAfterAdd,
      resolveOverlaps: plan.resolveOverlaps,
      duration: plan.durationSeconds,
      ...(plan.transform ? { transform: safeClone(plan.transform) } : {}),
      metadata: {
        addedByMcp: true,
        addedAt: new Date().toISOString(),
        sourceTool: 'add_solid_color',
        solidColor: plan.asset.color,
      },
    }

    if (!track && plan.createTrack) {
      timelineState.saveToHistory?.()
      track = useTimelineStore.getState().addTrack?.('video', {
        name: plan.track?.name || `${plan.asset.color === '#000000' ? 'Black' : 'Color'} solid`,
        position: plan.trackPlacement || 'bottom',
      })
      if (!track) throw new Error('Could not create a target video track for the solid color.')
      createdTrack = track
      options.saveHistory = false
    }
    if (!track?.id) throw new Error('No target video track was available for the solid color.')

    clip = useTimelineStore.getState().addClip?.(
      track.id,
      asset,
      plan.startSeconds,
      Number(useTimelineStore.getState().timelineFps) || 24,
      options
    )
    if (!clip) throw new Error('Could not place the solid color on the timeline.')
  }

  return {
    created: true,
    action: 'add_solid_color',
    asset: summarizeAsset(asset),
    clip: clip ? summarizeClip(clip) : null,
    track: createdTrack ? summarizeTrack(createdTrack) : plan.track,
    plan,
  }
}

function handleAddAssetToTimeline(payload = {}) {
  const initialState = useTimelineStore.getState()
  const asset = resolveMcpTimelineAsset(payload)
  const target = resolveMcpTimelineTrack(initialState, asset, payload)
  const linkedAudioPlan = buildLinkedAudioPlan(initialState, asset, payload)
  const plannedTrack = target.track || {
    id: null,
    name: String(payload.trackName || '').trim() || `MCP ${target.targetType === 'video' ? 'Video' : 'Audio'}`,
    type: target.targetType,
    locked: false,
    muted: false,
    visible: true,
    channels: target.targetType === 'audio' ? normalizeAudioChannels(payload.channels) : null,
  }
  const startTime = resolveMcpAssetPlacementStart(initialState, target.track?.id || '', payload)
  const fps = Number(initialState.timelineFps) || 24
  const duration = Number(payload.durationSeconds ?? payload.duration)
  const options = {
    selectAfterAdd: payload.selectAfterAdd !== false,
    resolveOverlaps: payload.resolveOverlaps !== false,
    ...(Number.isFinite(duration) && duration > 0 ? { duration: roundToTimelineFrame(duration, fps) } : {}),
    ...(payload.transform && typeof payload.transform === 'object' ? { transform: safeClone(payload.transform) } : {}),
    metadata: {
      addedByMcp: true,
      addedAt: new Date().toISOString(),
      sourceTool: 'add_asset_to_timeline',
    },
  }

  const plan = {
    asset: summarizeAsset(asset),
    track: summarizeTrack(plannedTrack),
    createTrack: target.createTrack,
    startSeconds: startTime,
    durationSeconds: options.duration || (asset.type === 'image' ? 5 : (Number(asset.duration ?? asset.settings?.duration) || 5)),
    resolveOverlaps: options.resolveOverlaps,
    selectAfterAdd: options.selectAfterAdd,
    placement: normalizeAssetTimelinePlacement(payload.at || payload.placement || payload.position),
    linkedAudio: linkedAudioPlan ? {
      ...linkedAudioPlan,
      startSeconds: startTime,
      durationSeconds: options.duration || (Number(asset.duration ?? asset.settings?.duration) || 5),
    } : null,
  }

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'add_asset_to_timeline',
      message: 'Asset placement plan only. No timeline change was made.',
      plan,
    }
  }

  let track = target.track
  const needsManualHistory = target.createTrack || linkedAudioPlan?.createTrack
  if (needsManualHistory) {
    initialState.saveToHistory?.()
    options.saveHistory = false
  }
  if (target.createTrack) {
    track = initialState.addTrack?.(target.targetType, {
      name: plannedTrack.name,
      ...(target.targetType === 'audio' ? { channels: plannedTrack.channels || 'stereo' } : {}),
    })
    if (!track) throw new Error('Could not create a compatible target track.')
  }

  let audioTrack = null
  if (linkedAudioPlan) {
    audioTrack = linkedAudioPlan.track?.id
      ? (useTimelineStore.getState().tracks || []).find((candidate) => candidate.id === linkedAudioPlan.track.id)
      : null
    if (!audioTrack && linkedAudioPlan.createTrack) {
      audioTrack = useTimelineStore.getState().addTrack?.('audio', {
        name: linkedAudioPlan.track?.name || 'MCP Linked Audio',
        channels: linkedAudioPlan.track?.channels || 'stereo',
      })
      if (!audioTrack) throw new Error('Could not create a linked audio track for the video asset.')
    }
  }

  const linkGroupId = audioTrack ? makeMcpLinkGroupId(asset, 'single') : undefined
  const clip = useTimelineStore.getState().addClip?.(track.id, asset, startTime, fps, {
    ...options,
    ...(linkGroupId ? { linkGroupId, selectAfterAdd: false } : {}),
  })
  if (!clip) throw new Error('Could not add the asset to the timeline.')

  let audioClip = null
  if (audioTrack && linkGroupId) {
    audioClip = useTimelineStore.getState().addClip?.(audioTrack.id, { ...asset, type: 'audio' }, clip.startTime, fps, {
      saveHistory: false,
      linkGroupId,
      selectAfterAdd: false,
      resolveOverlaps: options.resolveOverlaps,
      duration: clip.duration,
      metadata: {
        addedByMcp: true,
        addedAt: new Date().toISOString(),
        sourceTool: 'add_asset_to_timeline',
        linkedVideoClipId: clip.id,
        embeddedAudioFromVideoAsset: true,
      },
    })
  }

  if (options.selectAfterAdd && linkGroupId) {
    useTimelineStore.setState((state) => ({
      selectedClipIds: audioClip ? [clip.id, audioClip.id] : [clip.id],
    }))
  }

  return {
    created: true,
    action: 'add_asset_to_timeline',
    clip: summarizeClip(clip),
    audioClip: audioClip ? summarizeClip(audioClip) : null,
    asset: summarizeAsset(asset),
    track: summarizeTrack(track),
    audioTrack: audioTrack ? summarizeTrack(audioTrack) : null,
    createdTrack: target.createTrack,
    createdAudioTrack: Boolean(linkedAudioPlan?.createTrack && audioTrack),
  }
}

function normalizeMcpAssetBatchTrackStrategy(value, count) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (['single', 'singletrack', 'singleexisting', 'existing', 'existingtrack', 'onetrack', 'sametrack'].includes(normalized)) {
    return 'single_track'
  }
  if (['sequential', 'singletracksequential'].includes(normalized)) return 'single_track'
  if (count <= 1 && ['auto', ''].includes(normalized)) return 'new_tracks'
  return 'new_tracks'
}

function normalizeMcpAssetBatchLayout(value, trackStrategy) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (['sequential', 'sequence', 'append', 'sidebysideintime'].includes(normalized)) return 'sequential'
  if (['stack', 'stacked', 'lanes', 'reviewlanes', 'samestart'].includes(normalized)) return 'stacked'
  return trackStrategy === 'single_track' ? 'sequential' : 'stacked'
}

function formatMcpBatchTrackName(template, asset, index, total, fallbackPrefix = 'MCP Review') {
  const workflow = asset?.workflowName || asset?.settings?.workflowName || asset?.workflowId || asset?.settings?.workflowId || asset?.model || asset?.type || 'Asset'
  const assetName = asset?.name || asset?.id || `Asset ${index + 1}`
  const raw = String(template || '').trim()
    || `${fallbackPrefix} ${index + 1} - ${workflow}`
  return raw
    .replace(/\{index\}/gi, String(index + 1))
    .replace(/\{number\}/gi, String(index + 1))
    .replace(/\{total\}/gi, String(total))
    .replace(/\{asset\}/gi, assetName)
    .replace(/\{name\}/gi, assetName)
    .replace(/\{workflow\}/gi, workflow)
    .slice(0, 100)
}

function getMcpBatchLabelColor(payload = {}, entry = {}, index = 0) {
  const labelColors = Array.isArray(payload.labelColors) ? payload.labelColors : []
  const rawColor = entry.labelColor ?? labelColors[index] ?? payload.labelColor ?? payload.color ?? ''
  const color = normalizeClipLabelColor(rawColor)
  if (rawColor && !color) {
    throw new Error('Invalid label color. Use a hex color like #f97316, or omit labelColor.')
  }
  return color
}

function getMcpBatchDuration(asset, payload = {}, entry = {}) {
  const requestedDuration = Number(entry.durationSeconds ?? entry.duration ?? payload.durationSeconds ?? payload.duration)
  if (Number.isFinite(requestedDuration) && requestedDuration > 0) return requestedDuration
  const assetDuration = Number(asset.duration ?? asset.settings?.duration) || 0
  return asset.type === 'image' ? 5 : (assetDuration || 5)
}

function buildMcpAssetBatchPlacementPlan(state, payload = {}) {
  const items = resolveMcpTimelineAssets(payload)
  if (items.length === 0) throw new Error('No assets were resolved for batch placement.')
  if (items.length > MCP_ASSET_BATCH_MAX_ITEMS) throw new Error(`Batch placement is limited to ${MCP_ASSET_BATCH_MAX_ITEMS} assets.`)

  const trackStrategy = normalizeMcpAssetBatchTrackStrategy(payload.trackStrategy || payload.placementTrack, items.length)
  const layout = normalizeMcpAssetBatchLayout(payload.layout || payload.placementLayout, trackStrategy)
  const includeLinkedAudio = shouldAddBatchLinkedVideoAudio(payload, layout)
  const spacingSeconds = Math.max(0, Number(payload.spacingSeconds ?? payload.spacing) || 0)
  const fps = Number(state.timelineFps) || 24
  const baseStartSeconds = resolveMcpAssetPlacementStart(state, String(payload.trackId || '').trim(), payload)
  const trackNamePrefix = String(payload.trackNamePrefix || payload.trackPrefix || 'MCP Review').trim() || 'MCP Review'
  const trackNameTemplate = payload.trackNameTemplate || payload.trackTemplate || ''
  const placements = []

  if (trackStrategy === 'single_track') {
    const targetTypes = [...new Set(items.map(({ asset }) => getCompatibleTrackTypeForAsset(asset)))]
    if (targetTypes.length !== 1 || !targetTypes[0]) {
      throw new Error('Single-track batch placement requires all assets to use the same compatible track type.')
    }

    const sharedTarget = resolveMcpTimelineTrack(state, items[0].asset, {
      ...payload,
      createTrack: payload.createTrack !== false && payload.newTrack !== false && !payload.trackId,
      newTrack: payload.createTrack !== false && payload.newTrack !== false && !payload.trackId,
    })
    const sharedPlannedTrack = sharedTarget.track || {
      id: null,
      name: String(payload.trackName || '').trim() || `${trackNamePrefix} Batch`,
      type: sharedTarget.targetType,
      locked: false,
      muted: false,
      visible: true,
      channels: sharedTarget.targetType === 'audio' ? normalizeAudioChannels(payload.channels) : null,
    }

    let cursor = baseStartSeconds
    for (let index = 0; index < items.length; index += 1) {
      const { asset, entry } = items[index]
      const durationSeconds = roundToTimelineFrame(getMcpBatchDuration(asset, payload, entry), fps)
      const startSeconds = layout === 'sequential' ? cursor : baseStartSeconds
      placements.push({
        index,
        asset,
        track: sharedPlannedTrack,
        createTrack: sharedTarget.createTrack,
        startSeconds,
        durationSeconds,
        linkedAudio: includeLinkedAudio
          ? buildLinkedAudioPlan(state, asset, { ...payload, includeAudio: true })
          : null,
        labelColor: getMcpBatchLabelColor(payload, entry, index),
        transform: entry.transform && typeof entry.transform === 'object'
          ? safeClone(entry.transform)
          : (payload.transform && typeof payload.transform === 'object' ? safeClone(payload.transform) : null),
      })
      cursor = roundToTimelineFrame(startSeconds + durationSeconds + spacingSeconds, fps)
    }
  } else {
    let cursor = baseStartSeconds
    for (let index = 0; index < items.length; index += 1) {
      const { asset, entry } = items[index]
      const targetType = getCompatibleTrackTypeForAsset(asset)
      const durationSeconds = roundToTimelineFrame(getMcpBatchDuration(asset, payload, entry), fps)
      const startSeconds = layout === 'sequential' ? cursor : baseStartSeconds
      const trackName = String(entry.trackName || '').trim()
        || formatMcpBatchTrackName(trackNameTemplate, asset, index, items.length, trackNamePrefix)
      placements.push({
        index,
        asset,
        track: {
          id: null,
          name: trackName,
          type: targetType,
          locked: false,
          muted: false,
          visible: true,
          channels: targetType === 'audio' ? normalizeAudioChannels(payload.channels) : null,
        },
        createTrack: true,
        startSeconds,
        durationSeconds,
        linkedAudio: includeLinkedAudio
          ? buildLinkedAudioPlan(state, asset, { ...payload, includeAudio: true })
          : null,
        labelColor: getMcpBatchLabelColor(payload, entry, index),
        transform: entry.transform && typeof entry.transform === 'object'
          ? safeClone(entry.transform)
          : (payload.transform && typeof payload.transform === 'object' ? safeClone(payload.transform) : null),
      })
      cursor = roundToTimelineFrame(startSeconds + durationSeconds + spacingSeconds, fps)
    }
  }

  return {
    action: 'add_assets_to_timeline',
    previewOnly: payload.previewOnly !== false,
    assetCount: placements.length,
    layout,
    trackStrategy,
    includeAudio: includeLinkedAudio,
    baseStartSeconds,
    spacingSeconds,
    resolveOverlaps: payload.resolveOverlaps !== false,
    selectAfterAdd: payload.selectAfterAdd !== false,
    placements: placements.map((placement) => ({
      ...placement,
      asset: summarizeAsset(placement.asset),
      track: summarizeTrack(placement.track),
    })),
    _runtimePlacements: placements,
  }
}

function handleAddAssetsToTimeline(payload = {}) {
  const initialState = useTimelineStore.getState()
  const plan = buildMcpAssetBatchPlacementPlan(initialState, payload)

  const publicPlan = {
    ...plan,
    _runtimePlacements: undefined,
  }
  delete publicPlan._runtimePlacements

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'add_assets_to_timeline',
      message: 'Batch asset placement plan only. No timeline change was made.',
      plan: publicPlan,
    }
  }

  const placements = plan._runtimePlacements || []
  if (placements.length === 0) throw new Error('No placements were available to apply.')

  const fps = Number(initialState.timelineFps) || 24
  const trackByPlacementIndex = new Map()
  const createdTracks = []
  const createdClips = []
  const labelColorByClipId = new Map()
  const linkedAudioByClipId = new Map()

  initialState.saveToHistory?.()

  if (plan.trackStrategy === 'single_track') {
    const firstPlacement = placements[0]
    let track = firstPlacement.track?.id
      ? (useTimelineStore.getState().tracks || []).find((candidate) => candidate.id === firstPlacement.track.id)
      : null
    if (!track) {
      track = useTimelineStore.getState().addTrack?.(firstPlacement.track.type, {
        name: firstPlacement.track.name,
        ...(firstPlacement.track.type === 'audio' ? { channels: firstPlacement.track.channels || 'stereo' } : {}),
      })
      if (!track) throw new Error('Could not create the batch placement track.')
      createdTracks.push(track)
    }
    placements.forEach((placement) => trackByPlacementIndex.set(placement.index, track))
  } else {
    const videoPlacements = placements
      .filter((placement) => placement.createTrack && placement.track?.type === 'video')
      .slice()
      .reverse()
    const audioPlacements = placements
      .filter((placement) => placement.createTrack && placement.track?.type === 'audio')

    for (const placement of [...videoPlacements, ...audioPlacements]) {
      const track = useTimelineStore.getState().addTrack?.(placement.track.type, {
        name: placement.track.name,
        ...(placement.track.type === 'audio' ? { channels: placement.track.channels || 'stereo' } : {}),
      })
      if (!track) throw new Error(`Could not create track for ${placement.asset?.name || placement.asset?.id || 'asset'}.`)
      createdTracks.push(track)
      trackByPlacementIndex.set(placement.index, track)
    }
  }

  const placementsWithLinkedAudio = placements.filter((placement) => (
    plan.includeAudio === true &&
    shouldAddLinkedVideoAudio(placement.asset, { ...payload, includeAudio: true })
  ))
  let sharedAudioTrack = null
  if (placementsWithLinkedAudio.length > 0 && plan.layout === 'sequential') {
    sharedAudioTrack = getAvailableMcpAudioTrack(useTimelineStore.getState())
    if (!sharedAudioTrack) {
      sharedAudioTrack = useTimelineStore.getState().addTrack?.('audio', {
        name: String(payload.audioTrackName || '').trim() || `${String(payload.trackNamePrefix || payload.trackPrefix || 'MCP Review').trim() || 'MCP Review'} Audio`,
        channels: normalizeAudioChannels(payload.channels),
      })
      if (!sharedAudioTrack) throw new Error('Could not create a linked audio track for the batch.')
      createdTracks.push(sharedAudioTrack)
    }
  }

  for (const placement of placements) {
    const track = trackByPlacementIndex.get(placement.index) || placement.track
    if (!track?.id) throw new Error(`No target track was available for ${placement.asset?.name || placement.asset?.id || 'asset'}.`)
    let audioTrack = null
    if (placementsWithLinkedAudio.includes(placement)) {
      if (plan.layout === 'sequential') {
        audioTrack = sharedAudioTrack
      } else {
        audioTrack = useTimelineStore.getState().addTrack?.('audio', {
          name: `${placement.track?.name || placement.asset?.name || 'MCP Review'} Audio`.slice(0, 100),
          channels: normalizeAudioChannels(payload.channels),
        })
        if (!audioTrack) throw new Error(`Could not create a linked audio track for ${placement.asset?.name || placement.asset?.id || 'asset'}.`)
        createdTracks.push(audioTrack)
      }
    }
    const linkGroupId = audioTrack ? makeMcpLinkGroupId(placement.asset, `batch-${placement.index + 1}`) : undefined
    const clip = useTimelineStore.getState().addClip?.(track.id, placement.asset, placement.startSeconds, fps, {
      saveHistory: false,
      selectAfterAdd: false,
      resolveOverlaps: plan.resolveOverlaps,
      duration: placement.durationSeconds,
      ...(linkGroupId ? { linkGroupId } : {}),
      ...(placement.transform ? { transform: safeClone(placement.transform) } : {}),
      metadata: {
        addedByMcp: true,
        addedAt: new Date().toISOString(),
        sourceTool: 'add_assets_to_timeline',
        batchIndex: placement.index,
        batchLayout: plan.layout,
      },
    })
    if (!clip) throw new Error(`Could not add ${placement.asset?.name || placement.asset?.id || 'asset'} to the timeline.`)
    createdClips.push(clip)
    if (placement.labelColor) labelColorByClipId.set(clip.id, placement.labelColor)
    if (audioTrack && linkGroupId) {
      const audioClip = useTimelineStore.getState().addClip?.(audioTrack.id, { ...placement.asset, type: 'audio' }, clip.startTime, fps, {
        saveHistory: false,
        linkGroupId,
        selectAfterAdd: false,
        resolveOverlaps: plan.layout === 'sequential' ? plan.resolveOverlaps : false,
        duration: clip.duration,
        metadata: {
          addedByMcp: true,
          addedAt: new Date().toISOString(),
          sourceTool: 'add_assets_to_timeline',
          batchIndex: placement.index,
          batchLayout: plan.layout,
          linkedVideoClipId: clip.id,
          embeddedAudioFromVideoAsset: true,
        },
      })
      if (audioClip) {
        createdClips.push(audioClip)
        linkedAudioByClipId.set(clip.id, audioClip.id)
      }
    }
  }

  if (createdClips.length > 0 && (labelColorByClipId.size > 0 || plan.selectAfterAdd)) {
    const createdClipIds = createdClips.map((clip) => clip.id)
    useTimelineStore.setState((state) => ({
      clips: labelColorByClipId.size > 0
        ? (state.clips || []).map((clip) => (
          labelColorByClipId.has(clip.id)
            ? { ...clip, labelColor: labelColorByClipId.get(clip.id) }
            : clip
        ))
        : state.clips,
      selectedClipIds: plan.selectAfterAdd ? createdClipIds : state.selectedClipIds,
    }))
  }

  const finalState = useTimelineStore.getState()
  const createdClipIds = new Set(createdClips.map((clip) => clip.id))
  const finalClips = (finalState.clips || []).filter((clip) => createdClipIds.has(clip.id))

  return {
    created: true,
    action: 'add_assets_to_timeline',
    assetCount: placements.length,
    clipCount: finalClips.length,
    linkedAudioClipCount: linkedAudioByClipId.size,
    trackCount: createdTracks.length,
    layout: plan.layout,
    trackStrategy: plan.trackStrategy,
    includeAudio: plan.includeAudio,
    clips: finalClips.map(summarizeClip),
    tracks: createdTracks.map(summarizeTrack),
  }
}

function handleDuplicateClip(payload = {}) {
  const state = useTimelineStore.getState()
  const clipId = String(payload.clipId || '').trim()
  if (!clipId) throw new Error('Provide clipId for the clip to duplicate.')

  const sourceClip = (state.clips || []).find((clip) => clip.id === clipId)
  if (!sourceClip) throw new Error(`Clip ${clipId} was not found.`)

  const targetTrackId = String(payload.trackId || '').trim() || sourceClip.trackId
  const targetTrack = (state.tracks || []).find((track) => track.id === targetTrackId)
  if (!targetTrack) throw new Error(`Track ${targetTrackId} was not found.`)
  if (targetTrack.locked) throw new Error(`Track ${targetTrackId} is locked.`)

  const sourceTrack = (state.tracks || []).find((track) => track.id === sourceClip.trackId)
  const sourceTrackType = sourceTrack?.type || (sourceClip.type === 'audio' ? 'audio' : 'video')
  const clipNeedsVideoTrack = ['video', 'image', 'text', 'shape', 'adjustment', 'caption', 'captions'].includes(sourceClip.type)
  const clipNeedsAudioTrack = sourceClip.type === 'audio'
  if (clipNeedsVideoTrack && targetTrack.type !== 'video') {
    throw new Error(`Clip ${clipId} is a ${sourceClip.type} clip and must be duplicated onto a video track.`)
  }
  if (clipNeedsAudioTrack && targetTrack.type !== 'audio') {
    throw new Error(`Clip ${clipId} is an audio clip and must be duplicated onto an audio track.`)
  }
  if (!clipNeedsVideoTrack && !clipNeedsAudioTrack && targetTrack.type !== sourceTrackType) {
    throw new Error(`Clip ${clipId} must be duplicated onto a ${sourceTrackType} track.`)
  }

  const fps = Number(state.timelineFps) || 24
  const requestedStart = Number(payload.startSeconds ?? payload.startTime)
  const startTime = roundToTimelineFrame(
    Number.isFinite(requestedStart)
      ? requestedStart
      : (Number(sourceClip.startTime) || 0) + (Number(sourceClip.duration) || 0) + 0.1,
    fps
  )
  const duration = Math.max(1 / fps, Number(sourceClip.duration) || (1 / fps))
  const nextCounter = getNextMcpClipCounter(state.clips, state.clipCounter)
  const nextName = String(payload.name || '').trim()
  const preserveLinkGroup = payload.preserveLinkGroup === true
  const preserveSyncLock = payload.preserveSyncLock === true
  const duplicate = {
    ...safeClone(sourceClip),
    id: `clip-${nextCounter}`,
    trackId: targetTrack.id,
    startTime,
    duration,
    name: nextName || sourceClip.name,
    selected: false,
    cacheStatus: 'none',
    cacheProgress: 0,
    cacheUrl: null,
    cachePath: null,
    ...(preserveLinkGroup ? {} : { linkGroupId: undefined }),
    ...(preserveSyncLock ? {} : { lockMode: undefined, syncLock: undefined }),
    metadata: {
      ...(safeClone(sourceClip.metadata) || {}),
      duplicatedFromClipId: sourceClip.id,
      duplicatedAt: new Date().toISOString(),
      duplicatedBy: 'mcp',
    },
  }

  if (duplicate.type === 'text' && nextName && duplicate.textProperties?.text) {
    duplicate.name = nextName
  }

  const preview = {
    source: buildTextClipSummary(sourceClip) || buildShapeClipSummary(sourceClip) || summarizeClip(sourceClip),
    duplicate: buildTextClipSummary(duplicate) || buildShapeClipSummary(duplicate) || summarizeClip(duplicate),
    targetTrack: summarizeTrack(targetTrack),
    preserveLinkGroup,
    preserveSyncLock,
  }

  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      action: 'duplicate_clip',
      message: 'Clip duplicate plan only. No timeline change was made.',
      plan: preview,
    }
  }

  state.saveToHistory?.()
  useTimelineStore.setState((currentState) => {
    const nextClips = [...(currentState.clips || []), duplicate]
    const maxEnd = nextClips.reduce((max, clip) => Math.max(max, (Number(clip.startTime) || 0) + (Number(clip.duration) || 0)), 0)
    return {
      clips: nextClips,
      clipCounter: Math.max(Number(currentState.clipCounter) || 1, nextCounter + 1),
      selectedClipIds: [duplicate.id],
      selectedTransitionId: null,
      selectedMarkerId: null,
      selectedGap: null,
      duration: Math.max(Number(currentState.duration) || 0, maxEnd + 10),
    }
  })

  const createdClip = (useTimelineStore.getState().clips || []).find((clip) => clip.id === duplicate.id) || duplicate
  return {
    created: true,
    action: 'duplicate_clip',
    sourceClipId: sourceClip.id,
    clip: buildTextClipSummary(createdClip) || summarizeClip(createdClip),
    targetTrack: summarizeTrack(targetTrack),
    preserveLinkGroup,
    preserveSyncLock,
  }
}

function handleAddTextClip(payload = {}) {
  const state = useTimelineStore.getState()
  const track = findDefaultTextTrack(state, payload.trackId)
  const textUpdates = normalizeTextStyleUpdates({ ...payload, text: payload.text ?? payload.content ?? 'Text' })
  const { updates: transformUpdates, deltas: transformDeltas } = normalizeTransformUpdates(payload)
  const keyframes = normalizeTextKeyframes(payload)
  const startSeconds = Number(payload.startSeconds ?? payload.startTime)
  const startTime = Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : Number(state.playheadPosition) || 0
  const duration = clampNumber(payload.durationSeconds ?? payload.duration, 5, 1 / (Number(state.timelineFps) || 24), 3600)

  const newClip = state.addTextClip?.(track.id, {
    ...textUpdates,
    duration,
    enabled: payload.enabled !== false,
  }, startTime)
  if (!newClip) throw new Error('Could not create text clip.')

  const nextTransform = resolveNextTransform(newClip.transform || {}, transformUpdates, transformDeltas)
  if (Object.keys(transformUpdates).length > 0 || Object.keys(transformDeltas).length > 0) {
    useTimelineStore.getState().updateClipTransform?.(newClip.id, nextTransform, false)
  }

  const presetId = String(payload.animationPreset || payload.presetId || '').trim()
  if (presetId && presetId !== 'none') {
    useTimelineStore.getState().applyTextAnimationPreset?.(newClip.id, presetId, payload.animationMode || payload.mode || 'inOut', { saveHistory: false })
  }
  const appliedKeyframes = applyTextKeyframes(useTimelineStore.getState(), newClip.id, keyframes, payload.replaceKeyframes === true)

  return {
    created: true,
    clip: buildTextClipSummary(getUpdatedTextClip(newClip.id)),
    track: { id: track.id, name: track.name, type: track.type },
    appliedKeyframes,
  }
}

function handleUpdateTextClip(payload = {}) {
  const state = useTimelineStore.getState()
  const currentClip = getTextClipById(state, payload.clipId)
  const textUpdates = normalizeTextStyleUpdates(payload)
  const { updates: transformUpdates, deltas: transformDeltas } = normalizeTransformUpdates(payload)
  const keyframes = normalizeTextKeyframes(payload)
  const clearKeyframes = payload.clearKeyframes || payload.clearKeyframesForProperties
  const presetId = String(payload.animationPreset || payload.presetId || '').trim()
  const clearAnimationPreset = payload.clearAnimationPreset === true || presetId === 'none'

  const hasStart = hasOwn(payload, 'startSeconds') || hasOwn(payload, 'startTime')
  const hasDuration = hasOwn(payload, 'durationSeconds') || hasOwn(payload, 'duration')
  const nextTrack = hasOwn(payload, 'trackId') ? findDefaultTextTrack(state, payload.trackId) : null
  const nextStart = hasStart
    ? Math.max(0, Number(payload.startSeconds ?? payload.startTime) || 0)
    : currentClip.startTime
  const nextDuration = hasDuration
    ? clampNumber(payload.durationSeconds ?? payload.duration, currentClip.duration || 5, 1 / (Number(state.timelineFps) || 24), 3600)
    : currentClip.duration
  const nextTransform = resolveNextTransform(currentClip.transform || {}, transformUpdates, transformDeltas)
  const nextClipPreview = {
    ...currentClip,
    trackId: nextTrack?.id || currentClip.trackId,
    startTime: nextStart,
    duration: nextDuration,
    textProperties: { ...(currentClip.textProperties || {}), ...textUpdates },
    transform: nextTransform,
  }

  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      clipId: currentClip.id,
      before: buildTextClipSummary(currentClip),
      after: buildTextClipSummary(nextClipPreview),
      requested: {
        textUpdates,
        transformUpdates,
        transformDeltas,
        keyframes,
        clearKeyframes,
        animationPreset: presetId || null,
        clearAnimationPreset,
      },
    }
  }

  state.saveToHistory?.()
  if (nextTrack || hasStart) {
    useTimelineStore.getState().moveClip?.(currentClip.id, nextTrack?.id || currentClip.trackId, nextStart, false)
  }
  if (hasDuration) {
    useTimelineStore.getState().resizeClip?.(currentClip.id, nextDuration)
  }
  if (Object.keys(textUpdates).length > 0) {
    useTimelineStore.getState().updateTextProperties?.(currentClip.id, textUpdates, false)
  }
  if (Object.keys(transformUpdates).length > 0 || Object.keys(transformDeltas).length > 0) {
    useTimelineStore.getState().updateClipTransform?.(currentClip.id, nextTransform, false)
  }
  const clearedKeyframes = clearTextKeyframes(currentClip.id, clearKeyframes)
  if (clearAnimationPreset) {
    useTimelineStore.getState().clearTextAnimationPreset?.(currentClip.id, { saveHistory: false })
  }
  if (presetId && !clearAnimationPreset) {
    useTimelineStore.getState().applyTextAnimationPreset?.(currentClip.id, presetId, payload.animationMode || payload.mode || 'inOut', { saveHistory: false })
  }
  const appliedKeyframes = applyTextKeyframes(useTimelineStore.getState(), currentClip.id, keyframes, payload.replaceKeyframes === true)

  return {
    updated: true,
    clip: buildTextClipSummary(getUpdatedTextClip(currentClip.id)),
    requested: {
      textUpdates,
      transformUpdates,
      transformDeltas,
      clearedKeyframes,
      appliedKeyframes,
      animationPreset: presetId || null,
      clearAnimationPreset,
    },
  }
}

function getUpdatedShapeClip(clipId) {
  return useTimelineStore.getState().clips.find((clip) => clip.id === clipId) || null
}

function handleAddShapeClip(payload = {}) {
  const state = useTimelineStore.getState()
  const track = findDefaultTextTrack(state, payload.trackId)
  const shapeUpdates = normalizeShapeStyleUpdates(payload)
  const shapeProperties = normalizeShapeProperties(shapeUpdates)
  const { updates: transformUpdates, deltas: transformDeltas } = normalizeTransformUpdates(payload)
  const startSeconds = Number(payload.startSeconds ?? payload.startTime)
  const startTime = Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : Number(state.playheadPosition) || 0
  const duration = clampNumber(payload.durationSeconds ?? payload.duration, 5, 1 / (Number(state.timelineFps) || 24), 3600)
  const keyframes = normalizeClipKeyframes(payload, { type: 'shape', duration })
  const name = String(payload.name || getShapeDisplayName(shapeProperties)).slice(0, 160)

  const newClip = state.addShapeClip?.(track.id, {
    name,
    shapeProperties,
    duration,
    enabled: payload.enabled !== false,
  }, startTime)
  if (!newClip) throw new Error('Could not create shape clip.')

  const nextTransform = resolveNextTransform(newClip.transform || {}, transformUpdates, transformDeltas)
  if (Object.keys(transformUpdates).length > 0 || Object.keys(transformDeltas).length > 0) {
    useTimelineStore.getState().updateClipTransform?.(newClip.id, nextTransform, false)
  }
  const appliedKeyframes = applyClipKeyframes(useTimelineStore.getState(), newClip.id, keyframes, payload.replaceKeyframes === true)

  return {
    created: true,
    clip: buildShapeClipSummary(getUpdatedShapeClip(newClip.id)),
    track: { id: track.id, name: track.name, type: track.type },
    appliedKeyframes,
  }
}

function handleUpdateShapeClip(payload = {}) {
  const state = useTimelineStore.getState()
  const currentClip = getShapeClipById(state, payload.clipId)
  const shapeUpdates = normalizeShapeStyleUpdates(payload)
  const { updates: transformUpdates, deltas: transformDeltas } = normalizeTransformUpdates(payload)
  const keyframes = normalizeClipKeyframes(payload, currentClip)
  const clearKeyframes = payload.clearKeyframes || payload.clearKeyframesForProperties
  const clearProperties = resolveClipKeyframeClearProperties(clearKeyframes, currentClip)

  const hasStart = hasOwn(payload, 'startSeconds') || hasOwn(payload, 'startTime')
  const hasDuration = hasOwn(payload, 'durationSeconds') || hasOwn(payload, 'duration')
  const nextTrack = hasOwn(payload, 'trackId') ? findDefaultTextTrack(state, payload.trackId) : null
  const nextStart = hasStart
    ? Math.max(0, Number(payload.startSeconds ?? payload.startTime) || 0)
    : currentClip.startTime
  const nextDuration = hasDuration
    ? clampNumber(payload.durationSeconds ?? payload.duration, currentClip.duration || 5, 1 / (Number(state.timelineFps) || 24), 3600)
    : currentClip.duration
  const currentShapeProperties = normalizeShapeProperties(currentClip.shapeProperties || {})
  const hasWidthUpdate = hasOwn(shapeUpdates, 'width')
  const hasHeightUpdate = hasOwn(shapeUpdates, 'height')
  const nextShapeInput = { ...currentShapeProperties, ...shapeUpdates }
  if (currentShapeProperties.shapeType === 'line' && shapeUpdates?.shapeType && shapeUpdates.shapeType !== 'line') {
    nextShapeInput.sizeLinked = DEFAULT_SHAPE_PROPERTIES.sizeLinked
    if (!hasWidthUpdate && !hasHeightUpdate) {
      nextShapeInput.width = DEFAULT_SHAPE_PROPERTIES.width
      nextShapeInput.height = DEFAULT_SHAPE_PROPERTIES.height
    } else if (hasWidthUpdate && !hasHeightUpdate) {
      nextShapeInput.height = nextShapeInput.sizeLinked
        ? Math.max(1, Number(shapeUpdates.width) || DEFAULT_SHAPE_PROPERTIES.height)
        : DEFAULT_SHAPE_PROPERTIES.height
    } else if (!hasWidthUpdate && hasHeightUpdate) {
      nextShapeInput.width = nextShapeInput.sizeLinked
        ? Math.max(1, Number(shapeUpdates.height) || DEFAULT_SHAPE_PROPERTIES.width)
        : DEFAULT_SHAPE_PROPERTIES.width
    }
  }
  const nextShapeProperties = normalizeShapeProperties(nextShapeInput)
  const nextTransform = resolveNextTransform(currentClip.transform || {}, transformUpdates, transformDeltas)
  const nextClipPreview = {
    ...currentClip,
    name: payload.name || currentClip.name,
    trackId: nextTrack?.id || currentClip.trackId,
    startTime: nextStart,
    duration: nextDuration,
    shapeProperties: nextShapeProperties,
    transform: nextTransform,
  }

  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      clipId: currentClip.id,
      before: buildShapeClipSummary(currentClip),
      after: buildShapeClipSummary(nextClipPreview),
      requested: {
        shapeUpdates,
        transformUpdates,
        transformDeltas,
        keyframes,
        clearKeyframes: clearProperties,
      },
    }
  }

  state.saveToHistory?.()
  if (nextTrack || hasStart) {
    useTimelineStore.getState().moveClip?.(currentClip.id, nextTrack?.id || currentClip.trackId, nextStart, false)
  }
  if (hasDuration) {
    useTimelineStore.getState().resizeClip?.(currentClip.id, nextDuration)
  }
  if (Object.keys(shapeUpdates).length > 0 || payload.name) {
    useTimelineStore.getState().updateShapeProperties?.(currentClip.id, { ...shapeUpdates, ...(payload.name ? { name: String(payload.name).slice(0, 160) } : {}) }, false)
  }
  if (Object.keys(transformUpdates).length > 0 || Object.keys(transformDeltas).length > 0) {
    useTimelineStore.getState().updateClipTransform?.(currentClip.id, nextTransform, false)
  }
  const clearedKeyframes = clearClipKeyframes(currentClip.id, clearProperties, currentClip)
  const appliedKeyframes = applyClipKeyframes(useTimelineStore.getState(), currentClip.id, keyframes, payload.replaceKeyframes === true)

  return {
    updated: true,
    clip: buildShapeClipSummary(getUpdatedShapeClip(currentClip.id)),
    requested: {
      shapeUpdates,
      transformUpdates,
      transformDeltas,
      clearedKeyframes,
      appliedKeyframes,
    },
  }
}

async function handleExportTimeline(payload = {}) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.runExportInWorker || !api?.pathJoin || !api?.createDirectory) {
    throw new Error('Timeline export is only available in the desktop app.')
  }

  const projectState = useProjectStore.getState()
  const timelineState = useTimelineStore.getState()
  const assetsState = useAssetsStore.getState()
  const projectPath = projectState.currentProjectHandle
  if (typeof projectPath !== 'string' || !projectPath) {
    throw new Error('Open a saved project before exporting.')
  }

  const project = projectState.currentProject || {}
  const timelineSettings = typeof projectState.getCurrentTimelineSettings === 'function'
    ? projectState.getCurrentTimelineSettings()
    : (project.settings || {})
  const timelineWidth = makeEvenDimension(timelineSettings?.width || payload.sourceTimelineWidth || payload.width || 1920)
  const timelineHeight = makeEvenDimension(timelineSettings?.height || payload.sourceTimelineHeight || payload.height || 1080)
  const fps = Math.max(1, Number(payload.fps || timelineSettings?.fps || timelineState.timelineFps || 24))
  const timelineEnd = typeof timelineState.getTimelineEndTime === 'function'
    ? timelineState.getTimelineEndTime()
    : Math.max(0, ...(timelineState.clips || []).map((clip) => (Number(clip.startTime) || 0) + (Number(clip.duration) || 0)))
  const rangeStart = Math.max(0, Number(payload.rangeStart) || 0)
  const rangeEnd = Math.max(rangeStart, Number(payload.rangeEnd) || timelineEnd)
  if (rangeEnd <= rangeStart) {
    throw new Error('Export range is empty.')
  }

  const format = String(payload.format || 'mp4').toLowerCase() === 'mp4' ? 'mp4' : 'mp4'
  const videoCodec = String(payload.videoCodec || 'h264').toLowerCase() === 'h265' ? 'h265' : 'h264'
  const outputExtension = 'mp4'
  const filename = sanitizeExportBaseName(payload.filename || `${project.name || 'ComfyStudio'}_export`)
  const outputFolder = await api.pathJoin(projectPath, 'renders')
  await api.createDirectory(outputFolder)
  const defaultOutputPath = await api.pathJoin(outputFolder, `${filename}_${Date.now()}.${outputExtension}`)
  const outputPath = String(payload.outputPath || '').trim() || defaultOutputPath

  const options = {
    filename,
    format,
    videoCodec,
    audioCodec: String(payload.audioCodec || 'aac').toLowerCase() || 'aac',
    proresProfile: '3',
    useHardwareEncoder: payload.useHardwareEncoder === true,
    nvencPreset: String(payload.nvencPreset || 'p5'),
    preset: String(payload.preset || 'medium'),
    qualityMode: String(payload.qualityMode || 'crf').toLowerCase() === 'bitrate' ? 'bitrate' : 'crf',
    crf: Number.isFinite(Number(payload.crf)) ? Number(payload.crf) : 18,
    bitrateKbps: Number.isFinite(Number(payload.bitrateKbps)) ? Number(payload.bitrateKbps) : 8000,
    keyframeInterval: null,
    width: makeEvenDimension(payload.width || 1920),
    height: makeEvenDimension(payload.height || 1080),
    sourceTimelineWidth: timelineWidth,
    sourceTimelineHeight: timelineHeight,
    fps,
    rangeStart,
    rangeEnd,
    includeAudio: payload.includeAudio !== false,
    audioBitrateKbps: Number.isFinite(Number(payload.audioBitrateKbps)) ? Number(payload.audioBitrateKbps) : 192,
    audioSampleRate: Number.isFinite(Number(payload.audioSampleRate)) ? Number(payload.audioSampleRate) : 44100,
    audioChannels: Number.isFinite(Number(payload.audioChannels)) ? Number(payload.audioChannels) : 2,
    normalizeAudio: payload.includeAudio !== false && payload.normalizeAudio === true,
    loudnessTarget: Number.isFinite(Number(payload.loudnessTarget)) ? Number(payload.loudnessTarget) : -14,
    useCachedRenders: false,
    useProxyMedia: payload.useProxyMedia === true,
    fastSeek: false,
    useDirectFramePipe: payload.useDirectFramePipe !== false,
    deliveryFraming: ['fill', 'cover', 'center_crop', 'center-crop'].includes(String(payload.deliveryFraming || payload.framing || '').toLowerCase())
      ? 'fill'
      : 'fit',
    outputPath,
  }

  const assets = Array.isArray(assetsState.assets) ? assetsState.assets : []
  const result = await api.runExportInWorker({
    projectPath,
    outputPath,
    options,
    state: {
      timeline: {
        clips: timelineState.clips || [],
        tracks: timelineState.tracks || [],
        transitions: timelineState.transitions || [],
      },
      assets: assets.map((asset) => ({
        id: asset.id,
        path: asset.path,
        type: asset.type,
        name: asset.name,
        isImported: asset.isImported,
        settings: asset.settings,
        duration: asset.duration,
        proxyPath: asset.proxyPath,
        proxyStatus: asset.proxyStatus,
        maskFrames: asset.maskFrames?.map((frame) => ({ ...frame, url: undefined })),
      })),
    },
  })

  if (result?.success === false || result?.error) {
    throw new Error(result.error || 'Export failed to start.')
  }

  return {
    started: true,
    outputPath,
    options: {
      filename,
      format,
      videoCodec,
      audioCodec: options.audioCodec,
      width: options.width,
      height: options.height,
      fps: options.fps,
      rangeStart,
      rangeEnd,
      includeAudio: options.includeAudio,
      useHardwareEncoder: options.useHardwareEncoder,
      useProxyMedia: options.useProxyMedia,
      deliveryFraming: options.deliveryFraming,
      crf: options.crf,
      qualityMode: options.qualityMode,
    },
    worker: result,
  }
}

async function handleSetComfyUIConnection(payload = {}) {
  const port = payload?.port ?? payload?.httpBase ?? payload?.url
  const result = await saveLocalComfyConnectionPort(port)
  if (!result?.success) {
    throw new Error(result?.error || 'Could not update local ComfyUI connection.')
  }
  return {
    updated: true,
    config: result.config,
  }
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function getNumberPayloadValue(payload, key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(payload?.[key])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

async function handleInspectTimelineFrame(payload = {}) {
  const state = useTimelineStore.getState()
  const requestedTime = Number(payload.timeSeconds)
  const timeSeconds = Number.isFinite(requestedTime)
    ? requestedTime
    : Number(state.playheadPosition) || 0
  const includeImage = payload.includeImage !== false
  const maxImageBytes = getNumberPayloadValue(payload, 'maxImageBytes', 4 * 1024 * 1024, 1, 12 * 1024 * 1024)
  const maxWidth = getNumberPayloadValue(payload, 'maxWidth', 1280, 16, 3840)
  const maxHeight = getNumberPayloadValue(payload, 'maxHeight', 720, 16, 2160)
  const requestedMimeType = String(payload.mimeType || 'image/jpeg').toLowerCase()
  const mimeType = requestedMimeType === 'image/png' || requestedMimeType === 'image/webp'
    ? requestedMimeType
    : 'image/jpeg'
  const quality = getNumberPayloadValue(payload, 'quality', 0.86, 0.1, 1)

  const captured = await captureTimelineFrameAt(timeSeconds, {
    maxWidth,
    maxHeight,
    mimeType,
    quality,
    createBlobUrl: false,
  })

  if (!captured?.file) {
    return {
      success: false,
      timeSeconds,
      warning: 'No visual timeline frame could be captured at this time.',
    }
  }

  if (!includeImage) {
    return {
      success: true,
      timeSeconds,
      width: captured.width,
      height: captured.height,
      mimeType: captured.mimeType || captured.file.type || mimeType,
      size: captured.file.size,
      image: null,
    }
  }

  if (captured.file.size > maxImageBytes) {
    return {
      success: false,
      timeSeconds,
      width: captured.width,
      height: captured.height,
      mimeType: captured.mimeType || captured.file.type || mimeType,
      size: captured.file.size,
      warning: `Captured frame is ${captured.file.size} bytes, above the ${maxImageBytes} byte MCP embed limit.`,
    }
  }

  return {
    success: true,
    timeSeconds,
    width: captured.width,
    height: captured.height,
    mimeType: captured.mimeType || captured.file.type || mimeType,
    size: captured.file.size,
    image: {
      type: 'image',
      data: await blobToBase64(captured.file),
      mimeType: captured.mimeType || captured.file.type || mimeType,
    },
  }
}

async function canvasToBlob(canvas, mimeType = 'image/jpeg', quality = 0.84) {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), mimeType, quality))
}

async function blobToImageBitmap(blob) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob)
  }

  const objectUrl = URL.createObjectURL(blob)
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = reject
      img.src = objectUrl
    })
    return image
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

async function createRangeContactSheet(captures = [], options = {}) {
  const columns = Math.max(1, Math.min(4, Math.floor(Number(options.columns) || 3)))
  const cellWidth = Math.max(160, Math.min(960, Math.floor(Number(options.cellWidth) || 480)))
  const cellHeight = Math.max(90, Math.min(540, Math.floor(Number(options.cellHeight) || 270)))
  const labelHeight = 30
  const rows = Math.max(1, Math.ceil(Math.max(1, captures.length) / columns))
  const width = columns * cellWidth
  const height = rows * (cellHeight + labelHeight)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return null

  ctx.fillStyle = '#070709'
  ctx.fillRect(0, 0, width, height)
  ctx.font = '12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.textBaseline = 'middle'

  for (let index = 0; index < captures.length; index += 1) {
    const item = captures[index]
    const column = index % columns
    const row = Math.floor(index / columns)
    const x = column * cellWidth
    const y = row * (cellHeight + labelHeight)
    const label = item?.label || `Sample ${index + 1}`

    ctx.fillStyle = '#101014'
    ctx.fillRect(x, y, cellWidth, cellHeight + labelHeight)
    ctx.strokeStyle = '#2a2d36'
    ctx.strokeRect(x + 0.5, y + 0.5, cellWidth - 1, cellHeight + labelHeight - 1)

    if (item?.file) {
      try {
        const bitmap = await blobToImageBitmap(item.file)
        const sourceWidth = bitmap.width || item.width || cellWidth
        const sourceHeight = bitmap.height || item.height || cellHeight
        const scale = Math.min(cellWidth / sourceWidth, cellHeight / sourceHeight)
        const drawWidth = Math.max(1, Math.round(sourceWidth * scale))
        const drawHeight = Math.max(1, Math.round(sourceHeight * scale))
        const drawX = x + Math.round((cellWidth - drawWidth) / 2)
        const drawY = y + Math.round((cellHeight - drawHeight) / 2)
        ctx.drawImage(bitmap, drawX, drawY, drawWidth, drawHeight)
        bitmap.close?.()
      } catch (error) {
        ctx.fillStyle = '#19191f'
        ctx.fillRect(x, y, cellWidth, cellHeight)
        ctx.fillStyle = '#fca5a5'
        ctx.fillText('Frame capture failed', x + 12, y + Math.round(cellHeight / 2))
      }
    } else {
      ctx.fillStyle = '#19191f'
      ctx.fillRect(x, y, cellWidth, cellHeight)
      ctx.fillStyle = '#9ca3af'
      ctx.fillText(item?.warning || 'No visual frame', x + 12, y + Math.round(cellHeight / 2))
    }

    const labelY = y + cellHeight
    ctx.fillStyle = 'rgba(0, 0, 0, 0.82)'
    ctx.fillRect(x, labelY, cellWidth, labelHeight)
    ctx.fillStyle = '#f8fafc'
    ctx.fillText(label, x + 10, labelY + Math.round(labelHeight / 2))
  }

  const mimeType = String(options.mimeType || 'image/jpeg').toLowerCase() === 'image/png'
    ? 'image/png'
    : 'image/jpeg'
  const quality = getNumberPayloadValue(options, 'quality', 0.84, 0.1, 1)
  const blob = await canvasToBlob(canvas, mimeType, quality)
  if (!blob) return null
  return {
    file: new File([blob], `timeline_range_${Date.now()}.${mimeType === 'image/png' ? 'png' : 'jpg'}`, { type: mimeType }),
    width,
    height,
    mimeType,
  }
}

async function handleInspectTimelineRange(payload = {}) {
  const samples = Array.isArray(payload.samples) ? payload.samples : []
  const includeImage = payload.includeImage !== false
  const returnMode = String(payload.returnMode || 'contact_sheet').toLowerCase()
  const maxImageBytes = getNumberPayloadValue(payload, 'maxImageBytes', 6 * 1024 * 1024, 1, 16 * 1024 * 1024)
  const maxWidth = getNumberPayloadValue(payload, 'maxWidth', 640, 16, 1920)
  const maxHeight = getNumberPayloadValue(payload, 'maxHeight', 360, 16, 1080)
  const mimeType = String(payload.mimeType || 'image/jpeg').toLowerCase() === 'image/png'
    ? 'image/png'
    : 'image/jpeg'
  const quality = getNumberPayloadValue(payload, 'quality', 0.82, 0.1, 1)

  if (samples.length === 0) {
    return {
      success: false,
      warning: 'No range samples were provided.',
      samples: [],
    }
  }

  const captures = []
  for (const [index, sample] of samples.entries()) {
    const timeSeconds = Number(sample?.timeSeconds)
    const safeTimeSeconds = Number.isFinite(timeSeconds) ? timeSeconds : 0
    const captured = await captureTimelineFrameAt(safeTimeSeconds, {
      maxWidth,
      maxHeight,
      mimeType,
      quality,
      createBlobUrl: false,
    })

    captures.push({
      index,
      timeSeconds: safeTimeSeconds,
      timecode: sample?.timecode || '',
      label: sample?.label || `${index + 1}. ${sample?.timecode || `${safeTimeSeconds.toFixed(2)}s`}`,
      success: Boolean(captured?.file),
      file: captured?.file || null,
      width: captured?.width || null,
      height: captured?.height || null,
      mimeType: captured?.mimeType || mimeType,
      size: captured?.file?.size || 0,
      warning: captured?.file ? '' : 'No visual timeline frame could be captured at this time.',
    })
  }

  const resultSamples = captures.map((capture) => ({
    index: capture.index,
    timeSeconds: capture.timeSeconds,
    timecode: capture.timecode,
    label: capture.label,
    success: capture.success,
    width: capture.width,
    height: capture.height,
    mimeType: capture.mimeType,
    size: capture.size,
    warning: capture.warning,
  }))

  const result = {
    success: captures.some((capture) => capture.success),
    sampleCount: captures.length,
    capturedCount: captures.filter((capture) => capture.success).length,
    samples: resultSamples,
    contactSheet: null,
    frames: [],
  }

  if (!includeImage) return result

  if (returnMode !== 'frames') {
    const sheet = await createRangeContactSheet(captures, {
      columns: payload.columns,
      cellWidth: maxWidth,
      cellHeight: maxHeight,
      mimeType,
      quality,
    })
    if (sheet?.file) {
      if (sheet.file.size <= maxImageBytes) {
        result.contactSheet = {
          type: 'image',
          data: await blobToBase64(sheet.file),
          mimeType: sheet.mimeType,
          width: sheet.width,
          height: sheet.height,
          size: sheet.file.size,
        }
      } else {
        result.contactSheetWarning = `Contact sheet is ${sheet.file.size} bytes, above the ${maxImageBytes} byte MCP embed limit.`
      }
    }
  }

  if (returnMode === 'frames' || returnMode === 'both') {
    for (const capture of captures) {
      if (!capture.file || capture.file.size > maxImageBytes) continue
      result.frames.push({
        type: 'image',
        data: await blobToBase64(capture.file),
        mimeType: capture.mimeType,
        index: capture.index,
        timeSeconds: capture.timeSeconds,
        timecode: capture.timecode,
        width: capture.width,
        height: capture.height,
        size: capture.size,
      })
    }
  }

  return result
}

async function handleMcpAction(request = {}) {
  switch (request.action) {
    case 'set_clip_label_color':
      return handleSetClipLabelColor(request.payload || {})
    case 'set_clips_enabled':
      return handleSetClipsEnabled(request.payload || {})
    case 'prepare_generation_from_timeline_context':
      return handlePrepareGenerationFromTimelineContext(request.payload || {})
    case 'queue_prepared_generation':
      return handleQueuePreparedGeneration(request.payload || {})
    case 'queue_timeline_generation_batch':
      return handleQueueTimelineGenerationBatch(request.payload || {})
    case 'queue_prompt_generation_batch':
      return handleQueuePromptGenerationBatch(request.payload || {})
    case 'inspect_timeline_frame':
      return handleInspectTimelineFrame(request.payload || {})
    case 'inspect_timeline_range':
      return handleInspectTimelineRange(request.payload || {})
    case 'add_timeline_markers':
      return handleAddTimelineMarkers(request.payload || {})
    case 'remove_timeline_markers':
      return handleRemoveTimelineMarkers(request.payload || {})
    case 'set_timeline_marker_properties':
      return handleSetTimelineMarkerProperties(request.payload || {})
    case 'create_timeline':
      return handleCreateTimeline(request.payload || {})
    case 'create_asset_folder':
      return handleCreateAssetFolder(request.payload || {})
    case 'move_assets_to_folder':
      return handleMoveAssetsToFolder(request.payload || {})
    case 'add_track':
      return handleAddTrack(request.payload || {})
    case 'add_asset_to_timeline':
      return handleAddAssetToTimeline(request.payload || {})
    case 'add_assets_to_timeline':
      return handleAddAssetsToTimeline(request.payload || {})
    case 'add_solid_color':
      return handleAddSolidColor(request.payload || {})
    case 'duplicate_clip':
      return handleDuplicateClip(request.payload || {})
    case 'add_text_clip':
      return handleAddTextClip(request.payload || {})
    case 'update_text_clip':
      return handleUpdateTextClip(request.payload || {})
    case 'add_shape_clip':
      return handleAddShapeClip(request.payload || {})
    case 'update_shape_clip':
      return handleUpdateShapeClip(request.payload || {})
    case 'set_clip_keyframes':
      return handleSetClipKeyframes(request.payload || {})
    case 'set_comfyui_connection':
      return handleSetComfyUIConnection(request.payload || {})
    case 'export_timeline':
      return handleExportTimeline(request.payload || {})
    default:
      throw new Error(`Unknown MCP action: ${request.action || 'unknown'}`)
  }
}

export function startMcpActionBridge() {
  const api = typeof window !== 'undefined' ? window.electronAPI?.mcp : null
  if (!api?.onAction || !api?.sendActionResult) return () => {}

  return api.onAction(async (request = {}) => {
    try {
      const result = await handleMcpAction(request)
      api.sendActionResult({ id: request.id, success: true, result })
    } catch (error) {
      api.sendActionResult({
        id: request.id,
        success: false,
        error: error?.message || String(error),
      })
    }
  })
}
