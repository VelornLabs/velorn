import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { registerGenerationSpendingIpc, CHANNELS, STATUS_SETTING_KEY } = require('../electron/generationSpending.cjs')
const { GENERATION_LOCAL_TRUST_SETTING_KEY } = require('../electron/generationLocalWorkflowTrust.cjs')
const mainSource = fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8')
const rendererSource = fs.readFileSync(new URL('../src/services/generationSpending.js', import.meta.url), 'utf8')
const comfySource = fs.readFileSync(new URL('../src/services/comfyui.js', import.meta.url), 'utf8')
const generateSource = fs.readFileSync(new URL('../src/components/GenerateWorkspace.jsx', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)) }
  assert.fail('Synthetic integration did not reach its expected pending state')
}
function sourceRange(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `Actual source boundary missing: ${from}`)
  return source.slice(start, end)
}
const queueMethod = sourceRange(comfySource, '  async queuePrompt(workflow, { priced = false, batchCount = 0 } = {}) {', '\n  /**\n   * Resolve optional Comfy account API key')
const settingsHandlers = sourceRange(mainSource, "ipcMain.handle('settings:set',", '// NVIDIA RTX Video Super Resolution')
const settingsWriter = sourceRange(mainSource, 'async function writeSettingsRaw(mutator, beforeCommit, onCommitted) {', '\nasync function refreshSettingsDependentCaches()')
const catchMarker = "    } catch (err) {\n      const msg = err?.message || 'Generation failed'"
const generationCatch = sourceRange(generateSource, catchMarker, '    } finally {\n      await finalizeStoryboardPdfBatchForJob')
  .slice('    } catch (err) {'.length)
const workflow = () => ({ '1': { class_type: 'KSampler', inputs: { seed: 17 } } })
const paidWorkflow = () => ({ '1': { class_type: 'OpenAIGPTImage1', inputs: { model: 'gpt-image-2', prompt: 'Synthetic only' } } })

// Run the real helper and actual queuePrompt method in one renderer-shaped VM.
// React, Electron, user settings, raw HTTP and account-key access are absent.
function rendererHarness({ response = { success: true, ok: true, status: 200, body: { prompt_id: 'synthetic-prompt' } }, missingApi = false,
  queueError = null, resolvedWorkflow } = {}) {
  const calls = { queued: [], resolved: [], remembered: [], notices: [], fetch: 0, keys: 0 }
  let sequence = 0
  const forbiddenKey = () => { calls.keys++; throw new Error('Renderer must not request account credentials') }
  const api = { queue: async payload => { calls.queued.push(payload); if (queueError) throw queueError; return response } }
  const context = vm.createContext({
    crypto: { randomUUID: () => `synthetic-uuid-${++sequence}` },
    window: { electronAPI: { generationSpending: missingApi ? undefined : api, getSetting: forbiddenKey } },
    fetch: () => { calls.fetch++; throw new Error('Raw generation fetch is forbidden') },
    getComfyPartnerApiKey: forbiddenKey,
    console: { error() {}, warn() {} },
    isInsufficientCreditsError: value => value?.status === 402 || /insufficient credits/i.test(value?.message || ''),
    notifyComfyPartnerCreditsLow: value => calls.notices.push(value),
  })
  const helperSource = rendererSource.replace('export async function submitManagedGeneration', 'async function submitManagedGeneration')
  const actual = vm.runInContext(`${helperSource}\n({ submitManagedGeneration, queuePrompt: ({${queueMethod}\n}).queuePrompt })`, context)
  const client = {
    clientId: 'synthetic-client', getHttpBase: () => 'http://127.0.0.1:8188',
    resolveSubfolderModelPaths: async graph => { calls.resolved.push(graph); return resolvedWorkflow || graph },
    getComfyOrgApiKey: forbiddenKey,
    _rememberPromptNodeMeta: (...args) => calls.remembered.push(args),
  }
  return { calls, helper: actual.submitManagedGeneration, queue: graph => actual.queuePrompt.call(client, graph) }
}

