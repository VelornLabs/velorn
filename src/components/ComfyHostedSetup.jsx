import { useEffect, useRef, useState } from 'react'

const STATES = {
  missing: ['Not connected', 'Enter a Comfy API key to check access to your hosted account.'],
  configured: ['Not checked', 'A key is available. Check account access before relying on it.'],
  verified: ['Account access verified', 'Comfy Cloud reported active account access. No workflow was run.'],
  waitlisted: ['Access pending', 'Comfy Cloud reports that this account is waitlisted.'],
  'auth-rejected': ['Key not accepted', 'Comfy Cloud did not accept this key. Check or replace it.'],
  'subscription-or-rate-limited': ['Access needs attention', 'The service rejected this check because of a subscription or rate limit. Review your Comfy account or try again later.'],
  unavailable: ['Could not verify access', 'The check could not confirm active access. Check your connection and try again.'],
}

function safeStatus(value) {
  if (!value || !Object.hasOwn(STATES, value.state)
    || typeof value.configured !== 'boolean' || typeof value.remembered !== 'boolean'
    || typeof value.canRemember !== 'boolean' || value.success === false
    || (value.state === 'verified' && !value.configured)) return null
  return { state: value.state, configured: value.configured, remembered: value.remembered, canRemember: value.canRemember }
}

const buttonClass = 'rounded-md border border-sf-dark-600 bg-sf-dark-800 px-3 py-2 text-xs text-sf-text-primary hover:bg-sf-dark-700 disabled:cursor-not-allowed disabled:opacity-50'

