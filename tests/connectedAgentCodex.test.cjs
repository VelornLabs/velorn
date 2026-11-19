'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { execFile, spawn } = require('node:child_process')
const { inspectCodex, sendCodex, preflightCodex, createProtocolReader, childEnvironment, restrictionArgs, verifiedFeatures, normalizeCodexModels, readCodexModels, REQUIRED_FEATURES, REQUIRED_FLAGS } = require('../electron/connectedAgentCodex.cjs')
const { createMcpGateway } = require('../electron/connectedAgentMcpGateway.cjs')
const { PROJECT_CONVERSATION_GUIDANCE, withProjectConversationGuidance } = require('../electron/connectedAgentProjectGuidance.cjs')

const featureOutput = REQUIRED_FEATURES.map(name => `${name} stable ${name === 'unified_exec' ? 'true' : 'false'}`).concat('skip_host_skill_discovery under development true').join('\n')
function metadata({ auth = 'Logged in using ChatGPT', featureText, help = REQUIRED_FLAGS.join('\n'), missing = false,
  catalog = { models: [{ slug: 'sample-chat-model', display_name: 'Sample Chat Model', visibility: 'list', priority: 1 }] }, catalogFailure = null } = {}) {
  const calls = []
  const run = (file, args, options, done) => {
    calls.push({ file, args, options })
    if (missing) { done(Object.assign(new Error('missing'), { code: 'ENOENT' }), '', ''); return }
    if (args.includes('debug') && args.includes('models')) { done(catalogFailure, typeof catalog === 'string' ? catalog : JSON.stringify(catalog), catalogFailure ? 'Private diagnostic; do not expose' : ''); return }
    const features = featureText ?? (args.includes('code_mode_host') && args[args.indexOf('code_mode_host') - 1] === '--enable'
      ? featureOutput.replace('code_mode stable false', 'code_mode stable true').replace('code_mode_host stable false', 'code_mode_host stable true') : featureOutput)
    const output = args.includes('--version') ? 'codex-cli 0.154.0-alpha.6.2\n' : args.includes('--help') ? help : args.includes('features') ? features : ''
    done(null, output, args.includes('login') ? auth : '')
  }
  return { run, calls }
}
const sendRequest = (overrides = {}) => ({ requestId: 'abc', context: '{"shots":[{"id":"shot-one"}]}', messages: [{ role: 'user', content: 'Review the shot.' }], images: [], ...overrides })
const line = value => JSON.stringify(value) + '\n'
function fakeSpawn({ events = [{ type: 'thread.started', thread_id: 't1' }, { type: 'turn.started' }, { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Review [[shot:shot-one]].' } }, { type: 'turn.completed' }], pending = false, code = 0 } = {}) {
  const calls = []
  const spawnImpl = (file, args, options) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null })
    const entry = { file, args, options, child, prompt: '', kills: [] }; calls.push(entry)
    child.stdin.on('data', chunk => { entry.prompt += chunk })
    child.kill = signal => { entry.kills.push(signal); queueMicrotask(() => { child.exitCode = 143; child.emit('close', 143) }); return true }
    child.stdin.on('finish', () => {
      if (pending) return
      queueMicrotask(() => {
        for (const event of events) child.stdout.write(line(event))
        child.exitCode = code
        child.emit('close', code)
      })
    })
    return child
  }
  return { spawnImpl, calls }
}

test('restricted Codex rechecks phone sharing after async metadata before spawning a prompt process', async () => {
  const model = fakeSpawn(), check = metadata()
  const { sharingFailure, sharingPromptWasNotSent } = require('../electron/mobileAISharing.cjs')
  await assert.rejects(sendCodex(sendRequest(), { execFileImpl: check.run, spawnImpl: model.spawnImpl,
    assertBeforeSend() { assert.ok(check.calls.length >= 4); throw sharingFailure() } }), error => sharingPromptWasNotSent(error))
  assert.equal(model.calls.length, 0)
})

test('actual restricted Codex stdin includes optional project guidance once with ordinary user text preserved', async () => {
  for (const instructions of [undefined, withProjectConversationGuidance('Read-only native policy. No project writes are allowed.')]) {
    const model = fakeSpawn()
    const userText = 'Continue the current edit; do not restart planning.'
    await sendCodex(sendRequest({ messages: [{ role: 'user', content: userText }] }), {
      instructions, execFileImpl: metadata().run, spawnImpl: model.spawnImpl,
    })
    const prompt = model.calls[0].prompt
    assert.equal(prompt.split(PROJECT_CONVERSATION_GUIDANCE).length - 1, 1)
    assert.ok(prompt.includes(userText)); assert.match(prompt, /No tools or actions are available|No project writes are allowed/)
    assert.ok(model.calls[0].args.includes('read-only')); assert.equal(model.calls[0].options.shell, false)
  }
})

test('restricted Codex receives explicit thinking effort as a command argument without changing global configuration', async () => {
  for (const effort of [undefined, 'low', 'medium', 'ultra']) {
    const mock = fakeSpawn()
    await sendCodex(sendRequest({ reasoningEffort: effort }), { execFileImpl: metadata().run, spawnImpl: mock.spawnImpl })
    assert.equal(mock.calls[0].args.filter(value => value.startsWith('model_reasoning_effort=')).length, 1)
    assert.ok(mock.calls[0].args.includes(`model_reasoning_effort=${JSON.stringify(effort || 'medium')}`))
  }
})

test('Codex check uses bounded no-shell metadata and reports only sanitized ChatGPT account state', async () => {
  const mock = metadata()
  const result = await inspectCodex({}, { execFileImpl: mock.run })
  assert.equal(result.available, true)
  assert.equal(result.authMode, 'chatgpt')
  assert.equal(mock.calls.length, 5)
  assert.ok(mock.calls.every(call => call.options.shell === false && call.options.maxBuffer === (call.args.includes('models') ? 4 * 1024 * 1024 : 128 * 1024) && call.options.timeout === (call.args.includes('models') ? 4000 : 6000)))
  assert.ok(mock.calls.every(call => !call.args.includes('app-server') && !call.args.includes('start')))
  assert.deepEqual(result.models, [{ id: 'sample-chat-model', displayName: 'Sample Chat Model' }])
  assert.equal(result.modelCatalogStatus, 'available')
  const api = await inspectCodex({}, { execFileImpl: metadata({ auth: 'Logged in using an API key - sk-private-prefix' }).run })
  assert.equal(api.available, false)
  assert.equal(api.code, 'CODEX_CHATGPT_REQUIRED')
  assert.equal(api.modelCatalogStatus, 'not-requested')
  assert.doesNotMatch(JSON.stringify(api), /sk-private/)
  assert.equal((await inspectCodex({}, { execFileImpl: metadata({ auth: 'Not logged in' }).run })).available, false)
  assert.equal((await inspectCodex({}, { execFileImpl: metadata({ missing: true }).run })).code, 'CODEX_NOT_FOUND')
})

