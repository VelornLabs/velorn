import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeProductionRun, planProductionRunEdit, inspectProductionRun, getProductionClipIdentity,
  PRODUCTION_RUN_LIMITS, PRODUCTION_ATTEMPT_STATES } from './productionRun.mjs'
import { collectAssetReferences } from './projectAssetReferences.mjs'

const assets = [{ id: 'song', type: 'audio', duration: 45 }, { id: 'still', type: 'image' },
  { id: 'other-still', type: 'image' }, { id: 'take', type: 'video', duration: 5 },
  { id: 'retake', type: 'video', duration: 6 }, { id: 'mask', type: 'image' },
  { id: 'sound-video', type: 'video', hasAudio: true, duration: 90 }, { id: 'silent-video', type: 'video', duration: 90 }]
const board = { shots: [{ id: 'shot-a', label: 'Shot 01', storyboardAssetId: 'still', referenceAssetIds: ['still'],
  takes: [{ id: 'take-a', assetId: 'take' }], selectedTakeId: 'take-a' },
{ id: 'shot-b', label: 'Shot 02', storyboardAssetId: 'other-still', referenceAssetIds: ['other-still'], takes: [], selectedTakeId: null }] }
const clip = { id: 'clip-a', assetId: 'take', type: 'video', trackId: 'v1', startTime: 3, duration: 4,
  trimStart: 0.5, trimEnd: 4.5, sourceDuration: 5, transform: { scaleX: 100, scaleY: 100 }, keyframes: [],
  url: 'blob:active', cacheStatus: 'cached', cachePath: 'cache/local',
  effects: [{ id: 'effect-a', type: 'masked', maskAssetId: 'mask', strength: 0.5 }],
}
const timelines = [{ id: 'timeline-a', settings: { fps: 24, width: 1920, height: 1080 },
  tracks: [{ id: 'v1', type: 'video', name: 'Video 1', locked: false }],
  clips: [clip, { ...clip, id: 'clip-still', type: 'image', assetId: 'still', sourceDuration: Infinity, startTime: 10 }],
  transitions: [] }]
const recipe = { model: 'Local high-quality model', workflow: 'Audio-guided image to video',
  prompt: 'A performer sings inside a surreal tower.', seed: 4123, width: 1344, height: 768, fps: 24,
  generationDurationSeconds: 5.1666666667, referenceAssetIds: ['still'], inputAssetIds: ['still'],
  songAssetId: 'song', audioStartSeconds: 3, audioDurationSeconds: 4 }
const ctx = { board, assets, timelines }
const record = { operation: 'record_attempt', shotId: 'shot-a', attemptId: 'attempt-a', recipe }
const binding = { operation: 'bind_shot', shotId: 'shot-a', slot: 'final', timelineId: 'timeline-a', clipId: 'clip-a' }
const edit = (run, payload, context = ctx) => planProductionRunEdit(run, payload, context)
const start = () => edit(undefined, record).run
const update = (run, patch) => edit(run, { operation: 'update_attempt', attemptId: 'attempt-a', patch }).run
const complete = () => update(start(), { state: 'completed', remoteJobId: 'remote-a', outputAssetId: 'take' })
const bind = (run = start()) => edit(run, binding).run

test('optional data stays absent on reads and no-ops; explicit edits are portable and pure', () => {
  assert.equal(normalizeProductionRun(undefined), undefined)
  assert.equal(normalizeProductionRun(null), undefined)
  assert.equal(edit(undefined, { operation: 'update_run', patch: {} }).run, undefined)
  assert.equal(edit(undefined, { operation: 'update_run', patch: { notes: '' } }).changed, false)
  assert.equal(edit(undefined, { operation: 'unbind_shot', shotId: 'gone', slot: 'final' }).run, undefined)
  const before = structuredClone(ctx)
  const result = edit(undefined, { operation: 'update_run', patch: { notes: 'Keep the approved casting.', nextAction: 'Review the audition in Velorn.' } })
  assert.equal(result.changed, true)
  assert.deepEqual(result.run, { version: 1, notes: 'Keep the approved casting.', nextAction: 'Review the audition in Velorn.', attempts: [], bindings: [] })
  assert.deepEqual(normalizeProductionRun(JSON.parse(JSON.stringify(result.run))), result.run)
  assert.deepEqual(ctx, before)
  const inspected = inspectProductionRun(undefined, ctx)
  assert.equal(inspected.run, null)
  assert.equal(inspected.summary.exportRequired, false)
  assert.equal(inspected.summary.generationAuthorized, false)
  assert.equal(inspected.summary.statesVerified, false)
})

