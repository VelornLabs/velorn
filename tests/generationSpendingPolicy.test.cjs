'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { classifyGenerationGraph, GENERATION_SPENDING_LIMITS } = require('../electron/generationSpendingPolicy.cjs')

const node = (class_type, inputs = {}) => ({ class_type, inputs })
const info = (name, python_module = 'nodes', extra = {}) => ({ name, python_module, ...extra })
const graph = { '1': node('KSampler'), '2': node('SaveImage', { images: ['1', 0] }) }
const coreInfo = { KSampler: info('KSampler'), SaveImage: info('SaveImage') }

// Synthetic object_info fixtures mirror the audited ComfyUI source identity;
// tests never connect to a server, import Python, execute a graph or read models.
const bundledCoreClasses = new Set(`KSampler KSamplerAdvanced SaveImage LoadImage VAEDecode VAEDecodeTiled
  CLIPTextEncode CLIPLoader DualCLIPLoader VAELoader UNETLoader LoraLoader LoraLoaderModelOnly
  CheckpointLoaderSimple ConditioningZeroOut SetLatentNoiseMask`.split(/\s+/))
const bundledModules = Object.fromEntries(Object.entries({
  nodes_yue2: 'YuE2GenerateABC YuE2GenerateMusic EmptyYuE2LatentAudio',
  nodes_ace: 'TextEncodeAceStepAudio1.5 EmptyAceStep1.5LatentAudio',
  nodes_audio: 'VAEDecodeAudio SaveAudioAdvanced SaveAudioMP3 LoadAudio TrimAudioDuration EmptyLatentAudio',
  nodes_model_advanced: 'ModelSamplingAuraFlow ModelSamplingSD3',
  nodes_lt: 'LTXVConcatAVLatent LTXVCropGuides LTXVImgToVideoInplace LTXVPreprocess EmptyLTXVLatentVideo LTXVConditioning LTXVSeparateAVLatent LTXVReferenceAudio',
  nodes_lt_audio: 'LTXVAudioVAELoader LTXVAudioVAEDecode LTXVAudioVAEEncode LTXVEmptyLatentAudio LTXAVTextEncoderLoader',
  nodes_lt_upsampler: 'LTXVLatentUpsampler',
  nodes_hunyuan: 'LatentUpscaleModelLoader EmptyHunyuanLatentVideo',
  nodes_wan: 'WanImageToVideo',
  nodes_custom_sampler: 'RandomNoise KSamplerSelect ManualSigmas CFGGuider SamplerCustomAdvanced',
  nodes_primitive: 'PrimitiveInt PrimitiveFloat PrimitiveStringMultiline PrimitiveBoolean',
  nodes_logic: 'ComfySwitchNode', nodes_math: 'ComfyMathExpression', nodes_mask: 'SolidMask',
  nodes_post_processing: 'ResizeImageMaskNode', nodes_dataset: 'ResizeImagesByLongerEdge',
  nodes_video: 'SaveVideo CreateVideo', nodes_textgen: 'TextGenerateLTX2Prompt', nodes_preview_any: 'PreviewAny',
  nodes_sd3: 'EmptySD3LatentImage',
}).flatMap(([module, names]) => names.split(' ').map(name => [name, `comfy_extras.${module}`])))
function bundledInfo(workflow) {
  return Object.fromEntries(Object.values(workflow).map(({ class_type }) => {
    const module = bundledCoreClasses.has(class_type) ? 'nodes' : bundledModules[class_type]
    assert.ok(module, `Test fixture needs explicit audited module for ${class_type}`)
    return [class_type, info(class_type, module, { api_node: false, price_badge: null })]
  }))
}

test('the Sound tab Stable Audio graph is local only while every node is the audited core one', async () => {
  const { stableAudioWorkflow } = await import('../src/services/createFlow.mjs')
  const workflow = stableAudioWorkflow({ prompt: 'rain on a window', seconds: 5, seed: 1 })
  const audited = bundledInfo(workflow)
  const local = classifyGenerationGraph(workflow, audited)
  assert.deepEqual([local.risk, local.nodeCount, local.unknownNodes, local.paidNodes], ['local', 8, [], []])
  // The same class name loaded from anywhere else is not trusted.
  const replaced = classifyGenerationGraph(workflow, { ...audited, EmptyLatentAudio: info('EmptyLatentAudio', 'custom_nodes.lookalike', { api_node: false, price_badge: null }) })
  assert.equal(replaced.risk, 'unknown')
  assert.deepEqual(replaced.unknownNodes, [{ id: '5', classType: 'EmptyLatentAudio' }])
})

test('known local core graph needs server class/module identity and has no guessed price', () => {
  assert.deepEqual(classifyGenerationGraph(graph, coreInfo), {
    risk: 'local', nodeCount: 2, paidNodes: [], unknownNodes: [], providers: [], models: [], estimatedCredits: null,
  })
})

