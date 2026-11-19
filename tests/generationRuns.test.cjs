'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createGenerationRuns, FILE_NAME, LIMITS } = require('../electron/generationRuns.cjs')

const graph = () => ({
  '1': { class_type: 'KSampler', inputs: { seed: 12, api_key: 'sk-test-secret-never-persisted' } },
  '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
})
const fingerprint = workflow => crypto.createHash('sha256').update(JSON.stringify(workflow)).digest('hex')
const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function until(predicate, label = 'condition') {
  for (let index = 0; index < 100; index++) {
    if (await predicate()) return
    await wait(2)
  }
  assert.fail(`Timed out waiting for ${label}`)
}

async function harness(options = {}) {
  const ownsStorageDir = !options.storageDir
  const storageDir = options.storageDir || await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-generation-runs-'))
  const state = {
    endpoint: 'http://127.0.0.1:8188',
    context: { session: 'session-one', projectKey: '/synthetic/project-one', timelineId: 'timeline-one' },
    queue: [], histories: new Map(), accepted: new Map(), now: 0, ...options.state,
  }
  const calls = { fetch: [], submitted: [], notifications: [], postSawLedger: null }
  let manager
  const fetchImpl = async (url, init = {}) => {
    calls.fetch.push({ url, init })
    await options.onFetch?.({ url, init, state, calls })
    if (url.endsWith('/queue') && init.method !== 'POST') {
      return response({
        queue_running: state.queue.filter(item => item.status === 'running').map(item => [0, item.promptId, item.workflow, {}, []]),
        queue_pending: state.queue.filter(item => item.status === 'queued').map(item => [0, item.promptId, item.workflow, {}, []]),
      })
    }
    if (url.endsWith('/queue') && init.method === 'POST') {
      const body = JSON.parse(init.body)
      for (const id of body.delete || []) state.queue = state.queue.filter(item => item.promptId !== id)
      return response({ success: true })
    }
    const match = url.match(/\/history\/([^/?#]+)$/)
    if (match) return response(state.histories.get(decodeURIComponent(match[1])) || {})
    throw new Error(`Unexpected ComfyUI request: ${url}`)
  }
  const submitManaged = async payload => {
    calls.submitted.push(payload)
    await manager.beforeSubmit({ ...payload, fingerprint: fingerprint(payload.workflow),
      context: JSON.stringify([state.context.session, state.context.projectKey, state.context.timelineId]), assessment: { risk: 'local', nodeCount: 2 } })
    // This represents the broker's one POST. The ledger must already be on
    // disk before an injected submitter is allowed to reach this point.
    const raw = await fs.readFile(path.join(storageDir, FILE_NAME), 'utf8')
    calls.postSawLedger = JSON.parse(raw)
    const promptId = `prompt-${calls.submitted.length}`
    state.queue.push({ promptId, status: 'queued', workflow: payload.workflow })
    const result = { success: true, ok: true, status: 200, body: { prompt_id: promptId } }
    await manager.afterSubmit({ requestId: payload.requestId, result })
    return result
  }
  manager = createGenerationRuns({
    storageDir,
    getEndpoint: async () => state.endpoint,
    getContext: async () => ({ ...state.context }),
    submitManaged,
    notify: snapshot => calls.notifications.push(snapshot),
    onGenerationFinished: options.onGenerationFinished,
    fetchImpl,
    assertAvailable: options.assertAvailable || (() => {}),
    now: () => new Date(++state.now * 1000).toISOString(),
    uuid: () => `00000000-0000-4000-8000-${String(++state.now).padStart(12, '0')}`,
    pollIntervalMs: options.pollIntervalMs ?? 1000,
    maxPollAttempts: options.maxPollAttempts ?? 3,
  })
  return {
    storageDir, state, calls, manager,
    async close() { manager.dispose(); if (ownsStorageDir) await fs.rm(storageDir, { recursive: true, force: true }) },
  }
}

function storedLedgerRun(index, status = 'queued') {
  const workflow = graph()
  return {
    id: `stored-run-${String(index).padStart(4, '0')}`, requestId: `stored-request-${String(index).padStart(4, '0')}`,
    promptId: `stored-prompt-${index}`, endpoint: 'http://127.0.0.1:8188', projectKey: '/synthetic/project-one', timelineId: 'timeline-one',
    origin: 'agent', adopted: false, label: `Stored ${index}`, status, createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null, completedAt: status === 'done' ? '2026-01-01T00:01:00.000Z' : null, progress: null, node: null, error: null,
    outputs: [], resultAssetIds: [], assessment: { risk: 'local' }, importState: 'pending', inputAssetIds: [], targetShotId: null,
    recipe: { workflow, fingerprint: fingerprint(workflow), redacted: true, cannotExactReplay: true, note: 'Synthetic.' }, pollAttempts: 0, missingAttempts: 0,
  }
}

test('submit is preview-only by default and makes no ledger or ComfyUI submission', async t => {
  const f = await harness(); t.after(() => f.close())
  const result = await f.manager.submit({ workflow: graph(), label: 'A test run' })
  assert.equal(result.success, true)
  assert.equal(result.previewOnly, true)
  assert.equal(f.calls.submitted.length, 0)
  await assert.rejects(fs.readFile(path.join(f.storageDir, FILE_NAME)), { code: 'ENOENT' })
})

test('confirmed managed completion triggers optional memory cleanup once, without changing output records', async t => {
  const finished = []
  const f = await harness({ pollIntervalMs: 1, onGenerationFinished: detail => finished.push(detail) }); t.after(() => f.close())
  await f.manager.submit({ workflow: graph(), previewOnly: false })
  assert.equal(finished.length, 0)
  f.state.queue = []
  f.state.histories.set('prompt-1', { 'prompt-1': { status: { status_str: 'success' }, outputs: {} } })
  await until(async () => finished.length === 1, 'cleanup completion')
  assert.deepEqual(finished, [{ endpoint: f.state.endpoint }])
  assert.equal((await f.manager.list()).runs[0].status, 'done')
  await f.manager.observe(); await wait(5)
  assert.equal(finished.length, 1)
})

test('agent submission persists a redacted run before POST and tracks the returned prompt', async t => {
  const f = await harness(); t.after(() => f.close())
  const result = await f.manager.submit({ workflow: graph(), label: 'Agent test', inputAssetIds: ['asset-a'], targetShotId: 'shot-4', previewOnly: false })
  assert.equal(result.success, true)
  assert.equal(result.run.origin, 'agent')
  assert.equal(result.run.status, 'queued')
  assert.equal(result.run.promptId, 'prompt-1')
  assert.equal(f.calls.submitted.length, 1)
  assert.ok(f.calls.postSawLedger)
  const raw = await fs.readFile(path.join(f.storageDir, FILE_NAME), 'utf8')
  assert.doesNotMatch(raw, /sk-test-secret-never-persisted/)
  assert.match(raw, /\[redacted\]/)
  const recipe = await f.manager.recipe({ runId: result.runId })
  assert.equal(recipe.success, true)
  assert.equal(recipe.workflow['1'].inputs.api_key, '[redacted]')
  assert.equal(recipe.cannotExactReplay, true)
  assert.equal((await f.manager.list()).runs[0].targetShotId, 'shot-4')
})

test('a durable-ledger storage failure blocks submission before any ComfyUI POST', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-generation-runs-blocked-'))
  const blockedStorageDir = path.join(root, 'not-a-directory')
  await fs.writeFile(blockedStorageDir, 'not a directory')
  const f = await harness({ storageDir: blockedStorageDir })
  t.after(async () => { await f.close(); await fs.rm(root, { recursive: true, force: true }) })
  const result = await f.manager.submit({ workflow: graph(), previewOnly: false })
  assert.equal(result.success, false)
  assert.equal(result.code, 'GENERATION_RUNS_STORAGE_UNAVAILABLE')
  assert.equal(f.calls.fetch.filter(call => call.init.method === 'POST').length, 0)
  assert.equal((await f.manager.list()).runs.length, 0)
})

test('list is cached, project-scoped by default, and does not poll ComfyUI', async t => {
  const f = await harness(); t.after(() => f.close())
  const first = await f.manager.submit({ workflow: graph(), previewOnly: false })
  f.state.context = { session: 'session-two', projectKey: '/synthetic/project-two', timelineId: 'timeline-two' }
  const second = await f.manager.submit({ workflow: graph(), previewOnly: false })
  f.calls.fetch.length = 0
  const current = await f.manager.list()
  const all = await f.manager.list({ includeOtherProjects: true })
  assert.deepEqual(current.runs.map(run => run.id), [second.runId])
  assert.deepEqual(all.runs.map(run => run.id).sort(), [first.runId, second.runId].sort())
  assert.equal(f.calls.fetch.length, 0)
})

test('observe is read-only and adoption previews before explicitly writing an external run', async t => {
  const f = await harness(); t.after(() => f.close())
  const external = graph()
  f.state.queue.push({ promptId: 'external-prompt', status: 'queued', workflow: external })
  const observed = await f.manager.observe()
  assert.equal(observed.success, true)
  assert.deepEqual(observed.jobs.map(job => job.promptId), ['external-prompt'])
  await assert.rejects(fs.readFile(path.join(f.storageDir, FILE_NAME)), { code: 'ENOENT' })
  const preview = await f.manager.adopt({ promptId: 'external-prompt', label: 'Manual ComfyUI run' })
  assert.equal(preview.success, true)
  assert.equal(preview.previewOnly, true)
  assert.equal(preview.candidate.origin, 'external')
  assert.equal(preview.candidate.adopted, true)
  await assert.rejects(fs.readFile(path.join(f.storageDir, FILE_NAME)), { code: 'ENOENT' })
  const adopted = await f.manager.adopt({ promptId: 'external-prompt', label: 'Manual ComfyUI run', previewOnly: false })
  assert.equal(adopted.success, true)
  assert.equal(adopted.adopted, true)
  assert.equal(adopted.run.adopted, true)
  const stored = await f.manager.recipe({ runId: adopted.run.id })
  assert.equal(stored.workflow['1'].inputs.api_key, '[redacted]')
})

test('adoption rejects mismatched provenance and a project or endpoint switch before its write', async t => {
  const mismatch = await harness(); t.after(() => mismatch.close())
  mismatch.state.queue.push({ promptId: 'external-mismatch', status: 'queued', workflow: graph() })
  const different = graph(); different['1'].inputs.seed = 99
  const wrong = await mismatch.manager.adopt({ promptId: 'external-mismatch', workflow: different })
  assert.equal(wrong.success, false)
  assert.equal(wrong.code, 'GENERATION_RUNS_WORKFLOW_MISMATCH')

  let switched = false
  const f = await harness({ onFetch: async ({ url, state }) => {
    if (!switched && url.endsWith('/queue')) {
      switched = true
      state.context = { session: 'session-two', projectKey: '/synthetic/project-two', timelineId: 'timeline-two' }
      state.endpoint = 'http://127.0.0.1:8189'
    }
  } })
  t.after(() => f.close())
  f.state.queue.push({ promptId: 'external-race', status: 'queued', workflow: graph() })
  const raced = await f.manager.adopt({ promptId: 'external-race', previewOnly: false })
  assert.equal(raced.success, false)
  assert.equal(raced.code, 'GENERATION_RUNS_STALE_CONTEXT')
  await assert.rejects(fs.readFile(path.join(f.storageDir, FILE_NAME)), { code: 'ENOENT' })
})

test('cancel is preview-only by default, rechecks the live queue, and never uses a global interrupt', async t => {
  const f = await harness(); t.after(() => f.close())
  const submitted = await f.manager.submit({ workflow: graph(), previewOnly: false })
  f.calls.fetch.length = 0
  const preview = await f.manager.control({ runId: submitted.runId, operation: 'cancel' })
  assert.equal(preview.success, true)
  assert.equal(preview.previewOnly, true)
  assert.equal(f.calls.fetch.filter(call => call.init.method === 'POST').length, 0)
  const cancelled = await f.manager.control({ runId: submitted.runId, operation: 'cancel', previewOnly: false })
  assert.equal(cancelled.success, true)
  assert.equal(cancelled.run.status, 'cancelled')
  const posts = f.calls.fetch.filter(call => call.init.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(JSON.parse(posts[0].init.body), { delete: ['prompt-1'] })
  assert.match(posts[0].url, /\/queue$/)
})

test('cancel rejects a card that became running after it was recorded', async t => {
  const f = await harness(); t.after(() => f.close())
  const submitted = await f.manager.submit({ workflow: graph(), previewOnly: false })
  f.state.queue[0].status = 'running'
  const result = await f.manager.control({ runId: submitted.runId, operation: 'cancel', previewOnly: false })
  assert.equal(result.success, false)
  assert.equal(result.code, 'GENERATION_RUNS_RUNNING_CANCEL_UNSUPPORTED')
  assert.equal(f.calls.fetch.filter(call => call.init.method === 'POST').length, 0)
})

test('retry cannot carry an old project run into a newly selected project', async t => {
  let switchDuringApply = false
  const f = await harness({ assertAvailable: async () => {
    if (switchDuringApply) {
      f.state.context = { session: 'session-two', projectKey: '/synthetic/project-two', timelineId: 'timeline-two' }
    }
  } })
  t.after(() => f.close())
  const old = await f.manager.submit({ workflow: graph(), previewOnly: false })
  switchDuringApply = true
  const result = await f.manager.control({ runId: old.runId, operation: 'retry', workflow: graph(), previewOnly: false })
  assert.equal(result.success, false)
  assert.equal(result.code, 'GENERATION_RUNS_STALE_CONTEXT')
  assert.equal(f.calls.submitted.length, 1)
})

test('normal long-running jobs do not expire from successful polls, while missing prompts become recoverable unknowns', async t => {
  const f = await harness({ pollIntervalMs: 1, maxPollAttempts: 1 }); t.after(() => f.close())
  const submitted = await f.manager.submit({ workflow: graph(), previewOnly: false })
  f.state.queue[0].status = 'running'
  await wait(18)
  assert.equal((await f.manager.list()).runs[0].status, 'running')
  // The prompt then disappears from both queue and history. It becomes unknown
  // without any new submission, and an explicit read-only Refresh recovers it.
  f.state.queue = []
  await until(async () => (await f.manager.list()).runs[0].status === 'unknown', 'missing prompt')
  assert.equal(f.calls.submitted.length, 1)
  f.state.queue = [{ promptId: 'prompt-1', status: 'running', workflow: graph() }]
  const refresh = await f.manager.observe()
  assert.equal(refresh.success, true)
  await until(async () => (await f.manager.list()).runs[0].status === 'running', 'recovered prompt')
  assert.equal(f.calls.submitted.length, 1)
})

test('an explicit observe refresh is not lost when a prior poll turns its last active prompt unknown', async t => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-generation-runs-recovery-race-'))
  let releaseBlockedPoll
  const blockedPoll = new Promise(resolve => { releaseBlockedPoll = resolve })
  let firstQueueRead
  const firstQueueReadStarted = new Promise(resolve => { firstQueueRead = resolve })
  let blockOneQueueRead = true
  const f = await harness({ storageDir, pollIntervalMs: 1, maxPollAttempts: 1, onFetch: async ({ url, init }) => {
    if (blockOneQueueRead && url.endsWith('/queue') && init.method !== 'POST') {
      blockOneQueueRead = false
      firstQueueRead()
      await blockedPoll
    }
  } })
  t.after(async () => { await f.close(); await fs.rm(storageDir, { recursive: true, force: true }) })
  // The existing unknown prompt is a recoverable receipt from an earlier
  // session. The new submission gives us one active prompt whose in-flight
  // poll races the user's explicit Refresh action.
  await fs.writeFile(path.join(storageDir, FILE_NAME), JSON.stringify({ version: 1, updatedAt: '2026-01-01T00:00:00.000Z',
    runs: [storedLedgerRun(99, 'unknown')] }))
  const submitted = await f.manager.submit({ workflow: graph(), previewOnly: false })
  await firstQueueReadStarted
  f.state.queue = [] // The first prompt vanishes while its poll is in flight.
  const observed = await f.manager.observe()
  assert.equal(observed.success, true)
  f.state.queue = [{ promptId: 'stored-prompt-99', status: 'running', workflow: graph() }]
  releaseBlockedPoll()
  await until(async () => (await f.manager.list({ includeOtherProjects: true })).runs
    .some(run => run.promptId === 'stored-prompt-99' && run.status === 'running'), 'recovered unknown prompt')
  const runs = (await f.manager.list({ includeOtherProjects: true })).runs
  assert.equal(runs.find(run => run.id === submitted.runId).status, 'unknown')
})

test('polling rotates through more tracked prompts than one bounded poll batch', async t => {
  const f = await harness({ pollIntervalMs: 1, maxPollAttempts: 3 }); t.after(() => f.close())
  const submitted = []
  for (let index = 0; index < 26; index++) submitted.push(await f.manager.submit({ workflow: graph(), label: `Run ${index}`, previewOnly: false }))
  for (const item of f.state.queue) item.status = 'running'
  await f.manager.start()
  await until(async () => (await f.manager.list()).runs.length === 26 && (await f.manager.list()).runs.every(run => run.status === 'running'), 'rotated running prompts')
  assert.equal(f.calls.submitted.length, 26)
  assert.ok(f.calls.fetch.filter(call => call.url.endsWith('/queue')).length >= 2)
  assert.equal(new Set(submitted.map(item => item.runId)).size, 26)
})

test('a pre-POST receipt left by a restart becomes unknown and is never re-submitted', async t => {
  const f = await harness(); t.after(() => f.close())
  const workflow = graph()
  const requestId = 'restart-receipt-request-0001'
  await f.manager.beforeSubmit({ requestId, workflow, fingerprint: fingerprint(workflow), endpoint: f.state.endpoint,
    clientId: 'restart-client', context: JSON.stringify(['session-one', '/synthetic/project-one', 'timeline-one']), assessment: { risk: 'local' } })
  f.manager.dispose()
  let submitCalls = 0
  const restored = createGenerationRuns({
    storageDir: f.storageDir,
    getEndpoint: async () => f.state.endpoint,
    getContext: async () => ({ ...f.state.context }),
    submitManaged: async () => { submitCalls++; throw new Error('must not resubmit') },
    fetchImpl: async () => response({ queue_running: [], queue_pending: [] }),
  })
  t.after(() => restored.dispose())
  await restored.start()
  const listed = await restored.list()
  assert.equal(listed.runs.length, 1)
  assert.equal(listed.runs[0].status, 'unknown')
  assert.equal(submitCalls, 0)
})

test('retention prunes only old terminal records and refuses to evict active receipts', async t => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-generation-runs-capacity-'))
  t.after(() => fs.rm(storageDir, { recursive: true, force: true }))
  const context = { session: 'session-one', projectKey: '/synthetic/project-one', timelineId: 'timeline-one' }
  const writeLedger = async runs => fs.writeFile(path.join(storageDir, FILE_NAME), JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), runs }))
  const makeManager = () => createGenerationRuns({ storageDir, getEndpoint: async () => 'http://127.0.0.1:8188', getContext: async () => context })
  const workflow = graph()
  const detail = { requestId: 'capacity-request-new-0001', workflow, fingerprint: fingerprint(workflow), endpoint: 'http://127.0.0.1:8188',
    clientId: 'capacity-client', context: JSON.stringify(['session-one', '/synthetic/project-one', 'timeline-one']), assessment: { risk: 'local' } }

  await writeLedger(Array.from({ length: 400 }, (_, index) => storedLedgerRun(index, index === 0 ? 'done' : 'queued')))
  const prunable = makeManager(); t.after(() => prunable.dispose())
  await prunable.beforeSubmit(detail)
  const pruned = await prunable.list()
  assert.equal(pruned.runs.length, 400)
  assert.ok(!pruned.runs.some(run => run.id === 'stored-run-0000'))
  assert.ok(pruned.runs.some(run => run.id === 'stored-run-0001'))

  await writeLedger(Array.from({ length: 400 }, (_, index) => storedLedgerRun(index, 'queued')))
  const full = makeManager(); t.after(() => full.dispose())
  await assert.rejects(full.beforeSubmit({ ...detail, requestId: 'capacity-request-new-0002' }), error => error?.code === 'GENERATION_RUNS_CAPACITY')
  const after = JSON.parse(await fs.readFile(path.join(storageDir, FILE_NAME), 'utf8'))
  assert.equal(after.runs.length, 400)
  assert.ok(after.runs.every(run => run.status === 'queued'))
})

