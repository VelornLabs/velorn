'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { sendLocalWithTools, LIMITS, createPausableTimeout, localHistory } = require('../electron/connectedAgentLocalTools.cjs')
test('Full access zero duration has no wall-clock timer even across waits', () => {
  const timer=createPausableTimeout(()=>assert.fail('No deadline expected'),0,{setTimer:()=>assert.fail('No timer should be installed')})
  timer.setWaiting(true);timer.setWaiting(false);timer.dispose()
})
const { parseModelTransport, unpackLocalUserMessage } = require('./helpers/localAgentTransport.cjs')
const catalog = Array.from({ length: 162 }, (_, i) => ({ name: i === 1 ? 'get_timeline' : `tool_${i}`, description: `Velorn tool ${i}`, inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }))
const request = overrides => ({ model: 'local-model', endpoint: 'http://127.0.0.1:1234/v1', context: '{}', messages: [{ role: 'user', content: 'Inspect and edit.' }], images: [], ...overrides })
const call = (id, name = 'get_timeline', args = '{}') => ({ id, type: 'function', function: { name, arguments: args } })
const reply = message => new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }] }), { headers: { 'Content-Type': 'application/json' } })
function assertFixtureTools(body, extra = []) {
  assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), ['call_velorn_tool', 'discover_velorn_tools', 'get_timeline', ...extra].sort())
}
function assertCatalogVisible(body, definitions) {
  const supplied = new Set(body.tools.map(tool => tool.function.name))
  for (const definition of definitions) assert.ok(supplied.has(definition.name)
    || body.messages[0].content.includes(definition.name), definition.name)
}
function mock(replies, operation = async () => ({ content: [{ type: 'text', text: 'Observed result' }] })) {
  const requests = []; const calls = []
  return { requests, calls, fetchImpl: async (url, options) => { requests.push({ url, options, body: JSON.parse(options.body) }); return reply(replies.shift()) }, toolSession: { listTools: async () => catalog, callTool: async (...args) => { calls.push(args); return operation(...args) } } }
}

test('Full access local instructions request direct actions, not mandatory previews or approvals', async () => {
  const deps = mock([{ content: 'Ready.' }])
  await sendLocalWithTools(request({ fullAccess: true }), deps)
  const system = deps.requests[0].body.messages[0].content
  assert.match(system, /Full access is enabled/)
  assert.match(system, /No separate approval, preview, checkpoint/)
  assert.doesNotMatch(system, /Host approval is required|Native approval, preview and spending gates still apply/)
})

test('local provider exposes all names and a direct router, dispatches serially, and preserves tool messages', async () => {
  const events = []; let active = false
  const deps = mock([{ tool_calls: [call('discover', 'discover_velorn_tools', '{"names":["tool_161"]}')] }, { content: null, tool_calls: [call('a', 'tool_161', '{"value":"x"}'), call('b')] }, { content: 'Completed after host approval.' }], async () => { assert.equal(active, false); active = true; await new Promise(resolve => setImmediate(resolve)); active = false; return { content: [{ type: 'text', text: 'approved' }] } })
  const result = await sendLocalWithTools(request(), { ...deps, onEvent: event => events.push(event) })
  assert.equal(result.text, 'Completed after host approval.')
  assertFixtureTools(deps.requests[0].body)
  assertFixtureTools(deps.requests[1].body, ['tool_161'])
  assertCatalogVisible(deps.requests[0].body, catalog)
  assert.deepEqual(parseModelTransport(deps.requests[1].body.messages.at(-1).content).tools[0], catalog[161])
  assert.equal(deps.requests[0].body.parallel_tool_calls, false)
  assert.equal(deps.requests[0].options.redirect, 'error')
  assert.deepEqual(deps.calls, [['tool_161', { value: 'x' }], ['get_timeline', {}]])
  assert.deepEqual(deps.requests[2].body.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['discover', 'a', 'b'])
  assert.equal(events.filter(event => event.type === 'delta').length, 1)
})

test('exact tool-name mentions do not change direct catalog availability', async () => {
  const named = [
    ...catalog,
    { name: 'get_export_status', description: 'Inspect an export job.', inputSchema: { type: 'object', properties: { jobId: { type: 'string' } } } },
    { name: 'inspect_timeline_frame', description: 'Inspect a rendered timeline frame.', inputSchema: { type: 'object', properties: { time: { type: 'number' } } } },
  ]
  const deps = mock([{ content: 'The named inspection tools are available.' }])
  deps.toolSession.listTools = async () => named
  await sendLocalWithTools(request({ messages: [{ role: 'user', content: 'Use GET_EXPORT_STATUS and inspect timeline frame, then report what you observe.' }] }), deps)
  assertFixtureTools(deps.requests[0].body)
  assertCatalogVisible(deps.requests[0].body, named)
})

test('natural language and older assistant text do not hide any valid tools', async () => {
  const named = [
    ...catalog,
    { name: 'get_export_status', description: 'Inspect an export job.', inputSchema: { type: 'object', properties: {} } },
    { name: 'inspect_timeline_frame', description: 'Inspect a rendered timeline frame.', inputSchema: { type: 'object', properties: {} } },
  ]
  const deps = mock([{ content: 'No extra schema was requested by exact name.' }])
  deps.toolSession.listTools = async () => named
  await sendLocalWithTools(request({ messages: [
    { role: 'assistant', content: 'Earlier I suggested inspect_timeline_frame.' },
    { role: 'user', content: 'Check export status with invented_export_tool, without guessing a tool name.' },
  ] }), deps)
  assertFixtureTools(deps.requests[0].body)
  assertCatalogVisible(deps.requests[0].body, named)
})

test('a natural-language new-timeline request calls the native tool through the first-prediction router without discovery', async () => {
  const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
  const nativeCatalog = createComfyStudioMcpServer().tools
  const args = { name: 'Music video alternate', previewOnly: false }
  const deps = mock([
    { tool_calls: [call('new-timeline', 'call_velorn_tool', JSON.stringify({ name: 'create_timeline', arguments: args }))] },
    { content: 'Created the requested separate timeline.' },
  ], async () => ({ content: [{ type: 'text', text: '{"success":true,"timelineId":"fixture-new"}' }] }))
  deps.toolSession.listTools = async () => nativeCatalog
  await sendLocalWithTools(request({ fullAccess: true, messages: [{ role: 'user', content:
    'Create a separate timeline named Music video alternate and keep the original edit unchanged.' }] }), deps)
  const supplied = deps.requests[0].body.tools
  assert.ok(nativeCatalog.length >= 170)
  assertCatalogVisible(deps.requests[0].body, nativeCatalog)
  const routerParameters = supplied.find(tool => tool.function.name === 'call_velorn_tool').function.parameters
  assert.equal(routerParameters.properties.name.type, 'string')
  assert.equal(routerParameters.properties.arguments.type, 'object')
  assert.ok(supplied.some(tool => tool.function.name === 'get_timeline'))
  assert.deepEqual(deps.calls, [['create_timeline', args]])
  assert.equal(deps.requests.length, 2)
  assert.deepEqual(deps.requests[1].body.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['new-timeline'])
  const returned = parseModelTransport(deps.requests[1].body.messages.find(message => message.tool_call_id === 'new-timeline').content)
  assert.deepEqual(returned.result, { content: [{ type: 'text', text: '{"success":true,"timelineId":"fixture-new"}' }] })
})