test('actual queuePrompt resolves the graph then submits once through native API without fetching or reading keys', async () => {
  const original = workflow(), resolved = { '1': { class_type: 'KSampler', inputs: { seed: 18 } } }
  const f = rendererHarness({ resolvedWorkflow: resolved })
  assert.equal(await f.queue(original), 'synthetic-prompt')
  assert.deepEqual(plain(f.calls.queued), [{ requestId: 'synthetic-uuid-1', workflow: resolved,
    endpoint: 'http://127.0.0.1:8188', clientId: 'synthetic-client' }])
  assert.deepEqual(f.calls.resolved, [original])
  assert.deepEqual(f.calls.remembered, [['synthetic-prompt', original]])
  assert.equal(f.calls.fetch, 0); assert.equal(f.calls.keys, 0)
})

test('missing native bridge and native failures never trigger a direct-fetch or credential fallback', async () => {
  for (const options of [{ missingApi: true }, { queueError: new Error('Synthetic IPC unavailable: sk-private-secret /private/project') }]) {
    const f = rendererHarness(options)
    await assert.rejects(f.queue(workflow()), error => {
      assert.equal(error.code, options.missingApi ? 'GENERATION_SPENDING_UNAVAILABLE' : 'GENERATION_SPENDING_UNCERTAIN')
      if (!options.missingApi) {
        assert.equal(error.submissionState, 'unknown'); assert.equal(error.retryAllowed, false)
        assert.equal(error.generationSubmitted, undefined)
        assert.match(error.message, /Inspect ComfyUI queue\/history/)
        assert.doesNotMatch(error.message, /sk-private|private\/project|Synthetic IPC/)
      }
      return true
    })
    assert.equal(f.calls.queued.length, options.missingApi ? 0 : 1)
    assert.equal(f.calls.fetch, 0); assert.equal(f.calls.keys, 0)
    assert.deepEqual(f.calls.remembered, [])
  }
})

test('native refusal is surfaced once with not-started evidence and cannot be retried silently', async () => {
  for (const code of ['GENERATION_SPENDING_DENIED', 'GENERATION_SPENDING_LOCAL_ONLY', 'GENERATION_SPENDING_CANCELLED']) {
    const f = rendererHarness({ response: { success: false, code, error: 'Synthetic native refusal', submissionState: 'not-started' } })
    await assert.rejects(f.queue(paidWorkflow()), error => {
      assert.equal(error.code, code); assert.equal(error.generationSubmitted, false)
      assert.equal(error.submissionState, 'not-started'); return true
    })
    assert.equal(f.calls.queued.length, 1)
    assert.equal(f.calls.fetch, 0); assert.equal(f.calls.keys, 0)
    assert.deepEqual(f.calls.notices, [])
    assert.deepEqual(f.calls.remembered, [])
  }
})

test('uncertain submission never claims not-started or retries', async () => {
  const f = rendererHarness({ response: { success: false, code: 'GENERATION_SPENDING_SUBMISSION_UNCERTAIN',
    error: 'Inspect history before retrying.', submissionState: 'unknown', retryAllowed: false } })
  await assert.rejects(f.queue(workflow()), error => {
    assert.equal(error.code, 'GENERATION_SPENDING_SUBMISSION_UNCERTAIN')
    assert.equal(error.submissionState, 'unknown'); assert.equal(error.generationSubmitted, undefined); return true
  })
  assert.equal(f.calls.queued.length, 1)
  assert.equal(f.calls.fetch, 0); assert.equal(f.calls.keys, 0)
})

test('real queuePrompt preserves structured HTTP validation details and credit-exhaustion handling', async () => {
  const body = { error: { message: 'Prompt outputs failed validation', details: 'Synthetic top detail' },
    node_errors: { '1': { class_type: 'KSampler', errors: [{ type: 'value_not_in_list', message: 'Missing model', details: 'Synthetic weight' }] } } }
  const invalid = rendererHarness({ response: { success: true, ok: false, status: 400, body } })
  await assert.rejects(invalid.queue(workflow()), error => {
    assert.equal(error.status, 400); assert.deepEqual(error.rawBody, body)
    assert.deepEqual(error.nodeErrors, body.node_errors)
    assert.match(error.message, /Node 1 \(KSampler\).*value_not_in_list.*Missing model.*Synthetic weight/)
    assert.equal(error.insufficientCredits, false); return true
  })
  assert.equal(invalid.calls.queued.length, 1); assert.equal(invalid.calls.notices.length, 0)
  const credit = rendererHarness({ response: { success: true, ok: false, status: 402, body: 'Insufficient credits (synthetic)' } })
  await assert.rejects(credit.queue(paidWorkflow()), error => {
    assert.equal(error.status, 402); assert.equal(error.insufficientCredits, true)
    assert.equal(error.rawBody, 'Insufficient credits (synthetic)'); return true
  })
  assert.equal(credit.calls.notices.length, 1)
  assert.equal(credit.calls.queued.length, 1)
  assert.equal(credit.calls.fetch, 0); assert.equal(credit.calls.keys, 0)
})

