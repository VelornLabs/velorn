'use strict'

// Scoped phone transport. Hosted connections use an API-only loopback listener;
// the optional lab client keeps its separate trusted-LAN mode. This is not an
// MCP proxy: native code supplies sanitized data and handles scoped commands.
const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { randomBytes, timingSafeEqual, createHash } = require('node:crypto')

const TRANSPORT = 'trusted-lan-http'
const LIMITS = Object.freeze({ bodyBytes: 20 * 1024, createPhotoBodyBytes: 384 * 1024, textCharacters: 4000, snapshotBytes: 4 * 1024 * 1024,
  assetBytes: 3 * 1024 * 1024, receipts: 256, pairingMs: 5 * 60 * 1000, sessionMs: 2 * 60 * 60 * 1000,
  heartbeatMs: 30000, rateWindowMs: 60000, pairPerAddress: 5, pairGlobal: 20 })
const FILES = Object.freeze({ '/': ['live.html', 'text/html; charset=utf-8'],
  '/live.js': ['live.js', 'application/javascript; charset=utf-8'], '/live.css': ['live.css', 'text/css; charset=utf-8'] })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value)
const safeEqual = (a, b) => {
  const left = Buffer.from(typeof a === 'string' ? a : ''), right = Buffer.from(typeof b === 'string' ? b : '')
  return left.length === right.length && timingSafeEqual(left, right)
}
function ipv4(value) {
  const raw = String(value || '').replace(/^::ffff:/, '')
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(raw)) return null
  const parts = raw.split('.').map(Number)
  if (parts.some((part, index) => part > 255 || String(part) !== raw.split('.')[index])) return null
  return { raw, parts }
}
function privateAddress(value) {
  const parsed = ipv4(value)
  if (!parsed) return false
  const [a, b] = parsed.parts
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}
function allowedPeer(value) { const parsed = ipv4(value); return Boolean(parsed && (parsed.parts[0] === 127 || privateAddress(parsed.raw))) }
function serialized(value, max, label) {
  const text = JSON.stringify(value)
  if (typeof text !== 'string' || Buffer.byteLength(text) > max) throw new Error(`${label} exceeded its safe limit.`)
  return text
}
function scopeKey(scope) {
  if (typeof scope === 'string' && scope.length && Buffer.byteLength(scope) <= 8192) return JSON.stringify(scope)
  if (!object(scope)) throw new Error('A live companion scope is required.')
  const stable = value => Array.isArray(value) ? value.map(stable) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
  return serialized(stable(scope), 8192, 'Companion scope')
}

