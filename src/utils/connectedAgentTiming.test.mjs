import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_AGENT_TIMING_MS, connectedAgentDurationMs, updateConnectedAgentTiming, formatConnectedAgentDuration } from './connectedAgentTiming.mjs'

test('public durations accept bounded integers only, including zero', () => {
  for (const value of [0, 1, 1200, MAX_AGENT_TIMING_MS]) assert.equal(connectedAgentDurationMs(value), value)
  for (const value of [-1, 1.1, Infinity, NaN, null, undefined, '1200', true, {}, [], MAX_AGENT_TIMING_MS + 1]) {
    assert.equal(connectedAgentDurationMs(value), undefined)
  }
})

test('timing state allowlists three scalar measurements and fixed public metadata', () => {
  let state = null
  state = updateConnectedAgentTiming(state, { type: 'timing', phase: 'setup', durationMs: 150, continuity: 'continued',
    requestId: '/private/session', reasoning: 'PRIVATE_REASONING', output: 'RAW_RESULT', outcome: 'failed' })
  assert.deepEqual(state, { setup: 150, continuity: 'continued' })
  state = updateConnectedAgentTiming(state, { type: 'timing', phase: 'first-update', durationMs: 950 })
  state = updateConnectedAgentTiming(state, { type: 'timing', phase: 'total', durationMs: 1500, outcome: 'completed' })
  assert.deepEqual(state, { setup: 150, 'first-update': 950, total: 1500, continuity: 'continued', outcome: 'completed' })
  assert.equal(updateConnectedAgentTiming(state, { type: 'timing', phase: 'total', durationMs: 2000, outcome: 'failed' }), state)
})

test('unknown phases, private reasoning and invalid durations cannot create timing state', () => {
  const state = { setup: 0 }
  for (const event of [null, {}, { type: 'reasoning', phase: 'setup', durationMs: 1 },
    { type: 'timing', phase: 'analysis', durationMs: 1 }, { type: 'timing', phase: '__proto__', durationMs: 1 },
    { type: 'timing', phase: 'first-update', durationMs: '2' }, { type: 'timing', phase: 'total', durationMs: -1 }]) {
    assert.equal(updateConnectedAgentTiming(state, event), state)
  }
  assert.deepEqual(updateConnectedAgentTiming(null, { type: 'timing', phase: 'total', durationMs: 0,
    continuity: '/private/provider/session', outcome: 'PRIVATE_REASONING' }), { total: 0 })
})

test('failure, cancellation and a fresh run stay independent without invented phase measurements', () => {
  for (const outcome of ['failed', 'cancelled']) {
    const state = updateConnectedAgentTiming(null, { type: 'timing', phase: 'total', durationMs: 11, outcome })
    assert.deepEqual(state, { total: 11, outcome })
  }
  const previous = updateConnectedAgentTiming(null, { type: 'timing', phase: 'total', durationMs: 1200, outcome: 'completed' })
  assert.deepEqual(updateConnectedAgentTiming(null, { type: 'timing', phase: 'setup', durationMs: 20, continuity: 'new' }), { setup: 20, continuity: 'new' })
  assert.deepEqual(previous, { total: 1200, outcome: 'completed' })
})

test('duration display distinguishes exact milliseconds, seconds and longer elapsed runs', () => {
  for (const [value, expected] of [[0, '0 ms'], [42, '42 ms'], [999, '999 ms'], [1000, '1.0 s'],
    [1540, '1.5 s'], [62500, '1 min 2 s'], [3600000, '1 h 0 min'], [MAX_AGENT_TIMING_MS, '24 h 0 min'], [NaN, '']]) {
    assert.equal(formatConnectedAgentDuration(value), expected)
  }
})
