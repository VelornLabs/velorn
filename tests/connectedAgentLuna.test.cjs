'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { VELO_CONSENT } = require('../electron/connectedAgentAccessPreference.cjs')
const { sendLuna, inspectLuna, MODEL, LIMITS, lunaPromptWasNotSent, lunaContextLimitDiagnostics } = require('../electron/connectedAgentLuna.cjs')
const { registerConnectedAgentIpc, CHANNELS, validateSend } = require('../electron/connectedAgent.cjs')
const request = extra => ({ provider: 'luna', model: MODEL, requestId: 'native-request', context: '{}', messages: [{ role: 'user', content: 'Inspect this project.' }], ...extra })
const call = (call_id, name = 'get_project', args = {}) => ({ type: 'function_call', call_id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })
const answer = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
const response = (...output) => ({ ok: true, model: MODEL, output, remainingMicroUsd: 500000 })
const catalog = [
  { name: 'get_project', description: 'Read the project.', inputSchema: { type: 'object', properties: {} } },
  { name: 'project_edit', description: 'Edit after host approval.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
]
function fixture(replies = [response(answer('Ready.'))], run = async () => ({ content: [{ type: 'text', text: 'Observed' }] })) {
  const requests = [], calls = [], events = []
  return { requests, calls, events, onEvent: event => events.push(event),
    fundedLuna: { status: async () => ({ ok: true, model: MODEL, available: true, remainingMicroUsd: 1000000 }), respond: async payload => {
      requests.push(structuredClone(payload)); const reply = replies.shift(); if (reply instanceof Error) throw reply; return reply
    } },
    toolSession: { listTools: async () => catalog, callTool: async (...args) => { calls.push(args); return run(...args) } } }
}
const rejects = (operation, code) => assert.rejects(operation, error => error.code === code)
test('status validates percentage projection and strips extra private fields before renderer IPC', async () => {
  const allowance = { remainingPercent: 97.2, pending: true, poolLimited: false }
  const status = { ok: true, available: true, model: MODEL, allowance: { ...allowance, privateField: 'never renderer' } }
  const fundedLuna = { status: async () => status }
  assert.deepEqual((await inspectLuna({}, { fundedLuna })).allowance, allowance)
  for (const invalid of [null, { ...allowance, remainingPercent: NaN }, { ...allowance, remainingPercent: -1 },
    { ...allowance, remainingPercent: 101 }, { ...allowance, pending: 'yes' }, { ...allowance, poolLimited: null }]) {
    status.allowance = invalid; assert.equal((await inspectLuna({}, { fundedLuna })).allowance, undefined)
  }
  status.allowance = allowance; status.available = false; status.reason = 'allowance_exhausted'
  assert.deepEqual((await inspectLuna({}, { fundedLuna })).allowance, allowance)
  status.reason = 'not_eligible'; assert.equal((await inspectLuna({}, { fundedLuna })).allowance, undefined)
})

test('Velo desktop full computer access requires new native confirmation and retains editor tool behavior', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'velo-native-full-scope-'))
  t.after(() => fs.rmdir(folder))
  const deps = fixture(), events = [], owner = { session: 'fixture', projectKey: folder, revision: 1 }
  const f = ipcFixture({ fundedLuna: deps.fundedLuna, getToolContext: async () => owner,
    confirmFullAccess: async ({ provider }) => { assert.equal(provider, 'luna'); return { approved: true, shareImagesAndView: true, remember: false, scope: VELO_CONSENT.scope, version: VELO_CONSENT.version } },
    getMcpServer: () => ({}), executeTool: () => assert.fail('No real operation'),
    makeToolSession: async options => { events.push(options); return deps.toolSession },
  })
  try {
    const missing = await f.call('send', request({ context: {}, toolsEnabled: true, fullAccess: true, conversationId: 'review-chat', fullAccessToken: 'missing', expectedContext: owner }))
    assert.equal(missing.success, false); assert.equal(deps.requests.length, 0)
    const grant = await f.call('setFullAccess', { provider: 'luna', enabled: true, conversationId: 'review-chat', expectedContext: owner, shareImagesAndView: true })
    assert.equal(grant.enabled, true)
    const result = await f.call('send', request({ context: {}, toolsEnabled: true, vision: true, fullAccess: true, conversationId: 'review-chat', fullAccessToken: grant.token, expectedContext: owner }))
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(events[0].trustedFullAccess, true); assert.equal(events[0].allowImages, true)
    assert.match(deps.requests[0].instructions, /All available Velorn tools run automatically/)
    assert.match(deps.requests[0].instructions, /Rendering\/export does not require sending images/)
    assert.match(deps.requests[0].instructions, /native computer commands/)
    assert.match(deps.requests[0].instructions, /run_computer_command/)
    assert.doesNotMatch(deps.requests[0].instructions, /Codex also has native commands/)
  } finally { f.controller.dispose() }
})
test('Luna inspection is separate from inference, clamps unsafe status data and never uses another provider', async () => {
  const deps = fixture()
  assert.equal((await inspectLuna({}, deps)).models[0].id, MODEL)
  assert.deepEqual((await inspectLuna({}, deps)).models[0].supportedReasoningEfforts.map(x => x.reasoningEffort), ['low'])
  assert.equal((await inspectLuna({}, deps)).models[0].defaultReasoningEffort, 'low')
  assert.equal(deps.requests.length, 0)
  deps.fundedLuna.status = async () => ({ ok: true, available: false, model: MODEL, reason: 'no_entitlement', remainingMicroUsd: -3, credential: 'never-render' })
  const result = await inspectLuna({}, deps)
  assert.equal(result.status, 'not-eligible'); assert.equal(result.available, false)
  assert.equal(result.remainingMicroUsd, undefined); assert.equal(result.credential, undefined)
  assert.equal((await inspectLuna({})).status, 'unavailable')
})
test('funded and local agents retain identical editor privileges and tool definitions in Work in Velorn', async () => {
  const owner = { session: 'fixture', projectKey: 'unsaved-project', revision: 1 }
  const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
  const server = createComfyStudioMcpServer()
  // Velo desktop Full access now additionally supplies private computer tools;
  // its separate authority suite checks that expanded, explicitly granted mode.
  for (const fullAccess of [false]) {
    const observed = []
    for (const provider of ['lmstudio', 'luna']) {
      const deps = fixture(), records = { native: null, tools: null }
      const saveTools = tools => { records.tools = tools.map(tool => tool.function || tool).map(({ name, parameters }) => ({ name, parameters })) }
      const respond = deps.fundedLuna.respond
      deps.fundedLuna.respond = payload => { saveTools(payload.tools); return respond(payload) }
      const f = ipcFixture({ fundedLuna: deps.fundedLuna, getToolContext: async () => owner,
        getMcpServer: () => server, executeTool: () => assert.fail('No real operation'),
        makeResearchAccess: () => ({ catalog: native => native, has: () => false }),
        confirmFullAccess: async () => ({ approved: true, shareImagesAndView: true, remember: false }),
        makeToolSession: async options => {
          records.native = { trustedFullAccess: options.trustedFullAccess, allowImages: options.allowImages,
            autoApproveEdits: options.autoApproveEdits, expectedContext: options.expectedContext }
          return { listTools: async () => options.getServer().tools, callTool: () => assert.fail('No real operation') }
        },
        fetchImpl: async (_url, options) => {
          saveTools(JSON.parse(options.body).tools)
          return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Ready.' }, finish_reason: 'stop' }] }))
        },
      })
      try {
        const grant = fullAccess ? await f.call('setFullAccess', { provider, enabled: true, conversationId: 'parity-chat', expectedContext: owner, shareImagesAndView: true }) : null
        if (fullAccess) assert.equal(grant.enabled, true)
        const result = await f.call('send', request({ provider, model: provider === 'luna' ? MODEL : 'local-model',
          ...(provider === 'lmstudio' ? { endpoint: 'http://127.0.0.1:1234/v1' } : {}),
          context: {}, toolsEnabled: true, vision: true, allowToolImages: true, researchEnabled: true,
          autoApproveEdits: true, expectedContext: owner, fullAccess, conversationId: 'parity-chat',
          ...(grant ? { fullAccessToken: grant.token } : {}),
        }))
        assert.equal(result.success, true, JSON.stringify(result))
        assert.ok(records.tools.some(tool => tool.name === 'call_velorn_tool'))
        observed.push(records)
      } finally { f.controller.dispose() }
    }
    assert.deepEqual(observed[1], observed[0], `Native privilege/catalog mismatch in fullAccess=${fullAccess}`)
  }
})
test('Luna sends only the fixed broker contract and no credentials, overrides or personal API requests', async () => {
  const deps = fixture()
  const result = await sendLuna(request(), deps)
  assert.equal(result.text, 'Ready.'); assert.equal(result.model, MODEL)
  assert.deepEqual(Object.keys(deps.requests[0]).sort(), ['input', 'instructions', 'reasoningEffort', 'requestId', 'tools'])
  assert.equal(deps.requests[0].reasoningEffort, 'low')
  assert.deepEqual(deps.requests[0].tools, [])
  assert.equal(deps.requests[0].input[0].type, 'message')
  assert.match(deps.requests[0].input[0].content, /project snapshot.*\n/s)
})
test('Velo pins Light for omitted and legacy efforts at native validation and every tool round', async () => {
  for (const effort of [undefined, 'none', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const input = request({ reasoningEffort: effort })
    const before = structuredClone(input)
    assert.equal(validateSend({ ...input, context: {} }).reasoningEffort, 'low')
    const deps = fixture([response(call('read')), response(answer('Done.'))])
    await sendLuna({ ...input, toolsEnabled: true }, deps)
    assert.deepEqual(deps.requests.map(item => item.reasoningEffort), ['low', 'low'])
    assert.deepEqual(deps.calls, [['get_project', {}]])
    assert.deepEqual(input, before, 'No saved caller state is rewritten')
  }
})
test('unsupported model and endpoint overrides stop before inference', async () => {
  for (const value of [{ model: 'other' }, { model: 0 }, { model: false }, { endpoint: 'https://example.invalid' }, { endpoint: '' }, { reasoningEffort: 'invalid' }]) {
    const deps = fixture()
    await rejects(sendLuna(request(value), deps), 'LUNA_OPTIONS_UNSUPPORTED')
    assert.equal(deps.requests.length, 0)
  }
})
test('a fresh native entitlement check blocks exhausted/revoked access and marks only no-prompt failures', async () => {
  const deps = fixture()
  deps.fundedLuna.status = async () => ({ ok: true, model: MODEL, available: false, reason: 'budget_exhausted' })
  await assert.rejects(sendLuna(request(), deps), error => error.code === 'LUNA_EXHAUSTED' && lunaPromptWasNotSent(error))
  assert.equal(deps.requests.length, 0)
  deps.fundedLuna.status = async () => ({ ok: true, model: MODEL, available: true })
  deps.fundedLuna.respond = async () => { throw Object.assign(new Error('Server-specific sensitive text'), { code: 'LUNA_EXHAUSTED' }) }
  await assert.rejects(sendLuna(request(), deps), error => error.code === 'LUNA_EXHAUSTED' && !lunaPromptWasNotSent(error) && !error.message.includes('sensitive'))
})
test('router/discovery and multiple tool calls dispatch sequentially through the supplied native session', async () => {
  let active = false
  const deps = fixture([
    response(call('lookup', 'discover_velorn_tools', { names: ['project_edit'] })),
    response(call('read'), call('edit', 'project_edit', { name: 'Approved edit' })), response(answer('Done after host results.')),
  ], async () => { assert.equal(active, false); active = true; await new Promise(resolve => setImmediate(resolve)); active = false; return { content: [{ type: 'text', text: 'confirmed' }] } })
  const result = await sendLuna(request({ toolsEnabled: true }), deps)
  assert.equal(result.text, 'Done after host results.')
  assert.deepEqual(deps.calls, [['get_project', {}], ['project_edit', { name: 'Approved edit' }]])
  assert.ok(deps.requests[0].tools.some(tool => tool.name === 'call_velorn_tool' && tool.strict === false && !tool.function))
  assert.ok(deps.requests[1].tools.some(tool => tool.name === 'project_edit'))
  assert.deepEqual(deps.requests[2].input.filter(item => item.type === 'function_call_output').map(item => item.call_id), ['lookup', 'read', 'edit'])
  assert.equal(new Set(deps.requests.map(item => item.requestId)).size, 3)
})
test('all malformed calls are rejected before any call from their batch runs', async () => {
  for (const bad of [call('bad', 'get_project', '{'), call('bad', 'get_project', []), call('read'), call('bad', 'not_in_catalog'),
    call('bad', 'call_velorn_tool', { name: 'project_edit', arguments: {}, extra: true }),
    { ...call('bad'), arguments: '[]' }, { ...call('bad'), type: 'custom_tool_call' }]) {
    const deps = fixture([response(call('read'), bad)])
    await rejects(sendLuna(request({ toolsEnabled: true }), deps), 'LUNA_INVALID_RESPONSE')
    assert.equal(deps.calls.length, 0)
  }
})
test('tool images become typed input only when sharing is enabled; otherwise carry an explicit omission', async () => {
  for (const allowToolImages of [true, false]) {
    const deps = fixture([response(call('read')), response(answer('Reviewed.'))], async () => ({ content: [{ type: 'image', mimeType: 'image/png', data: 'abcd' }] }))
    await sendLuna(request({ toolsEnabled: true, vision: true, allowToolImages }), deps)
    assert.equal(deps.requests.length, 2)
    const parts = deps.requests[1].input.flatMap(item => Array.isArray(item.content) ? item.content : [])
    assert.equal(parts.filter(p => p.type === 'input_image').length, allowToolImages ? 1 : 0)
    assert.match(deps.requests[1].input.find(item => item.type === 'function_call_output').output, allowToolImages ? /image attached/i : /not shared/i)
  }
})
test('denied host tool results are preserved and no automatic replay is performed', async () => {
  const deps = fixture([response(call('edit', 'call_velorn_tool', { name: 'project_edit', arguments: { name: 'x' } })), response(answer('The edit was denied.'))],
    async () => ({ isError: true, content: [{ type: 'text', text: 'User denied this action.' }] }))
  await sendLuna(request({ toolsEnabled: true }), deps)
  assert.equal(deps.calls.length, 1)
  assert.match(deps.requests[1].input.at(-1).output, /User denied this action/)
})
test('uncertain tool failure stops the remaining batch and prevents a paid retry', async () => {
  const deps = fixture([response(call('first'), call('second'))], async () => { throw Error('uncertain side effect') })
  await rejects(sendLuna(request({ toolsEnabled: true }), deps), 'LUNA_TOOL_UNCERTAIN')
  assert.equal(deps.calls.length, 1); assert.equal(deps.requests.length, 1)
})
test('duplicate tool call IDs on a later response cannot apply an edit twice', async () => {
  const edit = call('one', 'call_velorn_tool', { name: 'project_edit', arguments: { name: 'x' } })
  const deps = fixture([response(edit), response(edit)])
  await rejects(sendLuna(request({ toolsEnabled: true }), deps), 'LUNA_INVALID_RESPONSE')
  assert.equal(deps.calls.length, 1); assert.equal(deps.requests.length, 2)
})
test('cost exhaustion after an edit preserves prior actions and never retries', async () => {
  const deps = fixture([response(call('one')), Object.assign(Error('budget'), { code: 'LUNA_EXHAUSTED' })])
  await rejects(sendLuna(request({ toolsEnabled: true }), deps), 'LUNA_EXHAUSTED')
  assert.equal(deps.calls.length, 1); assert.equal(deps.requests.length, 2)
})
test('cancellation before a late response prevents tools and further paid dispatch', async () => {
  const controller = new AbortController(), deps = fixture()
  deps.fundedLuna.respond = async () => { controller.abort(); return response(call('one')) }
  await rejects(sendLuna(request({ toolsEnabled: true }), { ...deps, signal: controller.signal }), 'CANCELLED')
  assert.equal(deps.calls.length, 0)
})
test('cancellation between tools stops the rest of a batch', async () => {
  const controller = new AbortController()
  const deps = fixture([response(call('one'), call('two'))], async () => { controller.abort(); return { content: [] } })
  await rejects(sendLuna(request({ toolsEnabled: true }), { ...deps, signal: controller.signal }), 'CANCELLED')
  assert.equal(deps.calls.length, 1); assert.equal(deps.requests.length, 1)
})
test('bounded requests stop without sending, truncating user context or silently changing the model', async () => {
  const deps = fixture()
  await rejects(sendLuna(request({ context: 'x'.repeat(LIMITS.requestBytes), messages: [{ role: 'user', content: 'x'.repeat(LIMITS.requestBytes) }] }), deps), 'LUNA_REQUEST_LIMIT')
  assert.equal(deps.requests.length, 0)
})
test('native context-limit diagnostics contain only bounded-protocol counts, not request contents or provider claims', async () => {
  const deps = fixture(), secret = 'private-fixture-marker'
  await assert.rejects(sendLuna(request({ messages: [{ role: 'user', content: secret + 'x'.repeat(200000) }] }), deps), error => {
    const d = lunaContextLimitDiagnostics(error)
    assert.equal(error.code, 'LUNA_REQUEST_LIMIT')
    assert.equal(d.violation, 'message')
    assert.ok(d.contextBytes > d.limitBytes)
    assert.deepEqual(Object.keys(d).sort(), ['archivedResults','contextBytes','inputItems','limitBytes','toolCount','violation','wireBytes'].sort())
    assert.equal(d.inputItems, 1); assert.equal(d.toolCount, 0); assert.equal(d.archivedResults, 0)
    assert.equal(Object.isFrozen(d), true)
    assert.doesNotMatch(JSON.stringify(d), /private-fixture-marker|instructions|content|credential|path/)
    return true
  })
  assert.equal(deps.requests.length, 0)
  assert.equal(lunaContextLimitDiagnostics({ code: 'LUNA_REQUEST_LIMIT', requestBudget: { violation: secret } }), undefined)
})
test('a long tool turn still stops at allowance exhaustion without replaying any action', async () => {
  const deps = fixture([...Array.from({ length: 35 }, (_, index) => response(call(`call_${index}`))), Object.assign(Error('budget'), { code: 'LUNA_EXHAUSTED' })])
  await rejects(sendLuna(request({ toolsEnabled: true }), deps), 'LUNA_EXHAUSTED')
  assert.equal(deps.requests.length, 36); assert.equal(deps.calls.length, 35)
})
test('native approval waiting pauses the owner deadline and always unsubscribes', async () => {
  for (const fail of [false, true]) {
    const waiting = [], deps = fixture([response(call('approval')), response(answer('Done.'))])
    let notify, subscriptions = 0
    deps.toolSession.subscribeUserWaiting = listener => { notify = listener; subscriptions++; return () => { subscriptions-- } }
    deps.toolSession.callTool = async () => {
      notify(true)
      if (fail) throw Error('Approval interrupted')
      notify(false)
      return { content: [] }
    }
    const operation = sendLuna(request({ toolsEnabled: true }), { ...deps, onWaiting: value => waiting.push(value) })
    if (fail) await rejects(operation, 'LUNA_TOOL_UNCERTAIN')
    else await operation
    assert.equal(subscriptions, 0)
    assert.equal(waiting[0], true); assert.equal(waiting.at(-1), false)
  }
})
test('no-tools chat refuses function calls and arbitrary provider output', async () => {
  for (const result of [response(call('x')), response({ type: 'reasoning', summary: [] }), response(answer('')), { ...response(answer('hi')), model: 'other' }]) {
    const deps = fixture([result])
    await rejects(sendLuna(request(), deps), 'LUNA_INVALID_RESPONSE')
    assert.equal(deps.calls.length, 0); assert.equal(deps.requests.length, 1)
  }
})
function ipcFixture(options = {}) {
  const handlers = new Map(), events = []
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: (...args) => events.push(args) })
  const window = { webContents: contents, isDestroyed: () => false }
  if (options.fundedLuna && !options.fundedLuna.beginTurn) options.fundedLuna.beginTurn = async ({ signal }) => ({ ...options.fundedLuna, signal, assertCurrent: () => { if (signal.aborted) throw Object.assign(Error('cancelled'), { code: 'CANCELLED' }) } })
  const controller = registerConnectedAgentIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) }, getMainWindow: () => window, app: new EventEmitter(), ...options })
  return { controller, events, call: (name, value) => handlers.get(CHANNELS[name])({ sender: contents, senderFrame: contents.mainFrame }, value) }
}
test('account-panel availability is coalesced, status-only and independent of provider inspection', async () => {
  let release, calls = 0, inspected = 0
  const f = ipcFixture({ fundedLuna: {
    status: () => { calls++; return new Promise(resolve => { release = resolve }) },
    respond: () => assert.fail('An account-panel check must never spend or send'),
  }, codex: { inspect: async () => { inspected++; return { success: true, available: true } }, send: () => assert.fail('No fallback') } })
  try {
    const first = f.call('veeAvailability'), second = f.call('veeAvailability')
    assert.equal((await f.call('inspect', { provider: 'codex' })).available, true)
    assert.equal(inspected, 1); assert.equal(calls, 1)
    const restore = await f.call('setFullAccess', { provider: 'luna', enabled: true, restoreOnly: true, conversationId: 'synthetic-restore' })
    assert.equal(restore.success, true, 'Background allowance read must not block ordinary settings')
    assert.equal(restore.enabled, false, 'A read cannot grant or restore unremembered access')
    const allowance = { remainingPercent: 95.2, pending: false, poolLimited: false }
    release({ ok: true, available: true, model: MODEL, remainingMicroUsd: 123, token: 'secret', allowance: { ...allowance, secret: 'hidden' } })
    const expected = { success: true, provider: 'luna', available: true, status: 'eligible', allowance }
    assert.deepEqual(await first, expected); assert.deepEqual(await second, expected)
    assert.equal((await f.call('veeAvailability', { accountId: 'other' })).success, false)
    assert.equal(calls, 1)
  } finally { f.controller.dispose() }
})