test('malformed native successes are rejected before remembering a prompt or taking a fallback path', async () => {
  for (const response of [
    { success: true, ok: true, status: '200', body: { prompt_id: 'x' } },
    { success: true, ok: 'true', status: 200, body: { prompt_id: 'x' } },
    { success: true, ok: true, status: 200, body: {} },
    { success: true, ok: true, status: 200, body: 'not a confirmed response' },
    { success: true, ok: true, status: 200, body: { prompt_id: '' } },
    { success: true, ok: true, status: 200, body: { prompt_id: 'x'.repeat(257) } },
  ]) {
    const f = rendererHarness({ response })
    await assert.rejects(f.queue(workflow()), error => {
      assert.equal(error.code, 'GENERATION_SPENDING_UNCERTAIN')
      assert.equal(error.submissionState, 'unknown'); assert.equal(error.retryAllowed, false)
      assert.equal(error.generationSubmitted, undefined); return true
    })
    assert.equal(f.calls.queued.length, 1); assert.deepEqual(f.calls.remembered, [])
    assert.equal(f.calls.fetch, 0); assert.equal(f.calls.keys, 0)
  }
})

test('renderer helper preserves JSON and text HTTP body access without adding approval or credential fields', async () => {
  const f = rendererHarness()
  const calls = []
  const body = { error: { message: 'Synthetic validation' } }
  const response = await f.helper({ workflow: workflow(), endpoint: 'http://127.0.0.1:8188', clientId: 'test' }, {
    queue: async value => { calls.push(value); return { success: true, ok: false, status: 400, body } },
  })
  assert.equal(response.ok, false); assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), body)
  assert.equal(await response.text(), JSON.stringify(body))
  assert.deepEqual(Object.keys(calls[0]).sort(), ['clientId', 'endpoint', 'requestId', 'workflow'])
})

function generationCatchHarness() {
  const initial = [
    { id: 'current', status: 'queuing', progress: 40 }, { id: 'next', status: 'queued', progress: 0 },
    { id: 'already-paused', status: 'paused', progress: 12 }, { id: 'done', status: 'done', progress: 100 },
    { id: 'running', status: 'running', progress: 67 }, { id: 'old-error', status: 'error', error: 'Previous failure' },
  ]
  let queue = initial
  const queuePausedRef = { current: false }, logs = [], updates = []
  const handle = vm.runInNewContext(`(err, job) => {${generationCatch}\n}`, {
    queuePausedRef,
    setGenerationQueue: update => { queue = update(queue) },
    addComfyLog: (...args) => logs.push(args),
    updateJob: (id, patch) => { updates.push({ id, patch }); queue = queue.map(item => item.id === id ? { ...item, ...patch } : item) },
  })
  return { initial, handle: error => handle(error, { id: 'current' }), queuePausedRef, logs, updates, get queue() { return queue } }
}

