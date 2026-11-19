import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { resolveMcpExportPlan } from '../src/utils/mcpExportPlan.mjs'
import { createMcpExportController } from '../src/services/mcpExportController.mjs'
const require = createRequire(import.meta.url)
const { ExportJobRegistry } = require('../electron/exportJobRegistry.cjs')
const { inspectExportFileNative } = require('../electron/exportFileInspection.cjs')
const { tools, writableTools } = require('../electron/mcpExportTools.cjs')
const timeline = { width: 1920, height: 1080, fps: 24, duration: 8, inPoint: 2, outPoint: 5 }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate) { for (let n = 0; n < 100; n++) { if (await predicate()) return; await tick() } assert.fail('Expected checkpoint was not reached') }

test('resolves all six UI formats with compatible codecs and truthful alpha/audio semantics', () => {
  for (const [format, extension, codec, audio] of [['mp4', 'mp4', 'h264', 'aac'], ['webm', 'webm', 'vp9', 'opus'],
    ['prores', 'mov', 'prores', 'aac'], ['audio', 'wav', 'h264', 'wav'], ['png-seq', '', null, null], ['gif', 'gif', null, null]]) {
    const plan = resolveMcpExportPlan({ format }, timeline)
    assert.equal(plan.extension, extension); assert.equal(plan.options.videoCodec, codec); assert.equal(plan.options.audioCodec, audio)
    if (['gif', 'png-seq'].includes(format)) assert.equal(plan.options.includeAudio, false)
  }
  assert.equal(resolveMcpExportPlan({ format: 'prores', transparent: true }, timeline).settings.proresProfile, '4')
  assert.throws(() => resolveMcpExportPlan({ format: 'mp4', transparent: true }, timeline), /not supported/)
  assert.throws(() => resolveMcpExportPlan({ format: 'webm', videoCodec: 'h264' }, timeline), /WebM presets require/)
})

test('delivery presets, custom presets and validated overrides match UI algorithms', () => {
  const small = { ...timeline, width: 1280, height: 720 }
  const youtube = resolveMcpExportPlan({ presetId: 'youtube-4k' }, small)
  assert.equal(youtube.options.width, 1280); assert.equal(youtube.options.bitrateKbps, 5000)
  assert.equal(resolveMcpExportPlan({ presetId: 'review-copy' }, timeline).options.width, 960)
  assert.equal(resolveMcpExportPlan({ presetId: 'small-h265' }, timeline).options.videoCodec, 'h265')
  assert.equal(resolveMcpExportPlan({ presetId: 'proxy-review' }, timeline).options.crf, 23)
  const custom = [{ id: 'user-export-example', name: 'Test', settings: { format: 'mp4', crf: 20, resolution: 'project' } }]
  assert.equal(resolveMcpExportPlan({ presetId: custom[0].id, overrides: { crf: 17 } }, timeline, custom).options.crf, 17)
  assert.throws(() => resolveMcpExportPlan({ presetId: 'missing' }, timeline), /not found/)
  assert.throws(() => resolveMcpExportPlan({ overrides: { notASetting: 1 } }, timeline), /Unsupported/)
  assert.throws(() => resolveMcpExportPlan({ crf: -1 }, timeline), /valid crf/)
})

test('RTX preview distinguishes source render size from final delivery and rejects non-video routes', () => {
  const plan = resolveMcpExportPlan({ presetId: 'h264-master', postProcessUpscale: 'rtx-4k' }, timeline)
  assert.equal(plan.options.width, 1920)
  assert.equal(plan.finalDelivery.width, 3840)
  assert.equal(plan.finalDelivery.height, 2160)
  assert.throws(() => resolveMcpExportPlan({ format: 'gif', postProcessUpscale: 'rtx-4k' }, timeline), /do not support/)
})

test('legacy targets/resolutions/aspect/framing/start/end and non-preset FPS remain supported', () => {
  const plan = resolveMcpExportPlan({ target: 'h264_square_720', range: 'custom', startSeconds: 1, endSeconds: 3, fps: 29.97 }, timeline)
  assert.equal(plan.options.width, 720); assert.equal(plan.options.height, 720); assert.equal(plan.options.deliveryFraming, 'fill')
  assert.equal(plan.options.rangeStart, 1); assert.equal(plan.options.rangeEnd, 3); assert.equal(plan.options.fps, 29.97)
  assert.equal(resolveMcpExportPlan({ resolution: 'vertical_720' }, timeline).options.width, 720)
  assert.equal(resolveMcpExportPlan({ resolution: 'timeline_half' }, timeline).options.width, 960)
  assert.equal(resolveMcpExportPlan({ aspectRatio: '9:16' }, timeline).options.height, 1920)
  assert.equal(resolveMcpExportPlan({ width: 1000, height: 500 }, timeline).options.width, 1000)
  assert.throws(() => resolveMcpExportPlan({ fps: 0 }, timeline), /FPS/)
})

