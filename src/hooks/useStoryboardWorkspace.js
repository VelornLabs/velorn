import { useCallback, useLayoutEffect, useMemo, useState } from 'react'
import useProjectStore from '../stores/projectStore'
import { getStoryboardProjectKey, hasStoryboardContent } from '../utils/storyboardWorkspace.mjs'

// Navigation only: opening an empty board must not author a storyboard, dirty
// the project, or persist an app-wide preference that leaks into other projects.
export default function useStoryboardWorkspace({ activeTab, onTabChange, disabled = false }) {
  const project = useProjectStore(state => state.currentProject)
  const handle = useProjectStore(state => state.currentProjectHandle)
  const loading = useProjectStore(state => state.isLoading)
  const key = getStoryboardProjectKey(project, handle)
  const hasContent = useMemo(() => hasStoryboardContent(project?.storyboard), [project?.storyboard])
  const [openedKey, setOpenedKey] = useState(null)
  const viewingBoard = Boolean(key != null && !loading && openedKey === key && activeTab === 'storyboard')
  const resolvedTab = activeTab === 'storyboard' && !viewingBoard ? 'editor' : activeTab

  useLayoutEffect(() => { setOpenedKey(null) }, [key, loading])
  useLayoutEffect(() => {
    if (activeTab !== resolvedTab) onTabChange(resolvedTab)
  }, [activeTab, resolvedTab, onTabChange])

  const openStoryboard = useCallback(() => {
    if (disabled || loading || key == null) return
    setOpenedKey(key)
    onTabChange('storyboard')
  }, [disabled, loading, key, onTabChange])
  const selectTab = useCallback(tab => {
    if (disabled) return
    if (tab === 'storyboard') return openStoryboard()
    setOpenedKey(null)
    onTabChange(tab)
  }, [disabled, openStoryboard, onTabChange])

  return { activeTab: resolvedTab, showStoryboardTab: Boolean(project && !loading && (hasContent || viewingBoard)), selectTab, openStoryboard }
}
