'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { registerGenerationSpendingIpc, CHANNELS, STATUS_SETTING_KEY, LIMITS } = require('../electron/generationSpending.cjs')
const { createLocalWorkflowTrustStore } = require('../electron/generationLocalWorkflowTrust.cjs')

const localGraph = () => ({ '1': { class_type: 'KSampler', inputs: { seed: 17, steps: 8 } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } } })
const paidGraph = () => ({ '1': { class_type: 'OpenAIGPTImage1', inputs: { prompt: 'Synthetic test only', model: 'gpt-image-1' } } })
const unknownGraph = () => ({ '1': { class_type: 'UnreviewedCustomNode', inputs: {} } })
const objectInfo = { KSampler: { name: 'KSampler', python_module: 'nodes' }, SaveImage: { name: 'SaveImage', python_module: 'nodes' },
  OpenAIGPTImage1: { name: 'OpenAIGPTImage1', python_module: 'comfy_api_nodes.nodes_openai', api_node: true } }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)) }
  assert.fail('Fixture did not reach the expected pending state')
}

function fixture(options = {}) {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  const window = { webContents: contents, isDestroyed: () => false }
  const state = { policy: undefined, endpoint: 'http://127.0.0.1:8188', context: { session: 'session-1', projectKey: '/synthetic/project', timelineId: 'timeline-1' },
    window, key: 'sk-test-never-public-secret', available: true, ...options.state }
  const events = [], calls = [], confirmations = [], policyConfirmations = [], writes = [], handlers = new Map()
  contents.send = (...args) => events.push(args)
  const event = { sender: contents, senderFrame: contents.mainFrame }
  let keyReads = 0; let requestSequence = 0
  const dependencies = {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    getMainWindow: () => state.window,
    readPolicy: () => state.policy,
    writePolicy: policy => { writes.push(policy); state.policy = policy },
    getEndpoint: () => state.endpoint,
    getContext: () => ({ ...state.context }),
    getApiKey: async () => { keyReads++; return options.getApiKey ? options.getApiKey(state) : state.key },
    confirmPolicyChange: async input => { policyConfirmations.push(input); return options.confirmPolicyChange ? options.confirmPolicyChange(input, state) : true },
    confirmSpend: async input => { confirmations.push(input); return options.confirmSpend ? options.confirmSpend(input, state) : true },
    assertAvailable: () => { if (!state.available) throw new Error('Synthetic export active') },
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (options.fetchImpl) return options.fetchImpl(url, init, state)
      return url.endsWith('/object_info') ? jsonResponse(objectInfo) : jsonResponse({ prompt_id: 'synthetic-prompt-id', number: 0, node_errors: {} })
    },
    ...options.dependencies,
  }
  const controller = registerGenerationSpendingIpc(dependencies)
  const invoke = (name, payload, sender = event) => handlers.get(CHANNELS[name])(sender, payload)
  const request = (workflow = localGraph(), extra = {}) => ({ requestId: `synthetic-request-${++requestSequence}`, endpoint: state.endpoint, clientId: 'synthetic-client', workflow, ...extra })
  return { state, event, window, contents, events, calls, confirmations, policyConfirmations, writes, controller, handlers, invoke, request,
    get keyReads() { return keyReads }, get posts() { return calls.filter(call => call.init.method === 'POST') } }
}
const code = (result, expected) => { assert.equal(result.success, false); assert.equal(result.code, `GENERATION_SPENDING_${expected}`) }

function trustedFixture(options = {}) {
  const state = { store: null, revision: 'a'.repeat(64), source: { '1': { class_type: 'UnreviewedCustomNode', inputs: { prompt: 'synthetic private', seed: 1, model: 'local.safetensors' } } },
    metadata: { UnreviewedCustomNode: { name: 'UnreviewedCustomNode', python_module: 'custom_nodes.synthetic', api_node: false } } }
  const trust = () => createLocalWorkflowTrustStore({ readStore: () => state.store, writeStore: (value, authority) => {
    if (authority.signal.aborted || !authority.isCurrent()) throw new Error('Stale synthetic authority')
    state.store = structuredClone(value)
  } })
  const saved = () => ({ success: true, ready: true, workflowId: 'my-workflow:synthetic', title: 'Synthetic local workflow',
    graphFingerprint: state.revision, workflow: structuredClone(state.source) })
  const f = fixture({ state: { policy: 'ask-cloud' }, confirmSpend: options.confirmSpend || (() => ({ approved: true, trustLocal: true })),
    fetchImpl: async url => url.endsWith('/object_info') ? jsonResponse(state.metadata) : jsonResponse({ prompt_id: 'synthetic-prompt' }),
    ...options, dependencies: { localWorkflowTrust: trust(), resolveSavedWorkflow: saved, ...options.dependencies } })
  return { ...f, localState: state, trust, saved,
    savedRequest: (extra = {}) => f.request(structuredClone(state.source), { savedWorkflowId: 'my-workflow:synthetic', ...extra }),
    // Spread copies getters, so expose the live counters again.
    get keyReads() { return f.keyReads }, get posts() { return f.posts } }
}

test('Local only reviews and remembers an unfamiliar saved workflow without changing policy or releasing a cloud key', async () => {
  const f = trustedFixture({ state: { policy: 'local-only' } })
  const first = f.savedRequest()
  const result = await f.invoke('queue', first)
  assert.equal(result.success, true)
  assert.equal(f.confirmations.length, 1)
  assert.equal(f.confirmations[0].policy, 'local-only')
  assert.equal(f.confirmations[0].localTrust.eligible, true)
  assert.deepEqual(f.confirmations[0].assessment.unknownNodes, [{ id: '1', classType: 'UnreviewedCustomNode' }])
  assert.equal(f.state.policy, 'local-only'); assert.equal(f.writes.length, 0)
  assert.equal(f.policyConfirmations.length, 0); assert.equal(f.keyReads, 0)
  assert.equal(f.posts.length, 1); assert.equal(JSON.parse(f.posts[0].init.body).extra_data, undefined)
  code(await f.invoke('queue', first), 'DUPLICATE_REQUEST')
  const second = f.savedRequest(); second.workflow['1'].inputs.seed = 65
  assert.equal((await f.invoke('queue', second)).success, true)
  assert.equal(f.confirmations.length, 1); assert.equal(f.posts.length, 2)
  assert.equal(f.keyReads, 0)
})

test('Local only never interprets Cancel, generic approval or forged trust as permission to run', async () => {
  for (const answer of [false, true, null, { approved: true }, { approved: true, trustLocal: 'true' }, { approved: true, trustLocal: true, extra: 'unexpected' }]) {
    const f = trustedFixture({ state: { policy: 'local-only' }, confirmSpend: () => answer })
    const result = await f.invoke('queue', f.savedRequest())
    code(result, 'DENIED')
    assert.equal(result.submissionState, 'not-started')
    assert.equal(f.posts.length, 0); assert.equal(f.keyReads, 0)
    assert.equal(f.localState.store, null); assert.equal(f.writes.length, 0)
  }
})

test('Local only explains unpersisted or changed configurations instead of misidentifying unknown nodes as paid', async () => {
  const f = trustedFixture({ state: { policy: 'local-only' } })
  const unsaved = await f.invoke('queue', f.request(unknownGraph()))
  code(unsaved, 'LOCAL_ONLY')
  assert.match(unsaved.error, /UnreviewedCustomNode/)
  assert.match(unsaved.error, /Unrecognized does not mean paid/)
  assert.match(unsaved.error, /Save this workflow/)
  const request = f.savedRequest(); request.workflow['1'].inputs.model = 'changed.safetensors'
  const changed = await f.invoke('queue', request)
  code(changed, 'LOCAL_ONLY'); assert.match(changed.error, /Save the revised workflow/)
  assert.equal(f.confirmations.length, 0); assert.equal(f.posts.length, 0); assert.equal(f.keyReads, 0)
})

