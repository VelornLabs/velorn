'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createComfyRouter, MODEL, ESTIMATE, LIMITS } = require('../electron/comfyRouter.cjs')
const { createRouterTestPng } = require('./helpers/routerImage.cjs')
const KEY = 'synthetic-router-key-one-never-real'
const OTHER_KEY = 'synthetic-router-key-two-never-real'
const PNG = createRouterTestPng()
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })
async function fixture(t, overrides = {}) {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-router-test-'))
  const requests = [], notices = [], approvals = []
  const state = { context: { session: 'session-one', projectKey: '/synthetic/project-one' }, policy: 'ask-cloud', time: Date.now(), approved: true }
  const transport = overrides.transport || (async (_url, options) => options.method === 'POST' ? response({ request_id: 'provider-job-one', status: 'IN_QUEUE' }, 201)
    : options.method === 'PUT' ? response({ status: 'CANCELLATION_REQUESTED' }, 202)
    : _url.endsWith('/status') ? response({ status: 'COMPLETED' })
    : _url.endsWith('/provider-job-one') ? response({ data: [{ b64_json: PNG.toString('base64') }] }) : response({ id: MODEL }))
  const options = { storageDir, getContext: async () => ({ ...state.context }), getPolicy: async () => state.policy,
    validateImage: async () => ({ width: 1024, height: 1024 }),
    confirmSpend: async value => { approvals.push(value); return state.approved }, now: () => state.time,
    fetchImpl: async (url, request) => { requests.push({ url, ...request }); return transport(url, request) },
    notify: value => notices.push(value), ...overrides }
  delete options.transport
  let manager = createComfyRouter(options)
  t.after(async () => { manager.dispose(); await fs.rm(storageDir, { recursive: true, force: true }) })
  return { get manager() { return manager }, storageDir, requests, notices, approvals, state, options,
    replace() { manager.dispose(); manager = createComfyRouter(options); return manager },
    advance(ms = 10000) { state.time += ms },
    async connected() { assert.equal((await manager.connect({ apiKey: KEY })).success, true) },
    async plan(prompt = 'A friendly robot on a quiet blue background.') { const result = await manager.preview({ prompt }); assert.equal(result.success, true, result.error); return result.planId },
    async queued() { await this.connected(); const planId = await this.plan(); const result = await manager.submit({ planId }); assert.equal(result.success, true, result.error); return result.job.jobId },
    async ledger() { return JSON.parse(await fs.readFile(path.join(storageDir, 'comfy-router-jobs.json'), 'utf8')) },
  }
}

test('status is passive and the dedicated key stays session-only', async t => {
  const f = await fixture(t)
  assert.equal((await f.manager.status({})).configured, false); assert.equal(f.requests.length, 0)
  const connected = await f.manager.connect({ apiKey: KEY })
  assert.equal(connected.keyAccepted, true); assert.equal(connected.sessionOnly, true)
  assert.match(connected.summary, /Workspace access.*credits/)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].url, `https://api.comfy.org/v2/models/${MODEL}`)
  assert.equal(f.requests[0].method, 'GET'); assert.equal(f.requests[0].headers['X-API-Key'], KEY)
  assert.equal(f.requests[0].redirect, 'error'); assert.equal(f.requests[0].credentials, 'omit')
  assert.doesNotMatch(JSON.stringify(await f.manager.status({})), new RegExp(KEY))
  assert.deepEqual(await fs.readdir(f.storageDir), [])
  await f.manager.clear({}); assert.equal((await f.manager.status({})).configured, false)
})

test('projectless status reports native policy but cannot preview a generation', async t => {
  const f = await fixture(t); f.state.context.projectKey = null
  const status = await f.manager.status(); assert.equal(status.success, true); assert.equal(status.policy, 'ask-cloud')
  assert.deepEqual(await f.manager.list(), { success: true, jobs: [] })
  await f.connected()
  assert.equal((await f.manager.preview({ prompt: 'A cat' })).code, 'COMFY_ROUTER_PROJECT_REQUIRED')
})

test('connect failure preserves the old key and never emits raw provider body', async t => {
  const f = await fixture(t, { transport: async (_url, request) => request.headers['X-API-Key'] === OTHER_KEY ? response({ error: KEY }, 401) : response({ id: MODEL }) })
  await f.connected()
  const bad = await f.manager.connect({ apiKey: OTHER_KEY })
  assert.equal(bad.code, 'COMFY_ROUTER_AUTH'); assert.doesNotMatch(JSON.stringify(bad), new RegExp(KEY))
  assert.equal((await f.manager.status({})).configured, true)
  f.replace(); assert.equal((await f.manager.status({})).configured, false)
})

