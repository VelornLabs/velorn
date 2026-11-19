/**
 * Background thread that hands export frames to the main process.
 *
 * Posting an 8 MB frame across processes copies it, and that copy costs
 * several milliseconds. Doing it here keeps it off the thread that renders
 * the export. The page transfers each frame buffer in (no copy), this
 * worker posts it down the port to the main process (the one copy), then
 * gives the buffer straight back so the page can reuse it.
 *
 * Messages in:  { type: 'port' } with the port, then { type: 'frame', id, buffer }.
 * Messages out: { type: 'ready' } | { type: 'recycle', buffer }
 *               | { type: 'ack', id, success, error } | { type: 'failed', error }.
 */
let port = null

self.onmessage = (event) => {
  const data = event.data
  if (data?.type === 'port') {
    port = event.ports[0]
    port.onmessage = (message) => {
      const reply = message.data
      if (reply?.type === 'ack') {
        self.postMessage({ type: 'ack', id: reply.id, success: reply.success === true, error: reply.error || null })
      } else if (reply?.type === 'ready') {
        self.postMessage({ type: 'ready' })
      } else if (reply?.type === 'error') {
        self.postMessage({ type: 'failed', error: reply.error || 'Frame pipe port was refused.' })
      }
    }
    return
  }
  if (data?.type === 'frame') {
    try {
      if (!port) throw new Error('Frame pipe port is not connected.')
      port.postMessage({ id: data.id, buffer: data.buffer })
    } catch (error) {
      self.postMessage({ type: 'ack', id: data.id, success: false, error: error?.message || String(error) })
    }
    self.postMessage({ type: 'recycle', buffer: data.buffer }, [data.buffer])
  }
}
