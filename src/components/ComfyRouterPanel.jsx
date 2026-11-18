import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { trapDialogFocus } from '../utils/dialogFocus.mjs'
import './ComfyRouterPanel.css'

const completed = job => ['COMPLETED', 'completed', 'succeeded', 'success'].includes(job.status) && job.outputAvailable === true && !job.errorType && !job.error
const cancelable = job => ['IN_QUEUE', 'IN_PROGRESS', 'queued', 'pending', 'running', 'processing'].includes(job.status) && !job.cancellationRequested
const labels = { queued: 'Queued', pending: 'Pending', running: 'Running', processing: 'Running',
  completed: 'Completed', succeeded: 'Completed', success: 'Completed', failed: 'Failed',
  cancelled: 'Cancelled', canceled: 'Cancelled', 'cancel-requested': 'Cancellation requested',
  unknown: 'Status unknown', 'submission-unknown': 'Submission outcome unknown', SUBMITTING: 'Submitting',
  UNCERTAIN: 'Submission outcome unknown', IN_QUEUE: 'Queued', IN_PROGRESS: 'Running',
  COMPLETED: 'Completed', FAILED: 'Failed', CANCELLED: 'Cancelled' }
const statusLabel = job => ['UNCERTAIN', 'submission-unknown'].includes(job.status) ? 'Submission outcome unknown'
  : job.notSubmitted ? 'Not submitted' : job.submissionRejected ? 'Rejected' : job.errorType || job.error ? 'Failed'
  : job.cancellationRequested && ['IN_QUEUE', 'IN_PROGRESS', 'queued', 'pending', 'running', 'processing'].includes(job.status) ? 'Cancellation requested'
    : labels[job.status] || 'Status unknown'
const jobId = job => job.id || job.jobId
const modelLabel = value => typeof value === 'string' ? value : value?.label || value?.name || value?.id || 'Seedream 4.0'
function connectionStatus(value) {
  if (!value?.success) return null
  const connected = typeof value.connected === 'boolean' ? value.connected
    : value.configured === false ? false : value.configured === true && typeof value.keyAccepted === 'boolean' ? value.keyAccepted : null
  return connected === null ? null : { ...value, connected, policy: typeof value.policy === 'string' ? value.policy : value.policy?.policy }
}
function estimateLabel(estimate) {
  if (typeof estimate?.label === 'string') return estimate.label
  if (Number.isFinite(estimate?.credits) && Number.isFinite(estimate?.usd)) return `Estimated ${estimate.credits} credits (US$${estimate.usd.toFixed(2)})`
  return 'Estimate unavailable — preview before requesting generation.'
}
function RouterErrorDetails({ diagnostics }) {
  if (!Number.isInteger(diagnostics?.httpStatus) || diagnostics.httpStatus < 400 || diagnostics.httpStatus > 599) return null
  return <details className="comfy-router-error-details">
    <summary>Error details</summary>
    <p>HTTP {diagnostics.httpStatus}{diagnostics.errorType ? ` · ${diagnostics.errorType}` : ''}</p>
    {diagnostics.requestId && <p>Comfy support request ID: {diagnostics.requestId}</p>}
    <p className="comfy-router-muted">Diagnostic reference only, not a generation job ID or billing receipt.</p>
  </details>
}

