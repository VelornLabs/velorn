'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createComfySetup } = require('../electron/comfySetup.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const detail = result => JSON.parse(result.content[0].text)
const copy = value => JSON.parse(JSON.stringify(value))
const stats = { system: { python_version: 'synthetic' }, devices: [{ name: 'Test device' }] }

// Exercise the actual native setter without Electron, real settings, servers,
// projects, launchers, accounts, or processes.
function nativeFixture() {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  const start = source.indexOf('function assertCanSwitchComfyConnection(')
  const end = source.indexOf('async function readComfyNodeCatalogInternal(', start)
  assert.ok(start > 0 && end > start)
  const calls = []
  const f = {
    settings: { unrelated: 'preserved', comfyConnection: { host: '127.0.0.1', port: 8188 } },
    state: { state: 'idle', ownership: 'none' }, output: stats, cancelled: false,
    afterProbe: () => {}, beforeWrite: () => {}, failWrite: false,
  }
  const dependencies = {
    URL, COMFY_CONNECTION_SETTING_KEY: 'comfyConnection',
    sanitizeLocalComfyPort: value => Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 65535 ? Number(value) : null,
    resolveLocalComfyPort: async () => f.settings.comfyConnection.port,
    comfyLauncher: { getState: () => f.state },
    agentDispatchScope: { current: () => { if (f.cancelled) throw new Error('Agent action cancelled before dispatch.'); return null } },
    exportJobs: { activeId: null },
    comfySetup: createComfySetup({ requestSystemStats: async request => {
      calls.push(['probe', request.port]); await f.afterProbe(); return f.output
    } }),
    writeSettingsRaw: async mutate => {
      await f.beforeWrite()
      const next = mutate(f.settings)
      if (f.failWrite) throw new Error('Settings write failed')
      f.settings = copy(next); calls.push(['write', copy(next)])
    },
    refreshSettingsDependentCaches: async () => calls.push(['refresh']),
    mainWindow: { isDestroyed: () => false },
    performMcpRendererAction: async request => { calls.push(['renderer', copy(request)]); return { success: true } },
  }
  vm.runInNewContext(source.slice(start, end) + '\nthis.connect = setComfyUIConnectionInternal', dependencies)
  return Object.assign(f, { connect: dependencies.connect, dependencies, calls })
}

test('native setup preview describes the port without probing, changing settings or adopting a process', async () => {
  const f = nativeFixture()
  f.state = { ownership: 'ours', state: 'running', httpBase: 'http://127.0.0.1:8188' }
  const before = copy(f.settings)
  const result = await f.connect({ port: 8000, previewOnly: true })
  assert.equal(result.success, true); assert.equal(result.previewOnly, true)
  assert.equal(result.before.port, 8188); assert.equal(result.after.port, 8000)
  assert.deepEqual(f.settings, before); assert.deepEqual(f.calls, [])
})

test('native apply shares desktop shape-checked probe and persists/synchronizes only a verified endpoint', async () => {
  const f = nativeFixture()
  const result = await f.connect({ port: 8000 })
  assert.equal(result.success, true); assert.equal(result.connection.port, 8000)
  assert.deepEqual(f.calls.map(value => value[0]), ['probe', 'write', 'refresh', 'renderer'])
  assert.equal(f.settings.comfyConnection.port, 8000)
  assert.equal(f.settings.unrelated, 'preserved')
  assert.deepEqual(f.calls.at(-1)[1], { action: 'set_comfyui_connection', payload: { port: 8000 } })
})

test('native apply rejects offline, non-ComfyUI, replaced and invalid targets without settings changes', async () => {
  for (const output of [null, {}, { message: 'Another local service' }, { system: { python_version: 'x' } }]) {
    const f = nativeFixture(); f.output = output
    const result = await f.connect({ port: 8000 })
    assert.equal(result.success, false); assert.match(result.error, /No settings were changed/)
    assert.equal(f.settings.comfyConnection.port, 8188)
    assert.deepEqual(f.calls, [['probe', 8000]])
  }
  const f = nativeFixture()
  for (const port of [true, false, {}, [8000], null, 0, 65536, 1.5, 'http://example.com:8000']) {
    assert.equal((await f.connect({ port })).success, false)
  }
  assert.deepEqual(f.calls, [])
  f.dependencies.comfySetup.probeConnection = async () => ({ port: 9 })
  assert.equal((await f.connect({ port: 8000 })).success, false)
  assert.deepEqual(f.calls, [])
})

