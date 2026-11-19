import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { applyImportedWorkflowBindings } from '../src/services/importedWorkflowBindings.js'
import { buildApiWorkflowMetadata } from '../electron/workflowApiGraph.mjs'

const require = createRequire(import.meta.url)
const { transformSync } = require('esbuild')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const depsCode = transformSync(read('../src/services/workflowDependencies.js'), { format: 'cjs', loader: 'js' }).code
const generate = read('../src/components/GenerateWorkspace.jsx')
const actions = read('../src/services/mcpActions.js')
const workflowId = 'tpl-mcp-synthetic-ltx'
const requiredModel = { classType: 'LatentUpscaleModelLoader', inputKey: 'model_name', filename: 'ltx-upscaler.safetensors', targetSubdir: 'latent_upscale_models' }
const pack = { id: workflowId, requiredNodes: [{ classType: requiredModel.classType }], requiredModels: [requiredModel] }

// Actual dependency module with synthetic metadata/native disk probes only.
// No network, model download, real ComfyUI, provider or project is connected.
function dependencies({ spec = [['ltx-upscaler.safetensors']], exists = false, configuredPack = pack } = {}) {
  const state = { diskChecks: [], metadataReads: 0 }
  const module = { exports: {} }
  vm.runInNewContext(depsCode, { module, exports: module.exports, Date, Set,
    window: { electronAPI: { getSetting: async () => '/synthetic/ComfyUI',
      checkWorkflowSetupFiles: async request => { state.diskChecks.push(request); return { success: true, results: request.files.map(() => ({ exists })) } } } },
    require: name => {
      if (name === 'jsonata') return () => ({ evaluate: async () => null })
      if (name === './comfyui') return { comfyui: { getObjectInfo: async () => {
        state.metadataReads++
        return { LatentUpscaleModelLoader: { input: { required: { model_name: spec } } } }
      } } }
      if (name.endsWith('workflowDependencyPacks')) return { getWorkflowDependencyPack: () => configuredPack }
      if (name.endsWith('workflowRegistry')) return { BUILTIN_WORKFLOW_PATHS: {} }
      throw new Error(`Unexpected fixture import ${name}`)
    },
  })
  return { ...module.exports, state }
}

for (const [label, spec] of [
  ['legacy choices', [['ltx-upscaler.safetensors'], {}]],
  ['current COMBO options', ['COMBO', { options: ['ltx-upscaler.safetensors'] }]],
  ['COMBO choices alias', ['COMBO', { choices: ['ltx-upscaler.safetensors'] }]],
  ['older object choices', [{ values: ['ltx-upscaler.safetensors'] }]],
  ['Linux subfolder', ['COMBO', { options: ['LTX/ltx-upscaler.safetensors'] }]],
  ['Windows subfolder and case', ['COMBO', { options: ['LTX\\LTX-UPSCALER.SAFETENSORS'] }]],
]) test(`installed models recognized from ${label} without false disk fallback`, async () => {
  const h = dependencies({ spec })
  const result = await h.checkWorkflowDependencies(workflowId)
  assert.equal(result.status, 'ready')
  assert.equal(result.hasBlockingIssues, false)
  assert.deepEqual(plain(result.missingModels), [])
  assert.equal(h.state.diskChecks.length, 0)
  assert.equal(h.state.metadataReads, 1)
})

test('nonempty COMBO choices still reject a genuinely missing filename', async () => {
  const h = dependencies({ spec: ['COMBO', { options: ['other.safetensors'] }], exists: true })
  const result = await h.checkWorkflowDependencies(workflowId)
  assert.equal(result.hasBlockingIssues, true)
  assert.deepEqual(plain(result.missingModels), [requiredModel])
  assert.equal(h.state.diskChecks.length, 0, 'Nonempty metadata remains authoritative')
})

