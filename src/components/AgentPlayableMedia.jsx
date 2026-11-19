import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'

export function useAgentPlayableMedia({ projectPath, chatId, turnIds, assets }) {
  const api = window.electronAPI?.agentReviewMedia
  const turns = [...new Set(turnIds.filter(id => typeof id === 'string'))].slice(-100)
  const turnsKey = turns.join('\n'), scope = `${projectPath}\n${chatId}`
  const current = useRef(scope), epoch = useRef(0)
  current.current = scope
  const [state, setState] = useState({ scope, items: [], candidates: [], error: '' })
  const reload = useCallback(async () => {
    const request = ++epoch.current
    if (!projectPath || !chatId || !api?.listPlayable) return
    try {
      const result = await api.listPlayable({ projectPath, chatId, turnIds: turnsKey ? turnsKey.split('\n') : [] })
      if (current.current !== scope || request !== epoch.current) return
      if (!result?.success) throw Error(result?.error || 'Audio/video attachments could not be restored.')
      setState({ scope, items: result.items || [], candidates: result.candidates || [], error: '' })
    } catch (error) {
      if (current.current === scope && request === epoch.current) setState(previous => ({ ...previous, scope,
        items: previous.scope === scope ? previous.items : [], candidates: [], error: error.message }))
    }
  }, [api, projectPath, chatId, turnsKey, scope])
  useEffect(() => {
    void reload()
    const unsubscribe = api?.onChanged?.(event => { if (!event?.chatId || event.chatId === chatId) void reload() })
    return () => { epoch.current++; unsubscribe?.() }
  }, [api, reload, assets, chatId])
  const attach = useCallback(async (turnId, assetIds) => {
    const result = await api.attachPlayable({ projectPath, chatId, turnId, assetIds })
    if (!result?.success) throw Error(result?.error || 'The media could not be attached.')
    if (current.current === scope) await reload()
  }, [api, projectPath, chatId, scope, reload])
  return { ...(state.scope === scope ? state : { items: [], candidates: [], error: '' }), attach }
}

function Player({ item }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [item.url])
  return <figure>
    <figcaption>{item.name || (item.type === 'audio' ? 'Audio' : 'Video')}</figcaption>
    {item.unavailable || !item.url ? <p role="status">File unavailable. The saved attachment is retained.</p>
      : <>{item.type === 'audio'
        ? <audio aria-label={item.name || 'Audio attachment'} controls preload="metadata" src={item.url} onError={() => setFailed(true)} />
        : <video aria-label={item.name || 'Video attachment'} controls playsInline preload="metadata" src={item.url} onError={() => setFailed(true)} />}
        {failed && <p role="status">This file could not be played. Check its availability or codec in project assets.</p>}
      </>}
  </figure>
}
export function AgentPlayableMedia({ items = [], candidates = [], onAttach, disabled, children }) {
  const [selected, setSelected] = useState([]), [saving, setSaving] = useState(false), [error, setError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false), [pickerOpen, setPickerOpen] = useState(false)
  const menuRoot = useRef(null), trigger = useRef(null), menuItem = useRef(null), picker = useRef(null)
  const id = useId(), canAttach = Boolean(onAttach && candidates.length)
  const closePicker = () => { setPickerOpen(false); setSelected([]); setError(''); trigger.current?.focus() }
  useEffect(() => {
    if (!menuOpen) return
    menuItem.current?.focus()
    const outside = event => { if (!menuRoot.current?.contains(event.target)) setMenuOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [menuOpen])
  useEffect(() => {
    if (pickerOpen) (picker.current?.querySelector('input:not(:disabled)') || picker.current)?.focus()
  }, [pickerOpen])
  useEffect(() => {
    if (disabled || !canAttach) setMenuOpen(false)
    if (!canAttach) { setPickerOpen(false); setSelected([]) }
  }, [disabled, canAttach])
  const actions = canAttach && <span ref={menuRoot} className="ca-reply-options" data-ca-copy-exclude
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false) }}>
    <button ref={trigger} type="button" aria-label="Reply options" title="Reply options" aria-haspopup="menu"
      aria-expanded={menuOpen} aria-controls={menuOpen ? `${id}-menu` : undefined} disabled={disabled || saving}
      onClick={() => setMenuOpen(open => !open)} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMenuOpen(true) }
      }}><MoreHorizontal size={16} /></button>
    {menuOpen && <span id={`${id}-menu`} className="ca-reply-menu" role="menu" aria-label="Reply options" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenuOpen(false); trigger.current?.focus() }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); menuItem.current?.focus() }
    }}><button ref={menuItem} type="button" role="menuitem" onClick={() => {
      setMenuOpen(false); setSelected([]); setError(''); setPickerOpen(true)
    }}>Show project media here</button></span>}
  </span>
  return <>
    {children ? children(actions) : actions && <div className="ca-message-actions">{actions}</div>}
    {(items.length > 0 || (pickerOpen && canAttach)) && <section className="ca-playable-media" aria-label="Audio and video attachments">
    {items.map(item => <Player key={item.id} item={item} />)}
    {pickerOpen && canAttach && <div ref={picker} tabIndex={-1} className="ca-reply-media-picker" role="group" aria-label="Show project media here"
      onKeyDown={event => { if (event.key === 'Escape' && !saving) { event.preventDefault(); event.stopPropagation(); closePicker() } }}>
      <strong>Show project media here</strong>
      <p>Add a player for existing project media. Nothing is sent to the AI or regenerated.</p>
      <div className="ca-media-choices">{candidates.map(asset => <label key={asset.id}>
        <input type="checkbox" checked={selected.includes(asset.id)} disabled={disabled || saving || (selected.length >= 100 && !selected.includes(asset.id))}
          onChange={event => setSelected(old => event.target.checked ? [...old, asset.id] : old.filter(id => id !== asset.id))} />
        {asset.name} · {asset.type}
      </label>)}</div>
      <div className="ca-reply-media-buttons"><button type="button" disabled={disabled || saving || !selected.length} onClick={async () => {
        if (saving || disabled || !selected.length) return
        setSaving(true); setError('')
        try { await onAttach(selected); closePicker() }
        catch (problem) { setError(problem.message) } finally { setSaving(false) }
      }}>{saving ? 'Adding…' : 'Add to reply'}</button>
      <button type="button" disabled={saving} onClick={closePicker}>Cancel</button></div>
      {error && <p role="alert">{error}</p>}
    </div>}
  </section>}
  </>
}
