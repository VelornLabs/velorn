import { MULTI_CLIP_FIELDS, getMultiClipSelection, planMultiClipInspectorEdit, planMultiClipInspectorUpdates } from './multiClipInspector.js'
import { getMultiClipEffectGroups, planMultiClipEffectsEdit } from './multiClipEffects.js'
import { getPasteAttributesAvailability, planPasteAttributes } from './pasteAttributes.js'
import { isCompoundLocked, isCompoundCacheBusy, validateCompoundDocument } from './compoundDocument.mjs'
import { createRollEditSession, planRollEdit } from './rollEdit.mjs'
import { createSlipEditSession, planSlipEdit } from './slipEdit.mjs'
import { createSlideEditSession, planSlideEdit } from './slideEdit.mjs'
import { createRippleTrimSession, planRippleTrim } from './rippleTrim.mjs'
import { createMultiClipTrimSession, resolveMultiClipTrim } from './multiClipTrim.mjs'
import { validateAudioVolumeEnvelope } from './audioVolumeEnvelope.mjs'
import { TRANSITION_TYPES, FRAME_RATE } from '../constants/transitions.js'

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const fail = reason => ({ ok: false, changed: false, reason })
const error = message => { throw new Error(message) }
const number = (value, label, min = -Infinity, max = Infinity) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) error(`${label} must be a finite number between ${min} and ${max}.`)
  return value
}
const boolean = (value, label) => { if (typeof value !== 'boolean') error(`${label} must be a boolean.`); return value }
const visual = new Set(['video', 'image', 'text', 'shape', 'adjustment', 'caption', 'captions'])
const inspectorVisual = new Set(['video', 'image', 'text', 'shape', 'adjustment'])
const supported = new Set([...visual, 'audio'])
const fields = new Map(MULTI_CLIP_FIELDS.map(field => [field.id, field]))
const extras = {
  blur: [0, 50], motionBlurSamples: [2, 48], motionBlurShutter: [1, 360],
  motionBlurEnabled: 'boolean', motionBlurMode: ['auto', 'velocity', 'sampled'], motionPathMode: ['linear', 'smooth'],
}
const extraDefaults = { blur: 0, motionBlurSamples: 8, motionBlurShutter: 180, motionBlurEnabled: false, motionBlurMode: 'auto', motionPathMode: 'linear' }
const frame = (time, fps) => Math.round(time * fps) / fps
const projectClip = clip => ({ id: clip.id, type: clip.type, trackId: clip.trackId, startTime: clip.startTime,
  duration: clip.duration, trimStart: clip.trimStart, trimEnd: clip.trimEnd, transform: clip.transform,
  adjustments: clip.adjustments, effects: clip.effects, enabled: clip.enabled, labelColor: clip.labelColor,
  trackMatte: clip.trackMatte, bypass: clip.bypass })

/** Strict target resolution shared by read-only previews and atomic commits. */
export function resolveMcpEditingTargets(state, payload = {}, suppliedIds, { readOnly = false } = {}) {
  let ids = suppliedIds ?? payload.clipIds ?? (payload.clipId ? [payload.clipId] : null)
  if (typeof ids === 'string') ids = [ids]
  if (ids == null) {
    let clips = state.clips
    const filter = String(payload.filter || '').toLowerCase()
    if (payload.selected || filter === 'selected' || (!filter && !payload.trackId && !payload.type && !payload.nameIncludes)) clips = clips.filter(clip => state.selectedClipIds.includes(clip.id))
    if (filter && !['selected', 'disabled', 'enabled', 'visual', 'audio', 'labeled', 'colored'].includes(filter)) error('Unsupported clip filter.')
    if (filter === 'disabled') clips = clips.filter(clip => clip.enabled === false)
    if (filter === 'enabled') clips = clips.filter(clip => clip.enabled !== false)
    if (filter === 'visual') clips = clips.filter(clip => visual.has(clip.type))
    if (filter === 'audio') clips = clips.filter(clip => clip.type === 'audio')
    if (filter === 'labeled' || filter === 'colored') clips = clips.filter(clip => clip.labelColor)
    if (payload.trackId) clips = clips.filter(clip => clip.trackId === payload.trackId)
    if (payload.type) clips = clips.filter(clip => clip.type === payload.type)
    if (payload.nameIncludes) clips = clips.filter(clip => String(clip.name || '').toLowerCase().includes(String(payload.nameIncludes).toLowerCase()))
    ids = clips.map(clip => clip.id)
  }
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) error('Provide distinct existing clip IDs, or an unambiguous selection/filter.')
  const limit = payload.limit === undefined ? 100 : number(payload.limit, 'limit', 1, 1000)
  if (ids.length > limit) error(`The edit matches ${ids.length} clips, above limit ${limit}.`)
  return ids.map(id => {
    const matches = state.clips.filter(clip => clip.id === id)
    if (matches.length !== 1) error(`Clip ${id} is missing or ambiguous.`)
    const clip = matches[0], tracks = state.tracks.filter(track => track.id === clip.trackId)
    if (tracks.length !== 1) error(`Track for ${id} is missing or ambiguous.`)
    if (!readOnly && (isCompoundLocked(clip) || isCompoundLocked(tracks[0]))) error(`Unlock clip ${id} and its track before editing.`)
    if (!readOnly && isCompoundCacheBusy(clip)) error(`Wait for clip ${id}'s render job before editing.`)
    if (!supported.has(clip.type)) error(`Editing ${clip.type} clips is not supported here. Open a compound to edit its children.`)
    return clip
  })
}

