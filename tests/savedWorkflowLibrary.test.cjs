'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createSavedWorkflowLibrary, registerSavedWorkflowLibraryIpc, CHANNELS, prepareApiGraph } = require('../electron/savedWorkflowLibrary.cjs')
const { createManagedApiWorkflowStore } = require('../electron/managedApiWorkflows.cjs')
const { createGenerationRuns } = require('../electron/generationRuns.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const graph = () => ({ '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'Old prompt' } },
  '2': { class_type: 'KSampler', inputs: { seed: 12, steps: 4, positive: ['1', 0] } },
  '3': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'review' } } })
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-saved-workflows-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dir = path.join(root, 'custom-workflows'); await fs.mkdir(dir)
  const record = { id: 'unmarked', title: 'Unmarked graph', description: 'Saved look',
    uiWorkflow: { nodes: [{ id: 1, type: 'KSampler' }] }, apiWorkflow: graph(), updatedAt: 1 }
  const file = path.join(dir, 'unmarked.json'); await fs.writeFile(file, JSON.stringify(record))
  const library = createSavedWorkflowLibrary({ getUserData: () => root })
  return { root, dir, file, record, library }
}
test('fresh listing unifies existing stores, excludes bundled files, and has no filesystem paths', async t => {
  const f = await fixture(t)
  const store = createManagedApiWorkflowStore({ getUserData: () => f.root, validateNodes: async () => ({ validation: { ok: true } }) })
  const args = { name: 'remembered', workflowJson: graph() }
  const plan = await store.importWorkflow(args); await store.importWorkflow({ ...args, ...plan.suggestedApplyPayload })
  const listed = await f.library.list()
  assert.equal(listed.success, true); assert.equal(listed.workflows.length, 2)
  assert.deepEqual(listed.workflows.map(item => item.source).sort(), ['imported', 'my-workflows'])
  assert.ok(listed.workflows.every(item => item.savedRunsReady === true && item.readiness === 'needs-review'))
  assert.equal(listed.workflows[0].description, 'Saved look')
  assert.ok(!JSON.stringify(listed).includes(f.root)); assert.ok(!JSON.stringify(listed).includes('workflowPath'))
  f.record.title = 'Renamed'; await fs.writeFile(f.file, JSON.stringify(f.record))
  assert.equal((await f.library.list()).workflows[0].title, 'Renamed')
  assert.equal((await f.library.prepare({ workflowId: 'tpl-mcp-remembered' })).success, true)
})
test('UI-only legacy entries are visible but honestly blocked, and reading does not convert or write', async t => {
  const f = await fixture(t); delete f.record.apiWorkflow; await fs.writeFile(f.file, JSON.stringify(f.record))
  const original = await fs.readFile(f.file, 'utf8')
  const listed = await f.library.list(); assert.equal(listed.workflows[0].readiness, 'needs-api-capture')
  const read = await f.library.read({ workflowId: 'my-workflow:unmarked' })
  assert.equal(read.format, 'ui'); assert.deepEqual(read.uiWorkflow, f.record.uiWorkflow)
  const prepared = await f.library.prepare({ workflowId: 'my-workflow:unmarked' })
  assert.equal(prepared.ready, false); assert.match(prepared.error, /save it to Velorn again/)
  assert.equal(await fs.readFile(f.file, 'utf8'), original)
})
test('captured API graph needs no markers; precise overrides clone the original and produce exact fingerprints', async t => {
  const f = await fixture(t), original = await fs.readFile(f.file, 'utf8')
  const basic = await f.library.prepare({ workflowId: 'my-workflow:unmarked' })
  const revised = await f.library.prepare({ workflowId: 'my-workflow:unmarked', inputOverrides: [{ nodeId: '1', input: 'value', value: 'Approved prompt' }] })
  assert.equal(basic.success, true); assert.equal(revised.success, true)
  assert.equal(revised.workflow['1'].inputs.value, 'Approved prompt')
  assert.equal(basic.graphFingerprint, revised.graphFingerprint)
  assert.notEqual(revised.resolvedFingerprint, basic.resolvedFingerprint)
  assert.equal(await fs.readFile(f.file, 'utf8'), original)
})
test('overrides reject links, missing targets, duplicate targets, unsafe media/credentials and type changes', async () => {
  for (const inputOverrides of [
    [{ nodeId: 'missing', input: 'value', value: 'x' }], [{ nodeId: '1', input: 'missing', value: 'x' }],
    [{ nodeId: '2', input: 'positive', value: 'x' }], [{ nodeId: '2', input: 'steps', value: '12' }],
    [{ nodeId: '2', input: 'steps', value: Infinity }], [{ nodeId: '1', input: 'value', value: {} }],
    [{ nodeId: '1', input: 'value', value: 'sk-unsafecredential123456789' }],
    [{ nodeId: '3', input: 'filename_prefix', value: '../escape' }],
    [{ nodeId: '3', input: 'filename_prefix', value: '/private/path' }],
    [{ nodeId: '1', input: 'value', value: 'x' }, { nodeId: '1', input: 'value', value: 'y' }],
  ]) await assert.rejects(prepareApiGraph(graph(), { inputOverrides }))
})
test('ID resolution refuses arbitrary paths, bundled IDs, aliases, symlink records and oversized records', async t => {
  const f = await fixture(t)
  for (const workflowId of [f.file, 'z-image-turbo', 'my-workflow:../unmarked', 'my-workflow:missing', 'tpl-mcp-missing']) {
    assert.equal((await f.library.prepare({ workflowId })).success, false)
  }
  await fs.symlink(f.file, path.join(f.dir, 'alias.json'))
  await fs.writeFile(path.join(f.dir, 'oversized.json'), 'x'.repeat(4 * 1024 * 1024 + 1))
  assert.equal((await f.library.list()).workflows.length, 1)
  await fs.rename(f.file, path.join(f.root, 'outside.json'))
  await fs.symlink(path.join(f.root, 'outside.json'), f.file)
  assert.equal((await f.library.prepare({ workflowId: 'my-workflow:unmarked' })).success, false)
})
test('saved queue previews and uses existing broker only after both exact fingerprints match', async t => {
  const f = await fixture(t), calls = []
  const manager = createGenerationRuns({ storageDir: path.join(f.root, 'runs'), getEndpoint: () => 'http://127.0.0.1:8188',
    getContext: () => ({ session: 's', projectKey: 'p', timelineId: 't' }), resolveSavedWorkflow: f.library.prepare,
    submitManaged: async args => { calls.push(args); return { success: false, code: 'SYNTHETIC_SPENDING_DENIED' } } })
  t.after(() => manager.dispose())
  const args = { workflowId: 'my-workflow:unmarked', inputOverrides: [{ nodeId: '2', input: 'seed', value: 98 }] }
  const preview = await manager.submit(args)
  assert.equal(preview.success, true); assert.equal(preview.previewOnly, true); assert.equal(calls.length, 0)
  assert.equal(preview.suggestedApplyPayload.previewOnly, false)
  assert.match(preview.message, /opens native confirmation automatically under ask-cloud/)
  assert.equal((await manager.submit({ ...args, previewOnly: false })).success, false)
  const apply = { ...args, previewOnly: false, graphFingerprint: preview.graphFingerprint, resolvedFingerprint: preview.resolvedFingerprint }
  assert.equal((await manager.submit({ ...apply, inputOverrides: [{ nodeId: '2', input: 'seed', value: 99 }] })).code, 'GENERATION_RUNS_SAVED_WORKFLOW_CHANGED')
  assert.equal(calls.length, 0)
  assert.equal((await manager.submit(apply)).code, 'SYNTHETIC_SPENDING_DENIED')
  assert.equal(calls.length, 1); assert.equal(calls[0].workflow['2'].inputs.seed, 98)
  assert.equal(calls[0].savedWorkflowId, 'my-workflow:unmarked')
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).apiWorkflow['2'].inputs.seed, 12)
  f.record.apiWorkflow['2'].inputs.seed = 100; await fs.writeFile(f.file, JSON.stringify(f.record))
  assert.equal((await manager.submit(apply)).code, 'GENERATION_RUNS_SAVED_WORKFLOW_CHANGED'); assert.equal(calls.length, 1)
  assert.equal((await manager.submit({ ...args, workflow: graph() })).success, false)
  assert.equal((await manager.submit({ workflow: graph(), inputOverrides: [] })).success, false)
})
test('saved resolution cannot cross a project switch or export guard into the broker', async t => {
  const f = await fixture(t); let context = { session: 's', projectKey: 'p', timelineId: 't' }, submitted = 0
  const prepared = await f.library.prepare({ workflowId: 'my-workflow:unmarked' })
  const manager = createGenerationRuns({ getEndpoint: () => 'http://127.0.0.1:8188', getContext: () => ({ ...context }),
    resolveSavedWorkflow: async args => { context.projectKey = 'other'; return f.library.prepare(args) }, submitManaged: async () => { submitted++ } })
  t.after(() => manager.dispose())
  assert.equal((await manager.submit({ workflowId: prepared.workflowId, graphFingerprint: prepared.graphFingerprint, resolvedFingerprint: prepared.resolvedFingerprint, previewOnly: false })).code, 'GENERATION_RUNS_STALE_CONTEXT')
  assert.equal(submitted, 0)
})
test('public MCP saved-ID route stays native, defaults to preview and rejects mixed sources', async () => {
  const received = []
  const server = createComfyStudioMcpServer({ generationRuns: { submit: async args => { received.push(args); return { success: true, ...args } } }, performAction: () => { throw new Error('Generate renderer must not mount') } })
  server.updateSnapshot({ project: { name: 'Synthetic', path: '/synthetic' }, currentTimeline: { id: 't', clips: [], tracks: [] }, assets: [] })
  const result = await server.callTool('queue_comfyui_workflow', { workflowId: 'my-workflow:unmarked', inputOverrides: [] })
  assert.equal(result.isError, undefined); assert.equal(received[0].previewOnly, true)
  assert.equal((await server.callTool('queue_comfyui_workflow', { workflowId: 'my-workflow:unmarked', workflow: graph() })).isError, true)
  assert.equal(received.length, 1)
})
test('restricted agent approval receives exact saved fingerprints from automatic preview before broker dispatch', async t => {
  const f = await fixture(t), approvals = [], brokerCalls = []
  const context = { schemaVersion: 1, session: 's', projectKey: '/synthetic', timelineId: 't', timelineSessionId: 1, compoundClipId: null, storyboardRevision: 0, revision: 0 }
  const manager = createGenerationRuns({ getEndpoint: () => 'http://127.0.0.1:8188', getContext: () => ({ ...context }),
    resolveSavedWorkflow: f.library.prepare, submitManaged: async args => { brokerCalls.push(args); return { success: false, code: 'SYNTHETIC_SPENDING_DENIED', error: 'Synthetic spending denial' } } })
  t.after(() => manager.dispose())
  const server = createComfyStudioMcpServer({ generationRuns: manager })
  server.updateSnapshot({ project: { name: 'Synthetic', path: '/synthetic' }, currentTimeline: { id: 't', clips: [], tracks: [] }, assets: [] })
  let approve = false
  const session = await require('../electron/connectedAgentTools.cjs').createAgentToolSession({ getServer: () => server, expectedContext: context,
    getContext: async () => ({ context }), autoApproveEdits: true,
    requestApproval: async request => { approvals.push(request); return approve }, executeTool: (name, args) => server.callTool(name, args) })
  const args = { workflowId: 'my-workflow:unmarked', inputOverrides: [{ nodeId: '2', input: 'seed', value: 321 }], previewOnly: false }
  assert.equal((await session.callTool('queue_comfyui_workflow', args)).isError, true)
  assert.equal(brokerCalls.length, 0); assert.equal(approvals.length, 1)
  assert.match(approvals[0].arguments.graphFingerprint, /^[a-f0-9]{64}$/)
  assert.match(approvals[0].arguments.resolvedFingerprint, /^[a-f0-9]{64}$/)
  approve = true
  const applied = await session.callTool('queue_comfyui_workflow', args)
  assert.equal(applied.isError, true, 'The shared spending broker denial still wins after tool approval')
  assert.equal(approvals.length, 2); assert.equal(brokerCalls.length, 1); assert.equal(brokerCalls[0].workflow['2'].inputs.seed, 321)
})
test('saved IPC restricts every method to the current main frame and accepts only IDs', async () => {
  const handlers = new Map(), calls = [], frame = {}, contents = { mainFrame: frame, isDestroyed: () => false }
  let window = { webContents: contents, isDestroyed: () => false }
  const registration = registerSavedWorkflowLibraryIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    getMainWindow: () => window, getLibrary: () => Object.fromEntries(['list', 'read', 'prepare'].map(method => [method, async args => { calls.push(args); return { success: true } }])) })
  const event = { sender: contents, senderFrame: frame }
  for (const channel of Object.values(CHANNELS)) {
    assert.equal((await handlers.get(channel)(event, {})).success, true)
    assert.equal((await handlers.get(channel)({ ...event, senderFrame: {} }, {})).success, false)
    assert.equal((await handlers.get(channel)({ ...event, sender: {} }, {})).success, false)
    assert.equal((await handlers.get(channel)(event, { workflowPath: '/private.json' })).success, false)
  }
  assert.equal(calls.length, 3); registration.dispose(); assert.equal(handlers.size, 0)
})

