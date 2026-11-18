'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { registerMobileCompanionIpc, CHANNELS } = require('../electron/mobileCompanion.cjs')
const { createMobileCompanionServer } = require('../electron/mobileCompanionServer.cjs')

const FIRST_SCOPE = 'synthetic-project-chat-session-001'
const NEXT_SCOPE = 'synthetic-project-chat-session-002'
const baseSnapshot = (extra = {}) => ({ projectName: 'Synthetic film', chatTitle: 'Synthetic conversation',
  provider: 'codex', model: 'synthetic-model-not-called', messages: [{ role: 'user', text: 'Discuss the lighting.' }],
  available: true, busy: false, awaitingApproval: false, status: 'Ready for desktop review', ...extra })

function request(status, route, { token, value = {}, method = 'POST' } = {}) {
  assert.match(status.localUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
  return new Promise((resolve, reject) => {
    const req = http.request(`${status.localUrl}${route}`, { method, agent: false,
      headers: { Origin: status.localUrl, 'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
        catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(new Error('Synthetic loopback request timed out')))
    req.end(method === 'GET' ? undefined : JSON.stringify(value))
  })
}

async function fixture(t, localControl = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-companion-integration-'))
  let controller
  t.after(async () => {
    await controller?.dispose()
    await fs.rm(root, { recursive: true, force: true })
  })
  // Disposable asset allowlist only; no real Site, project, provider or app files.
  await Promise.all(['live.html', 'live.js', 'live.css'].map(name => fs.writeFile(path.join(root, name), `Synthetic ${name}`)))
  const handlers = new Map(), events = [], dialogs = []
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false,
    send: (channel, value) => { assert.equal(channel, CHANNELS.event); events.push(value) } })
  const window = { webContents: contents, isDestroyed: () => false }
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const app = new EventEmitter()
  let server
  controller = registerMobileCompanionIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    app, getMainWindow: () => window, clientRoot: root,
    ...(localControl ? { deviceStorePath: path.join(root, 'remembered-device.json'), preferencePath: path.join(root,'phone-sharing.json') } : {}),
    dialog: { async showMessageBox(_window, options) {
      assert.equal(_window, window)
      dialogs.push(options)
      return { response: 1, checkboxChecked: true }
    } },
    createServer: options => {
      server = createMobileCompanionServer({ ...options, host: '127.0.0.1', port: 0, networkInterfaces: () => ({}) })
      return server
    },
  })
  const invoke = (method, payload) => handlers.get(CHANNELS[method])(event, payload)
  return { controller, server, window, events, dialogs, handlers, invoke,
    async enable(scope, snapshot = baseSnapshot()) {
      const response = await invoke('enable', { scope, snapshot })
      assert.equal(response.success, true, response.error)
      assert.equal(response.status.enabled, true)
      assert.deepEqual(response.status.urls, [], 'The test listener must expose no LAN URL')
      return response.status
    },
    async pair(status) {
      const response = await request(status, '/api/pair', { value: { code: status.pairingCode } })
      assert.equal(response.status, 200)
      assert.equal(response.body.success, true)
      assert.equal(response.body.fullAccess, false)
      assert.equal(response.body.remoteApprovals, false)
      return response.body.token
    },
  }
}

test('native receipt status survives phone reconnect without resubmitting any action', async t => {
  const f = await fixture(t)
  const status = await f.enable(FIRST_SCOPE)
  const token = await f.pair(status)
  const messages = [
    { role: 'user', turnId: 'trim-request', text: 'Trim the last shot.' },
    { role: 'assistant', turnId: 'trim-request', deliveryStatus: 'reply-unavailable',
      text: 'The final reply is unavailable. Review the recorded tool outcomes before repeating an edit.',
      toolReceipts: { version: 1, omitted: 0, entries: [
        { id: 'agent-receipt-11111111-1111-4111-8111-111111111111', toolName: 'edit_trim', outcome: 'applied', output: 'private raw tool result' },
        { id: 'agent-receipt-22222222-2222-4222-8222-222222222222', toolName: 'get_timeline', outcome: 'read' },
      ] } },
  ]
  assert.equal((await f.invoke('publish', { scope: FIRST_SCOPE, snapshot: baseSnapshot({ messages }) })).success, true)
  const first = await request(status, '/api/state', { token })
  const reconnected = await request(status, '/api/state', { token })
  assert.equal(first.status, 200)
  assert.deepEqual(reconnected.body.snapshot.messages, first.body.snapshot.messages)
  const reply = first.body.snapshot.messages[1]
  assert.equal(reply.deliveryStatus, 'reply-unavailable')
  assert.equal(reply.turnId, 'trim-request')
  assert.deepEqual(reply.toolReceipts.entries.map(item => [item.toolName, item.outcome]), [['edit_trim', 'applied'], ['get_timeline', 'read']])
  assert.doesNotMatch(JSON.stringify(first.body), /private raw|output/)
  assert.equal(f.events.some(event => event.type === 'message' || event.type === 'command'), false)
})

