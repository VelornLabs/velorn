import { getMultiClipSelection } from './multiClipInspector.js'

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = value => typeof value === 'string' && value.trim().length > 0
const equal = (a, b) => typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-7 : a === b
const effectsOf = clip => Array.isArray(clip?.effects) ? clip.effects : []
const activeKeys = clip => Object.entries(clip.keyframes || {}).filter(([, frames]) => Array.isArray(frames) && frames.length > 0)
const animatedReason = 'Animated effect property — select one clip to edit its keyframes.'
const staleReason = 'The selected effects changed. Select the shared effect again.'

// The caller injects the registry: this pure selection/planning module does not
// import renderer-dependent shader or keyframe services.
function definitionFor(type, getDefinition) {
  if (!validId(type) || typeof getDefinition !== 'function') return null
  const definition = getDefinition(type)
  return definition?.id === type && Array.isArray(definition.params) ? definition : null
}

function effectIndex(clip) {
  const effects = effectsOf(clip)
  const idCounts = new Map()
  for (const effect of effects) {
    if (validId(effect?.id)) idCounts.set(effect.id, (idCounts.get(effect.id) || 0) + 1)
  }
  const types = new Map()
  for (const effect of effects) {
    if (!validId(effect?.type)) continue
    if (!types.has(effect.type)) types.set(effect.type, [])
    types.get(effect.type).push(effect)
  }
  return { effects, types, valid: effect => validId(effect?.id) && idCounts.get(effect.id) === 1 }
}

/**
 * Match exact persisted types, never display labels. Repeated effects are only
 * shared when every editable clip has the same count; ordinal matching in an
 * uneven stack could accidentally combine unrelated creative operations.
 */
export function getMultiClipEffectGroups(selection, getDefinition) {
  const clips = selection?.visual || []
  if (!clips.length) return []
  const indices = clips.map(effectIndex)
  const usableTypes = new Map()
  for (const [type, effects] of indices[0].types) {
    const definition = definitionFor(type, getDefinition)
    if (!definition) continue
    if (!indices.every(index => {
      const members = index.types.get(type)
      return members?.length === effects.length && members.every(index.valid)
    })) continue
    usableTypes.set(type, definition)
  }
  const occurrences = new Map()
  const groups = []
  for (const effect of indices[0].effects) {
    const definition = usableTypes.get(effect?.type)
    if (!definition) continue
    const ordinal = occurrences.get(effect.type) || 0
    occurrences.set(effect.type, ordinal + 1)
    groups.push({
      key: `${effect.type}:${ordinal}`,
      type: effect.type,
      ordinal,
      repeated: indices[0].types.get(effect.type).length > 1,
      definition,
      effect,
      members: clips.map((clip, index) => ({ clipId: clip.id, effectId: indices[index].types.get(effect.type)[ordinal].id })),
    })
  }
  return groups
}

function resolveGroup(selection, snapshot, getDefinition) {
  if (!isObject(snapshot) || !Number.isInteger(snapshot.ordinal) || snapshot.ordinal < 0 || !Array.isArray(snapshot.members)) return null
  const current = getMultiClipEffectGroups(selection, getDefinition).find(group => group.key === snapshot.key && group.type === snapshot.type && group.ordinal === snapshot.ordinal)
  if (!current || current.members.length !== snapshot.members.length) return null
  const requested = new Map()
  for (const member of snapshot.members) {
    if (!validId(member?.clipId) || !validId(member?.effectId) || requested.has(member.clipId)) return null
    requested.set(member.clipId, member.effectId)
  }
  if (!current.members.every(member => requested.get(member.clipId) === member.effectId)) return null
  return current
}

function targetsFor(selection, group) {
  const byId = new Map(selection.visual.map(clip => [clip.id, clip]))
  return group.members.map(member => {
    const clip = byId.get(member.clipId)
    return { clip, effect: effectsOf(clip).find(effect => effect?.id === member.effectId) }
  })
}

