'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createComfyRouter, MODEL, BUTTON_APPROVAL_USD } = require('../electron/comfyRouter.cjs')
const { createRouterTestPng } = require('./helpers/routerImage.cjs')
const KEY = 'synthetic-router-key-one-never-real'
const P = 'A red fox trotting through a snowy pine forest'
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })

async function fixture(t, overrides = {}) {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-router-create-test-'))
  const requests = [], approvals = []
  // `quote` is what the pretend Comfy answers to a price question: a [low, high]
  // pair, an HTTP status to fail with, or null for "no usable answer".
  const state = { context: { session: 'session-one', projectKey: '/synthetic/project-one' }, policy: 'ask-cloud', time: Date.now(), approved: true,
    quote: null, statusHeaders: {}, result: null, decoded: null, file: null }
  const quoted = () => Array.isArray(state.quote)
    ? response({ currency: 'USD', min_amount: String(state.quote[0]), max_amount: String(state.quote[1]), source: 'estimated', pricing_as_of: '2026-11-20T10:00:00Z' })
    : typeof state.quote === 'number' ? response({ error: 'no' }, state.quote) : response({ note: 'no quote' })
  const transport = overrides.transport || (async (url, options) => !url.startsWith('https://api.comfy.org/') ? state.file(url, options)
    : url.endsWith('/estimate') ? quoted()
    : url.endsWith('/status') ? response({ status: 'COMPLETED' }, 200, state.statusHeaders)
    : url.endsWith('/requests/provider-job-one') && options.method === 'GET' ? state.result()
    : options.method === 'POST' ? response({ request_id: 'provider-job-one', status: 'IN_QUEUE' }, 201)
    : options.method === 'PUT' ? response({ status: 'CANCELLATION_REQUESTED' }, 202)
    : url.endsWith('/status') ? response({ status: 'COMPLETED' }) : response({ id: MODEL }))
  const options = { storageDir, getContext: async () => ({ ...state.context }), getPolicy: async () => state.policy,
    validateImage: async () => state.decoded,
    confirmSpend: async value => { approvals.push(value); return state.approved }, now: () => state.time,
    fetchImpl: async (url, request) => { requests.push({ url, ...request }); return transport(url, request) }, ...overrides }
  delete options.transport
  let manager = createComfyRouter(options)
  t.after(async () => { manager.dispose(); await fs.rm(storageDir, { recursive: true, force: true }) })
  assert.equal((await manager.connect({ apiKey: KEY })).success, true)
  requests.length = 0
  return { get manager() { return manager }, storageDir, requests, approvals, state,
    replace() { manager.dispose(); manager = createComfyRouter(options); return manager } }
}
const posts = f => f.requests.filter(r => r.method === 'POST' && !r.url.endsWith('/estimate'))
const quotes = f => f.requests.filter(r => r.url.endsWith('/estimate'))

test('a Create preview runs no model and reports the model, price and approval route', async t => {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: P, size: '2K' } })
  assert.equal(plan.success, true)
  assert.equal(plan.modelLabel, 'FLUX 3 Image')
  assert.equal(plan.model, 'bfl/flux-3-image')
  assert.deepEqual(plan.choices, { prompt: P, shape: 'landscape', size: '2K' })
  assert.equal(plan.estimate.usd, 0.143)
  assert.equal(plan.estimate.firm, true)
  assert.equal(plan.refusalCharged, 'no')
  assert.equal(plan.buttonApproval, true)
  assert.equal(plan.requiresNativeApproval, false)
  assert.equal(posts(f).length, 0)
  assert.equal(plan.estimate.basis, 'quote')
})