test('unknown and malformed arguments are tool errors, never arbitrary execution', async () => {
  const deps = mock([{ tool_calls: [call('a', 'shell', '{}'), call('b', 'get_timeline', '{bad')] }, { content: 'No action was performed.' }])
  await sendLocalWithTools(request(), deps)
  assert.equal(deps.calls.length, 0)
  assert.ok(deps.requests[1].body.messages.filter(message => message.role === 'tool').every(message => parseModelTransport(message.content).result.isError))
})

test('a known native tool name can be called immediately even when represented by the router', async () => {
  const deps = mock([{ tool_calls: [call('native-direct', 'tool_161', '{"value":"requested"}')] }, { content: 'Completed.' }])
  await sendLocalWithTools(request(), deps)
  assertFixtureTools(deps.requests[0].body)
  assert.deepEqual(deps.calls, [['tool_161', { value: 'requested' }]])
  assert.equal(deps.requests.length, 2)
})

test('complete public tool markup can directly call a known non-core tool with empty arguments', async () => {
  const deps = mock([{ content: '<tool_call>{"name":"tool_161","arguments":{}}</tool_call>' }, { content: 'Completed.' }])
  await sendLocalWithTools(request(), deps)
  assertFixtureTools(deps.requests[0].body)
  assert.deepEqual(deps.calls, [['tool_161', {}]])
  assert.equal(deps.requests.length, 2)
})

test('router forwards arguments unchanged and respects the same host result in Work and Full access', async () => {
  const args = { value: 'requested', previewOnly: false, nested: { values: [1, 'two', false] } }
  const original = { isError: true, content: [{ type: 'text', text: 'Host declined this action; nothing applied.' }] }
  for (const fullAccess of [false, true]) {
    const deps = mock([{ tool_calls: [call('routed', 'call_velorn_tool', JSON.stringify({ name: 'tool_161', arguments: args }))] },
      { content: 'The host declined the action.' }], async () => original)
    await sendLocalWithTools(request({ fullAccess }), deps)
    assert.deepEqual(deps.calls, [['tool_161', args]])
    assert.deepEqual(parseModelTransport(deps.requests[1].body.messages.at(-1).content).result, original)
    assert.equal(deps.requests.length, 2)
  }
})

test('router rejects invented tools, recursive helper routing, and non-object operands before native dispatch', async () => {
  const malformed = [
    {},
    { name: 'get_timeline' },
    { arguments: {} },
    { name: 'get_timeline', arguments: null },
    { name: 'get_timeline', arguments: {}, extra: true },
    { name: 'invented_tool', arguments: {} },
    { name: 'get_timeline', arguments: '{}' },
    { name: 'get_timeline', arguments: [] },
    { name: 'call_velorn_tool', arguments: { name: 'get_timeline', arguments: {} } },
    { name: 'discover_velorn_tools', arguments: { names: ['get_timeline'] } },
  ]
  const deps = mock([{ tool_calls: malformed.map((args, i) => call(`invalid-route-${i}`, 'call_velorn_tool', JSON.stringify(args))) },
    { content: 'No native action ran.' }])
  await sendLocalWithTools(request(), deps)
  assert.deepEqual(deps.calls, [])
  const results = deps.requests[1].body.messages.filter(message => message.role === 'tool')
  assert.equal(results.length, malformed.length)
  assert.ok(results.every(message => parseModelTransport(message.content).result.isError))
})

test('optional lookup adds schemas without gating calls or removing previously supplied schemas', async () => {
  const deps = mock([
    { tool_calls: [call('d1', 'discover_velorn_tools', '{"names":["tool_2"]}'), call('premature', 'tool_2')] },
    { tool_calls: [call('d2', 'discover_velorn_tools', '{"names":["tool_3"]}'), call('advertised', 'tool_2')] },
    { content: 'Both explicitly requested actions ran.' },
  ])
  await sendLocalWithTools(request(), deps)
  assert.deepEqual(deps.calls, [['tool_2', {}], ['tool_2', {}]])
  assert.equal(parseModelTransport(deps.requests[1].body.messages.find(message => message.tool_call_id === 'premature').content).result.isError, undefined)
  assertFixtureTools(deps.requests[0].body)
  assertFixtureTools(deps.requests[1].body, ['tool_2'])
  assertFixtureTools(deps.requests[2].body, ['tool_2', 'tool_3'])
})

test('unknown optional lookup is recoverable and does not prevent a valid direct call', async () => {
  const deps = mock([
    { tool_calls: [call('unknown', 'discover_velorn_tools', '{"names":["invented_tool"],"query":""}')] },
    { tool_calls: [call('correct', 'discover_velorn_tools', '{"names":["tool_161"],"query":""}'), call('direct', 'tool_161', '{"value":"first requested"}')] },
    { tool_calls: [call('explicit', 'tool_161', '{"value":"requested"}')] },
    { content: 'The explicitly requested tool completed.' },
  ])
  const hostCallsAtPrediction = []
  const fetchImpl = deps.fetchImpl
  deps.fetchImpl = async (...args) => { hostCallsAtPrediction.push(deps.calls.length); return fetchImpl(...args) }
  await sendLocalWithTools(request(), deps)

  assert.deepEqual(hostCallsAtPrediction, [0, 0, 1, 2])
  assert.deepEqual(deps.calls, [['tool_161', { value: 'first requested' }], ['tool_161', { value: 'requested' }]])
  const receipt = (index, id) => parseModelTransport(deps.requests[index].body.messages.find(message => message.tool_call_id === id).content)
  const unknown = receipt(1, 'unknown')
  assert.equal(unknown.error.code, 'UNKNOWN_TOOL')
  assert.deepEqual(unknown.unknown, ['invented_tool'])
  assert.equal(unknown.schemasChanged, false)
  assert.equal(unknown.actionExecuted, false)
  const corrected = receipt(2, 'correct')
  assert.equal(corrected.schemasChanged, true)
  assert.equal(corrected.actionExecuted, false)
  assert.equal(receipt(2, 'direct').result.isError, undefined)
  for (const index of [0, 1]) {
    assertFixtureTools(deps.requests[index].body)
  }
  assertFixtureTools(deps.requests[2].body, ['tool_161'])
  assert.deepEqual(corrected.tools[0], catalog[161])
  assert.deepEqual(deps.requests[3].body.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['unknown', 'correct', 'direct', 'explicit'])
})

