'use strict'

const { createHash } = require('node:crypto')
const { classifyGenerationGraph } = require('./generationSpendingPolicy.cjs')
const { localTrustCandidate } = require('./generationLocalWorkflowTrust.cjs')

const STATUS_SETTING_KEY = 'generationSpendingPolicy'
const CHANNELS = Object.freeze({
  status: 'generation-spending:status', setPolicy: 'generation-spending:set-policy',
  queue: 'generation-spending:queue', queuePriced: 'generation-spending:queue-priced', cancel: 'generation-spending:cancel', changed: 'generation-spending:changed',
  revokeLocalTrust: 'generation-spending:revoke-local-trust',
})
const LIMITS = Object.freeze({ graphBytes: 2 * 1024 * 1024, graphNodes: 1500, depth: 64,
  metadataBytes: 40 * 1024 * 1024, responseBytes: 2 * 1024 * 1024, requestIds: 10000,
  metadataTimeoutMs: 15000, submissionTimeoutMs: 30000, contextTimeoutMs: 15000, resourceTimeoutMs: 120000 })
const POLICIES = new Set(['local-only', 'ask-cloud'])
const { soundCloudApproval } = require('./soundCloudApproval.cjs')
// Marks a request that came from a person's click on a priced button. It is a
// private value, so nothing outside this file (a renderer argument, an agent
// tool, the MCP bridge) can claim it.
const PRICED_CLICK = Symbol('priced-click')
const SECRET_FIELD = /(?:api.?key|authorization|(?:access|refresh|auth|bearer)[_-]?token|password|secret|cookie)/i
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fault = (code, message) => Object.assign(new Error(message), { code: `GENERATION_SPENDING_${code}`, publicMessage: message })
const policyValue = value => POLICIES.has(value) ? value : 'local-only'

function endpointValue(value) {
  if (typeof value !== 'string' || value.length > 2048) throw fault('INVALID_ENDPOINT', 'Choose a configured loopback ComfyUI connection.')
  let url
  try { url = new URL(value) } catch { throw fault('INVALID_ENDPOINT', 'Choose a configured loopback ComfyUI connection.') }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw fault('INVALID_ENDPOINT', 'Managed generation accepts only the configured loopback ComfyUI connection.')
  }
  return url.origin
}

function freezeJson(value, depth = 0) {
  if (depth > LIMITS.depth) throw fault('INVALID_GRAPH', 'The workflow is nested too deeply.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw fault('INVALID_GRAPH', 'The workflow must contain only ordinary JSON data.')
  }
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw fault('INVALID_GRAPH', 'The workflow must contain only ordinary JSON data.')
    freezeJson(descriptor.value, depth + 1)
  }
  return Object.freeze(value)
}

function cloneGraph(graph) {
  if (!record(graph) || Object.keys(graph).length < 1 || Object.keys(graph).length > LIMITS.graphNodes) {
    throw fault('INVALID_GRAPH', `Choose an API workflow containing 1–${LIMITS.graphNodes} nodes.`)
  }
  // Validate without invoking toJSON/getters, then retain a detached frozen graph.
  // IPC already clones values, but the detached copy also protects injected callers.
  let minimumBytes = 0
  function reserve(bytes) {
    minimumBytes += bytes
    if (minimumBytes > LIMITS.graphBytes) throw fault('INVALID_GRAPH', 'The workflow exceeds the 2 MiB managed-generation limit.')
  }
  function validate(value, depth = 0, ancestors = new Set()) {
    if (depth > LIMITS.depth) throw fault('INVALID_GRAPH', 'The workflow is nested too deeply.')
    if (value === null || typeof value === 'boolean') { reserve(4); return }
    if (typeof value === 'string') { reserve(Buffer.byteLength(value) + 2); return }
    if (typeof value === 'number' && Number.isFinite(value)) { reserve(String(value).length); return }
    if (typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || ancestors.has(value)) throw fault('INVALID_GRAPH', 'The workflow must contain only ordinary JSON data.')
    ancestors.add(value)
    reserve(2)
    if (Array.isArray(value) && Object.keys(value).length !== value.length) throw fault('INVALID_GRAPH', 'Workflow arrays must contain ordinary JSON values without gaps.')
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw fault('INVALID_GRAPH', 'The workflow must contain only ordinary JSON data.')
      if (Array.isArray(value)) {
        if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) throw fault('INVALID_GRAPH', 'Workflow arrays must contain only indexed JSON values.')
        reserve(1)
      } else reserve(Buffer.byteLength(key) + 3)
      validate(descriptor.value, depth + 1, ancestors)
    }
    ancestors.delete(value)
  }
  validate(graph)
  let serialized
  try { serialized = JSON.stringify(graph) } catch { throw fault('INVALID_GRAPH', 'The workflow must contain only ordinary JSON data.') }
  if (Buffer.byteLength(serialized) > LIMITS.graphBytes) throw fault('INVALID_GRAPH', 'The workflow exceeds the 2 MiB managed-generation limit.')
  const copy = JSON.parse(serialized)
  for (const node of Object.values(copy)) {
    if (!record(node) || typeof node.class_type !== 'string' || !node.class_type.trim() || node.class_type.length > 512 || !record(node.inputs)) {
      throw fault('INVALID_GRAPH', 'Choose an API workflow with valid node classes and inputs.')
    }
  }
  return { workflow: freezeJson(copy), fingerprint: createHash('sha256').update(serialized).digest('hex') }
}

