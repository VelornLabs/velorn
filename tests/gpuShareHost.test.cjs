'use strict'
// The host's side of the Velorn network: the approved workflow list and running
// one job on this computer's ComfyUI. The ComfyUI here is a pretend one in
// memory; nothing is queued, no model runs and no network is used.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { getApproved, listApproved, checkImage, SIZES } = require('../electron/gpuShareWorkflows.cjs')
const { createGpuShareHostRunner } = require('../electron/gpuShareHostRunner.cjs')
const { classifyGenerationGraph } = require('../electron/generationSpendingPolicy.cjs')
const { createRouterTestPng } = require('./helpers/routerImage.cjs')

const template = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/workflows/video_ltx2_3_i2v.json'), 'utf8'))
const png = createRouterTestPng({ width: 1024, height: 576 })
const picture = { mimeType: 'image/png', bytes: png }
const MODULES = ['nodes', ...['nodes_lt', 'nodes_lt_audio', 'nodes_lt_upsampler', 'nodes_hunyuan', 'nodes_custom_sampler', 'nodes_primitive', 'nodes_logic', 'nodes_math',
  'nodes_post_processing', 'nodes_dataset', 'nodes_video', 'nodes_textgen', 'nodes_preview_any', 'nodes_images', 'nodes_mask'].map(name => `comfy_extras.${name}`)]
// Node information as an up-to-date ComfyUI reports it: each class from the
// module Velorn's audited list expects, and each loader offering the files it has.
function objectInfo({ without = [], files = null } = {}) {
  const info = {}
  for (const node of Object.values(template)) {
    if (info[node.class_type] || without.includes(node.class_type)) continue
    const module = MODULES.find(candidate => classifyGenerationGraph({ 1: { class_type: node.class_type, inputs: {} } },
      { [node.class_type]: { name: node.class_type, python_module: candidate, api_node: false, price_badge: null } }).risk === 'local')
    assert.ok(module, `no audited module for ${node.class_type}`)
    info[node.class_type] = { name: node.class_type, python_module: module, api_node: false, price_badge: null, input: { required: {} } }
  }
  for (const node of Object.values(template)) {
    for (const [key, value] of Object.entries(node.inputs || {})) {
      if (typeof value === 'string' && /\.safetensors$/.test(value) && info[node.class_type]) {
        const list = info[node.class_type].input.required[key]?.[0] || []
        if (!files || files.includes(value)) list.push(value)
        info[node.class_type].input.required[key] = [list]
      }
    }
  }
  return info
}
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

function fixture(overrides = {}) {
  const comfy = { calls: [], info: objectInfo(), uploaded: null, prompt: null, state: 'queued', polls: 0, finishAfter: 2, result: 'success',
    video: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(4000, 3)]), deleted: [], interrupts: 0, ...overrides.comfy }
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(url), method = options.method || 'GET'
    comfy.calls.push(`${method} ${u.pathname}`)
    assert.equal(u.origin, 'http://127.0.0.1:8188')
    if (u.pathname === '/object_info') return reply(comfy.info)
    if (u.pathname === '/upload/image') { const file = options.body.get('image'); comfy.uploaded = { name: file.name, bytes: Buffer.from(await file.arrayBuffer()), type: options.body.get('type') }; return reply({ name: file.name, subfolder: '', type: 'input' }) }
    if (u.pathname === '/prompt') { comfy.prompt = JSON.parse(options.body); return comfy.rejectPrompt ? reply({ error: 'no' }, 400) : reply({ prompt_id: 'prompt-0001-abcd' }) }
    if (u.pathname === '/queue' && method === 'POST') { comfy.deleted.push(...JSON.parse(options.body).delete); comfy.state = 'gone'; return reply({}) }
    if (u.pathname === '/interrupt') { comfy.interrupts++; comfy.state = 'gone'; return reply({}) }
    if (u.pathname === '/queue') return reply({ queue_running: comfy.state === 'running' ? [[1, 'prompt-0001-abcd']] : comfy.othersRunning ? [[1, 'someone-elses-job']] : [], queue_pending: comfy.state === 'queued' ? [[2, 'prompt-0001-abcd']] : [] })
    if (u.pathname.startsWith('/history/')) {
      comfy.polls++
      if (comfy.state === 'queued' && comfy.polls >= 1 && !comfy.stayQueued) comfy.state = 'running'
      if (comfy.state === 'running' && comfy.polls >= comfy.finishAfter && !comfy.neverFinish) comfy.state = 'done'
      if (comfy.state !== 'done') return reply({})
      return reply({ 'prompt-0001-abcd': { status: { status_str: comfy.result, completed: comfy.result === 'success' },
        outputs: comfy.result === 'success' ? (comfy.outputs || { 75: { images: [{ filename: 'job_00001_.mp4', subfolder: 'velorn_network', type: 'output' }] } }) : {} } })
    }
    if (u.pathname === '/view') { comfy.viewed = Object.fromEntries(u.searchParams); return new Response(comfy.video, { status: 200 }) }
    return reply({}, 404)
  }
  const statuses = []
  const runner = createGpuShareHostRunner({ getEndpoint: async () => overrides.endpoint || 'http://127.0.0.1:8188', readWorkflow: async file => { assert.equal(file, 'video_ltx2_3_i2v.json'); return overrides.template || template },
    fetchImpl, sleep: async () => { overrides.onSleep?.(comfy) }, pollMs: 1, randomSeed: () => 777, ...overrides.runner })
  const job = (extra = {}) => runner.run({ jobId: 'job-0001-abcd', workflowId: 'ltx23-i2v', choices: { prompt: 'Waves roll in at dusk' }, image: picture, onStatus: s => statuses.push(s.status), ...extra })
  return { comfy, runner, statuses, job }
}

