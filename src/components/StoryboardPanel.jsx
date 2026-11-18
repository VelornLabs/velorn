import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Film, Image, Maximize2, Minimize2, Plus, Redo2, Undo2, X } from 'lucide-react'
import useProjectStore from '../stores/projectStore'
import useAssetsStore from '../stores/assetsStore'
import useTimelineStore from '../stores/timelineStore'
import useExportActivityStore from '../stores/exportActivityStore'
import { applyStoryboardEdit } from '../services/storyboard'
import { normalizeStoryboard, isStoryboardSongAsset, STORYBOARD_LIMITS } from '../utils/storyboard.mjs'
import './StoryboardPanel.css'

const STATUS_NAMES = { planned: 'Planned', 'in-progress': 'In progress', review: 'Review', approved: 'Approved' }
const shotFields = shot => ({ title: shot.title, description: shot.description, durationSeconds: shot.durationSeconds, status: shot.status })
const boardFields = board => ({ title: board.title, brief: board.brief, songAssetId: board.songAssetId })
const durationLabel = value => `${Number(value.toFixed(2))}s`
const assetName = asset => asset?.name || asset?.filename || 'Untitled media'
const thumbnail = asset => asset?.poster?.url || (asset?.type === 'image' ? asset.url : null)
const handleKeys = new WeakMap()
// Unsaved forms survive shot/tab navigation, but never become authored data
// until Save. A bounded renderer-session cache, not another project model.
const formDrafts = new Map()
const draftListeners = new Set()
let draftRevision = 0
const changedDrafts = () => { draftRevision++; draftListeners.forEach(listener => listener()) }
export const subscribeStoryboardDrafts = listener => { draftListeners.add(listener); return () => draftListeners.delete(listener) }
export const getStoryboardDraftRevision = () => draftRevision
export const hasUnsavedStoryboardDrafts = keys => keys.some(key => {
  const entry = formDrafts.get(key)
  return entry && JSON.stringify(entry.draft) !== entry.base
})
const forgetDraft = key => { if (formDrafts.delete(key)) changedDrafts() }
function rememberDraft(key, value) {
  formDrafts.delete(key)
  formDrafts.set(key, value)
  while (formDrafts.size > 256) formDrafts.delete(formDrafts.keys().next().value)
  changedDrafts()
}
let nextHandleKey = 1
function projectKey(handle, fallback) {
  if (typeof handle === 'string') return handle
  if (handle && typeof handle === 'object') {
    if (!handleKeys.has(handle)) handleKeys.set(handle, `browser-project-${nextHandleKey++}`)
    return handleKeys.get(handle)
  }
  return fallback
}

// Keep typing local until Save, and never replace newer agent edits with an old form.
function useDraft(value, key) {
  const serialized = JSON.stringify(value)
  const [base, setBase] = useState(() => formDrafts.get(key)?.base ?? serialized)
  const [draft, setDraftState] = useState(() => formDrafts.get(key)?.draft ?? value)
  const dirty = JSON.stringify(draft) !== base
  const setDraft = next => { setDraftState(next); rememberDraft(key, { base, draft: next }) }
  useEffect(() => {
    if (!dirty && base !== serialized) {
      setBase(serialized)
      setDraftState(JSON.parse(serialized))
      forgetDraft(key)
    }
  }, [serialized, base, dirty, key])
  const reset = next => { setBase(JSON.stringify(next)); setDraftState(next); forgetDraft(key) }
  return { draft, setDraft, dirty, stale: dirty && base !== serialized, reset }
}

function Still({ asset, missing = false }) {
  const url = thumbnail(asset)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  return url && !failed
    ? <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
    : <div className="sb-thumbnail-empty"><Image size={25} /><span>{missing ? 'Missing media' : 'No preview yet'}</span></div>
}

function TakePreview({ asset }) {
  const [failed, setFailed] = useState(false)
  const mediaRef = useRef(null)
  const url = asset?.url
  useEffect(() => {
    setFailed(false)
    const media = mediaRef.current
    return () => { media?.pause?.(); media?.removeAttribute('src'); media?.load?.() }
  }, [url])
  if (!asset) return <div className="sb-preview-message">This media is no longer in the project. Attach another take or restore the asset.</div>
  if (!url || failed) return <div className="sb-preview-message">Preview unavailable. Check or reconnect this file in Assets.</div>
  return asset.type === 'video'
    ? <video ref={mediaRef} key={url} src={url} poster={thumbnail(asset) || undefined} controls preload="metadata" onError={() => setFailed(true)} />
    : <img src={url} alt={assetName(asset)} onError={() => setFailed(true)} />
}

