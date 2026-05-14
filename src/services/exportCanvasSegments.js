const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

/**
 * Render a contiguous segment of canvas frames using the exact time boundary
 * logic from exporter.js.
 *
 * Strict mode behavior:
 * - Throws when required params are invalid.
 * - Throws when renderFrame is missing.
 * - Throws when any frame render fails.
 */
export const renderCanvasSegment = async ({
  startFrame,
  endFrame,
  totalFrames,
  rangeStart,
  rangeEnd,
  fps,
  renderFrame,
}) => {
  if (!Number.isInteger(startFrame) || startFrame < 0) {
    throw new Error('renderCanvasSegment: startFrame must be an integer >= 0')
  }
  if (!Number.isInteger(endFrame) || endFrame < startFrame) {
    throw new Error('renderCanvasSegment: endFrame must be an integer >= startFrame')
  }
  if (!Number.isInteger(totalFrames) || totalFrames <= 0) {
    throw new Error('renderCanvasSegment: totalFrames must be an integer > 0')
  }
  if (endFrame >= totalFrames) {
    throw new Error('renderCanvasSegment: endFrame is out of bounds for totalFrames')
  }
  if (typeof renderFrame !== 'function') {
    throw new Error('renderCanvasSegment: renderFrame callback is required')
  }
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd < rangeStart) {
    throw new Error('renderCanvasSegment: invalid rangeStart/rangeEnd')
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error('renderCanvasSegment: fps must be > 0')
  }

  const frameDuration = 1 / fps
  const halfFrame = frameDuration / 2
  const safeEnd = Math.max(rangeStart, rangeEnd - halfFrame)

  for (let frameIndex = startFrame; frameIndex <= endFrame; frameIndex++) {
    const targetTime = rangeStart + frameIndex * frameDuration + halfFrame
    const time = clamp(targetTime, rangeStart, safeEnd)

    try {
      await renderFrame({ frameIndex, time, frameDuration, halfFrame, safeEnd })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`renderCanvasSegment: failed at frame ${frameIndex}: ${detail}`)
    }
  }
}

export default renderCanvasSegment
