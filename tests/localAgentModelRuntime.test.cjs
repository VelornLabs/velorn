'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createLocalAgentModelRuntime, endpointOrigin, savedConfig } = require('../electron/localAgentModelRuntime.cjs')

const endpoint = 'http://127.0.0.1:1234/v1'
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const selected = () => ({ type: 'llm', key: 'selected/model', loaded_instances: [{ id: 'selected-alias', config: {
  context_length: 8192, eval_batch_size: 256, num_experts: 4, flash_attention: true, offload_kv_cache_to_gpu: false,
} }] })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function tickUntil(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('The synthetic runtime request did not start')
}
async function outcomeWithin(promise, milliseconds = 80) {
  let timer
  try {
    return await Promise.race([
      promise.then(value => ({ status: 'resolved', value }), error => ({ status: 'rejected', error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'pending' }), milliseconds) }),
    ])
  } finally { clearTimeout(timer) }
}
function fixture(options = {}) {
  const state = { rows: structuredClone(options.rows || [selected(), { type: 'llm', key: 'unrelated/model', loaded_instances: [{ id: 'other-instance', config: {} }] }]) }
  const calls = []
  const runtime = createLocalAgentModelRuntime({ requestTimeoutMs: 1000, loadTimeoutMs: 1000, ...options.runtime,
    fetchImpl: async (url, init) => {
      const request = { url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body), signal: init.signal, redirect: init.redirect }
      calls.push(request)
      if (options.fetchImpl) return options.fetchImpl(request, state)
      if (init.method === 'GET') return response({ models: state.rows })
      if (url.endsWith('/unload')) {
        for (const row of state.rows) row.loaded_instances = row.loaded_instances.filter(instance => instance.id !== request.body.instance_id)
        return response({ instance_id: request.body.instance_id })
      }
      if (url.endsWith('/load')) {
        state.rows.find(row => row.key === request.body.model).loaded_instances.push({ id: 'restored-alias', config: { ...request.body } })
        return response({ status: 'loaded', instance_id: 'restored-alias' })
      }
      throw Error('Unexpected synthetic endpoint')
    },
  })
  return { runtime, calls, state }
}

test('local endpoints normalize only the supported loopback LM Studio server', () => {
  assert.equal(endpointOrigin(endpoint), 'http://127.0.0.1:1234')
  assert.equal(endpointOrigin('http://localhost:1234/v1/'), 'http://127.0.0.1:1234')
  assert.equal(endpointOrigin('http://[::1]:1234/v1'), 'http://[::1]:1234')
  for (const value of ['https://127.0.0.1:1234/v1', 'http://192.168.0.124:1234/v1', 'http://example.test:1234/v1',
    'http://127.0.0.1.evil.test:1234/v1', 'http://127.0.0.1:8080/v1', 'http://127.0.0.1:1234/',
    'http://user:secret@localhost:1234/v1', `${endpoint}?token=secret`, `${endpoint}#private`, 'file:///private/model']) {
    assert.throws(() => endpointOrigin(value), error => error.code === 'LOCAL_GPU_RUNTIME_UNAVAILABLE' && !/secret|private/.test(error.message))
  }
})

test('release unloads only the exact selected instance and verifies that it disappeared', async () => {
  const f = fixture()
  assert.deepEqual(await f.runtime.prepareModel({ model: 'selected-alias', endpoint }), { model: 'selected-alias' })
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0)
  assert.deepEqual(await f.runtime.releaseModel({ model: 'selected-alias', endpoint }), { released: true })
  const writes = f.calls.filter(call => call.method === 'POST')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].url, 'http://127.0.0.1:1234/api/v1/models/unload')
  assert.deepEqual(writes[0].body, { instance_id: 'selected-alias' })
  assert.equal(f.calls.at(-1).method, 'GET')
  assert.deepEqual(f.state.rows[1].loaded_instances, [{ id: 'other-instance', config: {} }])
  assert.ok(f.calls.every(call => call.redirect === 'error'))
})

