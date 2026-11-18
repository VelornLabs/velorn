const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const vm = require('node:vm')
const { createViewerPresentation, registerViewerPresentationIpc } = require('../electron/viewerPresentation.cjs')

const originalBounds = { x: 70, y: 90, width: 1000, height: 700 }
const screenBounds = { x: 0, y: 0, width: 1920, height: 1080 }
class FakeWindow extends EventEmitter {
  constructor({ maximized = false, fullscreen = false, simple = false, manual = false } = {}) {
    super()
    this.maximized = maximized
    this.fullscreen = fullscreen
    this.simple = simple
    this.manual = manual
    this.bounds = { ...originalBounds }
    this.calls = []
    this.pending = []
    this.webContents = new EventEmitter()
    this.webContents.mainFrame = { routingId: 1, processId: 10 }
  }
  isDestroyed() { return Boolean(this.destroyed) }
  isFullScreen() { return this.fullscreen }
  isSimpleFullScreen() { return this.simple }
  isMaximized() { return this.maximized }
  getBounds() { return { ...this.bounds } }
  getNormalBounds() { return { ...this.bounds } }
  setBounds(bounds) { this.calls.push(['bounds', bounds]); this.bounds = { ...bounds } }
  maximize() { this.calls.push(['maximize']); this.maximized = true }
  unmaximize() { this.calls.push(['unmaximize']); this.maximized = false }
  isMinimized() { return Boolean(this.minimized) }
  minimize() { this.calls.push(['minimize']); this.minimized = true }
  setSimpleFullScreen(flag) {
    this.calls.push(['simple', flag]); this.simple = flag
    if (flag) this.bounds = { ...screenBounds }
  }
  setFullScreen(flag) {
    this.calls.push(['native', flag])
    if (this.manual) this.pending.push(flag)
    else this.finishNative(flag)
  }
  finishNative(flag = this.pending.shift()) {
    this.fullscreen = flag
    if (flag) this.bounds = { ...screenBounds }
    this.emit(flag ? 'enter-full-screen' : 'leave-full-screen')
  }
  close() { this.emit('close'); this.destroyed = true; this.emit('closed') }
}
function harness(options = {}) {
  const window = new FakeWindow(options)
  const changes = [], errors = [], restored = []
  const controller = createViewerPresentation({ window, platform: options.platform || 'darwin',
    onChange: value => changes.push(value), onError: value => errors.push(value), onRestored: () => restored.push(true),
    transitionTimeoutMs: options.transitionTimeoutMs || 100,
  })
  return { window, controller, changes, errors, restored }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

function windowControls(h) {
  const source = fs.readFileSync(require.resolve('../electron/main.js'), 'utf8')
  const controlsSource = source.slice(source.indexOf('registerViewerPresentationIpc(ipcMain, () => viewerPresentation)'), source.indexOf('// Register custom protocol for serving local files'))
  const handlers = new Map()
  const context = vm.createContext({ mainWindow: h.window, viewerPresentation: h.controller,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, registerViewerPresentationIpc,
    restoreFullscreenAfterMinimize: false, setTimeout() {},
    getWindowState: () => ({ isFullScreen: h.window.isFullScreen(), isMaximized: h.window.isMaximized() }),
  })
  vm.runInContext(controlsSource, context)
  return { context, invoke: name => handlers.get(name)() }
}

test('macOS presentation uses simple fullscreen only and restores normal window geometry', async () => {
  const h = harness()
  assert.deepEqual(await h.controller.setEnabled(true), { active: true, revision: 1 })
  assert.deepEqual(h.window.calls, [['simple', true]])
  assert.deepEqual(h.controller.getPersistentWindowState(), { bounds: originalBounds, isMaximized: false })
  assert.deepEqual(await h.controller.setEnabled(false), { active: false, revision: 2 })
  assert.deepEqual(h.window.calls, [['simple', true], ['simple', false], ['bounds', originalBounds]])
  assert.equal(h.controller.getPersistentWindowState(), null)
  assert.equal(h.restored.length, 1)
})

test('each platform restores original maximized state without saving presentation geometry', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const h = harness({ platform, maximized: true })
    await h.controller.setEnabled(true)
    const saved = h.controller.getPersistentWindowState()
    assert.deepEqual(saved, { bounds: originalBounds, isMaximized: true })
    saved.bounds.x = 999
    assert.equal(h.controller.getPersistentWindowState().bounds.x, 70)
    await h.controller.setEnabled(false)
    assert.equal(h.window.maximized, true)
    assert.deepEqual(h.window.bounds, originalBounds)
    assert.deepEqual(h.window.calls.map(call => call[0]), [platform === 'darwin' ? 'simple' : 'native', platform === 'darwin' ? 'simple' : 'native', 'unmaximize', 'bounds', 'maximize'])
  }
})

