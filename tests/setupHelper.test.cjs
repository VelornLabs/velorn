'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createSetupHelper, registerSetupHelperIpc, captureSetupHelperEnvironment, CHANNELS, MODEL, ENDPOINT, LIMITS, SETUP_GUIDES, ACTION_LABELS } = require('../electron/setupHelper.cjs')
const { createOptionalSetup } = require('../electron/optionalSetup.cjs')
const key = 'synthetic-private-key-do-not-send-to-renderer'
const env = { VELORN_SETUP_LUNA_ENABLED: '1', VELORN_SETUP_OPENAI_API_KEY: key }
const question = { integration: 'comfyui', message: 'Help me connect ComfyUI. Can you check it?' }
const answer = text => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] })
const call = (name, args, id = 'call_1') => ({ status: 'completed', output: [{ type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) }] })
const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
function setup(options = {}) {
  const requests = [], checks = [], replies = options.replies || [answer('I can help with that setup.')]
  const helper = createSetupHelper({ app: { isPackaged: false }, env, optionalSetup: { inspect: async payload => { checks.push(payload); return { success: true, integration: payload.integration, state: 'ready' } } },
    fetchImpl: async (url, request) => { requests.push({ url, request, body: JSON.parse(request.body) }); return json(replies.shift() || answer('Done.')) }, ...options })
  return { helper, requests, checks }
}
test('dedicated key is captured before main imports and cannot pass to inherited child environment', () => {
  const inherited = { ...env, UNRELATED_SETTING: 'preserve' }
  const captured = captureSetupHelperEnvironment(inherited)
  assert.equal(captured.VELORN_SETUP_OPENAI_API_KEY, key)
  assert.equal(Object.hasOwn(inherited, 'VELORN_SETUP_OPENAI_API_KEY'), false)
  assert.equal(inherited.UNRELATED_SETTING, 'preserve')
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', "process.stdout.write(String(Object.hasOwn(process.env, 'VELORN_SETUP_OPENAI_API_KEY')))"], { env: { ...inherited }, encoding: 'utf8' })
  assert.equal(child.status, 0); assert.equal(child.stdout, 'false')
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '../electron/main.js'), 'utf8')
  assert.ok(main.indexOf('captureSetupHelperEnvironment(process.env)') < main.indexOf("require('electron')"))
  assert.match(main, /createSetupHelper\(\{ app, optionalSetup, installedApps: setupInstalledApps, env: setupHelperEnvironment,/)
})
test('presence-only status is passive; packaged and generic key paths cannot enable Luna', async () => {
  for (const options of [{ app: { isPackaged: true } }, { env: { OPENAI_API_KEY: key } }, { env: { VELORN_SETUP_OPENAI_API_KEY: key } }, { app: undefined }, { env: {} }]) {
    const { helper, requests, checks } = setup(options)
    assert.equal(helper.status({}).available, false)
    assert.equal((await helper.send(question)).code, 'SETUP_HELPER_UNAVAILABLE')
    assert.deepEqual(requests, []); assert.deepEqual(checks, [])
  }
  const { helper, requests } = setup()
  assert.equal(helper.status({}).mode, 'internal-api')
  assert.equal(helper.status({}).model, MODEL)
  assert.doesNotMatch(JSON.stringify(helper.status({})), new RegExp(key))
  assert.deepEqual(requests, [])
})
test('strict ingress rejects model, endpoint, history, project and credential injection', async () => {
  const { helper, requests } = setup()
  for (const payload of [null, {}, { ...question, model: 'other' }, { ...question, endpoint: 'https://bad.test' }, { ...question, history: [] }, { ...question, project: '/private/project' },
    { ...question, integration: 'cloud' }, { ...question, message: ' ' }, { ...question, message: 'a'.repeat(4001) }]) assert.equal((await helper.send(payload)).code, 'SETUP_HELPER_INVALID')
  for (const message of [key, 'sk-proj-abcdefghijklmnopqrstuvwxyz', 'Bearer my-secret-token-for-testing']) assert.equal((await helper.send({ ...question, message })).code, 'SETUP_HELPER_SECRET')
  for (const method of ['status', 'cancel', 'reset']) assert.equal(helper[method]({ history: [] }).code, 'SETUP_HELPER_INVALID')
  assert.equal(requests.length, 0)
})
test('exact API boundary and stateless messages retain native-owned conversation only', async () => {
  const { helper, requests } = setup()
  assert.equal((await helper.send(question)).success, true)
  await helper.send({ ...question, message: 'What do I do next?' })
  assert.equal(requests.length, 2)
  const first = requests[0]
  assert.equal(first.url, ENDPOINT); assert.equal(first.request.redirect, 'error')
  assert.equal(first.request.headers.Authorization, `Bearer ${key}`)
  assert.equal(first.body.model, MODEL); assert.equal(first.body.store, false)
  assert.equal(first.body.parallel_tool_calls, false); assert.equal(first.body.reasoning.effort, 'none')
  assert.equal(first.body.max_output_tokens, LIMITS.output)
  assert.deepEqual(first.body.tools.map(tool => tool.name), ['get_setup_status', 'request_setup_action'])
  assert.deepEqual(first.body.input, [{ role: 'user', content: question.message }])
  assert.equal(requests[1].body.input.length, 3)
  assert.doesNotMatch(JSON.stringify(first.body), /synthetic-private-key|projectPath|apiKey|previous_response_id/)
  await helper.send({ integration: 'codex', message: 'Help connect Codex' })
  assert.equal(requests[2].body.input.length, 1)
})
test('native checks minimize evidence and suggested actions do not execute', async () => {
  const { helper, requests, checks } = setup({ replies: [call('get_setup_status', { integration: 'comfyui' }),
    call('request_setup_action', { integration: 'comfyui', action: 'configure' }, 'call_2'), answer('Choose the connection button to continue.')],
    optionalSetup: { inspect: async payload => { checks.push(payload); return { success: true, state: 'unavailable', configuredPort: 8188,
      connections: [{ port: 8189, deviceNames: ['PRIVATE GPU detail'] }], summary: 'PRIVATE raw path /home/private', secret: key, models: [{ id: '/home/model' }] } } } })
  const result = await helper.send(question)
  assert.equal(result.success, true)
  assert.deepEqual(checks, [{ integration: 'comfyui' }])
  assert.deepEqual(result.actions, [{ integration: 'comfyui', action: 'configure' }])
  assert.deepEqual(result.checks[0].ports, [8189])
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|home\/model|synthetic-private-key/)
  assert.doesNotMatch(JSON.stringify(requests.map(req => req.body)), /PRIVATE|home\/model|synthetic-private-key/)
  assert.deepEqual(JSON.parse(requests[2].body.input.at(-1).output), { offered: true, executed: false, userClickRequired: true, integration: 'comfyui', action: 'configure', label: 'Open ComfyUI controls' })
})
test('setup controls are navigation-only offers with contextual labels, never lifecycle or sign-in authority', async () => {
  for (const integration of ['comfyui', 'lmstudio', 'codex']) {
    let opened = 0
    const { helper, requests, checks } = setup({ installedApps: { open: () => { opened++ } },
      replies: [call('request_setup_action', { integration, action: 'configure' }), answer('Use the suggested control.')],
    })
    const result = await helper.send({ integration, message: 'Show the setup controls without changing anything.' })
    assert.deepEqual(result.actions, [{ integration, action: 'configure' }])
    assert.deepEqual(JSON.parse(requests[1].body.input.at(-1).output), {
      offered: true, executed: false, userClickRequired: true, integration, action: 'configure',
      label: integration === 'comfyui' ? 'Open ComfyUI controls' : integration === 'codex' ? 'Open Codex setup controls' : 'Configure manually',
    })
    assert.equal(opened, 0); assert.deepEqual(checks, [])
    assert.equal((await helper.performAction({ integration, action: 'configure' })).success, false)
    assert.equal(opened, 0)
    assert.deepEqual(requests[0].body.tools.map(tool => tool.name), ['get_setup_status', 'request_setup_action'])
  }
})
test('Codex ready requires a successful matching native setup result, not generic or cross-topic Ready', async () => {
  const ready = { success: true, integration: 'codex', state: 'ready' }
  for (const connection of [ready, { ...ready, integration: undefined }, { ...ready, integration: 'lmstudio' },
    { ...ready, integration: 'comfyui' }, { ...ready, success: false }, { ...ready, state: undefined }]) {
    const { helper, requests } = setup({ optionalSetup: { inspect: async () => ({ ...connection,
      path: '/private/codex', account: 'private-account@example.invalid', models: [{ id: 'PRIVATE_CODEX_MODEL' }], secret: key }) },
      replies: [call('get_setup_status', { integration: 'codex' }), answer('See the native setup check.')],
    })
    const result = await helper.send({ integration: 'codex', message: 'Check Codex without signing in or sending a test prompt.' })
    assert.equal(result.success, true)
    assert.equal(result.checks[0].state, connection === ready ? 'ready' : 'problem')
    if (connection === ready) assert.equal(result.checks[0].summary, 'Codex CLI is signed in through ChatGPT. No Codex prompt was sent.')
    assert.deepEqual(Object.keys(result.checks[0]).sort(), ['integration', 'state', 'summary'])
    assert.doesNotMatch(JSON.stringify([result, requests.map(request => request.body)]), /private\/codex|private-account|PRIVATE_CODEX_MODEL|synthetic-private-key/)
  }
})
test('Codex completion evidence follows real optional-setup sign-in checks without prompts or account/model context', async () => {
  const cases = [
    [{ available: true, installed: true, signedIn: true, authMode: 'chatgpt' }, 'ready'],
    [{ installed: false, code: 'CODEX_NOT_FOUND' }, 'missing'],
    [{ installed: true, available: true, signedIn: false, authMode: 'chatgpt' }, 'signin'],
    [{ installed: true, available: true, signedIn: true, authMode: 'api-key' }, 'signin'],
    [{ installed: true, available: false, signedIn: true, authMode: 'chatgpt' }, 'problem'],
    [{ installed: true, available: true }, 'problem'],
    [{ code: 'BUSY' }, 'problem'],
  ]
  for (const [provider, state] of cases) {
    const calls = []
    const optionalSetup = createOptionalSetup({ inspectProvider: async payload => {
      calls.push(payload)
      return { ...provider, path: '/private/codex', account: 'private-account@example.invalid', models: [{ id: 'PRIVATE_CODEX_MODEL' }], secret: key }
    } })
    const { helper, requests } = setup({ optionalSetup, replies: [
      call('get_setup_status', { integration: 'codex' }),
      call('request_setup_action', { integration: 'codex', action: 'configure' }, 'call_2'),
      answer('Use Open Codex setup controls to view the existing setup options.'),
    ] })
    const result = await helper.send({ integration: 'codex', message: 'Check Codex and show its setup controls. Don’t sign me in or out or change my assistant.' })
    assert.equal(result.success, true)
    assert.equal(result.checks[0].state, state)
    assert.deepEqual(calls, [{ provider: 'codex' }])
    assert.deepEqual(result.actions, [{ integration: 'codex', action: 'configure' }])
    assert.deepEqual(JSON.parse(requests[2].body.input.at(-1).output), {
      offered: true, executed: false, userClickRequired: true, integration: 'codex', action: 'configure', label: 'Open Codex setup controls',
    })
    for (const action of ['configure', 'login', 'logout', 'send']) assert.equal((await helper.performAction({ integration: 'codex', action })).success, false)
    assert.equal(requests.length, 3)
    assert.doesNotMatch(JSON.stringify([result, requests.map(request => request.body)]), /private\/codex|private-account|PRIVATE_CODEX_MODEL|synthetic-private-key/)
  }
})
// These are request-contract and replay tests, not a live model-selection eval.
// The regression was missing action meaning BEFORE the model selected a tool.
test('initial request distinguishes ComfyUI in-app controls from external guides before tool selection', async () => {
  for (const integration of ['comfyui', 'lmstudio', 'codex']) {
    const { helper, requests } = setup()
    await helper.send({ integration, message: 'Show me the setup controls.' })
    const body = requests[0].body
    const action = body.tools.find(tool => tool.name === 'request_setup_action')
    assert.match(action.description, /For ComfyUI, configure offers Open ComfyUI controls/)
    assert.match(action.description, /Start\/Stop\/Restart controls, not a web guide/)
    assert.match(action.description, /ONLY offers it, never executes it/)
    assert.match(action.parameters.properties.action.description, /configure: show in-app controls/)
    assert.match(action.parameters.properties.action.description, /connection_guide: external official documentation, NOT Velorn's controls/)
    assert.match(body.instructions, /request_setup_action with integration=comfyui and action=configure/)
    assert.match(body.instructions, /do not start, stop or change anything.*still calls for configure, not a guide/)
    assert.match(body.instructions, /get_setup_status first, then offer configure regardless of whether the connection is ready/)
    assert.match(body.instructions, /controls-only question, no readiness check is required; do not claim current readiness/)
    assert.match(body.instructions, /Use guide actions when external official documentation is requested or needed for a step outside Velorn/)
    assert.match(body.instructions, /availability depends on the existing launcher and ownership checks/)
    assert.equal(body.model, MODEL)
    assert.equal(action.strict, true)
    assert.equal(action.parameters.additionalProperties, false)
    assert.deepEqual(action.parameters.required, ['integration', 'action'])
    assert.deepEqual(action.parameters.properties.action.enum, ['check', 'configure', 'install', 'credentials', 'open_app', 'choose_app', 'installation_guide', 'connection_guide'])
    assert.deepEqual(body.tools.map(tool => tool.name), ['get_setup_status', 'request_setup_action'])
  }
})
test('combined check and show-controls replay offers navigation for ready or unavailable ComfyUI without changing anything', async () => {
  const message = 'Check my existing ComfyUI connection, then show me where I can start and stop it. Don’t start, stop, restart, install, or change anything.'
  for (const state of ['ready', 'unavailable']) {
    let inspections = 0, changes = 0
    const changed = () => { changes++; throw Error('No setup changes allowed') }
    const { helper, requests } = setup({ optionalSetup: {
      inspect: async () => { inspections++; return { success: true, integration: 'comfyui', state, configuredPort: 8189, connections: state === 'ready' ? [{ port: 8189 }] : [] } },
      start: changed, stop: changed, restart: changed, configure: changed,
    }, installedApps: { open: changed, choose: changed }, openGuide: changed, replies: [
      call('get_setup_status', { integration: 'comfyui' }),
      call('request_setup_action', { integration: 'comfyui', action: 'configure' }, 'call_2'),
      answer('Use Open ComfyUI controls to view the existing controls. No lifecycle action was performed.'),
    ] })
    const result = await helper.send({ integration: 'comfyui', message })
    assert.equal(result.success, true)
    assert.equal(result.checks[0].state, state)
    assert.deepEqual(result.actions, [{ integration: 'comfyui', action: 'configure' }])
    assert.equal(requests[0].body.input[0].content, message)
    assert.equal(requests.length, 3)
    assert.equal(inspections, 1)
    assert.equal(changes, 0)
    const offer = JSON.parse(requests[2].body.input.at(-1).output)
    assert.equal(offer.label, 'Open ComfyUI controls')
    assert.equal(offer.executed, false)
    assert.equal(offer.userClickRequired, true)
    for (const action of ['configure', 'start', 'stop', 'restart']) assert.equal((await helper.performAction({ integration: 'comfyui', action })).success, false)
    assert.equal(changes, 0)
  }
})
test('controls-only and explicit ComfyUI documentation offers remain separate passive actions', async () => {
  for (const [action, message] of [
    ['configure', 'Show me where to restart ComfyUI in Velorn, but do not restart it.'],
    ['connection_guide', 'Show me the official ComfyUI connection documentation, not Velorn’s controls.'],
    ['installation_guide', 'Where is the official ComfyUI installation guide?'],
  ]) {
    let changes = 0
    const { helper, requests, checks } = setup({ openGuide: () => { changes++ }, replies: [
      call('request_setup_action', { integration: 'comfyui', action }), answer('Use the offered button.'),
    ] })
    const result = await helper.send({ integration: 'comfyui', message })
    assert.equal(result.success, true)
    assert.deepEqual(result.actions, [{ integration: 'comfyui', action }])
    assert.deepEqual(result.checks, [])
    assert.deepEqual(checks, [])
    assert.equal(changes, 0)
    assert.equal(requests.length, 2)
    const offer = JSON.parse(requests[1].body.input.at(-1).output)
    assert.equal(offer.label, action === 'configure' ? 'Open ComfyUI controls' : ACTION_LABELS[action])
    assert.equal(offer.executed, false)
  }
})
test('ComfyUI ready requires proof of the configured port, not another responding server or generic success', async () => {
  const ready = { success: true, integration: 'comfyui', state: 'ready', configuredPort: 8189, connections: [{ port: 8189 }] }
  for (const connection of [ready, { ...ready, configuredPort: undefined }, { ...ready, configuredPort: '8189' },
    { ...ready, configuredPort: 65536 }, { ...ready, connections: [{ port: 8188 }] },
    { ...ready, connections: [{ port: '8189' }] }, { ...ready, integration: 'lmstudio' }, { ...ready, success: false }]) {
    const { helper, requests } = setup({ optionalSetup: { inspect: async () => ({ ...connection, path: '/private/launcher', logs: ['private log'], models: ['unverified model'] }) },
      replies: [call('get_setup_status', { integration: 'comfyui' }), answer('See the native connection result.')],
    })
    const result = await helper.send(question)
    const check = result.checks[0]
    assert.equal(check.state, connection === ready ? 'ready' : 'problem')
    if (connection === ready) {
      assert.equal(check.configuredPort, 8189)
      assert.match(check.summary, /Models and workflows were not checked/)
      assert.match(check.summary, /No workflow or generation was run/)
    }
    assert.doesNotMatch(JSON.stringify([result, requests.map(request => request.body)]), /private\/launcher|private log|unverified model/)
  }
})
test('verified loaded model names are UI-only and absent from current and retained provider context', async () => {
  const connection = { success: true, integration: 'lmstudio', state: 'ready', models: [
    { id: 'publisher/actual-chat-q4', displayName: 'Actual Local Chat Q4', loaded: true, secret: key },
    { id: 'publisher/second-model:2', loaded: true },
    { id: 'publisher/downloaded-only', displayName: 'Not loaded', loaded: false },
  ] }
  const snapshot = structuredClone(connection)
  const { helper, requests } = setup({ optionalSetup: { inspect: async () => connection },
    replies: [call('get_setup_status', { integration: 'lmstudio' }), answer('The native check is ready.'), answer('You can continue.')],
  })
  const result = await helper.send({ integration: 'lmstudio', message: 'Check the connection.' })
  assert.equal(result.success, true)
  assert.deepEqual(result.checks[0].loadedModels, { verified: true, names: ['Actual Local Chat Q4', 'publisher/second-model:2'], truncated: false })
  assert.doesNotMatch(JSON.stringify(result), /downloaded-only|Not loaded|synthetic-private-key/)
  const toolOutput = JSON.parse(requests[1].body.input.at(-1).output)
  assert.equal(Object.hasOwn(toolOutput, 'loadedModels'), false)
  await helper.send({ integration: 'lmstudio', message: 'What next?' })
  assert.match(JSON.stringify(requests[2].body.input), /Prior native setup check/)
  assert.doesNotMatch(JSON.stringify(requests.map(request => request.body)), /Actual Local Chat|actual-chat|second-model|downloaded-only|loadedModels|synthetic-private-key/)
  assert.deepEqual(connection, snapshot)
})
test('only successful matching native ready results with explicitly loaded models supply names', async () => {
  const loaded = [{ id: 'exact-safe-model', displayName: 'Exact Safe Model', loaded: true }]
  for (const connection of [
    { success: false, integration: 'lmstudio', state: 'ready', models: loaded },
    { success: true, integration: 'codex', state: 'ready', models: loaded },
    { success: true, state: 'ready', models: loaded },
    ...['needs-model', 'problem', 'unavailable', 'missing', 'signin'].map(state => ({ success: true, integration: 'lmstudio', state, models: loaded })),
    ...[false, 'true', undefined, 1].map(value => ({ success: true, integration: 'lmstudio', state: 'ready', models: [{ ...loaded[0], loaded: value }] })),
    { success: true, integration: 'lmstudio', state: 'ready', models: { data: loaded } },
    { success: true, integration: 'lmstudio', state: 'ready', models: Array.from({ length: 101 }, (_, index) => ({ id: `model-${index}`, loaded: true })) },
  ]) {
    const { helper } = setup({ optionalSetup: { inspect: async () => connection },
      replies: [call('get_setup_status', { integration: 'lmstudio' }), answer('Checked.')],
    })
    const result = await helper.send({ integration: 'lmstudio', message: 'Check.' })
    assert.equal(result.success, true)
    assert.equal(Object.hasOwn(result.checks[0], 'loadedModels'), false, JSON.stringify(connection))
  }
  for (const integration of ['codex', 'comfyui']) {
    const { helper } = setup({ optionalSetup: { inspect: async () => ({ success: true, integration, state: 'ready', models: loaded }) },
      replies: [call('get_setup_status', { integration }), answer('Checked.')],
    })
    const result = await helper.send({ integration, message: 'Check.' })
    assert.equal(Object.hasOwn(result.checks[0], 'loadedModels'), false)
  }
})
test('loaded evidence rejects unsafe identities and uses only independently safe exact label fallback', async () => {
  const unsafe = ['/private/models/chat.gguf', 'C:\\private\\chat.gguf', '~/models/chat.gguf', '../chat.gguf', 'owner/../chat',
    'models/chat.gguf', 'https://private.test/model', 'file:/private/model', '<b>model</b>', 'model\nsecret', 'model\u202esecret',
    ' chat-model', 'chat-model ', 'api_key=private-value', 'Bearer short', 'sk-proj-abcdefghijklmnopqrstuvwxyz', key,
    'Label /private/models/chat', 'Label ~/private/model', 'Label C:/private/model', '.config/models', 'model\u2028secret',
    'model\u200fsecret', 'ftp://private.test/model', `Label ${key}`, 'x'.repeat(257), 12, null]
  const connection = { success: true, integration: 'lmstudio', state: 'ready', models: [
    ...unsafe.map(id => ({ id, displayName: 'Looks Safe But Identity Is Invalid', loaded: true })),
    ...unsafe.map((displayName, index) => ({ id: `exact-fallback-${index}`, displayName, loaded: true })),
  ] }
  const { helper, requests } = setup({ optionalSetup: { inspect: async () => connection },
    replies: [call('get_setup_status', { integration: 'lmstudio' }), answer('Checked.')],
  })
  const result = await helper.send({ integration: 'lmstudio', message: 'Check.' })
  assert.deepEqual(result.checks[0].loadedModels, { verified: true,
    names: Array.from({ length: 8 }, (_, index) => `exact-fallback-${index}`), truncated: true })
  assert.doesNotMatch(JSON.stringify(result), /private|Looks Safe|synthetic|Bearer|sk-proj/)
  assert.doesNotMatch(JSON.stringify(requests.map(request => request.body)), /fallback|loadedModels|Looks Safe/)
})
test('loaded evidence bounds names and preserves multiple exact models without claiming a total', async () => {
  const models = [
    { id: 'first-id', displayName: 'Shared Model Name', loaded: true },
    { id: 'second-id', displayName: 'Shared Model Name', loaded: true },
    { id: 'second-id', displayName: 'Duplicate Id Ignored', loaded: true },
    { id: 'unloaded-first', loaded: false }, { id: 'unloaded-first', loaded: true },
    { id: 'x'.repeat(161), displayName: 'A safe display name for a long identifier', loaded: true },
    { id: 'y'.repeat(161), loaded: true },
    ...Array.from({ length: 10 }, (_, index) => ({ id: `loaded-${index}`, loaded: true })),
  ]
  const { helper } = setup({ optionalSetup: { inspect: async () => ({ success: true, integration: 'lmstudio', state: 'ready', models }) },
    replies: [call('get_setup_status', { integration: 'lmstudio' }), answer('Checked.')],
  })
  const result = await helper.send({ integration: 'lmstudio', message: 'Check.' })
  assert.deepEqual(result.checks[0].loadedModels, { verified: true, names: ['Shared Model Name', 'Shared Model Name',
    'A safe display name for a long identifier', 'loaded-0', 'loaded-1', 'loaded-2', 'loaded-3', 'loaded-4'], truncated: true })
  assert.equal(Object.hasOwn(result.checks[0].loadedModels, 'total'), false)
})
test('later failed setup check cannot reuse a previous verified loaded-model receipt', async () => {
  let connection = { success: true, integration: 'lmstudio', state: 'ready', models: [{ id: 'first-only-model', loaded: true }] }
  const { helper, requests } = setup({ optionalSetup: { inspect: async () => connection }, replies: [
    call('get_setup_status', { integration: 'lmstudio' }), answer('Ready.'),
    call('get_setup_status', { integration: 'lmstudio' }), answer('Not responding.'),
  ] })
  const first = await helper.send({ integration: 'lmstudio', message: 'Check.' })
  assert.equal(first.checks[0].loadedModels.verified, true)
  connection = { success: false, integration: 'lmstudio', state: 'ready', models: [{ id: 'first-only-model', loaded: true }] }
  const second = await helper.send({ integration: 'lmstudio', message: 'Check again.' })
  assert.equal(second.checks[0].state, 'problem')
  assert.equal(Object.hasOwn(second.checks[0], 'loadedModels'), false)
  assert.doesNotMatch(JSON.stringify(requests.map(request => request.body)), /first-only-model|loadedModels/)
})
test('unknown, extra, cross-topic, unsupported and duplicate tool calls fail closed', async () => {
  const cases = [call('shell', {}), call('get_setup_status', { integration: 'codex' }), call('get_setup_status', { integration: 'comfyui', command: 'install' }),
    call('request_setup_action', { integration: 'comfyui', action: 'generate' }),
    { status: 'completed', output: [{ ...call('get_setup_status', { integration: 'comfyui' }).output[0], arguments: '{broken' }] }]
  for (const bad of cases) {
    const { helper, checks, requests } = setup({ replies: [bad] })
    assert.equal((await helper.send(question)).success, false); assert.equal(checks.length, 0); assert.equal(requests.length, 1)
  }
  for (const integration of ['codex', 'lmstudio']) {
    const { helper } = setup({ replies: [call('request_setup_action', { integration, action: 'credentials' })] })
    assert.equal((await helper.send({ integration, message: 'Help setup' })).code, 'SETUP_HELPER_TOOL')
  }
  const { helper, checks } = setup({ replies: [call('get_setup_status', { integration: 'comfyui' }), call('get_setup_status', { integration: 'comfyui' })] })
  assert.equal((await helper.send(question)).code, 'SETUP_HELPER_TOOL'); assert.equal(checks.length, 1)
})
test('no raw upstream errors or malformed/partial/oversized response leaks; no automatic retry', async () => {
  for (const response of [new Response(`secret ${key}`, { status: 401 }), json({ status: 'incomplete', output: [] }), json(answer(key)),
    new Response('bad json'), new Response('x'.repeat(LIMITS.response + 1)), json(answer(''))]) {
    let count = 0
    const { helper } = setup({ fetchImpl: async () => { count++; return response } })
    const result = await helper.send(question)
    assert.equal(result.success, false); assert.equal(count, 1); assert.ok(!JSON.stringify(result).includes(key))
  }
  const { helper } = setup({ fetchImpl: async () => { throw new Error(`transport secret ${key}`) } })
  assert.equal((await helper.send(question)).code, 'SETUP_HELPER_FAILED')
})
test('cancel and reset suppress late fetch results and preserve consumed allowance', async () => {
  let resolve, request
  const { helper } = setup({ fetchImpl: async (_url, payload) => { request = payload; return new Promise(done => { resolve = done }) } })
  const pending = helper.send(question)
  assert.equal((await helper.send(question)).code, 'SETUP_HELPER_BUSY')
  helper.reset({})
  assert.equal(request.signal.aborted, true)
  assert.equal((await pending).code, 'SETUP_HELPER_CANCELLED')
  resolve(json(answer('late result')))
  await new Promise(done => setImmediate(done))
  assert.equal(helper.status({}).remainingTurns, LIMITS.turns - 1)
})
test('timeout is bounded even when a transport ignores AbortSignal', async () => {
  const { helper } = setup({ timeoutMs: 8, fetchImpl: () => new Promise(() => {}) })
  assert.equal((await helper.send(question)).code, 'SETUP_HELPER_TIMEOUT')
})
test('cancel during native check prevents subsequent API continuation/action', async () => {
  let resolve, started
  const ready = new Promise(done => { started = done })
  const { helper, requests } = setup({ replies: [call('get_setup_status', { integration: 'comfyui' })], optionalSetup: { inspect: () => { started(); return new Promise(done => { resolve = done }) } } })
  const pending = helper.send(question)
  await ready; helper.cancel({})
  assert.equal((await pending).code, 'SETUP_HELPER_CANCELLED')
  resolve({ success: true, state: 'ready' }); await new Promise(done => setImmediate(done))
  assert.equal(requests.length, 1)
})
test('turn cap cannot be replenished by reset; tool steps are bounded', async () => {
  const { helper, requests } = setup()
  for (let i = 0; i < LIMITS.turns; i++) { assert.equal((await helper.send(question)).success, true); helper.reset({}) }
  assert.equal((await helper.send(question)).code, 'SETUP_HELPER_LIMIT'); assert.equal(requests.length, LIMITS.turns)
  let count = 0
  const limited = setup({ fetchImpl: async () => json(call('request_setup_action', { integration: 'comfyui', action: 'configure' }, `call_${++count}`)) }).helper
  assert.equal((await limited.send(question)).code, 'SETUP_HELPER_LIMIT'); assert.equal(count, LIMITS.steps)
})
test('process-wide request cap survives failed turns and reset, with truthful exhaustion status', async () => {
  let count = 0
  const { helper } = setup({ fetchImpl: async () => json(call('request_setup_action', { integration: 'comfyui', action: 'configure' }, `call_${++count}`)) })
  for (let i = 0; i < LIMITS.requests / LIMITS.steps; i++) { assert.equal((await helper.send(question)).code, 'SETUP_HELPER_LIMIT'); helper.reset({}) }
  const result = await helper.send(question)
  assert.equal(result.code, 'SETUP_HELPER_LIMIT'); assert.equal(result.remainingTurns, 0)
  assert.equal(helper.status({}).remainingTurns, 0); assert.equal(count, LIMITS.requests)
})
test('IPC main-frame authorization and navigation/renderer/quit lifecycle discard old turns', async () => {
  const handlers = new Map(), app = new EventEmitter(), contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false }),
    window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false }), event = { sender: contents, senderFrame: contents.mainFrame }
  let resolve
  const { helper } = setup({ fetchImpl: () => new Promise(done => { resolve = done }) })
  const controller = registerSetupHelperIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) }, app, getMainWindow: () => window, helper })
  const invoke = (method, payload, ev = event) => handlers.get(CHANNELS[method])(ev, payload)
  assert.equal((await invoke('send', question, { sender: contents, senderFrame: {} })).code, 'SETUP_HELPER_UNAUTHORIZED')
  assert.equal((await invoke('status', {}, { sender: {}, senderFrame: contents.mainFrame })).code, 'SETUP_HELPER_UNAUTHORIZED')
  const pending = invoke('send', question)
  contents.emit('did-start-navigation', {}, 'http://127.0.0.1/new', false, true)
  assert.equal((await pending).code, 'SETUP_HELPER_CANCELLED'); resolve(json(answer('late')))
  assert.equal(contents.listenerCount('did-start-navigation'), 0)
  assert.equal((await invoke('status', {})).available, true)
  contents.emit('render-process-gone')
  assert.equal(contents.listenerCount('did-start-navigation'), 0)
  app.emit('will-quit'); assert.equal(handlers.size, 0); assert.equal(helper.status({}).available, false)
  controller.dispose()
})
test('silent window replacement cannot run a late inspection or paid continuation', async () => {
  const handlers = new Map(), contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  let currentWindow = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false }), resolve, requests = 0, checks = 0
  const { helper } = setup({ fetchImpl: () => { requests++; return new Promise(done => { resolve = done }) }, optionalSetup: { inspect: () => { checks++; return { success: true, state: 'ready' } } } })
  const controller = registerSetupHelperIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) }, getMainWindow: () => currentWindow, helper })
  const pending = handlers.get(CHANNELS.send)({ sender: contents, senderFrame: contents.mainFrame }, question)
  currentWindow = { ...currentWindow }
  resolve(json(call('get_setup_status', { integration: 'comfyui' })))
  assert.equal((await pending).code, 'SETUP_HELPER_CANCELLED')
  assert.equal(requests, 1); assert.equal(checks, 0); controller.dispose()
})

