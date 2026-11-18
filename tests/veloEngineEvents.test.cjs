'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createEngineEventSink } = require('../electron/veloEngineEvents.cjs')

test('only public messages and native activity enter the desktop stream', () => {
  const events = [], emit = createEngineEventSink(e => events.push(e), { fullAccess: true, secrets: ['private-fixture-capability'] })
  emit({ method: 'item/completed', params: { item: { id: 'r', type: 'reasoning', text: 'private reasoning' } } })
  emit({ method: 'account/login/completed', params: { token: 'private-fixture-capability' } })
  emit({ method: 'item/completed', params: { item: { id: 'm', type: 'mcpToolCall', result: 'already native-owned' } } })
  assert.equal(events.length, 0)
  emit({ method: 'item/completed', params: { item: { id: 'cmd', type: 'commandExecution', command: 'printf ok', aggregatedOutput: 'private-fixture-capability', exitCode: 0 } } })
  assert.equal(events[0].status, 'completed')
  assert.equal(events[0].output.includes('private-fixture-capability'), false)
  emit({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'private-fixture-' } })
  assert.equal(events[1].text, '')
  emit({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'capability\n' } })
  assert.equal(events[2].text, '[private capability]\n')
})

test('chat mode has no shell activity and receives one completed public reply', () => {
  const events = [], emit = createEngineEventSink(e => events.push(e))
  emit({ method: 'item/started', params: { item: { id: 'cmd', type: 'commandExecution' } } })
  emit({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'hello' } })
  assert.equal(events.length, 0)
  emit({ method: 'item/completed', params: { item: { id: 'a', type: 'agentMessage', text: 'hello', phase: 'final_answer' } } })
  assert.deepEqual(events, [{ type: 'delta', text: 'hello' }])
})

test('native context compaction displays progress without inventing a chat reply or exposing opaque state', () => {
  const events = [], emit = createEngineEventSink(e => events.push(e))
  for (const method of ['item/started', 'item/completed']) emit({ method, params: { item: {
    id: 'compact-1', type: 'contextCompaction', encrypted_content: 'synthetic-private-opaque-state', text: 'not an assistant answer' } } })
  assert.deepEqual(events, [
    { type: 'status', text: 'Velo is compacting this chat’s context…' },
    { type: 'status', text: 'Velo is continuing…' },
  ])
})