test('the network offers only its own short list, and LTX image to video binds plain choices into the shipped workflow', () => {
  assert.deepEqual(listApproved().map(entry => entry.id), ['ltx23-i2v', 'ltx23-t2v', 'h3-t2i', 'h3-edit'])
  assert.equal(getApproved('anything-else'), null); assert.equal(getApproved('__proto__'), null); assert.equal(getApproved(7), null)
  const entry = getApproved('ltx23-i2v')
  const choices = entry.normalize({ prompt: '  A kite over a beach  ', shape: 'portrait', size: '1080p', seconds: 8, seed: 12 })
  assert.deepEqual(choices, { prompt: 'A kite over a beach', shape: 'portrait', size: '1080p', seconds: 8, seed: 12 })
  const bound = entry.bind(template, choices, { imageName: 'in.png', prefix: 'velorn_network/job', randomSeed: () => 1 })
  const w = bound.workflow
  assert.deepEqual([w['269'].inputs.image, w['320:319'].inputs.value, w['320:313'].inputs.text, w['320:312'].inputs.value, w['320:299'].inputs.value,
    w['320:300'].inputs.value, w['320:301'].inputs.value, w['320:276'].inputs.noise_seed, w['320:277'].inputs.noise_seed, w['75'].inputs.filename_prefix],
  ['in.png', 'A kite over a beach', '', 1080, 1920, 24, 8, 12, 12, 'velorn_network/job'])
  assert.equal(w['320:328'].inputs.value, false, 'the refusal-free prompt rewriter stays off for someone else\'s job')
  assert.deepEqual(SIZES['1080p'].portrait, [1080, 1920])
  // Only the bound inputs differ from the shipped file; no node is added, removed or rewired.
  assert.deepEqual(Object.keys(w), Object.keys(template))
  for (const [id, node] of Object.entries(template)) assert.equal(w[id].class_type, node.class_type)
  assert.equal(JSON.stringify(template).includes('A kite over a beach'), false, 'the shipped file is not changed')
  // Defaults, and everything that is not one of the plain choices is refused.
  assert.deepEqual(entry.normalize({ prompt: 'x' }), { prompt: 'x', shape: 'landscape', size: '720p', seconds: 5, seed: null })
  for (const bad of [{}, { prompt: '' }, { prompt: 'x'.repeat(2001) }, { prompt: 'x', shape: 'wide' }, { prompt: 'x', size: '4K' }, { prompt: 'x', seconds: 11 }, { prompt: 'x', seconds: 2 },
    { prompt: 'x', seconds: 5.5 }, { prompt: 'x', seed: -1 }, { prompt: 'x', workflow: {} }, { prompt: 'x', negativePrompt: 'y' }, { prompt: 'x', model: 'other.safetensors' }, { prompt: 'x', width: 4096 }, null, []]) {
    assert.throws(() => entry.normalize(bad), { code: 'GPU_SHARE_INVALID' }, JSON.stringify(bad))
  }
  // A changed workflow file is refused, never bound by guesswork.
  const changed = JSON.parse(JSON.stringify(template)); changed['320:328'].class_type = 'SomethingElse'
  assert.throws(() => entry.bind(changed, choices, { imageName: 'in.png', prefix: 'p', randomSeed: () => 1 }), { code: 'GPU_SHARE_WORKFLOW_CHANGED' })
})