function checkAbort(signal) {
  if (signal.aborted) throw fault(signal.reason === 'timeout' ? 'TIMEOUT' : 'CANCELLED', signal.reason === 'timeout'
    ? 'The managed generation request timed out.' : 'The managed generation request was cancelled before completion.')
}

async function abortable(operation, signal) {
  checkAbort(signal)
  let listener
  const aborted = new Promise((_, reject) => {
    listener = () => { try { checkAbort(signal) } catch (error) { reject(error) } }
    signal.addEventListener('abort', listener, { once: true })
  })
  try { return await Promise.race([Promise.resolve().then(() => { checkAbort(signal); return operation() }), aborted]) }
  finally { signal.removeEventListener('abort', listener) }
}

async function boundedText(response, maxBytes, signal) {
  if (Number(response.headers?.get?.('content-length')) > maxBytes) {
    try { Promise.resolve(response.body?.cancel?.()).catch(() => {}) } catch { /* Best effort. */ }
    throw fault('RESPONSE_LIMIT', 'The service response exceeded its safety limit.')
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader(); const chunks = []; let bytes = 0; let complete = false
    try {
      while (true) {
        const { done, value } = await abortable(() => reader.read(), signal)
        if (done) { complete = true; break }
        bytes += value.byteLength
        if (bytes > maxBytes) throw fault('RESPONSE_LIMIT', 'The service response exceeded its safety limit.')
        chunks.push(Buffer.from(value))
      }
      return Buffer.concat(chunks).toString('utf8')
    } finally {
      if (!complete) { try { Promise.resolve(reader.cancel()).catch(() => {}) } catch { /* Best effort. */ } }
      try { reader.releaseLock() } catch { /* A cancelled read may still be settling. */ }
    }
  }
  // The fallback supports injected response fixtures; native fetch is streamed.
  const value = await abortable(() => response.text(), signal)
  if (Buffer.byteLength(value) > maxBytes) throw fault('RESPONSE_LIMIT', 'The service response exceeded its safety limit.')
  return value
}

function graphSecrets(workflow) {
  const secrets = new Set()
  function visit(value) {
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_FIELD.test(key) && typeof item === 'string' && item) secrets.add(item)
      else visit(item)
    }
  }
  visit(workflow)
  return secrets
}

function publicBody(body, secrets) {
  const redact = value => {
    if (typeof value !== 'string') return value
    for (const secret of secrets) value = value.split(secret).join('[redacted]')
    return value.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|hf_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16})\b/g, '[redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
  }
  function visit(value, depth = 0) {
    if (depth > LIMITS.depth) return '[response nesting omitted]'
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1))
    if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key),
      SECRET_FIELD.test(key) ? '[redacted]' : visit(item, depth + 1)]))
    return redact(value)
  }
  return visit(body)
}

