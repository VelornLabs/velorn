import { formatInstallerBytes } from './agentSetupDownloads.mjs'

const states = new Set(['downloading', 'completed', 'failed', 'cancelled', 'loading', 'ready'])
const activeStates = new Set(['downloading', 'loading'])
const progressError = 'LM Studio model progress could not be refreshed. The operation may still be running.'
const text = (value, fallback = '') => typeof value === 'string' && value.trim()
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 700) : fallback
const errorText = (value, fallback) => text(typeof value === 'string' ? value : value?.message, fallback)
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const validJobId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const amount = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null
// Same bounded protocol metadata as the native model setup manager. This is
// not a renderer-selected context size or a fallback for older receipts.
const contextTokens = value => Number.isSafeInteger(value) && value > 0 && value <= 1048576 ? value : null

function contextInfo(item) {
  const contextTargetTokens = contextTokens(item.contextTargetTokens), requestedContextTokens = contextTokens(item.requestedContextTokens)
  const modelMaxContextTokens = contextTokens(item.modelMaxContextTokens), effectiveContextTokens = contextTokens(item.effectiveContextTokens)
  return { contextTargetTokens, requestedContextTokens, modelMaxContextTokens, effectiveContextTokens,
    contextVerified: item.state === 'ready' && item.connectionVerified === true && item.contextVerified === true
      && contextTargetTokens !== null && requestedContextTokens !== null && modelMaxContextTokens !== null && effectiveContextTokens !== null
      && requestedContextTokens === Math.min(contextTargetTokens, modelMaxContextTokens)
      && effectiveContextTokens >= requestedContextTokens && effectiveContextTokens <= modelMaxContextTokens }
}

export { formatInstallerBytes as formatModelBytes }

export function parseAgentLmStudioSetup(result) {
  if (result?.success !== true || !Array.isArray(result.jobs) || result.jobs.length > 32) throw new Error(errorText(result?.error, progressError))
  const seen = new Set()
  return result.jobs.map(job => {
    if (!job || !validJobId(job.jobId) || !validId(job.turnId) || !states.has(job.state) || seen.has(job.jobId)) throw new Error(progressError)
    seen.add(job.jobId)
    return { jobId: job.jobId, turnId: job.turnId, state: job.state,
      modelName: text(job.modelName, 'LM Studio model').slice(0, 200),
      bytesReceived: amount(job.bytesReceived), totalBytes: amount(job.totalBytes),
      canLoad: job.state === 'completed' && job.canLoad === true,
      connectionVerified: job.state === 'ready' && job.connectionVerified === true,
      ...contextInfo(job),
      error: errorText(job.error, ''), warning: errorText(job.warning, '') }
  })
}

export function lmStudioSetupPresentation(item) {
  const received = amount(item.bytesReceived), total = amount(item.totalBytes)
  const percent = total > 0 && received !== null ? Math.min(100, Math.floor(received / total * 100)) : null
  const verifying = item.state === 'downloading' && percent === 100
  const context = contextInfo(item), target = context.contextTargetTokens
  const contextHint = item.state === 'completed' && item.canLoad === true && target !== null
    ? `Load target: up to ${target.toLocaleString('en-US')} tokens, limited by the model. Larger context uses more RAM.`
    : context.contextVerified ? `Verified context: ${context.effectiveContextTokens.toLocaleString('en-US')} tokens.` : ''
  return { received, total, percent, verifying, contextHint,
    label: item.state === 'downloading' ? (verifying ? 'Finishing model download…' : 'Downloading model…')
      : item.state === 'completed' ? (item.error ? 'Model downloaded — load not verified' : 'Model downloaded — not loaded')
        : item.state === 'loading' ? 'Loading model and checking connection…'
          : item.state === 'ready' ? (item.connectionVerified === true ? 'Model loaded · local server available' : 'Model status needs verification')
            : item.state === 'cancelled' ? 'Model download cancelled' : 'Model setup failed' }
}

