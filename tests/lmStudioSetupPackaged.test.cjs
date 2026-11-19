'use strict'

// Execute the actual archived preload/controller/manager/runtime closure with
// synthetic metadata, model bytes and a disposable LM Studio home. No network,
// model inference, provider credentials or real OS commands are permitted.
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm')
const { EventEmitter } = require('node:events'), { builtinModules } = require('node:module')
const { createHash } = require('node:crypto'), { performance } = require('node:perf_hooks')
const { setTimeout: delay } = require('node:timers/promises')
const asar = require('@electron/asar')
const root = path.resolve(__dirname, '..')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function until(read, predicate, description) {
  const deadline = performance.now() + 5000
  for (;;) {
    const value = await read()
    if (predicate(value)) return value
    assert.ok(performance.now() < deadline, `${description}: ${JSON.stringify(value)}`)
    await delay(10)
  }
}

test('archived LM model setup preserves native reviews, real progress, exact ownership and separate verified loading', async t => {
  const output = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-lm-model-asar-')))
  const stage = path.join(output, 'source'), archive = path.join(output, 'app.asar'), home = path.join(output, 'home')
  const lmHome = path.join(home, '.lmstudio'), modelsRoot = path.join(home, 'models'), settings = path.join(lmHome, 'settings.json')
  let controller, manager
  const transferGates = new Map()
  t.after(async () => {
    for (const gate of transferGates.values()) gate.resolve()
    controller?.dispose(); await manager?.dispose(); asar.uncacheAll()
    await fs.rm(output, { recursive: true, force: true })
  })
  await fs.mkdir(path.join(stage, 'electron'), { recursive: true })
  await fs.mkdir(path.join(lmHome, 'bin'), { recursive: true }); await fs.mkdir(modelsRoot)
  const lms = path.join(lmHome, 'bin', 'lms')
  await fs.writeFile(lms, 'synthetic CLI; must never execute\n', { mode: 0o700 })
  const initialSettings = JSON.stringify({ downloadsFolder: modelsRoot, fixturePreference: 'unchanged' })
  await fs.writeFile(settings, initialSettings)
  const unrelated = path.join(modelsRoot, 'existing-user-model.gguf')
  await fs.writeFile(unrelated, 'existing model must survive')
  const providerSettings = Object.freeze({ agent: 'codex', model: 'existing-model', chatId: 'original-chat', fullAccess: true })
  const initialProvider = JSON.stringify(providerSettings)
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.build.files.includes('electron/**/*'))
  assert.ok(require('./helpers/nativeExclusions.cjs').onlyReviewedNativeExclusions(pkg.build.files), 'Native exclusions require model setup packaging review')
  const files = ['electron/lmStudioSetupIpc.cjs', 'electron/lmStudioModelSetup.cjs', 'electron/lmStudioSetupRuntime.cjs',
    'electron/lmStudioSetupTools.cjs', 'electron/agentResearchWeb.cjs', 'electron/preload.js']
  for (const file of files) await fs.copyFile(path.join(root, file), path.join(stage, file))
  await asar.createPackage(stage, archive)
  for (const file of files) assert.equal(asar.statFile(archive, file).unpacked, undefined)

  const repository = 'synthetic-publisher/synthetic-GGUF', revision = 'a'.repeat(40)
  const bytes = Buffer.alloc(4096, 12); bytes.write('GGUF', 0); bytes.writeUInt32LE(3, 4)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const handlers = new Map(), rendererEvents = new EventEmitter(), modules = new Map()
  const network = [], commands = [], confirmations = [], loaded = new Map(), loadedContexts = new Map(), models = new Map(), waiting = []
  let bridge, currentEvent, scope = null, exportBusy = false, approve = true, serverRunning = false, authRequired = false, approvalGate, flipExportBeforeLink = false
  const syntheticFs = Object.create(fs)
  syntheticFs.lstat = async filename => {
    const stat = await fs.lstat(filename)
    // Cross the last awaited filesystem boundary after ordinary async guards
    // have passed. Only the real synchronous host commit guard can reject this.
    if (flipExportBeforeLink && filename.endsWith('.partial')) {
      flipExportBeforeLink = false; exportBusy = true
    }
    return stat
  }
  function jsonResponse(url, data, status = 200) {
    const body = Buffer.from(JSON.stringify(data))
    return { status, url, headers: { 'content-type': 'application/json' }, body: { async *[Symbol.asyncIterator]() { yield body } } }
  }
  async function downloadedRows() {
    const rows = []
    for (const model of models.values()) {
      try {
        if ((await fs.stat(path.join(modelsRoot, repository, model.filename))).size === bytes.length) rows.push({
          type: 'llm', path: `${repository}/${model.filename}`, modelKey: model.key, sizeBytes: bytes.length,
        })
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return rows
  }
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'electronAPI') bridge = value } },
    ipcRenderer: { invoke: (channel, payload) => { assert.ok(handlers.has(channel), `Unexpected IPC: ${channel}`); return handlers.get(channel)(currentEvent, payload) },
      on: (...args) => rendererEvents.on(...args), removeListener: (...args) => rendererEvents.removeListener(...args) },
  }
  const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')))
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports
    assert.ok(files.includes(file), `Unexpected packaged dependency: ${file}`)
    const module = { exports: {} }; modules.set(file, module)
    function requireDependency(name) {
      if (name === 'electron') return electron
      if (name.startsWith('./')) {
        const resolved = path.posix.join(path.posix.dirname(file), name), value = load(resolved)
        if (resolved === 'electron/lmStudioModelSetup.cjs') return { ...value, createLmStudioModelSetup: dependencies => {
          manager = value.createLmStudioModelSetup({ ...dependencies, fs: syntheticFs, getHomePath: () => home,
            fetchPublic: async (url, options) => {
              network.push(['public', options.method, url])
              assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual')
              assert.equal(new URL(url).origin, 'https://huggingface.co')
              if (url.startsWith(`https://huggingface.co/api/models/${repository}`)) {
                assert.ok([`https://huggingface.co/api/models/${repository}?blobs=true`, `https://huggingface.co/api/models/${repository}/revision/${revision}?blobs=true`].includes(url))
                return jsonResponse(url, { id: repository, sha: revision, private: false, gated: false,
                  cardData: { license: 'apache-2.0' }, siblings: [...models.values()].map(model => ({ rfilename: model.filename, size: bytes.length, lfs: { size: bytes.length, sha256 } })) })
              }
              const filename = url.slice(url.lastIndexOf('/') + 1)
              assert.ok(models.has(filename)); assert.equal(url, `https://huggingface.co/${repository}/resolve/${revision}/${filename}`)
              const gate = deferred(); transferGates.set(filename, gate)
              return { status: 200, url, headers: { 'content-length': String(bytes.length), 'content-type': 'application/octet-stream' },
                body: { async *[Symbol.asyncIterator]() { yield bytes.subarray(0, 64); await gate.promise; yield bytes.subarray(64) } } }
            },
            fetchLocal: async (url, options) => {
              network.push(['local', options.method, url])
              assert.ok(['http://127.0.0.1:1234/api/v1/models', 'http://127.0.0.1:1234/api/v1/models/load'].includes(url))
              assert.equal(options.redirect, 'error'); assert.ok(!options.headers?.Authorization)
              if (!serverRunning) throw Error('Synthetic local service not started')
              if (authRequired) return jsonResponse(url, { error: 'fixture auth required' }, 401)
              if (options.method === 'POST') {
                assert.equal(url, 'http://127.0.0.1:1234/api/v1/models/load')
                const payload = JSON.parse(options.body)
                assert.deepEqual(Object.keys(payload), ['model', 'context_length', 'echo_load_config'])
                const selected = [...models.values()].find(model => model.key === payload.model)
                assert.ok(selected)
                assert.equal(payload.context_length, Math.min(32768, selected.maxContext)); assert.equal(payload.echo_load_config, true)
                assert.ok((await downloadedRows()).some(row => row.modelKey === payload.model))
                loaded.set(payload.model, `instance-${loaded.size + 1}`)
                loadedContexts.set(payload.model, Object.hasOwn(selected, 'actualContext') ? selected.actualContext : payload.context_length)
                return jsonResponse(url, { status: 'loaded', type: 'llm', instance_id: loaded.get(payload.model),
                  load_config: { context_length: loadedContexts.get(payload.model) } })
              }
              assert.equal(options.method, 'GET')
              return jsonResponse(url, { models: (await downloadedRows()).map(row => ({ type: 'llm', key: row.modelKey,
                size_bytes: row.sizeBytes, max_context_length: [...models.values()].find(model => model.key === row.modelKey)?.maxContext,
                loaded_instances: loaded.has(row.modelKey) ? [{ id: loaded.get(row.modelKey), config: { context_length: loadedContexts.get(row.modelKey) } }] : [] })) })
            },
          })
          return manager
        } }
        return value
      }
      assert.ok(name.startsWith('node:') && builtins.has(name.slice(5)), `Unexpected dependency: ${name}`)
      if (name === 'node:https') return { request: () => assert.fail('Real HTTPS forbidden') }
      if (name === 'node:dns/promises') return { lookup: () => assert.fail('Real DNS forbidden') }
      if (name === 'node:child_process') return { execFile: () => assert.fail('Real OS command forbidden'), spawn: () => assert.fail('Real OS command forbidden') }
      return require(name)
    }
    vm.runInThisContext(`(function(require,module,exports){${asar.extractFile(archive, file).toString('utf8')}\n})`, { filename: `${archive}/${file}` })(requireDependency, module, module.exports)
    return module.exports
  }
  const native = load('electron/lmStudioSetupIpc.cjs'), tools = load('electron/lmStudioSetupTools.cjs')
  const runtime = load('electron/lmStudioSetupRuntime.cjs').createLmStudioSetupRuntime({ getHomePath: () => home, platform: 'darwin',
    env: { NODE_OPTIONS: 'must-not-inherit', OPENAI_API_KEY: 'synthetic-only', HTTPS_PROXY: 'must-not-inherit', LM_STUDIO_HOST: 'remote.invalid' },
    run: (executable, args, options, callback) => {
      assert.equal(executable, lms); assert.equal(options.shell, false); assert.equal(options.cwd, home)
      assert.deepEqual(options.env, { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NO_COLOR: '1' })
      commands.push(args)
      if (args[0] === 'ls') {
        assert.deepEqual(args, ['ls', '--json', '--host', '127.0.0.1', '--port', '1234'])
        downloadedRows().then(rows => callback(null, JSON.stringify(rows)), callback)
      } else if (args.at(-1) === '--help') {
        assert.deepEqual(args, ['server', 'start', '--help']); callback(null, 'Usage: server start --port <port> --bind <address>')
      } else {
        assert.deepEqual(args, ['server', 'start', '--port', '1234', '--bind', '127.0.0.1']); serverRunning = true; callback(null, 'Started')
      }
    },
  })
  load('electron/preload.js')
  assert.deepEqual(Object.keys(bridge.lmStudioSetup), ['plan', 'download', 'status', 'cancel', 'load', 'agentDownloads', 'onChanged'])
  assert.deepEqual(new Set(Object.values(tools.methods)), new Set(['plan', 'download', 'status', 'cancel', 'load']))
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: (channel, ...values) => rendererEvents.emit(channel, {}, ...values) })
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false })
  currentEvent = { sender: contents, senderFrame: contents.mainFrame }
  controller = native.createLmStudioSetupController({ runtime, getMainWindow: () => window, app: new EventEmitter(),
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    isExportBusy: () => exportBusy, getAgentScope: () => scope,
    assertAgentCurrent: async value => { assert.equal(value, scope); assert.equal(value.signal.aborted, false) },
    dialog: { showMessageBox: async (target, config) => { assert.equal(target, window); confirmations.push(config); if (approvalGate) await approvalGate.promise; return { response: approve ? 1 : 0 } } },
  })
  const bridgeApi = bridge.lmStudioSetup
  const choice = (name, config = {}) => { const filename = `${name}-Q4_K_M.gguf`; models.set(filename, { filename, key: `fixture/${name}`, maxContext: 131072, ...config }); return { repository, filename } }
  const settled = (job, api = bridgeApi) => until(() => api.status({ jobId: job.jobId }), value => value.success && !['downloading', 'loading'].includes(value.state), 'Job did not settle')
  async function begin(model, api = bridgeApi) {
    const plan = await api.plan(model); assert.equal(plan.success, true, JSON.stringify(plan))
    const job = await api.download({ planId: plan.planId }); assert.equal(job.success, true, JSON.stringify(job))
    return { plan, job }
  }
  async function received(job, api = bridgeApi) {
    const progress = await until(() => api.status({ jobId: job.jobId }), value => value.success && value.bytesReceived === 64, 'Owned transfer did not report progress')
    assert.equal(progress.state, 'downloading'); assert.equal(progress.canLoad, false)
  }
  async function finish(model, job, api = bridgeApi) { await received(job, api); transferGates.get(model.filename).resolve(); const result = await settled(job, api); assert.equal(result.state, 'completed', JSON.stringify(result)); return result }

  await t.test('archived construction and plan are passive; renderer cannot provide authority or borrow MCP ownership', async () => {
    assert.deepEqual(network, []); assert.deepEqual(commands, []); assert.deepEqual(confirmations, [])
    const model = choice('desktop'), event = currentEvent
    currentEvent = { ...event, senderFrame: {} }
    assert.equal((await bridgeApi.plan(model)).code, 'LM_STUDIO_SETUP_UNAUTHORIZED'); assert.deepEqual(network, [])
    currentEvent = event
    assert.equal((await bridgeApi.plan({ ...model, destination: '/spoof' })).success, false)
    const plan = await bridgeApi.plan(model)
    assert.equal(plan.bytes, bytes.length); assert.equal(plan.sha256, sha256); assert.equal(plan.canDownload, true)
    assert.equal(plan.destination, `LM Studio models/${repository}/${model.filename}`)
    assert.ok(!JSON.stringify(plan).includes(home)); assert.equal(network.length, 2)
    assert.deepEqual(await fs.readdir(modelsRoot), [path.basename(unrelated)])
    assert.equal((await controller.api.download({ planId: plan.planId })).success, false)
    assert.deepEqual(confirmations, []); assert.deepEqual(commands, [])
    approve = false
    assert.equal((await bridgeApi.download({ planId: plan.planId })).code, 'DECLINED')
    assert.equal(network.length, 2); assert.deepEqual(await fs.readdir(modelsRoot), [path.basename(unrelated)])
    approve = true
    const job = await bridgeApi.download({ planId: plan.planId })
    assert.equal(job.downloadApproved, true); assert.equal(job.background, true); assert.equal(job.state, 'downloading'); assert.equal(job.bytesReceived, 0)
    const result = await finish(model, job)
    assert.equal(result.canLoad, true); assert.equal(result.connectionVerified, false)
    assert.deepEqual(await fs.readFile(path.join(modelsRoot, repository, model.filename)), bytes)
    assert.deepEqual(commands, []); assert.equal(loaded.size, 0, 'Downloaded is not implicitly loaded')
    approve = false
    assert.equal((await bridgeApi.load({ jobId: job.jobId })).code, 'DECLINED')
    assert.deepEqual(commands, []); assert.equal(network.filter(row => row[0] === 'local').length, 0)
    approve = true
  })
  await t.test('approved asynchronous agent load survives its turn and uses exact archived loopback runtime verification', async () => {
    const abort = new AbortController(); scope = { signal: abort.signal, onWaiting: value => waiting.push(value) }
    const model = choice('agent'), { job } = await begin(model, controller.api)
    assert.equal((await bridgeApi.status({ jobId: job.jobId })).success, false)
    await finish(model, job, controller.api)
    const events = [], unsubscribe = bridgeApi.onChanged((...values) => events.push(values))
    const query = { projectPath: path.join(output, 'synthetic-project'), chatId: 'chat-one' }
    assert.equal(controller.associateAgentResult('download_lmstudio_model', { content: [{ type: 'text', text: JSON.stringify(job) }] }, { chatId: query.chatId, turnId: 'turn-one' }, query.projectPath), true)
    assert.deepEqual(events, [[]]); assert.deepEqual((await bridgeApi.agentDownloads({ ...query, chatId: 'other-chat' })).jobs, [])
    assert.deepEqual((await bridgeApi.agentDownloads({ ...query, projectPath: path.join(output, 'other-project') })).jobs, [])
    const loading = await controller.api.load({ jobId: job.jobId })
    assert.equal(loading.state, 'loading', JSON.stringify(loading)); assert.equal(loading.connectionVerified, false)
    abort.abort(); scope = null
    const ready = await settled(job)
    assert.equal(ready.state, 'ready', JSON.stringify(ready)); assert.equal(ready.connectionVerified, true); assert.equal(ready.canLoad, false)
    assert.equal(ready.contextTargetTokens, 32768); assert.equal(ready.requestedContextTokens, 32768)
    assert.equal(ready.modelMaxContextTokens, 131072); assert.equal(ready.effectiveContextTokens, 32768); assert.equal(ready.contextVerified, true)
    assert.equal(loaded.size, 1); assert.ok(loaded.has('fixture/agent'))
    assert.deepEqual(commands, [['server', 'start', '--help'], ['server', 'start', '--port', '1234', '--bind', '127.0.0.1'], ['ls', '--json', '--host', '127.0.0.1', '--port', '1234']])
    const rows = (await bridgeApi.agentDownloads(query)).jobs
    assert.equal(rows[0].turnId, 'turn-one'); assert.equal(rows[0].state, 'ready')
    assert.equal(rows[0].effectiveContextTokens, 32768); assert.equal(rows[0].contextVerified, true)
    assert.match(confirmations.at(-1).detail, /Context Length: up to 32,768 tokens, capped by the model's reported maximum/)
    assert.match(confirmations.at(-1).detail, /Larger context uses more RAM\/GPU memory; fitting in memory is not guaranteed/)
    assert.match(confirmations.at(-1).detail, /does not.*unload\/reload an already loaded model/)
    assert.doesNotMatch(JSON.stringify(rows), /sourceUrl|destination|owner|projectPath/)
    assert.deepEqual(waiting, [true, false, true, false])
    unsubscribe(); assert.equal(rendererEvents.listenerCount(native.CHANGED), 0)
  })
  await t.test('Cancel stops only its owned transfer during export and never removes an existing or completed model', async () => {
    const model = choice('cancelled'), { job } = await begin(model)
    await received(job); exportBusy = true
    const cancelled = await bridgeApi.cancel({ jobId: job.jobId })
    assert.equal(cancelled.state, 'cancelled', JSON.stringify(cancelled)); assert.equal(cancelled.canLoad, false)
    transferGates.get(model.filename).resolve(); exportBusy = false
    await assert.rejects(fs.stat(path.join(modelsRoot, repository, model.filename)), { code: 'ENOENT' })
    assert.ok(!(await fs.readdir(path.join(modelsRoot, repository))).some(name => name.endsWith('.partial')))
    assert.equal(await fs.readFile(unrelated, 'utf8'), 'existing model must survive')
    assert.deepEqual(await fs.readFile(path.join(modelsRoot, repository, 'agent-Q4_K_M.gguf')), bytes)
    assert.equal(loaded.size, 1)
  })
  await t.test('local authentication failure stays unverified and never disables auth, loads or changes agent settings', async () => {
    const model = choice('authenticated'), { job } = await begin(model); await finish(model, job)
    authRequired = true
    const beforeCommands = commands.length, beforeLoads = loaded.size
    assert.equal((await bridgeApi.load({ jobId: job.jobId })).state, 'loading')
    const failed = await settled(job)
    assert.equal(failed.state, 'completed'); assert.equal(failed.connectionVerified, false); assert.equal(failed.error.code, 'LM_AUTH_REQUIRED')
    assert.equal(commands.length, beforeCommands); assert.equal(loaded.size, beforeLoads)
    authRequired = false
    assert.equal(await fs.readFile(settings, 'utf8'), initialSettings)
    assert.equal(JSON.stringify(providerSettings), initialProvider)
    assert.ok(network.every(([, method, url]) => method !== 'POST' || url === 'http://127.0.0.1:1234/api/v1/models/load'))
  })
  await t.test('export starting in the final filesystem await blocks the archived atomic model commit', async () => {
    const model = choice('export-race'), { job } = await begin(model)
    await received(job); flipExportBeforeLink = true
    transferGates.get(model.filename).resolve()
    const result = await settled(job)
    assert.equal(flipExportBeforeLink, false, 'The synthetic final-filesystem race must execute')
    assert.equal(exportBusy, true); assert.equal(result.state, 'failed', JSON.stringify(result)); assert.equal(result.canLoad, false)
    await assert.rejects(fs.stat(path.join(modelsRoot, repository, model.filename)), { code: 'ENOENT' })
    assert.ok(!(await fs.readdir(path.join(modelsRoot, repository))).some(filename => filename.endsWith('.partial')))
    assert.equal(loaded.size, 1); exportBusy = false
  })
  await t.test('archived context policy caps loads, rejects unverified context, and leaves existing instances alone', async () => {
    for (const [name, config, expectedError] of [
      ['small-limit', { maxContext: 8192 }, null],
      ['missing-limit', { maxContext: undefined }, 'LM_CONTEXT_UNAVAILABLE'],
      ['low-effective', { actualContext: 4096 }, 'LM_CONTEXT_UNCONFIRMED'],
      ['exceeds-approved-context', { actualContext: 65536 }, 'LM_CONTEXT_UNCONFIRMED'],
      ['existing-small', { preloaded: true }, 'LM_CONTEXT_TOO_SMALL'],
    ]) {
      const model = choice(name, config), { job } = await begin(model); await finish(model, job)
      const selected = models.get(model.filename)
      if (config.preloaded) { loaded.set(selected.key, 'existing-low-context'); loadedContexts.set(selected.key, 4096) }
      const postsBefore = network.filter(row => row[1] === 'POST').length
      assert.equal((await bridgeApi.load({ jobId: job.jobId })).state, 'loading')
      const result = await settled(job)
      assert.equal(result.contextTargetTokens, 32768)
      if (expectedError) {
        assert.equal(result.state, 'completed'); assert.equal(result.error.code, expectedError, JSON.stringify(result))
        assert.equal(result.contextVerified, false); assert.equal(result.connectionVerified, false)
        if (expectedError !== 'LM_CONTEXT_UNCONFIRMED') assert.equal(network.filter(row => row[1] === 'POST').length, postsBefore)
        else { assert.equal(result.canLoad, false); assert.equal((await bridgeApi.load({ jobId: job.jobId })).code, 'NOT_LOADABLE') }
      } else {
        assert.equal(result.state, 'ready'); assert.equal(result.contextVerified, true)
        assert.equal(result.requestedContextTokens, 8192); assert.equal(result.effectiveContextTokens, 8192)
      }
      if (config.preloaded) { assert.equal(loaded.get(selected.key), 'existing-low-context'); assert.equal(loadedContexts.get(selected.key), 4096) }
      assert.equal(await fs.readFile(settings, 'utf8'), initialSettings); assert.equal(JSON.stringify(providerSettings), initialProvider)
    }
  })
  await t.test('document navigation closes native review and rejects late approval without starting a transfer', async () => {
    const model = choice('stale'), plan = await bridgeApi.plan(model)
    const count = confirmations.length, requests = network.length; approvalGate = deferred()
    const pending = bridgeApi.download({ planId: plan.planId })
    await until(() => confirmations.length, value => value > count, 'Review did not open')
    contents.emit('did-start-navigation', {}, 'file:///replacement.html', false, true)
    assert.equal(confirmations.at(-1).signal.aborted, true)
    approvalGate.resolve(); approvalGate = null
    assert.equal((await pending).success, false)
    assert.equal(network.length, requests); assert.ok(!transferGates.has(model.filename))
  })
  for (const config of confirmations) {
    assert.equal(config.defaultId, 0); assert.equal(config.cancelId, 0)
    assert.ok(config.detail.includes(repository)); assert.ok(config.detail.includes(revision)); assert.ok(config.detail.includes('4,096 bytes'))
    assert.ok(config.detail.includes('apache-2.0')); assert.ok(config.detail.includes(modelsRoot))
  }
  controller.dispose(); await manager.dispose()
  assert.equal(handlers.size, 0); assert.equal(await fs.readFile(settings, 'utf8'), initialSettings)
})
