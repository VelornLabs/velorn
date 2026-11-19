// Whether Velorn is asking, right now, if a paid or unfamiliar job may run.
// A job waits at "queuing" while that question is open, so its card says it is
// waiting for the person instead of "Queued in ComfyUI".
import { useSyncExternalStore } from 'react'

export const APPROVAL_WAIT_LABEL = 'Waiting for your approval'

export function createSpendApprovalWait(api) {
  let asking = false
  let stop = null
  const listeners = new Set()
  const subscribe = (listener) => {
    listeners.add(listener)
    if (!stop && typeof api?.onAsking === 'function') {
      stop = api.onAsking((value) => {
        if (asking === (value === true)) return
        asking = value === true
        listeners.forEach((each) => each())
      })
    }
    return () => { listeners.delete(listener) }
  }
  return { subscribe, get: () => asking }
}

let shared = null
const wait = () => (shared ||= createSpendApprovalWait(globalThis.window?.electronAPI?.generationSpending))

export function useAwaitingSpendApproval() {
  return useSyncExternalStore((listener) => wait().subscribe(listener), () => wait().get(), () => false)
}
