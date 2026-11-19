import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildSync, transformSync } from 'esbuild'
import { getPlaybackReviewRange } from './playbackReviewRange.mjs'
import { createPlaybackJump } from './playbackJump.mjs'
import { stepTimeByFrames, timeToFrameIndex } from './timelineFrames.js'
import { formatExportOverviewTimecode } from './exportTimelineOverview.mjs'
import { nextShuttleRate } from './shuttlePlayback.js'

const componentSource = readFileSync(new URL('../components/ExportReviewPreview.jsx', import.meta.url), 'utf8')
const componentCode = transformSync(componentSource, { loader: 'jsx', format: 'cjs', jsxFactory: '__jsx' }).code
const hookSource = readFileSync(new URL('../hooks/useTimelinePlayback.js', import.meta.url), 'utf8')
  .replace("import useTimelineStore from '../stores/timelineStore'", 'const useTimelineStore = __testStore')
const hookCode = buildSync({ stdin: { contents: hookSource,
  resolveDir: fileURLToPath(new URL('../hooks/', import.meta.url)), sourcefile: 'useTimelinePlayback.js' },
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react'],
}).outputFiles[0].text

function componentHarness(patch = {}) {
  let state, reads = 0, pauses = 0, pooledPauses = 0
  const effects = []
  const writes = []
  const keyboards = new Set()
  let mediaPreparation = null
  state = { playheadPosition: 3, isPlaying: false, timelineFps: 24, timelineSessionId: 4,
    clips: [{ id: 'clip-a', startTime: 0, duration: 10 }], selectedClipIds: ['clip-a'], inPoint: 2, outPoint: 8,
    playbackRate: -4, loopMode: 'loop-selection', history: ['original'],
    getTimelineEndTime: () => 10,
    shuttlePause: () => { pauses += 1; state = { ...state, isPlaying: false, playbackRate: 1, playbackJump: null } },
    shuttleForward: () => { state = { ...state, isPlaying: true, playbackRate: nextShuttleRate(state, 'forward') } },
    shuttleReverse: () => { state = { ...state, isPlaying: true, playbackRate: nextShuttleRate(state, 'reverse') } },
    shuttleSlow: (direction, step) => { state = { ...state, isPlaying: true,
      playbackRate: step ? nextShuttleRate(state, direction, true) : direction === 'reverse' ? -0.5 : 0.5 } },
    setPlayheadPosition: (position, options) => { writes.push({ position, options }); state = { ...state, playheadPosition: position } },
    togglePlay: () => {
      const rewinds = !state.isPlaying && state.loopMode === 'normal' && state.playheadPosition >= state.getTimelineEndTime() - 0.001
      state = { ...state, isPlaying: !state.isPlaying, playbackRate: 1, playheadPosition: rewinds ? 0 : state.playheadPosition }
    }, ...patch }
  const store = () => { reads += 1; return state }
  store.getState = () => state
  const projectStore = () => ({ getCurrentTimelineSettings: () => ({ width: 1920, height: 1080, fps: state.timelineFps }) })
  const PreviewPanel = () => null
  const react = { useLayoutEffect: effect => effects.push(effect), useMemo: callback => callback() }
  const module = { exports: {} }
  Function('require', 'module', 'exports', '__jsx', componentCode)(name => {
    if (name === 'react') return react
    if (name === 'lucide-react') return Object.fromEntries(['ChevronLeft', 'ChevronRight', 'Film', 'Pause', 'Play', 'SkipBack', 'SkipForward'].map(key => [key, key]))
    if (name === '../stores/timelineStore') return store
    if (name === '../stores/projectStore') return projectStore
    if (name === '../stores/assetsStore') return { getState: () => ({ mediaPreparation }) }
    if (name === '../services/videoCache') return { pauseAll: () => { pooledPauses += 1 } }
    if (name === '../utils/timelineFrames') return { stepTimeByFrames, timeToFrameIndex }
    if (name === '../utils/exportTimelineOverview.mjs') return { formatExportOverviewTimecode }
    if (name === '../utils/playbackReviewRange.mjs') return { getPlaybackReviewRange }
    if (name === '../utils/reviewTransportKeyboard.mjs') return { attachReviewTransportKeyboard: options => {
      keyboards.add(options)
      return () => keyboards.delete(options)
    } }
    if (name === './PreviewPanel') return PreviewPanel
    throw new Error(`Unexpected import: ${name}`)
  }, module, module.exports, (type, props, ...children) => ({ type, props: { ...props, children } }))
  const render = props => module.exports.default(props)
  const mount = props => {
    const outer = render({ active: true, rangeStart: 2, rangeEnd: 4, ...props })
    const tree = outer.type(outer.props)
    const cleanups = effects.map(effect => effect())
    return { tree, unmount: () => cleanups.forEach(cleanup => cleanup?.()) }
  }
  return { render, mount, PreviewPanel, state: () => state, update: patch => { state = { ...state, ...patch } }, writes,
    dispatch: action => { for (const keyboard of keyboards) if (keyboard.canHandle()) keyboard.onAction(action) },
    keyboardCount: () => keyboards.size, prepare: value => { mediaPreparation = value },
    counters: () => ({ reads, pauses, pooledPauses, effects: effects.length }) }
}

