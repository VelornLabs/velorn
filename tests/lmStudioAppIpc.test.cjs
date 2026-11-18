'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm')
const { CHANNEL, registerLmStudioAppIpc } = require('../electron/lmStudioAppIpc.cjs')
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const surface = () => {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  return Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false })
}
function fixture({ register = registerLmStudioAppIpc, outcomes = {}, missing = false } = {}) {
  const handlers = new Map(), calls = [], effects = [], app = new EventEmitter()
  let window = surface(), hold = null, thrown = null
  const initialWindow = window, contents = window.webContents
  const installedApps = Object.fromEntries(['open', 'choose'].map(action => [action, async (payload, guard) => {
    calls.push({ action, payload, guard })
    if (hold) await hold.promise
    if (thrown) throw thrown
    if (!guard.isCurrent()) return { ok: false, status: 'stale', summary: '/private/stale' }
    const outcome = outcomes[action] || { ok: true, status: action === 'open' ? 'opened' : 'selected', summary: '/private/path' }
    if (outcome.ok) effects.push(action)
    return outcome
  }]))
  const controller = register({ app, getMainWindow: () => window, installedApps: missing ? {} : installedApps,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback), removeHandler: name => handlers.delete(name) } })
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const handler = handlers.get(CHANNEL)
  return { app, contents, initialWindow, event, handler, handlers, calls, effects, controller,
    call: (payload = { action: 'open' }, source = event) => handler(source, payload),
    hold: () => { hold = defer(); return hold }, throw: error => { thrown = error },
    replaceWindow: () => { window = surface() }, replaceContents: () => { window.webContents = surface().webContents },
    currentEvent: () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame }),
  }
}

test('registration is passive and exposes exactly one desktop action channel', t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  assert.deepEqual([...f.handlers.keys()], [CHANNEL]); assert.deepEqual(f.calls, []); assert.deepEqual(f.effects, [])
})

test('only current main-window/main-frame callers reach app controls', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  for (const event of [undefined, {}, { sender: {}, senderFrame: f.contents.mainFrame }, { sender: f.contents, senderFrame: {} }]) {
    assert.equal((await f.handler(event, { action: 'open' })).code, 'LM_STUDIO_APP_UNAUTHORIZED')
  }
  assert.deepEqual(f.calls, [])
})

test('exact enum schema rejects injected URLs, paths, models, guards and setup actions', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  for (const payload of [null, [], {}, { action: 'inspect' }, { action: 'download' }, { action: 'load' }, { action: 'open_app' },
    { action: 'open', integration: 'lmstudio' }, { action: 'open', path: '/private/app' }, { action: 'choose', url: 'https://example.test' },
    { action: 'open', model: 'model' }, { action: 'open', isCurrent: true }, { action: 'choose', args: [] }]) {
    assert.equal((await f.call(payload)).code, 'LM_STUDIO_APP_INVALID_REQUEST')
  }
  assert.deepEqual(f.calls, [])
})

test('open and choose delegate fixed integration and native-owned current guard without leaking outcome fields', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const opened = await f.call(), selected = await f.call({ action: 'choose' })
  assert.equal(opened.success, true); assert.equal(opened.opened, true); assert.equal(opened.cancelled, false)
  assert.match(opened.summary, /saved startup preferences/); assert.match(opened.summary, /did not request a model download, load or prompt/)
  assert.deepEqual({ success: selected.success, opened: selected.opened, cancelled: selected.cancelled }, { success: true, opened: false, cancelled: false })
  assert.match(selected.summary, /has not been opened or connected/)
  assert.deepEqual(f.calls.map(({ action, payload }) => ({ action, payload })), [
    { action: 'open', payload: { integration: 'lmstudio' } }, { action: 'choose', payload: { integration: 'lmstudio' } },
  ])
  assert.ok(f.calls.every(({ guard }) => typeof guard.isCurrent === 'function' && guard.isCurrent()))
  assert.doesNotMatch(JSON.stringify([opened, selected]), /private|path|ready/i)
})