test('actual Generate catch pauses only queued siblings for spending errors and keeps the failed job as an error', () => {
  for (const code of ['GENERATION_SPENDING_DENIED', 'GENERATION_SPENDING_LOCAL_ONLY', 'GENERATION_SPENDING_CANCELLED',
    'GENERATION_SPENDING_SUBMISSION_UNCERTAIN', 'GENERATION_SPENDING_UNAVAILABLE']) {
    const f = generationCatchHarness()
    f.handle(Object.assign(new Error('Synthetic spending refusal'), { code }))
    assert.equal(f.queuePausedRef.current, true)
    assert.deepEqual(f.queue.map(item => item.status), ['error', 'paused', 'paused', 'done', 'running', 'error'])
    assert.equal(f.queue[0].error, 'Synthetic spending refusal'); assert.equal(f.queue[0].progress, 0)
    for (let i = 2; i < f.initial.length; i++) assert.equal(f.queue[i], f.initial[i], `Existing ${f.initial[i].status} job must stay untouched`)
    assert.deepEqual(plain(f.updates), [{ id: 'current', patch: { status: 'error', error: 'Synthetic spending refusal', progress: 0 } }])
    assert.equal(f.logs.filter(([level]) => level === 'warning').length, 1)
    assert.match(f.logs.find(([level]) => level === 'warning')[1], /queue paused.*inspect ComfyUI history/i)
  }
})

test('actual Generate catch preserves ordinary-error behavior without applying a spending pause', () => {
  for (const error of [new Error('Synthetic ordinary failure'), Object.assign(new Error('Synthetic dependency failure'), { code: 'WORKFLOW_DEPENDENCIES_MISSING' }), null]) {
    const f = generationCatchHarness()
    f.handle(error)
    assert.equal(f.queuePausedRef.current, false)
    assert.deepEqual(f.queue.map(item => item.status), ['error', 'queued', 'paused', 'done', 'running', 'error'])
    assert.equal(f.queue[0].error, error?.message || 'Generation failed')
    assert.equal(f.queue[0].progress, 0)
    for (let i = 1; i < f.initial.length; i++) assert.equal(f.queue[i], f.initial[i])
    assert.equal(f.logs.filter(([level]) => level === 'warning').length, 0)
  }
})

test('actual generic settings handlers cannot set or delete native-owned spending policy', async () => {
  const handlers = new Map(); let settings = { [STATUS_SETTING_KEY]: 'local-only' }, writes = 0, refreshes = 0
  vm.runInNewContext(settingsHandlers, {
    GENERATION_SPENDING_SETTING_KEY: STATUS_SETTING_KEY,
    GENERATION_LOCAL_TRUST_SETTING_KEY,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    writeSettingsRaw: async update => { writes++; settings = update(settings) },
    refreshSettingsDependentCaches: async () => { refreshes++ },
  })
  for (const channel of ['settings:set', 'settings:delete']) {
    const result = await handlers.get(channel)({}, STATUS_SETTING_KEY, 'ask-cloud')
    assert.equal(result.success, false); assert.match(result.error, /Generation spending/)
    assert.equal(settings[STATUS_SETTING_KEY], 'local-only')
    assert.equal(writes, 0); assert.equal(refreshes, 0)
    const trust = await handlers.get(channel)({}, GENERATION_LOCAL_TRUST_SETTING_KEY, { version: 1, entries: [] })
    assert.equal(trust.success, false); assert.match(trust.error, /Generation spending/)
    assert.equal(writes, 0)
  }
  assert.equal((await handlers.get('settings:set')({}, 'theme', 'dark')).success, true)
  assert.equal(settings.theme, 'dark')
  assert.equal((await handlers.get('settings:delete')({}, 'theme')).success, true)
  assert.equal(settings.theme, undefined)
  assert.equal(writes, 2); assert.equal(refreshes, 2)
  assert.equal(settings[STATUS_SETTING_KEY], 'local-only')
})

function writerHarness({ initial = { comfyConnection: { port: 8188 } }, atomic, cancelPending = () => {} } = {}) {
  let state = structuredClone(initial)
  const calls = [], context = vm.createContext({
    settingsWriteQueue: Promise.resolve(), settingsPath: '/synthetic/settings.json', COMFY_CONNECTION_SETTING_KEY: 'comfyConnection',
    readSettingsRaw: async () => structuredClone(state),
    generationSpending: { cancelPending: reason => { calls.push(['cancel', reason]); return cancelPending(reason) } },
    writeFileAtomic: async (_path, serialized, encoding) => {
      const next = JSON.parse(serialized); calls.push(['write-start', next, encoding])
      if (atomic) await atomic(next)
      state = next; calls.push(['write-end', next])
    },
  })
  const write = vm.runInContext(`${settingsWriter}\nwriteSettingsRaw`, context)
  return { write, calls, get state() { return structuredClone(state) } }
}

