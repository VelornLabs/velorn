import test from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultStoryboard, normalizeStoryboard, planStoryboardEdit } from './storyboard.mjs'
import { createProduction, normalizeProduction, getProductionGuide, getProductionShotVisual,
  computeAnimaticShots, PRODUCTION_STAGES, PRODUCTION_LIMITS } from './production.mjs'
import { getProjectAssetReferences } from './projectAssetReferences.mjs'

const assets = [{ id: 'song', type: 'audio', duration: 90 }, { id: 'image', type: 'image' },
  { id: 'other-image', type: 'image' }, { id: 'video', type: 'video', hasAudio: true, duration: 60 },
  { id: 'silent', type: 'video', hasAudio: false }, { id: 'text', type: 'text' }]
let sequence = 0
const edit = (board, payload, media = assets) => planStoryboardEdit(board, payload, media,
  { idFactory: prefix => `${prefix}-${++sequence}` })
const start = (type = 'music-video') => edit(undefined, { operation: 'start_production', productionType: type }).board
const patch = (board, values, extra = {}) => edit(board, { operation: 'update_production', patch: values, ...extra }).board
const approve = (board, stage, media = assets) => edit(board, { operation: 'review_production_stage', stage, decision: 'approve' }, media).board
const guide = (board, media = assets) => getProductionGuide(board, media)
const stage = (board, id, media = assets) => guide(board, media).stages.find(entry => entry.id === id)
const concept = (type = 'music-video') => patch(start(type), { concept: 'A traveler finds connection through a changing city.',
  visualStyle: 'Natural cinematic light', audience: 'Curious creative adults', approach: 'mixed' }, type === 'music-video' ? { songAssetId: 'song' } : {})
function animatic() {
  let board = approve(concept(), 'concept')
  board = patch(board, { castMode: 'none', locationMode: 'none' })
  board = approve(board, 'cast-locations')
  const result = edit(board, { operation: 'add_shot', shot: { title: 'Opening', description: 'The traveler looks across the city.',
    durationSeconds: 45, referenceAssetIds: ['image'] } })
  return edit(result.board, { operation: 'set_shot_direction', shotId: result.shotId, patch: {} }).board
}
function completed() {
  let board = approve(animatic(), 'animatic')
  board = edit(board, { operation: 'attach_take', shotId: board.shots[0].id, assetId: 'video' }).board
  board = approve(board, 'generate')
  board = edit(board, { operation: 'update_shot', shotId: board.shots[0].id, patch: { status: 'approved' } }).board
  return approve(board, 'refine')
}

test('production is optional, portable, pure, and rejects future data without resetting it', () => {
  const legacy = createDefaultStoryboard()
  assert.equal(Object.hasOwn(normalizeStoryboard(legacy), 'production'), false)
  assert.deepEqual(guide(legacy).stages, [])
  assert.equal(guide(legacy).production, null)
  assert.equal(guide(legacy).summary.generationAuthorized, false)
  const board = start()
  assert.deepEqual(normalizeStoryboard(JSON.parse(JSON.stringify(board))), board)
  assert.equal(board.production.targetDurationSeconds, 45)
  assert.equal(edit(board, { operation: 'start_production', productionType: 'music-video' }).changed, false)
  assert.throws(() => edit(board, { operation: 'start_production', productionType: 'ad' }), /different production type/)
  assert.throws(() => edit(board, { operation: 'start_production', productionType: 'music-video', targetDurationSeconds: 30 }), /update_production/)
  for (const production of [{ ...board.production, version: 2 }, { ...board.production, future: 'keep' }]) {
    const source = { ...board, production }, before = JSON.stringify(source)
    assert.throws(() => normalizeStoryboard(source), /read-only/)
    assert.throws(() => edit(source, { operation: 'update_board', patch: { title: 'Overwrite' } }), /read-only/)
    assert.throws(() => guide(source), /read-only/)
    assert.equal(JSON.stringify(source), before)
  }
  assert.deepEqual(normalizeProduction(undefined), null)
})