test('installation inspection is passive, LM-only, minimized and independent of service readiness', async () => {
  for (const [state, installationState] of [['unavailable', 'found'], ['ready', 'not_found'], ['needs-model', 'unknown']]) {
    let discoveries = 0, launches = 0
    const { helper, requests } = setup({
      optionalSetup: { inspect: async () => ({ success: true, state }) },
      installedApps: { inspect: async () => { discoveries++; return { state: installationState, canOpen: true, summary: '/private/path', path: '/private/key', key } },
        open: async () => { launches++ } },
      replies: [call('get_setup_status', { integration: 'lmstudio' }), answer('Here is the installation and connection check.')],
    })
    assert.equal(discoveries, 0); helper.status({}); assert.equal(discoveries, 0)
    const result = await helper.send({ integration: 'lmstudio', message: 'Is LM Studio installed and connected?' })
    assert.equal(result.success, true); assert.equal(discoveries, 1); assert.equal(launches, 0)
    assert.equal(result.checks[0].state, state); assert.equal(result.checks[0].installation.state, installationState)
    assert.equal(result.checks[0].installation.canOpen, installationState === 'found')
    assert.doesNotMatch(JSON.stringify([result, requests.map(request => request.body)]), /private\/path|private\/key|synthetic-private-key/)
    if (state === 'unavailable') assert.match(result.checks[0].summary, /installed, but its local server is not responding/)
  }
  const { helper } = setup({ installedApps: { inspect: () => { throw Error('must not inspect an unrelated app') } },
    replies: [call('get_setup_status', { integration: 'codex' }), answer('Codex checked.')] })
  assert.equal((await helper.send({ integration: 'codex', message: 'Check Codex' })).success, true)
})

