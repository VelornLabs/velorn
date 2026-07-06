import { useEffect, useState } from 'react'
import { CheckCircle2, ExternalLink, Loader2, X } from 'lucide-react'
import { useCustomWorkflowLibrary } from '../../hooks/useCustomWorkflowLibrary'
import { openCustomLibraryWorkflowWithMarkerStubs, readCustomLibraryWorkflowGraph } from '../../services/customWorkflowLibrary'
import { scanUiWorkflowForCustomEndpoints } from '../../services/comfyui'

/**
 * Picker that promotes a graph saved in My Workflows into a Director custom
 * slot. Every saved graph is pre-scanned for the VELORN node titles the
 * slot requires; graphs missing required titles stay visible but disabled,
 * showing exactly which titles to add, with a shortcut to open them in the
 * ComfyUI tab. With dismissible=false it renders as always-on inline content
 * (no close button).
 */
export default function CustomWorkflowLibraryPicker({ kind = 'keyframe', onPick, onClose, dismissible = true }) {
  const { workflows } = useCustomWorkflowLibrary(true)
  const [scans, setScans] = useState(null)
  const [busyId, setBusyId] = useState('')
  const [openingId, setOpeningId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setScans(null)
    ;(async () => {
      const next = {}
      for (const entry of workflows) {
        const read = await readCustomLibraryWorkflowGraph(entry.id).catch((err) => ({
          success: false,
          error: err?.message || 'Could not read the saved workflow.',
        }))
        next[entry.id] = read.success
          ? scanUiWorkflowForCustomEndpoints(read.uiWorkflow, kind)
          : { eligible: false, missing: [], readError: read.error }
      }
      if (!cancelled) setScans(next)
    })()
    return () => { cancelled = true }
  }, [kind, workflows])

  const handlePick = async (entryId) => {
    if (busyId) return
    setBusyId(entryId)
    setError('')
    try {
      const result = await onPick?.(entryId)
      if (result?.success) {
        onClose?.()
        return
      }
      setError(result?.error || 'Could not load that workflow.')
    } finally {
      setBusyId('')
    }
  }

  const handleOpenEntry = async (entryId) => {
    if (openingId) return
    setOpeningId(entryId)
    setError('')
    try {
      const result = await openCustomLibraryWorkflowWithMarkerStubs(entryId, kind)
      if (!result?.success) setError(result?.error || 'Could not open the workflow in ComfyUI.')
    } finally {
      setOpeningId('')
    }
  }

  const scanning = scans === null && workflows.length > 0

  return (
    <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-sf-text-muted">
          Use a saved workflow
        </span>
        {dismissible && (
          <button
            type="button"
            onClick={onClose}
            className="rounded p-0.5 text-sf-text-muted transition-colors hover:text-sf-text-primary"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {workflows.length === 0 ? (
        <p className="mt-2 text-[10px] leading-4 text-sf-text-muted">
          Nothing saved yet. Build the graph in the ComfyUI tab, save it to My Workflows, and it will show up here.
        </p>
      ) : scanning ? (
        <div className="mt-2 flex items-center gap-2 text-[10px] text-sf-text-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          Checking saved workflows for the required node titles…
        </div>
      ) : (
        <div className="mt-2 grid gap-1.5">
          {workflows.map((entry) => {
            const scan = scans?.[entry.id] || { eligible: false, missing: [] }
            const busy = busyId === entry.id
            if (scan.eligible) {
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => handlePick(entry.id)}
                  disabled={Boolean(busyId)}
                  className="flex items-center justify-between gap-3 rounded border border-sf-dark-600 bg-sf-dark-800 px-2.5 py-2 text-left transition-colors hover:border-sf-accent/50 hover:bg-sf-dark-700 disabled:cursor-wait"
                  title="Load this workflow into the custom slot."
                >
                  <span className="min-w-0 truncate text-xs text-sf-text-primary">{entry.title}</span>
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-sf-accent" />
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" />
                      Ready
                    </span>
                  )}
                </button>
              )
            }
            return (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-3 rounded border border-sf-dark-700 bg-sf-dark-900/60 px-2.5 py-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs text-sf-text-secondary">{entry.title}</span>
                  <span className="mt-0.5 block truncate font-mono text-[9px] text-amber-200/90">
                    {scan.readError || `Missing: ${scan.missing.join(', ')}`}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200">
                    Needs titles
                  </span>
                  <button
                    type="button"
                    onClick={() => handleOpenEntry(entry.id)}
                    disabled={Boolean(openingId)}
                    className="inline-flex items-center gap-1 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1 text-[10px] font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-wait disabled:opacity-50"
                    title="Open this graph in ComfyUI with the missing tagged nodes added beside it — wire them into your graph, then save to My Workflows again."
                  >
                    {openingId === entry.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
                    Open + add nodes
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      )}
      {error && <div className="mt-2 text-[10px] text-red-300">{error}</div>}
    </div>
  )
}
