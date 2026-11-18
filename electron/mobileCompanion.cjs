'use strict'

const { sanitizeToolReceipts } = require('./connectedAgentReceipts.cjs')

// Paired local companion. Commands use the desktop agent and its native grants;
// this listener does not expose arbitrary IPC, shell, or MCP endpoints.
const CHANNELS = Object.freeze({
  enable: 'mobile-companion:enable', disable: 'mobile-companion:disable',
  publish: 'mobile-companion:publish', reply: 'mobile-companion:reply', event: 'mobile-companion:event',
  attach: 'mobile-companion:attach', detach: 'mobile-companion:detach', forget: 'mobile-companion:forget',
  decideNative: 'mobile-companion:decide-native', preference: 'mobile-companion:preference',
  accountRequests: 'mobile-companion:account-requests',
  guidedSetup: 'mobile-companion:guided-setup', guidedDisconnect: 'mobile-companion:guided-disconnect',
  guidedUnregister: 'mobile-companion:guided-unregister',
  desktopAccount: 'mobile-companion:desktop-account',
})
const LIMITS = Object.freeze({ messages: 60, messageBytes: 8192, totalTextBytes: 128 * 1024,
  activityItems: 30, activityBytes: 24576,
  phoneTextCharacters: 4000, phoneTextBytes: 16000,
  imageBytes: 1024 * 1024, publicationBytes: 3 * 1024 * 1024, metadataBytes: 256, statusBytes: 200 })

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fault = (code, message) => Object.assign(new Error(message), { code, publicMessage: message })
const invalid = () => fault('MOBILE_COMPANION_INVALID_REQUEST', 'The mobile companion request is invalid or exceeds its sharing limits.')
const stale = () => fault('MOBILE_COMPANION_CONTEXT_CHANGED', 'The shared project or chat changed. Enable the mobile companion again.')
const cancelled = () => ({ success: false, status: 'cancelled', error: 'The desktop sharing session ended. Nothing new was sent.' })

