'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createLocalAgentGpuCoordinator } = require('../electron/localAgentGpuCoordinator.cjs')

const endpoint = 'http://127.0.0.1:8188'
const modelEndpoint = 'http://127.0.0.1:1234/v1'
const idle = () => ({ queue_running: [], queue_pending: [] })
const busy = id => ({ queue_running: [[0, id]], queue_pending: [] })
const stats = bytes => ({ devices: [{ type: 'cuda', torch_vram_total: bytes }] })
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const response = body => ({ ok: true, json: async () => body })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function until(predicate, label = 'condition') {
  for (let index = 0; index < 300; index++) {
    if (predicate()) return
    await delay(1)
  }
  assert.fail(`Timed out waiting for ${label}`)
}
function fixture(options = {}) {
  const state = { queue: idle(), histories: {}, stats: stats(64 * 1024 * 1024), offline: false }
  const calls = [], waiting = [], events = []
  const runtime = {
    async prepareModel(args) { calls.push({ type: 'prepare', ...args }); return options.prepare?.(args) },
    async releaseModel(args) { calls.push({ type: 'release', ...args }); return options.release?.(args) },
  }
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname
    calls.push({ type: 'http', route, url, init })
    const override = await options.fetch?.({ route, url, init, state, calls })
    if (override !== undefined) return override
    if (state.offline) throw new TypeError('fetch failed')
    if (route === '/queue') return response(state.queue)
    if (route === '/system_stats') return response(state.stats)
    if (route === '/free') {
      assert.equal(init.method, 'POST')
      assert.deepEqual(JSON.parse(init.body), { unload_models: true, free_memory: true })
      assert.equal(state.queue.queue_running.length + state.queue.queue_pending.length, 0, 'never free an observed busy queue')
      return { ok: true, json: async () => { throw new Error('Empty /free body is not JSON') } }
    }
    if (route.startsWith('/history/')) {
      const id = decodeURIComponent(route.slice('/history/'.length))
      return response(state.histories[id] ? { [id]: state.histories[id] } : {})
    }
    throw new Error(`Unexpected HTTP request ${route}`)
  }
  const coordinator = createLocalAgentGpuCoordinator({
    runtime, fetchImpl, getComfyEndpoint: options.getComfyEndpoint || (() => endpoint),
    pollMs: 1, requestTimeoutMs: 40, maxWaitMs: options.maxWaitMs || 1000,
  })
  return {
    coordinator, state, calls, waiting, events,
    count(type) { return calls.filter(call => call.type === type).length },
    route(route) { return calls.filter(call => call.route === route).length },
    infer(operation = () => 'reply', args = {}) {
      return coordinator.withInference({ model: 'agent-small', endpoint: modelEndpoint,
        onWaiting: value => waiting.push(value), onEvent: event => events.push(event), ...args }, async payload => {
        calls.push({ type: 'inference' })
        return operation(payload)
      })
    },
    async submit(id = 'prompt-one') {
      const lease = await coordinator.beforeGeneration({ endpoint })
      const receipt = coordinator.afterGeneration({ lease, postStarted: true, result: { success: true, ok: true, status: 200, body: { prompt_id: id } } })
      assert.deepEqual(receipt, { tracking: true, promptId: id })
      return lease
    },
    done(id = 'prompt-one', status = 'success') { state.histories[id] = { status: { status_str: status } } },
  }
}

test('ordinary chat works while ComfyUI is offline and never frees unobserved models', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  f.state.offline = true
  assert.equal(await f.infer(), 'reply')
  assert.equal(f.count('prepare'), 1)
  assert.equal(f.count('inference'), 1)
  assert.equal(f.route('/free'), 0)
  assert.equal(f.count('release'), 0)
  assert.deepEqual(f.waiting, [true, false])
})

test('no ComfyUI configuration does not block chat, and invalid generation endpoints are rejected', async t => {
  const f = fixture({ getComfyEndpoint: () => null }); t.after(() => f.coordinator.dispose())
  assert.equal(await f.infer(), 'reply')
  assert.equal(f.count('http'), 0)
  await assert.rejects(f.coordinator.beforeGeneration({ endpoint: 'file:///tmp/not-comfy' }), { code: 'LOCAL_GPU_COMFY_UNAVAILABLE' })
  await assert.rejects(f.coordinator.beforeGeneration({ endpoint: 'https://external.invalid' }), { code: 'LOCAL_GPU_COMFY_UNAVAILABLE' })
})

