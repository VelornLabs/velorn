import { useEffect, useId, useRef, useState } from 'react'
import { Download, Loader2, X } from 'lucide-react'
import './ToolSetupAssistant.css'

// Remember only this renderer session's installer receipt. Leaving Settings
// must not cancel a download or make reopening offer an accidental duplicate.
// No account, project, preference or persistent browser storage is involved.
const sessionDownloads = new Map()
const INSTALL_GUIDES = Object.freeze({ lmstudio: 'https://lmstudio.ai/download', comfyui: 'https://docs.comfy.org/installation/desktop/overview' })
const STATES = new Set(['downloading', 'completed', 'failed', 'cancelled'])
const safeError = (value, fallback) => typeof value === 'string' && value ? value.slice(0, 700) : fallback
const bytes = value => Number.isFinite(value) && value >= 0
  ? `${(value / (1024 ** 2)).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB` : 'Size unavailable'
const activeJob = job => job?.state === 'downloading'
const hostLabel = host => [host?.platform === 'darwin' ? 'macOS' : host?.platform === 'win32' ? 'Windows' : host?.platform,
  host?.arch === 'arm64' ? (host?.platform === 'darwin' ? 'Apple Silicon / ARM64' : 'ARM64') : host?.arch,
  Number.isFinite(host?.memoryGiB) ? `${host.memoryGiB.toLocaleString(undefined, { maximumFractionDigits: 1 })} GB memory` : 'Memory not verified',
].filter(Boolean).join(' · ')

function jobResult(result, integration, expectedId) {
  const job = result?.job || result
  if (result?.success !== true || typeof job?.jobId !== 'string' || !STATES.has(job.state)
    || (job.integration && job.integration !== integration) || (expectedId && job.jobId !== expectedId)) {
    throw new Error(safeError(result?.error, 'Could not verify this installer download. Check its progress before trying again.'))
  }
  return job
}

