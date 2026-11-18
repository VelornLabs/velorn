'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { prepareApiGraph } = require('../electron/savedWorkflowLibrary.cjs')
const { createWorkflowAssetInputs } = require('../electron/workflowAssetInputs.cjs')
const { createGenerationRuns } = require('../electron/generationRuns.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')

// Same input shapes and subgraph IDs as the failing WAN request, without user
// data, installed models, real ComfyUI, or a generation provider.
const graph = () => ({
  '97': { class_type: 'LoadImage', inputs: { image: 'original.png' } },
  '129:93': { class_type: 'CLIPTextEncode', inputs: { text: 'old positive' } },
  '129:89': { class_type: 'CLIPTextEncode', inputs: { text: 'old negative' } },
  '129:161': { class_type: 'PrimitiveFloat', inputs: { value: 3 } },
  '129:162': { class_type: 'PrimitiveInt', inputs: { value: 24 } },
  '129:98': { class_type: 'EmptyLatentImage', inputs: { width: 320, height: 240 } },
  '20': { class_type: 'KSampler', inputs: { positive: ['129:93', 0], negative: ['129:89', 0], seed: 4 } },
  '21': { class_type: 'SaveImage', inputs: { images: ['20', 0], filename_prefix: 'test' } },
})
const settings = { node_129_161_value: 5, node_129_162_value: 16, node_129_98_width: 640, node_129_98_height: 368 }

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-reference-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'project'); await fs.mkdir(project)
  const image = path.join(project, 'reference.png'); await fs.writeFile(image, Buffer.from('synthetic image bytes'))
  const snapshot = { project: { path: project }, assets: [{ id: 'reference', type: 'image', path: 'reference.png' }] }
  const uploads = [], broker = []
  let context = { session: 's', projectKey: project, timelineId: 't' }, responseMode = 'ok'
  const assets = createWorkflowAssetInputs({ getSnapshot: async () => snapshot, fetchImpl: async (url, options) => {
    uploads.push({ url, options })
    assert.equal(url, 'http://127.0.0.1:8188/upload/image')
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST')
    const file = options.body.get('image')
    assert.equal(Buffer.from(await file.arrayBuffer()).toString(), 'synthetic image bytes')
    if (responseMode === 'switch') context = { ...context, projectKey: 'other' }
    if (responseMode === 'disconnect') throw new Error('private network diagnostics')
    if (responseMode === 'oversized') return new Response('x'.repeat(65537))
    return new Response(JSON.stringify({ name: responseMode === 'wrong-name' ? 'wrong.png' : file.name, type: 'input', subfolder: '' }), { status: responseMode === 'error' ? 500 : 200 })
  } })
  const manager = createGenerationRuns({ storageDir: path.join(root, 'runs'), getEndpoint: () => 'http://127.0.0.1:8188',
    getContext: () => ({ ...context }), uploadSavedAssets: assets.upload,
    resolveSavedWorkflow: args => prepareApiGraph(graph(), { ...args, resolveAsset: assets.resolveAsset }),
    submitManaged: async args => { broker.push(args); return { success: false, code: 'SYNTHETIC_SPENDING_DENIED' } } })
  t.after(() => manager.dispose())
  return { root, project, image, snapshot, assets, uploads, broker, manager, setResponse: value => { responseMode = value } }
}

test('both reported dictionary formats resolve identically to exact node overrides', async () => {
  const original = graph(), serialized = JSON.stringify(original)
  const first = await prepareApiGraph(original, { inputOverrides: { prompt: 'city', negativePrompt: 'blur' }, templateParameters: settings })
  const second = await prepareApiGraph(original, { inputOverrides: { node_129_93_text: 'city', node_129_89_text: 'blur', ...settings } })
  const exact = await prepareApiGraph(original, { inputOverrides: first.appliedInputs.map(({ nodeId, input, value }) => ({ nodeId, input, value })) })
  assert.equal(first.resolvedFingerprint, second.resolvedFingerprint)
  assert.equal(first.resolvedFingerprint, exact.resolvedFingerprint)
  assert.equal(first.workflow['129:161'].inputs.value, 5)
  assert.equal(first.workflow['129:98'].inputs.width, 640)
  assert.equal(JSON.stringify(original), serialized)
  assert.ok(first.queueInputs.namedInputs.some(i => i.name === 'node_129_161_value' && i.nodeId === '129:161'))
  assert.equal(first.queueInputs.referenceInputs[0].name, 'asset')
})

test('invalid named inputs have useful errors; links and scalar types remain intact', async () => {
  await assert.rejects(prepareApiGraph(graph(), { inputOverrides: { mystery: 3 } }), /Unknown workflow input "mystery"/)
  await assert.rejects(prepareApiGraph(graph(), { inputOverrides: { prompt: 'a' }, templateParameters: { node_129_93_text: 'b' } }), /more than once/)
  await assert.rejects(prepareApiGraph(graph(), { inputOverrides: { node_129_161_value: '5' } }), /scalar value type/)
  await assert.rejects(prepareApiGraph(graph(), { inputOverrides: [{ nodeId: '20', input: 'positive', value: 'bad' }] }), /links cannot be replaced/)
  await assert.rejects(prepareApiGraph(graph(), { assetBindings: [{ nodeId: '20', input: 'seed', assetId: 'reference' }] }), /inspected media input/)
  const collision = graph(); collision['129_93'] = { class_type: 'CLIPTextEncode', inputs: { text: 'collision' } }
  await assert.rejects(prepareApiGraph(collision, { inputOverrides: { node_129_93_text: 'a' } }), /ambiguous/)
})