test('offered open and official guide actions never execute and return exact UI labels', async () => {
  for (const action of ['open_app', 'choose_app', 'installation_guide', 'connection_guide']) {
    let writes = 0
    const { helper, requests } = setup({ installedApps: { open: () => { writes++ }, choose: () => { writes++ } }, openGuide: () => { writes++ },
      replies: [call('request_setup_action', { integration: 'lmstudio', action }), answer('Choose the offered button.')],
    })
    const result = await helper.send({ integration: 'lmstudio', message: 'Help with setup' })
    assert.equal(result.success, true); assert.equal(writes, 0)
    assert.deepEqual(result.actions, [{ integration: 'lmstudio', action }])
    assert.equal(JSON.parse(requests[1].body.input.at(-1).output).label, ACTION_LABELS[action])
  }
  const { helper } = setup({ replies: [call('performAction', { integration: 'lmstudio', action: 'open_app' })] })
  assert.equal((await helper.send({ integration: 'lmstudio', message: 'Open the app' })).code, 'SETUP_HELPER_TOOL')
})

test('UI-only actions accept no paths, URLs, extra fields or cross-topic launch, even without API configuration', async () => {
  const opened = []
  const { helper, requests } = setup({ env: {}, openGuide: async url => { opened.push(url) } })
  for (const payload of [null, {}, { integration: 'lmstudio', action: 'open_app', path: '/tmp/evil' },
    { integration: 'lmstudio', action: 'installation_guide', url: 'https://evil.test' },
    { integration: 'codex', action: 'open_app' }, { integration: 'comfyui', action: 'choose_app' },
    { integration: 'lmstudio', action: 'configure' }, { integration: 'lmstudio', action: 'shell' }]) {
    assert.equal((await helper.performAction(payload)).success, false)
  }
  const result = await helper.performAction({ integration: 'lmstudio', action: 'connection_guide' })
  assert.equal(result.success, true); assert.equal(result.opened, true)
  assert.deepEqual(opened, [SETUP_GUIDES.lmstudio.connection_guide]); assert.equal(requests.length, 0)
  assert.equal((await helper.performAction({ integration: 'codex', action: 'connection_guide' })).success, false)
})

