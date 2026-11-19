import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Clapperboard, Image as ImageIcon, Maximize2, Minimize2 } from 'lucide-react'
import { useI18n } from '../i18n/I18nContext'
import useProjectStore from '../stores/projectStore'
import useAssetsStore from '../stores/assetsStore'
import { normalizeStoryboard, getStoryboardPresentation } from '../utils/storyboard.mjs'
import './ProductionWorkspace.css'

// Read-only shared project data. Creative edits use the assistant's existing
// preview/Undo-aware tools; this view never imports an authoring service.
const nameOf = asset => asset?.name || 'Untitled reference'
const seconds = value => `${Number(value.toFixed(2))}s`
const projectHandles = new WeakMap()
let nextHandle = 0
function sessionKey(handle, fallback) {
  if (typeof handle === 'string') return handle
  if (handle && typeof handle === 'object') {
    if (!projectHandles.has(handle)) projectHandles.set(handle, ++nextHandle)
    return projectHandles.get(handle)
  }
  return fallback
}

function Still({ asset, label, expected = false, portrait = false }) {
  // Existing posters only: no playback, video decoders, thumbnail jobs or IO.
  const url = asset?.type === 'image' ? asset.url : asset?.type === 'video' ? asset.poster?.url : null
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  return <div className={`pr-still ${portrait ? 'pr-portrait' : ''}`}>
    {url && !failed
      ? <img src={url} alt={label} loading="lazy" draggable={false} onError={() => setFailed(true)} />
      : <div className="pr-still-empty"><ImageIcon size={24} aria-hidden="true" /><span>{!asset && expected ? 'Missing reference' : failed ? 'Preview unavailable' : asset?.type === 'video' ? 'Video reference' : asset?.type === 'audio' ? 'Audio reference' : asset ? 'Preview unavailable' : 'Image not created yet'}</span></div>}
  </div>
}

function ReferenceCard({ id, asset, label, portrait = false }) {
  return <figure className="pr-reference-card" data-asset-id={id}>
    <Still asset={asset} label={label} expected={Boolean(id)} portrait={portrait} />
    <figcaption title={asset ? nameOf(asset) : id}>{label}</figcaption>
  </figure>
}

function EntitySection({ title, entities, assetsById, cast = false }) {
  if (!entities.length) return null
  return <section className="pr-board-section" aria-label={title}>
    <div className="pr-section-heading"><h2>{title}</h2><span>{entities.length}</span></div>
    <div className="pr-entity-wall">{entities.map(entity => <article className={cast ? 'pr-character' : 'pr-location'} data-entity-id={cast ? entity.memberId : entity.locationId} key={cast ? entity.memberId : entity.locationId}>
      <header className="pr-entity-heading"><h3>{entity.displayLabel || entity.name || (cast ? 'Unnamed character' : 'Unnamed location')}</h3>{cast && entity.role && <span>{entity.role}</span>}</header>
      <div className={`pr-reference-grid ${cast ? 'pr-character-references' : ''}`}>
        {entity.references.length ? entity.references.map(reference => {
          const asset = assetsById.get(reference.assetId)
          return <ReferenceCard key={reference.assetId} id={reference.assetId} asset={asset} label={reference.displayLabel || reference.name} portrait={cast} />
        }) : <ReferenceCard label={`${entity.displayLabel || entity.name || title} · awaiting references`} portrait={cast} />}
      </div>
    </article>)}</div>
  </section>
}

function ShotCard({ shot, board, assetsById, highlighted = false }) {
  const asset = shot.stillAssetId ? assetsById.get(shot.stillAssetId) : null
  const direction = board.production?.shotDirections.find(item => item.shotId === shot.shotId)
  return <article className={`pr-shot-card${highlighted ? ' pr-agent-highlight' : ''}`} data-shot-id={shot.shotId} aria-label={`${shot.label} · ${shot.title}`}>
    <div className="pr-shot-image"><Still asset={asset?.type === 'image' ? asset : null} expected={Boolean(shot.stillAssetId)} label={`${shot.label} · ${shot.title}`} />
      <span className="pr-shot-label">{shot.label}</span>
      {shot.stillSource === 'reference' && <span className="pr-reference-badge">Reference only</span>}
    </div>
    <div className="pr-shot-caption"><div className="pr-shot-caption-top"><h3>{shot.title}</h3><span>{seconds(shot.durationSeconds)}</span></div>
      {shot.description && <p>{shot.description}</p>}
      {direction?.lipSync && <span className="pr-lip-sync">Lip sync</span>}
    </div>
  </article>
}

