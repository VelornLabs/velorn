import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import { validateApiWorkflow, buildApiWorkflowMetadata, API_WORKFLOW_LIMITS } from '../electron/workflowApiGraph.mjs'
import { applyImportedWorkflowBindings } from '../src/services/importedWorkflowBindings.js'
const require = createRequire(import.meta.url)
const { createManagedApiWorkflowStore, loadManagedWorkflowCatalog } = require('../electron/managedApiWorkflows.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { createAgentToolSession } = require('../electron/connectedAgentTools.cjs')

const graph = () => ({
  '1': { class_type: 'LoadImage', inputs: { image: 'reference.png' } },
  '2': { class_type: 'LoadAudio', inputs: { audio: 'vocal.wav' } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: 'A short performance' } },
  '4': { class_type: 'KSampler', inputs: { positive: ['3', 0], image: ['1', 0], audio: ['2', 0], seed: 42, steps: 8, length: 73, fps: 24 } },
  '5': { class_type: 'SaveVideo', inputs: { video: ['4', 0], filename_prefix: 'video/audition' } },
})
const request = extra => ({ workflowJson: graph(), name: 'audition', title: 'Synthetic audition', ...extra })
const available = async ({ nodeClasses }) => ({ validation: { ok: true, available: nodeClasses, missing: [] } })
test('catalog inspects completed UI-converted imports without modifying provenance or files', async t => {
  const { root, store } = await fixture(t)
  const preview = await store.importWorkflow(request())
  const saved = await store.importWorkflow(request(preview.suggestedApplyPayload))
  const entryFile = path.join(path.dirname(saved.entry.workflowPath), 'entry.json')
  const entry = JSON.parse(await fs.readFile(entryFile, 'utf8'))
  entry.source = { workflowUrl: '', sourceUrl: 'https://example.org/template.json' }
  await fs.writeFile(entryFile, JSON.stringify(entry))
  const before = await fs.readFile(entryFile, 'utf8')
  const beforeGraph = await fs.readFile(saved.entry.workflowPath, 'utf8')
  const catalog = await loadManagedWorkflowCatalog(root)
  assert.deepEqual(catalog.errors, [])
  assert.equal(catalog.workflows[0].id, entry.workflowId)
  assert.match(catalog.workflows[0].sourceFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(await fs.readFile(entryFile, 'utf8'), before)
  assert.equal(await fs.readFile(saved.entry.workflowPath, 'utf8'), beforeGraph)
  entry.manifest.runnable = false
  await fs.writeFile(entryFile, JSON.stringify(entry))
  assert.equal((await loadManagedWorkflowCatalog(root)).workflows[0].mcpRunnable, false)
  entry.conversionIncomplete = true
  await fs.writeFile(entryFile, JSON.stringify(entry))
  assert.equal((await loadManagedWorkflowCatalog(root)).workflows.length, 0)
  entry.conversionIncomplete = false
  await fs.writeFile(entryFile, JSON.stringify(entry))
  await fs.writeFile(saved.entry.workflowPath, JSON.stringify({ nodes: [] }))
  const invalid = await loadManagedWorkflowCatalog(root)
  assert.equal(invalid.workflows.length, 0)
  assert.equal(invalid.errors.length, 1)
  await fs.unlink(saved.entry.workflowPath)
  assert.equal((await loadManagedWorkflowCatalog(root)).workflows.length, 0)
  await fs.symlink(entryFile, saved.entry.workflowPath)
  assert.match((await loadManagedWorkflowCatalog(root)).errors[0], /unsafe/)
})
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-api-workflow-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { root, store: createManagedApiWorkflowStore({ getUserData: () => root, validateNodes: available, ...options }) }
}

