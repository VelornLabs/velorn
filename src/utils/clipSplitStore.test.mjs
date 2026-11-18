import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

import { buildSplitLeftPieceUpdates, buildSplitRightPieceCarryOver } from './clipSplit.mjs'

const require = createRequire(import.meta.url)
const code = buildSync({ entryPoints: [fileURLToPath(new URL('../stores/timelineStore.js', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'zustand', 'zustand/*'],
}).outputFiles[0].text
const module = { exports: {} }
Function('require', 'module', 'exports', 'localStorage', code)(require, module, module.exports,
  { getItem: () => null, setItem() {}, removeItem() {} })
const store = module.exports.useTimelineStore, initial = store.getState()
const asset = { id: 'source', type: 'video', name: 'Take 3', url: 'file:///take3.mp4', duration: 20, settings: { fps: 10 } }

// The same steps the Timeline razor and the assistant's cut run, in order.
const razor = (clipId, at) => {
  const clip = store.getState().clips.find((candidate) => candidate.id === clipId)
  const splitTime = at - clip.startTime, remainder = clip.duration - splitTime
  const scale = (clip.sourceTimeScale || 1) * (clip.speed || 1)
  store.getState().resizeClip(clip.id, splitTime)
  const sourceAtCut = clip.trimStart + splitTime * scale
  const added = store.getState().addClip(clip.trackId, asset, at, 10, {
    duration: remainder, trimStart: sourceAtCut, trimEnd: sourceAtCut + remainder * scale,
    transform: clip.transform, effects: clip.effects, frameSampling: clip.frameSampling,
    sourceTimeScale: clip.sourceTimeScale, sourceFps: clip.sourceFps, timelineFps: clip.timelineFps,
    speed: clip.speed, reverse: clip.reverse === true, saveHistory: false,
  })
  const carry = buildSplitRightPieceCarryOver(clip, splitTime, { remainder })
  const leftUpdates = buildSplitLeftPieceUpdates(clip, splitTime, remainder)
  store.setState((state) => ({ clips: state.clips.map((candidate) => (
    candidate.id === added.id ? { ...candidate, ...carry }
      : (leftUpdates && candidate.id === clip.id ? { ...candidate, ...leftUpdates } : candidate))) }))
  const clips = store.getState().clips
  return { left: clips.find((candidate) => candidate.id === clip.id), right: clips.find((candidate) => candidate.id === added.id) }
}

const reset = (patch) => store.setState({ ...initial,
  clips: [{ id: 'target', type: 'video', assetId: 'source', trackId: 'v', name: 'Take 3', startTime: 2, duration: 8,
    trimStart: 2, trimEnd: 6, sourceDuration: 20, sourceTimeScale: 1, sourceFps: 10, timelineFps: 10,
    speed: 0.5, reverse: false, url: asset.url, transform: { scaleX: 120 }, labelColor: 'rose',
    adjustments: { exposure: 0.4 }, shapeMask: { type: 'ellipse', feather: 12 },
    keyframes: { opacity: [{ time: 0, value: 0, easing: 'linear' }, { time: 8, value: 100, easing: 'linear' }] },
    ...patch }],
  tracks: [{ id: 'v', type: 'video' }], transitions: [], markers: [], timelineFps: 10, duration: 60,
  history: [], historyIndex: -1 })

test('cutting a half-speed, graded, masked, keyframed clip keeps all of it on both pieces', () => {
  reset()
  const { left, right } = razor('target', 5)
  assert.equal(left.duration, 3)
  assert.equal(right.startTime, 5)
  assert.equal(right.duration, 5, 'the slowed right piece is not cut short')
  assert.equal(right.speed, 0.5)
  assert.equal(left.trimEnd, 3.5)
  assert.equal(right.trimStart, 3.5)
  assert.equal(right.trimEnd, 6)
  assert.equal(right.name, 'Take 3')
  assert.equal(right.labelColor, 'rose')
  assert.deepEqual(right.adjustments, { exposure: 0.4 })
  assert.deepEqual(right.shapeMask, { type: 'ellipse', feather: 12 })
  assert.equal(right.transform.scaleX, 120)
  assert.deepEqual(right.keyframes.opacity.map((kf) => [kf.time, kf.value]), [[0, 37.5], [5, 100]])
  assert.notEqual(right.id, left.id)
})

test('cutting a reversed clip gives each piece the correct part of the source', () => {
  reset({ speed: 1, reverse: true, trimStart: 2, trimEnd: 10, keyframes: undefined })
  const { left, right } = razor('target', 5)
  assert.deepEqual([left.trimStart, left.trimEnd], [7, 10])
  assert.deepEqual([right.trimStart, right.trimEnd], [2, 7])
  assert.equal(right.reverse, true)
  assert.equal(right.duration, 5)
})
