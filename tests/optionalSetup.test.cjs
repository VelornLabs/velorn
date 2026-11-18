'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createOptionalSetup, registerOptionalSetupIpc, CHANNEL, tools } = require('../electron/optionalSetup.cjs')
const { registerConnectedAgentIpc, CHANNELS } = require('../electron/connectedAgent.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { createAgentToolSession } = require('../electron/connectedAgentTools.cjs')
const detail = result => JSON.parse(result.content[0].text)
const json = value => new Response(JSON.stringify(value))
const readyCodex = { success: true, available: true, installed: true, signedIn: true, authMode: 'chatgpt', models: [{ id: 'test-model' }] }

function fixture(options = {}) {
  const handlers = new Map(), calls = [], events = []
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: (...args) => events.push(args) })
  let window = { webContents: contents, isDestroyed: () => false }
  const app = new EventEmitter()
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) }
  const controller = registerConnectedAgentIpc({ ipcMain, app, getMainWindow: () => window,
    fetchImpl: async (...args) => { calls.push(['fetch', ...args]); throw Error('No real service permitted') },
    codex: { inspect: async (...args) => { calls.push(['codex', ...args]); return readyCodex }, send: async () => assert.fail('No inference permitted') },
    ...options,
  })
  const setup = createOptionalSetup({ inspectProvider: controller.inspectProvider,
    getConfiguredPort: async () => 8188,
    comfySetup: { discoverRunning: async () => { calls.push(['comfy']); return [] } },
  })
  const ipc = registerOptionalSetupIpc({ ipcMain, app, getMainWindow: () => window, setup })
  const event = { sender: contents, senderFrame: contents.mainFrame }
  return { handlers, calls, events, controller, setup, ipc, event, contents, app,
    call: payload => handlers.get(CHANNEL)(event, payload),
    replaceWindow: () => { window = { webContents: Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false }), isDestroyed: () => false } },
    dispose: () => { ipc.dispose(); controller.dispose() },
  }
}

test('constructing optional setup never probes, signs in, sends a prompt or changes settings', () => {
  const f = fixture()
  try { assert.deepEqual(f.calls, []); assert.ok(f.handlers.has(CHANNEL)) } finally { f.dispose() }
})

test('setup accepts only one named integration; rejects injected paths, endpoints and actions before inspection', async () => {
  const f = fixture()
  try {
    for (const payload of [undefined, null, [], {}, { integration: 'all' }, { integration: 'codex', action: 'login' },
      { integration: 'codex', path: '/tmp/untrusted' }, { integration: 'lmstudio', endpoint: 'https://remote.test' },
      { integration: 'comfyui', port: 80 }, { integration: 'comfyui', previewOnly: false }]) {
      assert.equal((await f.call(payload)).code, 'INVALID_REQUEST')
    }
    assert.deepEqual(f.calls, [])
  } finally { f.dispose() }
})

test('optional setup IPC rejects foreign windows and subframes and does not inspect', async () => {
  const f = fixture()
  try {
    for (const event of [{}, { sender: f.contents, senderFrame: {} },
      { sender: { isDestroyed: () => false }, senderFrame: f.contents.mainFrame }]) {
      assert.equal((await f.handlers.get(CHANNEL)(event, { integration: 'codex' })).code, 'UNAUTHORIZED')
    }
    assert.deepEqual(f.calls, [])
  } finally { f.dispose() }
})

test('native shared provider path is identical to authenticated renderer inspection and keeps IPC sender checks', async () => {
  const f = fixture()
  try {
    const native = await f.controller.inspectProvider({ provider: 'codex' })
    const renderer = await f.handlers.get(CHANNELS.inspect)(f.event, { provider: 'codex' })
    assert.deepEqual(renderer, native)
    assert.equal(f.calls.length, 2)
    assert.equal((await f.handlers.get(CHANNELS.inspect)({}, { provider: 'codex' })).code, 'UNAUTHORIZED')
    assert.equal(f.calls.length, 2)
    assert.equal((await f.call({ integration: 'codex' })).state, 'ready')
  } finally { f.dispose() }
  assert.equal((await f.controller.inspectProvider({ provider: 'codex' })).code, 'UNAUTHORIZED')
})