test('a live quote is asked for with a stand-in description, never the person\'s own', async t => {
  const f = await fixture(t)
  f.state.quote = [0.2, 0.21]
  const plan = await f.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: P, shape: 'portrait', size: '2K' } })
  assert.equal(quotes(f).length, 1)
  const asked = quotes(f)[0]
  assert.equal(asked.url, 'https://api.comfy.org/v2/models/bfl/flux-3-image/estimate')
  assert.equal(asked.method, 'POST')
  assert.equal(asked.headers['Idempotency-Key'], undefined)
  assert.ok(!asked.body.includes(P))
  const sent = JSON.parse(asked.body)
  assert.equal(sent.aspect_ratio, '9:16')
  assert.equal(sent.resolution, '2k')
  assert.deepEqual({ usd: plan.estimate.usd, firm: plan.estimate.firm, basis: plan.estimate.basis, asOf: plan.estimate.asOf },
    { usd: 0.21, firm: true, basis: 'live', asOf: '2026-11-20' })
  assert.match(plan.estimate.label, /^About \$0\.21 .*Quoted by Comfy 2026-11-20/)
  assert.equal(posts(f).length, 0)
})

test('a live quote above the limit brings back the confirmation box even when the record says less', async t => {
  const f = await fixture(t)
  f.state.quote = [2.4, 2.45]
  const plan = await f.manager.previewCreate({ modelId: 'seedance-2-5', choices: { prompt: P } })
  assert.equal(plan.buttonApproval, false)
  const result = await f.manager.submitCreate({ planId: plan.planId })
  assert.equal(result.approval, 'dialog')
  assert.equal(f.approvals[0].estimate.usd, 2.45)
})

test('a wide range keeps the recorded price when it fits, and gives no price when it does not', async t => {
  const f = await fixture(t)
  f.state.quote = [0.00005, 2.11]
  const fits = await f.manager.previewCreate({ modelId: 'nano-banana-2-1', choices: { prompt: P } })
  assert.equal(fits.estimate.usd, 0.055)
  assert.equal(fits.estimate.firm, false)
  assert.deepEqual(fits.estimate.range, { low: 0.00005, high: 2.11 })
  assert.match(fits.estimate.label, /^Usually about \$0\.06 /)
  assert.equal(fits.buttonApproval, true)
  f.state.quote = [0.5, 3]
  const moved = await f.manager.previewCreate({ modelId: 'nano-banana-2-1', choices: { prompt: P } })
  assert.equal(moved.estimate, null)
  assert.equal(moved.requiresNativeApproval, true)
})

test('when Comfy cannot quote, the recorded price is used; a rejected key is reported', async t => {
  const f = await fixture(t)
  for (const quote of [500, 429, 402, null, [5, 1], ['x', 'y']]) {
    f.state.quote = quote
    const plan = await f.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: P } })
    assert.equal(plan.success, true, `quote ${JSON.stringify(quote)}`)
    assert.deepEqual([plan.estimate.usd, plan.estimate.basis], [0.06864, 'quote'])
  }
  f.state.quote = 401
  assert.equal((await f.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: P } })).code, 'COMFY_ROUTER_AUTH')
})

test('"Local only" asks Comfy for nothing, not even a quote', async t => {
  const f = await fixture(t)
  f.state.policy = 'local-only'
  f.state.quote = [0.2, 0.21]
  const plan = await f.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: P } })
  assert.equal(plan.estimate.usd, 0.06864)
  assert.equal(f.requests.length, 0)
})

test('the charge Comfy reports is stored with the job', async t => {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId: 'nano-banana-2-1', choices: { prompt: P } })
  const { job } = await f.manager.submitCreate({ planId: plan.planId })
  assert.equal(job.chargedCredits, undefined)
  f.state.time += 5000
  f.state.statusHeaders = { 'x-comfy-credits-used': '11.64' }
  const refreshed = await f.manager.refresh({ jobId: job.jobId })
  assert.equal(refreshed.job.chargedCredits, 11.64)
  assert.equal(refreshed.job.chargedUsd, 0.0552)
  const saved = JSON.parse(await fs.readFile(path.join(f.storageDir, 'comfy-router-jobs.json'), 'utf8'))
  assert.equal(saved.jobs[0].create.credits, 11.64)
  f.state.time += 5000
  f.state.statusHeaders = { 'x-comfy-credits-used': 'lots' }
  assert.equal((await f.manager.refresh({ jobId: job.jobId })).job.chargedCredits, 11.64)
  assert.equal((await f.replace().list({})).jobs[0].chargedCredits, 11.64)
})

