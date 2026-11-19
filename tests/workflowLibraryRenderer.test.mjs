import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

// Execute the actual renderer service with only its imports/desktop boundary
// replaced. All files, events and ComfyUI calls are synthetic in-memory data.
const customSource = fs.readFileSync(new URL('../src/services/customWorkflowLibrary.js', import.meta.url), 'utf8')
const serviceSource = fs.readFileSync(new URL('../src/services/workflowLibrary.js', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const moduleBody = source => source.replace(/^import[\s\S]*? from '[^']+'\n/gm, '').replace(/^export /gm, '')

function customHarness(initial = []) {
  const folder = '/synthetic/owned/custom-workflows'
  const files = new Map(initial.map(record => [path.join(folder, `${record.id}.json`), JSON.stringify(record)]))
  const state = { writes: [], deletes: [], events: [], failWrite: false }
  const api = {
    getAppPath: async () => '/synthetic/owned', pathJoin: async (...parts) => path.posix.join(...parts),
    listDirectory: async () => ({ success: true, items: [...files.keys()].map(name => ({ name: path.basename(name) })) }),
    readFile: async name => ({ success: files.has(name), data: files.get(name) }),
    writeFile: async (name, data) => {
      if (state.failWrite) return { success: false, error: 'Synthetic storage failure' }
      files.set(name, data); state.writes.push(name); return { success: true }
    },
    createDirectory: async () => ({ success: true }),
    deleteFile: async name => { state.deletes.push(name); files.delete(name); return { success: true } },
  }
  const context = vm.createContext({
    console, crypto: { randomUUID }, window: { electronAPI: api, dispatchEvent: event => state.events.push(event.type) },
    CustomEvent: class { constructor(type) { this.type = type } },
    getLocalComfyConnectionSync: () => ({ httpBase: 'http://synthetic.invalid' }),
    openUiWorkflowInComfyUi: async () => ({ success: true }),
    CUSTOM_KEYFRAME_ENDPOINTS: {}, CUSTOM_VIDEO_ENDPOINTS: {}, scanUiWorkflowForCustomEndpoints: () => ({}),
  })
  const library = vm.runInContext(`${moduleBody(customSource)}; ({
    loadCustomWorkflowLibrary, getCustomLibraryWorkflows, saveCapturedGraphToLibrary,
    renameCustomLibraryWorkflow, updateCustomLibraryWorkflowMetadata, readCustomLibraryWorkflowGraph,
    setCustomLibraryWorkflowCategory, setCustomLibraryWorkflowThumbnail,
  })`, context)
  return { library, files, folder, state, api }
}

const ui = () => ({ nodes: [{ id: 1, type: 'PrimitiveStringMultiline' }], links: [] })
const apiGraph = () => ({ 1: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'synthetic prompt' } } })
const legacy = changes => ({ id: 'original', title: 'Original', savedAt: 1, updatedAt: 2, nodeCount: 1, uiWorkflow: ui(), category: 'image', thumbnail: 'data:synthetic', ...changes })

test('new captures retain UI/API graphs and same names never replace one another', async () => {
  const { library, files, state } = customHarness([legacy({ id: 'same-name', title: 'Same name' })])
  await library.loadCustomWorkflowLibrary()
  const captured = { workflow: ui(), output: apiGraph() }
  const results = await Promise.all([
    library.saveCapturedGraphToLibrary(captured, 'Same name'),
    library.saveCapturedGraphToLibrary(captured, 'Same name'),
  ])
  assert.equal(files.size, 3)
  assert.equal(new Set(results.map(result => result.entry.id)).size, 2)
  for (const { entry, updated } of results) {
    assert.equal(updated, false)
    assert.notEqual(entry.id, 'same-name')
    const saved = JSON.parse(files.get(entry.filePath))
    assert.deepEqual(saved.uiWorkflow, captured.workflow)
    assert.deepEqual(saved.apiWorkflow, captured.output)
  }
  assert.equal(state.deletes.length, 0)
})

test('rename preserves legacy identity, original path, graph and existing metadata even when names collide', async () => {
  const { library, files, folder, state } = customHarness([legacy({ apiWorkflow: apiGraph() }), legacy({ id: 'other', title: 'Other' })])
  await library.loadCustomWorkflowLibrary()
  const result = await library.renameCustomLibraryWorkflow('original', 'Other')
  assert.equal(result.success, true)
  assert.equal(files.size, 2)
  assert.deepEqual(state.writes, [path.join(folder, 'original.json')])
  assert.deepEqual(state.deletes, [])
  const record = JSON.parse(files.get(path.join(folder, 'original.json')))
  assert.equal(record.id, 'original')
  assert.equal(record.title, 'Other')
  assert.equal(record.category, 'image')
  assert.equal(record.thumbnail, 'data:synthetic')
  assert.equal(record.savedAt, 1)
  assert.deepEqual(record.apiWorkflow, apiGraph())
  assert.deepEqual(record.uiWorkflow, ui())
  assert.deepEqual(plain(await library.readCustomLibraryWorkflowGraph('original')).uiWorkflow, ui())
})