// One approval for several pictures made with a person's own paid workflow.
// The approval is tied to the paid nodes and their settings (the model, the
// quality, how many pictures per run), not to the words or the reference
// pictures, which change from shot to shot. It covers a stated number of
// submissions, in one project, for a limited time, and nothing else.
const BATCH_LIMITS = Object.freeze({ min: 2, max: 200, milliseconds: 60 * 60 * 1000 })
const BATCH_IGNORED_INPUTS = new Set(['seed', 'noise_seed', 'control_after_generate', 'prompt', 'text'])
function batchShape(workflow, assessment) {
  const paid = Array.isArray(assessment?.paidNodes) ? assessment.paidNodes : []
  if (assessment?.risk !== 'paid' || paid.length === 0 || paid.length >= 20) return null
  const rows = []
  for (const row of paid) {
    const node = Object.prototype.hasOwnProperty.call(workflow, row.id) ? workflow[row.id] : null
    if (!record(node) || typeof node.class_type !== 'string' || !record(node.inputs)) return null
    const settings = Object.keys(node.inputs).sort()
      .filter(key => !BATCH_IGNORED_INPUTS.has(key) && !Array.isArray(node.inputs[key]))
      .map(key => [key, node.inputs[key]])
    rows.push([node.class_type, settings])
  }
  rows.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

function registerGenerationSpendingIpc({ ipcMain, getMainWindow, readPolicy, writePolicy, getEndpoint, getApiKey,
  getContext, confirmPolicyChange, confirmSpend, assertAvailable = () => {}, fetchImpl = globalThis.fetch,
  metadataTimeoutMs = LIMITS.metadataTimeoutMs, submissionTimeoutMs = LIMITS.submissionTimeoutMs,
  contextTimeoutMs = LIMITS.contextTimeoutMs, resourceTimeoutMs = LIMITS.resourceTimeoutMs,
  beforeSubmit, afterSubmit, generationResources, localWorkflowTrust, resolveSavedWorkflow }) {
  let active = null; let disposed = false
  let batchGrant = null
  const seen = new Set(); const bound = new Map()
  function bind(window) {
    const contents = window.webContents
    if (bound.has(contents) || typeof contents.on !== 'function') return
    const cancel = reason => { if (active?.window === window) active.controller.abort(reason) }
    const listeners = [
      ['did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) cancel('navigation') }],
      ['render-process-gone', () => cancel('renderer-gone')], ['destroyed', () => cancel('window-destroyed')],
    ]
    for (const [name, listener] of listeners) contents.on(name, listener)
    bound.set(contents, listeners)
  }
  function authorize(event) {
    const window = getMainWindow()
    if (disposed || !window || window.isDestroyed() || !event?.sender || event.sender.isDestroyed()
      || event.sender !== window.webContents || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) {
      throw fault('UNAUTHORIZED', 'Managed generation is restricted to the main Velorn window.')
    }
    bind(window)
    return window
  }
  function assertWindow(task) {
    checkAbort(task.controller.signal)
    if (disposed || getMainWindow() !== task.window || task.window.isDestroyed() || task.window.webContents.isDestroyed()
      || task.event.senderFrame !== task.window.webContents.mainFrame) throw fault('STALE_CONTEXT', 'The Velorn window changed; review a new request.')
  }
  async function timed(task, milliseconds, operation) {
    const timer = setTimeout(() => task.controller.abort('timeout'), milliseconds)
    try { return await abortable(operation, task.controller.signal) }
    finally { clearTimeout(timer) }
  }
  async function owner(task) {
    const value = await timed(task, contextTimeoutMs, () => getContext())
    assertWindow(task)
    if (!record(value) || typeof value.session !== 'string' || !value.session || value.session.length > 512
      || !(value.projectKey === null || (typeof value.projectKey === 'string' && value.projectKey.length <= 8192))
      || !(value.timelineId == null || (typeof value.timelineId === 'string' && value.timelineId.length <= 512))) {
      throw fault('CONTEXT_UNAVAILABLE', 'The editor context is not ready for managed generation.')
    }
    return JSON.stringify([value.session, value.projectKey, value.timelineId ?? null])
  }
  async function nativeState(task) {
    const [policy, endpoint] = await timed(task, contextTimeoutMs, () => Promise.all([readPolicy(), getEndpoint()]))
    assertWindow(task)
    return { policy: policyValue(policy), endpoint: endpointValue(endpoint) }
  }
  async function recheck(task) {
    assertWindow(task)
    const state = await nativeState(task)
    if (state.policy !== task.policy || state.endpoint !== task.endpoint) throw fault('STALE_CONTEXT', 'The spending policy or ComfyUI connection changed; review a new request.')
    await timed(task, contextTimeoutMs, () => assertAvailable())
    // The renderer context is deliberately last: it is a fresh read-only
    // snapshot, not the snapshot from when a human dialog first opened.
    if (await owner(task) !== task.context) throw fault('STALE_CONTEXT', 'The project or session changed; review a new request.')
    assertWindow(task)
  }
  async function initialize(task) {
    await timed(task, contextTimeoutMs, () => assertAvailable())
    task.context = await owner(task)
    Object.assign(task, await nativeState(task))
  }
  async function getStatus() {
    return { success: true, policy: policyValue(await readPolicy()), scope: 'velorn-managed', busy: Boolean(active),
      enforcement: 'app-managed-queue-only', externalAccessCovered: false,
      ...(localWorkflowTrust ? { localTrustedWorkflows: await localWorkflowTrust.list() } : {}) }
  }
  function writeAuthority(task, additionallyCurrent = () => true) {
    return { signal: task.controller.signal, isCurrent: () => {
      try { assertWindow(task); return active === task && additionallyCurrent() === true } catch { return false }
    } }
  }
  function failure(error, task) {
    if (task?.postStarted) return { success: false, code: 'GENERATION_SPENDING_SUBMISSION_UNCERTAIN',
      error: 'The workflow may already have been submitted. Inspect the ComfyUI queue or history before making another request; Velorn will not retry automatically.',
      submissionState: 'unknown', retryAllowed: false }
    return { success: false, code: error?.publicMessage ? error.code : 'GENERATION_SPENDING_UNAVAILABLE',
      error: error?.publicMessage || 'Managed generation is unavailable. Check the connection and try a new request.', submissionState: 'not-started' }
  }
  function claim(event, kind, requestId) {
    const window = authorize(event)
    if (active) throw fault('BUSY', 'Wait for the current generation request or spending-policy confirmation to finish.')
    const task = { event, window, kind, requestId, controller: new AbortController(), postStarted: false }
    active = task
    return task
  }
  async function recordBeforeSubmit(task, detail) {
    if (typeof beforeSubmit !== 'function') return
    // This hook is deliberately before the one POST below. A durable run
    // ledger may reject it; in that case no prompt is sent to ComfyUI.
    await timed(task, contextTimeoutMs, () => beforeSubmit(detail))
    await recheck(task)
  }
  async function recordAfterSubmit(task, result) {
    if (!task?.postStarted || typeof afterSubmit !== 'function') return
    // POST has already happened. Never turn a bookkeeping failure into an
    // invitation to retry it; the pre-submit receipt remains authoritative.
    try { await Promise.resolve(afterSubmit({ requestId: task.requestId, result })) } catch { /* Best effort only after POST. */ }
  }
  async function acquireGenerationResources(task) {
    if (generationResources == null) return
    if (typeof generationResources.beforeGeneration !== 'function' || typeof generationResources.afterGeneration !== 'function') {
      throw fault('LOCAL_GPU', 'Local GPU sharing is not ready. Check the local agent and generation connection before trying a new request.')
    }
    await recheck(task)
    task.resourcesStarted = true
    try {
      // The coordinator owns cancellation/late-runtime cleanup inside this
      // acquisition. Resolving this hook confirms the agent has released GPU
      // resources; it does not grant spending or permit stale editor context.
      task.resourceLease = await timed(task, resourceTimeoutMs, () => generationResources.beforeGeneration({
        endpoint: task.endpoint, signal: task.controller.signal,
      }))
    } catch {
      if (task.controller.signal.aborted && task.controller.signal.reason !== 'timeout') checkAbort(task.controller.signal)
      throw fault('LOCAL_GPU', task.controller.signal.reason === 'timeout'
        ? 'Timed out waiting for the local agent to release GPU resources. No generation was submitted. Check local GPU sharing before trying a new request.'
        : 'Could not confirm that the local agent released GPU resources. No generation was submitted. Check local GPU sharing before trying a new request.')
    }
    await recheck(task)
  }
  async function finishGenerationResources(task, result) {
    if (!task?.resourcesStarted) return
    task.resourcesStarted = false
    let timer
    try {
      // This is a short ownership handoff, not a wait for the generation. Do not
      // pass the request's aborted signal: a cancelled POST may still be queued.
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Resource handoff timeout')), contextTimeoutMs) })
      await Promise.race([Promise.resolve().then(() => generationResources.afterGeneration({
        lease: task.resourceLease, result, postStarted: task.postStarted,
      })), timeout])
    } catch {
      // Keep the actual POST outcome. A resource-bookkeeping error must not make
      // a confirmed submission look failed, nor make an uncertain one retryable.
      result.resourceWarning = { code: 'GENERATION_SPENDING_LOCAL_GPU',
        message: 'Local GPU handoff could not be confirmed. Inspect GPU sharing status before starting more local work.' }
    } finally { clearTimeout(timer) }
  }
  const handlers = {
    status: async event => { try { authorize(event); return await getStatus() } catch (error) { return failure(error) } },
    revokeLocalTrust: async (event, payload) => {
      let task
      try {
        authorize(event)
        if (!record(payload) || Object.keys(payload).length !== 1 || typeof payload.id !== 'string') throw fault('INVALID_REQUEST', 'Choose a remembered local workflow to remove.')
        if (!localWorkflowTrust) throw fault('UNAVAILABLE', 'Remembered local workflows are unavailable. Restart Velorn.')
        task = claim(event, 'local-trust')
        await timed(task, contextTimeoutMs, () => localWorkflowTrust.revoke(payload.id, writeAuthority(task)))
        assertWindow(task)
        const result = { ...(await getStatus()), busy: false }
        task.window.webContents.send?.(CHANNELS.changed, result)
        return result
      } catch (error) { return failure(error, task) }
      finally { if (active === task) active = null }
    },
    setPolicy: async (event, payload) => {
      let task
      try {
        authorize(event)
        if (!record(payload) || Object.keys(payload).length !== 1 || !POLICIES.has(payload.policy)) throw fault('INVALID_REQUEST', 'Choose Local only or Ask before cloud.')
        const nextPolicy = payload.policy
        batchGrant = null
        task = claim(event, 'policy')
        await initialize(task)
        if (nextPolicy === task.policy) return { ...(await getStatus()), busy: false }
        if (nextPolicy === 'ask-cloud') {
          if (typeof confirmPolicyChange !== 'function') throw fault('UNAVAILABLE', 'Native spending-policy confirmation is unavailable. Restart Velorn.')
          await recheck(task)
          // Do not release serialization while an uncancellable native dialog remains open.
          const confirmed = await confirmPolicyChange({ window: task.window, policy: nextPolicy, previousPolicy: task.policy, signal: task.controller.signal })
          await recheck(task)
          if (confirmed !== true) return { ...(await getStatus()), busy: false, cancelled: true }
        }
        await recheck(task)
        // Persistence may wait behind another settings write. The native writer
        // must check this authority inside its queued mutator, immediately before
        // committing; a timeout/navigation cannot authorize a later queued write.
        const writeAuthority = { signal: task.controller.signal, isCurrent: () => {
          try { assertWindow(task); return active === task } catch { return false }
        } }
        await timed(task, contextTimeoutMs, () => writePolicy(nextPolicy, writeAuthority))
        assertWindow(task)
        const result = { ...(await getStatus()), busy: false }
        if (result.policy !== nextPolicy) throw fault('UNAVAILABLE', 'The spending policy could not be saved.')
        task.window.webContents.send?.(CHANNELS.changed, result)
        return result
      } catch (error) { return failure(error, task) }
      finally { if (active === task) active = null }
    },
    // The Sound tab's Generate button shows a price, and the click approves it.
    // Only the exact workflows that tab builds qualify; see soundCloudApproval.cjs.
    queuePriced: (event, payload) => handlers.queue(event, payload, PRICED_CLICK),
    queue: async (event, payload, origin) => {
      let task, result
      try {
        authorize(event)
        if (!record(payload) || typeof payload.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(payload.requestId)) throw fault('INVALID_REQUEST', 'A unique managed-generation request ID is required.')
        if (seen.has(payload.requestId)) throw fault('DUPLICATE_REQUEST', 'This generation request was already attempted. Inspect its result before preparing a new request.')
        if (seen.size >= LIMITS.requestIds) throw fault('REQUEST_LIMIT', 'The managed generation request limit was reached for this app session.')
        seen.add(payload.requestId)
        if (Object.keys(payload).some(key => !['requestId', 'endpoint', 'workflow', 'clientId', 'savedWorkflowId', 'batchCount'].includes(key))
          || (payload.batchCount !== undefined && (!Number.isInteger(payload.batchCount)
            || payload.batchCount < BATCH_LIMITS.min || payload.batchCount > BATCH_LIMITS.max))
          || (payload.savedWorkflowId !== undefined && (typeof payload.savedWorkflowId !== 'string' || payload.savedWorkflowId.length > 200))
          || typeof payload.clientId !== 'string' || !payload.clientId || payload.clientId.length > 128 || /[\u0000-\u001f]/.test(payload.clientId)) {
          throw fault('INVALID_REQUEST', 'Managed generation accepts only a workflow, request ID, client ID and configured endpoint.')
        }
        task = claim(event, 'queue', payload.requestId)
        const { workflow, fingerprint } = cloneGraph(payload.workflow)
        const secrets = graphSecrets(workflow)
        const clientId = payload.clientId; const endpoint = endpointValue(payload.endpoint)
        await initialize(task)
        if (endpoint !== task.endpoint) throw fault('INVALID_ENDPOINT', 'The requested connection no longer matches the configured ComfyUI connection.')
        let objectInfo = null
        try {
          await recheck(task)
          const metadataController = new AbortController()
          const relayAbort = () => metadataController.abort(task.controller.signal.reason)
          task.controller.signal.addEventListener('abort', relayAbort, { once: true })
          if (task.controller.signal.aborted) relayAbort()
          const timer = setTimeout(() => metadataController.abort('timeout'), metadataTimeoutMs)
          try {
            objectInfo = await abortable(async () => {
              const response = await abortable(() => fetchImpl(`${task.endpoint}/object_info`, { method: 'GET', redirect: 'error', signal: metadataController.signal }), metadataController.signal)
              if (!response.ok) {
                try { Promise.resolve(response.body?.cancel?.()).catch(() => {}) } catch { /* Best effort. */ }
                return null
              }
              const parsed = JSON.parse(await boundedText(response, LIMITS.metadataBytes, metadataController.signal))
              return record(parsed) ? parsed : null
            }, metadataController.signal)
          } finally {
            clearTimeout(timer)
            task.controller.signal.removeEventListener('abort', relayAbort)
          }
        } catch { /* Missing or invalid metadata cannot establish that execution is local. */ }
        await recheck(task)
        let assessment = freezeJson(classifyGenerationGraph(workflow, objectInfo))
        let localTrust = { eligible: false, reason: 'Save this workflow to My Workflows to remember a local-workflow choice.' }
        if (assessment.risk === 'unknown' && localWorkflowTrust && typeof resolveSavedWorkflow === 'function' && payload.savedWorkflowId) {
          const saved = await timed(task, contextTimeoutMs, () => resolveSavedWorkflow({ workflowId: payload.savedWorkflowId }))
          localTrust = localTrustCandidate({ saved, workflow, endpoint: task.endpoint, objectInfo })
        }
        async function recheckSavedTrust() {
          if (!localTrust.eligible) return
          const saved = await timed(task, contextTimeoutMs, () => resolveSavedWorkflow({ workflowId: payload.savedWorkflowId }))
          const current = localTrustCandidate({ saved, workflow, endpoint: task.endpoint, objectInfo })
          if (!current.eligible || current.id !== localTrust.id) throw fault('STALE_CONTEXT', 'The saved workflow changed. Review a new generation request before trusting or running it.')
        }
        let trustedLocal = assessment.risk === 'unknown' && localTrust.eligible
          && await timed(task, contextTimeoutMs, () => localWorkflowTrust.has(localTrust))
        let local = assessment?.risk === 'local' || trustedLocal
        // Local only can review a saved, unfamiliar workflow without enabling
        // cloud spending. Only an explicit native trust decision can proceed;
        // ordinary approve-once is never sufficient in this mode.
        if (!local && task.policy !== 'ask-cloud' && !(assessment.risk === 'unknown' && localTrust.eligible)) {
          const reason = assessment.risk === 'unknown'
            ? `Velorn could not verify these nodes as local: ${[...new Set(assessment.unknownNodes.map(node => node.classType))].join(', ') || 'Unidentified nodes'}. Unrecognized does not mean paid. ${localTrust.reason} Then request the saved workflow again to review it, or choose Ask before cloud in Generation spending for one-submission approval.`
            : 'Local only blocks workflows with cloud/API or pricing evidence. Choose Ask before cloud in Generation spending to review a submission; no spending is approved by changing that setting.'
          throw fault('LOCAL_ONLY', reason)
        }
        const priced = !local && origin === PRICED_CLICK && assessment.risk === 'paid' && task.policy === 'ask-cloud' ? soundCloudApproval(workflow) : null
        if (priced) assessment = freezeJson({ ...assessment, buttonApproved: true, approvedLabel: priced.label, maxUsd: priced.maxUsd })
        const shape = !local && !priced && task.policy === 'ask-cloud' ? batchShape(workflow, assessment) : null
        const grant = batchGrant
        const covered = Boolean(shape && grant && grant.shape === shape && grant.remaining > 0
          && grant.context === task.context && grant.endpoint === task.endpoint && Date.now() < grant.expiresAt)
        if (covered) {
          grant.remaining -= 1
          if (grant.remaining <= 0) batchGrant = null
          assessment = freezeJson({ ...assessment, batchApproved: true })
        }
        if (!local && !priced && !covered) {
          const batchCount = shape && payload.batchCount ? payload.batchCount : 0
          if (typeof confirmSpend !== 'function') throw fault('UNAVAILABLE', 'Native spending confirmation is unavailable. Restart Velorn.')
          const confirmed = await confirmSpend({ window: task.window, assessment, endpoint: task.endpoint, fingerprint, submissionCount: 1, batchCount,
            localTrust, policy: task.policy, signal: task.controller.signal })
          await recheck(task)
          if (assessment.risk === 'unknown' && localTrust.eligible && record(confirmed) && Object.keys(confirmed).length === 2
            && confirmed.approved === true && confirmed.trustLocal === true) {
            await recheckSavedTrust()
            await timed(task, contextTimeoutMs, () => localWorkflowTrust.remember(localTrust, writeAuthority(task)))
            trustedLocal = true
            local = true
            task.window.webContents.send?.(CHANNELS.changed, await getStatus())
          } else if (batchCount && task.policy === 'ask-cloud' && record(confirmed) && Object.keys(confirmed).length === 2
            && confirmed.approved === true && confirmed.batchCount === batchCount) {
            // This submission is the first of the approved number.
            batchGrant = batchCount > 1 ? { shape, remaining: batchCount - 1, context: task.context,
              endpoint: task.endpoint, expiresAt: Date.now() + BATCH_LIMITS.milliseconds } : null
            assessment = freezeJson({ ...assessment, batchApproved: true })
          } else if (confirmed !== true || task.policy !== 'ask-cloud') throw (batchGrant = null, fault)('DENIED', task.policy !== 'ask-cloud'
            ? 'Nothing was submitted. Local only remains on; this saved workflow needs an explicit Trust as local and run choice.'
            : 'This workflow submission was not approved.')
        }
        await recheck(task)
        if (trustedLocal) {
          await recheckSavedTrust()
          assessment = freezeJson({ ...assessment, userTrustedLocal: true, localTrustReference: localTrust.reference,
            note: 'User-trusted local workflow. This is a remembered user choice, not verification that custom nodes never contact external services.' })
        }
        let apiKey = null
        if (!local && typeof getApiKey === 'function') {
          apiKey = await timed(task, contextTimeoutMs, () => getApiKey())
          if (apiKey != null && typeof apiKey !== 'string') throw fault('UNAVAILABLE', 'The cloud account credential is unavailable.')
          if (apiKey) secrets.add(apiKey)
        }
        await acquireGenerationResources(task)
        await recordBeforeSubmit(task, { requestId: task.requestId, workflow, fingerprint, endpoint: task.endpoint,
          clientId, context: task.context, assessment })
        const requestBody = JSON.stringify({ prompt: workflow, client_id: clientId,
          ...(apiKey ? { extra_data: { api_key_comfy_org: apiKey } } : {}) })
        await recheck(task)
        if (trustedLocal) await recheckSavedTrust()
        result = await timed(task, submissionTimeoutMs, async () => {
          const response = await abortable(() => {
            // The final export/window checks and this one fetch invocation run
            // together without an intervening await. Native assertAvailable must
            // be synchronous here; async context/settings checks happened above.
            assertWindow(task)
            const availability = assertAvailable()
            if (availability && typeof availability.then === 'function') {
              Promise.resolve(availability).catch(() => {})
              throw fault('UNAVAILABLE', 'The native generation availability check is not ready.')
            }
            task.postStarted = true
            return fetchImpl(`${task.endpoint}/prompt`, { method: 'POST', redirect: 'error',
              headers: { 'Content-Type': 'application/json' }, body: requestBody, signal: task.controller.signal })
          }, task.controller.signal)
          const text = await boundedText(response, LIMITS.responseBytes, task.controller.signal)
          let body
          try { body = JSON.parse(text) } catch { body = text }
          return { success: true, status: response.status, ok: response.ok, body: publicBody(body, secrets) }
        })
        return result
      } catch (error) {
        result = failure(error, task)
        return result
      }
      finally {
        await finishGenerationResources(task, result)
        await recordAfterSubmit(task, result)
        if (active === task) active = null
      }
    },
    cancel: async (event, payload) => {
      try {
        const window = authorize(event)
        if (!record(payload) || Object.keys(payload).length !== 1 || typeof payload.requestId !== 'string') throw fault('INVALID_REQUEST', 'Choose the pending managed-generation request to cancel.')
        if (!active || active.kind !== 'queue' || active.requestId !== payload.requestId || active.window !== window) return { success: true, cancelled: false }
        const uncertain = active.postStarted
        active.controller.abort('cancelled')
        return { success: true, cancelled: true, submissionState: uncertain ? 'unknown' : 'not-started', serviceJobCancelled: false }
      } catch (error) { return failure(error) }
    },
  }
  for (const [key, handler] of Object.entries(handlers)) ipcMain.handle(CHANNELS[key], (event, payload) => handler(event, payload))
  return { getStatus,
    // Native-only: the authenticated phone Full access consent already includes
    // this policy choice. It does not authorize any individual paid generation.
    async enableAskCloudFromConsent({ window, isCurrent } = {}) {
      let task
      try {
        if (!window || window !== getMainWindow() || isCurrent?.() !== true) throw fault('UNAUTHORIZED', 'The Full access confirmation is no longer current.')
        task = claim({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, 'policy')
        const authority = writeAuthority(task, isCurrent)
        if (!authority.isCurrent()) throw fault('STALE_CONTEXT', 'The Full access confirmation is no longer current.')
        await timed(task, contextTimeoutMs, () => writePolicy('ask-cloud', authority))
        if (!authority.isCurrent()) throw fault('STALE_CONTEXT', 'The Full access confirmation is no longer current.')
        const result = { ...(await getStatus()), busy: false }
        if (result.policy !== 'ask-cloud') throw fault('UNAVAILABLE', 'The spending policy could not be saved.')
        window.webContents.send?.(CHANNELS.changed, result)
        return result
      } catch (error) { return failure(error, task) }
      finally { if (active === task) active = null }
    },
    // Native-only entry point for the Electron main/MCP bridge. It creates the
    // same verified main-frame event shape as renderer IPC, so policy,
    // endpoint, project-context and export checks remain exactly identical.
    async queueFromMain(payload) {
      try {
        const window = getMainWindow()
        if (disposed || !window || window.isDestroyed?.() || !window.webContents || window.webContents.isDestroyed?.()
          || !window.webContents.mainFrame) throw fault('UNAUTHORIZED', 'Managed generation is restricted to the main Velorn window.')
        return await handlers.queue({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, payload)
      } catch (error) { return failure(error) }
    },
    cancelPending(reason = 'cancelled') {
    if (!active || active.kind !== 'queue') return { cancelled: false }
    const submissionState = active.postStarted ? 'unknown' : 'not-started'
    active.controller.abort(reason)
    return { cancelled: true, submissionState, serviceJobCancelled: false }
  }, dispose() {
    disposed = true
    active?.controller.abort('disposed')
    for (const key of Object.keys(handlers)) ipcMain.removeHandler?.(CHANNELS[key])
    for (const [contents, listeners] of bound) for (const [name, listener] of listeners) contents.removeListener?.(name, listener)
    bound.clear()
  } }
}

module.exports = { registerGenerationSpendingIpc, CHANNELS, STATUS_SETTING_KEY, LIMITS }