test('MP4 outputs under images are videos, including after ledger reload', async t => {
  const f = await harness(); t.after(() => f.close())
  await f.manager.submit({ workflow: graph(), previewOnly: false })
  f.state.queue = []
  f.state.histories.set('prompt-1', { 'prompt-1': { status: { status_str: 'success' }, outputs: {
    '75': { images: [{ filename: 'LTX_2.3_i2v_00001_.mp4', subfolder: 'video', type: 'output' }], animated: [true] },
    '108': { images: [{ filename: 'city_drone_wan22_00001_.MP4', subfolder: 'video', type: 'output' }] },
  } } })
  await f.manager.start()
  await until(async () => (await f.manager.list()).runs[0].status === 'done', 'completed video history')
  const run = (await f.manager.list()).runs[0]
  assert.deepEqual(run.outputs.map(output => output.mediaType), ['video', 'video'])
  f.manager.dispose()
  const ledgerPath = path.join(f.storageDir, FILE_NAME)
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
  for (const output of ledger.runs[0].outputs) output.mediaType = 'image'
  await fs.writeFile(ledgerPath, JSON.stringify(ledger))
  const restored = await harness({ storageDir: f.storageDir }); t.after(() => restored.close())
  assert.deepEqual((await restored.manager.list()).runs[0].outputs.map(output => output.mediaType), ['video', 'video'])
})

