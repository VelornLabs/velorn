'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { EventEmitter } = require('node:events')
const { createToolReceiptLedger, sanitizeToolReceipts, LIMIT } = require('../electron/connectedAgentReceipts.cjs')
const { createAgentDispatchScope } = require('../electron/connectedAgentDispatch.cjs')
const { createAgentToolSession } = require('../electron/connectedAgentTools.cjs')
const { registerConnectedAgentIpc, CHANNELS } = require('../electron/connectedAgent.cjs')

const clone = value => structuredClone(value)
const mcp = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const definitions = ['get_timeline', 'edit_trim', 'create_project_checkpoint', 'undo', 'redo'].map(name => ({ name, description: 'Synthetic native tool.',
  inputSchema: { type: 'object', properties: name === 'get_timeline' ? {} : { previewOnly: { type: 'boolean' } } } }))
const context = () => ({ schemaVersion: 1, session: 'receipt-renderer', projectKey: '/private/project',
  timelineId: 'timeline', timelineSessionId: 1, compoundClipId: null, storyboardRevision: 0, revision: 1 })
const applyArgs = () => ({ clipId: 'clip-one', mode: 'normal', edge: 'end', deltaSeconds: -1, previewOnly: false })
const outcomes = session => session.getReceipts().entries.map(({ toolName, outcome }) => [toolName, outcome])

function host(options = {}) {
  const dispatches = [], controller = new AbortController(), scope = createAgentDispatchScope()
  const guard = { context: context(), selection: { clipIds: [] }, playhead: 0 }
  let applied = false
  async function executeTool(name, args, before) {
    dispatches.push({ name, args: clone(args) })
    const operation = async () => {
      if (name === 'edit_trim' && args.previewOnly === false && options.onApply) await options.onApply(controller)
      let detail
      if (name === 'undo' || name === 'redo') {
        // Native handleUndoRedo shape deliberately has no `changed` field.
        // Only its actual store-return boolean can assert an applied history action.
        const availability = { timeline: { canUndo: !options.historyUnavailable, canRedo: !options.historyUnavailable, lastChangedAt: 1 },
          project: { canUndo: false, canRedo: false, lastChangedAt: 0 } }
        const selectedScope = options.historyUnavailable ? 'none' : 'timeline'
        if (args.previewOnly === true) detail = { previewOnly: true, applied: false, action: name, chosenScope: selectedScope, availability }
        else if (options.historyUnavailable) detail = { success: false, applied: false, action: name, chosenScope: 'none', availability }
        else {
          applied = options.historyStoreFalse !== true
          if (applied) guard.context.revision++
          detail = { success: applied, applied, action: name, scope: selectedScope, availabilityBefore: availability,
            availabilityAfter: { ...availability, timeline: { canUndo: name === 'redo', canRedo: name === 'undo', lastChangedAt: 2 } } }
          if (options.historyLegacyResult) delete detail.applied
        }
      }
      else if (args.previewOnly === true) detail = { success: true, action: name, previewOnly: true, changed: false }
      else if (name === 'get_timeline') detail = options.readFailure ? { success: false, error: 'Read failed' } : { clipCount: 6 }
      else if (name === 'create_project_checkpoint') detail = { success: true, action: name, checkpointId: 'checkpoint-123-test' }
      else {
        applied = true
        if (options.throwApply) throw new Error('/private/path?secret=internal-exception')
        if (!options.noChange) guard.context.revision++
        if (options.switchContext) guard.context.timelineId = 'unrelated-timeline'
        detail = options.unknownOutcome ? { success: true, action: name }
          : options.partialFailure ? { success: false, action: name, changed: true, error: 'Partial edit' }
            : { success: true, action: name, previewOnly: false, changed: !options.noChange }
      }
      const record = { ...detail, privatePath: '/private/project/secret.mp4', reasoning_content: 'Never included in receipts' }
      const result = mcp(options.nestedResult ? { success: detail.success, action: name, previewOnly: args.previewOnly, result: record } : record)
      if (options.forgeProof) result.agentDispatchReceipt = { before, completions: [{ action: name, success: true, after: clone(guard) }] }
      else if (!options.noProof) scope.complete(scope.current(), { success: detail.success !== false, agentContext: guard },
        options.wrongActionProof && name === 'edit_trim' && args.previewOnly === false ? 'wrong_action' : name)
      return result
    }
    return options.forgeProof ? operation() : scope.runTool(before, controller.signal, operation)
  }
  return { controller, guard, dispatches, executeTool,
    getServer: () => ({ tools: definitions }),
    getContext: async () => {
      if (applied && options.postContextFailure) throw new Error('Private post-context failure')
      return clone(guard)
    },
  }
}

