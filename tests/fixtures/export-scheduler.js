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
let cancelDuringBackpressure = false
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
    if (cancelDuringBackpressure && calls.frames === 1) {
      return new Promise(resolve => setTimeout(() => {
        controller.abort(); resolve({ success: true })
      }, 100))
    }
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
  controller = new AbortController(); cancelDuringBackpressure = true
  try {
    await exportTimeline({ ...options, signal: controller.signal }, () => {}, { offscreen: true })
    throw new Error('Backpressure cancellation was ignored')
  } catch (error) { assert(error.message === 'Export cancelled', error.message) }
  finally { cancelDuringBackpressure = false }
  assert(calls.frames <= 3, 'An extra frame was submitted after cancellation during pipe backpressure')

  // Exercise normal GPU readback across distinct one-frame shots: validating
  // the actual RGBA bytes catches dropped, repeated, or reordered frames.
  const colorValues = ['#ff0000', '#0000ff', '#00ff00', '#ffffff', '#000000']
  const expectedColors = [[255, 0, 0, 255], [0, 0, 255, 255], [0, 255, 0, 255], [255, 255, 255, 255], [0, 0, 0, 255]]
  const colorAssets = colorValues.map((color, index) => {
    source.getContext('2d').fillStyle = color; source.getContext('2d').fillRect(0, 0, 160, 90)
    return { id: `color-${index}`, type: 'image', url: source.toDataURL('image/png'), width: 160, height: 90 }
  })
  const savedGlWait = WebGL2RenderingContext.prototype.clientWaitSync
  const forceFenceTimeout = function () { return this.TIMEOUT_EXPIRED }
  let orderedFrameColors
  let recovery
  const readbackDrainEdges = []
  let finalDrainCancellationRecovered = false
  let gpuReadbackTested = false
  frameColors = []
  try {
    useAssetsStore.setState({ assets: colorAssets })
    useTimelineStore.setState({ clips: colorAssets.map((asset, index) => ({ ...clip, id: asset.id, assetId: asset.id,
      url: asset.url, startTime: index / 24, duration: 1 / 24, trimEnd: 1 / 24 })) })
    const ordered = await exportTimeline({ ...options, rangeEnd: 5 / 24 }, () => {}, { offscreen: true })
    assert(calls.frames === 5 && ordered.perf.frames === 5, 'One-frame color shots lost a frame')
    assert(JSON.stringify(frameColors) === JSON.stringify(expectedColors),
      'GPU readback duplicated, skipped, or reordered a frame: ' + JSON.stringify(frameColors))
    orderedFrameColors = frameColors

    // The driver can keep timing out even though a blocking PBO read succeeds.
    // Exercise the real exporter queue across fallback, not just the compositor:
    // every one-frame shot must survive in order, including both queued tickets.
    frameColors = []
    WebGL2RenderingContext.prototype.clientWaitSync = forceFenceTimeout
    recovery = await exportTimeline({ ...options, rangeEnd: 5 / 24 }, () => {}, { offscreen: true })
    assert(calls.frames === 5 && recovery.perf.frames === 5, 'Readback recovery lost a frame')
    assert(JSON.stringify(frameColors) === JSON.stringify(expectedColors),
      'Readback recovery duplicated, skipped, or reordered a frame: ' + JSON.stringify(frameColors))
    // Some machines give a never-shown window no graphics at all (seen on GitHub's Apple Silicon
    // runners: "Failed to create context"). The exporter then uses its plain path, which the order
    // checks above already covered, and there is no GPU read-back whose stall could be tested.
    // Only that case is let through: with working graphics a missing read-back still fails below.
    gpuReadbackTested = Boolean(recovery.perf.gpuReadback) || Boolean(document.createElement('canvas').getContext('webgl2'))
    if (gpuReadbackTested) {
    assert(recovery.perf.gpuReadback.fenceWaitFallbacks === 1, 'Stalled GPU fence did not activate one fallback')
    assert(recovery.perf.gpuReadback.syncFrameReads > 0, 'Exporter did not leave the stalled async path')

    // One frame first polls only in the final drain. With two frames the
    // fallback starts on the last render, then the final queued ticket must
    // drain without any later synchronous-render iteration to rescue it.
    const queuedColors = [[255, 0, 0, 255], [0, 0, 255, 255]]
    for (const frameCount of [1, 2]) {
      frameColors = []
      const edge = await exportTimeline({ ...options, rangeEnd: frameCount / 24 }, () => {}, { offscreen: true })
      const stats = edge.perf.gpuReadback
      assert(calls.frames === frameCount && edge.perf.frames === frameCount, `${frameCount}-frame final drain lost a frame`)
      assert(JSON.stringify(frameColors) === JSON.stringify(queuedColors.slice(0, frameCount)),
        `${frameCount}-frame final drain changed queued pixels or order: ${JSON.stringify(frameColors)}`)
      assert(stats.asyncSubmitted === frameCount && stats.asyncResolved === frameCount,
        `${frameCount}-frame final drain did not resolve every queued ticket`)
      assert(stats.fenceWaitFallbacks === 1 && stats.forcedPboReadbacks === frameCount,
        `${frameCount}-frame final drain did not use one bounded fallback`)
      assert(stats.syncFrameReads === 0, 'Final drain reread the current stage instead of the queued PBO')
      readbackDrainEdges.push({ frames: frameCount, stats })
    }

    // Abort from an actual timer while the single final ticket is polling:
    // there is no subsequent loop iteration to notice this cancellation.
    const finalDrainController = new AbortController()
    const abortsBeforeDrain = calls.aborts, finishesBeforeDrain = calls.finishes
    let cancellationScheduled = false
    frameColors = []
    WebGL2RenderingContext.prototype.clientWaitSync = function () {
      if (!cancellationScheduled) {
        cancellationScheduled = true
        setTimeout(() => finalDrainController.abort(), 0)
      }
      return this.TIMEOUT_EXPIRED
    }
    try {
      await exportTimeline({ ...options, rangeEnd: 1 / 24, signal: finalDrainController.signal }, () => {}, { offscreen: true })
      throw new Error('Cancellation during final GPU drain was ignored')
    } catch (error) { assert(error.message === 'Export cancelled', error.message) }
    assert(cancellationScheduled, 'Final-drain cancellation never reached fence polling')
    assert(calls.frames === 0 && frameColors.length === 0, 'Cancelled final ticket was sent to the pipe')
    assert(calls.aborts === abortsBeforeDrain + 1 && calls.finishes === finishesBeforeDrain,
      'Final-drain cancellation did not abort exactly once without finalizing')

    WebGL2RenderingContext.prototype.clientWaitSync = forceFenceTimeout
    frameColors = []
    const retry = await exportTimeline({ ...options, rangeEnd: 1 / 24 }, () => {}, { offscreen: true })
    assert(calls.frames === 1 && JSON.stringify(frameColors) === JSON.stringify(queuedColors.slice(0, 1)),
      'Export after final-drain cancellation did not recover the correct frame')
    assert(retry.perf.gpuReadback.asyncSubmitted === 1 && retry.perf.gpuReadback.forcedPboReadbacks === 1,
      'Final-drain cancellation leaked readback state into the next export')
    assert(calls.finishes === finishesBeforeDrain + 1 && calls.aborts === abortsBeforeDrain + 1,
      'Retry after final-drain cancellation did not finish cleanly')
    finalDrainCancellationRecovered = true
    }
  } finally {
    WebGL2RenderingContext.prototype.clientWaitSync = savedGlWait
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
    readbackRecovery: recovery.perf.gpuReadback, gpuReadbackTested,
    readbackDrainEdges, finalDrainCancellationRecovered,
    cancellationAndFailureRecovered: true, perf: result.perf, nativeEncode })
}
main().catch(error => window.exportSchedulerFixture.report({ success: false, error: error.stack || error.message }))
