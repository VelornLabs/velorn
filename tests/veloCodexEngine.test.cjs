'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { createVeloCodexEngine, buildEngineConfig, verifyEffectiveConfiguration, scopeKey, MODEL, EFFORT, PROVIDER } = require('../electron/veloCodexEngine.cjs')

const textInput = text => [{ type: 'text', text }]
const scope = { accountId: 'synthetic-account', projectId: 'synthetic-project', chatId: 'synthetic-chat' }
function fixture(t, overrides = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-engine-unit-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const base = { executablePath: '/runtime/bin/codex', catalogPath: '/state/synthetic-catalog.json', providerUrl: 'http://127.0.0.1:18099/v1', stateDir: temp, workspaceDir: '/workspace', scope, accessMode: 'full', assertIsolatedRuntime: () => true, assertAuthorized: () => {}, rpcTimeoutMs: 200, ...overrides }
  const threads = new Map(), children = [], calls = [], results = []
  let turnHandler, compactHandler, turnNumber = 0, threadNumber = 0
  const notify = (child, method, params) => child.stdout.write(JSON.stringify({ method, params }) + '\n')
  const complete = (child, threadId, turnId, status = 'completed', text = 'Synthetic success') => {
    notify(child, 'item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `message-${turnId}`, text } })
    notify(child, 'turn/completed', { threadId, turn: { id: turnId, status, error: status === 'failed' ? { message: 'Synthetic interrupted transport' } : null } })
  }
  function spawnImpl(executable, args, options) {
    const child = new EventEmitter()
    child.exitCode = null; child.signalCode = null
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
    child.kill = signal => { child.signalCode = signal; child.exitCode = 0; child.emit('exit', 0, signal); return true }
    child.stdin.on('finish', () => { child.exitCode = 0; child.emit('exit', 0) })
    children.push({ child, executable, args, options })
    let buffer = ''
    child.stdin.on('data', chunk => {
      buffer += chunk.toString()
      let i
      while ((i = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1)
        if (!message.method) { results.push(message); turnHandler?.({ hostResult: message, child, notify, complete }); continue }
        calls.push(message)
        if (message.id == null) continue
        queueMicrotask(() => {
          let result = {}
          if (message.method === 'account/read') result = overrides.accountResult || { account: null, requiresOpenaiAuth: false }
          if (message.method === 'config/read') result = { config: overrides.effectiveConfig || buildEngineConfig(base) }
          if (message.method === 'thread/start') {
            const thread = { id: `thread-${++threadNumber}`, ephemeral: false, cwd: base.workspaceDir }
            threads.set(thread.id, thread); result = { thread }
          }
          if (message.method === 'thread/resume') result = { thread: threads.get(message.params.threadId) }
          if (message.method === 'turn/start') result = { turn: { id: `turn-${++turnNumber}`, status: 'inProgress' } }
          if (message.method === 'thread/compact/start') {
            const turnId = `compact-${++turnNumber}`, threadId = message.params.threadId
            const acknowledge = () => child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n')
            if (compactHandler) compactHandler({ turnId, threadId, acknowledge, notify, child })
            else {
              notify(child, 'turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } })
              notify(child, 'item/completed', { threadId, turnId, item: { id: 'compact-item', type: 'contextCompaction' } })
              notify(child, 'turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null } })
              acknowledge()
            }
            return
          }
          child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n')
          if (message.method === 'turn/start') {
            const ctx = { child, message, notify, complete, threadId: message.params.threadId, turnId: result.turn.id }
            if (turnHandler) turnHandler(ctx)
            else complete(child, ctx.threadId, ctx.turnId)
          }
          if (message.method === 'turn/interrupt') complete(child, message.params.threadId, message.params.turnId, 'interrupted', '')
        })
      }
    })
    return child
  }
  const create = extra => createVeloCodexEngine({ ...base, spawnImpl, ...extra })
  return { base, create, calls, children, results, threads, notify, complete, setTurnHandler: handler => { turnHandler = handler }, setCompactHandler: handler => { compactHandler = handler } }
}

test('fixed model/provider/effort and permission modes cannot inherit personal auth', () => {
  for (const mode of ['chat', 'velorn', 'full']) {
    const c = buildEngineConfig({ providerUrl: 'http://127.0.0.1:8080/v1', catalogPath: '/state/catalog.json', stateDir: '/state/engine', accessMode: mode })
    assert.equal(c.model, MODEL); assert.equal(c.model_reasoning_effort, EFFORT)
    assert.equal(c.model_providers[PROVIDER].requires_openai_auth, false)
    assert.equal(c.model_providers[PROVIDER].request_max_retries, 0)
    assert.equal(c.model_providers[PROVIDER].stream_max_retries, 0)
    assert.deepEqual(c.model_providers[PROVIDER].capabilities, { remote_compaction: 'v2' })
    assert.equal(c.features.shell_tool, mode === 'full')
    assert.equal(c.features.unified_exec, mode === 'full')
    assert.equal(c.features.code_mode.enabled, mode !== 'chat')
    assert.equal(c.sandbox_mode, mode === 'full' ? 'danger-full-access' : 'read-only')
    assert.equal(c.features.image_generation, false)
    verifyEffectiveConfiguration(c, c)
    assert.throws(() => verifyEffectiveConfiguration({ ...c, model: 'other' }, c), { code: 'VELO_ENGINE_CONFIGURATION_UNSAFE' })
  }
  for (const providerUrl of ['https://api.openai.com/v1', 'http://localhost:8080', 'http://127.0.0.1:1/?secret=x']) assert.throws(() => buildEngineConfig({ providerUrl, catalogPath: '/c', stateDir: '/s' }), { code: 'VELO_ENGINE_PROVIDER' })
})

test('only native ephemeral MCP capability is permitted; no auth or generic env pass-through', () => {
  const name = 'VELORN_AGENT_MCP_0123456789ABCDEF'
  const options = { providerUrl: 'http://127.0.0.1:1', catalogPath: '/c', stateDir: '/s', accessMode: 'velorn', mcpEnv: { [name]: 'a'.repeat(64) }, mcpServers: { velorn_session: { url: 'http://127.0.0.1:2/mcp', bearer_token_env_var: name } } }
  assert.equal(buildEngineConfig(options).mcp_servers.velorn_session.url, options.mcpServers.velorn_session.url)
  assert.ok(buildEngineConfig(options).shell_environment_policy.exclude.includes(name))
  assert.throws(() => buildEngineConfig({ ...options, accessMode: 'chat' }), { code: 'VELO_ENGINE_CONFIG' })
  assert.throws(() => buildEngineConfig({ ...options, mcpEnv: { ...options.mcpEnv, OPENAI_API_KEY: 'not-used' } }), { code: 'VELO_ENGINE_CONFIG' })
  assert.throws(() => buildEngineConfig({ ...options, mcpServers: { evil: { command: 'sh' } } }), { code: 'VELO_ENGINE_CONFIG' })
})

test('scopes are hashed and isolation/account/effective-config checks fail before a model turn', async t => {
  assert.match(scopeKey(scope), /^[0-9a-f]{64}$/)
  assert.notEqual(scopeKey(scope), scopeKey({ ...scope, accountId: 'another' }))
  for (const override of [
    { assertIsolatedRuntime: () => false },
    { accountResult: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } },
    { effectiveConfig: {} },
  ]) {
    const f = fixture(t, override), client = f.create()
    await assert.rejects(client.runTurn({ input: textInput('Synthetic') }))
    assert.equal(f.calls.some(call => call.method === 'turn/start'), false)
    await client.close()
  }
})

test('new thread seeds history once; fresh clients resume exact scoped history with current context', async t => {
  const f = fixture(t, { gatewayBearerToken: 'synthetic-local-capability' })
  let client = f.create()
  const first = await client.runTurn({ input: textInput('latest'), firstInput: textInput('historical seed plus latest'), developerInstructions: 'first context' })
  await client.close()
  client = f.create()
  const second = await client.runTurn({ input: textInput('followup'), firstInput: textInput('must not replay'), developerInstructions: 'fresh context' })
  await client.close()
  assert.equal(first.threadId, second.threadId); assert.equal(second.resumed, true)
  assert.equal(f.calls.filter(c => c.method === 'thread/start').length, 1)
  assert.equal(f.calls.find(c => c.method === 'thread/start').params.developerInstructions, 'first context')
  const firstTurnAt = f.calls.findIndex(c => c.method === 'turn/start')
  assert.equal(f.calls.slice(0, firstTurnAt).some(c => c.method === 'thread/resume'), false, 'A new engine thread has no resumable rollout before its first turn')
  const turns = f.calls.filter(c => c.method === 'turn/start')
  assert.deepEqual(turns.map(c => c.params.input), [textInput('historical seed plus latest'), textInput('followup')])
  for (const turn of turns) { assert.equal(turn.params.model, MODEL); assert.equal(turn.params.effort, 'low') }
  assert.ok(f.calls.some(c => c.method === 'thread/resume' && c.params.developerInstructions === 'fresh context'))
  for (const child of f.children) {
    assert.equal(child.options.env.HOME, undefined); assert.equal(child.options.env.CODEX_HOME, undefined)
    assert.equal(child.options.env.OPENAI_API_KEY, undefined)
    assert.equal(child.options.env.VELO_CODEX_GATEWAY_TOKEN, 'synthetic-local-capability')
    assert.equal(child.args.some(arg => arg.includes('synthetic-local-capability')), false)
  }
  const saved = fs.readFileSync(path.join(f.base.stateDir, `${scopeKey(scope)}.json`), 'utf8')
  assert.equal(saved.includes(scope.accountId), false); assert.equal(saved.includes('synthetic-local-capability'), false)
})

test('early host call race is retained; duplicate tool call ID executes only once and preserves images', async t => {
  const f = fixture(t), tool = { name: 'probe', description: 'Synthetic tool', inputSchema: { type: 'object' } }
  let count = 0, ctx
  f.setTurnHandler(event => {
    if (event.hostResult) {
      if (f.results.length === 2) f.complete(ctx.child, ctx.threadId, ctx.turnId)
      return
    }
    ctx = event
    const request = { method: 'item/tool/call', params: { threadId: ctx.threadId, turnId: ctx.turnId, callId: 'unique-call', namespace: 'velorn', tool: 'probe', arguments: { synthetic: true } } }
    ctx.child.stdout.write(JSON.stringify({ ...request, id: 'host-1' }) + '\n')
    ctx.child.stdout.write(JSON.stringify({ ...request, id: 'host-2' }) + '\n')
  })
  const client = f.create({ tools: [tool], callHostTool: async () => { count++; return { content: [{ type: 'text', text: 'real fixture result' }, { type: 'image', mimeType: 'image/png', data: 'AA==' }] } } })
  await client.runTurn({ input: textInput('Run synthetic tool once') }); await client.close()
  assert.equal(count, 1); assert.equal(f.results.length, 2)
  assert.deepEqual(f.results[0].result, f.results[1].result)
  assert.equal(f.results[0].result.contentItems[1].type, 'inputImage')
})

test('failed or interrupted turn needs explicit new continuation, never automatic replay', async t => {
  const f = fixture(t)
  f.setTurnHandler(ctx => f.complete(ctx.child, ctx.threadId, ctx.turnId, 'failed', 'An action may have completed'))
  const client = f.create()
  await assert.rejects(client.runTurn({ input: textInput('First action') }), { code: 'VELO_ENGINE_TURN_FAILED' })
  await assert.rejects(client.runTurn({ input: textInput('Would replay') }), { code: 'VELO_ENGINE_RECOVERY_REQUIRED' })
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1)
  f.setTurnHandler(ctx => f.complete(ctx.child, ctx.threadId, ctx.turnId))
  await client.runTurn({ input: textInput('Inspect retained result, continue only remaining work'), acknowledgeUncertain: true })
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 2)
  await client.close()
})