test('API contract clones scalar/link graphs and exposes exact safe queue bindings', () => {
  const source = graph(), clone = validateApiWorkflow(source)
  assert.notEqual(clone, source)
  const result = buildApiWorkflowMetadata(source, { name: 'audition' })
  assert.equal(result.workflowId, 'tpl-mcp-audition')
  assert.equal(result.outputType, 'video')
  assert.deepEqual(result.bindings.prompt, { nodeId: '3', inputKey: 'text' })
  assert.deepEqual(result.bindings.assets.map(item => [item.fieldId, item.assetType]), [['asset', 'image'], ['templateInput1', 'audio']])
  assert.ok(result.bindings.parameters.some(item => item.fieldId === 'node_4_length' && item.defaultValue === 73))
  assert.ok(!result.bindings.parameters.some(item => ['image', 'audio', 'filename_prefix'].includes(item.inputKey)))
  const bound = applyImportedWorkflowBindings(source, result.bindings, { prompt: 'New approved phrase', seed: 123,
    inputImage: 'uploaded-reference.png', assetFieldFilenames: { templateInput1: 'approved-vocal.wav' },
    templateParameters: { node_4_length: 97 }, filenamePrefix: 'video/approved-audition' })
  validateApiWorkflow(bound)
  assert.equal(bound['1'].inputs.image, 'uploaded-reference.png')
  assert.equal(bound['2'].inputs.audio, 'approved-vocal.wav')
  assert.equal(bound['3'].inputs.text, 'New approved phrase')
  assert.equal(bound['4'].inputs.length, 97)
  assert.equal(bound['4'].inputs.fps, 24)
  assert.equal(source['4'].inputs.length, 73, 'Queue binding never changes the stored source graph')
})

test('rejects malformed, cyclic, dangling, prototype and unsafe file/credential values', () => {
  for (const mutate of [
    value => { value['4'].inputs.image = ['missing', 0] },
    value => { value['4'].inputs.image = ['1', -1] },
    value => { value['1'].inputs.image = ['4', 0] },
    value => { value['1'].inputs.image = '../private.png' },
    value => { value['1'].inputs.image = '/private.png' },
    value => { value['2'].inputs.audio = 'C:\\private.wav' },
    value => { value['1'].inputs.image = 'https://host.example/private.png' },
    value => { value['4'].inputs.steps = Infinity },
    value => { value['4'].inputs.options = { list: [1] } },
    value => { value['4'].inputs.api_key = 'not-a-real-secret' },
    value => { value['4'].inputs = JSON.parse('{"__proto__":{}}') },
    value => { value['4'].constructor = {} },
    value => { value['4'].inputs.self = value },
  ]) { const value = graph(); mutate(value); assert.throws(() => validateApiWorkflow(value)) }
  const deep = graph(); let nested = deep['1']._meta = {}
  for (let i = 0; i < 15; i++) nested = nested.next = {}
  assert.throws(() => validateApiWorkflow(deep), /depth/)
  const many = Object.fromEntries(Array.from({ length: API_WORKFLOW_LIMITS.nodes + 1 }, (_, i) => [String(i), { class_type: 'PrimitiveInt', inputs: { value: i } }]))
  assert.throws(() => validateApiWorkflow(many), /200 nodes/)
  const big = graph(); for (let i = 0; i < 4; i++) big['3'].inputs[`text${i}`] = 'x'.repeat(30000)
  assert.throws(() => validateApiWorkflow(big), /96 KiB/)
})

test('preview is write-free and native apply requires exact source/target fingerprints', async t => {
  const { root, store } = await fixture(t)
  const preview = await store.importWorkflow(request())
  assert.equal(preview.previewOnly, true)
  assert.equal(preview.plan.targetFingerprint, 'absent')
  assert.deepEqual(await fs.readdir(root), [])
  await assert.rejects(store.importWorkflow(request({ previewOnly: false })), /Preview again/)
  const changed = graph(); changed['4'].inputs.length = 121
  await assert.rejects(store.importWorkflow(request({ ...preview.suggestedApplyPayload, workflowJson: changed })), /Preview again/)
  const applied = await store.importWorkflow(request(preview.suggestedApplyPayload))
  assert.equal(applied.success, true)
  assert.equal(applied.entry.source.format, 'api')
  assert.deepEqual(JSON.parse(await fs.readFile(applied.entry.workflowPath, 'utf8')), validateApiWorkflow(graph()))
  const catalog = await loadManagedWorkflowCatalog(root)
  assert.equal(catalog.workflows.length, 1)
  assert.equal(catalog.workflows[0].source, 'imported')
  assert.equal(catalog.workflows[0].id, 'tpl-mcp-audition')
  await assert.rejects(store.importWorkflow(request(preview.suggestedApplyPayload)), /already exists/)
})