test('empty choices retain real filesystem fallback and missing-file reporting', async () => {
  for (const exists of [false, true]) {
    const h = dependencies({ spec: ['COMBO', { options: [] }], exists })
    const result = await h.checkWorkflowDependencies(workflowId)
    assert.equal(result.hasBlockingIssues, !exists)
    assert.equal(h.state.diskChecks.length, 1)
    assert.equal(h.state.diskChecks[0].files[0].targetSubdir, 'latent_upscale_models')
    if (!exists) assert.equal(result.missingModels[0].verifiedMissingOnDisk, true)
  }
})

const report = dependencies().buildWorkflowDependencyReport
const ready = { workflowId, hasPack: true, status: 'ready', hasBlockingIssues: false, missingNodes: [], missingModels: [], unresolvedModels: [], missingAuth: false }
const missing = { ...ready, status: 'missing', hasBlockingIssues: true, missingModels: [requiredModel] }

test('dependency receipt bounds lists/fields and omits schema, credentials and download metadata', () => {
  const result = report({ ...missing, pack: { secret: 'not-for-agent' }, missingModels: Array.from({ length: 100 }, () => ({ ...requiredModel,
    filename: 'x'.repeat(1000), downloadUrl: 'https://not-for-agent.example/file', secret: 'not-for-agent' })) })
  assert.equal(result.missingModels.length, 64)
  assert.equal(result.missingModels[0].filename.length, 256)
  assert.equal(result.counts.missingModels, 100)
  assert.equal(result.truncated, true)
  assert.doesNotMatch(JSON.stringify(result), /not-for-agent/)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64 * 1024)
})

const imported = () => ({ workflowId, templateName: 'mcp-synthetic-ltx', source: { format: 'api' },
  template: { name: 'mcp-synthetic-ltx', title: 'Synthetic LTX', workflowUrl: 'https://example.invalid/never-fetched' },
  manifest: { runnable: true, inputAssetType: 'image', outputType: 'video', fields: [] }, bindings: { parameters: [] } })
const sourceAsset = { id: 'image-1', type: 'image', name: 'Synthetic reference', width: 1280, height: 720 }
const marker = generate.indexOf("window.addEventListener('comfystudio-mcp-queue-template-generation', handler)")
const handlerSource = generate.slice(generate.lastIndexOf('    const handler = (event) => {', marker), marker)
function templateHarness({ entry = imported(), checks = [ready], connected = true,
  checkConnection = async () => connected } = {}) {
  const state = { checks: 0, imports: 0, queued: [], launches: 0, creates: 0 }
  let current = entry
  const handler = vm.runInNewContext(`${handlerSource}; handler`, {
    assets: [sourceAsset], duration: 3, fps: 24, resolution: { width: 1280, height: 720 },
    fullPrompt: '', negativePrompt: '', isConnected: connected, allowQueueWhileWaiting: true,
    checkHttpConnection: checkConnection,
    queueRef: { current: [] }, ACTIVE_JOB_STATUSES: [], IMPORTED_WORKFLOW_ID_PREFIX: 'tpl-',
    getImportedWorkflowEntry: id => current?.workflowId === id ? current : null,
    checkWorkflowDependencies: async () => {
      const check = checks[Math.min(state.checks++, checks.length - 1)]
      if (check instanceof Error) throw check
      return check
    },
    buildWorkflowDependencyReport: report,
    applyImportedWorkflowBindings,
    fetchComfyTemplateCatalog: async () => ({ templates: [imported().template] }),
    resolveComfyTemplateFromCatalog: templates => templates[0],
    importComfyTemplate: async () => { state.imports++; current = imported(); return { entry: current } },
    reimportImportedWorkflow: async () => { state.imports++; current = imported(); return { entry: current } },
    launcherCanAutoStart: true, startComfyLauncher: () => { state.launches++ },
    createQueuedJob: value => { state.creates++; return { id: 'synthetic-job', ...value } },
    setGenerationQueue: update => { state.queued = update(state.queued) }, setFormError() {}, addComfyLog() {},
  })
  const run = payload => new Promise(resolve => handler({ detail: { importedWorkflowId: entry?.workflowId,
    templateName: entry ? undefined : 'mcp-synthetic-ltx', inputAssetId: sourceAsset.id, ...payload, respond: resolve } }))
  return { run, state }
}