test('a previously unloaded alias restores its selected model and supported load configuration', async () => {
  const f = fixture()
  await f.runtime.prepareModel({ model: 'selected-alias', endpoint })
  await f.runtime.releaseModel({ model: 'selected-alias', endpoint })
  assert.deepEqual(await f.runtime.prepareModel({ model: 'selected-alias', endpoint }), { model: 'restored-alias' })
  const loads = f.calls.filter(call => call.url.endsWith('/load'))
  assert.equal(loads.length, 1)
  assert.deepEqual(loads[0].body, { model: 'selected/model', context_length: 8192, eval_batch_size: 256, num_experts: 4,
    flash_attention: true, offload_kv_cache_to_gpu: false, echo_load_config: true })
  await f.runtime.releaseModel({ model: 'selected-alias', endpoint })
  assert.deepEqual(f.calls.filter(call => call.url.endsWith('/unload')).at(-1).body, { instance_id: 'restored-alias' })
  assert.equal(f.state.rows[1].loaded_instances[0].id, 'other-instance')
})

test('saved load settings omit arbitrary fields, invalid numbers and credentials', () => {
  assert.deepEqual(savedConfig({ context_length: 2048, eval_batch_size: 32, num_experts: 2, flash_attention: false, offload_kv_cache_to_gpu: true,
    temperature: 1, path: '/private/model', api_key: 'secret', gpu: 'all' }), {
    context_length: 2048, eval_batch_size: 32, num_experts: 2, flash_attention: false, offload_kv_cache_to_gpu: true,
  })
  for (const invalid of [-1, 0, 0.5, NaN, Infinity, 1048577, '8192', null]) {
    assert.deepEqual(savedConfig({ context_length: invalid, eval_batch_size: invalid, num_experts: invalid,
      flash_attention: 'true', offload_kv_cache_to_gpu: 1 }), {})
  }
  assert.deepEqual(savedConfig(null), {}); assert.deepEqual(savedConfig([]), {})
})

test('ambiguous catalogs and invalid loaded instance identities never send unload or load', async t => {
  const cases = [
    { name: 'unknown selected model', rows: [selected()], model: 'absent' },
    { name: 'duplicate model rows', rows: [selected(), selected()], model: 'selected/model' },
    { name: 'multiple instances without exact alias', rows: [{ ...selected(), loaded_instances: [{ id: 'one' }, { id: 'two' }] }], model: 'selected/model' },
    { name: 'invalid instance ID', rows: [{ ...selected(), loaded_instances: [{ id: '\u0000invalid' }] }], model: 'selected/model' },
    { name: 'duplicate instance IDs', rows: [{ ...selected(), loaded_instances: [{ id: 'same' }, { id: 'same' }] }], model: 'same' },
    { name: 'non-LLM model', rows: [{ ...selected(), type: 'embedding' }], model: 'selected/model' },
  ]
  for (const item of cases) await t.test(item.name, async () => {
    for (const operation of ['prepareModel', 'releaseModel']) {
      const f = fixture({ rows: item.rows })
      await assert.rejects(f.runtime[operation]({ endpoint, model: item.model }), error => error.code === 'LOCAL_GPU_RUNTIME_UNAVAILABLE')
      assert.equal(f.calls.filter(call => call.method === 'POST').length, 0)
    }
  })
})

test('a selected exact alias remains usable when another instance of that same model is loaded', async () => {
  const f = fixture({ rows: [{ ...selected(), loaded_instances: [{ id: 'selected-alias' }, { id: 'do-not-unload' }] }] })
  assert.deepEqual(await f.runtime.prepareModel({ endpoint, model: 'selected-alias' }), { model: 'selected-alias' })
  await f.runtime.releaseModel({ endpoint, model: 'selected-alias' })
  assert.deepEqual(f.state.rows[0].loaded_instances, [{ id: 'do-not-unload' }])
})

test('load and unload acknowledgements do not replace verification against a fresh catalog', async t => {
  for (const operation of ['prepareModel', 'releaseModel']) await t.test(operation, async () => {
    const rows = [selected()]
    if (operation === 'prepareModel') rows[0].loaded_instances = []
    const f = fixture({ rows, fetchImpl: request => request.method === 'GET' ? response({ models: rows })
      : request.url.endsWith('/load') ? response({ status: 'loaded', instance_id: 'unverified-alias' }) : response({ instance_id: 'selected-alias' }) })
    await assert.rejects(f.runtime[operation]({ endpoint, model: 'selected/model' }), error => error.code === 'LOCAL_GPU_RUNTIME_UNAVAILABLE')
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
    assert.equal(f.calls.at(-1).method, 'GET')
  })
})