function findNode(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null
  if (predicate(tree)) return tree
  for (const child of tree.props?.children?.flat(Infinity) || []) {
    const found = findNode(child, predicate)
    if (found) return found
  }
  return null
}

function clockHarness(options = {}, patch = {}) {
  let now = 1000, serial = 0, state
  const frames = new Map(), timers = new Map(), effects = [], subscribers = new Set(), writes = [], failures = []
  let cancelCalls = 0
  const update = patch => {
    const previous = state
    state = { ...state, ...patch }
    for (const subscriber of subscribers) subscriber(state, previous)
  }
  state = { isPlaying: true, playheadPosition: 2, playbackRate: 1, timelineFps: 24, timelineSessionId: 7,
    loopMode: 'loop-selection', selectedClipIds: ['keep'], inPoint: 0.5, outPoint: 9,
    clips: [{ id: 'keep', startTime: 0, duration: 10 }], tracks: [], transitions: [], playbackJump: null,
    getActiveClipAtTime: () => null, getTransitionAtTime: () => null, getTimelineEndTime: () => 10,
    togglePlay: () => update({ isPlaying: !state.isPlaying }), shuttlePause: () => update({ isPlaying: false, playbackJump: null }),
    setPlayheadPosition: (position, options) => { writes.push({ position, options }); update({ playheadPosition: position }) },
    cancelPlayAround: () => { cancelCalls += 1 }, failPlaybackJump: (token, reason) => {
      failures.push({ token, reason }); update({ playbackJump: null, isPlaying: false })
    }, ...patch }
  const store = selector => (typeof selector === 'function' ? selector(state) : state)
  store.getState = () => state
  store.subscribe = callback => { subscribers.add(callback); return () => subscribers.delete(callback) }
  const module = { exports: {} }
  Function('require', 'module', 'exports', '__testStore', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'Date', hookCode)(
    name => { assert.equal(name, 'react'); return { useRef: current => ({ current }), useCallback: callback => callback, useEffect: effect => effects.push(effect) } },
    module, module.exports, store, { now: () => now },
    callback => { const id = ++serial; frames.set(id, callback); return id }, id => frames.delete(id),
    (callback, delay) => { const id = ++serial; timers.set(id, { callback, at: now + delay }); return id }, id => timers.delete(id), { now: () => now })
  module.exports.useTimelinePlayback(options)
  const cleanups = effects.map(effect => effect())
  const advance = milliseconds => {
    now += milliseconds
    for (const [id, timer] of [...timers]) if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.callback() }
    const callbacks = [...frames.values()]; frames.clear()
    callbacks.forEach(callback => callback(now))
  }
  return { state: () => state, update, advance, writes, failures,
    request: target => update({ playheadPosition: target, playbackJump: createPlaybackJump(state, target, ++serial, now) }),
    unmount: () => cleanups.forEach(cleanup => cleanup?.()),
    counters: () => ({ frames: frames.size, timers: timers.size, subscribers: subscribers.size, cancelCalls }) }
}

test('review range end is exclusive and retains the final included picture', () => {
  assert.deepEqual(getPlaybackReviewRange({ start: 2, end: 4 }, 10, 24),
    { start: 2, end: 4, lastFrame: 2 + 47 / 24, fps: 24, duration: 2, frameCount: 48 })
  assert.equal(getPlaybackReviewRange({ start: 2, end: 2 + 1 / 24 }, 10, 24).lastFrame, 2)
  assert.equal(getPlaybackReviewRange({ start: 2, end: 1 }, 10, 24).duration, 0)
  assert.equal(getPlaybackReviewRange({ start: 0, end: null }, 10, 24).end, 10)
})