test('range full is explicit, In/Out uses marks, custom requires a real frame', () => {
  assert.equal(resolveMcpExportPlan({ range: 'full' }, timeline).options.rangeStart, 0)
  const range = resolveMcpExportPlan({ range: 'inout' }, timeline)
  assert.equal(range.options.rangeStart, 2); assert.equal(range.options.rangeEnd, 5)
  assert.throws(() => resolveMcpExportPlan({ range: 'inout' }, { ...timeline, inPoint: null }), /both/)
  assert.throws(() => resolveMcpExportPlan({ range: 'custom', rangeStart: 2, rangeEnd: 1 }, timeline), /increasing/)
  assert.throws(() => resolveMcpExportPlan({ range: 'custom', rangeStart: 1, rangeEnd: 1.001 }, timeline), /one output frame/)
  assert.throws(() => resolveMcpExportPlan({ range: 'custom', rangeEnd: NaN }, timeline), /finite/)
})

test('native registry ownership and terminal deduplication never clobber a newer job', () => {
  const jobs = new ExportJobRegistry()
  jobs.begin({ jobId: 'ui', owner: 'ui', senderId: 5 })
  assert.throws(() => jobs.requestCancel('ui', 5), /not owned/)
  assert.throws(() => jobs.begin({ jobId: 'second' }), /in progress/)
  jobs.finish('ui', { result: { outputPath: '/a' } })
  jobs.begin({ jobId: 'mcp', owner: 'mcp', senderId: 7 })
  assert.equal(jobs.finish('ui', { error: 'late crash' }), false)
  assert.equal(jobs.activeId, 'mcp')
  assert.equal(jobs.progress('ui', { progress: 50 }), false)
  assert.throws(() => jobs.requestCancel('mcp', 8), /not owned/)
  assert.equal(jobs.requestCancel('mcp', 7).cancelRequested, true)
  jobs.finish('mcp', { error: 'Export cancelled' })
  assert.equal(jobs.get('mcp').status, 'cancelled')
  assert.equal(jobs.activeId, null)
  assert.equal(jobs.requestCancel('mcp', 7).cancelRequested, false)
})

test('native registry reports real failures and retains bounded terminal history', () => {
  const registry = new ExportJobRegistry({ limit: 2 })
  for (let i = 0; i < 3; i++) { registry.begin({ jobId: `${i}` }); registry.finish(`${i}`, { error: 'Renderer crashed' }) }
  assert.equal(registry.list().length, 2)
  assert.equal(registry.get('2').status, 'failed')
  assert.equal(registry.get('0'), null)
})

function harness(options = {}) {
  const native = new ExportJobRegistry()
  const calls = { starts: [], directories: [], writes: 0, cancels: [] }
  let revision = 1
  let stored = null
  const project = { currentProject: { name: 'Synthetic', settings: timeline }, currentProjectHandle: '/synthetic/project', getCurrentTimelineSettings: () => timeline }
  const state = { clips: [{ id: 'text', type: 'text', startTime: 0, duration: 8, trackId: 'v1' }],
    tracks: [{ id: 'v1', type: 'video' }], transitions: [], timelineFps: 24, masterAudioVolume: 50, masterAudioInserts: [{ id: 'eq' }],
    inPoint: 2, outPoint: 5, getTimelineEndTime: () => 8 }
  const api = { platform: 'linux', pathJoin: async (...parts) => path.join(...parts), exists: async () => false,
    createDirectory: async folder => { calls.directories.push(folder) },
    getExportJobs: async () => ({ jobs: native.list(), activeJobId: native.activeId }),
    runExportInWorker: async payload => {
      calls.starts.push(payload)
      native.begin({ ...payload, senderId: 1 })
      return { started: true, jobId: payload.jobId }
    },
    cancelExportJob: async jobId => { calls.cancels.push(jobId); return native.requestCancel(jobId, 1) },
    inspectExportFileNative: async payload => payload,
  }
  const actions = createMcpExportController({ getProject: () => project, getTimeline: () => state,
    getAssets: () => ({ assets: [] }), getApi: () => api, captureContext: () => ({ revision }),
    assertContext: expected => { if (expected && expected.revision !== revision) throw new Error('changed after preview') },
    storage: { getItem: () => stored, setItem: (_, value) => { stored = value; calls.writes++ } }, sleep: tick,
    ...options })
  return { actions, api, calls, native, state, project, change: () => { revision++ } }
}

