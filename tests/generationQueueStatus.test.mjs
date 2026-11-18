import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { generationQueueOwner, projectGenerationQueueJob, readGenerationQueueStatus } from '../src/services/generationQueueStatus.mjs'

// Actual renderer dispatch, monitor store and Generate publication, all in RAM.
// No app, project, real storage, network, ComfyUI or generation is used.
const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const actions = read('../src/services/mcpActions.js')
const monitor = read('../src/stores/generationMonitorStore.js')
const generate = read('../src/components/GenerateWorkspace.jsx')
const statusService = read('../src/services/generationQueueStatus.mjs')
const plain = value => JSON.parse(JSON.stringify(value))
const STORAGE_KEY = 'generate-workspace-generation-queue'
const ACTIVE = ['uploading', 'configuring', 'queuing', 'running', 'saving']

function between(source, first, last) {
  const start = source.indexOf(first)
  const end = source.indexOf(last, start)
  assert.ok(start >= 0 && end > start, `Actual source boundaries: ${first}`)
  return source.slice(start, end)
}

function sampleJob(overrides = {}) {
  return {
    id: 'job-1', workflowId: 'ltx23-ia2v', workflowLabel: 'LTX IA2V',
    category: 'video', status: 'running', progress: 37, promptId: 'prompt-1',
    prompt: 'Synthetic prompt', duration: 3, fps: 24,
    resolution: { width: 1280, height: 720 },
    conditioningAudio: { assetId: 'audio-1', startSeconds: 32, durationSeconds: 3,
      source: 'explicit_audio_asset_range', timelineAudioMatched: false },
    resultAssetIds: ['asset-1'], error: '', ...overrides,
  }
}

function apiJob(overrides = {}) {
  return sampleJob({ id: 'api-1', workflowId: 'tpl-mcp-fixture',
    mcpBatch: { id: 'batch-1', requestedWorkflowId: 'my-workflow:fixture', promptLabel: 'Shot 01' },
    apiParameterSemantics: {
      requestedMetadata: { durationSeconds: 3, fps: 30, resolution: { width: 1024, height: 576 } },
      exactAppliedBindings: [{ fieldId: 'motion', nodeId: '7', inputName: 'value', value: 73 }],
      retainedDefaults: { count: 1, values: [{ nodeId: '8', inputName: 'seed', value: 123 }] },
      effectiveOutput: { verified: false, durationSeconds: null, fps: null, resolution: null },
      warnings: ['Requested metadata does not establish effective output.'],
    }, ...overrides,
  })
}

function liveSnapshot(jobs) {
  return { queueStatusAvailable: true, queueStatusJobs: jobs.map(projectGenerationQueueJob),
    updatedAt: 1000, isConnected: true }
}

function legacyStatus(jobs, payload = {}) {
  const marker = generate.indexOf("window.addEventListener('comfystudio-mcp-get-generation-queue-status', handler)")
  assert.ok(marker >= 0, 'Legacy UI listener remains a compatibility contract')
  const start = generate.lastIndexOf('    const handler = (event) => {', marker)
  const handler = vm.runInNewContext(`${generate.slice(start, marker)}; handler`, {
    queueRef: { current: jobs }, ACTIVE_JOB_STATUSES: ACTIVE,
  })
  let response
  handler({ detail: { ...payload, respond: value => { response = plain(value) } } })
  return response
}

