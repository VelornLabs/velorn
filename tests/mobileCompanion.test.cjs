'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { registerMobileCompanionIpc, sanitizePublication, CHANNELS, LIMITS } = require('../electron/mobileCompanion.cjs')

const SCOPE = 'synthetic-project-chat-session-001'
const OTHER = 'synthetic-project-chat-session-002'
const jpeg = 'data:image/jpeg;base64,/9j/2Q=='
const snapshot = (extra = {}) => ({ projectName: 'Synthetic film', chatTitle: 'Scene review', provider: 'codex', model: 'test-model',
  available: true, messages: [{ role: 'user', text: 'Review this shot.' }], ...extra })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('phone chat metadata is bounded, allowlisted, redacted and current-project/provider scoped', () => {
  const value = snapshot({ protocol: 3, contextId: 'current-context', chatId: 'shared-id', chatNavigation: true,
    chats: [
      { id: 'shared-id', provider: 'codex', title: 'Scene /private/project secret=hidden', updatedAt: 100, messages: ['private transcript'], path: '/private/project' },
      { id: 'shared-id', provider: 'lmstudio', title: 'Local chat', updatedAt: -1, current: true },
      { id: 'shared-id', provider: 'codex', title: 'Duplicate', updatedAt: 1 },
      { id: '../escape', provider: 'codex', title: 'Invalid ID' },
      { id: 'other', provider: 'shell', title: 'Invalid provider' },
      { id: 'object-title', provider: 'codex', title: { secret: 'no' } },
    ] })
  const clean = sanitizePublication(value)
  assert.equal(clean.chatNavigation, true)
  assert.deepEqual(clean.chats, [
    { id: 'shared-id', provider: 'codex', title: 'Scene [path omitted] [private value omitted]', updatedAt: 100, current: true },
    { id: 'shared-id', provider: 'lmstudio', title: 'Local chat', updatedAt: 0, current: false },
  ])
  assert.doesNotMatch(JSON.stringify(clean.chats), /private transcript|hidden|secret|\/private/)
  assert.equal(sanitizePublication({ ...value, chats: Array.from({ length: 150 }, (_, n) => ({ id: `chat-${n}`, provider: 'codex', title: 'x'.repeat(1000), updatedAt: Number.MAX_SAFE_INTEGER })) }).chats.length, 100)
  assert.equal(sanitizePublication({ ...value, chatNavigation: false }).chats.length, 0)
  assert.equal(sanitizePublication({ ...value, protocol: 2 }).chatNavigation, undefined)
})

test('chat commands require the advertised exact provider/id and fresh idle context', () => {
  const { validateCommand } = require('../electron/mobileCompanionControl.cjs')
  const value = sanitizePublication(snapshot({ protocol: 3, contextId: 'context', chatNavigation: true,
    chats: [{ id: 'chat-codex', provider: 'codex', title: 'Cloud' }, { id: 'chat-local', provider: 'lmstudio', title: 'Local' }] }))
  const select = { id: 'select-once', kind: 'chat', chatId: 'chat-local', provider: 'lmstudio', contextId: value.contextId }
  assert.deepEqual(validateCommand(select, value), select)
  const create = { id: 'new-once', kind: 'new-chat', contextId: value.contextId }
  assert.deepEqual(validateCommand(create, value), create)
  for (const change of [{ chatId: '../secret' }, { chatId: 'missing' }, { provider: 'codex' }, { provider: 'shell' }, { chatId: ['chat-local'] }]) {
    assert.throws(() => validateCommand({ ...select, ...change }, value), /CHAT_UNAVAILABLE/)
  }
  for (const extra of [{ provider: 'lmstudio' }, { projectPath: '/private' }, { fullAccess: true }, { text: 'replay an edit' }]) {
    assert.throws(() => validateCommand({ ...create, ...extra }, value), /INVALID_COMMAND/)
  }
  assert.throws(() => validateCommand({ ...select, contextId: 'old' }, value), /STALE_CONTEXT/)
  for (const unavailable of [{ protocol: 2 }, { chatNavigation: false }]) {
    assert.throws(() => validateCommand(select, { ...value, ...unavailable }), /CHAT_NAVIGATION_UNAVAILABLE/)
  }
  for (const busy of [{ busy: true }, { awaitingApproval: true }, { available: false }, { nativeApprovals: [{}] }]) {
    assert.throws(() => validateCommand(select, { ...value, ...busy }), /BUSY/)
    assert.throws(() => validateCommand(create, { ...value, ...busy }), /BUSY/)
  }
})

function fixture(options = {}) {
  const handlers = new Map(), events = [], calls = [], dialogs = []
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false,
    send: (...args) => events.push(args) })
  const window = { webContents: contents, isDestroyed: () => false }
  let liveWindow = window, hooks, status = { enabled: false, paired: false, pairingCode: null, urls: [] }
  const app = new EventEmitter()
  const server = {
    getStatus: () => structuredClone(status),
    async start(scope, value) {
      calls.push(['start', scope, value])
      if (options.start) await options.start()
      status = { enabled: true, paired: false, pairingCode: 'NATIVE-ONLY', urls: ['http://192.168.10.10:5212/'] }
      hooks.onStatus(server.getStatus())
      return server.getStatus()
    },
    async stop(reason) { calls.push(['stop', reason]); status = { enabled: false, paired: false, pairingCode: null, urls: [], reason }; hooks.onStatus(server.getStatus()) },
    publish(scope, value, provenance) { calls.push(['publish', scope, value, provenance]); return true },
    resolveCommand(scope, id, result) { calls.push(['resolve', scope, id, result]); return true },
  }
  const controller = registerMobileCompanionIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    app, getMainWindow: () => liveWindow, clientRoot: '/synthetic/mobile-client',
    dialog: { async showMessageBox(...args) { dialogs.push(args); return options.answer ? options.answer() : { response: 1, checkboxChecked: true } } },
    createServer(value) { hooks = value; return server }, ...(options.replyTimeoutMs ? { replyTimeoutMs: options.replyTimeoutMs } : {}), ...options.native })
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const call = (method, payload, from = event) => handlers.get(CHANNELS[method])(from, payload)
  return { controller, handlers, events, calls, dialogs, app, server, contents, window, event, call,
    setWindow(value) { liveWindow = value },
    enable: (extra = {}) => call('enable', { scope: SCOPE, snapshot: snapshot(), ...extra }),
    message: (extra = {}) => hooks.onMessage({ id: 'phone-request-1', text: 'Make the next shot warmer.', scope: SCOPE, ...extra }),
    command: extra => hooks.onMessage({ ...extra, scope: SCOPE }),
    notify: value => hooks.onStatus(value),
    pair() { status.paired = true }, get videoCatalog() { return hooks.videoCatalog }, get audioCatalog() { return hooks.audioCatalog },
  }
}

test('construction registers the bounded native handlers and never enables the listener', async () => {
  const f = fixture()
  assert.deepEqual([...f.handlers.keys()], [CHANNELS.enable, CHANNELS.disable, CHANNELS.attach, CHANNELS.detach, CHANNELS.forget, CHANNELS.preference, CHANNELS.desktopAccount, CHANNELS.accountRequests, CHANNELS.guidedSetup, CHANNELS.guidedDisconnect, CHANNELS.guidedUnregister, CHANNELS.publish, CHANNELS.reply, CHANNELS.decideNative])
  assert.equal(f.calls.length, 0)
  assert.equal(f.dialogs.length, 0)
  await f.controller.dispose()
})

test('project-free account actions remain main-frame owned, explicit and phone-independent', async () => {
  let answer = 1, nativeContext, registered = false, phone = false
  const f = fixture({ answer: () => ({ response: answer }) })
  const actions = []
  f.server.setAccountContext = async value => { nativeContext = value }
  f.server.getGuidedPreference = async () => phone
  f.server.getStatus = () => ({ enabled: false, guided: { registered, enabled: phone,
    computer: registered ? { id: 'fixture-computer', name: 'Remembered computer' } : null, devices: [] } })
  f.server.beginGuidedSetup = async (name, options) => {
    actions.push(['sign-in', name, options]); assert.equal(nativeContext.isCurrent(), true)
    const consent = await nativeContext.confirm({ kind: 'account', accountDisplayName: 'Synthetic owner', computerName: name, phoneAccess: false })
    if (consent) registered = true
  }
  f.server.unregisterGuided = async options => { actions.push(['sign-out', options]); registered = false; return { registered: false } }
  f.server.setGuidedPreference = async enabled => { phone = enabled }
  assert.equal((await f.call('preference')).success, true)
  assert.equal(f.calls.length, 0, 'Welcome account reads never start phone transports')
  assert.equal((await f.call('desktopAccount', { action: 'sign-in', name: 'Remembered computer' })).success, true)
  assert.deepEqual(actions[0], ['sign-in', 'Remembered computer', { accountOnly: true, reauthenticate: true }])
  assert.match(f.dialogs[0][1].detail, /Signing in does not enable phone sharing/)
  assert.equal(phone, false)
  const context = nativeContext
  assert.equal((await f.call('desktopAccount', { action: 'disable-phone' })).success, true)
  assert.equal(context.isCurrent(), true, 'Phone stop must not invalidate the account owner')
  answer = 0
  assert.equal((await f.call('desktopAccount', { action: 'switch-account' })).cancelled, true)
  assert.equal(actions.length, 1); assert.equal(registered, true)
  for (const payload of [{ action: 'sign-in', name: 'New', scope: SCOPE }, { action: 'delete-account' }, { action: 'enable-phone', token: 'not-accepted' }]) {
    assert.equal((await f.call('desktopAccount', payload)).success, false)
  }
  assert.equal((await f.call('desktopAccount', { action: 'sign-out' }, { ...f.event, senderFrame: {} })).success, false)
  answer = 1
  assert.equal((await f.call('desktopAccount', { action: 'switch-account' })).success, true)
  assert.deepEqual(actions.slice(1), [['sign-out', { accountOnly: true }], ['sign-in', 'Remembered computer', { accountOnly: true, reauthenticate: true }]])
  f.contents.emit('did-start-navigation', {}, 'http://synthetic.invalid', false, true)
  assert.equal(context.isCurrent(), false); assert.equal(nativeContext, null)
  await f.controller.dispose()
})

