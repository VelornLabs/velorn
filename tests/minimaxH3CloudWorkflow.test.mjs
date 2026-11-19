import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import {
  MINIMAX_H3_CLOUD_WORKFLOW_ID, buildH3CloudShotPrompt, h3CloudPriceUsd, h3CloudSeconds,
  modifyMinimaxH3CloudWorkflow, normalizeH3CloudLevel,
} from '../src/services/minimaxH3CloudWorkflow.mjs'

const base = JSON.parse(fs.readFileSync(new URL('../public/workflows/api_minimax_h3_r2v.json', import.meta.url), 'utf8'))
const KEYFRAME = 'Infinite white studio, singer in black suit beside a small potted cactus; bright even light, tidy medium composition. Camera setup: Lateral slide, 50mm lens.. Render one cinematic keyframe still.'
const MOTION = 'He sings, presenting the cactus. Camera: Lateral slide, eye level, 50mm lens.. The artist performs, lip-syncing naturally to the attached vocals.'
const shot = { prompt: MOTION, keyframePrompt: KEYFRAME, inputImage: 'key.png', inputAudio: 'slice.wav', duration: 6.2, width: 1280, height: 720, seed: 7, filenamePrefix: 'video/x' }

test('clip lengths are whole seconds the node accepts, never shorter than the shot', () => {
  assert.deepEqual([0, 3, 4, 6, 6.2, 6.98, 15, 40].map(h3CloudSeconds), [5, 4, 4, 6, 7, 7, 15, 15])
})

test('Standard is 768p and High is 2K, with a price guide', () => {
  assert.equal(normalizeH3CloudLevel('nonsense'), 'standard')
  assert.equal(h3CloudPriceUsd(7, 'standard'), 0.9)
  assert.equal(h3CloudPriceUsd(7, 'high'), 1.3)
  const node = (level) => Object.values(modifyMinimaxH3CloudWorkflow(base, { ...shot, level })).find((entry) => entry.class_type === 'MinimaxHailuo03ReferenceNode')
  assert.equal(node('standard').inputs['model.resolution'], '768P')
  assert.equal(node('high').inputs['model.resolution'], '2K')
  assert.equal(node().inputs['model.resolution'], '768P')
})

test('the shot gets its keyframe, its part of the song and text built from the keyframe words', () => {
  const graph = modifyMinimaxH3CloudWorkflow(base, shot)
  const node = Object.values(graph).find((entry) => entry.class_type === 'MinimaxHailuo03ReferenceNode')
  assert.equal(node.inputs.model, 'MiniMax H3')
  assert.equal(node.inputs['model.duration'], 7)
  assert.equal(node.inputs['model.ratio'], '16:9')
  assert.equal(node.inputs.seed, 7)
  assert.equal(node.inputs.watermark, false)
  assert.equal(graph[node.inputs['model.reference_images.image_1'][0]].inputs.image, 'key.png')
  assert.equal(graph[node.inputs['model.reference_audios.audio_1'][0]].inputs.audio, 'slice.wav')
  assert.equal(Object.values(graph).find((entry) => entry.class_type === 'SaveVideo').inputs.filename_prefix, 'video/x')
  const text = node.inputs['model.prompt']
  assert.match(text, /^Use <Picture 1> as the exact .* Use <Audio 1> exactly as it is/)
  assert.match(text, /Infinite white studio, singer in black suit beside a small potted cactus, bright even light\./)
  assert.match(text, /He sings, presenting the cactus\. Camera: Lateral slide, eye level\./)
  assert.match(text, /One continuous shot, no cuts, no text, no new characters or objects\.$/)
  assert.doesNotMatch(text, /50mm|medium composition|Render one/)
  assert.equal(base['4'].inputs['model.duration'], 5)
})

test('a tall shot asks for a tall clip', () => {
  const node = Object.values(modifyMinimaxH3CloudWorkflow(base, { ...shot, width: 720, height: 1280 })).find((entry) => entry.class_type === 'MinimaxHailuo03ReferenceNode')
  assert.equal(node.inputs['model.ratio'], '9:16')
})

