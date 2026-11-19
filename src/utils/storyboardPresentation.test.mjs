import test from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultStoryboard, normalizeStoryboard, planStoryboardEdit,
  getStoryboardShotLabel, getStoryboardPresentation } from './storyboard.mjs'
import { getProductionGuide, getProductionShotVisual } from './production.mjs'
import { getProjectAssetReferences } from './projectAssetReferences.mjs'

const assets = [{ id: 'frame', type: 'image', name: 'Opening frame' }, { id: 'frame2', type: 'image', name: 'Second frame' },
  { id: 'person', type: 'image', name: 'Mira portrait' }, { id: 'place', type: 'image', name: 'Roof reference' },
  { id: 'mood', type: 'image', name: 'Lighting reference' }, { id: 'video', type: 'video' }, { id: 'song', type: 'audio' }]
let sequence = 0
const edit = (board, payload, media = assets) => planStoryboardEdit(board, payload, media, { idFactory: prefix => `${prefix}-${++sequence}` })
const add = (board, shot = {}) => edit(board, { operation: 'add_shot', shot })
function legacy() {
  const board = add(add(undefined).board).board
  delete board.nextShotNumber
  board.shots.forEach(shot => { delete shot.label })
  return board
}

test('legacy read labels are pure and do not add optional data or require a production', () => {
  const board = legacy(), before = JSON.stringify(board)
  assert.deepEqual(normalizeStoryboard(board), board)
  assert.deepEqual(getStoryboardPresentation(board, assets).shots.map(shot => shot.label), ['Shot 01', 'Shot 02'])
  assert.equal(getStoryboardShotLabel(board, board.shots[1].id), 'Shot 02')
  assert.equal(getStoryboardShotLabel(board, board.shots[0]), 'Shot 01')
  assert.equal(JSON.stringify(board), before)
  for (const payload of [{ operation: 'update_board', patch: {} }, { operation: 'reorder_shots', shotIds: board.shots.map(shot => shot.id) },
    { operation: 'update_shot', shotId: board.shots[0].id, patch: { title: board.shots[0].title } }]) {
    const result = edit(board, payload)
    assert.equal(result.changed, false)
    assert.deepEqual(result.board, board)
  }
  assert.deepEqual(getStoryboardPresentation(createDefaultStoryboard(), assets), { shots: [], cast: [], locations: [], references: [] })
})

test('first meaningful reorder materializes old labels without renumbering and persists a high-water counter', () => {
  const board = legacy(), ids = board.shots.map(shot => shot.id)
  const reordered = edit(board, { operation: 'reorder_shots', shotIds: [...ids].reverse() }).board
  assert.deepEqual(reordered.shots.map(shot => [shot.id, shot.label]), [[ids[1], 'Shot 02'], [ids[0], 'Shot 01']])
  assert.equal(reordered.nextShotNumber, 3)
  assert.equal(Object.hasOwn(board, 'nextShotNumber'), false)
  assert.deepEqual(normalizeStoryboard(JSON.parse(JSON.stringify(reordered))), reordered)
  const next = add(reordered).board
  assert.deepEqual(next.shots.map(shot => shot.label), ['Shot 02', 'Shot 01', 'Shot 03'])
  assert.equal(next.nextShotNumber, 4)
})

test('removing the highest shot or every legacy shot never reuses a label', () => {
  const board = legacy(), first = board.shots[0].id, last = board.shots[1].id
  const removed = edit(board, { operation: 'remove_shot', shotId: last }).board
  assert.equal(removed.nextShotNumber, 3)
  assert.equal(add(removed).board.shots.at(-1).label, 'Shot 03')
  const empty = edit(removed, { operation: 'remove_shot', shotId: first }).board
  assert.equal(empty.nextShotNumber, 3)
  const created = add(empty).board
  assert.equal(created.shots[0].label, 'Shot 03')
  assert.equal(created.nextShotNumber, 4)
})

