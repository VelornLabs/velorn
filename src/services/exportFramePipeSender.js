/**
 * Sends rendered export frames to the FFmpeg pipe in the main process.
 *
 * Two routes, same result:
 *   - 'port': frames go through a background worker and a message port, so
 *     the export's own thread only hands over a buffer (see
 *     exportFramePipeWorker.js). Used when the app supports it.
 *   - 'invoke': the original electronAPI.writeFrameToPipe call. Always
 *     available; used as the fallback.
 *
 * Kill switch: localStorage 'comfystudio-export-frame-port' = '0'.
 */
const PORT_READY_TIMEOUT_MS = 2000
// Buffers kept for reuse: the frames in flight plus the one being filled.
const MAX_POOLED_BUFFERS = 6

const isFramePortEnabled = () => {
  try {
    return typeof localStorage === 'undefined' || localStorage.getItem('comfystudio-export-frame-port') !== '0'
  } catch {
    return true
  }
}

const createInvokeSender = (sessionId, api) => ({
  mode: 'invoke',
  // No buffer of our own: the caller's buffer is copied during the call.
  takeFrameBuffer: () => null,
  send: (arrayBuffer) => api.writeFrameToPipe(sessionId, arrayBuffer),
  dispose: () => {},
})

/**
 * @param {string} sessionId   Pipe session from electronAPI.startFramePipe.
 * @param {number} frameBytes  Size of one raw frame (width * height * 4).
 * @returns {Promise<{mode: string, takeFrameBuffer: Function, send: Function, dispose: Function}>}
 */
export const createFramePipeSender = async (sessionId, frameBytes, {
  api = globalThis.window?.electronAPI,
  host = globalThis,
  createWorker = () => new Worker(new URL('./exportFramePipeWorker.js', import.meta.url), { type: 'module' }),
} = {}) => {
  const fallback = () => createInvokeSender(sessionId, api)
  if (!api?.framePipePortSupported || !isFramePortEnabled()
    || typeof host.MessageChannel !== 'function' || typeof host.postMessage !== 'function') {
    return fallback()
  }

  let worker = null
  let channel = null
  try {
    worker = createWorker()
    channel = new host.MessageChannel()
  } catch {
    worker?.terminate?.()
    return fallback()
  }

  const pool = []
  const pending = new Map() // frame id -> resolve
  let nextId = 1
  let failure = null
  let onReady = null

  const failAll = (error) => {
    failure = failure || error || 'Frame pipe worker stopped.'
    for (const resolve of pending.values()) resolve({ success: false, error: failure })
    pending.clear()
    onReady?.(false)
  }
  worker.onmessage = (event) => {
    const data = event.data
    if (data?.type === 'recycle') {
      if (pool.length < MAX_POOLED_BUFFERS && data.buffer?.byteLength === frameBytes) pool.push(data.buffer)
    } else if (data?.type === 'ack') {
      const resolve = pending.get(data.id)
      pending.delete(data.id)
      resolve?.(data.success ? { success: true } : { success: false, error: data.error })
    } else if (data?.type === 'ready') {
      onReady?.(true)
    } else if (data?.type === 'failed') {
      failAll(data.error)
    }
  }
  worker.onerror = (event) => failAll(event?.message || 'Frame pipe worker failed.')

  const ready = await new Promise((resolve) => {
    const timer = host.setTimeout(() => resolve(false), PORT_READY_TIMEOUT_MS)
    onReady = (ok) => { host.clearTimeout(timer); resolve(ok) }
    try {
      // Main process end first (through the preload), then our end to the worker.
      host.postMessage({ type: 'velorn:export-frame-pipe-port', sessionId }, '*', [channel.port2])
      worker.postMessage({ type: 'port' }, [channel.port1])
    } catch {
      onReady(false)
    }
  })
  onReady = null
  if (!ready) {
    // Nothing was written yet, so the plain route can take over cleanly.
    worker.terminate()
    return fallback()
  }

  return {
    mode: 'port',
    /** A full-frame buffer the caller may fill and pass to send() with owned=true. */
    takeFrameBuffer: () => new Uint8Array(pool.pop() || new ArrayBuffer(frameBytes)),
    /**
     * @param {ArrayBuffer} arrayBuffer  One raw frame.
     * @param {boolean} owned  True when the buffer came from takeFrameBuffer
     *   (or is otherwise the caller's to give away): it is handed over
     *   without a copy and must not be touched again. False copies it first.
     */
    send: (arrayBuffer, owned = false) => {
      if (failure) return Promise.resolve({ success: false, error: failure })
      let buffer = arrayBuffer
      if (!owned) {
        buffer = pool.pop() || new ArrayBuffer(arrayBuffer.byteLength)
        if (buffer.byteLength !== arrayBuffer.byteLength) buffer = new ArrayBuffer(arrayBuffer.byteLength)
        new Uint8Array(buffer).set(new Uint8Array(arrayBuffer))
      }
      const id = nextId++
      return new Promise((resolve) => {
        pending.set(id, resolve)
        try {
          worker.postMessage({ type: 'frame', id, buffer }, [buffer])
        } catch (error) {
          pending.delete(id)
          resolve({ success: false, error: error?.message || String(error) })
        }
      })
    },
    dispose: () => {
      failAll('Frame pipe closed.')
      worker.terminate()
      pool.length = 0
    },
  }
}