test('central settings writer invalidates connection consent both before and after the asynchronous atomic write', async () => {
  const gate = deferred(), cancelled = []
  let pending = 'old-context-request'
  const f = writerHarness({ atomic: () => gate.promise, cancelPending: () => { cancelled.push(pending); pending = null } })
  const writing = f.write(settings => ({ ...settings, comfyConnection: { port: 8189 } }))
  await until(() => f.calls.some(call => call[0] === 'write-start'))
  assert.deepEqual(cancelled, ['old-context-request'])
  assert.equal(f.state.comfyConnection.port, 8188)
  pending = 'new-request-started-while-write-inflight'
  gate.resolve(); await writing
  assert.deepEqual(cancelled, ['old-context-request', 'new-request-started-while-write-inflight'])
  assert.equal(f.state.comfyConnection.port, 8189)
  assert.deepEqual(f.calls.map(call => call[0]), ['cancel', 'write-start', 'write-end', 'cancel'])
})

test('failed connection writes still invalidate inflight consent and do not break future settings writes', async () => {
  const gate = deferred(); let fail = true
  const f = writerHarness({ atomic: async () => { if (fail) await gate.promise } })
  const writing = f.write(settings => ({ ...settings, comfyConnection: 8189 }))
  await until(() => f.calls.some(call => call[0] === 'write-start'))
  gate.reject(new Error('Synthetic atomic failure'))
  await assert.rejects(writing, /atomic failure/)
  assert.equal(f.calls.filter(call => call[0] === 'cancel').length, 2)
  assert.deepEqual(f.state, { comfyConnection: { port: 8188 } })
  fail = false
  await f.write(settings => ({ ...settings, theme: 'dark' }))
  assert.equal(f.state.theme, 'dark')
  assert.equal(f.calls.filter(call => call[0] === 'cancel').length, 2)
})

test('unchanged connection values and unrelated settings writes do not cancel generation', async () => {
  const f = writerHarness()
  await f.write(settings => ({ ...settings, theme: 'dark', comfyConnection: { port: 8188 } }))
  await f.write(settings => ({ ...settings, [STATUS_SETTING_KEY]: 'ask-cloud' }))
  assert.equal(f.calls.filter(call => call[0] === 'cancel').length, 0)
  assert.equal(f.state[STATUS_SETTING_KEY], 'ask-cloud')
})

test('real broker rejects both preexisting and newly inflight approvals across the central connection write', async () => {
  const writeGate = deferred(), firstConsent = deferred(), secondConsent = deferred()
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send() {} })
  const window = { webContents: contents, isDestroyed: () => false }, handlers = new Map(), posts = []
  let controller, confirmations = 0, keyReads = 0, session = 'synthetic-session'
  const writer = writerHarness({ atomic: () => writeGate.promise, cancelPending: reason => controller.cancelPending(reason) })
  controller = registerGenerationSpendingIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    getMainWindow: () => window, readPolicy: () => 'ask-cloud', writePolicy: () => assert.fail('Policy must not change'),
    getEndpoint: () => `http://127.0.0.1:${writer.state.comfyConnection.port}`,
    getContext: () => ({ session, projectKey: 'synthetic-project', timelineId: 'synthetic-timeline' }),
    getApiKey: () => { keyReads++; return 'synthetic-key' }, assertAvailable() {},
    confirmSpend: () => ++confirmations === 1 ? firstConsent.promise : secondConsent.promise,
    fetchImpl: async (url, options) => {
      if (options.method === 'POST') posts.push(url)
      return new Response(JSON.stringify(options.method === 'POST' ? { prompt_id: 'synthetic' } : {}))
    },
  })
  const request = id => handlers.get(CHANNELS.queue)({ sender: contents, senderFrame: contents.mainFrame }, {
    requestId: `synthetic-connection-${id}`, endpoint: 'http://127.0.0.1:8188', clientId: 'synthetic', workflow: paidWorkflow(),
  })
  try {
    const first = request('first')
    await until(() => confirmations === 1)
    const writing = writer.write(settings => ({ ...settings, comfyConnection: { port: 8189 } }))
    await until(() => writer.calls.some(call => call[0] === 'write-start'))
    firstConsent.resolve(true)
    assert.equal((await first).code, 'GENERATION_SPENDING_CANCELLED')
    session = 'changed-editor-context'
    const second = request('second')
    await until(() => confirmations === 2)
    writeGate.resolve(); await writing
    secondConsent.resolve(true)
    assert.equal((await second).code, 'GENERATION_SPENDING_CANCELLED')
    assert.equal(keyReads, 0); assert.deepEqual(posts, [])
  } finally { controller.dispose() }
})

