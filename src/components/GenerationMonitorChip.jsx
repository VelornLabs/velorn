import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock3,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileOutput,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react'
import useGenerationMonitorStore from '../stores/generationMonitorStore'
import useProjectStore from '../stores/projectStore'
import { DISMISSED_RUNS_KEY, canDismissRun, isRunDismissed, readDismissedRuns, updateDismissedRuns, runTimestamp } from '../utils/generationRunVisibility.mjs'
import { captureMcpContext } from '../services/mcpContext'
import {
  adoptGenerationRun,
  controlGenerationRun,
  importGenerationRunResults,
  openGenerationRunRecipe,
  refreshGenerationRunObservation,
  setGenerationRunsObservation,
} from '../services/generationRuns'
import { APPROVAL_WAIT_LABEL, useAwaitingSpendApproval } from '../services/spendApprovalWait.mjs'

const ACTIVE_STATUSES = new Set(['uploading', 'configuring', 'submitting', 'queuing', 'queued', 'running', 'saving', 'importing'])
const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled', 'unknown'])

function statusLabel(job, awaitingApproval = false) {
  if (job.unsubmittedAttempt) return 'Not submitted'
  if (awaitingApproval && job.status === 'queuing') return APPROVAL_WAIT_LABEL
  switch (job.status) {
    case 'uploading': return 'Preparing inputs'
    case 'configuring': return 'Preparing workflow'
    case 'submitting': return 'Submitting'
    case 'queuing':
    case 'queued': return 'Queued in ComfyUI'
    case 'running': return 'Generating'
    case 'saving':
    case 'importing': return 'Saving output'
    case 'done': return 'Complete'
    case 'cancelled': return 'Cancelled'
    case 'unknown': return 'Needs attention'
    case 'error': return 'Failed'
    case 'paused': return 'Waiting for approval'
    default: return job.status ? String(job.status) : 'Waiting'
  }
}

function originLabel(job) {
  if (job.source === 'legacy') return 'Velorn managed'
  if (job.origin === 'agent') return 'Agent run'
  if (job.origin === 'external' && job.adopted) return 'External · tracked'
  if (job.origin === 'external') return 'External observed'
  return 'Velorn managed'
}

function runTone(job) {
  if (job.unsubmittedAttempt || job.status === 'error') return 'text-red-300 border-red-400/35 bg-red-500/5'
  if (job.status === 'done') return 'text-emerald-200 border-emerald-400/25 bg-emerald-500/5'
  if (job.status === 'unknown' || job.status === 'paused') return 'text-amber-100 border-amber-300/30 bg-amber-400/5'
  return 'text-sf-text-secondary border-sf-dark-700 bg-sf-dark-950/80'
}

function RunIcon({ job }) {
  if (job.unsubmittedAttempt || job.status === 'error') return <AlertTriangle className="h-4 w-4 text-red-300" aria-hidden="true" />
  if (job.status === 'done') return <CheckCircle2 className="h-4 w-4 text-emerald-300" aria-hidden="true" />
  if (ACTIVE_STATUSES.has(job.status)) return <Loader2 className="h-4 w-4 animate-spin text-sf-accent" aria-hidden="true" />
  if (job.origin === 'agent') return <Bot className="h-4 w-4 text-sf-blue" aria-hidden="true" />
  return <Clock3 className="h-4 w-4 text-sf-text-muted" aria-hidden="true" />
}

function sortRuns(a, b) {
  const rank = job => {
    if (ACTIVE_STATUSES.has(job.status)) return 0
    if (job.status === 'paused' || job.status === 'unknown') return 1
    if (job.status === 'error') return 2
    if (job.status === 'done') return 4
    return 3
  }
  const result = rank(a) - rank(b)
  if (result) return result
  return Number(b.createdAt || 0) - Number(a.createdAt || 0)
}

function readableOutputCount(job) {
  const count = Array.isArray(job.outputs) ? job.outputs.length : 0
  if (!count) return null
  return `${count} output${count === 1 ? '' : 's'} ready`
}

