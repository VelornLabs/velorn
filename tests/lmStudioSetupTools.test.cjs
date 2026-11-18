'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const catalog = require('../electron/lmStudioSetupTools.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { createAgentToolSession } = require('../electron/connectedAgentTools.cjs')
const detail = result => JSON.parse(result.content[0].text)
const context = { schemaVersion: 1, session: 'synthetic', projectKey: '/synthetic/project', timelineId: 'timeline', timelineSessionId: 1, compoundClipId: null, storyboardRevision: 0, revision: 2 }
const guard = { context, selection: {}, playhead: 0 }
const args = name => name === 'plan_lmstudio_model_setup' ? { repository: 'synthetic/model-GGUF', filename: 'synthetic-model-Q4_K_M.gguf' }
  : name === 'download_lmstudio_model' ? { planId: 'host-owned-plan' } : { jobId: 'host-owned-job' }
const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
function fixture(options = {}) {
  const calls = [], nativeApprovalCalls = []
  const api = Object.fromEntries(Object.values(catalog.methods).map(method => [method, async payload => {
    calls.push({ method, payload })
    if (['download', 'load'].includes(method)) nativeApprovalCalls.push(method)
    if (options.throws) throw Error('synthetic-private-error /private/model-path synthetic-secret')
    if (options.failure) return { success: false, code: options.failure, error: 'The native setup request did not complete.' }
    return { success: true, method, ...(method === 'plan' ? { planId: 'host-owned-plan' }
      : { jobId: 'host-owned-job', state: method === 'load' ? 'loading' : 'downloading' }) }
  }]))
  return { calls, nativeApprovalCalls, server: createComfyStudioMcpServer({ lmStudioSetup: api, isExportBusy: () => options.busy === true }) }
}

test('shared five-tool catalog has exact source/opaque ID schemas, no credentials or authority controls', () => {
  assert.equal(catalog.tools.length, 5)
  assert.deepEqual([...catalog.names], ['plan_lmstudio_model_setup', 'download_lmstudio_model', 'get_lmstudio_model_download', 'cancel_lmstudio_model_download', 'load_lmstudio_model'])
  assert.deepEqual([...catalog.readNames], ['plan_lmstudio_model_setup', 'get_lmstudio_model_download'])
  assert.deepEqual(Object.values(catalog.methods), ['plan', 'download', 'status', 'cancel', 'load'])
  for (const tool of catalog.tools) {
    const schema = tool.inputSchema, fields = Object.keys(schema.properties)
    assert.equal(schema.type, 'object'); assert.equal(schema.additionalProperties, false)
    assert.deepEqual(schema.required, fields)
    assert.deepEqual(fields, tool.name === 'plan_lmstudio_model_setup' ? ['repository', 'filename'] : tool.name === 'download_lmstudio_model' ? ['planId'] : ['jobId'])
    for (const field of Object.values(schema.properties)) {
      assert.equal(field.type, 'string'); assert.ok(field.minLength > 0); assert.ok(field.maxLength <= 180)
    }
    for (const forbidden of ['url', 'path', 'endpoint', 'owner', 'approved', 'token', 'apiKey', 'headers', 'command', 'fullAccess', 'previewOnly']) assert.ok(!Object.hasOwn(schema.properties, forbidden))
    assert.equal(tool.annotations.readOnlyHint, catalog.readNames.has(tool.name))
    assert.equal(tool.annotations.idempotentHint, catalog.readNames.has(tool.name))
    assert.equal(tool.annotations.openWorldHint, ['plan_lmstudio_model_setup', 'download_lmstudio_model'].includes(tool.name))
  }
})

test('security guidance distinguishes application install, model download, native load, and untested inference', () => {
  for (const pattern of [/exact public Hugging Face repository and single-file GGUF filename/, /pinned source, license, size, destination/,
    /Native desktop confirmation is mandatory even under Full access/, /live desktop chat progress and Cancel after the agent reply/,
    /do not hold the agent turn open to poll or start duplicate transfers/, /Downloaded does not mean loaded/,
    /load_lmstudio_model only when requested/, /Keep the current Codex agent\/model\/chat until the user explicitly switches/,
    /Never use ComfyUI download_agent_model for LM Studio/, /bypass a failed\/unsupported plan with shell downloads/,
    /disable authentication/, /expose a server beyond loopback/, /claim model\/tool compatibility without a separate user-authorized test/,
    /not MLX\/sharded\/gated models/, /plan_tool_setup for its application installer/, /setup remain optional/]) assert.match(catalog.guidance, pattern)
  const load = catalog.tools.find(tool => tool.name === 'load_lmstudio_model').description
  assert.match(load, /separately approved/); assert.match(load, /loopback-only server on port 1234/)
  assert.match(load, /Does not change authentication\/network sharing, unload other models, select LM Studio as the agent or run a prompt/)
  assert.match(load, /Returns background loading status/)
})