test('strict ingress and prompt boundary reject authority, URL and credential injection', async t => {
  const f = await fixture(t); await f.connected()
  for (const [method, payload] of [['status', { apiKey: KEY }], ['connect', { apiKey: KEY, remember: true }],
    ['preview', { prompt: 'A cat', model: 'other/model' }], ['preview', { prompt: KEY }], ['preview', { prompt: ' ' }],
    ['preview', { prompt: 'x'.repeat(LIMITS.prompt + 1) }], ['submit', { planId: 'missing', approved: true }],
    ['refresh', { jobId: 'https://evil.test' }], ['output', { jobId: 'missing', url: 'https://evil.test' }]]) {
    assert.equal((await f.manager[method](payload)).success, false, method)
  }
  assert.equal(f.requests.length, 1)
})

test('preview is fixed-model/project-bound and sends no provider request', async t => {
  const f = await fixture(t); await f.connected()
  const preview = await f.manager.preview({ prompt: ' A paper house. ' })
  assert.equal(preview.model, MODEL); assert.equal(preview.prompt, 'A paper house.'); assert.deepEqual(preview.estimate, ESTIMATE)
  assert.equal(preview.width, 1024); assert.equal(preview.requiresNativeApproval, true); assert.equal(f.requests.length, 1)
  f.state.context.projectKey = '/synthetic/project-two'
  assert.equal((await f.manager.submit({ planId: preview.planId })).code, 'COMFY_ROUTER_PLAN_INVALID')
  assert.equal(f.approvals.length, 0)
})

test('native plan inspection retains the exact preview and cannot regenerate/rebind it', async t => {
  const f = await fixture(t); await f.connected(); const planId = await f.plan('The approved original prompt')
  const inspected = await f.manager.inspectPlan({ planId })
  assert.equal(inspected.planId, planId); assert.equal(inspected.prompt, 'The approved original prompt'); assert.equal(inspected.previewOnly, true)
  assert.equal(f.requests.length, 1); assert.equal(f.approvals.length, 0)
  assert.equal((await f.manager.inspectPlan({ planId, prompt: 'replacement' })).success, false)
  f.advance(LIMITS.planMs + 1); assert.equal((await f.manager.inspectPlan({ planId })).code, 'COMFY_ROUTER_PLAN_EXPIRED')
})

test('ending an agent turn preserves an idle preview for separately approved apply', async t => {
  const f = await fixture(t); await f.connected(); const planId = await f.plan('Review this unchanged prompt next turn')
  f.manager.cancelPending()
  const inspected = await f.manager.inspectPlan({ planId })
  assert.equal(inspected.success, true); assert.equal(inspected.prompt, 'Review this unchanged prompt next turn')
  assert.equal(f.approvals.length, 0); assert.equal(f.requests.filter(r => r.method === 'POST').length, 0)
  assert.equal((await f.manager.submit({ planId })).success, true)
  assert.equal(f.approvals.length, 1); assert.equal(f.requests.filter(r => r.method === 'POST').length, 1)
})

test('expired submitted previews free plan capacity without deleting jobs or replaying an old plan', async t => {
  const f = await fixture(t); await f.connected()
  const planIds = []
  for (let index = 0; index < LIMITS.plans; index++) {
    const planId = await f.plan(`Synthetic image ${index}`); planIds.push(planId)
    assert.equal((await f.manager.submit({ planId })).success, true)
  }
  const full = await f.manager.preview({ prompt: 'Another synthetic image' })
  assert.equal(full.code, 'COMFY_ROUTER_PLAN_LIMIT'); assert.match(full.error, /expire/); assert.doesNotMatch(full.error, /reopen/)
  f.advance(LIMITS.planMs + 1)
  assert.equal((await f.manager.preview({ prompt: 'A new preview after expiry' })).success, true)
  assert.equal((await f.manager.list()).jobs.length, LIMITS.plans)
  assert.equal((await f.ledger()).jobs.length, LIMITS.plans)
  assert.equal((await f.manager.submit({ planId: planIds[0] })).code, 'COMFY_ROUTER_PLAN_INVALID')
  assert.equal(f.requests.filter(request => request.method === 'POST').length, LIMITS.plans)
})

test('pruning an expired uncertain preview preserves its duplicate-charge guard', async t => {
  const f = await fixture(t, { transport: async (_url, request) => { if (request.method === 'POST') throw new Error('synthetic network failure'); return response({ id: MODEL }) } })
  await f.connected(); const oldPlan = await f.plan()
  assert.equal((await f.manager.submit({ planId: oldPlan })).code, 'COMFY_ROUTER_UNCERTAIN')
  f.advance(LIMITS.planMs + 1)
  const newPlan = await f.plan('Another synthetic image')
  assert.equal((await f.manager.submit({ planId: oldPlan })).code, 'COMFY_ROUTER_PLAN_INVALID')
  assert.equal((await f.manager.submit({ planId: newPlan })).code, 'COMFY_ROUTER_UNCERTAIN')
  assert.equal((await f.manager.list()).jobs[0].status, 'UNCERTAIN')
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1)
})