test('hidden and busy review boundaries mount no preview, store subscriptions, effects, or clocks', () => {
  const h = componentHarness()
  assert.equal(h.render({}), null)
  assert.equal(h.render({ active: false, disabled: false }), null)
  const busy = h.render({ active: true, disabled: true })
  assert.equal(busy.props['data-testid'], 'export-review-paused')
  assert.equal(findNode(busy, node => node.type === h.PreviewPanel), null)
  assert.deepEqual(h.counters(), { reads: 0, pauses: 0, pooledPauses: 0, effects: 0 })
})

test('mounting review reuses PreviewPanel without moving playhead or changing authored state', () => {
  const h = componentHarness()
  const before = h.state()
  const { tree, unmount } = h.mount()
  const picture = findNode(tree, node => node.type === h.PreviewPanel)
  assert.equal(picture.props.reviewOnly, true)
  assert.equal(picture.props.playbackRange.start, 2)
  assert.equal(picture.props.playbackRange.end, 4)
  assert.equal(h.state(), before)
  assert.equal(h.writes.length, 0)
  unmount()
  assert.equal(h.state(), before, 'paused cleanup must not reset shuttle preference or selection')
  assert.equal(h.counters().pooledPauses, 1)
})

test('busy/tab-away unmount pauses playback and pooled decoders without moving the held target', () => {
  for (const playbackJump of [null, { token: 'held-target', targetTime: 3 }]) {
    const h = componentHarness({ isPlaying: true, playbackJump })
    const before = h.state()
    const { unmount } = h.mount()
    unmount()
    assert.equal(h.state().isPlaying, false)
    assert.equal(h.state().playbackJump, null)
    assert.equal(h.state().playheadPosition, 3)
    for (const key of ['clips', 'selectedClipIds', 'inPoint', 'outPoint', 'history', 'loopMode']) assert.equal(h.state()[key], before[key])
    assert.equal(h.writes.length, 0)
    assert.equal(h.counters().pooledPauses, 1)
  }
})

test('cleanup cannot pause a replacement timeline session', () => {
  const h = componentHarness({ isPlaying: true })
  const { unmount } = h.mount()
  h.update({ timelineSessionId: 99, playheadPosition: 5 })
  unmount()
  assert.equal(h.state().isPlaying, true)
  assert.equal(h.state().playheadPosition, 5)
  assert.equal(h.counters().pauses, 0)
})

test('review transport restarts its range explicitly and frame steps use precise seek intent', () => {
  const h = componentHarness({ playheadPosition: 9 })
  const { tree, unmount } = h.mount()
  findNode(tree, node => node.props['data-testid'] === 'export-review-play').props.onClick()
  assert.equal(h.state().playheadPosition, 2)
  assert.equal(h.state().isPlaying, true)
  findNode(tree, node => node.props['aria-label'] === 'Next frame').props.onClick()
  assert.equal(h.state().isPlaying, false)
  assert.equal(h.state().playheadPosition, 2 + 1 / 24)
  assert.deepEqual(h.writes.at(-1).options, { snap: true, intent: 'frame-step' })
  unmount()
})

test('keyboard review actions use bounded button paths without changing authored state', () => {
  const h = componentHarness({ playheadPosition: 9 })
  const before = h.state()
  const { unmount } = h.mount()
  assert.equal(h.keyboardCount(), 1)
  h.dispatch('toggle')
  assert.equal(h.state().isPlaying, true)
  assert.equal(h.state().playheadPosition, 2)
  h.dispatch('pause')
  h.dispatch('next-frame')
  assert.equal(h.state().playheadPosition, 2 + 1 / 24)
  h.dispatch('previous-frame')
  h.dispatch('previous-frame')
  assert.equal(h.state().playheadPosition, 2)
  h.dispatch('end')
  assert.equal(timeToFrameIndex(h.state().playheadPosition, 24), 95)
  h.dispatch('next-frame')
  assert.equal(timeToFrameIndex(h.state().playheadPosition, 24), 95)
  h.dispatch('start')
  assert.equal(h.state().playheadPosition, 2)
  for (const key of ['inPoint', 'outPoint', 'clips', 'selectedClipIds', 'history', 'loopMode']) assert.equal(h.state()[key], before[key])
  unmount()
  assert.equal(h.keyboardCount(), 0)
  h.dispatch('toggle')
  assert.equal(h.state().isPlaying, false)
})