test('Local only keeps paid or mixed workflows blocked even after remembered trust', async () => {
  const f = trustedFixture({ state: { policy: 'local-only' } })
  await f.invoke('queue', f.savedRequest())
  for (const metadata of [{ api_node: true }, { price_badge: 0 }, { python_module: 'comfy_api_nodes.new_provider' }]) {
    f.localState.metadata.UnreviewedCustomNode = { name: 'UnreviewedCustomNode', python_module: 'custom_nodes.synthetic', ...metadata }
    const result = await f.invoke('queue', f.savedRequest())
    code(result, 'LOCAL_ONLY'); assert.match(result.error, /cloud\/API or pricing evidence/)
    assert.equal(f.posts.length, 1); assert.equal(f.keyReads, 0); assert.equal(f.confirmations.length, 1)
  }
})

test('revoking or changing local trust asks again; cancellation never falls back to paid approval', async () => {
  let answer = { approved: true, trustLocal: true }
  const f = trustedFixture({ state: { policy: 'local-only' }, confirmSpend: () => answer })
  await f.invoke('queue', f.savedRequest())
  const status = await f.invoke('status')
  await f.invoke('revokeLocalTrust', { id: status.localTrustedWorkflows[0].id })
  answer = false
  code(await f.invoke('queue', f.savedRequest()), 'DENIED')
  assert.equal(f.confirmations.length, 2); assert.equal(f.posts.length, 1)
  answer = { approved: true, trustLocal: true }
  await f.invoke('queue', f.savedRequest())
  f.localState.metadata.UnreviewedCustomNode.python_module = 'custom_nodes.new_version'
  answer = false
  code(await f.invoke('queue', f.savedRequest()), 'DENIED')
  assert.equal(f.confirmations.length, 4); assert.equal(f.posts.length, 2); assert.equal(f.keyReads, 0)
})

test('cancelling or losing context while the Local only review is open grants nothing and submits nothing', async () => {
  for (const change of ['cancel', 'policy', 'project', 'source']) {
    const gate = deferred()
    const f = trustedFixture({ state: { policy: 'local-only' }, confirmSpend: () => gate.promise })
    const request = f.savedRequest(), pending = f.invoke('queue', request)
    await until(() => f.confirmations.length === 1)
    if (change === 'cancel') await f.invoke('cancel', { requestId: request.requestId })
    if (change === 'policy') f.state.policy = 'ask-cloud'
    if (change === 'project') f.state.context.projectKey = '/different/project'
    if (change === 'source') f.localState.revision = 'f'.repeat(64)
    gate.resolve({ approved: true, trustLocal: true })
    assert.equal((await pending).success, false, change)
    assert.equal(f.posts.length, 0); assert.equal(f.keyReads, 0); assert.equal(f.localState.store, null)
  }
})

test('unknown saved workflow is remembered once across creative overrides and records user trust without cloud credentials', async () => {
  const receipts = []
  const f = trustedFixture({ dependencies: { beforeSubmit: receipt => receipts.push(receipt) } })
  assert.equal((await f.invoke('queue', f.savedRequest())).success, true)
  assert.equal(f.confirmations.length, 1)
  assert.equal(f.confirmations[0].localTrust.eligible, true)
  assert.equal(receipts[0].assessment.risk, 'unknown')
  assert.equal(receipts[0].assessment.userTrustedLocal, true)
  assert.match(receipts[0].assessment.note, /not verification/)
  const next = f.savedRequest()
  next.workflow['1'].inputs.prompt = 'another private prompt'
  next.workflow['1'].inputs.seed = 99
  f.state.policy = 'local-only'
  assert.equal((await f.invoke('queue', next)).success, true)
  assert.equal(f.confirmations.length, 1)
  assert.equal(f.keyReads, 0)
  assert.equal(f.posts.length, 2)
  assert.equal(JSON.parse(f.posts[0].init.body).extra_data, undefined)
  const status = await f.invoke('status')
  assert.equal(status.localTrustedWorkflows.length, 1)
  assert.equal(JSON.stringify(status).includes('synthetic private'), false)
  assert.equal((await f.trust().list()).length, 1)
  assert.equal((await f.invoke('revokeLocalTrust', { id: status.localTrustedWorkflows[0].id })).success, true)
  f.state.policy = 'ask-cloud'
  assert.equal((await f.invoke('queue', f.savedRequest())).success, true)
  assert.equal(f.confirmations.length, 2)
})

test('saved revision, configured connection and live node identity changes each request a new local choice', async () => {
  const f = trustedFixture()
  await f.invoke('queue', f.savedRequest())
  for (const change of [
    () => { f.localState.revision = 'b'.repeat(64) },
    () => { f.state.endpoint = 'http://127.0.0.1:8189' },
    () => { f.localState.metadata.UnreviewedCustomNode.python_module = 'custom_nodes.changed' },
  ]) { change(); assert.equal((await f.invoke('queue', f.savedRequest())).success, true) }
  assert.equal(f.confirmations.length, 4)
})

test('known paid evidence never borrows saved local trust or accepts the trust-local decision', async () => {
  const f = trustedFixture()
  await f.invoke('queue', f.savedRequest())
  f.localState.metadata.UnreviewedCustomNode.api_node = true
  code(await f.invoke('queue', f.savedRequest()), 'DENIED')
  assert.equal(f.confirmations.length, 2)
  assert.equal(f.confirmations[1].assessment.risk, 'paid')
  assert.equal(f.confirmations[1].localTrust.eligible, false)
  assert.equal(f.posts.length, 1)
  assert.equal(f.keyReads, 0)
})

test('inline or altered saved models cannot be remembered, while ordinary approve-once remains supported', async () => {
  const f = trustedFixture()
  code(await f.invoke('queue', f.request(unknownGraph())), 'DENIED')
  const changed = f.savedRequest(); changed.workflow['1'].inputs.model = 'another-model'
  code(await f.invoke('queue', changed), 'DENIED')
  assert.equal(f.localState.store, null)
  assert.equal(f.confirmations.every(value => !value.localTrust.eligible), true)
  const once = trustedFixture({ confirmSpend: () => true })
  assert.equal((await once.invoke('queue', once.savedRequest())).success, true)
  assert.equal((await once.invoke('queue', once.savedRequest())).success, true)
  assert.equal(once.confirmations.length, 2)
  assert.equal(once.localState.store, null)
})

test('source changes during a trust confirmation block persistence and submission', async () => {
  const decision = deferred(), f = trustedFixture({ confirmSpend: () => decision.promise })
  const pending = f.invoke('queue', f.savedRequest())
  await until(() => f.confirmations.length === 1)
  f.localState.revision = 'b'.repeat(64)
  decision.resolve({ approved: true, trustLocal: true })
  code(await pending, 'STALE_CONTEXT')
  assert.equal(f.localState.store, null)
  assert.equal(f.posts.length, 0)
})

test('native phone bundle consent sets ask-cloud without another dialog, never grants a generation', async () => {
  const f = fixture()
  assert.equal((await f.controller.enableAskCloudFromConsent({ window: f.window, isCurrent: () => true })).policy, 'ask-cloud')
  assert.equal(f.policyConfirmations.length, 0)
  assert.equal(f.confirmations.length, 0)
  assert.equal(f.posts.length, 0)
  code(await f.controller.enableAskCloudFromConsent({ window: f.window, isCurrent: () => false }), 'UNAUTHORIZED')
  assert.equal(f.writes.length, 1)
  await f.invoke('queue', f.request(paidGraph()))
  assert.equal(f.confirmations.length, 1)
})

test('remembered source changing during ledger preparation cannot submit even after an earlier local decision', async () => {
  let change = false
  const f = trustedFixture({ dependencies: { beforeSubmit: () => { if (change) f.localState.revision = 'b'.repeat(64) } } })
  await f.invoke('queue', f.savedRequest())
  change = true
  code(await f.invoke('queue', f.savedRequest()), 'STALE_CONTEXT')
  assert.equal(f.posts.length, 1)
})

