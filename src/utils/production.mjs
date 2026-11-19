// Guided creative planning only. Review records describe the current plan;
// they are never generation jobs, payment approval, or media provenance.
import { getStoryboardShotLabel, getStoryboardShotVisual } from './storyboardPresentation.mjs'
export const PRODUCTION_VERSION = 1
export const PRODUCTION_TYPES = Object.freeze(['music-video', 'ad', 'ugc', 'short-film'])
export const PRODUCTION_STAGES = Object.freeze(['concept', 'cast-locations', 'animatic', 'generate', 'refine'])
export const PRODUCTION_OPERATIONS = Object.freeze(['start_production', 'update_production',
  'add_cast_member', 'update_cast_member', 'remove_cast_member', 'add_location', 'update_location',
  'remove_location', 'set_shot_direction', 'review_production_stage'])
export const PRODUCTION_LIMITS = Object.freeze({ cast: 20, locations: 20, references: 20, directions: 200,
  name: 200, role: 200, description: 4000, text: 8000, note: 4000, maxDurationSeconds: 3600, maxSongStartSeconds: 86400 })
const MODES = ['undecided', 'needed', 'none']
const APPROACHES = ['undecided', 'performance', 'story', 'mixed']
const fail = message => { throw new Error(`Production: ${message}`) }
const object = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object.`)
  return value
}
const fields = (value, allowed, name) => {
  object(value, name)
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${name} contains unsupported field "${key}"; it is read-only in this version.`)
}
const text = (value, max, name, fallback = '') => {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(`${name} must be text of at most ${max} characters.`)
  return value
}
const id = (value, name) => {
  if (typeof value !== 'string' || !value || value.length > 160 || /[\x00-\x20\x7f/\\]/.test(value)) fail(`${name} must be a project ID, not a path.`)
  return value
}
const choice = (value, options, name) => {
  if (!options.includes(value)) fail(`${name} must be one of: ${options.join(', ')}.`)
  return value
}
const number = (value, min, max, name, exclusiveMin = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || (exclusiveMin ? value <= min : value < min) || value > max) fail(`${name} is outside the supported range.`)
  return value
}
const list = (value, max, name) => {
  if (!Array.isArray(value) || value.length > max) fail(`${name} must be an array of at most ${max} items.`)
  return value
}
const unique = (values, name) => {
  if (new Set(values).size !== values.length) fail(`${name} must not contain duplicates.`)
  return values
}
const ids = (value, max, name) => unique(list(value, max, name).map(entry => id(entry, name)), name)
const visual = asset => ['image', 'video'].includes(asset?.type)
const song = asset => asset?.type === 'audio' || (asset?.type === 'video' && (asset.hasAudio === true || asset.settings?.hasAudio === true))
const clone = value => JSON.parse(JSON.stringify(value))
const SCALARS = ['targetDurationSeconds', 'songStartSeconds', 'approach', 'concept', 'visualStyle', 'audience', 'mustInclude', 'delegation', 'castMode', 'locationMode']

export function createProduction(type, targetDurationSeconds = 45) {
  return { version: PRODUCTION_VERSION, type: choice(type, PRODUCTION_TYPES, 'productionType'),
    targetDurationSeconds: number(targetDurationSeconds, 0, PRODUCTION_LIMITS.maxDurationSeconds, 'targetDurationSeconds', true),
    songStartSeconds: 0, approach: 'undecided', concept: '', visualStyle: '', audience: '', mustInclude: '',
    delegation: 'guided', castMode: 'undecided', locationMode: 'undecided', cast: [], locations: [], shotDirections: [], reviews: [] }
}

function normalizeEntity(value, isCast) {
  fields(value, ['id', 'name', 'description', 'referenceAssetIds', ...(isCast ? ['role'] : [])], isCast ? 'cast member' : 'location')
  return { id: id(value.id, isCast ? 'memberId' : 'locationId'), name: text(value.name, 200, 'name'),
    ...(isCast ? { role: text(value.role, 200, 'role') } : {}), description: text(value.description, 4000, 'description'),
    referenceAssetIds: ids(value.referenceAssetIds, 20, 'referenceAssetIds') }
}