function harness({ raw = null, storageError = false } = {}) {
  const state = { raw, now: 1000, writes: 0, reads: [], forbidden: [], activeTab: 'Editor',
    currentProjectHandle: '/synthetic/project-one',
    currentProject: { id: 'project-1', created: '2026-01-01', name: 'Synthetic project' } }
  const forbidden = name => (...args) => {
    state.forbidden.push({ name, args })
    throw new Error(`Forbidden status-read side effect: ${name}`)
  }
  const localStorage = {
    getItem(key) {
      state.reads.push(key)
      if (storageError) throw new Error('Storage unavailable')
      return state.raw
    },
    setItem: forbidden('storage.setItem'), removeItem: forbidden('storage.removeItem'),
    clear: forbidden('storage.clear'),
  }
  const context = vm.createContext({
    Date: class extends Date { static now() { return state.now } },
    localStorage,
    create(initializer) {
      let current
      const set = update => {
        state.writes++
        current = { ...current, ...(typeof update === 'function' ? update(current) : update) }
      }
      current = initializer(set, () => current)
      return { getState: () => current, setState: set }
    },
    window: { localStorage, __velornGenerateWorkspaceReady: false,
      dispatchEvent: forbidden('window.dispatchEvent'),
      addEventListener: forbidden('window.addEventListener'),
      set activeTab(value) { forbidden('activeTab')(value) },
      get activeTab() { return state.activeTab },
    },
    CustomEvent: class { constructor() { forbidden('CustomEvent')() } },
    fetch: forbidden('fetch'),
    setTimeout: forbidden('setTimeout'), clearTimeout: forbidden('clearTimeout'),
    setInterval: forbidden('setInterval'), clearInterval: forbidden('clearInterval'),
    waitForGenerateWorkspaceReady: forbidden('waitForGenerateWorkspaceReady'),
    setActiveTab: forbidden('setActiveTab'), setGenerationQueue: forbidden('setGenerationQueue'),
    comfyui: { queuePrompt: forbidden('queuePrompt'), getQueue: forbidden('getQueue'),
      getHistory: forbidden('getHistory'), connect: forbidden('connect') },
    useProjectStore: { getState: () => ({ currentProjectHandle: state.currentProjectHandle,
      currentProject: state.currentProject }) },
    MCP_PARITY_ACTIONS: {}, assertAssetRemovalAllowsMcp: () => {},
    assertMcpActionAllowedDuringExport: () => {}, isExportBusy: () => false,
  })
  const storeSource = monitor
    .replace(/^import\s+.*\sfrom\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export default useGenerationMonitorStore\s*$/m, '')
  const helperSource = statusService.replace(/^export /gm, '')
  const handlerSource = between(actions, 'async function handleGetGenerationQueueStatus(', 'async function handleImportComfyUiWorkflow(')
  const dispatchSource = between(actions, 'async function handleMcpAction(', 'export function startMcpActionBridge(')
    .replace(/^export /gm, '')
  const result = vm.runInContext(`${helperSource}\n${storeSource}\n${handlerSource}\n${dispatchSource}
    ;({ store: useGenerationMonitorStore, runMcpAction })`, context)
  const publication = between(generate, '  useEffect(() => {\n    publishGenerationMonitorQueue(', '\n  }, [')
    .slice('  useEffect('.length) + '\n  }'
  return { ...result, state,
    read: payload => result.runMcpAction('get_generation_queue_status', payload),
    publish(jobs, options = {}) {
      Object.assign(context, { generationQueue: jobs, activeJobId: options.activeJobId ?? jobs[0]?.id ?? null,
        isConnected: options.isConnected ?? true, publishGenerationMonitorQueue: result.store.getState().publishQueue,
        currentProjectHandle: state.currentProjectHandle, currentProject: state.currentProject })
      vm.runInContext(`(${publication})()`, context)
    },
  }
}