test('a picture must really be the kind of file it claims to be', () => {
  assert.equal(checkImage(picture), 'png')
  assert.equal(checkImage({ mimeType: 'image/jpeg', bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]) }), 'jpg')
  for (const bad of [{ mimeType: 'image/jpeg', bytes: png }, { mimeType: 'image/svg+xml', bytes: png }, { mimeType: 'image/png', bytes: Buffer.alloc(8) },
    { mimeType: 'image/png', bytes: Buffer.alloc(10 * 1024 * 1024 + 1) }, { mimeType: 'image/png', bytes: 'not bytes' }, null]) assert.throws(() => checkImage(bad), { code: 'GPU_SHARE_INVALID' })
})

test('one job: the picture is uploaded, the checked workflow is queued once, and the finished clip comes back', async () => {
  const f = fixture()
  const result = await f.job({ choices: { prompt: 'Waves roll in at dusk', shape: 'landscape', size: '720p', seconds: 6 } })
  assert.deepEqual([result.mimeType, result.filename, result.width, result.height, result.seconds, result.seed], ['video/mp4', 'velorn-network-job-0001-abcd.mp4', 1280, 720, 6, 777])
  assert.ok(result.bytes.equals(f.comfy.video))
  assert.ok(f.comfy.uploaded.bytes.equals(png)); assert.match(f.comfy.uploaded.name, /^velorn_network_[a-f0-9]{64}\.png$/); assert.equal(f.comfy.uploaded.type, 'input')
  const sent = f.comfy.prompt.prompt
  assert.equal(sent['269'].inputs.image, f.comfy.uploaded.name); assert.equal(sent['320:319'].inputs.value, 'Waves roll in at dusk')
  assert.equal(sent['75'].inputs.filename_prefix, 'velorn_network/job-0001-abcd'); assert.equal(sent['320:328'].inputs.value, false)
  assert.equal(f.comfy.calls.filter(call => call === 'POST /prompt').length, 1)
  assert.deepEqual(f.comfy.viewed, { filename: 'job_00001_.mp4', subfolder: 'velorn_network', type: 'output' })
  assert.deepEqual(f.statuses, ['preparing', 'queued', 'running', 'collecting'])
  assert.deepEqual([f.comfy.deleted, f.comfy.interrupts], [[], 0])
})

test('this computer only offers and runs a workflow it can run entirely locally with the files it has', async () => {
  assert.deepEqual(await fixture().runner.capability('ltx23-i2v'), { workflowId: 'ltx23-i2v', ok: true })
  // A model file is not downloaded here.
  const some = [...new Set(Object.values(template).flatMap(node => Object.values(node.inputs || {}).filter(value => typeof value === 'string' && /\.safetensors$/.test(value))))]
  const lacking = fixture({ comfy: { info: objectInfo({ files: some.slice(1) }) } })
  const cap = await lacking.runner.capability('ltx23-i2v')
  assert.deepEqual([cap.ok, cap.code, cap.missingModels], [false, 'GPU_SHARE_MODELS_MISSING', [some[0]]])
  await assert.rejects(lacking.job(), { code: 'GPU_SHARE_MODELS_MISSING' })
  assert.equal(lacking.comfy.prompt, null, 'nothing was queued')
  // A node is missing, or comes from somewhere other than the audited ComfyUI code.
  const old = fixture({ comfy: { info: objectInfo({ without: ['LTXVLatentUpsampler'] }) } })
  assert.equal((await old.runner.capability('ltx23-i2v')).code, 'GPU_SHARE_NOT_LOCAL')
  const swapped = objectInfo(); swapped.SaveVideo = { ...swapped.SaveVideo, python_module: 'custom_nodes.lookalike' }
  const lookalike = fixture({ comfy: { info: swapped } })
  await assert.rejects(lookalike.job(), { code: 'GPU_SHARE_NOT_LOCAL' }); assert.equal(lookalike.comfy.prompt, null)
  const paid = objectInfo(); paid.SaveVideo = { ...paid.SaveVideo, api_node: true }
  await assert.rejects(fixture({ comfy: { info: paid } }).job(), { code: 'GPU_SHARE_NOT_LOCAL' })
  assert.equal((await fixture().runner.capability('some-other-workflow')).code, 'GPU_SHARE_WORKFLOW_UNKNOWN')
})