test('verified restored instance alias reaches prediction while original selection owns the runtime snapshot', async t => {
  const f = fixture({ prepare: () => ({ model: 'restored-instance' }) }); t.after(() => f.coordinator.dispose())
  assert.equal(await f.infer(({ model, signal }) => { assert.ok(signal instanceof AbortSignal); return model }), 'restored-instance')
  const lease = await f.coordinator.beforeGeneration({ endpoint })
  assert.equal(f.calls.find(call => call.type === 'release').model, 'agent-small')
  f.coordinator.afterGeneration({ lease, postStarted: false })
})

test('only trusted supported runtime reasoning profiles reach prediction', async t => {
  for (const reasoningEffort of ['none', 'low', 'high', undefined]) {
    const f = fixture({ prepare: () => ({ model: 'restored-instance', reasoningEffort }) }); t.after(() => f.coordinator.dispose())
    const actual = await f.infer(value => value.reasoningEffort)
    assert.equal(actual, ['none', 'low'].includes(reasoningEffort) ? reasoningEffort : undefined)
  }
})

test('ownership begins at inference, persists between rounds, and unloads only selected models', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  const first = await f.coordinator.beforeGeneration({ endpoint })
  assert.equal(f.count('release'), 0)
  f.coordinator.afterGeneration({ lease: first, postStarted: false })
  await f.infer()
  await f.infer()
  await f.infer(() => 'other', { model: 'agent-other' })
  const lease = await f.coordinator.beforeGeneration({ endpoint })
  const released = f.calls.filter(call => call.type === 'release')
  assert.deepEqual(released.map(call => [call.model, call.endpoint]), [['agent-small', modelEndpoint], ['agent-other', modelEndpoint]])
  f.coordinator.afterGeneration({ lease, postStarted: false })
})

test('generation reserves synchronously and has priority over queued inference', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  const prediction = deferred()
  const first = f.infer(() => prediction.promise)
  await until(() => f.count('inference') === 1)
  const second = f.infer(() => 'second')
  let acquired = false
  const generation = f.coordinator.beforeGeneration({ endpoint }).then(value => { acquired = true; return value })
  await delay(5)
  assert.equal(acquired, false)
  assert.equal(f.count('release'), 0)
  prediction.resolve('first')
  assert.equal(await first, 'first')
  const lease = await generation
  assert.equal(f.count('release'), 1)
  assert.equal(f.count('inference'), 1)
  f.coordinator.afterGeneration({ lease, postStarted: false })
  assert.equal(await second, 'second')
  assert.ok(f.calls.findIndex(call => call.type === 'release') < f.calls.findLastIndex(call => call.type === 'prepare'))
})

test('same-turn generation priority prevents premature inference model loading', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  const inference = f.infer()
  const lease = await f.coordinator.beforeGeneration({ endpoint })
  assert.equal(f.count('prepare'), 0)
  f.coordinator.afterGeneration({ lease, postStarted: false })
  await inference
})

test('successful submission returns immediately, but empty queue alone cannot release its lease', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  await f.submit()
  const inference = f.infer()
  await until(() => f.route('/history/prompt-one') > 1)
  assert.equal(f.count('prepare'), 0)
  assert.equal(f.route('/free'), 0)
  assert.ok(f.events.some(event => /confirm the submitted generation/.test(event.text)))
  assert.ok(f.events.every(event => event.type === 'status'), 'native local-agent event filter forwards status events')
  f.done()
  assert.equal(await inference, 'reply')
  assert.equal(f.route('/free'), 1)
  assert.equal(f.route('/system_stats'), 2)
  assert.deepEqual(f.waiting, [true, false])
})

