'use strict'
// Create from the paired phone: the bridge in front of the real Router manager,
// and its routes on the phone connection's local server. The pretend Comfy is
// in memory; no real key, network, project or credit is involved.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { createComfyRouter, BUTTON_APPROVAL_USD, PHONE_CONFIRM_MAX_USD } = require('../electron/comfyRouter.cjs')
const { createMobileCreateBridge, LIMITS } = require('../electron/mobileCompanionCreate.cjs')
const { createMobileCompanionServer } = require('../electron/mobileCompanionServer.cjs')
const { validateRequest } = require('../electron/remoteCompanionDesktop.cjs')
const { METHODS } = require('../electron/comfyRouterIpc.cjs')
const { createRouterTestPng } = require('./helpers/routerImage.cjs')
const KEY = 'synthetic-router-key-one-never-real'
const P = 'A red fox trotting through a snowy pine forest'
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

async function fixture(t) {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-phone-create-test-'))
  const requests = [], approvals = []
  const state = { context: { session: 'session-one', projectKey: '/synthetic/project-one' }, policy: 'ask-cloud', time: Date.now(), busy: false,
    jobStatus: 'COMPLETED', result: null, decoded: null }
  const manager = createComfyRouter({ storageDir, getContext: async () => ({ ...state.context }), getPolicy: async () => state.policy,
    validateImage: async () => state.decoded, confirmSpend: async value => { approvals.push(value); return true }, now: () => state.time,
    fetchImpl: async (url, request) => {
      requests.push({ url, ...request })
      return url.endsWith('/estimate') ? response({ note: 'no quote' })
        : url.endsWith('/status') ? response({ status: state.jobStatus })
        : /\/requests\/provider-job-\d+$/.test(url) && request.method === 'GET' ? state.result()
        : request.method === 'POST' ? response({ request_id: `provider-job-${requests.filter(r => r.method === 'POST' && /\/requests$/.test(r.url)).length}`, status: 'IN_QUEUE' }, 201)
        : response({ id: 'model' })
    } })
  const cacheDir = path.join(storageDir, 'phone-cache')
  const bridge = createMobileCreateBridge({ getManager: () => manager, isBusy: () => state.busy, cacheDir, now: () => state.time })
  t.after(async () => { manager.dispose(); await fs.rm(storageDir, { recursive: true, force: true }) })
  assert.equal((await manager.connect({ apiKey: KEY })).success, true)
  requests.length = 0
  const submitted = () => requests.filter(r => r.method === 'POST' && /\/requests$/.test(r.url))
  return { manager, bridge, requests, approvals, state, cacheDir, submitted }
}
const quote = (f, extra = {}) => f.bridge.handle({ action: 'quote', modelId: 'gpt-image-2-5', choices: { prompt: P }, ...extra })
function pieces(bytes, size = LIMITS.chunkBytes) {
  const out = []
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size).toString('base64'))
  return out
}
function send(f, photoId, bytes, mimeType = 'image/png', size) {
  const parts = pieces(bytes, size)
  return parts.map((data, index) => f.bridge.upload({ photoId, index, total: parts.length, mimeType, data }))
}

test('the phone sees picture and video models only, with the tap limit and the spending mode', async t => {
  const f = await fixture(t)
  const catalog = await f.bridge.handle({ action: 'catalog' })
  assert.equal(catalog.success, true)
  assert.equal(catalog.connected, true); assert.equal(catalog.policy, 'ask-cloud'); assert.equal(catalog.buttonApprovalUsd, BUTTON_APPROVAL_USD)
  assert.ok(catalog.models.length >= 2)
  assert.deepEqual([...new Set(catalog.models.map(model => model.kind))].sort(), ['image', 'video'])
  assert.equal(JSON.stringify(catalog).includes(KEY), false)
  assert.equal((await f.bridge.handle({ action: 'catalog', extra: 1 })).code, 'CREATE_INVALID')
  assert.equal((await f.bridge.handle({ action: 'connect', apiKey: 'x' })).code, 'CREATE_INVALID', 'no key handling from the phone')
  assert.equal((await f.bridge.handle({ action: 'quote', modelId: 'eleven-v4', choices: { prompt: 'Hello', voice: 'rachel' } })).code, 'CREATE_INVALID', 'no sound models')
})

