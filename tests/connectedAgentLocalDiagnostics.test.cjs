'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { sendLocalWithTools } = require('../electron/connectedAgentLocalTools.cjs')
const { MAX_PREDICTIONS, MAX_CONTENT_CHARS, MAX_TOKEN_COUNT, MAX_TOOL_CALLS,
  sanitizeLocalDiagnostics, createLocalPredictionDiagnostic } = require('../electron/connectedAgentLocalDiagnostics.cjs')

const request = { model: 'fixture/local-model', endpoint: 'http://127.0.0.1:1234/v1',
  context: 'PRIVATE_PROJECT_CONTEXT', messages: [{ role: 'user', content: 'PRIVATE_USER_PROMPT' }] }
const readCatalog = [{ name: 'get_timeline', description: 'Inspect the test timeline.', inputSchema: { type: 'object', properties: {} } }]
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const response = (message, { finish = 'stop', prompt = 100, completion = 10 } = {}) => new Response(JSON.stringify({
  choices: [{ finish_reason: finish, message: { ...message, reasoning_content: 'PRIVATE_REASONING_CONTENT' } }],
  usage: { prompt_tokens: prompt, completion_tokens: completion, completion_tokens_details: { reasoning_tokens: 9 } },
  internal_state: 'PRIVATE_PROVIDER_STATE',
}), { headers: { 'Content-Type': 'application/json' } })
const base = { prediction: 1, finishReason: 'stop', publicContentChars: 0, parsedToolCalls: 0,
  promptTokens: 100, completionTokens: 10, answerRecovery: false }

test('diagnostics have a fixed numeric/enum allowlist and never inspect reasoning content', () => {
  const message = { content: 'PUBLIC_RESPONSE_SECRET', tool_calls: [toolCall('one', 'PRIVATE_TOOL_NAME', { secret: 'PRIVATE_ARGUMENT' })] }
  Object.defineProperty(message, 'reasoning_content', { get() { throw Error('Private reasoning must not be read') } })
  const data = { choices: [{ message, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 101, completion_tokens: 12 } }
  const result = createLocalPredictionDiagnostic(data, { prediction: 2, answerRecovery: true })
  assert.deepEqual(result, { prediction: 2, finishReason: 'tool_calls', publicContentChars: 22, parsedToolCalls: 1,
    promptTokens: 101, completionTokens: 12, answerRecovery: true })
  assert.ok(!JSON.stringify(result).includes('PRIVATE'))
  assert.ok(!JSON.stringify(result).includes('PUBLIC_RESPONSE_SECRET'))
  assert.equal(MAX_PREDICTIONS, 14, 'This bounds retained diagnostics, not execution rounds')
})

test('native-boundary sanitizer drops arbitrary fields, duplicates and unbounded numbers', () => {
  const sanitized = sanitizeLocalDiagnostics([{ ...base, finishReason: 'PRIVATE_ERROR_TEXT', rawResponse: 'SECRET',
    promptTokens: -1, completionTokens: MAX_TOKEN_COUNT + 1, parsedToolCalls: MAX_TOOL_CALLS + 1,
    publicContentChars: MAX_CONTENT_CHARS + 1, answerRecovery: 'true' },
  null, { ...base, prediction: 1, rawResponse: 'duplicate' }, { ...base, prediction: 0 },
  { ...base, prediction: 2, completionTokens: '123', promptTokens: NaN }])
  assert.deepEqual(sanitized, [
    { ...base, finishReason: 'unknown', promptTokens: null, completionTokens: null, parsedToolCalls: null, publicContentChars: null },
    { ...base, prediction: 2, completionTokens: null, promptTokens: null },
  ])
  assert.deepEqual(sanitizeLocalDiagnostics({ localDiagnostics: [base] }), [])
  const tail = sanitizeLocalDiagnostics(Array.from({ length: 1000 }, (_, i) => ({ ...base, prediction: i + 1 })))
  assert.equal(tail.length, MAX_PREDICTIONS)
  assert.deepEqual(tail.map(item => item.prediction), Array.from({ length: MAX_PREDICTIONS }, (_, i) => 1001 - MAX_PREDICTIONS + i))
  for (const value of [Infinity, Number.MAX_SAFE_INTEGER, {}, []]) {
    assert.equal(sanitizeLocalDiagnostics([{ ...base, promptTokens: value }])[0].promptTokens, null)
  }
})

test('prediction numbers beyond the diagnostic retention length remain valid metadata', () => {
  const diagnostic = createLocalPredictionDiagnostic({ choices: [{ message: { content: 'Done' }, finish_reason: 'stop' }] },
    { prediction: 81, answerRecovery: true })
  assert.equal(diagnostic.prediction, 81)
  assert.equal(diagnostic.answerRecovery, true)
  assert.equal(diagnostic.publicContentChars, 4)
  assert.deepEqual(sanitizeLocalDiagnostics([{ ...base, prediction: 0 }, { ...base, prediction: Infinity },
    { ...base, prediction: 1.5 }, { ...base, prediction: -1 }]), [])
})

test('two empty public replies attach only bounded diagnostics and make exactly one answer recovery', async () => {
  const requests = [], events = []
  let caught
  try {
    await sendLocalWithTools(request, { signal: new AbortController().signal, onEvent: event => events.push(event),
      toolSession: { listTools: async () => readCatalog, callTool: async () => assert.fail('No host tool should run') },
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body))
        assert.ok(requests.length <= 2, 'Recovery must stop after one prediction')
        return response({ content: requests.length === 1 ? null : '' }, { prompt: 100 + requests.length, completion: 20 + requests.length })
      } })
  } catch (error) { caught = error }
  assert.equal(caught?.code, 'EMPTY_RESPONSE')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].tool_choice, 'auto')
  assert.equal(requests[1].tool_choice, 'none')
  assert.deepEqual(requests[1].tools, [])
  assert.deepEqual(caught.localDiagnostics, [
    { ...base, promptTokens: 101, completionTokens: 21 },
    { ...base, prediction: 2, promptTokens: 102, completionTokens: 22, answerRecovery: true },
  ])
  assert.ok(!JSON.stringify(caught).includes('PRIVATE'))
  assert.ok(!events.some(event => event.type === 'delta'))
  assert.ok(!JSON.stringify(events).includes('PRIVATE'))
})

