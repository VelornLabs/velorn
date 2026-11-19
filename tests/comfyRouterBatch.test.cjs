'use strict'
// A batch of different pictures (the Director's keyframes): one plan, one
// approval, one request and one record per picture, reference pictures held once.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createComfyRouter, MODEL } = require('../electron/comfyRouter.cjs')
const { buildCreateRequest } = require('../electron/createRequests.cjs')
const { createRouterTestPng } = require('./helpers/routerImage.cjs')

const KEY = 'synthetic-router-key-batch-never-real'
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const picture = (width = 512, height = 512) => ({ mimeType: 'image/png', base64: createRouterTestPng({ width, height }).toString('base64') })

async function fixture(t, { failOn = 0 } = {}) {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-router-batch-test-'))
  const requests = [], approvals = []
  const state = { approved: true, posts: 0 }
  const manager = createComfyRouter({ storageDir, getContext: async () => ({ session: 's', projectKey: '/synthetic/project' }), getPolicy: async () => 'ask-cloud',
    confirmSpend: async value => { approvals.push(value); return state.approved },
    fetchImpl: async (url, request) => {
      requests.push({ url, ...request })
      if (url.endsWith('/estimate')) return response({ note: 'no quote' })
      if (request.method !== 'POST') return response({ id: MODEL })
      const n = ++state.posts
      if (n === failOn) return response({ detail: 'no' }, 400, { 'X-Comfy-Error-Type': 'content_policy_violation' })
      return response({ request_id: `provider-job-${n}`, status: 'IN_QUEUE' }, 201)
    } })
  t.after(async () => { manager.dispose(); await fs.rm(storageDir, { recursive: true, force: true }) })
  assert.equal((await manager.connect({ apiKey: KEY })).success, true)
  requests.length = 0
  const posts = () => requests.filter(r => r.method === 'POST' && !r.url.endsWith('/estimate'))
  return { manager, approvals, state, posts }
}

const item = (prompt, pictureIds = []) => ({ prompt, shape: 'landscape', size: '2K', pictureIds })

test('one picture request can carry up to three reference pictures, in order', () => {
  const a = picture(), b = picture(600, 400)
  const built = buildCreateRequest('nano-banana-2-1', { prompt: 'A singer in a room', shape: 'portrait', size: '2K', pictures: [a, b] })
  const parts = built.body.contents[0].parts
  assert.deepEqual(parts.map(part => (part.inlineData ? part.inlineData.data : part.text)), [a.base64, b.base64, 'A singer in a room'])
  assert.equal(built.choices.hasPicture, true)
  assert.equal(built.body.generationConfig.imageConfig.aspectRatio, '9:16')
  assert.throws(() => buildCreateRequest('nano-banana-2-1', { prompt: 'x', pictures: [a, a, a, a] }), /one to 3 reference pictures/)
  assert.throws(() => buildCreateRequest('nano-banana-2-1', { prompt: 'x', picture: a, pictures: [a] }), /does not take several/)
  assert.throws(() => buildCreateRequest('seedream-4-0', { prompt: 'x', pictures: [a] }), /does not take several/)
})

