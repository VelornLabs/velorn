'use strict'
// Per-turn desktop gateway: a fresh local capability, not account credentials,
// reaches the engine. Authority lasts only as long as the native desktop lease.
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { StringDecoder } = require('node:string_decoder')
const { parseAdmissionProgress } = require('./veloAdmissionWait.cjs')
const MODEL = 'gpt-6-luna'
const failure = () => Object.assign(new Error('The private Velo engine connection is unavailable. Its server activation may have expired. No message was sent or fallback selected.'), { code: 'VELO_PREVIEW_UNAVAILABLE' })

async function startDesktopGateway({ assertAuthorized, socketPath, capability, stateRoot, signal, requestImpl = http.request }) {
  assertAuthorized();
  const value = { capability };
  const launchSha256 = require('node:crypto').randomUUID();
  let closed = false, stopped = false, server;
  const active = new Set()
  const waitingListeners = new Set()
  const progress = value => { for (const listener of waitingListeners) { try { listener(value) } catch {} } }
  const authorized = () => !closed && !stopped && !signal?.aborted
  function stop() {
    if (stopped) return
    stopped = true
  }
  const assertCurrent = () => { assertAuthorized(); if (!authorized()) throw failure(); return true }
  const unix = (method, requestPath, callback, extra = {}) => requestImpl({ socketPath, method, path: requestPath,
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
  fs.writeFileSync(catalogPath, catalogText, { flag: 'wx', mode: 0o600 })

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
  const abort = () => { stop(); for (const item of active) item.upstream.destroy() }
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, token: value.capability, catalogPath, fixture: false,
    assertCurrent,
    subscribeWaiting(listener) { waitingListeners.add(listener); return () => waitingListeners.delete(listener) },
    async close() {
      if (closed) return; closed = true; signal?.removeEventListener('abort', abort)
      waitingListeners.clear()
      for (const item of active) { if (!item.completed()) stop(); item.upstream.destroy() }
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      fs.unlinkSync(catalogPath)
    },
  }
}

module.exports = { startDesktopGateway }