test('local-only policy, decline and missing approval block POST', async t => {
  const f = await fixture(t); await f.connected()
  const planId = await f.plan()
  f.state.policy = 'local-only'
  assert.equal((await f.manager.submit({ planId })).code, 'COMFY_ROUTER_LOCAL_ONLY')
  assert.equal(f.approvals.length, 0)
  f.state.policy = 'ask-cloud'; f.state.approved = false
  assert.equal((await f.manager.submit({ planId })).code, 'COMFY_ROUTER_DECLINED')
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0)
  const missing = createComfyRouter({ ...f.options, confirmSpend: undefined })
  t.after(() => missing.dispose()); await missing.connect({ apiKey: KEY })
  const other = await missing.preview({ prompt: 'A cat' })
  assert.equal((await missing.submit({ planId: other.planId })).code, 'COMFY_ROUTER_APPROVAL_UNAVAILABLE')
})

test('native approval is exact and ledger is private, sanitized and durable before single POST', async t => {
  let f
  f = await fixture(t, { transport: async (_url, request) => {
    if (request.method !== 'POST') return response({ id: MODEL })
    const ledger = await f.ledger()
    assert.equal(ledger.jobs.length, 1); assert.equal(ledger.jobs[0].status, 'SUBMITTING')
    assert.equal(request.headers['Idempotency-Key'], ledger.jobs[0].id)
    return response({ request_id: 'provider-job-one', status: 'IN_QUEUE', status_url: 'https://evil.test/status' }, 201)
  } })
  await f.connected(); const planId = await f.plan('Unique private prompt not written to disk.')
  const first = await f.manager.submit({ planId }); assert.equal(first.success, true)
  const second = await f.manager.submit({ planId }); assert.equal(second.repeated, true); assert.equal(second.job.jobId, first.job.jobId)
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1)
  assert.equal(f.approvals.length, 1); assert.equal(f.approvals[0].submissionCount, 1); assert.ok(f.approvals[0].signal instanceof AbortSignal)
  const post = f.requests.find(r => r.method === 'POST')
  assert.equal(post.url, `https://api.comfy.org/v2/models/${MODEL}/requests`)
  assert.deepEqual(JSON.parse(post.body), { prompt: 'Unique private prompt not written to disk.', size: '1024x1024', response_format: 'b64_json', sequential_image_generation: 'disabled', stream: false, watermark: true })
  const raw = await fs.readFile(path.join(f.storageDir, 'comfy-router-jobs.json'), 'utf8')
  assert.doesNotMatch(raw, /Unique private|https:|synthetic-router-key|X-API-Key/)
  assert.match(raw, /credentialFingerprint/)
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.storageDir, 'comfy-router-jobs.json'))).mode & 0o777, 0o600)
})

test('project or policy change during approval blocks dispatch', async t => {
  for (const changed of ['project', 'policy', 'cancel']) {
    let release, entered
    const ready = new Promise(resolve => { entered = resolve })
    const f = await fixture(t, { confirmSpend: async () => { entered(); return new Promise(resolve => { release = resolve }) } })
    await f.connected(); const planId = await f.plan()
    const submission = f.manager.submit({ planId }); await ready
    if (changed === 'project') f.state.context.projectKey = '/synthetic/other'
    else if (changed === 'policy') f.state.policy = 'local-only'
    else f.manager.cancelPending()
    release(true)
    assert.equal((await submission).success, false)
    assert.equal(f.requests.filter(r => r.method === 'POST').length, 0)
  }
})

test('reconnect/clear while approval waits invalidates the old plan and key', async t => {
  let release, entered
  const ready = new Promise(resolve => { entered = resolve })
  const f = await fixture(t, { confirmSpend: async () => { entered(); return new Promise(resolve => { release = resolve }) } })
  await f.connected(); const planId = await f.plan(); const pending = f.manager.submit({ planId }); await ready
  await f.manager.connect({ apiKey: OTHER_KEY }); release(true)
  assert.equal((await pending).success, false); assert.equal(f.requests.filter(r => r.method === 'POST').length, 0)
})

test('concurrent submissions are serialized before native approval', async t => {
  let release, entered
  const ready = new Promise(resolve => { entered = resolve })
  const f = await fixture(t, { confirmSpend: async () => { entered(); return new Promise(resolve => { release = resolve }) } })
  await f.connected(); const first = await f.plan(); const second = await f.plan('A different cat')
  const pending = f.manager.submit({ planId: first }); await ready
  assert.equal((await f.manager.submit({ planId: second })).code, 'COMFY_ROUTER_BUSY')
  release(true); assert.equal((await pending).success, true)
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1)
})

