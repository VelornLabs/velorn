'use strict'

// Read-only live check. Also runs under ELECTRON_RUN_AS_NODE=1 with the bundled
// Electron executable, testing the packaged native Node runtime without opening
// another Velorn window, sharing its profile or touching its project.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { names } = require('../electron/comfyWorkflowAuthoring.cjs')
const endpoint = process.argv[2]
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint || '')) throw new Error('Supply the actual running ComfyUI loopback URL, e.g. http://127.0.0.1:8189, and optionally a saved API workflow path.')

async function main() {
  let reads = 0, writes = 0
  const server = createComfyStudioMcpServer({ port: 0,
    readComfyNodeCatalog: async () => {
      reads++
      const response = await fetch(`${endpoint}/object_info`, { signal: AbortSignal.timeout(10000) })
      assert.equal(response.status, 200)
      return { info: await response.json(), endpoint }
    },
    performAction: () => { writes++; throw new Error('Unexpected renderer write') },
  })
  try {
    await server.start()
    let id = 0
    const rpc = async (method, params = {}) => {
      const response = await fetch(`http://127.0.0.1:${server.server.address().port}/mcp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      })
      const value = await response.json(); assert.ok(!value.error, JSON.stringify(value)); return value.result
    }
    const call = async (name, args) => {
      const r = await rpc('tools/call', { name, arguments: args })
      assert.notEqual(r.isError, true, JSON.stringify(r))
      const value = JSON.parse(r.content[0].text)
      assert.equal(value.success, true); assert.equal(value.endpoint, endpoint)
      return value
    }
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'authoring-smoke', version: '1' } })
    assert.match(init.instructions, /inspect_comfyui_node/)
    const catalog = await rpc('tools/list')
    for (const name of names) assert.ok(catalog.tools.some(t => t.name === name))
    const found = await call('discover_comfyui_nodes', { query: 'VAE Decode' })
    assert.ok(found.total > 0)
    const schema = await call('inspect_comfyui_node', { classType: 'VAEDecode' })
    assert.ok(schema.inputs.some(i => i.name === 'samples' && i.type === 'LATENT'))
    const chain = await call('find_comfyui_node_paths', { fromType: 'LATENT', toType: 'IMAGE', maxDepth: 2 })
    assert.ok(chain.paths.some(p => p.some(e => e.classType === 'VAEDecode')))
    const bad = await call('validate_comfyui_workflow', { workflow: { a: { class_type: 'VAEDecode', inputs: {} } } })
    assert.equal(bad.valid, false)
    assert.ok(bad.errors.some(e => e.code === 'MISSING_INPUT'))
    if (process.argv[3]) {
      const graph = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
      const result = await call('validate_comfyui_workflow', { workflow: graph })
      assert.equal(result.valid, true, JSON.stringify(result))
      console.log(`Saved API graph: valid schema, ${result.warningCount} advisory warnings; no execution.`)
    }
    assert.equal(writes, 0)
    console.log(`PASS: MCP initialize/list, discovery, schemas, paths and validation; ${reads} catalog GETs, zero renderer writes or GPU submissions. Runtime ${process.versions.electron || process.version}.`)
  } finally { await server.stop() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
