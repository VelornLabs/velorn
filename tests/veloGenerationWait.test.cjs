'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { waitForGenerationRuns, tool } = require('../electron/veloGenerationWait.cjs')
const run = (id, status = 'running', importState = 'pending') => ({ id, status, importState, outputCount: status === 'done' ? 1 : 0,
  resultAssetIds: importState === 'imported' ? [`asset-${id}`] : [] })
const snapshot = runs => ({ success: true, runs })
test('ten independent clips finish over forty minutes with one native wait and no model calls', async () => {
  let tick = 0, time = 0, reads = 0
  const ids = Array.from({ length: 10 }, (_, n) => `clip-${n}`), progress = []
  const result = await waitForGenerationRuns({ runIds: ids }, {
    read: async () => { reads++; return snapshot(ids.map((id, n) => n < tick ? run(id, 'done', 'imported') : run(id))) },
    now: () => time, sleep: async () => { tick++; time += 240000 }, onProgress: text => progress.push(text) })
  assert.equal(time, 2400000); assert.equal(reads, 11); assert.equal(result.reason, 'batch_complete')
  assert.deepEqual(result.completedRunIds, ids); assert.deepEqual(result.pendingRunIds, [])
  assert.ok(progress.at(-1).includes('10/10')); assert.equal(result.runs.flatMap(r => r.resultAssetIds).length, 10)
})
test('one failed job wakes the assistant and leaves independent jobs pending', async () => {
  const runs = [run('done', 'done', 'imported'), { ...run('failed', 'error'), error: 'Fixture failure' }, run('still-running')]
  const result = await waitForGenerationRuns({ runIds: runs.map(r => r.id) }, { read: async () => snapshot(runs) })
  assert.equal(result.reason, 'attention_needed'); assert.deepEqual(result.pendingRunIds, ['still-running'])
  assert.deepEqual(result.attentionRunIds, ['failed']); assert.equal(runs[2].status, 'running')
})
test('dependent stage waits for prerequisite, then separate child; completed parent is never replayed', async () => {
  const runs = [run('parent')]; let ticks = 0
  const read = async () => snapshot(runs)
  const sleep = async () => { ticks++; runs[0] = run('parent', 'done', 'imported') }
  assert.equal((await waitForGenerationRuns({ runIds: ['parent'] }, { read, sleep })).reason, 'batch_complete')
  runs.push(run('child', 'done', 'imported'))
  assert.equal((await waitForGenerationRuns({ runIds: ['parent', 'child'] }, { read, sleep })).reason, 'batch_complete')
  assert.equal(ticks, 1); assert.equal(runs.length, 2)
})
test('any-completion returns only useful event and identifies unfinished jobs', async () => {
  const result = await waitForGenerationRuns({ runIds: ['a', 'b'], returnWhen: 'any' }, {
    read: async () => snapshot([run('a', 'done', 'imported'), run('b')]) })
  assert.equal(result.reason, 'completion'); assert.deepEqual(result.pendingRunIds, ['b'])
})
test('completion waits briefly for app import receipt, without importing or regenerating', async () => {
  let reads = 0
  const result = await waitForGenerationRuns({ runIds: ['a'] }, {
    read: async () => snapshot([run('a', 'done', ++reads > 2 ? 'imported' : 'pending')]), sleep: async () => {} })
  assert.equal(reads, 3); assert.deepEqual(result.runs[0].resultAssetIds, ['asset-a'])
})
test('failed/partial/unconfirmed import asks to recover existing output, not generation', async () => {
  for (const state of ['failed', 'partial', 'pending']) {
    const result = await waitForGenerationRuns({ runIds: ['a'] }, { read: async () => snapshot([run('a', 'done', state)]), importGraceMs: 0 })
    assert.equal(result.reason, 'attention_needed'); assert.match(result.runs[0].attention, /do not regenerate/i)
    assert.deepEqual(result.completedRunIds, ['a'])
  }
})
test('Stop aborts waiting, not any generation; returning to saved completed IDs is immediate', async () => {
  const controller = new AbortController(), job = run('a')
  const waiting = waitForGenerationRuns({ runIds: ['a'] }, { signal: controller.signal,
    read: async () => { queueMicrotask(() => controller.abort()); return snapshot([job]) } })
  await assert.rejects(waiting, /stopped|abort/i); assert.equal(job.status, 'running')
  job.status = 'done'; job.importState = 'imported'
  const result = await waitForGenerationRuns({ runIds: ['a'] }, { read: async () => snapshot([job]), sleep: async () => assert.fail('Completed job cannot wait') })
  assert.equal(result.reason, 'batch_complete')
})
test('a multi-day wait checkpoint returns pending IDs, without cancelling or replaying jobs', async () => {
  let time = 0
  const job = run('long')
  const result = await waitForGenerationRuns({ runIds: ['long'] }, { read: async () => snapshot([job]), now: () => time,
    sleep: async () => { time += 86400000 } })
  assert.equal(result.reason, 'monitor_checkpoint'); assert.deepEqual(result.pendingRunIds, ['long']); assert.equal(job.status, 'running')
})
test('cancelling an in-flight read returns immediately without waiting for a slow bridge', async () => {
  const controller = new AbortController()
  const waiting = waitForGenerationRuns({ runIds: ['a'] }, { signal: controller.signal,
    read: async () => { controller.abort(); return new Promise(() => {}) } })
  await assert.rejects(waiting, /stopped/)
})
test('unknown IDs and offline state are explicit; invalid arguments never inspect anything', async () => {
  const result = await waitForGenerationRuns({ runIds: ['missing'] }, { read: async () => snapshot([]) })
  assert.equal(result.reason, 'attention_needed'); assert.match(result.runs[0].attention, /do not resubmit/)
  await assert.rejects(waitForGenerationRuns({ runIds: ['a'] }, { read: async () => ({ success: false }) }), /could not be verified/)
  for (const args of [{}, { runIds: [] }, { runIds: ['a', 'a'] }, { runIds: ['a'], returnWhen: 'forever' }, { runIds: ['a'], cancel: true }])
    await assert.rejects(waitForGenerationRuns(args, { read: async () => assert.fail('No read') }))
  assert.equal(tool.inputSchema.additionalProperties, false)
})