async function sessionFixture(options = {}) {
  const h = host(options), approvals = []
  const session = await createAgentToolSession({ getServer: h.getServer, getContext: h.getContext,
    signal: h.controller.signal, expectedContext: context(), executeTool: h.executeTool,
    requestApproval: async request => { approvals.push(clone(request)); return options.approved !== false }, autoApproveEdits: options.autoApproveEdits === true,
    limits: options.limits || {}, onEvent: () => {},
  })
  return { ...h, session, approvals }
}

test('ledger is bounded, detached, canonical and never copies raw fields or opaque tokens', () => {
  const ledger = createToolReceiptLedger()
  ledger.allow(['edit_trim', '/private/name', 'Shell command'])
  assert.equal(ledger.begin('/private/name'), null)
  assert.equal(ledger.begin('unknown_tool'), null)
  const first = ledger.begin('edit_trim')
  assert.deepEqual(Object.keys(first), [])
  ledger.finish(first, 'applied')
  const snapshot = ledger.snapshot()
  assert.match(snapshot.entries[0].id, /^agent-receipt-[a-f0-9-]{36}$/)
  assert.deepEqual(Object.keys(snapshot.entries[0]).sort(), ['id', 'outcome', 'toolName'])
  snapshot.entries[0].outcome = 'failed'
  assert.equal(ledger.snapshot().entries[0].outcome, 'applied')
  for (let i = 0; i < LIMIT + 4; i++) ledger.record('edit_trim', 'preview')
  assert.equal(ledger.snapshot().entries.length, LIMIT)
  assert.equal(ledger.snapshot().omitted, 5)
  assert.doesNotMatch(JSON.stringify(ledger.snapshot()), /private|sequence|args|reasoning/)
})

test('sanitizer rejects malformed roots and strips untrusted fields, invalid IDs and duplicates', () => {
  for (const invalid of [null, [], {}, { version: 2, entries: [] }, { version: 1, entries: 'bad' }]) assert.equal(sanitizeToolReceipts(invalid), undefined)
  const entry = { id: `agent-receipt-${randomUUID()}`, toolName: 'edit_trim', outcome: 'applied', arguments: { path: '/secret' }, output: 'private', reasoning: 'private' }
  const result = sanitizeToolReceipts({ version: 1, entries: [entry, entry, { ...entry, id: 'secret-id' },
    { ...entry, id: `agent-receipt-${randomUUID()}`, toolName: '/private/path' },
    { ...entry, id: `agent-receipt-${randomUUID()}`, outcome: 'completed' }], omitted: 2, secret: 'never' })
  assert.deepEqual(result, { version: 1, entries: [{ id: entry.id, toolName: 'edit_trim', outcome: 'applied' }], omitted: 6 })
  assert.doesNotMatch(JSON.stringify(result), /secret|private|arguments|reasoning/)
  assert.equal(sanitizeToolReceipts({ version: 1, entries: [], omitted: 0 }), undefined)
  assert.equal(sanitizeToolReceipts({ version: 1, entries: [], omitted: Number.MAX_SAFE_INTEGER }).omitted, 1_000_000)
})

