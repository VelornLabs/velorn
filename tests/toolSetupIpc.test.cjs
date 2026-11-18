'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createToolSetupController, CHANNELS, CHANGED } = require('../electron/toolSetupIpc.cjs')

const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const destination = '/fixture-downloads/Velorn setup/fixture-installer.dmg'
const sourceUrl = 'https://official.example.test/download/fixture-installer.dmg'
function fixture(options = {}) {
  const handlers = new Map(), calls = [], approvals = [], opened = [], effects = [], cancelledOwners = [], guards = [], sent = []
  const app = Object.assign(new EventEmitter(), { getPath: name => { assert.equal(name, 'downloads'); return '/fixture-downloads' } })
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: (...values) => sent.push(values) })
  let window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false })
  let exportBusy = false, agentScope = null, approve = true, approvalGate = null, managerGate = null, statusGate = null, statusFailure = null
  let disposed = 0, nextPlan = 0, nextJob = 0, dependencies, backgroundGate = null, backgroundCheck = null
  const plans = new Map(), jobs = new Map()
  const view = job => ({ success: true, jobId: job.jobId, integration: job.integration, state: job.state,
    bytesReceived: job.bytesReceived, totalBytes: 37, canOpen: job.state === 'completed' })
  const controller = createToolSetupController({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    app, getMainWindow: () => window, optionalSetup: { fixture: true },
    isExportBusy: () => exportBusy,
    getAgentScope: () => agentScope,
    assertAgentCurrent: async scope => { guards.push(scope); await options.assertAgentCurrent?.(scope) },
    dialog: { showMessageBox: async (target, config) => {
      approvals.push({ target, config })
      if (approvalGate) await approvalGate.promise
      return { response: approve ? 1 : 0 }
    } },
    shell: { openPath: async value => { opened.push(value); return '' } },
    createManager: deps => {
      dependencies = deps
      return {
        async plan(payload, owner) {
          calls.push(['plan', payload, owner])
          if (managerGate) await managerGate.promise
          const plan = { planId: `plan-${++nextPlan}`, integration: payload.integration, owner }
          plans.set(plan.planId, plan)
          return { success: true, planId: plan.planId }
        },
        async download(payload, owner) {
          calls.push(['download', payload, owner])
          const plan = plans.get(payload.planId)
          if (!plan || plan.owner !== owner) return { success: false, code: 'FOREIGN_PLAN' }
          if (!options.skipDownloadApproval && !await deps.confirm({ owner, action: 'download', plan, destination, sourceUrl, bytes: 37 })) return { success: true, cancelled: true }
          await deps.assertCanStart({ owner, action: 'download' })
          const job = { jobId: `job-${++nextJob}`, owner, integration: plan.integration, state: 'downloading', bytesReceived: 0 }
          jobs.set(job.jobId, job); effects.push(job.jobId)
          if (backgroundGate) backgroundCheck = backgroundGate.promise.then(() => deps.assertCanStart({ owner, action: 'download-background' })).then(() => ({ success: true }), error => ({ success: false, code: error.code }))
          return view(job)
        },
        async status(payload, owner) {
          calls.push(['status', payload, owner])
          await deps.assertCanStart({ owner, action: 'status' })
          if (statusGate) await statusGate.promise
          if (statusFailure) return statusFailure
          const job = jobs.get(payload.jobId)
          return job?.owner === owner ? view(job) : { success: false, code: job ? 'FOREIGN_JOB' : 'UNKNOWN_JOB' }
        },
        async cancel(payload, owner) {
          calls.push(['cancel', payload, owner])
          await deps.assertCanStart({ owner, action: 'cancel' })
          const job = jobs.get(payload.jobId)
          if (!job || job.owner !== owner) return { success: false, code: 'FOREIGN_JOB' }
          job.state = 'cancelled'; return view(job)
        },
        async open(payload, owner) {
          calls.push(['open', payload, owner])
          const job = jobs.get(payload.jobId)
          if (!job || job.owner !== owner) return { success: false, code: 'FOREIGN_JOB' }
          if (!options.skipOpenApproval && !await deps.confirm({ owner, action: 'open', job, destination, sourceUrl, bytes: 37 })) return { success: true, cancelled: true }
          await deps.assertCanStart({ owner, action: 'open-verification' })
          await deps.openPath(options.openDestination || destination, { owner,
            ...(options.skipFinalVerification ? {} : { beforeOpen: async () => { await options.beforeOpen?.() } }) })
          return { ...view(job), opened: true, installed: false }
        },
        cancelOwner(owner) {
          cancelledOwners.push(owner)
          for (const [key, plan] of plans) if (plan.owner === owner) plans.delete(key)
          for (const job of jobs.values()) if (job.owner === owner) job.state = 'cancelled'
        },
        dispose() { disposed++; for (const job of jobs.values()) job.state = 'cancelled' },
      }
    },
  })
  const event = { sender: contents, senderFrame: contents.mainFrame }
  return { app, contents, event, handlers, calls, effects, approvals, opened, cancelledOwners, guards, sent, controller,
    get dependencies() { return dependencies }, get disposed() { return disposed }, get backgroundCheck() { return backgroundCheck },
    call: (method, payload, sourceEvent = event) => handlers.get(CHANNELS[method])(sourceEvent, payload),
    setExport: value => { exportBusy = value }, setAgentScope: value => { agentScope = value },
    setApprove: value => { approve = value }, holdApproval: () => (approvalGate = defer()), holdManager: () => (managerGate = defer()),
    holdStatus: () => (statusGate = defer()),
    updateJob: (jobId, values) => Object.assign(jobs.get(jobId), values),
    forgetJob: jobId => jobs.delete(jobId), setStatusFailure: value => { statusFailure = value },
    holdBackground: () => (backgroundGate = defer()),
    replaceWindow: () => { window = Object.assign(new EventEmitter(), { webContents: Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false }), isDestroyed: () => false }) },
  }
}
const query = { projectPath: '/projects/fixture', chatId: 'chat-1' }
const origin = { chatId: query.chatId, turnId: 'turn-1' }
const envelope = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
function associate(f, job, nextOrigin = origin, projectPath = query.projectPath) {
  return f.controller.associateAgentResult('download_tool_installer', envelope(job), nextOrigin, projectPath)
}
async function readyJob(f, api = f.call) {
  const plan = await api('plan', { integration: 'comfyui' })
  assert.equal(plan.success, true)
  const job = await api('download', { planId: plan.planId })
  assert.equal(job.success, true)
  return job
}
async function flushUntil(predicate) {
  for (let count = 0; count < 20 && !predicate(); count++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(Boolean(predicate()), true, 'fixture operation reached the expected boundary')
}

test('controller registers only bounded installer methods and construction performs no action', t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  assert.deepEqual([...f.handlers.keys()], Object.values(CHANNELS))
  assert.deepEqual(Object.keys(f.controller.api), ['plan', 'download', 'status', 'cancel', 'open'])
  assert.deepEqual(f.calls, []); assert.deepEqual(f.approvals, []); assert.deepEqual(f.opened, [])
  assert.equal(f.dependencies.getDownloadsPath(), '/fixture-downloads')
  assert.equal(f.dependencies.optionalSetup.fixture, true)
})