test('legacy phone text route cannot bypass funded Luna dual-recipient consent', async () => {
  const f = fixture()
  await f.enable({ snapshot: snapshot({ provider: 'luna' }) }); f.pair()
  const before = f.events.length
  const result = await f.message()
  assert.equal(result.success, false)
  assert.match(result.error, /Velorn and OpenAI/)
  assert.equal(f.events.length, before, 'No renderer request, approval or provider call is emitted')
  await f.controller.dispose()
})

test('AI sharing claims only one accepted exact message and invalidates on native scope/configuration changes', async t => {
  const { descriptor } = require('../electron/mobileAISharing.cjs')
  const capabilities = { tools: false, research: false, fullAccess: false, images: false, view: false }
  const value = snapshot({ protocol: 3, contextId: 'sharing-context', chatId: 'sharing-chat', aiSharingVersion: 1, aiSharingCapabilities: capabilities })
  const { capabilities: _, ...consent } = descriptor('codex', capabilities)
  for (const changed of ['configuration', 'context', 'unpaired', 'frame', 'completed', 'abort']) await t.test(changed, async () => {
    const f = fixture(), abort = new AbortController()
    await f.enable({ snapshot: value }); f.pair()
    const command = { id: 'consented-message', kind: 'message', text: 'Check this shot.', contextId: value.contextId, aiSharingConsent: consent }
    const waiting = f.command({ ...command, signal: abort.signal })
    const request = { provider: 'codex', conversationId: value.chatId, images: [], mobileSharing: { commandId: command.id, consent, view: false } }
    const claim = input => f.controller.claimMessageConsent({ window: f.window, request, ...input })
    assert.throws(() => claim(), /AI sharing permission/)
    await f.call('reply', { scope: SCOPE, id: command.id, result: { success: true, status: 'accepted' } })
    assert.throws(() => claim({ window: {} }), /AI sharing permission/)
    assert.throws(() => claim({ request: { ...request, provider: 'lmstudio' } }), /AI sharing permission/)
    assert.throws(() => claim({ request: { ...request, conversationId: 'other-chat' } }), /AI sharing permission/)
    assert.throws(() => claim({ request: { ...request, mobileSharing: { ...request.mobileSharing, commandId: 'foreign' } } }), /AI sharing permission/)
    const lease = claim(); lease.assertCurrent()
    assert.throws(() => claim(), /AI sharing permission/, 'Accepted command is one-use')
    if (changed === 'configuration') await f.call('publish', { scope: SCOPE, snapshot: { ...value, toolsEnabled: true, aiSharingCapabilities: { ...capabilities, tools: true } } })
    if (changed === 'context') await f.call('publish', { scope: SCOPE, snapshot: { ...value, contextId: 'different-context' } })
    if (changed === 'unpaired') await f.call('disable', { scope: SCOPE })
    if (changed === 'frame') f.contents.mainFrame = {}
    if (changed === 'completed') await f.call('reply', { scope: SCOPE, id: command.id, result: { success: true, status: 'completed' } })
    if (changed === 'abort') abort.abort()
    assert.throws(() => lease.assertCurrent(), /AI sharing permission/)
    await f.controller.dispose(); await waiting
  })
})

test('native accepted phone command reaches only matching backend and fences async native preparation', async t => {
  const { registerConnectedAgentIpc, CHANNELS: AGENT } = require('../electron/connectedAgent.cjs')
  const { descriptor } = require('../electron/mobileAISharing.cjs')
  for (const changed of [false, true]) await t.test(changed ? 'changed during preflight' : 'unchanged', async () => {
    const f = fixture(), waiting = deferred(), entered = deferred(), sent = []
    const capabilities = { tools: false, research: false, fullAccess: false, images: false, view: false }
    const value = snapshot({ protocol: 3, contextId: 'sharing-context', chatId: 'sharing-chat', aiSharingVersion: 1, aiSharingCapabilities: capabilities })
    const { capabilities: _, ...consent } = descriptor('codex', capabilities)
    await f.enable({ snapshot: value }); f.pair()
    const command = { id: 'phone-send', kind: 'message', contextId: value.contextId, text: 'A private message.', aiSharingConsent: consent }
    const receipt = f.command(command)
    await f.call('reply', { scope: SCOPE, id: command.id, result: { success: true, status: 'accepted' } })
    const agent = registerConnectedAgentIpc({ ipcMain: { handle: (name, handler) => f.handlers.set(name, handler), removeHandler: name => f.handlers.delete(name) },
      app: f.app, getMainWindow: () => f.window, claimMobileMessageConsent: options => f.controller.claimMessageConsent(options),
      executableAccess: { resolve: async () => { entered.resolve(); await waiting.promise; return { path: '/synthetic/codex' } } },
      codex: { send: async (request, options) => { options.assertBeforeSend(); sent.push(request.provider); return { success: true, text: 'Received.' } } } })
    try {
      const work = f.handlers.get(AGENT.send)(f.event, { requestId: 'agent-turn', provider: 'codex', conversationId: value.chatId,
        messages: [{ role: 'user', content: command.text }], context: {}, images: [], vision: true,
        mobileSharing: { commandId: command.id, consent, view: false } })
      await entered.promise
      if (changed) await f.call('publish', { scope: SCOPE, snapshot: { ...value, toolsEnabled: true, aiSharingCapabilities: { ...capabilities, tools: true } } })
      waiting.resolve()
      const result = await work
      if (changed) { assert.equal(result.code, 'AI_SHARING_CHANGED'); assert.equal(result.promptNotSent, true); assert.deepEqual(sent, []) }
      else { assert.equal(result.success, true); assert.deepEqual(sent, ['codex']) }
    } finally { agent.dispose(); await f.controller.dispose(); await receipt }
  })
})

test('guided setup is main-frame only, preserves native approval, and never requests legacy LAN access', async () => {
  const f = fixture()
  let context, setups = 0, disconnects = 0
  f.server.setGuidedContext = value => { context = value }
  f.server.startGuided = (...args) => f.server.start(...args)
  f.server.beginGuidedSetup = async name => {
    setups++; assert.equal(name, 'Studio'); assert.equal(context.isCurrent(), true)
    assert.equal(await context.confirm({ kind: 'account', accountDisplayName: 'Owner', computerName: name }), true)
    assert.equal(await context.confirm({ kind: 'device', accountDisplayName: 'Owner', computerName: name, deviceName: 'Phone', fingerprint: '123456' }), true)
    return { registered: true }
  }
  f.server.disconnectGuidedDevice = async deviceId => { disconnects++; return { deviceId } }
  const payload = { scope: SCOPE, name: 'Studio', snapshot: snapshot({ protocol: 3, contextId: 'guided-context' }) }
  assert.equal((await f.call('guidedSetup', payload, { ...f.event, senderFrame: {} })).success, false)
  assert.equal((await f.call('guidedSetup', { ...payload, token: 'not-from-renderer' })).success, false)
  assert.equal(setups, 0)
  assert.equal((await f.call('guidedSetup', payload)).success, true)
  assert.equal(setups, 1)
  assert.equal(f.dialogs.length, 2)
  assert.equal(f.dialogs.some(([, value]) => value.checkboxLabel), false)
  assert.match(f.dialogs[1][1].detail, /123456/)
  assert.equal(f.dialogs[1][1].defaultId, 0)
  assert.equal((await f.call('guidedDisconnect', { scope: OTHER, deviceId: 'a'.repeat(32) })).success, false)
  assert.equal((await f.call('guidedDisconnect', { scope: SCOPE, deviceId: '../../invalid' })).success, false)
  assert.equal(disconnects, 0)
  assert.equal((await f.call('guidedDisconnect', { scope: SCOPE, deviceId: 'a'.repeat(32) })).success, true)
  assert.equal(disconnects, 1)
  await f.call('disable', { scope: SCOPE })
  assert.equal(context.isCurrent(), false)
  await f.controller.dispose()
})