test('phone consent cannot commit a delayed ask-cloud write after its authority is lost', async () => {
  const gate = deferred(); let current = true, authority, committed = false
  const f = fixture({ dependencies: { writePolicy: async (_policy, value) => {
    authority = value
    await gate.promise
    if (!authority.isCurrent()) throw new Error('Synthetic consent expired')
    committed = true
  } } })
  const pending = f.controller.enableAskCloudFromConsent({ window: f.window, isCurrent: () => current })
  await until(() => Boolean(authority))
  current = false; gate.resolve()
  assert.equal((await pending).success, false)
  assert.equal(committed, false)
  assert.equal(f.posts.length, 0)
})

test('status defaults to local-only, documents app-managed scope, and ignores invalid persisted policy', async () => {
  const f = fixture()
  assert.equal(STATUS_SETTING_KEY, 'generationSpendingPolicy')
  for (const stored of [undefined, null, 'allow-all', true, { policy: 'ask-cloud' }]) {
    f.state.policy = stored
    assert.deepEqual(await f.invoke('status'), { success: true, policy: 'local-only', scope: 'velorn-managed', busy: false,
      enforcement: 'app-managed-queue-only', externalAccessCovered: false })
  }
  f.state.policy = 'ask-cloud'
  assert.equal((await f.controller.getStatus()).policy, 'ask-cloud')
})

test('relaxing the policy requires native confirmation and emits the persisted status', async () => {
  const f = fixture()
  const result = await f.invoke('setPolicy', { policy: 'ask-cloud' })
  assert.equal(result.policy, 'ask-cloud')
  assert.equal(f.policyConfirmations.length, 1)
  assert.equal(f.policyConfirmations[0].window, f.window)
  assert.deepEqual(f.writes, ['ask-cloud'])
  assert.deepEqual(f.events, [[CHANNELS.changed, result]])
  assert.equal(result.busy, false)
  assert.equal((await f.invoke('setPolicy', { policy: 'local-only' })).policy, 'local-only')
  assert.equal(f.policyConfirmations.length, 1)
})

test('policy denial, missing native dialog, and model approval flags do not relax the policy', async () => {
  const f = fixture({ confirmPolicyChange: () => false })
  const result = await f.invoke('setPolicy', { policy: 'ask-cloud' })
  assert.equal(result.success, true)
  assert.equal(result.cancelled, true)
  assert.equal(result.policy, 'local-only')
  assert.equal(result.busy, false)
  code(await f.invoke('setPolicy', { policy: 'ask-cloud', approved: true }), 'INVALID_REQUEST')
  code(await fixture({ dependencies: { confirmPolicyChange: undefined } }).invoke('setPolicy', { policy: 'ask-cloud' }), 'UNAVAILABLE')
  assert.equal(f.writes.length, 0)
  assert.equal(f.events.length, 0)
})

test('local-only rejects paid and unsaved unknown graphs with zero key reads and zero POSTs', async () => {
  for (const graph of [paidGraph(), unknownGraph()]) {
    const f = fixture()
    const request = f.request(graph)
    code(await f.invoke('queue', request), 'LOCAL_ONLY')
    code(await f.invoke('queue', request), 'DUPLICATE_REQUEST')
    assert.equal(f.keyReads, 0)
    assert.equal(f.posts.length, 0)
    assert.equal(f.confirmations.length, 0)
  }
})

test('known local graph submits exact graph without partner credentials or a spending dialog in either policy', async () => {
  for (const policy of ['local-only', 'ask-cloud']) {
    const f = fixture({ state: { policy } })
    const graph = localGraph()
    const result = await f.invoke('queue', f.request(graph))
    assert.equal(result.success, true)
    assert.equal(result.status, 200)
    assert.equal(result.body.prompt_id, 'synthetic-prompt-id')
    assert.equal(f.posts.length, 1)
    assert.deepEqual(JSON.parse(f.posts[0].init.body), { prompt: graph, client_id: 'synthetic-client' })
    assert.equal(f.keyReads, 0)
    assert.equal(f.confirmations.length, 0)
    assert.ok(f.calls.every(call => call.init.redirect === 'error'))
  }
})

