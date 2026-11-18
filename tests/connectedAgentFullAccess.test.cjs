'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { registerConnectedAgentIpc, CHANNELS, validateSend } = require('../electron/connectedAgent.cjs')
const { PROJECT_CONVERSATION_GUIDANCE } = require('../electron/connectedAgentProjectGuidance.cjs')
const { prepareContinuity } = require('../electron/connectedAgentContinuity.cjs')

async function fixture(t, options = {}) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-full-access-consent-'))
  const context = { session: 'test-session', projectKey: folder, revision: 1 }
  const handlers = new Map(), events = [], calls = [], confirmations = []
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false,
    send: (channel, value) => events.push({ channel, ...value }) })
  const window = { webContents: contents, isDestroyed: () => false }
  const app = new EventEmitter()
  const controller = registerConnectedAgentIpc({
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
    getMainWindow: () => window, app, getToolContext: async () => ({ context: { ...context }, selection: {}, playhead: 0 }),
    getMcpServer: () => ({}), executeTool: async () => ({}), makeToolSession: async () => ({ listTools: async () => [] }),
    confirmFullAccess: async info => { confirmations.push(info); return true },
    codex: { send: async () => { calls.push('restricted'); return { success: true, text: 'Restricted fixture.' } } },
    sendFullAccessCodex: async (request, deps) => { calls.push({ request, deps }); return { success: true, text: 'Full fixture.' } },
    ...options,
  })
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const invoke = (key, payload, from = event) => handlers.get(CHANNELS[key])(from, payload)
  const enable = (extra = {}) => invoke('setFullAccess', { enabled: true, conversationId: 'chat-one', expectedContext: { ...context }, ...extra })
  const payload = (extra = {}) => ({ requestId: 'turn-one', provider: 'codex', messages: [{ role: 'user', content: 'Only a test.' }],
    context: {}, toolsEnabled: true, expectedContext: { ...context }, ...extra })
  const send = (grant, extra = {}) => invoke('send', payload({ fullAccess: true, fullAccessToken: grant.token, conversationId: 'chat-one', ...extra }))
  t.after(async () => { controller.dispose(); await fs.rmdir(folder) })
  return { folder, context, events, calls, confirmations, window, contents, app, controller, invoke, enable, payload, send }
}
const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)) }
  assert.fail('Expected fixture state did not arrive')
}
function memoryPreference(initial = false) {
  return { value: initial, calls: [],
    async read() { this.calls.push('read'); return this.value },
    async remember() { this.calls.push('remember'); this.value = true },
    async forget() { this.calls.push('forget'); this.value = false },
  }
}

test('restore-only is silent and fail-closed without literal saved native consent', async t => {
  for (const value of [false, undefined, null, 'true', { remembered: true }]) {
    const preference = memoryPreference(value)
    const f = await fixture(t, { fullAccessPreference: preference, confirmFullAccess: undefined })
    assert.deepEqual(await f.invoke('getFullAccessPreference'), { success: true, remembered: false })
    assert.deepEqual(await f.enable({ restoreOnly: true, remember: true }), { success: true, enabled: false, remembered: false })
    assert.equal(f.calls.length, 0)
    assert.equal(preference.calls.includes('remember'), false)
  }
  const f = await fixture(t, { fullAccessPreference: { read: async () => { throw Error('Unreadable') } } })
  assert.deepEqual(await f.enable({ restoreOnly: true }), { success: true, enabled: false, remembered: false })
  assert.equal(f.confirmations.length, 0)
})

test('saved consent mints fresh window/chat/project tokens across reloads and controllers without dialogs', async t => {
  const preference = memoryPreference(true)
  const f = await fixture(t, { fullAccessPreference: preference })
  const first = await f.enable({ restoreOnly: true })
  assert.equal(first.enabled, true); assert.equal(first.remembered, true); assert.equal(first.shareImagesAndView, true)
  assert.equal((await f.send(first)).success, true)
  f.contents.emit('did-start-navigation', {}, 'fixture', false, true)
  assert.equal((await f.send(first)).code, 'UNAUTHORIZED')
  const second = await f.enable({ restoreOnly: true })
  assert.notEqual(second.token, first.token)
  const nextChat = await f.enable({ restoreOnly: true, conversationId: 'chat-two' })
  assert.notEqual(nextChat.token, second.token)
  assert.equal((await f.send(second)).code, 'UNAUTHORIZED')
  assert.equal((await f.send(nextChat, { conversationId: 'chat-two' })).success, true)
  const g = await fixture(t, { fullAccessPreference: preference })
  const nextController = await g.enable({ restoreOnly: true })
  assert.notEqual(nextController.token, nextChat.token)
  assert.equal((await g.send(nextChat, { conversationId: 'chat-two' })).code, 'UNAUTHORIZED')
  assert.equal((await g.send(nextController)).success, true)
  assert.equal(f.confirmations.length + g.confirmations.length, 0)
  assert.equal(preference.calls.includes('remember'), false)
})

test('only explicit native desktop opt-in persists; renderer flags cannot grant remembered authority', async t => {
  const preference = memoryPreference()
  let remember = false, info
  const f = await fixture(t, { fullAccessPreference: preference, confirmFullAccess: async supplied => {
    info = supplied
    return { approved: true, shareImagesAndView: true, remember }
  } })
  const ephemeral = await f.enable({ remember: true })
  assert.equal(ephemeral.remembered, false); assert.equal(preference.value, false)
  assert.equal(info.isCurrent(), false, 'The confirmation lease ends after minting')
  remember = true
  const saved = await f.enable()
  assert.equal(info.remembered, false)
  assert.equal(saved.remembered, true); assert.equal(preference.value, true)
  assert.equal(preference.calls.filter(call => call === 'remember').length, 1)
  assert.deepEqual(await f.invoke('getFullAccessPreference'), { success: true, remembered: true })
  assert.equal((await f.invoke('setFullAccess', { enabled: false, conversationId: 'chat-one' })).remembered, true)
  const restored = await f.enable({ restoreOnly: true })
  assert.notEqual(restored.token, saved.token)
  remember = false
  const unchecked = await f.enable()
  assert.equal(info.remembered, true, 'Existing native preference is visible in the native dialog')
  assert.equal(unchecked.enabled, true); assert.equal(unchecked.remembered, false); assert.equal(preference.value, false)
})

