const JOB_STATES = new Set(['downloading', 'completed', 'failed', 'cancelled'])
const INTEGRATIONS = new Set(['comfyui', 'lmstudio'])
const progressError = 'Download progress could not be refreshed. The last known state is shown; the download may still be running.'
const cleanText = (value, fallback = '') => typeof value === 'string' && value.trim() ? value.slice(0, 700) : fallback
const errorText = (value, fallback) => cleanText(typeof value === 'string' ? value : value?.message, fallback)
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const validJobId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const amount = value => Number.isFinite(value) && value >= 0 ? value : null

export function parseAgentSetupDownloads(result) {
  if (result?.success !== true || !Array.isArray(result.jobs) || result.jobs.length > 32) throw new Error(errorText(result?.error, progressError))
  const seen = new Set()
  return result.jobs.map(job => {
    if (!job || !validJobId(job.jobId) || !validId(job.turnId) || !INTEGRATIONS.has(job.integration)
      || !JOB_STATES.has(job.state) || seen.has(job.jobId)) throw new Error(progressError)
    seen.add(job.jobId)
    return { jobId: job.jobId, turnId: job.turnId, integration: job.integration, state: job.state,
      bytesReceived: amount(job.bytesReceived), totalBytes: amount(job.totalBytes),
      canOpen: job.state === 'completed' && job.canOpen === true, opened: job.opened === true,
      error: errorText(job.error, ''), warning: errorText(job.warning, '') }
  })
}

export function installerDownloadPresentation(item) {
  const received = amount(item.bytesReceived), total = amount(item.totalBytes)
  const knownSize = total !== null && total > 0
  const percent = knownSize && received !== null ? Math.min(100, Math.floor(received / total * 100)) : null
  const verifying = item.state === 'downloading' && percent === 100
  return { name: item.integration === 'comfyui' ? 'ComfyUI' : 'LM Studio', received, total, percent, verifying,
    label: item.state === 'downloading' ? (verifying ? 'Verifying installer…' : 'Downloading installer…')
      : item.state === 'completed' ? (item.opened ? 'Installer opened' : 'Installer downloaded')
        : item.state === 'cancelled' ? 'Download cancelled' : 'Download failed' }
}

export function formatInstallerBytes(value) {
  if (amount(value) === null) return 'Size unknown'
  if (value < 1024) return `${Math.floor(value)} B`
  const unit = value < 1024 ** 2 ? 'KiB' : value < 1024 ** 3 ? 'MiB' : 'GiB'
  const divisor = unit === 'KiB' ? 1024 : unit === 'MiB' ? 1024 ** 2 : 1024 ** 3
  return `${(value / divisor).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`
}

/** Session-only observation of native-owned jobs. Never starts a download. */
export function createAgentSetupDownloadsTracker({ api, projectPath, chatId, pollMs = 1000,
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
    if (active && state.items.some(job => job.state === 'downloading')) {
      timer = setTimer(() => { timer = null; void refresh() }, pollMs)
    }
  }
  function refresh() {
    if (!active || !supported()) return Promise.resolve()
    clearPoll()
    if (inFlight) { queued = true; return inFlight.promise }
    const token = epoch, request = {}
    inFlight = request
    request.promise = Promise.resolve().then(() => api.agentDownloads({ projectPath, chatId })).then(result => {
      if (!current(token)) return
      const items = parseAgentSetupDownloads(result)
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
      || method === 'open' && !item.canOpen) return
    const token = epoch, operation = {}
    actions.set(jobId, operation)
    emit({ pendingById: { ...state.pendingById, [jobId]: method }, actionErrors: { ...state.actionErrors, [jobId]: '' } })
    try {
      if (typeof api?.[method] !== 'function') throw new Error('Reopen the latest Velorn build to manage this installer download.')
      const result = await api[method]({ jobId })
      if (!current(token)) return
      if (result?.success !== true || result.jobId && result.jobId !== jobId) {
        throw new Error(errorText(result?.error, method === 'open' ? 'The installer could not be opened. No automatic retry was started.' : 'Cancellation could not be confirmed. Check the download’s progress.'))
      }
      if (method === 'open' && result.opened !== true) {
        throw new Error(result.cancelled ? 'Opening cancelled. No installer was opened.' : 'Opening the installer could not be confirmed.')
      }
    } catch (error) {
      if (current(token)) emit({ actionErrors: { ...state.actionErrors, [jobId]: errorText(error, 'The setup action could not finish.') } })
    } finally {
      if (actions.get(jobId) === operation) actions.delete(jobId)
      if (current(token)) {
        const pendingById = { ...state.pendingById }; delete pendingById[jobId]
        emit({ pendingById })
        await refresh()
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
        try { unsubscribe = api.onChanged(() => { void refresh() }) }
        catch { /* The bounded local polling path still works without events. */ }
      }
      void refresh()
    },
    dispose() {
      active = false; epoch += 1; queued = false; clearPoll()
      try { if (typeof unsubscribe === 'function') unsubscribe() } catch { /* No native action on teardown. */ }
      unsubscribe = null; actions.clear()
      // React Strict Mode can restart this observer; stale actions never block it.
      state = { ...state, pendingById: {} }
    },
    refresh, cancel: jobId => act('cancel', jobId), open: jobId => act('open', jobId),
  }
}
