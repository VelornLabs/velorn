'use strict'
// An owner's own workflows for GPU sharing: what Velorn finds in a saved
// workflow, what it turns down, and that a job can only fill the found spots.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createGpuShareOwnWorkflows, describeGraph, entryFor, TEST_PROMPT } = require('../electron/gpuShareOwnWorkflows.cjs')

const node = (class_type, inputs, title) => ({ class_type, inputs, ...(title ? { _meta: { title } } : {}) })
const TEXT = {
  1: node('CheckpointLoaderSimple', { ckpt_name: 'model.safetensors' }),
  2: node('CLIPTextEncode', { text: 'a mug', clip: ['1', 1] }, 'Positive'),
  3: node('CLIPTextEncode', { text: 'blurry', clip: ['1', 1] }, 'Negative'),
  4: node('EmptyLatentImage', { width: 512, height: 512, batch_size: 1 }),
  5: node('KSampler', { seed: 7, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] }),
  6: node('VAEDecode', { samples: ['5', 0], vae: ['1', 2] }),
  7: node('SaveImage', { filename_prefix: 'mine', images: ['6', 0] }, 'Save it'),
}
const EDIT = { ...TEXT, 8: node('LoadImage', { image: 'cat.png' }, 'My picture'), 4: node('VAEEncode', { pixels: ['8', 0], vae: ['1', 2] }) }
const VIDEO = { ...EDIT, 7: node('SaveVideo', { filename_prefix: 'clip', format: 'auto', codec: 'auto', video: ['6', 0] }) }
// The bindings the saved workflow library works out; only the parts used here.
const bindings = graph => ({ prompt: { nodeId: '2', inputKey: 'text' }, seeds: [{ nodeId: '5', inputKey: 'seed' }],
  assets: Object.entries(graph).filter(([, item]) => item.class_type === 'LoadImage').map(([nodeId]) => ({ nodeId, inputKey: 'image', assetType: 'image' })) })
const print = graph => require('node:crypto').createHash('sha256').update(JSON.stringify(graph)).digest('hex')

async function fixture(t, { graphs = { 'my-workflow:text': TEXT, 'my-workflow:edit': EDIT }, check = { ok: true } } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-own-')); t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const state = { graphs: { ...graphs }, check, ran: [], result: { mimeType: 'image/png', bytes: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 1)]) } }
  const library = {
    list: async () => ({ success: true, workflows: Object.keys(state.graphs).map(id => ({ id, title: id.split(':')[1], savedRunsReady: true, source: 'my-workflows' })) }),
    prepare: async ({ workflowId }) => { const graph = state.graphs[workflowId]
      return graph === 'old' ? { success: false, code: 'NEEDS_API_CAPTURE' } : !graph ? { success: false, code: 'NOT_FOUND' }
        : { success: true, title: workflowId.split(':')[1], workflow: JSON.parse(JSON.stringify(graph)), bindings: bindings(graph), graphFingerprint: print(graph) } },
  }
  const runner = { check: async workflow => { state.checked = workflow; return state.check }, run: async job => { state.ran.push(job); if (state.fail) throw Object.assign(new Error('x'), { publicMessage: state.fail }); return state.result } }
  const make = () => createGpuShareOwnWorkflows({ dir, library, runner, now: () => (state.clock = (state.clock || 1000) + 5000) })
  return { dir, state, own: make(), make }
}