test('a batch is priced as a whole and needs one approval for all of it', async t => {
  const f = await fixture(t)
  const shots = Array.from({ length: 30 }, (_, n) => item(`Shot ${n + 1}: the singer walks`, n % 2 ? ['singer', 'street'] : ['singer']))
  const plan = await f.manager.previewCreateBatch({ modelId: 'nano-banana-2-1', items: shots, pictures: { singer: picture(), street: picture(640, 360) } })
  assert.equal(plan.success, true)
  assert.equal(plan.count, 30)
  assert.ok(Math.abs(plan.estimate.usd - 0.0785 * 30) < 1e-9)
  assert.match(plan.estimate.label, /^Usually about \$2\.35 for 30 pictures \(about \$0\.08 each, charged separately\)/)
  // Over the small-click limit, so the native confirmation is asked, once.
  assert.equal(plan.buttonApproval, false)
  assert.equal(f.posts().length, 0)
  const sent = await f.manager.submitCreate({ planId: plan.planId })
  assert.equal(sent.success, true)
  assert.equal(sent.jobs.length, 30)
  assert.equal(f.approvals.length, 1)
  assert.equal(f.approvals[0].submissionCount, 30)
  const posts = f.posts()
  assert.equal(posts.length, 30)
  assert.equal(new Set(posts.map(r => r.headers['Idempotency-Key'])).size, 30)
  // Each request carries its own words and its own pictures.
  const first = JSON.parse(posts[0].body).contents[0].parts, second = JSON.parse(posts[1].body).contents[0].parts
  assert.equal(first.length, 2)
  assert.equal(second.length, 3)
  assert.equal(first.at(-1).text, 'Shot 1: the singer walks')
  assert.equal(second.at(-1).text, 'Shot 2: the singer walks')
  // Every picture carries its own fresh seed.
  const seeds = posts.map(r => JSON.parse(r.body).generationConfig.seed)
  assert.ok(seeds.every(seed => Number.isInteger(seed) && seed >= 1 && seed < 2147483647))
  assert.equal(new Set(seeds).size, 30)
})

test('several pictures from one plan never share a seed', async t => {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId: 'nano-banana-2-1', choices: { prompt: 'A red fox in the snow' }, count: 4 })
  assert.equal((await f.manager.submitCreate({ planId: plan.planId })).success, true)
  const seeds = f.posts().map(r => JSON.parse(r.body).generationConfig.seed)
  assert.equal(seeds.length, 4)
  assert.equal(new Set(seeds).size, 4)
})

test('declining the approval sends nothing', async t => {
  const f = await fixture(t)
  f.state.approved = false
  const plan = await f.manager.previewCreateBatch({ modelId: 'nano-banana-2-1', items: Array.from({ length: 30 }, (_, n) => item(`Shot ${n}`)), pictures: {} })
  const sent = await f.manager.submitCreate({ planId: plan.planId })
  assert.equal(sent.success, false)
  assert.equal(sent.code, 'COMFY_ROUTER_DECLINED')
  assert.equal(f.posts().length, 0)
})

test('the first refusal stops the rest and reports what was sent', async t => {
  const f = await fixture(t, { failOn: 3 })
  const plan = await f.manager.previewCreateBatch({ modelId: 'nano-banana-2-1', items: [item('one'), item('two'), item('three'), item('four')], pictures: {} })
  assert.equal(plan.buttonApproval, true)
  const sent = await f.manager.submitCreate({ planId: plan.planId })
  assert.equal(sent.partial, true)
  assert.equal(sent.jobs.length, 2)
  assert.equal(f.posts().length, 3)
})

test('bad batches are refused before anything is priced or sent', async t => {
  const f = await fixture(t)
  const bad = async payload => (await f.manager.previewCreateBatch(payload)).success
  assert.equal(await bad({ modelId: 'nano-banana-2-1', items: [], pictures: {} }), false)
  assert.equal(await bad({ modelId: 'nano-banana-2-1', items: [item('x', ['missing'])], pictures: {} }), false)
  assert.equal(await bad({ modelId: 'nano-banana-2-1', items: [item('x', ['small'])], pictures: { small: picture(64, 64) } }), false)
  assert.equal(await bad({ modelId: 'nano-banana-2-1', items: Array.from({ length: 201 }, () => item('x')), pictures: {} }), false)
  assert.equal(await bad({ modelId: 'nano-banana-2-1', items: [{ prompt: 'x', shape: 'landscape', size: '2K', pictureIds: [], extra: 1 }], pictures: {} }), false)
  assert.equal(await bad({ modelId: 'seedance-2-5', items: [item('x')], pictures: {} }), false)
  assert.equal(f.posts().length, 0)
})
