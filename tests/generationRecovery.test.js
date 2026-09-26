import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isGenerationRecoveryPending,
  normalizeGenerationRecoveryPolicy,
  planGenerationRetry,
  requeueGenerationJob,
} from '../src/services/generationRecovery.js'

const NOW = Date.parse('2026-09-14T10:00:00.000Z')

const failedJob = (overrides = {}) => ({
  id: 'job-001',
  workflowId: 'wan22-t2v',
  status: 'error',
  error: 'temporary ComfyUI failure',
  promptId: 'prompt-001',
  resultAssetIds: ['stale-asset'],
  retryCount: 0,
  recoveryPolicy: {
    mode: 'until_terminal',
    workId: 'render-work-001',
    deadlineAt: '2026-09-14T11:00:00.000Z',
    initialBackoffMs: 2_000,
    maxBackoffMs: 30_000,
  },
  ...overrides,
})

test('normalizes a durable until-terminal policy without a retry-count ceiling', () => {
  const policy = normalizeGenerationRecoveryPolicy(failedJob().recoveryPolicy, NOW)
  assert.deepEqual(policy, {
    mode: 'until_terminal',
    workId: 'render-work-001',
    deadlineAt: '2026-09-14T11:00:00.000Z',
    initialBackoffMs: 2_000,
    maxBackoffMs: 30_000,
  })
})

test('plans exponential jittered retries bounded by the work deadline', () => {
  const first = planGenerationRetry(failedJob(), NOW)
  const later = planGenerationRetry(failedJob({ retryCount: 8 }), NOW)
  assert.equal(first.retryCount, 1)
  assert.ok(first.delayMs >= 1_500 && first.delayMs <= 2_500)
  assert.equal(later.retryCount, 9)
  assert.ok(later.delayMs >= 22_500 && later.delayMs <= 37_500)
  assert.equal(planGenerationRetry(failedJob(), Date.parse('2026-09-14T10:59:59.900Z')), null)
})

test('requeues the same job and work identity while clearing attempt-local evidence', () => {
  const plan = planGenerationRetry(failedJob(), NOW)
  const retried = requeueGenerationJob(failedJob(), plan)
  assert.equal(retried.id, 'job-001')
  assert.equal(retried.status, 'queued')
  assert.equal(retried.retryCount, 1)
  assert.equal(retried.retryOfJobId, 'job-001')
  assert.equal(retried.recoveryPolicy.workId, 'render-work-001')
  assert.equal(retried.promptId, undefined)
  assert.equal(retried.resultAssetIds, undefined)
  assert.equal(retried.recoveryLastError, 'temporary ComfyUI failure')
})

test('keeps only failed work with a live recovery policy durable across restarts', () => {
  assert.equal(isGenerationRecoveryPending(failedJob(), NOW), true)
  assert.equal(isGenerationRecoveryPending(failedJob({ status: 'done' }), NOW), false)
  assert.equal(isGenerationRecoveryPending(failedJob({ status: 'cancelled' }), NOW), false)
  assert.equal(isGenerationRecoveryPending(failedJob({ recoveryPolicy: null }), NOW), false)
  assert.equal(
    isGenerationRecoveryPending(
      failedJob({ recoveryPolicy: { ...failedJob().recoveryPolicy, deadlineAt: '2026-09-14T09:59:59.000Z' } }),
      NOW
    ),
    false
  )
})

test('does not retry successful, canceled, malformed, or expired work', () => {
  assert.equal(planGenerationRetry(failedJob({ status: 'done' }), NOW), null)
  assert.equal(planGenerationRetry(failedJob({ status: 'cancelled' }), NOW), null)
  assert.equal(planGenerationRetry(failedJob({ recoveryPolicy: null }), NOW), null)
  assert.equal(
    planGenerationRetry(
      failedJob({ recoveryPolicy: { ...failedJob().recoveryPolicy, deadlineAt: '2026-09-14T09:59:59.000Z' } }),
      NOW
    ),
    null
  )
})