test('uncertain POST is never retried, survives restart and blocks accidental duplicate spend', async t => {
  const f = await fixture(t, { transport: async (_url, request) => { if (request.method === 'POST') throw new Error(`network failed ${KEY}`); return response({ id: MODEL }) } })
  await f.connected(); const planId = await f.plan()
  const result = await f.manager.submit({ planId }); assert.equal(result.code, 'COMFY_ROUTER_UNCERTAIN'); assert.equal(result.job.status, 'UNCERTAIN')
  assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY))
  assert.equal((await f.manager.submit({ planId })).repeated, true)
  f.replace(); await f.connected()
  const jobs = await f.manager.list({}); assert.equal(jobs.jobs[0].status, 'UNCERTAIN')
  assert.equal((await f.manager.refresh({ jobId: jobs.jobs[0].jobId })).code, 'COMFY_ROUTER_UNCERTAIN')
  assert.equal((await f.manager.submit({ planId: await f.plan() })).code, 'COMFY_ROUTER_UNCERTAIN')
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1)
})

test('explicit queue denial is failed rather than an uncertain charged job', async t => {
  const f = await fixture(t, { transport: async (_url, request) => request.method === 'POST' ? response({ error: KEY }, 403) : response({ id: MODEL }) })
  await f.connected(); const result = await f.manager.submit({ planId: await f.plan() })
  assert.equal(result.code, 'COMFY_ROUTER_ACCESS'); assert.equal(result.job.status, 'FAILED')
  assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY))
})

test('safe rejection diagnostics survive restart and refresh without a key or provider request', async t => {
  const requestId = '1db3755e-b72e-429e-a310-c473d3bd1b57'
  for (const [status, errorType, message] of [[400, 'invalid_input', /parameters/], [401, 'unauthorized', /credential/],
    [402, 'insufficient_credits', /workspace credits/], [403, 'not_enabled', /workspace/], [404, 'model_not_found', /model/],
    [422, 'invalid_input', /parameters/], [429, 'rate_limited', /limit/],
    [400, 'content_policy_violation', /content-policy/], [403, 'content_policy_violation', /content-policy/], [422, 'content_policy_violation', /content-policy/]]) {
    const f = await fixture(t, { transport: async (_url, request) => request.method === 'POST'
      ? response({ detail: `${KEY} private prompt https://private.invalid` }, status, { 'X-Comfy-Error-Type': errorType, 'X-Comfy-Request-Id': requestId })
      : response({ id: MODEL }) })
    await f.connected(); const planId = await f.plan()
    const result = await f.manager.submit({ planId }), jobId = result.job.jobId
    const expected = { httpStatus: status, errorType, requestId }
    assert.equal(result.success, false); assert.equal(result.job.submissionRejected, true); assert.equal(result.job.canRefresh, false)
    assert.equal(result.job.needsReconnect, false); assert.equal(result.job.errorType, 'REQUEST_REJECTED')
    assert.deepEqual(result.diagnostics, expected); assert.deepEqual(result.job.diagnostics, expected)
    assert.match(result.error, message); assert.match(result.error, new RegExp(`HTTP ${status}`))
    assert.deepEqual((await f.ledger()).jobs[0].diagnostics, expected)
    assert.equal((await f.ledger()).jobs[0].providerJobId, undefined, 'A support request ID is not an admitted generation ID')
    assert.equal((await f.manager.submit({ planId })).repeated, true)
    await f.manager.clear({}); const before = f.requests.length
    const refreshed = await f.manager.refresh({ jobId })
    assert.equal(refreshed.success, true); assert.equal(refreshed.cached, true); assert.match(refreshed.summary, message)
    f.replace()
    const restored = await f.manager.refresh({ jobId })
    assert.deepEqual(restored.job.diagnostics, expected); assert.equal(restored.job.needsReconnect, false)
    assert.equal(f.requests.length, before); assert.equal(f.requests.filter(r => r.method === 'POST').length, 1)
    assert.doesNotMatch(JSON.stringify([result, restored, await f.ledger()]), /synthetic-router-key|private prompt|private\.invalid/)
    assert.doesNotMatch(JSON.stringify(await f.ledger()), /https:/)
    f.state.context.projectKey = '/other-project'
    assert.equal((await f.manager.refresh({ jobId })).code, 'COMFY_ROUTER_JOB_NOT_FOUND')
    assert.equal(f.requests.length, before)
  }
})

