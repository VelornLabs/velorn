// Store selector: the playhead as panels should follow it.
// Paused it is the exact playhead. While playing it advances once per
// timeline frame (never fewer than 24 steps a second) instead of on every
// animation-frame write, so a subscriber re-renders per frame of video
// rather than per screen refresh.
export const selectFramePlayhead = (state) => {
  if (!state.isPlaying) return state.playheadPosition
  const stepsPerSecond = Math.max(24, Number(state.timelineFps) || 24)
  return Math.floor(state.playheadPosition * stepsPerSecond + 1e-6) / stepsPerSecond
}
