'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createResearchAccess, TOOL_NAMES, TOOLS, RESEARCH_INSTRUCTIONS, ownerFromGuard } = require('../electron/connectedAgentResearch.cjs')
const { registerConnectedAgentIpc, CHANNELS, validateSend } = require('../electron/connectedAgent.cjs')
const { createAgentToolSession } = require('../electron/connectedAgentTools.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { tools: generationRunTools } = require('../electron/mcpGenerationRunTools.cjs')
const { parseModelTransport } = require('./helpers/localAgentTransport.cjs')
const clone = value => structuredClone(value)
const parsed = result => JSON.parse(result.content[0].text)
const context = () => ({ session: 'research-renderer', projectKey: 'test-project', timelineId: 'timeline1', timelineSessionId: 1, compoundClipId: null, revision: 1 })
const guard = () => ({ context: context(), selection: { clipIds: [] }, playhead: 0 })
const args = () => ({ url: 'https://huggingface.co/example/model/resolve/main/model.gguf', filename: 'model.gguf', targetSubdir: 'checkpoints', maxBytes: 1024 })
const payload = extra => ({ requestId: 'research-1', provider: 'codex', model: 'synthetic', messages: [{ role: 'user', content: 'Inspect this public workflow.' }], context: {}, toolsEnabled: true, expectedContext: context(), ...extra })
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const generationRunToolNames = Object.freeze(generationRunTools.map(tool => tool.name))
function assertLiveGenerationRunCatalog(catalog) {
  const names = new Set(catalog.map(tool => tool.name || tool.function?.name))
  for (const name of generationRunToolNames) assert.ok(names.has(name), `Missing live ComfyUI Runs tool: ${name}`)
}
async function until(predicate) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)) }
  assert.fail('Expected synthetic event did not arrive')
}
function accessFixture(overrides = {}) {
  const calls = []
  const record = (name, output) => async (input, options) => { calls.push({ name, input, options }); return clone(output) }
  const reader = { search: record('search', { untrusted: true, results: [] }), read: record('read', { untrusted: true, text: 'Public documentation.' }) }
  const downloads = { preview: record('preview', { previewOnly: true, previewToken: 'exact-preview', destination: '/synthetic/ComfyUI/models/checkpoints/model.gguf' }),
    start: record('start', { jobId: 'job1', state: 'queued' }), status: record('status', { jobs: [] }), cancel: record('cancel', { jobId: 'job1', state: 'cancelled' }),
    dispose: record('dispose', null) }
  return { calls, access: createResearchAccess({ reader, downloads, ...overrides }) }
}
function nativeFixture({ provider = 'codex', action, researchEnabled = true, ...overrides } = {}) {
  const handlers = new Map(), events = [], externalCalls = [], catalogues = [], requests = []
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: (_name, value) => events.push(value) })
  const window = { webContents: contents, isDestroyed: () => false }
  const app = new EventEmitter(), server = createComfyStudioMcpServer(), current = guard(), af = accessFixture()
  let made = 0, fetchCount = 0
  const ipc = registerConnectedAgentIpc({ ipcMain: { handle: (name, callback) => handlers.set(name, callback), removeHandler: name => handlers.delete(name) }, app,
    getMainWindow: () => window, getMcpServer: () => server, getToolContext: async () => clone(current),
    executeTool: async (name, input) => { externalCalls.push({ name, input }); return result({ success: true }) },
    makeResearchAccess: () => { made++; return af.access },
    codex: { send: async (_request, { toolSession, instructions }) => {
      catalogues.push(await toolSession.listTools())
      return action ? action(toolSession, instructions) : { success: true, text: 'Read complete.' }
    } },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); catalogues.push(body.tools); requests.push(body)
      assert.match(body.messages[0].content, researchEnabled ? /Research & setup is enabled/ : /whole editor/)
      const toolCall = (id, name, input) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(input) } })
      const rounds = [
        [toolCall('discover-research', 'discover_velorn_tools', { names: Object.values(TOOL_NAMES).slice(0, 4) })],
        [toolCall('local-search-call', TOOL_NAMES.search, { query: 'public workflow', source: 'github', limit: 2 }),
          toolCall('local-read-call', TOOL_NAMES.read, { url: 'https://huggingface.co/docs' })],
        [toolCall('discover-remaining-research', 'discover_velorn_tools', { names: Object.values(TOOL_NAMES).slice(4) })],
      ]
      const toolCalls = rounds[fetchCount++]
      const message = toolCalls ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content: 'Read complete.' }
      return new Response(JSON.stringify({ choices: [{ finish_reason: toolCalls ? 'tool_calls' : 'stop', message }] }), { headers: { 'Content-Type': 'application/json' } })
    }, ...overrides })
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const call = (key, input) => handlers.get(CHANNELS[key])(event, input)
  return { ...af, server, current, events, contents, app, ipc, externalCalls, catalogues, requests, made: () => made,
    send: extra => call('send', payload({ provider, researchEnabled, ...extra })), call }
}

