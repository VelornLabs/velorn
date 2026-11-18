'use strict'

// Native integration only. Every provider, computer command and editor operation
// is synthetic; the only disk access is this test's own temporary directory.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { registerConnectedAgentIpc, CHANNELS, validateSend } = require('../electron/connectedAgent.cjs')
const { createFullAccessPreference, VELO_CONSENT, LOCAL_CONSENT } = require('../electron/connectedAgentAccessPreference.cjs')
const { descriptor } = require('../electron/mobileAISharing.cjs')
const { markPreDispatchRefusal } = require('../electron/fundedLunaRecovery.cjs')
const { runCandidateTurn } = require('../electron/veloEngineCandidate.cjs')

const computerTool = { name: 'synthetic_computer_command', description: 'Synthetic computer boundary probe; never executes a command.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }
const editorTool = { name: 'get_project', description: 'Synthetic editor metadata.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
const answer = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
const call = (id, name, args = {}) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const response = (...output) => ({ ok: true, model: 'gpt-6-luna', output, remainingMicroUsd: 999999 })
const approved = (extra = {}) => ({ approved: true, shareImagesAndView: true, remember: false,
  scope: VELO_CONSENT.scope, version: VELO_CONSENT.version, ...extra })
const phoneApproval = () => ({ approved: true, shareImagesAndView: true, remember: true, phoneBundleVersion: 1,
  mobileBinding: { isCurrent: () => true } })
const failed = (value, message) => assert.equal(value.success === true && value.enabled === true, false, message)

test('isolated engine injection retains native Full access authority without a duplicate computer session', async t => {
  const dispatched = []
  const sendVelo = async (request, options) => {
    await options.assertBeforeSend()
    assert.equal(options.computerAccess, true)
    assert.equal(request.model, 'gpt-6-luna')
    assert.equal(request.reasoningEffort, 'low')
    assert.equal(path.isAbsolute(request.workingDirectory), true)
    assert.equal(options.engineContext.workspaceDir, request.workingDirectory)
    assert.equal(options.engineContext.projectKey, request.expectedContext.projectKey)
    const tools = await options.toolSession.listTools()
    assert.deepEqual(tools.map(tool => tool.name), ['get_project'])
    dispatched.push(request.requestId)
    return { success: true, provider: 'luna', text: 'Scripted bundled-engine reply.' }
  }
  sendVelo.handlesComputerAccess = true
  const f = await fixture(t, { sendVelo })
  const denied = await f.send({ token: 'not-a-grant' })
  assert.equal(denied.success, false); assert.equal(dispatched.length, 0)
  const grant = await f.enable()
  assert.equal(grant.enabled, true)
  const result = await f.send(grant)
  assert.equal(result.success, true)
  assert.equal(dispatched.length, 1)
  assert.equal(f.sessions.length, 0)
  assert.equal(f.requests.length, 0)
  f.revokeAccount()
  assert.equal((await f.send(grant)).success, false)
  assert.equal(dispatched.length, 1)
})

test('isolated engine injection does not grant shell access to a chat-only turn', async t => {
  const sendVelo = async (_request, options) => {
    assert.equal(options.computerAccess, false)
    assert.equal(options.toolSession, undefined)
    assert.equal(_request.expectedContext, undefined)
    assert.equal(path.isAbsolute(options.engineContext.workspaceDir), true)
    assert.equal(options.engineContext.workspaceDir, options.engineContext.projectKey)
    await options.assertBeforeSend()
    return { success: true, provider: 'luna', text: 'Scripted chat only.' }
  }
  sendVelo.handlesComputerAccess = true
  const f = await fixture(t, { sendVelo })
  const result = await f.invoke('send', f.payload({ toolsEnabled: false, fullAccess: false }))
  assert.equal(result.success, true)
  assert.equal(f.sessions.length, 0)
  assert.equal(f.requests.length, 0)
})

test('candidate recovery Cancel reaches IPC as trusted promptNotSent with no tools or provider request', async t => {
  let turns = 0
  const sendVelo = async (_request, options) => runCandidateTurn({
    engine: { start: async () => ({ recoveryRequired: true }), runTurn: async () => { turns++; assert.fail('Cancel cannot dispatch') } },
    input: [{ type: 'text', text: 'Only the new unsent message' }], signal: options.signal,
    assertAuthorized: async () => { await options.assertBeforeSend(); await options.engineContext.assertCurrent() },
    showRecoveryDialog: async () => ({ response: 0 }), onWaiting: options.onWaiting,
  })
  sendVelo.handlesComputerAccess = true
  const f = await fixture(t, { sendVelo })
  const result = await f.invoke('send', f.payload({ fullAccess: false }))
  assert.equal(result.success, false); assert.equal(result.code, 'CANCELLED'); assert.equal(result.promptNotSent, true)
  assert.equal(turns, 0); assert.equal(f.requests.length, 0); assert.equal(f.editorCalls.length, 0); assert.equal(f.computerCalls.length, 0)
})

test('candidate recovery approval cannot cross a changed native project or renderer session', async t => {
  for (const key of ['projectKey', 'session']) await t.test(key, async t => {
    let f, turns = 0
    const sendVelo = async (_request, options) => runCandidateTurn({
      engine: { start: async () => ({ recoveryRequired: true }), runTurn: async () => { turns++; assert.fail('Changed scope cannot dispatch') } },
      input: [{ type: 'text', text: 'Only the new unsent message' }], signal: options.signal,
      assertAuthorized: async () => { await options.assertBeforeSend(); await options.engineContext.assertCurrent() },
      showRecoveryDialog: async () => { f.context[key] = 'changed-native-context'; return { response: 1 } },
    })
    sendVelo.handlesComputerAccess = true
    f = await fixture(t, { sendVelo })
    const result = await f.invoke('send', f.payload({ fullAccess: false }))
    assert.equal(result.success, false); assert.equal(result.code, 'CANCELLED'); assert.equal(result.promptNotSent, true)
    assert.equal(turns, 0); assert.equal(f.requests.length, 0); assert.equal(f.editorCalls.length, 0)
  })
})

async function fixture(t, options = {}) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-computer-authority-'))
  const context = { session: 'synthetic-session', projectKey: folder, revision: 1 }
  const handlers = new Map(), requests = [], events = [], confirmations = [], sessions = [], computerCalls = [], editorCalls = []
  const replies = [], account = new AbortController()
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false,
    send: (channel, event) => events.push({ channel, ...event }) })
  const window = { webContents: contents, isDestroyed: () => false }
  const preference = createFullAccessPreference({ filePath: path.join(folder, 'consent.json') })
  let confirmation = approved(), beforeResponse, beforeTool, active = true, cleanupReceipt = { success: true }
  const nativeCurrent = () => { if (!active) throw Object.assign(Error('Synthetic authority revoked.'), { code: 'LUNA_UNAVAILABLE' }) }
  const controller = registerConnectedAgentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    getMainWindow: () => window, app: new EventEmitter(), platform: 'linux', fullAccessPreference: preference,
    getToolContext: async () => ({ context: { ...context } }), getMcpServer: () => ({}),
    fetchImpl: () => assert.fail('No real fetch or provider fallback'),
    codex: { inspect: () => assert.fail('No Codex account inspection'), send: () => assert.fail('No Codex inference') },
    executeTool: () => assert.fail('Synthetic tool session owns editor execution'),
    confirmFullAccess: async info => { confirmations.push(info); return confirmation },
    claimMobileMessageConsent: () => ({ assertCurrent: nativeCurrent }),
    getGenerationSpendingStatus: async () => ({ success: true, scope: 'velorn-managed', policy: 'local-only' }),
    fundedLuna: { beginTurn: async ({ signal }) => ({
      signal: AbortSignal.any([signal, account.signal]), assertCurrent: nativeCurrent,
      status: async () => ({ ok: true, available: true, model: 'gpt-6-luna', remainingMicroUsd: 1000000 }),
      respond: async payload => { requests.push(structuredClone(payload)); await beforeResponse?.(payload); return replies.shift() || response(answer('Synthetic reply.')) },
    }) },
    makeToolSession: async () => ({
      listTools: async () => [editorTool],
      callTool: async (name, args) => { assert.equal(name, editorTool.name); editorCalls.push([name, args]); return { content: [{ type: 'text', text: 'Synthetic editor metadata.' }] } },
      close() {},
    }),
    makeVeloComputerSession: options => {
      const record = { ...options, closes: 0 }; sessions.push(record)
      return {
        listTools: async () => [...await options.toolSession.listTools(), computerTool],
        callTool: async (name, args) => {
          if (name !== computerTool.name) return options.toolSession.callTool(name, args)
          await beforeTool?.(record)
          await options.assertCurrent()
          assert.equal(options.signal.aborted, false)
          computerCalls.push([name, structuredClone(args)])
          return { content: [{ type: 'text', text: 'Synthetic computer result; no command executed.' }] }
        },
        close() { record.closes++; return cleanupReceipt },
      }
    },
    ...options,
  })
  const invoke = (name, payload, event = { sender: contents, senderFrame: contents.mainFrame }) => handlers.get(CHANNELS[name])(event, payload)
  const enable = (extra = {}) => invoke('setFullAccess', { provider: 'luna', enabled: true, conversationId: 'synthetic-chat', expectedContext: { ...context }, ...extra })
  let next = 0
  const payload = (extra = {}) => ({ provider: 'luna', model: 'gpt-6-luna', requestId: `synthetic-turn-${++next}`,
    messages: [{ role: 'user', content: 'Synthetic fixture only.' }], context: {}, conversationId: 'synthetic-chat',
    toolsEnabled: true, expectedContext: { ...context }, ...extra })
  const send = (grant, extra = {}) => invoke('send', payload({ fullAccess: true, fullAccessToken: grant.token, ...extra }))
  const mobile = () => {
    const { capabilities, ...consent } = descriptor('luna', { tools: true, research: false, fullAccess: true, images: false, view: false })
    return { commandId: 'accepted-synthetic-phone-message', consent, view: false }
  }
  t.after(async () => { controller.dispose(); await fs.rm(folder, { recursive: true, force: true }) })
  return { folder, context, window, contents, requests, replies, events, confirmations, sessions, computerCalls, editorCalls, preference,
    invoke, enable, payload, send, mobile, setConfirmation: value => { confirmation = value },
    beforeResponse: fn => { beforeResponse = fn }, beforeTool: fn => { beforeTool = fn },
    revokeAccount: () => { active = false; account.abort() }, markAccountStale: () => { active = false },
    setCleanupReceipt: value => { cleanupReceipt = value } }
}