function executionLabel(job) {
  // A workflow label or a loopback ComfyUI URL does not establish where a
  // generation ran or whether it could spend credits. Only the native
  // spending assessment is authoritative enough to display an execution
  // classification here.
  const risk = String(job?.assessment?.risk || '').toLowerCase()
  if (risk === 'local') return 'Verified local'
  if (risk === 'paid') return 'Cloud / paid'
  if (risk === 'unknown') return 'Unverified'
  return null
}

function importStateLabel(job) {
  const state = String(job?.importState?.state || job?.importState || '').toLowerCase()
  if (state === 'partial') return 'Some outputs still need import'
  if (state === 'failed') return 'Import needs retry'
  return null
}

function GenerationRunCard({ job, isOtherProject, onAction, busyAction, dismissed, onDismiss }) {
  const awaitingApproval = useAwaitingSpendApproval()
  const timestamp = runTimestamp(job)
  const progressKnown = job.progressKnown !== false && Number.isFinite(Number(job.progress))
  const outputCount = readableOutputCount(job)
  const terminal = TERMINAL_STATUSES.has(job.status)
  const canImport = job.status === 'done'
    && Array.isArray(job.outputs) && job.outputs.length > 0
    && !isOtherProject
    && (job.origin === 'agent' || job.adopted === true || job.origin === 'velorn')
  const execution = executionLabel(job)
  const importState = importStateLabel(job)
  const isBusy = key => busyAction === `${job.runId || job.id}:${key}`

  return (
    <article
      data-generation-run-id={job.runId || job.id}
      className={`rounded-lg border p-3 ${runTone(job)}`}
    >
      <div className="flex gap-2.5">
        <div className="mt-0.5 flex-shrink-0"><RunIcon job={job} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold text-sf-text-primary">
                {job.workflowLabel || job.workflowId || 'ComfyUI generation'}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-sf-text-muted">
                <span>{originLabel(job)}</span>
                <span aria-hidden="true">·</span>
                <span>{statusLabel(job, awaitingApproval)}</span>
                {isOtherProject && <><span aria-hidden="true">·</span><span className="text-amber-200">Other project</span></>}
                {execution && <><span aria-hidden="true">·</span><span>{execution}</span></>}
              </div>
            </div>
            {progressKnown && <span className="font-mono text-[10px] text-sf-text-secondary">{Math.round(Number(job.progress))}%</span>}
            {canDismissRun(job) && <button type="button" disabled={Boolean(busyAction)} aria-label={`${dismissed ? 'Restore' : 'Dismiss'} ${job.workflowLabel || 'generation run'}`} title={dismissed ? 'Restore to queue' : 'Hide from queue (keeps files and history)'} onClick={() => onDismiss(job, !dismissed)} className="rounded px-1 text-[10px] text-sf-text-muted hover:bg-sf-dark-700 disabled:opacity-50">{dismissed ? 'Restore' : <X className="h-3.5 w-3.5" />}</button>}
          </div>

          {timestamp && <time dateTime={timestamp.iso} title={timestamp.title} className="mt-1 block text-[10px] text-sf-text-muted">{timestamp.label}{dismissed ? ' · Dismissed' : ''}</time>}

          {job.node && <div className="mt-1 truncate text-[10px] text-sf-text-muted">Working on {job.node}</div>}
          {job.error && <div className="mt-1 text-[10px] leading-4 text-red-200">{job.error}</div>}
          {!job.error && outputCount && <div className="mt-1 text-[10px] text-emerald-200/80">{outputCount}</div>}
          {importState && <div className="mt-1 text-[10px] leading-4 text-amber-200">{importState}</div>}
          {job.outputsTruncated === true && <div className="mt-1 text-[10px] leading-4 text-amber-200">Only the first {Array.isArray(job.outputs) ? job.outputs.length : 0} of {job.outputCount || 'more'} outputs can be safely handled here.</div>}

          {progressKnown && !terminal && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-sf-dark-700">
              <div className="h-full rounded-full bg-sf-accent transition-[width] duration-300" style={{ width: `${Math.max(2, Math.min(100, Number(job.progress)))}%` }} />
            </div>
          )}

          <div className="mt-2 flex flex-wrap gap-1.5">
            {canImport && (
              <button type="button" disabled={Boolean(busyAction)} onClick={() => onAction(job, 'import')} className="inline-flex items-center gap-1 rounded border border-sf-accent/50 bg-sf-accent/15 px-2 py-1 text-[10px] font-medium text-sf-text-primary hover:bg-sf-accent/25 disabled:cursor-wait disabled:opacity-60">
                {isBusy('import') ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />} Import outputs
              </button>
            )}
            {job.recipeAvailable === true && !isOtherProject && (
              <button type="button" disabled={Boolean(busyAction)} onClick={() => onAction(job, 'recipe')} className="inline-flex items-center gap-1 rounded border border-sf-dark-600 px-2 py-1 text-[10px] text-sf-text-secondary hover:border-sf-dark-500 hover:bg-sf-dark-800 disabled:cursor-wait disabled:opacity-60">
                {isBusy('recipe') ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />} Open in ComfyUI
              </button>
            )}
            {job.status === 'queued' && job.origin !== 'external' && !isOtherProject && (
              <button type="button" disabled={Boolean(busyAction)} onClick={() => onAction(job, 'cancel')} className="rounded border border-red-400/35 px-2 py-1 text-[10px] text-red-200 hover:bg-red-500/10 disabled:cursor-wait disabled:opacity-60">
                {isBusy('cancel') ? 'Cancelling…' : 'Cancel queued run'}
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}

function ObservedExternalCard({ item, busyAction, onTrack }) {
  const isTracked = Boolean(item.runId)
  return (
    <article className="rounded-lg border border-sf-dark-700 bg-sf-dark-950/70 p-3">
      <div className="flex items-start gap-2.5">
        <Eye className="mt-0.5 h-4 w-4 flex-shrink-0 text-sf-text-muted" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-sf-text-primary">{item.label || 'External ComfyUI job'}</div>
          <div className="mt-0.5 text-[10px] text-sf-text-muted">Read-only · {statusLabel(item)}</div>
          <div className="mt-2">
            {isTracked ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-emerald-200"><CheckCircle2 className="h-3 w-3" />Tracked in Velorn</span>
            ) : (
              <button type="button" disabled={Boolean(busyAction)} onClick={() => onTrack(item)} className="rounded border border-sf-blue/50 bg-sf-blue/10 px-2 py-1 text-[10px] font-medium text-sf-text-primary hover:bg-sf-blue/20 disabled:cursor-wait disabled:opacity-60">
                {busyAction === `observe:${item.promptId}` ? 'Tracking…' : 'Track in this project'}
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}

function GenerationMonitorChip() {
  const jobs = useGenerationMonitorStore(state => state.jobs)
  const runsAvailable = useGenerationMonitorStore(state => state.runsAvailable)
  const observation = useGenerationMonitorStore(state => state.observation)
  const currentProjectHandle = useProjectStore(state => state.currentProjectHandle)
  const currentProjectId = useProjectStore(state => state.currentProject?.id)
  const [open, setOpen] = useState(false)
  const [busyAction, setBusyAction] = useState(null)
  const [notice, setNotice] = useState(null)
  const [showDismissed, setShowDismissed] = useState(false)
  const [dismissedKeys, setDismissedKeys] = useState(() => {
    try { return readDismissedRuns(window.localStorage) } catch { return [] }
  })
  const changeVisibility = (items, dismiss) => {
    // Display preference only: never remove ledger entries, files or MCP results.
    const next = updateDismissedRuns(dismissedKeys, items, dismiss)
    setDismissedKeys(next)
    try { window.localStorage.setItem(DISMISSED_RUNS_KEY, JSON.stringify(next)) }
    catch { setNotice('Queue visibility changed for this session, but could not be saved on this device.') }
  }

  const currentProjectKey = useMemo(() => {
    try { return captureMcpContext()?.projectKey || null } catch (_) { return null }
  }, [currentProjectHandle, currentProjectId])
  const dismissedJobs = useMemo(() => jobs.filter(job => isRunDismissed(job, dismissedKeys)), [jobs, dismissedKeys])
  const sortedJobs = useMemo(() => jobs.filter(job => !isRunDismissed(job, dismissedKeys)).sort(sortRuns), [jobs, dismissedKeys])
  const visibleJobs = showDismissed ? [...sortedJobs, ...dismissedJobs.slice().sort(sortRuns)] : sortedJobs
  const activeJobs = useMemo(() => sortedJobs.filter(job => ACTIVE_STATUSES.has(job.status)), [sortedJobs])
  const failedJobs = useMemo(() => sortedJobs.filter(job => job.status === 'error' || job.unsubmittedAttempt), [sortedJobs])
  const observedJobs = observation?.enabled === true && Array.isArray(observation.jobs) ? observation.jobs : []

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = event => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  const runAction = useCallback(async (job, action) => {
    const id = job.runId || job.id
    if (!id) return
    if (action === 'cancel' && !window.confirm('Remove this queued prompt from ComfyUI? Running work will not be interrupted.')) return
    setBusyAction(`${id}:${action}`)
    setNotice(null)
    try {
      const result = action === 'import'
        ? await importGenerationRunResults(id, { previewOnly: false })
        : action === 'recipe'
          ? await openGenerationRunRecipe(id)
          : await controlGenerationRun(id, 'cancel')
      if (result?.success === false) throw new Error(result.error || 'The generation-run action could not be completed.')
      setNotice(result?.message || result?.hint || (action === 'import' ? 'Outputs imported into this project.' : 'Generation run updated.'))
    } catch (error) {
      setNotice(error?.message || 'The generation-run action could not be completed.')
    } finally {
      setBusyAction(null)
    }
  }, [])

  const trackObserved = useCallback(async (item) => {
    if (!item?.promptId) return
    setBusyAction(`observe:${item.promptId}`)
    setNotice(null)
    try {
      const result = await adoptGenerationRun(item.promptId, { label: item.label })
      if (result?.success === false) throw new Error(result.error || 'Could not track that ComfyUI job.')
      setNotice(result?.message || 'ComfyUI job is now tracked in this project.')
      await setGenerationRunsObservation(true)
    } catch (error) {
      setNotice(error?.message || 'Could not track that ComfyUI job.')
    } finally {
      setBusyAction(null)
    }
  }, [])

  const toggleObservation = useCallback(async () => {
    setBusyAction('observation')
    setNotice(null)
    try {
      const result = await setGenerationRunsObservation(observation?.enabled !== true)
      if (result?.success === false) throw new Error(result.error || 'Could not inspect external ComfyUI jobs.')
      setNotice(result?.message || (observation?.enabled ? 'External observation hidden.' : 'External ComfyUI queue observed without importing anything.'))
    } catch (error) {
      setNotice(error?.message || 'Could not inspect external ComfyUI jobs.')
    } finally {
      setBusyAction(null)
    }
  }, [observation?.enabled])

  const refresh = useCallback(async () => {
    setBusyAction('refresh')
    setNotice(null)
    try {
      const result = await refreshGenerationRunObservation()
      if (result?.success === false) throw new Error(result.error || 'Could not refresh generation runs.')
      setNotice(result?.message || 'Generation queue refreshed.')
    } catch (error) {
      setNotice(error?.message || 'Could not refresh generation runs.')
    } finally {
      setBusyAction(null)
    }
  }, [])

  const chipLabel = activeJobs.length > 0
    ? `${activeJobs.length} generation${activeJobs.length === 1 ? '' : 's'} active`
    : failedJobs.length > 0
      ? `${failedJobs.length} generation issue${failedJobs.length === 1 ? '' : 's'}`
      : 'Generation queue'

  const drawer = open && typeof document !== 'undefined' ? createPortal(
    <div className="pointer-events-none fixed inset-0 z-[100] flex justify-end">
      <aside data-generation-queue-drawer role="dialog" aria-label="Generation queue" className="pointer-events-auto flex h-full w-[min(470px,calc(100vw-20px))] flex-col border-l border-sf-dark-600 bg-sf-dark-900 shadow-2xl">
        <header className="border-b border-sf-dark-700 px-4 py-3.5">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-md border border-sf-accent/35 bg-sf-accent/10 p-1.5 text-sf-accent"><FileOutput className="h-4 w-4" /></div>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-sf-text-primary">Generation queue</h2>
              <p className="mt-0.5 text-[11px] leading-4 text-sf-text-muted">Velorn-managed and agent-run ComfyUI work. External observation is read-only until you explicitly track a job.</p>
            </div>
            <button type="button" aria-label="Close generation queue" onClick={() => setOpen(false)} className="rounded p-1 text-sf-text-muted hover:bg-sf-dark-700 hover:text-sf-text-primary"><X className="h-4 w-4" /></button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] ${runsAvailable ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100' : 'border-amber-300/30 bg-amber-400/10 text-amber-100'}`}><Circle className={`h-2 w-2 fill-current ${runsAvailable ? 'text-emerald-300' : 'text-amber-300'}`} />{runsAvailable ? 'Run tracker connected' : 'Run tracker unavailable'}</span>
            <span className="text-[10px] text-sf-text-muted">{activeJobs.length} active · {sortedJobs.filter(job => job.status === 'done').length} complete</span>
            <button type="button" onClick={refresh} disabled={Boolean(busyAction)} className="ml-auto inline-flex items-center gap-1 rounded border border-sf-dark-600 px-2 py-1 text-[10px] text-sf-text-secondary hover:bg-sf-dark-800 disabled:cursor-wait disabled:opacity-60"><RefreshCw className={`h-3 w-3 ${busyAction === 'refresh' ? 'animate-spin' : ''}`} />Refresh</button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
          {notice && <div role="status" className="mb-3 rounded border border-sf-blue/30 bg-sf-blue/10 px-2.5 py-2 text-[11px] leading-4 text-sf-text-secondary">{notice}</div>}
          <section aria-label="Tracked generation runs">
            <div className="mb-3 flex flex-wrap items-center gap-3 text-[11px] text-sf-text-secondary">
              <button type="button" disabled={Boolean(busyAction) || !sortedJobs.some(canDismissRun)} onClick={() => changeVisibility(sortedJobs, true)} title="Hide completed, failed and cancelled runs. No files are deleted." className="rounded border border-sf-dark-600 px-2 py-1 hover:bg-sf-dark-800 disabled:opacity-40">Clear finished</button>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={showDismissed} onChange={event => setShowDismissed(event.target.checked)} />Show dismissed ({dismissedJobs.length})</label>
            </div>
            <div className="mb-2 flex items-center justify-between gap-2 px-0.5"><h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-sf-text-muted">Tracked runs</h3><span className="text-[10px] text-sf-text-muted">{sortedJobs.length}</span></div>
            <div className="space-y-2">
              {visibleJobs.length ? visibleJobs.map(job => {
                const isOtherProject = Boolean(job.projectKey && currentProjectKey && job.projectKey !== currentProjectKey)
                return <GenerationRunCard key={job.id} job={job} isOtherProject={isOtherProject} onAction={runAction} busyAction={busyAction} dismissed={isRunDismissed(job, dismissedKeys)} onDismiss={(item, dismiss) => changeVisibility([item], dismiss)} />
              }) : (
                <div className="rounded-lg border border-dashed border-sf-dark-600 bg-sf-dark-950/50 px-3 py-5 text-center"><Sparkles className="mx-auto h-4 w-4 text-sf-text-muted" /><p className="mt-2 text-xs text-sf-text-secondary">{dismissedJobs.length ? 'Queue cleared. Show dismissed to restore previous runs.' : 'No tracked generation runs yet.'}</p><p className="mt-1 text-[10px] leading-4 text-sf-text-muted">Agent-run workflows will appear here without needing to open Generate.</p></div>
              )}
            </div>
          </section>

          {observation?.enabled === true && (
            <section className="mt-5 border-t border-sf-dark-700 pt-4" aria-label="Observed external ComfyUI jobs">
              <div className="mb-1 flex items-center gap-2"><Eye className="h-3.5 w-3.5 text-sf-text-muted" /><h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-sf-text-muted">External ComfyUI jobs</h3></div>
              <p className="mb-2 text-[10px] leading-4 text-sf-text-muted">Observed from the current ComfyUI queue. These are not imported, cancelled, or adopted automatically.</p>
              <div className="space-y-2">{observedJobs.length ? observedJobs.map(item => <ObservedExternalCard key={item.promptId} item={item} busyAction={busyAction} onTrack={trackObserved} />) : <p className="rounded border border-dashed border-sf-dark-700 px-3 py-3 text-[10px] text-sf-text-muted">No external queued jobs are visible right now.</p>}</div>
            </section>
          )}
        </div>

        <footer className="border-t border-sf-dark-700 p-3.5">
          <button type="button" aria-pressed={observation?.enabled === true} onClick={toggleObservation} disabled={Boolean(busyAction)} className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-wait disabled:opacity-60 ${observation?.enabled ? 'border-sf-blue/45 bg-sf-blue/10' : 'border-sf-dark-600 bg-sf-dark-950/60 hover:bg-sf-dark-800'}`}>
            <span className="flex min-w-0 items-center gap-2">{observation?.enabled ? <Eye className="h-4 w-4 flex-shrink-0 text-sf-blue" /> : <EyeOff className="h-4 w-4 flex-shrink-0 text-sf-text-muted" />}<span><span className="block text-[11px] font-medium text-sf-text-primary">Observe external ComfyUI jobs</span><span className="block text-[10px] leading-4 text-sf-text-muted">Read-only. You choose which job to track in this project.</span></span></span>
            {busyAction === 'observation' ? <Loader2 className="h-4 w-4 animate-spin text-sf-text-muted" /> : <span className={`h-4 w-7 rounded-full p-0.5 ${observation?.enabled ? 'bg-sf-blue' : 'bg-sf-dark-600'}`}><span className={`block h-3 w-3 rounded-full bg-white transition-transform ${observation?.enabled ? 'translate-x-3' : ''}`} /></span>}
          </button>
        </footer>
      </aside>
    </div>,
    document.body,
  ) : null

  return (
    <>
      <button type="button" aria-label="Open generation queue" aria-expanded={open} onClick={() => setOpen(value => !value)} className={`mr-1 inline-flex h-7 max-w-[210px] items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors hover:bg-sf-dark-700 ${activeJobs.length ? 'border-sf-accent/45 bg-sf-accent/10 text-sf-text-primary' : failedJobs.length ? 'border-red-400/40 bg-red-500/10 text-red-100' : 'border-sf-dark-600 bg-sf-dark-800 text-sf-text-secondary'}`} title={chipLabel}>
        {activeJobs.length ? <Loader2 className="h-3.5 w-3.5 animate-spin text-sf-accent" /> : failedJobs.length ? <AlertTriangle className="h-3.5 w-3.5 text-red-300" /> : <Sparkles className="h-3.5 w-3.5 text-sf-accent" />}<span className="truncate whitespace-nowrap">{chipLabel}</span><ChevronDown className="h-3 w-3 flex-shrink-0 text-sf-text-muted" />
      </button>
      {drawer}
    </>
  )
}

export default GenerationMonitorChip