test('metadata termination signals are launch diagnostics, not unsupported CLI or invented signature failures', async () => {
  for (const signal of ['SIGKILL', 'SIGTERM']) {
    for (const killed of [false, true]) {
      let calls = 0
      const result = await inspectCodex({}, { execFileImpl: (_file, _args, _options, done) => {
        calls++
        done(Object.assign(new Error('private launch diagnostic /Users/Private/token'), { signal, killed, code: null }), 'sk-private-output', 'secret stderr')
      } })
      assert.equal(result.code, 'CODEX_PROCESS_TERMINATED')
      assert.equal(result.available, false)
      assert.equal(result.installed, true)
      assert.deepEqual(result.models, [])
      assert.equal(calls, 1, 'do not continue metadata checks or run an agent after termination')
      assert.doesNotMatch(JSON.stringify(result), /signature|private launch|Private|token|sk-private|secret stderr|SIGKILL|SIGTERM/i)
    }
  }
})

test('metadata launch failures keep safe error codes without leaking native error messages', async () => {
  for (const [nativeCode, expectedCode] of [
    ['ENOENT', 'CODEX_NOT_FOUND'], ['EACCES', 'CODEX_LAUNCH_FAILED'], ['EPERM', 'CODEX_LAUNCH_FAILED'],
    ['ENOEXEC', 'CODEX_LAUNCH_FAILED'], ['UNKNOWN', 'CODEX_LAUNCH_FAILED'], ['ETIMEDOUT', 'CODEX_CHECK_TIMEOUT'],
  ]) {
    for (const synchronous of [false, true]) {
      const result = await inspectCodex({}, { execFileImpl: (_file, _args, _options, done) => {
        const failure = Object.assign(new Error('private exception /Users/Secret sk-fixture-token'), { code: nativeCode })
        if (synchronous) throw failure
        done(failure, 'private stdout', 'private stderr')
      } })
      assert.equal(result.code, expectedCode)
      assert.equal(result.available, false)
      assert.equal(result.installed, nativeCode !== 'ENOENT')
      assert.doesNotMatch(JSON.stringify(result), /private|Secret|sk-fixture|exception/)
    }
  }
})

test('metadata timeout is bounded and distinct from a non-timeout signal, including late callbacks', async () => {
  const kills = []; let calls = 0; let callback
  const result = await inspectCodex({}, { timeoutMs: 5, execFileImpl: (_file, _args, options, done) => {
    calls++; callback = done
    assert.equal(options.timeout, 5)
    return { kill: signal => {
      kills.push(signal)
      done(Object.assign(new Error('private timeout'), { killed: true, signal }), 'private stdout', 'private stderr')
      return true
    } }
  } })
  assert.equal(result.code, 'CODEX_CHECK_TIMEOUT')
  assert.equal(result.available, false)
  assert.equal(calls, 1)
  assert.deepEqual(kills, ['SIGKILL'])
  assert.doesNotMatch(JSON.stringify(result), /private|signature/i)
  callback(null, 'codex-cli 0.160.1', '')
  assert.equal(calls, 1, 'late completion cannot revive an expired check')
})

test('synchronous metadata completion clears its watchdog before a returned child can be killed', async () => {
  const mock = metadata(); const kills = []
  const result = await inspectCodex({}, { timeoutMs: 5, execFileImpl: (file, args, options, done) => {
    mock.run(file, args, options, done)
    return { kill: signal => kills.push(signal) }
  } })
  assert.equal(result.available, true)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.deepEqual(kills, [])
})

test('metadata cancellation stays cancellation and clears the watchdog', async () => {
  for (const alreadyAborted of [false, true]) {
    const controller = new AbortController(); const kills = []; let calls = 0
    if (alreadyAborted) controller.abort()
    const pending = inspectCodex({}, { signal: controller.signal, timeoutMs: 5, execFileImpl: (_file, _args, options, done) => {
      calls++
      assert.equal(options.signal, controller.signal)
      controller.abort()
      done(Object.assign(new Error('private abort'), { code: 'ABORT_ERR', signal: 'SIGTERM', killed: true }), '', '')
      return { kill: signal => kills.push(signal) }
    } })
    await assert.rejects(pending, { code: 'CANCELLED' })
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal(calls, alreadyAborted ? 0 : 1)
    assert.deepEqual(kills, [])
  }
})

test('ordinary command exit failures retain compatibility checks but failed version is a launch failure', async () => {
  for (const [stage, expectedCode] of [
    ['--version', 'CODEX_LAUNCH_FAILED'], ['--help', 'CODEX_UNSUPPORTED'], ['features', 'CODEX_ISOLATION_UNAVAILABLE'],
  ]) {
    const mock = metadata()
    const result = await inspectCodex({}, { execFileImpl: (file, args, options, done) => {
      if (args.includes(stage)) done(Object.assign(new Error('private unsupported command'), { code: 2, signal: null, killed: false }), 'private stdout', 'private stderr')
      else mock.run(file, args, options, done)
    } })
    assert.equal(result.code, expectedCode)
    assert.doesNotMatch(JSON.stringify(result), /private|stdout|stderr/)
  }
  const result = await inspectCodex({}, { execFileImpl: (_file, _args, _options, done) => done(null, 'not-the-codex-cli', '') })
  assert.equal(result.code, 'CODEX_UNSUPPORTED', 'a successful but unrecognized version response is not a spawn failure')
})

test('real synthetic metadata process respects timeout without running Codex or a model', async () => {
  let child
  const result = await inspectCodex({}, { timeoutMs: 30, execFileImpl: (_file, _args, options, done) => {
    child = execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options, done)
    return child
  } })
  assert.equal(result.code, 'CODEX_CHECK_TIMEOUT')
  if (child.exitCode === null && !child.signalCode) await new Promise(resolve => child.once('close', resolve))
  assert.ok(child.exitCode !== null || child.signalCode, 'the owned metadata process must be stopped')
})