test('a job is refused before ComfyUI is touched when its request is not exactly what the network allows', async () => {
  for (const [extra, code] of [[{ workflowId: 'my-own-workflow' }, 'GPU_SHARE_WORKFLOW_UNKNOWN'], [{ jobId: '../x' }, 'GPU_SHARE_INVALID'], [{ jobId: 'short' }, 'GPU_SHARE_INVALID'],
    [{ choices: { prompt: 'x', workflow: { 1: {} } } }, 'GPU_SHARE_INVALID'], [{ image: { mimeType: 'image/png', bytes: Buffer.from('<svg></svg>'.repeat(4)) } }, 'GPU_SHARE_INVALID'], [{ image: null }, 'GPU_SHARE_INVALID']]) {
    const f = fixture()
    await assert.rejects(f.job(extra), { code }, JSON.stringify(Object.keys(extra)))
    assert.equal(f.comfy.calls.some(call => call.startsWith('POST')), false, 'nothing was uploaded or queued')
  }
  for (const endpoint of ['http://192.168.1.20:8188', 'https://127.0.0.1:8188', 'http://127.0.0.1:8188/api', 'http://example.com:8188', 'not a url']) {
    await assert.rejects(fixture({ endpoint, runner: { fetchImpl: async () => { throw new Error('must not be called') } } }).job(), { code: 'GPU_SHARE_COMFY_UNAVAILABLE' })
  }
})

test('stopping removes a waiting job by its own id, interrupts only while our job is the one running, and never collects', async () => {
  const waiting = new AbortController()
  const queued = fixture({ comfy: { stayQueued: true }, onSleep: () => waiting.abort() })
  await assert.rejects(queued.job({ signal: waiting.signal }), { code: 'GPU_SHARE_STOPPED' })
  assert.deepEqual([queued.comfy.deleted, queued.comfy.interrupts], [['prompt-0001-abcd'], 0])
  const during = new AbortController()
  const running = fixture({ comfy: { neverFinish: true }, onSleep: comfy => { if (comfy.state === 'running') during.abort() } })
  await assert.rejects(running.job({ signal: during.signal }), { code: 'GPU_SHARE_STOPPED' })
  assert.deepEqual([running.comfy.deleted, running.comfy.interrupts], [[], 1])
  assert.equal(running.comfy.calls.includes('GET /view'), false)
  // Our job is already gone and someone else's is running: nothing of theirs is touched.
  const late = new AbortController()
  const other = fixture({ comfy: { stayQueued: true, othersRunning: true }, onSleep: comfy => { comfy.state = 'gone'; late.abort() } })
  await assert.rejects(other.job({ signal: late.signal }), { code: 'GPU_SHARE_STOPPED' })
  assert.deepEqual([other.comfy.deleted, other.comfy.interrupts], [[], 0])
  const before = new AbortController(); before.abort()
  const never = fixture(); await assert.rejects(never.job({ signal: before.signal }), { code: 'GPU_SHARE_STOPPED' }); assert.equal(never.comfy.prompt, null)
})

