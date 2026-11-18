import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgentLmStudioSetupTracker, parseAgentLmStudioSetup, lmStudioSetupPresentation, formatModelBytes } from '../src/utils/agentLmStudioSetup.mjs'

const job = (patch = {}) => ({ jobId: 'model-1', turnId: 'turn-1', modelName: 'Synthetic model', state: 'downloading', bytesReceived: 10, totalBytes: 100, ...patch })
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const flush = () => new Promise(resolve => setImmediate(resolve))
function fixture(overrides = {}) {
  const calls = [], timers = new Map(), changed = new Set()
  let jobs = [job()], sequence = 0
  const api = {
    agentDownloads: async scope => { calls.push(['list', scope]); return { success: true, jobs } },
    onChanged: listener => { changed.add(listener); return () => changed.delete(listener) },
    cancel: async args => { calls.push(['cancel', args]); jobs = jobs.map(item => ({ ...item, state: 'cancelled' })); return { success: true, jobId: args.jobId } },
    load: async args => { calls.push(['load', args]); return { success: true, jobId: args.jobId } },
    ...overrides,
  }
  const tracker = createAgentLmStudioSetupTracker({ api, projectPath: '/fixture/project', chatId: 'chat-1',
    setTimer: (callback, ms) => { const id = ++sequence; timers.set(id, { callback, ms }); return id }, clearTimer: id => timers.delete(id) })
  return { api, tracker, calls, timers, changed, setJobs: value => { jobs = value },
    invalidate: () => { for (const listener of changed) listener() },
    tick: () => { const next = timers.entries().next().value; assert.ok(next); timers.delete(next[0]); next[1].callback() } }
}

test('strict bounded parsing never treats invalid jobs as a successful empty list', () => {
  for (const result of [null, { success: false }, { success: true }, { success: true, jobs: {} },
    { success: true, jobs: [job(), job()] }, { success: true, jobs: [job({ jobId: '../foreign' })] },
    { success: true, jobs: [job({ turnId: '' })] }, { success: true, jobs: [job({ state: 'installed' })] },
    { success: true, jobs: Array.from({ length: 33 }, (_, n) => job({ jobId: `model-${n}` })) }]) assert.throws(() => parseAgentLmStudioSetup(result))
  assert.deepEqual(parseAgentLmStudioSetup({ success: true, jobs: [] }), [])
  const parsed = parseAgentLmStudioSetup({ success: true, jobs: [job({ modelName: 'x'.repeat(400), bytesReceived: -1,
    totalBytes: Infinity, canLoad: true, path: '/private/path', downloadUrl: 'https://example.invalid', error: { message: 'y'.repeat(900) } })] })[0]
  assert.equal(parsed.modelName.length, 200); assert.equal(parsed.bytesReceived, null); assert.equal(parsed.totalBytes, null)
  assert.equal(parsed.canLoad, false); assert.equal(parsed.error.length, 700); assert.equal(parsed.path, undefined); assert.equal(parsed.downloadUrl, undefined)
})

test('transfer completion, unknown size, model loading and connection remain distinct', () => {
  assert.equal(formatModelBytes(1024 ** 2), '1 MiB'); assert.equal(formatModelBytes(1024 ** 3), '1 GiB')
  assert.equal(lmStudioSetupPresentation(job({ bytesReceived: 999 })).percent, 100)
  assert.equal(lmStudioSetupPresentation(job({ bytesReceived: 100 })).label, 'Finishing model download…')
  assert.equal(lmStudioSetupPresentation(job({ totalBytes: 0 })).percent, null)
  assert.equal(lmStudioSetupPresentation(job({ state: 'completed' })).label, 'Model downloaded — not loaded')
  assert.equal(lmStudioSetupPresentation(job({ state: 'completed', error: 'Load result unknown' })).label, 'Model downloaded — load not verified')
  assert.match(lmStudioSetupPresentation(job({ state: 'loading' })).label, /Loading model/)
  assert.match(lmStudioSetupPresentation(job({ state: 'ready', connectionVerified: true })).label, /local server available/)
  assert.equal(lmStudioSetupPresentation(job({ state: 'ready' })).label, 'Model status needs verification')
})