test('real native adapter and loopback server share one reviewed conversation and revoke all stale phone authority', async t => {
  const f = await fixture(t)
  assert.equal(f.server.getStatus().enabled, false)
  assert.equal(f.dialogs.length, 0)
  const status = await f.enable(FIRST_SCOPE, baseSnapshot({ available: false }))
  assert.equal(f.dialogs.length, 1)
  assert.equal(f.dialogs[0].checkboxChecked, false)
  const token = await f.pair(status)
  assert.equal(f.events.at(-1).type, 'status')
  assert.equal(f.events.at(-1).status.paired, true)
  assert.equal(f.events.at(-1).status.pairingCode, null)
  assert.equal((await f.invoke('publish', { scope: FIRST_SCOPE, snapshot: baseSnapshot() })).success, true)

  const phoneRequest = { id: 'synthetic-phone-message-1', text: 'Should this scene be warmer?' }
  const sent = await request(status, '/api/message', { token, value: phoneRequest })
  assert.equal(sent.status, 202)
  assert.equal(sent.body.receipt.status, 'pending')
  const incoming = f.events.filter(value => value.type === 'message')
  assert.deepEqual(incoming, [{ type: 'message', scope: FIRST_SCOPE, ...phoneRequest }])
  let state = await request(status, '/api/state', { token })
  assert.equal(state.body.receipt.status, 'pending')
  assert.equal(state.body.busy, true)
  assert.deepEqual(state.body.snapshot.messages, baseSnapshot().messages)
  assert.equal((await request(status, '/api/message', { token, value: { id: 'blocked-message', text: 'A second request' } })).body.error, 'BUSY')
  assert.equal((await f.invoke('reply', { scope: FIRST_SCOPE, id: phoneRequest.id,
    result: { success: true, status: 'completed' } })).success, false, 'Phone text cannot skip desktop acceptance')

  // Only this simulated explicit desktop click crosses pending -> accepted.
  assert.equal((await f.invoke('reply', { scope: FIRST_SCOPE, id: phoneRequest.id,
    result: { success: true, status: 'accepted' } })).success, true)
  state = await request(status, '/api/state', { token })
  assert.equal(state.body.receipt.status, 'accepted')
  assert.equal(state.body.busy, true)

  // Publish a synthetic answer/still. No model, media capture or project mutation.
  const preview = { dataUrl: 'data:image/jpeg;base64,/9j/2Q==', capturedAt: 123456, workspace: 'editor' }
  const messages = [...baseSnapshot().messages, { role: 'user', text: phoneRequest.text },
    { role: 'assistant', text: 'A warmer palette could suit this scene.' }]
  assert.equal((await f.invoke('publish', { scope: FIRST_SCOPE, snapshot: baseSnapshot({ messages,
    activity: { updatedAt: 12345, items: [{ id:'tool-1',kind:'tool',toolName:'get_timeline',status:'completed',summary:'Timeline inspected.',output:'private raw log' }] },
    preview: { ...preview, path: '/private/still.jpg' }, context: { path: '/private/project' }, fullAccessToken: 'must-not-be-shared',
    toolOutput: 'private raw log', status: 'Synthetic answer complete' }) })).success, true)
  state = await request(status, '/api/state', { token })
  assert.equal(state.body.busy, true, 'Publication alone must not complete the receipt')
  assert.equal((await f.invoke('reply', { scope: FIRST_SCOPE, id: phoneRequest.id,
    result: { success: true, status: 'completed', output: 'private tool log' } })).success, true)
  state = await request(status, '/api/state', { token })
  assert.equal(state.body.receipt.status, 'completed')
  assert.equal(state.body.receipts.length, 1)
  assert.equal(state.body.busy, false)
  assert.deepEqual(state.body.snapshot.messages, messages)
  assert.deepEqual(state.body.snapshot.preview, preview)
  assert.equal(state.body.snapshot.activity.items[0].toolName, 'get_timeline')
  assert.equal(state.body.snapshot.activity.items[0].status, 'completed')
  assert.equal(state.body.snapshot.activity.updatedAt, 12345)
  assert.doesNotMatch(JSON.stringify(state.body), /synthetic-project-chat-session|pairingCode|must-not-be-shared|private|fullAccessToken|toolOutput/)
  const duplicate = await request(status, '/api/message', { token, value: phoneRequest })
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.body.duplicate, true)
  assert.equal(duplicate.body.receipt.status, 'completed')
  assert.equal(f.events.filter(value => value.type === 'message').length, 1)

  // Changing the opaque project/chat scope closes the listener and pending wait.
  const staleRequest = { id: 'synthetic-pending-before-switch', text: 'Do not send after the chat changes.' }
  assert.equal((await request(status, '/api/message', { token, value: staleRequest })).status, 202)
  assert.equal((await f.invoke('publish', { scope: NEXT_SCOPE, snapshot: baseSnapshot() })).code, 'MOBILE_COMPANION_CONTEXT_CHANGED')
  assert.equal(f.server.getStatus().enabled, false)
  assert.equal((await f.invoke('reply', { scope: FIRST_SCOPE, id: staleRequest.id,
    result: { success: true, status: 'accepted' } })).code, 'MOBILE_COMPANION_CONTEXT_CHANGED')
  await assert.rejects(request(status, '/api/state', { token }))

  const nextStatus = await f.enable(NEXT_SCOPE, baseSnapshot({ projectName: 'Second synthetic project', messages: [] }))
  assert.equal((await request(nextStatus, '/api/state', { token })).status, 401)
  const nextToken = await f.pair(nextStatus)
  assert.notEqual(nextToken, token)
  state = await request(nextStatus, '/api/state', { token: nextToken })
  assert.equal(state.body.receipt, null)
  assert.deepEqual(state.body.receipts, [])
  assert.deepEqual(state.body.snapshot.messages, [])
  assert.equal(state.body.snapshot.preview, null)

  // Authenticated phone unpair also cancels native desktop review, not only UI.
  const unpairedRequest = { id: 'synthetic-pending-before-unpair', text: 'Do not send after I unpair.' }
  assert.equal((await request(nextStatus, '/api/message', { token: nextToken, value: unpairedRequest })).status, 202)
  assert.equal((await request(nextStatus, '/api/unpair', { token: nextToken })).status, 200)
  assert.equal(f.server.getStatus().enabled, false)
  assert.equal(f.events.at(-1).type, 'status')
  assert.equal(f.events.at(-1).status.reason, 'unpaired')
  assert.ok(f.events.some(value => value.type === 'message-cancelled' && value.id === unpairedRequest.id && value.scope === NEXT_SCOPE))
  assert.equal((await f.invoke('reply', { scope: NEXT_SCOPE, id: unpairedRequest.id,
    result: { success: true, status: 'accepted' } })).code, 'MOBILE_COMPANION_CONTEXT_CHANGED')
  await assert.rejects(request(nextStatus, '/api/state', { token: nextToken }))

  const finalStatus = await f.enable(NEXT_SCOPE, baseSnapshot({ messages: [] }))
  assert.equal((await request(finalStatus, '/api/state', { token: nextToken })).status, 401)
  const finalToken = await f.pair(finalStatus)
  state = await request(finalStatus, '/api/state', { token: finalToken })
  assert.deepEqual(state.body.receipts, [])
  assert.equal(state.body.receipt, null)
  assert.equal((await f.invoke('disable', { scope: NEXT_SCOPE })).success, true)
  assert.equal(f.server.getStatus().enabled, false)
  await assert.rejects(request(finalStatus, '/api/state', { token: finalToken }))
  await f.controller.dispose()
  assert.equal(f.handlers.size, 0)
})