test('Velo computer authority requires the exact new native scope, never legacy or string approvals', async t => {
  for (const [label, receipt] of [
    ['boolean', true], ['string', 'true'], ['old object', { approved: true, shareImagesAndView: true, remember: true }],
    ['old scope', approved({ scope: LOCAL_CONSENT.scope, version: 1, remember: true })],
    ['string version', approved({ version: '2', remember: true })],
    ['wrong scope', approved({ scope: 'velorn-full-computer-access', remember: true })],
    ['old phone bundle', phoneApproval()], ['not approved', approved({ approved: false, remember: true })],
  ]) await t.test(label, async t => {
    const f = await fixture(t); f.setConfirmation(receipt)
    const result = await f.enable({ scope: VELO_CONSENT.scope, version: 2, computerAccess: true, remember: true })
    failed(result)
    assert.equal(await f.preference.read('luna'), false)
    assert.equal(f.requests.length, 0); assert.equal(f.sessions.length, 0)
  })
})

test('fresh native Velo consent mints an isolated computer grant without inference or an allowance change', async t => {
  const f = await fixture(t); f.setConfirmation(approved({ remember: true }))
  const grant = await f.enable()
  assert.equal(grant.enabled, true); assert.equal(grant.scope, VELO_CONSENT.scope); assert.equal(grant.version, 2)
  assert.equal(grant.remembered, true); assert.equal(await f.preference.read('luna'), true)
  assert.equal(await f.preference.read('codex'), false); assert.equal(await f.preference.read('lmstudio'), false)
  assert.equal(f.requests.length, 0); assert.equal(f.sessions.length, 0)
  assert.equal(f.confirmations.length, 1); assert.equal(f.confirmations[0].fromPhone, false)
})

