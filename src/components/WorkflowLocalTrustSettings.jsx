import { useCallback, useEffect, useRef, useState } from 'react'
import './WorkflowLocalTrustSettings.css'

// Human settings only. This does not expose a model-callable trust grant, and
// removing a choice never changes/deletes its saved graph or generated media.
export default function WorkflowLocalTrustSettings({ disabled = false, api = globalThis.window?.electronAPI?.generationSpending }) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')
  const epoch = useRef(0)
  const refresh = useCallback(async () => {
    const current = ++epoch.current
    try {
      const result = await api?.getStatus?.()
      if (current !== epoch.current) return
      if (result?.success !== true) throw new Error(result?.error || 'Remembered local workflows could not be read.')
      setEntries(Array.isArray(result.localTrustedWorkflows) ? result.localTrustedWorkflows : [])
      setError('')
    } catch (reason) {
      if (current === epoch.current) setError(reason?.message || 'Remembered local workflows could not be read.')
    } finally { if (current === epoch.current) setLoading(false) }
  }, [api])
  useEffect(() => {
    void refresh()
    const unsubscribe = api?.onChanged?.(() => { void refresh() })
    return () => { ++epoch.current; unsubscribe?.() }
  }, [api, refresh])
  async function forget(id) {
    if (disabled || busy) return
    setBusy(id); setError('')
    try {
      const result = await api?.revokeLocalTrust?.({ id })
      if (result?.success !== true) throw new Error(result?.error || 'The local-workflow choice could not be removed. Restart Velorn if the native bridge is unavailable.')
      await refresh()
    } catch (reason) { setError(reason?.message || 'The local-workflow choice could not be removed.') }
    finally { setBusy(null) }
  }
  return <details className="ca-local-workflow-trust ca-settings-disclosure">
    <summary>Remembered local workflows{entries.length ? ` (${entries.length})` : ''}</summary>
    <p>For an unfamiliar saved workflow, choose <strong>Trust as local and run</strong> in its generation review. This works with Local only; you do not need to enable cloud spending. This is your choice, not a guarantee that custom nodes never contact external services. Known paid workflows still follow Generation spending.</p>
    {loading ? <p role="status">Loading remembered choices…</p>
      : entries.length ? <ul>{entries.map(entry => <li key={entry.id}>
        <span>{entry.title || 'Saved workflow'}</span>{' '}
        <button type="button" disabled={disabled || Boolean(busy)} onClick={() => { void forget(entry.id) }}
          aria-label={`Forget local choice for ${entry.title || 'saved workflow'}`}>{busy === entry.id ? 'Forgetting…' : 'Forget local choice'}</button>
      </li>)}</ul> : <p>No workflows marked as local yet.</p>}
    {error && <p role="alert">{error}</p>}
    <p>Choices are saved on this desktop. Changes to the saved graph, models or connection need a new choice. Forgetting a choice leaves the workflow and media unchanged.</p>
  </details>
}