test('real synthetic metadata process abort remains cancellation and stops its child', async () => {
  const controller = new AbortController(); let child
  const pending = inspectCodex({}, { signal: controller.signal, timeoutMs: 100, execFileImpl: (_file, _args, options, done) => {
    child = execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options, done)
    return child
  } })
  controller.abort()
  await assert.rejects(pending, { code: 'CANCELLED' })
  if (child.exitCode === null && !child.signalCode) await new Promise(resolve => child.once('close', resolve))
  assert.ok(child.exitCode !== null || child.signalCode)
})

test('connection, model discovery and restricted turns use one native-resolved executable with spaces', async () => {
  const executablePath = path.join(os.tmpdir(), 'Trusted Codex Install', 'codex')
  const check = metadata()
  assert.equal((await inspectCodex({}, { executablePath, execFileImpl: check.run })).available, true)
  assert.ok(check.calls.every(call => call.file === executablePath && call.options.shell === false))
  const meta = metadata(), model = fakeSpawn()
  await sendCodex(sendRequest({ executablePath: '/untrusted/payload' }), { executablePath, execFileImpl: meta.run, spawnImpl: model.spawnImpl })
  assert.ok(meta.calls.every(call => call.file === executablePath))
  assert.equal(model.calls[0].file, executablePath)
  assert.equal(model.calls[0].options.shell, false)
  for (const bad of ['codex --flag', '../relative/codex', '/bad\nname']) {
    await assert.rejects(sendCodex(sendRequest(), { executablePath: bad, execFileImpl: meta.run, spawnImpl: model.spawnImpl }), { code: 'CODEX_EXECUTABLE_INVALID' })
  }
})

test('Windows environment keeps case-insensitive PATH and system keys without inheriting credentials', () => {
  const environment = childEnvironment({ Path: 'C:\\Tools;C:\\Windows', UserProfile: 'C:\\Users\\Editor', systemroot: 'C:\\Windows',
    openai_api_key: 'never-copy', OPENAI_BASE_URL: 'https://invalid.test', PRIVATE_TOKEN: 'never-copy' }, 'win32')
  assert.equal(environment.PATH, 'C:\\Tools;C:\\Windows')
  assert.equal(environment.USERPROFILE, 'C:\\Users\\Editor')
  assert.equal(environment.SystemRoot, 'C:\\Windows')
  assert.equal(Object.keys(environment).filter(key => key.toLowerCase() === 'systemroot').length, 1)
  assert.doesNotMatch(JSON.stringify(environment), /never-copy|invalid.test/)
})