test('imported template preview reports actual missing names and readiness without setup/queue effects', async () => {
  const h = templateHarness({ checks: [missing] })
  const result = await h.run({ previewOnly: true })
  assert.equal(result.success, true)
  assert.equal(result.plan.readiness, 'missing')
  assert.deepEqual(plain(result.plan.dependencyCheck.missingModels), [requiredModel])
  assert.deepEqual(h.state, { checks: 1, imports: 0, queued: [], launches: 0, creates: 0 })
})

test('initial dependency refusal precedes even required reimport/autostart and ignores forged outcome arguments', async () => {
  const entry = { ...imported(), conversionIncomplete: true }
  const h = templateHarness({ entry, checks: [missing], connected: false })
  const result = await h.run({ previewOnly: false, outcome: 'setup-changed', generationSubmitted: true })
  assert.equal(result.success, false)
  assert.equal(result.code, 'WORKFLOW_DEPENDENCIES_MISSING')
  assert.equal(result.generationSubmitted, false)
  assert.equal(result.outcome, 'not-started')
  assert.equal(result.workflowId, workflowId)
  assert.deepEqual(plain(result.dependencyCheck.missingModels), [requiredModel])
  assert.deepEqual(h.state, { checks: 1, imports: 0, queued: [], launches: 0, creates: 0 })
})

test('node and authentication prerequisites are preserved rather than reduced to a generic missing-model error', async () => {
  const check = { ...missing, missingModels: [], missingNodes: [{ classType: 'SyntheticMissingNode' }], missingAuth: true }
  const h = templateHarness({ checks: [check] })
  const result = await h.run({ previewOnly: false })
  assert.equal(result.outcome, 'not-started')
  assert.deepEqual(plain(result.dependencyCheck.missingNodes), [{ classType: 'SyntheticMissingNode' }])
  assert.equal(result.dependencyCheck.missingAuth, true)
  assert.deepEqual(plain(result.dependencyCheck.counts), { missingNodes: 1, missingModels: 0, unresolvedModels: 0 })
  assert.equal(h.state.creates, 0)
})

test('dependencies disappearing after initial check refuse before queue/autostart, with no setup claim', async () => {
  const h = templateHarness({ checks: [ready, missing], connected: false })
  const result = await h.run({ previewOnly: false })
  assert.equal(result.outcome, 'not-started')
  assert.deepEqual(h.state, { checks: 2, imports: 0, queued: [], launches: 0, creates: 0 })
})

for (const existing of [true, false]) test(`missing dependencies after ${existing ? 'reimport' : 'new import'} never claim not-started`, async () => {
  const h = templateHarness({ entry: existing ? { ...imported(), conversionIncomplete: true } : null, checks: existing ? [ready, missing] : [missing] })
  const result = await h.run({ previewOnly: false, outcome: 'not-started' })
  assert.equal(result.success, false)
  assert.equal(result.code, 'WORKFLOW_DEPENDENCIES_MISSING')
  assert.equal(result.outcome, 'setup-changed')
  assert.equal(result.generationSubmitted, false)
  assert.equal(h.state.imports, 1)
  assert.equal(h.state.creates, 0)
  assert.equal(h.state.queued.length, 0)
})

test('successful ready template creates exactly one job; unexpected dependency errors have no safe refusal receipt', async () => {
  const h = templateHarness()
  assert.equal((await h.run({ previewOnly: false })).success, true)
  assert.equal(h.state.checks, 2)
  assert.equal(h.state.creates, 1)
  assert.equal(h.state.queued.length, 1)
  const broken = templateHarness({ checks: [new Error('Synthetic unavailable check')] })
  const failure = await broken.run({ previewOnly: false })
  assert.equal(failure.success, false)
  assert.equal(failure.code, undefined)
  assert.equal(failure.outcome, undefined)
})