test('all writes default to preview; text-only readiness uses advisory UI engine', async () => {
  const h = harness()
  const preview = await h.actions.export_timeline({ presetId: 'h264-master' })
  assert.equal(preview.previewOnly, true)
  assert.equal(h.calls.starts.length, 0); assert.equal(h.calls.directories.length, 0)
  assert.equal(preview.plan.readiness.blocked, false)
  const readiness = await h.actions.check_export_readiness({ includeAudio: false })
  assert.equal(readiness.advisory, true)
  assert.equal(readiness.warnings.some(w => w.code === 'picture-gap'), false)
  assert.equal(readiness.warnings.some(w => w.code === 'no-audio'), false)
  const preset = h.actions.save_export_preset({ name: 'Test', settings: { format: 'mp4' } })
  assert.equal(preset.previewOnly, true); assert.equal(h.calls.writes, 0)
  assert.equal(h.actions.list_export_presets().builtIn.length, 10)
})

test('custom output parent is described in preview without creating it; native destination refusal survives to MCP', async () => {
  const h = harness(), outputPath = '/synthetic/project/exports/nested/review.mp4'
  const request = {outputPath,range:'custom',rangeStart:0,rangeEnd:3}
  const preview = await h.actions.export_timeline(request)
  assert.deepEqual(preview.plan.outputDirectories,[{path:'/synthetic/project/exports/nested',createOnApply:true}])
  assert.equal(h.calls.directories.length,0);assert.equal(h.calls.starts.length,0)
  const original = h.api.runExportInWorker
  h.api.runExportInWorker = async p => ({success:false,code:'EXPORT_NOT_STARTED',outcome:'not-started',workerStarted:false,
    phase:'destination',jobId:p.jobId,outputPath:p.outputPath,error:'Parent is not writable'})
  const result = await h.actions.export_timeline({...request,...preview.suggestedApplyPayload,previewOnly:false})
  assert.equal(result.success,false);assert.equal(result.started,false);assert.equal(result.workerStarted,false)
  assert.match(result.message,/fresh preview/)
  h.api.runExportInWorker = original
  const retry = await h.actions.export_timeline(request)
  assert.equal((await h.actions.export_timeline({...request,...retry.suggestedApplyPayload,previewOnly:false})).started,true)
  assert.equal(h.calls.starts[0].outputPath,outputPath)
})

test('uncorrelated or ambiguous native startup failures are not certified as safe export refusals', async () => {
  for (const patch of [{workerStarted:true},{jobId:'other'},{outputPath:'/other.mp4'},{code:'UNKNOWN'},{phase:'worker'}]) {
    const h = harness()
    h.api.runExportInWorker = async p => ({success:false,code:'EXPORT_NOT_STARTED',outcome:'not-started',workerStarted:false,
      phase:'destination',jobId:p.jobId,outputPath:p.outputPath,error:'Uncertain result',...patch})
    await assert.rejects(h.actions.export_timeline({previewOnly:false}),/Uncertain/)
  }
})

test('saved project and asynchronous stale-context guards block writes', async () => {
  const h = harness()
  h.project.currentProjectHandle = null
  await assert.rejects(h.actions.export_timeline({ previewOnly: false }), /saved project/)
  h.project.currentProjectHandle = '/synthetic/project'
  h.api.exists = async () => { h.change(); return false }
  await assert.rejects(h.actions.export_timeline({ previewOnly: false }), /changed/)
  assert.equal(h.calls.directories.length, 0); assert.equal(h.calls.starts.length, 0)
})

test('last asynchronous startup guard stops a changed project before mkdir/export', async () => {
  const h = harness()
  h.api.getExportJobs = async () => { h.change(); return { jobs: [], activeJobId: null } }
  await assert.rejects(h.actions.export_timeline({ previewOnly: false }), /changed/)
  assert.equal(h.calls.directories.length, 0); assert.equal(h.calls.starts.length, 0)
})

