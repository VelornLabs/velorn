'use strict'
// Archived production broker/preload plus the actual main-process atomic-write
// helper. Synthetic credentials and disposable settings only; no account calls.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), fsSync = require('node:fs')
const path = require('node:path'), os = require('node:os'), vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { performance } = require('node:perf_hooks')
const asar = require('@electron/asar')
const root = path.resolve(__dirname, '..')
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate, message) {
  const deadline = performance.now() + 5000
  while (!await predicate()) { assert.ok(performance.now() < deadline, message); await tick() }
}
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('archived cloud setup/preload performs isolated native credential handoff with main-document authority', async t => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-cloud-setup-asar-')))
  let broker
  t.after(async () => { broker?.dispose(); asar.uncacheAll(); await fs.rm(temp, { recursive: true, force: true }) })
  const stage = path.join(temp, 'source'), archive = path.join(temp, 'app.asar'), destination = path.join(temp, 'fixture-settings.json')
  await fs.mkdir(path.join(stage, 'electron'), { recursive: true })
  const files = ['electron/comfyCloudSetup.cjs', 'electron/preload.js', 'electron/main.js']
  for (const file of files) await fs.copyFile(path.join(root, file), path.join(stage, file))
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.build.files.includes('electron/**/*')); assert.ok(require('./helpers/nativeExclusions.cjs').onlyReviewedNativeExclusions(pkg.build.files))
  await asar.createPackage(stage, archive)
  for (const file of files) assert.equal(asar.statFile(archive, file).unpacked, undefined)

  let bridge, from, keyWriteGate
  const handlers = new Map(), rendererEvents = new EventEmitter(), publications = [], waiting = []
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'electronAPI') bridge = value } },
    ipcRenderer: { invoke: (channel, payload) => handlers.get(channel)(from, payload),
      on: (...args) => rendererEvents.on(...args), removeListener: (...args) => rendererEvents.removeListener(...args) } }
  function load(file) {
    const module = { exports: {} }, source = asar.extractFile(archive, file).toString('utf8')
    vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: `${archive}/${file}` })(name => {
      if (name === 'electron') return electron
      assert.equal(name, 'node:crypto', 'Native broker has no network or shell dependency')
      return require(name)
    }, module, module.exports)
    return module.exports
  }
  const native = load('electron/comfyCloudSetup.cjs'); load('electron/preload.js')
  assert.deepEqual(Object.keys(bridge.comfyCloudSetup), ['current', 'save', 'complete', 'onRequested', 'onChanged'])
  const mainSource = asar.extractFile(archive, 'electron/main.js').toString('utf8')
  const atomicSource = mainSource.slice(mainSource.indexOf('async function writeFileAtomic('), mainSource.indexOf('\nfunction getWindowState()', mainSource.indexOf('async function writeFileAtomic(')))
  assert.match(atomicSource, /beforeCommit\(\)[\s\S]*fsSync\.renameSync[\s\S]*onCommitted/)
  const testFs = Object.create(fs)
  testFs.writeFile = async (...args) => { await fs.writeFile(...args); if (keyWriteGate) await keyWriteGate.promise }
  const atomicWrite = vm.runInNewContext(`(${atomicSource})`, { fs: testFs, fsSync, path, process, Date, Math })
  await fs.writeFile(destination, JSON.stringify({ comfyApiKeyComfyOrg: '', generationSpending: 'local-only', keep: 17 }))
  const stored = async () => JSON.parse(await fs.readFile(destination, 'utf8'))
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false,
    send: (name, payload) => { publications.push([name, payload]); rendererEvents.emit(name, {}, payload) } })
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false })
  const abort = new AbortController()
  from = { sender: contents, senderFrame: contents.mainFrame }
  broker = native.createComfyCloudSetup({ ipcMain: { handle: (channel, callback) => handlers.set(channel, callback), removeHandler: channel => handlers.delete(channel) },
    getMainWindow: () => window, app: new EventEmitter(), getAgentScope: () => ({ signal: abort.signal, onWaiting: value => waiting.push(value) }),
    readKey: async () => (await stored()).comfyApiKeyComfyOrg,
    writeKey: async (key, { assertCurrent, expectedDigest, onCommitted }) => {
      const previous = await stored(); assertCurrent(); assert.equal(native.fingerprint(previous.comfyApiKeyComfyOrg), expectedDigest)
      await atomicWrite(destination, JSON.stringify({ ...previous, comfyApiKeyComfyOrg: key }), 'utf8', assertCurrent, onCommitted)
    },
  })
  let request, changeCount = 0
  const unrequest = bridge.comfyCloudSetup.onRequested(value => { request = value })
  const unchange = bridge.comfyCloudSetup.onChanged((...args) => { assert.equal(args.length, 0); changeCount++ })
  const pending = broker.api.request({}); await tick(); await tick()
  await until(() => request, 'Archived broker did not request the dialog within 5 seconds')
  assert.deepEqual(Object.keys(request), ['requestId'])
  assert.equal((await bridge.comfyCloudSetup.current()).request.requestId, request.requestId)
  const correct = from; from = { sender: contents, senderFrame: {} }
  assert.equal((await bridge.comfyCloudSetup.save({ ...request, key: 'bad-frame-key', validation: 'valid' })).success, false)
  from = correct
  const saved = await bridge.comfyCloudSetup.save({ ...request, key: 'fixture-key-not-real', validation: 'valid' })
  assert.equal(saved.status, 'verified'); assert.deepEqual(await pending, saved)
  assert.deepEqual(await stored(), { comfyApiKeyComfyOrg: 'fixture-key-not-real', generationSpending: 'local-only', keep: 17 })
  assert.doesNotMatch(JSON.stringify([saved, publications, await broker.api.status({})]), /fixture-key-not-real|bad-frame-key|fingerprint|digest/)
  assert.deepEqual(waiting, [true, false]); assert.ok(changeCount >= 2)

  request = null
  const cancelled = broker.api.request({})
  await until(() => request, 'Archived broker did not reopen the dialog within 5 seconds')
  keyWriteGate = defer()
  const saving = bridge.comfyCloudSetup.save({ ...request, key: 'never-committed', validation: 'unknown' })
  // Wait for the real atomic helper to create its owned temporary file.
  await until(async () => (await fs.readdir(temp)).some(name => name.endsWith('.tmp')), 'Atomic fixture did not reach its temporary write within 5 seconds')
  abort.abort('Stop'); keyWriteGate.resolve()
  assert.equal((await cancelled).status, 'cancelled'); assert.equal((await saving).success, false)
  assert.equal((await stored()).comfyApiKeyComfyOrg, 'fixture-key-not-real')
  assert.ok(!(await fs.readdir(temp)).some(name => name.endsWith('.tmp')))
  unrequest(); unchange()
  assert.equal(rendererEvents.listenerCount(native.REQUESTED), 0); assert.equal(rendererEvents.listenerCount(native.CHANGED), 0)

  const before = await fs.readFile(destination, 'utf8')
  for (const [beforeCommit, onCommitted] of [[{}, undefined], [() => {}, {}], [undefined, () => {}]]) {
    await assert.rejects(atomicWrite(destination, 'must-not-commit', 'utf8', beforeCommit, onCommitted), /native functions/)
    assert.equal(await fs.readFile(destination, 'utf8'), before)
  }
  assert.ok(!(await fs.readdir(temp)).some(name => name.endsWith('.tmp')))
  await atomicWrite(destination, 'ordinary-write', 'utf8')
  assert.equal(await fs.readFile(destination, 'utf8'), 'ordinary-write', 'ordinary unguarded writer is unchanged')
})