test('invalid model-management bodies and private native failures return only safe diagnostics', async t => {
  const cases = [
    () => { throw new Error('Bearer private-secret /private/model.gguf') },
    () => response({ error: 'password=private-secret' }, 500),
    () => new Response('not JSON /private/model.gguf'),
    () => response([]),
    () => response({ models: 'private-secret' }),
    () => response({ models: Array.from({ length: 2049 }, selected) }),
    () => new Response('x'.repeat(1024 * 1024 + 1)),
  ]
  for (let i = 0; i < cases.length; i++) await t.test(String(i), async () => {
    const f = fixture({ fetchImpl: cases[i] })
    await assert.rejects(f.runtime.prepareModel({ endpoint, model: 'selected/model' }), error => {
      assert.equal(error.code, 'LOCAL_GPU_RUNTIME_UNAVAILABLE'); assert.equal(error.publicMessage, error.message)
      assert.doesNotMatch(error.message, /private-secret|private\/model|password|Bearer/)
      return true
    })
  })
})

test('already aborted operations never call the model server', async () => {
  const f = fixture(), controller = new AbortController()
  controller.abort('private cancellation reason')
  for (const operation of ['prepareModel', 'releaseModel']) await assert.rejects(f.runtime[operation]({ endpoint, model: 'selected/model', signal: controller.signal }), error => {
    assert.equal(error.code, 'CANCELLED'); assert.doesNotMatch(error.message, /private/); return true
  })
  assert.equal(f.calls.length, 0)
})

test('fetch cancellation and request timeout remain bounded even if the transport resolves late', async t => {
  for (const kind of ['cancel', 'timeout']) await t.test(kind, async () => {
    const gate = deferred(), controller = new AbortController()
    const f = fixture({ runtime: { requestTimeoutMs: kind === 'timeout' ? 5 : 1000 }, fetchImpl: () => gate.promise })
    const pending = f.runtime.prepareModel({ endpoint, model: 'selected/model', signal: controller.signal })
    await tickUntil(() => f.calls.length === 1)
    if (kind === 'cancel') controller.abort('private cancellation reason')
    const outcome = await outcomeWithin(pending)
    gate.resolve(response({ models: [selected()] }))
    assert.equal(outcome.status, 'rejected', 'An uncooperative fetch must not leave local GPU handoff waiting indefinitely')
    assert.equal(outcome.error.code, kind === 'cancel' ? 'CANCELLED' : 'LOCAL_GPU_RUNTIME_UNAVAILABLE')
    assert.equal(f.calls[0].signal.aborted, true)
    assert.doesNotMatch(outcome.error.message, /private/)
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0)
  })
})

test('a stalled streamed catalog is cancelled and bounded by the internal request deadline', async () => {
  let cancelled = false, streamController
  const stream = new ReadableStream({ start(controller) { streamController = controller; controller.enqueue(Buffer.from('{"models":')) },
    cancel() { cancelled = true } })
  const f = fixture({ runtime: { requestTimeoutMs: 5 }, fetchImpl: () => new Response(stream) })
  const outcome = await outcomeWithin(f.runtime.prepareModel({ endpoint, model: 'selected/model' }))
  if (!cancelled) { try { streamController.error(new Error('Synthetic cleanup')) } catch {} }
  assert.equal(outcome.status, 'rejected', 'A response body that stops producing bytes must not defeat the deadline')
  assert.equal(outcome.error.code, 'LOCAL_GPU_RUNTIME_UNAVAILABLE')
  assert.equal(cancelled, true, 'Cancel the pending reader rather than leaving a detached body read behind')
})

test('a cancelled unload preserves the selected alias/config for state-checked restoration', async () => {
  const controller = new AbortController(), delayedUnload = deferred()
  const f = fixture({ fetchImpl: (request, state) => {
    if (request.method === 'GET') return response({ models: state.rows })
    if (request.url.endsWith('/unload')) {
      state.rows[0].loaded_instances = [] // Accepted by LM Studio before its response is lost.
      return delayedUnload.promise
    }
    state.rows[0].loaded_instances = [{ id: 'restored-after-cancel', config: request.body }]
    return response({ status: 'loaded', instance_id: 'restored-after-cancel' })
  } })
  const pending = f.runtime.releaseModel({ endpoint, model: 'selected-alias', signal: controller.signal })
  await tickUntil(() => f.calls.some(call => call.url.endsWith('/unload')))
  controller.abort()
  await assert.rejects(pending, error => error.code === 'CANCELLED')
  delayedUnload.resolve(response({ instance_id: 'selected-alias' }))
  assert.deepEqual(await f.runtime.prepareModel({ endpoint, model: 'selected-alias' }), { model: 'restored-after-cancel' })
  const load = f.calls.find(call => call.url.endsWith('/load'))
  assert.equal(load.body.model, 'selected/model'); assert.equal(load.body.context_length, 8192)
  assert.equal(f.calls.filter(call => call.url.endsWith('/unload')).length, 1, 'Cancellation does not repeat the unload')
  assert.equal(f.state.rows[1].loaded_instances[0].id, 'other-instance')
})