test('stored final reply excludes streamed commentary and falls back to last unphased public message', async t => {
  for (const withPhase of [true, false]) {
    const f = fixture(t)
    f.setTurnHandler(ctx => {
      for (const [id, text, phase] of [['progress', 'Inspecting synthetic workspace', 'commentary'], ['answer', 'Only the finished result', 'final_answer']]) {
        f.notify(ctx.child, 'item/completed', { threadId: ctx.threadId, turnId: ctx.turnId, item: { type: 'agentMessage', id, text, ...(withPhase ? { phase } : {}) } })
      }
      f.notify(ctx.child, 'turn/completed', { threadId: ctx.threadId, turn: { id: ctx.turnId, status: 'completed', error: null } })
    })
    const client = f.create()
    const result = await client.runTurn({ input: textInput('Synthetic task') })
    assert.equal(result.text, 'Only the finished result')
    assert.equal(result.completedItems.length, 2, 'Public activity remains available to the native event sink')
    await client.close()
  }
})

test('concurrent same-scope client and concurrent turn are rejected, then scope releases on close', async t => {
  const f = fixture(t), first = f.create(), second = f.create()
  await first.start()
  await assert.rejects(second.start(), { code: 'VELO_ENGINE_BUSY' })
  const running = first.runTurn({ input: textInput('First') })
  await assert.rejects(first.runTurn({ input: textInput('Duplicate') }), { code: 'VELO_ENGINE_BUSY' })
  await running; await first.close()
  const third = f.create(); await third.start(); await third.close()
})