test('discovery accepts a supplied query alongside exact names and still does not execute tools', async () => {
  for (const args of [{ names: [], query: 'tool_161' }, { names: ['tool_161'], query: ' \t\n' }, { names: ['tool_161'], query: 'drone city buildings above' }]) {
    const deps = mock([
      { tool_calls: [call('discover', 'discover_velorn_tools', JSON.stringify(args))] },
      { content: 'The schema is loaded; no action was requested.' },
    ])
    await sendLocalWithTools(request(), deps)
    const receipt = parseModelTransport(deps.requests[1].body.messages.at(-1).content)
    assert.equal(receipt.available, true)
    assert.equal(receipt.schemasChanged, true)
    assert.equal(receipt.actionExecuted, false)
    assertFixtureTools(deps.requests[1].body, ['tool_161'])
    assert.deepEqual(receipt.tools[0], catalog[161])
    assert.deepEqual(deps.calls, [])
  }
})

test('empty-selector compatibility does not accept ambiguous, malformed, unbounded, or unknown discovery', async () => {
  const invalidArgs = [
    { names: ['tool_161'], query: null },
    { names: null, query: 'tool_161' },
    { names: 'tool_161', query: '' },
    { names: ['tool_161'], query: [] },
    { names: [], query: 161 },
    { names: [], query: '' },
    { names: [], query: ' \t\n' },
    { names: ['tool_161'], query: ' '.repeat(257) },
    { names: [], query: 'x'.repeat(257) },
    { names: ['tool_161', 'tool_161'], query: '' },
    { names: ['tool_161'], query: '', extra: true },
  ]
  for (const args of [...invalidArgs, { names: ['tool_161', 'invented_tool'], query: '' }]) {
    const deps = mock([
      { tool_calls: [call('invalid', 'discover_velorn_tools', JSON.stringify(args))] },
      { content: 'No schemas or actions changed.' },
    ])
    await sendLocalWithTools(request(), deps)
    const receipt = parseModelTransport(deps.requests[1].body.messages.at(-1).content)
    assert.equal(receipt.error.code, args.names?.includes?.('invented_tool') ? 'UNKNOWN_TOOL' : 'INVALID_DISCOVERY_ARGUMENTS', JSON.stringify(args))
    assert.equal(receipt.available, false)
    assert.equal(receipt.schemasChanged, false)
    assert.equal(receipt.actionExecuted, false)
    assert.deepEqual(receipt.activated, [])
    assertFixtureTools(deps.requests[1].body)
    assert.deepEqual(deps.calls, [])
  }
})

test('large results are paged exactly without rerunning the original host tool', async () => {
  const original = { content: [{ type: 'text', text: JSON.stringify({ prefix: 'x'.repeat(25000), finalMarker: 'observed-tail' }) }] }
  const originalJson = JSON.stringify(original)
  const deps = mock([], async () => original)
  let round = 0; let resultId
  deps.fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body); deps.requests.push({ body })
    if (round++ === 0) {
      assert.equal(body.tools.some(tool => tool.function.name === 'read_velorn_tool_result'), false)
      return reply({ tool_calls: [call('large')] })
    }
    if (round === 2) {
      assert.equal(body.tools.some(tool => tool.function.name === 'read_velorn_tool_result'), true)
      const packed = parseModelTransport(body.messages.at(-1).content)
      assert.equal(packed.truncated, true); assert.equal(packed.complete, false)
      resultId = packed.resultId
      return reply({ tool_calls: [call('page', 'read_velorn_tool_result', JSON.stringify({ resultId, representation: 'original', offset: originalJson.length - 100, maxChars: 100 }))] })
    }
    const page = parseModelTransport(body.messages.at(-1).content)
    assert.equal(page.raw, originalJson.slice(-100))
    assert.equal(page.resultId, resultId)
    assert.equal(page.endOfResult, true)
    return reply({ content: 'Observed the final marker.' })
  }
  await sendLocalWithTools(request(), deps)
  assert.equal(deps.calls.length, 1)
})

test('complete outcomes remain complete even when denied, and do not advertise unnecessary paging', async () => {
  const original = { isError: true, content: [{ type: 'text', text: '{"success":false,"error":"Denied"}' }],
    structuredContent: { success: false, error: 'Denied', complete: false }, _meta: { audit: 'keep' }, complete: false }
  const deps = mock([{ tool_calls: [call('denied')] }, { content: 'That action was denied.' }], async () => original)
  await sendLocalWithTools(request(), deps)
  const wrapper = parseModelTransport(deps.requests[1].body.messages.at(-1).content)
  assert.equal(wrapper.kind, 'local-tool-result-complete')
  assert.equal(wrapper.format, 'readable-mcp-v1')
  assert.equal(wrapper.complete, true)
  assert.equal(wrapper.truncated, false)
  assert.equal(wrapper.pagingAvailable, false)
  assert.deepEqual(wrapper.result, original)
  assert.ok(deps.requests.every(({ body }) => body.tools.every(tool => tool.function.name !== 'read_velorn_tool_result')))
  const instructions = deps.requests[0].body.messages[0].content
  assert.match(instructions, /Use observed results and computed timing/)
  assert.doesNotMatch(instructions, /trimStart \+ duration\/2|sourceDuration is the entire/)
})

test('a retained project snapshot enables paging in the first prediction', async () => {
  const context = JSON.stringify({ data: 'x'.repeat(14000) })
  const deps = mock([{ content: 'The snapshot is incomplete; no action taken.' }])
  await sendLocalWithTools(request({ context }), deps)
  assert.ok(deps.requests[0].body.tools.some(tool => tool.function.name === 'read_velorn_tool_result'))
  const wrapper = parseModelTransport(unpackLocalUserMessage(deps.requests[0].body.messages[1]).snapshot)
  assert.equal(wrapper.kind, 'local-tool-result-excerpt')
  assert.equal(wrapper.pagingAvailable, true)
  assert.equal(wrapper.toolCallId, 'project_snapshot')
})

