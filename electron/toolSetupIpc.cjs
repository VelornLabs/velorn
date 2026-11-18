'use strict'

const { AsyncLocalStorage } = require('node:async_hooks')
const { randomUUID } = require('node:crypto')
const path = require('node:path')

const METHODS = Object.freeze(['plan', 'download', 'status', 'cancel', 'open'])
const CHANNELS = Object.freeze({ ...Object.fromEntries(METHODS.map(method => [method, `tool-setup:${method}`])),
  agentDownloads: 'tool-setup:agent-downloads' })
const CHANGED = 'tool-setup:changed'
const MAX_DOWNLOADS = 32
const JOB_STATES = new Set(['downloading', 'completed', 'failed', 'cancelled'])
const MUTATIONS = new Set(['plan', 'download', 'open'])
const INTEGRATIONS = new Set(['lmstudio', 'comfyui'])
const NAMES = { codex: 'Codex', lmstudio: 'LM Studio', comfyui: 'ComfyUI' }
const ownErrors = new WeakSet()
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const cleanText = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value)
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const failure = (code, error) => ({ success: false, code, error })
function fault(code, message) {
  const error = Object.assign(new Error(message), { code })
  ownErrors.add(error)
  return error
}
function validPayload(method, payload) {
  if (!object(payload)) return false
  const key = method === 'plan' ? 'integration' : method === 'download' ? 'planId' : 'jobId'
  return Object.keys(payload).length === 1 && Object.hasOwn(payload, key)
    && (key === 'integration' ? INTEGRATIONS.has(payload.integration) : id(payload[key]))
}
function validChatQuery(payload) {
  return object(payload) && Object.keys(payload).length === 2 && id(payload.chatId)
    && cleanText(payload.projectPath, 4096) && path.isAbsolute(payload.projectPath)
}
// Native manager output only. Never publish paths, source arguments or a model's
// own claimed receipt as live download authority.
function publicJob(value, expectedId) {
  if (!object(value) || value.success !== true || !id(value.jobId) || expectedId && value.jobId !== expectedId
    || !INTEGRATIONS.has(value.integration) || !JOB_STATES.has(value.state)
    || !Number.isSafeInteger(value.bytesReceived) || value.bytesReceived < 0
    || !Number.isSafeInteger(value.totalBytes) || value.totalBytes <= 0 || value.bytesReceived > value.totalBytes) return null
  const job = { success: true, jobId: value.jobId, integration: value.integration, state: value.state,
    bytesReceived: value.bytesReceived, totalBytes: value.totalBytes, canOpen: value.state === 'completed' && value.canOpen === true }
  if (object(value.error) && cleanText(value.error.code, 100) && cleanText(value.error.message, 700)) {
    job.error = { code: value.error.code, message: value.error.message }
  }
  if (cleanText(value.warning, 700)) job.warning = value.warning
  return job
}

