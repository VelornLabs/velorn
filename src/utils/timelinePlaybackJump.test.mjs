import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { createPlaybackJump, getCurrentPlaybackJump } from './playbackJump.mjs'
import { createPlayAround, getCurrentPlayAround, stopPlayAroundPatch } from './playAround.mjs'

// Execute the actual hook's callbacks with deterministic RAF/timers. Only React
// scheduling and the store boundary are stubbed; the transport loop, hold,
// subscription epoch reset and watchdog are production code.
const hookPath = new URL('../hooks/useTimelinePlayback.js', import.meta.url)
const hookSource = readFileSync(hookPath, 'utf8').replace(
  "import useTimelineStore from '../stores/timelineStore'", 'const useTimelineStore = __testStore')
assert.ok(hookSource.includes('const useTimelineStore = __testStore'))
const code = buildSync({ stdin: { contents: hookSource, resolveDir: fileURLToPath(new URL('../hooks/', import.meta.url)),
  sourcefile: 'useTimelinePlayback.js' }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'],
}).outputFiles[0].text

function harness(patch = {}) {
  let now = 0, nextId = 1, revision = 0
  const frames = new Map(), timers = new Map(), subscribers = new Set(), effects = [], writes = [], failures = [], finishes = []
  let state
  const update = patch => {
    const previous = state
    state = { ...state, ...patch }
    for (const subscriber of [...subscribers]) subscriber(state, previous)
  }
  const request = target => {
    const next = { ...state, playheadPosition: target }
    update({ playheadPosition: target, playbackJump: createPlaybackJump(next, target, ++revision, now) })
    return state.playbackJump
  }
  state = { isPlaying: true, playheadPosition: 5, playbackRate: 1, loopMode: 'normal', inPoint: null, outPoint: null,
    timelineSessionId: 1, timelineFps: 24, compoundEditContext: null, clips: [], tracks: [], transitions: [], selectedClipIds: [],
    playbackJump: null, getActiveClipAtTime: () => null, getTransitionAtTime: () => null, getTimelineEndTime: () => 10,
    togglePlay: () => update({ isPlaying: !state.isPlaying }), shuttlePause: () => update({ isPlaying: false }),
    setPlayheadPosition: (position, options) => {
      writes.push({ position, options })
      if (options?.discontinuity) request(position)
      else update({ playheadPosition: position })
    }, failPlaybackJump: (token, reason) => {
      if (getCurrentPlaybackJump(state)?.token !== token) return false
      failures.push({ token, reason })
      update({ playbackJump: null, isPlaying: false })
      return true
    },
    finishPlayAround: token => {
      const audition = getCurrentPlayAround(state)
      if (!audition || audition.token !== token) return false
      finishes.push(token)
      update({ ...stopPlayAroundPatch(state), playheadPosition: audition.returnTime })
      return true
    },
    cancelPlayAround: token => {
      if (!state.playAround || (token != null && state.playAround.token !== token)) return false
      update(stopPlayAroundPatch(state))
      return true
    }, ...patch }
  const store = selector => (typeof selector === 'function' ? selector(state) : state)
  store.getState = () => state
  store.subscribe = callback => { subscribers.add(callback); return () => subscribers.delete(callback) }
  const react = { useRef: value => ({ current: value }), useCallback: callback => callback,
    useEffect: callback => effects.push(callback) }
  const module = { exports: {} }
  Function('require', 'module', 'exports', '__testStore', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame',
    'setTimeout', 'clearTimeout', 'Date', code)(name => {
      assert.equal(name, 'react'); return react
    }, module, module.exports, store, { now: () => now },
    callback => { const id = nextId++; frames.set(id, callback); return id }, id => frames.delete(id),
    (callback, delay) => { const id = nextId++; timers.set(id, { callback, at: now + delay }); return id },
    id => timers.delete(id), { now: () => now })
  module.exports.useTimelinePlayback()
  const cleanups = effects.map(effect => effect())
  const advance = (ms, tick = true) => {
    now += ms
    for (const [id, timer] of [...timers]) if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.callback() }
    if (tick) {
      const pending = [...frames]
      frames.clear()
      for (const [, callback] of pending) callback(now)
    }
  }
  const audition = center => {
    const session = createPlayAround(state, center, ++revision)
    assert.ok(session)
    update({ playAround: session, isPlaying: true, playbackRate: 1, shuttleMode: false, playheadPosition: session.startTime,
      playbackJump: createPlaybackJump({ ...state, playbackRate: 1 }, session.startTime, ++revision, now) })
    return session
  }
  return { state: () => state, update, request, writes, failures, finishes, audition, advance,
    complete: () => update({ playbackJump: null }), dispose: () => cleanups.forEach(cleanup => cleanup?.()) }
}

test('target stays frozen and a decoder hold never accrues into the first resumed step', () => {
  const h = harness()
  try {
    h.advance(16)
    assert.equal(h.state().playheadPosition, 5.016)
    h.request(2)
    const before = h.writes.length
    h.advance(2000)
    assert.equal(h.state().playheadPosition, 2)
    assert.equal(h.writes.length, before)
    h.advance(100, false)
    h.complete()
    h.advance(16)
    assert.equal(h.state().playheadPosition, 2.016)
    assert.equal(h.writes.at(-1).options.source, 'transport')
    assert.equal(h.failures.length, 0)
  } finally { h.dispose() }
})