test('approved app action appends bounded native receipt, never fabricates Ready or performs a paid continuation', async () => {
  let opens = 0
  const { helper, requests } = setup({ installedApps: { open: async () => { opens++; return { ok: true, status: 'opened', summary: '/private/path', key } } } })
  const before = helper.status({}).remainingTurns
  const result = await helper.performAction({ integration: 'lmstudio', action: 'open_app' })
  assert.equal(opens, 1); assert.equal(result.success, true); assert.equal(result.opened, true)
  assert.match(result.summary, /have not been checked/)
  assert.equal(requests.length, 0); assert.equal(helper.status({}).remainingTurns, before)
  await helper.send({ integration: 'lmstudio', message: 'What should I do next?' })
  assert.match(requests[0].body.input[0].content, /User-clicked setup action/)
  assert.doesNotMatch(JSON.stringify([result, requests[0].body]), /private\/path|synthetic-private-key/)
  helper.reset({})
  await helper.send({ integration: 'lmstudio', message: 'Start a new setup conversation' })
  assert.equal(requests[1].body.input.length, 1)
})

test('setup actions cannot proceed after cancellation, reset or changed main frame', async () => {
  for (const invalidation of ['cancel', 'reset', 'frame']) {
    let complete, invoked = 0, launched = 0, current = true
    const { helper, requests } = setup({ installedApps: { open: async (_args, { isCurrent }) => {
      invoked++; await new Promise(resolve => { complete = resolve })
      if (isCurrent()) launched++
      return { ok: true, status: 'opened' }
    } } })
    const pending = helper.performAction({ integration: 'lmstudio', action: 'open_app' }, { isCurrent: () => current })
    assert.equal(invoked, 1)
    assert.equal((await helper.performAction({ integration: 'lmstudio', action: 'open_app' })).code, 'SETUP_HELPER_BUSY')
    assert.equal((await helper.send({ integration: 'lmstudio', message: 'Check it' })).code, 'SETUP_HELPER_BUSY')
    if (invalidation === 'frame') current = false
    else helper[invalidation]({})
    complete()
    assert.equal((await pending).code, 'SETUP_HELPER_CANCELLED')
    assert.equal(launched, 0); assert.equal(requests.length, 0)
  }
})