test('main-frame authority and exact payload schemas reject foreign frames, paths, URLs and forged owners', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  for (const event of [{}, { sender: f.contents, senderFrame: {} }, { sender: { isDestroyed: () => false }, senderFrame: f.contents.mainFrame }]) {
    assert.equal((await f.call('plan', { integration: 'comfyui' }, event)).code, 'TOOL_SETUP_UNAUTHORIZED')
  }
  for (const payload of [null, [], {}, { integration: 'anything' }, { integration: 'comfyui', owner: 'spoof' }, { integration: 'lmstudio', sourceUrl: 'https://example.test' }]) {
    assert.equal((await f.call('plan', payload)).code, 'TOOL_SETUP_INVALID_REQUEST')
  }
  for (const method of ['download', 'status', 'cancel', 'open']) {
    for (const payload of [{}, { planId: '/tmp/injected' }, { jobId: 'https://example.test' }, { jobId: 'job-1', destination: '/tmp/injected' }]) {
      assert.equal((await f.call(method, payload)).code, 'TOOL_SETUP_INVALID_REQUEST')
    }
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(f.approvals, [])
})

test('download and every installer open require separate Cancel-default native exact-source/path/bytes approval', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const job = await readyJob(f)
  assert.equal(f.approvals.length, 1); assert.deepEqual(f.opened, [])
  const first = f.approvals[0].config
  assert.equal(first.defaultId, 0); assert.equal(first.cancelId, 0)
  assert.deepEqual(first.buttons, ['Cancel', 'Download installer'])
  assert.ok(first.detail.includes(destination)); assert.ok(first.detail.includes(sourceUrl)); assert.ok(first.detail.includes('37 bytes'))
  assert.match(first.detail, /dependencies, accounts and model downloads are separate/)
  assert.equal((await f.call('open', { jobId: job.jobId })).success, true)
  assert.equal((await f.call('open', { jobId: job.jobId })).success, true)
  assert.equal(f.approvals.length, 3); assert.deepEqual(f.opened, [destination, destination])
  assert.deepEqual(f.approvals[1].config.buttons, ['Cancel', 'Open installer'])
})