test('browser account return restores/shows/focuses only its current main window before initial consent', async () => {
  for (const minimized of [false, true]) {
    const f = fixture(), raised = []
    let context
    f.window.isMinimized = () => minimized
    f.window.restore = () => raised.push('restore')
    f.window.show = () => raised.push('show')
    f.window.focus = () => raised.push('focus')
    f.server.setGuidedContext = value => { context = value }
    f.server.startGuided = (...args) => f.server.start(...args)
    f.server.beginGuidedSetup = async () => {
      assert.equal(await context.confirm({ kind: 'account', accountDisplayName: 'Owner', computerName: 'Studio' }), true)
      assert.deepEqual(raised, [...(minimized ? ['restore'] : []), 'show', 'focus'])
      raised.length = 0
      await context.confirm({ kind: 'automatic', automatic: true, computerName: 'Studio' })
      await context.confirm({ kind: 'device', accountDisplayName: 'Owner', computerName: 'Studio', deviceName: 'Phone', fingerprint: '123456' })
      assert.deepEqual(raised, [], 'Background phone enrollment and grant upgrades never steal focus')
    }
    assert.equal((await f.call('guidedSetup', { scope: SCOPE, name: 'Studio', snapshot: snapshot({ protocol: 3, contextId: 'guided-context' }) })).success, true)
    await f.controller.dispose()
  }
})

test('stale, destroyed or replaced window cannot be focused or consent after browser return', async () => {
  for (const phase of ['before', 'restore', 'show', 'focus']) {
    const f = fixture(), raised = []
    let context
    f.window.isMinimized = () => true
    const invalidate = () => { f.window.isDestroyed = () => true }
    for (const action of ['restore', 'show', 'focus']) f.window[action] = () => {
      raised.push(action)
      if (phase === action) invalidate()
    }
    f.server.setGuidedContext = value => { context = value }
    f.server.startGuided = (...args) => f.server.start(...args)
    f.server.beginGuidedSetup = async () => {
      if (phase === 'before') f.setWindow(null)
      await context.confirm({ kind: 'account', accountDisplayName: 'Owner', computerName: 'Studio' })
    }
    assert.equal((await f.call('guidedSetup', { scope: SCOPE, name: 'Studio', snapshot: snapshot({ protocol: 3, contextId: 'guided-context' }) })).success, false)
    assert.equal(f.dialogs.length, 0)
    assert.deepEqual(raised, phase === 'before' ? [] : ['restore', 'show', 'focus'].slice(0, ['restore', 'show', 'focus'].indexOf(phase) + 1))
    await f.controller.dispose()
  }
})

test('OS focus refusal does not approve or block the required native account confirmation', async () => {
  const f = fixture({ answer: () => ({ response: 0 }) })
  let context
  f.window.show = () => { throw Error('Synthetic OS denied focus') }
  f.window.focus = () => { throw Error('Synthetic OS denied focus') }
  f.server.setGuidedContext = value => { context = value }
  f.server.startGuided = (...args) => f.server.start(...args)
  f.server.beginGuidedSetup = async () => assert.equal(await context.confirm({ kind: 'account', accountDisplayName: 'Owner', computerName: 'Studio' }), false)
  assert.equal((await f.call('guidedSetup', { scope: SCOPE, name: 'Studio', snapshot: snapshot({ protocol: 3, contextId: 'guided-context' }) })).success, true)
  assert.equal(f.dialogs.length, 1)
  await f.controller.dispose()
})

test('paused account removal needs only current native consent and never starts or enables sharing', async () => {
  const f = fixture()
  let removals = 0
  f.server.unregisterGuided = async ({ isCurrent }) => { assert.equal(isCurrent(), true); removals++; return { registered: false, account: null } }
  const result = await f.call('guidedUnregister', { scope: SCOPE })
  assert.equal(result.success, true)
  assert.equal(result.status.enabled, false)
  assert.equal(removals, 1)
  assert.equal(f.dialogs.length, 1)
  assert.equal(f.dialogs[0][1].title, 'Disconnect Velorn account?')
  assert.deepEqual(f.calls, [])
  assert.equal((await f.call('guidedUnregister', { scope: SCOPE }, { ...f.event, senderFrame: {} })).success, false)
  assert.equal(removals, 1)
  await f.controller.dispose()
})

test('desktop account actions reject ambiguous sign-out, stale consent and failed browser continuation', async t => {
  for (const failure of ['cancel', 'stale-dialog', 'revocation-error', 'pending-revocation', 'browser-error']) await t.test(failure, async () => {
    let unregisters = 0, starts = 0;
    let guided = { registered: true, computer: { name: 'Existing computer' }, devices: [{ id: 'existing-phone' }] };
    const f = fixture({ answer: () => { if (failure === 'stale-dialog') f.setWindow(null); return { response: failure === 'cancel' ? 0 : 1 } } });
    const original = f.server.getStatus;
    f.server.getStatus = () => ({ ...original(), guided: structuredClone(guided) });
    f.server.startGuided = f.server.start;
    f.server.beginGuidedSetup = async () => { starts++; throw Error('Synthetic browser failure') };
    f.server.unregisterGuided = async () => {
      unregisters++;
      if (failure === 'revocation-error') throw Error('Synthetic offline failure');
      if (failure !== 'pending-revocation') guided = { registered: false, computer: null, devices: [] };
      return guided;
    };
    try {
      const result = await f.call('guidedUnregister', { scope: SCOPE, action: 'switch-account', snapshot: snapshot({ protocol: 3, contextId: 'account-switch' }) });
      if (failure === 'cancel') assert.equal(result.cancelled, true); else assert.equal(result.success, false);
      assert.equal(unregisters, ['cancel', 'stale-dialog'].includes(failure) ? 0 : 1);
      assert.equal(starts, failure === 'browser-error' ? 1 : 0);
      if (failure === 'browser-error') assert.equal(guided.registered, false, 'Never falsely restores old account after an explicit sign-out');
      else assert.equal(guided.registered, true);
      assert.equal(f.dialogs[0][1].buttons[1], 'Switch account');
      assert.match(f.dialogs[0][1].detail, /If you cancel that sign-in, this computer stays signed out/);
    } finally { await f.controller.dispose() }
  });
})

test('paused removal decline and stale browser/window never invoke account revocation', async () => {
  const declined = fixture({ answer: () => ({ response: 0 }) })
  declined.server.unregisterGuided = () => assert.fail('A declined removal cannot run')
  assert.equal((await declined.call('guidedUnregister', { scope: SCOPE })).cancelled, true)
  assert.deepEqual(declined.calls, [])
  await declined.controller.dispose()
  for (const event of ['render-process-gone', 'destroyed', 'navigation']) {
    const pending = deferred(), f = fixture({ answer: () => pending.promise })
    f.server.unregisterGuided = () => assert.fail('A stale removal cannot run')
    const result = f.call('guidedUnregister', { scope: SCOPE })
    assert.equal((await f.call('guidedUnregister', { scope: SCOPE })).code, 'MOBILE_COMPANION_BUSY')
    if (event === 'navigation') f.contents.emit('did-start-navigation', {}, 'https://untrusted.example', false, true)
    else f.contents.emit(event)
    pending.resolve({ response: 1 })
    assert.equal((await result).success, false)
    assert.equal(f.calls.some(call => call[0] === 'start'), false)
    await f.controller.dispose()
  }
})

test('paused revocation in flight is invalidated by renderer loss without reviving phone access', async () => {
  const f = fixture(), started = deferred(), finish = deferred()
  f.server.unregisterGuided = async ({ isCurrent }) => {
    started.resolve(); await finish.promise
    assert.equal(isCurrent(), false)
    return { registered: false }
  }
  const removing = f.call('guidedUnregister', { scope: SCOPE }); await started.promise
  f.contents.emit('render-process-gone'); finish.resolve()
  assert.equal((await removing).success, false)
  assert.ok(f.calls.some(call => call[0] === 'stop' && call[1] === 'renderer-gone'))
  assert.equal(f.calls.some(call => call[0] === 'start'), false)
  await f.controller.dispose()
})