test('native setup serializes provider checks and never launches another metadata process while busy', async () => {
  let release
  const calls = []
  const f = fixture({ codex: { inspect: async () => { calls.push('inspect'); return new Promise(resolve => { release = resolve }) } } })
  try {
    const first = f.call({ integration: 'codex' })
    assert.equal((await f.controller.inspectProvider({ provider: 'lmstudio' })).code, 'BUSY')
    const repeated = f.setup.inspect({ integration: 'codex' })
    release(readyCodex)
    assert.deepEqual(await first, await repeated)
    assert.deepEqual(calls, ['inspect'])
  } finally { f.dispose() }
})

test('setup metadata cannot be delivered to a replacement main window', async () => {
  let release
  const f = fixture({ codex: { inspect: async () => new Promise(resolve => { release = resolve }) } })
  try {
    const waiting = f.call({ integration: 'codex' })
    f.replaceWindow(); release(readyCodex)
    assert.equal((await waiting).code, 'UNAUTHORIZED')
  } finally { f.dispose() }
})

test('Codex setup distinguishes missing CLI, sign-in, unsupported launch and verified ChatGPT readiness', async () => {
  for (const [result, state] of [
    [{ success: false, code: 'CODEX_NOT_FOUND' }, 'missing'],
    [{ success: true, installed: false }, 'missing'],
    [{ success: true, installed: true, signedIn: false, code: 'CODEX_LOGIN_REQUIRED' }, 'signin'],
    [{ success: true, installed: true, signedIn: true, authMode: 'apiKey', code: 'CODEX_CHATGPT_REQUIRED' }, 'signin'],
    [{ success: true, installed: true, code: 'CODEX_TERMINATED' }, 'problem'],
    [{ success: false, code: 'CODEX_EXECUTABLE_INVALID' }, 'problem'],
    [{ success: true, available: true, signedIn: true, authMode: 'apiKey' }, 'problem'],
    [readyCodex, 'ready'],
  ]) {
    const setup = createOptionalSetup({ inspectProvider: async () => ({ ...result, executable: { path: '/private/account/codex' }, error: 'secret', message: 'secret' }) })
    const output = await setup.inspect({ integration: 'codex' })
    assert.equal(output.success, true); assert.equal(output.state, state)
    assert.doesNotMatch(JSON.stringify(output), /private\/account|secret/)
  }
})

test('shared setup preserves bounded known failures but never exposes raw process or credential output', async () => {
  for (const code of ['BUSY', 'CANCELLED', 'UNAUTHORIZED']) {
    const setup = createOptionalSetup({ inspectProvider: async () => ({ success: false, code, error: 'TOKEN_SECRET /private/home/codex' }) })
    const result = await setup.inspect({ integration: 'codex' })
    assert.equal(result.success, false); assert.equal(result.code, code)
    assert.doesNotMatch(JSON.stringify(result), /TOKEN_SECRET|private\/home/)
  }
  const setup = createOptionalSetup({ inspectProvider: async () => { throw Error('TOKEN_SECRET') } })
  const result = await setup.inspect({ integration: 'codex' })
  assert.equal(result.code, 'SETUP_UNAVAILABLE')
  assert.doesNotMatch(JSON.stringify(result), /TOKEN_SECRET/)
})