test('paging is available only in the next prediction after a host result creates pages', async () => {
  const original = { content: [{ type: 'text', text: 'x'.repeat(15000) }] }
  const deps = mock([], async () => original)
  let round = 0
  deps.fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body); deps.requests.push({ body })
    if (++round === 1) return reply({ tool_calls: [call('large'), call('early_page', 'read_velorn_tool_result', '{"resultId":"not-real"}')] })
    if (round === 2) {
      const receipt = parseModelTransport(body.messages.at(-1).content)
      assert.equal(receipt.error.code, 'LOCAL_TOOL_RESULT_NOT_ADVERTISED')
      assert.equal(receipt.pagingAvailable, true)
      assert.equal(receipt.availableResultCount, 1)
      assert.doesNotMatch(JSON.stringify(receipt), /not-real/)
      return reply({ tool_calls: [call('page', 'read_velorn_tool_result', JSON.stringify({
        resultId: receipt.availableResults[0].resultId, offset: receipt.availableResults[0].nextUnreadOffset,
      }))] })
    }
    const page = parseModelTransport(body.messages.at(-1).content)
    assert.equal(page.kind, 'local-tool-result-page')
    assert.ok(page.deliveryProgress.newChars > 0)
    return reply({ content: 'Observed the existing result; no action replayed.' })
  }
  await sendLocalWithTools(request(), deps)
  assert.equal(deps.calls.length, 1)
})

test('repeated unsuccessful helpers do not stop a later real action in the same response', async () => {
  for (const name of ['read_velorn_tool_result', 'discover_velorn_tools']) {
    const args = name === 'read_velorn_tool_result' ? '{"resultId":"private-file-path"}' : '{"names":["get_timeline"]}'
    const deps = mock([...Array.from({ length: 5 }, (_, i) => ({ tool_calls: [
      call(`noop_${i}`, name, args), ...(i === 4 ? [call('requested-read')] : []),
    ] })), { content: 'The requested inspection completed.' }])
    const events = []
    assert.equal((await sendLocalWithTools(request(), { ...deps, onEvent: event => events.push(event) })).success, true)
    assert.equal(deps.requests.length, 6)
    assert.deepEqual(deps.calls, [['get_timeline', {}]])
    assert.equal(events.filter(event => event.type === 'delta').length, 1)
    const receipt = parseModelTransport(deps.requests[1].body.messages.at(-1).content)
    if (name === 'read_velorn_tool_result') {
      assert.equal(receipt.error.code, 'LOCAL_TOOL_RESULT_NOT_ADVERTISED')
      assert.equal(receipt.pagingAvailable, false)
      assert.deepEqual(receipt.availableResults, [])
      assert.doesNotMatch(JSON.stringify(receipt), /private-file-path/)
    }
  }
})

test('repeated optional lookup never executes an action implicitly or stops the conversation', async () => {
  const deps = mock([...Array.from({ length: 5 }, (_, i) => ({ tool_calls: [
    call(`discover_${i}`, 'discover_velorn_tools', '{"names":["tool_161"]}'),
  ] })), { content: 'Looked up the tool; no action was requested.' }])
  assert.equal((await sendLocalWithTools(request(), deps)).success, true)
  assert.equal(deps.requests.length, 6)
  assert.equal(deps.calls.length, 0)
  const initial = parseModelTransport(deps.requests[1].body.messages.at(-1).content)
  assert.equal(initial.schemasChanged, true)
  const repeated = parseModelTransport(deps.requests[2].body.messages.at(-1).content)
  assert.equal(repeated.schemasChanged, false)
  assert.equal(repeated.actionExecuted, false)
  assert.deepEqual(repeated.tools, [])
  assert.deepEqual(repeated.directFunctions, ['tool_161'])
  assert.deepEqual(repeated.alreadyDocumented, ['tool_161'])
})

test('blank-query lookup of an already supplied schema remains optional after many repeats', async () => {
  const deps = mock([...Array.from({ length: 5 }, (_, i) => ({ tool_calls: [
    call(`loaded_${i}`, 'discover_velorn_tools', '{"names":["get_timeline"],"query":""}'),
  ] })), { content: 'No action requested.' }])
  assert.equal((await sendLocalWithTools(request(), deps)).success, true)
  assert.equal(deps.requests.length, 6)
  assert.deepEqual(deps.calls, [])
  for (let i = 1; i < deps.requests.length; i++) {
    const receipt = parseModelTransport(deps.requests[i].body.messages.at(-1).content)
    assert.equal(receipt.available, true)
    assert.equal(receipt.schemasChanged, false)
    assert.equal(receipt.actionExecuted, false)
  }
})

test('optional lookup before and after a host denial neither bypasses denial nor replays the action', async () => {
  const discover = (id, name) => ({ tool_calls: [call(id, 'discover_velorn_tools', JSON.stringify({ names: [name] }))] })
  const deps = mock([
    discover('a1', 'tool_2'), discover('a2', 'tool_2'), discover('a3', 'tool_2'),
    discover('b1', 'tool_3'), discover('b2', 'tool_3'), discover('b3', 'tool_3'),
    { tool_calls: [call('host', 'tool_3')] }, discover('b4', 'tool_3'), discover('b5', 'tool_3'),
    { content: 'The host denied the action. Nothing was changed.' },
  ], async () => ({ isError: true, content: [{ type: 'text', text: 'Approval denied.' }] }))
  await sendLocalWithTools(request(), deps)
  assert.deepEqual(deps.calls, [['tool_3', {}]])
  const denied = parseModelTransport(deps.requests[7].body.messages.at(-1).content)
  assert.equal(denied.result.isError, true)
  assert.match(JSON.stringify(denied), /Approval denied/)
  deps.requests.forEach(({ body }, index) => assertFixtureTools(body,
    index === 0 ? [] : index < 4 ? ['tool_2'] : ['tool_2', 'tool_3']))
})

test('repeated unknown paging IDs remain recoverable without original-tool replay', async () => {
  const original = { content: [{ type: 'text', text: 'Secret original data '.repeat(1000) }] }
  const deps = mock([{ tool_calls: [call('large')] }, ...Array.from({ length: 5 }, (_, i) => ({ tool_calls: [
    call(`invalid_${i}`, 'read_velorn_tool_result', JSON.stringify({ resultId: '/private/path?key=secret' })),
  ] })), { content: 'The original result remains available; no action was repeated.' }], async () => original)
  assert.equal((await sendLocalWithTools(request(), deps)).success, true)
  assert.equal(deps.calls.length, 1)
  assert.equal(deps.requests.length, 7)
  const receipt = parseModelTransport(deps.requests[2].body.messages.at(-1).content)
  assert.equal(receipt.error.code, 'LOCAL_TOOL_RESULT_NOT_FOUND')
  assert.equal(receipt.availableResultCount, 1)
  assert.ok(receipt.availableResults[0].resultId.startsWith('result_'))
  assert.equal(receipt.availableResults[0].nextUnreadOffset, 3000)
  assert.doesNotMatch(JSON.stringify(receipt), /private\/path|key=secret|Secret original data/)
})

