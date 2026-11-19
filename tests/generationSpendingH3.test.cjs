'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { classifyGenerationGraph } = require('../electron/generationSpendingPolicy.cjs')
const { registerGenerationSpendingIpc, CHANNELS } = require('../electron/generationSpending.cjs')

// Synthetic data only. Exact node IDs from the audited core extension, not a
// wildcard for future H3 nodes or arbitrary custom implementations.
const moduleName = 'comfy_extras.nodes_minimax_h3'
const classes = [
  'EmptyMiniMaxH3LatentAV', 'MiniMaxH3ImageToVideo', 'MiniMaxH3AddGuide',
  'MiniMaxH3ReferenceToVideo', 'MiniMaxH3SigmaShift', 'MiniMaxH3FunControlNetApply',
  'MiniMaxH3LatentUpscaleWithModel', 'PH3ImageConditioning',
]
const node = (class_type, inputs = {}) => ({ class_type, inputs })
const info = (name, python_module = moduleName, extra = {}) => ({ name, python_module, api_node: false, price_badge: null, ...extra })
const metadata = Object.fromEntries([
  ...classes.map(name => [name, info(name)]),
  ...['UNETLoader', 'CLIPLoader', 'VAELoader', 'LoadImage', 'KSampler', 'VAEDecode'].map(name => [name, info(name, 'nodes')]),
  ['CreateVideo', info('CreateVideo', 'comfy_extras.nodes_video')],
  ['SaveVideo', info('SaveVideo', 'comfy_extras.nodes_video')],
])
function graph({ model = 'h3.safetensors', image = 'reference.png', prefix = 'video/demo', width = 1280, height = 704, seed = 7 } = {}) {
  return {
    model: node('UNETLoader', { unet_name: model }),
    clip: node('CLIPLoader', { clip_name: 'encoder.safetensors' }),
    vae: node('VAELoader', { vae_name: 'video_vae.safetensors' }),
    image: node('LoadImage', { image }),
    conditioning: node('MiniMaxH3ReferenceToVideo', { clip: ['clip', 0], vae: ['vae', 0],
      ref_image_1: ['image', 0], prompt: 'Synthetic local scene', width, height, length: 124 }),
    sample: node('KSampler', { model: ['model', 0], positive: ['conditioning', 0], latent_image: ['conditioning', 1], seed }),
    decode: node('VAEDecode', { samples: ['sample', 0], vae: ['vae', 0] }),
    video: node('CreateVideo', { images: ['decode', 0], fps: 24 }),
    save: node('SaveVideo', { video: ['video', 0], filename_prefix: prefix }),
  }
}

test('all audited H3 core nodes classify local, independently of workflow names or saved trust', async t => {
  for (const name of classes) await t.test(name, () => {
    const assessment = classifyGenerationGraph({ arbitraryId: node(name) }, metadata)
    assert.equal(assessment.risk, 'local')
    assert.deepEqual(assessment.paidNodes, [])
    assert.deepEqual(assessment.unknownNodes, [])
    assert.deepEqual(assessment.providers, [])
    assert.equal(assessment.estimatedCredits, null, 'Recognition is not a price quote')
  })
})

test('H3 recognition uses server implementation identity, never a custom class name or free label', async t => {
  for (const name of classes) await t.test(name, () => {
    for (const entry of [undefined, {}, info('different'), info(name, 'custom_nodes.minimax_h3'),
      info(name, 'nodes'), info(name, `${moduleName}.custom`), info(name, moduleName, { api_node: 'false' })]) {
      assert.equal(classifyGenerationGraph({ x: node(name) }, { [name]: entry }).risk, 'unknown')
    }
    for (const extra of [{ api_node: true }, { price_badge: 0 }, { price_badge: false }, { provider: 'MiniMax' },
      { provider_name: 'OpenAI' }, { python_module: 'comfy_api_nodes.nodes_minimax_h3' }]) {
      assert.equal(classifyGenerationGraph({ x: node(name) }, { [name]: info(name, moduleName, extra) }).risk, 'paid')
    }
    assert.equal(classifyGenerationGraph({ x: node(name, { provider: 'MiniMax' }) }, metadata).risk, 'paid')
  })
  const name = 'MiniMaxH3FutureNode'
  assert.equal(classifyGenerationGraph({ x: node(name) }, { [name]: info(name) }).risk, 'unknown')
})