test('description edits are bounded, persisted and preserve an existing API snapshot', async () => {
  const { library, files, folder } = customHarness([legacy({ apiWorkflow: apiGraph() })])
  const result = await library.updateCustomLibraryWorkflowMetadata('original', { title: '  My portrait  ', description: `  ${'x'.repeat(2100)}  ` })
  assert.equal(result.success, true)
  const entry = library.getCustomLibraryWorkflows()[0]
  assert.equal(entry.title, 'My portrait')
  assert.equal(entry.description.length, 2000)
  const record = JSON.parse(files.get(path.join(folder, 'original.json')))
  assert.equal(record.id, 'original')
  assert.deepEqual(record.apiWorkflow, apiGraph())
})

test('blank names and failed writes preserve the previous entry', async () => {
  const { library, state } = customHarness([legacy()])
  await library.loadCustomWorkflowLibrary()
  assert.equal((await library.renameCustomLibraryWorkflow('original', '  ')).success, false)
  state.failWrite = true
  const result = await library.renameCustomLibraryWorkflow('original', 'New')
  assert.equal(result.success, false)
  assert.match(result.error, /storage failure/)
  assert.equal(library.getCustomLibraryWorkflows()[0].title, 'Original')
  await assert.rejects(library.saveCapturedGraphToLibrary({ workflow: ui() }, 'New capture'), /storage failure/)
  assert.equal(library.getCustomLibraryWorkflows().length, 1)
  assert.equal(state.events.length, 0)
})

test('explicit disk refresh discovers outside saves and drops removed records without manufacturing API readiness', async () => {
  const { library, files, folder } = customHarness([legacy()])
  await library.loadCustomWorkflowLibrary()
  files.clear()
  files.set(path.join(folder, 'external.json'), JSON.stringify(legacy({ id: 'external', title: 'Remembered externally', description: 'Reference animation' })))
  await library.loadCustomWorkflowLibrary({ refresh: true })
  const entries = library.getCustomLibraryWorkflows()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'external')
  assert.equal(entries[0].description, 'Reference animation')
  assert.equal((await library.readCustomLibraryWorkflowGraph('original')).success, false)
  const capture = await library.saveCapturedGraphToLibrary({ workflow: ui() }, 'UI only')
  assert.equal(Object.hasOwn(JSON.parse(files.get(capture.entry.filePath)), 'apiWorkflow'), false)
})

test('legacy category and thumbnail APIs remain usable after metadata rename', async () => {
  const { library, files, folder } = customHarness([legacy()])
  await library.loadCustomWorkflowLibrary()
  await library.renameCustomLibraryWorkflow('original', 'New display name')
  assert.equal((await library.setCustomLibraryWorkflowCategory('original', 'video')).success, true)
  assert.equal((await library.setCustomLibraryWorkflowThumbnail('original', 'data:new')).success, true)
  const record = JSON.parse(files.get(path.join(folder, 'original.json')))
  assert.equal(record.category, 'video')
  assert.equal(record.thumbnail, 'data:new')
  assert.equal(record.title, 'New display name')
})

test('a capture completing during disk refresh stays in the legacy picker', async () => {
  const { library, api } = customHarness([legacy()])
  await library.loadCustomWorkflowLibrary()
  const originalRead = api.readFile
  let releaseRead, beginRead
  const started = new Promise(resolve => { beginRead = resolve })
  const blocked = new Promise(resolve => { releaseRead = resolve })
  api.readFile = async name => {
    const result = await originalRead(name)
    beginRead()
    await blocked
    return result
  }
  const refresh = library.loadCustomWorkflowLibrary({ refresh: true })
  await started
  const capture = await library.saveCapturedGraphToLibrary({ workflow: ui(), output: apiGraph() }, 'New during refresh')
  releaseRead()
  await refresh
  assert.ok(library.getCustomLibraryWorkflows().some(entry => entry.id === capture.entry.id))
  assert.equal(library.getCustomLibraryWorkflows().length, 2)
})