test('a shot without its keyframe or song is refused instead of sent', () => {
  assert.throws(() => modifyMinimaxH3CloudWorkflow(base, { ...shot, inputImage: '' }), /keyframe/)
  assert.throws(() => modifyMinimaxH3CloudWorkflow(base, { ...shot, inputAudio: '' }), /song/)
  assert.equal(buildH3CloudShotPrompt({}), 'Use <Picture 1> as the exact character, clothes, objects, place and framing reference. Use <Audio 1> exactly as it is; the singer performs it with precise mouth timing. One continuous shot, no cuts, no text, no new characters or objects.')
})

test('the spending guard sees the cloud shot as paid, never as local', () => {
  const { classifyGenerationGraph } = createRequire(import.meta.url)('../electron/generationSpendingPolicy.cjs')
  const graph = modifyMinimaxH3CloudWorkflow(base, shot)
  const info = {
    LoadImage: { python_module: 'nodes' }, LoadAudio: { python_module: 'comfy_extras.nodes_audio' }, SaveVideo: { python_module: 'comfy_extras.nodes_video' },
    MinimaxHailuo03ReferenceNode: { python_module: 'comfy_api_nodes.nodes_minimax', api_node: true },
  }
  assert.equal(classifyGenerationGraph(graph, info).risk, 'paid')
  assert.equal(MINIMAX_H3_CLOUD_WORKFLOW_ID, 'minimax-h3-r2v')
})

import {
  MINIMAX_H3_LIP_SYNC_WORKFLOW_ID, h3LipSyncPriceUsd, h3LipSyncSeconds, modifyMinimaxH3LipSyncWorkflow,
} from '../src/services/minimaxH3CloudWorkflow.mjs'

const lipSyncBase = JSON.parse(fs.readFileSync(new URL('../public/workflows/api_minimax_h3_max_lip_sync.json', import.meta.url), 'utf8'))

test('lip sync clips are as long as the shot, but never under the five seconds the model needs', () => {
  assert.deepEqual([0, 2.5, 5, 6, 6.98, 2000].map(h3LipSyncSeconds), [5, 5, 5, 6, 6.98, 899])
  assert.deepEqual(h3LipSyncPriceUsd(7), { low: 0.8, high: 0.96 })
})

test('the lip sync shot gets only its keyframe and its part of the song, at 768p', () => {
  const graph = modifyMinimaxH3LipSyncWorkflow(lipSyncBase, { inputImage: 'key.png', inputAudio: 'slice.wav', seed: 9, filenamePrefix: 'video/y' })
  const node = Object.values(graph).find((entry) => entry.class_type === 'MinimaxHailuo03MaxLipSyncNode')
  assert.deepEqual(node.inputs, { model: 'MiniMax H3 Max', 'model.image': ['1', 0], 'model.audio': ['2', 0], 'model.resolution': '768P', 'model.transcription': false, 'model.seed': 9 })
  assert.equal(graph['1'].inputs.image, 'key.png')
  assert.equal(graph['2'].inputs.audio, 'slice.wav')
  assert.equal(graph['4'].inputs.filename_prefix, 'video/y')
  assert.equal(lipSyncBase['1'].inputs.image, 'keyframe.png')
  assert.throws(() => modifyMinimaxH3LipSyncWorkflow(lipSyncBase, { inputAudio: 'slice.wav' }), /keyframe/)
  assert.throws(() => modifyMinimaxH3LipSyncWorkflow(lipSyncBase, { inputImage: 'key.png' }), /song/)
})

test('the spending guard sees the lip sync shot as paid', () => {
  const { classifyGenerationGraph } = createRequire(import.meta.url)('../electron/generationSpendingPolicy.cjs')
  const graph = modifyMinimaxH3LipSyncWorkflow(lipSyncBase, { inputImage: 'key.png', inputAudio: 'slice.wav' })
  const info = {
    LoadImage: { python_module: 'nodes' }, LoadAudio: { python_module: 'comfy_extras.nodes_audio' }, SaveVideo: { python_module: 'comfy_extras.nodes_video' },
    MinimaxHailuo03MaxLipSyncNode: { python_module: 'comfy_api_nodes.nodes_minimax', api_node: true },
  }
  assert.equal(classifyGenerationGraph(graph, info).risk, 'paid')
  assert.equal(MINIMAX_H3_LIP_SYNC_WORKFLOW_ID, 'minimax-h3-lip-sync')
})