test('production scalars and entity payloads strictly validate bounds, enums, fields, and paths', () => {
  const board = start(), before = JSON.stringify(board)
  for (const values of [{ targetDurationSeconds: 0 }, { targetDurationSeconds: 3601 }, { targetDurationSeconds: NaN },
    { songStartSeconds: -1 }, { songStartSeconds: 86401 }, { targetDurationSeconds: '45' }, { delegation: 'automatic' },
    { castMode: null }, { locationMode: 'optional' }, { approach: 'custom' }, { concept: 'x'.repeat(8001) },
    { visualStyle: null }, { concept: 'bad\0value' }, { type: 'ad' }, { reviews: [] }, { songAssetId: 'song' }]) {
    assert.throws(() => patch(board, values))
  }
  for (const operation of ['add_cast_member', 'add_location']) {
    const key = operation === 'add_cast_member' ? 'member' : 'location'
    for (const value of [null, [], { id: 'injected' }, { path: '/tmp/file.png' }, { name: 'x'.repeat(201) },
      { referenceAssetIds: ['image', 'image'] }, { referenceAssetIds: ['song'] }, { referenceAssetIds: ['missing'] },
      { referenceAssetIds: ['/tmp/image.png'] }]) assert.throws(() => edit(board, { operation, [key]: value }))
  }
  assert.throws(() => edit(undefined, { operation: 'update_production', patch: {} }), /Start a production/)
  assert.throws(() => createProduction('movie'), /productionType/)
  assert.equal(JSON.stringify(board), before)
  assert.equal(patch(board, { targetDurationSeconds: 3600, songStartSeconds: 86400 }).production.songStartSeconds, 86400)
  assert.equal(edit(board, { operation: 'update_production', patch: {} }).changed, false)
})

test('song selection and creative details apply atomically with retained missing-song cleanup', () => {
  const board = start(), before = JSON.stringify(board)
  for (const songAssetId of ['image', 'silent', 'missing', '/tmp/song.wav']) {
    assert.throws(() => patch(board, { concept: 'Must not partially save this concept.' }, { songAssetId }))
    assert.equal(JSON.stringify(board), before)
  }
  const updated = patch(board, { concept: 'One atomic concept and soundtrack change.' }, { songAssetId: 'video' })
  assert.equal(updated.songAssetId, 'video')
  assert.match(updated.production.concept, /atomic/)
  const retained = edit(updated, { operation: 'update_production', patch: { visualStyle: 'Night' }, songAssetId: 'video' }, []).board
  assert.equal(retained.songAssetId, 'video')
  assert.throws(() => edit(retained, { operation: 'update_production', patch: {}, songAssetId: 'song' }, []), /existing audio/)
  assert.equal(edit(retained, { operation: 'update_production', patch: {}, songAssetId: null }, []).board.songAssetId, null)
})

test('stable entity IDs, counts, missing-reference cleanup and removal keep directions consistent', () => {
  const cast = edit(start(), { operation: 'add_cast_member', member: { name: 'Mira', role: 'Traveler', referenceAssetIds: ['image', 'other-image', 'video'] } })
  const location = edit(cast.board, { operation: 'add_location', location: { name: 'Roof', referenceAssetIds: ['image'] } })
  assert.equal(location.board.production.castMode, 'needed')
  assert.equal(location.board.production.locationMode, 'needed')
  const cleaned = edit(location.board, { operation: 'update_cast_member', memberId: cast.memberId,
    patch: { name: 'Mira revised', referenceAssetIds: ['other-image', 'video'] } }, [assets[3]])
  assert.equal(cleaned.board.production.cast[0].id, cast.memberId)
  assert.deepEqual(cleaned.board.production.cast[0].referenceAssetIds, ['other-image', 'video'])
  assert.throws(() => edit(cleaned.board, { operation: 'update_cast_member', memberId: cast.memberId,
    patch: { referenceAssetIds: ['other-image', 'missing'] } }, []), /existing image/)
  assert.throws(() => edit(cleaned.board, { operation: 'update_location', locationId: location.locationId,
    patch: { referenceAssetIds: ['missing'] } }, []), /existing image/)
  const shot = edit(cleaned.board, { operation: 'add_shot' })
  const directed = edit(shot.board, { operation: 'set_shot_direction', shotId: shot.shotId,
    patch: { castIds: [cast.memberId], locationId: location.locationId, lipSync: true } }).board
  const removedCast = edit(directed, { operation: 'remove_cast_member', memberId: cast.memberId }).board
  assert.deepEqual(removedCast.production.shotDirections[0].castIds, [])
  const removedLocation = edit(removedCast, { operation: 'remove_location', locationId: location.locationId }).board
  assert.equal(removedLocation.production.shotDirections[0].locationId, null)
  assert.equal(removedLocation.production.locationMode, 'needed', 'Removing entries does not silently decide none')
  assert.deepEqual(edit(removedLocation, { operation: 'remove_shot', shotId: shot.shotId }).board.production.shotDirections, [])
  assert.throws(() => edit(directed, { operation: 'remove_cast_member', memberId: 'missing' }), /not found/)
  assert.throws(() => planStoryboardEdit(cast.board, { operation: 'add_location' }, assets, { idFactory: () => cast.memberId }), /already exists/)
  let full = start()
  for (let index = 0; index < PRODUCTION_LIMITS.cast; index += 1) full = edit(full, { operation: 'add_cast_member' }).board
  assert.throws(() => edit(full, { operation: 'add_cast_member' }), /at most 20/)
})

