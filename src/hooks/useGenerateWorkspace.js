import { useEffect, useLayoutEffect, useState } from 'react'
import {
  GENERATE_TAB_VISIBILITY_CHANGED_EVENT,
  getShowGenerateTab,
  hydrateShowGenerateTab,
} from '../services/generateTabVisibilitySettings.mjs'

export function useGenerateTabVisibility() {
  const [show, setShow] = useState(getShowGenerateTab)
  useEffect(() => {
    let cancelled = false
    const changed = event => setShow(event?.detail?.show !== false)
    window.addEventListener(GENERATE_TAB_VISIBILITY_CHANGED_EVENT, changed)
    hydrateShowGenerateTab().then(value => { if (!cancelled) setShow(value) }).catch(() => {})
    return () => {
      cancelled = true
      window.removeEventListener(GENERATE_TAB_VISIBILITY_CHANGED_EVENT, changed)
    }
  }, [])
  return show
}

// Hiding a navigation tab is not permission to cancel generation. Keep an
// already visited workspace mounted, and let older MCP adapters mount its
// listeners in the background without reopening a tab the user has hidden.
export default function useGenerateWorkspace({ activeTab, onTabChange, disabled = false }) {
  const showGenerateTab = useGenerateTabVisibility()
  const [hasMountedGenerate, setHasMountedGenerate] = useState(false)
  const resolvedTab = activeTab === 'generate' && !showGenerateTab ? 'editor' : activeTab
  useLayoutEffect(() => {
    if (activeTab === 'generate') setHasMountedGenerate(true)
    if (activeTab !== resolvedTab) onTabChange(resolvedTab)
  }, [activeTab, resolvedTab, onTabChange])
  useEffect(() => {
    const open = () => {
      if (disabled) return
      setHasMountedGenerate(true)
      if (getShowGenerateTab()) onTabChange('generate')
    }
    window.addEventListener('comfystudio-open-generate-tab', open)
    window.addEventListener('comfystudio-open-generate-with-frame', open)
    return () => {
      window.removeEventListener('comfystudio-open-generate-tab', open)
      window.removeEventListener('comfystudio-open-generate-with-frame', open)
    }
  }, [onTabChange, disabled])
  return { activeTab: resolvedTab, showGenerateTab, hasMountedGenerate }
}