function BoardSession({ projectName, workspace, onBackToEditor, highlightShotIds = [] }) {
  const { t } = useI18n()
  const raw = useProjectStore(state => state.currentProject?.storyboard)
  const loading = useProjectStore(state => state.isLoading)
  const assets = useAssetsStore(state => state.assets)
  const [expanded, setExpanded] = useState(false)
  const panelRef = useRef(null), expandRef = useRef(null), scrollRef = useRef(null)
  const assetsById = useMemo(() => new Map(assets.map(asset => [asset.id, asset])), [assets])
  const { board, presentation, readError } = useMemo(() => {
    try { const board = normalizeStoryboard(raw); return { board, presentation: getStoryboardPresentation(board, assets), readError: '' } }
    catch (error) { return { board: null, presentation: null, readError: error.message } }
  }, [raw, assets])
  const cast = presentation?.cast || [], locations = presentation?.locations || []
  const references = presentation?.references || []
  const empty = board && !cast.length && !locations.length && !references.length && !board.shots.length
  const song = board?.songAssetId ? assetsById.get(board.songAssetId) : null
  const collapse = () => { setExpanded(false); expandRef.current?.focus() }
  useEffect(() => { if (expanded) panelRef.current?.focus() }, [expanded])
  useEffect(() => { if (workspace) panelRef.current?.focus() }, [workspace])
  return <section className={`production-workspace ${expanded ? 'pr-expanded' : ''}`} ref={panelRef} tabIndex={-1} role={expanded ? 'dialog' : undefined} aria-modal={expanded || undefined} aria-label="Production reference board" onKeyDown={event => {
    // Focused board navigation must not edit clips in a hidden timeline.
    event.stopPropagation()
    if (event.key === 'Escape' && workspace && onBackToEditor) { event.preventDefault(); onBackToEditor(); return }
    if (event.key === 'Escape' && expanded) { event.preventDefault(); collapse() }
    if (event.key === 'Tab' && expanded) {
      event.preventDefault()
      const targets = [expandRef.current, scrollRef.current].filter(Boolean)
      const index = targets.indexOf(document.activeElement)
      const next = index < 0 ? (event.shiftKey ? targets.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length
      targets[next]?.focus()
    }
  }}>
    <header className="pr-toolbar"><div className="pr-title"><Clapperboard size={17} aria-hidden="true" /><strong>{workspace ? t('topTabs.storyboard', undefined, 'Storyboard') : 'Reference board'}</strong></div>
      {workspace ? <button type="button" className="pr-back-editor" onClick={onBackToEditor} title="Back to editor (Esc)"><ArrowLeft size={14} aria-hidden="true" />{t('storyboard.backToEditor', undefined, 'Back to editor')}</button>
        : <button ref={expandRef} type="button" aria-label={expanded ? 'Collapse board' : 'Expand board'} title={expanded ? 'Collapse board (Esc)' : 'Expand board'} onClick={() => expanded ? collapse() : setExpanded(true)}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>}
    </header>
    <div className="pr-board-scroll" ref={scrollRef} role="region" tabIndex={0} aria-label="References and storyboard">
      {loading ? <p className="pr-board-notice" role="status">Opening the project…</p> : readError ? <div className="pr-board-notice" role="alert"><h2>This board needs a compatible version of Velorn.</h2><p>{readError}</p><p>Your saved board has not been changed.</p></div> : board && <>
        <div className="pr-board-heading"><div><h1>{board.title && board.title !== 'Storyboard' ? board.title : projectName}</h1>
          <p>Talk to your assistant. Use the names and shot labels below to ask for changes.</p></div>
          <div className="pr-board-meta">{board.production?.targetDurationSeconds > 0 && <span>{seconds(board.production.targetDurationSeconds)} planned</span>}{board.shots.length > 0 && <span>{board.shots.length} shots · {seconds(board.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0))} storyboard</span>}{board.songAssetId && <span title={song ? nameOf(song) : board.songAssetId}>{song ? nameOf(song) : 'Song is missing from Assets'}</span>}</div>
        </div>
        {empty ? <div className="pr-empty-board"><ImageIcon size={38} aria-hidden="true" /><h2>Your references and storyboard will appear here.</h2><p>Tell your assistant what you want to make. Discuss the story and characters together, then ask it to add the references you want to explore.</p><span>No forms to fill out. The conversation happens with your assistant.</span></div> : <>
          <div className="pr-reference-sections">
          <EntitySection title="Characters" entities={cast} assetsById={assetsById} cast />
          <EntitySection title="Locations" entities={locations} assetsById={assetsById} />
          {references.length > 0 && <section className="pr-board-section" aria-label="References"><div className="pr-section-heading"><h2>References</h2><span>{references.length}</span></div><div className="pr-reference-grid">{references.map(reference => {
            const asset = assetsById.get(reference.assetId)
            return <ReferenceCard key={reference.assetId} id={reference.assetId} asset={asset} label={reference.displayLabel || reference.name} />
          })}</div></section>}
          </div>
          <section className="pr-board-section pr-storyboard-section" aria-label="Storyboard"><div className="pr-section-heading"><h2>Storyboard</h2><span>{board.shots.length} shots</span></div>
            {board.shots.length ? <div className="pr-shot-grid">{presentation.shots.map(shot => <ShotCard key={shot.shotId} shot={shot} board={board} assetsById={assetsById} highlighted={highlightShotIds.includes(shot.shotId)} />)}</div> : <p className="pr-storyboard-empty">Once you're happy with the references, ask your assistant to create the storyboard images.</p>}
          </section>
        </>}
        <p className="pr-editor-note">When you're ready, ask your assistant to build an animatic on a normal Velorn timeline. Review and edit it in the editor.</p>
      </>}
    </div>
  </section>
}

export default function ProductionWorkspace({ workspace = false, onBackToEditor, highlightShotIds = [] } = {}) {
  const exists = useProjectStore(state => Boolean(state.currentProject))
  const handle = useProjectStore(state => state.currentProjectHandle)
  const name = useProjectStore(state => state.currentProject?.name)
  const created = useProjectStore(state => state.currentProject?.created)
  if (!exists) return <section className="production-workspace" aria-label="Production reference board"><p className="pr-board-notice">Open a project to see its reference board.</p></section>
  return <BoardSession key={sessionKey(handle, `${name}:${created}`)} projectName={name || 'Untitled project'} workspace={workspace} onBackToEditor={onBackToEditor} highlightShotIds={highlightShotIds} />
}