test('multiple managed submissions and other-client queue entries all block inference', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  await f.submit('one')
  await f.submit('two')
  f.done('one')
  const inference = f.infer()
  await until(() => f.route('/history/two') > 1)
  assert.equal(f.count('prepare'), 0)
  f.done('two', 'error')
  f.state.queue = busy('external-client')
  await until(() => f.events.some(event => /generation to finish/.test(event.text)))
  assert.equal(f.route('/free'), 0)
  f.state.queue = idle()
  await inference
  assert.equal(f.route('/free'), 1)
})

test('external ComfyUI generation is observed before loading, then freed only after idle', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  f.state.queue = busy('external-job')
  const inference = f.infer()
  await until(() => f.route('/queue') >= 3)
  assert.equal(f.count('prepare'), 0)
  assert.equal(f.route('/free'), 0)
  f.state.queue = idle()
  await inference
  assert.equal(f.route('/free'), 1)
  assert.equal(f.count('prepare'), 1)
})

test('queued generation preempts inference that is waiting for external GPU work', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  f.state.queue = busy('external-job')
  const inference = f.infer()
  await until(() => f.route('/queue') > 1)
  const lease = await f.coordinator.beforeGeneration({ endpoint })
  assert.equal(f.count('prepare'), 0)
  f.coordinator.afterGeneration({ lease, postStarted: false })
  f.state.queue = idle()
  await inference
})

test('unknown POST outcome remains blocked even if the queue is empty, with no automatic resubmission', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  const lease = await f.coordinator.beforeGeneration({ endpoint })
  const receipt = f.coordinator.afterGeneration({ lease, postStarted: true, result: { success: false, submissionState: 'unknown', retryAllowed: false } })
  assert.equal(receipt.code, 'LOCAL_GPU_GENERATION_UNCERTAIN')
  await assert.rejects(f.infer(), error => error.code === 'LOCAL_GPU_GENERATION_UNCERTAIN' && /Inspect the ComfyUI queue\/history/.test(error.publicMessage))
  assert.equal(f.count('prepare'), 0)
  assert.equal(f.route('/free'), 0)
  assert.equal(f.route('/prompt'), 0)
  // Generation-only use is still possible; uncertainty never authorizes loading
  // the agent or automatically retrying the earlier prompt.
  const secondLease = await f.coordinator.beforeGeneration({ endpoint })
  f.coordinator.afterGeneration({ lease: secondLease, postStarted: false })
  await assert.rejects(f.infer(), { code: 'LOCAL_GPU_GENERATION_UNCERTAIN' })
})

test('unknown POST fails actionably without waiting for a busy or offline queue', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  const lease = await f.coordinator.beforeGeneration({ endpoint })
  f.coordinator.afterGeneration({ lease, postStarted: true, result: { success: false, submissionState: 'unknown' } })
  f.state.offline = true
  await assert.rejects(f.infer(), { code: 'LOCAL_GPU_GENERATION_UNCERTAIN' })
  assert.equal(f.count('http'), 0)
})

test('complete HTTP 400 validation rejection releases the reservation without inventing a job', async t => {
  for (const error of ['Invalid workflow', { message: 'Prompt outputs failed validation' }, { type: 'no_prompt' }]) {
    const f = fixture(); t.after(() => f.coordinator.dispose())
    const lease = await f.coordinator.beforeGeneration({ endpoint })
    assert.deepEqual(f.coordinator.afterGeneration({ lease, postStarted: true,
      result: { success: true, ok: false, status: 400, body: { error, node_errors: {} } } }), { tracking: false })
    await f.infer()
    assert.equal(f.route('/free'), 0)
    assert.equal(f.calls.some(call => call.route?.startsWith('/history/')), false)
  }
})

test('5xx, malformed validation rejection and contradictory prompt ID remain uncertain', async t => {
  for (const result of [
    { success: true, ok: false, status: 500, body: { error: 'Internal error' } },
    { success: true, ok: false, status: 400, body: { error: {} } },
    { success: true, ok: false, status: 400, body: { error: 'Rejected', prompt_id: 'contradictory' } },
    { success: false, ok: false, status: 400, body: { error: 'Incomplete response' } },
    { success: true, ok: true, status: 200, body: { error: 'Malformed success' } },
  ]) {
    const f = fixture(); t.after(() => f.coordinator.dispose())
    const lease = await f.coordinator.beforeGeneration({ endpoint })
    f.coordinator.afterGeneration({ lease, postStarted: true, result })
    await assert.rejects(f.infer(), { code: 'LOCAL_GPU_GENERATION_UNCERTAIN' })
    assert.equal(f.count('prepare'), 0)
  }
})