test('directions reject missing shots/entities, duplicates, paths and nonboolean lip sync', () => {
  const shot = edit(start(), { operation: 'add_shot' })
  for (const values of [{ castIds: ['missing'] }, { castIds: ['same', 'same'] }, { locationId: 'missing' },
    { locationId: '/tmp/place' }, { lipSync: 'true' }, { notes: 'x'.repeat(4001) }, { model: 'technical' }]) {
    assert.throws(() => edit(shot.board, { operation: 'set_shot_direction', shotId: shot.shotId, patch: values }))
  }
  assert.throws(() => edit(shot.board, { operation: 'set_shot_direction', shotId: 'missing', patch: {} }), /not found/)
  const directed = edit(shot.board, { operation: 'set_shot_direction', shotId: shot.shotId, patch: {} }).board
  assert.equal(edit(directed, { operation: 'set_shot_direction', shotId: shot.shotId, patch: {} }).changed, false)
})

test('concept review requires meaningful creative decisions and an actual valid music excerpt', () => {
  let board = start()
  assert.match(stage(board, 'concept').blockers.join(' '), /creative idea.*visual style.*performance.*existing audio/)
  assert.throws(() => approve(board, 'concept'), /Cannot approve/)
  board = concept()
  assert.equal(stage(board, 'concept').state, 'ready')
  assert.equal(stage(patch(board, { songStartSeconds: 45 }), 'concept').state, 'ready')
  assert.match(stage(patch(board, { songStartSeconds: 45.06 }), 'concept').blockers.join(), /past the end/)
  assert.match(stage(board, 'concept', assets.filter(asset => asset.id !== 'song')).blockers.join(), /existing audio/)
  assert.match(stage(board, 'concept', assets.map(asset => asset.id === 'song' ? { ...asset, duration: null } : asset)).blockers.join(), /known duration/)
  for (const type of ['ad', 'ugc', 'short-film']) {
    const generic = concept(type)
    assert.equal(generic.songAssetId, null)
    assert.equal(stage(generic, 'concept').state, 'ready')
    assert.equal(guide(generic).questions.length, 1)
  }
  assert.match(stage(patch(concept('ad'), { audience: '' }), 'concept').blockers.join(), /who this video/)
  assert.equal(guide(start()).questions.length, 1)
  assert.match(guide(start()).questions[0], /story, concept, or feeling/)
})

test('cast/location review requires decisions and existing visual references but supports explicit none', () => {
  let board = approve(concept(), 'concept')
  assert.match(stage(board, 'cast-locations').blockers.join(), /Decide whether/)
  board = patch(board, { castMode: 'none', locationMode: 'none' })
  assert.equal(stage(board, 'cast-locations').state, 'ready')
  const cast = edit(board, { operation: 'add_cast_member', member: { name: 'Mira' } })
  assert.match(stage(cast.board, 'cast-locations').blockers.join(), /visual reference for Mira/)
  board = edit(cast.board, { operation: 'update_cast_member', memberId: cast.memberId, patch: { referenceAssetIds: ['video'] } }).board
  assert.equal(stage(board, 'cast-locations').state, 'ready')
  assert.match(stage(board, 'cast-locations', []).blockers.join(), /missing or incompatible/)
  assert.match(stage(patch(board, { castMode: 'none' }), 'cast-locations').blockers.join(), /Remove the unused/)
  assert.throws(() => approve(concept(), 'cast-locations'), /Approve the current concept/)
})

