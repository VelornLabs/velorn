import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createMediaPreparationStatusState,
  dismissMediaPreparationSummary,
  subscribeToMediaPreparationStatus,
  updateMediaPreparationStatus,
} from './mediaPreparationStatus.mjs'

const job = (overrides = {}) => ({ id: 'a', kind: 'playback', label: 'Camera take.mov', status: 'queued', progress: null, hardware: null, encoder: null, ...overrides })
const snapshot = (overrides = {}) => ({ activeCount: 0, queuedCount: 0, total: 0, completed: 0, failed: 0, cancelledCount: 0, jobs: [], ...overrides })
const update = (state, changes) => updateMediaPreparationStatus(state, snapshot(changes))
const start = (changes = {}) => update(createMediaPreparationStatusState(), { total: 1, queuedCount: 1, jobs: [job()], ...changes })

test('idle and historical terminal snapshots stay hidden on mount', () => {
  for (const changes of [{}, { total: 4, completed: 3, failed: 1, jobs: [job({ status: 'failed' })] }]) {
    assert.equal(update(createMediaPreparationStatusState(), changes).view, null)
  }
})

test('queued work names the operation and file without pretending it has progress', () => {
  const { view } = start({ queuedCount: 3, total: 3 })
  assert.equal(view.title, 'Optimizing playback')
  assert.equal(view.label, 'Camera take.mov')
  assert.equal(view.counts, '3 queued')
  assert.equal(view.processor, null)
  assert.equal(view.progress, null)
  assert.equal(start({ jobs: [job({ kind: 'proxy' })] }).view.title, 'Creating proxies')
})

test('encoding reports current file progress, hardware checks, and queue counts', () => {
  const queued = start({ queuedCount: 3, total: 3 })
  const checking = update(queued, { activeCount: 1, queuedCount: 2, total: 3, jobs: [job({ status: 'encoding' })] })
  assert.equal(checking.view.counts, '1 active · 2 queued')
  assert.equal(checking.view.processor, 'Checking hardware')
  assert.equal(checking.view.progress, null)
  const encoding = update(checking, { activeCount: 1, queuedCount: 2, total: 3, jobs: [job({ status: 'encoding', hardware: true, encoder: 'h264_nvenc', progress: 0.42 })] })
  assert.equal(encoding.view.processor, 'GPU')
  assert.equal(encoding.view.progress, 0.42)
  assert.equal(encoding.view.mode, 'busy')
  const probing = start({ activeCount: 1, queuedCount: 0, jobs: [job({ status: 'encoding', hardware: false, encoder: null })] })
  assert.equal(probing.view.processor, 'Checking hardware')
})

test('multiple active jobs keep progress tied to the named file rather than averaging', () => {
  const { view } = start({ activeCount: 2, queuedCount: 0, total: 2, jobs: [
    job({ status: 'encoding', kind: 'proxy', progress: 0.2 }),
    job({ id: 'b', status: 'encoding', progress: 0.8 }),
  ] })
  assert.equal(view.title, 'Creating proxies')
  assert.equal(view.counts, '2 active')
  assert.equal(view.progress, 0.2)
})

test('CPU fallback is explicit without showing native errors or paths', () => {
  const { view } = start({ activeCount: 1, queuedCount: 0, jobs: [job({
    status: 'encoding', hardware: false, encoder: 'libx264', fallbackReason: 'encoder failed at /private/user/file.mov',
  })] })
  assert.equal(view.processor, 'CPU')
  assert.match(view.processorDescription, /Continuing with the CPU/)
  assert.doesNotMatch(view.processorDescription, /private|file\.mov/)
})

test('known progress is clamped and malformed progress remains indeterminate', () => {
  for (const [value, expected] of [[-0.2, 0], [0, 0], [1.3, 1], [NaN, null], [Infinity, null], ['0.5', null], [undefined, null]]) {
    const { view } = start({ activeCount: 1, queuedCount: 0, jobs: [job({ status: 'encoding', progress: value })] })
    assert.equal(view.progress, expected)
  }
})

test('native labels show a basename only on every platform', () => {
  for (const [label, expected] of [['/home/user/private/take.mov', 'take.mov'], ['C:\\Users\\private\\take.mov', 'take.mov'], ['take\n.mov', 'take.mov'], [null, 'Media file'], ['', 'Media file']]) {
    assert.equal(start({ jobs: [job({ label })] }).view.label, expected)
  }
})

test('completion has a dismissible summary and duplicate idle updates do not resurrect it', () => {
  const completedSnapshot = { total: 1, completed: 1, jobs: [job({ status: 'ready' })] }
  const complete = update(start(), completedSnapshot)
  assert.equal(complete.view.title, 'Media preparation complete')
  assert.equal(complete.summaryId, 1)
  const hidden = dismissMediaPreparationSummary(complete, complete.summaryId)
  assert.equal(hidden.view, null)
  assert.equal(update(hidden, completedSnapshot).view, null)
})

