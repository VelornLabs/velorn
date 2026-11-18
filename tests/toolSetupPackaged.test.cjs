'use strict'

// Real archived manager/controller/preload, with synthetic HTTPS bytes and a
// disposable Downloads folder. Does not run an installer, OS command or provider.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path'), os = require('node:os'), vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { builtinModules } = require('node:module')
const { performance } = require('node:perf_hooks')
const { setTimeout: delay } = require('node:timers/promises')
const asar = require('@electron/asar')
const root = path.resolve(__dirname, '..')

async function waitForDownload(readStatus) {
  const deadline = performance.now() + 5000
  while (true) {
    const status = await readStatus()
    assert.equal(status.success, true, JSON.stringify(status))
    if (status.state !== 'downloading') return status
    assert.ok(performance.now() < deadline, `Installer fixture did not finish within 5 seconds: ${JSON.stringify(status)}`)
    await delay(10)
  }
}

test('archived installer/controller/preload closure preserves native approval, owned jobs and no-project metadata', async t => {
  // macOS temporary paths can use /var aliases for /private/var. Keep the
  // synthetic Downloads root canonical without relaxing production checks.
  const output = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-tool-setup-asar-')))
  let controller
  t.after(async () => { controller?.dispose(); asar.uncacheAll(); await fs.rm(output, { recursive: true, force: true }) })
  const staging = path.join(output, 'source'), archive = path.join(output, 'app.asar'), downloads = path.join(output, 'Downloads')
  await fs.mkdir(path.join(staging, 'electron'), { recursive: true }); await fs.mkdir(downloads)
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.build.files.includes('electron/**/*'))
  assert.ok(require('./helpers/nativeExclusions.cjs').onlyReviewedNativeExclusions(pkg.build.files), 'Native exclusions require explicit installer packaging review')
  const files = ['electron/toolSetupIpc.cjs', 'electron/toolSetupInstaller.cjs', 'electron/toolSetupTools.cjs',
    'electron/agentResearchWeb.cjs', 'electron/optionalSetup.cjs', 'electron/preload.js']
  for (const filename of files) await fs.copyFile(path.join(root, filename), path.join(staging, filename))
  await asar.createPackage(staging, archive)
  for (const filename of files) assert.equal(asar.statFile(archive, filename).unpacked, undefined)
  let bridge, currentEvent, activeAgentScope, finalGuardPath
  let replaceInFinalGuard = false
  const rendererEvents = new EventEmitter()
  const handlers = new Map(), calls = [], confirmations = [], opened = [], providers = [], quarantine = []
  const sourceUrl = 'https://dl.todesktop.com/241130tqe9q3y/mac/dmg/arm64'
  const bytes = Buffer.alloc(512); bytes.write('koly', 0)
  const fakeFs = Object.create(fs)
  fakeFs.lstat = async value => {
    if (value === '/Applications' || value.startsWith('/Applications/')) throw Object.assign(new Error('Synthetic app absent'), { code: 'ENOENT' })
    return fs.lstat(value)
  }
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'electronAPI') bridge = value } },
    ipcRenderer: { invoke: (channel, payload) => { assert.ok(handlers.has(channel)); calls.push(['ipc', channel]); return handlers.get(channel)(currentEvent, payload) },
      on: (...args) => rendererEvents.on(...args), removeListener: (...args) => rendererEvents.removeListener(...args) },
  }
  const modules = new Map()
  const builtins = new Set(builtinModules.map(value => value.replace(/^node:/, '')))
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports
    assert.ok(files.includes(filename), `Only archived native dependencies may load: ${filename}`)
    const module = { exports: {} }; modules.set(filename, module)
    const source = asar.extractFile(archive, filename).toString('utf8')
    const requireDependency = name => {
      if (name === 'electron') return electron
      if (name.startsWith('./')) {
        const resolved = path.posix.join(path.posix.dirname(filename), name)
        const value = load(resolved)
        if (resolved === 'electron/toolSetupInstaller.cjs') return { ...value, createToolSetupInstaller: dependencies => value.createToolSetupInstaller({
          ...dependencies, fs: fakeFs, platform: 'darwin', arch: 'arm64', release: '24.0.0', totalmem: 32 * 1024 ** 3,
          homeDir: path.join(output, 'fixture-home'),
          openPath: (file, context) => {
            if (replaceInFinalGuard) finalGuardPath = file
            return dependencies.openPath(file, context)
          },
          markQuarantine: async file => { quarantine.push(file) },
          fetch: async (url, options) => {
            calls.push(['fetch', options.method, url]); assert.equal(url, sourceUrl)
            assert.ok(['HEAD', 'GET'].includes(options.method)); assert.equal(options.credentials, 'omit')
            return { status: 200, url, headers: { 'content-length': '512', 'content-type': 'application/octet-stream', etag: '"fixture-v1"' },
              body: { async *[Symbol.asyncIterator]() {
                if (options.method === 'GET') {
                  // Exercise real elapsed-time waiting, not a number of event
                  // loop turns that can finish before slower CI filesystem IO.
                  await delay(75)
                  yield bytes
                }
              } } }
          },
        }) }
        return value
      }
      assert.ok(name.startsWith('node:') && builtins.has(name.slice(5)), `Unexpected packaged dependency: ${name}`)
      if (name === 'node:https') return { request: () => assert.fail('Real HTTPS forbidden in package fixture') }
      if (name === 'node:dns/promises') return { lookup: () => assert.fail('Real DNS forbidden in package fixture') }
      if (name === 'node:child_process') return { execFile: () => assert.fail('OS commands forbidden in package fixture'), spawn: () => assert.fail('OS commands forbidden in package fixture') }
      return require(name)
    }
    vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: `${archive}/${filename}` })(requireDependency, module, module.exports)
    return module.exports
  }
  const native = load('electron/toolSetupIpc.cjs'), toolCatalog = load('electron/toolSetupTools.cjs')
  const optional = load('electron/optionalSetup.cjs').createOptionalSetup({
    inspectProvider: async payload => { providers.push(payload); return { success: false, code: 'CONNECTION_FAILED' } },
    comfySetup: { discoverRunning: async () => [] }, getConfiguredPort: () => 8188,
  })
  load('electron/preload.js')
  assert.deepEqual(Object.keys(bridge.toolSetup), ['plan', 'download', 'status', 'cancel', 'open', 'agentDownloads', 'onChanged'])
  assert.deepEqual(new Set(Object.values(toolCatalog.methods)), new Set(Object.keys(bridge.toolSetup).filter(name => !['agentDownloads', 'onChanged'].includes(name))))
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false,
    send: (channel, ...values) => rendererEvents.emit(channel, {}, ...values) })
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false })
  currentEvent = { sender: contents, senderFrame: contents.mainFrame }
  const app = Object.assign(new EventEmitter(), { getPath: name => { assert.equal(name, 'downloads'); return downloads } })
  controller = native.createToolSetupController({
    app, getMainWindow: () => window, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    optionalSetup: optional, dialog: { showMessageBox: async (target, config) => { assert.equal(target, window); confirmations.push(config); return { response: 1 } } },
    shell: { openPath: async file => { opened.push(file); return '' } },
    isExportBusy: () => false, getAgentScope: () => activeAgentScope,
    assertAgentCurrent: async scope => {
      assert.equal(scope, activeAgentScope)
      assert.ok(scope, 'External MCP planning must not require project context')
      if (replaceInFinalGuard && finalGuardPath) {
        // Replace only this fixture-owned file inside the controller's final
        // awaited authority guard, before its host-only verification callback.
        await fs.rename(finalGuardPath, `${finalGuardPath}.original`)
        await fs.writeFile(finalGuardPath, bytes)
        replaceInFinalGuard = false
      }
    },
  })
  assert.deepEqual(calls, []); assert.deepEqual(confirmations, []); assert.deepEqual(opened, [])
  currentEvent = { sender: contents, senderFrame: {} }
  assert.equal((await bridge.toolSetup.plan({ integration: 'comfyui' })).code, 'TOOL_SETUP_UNAUTHORIZED')
  currentEvent = { sender: contents, senderFrame: contents.mainFrame }
  const plan = await bridge.toolSetup.plan({ integration: 'comfyui' })
  assert.equal(plan.success, true); assert.equal(plan.download.canDownload, true)
  assert.equal(plan.download.bytes, 512); assert.equal(confirmations.length, 0)
  assert.deepEqual(await fs.readdir(downloads), [], 'Planning does not create a download directory')
  assert.equal((await controller.api.download({ planId: plan.planId })).success, false, 'MCP cannot borrow the desktop plan')
  const job = await bridge.toolSetup.download({ planId: plan.planId })
  assert.equal(job.success, true); assert.equal(confirmations.length, 1)
  const status = await waitForDownload(() => bridge.toolSetup.status({ jobId: job.jobId }))
  assert.equal(status.state, 'completed', JSON.stringify(status)); assert.equal(status.canOpen, true)
  assert.deepEqual(opened, [], 'Completed download is not implicit installer opening')
  const openedResult = await bridge.toolSetup.open({ jobId: job.jobId })
  assert.equal(openedResult.opened, true, JSON.stringify(openedResult))
  assert.equal(confirmations.length, 2); assert.equal(opened.length, 1)
  assert.ok(opened[0].startsWith(path.join(downloads, 'Velorn Setup') + path.sep))
  assert.equal((await fs.readFile(opened[0])).compare(bytes), 0)
  for (const config of confirmations) {
    assert.equal(config.defaultId, 0); assert.equal(config.cancelId, 0)
    assert.ok(config.detail.includes(sourceUrl)); assert.ok(config.detail.includes('512 bytes'))
  }
  await t.test('archived controller detects replacement inside its final async authority guard', async () => {
    const mcpPlan = await controller.api.plan({ integration: 'comfyui' })
    assert.equal(mcpPlan.success, true)
    const mcpJob = await controller.api.download({ planId: mcpPlan.planId })
    assert.equal(mcpJob.success, true)
    const mcpStatus = await waitForDownload(() => controller.api.status({ jobId: mcpJob.jobId }))
    assert.equal(mcpStatus.state, 'completed', JSON.stringify(mcpStatus))
    activeAgentScope = { signal: new AbortController().signal }
    replaceInFinalGuard = true
    const result = await controller.api.open({ jobId: mcpJob.jobId })
    assert.equal(replaceInFinalGuard, false, 'Replacement occurred in the final native authority guard')
    assert.equal(result.code, 'INSTALLER_CHANGED', JSON.stringify(result))
    assert.equal(opened.length, 1, 'Changed installer was never handed to the OS')
    assert.equal((await controller.api.status({ jobId: mcpJob.jobId })).canOpen, false)
    activeAgentScope = undefined
  })
  await t.test('archived agent receipt remains live and user-openable after the requesting turn ends', async () => {
    const events = [], unsubscribe = bridge.toolSetup.onChanged((...values) => events.push(values))
    const query = { projectPath: path.join(output, 'fixture-project'), chatId: 'fixture-chat' }
    const abort = new AbortController(); activeAgentScope = { signal: abort.signal }
    const agentPlan = await controller.api.plan({ integration: 'comfyui' })
    const agentJob = await controller.api.download({ planId: agentPlan.planId })
    assert.equal(agentJob.downloadApproved, true); assert.equal(agentJob.background, true)
    assert.equal(agentJob.state, 'downloading'); assert.equal(agentJob.bytesReceived, 0)
    assert.equal((await bridge.toolSetup.status({ jobId: agentJob.jobId })).success, false)
    abort.abort()
    assert.equal(controller.associateAgentResult('download_tool_installer', { content: [{ type: 'text', text: JSON.stringify(agentJob) }] },
      { chatId: query.chatId, turnId: 'fixture-turn' }, query.projectPath), true)
    assert.deepEqual(events, [[]], 'Preload listener cannot receive native paths or mutable event payloads')
    assert.deepEqual((await bridge.toolSetup.agentDownloads({ ...query, chatId: 'other-chat' })).jobs, [])
    const status = await waitForDownload(async () => (await bridge.toolSetup.agentDownloads(query)).jobs[0])
    assert.equal(status.state, 'completed'); assert.equal(status.turnId, 'fixture-turn'); assert.equal(status.opened, false)
    const approvalCount = confirmations.length, openCount = opened.length
    const result = await bridge.toolSetup.open({ jobId: agentJob.jobId })
    assert.equal(result.opened, true, JSON.stringify(result))
    assert.equal(confirmations.length, approvalCount + 1); assert.equal(opened.length, openCount + 1)
    assert.equal((await bridge.toolSetup.agentDownloads({ ...query })).jobs[0].opened, true)
    assert.deepEqual(events, [[], []])
    unsubscribe()
    assert.equal(rendererEvents.listenerCount('tool-setup:changed'), 0)
    activeAgentScope = undefined
  })
  assert.equal((await bridge.toolSetup.plan({ integration: 'comfyui', sourceUrl: 'https://other.example' })).code, 'TOOL_SETUP_INVALID_REQUEST')
  contents.emit('did-start-navigation', {}, 'file:///new-document.html', false, true)
  assert.equal((await bridge.toolSetup.status({ jobId: job.jobId })).success, false, 'A replacement document cannot access old installer jobs')
  assert.deepEqual(providers, [])
  controller.dispose(); assert.equal(handlers.size, 0)
})