test('repeated already-delivered page ranges do not force a stop or repeat the original action', async () => {
  const deps = mock([], async () => ({ content: [{ type: 'text', text: 'x'.repeat(30000) }] }))
  let round = 0; let resultId
  deps.fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body); deps.requests.push({ body }); round++
    if (round === 1) return reply({ tool_calls: [call('large')] })
    if (round === 2) resultId = parseModelTransport(body.messages.at(-1).content).resultId
    if ([2, 3].includes(round)) return reply({ tool_calls: [call(`invalid_${round}`, 'read_velorn_tool_result', '{"resultId":"unknown"}')] })
    if (round === 5) {
      const page = parseModelTransport(body.messages.at(-1).content)
      assert.ok(page.deliveryProgress.newChars > 0)
    }
    if (round === 10) return reply({ content: 'The existing result was reviewed.' })
    return reply({ tool_calls: [call(`page_${round}`, 'read_velorn_tool_result', JSON.stringify({ resultId, offset: 3000, maxChars: 12000 }))] })
  }
  assert.equal((await sendLocalWithTools(request(), deps)).success, true)
  assert.equal(round, 10)
  assert.equal(deps.calls.length, 1)
})

test('current access is explicit and all accepted history survives beyond the former local 32 KiB cap', async () => {
  const messages = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}:` + 'Previous conversation. '.repeat(280) }))
  messages.push({ role: 'user', content: 'Inspect this without editing.' })
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) > 32 * 1024)
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) < 96 * 1024)
  const history = localHistory(messages)
  assert.deepEqual(history, { kept: messages, omitted: 0 })
  const deps = mock([{ content: 'Ready to inspect.' }])
  await sendLocalWithTools(request({ messages }), deps)
  const sent = deps.requests[0].body.messages
  assert.match(sent[0].content, /CURRENT ACCESS: Velorn tools are enabled/)
  assert.doesNotMatch(sent[0].content, /older chat messages were omitted/)
  assert.equal(sent.at(-1).role, messages.at(-1).role)
  assert.equal(unpackLocalUserMessage(sent.at(-1)).content, messages.at(-1).content)
  for (const message of messages) assert.ok(sent.some(item => typeof item.content === 'string' && item.content.includes(message.content)))
  const huge = mock([{ content: 'The provider accepted the request.' }])
  assert.equal((await sendLocalWithTools(request({ messages: [{ role: 'user', content: 'x'.repeat(180000) }] }), huge)).success, true)
  assert.equal(huge.requests.length, 1, 'The compaction byte target must not replace the loaded model’s actual context limit.')
  assert.equal(unpackLocalUserMessage(huge.requests[0].body.messages.at(-1)).content.length, 180000)
})

test('context overflow gives sanitized specific feedback and never retries a completed action', async () => {
  for (const contextError of [true, false]) {
    const deps = mock([])
    let requests = 0
    deps.fetchImpl = async () => ++requests === 1 ? reply({ tool_calls: [call('a')] }) : new Response(JSON.stringify({ error: {
      type: contextError ? 'exceed_context_size_error' : 'server_error', message: 'private backend path', n_prompt_tokens: 116117, n_ctx: 98304,
    } }), { status: 400 })
    await assert.rejects(sendLocalWithTools(request(), deps), error => {
      assert.equal(error.code, contextError ? 'LOCAL_CONTEXT_LIMIT' : 'PROVIDER_ERROR')
      assert.doesNotMatch(error.message, /private backend path/)
      assert.match(error.message, /Earlier tools may already have completed/)
      if (contextError) {
        assert.match(error.message, /116117.*98304/)
        assert.match(error.message, /Increase Context Length in LM Studio and reload/)
        assert.match(error.message, /supported limit and available memory/)
        assert.match(error.message, /does not trigger an automatic reload or retry/)
      }
      return true
    })
    assert.equal(deps.calls.length, 1); assert.equal(requests, 2)
  }
})

test('string context errors give reload guidance without exposing raw paths or invalid counts', async () => {
  for (const error of [
    'Context too long: PRIVATE_PATH with PRIVATE_TOKEN',
    { message: 'Requested tokens exceed context PRIVATE_PATH', n_prompt_tokens: -123, n_ctx: 'PRIVATE_TOKEN' },
  ]) {
    const deps = mock([])
    let requests = 0
    deps.fetchImpl = async () => { requests++; return new Response(JSON.stringify({ error }), { status: 400 }) }
    await assert.rejects(sendLocalWithTools(request(), deps), failure => {
      assert.equal(failure.code, 'LOCAL_CONTEXT_LIMIT')
      assert.match(failure.message, /Context Length in LM Studio/)
      assert.match(failure.message, /does not trigger an automatic reload or retry/)
      assert.doesNotMatch(failure.message, /PRIVATE_|-123/)
      return true
    })
    assert.equal(requests, 1); assert.deepEqual(deps.calls, [])
  }
})

test('empty public reply gets one answer-only recovery without replaying actions or exposing reasoning', async () => {
  const deps = mock([{ tool_calls: [call('a')] }, { content: '', reasoning_content: 'private reasoning never displayed' }, { content: 'The host denied that action.' }], async () => ({ isError: true, content: [{ type: 'text', text: 'Approval denied.' }] }))
  const events = []
  const result = await sendLocalWithTools(request(), { ...deps, onEvent: event => events.push(event) })
  assert.equal(result.text, 'The host denied that action.')
  assert.equal(deps.calls.length, 1)
  assert.equal(deps.requests.length, 3)
  assert.deepEqual(deps.requests.at(-1).body.tools, [])
  assert.equal(deps.requests.at(-1).body.tool_choice, 'none')
  assert.equal(deps.requests.at(-1).body.messages.filter(message => message.role === 'system').length, 1)
  assert.equal(deps.requests.at(-1).body.messages[0].role, 'system')
  assert.match(deps.requests.at(-1).body.messages[0].content, /must contain visible answer text.*private reasoning alone.*invalid/i)
  assert.doesNotMatch(JSON.stringify({ events, requests: deps.requests }), /private reasoning never displayed/)
  for (const finalMessage of [{ content: '' }, { tool_calls: [call('forbidden')] }]) {
    const bounded = mock([{ tool_calls: [call('a')] }, { content: '' }, finalMessage])
    await assert.rejects(sendLocalWithTools(request(), bounded))
    assert.equal(bounded.requests.length, 3)
    assert.equal(bounded.calls.length, 1)
  }
})

test('malformed action markup gets one format repair and never partial dispatch', async () => {
  const markup = '<tool_call>\n<function=rename_timeline>\n</function>\n</tool_call>'
  for (const content of [markup, `I inspected the project.\n\n${markup}`, `The edit was applied.\n${markup}\nDone.`,
    'I will inspect it now.\n<function=get_timeline>', 'Now creating the timeline.\n<tool_call',
    "I'll inspect it.\n<tool_call><function=get_timeline>", 'Unfinished response\n</tool_call>',
    'Now using the tool.\n<TOOL_CALL>']) {
    const events = [], deps = mock([{ content }, { content }])
    await assert.rejects(sendLocalWithTools(request(), { ...deps, onEvent: event => events.push(event) }), error => {
      assert.equal(error.code, 'INVALID_RESPONSE')
      assert.match(error.message, /not executed/)
      assert.match(error.message, /Earlier tools may already have completed/)
      return true
    })
    assert.deepEqual(deps.calls, [], content)
    assert.equal(deps.requests.length, 2, 'A malformed unexecuted request gets only one format repair')
    assert.deepEqual(events.filter(event => event.type === 'delta'), [], 'No partial prose is presented as a final answer')
  }
})

test('markup explanations in code, quotations, or escaped text remain unchanged public answers', async () => {
  const markup = '<tool_call><function=rename_timeline></function></tool_call>'
  for (const content of [
    'I inspected the timeline; no changes were needed.',
    `The server returned \`${markup}\`; Velorn did not execute it.`,
    `The example contains a backtick: \`\`<tool_call>\`literal\`</tool_call>\`\`.`,
    `Here is an example:\n\n\`\`\`xml\n${markup}\n\`\`\`\nIt is text, not an executed tool.`,
    `~~~xml\n${markup}\n~~~~\nThis is a quoted example.`,
    `\`\`\`\`xml\n\`\`\`\n${markup}\n\`\`\`\`\nThe shorter fence is literal.`,
    `The raw output was "${markup}"; no action happened.`,
    `The tag '<tool_call>' is not an action.`,
    '“<tool_call>” and ‘<function=get_timeline>’ are examples.',
    `Quoted output:\n> ${markup}\n\nThis was not executed.`,
    'The escaped tag is \\<tool_call>; &lt;function=get_timeline&gt; is escaped too.',
    'The names <tool_callback> and <functionality> are not tool request tags.',
    'The <tool_call> tag is part of the protocol.',
  ]) {
    const events = [], deps = mock([{ content }])
    assert.deepEqual(await sendLocalWithTools(request(), { ...deps, onEvent: event => events.push(event) }), { success: true, text: content })
    assert.deepEqual(deps.calls, [])
    assert.equal(deps.requests.length, 1)
    assert.deepEqual(events.filter(event => event.type === 'delta'), [{ type: 'delta', text: content }])
  }
})