// The native Router manager owns credentials, prices, paid confirmation and
// jobs. This panel neither chooses an endpoint nor changes spending policy.
export default function ComfyRouterPanel({ onClose, onOpenSpending, onImport }) {
  const api = window.electronAPI?.comfyRouter
  const [status, setStatus] = useState(null), [jobs, setJobs] = useState([])
  const [key, setKey] = useState(''), [prompt, setPrompt] = useState('')
  const [plan, setPlan] = useState(null), [pending, setPending] = useState('loading')
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [errorDiagnostics, setErrorDiagnostics] = useState(null)
  const [imported, setImported] = useState({})
  const dialog = useRef(null), closeButton = useRef(null), alive = useRef(false), busy = useRef(false)
  const close = useRef(onClose); close.current = onClose

  useEffect(() => {
    alive.current = true
    let cancelled = false, loadVersion = 0
    const previous = document.activeElement, element = dialog.current
    closeButton.current?.focus()
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current?.() }
      else trapDialogFocus(event, element)
    }
    document.addEventListener('keydown', keydown, true)
    async function load(initial = false) {
      const version = ++loadVersion
      if (!api?.status || !api?.list) {
        if (!cancelled) { setError('Cloud images require the updated Velorn desktop app.'); if (initial) setPending('') }
        return
      }
      try {
        const [current, listed] = await Promise.all([api.status({}), api.list({})])
        if (cancelled || version !== loadVersion) return
        const normalized = connectionStatus(current)
        if (!normalized) throw new Error('Could not read the Comfy Router connection.')
        setStatus(normalized)
        if (!listed?.success || !Array.isArray(listed.jobs)) throw new Error(listed?.error || 'Could not read Comfy Router jobs.')
        setJobs(listed.jobs)
      } catch (failure) { if (!cancelled && version === loadVersion) setError(failure.message || 'Could not read cloud image status.') }
      finally { if (!cancelled && initial) setPending('') }
    }
    void load(true)
    const unsubscribe = api?.onChanged?.(() => { void load() })
    return () => {
      alive.current = false
      cancelled = true
      if (typeof unsubscribe === 'function') unsubscribe()
      document.removeEventListener('keydown', keydown, true)
      if (element?.contains(document.activeElement) || document.activeElement === document.body) previous?.focus?.()
    }
  }, [api])

  async function perform(kind, action, accept, privateError = false) {
    if (busy.current || pending) return
    busy.current = true; setPending(kind); setError(''); setErrorDiagnostics(null); setNotice('')
    try {
      const result = await action()
      if (!alive.current) return
      if (!result?.success) {
        if (result?.job) updateJob(result.job)
        if (!privateError) setErrorDiagnostics(result?.diagnostics || null)
        throw new Error(result?.error || 'The request could not be completed.')
      }
      await accept?.(result)
    } catch (failure) {
      if (alive.current) setError(privateError
        ? 'The Router key could not be verified. Check the key and your connection, then try again.'
        : failure.message || 'The request could not be completed.')
    } finally {
      busy.current = false
      if (alive.current) setPending('')
    }
  }

  const updateJob = value => {
    if (!value || !jobId(value)) return
    setJobs(current => [value, ...current.filter(entry => jobId(entry) !== jobId(value))])
  }
  async function refreshLocalStatus() {
    const current = await api.status({})
    const normalized = connectionStatus(current)
    if (alive.current && normalized) setStatus(normalized)
  }
  function connect(event) {
    event.preventDefault()
    const candidate = key.trim()
    if (!candidate || busy.current || pending) return
    if (candidate.length > 4096 || /\s|[\x00-\x1f\x7f-\x9f]/.test(candidate)) {
      setError('Enter only the Comfy API key, without spaces or extra text.'); return
    }
    // Drop the renderer copy immediately, including on a failed verification.
    // Native keeps an accepted key in memory for this session only.
    setKey(''); setPlan(null)
    void perform('connect', () => api.connect({ apiKey: candidate }), async result => {
      if (connectionStatus(result)) setStatus(connectionStatus(result))
      await refreshLocalStatus()
      if (alive.current) setNotice('Router key verified with a catalog check. No image was generated.')
    }, true)
  }
  function preview(event) {
    event.preventDefault()
    const text = prompt.trim()
    if (!text || !status?.connected) return
    setPlan(null)
    void perform('preview', () => api.preview({ prompt: text }), result => {
      if (!result.planId) throw new Error('The cost preview did not return a generation plan.')
      setPlan({ ...result, prompt: text })
      if (result.policy) setStatus(current => ({ ...current, policy: typeof result.policy === 'string' ? result.policy : result.policy.policy }))
    })
  }
  function submit() {
    if (!plan || prompt.trim() !== plan.prompt || !status?.connected || status.policy !== 'ask-cloud') return
    const planId = plan.planId
    // A failed/ambiguous submission must not leave a one-click duplicate retry.
    setPlan(null)
    void perform('submit', () => api.submit({ planId }), result => {
      if (!result.job || !jobId(result.job)) throw new Error('No job receipt was returned. Refresh jobs before requesting another image.')
      updateJob(result.job)
      setNotice('Request recorded. Refresh its status to check the result.')
    })
  }
  const blocked = status?.policy === 'local-only'
  const disabled = Boolean(pending)

  return <div className="comfy-router-backdrop">
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="comfy-router-title" className="comfy-router-panel" tabIndex={-1}>
      <header>
        <div><p className="comfy-router-eyebrow">Comfy Router · cloud images</p><h2 id="comfy-router-title">Create an image</h2></div>
        <button ref={closeButton} type="button" className="comfy-router-close" aria-label="Close cloud images" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="comfy-router-body">
        <p>Generate one 1024 × 1024 image with {modelLabel(status?.modelLabel || status?.model)}. This uses the paid Comfy Router API, separate from hosted Comfy Cloud workflows. Local ComfyUI does not need to be running.</p>
        <section className="comfy-router-card" aria-labelledby="comfy-router-connection-title">
          <div className="comfy-router-row"><h3 id="comfy-router-connection-title">Router connection</h3><span className="comfy-router-badge">{status?.connected ? 'Connected for this session' : 'Not connected'}</span></div>
          <p className="comfy-router-muted">Use your workspace-backed Comfy API key here, never in chat. It is kept only until Velorn quits, not in your project or browser storage. Hosted and Partner/API keys are not automatically reused.</p>
          {status?.connected && <p className="comfy-router-muted">Key accepted for model access. Workspace access, credits and generation have not been verified by this connection check.</p>}
          <form onSubmit={connect}>
            <label htmlFor="comfy-router-key">Comfy Router API key</label>
            <input id="comfy-router-key" type="password" autoComplete="off" spellCheck={false} maxLength={4096} value={key}
              onChange={event => setKey(event.target.value)} disabled={disabled || !status} placeholder={status?.connected ? 'Paste a replacement key, if needed' : 'Paste your Comfy API key'} />
            <div className="comfy-router-actions">
              <button type="submit" disabled={disabled || !status || !key.trim()}>{pending === 'connect' ? 'Checking key…' : 'Connect Router'}</button>
              {status?.connected && <button type="button" disabled={disabled} onClick={() => { setKey(''); setPlan(null); void perform('clear', () => api.clear({}), async result => {
                if (connectionStatus(result)) setStatus(connectionStatus(result))
                await refreshLocalStatus()
                if (alive.current) setNotice('Session key removed. This does not revoke it at Comfy or cancel existing jobs.')
              }) }}>Forget session key</button>}
              {api?.openGuide && <button type="button" disabled={disabled} onClick={() => { void perform('guide', () => api.openGuide({})) }}>Get a Comfy API key</button>}
            </div>
          </form>
        </section>

        {blocked && <section className="comfy-router-warning" aria-label="Generation spending policy">
          <strong>Local-only generation is enabled.</strong>
          <p>Cloud image requests are blocked by your existing spending setting. Connecting and previewing do not generate an image.</p>
          {onOpenSpending && <button type="button" disabled={disabled} onClick={onOpenSpending}>Open generation spending settings</button>}
        </section>}

        <form onSubmit={preview} className="comfy-router-card">
          <label htmlFor="comfy-router-prompt">Describe your image</label>
          <textarea id="comfy-router-prompt" rows={4} maxLength={4000} value={prompt} disabled={disabled || !status?.connected}
            onChange={event => { setPrompt(event.target.value); setPlan(null) }} placeholder="A cinematic aerial view of a rain-soaked city at blue hour…" />
          <p className="comfy-router-muted">One image · 1024 × 1024 · provider watermark enabled. Previewing only prepares the request; it does not start or charge for generation.</p>
          <button type="submit" disabled={disabled || !status?.connected || !prompt.trim()}>{pending === 'preview' ? 'Preparing preview…' : 'Preview cost'}</button>
          {plan && <div className="comfy-router-estimate" aria-label="Generation cost preview">
            <strong>{estimateLabel(plan.estimate)}</strong>
            <p>{modelLabel(plan.modelLabel || status?.modelLabel || plan.model)} · 1 square image. Estimate, not a billing receipt; provider pricing may change{plan.estimate?.asOf ? ` (published ${plan.estimate.asOf})` : ''}.</p>
            <p>The next step opens Velorn’s native spending confirmation before submitting to Comfy Router.</p>
            {status?.policy !== 'ask-cloud' && !blocked && <p role="alert">Spending permission is unavailable. Refresh jobs to read the current policy before requesting generation.</p>}
            <button type="button" className="comfy-router-primary" disabled={disabled || status?.policy !== 'ask-cloud'} onClick={submit}>Request generation</button>
          </div>}
        </form>

        {pending && <p role="status" className="comfy-router-muted">{pending === 'loading' ? 'Reading cloud image status…' : pending === 'submit' ? 'Waiting for confirmation or submission…' : pending.startsWith('import:') ? 'Importing the completed image…' : 'Working…'}</p>}
        {error && <p role="alert" className="comfy-router-error">{error}</p>}
        {error && <RouterErrorDetails diagnostics={errorDiagnostics} />}
        {notice && <p role="status" className="comfy-router-notice">{notice}</p>}

        <section className="comfy-router-jobs" aria-labelledby="comfy-router-jobs-title">
          <div className="comfy-router-row"><h3 id="comfy-router-jobs-title">Image requests</h3><button type="button" disabled={disabled || !api?.list} onClick={() => { void perform('list', () => api.list({}), async result => {
            if (!Array.isArray(result.jobs)) throw new Error('Could not read image requests.')
            setJobs(result.jobs); await refreshLocalStatus()
          }) }}>Refresh jobs</button></div>
          {jobs.length === 0 && <p className="comfy-router-muted">No image requests for this project.</p>}
          {jobs.map(job => <article key={jobId(job)} className="comfy-router-card" aria-label={`Image request ${jobId(job)}`}>
            <div className="comfy-router-row"><h4>{modelLabel(job.modelLabel || job.model || status?.modelLabel || status?.model)}</h4><span className="comfy-router-badge">{statusLabel(job)}</span></div>
            {job.prompt && <p className="comfy-router-job-prompt">{job.prompt}</p>}
            <p className="comfy-router-muted">Request: {jobId(job)}</p>
            {job.error && <p className="comfy-router-error">{typeof job.error === 'string' ? job.error : 'This request needs attention. Refresh its status for the latest result.'}</p>}
            {job.status === 'UNCERTAIN' ? <p className="comfy-router-warning">Submission is unconfirmed, not a confirmed failure. It may still finish and spend credits. Check this request or your Comfy account before creating another image.</p>
              : job.errorType && <p className="comfy-router-error">{job.errorMessage || 'The provider reported a failed request. No image is available to import.'}</p>}
            <RouterErrorDetails diagnostics={job.diagnostics} />
            {job.needsReconnect && <p className="comfy-router-muted">Reconnect the Router key used for this request to check its provider status.</p>}
            <div className="comfy-router-actions">
              {job.canRefresh !== false && <button type="button" disabled={disabled || !status?.connected} onClick={() => { void perform(`refresh:${jobId(job)}`, () => api.refresh({ jobId: jobId(job) }), result => {
                updateJob(result.job)
                if (result.waiting) setNotice(`The provider asked us to wait. Check again in about ${Math.max(1, Math.ceil((result.job?.retryAfterMs || 1000) / 1000))} seconds.`)
              }) }}>Refresh status</button>}
              {cancelable(job) && <button type="button" disabled={disabled || !status?.connected} onClick={() => { void perform(`cancel:${jobId(job)}`, () => api.cancel({ jobId: jobId(job) }), result => {
                updateJob(result.job); setNotice('Cancellation was requested. Check the job status; completed work may still be billed.')
              }) }}>Request cancellation</button>}
              {completed(job) && <button type="button" disabled={disabled || !onImport} onClick={() => { void perform(`import:${jobId(job)}`, () => onImport(jobId(job)), result => {
                setImported(current => ({ ...current, [jobId(job)]: true })); setNotice(result.alreadyImported ? 'Showing the existing project image. No new generation or duplicate import.' : 'Image imported into project assets. Nothing was added to the timeline.')
              }) }}>{imported[jobId(job)] || job.importedAssetId ? 'Open / restore project image' : 'Import image to project'}</button>}
            </div>
            {cancelable(job) && <p className="comfy-router-muted">Cancellation is best effort; submitted work may still be billed.</p>}
          </article>)}
        </section>
      </div>
      <footer><p>Closing this panel does not cancel a submitted request. Router results expire after 24 hours; import completed images into your project to keep them.</p><button type="button" onClick={onClose}>Done</button></footer>
    </section>
  </div>
}