test('background restore and new setup cannot replace pending paused removal consent or its request', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-phone-admin-latch-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const phase of ['dialog', 'request']) {
    const held = deferred(), requestStarted = deferred()
    const f = fixture({ answer: phase === 'dialog' ? () => held.promise : undefined,
      native: { apiOnly: true, clientRoot: null, deviceStorePath: path.join(root, `${phase}-device.json`), preferencePath: path.join(root, `${phase}-preference.json`) } })
    t.after(() => f.controller.dispose())
    f.server.getGuidedPreference = async () => true // A saved unregisterPending also advertises recovery work.
    f.server.startGuided = () => assert.fail('Removal must not start a phone transport')
    f.server.beginGuidedSetup = () => assert.fail('Removal must not start setup')
    f.server.unregisterGuided = async ({ isCurrent }) => {
      requestStarted.resolve()
      if (phase === 'request') await held.promise
      assert.equal(isCurrent(), true)
      return { registered: false, account: null }
    }
    const removing = f.call('guidedUnregister', { scope: SCOPE })
    if (phase === 'request') await requestStarted.promise
    const payload = { scope: SCOPE, snapshot: snapshot({ protocol: 3, contextId: 'paused-account' }) }
    assert.equal((await f.call('attach', payload)).code, 'MOBILE_COMPANION_BUSY', phase)
    assert.equal((await f.call('guidedSetup', { ...payload, name: 'Studio' })).code, 'MOBILE_COMPANION_BUSY', phase)
    assert.equal(f.calls.length, 0, 'No stop/start or native context replacement while removal is pending')
    held.resolve({ response: 1 })
    assert.equal((await removing).success, true, phase)
    assert.equal(f.server.getStatus().enabled, false)
    assert.equal(f.calls.length, 0)
  }
})

test('guided native dialog cannot approve after frame replacement and unconfigured capability is false', async () => {
  const f = fixture({ answer: () => { f.setWindow(null); return { response: 1 } } })
  let context, approved = false
  f.server.setGuidedContext = value => { context = value }
  f.server.startGuided = (...args) => f.server.start(...args)
  f.server.beginGuidedSetup = async () => {
    approved = await context.confirm({ kind: 'device', accountDisplayName: 'Owner', computerName: 'Studio', deviceName: 'Phone', fingerprint: '123456' })
  }
  assert.equal((await f.call('guidedSetup', { scope: SCOPE, name: 'Studio', snapshot: snapshot({ protocol: 3, contextId: 'guided-context' }) })).success, false)
  assert.equal(approved, false)
  assert.equal(f.dialogs.length, 1)
  await f.controller.dispose()
  const packaged = fixture({ native: { clientRoot: null } })
  const preference = await packaged.call('preference')
  assert.equal(preference.available, false)
  assert.equal(preference.guidedAvailable, false)
  assert.equal((await packaged.call('guidedSetup', { scope: SCOPE, name: 'Studio', snapshot: snapshot() })).success, false)
  await packaged.controller.dispose()
})

test('automatic phone access is a bounded IPC option with explicit native account and upgrade consent', async () => {
  const f = fixture()
  let context, setups = 0
  f.server.setGuidedContext = value => { context = value }
  f.server.startGuided = (...args) => f.server.start(...args)
  f.server.beginGuidedSetup = async (name, options) => {
    setups++; assert.deepEqual(options, { automatic: true })
    assert.equal(await context.confirm({ kind: 'account', accountDisplayName: 'Owner', computerName: name, automatic: true }), true)
    assert.equal(await context.confirm({ kind: 'automatic', computerName: name, automatic: true }), true)
    return { registered: true, automaticAccountAccess: true }
  }
  const payload = { scope: SCOPE, name: 'Studio', snapshot: snapshot({ protocol: 3, contextId: 'guided-context' }), automatic: true }
  assert.equal((await f.call('guidedSetup', { ...payload, automatic: 'true' })).success, false)
  assert.equal((await f.call('guidedSetup', payload, { ...f.event, senderFrame: {} })).success, false)
  assert.equal(setups, 0)
  assert.equal((await f.call('guidedSetup', payload)).success, true)
  assert.equal(f.dialogs.length, 2)
  assert.equal(f.dialogs[0][1].title, 'Connect this computer to your Velorn account?')
  assert.equal(f.dialogs[1][1].title, 'Enable phone access?')
  for (const [, dialog] of f.dialogs) {
    assert.match(dialog.detail, /Phones signed into this same account can connect automatically/)
    assert.match(dialog.detail, /Paid generations still ask/)
    assert.match(dialog.detail, /Desktop editing, your own Codex, and local LM Studio do not require a Velorn account/)
    assert.match(dialog.detail, /Velo access when available for your account/)
    assert.equal(dialog.checkboxLabel, undefined)
    assert.equal(dialog.defaultId, 0)
  }
  assert.match(f.dialogs[0][1].detail, /Velorn account: Owner/)
  assert.match(f.dialogs[1][1].detail, /already linked to this computer/)
  await f.controller.dispose()
})

test('account link review is main-frame only and uses a native dialog, never phone approval', async () => {
  const f = fixture()
  let reviews = 0, approval
  f.server.reviewPhoneAccountRequests = async ({ confirm, isCurrent }) => {
    reviews++; assert.equal(isCurrent(), true)
    approval = await confirm({ accountDisplayName: 'Synthetic account', computerName: 'Editing workstation' })
    return { linked: approval ? 1 : 0, declined: approval ? 0 : 1, requestsChecked: 1 }
  }
  await f.enable()
  const malicious = { ...f.event, senderFrame: {} }
  assert.equal((await f.call('accountRequests', { scope: SCOPE }, malicious)).success, false)
  assert.equal((await f.call('accountRequests', { scope: OTHER })).success, false)
  assert.equal((await f.call('accountRequests', { scope: SCOPE, token: 'renderer-must-not-supply' })).success, false)
  assert.equal(reviews, 0)
  const result = await f.call('accountRequests', { scope: SCOPE })
  assert.deepEqual(result, { success: true, linked: 1, declined: 0, requestsChecked: 1 })
  assert.equal(approval, true)
  assert.equal(f.dialogs.at(-1)[0], f.window)
  assert.match(f.dialogs.at(-1)[1].detail, /Synthetic account/)
  assert.equal(f.dialogs.at(-1)[1].defaultId, 0)
  assert.equal(f.events.some(([, data]) => data.type === 'native-approvals' && data.approvals?.length), false)
  await f.controller.dispose()
})

test('account native dialog decline is explicit and a changed desktop invalidates approval', async () => {
  let response = 1
  const f = fixture({ answer: () => ({ response, checkboxChecked: true }) })
  await f.enable(); response = 0
  let approved
  f.server.reviewPhoneAccountRequests = async ({ confirm }) => {
    approved = await confirm({ accountDisplayName: 'Synthetic', computerName: 'Computer' })
    return { linked: 0, declined: 1, requestsChecked: 1 }
  }
  assert.equal((await f.call('accountRequests', { scope: SCOPE })).declined, 1)
  assert.equal(approved, false)
  f.server.reviewPhoneAccountRequests = async ({ confirm, isCurrent }) => {
    f.setWindow(null)
    assert.equal(isCurrent(), false)
    await confirm({ accountDisplayName: 'Synthetic', computerName: 'Computer' })
    throw Error('must not reach')
  }
  const before = f.dialogs.length
  assert.equal((await f.call('accountRequests', { scope: SCOPE })).success, false)
  assert.equal(f.dialogs.length, before)
  await f.controller.dispose()
})

test('successful opt-in restores from a fresh renderer after restart and stops durably on Stop or Forget', async t => {
  const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os')
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-phone-lifecycle-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const native={deviceStorePath:path.join(root,'device.json'),preferencePath:path.join(root,'sharing.json')}
  const value=snapshot({protocol:3,contextId:'fresh-context',chatId:'current-chat'})
  let f=fixture({native});t.after(()=>f.controller.dispose())
  assert.equal((await f.call('preference')).enabled,false)
  assert.equal((await f.call('attach',{scope:SCOPE,snapshot:value})).status.enabled,false)
  assert.equal(f.dialogs.length,0)
  await f.enable({snapshot:value})
  assert.equal((await f.call('preference')).enabled,true)
  await f.controller.dispose()
  f=fixture({native})
  assert.equal(f.calls.length,0,'Construction alone has no fresh renderer owner')
  assert.equal((await f.call('preference')).enabled,true)
  const restored=await f.call('attach',{scope:OTHER,snapshot:{...value,contextId:'after-restart'}})
  assert.equal(restored.success,true);assert.equal(restored.status.enabled,true)
  assert.equal(f.dialogs.length,0,'Saved opt-in needs no repeated confirmation')
  assert.equal(f.calls.find(([name])=>name==='start')[1],OTHER)
  f.contents.emit('render-process-gone')
  assert.equal(f.server.getStatus().enabled,false)
  assert.equal((await f.call('attach',{scope:SCOPE,snapshot:value})).status.enabled,true)
  await f.call('disable',{scope:SCOPE})
  assert.equal((await f.call('preference')).enabled,false)
  assert.equal((await f.call('attach',{scope:SCOPE,snapshot:value})).status.enabled,false)
  await f.controller.dispose();f=fixture({native})
  assert.equal((await f.call('preference')).enabled,false)
  await f.enable({snapshot:value})
  await fs.writeFile(native.deviceStorePath,JSON.stringify({version:2,digest:'a'.repeat(64),expiresAt:null}))
  await f.call('forget',{scope:SCOPE})
  assert.equal((await f.call('preference')).enabled,false)
  await assert.rejects(fs.stat(native.deviceStorePath),{code:'ENOENT'})
  assert.equal((await f.call('attach',{scope:SCOPE,snapshot:value})).status.enabled,false)
})

