'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { sendLuna, MODEL } = require('../electron/connectedAgentLuna.cjs')
const { markPreDispatchRefusal, getPreDispatchRefusal, consumePreDispatchRefusal,
  retryAfterMilliseconds, waitForPreDispatchRetry } = require('../electron/fundedLunaRecovery.cjs')
const { createPausableTimeout } = require('../electron/connectedAgentLocalTools.cjs')
const answer = text => ({ ok: true, model: MODEL, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] })
const request = { provider: 'luna', model: MODEL, context: '{}', messages: [{ role: 'user', content: 'Synthetic task.' }] }
const refusal = (payload, reason = 'rate_limited', retryAfter) => markPreDispatchRefusal(Object.assign(Error('synthetic refusal'), { code: 'LUNA_BUSY' }),
  { requestId: payload.requestId, reason, retryAfter })
function fixture(respond) {
  let time = 0
  const requests = [], waiting = [], events = [], sleeps = []
  return { requests, waiting, events, sleeps, get time() { return time },
    onWaiting: value => waiting.push(value), onEvent: value => events.push(value),
    recoveryTiming: { now: () => time, sleep: async milliseconds => { sleeps.push(milliseconds); time += milliseconds } },
    fundedLuna: { status: async () => ({ ok: true, available: true, model: MODEL }), respond: async payload => {
      requests.push(structuredClone(payload)); return respond(payload, requests.length)
    } } }
}

test('Retry-After parsing is bounded; malformed values use native fallback', () => {
  const now = Date.UTC(2026, 10, 3, 12, 0, 0)
  for (const [value, expected] of [['0', 1000], ['1', 1000], ['15', 15000], ['9999999999', 60000],
    ['Tue, 03 Nov 2026 12:00:08 GMT', 8000], ['Tue, 03 Nov 2026 11:00:00 GMT', 1000],
    ['-1', undefined], ['0.5', undefined], ['8; secret', undefined], ['', undefined], [[], undefined],
    ['999999999999999999999999', undefined], ['x'.repeat(81), undefined]]) {
    assert.equal(retryAfterMilliseconds(value, now), expected, String(value))
  }
})

test('a refusal is native, request-bound, and consumable only once', () => {
  const error = refusal({ requestId: 'round_1' }, 'busy')
  assert.equal(getPreDispatchRefusal({ ...error }, 'round_1'), undefined)
  assert.equal(consumePreDispatchRefusal(error, 'round_1').reason, 'busy')
  assert.equal(consumePreDispatchRefusal(error, 'round_1'), undefined)
  const stale = refusal({ requestId: 'round_1' })
  assert.equal(consumePreDispatchRefusal(stale, 'round_2'), undefined)
  assert.equal(consumePreDispatchRefusal(stale, 'round_1'), undefined)
  for (const reason of ['upstream_unavailable', 'allowance_exhausted', 'unknown']) {
    assert.equal(getPreDispatchRefusal(refusal({ requestId: 'round_1' }, reason), 'round_1'), undefined)
  }
})

test('repeated known refusals wait indefinitely without changing the payload or selecting another model', async () => {
  const deps = fixture((payload, attempt) => {
    if (attempt <= 26) { const error = refusal(payload); payload.input.push({ untrustedMutation: true }); throw error }
    return answer('Finished after multiple windows.')
  })
  const result = await sendLuna(request, deps)
  assert.equal(result.text, 'Finished after multiple windows.')
  assert.equal(deps.requests.length, 27); assert.equal(deps.time, 26 * 60000)
  assert.ok(deps.requests.every(item => JSON.stringify(item) === JSON.stringify(deps.requests[0])))
  assert.equal(deps.requests[0].reasoningEffort, 'low')
  assert.equal(deps.waiting.filter(Boolean).length, 26); assert.equal(deps.waiting.at(-1), false)
  assert.ok(deps.events.some(item => item.remainingSeconds === 60))
  assert.ok(deps.events.some(item => item.remainingSeconds === 1))
  assert.ok(deps.events.filter(item => item.waitingFor).every(item => /Stop to cancel/.test(item.text) && !/user|approval/i.test(item.text)))
})

test('busy uses bounded increasing backoff; an available first request has no pacing delay', async () => {
  const deps = fixture((payload, attempt) => { if (attempt < 8) throw refusal(payload, 'busy'); return answer('Done.') })
  await sendLuna(request, deps)
  assert.equal(deps.time, 2e3 + 4e3 + 6e3 + 8e3 + 10e3 + 10e3 + 10e3)
  const ready = fixture(() => answer('Already available.'))
  await sendLuna(request, ready); assert.equal(ready.sleeps.length, 0); assert.equal(ready.requests.length, 1)
})