test('live status preserves legacy job schema, filters, ordering and post-limit active count', () => {
  const jobs = [sampleJob({ id: 'old-done', status: 'done' }),
    apiJob(), sampleJob({ id: 'queued', status: 'queued' }),
    sampleJob({ id: 'paused', status: 'paused' }),
    sampleJob({ id: 'error', status: 'error', error: 'Synthetic error' }),
    sampleJob({ id: 'cancelled', status: 'cancelled' }),
    sampleJob({ id: 'latest', status: 'saving' })]
  for (const payload of [{}, { includeDone: false }, { limit: 2 },
    { workflowId: ' my-workflow:fixture ' }, { workflowId: 'tpl-mcp-fixture' },
    { batchId: ' batch-1 ' }, { jobIds: [' api-1 ', 'latest', '', null] },
    { workflowId: 'ltx23-ia2v', includeDone: false, limit: 2 },
    { workflowId: 'unknown' }, { limit: -10 }, { limit: 1.9 }]) {
    const legacy = legacyStatus(jobs, payload)
    const actual = readGenerationQueueStatus(liveSnapshot(jobs), payload)
    assert.deepEqual({ success: actual.success, action: actual.action, count: actual.count,
      activeCount: actual.activeCount, jobs: actual.jobs }, legacy, JSON.stringify(payload))
  }
  assert.equal(readGenerationQueueStatus(liveSnapshot(jobs), { limit: 3 }).activeCount, 1)
})

test('all established active phases count; queued and paused remain non-active', () => {
  const jobs = [...ACTIVE, 'queued', 'paused', 'done', 'error', 'cancelled']
    .map(status => sampleJob({ id: status, status }))
  assert.equal(readGenerationQueueStatus(liveSnapshot(jobs)).activeCount, 5)
  assert.equal(readGenerationQueueStatus(liveSnapshot(jobs), { includeDone: false }).count, 7)
  assert.equal(readGenerationQueueStatus(liveSnapshot(jobs), { limit: 4 }).activeCount, 0)
})

test('registered native submitting and queued runs count as active without redefining legacy queued jobs', () => {
  const project = { id: 'native-project', created: '2026-09-29', name: 'Native run project' }
  const owner = generationQueueOwner('/synthetic/native-project', project)
  const snapshot = {
    queueStatusAvailable: true,
    queueStatusOwner: owner,
    legacyQueueStatusJobs: [sampleJob({ id: 'legacy-queued', status: 'queued' })],
    runsAvailable: true,
    runsOwner: { ...owner, scope: 'application' },
    runsUpdatedAt: '2026-09-29T10:00:00.000Z',
    runsQueueStatusJobs: [
      { id: 'native-submitting', workflowLabel: 'Agent workflow', status: 'submitting', progress: null,
        promptId: 'native-submitting', origin: 'agent', source: 'native-run', outputs: [] },
      { id: 'native-queued', workflowLabel: 'Agent workflow', status: 'queued', progress: null,
        promptId: 'native-queued', origin: 'agent', source: 'native-run', outputs: [] },
    ],
  }
  const result = readGenerationQueueStatus(snapshot, {}, undefined, owner)
  assert.equal(result.live, true)
  assert.equal(result.count, 3)
  assert.equal(result.activeCount, 2)
  assert.equal(result.jobs.find(job => job.id === 'native-queued').progress, null)
})