test('Velorn names the shape from what a workflow starts with and what it saves', () => {
  const shape = graph => describeGraph(graph, bindings(graph))
  assert.deepEqual([shape(TEXT).shape, shape(EDIT).shape, shape(VIDEO).shape, shape({ ...VIDEO, 8: node('PrimitiveInt', { value: 1 }) }).shape], ['text-to-picture', 'picture-edit', 'picture-to-video', 'text-to-video'])
  const found = shape(EDIT)
  assert.deepEqual([found.problems, found.prompt, found.image.label, found.output], [[], { nodeId: '2', inputKey: 'text' }, 'My picture', { nodeId: '7', classType: 'SaveImage', label: 'Save it' }])
  // Every text box is offered as a place for the description, with what it holds now, so the owner can correct the guess.
  assert.deepEqual(found.promptChoices.map(choice => [choice.label, choice.holds]), [['Positive', 'a mug'], ['Negative', 'blurry']])
  for (const [name, graph, words] of [
    ['two results', { ...TEXT, 9: node('SaveImage', { filename_prefix: 'b', images: ['6', 0] }) }, /saves 2 results/],
    ['no result', { ...TEXT, 7: node('PreviewImage', { images: ['6', 0] }) }, /could not find where the result is saved/],
    ['sound out', { ...TEXT, 9: node('SaveAudio', { filename_prefix: 'a', audio: ['6', 0] }) }, /other than a picture or a video/],
    ['two pictures in', { ...EDIT, 9: node('LoadImage', { image: 'dog.png' }) }, /starts from 2 pictures/],
    ['a video in', { ...TEXT, 9: node('LoadVideo', { file: 'a.mp4' }) }, /starts from a video, a sound or another file/],
    ['nowhere for words', Object.fromEntries(Object.entries(TEXT).filter(([id]) => !['2', '3'].includes(id))), /could not find a place for the description/],
  ]) assert.ok(shape(graph).problems.some(problem => words.test(problem)), name)
})

test('a job through an own workflow fills the found spots and nothing else', () => {
  const record = { id: 'own-0123456789abcdef', name: 'Mine', kind: 'image', prompt: { nodeId: '2', inputKey: 'text' }, image: { nodeId: '8', inputKey: 'image' }, output: { nodeId: '7', classType: 'SaveImage' }, seeds: [{ nodeId: '5', inputKey: 'seed' }] }
  const entry = entryFor(record)
  assert.deepEqual([entry.needsImage, entry.kind, entry.own], [true, 'image', true])
  assert.deepEqual(entry.normalize({ prompt: '  a dog  ' }), { prompt: 'a dog', seed: null })
  for (const bad of [{}, { prompt: '' }, { prompt: 'x', shape: 'square' }, { prompt: 'x', steps: 99 }, { prompt: 'x', workflow: {} }, { prompt: 'x', model: 'other.safetensors' }, null])
    assert.throws(() => entry.normalize(bad), { code: 'GPU_SHARE_INVALID' }, JSON.stringify(bad))
  const bound = entry.bind(EDIT, { prompt: 'a dog', seed: null }, { imageName: 'in.png', prefix: 'velorn_network/job', randomSeed: () => 99 })
  const w = bound.workflow
  assert.deepEqual([w['2'].inputs.text, w['8'].inputs.image, w['5'].inputs.seed, w['7'].inputs.filename_prefix, bound.seed], ['a dog', 'in.png', 99, 'velorn_network/job', 99])
  // Everything else is exactly the saved graph.
  const rest = graph => JSON.stringify({ ...graph, 2: 0, 8: 0, 5: { ...graph['5'], inputs: { ...graph['5'].inputs, seed: 0 } }, 7: 0 })
  assert.equal(rest(w), rest(EDIT)); assert.equal(EDIT['2'].inputs.text, 'a mug', 'the saved graph is not changed')
  // A graph that is no longer the one that was looked at is refused, never bound by guesswork.
  for (const changed of [{ ...EDIT, 7: node('SaveVideo', { filename_prefix: 'x', video: ['6', 0] }) }, { ...EDIT, 2: node('CLIPTextEncode', { text: ['3', 0], clip: ['1', 1] }) }, Object.fromEntries(Object.entries(EDIT).filter(([id]) => id !== '8')), null])
    assert.throws(() => entry.bind(changed, { prompt: 'a dog', seed: 1 }, { imageName: 'in.png', prefix: 'p', randomSeed: () => 1 }), { code: 'GPU_SHARE_WORKFLOW_CHANGED' })
  // The owner's test keeps the picture the workflow was saved with.
  const kept = entryFor(record, { keepPicture: true })
  assert.equal(kept.needsImage, false)
  assert.equal(kept.bind(EDIT, { prompt: 'a dog', seed: 1 }, { imageName: null, prefix: 'p', randomSeed: () => 1 }).workflow['8'].inputs.image, 'cat.png')
})