test('hosted-only capability needs no UI files, ignores LAN preference and restores only guided consent', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-phone-hosted-ipc-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const native = { apiOnly: true, clientRoot: null, deviceStorePath: path.join(root, 'device.json'), preferencePath: path.join(root, 'sharing.json') }
  await require('../electron/mobileCompanionPreference.cjs').createMobileCompanionPreference(native.preferencePath).write(true)
  const f = fixture({ native }); t.after(() => f.controller.dispose())
  let guided = false, guidedStarts = 0, context
  const start = f.server.start
  f.server.start = () => assert.fail('Hosted-only connection must never start the legacy listener')
  f.server.startGuided = (...args) => { guidedStarts++; return start(...args) }
  f.server.getGuidedPreference = async () => guided
  f.server.setGuidedPreference = async value => { guided = value }
  f.server.setGuidedContext = value => { context = value }
  f.server.beginGuidedSetup = async name => {
    guided = await context.confirm({ kind: 'account', automatic: true, computerName: name, accountDisplayName: 'Synthetic owner' })
  }
  const value = snapshot({ protocol: 3, contextId: 'hosted-context', chatId: 'current-chat' })
  const caps = await f.call('preference')
  assert.equal(caps.available, true); assert.equal(caps.guidedAvailable, true); assert.equal(caps.legacyAvailable, false)
  assert.equal(caps.enabled, false, 'Old LAN preference is not account consent')
  assert.equal((await f.call('attach', { scope: SCOPE, snapshot: value })).status.enabled, false)
  assert.equal(guidedStarts, 0); assert.equal(f.dialogs.length, 0)
  assert.equal((await f.enable({ snapshot: value })).code, 'MOBILE_COMPANION_UNAVAILABLE')
  assert.equal((await f.call('accountRequests', { scope: SCOPE })).code, 'MOBILE_COMPANION_UNAVAILABLE')
  assert.equal((await f.call('guidedSetup', { scope: SCOPE, snapshot: value, name: 'My computer', automatic: true })).success, true)
  assert.equal(guidedStarts, 1); assert.equal(f.dialogs.length, 1)
  assert.equal((await f.call('preference')).enabled, true)
  f.contents.emit('render-process-gone')
  assert.equal((await f.call('attach', { scope: OTHER, snapshot: { ...value, contextId: 'restored' } })).success, true)
  assert.equal(guidedStarts, 2); assert.equal(f.dialogs.length, 1, 'No repeated consent during remembered restore')
  await f.call('disable', { scope: OTHER })
  assert.equal(guided, false)
  assert.equal((await f.call('attach', { scope: OTHER, snapshot: value })).status.enabled, false)
  assert.equal(guidedStarts, 2)
})

test('persistent restore cannot survive an explicit stop during asynchronous startup',async t=>{
  const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os')
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-phone-stop-race-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const native={deviceStorePath:path.join(root,'device.json'),preferencePath:path.join(root,'sharing.json')}
  await require('../electron/mobileCompanionPreference.cjs').createMobileCompanionPreference(native.preferencePath).write(true)
  const started=deferred(),f=fixture({native,start:()=>started.promise});t.after(()=>f.controller.dispose())
  const restoring=f.call('attach',{scope:SCOPE,snapshot:snapshot({protocol:3,contextId:'context',chatId:'chat'})})
  for(let i=0;i<50&&!f.calls.some(([name])=>name==='start');i++) await new Promise(resolve=>setTimeout(resolve,1))
  assert.equal(f.calls.some(([name])=>name==='start'),true)
  await f.call('disable',{scope:SCOPE});started.resolve()
  assert.equal((await restoring).success,false)
  assert.equal(f.server.getStatus().enabled,false)
  assert.equal((await f.call('preference')).enabled,false)
  assert.equal(f.dialogs.length,0)
})

test('single-action full access consumes only a current accepted bundled phone command',async t=>{
  const f=fixture({native:{deviceStorePath:'/synthetic-unused-device.json'}});t.after(()=>f.controller.dispose())
  const value=snapshot({protocol:3,contextId:'context-full',chatId:'chat-full'})
  await f.enable({snapshot:value});f.pair()
  const claim=()=>f.controller.claimFullAccess({window:f.window,provider:'codex'})
  assert.equal(claim(),null)
  const command={id:'take-full',kind:'access',mode:'full',bundleVersion:1,contextId:value.contextId}
  const pending=f.command(command)
  assert.equal(claim(),null,'An unaccepted command cannot grant access')
  await f.call('reply',{scope:SCOPE,id:command.id,result:{success:true,status:'accepted'}})
  await pending
  assert.equal(f.controller.claimFullAccess({window:{},provider:'codex'}),null)
  assert.equal(f.controller.claimFullAccess({window:f.window,provider:'lmstudio'}),null)
  const confirmation=claim()
  assert.equal(confirmation.approved,true);assert.equal(confirmation.phoneBundleVersion,1)
  assert.equal(confirmation.remember,true);assert.equal(confirmation.shareImagesAndView,true)
  assert.equal(claim(),null,'The exact command is consumed once')
  await f.call('reply',{scope:SCOPE,id:command.id,result:{success:true,status:'completed'}})
  assert.equal(confirmation.mobileBinding.isCurrent(),true,'Completion is not disconnection')
  await f.call('attach',{scope:SCOPE,snapshot:{...value,contextId:'new-context'}})
  assert.equal(confirmation.mobileBinding.isCurrent(),false)
  const legacy={id:'legacy-full',kind:'access',mode:'full',contextId:'new-context'}
  const waiting=f.command(legacy)
  await f.call('reply',{scope:SCOPE,id:legacy.id,result:{success:true,status:'accepted'}});await waiting
  assert.equal(claim(),null,'Legacy access buttons still require native confirmation')
  await f.call('disable',{scope:SCOPE})
  assert.equal(claim(),null)
})

test('native access revocation distinguishes shared-context rebinds from explicit disconnection',async t=>{
  let liveGrant=true
  const f=fixture({native:{deviceStorePath:'/synthetic-unused-device.json',onRevokeAccess:()=>liveGrant}})
  t.after(()=>f.controller.dispose())
  const value=snapshot({protocol:3,contextId:'context-first',chatId:'chat-first'})
  await f.enable({snapshot:value})
  await f.call('attach',{scope:SCOPE,snapshot:{...value,contextId:'context-next'}})
  await f.call('detach',{scope:SCOPE,contextId:'context-next'})
  await f.call('disable',{scope:SCOPE})
  assert.deepEqual(f.events.filter(([,event])=>event.type==='access-revoked').map(([,event])=>event.reason),
    ['shared-context-changed','shared-context-changed','desktop-disabled'])
  liveGrant=false
  await f.enable({snapshot:value})
  const count=f.events.filter(([,event])=>event.type==='access-revoked').length
  await f.call('attach',{scope:SCOPE,snapshot:{...value,contextId:'without-grant'}})
  assert.equal(f.events.filter(([,event])=>event.type==='access-revoked').length,count,'No restore signal without an actually revoked phone grant')
})

test('audio publication reads registered project assets through native pairing and sharing context',async t=>{
  const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os')
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-mobile-audio-ipc-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
  await fs.writeFile(path.join(root,'music.flac'),'synthetic audio')
  let nativeProject=root
  const f=fixture({native:{getProjectPath:async()=>nativeProject,getAudioAssets:async project=>{
    assert.equal(project,root);return [{id:'music',path:'music.flac',type:'audio',duration:45}]
  }}});t.after(()=>f.controller.dispose())
  const value=snapshot({protocol:3,contextId:'context-one',chatId:'chat-one',reviewProjectPath:root,shareReviewMedia:true})
  await f.enable({snapshot:value});assert.deepEqual(await f.audioCatalog.list(),[])
  f.pair();const cards=await f.audioCatalog.list();assert.equal(cards.length,1)
  assert.doesNotMatch(JSON.stringify(cards),new RegExp(root))
  nativeProject='/another/project';assert.equal(await f.audioCatalog.open(cards[0].id),null)
})