export function normalizeProduction(value, { shots } = {}) {
  if (value == null) return null
  object(value, 'production')
  if (value.version !== PRODUCTION_VERSION) fail(`Unsupported version ${String(value.version)}; this production is read-only and has been preserved.`)
  fields(value, ['version', 'type', ...SCALARS, 'cast', 'locations', 'shotDirections', 'reviews'], 'production')
  const result = { version: PRODUCTION_VERSION, type: choice(value.type, PRODUCTION_TYPES, 'type'),
    targetDurationSeconds: number(value.targetDurationSeconds, 0, 3600, 'targetDurationSeconds', true),
    songStartSeconds: number(value.songStartSeconds, 0, 86400, 'songStartSeconds'),
    approach: choice(value.approach, APPROACHES, 'approach'),
    concept: text(value.concept, 8000, 'concept'), visualStyle: text(value.visualStyle, 8000, 'visualStyle'),
    audience: text(value.audience, 8000, 'audience'), mustInclude: text(value.mustInclude, 8000, 'mustInclude'),
    delegation: choice(value.delegation, ['guided', 'agent-led'], 'delegation'),
    castMode: choice(value.castMode, MODES, 'castMode'), locationMode: choice(value.locationMode, MODES, 'locationMode'),
    cast: list(value.cast, 20, 'cast').map(entry => normalizeEntity(entry, true)),
    locations: list(value.locations, 20, 'locations').map(entry => normalizeEntity(entry, false)),
    shotDirections: [], reviews: [] }
  unique(result.cast.map(entry => entry.id), 'cast IDs')
  unique(result.locations.map(entry => entry.id), 'location IDs')
  unique([...result.cast, ...result.locations].map(entry => entry.id), 'production entity IDs')
  result.shotDirections = list(value.shotDirections, 200, 'shotDirections').map(direction => {
    fields(direction, ['shotId', 'castIds', 'locationId', 'lipSync', 'notes'], 'shot direction')
    const shotId = id(direction.shotId, 'shotId')
    if (shots && !shots.some(shot => shot.id === shotId)) fail('Shot direction refers to a missing shot.')
    const castIds = ids(direction.castIds, 20, 'castIds')
    if (castIds.some(memberId => !result.cast.some(member => member.id === memberId))) fail('Shot direction refers to a missing cast member.')
    const locationId = direction.locationId == null ? null : id(direction.locationId, 'locationId')
    if (locationId && !result.locations.some(location => location.id === locationId)) fail('Shot direction refers to a missing location.')
    if (typeof direction.lipSync !== 'boolean') fail('lipSync must be a boolean.')
    return { shotId, castIds, locationId, lipSync: direction.lipSync, notes: text(direction.notes, 4000, 'notes') }
  })
  unique(result.shotDirections.map(direction => direction.shotId), 'shot direction IDs')
  result.reviews = list(value.reviews, 5, 'reviews').map(review => {
    fields(review, ['stage', 'decision', 'fingerprint', 'note'], 'review')
    const fingerprint = text(review.fingerprint, 100, 'fingerprint')
    if (!/^production-v1-[a-f0-9]{32}$/.test(fingerprint)) fail('Review fingerprint is invalid.')
    return { stage: choice(review.stage, PRODUCTION_STAGES, 'stage'), decision: choice(review.decision, ['approve', 'reopen'], 'decision'),
      fingerprint, note: text(review.note, 4000, 'note') }
  })
  unique(result.reviews.map(review => review.stage), 'review stages')
  return result
}

const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)
// Deterministic content signature, not a security token or file-content hash.
function fingerprint(value) {
  const data = canonical(value)
  const seeds = [2166136261, 2246822507, 3266489909, 668265263]
  return `production-v1-${seeds.map(seed => {
    let hash = seed
    for (let index = 0; index < data.length; index += 1) hash = Math.imul(hash ^ data.charCodeAt(index), 16777619) >>> 0
    return hash.toString(16).padStart(8, '0')
  }).join('')}`
}
const assetDuration = asset => {
  const duration = Number(asset?.duration ?? asset?.settings?.duration)
  return Number.isFinite(duration) && duration > 0 ? duration : null
}
const assetIdentity = asset => asset ? { id: asset.id, type: asset.type, path: asset.path || asset.absolutePath || null,
  duration: assetDuration(asset), width: asset.width ?? asset.settings?.width ?? null, height: asset.height ?? asset.settings?.height ?? null,
  hasAudio: asset.hasAudio ?? asset.settings?.hasAudio ?? null,
  sourceVersion: asset.sourceVersion ?? asset.settings?.sourceVersion ?? asset.modified ?? asset.updatedAt ?? null } : null

