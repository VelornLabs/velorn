import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  FileText,
  FolderOpen,
  FolderSearch,
  Info,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  StopCircle,
} from 'lucide-react'

import {
  detectComfyLauncherCandidates,
  getComfyLauncherConfig,
  getComfyLauncherSnapshot,
  isComfyLauncherAvailable,
  openComfyLauncherLogFile,
  pickComfyLauncherMacApp,
  pickComfyLauncherScript,
  refreshComfyLauncher,
  restartComfyLauncher,
  startComfyLauncher,
  stopComfyLauncher,
  subscribeComfyLauncherState,
  updateComfyLauncherConfig,
} from '../services/comfyLauncher'

const STATE_LABEL = {
  unknown: { label: 'Unknown', dot: 'bg-slate-400' },
  idle: { label: 'Offline', dot: 'bg-slate-400' },
  starting: { label: 'Starting…', dot: 'bg-amber-400 animate-pulse' },
  running: { label: 'Running', dot: 'bg-emerald-400' },
  external: { label: 'External', dot: 'bg-sky-400' },
  stopping: { label: 'Stopping…', dot: 'bg-amber-400 animate-pulse' },
  stopped: { label: 'Stopped', dot: 'bg-slate-400' },
  crashed: { label: 'Crashed', dot: 'bg-red-500' },
}