test('managed overwrite preserves a recoverable backup and rejects stale target changes', async t => {
  const { store } = await fixture(t)
  const initial = await store.importWorkflow(request())
  const saved = await store.importWorkflow(request(initial.suggestedApplyPayload))
  const updated = graph(); updated['4'].inputs.length = 97
  const args = request({ workflowJson: updated, overwrite: true })
  const preview = await store.importWorkflow(args)
  await fs.writeFile(saved.entry.workflowPath, JSON.stringify(graph()) + ' ')
  await assert.rejects(store.importWorkflow({ ...args, ...preview.suggestedApplyPayload }), /Preview again/)
  const fresh = await store.importWorkflow(args)
  const result = await store.importWorkflow({ ...args, ...fresh.suggestedApplyPayload })
  assert.ok(result.backupId)
  const previous = path.join(path.dirname(path.dirname(saved.entry.workflowPath)), result.backupId, 'workflow.json')
  assert.equal(JSON.parse(await fs.readFile(previous, 'utf8'))['4'].inputs.length, 73)
  assert.equal(JSON.parse(await fs.readFile(result.entry.workflowPath, 'utf8'))['4'].inputs.length, 97)
})

test('missing nodes remain explicitly non-runnable; import never installs or queues', async t => {
  const { store } = await fixture(t, { validateNodes: async () => ({ validation: { ok: false, missing: ['KSampler'] } }) })
  const preview = await store.importWorkflow(request())
  const result = await store.importWorkflow(request(preview.suggestedApplyPayload))
  assert.equal(result.runnable, false)
  assert.deepEqual(result.entry.manifest.unknownNodeTypes, ['KSampler'])
  assert.deepEqual(result.entry.nodePackRecipes, [])
})

test('rejects traversal names and symlink targets and rechecks cancellation immediately before commit', async t => {
  const { root, store } = await fixture(t)
  for (const name of ['../outside', 'a/b', 'A', 'tpl-mcp-x', 'a'.repeat(49)]) {
    if (name === 'tpl-mcp-x') continue // A safe slug creates its own managed copy, never that source id.
    await assert.rejects(store.importWorkflow(request({ name })), /slug/)
  }
  await fs.mkdir(path.join(root, 'generate-templates'))
  const outside = path.join(root, 'protected'); await fs.mkdir(outside)
  await fs.symlink(outside, path.join(root, 'generate-templates', 'mcp-audition'))
  await assert.rejects(store.importWorkflow(request()), /unsafe|symbolic/)
  assert.deepEqual(await fs.readdir(outside), [])
  const other = await fixture(t, { beforeCommit: async () => { throw new Error('canceled before commit') } })
  const preview = await other.store.importWorkflow(request())
  await assert.rejects(other.store.importWorkflow(request(preview.suggestedApplyPayload)), /canceled/)
  assert.deepEqual(await fs.readdir(path.join(other.root, 'generate-templates')), [])
})

test('existing import tool accepts API inline JSON, suggests exact apply and registers without queueing', async t => {
  const { store } = await fixture(t)
  const actions = []
  const server = createComfyStudioMcpServer({ importManagedApiWorkflow: args => store.importWorkflow(args),
    performAction: async request => { actions.push(request); return { success: true } } })
  const first = JSON.parse((await server.importComfyUiWorkflowTool(request())).content[0].text)
  assert.equal(first.previewOnly, true)
  assert.equal(first.suggestedApplyCall.tool, 'import_comfyui_workflow')
  assert.equal(first.suggestedApplyCall.arguments.sourceFingerprint, first.plan.sourceFingerprint)
  assert.equal(actions.length, 0)
  const saved = JSON.parse((await server.importComfyUiWorkflowTool(first.suggestedApplyCall.arguments)).content[0].text)
  assert.equal(saved.success, true)
  assert.equal(saved.registered, true)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].action, 'import_comfyui_workflow')
  assert.equal(actions[0].payload.registerManagedApiEntry.source.format, 'api')
  assert.equal(saved.entry, undefined)
})