function boundedJson(value, bytes) {
  let json
  try { json = JSON.stringify(value) } catch { throw invalid() }
  if (typeof json !== 'string' || Buffer.byteLength(json) > bytes) throw invalid()
}
function scopeValue(value) {
  // Opaque, transient identity only: never a project path, stored chat, or token.
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw invalid()
  return value
}
function clipUtf8(value, bytes) {
  let end = Math.min(value.length, bytes), low = 0
  if (Buffer.byteLength(value.slice(0, end)) > bytes) {
    let high = end
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (Buffer.byteLength(value.slice(0, middle)) <= bytes) low = middle
      else high = middle - 1
    }
    end = low
  }
  let result = value.slice(0, end)
  if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1)
  return result
}
function sharedText(value, bytes) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw invalid()
  // Defense in depth for accidentally copied paths/credentials in visible chat.
  // Share only conversation prose and explicitly projected public activity,
  // never raw provider events, tool arguments or command output.
  return clipUtf8(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|authorization|endpoint|base[_ -]?url)\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '[private value omitted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+={0,2}/gi, '[credential omitted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/g, '[credential omitted]')
    .replace(/(["'])(?:[A-Za-z]:[\\/]|\\\\|~?\/)[^"'\n]*\1/g, '[path omitted]')
    .replace(/(^|[\s(\[{=:])(?:[A-Za-z]:[\\/]|\\\\|~?\/)[^\s"'<>\])}]+/g, '$1[path omitted]'), bytes)
}

function sanitizePublication(value = {}) {
  if (!object(value)) throw invalid()
  boundedJson(value, LIMITS.publicationBytes)
  for (const name of ['busy', 'awaitingApproval', 'available']) {
    if (value[name] !== undefined && typeof value[name] !== 'boolean') throw invalid()
  }
  if (value.messages !== undefined && !Array.isArray(value.messages)) throw invalid()
  // Match the desktop's 60-row history window, with a shared UTF-8 budget.
  // A system/tool/reasoning row is never promoted to user-visible phone history.
  const rows = (value.messages || []).filter(row => object(row) && ['user', 'assistant'].includes(row.role)).slice(-LIMITS.messages)
  const messages = []
  let remaining = LIMITS.totalTextBytes
  for (let index = rows.length - 1; index >= 0 && remaining; index--) {
    const text = sharedText(rows[index].text, Math.min(LIMITS.messageBytes, remaining))
    if (!text) continue
    remaining -= Buffer.byteLength(text)
    const row = rows[index]
    const toolReceipts = row.role === 'assistant' ? sanitizeToolReceipts(row.toolReceipts) : undefined
    messages.unshift({ role: rows[index].role, text,
      ...(typeof row.turnId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(row.turnId) ? { turnId: row.turnId } : {}),
      ...(row.role === 'assistant' && ['failed', 'reply-unavailable'].includes(row.deliveryStatus) ? { deliveryStatus: row.deliveryStatus } : {}),
      ...(toolReceipts ? { toolReceipts } : {}) })
  }
  const activity = { items: [], updatedAt: 0 }
  if (value.activity !== undefined) {
    if (!object(value.activity) || !Array.isArray(value.activity.items)) throw invalid()
    const entries = value.activity.items.filter(item => object(item)
      && ['progress', 'tool'].includes(item.kind)
      && ['running', 'completed', 'failed', 'denied', 'stopped', 'unconfirmed'].includes(item.status)).slice(-LIMITS.activityItems)
    let budget = LIMITS.activityBytes
    for (let index = entries.length - 1; index >= 0 && budget > 0; index--) {
      const item = entries[index]
      const row = { id: sharedText(item.id, 256), kind: item.kind, status: item.status }
      if (item.kind === 'progress') row.text = sharedText(item.text, Math.min(3000, budget))
      else {
        row.toolName = sharedText(item.toolName, Math.min(120, budget))
        row.summary = /shell|command/i.test(row.toolName) ? '' : sharedText(item.summary, Math.min(600, Math.max(0, budget - Buffer.byteLength(row.toolName))))
      }
      budget -= Buffer.byteLength(row.text || '') + Buffer.byteLength(row.toolName || '') + Buffer.byteLength(row.summary || '')
      activity.items.unshift(row)
    }
    if (activity.items.length && Number.isSafeInteger(value.activity.updatedAt) && value.activity.updatedAt > 0) {
      activity.updatedAt = Math.min(value.activity.updatedAt, Date.now())
    }
  }
  let preview = null
  if (value.preview !== undefined && value.preview !== null) {
    if (!object(value.preview) || typeof value.preview.dataUrl !== 'string'
      || !Number.isSafeInteger(value.preview.capturedAt) || value.preview.capturedAt < 0
      || !['editor', 'storyboard'].includes(value.preview.workspace)) throw invalid()
    const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.preview.dataUrl)
    if (!match || match[1].length % 4 || Buffer.byteLength(match[1], 'base64') > LIMITS.imageBytes) throw invalid()
    const bytes = Buffer.from(match[1], 'base64')
    if (bytes.toString('base64') !== match[1] || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8
      || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw invalid()
    preview = { dataUrl: value.preview.dataUrl, capturedAt: value.preview.capturedAt, workspace: value.preview.workspace }
  }
  const reviews = (Array.isArray(value.reviews) ? value.reviews : []).slice(-100).flatMap(frame => {
    if (!object(frame) || !/^review-[a-zA-Z0-9-]{1,100}$/.test(frame.id || '')
      || !(frame.persisted === true && frame.dataUrl === undefined) && !require('./connectedAgentReviews.cjs').validReviewImage(frame.dataUrl, 300000)
      || !Number.isSafeInteger(frame.capturedAt) || frame.capturedAt < 0) return []
    return [{ id: frame.id, dataUrl: frame.dataUrl, label: sharedText(frame.label, 150), capturedAt: frame.capturedAt,
      ...(frame.unavailable === true ? {unavailable:true,reason:'File unavailable'} : {}),
      ...(typeof frame.turnId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(frame.turnId) ? { turnId: frame.turnId } : {}),
      ...(Number.isFinite(frame.timeSeconds) && frame.timeSeconds >= 0 ? { timeSeconds: frame.timeSeconds } : {}) }]
  })
  return { projectName: sharedText(value.projectName, LIMITS.metadataBytes), chatTitle: sharedText(value.chatTitle, LIMITS.metadataBytes),
    provider: sharedText(value.provider, LIMITS.metadataBytes), model: sharedText(value.model, LIMITS.metadataBytes),
    messages, activity, reviews, shareReviewMedia: value.shareReviewMedia === true, busy: value.busy === true, awaitingApproval: value.awaitingApproval === true,
    status: sharedText(value.status, LIMITS.statusBytes), preview, available: value.available === true,
    ...require('./mobileCompanionControl.cjs').controlsSnapshot(value, sharedText) }
}

function sanitizeReply(value) {
  if (!object(value) || typeof value.success !== 'boolean') throw invalid()
  boundedJson(value, 2048)
  if (value.success) {
    if (!['accepted', 'completed'].includes(value.status)) throw invalid()
    return { success: true, status: value.status }
  }
  if (value.status !== undefined && !['declined', 'cancelled', 'busy', 'error'].includes(value.status)) throw invalid()
  return { success: false, status: value.status || 'error', error: sharedText(value.error, LIMITS.statusBytes)
    || 'The desktop did not send this message. Review it in Velorn.' }
}

function registerMobileCompanionIpc({ ipcMain, app, getMainWindow, dialog, clientRoot, apiOnly = false,
  createServer = options => require('./mobileCompanionServer.cjs').createMobileCompanionServer(options),
  replyTimeoutMs = 10 * 60 * 1000, deviceStorePath, preferencePath, onRevokeAccess, getExportJobs = () => [], getProjectPath = async () => null, getAudioAssets = async () => [], reviewMediaStore, createBridge = null }) {
  let disposed = false, epoch = 0, accessRevision = 0, owner = null, enabling = false
  let administrativeOwner = null
  let accountOwner = null, accountContext = null, accountChanging = false
  let stopping = Promise.resolve(), publication = null
  let preferenceSuppressed = false
  const preference = preferencePath ? require('./mobileCompanionPreference.cjs').createMobileCompanionPreference(preferencePath) : null
  const rememberedSharing = async () => {
    if (!preference || preferenceSuppressed) return false
    // A saved LAN opt-in must never silently enroll/enable account access in an
    // installer. Only the separately approved guided preference restores it.
    const enabled = (!apiOnly && await preference.read()) || await server.getGuidedPreference?.() === true
    return enabled && !preferenceSuppressed
  }
  const pending = new Map(), bound = new Map()
  // Private path binding is never part of the LAN snapshot.
  const reviewPaths = new WeakMap()
  function readPublication(value) {
    const next = sanitizePublication(value)
    if (typeof value.reviewProjectPath === 'string' && value.reviewProjectPath.length <= 8192) reviewPaths.set(next, value.reviewProjectPath)
    return next
  }
  const mediaContext = async () => {
      const before = publication, candidate = owner
      if (!current() || !before || !server.getStatus().paired) return { blocked: 'unavailable' }
      if (!before.shareReviewMedia) return { blocked: 'sharing-off' }
      if (!before.available) return { blocked: 'desktop-busy' }
      const projectPath = await getProjectPath()
      // Heartbeats replace the snapshot every 1.5 seconds. That is not a project
      // change: compare the media authority, not the snapshot object's identity.
      if (owner !== candidate || !current() || !server.getStatus().paired) return { blocked: 'unavailable' }
      if (!publication?.shareReviewMedia) return { blocked: 'sharing-off' }
      if (!publication.available) return { blocked: 'desktop-busy' }
      if (!projectPath || projectPath !== reviewPaths.get(before) || projectPath !== reviewPaths.get(publication)
        || publication.contextId !== before.contextId) return { blocked: 'project-changing' }
      return { projectPath, contextId: before.contextId,chatId:before.chatId,
        turnIds:[...new Set(before.messages.map(message=>message.turnId).filter(Boolean))] }
  }
  const savedMedia=async(projectPath,type)=>{
    if(!reviewMediaStore?.listPlayable) return []
    const {syncPlayable,playableJob}=require('./agentPlayableMedia.cjs')
    const items=await syncPlayable({projectPath,assets:await getAudioAssets(projectPath),store:reviewMediaStore})
    return items.filter(item=>item.type===type).map(item=>playableJob(item,projectPath))
  }
  const videoCatalog = require('./mobileCompanionVideos.cjs').createMobileVideoCatalog({getJobs:getExportJobs,getContext:mediaContext,
    ...(reviewMediaStore ? {getSavedJobs:async projectPath=>[...await reviewMediaStore.listExports(projectPath),...await savedMedia(projectPath,'video')]} : {})})
  const stillCatalog = reviewMediaStore ? require('./mobileCompanionStills.cjs').createMobileStillCatalog({getContext:mediaContext,store:reviewMediaStore}) : null
  const audioCatalog = require('./mobileCompanionAudio.cjs').createMobileAudioCatalog({ getContext: mediaContext, getAssets: getAudioAssets,
    getSavedMedia:projectPath=>savedMedia(projectPath,'audio'),
    getOrigins: projectPath => reviewMediaStore?.listAudioOrigins?.(projectPath) || [] })
  const deviceStore = deviceStorePath ? require('./mobileCompanionDevice.cjs').createDeviceStore(deviceStorePath) : null
  const reviews = require('./mobileCompanionReviews.cjs').createMobileReviews({
    getContext: () => current() && publication?.protocol === 3 && publication.available && server.getStatus().enabled && server.getStatus().paired
      ? { ...owner, contextId: publication.contextId } : null,
    changed: () => {
      if (current() && publication && server.getStatus().enabled) server.publish(owner.scope, effectiveSnapshot())
      emit({ type: 'native-approvals', approvals: reviews.snapshot() })
    },
    revoked: reason => { accessRevision++; if (onRevokeAccess?.()) emit({ type: 'access-revoked', reason: reason || 'disconnected' }) },
  })
  function effectiveSnapshot() { return { ...publication, nativeApprovals: reviews.snapshot() } }

  function current(candidate = owner) {
    return !!candidate && !disposed && getMainWindow() === candidate.window && !candidate.window.isDestroyed()
      && !candidate.sender.isDestroyed() && candidate.window.webContents === candidate.sender
      && candidate.sender.mainFrame === candidate.frame
  }
  function emit(message, candidate = owner) {
    if (!current(candidate)) return false
    try { candidate.sender.send(CHANNELS.event, message); return true } catch { return false }
  }
  function clearPending(record, result) {
    clearTimeout(record.timer)
    record.signal?.removeEventListener('abort', record.abort)
    pending.delete(record.id)
    if (!record.accepted) record.resolve(result)
  }
  function invalidate(reason) {
    if (['navigation', 'renderer-gone', 'destroyed', 'app-quit', 'disposed'].includes(reason)) {
      accountOwner = null; accountContext = null; void server.setAccountContext?.(null).catch(() => {})
    }
    reviews.invalidate(reason)
    epoch++
    owner = null
    administrativeOwner = null
    publication = null
    for (const record of pending.values()) clearPending(record, cancelled())
    // Invoke stop immediately so an in-flight start can be invalidated too.
    try { stopping = Promise.resolve(server.stop(reason)).catch(() => {}) } catch { stopping = Promise.resolve() }
    return stopping
  }
  function bind(contents) {
    if (bound.has(contents)) return
    const listeners = []
    const listen = (name, callback) => { contents.on(name, callback); listeners.push([name, callback]) }
    listen('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace && (owner?.sender === contents || administrativeOwner?.sender === contents || accountOwner?.sender === contents)) void invalidate('navigation')
    })
    listen('render-process-gone', () => { if (owner?.sender === contents || administrativeOwner?.sender === contents || accountOwner?.sender === contents) void invalidate('renderer-gone') })
    listen('destroyed', () => {
      if (owner?.sender === contents || administrativeOwner?.sender === contents || accountOwner?.sender === contents) void invalidate('destroyed')
      for (const [name, listener] of listeners) contents.removeListener(name, listener)
      bound.delete(contents)
    })
    bound.set(contents, listeners)
  }
  function authorize(event) {
    const window = getMainWindow()
    if (disposed || !window || window.isDestroyed() || !event?.sender || event.sender.isDestroyed()
      || event.sender !== window.webContents || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) {
      throw fault('MOBILE_COMPANION_UNAUTHORIZED', 'Mobile sharing is available only in the main Velorn window.')
    }
    bind(event.sender)
    return { window, sender: event.sender, frame: event.senderFrame }
  }
  function request(payload, keys) {
    if (!object(payload) || Object.keys(payload).some(key => !keys.includes(key))) throw invalid()
    boundedJson(payload, LIMITS.publicationBytes + 1024)
    return scopeValue(payload.scope)
  }
  function assertOwner(candidate, scope) {
    if (!current() || owner.sender !== candidate.sender || owner.frame !== candidate.frame || owner.scope !== scope) throw stale()
  }
  function onStatus(status) {
    const previous = owner
    if (status?.reason === 'unpaired') {
      preferenceSuppressed = true
      void preference?.write(false).catch(() => {})
    }
    if (!status?.enabled && owner) {
      reviews.invalidate(status.reason || 'disconnected')
      epoch++
      owner = null
      publication = null
      for (const record of pending.values()) clearPending(record, cancelled())
    }
    emit({ type: 'status', status }, previous || accountOwner)
  }
  function onMessage(message) {
    if (!current() || message?.scope !== owner.scope) { void invalidate('desktop-context-changed'); return Promise.resolve(cancelled()) }
    // The legacy text-only route has no provider-bound sharing envelope. It
    // must not bypass the dual-recipient permission required by funded Luna.
    if (!message?.kind && publication?.provider === 'luna') return Promise.resolve({ success: false, status: 'error', error: 'Velo requires an updated phone AI-sharing permission for Velorn and OpenAI. No message was sent.' })
    const command = message.kind ? require('./mobileCompanionControl.cjs').validateCommand(Object.fromEntries(Object.entries(message).filter(([k]) => !['scope', 'signal'].includes(k))), effectiveSnapshot()) : null
    if (command?.kind === 'native-approval') return Promise.resolve(reviews.decide(command))
    if (typeof message.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(message.id)
      || (!command && (typeof message.text !== 'string' || !message.text.trim() || message.text.length > LIMITS.phoneTextCharacters
      || Buffer.byteLength(message.text) > LIMITS.phoneTextBytes || /\u0000/.test(message.text)
      )) || message.signal?.aborted) return Promise.resolve({ success: false, status: 'error', error: 'The phone message is invalid.' })
    if (!['approval', 'stop'].includes(command?.kind) && (pending.size || !publication?.available || publication.busy || publication.awaitingApproval)) {
      return Promise.resolve({ success: false, status: 'busy', error: 'Velorn is busy or unavailable. Wait before sending another message.' })
    }
    return new Promise(resolve => {
      const record = { id: message.id, scope: owner.scope, owner, resolve, accepted: false, signal: message.signal, command, accessRevision }
      record.abort = () => {
        clearPending(record, cancelled())
        emit({ type: 'message-cancelled', id: record.id, scope: record.scope }, record.owner)
      }
      record.timer = setTimeout(() => {
        clearPending(record, { success: false, status: 'cancelled', error: 'Desktop review timed out. The message was not resent.' })
        try { server.resolveCommand(record.scope, record.id, { success: false, status: 'cancelled', error: 'Desktop review timed out.' }) } catch { /* Already revoked. */ }
        emit({ type: 'message-cancelled', id: record.id, scope: record.scope }, record.owner)
      }, replyTimeoutMs)
      record.timer.unref?.()
      pending.set(record.id, record)
      record.signal?.addEventListener('abort', record.abort, { once: true })
      if (!emit(command ? { type: 'command', command, scope: record.scope,
        ...(command.aiSharingConsent ? { aiSharing: publication.aiSharing } : {}) } : { type: 'message', id: record.id, text: message.text, scope: record.scope })) {
        clearPending(record, cancelled())
        void invalidate('desktop-unavailable')
      }
    })
  }
  // Construction does not listen. An authorized renderer can restore a saved
  // opt-in only after providing its fresh window/chat context.
  const legacyAvailable = !apiOnly && typeof clientRoot === 'string' && clientRoot.length > 0
  const available = legacyAvailable || (apiOnly === true && Boolean(deviceStore) && Boolean(preference))
  const server = available ? createServer({ clientRoot, ...(apiOnly ? { apiOnly: true, host: '127.0.0.1', port: 0 } : {}), onMessage, onStatus, videoCatalog, stillCatalog, audioCatalog, ...(createBridge ? { createBridge } : {}),
    onDeviceRevoked: reason => reviews.invalidate(reason || 'phone-disconnected'),
    ...(deviceStore ? { deviceStore, onCommand: onMessage } : {}) }) : {
    getStatus: () => ({ enabled: false, paired: false, pairingCode: null, urls: [], reason: 'unavailable' }),
    stop: () => Promise.resolve(),
  }
  function configureGuidedContext(candidate, scope) {
    const version = epoch
    const isCurrent = () => version === epoch && current(candidate) && owner?.scope === scope
    server.setGuidedContext?.(confirmationContext(candidate, isCurrent))
  }
  async function configureAccountContext(candidate) {
    if (!server.setAccountContext) return
    if (!accountOwner || !current(accountOwner)) {
      accountOwner = candidate
      accountContext = confirmationContext(candidate, () => accountOwner === candidate && current(candidate))
    }
    await server.setAccountContext(accountContext)
  }
  function confirmationContext(candidate, isCurrent) {
    return { isCurrent, confirm: async details => {
      if (!isCurrent() || typeof dialog?.showMessageBox !== 'function') throw stale()
      const device = details.kind === 'device'
      const automatic = details.automatic === true
      const upgrade = details.kind === 'automatic'
      if (details.kind === 'account') {
        // Return attention from browser sign-in to this owned window for the
        // first native account consent only. Polls and phone enrollments never
        // raise the desktop. Recheck ownership after native window callbacks.
        for (const action of [
          () => { if (candidate.window.isMinimized?.()) candidate.window.restore?.() },
          () => candidate.window.show?.(),
          () => candidate.window.focus?.(),
        ]) {
          if (!isCurrent()) throw stale()
          try { action() } catch { /* OS focus policy may deny raising the window. */ }
          if (!isCurrent()) throw stale()
        }
      }
      const answer = await dialog.showMessageBox(candidate.window, {
        type: 'question', title: device ? 'Connect this phone to Velorn?' : automatic && upgrade ? 'Enable phone access?' : 'Connect this computer to your Velorn account?',
        message: device ? `Connect “${details.deviceName}” to “${details.computerName}”?` : automatic && upgrade ? `Enable phone access to “${details.computerName}”?` : `Connect “${details.computerName}” to your Velorn account?`,
        detail: device ? `Account: ${details.accountDisplayName}\n\nCheck that your phone displays this code: ${details.fingerprint}\n\nApprove only your own phone. It can use your desktop agent, projects and shared media. Paid generations still ask. You can disconnect this device in Velorn.`
          : automatic ? `${upgrade ? 'Use the Velorn account already linked to this computer.' : `Velorn account: ${details.accountDisplayName}`}\n\nThis connects your computer for Velo access when available for your account, and enables phone access. Phones signed into this same account can connect automatically and use your desktop agent, projects and shared media without asking you to approve each phone here. This permission is remembered when Velorn restarts. Paid generations still ask. Stop all phone sharing turns access off; you can also disconnect individual devices. Desktop editing, your own Codex, and local LM Studio do not require a Velorn account.`
            : `Velorn account: ${details.accountDisplayName}\n\nApprove only the account you just signed into. This connects your computer for Velo access when available for your account.${details.phoneAccess === false ? ' Signing in does not enable phone sharing; existing sharing settings are unchanged.' : ' Phone access is also enabled.'} Desktop editing, your own Codex, and local LM Studio do not require a Velorn account.`,
        buttons: ['Cancel', device ? 'Connect phone' : automatic ? 'Enable phone access' : 'Link computer'], defaultId: 0, cancelId: 0, noLink: true,
      })
      if (!isCurrent()) throw stale()
      return answer?.response === 1
    } }
  }
  async function startConnection(candidate, scope, snapshot, restoreOnly = false, guidedOnly = false) {
      if (!available) throw fault('MOBILE_COMPANION_UNAVAILABLE', 'Phone connections are not available in this build.')
      if (enabling) throw fault('MOBILE_COMPANION_BUSY', 'A mobile sharing confirmation is already open.')
      if (administrativeOwner) throw fault('MOBILE_COMPANION_BUSY', 'Velorn account removal is in progress.')
      if (owner && current() && owner.scope === scope && server.getStatus().enabled) return { success: true, status: server.getStatus() }
      enabling = true
      try {
        await invalidate('sharing-replaced')
        owner = { ...candidate, scope }
        const consentEpoch = epoch
        const assertConsent = () => { if (epoch !== consentEpoch || !current() || owner?.scope !== scope) throw stale() }
        assertConsent()
        configureGuidedContext(candidate, scope)
        if (!restoreOnly && !guidedOnly) {
          if (typeof dialog?.showMessageBox !== 'function') throw fault('MOBILE_COMPANION_UNAVAILABLE', 'Restart Velorn to load native mobile-sharing confirmation.')
          const remoteConfigured = await server.hasRemoteConfiguration?.() === true
          assertConsent()
          const answer = await dialog.showMessageBox(candidate.window, {
          type: 'warning', title: 'Enable Velorn mobile companion?',
          message: deviceStore ? (remoteConfigured ? 'Let your paired phone work with Velorn through the configured remote connection and trusted Wi-Fi?' : 'Let one paired phone work with Velorn on your trusted Wi-Fi?') : 'Share this project’s current chat and preview with one paired phone?',
          detail: deviceStore ? `${remoteConfigured ? 'Remote beta is configured: an outbound encrypted connection also permits phone access outside your network. Anyone with the private pairing link and phone credential can use this access. Trust the remote website operator; the browser code is delivered by that website. ' : ''}Shares recent chat, project names, models, action arguments (including file paths), and optional still previews. With Share images enabled, project review media is playable on the phone. Your paired phone can use the desktop agent, switch projects, approve tools and paid submissions, and explicitly enable Full access. Normal model usage applies. The separate local HTTP connection is UNENCRYPTED: others on the network may read or alter traffic and control the computer. Use only trusted private Wi-Fi; never expose the local HTTP address to the internet. The phone is remembered until Forget phone.${preference ? ' Sharing automatically resumes when Velorn reopens a project, until Stop sharing.' : ''} Stopping sharing revokes phone-enabled full access but does not undo completed work or cancel every external job.` : 'Shares recent chat and previews over unencrypted HTTP. Use only a trusted private network. Phone messages require desktop review. Never expose this service to the internet.',
          buttons: ['Cancel', deviceStore ? 'Enable local companion' : 'Enable for this chat'], defaultId: 0, cancelId: 0, noLink: true,
          checkboxLabel: 'I am on a trusted private network and will not port-forward this unencrypted connection.', checkboxChecked: false,
          })
          assertConsent()
          if (answer?.response !== 1 || answer.checkboxChecked !== true) {
            await invalidate('consent-declined')
            return { success: true, cancelled: true, status: server.getStatus() }
          }
        } else if (restoreOnly) {
          if (!await rememberedSharing()) throw stale()
          assertConsent()
        }
        publication = snapshot
        const restoreGuidedOnly = restoreOnly && (apiOnly || (preference && !await preference.read())) && await server.getGuidedPreference?.() === true
        if (guidedOnly || restoreGuidedOnly) await server.startGuided(scope, snapshot)
        else await server.start(scope, snapshot)
        assertConsent()
        if (!restoreOnly && !guidedOnly && preference) {
          await preference.write(true)
          assertConsent()
          preferenceSuppressed = false
        }
        return { success: true, status: server.getStatus() }
      } catch (error) {
        await invalidate('enable-failed')
        throw error
      } finally { enabling = false }
  }
  const handlers = {
    async enable(event, payload) {
      const candidate = authorize(event)
      if (!legacyAvailable) throw fault('MOBILE_COMPANION_UNAVAILABLE', 'Use Enable phone access to connect through your Velorn account.')
      const scope = request(payload, ['scope', 'snapshot'])
      const snapshot = readPublication(payload.snapshot)
      return startConnection(candidate, scope, snapshot)
    },
    async disable(event, payload) {
      const candidate = authorize(event)
      const scope = request(payload, ['scope'])
      if (owner) assertOwner(candidate, scope)
      preferenceSuppressed = true
      await invalidate('desktop-disabled')
      await preference?.write(false)
      await server.setGuidedPreference?.(false)
      return { success: true, status: server.getStatus() }
    },
    async attach(event, payload) {
      const candidate = authorize(event), scope = request(payload, ['scope', 'snapshot'])
      if (!available || (!deviceStore && !owner)) return { success: true, status: server.getStatus() }
      const snapshot = readPublication(payload.snapshot)
      if (!deviceStore || ![2, 3].includes(snapshot.protocol)) throw invalid()
      if (!owner || !server.getStatus().enabled) {
        const version = epoch
        if (!available || enabling || !await rememberedSharing()) return { success: true, status: server.getStatus() }
        if (version !== epoch || disposed || !current({ ...candidate, scope })) throw stale()
        return startConnection(candidate, scope, snapshot, true)
      }
      assertOwner(candidate, scope)
      if (snapshot.contextId !== publication?.contextId) reviews.invalidate('shared-context-changed')
      for (const record of pending.values()) if (!record.accepted) {
        server.resolveCommand(scope, record.id, { success: false, code: 'STALE_SCOPE' }); clearPending(record, cancelled())
      }
      // Only a fresh, authorized renderer IPC grants recovery freshness.
      publication = snapshot; server.publish(scope, effectiveSnapshot(), { rendererPublication: true })
      return { success: true, status: server.getStatus(), nativeApprovals: reviews.snapshot() }
    },
    async detach(event, payload) {
      const candidate = authorize(event), scope = request(payload, ['scope', 'contextId'])
      if (!owner) return { success: true }
      assertOwner(candidate, scope)
      if (publication?.contextId === payload.contextId) {
        reviews.invalidate('shared-context-changed')
        publication = { ...publication, available: false, preview: null, approvals: [] }
        server.publish(scope, publication)
      }
      return { success: true }
    },
    async forget(event, payload) {
      authorize(event); request(payload, ['scope'])
      preferenceSuppressed = true
      await invalidate('device-forgotten')
      await Promise.all([preference?.write(false), deviceStore?.forget()])
      await server.setGuidedPreference?.(false)
      return { success: true, status: server.getStatus() }
    },
    async preference(event) {
      const candidate = authorize(event)
      await configureAccountContext(candidate)
      const enabled = available && Boolean(deviceStore) && await rememberedSharing()
      return { success: true, available, legacyAvailable, guidedAvailable: available && Boolean(server.beginGuidedSetup), enabled, status: server.getStatus() }
    },
    async desktopAccount(event, payload) {
      const candidate = authorize(event)
      if (!object(payload) || Object.keys(payload).some(key => !['action', 'name', 'deviceId'].includes(key))) throw invalid()
      boundedJson(payload, 1024)
      const action = payload.action
      if (!['sign-in', 'sign-out', 'switch-account', 'enable-phone', 'disable-phone', 'disconnect-device', 'refresh'].includes(action) || !server.setAccountContext) throw invalid()
      if (accountChanging || enabling || administrativeOwner) throw fault('MOBILE_COMPANION_BUSY', 'An account action is already in progress.')
      accountChanging = true
      try {
        await configureAccountContext(candidate)
        const identity = accountOwner, isCurrent = () => accountOwner === identity && current(candidate)
        const check = () => { if (!isCurrent()) throw stale() }
        check()
        const linked = server.getStatus().guided
        if (action === 'refresh') {
          await server.checkGuided(true)
        } else if (action === 'sign-in') {
          if (linked?.registered) throw invalid()
          if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 80 || /[\u0000-\u001f\u007f]/.test(payload.name)) throw invalid()
          await server.beginGuidedSetup(payload.name, { accountOnly: true, reauthenticate: true })
        } else if (action === 'enable-phone') {
          await server.enableAccountPhone(); check(); preferenceSuppressed = false
        } else if (action === 'disable-phone') {
          preferenceSuppressed = true
          await invalidate('desktop-disabled'); check()
          await server.setGuidedPreference(false); await preference?.write(false)
        } else if (action === 'disconnect-device') {
          if (typeof payload.deviceId !== 'string' || !linked?.devices?.some(device => device.id === payload.deviceId)) throw invalid()
          await server.disconnectGuidedDevice(payload.deviceId, { accountOnly: true })
        } else {
          if (!linked?.registered || !dialog?.showMessageBox) throw invalid()
          if (publication?.busy || publication?.awaitingApproval || reviews.snapshot().length) throw fault('MOBILE_COMPANION_BUSY', 'Wait for the current activity to finish before changing accounts.')
          const switching = action === 'switch-account'
          const answer = await dialog.showMessageBox(candidate.window, { type: 'question',
            title: switching ? 'Switch Velorn account?' : 'Sign out of Velorn on this computer?',
            message: switching ? 'Sign out, then choose another account?' : 'Sign out and disconnect this computer’s account-linked phones?',
            detail: 'This stops Velo here and disconnects this computer’s account-linked phones. Your projects, local chats, other computers and allowances stay unchanged. Google, Apple and browser sessions are not signed out.' + (switching ? ' If you cancel the new sign-in, this computer stays signed out.' : ''),
            buttons: ['Cancel', switching ? 'Switch account' : 'Sign out'], defaultId: 0, cancelId: 0, noLink: true })
          check()
          if (answer?.response !== 1) return { success: true, cancelled: true, status: server.getStatus() }
          if (publication?.busy || publication?.awaitingApproval || reviews.snapshot().length) throw fault('MOBILE_COMPANION_BUSY', 'Wait for the current activity to finish before changing accounts.')
          const result = await server.unregisterGuided({ accountOnly: true }); check()
          if (result.registered !== false) throw fault('MOBILE_COMPANION_BUSY', 'Sign-out could not be confirmed. No new sign-in was started.')
          if (switching) await server.beginGuidedSetup(linked.computer.name, { accountOnly: true, reauthenticate: true })
        }
        check(); return { success: true, status: server.getStatus() }
      } finally { accountChanging = false }
    },
    async accountRequests(event, payload) {
      const candidate = authorize(event), scope = request(payload, ['scope'])
      if (!legacyAvailable) throw fault('MOBILE_COMPANION_UNAVAILABLE', 'Use Enable phone access to connect through your Velorn account.')
      assertOwner(candidate, scope)
      if (!server.getStatus().enabled || !server.reviewPhoneAccountRequests || typeof dialog?.showMessageBox !== 'function') throw stale()
      const version = epoch
      const isCurrent = () => version === epoch && current(candidate) && owner?.scope === scope && server.getStatus().enabled
      const result = await server.reviewPhoneAccountRequests({ isCurrent, confirm: async ({ accountDisplayName, computerName }) => {
        if (!isCurrent()) throw stale()
        // Deliberately native-only: a remote phone cannot approve its own link.
        const answer = await dialog.showMessageBox(candidate.window, { type: 'question', title: 'Link this computer to your Velorn account?',
          message: `Link “${computerName}” to this Velorn account?`,
          detail: `Velorn account: ${accountDisplayName}\n\nApprove only if you just requested this link from your signed-in phone. This adds the existing paired connection to My computers; it does not change your pairing or require a desktop login.`,
          buttons: ['Decline', 'Link computer'], defaultId: 0, cancelId: 0, noLink: true })
        if (!isCurrent()) throw stale()
        return answer?.response === 1
      } })
      if (!isCurrent()) throw stale()
      return { success: true, ...result }
    },
    async guidedSetup(event, payload) {
      const candidate = authorize(event), scope = request(payload, ['scope', 'snapshot', 'name', 'automatic', 'reauthenticate'])
      if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 80 || /[\u0000-\u001f\u007f]/.test(payload.name)
        || (payload.automatic !== undefined && typeof payload.automatic !== 'boolean')
        || (payload.reauthenticate !== undefined && typeof payload.reauthenticate !== 'boolean')
        || !server.beginGuidedSetup || !server.startGuided) throw invalid()
      const snapshot = readPublication(payload.snapshot)
      await startConnection(candidate, scope, snapshot, false, true)
      assertOwner(candidate, scope)
      configureGuidedContext(candidate, scope)
      const guided = await server.beginGuidedSetup(payload.name, { automatic: payload.automatic === true, ...(payload.reauthenticate === true ? { reauthenticate: true } : {}) })
      assertOwner(candidate, scope)
      preferenceSuppressed = false
      return { success: true, guided, status: server.getStatus() }
    },
    async guidedDisconnect(event, payload) {
      const candidate = authorize(event), scope = request(payload, ['scope', 'deviceId'])
      assertOwner(candidate, scope)
      if (!/^[A-Za-z0-9_-]{24,128}$/.test(payload.deviceId || '') || !server.disconnectGuidedDevice) throw invalid()
      const guided = await server.disconnectGuidedDevice(payload.deviceId)
      assertOwner(candidate, scope)
      return { success: true, guided, status: server.getStatus() }
    },
    async guidedUnregister(event, payload) {
      const candidate = authorize(event), action = payload?.action
      if (action !== undefined && !['sign-out', 'switch-account'].includes(action)) throw invalid()
      const switching = action === 'switch-account'
      const scope = request(payload, switching ? ['scope', 'action', 'snapshot'] : ['scope', 'action'])
      const nextSnapshot = switching ? readPublication(payload.snapshot) : null
      const linked = server.getStatus().guided
      const computerName = switching ? linked?.computer?.name : null
      if (switching && (!linked?.registered || typeof computerName !== 'string' || !computerName.trim() || computerName.length > 80
        || /[\u0000-\u001f\u007f]/.test(computerName) || !server.beginGuidedSetup || !server.startGuided
        || !nextSnapshot.available || nextSnapshot.busy || nextSnapshot.awaitingApproval)) throw invalid()
      if (!server.unregisterGuided || !dialog?.showMessageBox) throw invalid()
      if (administrativeOwner) throw fault('MOBILE_COMPANION_BUSY', 'Velorn account removal is already being reviewed.')
      const version = epoch, paused = !owner
      const isCurrent = () => current(candidate) && version === epoch && (paused
        ? !owner && !server.getStatus().enabled
        : current() && owner?.sender === candidate.sender && owner?.frame === candidate.frame && owner?.scope === scope)
      if (!isCurrent()) throw stale()
      // Hold the native action latch even on an active account, including while
      // its confirmation is open. A second click cannot remove/enroll twice.
      administrativeOwner = candidate
      try {
        const answer = await dialog.showMessageBox(candidate.window, { type: 'question',
          title: switching ? 'Switch Velorn account?' : action === 'sign-out' ? 'Sign out of Velorn on this computer?' : 'Disconnect Velorn account?',
          message: switching ? 'Sign out of this computer, then choose another account?' : 'Disconnect this computer and all its account-linked phones?',
          detail: action ? 'This stops Velo access here and disconnects this computer from its account-linked phones. Your projects, local chats, other computers, account and allowances are not deleted or changed. You stay signed in to Google, Apple and your browser.'
            + (switching ? '\n\nBrowser sign-in opens after sign-out is confirmed. If you cancel that sign-in, this computer stays signed out. Phones will need to connect again under the selected account.' : '\n\nYou can sign in again later; phones will need to reconnect to this computer.')
            : 'Desktop editing and any older private-link pairing are unchanged. You can link this computer again later.',
          buttons: ['Cancel', switching ? 'Switch account' : action === 'sign-out' ? 'Sign out' : 'Disconnect account'], defaultId: 0, cancelId: 0, noLink: true })
        if (!isCurrent()) throw stale()
        if (answer?.response !== 1) return { success: true, cancelled: true, status: server.getStatus() }
        if (action && !paused && (publication?.busy || publication?.awaitingApproval || reviews.snapshot().length)) throw fault('MOBILE_COMPANION_BUSY', 'Wait for the current activity to finish before changing accounts.')
        const guided = await server.unregisterGuided(paused ? { isCurrent } : undefined)
        if (!isCurrent()) throw stale()
        if (action && (guided?.registered !== false || server.getStatus().guided?.registered !== false)) throw fault('MOBILE_COMPANION_BUSY', 'Sign-out could not be confirmed. No new sign-in was started.')
        if (switching) {
          // Native continuation of the same explicitly approved gesture. Never
          // replay a renderer click after its user-activation window has expired.
          administrativeOwner = null
          await startConnection(candidate, scope, nextSnapshot, false, true)
          assertOwner(candidate, scope)
          administrativeOwner = candidate
          configureGuidedContext(candidate, scope)
          const next = await server.beginGuidedSetup(computerName, { automatic: true, reauthenticate: true })
          assertOwner(candidate, scope)
          preferenceSuppressed = false
          return { success: true, guided: next, status: server.getStatus() }
        }
        return { success: true, guided, status: server.getStatus() }
      } finally { if (administrativeOwner === candidate) administrativeOwner = null }
    },
    async publish(event, payload) {
      const candidate = authorize(event)
      const scope = request(payload, ['scope', 'snapshot'])
      try { assertOwner(candidate, scope) } catch (error) { await invalidate('desktop-context-changed'); throw error }
      const snapshot = readPublication(payload.snapshot)
      if (deviceStore && publication?.contextId && snapshot.contextId !== publication.contextId) throw stale()
      publication = snapshot
      const result = await server.publish(scope, effectiveSnapshot(), { rendererPublication: true })
      assertOwner(candidate, scope)
      return { success: true, status: result?.enabled === undefined ? server.getStatus() : result }
    },
    async reply(event, payload) {
      const candidate = authorize(event)
      const scope = request(payload, ['scope', 'id', 'result'])
      assertOwner(candidate, scope)
      if (typeof payload.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.id)) throw invalid()
      const record = pending.get(payload.id)
      if (!record || record.scope !== scope || record.owner.sender !== candidate.sender || record.owner.frame !== candidate.frame) throw stale()
      const result = sanitizeReply(payload.result)
      if (!record.accepted) {
        // The renderer sends accepted only after the explicit desktop Send click.
        // No phone-supplied permission/provider/tool flag crosses this boundary.
        if (result.success && result.status === 'completed') throw invalid()
        if (result.success) {
          if (record.command) require('./mobileCompanionControl.cjs').validateCommand(record.command, effectiveSnapshot())
          // Require the native receipt to still be live before authorizing the
          // renderer's subsequent Send. The heartbeat can expire between ticks.
          if (server.resolveCommand(scope, record.id, result) !== true) {
            clearPending(record, cancelled())
            throw stale()
          }
          record.accepted = true
          record.resolve(result)
        }
        else clearPending(record, result)
      } else {
        if (result.status === 'accepted') throw invalid()
        const settled = server.resolveCommand(scope, record.id, result)
        clearPending(record, result)
        if (settled !== true) throw stale()
      }
      return { success: true }
    },
    async decideNative(event, payload) {
      const candidate = authorize(event)
      const scope = request(payload, ['scope', 'approvalId', 'reviewToken', 'approved', 'riskAcknowledged', 'trustLocal'])
      assertOwner(candidate, scope)
      return reviews.decide(payload)
    },
  }
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(CHANNELS[name], async (event, payload) => {
      try { return await handler(event, payload) }
      catch (error) { return { success: false, code: /^MOBILE_COMPANION_[A-Z_]+$/.test(error?.code || '') ? error.code : 'MOBILE_COMPANION_FAILED',
        error: error?.publicMessage || 'The mobile companion request could not be completed. Review sharing on the desktop.' } }
    })
  }
  const beforeQuit = () => { void invalidate('app-quit') }
  app?.on?.('will-quit', beforeQuit)
  function claimFullAccess({ window, provider } = {}) {
    if (!current() || owner.window !== window || !server.getStatus().enabled || !server.getStatus().paired
      || server.isCurrentScope?.(owner.scope) === false
      || !publication?.available || publication.protocol !== 3 || publication.provider !== provider || !['codex', 'lmstudio', 'luna'].includes(provider)) return null
    const record = [...pending.values()].find(record => record.accepted && !record.accessClaimed
      && record.accessRevision === accessRevision && !record.signal?.aborted
      && record.owner === owner && record.command?.kind === 'access' && record.command.mode === 'full'
      && record.command.bundleVersion === 1 && record.command.contextId === publication.contextId)
    if (!record) return null
    record.accessClaimed = true
    const candidate = owner, contextId = publication.contextId, version = epoch, revision = accessRevision
    return { approved: true, shareImagesAndView: true, remember: true, phoneBundleVersion: 1, mobileBinding: {
      isCurrent: () => epoch === version && accessRevision === revision && owner === candidate && current(candidate)
        && server.getStatus().enabled && server.getStatus().paired && publication?.contextId === contextId
        && server.isCurrentScope?.(candidate.scope) !== false
        && publication?.available && publication?.provider === provider,
    } }
  }
  function claimMessageConsent({ window, request } = {}) {
    const { consentMatches, requestSharing, sharingFailure } = require('./mobileAISharing.cjs')
    const binding = request?.mobileSharing, record = pending.get(binding?.commandId)
    const candidate = owner, version = epoch
    const same = () => current(candidate) && owner === candidate && owner?.window === window && epoch === version
      && server.getStatus().enabled && server.getStatus().paired && server.isCurrentScope?.(owner.scope) !== false
      && pending.get(record?.id) === record && record?.accepted && record.owner === owner && !record.signal?.aborted
      && publication?.available && record.command?.kind === 'message'
      && record.command.contextId === publication.contextId && request.conversationId === publication.chatId
      && consentMatches(binding?.consent, record.command.aiSharingConsent)
      && consentMatches(binding?.consent, publication.aiSharing)
      && consentMatches(binding?.consent, requestSharing(request))
      && (!request.images?.length || publication.aiSharing.capabilities.images)
    if (!same() || record.sharingClaimed) throw sharingFailure()
    record.sharingClaimed = true
    return { assertCurrent() { if (!same()) throw sharingFailure() } }
  }
  return { claimFullAccess, claimMessageConsent, fundedLuna: server.fundedLuna, gpuNetwork: server.gpuNetwork,
    confirm: options => reviews.confirm(options), async dispose() {
    if (disposed) return stopping
    disposed = true
    for (const name of Object.keys(handlers)) ipcMain.removeHandler?.(CHANNELS[name])
    app?.removeListener?.('will-quit', beforeQuit)
    for (const [contents, listeners] of bound) for (const [name, listener] of listeners) contents.removeListener(name, listener)
    bound.clear()
    await invalidate('disposed')
  } }
}

module.exports = { registerMobileCompanionIpc, sanitizePublication, CHANNELS, LIMITS }
