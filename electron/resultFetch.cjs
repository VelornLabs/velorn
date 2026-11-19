'use strict'
// Fetching a finished result from an address that is not Comfy's own.
//
// Electron's `net.fetch` throws an uncaught TypeError ("Cannot convert argument to a ByteString")
// when a server sends a header whose value has a character above 255, and the fetch then never
// settles. Seen on 2026-11-19 from a model maker's storage: the clip had been made and paid for,
// and Velorn waited for it forever. `net.request` hands the headers over as plain strings, so a
// result download goes through it, and the header values are cleaned here before a Response is
// built. It still uses Chromium's network stack, so a system proxy keeps working.
const clean = value => String(value).replace(/[^\x20-\x7e\t]/g, '')

function createResultFetch(net) {
  return function resultFetch(url, { method = 'GET', signal, redirect = 'follow' } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn, value) => { if (!settled) { settled = true; fn(value) } }
      let request
      try { request = net.request({ url: String(url), method, redirect: redirect === 'follow' ? 'follow' : 'manual', credentials: 'omit', cache: 'no-store' }) }
      catch (error) { reject(error); return }
      const stop = () => { try { request.abort() } catch {} }
      const aborted = () => { stop(); settle(reject, Object.assign(new Error('The download was stopped.'), { name: 'AbortError' })) }
      if (signal) { if (signal.aborted) { aborted(); return } signal.addEventListener('abort', aborted, { once: true }) }
      request.on('redirect', (status, _method, location) => {
        if (redirect === 'follow') { try { request.followRedirect() } catch {} ; return }
        // Not followed here: the caller checks the new address first.
        stop()
        settle(resolve, new Response(null, { status: status >= 300 && status < 400 ? status : 302, headers: { location: clean(location) } }))
      })
      request.on('response', response => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(response.headers || {})) {
          for (const item of [].concat(value)) { try { headers.append(name, clean(item)) } catch {} }
        }
        const status = Number(response.statusCode) || 0
        if (status < 200 || status > 599) { stop(); settle(reject, new Error('The server answered in a way that could not be read.')); return }
        const empty = status === 204 || status === 205 || status === 304
        const body = empty ? null : new ReadableStream({
          start(controller) {
            let open = true
            const close = fn => { if (open) { open = false; fn() } }
            response.on('data', chunk => { if (open) controller.enqueue(new Uint8Array(chunk)) })
            response.on('end', () => close(() => controller.close()))
            response.on('error', error => close(() => controller.error(error)))
            response.on('aborted', () => close(() => controller.error(new Error('The download was cut off.'))))
          },
          cancel() { stop() },
        })
        settle(resolve, new Response(body, { status, headers }))
      })
      request.on('error', error => settle(reject, error))
      request.end()
    })
  }
}

module.exports = { createResultFetch, clean }
