'use strict'

const ROUTE_RECOMMENDATION_SCHEMA = 'velorn.workflow-route-recommendation/v1'

const EVIDENCE_ORDER = Object.freeze({
  DISCOVERABLE: 0,
  INSTALLED: 1,
  EXECUTABLE: 2,
  TECHNICALLY_VALIDATED: 3,
  PRODUCT_PROVEN: 4,
})

const EVIDENCE_SCORE = Object.freeze({
  DISCOVERABLE: 0.10,
  INSTALLED: 0.30,
  EXECUTABLE: 0.55,
  TECHNICALLY_VALIDATED: 0.78,
  PRODUCT_PROVEN: 1.00,
})

const ROLE_QUALITY_PRIOR = Object.freeze({
  CHAMPION: 0.90,
  SPECIALIST_CHAMPION: 0.90,
  SOVEREIGN_ALTERNATIVE: 0.72,
  ECONOMIC_ALTERNATIVE: 0.64,
  PREMIUM_ALTERNATIVE: 0.68,
  FRONTIER_CANDIDATE: 0.42,
  FRONTIER_BLOCKED: 0.10,
  UNASSESSED: 0.30,
})

const ROLE_COST_SCORE = Object.freeze({
  CHAMPION: 0.55,
  SPECIALIST_CHAMPION: 0.55,
  SOVEREIGN_ALTERNATIVE: 0.78,
  ECONOMIC_ALTERNATIVE: 1.00,
  PREMIUM_ALTERNATIVE: 0.25,
  FRONTIER_CANDIDATE: 0.45,
  FRONTIER_BLOCKED: 0.10,
  UNASSESSED: 0.40,
})

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function clampPriority(value, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(100, Math.max(0, numeric))
}

function normalizeWeights(preferences = {}) {
  const raw = {
    quality: clampPriority(preferences.qualityPriority, 55),
    cost: clampPriority(preferences.costPriority, 10),
    privacy: clampPriority(preferences.privacyPriority, 10),
    readiness: clampPriority(preferences.readinessPriority, 25),
  }
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0)
  if (total <= 0) return { quality: 0.55, cost: 0.10, privacy: 0.10, readiness: 0.25 }
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value / total]))
}

function effectiveRouteEvidence(template) {
  const declared = String(template?.operational?.routeEvidenceLevel || template?.operational?.evidenceLevel || 'DISCOVERABLE')
  const profiles = Array.isArray(template?.calibrationProfiles) ? template.calibrationProfiles : []
  return profiles.reduce((best, profile) => {
    const level = String(profile?.routeEvidenceLevel || profile?.evidenceLevel || 'DISCOVERABLE')
    return (EVIDENCE_ORDER[level] ?? 0) > (EVIDENCE_ORDER[best] ?? 0) ? level : best
  }, declared)
}

function intentMatchScore(template, intent) {
  const normalizedIntent = normalizeText(intent)
  if (!normalizedIntent) return { score: 1, matchedTokens: [], totalTokens: 0 }
  const tokens = normalizedIntent.split(' ').filter(Boolean)
  const lane = normalizeText(template?.operational?.capabilityLane)
  const haystack = normalizeText([
    lane,
    template?.name,
    template?.title,
    template?.description,
    ...(template?.tags || []),
    ...(template?.models || []),
    template?.operational?.benchmark?.specialty,
  ].filter(Boolean).join(' '))
  const matchedTokens = tokens.filter((token) => haystack.includes(token))
  const ratio = tokens.length > 0 ? matchedTokens.length / tokens.length : 1
  const laneBonus = lane === normalizedIntent ? 0.15 : lane.includes(normalizedIntent) ? 0.08 : 0
  return {
    score: Math.min(1, ratio + laneBonus),
    matchedTokens,
    totalTokens: tokens.length,
  }
}

function privacyScore(template) {
  const sovereignty = normalizeText(template?.operational?.sovereignty)
  if (sovereignty.includes('self hosted') || sovereignty.includes('open source') || sovereignty.includes('user controlled')) return 1
  if (sovereignty.includes('commercial')) return 0.20
  return template?.openSource ? 0.90 : 0.40
}

function costScore(template) {
  const role = String(template?.operational?.portfolioRole || 'UNASSESSED')
  const base = ROLE_COST_SCORE[role] ?? ROLE_COST_SCORE.UNASSESSED
  if (template?.openSource) return Math.min(1, base + 0.08)
  return base
}

function qualityScore(template) {
  const operational = template?.operational || {}
  const role = String(operational.portfolioRole || 'UNASSESSED')
  const rolePrior = ROLE_QUALITY_PRIOR[role] ?? ROLE_QUALITY_PRIOR.UNASSESSED
  const benchmark = Number(operational?.benchmark?.score)
  const modelEvidence = EVIDENCE_SCORE[String(operational.modelEvidenceLevel || operational.evidenceLevel || 'DISCOVERABLE')] ?? 0.10
  if (Number.isFinite(benchmark) && benchmark >= 0) {
    return Math.min(1, Math.max(0, (benchmark / 10) * 0.80 + rolePrior * 0.20))
  }
  return rolePrior * 0.60 + modelEvidence * 0.40
}