test('catalog normalization uses visible ordinary models, catalog ordering, deduplication, and a metadata-only projection', () => {
  const result = normalizeCodexModels({ models: [
    { slug: 'later-model', display_name: ' Later\nModel\u202e ', description: 'Helpful\u0000\u2066 model', visibility: 'list', priority: 9, base_instructions: 'private prompt', model_messages: { internal: 'do not expose' }, is_default: false },
    { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide', priority: 0 },
    { slug: 'special-model', visibility: 'list', model_specialty: 'specialized', priority: 0 },
    { slug: 'first-model', display_name: 'First Model', visibility: 'list', priority: 1, is_default: true },
    { slug: 'first-model', display_name: 'Duplicate', visibility: 'list', priority: 2 },
    { slug: 'unknown-visibility', display_name: 'Unknown' },
    { slug: '--invalid-flag', visibility: 'list' },
    { slug: 'bad\nidentifier', visibility: 'list' },
    { slug: 'missing-label', visibility: 'list' },
  ] })
  assert.deepEqual(result, [
    { id: 'first-model', displayName: 'First Model', isDefault: true },
    { id: 'later-model', displayName: 'Later Model', description: 'Helpful model', isDefault: false },
    { id: 'missing-label', displayName: 'missing-label' },
  ])
  assert.doesNotMatch(JSON.stringify(result), /private prompt|do not expose|base_instructions|model_messages/)
  assert.throws(() => normalizeCodexModels({ models: [] }))
  assert.throws(() => normalizeCodexModels({ data: [] }))
  assert.throws(() => normalizeCodexModels({ models: Array(1001).fill({}) }))
  const bounded = normalizeCodexModels({ models: Array.from({ length: 150 }, (_, index) => ({ slug: `test-${index}`, display_name: 'x'.repeat(1000), description: 'y'.repeat(2000), visibility: 'list' })) })
  assert.equal(bounded.length, 100)
  assert.equal(bounded[0].displayName.length, 160)
  assert.equal(bounded[0].description.length, 600)
})

test('model discovery is one bounded no-shell metadata command with no prompts or integrations', async () => {
  const mock = metadata(); const controller = new AbortController()
  const result = await readCodexModels({ execFileImpl: mock.run, signal: controller.signal, environment: { PATH: '/test', HOME: '/synthetic' } })
  assert.equal(result.modelCatalogStatus, 'available')
  assert.equal(mock.calls.length, 1)
  const call = mock.calls[0]
  assert.deepEqual(call.args.slice(-2), ['debug', 'models'])
  assert.ok(!call.args.includes('exec') && !call.args.includes('app-server') && !call.args.includes('--bundled'))
  assert.ok(call.args.includes('mcp_servers={}') && call.args.includes('approval_policy="never"'))
  assert.ok(call.args.includes('features.code_mode={enabled=false,excluded_tool_namespaces=["functions","clock"]}'))
  assert.equal(call.options.signal, controller.signal)
  assert.equal(call.options.timeout, 4000)
  assert.equal(call.options.maxBuffer, 4 * 1024 * 1024)
  assert.equal(call.options.cwd, os.tmpdir())
  assert.deepEqual(call.options.env, { PATH: '/test', HOME: '/synthetic' })
})

test('catalog failure keeps the connected account available without leaking diagnostics or suppressing custom/default models', async () => {
  for (const options of [
    { catalog: 'not-json private data' },
    { catalog: { models: [] } },
    { catalog: { models: [{ slug: 'hidden', visibility: 'hide' }] } },
    { catalogFailure: Object.assign(new Error('private account diagnostic'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) },
    { catalogFailure: Object.assign(new Error('private timeout diagnostic'), { killed: true, signal: 'SIGTERM' }) },
    { catalogFailure: Object.assign(new Error('private unsupported-command diagnostic'), { code: 2 }) },
    { catalog: 'x'.repeat(4 * 1024 * 1024 + 1) },
  ]) {
    const result = await inspectCodex({}, { execFileImpl: metadata(options).run })
    assert.equal(result.available, true)
    assert.equal(result.authMode, 'chatgpt')
    assert.equal(result.modelCatalogStatus, 'unavailable')
    assert.deepEqual(result.models, [])
    assert.match(result.modelCatalogError, /default or enter a custom model ID/)
    assert.doesNotMatch(JSON.stringify(result), /private|Private|account diagnostic/)
  }
  const unsigned = metadata({ auth: 'Not logged in' })
  await inspectCodex({}, { execFileImpl: unsigned.run })
  assert.ok(unsigned.calls.every(call => !call.args.includes('models')))
})

test('optional catalog discovery respects the remaining IPC inspection budget', async () => {
  const limited = metadata()
  const result = await inspectCodex({}, { execFileImpl: limited.run, inspectTimeoutMs: 500 })
  assert.equal(result.available, true)
  assert.equal(result.modelCatalogStatus, 'available')
  const catalog = limited.calls.find(call => call.args.includes('models'))
  assert.ok(catalog.options.timeout > 0 && catalog.options.timeout <= 250)
  const expired = metadata()
  const fallback = await inspectCodex({}, { execFileImpl: expired.run, inspectTimeoutMs: 100 })
  assert.equal(fallback.available, true)
  assert.equal(fallback.modelCatalogStatus, 'unavailable')
  assert.equal(expired.calls.length, 4, 'do not start optional discovery with no remaining budget')
})

test('catalog cancellation is not disguised as a successful connection warning', async () => {
  const controller = new AbortController()
  const execFileImpl = (_file, _args, _options, done) => { controller.abort(); done(new Error('cancelled'), '', '') }
  await assert.rejects(readCodexModels({ execFileImpl, signal: controller.signal }), { code: 'CANCELLED' })
})

test('preflight fails closed for unsupported flags, missing feature gates, or enabled capabilities', async () => {
  assert.equal(verifiedFeatures(featureOutput), true, 'unified_exec is an engine selector, not the shell access gate')
  assert.equal(verifiedFeatures(featureOutput.replace('shell_tool stable false', 'shell_tool stable true')), false)
  assert.equal(verifiedFeatures(featureOutput.replace('plugins stable false', '')), false)
  await assert.rejects(preflightCodex({ execFileImpl: metadata({ help: '--json --sandbox' }).run }), { code: 'CODEX_UNSUPPORTED' })
  await assert.rejects(preflightCodex({ execFileImpl: metadata({ featureText: featureOutput.replace('hooks stable false', 'hooks stable true') }).run }), { code: 'CODEX_ISOLATION_UNAVAILABLE' })
  assert.equal(verifiedFeatures(featureOutput, { toolsEnabled: true }), false, 'tool mode requires the local code host used by supported models')
  await preflightCodex({ toolsEnabled: true, execFileImpl: metadata().run })
  await assert.rejects(preflightCodex({ toolsEnabled: true, execFileImpl: metadata({ featureText: featureOutput }).run }), { code: 'CODEX_ISOLATION_UNAVAILABLE' })
})

test('child environment cannot inherit API billing, provider redirection, remote sockets or arbitrary secrets', () => {
  const env = childEnvironment({ PATH: '/test', HOME: '/home/test', CODEX_HOME: '/home/test/.codex', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', OPENAI_BASE_URL: 'http://remote', CODEX_REMOTE_HOST: 'remote', AWS_SECRET_ACCESS_KEY: 'secret', UNRELATED_SECRET: 'secret' })
  assert.deepEqual(env, { PATH: '/test', HOME: '/home/test', CODEX_HOME: '/home/test/.codex' })
})

test('send uses ephemeral no-config no-rules read-only session; only temporary attachments and stdin prompt', async () => {
  const mock = fakeSpawn(); const events = []
  const response = await sendCodex(sendRequest({ model: 'chosen-model', images: [{ label: '../view', dataUrl: 'data:image/jpeg;base64,YQ==' }], documents: [{ name: 'workflow.json', text: '{"fixture":"ATTACHED_JSON_DATA"}' }] }), { execFileImpl: metadata().run, spawnImpl: mock.spawnImpl, onEvent: event => events.push(event), environment: { PATH: '/test' } })
  assert.deepEqual(response, { success: true, text: 'Review [[shot:shot-one]].' })
  const call = mock.calls[0]
  for (const flag of REQUIRED_FLAGS) assert.ok(call.args.includes(flag), flag)
  assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only')
  assert.ok(call.args.includes('approval_policy="never"'))
  assert.ok(call.args.includes('forced_login_method="chatgpt"'))
  assert.ok(call.args.includes('mcp_servers={}'))
  assert.ok(call.args.includes('project_doc_max_bytes=0'))
  for (const feature of REQUIRED_FEATURES.filter(name => name !== 'code_mode')) assert.ok(call.args.some((arg, index) => arg === '--disable' && call.args[index + 1] === feature), feature)
  assert.ok(call.args.includes('features.code_mode={enabled=false,excluded_tool_namespaces=["functions","clock"]}'))
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'chosen-model')
  assert.equal(call.args.at(-1), '-')
  assert.equal(call.options.shell, false)
  assert.deepEqual(call.options.env, { PATH: '/test' })
  assert.ok(call.options.cwd.startsWith(path.join(os.tmpdir(), 'velorn-conversation-')))
  const attachment = call.args[call.args.indexOf('--image') + 1]
  assert.equal(path.dirname(attachment), call.options.cwd)
  assert.equal(path.basename(attachment), 'view-0.jpg')
  assert.match(call.prompt, /shot-one/)
  assert.match(call.prompt, /ATTACHED_JSON_DATA/)
  assert.match(call.prompt, /untrusted data/)
  assert.match(call.prompt, /natural prose and readable Markdown/)
  assert.match(call.prompt, /not a response schema/)
  assert.match(call.prompt, /explicitly requests JSON/)
  assert.equal(call.args.includes('--output-schema'), false)
  assert.equal(call.args.some(value => value.includes('ATTACHED_JSON_DATA')), false)
  assert.equal(call.args.includes('Review the shot.'), false)
  await assert.rejects(fs.stat(call.options.cwd), { code: 'ENOENT' })
  assert.ok(events.some(event => event.type === 'delta'))
})

test('restricted Codex preserves explicitly requested JSON reply text and exact custom model', async () => {
  const artifact = '{"opinion":"Keep the vocal","musicPrompt":"Quiet piano","importantNote":"JSON was requested"}'
  const mock = fakeSpawn({ events: [
    { type: 'thread.started', thread_id: 't1' }, { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'json-artifact', type: 'agent_message', text: artifact } },
    { type: 'turn.completed' },
  ] })
  const result = await sendCodex(sendRequest({ model: 'user-custom-model',
    messages: [{ role: 'user', content: 'Return the music brief as JSON.' }] }), {
    execFileImpl: metadata().run, spawnImpl: mock.spawnImpl, instructions: 'Discuss only the supplied project.',
  })
  assert.equal(result.text, artifact)
  assert.equal(mock.calls[0].args[mock.calls[0].args.indexOf('--model') + 1], 'user-custom-model')
  assert.match(mock.calls[0].prompt, /natural prose and readable Markdown/)
  assert.match(mock.calls[0].prompt, /Return the music brief as JSON/)
  assert.equal(mock.calls[0].args.includes('--output-schema'), false)
})

test('send marks initial signed-out and wrong-auth failures without creating a model process', async () => {
  const { codexPromptWasNotSent } = require('../electron/connectedAgentCodexAuth.cjs')
  const mock = fakeSpawn()
  for (const [auth, code] of [['Not logged in', 'CODEX_LOGIN_REQUIRED'], ['Logged in using an API key - sk-secret', 'CODEX_CHATGPT_REQUIRED']]) {
    await assert.rejects(sendCodex(sendRequest(), { execFileImpl: metadata({ auth }).run, spawnImpl: mock.spawnImpl }), error => {
      assert.equal(error.code, code)
      assert.equal(codexPromptWasNotSent(error), true)
      assert.doesNotMatch(error.message, /sk-secret/)
      return true
    })
  }
  assert.equal(mock.calls.length, 0)
})

test('send refuses API-key authentication and invalid CLI before creating a model process', async () => {
  const mock = fakeSpawn()
  await assert.rejects(sendCodex(sendRequest(), { execFileImpl: metadata({ auth: 'Logged in using an API key - sk-secret' }).run, spawnImpl: mock.spawnImpl }), { code: 'CODEX_CHATGPT_REQUIRED' })
  await assert.rejects(sendCodex(sendRequest(), { execFileImpl: metadata({ help: '' }).run, spawnImpl: mock.spawnImpl }), { code: 'CODEX_UNSUPPORTED' })
  assert.equal(mock.calls.length, 0)
})

test('Codex JSONL tolerates chunk boundaries, ignores reasoning, and rejects malformed/tool/oversized events', () => {
  const output = []; let failure
  const reader = createProtocolReader({ onEvent: event => output.push(event), onFailure: problem => { failure = problem }, onComplete: () => {} })
  const message = line({ type: 'item.completed', item: { type: 'agent_message', id: 'a', text: 'Visible reply' } })
  reader.push(line({ type: 'item.completed', item: { type: 'error', message: 'Private startup notice' } }))
  reader.push(line({ type: 'item.completed', item: { type: 'reasoning', id: 'r', text: 'Hidden' } }))
  reader.push(message.slice(0, 10)); reader.push(message.slice(10)); reader.push(message)
  reader.push(line({ type: 'turn.completed' }))
  assert.deepEqual(reader.finish(), { success: true, text: 'Visible reply' })
  assert.equal(failure, undefined)
  assert.equal(output.length, 1)
  for (const [event, expected] of [
    [line({ type: 'item.started', item: { type: 'command_execution' } }), 'CODEX_TOOLS_DISABLED'],
    [line({ type: 'item.started', item: { type: 'mcp_tool_call' } }), 'CODEX_TOOLS_DISABLED'],
    ['not-json\n', 'CODEX_PROTOCOL_ERROR'],
    ['x'.repeat(130 * 1024), 'RESPONSE_TOO_LARGE'],
  ]) {
    let problem
    const rejected = createProtocolReader({ onEvent: () => {}, onComplete: () => {}, onFailure: value => { problem = value } })
    rejected.push(event)
    assert.equal(problem.code, expected)
  }
})

test('unexpected Codex tools and cancellation terminate the owned process and clean attachments', async () => {
  const forbidden = fakeSpawn({ events: [{ type: 'item.started', item: { type: 'file_change' } }] })
  await assert.rejects(sendCodex(sendRequest(), { execFileImpl: metadata().run, spawnImpl: forbidden.spawnImpl }), { code: 'CODEX_TOOLS_DISABLED' })
  assert.equal(forbidden.calls[0].kills[0], 'SIGTERM')
  const pending = fakeSpawn({ pending: true }); const controller = new AbortController()
  const result = sendCodex(sendRequest(), { execFileImpl: metadata().run, spawnImpl: pending.spawnImpl, signal: controller.signal })
  while (!pending.calls.length) await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(result, { code: 'CANCELLED' })
  assert.equal(pending.calls[0].kills[0], 'SIGTERM')
  await assert.rejects(fs.stat(pending.calls[0].options.cwd), { code: 'ENOENT' })
})

test('Codex tool session replaces MCP configuration and keeps credentials only in child env', async () => {
  const mock = fakeSpawn(); let listed = 0
  const toolSession = { listTools: async () => { listed++; return [{ name: 'inspect_project', inputSchema: { type: 'object', properties: {} } }] }, callTool: async () => ({ content: [] }) }
  await sendCodex(sendRequest(), { execFileImpl: metadata().run, spawnImpl: mock.spawnImpl, toolSession, environment: { PATH: '/test' } })
  const call = mock.calls[0]
  assert.equal(listed, 1)
  const config = call.args.find(value => value.startsWith('mcp_servers='))
  assert.match(config, /^mcp_servers=\{velorn_session=\{url="http:\/\/127\.0\.0\.1:\d+\/mcp"/)
  assert.equal(call.args.filter(value => value.startsWith('mcp_servers=')).length, 1)
  assert.ok(call.args.includes('features.code_mode={enabled=true,excluded_tool_namespaces=["functions","clock"]}'))
  assert.equal(call.args[call.args.indexOf('code_mode_host') - 1], '--enable')
  for (const feature of REQUIRED_FEATURES.filter(name => !['code_mode', 'code_mode_host'].includes(name))) assert.ok(call.args.some((arg, index) => arg === '--disable' && call.args[index + 1] === feature), feature)
  const tokenKey = Object.keys(call.options.env).find(key => key.startsWith('VELORN_AGENT_MCP_'))
  assert.ok(tokenKey)
  assert.match(config, new RegExp(tokenKey))
  assert.equal(JSON.stringify(call.args).includes(call.options.env[tokenKey]), false)
  for (const flag of ['--ignore-user-config', '--ignore-rules']) assert.ok(call.args.includes(flag))
  const url = /url="([^"]+)"/.exec(config)[1]
  await assert.rejects(fetch(url))
})

test('Codex accepts only explicitly scoped Velorn MCP events; foreign and execution tools stop the turn', () => {
  const events = []; const failures = []
  const reader = createProtocolReader({ onEvent: event => events.push(event), onFailure: error => failures.push(error), onComplete: () => {}, allowedMcpServer: 'velorn_session', allowedToolNames: new Set(['inspect_project']) })
  reader.push(line({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'velorn_session', tool: 'inspect_project' } }))
  reader.push(line({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'velorn_session', tool: 'inspect_project', result: { private: 'not displayed' } } }))
  reader.push(line({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'velorn_session', tool: 'inspect_project', result: { content: [{ type: 'image', data: 'a'.repeat(200 * 1024), mimeType: 'image/png' }] } } }))
  reader.push(line({ type: 'item.completed', item: { type: 'agent_message', id: 'a', text: 'Inspected.' } }))
  reader.push(line({ type: 'turn.completed' }))
  assert.equal(reader.finish().text, 'Inspected.')
  assert.equal(failures.length, 0)
  assert.doesNotMatch(JSON.stringify(events), /private|not displayed/)
  for (const item of [{ type: 'mcp_tool_call', server: 'other_server', tool: 'inspect_project' }, { type: 'mcp_tool_call', server: 'velorn_session', tool: 'shell' }, { type: 'command_execution' }]) {
    let failure
    const invalid = createProtocolReader({ onEvent: () => {}, onComplete: () => {}, onFailure: error => { failure = error }, allowedMcpServer: 'velorn_session', allowedToolNames: new Set(['inspect_project']) })
    invalid.push(line({ type: 'item.started', item }))
    assert.equal(failure.code, 'CODEX_TOOLS_DISABLED')
  }
})

