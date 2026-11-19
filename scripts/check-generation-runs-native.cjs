// Real sandboxed Electron/preload IPC; all ComfyUI responses are synthetic.
// No real project, GPU, account, provider, or running ComfyUI is contacted.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const root = path.resolve(__dirname, '..')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function launch() {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = require('node:child_process').spawn(require('electron'), [__filename], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk) })
  const timer = setTimeout(() => child.kill(), 40000)
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    assert.equal(code, 0)
    assert.match(output, /GENERATION_RUNS_NATIVE_RESULT .*"success":true/)
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill() }
}

async function runElectron() {
  const { app, BrowserWindow, ipcMain } = require('electron')
  // The shipping preload asks this synchronous maintainer-preview question.
  // A fixture must answer explicitly, including for its foreign test window.
  ipcMain.on('engine-candidate:info', event => { event.returnValue = null })
  const { createGenerationRuns } = require('../electron/generationRuns.cjs')
  const { registerGenerationRunsIpc } = require('../electron/generationRunsIpc.cjs')
  const { registerGenerationSpendingIpc } = require('../electron/generationSpending.cjs')
  const { createSavedWorkflowLibrary, registerSavedWorkflowLibraryIpc } = require('../electron/savedWorkflowLibrary.cjs')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-generation-runs-native-'))
  app.setPath('userData', path.join(profile, 'profile'))
  app.commandLine.appendSwitch('disable-background-networking')
  const groups = [], windows = [], calls = [], finished = []
  let main, server, spending, manager, bridge, savedBridge, shown = false, blocked = 0, sequence = 0
  const referenceInputs = require('../electron/workflowAssetInputs.cjs').createWorkflowAssetInputs({
    getSnapshot: async () => ({ project: { path: profile }, assets: [{ id: 'fixture-reference', type: 'image', path: 'reference.png' }] }),
    fetchImpl: (...args) => mockFetch(...args),
  })
  const savedLibrary = createSavedWorkflowLibrary({ getUserData: () => profile, resolveAsset: referenceInputs.resolveAsset })
  let context = { session: 'fixture-session', projectKey: '/synthetic/project-one', timelineId: 'fixture-timeline' }
  const endpoint = 'http://127.0.0.1:8188'
  const workflow = { '1': { class_type: 'KSampler', inputs: { seed: 42, steps: 8 } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } } }
  const paid = { '1': { class_type: 'OpenAIGPTImage1', inputs: { prompt: 'Synthetic only', model: 'gpt-image-1' } } }
  const objectInfo = { LoadImage: { name: 'LoadImage', python_module: 'nodes' }, KSampler: { name: 'KSampler', python_module: 'nodes' }, SaveImage: { name: 'SaveImage', python_module: 'nodes' },
    OpenAIGPTImage1: { name: 'OpenAIGPTImage1', python_module: 'comfy_api_nodes.nodes_openai', api_node: true } }
  const prompts = new Map()
  const posts = () => calls.filter(call => call.route === '/prompt' && call.method === 'POST')
  const entry = (id, graph = workflow) => [1, id, graph, {}, ['2']]
  const mockFetch = async (url, options = {}) => {
    assert.ok(url.startsWith(endpoint + '/')); assert.equal(options.redirect, 'error'); assert.ok(options.signal)
    const route = url.slice(endpoint.length), method = options.method || 'GET'
    calls.push({ route, method })
    let body
    if (route === '/upload/image' && method === 'POST') {
      const image = options.body.get('image')
      assert.equal(Buffer.from(await image.arrayBuffer()).toString(), 'synthetic reference')
      body = { name: image.name, type: 'input', subfolder: '' }
    } else if (route === '/object_info') body = objectInfo
    else if (route === '/prompt' && method === 'POST') {
      const request = JSON.parse(options.body), id = `synthetic-${++sequence}`
      prompts.set(id, { status: 'running', workflow: request.prompt }); body = { prompt_id: id, node_errors: {} }
    } else if (route === '/queue' && method === 'GET') {
      body = { queue_running: [], queue_pending: [] }
      for (const [id, item] of prompts) if (['running', 'queued'].includes(item.status)) body[item.status === 'running' ? 'queue_running' : 'queue_pending'].push(entry(id, item.workflow))
    } else if (route.startsWith('/history/')) {
      const id = decodeURIComponent(route.slice('/history/'.length)), item = prompts.get(id)
      body = item?.status === 'done' ? { [id]: { prompt: entry(id, item.workflow), status: { status_str: 'success', completed: true, messages: [] },
        outputs: { '2': { images: [{ filename: 'synthetic-result.png', subfolder: '', type: 'output' }] } } } } : {}
    } else throw new Error(`Unexpected synthetic route ${method} ${route}`)
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) }
  }
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const until = async predicate => {
    const deadline = Date.now() + 8000
    while (!await predicate()) { if (Date.now() > deadline) throw new Error('Native run fixture timed out'); await delay(20) }
  }
  const makeManager = () => createGenerationRuns({ storageDir: path.join(profile, 'runs'), getEndpoint: () => endpoint,
    getContext: () => ({ ...context }), submitManaged: args => spending.queueFromMain(args), fetchImpl: mockFetch,
    resolveSavedWorkflow: args => savedLibrary.prepare(args), uploadSavedAssets: referenceInputs.upload,
    onGenerationFinished: detail => finished.push(detail),
    notify: snapshot => { if (main && !main.isDestroyed()) main.webContents.send('generation-runs:changed', snapshot) },
    pollIntervalMs: 80 })
  try {
    await app.whenReady()
    server = require('node:http').createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'" })
      response.end('<!doctype html><title>Synthetic generation run fixture</title><h1>Fixture only</h1>' + (request.url === '/' ? '<iframe src="/child"></iframe>' : ''))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const create = () => {
      const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'electron/preload.js'), sandbox: true,
        contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, backgroundThrottling: false,
        partition: `generation-run-fixture-${windows.length}` } })
      windows.push(window); window.on('show', () => { shown = true })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.session.setPermissionRequestHandler((_w, _p, callback) => callback(false))
      window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        if (details.url.startsWith(origin + '/')) callback({ cancel: false })
        else { blocked++; callback({ cancel: true }) }
      })
      return window
    }
    main = create()
    spending = registerGenerationSpendingIpc({ ipcMain, getMainWindow: () => main, getEndpoint: () => endpoint,
      getContext: () => ({ ...context }), readPolicy: () => 'local-only', writePolicy: () => { throw new Error('No policy changes permitted in fixture') },
      getApiKey: () => { throw new Error('Credential access forbidden in fixture') }, fetchImpl: mockFetch,
      confirmSpend: () => { throw new Error('No cloud spending in fixture') },
      beforeSubmit: detail => manager.beforeSubmit(detail), afterSubmit: detail => manager.afterSubmit(detail) })
    manager = makeManager()
    bridge = registerGenerationRunsIpc({ ipcMain, getMainWindow: () => main, getManager: () => manager })
    savedBridge = registerSavedWorkflowLibraryIpc({ ipcMain, getMainWindow: () => main, getLibrary: () => savedLibrary })
    await manager.start()
    await main.loadURL(origin + '/')
    const run = (script, window = main) => window.webContents.executeJavaScript(script)
    const invoke = (method, args = {}, window = main) => run(`window.electronAPI.generationRuns.${method}(${JSON.stringify(args)})`, window)
    assert.equal(await run('typeof require'), 'undefined')
    await run('window.events=[]; window.unsubscribe=window.electronAPI.generationRuns.onChanged(value=>window.events.push(value)); true')
    for (const method of ['list', 'submit', 'adopt', 'recipe', 'control', 'observe']) assert.equal(await run(`typeof window.electronAPI.generationRuns.${method}`), 'function')
    const preview = await invoke('submit', { workflow, label: 'Native fixture' })
    assert.equal(preview.previewOnly, true); assert.equal(posts().length, 0); assert.equal((await invoke('list')).runs.length, 0)
    pass('Real sandboxed preload exposes the run bridge; preview writes and submits nothing')

    const submitted = await invoke('submit', { workflow, label: 'Native fixture', previewOnly: false })
    assert.equal(submitted.success, true, JSON.stringify(submitted)); assert.ok(submitted.runId)
    assert.equal(posts().length, 1)
    const id = submitted.runId, promptId = submitted.run.promptId
    await until(async () => (await invoke('list')).runs.find(item => item.id === id)?.status === 'running')
    assert.ok(await run('window.events.length > 0'))
    // There is no Generate workspace, renderer ComfyUI client or submission loop
    // in this page: the native manager alone must discover completion.
    prompts.get(promptId).status = 'done'
    await until(async () => (await invoke('list')).runs.find(item => item.id === id)?.status === 'done')
    const done = (await invoke('list')).runs[0]
    assert.deepEqual(finished, [{ endpoint }], 'Managed completion reaches the native memory-cleanup hook')
    assert.equal(done.outputs[0].filename, 'synthetic-result.png'); assert.equal(done.origin, 'agent')
    pass('One approved native POST produces progress, output descriptors and live events without mounting Generate')

    const beforeReads = calls.length
    await invoke('list'); await invoke('list'); await invoke('list')
    assert.equal(calls.length, beforeReads)
    const recipe = await invoke('recipe', { runId: id })
    assert.equal(recipe.success, true); assert.ok(recipe.workflow['1'])
    const marked = await invoke('control', { operation: 'mark-imported', runId: id, resultAssetIds: ['synthetic-asset'], previewOnly: false })
    assert.equal(marked.success, true, JSON.stringify(marked))
    pass('Status reads are repeatable, cached and side-effect free; recipe and import acknowledgement round-trip')

    const denied = await invoke('submit', { workflow: paid, previewOnly: false })
    assert.equal(denied.success, false); assert.match(denied.code, /LOCAL_ONLY/); assert.equal(posts().length, 1)
    pass('Arbitrary workflow submission still honors the native Local only spending gate')

    prompts.set('external-fixture', { status: 'done', workflow })
    const observed = await invoke('adopt', { promptId: 'external-fixture' })
    assert.equal(observed.previewOnly, true, JSON.stringify(observed)); assert.equal((await invoke('list')).runs.length, 1)
    const adopted = await invoke('adopt', { promptId: 'external-fixture', previewOnly: false })
    assert.equal(adopted.success, true); assert.equal(adopted.run.origin, 'external'); assert.equal(adopted.run.adopted, true)
    assert.equal(posts().length, 1)
    pass('Explicit adoption previews then tracks an existing prompt without rerunning or importing unrelated history')

    manager.dispose(); manager = makeManager(); await manager.start()
    const restored = await invoke('list')
    assert.equal(restored.runs.length, 2); assert.deepEqual(restored.runs.find(item => item.id === id).resultAssetIds, ['synthetic-asset'])
    context = { ...context, projectKey: '/synthetic/project-two' }
    assert.equal((await invoke('list')).runs.length, 0)
    assert.equal((await invoke('list', { includeOtherProjects: true })).runs.length, 2)
    assert.equal(posts().length, 1)
    pass('Restart restores durable receipts without resubmission and default reads respect project ownership')

    const savedDirectory = path.join(profile, 'custom-workflows'); fs.mkdirSync(savedDirectory)
    const savedFile = path.join(savedDirectory, 'native-copy.json')
    const savedRecord = { id: 'native-copy', title: 'Native saved copy', uiWorkflow: { nodes: [] }, apiWorkflow: workflow }
    fs.writeFileSync(savedFile, JSON.stringify(savedRecord))
    const listedSaved = await run('window.electronAPI.listSavedWorkflows()')
    assert.equal(listedSaved.workflows[0].id, 'my-workflow:native-copy')
    const preparedSaved = await run('window.electronAPI.prepareSavedWorkflow({workflowId:"my-workflow:native-copy"})')
    assert.equal(preparedSaved.success, true); assert.ok(preparedSaved.graphFingerprint)
    const savedArgs = { workflowId: 'my-workflow:native-copy', inputOverrides: [{ nodeId: '1', input: 'seed', value: 99 }] }
    const savedPreview = await invoke('submit', savedArgs)
    assert.equal(savedPreview.previewOnly, true); assert.equal(posts().length, 1)
    const savedApply = { ...savedArgs, ...savedPreview.suggestedApplyPayload, previewOnly: false }
    const changedOverrides = await invoke('submit', { ...savedApply, inputOverrides: [{ nodeId: '1', input: 'seed', value: 100 }] })
    assert.equal(changedOverrides.code, 'GENERATION_RUNS_SAVED_WORKFLOW_CHANGED'); assert.equal(posts().length, 1)
    const savedSubmitted = await invoke('submit', savedApply)
    assert.equal(savedSubmitted.success, true, JSON.stringify(savedSubmitted)); assert.equal(posts().length, 2)
    assert.equal(savedSubmitted.run.workflowId, savedArgs.workflowId)
    assert.equal(savedSubmitted.run.sourceGraphFingerprint, savedPreview.graphFingerprint)
    const savedRecipe = await invoke('recipe', { runId: savedSubmitted.runId })
    assert.equal(savedRecipe.workflowId, savedArgs.workflowId); assert.equal(savedRecipe.resolvedFingerprint, savedPreview.resolvedFingerprint)
    assert.equal(prompts.get(savedSubmitted.run.promptId).workflow['1'].inputs.seed, 99)
    assert.equal(JSON.parse(fs.readFileSync(savedFile, 'utf8')).apiWorkflow['1'].inputs.seed, 42)
    manager.dispose(); manager = makeManager(); await manager.start()
    assert.equal((await invoke('list')).runs.find(run => run.id === savedSubmitted.runId).workflowId, savedArgs.workflowId)
    pass('Saved-ID preview/apply uses real preload and the same broker with exact override fingerprints; original is untouched')

    savedRecord.apiWorkflow = paid; fs.writeFileSync(savedFile, JSON.stringify(savedRecord))
    const paidPreview = await invoke('submit', { workflowId: savedArgs.workflowId })
    const savedPaidDenied = await invoke('submit', { workflowId: savedArgs.workflowId, ...paidPreview.suggestedApplyPayload, previewOnly: false })
    assert.equal(savedPaidDenied.success, false); assert.match(savedPaidDenied.code, /LOCAL_ONLY/); assert.equal(posts().length, 2)
    delete savedRecord.apiWorkflow; fs.writeFileSync(savedFile, JSON.stringify(savedRecord))
    const legacy = await run('window.electronAPI.prepareSavedWorkflow({workflowId:"my-workflow:native-copy"})')
    assert.equal(legacy.success, false); assert.equal(legacy.ready, false)
    pass('Saved paid copies retain Local only blocking and old UI-only captures report not-ready without replacing ComfyUI')

    fs.writeFileSync(path.join(profile, 'reference.png'), 'synthetic reference')
    savedRecord.apiWorkflow = { ...workflow, '97': { class_type: 'LoadImage', inputs: { image: 'old.png' } } }
    fs.writeFileSync(savedFile, JSON.stringify(savedRecord))
    const referenceArgs = { workflowId: savedArgs.workflowId, inputOverrides: { asset: 'fixture-reference' }, templateParameters: { node_1_steps: 6 } }
    const referencePreview = await invoke('submit', referenceArgs)
    assert.equal(referencePreview.success, true, JSON.stringify(referencePreview))
    assert.equal(calls.filter(c => c.route === '/upload/image').length, 0); assert.equal(posts().length, 2)
    const referenceApplied = await invoke('submit', { ...referenceArgs, ...referencePreview.suggestedApplyPayload, previewOnly: false })
    assert.equal(referenceApplied.success, true, JSON.stringify(referenceApplied))
    assert.equal(calls.filter(c => c.route === '/upload/image').length, 1); assert.equal(posts().length, 3)
    const referenceGraph = prompts.get(referenceApplied.run.promptId).workflow
    assert.equal(referenceGraph['97'].inputs.image, referencePreview.preparedAssets[0].value)
    assert.equal(referenceGraph['1'].inputs.steps, 6)
    assert.deepEqual(referenceApplied.run.inputAssetIds, ['fixture-reference'])
    assert.equal(JSON.parse(fs.readFileSync(savedFile, 'utf8')).apiWorkflow['97'].inputs.image, 'old.png')
    pass('Named settings and project reference survive sandboxed IPC, upload only on apply, and queue exactly once through the native broker')

    const foreign = create(); await foreign.loadURL(origin + '/foreign')
    assert.equal((await invoke('list', {}, foreign)).code, 'GENERATION_RUN_UNAUTHORIZED')
    const frame = main.webContents.mainFrame.frames[0]; assert.ok(frame)
    assert.equal((await frame.executeJavaScript('window.electronAPI.generationRuns.list({})')).code, 'GENERATION_RUN_UNAUTHORIZED')
    for (const expression of ['listSavedWorkflows()', 'readSavedWorkflow({workflowId:"my-workflow:native-copy"})', 'prepareSavedWorkflow({workflowId:"my-workflow:native-copy"})']) {
      assert.equal((await run('window.electronAPI.' + expression, foreign)).code, 'SAVED_WORKFLOW_UNAUTHORIZED')
      assert.equal((await frame.executeJavaScript('window.electronAPI.' + expression)).code, 'SAVED_WORKFLOW_UNAUTHORIZED')
    }
    await run('window.unsubscribe(); true')
    assert.equal(shown, false); assert.equal(blocked, 0)
    pass('Foreign windows and preloaded child frames cannot acquire main-window run authority')
    const result = { success: true, groups, profile, realServiceRequests: 0, mockedPromptPosts: posts().length, windowNeverShown: true,
      runtime: { platform: process.platform, electron: process.versions.electron } }
    fs.writeFileSync(path.join(profile, 'result.json'), JSON.stringify(result, null, 2))
    console.log('GENERATION_RUNS_NATIVE_RESULT ' + JSON.stringify(result))
  } finally {
    bridge?.dispose(); savedBridge?.dispose(); manager?.dispose(); spending?.dispose()
    for (const window of windows) if (!window.isDestroyed()) window.destroy()
    server?.close()
  }
}

if (process.versions.electron) runElectron().then(() => require('electron').app.exit(0), error => { console.error(error); require('electron').app.exit(1) })
else launch().catch(error => { console.error(error); process.exitCode = 1 })
