'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { tools } = require('../electron/mcpEditingTools.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { projectConnectedAgentTool } = require('../electron/connectedAgentArguments.cjs')

test('trim_clips public schema distinguishes timeline timing from source In and Out', () => {
  const published = createComfyStudioMcpServer().tools.find(tool => tool.name === 'trim_clips')
  const scalar = published.inputSchema.properties
  const item = scalar.clips.items.properties
  for (const properties of [scalar, item]) {
    assert.match(properties.startSeconds.description, /start position.*timeline/i)
    assert.match(properties.durationSeconds.description, /duration.*timeline/i)
    assert.match(properties.durationSeconds.description, /shorten or lengthen.*timeline/i)
    assert.match(properties.trimStartSeconds.description, /source-in.*In point/i)
    assert.match(properties.trimEndSeconds.description, /source-out.*Out point/i)
    assert.match(properties.trimEndSeconds.description, /alone does not shorten.*timeline/i)
    assert.match(properties.trimEndSeconds.description, /set durationSeconds.*timeline duration/i)
  }
  for (const field of ['startSeconds', 'durationSeconds', 'trimStartSeconds', 'trimEndSeconds']) {
    assert.deepEqual(item[field], scalar[field], `${field} uses the shared trim definition in scalar and batch forms.`)
  }
})

test('edit_trim public schema explains direct primary IDs and the exact selection fallback without changing compatibility', () => {
  const declared = tools.find(tool => tool.name === 'edit_trim')
  const published = createComfyStudioMcpServer().tools.find(tool => tool.name === 'edit_trim')
  assert.deepEqual(published, { ...declared, inputSchema: { ...declared.inputSchema,
    properties: { ...declared.inputSchema.properties, expectedContext: published.inputSchema.properties.expectedContext } } },
  'Publication retains the declared schema apart from its existing shared context description.')
  assert.equal(published.inputSchema.properties.expectedContext.type, 'object')
  assert.equal(published.inputSchema.properties.expectedContext.additionalProperties, true)
  assert.match(published.inputSchema.properties.expectedContext.description, /Pass it unchanged to reject stale writes/)
  const { properties, required } = published.inputSchema
  assert.deepEqual(required, ['mode', 'deltaSeconds'], 'Conditional targeting retains existing optional selection fallback.')
  assert.deepEqual(properties.mode.enum, ['normal', 'roll', 'slip', 'slide', 'ripple'])
  assert.deepEqual(properties.edge.enum, ['start', 'end', 'left', 'right'])
  assert.equal(properties.clipId.type, 'string')
  assert.match(properties.clipId.description, /Exact inspected primary clip ID for normal, slip, slide or ripple/)
  assert.match(properties.clipId.description, /requires no prior selection/)
  assert.match(properties.clipId.description, /If omitted, exactly one clip must already be selected/)
  assert.match(properties.clipId.description, /empty or multiple selections are invalid/)
  for (const field of ['targetClipIds', 'clipIds']) {
    assert.equal(properties[field].type, 'array')
    assert.equal(properties[field].minItems, 1)
    assert.equal(properties[field].uniqueItems, true)
    assert.deepEqual(properties[field].items, { type: 'string' })
    assert.match(properties[field].description, /normal\/ripple/)
    assert.match(properties[field].description, /Must include the primary clip resolved from clipId or exactly one selected clip/)
    assert.match(properties[field].description, /list does not replace/)
  }
  assert.match(properties.clipAId.description, /Exact inspected outgoing clip ID required for roll; supply together with clipBId, not selection/)
  assert.match(properties.clipBId.description, /Exact inspected incoming clip ID required for roll; supply together with clipAId, not selection/)
  assert.match(properties.edge.description, /Required for normal and ripple/)
  assert.equal(properties.previewOnly.default, true)
  assert.ok(properties.previewToken)
  assert.ok(properties.expectedContext)
  assert.deepEqual(published.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false })
})

test('connected-agent schema inherits public targeting descriptions and preserves its host-managed control projection', () => {
  const publicTool = createComfyStudioMcpServer().tools.find(tool => tool.name === 'edit_trim')
  const before = JSON.parse(JSON.stringify(publicTool))
  const connected = projectConnectedAgentTool(publicTool)
  assert.deepEqual(publicTool, before, 'Projection must not mutate the external MCP schema.')
  for (const field of ['clipId', 'clipAId', 'clipBId', 'targetClipIds', 'clipIds', 'mode', 'deltaSeconds']) {
    assert.deepEqual(connected.inputSchema.properties[field], publicTool.inputSchema.properties[field])
  }
  assert.ok(connected.description.startsWith(publicTool.description))
  assert.match(connected.inputSchema.properties.edge.description, /Required for normal and ripple/)
  assert.deepEqual(connected.inputSchema.properties.edge.enum, publicTool.inputSchema.properties.edge.enum)
  assert.deepEqual(connected.inputSchema.required, publicTool.inputSchema.required)
  assert.equal(connected.inputSchema.properties.expectedContext, undefined)
  assert.equal(connected.inputSchema.properties.previewToken, undefined)
  assert.equal(connected.inputSchema.properties.previewOnly.default, true)
})
