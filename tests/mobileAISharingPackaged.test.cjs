'use strict'

// Platform-neutral ASAR boundary check, also run on the Mac builder. This does
// not claim a signed/quarantined launch or real account/provider connectivity.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { builtinModules, createRequire } = require('node:module')
const asar = require('@electron/asar')
const root = path.resolve(__dirname, '..')
const packageRequire = createRequire(path.join(root, 'package.json'))
const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])

async function stageClosure(destination, filenames, copied = new Set()) {
  for (const filename of filenames) {
    const absolute = path.resolve(root, filename)
    assert.ok(absolute.startsWith(path.join(root, 'electron') + path.sep), 'Fixture includes only native source')
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    if (copied.has(relative)) continue
    copied.add(relative)
    const source = await fs.readFile(absolute, 'utf8'), target = path.join(destination, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(absolute, target)
    const imports = [...source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)]
      .map(match => path.relative(root, path.resolve(path.dirname(absolute), match[1])))
    await stageClosure(destination, imports, copied)
  }
  return copied
}

test('archived phone-sharing module, preload flags and main broker preserve native consent before provider send', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-phone-sharing-asar-'))
  let controller
  t.after(async () => { controller?.dispose(); asar.uncacheAll(); await fs.rm(temp, { recursive: true, force: true }) })
  const staging = path.join(temp, 'source'), archive = path.join(temp, 'app.asar')
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.build.files.includes('electron/**/*'), 'Native sharing modules must ship')
  assert.ok(require('./helpers/nativeExclusions.cjs').onlyReviewedNativeExclusions(pkg.build.files), 'Native exclusions require explicit coverage')
  const copied = await stageClosure(staging, ['electron/mobileCompanion.cjs', 'electron/connectedAgent.cjs', 'electron/remoteCompanionGuided.cjs', 'electron/preload.js'])
  // main.js is inspected for its actual injection expression, not executed:
  // running Electron startup would touch the user's desktop and profile.
  await fs.copyFile(path.join(root, 'electron/main.js'), path.join(staging, 'electron/main.js'))
  await asar.createPackage(staging, archive)
  const entries = asar.listPackage(archive).map(entry => entry.replace(/^[/\\]/, '').replaceAll('\\', '/'))
  for (const filename of ['electron/mobileAISharing.cjs', 'electron/mobileCompanion.cjs', 'electron/mobileCompanionControl.cjs',
    'electron/connectedAgent.cjs', 'electron/connectedAgentCodex.cjs', 'electron/connectedAgentFullAccessCodex.cjs',
    'electron/connectedAgentLocalTools.cjs', 'electron/connectedAgentLuna.cjs', 'electron/fundedLunaTransport.cjs',
    'electron/remoteCompanionGuided.cjs', 'electron/preload.js', 'electron/main.js']) {
    assert.ok(entries.includes(filename), `Missing sharing boundary: ${filename}`)
    assert.equal(asar.statFile(archive, filename).unpacked, undefined)
  }
  assert.ok(!entries.some(entry => /(?:^|\/)(?:auth\.json|config\.toml|\.env|phone-account\.json)$/.test(entry)))

  const cache = new Map(), handlers = new Map(), channelCalls = [], sends = [], claims = []
  let bridge, sender, current = true
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'electronAPI') bridge = value } },
    ipcRenderer: { invoke: async (channel, payload) => { channelCalls.push(channel); assert.ok(handlers.has(channel)); return handlers.get(channel)(sender, payload) },
      on() {}, removeListener() {} } }
  function load(filename) {
    filename = path.posix.normalize(filename)
    assert.ok(copied.has(filename), `Import escaped archived native closure: ${filename}`)
    if (cache.has(filename)) return cache.get(filename).exports
    const source = asar.extractFile(archive, filename).toString('utf8'), module = { exports: {} }
    cache.set(filename, module)
    if (filename.endsWith('.json')) { module.exports = JSON.parse(source); return module.exports }
    const requireArchived = specifier => {
      if (specifier.startsWith('.')) return load(path.posix.join(path.posix.dirname(filename), specifier))
      if (specifier === 'electron') return electron
      if (specifier === 'node:child_process' || specifier === 'child_process') return {
        spawn: () => { throw Error('No real process allowed in sharing fixture') },
        execFile: () => { throw Error('No real provider metadata call allowed in sharing fixture') },
      }
      if (builtins.has(specifier)) return require(specifier)
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
      assert.ok(pkg.dependencies?.[name], `Production native dependency missing: ${name}`)
      return packageRequire(specifier)
    }
    vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${source}\n})`, { filename: `${archive}/${filename}` })(
      requireArchived, module, module.exports, `${archive}/${filename}`, path.dirname(`${archive}/${filename}`))
    return module.exports
  }
  const sharing = load('electron/mobileAISharing.cjs'), native = load('electron/connectedAgent.cjs')
  assert.equal(typeof load('electron/mobileCompanion.cjs').registerMobileCompanionIpc, 'function')
  load('electron/preload.js')
  assert.equal(bridge.mobileCompanion.aiSharingVersion, 1)
  assert.equal(bridge.connectedAgent.aiSharingVersion, 1)
  assert.equal(bridge.fundedLuna, undefined, 'No direct credential-bearing broker bridge')
  const capabilities = { tools: false, research: false, fullAccess: false, images: false, view: false }
  const descriptor = sharing.descriptor('codex', capabilities), { capabilities: _, ...consent } = descriptor
  assert.equal(descriptor.recipient, 'openai'); assert.match(descriptor.disclosureKey, /^[a-f0-9]{64}$/)
  assert.notEqual(sharing.descriptor('lmstudio', capabilities).disclosureKey, descriptor.disclosureKey)
  const main = asar.extractFile(archive, 'electron/main.js').toString('utf8')
  const injection = main.match(/claimMobileMessageConsent:\s*(options => mobileCompanion\.claimMessageConsent\(options\))/)
  assert.ok(injection, 'Main must wire accepted native phone commands into connected agent sends')
  assert.match(main, /fundedLuna:\s*mobileCompanion\.fundedLuna/, 'Main wires native funded broker without a provider key')
  const claimMobileMessageConsent = vm.runInNewContext(`(${injection[1]})`, { mobileCompanion: {
    claimMessageConsent(options) {
      claims.push(options)
      assert.equal(sharing.consentMatches(options.request.mobileSharing.consent, sharing.requestSharing(options.request)), true)
      return { assertCurrent() { if (!current) throw sharing.sharingFailure() } }
    },
  } })
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send() {} })
  const window = { webContents: contents, isDestroyed: () => false }
  sender = { sender: contents, senderFrame: contents.mainFrame }
  controller = native.registerConnectedAgentIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    getMainWindow: () => window, claimMobileMessageConsent,
    fundedLuna: {
      status: async () => ({ ok: true, model: 'gpt-6-luna', available: true, remainingMicroUsd: 1000000 }),
      beginTurn: async ({ signal }) => ({ signal, assertCurrent() { assert.equal(signal.aborted, false) },
        status: async () => ({ ok: true, model: 'gpt-6-luna', available: true, remainingMicroUsd: 1000000 }),
        respond: async payload => { sends.push(payload); return { ok: true, model: 'gpt-6-luna', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic funded reply.' }] }] } },
      }),
    },
    executableAccess: { resolve: async () => ({ path: path.join(temp, 'not-a-real-provider') }) },
    codex: { send: async (request, options) => { options.assertBeforeSend(); sends.push(request); return { success: true, text: 'Synthetic response.' } } },
  })
  const request = { provider: 'codex', model: '', requestId: 'archived-message', conversationId: 'synthetic-chat',
    messages: [{ role: 'user', content: 'Synthetic test message.' }], context: {}, images: [], vision: false,
    mobileSharing: { commandId: 'accepted-phone-command', consent, view: false } }
  assert.equal((await bridge.connectedAgent.send(request)).success, true)
  assert.equal(sends.length, 1); assert.equal(claims.length, 1); assert.equal(claims[0].window, window)
  assert.equal(channelCalls.at(-1), native.CHANNELS.send)
  current = false
  const stale = await bridge.connectedAgent.send({ ...request, requestId: 'archived-stale' })
  assert.equal(stale.code, 'AI_SHARING_CHANGED'); assert.equal(stale.promptNotSent, true); assert.equal(sends.length, 1)
  sender = { sender: contents, senderFrame: {} }
  assert.equal((await bridge.connectedAgent.send({ ...request, requestId: 'archived-foreign' })).code, 'UNAUTHORIZED')
  assert.equal(claims.length, 2); assert.equal(sends.length, 1)
  current = true; sender = { sender: contents, senderFrame: contents.mainFrame }
  const { capabilities: lunaCapabilities, ...lunaConsent } = sharing.descriptor('luna', capabilities)
  assert.equal(lunaConsent.recipient, 'velorn-openai')
  const lunaRequest = { ...request, provider: 'luna', model: 'gpt-6-luna', requestId: 'archived-luna',
    mobileSharing: { commandId: 'accepted-luna-command', consent: lunaConsent, view: false } }
  const funded = await bridge.connectedAgent.send(lunaRequest)
  assert.equal(funded.success, true); assert.equal(funded.text, 'Synthetic funded reply.')
  assert.equal(sends.length, 2); assert.deepEqual(Object.keys(sends[1]).sort(), ['input', 'instructions', 'reasoningEffort', 'requestId', 'tools'])
  assert.equal(sends[1].reasoningEffort, 'low')
  const staleRecipient = await bridge.connectedAgent.send({ ...lunaRequest, requestId: 'archived-luna-wrong-consent',
    mobileSharing: { ...lunaRequest.mobileSharing, consent } })
  assert.equal(staleRecipient.success, false); assert.equal(sends.length, 2)
})