test('optional installed-CLI audit advertises no execution tools to a synthetic local endpoint', { skip: process.env.VELORN_CODEX_LOCAL_PROBE !== '1', timeout: 30000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-codex-tools-probe-'))
  const requests = []
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end('{}')
      return
    }
    let body = ''
    request.on('data', chunk => { body += chunk; if (body.length > 2e6) request.destroy() })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Local safety audit complete', type: 'invalid_request_error' } }))
    })
  })
  let child; let timer
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', ...restrictionArgs(), '-c', 'model_provider="velorn_probe"', '-c', 'model="velorn-probe"', '-c', 'model_providers.velorn_probe.name="Velorn local safety audit"', '-c', `model_providers.velorn_probe.base_url="http://127.0.0.1:${server.address().port}/v1"`, '-c', 'model_providers.velorn_probe.wire_api="responses"', '-c', 'model_providers.velorn_probe.requires_openai_auth=false', '-']
    child = spawn('codex', args, { cwd: directory, env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    child.stdout.resume(); child.stderr.resume()
    child.stdin.end('Synthetic local safety audit. Reply hello; no tools.')
    timer = setTimeout(() => child.kill('SIGKILL'), 20000)
    await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
    assert.equal(requests.length, 1)
    const names = requests[0].tools.map(tool => tool.name || tool.type)
    assert.ok(names.every(name => name === 'request_user_input'), `Unexpected exposed capabilities: ${names.join(', ')}`)
    assert.ok(requests[0].tools.every(tool => !tool.tools))
  } finally {
    clearTimeout(timer)
    if (child?.exitCode === null) child.kill('SIGKILL')
    await new Promise(resolve => server.close(resolve))
    try { await fs.rmdir(directory) } catch {}
  }
})