test('new default titles follow allocated labels after deletion while legacy and authored titles stay unchanged', () => {
  const first = add(undefined), second = add(first.board)
  assert.equal(first.board.shots[0].title, 'Shot 01')
  const removedFirst = edit(second.board, { operation: 'remove_shot', shotId: first.shotId }).board
  const third = add(removedFirst).board
  assert.deepEqual(third.shots.map(shot => [shot.title, shot.label]), [['Shot 02', 'Shot 02'], ['Shot 03', 'Shot 03']])

  const old = legacy()
  old.shots[0].title = 'Shot 1'
  old.shots[1].title = 'An authored closing'
  const legacyAdded = add(old).board
  assert.deepEqual(legacyAdded.shots.map(shot => shot.title), ['Shot 1', 'An authored closing', 'Shot 03'])
  const explicit = add(legacyAdded, { title: 'Shot 2' }).board
  assert.equal(explicit.shots.at(-1).title, 'Shot 2', 'An explicitly authored Shot-style title is not rewritten')
  assert.equal(explicit.shots.at(-1).label, 'Shot 04')
  assert.equal(add(explicit, { title: '' }).board.shots.at(-1).title, '', 'An explicit empty title is preserved')

  let empty = old
  for (const shot of old.shots) empty = edit(empty, { operation: 'remove_shot', shotId: shot.id }).board
  const afterLastDelete = add(empty).board.shots[0]
  assert.equal(afterLastDelete.label, 'Shot 03')
  assert.equal(afterLastDelete.title, afterLastDelete.label)
})

test('labels and counters are strict, domain-owned and bounded without changing source on failure', () => {
  const board = add(undefined).board, shot = board.shots[0]
  for (const label of ['Shot 1', 'Shot 00', 'Shot 001', 'Shot -1', 'Scene 01', 'Shot 1000000', null]) {
    assert.throws(() => normalizeStoryboard({ ...board, shots: [{ ...shot, label }] }), /label/)
  }
  for (const nextShotNumber of [0, -1, 1, 2.5, 1000001, '2']) assert.throws(() => normalizeStoryboard({ ...board, nextShotNumber }), /nextShotNumber/)
  assert.throws(() => normalizeStoryboard({ ...board, shots: [shot, { ...shot, id: 'other' }] }), /duplicates/)
  assert.throws(() => edit(board, { operation: 'update_shot', shotId: shot.id, patch: { label: 'Shot 09' } }), /unsupported field/)
  assert.throws(() => edit(board, { operation: 'update_board', patch: { nextShotNumber: 1 } }), /unsupported field/)
  assert.throws(() => add({ ...board, nextShotNumber: 1000000 }), /No unused shot labels/)
  const partial = { ...board, nextShotNumber: 8, shots: [shot, { ...shot, id: 'legacy', label: undefined }] }
  assert.equal(getStoryboardShotLabel(partial, 'legacy'), 'Shot 08')
  assert.equal(add(partial).board.shots.at(-1).label, 'Shot 09')
})

test('explicit storyboard frames accept only project images and preserve retained missing references for cleanup', () => {
  const shot = add(undefined, { storyboardAssetId: 'frame' }), before = JSON.stringify(shot.board)
  assert.equal(shot.board.shots[0].storyboardAssetId, 'frame')
  for (const storyboardAssetId of ['video', 'song', 'missing', '/tmp/frame.png']) {
    assert.throws(() => edit(shot.board, { operation: 'update_shot', shotId: shot.shotId, patch: { storyboardAssetId } }))
    assert.throws(() => add(undefined, { storyboardAssetId }))
  }
  assert.equal(JSON.stringify(shot.board), before)
  const retained = edit(shot.board, { operation: 'update_shot', shotId: shot.shotId, patch: { title: 'Retained', storyboardAssetId: 'frame' } }, []).board
  assert.equal(retained.shots[0].storyboardAssetId, 'frame')
  assert.equal(getStoryboardPresentation(retained, []).shots[0].stillMissing, true)
  const cleared = edit(retained, { operation: 'update_shot', shotId: shot.shotId, patch: { storyboardAssetId: null } }, []).board
  assert.equal(cleared.shots[0].storyboardAssetId, null)
  assert.throws(() => edit(cleared, { operation: 'update_shot', shotId: shot.shotId, patch: { storyboardAssetId: 'frame' } }, []), /missing/)
  assert.deepEqual([...getProjectAssetReferences({ currentProject: { storyboard: shot.board } })], ['frame'])
})

