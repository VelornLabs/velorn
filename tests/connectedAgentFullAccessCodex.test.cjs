'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { createMcpGateway } = require('../electron/connectedAgentMcpGateway.cjs')
const { PROJECT_CONVERSATION_GUIDANCE, withProjectConversationGuidance } = require('../electron/connectedAgentProjectGuidance.cjs')
const { codexPromptWasNotSent } = require('../electron/connectedAgentCodexAuth.cjs')
const { sendFullAccessCodex, fullAccessConfig, fullAccessArgs, verifyConfiguration, buildInput,
  isolateMergedConfiguration, terminateOwnedProcess, redactActivityText, DISABLED_FEATURES, ENABLED_FEATURES } = require('../electron/connectedAgentFullAccessCodex.cjs')

const request = overrides => ({ workingDirectory: os.tmpdir(), model: 'sample-exact-model',
  context: '{"shots":[]}', messages: [{ role: 'user', content: 'Inspect the requested file.' }], images: [], ...overrides })
const clone = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
function fakeServer(options = {}) {
  const calls = []; const processSignals = []; const taskkill = []
  const spawnImpl = (executable, args, spawnOptions) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: 123456789, exitCode: null, signalCode: null })
    const entry = { executable, args, options: spawnOptions, child, messages: [], responses: [], initialized: false,
      effort: JSON.parse(args.find(value => value.startsWith('model_reasoning_effort=')).split('=')[1]) }
    calls.push(entry)
    entry.close = (code = 0) => { if (child.exitCode !== null) return; child.exitCode = code; child.emit('close', code) }
    child.kill = signal => { processSignals.push(['child', signal]); if (!options.neverCloses) queueMicrotask(() => entry.close(143)); return true }
    entry.send = value => child.stdout.write(JSON.stringify(value) + '\n')
    entry.event = (method, params = {}) => entry.send({ method, params: { threadId: 'thread-1', turnId: 'turn-1', ...params } })
    entry.complete = text => {
      entry.event('item/completed', { item: { type: 'agentMessage', id: 'answer-1', text: text ?? 'Finished the requested inspection.' } })
      entry.event('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } })
    }
    let buffer = ''
    child.stdin.on('data', chunk => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1)
        entry.messages.push(message)
        if (!message.method) { entry.responses.push(message); options.onResponse?.(message, entry); continue }
        if (message.method === 'initialized') { entry.initialized = true; continue }
        queueMicrotask(() => {
          if (options.hangMethod === message.method) return
          let result
          switch (message.method) {
            case 'initialize': result = { userAgent: 'synthetic-codex' }; break
            case 'account/read': result = { account: options.signedOut ? null : { type: options.accountType || 'chatgpt', email: 'private@example.test' }, requiresOpenaiAuth: true }; break
            case 'config/read': result = { config: options.configTransform ? options.configTransform(clone(fullAccessConfig(options.gateway, entry.effort)), entry, calls.length) : fullAccessConfig(options.gateway, entry.effort) }; break
            case 'thread/start':
            case 'thread/resume': {
              result = { thread: { id: message.method === 'thread/resume' ? message.params.threadId : 'thread-1',
                ...(message.method === 'thread/resume' ? { environments: [{ environmentId: 'local', cwd: message.params.cwd, runtimeWorkspaceRoots: [message.params.cwd] }] } : {}) }, sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never',
                approvalsReviewer: 'user', modelProvider: 'openai', model: message.params.model || 'default-model',
                cwd: message.params.cwd, instructionSources: [], reasoningEffort: message.params.config.model_reasoning_effort }
              if (options.threadTransform) result = options.threadTransform(result)
              if (message.method === 'thread/resume' && options.resumeTransform) result = options.resumeTransform(result)
              break
            }
            case 'turn/start': result = { turn: { id: 'turn-1' } }; break
            case 'turn/interrupt': result = {}; break
            default: throw new Error(`Unexpected client request: ${message.method}`)
          }
          if (options.errorMethod === message.method) entry.send({ id: message.id, error: { code: options.errorCode ?? -32602, message: 'Private provider diagnostics API key secret' } })
          else entry.send({ id: message.id, result })
          if (message.method === 'turn/start' && options.errorMethod !== message.method) {
            if (options.onTurn) options.onTurn(entry, message)
            else entry.complete()
          }
        })
      }
    })
    if (options.spawnError) queueMicrotask(() => child.emit('error', Object.assign(new Error('private spawn error'), { code: options.spawnError })))
    return child
  }
  const processKillImpl = (pid, signal) => {
    processSignals.push([pid, signal])
    if (!options.neverCloses) queueMicrotask(() => calls.at(-1).close(143))
  }
  const execFileImpl = (file, args, execOptions, done) => { taskkill.push({ file, args, options: execOptions }); queueMicrotask(() => { calls.at(-1)?.close(143); done?.(null, '', '') }) }
  return { calls, processSignals, taskkill, spawnImpl, processKillImpl, execFileImpl,
    dependencies: { spawnImpl, processKillImpl, execFileImpl, limits: { rpcMs: 1000, interruptMs: 1, terminateMs: 5, approvalMs: 1000 } } }
}

test('full Codex rechecks phone sharing after configuration and after thread setup without sending a turn', async () => {
  const { sharingFailure, sharingPromptWasNotSent } = require('../electron/mobileAISharing.cjs')
  for (const rejectAt of [1, 2]) {
    const mock = fakeServer(); let checks = 0
    await assert.rejects(sendFullAccessCodex(request(), { ...mock.dependencies,
      assertBeforeSend() { if (++checks === rejectAt) throw sharingFailure() } }), error => sharingPromptWasNotSent(error))
    const methods = mock.calls.flatMap(call => call.messages.map(message => message.method))
    assert.ok(methods.includes('config/read'))
    assert.equal(methods.includes('thread/start'), rejectAt === 2)
    assert.equal(methods.includes('turn/start'), false)
  }
})

