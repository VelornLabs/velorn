import { useCallback, useEffect, useRef, useState } from 'react'

const REVIEW_ID = /^review-[a-zA-Z0-9-]{1,100}$/
const TURN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const REVIEW_DATA = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const SESSION_WARNING = 'Review stills are available for this session only. Restart Velorn to enable saved review media.'

function restoredFrame(value, chatId, turnIds) {
  if (!value || !REVIEW_ID.test(value.id) || value.chatId !== chatId || !turnIds.has(value.turnId)
    || !Number.isFinite(value.capturedAt)) return null
  const unavailable = value.unavailable === true
  if (!unavailable && (typeof value.dataUrl !== 'string' || value.dataUrl.length > 300000 || !REVIEW_DATA.test(value.dataUrl))) return null
  return { id: value.id, chatId, turnId: value.turnId, capturedAt: value.capturedAt,
    label: String(value.label || 'Review still').slice(0, 100), persisted: true,
    ...(unavailable ? { unavailable: true } : { dataUrl: value.dataUrl }),
    ...(Number.isFinite(value.timeSeconds) && value.timeSeconds >= 0 && typeof value.timelineId === 'string'
      ? { timeSeconds: value.timeSeconds, timelineId: value.timelineId } : {}) }
}

// Thumbnails live in a project-owned native store, not conversation localStorage
// and not model context. Saving/restoring them never changes image-sharing grants.
export function useAgentReviewMedia({ projectKey, projectPath, chatId, turnIds, isProjectCurrent }) {
  const api = window.electronAPI?.agentReviewMedia
  const supported = typeof api?.saveFrame === 'function' && typeof api?.listFrames === 'function'
  const turnsKey = [...new Set(turnIds.filter(id => typeof id === 'string' && TURN_ID.test(id)))].slice(-100).join('\n')
  const scope = useRef(null), alive = useRef(false), readEpoch = useRef(0)
  const emptyCache = () => ({ projectKey, frames: new Map(), pending: new Map(), errors: new Set(), revisions: new Map(), revision: 0, loadError: '' })
  const cache = useRef(null)
  if (!cache.current || cache.current.projectKey !== projectKey) cache.current = emptyCache()
  scope.current = { projectKey, projectPath, chatId, turnsKey, isProjectCurrent }
  const [state, setState] = useState({ projectKey, frames: [], warning: '' })
  const publish = useCallback(() => {
    if (!alive.current || scope.current.projectKey !== projectKey || !scope.current.isProjectCurrent()) return
    const current = cache.current, activeChat = scope.current.chatId
    const warning = (current.notice?.chatId === activeChat ? current.notice.text : '') || current.loadError || ([...current.errors].some(id => current.frames.get(id)?.chatId === activeChat)
      ? 'Some review stills could not be saved. They remain available in this session; keep Velorn open and check project storage.'
      : !supported && scope.current.turnsKey ? SESSION_WARNING : '')
    setState({ projectKey, frames: [...current.frames.values()].sort((a, b) => a.capturedAt - b.capturedAt), warning })
  }, [projectKey, supported])
  const reload = useCallback(async () => {
    const currentScope = scope.current, epoch = ++readEpoch.current
    if (!supported || !currentScope.isProjectCurrent()) { publish(); return }
    const ids = new Set(currentScope.turnsKey.split('\n').filter(Boolean))
    const readRevision = cache.current.revision
    const isCurrent = () => alive.current && epoch === readEpoch.current && scope.current.projectKey === projectKey
      && scope.current.projectPath === currentScope.projectPath && scope.current.chatId === currentScope.chatId
      && scope.current.turnsKey === currentScope.turnsKey && scope.current.isProjectCurrent()
    try {
      const result = await api.listFrames({ projectPath: currentScope.projectPath, chatId: currentScope.chatId, turnIds: [...ids] })
      if (!isCurrent()) return
      if (!result?.success || !Array.isArray(result.frames)) throw Error('Review history unavailable')
      const current = cache.current
      for (const [id, frame] of current.frames) {
        if (frame.persisted && !current.pending.has(id) && (current.revisions.get(id) || 0) <= readRevision) current.frames.delete(id)
      }
      for (const item of result.frames) {
        const frame = restoredFrame(item, currentScope.chatId, ids)
        if (frame && !current.pending.has(frame.id) && !current.errors.has(frame.id)
          && (current.revisions.get(frame.id) || 0) <= readRevision) current.frames.set(frame.id, frame)
      }
      current.loadError = ''
    } catch {
      if (!isCurrent()) return
      cache.current.loadError = 'Saved review stills could not be restored. Reopen this conversation to retry; saved files have not been removed.'
    }
    publish()
  }, [api, supported, projectKey, publish])
  useEffect(() => {
    alive.current = true
    cache.current.loadError = ''
    publish()
    void reload()
    let unsubscribe
    if (supported && typeof api.onChanged === 'function') unsubscribe = api.onChanged(event => {
      if (!event?.chatId || event.chatId === scope.current.chatId) {
        cache.current.notice = typeof event?.error === 'string' ? { chatId: scope.current.chatId, text: event.error.slice(0, 500) } : null
        publish()
        void reload()
      }
    })
    return () => { alive.current = false; readEpoch.current++; unsubscribe?.() }
  }, [api, supported, projectKey, projectPath, chatId, turnsKey, publish, reload])
  const saveFrame = useCallback(async (frame, owner) => {
    if (!alive.current || scope.current.projectKey !== projectKey || !scope.current.isProjectCurrent()
      || !frame || !REVIEW_ID.test(frame.id) || !TURN_ID.test(owner?.turnId) || typeof owner?.chatId !== 'string') return
    const current = cache.current, marker = {}, ownedFrame = { ...frame, chatId: owner.chatId, turnId: owner.turnId, persisted: false }
    current.frames.set(frame.id, ownedFrame)
    current.revisions.set(frame.id, ++current.revision)
    current.pending.set(frame.id, marker)
    publish()
    if (!supported) { current.pending.delete(frame.id); return }
    try {
      const result = await api.saveFrame({ projectPath: scope.current.projectPath, chatId: owner.chatId, turnId: owner.turnId, frame })
      if (!alive.current || cache.current !== current || !scope.current.isProjectCurrent() || current.pending.get(frame.id) !== marker) return
      if (!result?.success) throw Error('Review still not saved')
      current.frames.set(frame.id, { ...ownedFrame, persisted: true })
      current.errors.delete(frame.id)
    } catch {
      if (!alive.current || cache.current !== current || current.pending.get(frame.id) !== marker) return
      current.errors.add(frame.id)
    } finally {
      if (cache.current === current && current.pending.get(frame.id) === marker) current.pending.delete(frame.id)
      publish()
    }
  }, [api, supported, projectKey, publish])
  return { frames: state.projectKey === projectKey ? state.frames : [], warning: state.projectKey === projectKey ? state.warning : '', saveFrame }
}

