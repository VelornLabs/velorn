import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { assertMcpActionAllowedDuringExport, isMcpActionAllowedDuringExport } from '../electron/exportPriorityPolicy.mjs'
import { createMcpExportController } from '../src/services/mcpExportController.mjs'
import { assertAssetRemovalAllowsMcp, claimAssetRemoval } from '../src/services/assetRemovalPlan.mjs'

const require = createRequire(import.meta.url)
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const renderer = fs.readFileSync(new URL('../src/services/mcpActions.js', import.meta.url), 'utf8')
const dispatchSource = renderer.slice(renderer.indexOf('async function handleMcpAction('), renderer.indexOf('export async function runMcpAction('))
const tick = () => new Promise(resolve => setImmediate(resolve))
const snapshot = { schemaVersion: 2, project: { name: 'Synthetic' }, assets: [], timelines: [],
  currentTimeline: { id: 'timeline', clips: [], tracks: [], transitions: [] } }

test('editing, Undo, transport, project switches and generation all wait for export, including previews', () => {
  for (const action of ['undo', 'redo', 'undo_redo', 'set_playhead', 'select_clips', 'open_project', 'create_project',
    'switch_timeline', 'open_compound', 'set_clip_style', 'set_clip_color', 'edit_source', 'trim_clips',
    'update_caption_cues', 'set_clip_audio', 'create_compound', 'generate_music', 'queue_h3_reference_video',
    'queue_prepared_generation', 'install_workflow_setup', 'import_asset_from_path', 'repair_comfyui_connection',
    'control_comfyui_launcher', 'request_comfy_cloud_setup', 'export_timeline', 'export_delivery_batch', 'run_mcp_action_plan']) {
    for (const previewOnly of [true, false]) {
      assert.throws(() => assertMcpActionAllowedDuringExport(action, { previewOnly }, true),
        error => error.code === 'EXPORT_IN_PROGRESS' && /get_export_status/.test(error.message), action)
    }
  }
  assert.equal(isMcpActionAllowedDuringExport('control_transport', { operation: 'play' }), false)
  assert.equal(isMcpActionAllowedDuringExport('control_transport', { operation: 'step' }), false)
})

test('lightweight inspection and export cancellation stay available', () => {
  for (const action of ['get_project', 'get_timeline', 'get_assets', 'get_transport_state', 'get_caption_status',
    'get_workflow_install_status', 'get_generation_status', 'get_generation_queue_status', 'get_comfyui_runs', 'inspect_comfyui_run', 'inspect_clip_audio', 'inspect_clip_effects',
    'inspect_compound', 'list_export_presets', 'get_export_status', 'cancel_export', 'get_comfy_cloud_setup_status']) {
    assert.doesNotThrow(() => assertMcpActionAllowedDuringExport(action, {}, true), action)
  }
  assert.equal(isMcpActionAllowedDuringExport('control_transport', { operation: 'pause' }), true)
  assert.equal(isMcpActionAllowedDuringExport('control_export_batch', { operation: 'pause' }), true)
  assert.equal(isMcpActionAllowedDuringExport('control_export_batch', { operation: 'cancel', previewOnly: false }), true)
  assert.equal(isMcpActionAllowedDuringExport('control_export_batch', { operation: 'resume', previewOnly: true }), false)
})

test('read-like tools that decode, import or probe media are not assumed harmless', () => {
  for (const action of ['get_music_generation_status', 'get_audio_analysis',
    'inspect_export_file', 'check_export_readiness', 'inspect_timeline_frame', 'inspect_timeline_range', 'list_fonts']) {
    assert.equal(isMcpActionAllowedDuringExport(action, { previewOnly: true }), false, action)
  }
  for (const action of ['inspect_clip', 'inspect_source_frame', 'inspect_edit_point', 'inspect_visible_shots']) {
    assert.equal(isMcpActionAllowedDuringExport(action, {}), false, action)
    assert.equal(isMcpActionAllowedDuringExport(action, { includeImage: true }), false, action)
    assert.equal(isMcpActionAllowedDuringExport(action, { includeImage: false }), true, action)
  }
})

