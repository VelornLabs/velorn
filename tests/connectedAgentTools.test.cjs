'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createAgentToolSession, LIMITS } = require('../electron/connectedAgentTools.cjs')
const { createAgentDispatchScope } = require('../electron/connectedAgentDispatch.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { projectConnectedAgentTool } = require('../electron/connectedAgentArguments.cjs')
const { createComfyRouter, MODEL } = require('../electron/comfyRouter.cjs')

const clone = value => JSON.parse(JSON.stringify(value))
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const text = value => value.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const context = () => ({ schemaVersion: 1, session: 'renderer-one', projectKey: '/disposable/project',
  timelineId: 'timeline-one', timelineSessionId: 8, compoundClipId: null, storyboardRevision: 0, revision: 2 })
const definition = (name, preview = true) => ({ name, description: `Synthetic ${name}`, inputSchema: {
  type: 'object', properties: preview ? { previewOnly: { type: 'boolean' } } : {},
} })

async function fixture(options = {}) {
  const server = options.server || createComfyStudioMcpServer()
  let guard = { context: context(), selection: { clipIds: ['clip-one'], assetIds: [], selectedMarkerId: null }, playhead: 4 }
  const dispatches = [], approvals = [], events = [], abort = new AbortController()
  const getContext = async () => clone(guard)
  const defaultExecute = async (name, args, suppliedGuard) => {
    dispatches.push({ name, args: clone(args), guard: clone(suppliedGuard) })
    if (args.previewOnly === true) return result({ previewOnly: true, action: name,
      suggestedApplyCall: { tool: name, arguments: { ...args, expectedContext: clone(guard.context), previewOnly: false } } })
    if (name === 'create_project_checkpoint') return result({ success: true, action: name, checkpointId: 'checkpoint-synthetic' })
    return result({ success: true, action: name })
  }
  const session = await createAgentToolSession({ getServer: () => server, signal: abort.signal,
    expectedContext: context(), getContext, onEvent: event => events.push(event),
    requestApproval: async request => { approvals.push(request); return options.approval ? options.approval(request, guard) : true },
    executeTool: options.execute ? async (name, args, suppliedGuard) => {
      dispatches.push({ name, args: clone(args), guard: clone(suppliedGuard) })
      return options.execute(name, args, suppliedGuard, guard)
    } : defaultExecute,
    ...options.session,
  })
  return { session, server, dispatches, approvals, events, abort, getContext,
    guard: () => guard, setGuard: value => { guard = value } }
}

test('native generation monitor uses the existing read boundary, not model tool quota or write approval', async () => {
  const f = await fixture({ session: { limits: { calls: 1 } }, execute: async (name, args) => {
    assert.equal(name, 'get_comfyui_runs'); assert.deepEqual(args, {})
    return result({ success: true, runs: [{ id: 'existing', status: 'done', importState: 'imported', resultAssetIds: ['asset-existing'], outputCount: 1 }] })
  } })
  const waiting = []; f.session.subscribeUserWaiting(value => waiting.push(value))
  for (let i = 0; i < 3; i++) assert.equal((await f.session.monitorGenerationRuns({ runIds: ['existing'] })).reason, 'batch_complete')
  assert.equal(f.dispatches.length, 3); assert.equal(f.approvals.length, 0)
  assert.deepEqual(waiting, [false, true, false, true, false, true, false])
})

test('native generation monitor stops on project change and cannot rebind IDs to another project', async () => {
  const f = await fixture({ execute: async (_name, _args, _guard, live) => {
    live.context.projectKey = '/different/project'
    return result({ success: true, runs: [{ id: 'a', status: 'done', importState: 'imported' }] })
  } })
  await assert.rejects(f.session.monitorGenerationRuns({ runIds: ['a'] }), /Project changed/)
  assert.equal(f.dispatches.length, 1); assert.equal(f.approvals.length, 0)
})

test('native generation monitor fails without a catalog capability or after cancellation', async () => {
  const f = await fixture({ server: { tools: [] } })
  await assert.rejects(f.session.monitorGenerationRuns({ runIds: ['a'] }), /unavailable/)
  const ready = await fixture(); ready.abort.abort()
  await assert.rejects(ready.session.monitorGenerationRuns({ runIds: ['a'] }), /canceled/)
  assert.equal(f.dispatches.length + ready.dispatches.length, 0)
})

async function routerFixture(t, trustedFullAccess) {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-router-agent-test-'))
  const nativeApprovals = [], providerRequests = [], nativeCalls = []
  const state = { approved: true }
  let f
  const manager = createComfyRouter({ storageDir, getContext: async () => f ? clone(f.guard().context) : context(),
    getPolicy: async () => 'ask-cloud', confirmSpend: async request => { nativeApprovals.push(request); return state.approved },
    fetchImpl: async (url, options) => {
      providerRequests.push({ url, ...options })
      assert.ok(url === `https://api.comfy.org/v2/models/${MODEL}` || url === `https://api.comfy.org/v2/models/${MODEL}/requests`)
      return new Response(JSON.stringify(options.method === 'POST'
        ? { request_id: 'synthetic-provider-job', status: 'IN_QUEUE' } : { id: MODEL }),
      { status: options.method === 'POST' ? 201 : 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  t.after(async () => { manager.dispose(); await fs.rm(storageDir, { recursive: true, force: true }) })
  const comfyRouter = Object.fromEntries(['status', 'list', 'preview', 'inspectPlan', 'submit', 'refresh', 'cancel'].map(method => [method, async args => {
    nativeCalls.push({ method, args: clone(args) })
    return manager[method](args)
  }]))
  const server = createComfyStudioMcpServer({ comfyRouter })
  server.updateSnapshot({ context: context(), project: { name: 'Synthetic Router test', path: context().projectKey },
    currentTimeline: { id: context().timelineId, tracks: [], clips: [] }, assets: [] })
  f = await fixture({ server, session: { trustedFullAccess }, execute: (name, args) => server.callTool(name, args) })
  assert.equal((await manager.connect({ apiKey: 'synthetic-router-agent-test-key-never-real' })).success, true)
  return { ...f, manager, state, nativeApprovals, nativeCalls, providerRequests,
    posts: () => providerRequests.filter(request => request.method === 'POST') }
}

test('Router prompt/plan previews stay read-only and every paid apply uses native confirmation in Normal and Full access', async t => {
  for (const trustedFullAccess of [false, true]) {
    const f = await routerFixture(t, trustedFullAccess)
    const prompt = 'The original synthetic paper fox'
    const preview = await f.session.callTool('generate_comfy_router_image', { prompt })
    assert.equal(preview.isError, undefined, text(preview))
    const plan = JSON.parse(text(preview))
    assert.equal(plan.previewOnly, true)
    assert.equal(plan.prompt, prompt)
    const reviewed = JSON.parse(text(await f.session.callTool('generate_comfy_router_image', { planId: plan.planId })))
    assert.equal(reviewed.planId, plan.planId)
    assert.equal(reviewed.prompt, prompt)
    assert.equal(reviewed.previewOnly, true)
    assert.equal(f.nativeApprovals.length, 0)
    assert.equal(f.approvals.length, 0)
    assert.equal(f.posts().length, 0)
    assert.equal(f.providerRequests.length, 1, 'Only the synthetic setup catalog check has occurred')
    const apply = await f.session.callTool('generate_comfy_router_image', { planId: plan.planId, previewOnly: false })
    assert.equal(apply.isError, undefined, text(apply))
    assert.equal(f.approvals.length, trustedFullAccess ? 0 : 1)
    assert.equal(f.nativeApprovals.length, 1, 'Full access cannot bypass the native paid dialog')
    assert.equal(f.nativeApprovals[0].prompt, prompt)
    assert.equal(f.nativeApprovals[0].submissionCount, 1)
    assert.equal(f.posts().length, 1)
    assert.equal(JSON.parse(f.posts()[0].body).prompt, prompt)
    assert.deepEqual(f.nativeCalls.map(call => call.method), trustedFullAccess
      ? ['preview', 'inspectPlan', 'submit'] : ['preview', 'inspectPlan', 'inspectPlan', 'submit'])
    assert.deepEqual(f.nativeCalls.find(call => call.method === 'submit').args, { planId: plan.planId })
    await f.session.callTool('generate_comfy_router_image', { planId: plan.planId, previewOnly: false })
    assert.equal(f.posts().length, 1, 'Neither access mode may resubmit an already submitted plan')
    assert.equal(f.nativeApprovals.length, 1)
  }
})

test('Router native decline blocks provider submission even after connected-agent approval or Full access', async t => {
  for (const trustedFullAccess of [false, true]) {
    const f = await routerFixture(t, trustedFullAccess)
    const plan = JSON.parse(text(await f.session.callTool('generate_comfy_router_image', { prompt: 'A synthetic paper house' })))
    f.state.approved = false
    const denied = await f.session.callTool('generate_comfy_router_image', { planId: plan.planId, previewOnly: false })
    assert.equal(denied.isError, true)
    assert.match(text(denied), /COMFY_ROUTER_DECLINED/)
    assert.equal(f.nativeApprovals.length, 1)
    assert.equal(f.posts().length, 0)
    assert.equal(f.nativeCalls.filter(call => call.method === 'preview').length, 1, 'Decline cannot trigger another plan')
  }
})

test('Router malformed apply cannot implicitly prepare a plan in either connected-agent access mode', async t => {
  for (const trustedFullAccess of [false, true]) {
    for (const args of [
      { prompt: 'Do not implicitly create this plan', previewOnly: false },
      { planId: 'missing-plan', prompt: 'Do not replace the prompt', previewOnly: false },
      { previewOnly: false },
    ]) {
      const f = await routerFixture(t, trustedFullAccess)
      assert.equal((await f.session.callTool('generate_comfy_router_image', args)).isError, true)
      assert.deepEqual(f.nativeCalls, [])
      assert.equal(f.nativeApprovals.length, 0)
      assert.equal(f.approvals.length, 0)
      assert.equal(f.posts().length, 0)
    }
  }
})

test('exposes all live definitions with only host-managed editing controls projected, no alias expansion', async () => {
  const f = await fixture()
  const tools = await f.session.listTools()
  assert.equal(tools.length, 197)
  assert.ok(tools.some(tool => tool.name === 'request_comfy_cloud_setup'))
  assert.ok(tools.some(tool => tool.name === 'get_comfy_cloud_setup_status'))
  assert.deepEqual(tools, f.server.tools.map(projectConnectedAgentTool))
  assert.deepEqual(tools.map(tool => tool.name), f.server.tools.map(tool => tool.name))
  tools[0].name = 'caller-cannot-mutate-catalog'
  assert.equal(f.server.tools[0].name, 'get_project')
  f.server.tools.push(definition('future_tool', false))
  assert.equal((await f.session.listTools()).length, tools.length + 1)
  assert.equal((await f.session.callTool('not_in_catalog')).isError, true)
  assert.equal((await f.session.callTool('list_comfystudio_workflows')).isError, true)
  assert.equal(f.dispatches.length, 0)
})

test('read-only inspection dispatches directly with the authoritative guard', async () => {
  const f = await fixture()
  const r = await f.session.callTool('get_timeline', { includeClips: true })
  assert.equal(r.isError, undefined)
  assert.equal(f.approvals.length, 0)
  assert.deepEqual(f.dispatches[0].guard, f.guard())
  assert.deepEqual(f.events.map(event => event.status), ['running', 'completed'])
})

test('workflow authoring checks need no previews or approvals in either access mode', async () => {
  for (const trustedFullAccess of [false, true]) {
    const f = await fixture({ session: { trustedFullAccess } })
    for (const [name, args] of [
      ['discover_comfyui_nodes', { query: 'video' }], ['inspect_comfyui_node', { classType: 'LoadImage' }],
      ['find_comfyui_node_paths', { fromType: 'LATENT', toType: 'IMAGE' }],
      ['validate_comfyui_workflow', { workflow: { a: { class_type: 'SaveImage', inputs: {} } } }],
    ]) {
      assert.notEqual((await f.session.callTool(name, args)).isError, true)
      assert.notEqual((await f.session.callTool(name, args)).isError, true)
    }
    assert.equal(f.approvals.length, 0)
    assert.equal(f.dispatches.length, 8)
    assert.ok(f.dispatches.every(d => !Object.hasOwn(d.args, 'previewOnly')))
  }
})

test('default sessions continue beyond the previous forty-call cutoff in both access modes', async () => {
  for (const trustedFullAccess of [false, true]) {
    const f = await fixture({ session: { trustedFullAccess } })
    for (let index = 0; index < 70; index++) {
      assert.equal((await f.session.callTool('get_timeline', { includeClips: true })).isError, undefined)
    }
    assert.equal(f.dispatches.length, 70)
    f.abort.abort()
    assert.equal((await f.session.callTool('get_timeline')).isError, true)
    assert.equal(f.dispatches.length, 70, 'Stop still prevents subsequent dispatches')
  }
})

test('workflow opening previews silently and respects normal approval versus Full access', async () => {
  const normal = await fixture()
  assert.notEqual((await normal.session.callTool('open_comfyui_workflow', { workflowId: 'tpl-mcp-test', previewOnly: true })).isError, true)
  assert.equal(normal.approvals.length, 0)
  assert.deepEqual(normal.dispatches.map(call => call.args.previewOnly), [true])
  assert.notEqual((await normal.session.callTool('open_comfyui_workflow', { workflowId: 'tpl-mcp-test', previewOnly: false })).isError, true)
  assert.equal(normal.approvals.length, 1)
  assert.ok(normal.dispatches.every(call => call.name === 'open_comfyui_workflow'))

  const full = await fixture({ session: { trustedFullAccess: true } })
  assert.notEqual((await full.session.callTool('open_comfyui_workflow', { workflowId: 'tpl-mcp-test' })).isError, true)
  assert.equal(full.approvals.length, 0)
  assert.deepEqual(full.dispatches.map(call => [call.name, call.args.previewOnly]), [['open_comfyui_workflow', false]])
})

test('inspection stills are delivered to chat only with image consent; no raw metadata is emitted', async () => {
  for (const allowImages of [true,false]) {
    const f = await fixture({ session: {allowImages}, execute: () => ({content:[
      {type:'text',text:JSON.stringify({timeline:{id:'timeline-one'},frame:{timeSeconds:1.5},secret:'not-projected'})},
      {type:'image',mimeType:'image/jpeg',data:'/9j/2Q=='},
    ]}) })
    await f.session.callTool('inspect_timeline_frame',{timeSeconds:1.5,includeImage:true})
    const events = f.events.filter(event=>event.type==='review-frame')
    assert.equal(events.length,allowImages?1:0)
    if (allowImages) {assert.equal(events[0].frame.timeSeconds,1.5);assert.equal(events[0].frame.secret,undefined)}
  }
})

test('identical Generate queue polls return fresh progress without approval in every permission mode', async () => {
  for (const session of [{}, { autoApproveEdits: true }]) {
    let pollCount = 0
    const f = await fixture({ session, approval: () => false, execute: (name) => {
      assert.equal(name, 'get_generation_queue_status')
      pollCount += 1
      return result({ success: true, action: name, jobs: [{ id: 'job-one',
        status: pollCount === 3 ? 'done' : 'running', progress: pollCount * 30,
        resultAssetIds: pollCount === 3 ? ['asset-one'] : [] }] })
    } })
    const args = { jobIds: ['job-one'], batchId: 'batch-one', includeDone: true, limit: 5 }
    for (let index = 1; index <= 3; index++) {
      const response = await f.session.callTool('get_generation_queue_status', args)
      assert.equal(response.isError, undefined)
      const job = JSON.parse(text(response)).jobs[0]
      assert.equal(job.progress, index * 30)
      assert.equal(job.status, index === 3 ? 'done' : 'running')
      assert.deepEqual(job.resultAssetIds, index === 3 ? ['asset-one'] : [])
    }
    assert.equal(f.approvals.length, 0)
    assert.equal(f.dispatches.length, 3)
    assert.ok(f.dispatches.every(call => call.name === 'get_generation_queue_status'))
    for (const call of f.dispatches) assert.deepEqual(call.args, args)
    assert.ok(f.events.every(event => !event.autoApproved))
  }
})

test('native ComfyUI Runs reads are repeatable while queueing stays previewed and approval-gated', async () => {
  for (const session of [{}, { autoApproveEdits: true }]) {
    const f = await fixture({ session })
    for (let index = 0; index < 2; index++) {
      assert.equal((await f.session.callTool('get_comfyui_runs', { includeOtherProjects: true })).isError, undefined)
      assert.equal((await f.session.callTool('inspect_comfyui_run', { runId: 'run-one', includeOtherProjects: true })).isError, undefined)
    }
    assert.equal(f.approvals.length, 0)
    assert.equal(f.dispatches.filter(call => ['get_comfyui_runs', 'inspect_comfyui_run'].includes(call.name)).length, 4)

    const queued = await f.session.callTool('queue_comfyui_workflow', {
      workflow: { '1': { class_type: 'SaveImage', inputs: {} } }, previewOnly: false,
    })
    assert.equal(queued.isError, undefined)
    assert.deepEqual(f.dispatches.filter(call => call.name === 'queue_comfyui_workflow').map(call => call.args.previewOnly), [true, false])
    assert.equal(f.approvals.length, session.trustedFullAccess ? 0 : 1)
    if (f.approvals.length) assert.match(f.approvals[0].warnings.join(' '), /start local generation or spend cloud credits/)
  }
})

test('tracked-run adoption, control, and output import have safe previews but require approval to apply', async () => {
  const cases = [
    ['track_comfyui_prompt', { promptId: 'prompt-one' }],
    ['control_comfyui_run', { runId: 'run-one', operation: 'cancel' }],
    ['import_comfyui_run_outputs', { runId: 'run-one' }],
  ]
  for (const [name, args] of cases) {
    const preview = await fixture({ approval: () => false })
    assert.equal((await preview.session.callTool(name, args)).isError, undefined, `${name} preview`)
    assert.equal(preview.approvals.length, 0, `${name} preview approval`)
    assert.deepEqual(preview.dispatches.map(call => call.args.previewOnly), [true], `${name} preview payload`)

    const apply = await fixture({ approval: () => false })
    const response = await apply.session.callTool(name, { ...args, previewOnly: false })
    assert.equal(response.isError, true, `${name} declined apply`)
    assert.equal(apply.approvals.length, 1, `${name} apply approval`)
    assert.deepEqual(apply.dispatches.map(call => call.args.previewOnly), [true], `${name} must not apply after denial`)
  }
})

test('failed Generate queue reads do not quarantine later polls, reads or approved generation', async () => {
  for (const session of [{}, { autoApproveEdits: true }]) {
    for (const failure of ['throw', 'error-result', 'invalid-result', 'timeout']) {
      let pollCount = 0
      const f = await fixture({ session: { ...session, limits: { operationTimeoutMs: 50 } }, execute: (name, args) => {
        if (name === 'get_generation_queue_status' && ++pollCount === 1) {
          if (failure === 'throw') throw new Error('Synthetic queue read failed.')
          if (failure === 'error-result') return { isError: true, ...result({ success: false, error: 'Synthetic queue unavailable.' }) }
          if (failure === 'invalid-result') return null
          return new Promise(() => {})
        }
        return args.previewOnly ? result({ previewOnly: true }) : result({ success: true, action: name })
      } })
      assert.equal((await f.session.callTool('get_generation_queue_status', { jobIds: ['job-one'] })).isError, true, failure)
      assert.equal((await f.session.callTool('get_generation_queue_status', { jobIds: ['job-one'] })).isError, undefined, failure)
      assert.equal((await f.session.callTool('get_timeline')).isError, undefined, failure)
      assert.equal(f.approvals.length, 0)
      assert.equal((await f.session.callTool('queue_timeline_template_generation', {
        workflowId: 'tpl-synthetic', previewOnly: false,
      })).isError, undefined, failure)
      assert.equal(f.approvals.length, session.trustedFullAccess ? 0 : 1)
      assert.equal(f.dispatches.filter(call => call.name === 'queue_timeline_template_generation'
        && call.args.previewOnly === false).length, 1)
    }
  }
})

test('repeatable queue reads retain call limits, cancellation and project identity checks', async () => {
  const limited = await fixture({ session: { limits: { calls: 2 } }, approval: () => false })
  assert.equal((await limited.session.callTool('get_generation_queue_status')).isError, undefined)
  assert.equal((await limited.session.callTool('get_generation_queue_status')).isError, undefined)
  assert.match(text(await limited.session.callTool('get_generation_queue_status')), /tool-call limit/)
  assert.equal(limited.dispatches.length, 2)
  for (const stop of ['cancel', 'project-change']) {
    const f = await fixture({ approval: () => false })
    assert.equal((await f.session.callTool('get_generation_queue_status')).isError, undefined)
    if (stop === 'cancel') f.abort.abort()
    else f.guard().context.projectKey = '/another/project'
    assert.equal((await f.session.callTool('get_generation_queue_status')).isError, true, stop)
    assert.equal(f.dispatches.length, 1)
    assert.equal(f.approvals.length, 0)
  }
})

test('real generation mutations remain approval-gated and identical retries blocked after queue polls', async () => {
  for (const session of [{}, { autoApproveEdits: true }]) {
    for (const name of ['queue_timeline_template_generation', 'queue_prompt_generation_batch', 'generate_music']) {
      const f = await fixture({ session })
      const args = { previewOnly: false }
      assert.equal((await f.session.callTool(name, args)).isError, undefined, name)
      assert.equal((await f.session.callTool('get_generation_queue_status')).isError, undefined)
      assert.equal((await f.session.callTool('get_generation_queue_status')).isError, undefined)
      const duplicate = await f.session.callTool(name, args)
      assert.equal(duplicate.isError, true, name)
      assert.match(text(duplicate), /already dispatched/)
      assert.equal(f.dispatches.filter(call => call.name === name && call.args.previewOnly === false).length, 1)
      assert.equal(f.approvals.length, session.trustedFullAccess ? 0 : 1)
      if (f.approvals.length) assert.match(f.approvals[0].warnings.join(' '), /start local generation or spend cloud credits/)
    }
  }
})

test('queue polls remain available after an uncertain generation without unlocking another write', async () => {
  const f = await fixture({ session: {}, execute: (name, args) => {
    if (args.previewOnly) return result({ previewOnly: true })
    if (name === 'queue_timeline_template_generation') throw new Error('Synthetic generation submission result lost.')
    return result({ success: true, jobs: [{ id: 'job-one', status: 'running' }] })
  } })
  assert.equal((await f.session.callTool('queue_timeline_template_generation', { previewOnly: false })).isError, true)
  assert.equal((await f.session.callTool('get_generation_queue_status')).isError, undefined)
  assert.equal((await f.session.callTool('get_generation_queue_status')).isError, undefined)
  const before = f.dispatches.length
  for (const name of ['queue_timeline_template_generation', 'generate_music']) {
    const response = await f.session.callTool(name, { previewOnly: false })
    assert.equal(response.isError, true)
    assert.match(text(response), /did not return a confirmed result/)
  }
  assert.equal(f.dispatches.length, before)
  assert.equal(f.approvals.length, 1)
})

test('Full access applies directly by default without cards, checkpoints or duplicate-action locks', async () => {
  const f = await fixture({ session: { trustedFullAccess: true }, approval: () => false })
  for (const name of ['add_text_clip', 'add_asset_to_timeline', 'save_project', 'queue_timeline_template_generation']) {
    assert.equal((await f.session.callTool(name, {})).isError, undefined, name)
    assert.deepEqual(f.dispatches.filter(call => call.name === name).map(call => call.args.previewOnly), [false])
    assert.equal((await f.session.callTool(name, {})).isError, undefined, `${name} may be requested again`)
  }
  assert.equal((await f.session.callTool('get_generation_queue_status')).isError, undefined)
  assert.equal(f.approvals.length, 0)
  assert.ok(f.events.some(event => event.summary === 'Completed with Full access.'))
  assert.equal(f.dispatches.some(call => call.name === 'create_project_checkpoint'), false)
  const before = f.dispatches.length
  f.abort.abort()
  assert.equal((await f.session.callTool('save_project', { previewOnly: false, name: 'different' })).isError, true)
  assert.equal(f.dispatches.length, before)
})

test('Full access waits for the task deadline or Stop, not the old per-operation timer', async () => {
  const originalSetTimeout = global.setTimeout, originalClearTimeout = global.clearTimeout
  const activeTimers = new Set()
  global.setTimeout = (callback, milliseconds) => {
    const timer = { callback, milliseconds }
    activeTimers.add(timer)
    return timer
  }
  global.clearTimeout = timer => activeTimers.delete(timer)
  try {
    let started
    const ready = new Promise(resolve => { started = resolve })
    const f = await fixture({ session: { trustedFullAccess: true }, execute: () => {
      started()
      return new Promise(() => {})
    } })
    const pending = f.session.callTool('save_project')
    await ready
    assert.equal(activeTimers.size, 0, 'No default operation timer interrupts an in-flight Full-access tool')
    f.abort.abort()
    assert.equal((await pending).isError, true)
    assert.equal(f.dispatches.length, 1, 'Stop does not retry the action')
  } finally {
    global.setTimeout = originalSetTimeout
    global.clearTimeout = originalClearTimeout
  }
})

test('Full access honors explicit previews, strips stale control fields and continues after errors or navigation', async () => {
  const f = await fixture({ session: { trustedFullAccess: true }, execute: (name, args) => {
    if (args.previewOnly) return result({ previewOnly: true, action: name })
    if (name === 'delete_clips') throw new Error('Native target not found')
    return result({ success: true, action: name })
  } })
  const schemas = await f.session.listTools()
  const trim = schemas.find(tool => tool.name === 'trim_clips')
  assert.equal(trim.inputSchema.properties.previewOnly.default, false)
  assert.equal(trim.inputSchema.properties.expectedContext, undefined)
  assert.equal(trim.inputSchema.properties.previewToken, undefined)
  assert.equal((await f.session.callTool('trim_clips', { clipId: 'one', durationSeconds: 2, previewOnly: true })).isError, undefined)
  assert.deepEqual(f.dispatches.map(call => call.args.previewOnly), [true])
  f.guard().context.timelineId = 'different-timeline'
  f.guard().playhead = 50
  f.guard().selection.clipIds = []
  assert.equal((await f.session.callTool('trim_clips', { clipId: 'one', durationSeconds: 2,
    expectedContext: { stale: true }, previewToken: 'expired', exportPlanToken: 'old' })).isError, undefined)
  assert.deepEqual(f.dispatches.at(-1).args, { clipId: 'one', durationSeconds: 2, previewOnly: false })
  assert.equal((await f.session.callTool('delete_clips', { clipIds: ['missing'] })).isError, true)
  assert.equal((await f.session.callTool('save_project')).isError, undefined, 'A native error does not lock the rest of the turn')
  assert.equal(f.approvals.length, 0)
  assert.equal(f.dispatches.some(call => call.name === 'create_project_checkpoint'), false)
})

test('Full access handles required native preparation in one model call, without an approval round trip', async () => {
  for (const name of ['edit_storyboard', 'edit_production_run', 'queue_prepared_generation', 'install_caption_engine']) {
    const f = await fixture({ session: { trustedFullAccess: true }, execute: (tool, args) => args.previewOnly
      ? result({ previewOnly: true, suggestedApplyPayload: { previewToken: 'native-prepared', expectedContext: { current: true } } })
      : result({ success: true, action: tool }) })
    assert.equal((await f.session.callTool(name, { operation: 'synthetic' })).isError, undefined)
    assert.deepEqual(f.dispatches.map(call => call.args.previewOnly), [true, false])
    assert.equal(f.dispatches.at(-1).args.previewToken, 'native-prepared')
    assert.equal(f.approvals.length, 0)
  }
})

test('trusted permission is host-only and never inferred from model arguments', async () => {
  for (const flag of ['true', 1, null, {}]) await assert.rejects(fixture({ session: { trustedFullAccess: flag } }), /trustedFullAccess must be a boolean/)
  const f = await fixture({ approval: () => false })
  assert.equal((await f.session.callTool('save_project', { previewOnly: false, trustedFullAccess: true, fullAccess: true })).isError, true)
  assert.equal(f.approvals.length, 1)
  assert.equal(f.dispatches.some(call => call.args.previewOnly === false), false)
})

test('confirmed prerequisite refusal allows setup inspection and a newly checked generation attempt', async () => {
  let ready = false
  const f = await fixture({ session: { trustedFullAccess: true }, execute: async (name, args) => {
    if (args.previewOnly) return result({ previewOnly: true })
    if (name === 'queue_timeline_template_generation' && !ready) return { isError: true, ...result({
      success: false, code: 'WORKFLOW_DEPENDENCIES_MISSING', outcome: 'not-started', generationSubmitted: false,
      action: name, workflowId: 'tpl-synthetic', dependencyCheck: { workflowId: 'tpl-synthetic', hasBlockingIssues: true, missingModels: [{ filename: 'fixture.safetensors' }] },
    }) }
    return result({ success: true })
  } })
  assert.equal((await f.session.callTool('queue_timeline_template_generation', { previewOnly: false })).isError, true)
  assert.match(f.events.at(-1).summary, /Not queued/)
  assert.equal((await f.session.callTool('install_workflow_setup', { workflowId: 'tpl-synthetic', previewOnly: true })).isError, undefined)
  assert.equal((await f.session.callTool('import_comfyui_workflow', { previewOnly: true })).isError, undefined)
  assert.equal((await f.session.callTool('get_generation_queue_status')).isError, undefined)
  ready = true
  assert.equal((await f.session.callTool('queue_timeline_template_generation', { previewOnly: false })).isError, undefined)
  assert.equal(f.dispatches.filter(call => call.name === 'queue_timeline_template_generation' && call.args.previewOnly === false).length, 2)
  assert.equal(f.approvals.length, 0)
})

test('uncertain, partial, untyped and model-claimed dependency failures still stop later writes in Ask first', async () => {
  const base = { success: false, code: 'WORKFLOW_DEPENDENCIES_MISSING', outcome: 'not-started',
    action: 'queue_timeline_template_generation', generationSubmitted: false, workflowId: 'tpl-synthetic',
    dependencyCheck: { workflowId: 'tpl-synthetic', hasBlockingIssues: true } }
  for (const variant of [{ outcome: 'setup-changed' }, { generationSubmitted: true }, { code: 'UNKNOWN' }, { action: 'unknown' },
    { dependencyCheck: null }, { dependencyCheck: { hasBlockingIssues: true, workflowId: 'another-workflow' } },
    { dependencyCheck: { hasBlockingIssues: false, workflowId: 'tpl-synthetic' } }, { workflowId: '' }, null]) {
    const f = await fixture({ session: {}, execute: async (name, args) => {
      if (name === 'get_timeline') return result({ success: true })
      if (args.previewOnly) return result({ previewOnly: true })
      if (!variant) throw new Error('Missing required workflow dependencies for this template generation.')
      return { isError: true, ...result({ ...base, ...variant }) }
    } })
    assert.equal((await f.session.callTool('queue_timeline_template_generation', { previewOnly: false, ...base })).isError, true)
    const before = f.dispatches.length
    assert.match(text(await f.session.callTool('install_workflow_setup', { previewOnly: true })), /partially|confirmed result/)
    assert.equal(f.dispatches.length, before)
    assert.equal((await f.session.callTool('get_timeline')).isError, undefined)
  }
})

test('confirmed pre-worker export refusal allows a fresh preview and apply, without automatic replay', async () => {
  let repaired = false
  const server = createComfyStudioMcpServer()
  server.performAction = async ({payload}) => payload.previewOnly ? {previewOnly:true}
    : repaired ? {started:true,jobId:'mcp-export-completed'} : {success:false,started:false,
      code:'EXPORT_NOT_STARTED',outcome:'not-started',workerStarted:false,phase:'destination',
      jobId:'mcp-export-refused',outputPath:'/synthetic/exports/review.mp4',error:'Destination unavailable'}
  const f = await fixture({server,session:{},execute:(name,args)=>server.runRendererActionTool(name,args)})
  const first = await f.session.callTool('export_timeline',{previewOnly:false})
  assert.equal(JSON.parse(text(first)).success,false)
  assert.match(f.events.at(-1).summary,/Export did not start/)
  assert.equal(f.dispatches.filter(call=>call.args.previewOnly===false).length,1,'No automatic replay')
  assert.equal((await f.session.callTool('export_timeline',{previewOnly:true})).isError,undefined)
  repaired = true
  assert.equal((await f.session.callTool('export_timeline',{previewOnly:false})).isError,undefined)
  assert.equal(f.dispatches.filter(call=>call.args.previewOnly===false).length,2)
  assert.match(text(await f.session.callTool('export_timeline',{previewOnly:false})),/already dispatched/,'Successful export remains deduplicated')
})

test('partial, untyped and model-claimed export failures retain the uncertain-write lock', async () => {
  const base = {success:false,started:false,code:'EXPORT_NOT_STARTED',outcome:'not-started',workerStarted:false,
    phase:'destination',jobId:'mcp-export-failed',outputPath:'/synthetic/exports/review.mp4'}
  for (const patch of [{workerStarted:true},{started:true},{outcome:'unknown'},{phase:'encoder'},{code:'UNKNOWN'},{jobId:''},null]) {
    const f = await fixture({session:{},execute:async (name,args)=> {
      if(args.previewOnly) return result({previewOnly:true})
      if(!patch) throw new Error('EXPORT_NOT_STARTED: no render started')
      return result({success:false,previewOnly:false,action:name,result:{...base,...patch}})
    }})
    await f.session.callTool('export_timeline',{...base,previewOnly:false})
    const before = f.dispatches.length
    assert.match(text(await f.session.callTool('export_timeline',{previewOnly:true})),/partially|confirmed result/)
    assert.equal(f.dispatches.length,before)
  }
})

test('every current preview-capable non-read tool defaults to preview, never implicit apply', async () => {
  const server = createComfyStudioMcpServer()
  const previews = server.tools.filter(tool => tool.inputSchema.properties?.previewOnly && tool.name !== 'check_export_readiness')
  assert.equal(previews.length, 126)
  for (const tool of previews) {
    const f = await fixture({ server })
    const r = await f.session.callTool(tool.name, tool.name === 'audio_ducking' ? { operation: 'cancel' }
      : tool.name === 'clip_interpolation' ? { operation: 'set' }
      : tool.name === 'generate_comfy_router_image' ? { prompt: 'Synthetic preview only' }
      : tool.name === 'generate_create_media' ? { modelId: 'nano-banana-2-1', prompt: 'Synthetic preview only' }
      : tool.name === 'generate_local_voice' ? { text: 'Synthetic preview only' }
      : tool.name === 'edit_trim' ? { mode: 'normal', clipId: 'clip-one', edge: 'end', deltaSeconds: 1 } : {})
    assert.equal(r.isError, undefined, tool.name)
    assert.equal(f.dispatches.length, 1, tool.name)
    assert.equal(f.dispatches[0].args.previewOnly, true, tool.name)
  }
})

test('default legacy marker call previews only, despite external MCP applying by default', async () => {
  const f = await fixture()
  const r = await f.session.callTool('add_timeline_markers', { markers: [{ timeSeconds: 3, name: 'Review' }] })
  assert.equal(r.isError, undefined)
  assert.equal(f.approvals.length, 0)
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.dispatches[0].args.previewOnly, true)
})

test('explicit marker apply previews, approves exact payload, and then dispatches once', async () => {
  const f = await fixture()
  const args = { markers: [{ timeSeconds: 3, name: 'Review' }], previewOnly: false }
  const r = await f.session.callTool('add_timeline_markers', args)
  assert.equal(r.isError, undefined)
  assert.deepEqual(f.dispatches.map(call => [call.name, call.args.previewOnly]), [
    ['add_timeline_markers', true], ['create_project_checkpoint', true], ['create_project_checkpoint', false], ['add_timeline_markers', false],
  ])
  assert.equal(f.approvals.length, 1)
  assert.deepEqual(f.approvals[0].arguments, f.dispatches[3].args)
  assert.match(f.approvals[0].warnings.join(' '), /Approving this edit also creates an in-memory Velorn safety checkpoint/)
  assert.ok(f.approvals[0].preview)
  const duplicate = await f.session.callTool('add_timeline_markers', args)
  assert.equal(duplicate.isError, true)
  assert.match(text(duplicate), /already dispatched/)
  assert.equal(f.dispatches.filter(call => call.name === 'add_timeline_markers' && call.args.previewOnly === false).length, 1)
  assert.equal(f.dispatches.filter(call => call.name === 'create_project_checkpoint' && call.args.previewOnly === false).length, 1)
})

test('semantic marker aliases cannot repeat an applied write', async () => {
  const f = await fixture({ session: { autoApproveEdits: true } })
  const first = await f.session.callTool('add_timeline_markers', {
    timeSeconds: 3, label: 'Review', color: '#ff8800', previewOnly: false,
  })
  assert.equal(first.isError, undefined)
  const repeated = await f.session.callTool('add_timeline_markers', {
    markers: [{ time: 3, name: 'Review', color: '#ff8800' }], previewOnly: false,
  })
  assert.equal(repeated.isError, true)
  assert.match(text(repeated), /already dispatched/)
  assert.equal(f.dispatches.filter(call => call.name === 'add_timeline_markers' && call.args.previewOnly === false).length, 1)
})

test('a declined edit never applies, regardless of model-supplied approval fields', async () => {
  const f = await fixture({ approval: () => false })
  const r = await f.session.callTool('add_track', { previewOnly: false, approved: true, approval: 'user said yes' })
  assert.equal(r.isError, true)
  assert.match(text(r), /declined/)
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.dispatches[0].args.previewOnly, true)
  assert.ok(f.events.some(event => event.status === 'denied'))
})

test('uses existing one-use preview token and frozen suggested operands unchanged', async () => {
  const f = await fixture({ execute: (name, args, guard) => args.previewOnly
    ? result({ previewOnly: true, result: { suggestedApplyPayload: {
      operation: 'update_board', patch: { title: 'Frozen plan' }, previewToken: 'one-use-token',
      expectedContext: guard.context, previewOnly: false,
    } } }) : result({ success: true, applied: args }) })
  const r = await f.session.callTool('edit_storyboard', { operation: 'update_board', patch: { title: 'Frozen plan' }, previewOnly: false })
  assert.equal(r.isError, undefined)
  assert.equal(f.dispatches[1].args.previewToken, 'one-use-token')
  assert.deepEqual(f.dispatches[1].args.expectedContext, f.guard().context)
  assert.equal(f.approvals[0].arguments.previewToken, 'one-use-token')
})

test('actual legacy project wrappers can report outer success:false for a valid nested preview', async () => {
  for (const name of ['create_project', 'duplicate_project']) {
    const rendererCalls = []
    const server = createComfyStudioMcpServer({ performAction: async ({ action, payload }) => {
      rendererCalls.push({ action, payload })
      return payload.previewOnly ? { previewOnly: true, action, plan: { name: 'Synthetic project' } }
        : { success: true, action }
    } })
    server.updateSnapshot({ project: { name: 'Synthetic', path: '/synthetic' }, currentTimeline: { id: 't', tracks: [], clips: [] }, assets: [] })
    const f = await fixture({ server, execute: (tool, args) => server.callTool(tool, args) })
    const r = await f.session.callTool(name, { name: 'Synthetic project', previewOnly: false })
    assert.equal(r.isError, undefined, name)
    assert.equal(JSON.parse(text(r)).success, true, name)
    assert.equal(f.approvals.length, 1, name)
    assert.deepEqual(rendererCalls.map(call => call.payload.previewOnly), [true, false], name)
  }
})

test('failed inner previews and explicit invalid plans remain failures despite previewOnly', async () => {
  for (const detail of [
    { success: false, previewOnly: true, invalidSteps: ['bad-tool'] },
    { success: false, result: { previewOnly: true, success: false, error: 'invalid project' } },
    { success: false, result: { previewOnly: true, error: 'invalid project' } },
  ]) {
    const f = await fixture({ execute: () => result(detail) })
    await f.session.callTool('create_project', { name: 'Synthetic project', previewOnly: false })
    assert.equal(f.approvals.length, 0)
    assert.equal(f.dispatches.length, 1)
  }
})

test('full guard rejects revision, selection and playhead changes during approval', async () => {
  for (const mutate of [
    guard => { guard.context.revision += 1 },
    guard => { guard.selection.clipIds = ['different-clip'] },
    guard => { guard.playhead += 1 },
    guard => { guard.context.storyboardRevision += 1 },
  ]) {
    const f = await fixture({ approval: (_, guard) => { mutate(guard); return true } })
    const r = await f.session.callTool('add_track', { previewOnly: false })
    assert.equal(r.isError, true)
    assert.match(text(r), /changed while approval/)
    assert.equal(f.dispatches.length, 1)
  }
})

test('a changed context during preview cannot produce an approved stale plan', async () => {
  const f = await fixture({ execute: (_, args, __, guard) => {
    guard.playhead += 1
    return result({ previewOnly: args.previewOnly })
  } })
  const r = await f.session.callTool('add_track', { previewOnly: false })
  assert.equal(r.isError, true)
  assert.match(text(r), /changed during preview/)
  assert.equal(f.approvals.length, 0)
  assert.equal(f.dispatches.length, 1)
})

test('rejects a stale supplied context and foreign initial project before dispatch', async () => {
  const f = await fixture()
  const r = await f.session.callTool('trim_clips', { previewOnly: false, expectedContext: { ...context(), revision: 1 } })
  assert.equal(r.isError, true)
  assert.equal(f.dispatches.length, 0)
  await assert.rejects(() => fixture({ session: { expectedContext: { ...context(), projectKey: 'foreign-project' } } }), /different project/)
  await assert.rejects(() => fixture({ session: { getContext: async () => ({}) } }), /unavailable/)
})

test('external project or timeline navigation invalidates the entire session', async () => {
  const f = await fixture()
  f.guard().context.timelineId = 'different-timeline'
  const r = await f.session.callTool('get_timeline')
  assert.equal(r.isError, true)
  assert.equal(f.dispatches.length, 0)
  assert.equal((await f.session.callTool('add_track')).isError, true)
})

test('navigation without an exact native completion returns its result then closes tool authority', async () => {
  const f = await fixture({ execute: (_, args, __, guard) => {
    if (args.previewOnly) return result({ previewOnly: true })
    guard.context.timelineId = 'new-timeline'
    return result({ success: true, timelineId: 'new-timeline' })
  } })
  const r = await f.session.callTool('switch_timeline', { timelineId: 'new-timeline', previewOnly: false })
  assert.equal(r.isError, undefined)
  assert.match(text(r), /new-timeline/)
  assert.equal((await f.session.callTool('get_timeline')).isError, true)
  assert.equal(f.dispatches.length, 2)
})

test('confirmed same-project timeline navigation continues in all permission modes', async () => {
  for (const session of [{}, { autoApproveEdits: true }]) {
    for (const name of ['switch_timeline', 'create_timeline', 'duplicate_timeline']) {
      const scope = createAgentDispatchScope()
      const f = await fixture({ session, execute: async (tool, args, supplied, guard) => {
        if (args.previewOnly) return result({ previewOnly: true })
        if (tool !== name) return result({ success: true })
        return scope.runTool(supplied, null, async () => {
          Object.assign(guard.context, { timelineId: 'new-timeline', timelineSessionId: 9, revision: 3 })
          scope.complete(scope.current(), { success: true, agentContext: guard }, tool)
          return result({ success: true, action: tool, result: { switched: true,
            created: tool === 'create_timeline', duplicated: tool === 'duplicate_timeline',
            timeline: { id: 'new-timeline' }, currentTimelineId: 'new-timeline' } })
        })
      } })
      const args = { timelineId: name === 'switch_timeline' ? 'new-timeline' : 'timeline-one', switchToTimeline: true, previewOnly: false }
      assert.equal((await f.session.callTool(name, args)).isError, undefined)
      assert.equal((await f.session.callTool('get_timeline')).isError, undefined)
      assert.equal((await f.session.callTool('add_text_clip', { text: 'Test', previewOnly: false })).isError, undefined)
      assert.equal(f.dispatches.at(-1).guard.context.timelineId, 'new-timeline')
      assert.equal(f.approvals.length, session.trustedFullAccess ? 0 : 2, 'Existing approval policy remains intact')
      f.guard().context.timelineId = 'manually-selected'
      assert.equal((await f.session.callTool('get_timeline')).isError, true)
    }
  }
})

test('navigation cannot adopt failed, mismatched, concurrent or cross-project state changes', async () => {
  for (const scenario of ['failed', 'wrong-target', 'project', 'renderer', 'compound', 'concurrent-edit', 'wrong-action', 'preview', 'not-switched', 'no-activation', 'unrelated-tool']) {
    const scope = createAgentDispatchScope()
    const name = scenario === 'no-activation' ? 'create_timeline' : scenario === 'unrelated-tool' ? 'add_track' : 'switch_timeline'
    const f = await fixture({ session: {}, execute: async (tool, args, supplied, guard) => {
      if (args.previewOnly && scenario !== 'preview') return result({ previewOnly: true })
      return scope.runTool(supplied, null, async () => {
        Object.assign(guard.context, { timelineId: scenario === 'wrong-target' ? 'unexpected-timeline' : 'new-timeline', timelineSessionId: 9 })
        if (scenario === 'project') guard.context.projectKey = '/other/project'
        if (scenario === 'renderer') guard.context.session = 'another-renderer'
        if (scenario === 'compound') guard.context.compoundClipId = 'compound'
        scope.complete(scope.current(), { success: true, agentContext: guard }, scenario === 'wrong-action' ? 'open_project' : tool)
        if (scenario === 'concurrent-edit') guard.context.revision++
        return result({ success: scenario !== 'failed', action: tool, result: { created: true,
          previewOnly: args.previewOnly, switched: scenario !== 'not-switched', timeline: { id: guard.context.timelineId }, currentTimelineId: guard.context.timelineId } })
      })
    } })
    await f.session.callTool(name, { timelineId: 'new-timeline', previewOnly: scenario === 'preview', ...(scenario === 'no-activation' ? { switchToTimeline: false } : {}) })
    assert.equal((await f.session.callTool('get_timeline')).isError, true, scenario)
    assert.equal((await f.session.callTool('add_text_clip', { previewOnly: false })).isError, true, scenario)
  }
})

test('music status requires approval because it imports files and has no preview', async () => {
  for (const session of [{}, { autoApproveEdits: true }]) {
    const f = await fixture({ session, approval: () => false })
    const r = await f.session.callTool('get_music_generation_status', { previewOnly: true })
    assert.equal(r.isError, true)
    assert.equal(f.dispatches.length, 0)
    assert.match(f.approvals[0].warnings.join(' '), /import completed music files/)
  }
})

test('music status keeps its side-effectful duplicate guard in every permission mode', async () => {
  for (const session of [{}, { autoApproveEdits: true }]) {
    const f = await fixture({ session })
    const args = { promptIds: ['music-one'] }
    assert.equal((await f.session.callTool('get_music_generation_status', args)).isError, undefined)
    const duplicate = await f.session.callTool('get_music_generation_status', args)
    assert.equal(duplicate.isError, true)
    assert.match(text(duplicate), /exact side-effectful action was already dispatched/)
    assert.equal(f.dispatches.length, 1)
    assert.equal(f.approvals.length, session.trustedFullAccess ? 0 : 1)
  }
})

test('stock and Generate workspace previews require approval before opening UI', async () => {
  for (const name of ['search_stock_media', 'import_stock_media',
    'get_music_video_session', 'get_music_video_plan', 'inspect_music_video_keyframe',
    'inspect_music_video_video', 'configure_music_video']) {
    const f = await fixture({ approval: () => false })
    const r = await f.session.callTool(name, { previewOnly: true })
    assert.equal(r.isError, true, name)
    assert.equal(f.dispatches.length, 0, name)
    assert.equal(f.approvals.length, 1, name)
  }
})

test('new unknown read-looking tools and their previews fail closed to approval', async () => {
  for (const name of ['get_future_dangerous_tool', 'get_future_generation_status']) {
    for (const preview of [false, true]) {
      const server = { tools: [definition(name, preview)] }
      const f = await fixture({ server, approval: () => false })
      const r = await f.session.callTool(name, { previewOnly: true })
      assert.equal(r.isError, true)
      assert.equal(f.dispatches.length, 0)
      assert.equal(f.approvals.length, 1)
    }
  }
})

test('audio status and interpolation inspection are reads; their mutations are not', async () => {
  const f = await fixture()
  await f.session.callTool('audio_ducking')
  await f.session.callTool('clip_interpolation', { operation: 'inspect', clipId: 'clip-one' })
  assert.equal(f.approvals.length, 0)
  await f.session.callTool('audio_ducking', { operation: 'cancel', jobId: 'job-one', previewOnly: false })
  assert.equal(f.approvals.length, 1)
  assert.equal(f.dispatches[2].args.previewOnly, true)
  assert.equal(f.dispatches[3].args.previewOnly, false)
})

test('without image opt-in, image readers receive metadata-only and media is stripped', async () => {
  const f = await fixture({ execute: () => ({ content: [
    { type: 'text', text: 'hello data:image/png;base64,YQ== and data:audio/wav;base64,YQ==' },
    { type: 'image', mimeType: 'image/png', data: 'YQ==' },
    { type: 'audio', mimeType: 'audio/wav', data: 'YQ==' },
  ] }) })
  const r = await f.session.callTool('inspect_timeline_frame', { includeImage: true })
  assert.equal(f.approvals.length, 0)
  assert.equal(f.dispatches[0].args.includeImage, false)
  assert.equal(r.content.some(block => block.type !== 'text'), false)
  assert.doesNotMatch(text(r), /base64/)
  assert.match(text(r), /metadata only/)
})

test('image opt-in preserves bounded stills; live timeline capture still needs approval', async () => {
  const f = await fixture({ session: { allowImages: true }, execute: () => ({ content: [
    { type: 'text', text: '{"success":true}' }, { type: 'image', mimeType: 'image/jpeg', data: 'YQ==' },
    { type: 'audio', mimeType: 'audio/wav', data: 'YQ==' },
  ] }) })
  const r = await f.session.callTool('inspect_timeline_range')
  assert.equal(f.approvals.length, 1)
  assert.match(f.approvals[0].warnings.join(' '), /temporarily seek/)
  assert.equal(r.content.filter(block => block.type === 'image').length, 1)
  assert.equal(r.content.filter(block => block.type === 'audio').length, 0)
})

test('action-plan approval exposes nested generation risks and checkpoint overrides', async () => {
  const f = await fixture()
  const r = await f.session.callTool('run_mcp_action_plan', { previewOnly: false, createCheckpointFirst: false,
    stopOnError: false, steps: [{ tool: 'generate_music', arguments: { tags: 'test', durationSeconds: 3 } },
      { tool: 'export_timeline', arguments: { filename: 'test' } }] })
  assert.equal(r.isError, undefined)
  const warnings = f.approvals[0].warnings.join(' ')
  assert.match(warnings, /Step 1.*spend cloud credits/)
  assert.match(warnings, /Step 2.*writes delivery files/)
  assert.match(warnings, /disables its safety checkpoint/)
  assert.match(warnings, /continues after an error/)
})

test('nested action-plan images cannot bypass opt-in through arguments or JSON-text results', async () => {
  const f = await fixture({ execute: (_, args) => args.previewOnly
    ? result({ previewOnly: true })
    : result({ success: true, results: [{ result: { content: [{ type: 'image', mimeType: 'image/png', data: 'YQ==' }],
      frame: { mimeType: 'image/png', data: 'YWJj', timeSeconds: 3 }, audio: { type: 'audio', base64: 'ZGVm' } } }] }) })
  // Current MCP action plans reject image-reader steps. This test also protects
  // the adapter boundary if that native allowlist is expanded in the future.
  const r = await f.session.callTool('run_mcp_action_plan', { previewOnly: false,
    steps: [{ tool: 'inspect_timeline_frame', arguments: { includeImage: true } },
      { action: 'inspect_clip', payload: { clipId: 'clip-one', includeImage: true } }] })
  assert.equal(r.isError, undefined)
  assert.equal(f.dispatches[0].args.steps[0].arguments.includeImage, false)
  assert.equal(f.dispatches[0].args.steps[1].payload.includeImage, false)
  assert.doesNotMatch(text(r), /YQ==|YWJj|ZGVm/)
  assert.match(text(r), /timeSeconds/)
})

test('oversized text, images, blocks and arguments are bounded', async () => {
  const f = await fixture({ session: { allowImages: true, limits: { resultBytes: 64, imageBytes: 2, images: 1, contentBlocks: 3 } },
    execute: () => ({ content: [
      { type: 'text', text: 'x'.repeat(256) }, { type: 'image', mimeType: 'image/png', data: 'YWJj' },
      { type: 'image', mimeType: 'image/png', data: 'YQ==' }, { type: 'text', text: 'extra block' },
    ] }) })
  const r = await f.session.callTool('inspect_clip', { clipId: 'clip-one' })
  assert.equal(r.content[0].text.length, 64)
  assert.equal(r.content.filter(block => block.type === 'image').length, 1)
  assert.match(text(r), /truncated/)
  assert.match(text(r), /Additional tool content/)
  assert.equal((await f.session.callTool('get_project', { large: 'x'.repeat(LIMITS.argumentBytes) })).isError, true)
  assert.equal((await f.session.callTool('get_project', [])).isError, true)
  assert.equal((await f.session.callTool('get_project', { previewOnly: 'false' })).isError, true)
})

test('an execution exception or MCP mutation error blocks all further side effects, not inspection', async () => {
  for (const throwError of [true, false]) {
    const f = await fixture({ execute: (name, args) => {
      if (args.previewOnly) return result({ previewOnly: true })
      if (name === 'create_project_checkpoint') return result({ success: true, checkpointId: 'checkpoint-synthetic' })
      if (throwError) throw new Error('IPC completion lost after action')
      return { isError: true, content: [{ type: 'text', text: 'partial edit failed' }] }
    } })
    const r = await f.session.callTool('add_track', { previewOnly: false })
    assert.equal(r.isError, true)
    assert.equal((await f.session.callTool('add_track', { previewOnly: false })).isError, true)
    assert.equal((await f.session.callTool('add_timeline_markers', { previewOnly: false })).isError, true)
    assert.deepEqual(f.dispatches.map(call => [call.name, call.args.previewOnly]), [
      ['add_track', true], ['create_project_checkpoint', true], ['create_project_checkpoint', false], ['add_track', false],
    ])
    await f.session.callTool('get_timeline')
    assert.equal(f.dispatches.length, 5)
  }
})

test('a failed or unconfirmed preview never falls through to an apply', async () => {
  for (const preview of [{ content: [{ type: 'text', text: 'not a dry-run confirmation' }] }, result({ success: false })]) {
    const f = await fixture({ execute: () => preview })
    const r = await f.session.callTool('add_track', { previewOnly: false })
    assert.equal(f.dispatches.length, 1)
    assert.equal(f.approvals.length, 0)
    assert.ok(r.isError || JSON.parse(text(r)).success === false)
  }
})

test('a future tool that ignores previewOnly is halted even when only a preview was requested', async () => {
  const server = { tools: [definition('new_unreviewed_writer')] }
  const f = await fixture({ server, execute: () => result({ success: true, changed: true }) })
  const r = await f.session.callTool('new_unreviewed_writer', { previewOnly: true })
  assert.equal(r.isError, true)
  assert.match(text(r), /did not confirm a dry-run/)
  assert.equal(f.approvals.length, 1)
  assert.equal(f.dispatches.length, 1)
  assert.equal((await f.session.callTool('new_unreviewed_writer', { previewOnly: false })).isError, true)
  assert.equal(f.dispatches.length, 1)
})

test('malformed completion is uncertain, and exception text cannot exceed error bounds', async () => {
  const f = await fixture({ execute: (name, args) => args.previewOnly ? result({ previewOnly: true })
    : name === 'create_project_checkpoint' ? result({ success: true, checkpointId: 'checkpoint-synthetic' }) : null })
  const r = await f.session.callTool('add_track', { previewOnly: false })
  assert.equal(r.isError, true)
  assert.match(text(r), /invalid result/)
  assert.equal((await f.session.callTool('add_track', { previewOnly: false })).isError, true)
  assert.equal(f.dispatches.length, 4)
  assert.equal(f.dispatches.filter(call => call.name === 'add_track' && call.args.previewOnly === false).length, 1)
  const huge = await fixture({ execute: () => { throw new Error('x'.repeat(10000)) } })
  assert.ok(Buffer.byteLength(text(await huge.session.callTool('get_project'))) <= 4096)
})

test('cancellation during approval prevents apply and queued calls', async () => {
  let entered
  const ready = new Promise(resolve => { entered = resolve })
  const f = await fixture({ approval: () => { entered(); return new Promise(() => {}) } })
  const pending = f.session.callTool('add_track', { previewOnly: false })
  await ready
  const queued = f.session.callTool('get_timeline')
  f.abort.abort()
  assert.equal((await pending).isError, true)
  assert.equal((await queued).isError, true)
  assert.equal(f.dispatches.length, 1)
})

test('calls are serialized across approval and apply, and the per-turn limit is enforced', async () => {
  let accept, entered
  const ready = new Promise(resolve => { entered = resolve })
  const f = await fixture({ session: { limits: { calls: 2 } }, approval: () => { entered(); return new Promise(resolve => { accept = resolve }) } })
  const first = f.session.callTool('add_track', { previewOnly: false })
  await ready
  const second = f.session.callTool('get_timeline')
  assert.equal(f.dispatches.length, 1)
  accept(true)
  await Promise.all([first, second])
  assert.deepEqual(f.dispatches.map(call => call.name), ['add_track', 'create_project_checkpoint', 'create_project_checkpoint', 'add_track', 'get_timeline'])
  assert.equal((await f.session.callTool('get_project')).isError, true)
  assert.equal(f.dispatches.length, 5)
})

test('approved asynchronous execution is never retried after a bounded timeout', async () => {
  const f = await fixture({ session: { limits: { operationTimeoutMs: 10 } },
    execute: (name, args) => args.previewOnly ? result({ previewOnly: true })
      : name === 'create_project_checkpoint' ? result({ success: true, checkpointId: 'checkpoint-synthetic' }) : new Promise(() => {}) })
  assert.equal((await f.session.callTool('add_track', { previewOnly: false })).isError, true)
  const again = await f.session.callTool('add_track', { previewOnly: false })
  assert.equal(again.isError, true)
  assert.match(text(again), /did not return a confirmed result/)
  assert.equal(f.dispatches.length, 4)
  assert.equal(f.dispatches.filter(call => call.name === 'add_track' && call.args.previewOnly === false).length, 1)
})
