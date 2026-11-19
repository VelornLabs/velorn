'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { registerComfyRouterIpc, METHODS, GUIDE } = require('../electron/comfyRouterIpc.cjs')

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function createWindow() {
  const webContents = new EventEmitter()
  webContents.mainFrame = { name: 'main-frame' }
  webContents.destroyed = false
  webContents.isDestroyed = () => webContents.destroyed
  return { webContents, destroyed: false, isDestroyed() { return this.destroyed } }
}

function fixture(options = {}) {
  const handlers = new Map(), calls = [], external = []
  const window = createWindow()
  let currentWindow = window
  let cancellations = 0
  const manager = Object.fromEntries(METHODS.map(method => [method, async payload => {
    calls.push({ method, payload })
    return { success: true, method }
  }]))
  manager.cancelPending = () => { cancellations++ }
  const registration = registerComfyRouterIpc({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    getMainWindow: () => currentWindow,
    getManager: () => manager,
    isBusy: options.isBusy,
    openExternal: async url => { external.push(url) },
  })
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame })
  const invoke = (method, payload = {}, candidate = event()) => handlers.get(`comfy-router:${method}`)(candidate, payload)
  return { handlers, calls, external, window, manager, registration, event, invoke,
    setWindow: value => { currentWindow = value }, get cancellations() { return cancellations } }
}

test('export allows cached reads and cancellation but blocks new work before native dispatch', async () => {
  const f = fixture({ isBusy: () => true })
  for (const method of [...METHODS, 'openGuide'].filter(name => !['status', 'list', 'clear', 'cancel'].includes(name))) {
    assert.equal((await f.invoke(method)).code, 'ROUTER_EXPORT_BUSY')
  }
  assert.equal(f.calls.length, 0)
  for (const method of ['status', 'list', 'clear', 'cancel']) assert.equal((await f.invoke(method)).success, true)
  assert.equal(f.calls.length, 4)
})

test('registers only fixed Router channels and fixed official guide', async () => {
  const f = fixture()
  assert.deepEqual([...f.handlers.keys()], [...METHODS, 'openGuide'].map(method => `comfy-router:${method}`))
  assert.equal((await f.invoke('openGuide', { url: 'https://attacker.invalid/' })).success, true)
  assert.deepEqual(f.external, [GUIDE])
  assert.equal(GUIDE, 'https://platform.comfy.org/profile/api-keys?onboarding=router')
  assert.deepEqual(f.calls, [])
})

test('main-window main-frame invokes each native method exactly once', async () => {
  const f = fixture()
  for (const method of METHODS) {
    const payload = { test: method }
    assert.equal((await f.invoke(method, payload)).success, true)
    assert.deepEqual(f.calls.at(-1), { method, payload })
  }
  assert.equal(f.calls.length, METHODS.length)
  assert.deepEqual(f.external, [])
})

test('embedded/subframe/foreign/missing senders cannot read keys, mutate jobs, or invoke providers', async () => {
  const f = fixture()
  const foreign = createWindow()
  const unauthorized = [
    null, {}, { sender: f.window.webContents },
    { sender: f.window.webContents, senderFrame: { parent: f.window.webContents.mainFrame, name: 'embedded-ComfyUI' } },
    { sender: foreign.webContents, senderFrame: foreign.webContents.mainFrame },
    { sender: foreign.webContents, senderFrame: f.window.webContents.mainFrame },
  ]
  for (const method of [...METHODS, 'openGuide']) for (const event of unauthorized) {
    assert.equal((await f.invoke(method, { apiKey: 'synthetic-only' }, event)).code, 'ROUTER_UNAUTHORIZED')
  }
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.external, [])
  assert.equal(f.cancellations, 0)
})

test('destroyed or replaced windows fail before every native/provider operation', async () => {
  for (const mutate of [
    f => { f.window.destroyed = true },
    f => { f.window.webContents.destroyed = true },
    f => { f.setWindow(createWindow()) },
    f => { f.setWindow(null) },
  ]) {
    const f = fixture()
    mutate(f)
    for (const method of [...METHODS, 'openGuide']) assert.equal((await f.invoke(method)).code, 'ROUTER_UNAUTHORIZED')
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.external, [])
  }
})

test('malformed payloads fail before calling native methods', async () => {
  const f = fixture()
  for (const payload of [null, [], 'key', false, 3]) {
    for (const method of METHODS) assert.equal((await f.invoke(method, payload)).code, 'ROUTER_UNAUTHORIZED')
  }
  assert.deepEqual(f.calls, [])
})

