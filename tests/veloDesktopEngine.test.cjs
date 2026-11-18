'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { initializeDesktopEngine } = require('../electron/veloDesktopEngine.cjs')
const { lunaPromptWasNotSent } = require('../electron/connectedAgentLuna.cjs')
function fixture(options = {}) {
  const app = new EventEmitter(); app.getPath = () => '/synthetic/profile'
  const abort = new AbortController(), calls = [], nativeOptions = [], mcpOptions = []
  let valid = true, runs = 0
  const close = name => async () => calls.push('close-' + name)
  const lease = { signal: abort.signal, assertCurrent() { if (!valid) throw Error('revoked') },
    nativeEngineAuthority: () => ({ accountScope: 'account-A', token: 'PRIVATE_ACCOUNT_TOKEN', computerId: 'computer', baseUrl: 'https://connect.velorn.ai/account/desktop/luna/native-test/v1' }) }
  const runtime = { verify: () => true, executablePath: '/runtime/bin/codex',
    account(scope) { calls.push('scope-' + scope); return { stateDir: '/state/' + scope, catalogs: '/state/catalogs', spawnEngine: () => {} } } }
  const api = initializeDesktopEngine(app, { runtime,
    createBroker: async value => { await value.assertAuthorized(); calls.push('broker'); return { socketPath: '/synthetic/socket', capability: 'cap', close: close('broker') } },
    createGateway: async value => { value.assertAuthorized(); if (options.catalogFailure) throw Error('private route unavailable'); return {
      baseUrl: 'http://127.0.0.1:12345/v1', token: 'PRIVATE_GATEWAY_TOKEN', catalogPath: '/synthetic/catalog',
      subscribeWaiting: () => () => calls.push('unsubscribe'), close: close('gateway') } },
    createMcp: async value => { calls.push('mcp'); mcpOptions.push(value); const monitor = value.serverName === 'velorn_generation'; return {
      serverName: value.serverName || 'velorn_session', tokenEnvVar: monitor ? 'VELORN_AGENT_MCP_1111111111111111' : 'VELORN_AGENT_MCP_ABCDEF0123456789',
      url: `http://127.0.0.1:${monitor ? 23457 : 23456}/mcp`, bearerToken: (monitor ? 'c' : 'b').repeat(64), close: close(monitor ? 'monitor-mcp' : 'mcp') } },
    createEngine: value => {
      nativeOptions.push(value)
      return { start: async () => ({ recoveryRequired: !!options.recovery }),
        runTurn: async input => { runs++; await value.assertAuthorized(); calls.push(input);
          if (options.duringTurn) await options.duringTurn(input, abort, app);
          return { status: 'completed', text: 'PRIVATE_ACCOUNT_TOKEN PRIVATE_GATEWAY_TOKEN safe reply' } },
        close: close('engine') }
    },
    showRecoveryDialog: async () => ({ response: options.confirm ? 1 : 0 }),
  })
  const request = { conversationId: 'chat-A', messages: [{ role: 'assistant', content: 'Previously completed action' }, { role: 'user', content: 'Inspect only' }], toolsEnabled: !!options.tools, fullAccess: !!options.full }
  const sendOptions = { fundedLuna: lease, signal: new AbortController().signal, computerAccess: !!options.full,
    ...(options.monitor ? { toolSession: { monitorGenerationRuns: options.monitor } } : {}),
    engineContext: { projectKey: 'project-A', workspaceDir: '/synthetic/project', assertCurrent: async () => { if (!valid) throw Error('project changed') } },
    assertBeforeSend: async () => { if (!valid) throw Error('authority revoked') } }
  return { app, api, calls, nativeOptions, mcpOptions, lease, request, sendOptions, abort,
    revoke() { valid = false; abort.abort() }, runs: () => runs }
}
test('desktop registers a dedicated monitor for existing chats, leaves other tool timeouts and permissions unchanged', async () => {
  let monitored = 0
  const f = fixture({ tools: true, monitor: async (args, controls) => {
    monitored++; assert.deepEqual(args, { runIds: ['existing'] }); assert.equal(controls.signal.aborted, false)
    controls.onProgress('1/1 clips imported')
    return { success: true, reason: 'batch_complete', pendingRunIds: [], runs: [] }
  }, duringTurn: async () => {
    const host = f.mcpOptions.find(v => v.serverName === 'velorn_generation')
    assert.equal(host.timeoutMs, 0)
    assert.equal((await host.toolSession.listTools()).length, 1)
    const value = await host.toolSession.callTool('wait_for_comfyui_runs', { runIds: ['existing'] }, { signal: new AbortController().signal })
    assert.equal(JSON.parse(value.content[0].text).reason, 'batch_complete')
  } })
  await f.api.sendVelo(f.request, f.sendOptions)
  const config = f.nativeOptions[0]
  assert.equal(config.directGenerationWait, true); assert.equal(config.accessMode, 'velorn')
  assert.equal(config.mcpServers.velorn_generation.tool_timeout_sec, 86400)
  assert.equal(config.mcpServers.velorn_session.tool_timeout_sec, 600)
  assert.equal(monitored, 1); assert.ok(f.calls.includes('close-monitor-mcp'))
})

