'use strict'

// Hosted account setup only. This does not share the Partner-node credential,
// authorize paid work, select a generation transport, or expose a generic fetch.
const path = require('node:path')
const nativeFs = require('node:fs/promises')
const nativeFsSync = require('node:fs')
const { randomUUID } = require('node:crypto')

const CHANNELS = Object.freeze({ status: 'comfy-hosted-setup:status', check: 'comfy-hosted-setup:check',
  clear: 'comfy-hosted-setup:clear', cancel: 'comfy-hosted-setup:cancel', openGuide: 'comfy-hosted-setup:open-guide' })
const ENDPOINT = 'https://cloud.comfy.org/api/user'
const GUIDES = Object.freeze({ cloud: 'https://docs.comfy.org/development/deploy/cloud', keys: 'https://platform.comfy.org/profile/api-keys' })
const FILE_NAME = 'comfy-hosted-credential.enc'
const LIMITS = Object.freeze({ key: 4096, response: 16384, encrypted: 65536, timeoutMs: 10000 })
const summaries = Object.freeze({
  missing: 'No hosted Comfy Cloud key is configured. Enter it only in the private key field.',
  configured: 'A hosted Comfy Cloud key is configured, but account access has not been verified in this session.',
  verified: 'Comfy Cloud accepted the key and reported an active account. No workflow, upload, generation, credit balance or spending permission was tested or changed.',
  waitlisted: 'Comfy Cloud reported that the tested account is waitlisted. Hosted generation readiness is not verified.',
  'auth-rejected': 'Comfy Cloud rejected the tested key. A previously configured key, if any, was left unchanged; account access is not verified.',
  'subscription-or-rate-limited': 'Comfy Cloud limited this check or requires an active subscription. Review your account in Comfy Cloud; no purchase or generation was made.',
  unavailable: 'Hosted Comfy Cloud account access could not be verified. Any previously configured key was left unchanged. No generation was run.',
})
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const empty = value => value === undefined || object(value) && Object.keys(value).length === 0
const validKey = value => typeof value === 'string' && value.length > 0 && value.length <= LIMITS.key && !/[\s\x00-\x1f\x7f-\x9f]/.test(value)
const knownErrors = new WeakSet()
function fault(code, summary) { const error = Object.assign(new Error(summary), { code }); knownErrors.add(error); return error }

