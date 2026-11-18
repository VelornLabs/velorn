import test from 'node:test'
import assert from 'node:assert/strict'
import { buildKeyframeBatch, keyframeText, runFewAtATime } from '../src/services/routerKeyframes.mjs'

test('the keyframe words say what the attached pictures are for', () => {
  const two = keyframeText('He sings by the fire.', 2)
  // The instruction comes before the shot's own words.
  assert.match(two, /^Use the attached pictures only as a reference for what the place and the people look like\. Do not copy their camera position or composition\. Make a new picture, from a new camera position, of this: He sings by the fire\./)
  assert.doesNotMatch(two, /exactly as they look/)
  assert.match(keyframeText('A street.', 1), /^Use the attached picture only as a reference .* Do not copy its camera position or composition\..* of this: A street\./)
  // The script's own place hint asked for the same place back; it is taken out.
  const hinted = keyframeText('A snowy street. Camera setup: wide. Keep the same place as the reference picture of New York City.', 1)
  assert.doesNotMatch(hinted, /Keep the same place as/)
  assert.match(hinted, /of this: A snowy street\. Camera setup: wide\. One single picture/)
  assert.match(keyframeText('An empty street.', 0), /^An empty street\. One single picture/)
  assert.doesNotMatch(keyframeText('An empty street.', 0), /reference/)
  assert.equal(keyframeText('   ', 2), '')
})

test('a picture used by many shots is loaded and sent once', async () => {
  const loaded = []
  const loadPicture = async (assetId) => { loaded.push(assetId); return { mimeType: 'image/jpeg', base64: `data-${assetId}` } }
  const batch = await buildKeyframeBatch({
    rows: [
      { prompt: 'Shot one', assetIds: ['singer', 'street'] },
      { prompt: 'Shot two', assetIds: ['singer'] },
      { prompt: 'Shot three', assetIds: [] },
    ],
    loadPicture, shape: 'portrait', size: '2K',
  })
  assert.deepEqual(loaded, ['singer', 'street'])
  assert.deepEqual(Object.keys(batch.pictures), ['p0', 'p1'])
  assert.deepEqual(batch.items.map((item) => item.pictureIds), [['p0', 'p1'], ['p0'], []])
  assert.ok(batch.items.every((item) => item.shape === 'portrait' && item.size === '2K'))
  assert.equal(batch.rows.length, 3)
})

test('a picture that cannot be loaded is left out, and a shot with no words is skipped', async () => {
  const batch = await buildKeyframeBatch({
    rows: [{ prompt: 'Shot one', assetIds: ['gone', 'singer'] }, { prompt: '', assetIds: ['singer'] }],
    loadPicture: async (assetId) => (assetId === 'gone' ? null : { mimeType: 'image/jpeg', base64: 'x' }),
  })
  assert.deepEqual(batch.items.map((item) => item.pictureIds), [['p0']])
  assert.equal(batch.rows.length, 1)
  assert.equal(batch.skipped.length, 1)
})

test('a very long script is cut to one batch and says how many were left out', async () => {
  const rows = Array.from({ length: 230 }, (_, n) => ({ prompt: `Shot ${n}`, assetIds: [] }))
  const batch = await buildKeyframeBatch({ rows, loadPicture: async () => null })
  assert.equal(batch.items.length, 200)
  assert.equal(batch.leftOut, 30)
})

test('jobs run a few at a time and every result is kept in order', async () => {
  let running = 0, most = 0
  const results = await runFewAtATime([1, 2, 3, 4, 5, 6, 7], async (value) => {
    running += 1; most = Math.max(most, running)
    await new Promise((resolve) => setTimeout(resolve, 5))
    running -= 1
    if (value === 4) throw new Error('boom')
    return { success: true, value }
  }, 3)
  assert.ok(most <= 3)
  assert.deepEqual(results.map((entry) => entry.value ?? entry.error), [1, 2, 3, 'boom', 5, 6, 7])
})