test('a literal example does not hide subsequent unparsed action markup', async () => {
  for (const content of [
    'Example: `<tool_call>`. Now running:\n<function=get_timeline>',
    '```xml\n<tool_call>\n```\nI will run it now.\n<tool_call>',
    '~~~xml\n<tool_call>\n~~~\nI will run it now.\n<tool_call>',
    '> <tool_call>\n\nI will run it now.\n<tool_call>',
    'The tag is "<tool_call>". Now running:\n<tool_call>',
    'An unmatched ` delimiter must not hide\n<tool_call>',
    'A mismatched `` delimiter ` must not hide\n<tool_call>',
  ]) {
    const deps = mock([{ content }, { content }])
    await assert.rejects(sendLocalWithTools(request(), deps), { code: 'INVALID_RESPONSE' })
    assert.equal(deps.requests.length, 2)
    assert.deepEqual(deps.calls, [])
  }
})

test('malformed public markup after native tools or answer recovery never replays completed tools', async () => {
  for (const recover of [false, true]) for (const result of [
    { content: [{ type: 'text', text: JSON.stringify({ success: true, applied: true }) }] },
    { isError: true, content: [{ type: 'text', text: 'Host denied this change.' }] },
  ]) {
    const malformed = { content: 'I inspected the result.\n<tool_call><function=get_timeline>', reasoning_content: 'private reasoning must not leak' }
    const events = [], deps = mock([{ tool_calls: [call('a')] }, ...(recover ? [{ content: '' }] : []),
      malformed, ...(recover ? [] : [malformed])], async () => result)
    await assert.rejects(sendLocalWithTools(request(), { ...deps, onEvent: event => events.push(event) }), { code: 'INVALID_RESPONSE' })
    assert.deepEqual(deps.calls, [['get_timeline', {}]])
    assert.equal(deps.requests.length, 3)
    assert.deepEqual(parseModelTransport(deps.requests.at(-1).body.messages.find(message => message.role === 'tool').content).result, result)
    if (recover) {
      assert.deepEqual(deps.requests.at(-1).body.tools, [])
      assert.equal(deps.requests.at(-1).body.tool_choice, 'none')
    }
    assert.deepEqual(events.filter(event => event.type === 'delta'), [])
    assert.doesNotMatch(JSON.stringify({ events, requests: deps.requests }), /private reasoning must not leak/)
  }
})

test('complete public tool formats use normal dispatch and only the subsequent final answer is shown', async () => {
  for (const content of [
    '<tool_call>{"name":"get_timeline","arguments":{"value":"actual"}}</tool_call>',
    '[TOOL_REQUEST]{"name":"get_timeline","arguments":{"value":"actual"}}[END_TOOL_REQUEST]',
    'I will inspect it.\n<tool_call><function=get_timeline><parameter=value>actual</parameter></function></tool_call>',
  ]) {
    const deps = mock([{ content }, { content: 'The timeline was inspected.' }]), events = []
    assert.equal((await sendLocalWithTools(request(), { ...deps, onEvent: e => events.push(e) })).text, 'The timeline was inspected.')
    assert.deepEqual(deps.calls, [['get_timeline', { value: 'actual' }]])
    assert.deepEqual(events.filter(e => e.type === 'delta'), [{ type: 'delta', text: 'The timeline was inspected.' }])
    const assistant = deps.requests[1].body.messages.find(m => m.role === 'assistant')
    assert.equal(assistant.tool_calls.length, 1)
    assert.equal(assistant.tool_calls[0].id, deps.requests[1].body.messages.find(m => m.role === 'tool').tool_call_id)
  }
})

test('format repair continues only the unexecuted next step, without replaying earlier native actions', async () => {
  const deps = mock([{ tool_calls: [call('first')] }, { content: '<tool_call>' },
    { content: '<tool_call>{"name":"get_timeline","arguments":{"value":"fresh read"}}</tool_call>' }, { content: 'Inspected.' }])
  assert.equal((await sendLocalWithTools(request(), deps)).text, 'Inspected.')
  assert.deepEqual(deps.calls, [['get_timeline', {}], ['get_timeline', { value: 'fresh read' }]])
  assert.match(deps.requests[2].body.messages.at(-1).content, /NOT executed.*only that unexecuted next step/)
})

