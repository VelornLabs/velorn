/**
 * ComfyUI event → launcher log bridge.
 *
 * Subscribes to the ComfyUI WebSocket events that the renderer already
 * receives (executing, progress, executed, execution_error, etc.) and
 * forwards human-readable lines to the Electron main process's shared
 * launcher log ring via comfyLauncher:appendLog. The launcher log viewer
 * then shows generation activity — queued prompts, per-node execution,
 * sampler progress, errors, completion — regardless of whether ComfyUI
 * was spawned by Velorn or adopted from an externally launched
 * process (in which case we don't own its stdout and would otherwise see
 * almost nothing in the log viewer).
 *
 * Design notes:
 *   - Only one bridge instance runs per renderer session.
 *   - Progress events are throttled so a 20-step sampler doesn't flood the
 *     ring buffer; we keep the endpoint logs focused on "interesting"
 *     milestones (start, finish, every ~10%, errors).
 *   - If the Electron bridge is unavailable (web preview) we become a
 *     silent no-op.
 */

import comfyui from './comfyui'

const PROGRESS_MIN_FRACTION_DELTA = 0.10 // log roughly every 10%
const PROGRESS_MIN_INTERVAL_MS = 750

let started = false
let detachers = []

function bridge() {
  return typeof window !== 'undefined' ? window.electronAPI?.comfyLauncher : null
}

function shortId(promptId) {
  if (!promptId) return ''
  const s = String(promptId)
  return s.length > 8 ? s.slice(0, 8) : s
}

function sendLine(stream, text) {
  const api = bridge()
  if (!api?.appendLog) return
  try {
    void api.appendLog({ stream, text })
  } catch (_) { /* ignore */ }
}

function formatNode(promptId, nodeId) {
  if (nodeId == null || nodeId === '') return 'node ?'
  const classType = comfyui.getNodeClassType?.(promptId, nodeId)
  return classType ? `${classType} (node ${nodeId})` : `node ${nodeId}`
}

/**
 * Start the bridge. Safe to call multiple times — subsequent calls are
 * no-ops. Returns an unsubscribe function for convenience in tests.
 */
export function startComfyLauncherEventBridge() {
  if (started) return stopComfyLauncherEventBridge
  if (!bridge()) {
    // No Electron host — nothing to forward to.
    return () => {}
  }
  started = true

  // Per-prompt runtime state. Cleared on complete/error/interrupted so
  // repeated runs don't drift.
  const runState = new Map() // promptId -> { startedAt, lastProgress, currentNode }

  const getRun = (promptId) => {
    const key = promptId || '_unknown'
    let entry = runState.get(key)
    if (!entry) {
      entry = { startedAt: Date.now(), lastLoggedFraction: -1, lastLoggedAt: 0, currentNode: null }
      runState.set(key, entry)
    }
    return entry
  }
  const clearRun = (promptId) => {
    const key = promptId || '_unknown'
    const entry = runState.get(key)
    runState.delete(key)
    return entry
  }

  const onExecutionStart = ({ promptId } = {}) => {
    getRun(promptId)
    sendLine('event', `▶ Prompt ${shortId(promptId)} queued — starting execution`)
  }

  const onExecutionCached = ({ promptId, nodes } = {}) => {
    if (!Array.isArray(nodes) || nodes.length === 0) return
    const count = nodes.length
    sendLine('event', `  ${count} cached node${count === 1 ? '' : 's'} reused from previous run`)
  }

  const onExecuting = ({ promptId, node } = {}) => {
    const run = getRun(promptId)
    if (run.currentNode === node) return
    run.currentNode = node
    run.lastLoggedFraction = -1
    sendLine('event', `  ⟳ Executing ${formatNode(promptId, node)}`)
  }

  const onProgress = ({ promptId, value, max } = {}) => {
    const run = getRun(promptId)
    const total = Number(max) || 0
    const current = Number(value) || 0
    if (total <= 0) return
    const fraction = Math.min(1, Math.max(0, current / total))
    const now = Date.now()
    const deltaFraction = fraction - run.lastLoggedFraction
    const enoughTime = now - run.lastLoggedAt >= PROGRESS_MIN_INTERVAL_MS
    // Always log the first and last tick; throttle the middle.
    const isEdge = current === 0 || current >= total
    if (!isEdge && (deltaFraction < PROGRESS_MIN_FRACTION_DELTA || !enoughTime)) return
    run.lastLoggedFraction = fraction
    run.lastLoggedAt = now
    const pct = Math.round(fraction * 100)
    const nodeLabel = run.currentNode != null ? ` — ${formatNode(promptId, run.currentNode)}` : ''
    sendLine('event', `    ${current}/${total} (${pct}%)${nodeLabel}`)
  }

  const onExecuted = ({ promptId, node } = {}) => {
    // Keep these low-noise: only mention nodes that actually produce
    // user-visible media (images / gifs / video). Everything else just
    // clutters the viewer during complex workflows.
    sendLine('event', `    ✓ ${formatNode(promptId, node)} finished`)
  }

  const onComplete = ({ promptId } = {}) => {
    const run = clearRun(promptId)
    const elapsed = run ? (Date.now() - run.startedAt) / 1000 : null
    const elapsedText = elapsed != null ? ` in ${elapsed.toFixed(1)}s` : ''
    sendLine('event', `✓ Prompt ${shortId(promptId)} completed${elapsedText}`)
  }

  const onExecutionError = ({ promptId, nodeId, nodeType, message } = {}) => {
    clearRun(promptId)
    const nodeLabel = nodeType
      ? `${nodeType} (node ${nodeId ?? '?'})`
      : formatNode(promptId, nodeId)
    const text = `✗ Prompt ${shortId(promptId)} failed in ${nodeLabel}: ${message || 'unknown error'}`
    sendLine('event', text)
  }

  const onExecutionInterrupted = ({ promptId, nodeId } = {}) => {
    clearRun(promptId)
    const nodeLabel = nodeId != null ? ` at ${formatNode(promptId, nodeId)}` : ''
    sendLine('event', `■ Prompt ${shortId(promptId)} interrupted${nodeLabel}`)
  }

  comfyui.on('execution_start', onExecutionStart)
  comfyui.on('execution_cached', onExecutionCached)
  comfyui.on('executing', onExecuting)
  comfyui.on('progress', onProgress)
  comfyui.on('executed', onExecuted)
  comfyui.on('complete', onComplete)
  comfyui.on('execution_error', onExecutionError)
  comfyui.on('execution_interrupted', onExecutionInterrupted)

  detachers = [
    () => comfyui.off('execution_start', onExecutionStart),
    () => comfyui.off('execution_cached', onExecutionCached),
    () => comfyui.off('executing', onExecuting),
    () => comfyui.off('progress', onProgress),
    () => comfyui.off('executed', onExecuted),
    () => comfyui.off('complete', onComplete),
    () => comfyui.off('execution_error', onExecutionError),
    () => comfyui.off('execution_interrupted', onExecutionInterrupted),
  ]

  return stopComfyLauncherEventBridge
}

export function stopComfyLauncherEventBridge() {
  if (!started) return
  for (const detach of detachers) {
    try { detach() } catch (_) { /* ignore */ }
  }
  detachers = []
  started = false
}
