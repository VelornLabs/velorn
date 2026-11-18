// Portable production memory only. Reported job states are not verified jobs,
// generation permission, review approval, payment authority, or an export plan.
// This module performs no IO and never changes an asset or timeline.
import { getStoryboardShotVisual } from './storyboardPresentation.mjs'

export const PRODUCTION_RUN_VERSION = 1
export const PRODUCTION_RUN_OPERATIONS = Object.freeze(['update_run', 'record_attempt', 'update_attempt', 'bind_shot', 'unbind_shot'])
export const PRODUCTION_ATTEMPT_STATES = Object.freeze(['planned', 'submitted', 'running', 'completed', 'failed', 'uncertain', 'cancelled'])
export const PRODUCTION_RUN_LIMITS = Object.freeze({ attempts: 1000, attemptsPerShot: 30, bindings: 400,
  history: 100, references: 50, id: 160, label: 200, note: 4000, prompt: 12000,
  durationSeconds: 3600, startSeconds: 86400, identityBytes: 1000000 })

const fail = message => { throw new Error(`Production run: ${message}`) }
const object = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${name} must be an object.`)
  return value
}
const fields = (value, allowed, name) => {
  object(value, name)
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${name} contains unsupported field "${key}"; it is read-only in this version.`)
}
const text = (value, name, max = PRODUCTION_RUN_LIMITS.note, fallback = '') => {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(`${name} must be text of at most ${max} characters.`)
  return value
}
const id = (value, name) => {
  if (typeof value !== 'string' || !value || value.length > PRODUCTION_RUN_LIMITS.id || /[\x00-\x20\x7f/\\]/.test(value)) fail(`${name} must be a project or job ID, not a path.`)
  return value
}
const nullableId = (value, name) => value == null ? null : id(value, name)
const list = (value, max, name) => {
  if (!Array.isArray(value) || value.length > max) fail(`${name} must be an array of at most ${max} items.`)
  return value
}
const unique = (values, name) => {
  if (new Set(values).size !== values.length) fail(`${name} must not contain duplicates.`)
  return values
}
const ids = (value, name) => unique(list(value, PRODUCTION_RUN_LIMITS.references, name).map(entry => id(entry, name)), name)
const number = (value, min, max, name, positive = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive ? value <= min : value < min) || value > max) fail(`${name} is outside the supported range.`)
  return value
}
const choice = (value, choices, name) => {
  if (!choices.includes(value)) fail(`${name} must be one of: ${choices.join(', ')}.`)
  return value
}
const exactOne = (entries, targetId, name) => {
  const matches = entries.filter(entry => entry?.id === targetId)
  if (matches.length !== 1) fail(`${name} "${targetId}" is ${matches.length ? 'ambiguous' : 'missing'}.`)
  return matches[0]
}
const emptyRun = () => ({ version: PRODUCTION_RUN_VERSION, notes: '', nextAction: '', attempts: [], bindings: [] })
const audioAsset = asset => asset?.type === 'audio' || (asset?.type === 'video' && (asset.hasAudio === true || asset.settings?.hasAudio === true))
const assetDuration = asset => {
  const value = Number(asset?.duration ?? asset?.settings?.duration)
  return Number.isFinite(value) && value > 0 ? value : null
}

const RECIPE_FIELDS = ['model', 'workflow', 'prompt', 'negativePrompt', 'seed', 'width', 'height', 'fps',
  'generationDurationSeconds', 'referenceAssetIds', 'inputAssetIds', 'songAssetId', 'audioStartSeconds', 'audioDurationSeconds']