test('image generation events deliver once, wait for import before final, and never expose base64', async () => {
  const events = [], delivered = []
  const image = { type: 'imageGeneration', id: 'image-1', status: 'completed', result: 'private-base64', savedPath: '/native/generated.png' }
  const mock = fakeServer({ onTurn(entry) {
    entry.event('item/started', { item: { ...image, status: 'inProgress', result: '' } })
    entry.event('item/completed', { item: image })
    entry.event('item/completed', { item: image })
    entry.event('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [image] } })
  } })
  const response = await sendFullAccessCodex(request(), { ...mock.dependencies, onEvent: event => events.push(event),
    onGeneratedImage: async item => { await tick(); delivered.push(item.id); return { assetId: 'asset-one', saved: true } } })
  assert.deepEqual(delivered, ['image-1']); assert.equal(response.success, true)
  assert.match(response.text, /imported into project assets \(asset-one\)/)
  assert.doesNotMatch(JSON.stringify(events), /private-base64|\/native\/generated/)
  assert.equal(events.filter(event => event.type === 'delta').length, 1)
})

test('image usage failure and failed import are reported without generation or import retries', async () => {
  for (const failed of [true, false]) {
    let imports = 0
    const mock = fakeServer({ onTurn(entry) {
      entry.event('item/completed', { item: { type: 'imageGeneration', id: 'image-1', status: failed ? 'failed' : 'completed', result: '',
        ...(failed ? { failure: { type: 'usageLimitExceeded', limitId: 'images' } } : {}) } })
      entry.complete('Image request finished.')
    } })
    const response = await sendFullAccessCodex(request(), { ...mock.dependencies,
      onGeneratedImage: async () => { imports++; throw Error('Import failed; recovery original retained.') } })
    assert.equal(imports, failed ? 0 : 1)
    assert.match(response.text, failed ? /did not complete/ : /recovery original retained/)
  }
})

test('cancellation while an image is being delivered does not emit a late final reply', async () => {
  let started, release
  const ready = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const controller = new AbortController(), events = []
  const mock = fakeServer({ onTurn(entry) {
    entry.event('item/completed', { item: { type: 'imageGeneration', id: 'image-1', status: 'completed', result: '' } })
    entry.complete()
  } })
  const operation = sendFullAccessCodex(request(), { ...mock.dependencies, signal: controller.signal, onEvent: event => events.push(event),
    onGeneratedImage: async (item, { signal }) => { started(); await gate; assert.equal(signal.aborted, true); throw Error('Cancelled') } })
  await ready; controller.abort(); release()
  await assert.rejects(operation, { code: 'CANCELLED' })
  assert.equal(events.filter(event => event.type === 'delta').length, 0)
})

test('actual full-access thread receives shared project cues once without replacing its verified permission configuration', async () => {
  for (const instructions of [undefined, withProjectConversationGuidance('Keep the approved song and edit.')]) {
    const mock = fakeServer()
    await sendFullAccessCodex(request({ messages: [{ role: 'user', content: 'Let us talk through this commercial.' }] }), { ...mock.dependencies, instructions })
    const started = mock.calls[0].messages.find(message => message.method === 'thread/start').params
    assert.equal(started.developerInstructions.split(PROJECT_CONVERSATION_GUIDANCE).length - 1, 1)
    assert.match(started.developerInstructions, /Full computer access was explicitly enabled/)
    assert.equal(started.sandbox, 'danger-full-access'); assert.equal(started.approvalPolicy, 'never')
    assert.equal(started.model, 'sample-exact-model')
    assert.match(started.developerInstructions, /Follow the current access mode: use its approval or preview process only when required/)
    assert.match(started.developerInstructions, /requested tool actions run directly without routine approval cards, mandatory previews, checkpoints, or previous-context tokens/)
    assert.match(started.developerInstructions, /normal editor Undo remains available/)
    assert.match(started.developerInstructions, /host prepares any execution records required by native tools internally/)
    assert.doesNotMatch(started.developerInstructions, /preview when supported|preserve Undo\/checkpoints|and preview queue_comfyui_workflow|import_comfyui_workflow preview\/apply|native permission, preview, Undo\/checkpoint/)
  }
})

test('full-access config enables native tools but explicitly disables inherited integrations and billing overrides', () => {
  const config = fullAccessConfig()
  assert.equal(config.approval_policy, 'never')
  assert.equal(config.approvals_reviewer, 'user')
  assert.equal(config.sandbox_mode, 'danger-full-access')
  assert.equal(config.web_search, 'live')
  assert.equal(config.forced_login_method, 'chatgpt')
  assert.deepEqual(config.mcp_servers, {})
  assert.deepEqual(config.model_providers, {})
  assert.deepEqual(config.hooks, {})
  assert.deepEqual(config.notify, [])
  assert.deepEqual(config.otel, { exporter: 'none', trace_exporter: 'none', metrics_exporter: 'none', log_user_prompt: false, tool_result: { max_bytes: 0 } })
  assert.equal(config.openai_base_url, undefined, 'ChatGPT auth must retain subscription routing, not the API base URL')
  assert.ok(!fullAccessArgs(config).some(value => value.startsWith('openai_base_url=')))
  assert.equal(config.project_doc_max_bytes, 0)
  for (const name of DISABLED_FEATURES) assert.equal(config.features[name], false)
  for (const name of ENABLED_FEATURES) assert.equal(config.features[name], true)
  assert.deepEqual(fullAccessArgs(config).slice(0, 3), ['app-server', '--listen', 'stdio://'])
  assert.ok(!fullAccessArgs(config).some(value => value.includes('dangerously-bypass') || value === '--sudo'))
})

test('full-access runtime uses the native-selected executable, not a user-message or payload path', async () => {
  const mock = fakeServer()
  const executablePath = path.join(os.tmpdir(), 'Trusted Codex Install', 'codex')
  const result = await sendFullAccessCodex(request({ executablePath: '/untrusted/payload' }), { ...mock.dependencies, executablePath })
  assert.equal(result.success, true)
  assert.ok(mock.calls.every(call => call.executable === executablePath && call.options.shell === false))
})

test('effective config accepts CLI inert defaults but rejects inherited executable/instruction/provider settings', () => {
  const expected = fullAccessConfig()
  const actual = clone(expected)
  actual.features.auth_elicitation = true; actual.features.mentions_v2 = true; actual.features.remote_control = false
  actual.hooks.SessionStart = []; actual.agents.max_depth = null; actual.shell_environment_policy.set = null
  actual.otel.environment = 'production'; actual.otel.service_name = 'codex'
  assert.doesNotThrow(() => verifyConfiguration(actual, expected))
  for (const mutate of [
    config => { config.features.hooks = true }, config => { config.features.new_external_tool = true },
    config => { config.hooks.SessionStart = [{ command: 'do-not-run' }] },
    config => { config.mcp_servers.other = { command: 'do-not-run' } },
    config => { config.model_providers.custom = { name: 'custom' } },
    config => { config.notify = ['do-not-run'] }, config => { config.model_instructions_file = '/private/override' },
    config => { config.model_catalog_json = '/private/catalog' }, config => { config.compact_prompt = 'inherited instructions' },
    config => { config.chatgpt_base_url = 'https://untrusted.example' },
    config => { config.openai_base_url = 'https://api.openai.com/v1' },
    config => { config.shell_environment_policy.set = { OPENAI_API_KEY: 'private' } },
    config => { config.otel.log_user_prompt = true },
    config => { config.otel.exporter = { 'otlp-http': { endpoint: 'https://private.example' } } },
    config => { config.otel.trace_exporter = 'otlp-http' }, config => { config.otel.metrics_exporter = 'statsig' },
    config => { config.otel.tool_result.max_bytes = 10000 },
  ]) {
    const config = clone(actual); mutate(config)
    assert.throws(() => verifyConfiguration(config, expected), { code: 'CODEX_CONFIGURATION_UNSAFE' })
  }
})

test('happy path authenticates and verifies permissions before sending exact-model ephemeral turn', async () => {
  const mock = fakeServer(); const events = []
  const result = await sendFullAccessCodex(request(), { ...mock.dependencies, onEvent: event => events.push(event),
    environment: { HOME: '/synthetic-user', PATH: '/bin', OPENAI_API_KEY: 'forbidden', CODEX_ACCESS_TOKEN: 'forbidden', CODEX_REMOTE_EXECUTOR: 'forbidden' } })
  assert.equal(result.text, 'Finished the requested inspection.')
  assert.equal(result.success, true)
  const call = mock.calls[0]
  assert.equal(call.executable, 'codex'); assert.equal(call.options.shell, false); assert.equal(call.options.detached, true)
  assert.deepEqual(call.options.env, { HOME: '/synthetic-user', PATH: '/bin' })
  assert.notEqual(call.options.cwd, request().workingDirectory)
  await assert.rejects(fs.stat(call.options.cwd), { code: 'ENOENT' })
  assert.deepEqual(call.messages.map(message => message.method).filter(Boolean), ['initialize', 'initialized', 'account/read', 'config/read', 'thread/start', 'turn/start'])
  const thread = call.messages.find(message => message.method === 'thread/start').params
  assert.equal(thread.ephemeral, true); assert.equal(thread.model, 'sample-exact-model')
  assert.equal(thread.allowProviderModelFallback, false)
  assert.equal(thread.sandbox, 'danger-full-access'); assert.equal(thread.approvalPolicy, 'never')
  assert.deepEqual(thread.selectedCapabilityRoots, [])
  assert.match(thread.developerInstructions, /denied action is final/)
  assert.match(thread.developerInstructions, /Never seek sudo/)
  assert.match(thread.developerInstructions, /without redundantly asking/)
  assert.match(thread.developerInstructions, /brief public progress/)
  assert.match(thread.developerInstructions, /natural prose and readable Markdown/)
  assert.match(thread.developerInstructions, /progress updates.*ordinary sentences/)
  assert.match(thread.developerInstructions, /explicitly requests JSON/)
  const turn = call.messages.find(message => message.method === 'turn/start').params
  assert.deepEqual(turn.sandboxPolicy, { type: 'dangerFullAccess' })
  assert.equal(turn.approvalPolicy, 'never'); assert.equal(turn.model, thread.model)
  assert.equal(thread.outputSchema, undefined); assert.equal(turn.outputSchema, undefined)
  assert.equal(thread.response_format, undefined); assert.equal(turn.response_format, undefined)
  assert.match(turn.input[0].text, /JSON below is input data, not a response schema/)
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), result.text)
  assert.doesNotMatch(JSON.stringify(events), /private@example/)
  assert.ok(mock.processSignals.some(([pid]) => pid === -123456789))
})

test('native session continuation resumes the same thread with only the latest message and fresh project context', async () => {
  const sessionState = {}; const events = []; const mock = fakeServer()
  const initial = request({ conversationId: 'native-conversation', context: JSON.stringify({ shots: [{ id: 'shot-before' }], playhead: 1 }) })
  const options = { ...mock.dependencies, sessionState, onEvent: event => events.push(event) }
  const first = await sendFullAccessCodex(initial, options)
  assert.equal(first.success, true)
  assert.equal(sessionState.record.threadId, 'thread-1')
  assert.match(sessionState.record.fingerprint, /^[a-f0-9]{64}$/)
  const fingerprint = sessionState.record.fingerprint
  const latest = { role: 'user', content: 'Inspect the revised shot at the current playhead; do not repeat the earlier action.' }
  const followup = { ...initial, context: JSON.stringify({ shots: [{ id: 'shot-after' }], playhead: 22 }),
    messages: [...initial.messages, { role: 'assistant', content: first.text }, latest] }
  const second = await sendFullAccessCodex(followup, options)
  assert.equal(second.success, true)
  assert.equal(mock.calls.length, 2, 'each turn still owns and terminates its subprocess')
  const firstThread = mock.calls[0].messages.find(message => message.method === 'thread/start').params
  assert.equal(firstThread.ephemeral, false)
  assert.deepEqual(mock.calls[1].messages.map(message => message.method).filter(Boolean),
    ['initialize', 'initialized', 'account/read', 'config/read', 'thread/resume', 'turn/start'])
  const resumed = mock.calls[1].messages.find(message => message.method === 'thread/resume').params
  assert.equal(resumed.threadId, 'thread-1'); assert.equal(resumed.excludeTurns, true)
  assert.equal(resumed.sandbox, 'danger-full-access'); assert.equal(resumed.approvalPolicy, 'never')
  assert.equal(resumed.model, initial.model)
  assert.deepEqual(resumed.config, firstThread.config)
  assert.equal(resumed.developerInstructions, firstThread.developerInstructions)
  for (const startOnly of ['ephemeral', 'selectedCapabilityRoots', 'environments', 'allowProviderModelFallback']) assert.equal(resumed[startOnly], undefined)
  const turn = mock.calls[1].messages.find(message => message.method === 'turn/start').params
  const text = turn.input[0].text
  const payload = JSON.parse(text.split('\n').at(-1))
  assert.deepEqual(payload.messages, [latest])
  assert.deepEqual(payload.context, JSON.parse(followup.context))
  assert.match(text, /Earlier tool history is retained but is not proof of current editor state or permission/)
  assert.match(text, /Do not re-run earlier actions/)
  assert.doesNotMatch(text, /shot-before/)
  assert.equal(sessionState.record.fingerprint, fingerprint)
  assert.deepEqual(events.filter(event => event.type === 'timing').map(event => event.continuity), ['new', 'continued'])
  assert.doesNotMatch(JSON.stringify([first, second, events]), new RegExp(fingerprint))
})