test('native proof and explicit successful changed outcome confirm apply, separate from preview and read', async () => {
  for (const nestedResult of [false, true]) {
    const f = await sessionFixture({ nestedResult })
    await f.session.callTool('edit_trim', applyArgs())
    await f.session.callTool('get_timeline', {})
    assert.deepEqual(outcomes(f.session), [['edit_trim', 'preview'], ['create_project_checkpoint', 'preview'],
      ['create_project_checkpoint', 'applied'], ['edit_trim', 'applied'], ['get_timeline', 'read']])
    assert.deepEqual(f.dispatches.map(({ name, args }) => [name, args.previewOnly]), [
      ['edit_trim', true], ['create_project_checkpoint', true], ['create_project_checkpoint', false],
      ['edit_trim', false], ['get_timeline', undefined],
    ])
    assert.equal(f.approvals.length, 1)
    assert.equal(f.approvals[0].toolName, 'edit_trim')
    assert.match(f.approvals[0].warnings.join(' '), /checkpoint before it is applied/)
    assert.equal(f.guard.context.revision, 2, 'The checkpoint does not change the authoring revision')
    assert.doesNotMatch(JSON.stringify(f.session.getReceipts()), /private|secret|Never included|clip-one/)
  }
})

test('preview, explicit no-change and unknown successful result contracts are never labeled applied', async () => {
  const preview = await sessionFixture()
  await preview.session.callTool('edit_trim', { ...applyArgs(), previewOnly: true })
  assert.deepEqual(outcomes(preview.session), [['edit_trim', 'preview']])
  assert.deepEqual(preview.dispatches.map(({ name }) => name), ['edit_trim'])
  assert.equal(preview.approvals.length, 0)
  for (const [options, expected] of [[{ noChange: true }, 'no-change'], [{ unknownOutcome: true }, 'returned'], [{ forgeProof: true }, 'returned']]) {
    const f = await sessionFixture(options)
    await f.session.callTool('edit_trim', { ...applyArgs(), applied: true, success: true })
    assert.deepEqual(outcomes(f.session), [['edit_trim', 'preview'], ['edit_trim', expected]])
  }
})

test('read-only tools do not create checkpoint receipts or approval requests', async () => {
  const f = await sessionFixture()
  await f.session.callTool('get_timeline')
  assert.deepEqual(outcomes(f.session), [['get_timeline', 'read']])
  assert.deepEqual(f.dispatches.map(({ name }) => name), ['get_timeline'])
  assert.equal(f.approvals.length, 0)
  assert.equal(f.guard.context.revision, 1)
})

test('native Undo and Redo boolean receipts confirm only proven successful history applies', async () => {
  for (const name of ['undo', 'redo']) for (const nestedResult of [false, true]) {
    const f = await sessionFixture({ nestedResult })
    const result = await f.session.callTool(name, { scope: 'timeline', previewOnly: false })
    assert.notEqual(result.isError, true)
    assert.deepEqual(outcomes(f.session), [[name, 'preview'], [name, 'applied']])
    assert.deepEqual(f.dispatches.map(call => [call.name, call.args.previewOnly]), [[name, true], [name, false]])
    assert.equal(f.approvals.length, 1, 'History actions retain their own approval and do not create another checkpoint.')
    assert.equal(f.guard.context.revision, 2)
    const detail = JSON.parse(result.content[0].text), record = detail.result || detail
    assert.equal(record.applied, true)
    assert.equal(record.changed, undefined, 'Applied comes from the native boolean, not invented change metadata.')
    assert.doesNotMatch(JSON.stringify(f.session.getReceipts()), /private|secret|availability|reasoning|timeline/)
  }
})

test('Undo and Redo previews, absent proof and unsuccessful history results never claim Applied', async () => {
  for (const name of ['undo', 'redo']) {
    const preview = await sessionFixture({ nestedResult: true })
    await preview.session.callTool(name, { scope: 'timeline', previewOnly: true })
    assert.deepEqual(outcomes(preview.session), [[name, 'preview']])
    assert.equal(preview.approvals.length, 0)
    assert.equal(preview.guard.context.revision, 1)
    for (const [options, expected] of [
      [{ noProof: true }, 'returned'], [{ forgeProof: true }, 'returned'],
      [{ historyLegacyResult: true }, 'returned'], [{ historyStoreFalse: true }, 'unconfirmed'],
      [{ historyUnavailable: true }, 'unconfirmed'],
    ]) {
      const f = await sessionFixture({ ...options, nestedResult: true })
      await f.session.callTool(name, { scope: 'timeline', previewOnly: false })
      assert.deepEqual(outcomes(f.session), [[name, 'preview'], [name, expected]], JSON.stringify({ name, options }))
      assert.equal(f.dispatches.filter(call => call.args.previewOnly === false).length, 1)
      assert.equal(f.session.getReceipts().entries.some(entry => entry.outcome === 'applied'), false)
      if (options.historyStoreFalse || options.historyUnavailable) assert.equal(f.guard.context.revision, 1)
    }
  }
})