test('native apply protects all owned active launcher states but allows reconnecting the same port', async () => {
  for (const ownership of ['ours', 'app']) for (const state of ['running', 'starting', 'stopping']) {
    const f = nativeFixture(); f.state = { ownership, state, httpBase: 'http://127.0.0.1:8188' }
    assert.equal((await f.connect({ port: 8000 })).success, false)
    assert.deepEqual(f.calls, [])
    assert.equal((await f.connect({ port: 8188 })).success, true)
  }
  for (const state of [null, { ownership: 'ours', state: 'running', httpBase: 'invalid' }]) {
    const f = nativeFixture(); f.state = state
    assert.equal((await f.connect({ port: 8000 })).success, false)
    assert.deepEqual(f.calls, [])
  }
})

test('native apply rechecks owned launcher, export and cancellation after probe and inside queued write', async () => {
  for (const hook of ['afterProbe', 'beforeWrite']) for (const change of ['launcher', 'export', 'cancel']) {
    const f = nativeFixture()
    f[hook] = () => {
      if (change === 'launcher') f.state = { ownership: 'app', state: 'starting', httpBase: 'http://127.0.0.1:8188' }
      if (change === 'export') f.dependencies.exportJobs.activeId = 'synthetic-export'
      if (change === 'cancel') f.cancelled = true
    }
    assert.equal((await f.connect({ port: 8000 })).success, false, `${hook}/${change}`)
    assert.equal(f.settings.comfyConnection.port, 8188)
    assert.deepEqual(f.calls, [['probe', 8000]])
  }
})

test('native failed save preserves old configuration and never announces a successful connection', async () => {
  const f = nativeFixture(); f.failWrite = true
  const result = await f.connect({ port: 8000 })
  assert.equal(result.success, false); assert.match(result.error, /write failed/)
  assert.equal(f.settings.comfyConnection.port, 8188)
  assert.deepEqual(f.calls, [['probe', 8000]])
})

test('native cache refresh failure retains the saved-setting receipt rather than suggesting a retry', async () => {
  const f = nativeFixture()
  f.dependencies.refreshSettingsDependentCaches = async () => { throw new Error('Cache refresh failed') }
  const result = await f.connect({ port: 8000 })
  assert.equal(result.success, true); assert.equal(result.settingsApplied, true)
  assert.equal(result.connected, false)
  assert.equal(f.settings.comfyConnection.port, 8000)
  assert.match(result.warning, /do not repeat/i)
  assert.ok(f.calls.every(call => call[0] !== 'renderer'))
})

test('native renderer synchronization failure reports saved settings and partial connection truth', async () => {
  for (const shouldThrow of [false, true]) {
    const f = nativeFixture()
    f.dependencies.performMcpRendererAction = async () => {
      if (shouldThrow) throw new Error('Window is unavailable')
      return { success: false, error: 'Window is unavailable' }
    }
    const result = await f.connect({ port: 8000 })
    assert.equal(result.success, true); assert.equal(result.settingsApplied, true)
    assert.equal(result.connected, false); assert.equal(result.rendererSync.success, false)
    assert.match(result.warning, /saved.*did not synchronize/i)
    assert.match(result.warning, /do not repeat/i)
    assert.equal(f.settings.comfyConnection.port, 8000)
  }
})