test('completed history keeps only safe persistent outputs and does not claim malformed reported paths were imported', async t => {
  const f = await harness(); t.after(() => f.close())
  const submitted = await f.manager.submit({ workflow: graph(), previewOnly: false })
  f.state.queue = []
  f.state.histories.set('prompt-1', {
    'prompt-1': { status: { status_str: 'success' }, outputs: {
      '2': { images: [
        { filename: 'result.png', subfolder: 'runs', type: 'output' },
        { filename: '../../outside.png', subfolder: 'runs', type: 'output' },
        { filename: 'bad-subfolder.png', subfolder: '../outside', type: 'output' },
        { filename: 'windows-drive.png', subfolder: 'C:outside', type: 'output' },
        { filename: 'x'.repeat(1025), subfolder: 'runs', type: 'output' },
        { filename: 'too-wide-subfolder.png', subfolder: 'x'.repeat(1025), type: 'output' },
        { filename: 'preview-only.png', subfolder: '', type: 'temp' },
      ], audio: [{ filename: 'song.flac', subfolder: '', type: 'output' }],
      files: [{ filename: 'metadata.json', subfolder: '', type: 'output' }] },
    } },
  })
  await f.manager.start()
  await until(async () => (await f.manager.list()).runs[0].status === 'done', 'completed history')
  let run = (await f.manager.list()).runs[0]
  assert.deepEqual(run.outputs.map(item => item.mediaType).sort(), ['audio', 'image'])
  // Temporary previews and unsupported generic files are intentionally
  // ignored. The five malformed persistent image paths remain counted as
  // unrepresented work, so this run cannot falsely become fully imported.
  assert.equal(run.outputCount, 7)
  assert.equal(run.outputsTruncated, true)
  assert.ok(run.outputs.every(item => !item.filename.includes('/') && !item.subfolder.includes('..')))
  const preview = await f.manager.control({ runId: submitted.runId, operation: 'mark-imported', resultAssetIds: ['asset-result'] })
  assert.equal(preview.previewOnly, true)
  assert.equal(preview.partial, true)
  assert.deepEqual((await f.manager.list()).runs[0].resultAssetIds, [])
  const applied = await f.manager.control({ runId: submitted.runId, operation: 'mark-imported', resultAssetIds: ['asset-result'], previewOnly: false })
  assert.equal(applied.success, true)
  run = (await f.manager.list()).runs[0]
  assert.deepEqual(run.resultAssetIds, ['asset-result'])
  assert.equal(run.importState, 'partial')
  const retried = await f.manager.control({ runId: submitted.runId, operation: 'mark-imported', resultAssetIds: ['asset-audio'], previewOnly: false })
  assert.equal(retried.success, true)
  run = (await f.manager.list()).runs[0]
  assert.deepEqual(run.resultAssetIds, ['asset-result', 'asset-audio'])
  assert.equal(run.importState, 'partial')
  assert.match(run.importWarning, /Only 2 of 7 reported outputs/)
})

