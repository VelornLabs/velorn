import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Loader2,
  Sparkles,
} from 'lucide-react'
import useGenerationMonitorStore from '../stores/generationMonitorStore'
import {
  ACTIVE_JOB_STATUSES,
  NON_TERMINAL_JOB_STATUSES,
} from '../config/generateWorkspaceConfig'

const ACTIVE_STATUSES = new Set(ACTIVE_JOB_STATUSES)
const NON_TERMINAL_STATUSES = new Set(NON_TERMINAL_JOB_STATUSES)
const TERMINAL_STATUSES = new Set(['done', 'error'])

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
  return `${seconds}s`
}

function getJobElapsedMs(job, now) {
  const start = Number(job.startedAt || job.createdAt)
  if (!Number.isFinite(start) || start <= 0) return 0
  const end = TERMINAL_STATUSES.has(job.status) && job.completedAt ? Number(job.completedAt) : now
  return Math.max(0, end - start)
}

function estimateActiveRemainingMs(job, now) {
  if (!job || !ACTIVE_STATUSES.has(job.status)) return null
  const progress = Math.max(0, Math.min(99, Number(job.progress) || 0))
  if (progress < 5) return null
  const elapsed = getJobElapsedMs(job, now)
  if (elapsed <= 0) return null
  const estimatedTotal = elapsed / (progress / 100)
  return Math.max(0, estimatedTotal - elapsed)
}

function estimateQueuedDurationMs(job, completedJobs, activeTotalMs) {
  const sameWorkflow = completedJobs
    .filter((candidate) => (
      candidate.workflowId === job.workflowId &&
      Number(candidate.elapsedMs) > 0
    ))
    .map((candidate) => Number(candidate.elapsedMs))
    .sort((a, b) => a - b)
  if (sameWorkflow.length > 0) {
    return sameWorkflow[Math.floor(sameWorkflow.length / 2)]
  }
  return activeTotalMs || null
}

function getStatusLabel(status) {
  switch (status) {
    case 'uploading': return 'Uploading'
    case 'configuring': return 'Configuring'
    case 'queuing': return 'Queuing'
    case 'running': return 'Generating'
    case 'saving': return 'Importing'
    case 'paused': return 'Paused'
    case 'done': return 'Done'
    case 'error': return 'Failed'
    default: return 'Queued'
  }
}

function sortJobsForDisplay(a, b) {
  const rank = (job) => {
    if (ACTIVE_STATUSES.has(job.status)) return 0
    if (job.status === 'queued') return 1
    if (job.status === 'paused') return 2
    if (job.status === 'error') return 3
    if (job.status === 'done') return 4
    return 5
  }
  const diff = rank(a) - rank(b)
  if (diff !== 0) return diff
  return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0)
}

function JobStatusIcon({ job }) {
  if (job.status === 'error') return <AlertTriangle className="h-3.5 w-3.5 text-red-300" />
  if (job.status === 'done') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
  if (ACTIVE_STATUSES.has(job.status)) return <Loader2 className="h-3.5 w-3.5 animate-spin text-sf-accent" />
  return <Clock3 className="h-3.5 w-3.5 text-sf-text-muted" />
}