test('all five tools use the shared 197-entry catalog and dispatch without a project or renderer action', async () => {
  const f = fixture()
  assert.equal(f.server.lastSnapshot, null); assert.deepEqual(f.calls, [])
  assert.equal(f.server.tools.length, 197); assert.equal(new Set(f.server.tools.map(tool => tool.name)).size, 197)
  for (const tool of catalog.tools) {
    assert.deepEqual(f.server.tools.find(item => item.name === tool.name), tool)
    const result = await f.server.callTool(tool.name, args(tool.name))
    assert.equal(result.isError, undefined); assert.equal(detail(result).method, catalog.methods[tool.name])
    assert.deepEqual(f.calls.at(-1).payload, args(tool.name))
    assert.ok(!Object.hasOwn(detail(result), 'inferenceTested'))
  }
  assert.equal(f.calls.length, 5)
  const initialized = await f.server.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.ok(initialized.result.instructions.includes(catalog.guidance))
})

test('unavailable, declined, unsupported and uncertain native results remain errors without leaking exceptions', async () => {
  for (const name of catalog.names) {
    assert.equal((await createComfyStudioMcpServer().callTool(name, args(name))).isError, true)
    for (const code of ['DECLINED', 'UNSUPPORTED', 'MODEL_NOT_FOUND', 'LOAD_UNKNOWN']) {
      const result = await fixture({ failure: code }).server.callTool(name, args(name))
      assert.equal(result.isError, true); assert.equal(detail(result).success, false); assert.equal(detail(result).code, code)
    }
    const thrown = await fixture({ throws: true }).server.callTool(name, args(name))
    assert.equal(thrown.isError, true); assert.doesNotMatch(JSON.stringify(thrown), /synthetic-private-error|private\/model-path|synthetic-secret/)
    assert.match(JSON.stringify(thrown), /no download or connection success is confirmed/)
  }
})

test('export allows only cached LM status and cancellation, blocking plan/download/load even with forged preview flag', async () => {
  const policy = await import('../electron/exportPriorityPolicy.mjs')
  const f = fixture({ busy: true })
  for (const name of catalog.names) {
    const allowed = ['get_lmstudio_model_download', 'cancel_lmstudio_model_download'].includes(name)
    for (const payload of [args(name), { ...args(name), previewOnly: true }]) {
      assert.equal(policy.isMcpActionAllowedDuringExport(name, payload), allowed)
      const result = await f.server.callTool(name, payload)
      assert.equal(result.isError === true, !allowed, name)
    }
  }
  assert.deepEqual(f.calls.map(call => call.method), ['status', 'status', 'cancel', 'cancel'])
  assert.deepEqual(f.nativeApprovalCalls, [])
})

test('normal and Full access retain source/IDs and still dispatch download/load to the native approval layer', async () => {
  for (const trustedFullAccess of [false, true]) {
    const f = fixture(), approvals = [], dispatched = []
    const session = await createAgentToolSession({ getServer: () => f.server, trustedFullAccess, expectedContext: context,
      getContext: async () => guard, signal: new AbortController().signal,
      requestApproval: async request => { approvals.push(request); return true },
      executeTool: async (name, payload) => { dispatched.push({ name, payload }); return f.server.callTool(name, payload) },
    })
    for (const name of catalog.names) assert.equal((await session.callTool(name, args(name))).isError, undefined, name)
    assert.equal(approvals.length, trustedFullAccess ? 0 : 3)
    assert.deepEqual(f.nativeApprovalCalls, ['download', 'load'], 'Full access must not replace or bypass native approval dispatch')
    for (const call of dispatched) assert.deepEqual(call.payload, args(call.name), 'Setup arguments must not gain preview or forged approval fields')
    session.close?.()
  }
})

