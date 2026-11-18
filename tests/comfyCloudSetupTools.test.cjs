'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const { performance } = require('node:perf_hooks')
const catalog = require('../electron/comfyCloudSetup.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { createAgentToolSession } = require('../electron/connectedAgentTools.cjs')
const { registerConnectedAgentIpc, CHANNELS } = require('../electron/connectedAgent.cjs')
const { createMcpGateway } = require('../electron/connectedAgentMcpGateway.cjs')
const context = { schemaVersion: 1, session: 'synthetic', projectKey: '/synthetic/project', timelineId: 'timeline', timelineSessionId: 1, compoundClipId: null, storyboardRevision: 0, revision: 2 }
const guard = { context, selection: {}, playhead: 0 }
const result = { success: true, configured: true, validation: 'valid', status: 'verified', outcome: 'saved' }
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

test('fixed zero-argument catalog and dispatch have no secret-bearing API and no project prerequisite', async () => {
  const calls = []
  const server = createComfyStudioMcpServer({ comfyCloudSetup: { request: async args => { calls.push(args); return result }, status: async args => { calls.push(args); return { ...result, outcome: undefined } } } })
  assert.equal(server.lastSnapshot, null)
  for (const tool of catalog.tools) {
    assert.deepEqual(tool.inputSchema, { type: 'object', properties: {}, additionalProperties: false })
    assert.equal(tool.annotations.readOnlyHint, tool.name === catalog.STATUS_TOOL)
    assert.ok(server.tools.some(item => item.name === tool.name))
    assert.equal((await server.callTool(tool.name, {})).isError, undefined)
    for (const args of [{ key: 'synthetic-secret' }, { validation: 'valid' }, { url: 'https://example.test' }, { requestId: 'fake' }]) {
      const rejected = await server.callTool(tool.name, args)
      assert.equal(rejected.isError, true); assert.doesNotMatch(JSON.stringify(rejected), /synthetic-secret|example.test/)
    }
  }
  assert.equal(calls.length, 2)
  const initialized = await server.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.match(initialized.result.instructions, /request_comfy_cloud_setup/)
  assert.match(catalog.guidance, /Paid generation still needs existing approval/)
})

test('request remains effectful under review policy; status is repeatable read; Full access does not submit credentials', async () => {
  for (const trustedFullAccess of [false, true]) {
    const calls = [], approvals = []
    const server = createComfyStudioMcpServer({ comfyCloudSetup: { request: async () => result, status: async () => result } })
    const session = await createAgentToolSession({ getServer: () => server, trustedFullAccess, expectedContext: context,
      getContext: async () => guard, signal: new AbortController().signal,
      requestApproval: async value => { approvals.push(value); return true },
      executeTool: async (name, args) => { calls.push({ name, args }); return server.callTool(name, args) },
    })
    for (const name of [catalog.STATUS_TOOL, catalog.STATUS_TOOL, catalog.REQUEST_TOOL]) assert.equal((await session.callTool(name, {})).isError, undefined)
    assert.equal(approvals.length, trustedFullAccess ? 0 : 1)
    assert.ok(calls.every(call => Object.keys(call.args).length === 0))
  }
})

test('export allows status but blocks showing the dialog, and unavailable native service fails closed', async () => {
  const calls = []
  const server = createComfyStudioMcpServer({ isExportBusy: () => true,
    comfyCloudSetup: { request: async () => { calls.push('request'); return result }, status: async () => { calls.push('status'); return result } } })
  assert.equal((await server.callTool(catalog.REQUEST_TOOL, {})).isError, true)
  assert.equal((await server.callTool(catalog.STATUS_TOOL, {})).isError, undefined)
  assert.deepEqual(calls, ['status'])
  for (const name of catalog.names) assert.equal((await createComfyStudioMcpServer().callTool(name, {})).isError, true)
})

test('only credential handoff pauses the operation budget, resumes afterwards and Stop remains effective', async () => {
  for (const trustedFullAccess of [false, true]) {
    const waits = [], controller = new AbortController()
    const server = createComfyStudioMcpServer()
    const session = await createAgentToolSession({ getServer: () => server, trustedFullAccess, getContext: async () => guard,
      signal: controller.signal, requestApproval: async () => true, limits: { operationTimeoutMs: 30 },
      executeTool: async (name, _args, _guard, controls) => {
        if (name === catalog.REQUEST_TOOL) { assert.equal(typeof controls.onWaiting, 'function'); controls.onWaiting(true); await delay(80); controls.onWaiting(false); return text(result) }
        assert.equal(controls, undefined); await delay(80); return text(result)
      },
    })
    const unsubscribe = session.subscribeUserWaiting(value => waits.push(value))
    assert.equal((await session.callTool(catalog.REQUEST_TOOL, {})).isError, undefined)
    assert.ok(waits.includes(true)); assert.equal(waits.at(-1), false)
    assert.equal((await session.callTool(catalog.STATUS_TOOL, {})).isError, true, 'ordinary calls retain their active execution deadline')
    unsubscribe()
  }
  const controller = new AbortController(), server = createComfyStudioMcpServer()
  let waiting = false
  const session = await createAgentToolSession({ getServer: () => server, trustedFullAccess: true, getContext: async () => guard,
    signal: controller.signal, requestApproval: async () => true,
    executeTool: async (_name, _args, _guard, controls) => { controls.onWaiting(true); waiting = true; await delay(80); return text(result) },
  })
  const pending = session.callTool(catalog.REQUEST_TOOL, {})
  const waitDeadline = performance.now() + 5000
  while (!waiting) { assert.ok(performance.now() < waitDeadline, 'Host did not enter user wait'); await delay(1) }
  controller.abort()
  assert.equal((await pending).isError, true)
})

test('real connected-agent local orchestration pauses both active timers only for the native user wait', async () => {
  const handlers = new Map(), events = [], contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: (...args) => events.push(args) })
  const window = { webContents: contents, isDestroyed: () => false }, event = { sender: contents, senderFrame: contents.mainFrame }
  const server = createComfyStudioMcpServer()
  let predictions = 0, executed = 0
  const agent = registerConnectedAgentIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    getMainWindow: () => window, app: new EventEmitter(), timeoutMs: 70, toolTimeoutMs: 70,
    getMcpServer: () => server, getToolContext: async () => guard,
    executeTool: async (name, args, _guard, signal, origin) => {
      assert.equal(name, catalog.REQUEST_TOOL); assert.deepEqual(args, {}); executed++
      origin.onWaiting(true); await delay(160); assert.equal(signal.aborted, false); origin.onWaiting(false)
      return text(result)
    },
    makeToolSession: options => createAgentToolSession({ ...options, limits: { operationTimeoutMs: 70 } }),
    fetchImpl: async () => {
      predictions++
      const message = predictions === 1 ? { tool_calls: [{ id: 'setup', type: 'function', function: { name: 'call_velorn_tool', arguments: JSON.stringify({ name: catalog.REQUEST_TOOL, arguments: {} }) } }] } : { content: 'Cloud key verified; paid generation still needs approval.' }
      return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'Content-Type': 'application/json' } })
    },
  })
  try {
    const send = { requestId: 'cloud-setup-turn', conversationId: 'cloud-setup-chat', provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234/v1', model: 'fixture',
      messages: [{ role: 'user', content: 'Help set up cloud generation.' }], context: {}, toolsEnabled: true, expectedContext: context }
    const pending = handlers.get(CHANNELS.send)(event, send)
    const stop = Date.now() + 1000
    let card
    while (!(card = events.find(([, value]) => value.type === 'approval')) && Date.now() < stop) await delay(1)
    assert.ok(card, JSON.stringify(events))
    await handlers.get(CHANNELS.approveTool)(event, { requestId: send.requestId, approvalId: card[1].approvalId, approved: true })
    const completed = await pending
    assert.equal(completed.success, true, JSON.stringify(completed)); assert.equal(predictions, 2); assert.equal(executed, 1)
  } finally { agent.dispose() }
})