test('a person\'s click under the limit posts once to the chosen model without the confirmation box', async t => {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId: 'seedance-2-5', choices: { prompt: P } })
  assert.ok(plan.estimate.usd <= BUTTON_APPROVAL_USD)
  const result = await f.manager.submitCreate({ planId: plan.planId })
  assert.equal(result.success, true)
  assert.equal(result.approval, 'button')
  assert.equal(f.approvals.length, 0)
  assert.equal(posts(f).length, 1)
  const post = posts(f)[0]
  assert.equal(post.url, 'https://api.comfy.org/v2/models/byteplus/dreamina-seedance-2-5-260628/requests')
  assert.equal(post.headers['X-API-Key'], KEY)
  assert.equal(post.headers['Idempotency-Key'], result.job.jobId)
  assert.deepEqual(JSON.parse(post.body), { content: [{ type: 'text', text: P }], duration: 5, ratio: '16:9', resolution: '720p', watermark: false })
  assert.equal(result.job.modelLabel, 'Seedance 2.5')
  assert.equal(result.job.kind, 'video')
  assert.equal(result.job.status, 'IN_QUEUE')
  const again = await f.manager.submitCreate({ planId: plan.planId })
  assert.equal(again.repeated, true)
  assert.equal(posts(f).length, 1)
})

test('above the limit the confirmation box still asks, and declining sends nothing', async t => {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId: 'seedance-2-5', choices: { prompt: P, seconds: 10 } })
  assert.ok(plan.estimate.usd > BUTTON_APPROVAL_USD)
  assert.equal(plan.requiresNativeApproval, true)
  f.state.approved = false
  const declined = await f.manager.submitCreate({ planId: plan.planId })
  assert.equal(declined.code, 'COMFY_ROUTER_DECLINED')
  assert.equal(f.approvals.length, 1)
  assert.equal(f.approvals[0].modelLabel, 'Seedance 2.5')
  assert.equal(f.approvals[0].estimate.usd, plan.estimate.usd)
  assert.equal(posts(f).length, 0)
  f.state.approved = true
  const second = await f.manager.previewCreate({ modelId: 'seedance-2-5', choices: { prompt: P, seconds: 10 } })
  const approved = await f.manager.submitCreate({ planId: second.planId })
  assert.equal(approved.approval, 'dialog')
  assert.equal(posts(f).length, 1)
})

test('with no price on record the confirmation box asks', async t => {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId: 'nano-banana-2-1', choices: { prompt: P, size: '4K' } })
  assert.equal(plan.estimate, null)
  assert.equal(plan.buttonApproval, false)
  const result = await f.manager.submitCreate({ planId: plan.planId })
  assert.equal(result.approval, 'dialog')
  assert.equal(f.approvals.length, 1)
  assert.equal(f.approvals[0].refusalCharged, 'yes')
})

test('the agent path always asks, even for a few cents', async t => {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId: 'seedream-5-0-flash', choices: { prompt: P } })
  assert.equal(plan.buttonApproval, true)
  const result = await f.manager.submit({ planId: plan.planId })
  assert.equal(result.success, true)
  assert.equal(result.approval, 'dialog')
  assert.equal(f.approvals.length, 1)
})

test('the button route cannot be used for the original fixed image request', async t => {
  const f = await fixture(t)
  const plan = await f.manager.preview({ prompt: P })
  const result = await f.manager.submitCreate({ planId: plan.planId })
  assert.equal(result.code, 'COMFY_ROUTER_INVALID')
  assert.equal(posts(f).length, 0)
})

test('"Local only" blocks a Create request before any approval or post', async t => {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: P } })
  f.state.policy = 'local-only'
  const result = await f.manager.submitCreate({ planId: plan.planId })
  assert.equal(result.code, 'COMFY_ROUTER_LOCAL_ONLY')
  assert.equal(f.approvals.length, 0)
  assert.equal(posts(f).length, 0)
  assert.equal(quotes(f).length, 1)
})

