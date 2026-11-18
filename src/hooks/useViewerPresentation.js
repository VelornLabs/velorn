import { useCallback, useEffect, useRef, useState } from 'react'
import { createViewerPresentation } from '../services/viewerPresentation.mjs'

export default function useViewerPresentation(panelRef) {
  const controller = useRef(null)
  const [state, setState] = useState({ active: false, pending: false, error: null })
  useEffect(() => {
    const current = createViewerPresentation({ getElement: () => panelRef.current, onChange: setState })
    controller.current = current
    const unload = () => { void current.exit() }
    window.addEventListener('beforeunload', unload)
    return () => {
      controller.current = null
      window.removeEventListener('beforeunload', unload)
      void current.dispose()
    }
  }, [panelRef])
  const toggleFullscreen = useCallback(() => controller.current?.toggle(), [])
  const exitFullscreen = useCallback(() => controller.current?.exit(), [])
  return { isFullscreen: state.active, fullscreenPending: state.pending,
    fullscreenError: state.error, toggleFullscreen, exitFullscreen }
}
