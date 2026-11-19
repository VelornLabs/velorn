'use strict'

const test = require('node:test'), assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createLmStudioSetupController, CHANNELS, CHANGED, CONFIRMATION_MS } = require('../electron/lmStudioSetupIpc.cjs')
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate()) { assert.ok(Date.now() < deadline, 'Fixture did not reach its expected boundary'); await tick() }
}
const model = { repository: 'publisher/fixture-GGUF', filename: 'fixture-Q4_K_M.gguf' }
const review = { ...model, modelName: 'Fixture Q4_K_M', revision: 'a'.repeat(40), bytes: 100,
  contextTargetTokens: 32768, contextPolicy: 'model-capped',
  sourceUrl: `https://huggingface.co/${model.repository}/resolve/${'a'.repeat(40)}/${model.filename}`,
  destination: `/synthetic/models/${model.repository}/${model.filename}`, license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' } }
const query = { projectPath: '/projects/fixture', chatId: 'chat-1' }, origin = { chatId: query.chatId, turnId: 'turn-1' }
const envelope = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
function fixture(options = {}) {
  const handlers = new Map(), calls = [], approvals = [], effects = [], loads = [], cancelledOwners = [], sent = [], waiting = []
  const app = new EventEmitter(), runtime = { fixture: true }, plans = new Map(), jobs = new Map()
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: (...args) => sent.push(args) })
  let window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false })
  let exportBusy = false, scope = null, approve = true, approvalGate, managerGate, statusGate, statusOverride, nextPlan = 0, nextJob = 0, dependencies, disposed = 0, backgroundGate, backgroundCheck, commitGate
  const view = job => ({ success: true, jobId: job.jobId, integration: 'lmstudio', modelName: review.modelName,
    bytesReceived: job.bytesReceived, totalBytes: 100, state: job.state, canLoad: job.state === 'completed', connectionVerified: job.state === 'ready', ...job.overrides })
  const controller = createLmStudioSetupController({ ipcMain: { handle: (name, callback) => handlers.set(name, callback), removeHandler: name => handlers.delete(name) },
    app, getMainWindow: () => window, runtime, confirmationMs: options.confirmationMs,
    isExportBusy: () => exportBusy, getAgentScope: () => scope,
    assertAgentCurrent: async value => { await options.assertAgentCurrent?.(value) },
    dialog: options.noDialog ? undefined : { showMessageBox: async (target, config) => { approvals.push({ target, config }); if (approvalGate) await approvalGate.promise; return { response: approve ? 1 : 0 } } },
    createManager: hooks => {
      dependencies = hooks
      return {
        async plan(payload, owner) {
          calls.push(['plan', payload, owner]); if (managerGate) await managerGate.promise
          if (options.planError) throw Error('PRIVATE raw settings and token')
          const plan = { ...review, planId: `plan-${++nextPlan}`, owner }; plans.set(plan.planId, plan)
          return { success: true, planId: plan.planId, destination: 'LM Studio models/publisher/fixture-GGUF/fixture-Q4_K_M.gguf' }
        },
        async download(payload, owner) {
          calls.push(['download', payload, owner])
          const plan = plans.get(payload.planId)
          if (!plan || plan.owner !== owner) return { success: false, code: 'FOREIGN_PLAN' }
          if (!options.skipApproval && !await hooks.confirm({ owner, action: 'download', plan, ...review, ...options.review })) return { success: true, cancelled: true }
          await hooks.assertCanStart({ owner, action: 'download' })
          if (commitGate) await commitGate.promise
          hooks.assertCanCommit({ owner, action: 'download-commit' })
          const job = { jobId: `job-${++nextJob}`, owner, state: 'downloading', bytesReceived: 0 }; jobs.set(job.jobId, job); effects.push(job.jobId)
          if (backgroundGate) backgroundCheck = backgroundGate.promise.then(() => hooks.assertCanStart({ owner, action: options.backgroundAction || 'download-background' })).then(() => ({ success: true }), error => ({ success: false, code: error.code }))
          return view(job)
        },
        async status(payload, owner) {
          calls.push(['status', payload, owner]); await hooks.assertCanStart({ owner, action: 'status' })
          if (statusGate) await statusGate.promise
          if (statusOverride) return statusOverride
          const job = jobs.get(payload.jobId)
          return job?.owner === owner ? view(job) : { success: false, code: job ? 'FOREIGN_JOB' : 'UNKNOWN_JOB' }
        },
        async cancel(payload, owner) {
          calls.push(['cancel', payload, owner]); await hooks.assertCanStart({ owner, action: 'cancel' })
          const job = jobs.get(payload.jobId)
          if (!job || job.owner !== owner) return { success: false, code: 'FOREIGN_JOB' }
          job.state = 'cancelled'; return view(job)
        },
        async load(payload, owner) {
          calls.push(['load', payload, owner]); const job = jobs.get(payload.jobId)
          if (!job || job.owner !== owner) return { success: false, code: 'FOREIGN_JOB' }
          if (!await hooks.confirm({ owner, action: 'load', job: view(job), ...review, ...options.review })) return { success: true, cancelled: true }
          await hooks.assertCanStart({ owner, action: 'load-verification' })
          if (commitGate) await commitGate.promise
          hooks.assertCanCommit({ owner, action: 'load-commit' })
          loads.push(job.jobId); job.state = 'ready'; return view(job)
        },
        cancelOwner(owner) { cancelledOwners.push(owner); for (const job of jobs.values()) if (job.owner === owner) job.state = 'cancelled'; for (const [id, plan] of plans) if (plan.owner === owner) plans.delete(id) },
        dispose() { disposed++ },
      }
    },
  })
  const event = { sender: contents, senderFrame: contents.mainFrame }
  return { controller, app, contents, event, calls, approvals, effects, loads, cancelledOwners, sent, waiting, runtime, handlers,
    get dependencies() { return dependencies }, get disposed() { return disposed }, get backgroundCheck() { return backgroundCheck },
    call: (method, payload, from = event) => handlers.get(CHANNELS[method])(from, payload),
    setScope: value => { scope = value }, setExport: value => { exportBusy = value }, setApprove: value => { approve = value },
    holdApproval: () => (approvalGate = defer()), holdManager: () => (managerGate = defer()), holdStatus: () => (statusGate = defer()), holdBackground: () => (backgroundGate = defer()),
    holdCommit: () => (commitGate = defer()),
    update: (jobId, value) => Object.assign(jobs.get(jobId), value), forget: jobId => jobs.delete(jobId), statusOverride: value => { statusOverride = value },
    replace: () => { window = Object.assign(new EventEmitter(), { webContents: Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send() {} }), isDestroyed: () => false }) },
  }
}
async function readyJob(f, native = false) {
  const call = (method, payload) => native ? f.controller.api[method](payload) : f.call(method, payload)
  const plan = await call('plan', model); assert.equal(plan.success, true)
  const job = await call('download', { planId: plan.planId }); assert.equal(job.success, true)
  return job
}
const associate = (f, job, nextOrigin = origin, projectPath = query.projectPath) => f.controller.associateAgentResult('download_lmstudio_model', envelope(job), nextOrigin, projectPath)