test('video publication binds the private renderer project to native context without leaking file paths',async t=>{
  const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os')
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-mobile-video-ipc-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const file=path.join(root,'export.mp4');await fs.writeFile(file,'synthetic media')
  let nativeProject=root
  const f=fixture({native:{getProjectPath:async()=>nativeProject,getExportJobs:()=>[{jobId:'done',status:'completed',projectPath:root,outputPath:file}]}})
  t.after(()=>f.controller.dispose())
  const value=snapshot({protocol:3,contextId:'context-one',chatId:'chat-one',reviewProjectPath:root,shareReviewMedia:true})
  await f.enable({snapshot:value});f.pair()
  assert.equal((await f.videoCatalog.list()).length,1)
  assert.doesNotMatch(JSON.stringify(f.calls.find(call=>call[0]==='start')[2]),new RegExp(root))
  nativeProject='/another/project'
  assert.deepEqual(await f.videoCatalog.list(),[],'A stale/mismatched project cannot publish video')
  nativeProject=root
  await f.call('publish',{scope:SCOPE,snapshot:{...value,shareReviewMedia:false}})
  assert.deepEqual(await f.videoCatalog.list(),[],'Image/media consent withdrawal blocks video too')
})

test('video lookup tolerates same-project heartbeats but rechecks consent and project after asynchronous inspection', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-video-heartbeat-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'review.mp4'); await fs.writeFile(file, 'synthetic video')
  let value = snapshot({ protocol: 3, contextId: 'context-one', chatId: 'chat-one', reviewProjectPath: root, shareReviewMedia: true })
  let duringRead = () => ({ ...value, status: 'Routine heartbeat' })
  const f = fixture({ native: {
    getExportJobs: () => [{ jobId: 'done', projectPath: root, outputPath: file, status: 'completed' }],
    getProjectPath: async () => { await f.call('publish', { scope: SCOPE, snapshot: duringRead() }); return root },
  } })
  t.after(() => f.controller.dispose())
  await f.enable({ snapshot: value }); f.pair()
  const cards = await f.videoCatalog.list()
  assert.equal(cards.length, 1, 'Heartbeat must not silently erase completed exports')
  assert.equal(f.videoCatalog.getStatus().state, 'ready')
  assert.equal((await f.videoCatalog.list())[0].id, cards[0].id)
  duringRead = () => ({ ...value, shareReviewMedia: false })
  assert.deepEqual(await f.videoCatalog.list(), [])
  assert.equal(f.videoCatalog.getStatus().state, 'sharing-off')
  await f.call('publish', { scope: SCOPE, snapshot: value })
  duringRead = () => ({ ...value, reviewProjectPath: '/different-project' })
  assert.deepEqual(await f.videoCatalog.list(), [])
  assert.equal(f.videoCatalog.getStatus().state, 'project-changing')
  await f.call('publish', { scope: SCOPE, snapshot: value })
  duringRead = () => ({ ...value, available: false })
  assert.deepEqual(await f.videoCatalog.list(), [])
  assert.equal(f.videoCatalog.getStatus().state, 'desktop-busy')
})

test('registration without either hosted runtime or client files remains disabled without a crash or dialog', async () => {
  const handlers = new Map(), contents = { mainFrame: {}, isDestroyed: () => false, on() {} }
  const window = { webContents: contents, isDestroyed: () => false }
  const controller = registerMobileCompanionIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler() {} },
    getMainWindow: () => window, clientRoot: null,
    createServer: () => assert.fail('Unconfigured app must not create a server'),
    dialog: { showMessageBox: () => assert.fail('Unavailable lab feature must not request network consent') } })
  const result = await handlers.get(CHANNELS.enable)({ sender: contents, senderFrame: contents.mainFrame }, { scope: SCOPE, snapshot: snapshot() })
  assert.equal(result.code, 'MOBILE_COMPANION_UNAVAILABLE')
  assert.match(result.error, /Enable phone access/)
  contents.removeListener = () => {}
  await controller.dispose()
})

test('every native request is restricted to the exact current main window and frame', async () => {
  const f = fixture()
  for (const method of ['enable', 'disable', 'publish', 'reply']) {
    for (const from of [null, {}, { sender: f.contents }, { ...f.event, senderFrame: {} },
      { ...f.event, sender: { isDestroyed: () => false } }, { ...f.event, sender: { isDestroyed: () => true } }]) {
      assert.equal((await f.call(method, { scope: SCOPE }, from)).code, 'MOBILE_COMPANION_UNAUTHORIZED')
    }
  }
  assert.equal(f.calls.length, 0)
  f.setWindow(null)
  assert.equal((await f.enable()).code, 'MOBILE_COMPANION_UNAUTHORIZED')
  await f.controller.dispose()
})

test('enable requires native confirmation and an independently checked trusted-network box', async () => {
  for (const answer of [{ response: 0, checkboxChecked: true }, { response: 1, checkboxChecked: false }, { response: 1 }, null]) {
    const f = fixture({ answer: () => answer })
    const result = await f.enable()
    assert.equal(result.cancelled, true)
    assert.equal(f.calls.some(([name]) => name === 'start'), false)
    const warning = f.dialogs[0][1]
    assert.equal(warning.checkboxChecked, false)
    assert.equal(warning.defaultId, 0)
    assert.match(warning.detail, /unencrypted HTTP/)
    assert.match(warning.detail, /Never expose/)
    assert.match(warning.detail, /Phone messages require desktop review/)
    await f.controller.dispose()
  }
})

test('confirmed enable returns native pairing metadata and publishes only the sanitized projection', async () => {
  const f = fixture()
  const result = await f.enable({ snapshot: snapshot({ context: { privatePath: '/private/project' }, token: 'secret',
    preview: { dataUrl: jpeg, capturedAt: 100, workspace: 'editor', filename: '/private/frame.jpg' } }) })
  assert.equal(result.success, true)
  assert.equal(result.status.pairingCode, 'NATIVE-ONLY')
  const [, scope, projection] = f.calls.find(([name]) => name === 'start')
  assert.equal(scope, SCOPE)
  assert.equal(projection.context, undefined)
  assert.equal(projection.token, undefined)
  assert.deepEqual(projection.preview, { dataUrl: jpeg, capturedAt: 100, workspace: 'editor' })
  assert.equal((await f.enable()).success, true)
  assert.equal(f.dialogs.length, 1)
  await f.controller.dispose()
})

