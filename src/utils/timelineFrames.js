export const DEFAULT_TIMELINE_FPS = 24

const FRAME_EPSILON = 1e-7

export function getSafeTimelineFps(fps, fallback = DEFAULT_TIMELINE_FPS) {
  const parsed = Number(fps)
  if (Number.isFinite(parsed) && parsed > 0) return parsed

  const fallbackParsed = Number(fallback)
  return Number.isFinite(fallbackParsed) && fallbackParsed > 0
    ? fallbackParsed
    : DEFAULT_TIMELINE_FPS
}

export function getTimecodeFrameRate(fps, fallback = DEFAULT_TIMELINE_FPS) {
  return Math.max(1, Math.round(getSafeTimelineFps(fps, fallback)))
}

export function timeToFrameIndex(time, fps, mode = 'nearest') {
  const safeFps = getSafeTimelineFps(fps)
  const rawFrame = Math.max(0, Number(time) || 0) * safeFps

  if (mode === 'floor') return Math.max(0, Math.floor(rawFrame + FRAME_EPSILON))
  if (mode === 'ceil') return Math.max(0, Math.ceil(rawFrame - FRAME_EPSILON))
  return Math.max(0, Math.round(rawFrame))
}

export function frameIndexToTime(frameIndex, fps) {
  const safeFps = getSafeTimelineFps(fps)
  const frame = Math.max(0, Math.round(Number(frameIndex) || 0))
  return frame / safeFps
}

export function quantizeTimeToFrame(time, fps) {
  return frameIndexToTime(timeToFrameIndex(time, fps, 'nearest'), fps)
}

export function roundDurationToFrame(duration, fps) {
  const safeFps = getSafeTimelineFps(fps)
  const minDuration = 1 / safeFps
  const parsed = Number(duration)
  if (!Number.isFinite(parsed) || parsed <= 0) return minDuration
  return Math.max(minDuration, frameIndexToTime(Math.round(parsed * safeFps), safeFps))
}

export function stepTimeByFrames(time, deltaFrames, fps, options = {}) {
  const safeFps = getSafeTimelineFps(fps)
  const delta = Math.trunc(Number(deltaFrames) || 0)
  const minTime = Number.isFinite(Number(options.min)) ? Number(options.min) : 0
  const maxTime = Number.isFinite(Number(options.max)) ? Number(options.max) : Infinity
  const minFrame = timeToFrameIndex(minTime, safeFps, 'ceil')
  const maxFrame = Number.isFinite(maxTime)
    ? timeToFrameIndex(maxTime, safeFps, 'floor')
    : Infinity

  if (delta === 0) {
    const currentFrame = timeToFrameIndex(time, safeFps, 'nearest')
    return frameIndexToTime(Math.min(maxFrame, Math.max(minFrame, currentFrame)), safeFps)
  }

  const rawFrame = Math.max(0, Number(time) || 0) * safeFps
  const nearestFrame = Math.round(rawFrame)
  const isOnFrame = Math.abs(rawFrame - nearestFrame) < FRAME_EPSILON
  const currentFrame = isOnFrame
    ? nearestFrame
    : (delta > 0 ? Math.floor(rawFrame + FRAME_EPSILON) : Math.ceil(rawFrame - FRAME_EPSILON))
  const targetFrame = Math.min(maxFrame, Math.max(minFrame, currentFrame + delta))
  return frameIndexToTime(targetFrame, safeFps)
}

export function formatTimecode(seconds, fps) {
  const timecodeFps = getTimecodeFrameRate(fps)
  const totalFrames = timeToFrameIndex(seconds, timecodeFps, 'nearest')
  const frames = totalFrames % timecodeFps
  const totalSeconds = Math.floor(totalFrames / timecodeFps)
  const ss = totalSeconds % 60
  const mm = Math.floor(totalSeconds / 60) % 60
  const hh = Math.floor(totalSeconds / 3600)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(frames)}`
}

export function formatSecondsFrames(seconds, fps) {
  const timecodeFps = getTimecodeFrameRate(fps)
  const totalFrames = timeToFrameIndex(seconds, timecodeFps, 'nearest')
  const wholeSeconds = Math.floor(totalFrames / timecodeFps)
  const frames = totalFrames % timecodeFps
  return `${wholeSeconds}:${String(frames).padStart(2, '0')}`
}

export function doSegmentsOverlap(segmentA, segmentB, toleranceSeconds = 0) {
  const aStart = Number(segmentA?.startTime) || 0
  const aDuration = Math.max(0, Number(segmentA?.duration) || 0)
  const bStart = Number(segmentB?.startTime) || 0
  const bDuration = Math.max(0, Number(segmentB?.duration) || 0)
  const tolerance = Math.max(0, Number(toleranceSeconds) || 0)

  const aEnd = aStart + aDuration
  const bEnd = bStart + bDuration

  return aStart <= bEnd + tolerance && bStart <= aEnd + tolerance
}
