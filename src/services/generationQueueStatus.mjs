// Inspection only: never import GenerateWorkspace, restore jobs, write storage,
// contact ComfyUI, or dispatch an event. Generate owns execution and publishes
// a detached status projection through the existing monitor store.
const STORAGE_KEY = 'generate-workspace-generation-queue'
const ACTIVE = new Set(['uploading', 'configuring', 'queuing', 'running', 'saving'])
// Generate's long-standing legacy projection treats a merely queued job as
// pending, not active. Registered native runs are different: `submitting` and
// `queued` are confirmed broker-owned work that the app is actively tracking.
// Keep that distinction so the established Generate status contract remains
// stable while the global Runs surface reports real in-flight native work.
const NATIVE_ACTIVE = new Set(['submitting', 'queued'])
const TERMINAL = new Set(['done', 'error', 'cancelled'])
const copy = value => JSON.parse(JSON.stringify(value))

// Kept only in renderer RAM, never returned through MCP. Handle identity also
// works for browser projects without converting it to a device-specific path.
export function generationQueueOwner(handle, project) {
  return { handle: handle ?? null, created: project?.created ?? null,
    id: project?.id ?? null, name: project?.name ?? null }
}

export function projectGenerationQueueJob(job) {
  return copy({
    id: job.id,
    workflowId: job.mcpBatch?.requestedWorkflowId || job.workflowId,
    executionWorkflowId: job.mcpBatch?.requestedWorkflowId ? job.workflowId : undefined,
    workflowLabel: job.workflowLabel,
    status: job.status,
    progress: Number(job.progress) || 0,
    promptId: job.promptId || null,
    promptLabel: job.mcpBatch?.promptLabel || null,
    batchId: job.mcpBatch?.id || null,
    duration: job.apiParameterSemantics ? null : job.duration || null,
    conditioningAudio: job.conditioningAudio || null,
    resolution: job.apiParameterSemantics ? null : job.resolution || null,
    ...(job.apiParameterSemantics ? {
      fps: null,
      requestedMetadata: job.apiParameterSemantics.requestedMetadata,
      apiParameterSemantics: job.apiParameterSemantics,
      warnings: job.apiParameterSemantics.warnings,
    } : {}),
    resultAssetIds: Array.isArray(job.resultAssetIds) ? job.resultAssetIds : [],
    error: job.error || null,
  })
}

function ownerMatches(owner, expectedOwner) {
  return expectedOwner === undefined || (owner
    && Object.keys(expectedOwner).every(key => owner[key] === expectedOwner[key]))
}

function runOwnerMatches(owner, expectedOwner) {
  if (expectedOwner === undefined) return true
  // A native subscription is intentionally app-wide: its individual records
  // carry their captured project identity internally, while its renderer
  // owner only establishes that this app session has a current native bridge.
  // Do not use this escape hatch for ordinary project-scoped publications.
  if (owner?.scope === 'application') return true
  return ownerMatches(owner, expectedOwner)
}

function latestSnapshotTime(snapshot, legacyLive, runsLive) {
  const candidates = []
  if (legacyLive && snapshot.updatedAt != null) candidates.push(snapshot.updatedAt)
  if (runsLive && snapshot.runsUpdatedAt != null) candidates.push(snapshot.runsUpdatedAt)
  if (!candidates.length) return null
  const parse = value => {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const date = typeof value === 'string' ? Date.parse(value) : NaN
    return Number.isFinite(date) ? date : 0
  }
  return candidates.reduce((latest, value) => parse(value) >= parse(latest) ? value : latest)
}

