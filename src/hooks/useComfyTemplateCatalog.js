import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchComfyTemplateCatalog } from '../services/comfyTemplateCatalog'

/**
 * Loads the ComfyUI official template catalog once `enabled` turns true
 * (i.e. the user opens the Templates route), then keeps it for the session.
 */
export function useComfyTemplateCatalog(enabled = false) {
  const [state, setState] = useState({
    status: 'idle',
    categories: [],
    templates: [],
    fetchedAt: 0,
    fromCache: false,
    staleError: '',
    error: '',
  })
  const requestTokenRef = useRef(0)

  const load = useCallback(async (forceRefresh = false) => {
    const token = requestTokenRef.current + 1
    requestTokenRef.current = token
    setState((prev) => ({ ...prev, status: 'loading', error: '' }))
    try {
      const result = await fetchComfyTemplateCatalog({ forceRefresh })
      if (requestTokenRef.current !== token) return
      setState({
        status: 'ready',
        categories: result.categories,
        templates: result.templates,
        fetchedAt: result.fetchedAt,
        fromCache: result.fromCache,
        staleError: result.staleError || '',
        error: '',
      })
    } catch (error) {
      if (requestTokenRef.current !== token) return
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : 'Could not load ComfyUI templates.',
      }))
    }
  }, [])

  useEffect(() => {
    if (!enabled || state.status !== 'idle') return
    void load()
  }, [enabled, state.status, load])

  const refresh = useCallback(() => load(true), [load])

  return { ...state, refresh }
}
