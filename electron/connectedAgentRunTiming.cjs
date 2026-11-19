'use strict'

// Public wall-clock diagnostics only; never prompts, arguments or raw outputs.
// Durations overlap and must not be summed to reconstruct total run time.
function createAgentRunTiming({ emit, now = () => performance.now() }) {
  const start = now(), tools = new Map()
  let first = false, ended = false
  const duration = since => Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.round(now() - since)))
  return {
    event(value) {
      if (ended) return value
      if (value.type === 'timing') {
        if (value.phase !== 'setup') return null
        return { type: 'timing', phase: 'setup', durationMs: duration(start),
          ...(['new', 'continued', 'reset'].includes(value.continuity) ? { continuity: value.continuity } : {}) }
      }
      if (!first && (value.type === 'tool' || (['progress', 'delta'].includes(value.type) && value.text?.trim()))) {
        first = true; emit({ type: 'timing', phase: 'first-update', durationMs: duration(start) })
      }
      if (value.type !== 'tool' || typeof value.callId !== 'string') return value
      if (value.status === 'running') {
        if (!tools.has(value.callId) && tools.size < 1024) tools.set(value.callId, { start: now() })
      } else {
        const item = tools.get(value.callId)
        if (item) {
          item.durationMs ??= duration(item.start)
          return { ...value, durationMs: item.durationMs }
        }
      }
      return value
    },
    finish(outcome) {
      if (ended) return
      ended = true
      emit({ type: 'timing', phase: 'total', durationMs: duration(start),
        outcome: ['completed', 'failed', 'cancelled'].includes(outcome) ? outcome : 'failed' })
      tools.clear()
    },
  }
}
module.exports = { createAgentRunTiming }