test('a delayed dismissal cannot hide newer work or a newer summary', () => {
  const complete = update(start(), { total: 1, completed: 1 })
  const busy = update(complete, { total: 1, queuedCount: 1, jobs: [job({ id: 'b' })] })
  assert.equal(dismissMediaPreparationSummary(busy, complete.summaryId), busy)
  const nextComplete = update(busy, { total: 1, completed: 1 })
  assert.equal(nextComplete.summaryId, 2)
  assert.equal(dismissMediaPreparationSummary(nextComplete, complete.summaryId), nextComplete)
})

test('failure is visible while working and after completion, preserving original availability', () => {
  const busy = start({ activeCount: 1, queuedCount: 1, total: 3, failed: 1, jobs: [job({ status: 'encoding' })] })
  assert.equal(busy.view.failureNote, '1 failed. Originals remain available for editing.')
  const done = update(busy, { total: 3, completed: 2, failed: 1 })
  assert.equal(done.view.tone, 'warning')
  assert.match(done.view.detail, /Originals remain available for editing/)
})

test('new batch counter resets do not retain a previous failure', () => {
  const failed = update(start(), { total: 1, failed: 1 })
  const next = update(failed, { total: 1, queuedCount: 1, jobs: [job({ id: 'b' })] })
  assert.equal(next.view.failureNote, null)
  assert.equal(update(next, { total: 1, completed: 1 }).view.tone, 'success')
})

test('cumulative owner counters only report new failures in an observed busy cycle', () => {
  const old = update(createMediaPreparationStatusState(), { total: 4, completed: 3, failed: 1 })
  const next = update(old, { total: 5, completed: 3, failed: 1, queuedCount: 1, jobs: [job()] })
  assert.equal(next.view.failureNote, null)
  assert.equal(update(next, { total: 5, completed: 4, failed: 1 }).view.tone, 'success')
  const failed = update(next, { total: 5, completed: 3, failed: 2 })
  assert.match(failed.view.detail, /^1 failed/)
})

test('cancellation does not claim that prepared media is ready', () => {
  const stopped = update(start(), { total: 1, cancelledCount: 1, jobs: [job({ status: 'cancelled' })] })
  assert.equal(stopped.view.title, 'Media preparation stopped')
  assert.match(stopped.view.detail, /Originals remain available/)
  const partial = update(start({ queuedCount: 2, total: 2 }), { total: 2, completed: 1, cancelledCount: 1 })
  assert.match(partial.view.detail, /Remaining jobs stopped/)
})

test('malformed and bounded snapshots remain safe without fabricated batch totals', () => {
  const initial = createMediaPreparationStatusState()
  assert.equal(updateMediaPreparationStatus(initial, null), initial)
  const { view } = updateMediaPreparationStatus(initial, { activeCount: 1, queuedCount: 5, jobs: [null, false], total: 100 })
  assert.equal(view.counts, '1 active · 5 queued')
  assert.equal(view.label, 'Preparing media')
  assert.equal(view.progress, null)
})

test('status subscription ignores a stale initial response after a live event', async () => {
  let listener
  let resolveInitial
  const received = []
  const api = {
    onMediaPreparationStatus: (callback) => { listener = callback; return () => {} },
    getMediaPreparationStatus: () => new Promise((resolve) => { resolveInitial = resolve }),
  }
  const dispose = subscribeToMediaPreparationStatus(api, (value) => received.push(value))
  listener({ activeCount: 1 })
  resolveInitial({ activeCount: 0 })
  await Promise.resolve()
  assert.deepEqual(received, [{ activeCount: 1 }])
  dispose()
})

test('status subscription loads initial work and removes the listener on unmount', async () => {
  let listener
  let unsubscribed = 0
  const received = []
  const dispose = subscribeToMediaPreparationStatus({
    onMediaPreparationStatus: (callback) => { listener = callback; return () => { unsubscribed += 1 } },
    getMediaPreparationStatus: async () => ({ queuedCount: 2 }),
  }, (value) => received.push(value))
  await Promise.resolve()
  assert.deepEqual(received, [{ queuedCount: 2 }])
  dispose()
  listener({ queuedCount: 3 })
  assert.equal(unsubscribed, 1)
  assert.equal(received.length, 1)
})

test('initial response after disposal and missing or rejected bridge APIs are harmless', async () => {
  const received = []
  const dispose = subscribeToMediaPreparationStatus({ getMediaPreparationStatus: async () => ({ queuedCount: 2 }) }, (value) => received.push(value))
  dispose()
  subscribeToMediaPreparationStatus(undefined, (value) => received.push(value))()
  subscribeToMediaPreparationStatus({ getMediaPreparationStatus: () => { throw new Error('unsupported') } }, (value) => received.push(value))()
  subscribeToMediaPreparationStatus({ getMediaPreparationStatus: async () => { throw new Error('disconnected') } }, (value) => received.push(value))()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(received, [])
})
