'use strict'

const { randomUUID, createHash } = require('node:crypto')

const REQUEST_TOOL = 'request_comfy_cloud_setup'
const STATUS_TOOL = 'get_comfy_cloud_setup_status'
const CHANNELS = Object.freeze({ current: 'comfy-cloud-setup:current', save: 'comfy-cloud-setup:save', complete: 'comfy-cloud-setup:complete' })
const REQUESTED = 'comfy-cloud-setup:requested', CHANGED = 'comfy-cloud-setup:changed'
const USER_WAIT_MS = 5 * 60 * 1000
const methods = Object.freeze({ [REQUEST_TOOL]: 'request', [STATUS_TOOL]: 'status' })
const names = new Set(Object.keys(methods)), readNames = new Set([STATUS_TOOL])
const tools = Object.freeze(Object.keys(methods).map(name => ({ name,
  description: name === REQUEST_TOOL
    ? 'Open Velorn’s dedicated Comfy cloud API-key dialog on the desktop and wait up to 5 minutes for the user. The user enters or tests their key directly in the dialog, never in chat. Returns only saved/verified/unknown/invalid/cancelled status, not credentials. Does not buy credits, change generation spending policy, run generation, install ComfyUI or connect hosted Comfy Cloud. Requires an explicit setup request; do not repeatedly reopen after cancellation.'
    : 'Read whether a Comfy cloud key is configured in Velorn, and any matching validation from this app session. No key, prefix, fingerprint, account information, network request or generation. Configured is not necessarily verified or funded.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: name === STATUS_TOOL, destructiveHint: false, idempotentHint: name === STATUS_TOOL, openWorldHint: false },
})))
const guidance = 'For Comfy Partner/API-node cloud setup, inspect get_comfy_cloud_setup_status and, when the user wants to connect their account, use request_comfy_cloud_setup with no arguments. This opens the dedicated desktop key-entry dialog and waits for the user. Never ask the user to paste a key or password into chat, read credential files, pass secrets to a tool, or bypass the dialog with settings/shell commands. Only the user enters, tests and saves their key. Configured, verified, unknown and cancelled are different results; none proves credit balance, paid-generation approval or workflow readiness. Continue local ComfyUI connection/node checks separately. Paid generation still needs existing approval.'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const empty = value => exact(value, [])
const normalizeKey = value => typeof value === 'string' ? value.trim() : ''
const fingerprint = value => createHash('sha256').update(normalizeKey(value)).digest('hex')
const validations = new Set(['valid', 'invalid', 'unknown'])
const failure = (code, error) => ({ success: false, code, error })
const ownErrors = new WeakSet()
function fault(code, message) { const error = Object.assign(new Error(message), { code }); ownErrors.add(error); return error }
function safeError(error) { return ownErrors.has(error) ? failure(error.code, error.message) : failure('COMFY_CLOUD_SETUP_FAILED', 'Comfy cloud setup could not finish. Check the dialog and try again; no credential is included in this result.') }