test('legacy rejected records remain readable and cannot acquire a misleading no-ID uncertainty', async t => {
  const f = await fixture(t, { transport: async (_url, request) => request.method === 'POST' ? response({}, 403) : response({ id: MODEL }) })
  await f.connected(); const rejected = await f.manager.submit({ planId: await f.plan() })
  const ledger = await f.ledger(); delete ledger.jobs[0].diagnostics
  await fs.writeFile(path.join(f.storageDir, 'comfy-router-jobs.json'), JSON.stringify(ledger))
  f.replace(); const before = f.requests.length
  const result = await f.manager.refresh({ jobId: rejected.job.jobId })
  assert.equal(result.success, true); assert.equal(result.cached, true); assert.equal(result.job.status, 'FAILED')
  assert.equal(result.job.submissionRejected, true); assert.equal(result.job.canRefresh, false)
  assert.match(result.summary, /earlier Velorn version did not retain/)
  assert.equal(result.job.diagnostics, undefined); assert.equal(f.requests.length, before)
})

test('a request stopped after recording but before dispatch is explicitly not submitted and remains cache-only', async t => {
  let policyReads = 0
  const f = await fixture(t, { getPolicy: async () => ++policyReads >= 4 ? 'local-only' : 'ask-cloud' })
  await f.connected(); const result = await f.manager.submit({ planId: await f.plan() })
  assert.equal(result.code, 'COMFY_ROUTER_LOCAL_ONLY')
  const job = (await f.manager.list()).jobs[0]
  assert.equal(job.status, 'CANCELLED'); assert.equal(job.notSubmitted, true); assert.equal(job.canRefresh, false)
  assert.match(job.errorMessage, /No generation request was sent/)
  assert.equal(job.diagnostics, undefined)
  await f.manager.clear({}); const before = f.requests.length
  const refresh = await f.manager.refresh({ jobId: job.jobId })
  assert.equal(refresh.success, true); assert.equal(refresh.cached, true)
  assert.equal(f.requests.length, before); assert.equal(f.requests.filter(r => r.method === 'POST').length, 0)
})

test('malformed or secret-bearing diagnostic headers and raw bodies are never retained', async t => {
  const uuidKey = '83333167-1939-4681-818b-3f482a0867a3'
  for (const [key, errorType, requestId] of [[KEY, KEY, KEY], [KEY, 'unknown_future_error', 'x'.repeat(4096)],
    [KEY, 'https://private.invalid', '1db3755e-b72e-429e-a310-c473d3bd1b57-suffix'], [uuidKey, uuidKey, uuidKey]]) {
    const f = await fixture(t, { transport: async (_url, request) => request.method === 'POST'
      ? new Response(`<html>${key} PRIVATE_BODY https://private.invalid</html>`, { status: 403,
        headers: { 'X-Comfy-Error-Type': errorType, 'X-Comfy-Request-Id': requestId } })
      : response({ id: MODEL }) })
    await f.manager.connect({ apiKey: key })
    const result = await f.manager.submit({ planId: await f.plan() })
    assert.deepEqual(result.diagnostics, { httpStatus: 403 })
    assert.deepEqual((await f.ledger()).jobs[0].diagnostics, { httpStatus: 403 })
    const serialized = JSON.stringify([result, await f.ledger()])
    assert.equal(serialized.includes(key), false); assert.doesNotMatch(serialized, /PRIVATE_BODY|private\.invalid|unknown_future_error/)
    assert.doesNotMatch(JSON.stringify(await f.ledger()), /https:/)
  }
})

test('HTTP diagnostics on ambiguous submissions never unlock retry or turn support IDs into polling IDs', async t => {
  for (const status of [408, 409, 500, 503, 504]) {
    const f = await fixture(t, { transport: async (_url, request) => request.method === 'POST' ? response({}, status,
      { 'X-Comfy-Error-Type': 'internal_error', 'X-Comfy-Request-Id': '1db3755e-b72e-429e-a310-c473d3bd1b57' }) : response({ id: MODEL }) })
    await f.connected(); const result = await f.manager.submit({ planId: await f.plan() })
    assert.equal(result.code, 'COMFY_ROUTER_UNCERTAIN'); assert.equal(result.job.status, 'UNCERTAIN')
    assert.equal(result.job.canRefresh, false); assert.equal(result.job.submissionRejected, undefined)
    assert.equal(result.job.diagnostics.httpStatus, status)
    const before = f.requests.length
    assert.equal((await f.manager.refresh({ jobId: result.job.jobId })).code, 'COMFY_ROUTER_UNCERTAIN')
    assert.equal((await f.manager.submit({ planId: await f.plan('A different image') })).code, 'COMFY_ROUTER_UNCERTAIN')
    assert.equal(f.requests.length, before)
    f.replace(); await f.connected()
    assert.equal((await f.manager.list()).jobs[0].status, 'UNCERTAIN')
    assert.equal((await f.manager.submit({ planId: await f.plan() })).code, 'COMFY_ROUTER_UNCERTAIN')
    assert.equal(f.requests.filter(r => r.method === 'POST').length, 1)
  }
})

