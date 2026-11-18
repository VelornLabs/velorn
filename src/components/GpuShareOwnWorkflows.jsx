import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { acceptGpuShare, getGpuShare, loadGpuShare, subscribeGpuShare } from '../services/gpuShareState'

// "Your own workflows" in the GPU sharing tab: pick one of the workflows saved
// in Velorn, look at what Velorn found in it, name it, test it on this computer,
// and then choose whether the people this owner invites may use it.
const box = 'rounded-lg border border-sf-dark-700 bg-sf-dark-900 p-3 flex flex-col gap-2 min-w-0'
const heading = 'text-[11px] font-semibold uppercase tracking-wide text-sf-text-muted'
const quiet = 'text-xs leading-relaxed text-sf-text-muted'
const button = 'flex-none rounded-md border border-sf-dark-600 bg-sf-dark-800 px-2.5 py-1 text-xs text-sf-text-primary hover:bg-sf-dark-700 disabled:opacity-45 disabled:cursor-default transition-colors'
const field = 'min-w-0 rounded-md border border-sf-dark-600 bg-sf-dark-950 px-2 py-1 text-xs text-sf-text-primary placeholder:text-sf-text-muted focus:outline-none focus:border-sf-accent'
const sameSpot = (a, b) => Boolean(a && b && a.nodeId === b.nodeId && a.inputKey === b.inputKey)

