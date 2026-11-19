'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { createLocalToolCatalog } = require('../electron/localAgentToolCatalog.cjs')

test('workflow browsing schema distinguishes purpose search from runtime and storage filters', () => {
  const tool = createComfyStudioMcpServer().tools.find(item => item.name === 'list_velorn_workflows')
  assert.ok(tool)
  assert.match(tool.description, /particular purpose or subject.*query/i)
  assert.match(tool.description, /runtime and source only select where.*runs or is stored, not what it does/i)
  assert.match(tool.inputSchema.properties.query.description, /requested purpose or subject/i)
  assert.match(tool.inputSchema.properties.query.description, /upscale/i)
})

test('workflow import router guidance retains the API name, preview and fingerprint contract', () => {
  const tools = createComfyStudioMcpServer().tools
  const catalog = createLocalToolCatalog(tools)
  const instruction = catalog.instructions.split('\n').find(line => line.startsWith('import_comfyui_workflow('))
  assert.ok(instruction, 'Import remains available through the router without discovery')
  assert.match(instruction, /API\/prompt graphs require an explicit lowercase name slug/)
  assert.match(instruction, /previewOnly:true first/)
  assert.match(instruction, /exact returned sourceFingerprint and targetFingerprint with previewOnly:false/)
  assert.equal(catalog.has('import_comfyui_workflow'), true)

  const original = tools.find(tool => tool.name === 'import_comfyui_workflow')
  const discovered = catalog.discover({ names: ['import_comfyui_workflow'] })
  assert.deepEqual(discovered.tools, [original], 'Full documentation must retain the native schema unchanged')
  const nameHelp = discovered.tools[0].inputSchema.properties.name.description
  assert.match(nameHelp, /API\/prompt graphs require an explicit lowercase name slug/)
  assert.match(nameHelp, /no default is inferred/)
  assert.match(nameHelp, /UI\/graph imports may default/)
  assert.match(original.inputSchema.properties.sourceFingerprint.description, /exact sourceFingerprint from the latest preview/)
  assert.match(original.inputSchema.properties.targetFingerprint.description, /exact targetFingerprint from the latest preview/)
})
