'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { registerCodexSetupInstallerIpc, CHANNELS } = require('../electron/codexSetupInstallerIpc.cjs')
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture() {
  const handlers = new Map(), calls = [], cancellations = [], approvals = []; let disposed = false, busy = false, hold = null, approve = true
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  let window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false })
  const app = Object.assign(new EventEmitter(), { getPath: () => '/synthetic/home' })
  const controller = registerCodexSetupInstallerIpc({ app, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    getMainWindow: () => window, inspectExisting: async () => false, isBusy: () => busy,
    dialog: { showMessageBox: async (w, config) => { approvals.push({ w, config }); if (hold) await hold.promise; return { response: approve ? 1 : 0 } } },
    createManager: deps => ({
      plan: async (args, owner) => { calls.push(['plan', args, owner]); await deps.assertCurrent(owner, 'plan'); return { success: true, planId: 'fixture-plan' } },
      install: async (args, owner) => { calls.push(['install', args, owner]); const approved = await deps.confirm({ owner, version: 'fixture', source: 'https://github.com/openai/codex/releases/download/fixture/codex.tar.gz', bytes: 123, destination: '/synthetic/codex' }); return { success: true, approved } },
      status: async (args, owner) => { calls.push(['status', args, owner]); return { success: true } },
      cancel: async (args, owner) => { calls.push(['cancel', args, owner]); return { success: true } },
      cancelOwner: owner => cancellations.push(owner), dispose: () => { disposed = true },
    }),
  })
  const event = { sender: contents, senderFrame: contents.mainFrame }
  return { app, contents, event, calls, cancellations, approvals, handlers, controller,
    call: (method, args = {}, source = event) => handlers.get(CHANNELS[method])(source, args),
    setBusy: value => { busy = value }, hold: () => { hold = defer(); return hold }, setApprove: value => { approve = value },
    replace: () => { window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false }); contents.mainFrame = {} },
    get disposed() { return disposed },
  }
}
test('installer IPC accepts only current main window and main frame', async () => {
  const f = fixture()
  for (const event of [{}, { sender: {}, senderFrame: f.contents.mainFrame }, { sender: f.contents, senderFrame: {} }]) assert.equal((await f.call('plan', {}, event)).code, 'UNAUTHORIZED')
  assert.equal(f.calls.length, 0); assert.equal((await f.call('plan')).success, true); assert.match(f.calls[0][2], /^[\w-]+$/)
  f.controller.dispose()
})
test('native installation review cannot default to approval and decline preserves state', async () => {
  const f = fixture(); f.setApprove(false); const result = await f.call('install', { planId: 'fixture-plan' })
  assert.equal(result.approved, false); assert.equal(f.approvals[0].config.defaultId, 0); assert.equal(f.approvals[0].config.cancelId, 0)
  assert.match(f.approvals[0].config.detail, /No administrator access/); assert.match(f.approvals[0].config.detail, /SHA-256/); f.controller.dispose()
})
test('navigation during review invalidates owner and rejects approval', async () => {
  const f = fixture(); const gate = f.hold(); const pending = f.call('install', { planId: 'fixture-plan' })
  while (!f.approvals.length) await new Promise(r => setImmediate(r))
  f.contents.emit('did-start-navigation', {}, 'https://unexpected.test', false, true); gate.resolve()
  assert.equal((await pending).code, 'UNAUTHORIZED'); assert.equal(f.cancellations.length, 1); f.controller.dispose()
})
test('subframe or in-place navigation does not cancel main document job', async () => {
  const f = fixture(); await f.call('plan'); f.contents.emit('did-start-navigation', {}, 'unused', false, false); f.contents.emit('did-start-navigation', {}, 'unused', true, true)
  assert.equal(f.cancellations.length, 0); f.controller.dispose(); assert.equal(f.cancellations.length, 1)
})
test('export busy is actionable while status and cancel stay available', async () => {
  const f = fixture(); f.setBusy(true); assert.equal((await f.call('plan')).code, 'BUSY'); assert.equal(f.calls.length, 0)
  assert.equal((await f.call('status', { jobId: 'fixture-job' })).success, true); assert.equal((await f.call('cancel', { jobId: 'fixture-job' })).success, true); f.controller.dispose()
})
test('shutdown disposes manager, invalidates ownership and removes handlers', async () => {
  const f = fixture(); await f.call('plan'); f.app.emit('will-quit'); assert.equal(f.disposed, true); assert.equal(f.cancellations.length, 1); assert.equal(f.handlers.size, 0)
})
