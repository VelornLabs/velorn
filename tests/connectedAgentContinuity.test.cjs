'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { prepareContinuity, invalidateContinuity } = require('../electron/connectedAgentContinuity.cjs')

test('continuation consumes its mapping and preserves only a verified completed ID', () => {
  const state = {}, identity = { model: 'fixture', catalog: 'version-one' }
  const first = prepareContinuity(state, identity)
  assert.equal(first.mode, 'new')
  first.commit('thread-one')
  const next = prepareContinuity(state, identity)
  assert.equal(next.mode, 'continued')
  assert.equal(next.threadId, 'thread-one')
  assert.equal(state.record, null)
  next.commit('../not-an-id')
  assert.equal(state.record, null)
  next.commit('thread-one')
  const changed = prepareContinuity(state, { ...identity, catalog: 'changed-schema-same-tool-names' })
  assert.equal(changed.mode, 'reset')
  assert.equal(changed.threadId, null)
})

test('revocation and newer requests prevent late completions from restoring history', () => {
  const state = {}
  const old = prepareContinuity(state, { model: 'fixture' })
  invalidateContinuity(state)
  old.commit('stale-thread')
  assert.equal(state.record, null)
  const current = prepareContinuity(state, { model: 'fixture' })
  current.commit('current-thread')
  old.commit('stale-thread')
  old.discard()
  assert.equal(state.record.threadId, 'current-thread')
  invalidateContinuity(state)
  assert.equal(state.record, null)
  assert.equal(prepareContinuity(undefined, {}), null)
})
