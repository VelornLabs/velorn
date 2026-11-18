import { useState, useSyncExternalStore } from 'react'
import { useOpenDesktopAccount } from './DesktopAccount'
import GpuShareOwnWorkflows from './GpuShareOwnWorkflows'
import { acceptGpuShare, getGpuShare, loadGpuShare, subscribeGpuShare } from '../services/gpuShareState'

// The GPU sharing tab's right half: this computer's own choices for sharing
// its GPU, what it is doing for other people right now, and the last jobs they
// sent. Everything here is saved on this computer. Nothing is offered to anyone
// until the switch is on.
const box = 'rounded-lg border border-sf-dark-700 bg-sf-dark-900 p-3 flex flex-col gap-2 min-w-0'
const heading = 'text-[11px] font-semibold uppercase tracking-wide text-sf-text-muted'
const quiet = 'text-xs leading-relaxed text-sf-text-muted'
const button = 'flex-none rounded-md border border-sf-dark-600 bg-sf-dark-800 px-2.5 py-1 text-xs text-sf-text-primary hover:bg-sf-dark-700 disabled:opacity-45 disabled:cursor-default transition-colors'
const tick = 'mt-0.5 h-4 w-4 flex-none accent-sf-accent'
const OUTCOME = { done: 'Done', declined: 'Declined', stopped: 'Stopped', failed: 'Failed' }
const STAGE = { checking: 'Checking the job', asking: 'Waiting for your answer', preparing: 'Getting ready', queued: 'Waiting its turn', running: 'Making the clip', collecting: 'Collecting the clip', sending: 'Sending the clip back' }