test('old Velo tools-only remembered consent stays unchanged and cannot restore computer authority', async t => {
  const f = await fixture(t), location = path.join(f.folder, 'consent.json.luna')
  const old = JSON.stringify({ ...LOCAL_CONSENT, provider: 'luna', remembered: true })
  await fs.writeFile(location, old, { mode: 0o600 })
  const result = await f.enable({ restoreOnly: true })
  assert.equal(result.enabled, false); assert.equal(result.remembered, false)
  assert.equal(await fs.readFile(location, 'utf8'), old)
  assert.equal(f.confirmations.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.sessions.length, 0)
})

test('new remembered consent restores a fresh native-scoped grant without reusing live tokens', async t => {
  const f = await fixture(t); f.setConfirmation(approved({ remember: true }))
  const first = await f.enable()
  f.contents.emit('did-start-navigation', {}, 'synthetic', false, true)
  assert.equal((await f.send(first)).code, 'UNAUTHORIZED')
  const restored = await f.enable({ restoreOnly: true })
  assert.equal(restored.enabled, true); assert.equal(restored.scope, VELO_CONSENT.scope); assert.equal(restored.version, 2)
  assert.notEqual(first.token, restored.token); assert.equal(f.confirmations.length, 1)
  assert.equal((await f.send(restored)).success, true)
  assert.equal(f.sessions.length, 1); assert.equal(f.sessions[0].cwd, await fs.realpath(f.folder))
})