function serviceHarness(api = {}) {
  const calls = []
  const state = { exportBusy: false, projectKey: 'synthetic-project-a' }
  const context = vm.createContext({
    window: { electronAPI: api },
    isExportBusy: () => state.exportBusy,
    captureMcpContext: () => ({ session: 'synthetic-session', projectKey: state.projectKey }),
    assertMcpContext: expected => {
      if (expected.projectKey !== state.projectKey) throw new Error('Project changed after preview')
    },
    loadCustomWorkflowLibrary: async args => calls.push(['refresh', args]),
    updateCustomLibraryWorkflowMetadata: async (...args) => { calls.push(['metadata', ...args]); return { success: true } },
    openUiWorkflowInComfyUi: async (...args) => { calls.push(['ui', ...args]); return { success: true } },
    openApiWorkflowInComfyUi: async (...args) => { calls.push(['api', ...args]); return { success: true } },
  })
  const service = vm.runInContext(`${moduleBody(serviceSource)}; ({ normalizeSavedWorkflow, searchSavedWorkflows, listSavedWorkflows, openSavedWorkflow, updateSavedWorkflowMetadata })`, context)
  return { service, calls, state }
}

const savedEntry = changes => ({ id: 'my-workflow:original', title: 'Portrait motion', description: 'Animate a reference image', source: 'my-workflows', format: 'ui', updatedAt: 12, ...changes })

test('library presents only known output types without guessing from a title or readiness', () => {
  const { service } = serviceHarness()
  for (const outputType of ['image', 'video', 'audio', 'utility']) {
    assert.equal(service.normalizeSavedWorkflow(savedEntry({ outputType })).outputType, outputType)
  }
  for (const outputType of [undefined, null, 'unknown', '<img>']) {
    assert.equal(service.normalizeSavedWorkflow(savedEntry({ title: 'Video generation', outputType })).outputType, null)
  }
})

test('combined library performs fresh native reads, sorts/deduplicates and strips filesystem/graph fields', async () => {
  let count = 0
  const { service } = serviceHarness({ listSavedWorkflows: async () => {
    count++
    return { success: true, workflows: [savedEntry({ filePath: '/private/file', workflow: apiGraph() }), savedEntry(), savedEntry({ id: 'tpl-mcp-new', title: `External ${count}`, source: 'imported', format: 'api', updatedAt: 30 }), { id: 'builtin', source: 'builtin' }] }
  } })
  for (let i = 1; i <= 2; i++) {
    const result = await service.listSavedWorkflows()
    assert.equal(result.success, true)
    assert.equal(result.workflows.length, 2)
    assert.equal(result.workflows[0].title, `External ${i}`)
    assert.equal(Object.hasOwn(result.workflows[1], 'filePath'), false)
    assert.equal(Object.hasOwn(result.workflows[1], 'workflow'), false)
  }
  assert.equal(count, 2)
})

test('saved-workflow search matches name and description words without a model-specific form', () => {
  const { service } = serviceHarness()
  const entries = [savedEntry(), savedEntry({ id: 'tpl-mcp-music', title: 'Song', description: 'Audio performance' })]
  assert.equal(service.searchSavedWorkflows(entries, 'REFERENCE portrait')[0].id, 'my-workflow:original')
  assert.equal(service.searchSavedWorkflows(entries, 'performance')[0].id, 'tpl-mcp-music')
  assert.equal(service.searchSavedWorkflows(entries, 'missing').length, 0)
  assert.equal(service.searchSavedWorkflows(entries, '  ').length, 2)
})

test('missing/failed native bridge returns actionable errors, not a false empty library', async () => {
  const missing = await serviceHarness().service.listSavedWorkflows()
  assert.equal(missing.success, false)
  assert.match(missing.error, /Restart/)
  const broken = await serviceHarness({ listSavedWorkflows: async () => { throw new Error('Synthetic read failed') } }).service.listSavedWorkflows()
  assert.equal(broken.success, false)
  assert.match(broken.error, /Synthetic read failed/)
})

test('open reads by stable ID only after explicit replacement confirmation and never runs', async () => {
  const reads = []
  const { service, calls } = serviceHarness({ readSavedWorkflow: async args => {
    reads.push(args)
    return { success: true, title: 'Fresh display name', format: 'ui', uiWorkflow: ui() }
  } })
  assert.equal((await service.openSavedWorkflow(savedEntry())).success, false)
  assert.equal(reads.length, 0)
  assert.equal(calls.length, 0)
  assert.equal((await service.openSavedWorkflow(savedEntry(), { confirmed: true })).success, true)
  assert.deepEqual(plain(reads), [{ workflowId: 'my-workflow:original' }])
  assert.deepEqual(plain(calls[0].slice(0, 2)), ['ui', ui()])
  assert.equal(calls[0][2].label, 'Fresh display name')
  assert.equal(typeof calls[0][2].assertCurrent, 'function')
  assert.equal(calls[0][2].expectedContext.projectKey, 'synthetic-project-a')
})

test('API recipes open via existing API graph loader; invalid stored graphs fail without opening', async () => {
  const { service, calls } = serviceHarness({ readSavedWorkflow: async () => ({ success: true, format: 'api', workflow: apiGraph() }) })
  assert.equal((await service.openSavedWorkflow(savedEntry(), { confirmed: true })).success, true)
  assert.equal(calls[0][0], 'api')
  const invalid = serviceHarness({ readSavedWorkflow: async () => ({ success: true, format: 'ui', uiWorkflow: {} }) })
  assert.equal((await invalid.service.openSavedWorkflow(savedEntry(), { confirmed: true })).success, false)
  assert.equal(invalid.calls.length, 0)
})

