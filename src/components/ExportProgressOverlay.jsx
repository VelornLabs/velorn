import { useEffect, useRef, useState } from 'react'
import { Film } from 'lucide-react'
import useExportActivityStore from '../stores/exportActivityStore'
import { cancelMcpExportBatchFromUi } from '../services/mcpExportParity'

export default function ExportProgressOverlay() {
  const activeJob = useExportActivityStore(state => state.activeJob)
  const local = useExportActivityStore(state => state.localActivity)
  const [cancelError, setCancelError] = useState('')
  const [stopping, setStopping] = useState(false)
  const buttonRef = useRef(null)
  const busy = Boolean(activeJob || local)
  const id = activeJob?.jobId || local?.id
  useEffect(() => {
    setCancelError(''); setStopping(false)
  }, [id])
  useEffect(() => {
    if (!busy) return
    const previousFocus = document.activeElement
    buttonRef.current?.focus()
    return () => { if (previousFocus?.isConnected) previousFocus.focus?.() }
  }, [busy])
  // Anything that moves on screen makes the graphics card wait for the
  // monitor 60 times a second, and the export's frames wait behind it: one
  // small spinner here roughly halved export speed. So nothing animates in
  // this window while an export runs; the bar, percent and time left still
  // update as the export moves.
  useEffect(() => {
    if (!busy) return
    document.documentElement.classList.add('velorn-export-busy')
    return () => document.documentElement.classList.remove('velorn-export-busy')
  }, [busy])
  if (!busy) return null
  const progress = activeJob?.progress || local?.progress || {}
  const percent = Number.isFinite(progress.progress) ? Math.max(0, Math.min(100, progress.progress)) : null
  const elapsed = activeJob?.startedAt ? Math.max(0, (Date.now() - Date.parse(activeJob.startedAt)) / 1000) : 0
  const estimatedSeconds = progress.frame > 0 && progress.totalFrames >= progress.frame && elapsed > 0
    ? (progress.totalFrames - progress.frame) * elapsed / progress.frame : null
  const seconds = Number.isFinite(progress.etaSeconds) ? progress.etaSeconds
    : Number.isFinite(local?.etaSeconds) ? local.etaSeconds : estimatedSeconds
  const roundedSeconds = Math.ceil(seconds)
  const eta = Number.isFinite(seconds) && seconds >= 0
    ? `${Math.floor(roundedSeconds / 60)}m ${roundedSeconds % 60}s remaining` : null
  const cancelling = !cancelError && (stopping || activeJob?.status === 'cancelling')
  const cancel = async () => {
    setStopping(true); setCancelError('')
    try {
      const result = local?.cancel
        ? await local.cancel()
        : await cancelMcpExportBatchFromUi(activeJob)
          ? { success: true } : await window.electronAPI?.cancelExport?.()
      if (result?.success === false) throw new Error(result.error || 'Could not stop export.')
    } catch (error) {
      setStopping(false)
      setCancelError(error?.message || 'Could not stop export. Please try again.')
    }
  }
  return (
    <div className="fixed inset-x-0 bottom-0 top-10 z-[10000] flex items-center justify-center bg-black/70 p-6"
      data-testid="export-priority-overlay">
      <section role="dialog" aria-modal="true" aria-labelledby="export-priority-title" aria-describedby="export-priority-description"
        className="w-full max-w-md rounded-xl border border-sf-dark-600 bg-sf-dark-900 p-6 shadow-2xl">
        <div className="mb-3 flex items-center gap-3">
          <Film aria-hidden="true" className="h-5 w-5 text-sf-accent" />
          <h2 id="export-priority-title" className="text-lg font-semibold text-sf-text-primary">{cancelling ? 'Stopping export…' : 'Exporting'}</h2>
        </div>
        <p id="export-priority-description" className="text-sm text-sf-text-secondary">Editing and playback are temporarily paused so Velorn can focus on your export. You can minimize this window.</p>
        <p className="mt-5 truncate text-xs text-sf-text-secondary" title={progress.status || local?.status}>{progress.status || local?.status || 'Preparing export…'}</p>
        <div role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={percent === null ? undefined : Math.round(percent)} className="my-3 h-2 overflow-hidden rounded-full bg-sf-dark-700">
          <div className={`h-full bg-sf-accent ${percent === null ? 'opacity-60' : ''}`} style={{ width: `${percent ?? 100}%` }} />
        </div>
        <div className="flex justify-between text-xs text-sf-text-muted"><span>{percent === null ? 'Preparing…' : `${Math.round(percent)}%`}</span><span>{eta}</span></div>
        {cancelError && <p role="alert" className="mt-3 text-sm text-sf-error">{cancelError}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {local?.pauseAfterCurrent && <button type="button" data-export-allowed="true"
            disabled={cancelling || local.pauseRequested} onClick={local.pauseAfterCurrent}
            className="rounded border border-sf-dark-500 px-3 py-2 text-sm text-sf-text-primary hover:bg-sf-dark-700 disabled:opacity-60">
            {local.pauseRequested ? 'Pausing after this export…' : 'Pause after current'}
          </button>}
          <button ref={buttonRef} type="button" data-export-allowed="true" data-testid="export-priority-cancel"
            aria-disabled={cancelling} onClick={() => { if (!cancelling) void cancel() }}
            className={`rounded border border-sf-dark-500 px-4 py-2 text-sm text-sf-text-primary hover:bg-sf-dark-700 ${cancelling ? 'opacity-60' : ''}`}>
            {cancelling ? 'Stopping…' : cancelError ? 'Retry cancel' : 'Cancel export'}
          </button>
        </div>
      </section>
    </div>
  )
}
