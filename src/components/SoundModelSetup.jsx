import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Download, FolderSearch, Loader2, RotateCw } from 'lucide-react'
import { checkLocalComfyConnection } from '../services/localComfyConnection'
import { checkWorkflowDependencies } from '../services/workflowDependencies'
import { useWorkflowSetupFlow } from '../hooks/useWorkflowSetupFlow'

// Getting a local model onto this computer, shown in the Sound tab where the
// starting ideas would be. It is the same check, download and restart that the
// timeline's Music button uses, said in plain words. It reports `ready` so the
// Generate button can wait for it. Mount with key={model.id}: each model starts
// from a clean check.
const gigabytes = bytes => {
  const gb = Number(bytes) / 1e9
  return gb >= 10 ? `${Math.round(gb)} GB` : gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(Number(bytes) / 1e6))} MB`
}

export default function SoundModelSetup({ model, what, onReady, onUseCloud }) {
  const [connected, setConnected] = useState(null) // null while checking
  const [check, setCheck] = useState({ status: 'idle', hasPack: true, hasBlockingIssues: false })
  const [justInstalled, setJustInstalled] = useState(false)
  const alive = useRef(true), request = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const recheck = useCallback(async () => {
    const mine = ++request.current
    setCheck({ status: 'checking', hasPack: true, hasBlockingIssues: false })
    const connection = await checkLocalComfyConnection().catch(() => null)
    const result = connection?.ok ? await checkWorkflowDependencies(model.workflowId).catch(() => null) : null
    if (alive.current && mine === request.current) {
      setConnected(Boolean(connection?.ok))
      setCheck(result || { status: 'error', hasPack: true, hasBlockingIssues: true })
    }
    return result
  }, [model.workflowId])
  useEffect(() => { recheck() }, [recheck])

  const flow = useWorkflowSetupFlow({ dependencyCheck: check, isConnected: connected === true, recheck })
  const checking = connected === null || ['idle', 'checking'].includes(check.status)
  const ready = connected === true && ['ready', 'partial'].includes(check.status) && !check.hasBlockingIssues
  const installing = flow.mode === 'installing' || flow.mode === 'restarting'
  useEffect(() => { onReady?.(checking ? null : ready && !installing) }, [checking, ready, installing, onReady])
  useEffect(() => { if (installing) setJustInstalled(true) }, [installing])

  const cloud = onUseCloud && <button type="button" className="vc-line" onClick={onUseCloud}>Use Cloud instead</button>
  const again = <button type="button" className="vc-line" onClick={recheck}>Check again</button>

  if (checking && !installing) return <p className="vc-setup-line" role="status"><Loader2 aria-hidden="true" size={16} className="vc-spin" />Checking whether {model.name} is on this computer…</p>

  if (installing) {
    const percent = Math.max(0, Math.min(100, Math.round(flow.progress.overallPercent || 0)))
    const done = flow.progress.bytesDownloaded, total = flow.progress.totalBytes || flow.totalDownloadBytes
    return <section className="vc-setup" aria-label={`Downloading ${model.name}`}>
      <div className="vc-row vc-between" style={{ alignItems: 'baseline' }}>
        <h2>{flow.mode === 'restarting' ? 'Restarting ComfyUI to load it' : `Downloading ${model.name}`}</h2>
        {flow.mode !== 'restarting' && <span className="vc-setup-percent">{percent}%</span>}
      </div>
      <div className="vc-setup-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Download progress"><span style={{ width: `${flow.mode === 'restarting' ? 100 : percent}%` }} /></div>
      <div className="vc-row vc-between vc-setup-facts">
        <span>{flow.progress.currentLabel ? `Now: ${flow.progress.currentLabel}` : flow.mode === 'restarting' ? 'This usually takes under a minute.' : 'Starting…'}</span>
        {total > 0 && flow.mode !== 'restarting' && <span>{done > 0 ? `${gigabytes(done)} of ${gigabytes(total)}` : gigabytes(total)}</span>}
      </div>
      <p>You can keep working, and Cloud still works while this runs. Keep Velorn open until it finishes.</p>
    </section>
  }

  if (ready) return justInstalled ? <p className="vc-setup-line vc-setup-ok" role="status"><Check aria-hidden="true" size={17} />{model.name} is installed and loaded. {what} you make here are free from now on.</p> : null

  if (connected === false) return <section className="vc-setup" role="status">
    <h2>ComfyUI isn't running</h2>
    <p>Local models run in ComfyUI, a free program on your computer. Start it from the ComfyUI menu at the top right of Velorn, then check again. If you have never set it up, open the ComfyUI tab to get started.</p>
    <div className="vc-row">{again}{cloud}</div>
  </section>

  if (flow.mode === 'needs-restart') return <section className="vc-setup" role="status">
    <h2>{model.name} is downloaded</h2>
    <p>ComfyUI needs a restart to load it. Anything ComfyUI is making right now will stop.</p>
    <div className="vc-row"><button type="button" className="vc-go" onClick={flow.restartNow}><RotateCw aria-hidden="true" size={16} />Restart ComfyUI</button>{again}</div>
    {flow.error && <p className="vc-alert" role="alert"><AlertTriangle aria-hidden="true" size={17} />{flow.error}</p>}
  </section>

  if (flow.mode === 'choose-root') return <section className="vc-setup" role="status">
    <h2>Where is your ComfyUI folder?</h2>
    <p>{model.name} isn't on this computer yet. Velorn needs to know where ComfyUI lives so the download goes to the right place.</p>
    <div className="vc-row"><button type="button" className="vc-go" onClick={flow.chooseComfyFolder}><FolderSearch aria-hidden="true" size={16} />Choose ComfyUI folder</button>{cloud}</div>
    {flow.error && <p className="vc-alert" role="alert"><AlertTriangle aria-hidden="true" size={17} />{flow.error}</p>}
  </section>

  if (flow.mode === 'setup') {
    const free = Number.isFinite(flow.diskSpace?.freeBytes) ? flow.diskSpace.freeBytes : null
    const files = flow.items.filter(item => item.kind === 'model').length
    const places = flow.diskSpace?.destinations || []
    const central = places.some(item => item.source !== 'comfyui')
    const missing = places.find(item => item.available === false)
    return <section className="vc-setup" aria-label={`Get ${model.name}`}>
      <div className="vc-setup-head"><span aria-hidden="true"><Download size={22} /></span>
        <div><h2>{model.name} isn't on this computer yet</h2>
          <p>{model.about || `It makes ${what.toLowerCase()} on your own computer.`} Download it once and everything after that is free, works offline, and never leaves this machine.</p></div>
      </div>
      <div className="vc-setup-grid">
        <div><span>Download size</span><b>{flow.totalDownloadBytes > 0 ? `${gigabytes(flow.totalDownloadBytes)}${flow.unknownSizeCount > 0 ? ' or more' : ''}` : 'Not known'}</b></div>
        <div><span>Free space here</span><b>{free === null ? 'Not checked' : gigabytes(free)}</b></div>
        <div><span>Files to download</span><b>{files || flow.items.length}</b></div>
      </div>
      {model.terms && <p className="vc-setup-terms">{model.terms.text}{model.terms.links.map(link => <span key={link.url}> <a href={link.url} target="_blank" rel="noreferrer">{link.label}</a></span>)}</p>}
      {flow.insufficientDiskSpace && <p className="vc-alert" role="alert"><AlertTriangle aria-hidden="true" size={17} />There isn't enough free space for this download. Free up some room on the disk your ComfyUI folder is on, then check again.</p>}
      {missing && <p className="vc-alert" role="alert"><AlertTriangle aria-hidden="true" size={17} />Your extra_model_paths.yaml points at {missing.folder}, but that folder isn't there right now. Connect that drive or fix the path, then check again.</p>}
      {flow.error && <p className="vc-alert" role="alert"><AlertTriangle aria-hidden="true" size={17} />{flow.error}</p>}
      <div className="vc-row vc-between">
        <span className="vc-setup-small">{places.length
          ? <>{central ? 'Following your extra_model_paths.yaml, the files go to ' : 'The files go to '}{places.map((item, index) => <span key={item.folder}>{index ? ' and ' : ''}<code>{item.folder}</code></span>)}.</>
          : 'The files go into your ComfyUI folder.'} Nothing is downloaded until you press the button.</span>
        <div className="vc-row">{flow.insufficientDiskSpace || missing ? again : null}{cloud}
          <button type="button" className="vc-go" disabled={flow.insufficientDiskSpace || Boolean(missing)} onClick={flow.startSetup}><Download aria-hidden="true" size={16} />Download{flow.totalDownloadBytes > 0 ? ` ${gigabytes(flow.totalDownloadBytes)}` : ''}</button></div>
      </div>
    </section>
  }

  // The check found something Velorn cannot fix by downloading.
  return <section className="vc-setup" role="status">
    <h2>{model.name} can't run here yet</h2>
    <p>{check.missingNodes?.length ? 'Your ComfyUI is missing parts this model needs. Update ComfyUI to its latest version, then check again.'
      : check.status === 'error' ? 'Velorn could not check this model. Make sure ComfyUI has finished starting, then check again.'
        : 'This model needs a step Velorn cannot do for you yet.'}</p>
    <div className="vc-row">{again}{cloud}</div>
  </section>
}