const controlSnapshot = (extra = {}) => baseSnapshot({ protocol: 2, contextId: 'context-1', chatId: 'chat-1',
  models: [{ id: 'synthetic-model-not-called', label: 'Synthetic' }],
  projects: [{ id: 'project-1', name: 'First project', current: true }, { id: 'project-2', name: 'Second project' }], ...extra })

test('chat navigation HTTP receipts survive context changes, reject stale/busy selections and never replay edits', async t => {
  const f = await fixture(t, true)
  const first = controlSnapshot({ protocol: 3, chatNavigation: true, chats: [
    { id: 'chat-1', provider: 'codex', title: 'First', updatedAt: 10 },
    { id: 'chat-2', provider: 'lmstudio', title: 'Second', updatedAt: 20 },
  ], messages: [{ role: 'assistant', turnId: 'prior-edit', text: 'Reply unavailable.', deliveryStatus: 'reply-unavailable',
    toolReceipts: { version: 1, omitted: 0, entries: [{ id: 'agent-receipt-11111111-1111-4111-8111-111111111111', toolName: 'edit_trim', outcome: 'applied' }] } }] })
  const status = await f.enable(FIRST_SCOPE, first)
  const token = (await request(status, '/api/pair', { value: { code: status.pairingCode } })).body.token
  const post = value => request(status, '/api/command', { token, value })
  const action = { id: 'select-chat-once', kind: 'chat', contextId: first.contextId, provider: 'lmstudio', chatId: 'chat-2' }
  assert.equal((await request(status, '/api/command', { value: action })).status, 401)
  for (const invalid of [{ chatId: '../private' }, { provider: 'codex' }, { projectId: 'project-2' }, { fullAccess: true }]) {
    assert.equal((await post({ ...action, ...invalid })).status, 409)
  }
  await f.invoke('publish', { scope: FIRST_SCOPE, snapshot: { ...first, busy: true } })
  assert.equal((await post(action)).body.error, 'BUSY')
  await f.invoke('publish', { scope: FIRST_SCOPE, snapshot: first })
  assert.equal((await post(action)).status, 202)
  assert.equal((await post(action)).body.duplicate, true)
  assert.equal((await post({ ...action, id: 'another-while-pending' })).body.error, 'BUSY')
  assert.equal(f.events.filter(event => event.type === 'command').length, 1)
  assert.equal((await f.invoke('reply', { scope: FIRST_SCOPE, id: action.id, result: { success: true, status: 'accepted' } })).success, true)
  await f.invoke('detach', { scope: FIRST_SCOPE, contextId: first.contextId })
  const second = { ...first, contextId: 'context-2', chatId: 'chat-2', provider: 'lmstudio', messages: [], fullAccess: false }
  assert.equal((await f.invoke('attach', { scope: FIRST_SCOPE, snapshot: second })).status.paired, true)
  assert.equal((await f.invoke('reply', { scope: FIRST_SCOPE, id: action.id, result: { success: true, status: 'completed' } })).success, true)
  const completed = await post(action)
  assert.equal(completed.body.duplicate, true); assert.equal(completed.body.receipt.status, 'completed')
  assert.equal((await post({ ...action, id: 'stale-selection' })).body.error, 'STALE_CONTEXT')
  assert.equal((await post({ ...action, contextId: second.contextId })).body.error, 'ID_REUSED')
  let state = (await request(status, '/api/state', { token })).body
  assert.equal(state.busy, false); assert.deepEqual(state.snapshot.messages, [])
  assert.equal(state.snapshot.chats.find(chat => chat.current).provider, 'lmstudio')
  assert.equal(f.controller.claimFullAccess({ window: f.window, provider: 'lmstudio' }), null)

  const create = { id: 'new-chat-once', kind: 'new-chat', contextId: second.contextId }
  assert.equal((await post(create)).status, 202)
  await f.invoke('reply', { scope: FIRST_SCOPE, id: create.id, result: { success: true, status: 'accepted' } })
  const third = { ...second, contextId: 'context-3', chatId: 'chat-3' }
  await f.invoke('attach', { scope: FIRST_SCOPE, snapshot: third })
  await f.invoke('reply', { scope: FIRST_SCOPE, id: create.id, result: { success: true, status: 'completed' } })
  assert.equal((await post(create)).body.duplicate, true)

  const pending = { id: 'pending-when-desktop-changes', kind: 'new-chat', contextId: third.contextId }
  assert.equal((await post(pending)).status, 202)
  await f.invoke('attach', { scope: FIRST_SCOPE, snapshot: { ...first, contextId: 'context-restored' } })
  assert.equal((await f.invoke('reply', { scope: FIRST_SCOPE, id: pending.id, result: { success: true, status: 'accepted' } })).success, false)
  assert.equal((await post(pending)).body.receipt.status, 'rejected')
  state = (await request(status, '/api/state', { token })).body
  assert.equal(state.snapshot.messages[0].toolReceipts.entries[0].outcome, 'applied')
  assert.equal(state.snapshot.messages[0].deliveryStatus, 'reply-unavailable')
  assert.equal(state.busy, false)
  assert.equal(f.events.filter(event => event.type === 'command').length, 3)
  assert.equal(f.events.some(event => event.type === 'message'), false)
  assert.equal(f.dialogs.length, 1, 'Only original pairing consent; navigation never changes permission/spending policy')
})

