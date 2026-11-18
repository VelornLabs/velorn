'use strict'

// Private Linux test transport only. The Unix-socket owner holds real account
// credentials; this process receives only a short-lived local capability.
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { createHash } = require('node:crypto')
const { StringDecoder } = require('node:string_decoder')
const { parseAdmissionProgress } = require('./veloAdmissionWait.cjs')
const MODEL = 'gpt-6-luna'
const MODE = 'owner-metered-test'
const failure = (code = 'VELO_OWNER_TEST_UNAVAILABLE') => Object.assign(new Error('The private owner test is unavailable. No automatic retry or fallback was made.'), { code })
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exact = (value, fields) => plain(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))

function validateOwnerLaunch(value, now = Date.now()) {
  if (!exact(value, ['version', 'mode', 'socketPath', 'capability', 'issuedAt', 'expiresAt', 'preflight']) || value.version !== 1 || value.mode !== MODE
    || value.socketPath !== '/bridge/upstream.sock' || !/^[a-f0-9]{64}$/.test(value.capability || '')
    || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.issuedAt > now + 5000 || value.expiresAt <= now || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > 600000
    || !exact(value.preflight, ['checkedAt', 'remainingMicroUsd', 'model', 'reasoningEffort'])
    || !Number.isSafeInteger(value.preflight.checkedAt) || value.preflight.checkedAt > value.issuedAt + 5000
    || value.preflight.checkedAt < value.issuedAt - 60000 || value.preflight.model !== MODEL || value.preflight.reasoningEffort !== 'low'
    || !Number.isSafeInteger(value.preflight.remainingMicroUsd) || value.preflight.remainingMicroUsd < 0 || value.preflight.remainingMicroUsd > 1000000) throw failure()
  return Object.freeze({ ...value, preflight: Object.freeze({ ...value.preflight }) })
}

function privateFile(file, maxBytes) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > maxBytes) throw failure()
  return fs.readFileSync(file)
}

function readOwnerLaunch({ launchPath = '/bridge/launch.json', stateRoot = '/state/owner-metered', now = Date.now } = {}) {
  const bytes = privateFile(launchPath, 8192), value = validateOwnerLaunch(JSON.parse(bytes), now())
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  const info = fs.lstatSync(stateRoot)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || fs.realpathSync(stateRoot) !== stateRoot) throw failure()
  const launchSha256 = createHash('sha256').update(bytes).digest('hex')
  const receiptPath = path.join(stateRoot, `accepted-${launchSha256}.json`)
  if (fs.existsSync(receiptPath)) {
    const receipt = JSON.parse(privateFile(receiptPath, 1024))
    if (!exact(receipt, ['version', 'launchSha256', 'acceptedAt']) || receipt.version !== 1 || receipt.launchSha256 !== launchSha256
      || !Number.isSafeInteger(receipt.acceptedAt) || receipt.acceptedAt < value.issuedAt - 5000
      || receipt.acceptedAt > value.preflight.checkedAt + 60000 || receipt.acceptedAt > now() + 5000) throw failure()
  } else {
    // A prior successful launch may reopen within the same short approval
    // window. A stale preflight cannot authorize a new launch by itself.
    if (now() - value.issuedAt > 60000 || now() - value.preflight.checkedAt > 60000) throw failure()
    fs.writeFileSync(receiptPath, JSON.stringify({ version: 1, launchSha256, acceptedAt: now() }), { flag: 'wx', mode: 0o600 })
  }
  return Object.freeze({ value, launchSha256, stateRoot })
}

