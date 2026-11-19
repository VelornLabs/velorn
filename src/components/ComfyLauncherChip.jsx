import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Play,
  StopCircle,
  RotateCcw,
  Loader2,
  AlertTriangle,
  ExternalLink,
  FolderOpen,
  FolderSearch,
  Settings as SettingsIcon,
  FileText,
  ChevronDown,
  Maximize2,
} from 'lucide-react'
import ComfyLauncherLogViewer from './ComfyLauncherLogViewer'
import ComfyConnectionSetup from './ComfyConnectionSetup'
import { useI18n } from '../i18n/I18nContext'

import {
  isComfyLauncherAvailable,
  subscribeComfyLauncherState,
  subscribeComfyLauncherLogs,
  getComfyLauncherSnapshot,
  getComfyLauncherLogs,
  getComfyLauncherConfig,
  startComfyLauncher,
  stopComfyLauncher,
  restartComfyLauncher,
  refreshComfyLauncher,
  fetchComfyLauncherLogsTail,
  openComfyLauncherLogFile,
  pickComfyLauncherMacApp,
  pickComfyLauncherScript,
  detectComfyLauncherCandidates,
  updateComfyLauncherConfig,
  describeComfyLauncherPortOwner,
  connectComfyLauncherExternal,
} from '../services/comfyLauncher'

const STATE_STYLES = {
  unknown: { dot: 'bg-slate-400', label: 'ComfyUI', tone: 'idle' },
  idle: { dot: 'bg-slate-400', label: 'ComfyUI offline', tone: 'idle' },
  starting: { dot: 'bg-amber-400 animate-pulse', label: 'Starting…', tone: 'starting' },
  running: { dot: 'bg-emerald-400', label: 'Running', tone: 'running' },
  external: { dot: 'bg-sky-400', label: 'External', tone: 'external' },
  stopping: { dot: 'bg-amber-400 animate-pulse', label: 'Stopping…', tone: 'starting' },
  stopped: { dot: 'bg-slate-400', label: 'Stopped', tone: 'idle' },
  crashed: { dot: 'bg-red-500', label: 'Crashed', tone: 'error' },
}

