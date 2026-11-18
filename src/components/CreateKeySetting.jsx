import { useCallback, useEffect, useState } from 'react'

// Settings row for the Comfy key the Create tab uses. It only shows whether a
// key is held and lets the person forget it; the key itself never reaches the
// screen. Adding a key happens in the Create tab, at the moment it is needed.
export default function CreateKeySetting() {
  const api = typeof window !== 'undefined' ? window.electronAPI?.comfyRouter : null
  const [status, setStatus] = useState(null)
  const [message, setMessage] = useState('')
  const [working, setWorking] = useState(false)
  const refresh = useCallback(async () => {
    if (!api?.status) return
    try { const next = await api.status({}); if (next?.success) setStatus(next) } catch { /* keep what is shown */ }
  }, [api])
  useEffect(() => { refresh(); return api?.onChanged?.(refresh) }, [api, refresh])
  if (!api?.status) return null

  const forget = async () => {
    setWorking(true); setMessage('')
    let answer
    try { answer = await api.clear({}) } catch { answer = null }
    await refresh(); setWorking(false)
    setMessage(answer?.success ? 'The key was forgotten on this computer.' : answer?.error || 'The key could not be forgotten. Try again.')
  }
  const held = Boolean(status?.configured)
  return (
    <div className="flex items-center justify-between rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
      <div className="pr-4">
        <label className="text-sm text-sf-text-primary">Comfy key for the Create tab</label>
        <p className="text-[10px] text-sf-text-muted">
          {!held ? 'No key is held. Create asks for one the first time you generate.'
            : status.remembered ? 'A key is remembered on this computer, encrypted by the system password store.'
              : 'A key is held until Velorn closes. This computer has no protected password store to remember it.'}
          {message ? ` ${message}` : ''}
        </p>
      </div>
      <button type="button" onClick={forget} disabled={!held || working}
        className="shrink-0 rounded-md border border-sf-dark-600 px-3 py-1.5 text-xs text-sf-text-primary hover:bg-sf-dark-700 disabled:cursor-default disabled:opacity-40">
        Forget key
      </button>
    </div>
  )
}