test('refresh errors expose diagnostics without changing an admitted job to a rejected submission', async t => {
  const f = await fixture(t, { transport: async (url, request) => request.method === 'POST' ? response({ request_id: 'provider-job-one' }, 201)
    : url.endsWith('/status') ? response({}, 403, { 'X-Comfy-Error-Type': 'forbidden' }) : response({ id: MODEL }) })
  const jobId = await f.queued(); f.advance()
  const result = await f.manager.refresh({ jobId })
  assert.deepEqual(result.diagnostics, { httpStatus: 403, errorType: 'forbidden' })
  const job = (await f.manager.list()).jobs[0]
  assert.equal(job.status, 'IN_QUEUE'); assert.equal(job.submissionRejected, undefined); assert.equal(job.canRefresh, true)
  assert.equal(job.diagnostics, undefined)
})

test('POST conflict remains uncertain because the original submission might be charged', async t => {
  const f = await fixture(t, { transport: async (_url, request) => request.method === 'POST' ? response({ error: 'conflict' }, 409) : response({ id: MODEL }) })
  await f.connected(); const result = await f.manager.submit({ planId: await f.plan() })
  assert.equal(result.code, 'COMFY_ROUTER_UNCERTAIN'); assert.equal(result.job.status, 'UNCERTAIN')
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1)
})

test('recovery requires the same key fingerprint and never POSTs again', async t => {
  const f = await fixture(t); const jobId = await f.queued(); f.replace()
  assert.equal((await f.manager.list({})).jobs[0].needsReconnect, true)
  await f.manager.connect({ apiKey: OTHER_KEY })
  assert.equal((await f.manager.refresh({ jobId })).code, 'COMFY_ROUTER_KEY_REQUIRED')
  await f.connected(); const refreshed = await f.manager.refresh({ jobId })
  assert.equal(refreshed.job.status, 'COMPLETED')
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1)
})

test('unknown and cross-project jobs cannot trigger provider checks or import', async t => {
  const f = await fixture(t); const jobId = await f.queued(); const before = f.requests.length
  f.state.context.projectKey = '/synthetic/another-project'
  assert.deepEqual((await f.manager.list({})).jobs, [])
  for (const method of ['refresh', 'cancel', 'output']) assert.equal((await f.manager[method]({ jobId })).code, 'COMFY_ROUTER_JOB_NOT_FOUND')
  assert.equal((await f.manager.refresh({ jobId: 'invented' })).code, 'COMFY_ROUTER_JOB_NOT_FOUND')
  assert.equal(f.requests.length, before)
})

test('known job status/cancel remains available in local-only, with truthful cancellation', async t => {
  const f = await fixture(t); const jobId = await f.queued(); f.state.policy = 'local-only'
  const result = await f.manager.cancel({ jobId }); assert.equal(result.success, true); assert.equal(result.job.status, 'IN_QUEUE')
  assert.match(result.summary, /not a refund/)
  await f.manager.cancel({ jobId }); assert.equal(f.requests.filter(r => r.method === 'PUT').length, 1)
  assert.equal(f.requests.find(r => r.method === 'PUT').url, `https://api.comfy.org/v2/models/${MODEL}/requests/provider-job-one/cancel`)
  f.advance(); assert.equal((await f.manager.refresh({ jobId })).job.status, 'COMPLETED')
})

test('failed cancellation never becomes a later false success or automatic retry', async t => {
  const f = await fixture(t, { transport: async (url, request) => request.method === 'POST' ? response({ request_id: 'provider-job-one', status: 'IN_QUEUE' }, 201)
    : request.method === 'PUT' ? Promise.reject(new Error('network stopped')) : url.endsWith('/status') ? response({ status: 'IN_PROGRESS' }) : response({ id: MODEL }) })
  const jobId = await f.queued()
  const cancelled = await f.manager.cancel({ jobId })
  assert.equal(cancelled.code, 'COMFY_ROUTER_CANCEL_UNCERTAIN'); assert.equal(cancelled.job.cancellationRequested, false); assert.equal(cancelled.job.cancellationState, 'UNCERTAIN')
  assert.equal((await f.manager.cancel({ jobId })).success, false); assert.equal(f.requests.filter(r => r.method === 'PUT').length, 1)
  f.advance(); assert.equal((await f.manager.refresh({ jobId })).job.status, 'IN_PROGRESS')
})

test('Retry-After prevents early status polling and provider error_type overrides COMPLETED', async t => {
  const f = await fixture(t, { transport: async (url, request) => request.method === 'POST' ? response({ request_id: 'provider-job-one', status: 'IN_QUEUE' }, 201, { 'Retry-After': '10' })
    : url.endsWith('/status') ? response({ status: 'COMPLETED', error_type: 'INSUFFICIENT_CREDITS', error: KEY }) : response({ id: MODEL }) })
  const jobId = await f.queued(); const before = f.requests.length
  assert.equal((await f.manager.refresh({ jobId })).waiting, true); assert.equal(f.requests.length, before)
  f.advance(); const result = await f.manager.refresh({ jobId })
  assert.equal(result.job.status, 'FAILED'); assert.equal(result.job.errorType, 'INSUFFICIENT_CREDITS'); assert.doesNotMatch(JSON.stringify(result), new RegExp(KEY))
  assert.equal((await f.manager.output({ jobId })).code, 'COMFY_ROUTER_NOT_COMPLETE')
})

