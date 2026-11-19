'use strict'

// Retry ONE pending Responses request only after the authenticated relay proves
// it has not reserved/admitted it. Never retry an ambiguous network/stream
// failure, restart a turn, or re-run tools. No allowance or rate-policy change.
const { setTimeout: sleep } = require('node:timers/promises')
const MAX_REFUSAL_BYTES = 16384
const aborted = signal => { if (signal?.aborted) throw signal.reason || new Error('Request cancelled') }
const notify = (callback, value) => { try { callback(value) } catch {} }

function retryDelay(headers, code, attempt, now) {
  const value = headers.get('retry-after')
  let milliseconds
  if (value && /^\d+(?:\.\d+)?$/.test(value.trim())) milliseconds = Math.ceil(Number(value) * 1000)
  else if (value && /GMT$/.test(value)) milliseconds = Date.parse(value) - now
  if (Number.isSafeInteger(milliseconds) && milliseconds >= 0) return Math.max(250, milliseconds)
  // The existing ledger window is one minute. No new turn/retry-count limit.
  return code === 'rate_limited' ? 60250 : Math.min(30000, 1000 * 2 ** Math.min(attempt - 1, 5))
}

async function readRefusal(response) {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks = []; let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return Buffer.concat(chunks)
      size += value.byteLength
      if (size > MAX_REFUSAL_BYTES) throw new Error('Unverifiable relay refusal; no retry')
      chunks.push(Buffer.from(value))
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
}

async function fetchWithAdmissionWait({ fetchImpl, url, headers, body, signal,
  assertAuthorized = () => {}, onState = () => {}, onAttempt = () => {},
  now = Date.now, wait = (ms, signal) => sleep(ms, undefined, { signal }), tickMs = 1000 }) {
  const pinnedBody = Buffer.from(body), pinnedHeaders = Object.freeze({ ...headers })
  if (typeof pinnedHeaders['Idempotency-Key'] !== 'string' || !pinnedHeaders['Idempotency-Key']) throw new Error('Stable request identity required')
  if (!Number.isSafeInteger(tickMs) || tickMs < 1 || tickMs > 1000) throw new Error('Invalid waiting tick')
  const check = async () => { aborted(signal); await assertAuthorized(); aborted(signal) }
  let attempt = 0
  for (;;) {
    await check(); attempt++
    onAttempt(attempt)
    const response = await fetchImpl(url, { method: 'POST', headers: { ...pinnedHeaders }, body: Buffer.from(pinnedBody), redirect: 'error', signal })
    if (response.status !== 429 || response.redirected
        || response.headers.get('x-velorn-retry-same-id') !== '1'
        || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return response
    const bytes = await readRefusal(response)
    let refusal
    try { refusal = JSON.parse(bytes) } catch {}
    const code = refusal?.error?.code
    if (refusal?.reserved !== false || refusal?.retrySameId !== true || !['busy', 'rate_limited'].includes(code)) {
      return new Response(bytes, { status: response.status, headers: response.headers })
    }
    const retryAt = now() + retryDelay(response.headers, code, attempt, now())
    for (;;) {
      await check()
      const remaining = Math.max(0, retryAt - now())
      if (!remaining) break
      notify(onState, { state: 'waiting', reason: code, retryInMs: remaining })
      await wait(Math.min(tickMs, remaining), signal)
    }
    await check()
    notify(onState, { state: 'resuming', reason: code, retryInMs: 0 })
  }
}

function parseAdmissionProgress(line) {
  const prefix = ': velo-admission '
  if (!line.startsWith(prefix) || line.length > 512) return null
  try {
    const value = JSON.parse(line.slice(prefix.length))
    if (!['waiting', 'resuming'].includes(value.state) || !['busy', 'rate_limited'].includes(value.reason)
        || !Number.isSafeInteger(value.retryInMs) || value.retryInMs < 0) return null
    return { state: value.state, reason: value.reason, retryInMs: value.retryInMs }
  } catch { return null }
}
function admissionStatus(progress) {
  if (progress.state !== 'waiting') return { type: 'status', text: 'Velo is continuing…' }
  return { type: 'status', waitingFor: 'velo-service', text: `Velo is waiting for availability. Continuing in ${Math.ceil(progress.retryInMs / 1000)}s… Stop to cancel.` }
}

module.exports = { fetchWithAdmissionWait, retryDelay, parseAdmissionProgress, admissionStatus }