export function computeAnimaticShots(board) {
  let cursor = 0
  return (board?.shots || []).map(shot => {
    const startSeconds = cursor
    cursor += shot.durationSeconds
    return { shotId: shot.id, startSeconds, endSeconds: cursor, durationSeconds: shot.durationSeconds }
  })
}

// Animatic review deliberately uses actual image assets, not a video first
// frame that would hide a missing storyboard still or require decoding.
export function getProductionShotVisual(_board, shot, assets = []) {
  return getStoryboardShotVisual(shot, assets)
}

export function getProductionGuide(board, assets = []) {
  const production = normalizeProduction(board?.production, { shots: board?.shots || [] })
  if (!production) return { production: null, stages: [], nextStage: null,
    questions: ['What would you like to make, and what story or feeling do you already have in mind?'],
    suggestedActions: ['Listen to the creator’s idea first, then propose one concrete next creative step and ask whether they want it.'],
    summary: { type: null, generationAuthorized: false },
    handoffPrompt: 'Help me start a creative production in Velorn. Ask about my story or concept first, then my casting intent, existing people/photos, and reference preferences. Ask one simple creative question at a time. Propose a concrete next step and ask yes or no before acting unless I explicitly delegated that whole scope in this conversation. Never generate first and ask afterward. The board is a read-only visual reference page; an animatic is an ordinary editable Velorn timeline created only when requested. Do not generate media, spend credits, import, edit the timeline, or export without separate authorization.' }
  const media = new Map(assets.map(asset => [asset.id, asset]))
  const shots = board.shots || []
  const label = shot => getStoryboardShotLabel(board, shot)
  const soundtrack = media.get(board.songAssetId)
  const totalDurationSeconds = shots.reduce((total, shot) => total + shot.durationSeconds, 0)
  const currentReview = stage => production.reviews.find(review => review.stage === stage)
  const reviewIdentity = stage => {
    const review = currentReview(stage)
    return review ? { decision: review.decision, fingerprint: review.fingerprint } : null
  }
  const entityIdentity = entity => ({ ...entity, references: entity.referenceAssetIds.map(assetId => assetIdentity(media.get(assetId))) })
  const directions = shots.map(shot => production.shotDirections.find(direction => direction.shotId === shot.id) || null)
  const selectedTakes = shots.map(shot => {
    const take = shot.takes.find(entry => entry.id === shot.selectedTakeId)
    return { shotId: shot.id, take: take || null, asset: assetIdentity(media.get(take?.assetId)) }
  })
  const inputs = {
    concept: { type: production.type, targetDurationSeconds: production.targetDurationSeconds, songStartSeconds: production.songStartSeconds,
      approach: production.approach, concept: production.concept, visualStyle: production.visualStyle, audience: production.audience,
      mustInclude: production.mustInclude, brief: board.brief, songAssetId: board.songAssetId, song: assetIdentity(soundtrack),
      references: (board.referenceAssetIds || []).map(assetId => ({ assetId, asset: assetIdentity(media.get(assetId)) })) },
    'cast-locations': { castMode: production.castMode, locationMode: production.locationMode,
      cast: production.cast.map(entityIdentity), locations: production.locations.map(entityIdentity) },
    animatic: { shots: shots.map(shot => ({ id: shot.id, title: shot.title, description: shot.description, durationSeconds: shot.durationSeconds,
      stillAssetId: getProductionShotVisual(board, shot, assets)?.assetId || null,
      stillAsset: assetIdentity(getProductionShotVisual(board, shot, assets)?.asset),
      references: shot.referenceAssetIds.map(assetId => ({ assetId, asset: assetIdentity(media.get(assetId)) })),
      images: shot.takes.filter(take => media.get(take.assetId)?.type === 'image').map(take => ({ assetId: take.assetId, asset: assetIdentity(media.get(take.assetId)) })) })), directions },
    generate: { selectedTakes }, refine: { selectedTakes, statuses: shots.map(shot => ({ id: shot.id, status: shot.status })) },
  }
  const problems = Object.fromEntries(PRODUCTION_STAGES.map(stage => [stage, []]))
  const conceptProblems = problems.concept
  if (production.concept.trim().length < 12) conceptProblems.push('Describe a clear creative idea in a sentence before approving the concept.')
  if (production.visualStyle.trim().length < 3) conceptProblems.push('Describe the visual style in a few words.')
  if (production.type === 'music-video' && production.approach === 'undecided') conceptProblems.push('Choose performance, story, or a mix for the music video.')
  if (['ad', 'ugc'].includes(production.type) && production.audience.trim().length < 3) conceptProblems.push('Describe who this video should reach.')
  if (production.type === 'music-video' || board.songAssetId != null) {
    if (!song(soundtrack)) conceptProblems.push('Choose an existing audio or audio-bearing video asset as the song.')
    else if (!assetDuration(soundtrack)) conceptProblems.push('The song needs a known duration before its excerpt can be reviewed.')
    else if (production.songStartSeconds + production.targetDurationSeconds > assetDuration(soundtrack) + 0.05) conceptProblems.push('The chosen song excerpt extends past the end of the song. Shorten it or choose an earlier start.')
  }
  for (const [mode, entities, kind] of [[production.castMode, production.cast, 'cast'], [production.locationMode, production.locations, 'location']]) {
    if (mode === 'undecided') problems['cast-locations'].push(`Decide whether ${kind === 'cast' ? 'characters or performers' : 'specific locations'} are needed.`)
    if (mode === 'none' && entities.length) problems['cast-locations'].push(`Remove the unused ${kind} entries or mark them as needed.`)
    if (mode === 'needed' && !entities.length) problems['cast-locations'].push(`Add at least one ${kind} entry, or explicitly choose none.`)
    for (const entity of entities) {
      if (!entity.name.trim()) problems['cast-locations'].push(`Give each ${kind} a name.`)
      if (!entity.referenceAssetIds.length) problems['cast-locations'].push(`Add a visual reference for ${entity.name || kind}.`)
      else if (entity.referenceAssetIds.some(assetId => !visual(media.get(assetId)))) problems['cast-locations'].push(`Fix the missing or incompatible visual references for ${entity.name || kind}.`)
    }
  }
  if (!shots.length) problems.animatic.push('Plan at least one shot before reviewing the animatic.')
  if (Math.abs(totalDurationSeconds - production.targetDurationSeconds) > 0.05 + 1e-8) problems.animatic.push(`Shot durations total ${Number(totalDurationSeconds.toFixed(3))}s; adjust them to the ${production.targetDurationSeconds}s target (within 0.05s).`)
  for (const shot of shots) {
    const direction = production.shotDirections.find(entry => entry.shotId === shot.id)
    if (!shot.description.trim()) problems.animatic.push(`${label(shot)} needs an action or purpose.`)
    if (!getProductionShotVisual(board, shot, assets)) problems.animatic.push(`${label(shot)} needs an existing image as a storyboard still.`)
    if (!direction) problems.animatic.push(`${label(shot)} needs a direction decision for cast, location, and lip sync.`)
    else {
      if (production.locationMode === 'needed' && !direction.locationId) problems.animatic.push(`${label(shot)} needs a location.`)
      if (direction.lipSync && !direction.castIds.length) problems.animatic.push(`${label(shot)} needs a performer for lip sync.`)
      if (production.castMode === 'none' && direction.castIds.length) problems.animatic.push(`${label(shot)} uses cast despite the no-cast decision.`)
    }
    const take = shot.takes.find(entry => entry.id === shot.selectedTakeId)
    if (media.get(take?.assetId)?.type !== 'video') problems.generate.push(`${label(shot)} needs a selected, existing video take. Creating one requires separate generation approval.`)
    if (shot.status !== 'approved') problems.refine.push(`${label(shot)} still needs final shot approval after reviewing its selected take.`)
  }
  const titles = ['Concept', 'Cast & locations', 'Animatic', 'Video takes', 'Refine & review']
  const stages = []
  for (let index = 0; index < PRODUCTION_STAGES.length; index += 1) {
    const stageId = PRODUCTION_STAGES[index]
    const previous = stages.at(-1)
    const currentFingerprint = fingerprint({ stage: stageId, inputs: inputs[stageId],
      upstream: previous ? { fingerprint: previous.fingerprint, review: reviewIdentity(previous.id) } : null })
    const review = currentReview(stageId)
    const blockers = [...problems[stageId]]
    if (previous && previous.state !== 'approved') blockers.unshift(`Approve the current ${previous.title.toLowerCase()} stage first.`)
    const stale = review?.decision === 'approve' && review.fingerprint !== currentFingerprint
    const approved = review?.decision === 'approve' && !stale && !blockers.length
    stages.push({ id: stageId, title: titles[index], state: approved ? 'approved' : stale ? 'stale' : blockers.length ? 'blocked' : 'ready',
      blockers: blockers.length > 12 ? [...blockers.slice(0, 12), `${blockers.length - 12} additional items need attention.`] : blockers,
      fingerprint: currentFingerprint, approved, review: review ? { ...review } : null })
  }
  const next = stages.find(stage => stage.state !== 'approved') || null
  const questions = []
  const suggestedActions = []
  if (next?.id === 'concept') {
    if (production.concept.trim().length < 12) questions.push(production.type === 'ad' || production.type === 'ugc'
      ? 'What idea do you have in mind, and what is the one thing you want viewers to remember or do?'
      : 'What story, concept, or feeling do you already have in mind?')
    else if (production.type === 'music-video' && !song(soundtrack)) questions.push('Which song would you like to use? Import it, or choose one already in the project.')
    else if (board.songAssetId && !song(soundtrack)) questions.push('Would you like to relink the missing soundtrack, choose a different one, or keep this video without music?')
    else if (song(soundtrack) && !assetDuration(soundtrack)) questions.push('Could you relink the song so we can check its length before choosing the excerpt?')
    else if (song(soundtrack) && production.songStartSeconds + production.targetDurationSeconds > assetDuration(soundtrack) + 0.05) questions.push('Which section of the song should we use—an earlier start, or a shorter excerpt?')
    else if (production.type === 'music-video' && production.approach === 'undecided') questions.push('Do you picture a performance, a story, or a mix of both?')
    else if (production.visualStyle.trim().length < 3) questions.push('What visual feel would suit it—for example, intimate and natural or bold and cinematic?')
    else if (['ad', 'ugc'].includes(production.type) && production.audience.trim().length < 3) questions.push('Who do you want this video to reach?')
    else questions.push('Does this concept and visual direction feel right, or would you like to change anything before approving it?')
    suggestedActions.push('Ask about the creator’s concept and visual references before proposing decisions. Offer one concrete next step and get a yes or no unless that scope was explicitly delegated in this conversation.')
  } else if (next?.id === 'cast-locations') {
    if (production.castMode === 'undecided') questions.push('Who should appear—do you have existing people or photos in mind, want proposed characters, or prefer no cast?')
    else if (production.locationMode === 'undecided') questions.push('May I propose a small set of environments that support this story?')
    else if (production.castMode === 'none' && production.cast.length) questions.push('Should we remove the unused cast entries, or include those characters in this idea?')
    else if (production.locationMode === 'none' && production.locations.length) questions.push('Should we remove the unused locations, or include those environments in this idea?')
    else if (production.castMode === 'needed' && !production.cast.length) questions.push('Do you have an existing person and reference photos for the lead, or would you like me to propose a character?')
    else if (production.locationMode === 'needed' && !production.locations.length) questions.push('May I propose a small set of environments that supports this concept?')
    else {
      const entity = [...production.cast, ...production.locations].find(entry => !entry.name.trim()
        || !entry.referenceAssetIds.length || entry.referenceAssetIds.some(assetId => !visual(media.get(assetId))))
      if (entity && !entity.name.trim()) questions.push('What should we call this character or environment?')
      else if (entity) questions.push(`Do you have existing photos for ${entity.name}, or would you like me to propose visual reference options?`)
      else questions.push('Do these cast and location references fit the idea, or should we adjust anything before approving them?')
    }
    suggestedActions.push('Confirm casting intent, existing people/photos, and reference preferences before deciding or generating. Propose only the needed cast and environments, then ask permission for the concrete next step.')
  } else if (next?.id === 'animatic') {
    const missingAction = shots.find(shot => !shot.description.trim())
    const missingStill = shots.find(shot => !getProductionShotVisual(board, shot, assets))
    if (!shots.length) questions.push('May I propose a short sequence of shots that tells this story within the target length?')
    else if (missingAction) questions.push(`What should happen in ${label(missingAction)}, or would you like me to propose its action?`)
    else if (missingStill) questions.push(`Do you have a still image for ${label(missingStill)}, or should we plan a reference image for it?`)
    else if (Math.abs(totalDurationSeconds - production.targetDurationSeconds) > 0.05 + 1e-8) questions.push(`The shots run ${Number(totalDurationSeconds.toFixed(3))} seconds; may I suggest timing changes to fit the ${production.targetDurationSeconds}-second target?`)
    else if (next.blockers.length) questions.push('May I suggest the remaining cast, location, and lip-sync choices for these shots?')
    else questions.push('Would you like me to preview building an animatic from these stills and the song in a new, ordinary Velorn timeline?')
    suggestedActions.push('Keep this board as a read-only visual reference page. Only when requested, preview a separate ordinary timeline with the explicit storyboard stills, planned timings, and song excerpt. The board has no playback or approval controls.')
  } else if (next?.id === 'generate') {
    questions.push(next.blockers.length
      ? 'Would you like me to propose an animation plan for the next shot? I will wait for approval before generating it or spending credits.'
      : 'Do the selected video takes match the reviewed animatic, or would you like to change a take before approving them?')
    suggestedActions.push('Propose the next concrete video-generation step and ask yes or no before running it, unless its full execution scope was explicitly delegated in this conversation. Never generate first and ask afterward; saved agent-led preference is not execution permission.')
  } else if (next?.id === 'refine') {
    questions.push(next.blockers.length ? 'Which selected take needs refinement, or are you ready to mark the shots you have reviewed as approved?'
      : 'Are you happy with the reviewed shots and ready to approve this final production review?')
    suggestedActions.push('Review the selected video take for each shot, refine only what needs improvement, and mark accepted shots approved.')
  } else suggestedActions.push('The production plan and selected takes are reviewed. Within the agreed scope, assemble and review the ordinary editable Velorn timeline. The handoff is ready for review in Velorn; do not export unless the user explicitly asks for a file.')
  if (next && !next.blockers.length) suggestedActions.push(`Review and approve ${next.title.toLowerCase()} when the creator is satisfied.`)
  const summary = { type: production.type, targetDurationSeconds: production.targetDurationSeconds, totalDurationSeconds,
    shotCount: shots.length, castCount: production.cast.length, locationCount: production.locations.length,
    approvedStageCount: stages.filter(stage => stage.approved).length, generationAuthorized: false }
  const handoffPrompt = [
    `Help me develop this ${production.type} in Velorn's shared Storyboard. Inspect get_storyboard and get_production_guide before editing.`,
    `Current next stage: ${next?.title || 'reviewed plan'}. Target: ${production.targetDurationSeconds} seconds. Collaboration preference: ${production.delegation}; this saved preference is not permission or proof of delegated scope.`,
    `Concept: ${production.concept.slice(0, 1800) || 'Not chosen yet'}. Visual style: ${production.visualStyle.slice(0, 600) || 'Not chosen yet'}.`,
    'Ask about the creator’s story/concept, casting intent (including existing people/photos), and reference preferences before deciding or generating. Ask one plain-language question at a time, not a technical questionnaire; propose environments that serve the story.',
    'Ask yes or no for each concrete next creative step unless the user explicitly delegated that whole scope in this conversation. Never generate first and ask whether they wanted it afterward.',
    'Use exact shot/member/location and existing asset IDs. Preview every edit, then apply the unchanged token/context only with approval. Preserve Director and the existing timeline.',
    'The board is a read-only visual reference page with no forms, approval buttons, or player. Only when the user asks for an animatic, preview creation/switching of a separate ordinary Velorn timeline and place the stills and song excerpt with existing timeline tools. Preserve the original edit and use a checkpoint for the multi-step change. Add labels or text overlays only if requested.',
    'Stage review is creative review only: it never authorizes generation, cloud spend, downloads, timeline edits, or export. Use explicit storyboardAssetId for a shot’s first-frame image; keep it when selecting a later video take.',
    'Read the accompanying recipe and productionRun record. Ask whether the user has a model/workflow in mind before recommending one. Verify current capabilities against this machine; do not assume a particular GPU or silently downgrade quality. Test one approved audition before a larger batch. The finish line is an editable timeline ready to review in Velorn, not an export. Export only on explicit request.',
    ...(questions.length ? [`Ask next: ${questions[0]}`] : []),
    ...(next?.blockers.length ? [`Current blockers: ${next.blockers.join(' ')}`] : []),
  ].join('\n')
  return { production, stages, nextStage: next?.id || null, questions: questions.slice(0, 2), suggestedActions, summary, handoffPrompt }
}

