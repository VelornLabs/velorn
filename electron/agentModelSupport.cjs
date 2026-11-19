'use strict'

// Desktop-owned, reviewed configuration data, never model-supplied authority.
// Phones consume the desktop's support label; capability/approval checks do
// not depend on this advisory registry or require a phone application release.
const MODEL_SUPPORT_REGISTRY = require('./agentModelSupportRegistry.json')
const QUALIFICATION_SUITE = 'velorn-local-agent-ten-prompts'
const REAL_ACCEPTANCE_CHECKS = Object.freeze(['real_edit', 'undo', 'export', 'phone_review', 'gpu_handoff'])
const EXACT_CONFIG_KEYS = Object.freeze(['modelId', 'modelRevision', 'runtimeVersion', 'runtimeBackend', 'quantization', 'contextLength', 'reasoning', 'sampling', 'platform', 'integrationVersion'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024
const unobserved = value => typeof value === 'string' && /^(?:unknown|unavailable|unobserved|unverified|unspecified|unset|default|defaults|model[-_ ]defaults?|runtime[-_ ]defaults?|server[-_ ]defaults?|n\/?a|not[-_ ](?:known|observed|available|verified))$/i.test(value.trim())
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function exactConfiguration(config) {
  if (!object(config) || !EXACT_CONFIG_KEYS.filter(key => !['contextLength', 'sampling'].includes(key)).every(key => nonempty(config[key]) && !unobserved(config[key]))
    || !Number.isSafeInteger(config.contextLength) || config.contextLength < 1 || config.contextLength > 1048576
    || !object(config.sampling) || !Object.keys(config.sampling).length) return null
  // A model-default label is not an observed configuration. Recommendations
  // require the actual reviewed runtime values, not guesses from a model name.
  if (Object.values(config.sampling).some(value => !(typeof value === 'boolean' || typeof value === 'string' && nonempty(value) && !unobserved(value)
    || typeof value === 'number' && Number.isFinite(value)))) return null
  return Object.fromEntries(EXACT_CONFIG_KEYS.map(key => [key, config[key]]))
}
function sameConfiguration(a, b) {
  const left = exactConfiguration(a), right = exactConfiguration(b)
  return Boolean(left && right && stable(left) === stable(right))
}
function cleanSuitePassed(report) {
  return Boolean(object(report) && report.kind === QUALIFICATION_SUITE && report.runKind === 'clean-suite'
    && report.syntheticProject === true && report.rerunOf == null && (report.rerunRound == null || report.rerunRound === 0)
    && nonempty(report.finishedAt) && Number.isSafeInteger(report.fixtureVersion) && report.fixtureVersion >= 3
    && Array.isArray(report.cases) && report.cases.length === 10 && report.cases.every(object)
    && new Set(report.cases.map(item => item.id)).size === 10
    && report.cases.every(item => Number.isInteger(item.id) && item.id >= 1 && item.id <= 10 && item.verdict === 'pass'
      && item.fixtureUnchanged === true && Array.isArray(item.assertions) && item.assertions.length > 0
      && item.assertions.every(check => object(check) && check.pass === true)))
}
function qualificationEvidenceValid(profile) {
  if (!object(profile) || !exactConfiguration(profile.configuration)) return false
  const evidence = profile.evidence, clean = evidence?.cleanSuites, real = evidence?.realAcceptance
  if (!object(evidence) || evidence.reviewed !== true || !nonempty(evidence.reviewedAt)
    || !Array.isArray(clean) || clean.length < 2 || clean.length > 20 || !clean.every(object)
    || new Set(clean.map(item => item.reportId)).size !== clean.length
    || !clean.every(item => nonempty(item.reportId) && nonempty(item.artifact) && cleanSuitePassed(item)
      && sameConfiguration(item.configuration, profile.configuration))) return false
  if (!object(real) || !nonempty(real.artifact) || !nonempty(real.platform) || !nonempty(real.completedAt)
    || !sameConfiguration(real.configuration, profile.configuration)
    || !REAL_ACCEPTANCE_CHECKS.every(key => real.checks?.[key] === 'pass')) return false
  return true
}
function getLocalModelSupport(config = {}, registry = MODEL_SUPPORT_REGISTRY) {
  const fallback = { status: 'experimental', label: 'Experimental',
    summary: 'Connected does not mean verified for editing. This exact local model setup has not completed Velorn qualification.', tier: null, profileId: null }
  if (!object(registry) || registry.schemaVersion !== 1 || !Array.isArray(registry.localProfiles)) return fallback
  const profiles = registry.localProfiles.filter(profile => object(profile) && nonempty(profile.id) && sameConfiguration(profile.configuration, config))
  // Conflicting reviewed records must not produce an arbitrary recommendation.
  if (profiles.length !== 1) return fallback
  const profile = profiles[0], tier = ['small', 'medium', 'large'].includes(profile.tier) ? profile.tier : null
  if (profile.status === 'unavailable') return { status: 'unavailable', label: 'Unavailable',
    summary: 'This exact setup is not currently available for Velorn qualification. Choose another model or configuration.', tier, profileId: profile.id }
  if (profile.status === 'recommended' && qualificationEvidenceValid(profile)) return { status: 'recommended', label: 'Recommended',
    summary: 'This exact setup passed repeated clean tool tests and reviewed editing, undo, export, phone review and GPU-handoff acceptance.', tier, profileId: profile.id }
  return { ...fallback, tier, profileId: profile.id }
}

module.exports = { MODEL_SUPPORT_REGISTRY, QUALIFICATION_SUITE, REAL_ACCEPTANCE_CHECKS, EXACT_CONFIG_KEYS,
  exactConfiguration, sameConfiguration, cleanSuitePassed, qualificationEvidenceValid, getLocalModelSupport }