test('import acknowledgement unions retry receipts and completes a fully represented run', async t => {
  const f = await harness(); t.after(() => f.close())
  const submitted = await f.manager.submit({ workflow: graph(), previewOnly: false })
  f.state.queue = []
  f.state.histories.set('prompt-1', {
    'prompt-1': { status: { status_str: 'success' }, outputs: {
      '2': { images: [{ filename: 'frame.png', subfolder: 'run', type: 'output' }],
        audio: [{ filename: 'voice.flac', subfolder: 'run', type: 'output' }] },
    } },
  })
  await f.manager.start()
  await until(async () => (await f.manager.list()).runs[0].status === 'done', 'completed history')
  const first = await f.manager.control({ runId: submitted.runId, operation: 'mark-imported', resultAssetIds: ['asset-frame'], previewOnly: false })
  assert.equal(first.success, true)
  assert.equal(first.partial, true)
  const failed = await f.manager.control({ runId: submitted.runId, operation: 'mark-import-failed', error: 'Temporary importer failure', previewOnly: false })
  assert.equal(failed.success, true)
  assert.match(failed.run.error, /Temporary importer failure/)
  const retry = await f.manager.control({ runId: submitted.runId, operation: 'mark-imported', resultAssetIds: ['asset-audio'], previewOnly: false })
  assert.equal(retry.success, true)
  assert.equal(retry.partial, false)
  const run = (await f.manager.list()).runs[0]
  assert.deepEqual(run.resultAssetIds, ['asset-frame', 'asset-audio'])
  assert.equal(run.importState, 'imported')
  assert.equal(run.error, null)
})

