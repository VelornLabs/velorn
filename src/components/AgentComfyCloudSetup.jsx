import { useCallback, useEffect, useRef, useState } from 'react'
import ApiKeyDialog from './ApiKeyDialog'
import { notifyComfyPartnerKeyChanged } from '../services/comfyPartnerAuth'

const requestId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)

// Mounted once at the app shell, not once per chat. Events are invalidations,
// never instructions containing a key. Native owns request lifetime and commit.
export default function AgentComfyCloudSetup() {
  const api = globalThis.window?.electronAPI?.comfyCloudSetup
  const [request, setRequest] = useState(null)
  const alive = useRef(false), epoch = useRef(0), active = useRef(null), dismissed = useRef(new Set())
  const refresh = useCallback(async () => {
    if (!alive.current || typeof api?.current !== 'function') return
    const token = ++epoch.current
    try {
      const result = await api.current()
      if (!alive.current || token !== epoch.current) return
      if (result?.success !== true) return
      const next = requestId(result.request?.requestId) && !dismissed.current.has(result.request.requestId)
        ? { requestId: result.request.requestId } : null
      active.current = next
      setRequest(previous => previous?.requestId === next?.requestId ? previous : next)
    } catch { /* Native owns timeout/cancellation; do not invent a successful handoff. */ }
  }, [api])
  useEffect(() => {
    alive.current = true
    if (!api?.current || !api?.save || !api?.complete) return () => { alive.current = false; epoch.current++ }
    const offRequested = api.onRequested?.(() => { void refresh() })
    const offChanged = api.onChanged?.(() => { void refresh() })
    void refresh()
    return () => {
      alive.current = false; epoch.current++; active.current = null
      offRequested?.(); offChanged?.()
    }
  }, [api, refresh])

  const dismiss = useCallback(async details => {
    const current = active.current
    if (!current) return
    dismissed.current.add(current.requestId)
    // Bound session-only close guards without storing any account/credential data.
    if (dismissed.current.size > 32) dismissed.current.delete(dismissed.current.values().next().value)
    epoch.current++; active.current = null; setRequest(null)
    if (details?.outcome === 'saved' || details?.outcome === 'removed') return
    try { await api.complete({ requestId: current.requestId, outcome: 'cancelled', validation: 'unknown' }) }
    catch { /* No retry and no credential write after the user closed the dialog. */ }
  }, [api])

  const persist = useCallback(async ({ key, validation, useExisting = false }) => {
    const current = active.current
    if (!alive.current || !current || current.requestId !== request?.requestId) throw new Error('Setup request is no longer active.')
    // This is a UI-only credential IPC, NOT an MCP argument or an agent result.
    // The native queued commit checks request revocation immediately before writing.
    const result = await api.save({ requestId: current.requestId, key, validation, ...(useExisting ? { useExisting: true } : {}) })
    if (result?.success !== true || !['saved', 'removed'].includes(result.outcome)) throw new Error('The key could not be saved. Retry while setup is still active.')
    notifyComfyPartnerKeyChanged(result.configured === true, { clearLegacy: true })
    if (alive.current && active.current?.requestId === current.requestId) {
      dismissed.current.add(current.requestId)
      if (dismissed.current.size > 32) dismissed.current.delete(dismissed.current.values().next().value)
      epoch.current++; active.current = null; setRequest(null)
    }
    return { success: true, outcome: result.outcome, validation: result.validation }
  }, [api, request?.requestId])

  return request ? <ApiKeyDialog key={request.requestId} open guided onClose={dismiss} onPersist={persist}
    headline="Connect your Comfy API key" subhead="Paste your key here, not in chat. Your agent receives only setup status." /> : null
}
