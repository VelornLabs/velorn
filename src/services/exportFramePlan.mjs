export function buildExportFramePlan({ rangeStart = 0, rangeEnd = 0, fps = 24 } = {}) {
  const safeStart = Math.max(0, Number(rangeStart) || 0)
  const safeEnd = Math.max(safeStart, Number(rangeEnd) || 0)
  const safeFps = Math.max(0, Number(fps) || 0)
  const frameDuration = safeFps > 0 ? 1 / safeFps : 0
  const halfFrame = frameDuration / 2
  const totalDuration = Math.max(0, safeEnd - safeStart)
  const totalFrames = frameDuration > 0 ? Math.ceil(totalDuration * safeFps) : 0

  const getFrameTime = (frameIndex) => {
    const index = Math.max(0, Math.floor(Number(frameIndex) || 0))
    const targetTime = safeStart + (index * frameDuration) + halfFrame
    const safeRenderEnd = Math.max(safeStart, safeEnd - halfFrame)
    return Math.min(targetTime, safeRenderEnd)
  }

  return {
    rangeStart: safeStart,
    rangeEnd: safeEnd,
    fps: safeFps,
    frameDuration,
    halfFrame,
    totalDuration,
    totalFrames,
    getFrameTime,
  }
}