/** Native authority around the fixed installer manager. Never accepts a caller owner, URL or path. */
function createToolSetupController({ ipcMain, app, getMainWindow, dialog, shell, optionalSetup,
  isExportBusy = () => false, getAgentScope = () => null, assertAgentCurrent = async () => {}, createManager } = {}) {
  let disposed = false, document = null, confirming = false
  const owners = new Map()
  const calls = new AsyncLocalStorage()
  const managerFactory = createManager || require('./toolSetupInstaller.cjs').createToolSetupInstaller
  let manager

  function documentCurrent(record) {
    return !disposed && record?.valid === true && getMainWindow() === record.window
      && !record.window.isDestroyed() && !record.contents.isDestroyed()
      && record.window.webContents === record.contents && record.contents.mainFrame === record.frame
  }
  function invalidate(record) {
    if (!record?.valid) return
    record.valid = false
    for (const [target, name, listener] of record.listeners) target.removeListener?.(name, listener)
    record.listeners = []
    record.downloads.clear()
    for (const owner of Object.values(record.owners)) {
      owners.delete(owner)
      try { Promise.resolve(manager?.cancelOwner?.(owner)).catch(() => {}) } catch {}
    }
    if (document === record) document = null
  }
  function currentDocument(event, source) {
    const window = getMainWindow()
    if (disposed || !window || window.isDestroyed() || !window.webContents || window.webContents.isDestroyed()) {
      throw fault('TOOL_SETUP_UNAUTHORIZED', 'Tool setup is available in the main Velorn window.')
    }
    const contents = window.webContents, frame = contents.mainFrame
    if (!frame || source === 'desktop' && (!event?.sender || event.sender !== contents || event.senderFrame !== frame)) {
      throw fault('TOOL_SETUP_UNAUTHORIZED', 'Tool setup is restricted to the main Velorn window, not embedded pages.')
    }
    if (document && !documentCurrent(document)) invalidate(document)
    if (!document) {
      const record = { window, contents, frame, valid: true, listeners: [], downloads: new Map(),
        owners: { desktop: randomUUID(), mcp: randomUUID() } }
      document = record
      for (const [sourceName, owner] of Object.entries(record.owners)) owners.set(owner, { record, source: sourceName })
      const listen = (target, name, listener) => {
        if (typeof target.on !== 'function') return
        target.on(name, listener); record.listeners.push([target, name, listener])
      }
      listen(contents, 'did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) invalidate(record) })
      listen(contents, 'render-process-gone', () => invalidate(record))
      listen(contents, 'destroyed', () => invalidate(record))
      listen(window, 'closed', () => invalidate(record))
    }
    return document
  }
  function changed(record) {
    if (!documentCurrent(record)) return
    // Static invalidation only: no paths, project identity, IDs or job contents.
    try { record.contents.send?.(CHANGED) } catch {}
  }
  function contextFor(owner) {
    const context = calls.getStore(), binding = owners.get(owner)
    if (!context || context.owner !== owner || !binding || binding.record !== context.record || !documentCurrent(binding.record)) {
      throw fault('TOOL_SETUP_CONTEXT_CHANGED', 'The Velorn window changed. Reopen tool setup before continuing.')
    }
    return context
  }
  async function assertCanStart({ owner, action }) {
    const context = contextFor(owner)
    // Progress reads and cancellation must remain usable while export runs.
    if (action === 'status' || action === 'cancel') return
    if (!MUTATIONS.has(action) && !['download-background', 'open-verification'].includes(action)) {
      throw fault('TOOL_SETUP_INVALID_REQUEST', 'The setup action is not supported.')
    }
    if (await isExportBusy()) throw fault('TOOL_SETUP_EXPORT_BUSY', 'Wait for the current export to finish before starting tool setup.')
    contextFor(owner)
    // Approved downloads belong to the setup job, not the lifetime of the
    // agent turn that requested them. Navigation and explicit Cancel still stop them.
    if (action !== 'download-background' && context.source === 'mcp' && context.agentScope) {
      if (context.agentScope.signal?.aborted) throw fault('TOOL_SETUP_CANCELLED', 'The agent setup request was cancelled. No new setup action was started.')
      if (action !== 'open-verification') await assertAgentCurrent(context.agentScope)
      if (context.agentScope.signal?.aborted) throw fault('TOOL_SETUP_CANCELLED', 'The agent setup request was cancelled. No new setup action was started.')
      contextFor(owner)
      if (await isExportBusy()) throw fault('TOOL_SETUP_EXPORT_BUSY', 'Wait for the current export to finish before starting tool setup.')
      contextFor(owner)
    }
  }
  async function confirm({ owner, action, plan, job, destination, sourceUrl, bytes } = {}) {
    if (!['download', 'open'].includes(action) || !cleanText(destination, 4096) || !path.isAbsolute(destination)
      || !cleanText(sourceUrl, 4096) || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw fault('TOOL_SETUP_INVALID_REQUEST', 'The installer review is incomplete. Make a new setup plan.')
    }
    let url
    try { url = new URL(sourceUrl) } catch { throw fault('TOOL_SETUP_INVALID_REQUEST', 'The installer source is invalid. Make a new setup plan.') }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw fault('TOOL_SETUP_INVALID_REQUEST', 'The installer source must be a verified HTTPS download.')
    await assertCanStart({ owner, action })
    if (confirming) throw fault('TOOL_SETUP_BUSY', 'Finish the current installer review before starting another one.')
    if (typeof dialog?.showMessageBox !== 'function') throw fault('TOOL_SETUP_UNAVAILABLE', 'Native installer confirmation is unavailable. Restart Velorn.')
    const context = contextFor(owner)
    const tool = NAMES[plan?.integration || job?.integration] || 'tool'
    const opening = action === 'open'
    confirming = true
    try {
      const answer = await dialog.showMessageBox(context.record.window, {
        type: 'question', title: 'Velorn tool setup',
        message: `${opening ? 'Open' : 'Download'} the ${tool} installer?`,
        detail: `Source: ${sourceUrl}\n\n${opening ? 'Installer' : 'Save to'}: ${destination}\n\nSize: ${bytes.toLocaleString('en-US')} bytes\n\nThis is the application installer only. Operating system installation, dependencies, accounts and model downloads are separate steps. Velorn does not run unattended install commands or bypass operating system security prompts.`,
        buttons: ['Cancel', opening ? 'Open installer' : 'Download installer'], defaultId: 0, cancelId: 0, noLink: true,
      })
      await assertCanStart({ owner, action })
      if (answer?.response !== 1) return false
      if (opening) context.openApprovals.add(destination)
      else context.downloadApproved = true
      return true
    } finally { confirming = false }
  }
  async function openPath(destination, { owner, beforeOpen } = {}) {
    await assertCanStart({ owner, action: 'open' })
    const context = contextFor(owner)
    if (!context.openApprovals.delete(destination)) throw fault('TOOL_SETUP_UNAUTHORIZED', 'Confirm opening this exact installer in Velorn first.')
    if (typeof shell?.openPath !== 'function') throw fault('TOOL_SETUP_UNAVAILABLE', 'Opening installers is unavailable. Restart Velorn.')
    if (typeof beforeOpen !== 'function') throw fault('TOOL_SETUP_UNAVAILABLE', 'Final installer verification is unavailable. Make a new setup plan.')
    // The trusted manager owns this callback; renderer payloads contain only
    // opaque IDs. Run its file/root/hash verification AFTER the last asynchronous
    // authority guard, then hand off without another asynchronous guard gap.
    await beforeOpen()
    const finalContext = contextFor(owner)
    if (finalContext.source === 'mcp' && finalContext.agentScope?.signal?.aborted) {
      throw fault('TOOL_SETUP_CANCELLED', 'The agent setup request was cancelled. No installer was opened.')
    }
    const exporting = isExportBusy()
    if (exporting && typeof exporting.then === 'function') {
      void Promise.resolve(exporting).catch(() => {})
      throw fault('TOOL_SETUP_UNAVAILABLE', 'The final installer safety check is unavailable. No installer was opened.')
    }
    if (exporting) throw fault('TOOL_SETUP_EXPORT_BUSY', 'Wait for the current export to finish before opening the installer.')
    return shell.openPath(destination)
  }
  manager = managerFactory({ confirm, openPath, assertCanStart, optionalSetup, getDownloadsPath: () => app.getPath('downloads') })
  for (const method of [...METHODS, 'cancelOwner', 'dispose']) {
    if (typeof manager?.[method] !== 'function') throw new TypeError(`Tool setup manager is missing ${method}.`)
  }

  async function invoke(source, method, payload, event) {
    try {
      const record = currentDocument(event, source)
      if (!validPayload(method, payload)) return failure('TOOL_SETUP_INVALID_REQUEST', 'Provide only the named tool or native setup ID required for this action.')
      // A desktop click may manage a native-approved agent download from this
      // exact document after its turn ends. This never lends desktop jobs or
      // plans to MCP, nor trusts a source/owner supplied by the renderer.
      const delegated = source === 'desktop' && ['status', 'cancel', 'open'].includes(method)
        ? record.downloads.get(payload.jobId) : null
      const owner = delegated?.origin ? record.owners.mcp : record.owners[source]
      const agentScope = source === 'mcp' && MUTATIONS.has(method) ? getAgentScope() : null
      const context = { owner, record, source, agentScope, openApprovals: new Set(), downloadApproved: false }
      return await calls.run(context, async () => {
        if (MUTATIONS.has(method)) await assertCanStart({ owner, action: method })
        const result = await manager[method](payload, owner)
        contextFor(owner)
        if (method === 'download' && context.downloadApproved) {
          const job = publicJob(result)
          if (job) {
            if (source === 'mcp') {
              while (record.downloads.size >= MAX_DOWNLOADS) {
                const obsolete = [...record.downloads].find(([, entry]) => entry.job.state !== 'downloading')
                record.downloads.delete(obsolete?.[0] || record.downloads.keys().next().value)
              }
              record.downloads.set(job.jobId, { job, origin: null, opened: false })
            }
            return { ...result, downloadApproved: true, background: true,
              message: 'Installer download approved. Transfer continues in the background; the initial byte count may be zero. Live desktop chat progress is shown for connected-agent requests. Completed means downloaded, not installed.' }
          }
        }
        const tracked = record.downloads.get(payload.jobId)
        if (tracked && owner === record.owners.mcp) {
          const job = publicJob(result, payload.jobId)
          if (job) tracked.job = job
          if (result?.success === true && method === 'open' && result.opened === true) tracked.opened = true
          if (result?.success === true && ['cancel', 'open'].includes(method)) changed(record)
        }
        return result
      })
    } catch (error) {
      return ownErrors.has(error) ? failure(error.code, error.message)
        : failure('TOOL_SETUP_FAILED', 'Tool setup could not finish. Check its status before retrying.')
    }
  }
  // Native dispatcher only, after the real MCP call returns. The parsed envelope
  // may identify an already registered download, never create one or rebind it.
  function associateAgentResult(name, result, origin, projectPath) {
    const record = document
    if (name !== 'download_tool_installer' || !documentCurrent(record) || result?.isError
      || !validChatQuery({ projectPath, chatId: origin?.chatId }) || !id(origin?.turnId)
      || !Array.isArray(result?.content) || result.content.length > 8) return false
    const blocks = result.content.filter(block => block?.type === 'text')
    if (blocks.length !== 1 || typeof blocks[0].text !== 'string' || blocks[0].text.length > 8192) return false
    let value
    try { value = JSON.parse(blocks[0].text) } catch { return false }
    if (!object(value) || value.success === false || value.previewOnly === true) return false
    value = value.result || value
    const job = publicJob(value)
    if (!job || value.downloadApproved !== true || value.background !== true) return false
    const tracked = record.downloads.get(job.jobId)
    if (!tracked || tracked.origin || tracked.job.integration !== job.integration || tracked.job.totalBytes !== job.totalBytes) return false
    tracked.origin = { projectPath, chatId: origin.chatId, turnId: origin.turnId }
    changed(record)
    return true
  }
  async function agentDownloads(event, payload) {
    try {
      const record = currentDocument(event, 'desktop')
      if (!validChatQuery(payload)) return failure('TOOL_SETUP_INVALID_REQUEST', 'Provide only the current project and chat for installer progress.')
      const owner = record.owners.mcp
      // User interface reads do not inherit an ended/cancelled agent turn.
      return await calls.run({ owner, record, source: 'desktop', agentScope: null, openApprovals: new Set() }, async () => {
        const jobs = []
        for (const [jobId, entry] of [...record.downloads].slice(-MAX_DOWNLOADS)) {
          if (entry.origin?.projectPath !== payload.projectPath || entry.origin.chatId !== payload.chatId) continue
          const result = await manager.status({ jobId }, owner)
          contextFor(owner)
          if (record.downloads.get(jobId) !== entry) continue
          if (result?.success === false && result.code === 'UNKNOWN_JOB') { record.downloads.delete(jobId); continue }
          const job = publicJob(result, jobId)
          if (!job) return failure('TOOL_SETUP_PROGRESS_UNAVAILABLE', 'Installer progress could not be verified. The download may still be running; no automatic retry was started.')
          entry.job = job
          jobs.push({ ...job, turnId: entry.origin.turnId, opened: entry.opened })
        }
        return { success: true, jobs }
      })
    } catch (error) {
      return ownErrors.has(error) ? failure(error.code, error.message)
        : failure('TOOL_SETUP_PROGRESS_UNAVAILABLE', 'Installer progress could not be checked in this desktop session.')
    }
  }
  const api = Object.fromEntries(METHODS.map(method => [method, payload => invoke('mcp', method, payload)]))
  for (const method of METHODS) ipcMain.handle(CHANNELS[method], (event, payload) => invoke('desktop', method, payload, event))
  ipcMain.handle(CHANNELS.agentDownloads, agentDownloads)
  function dispose() {
    if (disposed) return
    disposed = true
    invalidate(document)
    for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler?.(channel)
    app?.removeListener?.('will-quit', dispose)
    try { Promise.resolve(manager.dispose()).catch(() => {}) } catch {}
  }
  app?.on?.('will-quit', dispose)
  return { api, associateAgentResult, dispose }
}

module.exports = { createToolSetupController, CHANNELS, CHANGED }
