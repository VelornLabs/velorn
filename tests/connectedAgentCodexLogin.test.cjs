'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { setTimeout: delay } = require('node:timers/promises')
const { signInCodex, LOGIN_OUTPUT_BYTES } = require('../electron/connectedAgentCodexLogin.cjs')
const { registerConnectedAgentIpc, CHANNELS } = require('../electron/connectedAgent.cjs')

const executablePath = path.join(os.tmpdir(), 'synthetic-codex')
const problem = (code, message = code) => Object.assign(new Error(message), { code })
const tick = () => new Promise(resolve => setImmediate(resolve))
const waitForAbort = signal => new Promise((_resolve, reject) => {
  if (signal.aborted) reject(problem('CANCELLED'))
  else signal.addEventListener('abort', () => reject(problem('CANCELLED')), { once: true })
})
async function until(predicate) {
  const deadline = performance.now() + 5000
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'Expected synthetic operation did not start within five seconds')
    await delay(10)
  }
}
function processFixture() {
  const calls = [], checks = [], kills = []
  let child
  return { calls, checks, kills, get child() { return child }, dependencies: {
    executablePath,
    preflightImpl: async options => { checks.push(options) },
    spawnImpl: (...args) => {
      calls.push(args)
      child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
        kill: signal => { kills.push(signal); queueMicrotask(() => child.emit('close', null, signal)); return true } })
      return child
    },
  } }
}

