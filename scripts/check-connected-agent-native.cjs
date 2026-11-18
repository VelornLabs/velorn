// Standalone, never-shown Electron boundary check. The real preload and IPC
// controller run against deterministic provider functions only. --serve is
// accepted for consistency: this check always owns a disposable loopback server
// and profile, and never loads the app, user project, account or actual model.
// Research checks write only a tiny synthetic GGUF inside that temporary
// profile, with the real download manager and an in-memory mock network.
// Full-access checks use an injected confirmation and backend. Shell-command
// approval text is inert fixture data: no command, model or download runs.
// Deliberately injected approval requests test the generic IPC decision boundary;
// the real full-access runtime verifies never-approval and refuses such requests.
// Executable-picker checks use in-memory metadata and an injected picker only;
// no native file dialog, executable, application setting or installed file changes.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const root = path.resolve(__dirname, '..')
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function launch() {
  if (process.argv.slice(2).some(arg => arg !== '--serve')) throw new Error('Usage: node scripts/check-connected-agent-native.cjs [--serve]')
  const { spawn } = require('node:child_process')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const binary = process.env.VELORN_TEST_ELECTRON_BINARY || require('electron')
  const child = spawn(binary, [__filename], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  let stdout = ''
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-64000); process.stdout.write(data) })
  const stop = () => child.kill()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Native connected-agent fixture timed out')) }, 45000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
    })
    if (result.code !== 0) throw new Error(`Native connected-agent fixture failed: ${result.signal || result.code}`)
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('CONNECTED_AGENT_NATIVE_RESULT '))
    assert.ok(line && JSON.parse(line.slice('CONNECTED_AGENT_NATIVE_RESULT '.length)).success, 'Electron reported successful native checks')
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
}

