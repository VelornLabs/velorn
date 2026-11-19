'use strict'
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm')
const { EventEmitter } = require('node:events'), asar = require('@electron/asar')
test('archived native module/preload expose setup only through disabled packaged adapter', async () => {
  const root = path.resolve(__dirname, '..'), output = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-setup-helper-package-'))
  const source = path.join(output, 'source'), archive = path.join(output, 'app.asar')
  const files = ['electron/setupHelper.cjs', 'electron/preload.js', 'electron/setupInstalledApps.cjs']
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.build.files.includes('electron/**/*'))
  await fs.mkdir(path.join(source, 'electron'), { recursive: true })
  for (const file of files) await fs.copyFile(path.join(root, file), path.join(source, file))
  await asar.createPackage(source, archive)
  let bridge
  const handlers = new Map(), app = Object.assign(new EventEmitter(), { isPackaged: true }), contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false }),
    window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false }), event = { sender: contents, senderFrame: contents.mainFrame }
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'electronAPI') bridge = value } },
    ipcRenderer: { invoke: (channel, payload) => handlers.get(channel)(event, payload), on() {}, removeListener() {} } }
  const runtime = { fetch: globalThis.fetch, navigator: { userActivation: { isActive: false } } }
  const load = file => {
    assert.equal(asar.statFile(archive, file).unpacked, undefined)
    const module = { exports: {} }
    vm.runInThisContext(`(function(require,module,exports,globalThis){${asar.extractFile(archive, file).toString('utf8')}\n})`, { filename: `${archive}/${file}` })(name => {
      if (name === 'electron') return electron
      assert.ok(['node:fs/promises', 'node:path', 'node:child_process'].includes(name)); return require(name)
    }, module, module.exports, runtime)
    return module.exports
  }
  const native = load(files[0]); load(files[1])
  const installed = load(files[2]).createSetupInstalledApps({ app, fs: {}, environment: {}, spawn: () => { throw Error('No real process') } })
  assert.equal((await installed.inspect({ integration: 'lmstudio' })).state, 'unknown')
  let paidCalls = 0, guideOpens = 0
  const helper = native.createSetupHelper({ app, installedApps: installed, openGuide: async () => { guideOpens++ }, env: { VELORN_SETUP_LUNA_ENABLED: '1', VELORN_SETUP_OPENAI_API_KEY: 'synthetic-secret-not-a-real-key' }, fetchImpl: () => { paidCalls++; throw new Error('Must not be called') } })
  const controller = native.registerSetupHelperIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) }, app, getMainWindow: () => window, helper })
  assert.deepEqual(Object.keys(bridge.setupHelper).sort(), ['cancel', 'performAction', 'reset', 'send', 'status'])
  assert.equal((await bridge.setupHelper.status({})).available, false)
  assert.equal((await bridge.setupHelper.send({ integration: 'codex', message: 'Help connect' })).code, 'SETUP_HELPER_UNAVAILABLE')
  assert.equal((await bridge.setupHelper.reset({})).success, true); assert.equal((await bridge.setupHelper.cancel({})).success, true)
  await assert.rejects(bridge.setupHelper.performAction({ integration: 'lmstudio', action: 'connection_guide' }), /Choose a setup action yourself/)
  assert.equal(guideOpens, 0)
  runtime.navigator.userActivation.isActive = true
  assert.equal((await bridge.setupHelper.performAction({ integration: 'lmstudio', action: 'connection_guide', url: 'https://evil.test' })).success, false)
  assert.equal((await bridge.setupHelper.performAction({ integration: 'lmstudio', action: 'connection_guide' })).success, true)
  assert.equal(guideOpens, 1)
  assert.equal(paidCalls, 0); controller.dispose(); assert.equal(handlers.size, 0)
})