test('mixed-purpose tools only admit explicit cheap operations', () => {
  for (const [action, allowed, blocked] of [
    ['audio_ducking', ['status', 'cancel'], ['analyze', 'apply', 'unknown']],
    ['clip_interpolation', ['inspect', 'cancel'], ['set', 'build', 'unknown']],
  ]) {
    for (const operation of allowed) assert.equal(isMcpActionAllowedDuringExport(action, { operation }), true)
    for (const operation of blocked) assert.equal(isMcpActionAllowedDuringExport(action, { operation, previewOnly: true }), false)
  }
})

test('unknown future actions fail closed; normal editing is unaffected after export ends', () => {
  for (const action of ['future_expensive_tool', 'get_future_decoder', '', undefined]) {
    assert.equal(isMcpActionAllowedDuringExport(action, { previewOnly: true }), false)
    assert.throws(() => assertMcpActionAllowedDuringExport(action, {}, true), /Export is in progress/)
    assert.doesNotThrow(() => assertMcpActionAllowedDuringExport(action, {}, false))
  }
})

test('real renderer dispatch rejects before parity, legacy, context or preview handlers run', async () => {
  let busy = true, calls = 0
  const handle = vm.runInNewContext(`${dispatchSource}\nhandleMcpAction`, {
    isExportBusy: () => busy, assertMcpActionAllowedDuringExport, assertAssetRemovalAllowsMcp,
    MCP_PARITY_ACTIONS: { set_clip_color: async () => { calls++; return { success: true } },
      get_export_status: async () => { calls++; return { activeJobId: 'job' } } },
    assertMcpContext: () => { calls++ }, captureMcpContext: () => ({}),
    handleUndoRedo: () => { calls++; return { success: true } },
    handleSetPlayhead: () => { calls++; return { success: true } },
  })
  for (const action of ['set_clip_color', 'undo', 'set_playhead']) {
    await assert.rejects(handle({ action, payload: { previewOnly: true } }), /Export is in progress/)
  }
  assert.equal(calls, 0)
  assert.equal((await handle({ action: 'get_export_status' })).activeJobId, 'job')
  busy = false
  assert.equal((await handle({ action: 'set_clip_color' })).success, true)
  assert.equal((await handle({ action: 'undo' })).success, true)
})

test('native-only routes are gated before side effects or preview work, while lightweight Reads still dispatch', async () => {
  let busy = true, launcherCalls = 0, dispatched = [], runCalls = []
  const server = createComfyStudioMcpServer({ isExportBusy: () => busy,
    controlComfyLauncher: async () => { launcherCalls++; return { success: true } },
    generationRuns: {
      list: async args => { runCalls.push(['list', args]); return { success: true, runs: [] } },
      recipe: async args => { runCalls.push(['recipe', args]); return { success: true, runId: args.runId, redacted: true } },
      submit: async args => { runCalls.push(['submit', args]); return { success: true, previewOnly: args.previewOnly } },
      adopt: async args => { runCalls.push(['adopt', args]); return { success: true, previewOnly: args.previewOnly } },
      control: async args => { runCalls.push(['control', args]); return { success: true, previewOnly: args.previewOnly } },
    },
    performAction: async request => { dispatched.push(request); return { success: true, action: request.action } } })
  server.updateSnapshot(snapshot)
  for (const action of ['control_comfyui_launcher', 'repair_comfyui_connection', 'guide_comfyui_setup',
    'queue_h3_reference_video', 'install_workflow_setup', 'set_clip_color', 'undo', 'run_mcp_action_plan',
    'get_music_generation_status', 'export_timeline', 'future_tool', 'queue_comfyui_workflow',
    'track_comfyui_prompt', 'control_comfyui_run', 'import_comfyui_run_outputs']) {
    const result = await server.callTool(action, { command: 'start', previewOnly: true })
    assert.equal(result.isError, true, action)
    assert.match(result.content[0].text, /Export is in progress/, action)
  }
  assert.equal(launcherCalls, 0); assert.equal(dispatched.length, 0)
  assert.equal((await server.callTool('get_project')).isError, undefined)
  assert.equal((await server.callTool('get_generation_queue_status')).isError, undefined)
  assert.equal((await server.callTool('get_comfyui_runs', { includeOtherProjects: true })).isError, undefined)
  assert.equal((await server.callTool('inspect_comfyui_run', { runId: 'run-one', includeOtherProjects: true })).isError, undefined)
  assert.equal((await server.callTool('get_export_status')).isError, undefined)
  assert.equal((await server.callTool('cancel_export', { jobId: 'job', previewOnly: false })).isError, undefined)
  assert.equal((await server.callTool('control_export_batch', { batchId: 'batch', operation: 'cancel', previewOnly: false })).isError, undefined)
  assert.deepEqual(dispatched.map(request => request.action), ['get_generation_queue_status', 'get_export_status', 'cancel_export', 'control_export_batch'])
  assert.deepEqual(runCalls, [
    ['list', { includeOtherProjects: true }],
    ['recipe', { runId: 'run-one', includeOtherProjects: true }],
  ])
  busy = false
  assert.equal((await server.callTool('get_music_generation_status')).isError, undefined)
  assert.equal(dispatched.at(-1).action, 'get_music_generation_status')
})