test('a failed, lost, overlong or wrong-shaped result is an error, never a clip', async () => {
  await assert.rejects(fixture({ comfy: { result: 'error' } }).job(), { code: 'GPU_SHARE_COMFY_FAILED' })
  await assert.rejects(fixture({ comfy: { rejectPrompt: true } }).job(), { code: 'GPU_SHARE_COMFY_FAILED' })
  await assert.rejects(fixture({ comfy: { video: Buffer.from('<html>not a video</html>') } }).job(), { code: 'GPU_SHARE_COMFY_FAILED' })
  for (const outputs of [{}, { 75: { images: [{ filename: 'picture.png', subfolder: '', type: 'output' }] } }, { 75: { images: [{ filename: '../../secret.mp4', subfolder: '', type: 'output' }] } },
    { 75: { images: [{ filename: 'a.mp4', subfolder: '../outside', type: 'output' }] } }, { 75: { images: [{ filename: 'a.mp4', subfolder: '', type: 'input' }] } }]) {
    const f = fixture({ comfy: { outputs } })
    await assert.rejects(f.job(), { code: 'GPU_SHARE_COMFY_FAILED' }); assert.equal(f.comfy.calls.includes('GET /view'), false)
  }
  const lost = fixture({ onSleep: comfy => { comfy.state = 'gone' } })
  await assert.rejects(lost.job(), { code: 'GPU_SHARE_COMFY_FAILED' })
  let clock = 0
  const slow = fixture({ comfy: { neverFinish: true }, runner: { now: () => (clock += 10 * 60 * 1000) } })
  await assert.rejects(slow.job(), { code: 'GPU_SHARE_TIMEOUT' }); assert.equal(slow.comfy.interrupts + slow.comfy.deleted.length, 1)
})

// ---- Pictures: MiniMax H3 text to image and image edit ----
const h3File = name => JSON.parse(fs.readFileSync(path.join(__dirname, '../public/workflows', name), 'utf8'))
const h3 = { 'network_minimax_h3_t2i.json': h3File('network_minimax_h3_t2i.json'), 'network_minimax_h3_edit.json': h3File('network_minimax_h3_edit.json') }

test('the two MiniMax H3 picture workflows take a description and little else, and bind it into their shipped files', () => {
  const t2i = getApproved('h3-t2i'), edit = getApproved('h3-edit')
  assert.deepEqual([t2i.kind, t2i.needsImage, edit.kind, edit.needsImage], ['image', false, 'image', true])
  assert.deepEqual(t2i.normalize({ prompt: ' A lighthouse ' }), { prompt: 'A lighthouse', shape: 'square', seed: null })
  assert.deepEqual(edit.normalize({ prompt: 'Make it night', seed: 4 }), { prompt: 'Make it night', seed: 4 })
  for (const bad of [{}, { prompt: '' }, { prompt: 'x', shape: 'wide' }, { prompt: 'x', size: '1080p' }, { prompt: 'x', seconds: 5 }, { prompt: 'x', width: 4096 }, { prompt: 'x', steps: 50 }, { prompt: 'x', workflow: {} }, null])
    assert.throws(() => t2i.normalize(bad), { code: 'GPU_SHARE_INVALID' }, JSON.stringify(bad))
  assert.throws(() => edit.normalize({ prompt: 'x', shape: 'square' }), { code: 'GPU_SHARE_INVALID' }, 'an edit keeps its picture\'s own shape')
  const a = t2i.bind(h3['network_minimax_h3_t2i.json'], t2i.normalize({ prompt: 'A lighthouse', shape: 'portrait' }), { imageName: null, prefix: 'velorn_network/job', randomSeed: () => 9 })
  assert.deepEqual([a.width, a.height, a.seed, a.workflow['4'].inputs.value, a.workflow['5'].inputs.width, a.workflow['5'].inputs.height, a.workflow['7'].inputs.seed, a.workflow['9'].inputs.filename_prefix],
    [1536, 2720, 9, 'A lighthouse', 1536, 2720, 9, 'velorn_network/job'])
  const b = edit.bind(h3['network_minimax_h3_edit.json'], edit.normalize({ prompt: 'Make it night', seed: 4 }), { imageName: 'in.png', prefix: 'velorn_network/job', randomSeed: () => 9 })
  assert.deepEqual([b.seed, b.workflow['10'].inputs.image, b.workflow['4'].inputs.value, b.workflow['5'].inputs['images.image_1']], [4, 'in.png', 'Make it night', ['12', 0]])
  // Neither file has a text model that rewrites the description, or any node beyond the checked ones.
  for (const file of Object.values(h3)) {
    assert.equal(Object.values(file).some(node => /TextGenerate/.test(node.class_type)), false)
    assert.equal(classifyGenerationGraph(file, Object.fromEntries(Object.values(file).map(node => [node.class_type, { python_module: 'unlisted', api_node: false }]))).risk === 'local', false, 'an unknown module never counts as local')
  }
  const extra = { ...h3['network_minimax_h3_t2i.json'], 99: { class_type: 'SaveImage', inputs: {} } }
  assert.throws(() => t2i.bind(extra, t2i.normalize({ prompt: 'x' }), { imageName: null, prefix: 'p', randomSeed: () => 1 }), { code: 'GPU_SHARE_WORKFLOW_CHANGED' })
  assert.throws(() => edit.bind(h3['network_minimax_h3_t2i.json'], edit.normalize({ prompt: 'x' }), { imageName: 'in.png', prefix: 'p', randomSeed: () => 1 }), { code: 'GPU_SHARE_WORKFLOW_CHANGED' })
})