test('bad choices and secret-looking descriptions are refused at preview', async t => {
  const f = await fixture(t)
  for (const payload of [
    { modelId: 'missing', choices: { prompt: P } },
    { modelId: 'seedance-2-0-mini', choices: { prompt: P, resolution: '1080p' } },
    { modelId: 'seedream-5-0-pro', choices: { prompt: P, size: '4K' } },
    { modelId: 'flux-3-image', choices: { prompt: `use ${KEY}` } },
    { modelId: 'flux-3-image', choices: { prompt: 'Bearer abcdefghijklmnop' } },
    { modelId: 'flux-3-image', choices: { prompt: P }, extra: true },
    { modelId: 'flux-3-image' }
  ]) assert.equal((await f.manager.previewCreate(payload)).code, 'COMFY_ROUTER_INVALID')
  assert.equal(f.requests.length, 0)
})

test('an unclear outcome is recorded and blocks another request, as before', async t => {
  const f = await fixture(t, { transport: async (url, options) => { if (options.method === 'POST' && !url.endsWith('/estimate')) throw new Error('socket closed'); return response({ id: MODEL }) } })
  const plan = await f.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: P } })
  const result = await f.manager.submitCreate({ planId: plan.planId })
  assert.equal(result.code, 'COMFY_ROUTER_UNCERTAIN')
  assert.equal(result.job.status, 'UNCERTAIN')
  const next = await f.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: P } })
  assert.equal((await f.manager.submitCreate({ planId: next.planId })).code, 'COMFY_ROUTER_UNCERTAIN')
  assert.equal(posts(f).length, 1)
})

test('a Create job survives a restart and is checked and cancelled on its own model', async t => {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: P } })
  const { job } = await f.manager.submitCreate({ planId: plan.planId })
  const saved = JSON.parse(await fs.readFile(path.join(f.storageDir, 'comfy-router-jobs.json'), 'utf8'))
  assert.deepEqual(saved.jobs[0].create, { modelId: 'flux-3-image', usd: 0.06864 })
  assert.equal(saved.jobs[0].model, 'bfl/flux-3-image')
  assert.ok(!JSON.stringify(saved).includes(P) && !JSON.stringify(saved).includes(KEY))
  const manager = f.replace()
  await manager.connect({ apiKey: KEY })
  f.requests.length = 0
  f.state.time += 5000
  const listed = (await manager.list({})).jobs
  assert.equal(listed.length, 1)
  assert.equal(listed[0].modelLabel, 'FLUX 3 Image')
  const refreshed = await manager.refresh({ jobId: job.jobId })
  assert.equal(refreshed.job.status, 'COMPLETED')
  assert.equal(f.requests[0].url, 'https://api.comfy.org/v2/models/bfl/flux-3-image/requests/provider-job-one/status')
})

test('a saved record that names a model outside the list is rejected', async t => {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: P } })
  await f.manager.submitCreate({ planId: plan.planId })
  const file = path.join(f.storageDir, 'comfy-router-jobs.json')
  const saved = JSON.parse(await fs.readFile(file, 'utf8'))
  saved.jobs[0].model = 'bfl/some-other-model'
  await fs.writeFile(file, JSON.stringify(saved))
  const manager = f.replace()
  assert.equal((await manager.list({})).code, 'COMFY_ROUTER_LEDGER')
})

// ---- collecting a finished picture -------------------------------------
async function finished(t, modelId, choices = {}) {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId, choices: { prompt: P, ...choices } })
  const { job } = await f.manager.submitCreate({ planId: plan.planId })
  f.state.time += 5000
  assert.equal((await f.manager.refresh({ jobId: job.jobId })).job.outputAvailable, true)
  f.requests.length = 0
  return { f, job }
}
const png = (width, height) => createRouterTestPng({ width, height })
const openai = bytes => () => response({ data: [{ b64_json: bytes.toString('base64') }] })
const gemini = (...parts) => () => response({ candidates: [{ content: { parts } }] })
const inline = bytes => ({ inlineData: { mimeType: 'image/png', data: bytes.toString('base64') } })