export async function reviewThumbnail(frame) {
  if (!frame || typeof frame.id !== 'string' || !/^review-[a-zA-Z0-9-]{1,100}$/.test(frame.id)
    || typeof frame.dataUrl !== 'string' || frame.dataUrl.length > 1100000
    || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(frame.dataUrl)) return null
  const image = new Image()
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { image.src = ''; reject(Error('Preview decoding timed out')) }, 5000)
    image.onload = () => { clearTimeout(timeout); resolve() }
    image.onerror = () => { clearTimeout(timeout); reject(Error('Preview unavailable')) }
    image.src = frame.dataUrl
  })
  if (!image.width || !image.height || image.width * image.height > 40000000) return null
  const scale = Math.min(1, 960 / Math.max(image.width, image.height)), canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale))
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
  const dataUrl = canvas.toDataURL('image/jpeg', 0.75)
  if (dataUrl.length > 300000) return null
  return { id: frame.id, dataUrl, label: String(frame.label || 'Review still').slice(0,100), capturedAt: frame.capturedAt,
    ...(Number.isFinite(frame.timeSeconds) && frame.timeSeconds >= 0 && typeof frame.timelineId === 'string'
      ? { timeSeconds: frame.timeSeconds, timelineId: frame.timelineId } : {}) }
}

export function AgentReviewGallery({ frames, onShow, disabled }) {
  const [selected, setSelected] = useState(null), dialog = useRef(null)
  useEffect(() => { if (selected) dialog.current?.showModal(); else dialog.current?.close() }, [selected])
  useEffect(() => { if (selected && !frames.some(frame => frame.id === selected.id && !frame.unavailable)) setSelected(null) }, [frames, selected])
  if (!frames.length) return null
  const caption = frame => `${frame.label}${Number.isFinite(frame.timeSeconds) ? ` · ${frame.timeSeconds.toFixed(3)}s` : ''}`
  return <section className="ca-review-gallery" aria-label="Review stills">
    <h3>Review stills</h3><p>Captured snapshots · tap to enlarge. Not live views.</p>
    <div className="ca-review-grid">{frames.map(frame => <figure key={frame.id}>
      {frame.unavailable ? <p role="status">File unavailable · the saved review still could not be read.</p>
        : <button type="button" aria-label={`Enlarge ${caption(frame)}`} onClick={() => setSelected(frame)}><img src={frame.dataUrl} alt={caption(frame)} /></button>}
      <figcaption>{caption(frame)} · {new Date(frame.capturedAt).toLocaleTimeString()}</figcaption>
      {!frame.unavailable && Number.isFinite(frame.timeSeconds) && <button type="button" disabled={disabled} onClick={() => onShow(frame.id)}>Show in editor</button>}
    </figure>)}</div>
    <dialog ref={dialog} aria-label="Review still preview" className="ca-review-dialog" onCancel={() => setSelected(null)} onClose={() => setSelected(null)}>
      <button type="button" onClick={() => setSelected(null)} autoFocus>Close preview</button>
      {selected && <><img src={selected.dataUrl} alt={caption(selected)} /><p>{caption(selected)} · Captured snapshot</p></>}
    </dialog>
  </section>
}

export function AgentRecoveredReviewGallery({ message, messages, frames, chatId, busy, onShow, disabled }) {
  if (busy || message.role !== 'user' || !message.turnId
    || messages.some(item => item.role === 'assistant' && item.turnId === message.turnId)) return null
  const recovered = frames.filter(frame => frame.chatId === chatId && frame.turnId === message.turnId)
  if (!recovered.length) return null
  return <section aria-label="Recovered review media">
    <p>Recovered review media · previous request did not finish</p>
    <AgentReviewGallery frames={recovered} onShow={onShow} disabled={disabled} />
  </section>
}