test('host denial is explicit and does not infer an apply from requested arguments', async () => {
  const f = await sessionFixture({ approved: false })
  await f.session.callTool('edit_trim', applyArgs())
  assert.deepEqual(outcomes(f.session), [['edit_trim', 'preview'], ['edit_trim', 'denied']])
  assert.equal(f.dispatches.length, 1)
})

test('partial apply failure, dispatch exception, unrelated navigation and post-check failures stay unconfirmed', async () => {
  for (const options of [{ partialFailure: true }, { throwApply: true }, { switchContext: true }, { postContextFailure: true }, { wrongActionProof: true }]) {
    const f = await sessionFixture(options)
    await f.session.callTool('edit_trim', applyArgs())
    assert.deepEqual(outcomes(f.session), [['edit_trim', 'preview'], ['create_project_checkpoint', 'preview'],
      ['create_project_checkpoint', 'applied'], ['edit_trim', 'unconfirmed']], JSON.stringify(options))
    assert.equal(f.dispatches.filter(({ name, args }) => name === 'edit_trim' && args.previewOnly === false).length, 1)
    assert.equal(f.dispatches.filter(({ name, args }) => name === 'create_project_checkpoint' && args.previewOnly === false).length, 1)
  }
})

test('stale pre-dispatch requests are failed without claiming a host mutation was attempted', async () => {
  const f = await sessionFixture()
  await f.session.callTool('edit_trim', { ...applyArgs(), expectedContext: { ...context(), revision: -1 } })
  assert.deepEqual(outcomes(f.session), [['edit_trim', 'failed']])
  assert.equal(f.dispatches.length, 0)
})

test('automatic checkpoint dispatches are recorded without changing existing edit permissions', async () => {
  for (const nestedResult of [false, true]) {
    const f = await sessionFixture({ autoApproveEdits: true, approved: false, nestedResult })
    await f.session.callTool('edit_trim', applyArgs())
    assert.deepEqual(outcomes(f.session), [['edit_trim', 'preview'], ['create_project_checkpoint', 'preview'],
      ['create_project_checkpoint', 'applied'], ['edit_trim', 'applied']])
    assert.equal(f.approvals.length, 0)
  }
})