test('structured calls win over duplicate public markup and answer recovery never dispatches public calls', async () => {
  const content = '<tool_call>{"name":"get_timeline","arguments":{}}</tool_call>'
  const deps = mock([{ tool_calls: [call('structured')], content }, { content: 'Inspected.' }])
  await sendLocalWithTools(request(), deps)
  assert.deepEqual(deps.calls, [['get_timeline', {}]])
  const recovery = mock([{ tool_calls: [call('first')] }, { content: '' }, { content }])
  await assert.rejects(sendLocalWithTools(request(), recovery), { code: 'INVALID_RESPONSE' })
  assert.equal(recovery.calls.length, 1)
  assert.equal(recovery.requests.at(-1).body.messages.at(-1).role, 'user')
  assert.match(recovery.requests.at(-1).body.messages.at(-1).content, /Velorn answer recovery/)
})

test('tool denial and failures reach model without fabricated success or private exception text', async () => {
  let calls = 0
  const deps = mock([{ tool_calls: [call('a'), call('b')] }, { content: 'The change was denied; the other tool failed.' }], async () => { if (++calls === 2) throw new Error('secret'); return { isError: true, content: [{ type: 'text', text: 'Host denied this change.' }] } })
  await sendLocalWithTools(request(), deps)
  assert.match(JSON.stringify(deps.requests[1].body.messages), /Host denied/)
  assert.doesNotMatch(JSON.stringify(deps.requests[1].body.messages), /secret/)
  assert.ok(deps.requests[1].body.messages.filter(message => message.role === 'tool').every(message => parseModelTransport(message.content).result.isError))
})

test('tool images are attached only with explicit vision; complete tool group precedes image message', async () => {
  for (const vision of [false, true]) {
    const deps = mock([{ tool_calls: [call('a'), call('b')] }, { content: 'Summary.' }], async () => ({ content: [{ type: 'image', mimeType: 'image/png', data: 'YQ==' }] }))
    await sendLocalWithTools(request({ vision }), deps)
    const messages = deps.requests[1].body.messages
    const toolMessages = messages.filter(message => message.role === 'tool')
    assert.equal(toolMessages.length, 2)
    assert.ok(toolMessages.every(message => !message.content.includes('YQ==')))
    assert.equal(JSON.stringify(messages).includes('data:image/png;base64,YQ=='), vision)
    const toolHeader = JSON.parse(messages.find(message => message.role === 'tool').content.split('\n\n', 1)[0])
    assert.equal(toolHeader.attachedImageCount, vision ? 1 : 0)
    assert.equal(toolHeader.visualInspectionSupportedByThisResult, vision)
    if (vision) assert.equal(messages.at(-1).role, 'user')
  }
})

test('cancellation and timeout stop pending inference and prevent subsequent tool dispatch', async () => {
  for (const useTimeout of [false, true]) {
    const controller = new AbortController(); let started
    const deps = mock([{ tool_calls: [call('a'), call('b')] }], () => new Promise(resolve => { started = resolve }))
    const result = sendLocalWithTools(request(), { ...deps, signal: controller.signal, timeoutMs: useTimeout ? 20 : 2000 })
    while (!started) await new Promise(resolve => setImmediate(resolve))
    if (!useTimeout) controller.abort()
    const keepAlive = setTimeout(() => {}, 100)
    await assert.rejects(result, { code: 'CANCELLED' }); clearTimeout(keepAlive)
    started({ content: [] })
    assert.equal(deps.calls.length, 1)
  }
})

test('more than twelve tool predictions and forty-eight calls complete without a forced summary', async () => {
  const replies = Array.from({ length: 17 }, (_, i) => ({ tool_calls:
    Array.from({ length: 3 }, (_, j) => call(`call_${i}_${j}`)) })).concat({ content: 'All requested inspections completed.' })
  const deps = mock(replies)
  assert.equal((await sendLocalWithTools(request(), deps)).text, 'All requested inspections completed.')
  assert.equal(deps.calls.length, 51)
  assert.equal(deps.requests.length, 18)
  for (const { body } of deps.requests) {
    assert.equal(body.tool_choice, 'auto')
    assert.ok(body.tools.some(tool => tool.function.name === 'get_timeline'))
    assert.doesNotMatch(body.messages[0].content, /tool budget is exhausted/)
  }
})

test('user cancellation still stops a continuing conversation beyond the old round limit', async () => {
  const controller = new AbortController()
  const deps = mock([])
  deps.fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body); deps.requests.push({ body })
    const round = deps.requests.length
    if (round === 16) controller.abort('user stopped')
    return reply({ tool_calls: [call(`call_${round}`)] })
  }
  await assert.rejects(sendLocalWithTools(request(), { ...deps, signal: controller.signal }), { code: 'CANCELLED' })
  assert.equal(deps.requests.length, 16)
  assert.equal(deps.calls.length, 15)
})

test('invalid endpoints, duplicate IDs, oversized replies, and nonobject call arguments fail safely', async () => {
  const deps = mock([{ tool_calls: [call('a'), call('a')] }])
  await assert.rejects(sendLocalWithTools(request({ endpoint: 'http://remote:1234/v1' }), deps), { code: 'INVALID_ENDPOINT' })
  await assert.rejects(sendLocalWithTools(request(), deps), { code: 'INVALID_RESPONSE' })
  assert.equal(deps.calls.length, 0)
  const huge = mock([{ content: 'x'.repeat(LIMITS.responseBytes) }])
  await assert.rejects(sendLocalWithTools(request(), huge), { code: 'RESPONSE_TOO_LARGE' })
})

test('active timeout preserves its remaining budget across repeated waits and ignores late resumes', () => {
  let time = 0; let expired = 0; let next = 0
  const scheduled = new Map()
  const timer = createPausableTimeout(() => expired++, 100, {
    now: () => time,
    setTimer: (callback, delay) => { const id = ++next; scheduled.set(id, { callback, at: time + delay }); return id },
    clearTimer: id => scheduled.delete(id),
  })
  time = 30; timer.setWaiting(true); timer.setWaiting(true)
  assert.equal(scheduled.size, 0)
  time = 500; timer.setWaiting(false); timer.setWaiting(false)
  assert.equal(scheduled.size, 1)
  assert.equal([...scheduled.values()][0].at, 570)
  time = 520; timer.setWaiting(true)
  time = 900; timer.setWaiting(false)
  assert.equal([...scheduled.values()][0].at, 950)
  timer.dispose(); timer.setWaiting(true); timer.setWaiting(false)
  assert.equal(scheduled.size, 0)
  assert.equal(expired, 0)
})