test('unknown versions and fields fail closed without discarding original data', () => {
  for (const value of [{ ...start(), version: 2 }, { ...start(), future: true }, { ...start(), permission: 'everything' }]) {
    const original = structuredClone(value)
    assert.throws(() => normalizeProductionRun(value), /read-only/)
    assert.throws(() => inspectProductionRun(value, ctx), /read-only/)
    assert.throws(() => edit(value, { operation: 'update_run', patch: { notes: 'replace' } }), /read-only/)
    assert.deepEqual(value, original)
  }
  for (const value of [[], '', false, { version: 1, attempts: [], bindings: null }]) assert.throws(() => normalizeProductionRun(value))
})

test('recipe stores distinct input excerpt and generation duration without generation', () => {
  const run = start()
  assert.equal(run.attempts[0].recipe.audioDurationSeconds, 4)
  assert.equal(run.attempts[0].recipe.generationDurationSeconds, 5.1666666667)
  assert.equal(run.attempts[0].state, 'planned')
  assert.equal(run.attempts[0].remoteJobId, null)
  assert.equal(run.attempts[0].history.length, 1)
  const result = inspectProductionRun(run, ctx)
  assert.equal(result.attempts[0].verified, false)
  assert.equal(result.summary.reportedCompletedCount, 0)
  assert.deepEqual(result.issues, [])
})

test('attempt reservation replay is idempotent after submission, reconnection, and missing inputs', () => {
  const submitted = update(start(), { state: 'submitted', remoteJobId: 'remote-a' })
  const result = edit(submitted, record, { board: { shots: [] }, assets: [], timelines: [] })
  assert.equal(result.changed, false)
  assert.equal(result.deduplicated, true)
  assert.deepEqual(result.run, submitted)
  assert.throws(() => edit(submitted, { ...record, recipe: { ...recipe, seed: 99 } }), /immutable/)
  assert.throws(() => edit(submitted, { ...record, shotId: 'shot-b' }), /immutable/)
  assert.throws(() => edit(submitted, { operation: 'update_attempt', attemptId: 'attempt-a', patch: { recipe } }), /unsupported/)
})

test('reported job updates append history; same updates do not duplicate events', () => {
  let run = start()
  for (const patch of [{ state: 'submitted', remoteJobId: 'remote-a' }, { state: 'running' },
    { state: 'uncertain', note: 'Connection lost; inspect the existing job before another submission.' },
    { state: 'running', note: 'Existing job reconciled by the assistant.' },
    { state: 'completed', outputAssetId: 'take', note: 'Imported the reported output; needs visual review.' }]) {
    const previous = structuredClone(run)
    const length = run.attempts[0].history.length
    run = update(run, patch)
    assert.deepEqual(run.attempts[0].history.slice(0, length), previous.attempts[0].history)
    assert.equal(run.attempts[0].history.length, length + 1)
    assert.equal(edit(run, { operation: 'update_attempt', attemptId: 'attempt-a', patch }).changed, false)
  }
  const inspected = inspectProductionRun(run, ctx)
  assert.equal(inspected.summary.reportedCompletedCount, 1)
  assert.equal(inspected.summary.statesVerified, false)
  assert.equal(inspected.attempts[0].reportedState, 'completed')
  assert.equal('ready' in inspected.summary, false)
})