function mcpHarness(getGenerationSpendingStatus) {
  let mutations = 0
  const server = createComfyStudioMcpServer({ getGenerationSpendingStatus,
    performAction: async () => { mutations++; throw new Error('Read-only status must not dispatch an authored action') } })
  server.updateSnapshot({ project: { id: 'synthetic-project', name: 'Synthetic' }, assets: [
    { id: 'active', name: 'Active synthetic image', type: 'image', generationStatus: 'queued', workflowId: 'test' },
    { id: 'failed', name: 'Failed synthetic image', type: 'image', generationStatus: 'failed', error: 'Synthetic failure' },
  ], timelines: [], currentTimeline: null })
  return { server, get mutations() { return mutations } }
}

test('MCP generation status adds only native read-only policy status and cannot mutate or approve through arguments', async () => {
  let policy = 'local-only', reads = 0
  const f = mcpHarness(async () => { reads++; return { success: true, policy, scope: 'velorn-managed', privateKey: 'must-not-appear', busy: false } })
  const before = JSON.stringify(f.server.lastSnapshot)
  for (const current of ['local-only', 'ask-cloud']) {
    policy = current
    const result = await f.server.callTool('get_generation_status', { policy: 'allow-all', approved: true, previewOnly: false })
    assert.equal(result.isError, undefined)
    const body = JSON.parse(result.content[0].text)
    assert.equal(body.activeCount, 1); assert.equal(body.failedCount, 1)
    assert.equal(body.generationSpending.available, true)
    assert.equal(body.generationSpending.policy, current)
    assert.equal(body.generationSpending.coversDirectComputerActions, false)
    assert.match(body.generationSpending.note, /separate native human consent/)
    assert.equal(body.generationSpending.approvalTrigger, current === 'ask-cloud' ? 'managed-submit' : null)
    if (current === 'ask-cloud') {
      assert.match(body.generationSpending.note, /previewOnly:false/)
      assert.match(body.generationSpending.note, /status checks and previews cannot open it/)
      assert.match(body.generationSpending.note, /not a workflow assessment or a denial/)
    }
    assert.doesNotMatch(JSON.stringify(body), /must-not-appear|allow-all/)
  }
  assert.equal(reads, 2); assert.equal(f.mutations, 0)
  assert.equal(JSON.stringify(f.server.lastSnapshot), before)
  const definition = f.server.tools.find(tool => tool.name === 'get_generation_status')
  assert.deepEqual(definition.inputSchema.properties, {})
  assert.match(definition.description, /read-only tool cannot change policy or grant spending permission/)
})

test('MCP missing, failed or malformed native status explicitly reports unavailable, never permission to spend', async () => {
  for (const callback of [undefined, async () => { throw new Error('private-native-error') },
    async () => ({ success: false, policy: 'ask-cloud', scope: 'velorn-managed' }),
    async () => ({ success: true, policy: 'allow-all', scope: 'velorn-managed' }),
    async () => ({ success: true, policy: 'ask-cloud', scope: 'renderer-claimed' }),
  ]) {
    const f = mcpHarness(callback)
    const result = await f.server.callTool('get_generation_status', {})
    const body = JSON.parse(result.content[0].text)
    assert.equal(body.generationSpending.available, false)
    assert.equal(body.generationSpending.policy, 'unavailable')
    assert.match(body.generationSpending.note, /do not bypass/)
    assert.doesNotMatch(JSON.stringify(body), /private-native-error/)
    assert.equal(f.mutations, 0)
  }
})