test('model loading has its own bounded deadline and does not automatically retry', async () => {
  const delayedLoad = deferred()
  const f = fixture({ rows: [{ ...selected(), loaded_instances: [] }], runtime: { requestTimeoutMs: 1000, loadTimeoutMs: 5 },
    fetchImpl: (request, state) => request.method === 'GET' ? response({ models: state.rows }) : delayedLoad.promise })
  const outcome = await outcomeWithin(f.runtime.prepareModel({ endpoint, model: 'selected/model' }))
  delayedLoad.resolve(response({ status: 'loaded', instance_id: 'late-model' }))
  assert.equal(outcome.status, 'rejected'); assert.equal(outcome.error.code, 'LOCAL_GPU_RUNTIME_UNAVAILABLE')
  const loads = f.calls.filter(call => call.url.endsWith('/load'))
  assert.equal(loads.length, 1); assert.equal(loads[0].signal.aborted, true)
})

test('the pending-model limit rejects before loading another model', async () => {
  const rows = Array.from({ length: 33 }, (_, index) => ({ type: 'llm', key: `model-${index}`,
    loaded_instances: index < 32 ? [{ id: `instance-${index}` }] : [] }))
  const f = fixture({ rows })
  for (let index = 0; index < 32; index++) await f.runtime.prepareModel({ endpoint, model: `model-${index}` })
  await assert.rejects(f.runtime.prepareModel({ endpoint, model: 'model-32' }), error => error.code === 'LOCAL_GPU_RUNTIME_UNAVAILABLE')
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0)
})

test('release and restoration of a known instance never adopt another client replacement with the same weights', async () => {
  const f = fixture()
  await f.runtime.prepareModel({ endpoint, model: 'selected-alias' })
  f.state.rows[0].loaded_instances = [{ id: 'other-client-replacement', config: {} }]
  assert.deepEqual(await f.runtime.releaseModel({ endpoint, model: 'selected-alias' }), { released: true })
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0)
  assert.equal(f.state.rows[0].loaded_instances[0].id, 'other-client-replacement')
  assert.deepEqual(await f.runtime.prepareModel({ endpoint, model: 'selected-alias' }), { model: 'restored-alias' })
  assert.equal(f.calls.find(call => call.url.endsWith('/load')).body.context_length, 8192)
  await f.runtime.releaseModel({ endpoint, model: 'selected-alias' })
  assert.deepEqual(f.calls.filter(call => call.url.endsWith('/unload')).map(call => call.body), [{ instance_id: 'restored-alias' }])
  assert.deepEqual(f.state.rows[0].loaded_instances, [{ id: 'other-client-replacement', config: {} }])
})

test('restoration preserves selected settings with one or several same-weight sibling instances', async t => {
  for (const canonical of [true, false]) for (const siblingCount of [1, 2]) await t.test(`${canonical ? 'canonical' : 'custom alias'} with ${siblingCount} siblings`, async () => {
    const model = canonical ? 'selected/model' : 'selected-alias'
    const config = { context_length: 32768, eval_batch_size: 512, num_experts: 3, flash_attention: true, offload_kv_cache_to_gpu: true }
    const siblings = Array.from({ length: siblingCount }, (_, index) => ({
      id: !canonical && index === 0 ? 'selected/model' : `sibling-${index}`,
      config: { context_length: 8192, eval_batch_size: 128, flash_attention: false, offload_kv_cache_to_gpu: false },
    }))
    const f = fixture({ rows: [{ type: 'llm', key: 'selected/model', loaded_instances: [...structuredClone(siblings), { id: model, config }] }] })
    assert.deepEqual(await f.runtime.prepareModel({ endpoint, model }), { model })
    for (let cycle = 0; cycle < 3; cycle++) {
      await f.runtime.releaseModel({ endpoint, model })
      assert.deepEqual(f.state.rows[0].loaded_instances, siblings)
      assert.deepEqual(await f.runtime.prepareModel({ endpoint, model }), { model: 'restored-alias' })
      assert.deepEqual(f.calls.filter(call => call.url.endsWith('/load')).at(-1).body,
        { model: 'selected/model', ...config, echo_load_config: true })
      assert.deepEqual(f.state.rows[0].loaded_instances.filter(instance => instance.id !== 'restored-alias'), siblings)
    }
    assert.deepEqual(f.calls.filter(call => call.url.endsWith('/unload')).map(call => call.body.instance_id),
      [model, 'restored-alias', 'restored-alias'])
    assert.equal(f.calls.filter(call => call.url.endsWith('/load')).length, 3)
  })
})

