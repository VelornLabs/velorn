'use strict'

// Native, project-aware bookkeeping for ComfyUI prompts.  This deliberately
// does not try to be a global ComfyUI queue: prompts are only owned after a
// Velorn-managed submission or an explicit adoption.  It never resubmits a
// graph while recovering a record.

const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

const VERSION = 1
const FILE_NAME = 'velorn-generation-runs-v1.json'
const LIMITS = Object.freeze({
  fileBytes: 8 * 1024 * 1024,
  workflowBytes: 2 * 1024 * 1024,
  workflowNodes: 1500,
  workflowDepth: 64,
  runs: 400,
  labels: 192,
  promptId: 512,
  assetIds: 128,
  outputItems: 512,
  responseBytes: 4 * 1024 * 1024,
  pollIntervalMs: 2000,
  pollAttempts: 90,
  missingAttempts: 3,
  pollRunsPerPass: 24,
  requestTimeoutMs: 15000,
})

const ACTIVE = new Set(['submitting', 'queued', 'running'])
const TERMINAL = new Set(['done', 'error', 'cancelled', 'unknown'])
const PRUNABLE = new Set(['done', 'error', 'cancelled'])
const SECRET_FIELD = /(?:api.?key|authorization|(?:access|refresh|auth|bearer)[_-]?token|password|secret|cookie)/i
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9_-]{8,}|hf_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16})\b|\bBearer\s+[A-Za-z0-9._~+\/-]+/gi
const MAX_REPORTED_OUTPUTS = 1_000_000

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => plain(value) && Object.hasOwn(value, key) ? value[key] : undefined
const copy = value => JSON.parse(JSON.stringify(value))
const nowIso = () => new Date().toISOString()

async function readBoundedFile(filePath, maxBytes) {
  const handle = await fs.open(filePath, 'r')
  try {
    const chunks = []; let bytes = 0; let position = 0
    while (true) {
      // Read one byte beyond the cap when necessary, without allocating based
      // on untrusted file size. A damaged ledger cannot force a giant buffer.
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, maxBytes - bytes + 1)))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      bytes += bytesRead
      if (bytes > maxBytes) throw fault('STORAGE_UNAVAILABLE', 'Generation-run storage exceeds its safety limit.')
      chunks.push(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    return Buffer.concat(chunks, bytes)
  } finally { await handle.close() }
}

function fault(code, message) {
  return Object.assign(new Error(message), { code: `GENERATION_RUNS_${code}`, publicMessage: message })
}

function failure(code, error, extra = {}) {
  return { success: false, code: `GENERATION_RUNS_${code}`, error, ...extra }
}

function endpointValue(value) {
  if (typeof value !== 'string' || value.length > 2048) throw fault('INVALID_ENDPOINT', 'Choose a configured loopback ComfyUI connection.')
  let url
  try { url = new URL(value) } catch { throw fault('INVALID_ENDPOINT', 'Choose a configured loopback ComfyUI connection.') }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw fault('INVALID_ENDPOINT', 'Choose a configured loopback ComfyUI connection.')
  }
  return url.origin
}

function text(value, max = LIMITS.labels) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max && !/[\u0000-\u001f]/.test(trimmed) ? trimmed : null
}

function promptId(value) {
  const id = text(value, LIMITS.promptId)
  return id && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) ? id : null
}

function normalizeContext(value) {
  let context = value
  if (typeof context === 'string') {
    try { context = JSON.parse(context) } catch { throw fault('CONTEXT_UNAVAILABLE', 'The current Velorn project context is unavailable.') }
    if (Array.isArray(context)) context = { session: context[0], projectKey: context[1], timelineId: context[2] }
  }
  if (!plain(context) || typeof context.session !== 'string' || !context.session || context.session.length > 512
    || !(context.projectKey === null || (typeof context.projectKey === 'string' && context.projectKey.length <= 8192))
    || !(context.timelineId == null || (typeof context.timelineId === 'string' && context.timelineId.length <= 512))) {
    throw fault('CONTEXT_UNAVAILABLE', 'The current Velorn project context is unavailable.')
  }
  return { session: context.session, projectKey: context.projectKey, timelineId: context.timelineId ?? null }
}

function contextIdentity(context) {
  const value = normalizeContext(context)
  return JSON.stringify([value.session, value.projectKey, value.timelineId])
}

function cloneJson(value, depth = 0, ancestors = new Set(), reserve = () => {}) {
  if (depth > LIMITS.workflowDepth) throw fault('INVALID_WORKFLOW', 'The workflow is nested too deeply.')
  if (value === null || typeof value === 'boolean') { reserve(5); return value }
  if (typeof value === 'string') { reserve(Buffer.byteLength(value) + 2); return value }
  if (typeof value === 'number' && Number.isFinite(value)) { reserve(String(value).length); return value }
  if (typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || ancestors.has(value)) throw fault('INVALID_WORKFLOW', 'The workflow must contain only ordinary JSON data.')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw fault('INVALID_WORKFLOW', 'Workflow arrays must contain ordinary JSON values without gaps.')
      const output = []
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw fault('INVALID_WORKFLOW', 'The workflow must contain only ordinary JSON data.')
        reserve(1)
        output.push(cloneJson(descriptor.value, depth + 1, ancestors, reserve))
      }
      return output
    }
    const output = {}
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw fault('INVALID_WORKFLOW', 'The workflow must contain only ordinary JSON data.')
      }
      reserve(Buffer.byteLength(key) + 3)
      output[key] = cloneJson(descriptor.value, depth + 1, ancestors, reserve)
    }
    return output
  } finally {
    ancestors.delete(value)
  }
}

function workflowInput(args = {}, required = true) {
  const hasObject = Object.hasOwn(args, 'workflow') && args.workflow !== undefined
  const hasJson = Object.hasOwn(args, 'workflowJson') && args.workflowJson !== undefined
  if (!hasObject && !hasJson) {
    if (!required) return null
    throw fault('WORKFLOW_REQUIRED', 'Provide an API workflow object or workflowJson string.')
  }
  if (hasObject && hasJson) throw fault('INVALID_WORKFLOW', 'Provide either workflow or workflowJson, not both.')
  let source = args.workflow
  if (hasJson) {
    if (typeof args.workflowJson !== 'string' || Buffer.byteLength(args.workflowJson) > LIMITS.workflowBytes) {
      throw fault('INVALID_WORKFLOW', 'The workflow JSON exceeds the 2 MiB limit.')
    }
    try { source = JSON.parse(args.workflowJson) } catch { throw fault('INVALID_WORKFLOW', 'workflowJson must contain valid JSON.') }
  }
  if (!plain(source) || Object.keys(source).length < 1 || Object.keys(source).length > LIMITS.workflowNodes) {
    throw fault('INVALID_WORKFLOW', `Choose an API workflow containing 1–${LIMITS.workflowNodes} nodes.`)
  }
  let bytes = 0
  const reserve = count => {
    bytes += count
    if (bytes > LIMITS.workflowBytes) throw fault('INVALID_WORKFLOW', 'The workflow exceeds the 2 MiB limit.')
  }
  const workflow = cloneJson(source, 0, new Set(), reserve)
  let serialized
  try { serialized = JSON.stringify(workflow) } catch { throw fault('INVALID_WORKFLOW', 'The workflow must contain only ordinary JSON data.') }
  if (Buffer.byteLength(serialized) > LIMITS.workflowBytes) throw fault('INVALID_WORKFLOW', 'The workflow exceeds the 2 MiB limit.')
  for (const node of Object.values(workflow)) {
    if (!plain(node) || typeof node.class_type !== 'string' || !node.class_type.trim() || node.class_type.length > 512 || !plain(node.inputs)) {
      throw fault('INVALID_WORKFLOW', 'Choose an API workflow with valid node classes and inputs.')
    }
  }
  return { workflow, fingerprint: createHash('sha256').update(serialized).digest('hex') }
}