test('explicit first frames remain stable across selected image/video takes; missing or cleared frames never silently substitute', () => {
  let board = add(undefined, { storyboardAssetId: 'frame', referenceAssetIds: ['person'] }).board
  const shotId = board.shots[0].id
  const image = edit(board, { operation: 'attach_take', shotId, assetId: 'frame2' })
  board = image.board
  const video = edit(board, { operation: 'attach_take', shotId, assetId: 'video' })
  board = edit(video.board, { operation: 'select_take', shotId, takeId: video.takeId }).board
  let presentation = getStoryboardPresentation(board, assets).shots[0]
  assert.equal(presentation.stillAssetId, 'frame')
  assert.equal(presentation.stillSource, 'storyboard')
  assert.equal(presentation.selectedTakeAssetId, 'video')
  assert.equal(getProductionShotVisual(board, board.shots[0], assets).assetId, 'frame')
  presentation = getStoryboardPresentation(board, assets.filter(asset => asset.id !== 'frame')).shots[0]
  assert.equal(presentation.stillAssetId, 'frame')
  assert.equal(presentation.stillMissing, true)
  assert.equal(getProductionShotVisual(board, board.shots[0], assets.filter(asset => asset.id !== 'frame')), null)
  board = edit(board, { operation: 'update_shot', shotId, patch: { storyboardAssetId: null } }).board
  assert.equal(getProductionShotVisual(board, board.shots[0], assets), null)
  assert.equal(getStoryboardPresentation(board, assets).shots[0].stillAssetId, null)
})

test('legacy still fallback preserves selected-image, reference, then image-take order and reports its source honestly', () => {
  let board = add(undefined, { referenceAssetIds: ['person'] }).board
  const shotId = board.shots[0].id
  assert.equal(getStoryboardPresentation(board, assets).shots[0].stillSource, 'reference')
  board = edit(board, { operation: 'attach_take', shotId, assetId: 'frame' }).board
  assert.equal(getStoryboardPresentation(board, assets).shots[0].stillSource, 'selected-take')
  assert.equal(getStoryboardPresentation(board, assets).shots[0].stillAssetId, 'frame')
  const video = edit(board, { operation: 'attach_take', shotId, assetId: 'video' })
  board = edit(video.board, { operation: 'select_take', shotId, takeId: video.takeId }).board
  assert.equal(getStoryboardPresentation(board, assets).shots[0].stillAssetId, 'person')
  board = edit(board, { operation: 'update_shot', shotId, patch: { referenceAssetIds: [] } }).board
  assert.equal(getStoryboardPresentation(board, assets).shots[0].stillSource, 'take')
  assert.equal(getStoryboardPresentation(board, assets).shots[0].stillAssetId, 'frame')
})

test('presentation groups named cast/location references separately and returns detached general references', () => {
  let board = edit(undefined, { operation: 'start_production', productionType: 'short-film' }).board
  board = edit(board, { operation: 'add_cast_member', member: { name: 'Mira', role: 'Traveler', referenceAssetIds: ['person'] } }).board
  board = edit(board, { operation: 'add_location', location: { name: 'Roof', referenceAssetIds: ['place'] } }).board
  board = add(board, { storyboardAssetId: 'frame', referenceAssetIds: ['person', 'place', 'mood', 'frame'] }).board
  board = add(board, { storyboardAssetId: 'frame2', referenceAssetIds: ['mood'] }).board
  const before = JSON.stringify(board), view = getStoryboardPresentation(board, assets)
  assert.equal(view.cast[0].name, 'Mira')
  assert.equal(view.cast[0].references[0].name, 'Mira portrait')
  assert.equal(view.locations[0].name, 'Roof')
  assert.deepEqual(view.references.map(entry => entry.assetId), ['mood'])
  assert.deepEqual(view.shots.map(shot => shot.label), ['Shot 01', 'Shot 02'])
  view.shots[0].references[0].name = 'Changed copy'
  view.cast[0].name = 'Changed copy'
  assert.equal(JSON.stringify(board), before)
  assert.equal(assets.find(asset => asset.id === 'person').name, 'Mira portrait')
})

