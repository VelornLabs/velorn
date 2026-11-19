import test from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultStoryboard, normalizeStoryboard, planStoryboardEdit, STORYBOARD_LIMITS } from './storyboard.mjs'

const assets = [{ id: 'image', type: 'image', name: 'Still' }, { id: 'video', type: 'video', hasAudio: true },
  { id: 'silent', type: 'video', hasAudio: false }, { id: 'audio', type: 'audio' }, { id: 'text', type: 'text' }]
let sequence = 0
const edit = (board, payload) => planStoryboardEdit(board, payload, assets, { idFactory: prefix => `${prefix}-${++sequence}` })
const add = (board, shot = {}) => edit(board, { operation: 'add_shot', shot })

test('legacy absent boards normalize without mutation, preserving portable authored data only', () => {
  assert.deepEqual(normalizeStoryboard(undefined), createDefaultStoryboard())
  const source = add(undefined, { title: 'Opening', referenceAssetIds: ['image', 'audio'] }).board
  const before = JSON.stringify(source)
  const result = edit(source, { operation: 'update_board', patch: { title: 'Film', brief: 'A quiet opening', songAssetId: 'audio' } })
  assert.equal(JSON.stringify(source), before)
  assert.equal(result.changed, true)
  assert.equal(result.board.songAssetId, 'audio')
  assert.equal('path' in result.board.shots[0], false)
  assert.deepEqual(normalizeStoryboard(JSON.parse(JSON.stringify(result.board))), result.board)
})

test('unsupported, malformed and future fields are read-only rather than silently discarded', () => {
  for (const board of [{ version: 2, shots: [], future: 'keep' }, { ...createDefaultStoryboard(), future: 'keep' },
    { ...createDefaultStoryboard(), shots: 'wrong' }]) {
    const before = JSON.stringify(board)
    assert.throws(() => normalizeStoryboard(board), /read-only|must be an array/)
    assert.throws(() => edit(board, { operation: 'update_board', patch: { title: 'Overwrite' } }))
    assert.equal(JSON.stringify(board), before)
  }
})

test('shot edits, ordered insertions, permutations and removal use stable IDs', () => {
  const a = add(undefined), b = add(a.board), c = edit(b.board, { operation: 'add_shot', afterShotId: a.shotId, shot: { title: 'Middle' } })
  assert.deepEqual(c.board.shots.map(shot => shot.id), [a.shotId, c.shotId, b.shotId])
  const updated = edit(c.board, { operation: 'update_shot', shotId: c.shotId,
    patch: { description: 'Updated', durationSeconds: 2.5, status: 'review', referenceAssetIds: ['video'] } })
  assert.equal(updated.board.shots[1].id, c.shotId)
  const ids = [b.shotId, a.shotId, c.shotId]
  const reordered = edit(updated.board, { operation: 'reorder_shots', shotIds: ids })
  assert.deepEqual(reordered.board.shots.map(shot => shot.id), ids)
  assert.equal(edit(reordered.board, { operation: 'reorder_shots', shotIds: ids }).changed, false)
  assert.deepEqual(edit(reordered.board, { operation: 'remove_shot', shotId: a.shotId }).board.shots.map(shot => shot.id), [b.shotId, c.shotId])
  for (const shotIds of [[a.shotId], [a.shotId, a.shotId, b.shotId], [a.shotId, b.shotId, 'missing']]) {
    assert.throws(() => edit(c.board, { operation: 'reorder_shots', shotIds }), /duplicates|exact permutation/)
  }
})

