import { create } from 'zustand'
import { projectGenerationQueueJob } from '../services/generationQueueStatus.mjs'

// GenerateWorkspace still publishes its established managed jobs here. The
// app-global generation-run bridge publishes a second, native-owned set. Keep
// the sources separate so Generate can unmount without erasing an agent-run
// or explicitly observed external job.

const RUN_STATUS_ALIASES = Object.freeze({
  completed: 'done', complete: 'done', success: 'done', failed: 'error', failure: 'error',
  canceled: 'cancelled', cancelled: 'cancelled', waiting: 'queued', pending: 'queued',
  preparing: 'configuring', installing: 'configuring', 'awaiting-approval': 'paused',
  awaiting_approval: 'paused', importing: 'saving',
})

function text(value, max = 240) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)
}

function number(value, fallback = 0) {
  const candidate = Number(value)
  return Number.isFinite(candidate) ? candidate : fallback
}

function timestamp(value, fallback = 0) {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function endpoint(value) {
  return text(value, 600).replace(/\/+$/, '').toLowerCase()
}

function cloneMonitorValue(value, fallback) {
  try { return JSON.parse(JSON.stringify(value)) } catch (_) { return fallback }
}

function runStatus(value) {
  const raw = text(value || 'queued', 48).toLowerCase()
  return RUN_STATUS_ALIASES[raw] || raw || 'queued'
}

function sanitizeMonitorJob(job = {}) {
  const promptId = text(job.promptId, 180) || null
  const status = text(job.status || 'queued', 48).toLowerCase() || 'queued'
  return {
    id: text(job.id, 180) || `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    legacyId: text(job.id, 180) || null,
    runId: null,
    workflowId: text(job.workflowId, 180),
    workflowLabel: text(job.workflowLabel || job.workflowName || job.workflowId || 'Generation', 180),
    category: text(job.category, 80),
    status,
    progress: Math.max(0, Math.min(100, number(job.progress))),
    promptId,
    endpoint: endpoint(job.endpoint || job.comfyEndpoint || ''),
    node: job.node ?? null,
    error: text(job.error, 500),
    prompt: text(job.prompt, 240),
    createdAt: timestamp(job.createdAt, Date.now()),
    startedAt: timestamp(job.startedAt) || null,
    completedAt: timestamp(job.completedAt) || null,
    elapsedMs: number(job.elapsedMs, 0) || null,
    resultAssetIds: Array.isArray(job.resultAssetIds) ? job.resultAssetIds.filter(Boolean).slice(0, 12) : [],
    restoredFromLedger: Boolean(job.restoredFromLedger),
    origin: 'velorn',
    source: 'legacy',
    // An error before ComfyUI returns a prompt id is a useful diagnostic, but
    // it is not a real queued/running generation and must not look like one.
    unsubmittedAttempt: status === 'error' && !promptId,
    outputs: [],
    recipeAvailable: false,
    adopted: false,
    autoImport: false,
    projectKey: null,
    projectName: null,
  }
}

function sanitizeOutput(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const filename = text(raw.filename || raw.file || raw.name, 240)
  if (!filename || filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') return null
  const subfolder = text(raw.subfolder || raw.subFolder || '', 400)
  if (subfolder.startsWith('/') || subfolder.startsWith('\\') || /^[A-Za-z]:/.test(subfolder)
    || subfolder.split(/[\\/]+/).some(part => part === '..')) return null
  const outputType = text(raw.type || raw.outputType || 'output', 24).toLowerCase()
  if (outputType !== 'output') return null
  const mediaType = text(raw.mediaType || raw.kind || '', 24).toLowerCase()
  if (!['image', 'video', 'audio'].includes(mediaType)) return null
  return { filename, subfolder, type: outputType, nodeId: text(raw.nodeId, 80) || null, mediaType }
}

function sanitizeRun(raw = {}) {
  const runId = text(raw.id || raw.runId || raw.requestId, 180)
  if (!runId) return null
  const originCandidate = text(raw.origin || raw.source || 'agent', 30).toLowerCase()
  const origin = ['velorn', 'agent', 'external'].includes(originCandidate) ? originCandidate : 'external'
  const outputs = []
  const outputKeys = new Set()
  // The native ledger intentionally bounds a run to 512 descriptors. Mirror
  // that exact ceiling rather than silently hiding later outputs from an
  // import acknowledgement.
  for (const value of Array.isArray(raw.outputs) ? raw.outputs.slice(0, 512) : []) {
    const output = sanitizeOutput(value)
    if (!output) continue
    const key = `${output.mediaType}:${output.filename}|${output.subfolder}|${output.type}|${output.nodeId || ''}`
    if (outputKeys.has(key)) continue
    outputKeys.add(key)
    outputs.push(output)
  }
  const rawStatus = text(raw.status || 'queued', 48).toLowerCase() || 'queued'
  const status = runStatus(rawStatus)
  const progressValue = raw.progress
  const progressKnown = progressValue !== null && progressValue !== undefined && progressValue !== ''
    && Number.isFinite(Number(progressValue))
  return {
    id: `run:${runId}`,
    runId,
    legacyId: null,
    requestId: text(raw.requestId, 180) || null,
    workflowId: text(raw.workflowId || raw.workflow || raw.templateId, 180),
    workflowLabel: text(raw.workflowLabel || raw.label || raw.workflowName || raw.workflowId || 'ComfyUI workflow', 180),
    category: text(raw.category || raw.mediaType, 80),
    status,
    rawStatus,
    progress: progressKnown ? Math.max(0, Math.min(100, Number(progressValue))) : null,
    progressKnown,
    promptId: text(raw.promptId, 180) || null,
    endpoint: endpoint(raw.endpoint || raw.comfyEndpoint || ''),
    node: raw.node == null ? null : text(raw.node, 120) || null,
    error: text(raw.error || raw.message, 500),
    prompt: text(raw.prompt, 240),
    createdAt: timestamp(raw.createdAt, Date.now()),
    startedAt: timestamp(raw.startedAt) || null,
    completedAt: timestamp(raw.completedAt) || null,
    elapsedMs: number(raw.elapsedMs, 0) || null,
    resultAssetIds: Array.isArray(raw.resultAssetIds) ? raw.resultAssetIds.filter(Boolean).slice(0, 512) : [],
    origin,
    source: 'native-run',
    execution: text(raw.execution || raw.executionType || raw.assessment?.execution || '', 80) || null,
    local: raw.local === true || raw.assessment?.local === true,
    cloud: raw.cloud === true || raw.assessment?.cloud === true,
    assessment: raw.assessment && typeof raw.assessment === 'object' ? cloneMonitorValue(raw.assessment, null) : null,
    outputs,
    // A future native ledger may have more output descriptors than it can
    // safely surface in one record. Preserve that fact so the renderer never
    // calls a partial import “complete.” Older bridges simply omit it.
    outputCount: Number.isFinite(Number(raw.outputCount ?? raw.totalOutputs))
      ? Math.max(outputs.length, Math.min(1_000_000, Math.floor(Number(raw.outputCount ?? raw.totalOutputs))))
      : outputs.length,
    outputsTruncated: raw.outputsTruncated === true || raw.outputTruncated === true
      || raw.outputDescriptorsTruncated === true || Number(raw.outputCount ?? raw.totalOutputs) > outputs.length,
    // Native records retain a redacted recipe for a registered run. Older
    // records can still opt out explicitly; opening remains a safe native
    // request and never submits a graph.
    recipeAvailable: raw.recipeAvailable === true || raw.recipe === true || raw.hasRecipe === true
      || (raw.recipeAvailable !== false && Boolean(raw.requestId || raw.adopted)),
    adopted: raw.adopted === true || raw.importState?.adopted === true,
    autoImport: raw.autoImport !== false,
    importState: raw.importState && typeof raw.importState === 'object'
      ? cloneMonitorValue(raw.importState, null)
      : text(raw.importState, 80) ? { state: text(raw.importState, 80) } : null,
    canCancel: raw.canCancel === true,
    // This is renderer-only identity used to prevent cross-project imports.
    // It must retain a desktop path when the capture context uses a path;
    // `runStatusProjection` intentionally does not expose it through MCP.
    projectKey: text(raw.projectKey || raw.project?.key || raw.project?.projectKey, 8192) || null,
    projectName: text(raw.projectName || raw.project?.name, 160) || null,
    unsubmittedAttempt: false,
  }
}

function jobIdentity(job) {
  if (!job?.promptId) return null
  const endpointKey = endpoint(job.endpoint)
  // A prompt id by itself is not globally unique when people have multiple
  // ComfyUI instances. Missing endpoint only dedupes another missing endpoint.
  return `${endpointKey}::${String(job.promptId)}`
}

function terminalRank(status) {
  if (status === 'error') return 6
  if (status === 'cancelled') return 5
  if (status === 'done') return 4
  if (status === 'detached') return 3
  return 0
}

function mergeSamePrompt(legacy, run) {
  const nativeIsNewer = timestamp(run.completedAt || run.startedAt || run.createdAt) >= timestamp(legacy.completedAt || legacy.startedAt || legacy.createdAt)
  const preferred = nativeIsNewer ? run : legacy
  const fallback = nativeIsNewer ? legacy : run
  const preferredTerminal = terminalRank(preferred.status)
  const fallbackTerminal = terminalRank(fallback.status)
  const status = preferredTerminal || !fallbackTerminal ? preferred.status : fallback.status
  return {
    ...fallback,
    ...preferred,
    id: run.id,
    runId: run.runId,
    legacyId: legacy.id,
    source: 'merged',
    origin: run.origin || legacy.origin || 'velorn',
    status,
    rawStatus: run.rawStatus || legacy.rawStatus || status,
    progress: run.progressKnown ? run.progress : legacy.progress,
    progressKnown: run.progressKnown || false,
    resultAssetIds: Array.from(new Set([...(legacy.resultAssetIds || []), ...(run.resultAssetIds || [])])).slice(0, 512),
    outputs: run.outputs?.length ? run.outputs : legacy.outputs || [],
    outputCount: run.outputCount || legacy.outputCount || 0,
    outputsTruncated: run.outputsTruncated === true || legacy.outputsTruncated === true,
    error: run.error || legacy.error || '',
    unsubmittedAttempt: false,
  }
}

function mergeJobs(legacyJobs = [], runs = []) {
  const result = []
  const identityIndexes = new Map()
  const legacyWithoutEndpoint = new Map()
  for (const legacy of legacyJobs) {
    const identity = jobIdentity(legacy)
    if (identity && identityIndexes.has(identity)) {
      const index = identityIndexes.get(identity)
      result[index] = mergeSamePrompt(result[index], legacy)
    } else {
      result.push(legacy)
      if (identity) identityIndexes.set(identity, result.length - 1)
      if (legacy.promptId && !legacy.endpoint) {
        const entries = legacyWithoutEndpoint.get(legacy.promptId) || []
        entries.push(result.length - 1)
        legacyWithoutEndpoint.set(legacy.promptId, entries)
      }
    }
  }
  for (const run of runs) {
    const identity = jobIdentity(run)
    let index = identity && identityIndexes.has(identity) ? identityIndexes.get(identity) : null
    // Legacy Generate jobs predate endpoint capture. Matching a registered
    // native run by prompt id is safe only when there is exactly one
    // endpoint-less legacy candidate; never apply this fallback to external
    // observations, where a prompt ID can belong to another server.
    if (index == null && run.origin !== 'external' && run.promptId) {
      const candidates = legacyWithoutEndpoint.get(run.promptId) || []
      if (candidates.length === 1) index = candidates[0]
    }
    if (index != null) {
      result[index] = mergeSamePrompt(result[index], run)
    } else {
      result.push(run)
      if (identity) identityIndexes.set(identity, result.length - 1)
    }
  }
  return result.sort((a, b) => number(a.createdAt) - number(b.createdAt))
}

function runStatusProjection(run) {
  return {
    id: run.runId || run.id,
    workflowId: run.workflowId || undefined,
    workflowLabel: run.workflowLabel || undefined,
    status: run.status,
    progress: run.progressKnown ? run.progress : null,
    promptId: run.promptId || null,
    resultAssetIds: Array.isArray(run.resultAssetIds) ? [...run.resultAssetIds] : [],
    error: run.error || null,
    origin: run.origin || 'external',
    source: run.source || 'native-run',
    // `projectKey` is deliberately omitted: a desktop project key may be an
    // absolute local path. `projectName` is the portable display hint.
    projectName: run.projectName || null,
    node: run.node || null,
    outputs: (run.outputs || []).map(output => ({ ...output })),
    outputCount: run.outputCount || (run.outputs || []).length,
    outputsTruncated: run.outputsTruncated === true,
    importState: run.importState?.state || run.importState || null,
    recipeAvailable: run.recipeAvailable === true,
    adopted: run.adopted === true,
    unsubmittedAttempt: run.unsubmittedAttempt === true,
  }
}

function mergeQueueStatusJobs(legacyJobs, runJobs) {
  if (!runJobs.length) return legacyJobs.map(projectGenerationQueueJob)
  // Keep endpoint only while calculating the collision key. It is a loopback
  // connection identity, not part of the long-standing public legacy schema.
  const mappedLegacy = legacyJobs.map(job => ({
    ...projectGenerationQueueJob(job),
    _queueEndpoint: endpoint(job?.endpoint || job?.comfyEndpoint || ''),
  }))
  const mappedRuns = runJobs.map(run => ({ ...runStatusProjection(run), _queueEndpoint: endpoint(run.endpoint) }))
  const byIdentity = new Map()
  const endpointlessLegacyByPrompt = new Map()
  const result = []
  for (const job of mappedLegacy) {
    const key = job.promptId ? `${job._queueEndpoint || ''}::${job.promptId}` : null
    result.push(job)
    if (key) byIdentity.set(key, result.length - 1)
    if (job.promptId && !job._queueEndpoint) {
      const indexes = endpointlessLegacyByPrompt.get(job.promptId) || []
      indexes.push(result.length - 1)
      endpointlessLegacyByPrompt.set(job.promptId, indexes)
    }
  }
  for (const job of mappedRuns) {
    const key = job.promptId ? `${job._queueEndpoint || ''}::${job.promptId}` : null
    let index = key && byIdentity.has(key) ? byIdentity.get(key) : null
    // Existing Generate records did not retain their endpoint. Only bridge a
    // single unambiguous legacy record to a native registered run; external
    // jobs always remain endpoint-scoped.
    if (index == null && job.origin !== 'external' && job.promptId) {
      const candidates = endpointlessLegacyByPrompt.get(job.promptId) || []
      if (candidates.length === 1) index = candidates[0]
    }
    if (index != null) {
      const previous = result[index]
      result[index] = {
        ...previous,
        ...job,
        id: job.id,
        resultAssetIds: Array.from(new Set([...(previous.resultAssetIds || []), ...(job.resultAssetIds || [])])),
      }
      continue
    }
    result.push(job)
    if (key) byIdentity.set(key, result.length - 1)
  }
  return result.map(({ _queueEndpoint, ...job }) => job)
}

function buildState({ legacyJobs, legacyQueueStatusJobs, runs, activeJobId, isConnected, legacyAvailable, legacyOwner,
  runsAvailable, runsOwner, observation, updatedAt, runsUpdatedAt }) {
  const jobs = mergeJobs(legacyJobs, runs)
  return {
    legacyJobs,
    legacyQueueStatusJobs,
    runs,
    jobs,
    activeJobId,
    isConnected: Boolean(isConnected),
    updatedAt: Math.max(timestamp(updatedAt), timestamp(runsUpdatedAt), Date.now()),
    queueStatusAvailable: Boolean(legacyAvailable),
    // The compact title-bar monitor deliberately caps result IDs and prompt
    // text. MCP's existing queue-status contract, however, has always
    // retained the complete (detached) managed-job projection. Keep that
    // source separately instead of accidentally shrinking its output just
    // because a global run drawer also exists.
    queueStatusJobs: mergeQueueStatusJobs(legacyQueueStatusJobs || legacyJobs, runs),
    queueStatusOwner: legacyOwner ? { ...legacyOwner } : null,
    runsAvailable: Boolean(runsAvailable),
    runsQueueStatusJobs: runs.map(runStatusProjection),
    runsOwner: runsOwner ? { ...runsOwner } : null,
    runsUpdatedAt: timestamp(runsUpdatedAt) || 0,
    observation: observation && typeof observation === 'object' ? cloneMonitorValue(observation, null) : null,
  }
}

const useGenerationMonitorStore = create((set, get) => ({
  legacyJobs: [],
  legacyQueueStatusJobs: [],
  runs: [],
  jobs: [],
  activeJobId: null,
  isConnected: false,
  updatedAt: 0,
  queueStatusAvailable: false,
  queueStatusJobs: [],
  queueStatusOwner: null,
  runsAvailable: false,
  runsQueueStatusJobs: [],
  runsOwner: null,
  runsUpdatedAt: 0,
  observation: null,
  publishQueue: ({ jobs = [], activeJobId = null, isConnected = false, owner = null } = {}) => {
    set((state) => buildState({
      legacyJobs: Array.isArray(jobs) ? jobs.map(sanitizeMonitorJob) : [],
      legacyQueueStatusJobs: Array.isArray(jobs) ? jobs.map(job => cloneMonitorValue(job, {})) : [],
      runs: state.runs || [],
      activeJobId,
      isConnected,
      legacyAvailable: true,
      legacyOwner: owner,
      runsAvailable: state.runsAvailable,
      runsOwner: state.runsOwner,
      observation: state.observation,
      updatedAt: Date.now(),
      runsUpdatedAt: state.runsUpdatedAt,
    }))
  },
  publishRuns: ({ runs = [], owner = null, updatedAt = null, available = true, observation = null } = {}) => {
    set((state) => buildState({
      legacyJobs: state.legacyJobs || [],
      legacyQueueStatusJobs: state.legacyQueueStatusJobs || [],
      runs: (Array.isArray(runs) ? runs : []).map(sanitizeRun).filter(Boolean),
      activeJobId: state.activeJobId,
      isConnected: state.isConnected,
      legacyAvailable: state.queueStatusAvailable,
      legacyOwner: state.queueStatusOwner,
      runsAvailable: available === true,
      runsOwner: owner,
      observation: observation || state.observation,
      updatedAt: state.updatedAt,
      runsUpdatedAt: timestamp(updatedAt, Date.now()),
    }))
  },
  markRunImported: (runId, resultAssetIds = [], importState = 'imported') => {
    const id = text(runId, 180)
    if (!id) return
    set((state) => {
      const runs = (state.runs || []).map((run) => run.runId !== id ? run : {
        ...run,
        resultAssetIds: Array.from(new Set([...(run.resultAssetIds || []), ...(Array.isArray(resultAssetIds) ? resultAssetIds.filter(Boolean) : [])])).slice(0, 512),
        importState: {
          ...(run.importState || {}),
          state: importState === 'partial' ? 'partial' : 'imported',
          imported: importState !== 'partial',
          importedAt: Date.now(),
        },
      })
      return buildState({
        legacyJobs: state.legacyJobs || [], legacyQueueStatusJobs: state.legacyQueueStatusJobs || [],
        runs, activeJobId: state.activeJobId, isConnected: state.isConnected,
        legacyAvailable: state.queueStatusAvailable, legacyOwner: state.queueStatusOwner,
        runsAvailable: state.runsAvailable, runsOwner: state.runsOwner, observation: state.observation,
        updatedAt: state.updatedAt, runsUpdatedAt: Date.now(),
      })
    })
  },
  setObservation: (observation = null) => {
    const state = get()
    set(buildState({
      legacyJobs: state.legacyJobs || [], legacyQueueStatusJobs: state.legacyQueueStatusJobs || [],
      runs: state.runs || [], activeJobId: state.activeJobId, isConnected: state.isConnected,
      legacyAvailable: state.queueStatusAvailable, legacyOwner: state.queueStatusOwner,
      runsAvailable: state.runsAvailable, runsOwner: state.runsOwner,
      observation: observation && typeof observation === 'object' ? observation : null,
      updatedAt: state.updatedAt, runsUpdatedAt: state.runsUpdatedAt,
    }))
  },
  setRunsAvailability: (available) => {
    const state = get()
    set(buildState({
      legacyJobs: state.legacyJobs || [], legacyQueueStatusJobs: state.legacyQueueStatusJobs || [],
      runs: state.runs || [], activeJobId: state.activeJobId, isConnected: state.isConnected,
      legacyAvailable: state.queueStatusAvailable, legacyOwner: state.queueStatusOwner,
      runsAvailable: available === true, runsOwner: available === true ? state.runsOwner : null,
      observation: state.observation, updatedAt: state.updatedAt, runsUpdatedAt: state.runsUpdatedAt,
    }))
  },
  // GenerateWorkspace calls reset on unmount. It must only invalidate its own
  // projection; global native runs stay available across workspace switches.
  reset: () => {
    const state = get()
    set(buildState({
      legacyJobs: [], legacyQueueStatusJobs: [], runs: state.runs || [], activeJobId: null, isConnected: false,
      legacyAvailable: false, legacyOwner: null, runsAvailable: state.runsAvailable,
      runsOwner: state.runsOwner, observation: state.observation, updatedAt: Date.now(),
      runsUpdatedAt: state.runsUpdatedAt,
    }))
  },
  clearRuns: () => {
    const state = get()
    set(buildState({
      legacyJobs: state.legacyJobs || [], legacyQueueStatusJobs: state.legacyQueueStatusJobs || [],
      runs: [], activeJobId: state.activeJobId, isConnected: state.isConnected,
      legacyAvailable: state.queueStatusAvailable, legacyOwner: state.queueStatusOwner,
      runsAvailable: false, runsOwner: null, observation: null, updatedAt: state.updatedAt,
      runsUpdatedAt: Date.now(),
    }))
  },
  resetAll: () => set(buildState({
    legacyJobs: [], legacyQueueStatusJobs: [], runs: [], activeJobId: null, isConnected: false,
    legacyAvailable: false, legacyOwner: null, runsAvailable: false, runsOwner: null,
    observation: null, updatedAt: Date.now(), runsUpdatedAt: 0,
  })),
}))

export default useGenerationMonitorStore