function redactString(value) {
  return typeof value === 'string' ? value.replace(SECRET_VALUE, '[redacted]') : value
}

function redactedRecipe(workflow, fingerprint) {
  function visit(value) {
    if (Array.isArray(value)) {
      const items = value.map(visit)
      return { value: items.map(item => item.value), redacted: items.some(item => item.redacted) }
    }
    if (!plain(value)) {
      const next = redactString(value)
      return { value: next, redacted: next !== value }
    }
    const output = {}; let redacted = false
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_FIELD.test(key)) { output[key] = '[redacted]'; redacted = true; continue }
      const next = visit(item)
      output[key] = next.value
      redacted ||= next.redacted
    }
    return { value: output, redacted }
  }
  const result = visit(workflow)
  return { workflow: result.value, fingerprint, redacted: result.redacted, cannotExactReplay: true,
    note: 'This stored recipe is redacted for safety and cannot be treated as an exact replayable workflow.' }
}

function safeError(value, fallback = 'The ComfyUI job could not be confirmed.') {
  const message = typeof value === 'string' ? value : value?.message
  if (typeof message !== 'string') return fallback
  const clean = redactString(message).replace(/[\u0000-\u001f]+/g, ' ').trim()
  return clean && clean.length <= 512 ? clean : fallback
}

function optionalIds(value, { limit = LIMITS.assetIds, field = 'inputAssetIds' } = {}) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > limit) throw fault('INVALID_REQUEST', `${field} must be a bounded array of asset IDs.`)
  const result = []
  for (const item of value) {
    const id = text(item, 512)
    if (!id) throw fault('INVALID_REQUEST', `${field} must contain valid asset IDs.`)
    if (!result.includes(id)) result.push(id)
  }
  return result
}

function storedIds(value, limit = LIMITS.assetIds) {
  if (!Array.isArray(value)) return { ids: [], truncated: false }
  const ids = []; let truncated = false
  for (const item of value) {
    const id = text(item, 512)
    if (!id || ids.includes(id)) continue
    if (ids.length >= limit) { truncated = true; continue }
    ids.push(id)
  }
  return { ids, truncated }
}

function outputFilename(value) {
  const name = text(value, 1024)
  return name && !/[\\/]/.test(name) && name !== '.' && name !== '..' ? name : null
}

function outputSubfolder(value) {
  if (value === undefined || value === null || value === '') return ''
  // ComfyUI normally returns a relative POSIX-style subfolder. Reject both
  // native separators and drive-qualified paths so a malformed server reply
  // cannot later be joined outside Velorn's configured output root on Windows.
  if (typeof value !== 'string' || value.length > 1024 || /[\u0000-\u001f\\]/.test(value)
    || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null
  const parts = value.split('/')
  return parts.length && parts.every(part => part && part !== '.' && part !== '..') ? value : null
}

function outputKey(output) {
  return `${output.mediaType}:${output.filename}|${output.subfolder}|${output.type}|${output.nodeId}`
}

function outputEligibility(type, mediaType) {
  const safeMediaType = text(mediaType, 24)?.toLowerCase()
  if (!['image', 'video', 'audio'].includes(safeMediaType)) return null
  // PreviewImage and other temporary ComfyUI results are useful to ComfyUI,
  // but are not durable Velorn assets. They must not make the real saved
  // outputs look only partially imported.
  const safeType = type === undefined || type === null || type === '' ? 'output' : text(type, 96)?.toLowerCase()
  return safeType === 'output' ? { mediaType: safeMediaType, type: safeType } : null
}

function safeOutputDescriptor({ filename, subfolder, type, nodeId, mediaType } = {}) {
  // SaveVideo reports MP4s under `images`; the bucket is not the file type.
  // Normalize old persisted descriptors here as well as fresh responses.
  if (/\.(mp4|webm|mov|mkv|avi|m4v|gif)$/i.test(filename || '')) mediaType = 'video'
  else if (/\.(mp3|wav|ogg|flac|aac|m4a|opus)$/i.test(filename || '')) mediaType = 'audio'
  else if (/\.(png|jpe?g|webp|bmp|tiff?)$/i.test(filename || '')) mediaType = 'image'
  const eligibility = outputEligibility(type, mediaType)
  if (!eligibility) return { eligible: false, output: null }
  const safeFilename = outputFilename(filename)
  const safeSubfolder = outputSubfolder(subfolder)
  if (!safeFilename || safeSubfolder === null) return { eligible: true, output: null }
  return { eligible: true, output: {
    filename: safeFilename, subfolder: safeSubfolder, type: text(type, 96) || 'output',
    nodeId: text(nodeId, 128) || 'unknown', mediaType: eligibility.mediaType,
  } }
}

function addOutput(summary, output) {
  const key = outputKey(output)
  if (summary.keys.has(key)) return
  summary.keys.add(key)
  summary.outputCount += 1
  if (summary.outputs.length < LIMITS.outputItems) summary.outputs.push(output)
  else summary.outputsTruncated = true
}

function outputDescriptors(outputs) {
  const summary = { outputs: [], outputCount: 0, outputsTruncated: false, invalidCount: 0, keys: new Set() }
  if (!plain(outputs)) return summary
  const kinds = [
    ['images', 'image'], ['gifs', 'video'], ['videos', 'video'], ['audio', 'audio'], ['files', 'file'],
  ]
  for (const [nodeId, value] of Object.entries(outputs)) {
    if (!plain(value)) continue
    for (const [key, mediaType] of kinds) {
      if (!Array.isArray(value[key])) continue
      for (const item of value[key]) {
        if (!plain(item)) { summary.invalidCount += 1; continue }
        const normalized = safeOutputDescriptor({ ...item, nodeId, mediaType })
        if (!normalized.eligible) continue
        if (!normalized.output) { summary.invalidCount += 1; continue }
        addOutput(summary, normalized.output)
      }
    }
  }
  return summary
}

function storedOutputDescriptors(value) {
  const summary = { outputs: [], outputCount: 0, outputsTruncated: false, invalidCount: 0, keys: new Set() }
  if (!Array.isArray(value)) return summary
  for (const raw of value) {
    if (!plain(raw)) { summary.invalidCount += 1; continue }
    const normalized = safeOutputDescriptor(raw)
    if (!normalized.eligible) continue
    if (!normalized.output) { summary.invalidCount += 1; continue }
    addOutput(summary, normalized.output)
  }
  return summary
}

function queueEntries(body) {
  if (!plain(body)) return []
  const rows = []
  for (const [key, status] of [['queue_running', 'running'], ['queue_pending', 'queued']]) {
    if (!Array.isArray(body[key])) continue
    for (const entry of body[key]) {
      if (!Array.isArray(entry)) continue
      const id = promptId(entry[1])
      if (!id) continue
      rows.push({ promptId: id, status, workflow: plain(entry[2]) ? entry[2] : null })
    }
  }
  return rows
}

function historyEntry(body, id) {
  if (!plain(body)) return null
  const entry = own(body, id)
  if (!plain(entry)) return null
  const status = own(entry, 'status')
  const statusText = text(own(status, 'status_str'), 96)?.toLowerCase() || ''
  const workflow = Array.isArray(own(entry, 'prompt')) && plain(entry.prompt[2]) ? entry.prompt[2] : null
  const error = statusText === 'error' || statusText === 'failed' || statusText === 'cancelled' || statusText === 'interrupted'
  const done = statusText === 'success' || statusText === 'completed'
  const outputSummary = outputDescriptors(own(entry, 'outputs'))
  return { status: done ? 'done' : error ? (statusText === 'cancelled' || statusText === 'interrupted' ? 'cancelled' : 'error') : 'running',
    workflow, outputs: outputSummary.outputs, outputCount: outputSummary.outputCount + outputSummary.invalidCount,
    outputsTruncated: outputSummary.outputsTruncated || outputSummary.invalidCount > 0,
    error: error ? safeError(status?.messages, `ComfyUI reported ${statusText || 'an error'}.`) : null }
}

function boundedOutputCount(value, fallback = 0) {
  const count = Number.isSafeInteger(value) && value >= 0 ? Math.min(value, MAX_REPORTED_OUTPUTS) : fallback
  return Math.max(fallback, count)
}

function importSummary(run, resultAssetIds = run.resultAssetIds) {
  const outputs = Array.isArray(run.outputs) ? run.outputs : []
  const outputCount = boundedOutputCount(run.outputCount, outputs.length)
  const outputsTruncated = run.outputsTruncated === true || outputCount > outputs.length
  const importedCount = Array.isArray(resultAssetIds) ? resultAssetIds.length : 0
  const complete = run.status === 'done' && !outputsTruncated && importedCount >= outputCount
  return { outputCount, outputsTruncated, importedCount, complete }
}

function importWarning(run, summary = importSummary(run)) {
  if (summary.outputsTruncated) {
    return `Only ${Array.isArray(run.outputs) ? run.outputs.length : 0} of ${summary.outputCount} reported output${summary.outputCount === 1 ? '' : 's'} can be tracked safely. This run remains partially imported.`
  }
  if (run.importState === 'partial' && summary.importedCount < summary.outputCount) {
    return `${summary.importedCount} of ${summary.outputCount} tracked output${summary.outputCount === 1 ? '' : 's'} have been imported.`
  }
  if (run.importState === 'partial' && run.status !== 'done') return 'ComfyUI has not confirmed this generation as complete yet.'
  return null
}

function mergeResultAssetIds(existing, incoming) {
  const merged = []
  for (const id of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!merged.includes(id)) merged.push(id)
    if (merged.length > LIMITS.outputItems) {
      throw fault('INVALID_REQUEST', `resultAssetIds cannot exceed ${LIMITS.outputItems} tracked output assets.`)
    }
  }
  return merged
}

