import test from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultStoryboard, normalizeStoryboard, planStoryboardEdit } from './storyboard.mjs'
import { createProduction } from './production.mjs'
import { hasStoryboardContent, getStoryboardProjectKey } from './storyboardWorkspace.mjs'

const emptyRun = () => ({ version: 1, notes: '', nextAction: '', attempts: [], bindings: [] })
const boardWith = patch => ({ ...createDefaultStoryboard(), ...patch })
const frozen = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen)
    Object.freeze(value)
  }
  return value
}

test('absent, default and previously-cleared boards do not surface the workspace', () => {
  for (const board of [undefined, null, createDefaultStoryboard(), { version: 1, shots: [] },
    boardWith({ title: '', brief: ' \n\t ', referenceAssetIds: [], nextShotNumber: 19 }),
    boardWith({ title: ' Storyboard ', production: createProduction('music-video'), productionRun: emptyRun() }),
    boardWith({ production: null, productionRun: null }),
    boardWith({ productionRun: { ...emptyRun(), notes: ' \n ', nextAction: '\t' } })]) {
    assert.equal(hasStoryboardContent(frozen(board)), false)
  }
  const added = planStoryboardEdit(undefined, { operation: 'add_shot', shot: {} }, [], { idFactory: () => 'shot-a' })
  const removed = planStoryboardEdit(added.board, { operation: 'remove_shot', shotId: added.shotId }).board
  assert.equal(removed.nextShotNumber, 2)
  assert.equal(hasStoryboardContent(removed), false, 'Label allocation alone is not authored content')
})

test('shots, references, song, brief and custom title surface the workspace independently', () => {
  const added = planStoryboardEdit(undefined, { operation: 'add_shot', shot: {} }, [], { idFactory: () => 'shot-a' }).board
  for (const board of [added, boardWith({ referenceAssetIds: ['missing-reference'] }),
    boardWith({ songAssetId: 'missing-song' }), boardWith({ brief: 'A quiet opening.' }),
    boardWith({ title: 'Summer film' })]) {
    assert.equal(hasStoryboardContent(frozen(board)), true)
  }
})

test('intentional production setup is content even before images or shots exist', () => {
  const setup = createProduction('music-video')
  const patches = [{ type: 'ad' }, { type: 'ugc' }, { type: 'short-film' }, { targetDurationSeconds: 30 },
    { songStartSeconds: 15 }, { approach: 'story' }, { delegation: 'agent-led' },
    { castMode: 'none' }, { castMode: 'needed' }, { locationMode: 'none' }, { locationMode: 'needed' },
    { concept: 'An unexpected reunion' }, { visualStyle: 'Warm light' }, { audience: 'Travelers' },
    { mustInclude: 'The lighthouse' },
    { cast: [{ id: 'cast-a', name: 'Mira', role: '', description: '', referenceAssetIds: [] }] },
    { locations: [{ id: 'location-a', name: 'Rooftop', description: '', referenceAssetIds: [] }] },
    { reviews: [{ stage: 'concept', decision: 'reopen', fingerprint: `production-v1-${'0'.repeat(32)}`, note: '' }] }]
  for (const patch of patches) {
    const board = frozen(boardWith({ production: { ...setup, ...patch } }))
    assert.doesNotThrow(() => normalizeStoryboard(board))
    assert.equal(hasStoryboardContent(board), true, JSON.stringify(patch))
  }
  assert.equal(hasStoryboardContent(boardWith({ production: { ...setup, concept: ' \n ', visualStyle: '\t' } })), false)
})

test('production-run notes, next steps, attempts and bindings surface the workspace', () => {
  const event = { state: 'planned', remoteJobId: null, outputAssetId: null, note: '' }
  const attempt = { attemptId: 'attempt-a', shotId: 'removed-shot', recipe: { model: 'Model', workflow: 'Workflow' },
    ...event, history: [event] }
  const binding = { shotId: 'removed-shot', slot: 'animatic', timelineId: 'timeline-a', clipId: 'clip-a',
    baseline: { sourceAssetId: 'image-a', trackId: 'track-a', type: 'image', startTime: 0, duration: 5,
      trimStart: null, trimEnd: null, referencedAssetIds: ['image-a'], signature: `production-clip-v1-${'0'.repeat(32)}` } }
  for (const patch of [{ notes: 'Keep the casting.' }, { nextAction: 'Review the animatic.' },
    { attempts: [attempt] }, { bindings: [binding] }]) {
    const board = frozen(boardWith({ productionRun: { ...emptyRun(), ...patch } }))
    assert.doesNotThrow(() => normalizeStoryboard(board))
    assert.equal(hasStoryboardContent(board), true)
  }
})

test('future and corrupt saved data remain visible, read-only and unchanged', () => {
  for (const raw of [false, '', 0, [], {}, { version: 2, shots: [], future: 'retain' },
    boardWith({ future: { important: true } }), boardWith({ shots: 'corrupt' }),
    boardWith({ referenceAssetIds: 'corrupt' }), boardWith({ nextShotNumber: -1 }),
    boardWith({ production: { ...createProduction('music-video'), future: true } }),
    boardWith({ productionRun: { ...emptyRun(), version: 2 } })]) {
    const before = structuredClone(raw)
    assert.equal(hasStoryboardContent(frozen(raw)), true)
    assert.deepEqual(raw, before)
  }
})

test('path-backed project identity survives immutable edits and distinguishes project directories', () => {
  const project = frozen({ name: 'Film', created: '2026-09-27T00:00:00.000Z' })
  const edited = { ...project, name: 'Renamed', modified: 'later', storyboard: createDefaultStoryboard() }
  for (const path of ['/projects/film', 'C:\\Projects\\Film']) {
    assert.equal(getStoryboardProjectKey(project, path), getStoryboardProjectKey(edited, path))
    assert.equal(getStoryboardProjectKey(project, path), getStoryboardProjectKey({ ...edited, path }))
  }
  assert.notEqual(getStoryboardProjectKey(project, '/projects/a'), getStoryboardProjectKey(project, '/projects/b'))
  assert.equal(getStoryboardProjectKey({ ...project, path: '/stale' }, '/active'), 'path:/active')
})

test('browser directory handle identity is stable across project edits without relying on its name', () => {
  const handle = frozen({ kind: 'directory', name: 'Film' })
  const other = frozen({ kind: 'directory', name: 'Film' })
  const project = { name: 'Film' }
  assert.equal(getStoryboardProjectKey(project, handle), getStoryboardProjectKey({ ...project, modified: 'later' }, handle))
  assert.notEqual(getStoryboardProjectKey(project, handle), getStoryboardProjectKey(project, other))
})

test('durable metadata fallback survives immutable edits and no-project state never has a key', () => {
  for (const identity of [{ id: 'project-a' }, { id: 12 }, { created: '2026-09-27T00:00:00.000Z' },
    { createdAt: '2026-09-27T00:00:00.000Z' }]) {
    assert.equal(getStoryboardProjectKey({ ...identity, name: 'Before' }), getStoryboardProjectKey({ ...identity, name: 'After' }))
  }
  assert.notEqual(getStoryboardProjectKey({ id: 'a' }), getStoryboardProjectKey({ id: 'b' }))
  assert.notEqual(getStoryboardProjectKey({ created: 'a' }), getStoryboardProjectKey({ created: 'b' }))
  assert.notEqual(getStoryboardProjectKey({ name: 'Film' }), getStoryboardProjectKey({ name: 'Film' }))
  for (const project of [null, undefined, false, 'not-a-project']) {
    assert.equal(getStoryboardProjectKey(project, '/old-handle'), null)
  }
})
