'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { fetchWithAdmissionWait, retryDelay, parseAdmissionProgress, admissionStatus } = require('../electron/veloAdmissionWait.cjs')
const proof = (body = {}, headers = {}, status = 429) => new Response(JSON.stringify({ reserved: false, retrySameId: true, error: { code: 'rate_limited' }, ...body }), {
  status, headers: { 'content-type': 'application/json', 'x-velorn-retry-same-id': '1', ...headers } })
const done = () => new Response('data: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
function options(fetchImpl, extra = {}) { let clock = 0; return { fetchImpl, url: 'https://relay.invalid/responses', headers: { 'Idempotency-Key': 'same-id', authorization: 'synthetic' },
  body: Buffer.from('{"input":[{"type":"tool_result","output":"COMPLETED_ONCE"},{"type":"compaction","encrypted_content":"opaque"}]}'),
  now: () => clock, wait: async ms => { clock += ms }, ...extra } }

test('many proven refusals resend exact bytes/key with completed and compacted state intact', async () => {
  const attempts = [], states = []
  const response = await fetchWithAdmissionWait(options(async (url, input) => {
    attempts.push({ url, body: input.body.toString(), headers: { ...input.headers } })
    input.body.fill(0); input.headers['Idempotency-Key'] = 'attempted-mutation'
    return attempts.length <= 25 ? proof() : done()
  }, { onState: value => states.push(value) }))
  assert.equal(response.status, 200); assert.equal(attempts.length, 26)
  assert(attempts.every(item => item.body === attempts[0].body && item.headers['Idempotency-Key'] === 'same-id'))
  assert(states.some(item => item.state === 'waiting')); assert.equal(states.at(-1).state, 'resuming')
  assert.match(attempts[0].body, /COMPLETED_ONCE/); assert.match(attempts[0].body, /opaque/)
})
test('Retry-After honors seconds and dates; invalid/missing values back off without a retry-count cap', () => {
  assert.equal(retryDelay(new Headers({ 'retry-after': '72' }), 'busy', 1, 0), 72000)
  assert.equal(retryDelay(new Headers({ 'retry-after': 'Thu, 01 Jan 1970 00:02:00 GMT' }), 'busy', 1, 0), 120000)
  assert.equal(retryDelay(new Headers({ 'retry-after': '-9' }), 'rate_limited', 1, 0), 60250)
  assert.equal(retryDelay(new Headers(), 'busy', 20, 0), 30000)
})
for (const [name, response] of [
  ['reserved request', () => proof({ reserved: true })], ['unknown reservation', () => proof({ reserved: null })],
  ['retry denied', () => proof({ retrySameId: false })], ['string flag', () => proof({ retrySameId: 'true' })],
  ['allowance exhausted', () => proof({ error: { code: 'budget_exhausted' } })], ['missing proof header', () => proof({}, { 'x-velorn-retry-same-id': '0' })],
  ['unauthorized', () => proof({}, {}, 401)], ['forbidden', () => proof({}, {}, 403)], ['provider error', () => proof({}, {}, 503)],
  ['wrong content type', () => proof({}, { 'content-type': 'text/plain' })],
  ['malformed proof', () => new Response('{oops', { status: 429, headers: { 'content-type': 'application/json', 'x-velorn-retry-same-id': '1' } })],
]) test(`${name} is returned without any retry`, async () => {
  let attempts = 0
  await fetchWithAdmissionWait(options(async () => { attempts++; return response() }))
  assert.equal(attempts, 1)
})
test('network failure and admitted stream interruption never dispatch a second attempt', async () => {
  let attempts = 0
  await assert.rejects(fetchWithAdmissionWait(options(async () => { attempts++; throw Error('socket closed') })), /socket closed/)
  assert.equal(attempts, 1)
  const response = await fetchWithAdmissionWait(options(async () => { attempts++; return new Response(new ReadableStream({ start(controller) { controller.error(Error('partial admitted stream')) } })) }))
  await assert.rejects(response.text(), /partial admitted/); assert.equal(attempts, 2)
})
test('stop during wait aborts promptly and never dispatches again', async () => {
  const abort = new AbortController(); let attempts = 0
  await assert.rejects(fetchWithAdmissionWait(options(async () => { attempts++; return proof() }, {
    signal: abort.signal, onState: () => abort.abort(), wait: async () => { abort.signal.throwIfAborted() },
  })))
  assert.equal(attempts, 1)
})
test('authority expiry during waiting and late abort before retry stop without dispatch', async () => {
  let attempts = 0, current = true
  await assert.rejects(fetchWithAdmissionWait(options(async () => { attempts++; return proof() }, {
    assertAuthorized: () => { if (!current) throw Error('expired') }, onState: () => { current = false },
  })), /expired/)
  assert.equal(attempts, 1)
  const abort = new AbortController(); attempts = 0
  await assert.rejects(fetchWithAdmissionWait(options(async () => { attempts++; return proof({}, { 'retry-after': '0' }) }, {
    signal: abort.signal, onState: value => { if (value.state === 'resuming') abort.abort() },
  })))
  assert.equal(attempts, 1)
})
test('oversized refusal is not trusted or retried', async () => {
  let calls = 0
  await assert.rejects(fetchWithAdmissionWait(options(async () => { calls++; return proof({ padding: 'x'.repeat(17000) }) })), /Unverifiable/)
  assert.equal(calls, 1)
})
test('waiting presentation accepts only fixed, bounded metadata and exposes cancellation', () => {
  const progress = parseAdmissionProgress(': velo-admission {"state":"waiting","reason":"busy","retryInMs":1234,"secret":"never-forward"}')
  assert.deepEqual(progress, { state: 'waiting', reason: 'busy', retryInMs: 1234 })
  assert.match(admissionStatus(progress).text, /2s.*Stop to cancel/)
  assert.equal(admissionStatus(progress).waitingFor, 'velo-service')
  assert.equal(admissionStatus({ state: 'resuming' }).waitingFor, undefined)
  for (const input of [': velo-admission {}', ': velo-admission {"state":"waiting","reason":"evil","retryInMs":2}', ': velo-admission ' + 'a'.repeat(600)]) assert.equal(parseAdmissionProgress(input), null)
})
module.exports = { proof }
