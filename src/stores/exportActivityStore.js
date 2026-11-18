import { create } from 'zustand'

// Transient only: native state survives renderer reloads in ExportJobRegistry.
// Local leases cover preparation, browser exports, and gaps in a UI queue.
const useExportActivityStore = create(() => ({ revision: -1, activeJob: null, localActivity: null, localActivities: {} }))
let nextLease = 0

export const isExportBusy = () => {
  const { activeJob, localActivity } = useExportActivityStore.getState()
  return Boolean(activeJob || localActivity)
}

export function receiveExportActivity(snapshot) {
  if (!Number.isSafeInteger(snapshot?.revision) || snapshot.revision < 0) return false
  const current = useExportActivityStore.getState()
  if (snapshot.revision <= current.revision) return false
  useExportActivityStore.setState({ revision: snapshot.revision, activeJob: snapshot.activeJob || null })
  return true
}

export function beginLocalExportActivity(details = {}) {
  const id = `local-export-${++nextLease}`
  const update = (patch) => {
    const current = useExportActivityStore.getState()
    if (!current.localActivities[id]) return
    const localActivities = { ...current.localActivities,
      [id]: { ...current.localActivities[id], ...patch, id } }
    useExportActivityStore.setState({ localActivities, localActivity: Object.values(localActivities).at(-1) || null })
  }
  const localActivity = { ...details, id, startedAt: Date.now() }
  useExportActivityStore.setState(state => ({ localActivities: { ...state.localActivities, [id]: localActivity }, localActivity }))
  return { id, update, end() {
    const localActivities = { ...useExportActivityStore.getState().localActivities }
    delete localActivities[id]
    useExportActivityStore.setState({ localActivities, localActivity: Object.values(localActivities).at(-1) || null })
  } }
}

export default useExportActivityStore