test('native run-ledger hooks receive the verified graph before POST and a final result afterward', async () => {
  const before = [], after = []
  let durableReceipt = false
  const f = fixture({ dependencies: {
    beforeSubmit: async detail => { before.push(detail); durableReceipt = true },
    afterSubmit: async detail => { after.push(detail) },
  }, fetchImpl: async (url, init) => {
    if (url.endsWith('/object_info')) return jsonResponse(objectInfo)
    assert.equal(init.method, 'POST')
    assert.equal(durableReceipt, true, 'The durable ledger hook must finish before the sole prompt POST')
    return jsonResponse({ prompt_id: 'hooked-prompt-id' })
  } })
  const payload = f.request()
  const result = await f.invoke('queue', payload)
  assert.equal(result.success, true)
  assert.equal(before.length, 1)
  assert.equal(after.length, 1)
  assert.equal(before[0].requestId, payload.requestId)
  assert.deepEqual(before[0].workflow, payload.workflow)
  assert.match(before[0].fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(before[0].endpoint, f.state.endpoint)
  assert.equal(before[0].clientId, payload.clientId)
  assert.equal(before[0].context, JSON.stringify(['session-1', '/synthetic/project', 'timeline-1']))
  assert.equal(before[0].assessment.risk, 'local')
  assert.deepEqual(after[0], { requestId: payload.requestId, result })
})

test('a failed pre-submit ledger hook blocks POST, while an after-submit bookkeeping failure never retries', async () => {
  const ledgerFailure = Object.assign(new Error('Synthetic durable ledger failure'), {
    code: 'GENERATION_RUNS_STORAGE_UNAVAILABLE', publicMessage: 'Generation-run storage could not be saved.',
  })
  const blocked = fixture({ dependencies: { beforeSubmit: async () => { throw ledgerFailure } } })
  const blockedResult = await blocked.invoke('queue', blocked.request())
  assert.equal(blockedResult.success, false)
  assert.equal(blockedResult.code, 'GENERATION_RUNS_STORAGE_UNAVAILABLE')
  assert.equal(blocked.posts.length, 0)

  let afterCalls = 0
  const completed = fixture({ dependencies: { afterSubmit: async () => { afterCalls++; throw new Error('Synthetic post-POST storage failure') } } })
  const completedResult = await completed.invoke('queue', completed.request())
  assert.equal(completedResult.success, true)
  assert.equal(completed.posts.length, 1)
  assert.equal(afterCalls, 1)
})

test('GPU handoff waits for spending approval and completes before the durable ledger and sole POST', async () => {
  const approval = deferred(), gpu = deferred(), order = [], after = [], lease = Object.freeze({ id: 'gpu-lease' })
  let resourceInput
  const f = fixture({ state: { policy: 'ask-cloud' }, confirmSpend: async () => { order.push('approval'); return approval.promise },
    dependencies: {
      generationResources: {
        beforeGeneration: input => { order.push('gpu'); resourceInput = input; return gpu.promise },
        afterGeneration: input => { order.push('gpu-result'); after.push(input) },
      },
      beforeSubmit: () => { order.push('ledger-before') },
      afterSubmit: () => { order.push('ledger-after') },
    }, fetchImpl: async url => {
      if (url.endsWith('/object_info')) return jsonResponse(objectInfo)
      order.push('post'); return jsonResponse({ prompt_id: 'gpu-prompt' })
    } })
  const pending = f.invoke('queue', f.request(paidGraph()))
  await until(() => f.confirmations.length === 1)
  assert.deepEqual(order, ['approval']); assert.equal(f.posts.length, 0)
  approval.resolve(true)
  await until(() => resourceInput)
  assert.equal(resourceInput.endpoint, f.state.endpoint); assert.equal(resourceInput.signal.aborted, false)
  assert.deepEqual(order, ['approval', 'gpu']); assert.equal(f.posts.length, 0)
  gpu.resolve(lease)
  const result = await pending
  assert.equal(result.body.prompt_id, 'gpu-prompt')
  assert.deepEqual(order, ['approval', 'gpu', 'ledger-before', 'post', 'gpu-result', 'ledger-after'])
  assert.deepEqual(after, [{ lease, result, postStarted: true }])
  assert.equal(f.posts.length, 1)
})

test('blocked or denied spending never acquires GPU resources', async () => {
  for (const options of [{}, { state: { policy: 'ask-cloud' }, confirmSpend: () => false }]) {
    let acquisitions = 0, releases = 0
    const f = fixture({ ...options, dependencies: { generationResources: {
      beforeGeneration: () => { acquisitions++ }, afterGeneration: () => { releases++ },
    } } })
    code(await f.invoke('queue', f.request(paidGraph())), options.state ? 'DENIED' : 'LOCAL_ONLY')
    assert.equal(acquisitions, 0); assert.equal(releases, 0); assert.equal(f.posts.length, 0)
  }
})

test('GPU acquisition errors are safe LOCAL_GPU failures and cannot create a submitting ledger or POST', async () => {
  const released = [], ledger = []
  const f = fixture({ dependencies: {
    generationResources: {
      beforeGeneration: () => { throw Object.assign(new Error('/private/model password=secret'), { publicMessage: '/private/token', code: 'UNTRUSTED' }) },
      afterGeneration: detail => released.push(detail),
    }, beforeSubmit: detail => ledger.push(detail),
  } })
  const result = await f.invoke('queue', f.request())
  code(result, 'LOCAL_GPU'); assert.equal(result.submissionState, 'not-started')
  assert.match(result.error, /No generation was submitted/); assert.doesNotMatch(JSON.stringify(result), /private|password|secret|UNTRUSTED/)
  assert.equal(f.posts.length, 0); assert.equal(ledger.length, 0)
  assert.deepEqual(released, [{ lease: undefined, result, postStarted: false }])
})

test('GPU wait cancellation, navigation and timeout abort acquisition and notify exactly once without POST', async t => {
  for (const reason of ['cancel', 'navigation', 'timeout']) await t.test(reason, async () => {
    let input
    const released = []
    const f = fixture({ dependencies: { resourceTimeoutMs: reason === 'timeout' ? 5 : 1000, generationResources: {
      beforeGeneration: value => { input = value; return new Promise(() => {}) },
      afterGeneration: value => released.push(value),
    } } })
    const payload = f.request(), pending = f.invoke('queue', payload)
    await until(() => input)
    if (reason === 'cancel') await f.invoke('cancel', { requestId: payload.requestId })
    else if (reason === 'navigation') f.contents.emit('did-start-navigation', {}, 'file:///new-editor', false, true)
    const result = await pending
    code(result, reason === 'timeout' ? 'LOCAL_GPU' : 'CANCELLED')
    assert.equal(input.signal.aborted, true); assert.equal(f.posts.length, 0)
    assert.equal(released.length, 1); assert.equal(released[0].postStarted, false); assert.equal(released[0].result, result)
    assert.equal((await f.controller.getStatus()).busy, false)
    code(await f.invoke('queue', payload), 'DUPLICATE_REQUEST')
  })
})

test('a changed context or failed pre-submit ledger returns an acquired GPU lease without sending a prompt', async t => {
  for (const scenario of ['project', 'policy', 'endpoint', 'window', 'availability', 'ledger']) await t.test(scenario, async () => {
    const gate = deferred(), lease = { id: scenario }, released = []
    let acquiring = false
    const f = fixture({ dependencies: {
      generationResources: { beforeGeneration: () => { acquiring = true; return gate.promise }, afterGeneration: detail => released.push(detail) },
      beforeSubmit: () => { if (scenario === 'ledger') throw Error('Synthetic ledger failure') },
    } })
    const pending = f.invoke('queue', f.request())
    await until(() => acquiring)
    if (scenario === 'project') f.state.context.projectKey = '/synthetic/changed'
    if (scenario === 'policy') f.state.policy = 'ask-cloud'
    if (scenario === 'endpoint') f.state.endpoint = 'http://127.0.0.1:8190'
    if (scenario === 'window') f.state.window = { ...f.window }
    if (scenario === 'availability') f.state.available = false
    gate.resolve(lease)
    const result = await pending
    code(result, ['availability', 'ledger'].includes(scenario) ? 'UNAVAILABLE' : 'STALE_CONTEXT')
    assert.deepEqual(released, [{ lease, result, postStarted: false }]); assert.equal(f.posts.length, 0)
  })
})

test('GPU result handoff receives HTTP rejection or uncertain submission exactly once without retrying', async t => {
  for (const scenario of ['validation', 'network', 'cancel']) await t.test(scenario, async () => {
    const released = [], lease = { id: scenario }, pendingPost = deferred()
    const f = fixture({ dependencies: { generationResources: {
      beforeGeneration: () => lease, afterGeneration: detail => released.push(detail),
    } }, fetchImpl: async url => {
      if (url.endsWith('/object_info')) return jsonResponse(objectInfo)
      if (scenario === 'validation') return jsonResponse({ error: 'Synthetic invalid workflow' }, 400)
      if (scenario === 'network') throw Error('Synthetic failed response after POST')
      return pendingPost.promise
    } })
    const payload = f.request(), pending = f.invoke('queue', payload)
    if (scenario === 'cancel') {
      await until(() => f.posts.length === 1)
      await f.invoke('cancel', { requestId: payload.requestId })
    }
    const result = await pending
    if (scenario === 'validation') { assert.equal(result.success, true); assert.equal(result.ok, false); assert.equal(result.status, 400) }
    else { code(result, 'SUBMISSION_UNCERTAIN'); assert.equal(result.submissionState, 'unknown'); assert.equal(result.retryAllowed, false) }
    assert.deepEqual(released, [{ lease, result, postStarted: true }]); assert.equal(f.posts.length, 1)
    code(await f.invoke('queue', payload), 'DUPLICATE_REQUEST')
    if (scenario === 'cancel') pendingPost.resolve(jsonResponse({ prompt_id: 'late-prompt' }))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(released.length, 1, 'A late POST completion does not produce another resource handoff')
  })
})

test('GPU result hook failure preserves the true POST outcome and reports only a safe resource warning', async () => {
  for (const postFails of [false, true]) {
    let releases = 0
    const f = fixture({ dependencies: { generationResources: {
      beforeGeneration: () => ({ id: 'held' }),
      afterGeneration: () => { releases++; throw Error('secret /private/model path') },
    } }, fetchImpl: async url => {
      if (url.endsWith('/object_info')) return jsonResponse(objectInfo)
      if (postFails) throw Error('Uncertain prompt response')
      return jsonResponse({ prompt_id: 'confirmed-prompt' })
    } })
    const result = await f.invoke('queue', f.request())
    assert.equal(result.success, !postFails)
    if (postFails) assert.equal(result.submissionState, 'unknown')
    else assert.equal(result.body.prompt_id, 'confirmed-prompt')
    assert.equal(result.resourceWarning.code, 'GENERATION_SPENDING_LOCAL_GPU')
    assert.doesNotMatch(JSON.stringify(result), /private|secret/)
    assert.equal(releases, 1); assert.equal(f.posts.length, 1)
  }
})

test('GPU ownership handoff is bounded and a late completion never repeats the notification or POST', async () => {
  const handoff = deferred()
  let releases = 0
  const f = fixture({ dependencies: { contextTimeoutMs: 10, generationResources: {
    beforeGeneration: () => ({ id: 'held' }),
    afterGeneration: () => { releases++; return handoff.promise },
  } } })
  const result = await f.invoke('queue', f.request())
  assert.equal(result.success, true); assert.equal(result.body.prompt_id, 'synthetic-prompt-id')
  assert.equal(result.resourceWarning.code, 'GENERATION_SPENDING_LOCAL_GPU')
  assert.equal(releases, 1); assert.equal(f.posts.length, 1); assert.equal((await f.controller.getStatus()).busy, false)
  handoff.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(releases, 1); assert.equal(f.posts.length, 1)
})

test('an incomplete GPU coordinator cannot unload or submit without a paired result hook', async () => {
  let acquisitions = 0
  const f = fixture({ dependencies: { generationResources: { beforeGeneration: () => { acquisitions++ } } } })
  code(await f.invoke('queue', f.request()), 'LOCAL_GPU')
  assert.equal(acquisitions, 0); assert.equal(f.posts.length, 0)
})

test('native-only queueFromMain uses the same verified main-frame policy path', async () => {
  const f = fixture()
  const result = await f.controller.queueFromMain(f.request())
  assert.equal(result.success, true)
  assert.equal(f.posts.length, 1)
  f.state.window = null
  const unavailable = await f.controller.queueFromMain(f.request())
  code(unavailable, 'UNAUTHORIZED')
})

test('one approval binds one immutable graph, endpoint and fingerprint, never grants future submissions', async () => {
  const gate = deferred()
  const f = fixture({ state: { policy: 'ask-cloud' }, confirmSpend: () => gate.promise })
  const graph = paidGraph(), original = structuredClone(graph)
  const payload = f.request(graph)
  const pending = f.invoke('queue', payload)
  await until(() => f.confirmations.length === 1)
  graph['1'].inputs.prompt = 'Changed after opening dialog'
  payload.clientId = 'changed-client'
  const consent = f.confirmations[0]
  assert.equal(consent.submissionCount, 1)
  assert.equal(consent.endpoint, f.state.endpoint)
  assert.match(consent.fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(consent.assessment.risk, 'paid')
  assert.equal(consent.assessment.estimatedCredits, null)
  assert.ok(Object.isFrozen(consent.assessment))
  assert.ok(Object.isFrozen(consent.assessment.paidNodes))
  assert.equal(f.keyReads, 0)
  assert.equal(f.posts.length, 0)
  gate.resolve(true)
  assert.equal((await pending).success, true)
  const posted = JSON.parse(f.posts[0].init.body)
  assert.deepEqual(posted.prompt, original)
  assert.equal(posted.client_id, 'synthetic-client')
  assert.equal(posted.extra_data.api_key_comfy_org, f.state.key)
  assert.equal(f.keyReads, 1)
  await f.invoke('queue', f.request(paidGraph()))
  assert.equal(f.confirmations.length, 2)
  assert.equal(f.posts.length, 2)
})

for (const approve of [false, true]) test(`MCP unknown saved-workflow apply opens approval without pre-recorded consent; answer=${approve}`, async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
  const { createGenerationRuns } = require('../electron/generationRuns.cjs')
  const { prepareApiGraph } = require('../electron/savedWorkflowLibrary.cjs')
  const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-approval-handoff-'))
  const gate = deferred(); let manager
  const f = fixture({ state: { policy: 'ask-cloud', key: null }, confirmSpend: () => gate.promise,
    dependencies: { beforeSubmit: detail => manager.beforeSubmit(detail), afterSubmit: detail => manager.afterSubmit(detail) } })
  manager = createGenerationRuns({ storageDir, getContext: () => f.state.context, getEndpoint: () => f.state.endpoint,
    submitManaged: args => f.controller.queueFromMain(args),
    resolveSavedWorkflow: args => prepareApiGraph(unknownGraph(), args),
    fetchImpl: async () => jsonResponse({ queue_running: [], queue_pending: [] }),
  })
  t.after(async () => { gate.resolve(false); manager.dispose(); f.controller.dispose(); await fs.rm(storageDir, { recursive: true, force: true }) })
  const server = createComfyStudioMcpServer({ generationRuns: manager, getGenerationSpendingStatus: () => f.controller.getStatus() })
  server.updateSnapshot({ project: { name: 'Synthetic', path: '/synthetic/project' }, currentTimeline: { id: 'timeline-1', clips: [], tracks: [] }, assets: [] })
  const args = { workflowId: 'my-workflow:synthetic' }
  const status = await server.callTool('get_generation_status', {})
  assert.equal(JSON.parse(status.content[0].text).generationSpending.approvalTrigger, 'managed-submit')
  const preview = JSON.parse((await server.callTool('queue_comfyui_workflow', args)).content[0].text)
  assert.equal(preview.success, true); assert.equal(f.confirmations.length, 0); assert.equal(f.posts.length, 0)
  const pending = server.callTool('queue_comfyui_workflow', { ...args, ...preview.suggestedApplyPayload })
  await until(() => f.confirmations.length === 1)
  assert.equal(f.confirmations[0].assessment.risk, 'unknown')
  assert.equal(f.posts.length, 0, 'An apply requests approval, not an unconditional POST')
  gate.resolve(approve)
  const result = JSON.parse((await pending).content[0].text)
  assert.equal(result.success, approve, JSON.stringify(result))
  assert.equal(f.posts.length, approve ? 1 : 0)
  assert.equal(f.writes.length, 0, 'No spending-policy change is needed')
  if (!approve) assert.equal(result.code, 'GENERATION_SPENDING_DENIED')
})

test('denied or missing native spending confirmation never reads a key or POSTs', async () => {
  for (const options of [{ confirmSpend: () => false }, { dependencies: { confirmSpend: undefined } }]) {
    const f = fixture({ state: { policy: 'ask-cloud' }, ...options })
    const payload = f.request(paidGraph())
    code(await f.invoke('queue', payload), options.confirmSpend ? 'DENIED' : 'UNAVAILABLE')
    code(await f.invoke('queue', payload), 'DUPLICATE_REQUEST')
    assert.equal(f.keyReads, 0)
    assert.equal(f.posts.length, 0)
  }
})

test('renderer claims of approval, pricing, route, risk or metadata are rejected', async () => {
  for (const key of ['approved', 'allowPaid', 'fullAccess', 'route', 'risk', 'price', 'objectInfo', 'extra_data', 'apiKey']) {
    const f = fixture({ state: { policy: 'ask-cloud' } })
    code(await f.invoke('queue', f.request(paidGraph(), { [key]: true })), 'INVALID_REQUEST')
    assert.equal(f.calls.length, 0)
    assert.equal(f.keyReads, 0)
  }
})

test('all IPC channels reject foreign windows and child frames', async () => {
  const f = fixture()
  const payloads = { status: undefined, setPolicy: { policy: 'ask-cloud' }, queue: f.request(), cancel: { requestId: 'synthetic-request-1' } }
  for (const sender of [{ sender: Object.assign(new EventEmitter(), { isDestroyed: () => false }), senderFrame: {} },
    { sender: f.contents, senderFrame: {} }, { sender: f.contents }, null]) {
    for (const [name, payload] of Object.entries(payloads)) code(await f.invoke(name, payload, sender), 'UNAUTHORIZED')
  }
  assert.equal(f.calls.length, 0)
  assert.equal(f.writes.length, 0)
})

test('only the configured loopback origin can receive metadata and prompts', async () => {
  for (const endpoint of ['http://example.com:8188', 'https://127.0.0.1.evil.test:8188', 'file:///tmp/comfy', 'http://user:password@127.0.0.1:8188',
    'http://127.0.0.1:8188/prompt', 'http://127.0.0.1:8188?target=x', 'http://127.0.0.1:8189', 'http://[::1]:8188']) {
    const f = fixture()
    code(await f.invoke('queue', f.request(localGraph(), { endpoint })), 'INVALID_ENDPOINT')
    assert.equal(f.calls.length, 0)
  }
  for (const endpoint of ['http://127.0.0.1:8188/', 'http://localhost:8188', 'http://[::1]:8188']) {
    const f = fixture({ state: { endpoint } })
    assert.equal((await f.invoke('queue', f.request())).success, true)
  }
})

test('metadata failure is unknown, never a local exemption', async () => {
  const scenarios = [
    async () => { throw new Error('Metadata unavailable') },
    async () => jsonResponse({ error: 'offline' }, 503),
    async () => new Response('not-json'),
    async () => jsonResponse([]),
    async () => jsonResponse({}),
    async () => new Response('{}', { headers: { 'Content-Length': String(LIMITS.metadataBytes + 1) } }),
  ]
  for (const fetchImpl of scenarios) {
    const f = fixture({ fetchImpl })
    code(await f.invoke('queue', f.request()), 'LOCAL_ONLY')
    assert.equal(f.keyReads, 0)
    assert.equal(f.posts.length, 0)
  }
})

test('unknown graphs after failed metadata can only submit after their own native approval', async () => {
  const f = fixture({ state: { policy: 'ask-cloud' }, fetchImpl: async (url) => {
    if (url.endsWith('/object_info')) throw new Error('No metadata')
    return jsonResponse({ prompt_id: 'unknown-approved' })
  } })
  const result = await f.invoke('queue', f.request())
  assert.equal(result.success, true)
  assert.equal(f.confirmations[0].assessment.risk, 'unknown')
  assert.equal(f.posts.length, 1)
})

test('metadata timeout is unknown rather than free and does not expire native approval scope', async () => {
  const f = fixture({ state: { policy: 'ask-cloud' }, dependencies: { metadataTimeoutMs: 5 }, fetchImpl: async url => {
    if (url.endsWith('/object_info')) return new Promise(() => {})
    return jsonResponse({ prompt_id: 'approved-after-timeout' })
  } })
  assert.equal((await f.invoke('queue', f.request())).success, true)
  assert.equal(f.confirmations[0].assessment.risk, 'unknown')
  assert.equal(f.posts.length, 1)
})

test('simultaneous queues and policy changes reject busy, and busy request IDs are not reusable', async () => {
  const gate = deferred()
  const f = fixture({ state: { policy: 'ask-cloud' }, confirmSpend: () => gate.promise })
  const first = f.invoke('queue', f.request(paidGraph()))
  await until(() => f.confirmations.length === 1)
  const second = f.request(paidGraph())
  code(await f.invoke('queue', second), 'BUSY')
  code(await f.invoke('setPolicy', { policy: 'local-only' }), 'BUSY')
  assert.equal((await f.invoke('status')).busy, true)
  gate.resolve(false)
  code(await first, 'DENIED')
  code(await f.invoke('queue', second), 'DUPLICATE_REQUEST')
  assert.equal(f.confirmations.length, 1)
  assert.equal(f.posts.length, 0)
})

test('a pending policy relaxation serializes queue requests and rejects stale confirmation', async () => {
  const gate = deferred()
  const f = fixture({ confirmPolicyChange: () => gate.promise })
  const first = f.invoke('setPolicy', { policy: 'ask-cloud' })
  await until(() => f.policyConfirmations.length === 1)
  code(await f.invoke('queue', f.request()), 'BUSY')
  f.state.context.session = 'new-session'
  gate.resolve(true)
  code(await first, 'STALE_CONTEXT')
  assert.equal(f.writes.length, 0)
})

test('context, policy, endpoint and native window recheck after native consent', async t => {
  const changes = {
    session: f => { f.state.context.session = 'session-changed' }, project: f => { f.state.context.projectKey = '/different/project' },
    timeline: f => { f.state.context.timelineId = 'timeline-changed' }, endpoint: f => { f.state.endpoint = 'http://127.0.0.1:8189' },
    policy: f => { f.state.policy = 'local-only' }, window: f => { f.state.window = { ...f.window } },
    frame: f => { f.contents.mainFrame = {} }, destroyed: f => { f.window.isDestroyed = () => true },
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const gate = deferred()
    const f = fixture({ state: { policy: 'ask-cloud' }, confirmSpend: () => gate.promise })
    const pending = f.invoke('queue', f.request(paidGraph()))
    await until(() => f.confirmations.length === 1)
    change(f); gate.resolve(true)
    code(await pending, 'STALE_CONTEXT')
    assert.equal(f.keyReads, 0)
    assert.equal(f.posts.length, 0)
  })
})