// Exercises the actual native queue handler. No ComfyUI connection, Python,
// GPU, user settings, credential storage or model request is involved.
function broker({ policy, endpoint, projectKey, liveMetadata = metadata }) {
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send() {} })
  const window = { webContents: sender, isDestroyed: () => false }, handlers = new Map()
  const calls = [], confirmations = [], receipts = []
  const controller = registerGenerationSpendingIpc({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    getMainWindow: () => window, getContext: () => ({ session: 'synthetic', projectKey, timelineId: 'synthetic-timeline' }),
    getEndpoint: () => endpoint, readPolicy: () => policy,
    writePolicy: () => assert.fail('No policy changes'),
    getApiKey: () => assert.fail('Local H3 must not retrieve cloud credentials'),
    confirmSpend: input => { confirmations.push(input); return false },
    beforeSubmit: receipt => receipts.push(receipt),
    assertAvailable() {},
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      assert.ok(url === `${endpoint}/object_info` || url === `${endpoint}/prompt`)
      return new Response(JSON.stringify(init.method === 'POST'
        ? { prompt_id: 'synthetic-no-generation', node_errors: {} } : liveMetadata), { status: 200 })
    },
  })
  return { controller, calls, confirmations, receipts,
    queue: workflow => handlers.get(CHANNELS.queue)({ sender, senderFrame: sender.mainFrame }, {
      requestId: 'synthetic-h3-request-1', clientId: 'synthetic-client', endpoint, workflow,
    }) }
}

const installations = [
  { endpoint: 'http://127.0.0.1:8188', projectKey: '/home/creator/projects/Test', model: 'H3/int8.safetensors', image: 'image.png' },
  { endpoint: 'http://127.0.0.1:8189', projectKey: '/Users/creator/Documents/Test', model: 'custom/model.safetensors', image: 'inputs/reference.png', width: 768, height: 1344, seed: 123 },
  { endpoint: 'http://localhost:8190', projectKey: 'D:\\Creative\\Test', model: 'H3\\model.safetensors', image: 'reference.png', prefix: 'video/another-output', width: 640, height: 352, seed: 999 },
]
test('local H3 queues once with no approval/key/trust across policies, endpoints, paths and creative settings', async t => {
  for (const policy of ['local-only', 'ask-cloud']) for (const installation of installations) {
    await t.test(`${policy} ${installation.projectKey}`, async () => {
      const f = broker({ policy, ...installation }), workflow = graph(installation)
      try {
        const result = await f.queue(workflow)
        assert.equal(result.success, true, JSON.stringify(result))
        assert.equal(result.body.prompt_id, 'synthetic-no-generation')
        assert.equal(f.confirmations.length, 0)
        assert.equal(f.receipts.length, 1)
        assert.equal(f.receipts[0].assessment.risk, 'local')
        assert.equal(f.receipts[0].assessment.userTrustedLocal, undefined)
        const posts = f.calls.filter(call => call.init.method === 'POST')
        assert.equal(posts.length, 1)
        assert.deepEqual(JSON.parse(posts[0].init.body).prompt, workflow)
        assert.equal(JSON.parse(posts[0].init.body).extra_data, undefined)
        assert.equal(f.calls[0].url, `${installation.endpoint}/object_info`)
      } finally { f.controller.dispose() }
    })
  }
})