test('declined native download and open cause no respective side effect', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const plan = await f.call('plan', { integration: 'lmstudio' })
  f.setApprove(false)
  assert.equal((await f.call('download', { planId: plan.planId })).cancelled, true)
  assert.deepEqual(f.effects, [])
  f.setApprove(true)
  const job = await f.call('download', { planId: plan.planId })
  f.setApprove(false)
  assert.equal((await f.call('open', { jobId: job.jobId })).cancelled, true)
  assert.deepEqual(f.opened, [])
})

test('MCP ownership survives new tool scopes but cannot borrow desktop plans or jobs; Full access never bypasses native approval', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const desktop = await readyJob(f)
  const desktopPlan = f.calls.find(call => call[0] === 'plan')[1]
  assert.equal(desktopPlan.integration, 'comfyui')
  assert.equal((await f.controller.api.download({ planId: 'plan-1' })).code, 'FOREIGN_PLAN')
  assert.equal((await f.controller.api.status({ jobId: desktop.jobId })).code, 'FOREIGN_JOB')
  const firstScope = { signal: new AbortController().signal, trustedFullAccess: true }
  f.setAgentScope(firstScope)
  const plan = await f.controller.api.plan({ integration: 'lmstudio' })
  const secondScope = { signal: new AbortController().signal, trustedFullAccess: true }
  f.setAgentScope(secondScope)
  const job = await f.controller.api.download({ planId: plan.planId })
  assert.equal(job.success, true)
  assert.equal((await f.controller.api.open({ jobId: job.jobId })).success, true)
  assert.equal(f.approvals.length, 3, 'desktop download, MCP download and MCP open each confirm')
  const mcpCalls = f.calls.filter(call => ['plan', 'download', 'open'].includes(call[0])
    && (call[1].integration === 'lmstudio' || call[1].planId === plan.planId || call[1].jobId === job.jobId))
  assert.equal(new Set(mcpCalls.map(call => call[2])).size, 1)
  assert.notEqual(mcpCalls[0][2], f.calls[0][2])
  assert.ok(f.guards.includes(firstScope)); assert.ok(f.guards.includes(secondScope))
})

test('no-project external MCP can use setup without an agent context or guard', async t => {
  const f = fixture({ assertAgentCurrent: async () => assert.fail('External setup must not require project context') }); t.after(() => f.controller.dispose())
  const job = await readyJob(f, (method, payload) => f.controller.api[method](payload))
  assert.equal(job.success, true); assert.equal(f.guards.length, 0); assert.equal(f.approvals.length, 1)
})

test('export blocks new plan/download/open but cached status and cancel remain usable', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const job = await readyJob(f)
  f.setExport(true)
  for (const [method, payload] of [['plan', { integration: 'comfyui' }], ['download', { planId: 'plan-1' }], ['open', { jobId: job.jobId }]]) {
    assert.equal((await f.call(method, payload)).code, 'TOOL_SETUP_EXPORT_BUSY')
  }
  assert.equal((await f.call('status', { jobId: job.jobId })).success, true)
  assert.equal((await f.call('cancel', { jobId: job.jobId })).success, true)
  assert.equal(f.approvals.length, 1); assert.deepEqual(f.opened, [])
})

