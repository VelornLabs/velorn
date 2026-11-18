import { useEffect, useState } from 'react'
import { CheckCircle2, ExternalLink, Loader2, Pencil, Trash2, X } from 'lucide-react'
import { useCustomWorkflowLibrary } from '../../hooks/useCustomWorkflowLibrary'
import { deleteCustomLibraryWorkflow, openCustomLibraryWorkflow, openCustomLibraryWorkflowWithMarkerStubs, readCustomLibraryWorkflowGraph, renameCustomLibraryWorkflow } from '../../services/customWorkflowLibrary'
import { scanUiWorkflowForCustomEndpoints } from '../../services/comfyui'

/**
 * Picker that promotes a graph saved in My Workflows into a Director custom
 * slot. Every saved graph is pre-scanned for the VELORN node titles the
 * slot requires; graphs missing required titles stay visible but disabled,
 * showing exactly which titles to add, with a shortcut to open them in the
 * ComfyUI tab. With dismissible=false it renders as always-on inline content
 * (no close button).
 */
// What a missing node is, in plain words, with its name for the builder.
const MISSING_WORDS = {
  VELORN_PROMPT: 'a text box for the description',
  VELORN_INPUT_IMAGE: 'a Load Image node for the starting picture',
  VELORN_OUTPUT_IMAGE: 'a node that saves the picture',
  VELORN_OUTPUT_VIDEO: 'a node that saves the video',
}
const missingInWords = (names = []) => names
  .map((name) => (MISSING_WORDS[name] ? `${MISSING_WORDS[name]} (${name})` : name))
  .join(', ')

