import { useCallback, useEffect, useRef, useState } from 'react'
import { openApiWorkflowInComfyUi } from '../services/workflowSetupManager'

// The review list, for the accounts the Velorn service lists as reviewers.
// Workflows their owners want open to everyone wait here, and so do the jobs
// hosts reported. Shown only when the service says this account is a reviewer.
const box = 'rounded-lg border border-sf-dark-700 bg-sf-dark-900 p-3 flex flex-col gap-2 min-w-0'
const heading = 'text-[11px] font-semibold uppercase tracking-wide text-sf-text-muted'
const quiet = 'text-xs leading-relaxed text-sf-text-muted'
const button = 'flex-none rounded-md border border-sf-dark-600 bg-sf-dark-800 px-2.5 py-1 text-xs text-sf-text-primary hover:bg-sf-dark-700 disabled:opacity-45 disabled:cursor-default transition-colors'
const SHAPE = { 'text-to-picture': 'Text to picture', 'picture-edit': 'Picture edit', 'picture-to-video': 'Picture to video', 'text-to-video': 'Text to video', 'text-to-music': 'Text to music' }
const STATUS = { pending: 'Waiting for you', paused: 'Paused after reports', approved: 'Open to everyone', declined: 'Declined' }

export default function GpuShareReview() {
  const api = typeof window !== 'undefined' ? window.electronAPI?.gpuShare?.review : null
  const [data, setData] = useState(null)
  const [examples, setExamples] = useState({})
  const [open, setOpen] = useState('') // the submission whose details are shown
  const [asking, setAsking] = useState(null) // { kind: 'decline' | 'ban' | 'ban-job', id, note }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const urls = useRef({})
  // Trying one: a description (and a picture where it starts from one) goes to the owner's computer as one test job.
  const [trying, setTrying] = useState(null) // { sid, prompt, image, running, result: { url, video }, problem }
  const tried = useRef('')
  // What a reporting owner's computer sent along: fetched on a click, shown here, dropped when the list goes.
  const [sent, setSent] = useState({}) // jobId -> { loading, problem, result: { url, video }, picture: { url } }
  const sentUrls = useRef([])
  useEffect(() => () => { for (const url of sentUrls.current) URL.revokeObjectURL(url) }, [])
  const showSent = async report => {
    setSent(now => ({ ...now, [report.jobId]: { loading: true } }))
    const fetchOne = async kind => {
      const got = await api.evidence({ jobId: report.jobId, kind }).catch(() => null)
      if (!got?.success) return null
      const url = URL.createObjectURL(new Blob([got.bytes], { type: got.mimeType })); sentUrls.current.push(url)
      return { url, video: got.mimeType.startsWith('video/') }
    }
    // Both are asked for inside the one click; the second call would otherwise have no click to stand on.
    const [result, picture] = await Promise.all([report.result ? fetchOne('output') : null, report.picture ? fetchOne('image') : null])
    setSent(now => ({ ...now, [report.jobId]: { loading: false, result, picture, problem: result || picture ? '' : 'It could not be fetched. It may have been deleted already.' } }))
  }
  const pickPicture = async file => {
    if (!file) { setTrying(now => ({ ...now, image: null })); return }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) { setTrying(now => ({ ...now, image: null, problem: 'Choose a PNG, JPEG or WebP picture of up to 10 MB.' })); return }
    const bytes = new Uint8Array(await file.arrayBuffer())
    setTrying(now => ({ ...now, image: { mimeType: file.type, bytes, name: file.name }, problem: '' }))
  }
  const runTry = async item => {
    const { sid, prompt, image } = trying
    setTrying(now => ({ ...now, running: true, problem: '', result: null }))
    let got
    try { got = await api.try({ sid, prompt, image: image ? { mimeType: image.mimeType, bytes: image.bytes } : null }) } catch { got = null }
    if (tried.current) { URL.revokeObjectURL(tried.current); tried.current = '' }
    if (got?.success) { tried.current = URL.createObjectURL(new Blob([got.bytes], { type: got.mimeType })) }
    setTrying(now => now?.sid !== sid ? now : { ...now, running: false, result: got?.success ? { url: tried.current, video: got.mimeType.startsWith('video/') } : null,
      problem: got?.success ? '' : got?.error || `The test could not be finished. ${item.name} only runs while its owner’s computer is on and free.` })
  }
  // Opening one: the copy its owner sent for this review, shown in the ComfyUI tab. Nothing runs.
  const openInComfy = async item => {
    setBusy(true); setError('')
    try {
      const got = await api.graph({ sid: item.sid })
      if (!got?.success) { setError(got?.error || 'The workflow could not be fetched.'); return }
      if (!got.matches) { setError('The copy that came back is not the version this review is for. Do not approve it; ask the owner to offer it again.'); return }
      const opened = await openApiWorkflowInComfyUi(got.workflow, { label: `Review: ${item.name}` })
      if (!opened?.success) setError(opened?.error || 'It could not be opened in the ComfyUI tab.')
    } catch { setError('The workflow could not be opened.') } finally { setBusy(false); setAsking(null) }
  }

  const load = useCallback(async () => {
    if (!api?.list) return
    try {
      const next = await api.list()
      if (!next?.success) { setError(next?.error || 'The review list could not be read.'); return }
      setData({ items: next.items || [], reports: next.reports || [] }); setError('')
      for (const item of next.items || []) {
        if (!item.hasExample || urls.current[item.sid]) continue
        urls.current[item.sid] = 'loading'
        api.example({ sid: item.sid }).then(got => {
          if (!got?.success) { delete urls.current[item.sid]; return }
          const url = URL.createObjectURL(new Blob([got.bytes], { type: 'image/jpeg' })); urls.current[item.sid] = url
          setExamples(all => ({ ...all, [item.sid]: url }))
        }, () => { delete urls.current[item.sid] })
      }
    } catch { setError('The review list could not be read.') }
  }, [api])
  useEffect(() => { void load() }, [load])
  useEffect(() => () => { for (const url of Object.values(urls.current)) if (url !== 'loading') URL.revokeObjectURL(url); if (tried.current) URL.revokeObjectURL(tried.current) }, [])

  if (!api?.list || !data) return error ? <section className={box} aria-label="Review"><h3 className={heading}>Review</h3><p className="text-xs text-sf-error">{error}</p></section> : null
  const act = async action => { if (busy) return; setBusy(true); setError('')
    try { const result = await action(); if (!result?.success) setError(result?.error || 'That could not be done.') } catch { setError('That could not be done.') }
    finally { setBusy(false); setAsking(null); await load() } }
  const waiting = data.items.filter(item => ['pending', 'paused'].includes(item.status)).length

  return <section className={box} aria-label="Review" data-testid="gpu-review">
    <div className="flex items-center justify-between gap-2"><h3 className={heading}>Review{waiting ? ` · ${waiting} waiting` : ''}</h3>
      <button type="button" className={button} disabled={busy} onClick={() => void load()}>Check again</button></div>
    <p className={quiet}>Only you see this. A workflow is open to every Velorn user once you approve it, in exactly the version you looked at. You can try it on its owner’s computer and open it in ComfyUI before you decide.</p>
    {data.items.length === 0 ? <p className={quiet}>Nothing has been sent for review yet.</p>
      : <ul className="flex flex-col gap-2 min-w-0">{data.items.map(item => <li key={item.sid} className="rounded-md bg-sf-dark-800 px-2.5 py-2 flex flex-col gap-2 min-w-0">
        <div className="flex gap-2.5 min-w-0">
          {examples[item.sid] && <img src={examples[item.sid]} alt={`Example made by ${item.name}`} className="h-20 w-20 flex-none rounded object-cover bg-sf-dark-950" />}
          <div className="min-w-0 flex-1 flex flex-col gap-0.5">
            <div className="flex items-baseline justify-between gap-2 min-w-0"><span className="text-sm font-medium break-words min-w-0">{item.name}</span>
              <span className="flex-none text-[11px] text-sf-text-muted">{STATUS[item.status]}</span></div>
            <p className={`${quiet} break-words`}>{SHAPE[item.shape]} · by {item.maker || 'A Velorn creator'}{item.email ? ` · ${item.email}` : ''}</p>
            {item.reports > 0 && <p className="text-xs text-sf-warning">{item.reports} {item.reports === 1 ? 'person' : 'people'} who used it reported it.</p>}
            {item.note && <p className={`${quiet} break-words`}>Note: {item.note}</p>}
            {!item.hasExample && <p className={quiet}>No example picture came with it.</p>}
          </div>
        </div>
        {open === item.sid && <div className="text-xs text-sf-text-secondary flex flex-col gap-1 break-words">
          <div><span className="text-sf-text-muted">Models:</span> {item.models.length ? item.models.join(', ') : 'none named'}</div>
          <div><span className="text-sf-text-muted">Parts:</span> {item.parts.join(', ')}</div>
        </div>}
        {trying?.sid === item.sid && <div className="rounded-md border border-sf-dark-700 p-2 flex flex-col gap-1.5 min-w-0" role="group" aria-label={`Try ${item.name}`}>
          <p className={quiet}>One test job runs on the owner’s computer, as it would for anyone. It only works while that computer is on and free.</p>
          <textarea rows={2} maxLength={2000} aria-label="Description for the test" disabled={trying.running} value={trying.prompt} onChange={event => setTrying(now => ({ ...now, prompt: event.target.value }))}
            className="min-w-0 rounded-md border border-sf-dark-600 bg-sf-dark-950 px-2 py-1 text-xs text-sf-text-primary placeholder:text-sf-text-muted focus:outline-none focus:border-sf-accent resize-y" />
          {item.needsImage && <label className="flex flex-col gap-1 text-xs min-w-0"><span className="text-sf-text-muted">It starts from a picture. Choose one:</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" disabled={trying.running} onChange={event => void pickPicture(event.target.files?.[0] || null)} className="text-xs text-sf-text-secondary" /></label>}
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" className={button} disabled={trying.running || !trying.prompt.trim() || (item.needsImage && !trying.image)} onClick={() => void runTry(item)}>{trying.result ? 'Run it again' : 'Run the test'}</button>
            {trying.running && <span className={quiet} role="status">Running on the owner’s computer. This can take a few minutes.</span>}
          </div>
          {trying.problem && <p className="text-xs text-sf-error break-words" role="status">{trying.problem}</p>}
          {trying.result && (trying.result.video ? <video src={trying.result.url} controls loop className="max-h-72 w-full rounded bg-sf-dark-950" aria-label="What the test made" />
            : <img src={trying.result.url} alt="What the test made" className="max-h-72 w-full rounded object-contain bg-sf-dark-950" />)}
        </div>}
        {asking?.id === item.sid ? <div className="flex flex-col gap-1.5 min-w-0">
          {asking.kind === 'decline' && <input type="text" className="min-w-0 rounded-md border border-sf-dark-600 bg-sf-dark-950 px-2 py-1 text-xs text-sf-text-primary placeholder:text-sf-text-muted focus:outline-none focus:border-sf-accent"
            maxLength={300} placeholder="Why? The owner sees this. (optional)" aria-label="Why it is declined" value={asking.note} onChange={event => setAsking(now => ({ ...now, note: event.target.value }))} />}
          {asking.kind === 'ban' && <p className="text-xs text-sf-warning">This account can then no longer send jobs or offer workflows. It can only be undone on the server.</p>}
          {asking.kind === 'open' && <p className="text-xs text-sf-text-secondary">This shows the workflow in the ComfyUI tab and replaces what is open there now. Nothing is run.</p>}
          <div className="flex items-center gap-1.5 flex-wrap">
            <button type="button" className={button} disabled={busy} onClick={() => asking.kind === 'open' ? void openInComfy(item) : void act(() => asking.kind === 'decline' ? api.decide({ sid: item.sid, approve: false, note: asking.note }) : api.ban({ sid: item.sid }))}>{asking.kind === 'decline' ? 'Decline it' : asking.kind === 'open' ? 'Open it' : 'Yes, stop this account'}</button>
            <button type="button" className={button} disabled={busy} onClick={() => setAsking(null)}>Cancel</button>
          </div>
        </div> : <div className="flex items-center gap-1.5 flex-wrap">
          {item.status !== 'approved' && <button type="button" className={button} disabled={busy} onClick={() => void act(() => api.decide({ sid: item.sid, approve: true }))}>Approve</button>}
          {item.status !== 'declined' && <button type="button" className={button} disabled={busy} onClick={() => setAsking({ kind: 'decline', id: item.sid, note: '' })}>{item.status === 'approved' ? 'Take it down' : 'Decline'}</button>}
          <button type="button" className={button} disabled={busy || trying?.running} onClick={() => setTrying(trying?.sid === item.sid ? null : { sid: item.sid, prompt: 'A red apple on a wooden table, soft morning light.', image: null, running: false, result: null, problem: '' })}>{trying?.sid === item.sid ? 'Close the test' : 'Try it'}</button>
          {item.hasGraph && <button type="button" className={button} disabled={busy} onClick={() => setAsking({ kind: 'open', id: item.sid, note: '' })}>Open in ComfyUI</button>}
          <button type="button" className={button} onClick={() => setOpen(open === item.sid ? '' : item.sid)}>{open === item.sid ? 'Hide what it uses' : 'What it uses'}</button>
          <button type="button" className={button} disabled={busy} onClick={() => setAsking({ kind: 'ban', id: item.sid, note: '' })}>Stop this account</button>
        </div>}
      </li>)}</ul>}

    {data.reports.length > 0 && <>
      <h3 className={`${heading} mt-2`}>Jobs that hosts reported</h3>
      <ul className="flex flex-col gap-2 min-w-0">{data.reports.map(report => <li key={report.jobId} className="rounded-md bg-sf-dark-800 px-2.5 py-2 flex flex-col gap-1.5 min-w-0">
        <div className="flex items-baseline justify-between gap-2 min-w-0"><span className="text-xs font-medium break-all min-w-0">{report.email || 'Unknown sender'}</span>
          <span className="flex-none text-[11px] text-sf-text-muted">{report.reason}</span></div>
        <p className="text-xs text-sf-text-secondary break-words">“{report.prompt}”</p>
        <p className="text-[11px] text-sf-text-muted break-all">{report.address ? `Sent from ${report.address}` : 'Address not recorded'}</p>
        {report.others?.length > 0 && <p className="text-[11px] text-sf-warning break-words">Same address also used by: {report.others.join(', ')}</p>}
        <p className="text-[11px] text-sf-text-muted break-words">Reported by {report.reporter || 'an owner without a verified email'}
          {report.reporterReports > 1 ? ` · ${report.reporterReports} reports so far, ${report.reporterDismissed} dismissed` : ' · their first report'}</p>
        {sent[report.jobId]?.result && (sent[report.jobId].result.video
          ? <video src={sent[report.jobId].result.url} controls className="max-h-72 w-full rounded-md bg-black" aria-label="What the job made" />
          : <img src={sent[report.jobId].result.url} alt="What the job made" className="max-h-72 w-full rounded-md object-contain bg-black" />)}
        {sent[report.jobId]?.picture && <div className="flex flex-col gap-1"><span className="text-[11px] text-sf-text-muted">The picture they sent in:</span>
          <img src={sent[report.jobId].picture.url} alt="The picture the job started from" className="max-h-40 w-full rounded-md object-contain bg-black" /></div>}
        {sent[report.jobId]?.problem && <p className="text-[11px] text-sf-warning">{sent[report.jobId].problem}</p>}
        {!report.result && !report.picture && <p className="text-[11px] text-sf-text-muted">{Date.now() - report.at < 10 * 60_000
          ? 'The result is still on its way from the owner’s computer. A clip can take a minute. Press “Check again” at the top.'
          : 'The owner’s computer sent no result with this report, so there is only the description to go by.'}</p>}
        {asking?.id === report.jobId ? <div className="flex items-center gap-1.5 flex-wrap">
          <button type="button" className={button} disabled={busy} onClick={() => void act(() => api.ban({ jobId: report.jobId, ...(asking.kind === 'ban-reporter' ? { reporter: true } : {}) }))}>
            {asking.kind === 'ban-reporter' ? 'Yes, stop the owner who reported it' : report.address ? 'Yes, stop this account and its address' : 'Yes, stop this account'}</button>
          <button type="button" className={button} disabled={busy} onClick={() => setAsking(null)}>Cancel</button>
        </div> : <div className="flex items-center gap-1.5 flex-wrap">
          {(report.result || report.picture) && !sent[report.jobId]?.result && !sent[report.jobId]?.picture
            && <button type="button" className={button} disabled={busy || sent[report.jobId]?.loading} onClick={() => void showSent(report)}>{sent[report.jobId]?.loading ? 'Fetching…' : 'Show the result'}</button>}
          <button type="button" className={button} disabled={busy} title="The sender broke the rules. Stops their account and the addresses they sent from." onClick={() => setAsking({ kind: 'ban-job', id: report.jobId, note: '' })}>Stop the sender</button>
          <button type="button" className={button} disabled={busy} title="Nothing wrong here. Takes it off this list and stops nobody." onClick={() => void act(() => api.dismiss({ jobId: report.jobId }))}>Dismiss</button>
          <button type="button" className={button} disabled={busy} title="The report was made without cause. Stops the owner who reported it." onClick={() => setAsking({ kind: 'ban-reporter', id: report.jobId, note: '' })}>Stop this owner</button>
        </div>}
        <p className="text-[11px] text-sf-text-muted">Whatever you decide, the files sent with this report are deleted at once.</p>
      </li>)}</ul></>}
    {error && <p className="text-xs text-sf-error break-words" role="status">{error}</p>}
  </section>
}