test('failed renderer refresh reports saved state instead of retrying or claiming queue success', async t => {
  const { store } = await fixture(t)
  const server = createComfyStudioMcpServer({ importManagedApiWorkflow: args => store.importWorkflow(args), performAction: async () => { throw new Error('renderer unavailable') } })
  const preview = JSON.parse((await server.importComfyUiWorkflowTool(request())).content[0].text)
  const result = JSON.parse((await server.importComfyUiWorkflowTool(preview.suggestedApplyCall.arguments)).content[0].text)
  assert.equal(result.success, true)
  assert.equal(result.registered, false)
  assert.match(result.warning, /saved on disk/)
})

test('same existing inspection tool forwards only explicit graph opt-in', async () => {
  const seen = []
  const server = createComfyStudioMcpServer({ inspectComfyStudioWorkflow: async options => { seen.push(options); return { success: true } } })
  await server.inspectComfyStudioWorkflowTool({ workflowId: 'ltx23-i2v' })
  await server.inspectComfyStudioWorkflowTool({ workflowId: 'tpl-mcp-audition', includeGraph: true })
  assert.equal(seen[0].includeGraph, false)
  assert.equal(seen[1].includeGraph, true)
  assert.equal(server.tools.filter(tool => tool.name === 'import_comfyui_workflow').length, 1)
  assert.equal(server.tools.filter(tool => tool.name === 'inspect_velorn_workflow').length, 1)
})

test('native commit rejects a newly changed target after preparation and leaves it intact', async t => {
  let changed = false
  const { root, store } = await fixture(t, { beforeCommit: async () => {
    if (!changed) return
    const filename = path.join(root, 'generate-templates', 'mcp-audition', 'workflow.json')
    await fs.appendFile(filename, ' ')
  } })
  const first = await store.importWorkflow(request())
  await store.importWorkflow(request(first.suggestedApplyPayload))
  const args = request({ overwrite: true })
  const preview = await store.importWorkflow(args)
  changed = true
  await assert.rejects(store.importWorkflow({ ...args, ...preview.suggestedApplyPayload }), /changed before commit/)
  const listing = await fs.readdir(path.join(root, 'generate-templates'))
  assert.deepEqual(listing, ['mcp-audition'])
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'generate-templates', 'mcp-audition', 'workflow.json'), 'utf8'))['4'].inputs.length, 73)
})

test('Agent import approval gates the actual native save even with edit auto-approval enabled', async t => {
  const { root, store } = await fixture(t)
  const actions = [], approvals = []
  const server = createComfyStudioMcpServer({ importManagedApiWorkflow: args => store.importWorkflow(args),
    performAction: async action => { actions.push(action); return { success: true } } })
  const context = { session: 'synthetic-session', projectKey: '/synthetic-project', timelineId: 'synthetic-timeline', timelineSessionId: 1, compoundClipId: null, revision: 1 }
  let allow = false
  const session = await createAgentToolSession({ getServer: () => server, expectedContext: context,
    getContext: async () => ({ context }), autoApproveEdits: true,
    requestApproval: async approval => { approvals.push(approval); return allow },
    executeTool: (name, args) => server.callTool(name, args) })
  const denied = await session.callTool('import_comfyui_workflow', request({ previewOnly: false }))
  assert.equal(denied.isError, true)
  assert.equal(approvals.length, 1)
  assert.deepEqual(await fs.readdir(root), [])
  assert.equal(actions.length, 0)
  allow = true
  const saved = await session.callTool('import_comfyui_workflow', request({ previewOnly: false }))
  assert.equal(saved.isError, undefined)
  assert.equal(JSON.parse(saved.content[0].text).success, true)
  assert.equal(approvals.length, 2)
  assert.match(approvals[1].arguments.sourceFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].action, 'import_comfyui_workflow')
})

test('complete graph inspection fails explicitly at the response boundary without partial JSON', async () => {
  const server = createComfyStudioMcpServer({ inspectComfyStudioWorkflow: async () => ({ success: true, workflowJson: { tooLarge: 'x'.repeat(121 * 1024) } }) })
  const result = await server.inspectComfyStudioWorkflowTool({ includeGraph: true })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /bounded response limit/)
  assert.ok(result.content[0].text.length < 500)
})