test('keyboard shuttles reuse fast, slow, held-K ladders and restart the correct range edge', () => {
  const h = componentHarness({ playheadPosition: 9 })
  const { unmount } = h.mount()
  h.dispatch('forward')
  assert.equal(h.state().playheadPosition, 2)
  assert.equal(h.state().playbackRate, 1)
  for (const expected of [2, 4, 8, 8]) { h.dispatch('forward'); assert.equal(h.state().playbackRate, expected) }
  for (const expected of [0.5, 0.25, 0.125, 0.125]) { h.dispatch('slow-forward'); assert.equal(h.state().playbackRate, expected) }
  h.dispatch('pause')
  h.dispatch('reverse')
  assert.equal(timeToFrameIndex(h.state().playheadPosition, 24), 95)
  assert.equal(h.state().playbackRate, -1)
  // The store snaps to global frame time (95 / 24), which can differ by a
  // floating-point epsilon from the range helper's 2 + 47 / 24 endpoint.
  h.update({ playheadPosition: 95 / 24 })
  for (const expected of [-2, -4, -8, -8]) { h.dispatch('reverse'); assert.equal(h.state().playbackRate, expected) }
  for (const expected of [-0.5, -0.25, -0.125, -0.125]) { h.dispatch('slow-reverse'); assert.equal(h.state().playbackRate, expected) }
  for (const action of ['hold-forward', 'hold-forward', 'hold-reverse', 'hold-reverse']) {
    h.dispatch(action)
    assert.equal(h.state().playbackRate, action.endsWith('reverse') ? -0.5 : 0.5)
  }
  unmount()
})

test('keyboard gate blocks preparation, empty content and stale sessions synchronously', () => {
  const h = componentHarness()
  const { unmount } = h.mount()
  for (const blocker of ['preparation', 'clips', 'session']) {
    h.prepare(blocker === 'preparation' ? { critical: true } : null)
    h.update({ clips: blocker === 'clips' ? [] : [{ id: 'clip-a' }], timelineSessionId: blocker === 'session' ? 99 : 4 })
    const before = h.state()
    for (const action of ['toggle', 'pause', 'next-frame', 'end', 'forward', 'slow-reverse']) h.dispatch(action)
    assert.equal(h.state(), before)
  }
  unmount()
  assert.equal(h.keyboardCount(), 0)
  const empty = componentHarness({ clips: [] })
  const mounted = empty.mount()
  empty.dispatch('toggle')
  assert.equal(empty.state().isPlaying, false)
  mounted.unmount()
})

test('Play restarts at the range In when global-frame snapping lands just below its final-frame time', () => {
  const h = componentHarness({ playheadPosition: 8 / 24 })
  const { unmount } = h.mount({ rangeStart: 1 / 24, rangeEnd: 9 / 24 })
  assert.ok(8 / 24 < getPlaybackReviewRange({ start: 1 / 24, end: 9 / 24 }, 10, 24).lastFrame)
  h.dispatch('toggle')
  assert.equal(h.state().isPlaying, true)
  assert.equal(timeToFrameIndex(h.state().playheadPosition, 24), 1)
  unmount()
})

test('review timecode uses the same frame-count NDF labels as the overview at fractional rates', () => {
  for (const fps of [24000 / 1001, 30000 / 1001]) {
    const nominalFps = Math.round(fps)
    const h = componentHarness({ timelineFps: fps, playheadPosition: nominalFps * 60 / fps })
    const { tree, unmount } = h.mount({ rangeStart: 0, rangeEnd: nominalFps * 120 / fps })
    const current = findNode(tree, node => node.props['data-testid'] === 'export-review-timecode')
    assert.deepEqual(current.props.children, ['00:01:00:00'])
    assert.ok(findNode(tree, node => node.props.children?.includes('00:02:00:00')))
    unmount()
  }
})

