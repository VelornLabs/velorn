export const THINKING_LABELS = Object.freeze({ none: 'None', minimal: 'Minimal', low: 'Light', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' })
export const validThinkingLevel = value => typeof value === 'string' && Object.hasOwn(THINKING_LABELS, value)
export function thinkingOptions(model) {
  const seen = new Set()
  return (Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []).slice(0, 32).flatMap(item => {
    const id = item?.reasoningEffort
    if (!validThinkingLevel(id) || seen.has(id)) return []
    seen.add(id)
    return [{ id, label: THINKING_LABELS[id] }]
  })
}
export function selectedThinkingLevel(preference, model) {
  const options = thinkingOptions(model)
  if (!options.length) return validThinkingLevel(preference) ? preference : 'medium'
  return [preference, 'medium', model.defaultReasoningEffort, options[0].id].find(id => options.some(item => item.id === id))
}