function importAcknowledgement(run, incomingResultAssetIds) {
  const resultAssetIds = mergeResultAssetIds(run.resultAssetIds, incomingResultAssetIds)
  const summary = importSummary(run, resultAssetIds)
  const importState = summary.complete ? 'imported' : 'partial'
  const projected = { ...run, resultAssetIds, importState }
  return { resultAssetIds, importState, summary, message: importWarning(projected, summary) }
}

function savedWorkflowIdentity(value) {
  if (typeof value?.workflowId !== 'string' || value.workflowId.length > 200
    || !/^(?:my-workflow:[A-Za-z0-9][A-Za-z0-9_.-]*|tpl-mcp-[a-z0-9][a-z0-9-]{0,47})$/.test(value.workflowId)
    || typeof value.sourceGraphFingerprint !== 'string' || typeof value.resolvedFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.sourceGraphFingerprint || '') || !/^[a-f0-9]{64}$/.test(value.resolvedFingerprint || '')) return {}
  return { workflowId: value.workflowId, sourceGraphFingerprint: value.sourceGraphFingerprint, resolvedFingerprint: value.resolvedFingerprint }
}

function publicRun(run) {
  const outputs = Array.isArray(run.outputs) ? copy(run.outputs) : []
  const resultAssetIds = Array.isArray(run.resultAssetIds) ? [...run.resultAssetIds] : []
  const imports = importSummary({ ...run, outputs }, resultAssetIds)
  let importState = run.importState || 'pending'
  // Older ledgers could mark a run imported after receiving only a subset of
  // its asset IDs. Preserve the receipt but expose the honest partial state.
  if (importState === 'imported' && !imports.complete) importState = 'partial'
  return {
    id: run.id, requestId: run.requestId ?? null, promptId: run.promptId ?? null, endpoint: run.endpoint,
    projectKey: run.projectKey ?? null, origin: run.origin, adopted: run.adopted === true, label: run.label, status: run.status,
    createdAt: run.createdAt, startedAt: run.startedAt ?? null, completedAt: run.completedAt ?? null,
    progress: Number.isFinite(run.progress) ? run.progress : null, node: run.node ?? null, error: run.error ?? null,
    outputs, outputCount: imports.outputCount, outputsTruncated: imports.outputsTruncated, resultAssetIds,
    assessment: run.assessment ? copy(run.assessment) : null, importState, importWarning: importWarning({ ...run, importState, outputs }, imports),
    inputAssetIds: Array.isArray(run.inputAssetIds) ? [...run.inputAssetIds] : [], targetShotId: run.targetShotId ?? null,
    recipeAvailable: Boolean(run.recipe),
    ...savedWorkflowIdentity(run),
  }
}

function publicSnapshot(runs, updatedAt) {
  return { success: true, runs: runs.map(publicRun), updatedAt: updatedAt ?? null }
}

function storedRun(value) {
  if (!plain(value) || !text(value.id, 128) || !['velorn', 'agent', 'external'].includes(value.origin)
    || !['submitting', 'queued', 'running', 'done', 'error', 'cancelled', 'unknown'].includes(value.status)) return null
  let endpoint
  try { endpoint = endpointValue(value.endpoint) } catch { return null }
  const recipe = plain(value.recipe) && plain(value.recipe.workflow) ? value.recipe : null
  const restoredOutputs = storedOutputDescriptors(value.outputs)
  const outputCount = Math.max(restoredOutputs.outputCount + restoredOutputs.invalidCount,
    boundedOutputCount(value.outputCount ?? value.outputsTotal, restoredOutputs.outputCount))
  const outputsTruncated = value.outputsTruncated === true || restoredOutputs.outputsTruncated
    || restoredOutputs.invalidCount > 0 || outputCount > restoredOutputs.outputs.length
  const restoredResultIds = storedIds(value.resultAssetIds, LIMITS.outputItems)
  const restoredInputIds = storedIds(value.inputAssetIds, LIMITS.assetIds)
  return {
    id: value.id, requestId: text(value.requestId, 256), promptId: promptId(value.promptId), endpoint,
    projectKey: typeof value.projectKey === 'string' && value.projectKey.length <= 8192 ? value.projectKey : null,
    timelineId: typeof value.timelineId === 'string' && value.timelineId.length <= 512 ? value.timelineId : null,
    origin: value.origin, adopted: value.adopted === true || value.origin === 'external', label: text(value.label) || 'ComfyUI generation', status: value.status,
    createdAt: text(value.createdAt, 64) || nowIso(), startedAt: text(value.startedAt, 64), completedAt: text(value.completedAt, 64),
    progress: Number.isFinite(value.progress) ? Math.max(0, Math.min(100, value.progress)) : null,
    node: text(value.node, 256), error: text(value.error, 512), outputs: restoredOutputs.outputs, outputCount, outputsTruncated,
    resultAssetIds: restoredResultIds.ids,
    assessment: plain(value.assessment) ? value.assessment : null, importState: text(value.importState, 64) || 'pending',
    inputAssetIds: restoredInputIds.ids,
    targetShotId: text(value.targetShotId, 512), recipe, pollAttempts: Number.isInteger(value.pollAttempts) ? Math.max(0, value.pollAttempts) : 0,
    missingAttempts: Number.isInteger(value.missingAttempts) ? Math.max(0, value.missingAttempts) : 0,
    ...savedWorkflowIdentity(value),
  }
}

