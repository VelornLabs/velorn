'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { MODEL_SUPPORT_REGISTRY, getLocalModelSupport, qualificationEvidenceValid, cleanSuitePassed,
  sameConfiguration, REAL_ACCEPTANCE_CHECKS } = require('../electron/agentModelSupport.cjs')

const configuration = { modelId: 'fixture/model', modelRevision: 'sha256:weights-fixture', runtimeVersion: '1.2.3',
  runtimeBackend: 'fixture-engine-1', quantization: 'fixture-q4', contextLength: 32000, reasoning: 'off',
  sampling: { temperature: 0.7, top_p: 0.95, top_k: 20 }, platform: 'fixture-os', integrationVersion: 'fixture-contract-1' }
function clean(reportId) {
  return { reportId, artifact: `review/${reportId}.json`, kind: 'velorn-local-agent-ten-prompts', runKind: 'clean-suite',
    configuration: structuredClone(configuration), fixtureVersion: 3, syntheticProject: true, finishedAt: '2026-10-01T00:00:00Z',
    rerunOf: null, rerunRound: 0,
    cases: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, verdict: 'pass', fixtureUnchanged: true,
      assertions: [{ name: 'fixture_verified', pass: true }] })) }
}
function profile() {
  return { id: 'fixture-profile', tier: 'small', status: 'recommended', configuration: structuredClone(configuration),
    evidence: { reviewed: true, reviewedAt: '2026-10-01T00:00:00Z', cleanSuites: [clean('first'), clean('second')],
      realAcceptance: { artifact: 'review/real-acceptance.json', platform: 'fixture-os', completedAt: '2026-10-01T00:00:00Z',
        configuration: structuredClone(configuration), checks: Object.fromEntries(REAL_ACCEPTANCE_CHECKS.map(key => [key, 'pass'])) } } }
}
const registry = item => ({ schemaVersion: 1, localProfiles: [item] })