test('a tap on the priced button generates without any dialog on the computer, and the result reaches the phone', async t => {
  const f = await fixture(t)
  const plan = await quote(f)
  assert.equal(plan.success, true)
  assert.equal(plan.buttonApproval, true); assert.ok(plan.estimate.usd > 0 && plan.estimate.usd <= BUTTON_APPROVAL_USD)
  assert.equal(JSON.stringify(plan).includes(P), false, 'the prompt is not echoed back')
  assert.equal(f.submitted().length, 0, 'a price check sends nothing')
  const made = await f.bridge.handle({ action: 'generate', planId: plan.planId })
  assert.equal(made.success, true); assert.equal(made.jobs.length, 1)
  assert.deepEqual(f.approvals, [], 'no confirmation dialog was opened on the computer')
  assert.equal(f.submitted().length, 1)
  assert.equal(JSON.parse(f.submitted()[0].body).prompt, P)
  // The same tap again is the same request, not a second charge.
  const again = await f.bridge.handle({ action: 'generate', planId: plan.planId })
  assert.equal(again.success, true); assert.equal(again.repeated, true); assert.equal(f.submitted().length, 1)

  const bytes = createRouterTestPng({ width: 1536, height: 1024 })
  f.state.result = () => response({ data: [{ b64_json: bytes.toString('base64') }] }); f.state.decoded = { width: 1536, height: 1024 }
  f.state.time += 5000
  const listed = await f.bridge.handle({ action: 'jobs' })
  assert.equal(listed.success, true)
  const job = listed.jobs[0]
  assert.equal(job.status, 'COMPLETED'); assert.equal(job.kind, 'image'); assert.equal(job.savedToProject, false)
  assert.match(job.url, /^\/media\/create\/[a-f0-9]{48}$/); assert.equal(job.downloadUrl, `${job.url}/download`)
  assert.equal(job.url.includes(job.jobId), false, 'the phone asks by an opaque id, not the job id')
  const file = await f.bridge.open(job.url.split('/').pop())
  try {
    assert.equal(file.mime, 'image/png'); assert.equal(file.size, bytes.length); assert.match(file.name, /^velorn-create-[A-Za-z0-9_-]{8}\.png$/)
    assert.ok((await file.handle.readFile()).equals(bytes))
  } finally { await file.handle.close() }
  assert.equal((await f.bridge.handle({ action: 'jobs' })).jobs[0].ready, true)
  const fetched = f.requests.filter(r => r.method === 'GET' && /\/requests\/provider-job-1$/.test(r.url)).length
  const second = await f.bridge.open(job.url.split('/').pop()); await second.handle.close()
  assert.equal(f.requests.filter(r => r.method === 'GET' && /\/requests\/provider-job-1$/.test(r.url)).length, fetched, 'the result is collected from Comfy once')
  assert.equal(await f.bridge.open('f'.repeat(48)), null)
  assert.equal(await f.bridge.open('../../etc/passwd'), null)
  await f.bridge.clear()
  assert.deepEqual(await fs.readdir(f.cacheDir), [])
  assert.equal(await f.bridge.open(job.url.split('/').pop()), null)
})