for (const boundary of ['export', 'navigation', 'replacement', 'agent-cancel']) {
  test(`${boundary} during native approval prevents the download side effect`, async t => {
    const f = fixture(); t.after(() => f.controller.dispose())
    const abort = new AbortController()
    f.setAgentScope({ signal: abort.signal })
    const plan = await f.controller.api.plan({ integration: 'comfyui' })
    const gate = f.holdApproval()
    const waiting = f.controller.api.download({ planId: plan.planId })
    await flushUntil(() => f.approvals.length === 1)
    if (boundary === 'export') f.setExport(true)
    if (boundary === 'navigation') f.contents.emit('did-start-navigation', {}, 'file:///different.html', false, true)
    if (boundary === 'replacement') f.replaceWindow()
    if (boundary === 'agent-cancel') abort.abort()
    gate.resolve()
    const result = await waiting
    assert.equal(result.success, false)
    assert.deepEqual(f.effects, []); assert.deepEqual(f.opened, [])
    assert.equal(f.approvals.length, 1)
  })
}

for (const boundary of ['export', 'navigation', 'replacement', 'agent-cancel']) {
  test(`${boundary} during separate opening approval prevents the OS open`, async t => {
    const f = fixture(); t.after(() => f.controller.dispose())
    const abort = new AbortController(); f.setAgentScope({ signal: abort.signal })
    const job = await readyJob(f, (method, payload) => f.controller.api[method](payload))
    const gate = f.holdApproval(), waiting = f.controller.api.open({ jobId: job.jobId })
    await flushUntil(() => f.approvals.length === 2)
    if (boundary === 'export') f.setExport(true)
    if (boundary === 'navigation') f.contents.emit('did-start-navigation', {}, 'file:///different.html', false, true)
    if (boundary === 'replacement') f.replaceWindow()
    if (boundary === 'agent-cancel') abort.abort()
    gate.resolve()
    assert.equal((await waiting).success, false)
    assert.deepEqual(f.opened, []); assert.equal(f.effects.length, 1)
  })
}

test('agent context is rechecked after approval and stale guard failures are sanitized', async t => {
  let current = true
  const f = fixture({ assertAgentCurrent: async () => { if (!current) throw Error('PRIVATE_SECRET_PATH /Users/private') } }); t.after(() => f.controller.dispose())
  f.setAgentScope({ signal: new AbortController().signal })
  const plan = await f.controller.api.plan({ integration: 'comfyui' })
  const gate = f.holdApproval(), waiting = f.controller.api.download({ planId: plan.planId })
  await flushUntil(() => f.approvals.length === 1)
  current = false; gate.resolve()
  const result = await waiting
  assert.equal(result.success, false); assert.doesNotMatch(JSON.stringify(result), /SECRET|private/)
  assert.deepEqual(f.effects, [])
})

test('approved background download ignores completed turn signal but navigation cancels document jobs and plans', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const abort = new AbortController(); f.setAgentScope({ signal: abort.signal })
  const background = f.holdBackground()
  const job = await readyJob(f, (method, payload) => f.controller.api[method](payload))
  abort.abort(); background.resolve()
  assert.deepEqual(await f.backgroundCheck, { success: true })
  f.contents.emit('did-start-navigation', {}, 'file:///new.html', false, true)
  assert.equal(f.cancelledOwners.length, 2)
  f.setAgentScope(null)
  assert.equal((await f.controller.api.status({ jobId: job.jobId })).code, 'FOREIGN_JOB')
  assert.equal((await f.controller.api.download({ planId: 'plan-1' })).code, 'FOREIGN_PLAN')
})

test('in-place/subframe navigation does not discard jobs, but renderer loss and disposal cancel and remove all handlers/listeners', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const job = await readyJob(f)
  f.contents.emit('did-start-navigation', {}, 'file:///same#tab', true, true)
  f.contents.emit('did-start-navigation', {}, 'https://embedded.invalid', false, false)
  assert.equal((await f.call('status', { jobId: job.jobId })).success, true)
  assert.equal(f.cancelledOwners.length, 0)
  f.contents.emit('render-process-gone', {}, {})
  assert.equal(f.cancelledOwners.length, 2)
  assert.equal((await f.call('status', { jobId: job.jobId })).code, 'FOREIGN_JOB')
  f.app.emit('will-quit')
  assert.equal(f.disposed, 1); assert.equal(f.handlers.size, 0)
  assert.equal(f.contents.listenerCount('did-start-navigation'), 0)
  assert.equal(f.contents.listenerCount('destroyed'), 0)
  assert.equal(f.app.listenerCount('will-quit'), 0)
  assert.equal((await f.controller.api.plan({ integration: 'comfyui' })).code, 'TOOL_SETUP_UNAUTHORIZED')
  f.controller.dispose(); assert.equal(f.disposed, 1)
})