test('bundled YuE2, ACE, LTX, WAN and SD-family graphs remain local with exact core metadata', async t => {
  for (const file of [
    'music_generation_yue2.json', 'music_generation.json', 'video_ltx2_3_t2v.json',
    'video_ltx2_3_i2v.json', 'video_ltx2_3_ia2v.json', 'video_ltx2_3_id_lora.json',
    'short_film_dialogue_ltx2_3_ia2v.json', 'video_wan2_2_14B_t2v.json',
    'video_wan2_2_14B_i2v.json', 'image_z_image_turbo.json',
  ]) await t.test(file, () => {
    const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/workflows', file), 'utf8'))
    const assessed = classifyGenerationGraph(workflow, bundledInfo(workflow))
    assert.equal(assessed.risk, 'local', JSON.stringify(assessed.unknownNodes))
    assert.equal(assessed.nodeCount, Object.keys(workflow).length)
    assert.deepEqual(assessed.paidNodes, [])
    assert.deepEqual(assessed.providers, [])
    assert.equal(assessed.estimatedCredits, null)
  })
})

test('missing, partial, wrong-name and malformed metadata fail closed to unknown', () => {
  for (const metadata of [undefined, null, {}, [], { KSampler: info('KSampler') },
    { ...coreInfo, SaveImage: info('PreviewImage') },
    { ...coreInfo, KSampler: { name: 'KSampler' } },
    { ...coreInfo, KSampler: { python_module: 'nodes' } },
    { ...coreInfo, KSampler: info('KSampler', 'nodes', { api_node: 'false' }) },
  ]) assert.equal(classifyGenerationGraph(graph, metadata).risk, 'unknown')
})

test('unknown local-looking custom nodes never inherit a local namespace or free claim', () => {
  for (const classType of ['LocalImageGenerator', 'FreeOfflineSampler', 'FutureComfyCoreNode']) {
    for (const module of ['nodes', 'comfy_extras.nodes_custom_sampler', 'custom_nodes.local_free']) {
      const workflow = { x: { ...node(classType), route: 'local', cost: 0,
        _meta: { title: 'KSampler', python_module: 'nodes', api_node: false, estimatedCredits: 0 } } }
      assert.equal(classifyGenerationGraph(workflow, { [classType]: info(classType, module, { api_node: false }) }).risk, 'unknown')
    }
  }
})

test('custom overrides and borrowed core module names cannot authorize a known local class', () => {
  for (const module of ['custom_nodes.nodes', 'custom_nodes.local', 'comfy_extras.nodes_custom_sampler',
    'nodes.evil', 'comfy_extras.nodes_primitive', '/private/nodes.py', 'NODES']) {
    assert.equal(classifyGenerationGraph(graph, { ...coreInfo, KSampler: info('KSampler', module) }).risk, 'unknown')
  }
  const unknownOverride = { x: node('YuE2GenerateMusic') }
  assert.equal(classifyGenerationGraph(unknownOverride, { YuE2GenerateMusic: info('YuE2GenerateMusic', 'nodes') }).risk, 'unknown')
})

test('workflow annotations, routes, prices and embedded object_info are not authority', () => {
  const workflow = { '1': { ...node('KSampler'), route: 'local', estimatedCredits: 0,
    _meta: { title: 'Local free generation', object_info: coreInfo, python_module: 'nodes', api_node: false } } }
  assert.equal(classifyGenerationGraph(workflow).risk, 'unknown')
  workflow['1']._meta = { title: 'OpenAI Paid API', api_node: true, price_badge: {} }
  assert.equal(classifyGenerationGraph(workflow, coreInfo).risk, 'local')
})

test('server API and pricing evidence override an otherwise audited core class', () => {
  for (const extra of [{ api_node: true }, { price_badge: {} }, { price_badge: 0 }, { price_badge: false },
    { price_badge: { expr: '0', estimatedCredits: 0 } }, { provider: 'OpenAI' }]) {
    const assessed = classifyGenerationGraph(graph, { ...coreInfo, KSampler: info('KSampler', 'nodes', extra) })
    assert.equal(assessed.risk, 'paid')
    assert.deepEqual(assessed.paidNodes, [{ id: '1', classType: 'KSampler' }])
    assert.equal(assessed.estimatedCredits, null)
  }
})

test('API module evidence escalates even an unfamiliar class with api_node false', () => {
  for (const module of ['comfy_api_nodes.nodes_future_partner', 'custom_nodes.cloud.generate', 'custom_nodes.api.client']) {
    const assessed = classifyGenerationGraph({ n: node('UnfamiliarSampler') }, {
      UnfamiliarSampler: info('UnfamiliarSampler', module, { api_node: false }),
    })
    assert.equal(assessed.risk, 'paid')
    assert.deepEqual(assessed.providers, ['External API'])
  }
})

