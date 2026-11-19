'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { PROJECT_CONVERSATION_GUIDANCE } = require('../electron/connectedAgentProjectGuidance.cjs')
const detail = value => JSON.parse(value.content[0].text)

test('workflow opening is discoverable and clearly distinct from generation', () => {
  const server = createComfyStudioMcpServer()
  const tool = server.tools.find(tool => tool.name === 'open_comfyui_workflow')
  assert.ok(tool)
  assert.deepEqual(tool.inputSchema.required, ['workflowId'])
  assert.equal(tool.inputSchema.properties.previewOnly.default, true)
  assert.match(tool.description, /Does not queue generation/)
  assert.match(tool.description, /replacing its displayed graph/)
  assert.match(PROJECT_CONVERSATION_GUIDANCE, /open_comfyui_workflow/)
  assert.ok(Buffer.byteLength(PROJECT_CONVERSATION_GUIDANCE) < 6144)
})

test('saved graph preview works without an open project and carries the renderer plan', async () => {
  const calls = []
  const server = createComfyStudioMcpServer({ performAction: async request => {
    calls.push(request)
    return { previewOnly: true, opened: false, applied: false, workflowId: request.payload.workflowId,
      generationSubmitted: false, suggestedApplyPayload: { workflowId: request.payload.workflowId, previewOnly: false } }
  } })
  const response = await server.callTool('open_comfyui_workflow', { workflowId: 'tpl-mcp-built-graph' })
  assert.notEqual(response.isError, true)
  assert.deepEqual(calls, [{ action: 'open_comfyui_workflow', payload: { workflowId: 'tpl-mcp-built-graph', previewOnly: true } }])
  const value = detail(response)
  assert.equal(value.previewOnly, true)
  assert.equal(value.result.opened, false)
  assert.deepEqual(value.suggestedApplyCall, { tool: 'open_comfyui_workflow', arguments: { workflowId: 'tpl-mcp-built-graph', previewOnly: false } })
})

test('apply routes only the graph opening action and reports confirmed renderer outcome', async () => {
  const calls = []
  const server = createComfyStudioMcpServer({ performAction: async request => {
    calls.push(request)
    return { success: true, opened: true, applied: true, generationSubmitted: false, previewOnly: false }
  } })
  const response = await server.callTool('open_comfyui_workflow', { workflowId: 'my-workflow:portrait', previewOnly: false })
  assert.equal(detail(response).success, true)
  assert.equal(detail(response).result.opened, true)
  assert.equal(detail(response).result.generationSubmitted, false)
  assert.deepEqual(calls.map(call => call.action), ['open_comfyui_workflow'])
})

test('missing bridge and renderer loader errors fail without a false open receipt', async () => {
  for (const server of [createComfyStudioMcpServer(), createComfyStudioMcpServer({ performAction: async () => { throw new Error('Embedded ComfyUI is unavailable') } })]) {
    const result = await server.callTool('open_comfyui_workflow', { workflowId: 'tpl-mcp-test', previewOnly: false })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /bridge|unavailable/)
  }
})
