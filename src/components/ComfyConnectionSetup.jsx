import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, Search } from 'lucide-react'
import { useI18n } from '../i18n/I18nContext'
import { discoverRunningComfy, connectRunningComfy } from '../services/comfyConnectionSetup.mjs'
import { getLocalComfyConnectionSync, hydrateLocalComfyConnection, COMFY_CONNECTION_CHANGED_EVENT } from '../services/localComfyConnection'
import { refreshComfyLauncher } from '../services/comfyLauncher'

export default function ComfyConnectionSetup({ compact = false }) {
  const { t } = useI18n()
  const label = (key, fallback, variables = {}) => t(`settings.comfySetup.${key}`, variables, fallback)
  const [port, setPort] = useState(() => String(getLocalComfyConnectionSync().port))
  const [connections, setConnections] = useState([])
  const [searched, setSearched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(null)
  const alive = useRef(true), locked = useRef(false), edited = useRef(false)
  useEffect(() => {
    alive.current = true
    hydrateLocalComfyConnection().then(config => { if (alive.current && !edited.current) setPort(String(config.port)) })
    const changed = () => { setConnected(null); setPort(String(getLocalComfyConnectionSync().port)) }
    window.addEventListener(COMFY_CONNECTION_CHANGED_EVENT, changed)
    return () => { alive.current = false; window.removeEventListener(COMFY_CONNECTION_CHANGED_EVENT, changed) }
  }, [])

  const run = async action => {
    if (locked.current) return
    locked.current = true; setBusy(true); setError(''); setConnected(null)
    try { await action() }
    catch (failure) { if (alive.current) setError(failure?.message || label('failed', 'Could not connect. Please try again.')) }
    finally { locked.current = false; if (alive.current) setBusy(false) }
  }
  const find = () => run(async () => {
    const result = await discoverRunningComfy()
    if (!alive.current) return
    setConnections(result.connections || []); setSearched(true)
    if (!result.success) setError(result.error || label('failed', 'Could not connect. Please try again.'))
  })
  const connect = input => run(async () => {
    const result = await connectRunningComfy(input)
    if (!alive.current) return
    if (!result.success) { setError(result.error); return }
    setConnected(result.connection); setPort(String(result.config.port))
    // Refresh optional launcher controls after the saved connection has changed.
    // This never starts/stops a process. Unconfigured installations stay external.
    void refreshComfyLauncher().catch(() => {})
  })
  const button = 'inline-flex items-center justify-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed'
  return (
    <section aria-label="Connect ComfyUI" className={`rounded-lg border border-sf-dark-600 bg-sf-dark-900/60 ${compact ? 'p-3' : 'p-4'} space-y-3`}>
      <div>
        <h3 className="text-sm font-semibold text-sf-text-primary">{label('title', 'Connect ComfyUI')}</h3>
        <p className="mt-1 text-xs leading-relaxed text-sf-text-secondary">
          {label('openHelp', 'Open ComfyUI on this computer, then find it here. In Comfy Desktop, start the local instance you want to use. No launcher script is required.')}
        </p>
      </div>
      <button type="button" disabled={busy} onClick={find} className={`${button} bg-sf-accent hover:bg-sf-accent-hover text-white`}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
        {label('find', 'Find running ComfyUI')}
      </button>
      {connections.length > 0 && <div className="space-y-2">
        <p className="text-[11px] text-sf-text-muted">{label('choose', 'Choose the local connection to use. Finding it does not change your settings.')}</p>
        {connections.map(candidate => <div key={candidate.port} className="flex items-center gap-2 rounded border border-sf-dark-700 px-2.5 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-sf-text-primary break-all">{candidate.httpBase}</div>
            <div className="mt-0.5 text-[11px] text-sf-text-muted break-words">{candidate.deviceNames?.join(', ') || label('ready', 'ComfyUI is ready')}</div>
          </div>
          <button type="button" disabled={busy} aria-label={`Connect to ComfyUI on port ${candidate.port}`} onClick={() => connect(candidate.port)} className={`${button} bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-primary`}>
            {label('connect', 'Connect')}
          </button>
        </div>)}
      </div>}
      {searched && !connections.length && !error && <p role="status" className="text-xs text-sf-text-secondary">
        {label('notFound', 'No running ComfyUI found on the usual local ports. Open ComfyUI, finish its setup, start a local instance, then try again. If it uses another port, enter it below.')}
      </p>}
      <details>
        <summary className="cursor-pointer text-xs text-sf-text-muted hover:text-sf-text-primary">{label('manual', 'Enter a port manually')}</summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="text-[11px] text-sf-text-muted">{label('port', 'ComfyUI port')}
            <input aria-label="ComfyUI port" type="number" min="1" max="65535" step="1" value={port} disabled={busy}
              onChange={event => { edited.current = true; setPort(event.target.value); setConnected(null); setError('') }}
              className="block mt-1 w-28 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-xs text-sf-text-primary" />
          </label>
          <button type="button" disabled={busy || !port.trim()} onClick={() => connect(port)} className={`${button} bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-primary`}>{label('testConnect', 'Test and connect')}</button>
        </div>
      </details>
      {error && <p role="alert" className="text-xs text-red-300 break-words">{error}</p>}
      {connected && <p role="status" className="flex items-start gap-1.5 text-xs text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        {label('connected', 'Connected to ComfyUI on port {{port}}.', { port: connected.port })}
      </p>}
      {!compact && <p className="text-[11px] text-sf-text-muted">{label('localOnly', 'Local connection only. This does not install anything, launch ComfyUI, or generate media. Your editor works without ComfyUI.')}</p>}
    </section>
  )
}
