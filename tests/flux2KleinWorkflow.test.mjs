import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildKleinReferencePrompt, modifyFlux2KleinWorkflow } from '../src/services/flux2KleinWorkflow.mjs'

const base = JSON.parse(fs.readFileSync(new URL('../public/workflows/image_flux2_klein_4b.json', import.meta.url), 'utf8'))
const types = (graph) => Object.values(graph).map((node) => node.class_type)

test('with no reference it is a plain words-to-picture graph', () => {
  const graph = modifyFlux2KleinWorkflow(base, { prompt: 'A red door', seed: 7, width: 1280, height: 720, filenamePrefix: 'image/x' })
  assert.equal(types(graph).includes('LoadImage'), false)
  assert.equal(types(graph).includes('ReferenceLatent'), false)
  assert.deepEqual(graph['63'].inputs.positive, ['74', 0])
  assert.deepEqual(graph['63'].inputs.negative, ['82', 0])
  assert.equal(graph['74'].inputs.text, 'A red door')
  assert.equal(graph['73'].inputs.noise_seed, 7)
  assert.equal(graph['9'].inputs.filename_prefix, 'image/x')
  assert.equal(base['74'].inputs.text, '')
})

test('references are chained on both sides and the prompt says what they are for', () => {
  const graph = modifyFlux2KleinWorkflow(base, { prompt: 'He waves', inputImage: 'grinch.png', referenceImages: ['grinch.png', 'room.png', '', 'c.png', 'd.png'] })
  const loads = Object.values(graph).filter((node) => node.class_type === 'LoadImage').map((node) => node.inputs.image)
  assert.deepEqual(loads, ['grinch.png', 'room.png', 'c.png'])
  assert.equal(types(graph).filter((type) => type === 'ReferenceLatent').length, 6)
  assert.deepEqual(graph['63'].inputs.positive, ['223', 0])
  assert.deepEqual(graph['63'].inputs.negative, ['224', 0])
  assert.deepEqual(graph['203'].inputs.conditioning, ['74', 0])
  assert.deepEqual(graph['213'].inputs.conditioning, ['203', 0])
  assert.match(graph['74'].inputs.text, /^Use the characters from the reference images .* New picture: He waves$/)
  assert.equal(buildKleinReferencePrompt('x', 1).startsWith('Use the character from the reference image'), true)
})

test('sizes are snapped to what the model accepts', () => {
  const graph = modifyFlux2KleinWorkflow(base, { width: 1281, height: 719 })
  assert.deepEqual([graph['62'].inputs.width, graph['62'].inputs.height, graph['66'].inputs.width, graph['66'].inputs.height], [1280, 720, 1280, 720])
  assert.equal(modifyFlux2KleinWorkflow(base, { width: 0, height: 'x' })['66'].inputs.width, 1280)
})

import { createRequire } from 'node:module'
const { classifyGenerationGraph } = createRequire(import.meta.url)('../electron/generationSpendingPolicy.cjs')

test('the spending guard recognises a klein picture as local, with or without references', () => {
  const module = (python_module) => ({ python_module })
  const objectInfo = {
    LoadImage: module('nodes'), UNETLoader: module('nodes'), CLIPLoader: module('nodes'), VAELoader: module('nodes'),
    CLIPTextEncode: module('nodes'), ConditioningZeroOut: module('nodes'), VAEEncode: module('nodes'), VAEDecode: module('nodes'), SaveImage: module('nodes'),
    ImageScaleToTotalPixels: module('comfy_extras.nodes_post_processing'),
    ReferenceLatent: module('comfy_extras.nodes_edit_model'),
    CFGGuider: module('comfy_extras.nodes_custom_sampler'), KSamplerSelect: module('comfy_extras.nodes_custom_sampler'),
    RandomNoise: module('comfy_extras.nodes_custom_sampler'), SamplerCustomAdvanced: module('comfy_extras.nodes_custom_sampler'),
    Flux2Scheduler: module('comfy_extras.nodes_flux'), EmptyFlux2LatentImage: module('comfy_extras.nodes_flux'),
  }
  for (const [name, entry] of Object.entries(objectInfo)) entry.name = name
  for (const options of [{ prompt: 'x' }, { prompt: 'x', inputImage: 'a.png' }, { prompt: 'x', inputImage: 'a.png', referenceImages: ['b.png'] }]) {
    const assessment = classifyGenerationGraph(modifyFlux2KleinWorkflow(base, options), objectInfo)
    assert.equal(assessment.risk, 'local', JSON.stringify(assessment.unknownNodes))
  }
})