test('existing output paths and invalid extensions are rejected without writes', async () => {
  const h = harness()
  h.api.exists = async () => true
  await assert.rejects(h.actions.export_timeline({ outputPath: '/synthetic/existing.mp4', previewOnly: false }), /already exists/)
  await assert.rejects(h.actions.export_timeline({ outputPath: '/synthetic/bad.wav', format: 'mp4' }), /end in .mp4/)
  assert.equal(h.calls.directories.length, 0)
})

test('single export carries complete frozen authored state and reports job identity', async () => {
  const h = harness()
  const result = await h.actions.export_timeline({ format: 'prores', previewOnly: false })
  assert.equal(result.started, true)
  const payload = h.calls.starts[0]
  assert.equal(payload.jobId, result.jobId)
  assert.equal(payload.state.timeline.masterAudioVolume, 50)
  assert.equal(payload.state.timeline.masterAudioInserts[0].id, 'eq')
  h.state.clips[0].duration = 1
  assert.equal(payload.state.timeline.clips[0].duration, 8)
  h.native.finish(result.jobId, { result: { outputPath: result.outputPath } })
  assert.equal((await h.actions.get_export_status({ jobId: result.jobId })).job.status, 'completed')
})

test('open-compound exports use the active child dimensions and frame rate, not parent project settings', async () => {
  const h = harness()
  h.state.compoundEditContext = { compoundClipId: 'compound-1', compoundName: 'Portrait child',
    originalChildDocument: { width: 1080, height: 1920, fps: 60 } }
  h.state.getActiveDocumentData = () => ({ width: 1080, height: 1920, fps: 60, clips: h.state.clips })
  const result = await h.actions.export_timeline({ presetId: 'h264-master', previewOnly: false })
  assert.equal(result.plan.options.width, 1080)
  assert.equal(result.plan.options.height, 1920)
  assert.equal(result.plan.options.fps, 60)
  assert.equal(result.plan.options.sourceTimelineWidth, 1080)
  assert.equal(result.plan.activeDocument.kind, 'compound')
  assert.equal(h.calls.starts[0].state.timeline.timelineFps, 60)
  assert.equal(h.actions.list_export_presets().builtIn.find(p => p.id === 'youtube-1080p').settings.bitrateKbps, 12000)
  h.native.finish(result.jobId, { result: {} })
})

test('failed native destination preparation is returned without claiming a started render', async () => {
  const h = harness()
  h.api.runExportInWorker = async p => ({success:false,code:'EXPORT_NOT_STARTED',outcome:'not-started',workerStarted:false,
    phase:'destination',jobId:p.jobId,outputPath:p.outputPath,error:'Synthetic write denied'})
  const result = await h.actions.export_timeline({previewOnly:false})
  assert.equal(result.started,false);assert.match(result.error,/write denied/)
  assert.equal(h.calls.starts.length, 0)
})

test('batch waits for completion, freezes snapshot, and does not retry busy worker', async () => {
  const h = harness()
  const batch = await h.actions.export_delivery_batch({ targets: ['h264_720p', 'h264_square_720'], previewOnly: false })
  await until(() => h.calls.starts.length === 1)
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(h.calls.starts.length, 1)
  h.state.clips[0].duration = 3; h.change()
  h.native.finish(h.calls.starts[0].jobId, { result: {} })
  await until(() => h.calls.starts.length === 2)
  assert.equal(h.calls.starts[1].state.timeline.clips[0].duration, 8)
  h.native.finish(h.calls.starts[1].jobId, { result: {} })
  await until(async () => (await h.actions.get_export_status({ batchId: batch.batchId })).status === 'completed')
})

test('batch stops on failed job and preserves readable native failure', async () => {
  const h = harness()
  const batch = await h.actions.export_delivery_batch({ targets: ['h264_720p', 'h264_square_720'], previewOnly: false })
  await until(() => h.calls.starts.length === 1)
  h.native.finish(h.calls.starts[0].jobId, { error: 'Synthetic decode failure' })
  await until(async () => (await h.actions.get_export_status({ batchId: batch.batchId })).status === 'failed')
  assert.equal(h.calls.starts.length, 1)
  assert.match((await h.actions.get_export_status({ batchId: batch.batchId })).error, /decode failure/)
  assert.equal((await h.actions.get_export_status({ batchId: batch.batchId })).targets[1].status, 'skipped')
})

