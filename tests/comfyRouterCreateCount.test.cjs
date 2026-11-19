'use strict'
// Several pictures from one click: one plan, one approval, one request and one record per picture.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createComfyRouter, MODEL } = require('../electron/comfyRouter.cjs')
const KEY = 'synthetic-router-key-one-never-real'
const P = 'A red fox trotting through a snowy pine forest'
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })

async function fixture(t, { failOn = 0, failWith = null } = {}) {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-router-count-test-'))
  const requests = [], approvals = []
  const state = { approved: true, policy: 'ask-cloud', posts: 0 }
  const manager = createComfyRouter({ storageDir, getContext: async () => ({ session: 's', projectKey: '/synthetic/project' }), getPolicy: async () => state.policy,
    confirmSpend: async value => { approvals.push(value); return state.approved },
    fetchImpl: async (url, request) => {
      requests.push({ url, ...request })
      if (url.endsWith('/estimate')) return response({ note: 'no quote' })
      if (request.method !== 'POST') return response({ id: MODEL })
      const n = ++state.posts
      if (n === failOn) { if (failWith === 'network') throw new Error('socket closed'); return response({ detail: 'no' }, 400, { 'X-Comfy-Error-Type': 'content_policy_violation' }) }
      return response({ request_id: `provider-job-${n}`, status: 'IN_QUEUE' }, 201)
    } })
  t.after(async () => { manager.dispose(); await fs.rm(storageDir, { recursive: true, force: true }) })
  assert.equal((await manager.connect({ apiKey: KEY })).success, true)
  requests.length = 0
  const posts = () => requests.filter(r => r.method === 'POST' && !r.url.endsWith('/estimate'))
  const ledger = async () => JSON.parse(await fs.readFile(path.join(storageDir, 'comfy-router-jobs.json'), 'utf8')).jobs
  return { manager, requests, approvals, state, posts, ledger }
}

test('four pictures are priced together and sent as four separate requests', async t => {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: P }, count: 4 })
  assert.equal(plan.success, true)
  assert.equal(plan.count, 4)
  assert.ok(Math.abs(plan.estimate.usd - 0.06864 * 4) < 1e-9)
  assert.equal(plan.estimate.each, 0.06864)
  assert.match(plan.estimate.label, /^About \$0\.27 for 4 pictures \(\$0\.07 each, charged separately\)/)
  assert.equal(plan.buttonApproval, true)
  assert.equal(f.posts().length, 0)
  const sent = await f.manager.submitCreate({ planId: plan.planId })
  assert.equal(sent.success, true)
  assert.equal(sent.jobs.length, 4)
  assert.equal(sent.job.jobId, sent.jobs[0].jobId)
  assert.equal(f.approvals.length, 0)
  const posts = f.posts()
  assert.equal(posts.length, 4)
  assert.equal(new Set(posts.map(r => r.headers['Idempotency-Key'])).size, 4)
  assert.deepEqual(posts.map(r => r.headers['Idempotency-Key']), sent.jobs.map(j => j.jobId))
  assert.ok(posts.every(r => r.url === 'https://api.comfy.org/v2/models/bfl/flux-3-image/requests'))
  const saved = await f.ledger()
  assert.equal(saved.length, 4)
  assert.ok(saved.every(job => job.create.usd === 0.06864 && job.status === 'IN_QUEUE'))
  const again = await f.manager.submitCreate({ planId: plan.planId })
  assert.deepEqual([again.repeated, again.jobs.length], [true, 4])
  assert.equal(f.posts().length, 4)
})

test('a set that totals more than the limit goes to the confirmation box, which is told how many', async t => {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: P, size: '4K' }, count: 4 })
  assert.ok(plan.estimate.usd > 2)
  assert.equal(plan.requiresNativeApproval, true)
  f.state.approved = false
  assert.equal((await f.manager.submitCreate({ planId: plan.planId })).code, 'COMFY_ROUTER_DECLINED')
  assert.equal(f.approvals[0].submissionCount, 4)
  assert.equal(f.posts().length, 0)
  assert.deepEqual(await f.ledger().catch(() => []), [])
})

test('when one of a set is refused, the earlier ones stand and the rest are not sent', async t => {
  const f = await fixture(t, { failOn: 3 })
  const plan = await f.manager.previewCreate({ modelId: 'nano-banana-2-1', choices: { prompt: P }, count: 4 })
  const sent = await f.manager.submitCreate({ planId: plan.planId })
  assert.deepEqual([sent.success, sent.partial, sent.jobs.length], [true, true, 2])
  assert.equal(sent.stopped.diagnostics.errorType, 'content_policy_violation')
  assert.equal(sent.stopped.job.status, 'FAILED')
  assert.equal(f.posts().length, 3)
  assert.deepEqual((await f.ledger()).map(job => job.status), ['IN_QUEUE', 'IN_QUEUE', 'FAILED'])
})

test('an unclear outcome inside a set stops it and blocks further requests', async t => {
  const f = await fixture(t, { failOn: 2, failWith: 'network' })
  const plan = await f.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: P }, count: 2 })
  const sent = await f.manager.submitCreate({ planId: plan.planId })
  assert.deepEqual([sent.partial, sent.jobs.length, sent.stopped.code, sent.stopped.job.status], [true, 1, 'COMFY_ROUTER_UNCERTAIN', 'UNCERTAIN'])
  const next = await f.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: P } })
  assert.equal((await f.manager.submitCreate({ planId: next.planId })).code, 'COMFY_ROUTER_UNCERTAIN')
  assert.equal(f.posts().length, 2)
})

test('only 1, 2 or 4 pictures, and clips one at a time', async t => {
  const f = await fixture(t)
  for (const count of [0, 3, 5, 2.5, '2', null]) assert.equal((await f.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: P }, count })).code, 'COMFY_ROUTER_INVALID')
  assert.equal((await f.manager.previewCreate({ modelId: 'seedance-2-5', choices: { prompt: P }, count: 2 })).code, 'COMFY_ROUTER_INVALID')
  const one = await f.manager.previewCreate({ modelId: 'seedance-2-5', choices: { prompt: P }, count: 1 })
  assert.deepEqual([one.success, one.count], [true, 1])
  const plain = await f.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: P } })
  assert.deepEqual([plain.count, plain.estimate.each], [1, undefined])
  assert.equal(f.posts().length, 0)
})

test('the agent path asks once for the whole set', async t => {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId: 'seedream-5-0-flash', choices: { prompt: P }, count: 2 })
  const sent = await f.manager.submit({ planId: plan.planId })
  assert.deepEqual([sent.success, sent.jobs.length, sent.approval, f.approvals.length, f.approvals[0].submissionCount], [true, 2, 'dialog', 1, 2])
})
