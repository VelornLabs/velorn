'use strict'
// Downloaded models follow extra_model_paths.yaml when it names a folder for their type.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { chooseModelDownloadFolder } = require('../electron/modelDownloadTarget.cjs')

const MODELS = path.join('/opt', 'ComfyUI', 'models')
// The same alias rule the main process uses: a type and the other names ComfyUI accepts for it.
const ALIASES = { text_encoders: ['text_encoders', 'clip'], diffusion_models: ['diffusion_models', 'unet'] }
const keysFor = type => [...new Set([type, ...(ALIASES[type] || [])])]
const extra = (paths = {}, defaults = {}) => ({ configPath: '/opt/ComfyUI/extra_model_paths.yaml',
  pathsByKey: new Map(Object.entries(paths)), defaultPathsByKey: new Map(Object.entries(defaults)) })

test('with no extra paths file, a model goes into the ComfyUI models folder as before', () => {
  assert.deepEqual(chooseModelDownloadFolder({ modelsPath: MODELS, targetSubdir: 'checkpoints' }), { folder: path.join(MODELS, 'checkpoints'), source: 'comfyui' })
  assert.deepEqual(chooseModelDownloadFolder({ modelsPath: MODELS, targetSubdir: 'checkpoints', extra: extra(), keysFor }), { folder: path.join(MODELS, 'checkpoints'), source: 'comfyui' })
  assert.deepEqual(chooseModelDownloadFolder({ modelsPath: MODELS, targetSubdir: '', extra: extra({ checkpoints: ['/central/ckpt'] }), keysFor }), { folder: MODELS, source: 'comfyui' })
})

test('a folder the file names for that type is used, the first one when there are several', () => {
  const chosen = chooseModelDownloadFolder({ modelsPath: MODELS, targetSubdir: 'checkpoints', keysFor,
    extra: extra({ checkpoints: ['/central/checkpoints', '/older/checkpoints'], loras: ['/central/loras'] }) })
  assert.deepEqual(chosen, { folder: '/central/checkpoints', source: 'extra', key: 'checkpoints', configPath: '/opt/ComfyUI/extra_model_paths.yaml' })
})

test('a type the file does not mention still goes to the ComfyUI folder', () => {
  const chosen = chooseModelDownloadFolder({ modelsPath: MODELS, targetSubdir: 'vae', keysFor, extra: extra({ checkpoints: ['/central/checkpoints'] }) })
  assert.deepEqual(chosen, { folder: path.join(MODELS, 'vae'), source: 'comfyui' })
})

test('a section marked is_default wins over other sections', () => {
  const chosen = chooseModelDownloadFolder({ modelsPath: MODELS, targetSubdir: 'checkpoints', keysFor,
    extra: extra({ checkpoints: ['/a1111/models/Stable-diffusion', '/central/checkpoints'] }, { checkpoints: ['/central/checkpoints'] }) })
  assert.deepEqual([chosen.folder, chosen.source], ['/central/checkpoints', 'extra-default'])
})

test('the other names ComfyUI accepts for a type are followed too, the exact name first', () => {
  const onlyAlias = chooseModelDownloadFolder({ modelsPath: MODELS, targetSubdir: 'text_encoders', keysFor, extra: extra({ clip: ['/central/clip'] }) })
  assert.deepEqual([onlyAlias.folder, onlyAlias.key], ['/central/clip', 'clip'])
  const both = chooseModelDownloadFolder({ modelsPath: MODELS, targetSubdir: 'text_encoders', keysFor, extra: extra({ clip: ['/central/clip'], text_encoders: ['/central/text_encoders'] }) })
  assert.equal(both.folder, '/central/text_encoders')
  // A different type's folder is never borrowed.
  assert.equal(chooseModelDownloadFolder({ modelsPath: MODELS, targetSubdir: 'loras', keysFor, extra: extra({ clip: ['/central/clip'] }) }).source, 'comfyui')
})

test('bad input is refused or ignored, never guessed at', () => {
  assert.throws(() => chooseModelDownloadFolder({ targetSubdir: 'checkpoints' }), /modelsPath/)
  const odd = { configPath: '', pathsByKey: new Map([['checkpoints', []], ['vae', [null]]]), defaultPathsByKey: 'nope' }
  assert.equal(chooseModelDownloadFolder({ modelsPath: MODELS, targetSubdir: 'checkpoints', extra: odd, keysFor }).source, 'comfyui')
  assert.equal(chooseModelDownloadFolder({ modelsPath: MODELS, targetSubdir: 'vae', extra: odd, keysFor }).source, 'comfyui')
})
