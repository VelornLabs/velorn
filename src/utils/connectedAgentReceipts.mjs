// Display/history metadata, never permission, a fresh-state assertion, or
// instructions to replay an action. Native dispatch owns receipt production.
export const RECEIPT_OUTCOME_LABELS = Object.freeze({
  read: 'Inspection returned', preview: 'Preview only', applied: 'Applied',
  'no-change': 'No change', returned: 'Result returned — effect not confirmed',
  denied: 'Not approved', failed: 'Failed', unconfirmed: 'Outcome unconfirmed',
})
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export function sanitizeAgentToolReceipts(value) {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.entries)) return undefined
  const ids = new Set(), entries = []
  let rejected = 0
  for (const entry of value.entries.slice(-40)) {
    if (!object(entry) || typeof entry.id !== 'string' || !/^agent-receipt-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entry.id)
      || ids.has(entry.id) || typeof entry.toolName !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(entry.toolName)
      || typeof entry.outcome !== 'string' || !Object.hasOwn(RECEIPT_OUTCOME_LABELS, entry.outcome)) { rejected++; continue }
    ids.add(entry.id)
    entries.push({ id: entry.id, toolName: entry.toolName, outcome: entry.outcome })
  }
  const omitted = (Number.isSafeInteger(value.omitted) && value.omitted >= 0 ? Math.min(value.omitted, 1000000) : 0)
    + Math.max(0, value.entries.length - 40) + rejected
  return entries.length || omitted ? { version: 1, entries, omitted: Math.min(omitted, 1000000) } : undefined
}
export const receiptOutcomeLabel = value => typeof value === 'string' && Object.hasOwn(RECEIPT_OUTCOME_LABELS, value)
  ? RECEIPT_OUTCOME_LABELS[value] : 'Outcome unconfirmed'
export const agentStatusMessage = message => message?.role === 'assistant'
  && ['failed', 'reply-unavailable'].includes(message.deliveryStatus)

export function missingAgentReplyText(value) {
  const receipts = sanitizeAgentToolReceipts(value)
  const applied = receipts?.entries.filter(entry => entry.outcome === 'applied').length || 0
  const headline = applied
    ? `Velorn recorded ${applied} applied action${applied === 1 ? '' : 's'}, but the agent did not provide a final reply.`
    : 'The agent did not provide a final reply.'
  return `${headline}\n\n${receipts ? 'Recorded tool results are listed below. They do not confirm that the entire request finished.'
    : 'No verified tool receipts are available for this turn.'}\n\nNo tool actions were automatically retried. Inspect the current state before repeating an edit.`
}

const finishes = new Set(['stop', 'length', 'tool_calls', 'function_call', 'content_filter', 'unknown'])
const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null
// Match native response metadata retention, not an execution-round limit.
// Long turns keep their latest diagnostics, including answer-only recovery.
const MAX_LOCAL_DIAGNOSTIC_ENTRIES = 14
export function sanitizeAgentLocalDiagnostics(value) {
  if (!Array.isArray(value)) return undefined
  const seen = new Set()
  const entries = value.slice(-MAX_LOCAL_DIAGNOSTIC_ENTRIES).filter(entry => {
    if (!object(entry) || !Number.isSafeInteger(entry.prediction) || entry.prediction < 1 || seen.has(entry.prediction)) return false
    seen.add(entry.prediction); return true
  }).map(entry => ({
    prediction: entry.prediction, finishReason: finishes.has(entry.finishReason) ? entry.finishReason : 'unknown',
    publicContentChars: count(entry.publicContentChars, 2 * 1024 * 1024), parsedToolCalls: count(entry.parsedToolCalls, 1000000),
    promptTokens: count(entry.promptTokens, 10000000), completionTokens: count(entry.completionTokens, 10000000), answerRecovery: entry.answerRecovery === true,
  }))
  return entries.length ? entries : undefined
}
