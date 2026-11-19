import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { buildApiWorkflowMetadata } from '../electron/workflowApiGraph.mjs'

const read = file => fs.readFile(new URL(file, import.meta.url), 'utf8')
function section(source, start, end) {
  const begin = source.indexOf(start), finish = source.indexOf(end, begin)
  assert.ok(begin >= 0 && finish > begin, `Missing fixture boundary: ${start}`)
  return source.slice(begin, finish)
}
const importer = await read('../src/services/templateImporter.js')
const scan = new Function('collectUiWorkflowNodes', 'SUBGRAPH_INSTANCE_TYPE_RE', `${section(importer, 'const MODEL_FILE_EXT_RE', '\nfunction buildModelUrlHintMap').replace('export function', 'function')}; return scanWorkflowModelReferences`)(
  value => value?.nodes || [], /^[0-9a-f]{8}-[0-9a-f-]{27}$/i)
const managed = await read('../electron/managedApiWorkflows.cjs')
const dependencies = new Function(`${section(managed, 'function modelDependencies(', '\nfunction createManagedApiWorkflowStore')}; return modelDependencies`)()
const modelGraph = separator => ({
  '1': { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: `LTX${separator}spatial.safetensors` } },
  '2': { class_type: 'LTXVAudioVideoTextEncoderLoader', inputs: { text_encoder: `Gemma${separator}encoder.safetensors` } },
  '3': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'ltx.safetensors' } },
  '4': { class_type: 'UpscaleModelLoader', inputs: { model_name: 'image-upscaler.pth' } },
  '5': { class_type: 'CLIPVisionLoader', inputs: { clip_name: 'vision.safetensors' } },
  '6': { class_type: 'UnknownLoader', inputs: { model_name: 'unknown.safetensors' } },
})
const expected = ['latent_upscale_models', 'text_encoders', 'checkpoints', 'upscale_models', 'clip_vision', '']
for (const [platform, separator] of [['Linux', '/'], ['Windows', '\\']]) {
  test(`${platform} API metadata and managed pack retain loader-specific model folders`, () => {
    const metadata = buildApiWorkflowMetadata(modelGraph(separator), { name: 'models', outputType: 'video' })
    assert.deepEqual(metadata.models.map(model => model.targetSubdir), expected)
    const pack = dependencies(metadata)
    assert.deepEqual(pack.requiredModels.map(model => model.targetSubdir), expected)
    assert.equal(pack.requiredModels[0].filename, `LTX${separator}spatial.safetensors`, 'Do not rewrite the exact graph input')
    assert.deepEqual(pack.recipes, [], 'Folder inference never invents downloads')
    assert.equal(dependencies(metadata, [{ filename: metadata.models[0].filename, targetSubdir: 'custom_latents' }]).requiredModels[0].targetSubdir, 'custom_latents')
  })
  test(`${platform} community import distinguishes latent and image upscalers and text encoders`, () => {
    const refs = scan(null, modelGraph(separator))
    assert.deepEqual(refs.map(model => model.targetSubdir), expected)
    assert.equal(refs[0].filename, 'LTX/spatial.safetensors')
    assert.equal(refs[1].filename, 'Gemma/encoder.safetensors')
  })
}
test('widget-only import prefers latent category over generic upscale and keeps ordinary upscalers intact', () => {
  const refs = scan({ nodes: [
    { type: 'LatentUpscaleModelLoader', widgets_values: ['spatial.safetensors'] },
    { type: 'latent_upscale_model_loader', widgets_values: ['other.safetensors'] },
    { type: 'UpscaleModelLoader', widgets_values: ['image.pth'] },
  ] })
  assert.deepEqual(refs.map(model => model.targetSubdir), ['latent_upscale_models', 'latent_upscale_models', 'upscale_models'])
})
test('folder inference is host-derived and respects specific loader inputs without trusting graph hints', () => {
  const graph = {
    '1': { class_type: 'latent_upscale_model_loader', inputs: { upscale_model: 'latent.safetensors', targetSubdir: 'wrong_folder' }, _meta: { targetSubdir: 'also_wrong' } },
    '2': { class_type: 'AudioLoader', inputs: { audio_vae: 'audio.safetensors' } },
    '3': { class_type: 'UnknownLoader', inputs: { upscale_model: 'image.pth' } },
  }
  const metadata = buildApiWorkflowMetadata(graph, { name: 'specific-inputs', outputType: 'video' })
  const folders = ['latent_upscale_models', 'vae', 'upscale_models']
  assert.deepEqual(metadata.models.map(model => model.targetSubdir), folders)
  assert.deepEqual(dependencies(metadata).requiredModels.map(model => model.targetSubdir), folders)
  assert.deepEqual(scan(null, graph).map(model => model.targetSubdir), folders)
  assert.throws(() => dependencies(metadata, [{ filename: 'latent.safetensors', targetSubdir: '../outside' }]), /inside a ComfyUI model category/)
})

