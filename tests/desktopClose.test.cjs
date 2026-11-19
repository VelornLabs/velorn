'use strict'
const { test } = require('node:test'), assert = require('node:assert/strict')
const { EventEmitter } = require('node:events'), fs = require('node:fs'), vm = require('node:vm')
const { createDesktopClose } = require('../electron/desktopClose.cjs')
const tick = () => new Promise(resolve => setTimeout(resolve, 8))
const evt = () => ({ prevented: false, preventDefault() { this.prevented = true } })
function fixture(options = {}) {
  const app = new EventEmitter(), ipcMain = new EventEmitter(), win = new EventEmitter(), web = new EventEmitter()
  const records = []; let destroyed = false, saves = 0, pending
  Object.assign(web, { mainFrame: {}, send(channel, request) {
    records.push(channel)
    if (channel !== 'window:prepareClose') return
    saves++; pending = request
    if (!options.noReply) queueMicrotask(() => ipcMain.emit('window:closePrepared', { sender: web, senderFrame: web.mainFrame }, { id: request.id, ok: options.saveOk !== false }))
  } })
  win.webContents = web; win.isDestroyed = () => destroyed
  win.close = () => {
    const event = evt(); win.emit('close', event); if (event.prevented) return
    if (options.veto) { const veto = evt(); web.emit('will-prevent-unload', veto); if (!veto.prevented) return }
    records.push('closed'); destroyed = true; win.emit('closed')
  }
  app.quit = () => { const event = evt(); app.emit('before-quit', event); if (!event.prevented) { records.push('quit'); app.emit('will-quit') } }
  const dialog = {
    async showMessageBox(...args) { records.push(args.at(-1).title); return { response: options.choice ?? 1 } },
    showMessageBoxSync(_win, data) { assert.equal(data.defaultId, 0); assert.equal(data.cancelId, 0); records.push('veto'); return options.confirm ?? 0 },
  }
  const controller = createDesktopClose({ app, ipcMain, dialog, getWindow: () => destroyed ? null : win,
    getOwnedLauncher: () => options.owned, stopOnQuit: () => options.stopOnQuit,
    async detach() { records.push('detach'); return options.cleanup?.() },
    async shutdown() { records.push('stop'); return options.cleanup?.() },
    async flush() { records.push('flush'); return options.flush?.() }, timeoutMs: options.timeoutMs ?? 100,
    platform: options.platform || 'linux', log: { warn() {} },
  })
  controller.attach(win)
  return { win, web, app, ipcMain, records, options, get saves() { return saves }, get pending() { return pending }, get destroyed() { return destroyed } }
}
test('ordinary close saves/flushes before closing and quitting, exactly once', async () => {
  const f = fixture(); f.win.close(); f.win.close(); f.win.close(); await tick()
  assert.equal(f.saves, 1); assert.equal(f.destroyed, true)
  assert.deepEqual(f.records, ['window:prepareClose', 'flush', 'closed', 'quit'])
})
test('hidden-page veto defaults to keep-open; repeated attempts remain usable', async () => {
  const f = fixture({ owned: true, veto: true }); f.win.close(); await tick()
  assert.equal(f.destroyed, false); assert.ok(!f.records.includes('detach'))
  assert.ok(f.records.includes('window:closeCancelled'))
  f.options.confirm = 1; f.win.close(); await tick()
  assert.equal(f.saves, 2); assert.equal(f.destroyed, true)
  assert.ok(f.records.indexOf('detach') > f.records.indexOf('closed'))
})
for (const choice of [0, 1]) test(`launcher option ${choice} is deferred until page consent; Cancel performs neither`, async () => {
  const f = fixture({ owned: true, stopOnQuit: true, choice, veto: true })
  f.win.close(); f.win.close(); await tick()
  assert.equal(f.records.filter(x => x === 'Quit Velorn?').length, 1)
  assert.ok(!f.records.includes('stop')); assert.ok(!f.records.includes('detach'))
  f.options.confirm = 1; f.win.close(); await tick()
  assert.equal(f.records.filter(x => x === (choice === 0 ? 'stop' : 'detach')).length, 1)
})
test('launcher Cancel does not save, close or detach', async () => {
  const f = fixture({ owned: true, stopOnQuit: true, choice: 2 }); f.win.close(); await tick()
  assert.equal(f.saves, 0); assert.equal(f.destroyed, false)
})
test('failed save is visible, leaves launcher untouched, permits retry', async () => {
  const f = fixture({ owned: true, saveOk: false }); f.win.close(); await tick()
  assert.ok(f.records.includes('Velorn is still open')); assert.equal(f.destroyed, false)
  assert.ok(!f.records.includes('detach')); f.options.saveOk = true; f.win.close(); await tick(); assert.equal(f.destroyed, true)
})
test('save timeout is visible; foreign renderer, subframe and stale acknowledgements cannot approve', async () => {
  const f = fixture({ noReply: true, timeoutMs: 12 }); f.win.close(); await tick()
  for (const [sender, senderFrame, id] of [[{}, f.web.mainFrame, f.pending.id], [f.web, {}, f.pending.id], [f.web, f.web.mainFrame, 'stale']]) {
    f.ipcMain.emit('window:closePrepared', { sender, senderFrame }, { id, ok: true })
  }
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.destroyed, false)
  assert.ok(f.records.includes('Velorn is still open')); f.options.noReply = false; f.win.close(); await tick(); assert.equal(f.destroyed, true)
})
test('history flush failure keeps window and ComfyUI open', async () => {
  const f = fixture({ owned: true, flush() { throw Error('disk full') } }); f.win.close(); await tick()
  assert.equal(f.destroyed, false); assert.ok(!f.records.includes('detach'))
})
test('app Quit cancellation never emits final shutdown; later approval does', async () => {
  const f = fixture({ owned: true, veto: true }); let disposed = 0; f.app.on('will-quit', () => disposed++)
  f.app.quit(); await tick(); assert.equal(disposed, 0); assert.equal(f.destroyed, false)
  f.options.confirm = 1; f.app.quit(); await tick(); assert.equal(disposed, 1)
})
test('pending cleanup keeps app alive without repeating action', async () => {
  let finish; const f = fixture({ owned: true, cleanup: () => new Promise(resolve => { finish = resolve }) })
  f.win.close(); await tick(); f.app.quit(); f.app.quit(); assert.ok(!f.records.includes('quit'))
  finish({ detached: true }); await tick(); assert.equal(f.records.filter(x => x === 'detach').length, 1)
  assert.equal(f.records.filter(x => x === 'quit').length, 1)
})
test('failed cleanup is reported once without silently force-stopping or retrying', async () => {
  const f = fixture({ owned: true, cleanup() { throw Error('failed') } }); f.win.close(); await tick()
  assert.ok(f.records.includes('Check ComfyUI')); assert.equal(f.records.filter(x => x === 'detach').length, 1); assert.ok(f.records.includes('quit'))
})
test('unrelated reload veto is not overridden', () => {
  const f = fixture(); const event = evt(); f.web.emit('will-prevent-unload', event)
  assert.equal(event.prevented, false); assert.deepEqual(f.records, [])
})
test('mac window-close remains resident, explicit Quit still exits', async () => {
  const f = fixture({ platform: 'darwin' }); f.win.close(); await tick(); assert.equal(f.destroyed, true); assert.ok(!f.records.includes('quit'))
  f.app.quit(); assert.ok(f.records.includes('quit'))
})
test('preload acknowledges only finished saves, catches failure, unregisters callbacks', async () => {
  const renderer = new EventEmitter(), exposed = {}, sent = []
  renderer.invoke = () => Promise.resolve(); renderer.sendSync = () => ({}); renderer.send = (...args) => sent.push(args)
  vm.runInNewContext(fs.readFileSync(require.resolve('../electron/preload.js'), 'utf8'), {
    process: { platform: 'linux' }, require: () => ({ ipcRenderer: renderer, contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } } }),
  })
  let finish; const off = exposed.electronAPI.onPrepareClose(() => new Promise(resolve => { finish = resolve }))
  renderer.emit('window:prepareClose', {}, { id: 'one' }); assert.equal(sent.length, 0)
  finish(true); await tick(); assert.equal(sent[0][1].ok, true); assert.equal(sent[0][1].id, 'one'); off()
  exposed.electronAPI.onPrepareClose(() => { throw Error('save failed') })
  renderer.emit('window:prepareClose', {}, { id: 'two' }); await tick(); assert.equal(sent[1][1].ok, false)
  let cancelled = false; const cancelOff = exposed.electronAPI.onCloseCancelled(() => { cancelled = true })
  renderer.emit('window:closeCancelled'); assert.equal(cancelled, true); cancelOff(); assert.equal(renderer.listenerCount('window:closeCancelled'), 0)
})
test('renderer save waits, suppresses duplicate unload save, resets after Cancel', async () => {
  const { registerDesktopClose } = await import('../src/services/desktopClose.js')
  let prepare, cancel, saves = 0, finish; const target = new EventTarget()
  const off = registerDesktopClose({ api: { onPrepareClose(cb) { prepare = cb }, onCloseCancelled(cb) { cancel = cb } }, target,
    getProjectState: () => ({ currentProject: {}, saveProject: () => { saves++; return new Promise(resolve => { finish = resolve }) } }) })
  const result = prepare(); await tick(); assert.equal(saves, 1); finish(true); assert.equal(await result, true)
  target.dispatchEvent(new Event('beforeunload')); await tick(); assert.equal(saves, 1)
  cancel(); const second = prepare(); await tick(); finish(true); await second; assert.equal(saves, 2); off()
})
test('renderer welcome screen closes without a project; failed project save stays false', async () => {
  const { registerDesktopClose } = await import('../src/services/desktopClose.js')
  for (const state of [{ currentProject: null }, { currentProject: {}, saveProject: async () => false }]) {
    let prepare; const off = registerDesktopClose({ api: { onPrepareClose(cb) { prepare = cb } }, target: new EventTarget(), getProjectState: () => state })
    assert.equal(await prepare(), !state.currentProject); off()
  }
})
test('cancellable before-quit has no destructive cleanup listeners in product modules', () => {
  for (const file of fs.readdirSync(require('node:path').join(__dirname, '../electron')).filter(f => /\.(cjs|js)$/.test(f) && f !== 'desktopClose.cjs')) {
    const source = fs.readFileSync(require('node:path').join(__dirname, '../electron', file), 'utf8')
    assert.doesNotMatch(source, /(?:on|once)\??\.?\(\s*['"]before-quit['"]/, file)
  }
})
