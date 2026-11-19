'use strict'

// Host-owned permission classification, deliberately narrower than the MCP
// catalog. Audited handlers use timelineStore history or atomic native editing
// plans (mcpActions / mcpEditingParity / mcpAudioParity). They do not import,
// generate, render caches, save projects, delete source files or execute code.
// Unknown tools, operations, fields and nested fields always require approval.
// Keep this independent of model-supplied annotations or live schema expansion.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const number = value => typeof value === 'number' && Number.isFinite(value)
const boolean = value => typeof value === 'boolean'
const string = value => typeof value === 'string' && value.length <= 12000
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512
const oneOf = values => value => values.includes(value)
const array = (check, limit = 1000) => value => Array.isArray(value) && value.length <= limit && value.every(check)
const shape = rules => value => object(value) && Object.entries(value).every(([key, item]) => Object.hasOwn(rules, key) && rules[key](item))
const numericMap = keys => shape(Object.fromEntries(keys.map(key => [key, number])))
const fields = (names, check) => Object.fromEntries(names.split(' ').filter(Boolean).map(name => [name, check]))
const controls = { previewOnly: boolean, previewToken: id, expectedContext: object }
const clipIds = { clipId: id, clipIds: array(id) }
const targets = { ...clipIds, filter: oneOf(['selected', 'disabled', 'enabled', 'visual', 'audio', 'labeled', 'colored']),
  selected: boolean, trackId: id, type: string, nameIncludes: string, limit: number }
const markerTargets = { all: boolean, markerIds: array(id), color: string, labelContains: string,
  startSeconds: number, endSeconds: number, limit: number }
const transformNumbers = 'positionX positionY positionZ scaleX scaleY rotation rotationX rotationY perspective anchorX anchorY opacity blur cropTop cropBottom cropLeft cropRight motionBlurSamples motionBlurShutter cornerPinTLX cornerPinTLY cornerPinTRX cornerPinTRY cornerPinBLX cornerPinBLY cornerPinBRX cornerPinBRY'.split(' ')
const transformRules = { ...Object.fromEntries(transformNumbers.map(key => [key, number])),
  ...fields('scaleLinked flipH flipV motionBlurEnabled cornerPinEnabled', boolean), blendMode: string,
  motionBlurMode: oneOf(['auto', 'velocity', 'sampled']), motionPathMode: oneOf(['linear', 'smooth']) }
const colorNumbers = 'brightness contrast exposure saturation temperature tint hue gain gamma offset'.split(' ')
const colorRules = { ...Object.fromEntries(colorNumbers.map(key => [key, number])),
  ...Object.fromEntries(['shadows', 'midtones', 'highlights'].map(key => [key, numericMap(colorNumbers)])) }
const updateRules = { ...transformRules,
  ...Object.fromEntries(colorNumbers.map(key => [`color.${key}`, number])),
  ...Object.fromEntries(['shadows', 'midtones', 'highlights'].flatMap(group => colorNumbers.map(key => [`color.${group}.${key}`, number]))),
  'effects.blur': number }
const colorInputs = { adjustments: shape(colorRules), color: shape(colorRules), updates: shape(updateRules) }
const editTiming = { clipId: id, ...fields('startSeconds durationSeconds trimStartSeconds trimEndSeconds', number) }
const safeEffectTypes = ['cameraShake', 'gaussianBlur', 'directionalBlur', 'chromaticAberration', 'sharpen']
const effectSettings = { cameraShake: ['intensity', 'speed', 'rotation'], gaussianBlur: ['amount'],
  directionalBlur: ['amount', 'angle', 'samples'], chromaticAberration: ['amount', 'angle'], sharpen: ['amount'] }
const effectGroup = shape({ key: id, type: oneOf(safeEffectTypes), ordinal: number,
  members: array(shape({ clipId: id, effectId: id })), repeated: boolean })
const effectRule = value => {
  const type = value.effectType || value.group?.type
  return safeEffectTypes.includes(type)
    // The native resolver prioritizes effectId over an advertised effectType.
    // Only a validated typed group binds IDs to that known built-in type.
    && (!value.group || value.group.type === type)
    && (!value.effectId || value.group?.type === type)
    && shape({ ...targets, ...controls, action: oneOf(['add', 'update', 'remove', 'enabled', 'reset']),
      effectType: oneOf(safeEffectTypes), effectId: id, ordinal: number, group: effectGroup,
      settings: numericMap(effectSettings[type]), enabled: boolean })(value)
    && ['add', 'update', 'remove', 'enabled', 'reset'].includes(value.action)
}
const keyframeProperties = [...transformNumbers, ...colorNumbers,
  'width', 'height', 'fillOpacity', 'gradientAngle', 'gradientCenterX', 'gradientCenterY', 'gradientRadius',
  'strokeWidth', 'strokeOpacity', 'cornerRadius', 'sides', 'speed',
  ...['shadows', 'midtones', 'highlights'].flatMap(group => colorNumbers.map(key => `${group}.${key}`))]