test('manual enables always confirm; legacy callbacks and phone approvals preserve desktop choice without persisting', async t => {
  for (const remembered of [false, true]) {
    for (const mode of ['legacy', 'phone', 'binding']) {
      const preference = memoryPreference(remembered)
      let confirmations = 0
      const f = await fixture(t, { fullAccessPreference: preference, confirmFullAccess: async info => {
        confirmations++
        assert.equal(info.fromPhone, mode === 'phone')
        return mode === 'legacy' ? true : { approved: true, shareImagesAndView: true, remember: !remembered,
          ...(mode === 'binding' ? { mobileBinding: { isCurrent: () => true } } : {}) }
      } })
      const result = await f.enable({ fromPhone: mode === 'phone' })
      assert.equal(result.enabled, true); assert.equal(result.remembered, remembered)
      assert.equal(confirmations, 1)
      assert.equal(preference.value, remembered)
      assert.equal(preference.calls.some(call => call !== 'read'), false)
    }
  }
})

test('a native versioned phone bundle remembers only its provider and restores through the normal desktop preference', async t => {
  for (const provider of ['codex', 'lmstudio']) {
    const saved = new Map(), writes = []
    const preference = { read: async key => saved.get(key) === true,
      remember: async key => { writes.push(key); saved.set(key, true) }, forget: async key => saved.delete(key) }
    let confirmations = 0
    const f = await fixture(t, { fullAccessPreference: preference, confirmFullAccess: async info => {
      confirmations++; assert.equal(info.fromPhone, true); assert.equal(info.provider, provider)
      return { approved: true, shareImagesAndView: true, remember: true, phoneBundleVersion: 1, mobileBinding: { isCurrent: () => true } }
    } })
    const grant = await f.enable({ provider, fromPhone: true })
    assert.equal(grant.success, true); assert.equal(grant.enabled, true); assert.equal(grant.remembered, true); assert.equal(grant.shareImagesAndView, true)
    assert.deepEqual(writes, [provider])
    assert.equal(saved.size, 1)
    assert.equal((await f.invoke('getFullAccessPreference', { provider })).remembered, true)
    assert.equal((await f.invoke('getFullAccessPreference', { provider: provider === 'codex' ? 'lmstudio' : 'codex' })).remembered, false)
    const restored = await f.enable({ provider, restoreOnly: true })
    assert.equal(restored.enabled, true); assert.notEqual(restored.token, grant.token)
    assert.equal(confirmations, 1, 'Remembered restoration needs no second confirmation')
    assert.deepEqual(writes, [provider])
    await f.invoke('setFullAccess', { provider, enabled: false, forget: true, conversationId: 'chat-one' })
    assert.equal((await f.enable({ provider, restoreOnly: true })).enabled, false)
  }
})

test('renderer phone flags cannot manufacture a remembered bundle receipt', async t => {
  for (const native of [
    { mobileBinding: { isCurrent: () => true } },
    { phoneBundleVersion: 1 },
    { phoneBundleVersion: '1', mobileBinding: { isCurrent: () => true } },
    { phoneBundleVersion: 2, mobileBinding: { isCurrent: () => true } },
  ]) {
    const preference = memoryPreference()
    const f = await fixture(t, { fullAccessPreference: preference,
      confirmFullAccess: async () => ({ approved: true, shareImagesAndView: true, remember: true, ...native }) })
    const result = await f.enable({ fromPhone: true, phoneBundleVersion: 1, bundleVersion: 1, remember: true, mobileBinding: { isCurrent: () => true } })
    assert.equal(result.enabled, true)
    assert.equal(result.remembered, false)
    assert.equal(preference.value, false)
    assert.equal(preference.calls.includes('remember'), false)
  }
})

test('stale phone bindings cannot mint a bundle grant or leave a remembered preference after a late save', async t => {
  for (const timing of ['before-save', 'during-save']) {
    const preference = memoryPreference()
    let current = timing !== 'before-save'
    if (timing === 'during-save') preference.remember = async () => { preference.calls.push('remember'); preference.value = true; current = false }
    const f = await fixture(t, { fullAccessPreference: preference,
      confirmFullAccess: async () => ({ approved: true, shareImagesAndView: true, remember: true, phoneBundleVersion: 1, mobileBinding: { isCurrent: () => current } }) })
    const result = await f.enable({ fromPhone: true })
    assert.equal(result.success, false); assert.equal(result.code, 'STALE_APPROVAL')
    assert.equal(Object.hasOwn(result, 'token'), false)
    assert.equal(preference.value, false)
    if (timing === 'during-save') assert.equal(preference.calls.includes('forget'), true)
    else assert.equal(preference.calls.includes('remember'), false)
    assert.equal((await f.send({ token: 'not-minted' })).code, 'UNAUTHORIZED')
  }
})

test('phone consent callback or preference-save failures never mint access or persist a successful bundle', async t => {
  for (const failure of ['callback', 'save']) {
    const preference = memoryPreference()
    if (failure === 'save') preference.remember = async () => { preference.value = true; throw Error('Bundle storage failed') }
    const f = await fixture(t, { fullAccessPreference: preference, confirmFullAccess: async () => {
      if (failure === 'callback') throw Error('Spending bundle setup failed')
      return { approved: true, shareImagesAndView: true, remember: true, phoneBundleVersion: 1, mobileBinding: { isCurrent: () => true } }
    } })
    const result = await f.enable({ fromPhone: true })
    assert.equal(result.success, false); assert.equal(Object.hasOwn(result, 'token'), false)
    assert.equal(preference.value, false)
    assert.equal((await f.enable({ restoreOnly: true })).enabled, false)
    assert.equal((await f.send({ token: 'not-minted' })).code, 'UNAUTHORIZED')
  }
})

test('preference IPC is main-frame only and new switches are strictly boolean with desktop-only restore', async t => {
  const f = await fixture(t, { fullAccessPreference: memoryPreference(true) })
  const foreign = { sender: f.contents, senderFrame: {} }
  assert.equal((await f.invoke('getFullAccessPreference', undefined, foreign)).code, 'UNAUTHORIZED')
  for (const key of ['restoreOnly', 'forget', 'fromPhone']) for (const value of [null, 'true', 1, [], {}]) {
    assert.equal((await f.enable({ [key]: value })).code, 'INVALID_REQUEST')
  }
  for (const extra of [{ enabled: false, restoreOnly: true }, { forget: true }, { restoreOnly: true, fromPhone: true }]) {
    assert.equal((await f.enable(extra)).code, 'INVALID_REQUEST')
  }
  assert.equal(f.confirmations.length, 0)
})