test('cancel interrupts exact active turn and requests owned background-terminal cleanup', async t => {
  const f = fixture(t), client = f.create()
  let started
  const ready = new Promise(resolve => { started = resolve })
  f.setTurnHandler(ctx => { queueMicrotask(started) })
  const running = client.runTurn({ input: textInput('Synthetic long task') })
  await ready
  const stop = await client.cancel(), result = await running
  assert.equal(stop.stopped, true); assert.equal(result.status, 'interrupted')
  assert.equal(f.calls.filter(c => c.method === 'turn/interrupt').length, 1)
  assert.ok(f.calls.some(c => c.method === 'thread/backgroundTerminals/clean'))
  const beforeRetry = f.calls.filter(c => c.method === 'turn/start').length
  await assert.rejects(client.runTurn({ input: textInput('Do not replay after interruption'), acknowledgeUncertain: false }), { code: 'VELO_ENGINE_RECOVERY_REQUIRED' })
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, beforeRetry, 'No model turn dispatched by an unacknowledged continuation')
  await client.close()
})

test('native compaction accepts notifications before its RPC ack without fabricating summary input', async t => {
  const f = fixture(t), client = f.create()
  try {
    await assert.rejects(client.compactThread(), { code: 'VELO_ENGINE_NO_HISTORY' })
    assert.equal(f.calls.some(c => c.method === 'thread/compact/start'), false)
    const initial = await client.runTurn({ input: textInput('Synthetic task with prior tool work') })
    const compact = await client.compactThread()
    assert.equal(compact.threadId, initial.threadId); assert.equal(compact.compacted, true)
    assert.equal(compact.operation, 'compaction'); assert.equal(compact.text, '')
    assert.deepEqual(f.calls.find(c => c.method === 'thread/compact/start').params, { threadId: initial.threadId })
    assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1)
    assert.equal((await client.runTurn({ input: textInput('Continue retained state') })).threadId, initial.threadId)
  } finally { await client.close() }
})