export default function GpuShareOwnWorkflows() {
  const api = typeof window !== 'undefined' ? window.electronAPI?.gpuShare?.own : null
  const [workflows, setWorkflows] = useState(null)
  const [examples, setExamples] = useState({}) // id -> { url, video }
  const [picker, setPicker] = useState(null) // null | { workflows, filter }
  const [found, setFound] = useState(null) // what Velorn found in the picked workflow
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState(null)
  const [busy, setBusy] = useState('') // '' | 'reading' | 'adding' | 'testing:<id>' | 'removing:<id>'
  const [error, setError] = useState('')
  const [renaming, setRenaming] = useState(null) // null | { id, name }: the workflow whose name is being typed
  const [confirmOffer, setConfirmOffer] = useState('') // the workflow whose "offer to everyone" notice is showing
  const urls = useRef({})
  // The name people see on these workflows lives with the other sharing choices.
  const shareApi = typeof window !== 'undefined' ? window.electronAPI?.gpuShare : null
  const { state: sharing } = useSyncExternalStore(subscribeGpuShare, getGpuShare)
  const savedName = sharing?.settings?.displayName || ''
  const everyoneOn = sharing?.settings?.everyone?.enabled === true
  const [maker, setMaker] = useState(null) // null until the person types
  const [makerNote, setMakerNote] = useState('')
  const makerTimer = useRef(null)
  // The name saves itself: a moment after the last key, and at once on Enter or when the field is left. There is no button to forget.
  const saveMaker = async value => {
    clearTimeout(makerTimer.current)
    if (value === null || value.trim() === savedName) { setMakerNote(''); return }
    try {
      const next = await shareApi.update({ displayName: value })
      if (next?.success) { acceptGpuShare(next); setMaker(current => (current === value ? null : current)); setMakerNote('Saved'); setError('') } else { setMakerNote(''); setError(next?.error || 'That name could not be saved.') }
    } catch { setMakerNote(''); setError('That name could not be saved.') }
  }
  const typeMaker = value => { setMaker(value); setMakerNote(''); clearTimeout(makerTimer.current); makerTimer.current = setTimeout(() => void saveMaker(value), 700) }
  useEffect(() => () => clearTimeout(makerTimer.current), [])
  // Asking for a workflow to be open to everyone sends it for review; taking that back withdraws it.
  const offer = async (id, everyone) => {
    setError(''); setBusy(`offering:${id}`)
    try { const result = await api.offer({ id, everyone }); if (!result?.success) setError(result?.error || 'That could not be done.') }
    catch { setError('That could not be done.') } finally { setBusy(''); await load() }
  }
  const share = async (id, shared) => {
    setError(''); setBusy(`sharing:${id}`)
    try { const result = await api.share({ id, shared }); if (!result?.success) setError(result?.error || 'That change could not be saved.') }
    catch { setError('That change could not be saved.') } finally { setBusy(''); await load(); void loadGpuShare() }
  }

  const showExample = useCallback(async id => {
    try {
      const got = await api.example({ id })
      if (!got?.success) return
      const url = URL.createObjectURL(new Blob([got.bytes], { type: got.mimeType }))
      if (urls.current[id]) URL.revokeObjectURL(urls.current[id])
      urls.current[id] = url
      setExamples(all => ({ ...all, [id]: { url, video: got.mimeType.startsWith('video/') } }))
    } catch { /* The list still works without its picture. */ }
  }, [api])
  const load = useCallback(async () => {
    if (!api?.list) return
    try {
      const listed = await api.list()
      const next = listed?.success && Array.isArray(listed.workflows) ? listed.workflows : []
      setWorkflows(next)
      for (const item of next) if (item.hasExample && !urls.current[item.id]) void showExample(item.id)
    } catch { setWorkflows([]) }
  }, [api, showExample])
  useEffect(() => { void load() }, [load])
  useEffect(() => () => { for (const url of Object.values(urls.current)) URL.revokeObjectURL(url) }, [])

  if (!api?.list) return null
  const close = () => { setPicker(null); setFound(null); setName(''); setPrompt(null); setError('') }
  const openPicker = async () => {
    setError(''); setFound(null); setBusy('reading')
    try { const listed = await api.candidates(); if (listed?.success) setPicker({ workflows: listed.workflows, filter: '' }); else setError(listed?.error || 'Your saved workflows could not be read.') }
    catch { setError('Your saved workflows could not be read.') } finally { setBusy('') }
  }
  const pick = async item => {
    setError(''); setBusy('reading')
    try {
      const result = await api.inspect({ workflowId: item.workflowId })
      if (result?.success) { setFound(result); setName(item.title.replace(/[_-]+/g, ' ').slice(0, 60)); setPrompt(result.prompt) }
      else setError(result?.error || 'Velorn could not read this workflow.')
    } catch { setError('Velorn could not read this workflow.') } finally { setBusy('') }
  }
  const add = async () => {
    setError(''); setBusy('adding')
    try {
      const result = await api.add({ workflowId: found.workflowId, name, prompt })
      if (result?.success) { close(); await load() } else setError(result?.error || 'It could not be added.')
    } catch { setError('It could not be added.') } finally { setBusy('') }
  }
  const test = async id => {
    setError(''); setBusy(`testing:${id}`)
    try {
      const result = await api.test({ id })
      if (!result?.success) setError(result?.error || 'The test could not be finished.')
      else { delete urls.current[id]; void showExample(id) }
    } catch { setError('The test could not be finished.') } finally { setBusy(''); await load() }
  }
  const rename = async () => {
    if (!renaming?.name.trim()) return
    setError(''); setBusy(`renaming:${renaming.id}`)
    try { const result = await api.rename({ id: renaming.id, name: renaming.name }); if (result?.success) setRenaming(null); else setError(result?.error || 'It could not be renamed.') }
    catch { setError('It could not be renamed.') } finally { setBusy(''); await load() }
  }
  const remove = async id => {
    setError(''); setBusy(`removing:${id}`)
    try { const result = await api.remove({ id }); if (!result?.success) setError(result?.error || 'It could not be removed.') }
    catch { setError('It could not be removed.') } finally { setBusy(''); await load() }
  }
  const shown = picker ? picker.workflows.filter(item => !picker.filter.trim() || item.title.toLowerCase().includes(picker.filter.trim().toLowerCase())) : []

  return <section className={box} aria-label="What you share" data-testid="own-workflows">
    <h3 className={heading}>What you share</h3>
    <p className={quiet}>Add a workflow you made in ComfyUI and saved to Velorn. Velorn works out where the description and the picture go. Test it here, then tick it to share it with the people you invite. They see it in their GPU sharing tab, under the name you give it.</p>
    {workflows?.some(item => item.shared) && <label className="flex flex-col gap-1 text-xs min-w-0">
      <span className="flex items-baseline justify-between gap-2"><span className="text-sf-text-muted">Your name on them</span>
        <span className="text-[11px] text-sf-text-muted" role="status">{makerNote}</span></span>
      <input type="text" className={field} maxLength={40} placeholder="A Velorn creator" value={maker ?? savedName} onChange={event => typeMaker(event.target.value)}
        onBlur={() => void saveMaker(maker)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void saveMaker(maker) } }} />
    </label>}
    {workflows?.length > 0 && <ul className="flex flex-col gap-2 min-w-0">{workflows.map(item => <li key={item.id} className="rounded-md bg-sf-dark-800 px-2.5 py-2 flex gap-2.5 min-w-0">
      {examples[item.id] && (examples[item.id].video
        ? <video src={examples[item.id].url} muted loop autoPlay playsInline className="h-16 w-16 flex-none rounded object-cover bg-sf-dark-950" aria-label={`Example made by ${item.name}`} />
        : <img src={examples[item.id].url} alt={`Example made by ${item.name}`} className="h-16 w-16 flex-none rounded object-cover bg-sf-dark-950" />)}
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2 min-w-0">{renaming?.id === item.id
          ? <span className="flex flex-wrap items-center gap-1.5 min-w-0 flex-1"><input type="text" autoFocus className={`${field} min-w-0 flex-1`} maxLength={60} aria-label="New name" value={renaming.name}
              onChange={event => setRenaming({ id: item.id, name: event.target.value })}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void rename() } else if (event.key === 'Escape') setRenaming(null) }} />
            <button type="button" className={button} disabled={Boolean(busy) || !renaming.name.trim()} onClick={() => void rename()}>Save</button>
            <button type="button" className={button} disabled={Boolean(busy)} onClick={() => setRenaming(null)}>Cancel</button></span>
          : <span className="text-sm font-medium break-words min-w-0">{item.name}</span>}
          <span className="flex-none text-[11px] text-sf-text-muted">{item.shapeLabel}</span></div>
        <p className={`${quiet} break-words`} role="status">{busy === `testing:${item.id}` ? 'Testing on this computer. This can take a few minutes.'
          : item.trouble ? `The last test did not finish: ${item.trouble}` : item.testedAt ? `Tested. It took ${item.testSeconds} seconds on this computer.` : 'Not tested yet.'}</p>
        <label className={`flex items-start gap-2 text-xs min-w-0 ${item.testedAt && !item.trouble ? 'cursor-pointer' : 'text-sf-text-muted'}`}>
          <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 flex-none accent-sf-accent" checked={item.shared} disabled={Boolean(busy) || (!item.shared && (!item.testedAt || Boolean(item.trouble)))}
            onChange={event => void share(item.id, event.target.checked)} />
          <span className="min-w-0">{item.testedAt && !item.trouble ? 'Share with the people I invite' : 'Test it first, then it can be shared'}</span>
        </label>
        {item.shared && <p className={`${quiet} break-words`} role="status">{busy === `offering:${item.id}` ? 'Sending…' : !item.everyone ? 'Only the people you invite can use it.'
          : !item.review ? 'You asked for it to be open to everyone. Velorn could not check where the review stands right now.'
          : item.review.status === 'approved' ? (everyoneOn ? 'Approved. It is open to every Velorn user.' : 'Approved. Switch on “Open to everyone” below and every Velorn user can use it.')
          : item.review.status === 'pending' ? 'Sent for review. Until it is approved, only the people you invite can use it.'
          : item.review.status === 'declined' ? `Not approved${item.review.note ? `: ${item.review.note}` : '.'} Only the people you invite can use it.`
          : item.review.status === 'paused' ? 'Paused after reports from people who used it. A reviewer will look again.'
          : 'It changed or was not sent. Offer it again to have it looked at.'}</p>}
        {confirmOffer === item.id && <div className="rounded-md border border-sf-dark-700 p-2 flex flex-col gap-1.5 min-w-0" role="group" aria-label="Offer to everyone">
          <p className="text-xs text-sf-text-secondary">A Velorn reviewer looks at it first. They get its name, your name on it, its example, and a copy of the workflow to open. They may also run one test on this computer. The copy is deleted once they decide.</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button type="button" className={button} disabled={Boolean(busy)} onClick={() => { setConfirmOffer(''); void offer(item.id, true) }}>Send it for review</button>
            <button type="button" className={button} disabled={Boolean(busy)} onClick={() => setConfirmOffer('')}>Cancel</button>
          </div>
        </div>}
        <div className="flex items-center gap-1.5 flex-wrap">
          {item.shared && (!item.everyone || ['changed', 'not-sent', 'declined'].includes(item.review?.status)) && confirmOffer !== item.id && <button type="button" className={button} disabled={Boolean(busy)} onClick={() => setConfirmOffer(item.id)}>{item.everyone ? 'Send it again' : 'Offer to everyone'}</button>}
          {item.shared && item.everyone && <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void offer(item.id, false)}>{item.review?.status === 'pending' ? 'Cancel the review' : 'Stop offering to everyone'}</button>}
          <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void test(item.id)}>{item.testedAt ? 'Test again' : 'Test it'}</button>
          {renaming?.id !== item.id && <button type="button" className={button} disabled={Boolean(busy)} onClick={() => { setError(''); setRenaming({ id: item.id, name: item.name }) }}>Rename</button>}
          <button type="button" className={button} disabled={Boolean(busy)} onClick={() => void remove(item.id)}>Remove</button>
        </div>
      </div>
    </li>)}</ul>}

    {!picker && <button type="button" className={`${button} self-start`} disabled={Boolean(busy)} onClick={() => void openPicker()}>Add one of my workflows</button>}

    {picker && !found && <div className="rounded-md border border-sf-dark-700 p-2.5 flex flex-col gap-2 min-w-0">
      <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">Choose a saved workflow</span>
        <button type="button" className={button} onClick={close}>Cancel</button></div>
      {picker.workflows.length === 0 ? <p className={quiet}>You have no saved workflows yet. Open one in the ComfyUI tab and save it to Velorn first.</p> : <>
        {picker.workflows.length > 8 && <input type="search" className={field} placeholder="Search your workflows" aria-label="Search your workflows" value={picker.filter} onChange={event => setPicker(now => ({ ...now, filter: event.target.value }))} />}
        <ul className="flex flex-col gap-1 max-h-56 overflow-y-auto min-w-0">{shown.map(item => <li key={item.workflowId} className="min-w-0">
          <button type="button" className="w-full text-left rounded-md px-2 py-1.5 text-xs hover:bg-sf-dark-800 disabled:opacity-45 flex items-center justify-between gap-2 min-w-0"
            disabled={Boolean(busy) || item.added} onClick={() => void pick(item)}>
            <span className="break-words min-w-0">{item.title}</span>{item.added && <span className="flex-none text-[11px] text-sf-text-muted">Added</span>}</button>
        </li>)}{shown.length === 0 && <li className={quiet}>Nothing matches.</li>}</ul></>}
    </div>}

    {found && <div className="rounded-md border border-sf-dark-700 p-2.5 flex flex-col gap-2 min-w-0" role="group" aria-label="What Velorn found">
      <div className="text-xs font-medium break-words">{found.title}</div>
      {found.canAdd ? <>
        <p className="text-sm">This looks like: <span className="font-medium">{found.shapeLabel}</span></p>
        <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-xs min-w-0">
          <dt className="text-sf-text-muted">Description goes into</dt>
          <dd className="min-w-0">{found.promptChoices.length > 1
            ? <select className={`${field} w-full`} aria-label="Where the description goes" value={`${prompt?.nodeId}\n${prompt?.inputKey}`}
                onChange={event => { const [nodeId, inputKey] = event.target.value.split('\n'); setPrompt({ nodeId, inputKey }) }}>
                {found.promptChoices.map(choice => <option key={`${choice.nodeId}\n${choice.inputKey}`} value={`${choice.nodeId}\n${choice.inputKey}`}>{choice.label}{choice.holds ? `: “${choice.holds.slice(0, 40)}…”` : ''}</option>)}
              </select>
            : <span className="break-words">{found.promptChoices[0]?.label}</span>}</dd>
          {found.image && <><dt className="text-sf-text-muted">Picture goes into</dt><dd className="min-w-0 break-words">{found.image.label}</dd></>}
          <dt className="text-sf-text-muted">Result comes from</dt><dd className="min-w-0 break-words">{found.output.label}</dd>
        </dl>
        {found.promptChoices.length > 1 && !sameSpot(prompt, found.prompt) && <p className={quiet}>Velorn’s own guess was another box. Test it after adding, to see that the description lands where you expect.</p>}
        <label className="flex flex-col gap-1 text-xs min-w-0"><span className="text-sf-text-muted">Name people will see</span>
          <input type="text" className={field} maxLength={60} value={name} onChange={event => setName(event.target.value)} /></label>
      </> : <ul className="flex flex-col gap-1.5 min-w-0">{found.problems.map(problem => <li key={problem} className="text-xs text-sf-text-secondary break-words">{problem}</li>)}</ul>}
      <div className="flex items-center gap-1.5 flex-wrap">
        {found.canAdd && <button type="button" className={button} disabled={Boolean(busy) || !name.trim()} onClick={() => void add()}>Add it</button>}
        <button type="button" className={button} disabled={Boolean(busy)} onClick={() => { setFound(null); setError('') }}>Choose another</button>
        <button type="button" className={button} disabled={Boolean(busy)} onClick={close}>Cancel</button>
      </div>
    </div>}
    {busy === 'reading' && <p className={quiet} role="status">Looking inside…</p>}
    {error && <p className="text-xs text-sf-error break-words" role="status">{error}</p>}
  </section>
}