test('mixed cloud H3 and custom overrides still require approval; denial sends nothing', async t => {
  for (const scenario of ['mixed-cloud', 'custom-override', 'missing-metadata', 'priced-core']) {
    for (const policy of ['local-only', 'ask-cloud']) await t.test(`${scenario} ${policy}`, async () => {
      const workflow = graph(), liveMetadata = structuredClone(metadata)
      if (scenario === 'mixed-cloud') workflow.cloud = node('MinimaxHailuoVideoNode')
      if (scenario === 'custom-override') liveMetadata.MiniMaxH3ReferenceToVideo.python_module = 'custom_nodes.minimax_h3'
      if (scenario === 'missing-metadata') delete liveMetadata.MiniMaxH3ReferenceToVideo
      if (scenario === 'priced-core') liveMetadata.MiniMaxH3ReferenceToVideo.price_badge = 0
      const f = broker({ policy, ...installations[0], liveMetadata })
      try {
        const result = await f.queue(workflow)
        assert.equal(result.success, false)
        assert.equal(result.code, policy === 'local-only' ? 'GENERATION_SPENDING_LOCAL_ONLY' : 'GENERATION_SPENDING_DENIED')
        assert.equal(result.submissionState, 'not-started')
        assert.equal(f.confirmations.length, policy === 'local-only' ? 0 : 1)
        assert.equal(f.receipts.length, 0)
        assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 0)
      } finally { f.controller.dispose() }
    })
  }
})

test('ComfyUI\'s own helper parts count as local, the risky ones and look-alikes do not', () => {
  const info = (name, module) => ({ [name]: { name, python_module: module, api_node: false } })
  const risk = (name, module) => classifyGenerationGraph({ 1: { class_type: name, inputs: {} } }, info(name, module)).risk
  assert.equal(risk('TextGenerateV2', 'comfy_extras.nodes_textgen'), 'local')
  assert.equal(risk('JsonExtractString', 'comfy_extras.nodes_string'), 'local')
  assert.equal(risk('Epsilon Scaling', 'comfy_extras.nodes_eps'), 'local')
  // The same name from an add-on pack is not the audited part.
  assert.equal(risk('JsonExtractString', 'custom_nodes.some_pack'), 'unknown')
  for (const [name, module] of [['GLSLShader', 'comfy_extras.nodes_glsl'], ['TrainLoraNode', 'comfy_extras.nodes_train'],
    ['CheckpointSave', 'comfy_extras.nodes_model_merging'], ['StartLoop', 'comfy_extras.nodes_loop'],
    ['LoadImageDataSetFromFolder', 'comfy_extras.nodes_dataset']]) assert.equal(risk(name, module), 'unknown', name)
  assert.equal(risk('Ideogram4Scheduler', 'comfy_extras.nodes_ideogram4'), 'paid')
})

// MiniMax Music 3: the two core parts of the local music model, by exact class and module.
test('the MiniMax Music 3 core parts classify local only by their real implementation, never by name', () => {
  const musicModule = 'comfy_extras.nodes_minimax_music'
  for (const name of ['MiniMaxMusic3TextEncode', 'EmptyMiniMaxMusic3LatentAudio']) {
    const local = classifyGenerationGraph({ x: node(name, { caption: 'calm piano', lyrics: '' }) }, { [name]: info(name, musicModule) })
    assert.deepEqual([local.risk, local.paidNodes, local.unknownNodes, local.providers], ['local', [], [], []])
    for (const entry of [undefined, {}, info(name, 'custom_nodes.minimax_music'), info(name, 'nodes'), info(name, `${musicModule}.custom`)]) {
      assert.equal(classifyGenerationGraph({ x: node(name) }, { [name]: entry }).risk, 'unknown')
    }
    for (const extra of [{ api_node: true }, { price_badge: 0 }, { provider: 'MiniMax' }, { python_module: 'comfy_api_nodes.nodes_minimax_music' }]) {
      assert.equal(classifyGenerationGraph({ x: node(name) }, { [name]: info(name, musicModule, extra) }).risk, 'paid')
    }
  }
  // A paid MiniMax part with "music" nowhere in its real module is still paid.
  assert.equal(classifyGenerationGraph({ x: node('MinimaxTextToVideoNode') }, { MinimaxTextToVideoNode: info('MinimaxTextToVideoNode', 'comfy_api_nodes.nodes_minimax', { api_node: true }) }).risk, 'paid')
})