test('custom metadata refreshes first and uses stable local ID; managed entries cannot mutate renderer paths', async () => {
  const { service, calls } = serviceHarness()
  assert.equal((await service.updateSavedWorkflowMetadata(savedEntry(), { title: 'New' })).success, true)
  assert.deepEqual(plain(calls[0]), ['refresh', { refresh: true }])
  assert.deepEqual(plain(calls[1].slice(0, 3)), ['metadata', 'original', { title: 'New' }])
  assert.equal(typeof calls[1][3].assertCurrent, 'function')
  assert.equal((await service.updateSavedWorkflowMetadata(savedEntry({ id: 'tpl-mcp-test', source: 'imported' }), { title: 'No' })).success, false)
  assert.equal(calls.length, 2)
})

test('export starting or project changing during native read blocks the graph handoff', async () => {
  for (const change of [state => { state.exportBusy = true }, state => { state.projectKey = 'synthetic-project-b' }]) {
    let state
    const harness = serviceHarness({ readSavedWorkflow: async () => {
      change(state)
      return { success: true, format: 'ui', uiWorkflow: ui() }
    } })
    state = harness.state
    const result = await harness.service.openSavedWorkflow(savedEntry(), { confirmed: true })
    assert.equal(result.success, false)
    assert.match(result.error, /export|Project changed/)
    assert.equal(harness.calls.length, 0)
  }
})

test('metadata pre-write guard aborts after a delayed read without touching the file', async () => {
  const { library, api, state } = customHarness([legacy()])
  await library.loadCustomWorkflowLibrary()
  const originalRead = api.readFile
  let changed = false
  api.readFile = async name => { const result = await originalRead(name); changed = true; return result }
  const result = await library.updateCustomLibraryWorkflowMetadata('original', { title: 'Do not save' }, {
    assertCurrent: () => { if (changed) throw new Error('Project changed') },
  })
  assert.equal(result.success, false)
  assert.equal(state.writes.length, 0)
  assert.equal(library.getCustomLibraryWorkflows()[0].title, 'Original')
})

function openingHarness(phase) {
  const source = fs.readFileSync(new URL('../src/services/workflowSetupManager.js', import.meta.url), 'utf8')
  const actualOpenFunctions = source.slice(source.indexOf('async function loadApiWorkflowGraphIntoComfyUi'))
  const state = { changed: false, loads: [] }
  const context = vm.createContext({
    window: { dispatchEvent() {}, electronAPI: { loadComfyUiWorkflowGraph: async payload => { state.loads.push(payload); return { success: true } } } },
    CustomEvent: class {}, OPEN_COMFY_TAB_EVENT: 'synthetic-open-comfy',
    getLocalComfyConnectionSync: () => ({ httpBase: 'http://synthetic.invalid' }),
    comfyui: { getObjectInfo: async () => { if (phase === 'metadata') state.changed = true; return {} } },
    buildComfyGraphFromApiWorkflow: async () => ui(),
    waitForVisibleComfyIframe: async () => { if (phase === 'iframe') state.changed = true; return true },
  })
  const opening = vm.runInContext(`${moduleBody(actualOpenFunctions)}; ({ openUiWorkflowInComfyUi, openApiWorkflowInComfyUi })`, context)
  const options = { expectedContext: { session: 'synthetic', projectKey: 'project-a' }, assertCurrent: () => { if (state.changed) throw new Error('Stale operation') } }
  return { opening, state, options }
}

test('graph open checks its guard again after API metadata and visible-frame waits', async () => {
  for (const phase of ['metadata', 'iframe']) {
    const { opening, state, options } = openingHarness(phase)
    const result = await opening.openApiWorkflowInComfyUi(apiGraph(), options)
    assert.equal(result.success, false)
    assert.equal(state.loads.length, 0)
  }
  const { opening, state, options } = openingHarness('iframe')
  assert.equal((await opening.openUiWorkflowInComfyUi(ui(), options)).success, false)
  assert.equal(state.loads.length, 0)
})

test('guarded graph open forwards expected context while legacy callers remain compatible', async () => {
  const { opening, state, options } = openingHarness('none')
  assert.equal((await opening.openUiWorkflowInComfyUi(ui(), options)).success, true)
  assert.deepEqual(plain(state.loads[0].expectedContext), options.expectedContext)
  assert.equal((await opening.openApiWorkflowInComfyUi(apiGraph())).success, true)
  assert.equal(Object.hasOwn(state.loads[1], 'expectedContext'), false)
})