test('restoration rechecks saved local project, availability, and window ownership without a popup', async t => {
  let unavailable = true
  const f = await fixture(t, { fullAccessPreference: memoryPreference(true), assertFullAccessAvailable: () => {
    if (unavailable) throw Object.assign(Error('Export active'), { code: 'BUSY' })
  } })
  assert.equal((await f.enable({ restoreOnly: true })).code, 'BUSY')
  unavailable = false
  assert.equal((await f.enable({ restoreOnly: true, expectedContext: { session: 'old', projectKey: f.folder } })).code, 'STALE_APPROVAL')
  assert.equal(f.confirmations.length, 0)
  assert.equal((await f.send({ token: 'not-minted' })).code, 'UNAUTHORIZED')
})

test('a cancelled native dialog never changes a remembered desktop choice', async t => {
  const preference = memoryPreference(true)
  const f = await fixture(t, { fullAccessPreference: preference,
    confirmFullAccess: async () => ({ approved: false, shareImagesAndView: true, remember: false }) })
  assert.deepEqual(await f.enable(), { success: true, enabled: false, remembered: true })
  assert.equal(preference.value, true)
  assert.equal(preference.calls.some(call => call !== 'read'), false)
})

test('stale asynchronous saves are rolled back before reads or restore can observe them', async t => {
  for (const change of ['project', 'navigation', 'disable']) {
    const preference = memoryPreference()
    let release, entered = false
    preference.remember = async () => { entered = true; await new Promise(resolve => { release = resolve }); preference.value = true }
    const f = await fixture(t, { fullAccessPreference: preference,
      confirmFullAccess: async () => ({ approved: true, shareImagesAndView: true, remember: true }) })
    const enabling = f.enable()
    await waitFor(() => entered)
    let disabling
    if (change === 'project') f.context.session = 'new-project-session'
    if (change === 'navigation') f.contents.emit('did-start-navigation', {}, 'fixture', false, true)
    if (change === 'disable') disabling = f.invoke('setFullAccess', { enabled: false, forget: true, conversationId: 'chat-one' })
    const reading = f.invoke('getFullAccessPreference')
    release()
    assert.equal((await enabling).code, 'STALE_APPROVAL')
    if (disabling) assert.equal((await disabling).enabled, false)
    assert.deepEqual(await reading, { success: true, remembered: false })
    assert.equal(preference.value, false)
    assert.equal((await f.enable({ restoreOnly: true })).enabled, false)
  }
})

test('failed saves roll back and never mint access, including when rollback itself fails', async t => {
  for (const rollbackFails of [false, true]) {
    const preference = memoryPreference()
    preference.remember = async () => { preference.value = true; throw Error('Failed write') }
    if (rollbackFails) preference.forget = async () => { throw Error('Failed rollback') }
    const f = await fixture(t, { fullAccessPreference: preference,
      confirmFullAccess: async () => ({ approved: true, shareImagesAndView: true, remember: true }) })
    const result = await f.enable()
    assert.equal(result.success, false); assert.equal(Object.hasOwn(result, 'token'), false)
    if (rollbackFails) { assert.equal(result.code, 'FULL_ACCESS_PREFERENCE_FAILED'); assert.match(result.error, /before restarting/) }
    assert.deepEqual(await f.invoke('getFullAccessPreference'), { success: true, remembered: false })
    assert.equal((await f.enable({ restoreOnly: true })).enabled, false)
    assert.equal((await f.send({ token: 'not-minted' })).code, 'UNAUTHORIZED')
  }
})

test('explicit Forget revokes running access immediately even while persistence is pending or fails', async t => {
  const preference = memoryPreference(true)
  let finishForget, deps
  preference.forget = async () => { await new Promise(resolve => { finishForget = resolve }); throw Object.assign(Error('Full access revoked, but remembered choice could not be cleared before restarting.'), { code: 'FULL_ACCESS_PREFERENCE_FAILED' }) }
  const f = await fixture(t, { fullAccessPreference: preference,
    sendFullAccessCodex: async (_request, supplied) => { deps = supplied; return new Promise(() => {}) } })
  const grant = await f.enable({ restoreOnly: true }), response = f.send(grant)
  await waitFor(() => deps)
  const disabling = f.invoke('setFullAccess', { enabled: false, forget: true, conversationId: 'chat-one' })
  assert.equal(deps.signal.aborted, true)
  assert.equal((await response).success, false)
  await waitFor(() => finishForget)
  finishForget()
  const result = await disabling
  assert.equal(result.code, 'FULL_ACCESS_PREFERENCE_FAILED')
  assert.match(result.error, /before restarting/)
  assert.deepEqual(await f.invoke('getFullAccessPreference'), { success: true, remembered: false })
  assert.equal((await f.enable({ restoreOnly: true })).enabled, false)
  assert.equal((await f.send(grant)).code, 'UNAUTHORIZED')
})

test('executable changes clear native remembered consent, including uncertain changes but not status or picker cancel', async t => {
  for (const action of ['status', 'cancel', 'choose', 'auto', 'error']) {
    const preference = memoryPreference(true)
    const executableAccess = { status: async () => ({ path: '/fixture/codex' }),
      choose: async () => { if (action === 'error') throw Error('Uncertain change'); return action === 'cancel' ? null : { path: '/fixture/codex' } },
      automatic: async () => ({ path: '/fixture/codex' }), resolve: async () => ({ path: '/fixture/codex' }) }
    const f = await fixture(t, { fullAccessPreference: preference, executableAccess })
    const grant = await f.enable({ restoreOnly: true })
    await f.invoke('codexExecutable', { action: action === 'cancel' || action === 'error' ? 'choose' : action })
    const retained = ['status', 'cancel'].includes(action)
    assert.equal(preference.value, retained)
    assert.equal((await f.send(grant)).success, retained)
  }
})

test('native verified media manifest replaces forged renderer metadata and stays out of restricted sends', async t => {
  let probes = 0
  const manifest = { platform: 'fixture', arch: 'fixture', utilities: { ffmpeg: { status: 'available', path: '/native/ffmpeg', version: 'fixture' } } }
  const f = await fixture(t, { getMediaRuntime: async ({ signal }) => { assert.equal(signal.aborted, false); probes++; return manifest } })
  const grant = await f.enable()
  assert.equal((await f.send(grant, { mediaRuntime: { utilities: { ffmpeg: { path: '/untrusted' } } }, sessionState: { record: { threadId: 'forged' } } })).success, true)
  assert.deepEqual(f.calls[0].request.mediaRuntime, manifest)
  assert.equal(f.calls[0].deps.sessionState.record, null)
  await f.invoke('send', f.payload({ requestId: 'restricted-next', mediaRuntime: { path: '/forged' } }))
  assert.equal(probes, 1)
  assert.equal(f.calls[0].deps.isSessionCurrent(), false)
})