test('research consent is explicit, boolean, and cannot exist without editor tools', () => {
  assert.equal(validateSend(payload()).researchEnabled, false)
  assert.equal(validateSend(payload({ researchEnabled: true })).researchEnabled, true)
  for (const value of ['true', 1, {}, null]) assert.throws(() => validateSend(payload({ researchEnabled: value })))
  assert.throws(() => validateSend(payload({ researchEnabled: true, toolsEnabled: false })), /requires Velorn tools/)
})

test('private catalog extends but never mutates or registers tools on the external MCP server', () => {
  const f = accessFixture(), server = createComfyStudioMcpServer()
  const names = server.tools.map(tool => tool.name)
  assertLiveGenerationRunCatalog(server.tools)
  assert.equal(f.access.catalog(server).tools.length, names.length + TOOLS.length)
  assert.deepEqual(server.tools.map(tool => tool.name), names)
  assert.throws(() => f.access.catalog({ tools: [TOOLS[0]] }), /conflicts/)
  assert.throws(() => ownerFromGuard({ context: { session: 'forged' } }), /open project/)
})

test('ordinary tool mode neither creates research service nor advertises research functions', async t => {
  const f = nativeFixture({ researchEnabled: false, action: async (session, instructions) => {
    assert.doesNotMatch(instructions, /Research & setup is enabled/)
    assert.equal((await session.callTool(TOOL_NAMES.read, { url: 'https://example.com' })).isError, true)
    return { success: true, text: 'Only ordinary tools.' }
  } })
  t.after(() => f.ipc.dispose())
  assert.equal((await f.send()).success, true)
  assert.equal(f.made(), 0)
  assertLiveGenerationRunCatalog(f.catalogues[0])
  assert.equal(f.catalogues[0].length, f.server.tools.length)
  assert.equal(f.calls.length, 0)
  assert.equal(f.externalCalls.length, 0)
})

test('Codex and LM Studio expose the same research functions, with optional local documentation lookup', async t => {
  for (const provider of ['codex', 'lmstudio']) {
    const f = nativeFixture({ provider, action: async (session, instructions) => {
      assert.ok(instructions.includes(RESEARCH_INSTRUCTIONS))
      assert.equal(parsed(await session.callTool(TOOL_NAMES.search, { query: 'public workflow', source: 'github', limit: 2 })).untrusted, true)
      assert.equal(parsed(await session.callTool(TOOL_NAMES.read, { url: 'https://huggingface.co/docs' })).untrusted, true)
      return { success: true, text: 'Read complete.' }
    } })
    t.after(() => f.ipc.dispose())
    assert.equal((await f.send()).success, true)
    const names = f.catalogues.flat().flatMap(tool => [tool.name || tool.function.name,
      ...(tool.function?.name === 'call_velorn_tool' ? tool.function.parameters.properties.name.enum : [])])
    for (const name of Object.values(TOOL_NAMES)) assert.ok(names.includes(name), `${provider}: ${name}`)
    if (provider === 'lmstudio') {
      assert.equal(f.requests.length, 4)
      const initialNames = f.catalogues[0].map(tool => tool.function.name)
      for (const name of Object.values(TOOL_NAMES)) {
        assert.equal(initialNames.includes(name), false, 'Research calls use the immediately available router')
        assert.ok(f.requests[0].messages[0].content.includes(name), `Capability index retains ${name}`)
      }
      assert.ok(initialNames.includes('call_velorn_tool'))
      assert.ok(initialNames.includes('discover_velorn_tools'))
      const discovery = parseModelTransport(f.requests[1].messages.find(message => message.role === 'tool').content)
      for (const original of TOOLS) {
        const documented = discovery.tools.find(tool => tool.name === original.name)
        if (documented) assert.deepEqual(documented, original)
      }
      assert.equal(discovery.available, true)
      assert.deepEqual(discovery.activated, [])
      assert.equal(discovery.schemasChanged, true)
      assert.equal(discovery.requiresDiscovery, false)
      assert.deepEqual(discovery.tools.map(tool => tool.name), Object.values(TOOL_NAMES).slice(0, 4))
      const observations = f.requests[2].messages.filter(message => ['local-search-call', 'local-read-call'].includes(message.tool_call_id))
      assert.equal(observations.length, 2)
      for (const message of observations) {
        const wrapper = parseModelTransport(message.content)
        assert.equal(wrapper.kind, 'local-tool-result-complete')
        assert.equal(wrapper.complete, true)
        assert.equal(wrapper.pagingAvailable, false)
        assert.equal(parsed(wrapper.result).untrusted, true)
      }
      assert.ok(f.requests.every(body => body.tool_choice === 'auto' && body.parallel_tool_calls === false))
    }
    assert.deepEqual(f.calls.map(call => call.name), ['search', 'read'])
    assert.deepEqual(f.calls[0].input, { query: 'public workflow', source: 'github', limit: 2 })
    assert.equal(f.calls.filter(call => call.name === 'read').length, 1)
    assert.equal(f.externalCalls.length, 0)
    assert.equal(f.events.filter(event => event.type === 'approval').length, 0)
  }
})

