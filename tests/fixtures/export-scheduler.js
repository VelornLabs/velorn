// Real exporter/compositor, synthetic images and in-memory output sink. Every
// RAF callback is deliberately suspended, independently of platform timing.
// The default checks scheduling/frames/cancellation, not encoder throughput.
// An optional native pass encodes six seconds to a fixture-owned temporary MP4.
// IPC stays live through the sandboxed preload.
import exportTimeline from '../../src/services/exporter'
import { createExportScheduler } from '../../src/services/exportScheduler.mjs'
import useTimelineStore from '../../src/stores/timelineStore'
import useProjectStore from '../../src/stores/projectStore'
import useAssetsStore from '../../src/stores/assetsStore'

const assert = (condition, message) => { if (!condition) throw new Error(message) }
// Virtual paths only: these APIs never touch disk on any platform.
const root = '/__memory_export_scheduler__'
const validate = path => {
  assert(typeof path === 'string' && path.startsWith(root + '/') && !path.split('/').includes('..'), 'Non-memory output refused')
  return path
}
const calls = { frames: 0, starts: 0, finishes: 0, aborts: 0, correctColorFrames: 0 }
let cancelAfterFrame = null, failAfterFrame = null, controller = null
let frameColors = null
window.electronAPI = {
  pathJoin: async (...parts) => validate(parts.join('/')),
  createDirectory: async path => { validate(path); return { success: true } },
  deleteDirectory: async path => { validate(path); return { success: true } },
  startFramePipe: async ({ outputPath }) => {
    validate(outputPath); calls.starts++; calls.frames = 0; calls.correctColorFrames = 0
    return { success: true, sessionId: 'memory', encoderUsed: 'memory-test-sink' }
  },
  writeFrameToPipe: async (session, buffer) => {
    assert(session === 'memory', 'Unknown frame pipe'); calls.frames++
    const pixels = new Uint8Array(buffer)
    frameColors?.push(Array.from(pixels.slice(0, 4)))
    assert(pixels.length === 160 * 90 * 4, 'Wrong raw frame size')
    if ([220, 80, 100, 255].every((value, index) => Math.abs(pixels[index] - value) <= 1)) calls.correctColorFrames++
    if (calls.frames === cancelAfterFrame) setTimeout(() => controller.abort(), 0)
    if (calls.frames === failAfterFrame) return { success: false, error: 'Synthetic pipe failure' }
    return { success: true }
  },
  finishFramePipe: async () => { calls.finishes++; return { success: true, encoderUsed: 'memory-test-sink' } },
  abortFramePipe: async () => { calls.aborts++; return { success: true } },
}