test('stopOnError false continues after cancelled target but never reports complete delivery success', async () => {
  const h = harness()
  const batch = await h.actions.export_delivery_batch({ targets: ['h264_720p', 'h264_square_720'], stopOnError: false, previewOnly: false })
  await until(() => h.calls.starts.length === 1)
  await h.actions.cancel_export({ jobId: h.calls.starts[0].jobId, previewOnly: false })
  h.native.finish(h.calls.starts[0].jobId, { error: 'Export cancelled' })
  await until(() => h.calls.starts.length === 2)
  h.native.finish(h.calls.starts[1].jobId, { result: {} })
  await until(async () => (await h.actions.get_export_status({ batchId: batch.batchId })).status === 'cancelled')
  const result = await h.actions.get_export_status({ batchId: batch.batchId })
  assert.deepEqual(result.targets.map(target => target.status), ['cancelled', 'completed'])
})

test('batch pause-after-current and explicit resume continue the remaining target', async () => {
  const h = harness()
  const batch = await h.actions.export_delivery_batch({ targets: ['h264_720p', 'h264_square_720'], previewOnly: false })
  await until(() => h.calls.starts.length === 1)
  await h.actions.control_export_batch({ batchId: batch.batchId, operation: 'pause', previewOnly: false })
  h.native.finish(h.calls.starts[0].jobId, { result: {} })
  await until(async () => (await h.actions.get_export_status({ batchId: batch.batchId })).status === 'paused')
  assert.equal(h.calls.starts.length, 1)
  await h.actions.control_export_batch({ batchId: batch.batchId, operation: 'resume', previewOnly: false })
  await until(() => h.calls.starts.length === 2)
  h.native.finish(h.calls.starts[1].jobId, { result: {} })
  await until(async () => (await h.actions.get_export_status({ batchId: batch.batchId })).status === 'completed')
})

test('cancelling a batch touches only its running job and drops pending targets', async () => {
  const h = harness()
  const batch = await h.actions.export_delivery_batch({ targets: ['h264_720p', 'h264_square_720'], previewOnly: false })
  await until(() => h.calls.starts.length === 1)
  const preview = await h.actions.control_export_batch({ batchId: batch.batchId, operation: 'cancel' })
  assert.equal(preview.previewOnly, true); assert.equal(h.calls.cancels.length, 0)
  await h.actions.control_export_batch({ batchId: batch.batchId, operation: 'cancel', previewOnly: false })
  assert.deepEqual(h.calls.cancels, [h.calls.starts[0].jobId])
  h.native.finish(h.calls.starts[0].jobId, { error: 'Export cancelled' })
  await until(async () => (await h.actions.get_export_status({ batchId: batch.batchId })).status === 'cancelled')
  assert.equal(h.calls.starts.length, 1)
})

test('UI Cancel stops all MCP batch targets even when per-job errors normally continue', async () => {
  const h = harness()
  const batch = await h.actions.export_delivery_batch({ targets: ['h264_720p', 'h264_square_720'], stopOnError: false, previewOnly: false })
  await until(() => h.calls.starts.length === 1)
  const jobId = h.calls.starts[0].jobId
  assert.equal(await h.actions.cancelBatchFromUi(h.native.get(jobId)), true)
  await until(() => h.calls.cancels.includes(jobId))
  h.native.finish(jobId, { error: 'Export cancelled' })
  await until(async () => (await h.actions.get_export_status({ batchId: batch.batchId })).status === 'cancelled')
  const status = await h.actions.get_export_status({ batchId: batch.batchId })
  assert.deepEqual(status.targets.map(item => item.status), ['cancelled', 'cancelled'])
  assert.equal(h.calls.starts.length, 1)
  assert.equal(Object.keys(h.actions).includes('cancelBatchFromUi'), false, 'UI hook must not enter the MCP tool catalog')
})