function nativeQueueJob(job = {}) {
  const origin = ['velorn', 'agent', 'external'].includes(String(job.origin || '').toLowerCase())
    ? String(job.origin).toLowerCase()
    : 'external'
  const rawStatus = String(job.status || 'unknown').toLowerCase()
  // `null` is a meaningful native value: ComfyUI has not reported a numeric
  // node progress yet. Do not coerce it to a misleading 0% in an MCP read.
  const progressValue = job.progress
  const progress = progressValue === null || progressValue === undefined || progressValue === ''
    ? null : Number(progressValue)
  const outputs = Array.isArray(job.outputs) ? job.outputs.slice(0, 512).map(item => ({
    filename: String(item?.filename || '').slice(0, 240),
    subfolder: String(item?.subfolder || '').replace(/[\\/]+/g, '/').slice(0, 400),
    type: String(item?.type || 'output').slice(0, 24),
    nodeId: item?.nodeId == null ? null : String(item.nodeId).slice(0, 80),
    mediaType: String(item?.mediaType || '').slice(0, 24),
  })).filter(item => item.filename && !item.filename.includes('/') && !item.filename.includes('\\')
    && !item.subfolder.startsWith('/') && !/^[A-Za-z]:/.test(item.subfolder)
    && !item.subfolder.split('/').some(part => part === '..')) : []
  return {
    id: String(job.id || job.runId || '').slice(0, 180),
    workflowId: job.workflowId ? String(job.workflowId).slice(0, 180) : undefined,
    workflowLabel: job.workflowLabel ? String(job.workflowLabel).slice(0, 180) : undefined,
    status: rawStatus,
    progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null,
    promptId: job.promptId ? String(job.promptId).slice(0, 180) : null,
    resultAssetIds: Array.isArray(job.resultAssetIds) ? job.resultAssetIds.filter(Boolean).slice(0, 512) : [],
    error: job.error ? String(job.error).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 500) : null,
    origin,
    source: job.source || 'native-run',
    projectName: job.projectName ? String(job.projectName).slice(0, 160) : null,
    node: job.node == null ? null : String(job.node).slice(0, 120),
    outputs,
    outputCount: Number.isFinite(Number(job.outputCount ?? job.totalOutputs))
      ? Math.max(outputs.length, Math.min(1_000_000, Math.floor(Number(job.outputCount ?? job.totalOutputs))))
      : outputs.length,
    outputsTruncated: job.outputsTruncated === true || job.outputTruncated === true
      || job.outputDescriptorsTruncated === true || Number(job.outputCount ?? job.totalOutputs) > outputs.length,
    importState: job.importState ? String(job.importState).slice(0, 80) : null,
    recipeAvailable: job.recipeAvailable === true,
    adopted: job.adopted === true,
    unsubmittedAttempt: false,
  }
}

function mergeVerifiedLiveJobs(legacyJobs = [], runJobs = []) {
  if (!runJobs.length) return legacyJobs.map(copy)
  if (!legacyJobs.length) return runJobs.map(nativeQueueJob)
  const result = legacyJobs.map(copy)
  const unmatchedLegacy = new Map()
  for (let index = 0; index < result.length; index++) {
    const promptId = result[index]?.promptId
    if (!promptId) continue
    const indexes = unmatchedLegacy.get(promptId) || []
    indexes.push(index)
    unmatchedLegacy.set(promptId, indexes)
  }
  for (const source of runJobs) {
    const run = nativeQueueJob(source)
    const candidates = run.origin !== 'external' && run.promptId
      ? (unmatchedLegacy.get(run.promptId) || []) : []
    // Legacy Generate had no endpoint. Join only one clearly corresponding
    // registered prompt; external observations remain their own records.
    if (candidates.length === 1) {
      const index = candidates[0]
      const managed = result[index]
      result[index] = {
        ...managed, ...run,
        // Queue callers already received the managed ID. Keep it stable while
        // exposing the broker ID separately for native-run tools and polling.
        id: managed.id || run.id,
        runId: run.id || undefined,
        // Inline registered graphs may not have a workflow ID (or may only
        // have a generic label). Do not erase the managed workflow identity.
        workflowId: managed.workflowId || run.workflowId,
        workflowLabel: managed.workflowLabel || run.workflowLabel,
        resultAssetIds: Array.from(new Set([...(managed.resultAssetIds || []), ...(run.resultAssetIds || [])])),
      }
      unmatchedLegacy.set(run.promptId, [])
    } else {
      result.push(run)
    }
  }
  return result
}

function isActiveLiveJob(job) {
  const status = String(job?.status || '').toLowerCase()
  if (ACTIVE.has(status)) return true
  return NATIVE_ACTIVE.has(status) && job?.source === 'native-run'
}