test('explicit effort overrides inherited Ultra and is sent on each turn; effort changes reset continuation', async () => {
  const mock = fakeServer(), state = {}
  for (const effort of ['medium', 'medium', 'low']) {
    await sendFullAccessCodex(request({ reasoningEffort: effort }), { ...mock, sessionState: state })
    const call = mock.calls.at(-1)
    assert.ok(call.args.includes(`model_reasoning_effort=${JSON.stringify(effort)}`))
    assert.equal(call.messages.find(item => item.method === 'turn/start').params.effort, effort)
  }
  assert.ok(mock.calls[1].messages.some(item => item.method === 'thread/resume'))
  assert.ok(mock.calls[2].messages.some(item => item.method === 'thread/start'))
  assert.ok(!mock.calls[2].messages.some(item => item.method === 'thread/resume'))
})

test('missing or substituted thinking confirmation stops before inference, including resume', async () => {
  for (const effort of [undefined, 'ultra']) {
    const mock = fakeServer({ threadTransform: value => ({ ...value, reasoningEffort: effort }) })
    await assert.rejects(sendFullAccessCodex(request({ reasoningEffort: 'medium' }), mock), { code: 'CODEX_EFFORT_MISMATCH' })
    assert.ok(!mock.calls[0].messages.some(item => item.method === 'turn/start'))
  }
  const state = {}, first = fakeServer()
  await sendFullAccessCodex(request(), { ...first, sessionState: state })
  const resumed = fakeServer({ resumeTransform: value => ({ ...value, reasoningEffort: 'ultra' }) })
  await assert.rejects(sendFullAccessCodex(request(), { ...resumed, sessionState: state }), { code: 'CODEX_EFFORT_MISMATCH' })
  assert.equal(state.record, null)
  assert.ok(!resumed.calls[0].messages.some(item => item.method === 'turn/start'))
})

test('changing the exact model starts fresh and sends visible history instead of resuming a mismatched fingerprint', async () => {
  const sessionState = {}; const mock = fakeServer(); const events = []
  const initial = request({ conversationId: 'native-conversation' })
  await sendFullAccessCodex(initial, { ...mock.dependencies, sessionState })
  const previousFingerprint = sessionState.record.fingerprint
  const next = { ...initial, model: 'different-exact-model', messages: [...initial.messages,
    { role: 'assistant', content: 'Earlier verified answer.' }, { role: 'user', content: 'Continue with this newly selected model.' }] }
  await sendFullAccessCodex(next, { ...mock.dependencies, sessionState, onEvent: event => events.push(event) })
  const call = mock.calls[1]
  assert.equal(call.messages.some(message => message.method === 'thread/resume'), false)
  const started = call.messages.find(message => message.method === 'thread/start').params
  assert.equal(started.model, next.model); assert.equal(started.ephemeral, false)
  const prompt = call.messages.find(message => message.method === 'turn/start').params.input[0].text
  assert.deepEqual(JSON.parse(prompt.split('\n').at(-1)).messages, next.messages)
  assert.doesNotMatch(prompt, /This continues the same conversation/)
  assert.notEqual(sessionState.record.fingerprint, previousFingerprint)
  assert.equal(events.find(event => event.type === 'timing').continuity, 'reset')
})

test('omitted request model pins the effective configuration model on start, resume and every turn', async () => {
  const sessionState = {}; let configuredModel = 'configured-exact-model'
  const mock = fakeServer({ configTransform: config => ({ ...config, model: configuredModel }) })
  const initial = request({ model: undefined, conversationId: 'native-default-model-conversation' })
  await sendFullAccessCodex(initial, { ...mock.dependencies, sessionState })
  const initialFingerprint = sessionState.record.fingerprint
  await sendFullAccessCodex(initial, { ...mock.dependencies, sessionState })
  assert.equal(sessionState.record.fingerprint, initialFingerprint)
  for (const [index, method] of [[0, 'thread/start'], [1, 'thread/resume']]) {
    const call = mock.calls[index]
    assert.equal(call.messages.find(message => message.method === method).params.model, configuredModel)
    assert.equal(call.messages.find(message => message.method === 'turn/start').params.model, configuredModel)
  }
  configuredModel = 'changed-configured-exact-model'
  await sendFullAccessCodex(initial, { ...mock.dependencies, sessionState })
  assert.equal(mock.calls[2].messages.some(message => message.method === 'thread/resume'), false)
  assert.equal(mock.calls[2].messages.find(message => message.method === 'thread/start').params.model, configuredModel)
  assert.equal(mock.calls[2].messages.find(message => message.method === 'turn/start').params.model, configuredModel)
  assert.notEqual(sessionState.record.fingerprint, initialFingerprint)
})

test('effective default model substitution is rejected on both start and resume before a turn', async () => {
  const configTransform = config => ({ ...config, model: 'configured-exact-model' })
  const initial = request({ model: undefined, conversationId: 'native-default-model-conversation' })
  for (const resumed of [false, true]) {
    const sessionState = {}
    if (resumed) {
      const seed = fakeServer({ configTransform })
      await sendFullAccessCodex(initial, { ...seed.dependencies, sessionState })
    }
    const transform = result => ({ ...result, model: 'unapproved-default-substitute' })
    const mock = fakeServer({ configTransform, ...(resumed ? { resumeTransform: transform } : { threadTransform: transform }) })
    await assert.rejects(sendFullAccessCodex(initial, { ...mock.dependencies, sessionState }), { code: 'CODEX_MODEL_MISMATCH' })
    assert.equal(mock.calls[0].messages.some(message => message.method === (resumed ? 'thread/resume' : 'thread/start')), true)
    assert.equal(mock.calls[0].messages.some(message => message.method === 'turn/start'), false)
    assert.equal(sessionState.record, null)
  }
})

test('an opaque default model invalidates prior continuity and keeps each new thread ephemeral', async () => {
  const sessionState = {}; const seed = fakeServer()
  const initial = request({ conversationId: 'native-default-model-conversation' })
  await sendFullAccessCodex(initial, { ...seed.dependencies, sessionState })
  assert.ok(sessionState.record)
  const mock = fakeServer()
  for (let index = 0; index < 2; index++) {
    await sendFullAccessCodex({ ...initial, model: undefined }, { ...mock.dependencies, sessionState })
    assert.equal(sessionState.record, null)
    assert.equal(mock.calls[index].messages.some(message => message.method === 'thread/resume'), false)
    const started = mock.calls[index].messages.find(message => message.method === 'thread/start').params
    assert.equal(started.ephemeral, true); assert.equal(started.model, undefined)
  }
})

test('session revocation during asynchronous configuration, start or resume prevents turns and mapping commits', async () => {
  for (const phase of ['config', 'start', 'resume']) {
    const sessionState = {}; let current = true
    const initial = request({ conversationId: 'revoked-native-conversation' })
    if (phase === 'resume') {
      const seed = fakeServer()
      await sendFullAccessCodex(initial, { ...seed.dependencies, sessionState })
    }
    const revoke = result => { current = false; return result }
    const mock = fakeServer(phase === 'config' ? { configTransform: revoke }
      : phase === 'start' ? { threadTransform: revoke } : { resumeTransform: revoke })
    await assert.rejects(sendFullAccessCodex(initial, { ...mock.dependencies, sessionState, isSessionCurrent: () => current }), { code: 'CANCELLED' })
    assert.equal(mock.calls[0].messages.some(message => message.method === 'turn/start'), false)
    assert.equal(sessionState.record ?? null, null)
    if (phase === 'config') assert.equal(mock.calls[0].messages.some(message => ['thread/start', 'thread/resume'].includes(message.method)), false)
    else assert.equal(mock.calls[0].messages.some(message => message.method === `thread/${phase}`), true)
    mock.calls[0].complete('A revoked session must not reappear after late success.')
    await tick()
    assert.equal(sessionState.record ?? null, null)
  }
})