test('explicit login preflights then runs only login with sanitized environment and no credential output', async () => {
  const f = processFixture()
  const promise = signInCodex({ ...f.dependencies, environment: { HOME: '/synthetic-home', PATH: '/synthetic-bin',
    OPENAI_API_KEY: 'secret-api-key', OPENAI_BASE_URL: 'https://untrusted.invalid', NODE_OPTIONS: '--require /evil', BROWSER: '/evil' } })
  await until(() => f.calls.length)
  assert.equal(f.checks.length, 1)
  assert.equal(f.checks[0].executablePath, executablePath)
  assert.deepEqual(f.calls[0][1], ['login'])
  assert.deepEqual(f.calls[0][2], { cwd: os.tmpdir(), env: { PATH: '/synthetic-bin', HOME: '/synthetic-home' },
    shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  f.child.stdout.write('SECRET-CODE https://login.invalid/?token=SECRET-TOKEN')
  f.child.stderr.write('SECRET-CREDENTIALS')
  f.child.emit('close', 0, null)
  assert.deepEqual(await promise, { success: true })
  assert.deepEqual(f.kills, [])
})

test('failed preflight never launches a login process', async () => {
  const f = processFixture()
  await assert.rejects(signInCodex({ ...f.dependencies, preflightImpl: async () => { throw problem('CODEX_UNSUPPORTED', 'Update Codex.') } }), { code: 'CODEX_UNSUPPORTED' })
  assert.equal(f.calls.length, 0)
})

test('only bounded control-free desktop-session hints are added for browser login', async () => {
  const f = processFixture()
  const environment = { PATH: '/trusted-bin', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME',
    XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', BROWSER: 'evil --command',
    DESKTOP_SESSION: '/evil', SHELLOPTS: 'evil' }
  const pending = signInCodex({ ...f.dependencies, environment })
  await until(() => f.child)
  assert.deepEqual(f.calls[0][2].env, { PATH: '/trusted-bin', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME',
    XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' })
  f.child.emit('close', 0, null)
  await pending
  for (const value of ['bad\nvalue', 'bad\0value', 'bad\u007fvalue', 'a'.repeat(4097), 123]) {
    const invalid = processFixture()
    const result = signInCodex({ ...invalid.dependencies, environment: { DISPLAY: value, WAYLAND_DISPLAY: value,
      XDG_CURRENT_DESKTOP: value, XDG_RUNTIME_DIR: value, DBUS_SESSION_BUS_ADDRESS: value } })
    await until(() => invalid.child)
    assert.deepEqual(invalid.calls[0][2].env, {})
    invalid.child.emit('close', 0, null)
    await result
  }
})

test('cancel before or during preflight never launches a process', async () => {
  for (const before of [true, false]) {
    const f = processFixture(), controller = new AbortController()
    if (before) controller.abort()
    await assert.rejects(signInCodex({ ...f.dependencies, signal: controller.signal,
      preflightImpl: async () => { controller.abort() } }), { code: 'CANCELLED' })
    assert.equal(f.calls.length, 0)
  }
})

test('login cancellation kills only its owned process and never exposes prior output', async () => {
  const f = processFixture(), controller = new AbortController()
  const promise = signInCodex({ ...f.dependencies, signal: controller.signal })
  await until(() => f.child)
  f.child.stderr.write('SECRET-URL')
  controller.abort()
  await assert.rejects(promise, error => error.code === 'CANCELLED' && !error.message.includes('SECRET'))
  assert.deepEqual(f.kills, ['SIGKILL'])
})

test('login timeout is bounded and kills only its owned process', async () => {
  const f = processFixture()
  await assert.rejects(signInCodex({ ...f.dependencies, timeoutMs: 5 }), { code: 'CODEX_LOGIN_TIMEOUT' })
  assert.deepEqual(f.kills, ['SIGKILL'])
})

test('synthetic real subprocess cancellation waits for its owned child to close', async () => {
  const { spawn } = require('node:child_process')
  const controller = new AbortController()
  let child, closed = false
  const pending = signInCodex({ executablePath: process.execPath, signal: controller.signal, preflightImpl: async () => {},
    spawnImpl: (_executable, args, options) => {
      assert.deepEqual(args, ['login'])
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options)
      child.on('close', () => { closed = true })
      return child
    } })
  await until(() => child)
  controller.abort()
  await assert.rejects(pending, { code: 'CANCELLED' })
  assert.equal(closed, true)
  assert.equal(child.killed, true)
})

test('excess login output is discarded and stops the process without accumulating credential text', async () => {
  const f = processFixture()
  const promise = signInCodex(f.dependencies)
  await until(() => f.child)
  f.child.stdout.write(Buffer.alloc(LOGIN_OUTPUT_BYTES / 2, 's'))
  f.child.stderr.write(Buffer.alloc(LOGIN_OUTPUT_BYTES / 2 + 1, 't'))
  await assert.rejects(promise, { code: 'CODEX_LOGIN_FAILED' })
  assert.deepEqual(f.kills, ['SIGKILL'])
})

test('nonzero exit, killed process and spawn errors use only safe login errors', async () => {
  for (const mode of ['nonzero', 'signal', 'error', 'throw']) {
    const f = processFixture()
    const promise = signInCodex({ ...f.dependencies, ...(mode === 'throw' ? { spawnImpl: () => { throw new Error('SECRET-CREDENTIAL') } } : {}) })
    if (mode !== 'throw') {
      await until(() => f.child)
      f.child.stderr.write('SECRET-CREDENTIAL')
      if (mode === 'error') f.child.emit('error', new Error('SECRET-CREDENTIAL'))
      else f.child.emit('close', mode === 'nonzero' ? 1 : null, mode === 'signal' ? 'SIGKILL' : null)
    }
    await assert.rejects(promise, error => error.code === 'CODEX_LOGIN_FAILED' && !error.message.includes('SECRET'))
  }
})

test('login never falls back to an unqualified executable or accepts URL and command arguments', async () => {
  for (const value of [undefined, '', 'codex', 'https://example.invalid/codex', 'codex login']) {
    const f = processFixture()
    await assert.rejects(signInCodex({ ...f.dependencies, executablePath: value }), { code: 'CODEX_EXECUTABLE_INVALID' })
    assert.equal(f.calls.length, 0)
  }
})

function ipcFixture(overrides = {}) {
  const handlers = new Map(), events = [], actions = []
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: (...args) => events.push(args) })
  const window = { webContents: contents, isDestroyed: () => false }
  let currentWindow = window, remembered = true
  const context = { session: 'synthetic', projectKey: os.tmpdir(), revision: 1 }
  const options = {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    getMainWindow: () => currentWindow,
    executableAccess: { resolve: async () => { actions.push('resolve'); return { path: executablePath } }, status: async () => ({ available: true }) },
    fullAccessPreference: { read: async () => remembered, forget: async () => { actions.push('forget'); remembered = false } },
    assertFullAccessAvailable: async () => { actions.push('available') },
    confirmFullAccess: async () => ({ approved: true, shareImagesAndView: true }),
    getToolContext: async () => context,
    signInCodexImpl: async options => { actions.push('login'); assert.equal(options.executablePath, executablePath) },
    codex: { inspect: async () => ({ success: true }), send: async () => ({ success: true, text: 'synthetic' }) },
    ...overrides,
  }
  const controller = registerConnectedAgentIpc(options)
  const event = { sender: contents, senderFrame: contents.mainFrame }
  return { actions, contents, controller, event, events, context, handlers,
    replaceWindow: () => { currentWindow = { ...window } },
    call: (key, payload, from = event) => handlers.get(CHANNELS[key])(from, payload),
  }
}
const request = (extra = {}) => ({ provider: 'codex', requestId: 'synthetic-turn', context: {},
  messages: [{ role: 'user', content: 'Inspect only.' }], ...extra })

test('native login is explicit, revokes remembered access before account change and never forwards provider output', async t => {
  const f = ipcFixture({ signInCodexImpl: async options => { f.actions.push('login'); assert.equal(options.executablePath, executablePath); return { token: 'SECRET', url: 'https://secret.invalid' } } })
  t.after(() => f.controller.dispose())
  assert.deepEqual(f.actions, [])
  assert.deepEqual(await f.call('codexLogin', { action: 'start' }), { success: true })
  assert.deepEqual(f.actions, ['available', 'resolve', 'forget', 'login'])
  assert.equal((await f.call('getFullAccessPreference', { provider: 'codex' })).remembered, false)
  assert.deepEqual(f.events, [[CHANNELS.event, { type: 'codex-setup-changed' }]])
})

test('native login rejects subframes, foreign windows, extra URL/path/args and logout requests', async t => {
  const f = ipcFixture()
  t.after(() => f.controller.dispose())
  for (const from of [{ sender: f.contents, senderFrame: {} }, { sender: { isDestroyed: () => false }, senderFrame: f.event.senderFrame }]) {
    for (const action of ['start', 'cancel']) assert.equal((await f.call('codexLogin', { action }, from)).code, 'UNAUTHORIZED')
  }
  for (const payload of [undefined, {}, { action: 'logout' }, { action: 'start', url: 'https://untrusted.invalid' },
    { action: 'start', executablePath: '/evil' }, { action: 'start', args: ['logout'] }, { action: 'cancel', requestId: 'other' }]) {
    assert.equal((await f.call('codexLogin', payload)).code, 'INVALID_REQUEST')
  }
  assert.deepEqual(f.actions, [])
})

test('native login start locks provider, install and full-access operations until its own cancellation', async t => {
  let loginSignal
  const f = ipcFixture({ signInCodexImpl: ({ signal }) => { loginSignal = signal; return waitForAbort(signal) } })
  t.after(() => f.controller.dispose())
  const pending = f.call('codexLogin', { action: 'start' })
  await until(() => loginSignal)
  assert.equal((await f.call('codexLogin', { action: 'start' })).code, 'BUSY')
  assert.equal((await f.call('inspect', { provider: 'codex' })).code, 'BUSY')
  assert.equal((await f.call('codexExecutable', { action: 'choose' })).code, 'BUSY')
  assert.equal((await f.call('codexExecutable', { action: 'status' })).code, 'BUSY')
  assert.equal((await f.call('setFullAccess', { enabled: true, conversationId: 'chat' })).code, 'BUSY')
  assert.equal((await f.call('send', request())).code, 'BUSY')
  assert.equal((await f.call('cancel', { requestId: 'codex-login' })).code, 'INVALID_REQUEST')
  assert.equal(loginSignal.aborted, false)
  assert.deepEqual(await f.call('codexLogin', { action: 'cancel' }), { success: true, cancelled: true })
  assert.equal((await pending).code, 'CANCELLED')
  assert.equal(loginSignal.aborted, true)
  assert.equal((await f.call('inspect', { provider: 'codex' })).success, true)
})

test('login cannot collide with a normal send request ID', async t => {
  const f = ipcFixture()
  t.after(() => f.controller.dispose())
  assert.equal((await f.call('send', request({ requestId: 'codex-login' }))).code, 'INVALID_REQUEST')
  assert.deepEqual(f.actions, [])
})

test('cancelled login retains native ownership until helper process cleanup completes', async t => {
  let signal, finish
  const f = ipcFixture({ signInCodexImpl: options => { signal = options.signal; return new Promise(resolve => { finish = resolve }) } })
  t.after(() => f.controller.dispose())
  const pending = f.call('codexLogin', { action: 'start' })
  await until(() => signal)
  assert.equal((await f.call('codexLogin', { action: 'cancel' })).cancelled, true)
  assert.equal(signal.aborted, true)
  assert.equal((await f.call('codexLogin', { action: 'start' })).code, 'BUSY')
  assert.equal((await f.call('setFullAccess', { enabled: true, restoreOnly: true, conversationId: 'chat', expectedContext: f.context })).code, 'BUSY')
  finish()
  assert.equal((await pending).code, 'CANCELLED')
  assert.equal((await f.call('inspect', { provider: 'codex' })).success, true)
})

test('cancel without a login does not cancel a running conversation and start remains busy', async t => {
  let sendSignal
  const f = ipcFixture({ codex: { send: (_request, { signal }) => { sendSignal = signal; return new Promise(() => {}) } } })
  t.after(() => f.controller.dispose())
  const pending = f.call('send', request())
  await until(() => sendSignal)
  assert.deepEqual(await f.call('codexLogin', { action: 'cancel' }), { success: true, cancelled: false })
  assert.equal(sendSignal.aborted, false)
  assert.equal((await f.call('codexLogin', { action: 'start' })).code, 'BUSY')
  await f.call('cancel', { requestId: 'synthetic-turn' })
  assert.equal((await pending).cancelled, true)
})

test('login does not start during export or if resolving or forgetting access fails', async t => {
  for (const overrides of [
    { assertFullAccessAvailable: async () => { throw problem('BUSY', 'Export is active.') } },
    { executableAccess: { resolve: async () => { throw problem('CODEX_NOT_FOUND', 'Codex is missing.') } } },
    { fullAccessPreference: { forget: async () => { throw new Error('SECRET') } } },
  ]) {
    const f = ipcFixture(overrides)
    t.after(() => f.controller.dispose())
    assert.equal((await f.call('codexLogin', { action: 'start' })).success, false)
    assert.ok(!f.actions.includes('login'))
  }
})

test('navigation, renderer loss, shutdown and replacement window cancel login without success', async t => {
  for (const reason of ['navigation', 'renderer', 'shutdown', 'replacement']) {
    let loginSignal, finish
    const f = ipcFixture({ signInCodexImpl: ({ signal }) => { loginSignal = signal; return new Promise(resolve => { finish = resolve }) } })
    t.after(() => f.controller.dispose())
    const pending = f.call('codexLogin', { action: 'start' })
    await until(() => loginSignal)
    if (reason === 'navigation') f.contents.emit('did-start-navigation', {}, 'https://untrusted.invalid', false, true)
    if (reason === 'renderer') f.contents.emit('render-process-gone')
    if (reason === 'shutdown') f.controller.dispose()
    if (reason === 'replacement') f.replaceWindow()
    finish({ success: true })
    const result = await pending
    assert.equal(result.success, false, reason)
    assert.equal(result.code, 'CANCELLED', reason)
    assert.equal(loginSignal.aborted, true, reason)
  }
})

test('account login revokes an existing full-access grant even if sign-in later fails', async t => {
  for (const failure of ['CODEX_LOGIN_FAILED', 'CODEX_UNSUPPORTED', 'CODEX_PROCESS_TERMINATED']) {
    const f = ipcFixture({ signInCodexImpl: async () => { throw problem(failure, 'Sign-in did not finish.') } })
    t.after(() => f.controller.dispose())
    const grant = await f.call('setFullAccess', { enabled: true, conversationId: 'chat', expectedContext: f.context })
    assert.equal(grant.enabled, true)
    assert.equal((await f.call('codexLogin', { action: 'start' })).code, failure)
    const result = await f.call('send', request({ fullAccess: true, toolsEnabled: true, expectedContext: f.context,
      conversationId: 'chat', fullAccessToken: grant.token }))
    assert.equal(result.code, 'UNAUTHORIZED')
  }
})

test('pending full-access consent blocks login without clearing its state', async t => {
  let finish
  const f = ipcFixture({ confirmFullAccess: () => new Promise(resolve => { finish = resolve }) })
  t.after(() => f.controller.dispose())
  const pending = f.call('setFullAccess', { enabled: true, conversationId: 'chat', expectedContext: f.context })
  await until(() => finish)
  assert.equal((await f.call('codexLogin', { action: 'start' })).code, 'BUSY')
  assert.ok(!f.actions.includes('login'))
  finish(false)
  assert.equal((await pending).success, true)
})

test('preload exposes only the fixed login IPC channel, not direct process or URL launch', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/preload.js'), 'utf8')
  assert.match(source, /codexLogin: payload => ipcRenderer\.invoke\('connected-agent:codex-login', payload\)/)
})
