import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSplitLeftPieceUpdates,
  buildSplitRightPieceCarryOver,
  splitKeyframesForRightPiece,
} from './clipSplit.mjs'
import { getValueAtTime } from './keyframes.js'

const baseClip = () => ({
  id: 'clip-1', trackId: 'video-1', assetId: 'asset-1', type: 'video', name: 'Take 3',
  startTime: 10, duration: 8, trimStart: 2, trimEnd: 6, sourceDuration: 20,
  speed: 0.5, reverse: false, sourceTimeScale: 1, labelColor: 'rose',
  transform: { scaleX: 120 }, adjustments: { exposure: 0.4 }, shapeMask: { type: 'ellipse', feather: 12 },
  bypass: { color: true }, linkGroupId: 'link-manual-4', cacheStatus: 'cached', cacheUrl: 'file:///cache/a.webm',
  lockMode: undefined, selected: true,
})

test('the right piece keeps speed, colour, mask, name and label, but not identity or caches', () => {
  const clip = baseClip()
  const carried = buildSplitRightPieceCarryOver(clip, 3, { remainder: 5 })
  assert.equal(carried.speed, 0.5)
  assert.equal(carried.name, 'Take 3')
  assert.equal(carried.labelColor, 'rose')
  assert.deepEqual(carried.adjustments, { exposure: 0.4 })
  assert.deepEqual(carried.shapeMask, { type: 'ellipse', feather: 12 })
  assert.deepEqual(carried.bypass, { color: true })
  for (const key of ['id', 'startTime', 'duration', 'trimStart', 'trimEnd', 'cacheStatus', 'cacheUrl', 'selected', 'linkGroupId']) {
    assert.equal(key in carried, false, key)
  }
  carried.adjustments.exposure = 9
  assert.equal(clip.adjustments.exposure, 0.4, 'carried values are copies')
})

test('a link is only set when the caller supplies the right-hand link', () => {
  const carried = buildSplitRightPieceCarryOver(baseClip(), 3, { remainder: 5, linkGroupId: 'link-split-1' })
  assert.equal(carried.linkGroupId, 'link-split-1')
})

test('keyframes continue across the cut', () => {
  const keyframes = {
    opacity: [
      { time: 0, value: 0, easing: 'linear' },
      { time: 4, value: 100, easing: 'linear' },
      { time: 6, value: 50, easing: 'linear' },
    ],
    scaleX: [{ time: 1, value: 150, easing: 'linear' }],
    rotation: [{ time: 5, value: 90, easing: 'linear' }],
  }
  const right = splitKeyframesForRightPiece(keyframes, 3)
  assert.deepEqual(right.opacity.map((kf) => [kf.time, kf.value]), [[0, 75], [1, 100], [3, 50]])
  // Only earlier keyframes: the held value survives as a first-frame keyframe.
  assert.deepEqual(right.scaleX.map((kf) => [kf.time, kf.value]), [[0, 150]])
  // Only later keyframes: just moved back.
  assert.deepEqual(right.rotation.map((kf) => [kf.time, kf.value]), [[2, 90]])
  for (const t of [0, 0.5, 1, 2, 3, 4]) {
    assert.ok(Math.abs(getValueAtTime(right.opacity, t, 0) - getValueAtTime(keyframes.opacity, t + 3, 0)) < 1e-9)
  }
  assert.equal(keyframes.opacity[0].time, 0, 'source keyframes untouched')
})

test('a keyframe exactly on the cut becomes the first keyframe', () => {
  const right = splitKeyframesForRightPiece({ opacity: [
    { time: 0, value: 0, easing: 'hold' }, { time: 3, value: 40, easing: 'easeIn' }, { time: 5, value: 80, easing: 'linear' },
  ] }, 3)
  assert.deepEqual(right.opacity, [{ time: 0, value: 40, easing: 'easeIn' }, { time: 2, value: 80, easing: 'linear' }])
})

test('colour and mask-shape keyframes are sampled with their own interpolation', () => {
  const point = (x) => ({ x, y: 0, hIn: { x: 0, y: 0 }, hOut: { x: 0, y: 0 } })
  const right = splitKeyframesForRightPiece({
    textColor: [{ time: 0, value: '#000000', easing: 'linear' }, { time: 2, value: '#ffffff', easing: 'linear' }],
    'shapeMask.points': [
      { time: 0, value: [point(0), point(0), point(0)], easing: 'linear' },
      { time: 2, value: [point(10), point(20), point(30)], easing: 'linear' },
    ],
  }, 1)
  assert.match(right.textColor[0].value, /^#(7f7f7f|808080)$/i)
  assert.deepEqual(right['shapeMask.points'][0].value.map((p) => p.x), [5, 10, 15])
})

test('a reversed video hands each piece the correct end of the source', () => {
  const clip = { ...baseClip(), speed: 1, reverse: true, trimStart: 2, trimEnd: 10, duration: 8 }
  // Reversed: the first 3 seconds on the timeline show source 10 → 7.
  assert.deepEqual(buildSplitLeftPieceUpdates(clip, 3, 5), { trimStart: 7, trimEnd: 10 })
  const carried = buildSplitRightPieceCarryOver(clip, 3, { remainder: 5 })
  assert.equal(carried.trimStart, 2)
  assert.equal(carried.trimEnd, 7)
  assert.equal(carried.reverse, true)
})

test('a speed ramp starts the right piece where the left piece stopped in the source', () => {
  const clip = { ...baseClip(), speed: 1, trimStart: 0, trimEnd: 12, duration: 8,
    keyframes: { speed: [{ time: 0, value: 1, easing: 'linear' }, { time: 4, value: 2, easing: 'linear' }] } }
  const left = buildSplitLeftPieceUpdates(clip, 4, 4)
  const carried = buildSplitRightPieceCarryOver(clip, 4, { remainder: 4 })
  assert.ok(Math.abs(left.trimEnd - 6) < 0.01) // average speed 1.5 over 4 seconds
  assert.ok(Math.abs(carried.trimStart - 6) < 0.01)
  assert.ok(Math.abs(carried.trimEnd - 14) < 0.01) // then 2x for 4 seconds
  assert.equal(carried.duration, 4)
  assert.deepEqual(carried.keyframes.speed.map((kf) => [kf.time, kf.value]), [[0, 2]])
})

test('ordinary clips need no trim correction', () => {
  assert.equal(buildSplitLeftPieceUpdates(baseClip(), 3, 5), null)
})
