'use strict'
// One call to the Velorn network queue on the connection service. Fixed paths
// only, this computer's own registered credential, bounded sizes and time. The
// address always comes from native configuration, never from a job or a reply.
const http = require('node:http')
const https = require('node:https')

const ROUTES = new Set(['host/heartbeat', 'host/claim', 'host/input', 'host/progress', 'host/output', 'host/finish', 'host/report', 'host/evidence', 'review/evidence',
  'hosts', 'submit', 'job/input', 'job/status', 'job/output', 'job/cancel', 'job/done',
  'own/submit', 'own/graph', 'own/withdraw', 'own/status', 'workflow/report', 'review/list', 'review/example', 'review/graph', 'review/try', 'review/decide', 'review/ban', 'review/dismiss'])
const MAX_REQUEST = 300 * 1024, MAX_RESPONSE = 400 * 1024, DEADLINE_MS = 20000
const unavailable = (code = 'GPU_NETWORK_UNAVAILABLE', message = 'The Velorn network could not be reached.') => Object.assign(new Error(message), { code, publicMessage: message })

// Resolves to the service's JSON answer. A refusal by the service is an answer:
// { ok: false, error, status }. Only a failure to get any answer rejects.
function requestGpuNetwork({ url, token, body, signal, allowLocalTest = false }) {
  return new Promise((resolve, reject) => {
    let contents
    try {
      const route = url instanceof URL && url.pathname.startsWith('/account/desktop/gpu/') ? url.pathname.slice('/account/desktop/gpu/'.length) : ''
      if (!ROUTES.has(route) || url.username || url.password || url.search || url.hash
        || !(url.protocol === 'https:' || (allowLocalTest && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
        || !/^[A-Za-z0-9_-]{43}$/.test(token || '')) throw unavailable('GPU_NETWORK_REJECTED')
      contents = JSON.stringify(body)
      if (!contents || Buffer.byteLength(contents) > MAX_REQUEST) throw unavailable('GPU_NETWORK_LIMIT', 'That is too large to send through the Velorn network.')
      if (signal?.aborted) throw unavailable('GPU_NETWORK_CANCELLED', 'Stopped.')
    } catch (error) { reject(error?.publicMessage ? error : unavailable('GPU_NETWORK_REJECTED')); return }
    let settled = false
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(deadline); error ? reject(error) : resolve(value) }
    // Node's HTTP client does not follow redirects.
    const request = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(contents) } }, response => {
      if (!/^application\/json(?:;|$)/i.test(response.headers['content-type'] || '') || Number(response.headers['content-length'] || 0) > MAX_RESPONSE) {
        response.destroy(); finish(unavailable()); return
      }
      let size = 0; const chunks = []
      response.on('data', chunk => { size += chunk.length; if (size > MAX_RESPONSE) { response.destroy(); finish(unavailable()) } else chunks.push(chunk) })
      response.on('error', () => finish(unavailable()))
      response.on('end', () => {
        let value = null
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { value = null }
        if (value === null || typeof value !== 'object' || Array.isArray(value)) { finish(unavailable()); return }
        if (response.statusCode === 200 && value.ok === true) finish(null, value)
        else finish(null, { ok: false, error: typeof value.error === 'string' ? value.error.slice(0, 40) : 'unavailable', status: response.statusCode })
      })
    })
    const deadline = setTimeout(() => request.destroy(unavailable()), DEADLINE_MS)
    deadline.unref?.()
    request.on('error', () => finish(signal?.aborted ? unavailable('GPU_NETWORK_CANCELLED', 'Stopped.') : unavailable()))
    request.end(contents)
  })
}

module.exports = { requestGpuNetwork, ROUTES, MAX_REQUEST, MAX_RESPONSE }
