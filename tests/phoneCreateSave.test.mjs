import test from 'node:test'
import assert from 'node:assert/strict'
import { phoneJobsToSave, createPhoneCreateSaver } from '../src/services/phoneCreateSave.mjs'
import { unfinishedCreateJobs, RESULT_KEPT_MS } from '../src/services/createFlow.mjs'

const now = 1_800_000_000_000
const job = (jobId, extra = {}) => ({ jobId, create: true, fromPhone: true, kind: 'image', status: 'COMPLETED', canRefresh: true, needsReconnect: false, createdAt: now - 60000, ...extra })

test('only finished, unsaved phone pictures and clips of the last day are saved, oldest first', () => {
  const listed = [job('newer', { createdAt: now - 1000 }), job('older', { createdAt: now - 5000, kind: 'video' }),
    job('desktop', { fromPhone: undefined }), job('running', { status: 'IN_PROGRESS' }), job('saved', { importedAssetId: 'asset-1' }),
    job('sound', { kind: 'sound' }), job('stale', { createdAt: now - RESULT_KEPT_MS - 1 }), job('other-key', { needsReconnect: true }), null, {}]
  assert.deepEqual(phoneJobsToSave(listed, now).map(item => item.jobId), ['older', 'newer'])
  assert.deepEqual(phoneJobsToSave(null, now), [])
})

test('the Create tab leaves phone requests to their own watcher, so no result is collected twice', () => {
  const listed = [job('phone'), job('desktop', { fromPhone: undefined }), job('phone-running', { status: 'IN_PROGRESS' })]
  assert.deepEqual(unfinishedCreateJobs(listed, now).map(item => item.jobId), ['desktop'])
  assert.deepEqual(phoneJobsToSave(listed, now).map(item => item.jobId), ['phone'])
})

test('each result is saved once; a failure is retried a few times, spaced out, then left alone', async () => {
  let clock = now, jobs = [job('a'), job('b')]
  const calls = [], outcome = { a: true, b: false }
  const run = createPhoneCreateSaver({ now: () => clock, getApi: () => ({ list: async () => ({ success: true, jobs }) }),
    importJob: async jobId => { calls.push(jobId); if (outcome[jobId]) jobs = jobs.map(item => item.jobId === jobId ? { ...item, importedAssetId: 'asset' } : item); return { success: outcome[jobId] } } })
  await run()
  assert.deepEqual(calls, ['a', 'b'])
  await run(); await run()
  assert.deepEqual(calls, ['a', 'b'], 'a saved result is not fetched again, and a failed one waits before its next try')
  clock += 60000; await run()
  clock += 60000; await run()
  clock += 60000; await run()
  assert.deepEqual(calls, ['a', 'b', 'b', 'b'], 'three tries in all')
  outcome.b = true; clock += 600000; await run()
  assert.equal(calls.length, 4, 'after that it is left for the Create tab or the person')
})

test('overlapping runs do not save the same result twice, and a broken list or import never throws', async () => {
  let release, jobs = [job('slow')]
  const calls = [], gate = new Promise(resolve => { release = resolve })
  const run = createPhoneCreateSaver({ now: () => now, getApi: () => ({ list: async () => ({ success: true, jobs }) }),
    importJob: async jobId => { calls.push(jobId); await gate; jobs = [job('slow', { importedAssetId: 'asset' })]; return { success: true } } })
  const first = run(); const second = run(); const third = run()
  release(); await Promise.all([first, second, third])
  assert.deepEqual(calls, ['slow'])
  await createPhoneCreateSaver({ getApi: () => null, importJob: async () => ({ success: true }) })()
  await createPhoneCreateSaver({ getApi: () => ({ list: async () => { throw new Error('gone') } }), importJob: async () => ({ success: true }) })()
  await createPhoneCreateSaver({ getApi: () => ({ list: async () => ({ success: false }) }), importJob: async () => ({ success: true }) })()
  const thrown = []
  await createPhoneCreateSaver({ now: () => now, getApi: () => ({ list: async () => ({ success: true, jobs: [job('x')] }) }), importJob: async id => { thrown.push(id); throw new Error('no') } })()
  assert.deepEqual(thrown, ['x'])
})

test('an unfinished phone request is followed from the computer and saved when it finishes, without the phone', async () => {
  const { phoneJobsToFollow } = await import('../src/services/phoneCreateSave.mjs')
  let jobs = [job('waiting', { status: 'IN_PROGRESS' }), job('desktop-running', { status: 'IN_PROGRESS', fromPhone: undefined }), job('other-key', { status: 'IN_QUEUE', needsReconnect: true })]
  assert.deepEqual(phoneJobsToFollow(jobs, now).map(item => item.jobId), ['waiting'])
  const refreshed = [], saved = []
  let finishOnRefresh = 3
  const run = createPhoneCreateSaver({ now: () => now, getApi: () => ({ list: async () => ({ success: true, jobs }),
    refresh: async ({ jobId }) => { refreshed.push(jobId); if (--finishOnRefresh === 0) jobs = jobs.map(item => item.jobId === jobId ? { ...item, status: 'COMPLETED' } : item); return { success: true } } }),
    importJob: async jobId => { saved.push(jobId); jobs = jobs.map(item => item.jobId === jobId ? { ...item, importedAssetId: 'asset' } : item); return { success: true } } })
  assert.equal(await run(), 1, 'still being made: look again soon')
  assert.equal(await run(), 1)
  assert.deepEqual(saved, [])
  assert.equal(await run(), 0, 'finished and saved in the same pass')
  assert.deepEqual(refreshed, ['waiting', 'waiting', 'waiting'], 'only the phone request is asked about')
  assert.deepEqual(saved, ['waiting'])
  assert.equal(await run(), 0); assert.equal(refreshed.length, 3, 'nothing is asked once it is finished')
  // A request Comfy asked us to wait on is not asked about early, and a failing ask never throws.
  jobs = [job('patient', { status: 'IN_QUEUE', retryAfterMs: 3000 })]
  assert.equal(await run(), 1); assert.equal(refreshed.length, 3)
  jobs = [job('broken', { status: 'IN_QUEUE' })]
  const failing = createPhoneCreateSaver({ now: () => now, getApi: () => ({ list: async () => ({ success: true, jobs }), refresh: async () => { throw new Error('offline') } }), importJob: async () => ({ success: true }) })
  assert.equal(await failing(), 1)
})