function serverFixture({ healthy = [8000], configuredPort = 8188, setConnection } = {}) {
  const diagnoses = [], updates = [], timeouts = []
  const server = createComfyStudioMcpServer({
    diagnoseComfyUIConnection: async ({ port = configuredPort, timeoutMs } = {}) => {
      diagnoses.push(port); timeouts.push(timeoutMs)
      return { connection: { port, ok: healthy.includes(port), httpBase: `http://127.0.0.1:${port}` },
        api: { objectInfo: { nodeClassCount: 10 } }, installMode: { mode: port === 8000 ? 'desktop' : 'manual' } }
    },
    setComfyUIConnection: async args => {
      updates.push(args)
      return setConnection ? setConnection(args) : { success: true, previewOnly: args.previewOnly, after: { port: args.port } }
    },
  })
  return { server, diagnoses, updates, timeouts }
}
const tools = ['guide_comfyui_setup', 'repair_comfyui_connection']

test('both agent setup paths find Desktop port 8000 by default and preserve non-mutating preview', async () => {
  for (const tool of tools) {
    const f = serverFixture()
    const result = detail(await f.server.callTool(tool, {}))
    assert.equal(result.previewOnly, true)
    assert.equal(result.reachable.connection.port, 8000)
    assert.ok(f.diagnoses.includes(8000))
    assert.deepEqual(f.updates, [{ port: 8000, previewOnly: true }])
    const applied = detail(await f.server.callTool(tool, { previewOnly: false, applyFix: true }))
    assert.equal(applied.appliedFix ?? applied.repaired, true)
    assert.deepEqual(f.updates.at(-1), { port: 8000, previewOnly: false })
  }
  const f = serverFixture()
  const result = detail(await f.server.callTool('guide_comfyui_setup', { previewOnly: false }))
  assert.equal(result.appliedFix, false)
  assert.deepEqual(f.updates, [{ port: 8000, previewOnly: true }])
})

test('multiple alternative servers are reported without choosing or writing; healthy configured server wins', async () => {
  for (const tool of tools) {
    const f = serverFixture({ healthy: [8000, 8189] })
    const result = detail(await f.server.callTool(tool, { previewOnly: false, applyFix: true }))
    assert.equal(result.selectionRequired, true)
    assert.deepEqual(result.candidates.map(value => value.port), [8000, 8189])
    assert.deepEqual(f.updates, [])
    const current = serverFixture({ healthy: [8188, 8000, 8189] })
    const kept = detail(await current.server.callTool(tool, { previewOnly: false, applyFix: true }))
    assert.equal(kept.selectionRequired, undefined)
    assert.equal(kept.configured.connection.port, 8188)
    assert.deepEqual(current.updates, [])
  }
})

test('explicit chosen port overrides a healthy configured port, and an offline choice never substitutes it', async () => {
  for (const tool of tools) {
    const f = serverFixture({ healthy: [8188, 8000] })
    const result = detail(await f.server.callTool(tool, { port: 8000, previewOnly: false, applyFix: true }))
    assert.equal(result.reachable.connection.port, 8000)
    assert.deepEqual(f.updates, [{ port: 8000, previewOnly: false }])
    if (result.assistantMessage) assert.match(result.assistantMessage.join(' '), /updated.*8000/)
    f.updates.length = 0
    const missing = detail(await f.server.callTool(tool, { port: 9000, previewOnly: false, applyFix: true }))
    assert.equal(missing.selectionRequired, true)
    assert.match(missing.summary, /No other server was substituted/)
    assert.deepEqual(f.updates, [])
  }
})

test('explicit chosen target resolves ambiguity but an unavailable choice is never silently substituted', async () => {
  for (const tool of tools) {
    const f = serverFixture({ healthy: [8000, 8189] })
    const result = detail(await f.server.callTool(tool, { port: 8189, previewOnly: false, applyFix: true }))
    assert.equal(result.reachable.connection.port, 8189)
    assert.deepEqual(f.updates, [{ port: 8189, previewOnly: false }])
    f.updates.length = 0
    const missing = detail(await f.server.callTool(tool, { port: 9000, previewOnly: false, applyFix: true }))
    assert.equal(missing.selectionRequired, true); assert.match(missing.summary, /No other server was substituted/)
    assert.deepEqual(f.updates, [])
  }
})

