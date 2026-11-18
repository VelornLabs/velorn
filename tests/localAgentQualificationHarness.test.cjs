'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { main, evaluate, validateRunConfiguration, runtimeEvidence, inspectRuntime, summarizeQualification } = require('../scripts/check-local-agent-ten-prompts.cjs')

test('benchmark requires explicit selected model and product loopback endpoint', () => {
  assert.throws(() => validateRunConfiguration({}), /exact loaded/)
  assert.deepEqual(validateRunConfiguration({ model: 'some/model', endpoint: 'http://localhost:1234/v1/' }),
    { model: 'some/model', endpoint: 'http://127.0.0.1:1234/v1' })
  for (const endpoint of ['http://192.168.0.1:1234/v1', 'https://api.example.test/v1', 'http://127.0.0.1:1234/v1?x=1',
    'http://user:password@localhost:1234/v1', 'http://127.0.0.1:1234/v1/other', 'http://127.0.0.1:5678/v1']) {
    assert.throws(() => validateRunConfiguration({ model: 'some/model', endpoint }), /loopback/)
  }
  assert.throws(() => validateRunConfiguration({ model: 'bad\nmodel' }), /exact loaded/)
})
test('default plan makes no network request and does not silently select a model', async () => {
  const originalFetch = globalThis.fetch, originalLog = console.log, lines = []
  globalThis.fetch = () => { throw Error('Network must remain off') }
  console.log = line => lines.push(line)
  try {
    await main([])
    const plan = JSON.parse(lines[0])
    assert.equal(plan.actualModelRequests, 0)
    assert.equal(plan.model, null)
    assert.equal(plan.cases.length, 10)
    await assert.rejects(main(['--run']), /exact loaded/)
    await assert.rejects(main(['--model', 'first', '--model', 'second']), /Duplicate option/)
  } finally { globalThis.fetch = originalFetch; console.log = originalLog }
})
test('runtime evidence records observed config and leaves unknown details unknown', () => {
  const data = { models: [{ key: 'weights/model', type: 'llm', quantization: { name: 'Q4_K_M' },
    path: '/private/model/path', loaded_instances: [{ id: 'chosen-alias', config: { context_length: 32768, flash_attention: true, secret: 'do-not-report' } }] }] }
  const evidence = runtimeEvidence(data, 'chosen-alias')
  assert.equal(evidence.status, 'observed')
  assert.equal(evidence.modelKey, 'weights/model')
  assert.equal(evidence.instanceId, 'chosen-alias')
  assert.equal(evidence.quantization, 'Q4_K_M')
  assert.deepEqual(evidence.loadedConfiguration, { context_length: 32768, flash_attention: true })
  assert.equal(evidence.runtime.version, null)
  assert.equal(evidence.sampling, null)
  assert.equal(evidence.reasoning, null)
  assert.equal(evidence.modelRevision, null)
  assert.ok(!JSON.stringify(evidence).includes('private'))
  assert.ok(!JSON.stringify(evidence).includes('secret'))
  assert.equal(runtimeEvidence(data, 'missing').status, 'unavailable')
  assert.equal(runtimeEvidence({ models: [...data.models, ...data.models] }, 'chosen-alias').status, 'unavailable')
})
test('native metadata read is bounded read-only and failure does not invent config', async () => {
  const calls = []
  const evidence = await inspectRuntime({ model: 'fixture', endpoint: 'http://127.0.0.1:1234/v1' }, new AbortController().signal,
    async (url, options) => { calls.push({ url, options }); return new Response('{}', { status: 404 }) })
  assert.equal(evidence.status, 'unavailable')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:1234/api/v1/models')
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].options.redirect, 'error')
})
test('diagnostic retry cannot promote a model, even if every selected case passes', () => {
  const verdict = summarizeQualification({ runKind: 'diagnostic-retry', cases: [{ id: 7, verdict: 'pass' }] })
  assert.equal(verdict.recommended, false)
  assert.equal(verdict.cleanSuitePassed, false)
  assert.match(verdict.reason, /cannot be combined/)
})
test('workflow qualification accepts immediate routing but still requires the actual native inspection', () => {
  const fixture = { calls: [{ name: 'list_velorn_workflows', status: 'completed' }], unchanged: () => true, forbiddenActions: [], unsupportedTools: [] }
  const response = { success: true, text: JSON.stringify({ workflows: [{ id: 'saved-local-upscale-x2', name: 'My local upscale x2' }], queued: false }) }
  const requests = [{ advertisedToolNames: ['call_velorn_tool'], toolCalls: [{ name: 'call_velorn_tool' }] }]
  const passed = evaluate({ id: 8 }, fixture, response, requests)
  assert.equal(passed.verdict, 'pass')
  assert.equal(passed.assertions.find(item => item.name === 'workflow_tool_available').pass, true)
  const missingInspection = evaluate({ id: 8 }, { ...fixture, calls: [] }, response, requests)
  assert.equal(missingInspection.verdict, 'fail')
  assert.equal(missingInspection.assertions.find(item => item.name === 'workflow_catalog_was_inspected').pass, false)
})
