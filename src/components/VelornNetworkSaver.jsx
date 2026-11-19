import { useEffect } from 'react'
import useProjectStore from '../stores/projectStore'
import { velornNetwork, saveNetworkResult } from '../services/velornNetwork'

// Always mounted, shows nothing. A clip being made on the Velorn network is
// followed and saved into the open project even when the Create tab is closed,
// and a job left from before Velorn was restarted is picked up again.
export default function VelornNetworkSaver() {
  const projectPath = useProjectStore(state => (typeof state.currentProjectHandle === 'string' ? state.currentProjectHandle : state.currentProject?.name || ''))
  useEffect(() => { void velornNetwork.resume() }, [projectPath])
  // A job the paired phone sent is followed and saved here like one sent from this window.
  useEffect(() => window.electronAPI?.gpuNetwork?.onChanged?.(() => { velornNetwork.clear(); void velornNetwork.resume() }), [])
  // What the paired phone had this computer make with one of its own workflows is saved here too: when it
  // finishes, when a project opens, and every half minute while something still waits (no project open, an export running).
  useEffect(() => {
    const api = window.electronAPI?.phoneLocal
    if (!api?.pending) return undefined
    let stopped = false, busy = false, timer = null
    const run = async () => {
      if (busy || stopped) return
      busy = true
      let left = 0
      try {
        const listed = await api.pending()
        for (const job of listed?.success ? listed.jobs : []) {
          const found = await api.take(job.jobId)
          if (!found?.success) continue
          const saved = await saveNetworkResult(found)
          if (saved?.success) await api.saved(job.jobId); else left++
        }
      } catch { left++ } finally { busy = false }
      clearTimeout(timer)
      if (left && !stopped) timer = setTimeout(run, 30000)
    }
    const off = api.onChanged?.(() => void run())
    void run()
    return () => { stopped = true; clearTimeout(timer); off?.() }
  }, [projectPath])
  return null
}