test('optional installed-CLI audit exposes all session MCP tools and no host execution tools', { skip: process.env.VELORN_CODEX_LOCAL_PROBE !== '1', timeout: 30000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-codex-mcp-probe-'))
  const catalog = Array.from({ length: 162 }, (_, i) => ({ name: `velorn_tool_${i}`, description: 'Synthetic Velorn safety-audit tool', inputSchema: { type: 'object', properties: {} } }))
  let dispatched = 0
  const gateway = await createMcpGateway({ toolSession: { listTools: async () => catalog, callTool: async () => { dispatched++; return { content: [] } } } })
  const requests = []
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') { response.writeHead(404); response.end(); return }
    let body = ''
    request.on('data', chunk => { body += chunk; if (body.length > 2e6) request.destroy() })
    request.on('end', () => { requests.push(JSON.parse(body)); response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Local safety audit complete', type: 'invalid_request_error' } })) })
  })
  let child; let timer
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', ...restrictionArgs(gateway), '-c', 'model_provider="velorn_probe"', '-c', 'model="velorn-probe"', '-c', 'model_providers.velorn_probe.name="Velorn local MCP audit"', '-c', `model_providers.velorn_probe.base_url="http://127.0.0.1:${server.address().port}/v1"`, '-c', 'model_providers.velorn_probe.wire_api="responses"', '-c', 'model_providers.velorn_probe.requires_openai_auth=false', '-']
    child = spawn('codex', args, { cwd: directory, env: { ...childEnvironment(), [gateway.tokenEnvVar]: gateway.bearerToken }, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    child.stdout.resume(); child.stderr.resume(); child.stdin.end('Synthetic local MCP safety audit. Do not call tools.')
    timer = setTimeout(() => child.kill('SIGKILL'), 20000)
    await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
    assert.equal(requests.length, 1)
    const names = requests[0].tools.flatMap(tool => tool.tools ? tool.tools.map(nested => `${tool.name}__${nested.name}`) : [tool.name || tool.type])
    const expected = new Set(catalog.map(tool => `mcp__velorn_session__${tool.name}`))
    assert.equal(names.filter(name => expected.has(name)).length, catalog.length, `Incomplete MCP catalog: ${names.join(', ')}`)
    assert.ok(names.every(name => expected.has(name) || ['exec', 'wait', 'request_user_input', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(name)), `Unexpected tool: ${names.join(', ')}`)
    assert.equal(dispatched, 0)
  } finally {
    clearTimeout(timer)
    if (child?.exitCode === null) child.kill('SIGKILL')
    await gateway.close(); await new Promise(resolve => server.close(resolve))
    try { await fs.rmdir(directory) } catch {}
  }
})

test('optional installed-CLI synthetic response dispatches an action only through the session gateway', { skip: process.env.VELORN_CODEX_LOCAL_PROBE !== '1', timeout: 30000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-codex-dispatch-probe-'))
  const calls = []; const requests = []; const events = []
  const gateway = await createMcpGateway({ toolSession: {
    listTools: async () => [{ name: 'synthetic_edit', description: 'Synthetic tool; has no real editor or filesystem access.', annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, inputSchema: { type: 'object', properties: {} } }],
    callTool: async (name, args) => { calls.push({ name, args }); return { isError: true, content: [{ type: 'text', text: 'Synthetic host approval denied. No action occurred.' }] } },
  } })
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') { response.writeHead(404); response.end(); return }
    let body = ''
    request.on('data', chunk => { body += chunk; if (body.length > 2e6) request.destroy() })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      if (requests.length > 1) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Synthetic dispatch audit complete', type: 'invalid_request_error' } })); return }
      const item = { id: 'fc_synthetic', type: 'function_call', namespace: 'mcp__velorn_session', name: 'synthetic_edit', call_id: 'call_synthetic', arguments: '{}', status: 'completed' }
      const value = { id: 'resp_synthetic', object: 'response', created_at: 1, status: 'completed', model: 'velorn-probe', output: [item] }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const event of [{ type: 'response.created', response: { ...value, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: value }]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      response.end()
    })
  })
  let child; let timer
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', ...restrictionArgs(gateway), '-c', 'model_provider="velorn_probe"', '-c', 'model="velorn-probe"', '-c', 'model_providers.velorn_probe.name="Velorn synthetic dispatch audit"', '-c', `model_providers.velorn_probe.base_url="http://127.0.0.1:${server.address().port}/v1"`, '-c', 'model_providers.velorn_probe.wire_api="responses"', '-c', 'model_providers.velorn_probe.requires_openai_auth=false', '-']
    child = spawn('codex', args, { cwd: directory, env: { ...childEnvironment(), [gateway.tokenEnvVar]: gateway.bearerToken }, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    let output = ''
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; if (output.length > 2e6) child.kill('SIGKILL') }); child.stderr.resume()
    child.stdin.end('Synthetic localhost audit; the synthetic tool has no side effects.')
    timer = setTimeout(() => child.kill('SIGKILL'), 20000)
    await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
    for (const line of output.trim().split('\n')) { try { events.push(JSON.parse(line)) } catch {} }
    assert.deepEqual(calls, [{ name: 'synthetic_edit', args: {} }], JSON.stringify({ events, outputs: requests[1]?.input?.filter(item => item.type === 'function_call_output') }))
    assert.equal(requests.length, 2)
    const toolEvents = events.filter(event => event.item?.type === 'mcp_tool_call')
    assert.ok(toolEvents.length >= 2)
    assert.ok(toolEvents.every(event => event.item.server === gateway.serverName && event.item.tool === 'synthetic_edit'))
    assert.match(JSON.stringify(requests[1].input), /Synthetic host approval denied/)
  } finally {
    clearTimeout(timer)
    if (child?.exitCode === null) child.kill('SIGKILL')
    await gateway.close(); await new Promise(resolve => server.close(resolve))
    try { await fs.rmdir(directory) } catch {}
  }
})