function protectAnimation(clip, keys) {
  if (clip.keyframes != null && !plain(clip.keyframes)) error(`Clip ${clip.id} has invalid animation data.`)
  for (const key of keys) for (const alias of [key, `transform.${key}`, `adjustments.${key}`, key.replace(/^color\./, '')]) {
    const frames = clip.keyframes?.[alias]
    if (frames != null && (!Array.isArray(frames) || frames.length)) error(`Animated property ${key} is protected on ${clip.id}; edit its keyframes explicitly.`)
  }
}

function stylePlan(state, request) {
  const clips = resolveMcpEditingTargets(state, request), clipIds = clips.map(clip => clip.id)
  let next = state
  const transform = { ...(request.transform || {}) }, delta = request.transformDelta || {}
  if (request.transform != null && !plain(request.transform) || !plain(delta)) error('Transform values must be objects.')
  for (const key of [...fields.keys(), ...Object.keys(extras)]) if (own(request, key) && fields.get(key)?.group !== 'audio') transform[key] = request[key]
  const updates = { ...(request.updates || {}) }
  for (const [key, value] of Object.entries(transform)) {
    if (fields.get(key)?.group === 'transform') updates[key] = value
    else if (!own(extras, key)) error(`Unsupported transform property: ${key}.`)
  }
  const colors = request.adjustments ?? request.color
  if (colors !== undefined) {
    if (!plain(colors)) error('adjustments must be an object.')
    for (const [key, value] of Object.entries(colors)) {
      if (plain(value)) for (const [nested, item] of Object.entries(value)) updates[`color.${key}.${nested}`] = item
      else updates[key.startsWith('color.') ? key : `color.${key}`] = value
    }
  }
  const changedKeys = [...Object.keys(updates), ...Object.keys(delta), ...Object.keys(transform)]
  if ((Object.keys(updates).length || Object.keys(delta).length) && clips.some(clip => !inspectorVisual.has(clip.type)
    || state.tracks.find(track => track.id === clip.trackId)?.type !== 'video')) error('Static Inspector edits require ordinary visual clips on video tracks. Use dedicated caption/audio controls for other roles.')
  for (const clip of clips) {
    protectAnimation(clip, changedKeys)
    if (changedKeys.some(key => ['scaleX', 'scaleY'].includes(key)) && clip.transform?.scaleLinked !== false) protectAnimation(clip, ['scaleX', 'scaleY'])
  }
  if (Object.keys(updates).length) {
    for (const key of Object.keys(updates)) if (!fields.has(key)) error(`Unsupported Inspector property ${key}.`)
    const plan = planMultiClipInspectorUpdates(next, { clipIds, updates })
    if (!plan.ok) error(plan.error)
    next = { ...next, clips: plan.clips }
  }
  for (const [property, value] of Object.entries(delta)) {
    if (!fields.has(property) || fields.get(property).group !== 'transform') error(`Unsupported relative transform ${property}.`)
    const plan = planMultiClipInspectorEdit(next, { clipIds, property, value: number(value, property), mode: 'offset', explicitKeys: Object.keys(delta) })
    if (!plan.ok) error(plan.error)
    next = { ...next, clips: plan.clips }
  }
  const extraTransform = {}
  for (const [key, rule] of Object.entries(extras)) if (own(transform, key)) {
    const value = transform[key]
    if (rule === 'boolean') extraTransform[key] = boolean(value, key)
    else if (typeof rule[0] === 'number') extraTransform[key] = number(value, key, ...rule)
    else { if (!rule.includes(value)) error(`Unsupported ${key}.`); extraTransform[key] = value }
  }
  if (request.trackMatte !== undefined && !['none', 'alpha', 'alpha-inverted', 'luma', 'luma-inverted'].includes(request.trackMatte)) error('Unsupported track matte.')
  if (request.labelColor !== undefined && request.labelColor !== '' && !/^#[0-9a-f]{6}$/i.test(request.labelColor)) error('labelColor must be #RRGGBB or empty to clear.')
  if (request.enabled !== undefined) boolean(request.enabled, 'enabled')
  if (request.bypass !== undefined) {
    if (!plain(request.bypass) || Object.keys(request.bypass).some(key => !['mask', 'color', 'effects'].includes(key))) error('Unsupported bypass group.')
    for (const [key, value] of Object.entries(request.bypass)) boolean(value, key)
  }
  const hasVisualUpdates = changedKeys.length || request.trackMatte !== undefined || request.bypass !== undefined
  if (hasVisualUpdates && clips.some(clip => !visual.has(clip.type))) error('Visual styling requires visual clip targets; target audio separately.')
  if (!changedKeys.length && request.enabled === undefined && request.labelColor === undefined && request.trackMatte === undefined && request.bypass === undefined) error('Provide at least one supported style or color update.')
  const ids = new Set(clipIds)
  const result = next.clips.map(clip => {
    if (!ids.has(clip.id)) return clip
    const updated = { ...clip }
    const extraChanges = Object.fromEntries(Object.entries(extraTransform).filter(([key, value]) => value !== (clip.transform?.[key] ?? extraDefaults[key])))
    if (Object.keys(extraChanges).length) updated.transform = { ...clip.transform, ...extraChanges }
    if (own(request, 'enabled') && (clip.enabled !== false) !== request.enabled) updated.enabled = request.enabled
    if (own(request, 'labelColor') && (clip.labelColor || null) !== (request.labelColor || null)) updated.labelColor = request.labelColor || null
    if (own(request, 'trackMatte') && (clip.trackMatte || 'none') !== request.trackMatte) updated.trackMatte = request.trackMatte
    if (request.bypass) {
      const bypass = { ...clip.bypass }
      for (const [key, value] of Object.entries(request.bypass)) { if (value) bypass[key] = true; else delete bypass[key] }
      if (Object.keys(bypass).length) updated.bypass = bypass; else delete updated.bypass
    }
    return equal(updated, clip) ? clip : updated
  })
  return { ok: true, clips: result, targetClipIds: clipIds }
}

function effectsPlan(state, request, dependencies) {
  const clips = resolveMcpEditingTargets(state, request), clipIds = clips.map(clip => clip.id)
  if (clips.some(clip => !inspectorVisual.has(clip.type) || state.tracks.find(track => track.id === clip.trackId)?.type !== 'video')) error('Effects require ordinary visual clips on video tracks.')
  const projected = { ...state, selectedClipIds: clipIds }
  const groups = getMultiClipEffectGroups(getMultiClipSelection(state.clips, state.tracks, clipIds), dependencies.getDefinition)
  let group = request.group
  if (!group && request.action !== 'add') {
    const candidates = groups.filter(group => request.effectId ? group.members.some(member => member.effectId === request.effectId)
      : group.type === (request.effectType || request.type) && (request.ordinal == null || group.ordinal === request.ordinal))
    if (candidates.length !== 1) error('Choose one shared effect by effectId or exact effectType and ordinal. Inspect effects first.')
    group = candidates[0]
  }
  const plan = planMultiClipEffectsEdit(projected, { ...request, clipIds, group, type: request.effectType || request.type }, { ...dependencies, requireSelection: false })
  if (!plan.ok) error(plan.error)
  return { ...plan, targetClipIds: clipIds }
}

function pastePlan(state, request, dependencies) {
  const clips = resolveMcpEditingTargets(state, request, request.destinationClipIds || request.clipIds)
  const sources = state.clips.filter(clip => clip.id === (request.sourceClipId || request.sourceId))
  if (sources.length !== 1) error('Provide one existing sourceClipId.')
  const projected = { ...state, selectedClipIds: clips.map(clip => clip.id) }
  const input = { source: sources[0], clipIds: projected.selectedClipIds, groups: request.groups }
  const availability = getPasteAttributesAvailability(projected, input, dependencies)
  if (!availability.ok) error(availability.error)
  if (!request.groups?.length) error('Choose attribute groups: transform, color, effects, audio.')
  const plan = planPasteAttributes(projected, input, dependencies)
  if (!plan.ok) error(plan.error)
  return { ...plan, targetClipIds: input.clipIds, availability }
}

function trimPlan(state, request, dependencies) {
  const entries = request.clips || request.updates || [request]
  if (!Array.isArray(entries) || !entries.length || entries.length > 100) error('Provide between 1 and 100 clip trims.')
  const ids = entries.map(entry => entry.clipId || entry.id), clips = resolveMcpEditingTargets(state, { ...request, clipIds: ids })
  const idSet = new Set(ids), fps = state.timelineFps
  if (state.rippleEditMode) error('Use edit_trim mode ripple for ripple trimming, or turn off Ripple Edit for absolute trims.')
  if (state.transitions.some(item => [item.clipId, item.clipAId, item.clipBId].some(id => idSet.has(id)))) error('Remove attached transitions before absolute trimming; their handles must not be silently invalidated.')
  const changed = new Map()
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i], clip = clips[i], updates = {}
    if (clip.keyframes?.speed?.length || clip.speedRamp || clip.timeRemap) error('Absolute MCP trims do not support speed ramps or time remapping; edit a constant-speed clip.')
    if (clip.linkGroupId && state.clips.some(other => other.linkGroupId === clip.linkGroupId && !idSet.has(other.id))) error('Include the complete linked group when trimming.')
    for (const [key, alias] of [['startTime', 'startSeconds'], ['duration', 'durationSeconds'], ['trimStart', 'trimStartSeconds'], ['trimEnd', 'trimEndSeconds']]) {
      const value = entry[alias] ?? entry[key]
      if (value !== undefined) updates[key] = ['startTime', 'duration'].includes(key)
        ? frame(number(value, alias, key === 'duration' ? 1 / fps : 0), fps) : number(value, alias, 0)
    }
    if (!Object.keys(updates).length) error(`No timing update for ${clip.id}.`)
    if (['video', 'audio'].includes(clip.type) && (!Number.isFinite(clip.sourceDuration) || clip.sourceDuration <= 0)) error(`Clip ${clip.id} needs known source duration before trimming.`)
    const next = dependencies.applyClipTrimUpdate(clip, updates, fps)
    for (const [key, value] of Object.entries(updates)) if (Math.abs(next[key] - value) > 1e-6) error(`Trim ${clip.id} exceeds source bounds or has inconsistent ${key}; no clips changed.`)
    if (next.duration < 1 / fps || !Number.isFinite(next.duration) || next.trimStart < 0 || next.trimEnd <= next.trimStart) error(`Invalid trim for ${clip.id}.`)
    if (clip.type === 'audio' && clip.volumeEnvelope) {
      const validated = validateAudioVolumeEnvelope(clip.volumeEnvelope)
      if (!validated.ok) error(validated.reason)
    }
    if (!equal(next, clip)) changed.set(clip.id, next)
  }
  const nextClips = state.clips.map(clip => changed.get(clip.id) || clip)
  for (const clip of changed.values()) if (nextClips.some(other => other.id !== clip.id && other.trackId === clip.trackId
    && clip.startTime < other.startTime + other.duration - 1e-7 && clip.startTime + clip.duration > other.startTime + 1e-7)) error(`Trim ${clip.id} would overlap another clip. Use a roll, slide, or explicit source overwrite.`)
  return { ok: true, clips: nextClips, targetClipIds: ids }
}