test('completed output uses one fixed authenticated result GET, verifies inline bytes and exposes no URL', async t => {
  const f = await fixture(t); const jobId = await f.queued(); f.advance(); await f.manager.refresh({ jobId })
  const result = await f.manager.output({ jobId })
  assert.equal(result.success, true); assert.equal(result.mimeType, 'image/png'); assert.deepEqual(Buffer.from(result.bytes), PNG)
  assert.match(result.filename, /^velorn-router-[a-z0-9-]+\.png$/)
  assert.equal(f.requests.at(-1).url, `https://api.comfy.org/v2/models/${MODEL}/requests/provider-job-one`)
  assert.equal(f.requests.at(-1).headers['X-API-Key'], KEY)
  assert.doesNotMatch(JSON.stringify(result), /https:|synthetic-router-key/)
  const marked = await f.manager.markImported({ jobId, assetId: 'asset-one' }); assert.equal(marked.job.importedAssetId, 'asset-one')
  assert.equal((await f.manager.output({ jobId })).success, true, 'Undo/deletion can legitimately require reimport')
})

test('URL, multiple images, invalid base64 and nonimage outputs fail without any URL fetch', async t => {
  for (const bad of [{ data: [{ url: 'https://evil.test/image.png' }] }, { data: [{ b64_json: PNG.toString('base64') }, { b64_json: PNG.toString('base64') }] },
    { data: [{ b64_json: '!!!!' }] }, { data: [{ b64_json: Buffer.from('<svg>not raster</svg>').toString('base64') }] }]) {
    const f = await fixture(t, { transport: async (url, request) => request.method === 'POST' ? response({ request_id: 'provider-job-one', status: 'IN_QUEUE' }, 201)
      : url.endsWith('/status') ? response({ status: 'COMPLETED' }) : url.endsWith('/provider-job-one') ? response(bad) : response({ id: MODEL }) })
    const jobId = await f.queued(); f.advance(); await f.manager.refresh({ jobId })
    assert.equal((await f.manager.output({ jobId })).code, 'COMFY_ROUTER_OUTPUT_UNVERIFIED')
    assert.ok(f.requests.every(r => r.url.startsWith('https://api.comfy.org/v2/models/')))
  }
})

test('native decoder must verify actual requested image dimensions before import', async t => {
  for (const validateImage of [undefined, () => ({ width: 0, height: 0 }), () => ({ width: 999999, height: 999999 }), () => { throw new Error('invalid codec') }]) {
    const f = await fixture(t, { validateImage }); const jobId = await f.queued(); f.advance(); await f.manager.refresh({ jobId })
    assert.equal((await f.manager.output({ jobId })).success, false)
  }
})

function syntheticWebp(width = 1024, height = 1024, extended = false) {
  const part = (type, bytes) => { const header = Buffer.alloc(8); header.write(type, 0, 'ascii'); header.writeUInt32LE(bytes.length, 4); return Buffer.concat([header, bytes, ...(bytes.length % 2 ? [Buffer.alloc(1)] : [])]) }
  const lossless = Buffer.alloc(5); lossless[0] = 0x2f; lossless.writeUInt32LE(((width - 1) | (height - 1) << 14) >>> 0, 1)
  const chunks = [part('VP8L', lossless)]
  if (extended) { const canvas = Buffer.alloc(10); canvas.writeUIntLE(1023, 4, 3); canvas.writeUIntLE(1023, 7, 3); chunks.unshift(part('VP8X', canvas)) }
  const body = Buffer.concat(chunks), header = Buffer.alloc(12); header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(body.length + 4, 4); header.write('WEBP', 8, 'ascii')
  return Buffer.concat([header, body])
}
function syntheticJpeg(width = 1024, height = 1024) {
  const data = Buffer.from([255, 216, 255, 192, 0, 11, 8, 4, 0, 4, 0, 1, 1, 0x11, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 0, 255, 217])
  data.writeUInt16BE(height, 7); data.writeUInt16BE(width, 9)
  return data
}
test('oversized/truncated/malformed PNG, JPEG and WebP headers never reach a decoder', async t => {
  const pngBomb = Buffer.from(PNG); pngBomb.writeUInt32BE(1000000, 16)
  const pngLength = Buffer.from(PNG); pngLength.writeUInt32BE(0xffffffff, 33)
  const pngDuplicate = Buffer.concat([PNG.subarray(0, 33), PNG.subarray(8, 33), PNG.subarray(33)])
  const jpegLength = syntheticJpeg(); jpegLength.writeUInt16BE(65535, 4)
  const webpLength = syntheticWebp(); webpLength.writeUInt32LE(0xffffffff, 16)
  const badImages = [pngBomb, pngLength, pngDuplicate, PNG.subarray(0, 33), PNG.subarray(0, PNG.length - 12), createRouterTestPng({ width: 1, height: 1 }),
    syntheticJpeg(65535, 65535), jpegLength, Buffer.from([255, 216, 255, 218]),
    syntheticWebp(16384, 16384), syntheticWebp(2048, 2048, true), webpLength, syntheticWebp().subarray(0, 20)]
  for (const image of badImages) {
    let decoded = 0
    const f = await fixture(t, { validateImage: () => { decoded++; return { width: 1024, height: 1024 } },
      transport: async (url, request) => request.method === 'POST' ? response({ request_id: 'provider-job-one', status: 'IN_QUEUE' }, 201)
        : url.endsWith('/status') ? response({ status: 'COMPLETED' }) : url.endsWith('/provider-job-one') ? response({ data: [{ b64_json: image.toString('base64') }] }) : response({ id: MODEL }) })
    const jobId = await f.queued(); f.advance(); await f.manager.refresh({ jobId })
    assert.equal((await f.manager.output({ jobId })).code, 'COMFY_ROUTER_OUTPUT_UNVERIFIED'); assert.equal(decoded, 0)
  }
})