test('LM setup distinguishes stopped server, absent model, unloaded model and uncertain readiness', async () => {
  for (const [providerResult, state] of [
    [{ success: false, code: 'CONNECTION_FAILED' }, 'unavailable'],
    [{ success: true, models: [] }, 'needs-model'],
    [{ success: true, models: [{ id: 'test', loaded: false }], loadedModelStatus: 'available' }, 'needs-model'],
    [{ success: true, models: [{ id: 'test' }], loadedModelStatus: 'unavailable' }, 'problem'],
    [{ success: true, models: [{ id: 'test', loaded: true }], loadedModelStatus: 'available' }, 'ready'],
  ]) {
    const setup = createOptionalSetup({ inspectProvider: async value => { assert.deepEqual(value, { provider: 'lmstudio' }); return providerResult } })
    const output = await setup.inspect({ integration: 'lmstudio' })
    assert.equal(output.state, state)
    assert.notEqual(output.state, 'missing')
  }
})

test('LM setup uses fixed bounded native GET model endpoints; never loads a model or changes the active selection', async () => {
  const requests = []
  const f = fixture({ fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method, redirect: options.redirect })
    return url.endsWith('/api/v1/models')
      ? json({ models: [{ type: 'llm', key: 'test', display_name: 'Test', loaded_instances: [{ id: 'test' }] }] })
      : json({ data: [{ id: 'test' }] })
  } })
  try {
    const result = await f.call({ integration: 'lmstudio' })
    assert.equal(result.state, 'ready')
    assert.deepEqual(result.models, [{ id: 'test', displayName: 'Test', loaded: true }])
    assert.deepEqual(requests, [
      { url: 'http://127.0.0.1:1234/v1/models', method: 'GET', redirect: 'error' },
      { url: 'http://127.0.0.1:1234/api/v1/models', method: 'GET', redirect: 'error' },
    ])
  } finally { f.dispose() }
})

test('LM HTTP authorization and redirect failures stay sanitized and never advise weakening authentication', async () => {
  for (const status of [301, 401, 403]) {
    const f = fixture({ fetchImpl: async () => new Response('TOKEN_SECRET', { status }) })
    try {
      const result = await f.call({ integration: 'lmstudio' })
      assert.equal(result.state, 'unavailable')
      assert.match(result.nextActions.join(' '), /does not supply a token/)
      assert.match(result.nextActions.join(' '), /Do not expose.*turn off required authentication/)
      assert.doesNotMatch(JSON.stringify(result), /TOKEN_SECRET/)
    } finally { f.dispose() }
  }
})

test('model metadata is bounded and projects only IDs, labels and known loaded state', async () => {
  const models = [{ id: '/private/home/model' }, { id: 'C:\\private\\model' }, { id: 'newline\nmodel' },
    { id: 'safe', displayName: 'A model', loaded: true, instructions: 'SECRET', token: 'SECRET', path: '/private/home' },
    { id: 'safe', loaded: true }, { id: 'safe-other', displayName: '/Users/private/model' },
    ...Array.from({ length: 150 }, (_, index) => ({ id: `model-${index}` }))]
  const setup = createOptionalSetup({ inspectProvider: async () => ({ success: true, loadedModelStatus: 'available', models }) })
  const result = await setup.inspect({ integration: 'lmstudio' })
  assert.ok(result.models.length <= 100)
  assert.deepEqual(result.models[0], { id: 'safe', displayName: 'A model', loaded: true })
  assert.deepEqual(result.models[1], { id: 'safe-other' })
  assert.equal(result.models.filter(value => value.id === 'safe').length, 1)
  assert.doesNotMatch(JSON.stringify(result), /SECRET|private|instructions|token/)
})

test('ComfyUI setup reports alternate servers without choosing, saving, starting or claiming installation status', async () => {
  const requests = []
  for (const [found, state] of [
    [[], 'unavailable'], [[{ port: 8000 }], 'unavailable'], [[{ port: 8000 }, { port: 8189 }], 'unavailable'],
    [[{ port: 8188 }], 'ready'],
  ]) {
    const setup = createOptionalSetup({ getConfiguredPort: async () => 8188,
      comfySetup: { discoverRunning: async value => { requests.push(value); return found } } })
    const result = await setup.inspect({ integration: 'comfyui' })
    assert.equal(result.state, state); assert.equal(result.configuredPort, 8188)
    assert.deepEqual(result.connections.map(value => value.port), found.map(value => value.port))
    assert.notEqual(result.state, 'missing')
  }
  assert.ok(requests.every(value => value.configuredPort === 8188 && Object.keys(value).length === 1))
})