test('above the tap limit the phone must confirm the exact price in a second step; one tap alone sends nothing', async t => {
  const f = await fixture(t)
  const catalog = await f.bridge.handle({ action: 'catalog' })
  assert.equal(catalog.phoneConfirmMaxUsd, PHONE_CONFIRM_MAX_USD)
  const video = catalog.models.filter(model => model.kind === 'video').map(model => ({ model, usd: Math.max(...Object.values(model.usdPerSecond)) * Math.max(...model.seconds.offered) }))
    .sort((a, b) => b.usd - a.usd)[0]
  assert.ok(video.usd > BUTTON_APPROVAL_USD && video.usd <= PHONE_CONFIRM_MAX_USD, 'the list has a clip between the tap limit and the phone limit')
  const resolution = Object.entries(video.model.usdPerSecond).sort((a, b) => b[1] - a[1])[0][0]
  const ask = () => f.bridge.handle({ action: 'quote', modelId: video.model.id, choices: { prompt: P, seconds: Math.max(...video.model.seconds.offered), resolution } })
  const plan = await ask()
  assert.equal(plan.success, true); assert.equal(plan.buttonApproval, false); assert.equal(plan.approval, 'confirm'); assert.ok(plan.estimate.usd > BUTTON_APPROVAL_USD)
  // One tap, as for a cheap request: refused, nothing sent, no dialog on the computer.
  const tapped = await f.bridge.handle({ action: 'generate', planId: plan.planId })
  assert.equal(tapped.success, false); assert.equal(tapped.code, 'COMFY_ROUTER_CONFIRM_REQUIRED')
  // A confirmation of some other amount is not a confirmation of this one.
  for (const confirmedUsd of [plan.estimate.usd - 0.01, plan.estimate.usd + 1, 0.5]) {
    assert.equal((await f.bridge.handle({ action: 'generate', planId: plan.planId, confirmedUsd })).code, 'COMFY_ROUTER_CONFIRM_REQUIRED')
  }
  for (const confirmedUsd of ['8.17', 0, -1, NaN, Infinity, null, true]) {
    assert.equal((await f.bridge.handle({ action: 'generate', planId: plan.planId, confirmedUsd })).code, 'CREATE_INVALID')
  }
  assert.deepEqual(f.approvals, []); assert.equal(f.submitted().length, 0)
  assert.equal((await f.bridge.handle({ action: 'jobs' })).jobs.length, 0)
  // The exact price, confirmed: sent once, still without any dialog on the computer.
  const made = await f.bridge.handle({ action: 'generate', planId: plan.planId, confirmedUsd: plan.estimate.usd })
  assert.equal(made.success, true); assert.equal(made.jobs.length, 1)
  assert.deepEqual(f.approvals, []); assert.equal(f.submitted().length, 1)
  assert.equal((await f.bridge.handle({ action: 'generate', planId: plan.planId, confirmedUsd: plan.estimate.usd })).repeated, true)
  assert.equal(f.submitted().length, 1, 'the same confirmation again is the same request')
  // A cheap request still needs only the tap, and Local only still blocks a confirmed one.
  const cheap = await quote(f)
  assert.equal(cheap.approval, 'tap')
  f.state.time += 60000
  const again = await ask()
  f.state.policy = 'local-only'
  assert.equal((await f.bridge.handle({ action: 'generate', planId: again.planId, confirmedUsd: again.estimate.usd })).code, 'COMFY_ROUTER_LOCAL_ONLY')
  assert.equal(f.submitted().length, 1)
})

test('a request with no set price, or above the phone limit, cannot be confirmed from the phone at all', async t => {
  const f = await fixture(t)
  const photo = createRouterTestPng({ width: 1024, height: 768 }), photoId = 'e'.repeat(32)
  send(f, photoId, photo)
  const unpriced = await quote(f, { photoId })
  assert.equal(unpriced.estimate, null); assert.equal(unpriced.approval, 'computer')
  const refused = await f.bridge.handle({ action: 'generate', planId: unpriced.planId, confirmedUsd: 1 })
  assert.equal(refused.code, 'COMFY_ROUTER_APPROVAL_UNAVAILABLE'); assert.match(refused.error, /on the computer/)
  // The manager applies the upper limit itself, whatever the bridge passes on.
  const plan = await f.manager.previewCreate({ modelId: 'gpt-image-2-5', choices: { prompt: P } })
  assert.equal((await f.manager.submitCreateRemote({ planId: plan.planId, confirmedUsd: 1, extra: true })).success, false)
  assert.equal((await f.manager.submitCreateRemote({ planId: plan.planId, somethingElse: 1 })).success, false)
  assert.ok(PHONE_CONFIRM_MAX_USD > BUTTON_APPROVAL_USD && PHONE_CONFIRM_MAX_USD <= 20)
  assert.deepEqual(f.approvals, []); assert.equal(f.submitted().length, 0)
})

