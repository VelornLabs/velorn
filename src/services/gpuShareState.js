// This computer's Velorn network sharing state, read once and shared by the
// Network tab and the dot on its button. It is read again whenever the main
// process says something changed (a job arrived, started, ended).
const api = () => (typeof window !== 'undefined' ? window.electronAPI?.gpuShare : null)
let snapshot = { state: null, error: '' }
const listeners = new Set()
let watching = false, loading = null
const set = next => { snapshot = next; for (const listener of listeners) listener() }

export function loadGpuShare() {
  if (!api()?.status) return Promise.resolve()
  if (loading) return loading
  loading = (async () => {
    try { const next = await api().status(); set(next?.success ? { state: next, error: '' } : { ...snapshot, error: next?.error || 'GPU sharing could not be read.' }) }
    catch { set({ ...snapshot, error: 'GPU sharing could not be read.' }) }
    finally { loading = null }
  })()
  return loading
}
// A reply to a change (update or report) already carries the new state.
export function acceptGpuShare(next) { if (next?.success) set({ state: next, error: '' }) }
export function subscribeGpuShare(listener) {
  listeners.add(listener)
  if (!watching && api()?.status) { watching = true; api().onChanged?.(() => { void loadGpuShare() }); void loadGpuShare() }
  return () => { listeners.delete(listener) }
}
export const getGpuShare = () => snapshot
// What the tab's dot should say: someone is waiting for an answer, a job is running, or nothing.
export function gpuShareActivity(state) {
  const job = state?.network?.job
  return !job ? null : job.status === 'asking' ? 'asking' : 'running'
}