test('failed not-started preflight releases the reservation without /free or history reads', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  const lease = await f.coordinator.beforeGeneration({ endpoint })
  f.coordinator.afterGeneration({ lease, postStarted: false, result: { success: false } })
  await f.infer()
  assert.equal(f.route('/free'), 0)
  assert.equal(f.calls.some(call => call.route?.startsWith('/history/')), false)
})

test('unload failure prevents generation and retains the selected model for a later unload retry', async t => {
  let fail = true
  const f = fixture({ release: () => { if (fail) throw new Error('runtime secret detail') } }); t.after(() => f.coordinator.dispose())
  await f.infer()
  await assert.rejects(f.coordinator.beforeGeneration({ endpoint }), error => error.code === 'LOCAL_GPU_MODEL_RELEASE_FAILED' && !error.message.includes('secret'))
  fail = false
  const lease = await f.coordinator.beforeGeneration({ endpoint })
  assert.equal(f.count('release'), 2)
  f.coordinator.afterGeneration({ lease, postStarted: false })
})

test('/free acknowledgement cannot reload the agent until native memory release is confirmed', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  await f.submit(); f.done()
  f.state.stats = stats(8 * 1024 * 1024 * 1024)
  const inference = f.infer()
  await until(() => f.route('/system_stats') >= 3)
  assert.equal(f.route('/free'), 1)
  assert.equal(f.count('prepare'), 0)
  f.state.stats = stats(64 * 1024 * 1024)
  await inference
  assert.equal(f.count('prepare'), 1)
})

test('cold-start idle ComfyUI retained memory is released before the first local model load', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  f.state.stats = stats(12 * 1024 * 1024 * 1024)
  const inference = f.infer()
  await until(() => f.route('/free') === 1 && f.route('/system_stats') >= 3)
  assert.equal(f.count('prepare'), 0)
  f.state.stats = stats(64 * 1024 * 1024)
  await inference
  assert.equal(f.count('prepare'), 1)
  assert.equal(f.route('/free'), 1)
})

test('cold-start unknown ComfyUI memory reports an unconfirmed handoff without blocking ordinary chat', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  f.state.stats = { devices: [{ type: 'cuda', vram_free: 5000 }] }
  await f.infer()
  assert.equal(f.route('/free'), 0)
  assert.ok(f.events.some(event => event.type === 'status' && /without a confirmed GPU handoff/.test(event.text)))
})

test('cold-start stats connection failure does not make ComfyUI a chat dependency', async t => {
  const f = fixture({ fetch: ({ route }) => { if (route === '/system_stats') throw new Error('stats unavailable') } }); t.after(() => f.coordinator.dispose())
  await f.infer()
  assert.equal(f.route('/free'), 0)
  assert.ok(f.events.some(event => /could not be verified/.test(event.text)))
})

test('cold-start observed retained memory cannot silently fallback if its later allocator probe fails', async t => {
  const f = fixture({ maxWaitMs: 35 }); t.after(() => f.coordinator.dispose())
  f.state.stats = stats(6 * 1024 * 1024 * 1024)
  const inference = f.infer()
  await until(() => f.route('/free') === 1)
  f.state.stats = { devices: [] }
  await assert.rejects(inference, { code: 'LOCAL_GPU_MEMORY_NOT_RELEASED' })
  assert.equal(f.count('prepare'), 0)
})

test('missing GPU allocator stats and bounded memory timeout fail closed; a later retry can reconcile', async t => {
  const f = fixture({ maxWaitMs: 35 }); t.after(() => f.coordinator.dispose())
  await f.submit(); f.done()
  f.state.stats = { devices: [{ type: 'cuda', vram_free: 20 * 1024 * 1024 * 1024 }] }
  await assert.rejects(f.infer(), { code: 'LOCAL_GPU_MEMORY_NOT_RELEASED' })
  assert.equal(f.count('prepare'), 0)
  f.state.stats = stats(64 * 1024 * 1024)
  await f.infer()
  assert.equal(f.count('prepare'), 1)
})