function normalizeRecipe(value) {
  fields(value, RECIPE_FIELDS, 'recipe')
  const result = {}
  for (const key of ['model', 'workflow']) {
    result[key] = text(value[key], key, PRODUCTION_RUN_LIMITS.label)
    if (!result[key].trim() || /(?:[\\/]|:\/\/)/.test(result[key])) fail(`${key} must be a descriptive label, not a path or URL.`)
  }
  for (const key of ['prompt', 'negativePrompt']) if (key in value) result[key] = text(value[key], key, PRODUCTION_RUN_LIMITS.prompt)
  if ('seed' in value) {
    if (!Number.isSafeInteger(value.seed) || value.seed < 0) fail('seed must be a nonnegative safe integer.')
    result.seed = value.seed
  }
  for (const key of ['width', 'height']) if (key in value) {
    if (!Number.isInteger(value[key])) fail(`${key} must be an integer.`)
    result[key] = number(value[key], 8, 16384, key)
  }
  if ('fps' in value) result.fps = number(value.fps, 1, 240, 'fps')
  if ('generationDurationSeconds' in value) result.generationDurationSeconds = number(value.generationDurationSeconds, 0, 3600, 'generationDurationSeconds', true)
  for (const key of ['referenceAssetIds', 'inputAssetIds']) if (key in value) result[key] = ids(value[key], key)
  if ('songAssetId' in value) result.songAssetId = nullableId(value.songAssetId, 'songAssetId')
  if (result.songAssetId) {
    result.audioStartSeconds = number(value.audioStartSeconds, 0, 86400, 'audioStartSeconds')
    result.audioDurationSeconds = number(value.audioDurationSeconds, 0, 3600, 'audioDurationSeconds', true)
  } else if ('audioStartSeconds' in value || 'audioDurationSeconds' in value) fail('An audio excerpt requires songAssetId, audioStartSeconds and audioDurationSeconds together.')
  return result
}

const EVENT_FIELDS = ['state', 'remoteJobId', 'outputAssetId', 'note']
function normalizeEvent(value) {
  fields(value, EVENT_FIELDS, 'attempt event')
  const event = { state: choice(value.state, PRODUCTION_ATTEMPT_STATES, 'state'),
    remoteJobId: nullableId(value.remoteJobId, 'remoteJobId'), outputAssetId: nullableId(value.outputAssetId, 'outputAssetId'),
    note: text(value.note, 'note') }
  if (['submitted', 'running', 'completed'].includes(event.state) && !event.remoteJobId) fail(`${event.state} requires a remoteJobId; use uncertain when the job identity is unknown.`)
  if (event.state === 'planned' && event.remoteJobId) fail('A planned attempt cannot already have a remoteJobId.')
  if (event.state === 'completed' && !event.outputAssetId) fail('completed requires an imported outputAssetId.')
  if (event.state !== 'completed' && event.outputAssetId) fail('Only a completed attempt can have an outputAssetId.')
  return event
}
const transitions = {
  planned: PRODUCTION_ATTEMPT_STATES,
  submitted: ['submitted', 'running', 'completed', 'failed', 'uncertain', 'cancelled'],
  running: ['running', 'completed', 'failed', 'uncertain', 'cancelled'],
  uncertain: ['uncertain', 'submitted', 'running', 'completed', 'failed', 'cancelled'],
  completed: ['completed'], failed: ['failed'], cancelled: ['cancelled'],
}
function validateTransition(previous, next) {
  if (!transitions[previous.state].includes(next.state)) fail(`Cannot move ${previous.state} back to ${next.state}; a retry requires a new attemptId.`)
  if (previous.remoteJobId && previous.remoteJobId !== next.remoteJobId) fail('An attempt cannot change or forget its remoteJobId; a retry requires a new attemptId.')
  if (previous.outputAssetId && previous.outputAssetId !== next.outputAssetId) fail('A completed output cannot be changed; record a new attemptId to preserve the previous take.')
}
const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)
function normalizeAttempt(value) {
  fields(value, ['attemptId', 'shotId', 'recipe', ...EVENT_FIELDS, 'history'], 'attempt')
  const event = normalizeEvent(Object.fromEntries(EVENT_FIELDS.map(key => [key, value[key]])))
  const history = list(value.history, PRODUCTION_RUN_LIMITS.history, 'attempt history').map(normalizeEvent)
  if (!history.length || canonical(history.at(-1)) !== canonical(event)) fail('The latest attempt event must match its saved history.')
  for (let index = 1; index < history.length; index++) validateTransition(history[index - 1], history[index])
  return { attemptId: id(value.attemptId, 'attemptId'), shotId: id(value.shotId, 'shotId'),
    recipe: normalizeRecipe(value.recipe), ...event, history }
}

