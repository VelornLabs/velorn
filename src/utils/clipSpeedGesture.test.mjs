import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { createClipSpeedGesture } from './clipSpeedGesture.mjs'

const require = createRequire(import.meta.url)
const code = buildSync({ entryPoints: [fileURLToPath(new URL('../stores/timelineStore.js', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'zustand', 'zustand/*'],
}).outputFiles[0].text
const module = { exports: {} }
Function('require', 'module', 'exports', 'localStorage', code)(require, module, module.exports,
  { getItem: () => null, setItem() {}, removeItem() {} })
const store = module.exports.useTimelineStore, initial = store.getState()
let gesture
beforeEach(() => {
  const clip = { id: 'v', name: 'Before', assetId: 'source', type: 'video', trackId: 'video', startTime: 17,
    speed: 1, duration: 6, trimStart: 2, trimEnd: 8, sourceDuration: 20, keyframes: {}, effects: [] }
  store.setState({ ...initial, clips: [clip, { ...clip, id: 'a', type: 'audio', trackId: 'audio' }],
    tracks: [{ id: 'video', type: 'video' }, { id: 'audio', type: 'audio' }], history: [], historyIndex: -1 })
  store.getState().saveToHistory()
  store.setState({ clips: store.getState().clips.map(c => c.id === 'v' ? { ...c, name: 'Earlier edit' } : c) })
  gesture = createClipSpeedGesture(store)
})
const video = () => store.getState().clips[0]
test('one continuous gesture undoes speed and linked audio, not the earlier edit; redo restores it', () => {
  gesture.apply('v', 1.5); gesture.apply('v', 2); gesture.apply('v', 3); gesture.end()
  assert.equal(store.getState().history.length, 2)
  assert.deepEqual(store.getState().clips.map(c => [c.speed, c.duration]), [[3, 2], [3, 2]])
  store.getState().undo()
  assert.equal(video().name, 'Earlier edit')
  assert.deepEqual(store.getState().clips.map(c => [c.speed, c.duration, c.trimStart, c.startTime]), [[1, 6, 2, 17], [1, 6, 2, 17]])
  store.getState().redo()
  assert.equal(video().speed, 3)
  store.getState().undo(); store.getState().undo()
  assert.equal(video().name, 'Before')
})
test('separate gestures and presets each create their own undo step; no-op makes none', () => {
  assert.equal(gesture.apply('v', 1), false)
  assert.equal(store.getState().history.length, 1)
  gesture.apply('v', 2); gesture.end(); gesture.apply('v', 3); gesture.end()
  gesture.apply('v', 4, false)
  for (const speed of [3, 2, 1]) { store.getState().undo(); assert.equal(video().speed, speed); assert.equal(video().name, 'Earlier edit') }
})
test('undo during focused input invalidates the gesture and a new edit clears redo correctly', () => {
  gesture.apply('v', 2); store.getState().undo(); gesture.apply('v', 3)
  store.getState().undo()
  assert.equal(video().speed, 1); assert.equal(video().name, 'Earlier edit')
  store.getState().redo(); assert.equal(video().speed, 3)
})
