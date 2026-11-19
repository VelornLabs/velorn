// Portable authored data only: IDs refer to project assets, never file paths.
import { normalizeProduction, planProductionEdit, PRODUCTION_OPERATIONS } from './production.mjs'
import { normalizeProductionRun, planProductionRunEdit, PRODUCTION_RUN_OPERATIONS } from './productionRun.mjs'
import { formatStoryboardShotLabel, getStoryboardLabelAllocation, materializeStoryboardShotLabels, parseStoryboardShotLabel } from './storyboardPresentation.mjs'
export { getStoryboardShotLabel, getStoryboardPresentation } from './storyboardPresentation.mjs'
export const STORYBOARD_VERSION = 1
export const STORYBOARD_STATUSES = Object.freeze(['planned', 'in-progress', 'review', 'approved'])
export const STORYBOARD_LIMITS = Object.freeze({ shots: 200, takesPerShot: 30, referencesPerShot: 50,
  title: 200, brief: 12000, description: 8000, prompt: 12000, label: 200, workflowLabel: 200,
  id: 160, maxDurationSeconds: 3600 })

const fail = message => { throw new Error(`Storyboard: ${message}`) }
const object = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object.`)
  return value
}
const keys = (value, allowed, name) => {
  object(value, name)
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(name === 'edit' || name.includes('patch')
    ? `${name} contains unsupported field "${key}". Accepted fields: ${allowed.join(', ')}. This is an argument mismatch, not an access restriction.`
    : `${name} contains unsupported field "${key}"; it is read-only in this version.`)
}
const text = (value, field, max, fallback = '') => {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(`${field} must be text of at most ${max} characters.`)
  return value
}
const id = (value, name) => {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > STORYBOARD_LIMITS.id || /[\x00-\x20\x7f/\\]/.test(value)) fail(`${name} must be a valid project ID, not a path.`)
  return value
}
const nullableId = (value, name) => value == null ? null : id(value, name)
const duration = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > STORYBOARD_LIMITS.maxDurationSeconds) fail(`durationSeconds must be greater than 0 and at most ${STORYBOARD_LIMITS.maxDurationSeconds}.`)
  return value
}
const array = (value, name, max) => {
  if (!Array.isArray(value) || value.length > max) fail(`${name} must be an array of at most ${max} items.`)
  return value
}
const unique = (values, name) => {
  if (new Set(values).size !== values.length) fail(`${name} must not contain duplicates.`)
  return values
}
const references = values => unique(array(values, 'referenceAssetIds', STORYBOARD_LIMITS.referencesPerShot)
  .map(value => id(value, 'referenceAssetId')), 'referenceAssetIds')
const status = value => {
  if (!STORYBOARD_STATUSES.includes(value)) fail('status must be planned, in-progress, review, or approved.')
  return value
}

export const createDefaultStoryboard = () => ({ version: STORYBOARD_VERSION, title: 'Storyboard', brief: '', songAssetId: null, shots: [] })

export function normalizeStoryboard(value) {
  if (value == null) return createDefaultStoryboard()
  object(value, 'board')
  if (value.version !== STORYBOARD_VERSION) fail(`Unsupported version ${String(value.version)}; this board is read-only and has been preserved.`)
  keys(value, ['version', 'title', 'brief', 'songAssetId', 'shots', 'production', 'productionRun', 'nextShotNumber', 'referenceAssetIds', 'concept', 'visualStyle', 'approach'], 'board')
  const shots = array(value.shots, 'shots', STORYBOARD_LIMITS.shots).map((shot, index) => {
    keys(shot, ['id', 'title', 'description', 'durationSeconds', 'referenceAssetIds', 'status', 'takes', 'selectedTakeId', 'label', 'storyboardAssetId'], 'shot')
    const takes = array(shot.takes, 'takes', STORYBOARD_LIMITS.takesPerShot).map(take => {
      keys(take, ['id', 'assetId', 'label', 'prompt', 'workflowLabel'], 'take')
      return { id: id(take.id, 'takeId'), assetId: id(take.assetId, 'take assetId'),
        label: text(take.label, 'label', STORYBOARD_LIMITS.label),
        prompt: text(take.prompt, 'prompt', STORYBOARD_LIMITS.prompt),
        workflowLabel: text(take.workflowLabel, 'workflowLabel', STORYBOARD_LIMITS.workflowLabel) }
    })
    unique(takes.map(take => take.id), 'take IDs')
    unique(takes.map(take => take.assetId), 'take asset references')
    const selectedTakeId = nullableId(shot.selectedTakeId, 'selectedTakeId')
    if (selectedTakeId && !takes.some(take => take.id === selectedTakeId)) fail('selectedTakeId does not belong to its shot.')
    if (shot.label !== undefined) parseStoryboardShotLabel(shot.label)
    return { id: id(shot.id, 'shotId'), title: text(shot.title, 'title', STORYBOARD_LIMITS.title, `Shot ${index + 1}`),
      ...(shot.label !== undefined ? { label: shot.label } : {}),
      ...(Object.hasOwn(shot, 'storyboardAssetId') ? { storyboardAssetId: nullableId(shot.storyboardAssetId, 'storyboardAssetId') } : {}),
      description: text(shot.description, 'description', STORYBOARD_LIMITS.description),
      durationSeconds: duration(shot.durationSeconds), referenceAssetIds: references(shot.referenceAssetIds),
      status: status(shot.status), takes, selectedTakeId }
  })
  unique(shots.map(shot => shot.id), 'shot IDs')
  unique(shots.flatMap(shot => shot.takes.map(take => take.id)), 'board take IDs')
  getStoryboardLabelAllocation({ shots, nextShotNumber: value.nextShotNumber })
  return { version: STORYBOARD_VERSION, title: text(value.title, 'title', STORYBOARD_LIMITS.title, 'Storyboard'),
    brief: text(value.brief, 'brief', STORYBOARD_LIMITS.brief), songAssetId: nullableId(value.songAssetId, 'songAssetId'), shots,
    ...normalizeBoardDirection(value),
    ...(value.production != null ? { production: normalizeProduction(value.production, { shots }) } : {}),
    ...(value.productionRun != null ? { productionRun: normalizeProductionRun(value.productionRun) } : {}),
    ...(Object.hasOwn(value, 'referenceAssetIds') ? { referenceAssetIds: references(value.referenceAssetIds) } : {}),
    ...(value.nextShotNumber !== undefined ? { nextShotNumber: value.nextShotNumber } : {}) }
}

// A creative outline can exist before the user chooses a guided production
// type. Do not force a music-video/ad/film workflow just to save its direction.
function normalizeBoardDirection(value) {
  const result = {}
  for (const field of ['concept', 'visualStyle']) if (Object.hasOwn(value, field)) result[field] = text(value[field], field, 8000)
  if (Object.hasOwn(value, 'approach')) {
    if (!['undecided', 'performance', 'story', 'mixed'].includes(value.approach)) fail('approach must be undecided, performance, story, or mixed.')
    result.approach = value.approach
  }
  return result
}

export function isStoryboardSongAsset(asset) {
  return asset?.type === 'audio' || (asset?.type === 'video' && (asset.hasAudio === true || asset.settings?.hasAudio === true))
}

export function planStoryboardEdit(value, payload, assets = [], { idFactory = prefix => `${prefix}-${globalThis.crypto.randomUUID()}`, timelines = [] } = {}) {
  const board = normalizeStoryboard(value)
  const before = JSON.stringify(board)
  const allocation = getStoryboardLabelAllocation(board)
  const finish = result => result.changed ? { ...result, board: materializeStoryboardShotLabels(result.board, allocation) } : result
  object(payload, 'edit')
  if (PRODUCTION_RUN_OPERATIONS.includes(payload.operation)) {
    const result = planProductionRunEdit(board.productionRun, payload, { board, assets, timelines, idFactory })
    return finish({ ...result, board: result.changed ? { ...board, productionRun: result.run } : board })
  }
  if (PRODUCTION_OPERATIONS.includes(payload.operation)) return finish(planProductionEdit(board, payload, assets, { idFactory }))
  const asset = (assetId, allowed, name) => {
    id(assetId, name)
    const match = assets.find(item => item.id === assetId)
    if (!match) fail(`${name} "${assetId}" is missing from this project. Import it before attaching it.`)
    if (!allowed(match)) fail(`${name} is not a supported media type.`)
    return match
  }
  const validateReferences = (values, retainedIds = [], allowedTypes = ['image', 'video', 'audio']) => references(values).map(assetId => {
    // Project-only removal deliberately leaves inspectable missing links. A
    // full-array UI patch may retain those while removing another link; only
    // newly attached IDs need an existing, compatible project asset.
    if (!retainedIds.includes(assetId)) asset(assetId, item => allowedTypes.includes(item.type), 'reference asset')
    return assetId
  })
  const patchShot = (shot, patch) => {
    keys(patch, ['title', 'description', 'durationSeconds', 'referenceAssetIds', 'status', 'storyboardAssetId'], 'shot patch')
    if ('title' in patch) shot.title = text(patch.title, 'title', STORYBOARD_LIMITS.title)
    if ('description' in patch) shot.description = text(patch.description, 'description', STORYBOARD_LIMITS.description)
    if ('durationSeconds' in patch) shot.durationSeconds = duration(patch.durationSeconds)
    if ('referenceAssetIds' in patch) shot.referenceAssetIds = validateReferences(patch.referenceAssetIds, shot.referenceAssetIds)
    if ('status' in patch) shot.status = status(patch.status)
    if ('storyboardAssetId' in patch) {
      const storyboardAssetId = nullableId(patch.storyboardAssetId, 'storyboardAssetId')
      if (storyboardAssetId && storyboardAssetId !== shot.storyboardAssetId) asset(storyboardAssetId, item => item.type === 'image', 'storyboard frame asset')
      shot.storyboardAssetId = storyboardAssetId
    }
  }
  const requireShot = () => {
    id(payload.shotId, 'shotId')
    const shot = board.shots.find(item => item.id === payload.shotId)
    if (!shot) fail(`Shot "${payload.shotId}" was not found.`)
    return shot
  }
  const freshId = prefix => {
    const result = id(idFactory(prefix), `${prefix}Id`)
    if (board.shots.some(shot => shot.id === result || shot.takes.some(take => take.id === result))) fail('Generated ID already exists; please retry.')
    return result
  }
  let shotId, takeId
  switch (payload.operation) {
    case 'update_board': {
      keys(payload, ['operation', 'patch'], 'edit')
      keys(payload.patch, ['title', 'brief', 'songAssetId', 'referenceAssetIds', 'concept', 'visualStyle', 'approach'], 'board patch')
      const patch = payload.patch
      const direction = normalizeBoardDirection(patch)
      if (board.production && Object.keys(direction).length) {
        board.production = planProductionEdit(board, { operation: 'update_production', patch: direction }, assets).board.production
      } else Object.assign(board, direction)
      if ('title' in patch) board.title = text(patch.title, 'title', STORYBOARD_LIMITS.title)
      if ('brief' in patch) board.brief = text(patch.brief, 'brief', STORYBOARD_LIMITS.brief)
      if ('referenceAssetIds' in patch) {
        const next = validateReferences(patch.referenceAssetIds, board.referenceAssetIds, ['image', 'video'])
        if (next.length || Object.hasOwn(board, 'referenceAssetIds')) board.referenceAssetIds = next
      }
      if ('songAssetId' in patch) {
        const songAssetId = nullableId(patch.songAssetId, 'songAssetId')
        // Editing title/brief with an unchanged missing song must stay possible.
        if (songAssetId && songAssetId !== board.songAssetId) asset(songAssetId, isStoryboardSongAsset, 'song asset')
        board.songAssetId = songAssetId
      }
      break
    }
    case 'add_shot': {
      keys(payload, ['operation', 'shot', 'afterShotId'], 'edit')
      if (board.shots.length >= STORYBOARD_LIMITS.shots) fail(`A board supports at most ${STORYBOARD_LIMITS.shots} shots.`)
      const shot = { id: freshId('shot'), title: formatStoryboardShotLabel(allocation.nextShotNumber), description: '', durationSeconds: 5,
        referenceAssetIds: [], status: 'planned', takes: [], selectedTakeId: null }
      patchShot(shot, payload.shot === undefined ? {} : payload.shot)
      let index = board.shots.length
      if (payload.afterShotId != null) {
        id(payload.afterShotId, 'afterShotId')
        index = board.shots.findIndex(item => item.id === payload.afterShotId) + 1
        if (!index) fail('afterShotId was not found.')
      }
      board.shots.splice(index, 0, shot)
      shotId = shot.id
      break
    }
    case 'update_shot':
      keys(payload, ['operation', 'shotId', 'patch'], 'edit')
      patchShot(requireShot(), payload.patch)
      shotId = payload.shotId
      break
    case 'remove_shot':
      keys(payload, ['operation', 'shotId'], 'edit')
      requireShot()
      board.shots = board.shots.filter(shot => shot.id !== payload.shotId)
      if (board.production) board.production.shotDirections = board.production.shotDirections.filter(direction => direction.shotId !== payload.shotId)
      shotId = payload.shotId
      break
    case 'reorder_shots': {
      keys(payload, ['operation', 'shotIds'], 'edit')
      const ids = unique(array(payload.shotIds, 'shotIds', STORYBOARD_LIMITS.shots).map(value => id(value, 'shotId')), 'shotIds')
      if (ids.length !== board.shots.length || ids.some(value => !board.shots.some(shot => shot.id === value))) fail('shotIds must be an exact permutation of every current shot ID.')
      board.shots = ids.map(value => board.shots.find(shot => shot.id === value))
      break
    }
    case 'attach_take': {
      keys(payload, ['operation', 'shotId', 'assetId', 'label', 'prompt', 'workflowLabel'], 'edit')
      const shot = requireShot()
      const media = asset(payload.assetId, item => ['image', 'video'].includes(item.type), 'take asset')
      if (shot.takes.length >= STORYBOARD_LIMITS.takesPerShot) fail(`A shot supports at most ${STORYBOARD_LIMITS.takesPerShot} takes.`)
      if (shot.takes.some(take => take.assetId === payload.assetId)) fail('This asset already has a take in the shot.')
      takeId = freshId('take')
      shot.takes.push({ id: takeId, assetId: payload.assetId,
        label: text(payload.label, 'label', STORYBOARD_LIMITS.label, String(media.name || '').slice(0, STORYBOARD_LIMITS.label)),
        prompt: text(payload.prompt, 'prompt', STORYBOARD_LIMITS.prompt),
        workflowLabel: text(payload.workflowLabel, 'workflowLabel', STORYBOARD_LIMITS.workflowLabel) })
      if (!shot.selectedTakeId) shot.selectedTakeId = takeId
      shotId = shot.id
      break
    }
    case 'select_take':
    case 'remove_take': {
      keys(payload, ['operation', 'shotId', 'takeId'], 'edit')
      const shot = requireShot()
      id(payload.takeId, 'takeId')
      const take = shot.takes.find(item => item.id === payload.takeId)
      if (!take) fail('takeId does not belong to this shot.')
      if (payload.operation === 'select_take') {
        asset(take.assetId, item => ['image', 'video'].includes(item.type), 'take asset')
        shot.selectedTakeId = take.id
      } else {
        shot.takes = shot.takes.filter(item => item.id !== take.id)
        if (shot.selectedTakeId === take.id) shot.selectedTakeId = shot.takes[0]?.id || null
      }
      shotId = shot.id
      takeId = take.id
      break
    }
    default: fail('Unknown edit operation.')
  }
  return finish({ changed: JSON.stringify(board) !== before, board, operation: payload.operation,
    ...(shotId ? { shotId } : {}), ...(takeId ? { takeId } : {}) })
}