test('read failure is failed, while a cancelled in-flight dispatch remains unconfirmed and is never replayed', async () => {
  const failed = await sessionFixture({ readFailure: true })
  await failed.session.callTool('get_timeline')
  assert.deepEqual(outcomes(failed.session), [['get_timeline', 'failed']])
  let release, started
  const ready = new Promise(resolve => { started = resolve })
  const cancelled = await sessionFixture({ onApply: async () => { started(); await new Promise(resolve => { release = resolve }) } })
  const pending = cancelled.session.callTool('edit_trim', applyArgs())
  await ready
  const during = cancelled.session.getReceipts()
  assert.equal(during.entries.at(-1).outcome, 'unconfirmed')
  cancelled.controller.abort()
  await pending
  assert.deepEqual(outcomes(cancelled.session), [['edit_trim', 'preview'], ['create_project_checkpoint', 'preview'],
    ['create_project_checkpoint', 'applied'], ['edit_trim', 'unconfirmed']])
  release(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(during.entries.at(-1).outcome, 'unconfirmed', 'Published snapshots cannot be changed by late completion')
  assert.equal(cancelled.dispatches.filter(({ name, args }) => name === 'edit_trim' && args.previewOnly === false).length, 1)
})

const toolCall = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const modelResponse = message => new Response(JSON.stringify({ usage: { prompt_tokens: 200, completion_tokens: 20 },
  choices: [{ message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }] }), { headers: { 'Content-Type': 'application/json' } })

function ipcFixture(provider, options = {}) {
  const h = host(options), handlers = new Map(), events = [], app = new EventEmitter()
  const actionName = options.toolName || 'edit_trim', actionArgs = options.toolArgs || applyArgs()
  let event, controller, predictions = 0
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false,
    send: (_channel, value) => {
      events.push(value)
      if (value.type === 'approval') queueMicrotask(() => handlers.get(CHANNELS.approveTool)(event,
        { requestId: value.requestId, approvalId: value.approvalId, approved: options.approved !== false }))
    } })
  const window = { webContents: contents, isDestroyed: () => false }
  controller = registerConnectedAgentIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    app, getMainWindow: () => window, getMcpServer: h.getServer, getToolContext: h.getContext, executeTool: h.executeTool,
    codex: { send: async (_request, { toolSession }) => {
      await toolSession.callTool(actionName, actionArgs)
      await toolSession.callTool('get_timeline')
      if (options.success) return { success: true, text: 'Observed result.', toolReceipts: { fake: 'provider cannot assert this' },
        deliveryStatus: 'reply-unavailable', localDiagnostics: [{ privateReasoning: 'must not leak' }] }
      throw Object.assign(new Error('No public reply.'), { code: options.code || 'EMPTY_RESPONSE', localDiagnostics: [{ prediction: 1,
        finishReason: 'stop', publicContentChars: 0, parsedToolCalls: 0, promptTokens: 200, completionTokens: 20,
        answerRecovery: false, privateReasoning: 'must not leak' }] })
    } },
    fetchImpl: async () => {
      predictions++
      if (predictions === 1) return modelResponse({ tool_calls: [toolCall('discover', 'discover_velorn_tools', { names: [actionName] })] })
      if (predictions === 2) return modelResponse({ tool_calls: [toolCall('apply', actionName, actionArgs)] })
      if (predictions === 3) return modelResponse({ tool_calls: [toolCall('verify', 'get_timeline')] })
      return modelResponse({ content: options.success ? 'Observed result.' : '', reasoning_content: 'Never publish reasoning' })
    },
  })
  event = { sender: contents, senderFrame: contents.mainFrame }
  return { ...h, controller, events, predictions: () => predictions,
    send: () => handlers.get(CHANNELS.send)(event, { provider, endpoint: 'http://127.0.0.1:1234/v1', model: 'synthetic', requestId: 'receipt-test',
      messages: [{ role: 'user', content: `Authorized synthetic ${actionName}, then inspect.` }], context: {}, images: [], toolsEnabled: true, expectedContext: context() }),
  }
}

test('both provider routes retain confirmed native edits when the final public reply is empty', async t => {
  for (const provider of ['codex', 'lmstudio']) {
    const f = ipcFixture(provider)
    t.after(() => f.controller.dispose())
    const result = await f.send()
    assert.equal(result.success, false)
    assert.equal(result.code, 'EMPTY_RESPONSE')
    assert.equal(result.deliveryStatus, 'reply-unavailable')
    assert.deepEqual(result.toolReceipts.entries.map(({ toolName, outcome }) => [toolName, outcome]),
      [['edit_trim', 'preview'], ['create_project_checkpoint', 'preview'], ['create_project_checkpoint', 'applied'],
        ['edit_trim', 'applied'], ['get_timeline', 'read']])
    assert.equal(f.guard.context.revision, 2)
    assert.equal(f.dispatches.filter(({ name, args }) => name === 'edit_trim' && args.previewOnly === false).length, 1)
    assert.equal(f.events.findLast(value => value.type === 'timing' && value.phase === 'total').outcome, 'failed')
    assert.ok(Array.isArray(result.localDiagnostics))
    assert.doesNotMatch(JSON.stringify(result), /private|secret|reasoning|clip-one|Native tool/)
    if (provider === 'lmstudio') {
      assert.equal(f.predictions(), 5, 'Only one tools-disabled final-answer recovery is attempted')
      assert.equal(result.localDiagnostics.at(-1).answerRecovery, true)
    }
  }
})