test('parity approvals include file and generation actions from desktop turns without exposing internal guards', async t => {
  const f = await fixture(t, true), snapshot = controlSnapshot({ protocol: 3 })
  const status = await f.enable(FIRST_SCOPE, snapshot)
  const token = (await request(status, '/api/pair', { value: { code: status.pairingCode } })).body.token
  const approval = { approvalId: 'download-approval', requestId: 'desktop-request', toolName: 'download_model',
    arguments: JSON.stringify({ destination: '/synthetic/models/model.bin', previewToken: 'internal-guard', expectedContext: { projectKey: '/internal/project' } }),
    reviewable: true, state: 'pending' }
  await f.invoke('publish', { scope: FIRST_SCOPE, snapshot: { ...snapshot, busy: true, phoneRequest: false, approvals: [approval] } })
  const view = (await request(status, '/api/state', { token })).body.snapshot.approvals[0]
  assert.equal(view.remoteEligible, true); assert.match(view.arguments, /synthetic\/models/)
  assert.doesNotMatch(view.arguments, /internal-guard|internal\/project/)
  const action = { id: 'approve-download', kind: 'approval', contextId: snapshot.contextId, approvalId: view.approvalId, reviewToken: view.reviewToken, approved: true }
  assert.equal((await request(status, '/api/command', { token, value: action })).status, 202)
  assert.equal(f.events.at(-1).command.kind, 'approval')
  assert.equal((await f.invoke('reply', { scope: FIRST_SCOPE, id: action.id, result: { success: true, status: 'accepted' } })).success, true)
  // Test never executes a tool or downloads anything: only the desktop dispatch boundary.
  await f.invoke('reply', { scope: FIRST_SCOPE, id: action.id, result: { success: true, status: 'completed' } })
})