test('optional context metadata is bounded and never inferred for older receipts', () => {
  const parse = patch => parseAgentLmStudioSetup({ success: true, jobs: [job(patch)] })[0]
  const keys = ['contextTargetTokens', 'requestedContextTokens', 'modelMaxContextTokens', 'effectiveContextTokens']
  const older = parse({ state: 'ready', connectionVerified: true })
  for (const key of keys) assert.equal(older[key], null)
  assert.equal(older.contextVerified, false); assert.equal(lmStudioSetupPresentation(older).contextHint, '')
  for (const value of [null, undefined, 0, -1, 0.5, '32768', true, Infinity, NaN, 1048577, Number.MAX_SAFE_INTEGER]) {
    const item = parse({ state: 'ready', connectionVerified: true, contextVerified: true, ...Object.fromEntries(keys.map(key => [key, value])) })
    for (const key of keys) assert.equal(item[key], null)
    assert.equal(item.contextVerified, false); assert.equal(lmStudioSetupPresentation(item).contextHint, '')
  }
  const bounded = parse({ ...Object.fromEntries(keys.map(key => [key, 1048576])) })
  for (const key of keys) assert.equal(bounded[key], 1048576)
  assert.equal(bounded.contextVerified, false)
})

test('load target is distinct from verified effective context and never becomes an editable choice', () => {
  const parse = patch => parseAgentLmStudioSetup({ success: true, jobs: [job(patch)] })[0]
  const fields = { contextTargetTokens: 32768, requestedContextTokens: 8192, modelMaxContextTokens: 8192, effectiveContextTokens: 8192 }
  const completed = parse({ ...fields, state: 'completed', canLoad: true })
  assert.equal(lmStudioSetupPresentation(completed).contextHint, 'Load target: up to 32,768 tokens, limited by the model. Larger context uses more RAM.')
  assert.equal(lmStudioSetupPresentation(parse({ state: 'completed', canLoad: true })).contextHint, '')
  assert.equal(lmStudioSetupPresentation(parse({ ...fields, state: 'completed', canLoad: false, error: 'Load not verified' })).contextHint, '')
  for (const patch of [{ state: 'loading' }, { state: 'ready' }, { state: 'ready', connectionVerified: true },
    { state: 'ready', connectionVerified: false, contextVerified: true },
    { state: 'ready', connectionVerified: true, contextVerified: 'true' }]) {
    const item = parse({ ...fields, ...patch })
    assert.equal(item.contextVerified, false); assert.equal(lmStudioSetupPresentation(item).contextHint, '')
  }
  const ready = parse({ ...fields, state: 'ready', connectionVerified: true, contextVerified: true })
  assert.equal(ready.contextVerified, true)
  assert.equal(lmStudioSetupPresentation(ready).contextHint, 'Verified context: 8,192 tokens.')
  // An existing verified instance may use a different context; do not turn the
  // managed-load target into an invented effective value or a reload request.
  assert.equal(lmStudioSetupPresentation(parse({ ...ready, requestedContextTokens: 32768, modelMaxContextTokens: 131072,
    effectiveContextTokens: 65536 })).contextHint, 'Verified context: 65,536 tokens.')
  for (const patch of [{ contextTargetTokens: null }, { requestedContextTokens: null }, { modelMaxContextTokens: null },
    { effectiveContextTokens: null }, { requestedContextTokens: 4096 }, { effectiveContextTokens: 4096 },
    { effectiveContextTokens: 16384 }, { modelMaxContextTokens: 4096 }]) {
    const item = parse({ ...ready, ...patch })
    assert.equal(item.contextVerified, false); assert.equal(lmStudioSetupPresentation(item).contextHint, '')
  }
})

