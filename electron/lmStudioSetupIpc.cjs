'use strict'

const { AsyncLocalStorage } = require('node:async_hooks')
const { randomUUID } = require('node:crypto')
const path = require('node:path')

const METHODS = Object.freeze(['plan', 'download', 'status', 'cancel', 'load'])
const CHANNELS = Object.freeze({ ...Object.fromEntries(METHODS.map(method => [method, `lm-studio-setup:${method}`])), agentDownloads: 'lm-studio-setup:agent-downloads' })
const CHANGED = 'lm-studio-setup:changed'
const DOWNLOAD_TOOL = 'download_lmstudio_model'
const MAX_JOBS = 32, CONFIRMATION_MS = 5 * 60 * 1000
const JOB_STATES = new Set(['downloading', 'completed', 'failed', 'cancelled', 'loading', 'ready'])
const MUTATIONS = new Set(['plan', 'download', 'load'])
const BACKGROUND = new Set(['download-background', 'load-background', 'load-verification'])
const ownErrors = new WeakSet()
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const cleanText = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value)
const contextTokens = value => Number.isSafeInteger(value) && value > 0 && value <= 1048576
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const failure = (code, error) => ({ success: false, code, error })
function fault(code, message) { const error = Object.assign(new Error(message), { code }); ownErrors.add(error); return error }
function validPayload(method, payload) {
  if (method === 'plan') return exact(payload, ['repository', 'filename'])
    && typeof payload.repository === 'string' && payload.repository.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(payload.repository)
    && typeof payload.filename === 'string' && payload.filename.length <= 180 && /^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/i.test(payload.filename)
    && !payload.filename.includes('..')
  const key = method === 'download' ? 'planId' : 'jobId'
  return METHODS.includes(method) && exact(payload, [key]) && id(payload[key])
}
function validChatQuery(payload) {
  return exact(payload, ['projectPath', 'chatId']) && id(payload.chatId)
    && cleanText(payload.projectPath, 4096) && path.isAbsolute(payload.projectPath)
}
function publicJob(value, expectedId) {
  if (!object(value) || value.success !== true || !id(value.jobId) || expectedId && value.jobId !== expectedId
    || !JOB_STATES.has(value.state) || !cleanText(value.modelName, 256)
    || value.state === 'ready' && value.connectionVerified !== true
    || !Number.isSafeInteger(value.bytesReceived) || value.bytesReceived < 0
    || value.totalBytes !== null && (!Number.isSafeInteger(value.totalBytes) || value.totalBytes <= 0 || value.bytesReceived > value.totalBytes)) return null
  const job = { success: true, jobId: value.jobId, state: value.state, modelName: value.modelName,
    bytesReceived: value.bytesReceived, totalBytes: value.totalBytes, canLoad: value.state === 'completed' && value.canLoad === true,
    connectionVerified: value.state === 'ready' && value.connectionVerified === true }
  if (object(value.error) && cleanText(value.error.code, 100) && cleanText(value.error.message, 700)) job.error = { code: value.error.code, message: value.error.message }
  if (cleanText(value.warning, 700)) job.warning = value.warning
  for (const key of ['contextTargetTokens', 'requestedContextTokens', 'modelMaxContextTokens', 'effectiveContextTokens']) {
    if (contextTokens(value[key])) job[key] = value[key]
  }
  job.contextVerified = value.contextVerified === true && job.connectionVerified
    && contextTokens(job.contextTargetTokens) && contextTokens(job.requestedContextTokens)
    && contextTokens(job.modelMaxContextTokens) && contextTokens(job.effectiveContextTokens)
    && job.requestedContextTokens === Math.min(job.contextTargetTokens, job.modelMaxContextTokens)
    && job.effectiveContextTokens >= job.requestedContextTokens && job.effectiveContextTokens <= job.modelMaxContextTokens
  return job
}