test('pending manager metadata result is not returned after replacement main window', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const gate = f.holdManager(), waiting = f.call('plan', { integration: 'comfyui' })
  await flushUntil(() => f.calls.length === 1)
  f.replaceWindow(); gate.resolve()
  assert.equal((await waiting).code, 'TOOL_SETUP_CONTEXT_CHANGED')
})

test('native open helper refuses use outside a current manager call', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  await assert.rejects(f.dependencies.openPath(destination, { owner: 'made-up' }), { code: 'TOOL_SETUP_CONTEXT_CHANGED' })
  assert.deepEqual(f.opened, [])
})

for (const options of [{ skipOpenApproval: true }, { openDestination: '/different/installer.dmg' }]) {
  test(`native open helper refuses ${options.skipOpenApproval ? 'unapproved' : 'mismatched'} paths from a manager callback`, async t => {
    const f = fixture(options); t.after(() => f.controller.dispose())
    const job = await readyJob(f)
    assert.equal((await f.call('open', { jobId: job.jobId })).code, 'TOOL_SETUP_UNAUTHORIZED')
    assert.deepEqual(f.opened, [])
  })
}

test('native opener requires the manager final file verification callback', async t => {
  const f = fixture({ skipFinalVerification: true }); t.after(() => f.controller.dispose())
  const job = await readyJob(f)
  assert.equal((await f.call('open', { jobId: job.jobId })).code, 'TOOL_SETUP_UNAVAILABLE')
  assert.deepEqual(f.opened, [])
})

test('approved native agent downloads attach once to their originating chat and report advancing cached progress', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const job = await readyJob(f, (method, payload) => f.controller.api[method](payload))
  assert.equal(job.downloadApproved, true); assert.equal(job.background, true)
  assert.equal(job.bytesReceived, 0); assert.match(job.message, /initial byte count may be zero/)
  assert.deepEqual(await f.call('agentDownloads', query), { success: true, jobs: [] })
  assert.equal((await f.call('status', { jobId: job.jobId })).code, 'FOREIGN_JOB', 'Unassociated MCP jobs are not delegated')
  assert.equal(associate(f, job), true)
  assert.deepEqual(f.sent, [[CHANGED]], 'Change event carries no identity, path or job data')
  assert.equal(associate(f, job, { ...origin, turnId: 'another-turn' }), false, 'Native origin cannot be rebound')
  const first = await f.call('agentDownloads', query)
  assert.equal(first.jobs[0].turnId, origin.turnId); assert.equal(first.jobs[0].opened, false)
  assert.equal(first.jobs[0].bytesReceived, 0)
  f.updateJob(job.jobId, { bytesReceived: 23 })
  const second = await f.call('agentDownloads', query)
  assert.equal(second.jobs[0].bytesReceived, 23)
  assert.equal((await f.call('status', { jobId: job.jobId })).bytesReceived, 23)
  assert.doesNotMatch(JSON.stringify(second), /projects|owner|sourceUrl|destination|planId/)
  assert.equal(f.approvals.length, 1, 'Progress checks never request another download')
  assert.equal(f.sent.length, 1, 'Cached progress reads do not cause an event/poll loop')
})