function createGenerationRuns({ storageDir, getEndpoint, getContext, submitManaged, resolveSavedWorkflow, uploadSavedAssets, onGenerationFinished = () => {}, notify = () => {}, fetchImpl = globalThis.fetch,
  assertAvailable = () => {}, now = nowIso, uuid = randomUUID, pollIntervalMs = LIMITS.pollIntervalMs,
  maxPollAttempts = LIMITS.pollAttempts, requestTimeoutMs = LIMITS.requestTimeoutMs } = {}) {
  const filePath = typeof storageDir === 'string' && storageDir ? path.join(storageDir, FILE_NAME) : null
  let loaded = false
  let loading = null
  let storageError = null
  let writeChain = Promise.resolve()
  let disposed = false
  let timer = null
  let polling = false
  let recoveryRequested = false
  let pollCursor = 0
  let sequence = 0
  const pending = new Map()
  const state = { version: VERSION, updatedAt: null, runs: [] }

  async function load({ required = false } = {}) {
    if (!loading) {
      loading = (async () => {
        if (!filePath) { storageError = fault('STORAGE_UNAVAILABLE', 'Generation-run storage is not configured.'); loaded = true; return }
        try {
          const raw = await readBoundedFile(filePath, LIMITS.fileBytes)
          const parsed = JSON.parse(raw.toString('utf8'))
          if (!plain(parsed) || parsed.version !== VERSION || !Array.isArray(parsed.runs)) throw new Error('Invalid generation-run ledger')
          state.updatedAt = text(parsed.updatedAt, 64)
          state.runs = parsed.runs.map(storedRun).filter(Boolean)
        } catch (error) {
          if (error?.code !== 'ENOENT') storageError = error?.publicMessage ? error : fault('STORAGE_UNAVAILABLE', 'Generation-run storage could not be read.')
        } finally { loaded = true }
      })()
    }
    await loading
    if (required && storageError) throw storageError
  }

  async function persist() {
    await load({ required: true })
    const write = async () => {
      if (!filePath) throw fault('STORAGE_UNAVAILABLE', 'Generation-run storage is not configured.')
      const folder = path.dirname(filePath)
      const temporary = `${filePath}.${process.pid}.${++sequence}.tmp`
      state.updatedAt = now()
      // Retain active and uncertain receipts regardless of age. If a ledger is
      // full, only old completed/error/cancelled records may be discarded. A
      // caller receives a capacity error before POST rather than silently
      // losing an active/unknown prompt it may need to inspect later.
      const retained = [...state.runs]
      const prunedIds = new Set()
      let payload
      while (true) {
        payload = JSON.stringify({ version: VERSION, updatedAt: state.updatedAt, runs: retained })
        if (retained.length <= LIMITS.runs && Buffer.byteLength(payload) <= LIMITS.fileBytes) break
        const index = retained.findIndex(run => PRUNABLE.has(run.status))
        if (index < 0) throw fault('CAPACITY', 'Generation-run storage is full of active or uncertain receipts. Finish, import or inspect those runs before queuing another workflow.')
        prunedIds.add(retained[index].id)
        retained.splice(index, 1)
      }
      try {
        await fs.mkdir(folder, { recursive: true })
        await fs.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 })
        await fs.rename(temporary, filePath)
        if (prunedIds.size) state.runs = state.runs.filter(run => !prunedIds.has(run.id))
        storageError = null
      } catch (error) {
        try { await fs.unlink(temporary) } catch { /* Best effort cleanup only. */ }
        if (error?.code === 'GENERATION_RUNS_CAPACITY') throw error
        storageError = error?.publicMessage ? error : fault('STORAGE_UNAVAILABLE', 'Generation-run storage could not be saved.')
        throw storageError
      }
    }
    writeChain = writeChain.catch(() => {}).then(write)
    return writeChain
  }

  function emit() {
    const snapshot = publicSnapshot(state.runs, state.updatedAt)
    try { Promise.resolve(notify(snapshot)).catch(() => {}) } catch { /* Observer failures cannot affect a job. */ }
  }

  function findRun(runId) {
    return state.runs.find(run => run.id === runId) || null
  }

  function runForPrompt(endpoint, id) {
    return state.runs.find(run => run.endpoint === endpoint && run.promptId === id) || null
  }

  async function currentContext() {
    if (typeof getContext !== 'function') throw fault('CONTEXT_UNAVAILABLE', 'The current Velorn project context is unavailable.')
    return normalizeContext(await getContext())
  }

  async function configuredEndpoint() {
    if (typeof getEndpoint !== 'function') throw fault('UNAVAILABLE', 'The configured ComfyUI connection is unavailable.')
    return endpointValue(await getEndpoint())
  }

  async function assertReady() {
    if (typeof assertAvailable === 'function') await assertAvailable()
    if (disposed) throw fault('DISPOSED', 'Generation-run tracking is no longer available.')
  }

  function projectMatches(run, context, includeOtherProjects) {
    return includeOtherProjects === true || run.projectKey === context.projectKey
  }

  function activeRuns() { return state.runs.filter(run => ACTIVE.has(run.status) && run.promptId) }

  function pollBatch(runs) {
    if (runs.length <= LIMITS.pollRunsPerPass) { pollCursor = 0; return runs }
    const start = pollCursor % runs.length
    const selected = []
    for (let index = 0; index < LIMITS.pollRunsPerPass; index++) selected.push(runs[(start + index) % runs.length])
    pollCursor = (start + LIMITS.pollRunsPerPass) % runs.length
    return selected
  }

  function schedulePoll(delay = 0) {
    if (disposed || timer || polling || (!activeRuns().length && !recoveryRequested)) return
    timer = setTimeout(() => { timer = null; void pump() }, Math.max(0, delay))
    timer.unref?.()
  }

  async function boundedResponseText(response, maxBytes, signal) {
    const declared = Number(response.headers?.get?.('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      try { await response.body?.cancel?.() } catch { /* Best effort only. */ }
      throw fault('UNAVAILABLE', 'ComfyUI returned an oversized generation-status response.')
    }
    if (response.body?.getReader) {
      const reader = response.body.getReader(); const chunks = []; let bytes = 0; let complete = false
      const read = async () => {
        if (signal.aborted) throw fault('UNAVAILABLE', 'Velorn timed out while reading ComfyUI generation status.')
        let listener
        const aborted = new Promise((_, reject) => {
          listener = () => reject(fault('UNAVAILABLE', 'Velorn timed out while reading ComfyUI generation status.'))
          signal.addEventListener('abort', listener, { once: true })
        })
        try { return await Promise.race([reader.read(), aborted]) }
        finally { signal.removeEventListener('abort', listener) }
      }
      try {
        while (true) {
          const { done, value } = await read()
          if (done) { complete = true; break }
          bytes += value.byteLength
          if (bytes > maxBytes) throw fault('UNAVAILABLE', 'ComfyUI returned an oversized generation-status response.')
          chunks.push(Buffer.from(value))
        }
        return Buffer.concat(chunks).toString('utf8')
      } finally {
        if (!complete) { try { await reader.cancel() } catch { /* Best effort only. */ } }
        try { reader.releaseLock() } catch { /* A cancelled read may still settle. */ }
      }
    }
    // Injected response fixtures may not expose a streaming body. Native fetch
    // does, so production requests use the bounded path above.
    const raw = await response.text()
    if (Buffer.byteLength(raw) > maxBytes) throw fault('UNAVAILABLE', 'ComfyUI returned an oversized generation-status response.')
    return raw
  }

  async function requestJson(endpoint, route, { method = 'GET', body, tolerateMissing = false } = {}) {
    if (typeof fetchImpl !== 'function') throw fault('UNAVAILABLE', 'ComfyUI networking is unavailable.')
    const controller = new AbortController()
    const timerId = setTimeout(() => controller.abort('timeout'), requestTimeoutMs)
    try {
      const response = await fetchImpl(`${endpoint}${route}`, { method, redirect: 'error',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal })
      if (tolerateMissing && response.status === 404) return { missing: true, status: 404, body: null }
      if (!response.ok) throw fault('UNAVAILABLE', `ComfyUI returned ${response.status} while checking generation activity.`)
      const raw = await boundedResponseText(response, LIMITS.responseBytes, controller.signal)
      if (!raw.trim()) return { status: response.status, body: {} }
      try { return { status: response.status, body: JSON.parse(raw) } } catch { throw fault('UNAVAILABLE', 'ComfyUI returned an invalid generation-status response.') }
    } catch (error) {
      if (error?.publicMessage) throw error
      throw fault('UNAVAILABLE', 'Velorn could not contact the configured ComfyUI server.')
    } finally { clearTimeout(timerId) }
  }

  function updateTerminal(run, status, error = null) {
    run.status = status
    run.progress = status === 'done' ? 100 : run.progress
    run.error = error
    run.completedAt = now()
    run.node = null
  }

  async function markUnknown(runs, message) {
    if (!runs.length) return
    for (const run of runs) updateTerminal(run, 'unknown', message)
    await persist()
    emit()
  }

  async function pump() {
    if (disposed || polling) return
    polling = true
    try {
      await load()
      if (storageError) return
      const endpoint = await configuredEndpoint()
      const recovering = recoveryRequested
      recoveryRequested = false
      const eligible = [...activeRuns(), ...(recovering ? state.runs.filter(run => run.status === 'unknown' && run.promptId) : [])]
        .filter((run, index, values) => values.findIndex(item => item.id === run.id) === index && run.endpoint === endpoint)
      const candidates = pollBatch(eligible)
      const changedConnection = [...activeRuns(), ...(recovering ? state.runs.filter(run => run.status === 'unknown' && run.promptId) : [])]
        .filter((run, index, values) => values.findIndex(item => item.id === run.id) === index && run.endpoint !== endpoint)
      if (changedConnection.length) await markUnknown(changedConnection, 'The configured ComfyUI connection changed before this job could be confirmed.')
      if (!candidates.length) return
      let queue
      try { queue = queueEntries((await requestJson(endpoint, '/queue')).body) }
      catch (error) { await markUnknown(candidates, safeError(error, 'Velorn lost contact with ComfyUI before this job could be confirmed.')); return }
      const byPrompt = new Map(queue.map(item => [item.promptId, item]))
      let changed = false, managedFinished = false
      for (const run of candidates) {
        const queued = byPrompt.get(run.promptId)
        if (queued) {
          if (run.status !== queued.status || run.missingAttempts !== 0 || run.pollAttempts !== 0 || run.completedAt) changed = true
          run.status = queued.status
          run.error = null
          run.completedAt = null
          run.pollAttempts = 0
          run.missingAttempts = 0
          if (queued.status === 'running' && !run.startedAt) run.startedAt = now()
          continue
        }
        try {
          const response = await requestJson(endpoint, `/history/${encodeURIComponent(run.promptId)}`, { tolerateMissing: true })
          const history = response.missing ? null : historyEntry(response.body, run.promptId)
          if (history) {
            if (!run.adopted && ACTIVE.has(run.status) && ['done', 'error', 'cancelled'].includes(history.status)) managedFinished = true
            if (run.status !== history.status || history.status !== 'running' || run.pollAttempts !== 0 || run.completedAt && !TERMINAL.has(history.status)) changed = true
            run.status = history.status
            run.error = history.error
            run.pollAttempts = 0
            run.missingAttempts = 0
            if (history.status === 'running') { if (!run.startedAt) run.startedAt = now(); run.completedAt = null }
            if (TERMINAL.has(history.status)) {
              run.completedAt = now()
              run.node = null
              if (history.status === 'done') {
                run.progress = 100
                run.outputs = history.outputs
                run.outputCount = history.outputCount
                run.outputsTruncated = history.outputsTruncated === true
              }
            }
          } else {
            run.missingAttempts += 1
            run.pollAttempts += 1
            if (run.missingAttempts >= Math.min(LIMITS.missingAttempts, maxPollAttempts)) {
              updateTerminal(run, 'unknown', 'This prompt no longer appears in the configured ComfyUI queue or history. It was not resubmitted.')
            }
            changed = true
          }
        } catch (error) {
          updateTerminal(run, 'unknown', safeError(error, 'Velorn lost contact with ComfyUI before this job could be confirmed.'))
          changed = true
        }
      }
      if (changed) { await persist(); emit() }
      if (managedFinished) {
        try { await onGenerationFinished({ endpoint }) } catch { /* Cleanup never changes a generation outcome. */ }
      }
    } catch { /* A later explicit observe/start can surface availability again. */ }
    finally {
      polling = false
      // An explicit observe/start can request recovery while a prior pump is
      // still in flight.  Do not lose that read-only recovery just because the
      // prior pass turned the last active prompt into `unknown`.
      if (!disposed && (activeRuns().length || recoveryRequested)) {
        schedulePoll(recoveryRequested ? 0 : pollIntervalMs)
      }
    }
  }

  async function start() {
    try {
      await load()
      const ambiguous = state.runs.filter(run => run.status === 'submitting' && !run.promptId)
      if (ambiguous.length) {
        // The pre-submit receipt intentionally exists before POST. If the app
        // stops between POST and the response there is no safe prompt ID to
        // poll, so preserve that uncertainty rather than submitting again.
        for (const run of ambiguous) updateTerminal(run, 'unknown', 'Velorn restarted before ComfyUI acceptance could be confirmed. It was not resubmitted.')
        await persist()
        emit()
      }
      // Unknown prompt IDs are not automatically retried, but an explicit
      // startup/reconnect refresh may ask ComfyUI whether they now exist.
      recoveryRequested = !storageError && state.runs.some(run => run.status === 'unknown' && run.promptId)
      if (!storageError) schedulePoll(0)
      return publicSnapshot(state.runs, state.updatedAt)
    } catch (error) { return failure('STORAGE_UNAVAILABLE', safeError(error, 'Generation-run storage could not be read.')) }
  }

  async function list(args = {}) {
    try {
      await load()
      const context = await currentContext()
      const includeOtherProjects = args?.includeOtherProjects === true
      const runs = state.runs.filter(run => projectMatches(run, context, includeOtherProjects))
      return publicSnapshot(runs, state.updatedAt)
    } catch (error) { return failure(error?.code?.replace(/^GENERATION_RUNS_/, '') || 'UNAVAILABLE', safeError(error)) }
  }

  async function beforeSubmit({ requestId, workflow, fingerprint, endpoint, clientId, context, assessment } = {}) {
    await load({ required: true })
    if (disposed) throw fault('DISPOSED', 'Generation-run tracking is no longer available.')
    const id = text(requestId, 256)
    const normalizedEndpoint = endpointValue(endpoint)
    const normalizedContext = normalizeContext(context)
    const graph = workflowInput({ workflow })
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/.test(id) || !text(clientId, 128)
      || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint) || graph.fingerprint !== fingerprint) {
      throw fault('INVALID_REQUEST', 'The managed generation submission is invalid.')
    }
    const draft = pending.get(id)
    if (draft && (draft.fingerprint !== fingerprint || draft.endpoint !== normalizedEndpoint || draft.context !== contextIdentity(normalizedContext))) {
      throw fault('REQUEST_MISMATCH', 'The generation request changed before it could be submitted.')
    }
    let run = state.runs.find(item => item.requestId === id)
    if (run) throw fault('DUPLICATE_REQUEST', 'This generation request is already tracked.')
    const recipe = redactedRecipe(graph.workflow, fingerprint)
    run = {
      id: draft?.id || uuid(), requestId: id, promptId: null, endpoint: normalizedEndpoint,
      projectKey: normalizedContext.projectKey, timelineId: normalizedContext.timelineId,
      origin: draft?.origin || 'velorn', adopted: false, label: draft?.label || 'Velorn generation', status: 'submitting',
      createdAt: draft?.createdAt || now(), startedAt: null, completedAt: null, progress: null, node: null, error: null,
      outputs: [], outputCount: 0, outputsTruncated: false, resultAssetIds: [], assessment: plain(assessment) ? copy(assessment) : null, importState: 'pending',
      inputAssetIds: draft?.inputAssetIds || [], targetShotId: draft?.targetShotId || null, recipe, pollAttempts: 0, missingAttempts: 0,
      ...savedWorkflowIdentity(draft),
    }
    state.runs.push(run)
    // This await is intentionally before the broker's single POST call. If the
    // durable ledger cannot write, the broker receives a rejection and does not
    // submit a prompt that Velorn cannot later identify.
    try { await persist() }
    catch (error) {
      // A receipt that never reached durable storage must not remain visible
      // as though Velorn could recover it. The broker will reject before POST.
      const index = state.runs.findIndex(item => item.id === run.id)
      if (index >= 0) state.runs.splice(index, 1)
      throw error
    }
    emit()
    return { runId: run.id }
  }

  async function afterSubmit({ requestId, result } = {}) {
    await load({ required: true })
    const run = state.runs.find(item => item.requestId === requestId)
    if (!run) return { ignored: true }
    const body = plain(result?.body) ? result.body : null
    const id = promptId(body?.prompt_id)
    if (result?.success === true && result?.ok === true && id) {
      run.promptId = id
      run.status = 'queued'
      run.error = null
      run.progress = null
      run.pollAttempts = 0
      run.missingAttempts = 0
    } else if (result?.success === true && result?.ok === false) {
      updateTerminal(run, 'error', `ComfyUI rejected this submission (HTTP ${Number.isInteger(result.status) ? result.status : 'unknown'}).`)
    } else {
      // A timeout/disconnect after POST is intentionally not treated as a
      // rejection. Retrying could create duplicate paid or local work.
      updateTerminal(run, 'unknown', 'Velorn could not confirm whether ComfyUI accepted this submission. It was not retried.')
    }
    await persist()
    emit()
    if (ACTIVE.has(run.status)) schedulePoll(0)
    return { runId: run.id, status: run.status }
  }

  async function preserveUncertainSubmission(run, message) {
    if (!run) return
    updateTerminal(run, 'unknown', message)
    try { await persist(); emit() } catch { /* The original pre-POST failure is already surfaced. */ }
  }

  async function submit(args = {}) {
    try {
      if (!plain(args)) throw fault('INVALID_REQUEST', 'Provide a generation-run request.')
      const context = await currentContext()
      const endpoint = await configuredEndpoint()
      const hasSavedSource = args.workflowId !== undefined
      let saved = null
      if (hasSavedSource) {
        if (args.workflow !== undefined || args.workflowJson !== undefined) throw fault('INVALID_REQUEST', 'Provide either a saved workflowId or one inline graph, never both.')
        if (typeof resolveSavedWorkflow !== 'function') throw fault('UNAVAILABLE', 'Saved workflow reuse is unavailable. Restart Velorn.')
        saved = await resolveSavedWorkflow({ workflowId: args.workflowId, inputOverrides: args.inputOverrides,
          templateParameters: args.templateParameters, assetBindings: args.assetBindings })
        if (saved?.success !== true || saved?.ready !== true) throw fault('SAVED_WORKFLOW_NOT_READY', saved?.error || 'That saved workflow is not ready for reuse. Inspect it first.')
        if ((args.previewOnly === false || args.graphFingerprint !== undefined) && args.graphFingerprint !== saved.graphFingerprint) {
          throw fault('SAVED_WORKFLOW_CHANGED', 'The saved workflow changed or its graph fingerprint is missing. Inspect and preview again before applying.')
        }
        if ((args.previewOnly === false || args.resolvedFingerprint !== undefined) && args.resolvedFingerprint !== saved.resolvedFingerprint) {
          throw fault('SAVED_WORKFLOW_CHANGED', 'The exact input overrides changed or their resolved fingerprint is missing. Preview again before applying.')
        }
      } else if (args.inputOverrides !== undefined || args.templateParameters !== undefined || args.assetBindings !== undefined || args.graphFingerprint !== undefined || args.resolvedFingerprint !== undefined) {
        throw fault('INVALID_REQUEST', 'Saved input overrides and fingerprints require a saved workflowId.')
      }
      const graph = workflowInput(saved ? { workflow: saved.workflow } : args)
      const expectedContext = typeof args._expectedContext === 'string' ? args._expectedContext : contextIdentity(context)
      if (expectedContext !== contextIdentity(context)) throw fault('STALE_CONTEXT', 'The project changed; review this generation again.')
      const previewOnly = args.previewOnly !== false
      const metadata = {
        label: text(args.label) || text(saved?.title) || 'Agent generation', inputAssetIds: optionalIds([...new Set([...optionalIds(args.inputAssetIds), ...(saved?.preparedAssets || []).map(a => a.assetId)])]),
        targetShotId: args.targetShotId == null ? null : text(args.targetShotId, 512),
        ...(saved ? savedWorkflowIdentity({ workflowId: args.workflowId, sourceGraphFingerprint: saved.graphFingerprint, resolvedFingerprint: saved.resolvedFingerprint }) : {}),
      }
      if (args.targetShotId != null && !metadata.targetShotId) throw fault('INVALID_REQUEST', 'targetShotId must be a valid shot ID.')
      if (previewOnly) {
        return { success: true, previewOnly: true, requestId: null, runId: null, endpoint, projectKey: context.projectKey,
          fingerprint: graph.fingerprint, label: metadata.label,
          ...(saved ? { workflowId: args.workflowId, graphFingerprint: saved.graphFingerprint, resolvedFingerprint: saved.resolvedFingerprint,
            appliedInputs: saved.appliedInputs, preparedAssets: saved.preparedAssets || [], readinessMessage: saved.readinessMessage,
            suggestedApplyPayload: { previewOnly: false, graphFingerprint: saved.graphFingerprint, resolvedFingerprint: saved.resolvedFingerprint } } : {}),
          message: 'Workflow validated only; no record was written, no approval dialog was opened, and no ComfyUI prompt was queued. To perform an authorized generation, repeat this tool with the same inputs and previewOnly:false (plus the returned fingerprints for saved workflows). Apply assesses spending and opens native confirmation automatically under ask-cloud when needed, or a local-trust review for an eligible unfamiliar saved workflow under local-only; no pre-recorded spending approval is required to request it. Local-only policy and actual refusals still apply. Saved originals remain unchanged.' }
      }
      await assertReady()
      if (contextIdentity(await currentContext()) !== expectedContext || await configuredEndpoint() !== endpoint) {
        throw fault('STALE_CONTEXT', 'The project or ComfyUI connection changed; review this generation again.')
      }
      if (typeof submitManaged !== 'function') throw fault('UNAVAILABLE', 'The native managed-generation bridge is unavailable. Restart Velorn.')
      if (saved?.preparedAssets?.length) {
        if (typeof uploadSavedAssets !== 'function') throw fault('UNAVAILABLE', 'Reference upload support is unavailable. Restart Velorn.')
        const assertCurrent = async () => {
          await assertReady()
          if (contextIdentity(await currentContext()) !== expectedContext || await configuredEndpoint() !== endpoint) throw fault('STALE_CONTEXT', 'The project or ComfyUI connection changed during reference preparation. Preview again; no generation was queued.')
        }
        await uploadSavedAssets(saved.preparedAssets, { endpoint, assertCurrent })
        await assertCurrent()
      }
      const runId = uuid()
      const requestId = `velorn-run-${runId}`
      const clientId = `velorn-agent-${runId.slice(0, 24)}`
      const draft = { id: runId, requestId, endpoint, context: contextIdentity(context), fingerprint: graph.fingerprint,
        origin: 'agent', createdAt: now(), ...metadata }
      pending.set(requestId, draft)
      let result
      try { result = await submitManaged({ requestId, workflow: graph.workflow, endpoint, clientId,
        ...(saved ? { savedWorkflowId: args.workflowId } : {}) }) }
      catch (error) {
        await preserveUncertainSubmission(state.runs.find(item => item.requestId === requestId),
          'Velorn could not confirm the native submission result. It was not retried.')
        throw error
      } finally { pending.delete(requestId) }
      const run = state.runs.find(item => item.requestId === requestId)
      if (!plain(result) || typeof result.success !== 'boolean') {
        await preserveUncertainSubmission(run, 'Velorn received an invalid native submission result. It was not retried.')
        return failure('SUBMISSION_UNCERTAIN', 'Velorn could not confirm the native submission result. It was not retried.',
          { requestId, runId: run?.id || null, submissionState: 'unknown', retryAllowed: false })
      }
      if (!run && result.success === true) {
        // The caller posted without the required native beforeSubmit hook. Do
        // not pretend that a durable pre-POST record exists; mark this
        // submission uncertain and require inspection instead of retrying.
        return failure('SUBMISSION_UNCERTAIN', 'ComfyUI may have received the workflow, but Velorn did not receive its durable tracking receipt. It was not retried.',
          { requestId, runId: null, submissionState: 'unknown', retryAllowed: false })
      }
      if (result?.success === false) return { ...result, requestId, runId: run?.id || null }
      return { success: true, previewOnly: false, requestId, runId: run?.id || runId, run: run ? publicRun(run) : null,
        submission: result }
    } catch (error) {
      return failure(error?.code?.replace(/^GENERATION_RUNS_/, '') || 'UNAVAILABLE', safeError(error))
    }
  }

  async function observe() {
    try {
      await load()
      const endpoint = await configuredEndpoint()
      const entries = queueEntries((await requestJson(endpoint, '/queue')).body)
      const jobs = entries.map(entry => {
        const run = runForPrompt(endpoint, entry.promptId)
        return { promptId: entry.promptId, status: entry.status, label: run?.label || `External ComfyUI job ${entry.promptId.slice(0, 12)}`,
          runId: run?.id || null, origin: run?.origin || 'external' }
      })
      // Refresh is explicit. It may recheck only prompt IDs Velorn already
      // owns after this read; it does not adopt arbitrary queue work, import
      // files, or submit anything. This lets a transient disconnect recover
      // without requiring an app restart while `list()` stays purely cached.
      if (state.runs.some(run => run.status === 'unknown' && run.promptId && run.endpoint === endpoint)) {
        recoveryRequested = true
        schedulePoll(0)
      }
      return { success: true, endpoint, jobs, updatedAt: now(), message: 'Read-only ComfyUI queue observation; no jobs were submitted, adopted or imported. Known prompt status may refresh separately.' }
    } catch (error) { return failure(error?.code?.replace(/^GENERATION_RUNS_/, '') || 'UNAVAILABLE', safeError(error)) }
  }

  async function adopt(args = {}) {
    try {
      if (!plain(args)) throw fault('INVALID_REQUEST', 'Provide a ComfyUI prompt ID to adopt.')
      await load({ required: true })
      const id = promptId(args.promptId)
      if (!id) throw fault('INVALID_REQUEST', 'A known ComfyUI prompt ID is required for adoption.')
      const endpoint = await configuredEndpoint()
      const context = await currentContext()
      const contextId = contextIdentity(context)
      const previewOnly = args.previewOnly !== false
      const existing = runForPrompt(endpoint, id)
      if (existing) {
        if (!projectMatches(existing, context, false)) return failure('NOT_FOUND', 'That generation run is not available in this project.')
        return { success: true, adopted: false, run: publicRun(existing), message: 'This ComfyUI prompt is already tracked by Velorn.' }
      }
      const queue = queueEntries((await requestJson(endpoint, '/queue')).body)
      const queued = queue.find(item => item.promptId === id)
      let history = null
      if (!queued) {
        const response = await requestJson(endpoint, `/history/${encodeURIComponent(id)}`, { tolerateMissing: true })
        history = response.missing ? null : historyEntry(response.body, id)
      }
      if (!queued && !history) return failure('ADOPTION_NOT_FOUND', 'That prompt is not present in the configured ComfyUI queue or history.')
      const supplied = workflowInput(args, false)
      const observed = workflowInput({ workflow: queued?.workflow || history?.workflow }, false)
      if (supplied && observed && supplied.fingerprint !== observed.fingerprint) {
        throw fault('WORKFLOW_MISMATCH', 'The supplied workflow does not match the workflow ComfyUI reported for this prompt.')
      }
      // Prefer the graph actually correlated by ComfyUI. A supplied graph is a
      // fallback only for history/queue variants that omit their prompt graph.
      const captured = observed || supplied
      if (!captured) throw fault('WORKFLOW_REQUIRED', 'Adoption needs the API workflow so Velorn can retain a redacted recipe.')
      const metadata = {
        label: text(args.label) || `Adopted ComfyUI job ${id.slice(0, 12)}`,
        inputAssetIds: optionalIds(args.inputAssetIds), targetShotId: args.targetShotId == null ? null : text(args.targetShotId, 512),
      }
      if (args.targetShotId != null && !metadata.targetShotId) throw fault('INVALID_REQUEST', 'targetShotId must be a valid shot ID.')
      const status = queued?.status || history?.status || 'unknown'
      const run = {
        id: uuid(), requestId: null, promptId: id, endpoint, projectKey: context.projectKey, timelineId: context.timelineId,
        origin: 'external', adopted: true, ...metadata, status, createdAt: now(), startedAt: status === 'running' ? now() : null,
        completedAt: TERMINAL.has(status) ? now() : null, progress: status === 'done' ? 100 : null, node: null,
        error: history?.error || null, outputs: history?.outputs || [], outputCount: history?.outputCount || 0,
        outputsTruncated: history?.outputsTruncated === true, resultAssetIds: [], assessment: null, importState: 'pending',
        recipe: redactedRecipe(captured.workflow, captured.fingerprint), pollAttempts: 0, missingAttempts: 0,
      }
      if (previewOnly) {
        return { success: true, previewOnly: true, adopted: false, candidate: publicRun(run),
          message: 'ComfyUI prompt verified only; no Velorn run record was written.' }
      }
      // The observed prompt is not enough authority to attach it to whatever
      // project happened to become active while the network read was running.
      if (contextIdentity(await currentContext()) !== contextId || await configuredEndpoint() !== endpoint) {
        throw fault('STALE_CONTEXT', 'The project or ComfyUI connection changed; verify adoption again.')
      }
      await assertReady()
      if (contextIdentity(await currentContext()) !== contextId || await configuredEndpoint() !== endpoint) {
        throw fault('STALE_CONTEXT', 'The project or ComfyUI connection changed; verify adoption again.')
      }
      state.runs.push(run)
      try { await persist() }
      catch (error) {
        const index = state.runs.findIndex(item => item.id === run.id)
        if (index >= 0) state.runs.splice(index, 1)
        throw error
      }
      emit()
      if (ACTIVE.has(run.status)) schedulePoll(0)
      return { success: true, adopted: true, run: publicRun(run) }
    } catch (error) { return failure(error?.code?.replace(/^GENERATION_RUNS_/, '') || 'UNAVAILABLE', safeError(error)) }
  }

  async function recipe(args = {}) {
    try {
      await load()
      const id = text(args?.runId, 128)
      const context = await currentContext()
      const run = id && findRun(id)
      if (!run || !projectMatches(run, context, args?.includeOtherProjects === true)) return failure('NOT_FOUND', 'That generation run is not available in this project.')
      if (!run.recipe) return failure('WORKFLOW_REQUIRED', 'This generation run has no retained workflow recipe.')
      return { success: true, runId: run.id, requestId: run.requestId, promptId: run.promptId, workflow: copy(run.recipe.workflow),
        ...savedWorkflowIdentity(run),
        fingerprint: run.recipe.fingerprint, redacted: run.recipe.redacted === true, cannotExactReplay: true, note: run.recipe.note }
    } catch (error) { return failure(error?.code?.replace(/^GENERATION_RUNS_/, '') || 'UNAVAILABLE', safeError(error)) }
  }

  async function control(args = {}) {
    try {
      if (!plain(args)) throw fault('INVALID_REQUEST', 'Provide a generation-run control request.')
      const operation = text(args.operation, 64)
      if (!operation) throw fault('INVALID_REQUEST', 'Choose a generation-run operation.')
      if (operation === 'retry') {
        const old = await load().then(async () => {
          const context = await currentContext(); const run = findRun(text(args.runId, 128))
          return run && projectMatches(run, context, false) ? { run, contextId: contextIdentity(context) } : null
        })
        if (!old) return failure('NOT_FOUND', 'That generation run is not available in this project.')
        return submit({ workflow: args.workflow, workflowJson: args.workflowJson, previewOnly: args.previewOnly,
          label: text(args.label) || `Retry — ${old.run.label}`, inputAssetIds: args.inputAssetIds ?? old.run.inputAssetIds,
          targetShotId: args.targetShotId ?? old.run.targetShotId, _expectedContext: old.contextId })
      }
      await load({ required: operation !== 'list' })
      const context = await currentContext()
      const run = findRun(text(args.runId, 128))
      if (!run || !projectMatches(run, context, false)) return failure('NOT_FOUND', 'That generation run is not available in this project.')
      if (operation === 'mark-imported' || operation === 'ack-imported') {
        const incomingResultAssetIds = optionalIds(args.resultAssetIds, { limit: LIMITS.outputItems, field: 'resultAssetIds' })
        const acknowledgement = importAcknowledgement(run, incomingResultAssetIds)
        const projected = { ...run, resultAssetIds: acknowledgement.resultAssetIds, importState: acknowledgement.importState,
          error: acknowledgement.importState === 'imported' ? null : run.error }
        if (args.previewOnly !== false) return { success: true, previewOnly: true, run: publicRun(projected), partial: acknowledgement.importState === 'partial',
          message: acknowledgement.message || 'Import acknowledgement previewed only; no generation-run record was changed.' }
        await assertReady()
        if (contextIdentity(await currentContext()) !== contextIdentity(context)) throw fault('STALE_CONTEXT', 'The project changed; verify import acknowledgement again.')
        run.resultAssetIds = acknowledgement.resultAssetIds
        run.importState = acknowledgement.importState
        if (acknowledgement.importState === 'imported') run.error = null
        await persist(); emit()
        return { success: true, run: publicRun(run), partial: acknowledgement.importState === 'partial', message: acknowledgement.message }
      }
      if (operation === 'mark-import-failed') {
        if (args.previewOnly !== false) return { success: true, previewOnly: true, run: publicRun({ ...run, importState: 'failed',
          error: safeError(args.error, 'Velorn could not import this generation result.') }),
          message: 'Import failure acknowledgement previewed only; no generation-run record was changed.' }
        await assertReady()
        if (contextIdentity(await currentContext()) !== contextIdentity(context)) throw fault('STALE_CONTEXT', 'The project changed; verify import acknowledgement again.')
        run.importState = 'failed'
        run.error = safeError(args.error, 'Velorn could not import this generation result.')
        await persist(); emit()
        return { success: true, run: publicRun(run) }
      }
      if (operation === 'cancel') {
        if (run.status === 'running') return failure('RUNNING_CANCEL_UNSUPPORTED', 'This prompt is already running. Velorn will not issue ComfyUI’s global interrupt because it can affect unrelated work.')
        if (run.status !== 'queued' || !run.promptId) return failure('NOT_QUEUED', 'Only a known queued ComfyUI prompt can be removed safely.')
        const endpoint = await configuredEndpoint()
        if (endpoint !== run.endpoint) return failure('STALE_CONNECTION', 'The configured ComfyUI connection changed; inspect this job before cancelling it.')
        const checkPending = async () => {
          // A durable card can be stale. Only the actual pending queue record
          // is eligible for deletion; Velorn never calls global /interrupt.
          const fresh = queueEntries((await requestJson(endpoint, '/queue')).body).find(item => item.promptId === run.promptId)
          if (!fresh) return failure('NOT_QUEUED', 'This prompt is no longer pending in the configured ComfyUI queue.')
          if (fresh.status === 'running') return failure('RUNNING_CANCEL_UNSUPPORTED', 'This prompt is already running. Velorn will not issue ComfyUI’s global interrupt because it can affect unrelated work.')
          return null
        }
        const pendingError = await checkPending()
        if (pendingError) return pendingError
        if (args.previewOnly !== false) return { success: true, previewOnly: true, run: publicRun(run),
          message: 'Queued prompt verified; apply cancellation to remove only this pending ComfyUI prompt.' }
        const current = await currentContext()
        if (current.projectKey !== context.projectKey || current.timelineId !== context.timelineId || current.session !== context.session) {
          throw fault('STALE_CONTEXT', 'The project changed; verify cancellation again.')
        }
        await assertReady()
        const afterAvailability = await currentContext()
        if (afterAvailability.projectKey !== context.projectKey || afterAvailability.timelineId !== context.timelineId || afterAvailability.session !== context.session) {
          throw fault('STALE_CONTEXT', 'The project changed; verify cancellation again.')
        }
        // The project read above is asynchronous, so refresh the queue once
        // more directly before its delete POST to avoid cancelling a prompt
        // that moved into execution in the meantime.
        const finalPendingError = await checkPending()
        if (finalPendingError) return finalPendingError
        const response = await requestJson(endpoint, '/queue', { method: 'POST', body: { delete: [run.promptId] } })
        if (!response) return failure('UNAVAILABLE', 'ComfyUI did not confirm queue removal.')
        updateTerminal(run, 'cancelled', 'Removed from the ComfyUI pending queue.')
        await persist(); emit()
        return { success: true, run: publicRun(run) }
      }
      return failure('INVALID_REQUEST', 'That generation-run operation is not supported.')
    } catch (error) { return failure(error?.code?.replace(/^GENERATION_RUNS_/, '') || 'UNAVAILABLE', safeError(error)) }
  }

  return {
    list, submit, adopt, recipe, control, observe, start, beforeSubmit, afterSubmit,
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
      pending.clear()
    },
    // Useful to a native caller that needs a whole-application refresh without
    // performing a network read. It is intentionally not an MCP operation.
    snapshot: async () => { await load(); return publicSnapshot(state.runs, state.updatedAt) },
  }
}

module.exports = { createGenerationRuns, LIMITS, FILE_NAME }
