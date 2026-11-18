import test from 'node:test'
import assert from 'node:assert/strict'
import { findPlace, newPlace, normalizePlaces, placeHint, placeNameFromFile, placesBriefBlock, withPlacePicture } from '../src/services/musicVideoPlaces.mjs'
import { h3SceneWords } from '../src/services/minimaxH3LocalWorkflow.mjs'

const places = [
  { id: 'a', label: 'Cave living room', slug: 'cave_living_room', assetId: 'img-cave', notes: 'warm fire' },
  { id: 'b', label: 'Rooftop', slug: 'rooftop', assetId: 'img-roof', notes: '' },
]

test('a script shot finds its place by short name or by name', () => {
  assert.equal(findPlace('rooftop', places).id, 'b')
  assert.equal(findPlace('Cave Living Room', places).id, 'a')
  assert.equal(findPlace('the moon', places), null)
  assert.equal(findPlace('', places), null)
})

test('people keep their slots and the place takes a free one', () => {
  assert.deepEqual(withPlacePicture(['p1'], 'cave'), { assetIds: ['p1', 'cave'], placeUsed: true })
  assert.deepEqual(withPlacePicture([], 'cave'), { assetIds: ['cave'], placeUsed: true })
  assert.deepEqual(withPlacePicture(['p1', 'p2'], 'cave'), { assetIds: ['p1', 'p2'], placeUsed: false })
  assert.deepEqual(withPlacePicture(['p1'], null), { assetIds: ['p1'], placeUsed: false })
})

test('a new place gets a name and a short name that is not taken', () => {
  const first = newPlace({ label: 'Rooftop', assetId: 'x' }, places)
  assert.equal(first.slug, 'rooftop_2')
  assert.equal(newPlace({}, places).label, 'Place 3')
  assert.equal(placeNameFromFile('cave_living-room.png'), 'cave living room')
})

test('saved places load cleanly and empty ones are dropped', () => {
  const loaded = normalizePlaces([{ label: ' Stage ', assetId: 'i1' }, {}, null])
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].slug, 'stage')
  assert.deepEqual(normalizePlaces(undefined), [])
})

test('the script writer is told the places, and nothing when there are none', () => {
  const text = placesBriefBlock(places)
  assert.match(text, /Place: <short name>/)
  assert.match(text, /- cave_living_room: Cave living room \(warm fire\)/)
  assert.match(text, /change the camera position/)
  assert.match(text, /two reference pictures/)
  assert.match(text, /opening shot with nobody in it/)
  assert.equal(placesBriefBlock([]), '')
})

test('the place hint stays out of the video text', () => {
  const keyframe = `A green character by a fireplace, warm light. Camera setup: medium shot. ${placeHint(places[0])}`
  assert.doesNotMatch(h3SceneWords(keyframe), /reference picture/)
  assert.doesNotMatch(h3SceneWords(`A green character by a fireplace. ${placeHint(places[0])}`), /reference picture/)
})