const rules = {
  add_timeline_markers: shape({ ...controls, ...fields('timeSeconds frame limit', number), ...fields('label color', string),
    markers: array(shape({ ...fields('timeSeconds time frame', number), ...fields('label name color', string) })) }),
  remove_timeline_markers: shape({ ...controls, ...markerTargets }),
  set_timeline_marker_properties: shape({ ...controls, ...markerTargets, ...fields('label newColor setColor', string), ...fields('timeSeconds frame timeOffsetSeconds', number) }),
  add_track: shape({ ...controls, type: oneOf(['video', 'audio']), name: string, channels: oneOf(['mono', 'stereo']) }),
  update_track: shape({ ...controls, trackId: id, name: string, ...fields('muted solo locked visible', boolean),
    ...fields('volume pan index newIndex', number), channels: oneOf(['mono', 'stereo']) }),
  remove_track: shape({ ...controls, trackId: id }),
  split_clip: shape({ ...controls, ...clipIds, timeSeconds: number }),
  set_clip_speed: shape({ ...controls, ...clipIds, speed: number, reverse: boolean }),
  set_clip_audio: shape({ ...controls, ...clipIds, ...fields('gainDb fadeInSeconds fadeOutSeconds fadeIn fadeOut', number),
    resetEnvelope: boolean, resetEq: boolean,
    volumeEnvelope: shape({ version: oneOf([1]), offsetSeconds: number, points: array(shape({ id, time: number, db: number }), 128) }),
    audioEq: shape({ version: oneOf([1]), enabled: boolean, lowCut: boolean, ...fields('bassDb midDb trebleDb', number) }) }),
  set_clip_label_color: shape({ ...controls, clipIds: array(id), color: string, filter: string, limit: number }),
  set_clips_enabled: shape({ ...controls, clipIds: array(id), enabled: boolean, filter: string, limit: number }),
  move_clips: shape({ ...controls, clipId: id, trackId: id, startSeconds: number, startTime: number, resolveOverlaps: boolean,
    clips: array(shape({ clipId: id, trackId: id, startSeconds: number, startTime: number }), 100) }),
  trim_clips: shape({ ...controls, ...editTiming, clips: array(shape(editTiming), 100) }),
  edit_trim: shape({ ...controls, ...clipIds, clipAId: id, clipBId: id, targetClipIds: array(id),
    mode: oneOf(['normal', 'roll', 'slip', 'slide', 'ripple']), edge: oneOf(['start', 'end', 'left', 'right']), deltaSeconds: number }),
  delete_clips: shape({ ...controls, ...clipIds, filter: oneOf(['disabled', 'selected', 'labeled']), ripple: boolean, limit: number }),
  duplicate_clip: shape({ ...controls, clipId: id, trackId: id, startSeconds: number, startTime: number, name: string,
    preserveLinkGroup: boolean, preserveSyncLock: boolean }),
  set_clip_style: shape({ ...controls, ...targets, ...transformRules, ...colorInputs,
    transform: shape(transformRules), transformDelta: numericMap(transformNumbers), enabled: boolean, labelColor: string,
    trackMatte: oneOf(['none', 'alpha', 'alpha-inverted', 'luma', 'luma-inverted']), bypass: shape(fields('mask color effects', boolean)) }),
  set_clip_color: shape({ ...controls, ...targets, ...colorInputs }),
  edit_clip_effects: effectRule,
  set_clip_keyframes: shape({ ...controls, clipId: id, replaceKeyframes: boolean,
    clearKeyframes: value => boolean(value) || value === 'all' || array(oneOf(keyframeProperties))(value),
    keyframes: array(shape({ property: oneOf(keyframeProperties), timeSeconds: number, value: number, easing: string })) }),
}

function isAutoApprovableEdit(name, args) {
  if (!object(args) || args.previewOnly !== false || !Object.hasOwn(rules, name) || !rules[name](args)) return false
  // A real local-model stress run broadened one requested clip label into an
  // `enabled` filter covering the whole timeline. Keep that capability, but
  // auto-approval requires the precise IDs already returned by inspection.
  if (name === 'set_clip_label_color') return Array.isArray(args.clipIds) && args.clipIds.length > 0
  return true
}

module.exports = { isAutoApprovableEdit, AUTO_APPROVED_EDIT_TOOLS: Object.freeze(Object.keys(rules)) }
