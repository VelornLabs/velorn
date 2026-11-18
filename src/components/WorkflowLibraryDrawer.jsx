import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, FolderPlus, Library, Loader2, MessageSquare, Pencil, RefreshCw, Search, Star, Trash2, X } from 'lucide-react'
import { trapDialogFocus } from '../utils/dialogFocus.mjs'
import { deleteSavedWorkflow, isSharedInGpuSharing, listSavedWorkflows, openSavedWorkflow, searchSavedWorkflows, updateSavedWorkflowMetadata, WORKFLOW_LIBRARY_EVENTS } from '../services/workflowLibrary'
import { createWorkflowFolder, loadWorkflowOrganization, removeWorkflowFolder, renameWorkflowFolder, sortWorkflowLibrary, updateWorkflowEntry, updateWorkflowOrganization } from '../services/workflowLibraryOrganization.mjs'
import './WorkflowLibraryDrawer.css'

const emptyOrganization = () => ({ version: 1, folders: [], entries: {}, sort: 'recent' })
const typeLabels = { image: 'Image', video: 'Video', audio: 'Audio', utility: 'Utility' }

export default function WorkflowLibraryDrawer({ open = false, onClose, onUseWithAgent, disabled = false }) {
  const [workflows, setWorkflows] = useState([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [organizationError, setOrganizationError] = useState('')
  const [notice, setNotice] = useState('')
  const [warnings, setWarnings] = useState([])
  const [organization, setOrganization] = useState(emptyOrganization)
  const [organizationReady, setOrganizationReady] = useState(false)
  const [filter, setFilter] = useState('all')
  const [folderForm, setFolderForm] = useState(null)
  const [folderName, setFolderName] = useState('')
  const [editing, setEditing] = useState(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [confirming, setConfirming] = useState(null)
  const [deleting, setDeleting] = useState(null) // { id, shared }: the workflow whose "delete?" question is showing
  const dialogRef = useRef(null)
  const searchRef = useRef(null)
  const folderFilterRef = useRef(null)
  const refreshVersion = useRef(0)
  const organizationVersion = useRef(0)
  const focusFolderAfterSave = useRef(false)
  const actionInFlight = useRef(false)
  const preserveNewFocus = useRef(false)
  const callbacks = useRef({ onClose, busy })
  callbacks.current = { onClose, busy }

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current
    const organizationAtStart = organizationVersion.current
    setLoading(true)
    setOrganizationReady(false)
    const [libraryResult, organizationResult] = await Promise.allSettled([listSavedWorkflows(), loadWorkflowOrganization()])
    if (version !== refreshVersion.current) return
    setLoading(false)
    const result = libraryResult.status === 'fulfilled' ? libraryResult.value : { error: 'Could not load My Workflows.' }
    if (result.success) setWorkflows(result.workflows || [])
    setWarnings(result.warnings || [])
    setError(result.success ? '' : result.error)
    if (organizationAtStart !== organizationVersion.current) return
    if (organizationResult.status === 'fulfilled') {
      const saved = organizationResult.value
      setOrganization(saved)
      setOrganizationReady(true)
      setOrganizationError('')
      setFilter(current => ['all', 'favorites', 'unfiled'].includes(current) || saved.folders.some(folder => folder.id === current) ? current : 'all')
    } else {
      setOrganizationError(organizationResult.reason?.message || 'Could not load your folders and favorites. Refresh to try again.')
    }
  }, [])

  useEffect(() => {
    if (!open) return undefined
    setNotice('')
    setError('')
    setConfirming(null)
    setEditing(null)
    setFolderForm(null)
    focusFolderAfterSave.current = false
    preserveNewFocus.current = false
    void refresh()
    const previousFocus = document.activeElement
    const dialog = dialogRef.current
    searchRef.current?.focus()
    const handleKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!callbacks.current.busy) callbacks.current.onClose?.()
      } else {
        trapDialogFocus(event, dialog)
      }
    }
    document.addEventListener('keydown', handleKey, true)
    for (const name of WORKFLOW_LIBRARY_EVENTS) window.addEventListener(name, refresh)
    return () => {
      refreshVersion.current += 1
      document.removeEventListener('keydown', handleKey, true)
      for (const name of WORKFLOW_LIBRARY_EVENTS) window.removeEventListener(name, refresh)
      if (!preserveNewFocus.current && (dialog?.contains(document.activeElement) || document.activeElement === document.body)) previousFocus?.focus?.()
    }
  }, [open, refresh])

  useLayoutEffect(() => {
    if (open && !busy && focusFolderAfterSave.current) {
      focusFolderAfterSave.current = false
      folderFilterRef.current?.focus()
    }
  }, [open, busy, folderForm, organization, filter])

  const matches = useMemo(() => sortWorkflowLibrary(searchSavedWorkflows(workflows, query).filter(entry => {
    const preferences = organization.entries[entry.id]
    if (filter === 'all') return true
    if (filter === 'favorites') return preferences?.favorite === true
    if (filter === 'unfiled') return !preferences?.folderId
    return preferences?.folderId === filter
  }), organization), [workflows, query, organization, filter])
  const selectedFolder = organization.folders.find(folder => folder.id === filter)
  if (!open) return null

  const runAction = async (key, action, success, isOrganization = false) => {
    if (actionInFlight.current || busy || (!isOrganization && disabled)) return
    actionInFlight.current = true
    setBusy(key)
    setError('')
    setNotice('')
    try {
      const result = await action()
      if (!result?.success) setError(result?.error || 'The workflow action could not be completed.')
      else await success?.(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The workflow action could not be completed.')
    } finally {
      actionInFlight.current = false
      setBusy('')
    }
  }

  const saveOrganization = (key, mutate, afterSave) => {
    if (!organizationReady || loading) return
    return runAction(key, async () => {
      const saved = await updateWorkflowOrganization(mutate)
      // A stale organization read must not replace a successful save, but its
      // concurrent catalog read may still contain newly imported workflows.
      organizationVersion.current += 1
      setOrganizationReady(true)
      setOrganization(saved)
      setOrganizationError('')
      return { success: true, organization: saved }
    }, afterSave, true)
  }
  const actionsDisabled = disabled || Boolean(busy)
  const organizationDisabled = !organizationReady || loading || Boolean(busy)
  const closeAfterHandoff = () => {
    preserveNewFocus.current = true
    onClose?.()
  }
  const closeFolderForm = () => { focusFolderAfterSave.current = true; setFolderForm(null) }
  const filtered = Boolean(query.trim()) || filter !== 'all'

  return (
    <div className="workflow-library-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget && !busy) onClose?.()
    }}>
      <section ref={dialogRef} className="workflow-library-drawer" role="dialog" aria-modal="true" aria-labelledby="workflow-library-title" aria-describedby="workflow-library-intro" tabIndex={-1}>
        <header className="wl-header">
          <Library size={20} aria-hidden="true" />
          <div><h2 id="workflow-library-title">My Workflows</h2><p id="workflow-library-intro">Your saved recipes, all in one place.</p></div>
          <button type="button" onClick={onClose} disabled={Boolean(busy)} aria-label="Close My Workflows"><X size={18} /></button>
        </header>
        <div className="wl-search-row">
          <label className="wl-search"><Search size={16} aria-hidden="true" /><span className="wl-sr-only">Search saved workflows</span><input ref={searchRef} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search names or descriptions…" /></label>
          <button type="button" onClick={refresh} disabled={loading || Boolean(busy)} aria-label="Refresh My Workflows"><RefreshCw size={16} className={loading ? 'wl-spinning' : ''} /></button>
        </div>
        <div className="wl-toolbar">
          <label className="wl-folder-filter"><span className="wl-sr-only">Workflow folder</span><select ref={folderFilterRef} value={filter} onChange={event => { setFilter(event.target.value); setFolderForm(null) }} disabled={Boolean(busy)}>
            <option value="all">All workflows</option><option value="favorites">Favorites</option><option value="unfiled">Unfiled</option>
            {organization.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
          </select></label>
          <label className="wl-sort"><span className="wl-sr-only">Sort workflows</span><select value={organization.sort} disabled={organizationDisabled} onChange={event => { const sort = event.target.value; void saveOrganization('sort', current => ({ ...current, sort })) }}><option value="recent">Recently updated</option><option value="name">Name A–Z</option></select></label>
          <button type="button" disabled={organizationDisabled} onClick={() => { setFolderForm('new'); setFolderName('') }}><FolderPlus size={14} />New folder</button>
        </div>
        {selectedFolder && !folderForm && <div className="wl-folder-actions"><span>{selectedFolder.name}</span><button type="button" disabled={organizationDisabled} onClick={() => { setFolderForm(selectedFolder.id); setFolderName(selectedFolder.name) }}>Rename folder</button><button type="button" title="Remove this folder; its workflows stay in the library." disabled={organizationDisabled} onClick={() => void saveOrganization('remove-folder', current => removeWorkflowFolder(current, selectedFolder.id), () => { setFilter('all'); setNotice('Folder removed. Its workflows are still in your library.'); focusFolderAfterSave.current = true })}>Remove folder</button></div>}
        {folderForm && <form className="wl-folder-form" onSubmit={event => {
          event.preventDefault()
          void saveOrganization('folder', current => folderForm === 'new' ? createWorkflowFolder(current, folderName) : renameWorkflowFolder(current, folderForm, folderName), () => { setNotice(folderForm === 'new' ? 'Folder created. Assign workflows from their Details.' : 'Folder renamed.'); closeFolderForm() })
        }}><label>Folder name<input autoFocus maxLength={80} value={folderName} onChange={event => setFolderName(event.target.value)} disabled={organizationDisabled} /></label><div className="wl-card-actions"><button type="submit" className="wl-primary" disabled={organizationDisabled || !folderName.trim()}>{folderForm === 'new' ? 'Create folder' : 'Save folder'}</button><button type="button" onClick={closeFolderForm} disabled={Boolean(busy)}>Cancel</button></div></form>}
        {disabled && <p className="wl-banner">Workflow actions are paused during export. You can still browse your library.</p>}
        {error && <p className="wl-error" role="alert">{error}</p>}
        {organizationError && <p className="wl-error" role="alert">{organizationError}</p>}
        {notice && <p className="wl-notice" role="status">{notice}</p>}
        {warnings.map((warning, index) => <p className="wl-banner" key={index + ':' + warning}>{warning}</p>)}
        <div className="wl-results" aria-busy={loading}>
          {loading && workflows.length === 0 ? <p className="wl-empty" role="status"><Loader2 size={18} className="wl-spinning" /> Loading saved workflows…</p> : <>
            <div className="wl-count-row"><p className="wl-count" role="status">{matches.length} {matches.length === 1 ? 'workflow' : 'workflows'}{filtered ? ' found' : ' saved'}</p><span>Favorites first</span></div>
            {!matches.length && !error && <div className="wl-empty"><Library size={28} /><h3>{query.trim() ? 'No matching workflows' : filter === 'favorites' ? 'No favorites yet' : filter !== 'all' ? 'This folder is empty' : 'Keep your next workflow here'}</h3><p>{query.trim() ? 'Try another name or a word from the description.' : filter === 'favorites' ? 'Star a workflow to keep it at the top of your library.' : filter !== 'all' ? 'Choose All workflows, then assign a folder in a workflow’s Details.' : 'Use “Save workflow” in ComfyUI, or ask the agent to remember a workflow by name.'}</p></div>}
            {matches.map(entry => {
              const preferences = organization.entries[entry.id] || {}
              const folder = organization.folders.find(item => item.id === preferences.folderId)
              return <article className="wl-card" key={entry.id} aria-label={entry.title}>
                <div className="wl-card-heading">
                  <button type="button" className={'wl-favorite' + (preferences.favorite ? ' is-favorite' : '')} aria-label={(preferences.favorite ? 'Remove ' : 'Add ') + entry.title + (preferences.favorite ? ' from favorites' : ' to favorites')} aria-pressed={preferences.favorite === true} disabled={organizationDisabled} onClick={() => void saveOrganization('favorite:' + entry.id, current => updateWorkflowEntry(current, entry.id, { favorite: !current.entries[entry.id]?.favorite }), () => { if (filter === 'favorites') focusFolderAfterSave.current = true })}><Star size={17} fill={preferences.favorite ? 'currentColor' : 'none'} /></button>
                  <div className="wl-card-title"><h3>{entry.title}</h3>{folder && <p className="wl-folder-name">{folder.name}</p>}</div>
                  <span className="wl-type">{typeLabels[entry.outputType] || 'Workflow'}</span>
                  {entry.format === 'ui' && <span className="wl-source">UI only</span>}
                </div>
                <div className="wl-card-actions">
                  <button type="button" className="wl-primary" title="Add this workflow reference to the agent draft. Nothing is sent or run." disabled={actionsDisabled || !onUseWithAgent} onClick={() => void runAction('agent:' + entry.id, () => onUseWithAgent(entry), closeAfterHandoff)}><MessageSquare size={14} />Use with agent</button>
                  <button type="button" disabled={actionsDisabled} onClick={() => { setConfirming(entry.id); setEditing(null) }}><ArrowUpRight size={14} />Open in ComfyUI</button>
                </div>
                <details className="wl-details"><summary tabIndex={0}>Details</summary><div className="wl-details-body">
                  <div className="wl-detail-meta"><span>{entry.source === 'my-workflows' ? 'ComfyUI capture' : 'API recipe'}</span>{entry.nodeCount > 0 && <span>{entry.nodeCount} {entry.nodeCount === 1 ? 'node' : 'nodes'}</span>}</div>
                  {entry.description && <p className="wl-description">{entry.description}</p>}
                  <p className="wl-inputs">{entry.inputSummary || 'Review inputs and dependencies before running.'}</p>
                  <p className="wl-readiness">{entry.readinessMessage || (entry.format === 'ui' ? 'UI graph saved. API preparation may be needed before an agent can run it.' : 'API graph saved. This does not verify installed models, nodes, or media.')}</p>
                  <label className="wl-assign-folder">Folder<select aria-label={'Folder for ' + entry.title} value={preferences.folderId || ''} disabled={organizationDisabled} onChange={event => { const folderId = event.target.value || null; void saveOrganization('assign:' + entry.id, current => updateWorkflowEntry(current, entry.id, { folderId }), () => { if (filter !== 'all' && filter !== 'favorites') focusFolderAfterSave.current = true }) }}><option value="">Unfiled</option>{organization.folders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                  {editing === entry.id ? <form className="wl-edit" onSubmit={event => {
                    event.preventDefault()
                    void runAction('edit:' + entry.id, () => updateSavedWorkflowMetadata(entry, { title, description }), async () => {
                      setEditing(null)
                      setNotice('Name and description saved. Workflow identity and graph are unchanged.')
                      await refresh()
                    })
                  }}>
                    <label>Name<input aria-label="Workflow name" autoFocus maxLength={240} value={title} onChange={event => setTitle(event.target.value)} disabled={actionsDisabled} /></label>
                    <label>Description<textarea aria-label="Workflow description" maxLength={2000} rows={3} value={description} onChange={event => setDescription(event.target.value)} disabled={actionsDisabled} /></label>
                    <div className="wl-card-actions"><button type="submit" className="wl-primary" disabled={actionsDisabled || !title.trim()}>Save details</button><button type="button" onClick={() => setEditing(null)} disabled={Boolean(busy)}>Cancel</button></div>
                  </form> : entry.source === 'my-workflows' && <div className="wl-card-actions">
                    <button type="button" className="wl-edit-button" aria-label={'Edit details for ' + entry.title} disabled={actionsDisabled} onClick={() => { setEditing(entry.id); setTitle(entry.title); setDescription(entry.description); setConfirming(null); setDeleting(null) }}><Pencil size={13} />Edit name and description</button>
                    <button type="button" className="wl-edit-button" aria-label={'Delete ' + entry.title} disabled={actionsDisabled} onClick={async () => { setConfirming(null); setEditing(null); setDeleting({ id: entry.id, shared: await isSharedInGpuSharing(entry.id) }) }}><Trash2 size={13} />Delete</button>
                  </div>}
                </div></details>
                {deleting?.id === entry.id && <div className="wl-confirm" role="group" aria-label={'Confirm deleting ' + entry.title}>
                  <p>Delete “{entry.title}” from My Workflows? This cannot be undone.{deleting.shared ? ' It is one of the workflows you share in GPU sharing: it will stop being shared.' : ''}</p>
                  <div className="wl-card-actions"><button type="button" disabled={actionsDisabled} onClick={() => void runAction('delete:' + entry.id, () => deleteSavedWorkflow(entry), async () => { setDeleting(null); setNotice(`Deleted “${entry.title}”.`); await refresh() })}>Delete it</button><button type="button" disabled={Boolean(busy)} onClick={() => setDeleting(null)}>Cancel</button></div>
                </div>}
                {confirming === entry.id && <div className="wl-confirm" role="group" aria-label={'Confirm opening ' + entry.title}>
                  <p>Replace the current ComfyUI graph with “{entry.title}”? Save any unsaved graph first. This does not run the workflow.</p>
                  <div className="wl-card-actions"><button type="button" disabled={actionsDisabled} onClick={() => void runAction('open:' + entry.id, () => openSavedWorkflow(entry, { confirmed: true }), closeAfterHandoff)}>Replace graph and open</button><button type="button" disabled={Boolean(busy)} onClick={() => setConfirming(null)}>Cancel</button></div>
                </div>}
                {busy.endsWith(':' + entry.id) && <p className="wl-working" role="status"><Loader2 size={14} className="wl-spinning" />Working…</p>}
              </article>
            })}
          </>}
        </div>
        <footer className="wl-footer">“Use with agent” adds to your draft. Nothing runs until you ask.</footer>
      </section>
    </div>
  )
}