test('first template apply awaits current connection instead of the initial disconnected render', async () => {
  let resolveHealth, healthChecks = 0
  const health = new Promise(resolve => { resolveHealth = resolve })
  const h = templateHarness({ connected: false,
    checkConnection: () => { healthChecks++; return health } })
  const applied = h.run({ previewOnly: false })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(healthChecks, 1)
  assert.equal(h.state.creates, 0)
  assert.equal(h.state.launches, 0)
  resolveHealth(true)
  const result = await applied
  assert.equal(result.success, true)
  assert.equal(result.status.isConnected, true)
  assert.equal(h.state.creates, 1)
  assert.equal(h.state.queued.length, 1)
  assert.equal(h.state.launches, 0, 'Fresh healthy check must not trigger launcher from stale React state')
})

const bridgeHandler = actions.slice(actions.indexOf('async function handleQueueTimelineTemplateGeneration('), actions.indexOf('async function handleGetGenerationQueueStatus('))
function bridge(result) {
  const fn = vm.runInNewContext(`${bridgeHandler}; handleQueueTimelineTemplateGeneration`, {
    window: { dispatchEvent: event => event.detail.respond(result) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail } },
    setTimeout, clearTimeout,
  })
  return fn({})
}

test('renderer template bridge preserves only typed dependency refusals, not generic errors or forged incomplete flags', async () => {
  const receipt = await templateHarness({ checks: [missing] }).run({ previewOnly: false })
  assert.deepEqual(plain(await bridge(receipt)), plain(receipt))
  assert.equal((await bridge({ ...receipt, outcome: 'setup-changed' })).outcome, 'setup-changed')
  for (const changes of [{ code: undefined }, { action: 'other-tool' }, { generationSubmitted: true },
    { outcome: 'unknown' }, { dependencyCheck: {} }, { workflowId: 'different-workflow' }]) {
    await assert.rejects(bridge({ ...receipt, ...changes }), /Missing required workflow dependencies/)
  }
  await assert.rejects(bridge({ success: false, error: 'Synthetic unconfirmed error' }), /Synthetic unconfirmed error/)
})

const snapshot = { schemaVersion: 2, project: { name: 'Synthetic' }, assets: [sourceAsset], currentTimeline: {
  id: 't1', fps: 24, width: 1280, height: 720, playheadPosition: 0, selectedClipIds: ['clip-1'],
  tracks: [{ id: 'v1', type: 'video' }], clips: [{ id: 'clip-1', assetId: sourceAsset.id, trackId: 'v1', type: 'image', start: 0, duration: 3 }] } }
test('native template MCP preserves confirmed failure body/isError and preview readiness instead of claiming queued', async () => {
  const h = templateHarness({ checks: [missing] })
  const server = createComfyStudioMcpServer({ performAction: async request => bridge(await h.run(request.payload)) })
  const preview = await server.queueTimelineTemplateGeneration(snapshot, { importedWorkflowId: workflowId })
  const previewBody = JSON.parse(preview.content[0].text)
  assert.ok(previewBody.plan.renderer, JSON.stringify(previewBody))
  assert.equal(previewBody.plan.renderer.readiness, 'missing')
  const result = await server.queueTimelineTemplateGeneration(snapshot, { importedWorkflowId: workflowId, previewOnly: false })
  assert.equal(result.isError, true)
  const receipt = JSON.parse(result.content[0].text)
  assert.equal(receipt.success, false)
  assert.equal(receipt.outcome, 'not-started')
  assert.equal(receipt.code, 'WORKFLOW_DEPENDENCIES_MISSING')
  assert.deepEqual(receipt.dependencyCheck.missingModels, [requiredModel])
  assert.equal(h.state.queued.length, 0)
})

