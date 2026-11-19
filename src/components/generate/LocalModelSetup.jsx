import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Download, FolderSearch, RotateCw } from 'lucide-react'
import { checkLocalComfyConnection } from '../../services/localComfyConnection'
import { checkWorkflowDependencies } from '../../services/workflowDependencies'
import { useWorkflowSetupFlow } from '../../hooks/useWorkflowSetupFlow'

// Gets a local model onto this computer from inside the Director: it checks
// what is missing, shows the size, and downloads on one click. It draws nothing
// when the model is ready. The same check, download and restart as the Sound
// tab's model card (SoundModelSetup.jsx), in the Director's own look.
// Mount with key={workflowId} so each model starts from a clean check.
export const formatDownloadSize = (bytes) => {
  const gb = Number(bytes) / 1e9
  return gb >= 10 ? `${Math.round(gb)} GB` : gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(Number(bytes) / 1e6))} MB`
}

const CARD = 'rounded-lg border border-sf-accent/30 bg-sf-accent/5 p-4 text-xs leading-5 text-sf-text-secondary'
const TITLE = 'text-sm font-semibold text-sf-text-primary'
const GO = 'inline-flex items-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-45'
const LINE = 'rounded-lg border border-sf-dark-600 px-3 py-2 text-xs font-semibold text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary'
const ALERT = 'mt-2 flex items-start gap-2 text-amber-200'

export default function LocalModelSetup({ workflowId, name, about = '', terms = null, onReady }) {
  const [connected, setConnected] = useState(null) // null while checking
  const [check, setCheck] = useState({ status: 'idle', hasPack: true, hasBlockingIssues: false })
  const [justInstalled, setJustInstalled] = useState(false)
  const alive = useRef(true)
  const request = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const recheck = useCallback(async () => {
    const mine = ++request.current
    setCheck({ status: 'checking', hasPack: true, hasBlockingIssues: false })
    const connection = await checkLocalComfyConnection().catch(() => null)
    const result = connection?.ok ? await checkWorkflowDependencies(workflowId).catch(() => null) : null
    if (alive.current && mine === request.current) {
      setConnected(Boolean(connection?.ok))
      setCheck(result || { status: 'error', hasPack: true, hasBlockingIssues: true })
    }
    return result
  }, [workflowId])
  useEffect(() => { recheck() }, [recheck])

  const flow = useWorkflowSetupFlow({ dependencyCheck: check, isConnected: connected === true, recheck })
  const checking = connected === null || ['idle', 'checking'].includes(check.status)
  const ready = connected === true && ['ready', 'partial'].includes(check.status) && !check.hasBlockingIssues
  const installing = flow.mode === 'installing' || flow.mode === 'restarting'
  useEffect(() => { onReady?.(checking ? null : ready && !installing) }, [checking, ready, installing, onReady])
  useEffect(() => { if (installing) setJustInstalled(true) }, [installing])

  const again = <button type="button" className={LINE} onClick={recheck}>Check again</button>
  const problem = flow.error && (
    <p className={ALERT} role="alert"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{flow.error}</p>
  )

  // Stay out of the way while the first check runs and when everything is there.
  if (checking && !installing) return null

  if (installing) {
    const percent = Math.max(0, Math.min(100, Math.round(flow.progress.overallPercent || 0)))
    const done = flow.progress.bytesDownloaded
    const total = flow.progress.totalBytes || flow.totalDownloadBytes
    const restarting = flow.mode === 'restarting'
    return (
      <section className={CARD} aria-label={`Downloading ${name}`}>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className={TITLE}>{restarting ? 'Restarting ComfyUI to load it' : `Downloading ${name}`}</h3>
          {!restarting && <span className="font-semibold text-sf-text-primary">{percent}%</span>}
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sf-dark-800" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Download progress">
          <div className="h-full rounded-full bg-sf-accent transition-all" style={{ width: `${restarting ? 100 : percent}%` }} />
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span>{flow.progress.currentLabel ? `Now: ${flow.progress.currentLabel}` : restarting ? 'This usually takes under a minute.' : 'Starting…'}</span>
          {total > 0 && !restarting && <span>{done > 0 ? `${formatDownloadSize(done)} of ${formatDownloadSize(total)}` : formatDownloadSize(total)}</span>}
        </div>
        <p className="mt-2 text-sf-text-muted">You can keep working. Keep Velorn open until it finishes: a download that is interrupted starts that file again.</p>
      </section>
    )
  }

  if (ready) {
    return justInstalled
      ? <p className="flex items-center gap-2 text-xs text-emerald-300" role="status"><Check aria-hidden="true" className="h-4 w-4" />{name} is installed and ready.</p>
      : null
  }

  if (connected === false) {
    return (
      <section className={CARD} role="status">
        <h3 className={TITLE}>ComfyUI isn't running</h3>
        <p className="mt-1">{name} runs in ComfyUI on your computer. Start ComfyUI from the menu at the top right of Velorn, then check again.</p>
        <div className="mt-3 flex flex-wrap gap-2">{again}</div>
      </section>
    )
  }

  if (flow.mode === 'needs-restart') {
    return (
      <section className={CARD} role="status">
        <h3 className={TITLE}>{name} is downloaded</h3>
        <p className="mt-1">ComfyUI needs a restart to load it. Anything ComfyUI is making right now will stop.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={GO} onClick={flow.restartNow}><RotateCw aria-hidden="true" className="h-4 w-4" />Restart ComfyUI</button>
          {again}
        </div>
        {problem}
      </section>
    )
  }

  if (flow.mode === 'choose-root') {
    return (
      <section className={CARD} role="status">
        <h3 className={TITLE}>Where is your ComfyUI folder?</h3>
        <p className="mt-1">{name} isn't on this computer yet. Velorn needs to know where ComfyUI lives so the download goes to the right place.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={GO} onClick={flow.chooseComfyFolder}><FolderSearch aria-hidden="true" className="h-4 w-4" />Choose ComfyUI folder</button>
        </div>
        {problem}
      </section>
    )
  }

  if (flow.mode === 'setup') {
    const free = Number.isFinite(flow.diskSpace?.freeBytes) ? flow.diskSpace.freeBytes : null
    const files = flow.items.filter((item) => item.kind === 'model').length || flow.items.length
    const places = flow.diskSpace?.destinations || []
    const missingFolder = places.find((item) => item.available === false)
    const size = flow.totalDownloadBytes > 0 ? `${formatDownloadSize(flow.totalDownloadBytes)}${flow.unknownSizeCount > 0 ? ' or more' : ''}` : ''
    return (
      <section className={CARD} aria-label={`Get ${name}`}>
        <h3 className={TITLE}>{name} isn't on this computer yet</h3>
        <p className="mt-1">{about} Download it once and it is free to use from then on.</p>
        <p className="mt-2 text-sf-text-muted">
          {size ? `${size} in ${files} ${files === 1 ? 'file' : 'files'}.` : `${files} ${files === 1 ? 'file' : 'files'}.`}
          {free !== null && ` ${formatDownloadSize(free)} free on this disk.`}
          {' '}{places.length ? `The files go to ${places.map((item) => item.folder).join(' and ')}.` : 'The files go into your ComfyUI folder.'}
        </p>
        {terms && (
          <p className="mt-2 text-sf-text-muted">
            {terms.text}{' '}
            <a className="text-sf-accent underline" href={terms.url} target="_blank" rel="noreferrer">{terms.label}</a>
          </p>
        )}
        {flow.insufficientDiskSpace && <p className={ALERT} role="alert"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />There isn't enough free space for this download. Free up some room on the disk your ComfyUI folder is on, then check again.</p>}
        {missingFolder && <p className={ALERT} role="alert"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />Your extra_model_paths.yaml points at {missingFolder.folder}, but that folder isn't there right now. Connect that drive or fix the path, then check again.</p>}
        {problem}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={GO} disabled={flow.insufficientDiskSpace || Boolean(missingFolder)} onClick={flow.startSetup}>
            <Download aria-hidden="true" className="h-4 w-4" />Download{size ? ` ${size}` : ''}
          </button>
          {(flow.insufficientDiskSpace || missingFolder) && again}
        </div>
      </section>
    )
  }

  // The check found something a download cannot fix.
  return (
    <section className={CARD} role="status">
      <h3 className={TITLE}>{name} can't run here yet</h3>
      <p className="mt-1">
        {check.missingNodes?.length ? 'Your ComfyUI is missing parts this model needs. Update ComfyUI to its latest version, then check again.'
          : check.status === 'error' ? 'Velorn could not check this model. Make sure ComfyUI has finished starting, then check again.'
            : 'This model needs a step Velorn cannot do for you yet.'}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">{again}</div>
    </section>
  )
}