test('native full-access and spending confirmations work during an active phone command and are one-use', async t => {
  const f = await fixture(t, true), snapshot = controlSnapshot({ protocol: 3 })
  const status = await f.enable(FIRST_SCOPE, snapshot)
  const token = (await request(status, '/api/pair', { value: { code: status.pairingCode } })).body.token
  const access = { id: 'enable-full', kind: 'access', mode: 'full', contextId: snapshot.contextId }
  assert.equal((await request(status, '/api/command', { token, value: access })).status, 202)
  await f.invoke('reply', { scope: FIRST_SCOPE, id: access.id, result: { success: true, status: 'accepted' } })
  const confirmation = f.controller.confirm({ window: f.window, kind: 'full-access', title: 'Full access?', detail: 'Can change files and spend credits.' })
  const view = (await request(status, '/api/state', { token })).body.snapshot.nativeApprovals[0]
  const answer = { id: 'answer-full', kind: 'native-approval', contextId: snapshot.contextId, approvalId: view.approvalId, reviewToken: view.reviewToken, approved: true, riskAcknowledged: false }
  assert.equal((await request(status, '/api/command', { token, value: answer })).status, 409)
  answer.riskAcknowledged = true
  assert.equal((await request(status, '/api/command', { token, value: answer })).status, 202)
  const result = await confirmation
  assert.equal(result.approved, true); assert.equal(result.mobileBinding.isCurrent(), true)
  assert.equal((await request(status, '/api/command', { token, value: { ...answer, id: 'replay' } })).status, 409)
  await f.invoke('reply', { scope: FIRST_SCOPE, id: access.id, result: { success: true, status: 'completed' } })
  const abort = new AbortController()
  const spend = f.controller.confirm({ window: f.window, kind: 'generation-spending', title: 'Pay?', detail: 'One exact workflow, cost unknown.', signal: abort.signal })
  assert.equal((await request(status, '/api/state', { token })).body.snapshot.nativeApprovals[0].kind, 'generation-spending')
  abort.abort(); assert.equal((await spend).approved, false)
  const declined = f.controller.confirm({ window: f.window, kind: 'spending-policy', title: 'Cloud?', detail: 'Still asks each time.' })
  const desktopView = f.events.findLast(e => e.type === 'native-approvals').approvals[0]
  assert.equal((await f.invoke('decideNative', { scope: FIRST_SCOPE, approvalId: desktopView.approvalId,
    reviewToken: desktopView.reviewToken, approved: false, riskAcknowledged: false })).success, true)
  assert.equal((await declined).approved, false)
  const outstanding = f.controller.confirm({ window: f.window, kind: 'full-access', title: 'Full?', detail: 'risk' })
  await f.invoke('attach', { scope: FIRST_SCOPE, snapshot: { ...snapshot, contextId: 'new-chat' } })
  assert.equal((await outstanding).approved, false); assert.equal(result.mobileBinding.isCurrent(), false)
  assert.deepEqual((await request(status, '/api/state', { token })).body.snapshot.nativeApprovals, [])
})