// Unlike the fallback-model probes above, this exercises the supported model's
// actual additional_tools / custom functions.exec wire format through sendCodex.
// The Responses server and MCP dispatcher are synthetic and strictly localhost.
async function knownModelProbe({ script, toolSession, item, signal, onEvent, configureArgs = args => args } = {}) {
  const requests = []; const events = []
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/responses') { response.writeHead(404); response.end(); return }
    let body = ''
    request.on('data', chunk => { body += chunk; if (body.length > 4e6) request.destroy() })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      const output = requests.length === 1
        ? item || { id: 'ct_probe', type: 'custom_tool_call', namespace: 'functions', name: 'exec', call_id: 'call_probe', input: script, status: 'completed' }
        : { id: 'msg_probe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic routing audit complete.' }] }
      const value = { id: `resp_probe_${requests.length}`, object: 'response', created_at: 1, status: 'completed', model: 'gpt-6-astra', output: [output] }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const event of [{ type: 'response.created', response: { ...value, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item: output }, { type: 'response.output_item.done', output_index: 0, item: output }, { type: 'response.completed', response: value }]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      response.end()
    })
  })
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  const timeout = setTimeout(cancel, 20000)
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const response = await sendCodex(sendRequest({ model: 'gpt-6-astra' }), {
      toolSession, signal: controller.signal, execFileImpl: metadata().run,
      onEvent: event => { events.push(event); onEvent?.(event) },
      spawnImpl: (command, args, options) => spawn(command, configureArgs(args.slice(0, -1).concat([
        '-c', 'model_provider="velorn_probe"',
        '-c', 'model_providers.velorn_probe.name="Velorn localhost known-model audit"',
        '-c', `model_providers.velorn_probe.base_url="http://127.0.0.1:${server.address().port}/v1"`,
        '-c', 'model_providers.velorn_probe.wire_api="responses"',
        '-c', 'model_providers.velorn_probe.requires_openai_auth=false', '-',
      ])), options),
    })
    return { response, requests, events }
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); await new Promise(resolve => server.close(resolve)) }
}
function advertisedTools(request) {
  const tools = [...(request.tools || []), ...(request.input || []).filter(item => item.type === 'additional_tools').flatMap(item => item.tools || [])]
  return tools.flatMap(tool => tool.tools ? tool.tools.map(nested => ({ ...nested, qualifiedName: `${tool.name}.${nested.name}` })) : [{ ...tool, qualifiedName: tool.name }])
}
function probeOutput(request) {
  return JSON.stringify(request?.input?.filter(item => ['custom_tool_call_output', 'function_call_output'].includes(item.type)))
}
function probeObjects(request) {
  return (request?.input || []).filter(item => ['custom_tool_call_output', 'function_call_output'].includes(item.type))
    .flatMap(item => Array.isArray(item.output) ? item.output.map(block => block.text) : [item.output])
    .flatMap(text => { try { return [JSON.parse(text)] } catch { return [] } })
}
const knownCatalog = Array.from({ length: 162 }, (_, i) => ({ name: `velorn_tool_${i}`, description: 'Synthetic Velorn tool; no project or filesystem access.', inputSchema: { type: 'object', properties: {} } }))
const installedProbeOptions = { skip: process.env.VELORN_CODEX_LOCAL_PROBE !== '1', timeout: 30000 }