test('a load acknowledgement pointing at an existing sibling is not adopted or unloaded', async () => {
  const model = 'selected/model'
  const original = { id: model, config: { context_length: 32768 } }
  const sibling = { id: 'sibling-alias', config: { context_length: 8192 } }
  const f = fixture({ rows: [{ type: 'llm', key: model, loaded_instances: [original, sibling] }], fetchImpl: (request, state) => {
    if (request.method === 'GET') return response({ models: state.rows })
    if (request.url.endsWith('/unload')) {
      state.rows[0].loaded_instances = state.rows[0].loaded_instances.filter(instance => instance.id !== request.body.instance_id)
      return response({ instance_id: request.body.instance_id })
    }
    return response({ status: 'loaded', instance_id: sibling.id })
  } })
  await f.runtime.prepareModel({ endpoint, model })
  await f.runtime.releaseModel({ endpoint, model })
  await assert.rejects(f.runtime.prepareModel({ endpoint, model }), /already loaded instead of restoring/)
  for (const operation of ['prepareModel', 'releaseModel']) {
    await assert.rejects(f.runtime[operation]({ endpoint, model }), /uncertain outcome/)
  }
  assert.equal(f.calls.filter(call => call.url.endsWith('/load')).length, 1)
  assert.deepEqual(f.calls.filter(call => call.url.endsWith('/unload')).map(call => call.body.instance_id), [model])
  assert.deepEqual(f.state.rows[0].loaded_instances, [sibling])
})

test('a reused alias on different weights is not the previously owned model', async () => {
  const f = fixture()
  await f.runtime.prepareModel({ endpoint, model: 'selected-alias' })
  f.state.rows = [{ type: 'llm', key: 'someone-elses/model', loaded_instances: [{ id: 'selected-alias', config: {} }] }]
  try { await f.runtime.releaseModel({ endpoint, model: 'selected-alias' }) } catch (error) { assert.equal(error.code, 'LOCAL_GPU_RUNTIME_UNAVAILABLE') }
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0, 'Alias reuse must not authorize unloading different weights')
  assert.equal(f.state.rows[0].loaded_instances[0].id, 'selected-alias')
})

test('an unconfirmed load cannot be retried or declared released from an empty catalog or a late instance', async () => {
  const delayedLoad = deferred()
  const f = fixture({ rows: [{ ...selected(), loaded_instances: [] }], runtime: { requestTimeoutMs: 1000, loadTimeoutMs: 5 },
    fetchImpl: (request, state) => request.method === 'GET' ? response({ models: state.rows }) : delayedLoad.promise })
  await assert.rejects(f.runtime.prepareModel({ endpoint, model: 'selected/model' }), error => error.code === 'LOCAL_GPU_RUNTIME_UNAVAILABLE')
  for (const operation of ['prepareModel', 'releaseModel']) {
    await assert.rejects(f.runtime[operation]({ endpoint, model: 'selected/model' }), error => {
      assert.equal(error.code, 'LOCAL_GPU_RUNTIME_UNAVAILABLE'); assert.match(error.message, /uncertain outcome/); return true
    })
  }
  f.state.rows[0].loaded_instances = [{ id: 'late-unconfirmed-instance', config: {} }]
  delayedLoad.resolve(response({ status: 'loaded', instance_id: 'late-unconfirmed-instance' }))
  await new Promise(resolve => setImmediate(resolve))
  for (const operation of ['prepareModel', 'releaseModel']) {
    await assert.rejects(f.runtime[operation]({ endpoint, model: 'selected/model' }), error => error.code === 'LOCAL_GPU_RUNTIME_UNAVAILABLE')
  }
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(f.calls.filter(call => call.url.endsWith('/unload')).length, 0)
})

