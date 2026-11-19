import test from 'node:test'
import assert from 'node:assert/strict'
import { getStoryboardPresentation } from './storyboardPresentation.mjs'

const member = (id, name, referenceAssetIds = []) => ({ id, name, role: '', description: '', referenceAssetIds })
const location = (id, name, referenceAssetIds = []) => ({ id, name, description: '', referenceAssetIds })
const shot = (id, referenceAssetIds = []) => ({ id, title: 'Opening', description: '', durationSeconds: 5,
  referenceAssetIds, takes: [], selectedTakeId: null })
const board = (cast = [], locations = [], referenceAssetIds = [], shots = []) => ({ version: 1, title: 'Storyboard',
  brief: '', songAssetId: null, referenceAssetIds, shots, production: { cast, locations } })
const byId = (entries, key) => Object.fromEntries(entries.map(entry => [entry[key], entry.displayLabel]))

test('duplicate character and location names gain stable display labels without renaming authored entities', () => {
  const source = board([member('cast-aaaaaa', 'Mara'), member('cast-bbbbbb', 'Mara'), member('cast-cccccc', 'Guide')],
    [location('location-111111', 'Signal city'), location('location-222222', 'Signal city'), location('location-333333', 'Mara')])
  const before = JSON.stringify(source)
  const view = getStoryboardPresentation(source)
  assert.deepEqual(view.cast.map(entry => entry.displayLabel), ['Mara · …aaaaaa', 'Mara · …bbbbbb', 'Guide'])
  assert.deepEqual(view.locations.map(entry => entry.displayLabel), ['Signal city · …111111', 'Signal city · …222222', 'Mara'])
  assert.deepEqual(view.cast.map(entry => entry.name), ['Mara', 'Mara', 'Guide'])
  const reversed = getStoryboardPresentation({ ...source, production: { cast: [...source.production.cast].reverse(), locations: [...source.production.locations].reverse() } })
  assert.deepEqual(byId(reversed.cast, 'memberId'), byId(view.cast, 'memberId'))
  assert.deepEqual(byId(reversed.locations, 'locationId'), byId(view.locations, 'locationId'))
  assert.equal(JSON.stringify(source), before)
})

test('colliding short suffixes lengthen until labels distinguish every exact entity ID', () => {
  const source = board([member('left-same01', 'Mara'), member('right-same01', 'Mara'), member('same01', 'Mara')])
  const view = getStoryboardPresentation(source)
  const labels = view.cast.map(entry => entry.displayLabel)
  assert.equal(new Set(labels).size, 3)
  assert.deepEqual(labels, ['Mara · …ft-same01', 'Mara · …ht-same01', 'Mara · same01'])
  assert.deepEqual(view.cast.map(entry => entry.memberId), source.production.cast.map(entry => entry.id))
})

test('the same referenced asset has the same display label everywhere, while duplicate filenames distinguish IDs', () => {
  const assets = [{ id: 'image-aaaaaa', name: 'reference.png', type: 'image', url: 'private:image-a' },
    { id: 'image-bbbbbb', name: 'reference.png', type: 'image', url: 'private:image-b' },
    { id: 'image-cccccc', name: 'Only mood.png', type: 'image' },
    { id: 'unreferenced', name: 'Only mood.png', type: 'image' }]
  const source = board([member('cast-aaaaaa', 'Mara', ['image-aaaaaa'])],
    [location('location-aaaaaa', 'Signal city', ['image-bbbbbb', 'image-aaaaaa'])],
    ['image-aaaaaa', 'image-bbbbbb', 'image-cccccc'], [shot('shot-one', ['image-aaaaaa', 'image-bbbbbb'])])
  const before = JSON.stringify({ source, assets })
  const view = getStoryboardPresentation(source, assets)
  const references = [...view.references, ...view.cast.flatMap(entry => entry.references),
    ...view.locations.flatMap(entry => entry.references), ...view.shots.flatMap(entry => entry.references)]
  for (const reference of references) {
    assert.equal(reference.displayLabel, reference.assetId === 'image-aaaaaa' ? 'reference.png · …aaaaaa'
      : reference.assetId === 'image-bbbbbb' ? 'reference.png · …bbbbbb' : 'Only mood.png')
  }
  assert.equal(JSON.stringify(view).includes('private:'), false)
  assert.equal(JSON.stringify({ source, assets }), before)
  const reversed = getStoryboardPresentation({ ...source, referenceAssetIds: [...source.referenceAssetIds].reverse() }, [...assets].reverse())
  assert.deepEqual(byId(reversed.references, 'assetId'), byId(view.references, 'assetId'))
})

test('missing references stay inspectable and visible case/whitespace collisions receive display-only suffixes', () => {
  const source = board([member('cast-aaaaaa', 'Mara'), member('cast-bbbbbb', ' mara '), member('cast-cccccc', '')],
    [location('location-aaaaaa', ''), location('location-bbbbbb', ' ')], ['missing', 'present'])
  const view = getStoryboardPresentation(source, [{ id: 'present', name: 'missing', type: 'image' }])
  assert.deepEqual(view.cast.map(entry => entry.displayLabel), ['Mara · …aaaaaa', 'mara · …bbbbbb', 'Unnamed character'])
  assert.deepEqual(view.cast.map(entry => entry.name), ['Mara', ' mara ', ''])
  assert.equal(view.locations[0].displayLabel, 'Unnamed location · …aaaaaa')
  assert.equal(view.locations[1].displayLabel, 'Unnamed location · …bbbbbb')
  assert.equal(view.references[0].missing, true)
  assert.equal(view.references[1].missing, false)
  assert.notEqual(view.references[0].displayLabel, view.references[1].displayLabel)
  assert.equal(view.references[0].name, 'missing')
  assert.equal(Object.hasOwn(source.production.cast[0], 'displayLabel'), false)
})

test('truncated visible reference filenames disambiguate and presentation edits never mutate project data', () => {
  const name = 'A'.repeat(200)
  const assets = [{ id: 'asset-aaaaaa', name: `${name} first.png`, type: 'image' },
    { id: 'asset-bbbbbb', name: `${name} second.png`, type: 'image' }]
  const source = board([], [], assets.map(asset => asset.id))
  const view = getStoryboardPresentation(source, assets)
  assert.equal(view.references[0].name, name)
  assert.notEqual(view.references[0].displayLabel, view.references[1].displayLabel)
  view.references[0].displayLabel = 'Edited detached presentation'
  assert.equal(assets[0].name, `${name} first.png`)
  assert.equal(Object.hasOwn(source, 'displayLabel'), false)
  assert.equal(Object.hasOwn(assets[0], 'displayLabel'), false)
})