test('reference preview is read-only; apply uploads once then uses existing spending broker', async t => {
  const f = await fixture(t)
  const args = { workflowId: 'my-workflow:synthetic', inputOverrides: { asset: 'reference', prompt: 'city' }, templateParameters: settings }
  const preview = await f.manager.submit(args)
  assert.equal(preview.success, true, preview.error); assert.equal(preview.preparedAssets.length, 1)
  assert.equal(f.uploads.length, 0); assert.equal(f.broker.length, 0)
  assert.ok(!JSON.stringify(preview.preparedAssets).includes(f.project))
  assert.ok(!JSON.stringify(preview.preparedAssets).includes('bytes'))
  const applied = await f.manager.submit({ ...args, ...preview.suggestedApplyPayload, previewOnly: false })
  assert.equal(applied.code, 'SYNTHETIC_SPENDING_DENIED')
  assert.equal(f.uploads.length, 1); assert.equal(f.broker.length, 1)
  assert.equal(f.broker[0].workflow['97'].inputs.image, preview.preparedAssets[0].value)
  assert.equal(await fs.readFile(f.image, 'utf8'), 'synthetic image bytes')
})

test('exact reference mappings match named mappings; duplicate contents upload once', async t => {
  const f = await fixture(t)
  const named = await prepareApiGraph(graph(), { inputOverrides: { asset: 'reference' }, resolveAsset: f.assets.resolveAsset })
  const exact = await prepareApiGraph(graph(), { assetBindings: [{ nodeId: '97', input: 'image', assetId: 'reference' }], resolveAsset: f.assets.resolveAsset })
  assert.equal(named.resolvedFingerprint, exact.resolvedFingerprint)
  await f.assets.upload([...named.preparedAssets, ...exact.preparedAssets], { endpoint: 'http://127.0.0.1:8188' })
  assert.equal(f.uploads.length, 1)
})

test('changed reference invalidates preview without upload or broker call', async t => {
  const f = await fixture(t), args = { workflowId: 'my-workflow:synthetic', inputOverrides: { asset: 'reference' } }
  const preview = await f.manager.submit(args)
  await fs.writeFile(f.image, 'different content')
  const result = await f.manager.submit({ ...args, ...preview.suggestedApplyPayload, previewOnly: false })
  assert.equal(result.code, 'GENERATION_RUNS_SAVED_WORKFLOW_CHANGED')
  await assert.rejects(f.assets.upload(preview.preparedAssets, { endpoint: 'http://127.0.0.1:8188' }), /changed since preview/)
  assert.equal(f.uploads.length, 0); assert.equal(f.broker.length, 0)
})

for (const mode of ['error', 'wrong-name', 'switch', 'disconnect', 'oversized']) test(`upload ${mode} never queues or retries a generation`, async t => {
  const f = await fixture(t), args = { workflowId: 'my-workflow:synthetic', inputOverrides: { asset: 'reference' } }
  const preview = await f.manager.submit(args); f.setResponse(mode)
  const result = await f.manager.submit({ ...args, ...preview.suggestedApplyPayload, previewOnly: false })
  assert.equal(result.success, false); assert.equal(f.broker.length, 0); assert.equal(f.uploads.length, 1)
  const errors = { switch: /project.*changed/, error: /upload failed/, 'wrong-name': /unexpected reference filename/,
    disconnect: /did not return a valid receipt/, oversized: /oversized upload receipt/ }
  assert.match(result.error, errors[mode])
})

test('project resolution handles moved projects and rejects missing, wrong-type or external references', async t => {
  const f = await fixture(t), input = { assetId: 'reference', assetType: 'image' }
  const before = await f.assets.resolveAsset(input)
  const moved = path.join(f.root, 'moved'); await fs.rename(f.project, moved); f.snapshot.project.path = moved
  assert.equal((await f.assets.resolveAsset(input)).value, before.value)
  await assert.rejects(f.assets.resolveAsset({ ...input, assetId: 'missing' }), /missing/)
  await assert.rejects(f.assets.resolveAsset({ ...input, assetType: 'video' }), /wrong media type/)
  const outside = path.join(f.root, 'outside.png'); await fs.writeFile(outside, 'outside')
  f.snapshot.assets[0].path = outside
  await assert.rejects(f.assets.resolveAsset(input), /outside the project/)
  if (process.platform !== 'win32') {
    await fs.symlink(outside, path.join(moved, 'escape.png')); f.snapshot.assets[0].path = 'escape.png'
    await assert.rejects(f.assets.resolveAsset(input), /outside the project/)
  }
  f.snapshot.assets[0].path = 'missing.png'
  await assert.rejects(f.assets.resolveAsset(input), /Relink or import/)
  assert.equal(f.uploads.length, 0)
})

test('public MCP dispatch preserves both supported named input formats', async () => {
  const received = []
  const server = createComfyStudioMcpServer({ generationRuns: { submit: async args => { received.push(args); return { success: true } } } })
  server.updateSnapshot({ project: { name: 'Synthetic', path: '/synthetic' }, currentTimeline: { id: 't', clips: [], tracks: [] }, assets: [] })
  for (const fields of [{ inputOverrides: { asset: 'reference', prompt: 'city' }, templateParameters: settings },
    { inputOverrides: { node_129_93_text: 'city', ...settings }, assetBindings: [{ nodeId: '97', input: 'image', assetId: 'reference' }] }]) {
    const result = await server.callTool('queue_comfyui_workflow', { workflowId: 'my-workflow:synthetic', ...fields })
    assert.equal(result.isError, undefined, JSON.stringify(result))
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(received.at(-1)[key], value)
    assert.equal(received.at(-1).previewOnly, true)
  }
})