test('saved reads reject an entire symlinked library directory', async t => {
  const f = await fixture(t), moved = path.join(f.root, 'moved-library')
  await fs.rename(f.dir, moved); await fs.symlink(moved, f.dir)
  assert.equal((await f.library.list()).workflows.length, 0)
  assert.equal((await f.library.prepare({ workflowId: 'my-workflow:unmarked' })).success, false)
})
test('graph plus parameter bindings is bounded before any complete inspection response is sent', async () => {
  const large = { '1': { class_type: 'CustomParameters', inputs: {}, _meta: { a: 'a'.repeat(28000), b: 'b'.repeat(28000) } } }
  for (let index = 0; index < 128; index++) large['1'].inputs[`parameter_${index}_${'long'.repeat(25)}`] = index
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 96 * 1024)
  await assert.rejects(prepareApiGraph(large), /bounded inspection limit/)
})
test('saved IPC invalidates delayed results if the main window changes', async () => {
  const handlers = new Map(), frame = {}, contents = { mainFrame: frame, isDestroyed: () => false }
  let window = { webContents: contents, isDestroyed: () => false }, resolve
  registerSavedWorkflowLibraryIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getMainWindow: () => window,
    getLibrary: () => ({ prepare: () => new Promise(done => { resolve = done }) }) })
  const pending = handlers.get(CHANNELS.prepare)({ sender: contents, senderFrame: frame }, { workflowId: 'my-workflow:unmarked' })
  window = { webContents: contents, isDestroyed: () => false }; resolve({ success: true, workflow: graph() })
  const result = await pending; assert.equal(result.success, false); assert.equal(result.workflow, undefined)
})
test('native guarded graph loading waits read-only, rechecks before replacement, and clears temporary state', async () => {
  const source = await fs.readFile(path.join(__dirname, '../electron/main.js'), 'utf8')
  const start = source.indexOf('async function loadWorkflowGraphInEmbeddedComfy(')
  const end = source.indexOf('// Converts a UI-format workflow', start)
  const body = source.slice(start, end)
  const vm = require('node:vm'), sandbox = { setTimeout }, loaded = []
  sandbox.app = { canvasEl: { getBoundingClientRect: () => ({ width: 10, height: 10 }) }, loadGraphData: async graph => loaded.push(graph) }
  const context = vm.createContext(sandbox)
  const frame = { executeJavaScript: script => vm.runInContext(script, context) }
  const load = new Function('findEmbeddedComfyFrame', 'crypto', `${body};return loadWorkflowGraphInEmbeddedComfy`)(async () => frame, require('node:crypto'))
  await assert.rejects(load({ workflowGraph: { nodes: [] }, beforeLoad: async () => {
    assert.equal(loaded.length, 0); assert.ok(Object.keys(sandbox).some(key => key.startsWith('__velornPreparedWorkflow_')))
    throw new Error('The project changed during frontend readiness')
  } }), /project changed/)
  assert.equal(loaded.length, 0); assert.equal(Object.keys(sandbox).filter(key => key.startsWith('__velornPreparedWorkflow_')).length, 0)
  const result = await load({ workflowGraph: { nodes: [] }, beforeLoad: async () => assert.equal(loaded.length, 0) })
  assert.equal(result.success, true); assert.equal(loaded.length, 1)
  assert.equal(Object.keys(sandbox).filter(key => key.startsWith('__velornPreparedWorkflow_')).length, 0)
})
