'use strict'

const SETTING_KEY = 'freeGpuMemoryAfterGeneration'
// A completion arms cleanup; merely starting Velorn or changing a setting does
// not unload anything. Keep this independent from agent-model residency.
function createGenerationMemoryCleanup({ getEnabled, getEndpoint, isBusy = async () => false,
  fetchImpl = globalThis.fetch, delayMs = 10000, setTimer = setTimeout, clearTimer = clearTimeout,
  onError = () => {} }) {
  let timer = null, pending = null, controller = null, disposed = false
  const arm = () => {
    if (disposed || timer || !pending) return
    timer = setTimer(() => { timer = null; void check() }, delayMs)
    timer?.unref?.()
  }
  async function check() {
    const task = pending
    if (!task || disposed) return
    const current = async () => {
      const enabled = await getEnabled(), endpoint = await getEndpoint()
      return !disposed && pending === task && enabled === true && endpoint === task.endpoint
    }
    controller = new AbortController()
    const abort = setTimeout(() => controller?.abort(), 10000)
    try {
      if (!await current()) { if (pending === task) pending = null; return }
      if (await isBusy()) { task.idleSeen = false; arm(); return }
      const response = await fetchImpl(`${task.endpoint}/queue`, { redirect: 'error', signal: controller.signal })
      if (!response.ok) throw new Error('ComfyUI queue could not be checked')
      const queue = await response.json()
      // Missing/malformed data is never evidence of an empty queue.
      if (!Array.isArray(queue?.queue_running) || !Array.isArray(queue?.queue_pending)) throw new Error('ComfyUI returned an invalid queue')
      if (queue.queue_running.length || queue.queue_pending.length) { task.idleSeen = false; arm(); return }
      // Two idle observations leave time for the next shot in a batch to queue.
      if (!task.idleSeen) { task.idleSeen = true; arm(); return }
      if (!await current()) { if (pending === task) pending = null; return }
      if (await isBusy()) { task.idleSeen = false; arm(); return }
      if (!await current()) { if (pending === task) pending = null; return }
      const released = await fetchImpl(`${task.endpoint}/free`, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) })
      if (!released.ok) throw new Error('ComfyUI did not accept memory cleanup')
      // /free acknowledges a request, not an exact number of bytes reclaimed.
      if (pending === task) pending = null
    } catch {
      if (pending === task) pending = null // Do not automatically retry an uncertain POST.
      if (!disposed) onError('Automatic ComfyUI memory cleanup was skipped or could not be confirmed. Generation results are unchanged.')
    } finally { clearTimeout(abort); controller = null; if (pending && pending !== task) arm() }
  }
  return {
    schedule({ endpoint }) {
      if (disposed) return
      const url = new URL(endpoint)
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return
      pending = { endpoint: url.origin, idleSeen: false }
      if (timer) clearTimer(timer)
      timer = null
      if (!controller) arm()
    },
    dispose() { disposed = true; pending = null; if (timer) clearTimer(timer); timer = null; controller?.abort() },
  }
}
module.exports = { createGenerationMemoryCleanup, SETTING_KEY }
