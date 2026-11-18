'use strict'

// Production ASAR/preload/main wiring, with disposable storage and synthetic
// accounts only. No real Electron process, profile, credential or network call.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path'), os = require('node:os'), vm = require('node:vm')
const crypto = require('node:crypto'), { EventEmitter } = require('node:events')
const asar = require('@electron/asar')
const root = path.resolve(__dirname, '..')
const files = ['electron/comfyHostedSetup.cjs', 'electron/preload.js', 'electron/main.js']
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
let packageRoot, archive, sources

test.before(async () => {
  packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-hosted-asar-'))
  const stage = path.join(packageRoot, 'source')
  archive = path.join(packageRoot, 'app.asar')
  await fs.mkdir(path.join(stage, 'electron'), { recursive: true })
  for (const file of files) await fs.copyFile(path.join(root, file), path.join(stage, file))
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.build.files.includes('electron/**/*'))
  assert.ok(require('./helpers/nativeExclusions.cjs').onlyReviewedNativeExclusions(pkg.build.files))
  await asar.createPackage(stage, archive)
  sources = Object.fromEntries(files.map(file => {
    assert.equal(asar.statFile(archive, file).unpacked, undefined)
    return [file, asar.extractFile(archive, file).toString('utf8')]
  }))
})
test.after(async () => {
  asar.uncacheAll()
  if (packageRoot) await fs.rm(packageRoot, { recursive: true, force: true })
})

function protectedStorage(backend = 'gnome_libsecret') {
  const testKey = crypto.randomBytes(32), calls = []
  return {
    calls,
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString(value) {
      calls.push('encrypt')
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', testKey, nonce)
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), body])
    },
    decryptString(value) {
      calls.push('decrypt')
      const decipher = crypto.createDecipheriv('aes-256-gcm', testKey, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    },
  }
}

async function fixture(t, options = {}) {
  const userData = options.userData || await fs.mkdtemp(path.join(packageRoot, 'profile-'))
  const handlers = new Map(), calls = [], opens = [], ipcCalls = []
  const app = Object.assign(new EventEmitter(), { isPackaged: true, getPath: name => { assert.equal(name, 'userData'); return userData } })
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  let mainWindow = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false })
  let from = { sender: contents, senderFrame: contents.mainFrame }, bridge, broker
  const correct = from, safeStorage = options.safeStorage || protectedStorage()
  const runtime = { navigator: { userActivation: { isActive: false } }, fetch: () => assert.fail('Never use ambient fetch in packaged Electron') }
  const ipcMain = { handle: (name, callback) => { assert.ok(!handlers.has(name)); handlers.set(name, callback) }, removeHandler: name => handlers.delete(name) }
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'electronAPI') bridge = value } },
    ipcRenderer: { invoke: (name, payload) => { ipcCalls.push([name, payload]); return handlers.get(name)(from, payload) }, on() {}, removeListener() {} },
  }
  function load(file) {
    const module = { exports: {} }
    vm.runInThisContext(`(function(require,module,exports,globalThis){${sources[file]}\n})`, { filename: `${archive}/${file}` })(name => {
      if (name === 'electron') return electron
      assert.ok(['node:path', 'node:fs/promises', 'node:fs', 'node:crypto'].includes(name), `Unexpected native dependency: ${name}`)
      return require(name)
    }, module, module.exports, runtime)
    return module.exports
  }
  const native = load(files[0]); load(files[1])
  const main = sources['electron/main.js'], start = main.search(/\n(?:comfyHostedSetup = )?createComfyHostedSetup\(\{/)
  assert.ok(start >= 0, 'Production main must wire the hosted account setup')
  const end = main.indexOf('\n})', start)
  assert.ok(end > start)
  const wiring = main.slice(start, end + 3)
  assert.doesNotMatch(wiring, /readSettingsRaw|writeSettingsRaw|getAgentScope|generationSpending|comfyApiKeyComfyOrg/)
  const nativeFetch = async (url, request) => {
    calls.push({ url, request })
    return options.fetchImpl ? options.fetchImpl(url, request) : new Response(JSON.stringify({ status: 'active', private_account: 'must-not-be-returned' }))
  }
  vm.runInNewContext(wiring, {
    createComfyHostedSetup: configuration => {
      broker = native.createComfyHostedSetup({ ...configuration, getMainWindow: () => mainWindow,
        platform: 'linux', ...(options.fs ? { fs: options.fs } : {}), ...(options.fsSync ? { fsSync: options.fsSync } : {}) })
      return broker
    },
    app, ipcMain, safeStorage, mainWindow,
    net: { fetch: nativeFetch }, shell: { openExternal: async url => { opens.push(url) } },
  }, { filename: `${archive}/electron/main.js#hosted-wiring` })
  t.after(() => broker.dispose())
  return { bridge: bridge.comfyHostedSetup, native, broker, app, handlers, calls, opens, ipcCalls, runtime, safeStorage, userData, contents,
    credentialFile: path.join(userData, native.FILE_NAME),
    activate: value => { runtime.navigator.userActivation.isActive = value },
    foreign: () => { from = { sender: contents, senderFrame: {} } },
    restore: () => { from = correct },
    replace: () => { mainWindow = Object.assign(new EventEmitter(), { webContents: Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false }), isDestroyed: () => false }) },
  }
}