test('registered completion preserves managed identity and can be polled by either job ID', () => {
  const legacy = sampleJob({ id: 'managed-image-job', workflowId: 'z-image-turbo',
    workflowLabel: 'Z Image Turbo', status: 'running', progress: 45, error: 'Stale message',
    mcpBatch: { id: 'managed-batch', promptLabel: 'One image' },
    resultAssetIds: ['existing-image'] })
  const native = { id: 'native-run-uuid', promptId: legacy.promptId, origin: 'velorn',
    workflowLabel: 'Velorn generation', status: 'done', progress: 100,
    resultAssetIds: ['existing-image', 'new-image'], error: null,
    outputs: [{ filename: 'result.png', subfolder: 'image', type: 'output', nodeId: '9', mediaType: 'image' }],
    importState: 'pending', recipeAvailable: true, outputCount: 1 }
  const snapshot = { ...liveSnapshot([legacy]), runsAvailable: true, runsQueueStatusJobs: [native] }
  const before = plain(snapshot)
  for (const filters of [{}, { jobIds: [legacy.id] }, { jobIds: [native.id] },
    { jobIds: [legacy.id, native.id] }, { workflowId: legacy.workflowId },
    { batchId: legacy.mcpBatch.id },
    { jobIds: [native.id], workflowId: legacy.workflowId, batchId: legacy.mcpBatch.id }]) {
    const result = readGenerationQueueStatus(snapshot, filters)
    assert.equal(result.count, 1, JSON.stringify(filters))
    assert.equal(result.activeCount, 0)
    const job = result.jobs[0]
    assert.equal(job.id, legacy.id)
    assert.equal(job.runId, native.id)
    assert.equal(job.workflowId, legacy.workflowId)
    assert.equal(job.workflowLabel, legacy.workflowLabel)
    assert.equal(job.batchId, legacy.mcpBatch.id)
    assert.equal(job.status, 'done')
    assert.equal(job.progress, 100)
    assert.equal(job.error, null)
    assert.equal(job.source, 'native-run')
    assert.deepEqual(job.resultAssetIds, ['existing-image', 'new-image'])
    assert.deepEqual(job.outputs, native.outputs)
    assert.equal(job.outputCount, 1)
    assert.equal(job.importState, 'pending')
    assert.equal(job.recipeAvailable, true)
    job.outputs[0].filename = 'mutated-response.png'
  }
  assert.equal(readGenerationQueueStatus(snapshot, { jobIds: [native.id], includeDone: false }).count, 0)
  assert.deepEqual(snapshot, before, 'Projection and returned results never modify source records')
})

test('merged jobs retain requested and execution workflow filters alongside native metadata', () => {
  const legacy = apiJob({ status: 'running' })
  const native = { id: 'saved-native-run', promptId: legacy.promptId, origin: 'agent',
    workflowId: 'my-workflow:fixture', status: 'error', progress: null, error: 'Generation failed', outputs: [] }
  const snapshot = { ...liveSnapshot([legacy]), runsAvailable: true, runsQueueStatusJobs: [native] }
  for (const workflowId of ['my-workflow:fixture', 'tpl-mcp-fixture']) {
    const result = readGenerationQueueStatus(snapshot, { workflowId, jobIds: [native.id], batchId: 'batch-1' })
    assert.equal(result.count, 1)
    assert.equal(result.jobs[0].id, legacy.id)
    assert.equal(result.jobs[0].workflowId, 'my-workflow:fixture')
    assert.equal(result.jobs[0].executionWorkflowId, 'tpl-mcp-fixture')
    assert.equal(result.jobs[0].status, 'error')
    assert.equal(result.jobs[0].progress, null)
    assert.equal(result.jobs[0].error, native.error)
    assert.deepEqual(result.jobs[0].apiParameterSemantics, legacy.apiParameterSemantics)
  }
})

test('native-only records remain queryable after restart without inventing a managed alias', () => {
  const native = { id: 'resumed-native-run', promptId: 'resumed-prompt', origin: 'velorn',
    workflowId: 'z-image-turbo', status: 'done', progress: 100, resultAssetIds: ['resumed-image'], outputs: [] }
  const snapshot = { runsAvailable: true, runsQueueStatusJobs: [native] }
  const result = readGenerationQueueStatus(snapshot, { jobIds: [native.id], workflowId: native.workflowId })
  assert.equal(result.count, 1)
  assert.equal(result.jobs[0].id, native.id)
  assert.equal(result.jobs[0].status, 'done')
  assert.deepEqual(result.jobs[0].resultAssetIds, ['resumed-image'])
  assert.equal(readGenerationQueueStatus(snapshot, { jobIds: ['unrecorded-managed-id'] }).count, 0)
})