test('large inline JSON is canonicalized to a complete bounded suggested apply payload', async t => {
  const { store } = await fixture(t)
  const large = graph()
  for (let i = 0; i < 3; i++) large['3'].inputs[`description${i}`] = 'x'.repeat(30000)
  const server = createComfyStudioMcpServer({ importManagedApiWorkflow: args => store.importWorkflow(args), performAction: async () => ({ success: true }) })
  const result = await server.importComfyUiWorkflowTool(request({ workflowJson: JSON.stringify(large, null, 4) }))
  assert.equal(result.isError, undefined)
  assert.ok(Buffer.byteLength(result.content[0].text) < 120 * 1024)
  assert.deepEqual(JSON.parse(result.content[0].text).suggestedApplyCall.arguments.workflowJson, large)
})

test('renderer reload ignores native staging and recoverable backups', async t => {
  const { root, store } = await fixture(t)
  const first = await store.importWorkflow(request())
  await store.importWorkflow(request(first.suggestedApplyPayload))
  const next = graph(); next['4'].inputs.length = 97
  const args = request({ workflowJson: next, overwrite: true })
  const preview = await store.importWorkflow(args)
  const saved = await store.importWorkflow({ ...args, ...preview.suggestedApplyPayload })
  const previousWindow = globalThis.window
  globalThis.window = { dispatchEvent() {}, electronAPI: {
    getAppPath: async () => root, pathJoin: async (...parts) => path.join(...parts),
    listDirectory: async () => ({ success: true, items: ['mcp-audition', saved.backupId] }),
    readFile: async filename => ({ success: true, data: await fs.readFile(filename, 'utf8') }),
  } }
  try {
    const registry = await import('../src/config/importedWorkflowRegistry.js?managed-api-test')
    await registry.loadImportedWorkflowsFromDisk()
    assert.equal(registry.getImportedWorkflowEntries().length, 1)
    assert.equal(registry.getImportedWorkflowEntry('tpl-mcp-audition').workflowPath, saved.entry.workflowPath)
    assert.equal(registry.getImportedWorkflowEntry('tpl-mcp-audition').bindings.parameters.find(item => item.fieldId === 'node_4_length').defaultValue, 97)
  } finally { globalThis.window = previousWindow }
})

test('actual Generate parameter merge rejects generic keys and preserves exact API defaults', async () => {
  const source = await fs.readFile(new URL('../src/components/GenerateWorkspace.jsx', import.meta.url), 'utf8')
  const start = source.indexOf('const mergeTemplateParameters = ')
  const end = source.indexOf('\n\n        const templateInput', start)
  assert.ok(start > 0 && end > start)
  const merge = new Function('aspectParametersFromResolution', `${source.slice(start, end)}; return mergeTemplateParameters`)(() => ({ width: 16, height: 9 }))
  const metadata = buildApiWorkflowMetadata(graph(), { name: 'audition' })
  const entry = { source: { format: 'api' }, bindings: metadata.bindings }
  assert.deepEqual(merge({}, {}, { width: 1280, height: 720 }, entry), {})
  assert.deepEqual(merge({ templateParameters: { node_4_length: 73 } }, { parameters: { node_4_length: 97 } }, { width: 1280, height: 720 }, entry), { node_4_length: 97 })
  assert.throws(() => merge({}, { parameters: { durationSeconds: 3 } }, {}, entry), /exact inspected/)
  assert.throws(() => merge({}, { parameters: { width: 1280 } }, {}, entry), /exact inspected/)
  assert.equal(merge({}, {}, { width: 1280, height: 720 }, {}).width, 1280, 'Existing UI-template resolution inference stays intact')
})