test('a picture job comes back as a PNG, with no upload for text to image, and anything else is not a picture', async () => {
  const MODULE = { MiniMaxH3ImageConditioning: 'comfy_extras.nodes_minimax_h3', PrimitiveStringMultiline: 'comfy_extras.nodes_primitive', ResizeImageMaskNode: 'comfy_extras.nodes_post_processing', GetImageSize: 'comfy_extras.nodes_images' }
  const info = {}
  for (const file of Object.values(h3)) for (const node of Object.values(file)) {
    info[node.class_type] ||= { name: node.class_type, python_module: MODULE[node.class_type] || 'nodes', api_node: false, price_badge: null, input: { required: {} } }
    for (const [key, value] of Object.entries(node.inputs)) if (typeof value === 'string' && /\.safetensors$/.test(value)) info[node.class_type].input.required[key] = [[value]]
  }
  const make = result => {
    const seen = { calls: [], prompt: null }
    const fetchImpl = async (url, options = {}) => {
      const u = new URL(url); seen.calls.push(`${options.method || 'GET'} ${u.pathname}`)
      if (u.pathname === '/object_info') return reply(info)
      if (u.pathname === '/upload/image') return reply({ name: options.body.get('image').name, subfolder: '', type: 'input' })
      if (u.pathname === '/prompt') { seen.prompt = JSON.parse(options.body).prompt; return reply({ prompt_id: 'prompt-0001-abcd' }) }
      if (u.pathname === '/queue') return reply({ queue_running: [], queue_pending: [] })
      if (u.pathname.startsWith('/history/')) return reply({ 'prompt-0001-abcd': { status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: result.name, subfolder: 'velorn_network', type: 'output' }] } } } })
      if (u.pathname === '/view') return new Response(result.bytes, { status: 200 })
      return reply({}, 404)
    }
    return { seen, runner: createGpuShareHostRunner({ getEndpoint: async () => 'http://127.0.0.1:8188', readWorkflow: async file => h3[file], fetchImpl, sleep: async () => {}, pollMs: 1, randomSeed: () => 5 }) }
  }
  const good = make({ name: 'job_00001_.png', bytes: png })
  assert.deepEqual((await good.runner.capability('h3-t2i')), { workflowId: 'h3-t2i', ok: true })
  const made = await good.runner.run({ jobId: 'job-0001-abcd', workflowId: 'h3-t2i', choices: { prompt: 'A lighthouse', shape: 'landscape' } })
  assert.deepEqual([made.mimeType, made.filename, made.width, made.height, made.seed, 'seconds' in made], ['image/png', 'velorn-network-job-0001-abcd.png', 2720, 1536, 5, false])
  assert.ok(made.bytes.equals(png)); assert.equal(good.seen.calls.includes('POST /upload/image'), false)
  assert.equal(good.seen.prompt['4'].inputs.value, 'A lighthouse')
  const edited = make({ name: 'job_00001_.png', bytes: png })
  const result = await edited.runner.run({ jobId: 'job-0001-abcd', workflowId: 'h3-edit', choices: { prompt: 'Make it night' }, image: picture })
  assert.equal(result.mimeType, 'image/png'); assert.match(edited.seen.prompt['10'].inputs.image, /^velorn_network_[a-f0-9]{64}\.png$/)
  await assert.rejects(make({ name: 'job_00001_.png', bytes: png }).runner.run({ jobId: 'job-0001-abcd', workflowId: 'h3-edit', choices: { prompt: 'Make it night' } }), { code: 'GPU_SHARE_INVALID' }, 'an edit needs its picture')
  await assert.rejects(make({ name: 'job_00001_.png', bytes: Buffer.alloc(4000, 1) }).runner.run({ jobId: 'job-0001-abcd', workflowId: 'h3-t2i', choices: { prompt: 'x' } }), { code: 'GPU_SHARE_COMFY_FAILED' }, 'bytes that are not a PNG')
  await assert.rejects(make({ name: 'job_00001_.mp4', bytes: png }).runner.run({ jobId: 'job-0001-abcd', workflowId: 'h3-t2i', choices: { prompt: 'x' } }), { code: 'GPU_SHARE_COMFY_FAILED' }, 'a clip where a picture was expected')
})

