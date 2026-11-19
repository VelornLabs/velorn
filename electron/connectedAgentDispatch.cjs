'use strict'

const { AsyncLocalStorage } = require('node:async_hooks')
// Receipts stay inside the native process; tool JSON cannot manufacture one.
const receipts = new WeakMap()
function getAgentDispatchReceipt(result) {
  const receipt = result && receipts.get(result)
  return receipt ? structuredClone(receipt) : null
}

// One guard follows every renderer dispatch made by a tool, including legacy
// handlers and multi-action plans. Public/external MCP calls remain unchanged.
function createAgentDispatchScope() {
  const storage = new AsyncLocalStorage()
  return {
    run(guard, signal, operation) {
      return storage.run({ current: structuredClone(guard), signal }, operation)
    },
    runTool(guard, signal, operation, { trustedFullAccess = false } = {}) {
      const before = structuredClone(guard)
      const scope = { current: structuredClone(before), signal, completions: [], trustedFullAccess }
      return storage.run(scope, async () => {
        const result = await operation()
        if (result && typeof result === 'object' && !signal?.aborted) {
          receipts.set(result, { before, completions: scope.completions })
        }
        return result
      })
    },
    current() {
      const scope = storage.getStore()
      if (scope?.signal?.aborted) throw Object.assign(new Error('Agent action cancelled before dispatch.'), { code: 'CANCELLED' })
      return scope
    },
    complete(scope, response, action) {
      if (!scope) return
      if (!response?.agentContext?.context) {
        if (scope.trustedFullAccess) return
        throw new Error('No fresh agent context was received. Inspect the project before continuing; do not repeat the action.')
      }
      // Advance only from this exact action's response, not a throttled publisher
      // or another client's edit. A subsequent dispatch rechecks in the renderer.
      scope.current = structuredClone(response.agentContext)
      scope.completions?.push({ action, success: response.success === true, after: structuredClone(response.agentContext) })
    },
  }
}

module.exports = { createAgentDispatchScope, getAgentDispatchReceipt }