test('CPU-only native ComfyUI stats also require idle post-free confirmations', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  await f.submit(); f.done()
  f.state.stats = { devices: [{ type: 'cpu' }] }
  await f.infer()
  assert.equal(f.route('/system_stats'), 2)
})

test('a known busy ComfyUI going offline never falls back to ordinary inference', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  await f.submit(); f.state.offline = true
  await assert.rejects(f.infer(), { code: 'LOCAL_GPU_COMFY_UNAVAILABLE' })
  assert.equal(f.count('prepare'), 0)
  assert.equal(f.route('/free'), 0)
  f.state.offline = false; f.done()
  await f.infer()
})

test('fresh queue recheck prevents freeing when another client enqueues during history reads', async t => {
  let injected = false
  const f = fixture({ fetch: ({ route, state }) => {
    if (route.startsWith('/history/') && !injected) { injected = true; state.queue = busy('racing-client') }
  } }); t.after(() => f.coordinator.dispose())
  await f.submit(); f.done()
  const inference = f.infer()
  await until(() => injected && f.route('/queue') >= 4)
  assert.equal(f.route('/free'), 0)
  assert.equal(f.count('prepare'), 0)
  f.state.queue = idle()
  await inference
})

test('cancelled waiting inference releases timer pause and makes no late model mutation', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  f.state.queue = busy('external')
  const controller = new AbortController()
  const inference = f.infer(undefined, { signal: controller.signal })
  await until(() => f.route('/queue') > 1)
  controller.abort()
  await assert.rejects(inference, { name: 'AbortError' })
  f.state.queue = idle()
  await delay(10)
  assert.equal(f.count('prepare'), 0)
  assert.equal(f.route('/free'), 0)
  assert.deepEqual(f.waiting, [true, false])
})

test('cancelled prediction holds the internal slot until an abort-ignoring operation settles', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  const controller = new AbortController(), prediction = deferred()
  const inference = f.infer(() => prediction.promise, { signal: controller.signal })
  await until(() => f.count('inference') === 1)
  controller.abort()
  await assert.rejects(inference, { name: 'AbortError' })
  let acquired = false
  const generation = f.coordinator.beforeGeneration({ endpoint }).then(lease => { acquired = true; return lease })
  await delay(5)
  assert.equal(acquired, false)
  assert.equal(f.count('release'), 0)
  prediction.resolve('late ignored response')
  const lease = await generation
  assert.equal(f.count('release'), 1)
  f.coordinator.afterGeneration({ lease, postStarted: false })
})

test('dispose during abort-ignoring queue HTTP prevents later free/model loading', async () => {
  const pending = deferred()
  const f = fixture({ fetch: ({ route }) => route === '/queue' ? pending.promise : undefined })
  const inference = f.infer()
  await until(() => f.route('/queue') === 1)
  f.coordinator.dispose()
  await assert.rejects(inference, { code: 'LOCAL_GPU_DISPOSED' })
  pending.resolve(response(idle()))
  await delay(10)
  assert.equal(f.count('prepare'), 0)
  assert.equal(f.route('/free'), 0)
  assert.deepEqual(f.waiting, [true, false])
  await assert.rejects(f.infer(), { code: 'LOCAL_GPU_DISPOSED' })
})

test('dispose after /free acknowledgement prevents late allocator responses from loading the agent', async () => {
  const pending = deferred()
  const f = fixture({ fetch: ({ route }) => route === '/system_stats' ? pending.promise : undefined })
  await f.submit(); f.done()
  const inference = f.infer()
  await until(() => f.route('/system_stats') === 1)
  f.coordinator.dispose()
  await assert.rejects(inference, { code: 'LOCAL_GPU_DISPOSED' })
  pending.resolve(response(stats(0)))
  await delay(10)
  assert.equal(f.count('prepare'), 0)
  assert.equal(f.route('/free'), 1)
  assert.deepEqual(f.waiting, [true, false])
})