test('Codex gateway active budget pauses during user entry and unsubscribes on close', async () => {
  const listeners = new Set()
  const toolSession = { listTools: async () => catalog.tools, callTool: async () => text(result),
    subscribeUserWaiting: listener => { listeners.add(listener); listener(true); return () => listeners.delete(listener) } }
  const gateway = await createMcpGateway({ toolSession, timeoutMs: 40 })
  try {
    await delay(90)
    const response = await fetch(gateway.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gateway.bearerToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    assert.equal(response.status, 200)
    for (const listener of listeners) listener(false)
    await delay(70)
    assert.equal(listeners.size, 0)
    await assert.rejects(fetch(gateway.url))
  } finally { await gateway.close() }
})

test('native wiring guards queued settings and final atomic commit; credentials never enter tool arguments', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  assert.match(source, /writeKey: \(key, \{ assertCurrent, expectedDigest, onCommitted \}\) => writeSettingsRaw/)
  assert.match(source, /cloudKeyFingerprint\(settings\.comfyApiKeyComfyOrg\) !== expectedDigest/)
  assert.match(source, /beforeCommit\(\)\s+fsSync\.renameSync\(tempPath, filePath\)\s+onCommitted\?\.\(\)/)
  assert.match(source, /comfyCloudSetup: comfyCloudSetup\.api/)
  assert.match(source, /comfyCloudSetup\?\.exportChanged\(\)/)
  const provider = fs.readFileSync(path.join(__dirname, '../electron/connectedAgent.cjs'), 'utf8')
  assert.match(provider, /\['request_comfy_cloud_setup', 'download_lmstudio_model', 'load_lmstudio_model', 'generate_comfy_router_image', 'generate_create_media'\]\.includes\(name\) \? \{ onWaiting:/)
  assert.match(provider, /require\('\.\/comfyCloudSetup\.cjs'\)\.guidance/)
})