function semanticTrimPlan(state, request, dependencies) {
  const edge = ({ start: 'left', end: 'right', in: 'left', out: 'right' })[request.edge] || request.edge
  const requestedDelta = number(request.deltaSeconds ?? request.delta, 'deltaSeconds')
  if (['normal', 'trim'].includes(request.mode)) {
    const targets = request.targetClipIds || request.clipIds || [request.clipId]
    const clips = resolveMcpEditingTargets(state, request, targets)
    if (clips.some(clip => clip.reverse)) error('Normal batch edge trim does not support reverse media; use explicit trim_clips source bounds or a native roll/slip/slide/ripple edit.')
    const session = createMultiClipTrimSession({ clips: state.clips, targetClipIds: targets, primaryClipId: request.clipId, edge, fps: state.timelineFps })
    if (!session) error('Choose a primary clip, edge and existing trim targets.')
    const minimumDelta = Math.ceil(session.minimumDelta * state.timelineFps - 1e-7) / state.timelineFps
    const maximumDelta = Math.floor(session.maximumDelta * state.timelineFps + 1e-7) / state.timelineFps
    if (minimumDelta > maximumDelta) error('These clips have no safe shared frame-aligned trim range.')
    const resolved = resolveMultiClipTrim({ ...session, minimumDelta, maximumDelta }, frame(requestedDelta, state.timelineFps))
    const plan = trimPlan(state, { ...request, clips: resolved.updates.map(item => ({ clipId: item.id, ...item.updates })) }, dependencies)
    return { ...plan, delta: resolved.delta, requestedDelta, bounds: { minimumDelta, maximumDelta, constraints: session.limitConstraints } }
  }
  const modes = { roll: [createRollEditSession, planRollEdit], slip: [createSlipEditSession, planSlipEdit],
    slide: [createSlideEditSession, planSlideEdit], ripple: [createRippleTrimSession, planRippleTrim] }
  const pair = modes[request.mode]
  if (!pair) error('Choose normal, roll, slip, slide, or ripple.')
  const result = pair[0]({ ...request, edge, clips: state.clips, tracks: state.tracks, transitions: state.transitions,
    targetClipIds: request.targetClipIds || request.clipIds, fps: state.timelineFps })
  if (!result.ok) error(result.reason)
  const plan = pair[1]({ session: result.session, requestedDelta })
  if (!plan.ok) error(plan.reason)
  return { ...plan, bounds: result.session.bounds, requestedDelta,
    targetClipIds: state.clips.filter((clip, i) => clip !== plan.clips[i]).map(clip => clip.id) }
}