export function planProductionEdit(value, payload, assets = [], { idFactory = prefix => `${prefix}-${globalThis.crypto.randomUUID()}` } = {}) {
  const board = clone(value)
  const before = canonical(board)
  object(payload, 'edit')
  let memberId, locationId
  const requireProduction = () => {
    if (!board.production) fail('Start a production before editing its plan.')
    board.production = normalizeProduction(board.production, { shots: board.shots })
    return board.production
  }
  const freshId = prefix => {
    const generated = id(idFactory(prefix), `${prefix} ID`)
    const used = [...(board.production?.cast || []), ...(board.production?.locations || []), ...board.shots, ...board.shots.flatMap(shot => shot.takes)]
    if (used.some(entry => entry.id === generated)) fail('Generated ID already exists; please retry.')
    return generated
  }
  const patchEntity = (entity, patch, isCast) => {
    fields(patch, ['name', 'description', 'referenceAssetIds', ...(isCast ? ['role'] : [])], 'entity patch')
    for (const key of ['name', 'description', ...(isCast ? ['role'] : [])]) if (key in patch) entity[key] = text(patch[key], key === 'description' ? 4000 : 200, key)
    if ('referenceAssetIds' in patch) {
      const references = ids(patch.referenceAssetIds, 20, 'referenceAssetIds')
      for (const assetId of references) {
        if (!entity.referenceAssetIds.includes(assetId) && !visual(assets.find(asset => asset.id === assetId))) fail(`Visual reference "${assetId}" must be an existing image or video asset.`)
      }
      entity.referenceAssetIds = references
    }
  }
  if (payload.operation === 'start_production') {
    fields(payload, ['operation', 'productionType', 'targetDurationSeconds'], 'edit')
    const next = createProduction(payload.productionType, payload.targetDurationSeconds)
    if (board.production) {
      const existing = requireProduction()
      if (existing.type !== next.type) fail('This board already has a different production type. It was not replaced.')
      if (payload.targetDurationSeconds !== undefined && payload.targetDurationSeconds !== existing.targetDurationSeconds) fail('Use update_production to change the duration of an existing production.')
    } else {
      // Adopt the previously saved outline instead of losing it or inventing
      // a production type when the user only asked to save creative direction.
      for (const field of ['concept', 'visualStyle', 'approach']) if (Object.hasOwn(board, field)) {
        next[field] = board[field]; delete board[field]
      }
      board.production = next
    }
  } else {
    const production = requireProduction()
    switch (payload.operation) {
      case 'update_production': {
        fields(payload, ['operation', 'patch', 'songAssetId'], 'edit')
        fields(payload.patch, SCALARS, 'production patch')
        Object.assign(production, payload.patch)
        if ('songAssetId' in payload) {
          const songAssetId = payload.songAssetId == null ? null : id(payload.songAssetId, 'songAssetId')
          if (songAssetId && songAssetId !== board.songAssetId && !song(assets.find(asset => asset.id === songAssetId))) fail('The song must be an existing audio or audio-bearing video asset.')
          board.songAssetId = songAssetId
        }
        break
      }
      case 'add_cast_member':
      case 'add_location': {
        const isCast = payload.operation === 'add_cast_member'
        fields(payload, ['operation', isCast ? 'member' : 'location'], 'edit')
        const entries = isCast ? production.cast : production.locations
        if (entries.length >= 20) fail(`A production supports at most 20 ${isCast ? 'cast members' : 'locations'}.`)
        const entity = { id: freshId(isCast ? 'cast' : 'location'), name: `${isCast ? 'Cast member' : 'Location'} ${entries.length + 1}`,
          ...(isCast ? { role: '' } : {}), description: '', referenceAssetIds: [] }
        const details = payload[isCast ? 'member' : 'location']
        patchEntity(entity, details === undefined ? {} : details, isCast)
        entries.push(entity)
        if (isCast) { memberId = entity.id; production.castMode = 'needed' }
        else { locationId = entity.id; production.locationMode = 'needed' }
        break
      }
      case 'update_cast_member':
      case 'remove_cast_member':
      case 'update_location':
      case 'remove_location': {
        const isCast = payload.operation.endsWith('cast_member')
        const remove = payload.operation.startsWith('remove_')
        const idKey = isCast ? 'memberId' : 'locationId'
        fields(payload, ['operation', idKey, ...(remove ? [] : ['patch'])], 'edit')
        const entityId = id(payload[idKey], idKey)
        const entries = isCast ? production.cast : production.locations
        const entity = entries.find(entry => entry.id === entityId)
        if (!entity) fail(`${isCast ? 'Cast member' : 'Location'} was not found.`)
        if (remove) {
          if (isCast) production.cast = entries.filter(entry => entry.id !== entityId)
          else production.locations = entries.filter(entry => entry.id !== entityId)
          production.shotDirections = production.shotDirections.map(direction => ({ ...direction,
            ...(isCast ? { castIds: direction.castIds.filter(entry => entry !== entityId) }
              : { locationId: direction.locationId === entityId ? null : direction.locationId }) }))
        } else patchEntity(entity, payload.patch, isCast)
        if (isCast) memberId = entityId
        else locationId = entityId
        break
      }
      case 'set_shot_direction': {
        fields(payload, ['operation', 'shotId', 'patch'], 'edit')
        const shotId = id(payload.shotId, 'shotId')
        if (!board.shots.some(shot => shot.id === shotId)) fail('Shot was not found.')
        fields(payload.patch, ['castIds', 'locationId', 'lipSync', 'notes'], 'shot direction patch')
        const direction = production.shotDirections.find(entry => entry.shotId === shotId)
          || { shotId, castIds: [], locationId: null, lipSync: false, notes: '' }
        Object.assign(direction, payload.patch)
        if (!production.shotDirections.some(entry => entry.shotId === shotId)) production.shotDirections.push(direction)
        break
      }
      case 'review_production_stage': {
        fields(payload, ['operation', 'stage', 'decision', 'note'], 'edit')
        const stageId = choice(payload.stage, PRODUCTION_STAGES, 'stage')
        const decision = choice(payload.decision, ['approve', 'reopen'], 'decision')
        const note = text(payload.note, 4000, 'note')
        const stage = getProductionGuide(board, assets).stages.find(entry => entry.id === stageId)
        if (decision === 'approve' && stage.blockers.length) fail(`Cannot approve ${stage.title.toLowerCase()}: ${stage.blockers.join(' ')}`)
        const index = PRODUCTION_STAGES.indexOf(stageId)
        production.reviews = production.reviews.filter(review => review.stage !== stageId
          && (decision !== 'reopen' || PRODUCTION_STAGES.indexOf(review.stage) < index))
        production.reviews.push({ stage: stageId, decision, fingerprint: stage.fingerprint, note })
        production.reviews.sort((a, b) => PRODUCTION_STAGES.indexOf(a.stage) - PRODUCTION_STAGES.indexOf(b.stage))
        break
      }
      default: fail('Unknown production operation.')
    }
    board.production = normalizeProduction(production, { shots: board.shots })
  }
  return { changed: canonical(board) !== before, board, operation: payload.operation,
    ...(memberId ? { memberId } : {}), ...(locationId ? { locationId } : {}) }
}
