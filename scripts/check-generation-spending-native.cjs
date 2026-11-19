// Never-shown sandboxed Electron/preload/IPC fixture. ComfyUI fetches, account
// credentials, native confirmations and settings are injected in-memory values.
// Only an owned temporary-profile loopback HTML server is contacted. The actual
// app, user projects, accounts, provider APIs and ComfyUI are never loaded.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const root = path.resolve(__dirname, '..')
const nativeRoot = process.env.VELORN_SPENDING_TEST_PACKAGED === '1'
  ? path.join(root, 'release/linux-unpacked/resources/app.asar') : root
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function launch() {
  if (process.argv.length > 2) throw new Error('Usage: node scripts/check-generation-spending-native.cjs')
  const { spawn } = require('node:child_process')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.env.VELORN_TEST_ELECTRON_BINARY || require('electron'), [__filename],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  let stdout = ''
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-64000); process.stdout.write(data) })
  const stop = () => child.kill()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Native generation-spending fixture timed out')) }, 35000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', value => { clearTimeout(timer); resolve(value) })
    })
    if (code !== 0) throw new Error(`Native generation-spending fixture exited ${code}`)
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('GENERATION_SPENDING_NATIVE_RESULT '))
    assert.ok(line && JSON.parse(line.slice('GENERATION_SPENDING_NATIVE_RESULT '.length)).success)
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
}