test('real ASAR bridge keeps status/cancel passive and gesture-gates account mutations and official links', async t => {
  const f = await fixture(t)
  assert.deepEqual(Object.keys(f.bridge).sort(), ['cancel', 'check', 'clear', 'openGuide', 'status'])
  assert.deepEqual(Object.keys(f.broker).sort(), ['dispose', 'readStatus'], 'Only native status metadata is added, never a key getter')
  assert.equal(f.bridge.readStatus, undefined, 'The internal readStatus method is not exposed through preload')
  const status = await f.bridge.status()
  assert.equal(status.state, 'missing'); assert.equal(status.configured, false)
  await f.bridge.cancel()
  assert.equal(f.calls.length, 0); assert.deepEqual(await fs.readdir(f.userData), [])
  const count = f.ipcCalls.length
  await assert.rejects(f.bridge.check({ key: 'synthetic-account-key' }), /yourself|gesture/)
  await assert.rejects(f.bridge.clear(), /gesture/)
  await assert.rejects(f.bridge.openGuide({ guide: 'keys' }), /yourself|gesture/)
  assert.equal(f.ipcCalls.length, count, 'Blocked gestures never cross preload')
  f.activate(true)
  f.foreign()
  for (const run of [() => f.bridge.status(), () => f.bridge.cancel(), () => f.bridge.check({ key: 'synthetic-account-key' }), () => f.bridge.clear(), () => f.bridge.openGuide({ guide: 'keys' })]) {
    assert.equal((await run()).code, 'COMFY_HOSTED_UNAUTHORIZED')
  }
  f.restore()
  assert.equal(f.calls.length, 0); assert.equal(f.opens.length, 0)
  assert.equal((await f.bridge.openGuide({ guide: 'keys', url: 'https://untrusted.invalid' })).success, false)
  assert.equal((await f.bridge.openGuide({ guide: 'keys' })).success, true)
  assert.equal((await f.bridge.openGuide({ guide: 'cloud' })).success, true)
  assert.deepEqual(f.opens, [f.native.GUIDES.keys, f.native.GUIDES.cloud])
  assert.equal(f.calls.length, 0)
})