async function main() {
  assert(window.exportSchedulerFixture.sandboxed, 'Renderer is not sandboxed')
  const source = document.createElement('canvas'); source.width = 160; source.height = 90
  source.getContext('2d').fillStyle = '#dc5064'; source.getContext('2d').fillRect(0, 0, 160, 90)
  const url = source.toDataURL('image/png')
  const clip = { id: 'synthetic', type: 'image', assetId: 'image', trackId: 'picture', url,
    startTime: 0, duration: 4, trimStart: 0, trimEnd: 4, enabled: true,
    transform: { positionX: 0, positionY: 0, scaleX: 100, scaleY: 100, rotation: 0, opacity: 100 }, effects: [], keyframes: {} }
  useAssetsStore.setState({ assets: [{ id: 'image', type: 'image', url, width: 160, height: 90 }] })
  useProjectStore.setState({ currentProjectHandle: root, currentProject: { settings: { width: 160, height: 90, fps: 24 } } })
  useTimelineStore.setState({ clips: [clip], tracks: [{ id: 'picture', type: 'video', visible: true }], transitions: [], timelineFps: 24 })
  let rafRequests = 0
  // Never invoke callbacks: any accidental offscreen RAF dependency must time
  // out even on platforms that keep repainting never-shown windows.
  window.requestAnimationFrame = () => ++rafRequests
  const options = { width: 160, height: 90, fps: 24, rangeStart: 0, rangeEnd: 4,
    outputPath: root + '/delivery.mp4', includeAudio: false, useCachedRenders: false }
  const started = performance.now()
  const result = await exportTimeline(options, () => {}, { offscreen: true })
  const elapsedMs = performance.now() - started
  assert(calls.frames === 96 && calls.correctColorFrames === 96, 'Real compositor did not deliver 96 correct-color frames')
  assert(result.perf.scheduling === 'offscreen-task-queue', 'Exporter did not opt into worker scheduling')
  assert(rafRequests === 0, 'Export waited for a hidden screen repaint')
  assert(elapsedMs < 15000, 'Synthetic export is display-throttled')

  // A real task boundary must keep timers/cancellation and native IPC alive.
  const scheduler = createExportScheduler({ offscreen: true })
  let pingReply = false, timerFired = false, iterations = 0
  const ping = window.exportSchedulerFixture.ping().then(result => { assert(result.hidden, 'Worker became visible'); pingReply = true })
  setTimeout(() => { timerFired = true }, 10)
  try {
    while ((!pingReply || !timerFired) && iterations < 100000) { await scheduler.yieldTask(); iterations++ }
    await ping
    assert(timerFired && iterations < 100000, 'Task scheduler starved cancellation or native IPC')
  } finally { scheduler.dispose() }

  controller = new AbortController(); cancelAfterFrame = 8
  try {
    await exportTimeline({ ...options, signal: controller.signal }, () => {}, { offscreen: true })
    throw new Error('Cancellation was ignored')
  } catch (error) { assert(error.message === 'Export cancelled', error.message) }
  assert(calls.aborts === 1 && calls.frames < 96, 'Cancellation did not abort the frame pipe promptly')
  cancelAfterFrame = null; failAfterFrame = 5
  try {
    await exportTimeline(options, () => {}, { offscreen: true })
    throw new Error('Pipe failure was ignored')
  } catch (error) { assert(error.message === 'Synthetic pipe failure', error.message) }
  assert(calls.aborts === 2, 'Failure did not release the frame pipe')
  failAfterFrame = null
  await exportTimeline(options, () => {}, { offscreen: true })
  assert(calls.finishes === 2 && calls.frames === 96 && calls.correctColorFrames === 96,
    'A fresh export after failure did not recover')
  assert(rafRequests === 0, 'A terminal/retry path waited for hidden RAF')

  // Exercise normal GPU readback across distinct one-frame shots: validating
  // the actual RGBA bytes catches dropped, repeated, or reordered frames.
  const colorValues = ['#ff0000', '#0000ff', '#00ff00', '#ffffff', '#000000']
  const expectedColors = [[255, 0, 0, 255], [0, 0, 255, 255], [0, 255, 0, 255], [255, 255, 255, 255], [0, 0, 0, 255]]
  const colorAssets = colorValues.map((color, index) => {
    source.getContext('2d').fillStyle = color; source.getContext('2d').fillRect(0, 0, 160, 90)
    return { id: `color-${index}`, type: 'image', url: source.toDataURL('image/png'), width: 160, height: 90 }
  })
  frameColors = []
  let orderedFrameColors
  try {
    useAssetsStore.setState({ assets: colorAssets })
    useTimelineStore.setState({ clips: colorAssets.map((asset, index) => ({ ...clip, id: asset.id, assetId: asset.id,
      url: asset.url, startTime: index / 24, duration: 1 / 24, trimEnd: 1 / 24 })) })
    const ordered = await exportTimeline({ ...options, rangeEnd: 5 / 24 }, () => {}, { offscreen: true })
    assert(calls.frames === 5 && ordered.perf.frames === 5, 'One-frame color shots lost a frame')
    assert(JSON.stringify(frameColors) === JSON.stringify(expectedColors),
      'GPU readback duplicated, skipped, or reordered a frame: ' + JSON.stringify(frameColors))
    orderedFrameColors = frameColors
  } finally {
    frameColors = null
    useAssetsStore.setState({ assets: [{ id: 'image', type: 'image', url, width: 160, height: 90 }] })
    useTimelineStore.setState({ clips: [clip] })
  }

  let nativeEncode = null
  if (window.exportSchedulerFixture.nativeEncode) {
    Object.assign(window.electronAPI, window.exportSchedulerFixture.nativePipe)
    useTimelineStore.setState({ clips: [{ ...clip, duration: 6, trimEnd: 6 }] })
    useProjectStore.setState({ currentProject: { settings: { width: 1280, height: 720, fps: 24 } } })
    const nativeStarted = performance.now()
    const nativeResult = await exportTimeline({ ...options, width: 1280, height: 720, rangeEnd: 6 }, () => {}, { offscreen: true })
    const nativeElapsedMs = performance.now() - nativeStarted
    assert(nativeResult.encoderUsed === 'libx264' && nativeResult.perf.frames === 144, 'Native encode did not finish')
    assert(rafRequests === 0, 'Native export depends on suspended RAF')
    nativeEncode = { renderElapsedMs: Math.round(nativeElapsedMs), renderedFps: Number((144000 / nativeElapsedMs).toFixed(2)),
      rafDeliberatelySuspended: true, perf: nativeResult.perf }
  }
  assert(rafRequests === 0, 'An export path depends on suspended RAF')
  window.exportSchedulerFixture.report({ success: true, sandboxed: true, visibilityState: document.visibilityState,
    elapsedMs: Math.round(elapsedMs), syntheticFrames: 96, rafRequests, rafDeliberatelySuspended: true,
    timerAndIpcResponsive: true, orderedFrameColors,
    cancellationAndFailureRecovered: true, perf: result.perf, nativeEncode })
}
main().catch(error => window.exportSchedulerFixture.report({ success: false, error: error.stack || error.message }))