const BASELINE_FIELDS = ['sourceAssetId', 'trackId', 'type', 'startTime', 'duration', 'trimStart', 'trimEnd', 'referencedAssetIds', 'signature']
function normalizeBaseline(value) {
  fields(value, BASELINE_FIELDS, 'binding baseline')
  if (typeof value.signature !== 'string' || !/^production-clip-v1-[a-f0-9]{32}$/.test(value.signature)) fail('Invalid authored clip signature.')
  return { sourceAssetId: id(value.sourceAssetId, 'sourceAssetId'), trackId: id(value.trackId, 'trackId'),
    type: choice(value.type, ['image', 'video'], 'clip type'), startTime: number(value.startTime, 0, 86400, 'clip startTime'),
    duration: number(value.duration, 0, 86400, 'clip duration', true),
    trimStart: value.trimStart == null ? null : number(value.trimStart, 0, 86400, 'trimStart'),
    trimEnd: value.trimEnd == null ? null : number(value.trimEnd, 0, 172800, 'trimEnd'),
    referencedAssetIds: ids(value.referencedAssetIds, 'referencedAssetIds'), signature: value.signature }
}

export function normalizeProductionRun(value) {
  if (value == null) return undefined
  object(value, 'production run')
  if (value.version !== PRODUCTION_RUN_VERSION) fail(`Unsupported version ${String(value.version)}; this run is read-only and has been preserved.`)
  fields(value, ['version', 'notes', 'nextAction', 'attempts', 'bindings'], 'production run')
  const result = { version: PRODUCTION_RUN_VERSION, notes: text(value.notes, 'notes'), nextAction: text(value.nextAction, 'nextAction'),
    attempts: list(value.attempts, PRODUCTION_RUN_LIMITS.attempts, 'attempts').map(normalizeAttempt),
    bindings: list(value.bindings, PRODUCTION_RUN_LIMITS.bindings, 'bindings').map(binding => {
      fields(binding, ['shotId', 'slot', 'timelineId', 'clipId', 'baseline'], 'binding')
      return { shotId: id(binding.shotId, 'shotId'), slot: choice(binding.slot, ['animatic', 'final'], 'slot'),
        timelineId: id(binding.timelineId, 'timelineId'), clipId: id(binding.clipId, 'clipId'), baseline: normalizeBaseline(binding.baseline) }
    }) }
  unique(result.attempts.map(attempt => attempt.attemptId), 'attempt IDs')
  const count = new Map()
  for (const attempt of result.attempts) {
    count.set(attempt.shotId, (count.get(attempt.shotId) || 0) + 1)
    if (count.get(attempt.shotId) > PRODUCTION_RUN_LIMITS.attemptsPerShot) fail(`A shot supports at most ${PRODUCTION_RUN_LIMITS.attemptsPerShot} attempts.`)
  }
  unique(result.bindings.map(binding => canonical([binding.shotId, binding.slot])), 'shot-slot bindings')
  unique(result.bindings.map(binding => canonical([binding.timelineId, binding.clipId])), 'timeline-clip bindings')
  return result
}

// Hash authored values, not transient URLs, thumbnails, or cache state. The
// signature is change detection, NOT authentication or proof of media quality.
const CLIP_FIELDS = ['id', 'type', 'assetId', 'trackId', 'name', 'startTime', 'duration', 'trimStart', 'trimEnd',
  'sourceDuration', 'sourceFps', 'timelineFps', 'sourceTimeScale', 'speed', 'reverse', 'frameSampling',
  'enabled', 'locked', 'lockMode', 'syncLock', 'syncLocked', 'linkGroupId', 'transform', 'keyframes',
  'effects', 'adjustments', 'shapeMask', 'mask', 'masks', 'bypass', 'compositeLowerLayers', 'trackMatte', 'timeRemap',
  'timeRemapPoints', 'speedRamp', 'gainDb', 'fadeIn', 'fadeOut', 'volumeEnvelope', 'audioEq', 'audioInserts',
  'text', 'textProperties', 'shapeProperties', 'captions', 'role', 'captionScope', 'overlayKind']