function readParam(effect, param, definition) {
  const incoming = hasOwn(effect.settings || {}, param.key) ? effect.settings[param.key] : definition.defaults?.[param.key]
  if (param.type === 'toggle') return incoming ? 1 : 0
  const parsed = Number(incoming)
  const fallback = Number(definition.defaults?.[param.key])
  const value = Number.isFinite(parsed) ? parsed : Number.isFinite(fallback) ? fallback : 0
  return Math.max(param.min ?? -Infinity, Math.min(param.max ?? Infinity, value))
}

/** keys=null protects removal, including unknown/future animated parameters. */
export function getMultiClipEffectOperationBlock(selection, snapshot, keys, getDefinition) {
  if (!selection?.visual?.length) return 'No editable visual clips selected.'
  const group = resolveGroup(selection, snapshot, getDefinition)
  if (!group) return staleReason
  if (keys != null && (!Array.isArray(keys) || keys.some(key => !group.definition.params.some(param => param.key === key)))) return 'Unsupported effect property.'
  for (const { clip, effect } of targetsFor(selection, group)) {
    const prefix = `effect.${effect.id}.`
    if (activeKeys(clip).some(([property]) => keys == null ? property.startsWith(prefix) : keys.some(key => property === `${prefix}${key}`))) return animatedReason
  }
  return ''
}

export function getMultiClipEffectFieldState(selection, snapshot, property, getDefinition) {
  const empty = blockedReason => ({ values: [], value: null, mixed: false, blockedReason })
  if (!selection?.visual?.length) return empty('No editable visual clips selected.')
  const group = resolveGroup(selection, snapshot, getDefinition)
  if (!group) return empty(staleReason)
  const param = group.definition.params.find(item => item.key === property)
  if (property !== 'enabled' && !param) return empty('Unsupported effect property.')
  const targets = targetsFor(selection, group)
  const values = targets.map(({ effect }) => property === 'enabled' ? effect.enabled !== false : readParam(effect, param, group.definition))
  const mixed = values.some(value => !equal(value, values[0]))
  return {
    param,
    targets,
    values,
    value: mixed ? null : values[0],
    mixed,
    blockedReason: property === 'enabled' ? '' : getMultiClipEffectOperationBlock(selection, group, [property], getDefinition),
  }
}

function validatedSettings(settings, definition) {
  if (!isObject(settings)) return { error: 'Invalid effect settings.' }
  const values = {}
  for (const [key, incoming] of Object.entries(settings)) {
    const param = definition.params.find(item => item.key === key)
    if (!param || ['__proto__', 'constructor', 'prototype'].includes(key)) return { error: 'Unsupported effect property.' }
    if ((typeof incoming !== 'number' && typeof incoming !== 'string') || String(incoming).trim() === '' || !Number.isFinite(Number(incoming))) return { error: 'Enter a finite number.' }
    const value = Number(incoming)
    if (param.type === 'toggle') {
      if (value !== 0 && value !== 1) return { error: `${param.label || key} must be on or off.` }
    } else if (param.type != null || (param.min != null && value < param.min) || (param.max != null && value > param.max)) {
      return { error: `${param.label || key} must stay within its allowed range.` }
    }
    values[key] = value
  }
  return { values }
}

/**
 * One atomic, immutable edit plan. The store owns undo and dirty tracking.
 * Sparse writes retain each clip's own stack, unknown settings and cache
 * metadata; a previously cached status is invalidated after a change. Removing
 * the final effect follows the existing store's cache-clear contract (no file
 * deletion), so undo can restore the original cache reference.
 */