test('session revocation after final text but before cleanup cannot commit the completed thread mapping', async () => {
  const sessionState = {}; let current = true; const mock = fakeServer()
  const result = await sendFullAccessCodex(request({ conversationId: 'revoked-before-commit' }), {
    ...mock.dependencies, sessionState, isSessionCurrent: () => current,
    onEvent(event) { if (event.type === 'delta') current = false },
  })
  assert.equal(result.success, true)
  assert.equal(sessionState.record, null)
})

test('same-name tool description and schema changes reset runtime continuity using the native gateway fingerprint', async () => {
  const base = { name: 'inspect_project', description: 'Inspect the synthetic current project.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
  const variants = [[base], [clone(base)], [{ ...base, description: 'Inspect only the current synthetic shot.' }],
    [{ ...base, description: 'Inspect only the current synthetic shot.', inputSchema: { type: 'object', properties: { shotId: { type: 'string' } }, additionalProperties: false } }]]
  const sessionState = {}; const gateways = []; const fingerprints = []; const mockOptions = {}; let catalog; let toolCalls = 0
  const mock = fakeServer(mockOptions)
  const toolSession = { listTools: async () => clone(catalog), callTool: async () => { toolCalls++; assert.fail('The runtime fixture must not execute editor tools') } }
  const createGatewayImpl = async options => {
    const gateway = await createMcpGateway(options)
    gateways.push(gateway); mockOptions.gateway = gateway
    return gateway
  }
  for (const [index, variant] of variants.entries()) {
    catalog = variant
    await sendFullAccessCodex(request({ conversationId: 'same-name-native-catalog' }), { ...mock.dependencies, sessionState, toolSession, createGatewayImpl })
    fingerprints.push(sessionState.record.fingerprint)
    assert.deepEqual([...gateways[index].toolNames], ['inspect_project'])
    const method = index === 1 ? 'thread/resume' : 'thread/start'
    assert.equal(mock.calls[index].messages.some(message => message.method === method), true)
    assert.equal(mock.calls[index].messages.some(message => message.method === (method === 'thread/start' ? 'thread/resume' : 'thread/start')), false)
  }
  assert.equal(toolCalls, 0)
  assert.notEqual(gateways[0].bearerToken, gateways[1].bearerToken)
  assert.notEqual(gateways[0].tokenEnvVar, gateways[1].tokenEnvVar)
  assert.equal(gateways[0].catalogFingerprint, gateways[1].catalogFingerprint)
  assert.equal(fingerprints[0], fingerprints[1], 'per-turn transport credentials and endpoints cannot force a reset')
  assert.notEqual(fingerprints[1], fingerprints[2], 'changed description must reset unchanged tool names')
  assert.notEqual(fingerprints[2], fingerprints[3], 'changed schema must reset unchanged tool names')
})

test('unsupported thread/resume method falls back once before any turn and supplies the complete visible history', async () => {
  const sessionState = {}; const seed = fakeServer()
  const initial = request({ conversationId: 'native-conversation' })
  await sendFullAccessCodex(initial, { ...seed.dependencies, sessionState })
  const events = []; let turns = 0
  const mock = fakeServer({ errorMethod: 'thread/resume', errorCode: -32601, onTurn(entry) { turns++; entry.complete() } })
  const next = { ...initial, messages: [...initial.messages, { role: 'assistant', content: 'Earlier answer.' }, { role: 'user', content: 'Continue safely.' }] }
  const result = await sendFullAccessCodex(next, { ...mock.dependencies, sessionState, onEvent: event => events.push(event) })
  assert.equal(result.success, true); assert.equal(turns, 1); assert.equal(mock.calls.length, 1)
  assert.deepEqual(mock.calls[0].messages.map(message => message.method).filter(Boolean),
    ['initialize', 'initialized', 'account/read', 'config/read', 'thread/resume', 'thread/start', 'turn/start'])
  const prompt = mock.calls[0].messages.find(message => message.method === 'turn/start').params.input[0].text
  assert.deepEqual(JSON.parse(prompt.split('\n').at(-1)).messages, next.messages)
  assert.doesNotMatch(prompt, /This continues the same conversation/)
  assert.equal(sessionState.record.threadId, 'thread-1')
  assert.equal(events.find(event => event.type === 'timing').continuity, 'reset')
  assert.doesNotMatch(JSON.stringify(events), /Private provider|API key secret/)
})

test('other resume RPC errors cannot fall back or dispatch a turn; only the next explicit send starts fresh', async () => {
  for (const errorCode of [-32602, -32603, -32000]) {
    const sessionState = {}; const seed = fakeServer(); const initial = request({ conversationId: 'native-conversation' })
    await sendFullAccessCodex(initial, { ...seed.dependencies, sessionState })
    const mock = fakeServer({ errorMethod: 'thread/resume', errorCode })
    await assert.rejects(sendFullAccessCodex(initial, { ...mock.dependencies, sessionState }),
      error => error.code === 'CODEX_PROVIDER_ERROR' && !/private|secret/i.test(error.message))
    assert.equal(sessionState.record, null)
    assert.equal(mock.calls[0].messages.some(message => message.method === 'thread/resume'), true)
    assert.equal(mock.calls[0].messages.some(message => ['thread/start', 'turn/start'].includes(message.method)), false)
    const recovery = fakeServer()
    await sendFullAccessCodex(initial, { ...recovery.dependencies, sessionState })
    assert.equal(recovery.calls[0].messages.some(message => message.method === 'thread/resume'), false)
    assert.equal(recovery.calls[0].messages.some(message => message.method === 'thread/start'), true)
  }
})

test('wrong resumed thread, environment, permissions or exact model fail closed without fallback or a user turn', async () => {
  for (const [resumeTransform, code] of [
    [result => ({ ...result, thread: { id: 'foreign-thread' } }), 'CODEX_CONFIGURATION_UNSAFE'],
    [result => ({ ...result, thread: { ...result.thread, environments: [{ id: 'foreign-environment' }] } }), 'CODEX_CONFIGURATION_UNSAFE'],
    [result => ({ ...result, thread: { ...result.thread, environments: [{ environmentId: 'local', cwd: result.cwd, runtimeWorkspaceRoots: [result.cwd, '/unexpected'] }] } }), 'CODEX_CONFIGURATION_UNSAFE'],
    [result => ({ ...result, thread: { ...result.thread, environments: [{ environmentId: 'local', cwd: '/unexpected', runtimeWorkspaceRoots: ['/unexpected'] }] } }), 'CODEX_CONFIGURATION_UNSAFE'],
    [result => ({ ...result, approvalPolicy: 'on-request' }), 'CODEX_CONFIGURATION_UNSAFE'],
    [result => ({ ...result, model: 'unexpected-model' }), 'CODEX_MODEL_MISMATCH'],
  ]) {
    const sessionState = {}; const seed = fakeServer(); const initial = request({ conversationId: 'native-conversation' })
    await sendFullAccessCodex(initial, { ...seed.dependencies, sessionState })
    const mock = fakeServer({ resumeTransform })
    await assert.rejects(sendFullAccessCodex(initial, { ...mock.dependencies, sessionState }), { code })
    assert.equal(sessionState.record, null)
    assert.equal(mock.calls[0].messages.some(message => message.method === 'thread/resume'), true)
    assert.equal(mock.calls[0].messages.some(message => ['thread/start', 'turn/start'].includes(message.method)), false)
    assert.ok(mock.processSignals.length)
  }
})

test('ambiguous resume timeout cannot retry with a fresh thread or dispatch a turn', async () => {
  const sessionState = {}; const seed = fakeServer(); const initial = request({ conversationId: 'native-conversation' })
  await sendFullAccessCodex(initial, { ...seed.dependencies, sessionState })
  const mock = fakeServer({ hangMethod: 'thread/resume' })
  await assert.rejects(sendFullAccessCodex(initial, { ...mock.dependencies, sessionState,
    limits: { ...mock.dependencies.limits, rpcMs: 15 } }), { code: 'CODEX_TIMEOUT' })
  assert.equal(sessionState.record, null)
  assert.equal(mock.calls[0].messages.some(message => message.method === 'thread/resume'), true)
  assert.equal(mock.calls[0].messages.some(message => ['thread/start', 'turn/start'].includes(message.method)), false)
})

test('failed, interrupted, stopped and abruptly exited resumed turns discard continuity and ignore late success', async () => {
  for (const [kind, code] of [['failed', 'CODEX_PROVIDER_ERROR'], ['interrupted', 'CANCELLED'], ['stopped', 'CANCELLED'], ['exit', 'INCOMPLETE_RESPONSE']]) {
    const sessionState = {}; const seed = fakeServer(); const initial = request({ conversationId: 'native-conversation' })
    await sendFullAccessCodex(initial, { ...seed.dependencies, sessionState })
    const controller = new AbortController()
    const mock = fakeServer({ onTurn(entry) {
      entry.event('turn/started', { turn: { id: 'turn-1' } })
      if (kind === 'stopped') controller.abort()
      else if (kind === 'exit') entry.close(1)
      else entry.event('turn/completed', { turn: { id: 'turn-1', status: kind, error: { message: 'private failure' }, items: [] } })
    } })
    await assert.rejects(sendFullAccessCodex(initial, { ...mock.dependencies, sessionState, signal: controller.signal }), { code })
    assert.equal(mock.calls[0].messages.some(message => message.method === 'thread/resume'), true)
    assert.equal(sessionState.record, null)
    mock.calls[0].complete('Late success must not restore an uncertain session.')
    await tick()
    assert.equal(sessionState.record, null)
    const recovery = fakeServer()
    await sendFullAccessCodex(initial, { ...recovery.dependencies, sessionState })
    assert.equal(recovery.calls[0].messages.some(message => message.method === 'thread/resume'), false)
    assert.equal(recovery.calls[0].messages.some(message => message.method === 'thread/start'), true)
    assert.equal(sessionState.record.threadId, 'thread-1')
  }
})

test('full-access chat guidance leaves legitimate JSON artifacts and public progress text intact', async () => {
  const artifact = '{"opinion":"Keep the vocal","musicPrompt":"Quiet piano","importantNote":"JSON was requested"}'
  const commentary = 'I will review the requested music brief.'
  const events = []
  const mock = fakeServer({ onTurn(entry) {
    entry.event('item/completed', { item: { type: 'agentMessage', id: 'progress-1', phase: 'commentary', text: commentary } })
    entry.complete(artifact)
  } })
  const result = await sendFullAccessCodex(request({ model: 'user-custom-model',
    messages: [{ role: 'user', content: 'Return the music brief as JSON.' }] }), {
    ...mock.dependencies, instructions: 'Discuss only the requested music brief.', onEvent: event => events.push(event),
  })
  assert.equal(result.text, artifact)
  assert.ok(events.some(event => event.type === 'progress' && event.phase === 'commentary' && event.text === commentary))
  const thread = mock.calls[0].messages.find(message => message.method === 'thread/start').params
  const turn = mock.calls[0].messages.find(message => message.method === 'turn/start').params
  assert.equal(thread.model, 'user-custom-model'); assert.equal(turn.model, 'user-custom-model')
  assert.match(thread.developerInstructions, /natural prose and readable Markdown/)
  assert.match(thread.developerInstructions, /Discuss only the requested music brief/)
  assert.match(turn.input[0].text, /Return the music brief as JSON/)
  assert.equal(turn.outputSchema, undefined)
})

test('merged user MCP/plugins/hooks/environment are explicitly disabled in a metadata-only restart', async () => {
  const inherited = fullAccessConfig()
  inherited.mcp_servers.inherited_server = { command: 'do-not-execute-private-command', env: { SECRET: 'private-token' }, enabled: true, required: true }
  inherited.plugins['plugin@synthetic-marketplace'] = { enabled: true }
  inherited.hooks.SessionStart = [{ command: 'do-not-execute-private-hook' }]
  inherited.shell_environment_policy.set = { PRIVATE_TOKEN: 'private-token' }
  inherited.features.other_execution_feature = true
  const sanitized = isolateMergedConfiguration(inherited, fullAccessConfig())
  assert.doesNotMatch(JSON.stringify(sanitized), /private-token|do-not-execute/)
  assert.deepEqual(sanitized.mcp_servers.inherited_server, { enabled: false, required: false })
  assert.deepEqual(sanitized.plugins['plugin@synthetic-marketplace'], { enabled: false })
  assert.equal(sanitized.shell_environment_policy.set.PRIVATE_TOKEN, '')
  assert.deepEqual(sanitized.hooks.SessionStart, [])
  const mock = fakeServer({ configTransform(_config, _entry, count) {
    if (count === 1) return inherited
    const resolved = clone(sanitized)
    // Real CLI serializes disabled required=false as an omitted default and
    // retains the disabled server's private config, which must never be copied.
    resolved.mcp_servers.inherited_server = { command: 'do-not-execute-private-command', env: { SECRET: 'private-token' }, enabled: false }
    return resolved
  } })
  await sendFullAccessCodex(request(), mock.dependencies)
  assert.equal(mock.calls.length, 2)
  assert.ok(mock.calls[0].messages.every(message => message.method !== 'thread/start' && message.method !== 'turn/start'))
  assert.ok(mock.calls[1].messages.some(message => message.method === 'turn/start'))
  for (const call of mock.calls) assert.doesNotMatch(JSON.stringify([call.args, call.options.env, call.messages]), /private-token|do-not-execute/)
})

test('a second isolation check failure stops without starting a thread or looping', async () => {
  const mock = fakeServer({ configTransform(config) { config.mcp_servers.inherited = { enabled: true, command: 'do-not-run' }; return config } })
  await assert.rejects(sendFullAccessCodex(request(), mock.dependencies), { code: 'CODEX_CONFIGURATION_UNSAFE' })
  assert.equal(mock.calls.length, 2)
  assert.ok(mock.calls.every(call => call.messages.every(message => message.method !== 'thread/start')))
})

test('initial auth failures prove no prompt was sent, but an auth change after turn/start does not', async () => {
  for (const [options, code] of [[{ signedOut: true }, 'CODEX_LOGIN_REQUIRED'], [{ accountType: 'apiKey' }, 'CODEX_CHATGPT_REQUIRED']]) {
    const mock = fakeServer(options)
    await assert.rejects(sendFullAccessCodex(request(), mock.dependencies), error => {
      assert.equal(error.code, code)
      assert.equal(codexPromptWasNotSent(error), true)
      return true
    })
    assert.ok(mock.calls[0].messages.every(message => !['thread/start', 'turn/start'].includes(message.method)))
  }
  const mock = fakeServer({ onTurn(entry) { entry.event('account/updated', { authMode: 'apiKey' }) } })
  await assert.rejects(sendFullAccessCodex(request(), mock.dependencies), error => {
    assert.equal(error.code, 'CODEX_CHATGPT_REQUIRED')
    assert.equal(codexPromptWasNotSent(error), false)
    return true
  })
  assert.ok(mock.calls[0].messages.some(message => message.method === 'turn/start'))
})

test('API key auth, altered effective config, permissions and model substitution fail before turn/start', async () => {
  for (const [options, code] of [
    [{ accountType: 'apiKey' }, 'CODEX_CHATGPT_REQUIRED'], [{ accountType: 'amazonBedrock' }, 'CODEX_CHATGPT_REQUIRED'],
    [{ configTransform: config => ({ ...config, sandbox_mode: 'read-only' }) }, 'CODEX_CONFIGURATION_UNSAFE'],
    [{ configTransform: config => ({ ...config, openai_base_url: 'https://api.openai.com/v1' }) }, 'CODEX_CONFIGURATION_UNSAFE'],
    [{ configTransform: config => ({ ...config, otel: { ...config.otel, log_user_prompt: true } }) }, 'CODEX_CONFIGURATION_UNSAFE'],
    [{ threadTransform: value => ({ ...value, sandbox: { type: 'readOnly' } }) }, 'CODEX_CONFIGURATION_UNSAFE'],
    [{ threadTransform: value => ({ ...value, approvalPolicy: 'on-request' }) }, 'CODEX_CONFIGURATION_UNSAFE'],
    [{ threadTransform: value => ({ ...value, approvalsReviewer: 'auto_review' }) }, 'CODEX_CONFIGURATION_UNSAFE'],
    [{ threadTransform: value => ({ ...value, instructionSources: ['/inherited/AGENTS.md'] }) }, 'CODEX_CONFIGURATION_UNSAFE'],
    [{ threadTransform: value => ({ ...value, model: 'substituted-model' }) }, 'CODEX_MODEL_MISMATCH'],
    [{ errorMethod: 'thread/start' }, 'CODEX_PROVIDER_ERROR'],
  ]) {
    const mock = fakeServer(options)
    await assert.rejects(sendFullAccessCodex(request(), mock.dependencies), error => error.code === code && !/private|secret/i.test(error.message))
    assert.ok(mock.calls[0].messages.every(message => message.method !== 'turn/start'))
  }
})

test('streams actual command/file/web/image activity and text, never reasoning or raw results', async () => {
  const events = []
  const mock = fakeServer({ onTurn(entry) {
    entry.event('turn/started', { turn: { id: 'turn-1', status: 'inProgress' } })
    entry.event('item/started', { item: { type: 'reasoning', id: 'r1', text: 'hidden reasoning' } })
    entry.event('item/reasoning/textDelta', { itemId: 'r1', delta: 'hidden reasoning' })
    for (const item of [
      { type: 'commandExecution', id: 'c1', command: 'pwd', cwd: os.tmpdir(), aggregatedOutput: 'Authorization: Bearer private-output' },
      { type: 'fileChange', id: 'f1', changes: [{ path: '/synthetic/file', diff: 'private diff' }] },
      { type: 'webSearch', id: 'w1', query: 'Example query' }, { type: 'imageView', id: 'v1', path: '/synthetic/image.png' },
    ]) {
      entry.event('item/started', { item: { ...item, status: 'inProgress' } })
      entry.event('item/completed', { item: { ...item, status: 'completed', exitCode: 0 } })
    }
    entry.event('item/agentMessage/delta', { itemId: 'answer-1', delta: 'Hello ' })
    entry.event('item/agentMessage/delta', { itemId: 'answer-1', delta: 'world.' })
    entry.event('item/completed', { item: { type: 'agentMessage', id: 'answer-1', text: 'Hello world.' } })
    entry.event('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', id: 'answer-1', text: 'Hello world.' }] } })
  } })
  const result = await sendFullAccessCodex(request(), { ...mock.dependencies, onEvent: event => events.push(event) })
  assert.equal(result.text, 'Hello world.')
  assert.equal(events.filter(event => event.type === 'tool').length, 8)
  assert.deepEqual(events.filter(event => event.type === 'tool').map(event => event.status), ['running', 'completed', 'running', 'completed', 'running', 'completed', 'running', 'completed'])
  assert.doesNotMatch(JSON.stringify(events), /hidden reasoning|private-output|private diff/)
  assert.match(events.find(event => event.output)?.output || '', /redacted/)
})

