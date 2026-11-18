'use strict'

// Package boundary check, not a claim of a signed/quarantined Mac first launch.
// Reads archived native/preload source and uses only in-memory provider stubs.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path'), os = require('node:os'), vm = require('node:vm')
const { EventEmitter } = require('node:events')
const asar = require('@electron/asar')
const root = path.resolve(__dirname, '..')

test('optional setup service and bridge load from ASAR without probing, authenticating or editing settings', async t => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-optional-setup-asar-'))
  t.after(async () => { asar.uncacheAll(); await fs.rm(output, { recursive: true, force: true }) })
  const staging = path.join(output, 'source'), archive = path.join(output, 'app.asar')
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.build.files.includes('electron/**/*'))
  assert.ok(require('./helpers/nativeExclusions.cjs').onlyReviewedNativeExclusions(pkg.build.files), 'Native exclusions need explicit setup packaging coverage')
  const files = ['electron/optionalSetup.cjs', 'electron/preload.js']
  await fs.mkdir(path.join(staging, 'electron'), { recursive: true })
  for (const filename of files) await fs.copyFile(path.join(root, filename), path.join(staging, filename))
  await asar.createPackage(staging, archive)
  const entries = asar.listPackage(archive).map(value => value.replace(/^[/\\]/, '').replaceAll('\\', '/'))
  for (const filename of files) {
    assert.ok(entries.includes(filename))
    assert.equal(asar.statFile(archive, filename).unpacked, undefined)
  }
  let bridge, currentEvent
  const handlers = new Map(), calls = [], channelCalls = []
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'electronAPI') bridge = value } },
    ipcRenderer: { invoke: (channel, payload) => { channelCalls.push(channel); assert.ok(handlers.has(channel)); return handlers.get(channel)(currentEvent, payload) }, on() {}, removeListener() {} },
  }
  function load(filename) {
    assert.ok(files.includes(filename), 'Only staged source can be loaded')
    const source = asar.extractFile(archive, filename).toString('utf8'), module = { exports: {} }
    const loadDependency = name => { assert.equal(name, 'electron', 'Setup archive must not gain an untested native dependency'); return electron }
    vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: `${archive}/${filename}` })(loadDependency, module, module.exports)
    return module.exports
  }
  const native = load('electron/optionalSetup.cjs')
  load('electron/preload.js')
  assert.equal(typeof bridge.optionalSetup.inspect, 'function')
  const setup = native.createOptionalSetup({
    inspectProvider: async payload => {
      calls.push({ kind: 'provider', ...payload })
      return payload.provider === 'codex'
        ? { available: false, installed: true, signedIn: false, code: 'CODEX_LOGIN_REQUIRED' }
        : { success: true, models: [{ id: 'test-local-model', loaded: true }], loadedModelStatus: 'available' }
    },
    comfySetup: { discoverRunning: async payload => { calls.push({ kind: 'comfy', ...payload }); return [{ port: 8000, deviceNames: ['Synthetic GPU'] }] } },
    getConfiguredPort: async () => 8188,
  })
  const contents = { mainFrame: {}, isDestroyed: () => false }, window = { webContents: contents, isDestroyed: () => false }
  currentEvent = { sender: contents, senderFrame: contents.mainFrame }
  const app = new EventEmitter()
  const controller = native.registerOptionalSetupIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    app, getMainWindow: () => window, setup,
  })
  t.after(() => controller.dispose())
  assert.deepEqual(calls, [], 'Import, construction and registration must be passive')
  assert.equal((await bridge.optionalSetup.inspect({ integration: 'codex' })).state, 'signin')
  assert.deepEqual(calls, [{ kind: 'provider', provider: 'codex' }])
  assert.equal((await bridge.optionalSetup.inspect({ integration: 'lmstudio' })).state, 'ready')
  const comfy = await bridge.optionalSetup.inspect({ integration: 'comfyui' })
  assert.equal(comfy.state, 'unavailable')
  assert.equal(comfy.configuredPort, 8188)
  assert.equal(comfy.connections[0].port, 8000)
  assert.equal((await bridge.optionalSetup.inspect({ integration: 'codex', command: 'login' })).code, 'INVALID_REQUEST')
  assert.equal(calls.length, 3, 'Extra commands must never reach a provider')
  currentEvent = { sender: contents, senderFrame: {} }
  assert.equal((await bridge.optionalSetup.inspect({ integration: 'codex' })).code, 'UNAUTHORIZED')
  assert.equal(calls.length, 3)
  assert.ok(channelCalls.every(channel => channel === native.CHANNEL))
  controller.dispose()
  assert.equal(handlers.size, 0)
})