test('mount is passive and scoped, polling downloading and loading but not terminal states', async () => {
  const f = fixture(); assert.deepEqual(f.calls, []); f.tracker.start(); await flush()
  assert.deepEqual(f.calls, [['list', { projectPath: '/fixture/project', chatId: 'chat-1' }]])
  assert.equal([...f.timers.values()][0].ms, 1000)
  f.setJobs([job({ state: 'loading' })]); f.tick(); await flush(); assert.equal(f.timers.size, 1)
  for (const state of ['completed', 'ready', 'failed', 'cancelled']) {
    f.setJobs([job({ state })]); await f.tracker.refresh(); assert.equal(f.timers.size, 0)
  }
  assert.equal(f.calls.some(([method]) => method === 'load' || method === 'cancel'), false); f.tracker.dispose()
})

test('empty cache waits for native invalidation and can recover later jobs without inference', async () => {
  const f = fixture(); f.setJobs([]); f.tracker.start(); await flush(); assert.equal(f.timers.size, 0)
  f.setJobs([job()]); f.invalidate(); await flush(); assert.equal(f.tracker.getSnapshot().hasTrackedJobs, true)
  assert.equal(f.timers.size, 1); f.tracker.dispose()
})

test('held reads coalesce with no overlap even through StrictMode dispose/start', async () => {
  const held = deferred(); let reads = 0, concurrent = 0, maximum = 0
  const f = fixture({ agentDownloads: async () => {
    reads++; concurrent++; maximum = Math.max(maximum, concurrent)
    const result = reads === 1 ? await held.promise : { success: true, jobs: [job({ bytesReceived: 80 })] }
    concurrent--; return result
  } })
  f.tracker.start(); await flush(); f.invalidate(); f.invalidate(); f.tracker.dispose(); f.tracker.start()
  assert.equal(reads, 1); held.resolve({ success: true, jobs: [job({ bytesReceived: 1 })] }); await flush()
  assert.equal(reads, 2); assert.equal(maximum, 1); assert.equal(f.tracker.getSnapshot().items[0].bytesReceived, 80)
  assert.equal(f.changed.size, 1); f.tracker.dispose(); assert.equal(f.changed.size, 0)
})

test('poll failures preserve last known loading state and recover without false completion', async () => {
  const f = fixture(); f.setJobs([job({ state: 'loading' })]); f.tracker.start(); await flush()
  f.api.agentDownloads = async () => ({ success: false, error: { message: 'Temporarily unavailable' } }); f.tick(); await flush()
  assert.equal(f.tracker.getSnapshot().items[0].state, 'loading'); assert.equal(f.tracker.getSnapshot().error, 'Temporarily unavailable')
  assert.equal(f.timers.size, 1)
  f.api.agentDownloads = async () => ({ success: true, jobs: [job({ state: 'ready' })] }); f.tick(); await flush()
  assert.equal(f.tracker.getSnapshot().error, ''); assert.equal(f.timers.size, 0); f.tracker.dispose()
})

test('initial read error supports explicit refresh; missing bridge or scope stays silent', async () => {
  const f = fixture({ agentDownloads: async () => { throw Error('Unavailable') } }); f.tracker.start(); await flush()
  assert.equal(f.tracker.getSnapshot().error, 'Unavailable'); assert.equal(f.timers.size, 0)
  f.api.agentDownloads = async () => ({ success: true, jobs: [] }); await f.tracker.refresh(); assert.equal(f.tracker.getSnapshot().error, ''); f.tracker.dispose()
  for (const options of [{}, { api: {}, projectPath: '/project', chatId: 'chat' }, { api: { agentDownloads: () => assert.fail() } }]) {
    const tracker = createAgentLmStudioSetupTracker(options); tracker.start(); await tracker.refresh()
    assert.equal(tracker.getSnapshot().error, ''); assert.deepEqual(tracker.getSnapshot().items, []); tracker.dispose()
  }
})

test('unmount ignores delayed list results, clears polls and never cancels the native job', async () => {
  const held = deferred(), f = fixture({ agentDownloads: () => held.promise }); let updates = 0
  f.tracker.subscribe(() => updates++); f.tracker.start(); await flush(); f.tracker.dispose()
  held.resolve({ success: true, jobs: [job()] }); await flush()
  assert.equal(updates, 0); assert.equal(f.changed.size, 0); assert.equal(f.timers.size, 0); assert.deepEqual(f.calls, [])
})