test('known partner class names are paid even when metadata and local labels disagree', () => {
  for (const [classType, provider] of [
    ['OpenAIGPTImage1', 'OpenAI'], ['GeminiNanoBanana2', 'Google'], ['ByteDance2TextToVideoNode', 'ByteDance'],
    ['GrokVideoNode', 'xAI'], ['KlingOmniProImageToVideoNode', 'Kling'], ['MinimaxHailuo03ReferenceNode', 'MiniMax'],
    ['Vidu2ImageToVideoNode', 'Vidu'], ['ElevenLabsTextToSpeech', 'ElevenLabs'], ['SoniloVideoToMusic', 'Sonilo'],
    ['TopazVideoEnhance', 'Topaz'], ['RunwayVideo', 'Runway'], ['LumaVideoNode', 'Luma'],
  ]) {
    const workflow = { a: { ...node(classType, { route: 'local', cost: 0 }), _meta: { title: 'KSampler' } } }
    assert.equal(classifyGenerationGraph(workflow).risk, 'paid')
    const assessed = classifyGenerationGraph(workflow, { [classType]: info(classType, 'nodes', { api_node: false }) })
    assert.equal(assessed.risk, 'paid')
    assert.deepEqual(assessed.providers, [provider])
  }
})

test('explicit recognized provider fields only escalate and return canonical labels', () => {
  const workflow = { ...graph, '3': node('CustomGenerator', { provider_name: 'OpenAI', model: 'gpt-image-2' }) }
  const assessed = classifyGenerationGraph(workflow, coreInfo)
  assert.equal(assessed.risk, 'paid')
  assert.deepEqual(assessed.providers, ['OpenAI'])
  assert.deepEqual(assessed.models, ['gpt-image-2'])
  workflow['3'].inputs.provider_name = 'My free local service'
  assert.equal(classifyGenerationGraph(workflow, coreInfo).risk, 'unknown')
})

test('local MiniMax H3 names are unknown, while actual API/provider/pricing evidence still requires spending approval', () => {
  const workflow = { a: node('MiniMaxH3Generate') }
  const metadata = { MiniMaxH3Generate: info('MiniMaxH3Generate', 'custom_nodes.minimax_h3', { api_node: false }) }
  assert.equal(classifyGenerationGraph(workflow, metadata).risk, 'unknown')
  assert.equal(classifyGenerationGraph(workflow).risk, 'unknown')
  for (const extra of [{ api_node: true }, { price_badge: 0 }, { provider: 'MiniMax' }, { python_module: 'custom_nodes.cloud.minimax_h3' }]) {
    assert.equal(classifyGenerationGraph(workflow, { MiniMaxH3Generate: { ...metadata.MiniMaxH3Generate, ...extra } }).risk, 'paid')
  }
})

test('mixed paid, unknown and local nodes are paid, including disconnected branches', () => {
  const workflow = { ...graph, paid: node('OpenAIGPTImage1'), unknown: node('CustomEnhance') }
  const assessed = classifyGenerationGraph(workflow, coreInfo)
  assert.equal(assessed.risk, 'paid')
  assert.equal(assessed.nodeCount, 4)
  assert.deepEqual(assessed.paidNodes, [{ id: 'paid', classType: 'OpenAIGPTImage1' }])
  assert.deepEqual(assessed.unknownNodes, [{ id: 'unknown', classType: 'CustomEnhance' }])
})

test('a free custom graph remains unknown and needs policy-level manual approval', () => {
  const workflow = { custom: node('CustomOfflineBlur') }
  const assessed = classifyGenerationGraph(workflow, {
    CustomOfflineBlur: info('CustomOfflineBlur', 'custom_nodes.free_blur', { api_node: false, price_badge: null, cost: 0 }),
  })
  assert.equal(assessed.risk, 'unknown')
  assert.deepEqual(assessed.paidNodes, [])
  assert.deepEqual(assessed.unknownNodes, [{ id: 'custom', classType: 'CustomOfflineBlur' }])
})