test('a confirmed load ID can be reconciled after its first catalog verification failed', async () => {
  let verificationPending = false
  const f = fixture({ rows: [{ ...selected(), loaded_instances: [] }], fetchImpl: (request, state) => {
    if (request.method === 'GET') {
      if (verificationPending) { verificationPending = false; throw Error('Synthetic catalog unavailable after load') }
      return response({ models: state.rows })
    }
    if (request.url.endsWith('/load')) {
      state.rows[0].loaded_instances = [{ id: 'verified-response-instance', config: {} }]
      verificationPending = true
      return response({ status: 'loaded', instance_id: 'verified-response-instance' })
    }
    state.rows[0].loaded_instances = []
    return response({ instance_id: request.body.instance_id })
  } })
  await assert.rejects(f.runtime.prepareModel({ endpoint, model: 'selected/model' }), error => error.code === 'LOCAL_GPU_RUNTIME_UNAVAILABLE')
  assert.deepEqual(await f.runtime.releaseModel({ endpoint, model: 'selected/model' }), { released: true })
  assert.deepEqual(f.calls.filter(call => call.url.endsWith('/unload')).map(call => call.body), [{ instance_id: 'verified-response-instance' }])
})

test('an opt-in model profile applies context only to a new load and returns the verified alias plus reasoning effort', async () => {
  const f = fixture({ rows: [{ ...selected(), loaded_instances: [] }], runtime: {
    modelProfiles: { 'selected/model': { contextLength: 98304, reasoningEffort: 'low' } },
  } })
  assert.deepEqual(await f.runtime.prepareModel({ endpoint, model: 'selected/model' }), { model: 'restored-alias', reasoningEffort: 'low' })
  assert.deepEqual(f.calls.find(call => call.url.endsWith('/load')).body,
    { model: 'selected/model', context_length: 98304, echo_load_config: true })
  await f.runtime.releaseModel({ endpoint, model: 'selected/model' })
  await f.runtime.prepareModel({ endpoint, model: 'selected/model' })
  assert.equal(f.calls.filter(call => call.url.endsWith('/load')).at(-1).body.context_length, 98304)
})

test('profiles never rewrite an already loaded context or replace its saved reload configuration', async () => {
  const f = fixture({ runtime: { modelProfiles: { 'selected/model': { contextLength: 98304, reasoningEffort: 'low' } } } })
  assert.deepEqual(await f.runtime.prepareModel({ endpoint, model: 'selected-alias' }), { model: 'selected-alias', reasoningEffort: 'low' })
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0, 'There is no claimed live context resize')
  assert.equal(f.state.rows[0].loaded_instances[0].config.context_length, 8192)
  await f.runtime.releaseModel({ endpoint, model: 'selected-alias' })
  assert.deepEqual(await f.runtime.prepareModel({ endpoint, model: 'selected-alias' }), { model: 'restored-alias', reasoningEffort: 'low' })
  assert.equal(f.calls.find(call => call.url.endsWith('/load')).body.context_length, 8192)
})

test('profile defaults are limited to explicitly configured model keys and safe values', async t => {
  const cases = [
    { name: 'different model', profiles: { 'different/model': { contextLength: 98304, reasoningEffort: 'low' } } },
    { name: 'inherited profile', profiles: Object.create({ 'selected/model': { contextLength: 98304, reasoningEffort: 'low' } }) },
    { name: 'invalid configuration', profiles: { 'selected/model': { contextLength: -1, reasoningEffort: 'unsafe-custom-value', apiKey: 'secret' } } },
  ]
  for (const item of cases) await t.test(item.name, async () => {
    const f = fixture({ rows: [{ ...selected(), loaded_instances: [] }], runtime: { modelProfiles: item.profiles } })
    assert.deepEqual(await f.runtime.prepareModel({ endpoint, model: 'selected/model' }), { model: 'restored-alias' })
    assert.deepEqual(f.calls.find(call => call.url.endsWith('/load')).body, { model: 'selected/model', echo_load_config: true })
  })
})