test('an existing app fullscreen Space or simple fullscreen remains untouched', async () => {
  for (const options of [{ platform: 'darwin', fullscreen: true }, { platform: 'darwin', simple: true }, { platform: 'win32', fullscreen: true }, { platform: 'linux', fullscreen: true }]) {
    const h = harness(options)
    await h.controller.setEnabled(true)
    await h.controller.setEnabled(false)
    assert.deepEqual(h.window.calls, [])
    assert.equal(h.window.fullscreen, Boolean(options.fullscreen))
    assert.equal(h.window.simple, Boolean(options.simple))
  }
})

test('repeated enable and disable are idempotent and getter snapshots are immutable', async () => {
  const h = harness()
  const first = h.controller.setEnabled(true)
  const second = h.controller.setEnabled(true)
  await Promise.all([first, second])
  assert.deepEqual(h.controller.getState(), { active: true, revision: 1 })
  h.controller.getState().active = false
  assert.equal(h.controller.getState().active, true)
  await Promise.all([h.controller.setEnabled(false), h.controller.setEnabled(false)])
  assert.deepEqual(h.changes.map(state => [state.active, state.revision]), [[true, 1], [false, 2]])
})

test('entry cancelled before native work starts never changes the native window', async () => {
  const h = harness()
  await Promise.all([h.controller.setEnabled(true), h.controller.setEnabled(false)])
  assert.deepEqual(h.window.calls, [])
  assert.deepEqual(h.controller.getState(), { active: false, revision: 2 })
})

test('exit during async native entry waits before restoring and never broadcasts stale entry', async () => {
  const h = harness({ platform: 'win32', manual: true })
  const entry = h.controller.setEnabled(true)
  await flush()
  const exit = h.controller.setEnabled(false)
  assert.deepEqual(h.controller.getState(), { active: false, revision: 2 })
  assert.deepEqual(h.controller.getPersistentWindowState().bounds, originalBounds)
  h.window.finishNative()
  await entry
  await flush()
  assert.deepEqual(h.window.calls, [['native', true], ['native', false]])
  h.window.finishNative()
  await exit
  assert.deepEqual(h.window.bounds, originalBounds)
  assert.equal(h.changes.some(value => value.active), false)
})

test('entry arriving during async restoration survives the expected native leave event', async () => {
  const h = harness({ platform: 'linux', manual: true })
  const first = h.controller.setEnabled(true)
  await flush(); h.window.finishNative(); await first
  const exit = h.controller.setEnabled(false)
  await flush()
  const reentry = h.controller.setEnabled(true)
  h.window.finishNative()
  await exit; await flush()
  h.window.finishNative()
  assert.deepEqual(await reentry, { active: true, revision: 3 })
  assert.deepEqual(h.window.calls.map(call => call[0]), ['native', 'native', 'bounds', 'native'])
})

test('Escape notifies the renderer and restores without touching ordinary app fullscreen', async () => {
  const h = harness({ fullscreen: true })
  let prevented = 0
  const event = { preventDefault: () => prevented++ }
  h.window.webContents.emit('before-input-event', event, { key: 'Escape', type: 'keyDown' })
  assert.equal(prevented, 0)
  await h.controller.setEnabled(true)
  h.window.webContents.emit('before-input-event', event, { key: 'Escape', type: 'keyDown' })
  await flush()
  assert.equal(prevented, 1)
  assert.equal(h.changes.at(-1).reason, 'escape')
  assert.equal(h.controller.getState().active, false)
  assert.equal(h.window.fullscreen, true)
  assert.deepEqual(h.window.calls, [])
})

test('native fullscreen exit notifies the renderer and restores geometry', async () => {
  const h = harness({ platform: 'win32' })
  await h.controller.setEnabled(true)
  h.window.finishNative(false)
  await flush()
  assert.equal(h.changes.at(-1).reason, 'native-exit')
  assert.equal(h.controller.getState().active, false)
  assert.deepEqual(h.window.bounds, originalBounds)
})

test('HTML exit, navigation, crash, destroyed renderer and cancelled close clean up presentation', async () => {
  for (const [target, event, args] of [
    ['webContents', 'leave-html-full-screen', []],
    ['webContents', 'did-start-navigation', [{}, 'file:///index.html', false, true]],
    ['webContents', 'render-process-gone', [{}, { reason: 'crashed' }]],
    ['webContents', 'destroyed', []],
    ['window', 'close', []],
  ]) {
    const h = harness()
    await h.controller.setEnabled(true)
    ;(target === 'window' ? h.window : h.window.webContents).emit(event, ...args)
    await flush()
    assert.equal(h.controller.getState().active, false, event)
    assert.equal(h.window.simple, false, event)
    assert.deepEqual(h.window.bounds, originalBounds, event)
  }
})

