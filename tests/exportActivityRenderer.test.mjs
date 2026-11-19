import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import store, { isExportBusy, beginLocalExportActivity, receiveExportActivity } from '../src/stores/exportActivityStore.js'
import { VideoCache } from '../src/services/videoCache.js'

const reset = () => store.setState({ revision: -1, activeJob: null, localActivity: null, localActivities: {} })
test('native revisions reject stale events and initialization reads', () => {
  reset()
  assert.equal(receiveExportActivity({ revision: 3, activeJob: { jobId: 'new' } }), true)
  assert.equal(receiveExportActivity({ revision: 2, activeJob: null }), false)
  assert.equal(receiveExportActivity({ revision: 3, activeJob: null }), false)
  assert.equal(isExportBusy(), true)
  assert.equal(receiveExportActivity({ revision: 4, activeJob: null }), true)
  assert.equal(isExportBusy(), false)
  assert.equal(receiveExportActivity({ activeJob: { jobId: 'invalid' } }), false)
})
test('queue lease bridges terminal/start gaps and late lease cleanup cannot unlock a newer export', () => {
  reset()
  const queue = beginLocalExportActivity({ status: 'queue' })
  const first = beginLocalExportActivity({ status: 'first' })
  receiveExportActivity({ revision: 1, activeJob: { jobId: 'first' } })
  first.update({ progress: { progress: 60 } })
  assert.equal(store.getState().localActivity.progress.progress, 60)
  receiveExportActivity({ revision: 2, activeJob: null })
  first.end()
  assert.equal(isExportBusy(), true)
  assert.equal(store.getState().localActivity.status, 'queue')
  const second = beginLocalExportActivity({ status: 'second' })
  first.end(); first.update({ status: 'late' })
  assert.equal(store.getState().localActivity.status, 'second')
  second.end(); queue.end()
  assert.equal(isExportBusy(), false)
})
test('ending local preparation cannot unlock an active native job', () => {
  reset()
  const local = beginLocalExportActivity()
  receiveExportActivity({ revision: 1, activeJob: { jobId: 'native' } })
  local.end()
  assert.equal(isExportBusy(), true)
  receiveExportActivity({ revision: 2, activeJob: null })
  assert.equal(isExportBusy(), false)
})

const bridgeSource = fs.readFileSync(new URL('../src/services/exportActivity.js', import.meta.url), 'utf8')
  .replace(/^import .*\n/gm, '').replace('export function startExportActivityBridge', 'function startExportActivityBridge')
function fakeStore(initial) {
  const listeners = new Set()
  const state = { ...initial }
  const set = patch => { Object.assign(state, patch); for (const listener of listeners) listener(state) }
  return { getState: () => state, setState: set, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } }
}
function harness() {
  reset()
  const previewCache = new VideoCache()
  const timeline = fakeStore({ isPlaying: true, shuttleMode: true, playAround: null })
  timeline.getState().shuttlePause = () => timeline.setState({ isPlaying: false, shuttleMode: false })
  const assets = fakeStore({ isPlaying: true })
  assets.getState().setIsPlaying = isPlaying => assets.setState({ isPlaying })
  const listeners = new Map()
  const target = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) }
  let nativeListener, resolveRead
  const api = { onExportActivity: cb => { nativeListener = cb; return () => { nativeListener = null } },
    getExportActivity: () => new Promise(resolve => { resolveRead = resolve }) }
  const start = vm.runInNewContext(bridgeSource + '\nstartExportActivityBridge', {
    useExportActivityStore: store, useTimelineStore: timeline, useAssetsStore: assets,
    videoCache: previewCache, isExportBusy, receiveExportActivity, console,
  })
  const stop = start({ api, windowTarget: target })
  return { timeline, assets, previewCache, listeners, stop, publish: value => nativeListener(value), resolveRead }
}
test('native begin synchronously pauses both transports and prevents programmatic restart', async () => {
  const h = harness()
  h.publish({ revision: 2, activeJob: { jobId: 'render' } })
  assert.equal(h.timeline.getState().isPlaying, false)
  assert.equal(h.assets.getState().isPlaying, false)
  h.timeline.setState({ isPlaying: true })
  assert.equal(h.timeline.getState().isPlaying, false)
  h.resolveRead({ revision: 1, activeJob: null })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(isExportBusy(), true)
  h.publish({ revision: 3, activeJob: null })
  h.timeline.setState({ isPlaying: true })
  assert.equal(h.timeline.getState().isPlaying, true)
  h.stop()
  assert.equal(h.listeners.size, 0)
})
test('shortcuts and pointer actions are blocked while native button activation remains usable', () => {
  const h = harness(), lease = beginLocalExportActivity()
  const event = (key, allowed = false) => ({ key, target: { closest: () => allowed }, prevented: false, stopped: false,
    preventDefault() { this.prevented = true }, stopImmediatePropagation() { this.stopped = true } })
  for (const key of [' ', 'l', 'j', 'Delete', 'Escape', 'z']) {
    const input = event(key)
    h.listeners.get('keydown')(input)
    assert.equal(input.prevented, true); assert.equal(input.stopped, true)
  }
  const button = event('Enter', true)
  h.listeners.get('keydown')(button)
  assert.equal(button.prevented, false); assert.equal(button.stopped, true)
  const click = event('click')
  h.listeners.get('click')(click)
  assert.equal(click.prevented, true)
  lease.end()
  const free = event('l')
  h.listeners.get('keydown')(free)
  assert.equal(free.prevented, false)
  h.stop()
})