test('real ASAR bridge preserves local model privacy and verified ComfyUI/Codex navigation-only setup', async () => {
  const root = path.resolve(__dirname, '..'), output = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-setup-helper-models-package-'))
  const source = path.join(output, 'source'), archive = path.join(output, 'app.asar')
  const files = ['electron/setupHelper.cjs', 'electron/preload.js', 'electron/optionalSetup.cjs']
  await fs.mkdir(path.join(source, 'electron'), { recursive: true })
  for (const file of files) await fs.copyFile(path.join(root, file), path.join(source, file))
  await asar.createPackage(source, archive)
  let bridge
  const handlers = new Map(), app = Object.assign(new EventEmitter(), { isPackaged: false }),
    contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false }),
    window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false }),
    event = { sender: contents, senderFrame: contents.mainFrame }
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'electronAPI') bridge = value } },
    ipcRenderer: { invoke: (channel, payload) => handlers.get(channel)(event, payload), on() {}, removeListener() {} } }
  const runtime = { fetch: globalThis.fetch, navigator: { userActivation: { isActive: false } } }
  const load = file => {
    assert.equal(asar.statFile(archive, file).unpacked, undefined)
    const module = { exports: {} }
    vm.runInThisContext(`(function(require,module,exports,globalThis){${asar.extractFile(archive, file).toString('utf8')}\n})`, { filename: `${archive}/${file}` })(name => {
      assert.equal(name, 'electron'); return electron
    }, module, module.exports, runtime)
    return module.exports
  }
  const native = load(files[0]); load(files[1])
  const key = 'synthetic-private-model-test-key'
  let provider = { success: true, loadedModelStatus: 'available', models: [
    { id: 'publisher/native-chat-model', displayName: 'Native Chat Model Q4', loaded: true },
    { id: 'publisher/second-local-model', displayName: '/private/unsafe-label', loaded: true },
    { id: 'publisher/downloaded-not-loaded', loaded: false },
    { id: '/private/model-path', displayName: 'Unsafe identity', loaded: true },
    { id: key, loaded: true },
  ] }
  let comfyPorts = [8189]
  const optionalSetup = load(files[2]).createOptionalSetup({ inspectProvider: async () => provider,
    getConfiguredPort: async () => 8189,
    comfySetup: { discoverRunning: async () => comfyPorts.map(port => ({ port, deviceNames: ['PRIVATE_GPU'], rawPath: '/private/comfy' })) },
  })
  const bodies = [], replies = []
  const checkReply = (integration = 'lmstudio') => ({ status: 'completed', output: [{ type: 'function_call', name: 'get_setup_status', call_id: 'call_1', arguments: JSON.stringify({ integration }) }] })
  const finalReply = () => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'See the native setup check.' }] }] })
  const helper = native.createSetupHelper({ app, optionalSetup, env: { VELORN_SETUP_LUNA_ENABLED: '1', VELORN_SETUP_OPENAI_API_KEY: key },
    fetchImpl: async (_url, request) => { bodies.push(JSON.parse(request.body)); return new Response(JSON.stringify(replies.shift() || finalReply())) },
  })
  const controller = native.registerSetupHelperIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) }, app, getMainWindow: () => window, helper })
  try {
    // ASAR availability still follows the app flag, not archive presence. This
    // synthetic internal runtime exercises the actual bridge without networking.
    assert.equal((await bridge.setupHelper.status({})).available, true)
    assert.equal((await handlers.get(native.CHANNELS.send)({ sender: contents, senderFrame: {} }, { integration: 'lmstudio', message: 'Check.' })).code, 'SETUP_HELPER_UNAUTHORIZED')
    assert.equal(bodies.length, 0)
    replies.push(checkReply(), finalReply())
    const first = await bridge.setupHelper.send({ integration: 'lmstudio', message: 'Check the server.' })
    assert.equal(first.success, true)
    assert.deepEqual(first.checks[0].loadedModels, { verified: true, names: ['Native Chat Model Q4', 'publisher/second-local-model'], truncated: false })
    assert.doesNotMatch(JSON.stringify(first), /private|Unsafe identity|downloaded-not-loaded|synthetic/)
    assert.equal(Object.hasOwn(JSON.parse(bodies[1].input.at(-1).output), 'loadedModels'), false)
    await bridge.setupHelper.send({ integration: 'lmstudio', message: 'What next?' })
    assert.match(JSON.stringify(bodies.at(-1).input), /Prior native setup check/)
    assert.doesNotMatch(JSON.stringify(bodies), /native-chat-model|Native Chat Model|second-local-model|downloaded-not-loaded|loadedModels|synthetic-private/)
    provider = { success: true, loadedModelStatus: 'unavailable', models: [{ id: 'publisher/native-chat-model', loaded: true }] }
    replies.push(checkReply(), finalReply())
    const unknown = await bridge.setupHelper.send({ integration: 'lmstudio', message: 'Check again.' })
    assert.equal(unknown.checks[0].state, 'problem')
    assert.equal(Object.hasOwn(unknown.checks[0], 'loadedModels'), false)
    assert.doesNotMatch(JSON.stringify(bodies), /native-chat-model|loadedModels/)
    replies.push(checkReply('comfyui'), { status: 'completed', output: [{ type: 'function_call', name: 'request_setup_action', call_id: 'configure_comfy', arguments: JSON.stringify({ integration: 'comfyui', action: 'configure' }) }] }, finalReply())
    const comfy = await bridge.setupHelper.send({ integration: 'comfyui', message: 'Check my existing ComfyUI connection, then show me where I can start and stop it. Don’t start, stop, restart, install, or change anything.' })
    // Inspect the first request, before the scripted tool selection. The shipped
    // model context must explain configure up front, not only return its label.
    const firstComfyRequest = bodies.at(-3)
    assert.match(firstComfyRequest.instructions, /integration=comfyui and action=configure/)
    assert.match(firstComfyRequest.instructions, /do not start, stop or change anything.*still calls for configure, not a guide/)
    const actionTool = firstComfyRequest.tools.find(tool => tool.name === 'request_setup_action')
    assert.match(actionTool.description, /For ComfyUI, configure offers Open ComfyUI controls/)
    assert.match(actionTool.parameters.properties.action.description, /external official documentation, NOT Velorn's controls/)
    assert.deepEqual(actionTool.parameters.properties.action.enum, ['check', 'configure', 'install', 'credentials', 'open_app', 'choose_app', 'installation_guide', 'connection_guide'])
    assert.equal(comfy.checks[0].state, 'ready')
    assert.equal(comfy.checks[0].configuredPort, 8189)
    assert.deepEqual(comfy.checks[0].ports, [8189])
    assert.match(comfy.checks[0].summary, /Models and workflows were not checked/)
    assert.deepEqual(comfy.actions, [{ integration: 'comfyui', action: 'configure' }])
    assert.deepEqual(JSON.parse(bodies.at(-1).input.at(-1).output), { offered: true, executed: false, userClickRequired: true, integration: 'comfyui', action: 'configure', label: 'Open ComfyUI controls' })
    runtime.navigator.userActivation.isActive = true
    assert.equal((await bridge.setupHelper.performAction({ integration: 'comfyui', action: 'configure' })).success, false, 'Navigation must never become a native lifecycle action')
    comfyPorts = [8188]
    replies.push(checkReply('comfyui'), finalReply())
    const changed = await bridge.setupHelper.send({ integration: 'comfyui', message: 'Check again.' })
    assert.equal(changed.checks[0].state, 'unavailable')
    assert.deepEqual(changed.checks[0].ports, [8188])
    assert.doesNotMatch(JSON.stringify([comfy, changed, bodies]), /PRIVATE_GPU|private\/comfy/)
    provider = { installed: true, available: true, signedIn: true, authMode: 'chatgpt',
      models: [{ id: 'PRIVATE_CODEX_MODEL' }], account: 'private-account@example.invalid', path: '/private/codex' }
    replies.push(checkReply('codex'), { status: 'completed', output: [{ type: 'function_call', name: 'request_setup_action', call_id: 'configure_codex', arguments: JSON.stringify({ integration: 'codex', action: 'configure' }) }] }, finalReply())
    const codex = await bridge.setupHelper.send({ integration: 'codex', message: 'Check Codex and show its setup controls. Do not sign me in or out or send a test prompt.' })
    assert.deepEqual(codex.checks, [{ integration: 'codex', state: 'ready', summary: 'Codex CLI is signed in through ChatGPT. No Codex prompt was sent.' }])
    assert.deepEqual(codex.actions, [{ integration: 'codex', action: 'configure' }])
    assert.deepEqual(JSON.parse(bodies.at(-1).input.at(-1).output), { offered: true, executed: false, userClickRequired: true, integration: 'codex', action: 'configure', label: 'Open Codex setup controls' })
    assert.equal((await bridge.setupHelper.performAction({ integration: 'codex', action: 'configure' })).success, false)
    for (const [details, state] of [
      [{ signedIn: false }, 'signin'], [{ authMode: 'api-key' }, 'signin'], [{ available: false, authMode: 'chatgpt', signedIn: true }, 'problem'],
    ]) {
      provider = { installed: true, available: true, signedIn: true, authMode: 'chatgpt', ...details }
      replies.push(checkReply('codex'), finalReply())
      const next = await bridge.setupHelper.send({ integration: 'codex', message: 'Check Codex again.' })
      assert.equal(next.checks[0].state, state)
      assert.deepEqual(next.actions, [])
    }
    assert.doesNotMatch(JSON.stringify([codex, bodies]), /PRIVATE_CODEX_MODEL|private-account|private\/codex/)
  } finally { controller.dispose() }
  assert.equal(handlers.size, 0)
})