test('subframe navigation, same-document navigation and non-Escape input do not exit', async () => {
  const h = harness()
  await h.controller.setEnabled(true)
  h.window.webContents.emit('did-start-navigation', {}, 'https://example.com', false, false)
  h.window.webContents.emit('did-start-navigation', {}, '#anchor', true, true)
  h.window.webContents.emit('before-input-event', {}, { key: 'Escape', type: 'keyUp' })
  h.window.webContents.emit('before-input-event', {}, { key: 'Space', type: 'keyDown' })
  await flush()
  assert.equal(h.controller.getState().active, true)
})

test('closed windows dispose lifecycle listeners and cancel in-flight entry safely', async () => {
  const h = harness({ platform: 'linux', manual: true })
  const entry = h.controller.setEnabled(true)
  await flush()
  h.window.close()
  await entry
  await flush()
  assert.equal(h.controller.getState().active, false)
  assert.equal(h.window.webContents.listenerCount('before-input-event'), 0)
  assert.equal(h.window.listenerCount('leave-full-screen'), 0)
  assert.deepEqual(h.window.calls, [['native', true]])
  assert.equal((await h.controller.setEnabled(true)).active, false)
})

test('entry failure rolls native state back and a later entry remains usable', async () => {
  const h = harness()
  const original = h.window.setSimpleFullScreen.bind(h.window)
  let fail = true
  h.window.setSimpleFullScreen = flag => { original(flag); if (flag && fail) throw new Error('Synthetic entry failure') }
  await assert.rejects(h.controller.setEnabled(true), /Synthetic entry failure/)
  assert.equal(h.controller.getState().active, false)
  assert.equal(h.window.simple, false)
  assert.deepEqual(h.window.bounds, originalBounds)
  assert.equal((await h.controller.setEnabled(false)).active, false)
  fail = false
  assert.equal((await h.controller.setEnabled(true)).active, true)
})

test('timed-out native entry is explicitly cancelled before late native events can complete', async () => {
  const h = harness({ platform: 'linux', manual: true, transitionTimeoutMs: 10 })
  const entry = h.controller.setEnabled(true)
  const rejected = assert.rejects(entry, /Timed out/)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.deepEqual(h.window.calls, [['native', true], ['native', false]])
  h.window.finishNative()
  h.window.finishNative()
  await rejected
  assert.equal(h.window.fullscreen, false)
  assert.deepEqual(h.window.bounds, originalBounds)
  assert.equal((await h.controller.setEnabled(false)).active, false)
})

test('main window persistence uses saved normal bounds and maximized state during presentation', async () => {
  const source = fs.readFileSync(require.resolve('../electron/main.js'), 'utf8')
  const saveSource = source.slice(source.indexOf('async function saveMainWindowStateNow()'), source.indexOf('function scheduleSaveMainWindowState()'))
  for (const maximized of [false, true]) {
    const h = harness({ maximized })
    h.window.isMinimized = () => false
    await h.controller.setEnabled(true)
    let settings, displayBounds
    const context = vm.createContext({ mainWindow: h.window, viewerPresentation: h.controller,
      sanitizeWindowBounds: value => value, MAIN_WINDOW_STATE_SETTING_KEY: 'mainWindowState',
      screen: { getDisplayMatching: bounds => { displayBounds = bounds; return { id: 42 } } },
      writeSettingsRaw: async update => { settings = update({}) }, Date, console,
    })
    vm.runInContext(saveSource, context)
    await context.saveMainWindowStateNow()
    assert.deepEqual(settings.mainWindowState.bounds, originalBounds)
    assert.equal(settings.mainWindowState.isMaximized, maximized)
    assert.deepEqual(displayBounds, originalBounds)
  }
})

test('restoration failure retains original persistent bounds and can be retried', async () => {
  const h = harness()
  await h.controller.setEnabled(true)
  const original = h.window.setSimpleFullScreen.bind(h.window)
  h.window.setSimpleFullScreen = () => { throw new Error('Synthetic exit failure') }
  await assert.rejects(h.controller.setEnabled(false), /Synthetic exit failure/)
  assert.deepEqual(h.controller.getPersistentWindowState().bounds, originalBounds)
  h.window.setSimpleFullScreen = original
  await h.controller.setEnabled(false)
  assert.equal(h.controller.getPersistentWindowState(), null)
  assert.equal(h.window.simple, false)
})