test('extra ports are bounded, validated before probes and timeout is capped', async () => {
  for (const tool of tools) {
    for (const args of [{ candidatePorts: Array(9).fill(8000) }, { candidatePorts: [true] }, { candidatePorts: '8000' },
      { candidatePorts: [65536] }, { port: true }, { port: 'http://example.com:8000' }]) {
      const f = serverFixture()
      assert.equal((await f.server.callTool(tool, args)).isError, true)
      assert.deepEqual(f.diagnoses, []); assert.deepEqual(f.updates, [])
    }
    const f = serverFixture({ healthy: [12345] })
    const result = detail(await f.server.callTool(tool, { candidatePorts: [12345, 12345, 8000], timeoutMs: 999999 }))
    assert.equal(result.reachable.connection.port, 12345)
    assert.equal(f.diagnoses.filter(port => port === 12345).length, 1)
    assert.ok(f.timeouts.every(value => value <= 5000))
  }
})

test('bounded concurrent diagnostics keep deterministic candidate ordering', async () => {
  for (const tool of tools) {
    const f = serverFixture({ healthy: [] })
    const original = f.server.diagnoseComfyUIConnection
    let active = 0, maximum = 0
    f.server.diagnoseComfyUIConnection = async args => {
      active++; maximum = Math.max(maximum, active)
      await new Promise(resolve => setImmediate(resolve))
      try { return await original(args) } finally { active-- }
    }
    const result = detail(await f.server.callTool(tool, { candidatePorts: [9200, 9201, 9202, 9203, 9204, 9205, 9206, 9207] }))
    assert.equal(maximum, 3)
    assert.deepEqual(result.probes.map(value => value.port), [8188, 9200, 9201, 9202, 9203, 9204, 9205, 9206, 9207, 8000, 8189, 8190, 8191, 7860])
  }
})

test('native apply failure after successful discovery remains a tool error, never a claimed connection', async () => {
  for (const tool of tools) {
    const native = nativeFixture(); native.output = null
    const f = serverFixture({ setConnection: native.connect })
    const result = await f.server.callTool(tool, { previewOnly: false, applyFix: true })
    assert.equal(result.isError, true); assert.match(result.content[0].text, /No settings were changed/)
    assert.equal(native.settings.comfyConnection.port, 8188)
    assert.deepEqual(native.calls, [['probe', 8000]])
  }
})

test('agent wrappers retain saved-setting receipt but do not claim connection when renderer synchronization failed', async () => {
  for (const tool of tools) {
    const native = nativeFixture()
    native.dependencies.performMcpRendererAction = async () => ({ success: false, error: 'Renderer unavailable' })
    const f = serverFixture({ setConnection: native.connect })
    const result = detail(await f.server.callTool(tool, { previewOnly: false, applyFix: true }))
    assert.equal(result.settingsApplied, true)
    assert.equal(result.connected, false)
    assert.equal(result.appliedFix ?? result.repaired, false)
    assert.match(result.summary, /setting was saved.*did not synchronize/i)
    assert.match(result.warning, /do not repeat/i)
    const next = result.nextActions || result.recommendations
    assert.match(next.join(' '), /Refresh or reopen/)
    assert.equal(native.settings.comfyConnection.port, 8000)
    assert.equal(native.calls.filter(value => value[0] === 'write').length, 1)
    const update = result.update || result.proposedChange.update
    assert.equal(update.settingsApplied, true)
    assert.equal(update.rendererSync.success, false)
  }
})

test('setup schemas describe bounded discovery, explicit selection and no installation or generation', () => {
  const server = createComfyStudioMcpServer()
  for (const name of [...tools, 'set_comfyui_connection']) {
    const schema = server.tools.find(tool => tool.name === name)
    assert.match(schema.description, /8000|running local ComfyUI/)
    assert.match(schema.description, /not install software/i)
    assert.match(schema.description, /generate media/i)
    assert.equal(schema.inputSchema.properties.port.minimum, 1)
    assert.equal(schema.inputSchema.properties.port.maximum, 65535)
    if (tools.includes(name)) {
      assert.equal(schema.inputSchema.properties.candidatePorts.maxItems, 8)
      assert.equal(schema.inputSchema.properties.timeoutMs.maximum, 5000)
    }
  }
})