function createMobileCompanionServer({ clientRoot, onMessage, onStatus, apiOnly = false,
  port = apiOnly ? 0 : 5212, host = apiOnly ? '127.0.0.1' : '0.0.0.0',
  now = Date.now, networkInterfaces = os.networkInterfaces, deviceStore, onCommand, videoCatalog, stillCatalog, audioCatalog, createBridge } = {}) {
  if (typeof apiOnly !== 'boolean') throw new Error('Companion API-only mode must be explicit.')
  if ((!apiOnly && typeof clientRoot !== 'string') || typeof onMessage !== 'function') throw new Error('Companion client files and a native text handler are required.')
  if (apiOnly && (host !== '127.0.0.1' || typeof onCommand !== 'function'
    || !['read', 'write', 'forget'].every(method => typeof deviceStore?.[method] === 'function'))) {
    throw new Error('API-only companion connections require loopback and native device authority.')
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535
    || (host !== '0.0.0.0' && (!allowedPeer(host) || ipv4(host)?.raw !== host))) throw new Error('Use a local IPv4 companion bind address and port.')
  const transport = apiOnly ? 'loopback-http' : TRANSPORT
  let server = null, shutdown = null, timer = null, generation = 0, enabled = false, starting = false
  let key = null, scope = null, snapshot = {}, pairingCode = null, token = null, sessionExpiresAt = 0, pairingExpiresAt = 0
  let heartbeatAt = 0, reason = 'disabled', urls = [], localUrl = null, boundPort = null, controller = null
  let activeId = null, lastReceiptId = null, receipts = new Map(), files = new Map(), allowedHosts = new Set()
  const pairAttempts = []
  const sockets = new Set()
  // Pending file opens and active streams share the same admission limit.
  const mediaTransfers = new Set()
  let mediaCookie = ''
  function stopMedia() { for (const transfer of mediaTransfers) transfer.cancel(); mediaTransfers.clear() }
  let remembered = null, pairing = false
  const localControl = typeof onCommand === 'function' && Boolean(deviceStore)
  const digest = value => createHash('sha256').update(value).digest('hex')
  const trustedDevice = () => remembered && (remembered.expiresAt === null || remembered.expiresAt > now())
  function rotatePairingCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    pairingCode = [...randomBytes(12)].map(value => alphabet[value & 31]).join('')
    pairingExpiresAt = now() + LIMITS.pairingMs
  }
  function roomForReceipt() {
    // Long-lived connections retain recent idempotency receipts without an
    // eventual permanent limit. In-flight commands are never evicted/replayed.
    if (localControl) for (const [id, receipt] of receipts) {
      if (receipts.size < LIMITS.receipts) break
      if (receipt.status === 'completed' || receipt.status === 'rejected') receipts.delete(id)
    }
    return receipts.size < LIMITS.receipts
  }

  function getStatus() {
    return { enabled, paired: enabled && Boolean(token), transport,
      pairingCode: enabled && !token ? pairingCode : null, pairingExpiresAt: enabled && !apiOnly ? pairingExpiresAt : null,
      sessionExpiresAt: enabled ? sessionExpiresAt : null, urls: enabled ? [...urls] : [],
      localUrl: enabled ? localUrl : null, port: enabled ? boundPort : null, reason,
      remoteApprovals: localControl, fullAccess: snapshot.fullAccess === true, remembered: Boolean(remembered) }
  }
  function notify() { try { onStatus?.(getStatus()) } catch { /* Display notifications are not authority. */ } }
  function invalidate(why) {
    mediaCookie = ''; stopMedia()
    generation++; enabled = false; reason = why; pairingCode = null; token = null; key = null; scope = null; snapshot = {}
    activeId = null; lastReceiptId = null; receipts.clear(); pairAttempts.length = 0
    controller?.abort(); controller = null
    clearInterval(timer); timer = null; notify()
  }
  function closeNetwork() {
    if (shutdown) return shutdown
    const previous = server; server = null
    if (!previous) return Promise.resolve()
    shutdown = new Promise(resolve => {
      previous.close(() => { shutdown = null; resolve() })
      previous.closeIdleConnections?.()
      // Completed HTTP responses should flush, but held/slow clients must not
      // keep a revoked listener alive indefinitely.
      const deadline = setTimeout(() => { for (const socket of sockets) socket.destroy() }, 100)
      deadline.unref?.()
      previous.once('close', () => clearTimeout(deadline))
    })
    return shutdown
  }
  async function stop(why = 'disabled') { invalidate(why); await closeNetwork(); return getStatus() }
  function expired() {
    if (!enabled) return reason || 'disabled'
    if (sessionExpiresAt !== null && now() >= sessionExpiresAt) return 'session-expired'
    if (now() - heartbeatAt >= LIMITS.heartbeatMs) return 'desktop-unavailable'
    if (!apiOnly && !token && now() >= pairingExpiresAt) {
      if (!localControl) return 'pairing-expired'
      rotatePairingCode(); notify()
    }
    return null
  }
  function sameScope(value) { try { return key !== null && scopeKey(value) === key } catch { return false } }
  function updateScope(value) {
    if (!enabled) return false
    if (!sameScope(value)) { void stop('scope-changed'); return false }
    return true
  }
  function publish(value, next) {
    if (!updateScope(value)) return false
    const why = expired()
    if (why) { void stop(why); return false }
    if (!object(next)) throw new Error('A sanitized companion snapshot is required.')
    if (snapshot.contextId !== next.contextId || next.shareReviewMedia === false || next.available === false) stopMedia()
    snapshot = JSON.parse(serialized(next, LIMITS.snapshotBytes, 'Companion snapshot'))
    heartbeatAt = now()
    return true
  }
  function publicReceipt(record) {
    return record ? { id: record.id, status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt,
      ...(record.error ? { error: record.error } : {}) } : null
  }
  function resolveCommand(value, id, result = {}) {
    if (!enabled || !sameScope(value) || expired()) return false
    const record = receipts.get(id)
    if (!record || !['pending', 'accepted'].includes(record.status)) return false
    const accepted = result?.success === true && result?.status === 'accepted'
    record.status = accepted ? 'accepted' : result?.success === true ? 'completed' : 'rejected'
    // Error strings from native code may contain paths or provider secrets.
    // Only an allowlisted public reason leaves this boundary.
    if (record.status === 'rejected') record.error = ['BUSY', 'STALE_SCOPE', 'NOT_AVAILABLE', 'DECLINED', 'CANCELLED'].includes(result?.code)
      ? result.code : 'The desktop did not accept or complete this message. Check Velorn before retrying.'
    record.updatedAt = now()
    if (!accepted && activeId === id) activeId = null
    notify()
    return true
  }
  function headers(response, type = 'application/json; charset=utf-8') {
    response.setHeader('Content-Type', type)
    response.setHeader('Cache-Control', 'no-store, max-age=0')
    response.setHeader('Pragma', 'no-cache')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  }
  function respond(response, status, value) {
    if (response.destroyed || response.writableEnded) return
    headers(response); response.statusCode = status; response.end(JSON.stringify(value))
  }
  const fail = (response, status, code) => respond(response, status, { success: false, error: code })
  async function body(request, limit = LIMITS.bodyBytes) {
    if ((request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw Object.assign(new Error(), { status: 415, code: 'JSON_REQUIRED' })
    const contentLength = request.headers['content-length']
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) throw Object.assign(new Error(), { status: 413, code: 'BODY_TOO_LARGE' })
    let length = 0; const chunks = []
    for await (const chunk of request) {
      length += chunk.length
      if (length > limit) throw Object.assign(new Error(), { status: 413, code: 'BODY_TOO_LARGE' })
      chunks.push(chunk)
    }
    let value
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw Object.assign(new Error(), { status: 400, code: 'INVALID_JSON' }) }
    if (!object(value)) throw Object.assign(new Error(), { status: 400, code: 'INVALID_REQUEST' })
    return value
  }
  function pairAllowed(address) {
    const cutoff = now() - LIMITS.rateWindowMs
    while (pairAttempts.length && pairAttempts[0].time <= cutoff) pairAttempts.shift()
    if (pairAttempts.length >= LIMITS.pairGlobal || pairAttempts.filter(item => item.address === address).length >= LIMITS.pairPerAddress) return false
    pairAttempts.push({ address, time: now() }); return true
  }
  async function handle(request, response) {
    const requestGeneration = generation
    const current = () => enabled && requestGeneration === generation && !expired()
    const peer = ipv4(request.socket.remoteAddress)?.raw
    if (!allowedPeer(peer) || !allowedHosts.has(request.headers.host)) { fail(response, 403, 'LOCAL_ORIGIN_REQUIRED'); return }
    // A remembered phone can poll while its credential is still loading.
    // Report temporary unavailability without invalidating this startup or
    // returning 401 (which would make the phone discard its valid key).
    if (starting && !enabled) { fail(response, 503, 'DESKTOP_STARTING'); return }
    const why = expired()
    if (why) {
      fail(response, 410, 'SESSION_UNAVAILABLE'); invalidate(why)
      response.once('finish', () => { void closeNetwork() }); return
    }
    const route = request.url
    const mediaRoute = /^\/media\/exports\/([a-f0-9]{48})(\/download)?$/.exec(route)
    const audioRoute = /^\/media\/audio\/([a-f0-9]{48})(\/download)?$/.exec(route)
    const stillRoute = /^\/media\/reviews\/([a-f0-9]{48})$/.exec(route)
    // Finished Create pictures and clips made from this phone connection.
    const createRoute = createBridge && localControl ? /^\/media\/create\/([a-f0-9]{48})(\/download)?$/.exec(route) : null
    if (mediaRoute || stillRoute || audioRoute || createRoute) {
      if (!['GET', 'HEAD'].includes(request.method)) { fail(response, 405, 'METHOD_NOT_ALLOWED'); return }
      const cookie = /(?:^|;\s*)velorn_media=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || '')?.[1]
      if (!token || !mediaCookie || !safeEqual(cookie, mediaCookie) || (localControl && !trustedDevice())) { fail(response, 401, 'UNAUTHORIZED'); return }
      if ((request.headers.origin && request.headers.origin !== `http://${request.headers.host}`)
        || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) { fail(response, 403, 'SAME_ORIGIN_REQUIRED'); return }
      const contextId = snapshot.contextId
      if (stillRoute) {
        let frame
        try { frame=await stillCatalog?.open(stillRoute[1]) } catch {}
        if (!frame) {fail(response,404,'IMAGE_UNAVAILABLE');return}
        if (!current() || snapshot.contextId!==contextId || snapshot.shareReviewMedia===false || snapshot.available===false) {fail(response,410,'SESSION_UNAVAILABLE');return}
        headers(response,frame.mime);response.setHeader('Content-Length',frame.bytes.length);response.statusCode=200
        response.end(request.method==='HEAD' ? undefined : frame.bytes);return
      }
      if (mediaTransfers.size >= 6) { fail(response, 429, 'MEDIA_BUSY'); return }
      let cancelled = false, handle = null, stream = null
      const disconnected = () => cancelled || request.aborted || response.destroyed || response.writableEnded
      const cancel = () => { cancelled = true; stream?.destroy() }
      const transfer = { cancel() { cancel(); response.destroy() } }
      const release = () => { mediaTransfers.delete(transfer); response.removeListener('close', cancel) }
      const closeHandle = async () => {
        const owned = handle; handle = null
        if (owned) await owned.close()
      }
      // Install cancellation tracking and reserve a slot before the asynchronous
      // catalog lookup. A cancelled lookup keeps its slot until it settles; its
      // late file handle must be closed, never piped into an already-dead reply.
      mediaTransfers.add(transfer)
      response.once('close', cancel)
      try {
        if (disconnected()) return
        let file
        try { file = createRoute ? await createBridge.open(createRoute[1]) : audioRoute ? await audioCatalog?.open(audioRoute[1]) : await videoCatalog?.open(mediaRoute[1]) } catch { /* Never send filesystem errors or paths. */ }
        handle = file?.handle || null
        if (disconnected()) return
        if (!file) { fail(response, 404, createRoute ? 'CREATE_RESULT_UNAVAILABLE' : audioRoute ? 'AUDIO_UNAVAILABLE' : 'VIDEO_UNAVAILABLE'); return }
        // A Create result is the person's own request, not shared review media.
        if (!current() || snapshot.contextId !== contextId || (!createRoute && snapshot.shareReviewMedia === false) || snapshot.available === false) { await closeHandle(); fail(response, 410, 'SESSION_UNAVAILABLE'); return }
        const range = require('./mobileCompanionVideos.cjs').byteRange(request.headers.range, file.size)
        headers(response, file.mime)
        response.setHeader('Accept-Ranges', 'bytes')
        if (!range) {
          await closeHandle(); response.statusCode = 416
          response.setHeader('Content-Range', `bytes */${file.size}`); response.end(); return
        }
        response.statusCode = range.partial ? 206 : 200
        response.setHeader('Content-Length', range.end - range.start + 1)
        if (range.partial) response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`)
        if ((createRoute || audioRoute || mediaRoute)[2]) response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}`)
        if (request.method === 'HEAD') { await closeHandle(); response.end(); return }
        stream = handle.createReadStream({ start: range.start, end: range.end, autoClose: true })
        handle = null // The stream now owns and closes the file handle.
        stream.once('close', () => { release(); if (!response.writableEnded) response.destroy() })
        stream.on('error', () => { stream.destroy(); response.destroy() })
        stream.pipe(response)
      } catch (error) {
        stream?.destroy()
        throw error
      } finally {
        try { await closeHandle() } finally { if (!stream) release() }
      }
      return
    }
    if (!apiOnly && Object.hasOwn(FILES, route)) {
      if (!['GET', 'HEAD'].includes(request.method)) { fail(response, 405, 'METHOD_NOT_ALLOWED'); return }
      const file = files.get(route)
      if (!file) { fail(response, 503, 'CLIENT_UNAVAILABLE'); return }
      headers(response, file.type); response.statusCode = 200
      response.end(request.method === 'HEAD' ? undefined : file.bytes); return
    }
    if (![...(!apiOnly ? ['/api/pair'] : []), '/api/state', '/api/message', '/api/unpair', ...(localControl ? ['/api/command'] : []),
      ...(localControl && createBridge ? ['/api/create', '/api/create/photo'] : [])].includes(route)) { fail(response, 404, 'NOT_FOUND'); return }
    if (request.headers.origin !== `http://${request.headers.host}`) { fail(response, 403, 'SAME_ORIGIN_REQUIRED'); return }
    if (route === '/api/pair') {
      if (request.method !== 'POST') { fail(response, 405, 'METHOD_NOT_ALLOWED'); return }
      if (!pairAllowed(peer)) { fail(response, 429, 'PAIRING_RATE_LIMIT'); return }
      const input = await body(request)
      if (!current()) { fail(response, 410, 'SESSION_UNAVAILABLE'); return }
      if (Object.keys(input).some(item => item !== 'code') || typeof input.code !== 'string' || input.code.length !== 12) { fail(response, 400, 'INVALID_PAIRING_CODE'); return }
      if (token || !pairingCode || !safeEqual(input.code, pairingCode)) { fail(response, 401, 'PAIRING_FAILED'); return }
      // There is no await between consuming the one-use code and minting token.
      if (pairing) { fail(response, 409, 'PAIRING_IN_PROGRESS'); return }
      pairing = true
      const nextToken = randomBytes(32).toString('hex')
      try {
        if (localControl) {
          const record = { version: 2, digest: digest(nextToken), expiresAt: null }
          await deviceStore.write(record)
          if (!current()) { await deviceStore.forget(); fail(response, 410, 'SESSION_UNAVAILABLE'); return }
          remembered = record
        }
        token = nextToken; pairingCode = null; notify()
      } finally { pairing = false }
      respond(response, 200, { success: true, token, expiresAt: sessionExpiresAt, transport,
        remoteApprovals: localControl, fullAccess: snapshot.fullAccess === true }); return
    }
    const supplied = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '')?.[1]
    const authenticated = localControl ? supplied && trustedDevice() && safeEqual(digest(supplied), remembered.digest)
      : token && safeEqual(request.headers.authorization, `Bearer ${token}`)
    if (!authenticated) { fail(response, 401, 'UNAUTHORIZED'); return }
    if (route === '/api/unpair') {
      if (request.method !== 'POST') { fail(response, 405, 'METHOD_NOT_ALLOWED'); return }
      if (Object.keys(await body(request)).length) { fail(response, 400, 'INVALID_REQUEST'); return }
      if (!current()) { fail(response, 410, 'SESSION_UNAVAILABLE'); return }
      if (localControl) { await deviceStore.forget(); remembered = null }
      // Flush acknowledgement before closing the authenticated connection. The
      // finish callback invalidates authority synchronously, including pending
      // native approval callbacks, then closes the listener. Never just forget
      // the phone's token while leaving the desktop session usable.
      response.once('finish', () => { if (requestGeneration === generation) void stop('unpaired') })
      respond(response, 200, { success: true }); return
    }
    if (route === '/api/create' || route === '/api/create/photo') {
      // Create for the paired phone. Authenticated above like every other API
      // route; bound to the publication the phone last read, like a command.
      if (request.method !== 'POST') { fail(response, 405, 'METHOD_NOT_ALLOWED'); return }
      const photo = route === '/api/create/photo'
      const input = await body(request, photo ? LIMITS.createPhotoBodyBytes : LIMITS.bodyBytes)
      if (!current() || snapshot.available === false) { fail(response, 410, 'SESSION_UNAVAILABLE'); return }
      const { contextId, ...fields } = input
      if (typeof contextId !== 'string' || contextId !== snapshot.contextId) { fail(response, 409, 'STALE_CONTEXT'); return }
      const owner = generation
      let result
      try { result = photo ? await createBridge.upload(fields) : await createBridge.handle(fields) } catch { result = null }
      if (!enabled || owner !== generation || !current()) { fail(response, 410, 'SESSION_UNAVAILABLE'); return }
      if (!object(result) || typeof result.success !== 'boolean') { fail(response, 500, 'CREATE_FAILED'); return }
      // A refusal is an answer, not a transport error: the phone shows its wording.
      respond(response, 200, { success: true, create: result }); return
    }
    if (route === '/api/state') {
      if (!['GET', 'POST'].includes(request.method)) { fail(response, 405, 'METHOD_NOT_ALLOWED'); return }
      if (request.method === 'POST' && Object.keys(await body(request)).length) { fail(response, 400, 'INVALID_REQUEST'); return }
      if (!current()) { fail(response, 410, 'SESSION_UNAVAILABLE'); return }
      const contextId = snapshot.contextId
      let videos = [], videoReview = { state: 'unavailable', count: 0 }
      let audio = [], audioReview = { state: 'unavailable', count: 0 }
      try {
        audio = await audioCatalog?.list() || []
        audioReview = audioCatalog?.getStatus?.() || audioReview
      } catch { audioReview = { state: 'lookup-failed', count: 0 } }
      let reviews = snapshot.reviews || [], reviewHistoryError = ''
      try {
        videos = await videoCatalog?.list() || []
        videoReview = videoCatalog?.getStatus?.() || { state: videos.length ? 'ready' : 'no-exports', count: videos.length }
      } catch { videoReview = { state: 'lookup-failed', count: 0 } }
      if (stillCatalog) {
        try {
          const saved=await stillCatalog.list(), records=new Map(reviews.map(frame=>[frame.id,frame]))
          for (const frame of saved) records.set(frame.id,frame)
          reviews=[...records.values()].slice(-100)
        } catch {reviewHistoryError='Saved review images could not be loaded. They have not been deleted.'}
      }
      if (!current()) { fail(response, 410, 'SESSION_UNAVAILABLE'); return }
      if (snapshot.contextId !== contextId) { videos = []; reviews=[]; audio=[]; audioReview = { state: 'project-changing', count: 0 }; videoReview = { state: 'project-changing', count: 0 } }
      // Permission can change during catalog IO without changing the chat ID.
      // Never return the earlier inline stills or file grants after withdrawal.
      if (snapshot.shareReviewMedia === false || snapshot.available === false) {
        videos=[];reviews=[];audio=[]
        videoReview={state:snapshot.shareReviewMedia === false ? 'sharing-off' : 'desktop-busy',count:0}
        audioReview={...videoReview}
      }
      response.setHeader('Set-Cookie', `velorn_media=${mediaCookie}; Path=/media/; HttpOnly; SameSite=Strict`)
      respond(response, 200, { success: true, transport, snapshot: { ...snapshot, reviews, reviewHistoryError, videos, videoReview, audio, audioReview },
        busy: activeId !== null || snapshot.busy === true, receipt: publicReceipt(receipts.get(lastReceiptId)),
        receipts: [...receipts.values()].map(publicReceipt), remoteApprovals: localControl, fullAccess: snapshot.fullAccess === true,
        ...(localControl && createBridge ? { create: { supported: true, version: 1 } } : {}) }); return
    }
    if (request.method !== 'POST') { fail(response, 405, 'METHOD_NOT_ALLOWED'); return }
    const input = await body(request)
    if (route === '/api/command' && localControl) {
      if (!current()) { fail(response, 410, 'SESSION_UNAVAILABLE'); return }
      const fingerprint = digest(JSON.stringify(input)), existing = receipts.get(input.id)
      if (existing) {
        if (existing.fingerprint !== fingerprint) { fail(response, 409, 'ID_REUSED'); return }
        respond(response, 200, { success: true, duplicate: true, receipt: publicReceipt(existing) }); return
      }
      let command
      try { command = require('./mobileCompanionControl.cjs').validateCommand(input, snapshot) }
      catch (error) { fail(response, 409, error.message); return }
      if (activeId && !['approval', 'native-approval', 'stop'].includes(command.kind)) { fail(response, 409, 'BUSY'); return }
      if (!roomForReceipt()) { fail(response, 429, 'SESSION_MESSAGE_LIMIT'); return }
      const record = { id: input.id, fingerprint, status: 'pending', createdAt: now(), updatedAt: now() }
      receipts.set(input.id, record); lastReceiptId = input.id
      if (!['approval', 'native-approval', 'stop'].includes(command.kind)) activeId = input.id
      const owner = generation, commandScope = scope, signal = controller.signal
      respond(response, 202, { success: true, receipt: publicReceipt(record) })
      Promise.resolve().then(() => {
        if (!current() || signal.aborted) return { success: false }
        // Check again after acceptance, before dispatch, against the latest publication.
        require('./mobileCompanionControl.cjs').validateCommand(command, snapshot)
        return onCommand({ ...command, scope: commandScope, signal })
      }).then(result => {
        if (enabled && owner === generation && !signal.aborted) resolveCommand(commandScope, input.id, result)
      }, () => { if (enabled && owner === generation && !signal.aborted) resolveCommand(commandScope, input.id, { success: false }) })
      return
    }
    if (localControl) { fail(response, 400, 'USE_CONTEXT_COMMAND'); return }
    if (Object.keys(input).some(item => !['id', 'text'].includes(item)) || !validId(input.id)
      || typeof input.text !== 'string' || !input.text.trim() || input.text.length > LIMITS.textCharacters
      || /\u0000/.test(input.text)) { fail(response, 400, 'INVALID_MESSAGE'); return }
    // Native scope may have changed while a slow client was uploading.
    if (!current()) { fail(response, 410, 'SESSION_UNAVAILABLE'); return }
    const fingerprint = createHash('sha256').update(input.text).digest('hex')
    const existing = receipts.get(input.id)
    if (existing) {
      if (existing.fingerprint !== fingerprint) { fail(response, 409, 'ID_REUSED'); return }
      respond(response, 200, { success: true, duplicate: true, receipt: publicReceipt(existing) }); return
    }
    if (activeId || snapshot.busy === true) { fail(response, 409, 'BUSY'); return }
    if (receipts.size >= LIMITS.receipts) { fail(response, 429, 'SESSION_MESSAGE_LIMIT'); return }
    const record = { id: input.id, fingerprint, status: 'pending', createdAt: now(), updatedAt: now() }
    receipts.set(input.id, record); activeId = input.id; lastReceiptId = input.id
    const owner = generation, commandScope = JSON.parse(JSON.stringify(scope)), signal = controller.signal
    // Record acceptance before any asynchronous dispatch. A dropped HTTP reply
    // and retry cannot execute the message again.
    respond(response, 202, { success: true, receipt: publicReceipt(record) })
    Promise.resolve().then(() => {
      if (!enabled || owner !== generation || signal.aborted || expired()) return null
      return onMessage({ id: input.id, text: input.text, scope: commandScope, signal })
    }).then(result => {
      if (enabled && owner === generation && !signal.aborted) resolveCommand(commandScope, input.id, result)
    }, () => {
      if (enabled && owner === generation && !signal.aborted) resolveCommand(commandScope, input.id, { success: false })
    })
  }
  async function start(nextScope, initialSnapshot = {}) {
    if (starting || enabled || server) throw new Error('The companion is already enabled or starting.')
    if (shutdown) await shutdown
    starting = true
    const owner = ++generation
    try {
      const nextKey = scopeKey(nextScope)
      if (!object(initialSnapshot)) throw new Error('A sanitized companion snapshot is required.')
      const nextSnapshot = JSON.parse(serialized(initialSnapshot, LIMITS.snapshotBytes, 'Companion snapshot'))
      const nextFiles = new Map()
      if (!apiOnly) {
        const root = await fs.realpath(clientRoot)
        for (const [route, [name, type]] of Object.entries(FILES)) {
          const filename = await fs.realpath(path.join(root, name))
          if (path.dirname(filename) !== root) throw new Error('Companion client files must stay in the configured directory.')
          const stats = await fs.stat(filename)
          if (!stats.isFile() || stats.size > LIMITS.assetBytes) throw new Error('Companion client file is unavailable or too large.')
          const bytes = await fs.readFile(filename)
          if (bytes.length > LIMITS.assetBytes) throw new Error('Companion client file is too large.')
          nextFiles.set(route, { bytes, type })
        }
      }
      if (owner !== generation) throw new Error('Companion startup was cancelled.')
      const interfaces = apiOnly ? [] : Object.values(networkInterfaces()).flat().filter(Boolean)
      const addresses = [...new Set(interfaces.filter(item => (item.family === 'IPv4' || item.family === 4) && privateAddress(item.address)).map(item => item.address))]
      const nextServer = http.createServer((request, response) => {
        handle(request, response).catch(error => {
          request.resume(); fail(response, error?.status || 500, error?.code || 'REQUEST_FAILED')
        })
      })
      nextServer.headersTimeout = 10000; nextServer.requestTimeout = 15000; nextServer.keepAliveTimeout = 1000; nextServer.maxConnections = 32
      nextServer.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
      nextServer.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n') })
      server = nextServer
      await new Promise((resolve, reject) => {
        nextServer.once('error', reject)
        nextServer.listen(port, host, () => { nextServer.removeListener('error', reject); resolve() })
      })
      if (owner !== generation) { await closeNetwork(); throw new Error('Companion startup was cancelled.') }
      nextServer.on('error', () => { void stop('listener-error') })
      boundPort = nextServer.address().port
      const accessible = host === '0.0.0.0' ? addresses : addresses.filter(address => address === host)
      urls = accessible.map(address => `http://${address}:${boundPort}/`)
      localUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${boundPort}`
      allowedHosts = new Set([...(host === '0.0.0.0' ? ['127.0.0.1', ...addresses] : [host])].map(address => `${address}:${boundPort}`))
      key = nextKey; scope = JSON.parse(JSON.stringify(nextScope)); snapshot = nextSnapshot; files = nextFiles
      if (!apiOnly) rotatePairingCode()
      remembered = localControl ? await deviceStore.read() : null
      if (remembered?.version === 1) {
        await deviceStore.write({ digest: remembered.digest })
        remembered = { version: 2, digest: remembered.digest, expiresAt: null }
      }
      if (owner !== generation) throw new Error('Companion startup was cancelled.')
      token = remembered ? 'remembered-device' : null
      if (remembered) pairingCode = null
      sessionExpiresAt = localControl ? null : now() + LIMITS.sessionMs
      heartbeatAt = now(); controller = new AbortController(); reason = null; enabled = true
      mediaCookie = randomBytes(32).toString('hex')
      receipts = new Map(); activeId = null; lastReceiptId = null; pairAttempts.length = 0
      timer = setInterval(() => { const why = expired(); if (why) void stop(why) }, 1000); timer.unref?.()
      notify(); return getStatus()
    } catch {
      await stop('startup-failed')
      throw new Error(apiOnly ? 'The phone connection could not start. Check local device storage and the loopback port.'
        : 'The mobile companion could not start. Check the client files and local port.')
    } finally { starting = false }
  }
  // Native enrollment only. Never exposed as an HTTP route or renderer IPC.
  // Every guided device has its own listener/store; a live device is not replaced.
  async function pairApprovedDevice({ isCurrent = () => true } = {}) {
    const owner = generation
    if (!localControl || !enabled || token || pairing || !isCurrent() || expired()) throw Error('Phone approval is no longer current.')
    pairing = true
    const nextToken = randomBytes(32).toString('hex')
    try {
      const record = { version: 2, digest: digest(nextToken), expiresAt: null }
      await deviceStore.write(record)
      if (!enabled || owner !== generation || !isCurrent() || expired()) {
        await deviceStore.forget(); throw Error('Phone approval is no longer current.')
      }
      remembered = record; token = nextToken; pairingCode = null; notify()
      return nextToken
    } finally { pairing = false }
  }
  return { start, stop, revoke: stop, dispose: stop, getStatus, publish, updateScope, resolveCommand, pairApprovedDevice,
    isCurrentScope: value => enabled && sameScope(value) && !expired() }
}

module.exports = { createMobileCompanionServer, LIMITS, TRANSPORT, privateAddress, allowedPeer }