test('only native download/load human waits can pause the active tool budget, and Stop remains effective', async () => {
  for (const trustedFullAccess of [false, true]) {
    const server = createComfyStudioMcpServer(), waits = []
    const session = await createAgentToolSession({ getServer: () => server, trustedFullAccess, getContext: async () => guard,
      signal: new AbortController().signal, requestApproval: async () => true, limits: { operationTimeoutMs: 120 },
      executeTool: async (name, _args, _guard, controls) => {
        if (['download_lmstudio_model', 'load_lmstudio_model'].includes(name)) {
          assert.equal(typeof controls.onWaiting, 'function'); controls.onWaiting(true); await delay(250); controls.onWaiting(false)
        } else { assert.equal(controls, undefined) }
        return textResult({ success: true, state: 'loading' })
      },
    })
    const unsubscribe = session.subscribeUserWaiting(value => waits.push(value))
    for (const name of catalog.names) assert.equal((await session.callTool(name, args(name))).isError, undefined, name)
    assert.equal(waits.filter(value => value === true).length, 2); assert.equal(waits.at(-1), false); unsubscribe(); session.close?.()
  }
  const controller = new AbortController(), server = createComfyStudioMcpServer()
  let enteredWait
  const entered = new Promise(resolve => { enteredWait = resolve })
  const session = await createAgentToolSession({ getServer: () => server, trustedFullAccess: true, getContext: async () => guard,
    signal: controller.signal, requestApproval: async () => true,
    executeTool: async (_name, _args, _guard, controls) => { controls.onWaiting(true); enteredWait(); await delay(50); return textResult({ success: true }) },
  })
  const pending = session.callTool('load_lmstudio_model', args('load_lmstudio_model'))
  await entered; controller.abort(); assert.equal((await pending).isError, true); session.close?.()
})

test('normal status calls cannot pause or exceed the active budget', async () => {
  for (const trustedFullAccess of [false, true]) {
    const session = await createAgentToolSession({ getServer: () => createComfyStudioMcpServer(), trustedFullAccess, getContext: async () => guard,
      signal: new AbortController().signal, requestApproval: async () => true, limits: { operationTimeoutMs: 40 },
      executeTool: async (_name, _args, _guard, controls) => { assert.equal(controls, undefined); await delay(100); return textResult({ success: true }) },
    })
    const result = await session.callTool('get_lmstudio_model_download', args('get_lmstudio_model_download'))
    assert.equal(result.isError, true); session.close?.()
  }
})

test('download/load resume their active deadline after native approval and never replay timed-out work', async () => {
  for (const trustedFullAccess of [false, true]) for (const name of ['download_lmstudio_model', 'load_lmstudio_model']) {
    let executions = 0
    const session = await createAgentToolSession({ getServer: () => createComfyStudioMcpServer(), trustedFullAccess, getContext: async () => guard,
      signal: new AbortController().signal, requestApproval: async () => true, limits: { operationTimeoutMs: 60 },
      executeTool: async (_name, _args, _guard, controls) => {
        executions++; controls.onWaiting(true); await delay(100); controls.onWaiting(false)
        await delay(130); return textResult({ success: true, state: 'downloading' })
      },
    })
    const result = await session.callTool(name, args(name))
    assert.equal(result.isError, true, `${name} must retain its active deadline after user waiting ends`)
    assert.equal(executions, 1); session.close?.()
  }
})

test('agent instructions and one-shot native dispatcher keep bounded guidance and non-retrying progress association', () => {
  const provider = fs.readFileSync(path.join(__dirname, '../electron/connectedAgent.cjs'), 'utf8')
  assert.match(provider, /if \(request\.toolsEnabled \|\| request\.fullAccess\) instructions \+= `\\n\$\{require\('\.\/lmStudioSetupTools\.cjs'\)\.guidance\}`/)
  assert.match(provider, /\['request_comfy_cloud_setup', 'download_lmstudio_model', 'load_lmstudio_model', 'generate_comfy_router_image', 'generate_create_media'\]\.includes\(name\) \? \{ onWaiting: waiting => \{ task\.onWaiting\(waiting\); controls\?\.onWaiting\?\.\(waiting\) \}/)
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  assert.match(source, /lmStudioSetup: lmStudioSetupController\.api/)
  const execution = source.slice(source.indexOf('executeTool: (name, args, guard, signal, origin)'), source.indexOf('const optionalSetup ='))
  assert.equal((execution.match(/mcpServer\.callTool\(name, args\)/g) || []).length, 1)
  assert.match(execution, /try\s*\{\s*lmStudioSetupController\.associateAgentResult\(name, result, origin, guard\?\.context\?\.projectKey \|\| guard\?\.projectKey\)\s*\}\s*catch/)
  assert.match(execution, /return result/)
  assert.match(execution, /\['request_comfy_cloud_setup', 'download_lmstudio_model', 'load_lmstudio_model', 'generate_comfy_router_image', 'generate_create_media'\]\.includes\(name\)\) cloudScope\.onWaiting = origin\?\.onWaiting/)
})