test('native managed preview/apply preserve explicit duration/width bindings without injecting generic aliases', async () => {
  const parameters = { node_12_width: 1024, node_13_height: 576, node_14_duration: 3 }
  const entry = { ...imported(), bindings: { parameters: Object.keys(parameters).map(fieldId => {
    const [, nodeId, inputKey] = fieldId.split('_')
    return { fieldId, nodeId, inputKey, valueType: 'integer', defaultValue: 10 }
  }) } }
  const h = templateHarness({ entry })
  const server = createComfyStudioMcpServer({ performAction: async request => bridge(await h.run(request.payload)) })
  const preview = JSON.parse((await server.queueTimelineTemplateGeneration(snapshot, { importedWorkflowId: workflowId,
    durationSeconds: 3, templateParameters: parameters, resolution: { width: 1024, height: 576 } })).content[0].text)
  assert.deepEqual(preview.plan.renderer.templateParameters, parameters)
  assert.deepEqual(preview.suggestedApplyCall.arguments.templateParameters, parameters)
  assert.equal(preview.plan.renderer.durationSeconds, null)
  assert.equal(preview.plan.renderer.requestedMetadata.durationSeconds, 3)
  assert.equal(preview.plan.generationSettings.durationSeconds, null)
  assert.equal(preview.plan.generationSettings.resolution, null)
  assert.equal(preview.plan.apiParameterSemantics.effectiveOutput.verified, false)
  assert.deepEqual(preview.plan.apiParameterSemantics.exactAppliedBindings.map(binding => [binding.fieldId, binding.value]), Object.entries(parameters))
  const applied = await server.queueTimelineTemplateGeneration(snapshot, preview.suggestedApplyCall.arguments)
  assert.equal(applied.isError, undefined)
  const receipt = JSON.parse(applied.content[0].text)
  assert.equal(receipt.plan.generationSettings.durationSeconds, null)
  assert.equal(receipt.result.job.duration, null)
  assert.equal(receipt.result.job.fps, null)
  assert.equal(receipt.result.job.resolution, null)
  assert.equal(receipt.result.job.requestedMetadata.durationSeconds, 3)
  assert.equal(receipt.result.job.apiParameterSemantics.effectiveOutput.verified, false)
  assert.equal(h.state.queued.length, 1)
  assert.deepEqual(plain(h.state.queued[0].templateParameters), parameters)
  assert.equal(h.state.queued[0].duration, 3)
  assert.equal(h.state.imports, 0)
})

test('generic-only API requests cannot advertise requested 3s/size as effective graph output', async () => {
  const graph = {
    '1': { class_type: 'LoadImage', inputs: { image: 'synthetic.png' } },
    '2': { class_type: 'EmptyLTXVLatentVideo', inputs: { length: 241, width: 1920, height: 1080 } },
    '3': { class_type: 'CreateVideo', inputs: { fps: 24, images: ['1', 0] } },
    '4': { class_type: 'SaveVideo', inputs: { video: ['3', 0], filename_prefix: 'video/synthetic' } },
  }
  const metadata = buildApiWorkflowMetadata(graph, { name: 'synthetic-ltx' })
  const entry = { ...imported(), bindings: metadata.bindings }
  const h = templateHarness({ entry })
  const server = createComfyStudioMcpServer({ performAction: async request => bridge(await h.run(request.payload)) })
  const preview = JSON.parse((await server.queueTimelineTemplateGeneration(snapshot, { importedWorkflowId: workflowId,
    durationSeconds: 3, fps: 30, resolution: { width: 1024, height: 576 } })).content[0].text)
  const semantics = preview.plan.apiParameterSemantics
  assert.equal(semantics.genericControlsAffectGraph, false)
  assert.deepEqual(semantics.requestedMetadata, { durationSeconds: 3, fps: 30, resolution: { width: 1024, height: 576 } })
  assert.deepEqual(semantics.effectiveOutput, { verified: false, durationSeconds: null, fps: null, resolution: null })
  assert.deepEqual(semantics.exactAppliedBindings, [])
  assert.equal(semantics.retainedDefaults.count, 4)
  assert.ok(semantics.retainedDefaults.bindings.some(binding => binding.fieldId === 'node_2_length' && binding.value === 241))
  assert.match(semantics.warnings.join(' '), /do not configure graph inputs.*includeGraph:true.*unverified/)
  for (const key of ['durationSeconds', 'fps', 'resolution']) {
    assert.equal(preview.plan.renderer[key], null)
    assert.equal(preview.plan.generationSettings[key], null)
  }
  const receipt = JSON.parse((await server.queueTimelineTemplateGeneration(snapshot, preview.suggestedApplyCall.arguments)).content[0].text)
  assert.equal(receipt.result.job.duration, null)
  assert.equal(receipt.result.job.requestedMetadata.durationSeconds, 3)
  assert.deepEqual(applyImportedWorkflowBindings(graph, metadata.bindings, { templateParameters: h.state.queued[0].templateParameters }), graph,
    'Actual worker binding keeps graph defaults when generic metadata alone is provided')
  assert.equal(h.state.queued[0].duration, 3, 'Internal requested placement metadata is preserved without claiming output timing')
})