function isBlocked(template) {
  const operational = template?.operational || {}
  return String(operational.portfolioRole || '') === 'FRONTIER_BLOCKED'
    || normalizeText(operational.availability).includes('blocked')
}

function routeRecommendation(template, request = {}) {
  const weights = normalizeWeights(request)
  const intent = intentMatchScore(template, request.intent || request.capabilityLane || '')
  const routeEvidenceLevel = effectiveRouteEvidence(template)
  const components = {
    intent: intent.score,
    quality: qualityScore(template),
    cost: costScore(template),
    privacy: privacyScore(template),
    readiness: EVIDENCE_SCORE[routeEvidenceLevel] ?? EVIDENCE_SCORE.DISCOVERABLE,
  }
  const preferenceScore = (
    components.quality * weights.quality
    + components.cost * weights.cost
    + components.privacy * weights.privacy
    + components.readiness * weights.readiness
  )
  const score = Math.round((components.intent * 0.30 + preferenceScore * 0.70) * 10000) / 100
  const sovereignty = String(template?.operational?.sovereignty || (template?.openSource ? 'Open source workflow' : 'Commercial API'))
  const routeIsBlocked = isBlocked(template)
  const requiredLevel = String(request.minimumRouteEvidence || 'DISCOVERABLE')
  const evidenceEligible = (EVIDENCE_ORDER[routeEvidenceLevel] ?? 0) >= (EVIDENCE_ORDER[requiredLevel] ?? 0)
  const sovereigntyEligible = request.requireSovereign !== true || privacyScore(template) >= 0.90
  const eligible = !routeIsBlocked && evidenceEligible && sovereigntyEligible && (intent.totalTokens === 0 || intent.score > 0)

  const explanation = [
    intent.totalTokens > 0
      ? `Intent matched ${intent.matchedTokens.length}/${intent.totalTokens} tokens in lane, title, tags or model metadata.`
      : 'No intent filter was supplied; ranking uses portfolio evidence and preferences.',
    Number.isFinite(Number(template?.operational?.benchmark?.score))
      ? `Quality uses the observed model benchmark ${Number(template.operational.benchmark.score).toFixed(3)}/10; this does not upgrade exact-route evidence.`
      : `Quality uses the ${String(template?.operational?.portfolioRole || 'UNASSESSED')} role and declared evidence as a prior because no numeric benchmark exists.`,
    `Exact-route evidence is ${routeEvidenceLevel}; model evidence is ${String(template?.operational?.modelEvidenceLevel || template?.operational?.evidenceLevel || 'DISCOVERABLE')}.`,
    `Privacy is derived from ${sovereignty}; no prompt or asset is sent by this advisory ranking.`,
    `Cost preference is ordinal from portfolio role ${String(template?.operational?.portfolioRole || 'UNASSESSED')}; actual spend remains unknown until preview/receipt.`,
  ]
  if (routeIsBlocked) explanation.push('Excluded from automatic recommendation because the route is explicitly blocked.')
  if (!evidenceEligible) explanation.push(`Excluded because minimumRouteEvidence=${requiredLevel}.`)
  if (!sovereigntyEligible) explanation.push('Excluded because requireSovereign=true.')

  return {
    schema: ROUTE_RECOMMENDATION_SCHEMA,
    templateName: String(template?.name || ''),
    eligible,
    score,
    components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, Math.round(value * 1000) / 1000])),
    weights: Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, Math.round(value * 1000) / 1000])),
    routeEvidenceLevel,
    modelEvidenceLevel: String(template?.operational?.modelEvidenceLevel || template?.operational?.evidenceLevel || 'DISCOVERABLE'),
    sovereignty,
    blocked: routeIsBlocked,
    explanation,
    governance: {
      advisoryOnly: true,
      requiresKernelAuthorizationForSpend: !template?.openSource,
      requiresReceiptAfterExecution: true,
      mediaBytesThroughKernel: false,
    },
  }
}

function recommendWorkflowRoutes(templates = [], request = {}) {
  const ranked = (Array.isArray(templates) ? templates : [])
    .map((template) => ({ template, recommendation: routeRecommendation(template, request) }))
    .filter((entry) => request.includeIneligible === true || entry.recommendation.eligible)
    .sort((a, b) => {
      if (a.recommendation.eligible !== b.recommendation.eligible) return a.recommendation.eligible ? -1 : 1
      return b.recommendation.score - a.recommendation.score
        || String(a.template?.name || '').localeCompare(String(b.template?.name || ''))
    })
    .map((entry, index) => ({
      ...entry.template,
      routeRecommendation: {
        ...entry.recommendation,
        rank: index + 1,
        selected: index === 0 && entry.recommendation.eligible,
      },
    }))
  return ranked
}

module.exports = Object.freeze({
  ROUTE_RECOMMENDATION_SCHEMA,
  EVIDENCE_ORDER,
  effectiveRouteEvidence,
  routeRecommendation,
  recommendWorkflowRoutes,
})