test('pending read result is withheld after main frame replacement', async () => {
  const f = fixture(), wait = deferred()
  f.manager.status = () => wait.promise
  const pending = f.invoke('status')
  f.window.webContents.mainFrame = { name: 'replacement-frame' }
  wait.resolve({ success: true, secret: 'synthetic-provider-secret' })
  const result = await pending
  assert.equal(result.code, 'ROUTER_CONTEXT_CHANGED')
  assert.doesNotMatch(JSON.stringify(result), /synthetic-provider-secret/)
})

test('pending results are withheld after window replacement or disposal', async () => {
  for (const change of [f => f.setWindow(createWindow()), f => f.registration.dispose()]) {
    const f = fixture(), wait = deferred()
    f.manager.output = () => wait.promise
    const pending = f.invoke('output', { jobId: 'synthetic-job' })
    change(f)
    wait.resolve({ success: true, bytes: 'synthetic-private-output' })
    const result = await pending
    assert.equal(result.code, 'ROUTER_CONTEXT_CHANGED')
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private-output/)
  }
})

test('full main-frame navigation and renderer exit cancel pending native work once per event', async () => {
  const f = fixture()
  await f.invoke('status')
  await f.invoke('list')
  f.window.webContents.emit('did-start-navigation', {}, 'https://example.invalid/', false, false)
  f.window.webContents.emit('did-start-navigation', {}, 'app://same#fragment', true, true)
  assert.equal(f.cancellations, 0)
  f.window.webContents.emit('did-start-navigation', {}, 'app://new-document', false, true)
  assert.equal(f.cancellations, 1)
  f.window.webContents.emit('render-process-gone', {}, {})
  assert.equal(f.cancellations, 2)
})

test('navigation cancellation reaches a pending manager operation without exposing its failure details', async () => {
  const f = fixture(), pendingWork = deferred(), entered = deferred()
  let dispatchedPaidProvider = false
  f.manager.submit = async () => {
    entered.resolve()
    await pendingWork.promise
    if (f.cancellations) throw new Error('synthetic-secret-key https://signed.invalid/')
    dispatchedPaidProvider = true
    return { success: true }
  }
  f.manager.cancelPending = () => { pendingWork.resolve(); Object.defineProperty(f, 'cancellations', { value: 1 }) }
  const pending = f.invoke('submit', { planId: 'synthetic-plan' })
  await entered.promise
  f.window.webContents.emit('did-start-navigation', {}, 'app://new-document', false, true)
  const result = await pending
  assert.equal(dispatchedPaidProvider, false)
  assert.equal(result.code, 'ROUTER_FAILED')
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret-key|signed\.invalid/)
})

test('native/provider throws are redacted and never retried or sent to a fallback', async () => {
  const f = fixture()
  let calls = 0
  f.manager.connect = async () => { calls++; throw Object.assign(new Error('synthetic-secret https://signed.invalid/token'), { publicMessage: 'synthetic-secret' }) }
  const result = await f.invoke('connect', { apiKey: 'synthetic-only' })
  assert.equal(result.code, 'ROUTER_FAILED')
  assert.equal(calls, 1)
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|signed\.invalid/)
  assert.deepEqual(f.calls, [])
})

test('dispose removes channels and held handlers cannot call native methods', async () => {
  const f = fixture()
  const held = f.handlers.get('comfy-router:submit')
  f.registration.dispose()
  assert.equal(f.handlers.size, 0)
  assert.equal((await held(f.event(), { planId: 'synthetic-plan' })).code, 'ROUTER_UNAUTHORIZED')
  assert.deepEqual(f.calls, [])
})

test('events from an old window cannot cancel current-window operations', async () => {
  const f = fixture()
  await f.invoke('status')
  f.setWindow(createWindow())
  f.window.webContents.emit('did-start-navigation', {}, 'app://old-window', false, true)
  f.window.webContents.emit('render-process-gone', {}, {})
  assert.equal(f.cancellations, 0)
})

test('disposed IPC listeners cannot cancel later native work', async () => {
  const f = fixture()
  await f.invoke('status')
  f.registration.dispose()
  f.window.webContents.emit('did-start-navigation', {}, 'app://later', false, true)
  f.window.webContents.emit('render-process-gone', {}, {})
  assert.equal(f.cancellations, 0)
})