test('action IPC is main-frame-only and invalidates late approval on navigation', async () => {
  const handlers = new Map(), app = new EventEmitter(), contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false }),
    window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false }), event = { sender: contents, senderFrame: contents.mainFrame }
  let approve, launches = 0
  const { helper } = setup({ installedApps: { open: async (_args, { isCurrent }) => {
    await new Promise(resolve => { approve = resolve })
    if (isCurrent()) launches++
    return { ok: true, status: 'opened' }
  } } })
  const controller = registerSetupHelperIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) }, app, getMainWindow: () => window, helper })
  const action = { integration: 'lmstudio', action: 'open_app' }, invoke = handlers.get(CHANNELS.performAction)
  assert.equal((await invoke({ sender: contents, senderFrame: {} }, action)).code, 'SETUP_HELPER_UNAUTHORIZED')
  const pending = invoke(event, action)
  contents.emit('did-start-navigation', {}, 'http://127.0.0.1/new', false, true)
  approve()
  assert.equal((await pending).code, 'SETUP_HELPER_CANCELLED'); assert.equal(launches, 0)
  controller.dispose()
})

test('Cloud tool contract reads stored evidence only and offers two scoped actions without changing the model or tools', async () => {
  const { helper, requests } = setup()
  await helper.send({ integration: 'comfycloud', message: 'Help me set up hosted Comfy Cloud.' })
  const first = requests[0].body
  assert.equal(first.model, MODEL); assert.equal(first.model, 'gpt-6-luna'); assert.equal(first.tools.length, 2)
  assert.deepEqual(first.tools.map(tool => tool.name), ['get_setup_status', 'request_setup_action'])
  for (const tool of first.tools) assert.ok(tool.parameters.properties.integration.enum.includes('comfycloud'))
  assert.match(first.tools[0].description, /ONLY read the stored native account-check result; no new Comfy request/)
  assert.match(first.tools[1].description, /only configure .*Open Comfy Cloud controls.* or connection_guide/)
  assert.match(first.instructions, /ONLY reads Velorn's stored account-check result/)
  assert.match(first.instructions, /NOT verify a paid subscription, credit balance, models, workflows, generation capability or spending approval/)
  assert.match(first.instructions, /For a request to check again online, offer configure/)
  assert.match(first.instructions, /Hosted generation is not implemented/)
})

test('Cloud inspection only uses the native passive dependency and never serializes credentials, storage flags or raw status', async () => {
  let readCalls = 0
  const { helper, requests, checks } = setup({
    getHostedStatus: async ({ isCurrent }) => {
      readCalls++; assert.equal(isCurrent(), true)
      return { success: true, integration: 'comfycloud', state: 'verified', configured: true,
        key: 'comfyui-synthetic-private-hosted-key', path: '/private/cloud-key', account: 'private@example.invalid',
        remembered: true, canRemember: true, body: { subscription: 'PRIVATE-PLAN', balance: 999 }, summary: 'PRIVATE provider instructions' }
    },
    replies: [call('get_setup_status', { integration: 'comfycloud' }),
      call('request_setup_action', { integration: 'comfycloud', action: 'configure' }, 'cloud_controls'), answer('Open Comfy Cloud controls to run an explicit account check.')],
  })
  const result = await helper.send({ integration: 'comfycloud', message: 'Read my stored account check and show the controls.' })
  assert.equal(result.success, true); assert.equal(readCalls, 1); assert.deepEqual(checks, [])
  assert.deepEqual(result.actions, [{ integration: 'comfycloud', action: 'configure' }])
  assert.deepEqual(Object.keys(result.checks[0]).sort(), ['configured', 'evidence', 'integration', 'state', 'summary'])
  assert.equal(result.checks[0].state, 'verified'); assert.equal(result.checks[0].evidence, 'stored-account-check')
  assert.match(result.checks[0].summary, /stored account check/); assert.match(result.checks[0].summary, /no new Comfy request/)
  assert.deepEqual(JSON.parse(requests[2].body.input.at(-1).output), { offered: true, executed: false, userClickRequired: true,
    integration: 'comfycloud', action: 'configure', label: 'Open Comfy Cloud controls' })
  await helper.send({ integration: 'comfycloud', message: 'What is the next step?' })
  assert.equal(readCalls, 1)
  assert.doesNotMatch(JSON.stringify([result, requests.map(request => request.body)]), /synthetic-private-hosted|private\/cloud-key|private@example|PRIVATE-PLAN|PRIVATE provider|remembered|canRemember/)
})

test('Cloud evidence rejects generic ready, unsuccessful, wrong-topic and malformed status before any verified claim', async () => {
  const valid = { success: true, integration: 'comfycloud', state: 'verified', configured: true }
  for (const value of [valid, { ...valid, state: 'ready' }, { ...valid, configured: false }, { ...valid, configured: 'true' },
    { ...valid, success: false }, { ...valid, success: undefined }, { ...valid, integration: 'comfyui' }, { ...valid, integration: undefined }, {}]) {
    const { helper } = setup({ getHostedStatus: async () => value,
      replies: [call('get_setup_status', { integration: 'comfycloud' }), answer('See the stored account evidence.')] })
    const result = await helper.send({ integration: 'comfycloud', message: 'Read stored Cloud account status.' })
    assert.equal(result.success, true); assert.equal(result.checks[0].state, value === valid ? 'verified' : 'problem')
    assert.equal(result.checks[0].configured, value === valid); assert.equal(result.checks[0].evidence, 'stored-account-check')
    assert.match(result.checks[0].summary, /no new Comfy request/)
  }
})

test('Cloud nonverified states stay distinct, with no dependency falling back to problem rather than local inspection', async () => {
  for (const state of ['missing', 'configured', 'waitlisted', 'auth-rejected', 'subscription-or-rate-limited', 'unavailable']) {
    const { helper, checks } = setup({ getHostedStatus: async () => ({ success: true, integration: 'comfycloud', state, configured: state !== 'missing' }),
      replies: [call('get_setup_status', { integration: 'comfycloud' }), answer('Use the Cloud controls to check explicitly.')] })
    const result = await helper.send({ integration: 'comfycloud', message: 'Read stored Cloud account status.' })
    assert.equal(result.checks[0].state, state); assert.match(result.checks[0].summary, /no new Comfy request/); assert.deepEqual(checks, [])
  }
  const { helper, checks } = setup({ replies: [call('get_setup_status', { integration: 'comfycloud' }), answer('Open the Cloud controls.')] })
  assert.equal((await helper.send({ integration: 'comfycloud', message: 'Read stored Cloud account status.' })).checks[0].state, 'problem')
  assert.deepEqual(checks, [])
})

test('Cloud action allowlist rejects online checks, key operations, installs and cross-topic tools', async () => {
  for (const action of ['check', 'credentials', 'install', 'open_app', 'choose_app', 'installation_guide', 'clear', 'save', 'online_check']) {
    const { helper, requests, checks } = setup({ replies: [call('request_setup_action', { integration: 'comfycloud', action })] })
    assert.equal((await helper.send({ integration: 'comfycloud', message: 'Show Cloud setup controls.' })).code, 'SETUP_HELPER_TOOL')
    assert.equal((await helper.performAction({ integration: 'comfycloud', action })).success, false)
    assert.equal(requests.length, 1); assert.deepEqual(checks, [])
  }
  for (const integration of ['comfyui', 'lmstudio', 'codex']) {
    let reads = 0
    const { helper, checks } = setup({ getHostedStatus: async () => { reads++ }, replies: [call('get_setup_status', { integration })] })
    assert.equal((await helper.send({ integration: 'comfycloud', message: 'Read stored Cloud status.' })).code, 'SETUP_HELPER_TOOL')
    assert.equal(reads, 0); assert.deepEqual(checks, [])
  }
})

test('Cloud official guide is fixed UI-only navigation, available without Luna and no credential read', async () => {
  const opened = []; let reads = 0
  const { helper, requests } = setup({ env: {}, getHostedStatus: async () => { reads++ }, openGuide: async url => { opened.push(url) } })
  assert.equal((await helper.performAction({ integration: 'comfycloud', action: 'configure' })).success, false)
  assert.equal((await helper.performAction({ integration: 'comfycloud', action: 'connection_guide' })).success, true)
  assert.deepEqual(opened, ['https://docs.comfy.org/development/deploy/cloud']); assert.equal(reads, 0); assert.equal(requests.length, 0)
  assert.equal((await helper.performAction({ integration: 'comfycloud', action: 'connection_guide', url: 'https://evil.invalid' })).success, false)
})

test('cancelled passive Cloud read cannot provide evidence or trigger paid continuation', async () => {
  let complete, authority
  const { helper, requests, checks } = setup({ getHostedStatus: async ({ isCurrent }) => {
    authority = isCurrent; await new Promise(resolve => { complete = resolve })
    return { success: true, integration: 'comfycloud', state: 'verified', configured: true }
  }, replies: [call('get_setup_status', { integration: 'comfycloud' }), answer('Should not continue.')] })
  const pending = helper.send({ integration: 'comfycloud', message: 'Read stored Cloud status.' })
  while (!complete) await new Promise(resolve => setImmediate(resolve))
  assert.equal(authority(), true); helper.cancel({}); assert.equal(authority(), false); complete()
  assert.equal((await pending).code, 'SETUP_HELPER_CANCELLED'); assert.equal(requests.length, 1); assert.deepEqual(checks, [])
})

test('known Comfy API key formats are rejected in chat before any model request', async () => {
  const { helper, requests } = setup()
  assert.equal((await helper.send({ integration: 'comfycloud', message: 'My key is comfyui-synthetic-private-hosted-key' })).code, 'SETUP_HELPER_SECRET')
  assert.equal(requests.length, 0)
})
