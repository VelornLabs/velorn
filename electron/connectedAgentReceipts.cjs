'use strict'

const { randomUUID } = require('node:crypto')
const { getAgentDispatchReceipt } = require('./connectedAgentDispatch.cjs')

const LIMIT = 40
const MAX_OMITTED = 1_000_000
const OUTCOMES = new Set(['read', 'preview', 'applied', 'no-change', 'returned', 'denied', 'failed', 'unconfirmed'])
const ID = /^agent-receipt-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const NAME = /^[a-z][a-z0-9_]{0,63}$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const stable = value => JSON.stringify(value, (_, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)

// Native IPC, phone publication and saved conversation hydration each apply
// this projection. Never copy tool arguments, project IDs, paths or outputs.
function sanitizeToolReceipts(value) {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.entries)) return undefined
  const entries = [], seen = new Set()
  let omitted = Number.isSafeInteger(value.omitted) && value.omitted >= 0 ? Math.min(MAX_OMITTED, value.omitted) : 0
  // A malformed upstream list cannot make sanitization perform unbounded work.
  const candidates = value.entries.slice(-LIMIT)
  omitted += value.entries.length - candidates.length
  for (const entry of candidates) {
    if (!object(entry) || typeof entry.id !== 'string' || !ID.test(entry.id) || seen.has(entry.id)
      || typeof entry.toolName !== 'string' || !NAME.test(entry.toolName) || typeof entry.outcome !== 'string' || !OUTCOMES.has(entry.outcome)) { omitted++; continue }
    seen.add(entry.id)
    entries.push({ id: entry.id, toolName: entry.toolName, outcome: entry.outcome })
  }
  return entries.length || omitted ? { version: 1, entries, omitted: Math.min(MAX_OMITTED, omitted) } : undefined
}

function createToolReceiptLedger() {
  const allowed = new Set(), entries = [], tokens = new WeakMap()
  let sequence = 0, omitted = 0
  function begin(toolName, outcome = 'unconfirmed') {
    if (!allowed.has(toolName) || !OUTCOMES.has(outcome)) return null
    const token = Object.freeze({}), entry = { id: `agent-receipt-${randomUUID()}`, toolName, outcome, sequence: ++sequence }
    tokens.set(token, entry); entries.push(entry)
    if (entries.length > LIMIT) { entries.shift(); omitted++ }
    return token
  }
  return {
    allow(names) { for (const name of names) if (typeof name === 'string' && NAME.test(name)) allowed.add(name) },
    begin,
    finish(token, outcome) { const entry = token && tokens.get(token); if (entry && OUTCOMES.has(outcome)) entry.outcome = outcome },
    record: (toolName, outcome) => begin(toolName, outcome),
    mark: () => sequence,
    latestSince(mark, toolName) { return entries.findLast(entry => entry.sequence > mark && entry.toolName === toolName)?.outcome },
    snapshot: () => sanitizeToolReceipts({ version: 1, entries, omitted }) || { version: 1, entries: [], omitted: 0 },
  }
}

function detailOf(result) {
  const text = result?.content?.find(block => block?.type === 'text')?.text
  if (typeof text !== 'string') return null
  try { const detail = JSON.parse(text); return object(detail) ? detail : null } catch { return null }
}

// This consumes the exact native result BEFORE boundedResult clones it. A
// model-created JSON field cannot forge the in-process WeakMap dispatch proof.
// Unknown contracts deliberately say "returned", not "applied".
function classifyDispatchOutcome({ toolName, result, readOnly, effectful, before, after,
  contextVerified, failed, confirmedNoStart = false }) {
  if (!contextVerified) return 'unconfirmed'
  if (failed) return effectful && !confirmedNoStart ? 'unconfirmed' : 'failed'
  const detail = detailOf(result), record = object(detail?.result) ? detail.result : detail
  if (detail?.error || record?.error || result?.isError === true || record?.success === false) return effectful ? 'unconfirmed' : 'failed'
  if (detail?.previewOnly === true || record?.previewOnly === true) return 'preview'
  if (readOnly) return 'read'
  if (!effectful || !detail || !record) return 'returned'
  const proof = getAgentDispatchReceipt(result), completion = proof?.completions?.[0]
  if (proof?.completions?.length && (stable(proof.before) !== stable(before)
    || stable(proof.completions.at(-1).after) !== stable(after)
    || proof.completions.some(item => item.success !== true)
    || (proof.completions.length === 1 && completion.action !== toolName))) return 'unconfirmed'
  const exactProof = proof?.completions?.length === 1 && completion.action === toolName && completion.success === true
    && stable(proof.before) === stable(before) && stable(completion.after) === stable(after)
  const successful = detail.success === true && record.success !== false && detail.action === toolName
  if (!exactProof || !successful) return 'returned'
  if (record.changed === false) return 'no-change'
  if (record.changed === true || record.applied === true) return 'applied'
  // Checkpoints do not change the timeline revision. The native checkpoint
  // handler explicitly reports its newly stored record; no ID leaves here.
  if (toolName === 'create_project_checkpoint' && record.action === toolName && record.success === true
    && typeof record.checkpointId === 'string' && /^checkpoint-[a-zA-Z0-9_-]{1,180}$/.test(record.checkpointId)) return 'applied'
  return 'returned'
}

module.exports = { LIMIT, MAX_OMITTED, sanitizeToolReceipts, createToolReceiptLedger, classifyDispatchOutcome }