test('native phone opt-in explains configured remote access without exposing credentials', async t => {
  for (const configured of [false, true]) {
    const f = fixture({ native: { deviceStorePath: '/synthetic-unused-device.json' } })
    t.after(() => f.controller.dispose())
    f.server.hasRemoteConfiguration = async () => configured
    assert.equal((await f.enable()).success, true)
    const warning = f.dialogs[0][1]
    assert.match(warning.detail, /local HTTP connection is UNENCRYPTED/)
    assert.match(warning.detail, /approve tools and paid submissions/)
    if (configured) {
      assert.match(warning.detail, /outside your network/)
      assert.match(warning.detail, /Trust the remote website operator/)
    } else assert.doesNotMatch(warning.detail, /Remote beta is configured/)
    assert.doesNotMatch(warning.detail, /wss:\/\/|#eyJ/)
  }
})

test('requests reject nonopaque scope, wrong types, oversize envelopes, and renderer authority flags', async () => {
  const f = fixture()
  for (const payload of [null, [], { scope: '/home/private/project' }, { scope: { project: 'id' } }, { scope: 'tiny' },
    { scope: SCOPE, confirmed: true }, { scope: SCOPE, token: 'pretend-native' },
    { scope: SCOPE, snapshot: { raw: 'x'.repeat(LIMITS.publicationBytes + 1) } }]) {
    assert.equal((await f.call('enable', payload)).code, 'MOBILE_COMPANION_INVALID_REQUEST')
  }
  assert.equal(f.dialogs.length, 0)
  await f.controller.dispose()
})

test('projection strips non-chat fields and redacts common private path and credential patterns', () => {
  const clean = sanitizePublication(snapshot({ path: '/private/path', tools: [{ shell: 'secret' }], fullAccessToken: 'secret',
    messages: [{ role: 'system', text: 'private instructions' }, { role: 'tool', text: 'private output' },
      { role: 'assistant', text: 'Use /home/person/private.json and C:\\Users\\person\\key.json. Bearer abcdefgh api_key=hidden',
        toolResults: ['secret'], reasoning: 'private chain', attachments: ['secret'] }] }))
  assert.deepEqual(Object.keys(clean), ['projectName', 'chatTitle', 'provider', 'model', 'messages', 'activity', 'reviews', 'shareReviewMedia', 'busy', 'awaitingApproval', 'status', 'preview', 'available'])
  assert.deepEqual(Object.keys(clean.messages[0]), ['role', 'text'])
  assert.equal(clean.messages.length, 1)
  assert.doesNotMatch(JSON.stringify(clean), /home\/person|Users|abcdef|hidden|private instructions|private output|private chain/)
  assert.match(clean.messages[0].text, /\[path omitted\]/)
})

test('public activity is bounded, redacted and cannot include provider reasoning or raw tool payloads', () => {
  const items = [
    { id:'p', kind:'progress', status:'completed', text:'Inspecting /home/person/private.json password=secretvalue', reasoning:'hidden-thought' },
    { id:'t', kind:'tool', status:'failed', toolName:'get_timeline', summary:'Selection changed.', arguments:'hidden-args', output:'hidden-output' },
    { id:'s', kind:'tool', status:'running', toolName:'Shell command', summary:'hidden-command', output:'hidden-output' },
    { id:'r', kind:'reasoning', status:'completed', text:'hidden-thought' },
  ]
  const result = sanitizePublication(snapshot({ activity:{ items, updatedAt:12345, secret:'hidden-field' } })).activity
  assert.equal(result.items.length,3); assert.equal(result.updatedAt,12345)
  assert.equal(result.items[1].status,'failed'); assert.equal(result.items[2].summary,'')
  assert.doesNotMatch(JSON.stringify(result),/private.json|secretvalue|hidden-/)
  const bounded = sanitizePublication(snapshot({ activity:{ updatedAt:0, items:Array.from({length:60},(_,i) => ({id:String(i),kind:'progress',status:'running',text:'🎬'.repeat(2000)})) } })).activity
  assert.ok(bounded.items.length <= LIMITS.activityItems)
  assert.ok(bounded.items.reduce((bytes,item) => bytes + Buffer.byteLength(item.text),0) <= LIMITS.activityBytes)
  assert.equal(bounded.items.at(-1).id,'59')
  assert.throws(() => sanitizePublication(snapshot({activity:{items:'bad'}})))
})

test('phone history retains bounded native tool receipts and status labels, not raw outputs or user claims', () => {
  const receipt = { id: 'agent-receipt-11111111-1111-4111-8111-111111111111', toolName: 'edit_trim', outcome: 'applied',
    arguments: { path: '/private/source.mov' }, output: 'private tool payload', reasoning: 'private thought' }
  const toolReceipts = { version: 1, entries: [receipt, { ...receipt, id: 'bad', toolName: 'untrusted/name' }], omitted: 2, secret: 'private envelope' }
  const clean = sanitizePublication(snapshot({ messages: [
    { role: 'user', turnId: 'turn-trim', text: 'Trim this shot.', deliveryStatus: 'reply-unavailable', toolReceipts },
    { role: 'assistant', turnId: 'turn-trim', text: 'The agent did not provide a final reply. Check tool receipts before repeating an edit.', deliveryStatus: 'reply-unavailable', toolReceipts },
    { role: 'assistant', turnId: 'turn-failed', text: 'The request stopped.', deliveryStatus: 'failed', toolReceipts: { version: 1, entries: [{ ...receipt, outcome: 'unconfirmed' }], omitted: 0 } },
    { role: 'assistant', text: 'Ordinary answer.', deliveryStatus: 'made-up', toolReceipts: { version: 2, entries: [receipt] } },
  ] }))
  assert.deepEqual(clean.messages[0], { role: 'user', text: 'Trim this shot.', turnId: 'turn-trim' })
  assert.equal(clean.messages[1].deliveryStatus, 'reply-unavailable')
  assert.deepEqual(clean.messages[1].toolReceipts, { version: 1, entries: [{ id: receipt.id, toolName: 'edit_trim', outcome: 'applied' }], omitted: 3 })
  assert.equal(clean.messages[2].deliveryStatus, 'failed')
  assert.equal(clean.messages[2].toolReceipts.entries[0].outcome, 'unconfirmed')
  assert.deepEqual(clean.messages[3], { role: 'assistant', text: 'Ordinary answer.' })
  assert.doesNotMatch(JSON.stringify(clean), /private|arguments|reasoning|secret|untrusted/)
  const many = sanitizePublication(snapshot({ messages: [{ role: 'assistant', text: 'A bounded request record.', toolReceipts: {
    version: 1, entries: Array.from({ length: 80 }, (_, index) => ({ ...receipt, id: `agent-receipt-${String(index).padStart(8, '0')}-1111-4111-8111-111111111111` })), omitted: 0,
  } }] }))
  assert.equal(many.messages[0].toolReceipts.entries.length, 40)
  assert.equal(many.messages[0].toolReceipts.omitted, 40)
})

test('projection keeps latest history within 60 rows, 8KiB per message and 128KiB total UTF-8', () => {
  const many = Array.from({ length: 80 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `message-${index}` }))
  const clean = sanitizePublication(snapshot({ messages: many }))
  assert.equal(clean.messages.length, 60)
  assert.equal(clean.messages[0].text, 'message-20')
  const long = sanitizePublication(snapshot({ messages: many.map(row => ({ ...row, text: '🎬'.repeat(4000) })) }))
  assert.ok(long.messages.every(row => Buffer.byteLength(row.text) <= LIMITS.messageBytes))
  assert.ok(long.messages.reduce((total, row) => total + Buffer.byteLength(row.text), 0) <= LIMITS.totalTextBytes)
  assert.ok(long.messages.every(row => !/[\uD800-\uDBFF]$/.test(row.text)))
  assert.equal(sanitizePublication({}).available, false)
})

test('preview accepts only bounded JPEG inline data and an integer timestamp', () => {
  const frame = { dataUrl: jpeg, capturedAt: 0, workspace: 'storyboard' }
  assert.deepEqual(sanitizePublication({ preview: frame }).preview, frame)
  for (const change of [{ dataUrl: 'file:///private/frame.jpg' }, { dataUrl: 'https://example.com/frame.jpg' },
    { dataUrl: jpeg.replace('jpeg', 'png') }, { capturedAt: 'yesterday' }, { capturedAt: -1 }, { workspace: 'agent' },
    { dataUrl: 'data:image/jpeg;base64,YWJjZA==' },
    { dataUrl: `data:image/jpeg;base64,${Buffer.alloc(LIMITS.imageBytes + 1).toString('base64')}` }]) {
    assert.throws(() => sanitizePublication({ preview: { ...frame, ...change } }), { code: 'MOBILE_COMPANION_INVALID_REQUEST' })
  }
  for (const value of [{ available: 'yes' }, { busy: 1 }, { awaitingApproval: null }, { messages: 'raw log' }, { model: {} }]) {
    assert.throws(() => sanitizePublication(value), { code: 'MOBILE_COMPANION_INVALID_REQUEST' })
  }
})

test('phone text is emitted only as an inert pending review, accepted and completed separately', async () => {
  const f = fixture()
  await f.enable()
  let settled = false
  const pending = f.message({ fullAccess: true, provider: 'shell', token: 'secret' }).then(result => { settled = true; return result })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.deepEqual(f.events.at(-1), [CHANNELS.event, { type: 'message', id: 'phone-request-1', text: 'Make the next shot warmer.', scope: SCOPE }])
  const reply = result => f.call('reply', { scope: SCOPE, id: 'phone-request-1', result })
  assert.equal((await reply({ success: true, status: 'completed' })).success, false)
  assert.equal(settled, false)
  assert.equal((await reply({ success: true, status: 'accepted', fullAccess: true })).success, true)
  assert.deepEqual(await pending, { success: true, status: 'accepted' })
  assert.equal((await reply({ success: true, status: 'accepted' })).success, false)
  assert.equal((await reply({ success: true, status: 'completed', output: 'private tool output' })).success, true)
  assert.deepEqual(f.calls.filter(([name]) => name === 'resolve'), [
    ['resolve', SCOPE, 'phone-request-1', { success: true, status: 'accepted' }],
    ['resolve', SCOPE, 'phone-request-1', { success: true, status: 'completed' }],
  ])
  assert.equal((await reply({ success: true, status: 'completed' })).code, 'MOBILE_COMPANION_CONTEXT_CHANGED')
  await f.controller.dispose()
})

test('decline never accepts the phone message; foreign sender/scope/id cannot resolve review', async () => {
  const f = fixture()
  await f.enable()
  const pending = f.message()
  const result = { success: false, status: 'declined', error: 'Not now' }
  for (const request of [{ scope: OTHER, id: 'phone-request-1', result }, { scope: SCOPE, id: 'unknown', result }]) {
    assert.equal((await f.call('reply', request)).code, 'MOBILE_COMPANION_CONTEXT_CHANGED')
  }
  assert.equal((await f.call('reply', { scope: SCOPE, id: 'phone-request-1', result }, { ...f.event, senderFrame: {} })).code, 'MOBILE_COMPANION_UNAUTHORIZED')
  assert.equal((await f.call('reply', { scope: SCOPE, id: 'phone-request-1', result })).success, true)
  assert.deepEqual(await pending, result)
  assert.equal(f.calls.some(([name]) => name === 'resolve'), false)
  await f.controller.dispose()
})

test('an expired native receipt cannot acknowledge a desktop send even before the expiry notification', async () => {
  const f = fixture()
  await f.enable()
  const pending = f.message()
  f.server.resolveCommand = () => false
  const result = await f.call('reply', { scope: SCOPE, id: 'phone-request-1', result: { success: true, status: 'accepted' } })
  assert.equal(result.code, 'MOBILE_COMPANION_CONTEXT_CHANGED')
  assert.equal((await pending).success, false)
  await f.controller.dispose()
})