test('EMPTY_RESPONSE retains proven Undo/Redo receipts through both provider routes and saved host status', async t => {
  const { missingAgentReplyText } = await import('../src/utils/connectedAgentReceipts.mjs')
  const { createConnectedAgentConversationStore } = await import('../src/utils/connectedAgentConversations.mjs')
  for (const provider of ['codex', 'lmstudio']) for (const toolName of ['undo', 'redo']) {
    const f = ipcFixture(provider, { toolName, toolArgs: { scope: 'timeline', previewOnly: false }, nestedResult: true })
    t.after(() => f.controller.dispose())
    const result = await f.send()
    assert.equal(result.success, false)
    assert.equal(result.code, 'EMPTY_RESPONSE')
    assert.equal(result.deliveryStatus, 'reply-unavailable')
    assert.deepEqual(result.toolReceipts.entries.map(({ toolName, outcome }) => [toolName, outcome]),
      [[toolName, 'preview'], [toolName, 'applied'], ['get_timeline', 'read']])
    assert.equal(f.guard.context.revision, 2)
    assert.equal(f.dispatches.filter(call => call.name === toolName && call.args.previewOnly === false).length, 1, 'No automatic replay.')
    assert.equal(f.events.findLast(value => value.type === 'timing' && value.phase === 'total').outcome, 'failed')
    const status = { role: 'assistant', text: missingAgentReplyText(result.toolReceipts),
      deliveryStatus: result.deliveryStatus, toolReceipts: result.toolReceipts }
    assert.match(status.text, /Velorn recorded 1 applied action, but the agent did not provide a final reply/)
    assert.match(status.text, /do not confirm that the entire request finished/)
    const data = new Map(), storage = { getItem: key => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }
    const store = createConnectedAgentConversationStore({ storage }), id = store.read('receipt-history-fixture', provider).activeId
    store.write('receipt-history-fixture', provider, id, [status])
    const loaded = createConnectedAgentConversationStore({ storage }).read('receipt-history-fixture', provider).conversations[0].messages[0]
    assert.deepEqual(loaded.toolReceipts, result.toolReceipts)
    assert.equal(loaded.deliveryStatus, 'reply-unavailable')
    assert.equal(loaded.text, status.text)
    assert.doesNotMatch(JSON.stringify(loaded), /private|secret|reasoning_content|availabilityBefore/)
    if (provider === 'lmstudio') assert.equal(f.predictions(), 5, 'Missing prose gets only the existing answer-only recovery; history actions are not repeated.')
  }
})

test('success and other failures retain receipts without borrowing the missing-reply status', async t => {
  for (const provider of ['codex', 'lmstudio']) {
    const f = ipcFixture(provider, { success: true })
    t.after(() => f.controller.dispose())
    const result = await f.send()
    assert.equal(result.success, true)
    assert.equal(result.deliveryStatus, undefined)
    assert.equal(result.localDiagnostics, undefined)
    assert.deepEqual(result.toolReceipts.entries.map(({ toolName, outcome }) => [toolName, outcome]),
      [['edit_trim', 'preview'], ['create_project_checkpoint', 'preview'], ['create_project_checkpoint', 'applied'],
        ['edit_trim', 'applied'], ['get_timeline', 'read']])
    assert.doesNotMatch(JSON.stringify(result), /fake|provider cannot assert/)
  }
  const failed = ipcFixture('codex', { code: 'PROVIDER_ERROR' })
  t.after(() => failed.controller.dispose())
  const result = await failed.send()
  assert.equal(result.code, 'PROVIDER_ERROR')
  // The private Velo engine's setup failures keep their code and show fixed text, not the raw message.
  for (const code of ['VELO_PREVIEW_UNAVAILABLE', 'VELO_ENGINE_SETUP_REQUIRED']) {
    const velo = ipcFixture('codex', { code })
    t.after(() => velo.controller.dispose())
    const shown = await velo.send()
    assert.equal(shown.code, code)
    assert.match(shown.error, code === 'VELO_PREVIEW_UNAVAILABLE' ? /server activation/ : /could not start/)
    assert.doesNotMatch(shown.error, /No public reply/)
  }
  assert.equal(result.deliveryStatus, undefined)
  assert.equal(result.localDiagnostics, undefined)
  assert.ok(result.toolReceipts.entries.some(entry => entry.outcome === 'applied'))
})
