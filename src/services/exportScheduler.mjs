/**
 * Export needs real task boundaries for decoder output, cancellation and IPC.
 * A hidden Electron worker must never wait for a screen repaint: a never-shown
 * BrowserWindow can report visibilityState="visible" while RAF is throttled.
 * Keep that distinction explicit rather than inferring it from the document.
 */
export const createExportScheduler = ({ offscreen = false, host = globalThis } = {}) => {
  const pending = []
  let channel = null
  let disposed = false

  const yieldTask = () => {
    if (disposed) return Promise.resolve()
    if (typeof host.MessageChannel !== 'function') {
      return new Promise(resolve => host.setTimeout(resolve, 0))
    }
    if (!channel) {
      channel = new host.MessageChannel()
      channel.port1.onmessage = () => pending.shift()?.()
    }
    return new Promise(resolve => {
      pending.push(resolve)
      channel.port2.postMessage(null)
    })
  }

  const yieldForProgress = () => {
    if (disposed) return Promise.resolve()
    if (offscreen || host.document?.visibilityState === 'hidden' || typeof host.requestAnimationFrame !== 'function') {
      return yieldTask()
    }
    // Foreground direct exports/bakes can still give the visible UI a repaint.
    return new Promise(resolve => host.requestAnimationFrame(resolve))
  }

  const dispose = () => {
    disposed = true
    if (channel) {
      channel.port1.onmessage = null
      channel.port1.close()
      channel.port2.close()
      channel = null
    }
    while (pending.length) pending.shift()()
  }

  return { yieldForProgress, yieldTask, dispose, mode: offscreen ? 'offscreen-task-queue' : 'foreground' }
}