export function readGenerationQueueStatus(snapshot = {}, payload = {}, storage, expectedOwner) {
  const legacyLive = snapshot.queueStatusAvailable === true && Boolean(ownerMatches(snapshot.queueStatusOwner, expectedOwner))
  const runsLive = snapshot.runsAvailable === true && Boolean(runOwnerMatches(snapshot.runsOwner, expectedOwner))
  const live = legacyLive || runsLive
  const legacyJobs = legacyLive && Array.isArray(snapshot.legacyQueueStatusJobs)
    ? snapshot.legacyQueueStatusJobs.map(projectGenerationQueueJob)
    : legacyLive && Array.isArray(snapshot.queueStatusJobs) ? snapshot.queueStatusJobs : []
  const runJobs = runsLive && Array.isArray(snapshot.runsQueueStatusJobs)
    ? snapshot.runsQueueStatusJobs : []
  let jobs = live ? mergeVerifiedLiveJobs(legacyJobs, runJobs) : []
  let source = live ? 'live' : 'unavailable'
  let note = live
    ? runsLive && legacyLive
      ? 'Current app-wide Velorn managed and registered-run snapshot; no service polling or job execution was triggered by this read.'
      : runsLive
        ? 'Current app-wide Velorn registered-run snapshot; no service polling or job execution was triggered by this read.'
        : 'Current app-wide Velorn queue snapshot, not filtered to the open project; no service polling or job execution was triggered.'
    : 'Generate has not published a current queue snapshot. This does not establish that the ComfyUI queue is empty. Repeating this read will not start or restore Generate.'
  if (!live) {
    try {
      const raw = (storage ?? globalThis.localStorage)?.getItem(STORAGE_KEY)
      if (typeof raw === 'string' && raw.length <= 2 * 1024 * 1024) {
        const saved = JSON.parse(raw)
        if (!Array.isArray(saved) || saved.some(job => !job || typeof job !== 'object' || !job.id || typeof job.status !== 'string')) throw new Error('Invalid saved queue')
        jobs = saved.slice(-100).map(projectGenerationQueueJob)
        source = 'persisted'
        note = 'Saved app-wide unfinished-job records only, not filtered to the open project and not live ComfyUI status. Jobs are not restored, resumed, imported or submitted by this read. Open Generate only if you intend its normal job recovery to run.'
      }
    } catch { /* Unreadable storage is unknown, not a confirmed empty queue. */ }
  }
  const workflowId = String(payload.workflowId || '').trim()
  const batchId = String(payload.batchId || '').trim()
  const ids = new Set((Array.isArray(payload.jobIds) ? payload.jobIds : []).map(value => String(value || '').trim()).filter(Boolean))
  const requestedLimit = Number(payload.limit)
  const limit = Number.isFinite(requestedLimit) && requestedLimit !== 0 ? Math.max(1, Math.min(500, Math.floor(requestedLimit))) : 100
  if (workflowId) jobs = jobs.filter(job => job.workflowId === workflowId || job.executionWorkflowId === workflowId)
  if (batchId) jobs = jobs.filter(job => job.batchId === batchId)
  if (ids.size) jobs = jobs.filter(job => ids.has(String(job.id || '')) || ids.has(String(job.runId || '')))
  if (payload.includeDone === false) jobs = jobs.filter(job => !TERMINAL.has(String(job.status || '').toLowerCase()))
  jobs = jobs.slice(-limit).reverse()
  return copy({
    success: true, action: 'get_generation_queue_status', source, live, scope: 'application',
    message: 'Generation queue snapshot inspected; no jobs started or changed.',
    available: source !== 'unavailable', updatedAt: live ? latestSnapshotTime(snapshot, legacyLive, runsLive) : null,
    isConnected: legacyLive ? Boolean(snapshot.isConnected) : null, note,
    sources: live ? { managed: legacyLive, registeredRuns: runsLive } : undefined,
    count: jobs.length,
    activeCount: live ? jobs.filter(isActiveLiveJob).length : null,
    jobs: live ? jobs : jobs.map(job => ({ ...job, lastKnownStatus: job.status,
      lastKnownProgress: job.progress, status: 'unknown', progress: null })),
  })
}