test('animatic review requires actual stills, actions, directions and timing within one-frame tolerance', () => {
  const board = animatic(), shotId = board.shots[0].id
  assert.equal(stage(board, 'animatic').state, 'ready')
  for (const durationSeconds of [44.95, 45.05]) {
    const changed = edit(board, { operation: 'update_shot', shotId, patch: { durationSeconds } }).board
    assert.equal(stage(changed, 'animatic').state, 'ready')
  }
  for (const values of [{ durationSeconds: 44.94 }, { description: '' }, { referenceAssetIds: ['video'] }]) {
    const changed = edit(board, { operation: 'update_shot', shotId, patch: values }).board
    assert.equal(stage(changed, 'animatic').state, 'blocked')
  }
  assert.equal(getProductionShotVisual(board, { ...board.shots[0], referenceAssetIds: ['video'] }, assets), null)
  assert.match(stage(edit(board, { operation: 'set_shot_direction', shotId, patch: { lipSync: true } }).board, 'animatic').blockers.join(), /performer/)
  assert.match(stage({ ...board, production: { ...board.production, shotDirections: [] } }, 'animatic').blockers.join(), /direction decision/)
  const second = edit(board, { operation: 'add_shot', shot: { durationSeconds: 3 } }).board
  assert.deepEqual(computeAnimaticShots(second).map(entry => [entry.startSeconds, entry.endSeconds]), [[0, 45], [45, 48]])
})

test('all stage approvals are deterministic reviews only, and ordinary changes invalidate downstream approvals', () => {
  const board = completed(), before = JSON.stringify(board)
  assert.deepEqual(guide(board).stages.map(entry => entry.state), Array(5).fill('approved'))
  assert.equal(guide(board).nextStage, null)
  assert.equal(guide(board).summary.generationAuthorized, false)
  assert.equal(edit(board, { operation: 'review_production_stage', stage: 'refine', decision: 'approve' }).changed, false)
  assert.equal(JSON.stringify(board), before)
  const changed = patch(board, { concept: 'The traveler chooses a new direction after finding an old letter.' })
  assert.deepEqual(guide(changed).stages.map(entry => entry.state), Array(5).fill('stale'))
  assert.equal(guide(changed).nextStage, 'concept')
  assert.deepEqual(guide(patch(board, { delegation: 'agent-led' })).stages.map(entry => entry.state), Array(5).fill('approved'))
  const next = edit(board, { operation: 'review_production_stage', stage: 'concept', decision: 'approve', note: 'Reviewed together.' }).board
  assert.deepEqual(guide(next).stages.map(entry => entry.state), Array(5).fill('approved'), 'Review notes do not invalidate creative inputs')
  assert.match(guide(board).handoffPrompt, /never authorizes generation/)
  assert.ok(guide(board).questions.length <= 2)
  assert.deepEqual(guide(board).stages.map(entry => entry.id), PRODUCTION_STAGES)
})

test('reopening a stage preserves earlier approvals and clears only its downstream review records', () => {
  const board = edit(completed(), { operation: 'review_production_stage', stage: 'animatic', decision: 'reopen', note: 'Try a slower opening.' }).board
  assert.deepEqual(board.production.reviews.map(entry => entry.stage), ['concept', 'cast-locations', 'animatic'])
  assert.deepEqual(guide(board).stages.map(entry => entry.state), ['approved', 'approved', 'ready', 'blocked', 'blocked'])
  assert.equal(board.production.reviews.at(-1).decision, 'reopen')
  assert.equal(guide(approve(board, 'animatic')).nextStage, 'generate')
  assert.throws(() => edit(board, { operation: 'review_production_stage', stage: 'paid', decision: 'approve' }), /stage/)
})

test('asset metadata and entity planning changes invalidate approvals, while transient cache URLs do not', () => {
  let board = concept()
  const cast = edit(board, { operation: 'add_cast_member', member: { referenceAssetIds: ['image'] } })
  board = approve(cast.board, 'concept')
  board = patch(board, { locationMode: 'none' })
  board = approve(board, 'cast-locations')
  const transient = assets.map(asset => ({ ...asset, url: 'blob:new-cache', thumbnailUrl: 'blob:thumb', proxyProgress: 0.5 }))
  assert.equal(stage(board, 'cast-locations', transient).state, 'approved')
  const replaced = assets.map(asset => asset.id === 'image' ? { ...asset, sourceVersion: 'changed' } : asset)
  assert.equal(stage(board, 'cast-locations', replaced).state, 'stale')
  assert.equal(stage(board, 'cast-locations', assets.filter(asset => asset.id !== 'image')).state, 'stale')
  const changed = edit(board, { operation: 'update_cast_member', memberId: cast.memberId, patch: { description: 'A different character.' } }).board
  assert.equal(stage(changed, 'concept').state, 'approved')
  assert.equal(stage(changed, 'cast-locations').state, 'stale')
  assert.equal(stage(board, 'concept', assets.map(asset => asset.id === 'song' ? { ...asset, duration: 91 } : asset)).state, 'stale')
})