test('GPU coordinator owns every full prediction body but never a tool call', async () => {
  let leased = false; let predictions = 0; let toolCalls = 0
  const requests = []
  const messages = [{ tool_calls: [call('a')] }, { content: 'Confirmed result.' }]
  const localGpuCoordinator = { withInference: async (options, operation) => {
    assert.equal(options.model, 'local-model')
    assert.equal(options.endpoint, 'http://127.0.0.1:1234/v1')
    assert.equal(leased, false); leased = true; predictions++
    try { return await operation() } finally { leased = false }
  } }
  const result = await sendLocalWithTools(request(), {
    localGpuCoordinator,
    fetchImpl: async (_url, options) => {
      assert.equal(leased, true); requests.push(JSON.parse(options.body))
      const message = messages.shift()
      return { ok: true, body: (async function * () {
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(leased, true, 'Response consumption remains inside the reservation')
        yield Buffer.from(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }))
      })() }
    },
    toolSession: { listTools: async () => catalog, callTool: async () => {
      assert.equal(leased, false, 'A tool may itself queue generation without deadlocking inference')
      toolCalls++; return { content: [{ type: 'text', text: 'Observed edit' }] }
    } },
  })
  assert.equal(result.text, 'Confirmed result.')
  assert.equal(predictions, 2); assert.equal(toolCalls, 1); assert.equal(leased, false)
  assert.match(JSON.stringify(requests[1].messages), /Observed edit/)
})

test('GPU waiting pauses the local tool-turn timeout and resumes the same conversation', async () => {
  const waiting = []; let rounds = 0
  const deps = mock([{ tool_calls: [call('a')] }, { content: 'Done after waiting.' }])
  const localGpuCoordinator = { withInference: async ({ onWaiting }, operation) => {
    onWaiting(true); rounds++
    await new Promise(resolve => setTimeout(resolve, 45))
    onWaiting(false)
    return operation()
  } }
  const result = await sendLocalWithTools(request(), { ...deps, timeoutMs: 25, localGpuCoordinator, onWaiting: value => waiting.push(value) })
  assert.equal(result.success, true); assert.equal(rounds, 2)
  assert.equal(waiting.filter(Boolean).length, 2)
  assert.equal(deps.calls.length, 1)
})

test('cancelled GPU waits cannot start a late model request or dispatch tools', async () => {
  const controller = new AbortController(); let run; let waiting = false
  const deps = mock([{ tool_calls: [call('a')] }])
  const localGpuCoordinator = { withInference: ({ onWaiting }, operation) => {
    run = operation; onWaiting(true); return new Promise(() => {})
  } }
  const pending = sendLocalWithTools(request(), { ...deps, signal: controller.signal, localGpuCoordinator, onWaiting: value => { waiting = value } })
  while (!run) await new Promise(resolve => setImmediate(resolve))
  assert.equal(waiting, true)
  controller.abort('cancelled')
  await assert.rejects(pending, { code: 'CANCELLED' })
  await assert.rejects(run(), { code: 'CANCELLED' })
  assert.equal(waiting, false); assert.equal(deps.requests.length, 0); assert.equal(deps.calls.length, 0)
})

test('cancellation leaves an abort-ignoring inference lease held until its body settles', async () => {
  const controller = new AbortController(); let releaseBody; let reading; let leased = false
  const ready = new Promise(resolve => { reading = resolve })
  const localGpuCoordinator = { withInference: async (_options, operation) => {
    leased = true
    try { return await operation() } finally { leased = false }
  } }
  const deps = mock([])
  const pending = sendLocalWithTools(request(), { ...deps, signal: controller.signal, localGpuCoordinator,
    fetchImpl: async () => ({ ok: true, body: (async function * () {
      await new Promise(resolve => { releaseBody = resolve; reading() })
      yield Buffer.from(JSON.stringify({ choices: [{ message: { tool_calls: [call('a')] }, finish_reason: 'tool_calls' }] }))
    })() }),
  })
  await ready; controller.abort()
  await assert.rejects(pending, { code: 'CANCELLED' })
  assert.equal(leased, true)
  releaseBody(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(leased, false); assert.equal(deps.calls.length, 0)
})

test('coordinator shutdown signal reaches the local inference transport', async () => {
  const shutdown = new AbortController(); let suppliedSignal
  const deps = mock([])
  const result = await sendLocalWithTools(request(), { ...deps,
    localGpuCoordinator: { withInference: ({ signal }, operation) => {
      suppliedSignal = AbortSignal.any([signal, shutdown.signal])
      return operation({ signal: suppliedSignal })
    } },
    fetchImpl: async (_url, { signal }) => {
      assert.equal(signal, suppliedSignal)
      return reply({ content: 'Transport wired.' })
    },
  })
  assert.equal(result.text, 'Transport wired.')
})

test('each tool prediction uses the verified restored model instance without changing the requested model', async () => {
  const deps = mock([{ tool_calls: [call('a')] }, { content: 'Restored conversation.' }])
  let rounds = 0
  const original = request()
  await sendLocalWithTools(original, { ...deps, localGpuCoordinator: { withInference: ({ model }, operation) => {
    assert.equal(model, 'local-model')
    return operation({ model: `verified-instance-${++rounds}` })
  } } })
  assert.deepEqual(deps.requests.map(entry => entry.body.model), ['verified-instance-1', 'verified-instance-2'])
  assert.equal(original.model, 'local-model')
  assert.match(JSON.stringify(deps.requests[1].body.messages), /Observed result/)
})

test('tool predictions honor only whitelisted native reasoning overrides', async () => {
  for (const reasoningEffort of ['none', 'low', 'on', 'off', 'high', true, undefined, { value: 'none' }]) {
    const deps = mock([{ tool_calls: [call('a')] }, { content: 'Observed result.' }])
    await sendLocalWithTools(request({ reasoningEffort: 'none' }), { ...deps, localGpuCoordinator: {
      withInference: (_options, operation) => operation({ reasoningEffort }),
    } })
    for (const { body } of deps.requests) {
      assert.equal(body.reasoning_effort, ['none', 'low'].includes(reasoningEffort) ? reasoningEffort : undefined)
      assert.equal(Object.hasOwn(body, 'reasoning_effort'), ['none', 'low'].includes(reasoningEffort))
    }
  }
  const unchanged = mock([{ content: 'Default model configuration.' }])
  await sendLocalWithTools(request({ reasoningEffort: 'none' }), unchanged)
  assert.equal(Object.hasOwn(unchanged.requests[0].body, 'reasoning_effort'), false)
})
