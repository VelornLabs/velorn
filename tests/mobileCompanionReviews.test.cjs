'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createMobileReviews } = require('../electron/mobileCompanionReviews.cjs')

function fixture(t, options = {}) {
  const window = {}, frame = {}
  let context = { window, frame, scope: 'native-window-scope', contextId: 'project-chat-context' }
  let changes = 0, revocations = 0
  const reviews = createMobileReviews({ getContext: () => context,
    changed: () => { changes++ }, revoked: () => { revocations++ }, ...options })
  t.after(() => reviews.invalidate())
  const confirm = (extra = {}) => reviews.confirm({ window, title: 'Review generation', detail: 'One submission.',
    kind: 'generation-spending', allowLocalTrust: true, workflowTitle: 'Saved local workflow', ...extra })
  const answer = (extra = {}) => {
    const view = reviews.snapshot()[0]
    return { approvalId: view.approvalId, reviewToken: view.reviewToken, approved: true, riskAcknowledged: true, ...extra }
  }
  return { reviews, window, frame, confirm, answer, setContext: value => { context = value },
    get context() { return context }, get changes() { return changes }, get revocations() { return revocations } }
}

test('only native eligible generation reviews expose local-trust choice', async t => {
  const f = fixture(t)
  for (const extra of [{ kind: 'full-access' }, { kind: 'spending-policy' }, { allowLocalTrust: false }, { allowLocalTrust: 'true' }]) {
    const pending = f.confirm(extra), view = f.reviews.snapshot()[0]
    assert.equal(Object.hasOwn(view, 'allowLocalTrust'), false)
    assert.equal(Object.hasOwn(view, 'workflowTitle'), false)
    assert.throws(() => f.reviews.decide(f.answer({ trustLocal: true })), /APPROVAL_UNAVAILABLE/)
    f.reviews.decide(f.answer({ approved: false, riskAcknowledged: false }))
    const result = await pending
    assert.equal(result.approved, false); assert.equal(Object.hasOwn(result, 'trustLocal'), false)
  }
  const pending = f.confirm({ workflowTitle: 'x'.repeat(300) }), view = f.reviews.snapshot()[0]
  assert.equal(view.allowLocalTrust, true); assert.equal(view.workflowTitle.length, 160)
  f.reviews.decide(f.answer({ trustLocal: true }))
  assert.equal((await pending).trustLocal, true)
})

test('local trust needs explicit approval plus risk acknowledgement and cannot be replayed', async t => {
  const f = fixture(t), pending = f.confirm()
  for (const extra of [{ trustLocal: true, approved: false }, { trustLocal: true, riskAcknowledged: false },
    { trustLocal: 'true' }, { approved: 'true' }, { riskAcknowledged: 'true' }, { reviewToken: 'wrong-token' }]) {
    assert.throws(() => f.reviews.decide(f.answer(extra)), /APPROVAL_UNAVAILABLE/)
    assert.equal(f.reviews.snapshot().length, 1)
  }
  const answer = f.answer({ trustLocal: true })
  assert.deepEqual(f.reviews.decide(answer), { success: true, status: 'completed' })
  const result = await pending
  assert.equal(result.approved, true); assert.equal(result.trustLocal, true)
  assert.equal(result.mobileBinding.isCurrent(), true)
  assert.equal(f.reviews.snapshot().length, 0)
  assert.throws(() => f.reviews.decide(answer), /APPROVAL_UNAVAILABLE/)
})

test('approving one submission without trust does not remember the workflow', async t => {
  const f = fixture(t)
  for (const extra of [{}, { trustLocal: false }]) {
    const pending = f.confirm()
    f.reviews.decide(f.answer(extra))
    const result = await pending
    assert.equal(result.approved, true); assert.equal(Object.hasOwn(result, 'trustLocal'), false)
  }
})

test('context, frame, window and scope changes reject stale local-trust approvals', async t => {
  for (const field of ['contextId', 'frame', 'window', 'scope']) {
    const f = fixture(t), pending = f.confirm(), answer = f.answer({ trustLocal: true })
    f.setContext({ ...f.context, [field]: ['frame','window'].includes(field) ? {} : 'replacement' })
    assert.throws(() => f.reviews.decide(answer), /APPROVAL_UNAVAILABLE/, field)
    f.reviews.invalidate()
    const result = await pending
    assert.equal(result.approved, false); assert.equal(Object.hasOwn(result, 'trustLocal'), false)
    assert.equal(result.mobileBinding.isCurrent(), false)
  }
})

test('disconnection permanently invalidates a granted binding even after identical context returns', async t => {
  const f = fixture(t), pending = f.confirm(), context = f.context
  f.reviews.decide(f.answer({ trustLocal: true }))
  const result = await pending
  f.setContext(null)
  assert.equal(result.mobileBinding.isCurrent(), false)
  f.reviews.invalidate(); f.setContext(context)
  assert.equal(result.mobileBinding.isCurrent(), false)
  assert.equal(f.revocations, 1)
  assert.equal(f.reviews.confirm({ window: {}, kind: 'generation-spending' }), null)
})

test('abort and timeout decline pending trust without saving or approving it', async t => {
  const f = fixture(t, { timeoutMs: 10 }), abort = new AbortController()
  const pending = f.confirm({ signal: abort.signal }), answer = f.answer({ trustLocal: true })
  abort.abort()
  const result = await pending
  assert.equal(result.approved, false); assert.equal(Object.hasOwn(result, 'trustLocal'), false)
  assert.throws(() => f.reviews.decide(answer), /APPROVAL_UNAVAILABLE/)
  const timed = f.confirm()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal((await timed).approved, false)
  assert.deepEqual(f.reviews.snapshot(), [])
})