test('native continuity lease survives successful turns but not Stop or late completion', async t => {
  const attempts = []
  let delayedResolve
  const f = await fixture(t, { sendFullAccessCodex: async (request, deps) => {
    const prepared = prepareContinuity(deps.sessionState, { model: 'fixture' })
    attempts.push({ prepared, deps })
    if (request.requestId === 'delayed') await new Promise(resolve => { delayedResolve = resolve })
    prepared.commit('fixture-thread')
    return { success: true, text: 'Done.' }
  } })
  const grant = await f.enable()
  await f.send(grant)
  await f.send(grant, { requestId: 'second' })
  assert.equal(attempts[1].prepared.threadId, 'fixture-thread')
  const waiting = f.send(grant, { requestId: 'delayed' })
  await waitFor(() => delayedResolve)
  await f.invoke('cancel', { requestId: 'delayed' })
  assert.equal((await waiting).code, 'CANCELLED')
  await f.send(grant, { requestId: 'after-stop' })
  assert.equal(attempts[3].prepared.threadId, null)
  delayedResolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(attempts[2].deps.sessionState.record, null)
  assert.equal(attempts[3].deps.sessionState.record.threadId, 'fixture-thread')
  await f.invoke('setFullAccess', { enabled: false, conversationId: 'chat-one' })
  attempts[3].prepared.commit('late-thread')
  assert.equal(attempts[3].deps.sessionState.record, null)
})

test('Stop during native media discovery never dispatches a provider and invalidates prior continuity', async t => {
  let block = false, entered = false, resolveProbe
  const states = [], modes = []
  const f = await fixture(t, {
    getMediaRuntime: async () => { if (block) { entered = true; await new Promise(resolve => { resolveProbe = resolve }) } return { utilities: {} } },
    sendFullAccessCodex: async (request, deps) => {
      states.push(deps.sessionState)
      const prepared = prepareContinuity(deps.sessionState, {})
      modes.push(prepared.mode)
      prepared.commit('fixture-thread')
      return { success: true }
    },
  })
  const grant = await f.enable()
  await f.send(grant)
  block = true
  const waiting = f.send(grant, { requestId: 'probe-stop' })
  await waitFor(() => entered)
  await f.invoke('cancel', { requestId: 'probe-stop' })
  assert.equal((await waiting).code, 'CANCELLED')
  resolveProbe(); block = false
  await f.send(grant, { requestId: 'after-probe-stop' })
  assert.equal(states.length, 2)
  assert.deepEqual(modes, ['new', 'new'], 'Cancelled preflight discards the previously successful mapping')
  assert.equal(states[1].epoch, 1, 'A fresh request began after cancelled preflight')
})

test('mobile native grants become unusable when their sharing binding expires', async t => {
  let current = true
  const f = await fixture(t, { confirmFullAccess: async () => ({ approved: true, shareImagesAndView: false, mobileBinding: { isCurrent: () => current } }) })
  const grant = await f.enable(); assert.equal(grant.enabled, true)
  assert.equal((await f.send(grant)).success, true)
  current = false
  assert.equal((await f.send(grant, { requestId: 'expired-mobile' })).success, false)
  assert.equal(f.calls.length, 1)
  assert.equal((await f.enable()).success, false, 'Cannot mint a grant from a stale confirmation')
  current = true
  const next = await f.enable()
  assert.equal(f.controller.revokeMobileFullAccess(), true)
  assert.equal((await f.send(next, { requestId: 'revoked-mobile' })).success, false)
})