test('native cancellation is a non-opening success receipt without exposing raw summaries', async t => {
  const f = fixture({ outcomes: { open: { ok: false, status: 'cancelled', summary: 'PRIVATE_SECRET' } } }); t.after(() => f.controller.dispose())
  assert.deepEqual(await f.call(), { success: true, opened: false, cancelled: true, summary: 'Cancelled. No app was opened or selected.' })
  assert.deepEqual(f.effects, [])
})

test('failures and malformed/cross-action receipts stay sanitized and never imply success', async () => {
  for (const outcome of [undefined, { ok: false, status: 'unavailable' }, { ok: false, status: 'failed' },
    { ok: true, status: 'selected' }, { ok: true, status: 'cancelled' }, { ok: 'true', status: 'opened' }]) {
    const f = fixture({ outcomes: { open: outcome || { summary: 'PRIVATE_SECRET' } } })
    try {
      const result = await f.call(); assert.equal(result.success, false); assert.equal(result.code, 'LM_STUDIO_APP_FAILED')
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET/)
    } finally { f.controller.dispose() }
  }
  for (const [status, code] of [['busy', 'LM_STUDIO_APP_BUSY'], ['changed', 'LM_STUDIO_APP_CHANGED'], ['stale', 'LM_STUDIO_APP_CANCELLED']]) {
    const f = fixture({ outcomes: { open: { ok: false, status, summary: 'PRIVATE_SECRET' } } })
    try { assert.equal((await f.call()).code, code) } finally { f.controller.dispose() }
  }
})

test('unavailable dependency and thrown errors fail closed without raw path/credential disclosure', async t => {
  const missing = fixture({ missing: true }); t.after(() => missing.controller.dispose())
  assert.equal((await missing.call()).code, 'LM_STUDIO_APP_UNAVAILABLE'); assert.deepEqual(missing.calls, [])
  const f = fixture(); t.after(() => f.controller.dispose()); f.throw(new Error('/private/path PRIVATE_SECRET'))
  const result = await f.call(); assert.equal(result.success, false); assert.doesNotMatch(JSON.stringify(result), /private|SECRET/)
})

test('busy serialization blocks duplicate native controls until the first action settles', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); const gate = f.hold()
  const first = f.call(); assert.equal((await f.call({ action: 'choose' })).code, 'LM_STUDIO_APP_BUSY'); assert.equal(f.calls.length, 1)
  gate.resolve(); assert.equal((await first).opened, true); assert.equal((await f.call({ action: 'choose' })).success, true)
})

for (const boundary of ['navigation', 'renderer-loss', 'contents-destroyed', 'window-closed', 'window-replaced', 'contents-replaced', 'frame-replaced', 'quit', 'dispose']) {
  test(`${boundary} invalidates pending native approval/selection and suppresses late success`, async t => {
    const f = fixture(); t.after(() => f.controller.dispose()); const gate = f.hold(), pending = f.call()
    if (boundary === 'navigation') f.contents.emit('did-start-navigation', {}, 'https://example.test', false, true)
    else if (boundary === 'renderer-loss') f.contents.emit('render-process-gone')
    else if (boundary === 'contents-destroyed') f.contents.emit('destroyed')
    else if (boundary === 'window-closed') f.initialWindow.emit('closed')
    else if (boundary === 'window-replaced') f.replaceWindow()
    else if (boundary === 'contents-replaced') f.replaceContents()
    else if (boundary === 'frame-replaced') f.contents.mainFrame = {}
    else if (boundary === 'quit') f.app.emit('will-quit')
    else f.controller.dispose()
    assert.equal(f.calls[0].guard.isCurrent(), false); gate.resolve()
    assert.equal((await pending).code, 'LM_STUDIO_APP_CANCELLED'); assert.deepEqual(f.effects, [])
  })
}

test('subframe and in-place navigation preserve current approval while replacement cannot borrow it', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); const gate = f.hold(), pending = f.call()
  f.contents.emit('did-start-navigation', {}, 'unused', false, false); f.contents.emit('did-start-navigation', {}, 'unused', true, true)
  assert.equal(f.calls[0].guard.isCurrent(), true)
  f.replaceWindow(); assert.equal((await f.call({ action: 'choose' }, f.currentEvent())).code, 'LM_STUDIO_APP_BUSY')
  gate.resolve(); assert.equal((await pending).code, 'LM_STUDIO_APP_CANCELLED')
  assert.equal((await f.call({ action: 'choose' }, f.currentEvent())).success, true)
})