test('key lookup cannot bridge changed policy/context/endpoint/window into a submission', async t => {
  for (const name of ['policy', 'context', 'endpoint', 'window', 'export']) await t.test(name, async () => {
    const gate = deferred()
    const f = fixture({ state: { policy: 'ask-cloud' }, getApiKey: () => gate.promise })
    const pending = f.invoke('queue', f.request(paidGraph()))
    await until(() => f.keyReads === 1)
    if (name === 'policy') f.state.policy = 'local-only'
    if (name === 'context') f.state.context.projectKey = '/changed'
    if (name === 'endpoint') f.state.endpoint = 'http://127.0.0.1:8189'
    if (name === 'window') f.state.window = { ...f.window }
    if (name === 'export') f.state.available = false
    gate.resolve(f.state.key)
    code(await pending, name === 'export' ? 'UNAVAILABLE' : 'STALE_CONTEXT')
    assert.equal(f.posts.length, 0)
  })
})

test('availability changes during consent reject before key release and POST', async () => {
  const f = fixture({ state: { policy: 'ask-cloud' }, confirmSpend: (_input, state) => { state.available = false; return true } })
  code(await f.invoke('queue', f.request(paidGraph())), 'UNAVAILABLE')
  assert.equal(f.keyReads, 0)
  assert.equal(f.posts.length, 0)
})