test('states and output claims have strict identity invariants', () => {
  assert.deepEqual([...PRODUCTION_ATTEMPT_STATES], ['planned', 'submitted', 'running', 'completed', 'failed', 'uncertain', 'cancelled'])
  for (const state of ['submitted', 'running', 'completed']) assert.throws(() => update(start(), { state }), /remoteJobId/)
  assert.throws(() => update(start(), { remoteJobId: 'remote-a' }), /planned/)
  assert.throws(() => update(start(), { state: 'completed', remoteJobId: 'remote-a' }), /outputAssetId/)
  assert.throws(() => update(start(), { outputAssetId: 'take' }), /Only a completed/)
  assert.throws(() => update(start(), { state: 'completed', remoteJobId: 'remote-a', outputAssetId: 'song' }), /image or video/)
  assert.throws(() => update(start(), { state: 'completed', remoteJobId: 'remote-a', outputAssetId: 'missing' }), /missing/)
  assert.throws(() => update(complete(), { remoteJobId: 'remote-b' }), /remoteJobId/)
  assert.throws(() => update(complete(), { outputAssetId: 'retake' }), /completed output/)
  assert.throws(() => update(complete(), { state: 'running', outputAssetId: null }), /new attemptId/)
  assert.throws(() => update(update(start(), { state: 'failed' }), { state: 'submitted', remoteJobId: 'remote-a' }), /retry/)
  assert.throws(() => update(update(start(), { state: 'cancelled' }), { state: 'planned' }), /retry/)
  assert.throws(() => update(update(start(), { state: 'running', remoteJobId: 'remote-a' }), { state: 'submitted' }), /retry/)
})

test('explicit new attempts retain previous failed and completed takes', () => {
  const original = complete()
  const result = edit(original, { ...record, attemptId: 'attempt-b', recipe: { ...recipe, seed: 843 } })
  assert.equal(result.run.attempts.length, 2)
  assert.deepEqual(result.run.attempts[0], original.attempts[0])
  assert.equal(result.run.attempts[1].state, 'planned')
  assert.throws(() => edit(result.run, { operation: 'delete_attempt', attemptId: 'attempt-a' }), /Unknown/)
})

test('uncertain jobs remain visible and require reconciliation even without a known remote ID', () => {
  const run = update(start(), { state: 'uncertain', note: 'Lost response while submitting; do not resubmit blindly.' })
  const inspected = inspectProductionRun(run, ctx)
  assert.equal(inspected.summary.needsReconciliationCount, 1)
  assert.equal(inspected.issues[0].code, 'reconcile-job-before-retry')
  assert.equal(inspected.issues[0].remoteJobId, null)
  const reconciled = update(run, { state: 'completed', remoteJobId: 'found-job', outputAssetId: 'take' })
  assert.equal(inspectProductionRun(reconciled, ctx).summary.needsReconciliationCount, 0)
})

test('normalization validates history, refuses rollback tampering, and preserves snapshots', () => {
  for (const mutate of [
    attempt => { attempt.history = [] },
    attempt => { attempt.state = 'uncertain' },
    attempt => { attempt.history[0].state = 'failed' },
    attempt => { attempt.history.push({ ...attempt.history.at(-1), remoteJobId: 'changed' }) },
  ]) {
    const run = complete()
    mutate(run.attempts[0])
    assert.throws(() => normalizeProductionRun(run))
  }
  const source = complete(), before = structuredClone(source)
  normalizeProductionRun(source).attempts[0].history[0].note = 'Caller mutation'
  inspectProductionRun(source, ctx).attempts[0].recipe.prompt = 'Caller mutation'
  assert.deepEqual(source, before)
})

test('new recipes require existing unambiguous inputs and valid audio excerpts', () => {
  for (const replacement of [{ songAssetId: 'silent-video' }, { songAssetId: 'missing' },
    { songAssetId: null }, { audioStartSeconds: 44, audioDurationSeconds: 2 },
    { inputAssetIds: ['missing'] }, { referenceAssetIds: ['missing'] }]) {
    assert.throws(() => edit(undefined, { ...record, recipe: { ...recipe, ...replacement } }))
  }
  assert.throws(() => edit(undefined, record, { ...ctx, assets: [...assets, assets[1]] }), /ambiguous/)
  assert.throws(() => edit(undefined, record, { ...ctx, board: { shots: [...board.shots, board.shots[0]] } }), /ambiguous/)
  assert.throws(() => edit(undefined, { ...record, shotId: 'missing' }), /missing/)
  assert.equal(edit(undefined, { ...record, recipe: { ...recipe, songAssetId: 'sound-video' } }).changed, true)
  const imageRecipe = { model: 'Image model', workflow: 'Text to image', prompt: 'A tall tower.' }
  assert.equal(edit(undefined, { ...record, recipe: imageRecipe }).changed, true)
})