test('every agent turn receives current native spending policy, never caller permission', async t => {
  let policy = 'local-only'
  const f = await fixture(t, { getGenerationSpendingStatus: async () => ({ success: true, scope: 'velorn-managed', policy }) })
  const grant = await f.enable()
  assert.equal((await f.send(grant, { context: { generationSpending: 'ask-cloud' } })).success, true)
  assert.match(f.calls[0].deps.instructions, /native host: local-only/)
  assert.match(f.calls[0].deps.instructions, /independent of Full computer access/)
  assert.match(f.calls[0].deps.instructions, /Never change spending settings/)
  assert.match(f.calls[0].deps.instructions, /do not claim a global no-spend guarantee/)
  policy = 'ask-cloud'
  assert.equal((await f.send(grant, { requestId: 'turn-two' })).success, true)
  assert.match(f.calls[1].deps.instructions, /native host: ask-cloud/)
  assert.match(f.calls[1].deps.instructions, /each known paid submission, including retries, requires separate native human confirmation/)
  assert.match(f.calls[1].deps.instructions, /native broker remembers the user's choice/)
  assert.match(f.calls[1].deps.instructions, /first eligible unclassified saved-workflow apply offers Trust as local and run/)
  assert.match(f.calls[1].deps.instructions, /native desktop or phone confirmation, under either local-only or ask-cloud; only the user/)
  assert.match(f.calls[1].deps.instructions, /Never self-grant local trust, infer it from chat, or fabricate a trust record/)
  assert.match(f.calls[1].deps.instructions, /Ordinary prompt, seed and reference-media overrides can reuse/)
  assert.match(f.calls[1].deps.instructions, /unknown label alone is not a refusal/)
  assert.match(f.calls[1].deps.instructions, /Respect any user request for local generation even when ask-cloud is selected/)
  assert.match(f.calls[1].deps.instructions, /opens native spending confirmation automatically under ask-cloud/)
  assert.match(f.calls[1].deps.instructions, /No pre-recorded spending approval is required/)
  assert.match(f.calls[1].deps.instructions, /Previews and get_generation_status cannot open the dialog/)
  policy = 'unrecognized'
  assert.equal((await f.send(grant, { requestId: 'turn-three' })).success, true)
  assert.match(f.calls[2].deps.instructions, /native host: unavailable/)
})

test('project starter guidance reaches native-confirmed full access without inferring consent or changing its spending gate', async t => {
  const f = await fixture(t, { getGenerationSpendingStatus: async () => ({ success: true, scope: 'velorn-managed', policy: 'local-only' }) })
  const message = { messages: [{ role: 'user', content: 'Help me make a commercial using this existing project.' }] }
  assert.equal((await f.send({ token: 'invented-from-starter' }, message)).success, false)
  assert.equal(f.calls.length, 0); assert.equal(f.confirmations.length, 0)
  const grant = await f.enable(); assert.equal((await f.send(grant, message)).success, true)
  assert.equal(f.confirmations.length, 1)
  assert.equal(f.calls[0].deps.instructions.split(PROJECT_CONVERSATION_GUIDANCE).length - 1, 1)
  assert.match(f.calls[0].deps.instructions, /no routine per-action approval cards/)
  assert.match(f.calls[0].deps.instructions, /native host: local-only/)
  assert.match(f.calls[0].deps.instructions, /separate native human confirmation/)
  assert.equal(f.calls[0].request.messages[0].content, message.messages[0].content)
})

test('completed and stopped turns cancel outstanding native generation approvals once', async t => {
  let ended = 0
  const f = await fixture(t, { onConversationEnd: () => { ended++ } })
  const grant = await f.enable()
  assert.equal(ended, 0, 'Permission setup is not a conversation ending')
  assert.equal((await f.send(grant)).success, true)
  assert.equal(ended, 1)
  let entered = false
  const g = await fixture(t, { onConversationEnd: () => { ended++ }, sendFullAccessCodex: async () => {
    entered = true
    return new Promise(() => {})
  } })
  const waiting = g.send(await g.enable())
  await waitFor(() => entered)
  await g.invoke('cancel', { requestId: 'turn-one' })
  assert.equal((await waiting).success, false)
  assert.equal(ended, 2, 'Stop and final cleanup do not notify twice')
})

test('full-access payload supports both providers but cannot inherit permission from context', async t => {
  const f = await fixture(t)
  assert.equal(validateSend(f.payload()).fullAccess, false)
  for (const extra of [{ fullAccess: 'true' }, { fullAccess: true },
    { fullAccess: true, fullAccessToken: 'forged', conversationId: 'chat-one', toolsEnabled: false }]) {
    assert.throws(() => validateSend(f.payload(extra)))
  }
  assert.equal((await f.send({ token: 'forged' })).code, 'UNAUTHORIZED')
  assert.equal(validateSend(f.payload({ fullAccess: true, fullAccessToken: 'forged', conversationId: 'chat-one', provider: 'lmstudio' })).fullAccess, true)
  assert.equal((await f.send({ token: 'forged' }, { provider: 'lmstudio' })).code, 'UNAUTHORIZED')
  assert.equal(f.calls.length, 0)
})

test('LM Studio full access uses local tools, not the Codex computer backend, and displays review images without model vision', async t => {
  const bodies = [], sessions = [], origins = []
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fQAAAABJRU5ErkJggg=='
  const f = await fixture(t, {
    getMediaRuntime: () => assert.fail('LM Studio must not discover Codex computer utilities'),
    sendFullAccessCodex: () => assert.fail('LM Studio must not launch Codex'),
    makeToolSession: async options => {
      sessions.push(options)
      return {
        listTools: async () => [{ name: 'get_timeline', description: 'Inspect timeline', inputSchema: { type: 'object', properties: {} } }],
        callTool: async (name, args) => {
          options.onEvent({ type: 'review-frame', frame: { dataUrl: image } })
          await options.executeTool(name, args, null)
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, clips: [] }) }, { type: 'image', data: image.split(',')[1], mimeType: 'image/png' }] }
        },
      }
    },
    executeTool: async (_name, _args, _guard, _signal, origin) => { origins.push(origin); return {} },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); bodies.push(body)
      const message = bodies.length === 1
        ? { content: null, tool_calls: [{ id: 'inspect', type: 'function', function: { name: 'get_timeline', arguments: '{}' } }] }
        : { content: 'Timeline inspected.' }
      return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }))
    },
  })
  const grant = await f.enable({ provider: 'lmstudio' })
  assert.equal(grant.enabled, true)
  assert.equal(f.confirmations[0].provider, 'lmstudio')
  const result = await f.send(grant, { provider: 'lmstudio', model: 'fixture-local', vision: false, allowToolImages: false })
  assert.equal(result.success, true, result.error)
  assert.equal(result.text, 'Timeline inspected.')
  assert.equal(sessions[0].trustedFullAccess, true)
  assert.equal(sessions[0].allowImages, true)
  assert.equal(origins[0].trustedFullAccess, true)
  assert.ok(f.events.some(event => event.type === 'review-frame'))
  assert.doesNotMatch(JSON.stringify(bodies[1]), /image_url|data:image/)
  assert.match(bodies[0].messages[0].content, /no routine per-action approval cards/)
  assert.match(bodies[0].messages[0].content, /not arbitrary computer shell/)
  assert.equal((await f.send(grant, { requestId: 'wrong-provider', provider: 'codex' })).code, 'UNAUTHORIZED')
})

test('remembered access and grants are provider-specific', async t => {
  const remembered = new Map([['lmstudio', true]])
  const preference = { read: async provider => remembered.get(provider) === true,
    remember: async provider => remembered.set(provider, true), forget: async provider => remembered.delete(provider) }
  const f = await fixture(t, { fullAccessPreference: preference })
  assert.deepEqual(await f.invoke('getFullAccessPreference', { provider: 'lmstudio' }), { success: true, remembered: true })
  assert.deepEqual(await f.invoke('getFullAccessPreference', { provider: 'codex' }), { success: true, remembered: false })
  const grant = await f.enable({ provider: 'lmstudio', restoreOnly: true })
  assert.equal(grant.enabled, true)
  assert.equal(f.confirmations.length, 0)
  assert.equal((await f.send(grant)).code, 'UNAUTHORIZED', 'A local-tool grant cannot authorize computer shell')
  assert.equal((await f.enable({ provider: 'codex', restoreOnly: true })).enabled, false)
  await f.invoke('setFullAccess', { provider: 'lmstudio', enabled: false, forget: true, conversationId: 'chat-one' })
  assert.equal(remembered.has('lmstudio'), false)
  assert.equal((await f.invoke('getFullAccessPreference', { provider: 'unknown' })).code, 'INVALID_PROVIDER')
})

