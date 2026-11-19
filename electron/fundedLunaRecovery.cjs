'use strict'

// Native-only evidence. An IPC/model error string or a cloned Error cannot
// authorize a retry. Only the fixed-origin transport brands a complete,
// explicit relay refusal known to precede reservation/provider dispatch.
const refusals = new WeakMap()
const { checkAbort, abortable } = require('./connectedAgentMcpGateway.cjs')
const MIN_WAIT_MS = 1000, MAX_WAIT_MS = 60000

function retryAfterMilliseconds(value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 80) return undefined
  let milliseconds
  if (/^\d{1,10}$/.test(value)) milliseconds = Number(value) * 1000
  else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) milliseconds = Date.parse(value) - now
  if (!Number.isFinite(milliseconds)) return undefined
  return Math.max(MIN_WAIT_MS, Math.min(MAX_WAIT_MS, Math.ceil(milliseconds)))
}

function markPreDispatchRefusal(error, { reason, requestId, retryAfter } = {}) {
  if (!(error instanceof Error) || !['busy', 'rate_limited'].includes(reason)
    || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(requestId)) return error
  refusals.set(error, Object.freeze({ reason, requestId, retryAfterMs: retryAfterMilliseconds(retryAfter) }))
  return error
}

function getPreDispatchRefusal(error, requestId) {
  const refusal = error && typeof error === 'object' ? refusals.get(error) : undefined
  return refusal && refusal.requestId === requestId ? refusal : undefined
}

function consumePreDispatchRefusal(error, requestId) {
  const refusal = getPreDispatchRefusal(error, requestId)
  // One refusal authorizes one retry, never reuse of a stale transport error.
  if (error && typeof error === 'object') refusals.delete(error)
  return refusal
}

function sleep(milliseconds, signal) {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); error ? reject(error) : resolve() }
    const cancel = () => { try { checkAbort(signal) } catch (error) { finish(error) } }
    const timer = setTimeout(finish, milliseconds)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
  })
}

async function waitForPreDispatchRetry(refusal, { signal, assertCurrent, onEvent = () => {}, onWaiting = () => {},
  attempt = 1, timing = {} } = {}) {
  const now = timing.now || (() => performance.now()), pause = timing.sleep || sleep
  const current = () => abortable(Promise.resolve().then(() => { checkAbort(signal); return assertCurrent() }), signal)
  const milliseconds = refusal.retryAfterMs ?? (refusal.reason === 'rate_limited' ? 60000 : Math.min(10000, Math.max(1, attempt) * 2000))
  const end = now() + milliseconds
  onWaiting(true)
  try {
    for (;;) {
      checkAbort(signal); await current(); checkAbort(signal)
      const remaining = Math.max(0, end - now())
      if (!remaining) break
      const seconds = Math.ceil(remaining / 1000)
      onEvent({ type: 'status', waitingFor: 'velo-service', retryAfterMs: milliseconds, remainingSeconds: seconds,
        text: `${refusal.reason === 'rate_limited' ? 'Velo is waiting for its request limit to reset.' : 'Velo is busy.'} Continuing in ${seconds}s… Stop to cancel.` })
      await abortable(pause(Math.min(1000, remaining), signal), signal)
      checkAbort(signal); await current(); checkAbort(signal)
    }
  } finally { onWaiting(false) }
}

module.exports = { markPreDispatchRefusal, getPreDispatchRefusal, consumePreDispatchRefusal, retryAfterMilliseconds, waitForPreDispatchRetry }