test('unknown persisted managed jobs keep their original ID and workflow without native completion', () => {
  const legacy = sampleJob({ id: 'saved-managed-id', workflowId: 'z-image-turbo',
    mcpBatch: { id: 'saved-batch' }, status: 'running' })
  const storage = { getItem: () => JSON.stringify([legacy]) }
  const result = readGenerationQueueStatus({}, {
    jobIds: [legacy.id], workflowId: legacy.workflowId, batchId: 'saved-batch',
  }, storage)
  assert.equal(result.source, 'persisted')
  assert.equal(result.count, 1)
  assert.equal(result.jobs[0].id, legacy.id)
  assert.equal(result.jobs[0].status, 'unknown')
  assert.equal(result.jobs[0].lastKnownStatus, 'running')
  assert.equal(Object.hasOwn(result.jobs[0], 'runId'), false)
})

test('limit defaults to 100, floors numeric values and bounds live results to 1–500', () => {
  const snapshot = liveSnapshot(Array.from({ length: 600 }, (_, i) => sampleJob({ id: `job-${i}` })))
  for (const [limit, count] of [[undefined, 100], [0, 100], ['n/a', 100],
    [Infinity, 100], [2.9, 2], [-1, 1], [999, 500]]) {
    const result = readGenerationQueueStatus(snapshot, { limit })
    assert.equal(result.count, count, String(limit))
    assert.equal(result.jobs[0].id, 'job-599')
    assert.equal(result.jobs.at(-1).id, `job-${600 - count}`)
  }
})

test('API binding semantics stay exact and do not claim metadata as verified output', () => {
  const job = apiJob()
  const result = readGenerationQueueStatus(liveSnapshot([job])).jobs[0]
  assert.equal(result.workflowId, 'my-workflow:fixture')
  assert.equal(result.executionWorkflowId, 'tpl-mcp-fixture')
  assert.equal(result.batchId, 'batch-1')
  assert.equal(result.promptLabel, 'Shot 01')
  for (const name of ['duration', 'fps', 'resolution']) assert.equal(result[name], null)
  assert.deepEqual(result.requestedMetadata, job.apiParameterSemantics.requestedMetadata)
  assert.deepEqual(result.apiParameterSemantics, job.apiParameterSemantics)
  assert.deepEqual(result.warnings, job.apiParameterSemantics.warnings)
  assert.equal(result.apiParameterSemantics.effectiveOutput.verified, false)
  assert.equal(job.duration, 3)
  assert.equal(job.fps, 24)
})

test('actual Generate publisher and MCP dispatcher return fresh progress without switching Editor or polling', async () => {
  const h = harness({ raw: JSON.stringify([sampleJob({ id: 'stale' })]) })
  for (const progress of [4, 37, 92, 100]) {
    h.state.now++
    h.publish([sampleJob({ progress, status: progress === 100 ? 'done' : 'running' })])
    const before = plain(h.store.getState())
    const writes = h.state.writes
    for (let repeat = 0; repeat < 3; repeat++) {
      const result = await h.read({ timeoutMs: 1 })
      assert.equal(result.source, 'live')
      assert.equal(result.scope, 'application')
      assert.equal(result.live, true)
      assert.equal(result.available, true)
      assert.equal(result.updatedAt, h.state.now)
      assert.equal(result.isConnected, true)
      assert.equal(result.jobs[0].progress, progress)
      assert.equal(result.jobs[0].status, progress === 100 ? 'done' : 'running')
    }
    assert.equal(h.state.writes, writes, 'Status calls do not publish or mutate the store')
    assert.deepEqual(plain(h.store.getState()), before)
  }
  assert.equal(h.state.activeTab, 'Editor')
  assert.deepEqual(h.state.reads, [], 'A live publication never falls back to stale disk state')
  assert.deepEqual(h.state.forbidden, [])
})

