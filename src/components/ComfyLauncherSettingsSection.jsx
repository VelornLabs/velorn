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
import { useI18n } from '../i18n/I18nContext'
import ComfyConnectionSetup from './ComfyConnectionSetup'

const STATE_LABEL = {
  unknown: { key: 'unknown', dot: 'bg-slate-400' },
  idle: { key: 'offline', dot: 'bg-slate-400' },
  starting: { key: 'starting', dot: 'bg-amber-400 animate-pulse' },
  running: { key: 'running', dot: 'bg-emerald-400' },
  external: { key: 'external', dot: 'bg-sky-400' },
  stopping: { key: 'stopping', dot: 'bg-amber-400 animate-pulse' },
  stopped: { key: 'stopped', dot: 'bg-slate-400' },
  crashed: { key: 'crashed', dot: 'bg-red-500' },
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

function ComfyLauncherSettingsSection({ onOpenLogViewer, refreshOnMount = true }) {
  const { t } = useI18n()
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
    if (refreshOnMount) refreshComfyLauncher().catch(() => {})
    if (window?.electronAPI?.comfyLauncher?.getConfig) {
      window.electronAPI.comfyLauncher.getConfig().then((cfg) => {
        if (cfg) setConfig(cfg)
      }).catch(() => {})
    }
  }, [available, refreshOnMount])

  const stateMeta = STATE_LABEL[state.state] || STATE_LABEL.unknown
  const isMacPlatform = window?.electronAPI?.platform === 'darwin'
  const launcherMode = config.launcherMode === 'mac-app' ? 'mac-app' : 'script'

  const updateConfig = useCallback(async (partial) => {
    setError('')
    const next = { ...config, ...partial }
    const result = await updateComfyLauncherConfig(partial)
    if (result?.success === false) {
      setError(result.error || t('settings.launcher.saveFailed'))
    } else {
      setConfig(result?.config || next)
    }
  }, [config, t])

  const wrap = useCallback(async (action) => {
    setBusy(true)
    setError('')
    try {
      const result = await action()
      if (result && result.success === false) setError(result.error || t('settings.launcher.actionFailed'))
    } catch (err) {
      setError(err?.message || t('settings.launcher.actionFailed'))
    } finally {
      setBusy(false)
    }
  }, [t])

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
    if (candidate.launcherMode === 'mac-app') {
      if (!isMacPlatform) return
      await updateConfig({ launcherMode: 'mac-app', macAppPath: candidate.path })
    } else {
      await updateConfig({ launcherMode: 'script', launcherScript: candidate.path })
    }
  }

  const startupTimeoutSeconds = useMemo(() => Math.max(10, Math.round((config.startupTimeoutMs || 120000) / 1000)), [config.startupTimeoutMs])

  if (!available) {
    return (
      <div className="rounded-md border border-sf-dark-700 bg-sf-dark-900 px-4 py-6 text-sm text-sf-text-muted">
        {t('settings.launcher.desktopOnly')}
      </div>
    )
  }

  const hasLauncherTarget = launcherMode === 'mac-app' ? Boolean(config.macAppPath) : Boolean(config.launcherScript)
  const canControlMacApp = isMacPlatform && launcherMode === 'mac-app' && state.ownership === 'app'
  const canStart = (state.state === 'idle' || state.state === 'stopped' || state.state === 'crashed' || state.state === 'unknown') && hasLauncherTarget
  const canStop = state.state === 'running' && (state.ownership === 'ours' || canControlMacApp)
  const canRestart = state.state === 'running' && (state.ownership === 'ours' || canControlMacApp)
  const connectedExternally = state.ownership === 'external' || state.state === 'external'
  const statusLabel = connectedExternally
    ? t('settings.launcher.connectedExternally', {}, 'Connected externally')
    : state.state === 'running' && (state.ownership === 'ours' || state.ownership === 'app')
      ? t('settings.launcher.connectedManaged', {}, 'Connected · managed by Velorn')
      : t(`settings.launcher.states.${stateMeta.key}`)
  const usableCandidates = candidates.filter(candidate => candidate?.path
    && (candidate.launcherMode === 'mac-app' ? isMacPlatform : !candidate.launcherMode || candidate.launcherMode === 'script'))
  const statusMessage = state.statusMessage === 'ComfyUI is not running.'
    ? t('settings.launcher.status.notRunning')
    : state.statusMessage === 'ComfyUI not detected.'
      ? t('settings.launcher.status.notDetected')
      : state.statusMessage === 'ComfyUI.app is not running.'
        ? t('settings.launcher.status.appNotRunning')
        : state.statusMessage === 'ComfyUI.app not detected.'
          ? t('settings.launcher.status.appNotDetected')
          : state.statusMessage || (state.httpBase
            ? t('settings.launcher.status.endpoint', { endpoint: state.httpBase })
            : t('settings.launcher.status.noEndpoint'))

  return (
    <div className="space-y-5">
      {/* Status */}
      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 px-4 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`w-2.5 h-2.5 rounded-full ${stateMeta.dot}`} />
            <div className="min-w-0">
              <div className="text-sm font-medium text-sf-text-primary">ComfyUI · {statusLabel}</div>
              <div className="text-[11px] text-sf-text-muted truncate">{statusMessage}</div>
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
              {t('settings.launcher.start')}
            </button>
            <button
              type="button"
              onClick={() => wrap(stopComfyLauncher)}
              disabled={busy || !canStop}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-red-500/90 hover:bg-red-500 disabled:bg-sf-dark-700 disabled:text-sf-text-muted text-white transition-colors"
            >
              <StopCircle className="w-3 h-3" />
              {t('settings.launcher.stop')}
            </button>
            <button
              type="button"
              onClick={() => wrap(restartComfyLauncher)}
              disabled={busy || !canRestart}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-sky-500/90 hover:bg-sky-500 disabled:bg-sf-dark-700 disabled:text-sf-text-muted text-white transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              {t('settings.launcher.restart')}
            </button>
            <button
              type="button"
              onClick={() => wrap(refreshComfyLauncher)}
              disabled={busy}
              title={t('settings.launcher.refresh')}
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
        {connectedExternally && (
          <div className="mt-2 flex items-start gap-2 rounded bg-sky-500/10 border border-sky-500/30 px-2 py-1.5 text-[11px] text-sky-200">
            <ExternalLink className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <div>
              {t('settings.launcher.externalConnectionHelp', {}, 'ComfyUI is connected. Open its app or terminal to stop or restart it; generation does not require Velorn to manage startup.')}
            </div>
          </div>
        )}
      </div>

      <ComfyConnectionSetup />

      <details open={hasLauncherTarget} className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/30 px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-sf-text-primary">
          {t('settings.launcher.optionalStartup', {}, 'Let Velorn start ComfyUI (optional)')}
        </summary>
        <p className="mt-2 text-xs text-sf-text-muted">
          {t('settings.launcher.optionalStartupHelp', {}, 'Already open ComfyUI yourself? Keep using it that way. To start it here instead, choose a detected installation or browse for your launch script.')}
        </p>
        <div className="mt-4 space-y-5">
      {/* Launcher target */}
      {isMacPlatform && (
        <div>
          <label className="text-xs uppercase tracking-wider text-sf-text-muted font-semibold">{t('settings.launcher.mode')}</label>
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
              <div className="text-[11px] text-sf-text-muted mt-0.5">{t('settings.launcher.macAppHelp')}</div>
            </button>
            <button
              type="button"
              onClick={() => { void updateConfig({ launcherMode: 'script' }) }}
              className={`text-left rounded-md border px-3 py-2 transition-colors ${launcherMode === 'script'
                ? 'border-sf-accent bg-sf-accent/15 text-sf-text-primary'
                : 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-secondary hover:bg-sf-dark-800'
              }`}
            >
              <div className="text-xs font-semibold">{t('settings.launcher.script')}</div>
              <div className="text-[11px] text-sf-text-muted mt-0.5">{t('settings.launcher.scriptHelp')}</div>
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
                {t('settings.launcher.useDefault')}
              </button>
              <button
                type="button"
                onClick={handlePickMacApp}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-secondary transition-colors"
              >
                <FolderOpen className="w-3 h-3" />
                {t('settings.launcher.browse')}
              </button>
            </div>
          </div>
          <div className="bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2 text-xs text-sf-text-primary break-words min-h-[34px]">
            {config.macAppPath || (
              <span className="italic text-sf-text-muted">{t('settings.launcher.noAppOptional', {}, 'No app selected. Browse for ComfyUI.app, or open it yourself and connect above.')}</span>
            )}
          </div>
          <p className="text-[11px] text-sf-text-muted mt-1.5">
            {t('settings.launcher.macBehaviorHelp')}
          </p>
          <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-sf-dark-700 bg-sf-dark-900 px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-xs font-medium text-sf-text-primary">{t('settings.launcher.background')}</div>
              <div className="text-[11px] text-sf-text-muted mt-0.5">{t('settings.launcher.backgroundHelp')}</div>
            </div>
            <Toggle
              checked={config.macAppLaunchHidden !== false}
              ariaLabel={t('settings.launcher.backgroundToggle')}
              onChange={(value) => { void updateConfig({ macAppLaunchHidden: value }) }}
            />
          </div>
        </div>
      )}

      {!(isMacPlatform && launcherMode === 'mac-app') && (
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs uppercase tracking-wider text-sf-text-muted font-semibold">{t('settings.launcher.launcherScript')}</label>
          <button
            type="button"
            onClick={handlePickScript}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-secondary transition-colors"
          >
            <FolderOpen className="w-3 h-3" />
            {t('settings.launcher.browse')}
          </button>
        </div>
        <div className="bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2 text-xs text-sf-text-primary break-words min-h-[34px]">
          {config.launcherScript || (
            <span className="italic text-sf-text-muted">{t('settings.launcher.noScriptOptional', {}, 'No launch script selected. You can still open ComfyUI yourself and connect above.')}</span>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-sf-text-muted">
          {t('settings.launcher.scriptChoiceHelp', {}, 'Choose the script you normally use to start ComfyUI, such as a .bat file on Windows or a .sh file on Linux/macOS. For a desktop app, open the app and start the instance you want to use.')}
        </p>
      </div>
      )}
        {usableCandidates.length > 0 && (
          <div className="mt-2 space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-sf-text-muted font-semibold flex items-center gap-1">
              <FolderSearch className="w-3 h-3" />
              {t('settings.launcher.detectedInstallations', {}, 'Detected installations')}
            </div>
            {usableCandidates.map((candidate) => {
              const candidateMode = candidate.launcherMode === 'mac-app' ? 'mac-app' : 'script'
              const isCurrent = candidateMode === launcherMode && candidate.path === (candidateMode === 'mac-app' ? config.macAppPath : config.launcherScript)
              return (
                <button
                  key={candidate.path}
                  type="button"
                  onClick={() => wrap(() => handleUseCandidate(candidate))}
                  disabled={busy || isCurrent}
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

      {/* Behavior */}
      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-4 py-3 space-y-3">
        <div className="text-[10px] uppercase tracking-wider text-sf-text-muted font-semibold">{t('settings.launcher.behavior')}</div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-sf-text-primary">{t('settings.launcher.autoStart')}</div>
            <p className="text-[11px] text-sf-text-muted mt-0.5">{t('settings.launcher.autoStartHelp')}</p>
          </div>
          <Toggle
            checked={Boolean(config.autoStart)}
            ariaLabel={t('settings.launcher.autoStartToggle')}
            onChange={(value) => { void updateConfig({ autoStart: value }) }}
          />
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-sf-text-primary">{t('settings.launcher.keepRunning')}</div>
            <p className="text-[11px] text-sf-text-muted mt-0.5">{t('settings.launcher.keepRunningHelp')}</p>
          </div>
          <Toggle
            checked={config.stopOnQuit === false}
            ariaLabel={t('settings.launcher.keepRunningToggle')}
            onChange={(value) => { void updateConfig({ stopOnQuit: !value }) }}
          />
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-sf-text-primary">{t('settings.launcher.noBrowser')}</div>
            <p className="text-[11px] text-sf-text-muted mt-0.5">{t('settings.launcher.noBrowserHelpBefore')} <code className="px-1 rounded bg-sf-dark-800">--disable-auto-launch</code> {t('settings.launcher.noBrowserHelpAfter')}</p>
          </div>
          <Toggle
            checked={config.disableAutoLaunch !== false}
            ariaLabel={t('settings.launcher.noBrowserToggle')}
            onChange={(value) => { void updateConfig({ disableAutoLaunch: value }) }}
          />
        </div>
      </div>

      {/* Advanced */}
      <details className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-4 py-3">
        <summary className="cursor-pointer text-xs text-sf-text-muted font-semibold">{t('settings.launcher.advanced')}</summary>
        <div className="mt-3 space-y-3">
        <div>
          <label className="block text-[11px] text-sf-text-muted mb-1">{t('settings.launcher.timeout')}</label>
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
          <p className="text-[11px] text-sf-text-muted mt-1">{t('settings.launcher.timeoutHelpBefore')} <code>/system_stats</code> {t('settings.launcher.timeoutHelpAfter')}</p>
        </div>
        <div>
          <label className="block text-[11px] text-sf-text-muted mb-1">{t('settings.launcher.extraArgs')}</label>
          <input
            type="text"
            value={config.extraArgs || ''}
            onChange={(e) => { void updateConfig({ extraArgs: e.target.value }) }}
            placeholder="e.g. --listen 127.0.0.1 --port 8188"
            className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent placeholder-sf-text-muted"
          />
          <p className="text-[11px] text-sf-text-muted mt-1">{t('settings.launcher.extraArgsHelp')}</p>
        </div>
        </div>
      </details>
        </div>
      </details>

      {/* Logs */}
      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-4 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-sf-text-muted font-semibold flex items-center gap-1">
            <FileText className="w-3 h-3" />
            {t('settings.launcher.logs')}
          </div>
          <div className="flex items-center gap-1.5">
            {typeof onOpenLogViewer === 'function' && (
              <button
                type="button"
                onClick={onOpenLogViewer}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-sf-accent hover:bg-sf-accent-hover text-white transition-colors"
              >
                {t('settings.launcher.openLogViewer')}
                <ChevronRight className="w-3 h-3" />
              </button>
            )}
            <button
              type="button"
              onClick={() => { void openComfyLauncherLogFile() }}
              disabled={!state.logFilePath}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] bg-sf-dark-700 hover:bg-sf-dark-600 disabled:opacity-50 text-sf-text-secondary transition-colors"
            >
              {t('settings.launcher.openLogFile')}
            </button>
          </div>
        </div>
        <div className="text-[11px] text-sf-text-muted truncate" title={state.logFilePath}>
          {state.logFilePath || <span className="italic">{t('settings.launcher.noLog')}</span>}
        </div>
      </div>

      <div className="flex items-start gap-2 text-[11px] text-sf-text-muted">
        <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <div>
          {t('settings.launcher.connectionHelpBefore')} <code className="px-1 rounded bg-sf-dark-800">{state.httpBase || 'http://127.0.0.1:8188'}</code>.
          {' '}{t('settings.comfySetup.portHint', {}, 'Use Connect ComfyUI above to find or test a different local port.')}
          {(busy || state.state === 'starting' || state.state === 'stopping') && (
            <span className="ml-1 inline-flex items-center gap-1 text-sky-300">
              <Loader2 className="w-3 h-3 animate-spin" />
              {t('settings.launcher.working')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export default memo(ComfyLauncherSettingsSection)
