'use strict'
// Run ONLY via runtime/run-isolated.cjs. The real bundled engine receives
// scripted protocol fixtures, not real inference or an invented model summary.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const zlib = require('node:zlib')
const { createVeloCodexEngine } = require('../electron/veloCodexEngine.cjs')
assert.equal(process.env.HOME, undefined); assert.equal(process.env.CODEX_HOME, undefined)
assert.equal(JSON.parse(fs.readFileSync('/candidate-isolation.json')).fixtureOnly, true)
assert(Object.values(os.networkInterfaces()).flat().every(value => value.internal))
assert.equal(fs.existsSync('/usr/lib/chatgpt/resources/codex'), false)
const root = fs.mkdtempSync('/state/compaction-'), events = [], requests = [], errors = [], outcomes = []
const catalog = { models: [{ slug: 'gpt-6-luna', display_name: 'Scripted fixture', description: 'Offline compaction protocol fixture only', default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low', description: 'Light' }], shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 0, upgrade: null, base_instructions: 'You are a deterministic offline protocol fixture.', supports_reasoning_summaries: true, support_verbosity: false, default_verbosity: null, apply_patch_tool_type: 'freeform', web_search_tool_type: 'text', truncation_policy: { mode: 'tokens', limit: 10000 }, supports_image_detail_original: false, context_window: 272000, effective_context_window_percent: 95, experimental_supported_tools: [], input_modalities: ['text'], additional_speed_tiers: [], service_tiers: [], default_service_tier: null, tool_mode: 'code_mode_only' }] }
const catalogPath = `${root}/catalog.json`; fs.writeFileSync(catalogPath, JSON.stringify(catalog))
const opaque = Buffer.from('SYNTHETIC_OPAQUE_COMPACTION_FIXTURE_NOT_A_REAL_MODEL_SUMMARY').toString('base64')
let engine, server, phase = 'initial', n = 0, calls = 0, waitingCompact, compactClosed
const wait = async (fn, label, ms = 10000) => { const until = Date.now() + ms; while (!fn()) { if (Date.now() > until) throw Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 10)) } }
const flatten = (tools = []) => tools.flatMap(tool => tool.type === 'namespace' ? flatten(tool.tools) : [tool])
function stream(res, output, inputTokens = 100) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const base = { id: `response_${n}`, object: 'response', model: 'gpt-6-luna', created_at: 1, status: 'in_progress', output: [] }
  const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
  emit('response.created', { response: base })
  for (const [output_index, item] of output.entries()) {
    emit('response.output_item.added', { output_index, item })
    emit('response.output_item.done', { output_index, item })
  }
  emit('response.completed', { response: { ...base, status: 'completed', output, usage: { input_tokens: inputTokens, output_tokens: 20, total_tokens: inputTokens + 20 } } })
  res.end()
}
const message = text => ({ type: 'message', role: 'assistant', id: `msg_${n}`, phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] })
function client(chatId = 'c', localCatalogPath = catalogPath) {
  return createVeloCodexEngine({ executablePath: '/runtime/bin/codex', providerUrl: `http://127.0.0.1:${server.address().port}/v1`,
    catalogPath: localCatalogPath, stateDir: `${root}/engine`, workspaceDir: '/workspace', scope: { accountId: 'synthetic', projectId: 'compaction-fixture', chatId },
    accessMode: 'velorn', assertIsolatedRuntime: () => true, assertAuthorized: () => true, onEvent: event => events.push(event),
    tools: [{ name: 'fixture_probe', description: 'Synthetic once-only action returning a receipt.', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['complete', 'failed'] } }, additionalProperties: false } }],
    callHostTool: async (_name, args) => { calls++; const success = args.kind === 'complete', text = success ? 'ONCE_ONLY_COMPLETED_RECEIPT' : 'ONCE_ONLY_FAILURE_RECEIPT'; fs.appendFileSync(`${root}/tool-receipts.txt`, `${text}\n`); return { success, contentItems: [{ type: 'inputText', text }] } },
  })
}
async function turn(text) { const result = await engine.runTurn({ input: [{ type: 'text', text }], developerInstructions: 'Offline fixture. Do not replay previous tool actions.' }); assert.equal(result.status, 'completed'); return result }
async function main() {
  server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(catalog)); return }
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const bytes = Buffer.concat(chunks), decoded = req.headers['content-encoding'] === 'zstd' ? zlib.zstdDecompressSync(bytes) : bytes
      const body = JSON.parse(decoded); n++
      assert.equal(body.model, 'gpt-6-luna')
      requests.push({ phase, path: req.url, headers: Object.keys(req.headers), body })
      fs.writeFileSync(`${root}/request-${n}.json`, JSON.stringify(requests.at(-1), null, 2))
      assert.equal(req.url, '/v1/responses'); assert.equal(body.reasoning.effort, 'low'); assert.equal(body.store, false)
      if (body.input.at(-1)?.type === 'compaction_trigger') {
        if (phase === 'compact-failure') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"message":"SCRIPTED_COMPACT_UNAVAILABLE"}}'); return }
        if (phase === 'compact-stop') { waitingCompact = true; res.once('close', () => { compactClosed = true }); return }
        assert(['compact-success', 'auto-followup'].includes(phase))
        assert(JSON.stringify(body.input).includes('ONCE_ONLY_FAILURE_RECEIPT'), 'Compaction receives actual completed tool result')
        if (phase === 'auto-followup') assert(JSON.stringify(body.input).includes('ONCE_ONLY_COMPLETED_RECEIPT'), 'Automatic compaction retains both success and failure receipts')
        const reply = { type: 'compaction', id: 'cmp_item_fixture', encrypted_content: opaque }
        fs.writeFileSync(`${root}/compact-response.json`, JSON.stringify(reply, null, 2))
        return stream(res, [reply])
      }
      if (phase === 'auto-initial') {
        if (JSON.stringify(body.input).includes('ONCE_ONLY_COMPLETED_RECEIPT') && JSON.stringify(body.input).includes('ONCE_ONLY_FAILURE_RECEIPT')) {
          // Deliberately high fixture usage triggers the real engine's native
          // automatic threshold on the next user turn. No production model,
          // context limit, provider usage or allowance is changed.
          return stream(res, [message('SCRIPTED_AUTO_INITIAL_FINISHED')], 25000)
        }
        return stream(res, [{ type: 'custom_tool_call', id: `ct_${n}`, call_id: `call_${n}`, name: 'exec', input: 'const tool=ALL_TOOLS.find(x=>/fixture_probe$/.test(x.name));text(await tools[tool.name]({kind:"complete"}));text(await tools[tool.name]({kind:"failed"}));', status: 'completed' }])
      }
      if (phase === 'auto-followup') {
        assert(body.input.some(item => item.type === 'compaction' && item.encrypted_content === opaque))
        assert.equal(JSON.stringify(body.input).includes('ONCE_ONLY_COMPLETED_RECEIPT'), false)
        assert.equal(JSON.stringify(body.input).includes('ONCE_ONLY_FAILURE_RECEIPT'), false)
        assert(JSON.stringify(body.input).includes('AUTO_FOLLOWUP_USER_MARKER'))
        return stream(res, [message('SCRIPTED_AUTO_CONTINUITY_FINISHED')])
      }
      if (phase === 'initial' || phase === 'stop-initial') {
        if (JSON.stringify(body.input).includes('ONCE_ONLY_FAILURE_RECEIPT')) return stream(res, [message('SCRIPTED_INITIAL_FINISHED')])
        const tools = flatten([...(body.tools || []), ...body.input.filter(item => item.type === 'additional_tools').flatMap(item => item.tools)])
        assert(tools.some(tool => tool.type === 'custom' && tool.name === 'exec'))
        return stream(res, [{ type: 'custom_tool_call', id: `ct_${n}`, call_id: `call_${n}`, name: 'exec', input: 'const tool=ALL_TOOLS.find(x=>/fixture_probe$/.test(x.name));text(await tools[tool.name]({}));', status: 'completed' }])
      }
      assert.equal(phase, 'continuation')
      assert(body.input.some(item => item.type === 'compaction' && item.encrypted_content === opaque), 'Native engine must preserve opaque compaction item verbatim')
      assert.equal(JSON.stringify(body.input).includes('ONCE_ONLY_FAILURE_RECEIPT'), false, 'No plaintext replacement summary is injected by adapter')
      return stream(res, [message('SCRIPTED_COMPACTION_CONTINUITY')])
    } catch (error) { errors.push(error.stack); res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } })) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  engine = client(); await assert.rejects(engine.compactThread(), { code: 'VELO_ENGINE_NO_HISTORY' })
  const first = await turn('Run synthetic action once, inspect failure and finish'); assert.equal(calls, 1)
  phase = 'compact-success'; const compacted = await engine.compactThread()
  assert.equal(compacted.compacted, true); assert.equal(compacted.threadId, first.threadId); assert.equal(calls, 1)
  outcomes.push({ phase, status: compacted.status, compacted: compacted.compacted, threadId: compacted.threadId })
  await engine.close(); engine = client(); assert.equal((await engine.start()).threadId, first.threadId)
  phase = 'continuation'; await turn('Continue after native compaction without repeating the action'); assert.equal(calls, 1)
  phase = 'compact-failure'; const beforeFailure = n
  await assert.rejects(engine.compactThread()); assert.equal(n, beforeFailure + 1, 'No provider retry')
  await assert.rejects(turn('Unacknowledged continuation'), { code: 'VELO_ENGINE_RECOVERY_REQUIRED' }); assert.equal(n, beforeFailure + 1)
  outcomes.push({ phase, singleAttempt: true, noReplay: true })
  await engine.close(); engine = client('stop'); phase = 'stop-initial'; await turn('Prepare independent cancellation fixture')
  phase = 'compact-stop'; const aborter = new AbortController()
  const pending = engine.compactThread({ signal: aborter.signal }).then(result => ({ result }), error => ({ error }))
  await wait(() => waitingCompact, 'compaction request'); aborter.abort()
  const stopped = await pending
  assert.equal(stopped.result?.status, 'interrupted'); await wait(() => compactClosed, 'upstream compaction cancellation')
  const beforeBlocked = n
  await assert.rejects(turn('Do not replay after stop'), { code: 'VELO_ENGINE_RECOVERY_REQUIRED' }); assert.equal(n, beforeBlocked)
  outcomes.push({ phase, interrupted: true, upstreamClosed: true, noReplay: true })
  await engine.close()
  const autoCatalogPath = `${root}/catalog-auto-fixture.json`
  fs.writeFileSync(autoCatalogPath, JSON.stringify({ models: catalog.models.map(model => ({ ...model, auto_compact_token_limit: 20000 })) }))
  engine = client('automatic', autoCatalogPath); phase = 'auto-initial'
  const beforeAutoCalls = calls
  const initialAuto = await turn('Run one synthetic successful action and one failed action, then finish')
  assert.equal(calls, beforeAutoCalls + 2)
  phase = 'auto-followup'; const beforeAutoRequests = n, beforeAutoEvents = events.length
  const autoResult = await turn('AUTO_FOLLOWUP_USER_MARKER: inspect retained context without repeating the completed or failed actions')
  assert.equal(autoResult.threadId, initialAuto.threadId); assert.equal(autoResult.text, 'SCRIPTED_AUTO_CONTINUITY_FINISHED')
  assert.equal(calls, beforeAutoCalls + 2, 'Automatic compaction must not replay either action')
  const automaticRequests = requests.slice(beforeAutoRequests)
  assert.equal(automaticRequests.length, 2)
  assert.equal(automaticRequests[0].body.input.at(-1).type, 'compaction_trigger')
  assert(automaticRequests[1].body.input.some(item => item.type === 'compaction' && item.encrypted_content === opaque))
  assert(events.slice(beforeAutoEvents).some(event => event.method === 'item/completed' && event.params.item?.type === 'contextCompaction'))
  outcomes.push({ phase: 'automatic-compaction', manuallyRequested: false, fixtureTokenThreshold: 20000, fixturePreviousUsage: 25000,
    compactRequests: 1, continuationRequests: 1, successAndFailureReceiptsRetained: true, noReplay: true, finalReplyCorrectlyAttributed: true })
  assert.deepEqual(errors, [])
  fs.writeFileSync(`${root}/result.json`, JSON.stringify({ passed: true, fixtureOnly: true, paidRequests: 0, realEngine: true, calls, outcomes,
    limitations: ['Opaque compaction is a scripted wire fixture, not a real encrypted provider summary or cognition claim.'] }, null, 2))
  console.log(JSON.stringify({ passed: true, root, calls, outcomes }))
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 }).finally(async () => {
  await engine?.close(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve))
  fs.writeFileSync(`${root}/events.json`, JSON.stringify(events, null, 2)); fs.writeFileSync(`${root}/requests.json`, JSON.stringify(requests, null, 2)); fs.writeFileSync(`${root}/errors.json`, JSON.stringify(errors, null, 2))
})