test('API binding receipt uses actual integer/boolean coercion but still never derives global output semantics', async () => {
  const entry = { ...imported(), bindings: { parameters: [
    { fieldId: 'node_1_length', nodeId: '1', inputKey: 'length', valueType: 'integer', defaultValue: 241 },
    { fieldId: 'node_2_enabled', nodeId: '2', inputKey: 'enabled', valueType: 'boolean', defaultValue: true },
  ] } }
  const result = await templateHarness({ entry }).run({ previewOnly: true,
    templateParameters: { node_1_length: 73.4, node_2_enabled: 'false' } })
  assert.deepEqual(plain(result.plan.apiParameterSemantics.exactAppliedBindings.map(binding => binding.value)), [73, false])
  assert.equal(result.plan.apiParameterSemantics.retainedDefaults.count, 0)
  assert.equal(result.plan.apiParameterSemantics.effectiveOutput.durationSeconds, null)
  assert.equal(result.plan.apiParameterSemantics.effectiveOutput.verified, false)
})

test('queue status preserves API request semantics without presenting metadata as effective output; builtins stay unchanged', async () => {
  const h = templateHarness()
  await h.run({ previewOnly: false, durationSeconds: 3, fps: 30, resolution: { width: 1024, height: 576 } })
  const apiJob = h.state.queued[0]
  const builtinJob = { id: 'builtin-job', workflowId: 'builtin', workflowLabel: 'Builtin', status: 'queued',
    duration: 5, fps: 24, resolution: { width: 1280, height: 720 } }
  const marker = generate.indexOf("window.addEventListener('comfystudio-mcp-get-generation-queue-status', handler)")
  const source = generate.slice(generate.lastIndexOf('    const handler = (event) => {', marker), marker)
  const handler = vm.runInNewContext(`${source}; handler`, {
    queueRef: { current: [builtinJob, apiJob] }, ACTIVE_JOB_STATUSES: ['queued'],
  })
  let response
  handler({ detail: { respond: value => { response = plain(value) } } })
  const apiStatus = response.jobs.find(job => job.id === apiJob.id)
  assert.equal(apiStatus.duration, null)
  assert.equal(apiStatus.fps, null)
  assert.equal(apiStatus.resolution, null)
  assert.deepEqual(apiStatus.requestedMetadata, { durationSeconds: 3, fps: 30, resolution: { width: 1024, height: 576 } })
  assert.deepEqual(apiStatus.apiParameterSemantics, plain(apiJob.apiParameterSemantics))
  assert.equal(apiStatus.apiParameterSemantics.effectiveOutput.verified, false)
  assert.deepEqual(apiStatus.warnings, plain(apiJob.apiParameterSemantics.warnings))
  assert.equal(apiJob.duration, 3, 'Status must not change internal placement metadata')
  assert.equal(apiJob.fps, 30)
  assert.deepEqual(plain(apiJob.resolution), { width: 1024, height: 576 })
  assert.deepEqual(response.jobs.find(job => job.id === builtinJob.id), {
    id: 'builtin-job', workflowId: 'builtin', workflowLabel: 'Builtin', status: 'queued', progress: 0,
    promptId: null, promptLabel: null, batchId: null, duration: 5, conditioningAudio: null,
    resolution: { width: 1280, height: 720 }, resultAssetIds: [], error: null,
  })
})

