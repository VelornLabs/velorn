'use strict'

const LOCAL_CONTEXT_BYTES = 160 * 1024
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function contextBytes(body) {
  let images = 0
  const text = JSON.stringify(body, (key, value) => {
    if (key === 'image_url' && object(value)) { images++; return { url: '[attached image]' } }
    return value
  })
  return Buffer.byteLength(text) + images * 8000
}

// Deliberately narrow: these are data-only native inspections, not previews,
// export/generation status receipts, or tools whose names merely sound readable.
const ARCHIVABLE_INSPECTIONS = new Set(['get_project', 'get_timeline', 'get_assets'])
const protectedOutcome = detail => object(detail) && (detail.isError === true || detail.success === false
  || Boolean(detail.error) || detail.previewOnly === true || detail.result?.success === false || Boolean(detail.result?.error)
  || detail.result?.previewOnly === true)
function isArchivableInspection(name, result, images = []) {
  if (!ARCHIVABLE_INSPECTIONS.has(name) || images.length || !object(result)
    || !Array.isArray(result.content) || protectedOutcome(result) || protectedOutcome(result.structuredContent)) return false
  for (const block of result.content) {
    if (block?.type !== 'text') return false
    let detail
    try { detail = JSON.parse(block.text) } catch { continue }
    if (protectedOutcome(detail)) return false
  }
  return true
}

/** Keeps protocol messages and exact result references, not model summaries.
 * Call only after a complete tool response has been appended. Current user
 * instructions, assistant calls, previews, writes, failures and images are
 * never registered here and therefore cannot be removed for space.
 */
function createLocalContextBudget({ archiveResult, limitBytes = LOCAL_CONTEXT_BYTES } = {}) {
  if (typeof archiveResult !== 'function' || !Number.isSafeInteger(limitBytes)
    || limitBytes < 1 || limitBytes > LOCAL_CONTEXT_BYTES) throw new TypeError('Invalid local context budget.')
  const groups = new Map()
  let latestRead = null
  function observeResult(message, { resultId, readOnly } = {}) {
    if (!readOnly) return
    // A newer inline inspection also supersedes the previous large one.
    latestRead = typeof resultId === 'string' ? resultId : null
    if (!latestRead) return
    groups.set(latestRead, { messages: [message], pending: true })
  }
  function observePage(message, resultId) {
    const group = groups.get(resultId)
    if (!group) return
    group.messages.push(message)
    group.pending = true
    latestRead = resultId
  }
  function fit(payload) {
    let bytes = contextBytes(payload), archivedResults = 0
    for (const [resultId, group] of groups) {
      if (bytes <= limitBytes) break
      if (!group.pending || resultId === latestRead) continue
      // Preparation is read-only: do not reset delivery bookkeeping unless
      // this replacement actually saves space. The store remains authoritative
      // for retention, exact raw data and eligibility for retrieval.
      const reference = archiveResult(resultId, { commit: false })
      if (!reference || typeof reference.content !== 'string') continue
      const saving = group.messages.reduce((sum, message) => sum
        + Buffer.byteLength(JSON.stringify(message.content))
        - Buffer.byteLength(JSON.stringify(reference.content)), 0)
      if (saving <= 0) continue
      const committed = archiveResult(resultId, { commit: true })
      if (!committed || committed.content !== reference.content) continue
      for (const message of group.messages) message.content = reference.content
      // Later retrieval of this ID can register fresh pages. No tool action is
      // rerun, and the original assistant/tool IDs and ordering are untouched.
      group.messages = []
      group.pending = false
      archivedResults++
      bytes = contextBytes(payload)
    }
    return { fits: bytes <= limitBytes, bytes, limitBytes, archivedResults }
  }
  return { observeResult, observePage, fit }
}

module.exports = { LOCAL_CONTEXT_BYTES, contextBytes, isArchivableInspection, createLocalContextBudget }
