'use strict'

// Synthetic loopback transport + the real Velo adapter; no provider, account,
// user files or operational service are accessed by this suite.
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const vm = require('node:vm')
const { requestFundedLuna, MAX_RESPONSE } = require('../electron/fundedLunaTransport.cjs')
const { sendLuna, MODEL, lunaPromptWasNotSent } = require('../electron/connectedAgentLuna.cjs')

function deadlineTransport(deadlines) {
  const filename = require.resolve('../electron/fundedLunaTransport.cjs'), compiled = { exports: {} }
  vm.runInNewContext(readFileSync(filename, 'utf8'), {
    module: compiled, exports: compiled.exports, require: createRequire(filename), Buffer, URL,
    setTimeout(callback, milliseconds) { deadlines.push(milliseconds); return setTimeout(callback, 100) },
    clearTimeout,
  }, { filename })
  return compiled.exports.requestFundedLuna
}
const serviceFailure = (error, status = 503) => res => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error, detail: 'PRIVATE upstream error must not be exposed' }))
}
const cases = [
  ...[
    ['unauthorized', 403, 'LUNA_AUTH_REQUIRED'],
    ['not_eligible', 403, 'LUNA_NOT_ELIGIBLE'],
    ['allowance_exhausted', 402, 'LUNA_EXHAUSTED'],
    ['invalid_request', 400, 'LUNA_REQUEST_REJECTED'],
    ['upstream_unavailable', 503, 'LUNA_SERVICE_UNAVAILABLE'],
    ['storage_unavailable', 503, 'LUNA_SERVICE_UNAVAILABLE'],
    ['unknown_private_failure', 503, 'LUNA_SERVICE_UNAVAILABLE'],
    ['request_already_used', 409, 'LUNA_RESPONSE_UNCERTAIN'],
    ['request_conflict', 409, 'LUNA_RESPONSE_UNCERTAIN'],
    ['request_cancelled', 409, 'CANCELLED'],
  ].map(([name, status, code]) => ({ name, code, fail: serviceFailure(name, status) })),
  { name: 'connection lost', code: 'LUNA_RESPONSE_UNCERTAIN', fail: res => res.destroy() },
  { name: 'response aborted', code: 'LUNA_RESPONSE_UNCERTAIN', fail: res => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 1000 })
    res.write('{"ok":true,'); setImmediate(() => res.destroy())
  } },
  { name: 'malformed JSON', code: 'LUNA_INVALID_RESPONSE', fail: res => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('PRIVATE invalid JSON')
  } },
  { name: 'oversized reply', code: 'LUNA_INVALID_RESPONSE', fail: res => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('x'.repeat(MAX_RESPONSE + 1))
  } },
  { name: 'request deadline', code: 'LUNA_RESPONSE_UNCERTAIN', fail: () => {}, timeout: true },
]

for (const scenario of cases) test(`completed command is never replayed after ${scenario.name}`, async t => {
  const requests = [], waits = [], deadlines = []
  let commandCount = 0, statusCount = 0, confirmedEffects = 0
  const remainingMicroUsd = 999982
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk.toString('utf8') })
    req.on('end', () => {
      const body = JSON.parse(raw)
      if (req.url.endsWith('/status')) {
        statusCount++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, model: MODEL, available: true, remainingMicroUsd }))
        return
      }
      requests.push(body)
      if (requests.length === 1) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, model: MODEL, remainingMicroUsd, output: [{
          type: 'function_call', call_id: 'completed_command', name: 'call_velorn_tool',
          arguments: JSON.stringify({ name: 'run_computer_command', arguments: { command: 'synthetic:change-once' } }),
        }] }))
      } else scenario.fail(res)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const transport = scenario.timeout ? deadlineTransport(deadlines) : requestFundedLuna
  const post = (route, body) => transport({
    url: new URL(`http://127.0.0.1:${server.address().port}/account/desktop/luna/${route}`),
    token: 's'.repeat(43), body: { computerId: 'synthetic_computer_0001', ...body }, allowLocalTest: true,
  })
  const fundedLuna = { assertCurrent() {}, status: () => post('status', {}), respond: body => post('respond', body) }
  const toolSession = {
    listTools: async () => [{ name: 'run_computer_command', description: 'Synthetic command; no shell is run.',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }],
    callTool: async (name, args) => {
      assert.equal(name, 'run_computer_command'); assert.equal(args.command, 'synthetic:change-once')
      commandCount++; confirmedEffects++
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, status: 'completed',
        jobId: 'synthetic-job', exitCode: 0, signal: null, mainProcessExited: true, output: 'Confirmed synthetic effect once.' }) }] }
    },
  }
  await assert.rejects(sendLuna({ provider: 'luna', model: MODEL, requestId: 'synthetic-native-turn',
    context: '{}', messages: [{ role: 'user', content: 'Complete one synthetic command.' }], toolsEnabled: true }, {
    fundedLuna, toolSession, recoveryTiming: { sleep: async () => assert.fail('No failed paid request may be replayed') },
    onWaiting: waiting => waits.push(waiting),
  }), error => {
    assert.equal(error.code, scenario.code)
    assert.equal(lunaPromptWasNotSent(error), false)
    assert.doesNotMatch(error.message, /PRIVATE|unknown_private_failure/)
    if (['LUNA_REQUEST_REJECTED', 'LUNA_SERVICE_UNAVAILABLE', 'LUNA_RESPONSE_UNCERTAIN', 'LUNA_INVALID_RESPONSE'].includes(error.code)) {
      assert.doesNotMatch(error.message, /connect this computer|check its funded access|account connection/i)
    }
    return true
  })
  assert.equal(statusCount, 1); assert.equal(requests.length, 2)
  assert.equal(commandCount, 1); assert.equal(confirmedEffects, 1)
  assert.match(requests[1].input.find(item => item.type === 'function_call_output').output, /Confirmed synthetic effect once/)
  assert.equal(waits.includes(true), false)
  assert.equal((await fundedLuna.status()).remainingMicroUsd, remainingMicroUsd)
  assert.equal(commandCount, 1); assert.equal(requests.length, 2)
  if (scenario.timeout) assert.ok(deadlines.length === 4 && deadlines.every(value => value === 75000))
})