test('first take is selected, later attachments preserve selection, removal has an explicit fallback', () => {
  const shot = add(undefined)
  const first = edit(shot.board, { operation: 'attach_take', shotId: shot.shotId, assetId: 'image', prompt: 'A frame', workflowLabel: 'Manual' })
  assert.equal(first.board.shots[0].selectedTakeId, first.takeId)
  const second = edit(first.board, { operation: 'attach_take', shotId: shot.shotId, assetId: 'video', label: 'Motion' })
  assert.equal(second.board.shots[0].selectedTakeId, first.takeId)
  const selected = edit(second.board, { operation: 'select_take', shotId: shot.shotId, takeId: second.takeId })
  assert.equal(selected.board.shots[0].selectedTakeId, second.takeId)
  assert.equal(edit(selected.board, { operation: 'select_take', shotId: shot.shotId, takeId: second.takeId }).changed, false)
  const removed = edit(selected.board, { operation: 'remove_take', shotId: shot.shotId, takeId: second.takeId })
  assert.equal(removed.board.shots[0].selectedTakeId, first.takeId)
  assert.equal(edit(removed.board, { operation: 'remove_take', shotId: shot.shotId, takeId: first.takeId }).board.shots[0].selectedTakeId, null)
  assert.throws(() => edit(first.board, { operation: 'attach_take', shotId: shot.shotId, assetId: 'image' }), /already has a take/)
})

test('only existing project assets of the correct media type can be newly referenced', () => {
  const { board, shotId } = add(undefined)
  for (const assetId of ['missing', '/tmp/video.mp4', 'audio', 'text']) assert.throws(() => edit(board, { operation: 'attach_take', shotId, assetId }))
  for (const songAssetId of ['image', 'silent', 'missing']) assert.throws(() => edit(board, { operation: 'update_board', patch: { songAssetId } }))
  for (const songAssetId of ['audio', 'video', null]) assert.equal(edit(board, { operation: 'update_board', patch: { songAssetId } }).board.songAssetId, songAssetId)
  assert.throws(() => add(board, { referenceAssetIds: ['image', 'image'] }), /duplicates/)
  assert.throws(() => add(board, { referenceAssetIds: ['text'] }), /supported media type/)
})

test('removed project-only references remain inspectable and can be cleared without losing other board data', () => {
  const initial = add(undefined, { referenceAssetIds: ['image'] })
  const attached = edit(initial.board, { operation: 'attach_take', shotId: initial.shotId, assetId: 'video' })
  assert.deepEqual(normalizeStoryboard(attached.board), attached.board)
  const result = planStoryboardEdit(attached.board, { operation: 'update_shot', shotId: initial.shotId, patch: { title: 'Still editable' } }, [])
  assert.deepEqual(result.board.shots[0].referenceAssetIds, ['image'])
  assert.throws(() => planStoryboardEdit(attached.board, { operation: 'select_take', shotId: initial.shotId, takeId: attached.takeId }, []), /missing from this project/)
  assert.equal(planStoryboardEdit(attached.board, { operation: 'remove_take', shotId: initial.shotId, takeId: attached.takeId }, []).board.shots[0].takes.length, 0)
})

test('full reference-array patches can remove missing links one by one but cannot attach new missing links', () => {
  const initial = add(undefined, { referenceAssetIds: ['image', 'video', 'audio'] })
  const remainingAssets = assets.filter(asset => asset.id === 'audio')
  const cleaned = planStoryboardEdit(initial.board, { operation: 'update_shot', shotId: initial.shotId,
    patch: { referenceAssetIds: ['video', 'audio'] } }, remainingAssets)
  assert.deepEqual(cleaned.board.shots[0].referenceAssetIds, ['video', 'audio'])
  assert.deepEqual(initial.board.shots[0].referenceAssetIds, ['image', 'video', 'audio'], 'Input board stays unchanged')
  assert.equal(planStoryboardEdit(cleaned.board, { operation: 'update_shot', shotId: initial.shotId,
    patch: { referenceAssetIds: ['video', 'audio'] } }, remainingAssets).changed, false)
  assert.deepEqual(planStoryboardEdit(cleaned.board, { operation: 'update_shot', shotId: initial.shotId,
    patch: { referenceAssetIds: ['audio'] } }, remainingAssets).board.shots[0].referenceAssetIds, ['audio'])
  for (const referenceAssetIds of [['video', 'new-missing'], ['image', 'video'], ['video', 'video']]) {
    assert.throws(() => planStoryboardEdit(cleaned.board, { operation: 'update_shot', shotId: initial.shotId,
      patch: { referenceAssetIds } }, remainingAssets), /missing from this project|duplicates/)
  }
  assert.throws(() => planStoryboardEdit(cleaned.board, { operation: 'add_shot', shot: { referenceAssetIds: ['video'] } }, remainingAssets), /missing from this project/)
  assert.throws(() => planStoryboardEdit(cleaned.board, { operation: 'attach_take', shotId: initial.shotId, assetId: 'video' }, remainingAssets), /missing from this project/)
})