test('native imported preview without renderer cannot present requested settings as verified output controls', async () => {
  const server = createComfyStudioMcpServer()
  const result = JSON.parse((await server.queueTimelineTemplateGeneration(snapshot, { importedWorkflowId: workflowId, durationSeconds: 3 })).content[0].text)
  assert.equal(result.plan.generationSettings.durationSeconds, null)
  assert.equal(result.plan.generationSettings.requestedMetadata.durationSeconds, 3)
  assert.match(result.plan.warnings.join(' '), /could not be inspected/)
})

test('native legacy imported UI preview retains its resolution-derived width/aspect aliases', async () => {
  const entry = { ...imported(), source: { format: 'ui' }, bindings: { parameters: [{ fieldId: 'width' }] } }
  const h = templateHarness({ entry })
  const server = createComfyStudioMcpServer({ performAction: async request => bridge(await h.run(request.payload)) })
  const preview = JSON.parse((await server.queueTimelineTemplateGeneration(snapshot, { importedWorkflowId: workflowId,
    resolution: { width: 1024, height: 576 } })).content[0].text)
  assert.deepEqual(preview.plan.renderer.templateParameters, { width: 1024, height: 576, target_aspect_w: 16, target_aspect_h: 9 })
  assert.equal(h.state.imports, 0)
  assert.equal(h.state.queued.length, 0)
})

test('explicit unsupported API aliases still reject instead of silently bypassing binding validation', async () => {
  const h = templateHarness()
  const server = createComfyStudioMcpServer({ performAction: async request => bridge(await h.run(request.payload)) })
  await assert.rejects(server.queueTimelineTemplateGeneration(snapshot, { importedWorkflowId: workflowId,
    templateParameters: { width: 1024 }, previewOnly: false }), /exact inspected API workflow parameter field IDs: width/)
  assert.equal(h.state.checks, 0)
  assert.equal(h.state.queued.length, 0)
})

test('actual outer renderer/native IPC returns inner refusal only after fresh snapshot; snapshot failure still rejects', async () => {
  const receipt = await templateHarness({ checks: [missing] }).run({ previewOnly: false })
  const native = read('../electron/main.js')
  const nativeHandler = native.slice(native.indexOf("ipcMain.on('mcp:actionResult'"), native.indexOf('// ComfyUI Launcher IPC'))
  const rendererBridge = actions.slice(actions.indexOf('export function startMcpActionBridge()')).replace('export function', 'function')
  for (const snapshotOk of [true, false]) {
    const ipcMain = new EventEmitter(), pending = new Map(), order = []
    const sender = { mainFrame: {} }
    vm.runInNewContext(nativeHandler, { ipcMain, mainWindow: { webContents: sender }, pendingMcpActionRequests: pending,
      clearTimeout, mcpServer: { updateSnapshot: () => { order.push('snapshot'); return snapshotOk } },
      agentDispatchScope: { complete: () => { order.push('agent-context') } } })
    let callback
    vm.runInNewContext(`${rendererBridge}; startMcpActionBridge()`, {
      window: { electronAPI: { mcp: { onAction: fn => { callback = fn }, sendActionResult: response => {
        assert.equal(response.success, true)
        ipcMain.emit('mcp:actionResult', { sender, senderFrame: sender.mainFrame }, response)
      } } } },
      assertAgentInteractionContext() {}, runMcpAction: async () => bridge(receipt),
      buildMcpSnapshot: () => snapshot, captureAgentInteractionContext: () => ({ context: { revision: 1 } }),
    })
    const result = new Promise((resolve, reject) => pending.set('test-action', { resolve: value => { order.push('resolve'); resolve(value) }, reject }))
    await callback({ id: 'test-action', action: 'queue_timeline_template_generation', payload: {} })
    if (snapshotOk) {
      assert.deepEqual(plain(await result), plain(receipt))
      assert.deepEqual(order, ['snapshot', 'agent-context', 'resolve'])
    } else await assert.rejects(result, /snapshot could not be refreshed.*Do not automatically repeat/)
  }
})