function GenerationMonitorChip({ onOpenGenerate }) {
  const jobs = useGenerationMonitorStore((state) => state.jobs)
  const activeJobId = useGenerationMonitorStore((state) => state.activeJobId)
  const isConnected = useGenerationMonitorStore((state) => state.isConnected)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const popoverRef = useRef(null)

  useEffect(() => {
    const hasLiveWork = jobs.some((job) => NON_TERMINAL_STATUSES.has(job.status))
    if (!hasLiveWork && !open) return undefined
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [jobs, open])

  useEffect(() => {
    if (!open) return undefined
    const handlePointerDown = (event) => {
      if (!popoverRef.current) return
      if (popoverRef.current.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  const summary = useMemo(() => {
    const queued = jobs.filter((job) => job.status === 'queued')
    const active = jobs.filter((job) => ACTIVE_STATUSES.has(job.status))
    const paused = jobs.filter((job) => job.status === 'paused')
    const failed = jobs.filter((job) => job.status === 'error')
    const done = jobs.filter((job) => job.status === 'done')
    const nonTerminal = jobs.filter((job) => NON_TERMINAL_STATUSES.has(job.status))
    const visible = [...nonTerminal, ...failed].sort(sortJobsForDisplay)
    const activeJob = active.find((job) => job.id === activeJobId) || active[0] || null
    const activeRemainingMs = estimateActiveRemainingMs(activeJob, now)
    const activeElapsedMs = activeJob ? getJobElapsedMs(activeJob, now) : 0
    const activeTotalMs = activeRemainingMs != null ? activeElapsedMs + activeRemainingMs : null
    const completedJobs = done.filter((job) => Number(job.elapsedMs) > 0)

    let queuedEstimateMs = 0
    let unknownQueued = 0
    for (const job of queued) {
      const estimate = estimateQueuedDurationMs(job, completedJobs, activeTotalMs)
      if (estimate == null) {
        unknownQueued += 1
      } else {
        queuedEstimateMs += estimate
      }
    }

    const knownRemainingMs = (activeRemainingMs || 0) + queuedEstimateMs
    const progressJobs = nonTerminal.length > 0 ? nonTerminal : jobs
    const aggregateProgress = progressJobs.length > 0
      ? Math.round(progressJobs.reduce((sum, job) => sum + Math.max(0, Math.min(100, Number(job.progress) || 0)), 0) / progressJobs.length)
      : 0

    return {
      queued,
      active,
      paused,
      failed,
      done,
      nonTerminal,
      visible,
      activeJob,
      aggregateProgress,
      knownRemainingMs,
      unknownQueued,
    }
  }, [activeJobId, jobs, now])

  const shouldShow = summary.nonTerminal.length > 0 || summary.failed.length > 0
  if (!shouldShow) return null

  const title = summary.failed.length > 0 && summary.nonTerminal.length === 0
    ? `${summary.failed.length} failed`
    : summary.active.length > 0
      ? `Generating ${summary.active.length}`
      : summary.paused.length > 0
        ? `Paused ${summary.paused.length}`
        : `Queued ${summary.queued.length}`
  const etaText = summary.knownRemainingMs > 0
    ? `~${formatDuration(summary.knownRemainingMs)}${summary.unknownQueued > 0 ? ` + ${summary.unknownQueued} queued` : ''}`
    : summary.queued.length > 0
      ? 'waiting'
      : summary.active.length > 0
        ? 'calculating'
        : ''
  const toneClass = summary.failed.length > 0
    ? 'border-red-500/40 bg-red-500/10 text-red-100'
    : summary.paused.length > 0 && summary.active.length === 0
      ? 'border-amber-400/40 bg-amber-400/10 text-amber-100'
      : 'border-sf-accent/40 bg-sf-accent/12 text-sf-text-primary'

  return (
    <div className="relative no-drag" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`mr-1 flex h-7 max-w-[230px] items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors hover:bg-sf-dark-700 ${toneClass}`}
        title={title}
      >
        {summary.active.length > 0 ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-sf-accent" />
        ) : summary.failed.length > 0 ? (
          <AlertTriangle className="h-3.5 w-3.5 text-red-300" />
        ) : (
          <Sparkles className="h-3.5 w-3.5 text-sf-accent" />
        )}
        <span className="truncate whitespace-nowrap">{title}</span>
        <ChevronDown className="h-3 w-3 flex-shrink-0 text-sf-text-muted" />
      </button>

      {open && (
        <div className="absolute right-0 top-[110%] z-50 w-[390px] overflow-hidden rounded-lg border border-sf-dark-700 bg-sf-dark-900 shadow-2xl">
          <div className="border-b border-sf-dark-700 px-3.5 py-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-sf-accent" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-sf-text-primary">{title}</div>
                <div className="mt-0.5 text-[11px] text-sf-text-muted">
                  {summary.active.length} active - {summary.queued.length} queued - {summary.done.length} done
                  {summary.failed.length > 0 ? ` - ${summary.failed.length} failed` : ''}
                </div>
              </div>
              <div className="font-mono text-[11px] text-sf-text-secondary">
                {summary.aggregateProgress}%
              </div>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sf-dark-700">
              <div
                className="h-full rounded-full bg-sf-accent transition-[width] duration-300"
                style={{ width: `${summary.aggregateProgress}%` }}
              />
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-sf-text-muted">
              <span>{isConnected ? 'ComfyUI connected' : 'ComfyUI offline'}</span>
              <span>{etaText ? `ETA ${etaText}` : 'ETA unavailable'}</span>
            </div>
          </div>

          <div className="max-h-[300px] overflow-y-auto py-1">
            {summary.visible.slice(0, 8).map((job) => {
              const jobEta = estimateActiveRemainingMs(job, now)
              return (
                <div key={job.id} className="border-b border-sf-dark-800/80 px-3.5 py-2 last:border-b-0">
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5 flex-shrink-0">
                      <JobStatusIcon job={job} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1 truncate text-xs font-medium text-sf-text-primary">
                          {job.workflowLabel || job.workflowId || 'Generation'}
                        </div>
                        <div className="font-mono text-[10px] text-sf-text-muted">
                          {Math.round(Number(job.progress) || 0)}%
                        </div>
                      </div>
                      <div className="mt-0.5 truncate text-[10px] text-sf-text-muted">
                        {getStatusLabel(job.status)}
                        {job.node != null ? ` - node ${job.node}` : ''}
                        {jobEta != null ? ` - ${formatDuration(jobEta)} left` : ''}
                      </div>
                      {job.error ? (
                        <div className="mt-1 truncate text-[10px] text-red-300">{job.error}</div>
                      ) : job.prompt ? (
                        <div className="mt-1 truncate text-[10px] text-sf-text-muted/80">{job.prompt}</div>
                      ) : null}
                      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-sf-dark-700">
                        <div
                          className={`h-full rounded-full transition-[width] duration-300 ${job.status === 'error' ? 'bg-red-400' : 'bg-sf-accent'}`}
                          style={{ width: `${Math.max(2, Math.min(100, Number(job.progress) || 0))}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-sf-dark-700 px-3.5 py-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onOpenGenerate?.()
              }}
              className="rounded-md bg-sf-accent px-2.5 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-sf-accent-hover"
            >
              Open Generate
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default GenerationMonitorChip