test('a cancelled native dialog remains serialized until it closes and approval cannot revive it', async () => {
  const gate = deferred()
  const f = fixture({ state: { policy: 'ask-cloud' }, confirmSpend: () => gate.promise })
  const payload = f.request(paidGraph())
  const pending = f.invoke('queue', payload)
  await until(() => f.confirmations.length === 1)
  assert.deepEqual(await f.invoke('cancel', { requestId: payload.requestId }), { success: true, cancelled: true, submissionState: 'not-started', serviceJobCancelled: false })
  assert.equal(f.confirmations[0].signal.aborted, true)
  code(await f.invoke('queue', f.request()), 'BUSY')
  gate.resolve(true)
  code(await pending, 'CANCELLED')
  assert.equal(f.keyReads, 0)
  assert.equal(f.posts.length, 0)
  code(await f.invoke('queue', payload), 'DUPLICATE_REQUEST')
})

test('cancellation while reading metadata aborts the read and makes no POST', async () => {
  const f = fixture({ fetchImpl: async () => new Promise(() => {}) })
  const payload = f.request()
  const pending = f.invoke('queue', payload)
  await until(() => f.calls.length === 1)
  await f.invoke('cancel', { requestId: payload.requestId })
  code(await pending, 'CANCELLED')
  assert.equal(f.calls[0].init.signal.aborted, true)
  assert.equal(f.posts.length, 0)
})

test('native agent-turn cancellation stops a pending credential read before POST', async () => {
  const f = fixture({ state: { policy: 'ask-cloud' }, getApiKey: () => new Promise(() => {}) })
  const pending = f.invoke('queue', f.request(paidGraph()))
  await until(() => f.keyReads === 1)
  assert.deepEqual(f.controller.cancelPending('agent-turn-ended'), { cancelled: true, submissionState: 'not-started', serviceJobCancelled: false })
  code(await pending, 'CANCELLED')
  assert.equal(f.posts.length, 0)
})

test('cancel after POST starts reports uncertain, never cancels the service job or retries', async () => {
  const f = fixture({ fetchImpl: async url => url.endsWith('/object_info') ? jsonResponse(objectInfo) : new Promise(() => {}) })
  const payload = f.request()
  const pending = f.invoke('queue', payload)
  await until(() => f.posts.length === 1)
  const cancellation = await f.invoke('cancel', { requestId: payload.requestId })
  assert.equal(cancellation.submissionState, 'unknown')
  assert.equal(cancellation.serviceJobCancelled, false)
  const result = await pending
  code(result, 'SUBMISSION_UNCERTAIN')
  assert.equal(result.retryAllowed, false)
  assert.equal(f.posts[0].init.signal.aborted, true)
  code(await f.invoke('queue', payload), 'DUPLICATE_REQUEST')
  assert.equal(f.posts.length, 1)
})

