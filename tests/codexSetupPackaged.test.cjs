'use strict'

// Platform-neutral ASAR closure/preload contract, runnable in the Mac build's
// Node preflight too. This is not a claim of a signed/quarantined Mac launch.
// No real Codex, browser, user profile, sign-in or provider call is performed.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { builtinModules, createRequire } = require('node:module')
const asar = require('@electron/asar')

const root = path.resolve(__dirname, '..')
const packageRequire = createRequire(path.join(root, 'package.json'))
const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])

async function stageNativeClosure(destination, filenames, copied = new Set()) {
  for (const filename of filenames) {
    const absolute = path.resolve(root, filename)
    assert.ok(absolute.startsWith(path.join(root, 'electron') + path.sep), 'Only native source belongs in this fixture')
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    if (copied.has(relative)) continue
    copied.add(relative)
    const source = await fs.readFile(absolute, 'utf8')
    const target = path.join(destination, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(absolute, target)
    const dependencies = [...source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)]
      .map(match => path.relative(root, path.resolve(path.dirname(absolute), match[1])))
    await stageNativeClosure(destination, dependencies, copied)
  }
  return copied
}

test('packaged Codex setup includes native login closure and preload connects to the real native channel', async t => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-codex-asar-'))
  t.after(async () => { asar.uncacheAll(); await fs.rm(output, { recursive: true, force: true }) })
  const staging = path.join(output, 'source'), archive = path.join(output, 'app.asar')
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.build.files.includes('electron/**/*'), 'All native Codex modules must ship in the desktop archive')
  assert.ok(require('./helpers/nativeExclusions.cjs').onlyReviewedNativeExclusions(pkg.build.files), 'A new native exclusion needs explicit setup coverage')
  const copied = await stageNativeClosure(staging, ['electron/connectedAgent.cjs', 'electron/preload.js', 'electron/codexSetupInstallerIpc.cjs'])
  await asar.createPackage(staging, archive)
  const entries = asar.listPackage(archive).map(entry => entry.replace(/^[/\\]/, '').replaceAll('\\', '/'))
  for (const filename of ['electron/connectedAgent.cjs', 'electron/connectedAgentCodex.cjs', 'electron/connectedAgentCodexLogin.cjs', 'electron/connectedAgentCodexAuth.cjs', 'electron/preload.js', 'electron/codexSetupInstaller.cjs', 'electron/codexSetupInstallerIpc.cjs']) {
    assert.ok(entries.includes(filename), `Missing packaged setup file: ${filename}`)
    assert.equal(asar.statFile(archive, filename).unpacked, undefined, 'JavaScript setup modules load directly from ASAR')
  }
  assert.ok(!entries.some(entry => /(?:^|\/)(?:auth\.json|config\.toml|\.env|phone-account\.json)$/.test(entry)), 'No account/configuration files belong in setup packaging')

  // Resolve every relative import from archived bytes, never the source tree.
  // Node lacks Electron's built-in ASAR loader, so this bounded loader also
  // validates the archive's transitive native module closure on every platform.
  const cache = new Map(), loads = [], externalLoads = []
  let bridge, rendererEvent
  const handlers = new Map(), channelCalls = []
  const electron = { contextBridge: { exposeInMainWorld: (key, value) => { if (key === 'electronAPI') bridge = value } },
    ipcRenderer: { invoke: async (channel, payload) => { channelCalls.push(channel); assert.ok(handlers.has(channel)); return handlers.get(channel)(rendererEvent, payload) }, on() {}, removeListener() {} } }
  function load(filename) {
    filename = path.posix.normalize(filename)
    assert.ok(copied.has(filename), `Import escaped the staged native closure: ${filename}`)
    if (cache.has(filename)) return cache.get(filename).exports
    loads.push(filename)
    const source = asar.extractFile(archive, filename).toString('utf8')
    const module = { exports: {} }
    cache.set(filename, module)
    if (filename.endsWith('.json')) { module.exports = JSON.parse(source); return module.exports }
    const requireArchived = specifier => {
      if (specifier.startsWith('.')) return load(path.posix.join(path.posix.dirname(filename), specifier))
      if (specifier === 'electron') return electron
      if (specifier === 'node:child_process' || specifier === 'child_process') return {
        spawn: () => { throw Error('Real process launch is forbidden in ASAR fixture') },
        execFile: () => { throw Error('Real metadata calls are forbidden in ASAR fixture') },
      }
      if (builtins.has(specifier)) return require(specifier)
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
      assert.ok(pkg.dependencies?.[name], `Native runtime dependency must be production-owned: ${name}`)
      externalLoads.push(name)
      return packageRequire(specifier)
    }
    const compiled = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${source}\n})`, { filename: `${archive}/${filename}` })
    compiled(requireArchived, module, module.exports, `${archive}/${filename}`, path.dirname(`${archive}/${filename}`))
    return module.exports
  }
  const native = load('electron/connectedAgent.cjs')
  const helper = load('electron/connectedAgentCodexLogin.cjs')
  const auth = load('electron/connectedAgentCodexAuth.cjs')
  load('electron/preload.js')
  const installerIpc = load('electron/codexSetupInstallerIpc.cjs')
  const installerCalls = []
  const installerWindow = { webContents: Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false }), isDestroyed: () => false }
  const installerController = installerIpc.registerCodexSetupInstallerIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    app: new EventEmitter(), getMainWindow: () => installerWindow,
    createManager: () => Object.fromEntries([...['plan', 'install', 'status', 'cancel'].map(method => [method, async args => { installerCalls.push([method, args]); return { success: true } }]), ['dispose', () => {}], ['cancelOwner', () => {}]]),
  })
  rendererEvent = { sender: installerWindow.webContents, senderFrame: installerWindow.webContents.mainFrame }
  for (const method of ['plan', 'install', 'status', 'cancel']) {
    assert.equal(typeof bridge.codexSetupInstaller[method], 'function')
    assert.equal((await bridge.codexSetupInstaller[method]({ fixture: method })).success, true)
  }
  assert.equal(installerCalls.length, 4)
  assert.deepEqual(channelCalls, ['plan', 'install', 'status', 'cancel'].map(method => installerIpc.CHANNELS[method]))
  channelCalls.length = 0
  installerController.dispose()
  assert.equal(typeof bridge.connectedAgent.codexLogin, 'function')
  assert.equal(typeof helper.signInCodex, 'function')
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send() {} })
  const window = { webContents: contents, isDestroyed: () => false }
  rendererEvent = { sender: contents, senderFrame: contents.mainFrame }
  const actions = [], executablePath = path.join(output, 'synthetic-native-codex')
  let activeLogin
  const controller = native.registerConnectedAgentIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    getMainWindow: () => window,
    executableAccess: { resolve: async () => ({ path: executablePath }) },
    codex: { send: async () => { throw auth.initialCodexAuthFailure(false) } },
    fullAccessPreference: { forget: async () => { actions.push('forget') }, read: async () => false },
    assertFullAccessAvailable: async () => {},
    signInCodexImpl: options => helper.signInCodex({ ...options, environment: {}, preflightImpl: async () => { actions.push('preflight') },
      spawnImpl: (executable, args, spawnOptions) => {
        actions.push('login')
        assert.equal(executable, executablePath)
        assert.deepEqual(args, ['login'])
        assert.equal(spawnOptions.shell, false)
        activeLogin = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
          kill: signal => { queueMicrotask(() => activeLogin.emit('close', null, signal)); return true } })
        return activeLogin
      },
    }),
  })
  t.after(() => controller.dispose())
  assert.deepEqual(actions, [], 'Loading packaged modules must never auto-sign-in')
  assert.equal((await bridge.connectedAgent.codexLogin({ action: 'start', url: 'https://untrusted.invalid' })).code, 'INVALID_REQUEST')
  const pending = bridge.connectedAgent.codexLogin({ action: 'start' })
  for (let i = 0; i < 20 && !activeLogin; i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(activeLogin)
  activeLogin.stdout.write('SECRET-SIGNIN-CODE')
  activeLogin.emit('close', 0, null)
  assert.deepEqual(await pending, { success: true })
  assert.deepEqual(actions, ['forget', 'preflight', 'login'])
  assert.ok(channelCalls.every(channel => channel === native.CHANNELS.codexLogin))
  const signedOut = await bridge.connectedAgent.send({ provider: 'codex', requestId: 'packaged-auth-recovery',
    model: '', messages: [{ role: 'user', content: 'Keep my unsent message.' }], context: {}, images: [], vision: false })
  assert.equal(signedOut.code, 'CODEX_LOGIN_REQUIRED')
  assert.equal(signedOut.promptNotSent, true, 'Packaged IPC retains the host-only pre-turn recovery proof')
  assert.equal(channelCalls.at(-1), native.CHANNELS.send)
  rendererEvent = { sender: contents, senderFrame: {} }
  assert.equal((await bridge.connectedAgent.codexLogin({ action: 'start' })).code, 'UNAUTHORIZED')
  assert.ok(loads.includes('electron/connectedAgentCodexLogin.cjs'))
  assert.ok(loads.every(filename => copied.has(filename)))
  assert.ok(externalLoads.every(name => pkg.dependencies[name]))
})