test('watchdog deadline follows the newest token and bounded failure stops the clock', () => {
  const h = harness()
  try {
    h.request(2)
    h.advance(2000)
    const latest = h.request(7)
    h.advance(3000)
    assert.equal(h.failures.length, 0, 'old request deadline was canceled')
    h.advance(1999)
    assert.equal(h.state().isPlaying, true)
    h.advance(1)
    assert.equal(h.failures.length, 1)
    assert.equal(h.failures[0].token, latest.token)
    assert.equal(h.state().isPlaying, false)
    const before = h.writes.length
    h.advance(1000)
    assert.equal(h.writes.length, before)
  } finally { h.dispose() }
})

test('pause and session replacement retire the old watchdog without mutating the replacement', () => {
  for (const patch of [{ isPlaying: false }, { timelineSessionId: 2, playbackJump: null }]) {
    const h = harness()
    try {
      h.request(2)
      h.advance(1000)
      h.update(patch)
      h.advance(5000, false)
      assert.equal(h.failures.length, 0)
    } finally { h.dispose() }
  }
})

test('forward and reverse loop wraps create discontinuities; ordinary movement does not', () => {
  for (const { position, rate, expected } of [{ position: 9.99, rate: 1, expected: 0 }, { position: 0.01, rate: -1, expected: 10 }]) {
    const h = harness({ playheadPosition: position, playbackRate: rate, loopMode: 'loop' })
    try {
      h.advance(20)
      assert.equal(h.state().playheadPosition, expected)
      assert.equal(h.writes[0].options.source, 'transport')
      assert.equal(h.writes[0].options.discontinuity, true)
      assert.ok(getCurrentPlaybackJump(h.state()))
      h.advance(500)
      assert.equal(h.state().playheadPosition, expected)
      assert.equal(h.writes.length, 1)
    } finally { h.dispose() }
  }
})

test('normal timeline end stops instead of waiting for a nonexistent next picture', () => {
  const h = harness({ playheadPosition: 9.99 })
  try {
    h.advance(20)
    assert.equal(h.state().playheadPosition, 10)
    assert.equal(h.state().isPlaying, false)
    assert.equal(h.state().playbackJump, null)
    assert.equal(h.writes[0].options.source, 'transport')
  } finally { h.dispose() }
})

test('Play Around runs once at 1x regardless of loop preference and returns after four played seconds', () => {
  for (const loopMode of ['normal', 'loop', 'loop-in-out', 'loop-selection', 'ping-pong']) {
    const h = harness({ loopMode, playbackRate: -4, shuttleMode: true, inPoint: 8, outPoint: 9,
      clips: [{ id: 'a', startTime: 0, duration: 10 }], selectedClipIds: ['a'] })
    try {
      const session = h.audition(5)
      h.advance(1900)
      assert.equal(h.state().playheadPosition, 3, 'decoder wait is not preview time')
      h.complete()
      h.advance(1000)
      assert.equal(h.state().playheadPosition, 4)
      h.advance(2999)
      assert.equal(h.state().isPlaying, true)
      h.advance(1)
      assert.deepEqual(h.finishes, [session.token])
      assert.equal(h.state().playheadPosition, 5)
      assert.equal(h.state().isPlaying, false)
      assert.equal(h.state().playbackRate, -4)
      assert.equal(h.state().shuttleMode, true)
      assert.equal(h.state().loopMode, loopMode)
      assert.equal(h.state().inPoint, 8)
      h.advance(5000)
      assert.equal(h.finishes.length, 1)
    } finally { h.dispose() }
  }
})

test('Play Around retrigger renews decoder ownership and starts a fresh played interval', () => {
  const h = harness({ clips: [{ id: 'a', startTime: 0, duration: 10 }] })
  try {
    const first = h.audition(5)
    h.complete(); h.advance(2000)
    const second = h.audition()
    assert.notEqual(first.token, second.token)
    h.advance(500)
    assert.equal(h.state().playheadPosition, 3)
    h.complete(); h.advance(3999)
    assert.equal(h.finishes.length, 0)
    h.advance(1)
    assert.deepEqual(h.finishes, [second.token])
    assert.equal(h.state().playheadPosition, 5)
  } finally { h.dispose() }
})

test('Play Around observes authored changes and unmount without a stale return', () => {
  for (const change of ['clip', 'range', 'unmount', 'session']) {
    const h = harness({ clips: [{ id: 'a', startTime: 0, duration: 10 }] })
    try {
      h.audition(5); h.complete(); h.advance(500)
      if (change === 'clip') h.update({ clips: [{ id: 'replacement', startTime: 0, duration: 10 }] })
      if (change === 'range') h.update({ inPoint: 2 })
      if (change === 'unmount') h.dispose()
      if (change === 'session') h.update({ timelineSessionId: 9, playheadPosition: 1, isPlaying: false })
      assert.equal(h.state().playAround, null)
      assert.equal(h.state().isPlaying, false)
      assert.equal(h.state().playheadPosition, change === 'session' ? 1 : 3.5)
      h.advance(10000)
      assert.equal(h.finishes.length, 0)
    } finally { h.dispose() }
  }
})
