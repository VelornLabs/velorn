'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createMcpGateway, LIMITS } = require('../electron/connectedAgentMcpGateway.cjs')
const catalog = Array.from({ length: 162 }, (_, i) => ({ name: `tool_${i}`, description: `Velorn tool ${i}`, inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }))
const result = { content: [{ type: 'text', text: 'Done' }] }
async function rpc(gateway, message, overrides = {}) {
  return fetch(gateway.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gateway.bearerToken}`, ...overrides.headers }, body: typeof message === 'string' ? message : JSON.stringify(message), ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'headers')) })
}
const message = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params })
test('Full access gateway has no session deadline but still closes on Stop',async()=>{
  const controller=new AbortController()
  const gateway=await createMcpGateway({toolSession:{listTools:async()=>catalog,callTool:async()=>result},timeoutMs:0,signal:controller.signal})
  try {
    await new Promise(resolve=>setTimeout(resolve,25))
    assert.equal((await rpc(gateway,message('tools/list'))).status,200)
    controller.abort();await gateway.close()
    await assert.rejects(rpc(gateway,message('tools/list')))
  }finally{await gateway.close()}
})

test('catalog fingerprint ignores rotated transport but detects same-name schema changes', async t => {
  const make = async tools => {
    const gateway = await createMcpGateway({ toolSession: { listTools: async () => tools, callTool: async () => result } })
    t.after(() => gateway.close())
    return gateway
  }
  const first = await make(catalog)
  const next = await make([...catalog].reverse())
  assert.notEqual(first.url, next.url)
  assert.notEqual(first.bearerToken, next.bearerToken)
  assert.equal(first.catalogFingerprint, next.catalogFingerprint)
  const changed = await make(catalog.map((tool, i) => i ? tool : { ...tool, inputSchema: { type: 'object', properties: { value: { type: 'number' } } } }))
  assert.notEqual(first.catalogFingerprint, changed.catalogFingerprint)
  const description = await make(catalog.map((tool, i) => i ? tool : { ...tool, description: 'Changed behavior' }))
  assert.notEqual(first.catalogFingerprint, description.catalogFingerprint)
})

test('ephemeral authenticated gateway serves the full live catalog and only the host dispatcher', async () => {
  const calls = []
  const gateway = await createMcpGateway({ toolSession: { listTools: async () => catalog, callTool: async (...args) => { calls.push(args); return result } } })
  try {
    assert.match(gateway.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    assert.match(gateway.tokenEnvVar, /^VELORN_AGENT_MCP_[A-F0-9]+$/)
    assert.equal((await (await rpc(gateway, message('initialize', { protocolVersion: '2025-03-26' }))).json()).result.protocolVersion, '2025-03-26')
    assert.deepEqual((await (await rpc(gateway, message('tools/list'))).json()).result.tools, catalog)
    assert.deepEqual((await (await rpc(gateway, message('tools/call', { name: 'tool_161', arguments: { value: 'x' } }))).json()).result, result)
    assert.deepEqual(calls.map(call => call.slice(0, 2)), [['tool_161', { value: 'x' }]])
    assert.equal(calls[0][2].signal.aborted, false)
    const unknown = await (await rpc(gateway, message('tools/call', { name: 'shell', arguments: {} }))).json()
    assert.equal(unknown.error.code, -32602)
    assert.equal(calls.length, 1)
  } finally { await gateway.close() }
  assert.equal(calls[0][2].signal.aborted, true)
  await assert.rejects(fetch(gateway.url))
})

test('dedicated monitoring gateway cancellation reaches its native waiter without changing jobs', async () => {
  let started, cancelled = false
  const ready = new Promise(resolve => { started = resolve })
  const gateway = await createMcpGateway({ serverName: 'velorn_generation', timeoutMs: 0,
    toolSession: { listTools: async () => [catalog[0]], callTool: async (_name, _args, { signal }) => {
      started(); return new Promise(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(result) }, { once: true }))
    } } })
  const pending = rpc(gateway, message('tools/call', { name: catalog[0].name })).catch(() => null)
  await ready; await gateway.close(); await pending
  assert.equal(cancelled, true); assert.equal(gateway.serverName, 'velorn_generation')
})

test('gateway rejects browser origins, foreign hosts, bad tokens, batches, invalid RPC, and oversized input', async () => {
  let called = false
  const gateway = await createMcpGateway({ toolSession: { listTools: async () => catalog, callTool: async () => { called = true; return result } } })
  try {
    for (const headers of [{ Origin: 'http://127.0.0.1' }, { Authorization: 'Bearer wrong' }]) assert.ok([401, 403].includes((await rpc(gateway, message('tools/list'), { headers })).status))
    const foreignHost = await new Promise((resolve, reject) => {
      const request = http.request(gateway.url, { method: 'POST', headers: { Host: 'evil.example', Authorization: `Bearer ${gateway.bearerToken}`, 'Content-Type': 'application/json' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)) })
      request.on('error', reject); request.end(JSON.stringify(message('tools/list')))
    })
    assert.equal(foreignHost, 403)
    assert.equal((await (await rpc(gateway, [message('tools/list')])).json()).error.code, -32600)
    assert.equal((await (await rpc(gateway, '{invalid')).json()).error.code, -32700)
    assert.equal((await (await rpc(gateway, message('resources/read'))).json()).error.code, -32601)
    assert.equal((await rpc(gateway, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
    assert.equal((await rpc(gateway, message('tools/call', { name: 'tool_1', arguments: { text: 'x'.repeat(LIMITS.requestBytes) } }))).status, 413)
    assert.equal(called, false)
  } finally { await gateway.close() }
})

test('concurrent gateway tool calls run serially and cancellation prevents queued calls', async () => {
  const controller = new AbortController(); const started = []
  let release
  const gateway = await createMcpGateway({ signal: controller.signal, toolSession: { listTools: async () => catalog, callTool: async name => { started.push(name); if (name === 'tool_1') await new Promise(resolve => { release = resolve }); return result } } })
  const first = rpc(gateway, message('tools/call', { name: 'tool_1' })).catch(() => null)
  while (!release) await new Promise(resolve => setImmediate(resolve))
  const second = rpc(gateway, message('tools/call', { name: 'tool_2' })).catch(() => null)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(); release()
  await Promise.all([first, second]); await gateway.close()
  assert.deepEqual(started, ['tool_1'])
})

test('gateway preserves tool errors and allows work beyond previous call and request caps', async () => {
  let calls = 0
  const gateway = await createMcpGateway({ toolSession: { listTools: async () => catalog, callTool: async () => { if (++calls === 1) throw new Error('private secret'); return { isError: true, content: [{ type: 'text', text: 'Host denied this change.' }] } } } })
  try {
    const failed = await (await rpc(gateway, message('tools/call', { name: 'tool_1' }))).json()
    assert.equal(failed.result.isError, true)
    assert.doesNotMatch(JSON.stringify(failed), /private secret/)
    const denied = await (await rpc(gateway, message('tools/call', { name: 'tool_1' }))).json()
    assert.equal(denied.result.content[0].text, 'Host denied this change.')
    for (let i = calls; i < 66; i++) await rpc(gateway, message('tools/call', { name: 'tool_1' }))
    for (let i = 0; i < 260; i++) assert.equal((await rpc(gateway, message('ping'))).status, 200)
    const next = await (await rpc(gateway, message('tools/call', { name: 'tool_1' }))).json()
    assert.equal(next.result.content[0].text, 'Host denied this change.')
    assert.equal(calls, 67)
  } finally { await gateway.close() }
})
