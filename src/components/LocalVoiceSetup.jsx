import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Download, Loader2 } from 'lucide-react'
import { installLocalVoice, localVoiceAvailable, localVoiceStatus } from '../services/localVoice'

// Getting the built-in voice model onto this computer: one download, kept in
// Velorn's own data folder, no ComfyUI. Looks like the other local model panel
// and reports `ready` the same way so the Generate button can wait for it.
const megabytes = bytes => `${Math.max(1, Math.round(Number(bytes) / 1e6))} MB`

export default function LocalVoiceSetup({ model, onReady, onUseCloud }) {
  const [state, setState] = useState({ phase: 'checking' })
  const [progress, setProgress] = useState(null)
  const [justInstalled, setJustInstalled] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const check = useCallback(async () => {
    if (!localVoiceAvailable()) { setState({ phase: 'unavailable' }); return }
    const status = await localVoiceStatus().catch(() => null)
    if (!alive.current) return
    setState(!status?.success ? { phase: 'error', error: status?.error } : status.installed ? { phase: 'ready', status } : { phase: status.installing ? 'installing' : 'setup', status })
  }, [])
  useEffect(() => { check() }, [check])
  useEffect(() => { onReady?.(state.phase === 'checking' ? null : state.phase === 'ready') }, [state.phase, onReady])

  const start = async () => {
    setState(current => ({ ...current, phase: 'installing', error: '' })); setProgress(null)
    const result = await installLocalVoice(value => { if (alive.current) setProgress(value) })
    if (!alive.current) return
    if (result?.installed) { setJustInstalled(true); setState({ phase: 'ready', status: result }) }
    else setState({ phase: 'setup', status: result, error: result?.error || 'The download did not finish. Check your internet connection and try again.' })
  }

  const cloud = onUseCloud && <button type="button" className="vc-line" onClick={onUseCloud}>Use Cloud instead</button>
  if (state.phase === 'checking') return <p className="vc-setup-line" role="status"><Loader2 aria-hidden="true" size={16} className="vc-spin" />Checking whether {model.name} is on this computer…</p>
  if (state.phase === 'ready') return justInstalled ? <p className="vc-setup-line vc-setup-ok" role="status"><Check aria-hidden="true" size={17} />{model.name} is downloaded. Voices you make here are free from now on.</p> : null
  if (state.phase === 'unavailable' || state.phase === 'error') return <section className="vc-setup" role="status">
    <h2>{model.name} can't run here</h2>
    <p>{state.phase === 'unavailable' ? 'Local voices need the Velorn desktop app.' : state.error || 'Velorn could not check the voice model. Restart Velorn and try again.'}</p>
    <div className="vc-row">{state.phase === 'error' && <button type="button" className="vc-line" onClick={check}>Check again</button>}{cloud}</div>
  </section>

  const total = state.status?.totalBytes || 0, have = state.status?.doneBytes || 0
  if (state.phase === 'installing') {
    const done = progress?.doneBytes ?? have, percent = total > 0 ? Math.max(0, Math.min(100, Math.round(done / total * 100))) : 0
    return <section className="vc-setup" aria-label={`Downloading ${model.name}`}>
      <div className="vc-row vc-between" style={{ alignItems: 'baseline' }}><h2>Downloading {model.name}</h2><span className="vc-setup-percent">{percent}%</span></div>
      <div className="vc-setup-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Download progress"><span style={{ width: `${percent}%` }} /></div>
      <div className="vc-row vc-between vc-setup-facts"><span>Each file is checked as it arrives.</span><span>{megabytes(done)} of {megabytes(total)}</span></div>
      <p>You can keep working, and Cloud still works while this runs. Keep Velorn open until it finishes.</p>
    </section>
  }
  return <section className="vc-setup" aria-label={`Get ${model.name}`}>
    <div className="vc-setup-head"><span aria-hidden="true"><Download size={22} /></span>
      <div><h2>{model.name} isn't on this computer yet</h2>
        <p>{model.about} Download it once and everything after that is free, works offline, and never leaves this machine.</p></div>
    </div>
    <div className="vc-setup-grid">
      <div><span>Download size</span><b>{megabytes(Math.max(0, total - have))}</b></div>
      <div><span>Needs</span><b>No ComfyUI, no graphics card</b></div>
      <div><span>Voices</span><b>{model.voices.length} English</b></div>
    </div>
    <p className="vc-setup-terms">Kokoro is open source under the Apache 2.0 licence. What you make with it is yours to use.</p>
    {state.error && <p className="vc-alert" role="alert"><AlertTriangle aria-hidden="true" size={17} />{state.error}</p>}
    <div className="vc-row vc-between">
      <span className="vc-setup-small">It is kept in Velorn's own data folder. Nothing is downloaded until you press the button.</span>
      <div className="vc-row">{cloud}<button type="button" className="vc-go" onClick={start}><Download aria-hidden="true" size={16} />Download {megabytes(Math.max(0, total - have))}</button></div>
    </div>
  </section>
}