test('native IPC accepts only strict boolean requests from the editor top frame', async () => {
  const h = harness()
  const handlers = new Map()
  registerViewerPresentationIpc({ handle: (name, fn) => handlers.set(name, fn) }, () => h.controller)
  const event = { sender: h.window.webContents, senderFrame: h.window.webContents.mainFrame }
  const set = handlers.get('viewer:setPresentation'), get = handlers.get('viewer:getPresentation')
  assert.deepEqual(get(event), { active: false, revision: 0 })
  for (const foreign of [{ sender: {}, senderFrame: event.senderFrame }, { sender: event.sender, senderFrame: {} }, { sender: event.sender }]) {
    assert.throws(() => set(foreign, { enabled: true }), /main frame/)
    assert.throws(() => get(foreign), /main frame/)
  }
  for (const request of [undefined, null, {}, { enabled: 'true' }, { enabled: 1 }]) assert.throws(() => set(event, request), /boolean/)
  assert.equal((await set(event, { enabled: true })).active, true)
  h.window.destroyed = true
  assert.throws(() => get(event), /main frame/)
})

test('preload forwards viewer state without Electron event and removes the exact listener', async () => {
  const preload = fs.readFileSync(require.resolve('../electron/preload.js'), 'utf8')
  const exposed = {}, calls = []
  const ipcRenderer = new EventEmitter()
  ipcRenderer.invoke = async (...args) => { calls.push(args); return { active: true, revision: 1 } }
  vm.runInNewContext(preload, { require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } }, ipcRenderer }), process: { platform: 'darwin' }, console })
  const api = exposed.electronAPI
  await api.setViewerPresentation({ enabled: true }); await api.getViewerPresentation()
  assert.deepEqual(calls, [['viewer:setPresentation', { enabled: true }], ['viewer:getPresentation']])
  const changes = [], dispose = api.onViewerPresentationChanged(value => changes.push(value))
  const state = { active: false, revision: 2 }
  ipcRenderer.emit('viewer:presentationChanged', { sender: 'private' }, state)
  assert.deepEqual(changes, [state])
  dispose()
  assert.equal(ipcRenderer.listenerCount('viewer:presentationChanged'), 0)
})

test('ordinary minimize first exits viewer presentation and does not restore viewer-owned fullscreen later', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const h = harness({ platform })
    const controls = windowControls(h)
    await h.controller.setEnabled(true)
    assert.equal(await controls.invoke('window:minimize'), true)
    assert.equal(h.controller.getState().active, false)
    assert.equal(h.window.simple, false)
    assert.equal(h.window.fullscreen, false)
    assert.equal(h.window.minimized, true)
    assert.equal(controls.context.restoreFullscreenAfterMinimize, false)
    assert.deepEqual(h.window.calls.at(-1), ['minimize'])
  }
})

test('ordinary maximize/fullscreen controls restore viewer state before applying their own operation', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const action of ['window:toggleMaximize', 'window:toggleFullScreen']) {
      const h = harness({ platform })
      const controls = windowControls(h)
      await h.controller.setEnabled(true)
      assert.equal(await controls.invoke(action), true)
      assert.equal(h.controller.getState().active, false)
      assert.equal(h.window.simple, false)
      assert.equal(h.controller.getPersistentWindowState(), null)
      assert.deepEqual(h.window.calls.at(-1), action === 'window:toggleMaximize' ? ['maximize'] : ['native', true])
    }
  }
})

test('existing ordinary fullscreen retains its minimize/restore contract after viewer exit', async () => {
  const h = harness({ fullscreen: true })
  const controls = windowControls(h)
  await h.controller.setEnabled(true)
  assert.equal(await controls.invoke('window:minimize'), true)
  assert.equal(controls.context.restoreFullscreenAfterMinimize, true)
  assert.deepEqual(h.window.calls, [['native', false], ['minimize']])
})

test('window controls wait for in-flight viewer entry and reject unsafe restoration failures', async () => {
  const h = harness({ platform: 'win32', manual: true })
  const controls = windowControls(h)
  const entry = h.controller.setEnabled(true)
  await flush()
  const minimized = controls.invoke('window:minimize')
  h.window.finishNative()
  await entry; await flush()
  assert.equal(h.window.minimized, undefined)
  h.window.finishNative()
  assert.equal(await minimized, true)
  assert.equal(controls.context.restoreFullscreenAfterMinimize, false)

  const failed = harness(), failedControls = windowControls(failed)
  await failed.controller.setEnabled(true)
  failed.window.setSimpleFullScreen = () => { throw new Error('Synthetic restoration failure') }
  await assert.rejects(failedControls.invoke('window:minimize'), /Synthetic restoration failure/)
  assert.equal(failed.window.minimized, undefined)
})

test('window controls return false when the target closes or changes during viewer restoration', async () => {
  for (const action of ['window:minimize', 'window:toggleMaximize', 'window:toggleFullScreen']) {
    const h = harness()
    const controls = windowControls(h)
    controls.context.mainWindow = null
    assert.equal(await controls.invoke(action), false)
    controls.context.mainWindow = h.window
    controls.context.viewerPresentation = { async setEnabled() { controls.context.mainWindow = new FakeWindow() } }
    assert.equal(await controls.invoke(action), false)
    assert.deepEqual(h.window.calls, [])
  }
})