export function planMultiClipEffectsEdit(state, request = {}, { getDefinition, makeId, requireSelection = true } = {}) {
  const fail = error => ({ ok: false, clips: state.clips, changedCount: 0, error })
  if (!isObject(request)) return fail('Invalid effects request.')
  const { clipIds, action } = request
  if (!Array.isArray(clipIds) || clipIds.some(id => !validId(id))) return fail('Select at least two clips.')
  const ids = new Set(clipIds)
  if (ids.size < (requireSelection ? 2 : 1) || ids.size !== clipIds.length) return fail('Select distinct clips.')
  if (requireSelection && Array.isArray(state.selectedClipIds)) {
    const currentIds = new Set(state.selectedClipIds)
    if (currentIds.size !== ids.size || [...ids].some(id => !currentIds.has(id))) return fail('The selection changed. Try the edit again.')
  }
  const selection = getMultiClipSelection(state.clips, state.tracks, clipIds)
  if (selection.selected.length !== ids.size || state.clips.filter(clip => ids.has(clip.id)).length !== ids.size) return fail('The selection changed. Try the edit again.')
  if (!selection.visual.length) return fail('No editable visual clips selected.')
  if (!['add', 'update', 'remove', 'enabled', 'reset'].includes(action)) return fail('Unsupported effects action.')
  // An invalid saved stack must not be overwritten with an empty/new one.
  if (selection.visual.some(clip => clip.effects != null && !Array.isArray(clip.effects))) return fail('An effect stack is invalid. Select one clip to inspect it.')

  const changes = new Map()
  if (action === 'add') {
    const definition = definitionFor(request.type, getDefinition)
    if (!definition || typeof makeId !== 'function') return fail('Unsupported effect type.')
    const defaults = Object.fromEntries(definition.params.map(param => [param.key, definition.defaults?.[param.key]]))
    const validation = validatedSettings(defaults, definition)
    if (validation.error) return fail(validation.error)
    if (request.settings !== undefined) {
      const overrides = validatedSettings(request.settings, definition)
      if (overrides.error) return fail(overrides.error)
      Object.assign(validation.values, overrides.values)
    }
    const existingIds = new Set(state.clips.flatMap(clip => effectsOf(clip).map(effect => effect?.id)))
    for (const clip of selection.visual) {
      let id
      try { id = makeId() } catch { return fail('Could not create an effect ID. Try again.') }
      if (!validId(id) || existingIds.has(id)) return fail('Could not create a unique effect ID. Try again.')
      existingIds.add(id)
      changes.set(clip.id, [...effectsOf(clip), { id, type: request.type, enabled: true, settings: { ...validation.values } }])
    }
  } else {
    const group = resolveGroup(selection, request.group, getDefinition)
    if (!group) return fail(staleReason)
    if (action === 'enabled' && typeof request.enabled !== 'boolean') return fail('Choose whether the effect is enabled.')
    let values = {}
    if (action === 'update' || action === 'reset') {
      const settings = action === 'reset'
        ? Object.fromEntries(group.definition.params.map(param => [param.key, group.definition.defaults?.[param.key]]))
        : request.settings
      const validation = validatedSettings(settings, group.definition)
      if (validation.error) return fail(validation.error)
      values = validation.values
    }
    const blocked = action === 'enabled' ? '' : getMultiClipEffectOperationBlock(selection, group, action === 'remove' ? null : Object.keys(values), getDefinition)
    if (blocked) return fail(blocked)
    for (const { clip, effect } of targetsFor(selection, group)) {
      if (action === 'remove') {
        changes.set(clip.id, effectsOf(clip).filter(item => item !== effect))
        continue
      }
      let updated = effect
      if (action === 'enabled') {
        if ((effect.enabled !== false) !== request.enabled) updated = { ...effect, enabled: request.enabled }
      } else {
        const changedSettings = Object.fromEntries(Object.entries(values).filter(([key, value]) => !equal(readParam(effect, group.definition.params.find(param => param.key === key), group.definition), value)))
        if (Object.keys(changedSettings).length) updated = { ...effect, settings: { ...effect.settings, ...changedSettings } }
      }
      if (updated !== effect) changes.set(clip.id, effectsOf(clip).map(item => item === effect ? updated : item))
    }
  }
  return {
    ok: true,
    changedCount: changes.size,
    targetCount: selection.visual.length,
    clips: changes.size ? state.clips.map(clip => changes.has(clip.id)
      ? {
          ...clip,
          effects: changes.get(clip.id),
          ...(action === 'remove' && changes.get(clip.id).length === 0
            ? { cacheStatus: 'none', cacheUrl: null }
            : { cacheStatus: clip.cacheStatus === 'cached' ? 'invalid' : clip.cacheStatus }),
        }
      : clip) : state.clips,
  }
}
