import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgentSetupDownloadsTracker, formatInstallerBytes, installerDownloadPresentation, parseAgentSetupDownloads } from '../src/utils/agentSetupDownloads.mjs'

const job = (patch = {}) => ({ jobId: 'job-1', turnId: 'turn-1', integration: 'comfyui', state: 'downloading', bytesReceived: 10, totalBytes: 100, canOpen: false, ...patch })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = () => new Promise(resolve => setImmediate(resolve))
function fixture(overrides = {}) {
  const calls = [], timers = new Map(), changed = new Set()
  let jobs = [job()], timerId = 0
  const api = {
    agentDownloads: async scope => { calls.push(['list', scope]); return { success: true, jobs } },
    onChanged: callback => { calls.push(['subscribe']); changed.add(callback); return () => { changed.delete(callback); calls.push(['unsubscribe']) } },
    cancel: async args => { calls.push(['cancel', args]); jobs = jobs.map(item => item.jobId === args.jobId ? { ...item, state: 'cancelled' } : item); return { success: true, jobId: args.jobId } },
    open: async args => { calls.push(['open', args]); jobs = jobs.map(item => item.jobId === args.jobId ? { ...item, opened: true } : item); return { success: true, jobId: args.jobId, opened: true, installed: false } },
    ...overrides,
  }
  const tracker = createAgentSetupDownloadsTracker({ api, projectPath: '/fixture/project', chatId: 'chat-1',
    setTimer: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id }, clearTimer: id => timers.delete(id) })
  return { api, tracker, calls, timers, changed, setJobs: value => { jobs = value },
    invalidate: () => { for (const callback of changed) callback() },
    tick: () => { const next = timers.entries().next().value; assert.ok(next, 'A local progress poll was scheduled'); timers.delete(next[0]); next[1].callback() } }
}

test('download parsing requires authoritative valid jobs and never turns malformed responses into an empty success', () => {
  for (const result of [undefined, { success: false }, { success: true }, { success: true, jobs: {} }, { success: true, jobs: [job({ turnId: undefined })] },
    { success: true, jobs: [job({ integration: 'other' })] }, { success: true, jobs: [job(), job()] },
    { success: true, jobs: [job({ jobId: '../../foreign-path' })] },
    { success: true, jobs: Array.from({ length: 33 }, (_, index) => job({ jobId: `job-${index}` })) }]) {
    assert.throws(() => parseAgentSetupDownloads(result))
  }
  assert.deepEqual(parseAgentSetupDownloads({ success: true, jobs: [] }), [])
  const parsed = parseAgentSetupDownloads({ success: true, jobs: [job({ bytesReceived: -1, totalBytes: Infinity, canOpen: true,
    error: { message: 'x'.repeat(800) }, warning: { message: 'Check storage.' } })] })[0]
  assert.equal(parsed.bytesReceived, null); assert.equal(parsed.totalBytes, null); assert.equal(parsed.canOpen, false)
  assert.equal(parsed.error.length, 700); assert.equal(parsed.warning, 'Check storage.')
})

test('progress is bounded, uses honest binary units, and full transfer remains verifying until completed', () => {
  assert.equal(formatInstallerBytes(1024 ** 2), '1 MiB')
  assert.equal(formatInstallerBytes(1024 ** 3), '1 GiB')
  assert.equal(formatInstallerBytes(0), '0 B'); assert.equal(formatInstallerBytes(null), 'Size unknown')
  assert.equal(installerDownloadPresentation(job({ bytesReceived: 99.9 })).percent, 99)
  const full = installerDownloadPresentation(job({ bytesReceived: 101 }))
  assert.equal(full.percent, 100); assert.equal(full.label, 'Verifying installer…')
  assert.equal(installerDownloadPresentation(job({ totalBytes: 0 })).percent, null)
  assert.equal(installerDownloadPresentation(job({ state: 'completed' })).label, 'Installer downloaded')
  assert.equal(installerDownloadPresentation(job({ state: 'completed', opened: true })).label, 'Installer opened')
})

test('construction is passive; mount queries scoped native cache and polls only downloading jobs every second', async () => {
  const f = fixture(); assert.deepEqual(f.calls, [])
  f.tracker.start(); await flush()
  assert.deepEqual(f.calls, [['subscribe'], ['list', { projectPath: '/fixture/project', chatId: 'chat-1' }]])
  assert.equal(f.tracker.getSnapshot().items[0].bytesReceived, 10)
  assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].ms, 1000)
  f.setJobs([job({ bytesReceived: 70 })]); f.tick(); await flush()
  assert.equal(f.tracker.getSnapshot().items[0].bytesReceived, 70)
  f.setJobs([job({ state: 'completed', bytesReceived: 100, canOpen: true })]); f.tick(); await flush()
  assert.equal(f.tracker.getSnapshot().items[0].canOpen, true); assert.equal(f.timers.size, 0)
  assert.equal(f.calls.some(([type]) => type === 'open'), false)
  f.tracker.dispose()
})