test('UI batch cancellation during native startup is replayed after acknowledgement', async () => {
  const h = harness()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const start = h.api.runExportInWorker
  h.api.runExportInWorker = async payload => { const result = await start(payload); await gate; return result }
  const batch = await h.actions.export_delivery_batch({ targets: ['h264_720p', 'h264_square_720'], stopOnError: false, previewOnly: false })
  await until(() => h.calls.starts.length === 1)
  const jobId = h.calls.starts[0].jobId
  assert.equal(await h.actions.cancelBatchFromUi(h.native.get(jobId)), true)
  assert.equal(h.calls.cancels.length, 0, 'Controller has not yet received the startup job ID')
  release()
  await until(() => h.calls.cancels.includes(jobId))
  h.native.finish(jobId, { error: 'Export cancelled' })
  await until(async () => (await h.actions.get_export_status({ batchId: batch.batchId })).status === 'cancelled')
  assert.equal(h.calls.starts.length, 1)
})

test('UI batch cancellation falls back for single jobs or lost renderer sessions', async () => {
  const h = harness()
  for (const job of [null, { owner: 'ui', batchId: 'batch' }, { owner: 'mcp', jobId: 'single' },
    { owner: 'mcp', jobId: 'orphaned', batchId: 'batch-before-reload' }]) {
    assert.equal(await h.actions.cancelBatchFromUi(job), false)
  }
  assert.equal(h.calls.cancels.length, 0)
})

function activityHarness() {
  const activities = [], held = new Set()
  const h = harness({ beginBatchActivity(details) {
    const activity = { details, ended: 0, update(patch) { Object.assign(activity.details, patch) },
      end() { activity.ended++; held.delete(activity) } }
    activities.push(activity); held.add(activity)
    return activity
  } })
  return { ...h, activities, held }
}

test('one MCP batch lease spans preflight, every native job and the idle gap; previews never lock', async () => {
  const h = activityHarness()
  const preview = await h.actions.export_delivery_batch({ targets: ['h264_720p', 'h264_square_720'] })
  assert.equal(preview.previewOnly, true); assert.equal(h.activities.length, 0)
  let releasePrepare, releaseGap
  const prepareGate = new Promise(resolve => { releasePrepare = resolve })
  const gapGate = new Promise(resolve => { releaseGap = resolve })
  const exists = h.api.exists, start = h.api.runExportInWorker
  h.api.exists = async file => { await prepareGate; return exists(file) }
  h.api.runExportInWorker = async payload => { if (h.calls.starts.length === 1) await gapGate; return start(payload) }
  const preparing = h.actions.export_delivery_batch({ targets: ['h264_720p', 'h264_square_720'], previewOnly: false })
  assert.equal(h.held.size, 1); assert.equal(h.calls.starts.length, 0)
  releasePrepare()
  const batch = await preparing
  await until(() => h.calls.starts.length === 1)
  h.native.finish(h.calls.starts[0].jobId, { result: {} })
  for (let i = 0; i < 5; i++) await tick()
  assert.equal(h.native.activeId, null)
  assert.equal(h.calls.starts.length, 1)
  assert.equal(h.held.size, 1, 'Completion of one native job must not unlock the parent batch')
  assert.equal(h.activities.length, 1)
  releaseGap()
  await until(() => h.calls.starts.length === 2)
  h.native.finish(h.calls.starts[1].jobId, { result: {} })
  await until(async () => (await h.actions.get_export_status({ batchId: batch.batchId })).status === 'completed')
  assert.equal(h.held.size, 0); assert.equal(h.activities[0].ended, 1)
})

test('MCP parent lease releases on preflight failure or cancellation without starting native work', async () => {
  const failed = activityHarness()
  failed.api.exists = async () => { throw new Error('Synthetic preflight failure') }
  await assert.rejects(failed.actions.export_delivery_batch({ targets: ['h264_720p'], previewOnly: false }), /preflight failure/)
  assert.equal(failed.held.size, 0); assert.equal(failed.activities[0].ended, 1)
  assert.equal(failed.calls.starts.length, 0)

  const cancelled = activityHarness()
  let release
  const gate = new Promise(resolve => { release = resolve })
  cancelled.api.exists = async () => { await gate; return false }
  const pending = cancelled.actions.export_delivery_batch({ targets: ['h264_720p'], previewOnly: false })
  await cancelled.activities[0].details.cancel()
  assert.equal(cancelled.held.size, 1, 'Cancellation stays locked until in-flight preflight returns')
  release()
  await assert.rejects(pending, /Export cancelled/)
  assert.equal(cancelled.held.size, 0); assert.equal(cancelled.activities[0].ended, 1)
  assert.equal(cancelled.calls.starts.length, 0); assert.equal(cancelled.calls.directories.length, 0)
})