// Hosted account verification is deliberately separate from Partner/API nodes,
// local ComfyUI transport and the editor's selected assistant.
export default function ComfyHostedSetup() {
  const api = window.electronAPI?.comfyHostedSetup
  const [status, setStatus] = useState(null)
  const [key, setKey] = useState('')
  const [remember, setRemember] = useState(false)
  const [pending, setPending] = useState('loading')
  const [error, setError] = useState('')
  const [checkNote, setCheckNote] = useState('')
  const [confirmForget, setConfirmForget] = useState(false)
  const revision = useRef(0)
  const busy = useRef(false)

  useEffect(() => {
    const current = ++revision.current
    if (!api?.status) {
      setError('Hosted account checks are available in the updated Velorn desktop app.')
      setPending('')
      return () => { revision.current++ }
    }
    Promise.resolve().then(() => api.status()).then(value => {
      if (current !== revision.current) return
      const safe = safeStatus(value)
      setStatus(safe)
      if (!safe) setError('Could not read hosted setup status. Close and reopen these controls to try again.')
    }).catch(() => {
      if (current === revision.current) setError('Could not read hosted setup status. Close and reopen these controls to try again.')
    }).finally(() => { if (current === revision.current) setPending('') })
    return () => {
      revision.current++
      if (busy.current) { try { Promise.resolve(api.cancel?.()).catch(() => {}) } catch {} }
    }
  }, [api])

  async function perform(kind, payload) {
    if (busy.current || pending || !api?.[kind]) return
    busy.current = true
    const current = ++revision.current
    setError('')
    setCheckNote('')
    setPending(kind)
    setConfirmForget(false)
    // The renderer never receives a saved key. Discard the entered copy after
    // submitting it to native code; no localStorage, transcript or telemetry.
    if (kind === 'check') setKey('')
    setStatus(previous => previous ? { ...previous, state: previous.configured ? 'configured' : 'missing' } : previous)
    try {
      const value = await api[kind](payload)
      if (current !== revision.current) return
      const safe = safeStatus(value)
      if (!safe) {
        setError(kind === 'clear' ? 'Could not forget the hosted key. Try again.' : 'Could not complete the account check. Try again.')
      } else {
        setStatus(safe)
        setRemember(false)
        if (kind === 'check' && payload?.key && safe.state !== 'verified' && safe.configured) {
          setCheckNote('The previous hosted key was kept unchanged. This result is for the new key you just tested.')
        }
      }
    } catch {
      if (current === revision.current) setError(kind === 'clear' ? 'Could not forget the hosted key. Try again.' : 'Could not complete the account check. Try again.')
    } finally {
      if (current === revision.current) { busy.current = false; setPending('') }
    }
  }

  function check(event) {
    event.preventDefault()
    const candidate = key.trim()
    if (candidate && (candidate.length > 4096 || /\s|[\x00-\x1f\x7f-\x9f]/.test(candidate))) {
      setError('Enter only the API key, without spaces or extra text.')
      return
    }
    if (!candidate && !status?.configured) return
    void perform('check', candidate ? { key: candidate, remember: remember && status?.canRemember === true } : {})
  }

  async function openGuide(guide) {
    if (!api?.openGuide) return
    try {
      const result = await api.openGuide({ guide })
      if (result?.success === false) setError('Could not open the official Comfy page. Try again.')
    } catch { setError('Could not open the official Comfy page. Try again.') }
  }

  const changed = Boolean(key.trim())
  const state = changed ? 'configured' : status?.state || 'missing'
  const verified = state === 'verified' && !pending && !error
  const title = changed ? 'New key not checked' : STATES[state][0]

  return (
    <section aria-labelledby="comfy-hosted-title" className="comfy-hosted-setup space-y-4 rounded-lg border border-sf-dark-600 bg-sf-dark-900/60 p-4">
      <div className="space-y-2">
        <h3 id="comfy-hosted-title" className="text-sm font-semibold text-sf-text-primary">Hosted Comfy Cloud</h3>
        <p className="text-xs leading-relaxed text-sf-text-secondary">Check access to Comfy’s hosted service, separate from your local ComfyUI and its Partner/API nodes. Comfy Cloud API access requires a paid Comfy Cloud subscription.</p>
        <p className="text-xs leading-relaxed text-sf-text-muted">Account check only: hosted generation is not enabled in Velorn yet. This does not upload media, run a workflow, purchase credits, or change your local connection or editing assistant.</p>
      </div>

      <div role="status" aria-live="polite" className={`rounded-md border p-3 text-xs leading-relaxed ${verified ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-300' : 'border-sf-dark-700 text-sf-text-secondary'}`}>
        <p className="font-medium">{pending === 'loading' ? 'Reading saved setup…' : pending === 'check' ? 'Checking account access…' : pending === 'clear' ? 'Forgetting hosted key…' : title}</p>
        {!pending && <p className="mt-1">{changed ? 'Check this key to verify its account access.' : STATES[state][1]}</p>}
        {checkNote && !pending && <p className="mt-1">{checkNote}</p>}
        {status?.configured && !changed && !pending && <p className="mt-1 text-sf-text-muted">{status.remembered ? 'Key remembered on this device using OS-protected storage.' : 'Key kept only for this Velorn session. It will be forgotten when Velorn quits.'}</p>}
      </div>

      <form onSubmit={check} className="space-y-3">
        <div>
          <label htmlFor="comfy-hosted-key" className="mb-1.5 block text-xs text-sf-text-primary">Comfy Cloud API key</label>
          <input id="comfy-hosted-key" type="password" autoComplete="off" spellCheck={false} maxLength={4096}
            value={key} disabled={Boolean(pending) || !status} onChange={event => { setKey(event.target.value); setError(''); setCheckNote(''); setConfirmForget(false) }}
            placeholder={status?.configured ? 'Leave blank to check the existing key' : 'Paste your Comfy API key here, not in chat'}
            aria-describedby="comfy-hosted-key-help" className="w-full min-w-0 rounded-md border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary" />
          <p id="comfy-hosted-key-help" className="mt-1.5 text-[11px] leading-relaxed text-sf-text-muted">Use a Comfy key, not your Luna/OpenAI key. The key goes only to Comfy Cloud for this check. It is not sent to Luna or added to your project. Your existing Partner/API key is not changed or reused automatically.</p>
        </div>
        <label className="flex items-center gap-2 text-xs text-sf-text-primary">
          <input type="checkbox" checked={remember} disabled={!status?.canRemember || !changed || Boolean(pending)} onChange={event => setRemember(event.target.checked)} />
          Remember on this device
        </label>
        <p className="text-[11px] leading-relaxed text-sf-text-muted">{status?.canRemember
          ? 'Optional: remember the new key only after active account access is verified. Unchecked, a verified replacement is kept only until you quit.'
          : 'OS-protected key storage is unavailable here. You can still check access with a session-only key.'}</p>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={buttonClass} disabled={Boolean(pending) || !status || (!changed && !status.configured)}>Check account access</button>
          {status?.configured && <button type="button" className={buttonClass} disabled={Boolean(pending)} onClick={() => setConfirmForget(true)}>Forget hosted key</button>}
        </div>
      </form>

      {confirmForget && <div className="space-y-2 rounded-md border border-sf-dark-600 p-3 text-xs text-sf-text-secondary">
        <p>Forget this hosted key in Velorn? This removes its local saved copy and session copy. It does not revoke the key at Comfy or change your Partner/API key.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} onClick={() => { setKey(''); void perform('clear') }}>Forget key</button>
          <button type="button" className={buttonClass} onClick={() => setConfirmForget(false)}>Cancel</button>
        </div>
      </div>}
      {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={!api?.openGuide || Boolean(pending)} onClick={() => { void openGuide('keys') }}>Get a Comfy API key</button>
        <button type="button" className={buttonClass} disabled={!api?.openGuide || Boolean(pending)} onClick={() => { void openGuide('cloud') }}>Comfy Cloud guide</button>
      </div>
    </section>
  )
}