test('GPT Image and Seedream pictures are saved only at the pixel size that was asked for', async t => {
  for (const [modelId, width, height] of [['gpt-image-2-5', 1536, 1024], ['seedream-5-0-pro', 1376, 768], ['seedream-4-0', 1376, 768]]) {
    const { f, job } = await finished(t, modelId)
    const bytes = png(width, height)
    f.state.result = openai(bytes); f.state.decoded = { width, height }
    const output = await f.manager.output({ jobId: job.jobId })
    assert.equal(output.success, true, modelId)
    assert.deepEqual([output.mimeType, output.width, output.height, output.filename], ['image/png', width, height, `velorn-router-${job.jobId}.png`])
    assert.ok(Buffer.from(output.bytes).equals(bytes))
    assert.equal(f.requests.length, 1)
    assert.match(f.requests[0].url, /\/requests\/provider-job-one$/)
    f.state.result = openai(png(1024, 1024)); f.state.decoded = { width: 1024, height: 1024 }
    assert.equal((await f.manager.output({ jobId: job.jobId })).code, 'COMFY_ROUTER_OUTPUT_UNVERIFIED', `${modelId} wrong size`)
  }
})

test('a Nano Banana picture is saved at whatever size it declares, within bounds', async t => {
  const { f, job } = await finished(t, 'nano-banana-2-1')
  f.state.result = gemini({ text: 'Here is your picture.' }, inline(png(1376, 768))); f.state.decoded = { width: 1376, height: 768 }
  const output = await f.manager.output({ jobId: job.jobId })
  assert.deepEqual([output.success, output.width, output.height], [true, 1376, 768])
})

test('a picture is refused when the reply holds none, several, or one that does not decode as declared', async t => {
  const { f, job } = await finished(t, 'nano-banana-2-1')
  const good = png(1376, 768)
  f.state.decoded = { width: 1376, height: 768 }
  for (const result of [gemini({ text: 'I cannot make that.' }), gemini(inline(good), inline(good)), () => response({ candidates: [] }),
    gemini({ inlineData: { mimeType: 'image/png', data: 'not base64!' } }), gemini(inline(Buffer.from('plain text, not a picture'))),
    gemini({ fileData: { fileUri: 'https://example.com/picture.png' } }), () => response({ error: 'failed' })]) {
    f.state.result = result
    assert.equal((await f.manager.output({ jobId: job.jobId })).code, 'COMFY_ROUTER_OUTPUT_UNVERIFIED')
  }
  f.state.result = gemini(inline(good))
  for (const decoded of [null, { width: 768, height: 1376 }, { width: 1376, height: 768, valid: false }]) {
    f.state.decoded = decoded
    assert.equal((await f.manager.output({ jobId: job.jobId })).code, 'COMFY_ROUTER_OUTPUT_UNVERIFIED')
  }
  assert.ok(f.requests.every(r => r.url.startsWith('https://api.comfy.org/')))
})

test('a result that is not ready yet is reported as waiting, and the charge on the result is stored', async t => {
  const { f, job } = await finished(t, 'gpt-image-2-5', { shape: 'square' })
  f.state.result = () => response({ status: 'IN_PROGRESS' }, 202)
  assert.equal((await f.manager.output({ jobId: job.jobId })).code, 'COMFY_ROUTER_NOT_COMPLETE')
  const bytes = png(1024, 1024)
  f.state.result = () => response({ data: [{ b64_json: bytes.toString('base64') }] }, 200, { 'x-comfy-credits-used': '4.07' })
  f.state.decoded = { width: 1024, height: 1024 }
  assert.equal((await f.manager.output({ jobId: job.jobId })).success, true)
  assert.equal((await f.manager.list({})).jobs[0].chargedCredits, 4.07)
})

const STORE = 'https://storage.googleapis.com/partner-nodes-assets/a/b/c/d/result'
const flux = link => () => response({ id: 'task', status: 'Ready', result: { sample: link } })
const seedance = link => () => response({ id: 'task', status: 'succeeded', output_format: 'mp4', content: { video_url: link } })
const raw = (bytes, status = 200) => () => new Response(bytes, { status })
function mp4(length = 8192, brand = 'isom') {
  const data = Buffer.alloc(length, 1)
  data.writeUInt32BE(24, 0); data.write('ftyp', 4, 'ascii'); data.write(brand, 8, 'ascii')
  return data
}