test('review playback can begin in a legitimate marked blank tail despite the editor auto-rewind', () => {
  const h = componentHarness({ playheadPosition: 11, loopMode: 'normal' })
  const before = h.state()
  const { tree, unmount } = h.mount({ rangeStart: 11, rangeEnd: 12 })
  findNode(tree, node => node.props['data-testid'] === 'export-review-play').props.onClick()
  assert.equal(h.state().isPlaying, true)
  assert.equal(h.state().playheadPosition, 11)
  assert.deepEqual(h.writes, [{ position: 11, options: { snap: true } }])
  for (const key of ['inPoint', 'outPoint', 'clips', 'selectedClipIds', 'history']) assert.equal(h.state()[key], before[key])
  unmount()
})

test('bounded review uses the shared clock but ignores every editor looping preference', () => {
  for (const loopMode of ['normal', 'loop', 'loop-in-out', 'loop-selection', 'ping-pong']) {
    const h = clockHarness({ playbackRange: { start: 2, end: 4 }, cancelPlayAroundOnUnmount: false }, { loopMode })
    const before = h.state()
    try {
      // Small frame deltas catch a final-frame clamp that would freeze the
      // clock before it ever reaches the exclusive range end.
      for (let frame = 0; frame < 126; frame += 1) h.advance(16)
      assert.equal(h.state().isPlaying, false)
      assert.ok(Math.abs(h.state().playheadPosition - (4 - 1 / 24)) < 1e-12)
      for (const key of ['loopMode', 'selectedClipIds', 'inPoint', 'outPoint', 'clips']) assert.equal(h.state()[key], before[key])
      assert.equal(h.writes.every(write => write.options.source === 'transport'), true)
      assert.equal(h.counters().frames, 0)
    } finally { h.unmount() }
    assert.equal(h.counters().cancelCalls, 0)
  }
})

test('bounded clock keeps a marked blank tail past clip end and stops at its final included frame', () => {
  const h = clockHarness({ playbackRange: { start: 9, end: 12 }, cancelPlayAroundOnUnmount: false },
    { playheadPosition: 9.99, loopMode: 'normal' })
  h.advance(20)
  assert.equal(h.state().isPlaying, true)
  assert.ok(h.state().playheadPosition > 10, 'the last clip is not the marked review endpoint')
  h.advance(2000)
  assert.equal(h.state().isPlaying, false)
  assert.ok(Math.abs(h.state().playheadPosition - (12 - 1 / 24)) < 1e-12)
  h.unmount()
})

test('fractional-rate review keeps its exclusive endpoint frame accurate', () => {
  const fps = 24000 / 1001
  const start = 12 / fps, end = 48 / fps
  const h = clockHarness({ playbackRange: { start, end, fps } }, { playheadPosition: start, timelineFps: fps })
  assert.equal(getPlaybackReviewRange({ start, end }, 10, fps).frameCount, 36)
  h.advance(2000)
  assert.equal(h.state().isPlaying, false)
  assert.ok(Math.abs(h.state().playheadPosition - 47 / fps) < 1e-12)
  h.unmount()
})

test('bounded review preserves decoder-hold timing and cleans all clock work on unmount', () => {
  const h = clockHarness({ playbackRange: { start: 2, end: 4 }, cancelPlayAroundOnUnmount: false })
  h.request(3)
  h.advance(2000)
  assert.equal(h.state().playheadPosition, 3)
  assert.equal(h.writes.length, 0)
  h.update({ playbackJump: null })
  h.advance(16)
  assert.equal(h.state().playheadPosition, 3.016)
  h.request(2.5)
  h.unmount()
  assert.deepEqual(h.counters(), { frames: 0, timers: 0, subscribers: 0, cancelCalls: 0 })
  const count = h.writes.length
  h.advance(10000)
  assert.equal(h.writes.length, count)
  assert.equal(h.failures.length, 0)
})

test('reverse review stops at range start and default editor playback remains unchanged', () => {
  const reverse = clockHarness({ playbackRange: { start: 2, end: 4 } }, { playheadPosition: 2.01, playbackRate: -1 })
  reverse.advance(16)
  assert.equal(reverse.state().playheadPosition, 2)
  assert.equal(reverse.state().isPlaying, false)
  reverse.unmount()
  const editor = clockHarness({}, { loopMode: 'normal', playheadPosition: 9.99 })
  editor.advance(16)
  assert.equal(editor.state().playheadPosition, 10)
  assert.equal(editor.state().isPlaying, false)
  editor.unmount()
  assert.equal(editor.counters().cancelCalls, 1)
})
