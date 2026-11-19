'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { assertIsolation, createRequestBridge, runCandidateTurn, RECOVERY_DIALOG } = require('../electron/veloEngineCandidate.cjs')
const { lunaPromptWasNotSent } = require('../electron/connectedAgentLuna.cjs')

function recoveryFixture(overrides = {}) {
  const controller = new AbortController(), calls = [], dialogs = [], waiting = []
  const input = [{ type: 'text', text: 'Inspect and save the existing asset only.' }]
  const firstInput = [{ type: 'text', text: 'Historical context must not be replayed.' }]
  const state = { status: 'uncertain' }
  const deps = { input, firstInput, developerInstructions: 'Existing native instructions', signal: controller.signal,
    assertAuthorized: async () => true, onWaiting: value => waiting.push(value),
    engine: { start: async () => ({ recoveryRequired: state.status === 'uncertain' }),
      runTurn: async value => { calls.push(value); return { status: 'completed', text: 'Synthetic result' } } },
    showRecoveryDialog: async options => { dialogs.push(options); return { response: 1 } }, ...overrides }
  return { deps, controller, calls, dialogs, waiting, state }
}

test('candidate explicit Continue acknowledges only the new turn without clearing the old journal', async () => {
  const f = recoveryFixture()
  assert.equal((await runCandidateTurn(f.deps)).status, 'completed')
  assert.equal(f.dialogs.length, 1); assert.equal(f.calls.length, 1)
  assert.deepEqual(f.dialogs[0], { ...RECOVERY_DIALOG, buttons: ['Cancel', 'Continue'], signal: f.controller.signal })
  assert.equal(f.calls[0].acknowledgeUncertain, true)
  assert.equal(f.calls[0].input, f.deps.input); assert.equal(f.calls[0].firstInput, f.deps.firstInput)
  assert.equal(f.state.status, 'uncertain'); assert.deepEqual(f.waiting, [true, false])
})

test('candidate Cancel restores the unsent draft through the trusted marker and dispatches nothing', async () => {
  const f = recoveryFixture({ showRecoveryDialog: async () => ({ response: 0 }) })
  await assert.rejects(runCandidateTurn(f.deps), error => error.code === 'CANCELLED' && lunaPromptWasNotSent(error))
  assert.equal(f.calls.length, 0); assert.equal(f.state.status, 'uncertain'); assert.deepEqual(f.waiting, [true, false])
})

test('candidate abort during native confirmation rejects a late affirmative response without dispatch', async () => {
  const f = recoveryFixture()
  let answer, entered
  const shown = new Promise(resolve => { entered = resolve })
  f.deps.showRecoveryDialog = () => { entered(); return new Promise(resolve => { answer = resolve }) }
  const pending = runCandidateTurn(f.deps); await shown; f.controller.abort()
  await assert.rejects(pending, error => error.code === 'CANCELLED' && lunaPromptWasNotSent(error))
  answer({ response: 1 }); await Promise.resolve()
  assert.equal(f.calls.length, 0); assert.equal(f.state.status, 'uncertain'); assert.deepEqual(f.waiting, [true, false])
})

test('candidate rechecks account and project authority after Continue', async () => {
  for (const code of ['LUNA_AUTH_REQUIRED', 'CANCELLED']) {
    let current = true
    const f = recoveryFixture({ assertAuthorized: async () => { if (!current) throw Object.assign(Error('Native scope changed'), { code }) },
      showRecoveryDialog: async () => { current = false; return { response: 1 } } })
    await assert.rejects(runCandidateTurn(f.deps), error => error.code === code && lunaPromptWasNotSent(error))
    assert.equal(f.calls.length, 0); assert.equal(f.state.status, 'uncertain')
  }
})

test('candidate clean thread sends normally without a modal or blanket acknowledgement', async () => {
  const f = recoveryFixture(); f.state.status = 'completed'
  await runCandidateTurn(f.deps)
  assert.equal(f.dialogs.length, 0); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].acknowledgeUncertain, false)
  assert.deepEqual(f.waiting, [])
})

test('candidate never brands a dispatched failure as unsent and never retries it', async () => {
  const f = recoveryFixture(), error = Object.assign(Error('Synthetic uncertain response'), { code: 'VELO_ENGINE_TURN_FAILED' })
  f.deps.engine.runTurn = async value => { f.calls.push(value); throw error }
  await assert.rejects(runCandidateTurn(f.deps), failure => failure === error && !lunaPromptWasNotSent(failure))
  assert.equal(f.calls.length, 1); assert.equal(f.dialogs.length, 1)
})

test('offline candidate refuses an ordinary host launch before opening any profile', () => {
  assert.throws(assertIsolation)
})

test('native bridge issues unique request IDs, preserves typed body and does not retry', async t => {
  const calls = []
  const server = http.createServer(async (req, res) => {
    const data = []
    for await (const chunk of req) data.push(chunk)
    calls.push({ headers: req.headers, body: JSON.parse(Buffer.concat(data)) })
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'synthetic_unavailable' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const token = 'synthetic-local-capability'
  const bridge = await createRequestBridge({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, token })
  t.after(async () => { await bridge.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const body = { model: 'gpt-6-luna', reasoning: { effort: 'low' }, input: [{ type: 'reasoning', encrypted_content: 'synthetic' }, { type: 'custom_tool_call_output', call_id: 'call-1', output: 'done' }] }
  for (let i = 0; i < 2; i++) {
    const result = await fetch(bridge.baseUrl + '/responses', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-client-request-id': 'same-thread' }, body: JSON.stringify(body) })
    assert.equal(result.status, 503)
    await result.text()
  }
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0].headers['idempotency-key'], calls[1].headers['idempotency-key'])
  for (const call of calls) assert.deepEqual(call.body, body)
  const forbidden = await fetch(bridge.baseUrl + '/responses', { method: 'POST', body: '{}' })
  assert.equal(forbidden.status, 403)
  assert.equal(calls.length, 2)
})

test('native bridge cannot be aimed at a live funding endpoint', async () => {
  await assert.rejects(createRequestBridge({ baseUrl: 'https://connect.velorn.ai/v1', token: 'synthetic' }), /Offline loopback/)
})