test('publication and each returned result are deeply detached from raw jobs and store state', async () => {
  const h = harness()
  const job = apiJob({ resultAssetIds: Array.from({ length: 15 }, (_, i) => `asset-${i}`) })
  h.publish([job])
  assert.equal(h.store.getState().jobs[0].resultAssetIds.length, 12, 'Existing compact monitor remains bounded')
  assert.equal(h.store.getState().queueStatusJobs[0].resultAssetIds.length, 15, 'MCP keeps the established result IDs')
  job.conditioningAudio.startSeconds = 999
  job.apiParameterSemantics.exactAppliedBindings[0].value = 999
  job.resultAssetIds.push('late-input-mutation')
  const before = plain(h.store.getState())
  const first = await h.read()
  assert.equal(first.jobs[0].conditioningAudio.startSeconds, 32)
  assert.equal(first.jobs[0].apiParameterSemantics.exactAppliedBindings[0].value, 73)
  first.jobs[0].conditioningAudio.startSeconds = 111
  first.jobs[0].apiParameterSemantics.exactAppliedBindings[0].value = 111
  first.jobs[0].requestedMetadata.resolution.width = 1
  first.jobs[0].warnings.push('mutated response')
  first.jobs[0].resultAssetIds.push('mutated response')
  first.jobs.push({ id: 'injected' })
  assert.deepEqual(plain(h.store.getState()), before)
  const second = await h.read()
  assert.equal(second.count, 1)
  assert.equal(second.jobs[0].conditioningAudio.startSeconds, 32)
  assert.equal(second.jobs[0].apiParameterSemantics.exactAppliedBindings[0].value, 73)
  assert.equal(second.jobs[0].requestedMetadata.resolution.width, 1024)
  assert.equal(second.jobs[0].resultAssetIds.length, 15)
})

test('a live empty publication is authoritative over persisted unfinished jobs', async () => {
  const h = harness({ raw: JSON.stringify([sampleJob()]) })
  h.publish([], { isConnected: false })
  const result = await h.read()
  assert.equal(result.source, 'live')
  assert.equal(result.live, true)
  assert.equal(result.available, true)
  assert.equal(result.isConnected, false)
  assert.equal(result.count, 0)
  assert.equal(result.activeCount, 0)
  assert.deepEqual(plain(result.jobs), [])
  assert.deepEqual(h.state.reads, [])
  assert.deepEqual(h.state.forbidden, [])
})

test('cold MCP reads report saved records as unknown without mounting, restoring or writing', async () => {
  const raw = JSON.stringify([apiJob({ status: 'running', progress: 62 })])
  const h = harness({ raw })
  const before = plain(h.store.getState())
  for (let i = 0; i < 3; i++) {
    const result = await h.read({ workflowId: 'my-workflow:fixture', includeDone: false })
    assert.equal(result.source, 'persisted')
    assert.equal(result.available, true)
    assert.equal(result.live, false)
    assert.equal(result.updatedAt, null)
    assert.equal(result.isConnected, null)
    assert.equal(result.activeCount, null)
    assert.equal(result.count, 1)
    assert.equal(result.jobs[0].status, 'unknown')
    assert.equal(result.jobs[0].progress, null)
    assert.equal(result.jobs[0].lastKnownStatus, 'running')
    assert.equal(result.jobs[0].lastKnownProgress, 62)
    assert.equal(result.jobs[0].apiParameterSemantics.effectiveOutput.verified, false)
    assert.match(result.note, /not live ComfyUI status/)
    assert.match(result.note, /not restored, resumed, imported or submitted/)
  }
  assert.deepEqual(plain(h.store.getState()), before)
  assert.equal(h.state.raw, raw)
  assert.equal(h.state.writes, 0)
  assert.equal(h.state.activeTab, 'Editor')
  assert.deepEqual(h.state.reads, [STORAGE_KEY, STORAGE_KEY, STORAGE_KEY])
  assert.deepEqual(h.state.forbidden, [])
})