test('invalid fields, paths, oversized values and non-finite numeric metadata are rejected', () => {
  for (const patch of [{ apiKey: 'secret' }, { workflowGraph: {} }, { command: 'do something' }, { path: '/home/user/model' },
    { model: '/home/user/model' }, { workflow: 'https://example.com/workflow' },
    { referenceAssetIds: ['../../asset'] }, { inputAssetIds: ['still', 'still'] },
    { seed: -1 }, { seed: Number.MAX_SAFE_INTEGER + 1 }, { seed: 1.3 }, { width: 3 }, { height: 800.5 },
    { fps: Infinity }, { generationDurationSeconds: 0 }, { audioStartSeconds: -1 },
    { prompt: 'x'.repeat(PRODUCTION_RUN_LIMITS.prompt + 1) }]) assert.throws(() => edit(undefined, { ...record, recipe: { ...recipe, ...patch } }))
  for (const attemptId of ['', 'has space', '../path', 'x'.repeat(161)]) assert.throws(() => edit(undefined, { ...record, attemptId }))
  assert.throws(() => edit(undefined, { operation: 'update_run', patch: { notes: 'x'.repeat(4001) } }), /4000/)
  assert.throws(() => edit(undefined, { operation: 'update_run', patch: { nextAction: '\u0000bad' } }), /text/)
  assert.throws(() => edit(undefined, { ...record, authorization: true }), /unsupported/)
})

test('orphaned shots and removed media stay in records and can receive reconciliation notes', () => {
  const run = complete()
  const context = { board: { shots: [] }, assets: [], timelines: [] }
  const before = structuredClone(run)
  const inspected = inspectProductionRun(run, context)
  assert.ok(inspected.issues.some(issue => issue.code === 'missing-shot'))
  assert.ok(inspected.issues.some(issue => issue.code === 'missing-asset' && issue.assetId === 'take'))
  assert.deepEqual(run, before)
  const result = edit(run, { operation: 'update_attempt', attemptId: 'attempt-a', patch: { note: 'Original shot removed; keep this history.' } }, context)
  assert.equal(result.changed, true)
  assert.equal(result.run.attempts[0].outputAssetId, 'take')
})

test('relinked assets with incompatible media or shorter audio are surfaced, never removed', () => {
  const run = bind(complete())
  const shortened = structuredClone(ctx)
  shortened.assets[0].duration = 4
  assert.ok(inspectProductionRun(run, shortened).attempts[0].issues.some(issue => issue.code === 'incompatible-input-or-output'))
  const changedKind = structuredClone(ctx)
  changedKind.assets.find(asset => asset.id === 'take').type = 'audio'
  const result = inspectProductionRun(run, changedKind)
  assert.ok(result.attempts[0].issues.some(issue => issue.code === 'incompatible-input-or-output'))
  assert.ok(result.bindings[0].issues.some(issue => issue.code === 'incompatible-clip-asset'))
  assert.equal(result.run.attempts[0].outputAssetId, 'take')
  assert.equal(result.run.bindings[0].baseline.sourceAssetId, 'take')
})

test('bounded attempt and history limits do not truncate existing takes or events', () => {
  let run
  for (let index = 0; index < PRODUCTION_RUN_LIMITS.attemptsPerShot; index++) run = edit(run, { ...record, attemptId: `attempt-${index}` }).run
  const original = structuredClone(run)
  assert.throws(() => edit(run, { ...record, attemptId: 'too-many' }), /at most 30/)
  assert.deepEqual(run, original)
  run = start()
  for (let index = 1; index < PRODUCTION_RUN_LIMITS.history; index++) run = update(run, { note: `Update ${index}` })
  assert.throws(() => update(run, { note: 'One too many' }), /history is full/)
  assert.equal(edit(run, { operation: 'update_attempt', attemptId: 'attempt-a', patch: { note: 'Update 99' } }).changed, false)
})

