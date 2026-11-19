import { useCallback, useEffect, useState } from 'react'
import {
  CUSTOM_WORKFLOW_LIBRARY_CHANGED_EVENT,
  getCustomLibraryWorkflows,
  loadCustomWorkflowLibrary,
} from '../services/customWorkflowLibrary'

/**
 * Live view of the personal workflow library (graphs saved from the embedded
 * ComfyUI tab). Loads from disk once `enabled` turns true, then tracks the
 * library's change events for the session.
 */
export function useCustomWorkflowLibrary(enabled = false) {
  const [workflows, setWorkflows] = useState(() => getCustomLibraryWorkflows())

  const refresh = useCallback(() => {
    setWorkflows(getCustomLibraryWorkflows())
  }, [])

  useEffect(() => {
    if (!enabled) return undefined
    // Read the folder again each time a list opens, so a workflow saved or
    // removed elsewhere shows without restarting Velorn.
    void loadCustomWorkflowLibrary({ refresh: true }).then(refresh)
    window.addEventListener(CUSTOM_WORKFLOW_LIBRARY_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(CUSTOM_WORKFLOW_LIBRARY_CHANGED_EVENT, refresh)
  }, [enabled, refresh])

  return { workflows, refresh }
}