const TRACK_FIELDS = ['id', 'name', 'type', 'locked', 'muted', 'solo', 'visible', 'hidden', 'enabled', 'volume', 'gainDb', 'effects', 'audioInserts', 'audioEq']
const transientKey = key => /(?:^cache|^proxy|^thumbnail|^waveform|^poster|^preview|^opticalFlowCache|(?:url|path)$)/i.test(key)
function authoredValue(value, seen = new Set(), depth = 0, budget = { count: 0 }) {
  if (++budget.count > 100000 || depth > 32) fail('Authored clip data is too complex to bind safely.')
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return value
  if (value === undefined) return null
  if (typeof value !== 'object' || seen.has(value)) fail('Authored clip data is not serializable.')
  seen.add(value)
  const result = Array.isArray(value) ? value.map(entry => authoredValue(entry, seen, depth + 1, budget))
    : Object.fromEntries(Object.keys(value).sort().filter(key => !transientKey(key) && value[key] !== undefined)
      .map(key => [key, authoredValue(value[key], seen, depth + 1, budget)]))
  seen.delete(value)
  return result
}
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]))
function fingerprint(value) {
  const data = canonical(value)
  if (data.length > PRODUCTION_RUN_LIMITS.identityBytes) fail('Authored clip data is too large to bind safely.')
  return `production-clip-v1-${[2166136261, 2246822507, 3266489909, 668265263].map(seed => {
    let hash = seed
    for (let index = 0; index < data.length; index++) hash = Math.imul(hash ^ data.charCodeAt(index), 16777619) >>> 0
    return hash.toString(16).padStart(8, '0')
  }).join('')}`
}
function collectAssetIds(value, result = new Set()) {
  if (!value || typeof value !== 'object') return result
  for (const [key, entry] of Object.entries(value)) {
    if (/assetid$/i.test(key) && typeof entry === 'string') result.add(entry)
    if (/assetids$/i.test(key) && Array.isArray(entry)) entry.filter(item => typeof item === 'string').forEach(item => result.add(item))
    if (entry && typeof entry === 'object') collectAssetIds(entry, result)
  }
  return result
}