test('empty-answer recovery records prior tools but never replays an already completed action', async () => {
  const requests = [], nativeCalls = []
  let timelineName = 'Before', caught
  const catalog = [{ name: 'rename_timeline', description: 'Rename the test timeline.', inputSchema: { type: 'object',
    properties: { name: { type: 'string' } }, required: ['name'] } }]
  const messages = [
    { content: null, tool_calls: [toolCall('discover', 'discover_velorn_tools', { names: ['rename_timeline'] })] },
    { content: null, tool_calls: [toolCall('rename', 'rename_timeline', { name: 'After' })] },
    { content: '' }, { content: null },
  ]
  try {
    await sendLocalWithTools(request, { signal: new AbortController().signal,
      toolSession: { listTools: async () => catalog, callTool: async (name, args) => {
        nativeCalls.push({ name, args }); timelineName = args.name
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, name: timelineName }) }] }
      } }, fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body))
        const message = messages.shift(); assert.ok(message, 'No additional prediction is permitted')
        return response(message, { finish: message.tool_calls ? 'tool_calls' : 'stop' })
      } })
  } catch (error) { caught = error }
  assert.equal(caught?.code, 'EMPTY_RESPONSE')
  assert.equal(requests.length, 4)
  assert.equal(timelineName, 'After')
  assert.deepEqual(nativeCalls, [{ name: 'rename_timeline', args: { name: 'After' } }])
  assert.deepEqual(caught.localDiagnostics.map(item => item.parsedToolCalls), [1, 1, 0, 0])
  assert.deepEqual(caught.localDiagnostics.map(item => item.answerRecovery), [false, false, false, true])
  assert.deepEqual(requests[3].tools, [])
  assert.equal(requests[3].tool_choice, 'none')
  assert.ok(!JSON.stringify(caught.localDiagnostics).includes('rename_timeline'))
})

test('diagnostic instrumentation leaves successful answers and other failures unchanged', async () => {
  const successful = await sendLocalWithTools(request, { signal: new AbortController().signal,
    toolSession: { listTools: async () => readCatalog, callTool: async () => assert.fail() }, fetchImpl: async () => response({ content: 'Done' }) })
  assert.deepEqual(successful, { success: true, text: 'Done' })
  await assert.rejects(sendLocalWithTools(request, { signal: new AbortController().signal,
    toolSession: { listTools: async () => readCatalog, callTool: async () => assert.fail() },
    fetchImpl: async () => response({ content: '' }, { finish: 'length' }) }), error => {
    assert.equal(error.code, 'INCOMPLETE_RESPONSE')
    assert.equal(Object.hasOwn(error, 'localDiagnostics'), false)
    return true
  })
})