const main = await read('../electron/main.js')
function nativeFixture(platformPath, { extra = false } = {}) {
  const root = platformPath === path.win32 ? 'C:\\ComfyUI' : '/fixture/ComfyUI'
  const modelsPath = platformPath.join(root, 'models')
  const modelDir = extra ? platformPath.join(root, 'shared', 'ltx') : platformPath.join(modelsPath, 'latent_upscale_models')
  const calls = [], handlers = new Map()
  const constants = section(main, 'const COMMON_MODEL_SEARCH_KEYS', '\nlet mainWindow')
  const normalize = section(main, 'function normalizeModelSearchKey(', '\nfunction expandPathVariables')
  const keys = section(main, 'function getModelSearchKeys(', '\nfunction normalizePythonCommand')
  const handler = section(main, "ipcMain.handle('workflowSetup:checkFiles'", "\nipcMain.handle('workflowSetup:diskSpace'")
  new Function('ipcMain', 'path', 'fs', 'validateWorkflowSetupRootInternal', 'loadExtraModelPathConfigForComfyRoot', `${constants}\n${normalize}\n${keys}\n${handler}`)(
    { handle: (name, fn) => handlers.set(name, fn) }, platformPath,
    { readdir: async directory => {
      calls.push(directory)
      if (directory === modelDir) return [{ name: 'LTX', isDirectory: () => true }]
      if (directory === platformPath.join(modelDir, 'LTX')) return [{ name: 'Spatial.SAFETENSORS', isDirectory: () => false }]
      return []
    } },
    async () => ({ isValid: true, normalizedPath: root, modelsPath }),
    async () => ({ pathsByKey: extra ? new Map([['latent_upscale_models', [modelDir]]]) : new Map(), configPath: '', pathCount: extra ? 1 : 0 }))
  return { check: handlers.get('workflowSetup:checkFiles'), calls, resolvedPath: platformPath.join(modelDir, 'LTX', 'Spatial.SAFETENSORS') }
}
for (const [platform, platformPath] of [['Linux', path.posix], ['Windows', path.win32]]) {
  for (const extra of [false, true]) test(`${platform} native empty-folder fallback finds latent model ${extra ? 'through extra model paths' : 'in its standard folder'}`, async () => {
    const fixture = nativeFixture(platformPath, { extra })
    const result = await fixture.check({}, { files: [{ filename: 'spatial.safetensors', targetSubdir: '' }, { filename: 'missing.safetensors', targetSubdir: '' }] })
    assert.equal(result.success, true)
    assert.equal(result.results[0].exists, true)
    assert.equal(result.results[0].resolvedPath, fixture.resolvedPath)
    assert.equal(result.results[1].exists, false)
    assert.equal(result.results[1].resolvedPath, '')
    assert.equal(new Set(fixture.calls).size, fixture.calls.length, 'Listings remain cached and bounded')
  })
}
