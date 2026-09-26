import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Info, Loader2, X } from 'lucide-react'
import {
  createMediaPreparationStatusState,
  dismissMediaPreparationSummary,
  subscribeToMediaPreparationStatus,
  updateMediaPreparationStatus,
} from '../utils/mediaPreparationStatus.mjs'

export default function MediaPreparationStatus() {
  const [state, setState] = useState(createMediaPreparationStatusState)
  const { view, summaryId } = state

  useEffect(() => subscribeToMediaPreparationStatus(window.electronAPI, (snapshot) => {
    setState((previous) => updateMediaPreparationStatus(previous, snapshot))
  }), [])

  const isSummary = view?.mode === 'summary'
  const isWarning = view?.tone === 'warning'
  useEffect(() => {
    if (!isSummary) return undefined
    const timeout = setTimeout(() => {
      setState((previous) => dismissMediaPreparationSummary(previous, summaryId))
    }, isWarning ? 10000 : 5000)
    return () => clearTimeout(timeout)
  }, [isSummary, isWarning, summaryId])

  if (!view) return null
  const Icon = !isSummary ? Loader2 : isWarning ? AlertCircle : view.tone === 'success' ? CheckCircle2 : Info
  const percentage = view.progress == null ? null : Math.round(view.progress * 100)

  return (
    <section aria-label="Background media preparation" className="shrink-0 border-b border-sf-dark-700 bg-sf-dark-800/60 px-2 py-2 text-[10px]">
      <div className="flex min-w-0 items-start gap-1.5">
        <Icon
          aria-hidden="true"
          className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${!isSummary ? 'animate-spin motion-reduce:animate-none text-sf-accent' : isWarning ? 'text-sf-warning' : 'text-sf-text-secondary'}`}
        />
        <div className="min-w-0 flex-1">
          <div role="status" aria-live="polite" aria-atomic="true" className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
            <span className="font-medium text-sf-text-primary">{view.title}</span>
            {!isSummary && <span className="text-sf-text-muted">{view.counts}</span>}
            {!isSummary && <span className="sr-only">{view.label}</span>}
            {isSummary && <span className="w-full text-sf-text-secondary">{view.detail}</span>}
          </div>
          {!isSummary && (
            <>
              <div className="mt-0.5 flex min-w-0 items-baseline gap-2 text-sf-text-secondary">
                <span className="min-w-0 flex-1 truncate" title={view.label}>{view.label}</span>
                {view.processor && <span tabIndex={0} title={view.processorDescription} aria-label={`${view.processor}. ${view.processorDescription}`} className="shrink-0 rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-sf-accent">{view.processor}</span>}
                {percentage !== null && <span className="shrink-0 tabular-nums">{percentage}%</span>}
              </div>
              <div
                role="progressbar"
                aria-label={`${view.title}: ${view.label}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percentage === null ? undefined : percentage}
                aria-valuetext={percentage === null ? (view.processor || 'Queued') : `${percentage}% of current file`}
                className={percentage === null ? 'sr-only' : 'mt-1.5 h-1 overflow-hidden rounded-full bg-sf-dark-600'}
              >
                {percentage !== null && <div className="h-full rounded-full bg-sf-accent" style={{ width: `${percentage}%` }} />}
              </div>
              {view.failureNote && <p role="status" className="mt-1 text-sf-warning">{view.failureNote}</p>}
            </>
          )}
        </div>
        {isSummary && (
          <button
            type="button"
            aria-label="Dismiss media preparation status"
            onClick={() => setState((previous) => dismissMediaPreparationSummary(previous, summaryId))}
            className="-mr-0.5 shrink-0 rounded p-0.5 text-sf-text-muted hover:bg-sf-dark-700 hover:text-sf-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sf-accent"
          >
            <X aria-hidden="true" className="h-3 w-3" />
          </button>
        )}
      </div>
    </section>
  )
}