test('LM Studio full access supports unsaved live projects without requiring a native command directory', async t => {
  const requests = []
  const f = await fixture(t, { makeToolSession: async () => ({ listTools: async () => [
    { name: 'get_timeline', description: 'Inspect the timeline.', inputSchema: { type: 'object', properties: {} } },
  ], callTool: async () => assert.fail('This check should not dispatch tools') }), fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body))
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Local tools ready.' }, finish_reason: 'stop' }] }))
  } })
  f.context.projectKey = 'unsaved-fixture-project'
  const local = await f.enable({ provider: 'lmstudio' })
  assert.equal(local.enabled, true)
  const result = await f.send(local, { provider: 'lmstudio', model: 'fixture-local' })
  assert.equal(result.success, true, result.error)
  assert.equal(requests.length, 1)
  const computer = await f.enable({ provider: 'codex' })
  assert.equal(computer.code, 'INVALID_REQUEST')
  assert.match(computer.error, /saved local project/)
})

test('native confirmation defaults to denial when absent, declined or nonboolean', async t => {
  for (const confirmFullAccess of [undefined, async () => false, async () => 'true',
    async () => ({ approved: 'true', shareImagesAndView: true }),
    async () => ({ approved: true }),
    async () => ({ approved: true, shareImagesAndView: 'true' }),
    async () => { throw new Error('Dialog unavailable') }]) {
    const f = await fixture(t, { confirmFullAccess })
    const grant = await f.enable()
    assert.notEqual(grant.enabled, true)
    assert.equal(Object.hasOwn(grant, 'shareImagesAndView'), false)
    assert.equal(Object.hasOwn(grant, 'token'), false)
    assert.equal((await f.send({ token: 'invented' })).success, false)
    assert.equal(f.calls.length, 0)
  }
})

test('optional image-sharing preference is strict and missing legacy input is off', async t => {
  const f = await fixture(t)
  for (const shareImagesAndView of [null, 'true', 'false', 0, 1, [], {}]) {
    assert.equal((await f.enable({ shareImagesAndView })).code, 'INVALID_REQUEST')
  }
  assert.equal(f.confirmations.length, 0)
  const legacy = await f.enable()
  assert.equal(f.confirmations[0].shareImagesAndView, false)
  assert.equal(legacy.enabled, true)
  assert.equal(legacy.shareImagesAndView, false)
  const requested = await f.enable({ shareImagesAndView: true })
  assert.equal(f.confirmations[1].shareImagesAndView, true)
  assert.equal(requested.shareImagesAndView, false, 'A preference cannot substitute for the native checkbox response')
})

test('native confirmation, not the requested default, determines the granted image-sharing choice', async t => {
  for (const requested of [false, true]) {
    for (const confirmed of [false, true]) {
      const f = await fixture(t, { confirmFullAccess: async info => {
        assert.equal(info.shareImagesAndView, requested)
        return { approved: true, shareImagesAndView: confirmed }
      } })
      const grant = await f.enable({ shareImagesAndView: requested })
      assert.equal(grant.enabled, true)
      assert.equal(grant.shareImagesAndView, confirmed)
      assert.equal((await f.send(grant)).success, true)
    }
  }
})

test('cancelled native consent cannot return image permission or retain an earlier grant', async t => {
  let approved = true
  const f = await fixture(t, { confirmFullAccess: async () => ({ approved, shareImagesAndView: true }) })
  const prior = await f.enable({ shareImagesAndView: true })
  approved = false
  const result = await f.enable({ shareImagesAndView: true })
  assert.deepEqual(result, { success: true, enabled: false, remembered: false })
  assert.equal((await f.send(prior)).code, 'UNAUTHORIZED')
  assert.equal(f.calls.length, 0)
})