test('generic busy, ambiguous network, auth, quota, duplicate IDs and stale receipts never retry', async () => {
  for (const error of [Object.assign(Error(), { code: 'LUNA_BUSY', reason: 'rate_limited', retryAfterMs: 1 }),
    Object.assign(Error(), { code: 'ECONNRESET' }), Object.assign(Error(), { code: 'ETIMEDOUT' }),
    ...['LUNA_EXHAUSTED', 'LUNA_NOT_ELIGIBLE', 'request_already_used', 'request_conflict', 'LUNA_UNAVAILABLE']
      .map(code => Object.assign(Error(), { code })), refusal({ requestId: 'another-turn' })]) {
    const deps = fixture(() => { throw error })
    await assert.rejects(sendLuna(request, deps)); assert.equal(deps.requests.length, 1); assert.equal(deps.sleeps.length, 0)
  }
  let old
  const reused = fixture(payload => { old ||= refusal(payload, 'busy'); throw old })
  await assert.rejects(sendLuna(request, reused), { code: 'LUNA_BUSY' })
  assert.equal(reused.requests.length, 2); assert.equal(reused.time, 2000)
})

test('Stop aborts a service wait and releases the pause without a second dispatch', async () => {
  const controller = new AbortController()
  const deps = fixture(payload => { throw refusal(payload) })
  deps.recoveryTiming.sleep = async () => controller.abort()
  await assert.rejects(sendLuna(request, { ...deps, signal: controller.signal }), { code: 'CANCELLED' })
  assert.equal(deps.requests.length, 1); assert.equal(deps.waiting.at(-1), false)
})

test('native account lease revocation interrupts a real timer wait immediately', async () => {
  const controller = new AbortController(), deps = fixture(payload => { throw refusal(payload) })
  delete deps.recoveryTiming
  deps.fundedLuna.signal = controller.signal
  deps.onWaiting = value => { deps.waiting.push(value); if (value) queueMicrotask(() => controller.abort()) }
  await assert.rejects(sendLuna(request, deps), { code: 'CANCELLED' })
  assert.equal(deps.requests.length, 1); assert.equal(deps.waiting.at(-1), false)
})

test('authority is rechecked within waits and immediately before resuming', async () => {
  for (const revokedAt of [1000, 60000]) {
    const deps = fixture(payload => { throw refusal(payload) })
    let checks = 0
    deps.assertBeforeSend = () => { checks++; if (deps.time >= revokedAt) throw Object.assign(Error('changed project'), { code: 'UNAUTHORIZED' }) }
    await assert.rejects(sendLuna(request, deps), { code: 'UNAUTHORIZED' })
    assert.equal(deps.requests.length, 1); assert.ok(checks >= 2); assert.equal(deps.waiting.at(-1), false)
  }
})

test('service wait preserves remaining active-time budget without labelling it a user wait', async () => {
  let time = 0, fire, fired = false, remaining
  const timer = createPausableTimeout(() => { fired = true }, 5000, {
    now: () => time, setTimer: (callback, ms) => { fire = callback; remaining = ms; return 1 }, clearTimer: () => { fire = null },
  })
  time = 1000
  await waitForPreDispatchRetry({ reason: 'rate_limited' }, { assertCurrent: () => {}, onWaiting: value => timer.setWaiting(value),
    timing: { now: () => time, sleep: async ms => { assert.equal(fire, null); time += ms } } })
  assert.equal(time, 61000); assert.equal(fired, false); assert.equal(remaining, 4000)
  timer.dispose()
})

test('Stop does not wait for an unresolved native authority lookup during recovery', async () => {
  const controller = new AbortController(), deps = fixture(payload => { throw refusal(payload) })
  let waiting = false, reached
  const inspecting = new Promise(resolve => { reached = resolve })
  deps.onWaiting = value => { deps.waiting.push(value); waiting = value }
  deps.assertBeforeSend = () => {
    if (!waiting) return
    reached()
    return new Promise(() => {})
  }
  const operation = sendLuna(request, { ...deps, signal: controller.signal })
  await inspecting; controller.abort()
  await assert.rejects(operation, { code: 'CANCELLED' })
  assert.equal(deps.requests.length, 1); assert.equal(deps.waiting.at(-1), false)
})