function createComfyHostedSetup({ ipcMain, app, getMainWindow, safeStorage, fs = nativeFs, fsSync = nativeFsSync,
  fetchImpl = globalThis.fetch, openExternal, platform = process.platform, timeoutMs = LIMITS.timeoutMs } = {}) {
  if (!ipcMain?.handle || typeof app?.getPath !== 'function' || typeof getMainWindow !== 'function') throw new TypeError('Hosted setup requires the native desktop dependencies.')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.timeoutMs) throw new TypeError('Invalid hosted setup deadline.')
  const credentialFile = path.join(app.getPath('userData'), FILE_NAME)
  let disposed = false, document = null, active = null, clearing = false, version = 0, cancellation = 0
  let credential = '', remembered = false, lastState = null, initialization = null, writeQueue = Promise.resolve()

  function canRemember() {
    try {
      if (safeStorage?.isEncryptionAvailable?.() !== true || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') return false
      // Linux can report encryption available while using a hard-coded plaintext
      // fallback. Unknown backends are not treated as OS-protected storage.
      return platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(safeStorage.getSelectedStorageBackend?.())
    } catch { return false }
  }
  function snapshot(state = lastState || (credential ? 'configured' : 'missing')) {
    return { state, configured: Boolean(credential), remembered, canRemember: canRemember(), summary: summaries[state] || summaries.unavailable }
  }
  function failure(error) {
    if (knownErrors.has(error) && error.code === 'COMFY_HOSTED_UNAUTHORIZED') return { success: false, code: error.code, summary: error.message }
    return { ...snapshot(), success: false, code: knownErrors.has(error) ? error.code : 'COMFY_HOSTED_UNAVAILABLE',
      summary: knownErrors.has(error) ? error.message : summaries.unavailable }
  }
  function current(doc) {
    const window = getMainWindow()
    return !disposed && doc?.valid && doc === document && doc.window === window && !window.isDestroyed()
      && window.webContents === doc.contents && !doc.contents.isDestroyed() && doc.contents.mainFrame === doc.frame
  }
  function stop() {
    version++; cancellation++
    lastState = null
    active?.controller.abort('cancelled')
    active = null
  }
  function invalidate(doc) {
    if (!doc?.valid) return
    doc.valid = false; stop()
    for (const [target, event, listener] of doc.listeners) target.removeListener?.(event, listener)
    if (document === doc) document = null
  }
  function authorize(event, nativeRead = false) {
    const window = getMainWindow(), contents = window?.webContents, frame = contents?.mainFrame
    if (disposed || !window || window.isDestroyed() || !contents || contents.isDestroyed() || !frame
      || !nativeRead && (event?.sender !== contents || event?.senderFrame !== frame)) {
      throw fault('COMFY_HOSTED_UNAUTHORIZED', 'Hosted setup is available only in the main Velorn desktop window.')
    }
    if (document && !current(document)) invalidate(document)
    if (!document) {
      const doc = document = { window, contents, frame, valid: true, listeners: [] }
      const listen = (target, name, listener) => { target.on?.(name, listener); doc.listeners.push([target, name, listener]) }
      listen(contents, 'did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) invalidate(doc) })
      listen(contents, 'render-process-gone', () => invalidate(doc)); listen(contents, 'destroyed', () => invalidate(doc)); listen(window, 'closed', () => invalidate(doc))
    }
    return document
  }
  function assertCurrent(doc) {
    if (!current(doc)) throw fault('COMFY_HOSTED_CANCELLED', 'Hosted setup was cancelled because the Velorn window changed.')
  }
  function assertOperation(op) {
    assertCurrent(op.document)
    if (active !== op || version !== op.version || op.controller.signal.aborted) {
      throw fault('COMFY_HOSTED_CANCELLED', 'The hosted setup check was cancelled. Check again when you are ready.')
    }
  }
  function queued(operation) {
    const result = writeQueue.then(operation, operation)
    writeQueue = result.catch(() => {})
    return result
  }
  function initialize() {
    if (initialization) return initialization
    const initialVersion = version
    const loading = queued(async () => {
      if (!canRemember()) return
      try {
        const stat = await fs.lstat(credentialFile)
        if (!stat.isFile() || stat.isSymbolicLink?.() || stat.size > LIMITS.encrypted) throw new Error('Unsupported credential file')
        // O_NOFOLLOW prevents a symlink replacement between lstat and open on
        // systems that support it. The size is bounded again after reading.
        const constants = require('node:fs').constants
        const handle = await fs.open(credentialFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
        let encrypted
        try {
          const opened = await handle.stat()
          if (!opened.isFile() || opened.size > LIMITS.encrypted) throw new Error('Unsupported credential file')
          const bytes = Buffer.alloc(LIMITS.encrypted + 1); let length = 0
          while (length < bytes.length) {
            const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null)
            if (!bytesRead) break
            length += bytesRead
          }
          encrypted = bytes.subarray(0, length)
        } finally { await handle.close() }
        if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > LIMITS.encrypted) throw new Error('Invalid credential file')
        const loaded = safeStorage.decryptString(encrypted)
        if (!validKey(loaded)) throw new Error('Invalid credential')
        if (!disposed && version === initialVersion) { credential = loaded; remembered = true }
      } catch (error) {
        if (error?.code !== 'ENOENT' && !disposed && version === initialVersion) lastState = 'unavailable'
      }
    })
    initialization = loading.finally(() => {
      // Cancellation/navigation during disk IO must not permanently turn a
      // remembered credential into a missing one for the rest of the process.
      if (!disposed && version !== initialVersion) initialization = null
    })
    return initialization
  }
  // Native dependency for Luna, not an IPC/MCP endpoint or credential getter.
  // Reads existing evidence only; never invokes inspect(), fetch, save or clear.
  async function readStatus({ isCurrent } = {}) {
    const unavailable = () => ({ success: false, integration: 'comfycloud', state: 'problem', configured: false })
    try {
      if (typeof isCurrent !== 'function' || isCurrent() !== true) return unavailable()
      const doc = authorize(undefined, true), beforeRead = version
      await initialize()
      if (isCurrent() !== true || beforeRead !== version || !current(doc)) return unavailable()
      const state = lastState || (credential ? 'configured' : 'missing')
      return { success: true, integration: 'comfycloud', state, configured: Boolean(credential) }
    } catch { return unavailable() }
  }
  function removeFile(assertLive) {
    assertLive()
    try { fsSync.unlinkSync(credentialFile) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  async function commitCandidate(op, key, remember) {
    return queued(async () => {
      assertOperation(op)
      if (!remember) {
        // A verified replacement chosen for this session must not leave an old
        // hosted key behind to silently return on the next launch.
        removeFile(() => assertOperation(op))
        credential = key; remembered = false
        return
      }
      if (!canRemember()) throw fault('COMFY_HOSTED_STORAGE_UNAVAILABLE', 'OS-protected key storage is unavailable. Leave Remember unchecked to use a verified key for this session only.')
      const encrypted = safeStorage.encryptString(key)
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > LIMITS.encrypted) throw new Error('Encryption unavailable')
      const temporary = `${credentialFile}.${randomUUID()}.tmp`
      let handle, renamed = false
      try {
        assertOperation(op)
        handle = await fs.open(temporary, 'wx', 0o600)
        await handle.writeFile(encrypted); await handle.sync(); await handle.close(); handle = null
        assertOperation(op)
        // The final authority check, atomic rename and metadata publication run
        // in one event-loop turn. Cancellation cannot leave a scheduled rename
        // which saves the key after the user's cancel/clear/navigation action.
        fsSync.renameSync(temporary, credentialFile); renamed = true
        credential = key; remembered = true
      } finally {
        if (handle) { try { await handle.close() } catch {} }
        if (!renamed) { try { await fs.unlink(temporary) } catch {} }
      }
    })
  }
  function abortable(operation, signal) {
    if (signal.aborted) return Promise.reject(fault('COMFY_HOSTED_CANCELLED', 'The hosted setup check was cancelled.'))
    let listener
    const cancelled = new Promise((_, reject) => {
      listener = () => reject(fault(signal.reason === 'timeout' ? 'COMFY_HOSTED_TIMEOUT' : 'COMFY_HOSTED_CANCELLED',
        signal.reason === 'timeout' ? summaries.unavailable : 'The hosted setup check was cancelled.'))
      signal.addEventListener('abort', listener, { once: true })
    })
    return Promise.race([Promise.resolve().then(() => { if (signal.aborted) return cancelled; return operation() }), cancelled])
      .finally(() => signal.removeEventListener('abort', listener))
  }
  function discard(response) { try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}) } catch {} }
  async function readBody(response, signal) {
    if (Number(response.headers?.get?.('content-length')) > LIMITS.response) { discard(response); throw new Error('Response too large') }
    if (response.body?.getReader) {
      const reader = response.body.getReader(), chunks = []; let length = 0, complete = false
      try {
        while (true) {
          const item = await abortable(() => reader.read(), signal)
          if (item.done) { complete = true; break }
          length += item.value.byteLength
          if (length > LIMITS.response) throw new Error('Response too large')
          chunks.push(Buffer.from(item.value))
        }
        return Buffer.concat(chunks).toString('utf8')
      } finally {
        if (!complete) { try { Promise.resolve(reader.cancel()).catch(() => {}) } catch {} }
        try { reader.releaseLock() } catch {}
      }
    }
    // Used by bounded synthetic fixtures; real native fetch exposes a stream.
    const text = await abortable(() => response.text(), signal)
    if (typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.response) throw new Error('Response too large')
    return text
  }
  async function inspect(op, key) {
    if (typeof fetchImpl !== 'function') return 'unavailable'
    const timer = setTimeout(() => op.controller.abort('timeout'), timeoutMs)
    try {
      const response = await abortable(() => fetchImpl(ENDPOINT, { method: 'GET', redirect: 'error', credentials: 'omit',
        headers: { Accept: 'application/json', 'X-API-Key': key }, signal: op.controller.signal }), op.controller.signal)
      assertOperation(op)
      // Do not parse or reflect error bodies, even for known authentication errors.
      if (response.status === 401 || response.status === 403) { discard(response); return 'auth-rejected' }
      if (response.status === 429) { discard(response); return 'subscription-or-rate-limited' }
      if (response.status !== 200 || response.redirected === true) { discard(response); return 'unavailable' }
      const body = JSON.parse(await readBody(response, op.controller.signal))
      assertOperation(op)
      return object(body) && body.status === 'active' ? 'verified' : object(body) && body.status === 'waitlisted' ? 'waitlisted' : 'unavailable'
    } catch (error) {
      if (!current(op.document) || active !== op || op.version !== version || op.controller.signal.reason === 'cancelled') throw error
      return 'unavailable'
    } finally { clearTimeout(timer) }
  }
  async function invoke(method, event, payload) {
    try {
      const doc = authorize(event)
      if (['status', 'clear', 'cancel'].includes(method) && !empty(payload)) throw fault('COMFY_HOSTED_INVALID', 'This hosted setup control takes no arguments.')
      if (method === 'openGuide') {
        if (!object(payload) || Object.keys(payload).length !== 1 || !Object.hasOwn(GUIDES, payload.guide)) throw fault('COMFY_HOSTED_INVALID', 'Choose the official Comfy Cloud or API-key page.')
        if (typeof openExternal !== 'function') throw fault('COMFY_HOSTED_UNAVAILABLE', 'The official page could not be opened. Try again from the desktop app.')
        await openExternal(GUIDES[payload.guide]); assertCurrent(doc)
        return { success: true, opened: true }
      }
      if (method === 'cancel') { stop(); return { ...snapshot(), success: true } }
      const beforeInitialization = cancellation
      await initialize(); assertCurrent(doc)
      if (['check', 'clear'].includes(method) && beforeInitialization !== cancellation) throw fault('COMFY_HOSTED_CANCELLED', 'The hosted setup action was cancelled.')
      if (method === 'status') return snapshot()
      if (method === 'clear') {
        if (clearing) throw fault('COMFY_HOSTED_BUSY', 'A hosted key change is already in progress.')
        stop(); clearing = true
        const clearCancellation = cancellation
        try {
          await queued(async () => {
            removeFile(() => {
              assertCurrent(doc)
              if (clearCancellation !== cancellation) throw fault('COMFY_HOSTED_CANCELLED', 'The hosted key removal was cancelled.')
            })
            credential = ''; remembered = false; lastState = null
          })
          assertCurrent(doc)
          return snapshot()
        } finally { clearing = false }
      }
      if (method !== 'check' || !object(payload) || Object.keys(payload).some(key => !['key', 'remember'].includes(key))
        || Object.hasOwn(payload, 'key') && !validKey(payload.key)
        || Object.hasOwn(payload, 'remember') && (typeof payload.remember !== 'boolean' || !Object.hasOwn(payload, 'key'))) {
        throw fault('COMFY_HOSTED_INVALID', 'Use the private hosted key field, or check the configured key without arguments.')
      }
      if (active || clearing) throw fault('COMFY_HOSTED_BUSY', 'A hosted setup check or key change is already in progress.')
      const candidate = Object.hasOwn(payload, 'key'), key = candidate ? payload.key : credential
      lastState = null
      if (!key) return snapshot('missing')
      if (payload.remember === true && !canRemember()) throw fault('COMFY_HOSTED_STORAGE_UNAVAILABLE', 'OS-protected key storage is unavailable. Leave Remember unchecked to use a verified key for this session only.')
      const op = active = { document: doc, version: ++version, controller: new AbortController() }
      try {
        const state = await inspect(op, key)
        // A deadline expires the request, not the whole setup document.
        if (op.controller.signal.reason === 'timeout') {
          if (!current(doc) || active !== op || version !== op.version) throw fault('COMFY_HOSTED_CANCELLED', 'The hosted setup check was cancelled.')
          lastState = 'unavailable'; return snapshot()
        }
        assertOperation(op)
        if (state === 'verified' && candidate) await commitCandidate(op, key, payload.remember === true)
        assertOperation(op); lastState = state
        return snapshot()
      } catch (error) {
        if (active === op && current(doc) && version === op.version) lastState = 'unavailable'
        throw error
      } finally { if (active === op) active = null }
    } catch (error) { return failure(error) }
  }
  for (const [method, channel] of Object.entries(CHANNELS)) ipcMain.handle(channel, (event, payload) => invoke(method, event, payload === undefined && method === 'check' ? {} : payload))
  function dispose() {
    if (disposed) return
    stop(); if (document) invalidate(document); disposed = true; credential = ''
    for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler?.(channel)
    app.removeListener?.('will-quit', dispose)
  }
  app.on?.('will-quit', dispose)
  return { readStatus, dispose }
}

module.exports = { createComfyHostedSetup, CHANNELS, ENDPOINT, GUIDES, FILE_NAME, LIMITS }