test('archived native-only readStatus returns minimal prior account evidence without an account request', async t => {
  const f = await fixture(t)
  const current = { isCurrent: () => true }
  assert.deepEqual(await f.broker.readStatus(current), { success: true, integration: 'comfycloud', state: 'missing', configured: false })
  assert.equal(f.calls.length, 0)
  f.activate(true)
  await f.bridge.check({ key: 'synthetic-private-hosted-read-status-key', remember: true })
  const count = f.calls.length, saved = await fs.readFile(f.credentialFile)
  assert.deepEqual(await f.broker.readStatus(current), { success: true, integration: 'comfycloud', state: 'verified', configured: true })
  assert.equal(f.calls.length, count)
  assert.deepEqual(await fs.readFile(f.credentialFile), saved)
  await f.bridge.cancel()
  assert.deepEqual(await f.broker.readStatus(current), { success: true, integration: 'comfycloud', state: 'configured', configured: true })
  const stale = await f.broker.readStatus({ isCurrent: () => false })
  assert.notEqual(stale?.state, 'verified')
  assert.doesNotMatch(JSON.stringify(stale), /synthetic|credential|remembered|canRemember|\.enc/)
  await f.bridge.clear()
  assert.deepEqual(await f.broker.readStatus(current), { success: true, integration: 'comfycloud', state: 'missing', configured: false })
  assert.equal(f.calls.length, count)
})

test('archived main uses fixed private account GET and remembers only verified encrypted credentials', async t => {
  const f = await fixture(t)
  f.activate(true)
  const key = 'synthetic-hosted-key-not-a-real-credential'
  const result = await f.bridge.check({ key, remember: true })
  assert.equal(result.state, 'verified'); assert.equal(result.configured, true); assert.equal(result.remembered, true)
  assert.equal(f.calls.length, 1)
  const { url, request } = f.calls[0]
  assert.equal(url, f.native.ENDPOINT); assert.equal(request.method, 'GET')
  assert.equal(request.redirect, 'error'); assert.equal(request.credentials, 'omit')
  assert.equal(request.cache, 'no-store'); assert.equal(request.bypassCustomProtocolHandlers, true)
  assert.equal(request.headers['X-API-Key'], key); assert.equal(request.headers.Authorization, undefined)
  assert.equal(request.body, undefined)
  const bytes = await fs.readFile(f.credentialFile)
  assert.ok(!bytes.includes(Buffer.from(key))); assert.equal((await fs.stat(f.credentialFile)).mode & 0o777, 0o600)
  assert.deepEqual(await fs.readdir(f.userData), [f.native.FILE_NAME])
  assert.doesNotMatch(JSON.stringify([result, await f.bridge.status()]), /synthetic|must-not-be-returned|private_account|digest|fingerprint/)
  const before = f.calls.length
  f.broker.dispose()
  const reopened = await fixture(t, { userData: f.userData, safeStorage: f.safeStorage })
  const saved = await reopened.bridge.status()
  assert.equal(saved.state, 'configured'); assert.equal(saved.remembered, true)
  assert.deepEqual(await reopened.broker.readStatus({ isCurrent: () => true }), { success: true, integration: 'comfycloud', state: 'configured', configured: true })
  assert.equal(f.calls.length, before); assert.equal(reopened.calls.length, 0, 'Reopening does not verify over the network')
  reopened.activate(true)
  const cleared = await reopened.bridge.clear()
  assert.equal(cleared.configured, false); assert.equal(cleared.remembered, false)
  await assert.rejects(fs.stat(f.credentialFile), { code: 'ENOENT' })
  assert.equal(reopened.calls.length, 0)
})

test('Linux plaintext fallback and unavailable safeStorage allow only explicit session credentials', async t => {
  for (const safeStorage of [protectedStorage('basic_text'), { isEncryptionAvailable: () => false }]) {
    const f = await fixture(t, { safeStorage })
    assert.equal((await f.bridge.status()).canRemember, false)
    f.activate(true)
    const denied = await f.bridge.check({ key: 'synthetic-session-key', remember: true })
    assert.equal(denied.success, false); assert.equal(f.calls.length, 0)
    const checked = await f.bridge.check({ key: 'synthetic-session-key', remember: false })
    assert.equal(checked.state, 'verified'); assert.equal(checked.remembered, false)
    assert.deepEqual(await fs.readdir(f.userData), [])
    if (safeStorage.calls) assert.deepEqual(safeStorage.calls, [])
  }
})