test('binding derives a portable baseline from a unique existing timeline clip', () => {
  const before = structuredClone(ctx)
  const run = bind()
  const bound = run.bindings[0]
  assert.equal(bound.baseline.sourceAssetId, 'take')
  assert.equal(bound.baseline.trimStart, 0.5)
  assert.equal(bound.baseline.startTime, 3)
  assert.deepEqual(bound.baseline.referencedAssetIds, ['mask', 'take'])
  assert.match(bound.baseline.signature, /^production-clip-v1-[a-f0-9]{32}$/)
  assert.equal(JSON.stringify(bound).includes('blob:'), false)
  assert.equal(JSON.stringify(bound).includes('cache/local'), false)
  assert.deepEqual(ctx, before)
  assert.equal(inspectProductionRun(run, ctx).bindings[0].status, 'linked')
  assert.equal(inspectProductionRun(run, ctx).summary.linkedCount, 1)
  assert.deepEqual(normalizeProductionRun(JSON.parse(JSON.stringify(run))), run)
  assert.throws(() => edit(start(), { ...binding, baseline: { signature: 'forged' } }), /unsupported/)
})

test('animatic and final bindings require the appropriate shot source and media kind', () => {
  const animatic = { ...binding, slot: 'animatic', clipId: 'clip-still' }
  assert.equal(edit(undefined, animatic).run.bindings[0].baseline.type, 'image')
  assert.throws(() => edit(undefined, { ...animatic, clipId: 'clip-a' }), /image/)
  assert.throws(() => edit(undefined, { ...binding, clipId: 'clip-still' }), /video/)
  assert.throws(() => edit(undefined, { ...binding, shotId: 'shot-b' }), /source/)
  const noSelected = { ...ctx, board: { shots: [{ ...board.shots[0], selectedTakeId: null }] } }
  assert.throws(() => edit(undefined, binding, noSelected), /source/)
  assert.equal(edit(complete(), binding, noSelected).changed, true)
  const noExplicitStill = { ...ctx, board: { shots: [{ id: 'shot-a', takes: [], referenceAssetIds: ['still'] }] } }
  assert.equal(edit(undefined, animatic, noExplicitStill).changed, true)
  const intentionallyNoStill = { ...noExplicitStill, board: { shots: [{ ...noExplicitStill.board.shots[0], storyboardAssetId: null }] } }
  assert.throws(() => edit(undefined, animatic, intentionallyNoStill), /source/)
})

test('binding replay cannot refresh an edited baseline; only explicit rebind acknowledges it', () => {
  const run = bind()
  const context = structuredClone(ctx)
  context.timelines[0].clips[0].duration = 3
  assert.equal(inspectProductionRun(run, context).bindings[0].status, 'changed')
  const replay = edit(run, binding, context)
  assert.equal(replay.changed, false)
  assert.deepEqual(replay.run.bindings, run.bindings)
  const rebound = edit(run, { ...binding, rebind: true }, context)
  assert.equal(rebound.changed, true)
  assert.equal(rebound.run.bindings[0].baseline.duration, 3)
  assert.equal(inspectProductionRun(rebound.run, context).bindings[0].status, 'linked')
})

test('one shot-slot cannot silently change targets and one timeline clip cannot bind twice', () => {
  const run = bind()
  const context = structuredClone(ctx)
  context.timelines[0].clips.push({ ...clip, id: 'clip-new' })
  assert.throws(() => edit(run, { ...binding, clipId: 'clip-new' }, context), /explicit rebind/)
  assert.equal(edit(run, { ...binding, clipId: 'clip-new', rebind: true }, context).run.bindings[0].clipId, 'clip-new')
  context.board.shots[1].takes = [{ id: 'take-b', assetId: 'take' }]
  context.board.shots[1].selectedTakeId = 'take-b'
  assert.throws(() => edit(run, { ...binding, shotId: 'shot-b' }, context), /already bound/)
  assert.throws(() => normalizeProductionRun({ ...run, bindings: [...run.bindings, { ...run.bindings[0], shotId: 'shot-b' }] }), /duplicates/)
  assert.throws(() => normalizeProductionRun({ ...run, bindings: [...run.bindings, { ...run.bindings[0], clipId: 'other' }] }), /duplicates/)
})