test('no phone review is staged while busy, awaiting another approval, or unavailable', async () => {
  for (const flags of [{ busy: true }, { awaitingApproval: true }, { available: false }]) {
    const f = fixture()
    await f.enable({ snapshot: snapshot(flags) })
    assert.equal((await f.message()).status, 'busy')
    assert.equal(f.events.some(([, value]) => value.type === 'message'), false)
    await f.controller.dispose()
  }
  const f = fixture()
  await f.enable()
  const first = f.message()
  assert.equal((await f.message({ id: 'phone-request-2' })).status, 'busy')
  await f.controller.dispose()
  assert.equal((await first).success, false)
})

test('invalid inbound messages and stale scopes cannot cross the native review boundary', async () => {
  const f = fixture()
  await f.enable()
  for (const change of [{ id: 'file:///bad' }, { text: '' }, { text: 'x'.repeat(LIMITS.phoneTextCharacters + 1) }, { text: 'null\u0000byte' }, { signal: AbortSignal.abort() }]) {
    assert.equal((await f.message(change)).success, false)
  }
  assert.equal(f.events.some(([, value]) => value.type === 'message'), false)
  assert.equal((await f.message({ scope: OTHER })).status, 'cancelled')
  assert.equal(f.server.getStatus().enabled, false)
  await f.controller.dispose()
})

test('phone UTF-8 budget accepts the same bounded non-ASCII messages as the server', async () => {
  const f = fixture()
  await f.enable()
  const text = '字'.repeat(LIMITS.phoneTextCharacters)
  const pending = f.message({ text })
  assert.equal(f.events.at(-1)[1].text, text)
  await f.call('reply', { scope: SCOPE, id: 'phone-request-1', result: { success: false, status: 'declined' } })
  assert.equal((await pending).status, 'declined')
  await f.controller.dispose()
})

test('same-scope heartbeat publication is sanitized, while a scope change revokes sharing', async () => {
  const f = fixture()
  await f.enable()
  assert.equal((await f.call('publish', { scope: SCOPE, snapshot: snapshot({ context: 'secret' }) })).success, true)
  assert.equal(f.calls.find(([name]) => name === 'publish')[2].context, undefined)
  assert.deepEqual(f.calls.find(([name]) => name === 'publish')[3], { rendererPublication: true })
  assert.equal((await f.call('publish', { scope: OTHER, snapshot: snapshot() })).code, 'MOBILE_COMPANION_CONTEXT_CHANGED')
  assert.equal(f.server.getStatus().enabled, false)
  await f.controller.dispose()
})

test('only authorized renderer attach/publish marks freshness; cached native reviews and detach do not', async () => {
  const path = require('node:path'), os = require('node:os')
  const f = fixture({ native: { deviceStorePath: path.join(os.tmpdir(), 'velorn-unused-synthetic-device.json') } })
  const value = snapshot({ protocol: 3, contextId: 'fresh-renderer-context' })
  await f.enable({ snapshot: value }); f.pair()
  assert.equal((await f.call('attach', { scope: SCOPE, snapshot: value })).success, true)
  assert.deepEqual(f.calls.filter(([name]) => name === 'publish').at(-1)[3], { rendererPublication: true })
  const marker = f.calls.length
  const approval = f.controller.confirm({ window: f.window, kind: 'generation-spending', title: 'Synthetic review', detail: 'No operation is run.' })
  assert.ok(approval)
  assert.ok(f.calls.slice(marker).some(([name]) => name === 'publish'))
  assert.ok(f.calls.slice(marker).filter(([name]) => name === 'publish').every(call => call[3] === undefined))
  assert.equal((await f.call('detach', { scope: SCOPE, contextId: value.contextId })).success, true)
  assert.equal((await approval).approved, false)
  assert.equal(f.calls.filter(([name]) => name === 'publish').at(-1)[3], undefined)
  const afterDetach = f.calls.length
  assert.equal((await f.call('publish', { scope: SCOPE, snapshot: value }, { ...f.event, senderFrame: {} })).success, false)
  assert.equal((await f.call('attach', { scope: SCOPE, snapshot: value, rendererPublication: true })).success, false)
  assert.equal(f.calls.length, afterDetach, 'Untrusted frame/payload cannot manufacture freshness')
  await f.controller.dispose()
})

test('navigation, crash, destruction, quit, and disposal invalidate pending desktop waits', async () => {
  for (const action of ['navigate', 'crash', 'destroy', 'quit', 'dispose']) {
    const f = fixture()
    await f.enable()
    const pending = f.message()
    if (action === 'navigate') f.contents.emit('did-start-navigation', {}, 'file:///synthetic.html', false, true)
    if (action === 'crash') f.contents.emit('render-process-gone', {}, { reason: 'crashed' })
    if (action === 'destroy') f.contents.emit('destroyed')
    if (action === 'quit') f.app.emit('will-quit')
    if (action === 'dispose') await f.controller.dispose()
    assert.equal((await pending).status, 'cancelled', action)
    assert.equal(f.server.getStatus().enabled, false, action)
    await f.controller.dispose()
  }
})

test('subframe and same-document navigation do not discard a live desktop sharing scope', async () => {
  const f = fixture()
  await f.enable()
  f.contents.emit('did-start-navigation', {}, 'https://embedded.invalid', false, false)
  f.contents.emit('did-start-navigation', {}, 'file:///editor#panel', true, true)
  assert.equal(f.server.getStatus().enabled, true)
  await f.controller.dispose()
})

test('server expiry clears pending native requests and sends native disabled status to the desktop', async () => {
  const f = fixture()
  await f.enable()
  const pending = f.message()
  f.notify({ enabled: false, reason: 'desktop-unavailable' })
  assert.equal((await pending).success, false)
  assert.deepEqual(f.events.at(-1), [CHANNELS.event, { type: 'status', status: { enabled: false, reason: 'desktop-unavailable' } }])
  assert.equal((await f.call('reply', { scope: SCOPE, id: 'phone-request-1', result: { success: true, status: 'accepted' } })).success, false)
  await f.controller.dispose()
})

test('server abort clears the review event and a short bounded timeout rejects without retry', async () => {
  const f = fixture({ replyTimeoutMs: 10 })
  await f.enable()
  const abort = new AbortController()
  const first = f.message({ signal: abort.signal })
  abort.abort()
  assert.equal((await first).status, 'cancelled')
  assert.equal(f.events.at(-1)[1].type, 'message-cancelled')
  const second = f.message({ id: 'phone-request-2' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal((await second).status, 'cancelled')
  assert.equal(f.calls.filter(([name]) => name === 'resolve').length, 1)
  await f.controller.dispose()
})

test('late confirmation after project disable or frame replacement cannot enable sharing', async () => {
  for (const change of ['disable', 'frame', 'window', 'crash']) {
    const consent = deferred()
    const f = fixture({ answer: () => consent.promise })
    const enabling = f.enable()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.dialogs.length, 1)
    if (change === 'disable') await f.call('disable', { scope: SCOPE })
    if (change === 'frame') f.contents.mainFrame = {}
    if (change === 'window') f.setWindow(null)
    if (change === 'crash') f.contents.emit('render-process-gone')
    consent.resolve({ response: 1, checkboxChecked: true })
    assert.equal((await enabling).code, 'MOBILE_COMPANION_CONTEXT_CHANGED', change)
    assert.equal(f.calls.some(([name]) => name === 'start'), false, change)
    await f.controller.dispose()
  }
})

test('a second concurrent enable cannot replace an outstanding native warning', async () => {
  const consent = deferred()
  const f = fixture({ answer: () => consent.promise })
  const first = f.enable()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await f.enable({ scope: OTHER })).code, 'MOBILE_COMPANION_BUSY')
  consent.resolve({ response: 1, checkboxChecked: true })
  assert.equal((await first).success, true)
  await f.controller.dispose()
})

test('disable during asynchronous server startup shuts down a late listener', async () => {
  const started = deferred()
  const f = fixture({ start: () => started.promise })
  const first = f.enable()
  await new Promise(resolve => setImmediate(resolve))
  await f.call('disable', { scope: SCOPE })
  started.resolve()
  assert.equal((await first).code, 'MOBILE_COMPANION_CONTEXT_CHANGED')
  assert.equal(f.server.getStatus().enabled, false)
  await f.controller.dispose()
})

test('unknown native failures never expose paths or provider secret diagnostics', async () => {
  const f = fixture({ start: () => { throw new Error('/home/private/password.json sk-secret-provider') } })
  const result = await f.enable()
  assert.equal(result.code, 'MOBILE_COMPANION_FAILED')
  assert.doesNotMatch(JSON.stringify(result), /home|password|sk-secret/)
  await f.controller.dispose()
  assert.equal(f.handlers.size, 0)
  assert.equal(f.app.listenerCount('will-quit'), 0)
  assert.equal(f.contents.listenerCount('did-start-navigation'), 0)
})