const scalarMetadata = value => typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value)) ? value : null
function portableSourceLocation(asset) {
  const candidates = [asset.relativePath, asset.path, asset.absolutePath]
    .filter(value => typeof value === 'string' && value && !/[\x00-\x1f\x7f]/.test(value))
    .map(value => value.replace(/\\/g, '/'))
    // URLs are runtime playback addresses, not source-file identity. A Windows
    // drive prefix is a filesystem path but is deliberately never retained.
    .filter(value => !/^[a-z][a-z0-9+.-]*:/i.test(value) || /^[a-z]:\//i.test(value))
  const relative = candidates.find(value => !value.startsWith('/') && !/^[a-z]:/i.test(value)
    && !value.split('/').includes('..'))
  const relativeFile = relative ? relative.split('/').filter(part => part && part !== '.').join('/') : null
  const fileName = (relativeFile || candidates[0] || '').split('/').filter(Boolean).at(-1) || null
  return { relativeFile, fileName }
}
function portableAssetIdentity(assetId, assets) {
  const matches = assets.filter(asset => asset?.id === assetId)
  if (matches.length !== 1) return { assetId, status: matches.length ? 'ambiguous' : 'missing' }
  const asset = matches[0]
  const metadata = { assetId, type: scalarMetadata(asset.type), ...portableSourceLocation(asset) }
  for (const key of ['sourceVersion', 'modified', 'lastModified', 'mtimeMs', 'sourceModified', 'size',
    'duration', 'width', 'height', 'fps', 'hasAudio', 'hasAlpha', 'frameCount', 'mimeType',
    'videoCodec', 'audioCodec', 'pixelFormat', 'sourceAssetId']) {
    metadata[key] = scalarMetadata(asset[key] ?? asset.settings?.[key])
  }
  return metadata
}

// Asset metadata detects known same-ID relinks and source revisions. This is
// not a filesystem/content hash: changed bytes with unchanged metadata cannot
// be proven here and still require normal media relinking and visual review.
export function getProductionClipIdentity(clip, timeline, assets = []) {
  object(clip, 'clip')
  const track = exactOne(timeline?.tracks || [], clip.trackId, 'Track')
  if (track.type !== 'video') fail('Shot bindings require a video track.')
  const authored = authoredValue({ clip: pick(clip, CLIP_FIELDS), track: pick(track, TRACK_FIELDS),
    settings: pick(timeline?.settings || timeline || {}, ['fps', 'width', 'height', 'resolution']),
    transitions: (timeline?.transitions || []).filter(transition => [transition.clipId, transition.clipAId, transition.clipBId].includes(clip.id)) })
  const referencedAssetIds = [...collectAssetIds(authored)].sort()
  const media = referencedAssetIds.map(assetId => portableAssetIdentity(assetId, assets))
  return normalizeBaseline({ sourceAssetId: clip.assetId, trackId: clip.trackId, type: clip.type,
    startTime: clip.startTime, duration: clip.duration, trimStart: clip.trimStart ?? null, trimEnd: clip.trimEnd ?? null,
    referencedAssetIds, signature: fingerprint({ authored, media }) })
}

function validateRecipeAssets(recipe, assets) {
  for (const assetId of new Set([...(recipe.referenceAssetIds || []), ...(recipe.inputAssetIds || [])])) {
    if (!['image', 'video', 'audio'].includes(exactOne(assets, assetId, 'Input asset').type)) fail('Recipe inputs must be image, video, or audio assets.')
  }
  if (recipe.songAssetId) {
    const song = exactOne(assets, recipe.songAssetId, 'Song asset')
    if (!audioAsset(song)) fail('songAssetId must identify audio or a video with audio.')
    const duration = assetDuration(song)
    if (duration && recipe.audioStartSeconds + recipe.audioDurationSeconds > duration + 0.001) fail('The audio excerpt exceeds the song duration.')
  }
}
function validateOutput(assetId, assets) {
  if (assetId && !['image', 'video'].includes(exactOne(assets, assetId, 'Output asset').type)) fail('A shot output must be an imported image or video.')
}
function compatibleSource(shot, slot, assetId, run, assets) {
  if (slot === 'animatic') return getStoryboardShotVisual(shot, assets)?.assetId === assetId
  return shot.takes?.find(take => take.id === shot.selectedTakeId)?.assetId === assetId
    || run.attempts.some(attempt => attempt.shotId === shot.id && attempt.state === 'completed' && attempt.outputAssetId === assetId)
}

export function planProductionRunEdit(value, payload, { board, assets = [], timelines = [] } = {}) {
  const existing = normalizeProductionRun(value)
  const run = existing || emptyRun()
  const before = canonical(run)
  object(payload, 'edit')
  const requireShot = shotId => exactOne(board?.shots || [], id(shotId, 'shotId'), 'Shot')
  let shotId, attemptId, deduplicated = false
  switch (payload.operation) {
    case 'update_run':
      fields(payload, ['operation', 'patch'], 'edit')
      fields(payload.patch, ['notes', 'nextAction'], 'run patch')
      for (const key of ['notes', 'nextAction']) if (key in payload.patch) run[key] = text(payload.patch[key], key)
      break
    case 'record_attempt': {
      fields(payload, ['operation', 'shotId', 'attemptId', 'recipe', ...EVENT_FIELDS], 'edit')
      shotId = id(payload.shotId, 'shotId')
      attemptId = id(payload.attemptId, 'attemptId')
      const recipe = normalizeRecipe(payload.recipe)
      const prior = run.attempts.find(attempt => attempt.attemptId === attemptId)
      if (prior) {
        if (prior.shotId !== shotId || canonical(prior.recipe) !== canonical(recipe)) fail('This attemptId already has a different immutable shot or recipe. A retry requires a new attemptId.')
        // Replay-safe reservation: never reset an already submitted job or
        // revalidate historic inputs that may have been removed from a project.
        deduplicated = true
        break
      }
      requireShot(shotId)
      validateRecipeAssets(recipe, assets)
      const event = normalizeEvent({ state: payload.state ?? 'planned', remoteJobId: payload.remoteJobId,
        outputAssetId: payload.outputAssetId, note: payload.note })
      validateOutput(event.outputAssetId, assets)
      run.attempts.push({ shotId, attemptId, recipe, ...event, history: [event] })
      break
    }
    case 'update_attempt': {
      fields(payload, ['operation', 'attemptId', 'patch'], 'edit')
      fields(payload.patch, EVENT_FIELDS, 'attempt patch')
      attemptId = id(payload.attemptId, 'attemptId')
      const attempt = run.attempts.find(item => item.attemptId === attemptId)
      if (!attempt) fail('Attempt was not found. Record its immutable recipe first.')
      shotId = attempt.shotId
      const previous = pick(attempt, EVENT_FIELDS)
      const next = normalizeEvent({ ...previous, ...payload.patch })
      validateTransition(previous, next)
      if (next.outputAssetId !== previous.outputAssetId) validateOutput(next.outputAssetId, assets)
      if (canonical(previous) !== canonical(next)) {
        if (attempt.history.length >= PRODUCTION_RUN_LIMITS.history) fail('Attempt history is full; existing history must be preserved.')
        Object.assign(attempt, next)
        attempt.history.push(next)
      }
      break
    }
    case 'bind_shot': {
      fields(payload, ['operation', 'shotId', 'slot', 'timelineId', 'clipId', 'rebind'], 'edit')
      if ('rebind' in payload && typeof payload.rebind !== 'boolean') fail('rebind must be a boolean.')
      shotId = id(payload.shotId, 'shotId')
      const shot = requireShot(shotId)
      const slot = choice(payload.slot, ['animatic', 'final'], 'slot')
      const timelineId = id(payload.timelineId, 'timelineId'), clipId = id(payload.clipId, 'clipId')
      const timeline = exactOne(timelines, timelineId, 'Timeline')
      const clip = exactOne(timeline.clips || [], clipId, 'Clip')
      const media = exactOne(assets, clip.assetId, 'Clip asset')
      if (media.type !== (slot === 'animatic' ? 'image' : 'video') || clip.type !== media.type) fail(`${slot} needs a matching ${slot === 'animatic' ? 'image' : 'video'} clip and asset.`)
      if (!compatibleSource(shot, slot, media.id, run, assets)) fail('The clip source is not this shot’s current storyboard image, selected take, or completed output for this slot.')
      const prior = run.bindings.find(binding => binding.shotId === shotId && binding.slot === slot)
      if (run.bindings.some(binding => binding !== prior && binding.timelineId === timelineId && binding.clipId === clipId)) fail('This timeline clip is already bound to another shot or slot.')
      if (prior && !payload.rebind) {
        if (prior.timelineId !== timelineId || prior.clipId !== clipId) fail('The shot slot already has a binding. Use explicit rebind after review.')
        break // Never silently refresh an authored baseline during a retry.
      }
      const binding = { shotId, slot, timelineId, clipId, baseline: getProductionClipIdentity(clip, timeline, assets) }
      if (prior) run.bindings[run.bindings.indexOf(prior)] = binding
      else run.bindings.push(binding)
      break
    }
    case 'unbind_shot': {
      fields(payload, ['operation', 'shotId', 'slot'], 'edit')
      shotId = id(payload.shotId, 'shotId')
      const slot = choice(payload.slot, ['animatic', 'final'], 'slot')
      // Missing shots/targets remain inspectable and can be explicitly unbound.
      run.bindings = run.bindings.filter(binding => binding.shotId !== shotId || binding.slot !== slot)
      break
    }
    default: fail('Unknown production-run operation.')
  }
  const normalized = normalizeProductionRun(run)
  const changed = canonical(normalized) !== before
  return { run: existing || changed ? normalized : undefined, changed, operation: payload.operation,
    ...(shotId ? { shotId } : {}), ...(attemptId ? { attemptId } : {}), ...(deduplicated ? { deduplicated } : {}) }
}

/** Read-only metadata. Does not contact generation services or decode media. */
export function inspectProductionRun(value, { board, assets = [], timelines = [] } = {}) {
  const run = normalizeProductionRun(value)
  const issues = []
  const problem = (code, details) => { const issue = { code, ...details }; issues.push(issue); return issue }
  const matching = (entries, targetId) => entries.filter(entry => entry?.id === targetId)
  const checkAsset = (assetId, details) => {
    const matches = matching(assets, assetId)
    if (matches.length !== 1) return problem(matches.length ? 'ambiguous-asset' : 'missing-asset', { ...details, assetId })
    return null
  }
  const attempts = (run?.attempts || []).map(attempt => {
    const problems = [], details = { shotId: attempt.shotId, attemptId: attempt.attemptId }
    const shots = matching(board?.shots || [], attempt.shotId)
    if (shots.length !== 1) problems.push(problem(shots.length ? 'ambiguous-shot' : 'missing-shot', details))
    for (const assetId of collectAssetIds(attempt)) {
      const issue = checkAsset(assetId, details)
      if (issue) problems.push(issue)
    }
    // Existence alone is not evidence that a relinked/replaced asset still has
    // the same compatible media kind or audio extent. These remain advisories;
    // historic records are never discarded or rewritten on inspection.
    try { validateRecipeAssets(attempt.recipe, assets); validateOutput(attempt.outputAssetId, assets) }
    catch (error) {
      if (!problems.some(issue => ['missing-asset', 'ambiguous-asset'].includes(issue.code))) {
        problems.push(problem('incompatible-input-or-output', { ...details, message: error.message }))
      }
    }
    if (['submitted', 'running', 'uncertain'].includes(attempt.state)) problems.push(problem('reconcile-job-before-retry', { ...details, remoteJobId: attempt.remoteJobId }))
    return { ...attempt, reportedState: attempt.state, verified: false, issues: problems }
  })
  const bindings = (run?.bindings || []).map(binding => {
    const problems = [], details = { shotId: binding.shotId, slot: binding.slot, timelineId: binding.timelineId, clipId: binding.clipId }
    let current = null
    const shots = matching(board?.shots || [], binding.shotId)
    const documents = matching(timelines, binding.timelineId)
    if (shots.length !== 1) problems.push(problem(shots.length ? 'ambiguous-shot' : 'missing-shot', details))
    if (documents.length !== 1) problems.push(problem(documents.length ? 'ambiguous-timeline' : 'missing-timeline', details))
    else {
      const clips = matching(documents[0].clips || [], binding.clipId)
      if (clips.length !== 1) problems.push(problem(clips.length ? 'ambiguous-clip' : 'missing-clip', details))
      else {
        try {
          current = getProductionClipIdentity(clips[0], documents[0], assets)
          if (current.signature !== binding.baseline.signature) problems.push(problem('changed', details))
          const media = matching(assets, clips[0].assetId)
          if (media.length === 1 && (media[0].type !== clips[0].type || media[0].type !== (binding.slot === 'animatic' ? 'image' : 'video'))) {
            problems.push(problem('incompatible-clip-asset', details))
          }
          if (shots.length === 1 && !compatibleSource(shots[0], binding.slot, clips[0].assetId, run, assets)) problems.push(problem('shot-source-changed', details))
        } catch (error) { problems.push(problem('unsupported-clip', { ...details, message: error.message })) }
      }
    }
    for (const assetId of new Set([...binding.baseline.referencedAssetIds, ...(current?.referencedAssetIds || [])])) {
      const issue = checkAsset(assetId, details)
      if (issue) problems.push(issue)
    }
    return { ...binding, current, status: problems[0]?.code || 'linked', issues: problems }
  })
  return { run: run || null, attempts, bindings, issues,
    summary: { attemptCount: attempts.length, bindingCount: bindings.length,
      reportedCompletedCount: attempts.filter(attempt => attempt.state === 'completed').length,
      needsReconciliationCount: attempts.filter(attempt => ['submitted', 'running', 'uncertain'].includes(attempt.state)).length,
      linkedCount: bindings.filter(binding => binding.status === 'linked').length,
      reviewInVelorn: true, exportRequired: false, generationAuthorized: false, statesVerified: false } }
}