test('phone bundle 1 preserves Velorn tools but never remembers or grants desktop computer access', async t => {
  const f = await fixture(t); f.context.projectKey = 'synthetic-unsaved'; f.setConfirmation(phoneApproval())
  const grant = await f.enable({ fromPhone: true })
  assert.equal(grant.enabled, true); assert.equal(grant.remembered, false)
  assert.equal(await f.preference.read('luna'), false)
  assert.equal((await f.send(grant)).code, 'UNAUTHORIZED')
  assert.equal(f.requests.length, 0)
  assert.equal((await f.send(grant, { mobileSharing: f.mobile() })).success, true)
  assert.equal(f.sessions.length, 0); assert.equal(f.computerCalls.length, 0)
  assert.match(f.requests[0].instructions, /not arbitrary computer shell|no arbitrary shell/)
  assert.doesNotMatch(f.requests[0].instructions, /synthetic_computer_command/)
})

test('desktop computer grant does not enlarge an old phone sharing descriptor or route computer tools', async t => {
  const f = await fixture(t), grant = await f.enable()
  f.replies.push(response(call('phone-route', 'call_velorn_tool', { name: computerTool.name, arguments: { value: 'never execute' } })))
  const result = await f.send(grant, { mobileSharing: f.mobile() })
  assert.equal(result.success, false)
  assert.equal(f.sessions.length, 0); assert.equal(f.computerCalls.length, 0); assert.equal(f.editorCalls.length, 0)
  assert.equal(f.requests.length, 1); assert.doesNotMatch(f.requests[0].instructions, /synthetic_computer_command/)
  assert.equal(f.requests[0].tools.some(tool => tool.name === computerTool.name), false)
})

test('old phone cannot smuggle computer tools through discovery or direct names', async t => {
  for (const direct of [false, true]) await t.test(direct ? 'direct' : 'discovery', async t => {
    const f = await fixture(t); f.setConfirmation(phoneApproval())
    const grant = await f.enable({ fromPhone: true })
    f.replies.push(response(direct ? call('direct', computerTool.name, { value: 'never execute' }) : call('discover', 'discover_velorn_tools', { names: [computerTool.name] })))
    await f.send(grant, { mobileSharing: f.mobile() })
    assert.equal(f.sessions.length, 0); assert.equal(f.computerCalls.length, 0)
    assert.ok(f.requests.every(request => !request.tools.some(tool => tool.name === computerTool.name)))
  })
})

test('renderer flags and forged working directories cannot manufacture computer authority in ordinary tool mode', async t => {
  const f = await fixture(t)
  const payload = f.payload({ computerAccess: true, trustedComputerAccess: true, scope: VELO_CONSENT.scope, version: 2,
    workingDirectory: '/synthetic-untrusted', fromPhone: false })
  const checked = validateSend(payload)
  for (const key of ['computerAccess', 'trustedComputerAccess', 'scope', 'version', 'workingDirectory', 'fromPhone']) assert.equal(Object.hasOwn(checked, key), false)
  assert.equal((await f.invoke('send', payload)).success, true)
  assert.equal(f.sessions.length, 0)
  assert.ok(f.requests.every(request => !request.tools.some(tool => tool.name === computerTool.name)))
})