test('cold missing, invalid, oversized and inaccessible ledger remains explicitly unavailable', async () => {
  for (const options of [{ raw: null }, { raw: '{broken' }, { raw: '{}' }, { raw: '[null]' },
    { raw: '[{"id":"missing-status"}]' }, { raw: '[{"status":"running"}]' },
    { raw: ' '.repeat(2 * 1024 * 1024 + 1) }, { storageError: true }]) {
    const h = harness(options)
    const result = await h.read()
    assert.equal(result.source, 'unavailable')
    assert.equal(result.available, false)
    assert.equal(result.live, false)
    assert.equal(result.activeCount, null)
    assert.equal(result.count, 0)
    assert.match(result.note, /does not establish that the ComfyUI queue is empty/)
    assert.equal(h.state.writes, 0)
    assert.deepEqual(h.state.forbidden, [])
  }
})

test('cold ledger is bounded, filtered and detached; an empty saved ledger never claims live emptiness', () => {
  const saved = Array.from({ length: 130 }, (_, i) => sampleJob({ id: `saved-${i}`, status: i % 2 ? 'done' : 'queued' }))
  const raw = JSON.stringify(saved)
  const storage = { getItem: key => { assert.equal(key, STORAGE_KEY); return raw } }
  assert.equal(readGenerationQueueStatus({}, { limit: 500 }, storage).count, 100)
  const result = readGenerationQueueStatus({}, { includeDone: false, limit: 2 }, storage)
  assert.deepEqual(result.jobs.map(job => job.id), ['saved-128', 'saved-126'])
  assert.equal(result.jobs[0].lastKnownStatus, 'queued')
  result.jobs[0].conditioningAudio.startSeconds = 999
  assert.equal(readGenerationQueueStatus({}, { jobIds: ['saved-128'] }, storage).jobs[0].conditioningAudio.startSeconds, 32)
  const empty = readGenerationQueueStatus({}, {}, { getItem: () => '[]' })
  assert.equal(empty.source, 'persisted')
  assert.equal(empty.live, false)
  assert.equal(empty.activeCount, null)
})

test('monitor reset invalidates a previous live snapshot; status inspection never repopulates it', async () => {
  const h = harness()
  h.publish([sampleJob()])
  assert.equal((await h.read()).source, 'live')
  h.store.getState().reset()
  const writes = h.state.writes
  const result = await h.read()
  assert.equal(result.source, 'unavailable')
  assert.equal(result.live, false)
  assert.equal(result.activeCount, null)
  assert.equal(h.store.getState().queueStatusAvailable, false)
  assert.equal(h.store.getState().queueStatusOwner, null)
  assert.deepEqual(plain(h.store.getState().queueStatusJobs), [])
  assert.equal(h.state.writes, writes)
  assert.deepEqual(h.state.forbidden, [])
})

test('owner captures only identity fields and treats browser handles by object identity', () => {
  const project = { id: 'project-1', created: '2026-01-01', name: 'Synthetic project', privateMetadata: 'omitted' }
  const handle = { name: 'same-project-name', kind: 'directory' }
  const owner = generationQueueOwner(handle, project)
  assert.deepEqual(owner, { handle, created: project.created, id: project.id, name: project.name })
  assert.equal(owner.handle, handle)
  assert.deepEqual(generationQueueOwner(), { handle: null, created: null, id: null, name: null })
  const snapshot = { ...liveSnapshot([sampleJob()]), queueStatusOwner: owner }
  const noStorage = { getItem: () => null }
  assert.equal(readGenerationQueueStatus(snapshot, {}, noStorage, generationQueueOwner(handle, { ...project })).live, true)
  for (const changed of [generationQueueOwner({ ...handle }, project),
    generationQueueOwner(null, project), generationQueueOwner(handle, { ...project, id: 'new-id' }),
    generationQueueOwner(handle, { ...project, created: '2026-02-01' }),
    generationQueueOwner(handle, { ...project, name: 'Renamed project' })]) {
    const result = readGenerationQueueStatus(snapshot, {}, noStorage, changed)
    assert.equal(result.source, 'unavailable')
    assert.equal(result.live, false)
    assert.equal(result.activeCount, null)
  }
  const missingOwner = readGenerationQueueStatus(liveSnapshot([sampleJob()]), {}, noStorage, owner)
  assert.equal(missingOwner.live, false, 'A pre-update publication with no owner cannot be trusted as current')
})