async function startOwnerTestGateway({ assertIsolation, launch = readOwnerLaunch(), now = Date.now, requestImpl = http.request } = {}) {
  if (typeof assertIsolation !== 'function' || assertIsolation() !== true) throw failure()
  const { value, launchSha256, stateRoot } = launch
  validateOwnerLaunch(value, now())
  const stoppedPath = path.join(stateRoot, `stopped-${launchSha256}.json`)
  let closed = false, stopped = fs.existsSync(stoppedPath), server
  const active = new Set()
  const waitingListeners = new Set()
  const progress = value => { for (const listener of waitingListeners) { try { listener(value) } catch {} } }
  const authorized = () => !closed && !stopped && now() < value.expiresAt && value.preflight.remainingMicroUsd > 0
  function stop() {
    if (stopped) return
    stopped = true
    if (!fs.existsSync(stoppedPath)) fs.writeFileSync(stoppedPath, JSON.stringify({ version: 1, launchSha256, reason: 'owner_test_stopped' }), { flag: 'wx', mode: 0o600 })
  }
  const assertCurrent = () => { if (assertIsolation() !== true || !authorized()) throw failure(); return true }
  const unix = (method, requestPath, callback, extra = {}) => requestImpl({ socketPath: '/bridge/upstream.sock', method, path: requestPath,
    headers: { authorization: `Bearer ${value.capability}`, 'content-type': 'application/json', ...extra } }, callback)
  assertCurrent()
  // Fetch the authenticated full catalog from the owner. No synthetic or
  // installed-personal-Codex fallback and no remote URL is accepted here.
  const catalogText = await new Promise((resolve, reject) => {
    const request = unix('GET', '/models?client_version=0.165.0', response => {
      if (response.statusCode !== 200 || response.headers['content-type']?.split(';')[0] !== 'application/json') { response.destroy(); reject(failure()); return }
      let size = 0; const chunks = []
      response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { response.destroy(); reject(failure()) } else chunks.push(chunk) })
      response.once('error', () => reject(failure()))
      response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    request.setTimeout(15000, () => request.destroy())
    request.once('error', () => reject(failure()))
    request.once('close', () => { if (!request.res?.complete) reject(failure()) })
    request.end()
  })
  assertCurrent()
  const catalog = JSON.parse(catalogText)
  if (!Array.isArray(catalog.models) || catalog.models.length !== 1 || catalog.models[0]?.slug !== MODEL
    || typeof catalog.models[0]?.base_instructions !== 'string' || !catalog.models[0].base_instructions
    || !catalog.models[0]?.supported_reasoning_levels?.some(level => level.effort === 'low')) throw failure()
  const catalogPath = path.join(stateRoot, `catalog-${launchSha256}.json`)
  if (fs.existsSync(catalogPath)) {
    if (privateFile(catalogPath, 1024 * 1024).toString('utf8') !== catalogText) throw failure()
  } else fs.writeFileSync(catalogPath, catalogText, { flag: 'wx', mode: 0o600 })

  server = http.createServer((request, response) => {
    if (!authorized()) { response.writeHead(503); response.end(); return }
    if (request.headers.origin || request.headers.cookie || request.headers.host !== `127.0.0.1:${server.address().port}`
      || request.method !== 'POST' || request.url !== '/v1/responses'
      || request.headers.authorization !== `Bearer ${value.capability}`) { response.writeHead(403); response.end(); return }
    let completed = false
    const entry = { upstream: null, completed: () => completed }
    const upstream = unix('POST', '/responses', incoming => {
      response.writeHead(incoming.statusCode, { 'content-type': incoming.headers['content-type'] || 'application/json', 'cache-control': 'no-store' })
      if (incoming.statusCode !== 200) stop()
      const decoder = new StringDecoder('utf8'); let lines = ''
      incoming.on('data', chunk => {
        lines += decoder.write(chunk)
        let newline
        while ((newline = lines.indexOf('\n')) !== -1) {
          const line = lines.slice(0, newline).trim(); lines = lines.slice(newline + 1)
          const waiting = parseAdmissionProgress(line)
          if (waiting) { progress(waiting); continue }
          if (!line.startsWith('data:')) continue
          try {
            const event = JSON.parse(line.slice(5).trim())
            if (event.type === 'response.completed') completed = true
            if (['error', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type)) stop()
          } catch {}
        }
        if (lines.length > 16 * 1024 * 1024) { stop(); incoming.destroy(); response.destroy() }
      })
      incoming.once('end', () => { if (!completed) stop() })
      incoming.once('error', () => { if (!completed) stop(); response.destroy() })
      incoming.pipe(response)
    }, request.headers['content-encoding'] ? { 'content-encoding': request.headers['content-encoding'] } : {})
    entry.upstream = upstream; active.add(entry)
    upstream.once('close', () => active.delete(entry))
    upstream.once('error', () => { if (!completed) stop(); if (!response.headersSent) response.writeHead(502); response.end() })
    request.once('aborted', () => { if (!completed) stop(); upstream.destroy() })
    response.once('close', () => { if (!response.writableFinished) { if (!completed) stop(); upstream.destroy() } })
    request.pipe(upstream)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const expiry = setTimeout(() => { for (const item of active) { if (!item.completed()) stop(); item.upstream.destroy() } }, Math.max(1, value.expiresAt - now())); expiry.unref()
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, token: value.capability, catalogPath, fixture: false,
    assertCurrent,
    subscribeWaiting(listener) { waitingListeners.add(listener); return () => waitingListeners.delete(listener) },
    status: async () => ({ model: MODEL, reasoningEffort: 'low', fixture: false, ownerMeteredTest: true,
      liveProviderEnabled: true, available: authorized(), revoked: !authorized(), remainingMicroUsd: value.preflight.remainingMicroUsd,
      balanceSource: 'owner-preflight', balanceCheckedAt: value.preflight.checkedAt, balanceIsLive: false }),
    async close() {
      closed = true; clearTimeout(expiry)
      waitingListeners.clear()
      for (const item of active) { if (!item.completed()) stop(); item.upstream.destroy() }
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

module.exports = { validateOwnerLaunch, readOwnerLaunch, startOwnerTestGateway }