test('deleted, ambiguous and stale targets are inspected without changing the timeline or record', () => {
  const run = bind()
  const cases = [
    ['missing-shot', context => { context.board.shots = [] }],
    ['ambiguous-shot', context => { context.board.shots.push(context.board.shots[0]) }],
    ['missing-timeline', context => { context.timelines = [] }],
    ['ambiguous-timeline', context => { context.timelines.push(context.timelines[0]) }],
    ['missing-clip', context => { context.timelines[0].clips = [] }],
    ['ambiguous-clip', context => { context.timelines[0].clips.push(context.timelines[0].clips[0]) }],
    ['missing-asset', context => { context.assets = context.assets.filter(asset => asset.id !== 'take') }],
    ['ambiguous-asset', context => { context.assets.push(context.assets.find(asset => asset.id === 'take')) }],
    ['unsupported-clip', context => { context.timelines[0].tracks = [] }],
    ['shot-source-changed', context => { context.board.shots[0].selectedTakeId = null }],
  ]
  for (const [code, mutate] of cases) {
    const context = structuredClone(ctx)
    mutate(context)
    const previous = structuredClone({ run, context })
    const result = inspectProductionRun(run, context)
    assert.ok(result.bindings[0].issues.some(issue => issue.code === code), `${code} should be visible`)
    assert.deepEqual({ run, context }, previous)
  }
})

test('unsafe binding targets fail before mutation', () => {
  const mutations = [
    context => { context.timelines = [] },
    context => { context.timelines.push(context.timelines[0]) },
    context => { context.timelines[0].clips.push(context.timelines[0].clips[0]) },
    context => { context.timelines[0].tracks.push(context.timelines[0].tracks[0]) },
    context => { context.timelines[0].tracks[0].type = 'audio' },
    context => { context.timelines[0].clips[0].assetId = 'missing' },
    context => { context.timelines[0].clips[0].duration = 0 },
    context => { context.timelines[0].clips[0].type = 'compound' },
  ]
  for (const mutate of mutations) {
    const context = structuredClone(ctx)
    mutate(context)
    assert.throws(() => edit(undefined, binding, context))
  }
})

test('authored timing, source, transform, masks, effects, keyframes and track changes invalidate a binding', () => {
  const run = bind()
  const mutations = [
    value => { value.startTime = 3.5 }, value => { value.duration = 3.5 }, value => { value.trimStart = 0.75 },
    value => { value.trimEnd = 4.7 }, value => { value.assetId = 'retake' },
    value => { value.transform.scaleX = 120 }, value => { value.reverse = true },
    value => { value.speed = 0.5 }, value => { value.effects[0].strength = 0.8 },
    value => { value.effects[0].maskAssetId = 'other-still' },
    value => { value.keyframes = [{ time: 1, property: 'scaleX', value: 150 }] },
    value => { value.enabled = false }, value => { value.shapeMask = { mode: 'circle', feather: 0.5 } },
    value => { value.trackMatte = 'luma-inverted' },
  ]
  for (const mutate of mutations) {
    const context = structuredClone(ctx)
    mutate(context.timelines[0].clips[0])
    assert.equal(inspectProductionRun(run, context).bindings[0].status, 'changed')
  }
  const context = structuredClone(ctx)
  context.timelines[0].tracks[0].locked = true
  assert.equal(inspectProductionRun(run, context).bindings[0].status, 'changed')
  context.timelines[0].tracks[0].locked = false
  context.timelines[0].tracks[0].visible = false
  assert.equal(inspectProductionRun(run, context).bindings[0].status, 'changed')
})