test('cancel only affects an explicitly selected downloading job, never loading', async () => {
  const f = fixture(); f.tracker.start(); await flush(); await f.tracker.cancel('other')
  assert.equal(f.calls.length, 1); await f.tracker.cancel('model-1')
  assert.equal(f.tracker.getSnapshot().items[0].state, 'cancelled'); assert.equal(f.timers.size, 0)
  f.setJobs([job({ state: 'loading' })]); await f.tracker.refresh(); await f.tracker.cancel('model-1')
  assert.equal(f.calls.filter(([method]) => method === 'cancel').length, 1); f.tracker.dispose()
})

test('load requires completed canLoad and successful receipt alone never claims ready', async () => {
  const f = fixture(); f.tracker.start(); await flush(); await f.tracker.load('model-1')
  f.setJobs([job({ state: 'completed', canLoad: false })]); await f.tracker.refresh(); await f.tracker.load('model-1')
  assert.equal(f.calls.some(([method]) => method === 'load'), false)
  f.setJobs([job({ state: 'completed', canLoad: true })]); await f.tracker.refresh(); await f.tracker.load('model-1')
  assert.deepEqual(f.calls.find(([method]) => method === 'load'), ['load', { jobId: 'model-1' }])
  assert.equal(f.tracker.getSnapshot().items[0].state, 'completed'); f.tracker.dispose()
})

test('load confirmation blocks duplicate clicks and unknown/no-match failures remain explicit', async () => {
  for (const code of ['LOAD_UNKNOWN', 'MODEL_NOT_FOUND', 'DECLINED']) {
    const held = deferred(); let loads = 0
    const f = fixture({ load: async () => { loads++; return held.promise } })
    f.setJobs([job({ state: 'completed', canLoad: true })]); f.tracker.start(); await flush()
    const first = f.tracker.load('model-1'); await f.tracker.load('model-1'); assert.equal(loads, 1)
    assert.equal(f.tracker.getSnapshot().pendingById['model-1'], 'load')
    held.resolve({ success: false, code, error: { message: `Synthetic ${code}` } }); await first
    assert.equal(f.tracker.getSnapshot().actionErrors['model-1'], `Synthetic ${code}`)
    assert.equal(f.tracker.getSnapshot().items[0].state, 'completed'); assert.deepEqual(f.tracker.getSnapshot().pendingById, {})
    f.tracker.dispose()
  }
})

test('wrong-job response and missing load bridge never promote or change selected identity', async () => {
  for (const load of [undefined, async () => ({ success: true, jobId: 'foreign' })]) {
    const f = fixture({ load }); f.setJobs([job({ state: 'completed', canLoad: true })]); f.tracker.start(); await flush(); await f.tracker.load('model-1')
    assert.ok(f.tracker.getSnapshot().actionErrors['model-1']); assert.equal(f.tracker.getSnapshot().items[0].jobId, 'model-1')
    assert.equal(f.tracker.getSnapshot().items[0].state, 'completed'); f.tracker.dispose()
  }
})

test('late action after scope unmount cannot update or refresh old-scope state', async () => {
  const held = deferred(), f = fixture({ load: () => held.promise }); f.setJobs([job({ state: 'completed', canLoad: true })])
  f.tracker.start(); await flush(); const action = f.tracker.load('model-1'); const reads = f.calls.length
  f.tracker.dispose(); held.resolve({ success: true, jobId: 'model-1' }); await action
  assert.equal(f.calls.length, reads); assert.deepEqual(f.tracker.getSnapshot().pendingById, {})
})

test('scope replacement keeps old late jobs separate and reattaches through a fresh cached read', async () => {
  const held = deferred(), first = fixture({ agentDownloads: () => held.promise }), second = fixture()
  first.tracker.start(); await flush(); first.tracker.dispose(); second.setJobs([job({ jobId: 'new-job', turnId: 'new-turn' })]); second.tracker.start(); await flush()
  held.resolve({ success: true, jobs: [job()] }); await flush()
  assert.deepEqual(first.tracker.getSnapshot().items, []); assert.equal(second.tracker.getSnapshot().items[0].jobId, 'new-job'); second.tracker.dispose()
})
