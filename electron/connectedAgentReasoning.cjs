'use strict'
const EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
function reasoningEffort(value) {
  if (value === undefined) return 'medium'
  if (!EFFORTS.includes(value)) throw Object.assign(new Error('Choose a valid Codex thinking level.'), { code: 'INVALID_REQUEST' })
  return value
}
function reasoningMetadata(model) {
  const entries = model?.supported_reasoning_levels ?? model?.supportedReasoningEfforts
  const seen = new Set()
  const supportedReasoningEfforts = (Array.isArray(entries) ? entries : []).slice(0, 32).flatMap(entry => {
    const effort = entry?.effort ?? entry?.reasoningEffort
    if (!EFFORTS.includes(effort) || seen.has(effort)) return []
    seen.add(effort)
    return [{ reasoningEffort: effort, description: typeof entry.description === 'string'
      ? entry.description.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 240) : '' }]
  })
  if (!supportedReasoningEfforts.length) return {}
  const defaultReasoningEffort = model.default_reasoning_level ?? model.defaultReasoningEffort
  return { supportedReasoningEfforts, ...(seen.has(defaultReasoningEffort) ? { defaultReasoningEffort } : {}) }
}
module.exports = { EFFORTS, reasoningEffort, reasoningMetadata }