test('empty native cache has no polls; static invalidation discovers later agent jobs without a model call', async () => {
  const f = fixture(); f.setJobs([]); f.tracker.start(); await flush()
  assert.equal(f.timers.size, 0); assert.equal(f.tracker.getSnapshot().hasTrackedJobs, false)
  f.setJobs([job()]); f.invalidate(); await flush()
  assert.equal(f.tracker.getSnapshot().items.length, 1); assert.equal(f.tracker.getSnapshot().hasTrackedJobs, true)
  assert.equal(f.timers.size, 1); f.tracker.dispose()
})

test('list reads never overlap and bursts during a held read coalesce into one follow-up', async () => {
  const held = deferred(); let reads = 0, concurrent = 0, maximum = 0
  const f = fixture({ agentDownloads: async () => {
    concurrent++; maximum = Math.max(maximum, concurrent); reads++
    const response = reads === 1 ? await held.promise : { success: true, jobs: [job({ bytesReceived: 90 })] }
    concurrent--; return response
  } })
  f.tracker.start(); await flush()
  f.invalidate(); f.invalidate(); void f.tracker.refresh(); await flush()
  assert.equal(reads, 1); assert.equal(f.timers.size, 0)
  held.resolve({ success: true, jobs: [job()] }); await flush()
  assert.equal(reads, 2); assert.equal(maximum, 1); assert.equal(f.tracker.getSnapshot().items[0].bytesReceived, 90)
  f.tracker.dispose()
})

test('poll errors retain truthful last state, continue bounded recovery polls, and never manufacture completion', async () => {
  const f = fixture(); f.tracker.start(); await flush()
  f.api.agentDownloads = async () => ({ success: false, error: 'Temporary IPC failure' })
  f.tick(); await flush()
  assert.equal(f.tracker.getSnapshot().items[0].state, 'downloading')
  assert.equal(f.tracker.getSnapshot().error, 'Temporary IPC failure'); assert.equal(f.timers.size, 1)
  f.api.agentDownloads = async () => ({ success: true, jobs: [job({ state: 'failed', error: { message: 'Network stopped' } })] })
  f.tick(); await flush()
  assert.equal(f.tracker.getSnapshot().error, ''); assert.equal(f.tracker.getSnapshot().items[0].error, 'Network stopped')
  assert.equal(f.timers.size, 0); f.tracker.dispose()
})

test('initial read failures remain visible and explicit refresh can recover without download or login', async () => {
  const f = fixture({ agentDownloads: async () => { throw new Error('Unavailable') } })
  f.tracker.start(); await flush()
  assert.deepEqual(f.tracker.getSnapshot().items, []); assert.equal(f.tracker.getSnapshot().error, 'Unavailable')
  assert.equal(f.timers.size, 0)
  f.api.agentDownloads = async () => ({ success: true, jobs: [] })
  await f.tracker.refresh(); assert.equal(f.tracker.getSnapshot().error, '')
  f.tracker.dispose()
})

test('missing bridge or incomplete scope is silent and performs no work', async () => {
  for (const options of [{}, { api: {}, projectPath: '/project', chatId: 'chat' }, { api: { agentDownloads: () => assert.fail('No scope') } }]) {
    const tracker = createAgentSetupDownloadsTracker(options)
    tracker.start(); await tracker.refresh()
    assert.deepEqual(tracker.getSnapshot().items, []); assert.equal(tracker.getSnapshot().error, '')
    tracker.dispose()
  }
})

test('unmount unsubscribes, clears timers and ignores late native results without cancelling the job', async () => {
  const held = deferred(), f = fixture({ agentDownloads: async () => held.promise })
  const snapshots = []; f.tracker.subscribe(() => snapshots.push(f.tracker.getSnapshot()))
  f.tracker.start(); await flush(); f.tracker.dispose()
  held.resolve({ success: true, jobs: [job()] }); await flush()
  assert.equal(snapshots.length, 0); assert.equal(f.changed.size, 0); assert.equal(f.timers.size, 0)
  assert.equal(f.calls.some(([type]) => type === 'cancel'), false)
})