// `currentName` is the workflow in use, so the list can mark it.
export default function CustomWorkflowLibraryPicker({ kind = 'keyframe', onPick, onClose, dismissible = true, currentName = '' }) {
  const { workflows } = useCustomWorkflowLibrary(true)
  const [scans, setScans] = useState(null)
  const [busyId, setBusyId] = useState('')
  const [openingId, setOpeningId] = useState('')
  const [error, setError] = useState('')
  const [showOthers, setShowOthers] = useState(false)

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
        // A workflow that saves a picture is a picture workflow, and one that
        // saves a video is a video workflow. Each belongs in its own list only.
        if (read.success && !next[entry.id].eligible) {
          const other = scanUiWorkflowForCustomEndpoints(read.uiWorkflow, kind === 'video' ? 'keyframe' : 'video')
          next[entry.id].otherKind = Boolean(kind === 'video' ? other.found?.outputImage : other.found?.outputVideo)
        }
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

  // Removing asks first. A project that already uses the workflow keeps its
  // own copy, so removing it from the list breaks nothing.
  const [removingId, setRemovingId] = useState('')
  const handleRemove = async (entry) => {
    if (removingId) return
    if (!window.confirm(`Remove "${entry.title}" from your saved workflows?\n\nA project that already uses it keeps its own copy.`)) return
    setRemovingId(entry.id)
    setError('')
    try {
      const result = await deleteCustomLibraryWorkflow(entry.id)
      if (result === false) setError('Could not remove that workflow.')
    } catch (err) {
      setError(err?.message || 'Could not remove that workflow.')
    } finally {
      setRemovingId('')
    }
  }
  // Opening shows the workflow in the ComfyUI tab as it was saved. Saving it
  // there again always makes a new entry, so this is also how to copy one.
  const [viewingId, setViewingId] = useState('')
  const handleView = async (entry) => {
    if (viewingId) return
    setViewingId(entry.id)
    setError('')
    try {
      const result = await openCustomLibraryWorkflow(entry.id)
      if (!result?.success) setError(result?.error || 'Could not open the workflow in ComfyUI.')
    } finally {
      setViewingId('')
    }
  }
  const [renaming, setRenaming] = useState(null) // { id, value }
  const saveRename = async () => {
    const current = renaming
    setRenaming(null)
    const title = String(current?.value || '').trim()
    const entry = workflows.find((item) => item.id === current?.id)
    if (!entry || !title || title === entry.title) return
    setError('')
    try {
      const result = await renameCustomLibraryWorkflow(entry.id, title)
      if (result === false || result?.success === false) setError(result?.error || 'Could not rename that workflow.')
    } catch (err) {
      setError(err?.message || 'Could not rename that workflow.')
    }
  }
  const iconButton = 'shrink-0 rounded p-1.5 text-sf-text-muted transition-colors hover:bg-sf-dark-700 hover:text-sf-text-primary disabled:cursor-wait disabled:opacity-50'
  const rowTools = (entry, { withOpen = true } = {}) => (
    <>
      {withOpen && (
        <button
          type="button"
          onClick={() => handleView(entry)}
          disabled={Boolean(viewingId)}
          aria-label={`Open ${entry.title} in ComfyUI`}
          title="Open in ComfyUI. To make a copy, change it there and press Save workflow with a new name."
          className={iconButton}
        >
          {viewingId === entry.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
        </button>
      )}
      <button
        type="button"
        onClick={() => setRenaming({ id: entry.id, value: entry.title })}
        aria-label={`Rename ${entry.title}`}
        title="Rename"
        className={iconButton}
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      {removeButton(entry)}
    </>
  )
  const renameBox = (entry) => (
    <div key={entry.id} className="flex items-center gap-1.5 rounded border border-sf-accent/60 bg-sf-dark-800 px-2.5 py-1.5">
      <input
        autoFocus
        aria-label={`New name for ${entry.title}`}
        value={renaming?.value || ''}
        maxLength={80}
        onChange={(event) => setRenaming({ id: entry.id, value: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); void saveRename() }
          if (event.key === 'Escape') { event.preventDefault(); setRenaming(null) }
        }}
        className="min-w-0 flex-1 rounded border border-sf-dark-600 bg-sf-dark-950 px-2 py-1 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
      />
      <button type="button" onClick={() => void saveRename()} className="rounded bg-sf-accent px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-sf-accent-hover">Save</button>
      <button type="button" onClick={() => setRenaming(null)} className="rounded px-2 py-1 text-xs text-sf-text-muted transition-colors hover:text-sf-text-primary">Cancel</button>
    </div>
  )
  const removeButton = (entry) => (
    <button
      type="button"
      onClick={() => handleRemove(entry)}
      disabled={Boolean(removingId)}
      aria-label={`Remove ${entry.title} from your saved workflows`}
      title="Remove from your saved workflows"
      className="shrink-0 rounded p-1.5 text-sf-text-muted transition-colors hover:bg-sf-dark-700 hover:text-red-300 disabled:cursor-wait disabled:opacity-50"
    >
      {removingId === entry.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
    </button>
  )

  const scanning = scans === null && workflows.length > 0
  // The ones that can be used come first. The rest (a video workflow in the
  // picture list, a half-built one) wait behind a link, out of the way.
  const ready = workflows.filter((entry) => scans?.[entry.id]?.eligible)
  const others = workflows.filter((entry) => !scans?.[entry.id]?.eligible && !scans?.[entry.id]?.otherKind)
  const othersOpen = showOthers || ready.length === 0
  const made = kind === 'video' ? 'videos' : 'pictures'

  return (
    <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-sf-text-primary">
          Your saved workflows
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
      <p className="mt-1 text-xs leading-5 text-sf-text-muted">
        The {kind === 'video' ? 'video' : 'picture'} workflows you saved in the ComfyUI tab with Save workflow.
      </p>
      {workflows.length === 0 ? (
        <p className="mt-2 text-xs leading-5 text-sf-text-muted">
          Nothing saved yet. Build one in the ComfyUI tab, press Save workflow, and it shows up here.
        </p>
      ) : scanning ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-sf-text-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          Checking your saved workflows…
        </div>
      ) : (
        <div className="mt-2 grid gap-1.5">
          {ready.length === 0 && (
            <p className="text-xs leading-5 text-amber-200">
              {others.length === 0
                ? `You have no workflow for ${made} yet. Build one in the ComfyUI tab and press Save workflow.`
                : `None of them is set up for ${made} yet.`}
            </p>
          )}
          {[...ready, ...(othersOpen ? others : [])].map((entry) => {
            const scan = scans?.[entry.id] || { eligible: false, missing: [] }
            const busy = busyId === entry.id
            const inUse = Boolean(currentName) && entry.title === currentName
            if (renaming?.id === entry.id) return renameBox(entry)
            if (scan.eligible) {
              return (
                <div key={entry.id} className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handlePick(entry.id)}
                  disabled={Boolean(busyId)}
                  className={`flex min-w-0 flex-1 items-center justify-between gap-3 rounded border px-2.5 py-2 text-left transition-colors hover:bg-sf-dark-700 disabled:cursor-wait ${inUse ? 'border-sf-accent/70 bg-sf-accent/10' : 'border-sf-dark-600 bg-sf-dark-800 hover:border-sf-accent/50'}`}
                  title={inUse ? 'This is the workflow in use.' : 'Use this workflow.'}
                >
                  <span className="min-w-0 truncate text-xs text-sf-text-primary">{entry.title}</span>
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-sf-accent" />
                  ) : inUse ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-sf-accent/60 bg-sf-accent/20 px-2 py-0.5 text-xs font-semibold text-sf-text-primary">
                      <CheckCircle2 className="h-3 w-3" />
                      In use
                    </span>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" />
                      Ready
                    </span>
                  )}
                </button>
                {rowTools(entry)}
                </div>
              )
            }
            return (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-3 rounded border border-sf-dark-700 bg-sf-dark-900/60 px-2.5 py-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs text-sf-text-secondary">{entry.title}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-amber-200/90">
                    {scan.readError || `Still needs ${missingInWords(scan.missing)}.`}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-200">
                    Needs setting up
                  </span>
                  <button
                    type="button"
                    onClick={() => handleOpenEntry(entry.id)}
                    disabled={Boolean(openingId)}
                    className="inline-flex items-center gap-1 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1 text-xs font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-wait disabled:opacity-50"
                    title="Open this graph in ComfyUI with the missing tagged nodes added beside it — wire them into your graph, then save to My Workflows again."
                  >
                    {openingId === entry.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />}
                    Open + add nodes
                  </button>
                  {rowTools(entry, { withOpen: false })}
                </span>
              </div>
            )
          })}
          {ready.length > 0 && others.length > 0 && (
            <button
              type="button"
              onClick={() => setShowOthers((current) => !current)}
              className="justify-self-start text-xs text-sf-text-muted underline-offset-2 transition-colors hover:text-sf-text-primary hover:underline"
            >
              {showOthers
                ? 'Hide the ones that need setting up'
                : `${others.length} ${others.length === 1 ? 'other needs' : 'others need'} setting up for ${made}`}
            </button>
          )}
        </div>
      )}
      {error && <div className="mt-2 text-xs text-red-300">{error}</div>}
    </div>
  )
}
