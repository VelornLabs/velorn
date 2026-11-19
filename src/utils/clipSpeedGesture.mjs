// Save before the first real change, never after the live slider/input update.
export function createClipSpeedGesture(store) {
  let session = null
  return {
    end() { session = null },
    apply(clipId, value, continuous = true) {
      const state = store.getState(), clip = state.clips.find(c => c.id === clipId)
      if (!clip || clip.type === 'image') return false
      const speed = Math.max(0.1, Math.min(8, Number(value) || 1))
      if (Math.abs((Number(clip.speed) || 1) - speed) < 1e-9) { if (!continuous) session = null; return false }
      const same = session && session.clip === clip && session.history === state.history
        && session.historyIndex === state.historyIndex && session.timeline === state.timelineSessionId
      if (!same || !continuous) state.saveToHistory()
      store.getState().updateClipSpeed(clipId, speed, false)
      const next = store.getState()
      session = continuous ? { clip: next.clips.find(c => c.id === clipId), history: next.history,
        historyIndex: next.historyIndex, timeline: next.timelineSessionId } : null
      return true
    },
  }
}