test('ComfyUI metadata drops raw fields and invalid ports, and never trusts a reported remote URL', async () => {
  const setup = createOptionalSetup({ getConfiguredPort: async () => 8188,
    comfySetup: { discoverRunning: async () => [{ port: 8188, httpBase: 'https://remote.test', deviceNames: ['GPU', 'invalid\nname'], path: '/private/path', token: 'TOKEN_SECRET' }, { port: -1 }] } })
  const result = await setup.inspect({ integration: 'comfyui' })
  assert.deepEqual(result.connections, [{ port: 8188, httpBase: 'http://127.0.0.1:8188', deviceNames: ['GPU'] }])
  assert.doesNotMatch(JSON.stringify(result), /remote\.test|private|TOKEN_SECRET/)
  const invalid = createOptionalSetup({ getConfiguredPort: async () => 'https://remote.test', comfySetup: { discoverRunning: () => assert.fail('No probe') } })
  assert.equal((await invalid.inspect({ integration: 'comfyui' })).code, 'SETUP_UNAVAILABLE')
})

test('agent setup guide is optional and never signs in or selects a provider/model for the user', async () => {
  const calls = []
  const setup = createOptionalSetup({ inspectProvider: async value => { calls.push(value); return { success: true, installed: true, signedIn: false } } })
  const result = await setup.guide({ provider: 'codex' })
  assert.equal(result.optional, true); assert.equal(result.changesMade, false); assert.equal(result.userActionRequired, true)
  assert.match(result.location, /Settings > Connections > Connect tools/)
  assert.match(result.notice, /optional/)
  assert.match(result.nextActions.join(' '), /complete the browser sign-in yourself/)
  assert.deepEqual(calls, [{ provider: 'codex' }])
  for (const payload of [{}, { provider: 'comfyui' }, { provider: 'codex', signIn: true }]) assert.equal((await setup.guide(payload)).success, false)
})

test('both setup tools are in the real MCP catalog and work without a project', async () => {
  const setup = createOptionalSetup({ inspectProvider: async () => readyCodex })
  const server = createComfyStudioMcpServer({ optionalSetup: setup })
  assert.equal(server.lastSnapshot, null)
  for (const definition of tools) {
    assert.deepEqual(server.tools.find(value => value.name === definition.name), definition)
    const args = definition.name === 'get_setup_status' ? { integration: 'codex' } : { provider: 'codex' }
    const result = await server.callTool(definition.name, args)
    assert.notEqual(result.isError, true); assert.equal(detail(result).state, 'ready')
    assert.equal((await server.callTool(definition.name, { ...args, command: 'login' })).isError, true)
  }
  assert.equal((await createComfyStudioMcpServer().callTool('get_setup_status', { integration: 'codex' })).isError, true)
})

test('setup tools are classified read-only for ordinary and Full access agent sessions', async () => {
  const setup = createOptionalSetup({ inspectProvider: async () => readyCodex })
  const server = createComfyStudioMcpServer({ optionalSetup: setup })
  const context = { schemaVersion: 1, session: 'fixture', projectKey: '/synthetic/project', timelineId: 't', timelineSessionId: 1, compoundClipId: null, revision: 1 }
  for (const trustedFullAccess of [false, true]) {
    const dispatches = []
    const session = await createAgentToolSession({ getServer: () => server, expectedContext: context,
      signal: new AbortController().signal, getContext: async () => ({ context }), trustedFullAccess,
      requestApproval: async () => assert.fail('Read-only setup must not request approval'), onEvent() {},
      executeTool: async (name, args) => { dispatches.push({ name, args }); return server.callTool(name, args) },
    })
    for (const [name, args] of [['get_setup_status', { integration: 'codex' }], ['guide_agent_setup', { provider: 'codex' }]]) {
      assert.notEqual((await session.callTool(name, args)).isError, true)
    }
    assert.equal(dispatches.length, 2)
    assert.ok(dispatches.every(value => !Object.hasOwn(value.args, 'previewOnly')))
  }
})