test('LTX 2.3 text to video is the same shipped file with its own switch turned on, and a placeholder for its picture loader', async () => {
  const { PLACEHOLDER_IMAGE } = require('../electron/gpuShareWorkflows.cjs')
  const entry = getApproved('ltx23-t2v'), still = getApproved('ltx23-i2v')
  assert.deepEqual([entry.kind, entry.needsImage, entry.placeholderImage, entry.file, entry.minimumVramGb], ['video', false, true, 'video_ltx2_3_i2v.json', 24])
  const choices = entry.normalize({ prompt: ' A paper boat ', shape: 'portrait', size: '1080p', seconds: 7 })
  assert.deepEqual(choices, { prompt: 'A paper boat', shape: 'portrait', size: '1080p', seconds: 7, seed: null })
  const bound = entry.bind(template, choices, { imageName: 'grey.png', prefix: 'velorn_network/job', randomSeed: () => 31 })
  const w = bound.workflow
  assert.deepEqual([w['320:302'].inputs.value, w['320:328'].inputs.value, w['320:319'].inputs.value, w['320:312'].inputs.value, w['320:299'].inputs.value, w['320:301'].inputs.value, w['269'].inputs.image, w['320:276'].inputs.noise_seed, w['75'].inputs.filename_prefix],
    [true, false, 'A paper boat', 1080, 1920, 7, 'grey.png', 31, 'velorn_network/job'])
  // Image to video sets the same switch the other way, whatever the shipped file says.
  const flipped = JSON.parse(JSON.stringify(template)); flipped['320:302'].inputs.value = true
  assert.equal(still.bind(flipped, still.normalize({ prompt: 'x' }), { imageName: 'in.png', prefix: 'p', randomSeed: () => 1 }).workflow['320:302'].inputs.value, false)
  for (const bad of [{ prompt: 'x', seconds: 60 }, { prompt: 'x', negativePrompt: 'y' }, { prompt: 'x', image: 'a.png' }, {}]) assert.throws(() => entry.normalize(bad), { code: 'GPU_SHARE_INVALID' })
  const other = JSON.parse(JSON.stringify(template)); other['320:302'].class_type = 'SomethingElse'
  assert.throws(() => entry.bind(other, choices, { imageName: 'grey.png', prefix: 'p', randomSeed: () => 1 }), { code: 'GPU_SHARE_WORKFLOW_CHANGED' })
  // One job: no picture is asked of the sender; the placeholder is what gets uploaded.
  assert.equal(checkImage(PLACEHOLDER_IMAGE), 'png')
  const f = fixture()
  const result = await f.job({ workflowId: 'ltx23-t2v', image: undefined, choices: { prompt: 'A paper boat', seconds: 4 } })
  assert.deepEqual([result.mimeType, result.seconds], ['video/mp4', 4])
  assert.ok(f.comfy.uploaded.bytes.equals(PLACEHOLDER_IMAGE.bytes)); assert.equal(f.comfy.prompt.prompt['269'].inputs.image, f.comfy.uploaded.name)
  assert.equal(f.comfy.prompt.prompt['320:302'].inputs.value, true)
})