test('a FLUX picture is fetched from Comfy\'s result storage without the key, then checked like any other', async t => {
  const { f, job } = await finished(t, 'flux-3-image')
  const bytes = png(1376, 768), link = `${STORE}.png?Expires=1&GoogleAccessId=x&Signature=y`
  f.state.result = flux(link); f.state.file = raw(bytes); f.state.decoded = { width: 1376, height: 768 }
  const output = await f.manager.output({ jobId: job.jobId })
  assert.deepEqual([output.success, output.mimeType, output.width, output.height], [true, 'image/png', 1376, 768])
  assert.ok(Buffer.from(output.bytes).equals(bytes))
  assert.equal(f.requests.length, 2)
  const fetched = f.requests[1]
  assert.equal(fetched.url, link)
  assert.deepEqual(fetched.headers, {})
  assert.equal(fetched.redirect, 'error')
  assert.equal(fetched.method, 'GET')
  assert.ok(!JSON.stringify(output, (k, v) => k === 'bytes' ? undefined : v).includes('storage.googleapis.com'))
  const saved = await fs.readFile(path.join(f.storageDir, 'comfy-router-jobs.json'), 'utf8')
  assert.ok(!saved.includes('googleapis') && !saved.includes('Signature'))
})

test('a Seedance clip is fetched and accepted only as an MP4 or MOV file', async t => {
  const { f, job } = await finished(t, 'seedance-2-0-mini')
  f.state.result = seedance(`${STORE}.mp4?Signature=y`)
  f.state.file = raw(mp4())
  const output = await f.manager.output({ jobId: job.jobId })
  assert.deepEqual([output.success, output.kind, output.mimeType, output.filename], [true, 'video', 'video/mp4', `velorn-router-${job.jobId}.mp4`])
  assert.equal(output.bytes.length, 8192)
  f.state.file = raw(mp4(8192, 'qt  '))
  assert.equal((await f.manager.output({ jobId: job.jobId })).mimeType, 'video/quicktime')
  for (const bad of [Buffer.from('<html>not a video</html>'.padEnd(8192, ' ')), png(1024, 1024), mp4(64), Buffer.alloc(0)]) {
    f.state.file = raw(bad)
    assert.equal((await f.manager.output({ jobId: job.jobId })).code, 'COMFY_ROUTER_OUTPUT_UNVERIFIED')
  }
})

test('a link anywhere but Comfy\'s result storage is refused and never fetched', async t => {
  const { f, job } = await finished(t, 'flux-3-image')
  f.state.file = () => assert.fail('a refused link was fetched')
  for (const link of [
    'https://delivery.bfl.ai/results/picture.png?sig=1',
    'http://storage.googleapis.com/partner-nodes-assets/a/picture.png',
    'https://storage.googleapis.com/some-other-bucket/a/picture.png',
    'https://storage.googleapis.com/partner-nodes-assets/',
    'https://storage.googleapis.com/partner-nodes-assets/../other-bucket/picture.png',
    'https://storage.googleapis.com.example.com/partner-nodes-assets/a/picture.png',
    'https://user:pass@storage.googleapis.com/partner-nodes-assets/a/picture.png',
    'https://storage.googleapis.com:8443/partner-nodes-assets/a/picture.png',
    'https://partner-nodes-assets.storage.googleapis.com/a/picture.png',
    'file:///etc/passwd', 'data:image/png;base64,AAAA', '', 42, null
  ]) {
    f.state.result = flux(link)
    assert.equal((await f.manager.output({ jobId: job.jobId })).code, 'COMFY_ROUTER_OUTPUT_UNVERIFIED', String(link))
  }
  assert.ok(f.requests.every(r => r.url.startsWith('https://api.comfy.org/')))
})

