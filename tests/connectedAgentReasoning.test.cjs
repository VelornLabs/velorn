'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { reasoningEffort, reasoningMetadata } = require('../electron/connectedAgentReasoning.cjs')
const { normalizeCodexModels } = require('../electron/connectedAgentCodex.cjs')
const { validateSend } = require('../electron/connectedAgent.cjs')
const { controlsSnapshot, validateCommand } = require('../electron/mobileCompanionControl.cjs')
test('native reasoning metadata is bounded and excludes private catalog data', () => {
  const [model] = normalizeCodexModels({ models: [{ slug: 'fixture', visibility: 'list',
    default_reasoning_level: 'low', supported_reasoning_levels: [
      { effort: 'low', description: 'Fast\u0000', base_instructions: 'SECRET' }, { effort: 'medium' },
      { effort: 'low' }, { effort: 'made-up' }], base_instructions: 'SECRET' }] })
  assert.equal(model.defaultReasoningEffort, 'low')
  assert.deepEqual(model.supportedReasoningEfforts, [{ reasoningEffort: 'low', description: 'Fast ' }, { reasoningEffort: 'medium', description: '' }])
  assert.doesNotMatch(JSON.stringify(model), /SECRET|base_instructions/)
  assert.deepEqual(reasoningMetadata({}), {})
})
test('native request explicitly defaults to Medium, rejects invalid levels and does not configure LM Studio', () => {
  const payload = { requestId: 'fixture', provider: 'codex', messages: [{ role: 'user', content: 'Hello' }], context: {} }
  assert.equal(validateSend(payload).reasoningEffort, 'medium')
  assert.equal(validateSend({ ...payload, reasoningEffort: 'low' }).reasoningEffort, 'low')
  for (const reasoningEffort of [null, '', {}, 'auto', 'high\nmodel=other']) assert.throws(() => validateSend({ ...payload, reasoningEffort }), { code: 'INVALID_REQUEST' })
  assert.throws(() => validateSend({ ...payload, provider: 'lmstudio', model: 'local-model', reasoningEffort: 'low' }), { code: 'INVALID_REQUEST' })
  assert.equal(reasoningEffort(undefined), 'medium')
})
test('phone receives only supported levels and uses context-bound, idle, provider-specific commands', () => {
  const raw = { protocol: 3, contextId: 'fixture-context', provider: 'codex', reasoningEffort: 'medium',
    reasoningOptions: [{ id: 'low', label: 'Light' }, { id: 'medium', label: 'Medium' }, { id: 'bogus', label: 'SECRET' }] }
  const snapshot = { ...raw, ...controlsSnapshot(raw, (x, n) => String(x || '').slice(0, n)), available: true }
  assert.equal(snapshot.reasoningOptions.length, 2)
  const command = { id: 'command-one', contextId: snapshot.contextId, kind: 'reasoning', effort: 'low' }
  assert.equal(validateCommand(command, snapshot).effort, 'low')
  assert.throws(() => validateCommand({ ...command, effort: 'ultra' }, snapshot), /REASONING_UNAVAILABLE/)
  assert.throws(() => validateCommand(command, { ...snapshot, contextId: 'changed' }), /STALE_CONTEXT/)
  assert.throws(() => validateCommand(command, { ...snapshot, busy: true }), /BUSY/)
  assert.throws(() => validateCommand(command, { ...snapshot, provider: 'lmstudio' }), /REASONING_UNAVAILABLE/)
  assert.throws(() => validateCommand({ ...command, fullAccess: true }, snapshot), /INVALID_COMMAND/)
})