test('pausing releases the batch lease after the current job, and resume reacquires it', async () => {
  const h = activityHarness()
  const batch = await h.actions.export_delivery_batch({ targets: ['h264_720p', 'h264_square_720'], previewOnly: false })
  await until(() => h.calls.starts.length === 1)
  await h.actions.control_export_batch({ batchId: batch.batchId, operation: 'pause', previewOnly: false })
  assert.equal(h.held.size, 1)
  h.native.finish(h.calls.starts[0].jobId, { result: {} })
  await until(async () => (await h.actions.get_export_status({ batchId: batch.batchId })).status === 'paused')
  assert.equal(h.held.size, 0); assert.equal(h.activities[0].ended, 1)
  await h.actions.control_export_batch({ batchId: batch.batchId, operation: 'resume', previewOnly: false })
  assert.equal(h.held.size, 1); assert.equal(h.activities.length, 2)
  await until(() => h.calls.starts.length === 2)
  await h.activities[1].details.cancel()
  h.native.finish(h.calls.starts[1].jobId, { error: 'Export cancelled' })
  await until(async () => (await h.actions.get_export_status({ batchId: batch.batchId })).status === 'cancelled')
  assert.equal(h.held.size, 0); assert.equal(h.activities[1].ended, 1)
})

test('worker failure and UI cancellation both release the MCP parent lease exactly once', async () => {
  for (const outcome of ['failed', 'cancelled']) {
    const h = activityHarness()
    const batch = await h.actions.export_delivery_batch({ targets: ['h264_720p', 'h264_square_720'], previewOnly: false })
    await until(() => h.calls.starts.length === 1)
    if (outcome === 'cancelled') {
      await h.activities[0].details.cancel()
      assert.equal(h.held.size, 1, 'Wait for native cancellation acknowledgement')
    }
    h.native.finish(h.calls.starts[0].jobId, { error: outcome === 'failed' ? 'Synthetic worker failure' : 'Export cancelled' })
    await until(async () => (await h.actions.get_export_status({ batchId: batch.batchId })).status === outcome)
    assert.equal(h.held.size, 0); assert.equal(h.activities[0].ended, 1)
    assert.equal(h.calls.starts.length, 1)
  }
})

test('UI exports are visible but not cancellable and busy native worker is never interrupted', async () => {
  const h = harness()
  h.native.begin({ jobId: 'ui-job', owner: 'ui', senderId: 1 })
  assert.equal((await h.actions.get_export_status()).jobs[0].owner, 'ui')
  await assert.rejects(h.actions.cancel_export({ jobId: 'ui-job', previewOnly: false }), /UI exports/)
  await assert.rejects(h.actions.export_timeline({ previewOnly: false }), /in progress/)
  await assert.rejects(h.actions.export_delivery_batch({ targets: ['h264_720p'], previewOnly: false }), /already running/)
  assert.equal(h.calls.starts.length, 0); assert.equal(h.calls.cancels.length, 0)
})

test('custom library mutations use preview, persistence, and exact stale-target comparison', () => {
  const h = harness()
  const saved = h.actions.save_export_preset({ name: 'My ProRes', settings: { format: 'prores', videoCodec: 'prores' }, previewOnly: false }).preset
  const preview = h.actions.rename_export_preset({ id: saved.id, name: 'Renamed' })
  assert.deepEqual(preview.suggestedApplyPayload.expectedPreset, saved)
  assert.equal(h.calls.writes, 1)
  h.actions.rename_export_preset({ id: saved.id, name: 'Elsewhere', previewOnly: false })
  assert.throws(() => h.actions.rename_export_preset({ id: saved.id, name: 'Renamed', expectedPreset: preview.expectedPreset, previewOnly: false }), /changed after preview/)
  assert.equal(h.actions.list_export_presets().custom[0].name, 'Elsewhere')
  h.actions.delete_export_preset({ id: saved.id, previewOnly: false })
  assert.equal(h.actions.list_export_presets().custom.length, 0)
  assert.throws(() => h.actions.delete_export_preset({ id: 'youtube-1080p', previewOnly: false }), /read-only/)
})