test('archived Luna reads hosted account evidence without rechecking Comfy or acquiring credential authority', async t => {
  const root = path.resolve(__dirname, '..'), output = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-helper-hosted-package-'))
  const source = path.join(output, 'source'), archive = path.join(output, 'app.asar'), profile = path.join(output, 'isolated-profile')
  const files = ['electron/setupHelper.cjs', 'electron/comfyHostedSetup.cjs', 'electron/preload.js', 'electron/main.js']
  await fs.mkdir(path.join(source, 'electron'), { recursive: true }); await fs.mkdir(profile)
  for (const file of files) await fs.copyFile(path.join(root, file), path.join(source, file))
  await asar.createPackage(source, archive)
  let controller, hosted, bridge
  t.after(async () => { controller?.dispose(); hosted?.dispose(); asar.uncacheAll(); await fs.rm(output, { recursive: true, force: true }) })
  const sources = Object.fromEntries(files.map(file => {
    assert.equal(asar.statFile(archive, file).unpacked, undefined)
    return [file, asar.extractFile(archive, file).toString('utf8')]
  }))
  const main = sources['electron/main.js']
  assert.match(main, /getHostedStatus:\s*options\s*=>\s*comfyHostedSetup\.readStatus\(options\)/)
  assert.match(main, /comfyHostedSetup\s*=\s*createComfyHostedSetup\(/)
  const handlers = new Map(), app = Object.assign(new EventEmitter(), { isPackaged: false,
    getPath: name => { assert.equal(name, 'userData'); return profile } })
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false })
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const ipcMain = { handle: (name, callback) => { assert.ok(!handlers.has(name)); handlers.set(name, callback) }, removeHandler: name => handlers.delete(name) }
  const runtime = { navigator: { userActivation: { isActive: false } }, fetch: () => assert.fail('No ambient network') }
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'electronAPI') bridge = value } },
    ipcRenderer: { invoke: (name, payload) => handlers.get(name)(event, payload), on() {}, removeListener() {} } }
  const load = file => {
    const module = { exports: {} }
    vm.runInThisContext(`(function(require,module,exports,globalThis){${sources[file]}\n})`, { filename: `${archive}/${file}` })(name => {
      if (name === 'electron') return electron
      assert.ok(['node:fs', 'node:fs/promises', 'node:path', 'node:crypto'].includes(name)); return require(name)
    }, module, module.exports, runtime)
    return module.exports
  }
  const helperNative = load(files[0]), hostedNative = load(files[1]); load(files[2])
  assert.deepEqual(Object.keys(bridge.comfyHostedSetup).sort(), ['cancel', 'check', 'clear', 'openGuide', 'status'])
  assert.equal(bridge.comfyHostedSetup.readStatus, undefined)
  const hostedKey = 'synthetic-comfy-cloud-private-key', lunaKey = 'synthetic-private-luna-key'
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: value => Buffer.from(`test-encrypted:${Buffer.from(value).toString('base64')}`),
    decryptString: value => Buffer.from(value.toString().slice('test-encrypted:'.length), 'base64').toString() }
  let accountCalls = 0, accountReply = { status: 'active', private_account: 'do-not-send-account-data' }
  const createHosted = () => hostedNative.createComfyHostedSetup({ ipcMain, app, getMainWindow: () => window, safeStorage, platform: 'linux',
    fetchImpl: async (url, request) => {
      accountCalls++; assert.equal(url, hostedNative.ENDPOINT); assert.equal(request.method, 'GET')
      return new Response(JSON.stringify(accountReply))
    }, openExternal: () => assert.fail('Luna status reads must not open external pages'),
  })
  hosted = createHosted()
  const bodies = [], replies = [], guideOpens = []
  let override
  const helper = helperNative.createSetupHelper({ app,
    optionalSetup: { inspect: () => assert.fail('Hosted status must not inspect local integrations') },
    installedApps: { inspect: () => assert.fail('Hosted status must not inspect installed apps') },
    getHostedStatus: async options => override === undefined ? hosted.readStatus(options) : override,
    openGuide: async url => { guideOpens.push(url) },
    env: { VELORN_SETUP_LUNA_ENABLED: '1', VELORN_SETUP_OPENAI_API_KEY: lunaKey },
    fetchImpl: async (url, request) => {
      assert.equal(url, helperNative.ENDPOINT); bodies.push(JSON.parse(request.body))
      assert.ok(replies.length, 'Only expected synthetic model responses may be requested')
      return new Response(JSON.stringify(replies.shift()))
    },
  })
  controller = helperNative.registerSetupHelperIpc({ ipcMain, app, getMainWindow: () => window, helper })
  const modelCall = (name, args, call_id) => ({ status: 'completed', output: [{ type: 'function_call', name, call_id, arguments: JSON.stringify(args) }] })
  const final = () => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'This is stored account evidence, not a new online check.' }] }] })
  async function inspect({ configure = false } = {}) {
    const before = accountCalls
    replies.push(modelCall('get_setup_status', { integration: 'comfycloud' }, 'hosted_status'))
    if (configure) replies.push(modelCall('request_setup_action', { integration: 'comfycloud', action: 'configure' }, 'hosted_controls'))
    replies.push(final())
    const result = await bridge.setupHelper.send({ integration: 'comfycloud', message: 'Read the existing hosted account status without rechecking it online.' })
    assert.equal(result.success, true)
    assert.equal(accountCalls, before, 'Luna must never call the Comfy account endpoint')
    assert.equal(result.checks[0].evidence, 'stored-account-check')
    assert.notEqual(result.checks[0].state, 'ready')
    assert.doesNotMatch(JSON.stringify([result, bodies]), /synthetic-comfy-cloud-private-key|synthetic-private-luna-key|do-not-send-account-data|test-encrypted|canRemember|remembered|credential\.enc/)
    return result
  }
  const missing = await inspect()
  assert.equal(missing.checks[0].state, 'missing'); assert.equal(accountCalls, 0)
  const checkTool = bodies[0].tools.find(tool => tool.name === 'get_setup_status')
  assert.ok(checkTool.parameters.properties.integration.enum.includes('comfycloud'))
  assert.match(bodies[0].instructions, /stored|earlier|existing|previous/)
  runtime.navigator.userActivation.isActive = true
  const checked = await bridge.comfyHostedSetup.check({ key: hostedKey, remember: true })
  assert.equal(checked.state, 'verified'); assert.equal(accountCalls, 1)
  const saved = await fs.readFile(path.join(profile, hostedNative.FILE_NAME))
  const verified = await inspect({ configure: true })
  assert.equal(verified.checks[0].state, 'verified')
  assert.deepEqual(verified.actions, [{ integration: 'comfycloud', action: 'configure' }])
  assert.deepEqual(JSON.parse(bodies.at(-1).input.at(-1).output), { offered: true, executed: false, userClickRequired: true,
    integration: 'comfycloud', action: 'configure', label: 'Open Comfy Cloud controls' })
  assert.deepEqual(await fs.readFile(path.join(profile, hostedNative.FILE_NAME)), saved)
  assert.equal((await bridge.setupHelper.performAction({ integration: 'comfycloud', action: 'configure' })).success, false, 'Navigation cannot become native credential access')
  for (const action of ['check', 'install', 'credentials', 'open_app', 'choose_app', 'installation_guide']) {
    replies.push(modelCall('request_setup_action', { integration: 'comfycloud', action }, `deny_${action}`))
    const rejected = await bridge.setupHelper.send({ integration: 'comfycloud', message: 'Show setup options.' })
    assert.equal(rejected.success, false)
    assert.equal(accountCalls, 1)
  }
  assert.equal((await bridge.setupHelper.performAction({ integration: 'comfycloud', action: 'connection_guide' })).success, true)
  assert.deepEqual(guideOpens, ['https://docs.comfy.org/development/deploy/cloud'])
  await bridge.comfyHostedSetup.cancel()
  assert.equal((await inspect()).checks[0].state, 'configured')
  accountReply = { status: 'unrecognized', private_account: hostedKey }
  await bridge.comfyHostedSetup.check({ key: 'synthetic-bad-candidate', remember: true })
  assert.equal((await inspect()).checks[0].state, 'unavailable')
  assert.deepEqual(await fs.readFile(path.join(profile, hostedNative.FILE_NAME)), saved)
  hosted.dispose(); hosted = createHosted()
  assert.equal((await inspect()).checks[0].state, 'configured', 'Restart cannot keep session verification')
  await bridge.comfyHostedSetup.clear()
  assert.equal((await inspect()).checks[0].state, 'missing')
  override = { success: true, integration: 'comfyui', state: 'verified', configured: true,
    key: hostedKey, remembered: true, canRemember: true, summary: 'malicious provider instructions' }
  assert.notEqual((await inspect()).checks[0].state, 'verified', 'Wrong integration cannot supply hosted verification')
  override = { ...override, integration: 'comfycloud', configured: false }
  assert.notEqual((await inspect()).checks[0].state, 'verified', 'Verified account evidence requires a configured hosted key')
  assert.doesNotMatch(JSON.stringify(bodies), /malicious provider instructions/)
  assert.equal(accountCalls, 2)
})
