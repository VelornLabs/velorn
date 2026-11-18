import { useEffect } from 'react'
import useProjectStore from '../stores/projectStore'
import { importRouterImage } from '../services/comfyRouterImages'
import { createPhoneCreateSaver } from '../services/phoneCreateSave.mjs'

// Always mounted, shows nothing. When a picture or clip made from the paired
// phone finishes, it is saved into the open project without the Create tab.
// It also keeps asking Comfy about phone requests that are still being made, so
// a result is collected even when the phone has been put away.
const saver = createPhoneCreateSaver({
  getApi: () => window.electronAPI?.comfyRouter,
  importJob: jobId => importRouterImage(jobId, { previewOnly: false }),
})

export default function PhoneCreateSaver() {
  const projectPath = useProjectStore(state => (typeof state.currentProjectHandle === 'string' ? state.currentProjectHandle : state.currentProject?.name || ''))
  useEffect(() => {
    const api = window.electronAPI?.comfyRouter
    if (!api?.list || !projectPath) return undefined
    let active = true, timer = null
    // Looks every few seconds while a phone request is still being made, and
    // once a minute otherwise (a missed change notice, spaced-out retries).
    const look = async () => {
      clearTimeout(timer)
      let following = 0
      try { following = await saver() } catch { following = 0 }
      if (active) timer = setTimeout(look, following > 0 ? 5000 : 60000)
    }
    void look()
    const stop = api.onChanged?.(() => { void look() })
    return () => { active = false; clearTimeout(timer); if (typeof stop === 'function') stop() }
  }, [projectPath])
  return null
}