test('native-scoped desktop Velo can route computer work while the relay remains Light and account-independent', async t => {
  const f = await fixture(t), grant = await f.enable()
  f.replies.push(response(call('computer', 'call_velorn_tool', { name: computerTool.name, arguments: { value: 'synthetic' } })), response(answer('Synthetic operation observed.')))
  const result = await f.send(grant, { workingDirectory: '/synthetic-untrusted', reasoningEffort: 'max' })
  assert.equal(result.success, true, JSON.stringify(result)); assert.equal(f.sessions.length, 1)
  assert.equal(f.sessions[0].cwd, await fs.realpath(f.folder)); assert.equal(f.sessions[0].closes, 1)
  assert.deepEqual(f.computerCalls, [[computerTool.name, { value: 'synthetic' }]])
  assert.equal(f.requests.length, 2)
  for (const request of f.requests) {
    assert.equal(request.reasoningEffort, 'low')
    assert.deepEqual(Object.keys(request).sort(), ['input', 'instructions', 'reasoningEffort', 'requestId', 'tools'])
    assert.match(request.instructions, /synthetic_computer_command/)
  }
})

test('account revocation immediately before computer dispatch blocks it and makes no continuation request', async t => {
  const f = await fixture(t), grant = await f.enable()
  f.replies.push(response(call('computer', 'call_velorn_tool', { name: computerTool.name, arguments: { value: 'never execute' } })))
  f.beforeTool(() => f.markAccountStale())
  const result = await f.send(grant)
  assert.equal(result.success, false); assert.equal(f.computerCalls.length, 0); assert.equal(f.requests.length, 1)
  assert.equal(f.sessions[0].closes, 1)
})

test('revoked full access rejects late computer dispatch and closes the native wrapper', async t => {
  const f = await fixture(t), grant = await f.enable()
  f.replies.push(response(call('computer', 'call_velorn_tool', { name: computerTool.name, arguments: { value: 'never execute' } })))
  f.beforeTool(() => f.invoke('setFullAccess', { provider: 'luna', enabled: false, conversationId: 'synthetic-chat' }))
  const result = await f.send(grant)
  assert.equal(result.success, false); assert.equal(f.computerCalls.length, 0); assert.equal(f.requests.length, 1)
  assert.equal(f.sessions[0].closes, 1)
})

test('new computer confirmation cannot run in an unsaved project or a foreign renderer', async t => {
  const f = await fixture(t)
  const foreign = { sender: f.contents, senderFrame: {} }
  assert.equal((await f.invoke('setFullAccess', { provider: 'luna', enabled: true, conversationId: 'synthetic-chat', expectedContext: f.context }, foreign)).code, 'UNAUTHORIZED')
  f.context.projectKey = 'synthetic-unsaved'
  failed(await f.enable())
  assert.equal(f.requests.length, 0); assert.equal(f.sessions.length, 0)
})

test('unvalidated platforms cannot silently acquire new desktop computer authority', async t => {
  for (const platform of ['darwin', 'win32']) await t.test(platform, async t => {
    const f = await fixture(t, { platform })
    const result = await f.enable()
    assert.equal(result.success, false); assert.equal(result.code, 'UNSUPPORTED_PLATFORM')
    assert.equal(f.confirmations.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.sessions.length, 0)
    f.setConfirmation(phoneApproval())
    assert.equal((await f.enable({ fromPhone: true })).enabled, true, 'Existing phone tools-only scope stays compatible')
  })
})

test('a failed cleanup receipt overrides a completed model answer with an explicit failure', async t => {
  for (const receipt of [{ success: false, survivingProcessCount: 1 }, undefined]) await t.test(String(receipt?.success), async t => {
    const f = await fixture(t), grant = await f.enable()
    f.setCleanupReceipt(receipt)
    const result = await f.send(grant)
    assert.equal(result.success, false); assert.equal(result.code, 'COMPUTER_CLEANUP_FAILED')
    assert.equal(f.requests.length, 1); assert.equal(f.sessions[0].closes, 1)
    assert.equal(result.text, undefined)
  })
})

test('Stop cannot acknowledge successful cleanup when the native session reports survivors', async t => {
  const f = await fixture(t), grant = await f.enable()
  f.setCleanupReceipt({ success: false, survivingProcessCount: 1 })
  let release
  f.beforeResponse(() => new Promise(resolve => { release = resolve }))
  const pending = f.send(grant)
  for (let attempt = 0; attempt < 100 && !release; attempt++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof release, 'function')
  const result = await f.invoke('cancel', { requestId: 'synthetic-turn-1' })
  assert.equal(result.success, false); assert.equal(result.code, 'COMPUTER_CLEANUP_FAILED')
  release()
  assert.equal((await pending).code, 'COMPUTER_CLEANUP_FAILED')
  assert.equal(f.computerCalls.length, 0); assert.equal(f.requests.length, 1)
})