test('archived check cancellation and silent window replacement cannot adopt a late candidate', async t => {
  for (const boundary of ['cancel', 'navigation', 'replacement']) {
    const gate = defer(), started = defer()
    const f = await fixture(t, { fetchImpl: async () => { started.resolve(); return gate.promise } })
    f.activate(true)
    const pending = f.bridge.check({ key: 'synthetic-never-adopt-key', remember: true })
    await started.promise
    if (boundary === 'cancel') await f.bridge.cancel()
    if (boundary === 'navigation') f.contents.emit('did-start-navigation', {}, 'file:///changed', false, true)
    if (boundary === 'replacement') f.replace()
    gate.resolve(new Response(JSON.stringify({ status: 'active' })))
    const result = await pending
    assert.equal(result.success, false); assert.equal(result.remembered, false)
    assert.deepEqual(await fs.readdir(f.userData), [])
    assert.doesNotMatch(JSON.stringify(result), /synthetic-never-adopt-key/)
  }
})

test('cancel during temporary encrypted write preserves prior key and prevents late save', async t => {
  const gate = defer(), started = defer(), customFs = Object.create(fs)
  let hold = false
  customFs.open = async (...args) => {
    const handle = await fs.open(...args)
    if (!hold || !String(args[0]).endsWith('.tmp')) return handle
    return {
      writeFile: async value => { await handle.writeFile(value); started.resolve(); await gate.promise },
      sync: () => handle.sync(), close: () => handle.close(),
    }
  }
  const f = await fixture(t, { fs: customFs })
  f.activate(true)
  assert.equal((await f.bridge.check({ key: 'synthetic-old-remembered-key', remember: true })).remembered, true)
  const previous = await fs.readFile(f.credentialFile)
  hold = true
  const replacing = f.bridge.check({ key: 'synthetic-new-never-saved-key', remember: true })
  await started.promise
  await f.bridge.cancel()
  gate.resolve()
  const result = await replacing
  assert.equal(result.success, false)
  const status = await f.bridge.status()
  assert.equal(status.remembered, true)
  assert.notEqual(status.state, 'verified')
  assert.deepEqual(await fs.readFile(f.credentialFile), previous)
  assert.deepEqual(await fs.readdir(f.userData), [f.native.FILE_NAME], 'Owned temporary writes are cleaned up')
})

test('cancel revokes a Clear queued behind an outstanding encrypted write', async t => {
  const gate = defer(), started = defer(), customFs = Object.create(fs)
  let hold = false
  customFs.open = async (...args) => {
    const handle = await fs.open(...args)
    if (!hold || !String(args[0]).endsWith('.tmp')) return handle
    return {
      writeFile: async value => { await handle.writeFile(value); started.resolve(); await gate.promise },
      sync: () => handle.sync(), close: () => handle.close(),
    }
  }
  const f = await fixture(t, { fs: customFs })
  f.activate(true)
  await f.bridge.check({ key: 'synthetic-prior-key', remember: true })
  const previous = await fs.readFile(f.credentialFile)
  hold = true
  const replacing = f.bridge.check({ key: 'synthetic-never-committed-key', remember: true })
  await started.promise
  const clearing = f.bridge.clear()
  // Let Clear invalidate the check and enqueue its mutation before the separate
  // cancellation that represents closing the controls.
  await new Promise(resolve => setImmediate(resolve))
  await f.bridge.cancel()
  gate.resolve()
  assert.equal((await replacing).success, false)
  assert.equal((await clearing).success, false)
  assert.deepEqual(await fs.readFile(f.credentialFile), previous)
  assert.equal((await f.bridge.status()).remembered, true)
  assert.deepEqual(await fs.readdir(f.userData), [f.native.FILE_NAME])
})
