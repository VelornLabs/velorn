import { useEffect, useState } from 'react'
import './VeloAllowance.css'

export function veloAllowanceNotice(result) {
  if (result?.success !== true || result?.provider !== 'luna' || result?.available !== false || result?.status !== 'exhausted') return ''
  if (result.allowance?.pending === true) return 'Velo usage is awaiting confirmation. Check again shortly.'
  if (result.allowance?.poolLimited === true) return 'Velo launch funding is currently unavailable.'
  return 'Velo allowance used up — no automatic refills'
}

// Only a display of native, authenticated status. It never enables Send,
// changes an allowance, sends a prompt, or persists account data in the browser.
export function useVeloAllowance({ enabled, accountKey, revision = 0 }) {
  const [state, setState] = useState(null)
  useEffect(() => {
    if (!enabled) return
    let current = true, pending = false
    setState({ key: accountKey, result: null, checking: true })
    const refresh = async () => {
      if (!current || pending || document.visibilityState === 'hidden') return
      if (navigator.onLine === false) { setState({ key: accountKey, result: null, checking: false }); return }
      pending = true
      try {
        const result = await window.electronAPI?.connectedAgent?.veeAvailability?.()
        if (current) setState({ key: accountKey, result: navigator.onLine !== false && result?.success === true ? result : null, checking: false })
      } catch {
        if (current) setState({ key: accountKey, result: null, checking: false })
      } finally { pending = false }
    }
    void refresh()
    const timer = setInterval(refresh, 30000)
    const offline = () => { if (current) setState({ key: accountKey, result: null, checking: false }) }
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('online', refresh)
    window.addEventListener('offline', offline)
    return () => {
      current = false; clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('online', refresh); window.removeEventListener('offline', offline)
    }
  }, [enabled, accountKey, revision])
  return enabled && state?.key === accountKey ? state : { result: null, checking: enabled }
}

export function VeloAllowance({ result, checking = false }) {
  const value = result?.allowance
  const valid = result?.success === true && result?.provider === 'luna'
    && ['eligible', 'exhausted'].includes(result.status)
    && Number.isFinite(value?.remainingPercent) && value.remainingPercent >= 0 && value.remainingPercent <= 100
    && typeof value.pending === 'boolean' && typeof value.poolLimited === 'boolean'
  if (!valid) return <div className="velo-allowance velo-allowance-unknown" role="status">
    {checking ? 'Checking Velo allowance…' : result?.status === 'not-eligible' ? 'No Velo allowance enabled' : 'Velo allowance unavailable'}
  </div>
  const percent = value.remainingPercent
  const note = value.pending ? 'Usage pending · this bar shows confirmed usage.'
    : value.poolLimited ? 'Availability also depends on remaining launch funding.'
      : percent === 0 ? 'Allowance used up · no automatic refills.' : 'Separate from generation credits.'
  return <div className="velo-allowance">
    <div className="velo-allowance-label"><span>Velo allowance</span><span>{percent}% remaining</span></div>
    <div className="velo-allowance-track" role="progressbar" aria-label="Velo allowance remaining"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
      aria-valuetext={`${percent}% remaining${value.pending ? ', usage pending' : ''}`}>
      <span style={{ width: `${percent}%` }} />
    </div>
    <small>{note}</small>
  </div>
}