test('bounded JPEG/WebP headers still require full codec verification', async t => {
  // These are header stubs, not valid images. A real codec must still reject
  // them: the parser is a memory-allocation bound, not image attestation.
  for (const image of [syntheticJpeg(), syntheticWebp(), syntheticWebp(1024, 1024, true)]) {
    let decoded = 0
    const f = await fixture(t, { validateImage: () => { decoded++; return null },
      transport: async (url, request) => request.method === 'POST' ? response({ request_id: 'provider-job-one', status: 'IN_QUEUE' }, 201)
        : url.endsWith('/status') ? response({ status: 'COMPLETED' }) : url.endsWith('/provider-job-one') ? response({ data: [{ b64_json: image.toString('base64') }] }) : response({ id: MODEL }) })
    const jobId = await f.queued(); f.advance(); await f.manager.refresh({ jobId })
    assert.equal((await f.manager.output({ jobId })).code, 'COMFY_ROUTER_OUTPUT_UNVERIFIED'); assert.equal(decoded, 1)
  }
})

test('oversized responses and misleading content-length are bounded', async t => {
  const f = await fixture(t, { transport: async () => response({ id: MODEL }, 200, { 'Content-Length': String(LIMITS.response + 1) }) })
  assert.equal((await f.manager.connect({ apiKey: KEY })).code, 'COMFY_ROUTER_RESPONSE')
  const g = await fixture(t, { transport: async () => new Response('x'.repeat(LIMITS.response + 1), { headers: { 'Content-Length': '1' } }) })
  assert.equal((await g.manager.connect({ apiKey: KEY })).code, 'COMFY_ROUTER_RESPONSE')
})

test('network cancellation/timeout cannot publish credentials or late results', async t => {
  let release, started
  const ready = new Promise(resolve => { started = resolve })
  const f = await fixture(t, { transport: () => { started(); return new Promise(resolve => { release = resolve }) } })
  const pending = f.manager.connect({ apiKey: KEY }); await ready; f.manager.cancelPending(); release(response({ id: MODEL }))
  assert.equal((await pending).code, 'COMFY_ROUTER_CANCELLED'); assert.equal((await f.manager.status({})).configured, false)
  const g = await fixture(t, { timeoutMs: 5, transport: () => new Promise(() => {}) })
  assert.equal((await g.manager.connect({ apiKey: KEY })).code, 'COMFY_ROUTER_CANCELLED')
})

test('corrupt and symlinked ledger fail closed without overwriting data', async t => {
  const f = await fixture(t)
  const target = path.join(f.storageDir, 'original.json'); await fs.writeFile(target, 'keep-me')
  await fs.symlink(target, path.join(f.storageDir, 'comfy-router-jobs.json'))
  assert.equal((await f.manager.status({})).code, 'COMFY_ROUTER_LEDGER')
  assert.equal(await fs.readFile(target, 'utf8'), 'keep-me')
  const g = await fixture(t); await fs.writeFile(path.join(g.storageDir, 'comfy-router-jobs.json'), '{invalid')
  assert.equal((await g.manager.status({})).code, 'COMFY_ROUTER_LEDGER')
  assert.equal(await fs.readFile(path.join(g.storageDir, 'comfy-router-jobs.json'), 'utf8'), '{invalid')
})
