import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

import { nudgeSelectedClips, trimToPlayhead } from './playheadEdits.mjs'

const require = createRequire(import.meta.url)
const code = buildSync({ entryPoints: [fileURLToPath(new URL('../stores/timelineStore.js', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'zustand', 'zustand/*'],
}).outputFiles[0].text
const module = { exports: {} }
Function('require', 'module', 'exports', 'localStorage', code)(require, module, module.exports,
  { getItem: () => null, setItem() {}, removeItem() {} })
const store = module.exports.useTimelineStore, initial = store.getState()
const clip = patch => ({ id: 'a', type: 'video', assetId: 'source', trackId: 'v', startTime: 2,
  duration: 4, trimStart: 1, trimEnd: 5, sourceDuration: 20, sourceTimeScale: 1, sourceFps: 10, timelineFps: 10,
  speed: 1, reverse: false, ...patch })
const reset = patch => store.setState({ ...initial,
  clips: [clip(), clip({ id: 'b', startTime: 6, duration: 2, trimStart: 0, trimEnd: 2 }),
    clip({ id: 'sound', type: 'audio', trackId: 'au', linkGroupId: 'link-1' })],
  tracks: [{ id: 'v', type: 'video' }, { id: 'au', type: 'audio' }],
  transitions: [], markers: [], selectedClipIds: [], activeTrackId: 'v', playheadPosition: 3,
  timelineFps: 10, duration: 60, rippleEditMode: false, isPlaying: false, history: [], historyIndex: -1, ...patch })
const get = id => store.getState().clips.find(candidate => candidate.id === id)
beforeEach(() => reset())

test('Q trims the start of the active-track clip to the playhead as one undo step', () => {
  const result = trimToPlayhead(store, 'left')
  assert.deepEqual(result, { ok: true, changed: true })
  assert.deepEqual([get('a').startTime, get('a').duration, get('a').trimStart, get('a').trimEnd], [3, 3, 2, 5])
  assert.equal(get('b').startTime, 6, 'later clips stay put without ripple')
  assert.equal(store.getState().history.length, 1)
  store.getState().undo()
  assert.deepEqual([get('a').startTime, get('a').duration, get('a').trimStart], [2, 4, 1])
})

test('W trims the end to the playhead', () => {
  assert.equal(trimToPlayhead(store, 'right').changed, true)
  assert.deepEqual([get('a').startTime, get('a').duration, get('a').trimStart, get('a').trimEnd], [2, 1, 1, 2])
})

test('a linked clip under the playhead is trimmed together with the active one', () => {
  reset({ clips: [clip({ linkGroupId: 'link-1' }), clip({ id: 'sound', type: 'audio', trackId: 'au', linkGroupId: 'link-1' })] })
  trimToPlayhead(store, 'left')
  assert.equal(get('a').startTime, 3)
  assert.equal(get('sound').startTime, 3)
  assert.equal(store.getState().history.length, 1)
})

test('selected clips under the playhead win over the active track', () => {
  reset({ selectedClipIds: ['sound'] })
  trimToPlayhead(store, 'right')
  assert.equal(get('sound').duration, 1)
  assert.equal(get('a').duration, 4)
})

test('nothing under the playhead, a locked track, or an edge-aligned playhead changes nothing', () => {
  reset({ playheadPosition: 10 })
  assert.equal(trimToPlayhead(store, 'left').changed, false)
  reset({ tracks: [{ id: 'v', type: 'video', locked: true }, { id: 'au', type: 'audio' }] })
  assert.equal(trimToPlayhead(store, 'left').changed, false)
  reset({ playheadPosition: 2 })
  assert.equal(trimToPlayhead(store, 'left').changed, false)
  assert.equal(store.getState().history.length, 0)
})

test('with Ripple Edit on, Q closes the gap it makes', () => {
  reset({ rippleEditMode: true, clips: [clip(), clip({ id: 'b', startTime: 6, duration: 2, trimStart: 0, trimEnd: 2 })] })
  const result = trimToPlayhead(store, 'left')
  assert.equal(result.ok, true, result.reason)
  assert.equal(get('a').duration, 3)
  assert.equal(get('a').startTime, 2, 'the clip keeps its place and the rest closes up')
  assert.equal(get('b').startTime, 5)
})

test('nudge moves the selection by whole frames and never before zero', () => {
  reset({ selectedClipIds: ['b'] })
  assert.equal(nudgeSelectedClips(store, 1).changed, true)
  assert.ok(Math.abs(get('b').startTime - 6.1) < 1e-9)
  nudgeSelectedClips(store, -10)
  assert.ok(Math.abs(get('b').startTime - 5.1) < 1e-9)
  assert.equal(store.getState().history.length, 2)
  reset({ selectedClipIds: ['a'], clips: [clip({ startTime: 0.2 })] })
  nudgeSelectedClips(store, -10)
  assert.equal(get('a').startTime, 0)
  assert.equal(nudgeSelectedClips(store, -1).changed, false, 'already at the start')
})

test('nudge needs a selection and respects locks', () => {
  assert.equal(nudgeSelectedClips(store, 1).changed, false)
  reset({ selectedClipIds: ['a'], tracks: [{ id: 'v', type: 'video', locked: true }, { id: 'au', type: 'audio' }] })
  assert.equal(nudgeSelectedClips(store, 1).changed, false)
  assert.equal(get('a').startTime, 2)
})