test('new independent HTML media playback is paused during export only', () => {
  const h = harness(), lease = beginLocalExportActivity()
  let paused = 0
  const media = { pause() { paused++ } }
  h.listeners.get('play')({ target: media })
  assert.equal(paused, 1)
  lease.end()
  h.listeners.get('play')({ target: media })
  assert.equal(paused, 1)
  h.stop()
})

for (const owner of ['native', 'local']) {
  test(`${owner} acquisition pauses detached preview media before transport teardown and never resumes it`, () => {
    const h = harness()
    let pauses = 0, plays = 0, pausedAtTransportStop = null, lease = null
    // Canvas preview owns pooled videos that are never attached to the DOM.
    // Use the actual pool's pauseAll implementation, without any React effects.
    const video = { paused: false, src: 'memory-preview.mp4',
      pause() { this.paused = true; pauses++ },
      play() { this.paused = false; plays++ },
      load() { throw new Error('Export must not reload or dispose preview media') } }
    const entry = { videoElement: video, ready: true, url: video.src }
    h.previewCache.cache.set('detached-preview', entry)
    h.previewCache.activeElements.add('detached-preview')
    const unsubscribe = h.timeline.subscribe(() => {
      if (!h.timeline.getState().isPlaying) pausedAtTransportStop = video.paused
    })
    try {
      if (owner === 'native') h.publish({ revision: 1, activeJob: { jobId: 'render' } })
      else lease = beginLocalExportActivity({ status: 'Preparing export' })

      assert.equal(video.paused, true, 'pooled preview pauses synchronously without a DOM media event')
      assert.equal(pausedAtTransportStop, true, 'pause precedes transport updates that may unmount preview')
      assert.equal(pauses, 1)
      assert.equal(h.previewCache.cache.get('detached-preview'), entry, 'cached media is retained')
      assert.equal(h.previewCache.activeElements.has('detached-preview'), true)
      assert.equal(video.src, 'memory-preview.mp4')

      if (owner === 'native') h.publish({ revision: 2, activeJob: { jobId: 'render', progress: { progress: 50 } } })
      else lease.update({ progress: { progress: 50 } })
      assert.equal(pauses, 1, 'progress does not repeatedly touch paused media')
      if (owner === 'native') h.publish({ revision: 3, activeJob: null })
      else lease.end()

      assert.equal(video.paused, true, 'completion does not resume preview')
      assert.equal(plays, 0)
      assert.equal(h.previewCache.cache.get('detached-preview'), entry)
      video.play()
      assert.equal(video.paused, false, 'normal preview may play again after export')
      const nextLease = beginLocalExportActivity()
      assert.equal(video.paused, true, 'the next export pauses a newly playing cached video')
      assert.equal(pauses, 2)
      nextLease.end()
      assert.equal(plays, 1, 'ending the next export does not auto-resume either')
    } finally {
      lease?.end()
      unsubscribe()
      h.stop()
    }
  })
}