test('managed generation wait timeout does not leak an acquired lease or permit overlap', async t => {
  const f = fixture({ maxWaitMs: 25 }); t.after(() => f.coordinator.dispose())
  const pending = deferred()
  const inference = f.infer(() => pending.promise)
  await until(() => f.count('inference') === 1)
  await assert.rejects(f.coordinator.beforeGeneration({ endpoint }), { code: 'LOCAL_GPU_WAIT_TIMEOUT' })
  assert.equal(f.count('release'), 0)
  pending.resolve('done'); await inference
  await f.infer()
  assert.equal(f.count('release'), 0)
})

test('cancelled or disposed unload acquisition cannot publish a late generation lease', async () => {
  for (const mode of ['abort', 'dispose']) {
    const pending = deferred(), controller = new AbortController()
    const f = fixture({ release: () => pending.promise })
    await f.infer()
    let lease = null
    const generation = f.coordinator.beforeGeneration({ endpoint, signal: controller.signal }).then(value => { lease = value })
    await until(() => f.count('release') === 1)
    if (mode === 'abort') controller.abort()
    else f.coordinator.dispose()
    await assert.rejects(generation)
    pending.resolve()
    await delay(5)
    assert.equal(lease, null)
    f.coordinator.dispose()
  }
})

test('queued acquisition cancellation neither unloads a model nor leaks a reservation', async t => {
  const f = fixture(); t.after(() => f.coordinator.dispose())
  const pending = deferred()
  const inference = f.infer(() => pending.promise)
  await until(() => f.count('inference') === 1)
  const controller = new AbortController()
  const generation = f.coordinator.beforeGeneration({ endpoint, signal: controller.signal })
  controller.abort()
  await assert.rejects(generation, { name: 'AbortError' })
  pending.resolve('done'); await inference
  await f.infer()
  assert.equal(f.count('release'), 0)
})

test('failed preparation and failed inference both require selected-model reconciliation before generation', async t => {
  let failPreparation = true
  const f = fixture({ prepare: () => { if (failPreparation) throw new Error('load failure') } }); t.after(() => f.coordinator.dispose())
  await assert.rejects(f.infer(), /load failure/)
  let lease = await f.coordinator.beforeGeneration({ endpoint })
  assert.equal(f.count('release'), 1)
  f.coordinator.afterGeneration({ lease, postStarted: false })
  failPreparation = false
  await assert.rejects(f.infer(() => { throw new Error('prediction failure') }), /prediction failure/)
  lease = await f.coordinator.beforeGeneration({ endpoint })
  assert.equal(f.count('release'), 2)
  f.coordinator.afterGeneration({ lease, postStarted: false })
})

test('a load that becomes resident before preparation fails is unloaded before generation proceeds', async t => {
  let resident = false
  const f = fixture({ prepare: () => { resident = true; throw new Error('verification failed after load') },
    release: () => { resident = false } }); t.after(() => f.coordinator.dispose())
  await assert.rejects(f.infer(), /verification failed/)
  assert.equal(resident, true)
  const lease = await f.coordinator.beforeGeneration({ endpoint })
  assert.equal(resident, false)
  assert.equal(f.count('inference'), 0)
  assert.equal(f.count('release'), 1)
  f.coordinator.afterGeneration({ lease, postStarted: false })
})

test('cancelled preparation retains its selected identity for cleanup after late load settlement', async t => {
  const pending = deferred(), controller = new AbortController()
  let resident = false
  const f = fixture({ prepare: async () => { await pending.promise; resident = true }, release: () => { resident = false } }); t.after(() => f.coordinator.dispose())
  const inference = f.infer(undefined, { signal: controller.signal })
  await until(() => f.count('prepare') === 1)
  controller.abort()
  await assert.rejects(inference, { name: 'AbortError' })
  let acquired = false
  const generation = f.coordinator.beforeGeneration({ endpoint }).then(lease => { acquired = true; return lease })
  await delay(5)
  assert.equal(acquired, false)
  pending.resolve()
  const lease = await generation
  assert.equal(resident, false)
  assert.equal(f.count('release'), 1)
  assert.equal(f.count('inference'), 0)
  f.coordinator.afterGeneration({ lease, postStarted: false })
})
