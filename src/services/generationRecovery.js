const DEFAULT_INITIAL_BACKOFF_MS = 2_000
const DEFAULT_MAX_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 5 * 60 * 1000

function finiteNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function stableUnitInterval(value = '') {
  let hash = 2166136261
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 0xffffffff
}

export function normalizeGenerationRecoveryPolicy(value, nowMs = Date.now()) {
  if (!value || String(value.mode || '').toLowerCase() !== 'until_terminal') return null
  const deadlineMs = Date.parse(String(value.deadlineAt || ''))
  if (!Number.isFinite(deadlineMs) || deadlineMs <= nowMs) return null
  const initialBackoffMs = Math.max(
    100,
    Math.min(MAX_BACKOFF_MS, Math.round(finiteNumber(value.initialBackoffMs, DEFAULT_INITIAL_BACKOFF_MS)))
  )
  const maxBackoffMs = Math.max(
    initialBackoffMs,
    Math.min(MAX_BACKOFF_MS, Math.round(finiteNumber(value.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS)))
  )
  const workId = String(value.workId || '').trim()
  if (!workId) return null
  return {
    mode: 'until_terminal',
    workId,
    deadlineAt: new Date(deadlineMs).toISOString(),
    initialBackoffMs,
    maxBackoffMs,
  }
}

export function planGenerationRetry(job, nowMs = Date.now()) {
  if (!job || String(job.status || '').toLowerCase() !== 'error') return null
  const policy = normalizeGenerationRecoveryPolicy(job.recoveryPolicy, nowMs)
  if (!policy) return null
  const retryCount = Math.max(0, Math.floor(finiteNumber(job.retryCount, 0))) + 1
  const exponential = Math.min(
    policy.maxBackoffMs,
    policy.initialBackoffMs * (2 ** Math.min(retryCount - 1, 20))
  )
  const jitter = 0.75 + (stableUnitInterval(`${policy.workId}:${retryCount}`) * 0.5)
  const delayMs = Math.max(100, Math.round(exponential * jitter))
  if (nowMs + delayMs >= Date.parse(policy.deadlineAt)) return null
  return {
    retryCount,
    delayMs,
    nextAttemptAt: new Date(nowMs + delayMs).toISOString(),
    policy,
  }
}

export function isGenerationRecoveryPending(job, nowMs = Date.now()) {
  return Boolean(planGenerationRetry(job, nowMs))
}

export function requeueGenerationJob(job, retryPlan) {
  if (!job?.id || !retryPlan) return job
  return {
    ...job,
    status: 'queued',
    progress: 0,
    error: undefined,
    node: undefined,
    promptId: undefined,
    resultAssetIds: undefined,
    restoredFromLedger: undefined,
    isCombiningAngles: undefined,
    combineError: undefined,
    retryCount: retryPlan.retryCount,
    retryOfJobId: job.retryOfJobId || job.id,
    recoveryPolicy: retryPlan.policy,
    recoveryNextAttemptAt: retryPlan.nextAttemptAt,
    recoveryLastError: job.error || null,
  }
}

export default {
  normalizeGenerationRecoveryPolicy,
  planGenerationRetry,
  isGenerationRecoveryPending,
  requeueGenerationJob,
}