async function runElectron() {
  const { app, BrowserWindow, ipcMain } = require('electron')
  ipcMain.on('engine-candidate:info', event => { event.returnValue = null })
  const { registerGenerationSpendingIpc } = require(path.join(nativeRoot, 'electron/generationSpending.cjs'))
  const { createLocalWorkflowTrustStore } = require(path.join(nativeRoot, 'electron/generationLocalWorkflowTrust.cjs'))
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-generation-spending-native-'))
  app.setPath('userData', path.join(profile, 'profile'))
  app.commandLine.appendSwitch('disable-background-networking')
  const windows = [], groups = [], calls = [], confirmations = [], policyConfirmations = [], blockedRequests = []
  const local = { '1': { class_type: 'KSampler', inputs: { seed: 42, steps: 8 } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } } }
  const paid = { '1': { class_type: 'OpenAIGPTImage1', inputs: { prompt: 'Synthetic fixture only', model: 'gpt-image-1' } } }
  const objectInfo = { KSampler: { name: 'KSampler', python_module: 'nodes' }, SaveImage: { name: 'SaveImage', python_module: 'nodes' },
    OpenAIGPTImage1: { name: 'OpenAIGPTImage1', python_module: 'comfy_api_nodes.nodes_openai', api_node: true } }
  const endpoint = 'http://127.0.0.1:8188', accountKey = 'sk-synthetic-account-key-never-returned'
  const context = { session: 'native-fixture-session', projectKey: '/synthetic-only/project', timelineId: 'synthetic-timeline' }
  const unfamiliar = { '1': { class_type: 'SyntheticLocalVideo', inputs: { prompt: 'synthetic test', seed: 42 } } }
  objectInfo.SyntheticLocalVideo = { name: 'SyntheticLocalVideo', python_module: 'custom_nodes.synthetic_video', api_node: false }
  let localTrustData = null
  const localWorkflowTrust = createLocalWorkflowTrustStore({ readStore: () => localTrustData, writeStore: (value, authority) => {
    assert.equal(authority.isCurrent(), true); assert.equal(authority.signal.aborted, false); localTrustData = value
  } })
  let main, server, controller, shown = false, policy, keyReads = 0, policyDecision = false, spendDecision = true, releaseSpend, sequence = 0
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const until = async predicate => {
    const deadline = Date.now() + 5000
    while (!await predicate()) { if (Date.now() > deadline) throw new Error('Native fixture condition timed out'); await delay(10) }
  }
  const request = (workflow = local) => ({ requestId: `native-fixture-request-${++sequence}`, endpoint, clientId: 'native-fixture-client', workflow })
  const posts = () => calls.filter(call => call.method === 'POST')
  const expectedCode = (value, code) => { assert.equal(value.success, false); assert.equal(value.code, `GENERATION_SPENDING_${code}`) }
  try {
    await app.whenReady()
    server = require('node:http').createServer((request, response) => {
      if (request.url === '/generationSpending.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript' })
        response.end(fs.readFileSync(path.join(root, 'src/services/generationSpending.js')))
        return
      }
      if (!['/', '/frame', '/foreign', '/favicon.ico'].includes(request.url)) { response.writeHead(404); response.end(); return }
      response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'; script-src 'self'" })
      response.end('<!doctype html><html><body><h1>Velorn synthetic spending IPC fixture</h1><p>No project or provider is connected.</p>'
        + (request.url === '/' ? '<iframe title="Synthetic untrusted child" src="/frame"></iframe>' : '') + '</body></html>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const create = () => {
      const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(nativeRoot, 'electron/preload.js'),
        sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true,
        backgroundThrottling: false, partition: `generation-spending-fixture-${windows.length}` } })
      windows.push(window)
      window.on('show', () => { shown = true })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        if (details.url.startsWith(origin + '/')) return callback({ cancel: false })
        blockedRequests.push(details.url); callback({ cancel: true })
      })
      return window
    }
    main = create()
    controller = registerGenerationSpendingIpc({ ipcMain, getMainWindow: () => main,
      localWorkflowTrust,
      resolveSavedWorkflow: () => ({ success: true, ready: true, workflowId: 'my-workflow:synthetic', title: 'Synthetic local video',
        graphFingerprint: 'a'.repeat(64), workflow: unfamiliar }),
      readPolicy: () => policy,
      writePolicy: (value, authority) => { assert.equal(authority.isCurrent(), true); assert.equal(authority.signal.aborted, false); policy = value },
      getEndpoint: () => endpoint, getContext: () => ({ ...context }), assertAvailable: () => {},
      getApiKey: () => { keyReads++; return accountKey },
      confirmPolicyChange: async input => { assert.equal(input.window, main); policyConfirmations.push(input.policy); return policyDecision },
      confirmSpend: async input => {
        assert.equal(input.window, main); assert.equal(input.submissionCount, 1); assert.equal(input.endpoint, endpoint)
        assert.match(input.fingerprint, /^[a-f0-9]{64}$/)
        confirmations.push({ risk: input.assessment.risk, fingerprint: input.fingerprint, submissionCount: input.submissionCount,
          policy: input.policy, eligible: input.localTrust.eligible })
        return spendDecision === 'hold' ? new Promise(resolve => { releaseSpend = resolve }) : spendDecision
      },
      fetchImpl: async (url, options) => {
        assert.equal(options.redirect, 'error')
        assert.ok(options.signal)
        assert.ok([`${endpoint}/object_info`, `${endpoint}/prompt`].includes(url))
        calls.push({ url, method: options.method, ...(options.body ? { body: JSON.parse(options.body) } : {}) })
        const body = url.endsWith('/object_info') ? objectInfo : { prompt_id: `synthetic-prompt-${posts().length}`, node_errors: {} }
        // Injected fixtures intentionally do not use any native network client.
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) }
      },
    })
    await main.loadURL(origin + '/')
    const run = (script, gesture = false, window = main) => window.webContents.executeJavaScript(script, gesture)
    const invoke = (method, payload, gesture = false, window = main) => run(`window.electronAPI.generationSpending.${method}(${JSON.stringify(payload)})`, gesture, window)
    assert.equal(await run('typeof require'), 'undefined')
    assert.equal(await run('typeof window.electronAPI.generationSpending.queue'), 'function')
    const status = await invoke('getStatus')
    assert.equal(status.policy, 'local-only'); assert.equal(status.scope, 'velorn-managed')
    assert.equal(status.externalAccessCovered, false)
    assert.match(await run('window.electronAPI.generationSpending.setPolicy("ask-cloud").then(()=>"unexpected", error=>error.message)'), /user gesture/)
    assert.equal(policyConfirmations.length, 0)
    pass('Real sandboxed preload defaults to Local only and rejects background policy writes without a user gesture')

    const localRequest = request()
    assert.equal((await invoke('queue', localRequest)).success, true)
    assert.equal(posts().length, 1); assert.equal(keyReads, 0); assert.equal(confirmations.length, 0)
    assert.deepEqual(posts()[0].body, { prompt: local, client_id: 'native-fixture-client' })
    pass('Local graph crosses real IPC exactly once without reading or forwarding account credentials')

    const paidRequest = request(paid)
    expectedCode(await invoke('queue', paidRequest), 'LOCAL_ONLY')
    expectedCode(await invoke('queue', paidRequest), 'DUPLICATE_REQUEST')
    assert.equal(posts().length, 1); assert.equal(keyReads, 0); assert.equal(confirmations.length, 0)
    pass('Local only blocks paid work before native consent, key release and POST, and rejects repeated request IDs')

    await run('window.spendingChanges = []; window.stopSpendingChanges = window.electronAPI.generationSpending.onChanged(value => window.spendingChanges.push(value)); true')
    const cancelled = await invoke('setPolicy', 'ask-cloud', true)
    assert.equal(cancelled.cancelled, true); assert.equal(cancelled.policy, 'local-only')
    assert.equal(policyConfirmations.length, 1); assert.equal(policy, undefined)
    policyDecision = true
    const changed = await invoke('setPolicy', 'ask-cloud', true)
    assert.equal(changed.policy, 'ask-cloud'); assert.equal(changed.busy, false)
    await until(async () => (await run('window.spendingChanges.length')) === 1)
    assert.equal((await run('window.spendingChanges[0]')).policy, 'ask-cloud')
    pass('Gesture-gated policy changes honor native cancellation, native acceptance and real preload status events')

    spendDecision = 'hold'
    const approvedRequest = request(paid)
    await run(`window.heldRequest = ${JSON.stringify(approvedRequest)}; window.heldSubmission = window.electronAPI.generationSpending.queue(window.heldRequest); 'started'`)
    await until(() => confirmations.length === 1)
    await run('window.heldRequest.workflow["1"].inputs.prompt = "Mutated renderer graph after dialog"; true')
    assert.equal(keyReads, 0); assert.equal(posts().length, 1)
    assert.equal(confirmations[0].risk, 'paid')
    releaseSpend(true)
    assert.equal((await run('window.heldSubmission')).success, true)
    assert.equal(keyReads, 1); assert.equal(posts().length, 2)
    assert.deepEqual(posts()[1].body.prompt, paid)
    assert.equal(posts()[1].body.extra_data.api_key_comfy_org, accountKey)
    assert.equal(JSON.stringify(await run('window.heldSubmission')).includes(accountKey), false)
    pass('Native approval binds the exact detached graph and one submission; credentials remain in native POST only')

    spendDecision = false
    expectedCode(await invoke('queue', request(paid)), 'DENIED')
    assert.equal(confirmations.length, 2); assert.equal(posts().length, 2); assert.equal(keyReads, 1)
    pass('A subsequent paid graph asks again and native denial has no credential access or submission')

    const foreign = create(); await foreign.loadURL(origin + '/foreign')
    expectedCode(await invoke('getStatus', undefined, false, foreign), 'UNAUTHORIZED')
    expectedCode(await invoke('queue', request(), false, foreign), 'UNAUTHORIZED')
    expectedCode(await invoke('setPolicy', 'local-only', true, foreign), 'UNAUTHORIZED')
    const frame = main.webContents.mainFrame.frames[0]
    assert.ok(frame)
    assert.equal(await frame.executeJavaScript('typeof window.electronAPI.generationSpending.queue'), 'function')
    expectedCode(await frame.executeJavaScript(`window.electronAPI.generationSpending.queue(${JSON.stringify(request())})`), 'UNAUTHORIZED')
    expectedCode(await frame.executeJavaScript('window.electronAPI.generationSpending.getStatus()'), 'UNAUTHORIZED')
    assert.equal(posts().length, 2)
    pass('Real native IPC rejects foreign windows and a preloaded child frame even when the bridge exists')

    await run('(async () => { window.spendingModule = await import("/generationSpending.js"); window.browserFetchCalls = 0; window.fetch = () => { window.browserFetchCalls++; throw new Error("Unexpected renderer network"); }; return true })()')
    const noFallback = await run(`window.spendingModule.submitManagedGeneration(${JSON.stringify({ workflow: local, endpoint, clientId: 'test' })}, null).then(()=>"unexpected", error=>({code:error.code,message:error.message}))`)
    assert.equal(noFallback.code, 'GENERATION_SPENDING_UNAVAILABLE')
    assert.equal(await run('window.browserFetchCalls'), 0)
    assert.equal(posts().length, 2)
    pass('The actual renderer submission helper fails closed with an absent bridge and has no raw-fetch fallback')

    spendDecision = 'hold'
    const cancelledRequest = request(paid)
    await run(`window.cancelledSubmission = window.electronAPI.generationSpending.queue(${JSON.stringify(cancelledRequest)}); 'started'`)
    await until(() => confirmations.length === 3)
    assert.equal((await invoke('cancel', cancelledRequest.requestId)).submissionState, 'not-started')
    expectedCode(await invoke('queue', request()), 'BUSY')
    releaseSpend(true)
    expectedCode(await run('window.cancelledSubmission'), 'CANCELLED')
    assert.equal(posts().length, 2); assert.equal(keyReads, 1)
    pass('Real preload cancellation invalidates an open consent and keeps dialogs serialized until it closes')

    const h3Name = 'MiniMaxH3ReferenceToVideo'
    objectInfo[h3Name] = { name: h3Name, python_module: 'comfy_extras.nodes_minimax_h3', api_node: false, price_badge: null }
    const h3 = { ...local, '3': { class_type: h3Name, inputs: { width: 1280, height: 704, length: 124 } } }
    spendDecision = false
    for (const selectedPolicy of ['local-only', 'ask-cloud']) {
      policy = selectedPolicy // Fixture state only; no real settings are loaded.
      const priorPosts = posts().length
      const response = await run(`window.spendingModule.submitManagedGeneration(${JSON.stringify({ workflow: h3, endpoint, clientId: 'test-h3' })}).then(async result => ({ok:result.ok,body:await result.json()}))`)
      assert.equal(response.ok, true)
      assert.equal(posts().length, priorPosts + 1)
      assert.deepEqual(posts().at(-1).body.prompt, h3)
      assert.equal(posts().at(-1).body.extra_data, undefined)
    }
    assert.equal(confirmations.length, 3); assert.equal(keyReads, 1)
    assert.equal(await run('window.browserFetchCalls'), 0)
    pass('Local H3 crosses actual renderer/preload/native queue under both policies without consent, cloud keys or direct fetch')
    objectInfo[h3Name].api_node = true
    const beforeMixed = posts().length
    expectedCode(await invoke('queue', request(h3)), 'DENIED')
    assert.equal(posts().length, beforeMixed); assert.equal(keyReads, 1)
    assert.equal(confirmations.at(-1).risk, 'paid')
    pass('Server-reported paid H3 implementation still prompts; denial submits nothing')

    policy = 'local-only'; spendDecision = false
    const savedRequest = () => ({ ...request(unfamiliar), savedWorkflowId: 'my-workflow:synthetic' })
    const priorPosts = posts().length, priorKeys = keyReads, priorReviews = confirmations.length
    expectedCode(await invoke('queue', savedRequest()), 'DENIED')
    assert.equal(confirmations.at(-1).policy, 'local-only'); assert.equal(confirmations.at(-1).eligible, true)
    assert.equal(localTrustData, null); assert.equal(posts().length, priorPosts)
    spendDecision = true
    expectedCode(await invoke('queue', savedRequest()), 'DENIED')
    assert.equal(localTrustData, null); assert.equal(posts().length, priorPosts)
    spendDecision = { approved: true, trustLocal: true }
    assert.equal((await invoke('queue', savedRequest())).success, true)
    assert.equal(posts().length, priorPosts + 1); assert.equal(keyReads, priorKeys)
    assert.equal(posts().at(-1).body.extra_data, undefined)
    assert.equal(policy, 'local-only'); assert.equal(localTrustData.entries.length, 1)
    assert.equal((await invoke('queue', savedRequest())).success, true)
    assert.equal(posts().length, priorPosts + 2); assert.equal(confirmations.length, priorReviews + 3)
    pass('Real IPC offers native local trust under Local only; Cancel and generic approval do not queue; remembered trust never releases a cloud key')

    objectInfo.SyntheticLocalVideo.api_node = true
    expectedCode(await invoke('queue', savedRequest()), 'LOCAL_ONLY')
    assert.equal(posts().length, priorPosts + 2); assert.equal(keyReads, priorKeys)
    assert.equal(confirmations.length, priorReviews + 3)
    objectInfo.SyntheticLocalVideo.api_node = false
    await invoke('revokeLocalTrust', { id: localTrustData.entries[0].id }, true)
    spendDecision = false
    expectedCode(await invoke('queue', savedRequest()), 'DENIED')
    assert.equal(localTrustData.entries.length, 0); assert.equal(posts().length, priorPosts + 2)
    assert.equal(await run('window.browserFetchCalls'), 0)
    pass('Real IPC refuses paid evidence after local trust and honors native gesture-gated revocation without automatic resubmission')

    assert.equal(shown, false)
    assert.equal(blockedRequests.length, 0)
    const result = { success: true, groups, profile, nativeRoot, windowNeverShown: true, realServiceRequests: 0,
      settingsInMemoryOnly: true, mockedPromptPosts: posts().length, mockedCredentialReads: keyReads,
      nativeSpendConfirmations: confirmations.length, policyConfirmations: policyConfirmations.length,
      runtime: { platform: process.platform, electron: process.versions.electron, chrome: process.versions.chrome } }
    fs.writeFileSync(path.join(profile, 'result.json'), JSON.stringify(result, null, 2))
    console.log('GENERATION_SPENDING_NATIVE_RESULT ' + JSON.stringify(result))
  } catch (error) {
    fs.writeFileSync(path.join(profile, 'failure.json'), JSON.stringify({ success: false, groups, profile, error: error.stack || String(error) }, null, 2))
    throw error
  } finally {
    controller?.dispose()
    for (const window of windows) if (!window.isDestroyed()) window.destroy()
    server?.close()
  }
}

if (process.versions.electron) runElectron().then(() => require('electron').app.exit(0), error => {
  console.error(error); require('electron').app.exit(1)
})
else launch().catch(error => { console.error(error); process.exitCode = 1 })