test('stop/start observer lifecycle ignores a stale read and reacquires native progress', async () => {
  const held = deferred(); let reads = 0
  const f = fixture({ agentDownloads: async () => ++reads === 1 ? held.promise : { success: true, jobs: [job({ bytesReceived: 80 })] } })
  f.tracker.start(); await flush(); f.tracker.dispose(); f.tracker.start()
  held.resolve({ success: true, jobs: [job({ bytesReceived: 1 })] }); await flush()
  assert.equal(reads, 2); assert.equal(f.tracker.getSnapshot().items[0].bytesReceived, 80)
  f.tracker.dispose()
})

test('different chat observers never receive late old-scope data', async () => {
  const held = deferred(), first = fixture({ agentDownloads: async () => held.promise }), second = fixture()
  first.tracker.start(); await flush(); first.tracker.dispose()
  second.setJobs([job({ jobId: 'other-job', turnId: 'other-turn' })]); second.tracker.start(); await flush()
  held.resolve({ success: true, jobs: [job()] }); await flush()
  assert.deepEqual(first.tracker.getSnapshot().items, []); assert.equal(second.tracker.getSnapshot().items[0].jobId, 'other-job')
  second.tracker.dispose()
})

test('cancel remains available independently of agent/export state and refreshes authoritative completion', async () => {
  const f = fixture(); f.tracker.start(); await flush()
  await f.tracker.cancel('job-1')
  assert.equal(f.calls.filter(([type]) => type === 'cancel').length, 1)
  assert.equal(f.tracker.getSnapshot().items[0].state, 'cancelled'); assert.equal(f.timers.size, 0)
  assert.deepEqual(f.tracker.getSnapshot().pendingById, {}); f.tracker.dispose()
})

test('only completed canOpen jobs can open and native opened never means installed', async () => {
  const f = fixture(); f.tracker.start(); await flush(); await f.tracker.open('job-1')
  assert.equal(f.calls.some(([type]) => type === 'open'), false)
  f.setJobs([job({ state: 'completed', canOpen: true, bytesReceived: 100 })]); await f.tracker.refresh()
  await f.tracker.open('job-1')
  assert.deepEqual(f.calls.find(([type]) => type === 'open'), ['open', { jobId: 'job-1' }])
  assert.equal(f.tracker.getSnapshot().items[0].opened, true)
  assert.equal(f.tracker.getSnapshot().items[0].installed, undefined); f.tracker.dispose()
})

test('duplicate clicks are locked per job and failed native approval never claims opened', async () => {
  const held = deferred(); let opens = 0
  const f = fixture({ open: async () => { opens++; return held.promise } })
  f.setJobs([job({ state: 'completed', canOpen: true })]); f.tracker.start(); await flush()
  const first = f.tracker.open('job-1'); await f.tracker.open('job-1')
  assert.equal(opens, 1); assert.equal(f.tracker.getSnapshot().pendingById['job-1'], 'open')
  held.resolve({ success: false, code: 'DECLINED', error: 'Opening was not approved.' }); await first
  assert.equal(f.tracker.getSnapshot().items[0].opened, false)
  assert.equal(f.tracker.getSnapshot().actionErrors['job-1'], 'Opening was not approved.')
  assert.deepEqual(f.tracker.getSnapshot().pendingById, {}); f.tracker.dispose()
})

test('late actions after unmount neither mutate view nor refresh the old scope', async () => {
  const held = deferred(), f = fixture({ cancel: async () => held.promise })
  f.tracker.start(); await flush()
  const action = f.tracker.cancel('job-1'), before = f.calls.length
  f.tracker.dispose(); held.resolve({ success: true, jobId: 'job-1', state: 'cancelled' }); await action
  assert.equal(f.calls.length, before + 1, 'Only unsubscribe was called')
  assert.equal(f.tracker.getSnapshot().items[0].state, 'downloading'); assert.deepEqual(f.tracker.getSnapshot().pendingById, {})
})

test('successful but unconfirmed or wrong-job opener replies remain errors and cannot change job identity', async () => {
  for (const reply of [{ success: true }, { success: true, opened: true, jobId: 'foreign-job' }]) {
    const f = fixture({ open: async () => reply }); f.setJobs([job({ state: 'completed', canOpen: true })])
    f.tracker.start(); await flush(); await f.tracker.open('job-1')
    assert.ok(f.tracker.getSnapshot().actionErrors['job-1']); assert.equal(f.tracker.getSnapshot().items[0].jobId, 'job-1')
    assert.equal(f.tracker.getSnapshot().items[0].opened, false); f.tracker.dispose()
  }
})