export default function NetworkPanel() {
  const api = typeof window !== 'undefined' ? window.electronAPI?.gpuShare : null
  const { state, error: readError } = useSyncExternalStore(subscribeGpuShare, getGpuShare)
  const openAccount = useOpenDesktopAccount()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [invite, setInvite] = useState('')
  const [reporting, setReporting] = useState(null)

  const act = async (action, fallback) => {
    if (busy) return
    setBusy(true)
    try { const next = await action(); if (next?.success) { acceptGpuShare(next); setError('') } else setError(next?.error || fallback) }
    catch { setError(fallback) }
    finally { setBusy(false) }
  }
  const change = patch => act(() => api.update(patch), 'That change could not be saved.')
  const report = jobId => act(() => api.report(jobId), 'That job could not be reported.').finally(() => setReporting(null))
  const openJob = async jobId => {
    try { const result = await api.openJob(jobId); setError(result?.success ? '' : result?.error || 'That job’s files could not be opened.') }
    catch { setError('That job’s files could not be opened.') }
  }

  const settings = state?.settings, network = state?.network
  if (!api?.status) return <p className="text-sm text-sf-text-muted">The Velorn network is not available in this window.</p>
  if (!settings) return <div className="text-sm text-sf-text-muted" role="status">{readError || 'Reading your sharing choices…'}
    {readError && <button type="button" className={`${button} mt-3 block`} onClick={() => void loadGpuShare()}>Try again</button>}</div>

  const addInvite = () => { const value = invite.trim().toLowerCase(); if (!value) return; setInvite(''); void change({ invited: [...settings.invited, value] }) }
  const pill = !settings.enabled ? ['Off', 'bg-sf-dark-700 text-sf-text-muted'] : !network?.connected ? ['Not connected', 'bg-sf-warning/20 text-sf-warning']
    : network.job ? ['Busy', 'bg-sf-accent/20 text-sf-accent'] : ['Sharing', 'bg-sf-success/20 text-sf-success']
  const needsAccount = settings.enabled && !network?.connected && /sign in/i.test(network?.note || '')
  const recent = network?.recent || []

  return <div className="max-w-xl flex flex-col gap-3 text-sf-text-primary" data-testid="network-panel">
      <section className={box} aria-label="Share your GPU">
        <div className="flex items-center justify-between gap-2"><h3 className={heading}>Velorn network</h3>
          <span className={`flex-none rounded-full px-2 py-0.5 text-[11px] font-medium ${pill[1]}`}>{pill[0]}</span></div>
        <label className="flex items-start gap-2 text-sm cursor-pointer min-w-0">
          <input type="checkbox" className={tick} checked={settings.enabled} disabled={busy} onChange={event => void change({ enabled: event.target.checked })} />
          <span className="min-w-0">Share this computer’s GPU when it is free</span>
        </label>
        <p className={quiet} role="status">{!settings.enabled ? 'Sharing is off. Nothing is offered to anyone.' : network?.note || 'Connecting…'}{settings.enabled ? ` ${state.idle ? 'Right now: free.' : `Right now: not free. ${state.reasons.join(' ')}`}` : ''}</p>
        {needsAccount && <button type="button" className={`${button} self-start`} onClick={openAccount}>Open your account</button>}
        {network?.job && <div className="rounded-md bg-sf-dark-800 px-2.5 py-2 text-xs" role="status">
          <div className="font-medium break-words">Running a job for {network.job.from}</div>
          <div className="text-sf-text-muted">{STAGE[network.job.status] || 'Working on it'}. To stop it, switch sharing off.</div>
        </div>}
        {!network?.job && network?.lastJob && <p className={quiet}>Last job: {network.lastJob.from}, {(OUTCOME[network.lastJob.outcome] || network.lastJob.outcome).toLowerCase()}{network.lastJob.reason ? ` (${network.lastJob.reason})` : ''}.</p>}
        {!settings.enabled && <ol className="list-decimal ml-5 flex flex-col gap-0.5 text-xs leading-relaxed text-sf-text-secondary">
          <li>Switch sharing on.</li>
          <li>Tick what to share. Velorn only lists what your graphics card can run.</li>
          <li>Invite people by their Velorn email.</li>
        </ol>}
        {state.gpu && <p className={quiet}>Your graphics card: <span className="text-sf-text-secondary">{state.gpu.name}, {state.gpu.memoryGb} GB</span></p>}
        <p className={quiet}>Free, experimental. It only runs while this computer is free, and you can switch it off at any time. Nobody can send a workflow to this computer: only the ones you add yourself run here.</p>
      </section>

      <GpuShareOwnWorkflows />

      <section className={box} aria-label="Recent jobs from other people">
        <h3 className={heading}>Recent jobs from other people</h3>
        {recent.length === 0 ? <p className={quiet}>None yet. Jobs from people you invite show here, with the picture they sent and the clip that was made.</p>
          : <ul className="flex flex-col gap-2 min-w-0">{recent.map(job => <li key={job.jobId} className="rounded-md bg-sf-dark-800 px-2.5 py-2 flex flex-col gap-1.5 min-w-0">
            <div className="flex items-baseline justify-between gap-2 min-w-0">
              <span className="text-xs font-medium break-all min-w-0">{job.from}</span>
              <span className="flex-none text-[11px] text-sf-text-muted">{OUTCOME[job.outcome] || job.outcome}</span>
            </div>
            <p className="text-xs text-sf-text-secondary break-words">“{job.prompt}”</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              {job.hasFiles && api.openJob && <button type="button" className={button} title="Open the folder with the picture they sent and the clip that was made" onClick={() => void openJob(job.jobId)}>View</button>}
              {job.reported ? <span className="text-[11px] text-sf-text-muted">Reported</span>
                : reporting === job.jobId ? <><button type="button" className={button} disabled={busy} onClick={() => void report(job.jobId)}>Yes, report</button><button type="button" className={button} disabled={busy} onClick={() => setReporting(null)}>Cancel</button></>
                : <button type="button" className={button} disabled={busy} onClick={() => setReporting(job.jobId)}>Report</button>}
            </div>
          </li>)}</ul>}
        <p className={quiet}>Every job is tied to the sender’s Velorn account. This computer keeps the last 10. If one showed nudity or sexual acts, report it. The result (and the picture they sent) then go to Velorn’s reviewers, who look at it and decide. Reports made without cause can get your own account stopped.</p>
      </section>

      <section className={box} aria-label="Who you invite">
        <h3 className={heading}>Who you invite</h3>
        <p className={quiet}>Add the email of each person’s Velorn account. Your own computers on your account never need an invite.</p>
        {settings.invited.length > 0 && <ul className="flex flex-col gap-1.5 min-w-0">{settings.invited.map(person => <li key={person} className="flex items-center justify-between gap-2 min-w-0">
          <span className="text-xs break-all min-w-0">{person}</span>
          <button type="button" className={button} disabled={busy} onClick={() => void change({ invited: settings.invited.filter(item => item !== person) })}>Remove</button>
        </li>)}</ul>}
        <div className="flex gap-1.5 min-w-0">
          <input type="email" value={invite} maxLength={254} placeholder="name@example.com" aria-label="Email to invite" disabled={busy}
            className="flex-1 min-w-0 rounded-md border border-sf-dark-600 bg-sf-dark-950 px-2 py-1 text-xs text-sf-text-primary placeholder:text-sf-text-muted focus:outline-none focus:border-sf-accent"
            onChange={event => setInvite(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addInvite() } }} />
          <button type="button" className={button} disabled={busy || !invite.trim()} onClick={addInvite}>Invite</button>
        </div>
        <label className="flex items-start gap-2 text-sm cursor-pointer min-w-0 mt-1">
          <input type="checkbox" className={tick} checked={settings.askBeforeEach} disabled={busy} onChange={event => void change({ askBeforeEach: event.target.checked })} />
          <span className="min-w-0">Ask me before each job runs</span>
        </label>
        <label className="flex items-center justify-between gap-2 text-sm min-w-0" htmlFor="network-panel-daily">
          <span className="min-w-0">Jobs per invited person per day</span>
          <select id="network-panel-daily" value={settings.dailyLimitPerPerson} disabled={busy} onChange={event => void change({ dailyLimitPerPerson: Number(event.target.value) })}
            className="flex-none rounded-md border border-sf-dark-600 bg-sf-dark-950 px-2 py-1 text-xs text-sf-text-primary">
            {[1, 2, 3, 4, 5, 6, 8, 10].map(count => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
        {/* Open to everyone: the owner's own switch. Their approved own workflows and the Velorn ones they ticked are then free for any Velorn user, within these limits. */}
        <div className="mt-2 pt-2 border-t border-sf-dark-700 flex flex-col gap-2 min-w-0">
          <label className="flex items-start gap-2 text-sm cursor-pointer min-w-0">
            <input type="checkbox" className={tick} checked={settings.everyone?.enabled === true} disabled={busy} onChange={event => void change({ everyone: { ...settings.everyone, enabled: event.target.checked } })} />
            <span className="min-w-0">Open to everyone</span>
          </label>
          <p className={`${quiet} ml-6`}>{settings.everyone?.enabled ? 'Any Velorn user can now use those of your workflows that passed review. Not only the people you invite.'
            : 'Off: only the people you invite can use this computer. On: any Velorn user can, for those of your workflows that passed review.'}</p>
          {settings.everyone?.enabled && <div className="ml-6 flex flex-col gap-1.5 min-w-0">
            <label className="flex items-center justify-between gap-2 text-xs min-w-0"><span className="min-w-0">Jobs per person per day</span>
              <select value={settings.everyone.perPerson} disabled={busy} onChange={event => void change({ everyone: { ...settings.everyone, perPerson: Number(event.target.value) } })}
                className="flex-none rounded-md border border-sf-dark-600 bg-sf-dark-950 px-2 py-1 text-xs text-sf-text-primary">{[1, 2, 3, 4, 5, 6, 8, 10].map(count => <option key={count} value={count}>{count}</option>)}</select></label>
            <label className="flex items-center justify-between gap-2 text-xs min-w-0"><span className="min-w-0">Jobs for everyone together per day</span>
              <select value={settings.everyone.total} disabled={busy} onChange={event => void change({ everyone: { ...settings.everyone, total: Number(event.target.value) } })}
                className="flex-none rounded-md border border-sf-dark-600 bg-sf-dark-950 px-2 py-1 text-xs text-sf-text-primary">{[5, 10, 20, 50, 100, 200].map(count => <option key={count} value={count}>{count}</option>)}</select></label>
          </div>}
        </div>
      </section>
      {error && <p className="text-xs text-sf-error" role="status">{error}</p>}
  </div>
}