test('adding: the owner sees what was found, may pick another listed text box, and the list survives a restart', async t => {
  const f = await fixture(t)
  assert.deepEqual((await f.own.candidates()).workflows.map(item => [item.workflowId, item.title, item.added]), [['my-workflow:text', 'text', false], ['my-workflow:edit', 'edit', false]])
  const found = await f.own.inspect({ workflowId: 'my-workflow:edit' })
  assert.deepEqual([found.canAdd, found.shapeLabel, found.problems], [true, 'Picture edit', []])
  assert.equal(f.state.checked['7'].inputs.filename_prefix, 'velorn_network/check', 'judged bound exactly as a job would be')
  const added = await f.own.add({ workflowId: 'my-workflow:edit', name: '  Sam\'s   cats  ', prompt: { nodeId: '3', inputKey: 'text' } })
  assert.match(added.workflow.id, /^own-[a-f0-9]{16}$/); assert.deepEqual([added.workflow.name, added.workflow.shape, added.workflow.needsImage, added.workflow.testedAt], ['Sam\'s cats', 'picture-edit', true, null])
  const resolved = await f.own.resolve(added.workflow.id)
  assert.equal(resolved.entry.bind(resolved.template, { prompt: 'x', seed: 1 }, { imageName: 'in.png', prefix: 'p', randomSeed: () => 1 }).workflow['3'].inputs.text, 'x', 'the box the owner chose is the one filled')
  for (const [payload, words] of [[{ workflowId: 'my-workflow:edit', name: 'Again' }, /already in your list/], [{ workflowId: 'my-workflow:text', name: 'sam\'s CATS' }, /already has that name/],
    [{ workflowId: 'my-workflow:text', name: '   ' }, /Give it a name/], [{ workflowId: 'my-workflow:text', name: 'T', prompt: { nodeId: '5', inputKey: 'seed' } }, /one of the listed places/],
    [{ workflowId: 'my-workflow:gone', name: 'T' }, /no longer in your saved workflows/]]) await assert.rejects(f.own.add(payload), error => words.test(error.publicMessage), JSON.stringify(payload))
  assert.deepEqual((await f.make().list()).workflows.map(item => item.name), ['Sam\'s cats'])
  assert.equal((await fs.stat(path.join(f.dir, 'own-workflows.json'))).mode & 0o077, 0, 'kept private')
  assert.equal(await f.own.resolve('own-ffffffffffffffff'), null); assert.equal(await f.own.resolve('ltx23-i2v'), null)
  // A new name changes the name and nothing else.
  const other = await f.own.add({ workflowId: 'my-workflow:text', name: 'Dogs' })
  const renamed = await f.own.rename({ id: added.workflow.id, name: '  MiniMax   H3 edit ' })
  assert.deepEqual([renamed.workflow.name, renamed.workflow.id, renamed.workflow.fingerprint], ['MiniMax H3 edit', added.workflow.id, added.workflow.fingerprint])
  assert.equal((await f.own.rename({ id: added.workflow.id, name: 'minimax h3 EDIT' })).workflow.name, 'minimax h3 EDIT', 'its own name in other letters is fine')
  for (const [payload, words] of [[{ id: added.workflow.id, name: 'dogs' }, /already has that name/], [{ id: added.workflow.id, name: '  ' }, /Give it a name/], [{ id: 'own-ffffffffffffffff', name: 'X' }, /no longer in your list/]])
    await assert.rejects(f.own.rename(payload), error => words.test(error.publicMessage), JSON.stringify(payload))
  assert.deepEqual((await f.make().list()).workflows.map(item => item.name), ['minimax h3 EDIT', 'Dogs'])
  await f.own.remove({ id: other.workflow.id })
  await f.own.remove({ id: added.workflow.id })
  assert.deepEqual((await f.own.list()).workflows, [])
})