async function runElectron() {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const { registerConnectedAgentIpc, LIMITS } = require('../electron/connectedAgent.cjs')
  const { createFullAccessPreference } = require('../electron/connectedAgentAccessPreference.cjs')
  const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
  const { tools: generationRunTools } = require('../electron/mcpGenerationRunTools.cjs')
  const { createResearchAccess, TOOL_NAMES, ownerFromGuard } = require('../electron/connectedAgentResearch.cjs')
  const { createModelDownloadManager } = require('../electron/agentModelDownloads.cjs')
  const { createHash } = require('node:crypto')
  const http = require('node:http')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-connected-agent-native-'))
  app.setPath('userData', path.join(profile, 'profile'))
  app.commandLine.appendSwitch('disable-background-networking')
  const groups = [], blockedRequests = [], calls = [], held = new Map(), aborted = []
  const executableCalls = [], executableSaves = []
  const automaticExecutable = { path: path.join(profile, 'synthetic-auto-codex'), source: 'path', mode: 'auto', available: true }
  const selectedExecutable = { path: path.join(profile, 'synthetic-picked-codex'), source: 'configured', mode: 'manual', available: true }
  let currentExecutable = { ...automaticExecutable }, pickerMode = 'cancel', pendingPicker, holdInspection = false, releaseInspection
  const checkExecutableScope = async ({ signal, isCurrent }) => {
    if (signal?.aborted || (isCurrent && !await isCurrent())) throw Object.assign(new Error('Synthetic executable choice is stale'), { code: 'CANCELLED' })
  }
  const executableAccess = {
    status: async options => { await checkExecutableScope(options); executableCalls.push('status'); return { ...currentExecutable } },
    resolve: async options => { await checkExecutableScope(options); executableCalls.push('resolve'); return { ...currentExecutable } },
    choose: async options => {
      assert.equal(options.window, main)
      assert.equal(typeof options.isCurrent, 'function')
      executableCalls.push('choose')
      const operation = { ...options, finished: false }
      try {
        if (pickerMode === 'hold') {
          await new Promise(resolve => { operation.release = resolve; pendingPicker = operation })
        }
        await checkExecutableScope(options)
        if (pickerMode === 'cancel') return null
        currentExecutable = { ...selectedExecutable }; executableSaves.push({ ...currentExecutable })
        return { ...currentExecutable }
      } finally { operation.finished = true }
    },
    automatic: async options => {
      assert.equal(options.window, main)
      assert.equal(typeof options.isCurrent, 'function')
      executableCalls.push('auto')
      await checkExecutableScope(options)
      currentExecutable = { ...automaticExecutable }; executableSaves.push({ ...currentExecutable })
      return { ...currentExecutable }
    },
  }
  const fullAccessCalls = [], fullAccessConfirmations = [], fullAccessDecisions = []
  let fullAccessConfirmation = true, releaseFullAccessConfirmation, fullAccessAvailable = true, fullAccessAvailabilityChecks = 0
  const catalogs = [], downloadRequests = [], researchManagers = [], researchDisposals = []
  const researchResults = new Map(), stalledDownloads = new Map()
  const syntheticComfyRoot = path.join(profile, 'synthetic-comfy')
  const syntheticModels = path.join(syntheticComfyRoot, 'models', 'checkpoints')
  fs.mkdirSync(syntheticModels, { recursive: true })
  fs.writeFileSync(path.join(syntheticComfyRoot, 'main.py'), '# Synthetic root marker. Never executed.\n')
  const syntheticGguf = Buffer.alloc(24); syntheticGguf.write('GGUF'); syntheticGguf.writeUInt32LE(3, 4)
  const syntheticSha256 = createHash('sha256').update(syntheticGguf).digest('hex')
  const windows = new Set()
  let main, controller, server, finished = false, everShown = false
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const finish = async (success, error) => {
    if (finished) return
    finished = true
    controller?.dispose()
    await Promise.allSettled(researchManagers.map(manager => manager.dispose()))
    await Promise.allSettled(researchDisposals)
    for (const window of windows) if (!window.isDestroyed()) window.destroy()
    server?.close()
    const result = { success, groups, profile, windowNeverShown: !everShown, blockedRequests, calls, aborted,
      executable: { calls: executableCalls, saves: executableSaves, current: currentExecutable },
      fullAccess: { calls: fullAccessCalls, confirmations: fullAccessConfirmations, decisions: fullAccessDecisions, availabilityChecks: fullAccessAvailabilityChecks },
      research: { catalogs, downloadRequests, syntheticComfyRoot, retainedSyntheticModels: fs.readdirSync(syntheticModels), disposalCount: researchDisposals.length },
      runtime: { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, arch: process.arch },
      ...(error ? { error: error.stack || String(error) } : {}) }
    fs.writeFileSync(path.join(profile, success ? 'result.json' : 'failure.json'), JSON.stringify(result, null, 2))
    console.log('CONNECTED_AGENT_NATIVE_RESULT ' + JSON.stringify(result))
    app.exit(success ? 0 : 1)
  }
  const deadline = setTimeout(() => void finish(false, new Error('Native fixture exceeded 35 seconds')), 35000)
  const until = async predicate => {
    const end = Date.now() + 5000
    while (!await predicate()) { if (Date.now() > end) throw new Error('Native fixture condition timed out'); await delay(20) }
  }
  const payload = id => ({ requestId: id, provider: 'codex', messages: [{ role: 'user', content: `Synthetic ${id}` }],
    context: { project: { name: 'Native synthetic fixture' }, storyboard: { shots: [{ shotId: 'shot-7', label: 'Shot 07' }] } }, images: [], vision: false })
  const invoke = (window, method, data) => window.webContents.executeJavaScript(`window.electronAPI.connectedAgent.${method}(${JSON.stringify(data)})`)
  const toolGuard = { context: { schemaVersion: 1, session: 'native-fixture', projectKey: '/synthetic-only',
    timelineId: 't1', timelineSessionId: 1, compoundClipId: null, storyboardRevision: 0, revision: 1 }, selection: {}, playhead: 0 }
  const toolCalls = []
  const toolServer = createComfyStudioMcpServer()
  const generationRunToolNames = generationRunTools.map(tool => tool.name)
  const assertLiveGenerationRunTools = catalog => {
    const names = new Set(catalog.map(tool => tool.name))
    for (const name of generationRunToolNames) assert.ok(names.has(name), `Missing live ComfyUI Runs tool: ${name}`)
  }
  const researchPayload = requestId => ({ ...payload(requestId), toolsEnabled: true, researchEnabled: true, expectedContext: toolGuard.context })
  const fullConversationId = 'native-full-access-chat'
  const fullAccessPayload = (requestId, token, extra = {}) => ({ ...payload(requestId), toolsEnabled: true,
    fullAccess: true, fullAccessToken: token, conversationId: fullConversationId, expectedContext: structuredClone(toolGuard.context), ...extra })
  const fullAccessConsent = (enabled = true, extra = {}) => ({ enabled, conversationId: fullConversationId,
    expectedContext: structuredClone(toolGuard.context), ...extra })
  const parsed = value => JSON.parse(value.content.find(block => block.type === 'text').text)
  try {
    await app.whenReady()
    server = http.createServer((request, response) => {
      if (!['/', '/frame', '/next', '/export-worker', '/favicon.ico'].includes(request.url)) { response.writeHead(404); response.end(); return }
      response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'none'" })
      response.end('<!doctype html><html><head><title>Velorn native synthetic fixture</title></head><body style="margin:0;background:#16364d;color:white;font:32px sans-serif"><h1>Velorn synthetic IPC fixture</h1><p>No project or provider is connected.</p>'
        + (request.url === '/' ? '<iframe title="Untrusted child frame" src="/frame" style="width:300px;height:160px"></iframe>' : '') + '</body></html>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const createWindow = () => {
      const window = new BrowserWindow({ show: false, width: 1600, height: 1000, useContentSize: true, frame: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true,
          backgroundThrottling: false, preload: path.join(root, 'electron/preload.js') } })
      windows.add(window)
      window.on('show', () => { everShown = true; void finish(false, new Error('Native fixture window became visible')) })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      return window
    }
    main = createWindow()
    main.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    main.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      if (details.url.startsWith(origin + '/')) return callback({ cancel: false })
      blockedRequests.push(details.url); callback({ cancel: true })
    })
    controller = registerConnectedAgentIpc({ ipcMain, app, getMainWindow: () => main, executableAccess,
      fullAccessPreference: createFullAccessPreference({ filePath: path.join(profile, 'full-access-consent.json') }),
      getMcpServer: () => toolServer, getToolContext: async () => structuredClone(toolGuard),
      confirmFullAccess: async ({ window, projectKey, conversationId, shareImagesAndView }) => {
        assert.equal(window, main)
        fullAccessConfirmations.push({ windowId: window.id, projectKey, conversationId, shareImagesAndView })
        return fullAccessConfirmation === 'hold'
          ? new Promise(resolve => { releaseFullAccessConfirmation = resolve }) : fullAccessConfirmation
      },
      assertFullAccessAvailable: async () => {
        fullAccessAvailabilityChecks++
        if (!fullAccessAvailable) throw Object.assign(new Error('Synthetic export lock'), { code: 'BUSY' })
      },
      sendFullAccessCodex: async (request, { signal, onEvent, toolSession, requestApproval, executablePath }) => {
        assert.equal(executablePath, currentExecutable.path, 'Full access uses the native-resolved executable')
        assert.equal(request.fullAccess, true)
        assert.equal(request.provider, 'codex')
        assert.equal(request.toolsEnabled, true)
        assert.equal(request.workingDirectory, fs.realpathSync(profile), 'The host resolves the real temporary project directory')
        assert.ok(toolSession, 'Full-access backend retains the guarded Velorn tool session')
        const catalog = await toolSession.listTools()
        assert.equal(catalog.length, toolServer.tools.length)
        assertLiveGenerationRunTools(catalog)
        fullAccessCalls.push({ requestId: request.requestId, conversationId: request.conversationId, workingDirectory: request.workingDirectory })
        onEvent({ type: 'status', text: 'Synthetic full-access progress' })
        onEvent({ type: 'progress', itemId: 'synthetic-commentary', phase: 'commentary', status: 'running', text: 'Inspecting the synthetic fixture.' })
        onEvent({ type: 'tool', callId: `fake:${request.requestId}`, toolName: 'Shell command', status: 'running', summary: 'Inert synthetic command review' })
        if (request.requestId === 'full_automatic_tools') {
          const result = await toolSession.callTool('save_project', { previewOnly: false })
          assert.notEqual(result.isError, true)
          assert.equal((await toolSession.callTool('save_project', { previewOnly: false })).isError, true, 'Exact duplicate remains blocked')
          onEvent({ type: 'tool', callId: `fake:${request.requestId}`, toolName: 'Shell command', status: 'completed', summary: 'Synthetic result only', output: 'Bounded synthetic output\n' })
          onEvent({ type: 'progress', itemId: 'synthetic-commentary', phase: 'commentary', status: 'completed', text: 'Synthetic inspection complete.' })
          onEvent({ type: 'progress', itemId: 'synthetic-final', phase: 'final_answer', status: 'completed', text: 'Synthetic final response.' })
        }
        if (request.requestId.startsWith('full_approval_')) {
          const approved = await requestApproval({ toolName: 'Codex shell command',
            arguments: { command: 'SYNTHETIC_COMMAND_NEVER_EXECUTED', cwd: request.workingDirectory },
            warnings: ['Synthetic native fixture: this only records a decision and never executes a command.'] })
          fullAccessDecisions.push({ requestId: request.requestId, approved })
          onEvent({ type: 'tool', callId: `fake:${request.requestId}`, toolName: 'Shell command',
            status: approved ? 'completed' : 'denied', summary: 'Synthetic decision recorded without command execution' })
        }
        if (request.requestId.startsWith('full_hold_') || ['hold_navigation', 'hold_dispose'].includes(request.requestId)) {
          held.set(request.requestId, signal)
          await new Promise((resolve, reject) => {
            const abort = () => {
              aborted.push({ requestId: request.requestId, reason: signal.reason })
              onEvent({ type: 'delta', text: 'LATE_ABORTED_FULL_EVENT_MUST_NOT_APPEAR' })
              reject(Object.assign(new Error('Synthetic full-access cancellation'), { code: 'CANCELLED' }))
            }
            if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
          })
        }
        onEvent({ type: 'delta', text: 'Synthetic full-access response. No command executed.' })
        return { success: true, text: 'Synthetic full-access response. No command executed.' }
      },
      getComfyRoot: () => syntheticComfyRoot,
      makeResearchAccess: options => {
        const manager = createModelDownloadManager({ getComfyRoot: options.getComfyRoot,
          assertCanStart: async () => options.assertAvailable?.(TOOL_NAMES.download),
          webClient: { open: async (url, { signal, maxBytes }) => {
            const target = new URL(url)
            assert.equal(target.origin, 'https://models.example.com')
            assert.ok(target.pathname.startsWith('/native_research_'))
            assert.equal(maxBytes, 1024)
            downloadRequests.push({ url, maxBytes })
            const filename = path.basename(target.pathname)
            if (filename.includes('_hold_')) {
              const heldDownload = { signal, reading: false, returned: false }
              stalledDownloads.set(filename, heldDownload)
              return { statusCode: 200, headers: {}, finalUrl: url,
                stream: { [Symbol.asyncIterator]() { return this }, next() { heldDownload.reading = true; return new Promise(() => {}) },
                  async return() { heldDownload.returned = true; return { done: true } } } }
            }
            return { statusCode: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(syntheticGguf.length) }, finalUrl: url,
              stream: (async function* () { yield syntheticGguf })() }
          } },
        })
        researchManagers.push(manager)
        const access = createResearchAccess({ ...options, downloads: manager,
          reader: { search: async () => { throw new Error('Native fixture does not perform web searches') }, read: async () => { throw new Error('Native fixture does not read remote pages') } } })
        const dispose = access.dispose
        access.dispose = () => { const operation = Promise.resolve(dispose()); researchDisposals.push(operation); return operation }
        return access
      },
      executeTool: async (name, args, guard) => {
        assert.deepEqual(guard, toolGuard)
        toolCalls.push({ name, args })
        if (!args.previewOnly) toolGuard.context.revision++
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, previewOnly: args.previewOnly,
          ...(args.previewOnly ? { suggestedApplyCall: { tool: name, arguments: { ...args, previewOnly: false } } } : {}) }) }] }
      },
      fetchImpl: async () => { throw new Error('No real or local model HTTP is permitted in the native fixture') },
      codex: {
        inspect: async (options, { executablePath }) => {
          assert.equal(executablePath, currentExecutable.path, 'Metadata inspection uses the native-resolved executable')
          calls.push({ method: 'inspect', provider: options.provider })
          if (holdInspection) await new Promise(resolve => { releaseInspection = resolve })
          return { success: true, available: true, models: [{ id: 'native-fixture-model' }] }
        },
        send: async (request, { signal, onEvent, toolSession, executablePath }) => {
          assert.equal(executablePath, currentExecutable.path, 'Restricted Codex uses the native-resolved executable')
          calls.push({ method: 'send', requestId: request.requestId })
          onEvent({ type: 'status', text: 'Deterministic native fixture response' })
          if (toolSession) {
            const catalog = await toolSession.listTools()
            catalogs.push({ requestId: request.requestId, count: catalog.length, researchEnabled: request.researchEnabled })
            assert.equal(catalog.length, toolServer.tools.length + (request.researchEnabled ? Object.values(TOOL_NAMES).length : 0))
            assertLiveGenerationRunTools(catalog)
            for (const name of Object.values(TOOL_NAMES)) assert.equal(catalog.some(tool => tool.name === name), request.researchEnabled)
            if (request.requestId.startsWith('native_catalog_')) {
              if (!request.researchEnabled) assert.equal((await toolSession.callTool(TOOL_NAMES.status, {})).isError, true)
              return { success: true, text: 'Synthetic catalog inspected.' }
            }
            if (request.requestId === 'native_research_status') {
              researchResults.set(request.requestId, await toolSession.callTool(TOOL_NAMES.status, {}))
              return { success: true, text: 'Synthetic download status inspected.' }
            }
            if (request.researchEnabled) {
              const result = await toolSession.callTool(TOOL_NAMES.download, {
                url: `https://models.example.com/${request.requestId}.gguf`, filename: `${request.requestId}.gguf`,
                targetSubdir: 'checkpoints', maxBytes: 1024, expectedSha256: syntheticSha256, previewOnly: false,
              })
              researchResults.set(request.requestId, result)
              return { success: true, text: result.isError ? 'Synthetic model download was not started.' : 'Synthetic model download job created.' }
            }
            const result = await toolSession.callTool('add_track', { type: 'video', name: 'Synthetic track', previewOnly: false })
            return { success: true, text: result.isError ? 'Synthetic action was not applied.' : 'Synthetic action applied.' }
          }
          if (request.requestId.startsWith('hold_')) {
            held.set(request.requestId, signal)
            await new Promise((resolve, reject) => {
              const abort = () => {
                aborted.push({ requestId: request.requestId, reason: signal.reason })
                onEvent({ type: 'delta', text: 'LATE_ABORTED_EVENT_MUST_NOT_APPEAR' })
                reject(Object.assign(new Error('Synthetic cancellation'), { code: 'CANCELLED' }))
              }
              if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
            })
          }
          onEvent({ type: 'delta', text: 'Native fixture says [[shot:shot-7]].' })
          return { success: true, text: 'Native fixture says [[shot:shot-7]].' }
        },
      }, timeoutMs: 10000, inspectTimeoutMs: 10000 })
    await main.loadURL(origin + '/')
    assert.equal(main.isVisible(), false)
    assert.equal(main.webContents.getLastWebPreferences().sandbox, true)
    assert.equal(main.webContents.getLastWebPreferences().contextIsolation, true)
    assert.equal(await main.webContents.executeJavaScript('typeof require'), 'undefined')
    const inspected = await invoke(main, 'inspect', { provider: 'codex' })
    assert.equal(inspected.success, true)
    await main.webContents.executeJavaScript('window.fixtureEvents=[];window.fixtureUnsubscribe=window.electronAPI.connectedAgent.onEvent(value=>window.fixtureEvents.push(value));true')
    const sent = await invoke(main, 'send', payload('native_main'))
    assert.equal(sent.success, true)
    await until(async () => (await main.webContents.executeJavaScript('window.fixtureEvents.length')) >= 2)
    const events = await main.webContents.executeJavaScript('window.fixtureEvents')
    assert.ok(events.some(event => event.requestId === 'native_main' && event.type === 'delta'))
    pass('Actual sandboxed/context-isolated preload can inspect, send and receive streamed events from the authorized main frame')

    assert.deepEqual(await invoke(main, 'codexExecutable', { action: 'status' }), { success: true, executable: automaticExecutable })
    const beforeMalformedExecutable = executableCalls.length
    for (const malformed of [null, {}, { action: 'run' }, { action: 'choose', path: '/renderer-supplied-codex' },
      { action: 'auto', executablePath: '/renderer-supplied-codex' }, { action: 'status', args: ['--dangerous'] }]) {
      assert.equal((await invoke(main, 'codexExecutable', malformed)).code, 'INVALID_REQUEST')
    }
    assert.equal(executableCalls.length, beforeMalformedExecutable, 'Invalid renderer paths/actions never reach executable settings')
    assert.deepEqual(await invoke(main, 'codexExecutable', { action: 'choose' }), { success: true, cancelled: true })
    assert.deepEqual(executableSaves, [])
    pickerMode = 'select'
    assert.deepEqual(await invoke(main, 'codexExecutable', { action: 'choose' }), { success: true, executable: selectedExecutable })
    const resolutionsBefore = executableCalls.filter(method => method === 'resolve').length
    assert.equal((await invoke(main, 'inspect', { provider: 'codex', executablePath: '/renderer-forged-codex' })).success, true)
    assert.equal((await invoke(main, 'send', { ...payload('native_picked_executable'), executablePath: '/renderer-forged-codex' })).success, true)
    assert.equal(executableCalls.filter(method => method === 'resolve').length, resolutionsBefore + 2, 'Each Codex inspect/send resolves its native path exactly once')
    assert.deepEqual(await invoke(main, 'codexExecutable', { action: 'auto' }), { success: true, executable: automaticExecutable })
    assert.deepEqual(executableSaves, [selectedExecutable, automaticExecutable])
    const beforeLocalExecutable = executableCalls.length
    assert.equal((await invoke(main, 'inspect', { provider: 'lmstudio' })).success, false, 'Local provider reaches only the deliberately failing mock HTTP function')
    assert.equal(executableCalls.length, beforeLocalExecutable, 'LM Studio does not resolve a Codex executable')
    pass('Native executable settings accept only status/choose/auto, preserve cancelled picks and route resolved paths to Codex but not LM Studio')

    await main.webContents.executeJavaScript(`window.executableBusyResult=null;void window.electronAPI.connectedAgent.send(${JSON.stringify(payload('hold_executable_busy'))}).then(value=>window.executableBusyResult=value);true`)
    await until(() => held.has('hold_executable_busy'))
    const beforeBusyPicker = executableSaves.length
    for (const action of ['choose', 'auto']) assert.equal((await invoke(main, 'codexExecutable', { action })).code, 'BUSY')
    assert.equal(executableSaves.length, beforeBusyPicker)
    assert.equal((await invoke(main, 'cancel', { requestId: 'hold_executable_busy' })).cancelled, true)
    await until(async () => Boolean(await main.webContents.executeJavaScript('window.executableBusyResult')))
    assert.equal((await main.webContents.executeJavaScript('window.executableBusyResult')).code, 'CANCELLED')
    holdInspection = true; releaseInspection = undefined
    await main.webContents.executeJavaScript('window.executableInspectResult=null;void window.electronAPI.connectedAgent.inspect({provider:"codex"}).then(value=>window.executableInspectResult=value);true')
    await until(() => typeof releaseInspection === 'function')
    for (const action of ['choose', 'auto']) assert.equal((await invoke(main, 'codexExecutable', { action })).code, 'BUSY')
    releaseInspection(); holdInspection = false
    await until(async () => Boolean(await main.webContents.executeJavaScript('window.executableInspectResult')))
    assert.equal((await main.webContents.executeJavaScript('window.executableInspectResult')).success, true)
    pass('An active native response or metadata inspection prevents executable preference changes')

    const originalProjectKey = toolGuard.context.projectKey
    toolGuard.context.projectKey = profile
    const enableFullAccess = async () => {
      const consent = await invoke(main, 'setFullAccess', fullAccessConsent())
      assert.equal(consent.success, true, consent.error)
      assert.equal(consent.enabled, true)
      assert.equal(typeof consent.token, 'string')
      assert.equal(consent.shareImagesAndView, false, 'Legacy confirmation callbacks cannot approve automatic image sharing')
      return consent.token
    }
    const readFixtureEvents = requestId => main.webContents.executeJavaScript(`window.fixtureEvents.filter(value=>value.requestId===${JSON.stringify(requestId)})`)
    const startFullAccess = async (requestId, token) => {
      await main.webContents.executeJavaScript(`window.fullResult=null;void window.electronAPI.connectedAgent.send(${JSON.stringify(fullAccessPayload(requestId, token))}).then(value=>window.fullResult=value);true`)
    }
    const waitFullAccessResult = async () => {
      await until(async () => Boolean(await main.webContents.executeJavaScript('window.fullResult')))
      return main.webContents.executeJavaScript('window.fullResult')
    }
    const startPicker = async () => {
      pickerMode = 'hold'; pendingPicker = undefined
      await main.webContents.executeJavaScript('window.executablePickResult=null;void window.electronAPI.connectedAgent.codexExecutable({action:"choose"}).then(value=>window.executablePickResult=value);true')
      await until(() => Boolean(pendingPicker))
      return pendingPicker
    }
    const pendingChoice = await startPicker()
    const beforePendingProvider = calls.length
    assert.equal((await invoke(main, 'send', payload('native_during_picker'))).code, 'BUSY')
    assert.equal((await invoke(main, 'inspect', { provider: 'codex' })).code, 'BUSY')
    assert.equal((await invoke(main, 'setFullAccess', fullAccessConsent())).code, 'BUSY')
    for (const action of ['choose', 'auto']) assert.equal((await invoke(main, 'codexExecutable', { action })).code, 'BUSY')
    assert.equal(calls.length, beforePendingProvider)
    assert.equal(fullAccessConfirmations.length, 0)
    pickerMode = 'select'; pendingChoice.release()
    await until(async () => Boolean(await main.webContents.executeJavaScript('window.executablePickResult')))
    assert.deepEqual(await main.webContents.executeJavaScript('window.executablePickResult'), { success: true, executable: selectedExecutable })
    pass('A pending native picker blocks sends, connection checks, full-access confirmation and competing preference changes')

    for (const lifecycle of ['navigation', 'destroyed']) {
      const pending = await startPicker(), savesBefore = executableSaves.length
      if (lifecycle === 'navigation') await main.loadURL(origin + '/next')
      else {
        const replacement = createWindow()
        main.destroy(); main = replacement
        await main.loadURL(origin + '/')
      }
      await until(() => pending.signal.aborted)
      assert.equal(pending.signal.reason, lifecycle)
      assert.equal(await pending.isCurrent(), false)
      pickerMode = 'select'; pending.release()
      await until(() => pending.finished)
      assert.equal(executableSaves.length, savesBefore, 'A stale native picker result never saves settings')
      assert.deepEqual((await invoke(main, 'codexExecutable', { action: 'status' })).executable, selectedExecutable)
      assert.equal((await invoke(main, 'inspect', { provider: 'codex' })).success, true, 'New main frame can inspect after stale picker cleanup')
    }
    await main.webContents.executeJavaScript('window.fixtureEvents=[];window.fixtureUnsubscribe=window.electronAPI.connectedAgent.onEvent(value=>window.fixtureEvents.push(value));true')
    pass('Real main-frame navigation and native-window destruction abort pending picker scope and discard late choices without saving')
    const beforeFullRestricted = calls.length
    assert.equal((await invoke(main, 'send', fullAccessPayload('full_unconfirmed', 'forged-token'))).code, 'UNAUTHORIZED')
    await until(() => main.webContents.mainFrame.frames.length > 0)
    const fullFrame = main.webContents.mainFrame.frames[0]
    const fullForeign = createWindow(); await fullForeign.loadURL(origin + '/export-worker')
    const fullForeignChecks = [
      ['getFullAccessPreference', undefined],
      ['setFullAccess', fullAccessConsent()], ['setFullAccess', fullAccessConsent(false)],
      ['send', fullAccessPayload('full_foreign', 'forged-token')],
      ...['status', 'choose', 'auto'].map(action => ['codexExecutable', { action }]),
    ]
    const beforeForeignExecutable = executableCalls.length, beforeForeignAvailability = fullAccessAvailabilityChecks
    for (const [method, data] of fullForeignChecks) {
      assert.equal((await fullFrame.executeJavaScript(`window.electronAPI.connectedAgent.${method}(${JSON.stringify(data)})`)).code, 'UNAUTHORIZED')
      assert.equal((await invoke(fullForeign, method, data)).code, 'UNAUTHORIZED')
    }
    assert.equal(fullAccessConfirmations.length, 0)
    assert.equal(fullAccessAvailabilityChecks, beforeForeignAvailability)
    assert.equal(fullAccessCalls.length, 0)
    assert.equal(calls.length, beforeFullRestricted)
    assert.equal(executableCalls.length, beforeForeignExecutable, 'Foreign native windows/iframes never reach executable metadata or preferences')
    assert.equal((await invoke(main, 'setFullAccess', fullAccessConsent(true, { expectedContext: { ...toolGuard.context, projectKey: '/forged-project' } }))).code, 'STALE_APPROVAL')
    toolGuard.context.projectKey = path.join(profile, 'missing-project')
    assert.equal((await invoke(main, 'setFullAccess', fullAccessConsent())).success, false)
    toolGuard.context.projectKey = path.join(syntheticComfyRoot, 'main.py')
    assert.equal((await invoke(main, 'setFullAccess', fullAccessConsent())).code, 'INVALID_REQUEST')
    toolGuard.context.projectKey = profile
    assert.equal(fullAccessConfirmations.length, 0, 'Invalid and stale folders never reach confirmation')
    fullAccessAvailable = false
    assert.equal((await invoke(main, 'setFullAccess', fullAccessConsent())).code, 'BUSY')
    fullAccessAvailable = true
    fullAccessConfirmation = false
    assert.deepEqual(await invoke(main, 'setFullAccess', fullAccessConsent()), { success: true, enabled: false, remembered: false })
    assert.equal((await invoke(main, 'send', fullAccessPayload('full_denied_consent', 'forged-token'))).code, 'UNAUTHORIZED')
    assert.equal(fullAccessCalls.length, 0)
    pass('Full access is default-off; real iframe/foreign-window, forged token, stale project, unavailable folder, export lock and denied confirmation never reach a backend')

    const beforeImagePreferenceConfirmation = fullAccessConfirmations.length
    for (const shareImagesAndView of [null, 'true', 1, [], {}]) {
      const invalid = await invoke(main, 'setFullAccess', fullAccessConsent(true, { shareImagesAndView }))
      assert.equal(invalid.code, 'INVALID_REQUEST')
      assert.equal(Object.hasOwn(invalid, 'shareImagesAndView'), false)
      assert.equal(Object.hasOwn(invalid, 'token'), false)
    }
    assert.equal(fullAccessConfirmations.length, beforeImagePreferenceConfirmation)
    for (const requested of [false, true]) {
      for (const confirmed of [false, true]) {
        fullAccessConfirmation = { approved: true, shareImagesAndView: confirmed }
        const grant = await invoke(main, 'setFullAccess', fullAccessConsent(true, { shareImagesAndView: requested }))
        assert.equal(grant.enabled, true)
        assert.equal(grant.shareImagesAndView, confirmed, 'Only the native checkbox result is returned, not the requested default')
        assert.equal(fullAccessConfirmations.at(-1).shareImagesAndView, requested, 'Actual preload/IPC preserve the remembered default')
        const revoked = await invoke(main, 'setFullAccess', fullAccessConsent(false))
        assert.deepEqual(revoked, { success: true, enabled: false, remembered: false })
        assert.equal((await invoke(main, 'send', fullAccessPayload('full_revoked_image_bundle', grant.token, { shareImagesAndView: true }))).code, 'UNAUTHORIZED')
      }
    }
    fullAccessConfirmation = { approved: false, shareImagesAndView: true }
    assert.deepEqual(await invoke(main, 'setFullAccess', fullAccessConsent(true, { shareImagesAndView: true })), { success: true, enabled: false, remembered: false })
    assert.equal(fullAccessCalls.length, 0, 'Bundling permissions does not capture an image, run a command or contact a provider')
    assert.equal(calls.length, beforeFullRestricted)
    pass('Real preload/IPC strictly validates image preferences, conveys one native confirmation choice and grants no images/token on cancellation or revocation')

    fullAccessConfirmation = true
    let fullToken = await enableFullAccess()
    assert.equal(fullAccessConfirmations.at(-1).projectKey, profile)
    assert.equal(fullAccessConfirmations.at(-1).conversationId, fullConversationId)
    for (const extra of [{ fullAccessToken: 'forged-token' }, { conversationId: 'different-chat' }]) {
      assert.equal((await invoke(main, 'send', fullAccessPayload('full_wrong_scope', fullToken, extra))).code, 'UNAUTHORIZED')
    }
    for (const extra of [{ provider: 'lmstudio' }, { toolsEnabled: false }]) {
      assert.equal((await invoke(main, 'send', fullAccessPayload('full_unsupported', fullToken, extra))).code, 'INVALID_REQUEST')
    }
    fullAccessAvailable = false
    assert.equal((await invoke(main, 'send', fullAccessPayload('full_export_locked', fullToken))).code, 'BUSY')
    fullAccessAvailable = true
    assert.equal(fullAccessCalls.length, 0)
    assert.equal((await invoke(main, 'send', fullAccessPayload('full_scoped_success', fullToken, { workingDirectory: '/forged-working-directory' }))).success, true)
    const fullEvents = await readFixtureEvents('full_scoped_success')
    assert.ok(fullEvents.some(event => event.type === 'status' && event.text === 'Synthetic full-access progress'))
    assert.ok(fullEvents.some(event => event.type === 'tool' && event.toolName === 'Shell command' && event.status === 'running'))
    assert.ok(fullEvents.some(event => event.type === 'delta' && event.text.includes('No command executed')))
    assert.equal(calls.length, beforeFullRestricted, 'Full access routes only to the injected full backend, never restricted Codex')
    const beforeScopeRejection = fullAccessCalls.length
    const initialSession = toolGuard.context.session
    toolGuard.context.session = 'different-project-session'
    assert.equal((await invoke(main, 'send', fullAccessPayload('full_changed_project', fullToken))).code, 'STALE_APPROVAL')
    toolGuard.context.session = initialSession
    assert.equal((await invoke(main, 'send', fullAccessPayload('full_old_project_token', fullToken))).code, 'UNAUTHORIZED')
    assert.equal(fullAccessCalls.length, beforeScopeRejection)
    fullToken = await enableFullAccess()
    assert.equal((await invoke(main, 'send', payload('native_restricted_revokes_full'))).success, true)
    assert.equal((await invoke(main, 'send', fullAccessPayload('full_after_restricted', fullToken))).code, 'UNAUTHORIZED')
    pass('Native confirmation grants only the current window/project/chat; exact token and tool/provider requirements gate the fake full backend and host-resolved working directory')

    fullToken = await enableFullAccess()
    const beforeAutomatic = toolCalls.length
    assert.equal((await invoke(main, 'send', fullAccessPayload('full_automatic_tools', fullToken))).success, true)
    const automaticEvents = await readFixtureEvents('full_automatic_tools')
    assert.equal(automaticEvents.some(event => event.type === 'approval'), false)
    assert.deepEqual(toolCalls.slice(beforeAutomatic).map(call => [call.name, call.args.previewOnly]), [
      ['save_project', true], ['save_project', false], ['save_project', true],
    ])
    assert.ok(automaticEvents.some(event => event.type === 'tool' && event.summary === 'Completed under Full computer access.'))
    assert.ok(automaticEvents.some(event => event.type === 'tool' && event.output === 'Bounded synthetic output\n'))
    assert.deepEqual(automaticEvents.filter(event => event.type === 'progress').map(event => [event.itemId, event.phase, event.status]), [
      ['synthetic-commentary', 'commentary', 'running'], ['synthetic-commentary', 'commentary', 'completed'], ['synthetic-final', 'final_answer', 'completed'],
    ])
    pass('Native full-access grant automatically approves host MCP previews/applies without cards; exact duplicate is blocked and phased progress/output crosses actual preload')

    fullToken = await enableFullAccess()
    assert.equal((await invoke(main, 'codexExecutable', { action: 'status' })).success, true)
    pickerMode = 'cancel'
    assert.deepEqual(await invoke(main, 'codexExecutable', { action: 'choose' }), { success: true, cancelled: true })
    assert.equal((await invoke(main, 'send', fullAccessPayload('full_after_cancelled_picker', fullToken))).success, true, 'Status and cancelled picker preserve the current native grant')
    pickerMode = 'select'
    assert.equal((await invoke(main, 'codexExecutable', { action: 'choose' })).success, true)
    assert.equal((await invoke(main, 'send', fullAccessPayload('full_after_executable_change', fullToken))).code, 'UNAUTHORIZED')
    fullToken = await enableFullAccess()
    assert.equal((await invoke(main, 'codexExecutable', { action: 'auto' })).success, true)
    assert.equal((await invoke(main, 'send', fullAccessPayload('full_after_automatic_change', fullToken))).code, 'UNAUTHORIZED')
    pass('Executable status/cancel preserve a native full-access grant; successful selection or automatic reset revokes the old token')

    fullToken = await enableFullAccess()
    for (const approved of [false, true]) {
      const requestId = `full_approval_${approved}`
      const beforeDecision = fullAccessDecisions.length
      await startFullAccess(requestId, fullToken)
      await until(async () => (await readFixtureEvents(requestId)).some(event => event.type === 'approval'))
      const approval = (await readFixtureEvents(requestId)).find(event => event.type === 'approval')
      assert.equal(approval.toolName, 'Codex shell command')
      assert.equal(approval.arguments.command, 'SYNTHETIC_COMMAND_NEVER_EXECUTED')
      assert.equal(approval.arguments.cwd, fs.realpathSync(profile))
      assert.equal(fullAccessDecisions.length, beforeDecision, 'No decision is assumed before user review')
      const decision = { requestId, approvalId: approval.approvalId, approved }
      assert.equal((await fullFrame.executeJavaScript(`window.electronAPI.connectedAgent.approveTool(${JSON.stringify(decision)})`)).code, 'UNAUTHORIZED')
      assert.equal((await invoke(fullForeign, 'approveTool', decision)).code, 'UNAUTHORIZED')
      assert.equal((await invoke(main, 'approveTool', decision)).success, true)
      assert.equal((await invoke(main, 'approveTool', decision)).code, 'STALE_APPROVAL')
      assert.equal((await waitFullAccessResult()).success, true)
      assert.deepEqual(fullAccessDecisions.at(-1), { requestId, approved })
      assert.ok((await readFixtureEvents(requestId)).some(event => event.type === 'tool' && event.status === (approved ? 'completed' : 'denied')))
    }
    for (const action of ['cancel', 'revoke']) {
      const requestId = `full_approval_${action}`
      await startFullAccess(requestId, fullToken)
      await until(async () => (await readFixtureEvents(requestId)).some(event => event.type === 'approval'))
      const approval = (await readFixtureEvents(requestId)).find(event => event.type === 'approval')
      if (action === 'cancel') assert.equal((await invoke(main, 'cancel', { requestId })).cancelled, true)
      else assert.deepEqual(await invoke(main, 'setFullAccess', fullAccessConsent(false)), { success: true, enabled: false, remembered: false })
      assert.equal((await waitFullAccessResult()).code, 'CANCELLED')
      assert.equal((await invoke(main, 'approveTool', { requestId, approvalId: approval.approvalId, approved: true })).code, 'STALE_APPROVAL')
      assert.equal(fullAccessDecisions.some(item => item.requestId === requestId), false)
    }
    assert.equal((await invoke(main, 'send', fullAccessPayload('full_after_disable', fullToken))).code, 'UNAUTHORIZED')
    pass('Actual preload forwards full-backend progress, tool activity and one-use command approvals; denial, Stop and permission revocation leave no accepted late decision')

    fullAccessConfirmation = 'hold'
    await main.webContents.executeJavaScript(`window.consentResult=null;void window.electronAPI.connectedAgent.setFullAccess(${JSON.stringify(fullAccessConsent(true, { shareImagesAndView: true }))}).then(value=>window.consentResult=value);true`)
    await until(() => typeof releaseFullAccessConfirmation === 'function')
    assert.equal((await invoke(main, 'setFullAccess', fullAccessConsent())).code, 'BUSY')
    assert.equal((await invoke(main, 'send', payload('native_during_full_confirmation'))).code, 'BUSY')
    for (const action of ['choose', 'auto']) assert.equal((await invoke(main, 'codexExecutable', { action })).code, 'BUSY')
    assert.deepEqual(await invoke(main, 'setFullAccess', fullAccessConsent(false)), { success: true, enabled: false, remembered: false })
    releaseFullAccessConfirmation({ approved: true, shareImagesAndView: true })
    await until(async () => Boolean(await main.webContents.executeJavaScript('window.consentResult')))
    const staleBundledConsent = await main.webContents.executeJavaScript('window.consentResult')
    assert.equal(staleBundledConsent.code, 'STALE_APPROVAL')
    assert.equal(Object.hasOwn(staleBundledConsent, 'shareImagesAndView'), false)
    assert.equal(Object.hasOwn(staleBundledConsent, 'token'), false)
    fullAccessConfirmation = true
    fullToken = await enableFullAccess()
    await startFullAccess('full_hold_revoke', fullToken)
    await until(() => held.has('full_hold_revoke'))
    await invoke(main, 'setFullAccess', fullAccessConsent(false))
    assert.equal((await waitFullAccessResult()).code, 'CANCELLED')
    assert.equal(held.get('full_hold_revoke').reason, 'full-access-revoked')
    assert.ok(!(await main.webContents.executeJavaScript('JSON.stringify(window.fixtureEvents)')).includes('LATE_ABORTED_FULL'))
    assert.equal((await invoke(main, 'send', fullAccessPayload('full_after_running_revoke', fullToken))).code, 'UNAUTHORIZED')
    pass('Revoking while native confirmation or full-backend work is pending invalidates the grant, cancels work and filters late native events')

    fullToken = await enableFullAccess()
    await startFullAccess('full_hold_destroyed', fullToken)
    await until(() => held.has('full_hold_destroyed'))
    fullForeign.destroy()
    assert.equal(held.get('full_hold_destroyed').aborted, false, 'Destroying an unauthorized window cannot revoke the authorized window grant')
    const replacementMain = createWindow() // Keep Electron alive while testing a destroyed owner, rather than app quit.
    main.destroy()
    await until(() => held.get('full_hold_destroyed').aborted)
    assert.equal(held.get('full_hold_destroyed').reason, 'destroyed')
    main = replacementMain; await main.loadURL(origin + '/')
    await main.webContents.executeJavaScript('window.fixtureEvents=[];window.fixtureUnsubscribe=window.electronAPI.connectedAgent.onEvent(value=>window.fixtureEvents.push(value));true')
    assert.equal((await invoke(main, 'send', fullAccessPayload('full_replacement_window', fullToken))).code, 'UNAUTHORIZED')
    assert.equal((await invoke(main, 'send', payload('native_after_destroyed_full'))).success, true)
    toolGuard.context.projectKey = originalProjectKey
    pass('Destroying the authorized native window cancels full-access work and a replacement window cannot reuse its grant')

    await until(() => main.webContents.mainFrame.frames.length > 0)
    const frame = main.webContents.mainFrame.frames[0]
    assert.equal(await frame.executeJavaScript('typeof require'), 'undefined')
    assert.equal(await frame.executeJavaScript('typeof window.electronAPI?.connectedAgent'), 'object', 'Worst-case child frame receives the test-enabled actual preload')
    const beforeForeign = calls.length
    for (const [method, data] of [['inspect', { provider: 'codex' }], ['send', payload('native_iframe')], ['send', researchPayload('native_iframe_research')], ['cancel', { requestId: 'native_main' }], ['capture', { rect: { x: 0, y: 0, width: 10, height: 10 } }]]) {
      const result = await frame.executeJavaScript(`window.electronAPI.connectedAgent.${method}(${JSON.stringify(data)})`)
      assert.equal(result.code, 'UNAUTHORIZED', `Child-frame ${method} is denied`)
    }
    const worker = createWindow(); await worker.loadURL(origin + '/export-worker')
    for (const [method, data] of [['inspect', { provider: 'codex' }], ['send', payload('native_worker')], ['send', researchPayload('native_worker_research')], ['cancel', { requestId: 'native_main' }], ['capture', { rect: { x: 0, y: 0, width: 10, height: 10 } }]]) {
      assert.equal((await invoke(worker, method, data)).code, 'UNAUTHORIZED', `Export-worker ${method} is denied`)
    }
    assert.equal(calls.length, beforeForeign)
    assert.equal(researchManagers.length, 0)
    assert.equal(downloadRequests.length, 0)
    assert.deepEqual(fs.readdirSync(syntheticModels), [])
    worker.destroy()
    pass('Real iframe and separate export-worker IPC calls, including forged research opt-in, are denied before any provider, research manager or capture')

    for (const approved of [true, false]) {
      const requestId = `native_tools_${approved}`
      const before = toolCalls.filter(call => call.args.previewOnly === false).length
      const data = { ...payload(requestId), toolsEnabled: true, expectedContext: toolGuard.context }
      await main.webContents.executeJavaScript(`window.toolResult=null;void window.electronAPI.connectedAgent.send(${JSON.stringify(data)}).then(value=>window.toolResult=value);true`)
      await until(async () => Boolean(await main.webContents.executeJavaScript(`window.fixtureEvents.find(value=>value.requestId===${JSON.stringify(requestId)}&&value.type==='approval')`)))
      const approval = await main.webContents.executeJavaScript(`window.fixtureEvents.find(value=>value.requestId===${JSON.stringify(requestId)}&&value.type==='approval')`)
      const decision = { requestId, approvalId: approval.approvalId, approved }
      assert.equal(toolCalls.filter(call => call.args.previewOnly === false).length, before)
      assert.equal((await frame.executeJavaScript(`window.electronAPI.connectedAgent.approveTool(${JSON.stringify(decision)})`)).code, 'UNAUTHORIZED')
      assert.equal((await invoke(main, 'approveTool', decision)).success, true)
      assert.equal((await invoke(main, 'approveTool', decision)).code, 'STALE_APPROVAL')
      await until(async () => Boolean(await main.webContents.executeJavaScript('window.toolResult')))
      assert.equal((await main.webContents.executeJavaScript('window.toolResult')).success, true)
      assert.equal(toolCalls.filter(call => call.args.previewOnly === false).length, before + Number(approved))
    }
    pass('Actual preload exposes the full catalog through a host session; native approval is main-frame-only, one-use, and denial never applies')

    for (const researchEnabled of [false, true, false]) {
      const requestId = `native_catalog_${catalogs.length}`
      assert.equal((await invoke(main, 'send', { ...payload(requestId), toolsEnabled: true, researchEnabled, expectedContext: toolGuard.context })).success, true)
    }
    const liveToolCount = toolServer.tools.length
    const researchToolCount = Object.values(TOOL_NAMES).length
    assert.deepEqual(catalogs.filter(entry => entry.requestId.startsWith('native_catalog_')).map(entry => entry.count),
      [liveToolCount, liveToolCount + researchToolCount, liveToolCount])
    assertLiveGenerationRunTools(toolServer.tools)
    assert.equal(researchManagers.length, 1)
    assert.equal(downloadRequests.length, 0)
    pass(`Actual main-frame opt-in adds ${researchToolCount} private research tools (${liveToolCount + researchToolCount}); ordinary and external MCP catalogs remain ${liveToolCount}`)

    const approveResearchDownload = async (requestId, approved) => {
      const beforeFiles = fs.readdirSync(syntheticModels), beforeRequests = downloadRequests.length
      await main.webContents.executeJavaScript(`window.researchResult=null;void window.electronAPI.connectedAgent.send(${JSON.stringify(researchPayload(requestId))}).then(value=>window.researchResult=value);true`)
      await until(async () => Boolean(await main.webContents.executeJavaScript(`window.fixtureEvents.find(value=>value.requestId===${JSON.stringify(requestId)}&&value.type==='approval')`)))
      const approval = await main.webContents.executeJavaScript(`window.fixtureEvents.find(value=>value.requestId===${JSON.stringify(requestId)}&&value.type==='approval')`)
      assert.equal(approval.toolName, TOOL_NAMES.download)
      assert.ok(approval.arguments.previewToken)
      assert.equal(approval.arguments.maxBytes, 1024)
      assert.equal(approval.arguments.expectedSha256, syntheticSha256)
      assert.equal(downloadRequests.length, beforeRequests)
      assert.deepEqual(fs.readdirSync(syntheticModels), beforeFiles)
      const decision = { requestId, approvalId: approval.approvalId, approved }
      const childFrame = main.webContents.mainFrame.frames[0]
      if (childFrame) assert.equal((await childFrame.executeJavaScript(`window.electronAPI.connectedAgent.approveTool(${JSON.stringify(decision)})`)).code, 'UNAUTHORIZED')
      assert.equal((await invoke(main, 'approveTool', decision)).success, true)
      assert.equal((await invoke(main, 'approveTool', decision)).code, 'STALE_APPROVAL')
      await until(async () => Boolean(await main.webContents.executeJavaScript('window.researchResult')))
      assert.equal((await main.webContents.executeJavaScript('window.researchResult')).success, true)
      const result = researchResults.get(requestId)
      if (!approved) {
        assert.equal(result.isError, true)
        assert.equal(downloadRequests.length, beforeRequests)
        assert.deepEqual(fs.readdirSync(syntheticModels), beforeFiles)
        return null
      }
      assert.notEqual(result.isError, true)
      const job = parsed(result)
      assert.ok(job.jobId)
      return { job, manager: researchManagers.at(-1), owner: ownerFromGuard(toolGuard) }
    }
    const approvedDownload = await approveResearchDownload('native_research_approved', true)
    await until(() => approvedDownload.manager.status({ jobId: approvedDownload.job.jobId }, { owner: approvedDownload.owner }).state === 'completed')
    assert.deepEqual(fs.readFileSync(path.join(syntheticModels, 'native_research_approved.gguf')), syntheticGguf)
    await approveResearchDownload('native_research_denied', false)
    assert.equal((await invoke(main, 'send', researchPayload('native_research_status'))).success, true)
    const status = parsed(researchResults.get('native_research_status'))
    assert.equal(status.jobs.length, 1)
    assert.equal(status.jobs[0].state, 'completed')
    assert.equal(status.jobs[0].sha256, syntheticSha256)
    assert.deepEqual(fs.readdirSync(syntheticModels), ['native_research_approved.gguf'])
    pass('Real native approval installs only the verified synthetic GGUF; denial creates nothing and a later preload turn reads completed status')

    for (const rect of [{ x: -1, y: 0, width: 10, height: 10 }, { x: 1500, y: 0, width: 300, height: 10 }, { x: 0, y: 0, width: 0, height: 10 }]) {
      assert.equal((await invoke(main, 'capture', { rect })).code, 'INVALID_REQUEST')
    }
    const captured = await invoke(main, 'capture', { rect: { x: 0, y: 0, width: 1600, height: 960 } })
    assert.equal(captured.success, true, captured.error)
    assert.match(captured.dataUrl, /^data:image\/jpeg;base64,/)
    assert.ok(Math.max(captured.width, captured.height) <= 1280)
    assert.ok(Buffer.from(captured.dataUrl.split(',')[1], 'base64').length <= LIMITS.imageBytes)
    assert.equal(main.isVisible(), false)
    pass('Actual never-shown capture rejects out-of-window rectangles and returns bounded JPEG bytes/dimensions')

    await main.webContents.executeJavaScript(`window.cancelResult=null;void window.electronAPI.connectedAgent.send(${JSON.stringify(payload('hold_cancel'))}).then(value=>window.cancelResult=value);true`)
    await until(() => held.has('hold_cancel'))
    assert.equal((await invoke(main, 'cancel', { requestId: 'hold_cancel' })).cancelled, true)
    await until(async () => Boolean(await main.webContents.executeJavaScript('window.cancelResult')))
    assert.equal((await main.webContents.executeJavaScript('window.cancelResult')).code, 'CANCELLED')
    assert.ok(!(await main.webContents.executeJavaScript('JSON.stringify(window.fixtureEvents)')).includes('LATE_ABORTED'))
    assert.equal((await invoke(main, 'send', payload('native_after_cancel'))).success, true)
    await main.webContents.executeJavaScript('window.fixtureUnsubscribe();window.fixtureEvents=[]')
    assert.equal((await invoke(main, 'send', payload('native_unsubscribed'))).success, true)
    assert.deepEqual(await main.webContents.executeJavaScript('window.fixtureEvents'), [])
    pass('Cancellation aborts native work, filters late events, allows recovery and actual preload unsubscribe removes listeners')

    toolGuard.context.projectKey = profile
    assert.deepEqual(await invoke(main, 'getFullAccessPreference'), { success: true, remembered: false })
    const confirmationsBeforeRestore = fullAccessConfirmations.length
    assert.equal((await invoke(main, 'setFullAccess', fullAccessConsent(true, { restoreOnly: true }))).enabled, false)
    assert.equal(fullAccessConfirmations.length, confirmationsBeforeRestore, 'No automatic popup without saved native consent')
    fullAccessConfirmation = { approved: true, shareImagesAndView: true, remember: true }
    const rememberedGrant = await invoke(main, 'setFullAccess', fullAccessConsent())
    assert.equal(rememberedGrant.remembered, true)
    assert.equal(await createFullAccessPreference({ filePath: path.join(profile, 'full-access-consent.json') }).read(), true)
    await invoke(main, 'setFullAccess', fullAccessConsent(false))
    const restoredGrant = await invoke(main, 'setFullAccess', fullAccessConsent(true, { restoreOnly: true }))
    assert.equal(restoredGrant.enabled, true)
    assert.notEqual(restoredGrant.token, rememberedGrant.token, 'Restoring creates fresh authority, not a saved token')
    assert.equal(fullAccessConfirmations.length, confirmationsBeforeRestore + 1)
    await invoke(main, 'setFullAccess', fullAccessConsent(false, { forget: true }))
    assert.deepEqual(await invoke(main, 'getFullAccessPreference'), { success: true, remembered: false })
    assert.equal((await invoke(main, 'setFullAccess', fullAccessConsent(true, { restoreOnly: true }))).enabled, false)
    fullAccessConfirmation = true
    pass('Real preload/IPC persists native opt-in only, restores a fresh scoped grant without a dialog and explicitly forgets it')

    toolGuard.context.projectKey = profile
    await main.webContents.executeJavaScript('window.fixtureEvents=[];window.fixtureUnsubscribe=window.electronAPI.connectedAgent.onEvent(value=>window.fixtureEvents.push(value));true')
    const navigationDownload = await approveResearchDownload('native_research_hold_navigation', true)
    await until(() => stalledDownloads.get('native_research_hold_navigation.gguf')?.reading)
    assert.equal(stalledDownloads.get('native_research_hold_navigation.gguf').signal.aborted, false, 'A normally finished provider turn detaches rather than cancelling its approved download')
    const navigationFullToken = await enableFullAccess()
    await main.webContents.executeJavaScript(`void window.electronAPI.connectedAgent.send(${JSON.stringify(fullAccessPayload('hold_navigation', navigationFullToken))});true`)
    await until(() => held.has('hold_navigation'))
    await main.loadURL(origin + '/next')
    await until(() => held.get('hold_navigation').aborted)
    assert.ok(aborted.some(item => item.requestId === 'hold_navigation' && item.reason === 'navigation'))
    await until(() => navigationDownload.manager.status({ jobId: navigationDownload.job.jobId }, { owner: navigationDownload.owner }).state === 'cancelled')
    assert.equal(stalledDownloads.get('native_research_hold_navigation.gguf').returned, true)
    assert.deepEqual(fs.readdirSync(syntheticModels), ['native_research_approved.gguf'])
    assert.equal((await invoke(main, 'send', fullAccessPayload('full_after_navigation', navigationFullToken))).code, 'UNAUTHORIZED')
    assert.equal((await invoke(main, 'send', payload('native_after_navigation'))).success, true)
    await main.webContents.executeJavaScript('window.fixtureEvents=[];window.fixtureUnsubscribe=window.electronAPI.connectedAgent.onEvent(value=>window.fixtureEvents.push(value));true')
    const shutdownDownload = await approveResearchDownload('native_research_hold_shutdown', true)
    await until(() => stalledDownloads.get('native_research_hold_shutdown.gguf')?.reading)
    const shutdownFullToken = await enableFullAccess()
    await main.webContents.executeJavaScript(`window.disposeResult=null;void window.electronAPI.connectedAgent.send(${JSON.stringify(fullAccessPayload('hold_dispose', shutdownFullToken))}).then(value=>window.disposeResult=value);true`)
    await until(() => held.has('hold_dispose'))
    controller.dispose()
    await until(async () => Boolean(await main.webContents.executeJavaScript('window.disposeResult')))
    assert.equal((await main.webContents.executeJavaScript('window.disposeResult')).code, 'CANCELLED')
    assert.ok(aborted.some(item => item.requestId === 'hold_dispose' && item.reason === 'shutdown'))
    await until(() => shutdownDownload.manager.status({ jobId: shutdownDownload.job.jobId }, { owner: shutdownDownload.owner }).state === 'cancelled')
    assert.equal(stalledDownloads.get('native_research_hold_shutdown.gguf').returned, true)
    assert.deepEqual(fs.readdirSync(syntheticModels), ['native_research_approved.gguf'])
    assert.ok(!(await main.webContents.executeJavaScript('JSON.stringify(window.fixtureEvents)')).includes('LATE_ABORTED_FULL'))
    pass('Main-frame navigation and controller shutdown abort in-flight work and cleanly release ownership')
    assert.equal(researchDisposals.length, 2)
    pass('Navigation and shutdown dispose normally detached research jobs, close stalled streams and remove only their partials; the completed synthetic model is retained')
    assert.ok(fullAccessCalls.some(call => call.requestId === 'hold_navigation'))
    assert.ok(fullAccessCalls.some(call => call.requestId === 'hold_dispose'))
    assert.equal(fullAccessDecisions.length, 2, 'Only explicit fixture Approve and Deny decisions reached the fake full backend')
    toolGuard.context.projectKey = originalProjectKey
    pass('Full-access navigation revokes its token and shutdown aborts its fake backend, with no late events, actual commands, provider calls or external downloads')
    // The earlier controller is fully disposed. Re-register only to exercise
    // shutdown during a picker, which intentionally cannot overlap a response.
    const forbiddenProvider = async () => { throw new Error('Executable shutdown fixture must not run a provider') }
    controller = registerConnectedAgentIpc({ ipcMain, app, getMainWindow: () => main, executableAccess,
      codex: { inspect: forbiddenProvider, send: forbiddenProvider }, fetchImpl: forbiddenProvider })
    assert.equal((await invoke(main, 'send', fullAccessPayload('full_after_controller_restart', shutdownFullToken,
      { preferredAccessMode: 'full', shareImagesAndView: true }))).code, 'UNAUTHORIZED')
    pass('A fresh native controller does not restore a previous token or grant authority from remembered access/image preferences')
    const shutdownPicker = await startPicker(), savesBeforeShutdown = executableSaves.length
    controller.dispose()
    await until(async () => Boolean(await main.webContents.executeJavaScript('window.executablePickResult')))
    assert.equal((await main.webContents.executeJavaScript('window.executablePickResult')).code, 'CANCELLED')
    assert.equal(shutdownPicker.signal.aborted, true)
    assert.equal(shutdownPicker.signal.reason, 'shutdown')
    assert.equal(await shutdownPicker.isCurrent(), false)
    pickerMode = 'select'; shutdownPicker.release()
    await until(() => shutdownPicker.finished)
    assert.equal(executableSaves.length, savesBeforeShutdown, 'A picker finishing after controller shutdown cannot save settings')
    pass('Native controller shutdown cancels a pending picker and refuses its late settings result')
    assert.deepEqual(blockedRequests, [])
    assert.equal(everShown, false)
    clearTimeout(deadline)
    await finish(true)
  } catch (error) { clearTimeout(deadline); await finish(false, error) }
}

if (process.versions.electron) void runElectron()
else launch().catch(error => { console.error(error); process.exitCode = 1 })
