import test from 'node:test'
import assert from 'node:assert/strict'
import { CUSTOM_PLACE_IMAGE_ENDPOINT, splitPlaceFromReferences } from '../src/services/customKeyframePlace.mjs'

test('the node name is the one written in the card', () => {
  assert.equal(CUSTOM_PLACE_IMAGE_ENDPOINT, 'VELORN_PLACE_IMAGE')
})

test('a workflow without a place input is left exactly as it was', () => {
  const files = ['ana.png', 'beach.png']
  const result = splitPlaceFromReferences({ referenceIds: ['ana', 'beach'], referenceFilenames: files, placeAssetId: 'beach', hasPlaceInput: false })
  assert.deepEqual(result, { referenceFilenames: files, sendPlace: false })
})

test('with a place input, the place leaves the people inputs', () => {
  const result = splitPlaceFromReferences({ referenceIds: ['ana', 'beach'], referenceFilenames: ['ana.png', 'beach.png'], placeAssetId: 'beach', hasPlaceInput: true })
  assert.deepEqual(result, { referenceFilenames: ['ana.png'], sendPlace: true })
})

test('a place with nobody in the shot leaves both people inputs empty', () => {
  const result = splitPlaceFromReferences({ referenceIds: ['beach', null], referenceFilenames: ['beach.png', null], placeAssetId: 'beach', hasPlaceInput: true })
  assert.deepEqual(result, { referenceFilenames: [], sendPlace: true })
})

test('two people and a place: both people stay, and the place is still sent', () => {
  const result = splitPlaceFromReferences({ referenceIds: ['ana', 'ben'], referenceFilenames: ['ana.png', 'ben.png'], placeAssetId: 'beach', hasPlaceInput: true })
  assert.deepEqual(result, { referenceFilenames: ['ana.png', 'ben.png'], sendPlace: true })
})

test('a shot with no place sends none', () => {
  const result = splitPlaceFromReferences({ referenceIds: ['ana'], referenceFilenames: ['ana.png'], placeAssetId: '', hasPlaceInput: true })
  assert.deepEqual(result, { referenceFilenames: ['ana.png'], sendPlace: false })
})

// ---- inputs a shot does not use are switched off ----
import { switchOffUnusedPictureInputs } from '../src/services/customKeyframePlace.mjs'

const info = {
  ReferenceLatent: { input: { required: { conditioning: [] }, optional: { latent: [] } } },
  VAEEncode: { input: { required: { pixels: [], vae: [] } } },
  LoadImage: { input: { required: { image: [] } } },
  Sampler: { input: { required: { positive: [] } } },
  SaveImage: { input: { required: { images: [] } } },
  Edit: { input: { required: { image: [] } } },
}
const graph = () => ({
  person: { class_type: 'LoadImage', inputs: { image: 'old.png' } },
  personLatent: { class_type: 'VAEEncode', inputs: { pixels: ['person', 0], vae: ['vae', 0] } },
  withPerson: { class_type: 'ReferenceLatent', inputs: { conditioning: ['text', 0], latent: ['personLatent', 0] } },
  place: { class_type: 'LoadImage', inputs: { image: 'old.png' } },
  placeLatent: { class_type: 'VAEEncode', inputs: { pixels: ['place', 0], vae: ['vae', 0] } },
  withPlace: { class_type: 'ReferenceLatent', inputs: { conditioning: ['withPerson', 0], latent: ['placeLatent', 0] } },
  sampler: { class_type: 'Sampler', inputs: { positive: ['withPlace', 0] } },
  save: { class_type: 'SaveImage', inputs: { images: ['sampler', 0] } },
})

test('an unused person input is taken out and the rest still runs', () => {
  const before = graph()
  const { workflow, switchedOff } = switchOffUnusedPictureInputs(before, ['person'], info, ['save'])
  assert.deepEqual(switchedOff, ['person'])
  assert.equal(workflow.person, undefined)
  assert.equal(workflow.personLatent, undefined)
  assert.deepEqual(workflow.withPerson.inputs, { conditioning: ['text', 0] })
  assert.deepEqual(workflow.withPlace.inputs, { conditioning: ['withPerson', 0], latent: ['placeLatent', 0] })
  assert.ok(workflow.save && workflow.sampler && workflow.place)
  // The workflow handed in is not touched.
  assert.deepEqual(before, graph())
})

test('both can be unused at once', () => {
  const { workflow } = switchOffUnusedPictureInputs(graph(), ['person', 'place'], info, ['save'])
  assert.deepEqual(Object.keys(workflow).sort(), ['sampler', 'save', 'withPerson', 'withPlace'])
})

test('a workflow that cannot run without the picture is left exactly as built', () => {
  const needs = {
    person: { class_type: 'LoadImage', inputs: { image: 'old.png' } },
    edit: { class_type: 'Edit', inputs: { image: ['person', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['edit', 0] } },
  }
  const result = switchOffUnusedPictureInputs(needs, ['person'], info, ['save'])
  assert.equal(result.workflow, needs)
  assert.deepEqual(result.switchedOff, [])
})

test('a node type ComfyUI did not describe is treated as needing its inputs', () => {
  const g = graph()
  g.withPerson.class_type = 'SomethingUnknown'
  const result = switchOffUnusedPictureInputs(g, ['person'], info, ['save'])
  assert.equal(result.workflow, g)
})

test('nothing unused, nothing changed', () => {
  const g = graph()
  assert.equal(switchOffUnusedPictureInputs(g, [], info, ['save']).workflow, g)
  assert.equal(switchOffUnusedPictureInputs(g, ['not-a-node'], info, ['save']).workflow, g)
})