test('foreign cancellation cannot cancel a main-frame request', async () => {
  const gate = deferred()
  const f = fixture({ state: { policy: 'ask-cloud' }, confirmSpend: () => gate.promise })
  const payload = f.request(paidGraph())
  const pending = f.invoke('queue', payload)
  await until(() => f.confirmations.length === 1)
  code(await f.invoke('cancel', { requestId: payload.requestId }, { sender: f.contents, senderFrame: {} }), 'UNAUTHORIZED')
  assert.equal(f.confirmations[0].signal.aborted, false)
  gate.resolve(false); await pending
})

test('main-frame navigation, renderer crash and disposal cancel pending requests', async t => {
  for (const action of ['navigation', 'crash', 'dispose']) await t.test(action, async () => {
    const gate = deferred()
    const f = fixture({ state: { policy: 'ask-cloud' }, confirmSpend: () => gate.promise })
    const pending = f.invoke('queue', f.request(paidGraph()))
    await until(() => f.confirmations.length === 1)
    if (action === 'navigation') f.contents.emit('did-start-navigation', {}, 'file:///new', false, true)
    if (action === 'crash') f.contents.emit('render-process-gone')
    if (action === 'dispose') f.controller.dispose()
    gate.resolve(true)
    code(await pending, 'CANCELLED')
    assert.equal(f.posts.length, 0)
    if (action === 'dispose') { assert.equal(f.handlers.size, 0); assert.equal(f.contents.listenerCount('render-process-gone'), 0) }
  })
})

test('HTTP validation errors return their bounded body once without automatic retries', async () => {
  const body = { error: { message: 'Prompt outputs failed validation' }, node_errors: { '1': { errors: [{ details: 'Fixture error' }] } } }
  const f = fixture({ fetchImpl: async url => url.endsWith('/object_info') ? jsonResponse(objectInfo) : jsonResponse(body, 400) })
  const payload = f.request()
  assert.deepEqual(await f.invoke('queue', payload), { success: true, status: 400, ok: false, body })
  code(await f.invoke('queue', payload), 'DUPLICATE_REQUEST')
  assert.equal(f.posts.length, 1)
})

test('submission network failures, response overflow, and timeout remain uncertain and are not retried', async () => {
  const scenarios = [
    async () => { throw new Error('Synthetic response may contain a credential') },
    async () => new Response('x', { headers: { 'Content-Length': String(LIMITS.responseBytes + 1) } }),
    async () => new Promise(() => {}),
  ]
  for (const post of scenarios) {
    const f = fixture({ dependencies: { submissionTimeoutMs: 5 }, fetchImpl: async url => url.endsWith('/object_info') ? jsonResponse(objectInfo) : post() })
    const payload = f.request()
    const result = await f.invoke('queue', payload)
    code(result, 'SUBMISSION_UNCERTAIN')
    assert.equal(result.submissionState, 'unknown')
    assert.equal(result.retryAllowed, false)
    assert.equal(f.posts.length, 1)
    code(await f.invoke('queue', payload), 'DUPLICATE_REQUEST')
  }
})

test('service bodies never return the released account key, even if it is echoed inside JSON or text', async () => {
  for (const asJson of [true, false]) {
    const f = fixture({ state: { policy: 'ask-cloud' }, fetchImpl: async (url, _init, state) => {
      if (url.endsWith('/object_info')) return jsonResponse(objectInfo)
      return asJson ? jsonResponse({ prompt_id: 'fixture', error: { details: `Echo ${state.key}` }, api_key_comfy_org: 'unrelated-secret', [state.key]: state.key })
        : new Response(`Service echoed ${state.key}`)
    } })
    const result = await f.invoke('queue', f.request(paidGraph()))
    assert.equal(result.success, true)
    assert.equal(JSON.stringify(result).includes(f.state.key), false)
    assert.equal(JSON.stringify(result).includes('unrelated-secret'), false)
    assert.match(JSON.stringify(result), /redacted/)
  }
})

test('unsupported graphs reject before metadata, native approval, credential access or POST', async () => {
  const cycle = {}; cycle.self = cycle
  const tooDeep = localGraph(); let nested = tooDeep['1'].inputs
  for (let i = 0; i < LIMITS.depth; i++) nested = nested.child = {}
  const candidates = [null, [], {}, { '1': { inputs: {} } }, { '1': { class_type: 'KSampler', inputs: [] } },
    { '1': { class_type: 'KSampler', inputs: { bad: undefined } } }, { '1': { class_type: 'KSampler', inputs: { bad: Infinity } } },
    { '1': { class_type: 'KSampler', inputs: { bad: new Array(100000000) } } },
    { '1': { class_type: 'KSampler', inputs: { bad: Object.assign([], { custom: true }) } } },
    { '1': { class_type: 'KSampler', inputs: cycle } }, { '1': { class_type: 'KSampler', inputs: { huge: 'x'.repeat(LIMITS.graphBytes) } } },
    Object.fromEntries(Array.from({ length: LIMITS.graphNodes + 1 }, (_, i) => [String(i), { class_type: 'SaveImage', inputs: {} }])), tooDeep,
    { '1': { class_type: 'KSampler', inputs: { toJSON() { assert.fail('toJSON must not execute') } } } },
  ]
  for (const graph of candidates) {
    const f = fixture()
    code(await f.invoke('queue', f.request(graph)), 'INVALID_GRAPH')
    assert.equal(f.calls.length, 0)
    assert.equal(f.keyReads, 0)
  }
})

test('untrusted dependency exceptions cannot leak private text into public control errors', async () => {
  for (const name of ['getContext', 'readPolicy', 'getEndpoint', 'assertAvailable']) {
    const f = fixture({ dependencies: { [name]: () => { throw new Error('secret-provider-key-private') } } })
    const result = await f.invoke('queue', f.request())
    code(result, 'UNAVAILABLE')
    assert.equal(JSON.stringify(result).includes('secret-provider-key-private'), false)
    assert.equal(f.posts.length, 0)
  }
})

test('bounded streamed responses reject actual bytes above the declared length', async () => {
  const f = fixture({ fetchImpl: async url => {
    if (url.endsWith('/object_info')) return jsonResponse(objectInfo)
    return new Response('x'.repeat(LIMITS.responseBytes + 1), { headers: { 'Content-Length': '1' } })
  } })
  code(await f.invoke('queue', f.request()), 'SUBMISSION_UNCERTAIN')
  assert.equal(f.posts.length, 1)
})

test('only a literal true native decision approves spending', async () => {
  for (const decision of [1, 'yes', { approved: true }, { response: 0 }, null]) {
    const f = fixture({ state: { policy: 'ask-cloud' }, confirmSpend: () => decision })
    code(await f.invoke('queue', f.request(paidGraph())), 'DENIED')
    assert.equal(f.keyReads, 0)
    assert.equal(f.posts.length, 0)
  }
})

test('delayed native settings commit loses authority on navigation, window replacement or timeout', async t => {
  for (const action of ['navigation', 'window', 'timeout']) await t.test(action, async () => {
    const gate = deferred()
    let pendingAuthority, commits = 0
    const f = fixture({ dependencies: { contextTimeoutMs: action === 'timeout' ? 5 : 15000,
      writePolicy: async (_policy, authority) => {
        pendingAuthority = authority
        await gate.promise
        if (!authority.isCurrent() || authority.signal.aborted) throw new Error('Expired settings authority')
        commits++
      } } })
    const pending = f.invoke('setPolicy', { policy: 'ask-cloud' })
    await until(() => pendingAuthority)
    if (action === 'navigation') f.contents.emit('did-start-navigation', {}, 'file:///different', false, true)
    if (action === 'window') f.state.window = { ...f.window }
    if (action === 'timeout') await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(pendingAuthority.isCurrent(), false)
    gate.resolve()
    const result = await pending
    assert.equal(result.success, false)
    assert.equal(commits, 0)
    assert.equal(f.writes.length, 0)
    assert.equal(f.events.length, 0)
  })
})