test('phone activation cannot persist computer consent even if a callback contains new scope fields', async t => {
  const f = await fixture(t); f.setConfirmation({ ...approved({ remember: true }), ...phoneApproval() })
  const grant = await f.enable({ fromPhone: true, computerAccess: true, scope: VELO_CONSENT.scope, version: 2 })
  assert.equal(grant.enabled, true); assert.equal(grant.scope, LOCAL_CONSENT.scope); assert.equal(grant.version, 1)
  assert.equal(grant.remembered, false); assert.equal(await f.preference.read('luna'), false)
  assert.equal((await f.send(grant)).code, 'UNAUTHORIZED'); assert.equal(f.sessions.length, 0)
})

test('project replacement between model output and computer dispatch invalidates the native authority', async t => {
  const f = await fixture(t), grant = await f.enable()
  f.replies.push(response(call('computer', 'call_velorn_tool', { name: computerTool.name, arguments: { value: 'never execute' } })))
  f.beforeTool(() => { f.context.session = 'replacement-project-session' })
  const result = await f.send(grant)
  assert.equal(result.success, false); assert.equal(f.computerCalls.length, 0); assert.equal(f.requests.length, 1)
  assert.equal(f.sessions[0].closes, 1)
})

test('private computer tool names are not registered on the public editor MCP server', () => {
  const { TOOLS } = require('../electron/veloComputerTools.cjs')
  const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
  const publicTools = new Set(createComfyStudioMcpServer().tools.map(tool => tool.name))
  for (const tool of TOOLS) assert.equal(publicTools.has(tool.name), false, `${tool.name} must require the private native grant`)
})

test('native composition refuses a public catalog shadowing a computer tool and cleans up', async () => {
  const { createVeloComputerSession } = require('../electron/veloComputerSession.cjs')
  let closed = 0
  await assert.rejects(createVeloComputerSession({ cwd: '/synthetic', signal: new AbortController().signal,
    assertCurrent: async () => {}, toolSession: { listTools: async () => [computerTool], callTool: () => assert.fail('No execution') },
    makeComputerTools: () => ({ tools: [computerTool], callTool: () => assert.fail('No execution'), close: async () => { closed++; return { success: true } } }),
  }), /conflicts with the editor catalog/)
  assert.equal(closed, 1)
})

test('known surviving processes cannot be reported as successful native cleanup', async () => {
  const { createVeloComputerSession } = require('../electron/veloComputerSession.cjs')
  const session = await createVeloComputerSession({ cwd: '/synthetic', signal: new AbortController().signal,
    assertCurrent: async () => {}, toolSession: { listTools: async () => [editorTool], callTool: () => assert.fail('No execution') },
    makeComputerTools: () => ({ tools: [computerTool], callTool: () => assert.fail('No execution'),
      close: async () => ({ success: false, survivingProcessCount: 1 }) }),
  })
  await assert.rejects(session.close(), error => error.code === 'COMPUTER_CLEANUP_FAILED')
})