function BoardDetails({ board, assets, disabled, edit, projectId }) {
  const { draft, setDraft, dirty, stale, reset } = useDraft(boardFields(board), `${projectId}:board`)
  const song = assets.find(asset => asset.id === draft.songAssetId)
  return <details className="sb-board-details">
    <summary>Board details <span>{board.brief ? 'Brief & music' : 'Optional brief & music'}</span></summary>
    <form onSubmit={event => {
      event.preventDefault()
      if (stale) return
      const result = edit({ operation: 'update_board', patch: draft })
      if (result) reset(boardFields(result.board))
    }}>
      <fieldset disabled={disabled}>
        <label>Board title<input aria-label="Board title" value={draft.title} maxLength={STORYBOARD_LIMITS.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
        <label>Brief<textarea aria-label="Brief" rows={3} value={draft.brief} maxLength={STORYBOARD_LIMITS.brief} placeholder="What's the story? Describe the mood, pacing, or message." onChange={event => setDraft({ ...draft, brief: event.target.value })} /></label>
        {!board.production && (board.concept || board.visualStyle || board.approach) && <div className="sb-direction-summary">
          {board.concept && <p><strong>Concept:</strong> {board.concept}</p>}
          {board.visualStyle && <p><strong>Visual style:</strong> {board.visualStyle}</p>}
          {board.approach && <p><strong>Approach:</strong> {board.approach}</p>}
        </div>}
        <label>Song<select aria-label="Song" value={draft.songAssetId || ''} onChange={event => setDraft({ ...draft, songAssetId: event.target.value || null })}>
          <option value="">No song — this doesn't need to be a music video</option>
          {draft.songAssetId && !song && <option value={draft.songAssetId}>Missing song</option>}
          {assets.filter(isStoryboardSongAsset).map(asset => <option key={asset.id} value={asset.id}>{assetName(asset)}</option>)}
        </select></label>
        {stale && <p className="sb-warning">Board details changed while you were typing. Reload them before saving.</p>}
        <div className="sb-inline-actions">
          <button type="submit" disabled={!dirty || stale} className="sb-primary">Save board details</button>
          {dirty && <button type="button" onClick={() => reset(boardFields(board))}>{stale ? 'Reload board details' : 'Discard changes'}</button>}
        </div>
      </fieldset>
    </form>
  </details>
}

function ShotDetails({ shot, index, board, assets, disabled, edit, projectId }) {
  const { draft, setDraft, dirty, stale, reset } = useDraft(shotFields(shot), `${projectId}:shot:${shot.id}`)
  const [referenceId, setReferenceId] = useState('')
  const [takeAssetId, setTakeAssetId] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const selectedTake = shot.takes.find(take => take.id === shot.selectedTakeId)
  const assetMap = useMemo(() => new Map(assets.map(asset => [asset.id, asset])), [assets])
  const references = assets.filter(asset => ['image', 'video', 'audio'].includes(asset.type) && !shot.referenceAssetIds.includes(asset.id))
  const takeAssets = assets.filter(asset => ['image', 'video'].includes(asset.type) && !shot.takes.some(take => take.assetId === asset.id))
  const move = direction => {
    const ids = board.shots.map(item => item.id)
    ;[ids[index], ids[index + direction]] = [ids[index + direction], ids[index]]
    edit({ operation: 'reorder_shots', shotIds: ids })
  }
  return <aside className="sb-shot-details" aria-label="Shot details">
    <div className="sb-detail-heading"><span title={shot.id}>SHOT {board.production ? shot.id.slice(-6).toUpperCase() : String(index + 1).padStart(2, '0')}</span><div className="sb-inline-actions">
      <button title="Move shot left" aria-label="Move shot left" disabled={disabled || index === 0} onClick={() => move(-1)}><ArrowLeft size={14} /></button>
      <button title="Move shot right" aria-label="Move shot right" disabled={disabled || index === board.shots.length - 1} onClick={() => move(1)}><ArrowRight size={14} /></button>
    </div></div>
    <form onSubmit={event => {
      event.preventDefault()
      if (stale) return
      const result = edit({ operation: 'update_shot', shotId: shot.id, patch: { ...draft, durationSeconds: Number(draft.durationSeconds) } })
      if (result) reset(shotFields(result.board.shots.find(item => item.id === shot.id)))
    }}>
      <fieldset disabled={disabled}>
        <label>Shot title<input aria-label="Shot title" value={draft.title} maxLength={STORYBOARD_LIMITS.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
        <label>Shot description<textarea aria-label="Shot description" rows={3} value={draft.description} maxLength={STORYBOARD_LIMITS.description} placeholder="What happens in this shot?" onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
        <div className="sb-form-row">
          <label>Duration <span>(seconds)</span><input aria-label="Duration" type="number" min="0.01" max={STORYBOARD_LIMITS.maxDurationSeconds} step="any" required value={draft.durationSeconds} onChange={event => setDraft({ ...draft, durationSeconds: event.target.value })} /></label>
          <label>Status<select aria-label="Status" value={draft.status} onChange={event => setDraft({ ...draft, status: event.target.value })}>{Object.entries(STATUS_NAMES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
        </div>
        {stale && <p className="sb-warning">This shot changed while you were typing. Reload it before saving.</p>}
        <div className="sb-inline-actions">
          <button type="submit" className="sb-primary" disabled={!dirty || stale}>Save shot</button>
          {dirty && <button type="button" onClick={() => reset(shotFields(shot))}>{stale ? 'Reload shot' : 'Discard changes'}</button>}
        </div>
      </fieldset>
    </form>
    <section className="sb-detail-section">
      <h3>References <span>{shot.referenceAssetIds.length}</span></h3>
      <p>Images, clips, or audio to guide this shot.</p>
      <ul className="sb-reference-list">{shot.referenceAssetIds.map(assetId => {
        const asset = assetMap.get(assetId)
        const name = asset ? assetName(asset) : `Missing media (${assetId})`
        return <li key={assetId}><span title={name}>{name}</span><button aria-label={`Remove reference ${name}`} title="Remove reference (keeps the asset)" disabled={disabled} onClick={() => edit({ operation: 'update_shot', shotId: shot.id, patch: { referenceAssetIds: shot.referenceAssetIds.filter(id => id !== assetId) } })}><X size={13} /></button></li>
      })}</ul>
      <div className="sb-attach-row"><select aria-label="Reference asset" disabled={disabled || !references.length} value={references.some(asset => asset.id === referenceId) ? referenceId : ''} onChange={event => setReferenceId(event.target.value)}>
        <option value="">{references.length ? 'Choose an asset…' : 'Import media in Assets first'}</option>
        {references.map(asset => <option key={asset.id} value={asset.id}>{assetName(asset)}</option>)}
      </select><button aria-label="Add reference" title="Add reference" disabled={disabled || !references.some(asset => asset.id === referenceId)} onClick={() => {
        if (edit({ operation: 'update_shot', shotId: shot.id, patch: { referenceAssetIds: [...shot.referenceAssetIds, referenceId] } })) setReferenceId('')
      }}><Plus size={15} /></button></div>
    </section>
    <section className="sb-detail-section">
      <h3>Takes <span>{shot.takes.length}</span></h3>
      <p>Attach results from any workflow. Choose the take you want to keep.</p>
      {selectedTake && <div className="sb-selected-preview"><TakePreview key={selectedTake.assetId} asset={assetMap.get(selectedTake.assetId)} /></div>}
      <ul className="sb-take-list">{shot.takes.map((take, takeIndex) => {
        const asset = assetMap.get(take.assetId)
        const name = asset ? assetName(asset) : `Missing media (${take.assetId})`
        const selected = take.id === shot.selectedTakeId
        return <li key={take.id} className={selected ? 'is-selected' : ''}>
          <button className="sb-take-select" aria-label={`Select take ${name}`} aria-pressed={selected} disabled={disabled} onClick={() => edit({ operation: 'select_take', shotId: shot.id, takeId: take.id })}>
            <span className="sb-take-check">{selected ? <Check size={14} /> : String(takeIndex + 1).padStart(2, '0')}</span><span><strong>{take.label || name}</strong>{take.label && <small>{name}</small>}</span>
          </button>
          <button aria-label={`Remove take ${name}`} title="Remove take (keeps the asset)" disabled={disabled} onClick={() => edit({ operation: 'remove_take', shotId: shot.id, takeId: take.id })}><X size={13} /></button>
        </li>
      })}</ul>
      {selectedTake && (selectedTake.prompt || selectedTake.workflowLabel) && <details className="sb-provenance"><summary>Take notes</summary>{selectedTake.workflowLabel && <p>Workflow: {selectedTake.workflowLabel}</p>}{selectedTake.prompt && <p>{selectedTake.prompt}</p>}</details>}
      <div className="sb-attach-row"><select aria-label="Take asset" disabled={disabled || !takeAssets.length} value={takeAssets.some(asset => asset.id === takeAssetId) ? takeAssetId : ''} onChange={event => setTakeAssetId(event.target.value)}>
        <option value="">{takeAssets.length ? 'Choose an image or video…' : 'Import a result in Assets first'}</option>
        {takeAssets.map(asset => <option key={asset.id} value={asset.id}>{assetName(asset)}</option>)}
      </select><button aria-label="Add take" title="Add take" disabled={disabled || !takeAssets.some(asset => asset.id === takeAssetId)} onClick={() => {
        if (edit({ operation: 'attach_take', shotId: shot.id, assetId: takeAssetId })) setTakeAssetId('')
      }}><Plus size={15} /></button></div>
    </section>
    <div className="sb-delete-area">{confirmRemove ? <>
      <p>Remove this shot from the board? Your media and timeline stay untouched.</p>
      <div className="sb-inline-actions"><button className="sb-danger" disabled={disabled} onClick={() => edit({ operation: 'remove_shot', shotId: shot.id })}>Confirm remove shot</button><button onClick={() => setConfirmRemove(false)}>Cancel</button></div>
    </> : <button disabled={disabled} onClick={() => setConfirmRemove(true)}>Delete shot</button>}</div>
  </aside>
}

function StoryboardView({ projectId, embedded }) {
  const rawBoard = useProjectStore(state => state.currentProject?.storyboard)
  const assets = useAssetsStore(state => state.assets)
  const compound = useTimelineStore(state => Boolean(state.compoundEditContext))
  const exportBusy = useExportActivityStore(state => Boolean(state.activeJob || state.localActivity))
  const projectHistory = useProjectStore(state => state.projectHistory)
  const projectFuture = useProjectStore(state => state.projectFuture)
  const historyIndex = useTimelineStore(state => state.historyIndex)
  const historyLength = useTimelineStore(state => state.history.length)
  const [selectedId, setSelectedId] = useState(null)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const panelRef = useRef(null)
  const expandRef = useRef(null)
  const { board, readError } = useMemo(() => {
    try { return { board: normalizeStoryboard(rawBoard), readError: '' } }
    catch (err) { return { board: null, readError: err.message } }
  }, [rawBoard])
  const assetMap = useMemo(() => new Map(assets.map(asset => [asset.id, asset])), [assets])
  const selectedShot = board?.shots.find(shot => shot.id === selectedId) || board?.shots[0]
  const disabled = !projectId || compound || exportBusy || Boolean(readError)
  const canUndo = projectHistory.length > 0 || (historyLength > 0 && (historyIndex === -1 || historyIndex > 0))
  const canRedo = projectFuture.length > 0 || (historyIndex >= 0 && historyIndex < historyLength - 1)
  const edit = payload => {
    try {
      if (disabled) throw new Error('The storyboard is read-only right now.')
      const result = applyStoryboardEdit(payload)
      setError('')
      if (result.changed) setNotice('Storyboard updated. Save your project to keep your changes.')
      return result
    } catch (err) { setError(err.message); return null }
  }
  const history = redo => {
    if (disabled) return
    const project = useProjectStore.getState(), timeline = useTimelineStore.getState()
    const projectCan = redo ? project.canRedoTimelineStructureChange() : project.canUndoTimelineStructureChange()
    const timelineCan = redo ? timeline.canRedo() : timeline.canUndo()
    if (projectCan && (!timelineCan || project.projectHistoryLastChangedAt > timeline.historyLastChangedAt)) {
      if (redo) project.redoTimelineStructureChange(); else project.undoTimelineStructureChange()
    } else if (redo) timeline.redo(); else timeline.undo()
    setNotice(redo ? 'Redone.' : 'Undone.')
    setError('')
  }
  const collapse = () => { setExpanded(false); expandRef.current?.focus() }
  const onKeyDown = event => {
    // Text fields retain native text Undo and Space; don't leak them to transports.
    const editable = event.target.closest('input, textarea, select, [contenteditable="true"]')
    if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); collapse(); return }
    if (editable) { event.stopPropagation(); return }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault(); event.stopPropagation(); history(event.key.toLowerCase() === 'y' || event.shiftKey)
    }
  }
  useEffect(() => {
    if (expanded) panelRef.current?.focus()
  }, [expanded])
  return <section ref={panelRef} tabIndex={-1} aria-label="Storyboard" className={`storyboard-panel ${expanded ? 'sb-expanded' : ''}`} onKeyDown={onKeyDown}>
    <header className="sb-toolbar">
      <div className="sb-title"><Film size={17} /><h2>{board?.title || 'Storyboard'}</h2><span className="sb-lab">LAB</span></div>
      <div className="sb-inline-actions">
        <button aria-label="Undo" title="Undo (Ctrl/Cmd+Z)" disabled={disabled || !canUndo} onClick={() => history(false)}><Undo2 size={15} /></button>
        <button aria-label="Redo" title="Redo (Ctrl/Cmd+Shift+Z)" disabled={disabled || !canRedo} onClick={() => history(true)}><Redo2 size={15} /></button>
        <button className="sb-primary" disabled={disabled} onClick={() => { const result = edit({ operation: 'add_shot', shot: {} }); if (result) setSelectedId(result.shotId) }}><Plus size={15} />Add shot</button>
        {!embedded && <button ref={expandRef} title={expanded ? 'Collapse board (Esc)' : 'Expand board'} aria-label={expanded ? 'Collapse board' : 'Expand board'} onClick={() => expanded ? collapse() : setExpanded(true)}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>}
      </div>
    </header>
    {(error || readError) && <div className="sb-error" role="alert">{error || readError}</div>}
    {(compound || exportBusy) && <div className="sb-warning">{compound ? 'Exit the compound clip to edit the storyboard.' : 'Export is running. The storyboard is read-only.'}</div>}
    {board && <div className="sb-workspace">
      <div className="sb-board-column">
        <BoardDetails board={board} assets={assets} disabled={disabled} edit={edit} projectId={projectId} />
        <div className="sb-board-summary"><span>{board.shots.length} {board.shots.length === 1 ? 'shot' : 'shots'} · {durationLabel(board.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0))} planned</span><span>Plan here. Edit on the timeline.</span></div>
        {!board.shots.length ? <div className="sb-empty"><Film size={36} /><h3>Start with the story.</h3><p>Add a shot, or ask your assistant to build the board.<br />Use any workflow. Bring the results here.</p></div>
          : <div className="sb-shot-grid">{board.shots.map((shot, index) => {
            const take = shot.takes.find(item => item.id === shot.selectedTakeId)
            const assetId = take?.assetId || shot.referenceAssetIds.find(id => ['image', 'video'].includes(assetMap.get(id)?.type))
            return <button key={shot.id} data-testid="storyboard-shot" data-shot-id={shot.id} className={`sb-shot-card ${selectedShot?.id === shot.id ? 'is-selected' : ''}`} aria-label={`Shot ${board.production ? shot.id.slice(-6).toUpperCase() : index + 1}: ${shot.title}`} aria-pressed={selectedShot?.id === shot.id} onClick={() => { setSelectedId(shot.id); setError('') }}>
              <div className="sb-shot-image"><Still asset={assetMap.get(assetId)} missing={Boolean(assetId && !assetMap.has(assetId))} /><span className="sb-shot-number" title={shot.id}>{board.production ? shot.id.slice(-6).toUpperCase() : String(index + 1).padStart(2, '0')}</span><span className="sb-shot-duration">{durationLabel(shot.durationSeconds)}</span></div>
              <div className="sb-shot-content"><strong>{shot.title || 'Untitled shot'}</strong><p>{shot.description || 'Describe this moment…'}</p><div className="sb-shot-footer"><span className={`sb-status sb-status-${shot.status}`}>{STATUS_NAMES[shot.status]}</span><span>{shot.takes.length} {shot.takes.length === 1 ? 'take' : 'takes'}</span></div></div>
            </button>
          })}</div>}
      </div>
      {selectedShot && <ShotDetails key={selectedShot.id} shot={selectedShot} index={board.shots.indexOf(selectedShot)} board={board} assets={assets} disabled={disabled} edit={edit} projectId={projectId} />}
    </div>}
    <footer className="sb-footer"><span>Shared with your assistant · No automatic generation or timeline changes</span><span className="sb-sr-only" role="status" aria-live="polite">{notice}</span></footer>
  </section>
}

export { useDraft as useStoryboardDraft, projectKey as getStoryboardProjectKey }

export default function StoryboardPanel({ embedded = false }) {
  const exists = useProjectStore(state => Boolean(state.currentProject))
  const handle = useProjectStore(state => state.currentProjectHandle)
  const name = useProjectStore(state => state.currentProject?.name)
  const created = useProjectStore(state => state.currentProject?.created)
  if (!exists) return <div className="storyboard-panel sb-empty">Open a project to use the storyboard.</div>
  const key = projectKey(handle, `${name}:${created}`)
  return <StoryboardView key={key} projectId={key} embedded={embedded} />
}
