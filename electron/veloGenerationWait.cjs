'use strict'
// A dedicated, directly exposed native monitor (not a code-mode cell). Its
// scoped MCP connection works in old chats too, unlike start-only dynamic tools.
const { setTimeout: delay } = require('node:timers/promises')
const tool = Object.freeze({ name: 'wait_for_comfyui_runs', description:
  'Let Velorn monitor existing generation IDs without AI polling. Queue independent clips first, then wait for the batch. Returns compact completion/import receipts or an actionable failure; other jobs keep running. Never queues, regenerates, cancels or edits anything. Stop only ends the wait. For dependencies, wait for prerequisite IDs before planning dependent jobs. Already completed IDs return immediately.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['runIds'], properties: {
    runIds: { type: 'array', minItems: 1, maxItems: 400, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
    returnWhen: { type: 'string', enum: ['all', 'any'], description: 'Default all. Use any only when individual completions unlock dependent work.' },
  } } })
const instructions = '\nGeneration monitoring: after queueing independent generations, call the directly exposed wait_for_comfyui_runs tool once with their actual run IDs. Do not wrap this monitor in functions.exec. If a generation was submitted outside Velorn tracking, first inspect/adopt its existing ComfyUI prompt with track_comfyui_prompt; never submit it again just to obtain a run ID. Do not repeatedly call status/log tools or clock.sleep while jobs are healthy. Velorn tracks progress and imports eligible outputs without model calls. Wait for prerequisite IDs before dependent work. On an error, inspect only the failed job; other jobs continue. Never resubmit completed jobs to recover an import/save error. Return pendingRunIds to the wait tool when useful. Existing completed jobs may be inspected by ID after a restart; do not replay submissions.\n'
const abort = signal => { if (signal?.aborted) throw Object.assign(new Error('Generation monitoring stopped; queued generations were not cancelled.'), { code: 'CANCELLED' }) }
async function cancellableRead(read, signal) {
  abort(signal)
  let listener
  const cancelled = new Promise((_, reject) => {
    listener = () => { try { abort(signal) } catch (error) { reject(error) } }
    signal?.addEventListener('abort', listener, { once: true })
  })
  try { return await Promise.race([Promise.resolve().then(read), cancelled]) }
  finally { signal?.removeEventListener('abort', listener) }
}
function validate(args) {
  if (!args || Array.isArray(args) || Object.keys(args).some(k => !['runIds', 'returnWhen'].includes(k)) ||
      !Array.isArray(args.runIds) || !args.runIds.length || args.runIds.length > 400 ||
      args.runIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 128) ||
      new Set(args.runIds).size !== args.runIds.length || ![undefined, 'all', 'any'].includes(args.returnWhen)) throw new Error('Use unique existing runIds and returnWhen all or any.')
}
async function waitForGenerationRuns(args, { read, signal, onProgress = () => {},
  now = () => performance.now(), sleep = ms => delay(ms, undefined, { signal }), pollMs = 2000, importGraceMs = 15000,
  maxWaitMs = 86340000 } = {}) {
  validate(args)
  if (typeof read !== 'function') throw new Error('Generation monitoring is unavailable.')
  const doneAt = new Map(), began = now()
  let previous = ''
  for (;;) {
    abort(signal)
    const snapshot = await cancellableRead(read, signal)
    abort(signal)
    if (snapshot?.success !== true || !Array.isArray(snapshot.runs)) throw new Error('Generation state could not be verified. Existing jobs were not changed.')
    const byId = new Map(snapshot.runs.map(run => [run.id, run]))
    const runs = args.runIds.map(id => {
      const run = byId.get(id)
      if (!run) return { id, status: 'unknown', attention: 'Run not found in the current project. Inspect; do not resubmit automatically.' }
      const compact = { id, status: run.status, importState: run.importState,
        resultAssetIds: (run.resultAssetIds || []).slice(0, 512), outputCount: run.outputCount ?? run.outputs?.length ?? 0 }
      if (['error', 'cancelled', 'unknown'].includes(run.status)) compact.attention = String(run.error || 'Inspect this job before retrying.').slice(0, 1000)
      else if (run.status === 'done') {
        if (!doneAt.has(id)) doneAt.set(id, now())
        if (['failed', 'partial'].includes(run.importState)) compact.attention = 'Generation finished; import needs attention. Recover existing outputs, do not regenerate.'
        else if (run.importState === 'imported') compact.ready = true
        else if (now() - doneAt.get(id) >= importGraceMs) {
          compact.ready = true
          compact.attention = 'Generation finished; import is not confirmed. Inspect/import existing outputs only; do not regenerate.'
        }
      } else if (!['queued', 'running', 'submitting'].includes(run.status)) compact.attention = 'Unrecognized job status; inspect without resubmitting.'
      return compact
    })
    const pendingRunIds = runs.filter(r => !r.ready && !r.attention).map(r => r.id)
    const completedRunIds = runs.filter(r => r.status === 'done').map(r => r.id)
    const attentionRunIds = runs.filter(r => r.attention).map(r => r.id)
    const imported = runs.filter(r => r.importState === 'imported').length
    const progress = `${imported}/${runs.length} clips imported · ${pendingRunIds.length} pending. Velorn is monitoring; no AI polling.`
    if (progress !== previous) { try { onProgress(progress) } catch {} previous = progress }
    // Return before the transport's one-day deadline. This ends only the wait;
    // even a multi-day render remains tracked and may be waited on again.
    const checkpoint = now() - began >= maxWaitMs
    if (checkpoint || attentionRunIds.length || !pendingRunIds.length || (args.returnWhen === 'any' && runs.some(r => r.ready))) return {
      success: true, reason: checkpoint ? 'monitor_checkpoint' : attentionRunIds.length ? 'attention_needed' : pendingRunIds.length ? 'completion' : 'batch_complete',
      runs, completedRunIds, pendingRunIds, attentionRunIds,
      instructions: 'Existing generations were not changed. Independent pending jobs continue. Resume only necessary next steps; never regenerate completed outputs to repair importing.' }
    await sleep(pollMs)
  }
}
module.exports = { tool, instructions, waitForGenerationRuns }