test('download apply previews first, waits for exact host approval, then dispatches the bound token once', async t => {
  let toolResult
  const f = nativeFixture({ action: async session => {
    toolResult = await session.callTool(TOOL_NAMES.download, { ...args(), previewOnly: false })
    return { success: true, text: 'Reviewed the download.' }
  } })
  t.after(() => f.ipc.dispose())
  const running = f.send()
  await until(() => f.events.some(event => event.type === 'approval'))
  assert.deepEqual(f.calls.map(call => call.name), ['preview'])
  const approval = f.events.find(event => event.type === 'approval')
  assert.equal(approval.arguments.previewToken, 'exact-preview')
  assert.ok(approval.warnings.some(warning => /not undone/.test(warning)))
  assert.equal((await f.call('approveTool', { requestId: approval.requestId, approvalId: approval.approvalId, approved: true })).success, true)
  assert.equal((await running).success, true)
  assert.equal(parsed(toolResult).jobId, 'job1')
  assert.deepEqual(f.calls.map(call => call.name), ['preview', 'start'])
  assert.equal(f.calls[1].input.previewToken, 'exact-preview')
  assert.equal(f.calls[1].options.owner, ownerFromGuard(guard()))
  assert.equal(f.externalCalls.length, 0)
})

test('denial, Stop, and changed project prevent an approved-looking model download from starting', async t => {
  for (const mode of ['deny', 'stop', 'project']) {
    const f = nativeFixture({ action: async session => {
      await session.callTool(TOOL_NAMES.download, { ...args(), previewOnly: false, approved: true })
      return { success: true, text: 'No completed download claimed.' }
    } })
    t.after(() => f.ipc.dispose())
    const running = f.send()
    await until(() => f.events.some(event => event.type === 'approval'))
    const approval = f.events.find(event => event.type === 'approval')
    if (mode === 'stop') await f.call('cancel', { requestId: approval.requestId })
    else {
      if (mode === 'project') f.current.context.projectKey = 'another-project'
      await f.call('approveTool', { requestId: approval.requestId, approvalId: approval.approvalId, approved: mode !== 'deny' })
    }
    await running
    assert.equal(f.calls.some(call => call.name === 'start'), false, mode)
  }
})

test('native availability/export guard rejects before research side effects, and abort is rechecked', async () => {
  const abort = new AbortController()
  const f = accessFixture({ assertAvailable: async () => { throw new Error('Export has priority') } })
  await assert.rejects(f.access.execute(TOOL_NAMES.download, args(), guard(), abort.signal), /Export has priority/)
  assert.equal(f.calls.length, 0)
  const late = accessFixture({ assertAvailable: async () => abort.abort() })
  await assert.rejects(late.access.execute(TOOL_NAMES.read, { url: 'https://example.com' }, guard(), abort.signal), /cancelled/)
  assert.equal(late.calls.length, 0)
})

test('renderer navigation and app shutdown dispose research jobs, never granting authority to a replacement window', async () => {
  for (const mode of ['navigation', 'renderer-gone', 'shutdown']) {
    const f = nativeFixture()
    assert.equal((await f.send()).success, true)
    assert.equal(f.calls.some(call => call.name === 'dispose'), false)
    if (mode === 'navigation') f.contents.emit('did-start-navigation', {}, 'app', false, true)
    else if (mode === 'renderer-gone') f.contents.emit('render-process-gone')
    else f.app.emit('will-quit')
    await until(() => f.calls.some(call => call.name === 'dispose'))
    f.ipc.dispose()
  }
})

test('download status is a read; cancellation requires approval and never routes through external MCP', async () => {
  const f = accessFixture(), server = createComfyStudioMcpServer(), current = guard(), approvals = []
  const session = await createAgentToolSession({ getServer: () => f.access.catalog(server), getContext: async () => clone(current), expectedContext: context(),
    executeTool: (name, input, actual) => f.access.execute(name, input, actual), requestApproval: async value => { approvals.push(value); return true } })
  assert.deepEqual(parsed(await session.callTool(TOOL_NAMES.status, {})), { jobs: [] })
  assert.equal(approvals.length, 0)
  assert.equal(parsed(await session.callTool(TOOL_NAMES.cancel, { jobId: 'job1' })).state, 'cancelled')
  assert.equal(approvals.length, 1)
})

test('the exact suggested apply payload can be submitted through the host re-preview path', async () => {
  const f = accessFixture(), server = createComfyStudioMcpServer(), approvals = []
  const session = await createAgentToolSession({ getServer: () => f.access.catalog(server), getContext: async () => guard(), expectedContext: context(),
    executeTool: (name, input, actual) => f.access.execute(name, input, actual), requestApproval: async value => { approvals.push(value); return true } })
  const preview = parsed(await session.callTool(TOOL_NAMES.download, args()))
  assert.equal(approvals.length, 0)
  assert.deepEqual(preview.suggestedApplyPayload, { ...args(), previewToken: 'exact-preview', previewOnly: false })
  assert.equal(parsed(await session.callTool(TOOL_NAMES.download, preview.suggestedApplyPayload)).jobId, 'job1')
  assert.deepEqual(f.calls.map(call => call.name), ['preview', 'preview', 'start'])
  assert.equal(approvals.length, 1)
})
