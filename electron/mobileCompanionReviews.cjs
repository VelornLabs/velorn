'use strict'
const { randomUUID } = require('node:crypto')

// Native-owned, one-use confirmations. No renderer publication can manufacture
// these prompts or the binding retained by a full-access grant.
function createMobileReviews({ getContext, changed, revoked, timeoutMs = 300000 }) {
  const pending = new Map()
  let revision = 0
  function snapshot() { return [...pending.values()].map(record => record.view) }
  function settle(record, approved, trustLocal = false) {
    if (!pending.delete(record.view.approvalId)) return false
    clearTimeout(record.timer)
    record.signal?.removeEventListener('abort', record.abort)
    record.resolve({ approved, mobileBinding: record.binding, ...(approved && record.view.allowLocalTrust && trustLocal ? { trustLocal: true } : {}) })
    changed()
    return true
  }
  function invalidate(reason) {
    revision++
    for (const record of [...pending.values()]) settle(record, false)
    revoked?.(reason)
  }
  function confirm({ window, title, detail, kind, signal, requiresRiskAcknowledgement = true, allowLocalTrust = false, workflowTitle }) {
    const context = getContext()
    if (!context || context.window !== window) return null
    const version = revision
    const binding = { isCurrent: () => {
      const next = getContext()
      return version === revision && !!next && next.window === context.window && next.frame === context.frame
        && next.contextId === context.contextId && next.scope === context.scope
    } }
    return new Promise(resolve => {
      const record = { resolve, binding, signal, view: {
        approvalId: randomUUID(), reviewToken: randomUUID(), kind, title: String(title).slice(0, 256),
        detail: String(detail).slice(0, 24000), requiresRiskAcknowledgement,
        ...(kind === 'generation-spending' && allowLocalTrust === true ? { allowLocalTrust: true, workflowTitle: String(workflowTitle || 'Saved workflow').slice(0, 160) } : {}),
      } }
      record.abort = () => settle(record, false)
      record.timer = setTimeout(record.abort, timeoutMs); record.timer.unref?.()
      pending.set(record.view.approvalId, record)
      if (signal?.aborted) record.abort()
      else { signal?.addEventListener('abort', record.abort, { once: true }); changed() }
    })
  }
  function decide(input) {
    const record = pending.get(input.approvalId)
    if (!record || record.view.reviewToken !== input.reviewToken || !record.binding.isCurrent()
      || typeof input.approved !== 'boolean' || typeof input.riskAcknowledged !== 'boolean'
      || (input.approved && record.view.requiresRiskAcknowledgement && !input.riskAcknowledged)
      || (Object.hasOwn(input, 'trustLocal') && (typeof input.trustLocal !== 'boolean' || !record.view.allowLocalTrust || !input.approved))) throw Error('APPROVAL_UNAVAILABLE')
    settle(record, input.approved, input.trustLocal === true)
    return { success: true, status: 'completed' }
  }
  return { confirm, decide, snapshot, invalidate }
}
module.exports = { createMobileReviews }