// Optional local integration with an existing, independently reviewed relay
// checkout. No private relay code is copied into this distributable source and
// the validator is a pure function: no service, ledger, credential or API calls.
test('real computer schemas and paged results pass the existing relay without a protocol change', {
  skip: process.env.VELORN_TEST_RELAY_VALIDATOR_PATH ? false : 'Private relay validator checkout not supplied',
}, async t => {
  const { pathToFileURL } = require('node:url')
  const validatorPath = process.env.VELORN_TEST_RELAY_VALIDATOR_PATH
  assert.equal(path.isAbsolute(validatorPath), true)
  const { validateFundedLunaRequest } = await import(pathToFileURL(validatorPath).href)
  const { TOOLS } = require('../electron/veloComputerTools.cjs')
  const { sendLuna } = require('../electron/connectedAgentLuna.cjs')
  const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
  const catalog = [...createComfyStudioMcpServer().tools, ...TOOLS]
  const requests = [], calls = [], replies = [
    response(call('discover-computer', 'discover_velorn_tools', { names: TOOLS.map(tool => tool.name) })),
    response(call('read-synthetic', 'read_computer_file', { path: '/synthetic/no-real-read' })),
    response(answer('Synthetic relay compatibility verified.')),
  ]
  const result = await sendLuna({ provider: 'luna', model: 'gpt-6-luna', requestId: 'synthetic-relay-check',
    context: '{}', messages: [{ role: 'user', content: 'Only a synthetic compatibility test.' }], toolsEnabled: true,
  }, { computerAccess: true, instructions: 'Synthetic local check; do not execute real operations.',
    fundedLuna: {
      status: async () => ({ ok: true, available: true, model: 'gpt-6-luna', remainingMicroUsd: 1000000 }),
      respond: async payload => {
        const checked = validateFundedLunaRequest({ computerId: 'synthetic_computer_001', ...payload })
        assert.equal(Number.isSafeInteger(checked.reserveMicroUsd), true)
        assert.equal(payload.reasoningEffort, 'low'); requests.push(structuredClone(payload)); return replies.shift()
      },
    }, toolSession: { listTools: async () => catalog, callTool: async (...args) => {
      calls.push(args)
      return { content: [{ type: 'text', text: 'Synthetic untrusted file bytes. '.repeat(10000) }] }
    } },
  })
  assert.equal(result.success, true); assert.equal(requests.length, 3); assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['read_computer_file', { path: '/synthetic/no-real-read' }])
  for (const tool of TOOLS) assert.equal(requests[1].tools.some(item => item.name === tool.name), true)
  const output = requests[2].input.find(item => item.type === 'function_call_output' && item.call_id === 'read-synthetic')
  assert.ok(output); assert.ok(Buffer.byteLength(output.output) < 96 * 1024)
  t.diagnostic(`Validated ${catalog.length} native definitions through ${requests.length} synthetic relay payloads; no network or real tool execution.`)
})

test('service recovery rechecks full computer project/account authority and preserves only the native wait marker', async t => {
  for (const change of ['project', 'account']) await t.test(change, async t => {
    const f = await fixture(t), grant = await f.enable()
    let changed = false
    const originalSend = f.contents.send
    f.contents.send = (channel, event) => {
      originalSend(channel, event)
      if (event.type === 'status' && event.waitingFor === 'velo-service' && !changed) {
        changed = true
        if (change === 'project') f.context.session = 'replacement-project-session'
        else f.revokeAccount()
      }
    }
    f.beforeResponse(payload => { throw markPreDispatchRefusal(Object.assign(Error('synthetic pre-dispatch refusal'), { code: 'LUNA_BUSY' }),
      { requestId: payload.requestId, reason: 'busy', retryAfter: '1' }) })
    const result = await f.send(grant)
    assert.equal(result.success, false)
    assert.equal(result.code, change === 'project' ? 'STALE_APPROVAL' : 'CANCELLED', JSON.stringify(result))
    assert.equal(changed, true); assert.equal(f.requests.length, 1); assert.equal(f.computerCalls.length, 0)
    const statuses = f.events.filter(event => event.type === 'status')
    assert.ok(statuses.some(event => event.waitingFor === 'velo-service' && /Stop to cancel/.test(event.text)))
    assert.ok(statuses.some(event => !Object.hasOwn(event, 'waitingFor')))
    for (const event of statuses) {
      assert.equal(Object.hasOwn(event, 'remainingSeconds'), false)
      assert.equal(Object.hasOwn(event, 'retryAfterMs'), false)
    }
  })
})

test('Stop releases a Velo turn blocked in full computer context revalidation after a service wait', async t => {
  let f, block = false, release, reached
  const inspecting = new Promise(resolve => { reached = resolve })
  f = await fixture(t, { getToolContext: () => block ? new Promise(resolve => { release = resolve; reached() }) : Promise.resolve({ context: { ...f.context } }) })
  const grant = await f.enable()
  const originalSend = f.contents.send
  f.contents.send = (channel, event) => {
    originalSend(channel, event)
    if (event.type === 'status' && event.waitingFor === 'velo-service') block = true
  }
  f.beforeResponse(payload => { throw markPreDispatchRefusal(Object.assign(Error('synthetic refusal'), { code: 'LUNA_BUSY' }),
    { requestId: payload.requestId, reason: 'busy', retryAfter: '1' }) })
  const operation = f.send(grant)
  await inspecting
  const stopped = await f.invoke('cancel', { requestId: 'synthetic-turn-1' })
  assert.equal(stopped.success, true)
  const result = await operation
  assert.equal(result.success, false); assert.equal(result.code, 'CANCELLED')
  release({ context: { ...f.context } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.requests.length, 1); assert.equal(f.computerCalls.length, 0)
})
