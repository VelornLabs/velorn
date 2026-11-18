import test from 'node:test'
import assert from 'node:assert/strict'
import { stageWorkflowInAgent } from './workflowAgentHandoff.mjs'

test('opens a lazy agent once before staging, without sending or changing the entry', async () => {
  const entry = { id: 'tpl-mcp-test', title: 'Test' }, calls = [], handlerRef = { current: null }
  const result = await stageWorkflowInAgent(entry, { handlerRef, isCurrent: () => true,
    reveal: () => { calls.push('reveal'); handlerRef.current = value => { calls.push(value); return { success: true } } } })
  assert.equal(result.success, true)
  assert.deepEqual(calls, ['reveal', entry, 'reveal'])
})
test('a project change while mounting never stages into the new project', async () => {
  let current = true, staged = false
  const handlerRef = { current: null }
  const result = await stageWorkflowInAgent({}, { handlerRef, isCurrent: () => current, reveal: () => {
    current = false; handlerRef.current = () => { staged = true; return { success: true } }
  } })
  assert.equal(result.success, false); assert.equal(staged, false)
})
test('a busy agent error is returned immediately without waiting or changing its view', async () => {
  const error = { success: false, error: 'Already working' }
  const result = await stageWorkflowInAgent({}, { handlerRef: { current: () => error }, isCurrent: () => true,
    reveal: () => { assert.fail('must not reveal a busy turn') } })
  assert.equal(result, error)
})
test('an unavailable lazy panel times out without queuing a deferred send', async () => {
  const result = await stageWorkflowInAgent({}, { handlerRef: { current: null }, isCurrent: () => true,
    reveal: () => {}, timeoutMs: 0 })
  assert.equal(result.success, false)
})