test('real renderer dispatch keeps new edits out of a pending asset-removal transaction', async () => {
  let calls = 0
  const handle = vm.runInNewContext(`${dispatchSource}\nhandleMcpAction`, {
    isExportBusy: () => false, assertMcpActionAllowedDuringExport, assertAssetRemovalAllowsMcp,
    MCP_PARITY_ACTIONS: { set_clip_color: async () => { calls++; return { success: true } } },
    assertMcpContext: () => {}, captureMcpContext: () => ({}),
    handleUndoRedo: () => { calls++; return { success: true } },
  })
  const release = claimAssetRemoval()
  try {
    for (const action of ['set_clip_color', 'undo', 'open_project', 'get_music_generation_status']) {
      await assert.rejects(handle({ action }), { code: 'ASSET_REMOVAL_IN_PROGRESS' })
    }
    assert.equal(calls, 0)
  } finally { release() }
  assert.equal((await handle({ action: 'set_clip_color' })).success, true)
  assert.equal(calls, 1)
})

test('approved batch continuation does not re-enter external MCP guards between targets', async () => {
  let active = null, starts = 0
  const jobs = [], info = { width: 1920, height: 1080, fps: 24, duration: 1 }
  const api = { pathJoin: async (...parts) => parts.join('/'), exists: async () => false,
    createDirectory: async () => ({ success: true }),
    getExportJobs: async () => ({ activeJobId: active, jobs }),
    runExportInWorker: async request => {
      active = request.jobId; starts++
      jobs.push({ jobId: active, owner: 'mcp', status: 'running' })
      return { started: true, jobId: active }
    } }
  const controller = createMcpExportController({
    getProject: () => ({ currentProject: { name: 'Synthetic', settings: info }, currentProjectHandle: '/synthetic', getCurrentTimelineSettings: () => info }),
    getTimeline: () => ({ clips: [{ id: 'text', type: 'text', startTime: 0, duration: 1, trackId: 'v1' }], tracks: [{ id: 'v1', type: 'video' }], transitions: [], getTimelineEndTime: () => 1 }),
    getAssets: () => ({ assets: [] }), getApi: () => api, captureContext: () => ({}), assertContext: () => {},
    storage: { getItem: () => null, setItem() {} },
    sleep: async () => { jobs.find(job => job.jobId === active).status = 'completed'; active = null; await tick() },
  })
  const result = await controller.export_delivery_batch({ targets: ['h264_hd', 'h264_square_1080'], previewOnly: false })
  let status
  for (let count = 0; count < 50; count++) {
    status = await controller.get_export_status({ batchId: result.batchId })
    if (status.status === 'completed') break
    await tick()
  }
  assert.equal(starts, 2)
  assert.equal(status.status, 'completed')
  assert.deepEqual(status.targets.map(item => item.status), ['completed', 'completed'])
})