test('public commentary and final answer stream separately with authoritative completion and no duplicate final', async () => {
  const events = []
  const mock = fakeServer({ onTurn(entry) {
    entry.event('item/started', { item: { type: 'agentMessage', id: 'progress-1', phase: 'commentary', text: '' } })
    entry.event('item/agentMessage/delta', { itemId: 'progress-1', delta: 'Checking the workflow.\n' })
    entry.event('item/agentMessage/delta', { itemId: 'progress-1', delta: 'OPENAI_API_' })
    entry.event('item/agentMessage/delta', { itemId: 'progress-1', delta: 'KEY=sk-must-not-appear\n' })
    entry.event('item/completed', { item: { type: 'agentMessage', id: 'progress-1', phase: 'commentary', text: 'Workflow inspection completed.' } })
    entry.event('item/started', { item: { type: 'agentMessage', id: 'answer-1', phase: 'final_answer', text: '' } })
    entry.event('item/agentMessage/delta', { itemId: 'answer-1', delta: 'Provisional summary.\n' })
    const final = { type: 'agentMessage', id: 'answer-1', phase: 'final_answer', text: 'Verified final outcome.' }
    entry.event('item/completed', { item: final })
    entry.event('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [final] } })
  } })
  const result = await sendFullAccessCodex(request(), { ...mock.dependencies, onEvent: event => events.push(event) })
  assert.equal(result.text, 'Verified final outcome.')
  const progress = events.filter(event => event.type === 'progress')
  assert.ok(progress.some(event => event.itemId === 'progress-1' && event.phase === 'commentary' && event.status === 'running'))
  assert.ok(progress.some(event => event.itemId === 'progress-1' && event.text === 'Workflow inspection completed.' && event.status === 'completed'))
  assert.equal(progress.filter(event => event.itemId === 'answer-1' && event.status === 'completed').length, 1)
  assert.deepEqual(events.filter(event => event.type === 'delta'), [{ type: 'delta', text: result.text }])
  assert.doesNotMatch(JSON.stringify(events), /sk-must-not-appear|OPENAI_API_"/)
})

test('phase-less deltas wait for authoritative public classification and never treat reasoning as progress', async () => {
  const events = []
  const mock = fakeServer({ onTurn(entry) {
    entry.event('item/started', { item: { type: 'reasoning', id: 'r1', text: 'private-reasoning', summary: [{ text: 'private-summary' }] } })
    entry.event('item/reasoning/textDelta', { itemId: 'r1', delta: 'private-reasoning' })
    entry.event('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'private-summary' })
    entry.event('item/agentMessage/delta', { itemId: 'p1', delta: 'Public step\n' })
    assert.equal(events.filter(event => event.type === 'progress').length, 0)
    entry.event('item/completed', { item: { type: 'agentMessage', id: 'p1', phase: 'commentary', text: 'Public step' } })
    entry.complete('Final response')
  } })
  const result = await sendFullAccessCodex(request(), { ...mock.dependencies, onEvent: event => events.push(event) })
  assert.equal(result.text, 'Final response')
  assert.equal(events.find(event => event.itemId === 'p1').phase, 'commentary')
  assert.doesNotMatch(JSON.stringify(events), /private-reasoning|private-summary/)
})

test('unknown public phase is refused and explicit commentary alone is not a final answer', async () => {
  for (const [phase, code] of [['analysis', 'CODEX_PROTOCOL_ERROR'], ['commentary', 'EMPTY_RESPONSE']]) {
    const events = []
    const mock = fakeServer({ onTurn(entry) {
      entry.event('item/completed', { item: { type: 'agentMessage', id: 'p1', phase, text: 'Visible only for commentary.' } })
      entry.event('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } })
    } })
    await assert.rejects(sendFullAccessCodex(request(), { ...mock.dependencies, onEvent: event => events.push(event) }), { code })
    if (phase === 'analysis') assert.equal(events.filter(event => event.type === 'progress' || event.type === 'delta').length, 0)
  }
})

test('command output is cumulative, line-safe across split credentials and authoritative on completion', async () => {
  const events = []
  const mock = fakeServer({ onTurn(entry) {
    entry.event('item/commandExecution/outputDelta', { itemId: 'unknown', delta: 'unknown-private-output\n' })
    entry.event('item/started', { item: { type: 'commandExecution', id: 'c1', command: 'printf status', status: 'inProgress' } })
    for (const delta of ['Downloaded ', '1 MB\nOPENAI_API_', 'KEY=sk-hidden-credential\n', 'Authorization: Bea', 'rer another-secret\n']) {
      entry.event('item/commandExecution/outputDelta', { itemId: 'c1', delta })
    }
    entry.event('item/commandExecution/outputDelta', { threadId: 'foreign', itemId: 'c1', delta: 'foreign-private-output\n' })
    entry.event('item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'printf status', status: 'completed', exitCode: 1,
      aggregatedOutput: 'Authoritative command result\nPASSWORD=final-secret\n' } })
    entry.event('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'late-private-output\n' })
    entry.complete()
  } })
  await sendFullAccessCodex(request(), { ...mock.dependencies, onEvent: event => events.push(event) })
  const commands = events.filter(event => event.type === 'tool' && event.callId === 'codex:c1')
  assert.equal(commands[0].output, undefined)
  assert.equal(commands[1].output, 'Downloaded 1 MB\n')
  assert.ok(commands.some(event => event.output?.includes('redacted')))
  assert.equal(commands.at(-1).status, 'failed')
  assert.match(commands.at(-1).output, /^Authoritative command result\n/)
  assert.doesNotMatch(JSON.stringify(events), /hidden-credential|another-secret|final-secret|unknown-private|foreign-private|late-private|OPENAI_API_"/)
})

test('authoritative empty command completion clears provisional output in the renderer', async () => {
  const events = []
  const mock = fakeServer({ onTurn(entry) {
    entry.event('item/started', { item: { type: 'commandExecution', id: 'empty-output', command: 'synthetic', status: 'inProgress' } })
    entry.event('item/commandExecution/outputDelta', { itemId: 'empty-output', delta: 'Provisional result\n' })
    entry.event('item/completed', { item: { type: 'commandExecution', id: 'empty-output', command: 'synthetic', status: 'completed', exitCode: 0, aggregatedOutput: '' } })
    entry.complete()
  } })
  await sendFullAccessCodex(request(), { ...mock.dependencies, onEvent: event => events.push(event) })
  const commands = events.filter(event => event.type === 'tool' && event.callId === 'codex:empty-output')
  assert.equal(commands.at(-2).output, 'Provisional result\n')
  assert.equal(commands.at(-1).output, '')
})

test('activity redaction handles known tokens, URL credentials, ANSI, private keys and bounded Unicode', () => {
  const text = redactActivityText('Safe \u001b[32mprogress\u001b[0m\nAuthorization: Bearer do-not-show\n'
    + 'https://user:password@example.test/file\nhttps://example.test/?X-Amz-Signature=hidden-query\n'
    + 'sk-1234567890 ghp_abcdefghijk hf_abcdefghijk eyJabcdefgh.abcdefghijk.abcdefghijk\n'
    + '-----BEGIN PRIVATE KEY-----\nprivate-key-bytes\n-----END PRIVATE KEY-----\nknown-gateway-token', { secret: 'known-gateway-token' })
  assert.match(text, /Safe progress/)
  assert.doesNotMatch(text, /do-not-show|user:password|hidden-query|1234567890|abcdefgh|private-key-bytes|known-gateway-token|\u001b/)
  assert.equal(redactActivityText('safe\nAPI_', { complete: false }), 'safe\n')
  const truncated = redactActivityText('映像'.repeat(100), { maxBytes: 40 })
  assert.ok(Buffer.byteLength(truncated) <= 40)
  assert.doesNotMatch(truncated, /\uFFFD/)
  assert.match(truncated, /truncated/)
})

test('command output retention and displayed text are bounded without flushing an incomplete secret', async () => {
  const events = []
  const mock = fakeServer({ onTurn(entry) {
    for (let index = 0; index < 4; index++) {
      entry.event('item/started', { item: { type: 'commandExecution', id: `c${index}`, command: 'printf status' } })
      entry.event('item/commandExecution/outputDelta', { itemId: `c${index}`, delta: `safe line\nTOKEN=${'private'.repeat(80)}` })
      entry.event('item/completed', { item: { type: 'commandExecution', id: `c${index}`, command: 'printf status', status: 'completed', exitCode: 0 } })
    }
    entry.complete()
  } })
  await sendFullAccessCodex(request(), { ...mock.dependencies, limits: { ...mock.dependencies.limits, outputBytes: 64, outputTotalBytes: 96 }, onEvent: event => events.push(event) })
  const outputs = events.filter(event => event.output).map(event => event.output)
  assert.ok(outputs.every(output => Buffer.byteLength(output) <= 64))
  assert.ok(outputs.some(output => output.includes('truncated')))
  assert.doesNotMatch(outputs.join(''), /private|TOKEN=/)
})

test('native MCP events do not duplicate host rows or expose raw MCP error results', async () => {
  const events = []
  const gateway = { serverName: 'velorn_session', url: 'http://127.0.0.1:39991/mcp', tokenEnvVar: 'VELORN_TEST_MCP', bearerToken: 'private-gateway-secret', toolNames: new Set(['inspect_project']), close: async () => {} }
  const mock = fakeServer({ gateway, onTurn(entry) {
    const item = { type: 'mcpToolCall', id: 'mcp1', server: 'velorn_session', tool: 'inspect_project' }
    entry.event('item/started', { item: { ...item, status: 'inProgress' } })
    entry.event('item/completed', { item: { ...item, status: 'completed', result: { isError: true, content: [{ type: 'text', text: 'private MCP diagnostics' }] } } })
    entry.event('item/started', { item: { type: 'commandExecution', id: 'c1', command: 'echo private-gateway-secret' } })
    entry.event('item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'echo private-gateway-secret', aggregatedOutput: 'private-gateway-secret', status: 'completed', exitCode: 0 } })
    entry.complete()
  } })
  await sendFullAccessCodex(request(), { ...mock.dependencies, toolSession: {}, createGatewayImpl: async () => gateway, onEvent: event => events.push(event) })
  assert.ok(!events.some(event => event.callId === 'codex:mcp1' || event.toolName === 'inspect_project'))
  assert.doesNotMatch(JSON.stringify(events), /private MCP diagnostics|private-gateway-secret/)
})

test('unexpected command and file permission requests decline and fail closed without showing a card', async () => {
  for (const kind of ['command', 'file']) {
    const reviews = []
    const mock = fakeServer({ onTurn(entry) {
      if (kind === 'file') entry.event('item/started', { item: { type: 'fileChange', id: 'change1', changes: [{ path: '/synthetic/file', diff: '+ example', kind: { type: 'add' } }] } })
      entry.send({ id: 'approval-1', method: kind === 'file' ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'change1', reason: 'Requested operation', ...(kind === 'command' ? { command: 'printf example', cwd: os.tmpdir(), availableDecisions: ['accept', 'decline'] } : {}) } })
    }, onResponse(message, entry) { if (message.id === 'approval-1') entry.complete('Late completion must not turn refusal into success.') } })
    await assert.rejects(sendFullAccessCodex(request(), { ...mock.dependencies, requestApproval: async details => { reviews.push(details); return true } }), { code: 'CODEX_UNSUPPORTED_REQUEST' })
    assert.equal(reviews.length, 0)
    assert.equal(mock.calls[0].responses[0].result.decision, 'decline')
    assert.ok(mock.processSignals.length)
  }
})

test('missing reviewer, opaque/oversized permission requests and callback errors cannot authorize commands', async () => {
  for (const variant of ['no-reviewer', 'opaque', 'oversize', 'error']) {
    let reviews = 0
    const mock = fakeServer({ onTurn(entry) {
      entry.send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'c1',
        ...(variant === 'opaque' ? {} : { command: variant === 'oversize' ? 'x'.repeat(50 * 1024) : 'printf example' }) } })
    } })
    await assert.rejects(sendFullAccessCodex(request(), { ...mock.dependencies,
      ...(variant !== 'no-reviewer' ? { requestApproval: () => { reviews++; throw new Error('private approval failure') } } : {}) }), { code: 'CODEX_UNSUPPORTED_REQUEST' })
    assert.equal(mock.calls[0].responses[0].result.decision, 'decline')
    assert.equal(reviews, 0)
  }
})

test('unknown or foreign server requests receive protocol error and interrupt, never auto-approval', async () => {
  for (const [method, foreign] of [['item/tool/call', false], ['item/permissions/requestApproval', false], ['item/commandExecution/requestApproval', true]]) {
    let reviews = 0
    const mock = fakeServer({ onTurn(entry) {
      entry.event('turn/started', { turn: { id: 'turn-1' } })
      entry.send({ id: 'unknown-1', method, params: { threadId: foreign ? 'another-thread' : 'thread-1', turnId: 'turn-1', itemId: 'c1', command: 'printf forbidden' } })
    } })
    await assert.rejects(sendFullAccessCodex(request(), { ...mock.dependencies, requestApproval: () => { reviews++; return true } }), { code: 'CODEX_UNSUPPORTED_REQUEST' })
    assert.equal(reviews, 0)
    assert.equal(mock.calls[0].responses[0].error.code, -32601)
    assert.ok(mock.calls[0].messages.some(message => message.method === 'turn/interrupt'))
    assert.ok(mock.processSignals.length)
  }
})

test('cancellation interrupts running turn, kills owned process group, and ignores late activity', async () => {
  const controller = new AbortController(); let turnReady
  const ready = new Promise(resolve => { turnReady = resolve }); const events = []
  const mock = fakeServer({ onTurn(entry) {
    entry.event('turn/started', { turn: { id: 'turn-1' } })
    entry.event('item/started', { item: { type: 'commandExecution', id: 'c1', command: 'printf example' } })
    turnReady()
  } })
  const run = sendFullAccessCodex(request(), { ...mock.dependencies, signal: controller.signal, onEvent: event => events.push(event) })
  await ready; controller.abort()
  await assert.rejects(run, { code: 'CANCELLED' })
  const count = events.length
  mock.calls[0].event('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'late activity\n' })
  mock.calls[0].complete('Late answer')
  await tick()
  assert.equal(events.length, count)
  assert.equal(mock.calls[0].responses.length, 0)
  const interrupt = mock.calls[0].messages.find(message => message.method === 'turn/interrupt')
  assert.deepEqual(interrupt.params, { threadId: 'thread-1', turnId: 'turn-1' })
  assert.ok(mock.processSignals.some(([pid]) => pid === -123456789))
})

test('zero total deadline permits Full access work and explicit Stop still terminates it',async()=>{
  const controller=new AbortController(),mock=fakeServer({onTurn(){}})
  const pending=sendFullAccessCodex(request(),{...mock.dependencies,timeoutMs:0,signal:controller.signal})
  while(!mock.calls.length || !mock.calls[0].messages.some(message=>message.method==='turn/start')) await tick()
  controller.abort()
  await assert.rejects(pending)
})
test('total timeout and unresponsive subprocess do not hang cancellation/cleanup', async () => {
  const mock = fakeServer({ onTurn() {}, neverCloses: true })
  await assert.rejects(sendFullAccessCodex(request(), { ...mock.dependencies, timeoutMs: 20 }), { code: 'TIMEOUT' })
  assert.ok(mock.processSignals.some(([, signal]) => signal === 'SIGTERM'))
  assert.ok(mock.processSignals.some(([, signal]) => signal === 'SIGKILL'))
  await assert.rejects(fs.stat(mock.calls[0].options.cwd), { code: 'ENOENT' })
})

test('nonzero Full access budget pauses only through the native user-wait subscription', async () => {
  const listeners = new Set()
  const toolSession = { listTools: async () => [], callTool: async () => assert.fail('No synthetic tool dispatch expected'),
    subscribeUserWaiting: listener => { listeners.add(listener); listener(true); return () => listeners.delete(listener) } }
  const mock = fakeServer({ onTurn() {} })
  const pending = sendFullAccessCodex(request(), { ...mock.dependencies, toolSession, timeoutMs: 40,
    createGatewayImpl: async () => undefined })
  const waitDeadline = performance.now() + 5000
  while (!mock.calls.length || !mock.calls[0].messages.some(message => message.method === 'turn/start')) {
    assert.ok(performance.now() < waitDeadline, 'Synthetic Codex did not start within 5 seconds'); await tick()
  }
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.equal(mock.processSignals.length, 0, 'waiting for a credential is not active model execution time')
  for (const listener of listeners) listener(false)
  mock.calls[0].complete('User setup finished.')
  assert.equal((await pending).text, 'User setup finished.')
  assert.equal(listeners.size, 0)
})

test('protocol RPC startup timeout, missing executable and abrupt exit return sanitized errors', async () => {
  for (const [options, code] of [[{ hangMethod: 'initialize' }, 'CODEX_TIMEOUT'], [{ spawnError: 'ENOENT' }, 'CODEX_NOT_FOUND'],
    [{ onTurn: entry => entry.close(1) }, 'INCOMPLETE_RESPONSE']]) {
    const mock = fakeServer(options)
    await assert.rejects(sendFullAccessCodex(request(), { ...mock.dependencies, limits: { ...mock.dependencies.limits, rpcMs: 15 } }),
      error => error.code === code && !error.message.includes('private'))
  }
})

test('Windows cleanup scopes taskkill to owned child PID and descendants, not executable name', async () => {
  const mock = fakeServer()
  await sendFullAccessCodex(request(), { ...mock.dependencies, platform: 'win32' })
  assert.equal(mock.calls[0].options.detached, false)
  assert.equal(mock.taskkill[0].file, 'taskkill')
  assert.deepEqual(mock.taskkill[0].args, ['/PID', '123456789', '/T', '/F'])
  assert.equal(mock.taskkill[0].options.shell, false)
  assert.ok(mock.taskkill[0].options.timeout <= 2000)
  let calls = 0
  for (const child of [{ pid: -1, exitCode: null }, { pid: 1, exitCode: 0 }, { pid: undefined, exitCode: null }]) terminateOwnedProcess(child, 'SIGTERM', { platform: 'win32', execFileImpl: () => { calls++ } })
  assert.equal(calls, 0)
})

test('malformed, excessive, failed and empty events stop cleanly without diagnostics leakage', async () => {
  const variants = [
    ['CODEX_PROTOCOL_ERROR', entry => entry.child.stdout.write('{broken\n'), {}],
    ['RESPONSE_TOO_LARGE', entry => entry.child.stdout.write('x'.repeat(40)), { lineBytes: 32 }],
    ['RESPONSE_TOO_LARGE', entry => entry.child.stderr.write('x'.repeat(40)), { stderrBytes: 32 }],
    ['RESPONSE_TOO_LARGE', entry => entry.complete('x'.repeat(40)), { textBytes: 32 }],
    ['CODEX_PROVIDER_ERROR', entry => entry.event('turn/completed', { turn: { id: 'turn-1', status: 'failed', error: { message: 'private secret diagnostics' }, items: [] } }), {}],
    ['EMPTY_RESPONSE', entry => entry.event('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } }), {}],
    ['CODEX_UNEXPECTED_CAPABILITY', entry => entry.event('item/started', { item: { id: 'x1', type: 'unknownCapability' } }), {}],
    ['CODEX_UNEXPECTED_CAPABILITY', entry => entry.event('item/started', { item: { id: 'x1', type: 'mcpToolCall', server: 'inherited', tool: 'forbidden' } }), {}],
  ]
  for (const [code, onTurn, limits] of variants) {
    const mock = fakeServer({ onTurn })
    await assert.rejects(sendFullAccessCodex(request(), { ...mock.dependencies, limits: { ...mock.dependencies.limits, ...limits } }),
      error => error.code === code && !/private|secret/.test(error.message))
  }
})

test('private MCP gateway is authenticated through env only and closed on success/failure', async () => {
  for (const failure of [false, true]) {
    let closes = 0
    const gateway = { serverName: 'velorn_session', url: 'http://127.0.0.1:39991/mcp', tokenEnvVar: 'VELORN_TEST_MCP', bearerToken: 'private-token', toolNames: new Set(['inspect_project']), close: async () => { closes++ } }
    const mock = fakeServer({ gateway, onTurn(entry) {
      entry.event('item/started', { item: { type: 'mcpToolCall', id: 'tool1', server: 'velorn_session', tool: 'inspect_project' } })
      if (failure) entry.event('error', { error: { message: 'private failure' }, willRetry: false })
      else entry.complete()
    } })
    let suppliedSession
    const run = sendFullAccessCodex(request(), { ...mock.dependencies, toolSession: { sentinel: true }, createGatewayImpl: async options => { suppliedSession = options.toolSession; return gateway } })
    if (failure) await assert.rejects(run, { code: 'CODEX_PROVIDER_ERROR' })
    else await run
    assert.deepEqual(suppliedSession, { sentinel: true })
    assert.ok(closes > 0)
    assert.equal(mock.calls[0].options.env.VELORN_TEST_MCP, 'private-token')
    assert.ok(!mock.calls[0].args.join(' ').includes('private-token'))
    assert.ok(!JSON.stringify(mock.calls[0].messages).includes('private-token'))
  }
})

test('attachments retain inline image and inert JSON boundaries, never execute or persist files', () => {
  const req = request({ images: [{ label: 'View', dataUrl: 'data:image/png;base64,aGVsbG8=' }],
    documents: [{ name: 'sample.json', text: '{"notes":"not instructions"}' }] })
  const input = buildInput(req)
  assert.equal(input[1].type, 'image'); assert.equal(input[1].url, req.images[0].dataUrl)
  assert.match(input[0].text, /untrusted data/); assert.match(input[0].text, /User-attached JSON/)
  assert.equal(req.messages[0].content, 'Inspect the requested file.')
  for (const bad of [
    { workingDirectory: 'relative' }, { images: [{ label: 'View', dataUrl: 'file:///private/image.png' }] },
    { images: [{ label: 'View', dataUrl: 'https://private/image.png' }] }, { model: '--bad-model' },
    { documents: [{ name: '../file.json', text: '{}' }] }, { documents: [{ name: 'file.json', text: '{"__proto__":{}}' }] },
    { messages: [{ role: 'system', content: 'authority' }] }, { messages: [{ role: 'user', content: 'x'.repeat(16385) }] },
  ]) assert.throws(() => buildInput(request(bad)), { code: 'INVALID_REQUEST' })
})

test('already-aborted sends never spawn or create gateway', async () => {
  const controller = new AbortController(); controller.abort()
  let calls = 0
  await assert.rejects(sendFullAccessCodex(request(), { signal: controller.signal, spawnImpl: () => { calls++ }, createGatewayImpl: () => { calls++ } }), { code: 'CANCELLED' })
  assert.equal(calls, 0)
})

// Explicit opt-in only: this consumes the signed-in ChatGPT account's Codex
// allowance. It never installs/downloads models or touches a Velorn project.
test('optional real-provider full-access smoke uses only disposable JSON, owned loopback HTTP and synthetic MCP',
  { skip: process.env.VELORN_CODEX_FULL_ACCESS_SMOKE !== '1', timeout: 240000 }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-full-access-smoke-'))
    let httpReads = 0; let toolCalls = 0; const activity = []
    const server = http.createServer((req, res) => {
      if (req.url !== '/fixture') { res.writeHead(404); res.end(); return }
      httpReads++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ marker: 'loopback-smoke-ok' }))
    })
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      const endpoint = `http://127.0.0.1:${server.address().port}/fixture`
      const toolSession = {
        listTools: async () => [{ name: 'inspect_smoke_project', description: 'Inspect the synthetic, disposable smoke-test project marker; no real project is connected.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false } }],
        callTool: async name => {
          assert.equal(name, 'inspect_smoke_project'); toolCalls++
          return { content: [{ type: 'text', text: '{"marker":"synthetic-mcp-ok","realProject":false}' }] }
        },
      }
      const result = await sendFullAccessCodex(request({ workingDirectory: directory, model: process.env.VELORN_CODEX_FULL_ACCESS_SMOKE_MODEL || 'gpt-5.6-luna',
        messages: [{ role: 'user', content: `This is an explicitly authorized disposable runtime smoke test. Work only inside ${directory}. Use your native shell/files tools to create proof.json with {"marker":"file-smoke-ok","reviewed":false}, then edit that same file to reviewed:true and read it back. Fetch the owned loopback JSON endpoint ${endpoint} via a native shell command. Call the provided inspect_smoke_project Velorn tool. Report the three marker values and what actually completed. Do not use any other filesystem directory, external site, account, downloads, models, ComfyUI, or application. Do not create extra scripts or files. Do not seek elevated privileges.` }] }),
      { timeoutMs: 210000, toolSession, requestApproval: async () => false, onEvent: event => { if (event.type === 'tool') activity.push(event) } })
      assert.equal(result.success, true)
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'proof.json'), 'utf8')), { marker: 'file-smoke-ok', reviewed: true })
      assert.ok(httpReads > 0, 'native shell must reach the owned loopback fixture')
      assert.ok(toolCalls > 0, 'private authenticated gateway must be called')
      assert.ok(activity.some(event => event.toolName === 'Shell command'), 'real native execution must appear in activity')
    } finally {
      server.closeAllConnections?.()
      await new Promise(resolve => server.close(resolve))
      // Only the known synthetic file is removable, never recursively delete
      // unexpected outputs that the agent may have produced.
      await fs.unlink(path.join(directory, 'proof.json')).catch(() => {})
      await fs.rmdir(directory).catch(() => {})
    }
  })