test('a refused, failed or oversized download imports nothing', async t => {
  const { f, job } = await finished(t, 'flux-3-image')
  f.state.decoded = { width: 1376, height: 768 }
  f.state.result = () => response({ id: 'task', status: 'Content Moderated', result: null })
  assert.equal((await f.manager.output({ jobId: job.jobId })).code, 'COMFY_ROUTER_OUTPUT_UNVERIFIED')
  f.state.result = flux(`${STORE}.png?Signature=y`)
  f.state.file = raw(Buffer.from('gone'), 403)
  assert.equal((await f.manager.output({ jobId: job.jobId })).code, 'COMFY_ROUTER_OUTPUT_UNVERIFIED')
  f.state.file = async () => { throw new Error('redirect was refused') }
  assert.equal((await f.manager.output({ jobId: job.jobId })).code, 'COMFY_ROUTER_OUTPUT_UNVERIFIED')
  f.state.file = raw(Buffer.alloc(20 * 1024 * 1024 + 1))
  assert.equal((await f.manager.output({ jobId: job.jobId })).code, 'COMFY_ROUTER_RESPONSE')
  f.state.file = raw(png(1024, 1024)); f.state.decoded = { width: 512, height: 512 }
  assert.equal((await f.manager.output({ jobId: job.jobId })).code, 'COMFY_ROUTER_OUTPUT_UNVERIFIED')
})

// ---- one input picture ---------------------------------------------------
const picture = (width = 512, height = 512) => ({ mimeType: 'image/png', base64: png(width, height).toString('base64') })

test('a request with a picture is priced from the record, and the picture is not sent before the click', async t => {
  const f = await fixture(t)
  f.state.quote = [0.2, 0.21]
  const pic = picture()
  const plan = await f.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: P, picture: pic } })
  assert.equal(plan.success, true)
  assert.equal(f.requests.length, 0)
  assert.deepEqual([plan.estimate.usd, plan.estimate.firm], [0.06864, false])
  assert.match(plan.estimate.label, /^Usually about/)
  assert.equal(plan.choices.hasPicture, true)
  assert.ok(!JSON.stringify(plan).includes(pic.base64))
  const result = await f.manager.submitCreate({ planId: plan.planId })
  assert.equal(result.approval, 'button')
  assert.deepEqual(JSON.parse(posts(f)[0].body).images, [pic.base64])
  assert.ok(!JSON.stringify(result).includes(pic.base64))
  assert.ok(!(await fs.readFile(path.join(f.storageDir, 'comfy-router-jobs.json'), 'utf8')).includes(pic.base64))
})

test('a GPT Image edit has no price, so the confirmation box asks', async t => {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId: 'gpt-image-2-5', choices: { prompt: P, picture: picture() } })
  assert.equal(plan.estimate, null)
  const result = await f.manager.submitCreate({ planId: plan.planId })
  assert.equal(result.approval, 'dialog')
  assert.equal(f.approvals[0].choices.hasPicture, true)
  assert.ok(!JSON.stringify(f.approvals[0], (k, v) => k === 'signal' ? undefined : v).includes('iVBOR'))
})

test('a picture that is mislabelled, too small or not a picture is refused before anything is sent', async t => {
  const f = await fixture(t)
  const good = picture()
  for (const bad of [{ ...good, mimeType: 'image/jpeg' }, picture(128, 128), picture(2048, 200),
    { mimeType: 'image/png', base64: Buffer.from('<svg onload="x"/>').toString('base64') }]) {
    assert.equal((await f.manager.previewCreate({ modelId: 'nano-banana-2-1', choices: { prompt: P, picture: bad } })).code, 'COMFY_ROUTER_INVALID')
  }
  assert.equal((await f.manager.previewCreate({ modelId: 'seedance-2-5', choices: { prompt: P, picture: good, pictureUse: 'reference' } })).success, true)
  assert.equal(f.requests.length, 0)
})

// ---- the list and bridge the screen uses ---------------------------------
test('the screen can read the Create list without a key or a project', async t => {
  const f = await fixture(t)
  await f.manager.clear({})
  f.state.context = { session: 'session-one', projectKey: null }
  f.requests.length = 0
  const listed = await f.manager.models({})
  assert.equal(listed.success, true)
  assert.equal(listed.models.filter(m => ['image', 'video'].includes(m.kind)).length, 12)
  assert.equal(listed.buttonApprovalUsd, BUTTON_APPROVAL_USD)
  assert.equal(listed.creditsPerUsd, 211)
  const byId = Object.fromEntries(listed.models.map(m => [m.id, m]))
  assert.deepEqual(listed.models.filter(m => m.default).map(m => m.name), ['Seedance 2.5', 'Nano Banana 2.1', 'Eleven V4', 'Eleven Sound Effects'])
  assert.deepEqual(byId['seedream-5-0-pro'].sizes, ['1K', '2K'])
  assert.deepEqual(byId['seedance-2-5'].resolutions, ['720p', '1080p'])
  assert.deepEqual(byId['seedance-2-0'].seconds, { min: 4, max: 15, offered: [5, 10] })
  assert.deepEqual([byId['gpt-image-2-5'].editQuote, byId['nano-banana-2-1'].firmQuote, byId['flux-3-image'].refusalCharged], [false, false, 'no'])
  assert.ok(!JSON.stringify(listed).includes('byteplus/'))
  assert.equal(f.requests.length, 0)
})