test('output tracking retains at most 512 descriptors and never finalizes a truncated receipt', async t => {
  const f = await harness(); t.after(() => f.close())
  const submitted = await f.manager.submit({ workflow: graph(), previewOnly: false })
  const images = Array.from({ length: LIMITS.outputItems + 1 }, (_, index) => ({
    filename: `frame-${String(index).padStart(4, '0')}.png`, subfolder: 'large-run', type: 'output',
  }))
  f.state.queue = []
  f.state.histories.set('prompt-1', { 'prompt-1': { status: { status_str: 'success' }, outputs: { '2': { images } } } })
  await f.manager.start()
  await until(async () => (await f.manager.list()).runs[0].status === 'done', 'large completed history')
  let run = (await f.manager.list()).runs[0]
  assert.equal(run.outputs.length, LIMITS.outputItems)
  assert.equal(run.outputCount, LIMITS.outputItems + 1)
  assert.equal(run.outputsTruncated, true)
  const allRepresented = Array.from({ length: LIMITS.outputItems }, (_, index) => `asset-${index}`)
  const acknowledgement = await f.manager.control({ runId: submitted.runId, operation: 'mark-imported', resultAssetIds: allRepresented, previewOnly: false })
  assert.equal(acknowledgement.success, true)
  assert.equal(acknowledgement.partial, true)
  run = (await f.manager.list()).runs[0]
  assert.equal(run.resultAssetIds.length, LIMITS.outputItems)
  assert.equal(run.importState, 'partial')
  assert.match(run.importWarning, /Only 512 of 513 reported outputs/)
})

test('restored ledgers revalidate persisted output descriptors before exposing them', async t => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-generation-runs-restored-output-'))
  const stored = storedLedgerRun(1, 'done')
  stored.outputs = [
    { filename: 'safe.png', subfolder: 'run', type: 'output', nodeId: '2', mediaType: 'image' },
    { filename: 'drive.png', subfolder: 'C:outside', type: 'output', nodeId: '2', mediaType: 'image' },
    { filename: 'preview.png', subfolder: '', type: 'temp', nodeId: '3', mediaType: 'image' },
  ]
  stored.outputCount = 2
  stored.outputsTruncated = false
  await fs.writeFile(path.join(storageDir, FILE_NAME), JSON.stringify({ version: 1, updatedAt: '2026-01-01T00:00:00.000Z', runs: [stored] }))
  const f = await harness({ storageDir })
  t.after(async () => { await f.close(); await fs.rm(storageDir, { recursive: true, force: true }) })
  const run = (await f.manager.list()).runs[0]
  assert.deepEqual(run.outputs.map(output => output.filename), ['safe.png'])
  assert.equal(run.outputCount, 2)
  assert.equal(run.outputsTruncated, true)
  assert.match(run.importWarning, /Only 1 of 2 reported outputs/)
})