test('confirmed session alone routes to full backend using native directory and live tools', async t => {
  const f = await fixture(t)
  const grant = await f.enable()
  assert.equal(grant.enabled, true)
  assert.match(grant.token, /^[a-f0-9-]{36}$/)
  assert.equal(f.confirmations.length, 1)
  assert.equal((await f.send(grant, { workingDirectory: '/untrusted/override', model: 'selected-model' })).success, true)
  const { request, deps } = f.calls[0]
  assert.equal(request.workingDirectory, await fs.realpath(f.folder))
  assert.equal(request.model, 'selected-model')
  assert.equal(request.fullAccess, true)
  assert.ok(deps.toolSession)
  assert.match(deps.instructions, /scope of the user's request/)
  assert.match(deps.instructions, /Never bypass a denied/)
  assert.match(deps.instructions, /generic duration\/FPS\/resolution fields describe requested metadata/)
  assert.match(deps.instructions, /verify the resulting media before claiming/)
  assert.match(deps.instructions, /natural prose and readable Markdown/)
  assert.match(deps.instructions, /explicitly requests JSON/)
  assert.doesNotMatch(deps.instructions, /you have no tools|no.*host shell/)
  // Ordinary authored revision changes do not turn the full-access checkbox off.
  f.context.revision++
  assert.equal((await f.send(grant, { requestId: 'turn-two' })).success, true)
})

test('only native-confirmed full access supplies automatic host tool authority', async t => {
  const sessions = []
  const f = await fixture(t, { makeToolSession: async options => {
    sessions.push(options); return { listTools: async () => [] }
  } })
  assert.equal((await f.invoke('send', f.payload({ trustedFullAccess: true }))).success, true)
  assert.equal(sessions[0].trustedFullAccess, false)
  assert.equal((await f.send({ token: 'invented' })).code, 'UNAUTHORIZED')
  assert.equal(sessions.length, 1)
  const grant = await f.enable()
  assert.equal((await f.send(grant, { trustedFullAccess: false })).success, true)
  assert.equal(sessions[1].trustedFullAccess, true)
  assert.match(f.calls.at(-1).deps.instructions, /no routine per-action approval cards/)
  assert.match(f.calls.at(-1).deps.instructions, /outside the user's existing authorization/)
})

test('native progress forwards public phases only with bounded, whitelisted fields', async t => {
  const f = await fixture(t, { sendFullAccessCodex: async (_request, deps) => {
    deps.onEvent({ type: 'progress', itemId: 'message-one', phase: 'commentary', status: 'running', text: 'Inspecting dependencies.', raw: 'must not cross IPC' })
    deps.onEvent({ type: 'progress', itemId: 'message-one', phase: 'commentary', status: 'completed', text: 'Dependencies inspected.' })
    deps.onEvent({ type: 'progress', itemId: 'message-two', phase: 'final_answer', status: 'completed', text: 'Done.' })
    for (const extra of [{ phase: 'reasoning' }, { status: 'unknown' }, { itemId: 'x'.repeat(201) }, { text: 'x'.repeat(65537) }]) {
      deps.onEvent({ type: 'progress', itemId: 'invalid', phase: 'commentary', status: 'running', text: 'Invalid.', ...extra })
    }
    deps.onEvent({ type: 'reasoning', text: 'Not public.' })
    return { success: true, text: 'Done.' }
  } })
  const grant = await f.enable()
  assert.equal((await f.send(grant)).success, true)
  assert.deepEqual(f.events.filter(event => event.type === 'progress').map(({ channel, ...event }) => event), [
    { requestId: 'turn-one', type: 'progress', itemId: 'message-one', phase: 'commentary', status: 'running', text: 'Inspecting dependencies.' },
    { requestId: 'turn-one', type: 'progress', itemId: 'message-one', phase: 'commentary', status: 'completed', text: 'Dependencies inspected.' },
    { requestId: 'turn-one', type: 'progress', itemId: 'message-two', phase: 'final_answer', status: 'completed', text: 'Done.' },
  ])
  assert.equal(f.events.some(event => event.type === 'reasoning'), false)
})

test('permission is bound to chat and the live project session, never payload metadata', async t => {
  const f = await fixture(t)
  const grant = await f.enable()
  assert.equal((await f.send(grant, { conversationId: 'another-chat' })).code, 'UNAUTHORIZED')
  f.context.session = 'reloaded-session'
  assert.equal((await f.send(grant)).code, 'STALE_APPROVAL')
  f.context.session = 'test-session'
  assert.equal((await f.send(grant)).code, 'UNAUTHORIZED')
  assert.equal(f.calls.length, 0)
})

test('main-frame boundary also protects enabling and revoking full access', async t => {
  const f = await fixture(t)
  for (const event of [{ sender: { isDestroyed: () => false }, senderFrame: f.contents.mainFrame }, { sender: f.contents, senderFrame: {} }]) {
    for (const enabled of [true, false]) assert.equal((await f.invoke('setFullAccess', { enabled, conversationId: 'chat-one', expectedContext: f.context }, event)).code, 'UNAUTHORIZED')
  }
  assert.equal(f.confirmations.length, 0)
})

test('permission revokes on navigation, renderer loss, shutdown and explicit disable', async t => {
  for (const reason of ['navigate', 'gone', 'shutdown', 'disable']) {
    const f = await fixture(t)
    const grant = await f.enable()
    if (reason === 'navigate') f.contents.emit('did-start-navigation', {}, 'about:blank', false, true)
    if (reason === 'gone') f.contents.emit('render-process-gone')
    if (reason === 'shutdown') f.app.emit('will-quit')
    if (reason === 'disable') await f.invoke('setFullAccess', { enabled: false, conversationId: 'chat-one' })
    if (reason !== 'shutdown') assert.equal((await f.send(grant)).code, 'UNAUTHORIZED')
    assert.equal(f.calls.length, 0)
  }
})

test('stale chat cleanup cannot revoke a different newly confirmed chat', async t => {
  const f = await fixture(t)
  const grant = await f.enable({ conversationId: 'chat-two' })
  await f.invoke('setFullAccess', { enabled: false, conversationId: 'chat-one' })
  assert.equal((await f.send(grant, { conversationId: 'chat-two' })).success, true)
})

test('late confirmation cannot grant access after disable, project switch or navigation', async t => {
  for (const action of ['disable', 'project', 'navigate']) {
    let release
    const f = await fixture(t, { confirmFullAccess: () => new Promise(resolve => { release = resolve }) })
    const pending = f.enable({ shareImagesAndView: true })
    await waitFor(() => release)
    assert.equal((await f.enable()).code, 'BUSY')
    if (action === 'disable') await f.invoke('setFullAccess', { enabled: false, conversationId: 'chat-one' })
    if (action === 'project') f.context.session = 'another-session'
    if (action === 'navigate') f.contents.emit('did-start-navigation', {}, 'about:blank', false, true)
    release({ approved: true, shareImagesAndView: true })
    const result = await pending
    assert.equal(result.code, 'STALE_APPROVAL')
    assert.equal(Object.hasOwn(result, 'shareImagesAndView'), false)
    assert.equal(Object.hasOwn(result, 'token'), false)
    assert.equal(f.calls.length, 0)
  }
})

test('export starting during native confirmation cannot grant either access or image permission', async t => {
  let release, exporting = false
  const f = await fixture(t, {
    confirmFullAccess: () => new Promise(resolve => { release = resolve }),
    assertFullAccessAvailable: async () => { if (exporting) throw Object.assign(new Error('Export running.'), { code: 'BUSY' }) },
  })
  const pending = f.enable({ shareImagesAndView: true })
  await waitFor(() => release)
  exporting = true
  release({ approved: true, shareImagesAndView: true })
  const result = await pending
  assert.equal(result.code, 'BUSY')
  assert.equal(Object.hasOwn(result, 'shareImagesAndView'), false)
  assert.equal(Object.hasOwn(result, 'token'), false)
  assert.equal(f.calls.length, 0)
})

test('production desktop confirmation remains native even with a paired phone and offers explicit remembering', async () => {
  const source = await fs.readFile(path.join(__dirname, '../electron/main.js'), 'utf8')
  const start = source.indexOf('  confirmFullAccess: async (')
  const end = source.indexOf('  getComfyRoot:', start)
  assert.ok(start > 0 && end > start)
  const dialogs = [], window = { isDestroyed: () => false, webContents: { isDestroyed: () => false } }
  let result = { response: 1 }
  const native = require('node:vm').runInNewContext(`({${source.slice(start, end)}})`, {
    mobileCompanion: { confirm: () => assert.fail('Desktop consent must not be redirected to the phone') },
    confirmDesktopFullAccess: require('../electron/connectedAgentAccessDialog.cjs').confirmDesktopFullAccess,
    dialog: { showMessageBox: async (owner, options) => {
      assert.equal(owner, window)
      dialogs.push(options)
      return result
    } },
  }).confirmFullAccess
  for (const requested of [undefined, false, true]) {
    const confirmed = await native({ window, shareImagesAndView: requested })
    assert.equal(confirmed.approved, true)
    assert.equal(confirmed.shareImagesAndView, true)
    const options = dialogs.at(-1)
    assert.equal(options.checkboxLabel, 'Remember on this desktop')
    assert.equal(options.checkboxChecked, true)
    assert.equal(options.defaultId, 0)
    assert.equal(options.cancelId, 0)
    assert.equal(options.buttons[0], 'Cancel')
    assert.match(options.detail, /Includes image sharing and the current Velorn view/)
    assert.match(options.detail, /Generation spending settings stay separate/)
    assert.match(options.detail, /data loss or unexpected costs/)
    assert.equal(confirmed.remember, false)
  }
  result = { response: 0 }
  const cancelled = await native({ window, shareImagesAndView: true })
  assert.equal(cancelled.approved, false)
  assert.equal(cancelled.shareImagesAndView, false)
  assert.equal(dialogs.length, 4, 'Exactly one native dialog for each request')
})

test('production phone confirmation includes images only after approval and retains the session binding', async () => {
  const source = await fs.readFile(path.join(__dirname, '../electron/main.js'), 'utf8')
  const start = source.indexOf('  confirmFullAccess: async (')
  const end = source.indexOf('  getComfyRoot:', start)
  const confirmations = [], window = {}, mobileBinding = { isCurrent: () => true }
  let approved = false
  const native = require('node:vm').runInNewContext(`({${source.slice(start, end)}})`, {
    FULL_ACCESS_SUMMARY: require('../electron/connectedAgentAccessDialog.cjs').SUMMARY,
    FULL_ACCESS_BUNDLE: require('../electron/connectedAgentAccessDialog.cjs').BUNDLE,
    confirmDesktopFullAccess: () => assert.fail('Phone consent must retain its phone binding'),
    mobileCompanion: { confirm: options => {
      confirmations.push(options)
      return Promise.resolve({ approved, mobileBinding })
    } },
    dialog: { showMessageBox: () => { throw Error('Must not open a second desktop dialog') } },
  }).confirmFullAccess
  for (approved of [false, true]) {
    const result = await native({ window, fromPhone: true, shareImagesAndView: false })
    assert.equal(result.approved, approved)
    assert.equal(result.shareImagesAndView, approved)
    assert.equal(result.mobileBinding, mobileBinding)
    const options = confirmations.at(-1)
    assert.equal(options.window, window)
    assert.equal(options.kind, 'full-access')
    assert.equal(options.requiresRiskAcknowledgement, false)
    assert.match(options.detail, /Includes image sharing and the current Velorn view/)
    assert.equal(result.remember, false)
  }
})

test('export gate blocks both confirmation and dispatch without contacting provider', async t => {
  let exporting = false
  const f = await fixture(t, { assertFullAccessAvailable: async () => { if (exporting) throw Object.assign(new Error('Export running.'), { code: 'BUSY' }) } })
  exporting = true
  assert.equal((await f.enable()).code, 'BUSY')
  assert.equal(f.confirmations.length, 0)
  exporting = false
  const grant = await f.enable()
  exporting = true
  assert.equal((await f.send(grant)).code, 'BUSY')
  assert.equal(f.calls.length, 0)
})

test('native execution events and one-use approval requests reach existing UI route', async t => {
  let approved
  const f = await fixture(t, { sendFullAccessCodex: async (_request, deps) => {
    deps.onEvent({ type: 'tool', callId: 'cmd-one', toolName: 'Run command', status: 'running', summary: 'Synthetic command only' })
    approved = await deps.requestApproval({ toolName: 'Run command', arguments: { command: 'synthetic' }, warnings: ['Fixture only.'] })
    deps.onEvent({ type: 'tool', callId: 'cmd-one', toolName: 'Run command', status: approved ? 'completed' : 'denied' })
    return { success: true, text: 'No command executed.' }
  } })
  const grant = await f.enable(), response = f.send(grant)
  await waitFor(() => f.events.some(event => event.type === 'approval'))
  const event = f.events.find(event => event.type === 'approval')
  assert.equal((await f.invoke('approveTool', { requestId: event.requestId, approvalId: event.approvalId, approved: false })).success, true)
  assert.equal((await response).success, true)
  assert.equal(approved, false)
  assert.equal((await f.invoke('approveTool', { requestId: event.requestId, approvalId: event.approvalId, approved: true })).code, 'STALE_APPROVAL')
  assert.ok(f.events.some(event => event.type === 'tool' && event.status === 'denied'))
})

test('Stop and disabling permission abort native work; late events cannot reach chat', async t => {
  for (const action of ['stop', 'disable']) {
    let deps
    const f = await fixture(t, { sendFullAccessCodex: async (_request, supplied) => { deps = supplied; return new Promise(() => {}) } })
    const grant = await f.enable(), response = f.send(grant)
    await waitFor(() => deps)
    if (action === 'stop') await f.invoke('cancel', { requestId: 'turn-one' })
    else await f.invoke('setFullAccess', { enabled: false, conversationId: 'chat-one' })
    assert.equal((await response).code, 'CANCELLED')
    assert.equal(deps.signal.aborted, true)
    const before = f.events.length
    deps.onEvent({ type: 'delta', text: 'Late reply' })
    deps.onEvent({ type: 'progress', itemId: 'late', phase: 'commentary', status: 'running', text: 'Late progress' })
    assert.equal(f.events.length, before)
  }
})

test('a restricted turn revokes prior full-access permission and retains the original backend', async t => {
  const f = await fixture(t)
  const grant = await f.enable()
  assert.equal((await f.invoke('send', f.payload())).success, true)
  assert.deepEqual(f.calls, ['restricted'])
  assert.equal((await f.send(grant)).code, 'UNAUTHORIZED')
})

test('Stop during full-access native preflight prevents any later provider launch', async t => {
  let hold = false, release, reached = false
  const f = await fixture(t, { assertFullAccessAvailable: async () => {
    if (hold) { reached = true; await new Promise(resolve => { release = resolve }) }
  } })
  const grant = await f.enable()
  hold = true
  const pending = f.send(grant)
  await waitFor(() => reached)
  assert.equal((await f.invoke('cancel', { requestId: 'turn-one' })).cancelled, true)
  assert.equal((await pending).code, 'CANCELLED')
  release()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.calls.length, 0)
})

test('disable during initial consent preflight prevents even opening a late confirmation', async t => {
  let release, confirmations = 0
  const f = await fixture(t, {
    assertFullAccessAvailable: () => new Promise(resolve => { release = resolve }),
    confirmFullAccess: async () => { confirmations++; return true },
  })
  const pending = f.enable()
  await waitFor(() => release)
  await f.invoke('setFullAccess', { enabled: false, conversationId: 'chat-one' })
  release()
  assert.equal((await pending).code, 'STALE_APPROVAL')
  assert.equal(confirmations, 0)
})