test('what cannot be shared is turned down with the reason, before anything is stored', async t => {
  const old = await fixture(t, { graphs: { 'my-workflow:old': 'old' } })
  await assert.rejects(old.own.inspect({ workflowId: 'my-workflow:old' }), error => /save it to Velorn again/.test(error.publicMessage))
  const custom = await fixture(t, { check: { ok: false, code: 'GPU_SHARE_NOT_LOCAL', reason: 'x', unknownNodes: ['FancyNode', 'OtherNode'] } })
  const found = await custom.own.inspect({ workflowId: 'my-workflow:text' })
  assert.equal(found.canAdd, false); assert.match(found.problems[0], /parts Velorn does not know yet.*FancyNode, OtherNode/)
  await assert.rejects(custom.own.add({ workflowId: 'my-workflow:text', name: 'T' }), error => /does not know yet/.test(error.publicMessage))
  const missing = await fixture(t, { check: { ok: false, code: 'GPU_SHARE_MODELS_MISSING', reason: 'This computer does not have all the model files this workflow needs.', missingModels: ['model.safetensors'] } })
  assert.match((await missing.own.inspect({ workflowId: 'my-workflow:text' })).problems[0], /does not have all the model files.*Missing: model\.safetensors/)
  const shaped = await fixture(t, { graphs: { 'my-workflow:two': { ...EDIT, 9: node('LoadImage', { image: 'dog.png' }) } } })
  assert.equal((await shaped.own.inspect({ workflowId: 'my-workflow:two' })).canAdd, false)
  assert.equal(shaped.state.checked, undefined, 'a workflow of the wrong shape is not even sent to be judged')
  for (const f of [custom, missing, shaped]) assert.deepEqual((await f.own.list()).workflows, [])
})

test('the test run uses a plain description, keeps the result as the example, and a changed workflow stops working', async t => {
  const f = await fixture(t)
  const { workflow } = await f.own.add({ workflowId: 'my-workflow:edit', name: 'Cats' })
  const tested = await f.own.test({ id: workflow.id })
  assert.deepEqual([tested.workflow.hasExample, tested.workflow.testSeconds > 0, Boolean(tested.workflow.testedAt)], [true, true, true])
  const [job] = f.state.ran
  assert.deepEqual([job.workflowId, job.choices, job.image, job.own.entry.needsImage], [workflow.id, { prompt: TEST_PROMPT }, undefined, false])
  assert.match(job.jobId, /^owntest-[a-f0-9]{18}$/)
  const example = await f.own.example({ id: workflow.id })
  assert.equal(example.mimeType, 'image/png'); assert.ok(Buffer.from(example.bytes).equals(f.state.result.bytes))
  // A failed test is remembered with its reason, and the earlier example stays.
  f.state.fail = 'ComfyUI could not finish the job.'
  await assert.rejects(f.own.test({ id: workflow.id }), { code: 'GPU_SHARE_OWN_TEST_FAILED' })
  const [after] = (await f.own.list()).workflows
  assert.deepEqual([after.trouble, after.hasExample], ['ComfyUI could not finish the job.', true])
  // The saved workflow is edited in ComfyUI afterwards: the entry no longer resolves, so it can never run something its owner did not look at.
  f.state.graphs['my-workflow:edit'] = { ...EDIT, 5: { ...EDIT['5'], inputs: { ...EDIT['5'].inputs, steps: 50 } } }
  await assert.rejects(f.own.resolve(workflow.id), { code: 'GPU_SHARE_WORKFLOW_CHANGED' })
  await f.own.remove({ id: workflow.id })
  await assert.rejects(fs.stat(path.join(f.dir, `${workflow.id}.png`)), { code: 'ENOENT' })
})

