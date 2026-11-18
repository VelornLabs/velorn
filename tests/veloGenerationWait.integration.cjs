'use strict'
// Real bundled Codex engine, scripted local provider, synthetic jobs only.
// Run with runtime/run-isolated.cjs: no host account, project, GPU or internet.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), http = require('node:http'), zlib = require('node:zlib')
const { createVeloCodexEngine } = require('../electron/veloCodexEngine.cjs')
const { waitForGenerationRuns, tool, instructions } = require('../electron/veloGenerationWait.cjs')
const { createMcpGateway } = require('../electron/connectedAgentMcpGateway.cjs')
assert.equal(process.env.HOME, undefined); assert.equal(process.env.CODEX_HOME, undefined)
assert.equal(JSON.parse(fs.readFileSync('/candidate-isolation.json')).fixtureOnly, true)
assert(Object.values(os.networkInterfaces()).flat().every(value => value.internal))
const root = fs.mkdtempSync('/state/generation-wait-')
const catalog = { models: [{ slug: 'gpt-6-luna', display_name: 'Scripted fixture', description: 'Offline generation wait fixture', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low', description: 'Light' }], shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 0, upgrade: null, base_instructions: 'Deterministic offline fixture.', supports_reasoning_summaries: true, support_verbosity: false, default_verbosity: null, apply_patch_tool_type: 'freeform', web_search_tool_type: 'text', truncation_policy: { mode: 'tokens', limit: 10000 }, supports_image_detail_original: false, context_window: 272000, effective_context_window_percent: 95, experimental_supported_tools: [], input_modalities: ['text'], additional_speed_tiers: [], service_tiers: [], default_service_tier: null, tool_mode: 'code_mode_only' }] }
const catalogPath = `${root}/catalog.json`; fs.writeFileSync(catalogPath, JSON.stringify(catalog))
let requests = 0, toolCalls = 0, reads = 0, engine, server, monitor, assertionError, noPollingConfirmed = false
const ids = Array.from({ length: 10 }, (_, i) => `existing-${i}`)
const output = text => ({ type: 'message', role: 'assistant', id: `msg_${requests}`, phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] })
function stream(res, items) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const base = { id: `resp_${requests}`, object: 'response', model: 'gpt-6-luna', created_at: 1, status: 'in_progress', output: [] }
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  emit('response.created', { response: base })
  items.forEach((item, output_index) => { emit('response.output_item.added', { output_index, item }); emit('response.output_item.done', { output_index, item }) })
  emit('response.completed', { response: { ...base, status: 'completed', output: items, usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } })
  res.end()
}
function client(enableMonitor = true) {
  return createVeloCodexEngine({ executablePath: '/runtime/bin/codex', providerUrl: `http://127.0.0.1:${server.address().port}/v1`,
    catalogPath, stateDir: `${root}/engine`, workspaceDir: '/workspace', scope: { accountId: 'synthetic', projectId: 'synthetic', chatId: 'batch' },
    accessMode: 'velorn', directGenerationWait: enableMonitor, assertIsolatedRuntime: () => true, assertAuthorized: () => true,
    mcpServers: enableMonitor ? { [monitor.serverName]: { url: monitor.url, bearer_token_env_var: monitor.tokenEnvVar,
      startup_timeout_sec: 15, tool_timeout_sec: 86400, default_tools_approval_mode: 'approve', enabled: true, required: true } } : {},
    mcpEnv: enableMonitor ? { [monitor.tokenEnvVar]: monitor.bearerToken } : {} })
}
async function createMonitor() {
  return createMcpGateway({ serverName: 'velorn_generation', timeoutMs: 0, toolSession: {
    listTools: async () => [tool], callTool: async (name, args, scope) => {
      assert.equal(name, tool.name); toolCalls++; assert.equal(toolCalls, 1)
      const began = Date.now()
      const result = await waitForGenerationRuns(args, { signal: scope.signal, pollMs: 1000,
        read: async () => {
          reads++; const elapsed = Date.now() - began
          assert.equal(requests, 2, 'No provider consultation during wait, including after the code-mode default yield')
          if (elapsed > 31000) noPollingConfirmed = true
          return { success: true, runs: ids.map(id => ({ id, status: elapsed > 35000 ? 'done' : 'running',
            importState: elapsed > 35000 ? 'imported' : 'pending', outputCount: elapsed > 35000 ? 1 : 0,
            resultAssetIds: elapsed > 35000 ? [`asset-${id}`] : [] })) }
        } })
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } } })
}
async function main() {
  server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(catalog)); return }
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks), body = JSON.parse(req.headers['content-encoding'] === 'zstd' ? zlib.zstdDecompressSync(raw) : raw)
      requests++; fs.writeFileSync(`${root}/request-${requests}.json`, JSON.stringify(body))
      assert.equal(req.url, '/v1/responses'); assert.equal(body.model, 'gpt-6-luna'); assert.equal(body.reasoning.effort, 'low')
      if (requests === 1) {
        return stream(res, [output('Legacy chat preserved. No tools dispatched.')])
      }
      if (requests === 2) {
        const flatten = (tools, namespace) => tools.flatMap(t => t.type === 'namespace' ? flatten(t.tools, t.name) : [{ ...t, namespace }])
        const direct = flatten(body.tools).find(t => t.name.endsWith(tool.name))
        assert.ok(direct, 'Wait is directly callable in an existing chat, not hidden inside code mode')
        return stream(res, [{ type: 'function_call', id: 'fc_wait', call_id: 'call_wait', ...(direct.namespace ? { namespace: direct.namespace } : {}), name: direct.name,
          arguments: JSON.stringify({ runIds: ids }), status: 'completed' }])
      }
      if (requests === 3) {
        assert.equal(toolCalls, 1); assert.equal(noPollingConfirmed, true)
        assert.match(JSON.stringify(body.input), /batch_complete/)
        for (const id of ids) assert.ok(JSON.stringify(body.input).includes(`asset-${id}`))
        return stream(res, [output('Ten existing clips imported. No generation was submitted by the monitor.')])
      }
      assert.equal(requests, 4); assert.equal(toolCalls, 1)
      assert.match(JSON.stringify(body.input), /batch_complete/)
      stream(res, [output('The completed batch receipts remain available after reopening.')])
    } catch (error) { assertionError = error; res.writeHead(500); res.end('Synthetic fixture assertion failed') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  monitor = await createMonitor()
  engine = client(false)
  const legacy = await engine.runTurn({ input: [{ type: 'text', text: 'Seed a synthetic pre-update chat without a generation monitor.' }] })
  assert.equal(legacy.status, 'completed'); await engine.close()
  engine = client()
  const first = await engine.runTurn({ input: [{ type: 'text', text: 'Wait for the ten already submitted synthetic clips.' }], developerInstructions: instructions })
  if (assertionError) throw assertionError
  assert.equal(first.status, 'completed'); assert.equal(requests, 3); assert.equal(toolCalls, 1); assert.ok(reads > 30)
  await engine.close(); engine = client()
  const second = await engine.runTurn({ input: [{ type: 'text', text: 'Recall the batch without repeating tools.' }], developerInstructions: instructions })
  if (assertionError) throw assertionError
  assert.equal(second.status, 'completed'); assert.equal(requests, 4); assert.equal(toolCalls, 1)
  console.log(JSON.stringify({ passed: true, realEngine: true, scriptedProvider: true, paidRequests: 0,
    generationSubmissions: 0, monitoredJobs: 10, nativeWaitCalls: toolCalls, localLedgerReads: reads,
    providerRequestsDuringWait: 0, noCodeModeYieldPolling: noPollingConfirmed, legacyChatUpgrade: true, receiptsRetainedAfterReopen: true }))
}
main().catch(error => { console.error(assertionError || error); process.exitCode = 1 }).finally(async () => {
  await engine?.close(); await monitor?.close(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve))
})