function Toggle({ checked, onChange, ariaLabel }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-label={ariaLabel}
      className={`w-10 h-5 rounded-full transition-colors flex-shrink-0 ${checked ? 'bg-sf-accent' : 'bg-sf-dark-600'}`}
    >
      <div className={`w-4 h-4 bg-white rounded-full transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  )
}

function ComfyLauncherSettingsSection({ onOpenLogViewer }) {
  const available = isComfyLauncherAvailable()
  const [state, setState] = useState(() => getComfyLauncherSnapshot())
  const [config, setConfig] = useState(() => getComfyLauncherConfig())
  const [candidates, setCandidates] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!available) return undefined
    const unsub = subscribeComfyLauncherState((next) => setState(next))
    return unsub
  }, [available])

  useEffect(() => {
    if (!available) return
    detectComfyLauncherCandidates({}).then((result) => {
      if (result?.success) setCandidates(result.candidates || [])
    }).catch(() => {})
    refreshComfyLauncher().catch(() => {})
    if (window?.electronAPI?.comfyLauncher?.getConfig) {
      window.electronAPI.comfyLauncher.getConfig().then((cfg) => {
        if (cfg) setConfig(cfg)
      }).catch(() => {})
    }
  }, [available])

  const stateMeta = STATE_LABEL[state.state] || STATE_LABEL.unknown
  const isMacPlatform = window?.electronAPI?.platform === 'darwin'
  const launcherMode = config.launcherMode === 'mac-app' ? 'mac-app' : 'script'

  const updateConfig = useCallback(async (partial) => {
    setError('')
    const next = { ...config, ...partial }
    setConfig(next)
    const result = await updateComfyLauncherConfig(partial)
    if (result?.success === false) {
      setError(result.error || 'Failed to save launcher settings.')
    } else if (result?.config) {
      setConfig(result.config)
    }
  }, [config])

  const wrap = useCallback(async (action) => {
    setBusy(true)
    setError('')
    try {
      const result = await action()
      if (result && result.success === false) setError(result.error || 'Action failed.')
    } catch (err) {
      setError(err?.message || 'Action failed.')
    } finally {
      setBusy(false)
    }
  }, [])

  const handlePickScript = async () => {
    const result = await pickComfyLauncherScript()
    if (result?.success && result.filePath) {
      setConfig((prev) => ({ ...prev, launcherMode: 'script', launcherScript: result.filePath }))
    }
  }

  const handlePickMacApp = async () => {
    const result = await pickComfyLauncherMacApp()
    if (result?.success && result.filePath) {
      setConfig((prev) => ({ ...prev, launcherMode: 'mac-app', macAppPath: result.filePath }))
    }
  }

  const handleUseCandidate = async (candidate) => {
    if (!candidate?.path) return
    await updateConfig({ launcherMode: 'script', launcherScript: candidate.path })
  }

  const startupTimeoutSeconds = useMemo(() => Math.max(10, Math.round((config.startupTimeoutMs || 120000) / 1000)), [config.startupTimeoutMs])

  if (!available) {
    return (
      <div className="rounded-md border border-sf-dark-700 bg-sf-dark-900 px-4 py-6 text-sm text-sf-text-muted">
        ComfyUI Launcher is only available in the desktop build.
      </div>
    )
  }

  const hasLauncherTarget = launcherMode === 'mac-app' ? Boolean(config.macAppPath) : Boolean(config.launcherScript)
  const canControlMacApp = isMacPlatform && launcherMode === 'mac-app' && state.ownership === 'app'
  const canStart = (state.state === 'idle' || state.state === 'stopped' || state.state === 'crashed' || state.state === 'unknown') && hasLauncherTarget
  const canStop = state.state === 'running' && (state.ownership === 'ours' || canControlMacApp)
  const canRestart = state.state === 'running' && (state.ownership === 'ours' || canControlMacApp)

  return (
    <div className="space-y-5">
      {/* Status */}
      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 px-4 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`w-2.5 h-2.5 rounded-full ${stateMeta.dot}`} />
            <div className="min-w-0">
              <div className="text-sm font-medium text-sf-text-primary">ComfyUI {stateMeta.label.toLowerCase()}</div>
              <div className="text-[11px] text-sf-text-muted truncate">{state.statusMessage || (state.httpBase ? `Endpoint: ${state.httpBase}` : 'No endpoint configured')}</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              type="button"
              onClick={() => wrap(startComfyLauncher)}
              disabled={busy || !canStart}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-emerald-500/90 hover:bg-emerald-500 disabled:bg-sf-dark-700 disabled:text-sf-text-muted text-white transition-colors"
            >
              <Play className="w-3 h-3" />
              Start
            </button>
            <button
              type="button"
              onClick={() => wrap(stopComfyLauncher)}
              disabled={busy || !canStop}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-red-500/90 hover:bg-red-500 disabled:bg-sf-dark-700 disabled:text-sf-text-muted text-white transition-colors"
            >
              <StopCircle className="w-3 h-3" />
              Stop
            </button>
            <button
              type="button"
              onClick={() => wrap(restartComfyLauncher)}
              disabled={busy || !canRestart}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-sky-500/90 hover:bg-sky-500 disabled:bg-sf-dark-700 disabled:text-sf-text-muted text-white transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              Restart
            </button>
            <button
              type="button"
              onClick={() => wrap(refreshComfyLauncher)}
              disabled={busy}
              title="Re-probe ComfyUI"
              className="inline-flex items-center gap-1 p-1.5 rounded text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-700 disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
        {error && (
          <div className="mt-2 flex items-start gap-2 rounded bg-red-500/10 border border-red-500/30 px-2 py-1.5 text-[11px] text-red-200">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <div className="flex-1 break-words">{error}</div>
          </div>
        )}
        {state.state === 'external' && (
          <div className="mt-2 flex items-start gap-2 rounded bg-sky-500/10 border border-sky-500/30 px-2 py-1.5 text-[11px] text-sky-200">
            <ExternalLink className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <div>
              ComfyUI is already running, but ComfyStudio didn't start it. Stop it from the window where you launched it and hit Start to let ComfyStudio manage it (you'll get auto-restarts after node-pack installs).
            </div>
          </div>
        )}
      </div>

      {/* Launcher target */}
      {isMacPlatform && (
        <div>
          <label className="text-xs uppercase tracking-wider text-sf-text-muted font-semibold">Launcher mode</label>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => { void updateConfig({ launcherMode: 'mac-app' }) }}
              className={`text-left rounded-md border px-3 py-2 transition-colors ${launcherMode === 'mac-app'
                ? 'border-sf-accent bg-sf-accent/15 text-sf-text-primary'
                : 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-secondary hover:bg-sf-dark-800'
              }`}
            >
              <div className="text-xs font-semibold">ComfyUI.app</div>
              <div className="text-[11px] text-sf-text-muted mt-0.5">Open the official Mac app and connect when it is ready.</div>
            </button>
            <button
              type="button"
              onClick={() => { void updateConfig({ launcherMode: 'script' }) }}
              className={`text-left rounded-md border px-3 py-2 transition-colors ${launcherMode === 'script'
                ? 'border-sf-accent bg-sf-accent/15 text-sf-text-primary'
                : 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-secondary hover:bg-sf-dark-800'
              }`}
            >
              <div className="text-xs font-semibold">Script</div>
              <div className="text-[11px] text-sf-text-muted mt-0.5">Run a custom .sh launcher or standalone ComfyUI install.</div>
            </button>
          </div>
        </div>
      )}

      {isMacPlatform && launcherMode === 'mac-app' && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs uppercase tracking-wider text-sf-text-muted font-semibold">ComfyUI.app</label>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => { void updateConfig({ launcherMode: 'mac-app', macAppPath: '/Applications/ComfyUI.app' }) }}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-secondary transition-colors"
              >
                Use default
              </button>
              <button
                type="button"
                onClick={handlePickMacApp}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-secondary transition-colors"
              >
                <FolderOpen className="w-3 h-3" />
                Browse...
              </button>
            </div>
          </div>
          <div className="bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2 text-xs text-sf-text-primary truncate min-h-[34px]">
            {config.macAppPath || (
              <span className="italic text-sf-text-muted">No app configured. Pick ComfyUI.app to let ComfyStudio open it for you.</span>
            )}
          </div>
          <p className="text-[11px] text-sf-text-muted mt-1.5">
            ComfyStudio opens the Mac app, waits for the configured ComfyUI endpoint, and can ask macOS to quit or reopen it.
          </p>
          <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-sf-dark-700 bg-sf-dark-900 px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-xs font-medium text-sf-text-primary">Launch in background</div>
              <div className="text-[11px] text-sf-text-muted mt-0.5">Open ComfyUI.app hidden so the embedded ComfyUI tab stays front and center.</div>
            </div>
            <Toggle
              checked={config.macAppLaunchHidden !== false}
              ariaLabel="Toggle background launch for ComfyUI.app"
              onChange={(value) => { void updateConfig({ macAppLaunchHidden: value }) }}
            />
          </div>
        </div>
      )}

      {!(isMacPlatform && launcherMode === 'mac-app') && (
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs uppercase tracking-wider text-sf-text-muted font-semibold">Launcher script</label>
          <button
            type="button"
            onClick={handlePickScript}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-secondary transition-colors"
          >
            <FolderOpen className="w-3 h-3" />
            Browse…
          </button>
        </div>
        <div className="bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2 text-xs text-sf-text-primary truncate min-h-[34px]">
          {config.launcherScript || (
            <span className="italic text-sf-text-muted">No launcher configured. Pick your run_nvidia_gpu.bat (or equivalent) to let ComfyStudio start ComfyUI for you.</span>
          )}
        </div>
        {candidates.length > 0 && (
          <div className="mt-2 space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-sf-text-muted font-semibold flex items-center gap-1">
              <FolderSearch className="w-3 h-3" />
              Detected near your ComfyUI folder
            </div>
            {candidates.map((candidate) => {
              const isCurrent = candidate.path === config.launcherScript
              return (
                <button
                  key={candidate.path}
                  type="button"
                  onClick={() => handleUseCandidate(candidate)}
                  disabled={isCurrent}
                  className={`w-full text-left px-2.5 py-1.5 rounded border text-[11px] transition-colors ${isCurrent
                    ? 'bg-sf-accent/20 border-sf-accent/40 text-sf-text-primary cursor-default'
                    : 'bg-sf-dark-800 border-sf-dark-700 hover:bg-sf-dark-700 text-sf-text-primary'
                  }`}
                >
                  <div className="font-medium truncate">{candidate.label || candidate.path.split(/[\\/]/).pop()}</div>
                  <div className="text-[10px] text-sf-text-muted truncate">{candidate.path}</div>
                </button>
              )
            })}
          </div>
        )}
      </div>
      )}

      {/* Behavior */}
      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-4 py-3 space-y-3">
        <div className="text-[10px] uppercase tracking-wider text-sf-text-muted font-semibold">Behavior</div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-sf-text-primary">Auto-start ComfyUI when ComfyStudio launches</div>
            <p className="text-[11px] text-sf-text-muted mt-0.5">Off by default. When on, ComfyStudio starts ComfyUI automatically as soon as the app opens.</p>
          </div>
          <Toggle
            checked={Boolean(config.autoStart)}
            ariaLabel="Toggle auto-start"
            onChange={(value) => { void updateConfig({ autoStart: value }) }}
          />
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-sf-text-primary">Keep ComfyUI running after ComfyStudio quits</div>
            <p className="text-[11px] text-sf-text-muted mt-0.5">When on, closing ComfyStudio leaves ComfyUI open in the background without asking.</p>
          </div>
          <Toggle
            checked={config.stopOnQuit === false}
            ariaLabel="Toggle keep ComfyUI running after quit"
            onChange={(value) => { void updateConfig({ stopOnQuit: !value }) }}
          />
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-sf-text-primary">Don't open ComfyUI in a browser tab on start</div>
            <p className="text-[11px] text-sf-text-muted mt-0.5">On by default. ComfyStudio passes <code className="px-1 rounded bg-sf-dark-800">--disable-auto-launch</code> so the classic ComfyUI tab doesn't steal focus each time it boots.</p>
          </div>
          <Toggle
            checked={config.disableAutoLaunch !== false}
            ariaLabel="Toggle disable auto-launch"
            onChange={(value) => { void updateConfig({ disableAutoLaunch: value }) }}
          />
        </div>
      </div>

      {/* Advanced */}
      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-4 py-3 space-y-3">
        <div className="text-[10px] uppercase tracking-wider text-sf-text-muted font-semibold">Advanced</div>
        <div>
          <label className="block text-[11px] text-sf-text-muted mb-1">Startup timeout (seconds)</label>
          <input
            type="number"
            min={10}
            max={900}
            value={startupTimeoutSeconds}
            onChange={(e) => {
              const seconds = Math.max(10, Math.min(900, Number(e.target.value) || 120))
              void updateConfig({ startupTimeoutMs: seconds * 1000 })
            }}
            className="w-32 bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
          />
          <p className="text-[11px] text-sf-text-muted mt-1">If ComfyUI hasn't responded on /system_stats within this many seconds after launch, ComfyStudio will give up and stop the process.</p>
        </div>
        <div>
          <label className="block text-[11px] text-sf-text-muted mb-1">Extra arguments</label>
          <input
            type="text"
            value={config.extraArgs || ''}
            onChange={(e) => { void updateConfig({ extraArgs: e.target.value }) }}
            placeholder="e.g. --listen 127.0.0.1 --port 8188"
            className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent placeholder-sf-text-muted"
          />
          <p className="text-[11px] text-sf-text-muted mt-1">Appended to the launcher script. Quoted strings are kept together.</p>
        </div>
      </div>

      {/* Logs */}
      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-4 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-sf-text-muted font-semibold flex items-center gap-1">
            <FileText className="w-3 h-3" />
            Logs
          </div>
          <div className="flex items-center gap-1.5">
            {typeof onOpenLogViewer === 'function' && (
              <button
                type="button"
                onClick={onOpenLogViewer}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-sf-accent hover:bg-sf-accent-hover text-white transition-colors"
              >
                Open log viewer
                <ChevronRight className="w-3 h-3" />
              </button>
            )}
            <button
              type="button"
              onClick={() => { void openComfyLauncherLogFile() }}
              disabled={!state.logFilePath}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] bg-sf-dark-700 hover:bg-sf-dark-600 disabled:opacity-50 text-sf-text-secondary transition-colors"
            >
              Open log file
            </button>
          </div>
        </div>
        <div className="text-[11px] text-sf-text-muted truncate" title={state.logFilePath}>
          {state.logFilePath || <span className="italic">No log file written this session yet.</span>}
        </div>
      </div>

      <div className="flex items-start gap-2 text-[11px] text-sf-text-muted">
        <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <div>
          ComfyStudio talks to ComfyUI on <code className="px-1 rounded bg-sf-dark-800">{state.httpBase || 'http://127.0.0.1:8188'}</code>. Change the port in
          <span className="mx-1 inline-flex items-center gap-1">
            <strong>ComfyUI Connection</strong>
          </span>
          if you need a different one.
          {(busy || state.state === 'starting' || state.state === 'stopping') && (
            <span className="ml-1 inline-flex items-center gap-1 text-sky-300">
              <Loader2 className="w-3 h-3 animate-spin" />
              Working…
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export default memo(ComfyLauncherSettingsSection)
