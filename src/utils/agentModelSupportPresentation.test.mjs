import test from 'node:test'
import assert from 'node:assert/strict'
import { localModelSupportPresentation, localModelOptionLabel } from './agentModelSupportPresentation.mjs'

test('connection, missing metadata and a claimed recommendation are not qualification', () => {
  for (const value of [null, undefined, {}, { connected: true }, { status: 'recommended' }, { status: 'recommended', profileId: '<script>' }]) {
    assert.equal(localModelSupportPresentation(value).status, 'experimental')
  }
})
test('native reviewed profile and unavailable states have concise display-only labels', () => {
  assert.equal(localModelSupportPresentation({ status: 'recommended', profileId: 'fixture-reviewed-v1' }).label, 'Recommended setup')
  assert.equal(localModelSupportPresentation({ status: 'unavailable' }).label, 'Setup unavailable')
  assert.equal(localModelOptionLabel({ id: 'local-test' }), 'local-test · Experimental in Velorn')
  assert.equal(localModelOptionLabel({ id: 'local-test', displayName: 'Local Test', support: { status: 'recommended', profileId: 'reviewed' } }), 'Local Test · Recommended setup')
})
test('loaded-instance status and context are separate from compatibility and distinguish aliases', () => {
  assert.equal(localModelOptionLabel({ id: 'small:2', modelKey: 'small', displayName: 'Small', loaded: true, contextLength: 32768 }),
    'Small (small:2) · Loaded · 32,768 context · Experimental in Velorn')
  assert.equal(localModelOptionLabel({ id: 'small', loaded: false }), 'small · Not loaded · Experimental in Velorn')
  assert.equal(localModelOptionLabel({ id: 'unknown' }), 'unknown · Experimental in Velorn')
})