test('normal desktop initialization is lazy and changes no app identity/profile/account', () => {
  const f = fixture(); assert.deepEqual(f.calls, []); assert.equal(f.api.fundedLuna, undefined)
  assert.equal(f.api.sendVelo.handlesComputerAccess, true)
})
for (const mode of ['chat', 'velorn', 'full']) test('native adapter retains ' + mode + ' permissions, stable scopes, no credentials in output', async () => {
  const f = fixture({ tools: mode !== 'chat', full: mode === 'full' })
  const result = await f.api.sendVelo(f.request, f.sendOptions)
  assert.equal(result.model, 'gpt-6-luna'); assert.equal(result.reasoningEffort, 'low')
  assert.equal(result.text.includes('PRIVATE_'), false); assert.equal(f.runs(), 1)
  assert.equal(f.nativeOptions[0].accessMode, mode)
  assert.deepEqual(f.nativeOptions[0].scope, { accountId: 'account-A', projectId: 'project-A', chatId: 'chat-A' })
  assert.equal(f.calls.includes('mcp'), mode !== 'chat')
  const sent = f.calls.find(value => value?.firstInput)
  assert.match(sent.firstInput[0].text, /Previously completed action/)
  assert.doesNotMatch(sent.input[0].text, /Previously completed action/)
  for (const name of ['engine', 'gateway', 'broker']) assert.ok(f.calls.includes('close-' + name))
})
test('route unavailable preserves draft, performs no inference or fallback and closes broker', async () => {
  const f = fixture({ catalogFailure: true })
  await assert.rejects(f.api.sendVelo(f.request, f.sendOptions), e => lunaPromptWasNotSent(e))
  assert.equal(f.runs(), 0); assert.ok(f.calls.includes('close-broker'))
})
test('revoked account cannot create engine or broker', async () => {
  const f = fixture(); f.revoke()
  await assert.rejects(f.api.sendVelo(f.request, f.sendOptions), e => lunaPromptWasNotSent(e))
  assert.deepEqual(f.calls, [])
})
test('quit cancels the native operation through combined authority', async () => {
  const f = fixture({ duringTurn: async (input, _abort, app) => { app.emit('will-quit'); assert.equal(input.signal.aborted, true); throw Error('quit') } })
  await assert.rejects(f.api.sendVelo(f.request, f.sendOptions))
  assert.equal(f.runs(), 1); assert.ok(f.calls.includes('close-engine'))
})
for (const confirm of [false, true]) test('uncertain history requires affirmative continuation: ' + confirm, async () => {
  const f = fixture({ recovery: true, confirm })
  if (confirm) {
    await f.api.sendVelo(f.request, f.sendOptions)
    assert.equal(f.calls.find(value => value?.input).acknowledgeUncertain, true)
  } else await assert.rejects(f.api.sendVelo(f.request, f.sendOptions), e => lunaPromptWasNotSent(e))
  assert.equal(f.runs(), confirm ? 1 : 0)
})