test('an own workflow is offered only after it ran here once, and stops being offered when it fails or is removed', async t => {
  const f = await fixture(t)
  const { workflow } = await f.own.add({ workflowId: 'my-workflow:text', name: 'Mugs' })
  await assert.rejects(f.own.share({ id: workflow.id, shared: true }), error => /Test it first/.test(error.publicMessage))
  assert.deepEqual(await f.own.offered(), []); assert.equal(await f.own.resolveShared(workflow.id), null)
  await f.own.test({ id: workflow.id })
  assert.equal((await f.own.share({ id: workflow.id, shared: true })).workflow.shared, true)
  assert.deepEqual(await f.own.offered(), [{ id: workflow.id, name: 'Mugs', shape: 'text-to-picture', kind: 'image', needsImage: false }])
  assert.equal((await f.own.resolveShared(workflow.id)).entry.id, workflow.id)
  assert.deepEqual((await f.make().offered()).map(item => item.id), [workflow.id], 'the choice survives a restart')
  await assert.rejects(f.own.share({ id: workflow.id, shared: 'yes' })); await assert.rejects(f.own.share({ id: 'own-ffffffffffffffff', shared: true }))
  // A later test fails: it is no longer offered until it runs again.
  f.state.fail = 'ComfyUI could not finish the job.'
  await assert.rejects(f.own.test({ id: workflow.id }))
  assert.deepEqual(await f.own.offered(), []); assert.equal(await f.own.resolveShared(workflow.id), null)
  await assert.rejects(f.own.share({ id: workflow.id, shared: true }), error => /Test it first/.test(error.publicMessage))
})

test('offering to everyone sends a reviewer the facts about a workflow, never the workflow', async t => {
  const f = await fixture(t)
  const dir = f.dir
  const thumbs = []
  const own = createGpuShareOwnWorkflows({ dir, now: () => 5000, makeThumbnail: async bytes => { thumbs.push(bytes.length); return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(900, 2)]) },
    library: { list: async () => ({ success: true, workflows: [] }), prepare: async ({ workflowId }) => ({ success: true, title: 'edit', workflow: JSON.parse(JSON.stringify(EDIT)), bindings: bindings(EDIT), graphFingerprint: print(EDIT) }) },
    runner: { check: async () => ({ ok: true }), run: async () => f.state.result } })
  const { workflow } = await own.add({ workflowId: 'my-workflow:edit', name: 'Cats' })
  await assert.rejects(own.reviewPackage({ id: workflow.id }), error => /Share it with the people you invite first/.test(error.publicMessage))
  await assert.rejects(own.setEveryone({ id: workflow.id, everyone: true }), error => /Share it with the people you invite first/.test(error.publicMessage))
  await own.test({ id: workflow.id }); await own.share({ id: workflow.id, shared: true })
  const sent = await own.reviewPackage({ id: workflow.id })
  assert.deepEqual(Object.keys(sent).sort(), ['example', 'fingerprint', 'id', 'models', 'name', 'parts', 'shape'])
  assert.deepEqual([sent.id, sent.fingerprint, sent.name, sent.shape, sent.models], [workflow.id, print(EDIT), 'Cats', 'picture-edit', ['model.safetensors']])
  assert.deepEqual(sent.parts, ['CLIPTextEncode', 'CheckpointLoaderSimple', 'KSampler', 'LoadImage', 'SaveImage', 'VAEDecode', 'VAEEncode'])
  assert.equal(Buffer.from(sent.example, 'base64')[1], 0xd8); assert.equal(thumbs.length, 1)
  assert.equal(JSON.stringify(sent).includes('a mug'), false, 'no prompt text, no graph')
  // The copy a reviewer may open is exactly the graph that runs, under the same fingerprint.
  const copy = await own.reviewGraph({ id: workflow.id })
  assert.deepEqual([copy.id, copy.fingerprint, JSON.parse(copy.graph)], [workflow.id, print(EDIT), EDIT])
  // Asking is remembered; the fingerprint then travels with what is offered, and only then.
  assert.equal((await own.offered())[0].fingerprint, undefined)
  assert.equal((await own.setEveryone({ id: workflow.id, everyone: true })).workflow.everyone, true)
  assert.equal((await own.offered())[0].fingerprint, print(EDIT))
  // No longer shared with invited people: not open to everyone either.
  await own.share({ id: workflow.id, shared: false })
  assert.deepEqual([(await own.list()).workflows[0].everyone, (await own.offered()).length], [false, 0])
})