test('desktop progress, cancellation and separately confirmed opening survive ended agent scope and panel remount', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const abort = new AbortController(); f.setAgentScope({ signal: abort.signal })
  const job = await readyJob(f, (method, payload) => f.controller.api[method](payload))
  assert.equal(associate(f, job), true)
  const guardCount = f.guards.length
  abort.abort()
  assert.equal((await f.call('agentDownloads', query)).jobs[0].jobId, job.jobId)
  f.setExport(true)
  assert.equal((await f.call('status', { jobId: job.jobId })).success, true)
  assert.equal((await f.call('cancel', { jobId: job.jobId })).state, 'cancelled')
  f.setExport(false)
  f.updateJob(job.jobId, { state: 'completed', bytesReceived: 37 })
  const reattached = await f.call('agentDownloads', { ...query })
  assert.equal(reattached.jobs[0].canOpen, true)
  assert.equal((await f.call('open', { jobId: job.jobId })).opened, true)
  assert.equal(f.guards.length, guardCount, 'User actions do not inherit an ended agent turn')
  assert.equal(f.approvals.length, 2, 'Download approval does not authorize OS opening')
  assert.equal((await f.call('agentDownloads', { ...query })).jobs[0].opened, true, 'Opened state survives remount/requery')
  assert.deepEqual(f.sent, [[CHANGED], [CHANGED], [CHANGED]])
})

test('agent download listing isolates exact project/chat and rejects arbitrary or embedded-frame payloads', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const job = await readyJob(f, (method, payload) => f.controller.api[method](payload)); associate(f, job)
  for (const other of [{ ...query, chatId: 'different-chat' }, { ...query, projectPath: '/other/project' }]) {
    assert.deepEqual(await f.call('agentDownloads', other), { success: true, jobs: [] })
  }
  for (const invalid of [null, {}, { ...query, owner: 'mcp' }, { ...query, source: 'mcp' },
    { ...query, projectPath: 'relative/project' }, { ...query, projectPath: '/secret\npath' }, { ...query, chatId: '../chat' }]) {
    assert.equal((await f.call('agentDownloads', invalid)).code, 'TOOL_SETUP_INVALID_REQUEST')
  }
  for (const event of [{}, { sender: f.contents, senderFrame: {} }]) {
    assert.equal((await f.call('agentDownloads', query, event)).code, 'TOOL_SETUP_UNAUTHORIZED')
    assert.equal((await f.call('open', { jobId: job.jobId }, event)).code, 'TOOL_SETUP_UNAUTHORIZED')
  }
  assert.equal(f.approvals.length, 1); assert.deepEqual(f.opened, [])
})

test('model-like results cannot manufacture agent download receipts or claim desktop downloads', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const desktop = await readyJob(f)
  assert.equal(associate(f, desktop), false)
  const job = await readyJob(f, (method, payload) => f.controller.api[method](payload))
  for (const forged of [{ ...job, jobId: 'unknown' }, { ...job, success: false }, { ...job, previewOnly: true },
    { ...job, downloadApproved: false }, { ...job, background: false }, { ...job, totalBytes: 99 },
    { ...job, integration: 'lmstudio' }, { ...job, state: 'installed' }]) assert.equal(associate(f, forged), false)
  assert.equal(f.controller.associateAgentResult('get_tool_setup_download', envelope(job), origin, query.projectPath), false)
  assert.equal(f.controller.associateAgentResult('download_tool_installer', { ...envelope(job), isError: true }, origin, query.projectPath), false)
  assert.equal(f.controller.associateAgentResult('download_tool_installer', { content: [{ type: 'text', text: '{not json' }] }, origin, query.projectPath), false)
  assert.equal(f.controller.associateAgentResult('download_tool_installer', { content: [...envelope(job).content, ...envelope(job).content] }, origin, query.projectPath), false)
  assert.equal(associate(f, job, { chatId: '../invalid', turnId: 'turn' }), false)
  assert.deepEqual(f.sent, []); assert.deepEqual((await f.call('agentDownloads', query)).jobs, [])
  assert.equal(associate(f, job), true)
})

test('a manager result without actual native download approval cannot gain a live receipt', async t => {
  const f = fixture({ skipDownloadApproval: true }); t.after(() => f.controller.dispose())
  const job = await readyJob(f, (method, payload) => f.controller.api[method](payload))
  assert.equal(job.downloadApproved, undefined)
  assert.equal(associate(f, { ...job, downloadApproved: true, background: true }), false)
  assert.deepEqual(f.approvals, []); assert.deepEqual(f.sent, [])
})