test('quit and repeated disposal remove handlers/listeners and deny retained callback calls', async () => {
  const f = fixture(); await f.call(); assert.ok(f.contents.listenerCount('did-start-navigation'))
  f.app.emit('will-quit'); f.controller.dispose()
  assert.equal(f.handlers.size, 0); assert.equal(f.contents.eventNames().length, 0); assert.equal(f.initialWindow.eventNames().length, 0)
  assert.equal(f.app.listenerCount('will-quit'), 0); assert.equal((await f.call()).code, 'LM_STUDIO_APP_UNAUTHORIZED')
})

test('ASAR/native/preload boundary stays passive and gates fixed app controls on a live user gesture', async t => {
  const asar = require('@electron/asar'), root = path.resolve(__dirname, '..')
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-lmstudio-app-asar-'))
  t.after(async () => { asar.uncacheAll(); await fs.rm(output, { recursive: true, force: true }) })
  const staging = path.join(output, 'source'), archive = path.join(output, 'app.asar')
  const files = ['electron/lmStudioAppIpc.cjs', 'electron/preload.js']
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.build.files.includes('electron/**/*'))
  // Private engine experiments are intentionally excluded; the actual LM
  // Studio controller and bridge must still be included by the package rules.
  const minimatch = require('minimatch'), match = minimatch.minimatch || minimatch
  for (const file of files) assert.ok(!pkg.build.files.some(value => value.startsWith('!') && match(file, value.slice(1))), file)
  await fs.mkdir(path.join(staging, 'electron'), { recursive: true })
  for (const filename of files) await fs.copyFile(path.join(root, filename), path.join(staging, filename))
  await asar.createPackage(staging, archive)
  let bridge, invoke
  const channelCalls = [], activation = { isActive: false }
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'electronAPI') bridge = value } },
    ipcRenderer: { invoke: (channel, payload) => { channelCalls.push({ channel, payload }); return invoke(channel, payload) }, on() {}, removeListener() {} } }
  function load(filename) {
    assert.equal(asar.statFile(archive, filename).unpacked, undefined)
    const module = { exports: {} }
    vm.runInNewContext(`(function(require,module,exports){${asar.extractFile(archive, filename).toString('utf8')}\n})`,
      { navigator: { userActivation: activation }, process: { platform: 'linux' } }, { filename: `${archive}/${filename}` })(
      dependency => { assert.equal(dependency, 'electron'); return electron }, module, module.exports)
    return module.exports
  }
  const native = load(files[0]); load(files[1])
  const f = fixture({ register: native.registerLmStudioAppIpc }); t.after(() => f.controller.dispose())
  invoke = (channel, payload) => { assert.equal(channel, native.CHANNEL); return f.call(payload) }
  assert.deepEqual(Object.keys(bridge.lmStudioApp), ['performAction']); assert.deepEqual(f.calls, []); assert.deepEqual(channelCalls, [])
  await assert.rejects(bridge.lmStudioApp.performAction({ action: 'open' }), /yourself/)
  assert.deepEqual(channelCalls, []); activation.isActive = true
  assert.equal((await bridge.lmStudioApp.performAction({ action: 'choose' })).success, true)
  assert.equal((await bridge.lmStudioApp.performAction({ action: 'open', model: 'forbidden' })).code, 'LM_STUDIO_APP_INVALID_REQUEST')
  activation.isActive = false
  await assert.rejects(bridge.lmStudioApp.performAction({ action: 'open', userActivation: true }), /yourself/)
  assert.equal(f.calls.length, 1)
  const main = await fs.readFile(path.join(root, 'electron/main.js'), 'utf8')
  assert.match(main, /registerLmStudioAppIpc\(\{ ipcMain, app, getMainWindow: \(\) => mainWindow, installedApps: setupInstalledApps \}\)/)
})