/** Observes native-owned session jobs only. No download, model choice or inference on mount. */
export function createAgentLmStudioSetupTracker({ api, projectPath, chatId, pollMs = 1000,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let state = { items: [], error: '', hasTrackedJobs: false, pendingById: {}, actionErrors: {} }
  const listeners = new Set(), actions = new Map()
  let active = false, epoch = 0, inFlight = null, queued = false, timer = null, unsubscribe = null
  const emit = patch => { state = { ...state, ...patch }; for (const listener of listeners) listener() }
  const current = token => active && epoch === token
  const clearPoll = () => { if (timer !== null) clearTimer(timer); timer = null }
  const supported = () => validId(chatId) && typeof projectPath === 'string' && projectPath.length > 0 && typeof api?.agentDownloads === 'function'
  const schedule = () => {
    clearPoll()
    if (active && state.items.some(job => activeStates.has(job.state))) timer = setTimer(() => { timer = null; void refresh() }, pollMs)
  }
  function refresh() {
    if (!active || !supported()) return Promise.resolve()
    clearPoll()
    if (inFlight) { queued = true; return inFlight.promise }
    const token = epoch, request = {}
    inFlight = request
    request.promise = Promise.resolve().then(() => api.agentDownloads({ projectPath, chatId })).then(result => {
      if (!current(token)) return
      const items = parseAgentLmStudioSetup(result)
      emit({ items, error: '', hasTrackedJobs: state.hasTrackedJobs || items.length > 0 })
    }).catch(error => {
      if (current(token)) emit({ error: errorText(error, progressError) })
    }).finally(() => {
      if (inFlight !== request) return
      inFlight = null
      if (!active) return
      if (queued) { queued = false; void refresh() }
      else schedule()
    })
    return request.promise
  }
  async function act(method, jobId) {
    const item = state.items.find(job => job.jobId === jobId)
    if (!active || !item || actions.has(jobId) || method === 'cancel' && item.state !== 'downloading'
      || method === 'load' && !item.canLoad) return
    const token = epoch, operation = {}
    actions.set(jobId, operation)
    emit({ pendingById: { ...state.pendingById, [jobId]: method }, actionErrors: { ...state.actionErrors, [jobId]: '' } })
    try {
      if (typeof api?.[method] !== 'function') throw new Error('Reopen the latest Velorn build to manage this model setup.')
      const result = await api[method]({ jobId })
      if (!current(token)) return
      if (result?.success !== true || result.jobId && result.jobId !== jobId) throw new Error(errorText(result?.error,
        method === 'load' ? 'Loading could not be confirmed. Check LM Studio; no automatic retry was started.'
          : 'Cancellation could not be confirmed. Check the model download’s progress.'))
      // Only the next authoritative list can say loading/ready; a successful
      // request receipt alone never proves model identity, load or connection.
    } catch (error) {
      if (current(token)) emit({ actionErrors: { ...state.actionErrors, [jobId]: errorText(error, 'The model setup action could not finish.') } })
    } finally {
      if (actions.get(jobId) === operation) actions.delete(jobId)
      if (current(token)) {
        const pendingById = { ...state.pendingById }; delete pendingById[jobId]
        emit({ pendingById }); await refresh()
      }
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    start() {
      if (active) return
      active = true; epoch += 1
      if (!supported()) return
      if (typeof api.onChanged === 'function') {
        try { unsubscribe = api.onChanged(() => { void refresh() }) } catch { /* Local cached polling remains available. */ }
      }
      void refresh()
    },
    dispose() {
      active = false; epoch += 1; queued = false; clearPoll()
      try { if (typeof unsubscribe === 'function') unsubscribe() } catch { /* Never perform a native action on teardown. */ }
      unsubscribe = null; actions.clear(); state = { ...state, pendingById: {} }
    },
    refresh, cancel: jobId => act('cancel', jobId), load: jobId => act('load', jobId),
  }
}