test('summaries do not copy prompts, titles, keys, endpoints, filenames or private model paths', () => {
  const workflow = {
    a: node('CLIPTextEncode', { text: 'do not expose my prompt', api_key: 'sk-private-abcdefgh12345', filename_prefix: 'my-private-output' }),
    b: { ...node('OpenAIGPTImage1', { model: 'gpt-image-2', prompt: 'private portrait prompt', endpoint: 'https://private.example' }), _meta: { title: 'PRIVATE TITLE' } },
    c: node('UNETLoader', { unet_name: 'private-folder/model-fp8.safetensors', model: '/home/private/person/my-secret-model.safetensors' }),
    d: node('CLIPLoader', { clip_name: 'C:\\Users\\private\\encoder.safetensors', model_name: 'sk-private-abcdefgh12345' }),
    e: node('VAELoader', { vae_name: 'https://private.example/model?key=secret', model: 'Bearer private-secret' }),
    f: node('SaveImage', { model: 'This is actually a prompt, not a model' }),
  }
  const assessed = classifyGenerationGraph(workflow, {
    OpenAIGPTImage1: info('OpenAIGPTImage1', 'comfy_api_nodes.nodes_openai', { provider: 'https://private.example/openai?token=PRIVATE' }),
  })
  assert.deepEqual(assessed.models, ['gpt-image-2', 'model-fp8.safetensors'])
  assert.deepEqual(assessed.providers, ['OpenAI'])
  const serialized = JSON.stringify(assessed)
  for (const secret of ['private', 'PRIVATE', 'portrait', 'prompt', 'sk-', 'Bearer', 'https:', 'filename_prefix']) assert.equal(serialized.includes(secret), false, secret)
})

test('unsafe node labels are replaced, and models with oversized or traversal values are omitted', () => {
  const workflow = {
    '/home/private': node('/home/private/node', { model: '../secret.safetensors' }),
    'sk-abcdefghijklmnop': node('sk-abcdefghijklmnop', { model_name: 'x'.repeat(1000) }),
    safe: node('CustomNode', { unet_name: 'folder/../weights.safetensors', vae_name: 'folder//vae.safetensors' }),
  }
  const assessed = classifyGenerationGraph(workflow)
  assert.equal(assessed.risk, 'unknown')
  assert.deepEqual(assessed.unknownNodes.slice(0, 2), [
    { id: 'unidentified', classType: 'Unidentified node' }, { id: 'unidentified', classType: 'Unidentified node' },
  ])
  assert.deepEqual(assessed.models, [])
})

test('report caps never stop classification before a later paid node', () => {
  const workflow = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i), node(`CustomNode${i}`, { model: `model-${i}.safetensors` })]))
  workflow.last = node('OpenAIGPTImage1')
  const assessed = classifyGenerationGraph(workflow)
  assert.equal(assessed.risk, 'paid')
  assert.equal(assessed.nodeCount, 101)
  assert.equal(assessed.unknownNodes.length, GENERATION_SPENDING_LIMITS.reportedNodes)
  assert.equal(assessed.models.length, GENERATION_SPENDING_LIMITS.labels)
  assert.deepEqual(assessed.paidNodes, [{ id: 'last', classType: 'OpenAIGPTImage1' }])
})

test('paid-node and provider reports are bounded while risk remains paid', () => {
  const workflow = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i), node('OpenAIGPTImage1')]))
  const assessed = classifyGenerationGraph(workflow)
  assert.equal(assessed.risk, 'paid')
  assert.equal(assessed.paidNodes.length, GENERATION_SPENDING_LIMITS.reportedNodes)
  assert.deepEqual(assessed.providers, ['OpenAI'])
  assert.ok(assessed.providers.length <= GENERATION_SPENDING_LIMITS.labels)
})

test('empty, non-API, invalid and over-limit graph inputs cannot become local', () => {
  for (const workflow of [undefined, null, 0, 'local', [], {}, { nodes: [] }, { a: null }, { a: {} },
    { a: node('KSampler', []) }, Object.fromEntries(Array.from({ length: GENERATION_SPENDING_LIMITS.nodes + 1 }, (_, i) => [String(i), node('KSampler')]))]) {
    const assessed = classifyGenerationGraph(workflow, coreInfo)
    assert.equal(assessed.risk, 'unknown')
    assert.equal(assessed.estimatedCredits, null)
  }
})

test('inherited metadata is not trusted and JSON null prototypes still work', () => {
  const inherited = Object.create(coreInfo)
  assert.equal(classifyGenerationGraph(graph, inherited).risk, 'unknown')
  assert.equal(classifyGenerationGraph(graph, { ...coreInfo, KSampler: Object.create(info('KSampler')) }).risk, 'unknown')
  const nullInfo = Object.assign(Object.create(null), coreInfo)
  const nullGraph = Object.assign(Object.create(null), graph)
  assert.equal(classifyGenerationGraph(nullGraph, nullInfo).risk, 'local')
})

test('classification is deterministic and never mutates graph or metadata', () => {
  const workflow = structuredClone(graph), metadata = structuredClone(coreInfo)
  const before = JSON.stringify({ workflow, metadata })
  for (const value of Object.values(workflow)) { Object.freeze(value.inputs); Object.freeze(value) }
  Object.freeze(workflow)
  for (const value of Object.values(metadata)) Object.freeze(value)
  Object.freeze(metadata)
  assert.deepEqual(classifyGenerationGraph(workflow, metadata), classifyGenerationGraph(workflow, metadata))
  assert.equal(JSON.stringify({ workflow, metadata }), before)
})