// The only key ingress is authenticated main-renderer IPC. MCP has zero-argument
// request/status methods; no credential, path, URL or renderer outcome is authority.
function createComfyCloudSetup({ ipcMain, app, getMainWindow, readKey, writeKey,
  getAgentScope = () => null, assertAgentCurrent = async () => {}, isExportBusy = () => false,
  userWaitMs = USER_WAIT_MS } = {}) {
  if (![getMainWindow, readKey, writeKey].every(value => typeof value === 'function')) throw new TypeError('Comfy cloud setup requires native window and settings dependencies.')
  if (!Number.isSafeInteger(userWaitMs) || userWaitMs < 1 || userWaitMs > USER_WAIT_MS) throw new TypeError('Invalid cloud setup wait limit.')
  let disposed = false, document = null, active = null, starting = false, lastValidation = null
  function currentDocument(record) {
    return !disposed && record?.valid && getMainWindow() === record.window && !record.window.isDestroyed()
      && !record.contents.isDestroyed() && record.window.webContents === record.contents && record.contents.mainFrame === record.frame
  }
  function changed(record) { if (currentDocument(record)) { try { record.contents.send(CHANGED) } catch {} } }
  function finish(record, result) {
    if (!record || active !== record) return
    active = null; clearTimeout(record.timer); record.scope?.signal?.removeEventListener('abort', record.abort)
    try { record.scope?.onWaiting?.(false) } catch {}
    changed(record.document); record.resolve(result)
  }
  function cancel(code = 'COMFY_CLOUD_SETUP_CANCELLED', message = 'Comfy cloud setup was cancelled. No generation was started.') {
    if (active) finish(active, { ...failure(code, message), status: 'cancelled', outcome: 'cancelled' })
  }
  function invalidate(record) {
    if (!record?.valid) return
    record.valid = false
    if (active?.document === record) cancel('COMFY_CLOUD_SETUP_CONTEXT_CHANGED', 'The Velorn window changed. Start cloud setup again if needed.')
    for (const [target, event, listener] of record.listeners) target.removeListener?.(event, listener)
    if (document === record) document = null
  }
  function authorize(event, renderer = false) {
    const window = getMainWindow(), contents = window?.webContents, frame = contents?.mainFrame
    if (disposed || !window || window.isDestroyed() || !contents || contents.isDestroyed() || !frame
      || renderer && (event?.sender !== contents || event?.senderFrame !== frame)) {
      throw fault('COMFY_CLOUD_SETUP_UNAUTHORIZED', 'Cloud setup is available only in the main Velorn desktop window.')
    }
    if (document && !currentDocument(document)) invalidate(document)
    if (!document) {
      const record = document = { window, contents, frame, valid: true, listeners: [] }
      const listen = (target, event, listener) => { target.on?.(event, listener); record.listeners.push([target, event, listener]) }
      listen(contents, 'did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) invalidate(record) })
      listen(contents, 'render-process-gone', () => invalidate(record))
      listen(contents, 'destroyed', () => invalidate(record)); listen(window, 'closed', () => invalidate(record))
    }
    return document
  }
  function assertLive(record, checkExport = true) {
    if (active !== record || !currentDocument(record.document) || record.scope?.signal?.aborted) throw fault('COMFY_CLOUD_SETUP_CANCELLED', 'This cloud setup request is no longer active. No new key was saved.')
    if (checkExport && isExportBusy()) { cancel('COMFY_CLOUD_SETUP_EXPORT_BUSY', 'Export has priority. Reopen cloud setup when export finishes.'); throw fault('COMFY_CLOUD_SETUP_EXPORT_BUSY', 'Wait for export to finish before saving cloud setup.') }
  }
  async function guard(record) {
    assertLive(record)
    if (record.scope) await assertAgentCurrent(record.scope)
    assertLive(record)
  }
  function state(key) {
    const configured = Boolean(normalizeKey(key))
    const validation = configured && lastValidation?.digest === fingerprint(key) ? lastValidation.validation : 'unknown'
    return { success: true, configured, validation, status: configured ? validation === 'valid' ? 'verified' : 'configured' : 'missing' }
  }
  async function status(args = {}) {
    try {
      const doc = authorize()
      if (!empty(args)) throw fault('COMFY_CLOUD_SETUP_INVALID_REQUEST', 'Cloud setup status takes no arguments.')
      const key = await readKey()
      if (!currentDocument(doc)) throw fault('COMFY_CLOUD_SETUP_CONTEXT_CHANGED', 'The Velorn window changed.')
      return state(key)
    } catch (error) { return safeError(error) }
  }
  async function request(args = {}) {
    let record, reservation
    try {
      const doc = authorize()
      if (!empty(args)) throw fault('COMFY_CLOUD_SETUP_INVALID_REQUEST', 'Cloud setup takes no arguments. Enter credentials only in the desktop dialog.')
      if (active || starting) throw fault('COMFY_CLOUD_SETUP_BUSY', 'Finish or cancel the current cloud setup dialog first.')
      reservation = {}; starting = reservation
      const scope = getAgentScope()
      if (scope?.signal?.aborted || isExportBusy()) throw fault('COMFY_CLOUD_SETUP_UNAVAILABLE', 'Finish export or cancelled agent work before starting cloud setup.')
      if (scope) await assertAgentCurrent(scope)
      const key = await readKey()
      if (!currentDocument(doc) || scope?.signal?.aborted || isExportBusy()) throw fault('COMFY_CLOUD_SETUP_CONTEXT_CHANGED', 'Cloud setup context changed. Start again when the desktop is ready.')
      let resolve
      const result = new Promise(done => { resolve = done })
      record = active = { document: doc, scope, requestId: randomUUID(), resolve, baseline: fingerprint(key), saving: false }
      record.abort = () => cancel()
      scope?.signal?.addEventListener('abort', record.abort, { once: true })
      record.timer = setTimeout(() => cancel('COMFY_CLOUD_SETUP_EXPIRED', 'Cloud setup timed out waiting for you. Reopen it when ready.'), userWaitMs)
      try { scope?.onWaiting?.(true) } catch {}
      doc.contents.send(REQUESTED, { requestId: record.requestId }); changed(doc)
      if (starting === reservation) starting = false
      return await result
    } catch (error) { if (record && active === record) finish(record, safeError(error)); return safeError(error) }
    finally { if (starting === reservation) starting = false }
  }
  async function renderer(method, event, payload) {
    try {
      const doc = authorize(event, true)
      if (method === 'current') {
        if (payload !== undefined && !empty(payload)) throw fault('COMFY_CLOUD_SETUP_INVALID_REQUEST', 'Use the current setup request without arguments.')
        if (active && isExportBusy()) cancel('COMFY_CLOUD_SETUP_EXPORT_BUSY', 'Export has priority. Reopen cloud setup when export finishes.')
        return { success: true, request: active?.document === doc ? { requestId: active.requestId } : null }
      }
      const record = active
      if (!object(payload) || !record || record.document !== doc || payload.requestId !== record.requestId) throw fault('COMFY_CLOUD_SETUP_STALE', 'This cloud setup dialog is no longer active.')
      if (method === 'complete') {
        if (!exact(payload, ['requestId', 'outcome', 'validation']) || payload.outcome !== 'cancelled' || !validations.has(payload.validation)) throw fault('COMFY_CLOUD_SETUP_INVALID_REQUEST', 'Close the current cloud setup dialog to cancel it.')
        const result = { success: true, outcome: 'cancelled', status: payload.validation === 'invalid' ? 'invalid' : 'cancelled', validation: payload.validation }
        finish(record, result); return result
      }
      if (method !== 'save' || !exact(payload, Object.hasOwn(payload, 'useExisting') ? ['requestId', 'key', 'validation', 'useExisting'] : ['requestId', 'key', 'validation'])
        || typeof payload.key !== 'string' || payload.key.length > 8192 || /[\x00-\x1f\x7f]/.test(payload.key)
        || !validations.has(payload.validation) || Object.hasOwn(payload, 'useExisting') && typeof payload.useExisting !== 'boolean') {
        throw fault('COMFY_CLOUD_SETUP_INVALID_REQUEST', 'Use the cloud setup dialog to save a valid credential.')
      }
      if (record.saving) throw fault('COMFY_CLOUD_SETUP_BUSY', 'The current key save is already in progress.')
      const key = normalizeKey(payload.key)
      if (payload.validation === 'invalid' || !key && (payload.validation !== 'unknown' || payload.useExisting)) throw fault('COMFY_CLOUD_SETUP_INVALID_KEY', 'The key was not accepted. Check it in the dialog before saving.')
      record.saving = true
      try {
        await guard(record)
        const previous = normalizeKey(await readKey()); assertLive(record)
        if (payload.useExisting ? previous !== key : fingerprint(previous) !== record.baseline) throw fault('COMFY_CLOUD_SETUP_KEY_CHANGED', 'The saved key changed while this dialog was open. Cancel and reopen setup before continuing.')
        const committed = () => {
          // The native writer calls this synchronously AFTER atomic rename.
          // Publish that fact before Stop/close can misrepresent it as rollback.
          lastValidation = key ? { digest: fingerprint(key), validation: payload.validation } : null
          record.committedResult = { ...state(key), outcome: key ? 'saved' : 'removed' }
          finish(record, record.committedResult)
        }
        if (payload.useExisting) { assertLive(record); committed() }
        else {
          try { await writeKey(key, { assertCurrent: () => assertLive(record), expectedDigest: fingerprint(previous), onCommitted: committed }) }
          catch (error) { if (!record.committedResult) throw error }
        }
        if (!record.committedResult) throw fault('COMFY_CLOUD_SETUP_SAVE_FAILED', 'The key save could not be confirmed. Check settings before trying again.')
        return record.committedResult
      } finally { record.saving = false }
    } catch (error) { return safeError(error) }
  }
  for (const [method, channel] of Object.entries(CHANNELS)) ipcMain.handle(channel, (event, payload) => renderer(method, event, payload))
  function exportChanged() { if (isExportBusy()) cancel('COMFY_CLOUD_SETUP_EXPORT_BUSY', 'Export has priority. Reopen cloud setup when export finishes.') }
  function dispose() { cancel(); if (document) invalidate(document); disposed = true; for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler?.(channel); app?.removeListener?.('will-quit', dispose) }
  app?.on?.('will-quit', dispose)
  return { api: { request, status }, exportChanged, dispose }
}

module.exports = { createComfyCloudSetup, tools, names, readNames, methods, guidance, REQUEST_TOOL, STATUS_TOOL, CHANNELS, REQUESTED, CHANGED, USER_WAIT_MS, fingerprint }
