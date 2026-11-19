import test from 'node:test'
import assert from 'node:assert/strict'
import { getClipAgentTiming } from './clipAgentTiming.mjs'
import { getClipPlaybackTimingAtTimeline } from './clipPlaybackTiming.js'

const asset = Object.freeze({ id: 'take', type: 'video', duration: 60 })
const video = (extra = {}) => ({
  id: 'clip', assetId: asset.id, type: 'video', startTime: 10, duration: 3,
  trimStart: 2, trimEnd: 5, sourceDuration: 60, speed: 1, sourceTimeScale: 1,
  sourceFps: 24, timelineFps: 24, reverse: false, ...extra,
})
const timing = (extra = {}) => getClipAgentTiming(video(extra), { asset })

test('trimmed picture midpoint is the retained segment, not half the full recording', () => {
  const clip = Object.freeze(video()), before = structuredClone(clip)
  const result = getClipAgentTiming(clip, { asset })
  assert.deepEqual(clip, before)
  assert.deepEqual(result.timeline, { status: 'available', startSeconds: 10, durationSeconds: 3,
    endSeconds: 13, midpointSeconds: 11.5, endExclusive: true })
  assert.deepEqual(result.source, { status: 'available', reference: 'original-media', mapping: 'constant-speed',
    trimInSeconds: 2, trimOutSeconds: 5, startBoundarySeconds: 2, endBoundarySeconds: 5,
    midpointSeconds: 3.5, midpointClamped: false })
  assert.equal(timing({ startTime: 0, trimStart: 0, trimEnd: 3 }).source.midpointSeconds, 1.5)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test('constant speed and timebase conversion reuse playback mapping exactly once', () => {
  for (const extra of [
    { speed: 2, trimEnd: 8 }, { speed: 0.5, trimEnd: 3.5 },
    { speed: 0.5, sourceTimeScale: 2 },
    { sourceTimeScale: undefined, timelineFps: 30, sourceFps: 60, trimEnd: 3.5 },
    { sourceTimeScale: null, timelineFps: 30000 / 1001, sourceFps: 60, trimEnd: 5 },
  ]) {
    const clip = video(extra), computed = getClipAgentTiming(clip, { asset })
    const expected = getClipPlaybackTimingAtTimeline(clip, 11.5, 0.000001, { useFrameSampling: false })
    assert.equal(computed.source.status, 'available')
    assert.equal(computed.source.midpointSeconds, expected.time)
  }
  assert.equal(timing({ speed: 2, trimEnd: 8 }).source.midpointSeconds, 5)
  assert.equal(timing({ speed: 0.5, trimEnd: 3.5 }).source.midpointSeconds, 2.75)
})

test('reverse maps from trim-out, with boundary values distinguished from seek targets', () => {
  const result = timing({ reverse: true, duration: 2 })
  assert.equal(result.source.mapping, 'reverse')
  assert.equal(result.source.startBoundarySeconds, 5)
  assert.equal(result.source.endBoundarySeconds, 3)
  assert.equal(result.source.midpointSeconds, 4)
  assert.equal(result.timeline.midpointSeconds, 11)
})

test('source exhaustion reports the same clamp as playback, never extrapolated source time', () => {
  const result = timing({ duration: 12 })
  assert.equal(result.source.status, 'available')
  assert.equal(result.source.endBoundarySeconds, 5)
  assert.equal(result.source.midpointSeconds, 4.999999)
  assert.equal(result.source.midpointClamped, true)
})

test('valid missing optional trim/speed fields follow playback fallback semantics', () => {
  const source = timing({ trimStart: undefined, trimEnd: undefined, sourceDuration: undefined,
    speed: undefined, sourceTimeScale: undefined, sourceFps: undefined, timelineFps: undefined }).source
  assert.equal(source.status, 'available')
  assert.equal(source.trimInSeconds, 0)
  assert.equal(source.trimOutSeconds, 3)
  assert.equal(source.midpointSeconds, 1.5)
})

test('Optical Flow cache settings do not turn original-media times into cache-local times', () => {
  const result = timing({ frameSampling: 'optical-flow', opticalFlowCache: {
    status: 'ready', url: 'memory:cache', sourceStart: 1, sourceEnd: 8, targetFps: 48,
  } })
  assert.equal(result.source.reference, 'original-media')
  assert.equal(result.source.midpointSeconds, 3.5)
})

test('active non-linear mapping is explicitly unsupported and has no guessed source timestamp', () => {
  const keyframes = { speed: [{ time: 0, value: 1 }, { time: 3, value: 2 }] }
  const result = timing({ keyframes })
  assert.equal(result.timeline.midpointSeconds, 11.5)
  assert.equal(result.source.status, 'unsupported')
  assert.equal(result.source.reason, 'active-speed-ramp')
  assert.equal(result.source.midpointSeconds, null)
  // Playback explicitly ignores ramps on reverse clips; the shared metadata
  // must follow that rule rather than treating inactive keyframes as active.
  assert.equal(timing({ reverse: true, keyframes }).source.status, 'available')
})

test('still images and generated layers retain timeline timing but invent no source timestamp', () => {
  for (const type of ['image', 'text', 'shape', 'captions', 'adjustment']) {
    const result = timing({ type })
    assert.equal(result.timeline.midpointSeconds, 11.5)
    assert.equal(result.source.status, 'not-applicable')
    assert.equal(result.source.midpointSeconds, null)
  }
  assert.equal(timing({ compound: { document: {} } }).source.status, 'unsupported')
  assert.equal(timing({ type: 'audio' }).source.status, 'unsupported')
})

test('missing or mismatched asset references do not claim a usable original source', () => {
  for (const candidate of [null, { id: 'other', type: 'video' }]) {
    const result = getClipAgentTiming(video(), { asset: candidate })
    assert.equal(result.source.status, 'unavailable')
    assert.equal(result.source.reason, 'source-asset-not-in-project')
    assert.equal(result.source.midpointSeconds, null)
  }
  assert.equal(getClipAgentTiming(video(), { asset: { id: 'take', type: 'image' } }).source.status, 'unsupported')
})

test('invalid or non-numeric timeline values are unavailable rather than silently normalized', () => {
  for (const extra of [{ startTime: NaN }, { startTime: Infinity }, { startTime: -1 }, { startTime: '10' },
    { startTime: null }, { duration: NaN }, { duration: 0 }, { duration: -1 }, { duration: '3' },
    { startTime: Number.MAX_VALUE, duration: Number.MAX_VALUE }]) {
    const result = timing(extra)
    assert.equal(result.timeline.status, 'unavailable', JSON.stringify(extra))
    assert.equal(result.timeline.midpointSeconds, null)
    assert.equal(result.source.midpointSeconds, null)
  }
})

test('invalid source bounds and playback fields cannot become verified timestamps', () => {
  for (const extra of [{ trimStart: -1 }, { trimStart: '2' }, { trimEnd: 2 }, { trimEnd: 1 },
    { trimEnd: Infinity }, { trimEnd: 61 }, { sourceDuration: 0 }, { sourceDuration: Infinity },
    { speed: 0 }, { speed: -1 }, { speed: '2' }, { sourceTimeScale: 0 }, { sourceTimeScale: Infinity },
    { sourceFps: -1 }, { timelineFps: NaN }, { reverse: 'false' }]) {
    const result = timing(extra)
    assert.equal(result.source.status, 'unavailable', JSON.stringify(extra))
    assert.equal(result.source.midpointSeconds, null)
    assert.equal(result.timeline.status, 'available')
  }
})