test('setup checks keep the existing export-priority restriction and do not execute while exporting', async () => {
  const server = createComfyStudioMcpServer({ isExportBusy: () => true,
    optionalSetup: { inspect: () => assert.fail('No probe during export'), guide: () => assert.fail('No probe during export') } })
  assert.equal((await server.callTool('get_setup_status', { integration: 'codex' })).isError, true)
  assert.equal((await server.callTool('guide_agent_setup', { provider: 'codex' })).isError, true)
})

test('explicit account sign-in emits one fixed setup invalidation before permission revocation, including failed revocation', async () => {
  for (const fails of [false, true]) {
    const steps = []
    const f = fixture({ executableAccess: { resolve: async () => ({ path: '/synthetic/codex' }) },
      fullAccessPreference: { forget: async () => { steps.push('forget'); assert.equal(f.events.length, 1); if (fails) throw Error('SECRET') } },
      signInCodexImpl: async () => { steps.push('login'); assert.equal(f.events.length, 1) },
    })
    try {
      const result = await f.handlers.get(CHANNELS.codexLogin)(f.event, { action: 'start' })
      assert.equal(result.success, !fails)
      assert.deepEqual(steps, fails ? ['forget'] : ['forget', 'login'])
      assert.deepEqual(f.events, [[CHANNELS.event, { type: 'codex-setup-changed' }]])
    } finally { f.dispose() }
  }
})

test('installation changes and uncertain failures emit one invalidation, but status and a cancelled chooser do not', async () => {
  for (const action of ['status', 'choose', 'auto']) for (const outcome of ['success', 'cancelled', 'failed', 'forget-failed']) {
    const respond = async () => {
      if (outcome === 'failed') throw Object.assign(Error('SECRET'), { code: 'CODEX_EXECUTABLE_INVALID' })
      return outcome === 'cancelled' && action === 'choose' ? null : { path: '/synthetic/codex', available: true }
    }
    const f = fixture({ executableAccess: { status: respond, choose: respond, automatic: respond },
      fullAccessPreference: { forget: async () => { if (outcome === 'forget-failed') throw Error('SECRET') } },
    })
    try {
      await f.handlers.get(CHANNELS.codexExecutable)(f.event, { action })
      const changed = action !== 'status' && !(action === 'choose' && outcome === 'cancelled')
      assert.deepEqual(f.events, changed ? [[CHANNELS.event, { type: 'codex-setup-changed' }]] : [], `${action} ${outcome}`)
    } finally { f.dispose() }
  }
})

test('invalid, unauthorized, blocked and cancelled setup actions never emit an account-change event', async () => {
  const f = fixture({ executableAccess: { resolve: async () => ({ path: '/synthetic/codex' }) },
    assertFullAccessAvailable: async () => { throw Object.assign(Error('Export is active'), { code: 'BUSY' }) },
  })
  try {
    await f.handlers.get(CHANNELS.codexLogin)(f.event, { action: 'cancel' })
    for (const channel of [CHANNELS.codexLogin, CHANNELS.codexExecutable]) {
      const action = channel === CHANNELS.codexLogin ? 'start' : 'auto'
      await f.handlers.get(channel)(f.event, { action, extra: true })
      await f.handlers.get(channel)({}, { action })
      await f.handlers.get(channel)(f.event, { action })
    }
    assert.deepEqual(f.events, [])
  } finally { f.dispose() }
})