test('default registry promotes no local model and separates integrations from size categories', () => {
  assert.deepEqual(MODEL_SUPPORT_REGISTRY.localProfiles, [])
  assert.deepEqual(MODEL_SUPPORT_REGISTRY.localTiers.map(item => item.id), ['small', 'medium', 'large'])
  for (const modelId of ['', 'qwen/qwen3.5-9b', 'unknown/large-model']) {
    assert.equal(getLocalModelSupport({ modelId }).status, 'experimental')
    assert.equal(getLocalModelSupport({ modelId }).tier, null)
  }
  assert.equal(MODEL_SUPPORT_REGISTRY.providers.find(item => item.id === 'codex').qualification, 'separate-integration')
  assert.equal(MODEL_SUPPORT_REGISTRY.providers.find(item => item.id === 'claude').availability, 'planned')
})
test('recommendation matches exact reviewed configuration, not family or model size', () => {
  const supported = getLocalModelSupport(configuration, registry(profile()))
  assert.equal(supported.status, 'recommended')
  assert.equal(supported.tier, 'small')
  assert.equal(supported.profileId, 'fixture-profile')
  for (const field of Object.keys(configuration)) {
    const altered = structuredClone(configuration)
    delete altered[field]
    assert.equal(getLocalModelSupport(altered, registry(profile())).status, 'experimental', `Missing ${field}`)
  }
  for (const change of [{ modelId: 'fixture/model-next' }, { contextLength: 64000 }, { quantization: 'fixture-q8' },
    { runtimeVersion: '1.2.4' }, { reasoning: 'on' }, { sampling: { temperature: 0.2 } }, { platform: 'other-os' }, { integrationVersion: 'fixture-contract-2' }]) {
    assert.equal(getLocalModelSupport({ ...configuration, ...change }, registry(profile())).status, 'experimental')
  }
  assert.equal(sameConfiguration(configuration, { ...configuration, sampling: { top_k: 20, temperature: 0.7, top_p: 0.95 } }), true)
})
test('only clean complete suites count and retries cannot be aggregated', () => {
  assert.equal(cleanSuitePassed(clean('valid')), true)
  for (const mutate of [
    report => { report.runKind = 'diagnostic-retry' },
    report => { report.rerunOf = '/tmp/prior.json' },
    report => { report.rerunRound = 1 },
    report => { report.cases.pop() },
    report => { report.cases[9].id = 1 },
    report => { report.cases[2].verdict = 'fail' },
    report => { report.cases[2].fixtureUnchanged = false },
    report => { report.cases[2].assertions[0].pass = false },
    report => { report.finishedAt = '' },
    report => { report.fixtureVersion = 2 },
  ]) {
    const report = clean('invalid'); mutate(report)
    assert.equal(cleanSuitePassed(report), false)
    const item = profile(); item.evidence.cleanSuites[0] = report
    assert.equal(getLocalModelSupport(configuration, registry(item)).status, 'experimental')
  }
})
test('passing synthetic tests cannot replace reviewed real acceptance or repeat evidence', () => {
  for (const mutate of [
    item => { item.evidence.cleanSuites.pop() },
    item => { item.evidence.cleanSuites[1].reportId = 'first' },
    item => { item.evidence.reviewed = false },
    item => { item.evidence.realAcceptance.checks.export = 'pending' },
    item => { item.evidence.realAcceptance.checks.phone_review = 'fail' },
    item => { delete item.evidence.realAcceptance },
    item => { item.evidence.cleanSuites[1].configuration.reasoning = 'on' },
    item => { item.evidence.realAcceptance.configuration.contextLength = 16000 },
  ]) {
    const item = profile(); mutate(item)
    assert.equal(qualificationEvidenceValid(item), false)
    assert.equal(getLocalModelSupport(configuration, registry(item)).status, 'experimental')
  }
})
test('unknown or model-default sentinels are not exact observed configuration', () => {
  for (const change of [{ modelRevision: 'unknown' }, { runtimeVersion: 'unavailable' }, { quantization: 'unverified' },
    { reasoning: 'model-default' }, { runtimeBackend: 'not_observed' }, { sampling: { mode: 'runtime default' } },
    { sampling: { temperature: NaN } }, { sampling: {} }]) {
    const config = { ...configuration, ...change }, item = profile()
    item.configuration = config
    assert.equal(sameConfiguration(config, config), false)
    assert.equal(getLocalModelSupport(config, registry(item)).status, 'experimental')
  }
})
test('malformed and conflicting metadata fail to experimental; reviewed unavailable stays exact', () => {
  for (const value of [null, {}, { schemaVersion: 2, localProfiles: [profile()] }, registry({}),
    { schemaVersion: 1, localProfiles: [profile(), profile()] }]) {
    assert.equal(getLocalModelSupport(configuration, value).status, 'experimental')
  }
  const item = profile(); item.status = 'unavailable'
  assert.equal(getLocalModelSupport(configuration, registry(item)).status, 'unavailable')
  assert.equal(getLocalModelSupport({ modelId: configuration.modelId }, registry(item)).status, 'experimental')
})
test('malformed nested report and review records fail closed without throwing', () => {
  for (const mutate of [
    report => { report.cases = Array(10).fill(null) },
    report => { report.cases[0] = null },
    report => { report.cases[0].assertions = [null] },
    report => { report.cases[0].assertions = [{ pass: true }, false] },
  ]) {
    const report = clean('invalid'); mutate(report)
    assert.equal(cleanSuitePassed(report), false)
  }
  for (const mutate of [
    item => { item.evidence.cleanSuites = [null, null] },
    item => { item.evidence.cleanSuites[0] = false },
    item => { item.evidence.cleanSuites[0].cases = Array(10).fill(null) },
    item => { item.evidence.realAcceptance = null },
    item => { item.evidence.realAcceptance.checks = null },
  ]) {
    const item = profile(); mutate(item)
    assert.equal(qualificationEvidenceValid(item), false)
    assert.equal(getLocalModelSupport(configuration, registry(item)).status, 'experimental')
  }
})