test('native track matte and GLSL effect settings/keyframes remain authored changes', () => {
  const context = structuredClone(ctx)
  context.timelines[0].clips[0].trackMatte = 'alpha'
  context.timelines[0].clips[0].effects.push({ id: 'grain-1', type: 'glslFilmGrain',
    enabled: true, settings: { amount: 0.2, size: 1 }, keyframes: { amount: [{ time: 0, value: 0.2 }] } })
  const run = edit(start(), binding, context).run
  for (const mutate of [
    value => { value.trackMatte = 'luma' },
    value => { value.effects[1].settings.amount = 0.5 },
    value => { value.effects[1].keyframes.amount[0].value = 0.7 },
    value => { value.effects[1].enabled = false },
  ]) {
    const changed = structuredClone(context)
    mutate(changed.timelines[0].clips[0])
    assert.equal(inspectProductionRun(run, changed).bindings[0].status, 'changed')
  }
})

test('same-ID source revisions and measured media metadata invalidate a binding', () => {
  const run = bind()
  for (const patch of [
    { sourceVersion: 'new-file-content' }, { modified: '2026-09-28T10:00:00.000Z' },
    { size: 8239718 }, { duration: 6 }, { width: 1920 }, { height: 1080 }, { fps: 30 },
    { hasAudio: true }, { settings: { sourceVersion: 2 } }, { settings: { width: 1920, height: 1080 } },
  ]) {
    const context = structuredClone(ctx)
    Object.assign(context.assets.find(asset => asset.id === 'take'), patch)
    const result = inspectProductionRun(run, context)
    assert.equal(result.bindings[0].status, 'changed', JSON.stringify(patch))
    assert.equal(result.bindings[0].baseline.sourceAssetId, 'take')
    assert.equal(result.bindings[0].current.sourceAssetId, 'take')
  }
  const context = structuredClone(ctx)
  context.assets.find(asset => asset.id === 'mask').sourceVersion = 'retouched-mask'
  assert.equal(inspectProductionRun(run, context).bindings[0].status, 'changed')
})

test('same-ID media relinking tracks portable filenames without pinning the project root', () => {
  const context = structuredClone(ctx)
  Object.assign(context.assets.find(asset => asset.id === 'take'), {
    path: 'assets/video/original.mp4', absolutePath: '/old-project/assets/video/original.mp4',
    url: 'blob:original-url', sourceVersion: 1,
  })
  const run = edit(start(), binding, context).run
  const relocated = structuredClone(context)
  Object.assign(relocated.assets.find(asset => asset.id === 'take'), {
    path: 'assets\\video\\original.mp4', absolutePath: 'D:\\new-project\\assets\\video\\original.mp4',
    url: 'blob:new-url', thumbnail: 'blob:poster', proxyPath: 'cache/proxy-new.mp4',
  })
  assert.equal(inspectProductionRun(run, relocated).bindings[0].status, 'linked')
  relocated.assets.find(asset => asset.id === 'take').path = 'assets/video/replacement.mp4'
  assert.equal(inspectProductionRun(run, relocated).bindings[0].status, 'changed')
  assert.equal(JSON.stringify(run).includes('old-project'), false)
  assert.equal(JSON.stringify(run).includes('original.mp4'), false)
})

test('absolute-only legacy media identity survives relocation but notices a new filename', () => {
  const context = structuredClone(ctx)
  context.assets.find(asset => asset.id === 'take').absolutePath = '/Volumes/old-drive/original.mp4'
  const run = edit(start(), binding, context).run
  context.assets.find(asset => asset.id === 'take').absolutePath = 'C:\\new-drive\\original.mp4'
  assert.equal(inspectProductionRun(run, context).bindings[0].status, 'linked')
  context.assets.find(asset => asset.id === 'take').absolutePath = 'C:\\new-drive\\replacement.mp4'
  assert.equal(inspectProductionRun(run, context).bindings[0].status, 'changed')
})

test('playback URLs, cache data and asset list order do not affect source identity', () => {
  const run = bind()
  const context = structuredClone(ctx)
  Object.assign(context.assets.find(asset => asset.id === 'take'), {
    url: 'file:///new-location/video.mp4', thumbnail: 'blob:new-poster', cacheStatus: 'ready',
    cachePath: '/new/cache.mp4', proxyPath: '/new/proxy.mp4', preparationProgress: 0.9,
  })
  context.assets.reverse()
  assert.equal(inspectProductionRun(run, context).bindings[0].status, 'linked')
})