test('authenticated bundled access action is one-use without a second phone confirmation',async t=>{
  const f=await fixture(t,true),snapshot=controlSnapshot({protocol:3})
  const status=await f.enable(FIRST_SCOPE,snapshot)
  const token=(await request(status,'/api/pair',{value:{code:status.pairingCode}})).body.token
  const command={id:'take-full-once',kind:'access',mode:'full',bundleVersion:1,contextId:snapshot.contextId}
  assert.equal((await request(status,'/api/command',{value:command})).status,401)
  assert.equal(f.controller.claimFullAccess({window:f.window,provider:'codex'}),null)
  assert.equal((await request(status,'/api/command',{token,value:command})).status,202)
  assert.equal(f.controller.claimFullAccess({window:f.window,provider:'codex'}),null)
  await f.invoke('reply',{scope:FIRST_SCOPE,id:command.id,result:{success:true,status:'accepted'}})
  const claim=f.controller.claimFullAccess({window:f.window,provider:'codex'})
  assert.equal(claim.approved,true);assert.equal(claim.phoneBundleVersion,1);assert.equal(claim.remember,true)
  assert.equal(f.controller.claimFullAccess({window:f.window,provider:'codex'}),null)
  await f.invoke('reply',{scope:FIRST_SCOPE,id:command.id,result:{success:true,status:'completed'}})
  assert.equal(claim.mobileBinding.isCurrent(),true)
  assert.deepEqual((await request(status,'/api/state',{token})).body.snapshot.nativeApprovals || [],[])
  await f.invoke('detach',{scope:FIRST_SCOPE,contextId:snapshot.contextId})
  assert.equal(claim.mobileBinding.isCurrent(),false)
  await f.invoke('attach',{scope:FIRST_SCOPE,snapshot})
  assert.equal(claim.mobileBinding.isCurrent(),false,'Old grant cannot revive after detach')
  assert.equal((await f.invoke('preference')).enabled,true)
  await request(status,'/api/unpair',{token})
  assert.equal((await f.invoke('preference')).enabled,false)
})