/** Main-document authority for separately approved model transfer and loading. */
function createLmStudioSetupController({ ipcMain, app, getMainWindow, dialog,
  isExportBusy = () => false, getAgentScope = () => null, assertAgentCurrent = async () => {}, createManager,
  runtime, confirmationMs = CONFIRMATION_MS } = {}) {
  if (!Number.isSafeInteger(confirmationMs) || confirmationMs < 1 || confirmationMs > CONFIRMATION_MS) throw new TypeError('Invalid model confirmation deadline.')
  let disposed = false, document = null, confirming = null, manager
  const owners = new Map(), calls = new AsyncLocalStorage()
  const managerFactory = createManager || require('./lmStudioModelSetup.cjs').createLmStudioModelSetup

  function documentCurrent(record) {
    return !disposed && record?.valid === true && getMainWindow() === record.window && !record.window.isDestroyed()
      && !record.contents.isDestroyed() && record.window.webContents === record.contents && record.contents.mainFrame === record.frame
  }
  function invalidate(record) {
    if (!record?.valid) return
    record.valid = false; record.abort.abort()
    for (const [target, name, listener] of record.listeners) target.removeListener?.(name, listener)
    record.listeners = []; record.jobs.clear()
    for (const owner of Object.values(record.owners)) {
      owners.delete(owner)
      try { Promise.resolve(manager?.cancelOwner?.(owner)).catch(() => {}) } catch {}
    }
    if (document === record) document = null
  }
  function currentDocument(event, source) {
    const window = getMainWindow(), contents = window?.webContents, frame = contents?.mainFrame
    if (disposed || !window || window.isDestroyed() || !contents || contents.isDestroyed() || !frame
      || source === 'desktop' && (event?.sender !== contents || event?.senderFrame !== frame)) {
      throw fault('LM_STUDIO_SETUP_UNAUTHORIZED', 'Model setup is available only in the main Velorn desktop window.')
    }
    if (document && !documentCurrent(document)) invalidate(document)
    if (!document) {
      const record = document = { window, contents, frame, valid: true, abort: new AbortController(), listeners: [], jobs: new Map(),
        owners: { desktop: randomUUID(), mcp: randomUUID() } }
      for (const [sourceName, owner] of Object.entries(record.owners)) owners.set(owner, { record, source: sourceName })
      const listen = (target, name, listener) => { target.on?.(name, listener); record.listeners.push([target, name, listener]) }
      listen(contents, 'did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) invalidate(record) })
      listen(contents, 'render-process-gone', () => invalidate(record)); listen(contents, 'destroyed', () => invalidate(record))
      listen(window, 'closed', () => invalidate(record))
    }
    return document
  }
  function changed(record) { if (documentCurrent(record)) { try { record.contents.send(CHANGED) } catch {} } }
  function contextFor(owner) {
    const context = calls.getStore(), binding = owners.get(owner)
    if (!context || context.owner !== owner || !binding || binding.record !== context.record || !documentCurrent(binding.record)) {
      throw fault('LM_STUDIO_SETUP_CONTEXT_CHANGED', 'The Velorn window changed. Reopen model setup before continuing.')
    }
    return context
  }
  async function assertCanStart({ owner, action }) {
    const context = contextFor(owner)
    if (action === 'status' || action === 'cancel') return
    if (!MUTATIONS.has(action) && !BACKGROUND.has(action)) throw fault('LM_STUDIO_SETUP_INVALID_REQUEST', 'The model setup action is unsupported.')
    if (await isExportBusy()) throw fault('LM_STUDIO_SETUP_EXPORT_BUSY', 'Wait for export to finish before starting model setup.')
    contextFor(owner)
    // The initial operation and its native confirmation require a current turn.
    // Once approved, its owned background work can outlive that turn; document
    // invalidation/export still revoke it, including load integrity checks.
    if (!BACKGROUND.has(action) && context.source === 'mcp' && context.agentScope) {
      if (context.agentScope.signal?.aborted) throw fault('LM_STUDIO_SETUP_CANCELLED', 'The agent request was cancelled. No new model setup action was started.')
      await assertAgentCurrent(context.agentScope)
      if (context.agentScope.signal?.aborted) throw fault('LM_STUDIO_SETUP_CANCELLED', 'The agent request was cancelled. No new model setup action was started.')
      contextFor(owner)
      if (await isExportBusy()) throw fault('LM_STUDIO_SETUP_EXPORT_BUSY', 'Wait for export to finish before starting model setup.')
      contextFor(owner)
    }
  }
  function assertCanCommit({ owner, action }) {
    contextFor(owner)
    if (!['download-commit', 'load-commit'].includes(action)) throw fault('LM_STUDIO_SETUP_INVALID_REQUEST', 'The model commit action is unsupported.')
    const busy = isExportBusy()
    contextFor(owner)
    // This guard runs after the final awaited filesystem inspection. Do not
    // introduce another await before the owned link or fixed local load request.
    if (typeof busy !== 'boolean') {
      // A mistaken async hook must fail closed without an unhandled rejection.
      if (busy instanceof Promise) busy.catch(() => {})
      throw fault('LM_STUDIO_SETUP_UNAVAILABLE', 'Current export activity could not be confirmed. Reopen model setup before continuing.')
    }
    if (busy) throw fault('LM_STUDIO_SETUP_EXPORT_BUSY', 'Wait for export to finish before starting model setup.')
  }
  async function confirm({ owner, action, ...review } = {}) {
    if (!['download', 'load'].includes(action) || !object(review) || !cleanText(review.modelName, 256)
      || !cleanText(review.repository, 193) || !cleanText(review.filename, 200) || !cleanText(review.revision, 100)
      || !object(review.license) || !cleanText(review.license.name, 300) || !cleanText(review.license.url, 4096)
      || !cleanText(review.destination, 4096) || !path.isAbsolute(review.destination)
      || !Number.isSafeInteger(review.bytes) || review.bytes <= 0 || !cleanText(review.sourceUrl, 4096)
      || action === 'load' && (review.contextTargetTokens !== 32768 || review.contextPolicy !== 'model-capped')) {
      throw fault('LM_STUDIO_SETUP_INVALID_REVIEW', 'The model review is incomplete. Request a fresh setup plan.')
    }
    let url
    try { url = new URL(review.sourceUrl) } catch { throw fault('LM_STUDIO_SETUP_INVALID_REVIEW', 'The model source is invalid.') }
    if (url.protocol !== 'https:' || url.hostname !== 'huggingface.co' || url.port || url.username || url.password || url.search || url.hash) throw fault('LM_STUDIO_SETUP_INVALID_REVIEW', 'Use an exact public Hugging Face model source.')
    await assertCanStart({ owner, action })
    if (confirming) throw fault('LM_STUDIO_SETUP_BUSY', 'Finish the current model review before starting another one.')
    if (typeof dialog?.showMessageBox !== 'function') throw fault('LM_STUDIO_SETUP_UNAVAILABLE', 'Native model confirmation is unavailable. Restart Velorn.')
    const context = contextFor(owner), record = context.record, token = {}, controller = new AbortController()
    confirming = token
    let timer, rejectAbort
    const aborted = new Promise((_resolve, reject) => { rejectAbort = reject })
    const abort = () => { controller.abort(); rejectAbort(fault('LM_STUDIO_SETUP_CANCELLED', 'The model setup confirmation is no longer active.')) }
    record.abort.signal.addEventListener('abort', abort, { once: true })
    context.agentScope?.signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => { controller.abort(); rejectAbort(fault('LM_STUDIO_SETUP_CONFIRMATION_EXPIRED', 'Model setup confirmation expired. Request it again when ready.')) }, confirmationMs)
    const loading = action === 'load'
    try {
      if (record.abort.signal.aborted || context.agentScope?.signal?.aborted) { abort(); await aborted }
      try { context.agentScope?.onWaiting?.(true) } catch {}
      const answer = await Promise.race([aborted, dialog.showMessageBox(record.window, {
        type: 'question', title: 'Velorn local model setup', signal: controller.signal,
        message: `${loading ? 'Load' : 'Download'} ${review.modelName}?`,
        detail: `Model: ${review.repository}\nFile: ${review.filename}\nRevision: ${review.revision}\nLicense: ${review.license.name}\nLicense information: ${review.license.url}\nSource: ${review.sourceUrl}\n\nSize: ${review.bytes.toLocaleString('en-US')} bytes\nDestination: ${review.destination}\n\n${loading
          ? `Context Length: up to ${review.contextTargetTokens.toLocaleString('en-US')} tokens, capped by the model's reported maximum. Larger context uses more RAM/GPU memory; fitting in memory is not guaranteed. Loading may start the installed LM Studio local server on loopback only. Existing authentication stays enabled. This does not send a prompt, switch your Velorn agent/model, or unload/reload an already loaded model.`
          : 'This downloads only the reviewed model weights. Loading uses additional RAM/GPU memory and needs separate approval. This does not select an agent, send a prompt, install code, or purchase credits.'}`,
        buttons: ['Cancel', loading ? 'Load model' : 'Download model'], defaultId: 0, cancelId: 0, noLink: true,
      })])
      await assertCanStart({ owner, action })
      if (controller.signal.aborted || answer?.response !== 1) return false
      if (action === 'download') context.downloadApproved = true
      return true
    } finally {
      clearTimeout(timer); controller.abort()
      record.abort.signal.removeEventListener('abort', abort); context.agentScope?.signal?.removeEventListener('abort', abort)
      try { context.agentScope?.onWaiting?.(false) } catch {}
      if (confirming === token) confirming = null
    }
  }
  manager = managerFactory({ confirm, assertCanStart, assertCanCommit, runtime })
  for (const method of [...METHODS, 'cancelOwner', 'dispose']) if (typeof manager?.[method] !== 'function') throw new TypeError(`LM Studio model setup manager is missing ${method}.`)

  async function invoke(source, method, payload, event) {
    try {
      const record = currentDocument(event, source)
      if (!validPayload(method, payload)) return failure('LM_STUDIO_SETUP_INVALID_REQUEST', 'Provide only the exact model or native setup ID required by this action.')
      const delegated = source === 'desktop' && ['status', 'cancel', 'load'].includes(method) ? record.jobs.get(payload.jobId) : null
      const owner = delegated?.origin ? record.owners.mcp : record.owners[source]
      const agentScope = source === 'mcp' && MUTATIONS.has(method) ? getAgentScope() : null
      const context = { owner, record, source, agentScope, downloadApproved: false }
      return await calls.run(context, async () => {
        if (MUTATIONS.has(method)) await assertCanStart({ owner, action: method })
        // A user need not keep the original chat open for its terminal jobs to
        // become prunable. Never start a transfer we cannot retain/reattach.
        if (method === 'download' && source === 'mcp' && record.jobs.size >= MAX_JOBS) {
          for (const [jobId, entry] of record.jobs) {
            const current = await manager.status({ jobId }, owner)
            contextFor(owner)
            const snapshot = publicJob(current, jobId)
            if (current?.success === false && current.code === 'UNKNOWN_JOB' || snapshot && !['downloading', 'loading'].includes(snapshot.state)) {
              record.jobs.delete(jobId)
              if (record.jobs.size < MAX_JOBS) break
            } else if (snapshot) entry.job = snapshot
          }
          if (record.jobs.size >= MAX_JOBS) throw fault('LM_STUDIO_SETUP_JOB_LIMIT', 'Finish or cancel an existing model setup job before starting another.')
        }
        const result = await manager[method](payload, owner)
        contextFor(owner)
        if (method === 'download' && context.downloadApproved) {
          const job = publicJob(result)
          if (job) {
            if (source === 'mcp') {
              while (record.jobs.size >= MAX_JOBS) {
                const obsolete = [...record.jobs].find(([, entry]) => !['downloading', 'loading'].includes(entry.job.state))
                if (!obsolete) break
                record.jobs.delete(obsolete[0])
              }
              record.jobs.set(job.jobId, { job, origin: null })
            }
            return { ...result, downloadApproved: true, background: true,
              message: 'Model download approved. Transfer continues in the background. Downloaded is not loaded or tested; loading needs separate confirmation.' }
          }
        }
        const tracked = record.jobs.get(payload.jobId)
        if (tracked && owner === record.owners.mcp) {
          const job = publicJob(result, payload.jobId)
          if (job) tracked.job = job
          if (['cancel', 'load'].includes(method)) changed(record)
        }
        return result
      })
    } catch (error) { return ownErrors.has(error) ? failure(error.code, error.message) : failure('LM_STUDIO_SETUP_FAILED', 'Local model setup could not finish. Check its status before retrying.') }
  }
  function associateAgentResult(name, result, origin, projectPath) {
    const record = document
    if (name !== DOWNLOAD_TOOL || !documentCurrent(record) || result?.isError || !validChatQuery({ projectPath, chatId: origin?.chatId })
      || !id(origin?.turnId) || !Array.isArray(result?.content) || result.content.length > 8) return false
    const blocks = result.content.filter(block => block?.type === 'text')
    if (blocks.length !== 1 || typeof blocks[0].text !== 'string' || blocks[0].text.length > 8192) return false
    let value
    try { value = JSON.parse(blocks[0].text) } catch { return false }
    if (!object(value) || value.success === false || value.previewOnly === true) return false
    value = value.result || value
    const job = publicJob(value), tracked = job && record.jobs.get(job.jobId)
    if (!job || value.downloadApproved !== true || value.background !== true || !tracked || tracked.origin
      || tracked.job.modelName !== job.modelName || tracked.job.totalBytes !== job.totalBytes) return false
    tracked.origin = { projectPath, chatId: origin.chatId, turnId: origin.turnId }
    changed(record); return true
  }
  async function agentDownloads(event, payload) {
    try {
      const record = currentDocument(event, 'desktop')
      if (!validChatQuery(payload)) return failure('LM_STUDIO_SETUP_INVALID_REQUEST', 'Provide only the current project and chat for model progress.')
      const owner = record.owners.mcp
      return await calls.run({ owner, record, source: 'desktop', agentScope: null }, async () => {
        const jobs = []
        for (const [jobId, entry] of [...record.jobs].slice(-MAX_JOBS)) {
          if (entry.origin?.projectPath !== payload.projectPath || entry.origin.chatId !== payload.chatId) continue
          const result = await manager.status({ jobId }, owner)
          contextFor(owner)
          if (record.jobs.get(jobId) !== entry) continue
          if (result?.success === false && result.code === 'UNKNOWN_JOB') { record.jobs.delete(jobId); continue }
          const job = publicJob(result, jobId)
          if (!job) return failure('LM_STUDIO_SETUP_PROGRESS_UNAVAILABLE', 'Model progress could not be verified. The job may still be running; no automatic retry was started.')
          entry.job = job; jobs.push({ ...job, turnId: entry.origin.turnId })
        }
        return { success: true, jobs }
      })
    } catch (error) { return ownErrors.has(error) ? failure(error.code, error.message) : failure('LM_STUDIO_SETUP_PROGRESS_UNAVAILABLE', 'Model progress could not be checked in this desktop session.') }
  }
  const api = Object.fromEntries(METHODS.map(method => [method, payload => invoke('mcp', method, payload)]))
  for (const method of METHODS) ipcMain.handle(CHANNELS[method], (event, payload) => invoke('desktop', method, payload, event))
  ipcMain.handle(CHANNELS.agentDownloads, agentDownloads)
  function dispose() {
    if (disposed) return
    invalidate(document); disposed = true
    for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler?.(channel)
    app?.removeListener?.('will-quit', dispose)
    try { Promise.resolve(manager.dispose()).catch(() => {}) } catch {}
  }
  app?.on?.('will-quit', dispose)
  return { api, associateAgentResult, dispose }
}

module.exports = { createLmStudioSetupController, CHANNELS, CHANGED, CONFIRMATION_MS }
