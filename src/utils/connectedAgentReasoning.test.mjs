import test from 'node:test'
import assert from 'node:assert/strict'
import { selectedThinkingLevel, thinkingOptions, validThinkingLevel } from './connectedAgentReasoning.mjs'
import { sanitizeConnectedAgentMessages } from './connectedAgentContext.mjs'
const model = (...levels) => ({ supportedReasoningEfforts: levels.map(reasoningEffort => ({ reasoningEffort })) })
test('thinking picker follows each model catalog and starts at Medium where supported', () => {
  const sol = model('low', 'medium', 'high', 'xhigh', 'ultra'), luna = model('low', 'medium')
  assert.deepEqual(thinkingOptions(luna), [{ id: 'low', label: 'Light' }, { id: 'medium', label: 'Medium' }])
  assert.equal(selectedThinkingLevel(undefined, sol), 'medium')
  assert.equal(selectedThinkingLevel('ultra', sol), 'ultra')
  assert.equal(selectedThinkingLevel('ultra', luna), 'medium')
  assert.equal(selectedThinkingLevel('medium', { ...model('low', 'high'), defaultReasoningEffort: 'high' }), 'high')
  assert.equal(selectedThinkingLevel('medium', model('low')), 'low')
})
test('unknown model support does not invent catalog options or silently inherit effort', () => {
  assert.deepEqual(thinkingOptions(undefined), [])
  assert.equal(selectedThinkingLevel(undefined, undefined), 'medium')
  assert.equal(selectedThinkingLevel('low', undefined), 'low')
  assert.equal(validThinkingLevel('__proto__'), false)
  assert.equal(validThinkingLevel({}), false)
  assert.deepEqual(thinkingOptions(model('low', 'low', '__proto__', 'invalid')), [{ id: 'low', label: 'Light' }])
})
test('reply history preserves exact requested effort, not current selection or invented legacy metadata', () => {
  const result = sanitizeConnectedAgentMessages([
    { role: 'assistant', text: 'Old reply' },
    { role: 'assistant', text: 'New reply', requestedModel: 'fixture-model', requestedReasoningEffort: 'low' },
    { role: 'assistant', text: 'Forged', requestedReasoningEffort: 'unexpected' },
    { role: 'user', text: 'Hello', requestedReasoningEffort: 'ultra' },
  ])
  assert.equal(result[0].requestedReasoningEffort, undefined)
  assert.equal(result[1].requestedReasoningEffort, 'low')
  assert.equal(result[2].requestedReasoningEffort, undefined)
  assert.equal(result[3].requestedReasoningEffort, undefined)
})