test('LM Studio phone controls expose and dispatch Full Velorn access', async t => {
  const f = await fixture(t, true), snapshot = controlSnapshot({ protocol: 3, provider: 'lmstudio' })
  const status = await f.enable(FIRST_SCOPE, snapshot)
  const token = (await request(status, '/api/pair', { value: { code: status.pairingCode } })).body.token
  const view = (await request(status, '/api/state', { token })).body.snapshot
  assert.equal(view.fullAccessSupported, true)
  const action = { id: 'enable-local-full', kind: 'access', mode: 'full', contextId: snapshot.contextId }
  assert.equal((await request(status, '/api/command', { token, value: action })).status, 202)
  assert.equal(f.events.at(-1).command.mode, 'full')
  await f.invoke('reply', { scope: FIRST_SCOPE, id: action.id, result: { success: true, status: 'completed' } })
})

test('the reported 77-second playhead move is visible and approvable through the phone boundary', async t => {
  const f = await fixture(t, true), status = await f.enable(FIRST_SCOPE, controlSnapshot())
  const token = (await request(status, '/api/pair', { value: { code: status.pairingCode } })).body.token
  const args = { timeSeconds: 77, snapToFrame: true, previewOnly: false }
  const approval = { approvalId: 'playhead-approval', requestId: 'review-request', toolName: 'set_playhead', arguments: JSON.stringify(args), reviewable: true, state: 'pending' }
  await f.invoke('publish', { scope: FIRST_SCOPE, snapshot: controlSnapshot({ busy: true, phoneRequest: true, awaitingApproval: true, approvals: [approval] }) })
  const state = (await request(status, '/api/state', { token })).body.snapshot
  assert.equal(state.approvals.length, 1)
  assert.equal(state.approvals[0].remoteEligible, true)
  assert.deepEqual(JSON.parse(state.approvals[0].arguments), args)
  const command = { id: 'approve-playhead', kind: 'approval', contextId: state.contextId, approvalId: approval.approvalId, reviewToken: state.approvals[0].reviewToken, approved: true }
  assert.equal((await request(status, '/api/command', { token, value: command })).status, 202)
  assert.equal((await f.invoke('reply', { scope: FIRST_SCOPE, id: command.id, result: { success: true, status: 'accepted' } })).success, true)
  assert.equal((await f.invoke('reply', { scope: FIRST_SCOPE, id: command.id, result: { success: true, status: 'completed' } })).success, true)
  assert.equal((await request(status, '/api/command', { token, value: command })).body.duplicate, true)
  assert.equal(f.events.filter(e => e.type === 'command').length, 1)
})

test('navigation allowance is narrow and does not change desktop auto-approval', () => {
  const { isMobileApprovableAction } = require('../electron/mobileCompanionControl.cjs')
  const { isAutoApprovableEdit } = require('../electron/connectedAgentEditPolicy.cjs')
  const args = { timeSeconds: 77, snapToFrame: true, previewOnly: false }
  assert.equal(isMobileApprovableAction('set_playhead', args), true)
  assert.equal(isAutoApprovableEdit('set_playhead', args), false)
  for (const invalid of [{ ...args, shell: 'arbitrary' }, { ...args, timeSeconds: Infinity }, { ...args, timeSeconds: -1 }, { previewOnly: false }, { ...args, previewOnly: true }, { ...args, snapToFrame: 'yes' }]) {
    assert.equal(isMobileApprovableAction('set_playhead', invalid), false)
  }
  assert.equal(isMobileApprovableAction('run_shell', args), false)
  assert.equal(isMobileApprovableAction('queue_generation', args), false)
})

