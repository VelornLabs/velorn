import test from 'node:test'
import assert from 'node:assert/strict'
import { canDismissRun, isRunDismissed, readDismissedRuns, updateDismissedRuns, runTimestamp } from '../src/utils/generationRunVisibility.mjs'
test('only confirmed terminal runs hide; renewed active work always appears', () => {
  const jobs = ['done', 'error', 'cancelled', 'running', 'queued', 'unknown', 'paused'].map(status => ({ id: status, status }))
  const keys = updateDismissedRuns([], jobs)
  assert.equal(keys.length, 3)
  for (const job of jobs) assert.equal(isRunDismissed(job, keys), canDismissRun(job))
  assert.equal(isRunDismissed({ ...jobs[0], status: 'running' }, keys), false)
  assert.equal(updateDismissedRuns(keys, [jobs[0]], false).length, 2)
  assert.equal(isRunDismissed({ ...jobs[0], projectKey: 'other' }, keys), false)
  assert.equal(isRunDismissed({ ...jobs[0], endpoint: 'other' }, keys), false)
})
test('preferences reload safely and corrupt/unavailable storage fails open', () => {
  const keys = updateDismissedRuns([], [{ id: 'test', status: 'error' }])
  assert.deepEqual(readDismissedRuns({ getItem: () => JSON.stringify(keys) }), keys)
  for (const value of ['oops', '{}', 'null']) assert.deepEqual(readDismissedRuns({ getItem: () => value }), [])
  assert.deepEqual(readDismissedRuns({ getItem: () => { throw Error('blocked') } }), [])
})
test('timestamps use actual start/create time, handle old years and omit invalid dates', () => {
  const now = new Date(2026, 8, 29, 15, 0)
  const result = runTimestamp({ startedAt: now.getTime(), createdAt: 1 }, now, 'en-US')
  assert.match(result.label, /Today, 3:00 PM/)
  assert.match(result.title, /^Started:/)
  assert.match(runTimestamp({ createdAt: new Date(2025, 0, 3).getTime() }, now, 'en-US').label, /2025/)
  assert.equal(runTimestamp({ createdAt: 'bad' }), null)
  assert.equal(runTimestamp({}), null)
})
