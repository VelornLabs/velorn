'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAgentDispatchScope, getAgentDispatchReceipt } = require('../electron/connectedAgentDispatch.cjs')

test('tool completion receipts are native-only, exact-response bound and never serializable', async () => {
  const scope = createAgentDispatchScope(), guard = { context: { revision: 1 } }
  const result = await scope.runTool(guard, null, async () => {
    scope.complete(scope.current(), { success: true, agentContext: { context: { revision: 2 } } }, 'switch_timeline')
    return { content: [] }
  })
  assert.equal(getAgentDispatchReceipt(result).completions[0].after.context.revision, 2)
  const receipt = getAgentDispatchReceipt(result); receipt.completions.length = 0
  assert.equal(getAgentDispatchReceipt(result).completions.length, 1)
  assert.equal(getAgentDispatchReceipt(JSON.parse(JSON.stringify(result))), null)
  assert.equal(getAgentDispatchReceipt({ ...result, receipt }), null)
  const controller = new AbortController()
  const cancelled = await scope.runTool(guard, controller.signal, async () => { controller.abort(); return { content: [] } })
  assert.equal(getAgentDispatchReceipt(cancelled), null)
})

test('Full access scope records native completions without requiring context and still honors Stop', async () => {
  const scope = createAgentDispatchScope(), controller = new AbortController()
  await scope.runTool(null, controller.signal, async () => {
    assert.equal(scope.current().trustedFullAccess, true)
    assert.doesNotThrow(() => scope.complete(scope.current(), { success: true }, 'save_project'))
    controller.abort()
    assert.throws(() => scope.current(), { code: 'CANCELLED' })
    return { content: [] }
  }, { trustedFullAccess: true })
})

test('native scope isolates agent calls, advances only from exact response, and blocks canceled follow-up dispatch', async () => {
  const scope = createAgentDispatchScope()
  const controller = new AbortController()
  const guard = { context: { revision: 1 }, selection: {}, playhead: 2 }
  assert.equal(scope.current(), undefined)
  await scope.run(guard, controller.signal, async () => {
    await Promise.resolve()
    const pending = scope.current()
    assert.deepEqual(pending.current, guard)
    scope.complete(pending, { agentContext: { ...guard, context: { revision: 2 } } })
    assert.equal(scope.current().current.context.revision, 2)
    assert.equal(guard.context.revision, 1)
    assert.throws(() => scope.complete(pending, {}), /No fresh/)
    controller.abort()
    assert.throws(() => scope.current(), { code: 'CANCELLED' })
  })
  assert.equal(scope.current(), undefined)
})