test('video selection preserves reviewed animatic stills but changing the actual still invalidates review', () => {
  let board = approve(animatic(), 'animatic'), shotId = board.shots[0].id
  board = edit(board, { operation: 'attach_take', shotId, assetId: 'video' }).board
  assert.equal(stage(board, 'animatic').state, 'approved')
  assert.equal(stage(board, 'generate').state, 'ready')
  const image = edit(board, { operation: 'attach_take', shotId, assetId: 'other-image' })
  board = approve(image.board, 'animatic')
  assert.equal(getProductionShotVisual(board, board.shots[0], assets).assetId, 'image')
  board = edit(board, { operation: 'select_take', shotId, takeId: image.takeId }).board
  assert.equal(getProductionShotVisual(board, board.shots[0], assets).assetId, 'other-image')
  assert.equal(stage(board, 'animatic').state, 'stale')
  assert.equal(stage(board, 'generate').state, 'blocked')
})

test('production references protect native Trash but not project-only removal; guide reads are detached', () => {
  let board = edit(start(), { operation: 'add_cast_member', member: { referenceAssetIds: ['image'] } }).board
  board = edit(board, { operation: 'add_location', location: { referenceAssetIds: ['video'] } }).board
  const project = { currentProject: { storyboard: board, timelines: [] } }
  assert.deepEqual([...getProjectAssetReferences(project)].sort(), ['image', 'video'])
  assert.deepEqual([...getProjectAssetReferences(project, {}, { compoundOnly: true })], [])
  const before = JSON.stringify(board), read = guide(board)
  read.production.cast[0].name = 'Changed copy'
  assert.equal(JSON.stringify(board), before)
  assert.ok(JSON.stringify(read).length < 100000)
})

test('the next-step guide asks one focused creative question at each blocked or ready stage', () => {
  assert.match(guide(patch(concept(), { songStartSeconds: 80 })).questions[0], /section of the song/)
  assert.match(guide(patch(concept('ad'), { audience: 'a' })).questions[0], /Who/)
  let board = approve(concept(), 'concept')
  const cast = edit(board, { operation: 'add_cast_member', member: { name: 'Mira' } })
  board = patch(cast.board, { locationMode: 'none' })
  assert.match(guide(board).questions[0], /existing photos for Mira/)
  board = edit(board, { operation: 'update_cast_member', memberId: cast.memberId, patch: { referenceAssetIds: ['image'] } }).board
  assert.match(guide(board).questions[0], /before approving/)
  assert.match(guide(approve(board, 'cast-locations')).questions[0], /sequence of shots/)
  board = animatic()
  assert.match(guide(board).questions[0], /ordinary Velorn timeline/)
  let changed = edit(board, { operation: 'update_shot', shotId: board.shots[0].id, patch: { referenceAssetIds: [] } }).board
  assert.match(guide(changed).questions[0], /still image/)
  changed = edit(board, { operation: 'update_shot', shotId: board.shots[0].id, patch: { durationSeconds: 30 } }).board
  assert.match(guide(changed).questions[0], /timing changes/)
  board = approve(board, 'animatic')
  assert.match(guide(board).questions[0], /wait for approval/)
  board = edit(board, { operation: 'attach_take', shotId: board.shots[0].id, assetId: 'video' }).board
  assert.match(guide(board).questions[0], /selected video takes/)
  board = approve(board, 'generate')
  assert.match(guide(board).questions[0], /refinement/)
  for (const value of [start(), concept(), animatic(), board]) assert.equal(guide(value).questions.length, 1)
})

test('guide keeps the assistant conversation first and separates preferences from execution permission', () => {
  const empty = guide(createDefaultStoryboard())
  assert.match(empty.questions[0], /story or feeling/)
  assert.match(empty.handoffPrompt, /existing people\/photos/)
  assert.match(empty.handoffPrompt, /Never generate first/)
  const value = guide(patch(concept(), { delegation: 'agent-led' }))
  assert.equal(value.summary.generationAuthorized, false)
  assert.match(value.handoffPrompt, /not permission or proof of delegated scope/)
  assert.match(value.handoffPrompt, /whole scope in this conversation/)
  assert.match(value.handoffPrompt, /read-only visual reference page/)
  assert.match(value.handoffPrompt, /ordinary Velorn timeline/)
  assert.match(value.handoffPrompt, /labels or text overlays only if requested/)
})