test('download association may follow turn cancellation but cannot follow document replacement', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const abort = new AbortController(); f.setAgentScope({ signal: abort.signal })
  const job = await readyJob(f, (method, payload) => f.controller.api[method](payload))
  abort.abort()
  assert.equal(associate(f, job), true)
  f.contents.emit('did-start-navigation', {}, 'file:///another-document', false, true)
  assert.equal(associate(f, job), false)
  assert.deepEqual(await f.call('agentDownloads', query), { success: true, jobs: [] })
  assert.equal((await f.call('status', { jobId: job.jobId })).success, false)
  assert.equal(f.cancelledOwners.length, 2)
})

test('pending progress does not leak after navigation and registered metadata stays bounded', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  let first, last
  for (let count = 0; count < 35; count++) {
    const job = await readyJob(f, (method, payload) => f.controller.api[method](payload))
    associate(f, job, { ...origin, turnId: `turn-${count}` })
    if (!first) first = job
    last = job
  }
  const list = await f.call('agentDownloads', query)
  assert.equal(list.jobs.length, 32); assert.equal(list.jobs.some(job => job.jobId === first.jobId), false)
  assert.equal(list.jobs.at(-1).jobId, last.jobId)
  const gate = f.holdStatus(), waiting = f.call('agentDownloads', query)
  await flushUntil(() => f.calls.at(-1)?.[0] === 'status')
  f.contents.emit('did-start-navigation', {}, 'file:///another', false, true); gate.resolve()
  assert.equal((await waiting).code, 'TOOL_SETUP_CONTEXT_CHANGED')
  assert.deepEqual((await f.call('agentDownloads', query)).jobs, [])
})

test('expired native jobs are pruned while transient progress failure does not discard a real receipt', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const job = await readyJob(f, (method, payload) => f.controller.api[method](payload)); associate(f, job)
  f.setStatusFailure({ success: false, code: 'UNAVAILABLE', error: '/PRIVATE/native/diagnostic' })
  const failure = await f.call('agentDownloads', query)
  assert.equal(failure.code, 'TOOL_SETUP_PROGRESS_UNAVAILABLE')
  assert.doesNotMatch(JSON.stringify(failure), /PRIVATE/)
  f.setStatusFailure(null)
  assert.equal((await f.call('agentDownloads', query)).jobs.length, 1)
  f.forgetJob(job.jobId)
  assert.deepEqual((await f.call('agentDownloads', query)).jobs, [])
  const calls = f.calls.length
  assert.deepEqual((await f.call('agentDownloads', query)).jobs, [])
  assert.equal(f.calls.length, calls, 'Pruned IDs are not polled forever')
  assert.equal(associate(f, job), false, 'Evicted receipts cannot be recreated from old result text')
})

test('delegated desktop opening still declines, blocks export and cancels at a changed document', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const job = await readyJob(f, (method, payload) => f.controller.api[method](payload)); associate(f, job)
  f.updateJob(job.jobId, { state: 'completed', bytesReceived: 37 })
  f.setApprove(false)
  assert.equal((await f.call('open', { jobId: job.jobId })).cancelled, true)
  assert.equal((await f.call('agentDownloads', query)).jobs[0].opened, false)
  f.setApprove(true); f.setExport(true)
  assert.equal((await f.call('open', { jobId: job.jobId })).code, 'TOOL_SETUP_EXPORT_BUSY')
  f.setExport(false)
  const gate = f.holdApproval(), waiting = f.call('open', { jobId: job.jobId })
  await flushUntil(() => f.approvals.length === 3)
  f.contents.emit('did-start-navigation', {}, 'file:///changed', false, true); gate.resolve()
  assert.equal((await waiting).success, false)
  assert.deepEqual(f.opened, [])
})

for (const boundary of ['export', 'navigation', 'agent-cancel']) {
  test(`${boundary} during final file verification is caught synchronously before OS handoff`, async t => {
    const abort = new AbortController()
    let f
    f = fixture({ beforeOpen: async () => {
      if (boundary === 'export') f.setExport(true)
      if (boundary === 'navigation') f.contents.emit('did-start-navigation', {}, 'file:///different.html', false, true)
      if (boundary === 'agent-cancel') abort.abort()
    } }); t.after(() => f.controller.dispose())
    f.setAgentScope({ signal: abort.signal })
    const job = await readyJob(f, (method, payload) => f.controller.api[method](payload))
    assert.equal((await f.controller.api.open({ jobId: job.jobId })).success, false)
    assert.deepEqual(f.opened, [])
  })
}
