import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractComboChoicesFromSpec,
  resolveSubfolderModelPathsFromObjectInfo,
} from './comfyObjectInfo.mjs'

test('reads legacy combo choice arrays', () => {
  assert.deepEqual(
    extractComboChoicesFromSpec([['model-a.safetensors', ' folder/model-b.safetensors '], {}]),
    ['model-a.safetensors', 'folder/model-b.safetensors'],
  )
})

test('reads choices stored directly in an object', () => {
  assert.deepEqual(extractComboChoicesFromSpec({ values: ['a', 'b'] }), ['a', 'b'])
  assert.deepEqual(extractComboChoicesFromSpec([{ choices: ['a', 'b'] }, {}]), ['a', 'b'])
  assert.deepEqual(extractComboChoicesFromSpec({ enum: ['a', 'b'] }), ['a', 'b'])
})

test('reads the new COMBO options schema from the config object', () => {
  assert.deepEqual(
    extractComboChoicesFromSpec(['COMBO', { options: ['WAN/model.safetensors', 'SDXL/model.safetensors'] }]),
    ['WAN/model.safetensors', 'SDXL/model.safetensors'],
  )
})

test('resolves a bare model filename to its full subfolder path using the new COMBO options schema', () => {
  const workflow = {
    12: {
      class_type: 'UNETLoader',
      inputs: { weight_dtype: 'default', unet_name: 'wan2.2_i2v.safetensors' },
    },
  }
  const objectInfo = {
    UNETLoader: {
      input: {
        required: {
          unet_name: ['COMBO', { options: ['WAN/wan2.2_i2v.safetensors', 'SDXL/other.safetensors'] }],
        },
      },
    },
  }

  const result = resolveSubfolderModelPathsFromObjectInfo(workflow, objectInfo)

  assert.equal(result.workflow[12].inputs.unet_name, 'WAN/wan2.2_i2v.safetensors')
  assert.equal(workflow[12].inputs.unet_name, 'wan2.2_i2v.safetensors')
  assert.deepEqual(result.substitutions, [{
    nodeId: '12',
    classType: 'UNETLoader',
    inputKey: 'unet_name',
    value: 'wan2.2_i2v.safetensors',
    resolved: 'WAN/wan2.2_i2v.safetensors',
    ambiguous: false,
  }])
})

test('ignores malformed or empty choice specifications', () => {
  assert.deepEqual(extractComboChoicesFromSpec(null), [])
  assert.deepEqual(extractComboChoicesFromSpec(['STRING', { default: '' }]), [])
  assert.deepEqual(extractComboChoicesFromSpec(['COMBO', { options: [' ', null] }]), [])
})
