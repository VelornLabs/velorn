import assert from 'node:assert/strict'
import test from 'node:test'

import { extractComboChoicesFromSpec } from './comfyObjectInfo.mjs'

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

test('reads newer dynamic COMBO options from the config object', () => {
  assert.deepEqual(
    extractComboChoicesFromSpec(['COMBO', { options: ['WAN/model.safetensors', 'SDXL/model.safetensors'] }]),
    ['WAN/model.safetensors', 'SDXL/model.safetensors'],
  )
})

test('ignores malformed or empty choice specifications', () => {
  assert.deepEqual(extractComboChoicesFromSpec(null), [])
  assert.deepEqual(extractComboChoicesFromSpec(['STRING', { default: '' }]), [])
  assert.deepEqual(extractComboChoicesFromSpec(['COMBO', { options: [' ', null] }]), [])
})