test('the preload forwards Generate only during a live click, and the bridge registers the Create channels', async () => {
  const { METHODS } = require('../electron/comfyRouterIpc.cjs')
  for (const name of ['models', 'previewCreate', 'submitCreate']) assert.ok(METHODS.includes(name))
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  const invoked = []
  let bridge
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'electronAPI') bridge = value } },
    ipcRenderer: { invoke: async (channel, payload) => { invoked.push([channel, payload]); return { success: true } }, on() {}, removeListener() {}, sendSync: () => null, send() {} } }
  const runtime = { navigator: { userActivation: { isActive: false } } }
  require('node:vm').runInNewContext(`(function(require,globalThis,process,console){${source}\n})`, {})(name => name === 'electron' ? electron : require(name), runtime, { platform: 'linux', versions: {}, env: {} }, console)
  await assert.rejects(Promise.resolve().then(() => bridge.comfyRouter.submitCreate({ planId: 'p' })), /user gesture/)
  assert.deepEqual(invoked, [])
  await bridge.comfyRouter.previewCreate({ modelId: 'flux-3-image', choices: { prompt: 'x' } })
  await bridge.comfyRouter.models({})
  runtime.navigator.userActivation.isActive = true
  await bridge.comfyRouter.submitCreate({ planId: 'p' })
  assert.deepEqual(invoked.map(i => i[0]), ['comfy-router:previewCreate', 'comfy-router:models', 'comfy-router:submitCreate'])
})

test('the credit balance is read with the key inside the main process and handed out only as a number', async t => {
  const answers = { value: () => response({ amount_micros: 30000, effective_balance_micros: 30056, currency: 'usd' }) }
  const f = await fixture(t, { transport: async (url, options) => url === 'https://api.comfy.org/customers/balance' ? answers.value(url, options) : response({ id: 'ok' }) })
  const seen = await f.manager.balance({})
  // 300.56 dollars at 211 credits a dollar. The fields are named "micros" but hold cents.
  assert.deepEqual(seen, { success: true, connected: true, known: true, credits: 63418.16, usd: 300.56 })
  const asked = f.requests.at(-1)
  assert.deepEqual([asked.url, asked.method, asked.body], ['https://api.comfy.org/customers/balance', 'GET', undefined])
  assert.equal(asked.headers['X-API-Key'], KEY)
  assert.equal(JSON.stringify(seen).includes(KEY), false)
  assert.equal(posts(f).length, 0) // Nothing is sent that could cost anything.
  // Without the "effective" figure the plain amount is used.
  answers.value = () => response({ amount_micros: 211 })
  assert.deepEqual(await f.manager.balance({}), { success: true, connected: true, known: true, credits: 445.21, usd: 2.11 })
  // Every way of not knowing is the same quiet answer, never a guess.
  for (const unknown of [() => response({ balance: 'lots' }), () => response({ amount_micros: -5 }), () => response({ amount_micros: 100, currency: 'eur' }),
    () => response({ error: 'no' }, 401), () => response({ error: 'no' }, 403), () => response({ error: 'no' }, 500)]) {
    answers.value = unknown
    assert.deepEqual(await f.manager.balance({}), { success: true, connected: true, known: false })
  }
  assert.equal((await f.manager.balance({ jobId: 'x' })).success, false) // No choices are taken.
  // With no key there is nothing to ask with, and nothing is asked.
  assert.equal((await f.manager.clear({})).success, true)
  f.requests.length = 0
  assert.deepEqual(await f.manager.balance({}), { success: true, connected: false, known: false })
  assert.equal(f.requests.length, 0)
})