test('Local only, an export, a foreign plan and a changed project all stop a phone request before anything is sent', async t => {
  const f = await fixture(t)
  const plan = await quote(f)
  f.state.policy = 'local-only'
  assert.equal((await f.bridge.handle({ action: 'generate', planId: plan.planId })).code, 'COMFY_ROUTER_LOCAL_ONLY')
  f.state.policy = 'ask-cloud'; f.state.busy = true
  assert.equal((await f.bridge.handle({ action: 'generate', planId: plan.planId })).code, 'CREATE_EXPORT_BUSY')
  assert.equal((await quote(f)).code, 'CREATE_EXPORT_BUSY')
  assert.equal((await f.bridge.handle({ action: 'jobs' })).success, true, 'reading the list is still allowed')
  f.state.busy = false
  // A plan made on the computer's own Create tab cannot be submitted from the phone.
  const desktop = await f.manager.previewCreate({ modelId: 'gpt-image-2-5', choices: { prompt: P } })
  assert.equal((await f.bridge.handle({ action: 'generate', planId: desktop.planId })).code, 'CREATE_PLAN_INVALID')
  f.state.context = { session: 'session-one', projectKey: '/synthetic/project-two' }
  assert.equal((await f.bridge.handle({ action: 'generate', planId: plan.planId })).success, false)
  assert.equal(f.submitted().length, 0)
  assert.equal(METHODS.includes('submitCreateRemote'), false, 'the phone approval path is not reachable from the window or agents')
})

test('a phone photo arrives in pieces and is sent only when the person generates', async t => {
  const f = await fixture(t)
  const photo = createRouterTestPng({ width: 1024, height: 768 }), photoId = 'a'.repeat(32)
  const parts = send(f, photoId, photo, 'image/png', 200)
  assert.ok(parts.length > 1)
  assert.deepEqual(parts.at(-1), { success: true, received: parts.length, complete: true })
  assert.equal(parts[0].complete, false)
  // A piece sent again after a lost reply is acknowledged and not stored twice.
  assert.deepEqual(f.bridge.upload({ photoId, index: 0, total: parts.length, mimeType: 'image/png', data: pieces(photo, 200)[0] }), { success: true, received: parts.length, complete: true })
  assert.equal((await quote(f, { choices: { prompt: P, picture: { mimeType: 'image/png', base64: photo.toString('base64') } } })).code, 'CREATE_INVALID', 'a picture can only come through the upload')
  assert.equal((await quote(f, { photoId: 'b'.repeat(32) })).code, 'CREATE_PHOTO_MISSING')
  // GPT Image has no set price for a request with a picture, so a tap cannot approve it.
  const unpriced = await quote(f, { photoId })
  assert.equal(unpriced.success, true); assert.equal(unpriced.estimate, null); assert.equal(unpriced.buttonApproval, false)
  assert.equal((await f.bridge.handle({ action: 'generate', planId: unpriced.planId })).code, 'COMFY_ROUTER_APPROVAL_UNAVAILABLE')
  assert.equal((await f.bridge.handle({ action: 'catalog' })).models.find(model => model.id === 'gpt-image-2-5').editQuote, false, 'the phone can tell which models those are')
  const plan = await quote(f, { photoId, modelId: 'nano-banana-2-1' })
  assert.equal(plan.success, true); assert.equal(plan.buttonApproval, true)
  assert.equal(f.requests.some(r => String(r.body || '').includes(photo.toString('base64'))), false, 'a price check never sends the photo')
  const made = await f.bridge.handle({ action: 'generate', planId: plan.planId })
  assert.equal(made.success, true)
  assert.equal(f.submitted().length, 1)
  assert.ok(f.submitted()[0].body.includes(photo.toString('base64')))
  f.state.time += LIMITS.photoMs + 1
  assert.equal((await quote(f, { photoId })).code, 'CREATE_PHOTO_MISSING', 'a held photo expires')
})

test('photo pieces are bounded, ordered and typed', async t => {
  const f = await fixture(t)
  const data = Buffer.alloc(300, 7).toString('base64'), ok = { photoId: 'c'.repeat(32), index: 0, total: 2, mimeType: 'image/jpeg', data }
  for (const bad of [{ ...ok, photoId: '../x' }, { ...ok, total: 0 }, { ...ok, total: LIMITS.photoChunks + 1 }, { ...ok, index: 2 }, { ...ok, mimeType: 'image/svg+xml' },
    { ...ok, data: '' }, { ...ok, data: 'not base64!' }, { ...ok, data: Buffer.alloc(LIMITS.chunkBytes + 3).toString('base64') }, { ...ok, extra: true }, null, []]) {
    assert.equal(f.bridge.upload(bad).code, 'CREATE_INVALID')
  }
  assert.equal(f.bridge.upload({ ...ok, index: 1 }).code, 'CREATE_PHOTO_MISSING', 'a photo cannot start in the middle')
  assert.equal(f.bridge.upload(ok).received, 1)
  assert.equal(f.bridge.upload({ ...ok, index: 1, mimeType: 'image/png' }).code, 'CREATE_INVALID', 'the type cannot change part way')
  // Too many bytes in total.
  const big = Buffer.alloc(LIMITS.chunkBytes, 1).toString('base64'), total = Math.ceil(LIMITS.photoBytes / LIMITS.chunkBytes) + 1
  let last
  for (let index = 0; index < total; index++) last = f.bridge.upload({ photoId: 'd'.repeat(32), index, total, mimeType: 'image/jpeg', data: big })
  assert.equal(last.code, 'CREATE_PHOTO_TOO_LARGE')
  // Only a couple of photos are held at once; the oldest is dropped.
  for (const letter of ['1', '2', '3']) assert.equal(f.bridge.upload({ photoId: letter.repeat(32), index: 0, total: 1, mimeType: 'image/jpeg', data }).complete, true)
  assert.equal((await quote(f, { photoId: '1'.repeat(32) })).code, 'CREATE_PHOTO_MISSING')
})