test('optional known-model code-mode route exposes the full Velorn-only inventory and preserves host denial', installedProbeOptions, async () => {
  await preflightCodex({ toolsEnabled: true })
  const calls = []
  const result = await knownModelProbe({
    script: 'text({inventory:ALL_TOOLS.map(tool=>tool.name)}); text(await tools.mcp__velorn_session__velorn_tool_161({}));',
    toolSession: { listTools: async () => knownCatalog, callTool: async (...args) => { calls.push(args); return { isError: true, content: [{ type: 'text', text: 'Synthetic host approval denied. No action occurred.' }] } } },
  })
  assert.equal(result.response.text, 'Synthetic routing audit complete.')
  assert.equal(result.requests.length, 2)
  assert.ok(result.requests[0].input.some(item => item.type === 'additional_tools'), 'must exercise supported model metadata, not unknown-model fallback')
  const visible = advertisedTools(result.requests[0])
  const exec = visible.find(tool => tool.qualifiedName === 'functions.exec')
  assert.ok(exec, 'use the actually advertised custom executor')
  assert.doesNotMatch(exec.description, /### `(?:apply_patch|exec_command|read_mcp_resource|clock__curr_time)`/)
  const output = probeOutput(result.requests[1])
  assert.doesNotMatch(output, /code-mode host is disabled/)
  assert.match(output, /Synthetic host approval denied/)
  const inventory = probeObjects(result.requests[1]).find(value => Array.isArray(value?.inventory))?.inventory
  assert.deepEqual(inventory?.slice().sort(), knownCatalog.map(tool => `mcp__velorn_session__${tool.name}`).sort())
  assert.deepEqual(calls, [['velorn_tool_161', {}]])
  assert.ok(result.events.some(event => event.type === 'status' && event.text.includes('velorn_tool_161')))
})

test('optional known-model runtime cannot reach builtin patch, shell, resource, filesystem, or network APIs', installedProbeOptions, async () => {
  let calls = 0
  const result = await knownModelProbe({
    script: `const blocked=[]; for(const name of ['apply_patch','exec_command','read_mcp_resource','clock__curr_time']) { try { await tools[name]({}); blocked.push(name+':ALLOWED'); } catch { blocked.push(name+':blocked'); } } let imports='ALLOWED'; try { await import('node:fs'); } catch { imports='blocked'; } text({inventory:ALL_TOOLS.map(tool=>tool.name),blocked,imports,globals:[typeof require,typeof process,typeof fetch,typeof WebSocket]});`,
    toolSession: { listTools: async () => knownCatalog.slice(0, 1), callTool: async () => { calls++; return { content: [] } } },
  })
  const output = probeOutput(result.requests[1])
  const report = probeObjects(result.requests[1]).find(value => Array.isArray(value?.inventory))
  assert.deepEqual(report?.inventory, ['mcp__velorn_session__velorn_tool_0'])
  assert.deepEqual(report?.globals, ['undefined', 'undefined', 'undefined', 'undefined'])
  assert.equal(report?.imports, 'blocked')
  assert.deepEqual(report?.blocked, ['apply_patch:blocked', 'exec_command:blocked', 'read_mcp_resource:blocked', 'clock__curr_time:blocked'])
  assert.doesNotMatch(output, /ALLOWED/)
  assert.ok(output.includes('undefined'))
  assert.equal(calls, 0)
})

test('optional known-model review mode omits builtin guidance and refuses the code host', installedProbeOptions, async () => {
  const result = await knownModelProbe({ script: 'text("REVIEW_EXECUTED_UNEXPECTEDLY");' })
  const exec = advertisedTools(result.requests[0]).find(tool => tool.qualifiedName === 'functions.exec')
  assert.ok(exec)
  assert.doesNotMatch(exec.description, /### `(?:apply_patch|exec_command|read_mcp_resource|clock__curr_time)`/)
  assert.match(probeOutput(result.requests[1]), /code-mode host is disabled/)
  assert.doesNotMatch(probeOutput(result.requests[1]), /REVIEW_EXECUTED_UNEXPECTEDLY/)
})

test('optional known-model unadvertised direct patch is blocked by read-only sandbox and never-approve policy', installedProbeOptions, async () => {
  // Namespace exclusion protects Code Mode's executor, not every registered
  // direct handler. The filesystem sandbox must still block an injected valid
  // patch even though that helper was not advertised to the model.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-direct-patch-denial-'))
  const marker = path.join(directory, 'must-not-exist.txt')
  let calls = 0
  try {
    const result = await knownModelProbe({
      item: { id: 'ct_patch', type: 'custom_tool_call', namespace: 'functions', name: 'apply_patch', call_id: 'call_patch', input: `*** Begin Patch\n*** Add File: ${marker}\n+Synthetic patch must be denied.\n*** End Patch`, status: 'completed' },
      toolSession: { listTools: async () => knownCatalog.slice(0, 1), callTool: async () => { calls++; return { content: [] } } },
    })
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' })
    assert.match(probeOutput(result.requests[1]), /patch rejected.*read-only sandbox/)
    assert.equal(calls, 0)
  } finally {
    // This path is exclusively owned by the synthetic test, even on failure.
    try { await fs.unlink(marker) } catch {}
    await fs.rmdir(directory)
  }
})