function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function usePopoverClickAway(ref, onDismiss, isOpen) {
  useEffect(() => {
    if (!isOpen) return
    const handle = (event) => {
      if (!ref.current) return
      if (ref.current.contains(event.target)) return
      onDismiss?.()
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [isOpen, onDismiss, ref])
}

function ComfyLauncherChip() {
  const { t } = useI18n()
  const available = isComfyLauncherAvailable()
  const [state, setState] = useState(() => getComfyLauncherSnapshot())
  const [config, setConfig] = useState(() => getComfyLauncherConfig())
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [logs, setLogs] = useState(() => getComfyLauncherLogs())
  const [candidates, setCandidates] = useState([])
  const [error, setError] = useState('')
  const [logViewerOpen, setLogViewerOpen] = useState(false)
  const [portOwner, setPortOwner] = useState(null) // { pid, name, port } | null
  // Which edge of the trigger button the popover anchors to. 'right' means the
  // popover extends leftward (good when the chip lives on the right side of a
  // header); 'left' means it extends rightward (needed when the chip lives
  // near the left edge of the viewport so the popover doesn't clip off-screen).
  // We recompute this at open time based on the trigger's bounding rect.
  const [popoverAnchor, setPopoverAnchor] = useState('right')
  const popoverRef = useRef(null)
  const triggerRef = useRef(null)
  const logTailRef = useRef(null)

  useEffect(() => {
    if (!available) return undefined
    const unsub = subscribeComfyLauncherState((next) => {
      setState(next)
    })
    return unsub
  }, [available])

  useEffect(() => {
    if (!open) return undefined
    const unsub = subscribeComfyLauncherLogs(() => {
      setLogs(getComfyLauncherLogs())
    })
    return unsub
  }, [open])

  useEffect(() => {
    if (!open) return
    setError('')
    fetchComfyLauncherLogsTail({ tailLines: 200 }).then(setLogs).catch(() => {})
    refreshComfyLauncher().catch(() => {})
    detectComfyLauncherCandidates({}).then((result) => {
      if (result?.success) setCandidates(result.candidates || [])
    }).catch(() => {})
    // Re-fetch config in case settings changed elsewhere.
    if (isComfyLauncherAvailable() && window.electronAPI?.comfyLauncher?.getConfig) {
      window.electronAPI.comfyLauncher.getConfig().then((cfg) => {
        if (cfg) setConfig(cfg)
      }).catch(() => {})
    }
  }, [open])

  // If the launcher has latched a port-in-use error, look up who's holding
  // the port so the user knows what to do about it. We only run this when
  // the popover is open to avoid surprising the user with shelling out to
  // netstat / lsof in the background.
  useEffect(() => {
    if (!open) return
    if (state.error !== 'port-in-use') {
      setPortOwner(null)
      return
    }
    let cancelled = false
    describeComfyLauncherPortOwner()
      .then((info) => { if (!cancelled) setPortOwner(info) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [open, state.error, state.httpBase])

  // Auto-scroll log tail when new lines arrive.
  useEffect(() => {
    if (!open) return
    const node = logTailRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [logs, open])

  usePopoverClickAway(popoverRef, () => setOpen(false), open)

  // Recompute which edge to anchor to every time the popover opens. If the
  // trigger sits close to the left edge of the window (common on the project
  // picker where the chip is clustered with the app title), the default
  // right-anchored popover would extend off-screen — so we flip to left.
  // The popover is ~380px wide; we leave 16px of breathing room.
  useEffect(() => {
    if (!open) return
    const POPOVER_WIDTH = 396
    const trigger = triggerRef.current
    if (!trigger || typeof window === 'undefined') return
    const rect = trigger.getBoundingClientRect()
    // Right-anchored popover extends from `rect.right - POPOVER_WIDTH` leftward.
    // If that goes past the viewport edge, flip to left-anchored.
    const wouldClipOnLeft = rect.right - POPOVER_WIDTH < 8
    setPopoverAnchor(wouldClipOnLeft ? 'left' : 'right')
  }, [open])

  const stateStyle = STATE_STYLES[state.state] || STATE_STYLES.unknown
  const connectedExternally = state.ownership === 'external' || state.state === 'external'
  const stateLabel = connectedExternally
    ? t('launcherChip.connectedExternally', {}, 'Connected externally')
    : t(`launcherChip.states.${STATE_STYLES[state.state] ? state.state : 'unknown'}`)
  const isMacPlatform = window?.electronAPI?.platform === 'darwin'
  const launcherMode = config.launcherMode === 'mac-app' ? 'mac-app' : 'script'

  const summary = useMemo(() => {
    if (!available) return t('launcherChip.summary.unavailable')
    if (state.state === 'running' && state.ownership === 'app') {
      const uptime = formatUptime(state.uptimeMs || Math.max(0, Date.now() - state.startedAt))
      return t('launcherChip.summary.managedApp', { uptime: uptime ? ` · ${uptime}` : '' }, 'Connected · ComfyUI.app managed by Velorn{{uptime}}')
    }
    if (state.state === 'running' && state.ownership === 'ours') {
      const uptime = formatUptime(state.uptimeMs || Math.max(0, Date.now() - state.startedAt))
      return t('launcherChip.summary.managed', { uptime: uptime ? ` · ${uptime}` : '' }, 'Connected · managed by Velorn{{uptime}}')
    }
    if (connectedExternally) {
      return t('launcherChip.summary.connectedExternal', { endpoint: state.httpBase || 'ComfyUI' }, 'Connected at {{endpoint}} · startup managed outside Velorn')
    }
    if (state.state === 'starting') return state.statusMessage || 'Starting ComfyUI…'
    if (state.state === 'stopping') return state.statusMessage || 'Stopping ComfyUI…'
    if (state.state === 'crashed') return state.statusMessage || 'ComfyUI exited unexpectedly.'
    if (state.state === 'stopped') return state.statusMessage || 'ComfyUI is stopped.'
    if (state.state === 'idle') return t('launcherChip.summary.notRunning')
    return t('launcherChip.summary.unknown')
  }, [available, state, connectedExternally, t])

  const wrap = async (action) => {
    setBusy(true)
    setError('')
    try {
      const result = await action()
      if (result && result.success === false) {
        setError(result.error || 'Action failed.')
      }
    } catch (err) {
      setError(err?.message || 'Action failed.')
    } finally {
      setBusy(false)
    }
  }

  const handleStart = () => wrap(startComfyLauncher)
  const handleStop = () => wrap(stopComfyLauncher)
  const handleRestart = () => wrap(restartComfyLauncher)
  const handleRefresh = () => wrap(refreshComfyLauncher)

  const handlePickLauncher = async () => {
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
    if (candidate.launcherMode === 'mac-app' && !isMacPlatform) return
    const partial = candidate.launcherMode === 'mac-app'
      ? { launcherMode: 'mac-app', macAppPath: candidate.path }
      : { launcherMode: 'script', launcherScript: candidate.path }
    await wrap(async () => {
      const result = await updateComfyLauncherConfig(partial)
      if (result?.success !== false) setConfig((prev) => ({ ...prev, ...partial, ...(result?.config || {}) }))
      return result
    })
  }

  const handleOpenLogFile = async () => {
    await openComfyLauncherLogFile()
  }

  const hasLauncherTarget = launcherMode === 'mac-app' ? Boolean(config.macAppPath) : Boolean(config.launcherScript)
  const canControlMacApp = isMacPlatform && launcherMode === 'mac-app' && state.ownership === 'app'
  const canStart = (state.state === 'idle' || state.state === 'stopped' || state.state === 'crashed' || state.state === 'unknown') && hasLauncherTarget
  const canStop = state.state === 'running' && (state.ownership === 'ours' || canControlMacApp)
  const canRestart = state.state === 'running' && (state.ownership === 'ours' || canControlMacApp)
  const showConnectionSetup = (!hasLauncherTarget || (state.state !== 'running' && !connectedExternally))
    && state.state !== 'starting' && state.state !== 'stopping'
  const usableCandidates = candidates.filter(candidate => candidate?.path
    && (candidate.launcherMode === 'mac-app' ? isMacPlatform : !candidate.launcherMode || candidate.launcherMode === 'script'))

  if (!available) return null

  return (
    <div className="relative no-drag" ref={popoverRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={summary}
        className="flex items-center gap-1.5 h-7 px-2.5 mr-1 rounded-md bg-sf-dark-800 hover:bg-sf-dark-700 text-sf-text-primary text-[11px] font-medium transition-colors border border-sf-dark-700"
      >
        <span className={`w-2 h-2 rounded-full ${stateStyle.dot}`} />
        <span className="whitespace-nowrap">{state.state === 'unknown' ? stateLabel : `ComfyUI ${stateLabel}`}</span>
        <ChevronDown className="w-3 h-3 text-sf-text-muted" />
      </button>

      {open && (
        <div className={`absolute ${popoverAnchor === 'left' ? 'left-0' : 'right-0'} top-[110%] z-50 w-[380px] max-w-[calc(100vw-16px)] max-h-[calc(100vh-80px)] overflow-y-auto bg-sf-dark-900 border border-sf-dark-700 rounded-lg shadow-2xl`}>
          <div className="px-3.5 py-3 border-b border-sf-dark-700 flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${stateStyle.dot}`} />
                <div className="text-sm font-semibold text-sf-text-primary">ComfyUI {stateLabel}</div>
              </div>
              <div className="mt-1 text-[11px] text-sf-text-muted truncate">{summary}</div>
            </div>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={busy}
              title={t('launcherChip.reprobeHelp')}
              className="p-1 rounded hover:bg-sf-dark-700 text-sf-text-muted hover:text-sf-text-primary disabled:opacity-50"
            >
              <Loader2 className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {showConnectionSetup && (
            <div className="px-3.5 py-3 border-b border-sf-dark-700">
              <ComfyConnectionSetup compact />
            </div>
          )}

          <div className="px-3.5 py-3 space-y-2.5 border-b border-sf-dark-700">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleStart}
                disabled={busy || !canStart}
                className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-md bg-emerald-500/90 hover:bg-emerald-500 disabled:bg-sf-dark-700 disabled:text-sf-text-muted text-white text-[11px] font-semibold transition-colors"
              >
                <Play className="w-3.5 h-3.5" />
                {t('launcherChip.start')}
              </button>
              <button
                type="button"
                onClick={handleStop}
                disabled={busy || !canStop}
                className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-md bg-red-500/90 hover:bg-red-500 disabled:bg-sf-dark-700 disabled:text-sf-text-muted text-white text-[11px] font-semibold transition-colors"
              >
                <StopCircle className="w-3.5 h-3.5" />
                {t('launcherChip.stop')}
              </button>
              <button
                type="button"
                onClick={handleRestart}
                disabled={busy || !canRestart}
                className="flex-1 flex items-center justify-center gap-1.5 h-8 rounded-md bg-sky-500/90 hover:bg-sky-500 disabled:bg-sf-dark-700 disabled:text-sf-text-muted text-white text-[11px] font-semibold transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {t('launcherChip.restart')}
              </button>
            </div>

            {connectedExternally && (
              <div className="flex items-start gap-2 rounded-md bg-sky-500/10 border border-sky-500/30 px-2.5 py-2 text-[11px] text-sky-200">
                <ExternalLink className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div>
                    {t('launcherChip.externalConnectionHelp', {}, 'ComfyUI is connected. You can generate normally. Use its app or terminal to stop or restart it, or recheck whether Velorn can safely manage it.')}
                  </div>
                  <div className="mt-1.5">
                    <button
                      type="button"
                      onClick={() => wrap(connectComfyLauncherExternal)}
                      disabled={busy}
                      className="px-2 py-1 rounded bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/40 text-sky-50 text-[10.5px] font-semibold disabled:opacity-50"
                    >
                      {t('launcherChip.recheckControls', {}, 'Recheck controls')}
                    </button>
                  </div>
                </div>
              </div>
            )}
            {error && (
              <div className="flex items-start gap-2 rounded-md bg-red-500/10 border border-red-500/30 px-2.5 py-2 text-[11px] text-red-200">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <div className="flex-1 break-words">{error}</div>
              </div>
            )}
            {state.error === 'port-in-use' && (
              <div className="rounded-md bg-amber-500/10 border border-amber-500/30 px-2.5 py-2 text-[11px] text-amber-100">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-amber-300" />
                  <div className="flex-1">
                    <div className="font-semibold">
                      Port {portOwner?.port || 8188} is already in use.
                    </div>
                    <div className="mt-0.5 text-amber-100/90 leading-snug">
                      {portOwner?.pid
                        ? <>Held by <span className="font-mono">{portOwner.name || 'pid'} (pid {portOwner.pid})</span>. {portOwner.name && /python|comfy/i.test(portOwner.name) ? 'That looks like ComfyUI already running.' : 'Velorn will not be able to start ComfyUI until that process releases the port.'}</>
                        : 'Another process is bound to this port. Velorn will not be able to start ComfyUI until that process releases the port.'}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => wrap(connectComfyLauncherExternal)}
                        disabled={busy}
                        className="px-2 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-50 text-[10.5px] font-semibold disabled:opacity-50"
                      >
                        Connect as external
                      </button>
                      <button
                        type="button"
                        onClick={handleStart}
                        disabled={busy || !canStart}
                        className="px-2 py-1 rounded bg-sf-dark-800 hover:bg-sf-dark-700 border border-sf-dark-600 text-sf-text-primary text-[10.5px] font-semibold disabled:opacity-50"
                      >
                        Retry start
                      </button>
                      <button
                        type="button"
                        onClick={handleRefresh}
                        disabled={busy}
                        className="px-2 py-1 rounded bg-sf-dark-800 hover:bg-sf-dark-700 border border-sf-dark-600 text-sf-text-primary text-[10.5px] font-semibold disabled:opacity-50"
                      >
                        Re-probe
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <details open={hasLauncherTarget} className="border-b border-sf-dark-700">
            <summary className="cursor-pointer px-3.5 py-3 text-xs font-medium text-sf-text-primary">
              {t('launcherChip.optionalStartup', {}, 'Let Velorn start ComfyUI (optional)')}
            </summary>
            <p className="px-3.5 pb-2 text-[11px] text-sf-text-muted">
              {t('launcherChip.optionalStartupHelp', {}, 'Choose an installation only if you want to start it from Velorn. Otherwise, open ComfyUI yourself and use Find running ComfyUI to connect.')}
            </p>
          {isMacPlatform && (
            <div className="px-3.5 py-3 space-y-2 border-b border-sf-dark-700">
              <div className="text-[10px] uppercase tracking-wider text-sf-text-muted font-semibold">Launcher mode</div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => { void updateComfyLauncherConfig({ launcherMode: 'mac-app' }); setConfig((prev) => ({ ...prev, launcherMode: 'mac-app' })) }}
                  className={`text-left px-2 py-1.5 rounded border text-[11px] transition-colors ${launcherMode === 'mac-app'
                    ? 'bg-sf-accent/20 border-sf-accent/40 text-sf-text-primary'
                    : 'bg-sf-dark-800 border-sf-dark-700 hover:bg-sf-dark-700 text-sf-text-primary'
                  }`}
                >
                  ComfyUI.app
                </button>
                <button
                  type="button"
                  onClick={() => { void updateComfyLauncherConfig({ launcherMode: 'script' }); setConfig((prev) => ({ ...prev, launcherMode: 'script' })) }}
                  className={`text-left px-2 py-1.5 rounded border text-[11px] transition-colors ${launcherMode === 'script'
                    ? 'bg-sf-accent/20 border-sf-accent/40 text-sf-text-primary'
                    : 'bg-sf-dark-800 border-sf-dark-700 hover:bg-sf-dark-700 text-sf-text-primary'
                  }`}
                >
                  Script
                </button>
              </div>
            </div>
          )}

          {isMacPlatform && launcherMode === 'mac-app' && (
            <div className="px-3.5 py-3 space-y-2 border-b border-sf-dark-700">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wider text-sf-text-muted font-semibold">ComfyUI.app</div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => { void updateComfyLauncherConfig({ launcherMode: 'mac-app', macAppPath: '/Applications/ComfyUI.app' }); setConfig((prev) => ({ ...prev, launcherMode: 'mac-app', macAppPath: '/Applications/ComfyUI.app' })) }}
                    className="flex items-center gap-1 px-2 py-0.5 rounded bg-sf-dark-800 hover:bg-sf-dark-700 text-[10px] text-sf-text-primary"
                  >
                    Default
                  </button>
                  <button
                    type="button"
                    onClick={handlePickMacApp}
                    className="flex items-center gap-1 px-2 py-0.5 rounded bg-sf-dark-800 hover:bg-sf-dark-700 text-[10px] text-sf-text-primary"
                    title="Pick ComfyUI.app"
                  >
                    <FolderOpen className="w-3 h-3" />
                    Browse
                  </button>
                </div>
              </div>
              <div className="text-[11px] text-sf-text-primary break-words" title={config.macAppPath}>
                {config.macAppPath || (
                  <span className="italic text-sf-text-muted">{t('launcherChip.noAppOptional', {}, 'No app selected. Browse for ComfyUI.app, or open it yourself and connect.')}</span>
                )}
              </div>
              <div className="text-[10px] text-sf-text-muted">Velorn opens the Mac app and waits for the configured endpoint.</div>
            </div>
          )}

          {!(isMacPlatform && launcherMode === 'mac-app') && (
          <div className="px-3.5 py-3 space-y-2 border-b border-sf-dark-700">
            <div className="flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-wider text-sf-text-muted font-semibold">{t('launcherChip.script')}</div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={handlePickLauncher}
                  className="flex items-center gap-1 px-2 py-0.5 rounded bg-sf-dark-800 hover:bg-sf-dark-700 text-[10px] text-sf-text-primary"
                  title={t('launcherChip.pickScript')}
                >
                  <FolderOpen className="w-3 h-3" />
                  {t('launcherChip.browse')}
                </button>
              </div>
            </div>
            <div className="text-[11px] text-sf-text-primary break-words" title={config.launcherScript}>
              {config.launcherScript || (
                <span className="italic text-sf-text-muted">{t('launcherChip.noScriptOptional', {}, 'No launch script selected. Open ComfyUI yourself and connect, or browse for the .bat or .sh script you normally use.')}</span>
              )}
            </div>
          </div>
          )}
            {usableCandidates.length > 0 && (
              <div className="px-3.5 py-3 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-sf-text-muted font-semibold flex items-center gap-1">
                  <FolderSearch className="w-3 h-3" />
                  {t('launcherChip.detectedInstallations', {}, 'Detected installations')}
                </div>
                {usableCandidates.map((candidate) => {
                  const candidateMode = candidate.launcherMode === 'mac-app' ? 'mac-app' : 'script'
                  const isCurrent = candidateMode === launcherMode && candidate.path === (candidateMode === 'mac-app' ? config.macAppPath : config.launcherScript)
                  return (
                    <button
                      key={candidate.path}
                      type="button"
                      onClick={() => handleUseCandidate(candidate)}
                      disabled={busy || isCurrent}
                      className={`w-full text-left px-2 py-1.5 rounded border text-[11px] transition-colors ${isCurrent
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
          </details>

          <details className="px-3.5 py-2.5" onToggle={event => {
            if (event.currentTarget.open && logTailRef.current) {
              logTailRef.current.scrollTop = logTailRef.current.scrollHeight
            }
          }}>
            <summary className="cursor-pointer text-xs font-medium text-sf-text-muted">
              {t('launcherChip.troubleshootingLogs', {}, 'Troubleshooting and logs')}
            </summary>
            <div className="mt-3">
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[10px] uppercase tracking-wider text-sf-text-muted font-semibold flex items-center gap-1">
                <FileText className="w-3 h-3" />
                {t('launcherChip.logTail')}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => { setOpen(false); setLogViewerOpen(true) }}
                  className="inline-flex items-center gap-1 text-[10px] text-sf-accent hover:text-sf-accent-hover"
                  title={t('launcherChip.openViewerHelp')}
                >
                  <Maximize2 className="w-3 h-3" />
                  {t('launcherChip.openViewer')}
                </button>
                <button
                  type="button"
                  onClick={handleOpenLogFile}
                  disabled={!state.logFilePath}
                  className="text-[10px] text-sf-accent hover:text-sf-accent-hover disabled:text-sf-text-muted"
                  title={state.logFilePath || t('launcherChip.noLogFile')}
                >
                  {t('launcherChip.openLogFile')}
                </button>
              </div>
            </div>
            <div
              ref={logTailRef}
              className="h-[160px] overflow-y-auto bg-black/60 border border-sf-dark-700 rounded-md px-2 py-1.5 font-mono text-[10.5px] text-sf-text-secondary leading-snug"
            >
              {logs.length === 0 ? (
                <div className="text-sf-text-muted italic">{t('launcherChip.noLogs')}</div>
              ) : (
                logs.slice(-200).map((entry, idx) => (
                  <div
                    key={`${entry.ts}-${idx}`}
                    className={`whitespace-pre-wrap break-words ${entry.stream === 'stderr' ? 'text-amber-300/90' : entry.stream === 'system' ? 'text-sky-300/80' : ''}`}
                  >
                    {entry.text}
                  </div>
                ))
              )}
            </div>
            </div>
          </details>

          <div className="px-3.5 py-2 bg-sf-dark-950/50 border-t border-sf-dark-700 flex items-center justify-between text-[10px] text-sf-text-muted">
            <span>{state.httpBase || '—'}</span>
            <span className="flex items-center gap-1">
              <SettingsIcon className="w-3 h-3" />
              {t('launcherChip.manage')}
            </span>
          </div>
        </div>
      )}
      <ComfyLauncherLogViewer open={logViewerOpen} onClose={() => setLogViewerOpen(false)} />
    </div>
  )
}

export default ComfyLauncherChip
