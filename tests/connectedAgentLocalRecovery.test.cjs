'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { sendLocalWithTools } = require('../electron/connectedAgentLocalTools.cjs')
const { MAX_PREDICTIONS } = require('../electron/connectedAgentLocalDiagnostics.cjs')

const request = { model: 'fixture/local-model', endpoint: 'http://127.0.0.1:1234/v1', context: '{}',
  messages: [{ role: 'user', content: 'Inspect the fixture and report only observed results.' }] }
const catalog = [{ name: 'get_timeline', description: 'Read the fixture timeline.', inputSchema: { type: 'object', properties: {} } }]
const call = id => ({ id, type: 'function', function: { name: 'get_timeline', arguments: '{}' } })
const reply = (message, finishReason = message.tool_calls ? 'tool_calls' : 'stop') => new Response(JSON.stringify({
  choices: [{ message: { ...message, reasoning_content: 'PRIVATE_REASONING_DO_NOT_EXPOSE' }, finish_reason: finishReason }],
  usage: { prompt_tokens: 100, completion_tokens: 10 },
}), { headers: { 'Content-Type': 'application/json' } })

function fixture(responder) {
  const bodies = [], calls = [], events = [], controller = new AbortController()
  const options = { signal: controller.signal, onEvent: event => events.push(event),
    toolSession: { listTools: async () => catalog, callTool: async (name, args) => {
      calls.push({ name, args })
      return { content: [{ type: 'text', text: '{"clipCount":6}' }] }
    } },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); bodies.push(body)
      return responder({ body, prediction: bodies.length, controller, signal: options.signal })
    },
  }
  return { bodies, calls, events, controller, options }
}
function assertFinalOnly(body) {
  assert.deepEqual(body.tools, [])
  assert.equal(body.tool_choice, 'none')
  assert.equal(body.messages.filter(message => message.role === 'system').length, 1)
}

test('an empty reply gets exactly one answer-only recovery after more than twelve tool rounds', async () => {
  const toolRounds = 17
  const f = fixture(({ prediction }) => prediction <= toolRounds
    ? reply({ tool_calls: [call(`read-${prediction}`)] })
    : reply({ content: prediction === toolRounds + 1 ? '' : 'All seventeen inspection results were received; no edit was requested.' }))
  const result = await sendLocalWithTools(request, f.options)
  assert.equal(result.success, true)
  assert.equal(f.bodies.length, 19)
  assert.equal(f.calls.length, 17)
  assert.equal(f.bodies[17].tool_choice, 'auto')
  assertFinalOnly(f.bodies[18])
  assert.doesNotMatch(f.bodies[17].messages[0].content, /tool budget is exhausted/)
  assert.match(f.bodies[18].messages[0].content, /previous response contained no user-facing answer/)
  assert.doesNotMatch(JSON.stringify({ result, bodies: f.bodies, events: f.events }), /PRIVATE_REASONING/)
})

test('an empty recovery after a long conversation preserves only the latest bounded diagnostics', async () => {
  const toolRounds = 20
  const f = fixture(({ prediction }) => {
    assert.ok(prediction <= toolRounds + 2, 'No third answer request is permitted')
    return prediction <= toolRounds ? reply({ tool_calls: [call(`read-${prediction}`)] }) : reply({ content: null })
  })
  await assert.rejects(sendLocalWithTools(request, f.options), error => {
    assert.equal(error.code, 'EMPTY_RESPONSE')
    assert.equal(error.localDiagnostics.length, MAX_PREDICTIONS)
    assert.deepEqual(error.localDiagnostics.map(item => item.prediction), Array.from({ length: MAX_PREDICTIONS }, (_, i) => toolRounds + 3 - MAX_PREDICTIONS + i))
    assert.equal(error.localDiagnostics.at(-2).answerRecovery, false)
    assert.equal(error.localDiagnostics.at(-1).answerRecovery, true)
    assert.equal(error.localDiagnostics.at(-1).prediction, 22)
    assert.equal(error.localDiagnostics.at(-1).parsedToolCalls, 0)
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_REASONING/)
    return true
  })
  assert.equal(f.bodies.length, 22)
  assert.equal(f.calls.length, 20)
})

test('an early empty answer still gets only one recovery, not the remaining round budget', async () => {
  for (const finalContent of ['Inspection did not run.', '']) {
    const f = fixture(({ prediction }) => {
      assert.ok(prediction <= 2)
      return reply({ content: prediction === 1 ? '' : finalContent })
    })
    if (finalContent) assert.equal((await sendLocalWithTools(request, f.options)).text, finalContent)
    else await assert.rejects(sendLocalWithTools(request, f.options), { code: 'EMPTY_RESPONSE' })
    assert.equal(f.bodies.length, 2); assert.equal(f.calls.length, 0)
    assertFinalOnly(f.bodies[1])
  }
})

test('tool calls returned during recovery are rejected before dispatch, early or after many actions', async () => {
  for (const priorToolRounds of [0, 17]) {
    const f = fixture(({ prediction }) => prediction <= priorToolRounds
      ? reply({ tool_calls: [call(`read-${prediction}`)] })
      : prediction === priorToolRounds + 1 ? reply({ content: '' }) : reply({ tool_calls: [call('forbidden-recovery-call')] }))
    await assert.rejects(sendLocalWithTools(request, f.options), { code: 'INVALID_RESPONSE' })
    assert.equal(f.calls.length, priorToolRounds)
    assert.equal(f.bodies.length, priorToolRounds + 2)
    assertFinalOnly(f.bodies.at(-1))
  }
})

test('more than forty-eight completed calls receive only one answer-only recovery without action replay', async () => {
  const f = fixture(({ prediction }) => prediction === 1
    ? reply({ tool_calls: Array.from({ length: 55 }, (_, i) => call(`read-${i}`)) })
    : reply({ content: prediction === 2 ? '' : 'The requested inspections returned.' }))
  assert.equal((await sendLocalWithTools(request, f.options)).success, true)
  assert.equal(f.calls.length, 55)
  assert.equal(f.bodies.length, 3)
  assert.equal(f.bodies[1].tool_choice, 'auto'); assertFinalOnly(f.bodies[2])
})

test('cancellation before a late recovery prevents another provider request or host call', async () => {
  const f = fixture(({ prediction, controller }) => {
    if (prediction <= 17) return reply({ tool_calls: [call(`read-${prediction}`)] })
    controller.abort()
    return reply({ content: '' })
  })
  await assert.rejects(sendLocalWithTools(request, f.options), { code: 'CANCELLED' })
  assert.equal(f.bodies.length, 18)
  assert.equal(f.calls.length, 17)
})

test('cancellation during the recovery stops without reopening tools or leaking private response text', async () => {
  const f = fixture(({ prediction, controller, signal }) => {
    if (prediction === 1) return reply({ content: '' })
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Error('PRIVATE_NETWORK_ERROR')), { once: true })
      controller.abort()
    })
  })
  await assert.rejects(sendLocalWithTools(request, f.options), error => {
    assert.equal(error.code, 'CANCELLED')
    assert.doesNotMatch(error.message, /PRIVATE/)
    return true
  })
  assert.equal(f.bodies.length, 2); assert.equal(f.calls.length, 0)
})

test('truncated provider responses are still incomplete, not eligible for answer recovery', async () => {
  const f = fixture(() => reply({ content: '' }, 'length'))
  await assert.rejects(sendLocalWithTools(request, f.options), { code: 'INCOMPLETE_RESPONSE' })
  assert.equal(f.bodies.length, 1); assert.equal(f.calls.length, 0)
})