test('compaction refuses a newly persisted empty thread even when uncertainty is acknowledged', async t => {
  const f = fixture(t), client = f.create()
  fs.writeFileSync(path.join(f.base.stateDir, `${scopeKey(scope)}.json`), JSON.stringify({ version: 1, scopeKey: scopeKey(scope), model: MODEL, provider: PROVIDER, workspaceDir: f.base.workspaceDir, threadId: 'thread-empty', status: 'ready' }))
  f.threads.set('thread-empty', { id: 'thread-empty', ephemeral: false, cwd: f.base.workspaceDir })
  try {
    await assert.rejects(client.compactThread({ acknowledgeUncertain: true }), { code: 'VELO_ENGINE_NO_HISTORY' })
    assert.equal(f.calls.some(c => c.method === 'thread/compact/start'), false)
  } finally { await client.close() }
})

test('completion without a contextCompaction item remains uncertain and cannot silently continue', async t => {
  const f = fixture(t), client = f.create()
  try {
    await client.runTurn({ input: textInput('Synthetic task') })
    f.setCompactHandler(({ child, turnId, threadId, notify, acknowledge }) => {
      notify(child, 'turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } })
      notify(child, 'turn/completed', { threadId, turn: { id: turnId, status: 'completed' } }); acknowledge()
    })
    await assert.rejects(client.compactThread(), { code: 'VELO_ENGINE_COMPACTION_UNCONFIRMED' })
    const count = f.calls.length
    await assert.rejects(client.runTurn({ input: textInput('Do not replay') }), { code: 'VELO_ENGINE_RECOVERY_REQUIRED' })
    await assert.rejects(client.compactThread(), { code: 'VELO_ENGINE_RECOVERY_REQUIRED' })
    assert.equal(f.calls.length, count)
  } finally { await client.close() }
})

test('compaction stop before turn identity waits for the native identity and interrupts exactly that turn', async t => {
  const f = fixture(t), client = f.create(), controller = new AbortController()
  try {
    await client.runTurn({ input: textInput('Synthetic task') })
    let startNative, compactTurnId
    f.setCompactHandler(({ child, turnId, threadId, notify, acknowledge }) => {
      compactTurnId = turnId; acknowledge()
      startNative = () => notify(child, 'turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } })
    })
    const pending = client.compactThread({ signal: controller.signal })
    while (!startNative) await new Promise(resolve => setImmediate(resolve))
    controller.abort(); startNative()
    assert.equal((await pending).status, 'interrupted')
    assert.equal(f.calls.find(c => c.method === 'turn/interrupt').params.turnId, compactTurnId)
    await assert.rejects(client.runTurn({ input: textInput('Do not replay') }), { code: 'VELO_ENGINE_RECOVERY_REQUIRED' })
  } finally { await client.close() }
})

test('compaction rechecks authorization and rejects unexpected dynamic host actions', async t => {
  const f = fixture(t); let allow = true, toolCount = 0
  const client = f.create({ assertAuthorized: ({ stage }) => { if (stage === 'compaction') assert.equal(allow, true, 'authorization revoked') },
    tools: [{ name: 'fixture_probe', description: 'Synthetic', inputSchema: { type: 'object' } }],
    callHostTool: async () => { toolCount++; return {} } })
  try {
    await client.runTurn({ input: textInput('Synthetic task') }); allow = false
    await assert.rejects(client.compactThread(), /authorization revoked/)
    assert.equal(f.calls.some(c => c.method === 'thread/compact/start'), false); allow = true
    f.setCompactHandler(({ child, turnId, threadId, notify, acknowledge }) => {
      notify(child, 'turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } })
      child.stdout.write(JSON.stringify({ id: 'unexpected-action', method: 'item/tool/call', params: { threadId, turnId, callId: 'unexpected', namespace: 'velorn', tool: 'fixture_probe', arguments: {} } }) + '\n')
      notify(child, 'item/completed', { threadId, turnId, item: { id: 'compact-item', type: 'contextCompaction' } })
      notify(child, 'turn/completed', { threadId, turn: { id: turnId, status: 'completed' } }); acknowledge()
    })
    await client.compactThread(); assert.equal(toolCount, 0)
    assert.equal(f.results.find(r => r.id === 'unexpected-action').result.success, false)
  } finally { await client.close() }
})
