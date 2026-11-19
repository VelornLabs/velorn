'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { createGenerationMemoryCleanup } = require('../electron/generationMemoryCleanup.cjs')
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(t) {
  const state = { enabled: true, endpoint: 'http://127.0.0.1:8189', busy: false, queue: { queue_running: [], queue_pending: [] }, fail: false }
  const timers = new Set(), calls = [], errors = []
  const cleanup = createGenerationMemoryCleanup({ getEnabled: () => state.enabled, getEndpoint: () => state.endpoint, isBusy: () => state.busy,
    setTimer: fn => { timers.add(fn); return fn }, clearTimer: fn => timers.delete(fn), onError: message => errors.push(message),
    fetchImpl: async (url, options) => {
      calls.push({ url, options }); await state.onFetch?.(url)
      if (state.fail) throw new Error('fixture failure')
      return { ok: true, json: async () => state.queue }
    } })
  t.after(() => cleanup.dispose())
  return { state, cleanup, calls, errors, timers, schedule: () => cleanup.schedule({ endpoint: state.endpoint }),
    step: async () => { const fn = timers.values().next().value; if (fn) { timers.delete(fn); fn(); for (let i = 0; i < 6; i++) await tick() } },
    posts: () => calls.filter(c => c.options.method === 'POST') }
}
test('opt-in, completion-triggered cleanup requests /free once after two idle observations', async t => {
  const f = fixture(t)
  assert.equal(f.timers.size, 0)
  f.schedule(); await f.step(); assert.equal(f.posts().length, 0)
  await f.step(); assert.equal(f.posts().length, 1)
  assert.equal(f.posts()[0].url, 'http://127.0.0.1:8189/free')
  assert.deepEqual(JSON.parse(f.posts()[0].options.body), { unload_models: true, free_memory: true })
  await f.step(); assert.equal(f.posts().length, 1)
})
test('busy queue includes external jobs and resets the idle delay', async t => {
  const f = fixture(t); f.schedule(); await f.step()
  f.state.queue.queue_pending = [[1, 'external']]; await f.step(); assert.equal(f.posts().length, 0)
  f.state.queue.queue_pending = []; f.state.queue.queue_running = [[2, 'external']]; await f.step()
  f.state.queue.queue_running = []; await f.step(); assert.equal(f.posts().length, 0)
  await f.step(); assert.equal(f.posts().length, 1)
})
for (const condition of ['disabled', 'switch', 'busy', 'disposed', 'malformed', 'failed']) test(`does not unload when ${condition}`, async t => {
  const f = fixture(t); f.schedule(); await f.step()
  if (condition === 'disabled') f.state.enabled = false
  if (condition === 'switch') f.state.endpoint = 'http://127.0.0.1:8190'
  if (condition === 'busy') f.state.busy = true
  if (condition === 'disposed') f.cleanup.dispose()
  if (condition === 'malformed') f.state.queue = {}
  if (condition === 'failed') f.state.fail = true
  await f.step(); assert.equal(f.posts().length, 0)
})
test('disabling during queue read prevents the POST', async t => {
  const f = fixture(t); f.schedule(); await f.step()
  f.state.onFetch = () => { f.state.enabled = false }
  await f.step(); assert.equal(f.posts().length, 0)
})
test('a fresh completion during a read restarts the idle window', async t => {
  const f = fixture(t); f.schedule(); await f.step()
  f.state.onFetch = () => { f.state.onFetch = null; f.schedule() }
  await f.step(); assert.equal(f.posts().length, 0)
  await f.step(); assert.equal(f.posts().length, 0)
  await f.step(); assert.equal(f.posts().length, 1)
})
test('failed cleanup POST is not retried and does not affect a generation result', async t => {
  const f = fixture(t); f.schedule(); await f.step()
  f.state.onFetch = url => { if (url.endsWith('/free')) f.state.fail = true }
  await f.step(); await f.step()
  assert.equal(f.posts().length, 1); assert.equal(f.errors.length, 1); assert.equal(f.timers.size, 0)
})
test('default-off never contacts ComfyUI and remote endpoints are ignored', async t => {
  const f = fixture(t); f.state.enabled = undefined; f.schedule(); await f.step()
  assert.equal(f.calls.length, 0)
  f.cleanup.schedule({ endpoint: 'https://example.com' }); assert.equal(f.timers.size, 0)
})