test('explicit frame changes update production review fingerprints and missing frames block animatic readiness', () => {
  let board = edit(undefined, { operation: 'start_production', productionType: 'short-film' }).board
  board = edit(board, { operation: 'update_production', patch: { concept: 'A traveler watches the city wake up.', visualStyle: 'Natural light', castMode: 'none', locationMode: 'none' } }).board
  for (const stage of ['concept', 'cast-locations']) board = edit(board, { operation: 'review_production_stage', stage, decision: 'approve' }).board
  const result = add(board, { storyboardAssetId: 'frame', description: 'A quiet city wakes up.', durationSeconds: 45, referenceAssetIds: ['person'] })
  board = edit(result.board, { operation: 'set_shot_direction', shotId: result.shotId, patch: {} }).board
  board = edit(board, { operation: 'review_production_stage', stage: 'animatic', decision: 'approve' }).board
  assert.equal(getProductionGuide(board, assets).stages[2].state, 'approved')
  const video = edit(board, { operation: 'attach_take', shotId: result.shotId, assetId: 'video' }).board
  assert.equal(getProductionGuide(video, assets).stages[2].state, 'approved')
  const replaced = assets.map(asset => asset.id === 'frame' ? { ...asset, sourceVersion: 'new frame content' } : asset)
  assert.equal(getProductionGuide(video, replaced).stages[2].state, 'stale', 'Explicit frame identity is reviewed even without a take/reference entry')
  const changed = edit(video, { operation: 'update_shot', shotId: result.shotId, patch: { storyboardAssetId: 'frame2' } }).board
  assert.equal(getProductionGuide(changed, assets).stages[2].state, 'stale')
  const missing = getProductionGuide(board, assets.filter(asset => asset.id !== 'frame')).stages[2]
  assert.equal(missing.state, 'stale')
  assert.match(missing.blockers.join(), /Shot 01 needs an existing image/)
})

test('general board references work before shots, validate new visual media, retain missing links, and protect files from Trash', () => {
  const empty = createDefaultStoryboard()
  assert.equal(Object.hasOwn(normalizeStoryboard(empty), 'referenceAssetIds'), false)
  assert.equal(edit(empty, { operation: 'update_board', patch: { referenceAssetIds: [] } }).changed, false)
  const board = edit(empty, { operation: 'update_board', patch: { referenceAssetIds: ['mood', 'frame', 'video'] } }).board
  assert.deepEqual(board.shots, [])
  assert.deepEqual(board.referenceAssetIds, ['mood', 'frame', 'video'])
  assert.deepEqual(getStoryboardPresentation(board, assets).references.map(entry => entry.assetId), ['mood', 'frame', 'video'])
  assert.deepEqual(normalizeStoryboard(JSON.parse(JSON.stringify(board))), board)
  for (const referenceAssetIds of [['song'], ['missing'], ['/tmp/picture.png'], ['frame', 'frame'], Array(51).fill('frame')]) {
    assert.throws(() => edit(empty, { operation: 'update_board', patch: { referenceAssetIds } }))
  }
  const removed = edit(board, { operation: 'update_board', patch: { referenceAssetIds: ['frame', 'video'] } }, []).board
  assert.deepEqual(removed.referenceAssetIds, ['frame', 'video'])
  assert.equal(getStoryboardPresentation(removed, []).references.every(entry => entry.missing), true)
  assert.throws(() => edit(removed, { operation: 'update_board', patch: { referenceAssetIds: ['frame', 'mood'] } }, []), /missing/)
  assert.deepEqual([...getProjectAssetReferences({ currentProject: { storyboard: board } })].sort(), ['frame', 'mood', 'video'])
  assert.deepEqual([...getProjectAssetReferences({ currentProject: { storyboard: board } }, {}, { compoundOnly: true })], [])
})

test('explicit general references stay visible when also used as a frame or cast reference and union deduplicates', () => {
  let board = edit(undefined, { operation: 'start_production', productionType: 'short-film' }).board
  board = edit(board, { operation: 'update_board', patch: { referenceAssetIds: ['person', 'frame', 'mood'] } }).board
  board = edit(board, { operation: 'add_cast_member', member: { name: 'Mira', referenceAssetIds: ['person'] } }).board
  board = add(board, { storyboardAssetId: 'frame', referenceAssetIds: ['person', 'frame', 'mood', 'place'] }).board
  assert.deepEqual(getStoryboardPresentation(board, assets).references.map(entry => entry.assetId), ['person', 'frame', 'mood', 'place'])
})