test('preview tokens preserve exact reviewed output/settings even if the custom preset changes', async () => {
  const h = harness()
  const custom = h.actions.save_export_preset({ name: 'Reviewed preset', settings: { format: 'mp4', crf: 17 }, previewOnly: false }).preset
  const request = { presetId: custom.id }
  const preview = await h.actions.export_timeline(request)
  h.actions.delete_export_preset({ id: custom.id, previewOnly: false })
  const applied = await h.actions.export_timeline({ ...request, ...preview.suggestedApplyPayload, previewOnly: false })
  assert.equal(applied.outputPath, preview.plan.outputPath)
  assert.equal(h.calls.starts[0].options.crf, 17)
  h.native.finish(applied.jobId, { result: {} })
  await assert.rejects(h.actions.export_timeline({ ...request, ...preview.suggestedApplyPayload, previewOnly: false }), /already applied/)
})

test('preview token rejects changed arguments and parallel replay cannot duplicate export', async () => {
  const h = harness()
  const request = { presetId: 'h264-master' }
  const preview = await h.actions.export_timeline(request)
  await assert.rejects(h.actions.export_timeline({ ...request, ...preview.suggestedApplyPayload, crf: 30, previewOnly: false }), /arguments changed/)
  const apply = { ...request, ...preview.suggestedApplyPayload, previewOnly: false }
  const outcomes = await Promise.allSettled([h.actions.export_timeline(apply), h.actions.export_timeline(apply)])
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(h.calls.starts.length, 1)
  h.native.finish(h.calls.starts[0].jobId, { result: {} })
})

test('batch preview token freezes every target output path and resolved settings', async () => {
  const h = harness()
  const request = { targets: ['h264_720p', 'review-copy'] }
  const preview = await h.actions.export_delivery_batch(request)
  const batch = await h.actions.export_delivery_batch({ ...request, ...preview.suggestedApplyPayload, previewOnly: false })
  await until(() => h.calls.starts.length === 1)
  assert.equal(h.calls.starts[0].outputPath, preview.targets[0].outputPath)
  h.native.finish(h.calls.starts[0].jobId, { result: {} })
  await until(() => h.calls.starts.length === 2)
  assert.equal(h.calls.starts[1].outputPath, preview.targets[1].outputPath)
  h.native.finish(h.calls.starts[1].jobId, { result: {} })
  await until(async () => (await h.actions.get_export_status({ batchId: batch.batchId })).status === 'completed')
})

test('bundled ffprobe QC is read-only, validates expected metadata, and does not claim perceptual quality', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-export-qc-test-'))
  const file = path.join(dir, 'synthetic.mp4')
  await fs.writeFile(file, 'fixture')
  try {
    let binary
    const probe = async executable => { binary = executable; return { format: { duration: '8', format_name: 'mov,mp4', bit_rate: '5000' }, streams: [
      { codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, avg_frame_rate: '24/1' },
      { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }] } }
    const result = await inspectExportFileNative({ filePath: file, width: 1920, height: 1080, videoCodec: 'h265', durationSeconds: 8 }, { ffprobePath: '/packaged/ffprobe', probe })
    assert.equal(binary, '/packaged/ffprobe'); assert.equal(result.ready, true)
    assert.match(result.inspectionScope, /metadata only/i)
    const mismatch = await inspectExportFileNative({ filePath: file, width: 720 }, { ffprobePath: '/packaged/ffprobe', probe })
    assert.equal(mismatch.ready, false); assert.match(mismatch.warnings[0], /width/)
    const absent = await inspectExportFileNative({ filePath: `${file}.missing` }, { ffprobePath: '/packaged/ffprobe', probe })
    assert.equal(absent.ready, false); assert.equal(absent.exists, false)
    assert.equal(await fs.readFile(file, 'utf8'), 'fixture')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('export definitions cover every renderer action and all mutating schemas default to preview', () => {
  const h = harness()
  assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(h.actions).sort())
  for (const name of writableTools) assert.equal(tools.find(tool => tool.name === name).inputSchema.properties.previewOnly.default, true)
})

test('packaged workflow filename aliases preserve legacy ACE and resolve YuE2 exactly', async () => {
  const source = await fs.readFile(new URL('../electron/main.js', import.meta.url), 'utf8')
  const definition = source.match(/function deriveWorkflowIdFromFile\([^]*?\n}/)?.[0]
  assert.ok(definition)
  const derive = vm.runInNewContext(`(${definition})`, { path })
  assert.equal(derive('music_generation.json'), 'music-gen')
  assert.equal(derive('music_generation_yue2.json'), 'music-gen-yue2')
  assert.match(source, /inspectExportFileNative\(args, \{ ffprobePath \}\)/)
})