test('an unfinished request is refreshed when the phone reads the list, and can be cancelled', async t => {
  const f = await fixture(t)
  const plan = await quote(f)
  const made = await f.bridge.handle({ action: 'generate', planId: plan.planId })
  f.state.jobStatus = 'IN_PROGRESS'; f.state.time += 5000
  const running = (await f.bridge.handle({ action: 'jobs' })).jobs[0]
  assert.equal(running.status, 'IN_PROGRESS'); assert.equal(running.url, undefined)
  const cancelled = await f.bridge.handle({ action: 'cancel', jobId: made.jobs[0].jobId })
  assert.equal(typeof cancelled.success, 'boolean')
  assert.equal(f.requests.some(r => r.method === 'PUT'), true, 'the cancellation was asked of Comfy')
  assert.equal((await f.bridge.handle({ action: 'cancel', jobId: '../x' })).code, 'CREATE_INVALID')
})

// ---- The routes on the phone connection's local server ----
function call(status, route, { method = 'POST', value = {}, headers = {}, token } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${status.localUrl}${route}`, { method, headers: { Origin: status.localUrl, 'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => { const raw = Buffer.concat(chunks); let body; try { body = JSON.parse(raw.toString('utf8')) } catch { body = raw }; resolve({ status: res.statusCode, headers: res.headers, body }) })
    })
    req.on('error', reject); req.end(['GET', 'HEAD'].includes(method) ? undefined : typeof value === 'string' ? value : JSON.stringify(value))
  })
}
async function served(t, { withBridge = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-phone-create-server-'))
  await Promise.all(['live.html', 'live.js', 'live.css'].map(name => fs.writeFile(path.join(root, name), name)))
  const file = path.join(root, 'result.png'); await fs.writeFile(file, '0123456789abcdef')
  const seen = []
  const createBridge = { handle: async input => { seen.push(['handle', input]); return input.action === 'throw' ? Promise.reject(Error('private detail')) : { success: input.action !== 'refuse', echoed: input.action } },
    upload: input => { seen.push(['upload', input]); return { success: true, received: 1, complete: true } },
    open: async id => id === 'a'.repeat(48) ? { handle: await fs.open(file, 'r'), size: 16, mime: 'image/png', name: 'velorn-create-test.png' } : null }
  let remembered = null
  const api = createMobileCompanionServer({ clientRoot: root, port: 0, host: '127.0.0.1', networkInterfaces: () => ({ lan: [{ family: 'IPv4', address: '192.168.10.20' }] }),
    onMessage: () => ({ success: true }), onCommand: async () => ({ success: true, status: 'completed' }),
    deviceStore: { read: async () => remembered, write: async value => { remembered = { ...value } }, forget: async () => { remembered = null } },
    ...(withBridge ? { createBridge } : {}) })
  t.after(async () => { await api.stop(); await fs.rm(root, { recursive: true, force: true }) })
  const scope = { projectKey: '/private/project', conversationId: 'chat-one', session: 'renderer-one' }
  const status = await api.start(scope, { contextId: 'context-one', available: true })
  const token = (await call(status, '/api/pair', { value: { code: status.pairingCode } })).body.token
  return { api, scope, status, token, seen }
}

test('Create routes need the paired phone, the current context, and pass only their own fields to the bridge', async t => {
  const f = await served(t)
  const state = await call(f.status, '/api/state', { token: f.token })
  assert.deepEqual(state.body.create, { supported: true, version: 1 })
  assert.equal((await call(f.status, '/api/create', { value: { contextId: 'context-one', action: 'catalog' } })).status, 401)
  assert.equal((await call(f.status, '/api/create', { token: 'b'.repeat(64), value: { contextId: 'context-one', action: 'catalog' } })).status, 401)
  assert.equal((await call(f.status, '/api/create', { token: f.token, value: { action: 'catalog' } })).status, 409)
  assert.equal((await call(f.status, '/api/create', { token: f.token, value: { contextId: 'older-context', action: 'catalog' } })).body.error, 'STALE_CONTEXT')
  assert.equal((await call(f.status, '/api/create', { token: f.token, method: 'GET' })).status, 405)
  assert.deepEqual(f.seen, [])
  const ok = await call(f.status, '/api/create', { token: f.token, value: { contextId: 'context-one', action: 'catalog' } })
  assert.deepEqual([ok.status, ok.body], [200, { success: true, create: { success: true, echoed: 'catalog' } }])
  assert.deepEqual(f.seen.at(-1), ['handle', { action: 'catalog' }], 'the context id is checked here and not passed on')
  const refused = await call(f.status, '/api/create', { token: f.token, value: { contextId: 'context-one', action: 'refuse' } })
  assert.deepEqual([refused.status, refused.body.create.success], [200, false], 'a refusal is an answer the phone can show')
  const broke = await call(f.status, '/api/create', { token: f.token, value: { contextId: 'context-one', action: 'throw' } })
  assert.deepEqual([broke.status, broke.body], [500, { success: false, error: 'CREATE_FAILED' }])
  // Only the photo route takes a large body.
  const large = 'A'.repeat(300 * 1024)
  assert.equal((await call(f.status, '/api/create', { token: f.token, value: { contextId: 'context-one', action: 'quote', data: large } })).status, 413)
  const photo = await call(f.status, '/api/create/photo', { token: f.token, value: { contextId: 'context-one', photoId: 'a'.repeat(32), index: 0, total: 1, mimeType: 'image/jpeg', data: large } })
  assert.equal(photo.status, 200); assert.equal(photo.body.create.complete, true)
  assert.equal(f.seen.at(-1)[0], 'upload'); assert.equal(f.seen.at(-1)[1].data.length, large.length); assert.equal(f.seen.at(-1)[1].contextId, undefined)
  assert.equal((await call(f.status, '/api/create/photo', { token: f.token, value: { contextId: 'context-one', data: 'A'.repeat(400 * 1024) } })).status, 413)
  // While the desktop is not available, nothing reaches the bridge.
  const before = f.seen.length
  f.api.publish(f.scope, { contextId: 'context-one', available: false })
  assert.equal((await call(f.status, '/api/create', { token: f.token, value: { contextId: 'context-one', action: 'catalog' } })).status, 410)
  assert.equal(f.seen.length, before)
})

test('a finished Create result streams to the paired phone only, in ranges, by opaque id', async t => {
  const f = await served(t)
  const state = await call(f.status, '/api/state', { token: f.token }), cookie = state.headers['set-cookie'][0].split(';')[0]
  const url = `/media/create/${'a'.repeat(48)}`
  assert.equal((await call(f.status, url, { method: 'GET' })).status, 401)
  const head = await call(f.status, url, { method: 'HEAD', headers: { Cookie: cookie } })
  assert.deepEqual([head.status, head.headers['content-length'], head.headers['content-type']], [200, '16', 'image/png'])
  const part = await call(f.status, url, { method: 'GET', headers: { Cookie: cookie, Range: 'bytes=3-7' } })
  assert.deepEqual([part.status, String(part.body), part.headers['content-range']], [206, '34567', 'bytes 3-7/16'])
  const download = await call(f.status, `${url}/download`, { method: 'GET', headers: { Cookie: cookie, Range: 'bytes=0-15' } })
  assert.match(download.headers['content-disposition'], /velorn-create-test\.png/)
  assert.equal((await call(f.status, `/media/create/${'b'.repeat(48)}`, { method: 'GET', headers: { Cookie: cookie } })).body.error, 'CREATE_RESULT_UNAVAILABLE')
  // Create results are the person's own requests: they do not depend on review-media sharing.
  f.api.publish(f.scope, { contextId: 'context-one', available: true, shareReviewMedia: false })
  assert.equal((await call(f.status, url, { method: 'HEAD', headers: { Cookie: cookie } })).status, 200)
})

test('a server without the bridge offers no Create routes', async t => {
  const f = await served(t, { withBridge: false })
  assert.equal((await call(f.status, '/api/state', { token: f.token })).body.create, undefined)
  assert.equal((await call(f.status, '/api/create', { token: f.token, value: { contextId: 'context-one', action: 'catalog' } })).status, 404)
  const cookie = (await call(f.status, '/api/state', { token: f.token })).headers['set-cookie'][0].split(';')[0]
  assert.equal((await call(f.status, `/media/create/${'a'.repeat(48)}`, { method: 'GET', headers: { Cookie: cookie } })).status, 404)
})

test('the encrypted connection forwards only the Create routes that exist, with their own size limits', () => {
  const bearer = { authorization: `Bearer ${'a'.repeat(64)}`, 'content-type': 'application/json' }
  const post = (path, body) => validateRequest({ method: 'POST', path, headers: bearer, body: JSON.stringify(body) })
  assert.equal(post('/api/create', { action: 'catalog' }).api, true)
  assert.equal(post('/api/create/photo', { data: 'A'.repeat(350 * 1024) }).api, true)
  assert.throws(() => post('/api/create', { data: 'A'.repeat(21 * 1024) }), /Invalid request body/)
  assert.throws(() => post('/api/create/photo', { data: 'A'.repeat(385 * 1024) }), /Invalid request body/)
  assert.throws(() => post('/api/create/other', {}), /Route not supported/)
  assert.throws(() => validateRequest({ method: 'GET', path: '/api/create', headers: {} }), /Route not supported/)
  const id = 'c'.repeat(48)
  assert.ok(validateRequest({ method: 'HEAD', path: `/media/create/${id}`, headers: {} }).media)
  assert.ok(validateRequest({ method: 'GET', path: `/media/create/${id}/download`, headers: { range: 'bytes=0-262143' } }).media)
  assert.throws(() => validateRequest({ method: 'GET', path: `/media/create/${id}`, headers: {} }), /bounded media range/)
  assert.throws(() => validateRequest({ method: 'GET', path: `/media/create/${id}`, headers: { range: 'bytes=0-262144' } }), /bounded media range/)
  assert.throws(() => validateRequest({ method: 'POST', path: `/media/create/${id}`, headers: {}, body: '{}' }), /Route not supported/)
  assert.throws(() => validateRequest({ method: 'GET', path: '/media/create/../../etc', headers: {} }), /Route not supported/)
})

test('phone requests are marked beside the job record, not in it, and the mark survives a restart', async t => {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-phone-create-mark-'))
  t.after(() => fs.rm(storageDir, { recursive: true, force: true }))
  const make = () => createComfyRouter({ storageDir, getContext: async () => ({ session: 'session-one', projectKey: '/synthetic/project-one' }), getPolicy: async () => 'ask-cloud',
    validateImage: async () => null, confirmSpend: async () => true,
    fetchImpl: async (url, request) => url.endsWith('/estimate') ? response({ note: 'no quote' })
      : request.method === 'POST' ? response({ request_id: `provider-${Math.random().toString(36).slice(2, 10)}`, status: 'IN_QUEUE' }, 201) : response({ id: 'model' }) })
  let manager = make()
  assert.equal((await manager.connect({ apiKey: KEY })).success, true)
  const bridge = createMobileCreateBridge({ getManager: () => manager, cacheDir: path.join(storageDir, 'phone-cache') })
  const plan = await bridge.handle({ action: 'quote', modelId: 'gpt-image-2-5', choices: { prompt: P } })
  const fromPhone = (await bridge.handle({ action: 'generate', planId: plan.planId })).jobs[0].jobId
  const own = await manager.previewCreate({ modelId: 'gpt-image-2-5', choices: { prompt: `${P} again` } })
  const fromDesktop = (await manager.submitCreate({ planId: own.planId })).job.jobId
  const marks = async () => Object.fromEntries((await manager.list({})).jobs.map(job => [job.jobId, job.fromPhone === true]))
  assert.deepEqual(await marks(), { [fromPhone]: true, [fromDesktop]: false })
  // The job record keeps the shape an older Velorn reads.
  const ledger = JSON.parse(await fs.readFile(path.join(storageDir, 'comfy-router-jobs.json'), 'utf8'))
  assert.deepEqual(Object.keys(ledger).sort(), ['jobs', 'version'])
  for (const record of ledger.jobs) assert.equal(Object.keys(record).some(key => /phone|origin/i.test(key)), false)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(storageDir, 'comfy-router-phone-jobs.json'), 'utf8')), [fromPhone])
  manager.dispose(); manager = make()
  assert.equal((await manager.connect({ apiKey: KEY })).success, true)
  assert.deepEqual(await marks(), { [fromPhone]: true, [fromDesktop]: false })
  // A damaged list only loses the mark; the record still loads.
  manager.dispose(); await fs.writeFile(path.join(storageDir, 'comfy-router-phone-jobs.json'), '{not json'); manager = make()
  assert.equal((await manager.connect({ apiKey: KEY })).success, true)
  assert.deepEqual(await marks(), { [fromPhone]: false, [fromDesktop]: false })
  manager.dispose()
})

test('a finished picture can be the input of the next request without leaving the computer', async t => {
  const f = await fixture(t)
  assert.equal((await f.bridge.handle({ action: 'catalog' })).resultAsInput, true)
  const first = await quote(f, { modelId: 'nano-banana-2-1' })
  const made = await f.bridge.handle({ action: 'generate', planId: first.planId })
  const jobId = made.jobs[0].jobId
  // Not finished yet: nothing to reuse.
  assert.equal((await quote(f, { modelId: 'nano-banana-2-1', fromJobId: jobId })).code, 'CREATE_RESULT_UNAVAILABLE')
  const picture = createRouterTestPng({ width: 1376, height: 768 })
  f.state.result = () => response({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: picture.toString('base64') } }] } }] })
  f.state.decoded = { width: 1376, height: 768 }
  f.state.time += 5000
  assert.equal((await f.bridge.handle({ action: 'jobs' })).jobs[0].status, 'COMPLETED')
  // A picture into a clip, and a picture into a changed picture.
  const clip = await f.bridge.handle({ action: 'quote', modelId: 'seedance-2-0-mini', choices: { prompt: 'The fox starts to run', seconds: 5, resolution: '720p', pictureUse: 'start' }, fromJobId: jobId })
  assert.equal(clip.success, true, JSON.stringify(clip)); assert.equal(clip.kind, 'video')
  const before = f.submitted().length
  assert.equal(f.requests.slice(-3).some(r => String(r.body || '').includes(picture.toString('base64'))), false, 'a price check does not send the picture')
  const sent = await f.bridge.handle({ action: 'generate', planId: clip.planId })
  assert.equal(sent.success, true)
  assert.equal(f.submitted().length, before + 1)
  assert.ok(f.submitted().at(-1).body.includes(picture.toString('base64')), 'the stored result itself is what the model receives')
  assert.equal((await quote(f, { modelId: 'nano-banana-2-1', choices: { prompt: 'Make it night' }, fromJobId: jobId })).success, true)
  // Fences: not together with a phone photo, not an unknown or foreign request, not a path.
  assert.equal((await quote(f, { modelId: 'nano-banana-2-1', fromJobId: jobId, photoId: 'a'.repeat(32) })).code, 'CREATE_INVALID')
  for (const fromJobId of ['unknown-job', '../' + jobId, '', 7, null]) {
    assert.ok(['CREATE_RESULT_UNAVAILABLE', 'CREATE_INVALID'].includes((await quote(f, { modelId: 'nano-banana-2-1', fromJobId })).code), String(fromJobId))
  }
  const own = await f.manager.previewCreate({ modelId: 'gpt-image-2-5', choices: { prompt: P } })
  const desktopJob = (await f.manager.submitCreate({ planId: own.planId })).job.jobId
  assert.equal((await quote(f, { modelId: 'nano-banana-2-1', fromJobId: desktopJob })).code, 'CREATE_RESULT_UNAVAILABLE', 'only a result the phone has been shown')
  await f.bridge.clear()
  assert.equal((await quote(f, { modelId: 'nano-banana-2-1', fromJobId: jobId })).code, 'CREATE_RESULT_UNAVAILABLE')
})
