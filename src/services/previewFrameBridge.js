/**
 * Live preview frame bridge.
 *
 * CanvasPreviewRenderer registers a capture function while mounted so
 * out-of-band consumers (MCP frame inspection, still capture) can grab TRUE
 * composited frames — the same GPU pipeline playback uses (track mattes,
 * corner pin, speed ramps, GLSL effects, motion blur, adjustment layers) —
 * instead of the simplified offscreen still renderer in
 * utils/captureTimelineFrame.js, which stays as the fallback when the
 * timeline preview isn't mounted (other workspace open, asset preview mode).
 *
 * The capture function signature is:
 *   (timeSeconds, { timeoutMs }) => Promise<HTMLCanvasElement | null>
 * It seeks the playhead and resolves once a frame for that exact time has
 * committed. Callers own playhead restoration.
 */

let liveCaptureFn = null

export function registerLivePreviewCapture(captureFn) {
  liveCaptureFn = typeof captureFn === 'function' ? captureFn : null
}

export function unregisterLivePreviewCapture(captureFn) {
  if (liveCaptureFn === captureFn) liveCaptureFn = null
}

export function getLivePreviewCapture() {
  return liveCaptureFn
}