function transitionPlan(state, request, dependencies) {
  if (state.compoundEditContext) error('Transitions inside compounds are not supported.')
  const action = request.operation
  let existing = request.transitionId ? state.transitions.find(item => item.id === request.transitionId) : null
  if (action === 'remove') {
    const ids = request.transitionIds || [request.transitionId]
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) error('Choose distinct existing transition IDs.')
    const targets = ids.map(id => { const item = state.transitions.find(t => t.id === id); if (!item) error(`Transition ${id} was not found.`); return item })
    resolveMcpEditingTargets(state, {}, [...new Set(targets.flatMap(item => item.kind === 'edge' ? [item.clipId] : [item.clipAId, item.clipBId]))])
    if (targets.some(item => !['edge', 'between'].includes(item.kind))) error('Remove legacy transitions in the UI first.')
    return { ok: true, clips: state.clips, transitions: state.transitions.filter(item => !ids.includes(item.id)), removedTransitionIds: ids }
  }
  if (action === 'update' && !existing) error('Choose an existing transitionId.')
  const kind = existing?.kind || (request.clipAId && request.clipBId ? 'between' : 'edge')
  const ids = kind === 'between' ? [existing?.clipAId || request.clipAId, existing?.clipBId || request.clipBId] : [existing?.clipId || request.clipId]
  const clips = resolveMcpEditingTargets(state, {}, ids)
  if (clips.some(clip => !visual.has(clip.type) || clip.type === 'adjustment')) error('Transitions require ordinary visual clips.')
  if (kind === 'between' && clips[0].trackId !== clips[1].trackId) error('Transition clips must share one track.')
  if (kind === 'between' && (clips[0].startTime >= clips[1].startTime || clips[0].startTime + clips[0].duration < clips[1].startTime - 1e-7)) error('Between transitions need clips in timeline order with touching or overlapping timing.')
  const edge = existing?.edge || request.edge || 'in'
  if (kind === 'edge' && !['in', 'out'].includes(edge)) error('Transition edge must be in or out.')
  if (action === 'add') existing = state.transitions.find(item => kind === 'edge' ? item.kind === 'edge' && item.clipId === ids[0] && item.edge === edge
    : item.clipAId === ids[0] && item.clipBId === ids[1] || item.clipAId === ids[1] && item.clipBId === ids[0]) || null
  const type = request.transitionType || request.type || existing?.type || (kind === 'edge' ? 'fade-black' : 'dissolve')
  if (!TRANSITION_TYPES.some(item => item.id === type)) error('Unsupported transition type.')
  const inputSettings = { ...existing?.settings, ...request.settings, ...(request.alignment ? { alignment: request.alignment } : {}) }
  if (inputSettings.alignment && !['center', 'start', 'end'].includes(inputSettings.alignment)) error('Alignment must be center, start, or end.')
  for (const [key, value] of Object.entries(inputSettings)) {
    if (typeof value === 'number' && !Number.isFinite(value)) error(`Invalid transition setting ${key}.`)
    if (['__proto__', 'constructor', 'prototype'].includes(key)) error('Invalid transition settings.')
  }
  const settings = dependencies.buildTransitionSettings(type, inputSettings)
  const requestedDuration = number(request.durationSeconds ?? request.duration ?? existing?.duration ?? .5, 'durationSeconds', 1 / FRAME_RATE)
  const maximum = kind === 'edge' ? dependencies.getMaxEdgeTransitionDuration(ids[0])
    : dependencies.getMaxTransitionDurationForAlignment(ids[0], ids[1], settings.alignment || 'center', existing?.id)
  if (!Number.isFinite(maximum) || maximum < 1 / FRAME_RATE) error('Insufficient transition handles or incompatible clip timing.')
  const duration = Math.min(requestedDuration, maximum)
  const base = existing || { id: `transition-${state.transitionCounter}`, kind, ...(kind === 'edge' ? { clipId: ids[0], edge }
    : { clipAId: ids[0], clipBId: ids[1], editPoint: clips[0].startTime + clips[0].duration,
      originalClipAEnd: clips[0].startTime + clips[0].duration, originalClipADuration: clips[0].duration, originalClipATrimEnd: clips[0].trimEnd,
      originalClipBStart: clips[1].startTime, originalClipBDuration: clips[1].duration, originalClipBTrimStart: clips[1].trimStart }) }
  const next = { ...base, type, duration, settings, ...(kind === 'between' ? { contributions: dependencies.getTransitionContributions(duration, settings), split: settings.split || null } : {}) }
  return { ok: true, clips: state.clips, transitions: existing ? state.transitions.map(item => item.id === existing.id ? equal(next, item) ? item : next : item) : [...state.transitions, next],
    transitionCounter: state.transitionCounter + (existing ? 0 : 1), transition: next,
    warnings: duration < requestedDuration ? [`Transition duration limited to ${duration} seconds by available handles.`] : [] }
}