test('native IPC selects Luna without fallback and requires ordinary native access consent', async () => {
  const deps = fixture(), f = ipcFixture({ fundedLuna: deps.fundedLuna, fetchImpl: () => assert.fail('No LM fallback'), codex: { inspect: () => assert.fail('No Codex'), send: () => assert.fail('No Codex') } })
  try {
    assert.equal((await f.call('inspect', { provider: 'luna' })).available, true)
    const result = await f.call('send', request({ context: {} }))
    assert.equal(result.success, true)
    assert.equal((await f.call('setFullAccess', { provider: 'luna', enabled: true })).success, false)
    assert.equal((await f.call('getFullAccessPreference', { provider: 'luna' })).remembered, false)
    for (const supported of [{ autoApproveEdits: true }, { researchEnabled: true }, { vision: true }]) {
      assert.doesNotThrow(() => validateSend(request({ context: {}, toolsEnabled: true, expectedContext: { session: 'fixture', revision: 1 }, ...supported })))
    }
    assert.throws(() => validateSend(request({ context: {}, endpoint: 'http://127.0.0.1:1234/v1' })), error => error.code === 'LUNA_OPTIONS_UNSUPPORTED')
  } finally { f.controller.dispose() }
})
test('native IPC preserves unsupported-account draft evidence without fabricating delivered response', async () => {
  const f = ipcFixture({ fundedLuna: { status: async () => ({ ok: true, model: MODEL, available: false, reason: 'no_entitlement' }), respond: () => assert.fail('No inference') } })
  try {
    const result = await f.call('send', request({ context: {} }))
    assert.equal(result.success, false); assert.equal(result.promptNotSent, true); assert.equal(result.code, 'LUNA_NOT_ELIGIBLE')
  } finally { f.controller.dispose() }
})
test('account replacement aborts a pending native approval and never dispatches its edit', async () => {
  const authority = new AbortController(), deps = fixture([response(call('edit', 'call_velorn_tool', { name: 'project_edit', arguments: { name: 'x' } }))])
  let approvalWaiting = false, edits = 0
  deps.fundedLuna.beginTurn = async ({ signal }) => ({ ...deps.fundedLuna, signal: AbortSignal.any([signal, authority.signal]),
    assertCurrent: () => { if (authority.signal.aborted) throw Object.assign(Error('account changed'), { code: 'LUNA_UNAVAILABLE' }) } })
  const f = ipcFixture({ fundedLuna: deps.fundedLuna, getMcpServer: () => ({}), getToolContext: async () => ({}), executeTool: () => assert.fail('Mock session owns dispatch'),
    makeToolSession: async ({ signal, requestApproval, trustedFullAccess, autoApproveEdits, allowImages }) => {
      assert.equal(trustedFullAccess, false); assert.equal(autoApproveEdits, false); assert.equal(allowImages, false)
      return { listTools: async () => catalog, callTool: async () => {
        approvalWaiting = true
        const approved = await requestApproval({ tool: 'project_edit', text: 'Approve fixture edit?' })
        if (approved && !signal.aborted) edits++
        return { content: [{ type: 'text', text: 'fixture completed' }] }
      } }
    } })
  try {
    const pending = f.call('send', request({ context: {}, toolsEnabled: true, expectedContext: { session: 'fixture', revision: 1 } }))
    for (let i = 0; i < 20 && !approvalWaiting; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(approvalWaiting, true)
    authority.abort()
    const result = await pending
    assert.equal(result.success, false); assert.equal(result.cancelled, true); assert.equal(edits, 0)
    const approval = f.events.map(([, value]) => value).find(value => value.type === 'approval')
    assert.ok(approval)
    assert.equal((await f.call('approveTool', { requestId: 'native-request', approvalId: approval.approvalId, approved: true })).code, 'STALE_APPROVAL')
    assert.equal(deps.requests.length, 1)
  } finally { f.controller.dispose() }
})
test('native lease is mandatory and an already-revoked lease never sends an inference request', async () => {
  const deps = fixture(), authority = new AbortController(); authority.abort()
  deps.fundedLuna.beginTurn = async () => ({ ...deps.fundedLuna, signal: authority.signal, assertCurrent: () => {} })
  const f = ipcFixture({ fundedLuna: deps.fundedLuna })
  try {
    const result = await f.call('send', request({ context: {} }))
    assert.equal(result.success, false); assert.equal(deps.requests.length, 0)
  } finally { f.controller.dispose() }
})
test('native executeTool rechecks account authority after approval even before cancellation notification', async () => {
  let current = true, hostDispatches = 0
  const deps = fixture([response(call('edit', 'call_velorn_tool', { name: 'project_edit', arguments: { name: 'x' } }))])
  deps.fundedLuna.beginTurn = async ({ signal }) => ({ ...deps.fundedLuna, signal, assertCurrent: () => {
    if (!current) throw Object.assign(Error('account changed'), { code: 'LUNA_UNAVAILABLE' })
  } })
  const f = ipcFixture({ fundedLuna: deps.fundedLuna, getMcpServer: () => ({}), getToolContext: async () => ({}),
    executeTool: () => { hostDispatches++; return { content: [] } },
    makeToolSession: async ({ executeTool }) => ({ listTools: async () => catalog, callTool: async (name, args) => {
      current = false // An account change arrived while a simulated approval was open.
      return executeTool(name, args, {})
    } }) })
  try {
    const result = await f.call('send', request({ context: {}, toolsEnabled: true, expectedContext: { session: 'fixture', revision: 1 } }))
    assert.equal(result.success, false); assert.equal(hostDispatches, 0); assert.equal(deps.requests.length, 1)
  } finally { f.controller.dispose() }
})