test('source-signature inspection is metadata-only and cannot prove unchanged bytes', () => {
  const run = bind()
  const context = structuredClone(ctx)
  // File bytes deliberately do not exist in this pure domain fixture. A caller
  // must update source metadata after relinking; this is not a content hash.
  context.assets.find(asset => asset.id === 'take').url = 'blob:different-bytes-same-reported-metadata'
  const inspected = inspectProductionRun(run, context)
  assert.equal(inspected.bindings[0].status, 'linked')
  assert.equal(inspected.summary.statesVerified, false)
  context.assets.find(asset => asset.id === 'take').sourceVersion = 'explicit-revision'
  assert.equal(inspectProductionRun(run, context).bindings[0].status, 'changed')
})

test('related transitions and composition settings invalidate identity; unrelated clips do not', () => {
  const run = bind()
  const context = structuredClone(ctx)
  context.timelines[0].transitions = [{ id: 't1', kind: 'edge', clipId: 'clip-a', duration: 0.5, type: 'fade' }]
  assert.equal(inspectProductionRun(run, context).bindings[0].status, 'changed')
  context.timelines[0].transitions[0].clipId = 'clip-still'
  assert.equal(inspectProductionRun(run, context).bindings[0].status, 'linked')
  context.timelines[0].settings.fps = 30
  assert.equal(inspectProductionRun(run, context).bindings[0].status, 'changed')
})

test('cache hydration, URL relocation, field order and selection do not invalidate authored identity', () => {
  const before = getProductionClipIdentity(clip, timelines[0])
  const context = structuredClone(ctx)
  const value = context.timelines[0].clips[0]
  Object.assign(value, { url: '/other-machine/video.mp4', thumbnail: 'blob:changed', cacheStatus: 'rendering',
    cachePath: '/other-machine/cache', cacheProgress: 0.8, selected: true })
  value.effects[0].cacheUrl = 'blob:effect-cache'
  value.effects[0].cacheStatus = 'cached'
  value.transform = { scaleY: 100, scaleX: 100 }
  assert.deepEqual(getProductionClipIdentity(value, context.timelines[0]), before)
  assert.equal(inspectProductionRun(bind(), context).bindings[0].status, 'linked')
})

test('asset references protect recipe inputs, completed output, and old binding sources from deletion', () => {
  const run = bind(complete())
  assert.deepEqual([...collectAssetReferences(run)].sort(), ['mask', 'song', 'still', 'take'])
  const context = structuredClone(ctx)
  context.timelines[0].clips[0].assetId = 'retake'
  const result = inspectProductionRun(run, context)
  assert.equal(result.bindings[0].status, 'changed')
  assert.equal(result.bindings[0].baseline.sourceAssetId, 'take')
  assert.equal(result.bindings[0].current.sourceAssetId, 'retake')
  assert.equal(collectAssetReferences(run).has('take'), true)
})

test('explicit unbind works for missing shots without deleting attempts or timeline clips', () => {
  const run = bind(complete())
  const before = structuredClone(ctx)
  const result = edit(run, { operation: 'unbind_shot', shotId: 'shot-a', slot: 'final' }, { ...ctx, board: { shots: [] } })
  assert.equal(result.changed, true)
  assert.deepEqual(result.run.bindings, [])
  assert.deepEqual(result.run.attempts, run.attempts)
  assert.deepEqual(ctx, before)
})

test('cyclic or extreme clip data fails closed instead of freezing or saving a raw graph', () => {
  const value = structuredClone(clip)
  value.transform.recursive = value.transform
  assert.throws(() => getProductionClipIdentity(value, timelines[0]), /not serializable/)
  value.transform = { x: 'x'.repeat(PRODUCTION_RUN_LIMITS.identityBytes + 1) }
  assert.throws(() => getProductionClipIdentity(value, timelines[0]), /too large/)
})