/** Pure plan. All persistence/history is owned by timelineStore's token commit. */
export function planMcpEditing(state, request, dependencies = {}) {
  try {
    if (state.isPlaying) error('Pause timeline playback before editing.')
    if (!Number.isFinite(state.timelineFps) || state.timelineFps <= 0) error('A known timeline frame rate is required.')
    const planners = { style: stylePlan, effects: effectsPlan, paste: pastePlan, trim: trimPlan, edit_trim: semanticTrimPlan, transition: transitionPlan }
    if (!planners[request.kind]) error('Unsupported editing operation.')
    const plan = planners[request.kind](state, request, dependencies)
    if (!plan.ok) return plan
    if (state.compoundEditContext) {
      const valid = validateCompoundDocument({ ...state.compoundEditContext.originalChildDocument, clips: plan.clips,
        tracks: state.tracks, transitions: plan.transitions || state.transitions })
      if (!valid.ok) return fail(valid.reason)
    }
    const changedClipIds = state.clips.filter((clip, i) => !equal(clip, plan.clips[i])).map(clip => clip.id)
    const changed = changedClipIds.length > 0 || !!plan.transitions && !equal(state.transitions, plan.transitions)
    const patch = changed ? { clips: plan.clips, ...(plan.transitions ? { transitions: plan.transitions } : {}),
      ...(plan.transitionCounter !== undefined ? { transitionCounter: plan.transitionCounter } : {}),
      ...(request.kind === 'edit_trim' && request.mode === 'ripple' ? { duration: Math.max(state.duration, ...plan.clips.map(clip => clip.startTime + clip.duration)) } : {}) } : {}
    return { ok: true, changed, patch, summary: { operation: request.kind, changedClipIds, changedCount: changedClipIds.length,
      targetClipIds: plan.targetClipIds, before: state.clips.filter(clip => changedClipIds.includes(clip.id)).map(projectClip),
      after: plan.clips.filter(clip => changedClipIds.includes(clip.id)).map(projectClip), deltaSeconds: plan.delta,
      requestedDeltaSeconds: plan.requestedDelta, bounds: plan.bounds, warnings: plan.warnings || [], transition: plan.transition,
      removedTransitionIds: plan.removedTransitionIds, availability: plan.availability } }
  } catch (cause) { return fail(cause?.message || 'This edit cannot be applied safely.') }
}
