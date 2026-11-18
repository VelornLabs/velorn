// Public, request-local diagnostics only. Never retain event payloads, provider
// identifiers, prompts, hidden reasoning or raw tool results in this state.
export const MAX_AGENT_TIMING_MS = 24 * 60 * 60 * 1000
const phases = ['setup', 'first-update', 'total']
const outcomes = ['completed', 'failed', 'cancelled']
const continuities = ['new', 'continued', 'reset']

export function connectedAgentDurationMs(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_AGENT_TIMING_MS ? value : undefined
}

export function updateConnectedAgentTiming(previous, event) {
  const durationMs = connectedAgentDurationMs(event?.durationMs)
  if (event?.type !== 'timing' || !phases.includes(event.phase) || durationMs === undefined
    || previous?.[event.phase] !== undefined) return previous
  return { ...previous, [event.phase]: durationMs,
    ...(continuities.includes(event.continuity) ? { continuity: event.continuity } : {}),
    ...(event.phase === 'total' && outcomes.includes(event.outcome) ? { outcome: event.outcome } : {}) }
}

export function formatConnectedAgentDuration(value) {
  const durationMs = connectedAgentDurationMs(value)
  if (durationMs === undefined) return ''
  if (durationMs < 1000) return `${durationMs} ms`
  if (durationMs < 60000) return `${(durationMs / 1000).toFixed(1)} s`
  const seconds = Math.floor(durationMs / 1000)
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`
  return `${Math.floor(seconds / 3600)} h ${Math.floor(seconds % 3600 / 60)} min`
}