test('construction is passive and bridge exposes only bounded methods', t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  assert.deepEqual([...f.handlers.keys()], Object.values(CHANNELS)); assert.deepEqual(Object.keys(f.controller.api), ['plan', 'download', 'status', 'cancel', 'load'])
  assert.equal(f.dependencies.runtime, f.runtime); assert.deepEqual(f.calls, []); assert.deepEqual(f.approvals, [])
  assert.equal(CONFIRMATION_MS, 300000)
  assert.throws(() => fixture({ confirmationMs: 300001 }), /deadline/)
})
test('foreign frames and caller URLs, paths, owners, tokens or extra plan fields never dispatch', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  for (const from of [{}, { sender: f.contents, senderFrame: {} }, { sender: {}, senderFrame: f.contents.mainFrame }]) assert.equal((await f.call('plan', model, from)).code, 'LM_STUDIO_SETUP_UNAUTHORIZED')
  for (const payload of [null, [], {}, { ...model, approved: true }, { ...model, url: review.sourceUrl }, { ...model, owner: 'spoof' }, { ...model, filename: '../fixture.gguf' }, { ...model, filename: 'weights.safetensors' }, { ...model, repository: 'https://huggingface.co/repo' }]) assert.equal((await f.call('plan', payload)).code, 'LM_STUDIO_SETUP_INVALID_REQUEST')
  for (const method of ['download', 'status', 'cancel', 'load']) for (const payload of [{}, { jobId: '/local/path' }, { jobId: 'job-1', approved: true }, { planId: 'plan-1', token: 'secret' }]) assert.equal((await f.call(method, payload)).code, 'LM_STUDIO_SETUP_INVALID_REQUEST')
  assert.deepEqual(f.calls, []); assert.deepEqual(f.approvals, [])
})
test('download and load always require separate exact-model Cancel-default desktop confirmation', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const job = await readyJob(f); assert.equal(job.downloadApproved, true); assert.equal(job.background, true)
  assert.equal(f.approvals.length, 1); assert.deepEqual(f.loads, [])
  const first = f.approvals[0].config
  assert.equal(first.defaultId, 0); assert.equal(first.cancelId, 0); assert.deepEqual(first.buttons, ['Cancel', 'Download model'])
  for (const field of ['repository', 'filename', 'revision', 'sourceUrl', 'destination']) assert.ok(first.detail.includes(review[field]))
  assert.match(first.detail, /100 bytes/); assert.ok(first.detail.includes(review.license.name)); assert.ok(first.detail.includes(review.license.url))
  f.update(job.jobId, { state: 'completed', bytesReceived: 100 })
  assert.equal((await f.call('load', { jobId: job.jobId })).state, 'ready')
  assert.deepEqual(f.approvals[1].config.buttons, ['Cancel', 'Load model'])
  assert.match(f.approvals[1].config.detail, /RAM\/GPU/); assert.match(f.approvals[1].config.detail, /loopback only/); assert.match(f.approvals[1].config.detail, /authentication stays enabled/)
  assert.match(f.approvals[1].config.detail, /Context Length: up to 32,768 tokens/)
  assert.match(f.approvals[1].config.detail, /capped by the model's reported maximum/)
  assert.match(f.approvals[1].config.detail, /fitting in memory is not guaranteed/)
  assert.match(f.approvals[1].config.detail, /unload\/reload an already loaded model/)
})
test('load review requires the exact native context policy before showing approval', async t => {
  for (const patch of [{ contextTargetTokens: undefined }, { contextTargetTokens: 4096 }, { contextTargetTokens: '32768' },
    { contextTargetTokens: 1048577 }, { contextPolicy: 'arbitrary' }]) {
    const f = fixture({ review: patch }); t.after(() => f.controller.dispose())
    const job = await readyJob(f); f.update(job.jobId, { state: 'completed', bytesReceived: 100 })
    assert.equal((await f.call('load', { jobId: job.jobId })).code, 'LM_STUDIO_SETUP_INVALID_REVIEW')
    assert.equal(f.approvals.length, 1); assert.deepEqual(f.loads, [])
  }
})
test('progress exposes bounded effective context only with coherent native verification', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const job = await readyJob(f, true); associate(f, job)
  const context = { contextTargetTokens: 32768, requestedContextTokens: 32768, modelMaxContextTokens: 131072,
    effectiveContextTokens: 32768, contextVerified: true }
  f.update(job.jobId, { state: 'ready', bytesReceived: 100, overrides: context })
  const verified = (await f.call('agentDownloads', query)).jobs[0]
  assert.equal(verified.contextVerified, true); assert.equal(verified.effectiveContextTokens, 32768)
  for (const patch of [{ effectiveContextTokens: 4096 }, { effectiveContextTokens: 1048577 }, { effectiveContextTokens: 'PRIVATE' },
    { requestedContextTokens: 16384 }, { modelMaxContextTokens: 1024 }, { contextVerified: 'true' }, { contextTargetTokens: null }]) {
    f.update(job.jobId, { overrides: { ...context, ...patch } })
    const result = (await f.call('agentDownloads', query)).jobs[0]
    assert.equal(result.contextVerified, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/)
  }
  f.update(job.jobId, { overrides: {} })
  const legacy = (await f.call('agentDownloads', query)).jobs[0]
  assert.equal(legacy.contextVerified, false); assert.equal(legacy.effectiveContextTokens, undefined)
})
test('controller model field limits match the tool catalog and native manager', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const largest = { repository: `${'p'.repeat(96)}/${'r'.repeat(63)}`, filename: `${'f'.repeat(175)}.gguf` }
  assert.equal((await f.call('plan', largest)).success, true)
  for (const payload of [{ ...largest, repository: `${largest.repository}r` }, { ...largest, filename: `f${largest.filename}` },
    { ...model, filename: 'model name.gguf' }, { ...model, filename: 'mödél.gguf' }]) {
    assert.equal((await f.call('plan', payload)).code, 'LM_STUDIO_SETUP_INVALID_REQUEST')
  }
  assert.equal(f.calls.length, 1, 'Rejected fields never reached the manager')
})
test('declined reviews and unavailable native dialog perform no respective effect', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const plan = await f.call('plan', model); f.setApprove(false)
  assert.equal((await f.call('download', { planId: plan.planId })).cancelled, true); assert.deepEqual(f.effects, [])
  f.setApprove(true); const job = await f.call('download', { planId: plan.planId }); f.setApprove(false)
  assert.equal((await f.call('load', { jobId: job.jobId })).cancelled, true); assert.deepEqual(f.loads, [])
  const missing = fixture({ noDialog: true }); t.after(() => missing.controller.dispose())
  const p = await missing.call('plan', model)
  assert.equal((await missing.call('download', { planId: p.planId })).code, 'LM_STUDIO_SETUP_UNAVAILABLE'); assert.deepEqual(missing.effects, [])
})
test('incomplete native metadata cannot authorize a model transfer', async t => {
  for (const patch of [{ license: 'unknown' }, { bytes: null }, { destination: 'relative' }, { revision: '' }, { sourceUrl: 'https://huggingface.co/private?token=secret' }, { sourceUrl: 'https://elsewhere.test/model.gguf' }]) {
    const f = fixture({ review: patch }); t.after(() => f.controller.dispose())
    const plan = await f.call('plan', model)
    assert.equal((await f.call('download', { planId: plan.planId })).code, 'LM_STUDIO_SETUP_INVALID_REVIEW')
    assert.deepEqual(f.approvals, []); assert.deepEqual(f.effects, [])
  }
})
test('source ownership is native; Full access cannot borrow desktop plans or skip review', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const desktop = await readyJob(f)
  assert.equal((await f.controller.api.download({ planId: 'plan-1' })).code, 'FOREIGN_PLAN')
  assert.equal((await f.controller.api.status({ jobId: desktop.jobId })).code, 'FOREIGN_JOB')
  f.setScope({ trustedFullAccess: true, signal: new AbortController().signal, onWaiting: value => f.waiting.push(value) })
  const native = await readyJob(f, true)
  assert.equal(f.approvals.length, 2); assert.deepEqual(f.waiting, [true, false])
  assert.notEqual(f.calls.find(call => call[0] === 'download' && call[1].planId === 'plan-1')[2], f.calls.find(call => call[0] === 'download' && call[1].planId === 'plan-2')[2])
  assert.equal((await f.call('status', { jobId: native.jobId })).code, 'FOREIGN_JOB')
})
test('external MCP setup requires no project but still asks in the desktop', async t => {
  const f = fixture({ assertAgentCurrent: () => assert.fail('No agent context should be inspected') }); t.after(() => f.controller.dispose())
  assert.equal((await readyJob(f, true)).success, true); assert.equal(f.approvals.length, 1)
})
test('export blocks plan/download/load, never status or cancellation', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  const job = await readyJob(f); f.setExport(true)
  for (const [method, payload] of [['plan', model], ['download', { planId: 'plan-1' }], ['load', { jobId: job.jobId }]]) assert.equal((await f.call(method, payload)).code, 'LM_STUDIO_SETUP_EXPORT_BUSY')
  assert.equal((await f.call('status', { jobId: job.jobId })).success, true)
  assert.equal((await f.call('cancel', { jobId: job.jobId })).state, 'cancelled'); assert.deepEqual(f.loads, [])
})
for (const action of ['download', 'load']) for (const boundary of ['export', 'navigation', 'replacement', 'agent-stop']) {
  test(`${boundary} during ${action} review rejects a late approval`, async t => {
    const f = fixture(); t.after(() => f.controller.dispose())
    const abort = new AbortController(); f.setScope({ signal: abort.signal, onWaiting: value => f.waiting.push(value) })
    const job = action === 'load' ? await readyJob(f, true) : null
    const plan = action === 'download' ? await f.controller.api.plan(model) : null
    const gate = f.holdApproval(), before = f.approvals.length
    const pending = f.controller.api[action](action === 'load' ? { jobId: job.jobId } : { planId: plan.planId })
    await until(() => f.approvals.length > before)
    if (boundary === 'export') f.setExport(true)
    if (boundary === 'navigation') f.contents.emit('did-start-navigation', {}, 'file:///new', false, true)
    if (boundary === 'replacement') f.replace()
    if (boundary === 'agent-stop') abort.abort()
    gate.resolve()
    assert.equal((await pending).success, false); assert.equal(f.effects.length, action === 'load' ? 1 : 0); assert.deepEqual(f.loads, [])
    assert.equal(f.waiting.at(-1), false); assert.equal(f.approvals.at(-1).config.signal.aborted, true)
  })
}
test('review expires, closes the native dialog, resumes active time, and ignores later approval', async t => {
  const f = fixture({ confirmationMs: 20 }); t.after(() => f.controller.dispose())
  f.setScope({ signal: new AbortController().signal, onWaiting: value => f.waiting.push(value) })
  const plan = await f.controller.api.plan(model), gate = f.holdApproval()
  const result = await f.controller.api.download({ planId: plan.planId })
  assert.equal(result.code, 'LM_STUDIO_SETUP_CONFIRMATION_EXPIRED'); assert.deepEqual(f.waiting, [true, false])
  assert.equal(f.approvals[0].config.signal.aborted, true); gate.resolve(); await tick(); assert.deepEqual(f.effects, [])
})
test('one live native review at a time and stale context exceptions reveal no raw errors', async t => {
  let fresh = true
  const f = fixture({ assertAgentCurrent: async () => { if (!fresh) throw Error('PRIVATE secret settings path') } }); t.after(() => f.controller.dispose())
  f.setScope({ signal: new AbortController().signal })
  const a = await f.controller.api.plan(model), b = await f.controller.api.plan(model), gate = f.holdApproval()
  const pending = f.controller.api.download({ planId: a.planId }); await until(() => f.approvals.length === 1)
  assert.equal((await f.controller.api.download({ planId: b.planId })).code, 'LM_STUDIO_SETUP_BUSY')
  fresh = false; gate.resolve(); const failed = await pending
  assert.equal(failed.success, false); assert.doesNotMatch(JSON.stringify(failed), /PRIVATE|secret/); assert.deepEqual(f.effects, [])
})
for (const backgroundAction of ['download-background', 'load-background', 'load-verification']) test(`${backgroundAction} ownership outlives the requesting turn but document navigation revokes it`, async t => {
  const f = fixture({ backgroundAction }); t.after(() => f.controller.dispose())
  const abort = new AbortController(); f.setScope({ signal: abort.signal }); const gate = f.holdBackground()
  const job = await readyJob(f, true); abort.abort(); gate.resolve()
  assert.deepEqual(await f.backgroundCheck, { success: true })
  f.contents.emit('did-start-navigation', {}, 'file:///same#tab', true, true)
  assert.equal((await f.controller.api.status({ jobId: job.jobId })).success, true)
  f.contents.emit('did-start-navigation', {}, 'file:///new', false, true)
  assert.equal(f.cancelledOwners.length, 2); assert.equal((await f.controller.api.status({ jobId: job.jobId })).code, 'FOREIGN_JOB')
})
test('only a native-approved result may bind once to its original project/chat/turn', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); const job = await readyJob(f, true)
  assert.deepEqual(await f.call('agentDownloads', query), { success: true, jobs: [] })
  assert.equal(associate(f, { ...job, jobId: 'invented' }), false)
  assert.equal(associate(f, { ...job, downloadApproved: false }), false)
  assert.equal(associate(f, { ...job, modelName: 'different' }), false)
  assert.equal(associate(f, job), true); assert.equal(associate(f, job, { ...origin, turnId: 'later' }), false)
  assert.deepEqual(f.sent, [[CHANGED]])
  f.update(job.jobId, { bytesReceived: 72 })
  const snapshot = await f.call('agentDownloads', query)
  assert.equal(snapshot.jobs[0].bytesReceived, 72); assert.equal(snapshot.jobs[0].turnId, origin.turnId)
  assert.doesNotMatch(JSON.stringify(snapshot), /synthetic\/models|sourceUrl|repository|owner|projectPath/)
  for (const next of [{ ...query, chatId: 'other' }, { ...query, projectPath: '/other-project' }]) assert.deepEqual(await f.call('agentDownloads', next), { success: true, jobs: [] })
  assert.equal((await f.call('status', { jobId: job.jobId })).success, true, 'Bound desktop may manage job after agent turn ends')
})
test('forged external receipt cannot create progress; no native approval means no delegation', async t => {
  const f = fixture({ skipApproval: true }); t.after(() => f.controller.dispose()); const job = await readyJob(f, true)
  assert.equal(job.downloadApproved, undefined)
  assert.equal(associate(f, { ...job, downloadApproved: true, background: true }), false)
  assert.deepEqual(await f.call('agentDownloads', query), { success: true, jobs: [] })
})
test('100% bytes is not loaded; ready needs verified connection, and malformed progress fails closed', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); const job = await readyJob(f, true); associate(f, job)
  f.update(job.jobId, { bytesReceived: 100 })
  assert.equal((await f.call('agentDownloads', query)).jobs[0].canLoad, false)
  f.update(job.jobId, { state: 'completed' })
  assert.equal((await f.call('agentDownloads', query)).jobs[0].canLoad, true)
  f.update(job.jobId, { state: 'ready', overrides: { connectionVerified: false } })
  assert.equal((await f.call('agentDownloads', query)).code, 'LM_STUDIO_SETUP_PROGRESS_UNAVAILABLE')
  f.update(job.jobId, { overrides: { connectionVerified: true } })
  const ready = (await f.call('agentDownloads', query)).jobs[0]
  assert.equal(ready.connectionVerified, true); assert.equal(ready.canLoad, false)
  f.update(job.jobId, { bytesReceived: 101 })
  assert.equal((await f.call('agentDownloads', query)).success, false)
})
test('delegated load still asks; delegated Cancel works during export and sends only invalidation', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); const job = await readyJob(f, true); associate(f, job)
  f.update(job.jobId, { state: 'completed', bytesReceived: 100 })
  assert.equal((await f.call('load', { jobId: job.jobId })).state, 'ready'); assert.equal(f.approvals.length, 2)
  assert.deepEqual(f.sent, [[CHANGED], [CHANGED]])
  f.setExport(true); assert.equal((await f.call('cancel', { jobId: job.jobId })).success, true)
  assert.deepEqual(f.sent.at(-1), [CHANGED])
})
test('late plan/progress responses are suppressed after window replacement', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); const gate = f.holdManager(), pending = f.call('plan', model)
  await until(() => f.calls.length === 1); f.replace(); gate.resolve()
  assert.equal((await pending).code, 'LM_STUDIO_SETUP_CONTEXT_CHANGED')
  const g = fixture(); t.after(() => g.controller.dispose()); const job = await readyJob(g, true); associate(g, job)
  const statusGate = g.holdStatus(), progress = g.call('agentDownloads', query); await until(() => g.calls.some(call => call[0] === 'status'))
  g.replace(); statusGate.resolve(); assert.equal((await progress).code, 'LM_STUDIO_SETUP_CONTEXT_CHANGED')
})
test('known missing jobs are pruned but status failures are not invented cancellation', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); const job = await readyJob(f, true); associate(f, job)
  f.statusOverride({ success: false, code: 'TRANSIENT', error: 'PRIVATE token' })
  const failed = await f.call('agentDownloads', query); assert.equal(failed.success, false); assert.doesNotMatch(JSON.stringify(failed), /PRIVATE|token/)
  f.statusOverride(null); assert.equal((await f.call('agentDownloads', query)).jobs.length, 1)
  f.forget(job.jobId); assert.deepEqual(await f.call('agentDownloads', query), { success: true, jobs: [] })
})
test('shutdown/crash close reviews, revoke owners, and remove exact handlers/listeners', async t => {
  const f = fixture(); t.after(() => f.controller.dispose()); const p = await f.call('plan', model), gate = f.holdApproval()
  const pending = f.call('download', { planId: p.planId }); await until(() => f.approvals.length === 1)
  f.contents.emit('render-process-gone'); assert.equal((await pending).success, false); gate.resolve()
  assert.equal(f.cancelledOwners.length, 2); assert.equal(f.contents.listenerCount('did-start-navigation'), 0)
  f.app.emit('will-quit'); assert.equal(f.disposed, 1); assert.equal(f.handlers.size, 0); assert.equal(f.app.listenerCount('will-quit'), 0)
  assert.equal((await f.controller.api.plan(model)).code, 'LM_STUDIO_SETUP_UNAUTHORIZED'); f.controller.dispose(); assert.equal(f.disposed, 1)
})
test('manager callbacks outside host call context fail and raw manager errors stay private', async t => {
  const f = fixture({ planError: true }); t.after(() => f.controller.dispose())
  const result = await f.call('plan', model); assert.equal(result.success, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|token/)
  await assert.rejects(f.dependencies.assertCanStart({ owner: 'forged', action: 'cancel' }), { code: 'LM_STUDIO_SETUP_CONTEXT_CHANGED' })
  assert.throws(() => f.dependencies.assertCanCommit({ owner: 'forged', action: 'download-commit' }), { code: 'LM_STUDIO_SETUP_CONTEXT_CHANGED' })
})
for (const action of ['download', 'load']) test(`${action} final commit guard is synchronous, document/export bound, and not tied to an ended turn`, async t => {
  for (const boundary of ['export', 'unknown', 'async', 'navigation', 'ended-turn']) {
    const f = fixture(); t.after(() => f.controller.dispose())
    const abort = new AbortController(); f.setScope({ signal: abort.signal })
    const job = action === 'load' ? await readyJob(f, true) : null
    const plan = action === 'download' ? await f.controller.api.plan(model) : null
    const gate = f.holdCommit(), count = f.approvals.length
    const pending = f.controller.api[action](action === 'load' ? { jobId: job.jobId } : { planId: plan.planId })
    await until(() => f.approvals.length > count); await tick()
    if (boundary === 'export') f.setExport(true)
    if (boundary === 'unknown') f.setExport(null)
    if (boundary === 'async') f.setExport(Promise.resolve(false))
    if (boundary === 'navigation') f.contents.emit('did-start-navigation', {}, 'file:///new-document', false, true)
    if (boundary === 'ended-turn') abort.abort()
    gate.resolve()
    const result = await pending
    assert.equal(result.success, boundary === 'ended-turn', `${action}/${boundary}: ${JSON.stringify(result)}`)
    assert.equal(f.effects.length, action === 'load' || boundary === 'ended-turn' ? 1 : 0)
    assert.equal(f.loads.length, action === 'load' && boundary === 'ended-turn' ? 1 : 0)
  }
})
test('full progress registry rechecks unobserved terminal jobs before a new approved transfer', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  for (let index = 0; index < 32; index++) {
    const job = await readyJob(f, true)
    f.update(job.jobId, { state: 'completed', bytesReceived: 100 })
  }
  const next = await readyJob(f, true)
  assert.equal(associate(f, next), true)
  assert.equal((await f.call('agentDownloads', query)).jobs[0].jobId, next.jobId)
})
test('full registry with genuinely active jobs rejects before another download effect or review', async t => {
  const f = fixture(); t.after(() => f.controller.dispose())
  for (let index = 0; index < 32; index++) await readyJob(f, true)
  const plan = await f.controller.api.plan(model)
  assert.equal((await f.controller.api.download({ planId: plan.planId })).code, 'LM_STUDIO_SETUP_JOB_LIMIT')
  assert.equal(f.effects.length, 32); assert.equal(f.approvals.length, 32)
})