test('project change without monitor reset makes an old live publication unverified until fresh publication', async () => {
  for (const changeProject of [
    state => { state.currentProjectHandle = '/synthetic/project-two' },
    state => { state.currentProject = { ...state.currentProject, id: 'project-2' } },
    state => { state.currentProject = { ...state.currentProject, created: '2026-02-01' } },
    state => { state.currentProject = { ...state.currentProject, name: 'Changed identity' } },
    state => { state.currentProjectHandle = null; state.currentProject = null },
  ]) {
    const raw = JSON.stringify([sampleJob({ id: 'saved-application-job', progress: 12 })])
    const h = harness({ raw })
    h.publish([sampleJob({ id: 'previous-live-job', progress: 65 })])
    assert.equal((await h.read()).source, 'live')
    const previous = h.store.getState()
    const writes = h.state.writes
    changeProject(h.state)
    const stale = await h.read()
    assert.equal(stale.scope, 'application', 'Ownership invalidation does not redefine queue scope')
    assert.equal(stale.source, 'persisted')
    assert.equal(stale.live, false)
    assert.equal(stale.activeCount, null)
    assert.equal(stale.jobs[0].id, 'saved-application-job')
    assert.equal(stale.jobs[0].status, 'unknown')
    assert.equal(stale.jobs[0].progress, null)
    assert.equal(stale.jobs[0].lastKnownProgress, 12)
    assert.equal(h.store.getState(), previous, 'Status read neither resets nor republishes the old store')
    assert.equal(h.state.writes, writes)
    h.publish([sampleJob({ id: 'fresh-current-publication', progress: 82 })])
    const fresh = await h.read()
    assert.equal(fresh.source, 'live')
    assert.equal(fresh.jobs[0].id, 'fresh-current-publication')
    assert.equal(fresh.jobs[0].progress, 82)
    assert.deepEqual(h.state.reads, [STORAGE_KEY])
    assert.deepEqual(h.state.forbidden, [])
  }
})

test('actual publisher keeps browser handle identity in RAM but never returns owner data through MCP', async () => {
  const h = harness()
  const browserHandle = { name: 'synthetic-directory', kind: 'directory',
    toJSON() { throw new Error('A browser project handle must not be serialized into MCP status') } }
  h.state.currentProjectHandle = browserHandle
  h.publish([sampleJob()])
  assert.equal(h.store.getState().queueStatusOwner.handle, browserHandle)
  assert.equal((await h.read()).source, 'live')
  h.state.currentProject = { ...h.state.currentProject, unrelatedMetadata: 'ordinary project update' }
  const unchanged = await h.read()
  assert.equal(unchanged.source, 'live', 'Unrelated project updates preserve identity')
  assert.equal(Object.hasOwn(unchanged, 'queueStatusOwner'), false)
  assert.equal(Object.hasOwn(unchanged, 'owner'), false)
  assert.doesNotMatch(JSON.stringify(unchanged), /synthetic-directory|project-1|2026-01-01/)
  h.state.currentProjectHandle = { ...browserHandle }
  assert.equal((await h.read()).source, 'unavailable', 'Equal handle names are not equal browser handles')
  h.publish([sampleJob({ progress: 91 })])
  assert.equal((await h.read()).jobs[0].progress, 91)
  assert.deepEqual(h.state.forbidden, [])
})

test('actual MCP handler refuses ownerless publications even if other live fields look valid', async () => {
  const h = harness()
  h.store.getState().publishQueue({ jobs: [sampleJob()], isConnected: true })
  assert.equal(h.store.getState().queueStatusAvailable, true)
  const result = await h.read()
  assert.equal(result.source, 'unavailable')
  assert.equal(result.live, false)
  assert.equal(result.activeCount, null)
  assert.deepEqual(plain(result.jobs), [])
  assert.deepEqual(h.state.forbidden, [])
})
