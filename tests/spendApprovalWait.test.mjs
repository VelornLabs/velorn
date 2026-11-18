import test from 'node:test'
import assert from 'node:assert/strict'
import { APPROVAL_WAIT_LABEL, createSpendApprovalWait } from '../src/services/spendApprovalWait.mjs'

test('the card wording is plain', () => {
  assert.equal(APPROVAL_WAIT_LABEL, 'Waiting for your approval')
})

test('follows the question opening and closing, and tells listeners only on a change', () => {
  let send = null
  const wait = createSpendApprovalWait({ onAsking: (callback) => { send = callback; return () => {} } })
  let calls = 0
  const stop = wait.subscribe(() => { calls += 1 })
  assert.equal(wait.get(), false)
  send(true)
  send(true)
  assert.equal(wait.get(), true)
  assert.equal(calls, 1)
  send(false)
  assert.equal(wait.get(), false)
  assert.equal(calls, 2)
  stop()
  send(true)
  assert.equal(calls, 2)
})

test('stays quiet where the desktop bridge is missing', () => {
  const wait = createSpendApprovalWait(undefined)
  wait.subscribe(() => {})()
  assert.equal(wait.get(), false)
})
