'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const catalog = require('../electron/toolSetupTools.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { createAgentToolSession } = require('../electron/connectedAgentTools.cjs')
const detail = result => JSON.parse(result.content[0].text)
const args = name => name === 'plan_tool_setup' ? { integration: 'comfyui' }
  : name === 'download_tool_installer' ? { planId: 'host-owned-plan' } : { jobId: 'host-owned-job' }

function fixture(options = {}) {
  const calls = []
  const api = Object.fromEntries(Object.values(catalog.methods).map(method => [method, async payload => {
    calls.push({ method, payload })
    return options.failure ? { success: false, code: 'DECLINED', error: 'The user declined native confirmation.' }
      : { success: true, method, ...(method === 'plan' ? { planId: 'host-owned-plan' } : { jobId: 'host-owned-job', state: 'downloading' }) }
  }]))
  return { calls, server: createComfyStudioMcpServer({ toolSetup: api, isExportBusy: () => options.busy === true }) }
}

test('setup catalog accepts IDs only and keeps installer effects out of passive setup reads', () => {
  assert.equal(catalog.tools.length, 5)
  assert.deepEqual([...catalog.readNames], ['plan_tool_setup', 'get_tool_setup_download'])
  for (const tool of catalog.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(tool.annotations.readOnlyHint, catalog.readNames.has(tool.name))
    assert.ok(!('url' in tool.inputSchema.properties) && !('path' in tool.inputSchema.properties) && !('approved' in tool.inputSchema.properties))
  }
  assert.match(catalog.guidance, /native desktop confirmation even under Full access/)
  assert.match(catalog.guidance, /Opening an installer is not installation success/)
  assert.match(catalog.guidance, /initial zero bytes is normal/)
  assert.match(catalog.guidance, /live progress in the desktop chat after the turn ends/)
  assert.match(catalog.guidance, /do not ask for the same download approval again/)
  assert.match(catalog.tools.find(tool => tool.name === 'download_tool_installer').description, /transfer continues asynchronously/)
})

test('all five setup tools dispatch without a project; construction and listing are passive', async () => {
  const f = fixture()
  assert.equal(f.server.lastSnapshot, null)
  assert.deepEqual(f.calls, [])
  for (const tool of catalog.tools) {
    assert.ok(f.server.tools.some(item => item.name === tool.name))
    const result = await f.server.callTool(tool.name, args(tool.name))
    assert.equal(result.isError, undefined)
    assert.equal(detail(result).method, catalog.methods[tool.name])
  }
  assert.equal(f.calls.length, 5)
  const initialized = await f.server.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.match(initialized.result.instructions, /plan_tool_setup/)
})

test('unavailable setup service and declined native actions are failures, never installation success', async () => {
  for (const name of catalog.names) {
    assert.equal((await createComfyStudioMcpServer().callTool(name, args(name))).isError, true)
    const result = await fixture({ failure: true }).server.callTool(name, args(name))
    assert.equal(result.isError, true)
    assert.equal(detail(result).code, 'DECLINED')
  }
})

test('export blocks setup probes, downloads and installer opening while cached status/cancel remain available', async () => {
  const f = fixture({ busy: true })
  for (const name of catalog.names) {
    const result = await f.server.callTool(name, args(name))
    assert.equal(result.isError === true, !['get_tool_setup_download', 'cancel_tool_setup_download'].includes(name), name)
  }
  assert.deepEqual(f.calls.map(call => call.method), ['status', 'cancel'])
})

test('agent access modes preserve host plan/job IDs and never classify installer actions as reads', async () => {
  const context = { schemaVersion: 1, session: 'synthetic', projectKey: '/synthetic/project', timelineId: 'timeline', timelineSessionId: 1, compoundClipId: null, storyboardRevision: 0, revision: 2 }
  for (const trustedFullAccess of [false, true]) {
    const f = fixture(), approvals = [], dispatches = []
    const session = await createAgentToolSession({ getServer: () => f.server, signal: new AbortController().signal,
      expectedContext: context, trustedFullAccess, getContext: async () => ({ context, selection: {}, playhead: 0 }),
      requestApproval: async request => { approvals.push(request); return true },
      executeTool: async (name, payload) => { dispatches.push({ name, payload }); return f.server.callTool(name, payload) },
    })
    for (const name of catalog.names) assert.notEqual((await session.callTool(name, args(name))).isError, true, name)
    assert.equal(approvals.length, trustedFullAccess ? 0 : 3)
    for (const call of dispatches) assert.deepEqual(call.payload, args(call.name), 'No previewToken stripping or implicit previewOnly should alter the opaque setup IDs')
    session.close?.()
  }
})

test('tool-enabled and Full-access agent instructions include the bounded setup guidance', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/connectedAgent.cjs'), 'utf8')
  assert.match(source, /if \(request\.toolsEnabled \|\| request\.fullAccess\) instructions \+= `\\n\$\{require\('\.\/toolSetupTools\.cjs'\)\.guidance\}`/)
})

test('native agent dispatcher associates real installer results without turning presentation failure into a retry', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  const execution = source.slice(source.indexOf('executeTool: (name, args, guard, signal, origin)'), source.indexOf('const optionalSetup ='))
  assert.match(execution, /const result = await mcpServer\.callTool\(name, args\)/)
  assert.match(execution, /toolSetupController\.associateAgentResult\(name, result, origin,/)
  assert.match(execution, /guard\?\.context\?\.projectKey \|\| guard\?\.projectKey/)
  assert.match(execution, /try\s*\{[\s\S]*associateAgentResult\(name, result, origin,[\s\S]*\}\s*catch/)
  assert.equal((execution.match(/mcpServer\.callTool\(name, args\)/g) || []).length, 1)
  assert.match(execution, /return result/)
})