test('remembered device, scoped commands, remounts and revocation use the real native HTTP boundary', async t => {
  const f = await fixture(t, true)
  let status = await f.enable(FIRST_SCOPE, controlSnapshot())
  const paired = await request(status, '/api/pair', { value: { code: status.pairingCode } })
  const token = paired.body.token
  assert.equal(paired.status, 200)
  assert.equal((await request(status, '/api/message', { token, value: { id: 'legacy', text: 'unscoped' } })).status, 400)
  assert.equal((await request(status, '/api/command', { token, value: { id: 'bad', contextId: 'context-1', kind: 'access', mode: 'full' } })).status, 409)
  const change = { id: 'switch-model', kind: 'model', contextId: 'context-1', model: 'synthetic-model-not-called' }
  assert.equal((await request(status, '/api/command', { token, value: change })).status, 202)
  const event = f.events.find(e => e.type === 'command')
  assert.deepEqual(event.command, change)
  assert.equal((await f.invoke('reply', { scope: FIRST_SCOPE, id: change.id, result: { success: true, status: 'accepted' } })).success, true)
  // A project/model remount changes context, not the remembered connection.
  await f.invoke('detach', { scope: FIRST_SCOPE, contextId: 'context-1' })
  const attached = await f.invoke('attach', { scope: FIRST_SCOPE, snapshot: controlSnapshot({ contextId: 'context-2' }) })
  assert.equal(attached.status.paired, true)
  assert.equal((await f.invoke('reply', { scope: FIRST_SCOPE, id: change.id, result: { success: true, status: 'completed' } })).success, true)
  const duplicate = await request(status, '/api/command', { token, value: change })
  assert.equal(duplicate.body.duplicate, true)
  assert.equal(f.events.filter(e => e.type === 'command').length, 1)
  assert.equal((await request(status, '/api/command', { token, value: { ...change, id: 'stale' } })).body.error, 'STALE_CONTEXT')
  assert.equal((await f.invoke('publish', { scope: FIRST_SCOPE, snapshot: controlSnapshot() })).success, false)
  await f.invoke('disable', { scope: FIRST_SCOPE })
  status = await f.enable(FIRST_SCOPE, controlSnapshot())
  assert.equal(status.paired, true)
  assert.equal(status.pairingCode, null)
  assert.equal((await request(status, '/api/state', { token })).status, 200)
  await f.invoke('forget', { scope: FIRST_SCOPE })
  status = await f.enable(FIRST_SCOPE, controlSnapshot())
  assert.equal(status.paired, false)
  assert.equal((await request(status, '/api/state', { token })).status, 401)
})

test('phone approvals can coexist with a running message but cannot approve spending or stale edits', async t => {
  const f = await fixture(t, true), status = await f.enable(FIRST_SCOPE, controlSnapshot())
  const token = (await request(status, '/api/pair', { value: { code: status.pairingCode } })).body.token
  const message = { id: 'message', kind: 'message', contextId: 'context-1', text: 'Remove markers.' }
  await request(status, '/api/command', { token, value: message })
  await f.invoke('reply', { scope: FIRST_SCOPE, id: 'message', result: { success: true, status: 'accepted' } })
  const approval = { approvalId: 'approval-1', requestId: 'request-1', toolName: 'remove_timeline_markers',
    arguments: JSON.stringify({ all: true, previewOnly: false, expectedContext: { projectKey: '/synthetic/private/project' }, previewToken: 'private-guard' }), reviewable: true, state: 'pending' }
  const publish = approvals => f.invoke('publish', { scope: FIRST_SCOPE, snapshot: controlSnapshot({ busy: true, phoneRequest: true, awaitingApproval: true, approvals }) })
  await publish([approval])
  const snapshot = (await request(status, '/api/state', { token })).body.snapshot
  assert.equal(snapshot.approvals[0].remoteEligible, true)
  assert.equal(snapshot.approvals[0].arguments.includes('/synthetic'), false)
  assert.equal(snapshot.approvals[0].arguments.includes('private-guard'), false)
  const action = { id: 'approve', kind: 'approval', contextId: 'context-1', approvalId: approval.approvalId,
    reviewToken: snapshot.approvals[0].reviewToken, approved: true }
  assert.equal((await request(status, '/api/command', { token, value: action })).status, 202)
  await publish([{ ...approval, arguments: JSON.stringify({ all: false, previewOnly: false }) }])
  assert.equal((await f.invoke('reply', { scope: FIRST_SCOPE, id: action.id, result: { success: true, status: 'accepted' } })).success, false)
  await publish([{ ...approval, toolName: 'queue_generation' }])
  const paid = (await request(status, '/api/state', { token })).body.snapshot.approvals[0]
  assert.equal(paid.remoteEligible, false)
  assert.equal((await request(status, '/api/command', { token, value: { ...action, id: 'paid', reviewToken: paid.reviewToken } })).status, 409)
  assert.equal((await request(status, '/api/command', { token, value: { id: 'stop', kind: 'stop', contextId: 'context-1' } })).status, 202)
  assert.equal((await request(status, '/api/command', { token, value: { ...message, id: 'second' } })).status, 409)
})