test('policy target is frozen before its native confirmation opens', async () => {
  const gate = deferred()
  const f = fixture({ confirmPolicyChange: () => gate.promise })
  const payload = { policy: 'ask-cloud' }
  const pending = f.invoke('setPolicy', payload)
  await until(() => f.policyConfirmations.length === 1)
  payload.policy = 'local-only'
  gate.resolve(true)
  assert.equal((await pending).policy, 'ask-cloud')
  assert.deepEqual(f.writes, ['ask-cloud'])
})

test('workflow credential fields and standard token shapes are redacted from echoed service details', async () => {
  const graph = paidGraph()
  graph['1'].inputs.private_api_key = 'some-private-value-not-a-known-token-format'
  graph['1'].inputs.authorization = 'Some authentication scheme'
  const f = fixture({ state: { policy: 'ask-cloud' }, fetchImpl: async url => url.endsWith('/object_info') ? jsonResponse(objectInfo)
    : jsonResponse({ details: `Echo ${graph['1'].inputs.private_api_key}, ${graph['1'].inputs.authorization}, sk-unrelated-long-private-key, Bearer abcdefg` }) })
  const result = await f.invoke('queue', f.request(graph))
  const text = JSON.stringify(result)
  assert.equal(result.success, true)
  assert.equal(text.includes(graph['1'].inputs.private_api_key), false)
  assert.equal(text.includes(graph['1'].inputs.authorization), false)
  assert.equal(text.includes('sk-unrelated-long-private-key'), false)
  assert.equal(text.includes('Bearer abcdefg'), false)
})

test('the final asynchronous settings read cannot hide a context or export change before POST', async t => {
  for (const target of ['project', 'export']) await t.test(target, async () => {
    let reads = 0
    const f = fixture({ state: { policy: 'ask-cloud' }, dependencies: { readPolicy: async () => {
      if (++reads === 6) {
        if (target === 'project') f.state.context.projectKey = '/late-project-change'
        else f.state.available = false
      }
      return 'ask-cloud'
    } } })
    code(await f.invoke('queue', f.request(paidGraph())), target === 'project' ? 'STALE_CONTEXT' : 'UNAVAILABLE')
    assert.equal(reads, 6)
    assert.equal(f.keyReads, 1)
    assert.equal(f.posts.length, 0)
  })
})

test('the actual POST dispatch rechecks export availability after the last context await', async () => {
  let reads = 0
  const f = fixture({ state: { policy: 'ask-cloud' }, dependencies: { getContext: async () => {
    if (++reads === 6) f.state.available = false
    return { ...f.state.context }
  } } })
  code(await f.invoke('queue', f.request(paidGraph())), 'UNAVAILABLE')
  assert.equal(reads, 6)
  assert.equal(f.keyReads, 1)
  assert.equal(f.posts.length, 0)
})

// ---- one approval for several pictures from a person's own paid workflow ----
const batchGraph = (prompt = 'shot one', extra = {}) => ({
  '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: prompt } },
  '2': { class_type: 'OpenAIGPTImage1', inputs: { prompt: ['1', 0], model: 'gpt-image-1', quality: 'low', seed: Math.floor(Math.random() * 1e9), ...extra } },
})
const batchFixture = (answer, options = {}) => fixture({ state: { policy: 'ask-cloud' },
  confirmSpend: input => (typeof answer === 'function' ? answer(input) : answer), ...options })

test('one batch approval covers the stated number of submissions and then asks again', async () => {
  const f = batchFixture(input => ({ approved: true, batchCount: input.batchCount }))
  for (const prompt of ['one', 'two', 'three']) {
    const result = await f.invoke('queue', f.request(batchGraph(prompt), { batchCount: 3 }))
    assert.equal(result.success, true)
  }
  assert.equal(f.confirmations.length, 1, 'asked once for three')
  assert.equal(f.confirmations[0].batchCount, 3)
  assert.equal(f.posts.length, 3)
  // The fourth is outside the approved number.
  await f.invoke('queue', f.request(batchGraph('four')))
  assert.equal(f.confirmations.length, 2)
  assert.equal(f.confirmations[1].batchCount, 0)
})

test('a batch approval does not cover a different model or setting', async () => {
  const f = batchFixture(input => input.batchCount ? { approved: true, batchCount: input.batchCount } : false)
  assert.equal((await f.invoke('queue', f.request(batchGraph('one'), { batchCount: 5 }))).success, true)
  code(await f.invoke('queue', f.request(batchGraph('two', { quality: 'high' }))), 'DENIED')
  code(await f.invoke('queue', f.request(batchGraph('three', { model: 'gpt-image-2' }))), 'DENIED')
  assert.equal(f.confirmations.length, 3)
  assert.equal(f.posts.length, 1)
})

test('a refusal ends the batch approval', async () => {
  let refuse = false
  const f = batchFixture(input => refuse ? false : { approved: true, batchCount: input.batchCount })
  assert.equal((await f.invoke('queue', f.request(batchGraph('one'), { batchCount: 5 }))).success, true)
  refuse = true
  code(await f.invoke('queue', f.request(batchGraph('two', { quality: 'high' }))), 'DENIED')
  // The same model and settings as the batch now ask again too.
  code(await f.invoke('queue', f.request(batchGraph('three'))), 'DENIED')
  assert.equal(f.posts.length, 1)
})

test('a batch approval stays in its own project', async () => {
  const f = batchFixture(input => ({ approved: true, batchCount: input.batchCount || undefined }))
  assert.equal((await f.invoke('queue', f.request(batchGraph('one'), { batchCount: 5 }))).success, true)
  f.state.context = { ...f.state.context, projectKey: '/synthetic/other-project' }
  await f.invoke('queue', f.request(batchGraph('two')))
  assert.equal(f.confirmations.length, 2, 'another project is asked about again')
})

test('an ordinary single approval never becomes a batch', async () => {
  const f = batchFixture(true)
  assert.equal((await f.invoke('queue', f.request(batchGraph('one'), { batchCount: 5 }))).success, true)
  assert.equal((await f.invoke('queue', f.request(batchGraph('two'), { batchCount: 4 }))).success, true)
  assert.equal(f.confirmations.length, 2)
})

test('an answer for a different number than was asked is refused', async () => {
  const f = batchFixture({ approved: true, batchCount: 50 })
  code(await f.invoke('queue', f.request(batchGraph('one'), { batchCount: 3 })), 'DENIED')
  assert.equal(f.posts.length, 0)
})

test('a batch number outside the allowed range is rejected before anything is asked', async () => {
  const f = batchFixture(true)
  for (const batchCount of [1, 0, -3, 201, 2.5, '3']) {
    code(await f.invoke('queue', f.request(batchGraph('x'), { batchCount })), 'INVALID_REQUEST')
  }
  assert.equal(f.confirmations.length, 0)
})

test('a batch is never offered for a local or an unfamiliar workflow, or under Local only', async () => {
  const local = batchFixture(true)
  assert.equal((await local.invoke('queue', local.request(localGraph(), { batchCount: 5 }))).success, true)
  assert.equal(local.confirmations.length, 0)
  const unknown = batchFixture(input => { assert.equal(input.batchCount, 0); return true })
  await unknown.invoke('queue', unknown.request(unknownGraph(), { batchCount: 5 }))
  assert.equal(unknown.confirmations.length, 1)
  const localOnly = fixture({ state: { policy: 'local-only' } })
  code(await localOnly.invoke('queue', localOnly.request(batchGraph('x'), { batchCount: 5 })), 'LOCAL_ONLY')
})

test('changing the spending policy ends a batch approval', async () => {
  const f = batchFixture(input => ({ approved: true, batchCount: input.batchCount || undefined }))
  assert.equal((await f.invoke('queue', f.request(batchGraph('one'), { batchCount: 5 }))).success, true)
  await f.invoke('setPolicy', { policy: 'local-only' })
  await f.invoke('setPolicy', { policy: 'ask-cloud' })
  await f.invoke('queue', f.request(batchGraph('two')))
  assert.equal(f.confirmations.length, 2)
})