test('full board patches retain an unchanged missing song while newly assigned missing songs still fail', () => {
  const initial = edit(undefined, { operation: 'update_board', patch: { songAssetId: 'audio' } }).board
  const updated = planStoryboardEdit(initial, { operation: 'update_board', patch: {
    title: 'Edited title', brief: 'Edited brief', songAssetId: 'audio',
  } }, [])
  assert.equal(updated.board.songAssetId, 'audio')
  assert.equal(updated.board.title, 'Edited title')
  assert.equal(planStoryboardEdit(updated.board, { operation: 'update_board', patch: { songAssetId: 'audio' } }, []).changed, false)
  assert.throws(() => planStoryboardEdit(updated.board, { operation: 'update_board', patch: { songAssetId: 'video' } }, []), /missing from this project/)
  const cleared = planStoryboardEdit(updated.board, { operation: 'update_board', patch: { songAssetId: null } }, [])
  assert.equal(cleared.board.songAssetId, null)
  assert.throws(() => planStoryboardEdit(cleared.board, { operation: 'update_board', patch: { songAssetId: 'audio' } }, []), /missing from this project/)
})

test('invalid IDs, fields, durations, text and counts fail without changing input', () => {
  const { board, shotId } = add(undefined)
  const before = JSON.stringify(board)
  for (const durationSeconds of [0, -1, Infinity, NaN, '5', null, 3601]) assert.throws(() => edit(board, { operation: 'update_shot', shotId, patch: { durationSeconds } }))
  for (const payload of [{ operation: 'remove_shot', shotId: 'missing' }, { operation: 'update_shot', shotId, patch: { id: 'replacement' } },
    { operation: 'add_shot', shot: { path: '/tmp/unsafe' } }, { operation: 'update_board', patch: { title: 'x'.repeat(201) } },
    { operation: 'update_shot', shotId, patch: { status: 'ready' } }, { operation: 'select_take', shotId, takeId: null },
    { operation: 'unexpected' }]) assert.throws(() => edit(board, payload))
  assert.throws(() => add(board, { referenceAssetIds: Array(STORYBOARD_LIMITS.referencesPerShot + 1).fill('image') }), /at most/)
  assert.equal(JSON.stringify(board), before)
  const full = { ...board, nextShotNumber: 201, shots: Array.from({ length: STORYBOARD_LIMITS.shots }, (_, index) => ({ ...board.shots[0], id: `shot-${index}`, label: `Shot ${String(index + 1).padStart(2, '0')}` })) }
  assert.throws(() => add(full), /at most 200/)
  const invalid = { ...board, shots: [{ ...board.shots[0], selectedTakeId: 'missing' }] }
  assert.throws(() => normalizeStoryboard(invalid), /does not belong/)
  assert.throws(() => edit(board, { operation: 'add_shot', shot: null }), /must be an object/)
  const fullTakes = { ...board, shots: [{ ...board.shots[0], takes: Array.from({ length: STORYBOARD_LIMITS.takesPerShot },
    (_, index) => ({ id: `take-${index}`, assetId: `asset-${index}`, label: '', prompt: '', workflowLabel: '' })) }] }
  assert.throws(() => edit(fullTakes, { operation: 'attach_take', shotId, assetId: 'image' }), /at most 30/)
  assert.throws(() => planStoryboardEdit(board, { operation: 'add_shot' }, assets, { idFactory: () => shotId }), /already exists/)
})

test('no-op edits do not initialize absent authored data', () => {
  assert.equal(edit(undefined, { operation: 'update_board', patch: {} }).changed, false)
  assert.equal(edit(undefined, { operation: 'update_board', patch: { title: 'Storyboard', brief: '', songAssetId: null } }).changed, false)
})
