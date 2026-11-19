import test from 'node:test'
import assert from 'node:assert/strict'
import { selectFramePlayhead } from './framePlayhead.mjs'

test('paused, the playhead is exact', () => {
  assert.equal(selectFramePlayhead({ isPlaying: false, playheadPosition: 1.23456, timelineFps: 24 }), 1.23456)
})

test('playing, it advances once per timeline frame', () => {
  const at = (playheadPosition, timelineFps = 24) => selectFramePlayhead({ isPlaying: true, playheadPosition, timelineFps })
  // Sixty writes across one second of a 24 fps timeline give 24 distinct values.
  const values = new Set()
  for (let write = 0; write < 60; write += 1) values.add(at(write / 60))
  assert.equal(values.size, 24)
  assert.equal(at(2 / 24), 2 / 24, 'a time exactly on a frame is that frame')
  assert.ok(at(1.99) <= 1.99 && 1.99 - at(1.99) < 1 / 24)
})

test('slow-frame-rate timelines still update at least 24 times a second', () => {
  const values = new Set()
  for (let write = 0; write < 120; write += 1) {
    values.add(selectFramePlayhead({ isPlaying: true, playheadPosition: write / 120, timelineFps: 12 }))
  }
  assert.equal(values.size, 24)
})