/** Explicit, optional installer assistance. Mounting never probes or downloads. */
export default function ToolSetupAssistant({ integration, name, disabled = false, onCheck }) {
  const [expanded, setExpanded] = useState(false)
  const [plan, setPlan] = useState(null)
  const [job, setJob] = useState(null)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pollFailed, setPollFailed] = useState(false)
  const [cached, setCached] = useState(() => sessionDownloads.has(integration))
  const alive = useRef(false), version = useRef(0), operation = useRef(null), opener = useRef(null)
  const titleId = useId(), panelId = useId()
  const api = window.electronAPI?.toolSetup
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; version.current += 1; operation.current = null }
  }, [integration])
  const current = token => alive.current && version.current === token
  const requireMethod = method => {
    if (typeof api?.[method] !== 'function') throw new Error('Fully quit and reopen the latest Velorn build to use guided tool setup.')
    return api[method]
  }
  const acceptJob = (result, expectedId) => {
    const next = jobResult(result, integration, expectedId)
    const saved = sessionDownloads.get(integration)
    if (saved && (!saved.job || saved.job.jobId === next.jobId)) saved.job = next
    return next
  }
  const run = async (action, task) => {
    if (operation.current) return
    const token = version.current, request = {}
    operation.current = request
    setPending(action); setError(''); setNotice('')
    try { await task(token) }
    catch (failure) { if (current(token)) setError(safeError(failure?.message, 'Setup could not finish. No automatic retry was started.')) }
    finally {
      if (operation.current === request) operation.current = null
      if (current(token)) setPending('')
    }
  }
  const refreshJob = async token => {
    if (!job?.jobId) return
    const result = await requireMethod('status')({ jobId: job.jobId })
    if (!current(token)) return
    setJob(acceptJob(result, job.jobId)); setPollFailed(false)
  }
  useEffect(() => {
    if (!expanded || pending || pollFailed || !activeJob(job)) return undefined
    let cancelled = false
    const token = version.current
    const timer = setTimeout(async () => {
      try {
        const result = await requireMethod('status')({ jobId: job.jobId })
        if (!cancelled && current(token)) setJob(acceptJob(result, job.jobId))
      } catch (failure) {
        if (!cancelled && current(token)) {
          setPollFailed(true)
          setError(safeError(failure?.message, 'Progress could not be checked. The download may still be running. Check progress before starting another.'))
        }
      }
    }, 1000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [expanded, pending, pollFailed, job, integration, api])

  const prepare = async () => {
    if (operation.current) return
    setExpanded(true)
    const saved = sessionDownloads.get(integration)
    if (saved) {
      setPlan(saved.plan); setJob(saved.job || null); setCached(true)
      await run('status', async token => {
        // A native approval may still be pending after this panel was closed.
        // Reattach its receipt; do not submit a second download request.
        if (saved.pending) await saved.pending
        if (!current(token)) return
        if (saved.error) throw new Error(saved.error)
        setJob(saved.job || null)
        if (saved.job?.jobId) {
          const result = await requireMethod('status')({ jobId: saved.job.jobId })
          if (!current(token)) return
          setJob(acceptJob(result, saved.job.jobId)); setPollFailed(false)
        }
      })
      return
    }
    await run('plan', async token => {
      setPlan(null); setJob(null)
      const result = await requireMethod('plan')({ integration })
      if (!current(token)) return
      if (result?.success !== true || typeof result.planId !== 'string' || result.integration !== integration) {
        throw new Error(safeError(result?.error, 'The setup plan could not be checked. Nothing was downloaded.'))
      }
      setPlan(result)
    })
  }
  const close = () => {
    version.current += 1; operation.current = null
    setExpanded(false); setPending(''); setError(''); setNotice('')
    opener.current?.focus()
  }
  const download = () => run('download', async token => {
    if (!plan?.download?.canDownload || !plan.download.supported || !Number.isFinite(plan.download.bytes) || plan.download.bytes <= 0) return
    if (sessionDownloads.has(integration)) throw new Error('An installer request is already tracked. Review its progress first.')
    const saved = { plan, job: null, error: '', pending: null }
    sessionDownloads.set(integration, saved); setCached(true)
    saved.pending = Promise.resolve().then(() => requireMethod('download')({ planId: plan.planId })).then(result => {
      if (result?.cancelled === true || result?.code === 'CANCELLED' || result?.code === 'DECLINED') {
        saved.error = 'Download not approved. No installer download was started.'
        return
      }
      saved.job = jobResult(result, integration)
    }).catch(failure => { saved.error = safeError(failure?.message, 'The download request could not be confirmed. Check setup before trying again.') })
      .finally(() => { saved.pending = null })
    await saved.pending
    if (!current(token)) return
    if (saved.error) throw new Error(saved.error)
    setJob(saved.job); setPollFailed(false)
  })
  const cancel = () => run('cancel', async token => {
    const result = await requireMethod('cancel')({ jobId: job.jobId })
    if (!current(token)) return
    setJob(acceptJob(result, job.jobId)); setPollFailed(false)
  })
  const openInstaller = () => run('open', async token => {
    const result = await requireMethod('open')({ jobId: job.jobId })
    if (!current(token)) return
    if (result?.success !== true || !result.cancelled && result.opened !== true) throw new Error(safeError(result?.error, 'The installer could not be confirmed open. No retry was started.'))
    setNotice(result?.cancelled ? 'Opening cancelled.' : 'Installer opened. Complete its instructions yourself, then start the app and check setup again. Opening an installer does not mean the tool is installed or connected.')
  })
  const openGuide = () => run('guide', async () => {
    const url = INSTALL_GUIDES[integration]
    if (!url || !window.electronAPI?.openExternalUrl) throw new Error(`Open ${url || 'the official vendor setup guide'} in your browser.`)
    const result = await window.electronAPI.openExternalUrl(url)
    if (result?.success === false) throw new Error(`Open ${url} in your browser for the official setup guide.`)
  })
  const newPlan = () => {
    if (operation.current || activeJob(job) || sessionDownloads.get(integration)?.pending) return
    sessionDownloads.delete(integration); setCached(false); setPlan(null); setJob(null); setPollFailed(false)
    void prepare()
  }
  const terminal = job && !activeJob(job)
  const canDownload = plan?.download?.supported === true && plan.download.canDownload === true
    && Number.isFinite(plan.download.bytes) && plan.download.bytes > 0
  const setupText = typeof plan?.readiness === 'string' ? plan.readiness : plan?.readiness?.summary
  const buttonDisabled = disabled || Boolean(pending)
  return <div className="tool-setup-assistant">
    <button ref={opener} type="button" aria-label={`${cached ? 'Review' : 'Plan'} ${name} setup`} aria-expanded={expanded} aria-controls={panelId}
      disabled={disabled || Boolean(pending)} onClick={() => void prepare()}>{cached ? 'Review setup download' : 'Plan setup'}</button>
    {expanded && <section id={panelId} className="tool-setup-plan" aria-labelledby={titleId}>
      <div className="tool-setup-plan-heading"><h4 id={titleId}>{name} setup plan</h4>
        <button type="button" aria-label={`Close ${name} setup plan`} onClick={close}><X size={16} aria-hidden="true" /></button></div>
      {pending && <p role="status" className="tool-setup-progress"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{pending === 'plan' ? 'Checking this computer…' : pending === 'download' ? 'Waiting for native approval and the download receipt…' : pending === 'open' ? 'Waiting for approval to open the verified installer…' : pending === 'cancel' ? 'Cancelling download…' : pending === 'guide' ? 'Opening the official setup guide…' : 'Checking download progress…'}</p>}
      {plan && <>
        <p>{hostLabel(plan.host)}</p>
        {setupText && <p>{setupText}</p>}
        {plan.installation?.summary && <p>{plan.installation.summary}</p>}
        <dl className="tool-setup-details">
          <dt>Installer source</dt><dd>{plan.download?.sourceUrl || 'Use the official setup guide below.'}</dd>
          <dt>Installer size</dt><dd>{bytes(plan.download?.bytes)}{Number.isFinite(plan.download?.maxBytes) && ` · Limit ${bytes(plan.download.maxBytes)}`}</dd>
          <dt>Download destination</dt><dd>{plan.download?.destination || 'Choose the destination in the official installer.'}</dd>
        </dl>
        <p>No models are downloaded by this step. In the vendor app, review each model’s size, license and storage needs before downloading it.</p>
        {!canDownload && !job && <p className="tool-setup-warning">A managed installer download is not available for this plan. Use the official guide; no installation or connection is assumed.</p>}
        {Array.isArray(plan.steps) && plan.steps.length > 0 && <ol>{plan.steps.slice(0, 12).map((step, index) => <li key={index}>{step}</li>)}</ol>}
        {Array.isArray(plan.warnings) && plan.warnings.length > 0 && <ul className="tool-setup-warnings">{plan.warnings.slice(0, 12).map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        {!job && !cached && canDownload && <button type="button" disabled={buttonDisabled} onClick={() => void download()}><Download size={14} aria-hidden="true" /> Download installer</button>}
        {!job && !cached && <p className="optional-setup-hint">Downloading and opening each require native confirmation, even with agent Full access. You complete the installer, OS permissions and any sign-in yourself.</p>}
      </>}
      {job && <div className="tool-setup-job" aria-live="polite">
        <p>{activeJob(job) ? 'Downloading installer…' : job.state === 'completed' ? 'Installer downloaded — not installed or connected yet.' : job.state === 'cancelled' ? 'Installer download cancelled.' : 'Installer download failed.'}</p>
        {activeJob(job) && <>
          <progress aria-label={`${name} installer download progress`} {...(Number.isFinite(job.totalBytes) && job.totalBytes > 0 ? { value: Math.min(job.bytesReceived || 0, job.totalBytes), max: job.totalBytes } : {})} />
          <p>{bytes(job.bytesReceived || 0)} received{Number.isFinite(job.totalBytes) && job.totalBytes > 0 ? ` of ${bytes(job.totalBytes)}` : ' · total size unavailable'}</p>
        </>}
        {job.error && <p className="optional-setup-error">{typeof job.error === 'string' ? job.error : job.error.message}</p>}
        {job.warning && <p className="tool-setup-warning">{job.warning}</p>}
        <div className="optional-setup-actions">
          {activeJob(job) && <button type="button" disabled={buttonDisabled} onClick={() => void cancel()}>Cancel download</button>}
          {pollFailed && <button type="button" disabled={buttonDisabled} onClick={() => void run('status', refreshJob)}>Check download progress</button>}
          {job.state === 'completed' && job.canOpen === true && <button type="button" disabled={buttonDisabled} onClick={() => void openInstaller()}>Open installer</button>}
        </div>
        <p className="optional-setup-hint">Closing setup stops these progress checks, not the download. Review setup to reconnect to this receipt during this Velorn session.</p>
      </div>}
      {error && <p className="optional-setup-error" role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="optional-setup-actions">
        <button type="button" disabled={buttonDisabled} onClick={() => void openGuide()}>Official {name} setup guide</button>
        <button type="button" disabled={buttonDisabled} onClick={() => void onCheck?.()}>Check {name} setup again</button>
        {(terminal || !job && !pending) && <button type="button" disabled={buttonDisabled} onClick={newPlan}>Refresh {name} setup plan</button>}
      </div>
      <p className="optional-setup-hint">Your editor, selected agent, models, chat and projects are unchanged. Setup and model downloads are optional.</p>
    </section>}
  </div>
}