for (const converted of [false, true]) test(`actual native inspect returns complete graph and fingerprints (UI converted: ${converted})`, async t => {
  const { root, store } = await fixture(t)
  const preview = await store.importWorkflow(request())
  const saved = await store.importWorkflow(request(preview.suggestedApplyPayload))
  if (converted) {
    const entryFile = path.join(path.dirname(saved.entry.workflowPath), 'entry.json')
    const entry = JSON.parse(await fs.readFile(entryFile, 'utf8'))
    entry.source = { workflowUrl: '', sourceUrl: 'https://example.org/template.json' }
    await fs.writeFile(entryFile, JSON.stringify(entry))
  }
  const catalog = await loadManagedWorkflowCatalog(root)
  const source = await fs.readFile(new URL('../electron/main.js', import.meta.url), 'utf8')
  const start = source.indexOf('async function inspectComfyStudioWorkflowInternal(')
  const end = source.indexOf('\nfunction summarizeComfyLauncherLogIssues', start)
  assert.ok(start > 0 && end > start)
  const body = source.slice(start, end).replace("import('./workflowApiGraph.mjs')", `import(${JSON.stringify(new URL('../electron/workflowApiGraph.mjs', import.meta.url).href)})`)
  const inspect = new Function('resolveMcpWorkflowReference', 'readBoundedWorkflowFile', 'fs', 'crypto', 'collectWorkflowClassTypes', 'loadMcpNodeHintManifest', 'validateComfyUINodesInternal', 'buildWorkflowNodeHints', 'savedWorkflowLibrary', `${body}; return inspectComfyStudioWorkflowInternal`)(
    async () => ({ success: true, workflow: catalog.workflows[0] }), require('../electron/managedApiWorkflows.cjs').readBounded, fs, crypto,
    value => new Set(Object.values(value).map(node => node.class_type)), async () => ({ success: true }), available, () => [],
    require('../electron/savedWorkflowLibrary.cjs').createSavedWorkflowLibrary({ getUserData: () => root }))
  const result = await inspect({ includeGraph: true, includeValidation: false })
  assert.equal(result.success, true)
  assert.deepEqual(result.workflowJson, validateApiWorkflow(graph()))
  assert.deepEqual(result.bindings, saved.entry.bindings)
  assert.equal(result.targetFingerprint, catalog.workflows[0].targetFingerprint)
  assert.match(result.graphFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(result.copyOnly, false)
})

test('actual imported API revalidation uses the saved graph without UI conversion or remote template fetch', async t => {
  const { store } = await fixture(t)
  const preview = await store.importWorkflow(request())
  const saved = await store.importWorkflow(request(preview.suggestedApplyPayload))
  const entry = { ...saved.entry, manifest: { ...saved.entry.manifest, runnable: false } }
  const source = await fs.readFile(new URL('../src/services/templateImporter.js', import.meta.url), 'utf8')
  const start = source.indexOf('export async function reimportImportedWorkflow(')
  const end = source.indexOf('\n// When the user opens', start)
  assert.ok(start > 0 && end > start)
  const body = source.slice(start, end).replace('export async function', 'async function')
    .replace("import('../../electron/workflowApiGraph.mjs')", `import(${JSON.stringify(new URL('../electron/workflowApiGraph.mjs', import.meta.url).href)})`)
  let availableClasses = Object.fromEntries(Object.values(graph()).map(node => [node.class_type, {}]))
  const revalidate = new Function('getImportedWorkflowEntry', 'window', 'comfyui', 'registerImportedWorkflow', `${body}; return reimportImportedWorkflow`)(
    () => entry, { electronAPI: { readFile: async filename => ({ success: true, data: await fs.readFile(filename, 'utf8') }) } },
    { getObjectInfo: async () => availableClasses }, value => value)
  const result = await revalidate(entry.workflowId)
  assert.equal(result.entry.manifest.runnable, true)
  assert.deepEqual(result.entry.bindings, saved.entry.bindings)
  assert.equal(result.entry.workflowPath, saved.entry.workflowPath)
  availableClasses = {}
  await assert.rejects(revalidate(entry.workflowId), /missing node classes/)
})

test('a widget setting stored as a small bundle of scalars is accepted, anything looser is not', () => {
  const graph = extra => ({ 1: { class_type: 'LoadImage', inputs: { image: 'a.png' } }, 2: { class_type: 'ImageCompare', inputs: { image_a: ['1', 0], ...extra } } })
  assert.doesNotThrow(() => validateApiWorkflow(graph({ compare_view: { __value__: { 0: '', 1: '' } } })))
  for (const bad of [
    { compare_view: { __value__: ['1', 0] } }, // a list could pass for a node link
    { compare_view: { a: { b: { c: { d: 1 } } } } }, // too deep
    { compare_view: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i, i])) }, // too many values
    { compare_view: { path: '/etc/passwd' } }, { compare_view: { note: 'sk-abcdefghijklmnop' } },
    { image: { __value__: 'https://example.com/a.png' } }, { api_key: { __value__: 'x' } },
  ]) assert.throws(() => validateApiWorkflow(graph(bad)), JSON.stringify(bad))
})
