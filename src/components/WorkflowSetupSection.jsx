import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cloud,
  Download,
  ExternalLink,
  Film,
  FolderSearch,
  Image as ImageIcon,
  KeyRound,
  Layers,
  LayoutGrid,
  List,
  Loader2,
  Music,
  RefreshCw,
  ScanLine,
  Settings,
  Sparkles,
  Users,
  Wrench,
  X,
} from 'lucide-react'
import ApiKeyDialog from './ApiKeyDialog'
import { COMFY_PARTNER_KEY_CHANGED_EVENT } from '../services/comfyPartnerAuth'
import { WORKFLOW_SETUP_STARTER_KITS, getWorkflowSetupGalleryMeta } from '../config/workflowSetupGallery'
import { checkLocalComfyConnection, getLocalComfyConnectionSync } from '../services/localComfyConnection'
import {
  WORKFLOW_SETUP_SECTION_ID,
  buildWorkflowInstallPlan,
  buildWorkflowSetupClipboardText,
  getWorkflowSetupWorkflows,
  openBundledWorkflowInComfyUi,
  scanWorkflowSetupDependencies,
} from '../services/workflowSetupManager'
import {
  getComfyLauncherSnapshot,
  isComfyLauncherAvailable,
  restartComfyLauncher,
  startComfyLauncher,
  subscribeComfyLauncherState,
  waitForComfyLauncherState,
} from '../services/comfyLauncher'

const COMFY_ROOT_PATH_SETTING_KEY = 'comfyRootPath'

function formatBytes(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 'Unknown size'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = numeric
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function clampProgressPercent(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Math.max(0, Math.min(100, numeric))
}

function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target || {}, key)
}

function createInitialInstallProgress() {
  return {
    stage: '',
    status: 'idle',
    message: '',
    currentLabel: '',
    taskType: '',
    currentTaskIndex: 0,
    totalTasks: 0,
    completedTasks: 0,
    taskPercent: null,
    overallPercent: 0,
    bytesDownloaded: 0,
    totalBytes: 0,
  }
}

function parseInstallProgressFromMessage(message) {
  const text = String(message || '').trim()
  if (!text) return null

  const downloadMatch = text.match(/^Downloading\s+(.+?):\s+(\d+)%$/i)
  if (downloadMatch) {
    return {
      taskType: 'model',
      currentLabel: downloadMatch[1],
      taskPercent: clampProgressPercent(Number(downloadMatch[2])),
    }
  }

  const downloadStartMatch = text.match(/^Downloading\s+(.+?)\.\.\.$/i)
  if (downloadStartMatch) {
    return {
      taskType: 'model',
      currentLabel: downloadStartMatch[1],
      taskPercent: 0,
    }
  }

  const readyMatch = text.match(/^(.+?):\s+(downloaded to|already exists, skipping download\.)/i)
  if (readyMatch) {
    return {
      taskType: 'model',
      currentLabel: readyMatch[1],
      taskPercent: 100,
    }
  }

  const nodePackMatch = text.match(/^Installing\s+(.+?)\.\.\.$/i)
  if (nodePackMatch) {
    return {
      taskType: 'node-pack',
      currentLabel: nodePackMatch[1],
      taskPercent: null,
    }
  }

  return null
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function copyTextToClipboard(text) {
  if (navigator?.clipboard?.writeText) {
    return navigator.clipboard.writeText(String(text || ''))
  }

  const textarea = document.createElement('textarea')
  textarea.value = String(text || '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
  return Promise.resolve()
}

function formatModelFolder(targetSubdir = '') {
  return targetSubdir ? `ComfyUI/models/${targetSubdir}` : 'ComfyUI/models'
}

function getStatusMeta(result) {
  switch (result?.setupStatus) {
    case 'ready':
      return { label: 'All set', tone: 'text-green-400 border-green-500/30 bg-green-500/10', dot: 'bg-green-400' }
    case 'auto-installable':
      return { label: 'Install needed', tone: 'text-orange-300 border-orange-400/30 bg-orange-400/10', dot: 'bg-orange-400' }
    case 'needs-auth':
      return { label: 'API key needed', tone: 'text-yellow-300 border-yellow-400/30 bg-yellow-400/10', dot: 'bg-yellow-300' }
    case 'needs-comfy-update':
      return { label: 'Update ComfyUI', tone: 'text-orange-300 border-orange-400/30 bg-orange-400/10', dot: 'bg-orange-400' }
    case 'manual':
      return { label: 'Manual steps', tone: 'text-yellow-300 border-yellow-400/30 bg-yellow-400/10', dot: 'bg-yellow-300' }
    case 'mixed':
      return { label: 'Install needed', tone: 'text-orange-300 border-orange-400/30 bg-orange-400/10', dot: 'bg-orange-400' }
    case 'partial':
      return { label: 'Partial', tone: 'text-yellow-300 border-yellow-400/30 bg-yellow-400/10', dot: 'bg-yellow-300' }
    case 'error':
      return { label: 'Error', tone: 'text-sf-error border-sf-error/30 bg-sf-error/10', dot: 'bg-sf-error' }
    case 'no-pack':
      return { label: 'No pack', tone: 'text-sf-text-muted border-sf-dark-600 bg-sf-dark-800/80', dot: 'bg-sf-text-muted' }
    default:
      return { label: 'Unknown', tone: 'text-sf-text-muted border-sf-dark-600 bg-sf-dark-800/80', dot: 'bg-sf-text-muted' }
  }
}

/**
 * High-contrast status pill used on top of busy thumbnails. Uses a solid dark
 * backdrop with a colored dot so the label stays readable regardless of the
 * artwork behind it.
 */
function StatusChipOnMedia({ statusMeta }) {
  return (
    <div className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full bg-black/80 px-2 py-0.5 text-[10px] font-semibold text-white shadow-md ring-1 ring-white/15">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusMeta.dot || 'bg-white'}`} />
      <span className="truncate">{statusMeta.label}</span>
    </div>
  )
}

const WORKFLOW_GALLERY_ICONS = {
  film: Film,
  cloud: Cloud,
  image: ImageIcon,
  music: Music,
  sparkles: Sparkles,
  scanline: ScanLine,
  boxes: Boxes,
  users: Users,
  layers: Layers,
}

function WorkflowGalleryHeroIcon({ name, className = 'h-10 w-10 opacity-90' }) {
  const Icon = WORKFLOW_GALLERY_ICONS[name] || Boxes
  return <Icon className={className} />
}

function WorkflowSetupExpandedBody({
  result,
  rootValidation,
  installing,
  galleryMeta,
  onCopySetup,
  onOpenComfy,
  onInstallWorkflow,
  onConfigureApiKey,
}) {
  const canInstallWorkflow = result.hasActionableInstalls && rootValidation.isValid && !installing
  const longDescription = galleryMeta?.longDescription || galleryMeta?.description || ''
  const badgeList = Array.isArray(galleryMeta?.badges) ? galleryMeta.badges : []

  return (
    <div className="border-t border-sf-dark-700 px-3 py-3 space-y-3 bg-sf-dark-950/40">
      {longDescription && (
        <div className="rounded border border-sf-dark-700 bg-sf-dark-950/70 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium text-sf-text-primary">
            <Boxes className="h-3.5 w-3.5 text-sf-text-secondary" />
            About this workflow
          </div>
          <p className="text-[11px] leading-relaxed text-sf-text-secondary">{longDescription}</p>
          {badgeList.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {badgeList.map((badge) => (
                <span
                  key={badge}
                  className="rounded-full border border-sf-dark-700 bg-sf-dark-900/80 px-2 py-0.5 text-[10px] text-sf-text-muted"
                >
                  {badge}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {result.status === 'error' && (
        <div className="text-[11px] text-sf-error">
          Could not validate this workflow yet: {result.error || 'unknown error'}
        </div>
      )}

      {result.hasActionableInstalls && (
        <div className="rounded border border-sf-dark-700 bg-sf-dark-950/70 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs text-sf-text-primary">
            <Download className="w-3.5 h-3.5 text-orange-300" />
            Actionable installs
          </div>
          {result.autoNodePacks.map((pack) => (
            <div key={pack.id} className="text-[11px] text-sf-text-secondary">
              <div className="font-medium text-sf-text-primary">{pack.displayName}</div>
              <div>{pack.notes}</div>
            </div>
          ))}
          {result.autoModels.map((model) => (
            <div key={`${model.targetSubdir}:${model.filename}`} className="text-[11px] text-sf-text-secondary">
              <div className="font-medium text-sf-text-primary">{model.filename}</div>
              <div>{formatModelFolder(model.targetSubdir)}{model.install.sizeBytes ? ` • ${formatBytes(model.install.sizeBytes)}` : ''}</div>
              {model.install.notes && (
                <div>{model.install.notes}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {result.coreUpdateNodes.length > 0 && (
        <div className="rounded border border-sf-dark-700 bg-sf-dark-950/70 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs text-sf-text-primary">
            <Settings className="w-3.5 h-3.5 text-yellow-300" />
            Update ComfyUI first
          </div>
          {result.coreUpdateNodes.map((node) => (
            <div key={node.classType} className="text-[11px] text-sf-text-secondary">
              <div className="font-medium text-sf-text-primary">{node.classType}</div>
              <div>{node.install.notes}</div>
              {node.install.fallbackRepoUrl && (
                <a
                  href={node.install.fallbackRepoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 mt-1 text-sf-accent hover:text-sf-accent-hover"
                >
                  Optional fallback repo
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {result.manualNodes.length > 0 && (
        <div className="rounded border border-sf-dark-700 bg-sf-dark-950/70 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs text-sf-text-primary">
            <Boxes className="w-3.5 h-3.5 text-yellow-300" />
            Manual node setup
          </div>
          {result.manualNodes.map((node) => (
            <div key={node.classType} className="text-[11px] text-sf-text-secondary">
              <div className="font-medium text-sf-text-primary">{node.classType}</div>
              <div>{node.install.notes}</div>
            </div>
          ))}
        </div>
      )}

      {result.manualModels.length > 0 && (
        <div className="rounded border border-sf-dark-700 bg-sf-dark-950/70 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs text-sf-text-primary">
            <AlertTriangle className="w-3.5 h-3.5 text-yellow-300" />
            Manual model setup
          </div>
          {result.manualModels.map((model) => (
            <div key={`${model.targetSubdir}:${model.filename}`} className="text-[11px] text-sf-text-secondary">
              <div className="font-medium text-sf-text-primary">{model.filename}</div>
              <div>{formatModelFolder(model.targetSubdir)}</div>
              <div>{model.install.notes}</div>
            </div>
          ))}
        </div>
      )}

      {result.missingAuth && (
        <div className="rounded border border-yellow-400/30 bg-yellow-400/5 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-yellow-300" />
              <div>
                <div className="text-[12px] font-medium text-sf-text-primary">Cloud API key needed</div>
                <p className="mt-0.5 text-[11px] text-sf-text-muted">
                  This cloud workflow runs on Comfy.org's API. Paste your key once and you're set — the same key unlocks Grok, Kling, Vidu, Nano Banana, and Seedream.
                </p>
              </div>
            </div>
            {typeof onConfigureApiKey === 'function' && (
              <button
                type="button"
                onClick={(event) => { event.stopPropagation(); onConfigureApiKey() }}
                className="shrink-0 rounded bg-sf-accent px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-sf-accent/90"
              >
                Set up key
              </button>
            )}
          </div>
        </div>
      )}

      {(result.unresolvedModels?.length || 0) > 0 && (
        <div className="rounded border border-sf-dark-700 bg-sf-dark-950/70 p-3 text-[11px] text-yellow-300">
          {result.unresolvedModels.length} model check(s) could not be verified from ComfyUI metadata and may still need manual confirmation.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => { void onCopySetup(result) }}
          className="rounded border border-sf-dark-600 px-3 py-1.5 text-xs text-sf-text-secondary hover:text-sf-text-primary hover:border-sf-dark-500 transition-colors"
        >
          Copy setup notes
        </button>
        <button
          type="button"
          onClick={() => { void onOpenComfy(result.workflowId) }}
          className="rounded border border-sf-dark-600 px-3 py-1.5 text-xs text-sf-text-secondary hover:text-sf-text-primary hover:border-sf-dark-500 transition-colors"
        >
          Load in ComfyUI
        </button>
        {result.pack?.docsUrl && (
          <a
            href={result.pack.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded border border-sf-dark-600 px-3 py-1.5 text-xs text-sf-text-secondary hover:text-sf-text-primary hover:border-sf-dark-500 transition-colors"
          >
            Open docs
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
        {result.hasActionableInstalls && (
          <button
            type="button"
            onClick={() => { void onInstallWorkflow(result) }}
            disabled={!canInstallWorkflow}
            className={`inline-flex items-center gap-1 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              canInstallWorkflow
                ? 'bg-orange-400/15 text-orange-200 border border-orange-400/35 hover:bg-orange-400/20'
                : 'border border-sf-dark-600 bg-sf-dark-800 text-sf-text-muted cursor-not-allowed'
            }`}
          >
            {installing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wrench className="w-3 h-3" />}
            Install missing
          </button>
        )}
      </div>
    </div>
  )
}

function InstallSummaryRow({ label, value, tone = 'text-sf-text-secondary' }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-2">
      <span className="text-xs text-sf-text-muted">{label}</span>
      <span className={`text-xs font-medium ${tone}`}>{value}</span>
    </div>
  )
}

const WorkflowSetupSection = memo(function WorkflowSetupSection() {
  const [comfyRootPath, setComfyRootPath] = useState('')
  const [rootValidation, setRootValidation] = useState({
    success: false,
    isValid: false,
    error: '',
    warnings: [],
    normalizedPath: '',
    customNodesPath: '',
    modelsPath: '',
    pythonCommand: '',
    extraModelConfigPath: '',
    extraModelPathCount: 0,
  })
  const [connectionState, setConnectionState] = useState({
    status: 'idle',
    message: `Saved endpoint: ${getLocalComfyConnectionSync().httpBase}`,
  })
  const [scanState, setScanState] = useState('idle')
  const [workflowResults, setWorkflowResults] = useState([])
  const [selectedWorkflowIds, setSelectedWorkflowIds] = useState([])
  const [expandedWorkflowId, setExpandedWorkflowId] = useState(null)
  const [installing, setInstalling] = useState(false)
  const [showInstallOverlay, setShowInstallOverlay] = useState(false)
  const [installProgress, setInstallProgress] = useState(() => createInitialInstallProgress())
  const [installLogs, setInstallLogs] = useState([])
  const [statusMessage, setStatusMessage] = useState('')
  const [setupViewMode, setSetupViewMode] = useState('gallery')
  const [activeWorkflowFilterId, setActiveWorkflowFilterId] = useState('all')
  const [launcherState, setLauncherState] = useState(() => (
    isComfyLauncherAvailable() ? getComfyLauncherSnapshot() : null
  ))
  // { installs: [{ label, source }], since } — cleared once ComfyUI restarts.
  const [pendingRestart, setPendingRestart] = useState(null)
  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false)

  useEffect(() => {
    if (!isComfyLauncherAvailable()) return undefined
    const unsub = subscribeComfyLauncherState((next) => setLauncherState(next))
    return unsub
  }, [])

  // When a restart/start actually completes (observed via launcher state),
  // clear the pending-restart banner. We only act on transitions into
  // 'running' while we had a pending restart, so stale banners don't persist
  // across sessions.
  const prevLauncherRef = useRef(null)
  useEffect(() => {
    const prev = prevLauncherRef.current
    prevLauncherRef.current = launcherState
    if (!launcherState || !prev) return
    if (launcherState.state === 'running' && prev.state === 'starting') {
      // ComfyUI just came back up. If there was a pending restart, clear it.
      setPendingRestart((current) => (current ? null : current))
    }
  }, [launcherState])

  const handleValidateRoot = useCallback(async (pathValue) => {
    const normalized = String(pathValue || '').trim()
    if (!normalized) {
      setRootValidation({
        success: false,
        isValid: false,
        error: 'Select your local ComfyUI folder to enable in-app installs.',
        warnings: [],
        normalizedPath: '',
        customNodesPath: '',
        modelsPath: '',
        pythonCommand: '',
        extraModelConfigPath: '',
        extraModelPathCount: 0,
      })
      return
    }

    if (!window?.electronAPI?.validateWorkflowSetupRoot) {
      setRootValidation({
        success: false,
        isValid: false,
        error: 'Workflow setup validation is only available in the desktop build.',
        warnings: [],
        normalizedPath: '',
        customNodesPath: '',
        modelsPath: '',
        pythonCommand: '',
        extraModelConfigPath: '',
        extraModelPathCount: 0,
      })
      return
    }

    const result = await window.electronAPI.validateWorkflowSetupRoot(normalized)
    setRootValidation({
      success: Boolean(result?.success),
      isValid: Boolean(result?.isValid),
      error: result?.error || '',
      warnings: Array.isArray(result?.warnings) ? result.warnings : [],
      normalizedPath: result?.normalizedPath || normalized,
      customNodesPath: result?.customNodesPath || '',
      modelsPath: result?.modelsPath || '',
      pythonCommand: result?.pythonCommand || '',
      extraModelConfigPath: result?.extraModelConfigPath || '',
      extraModelPathCount: Number(result?.extraModelPathCount || 0) || 0,
    })
  }, [])

  const handleRefreshConnection = useCallback(async () => {
    const current = getLocalComfyConnectionSync()
    setConnectionState({
      status: 'testing',
      message: `Testing ${current.httpBase}...`,
    })

    try {
      const result = await checkLocalComfyConnection()
      if (result.ok) {
        setConnectionState({
          status: 'success',
          message: `Connected to ${result.httpBase}`,
        })
        return true
      }

      setConnectionState({
        status: 'offline',
        message: result.error || `Could not connect to ${current.httpBase}`,
      })
      return false
    } catch (error) {
      setConnectionState({
        status: 'offline',
        message: error instanceof Error ? error.message : 'Could not connect to local ComfyUI.',
      })
      return false
    }
  }, [])

  const handleScanAll = useCallback(async () => {
    setScanState('checking')
    setStatusMessage('')

    const connected = await handleRefreshConnection()
    if (!connected) {
      setScanState('offline')
      setStatusMessage('ComfyUI is offline. Start it, then re-check workflow setup.')
      return
    }

    try {
      const nextResults = await scanWorkflowSetupDependencies()
      setWorkflowResults(nextResults)
      setExpandedWorkflowId((prev) => (
        prev && nextResults.some((result) => result.workflowId === prev) ? prev : null
      ))
      setSelectedWorkflowIds((prev) => {
        const previous = new Set(prev)
        return nextResults
          .filter((result) => previous.has(result.workflowId) && result.hasActionableInstalls)
          .map((result) => result.workflowId)
      })
      setScanState('ready')
      setStatusMessage('Workflow dependency scan complete.')
    } catch (error) {
      setScanState('error')
      setStatusMessage(error instanceof Error ? error.message : 'Could not check workflow dependencies.')
    }
  }, [handleRefreshConnection])

  // Re-scan once the partner API key is saved/removed so needs-auth status
  // flips to ready without the user having to hit Re-scan manually.
  useEffect(() => {
    const handler = () => { void handleScanAll() }
    window.addEventListener(COMFY_PARTNER_KEY_CHANGED_EVENT, handler)
    return () => window.removeEventListener(COMFY_PARTNER_KEY_CHANGED_EVENT, handler)
  }, [handleScanAll])

  const installPlan = useMemo(
    () => buildWorkflowInstallPlan(workflowResults, selectedWorkflowIds),
    [workflowResults, selectedWorkflowIds]
  )

  const activeWorkflowFilter = useMemo(
    () => WORKFLOW_SETUP_STARTER_KITS.find((kit) => kit.id === activeWorkflowFilterId) || null,
    [activeWorkflowFilterId]
  )
  const visibleWorkflowResults = useMemo(() => {
    if (!activeWorkflowFilter) return workflowResults
    const workflowOrder = new Map(
      (Array.isArray(activeWorkflowFilter.workflowIds) ? activeWorkflowFilter.workflowIds : [])
        .map((workflowId, index) => [workflowId, index])
    )
    return workflowResults
      .filter((result) => workflowOrder.has(result.workflowId))
      .sort((a, b) => (workflowOrder.get(a.workflowId) ?? 999) - (workflowOrder.get(b.workflowId) ?? 999))
  }, [activeWorkflowFilter, workflowResults])
  const visibleActionableWorkflowIds = useMemo(
    () => visibleWorkflowResults
      .filter((result) => result.hasActionableInstalls)
      .map((result) => result.workflowId),
    [visibleWorkflowResults]
  )

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        if (window?.electronAPI?.getSetting) {
          const stored = String(await window.electronAPI.getSetting(COMFY_ROOT_PATH_SETTING_KEY) || '')
          if (!cancelled) {
            setComfyRootPath(stored)
            if (stored) {
              await handleValidateRoot(stored)
            } else {
              await handleValidateRoot('')
            }
          }
        }
      } catch (_) {
        if (!cancelled) {
          await handleValidateRoot('')
        }
      }

      if (!cancelled) {
        void handleScanAll()
      }
    })()

    return () => {
      cancelled = true
    }
  }, [handleScanAll, handleValidateRoot])

  useEffect(() => {
    if (!window?.electronAPI?.onWorkflowSetupProgress) return undefined
    return window.electronAPI.onWorkflowSetupProgress((entry) => {
      const normalizedEntry = entry && typeof entry === 'object' ? entry : {}
      const parsedMessageProgress = parseInstallProgressFromMessage(normalizedEntry.message)

      setInstallLogs((prev) => [...prev, {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        message: normalizedEntry.message || 'Working...',
        stage: normalizedEntry.stage || '',
        level: normalizedEntry.level || 'info',
      }].slice(-150))
      setInstallProgress((prev) => {
        const next = { ...prev }
        if (hasOwn(normalizedEntry, 'stage')) next.stage = normalizedEntry.stage || ''
        if (hasOwn(normalizedEntry, 'status')) {
          // Guard against an Electron IPC race: the main process emits a
          // trailing `status: 'finished'` progress event around the same
          // time the install IPC resolves, and the invoke reply can land
          // BEFORE the broadcast event. That let the broadcast overwrite
          // our UI-managed terminal status ('needs-restart', 'success',
          // 'restarting'), stranding the overlay in the active state.
          // These statuses are set by `runInstallPlan` and its callbacks
          // only; don't let the IPC stream clobber them.
          const UI_TERMINAL_STATES = new Set(['success', 'needs-restart', 'restarting'])
          if (!UI_TERMINAL_STATES.has(prev.status)) {
            next.status = normalizedEntry.status || ''
          }
        }
        if (hasOwn(normalizedEntry, 'message')) {
          const UI_TERMINAL_STATES = new Set(['success', 'needs-restart', 'restarting'])
          if (!UI_TERMINAL_STATES.has(prev.status)) {
            next.message = normalizedEntry.message || ''
          }
        }
        if (hasOwn(normalizedEntry, 'currentLabel')) next.currentLabel = normalizedEntry.currentLabel || ''
        if (hasOwn(normalizedEntry, 'taskType')) next.taskType = normalizedEntry.taskType || ''
        if (hasOwn(normalizedEntry, 'currentTaskIndex')) next.currentTaskIndex = Number(normalizedEntry.currentTaskIndex) || 0
        if (hasOwn(normalizedEntry, 'totalTasks')) next.totalTasks = Number(normalizedEntry.totalTasks) || 0
        if (hasOwn(normalizedEntry, 'completedTasks')) next.completedTasks = Number(normalizedEntry.completedTasks) || 0
        if (hasOwn(normalizedEntry, 'taskPercent')) next.taskPercent = clampProgressPercent(normalizedEntry.taskPercent)
        if (hasOwn(normalizedEntry, 'overallPercent')) next.overallPercent = clampProgressPercent(normalizedEntry.overallPercent) ?? 0
        if (hasOwn(normalizedEntry, 'bytesDownloaded')) next.bytesDownloaded = Number(normalizedEntry.bytesDownloaded) || 0
        if (hasOwn(normalizedEntry, 'totalBytes')) next.totalBytes = Number(normalizedEntry.totalBytes) || 0

        if (!hasOwn(normalizedEntry, 'currentLabel') && parsedMessageProgress?.currentLabel) {
          next.currentLabel = parsedMessageProgress.currentLabel
        }
        if (!hasOwn(normalizedEntry, 'taskType') && parsedMessageProgress?.taskType) {
          next.taskType = parsedMessageProgress.taskType
        }
        if (!hasOwn(normalizedEntry, 'taskPercent') && parsedMessageProgress && parsedMessageProgress.taskPercent !== undefined) {
          next.taskPercent = parsedMessageProgress.taskPercent
        }

        return next
      })
    })
  }, [])

  const handleChooseRoot = useCallback(async () => {
    if (!window?.electronAPI?.selectDirectory) return
    const picked = await window.electronAPI.selectDirectory({
      title: 'Select your ComfyUI folder',
      defaultPath: comfyRootPath || undefined,
    })
    if (!picked) return

    setComfyRootPath(picked)
    await window.electronAPI.setSetting?.(COMFY_ROOT_PATH_SETTING_KEY, picked)
    await handleValidateRoot(picked)
    setStatusMessage('Saved ComfyUI folder.')
  }, [comfyRootPath, handleValidateRoot])

  const handleSaveRootPath = useCallback(async () => {
    const normalized = String(comfyRootPath || '').trim()
    if (window?.electronAPI?.setSetting) {
      await window.electronAPI.setSetting(COMFY_ROOT_PATH_SETTING_KEY, normalized)
    }
    await handleValidateRoot(normalized)
    setStatusMessage(normalized ? 'Saved ComfyUI folder.' : 'Cleared ComfyUI folder.')
  }, [comfyRootPath, handleValidateRoot])

  const handleClearRootPath = useCallback(async () => {
    setComfyRootPath('')
    if (window?.electronAPI?.deleteSetting) {
      await window.electronAPI.deleteSetting(COMFY_ROOT_PATH_SETTING_KEY)
    }
    await handleValidateRoot('')
    setStatusMessage('Cleared saved ComfyUI folder.')
  }, [handleValidateRoot])

  const toggleWorkflowSelected = useCallback((workflowId) => {
    setSelectedWorkflowIds((prev) => (
      prev.includes(workflowId)
        ? prev.filter((entry) => entry !== workflowId)
        : [...prev, workflowId]
    ))
  }, [])

  const toggleWorkflowExpanded = useCallback((workflowId) => {
    setExpandedWorkflowId((prev) => (prev === workflowId ? null : workflowId))
  }, [])

  const handleWorkflowFilterChange = useCallback((filterId) => {
    const nextFilterId = String(filterId || 'all')
    const nextKit = WORKFLOW_SETUP_STARTER_KITS.find((kit) => kit.id === nextFilterId) || null
    const nextIds = new Set(Array.isArray(nextKit?.workflowIds) ? nextKit.workflowIds : [])
    setActiveWorkflowFilterId(nextKit ? nextFilterId : 'all')
    setExpandedWorkflowId((prev) => {
      if (!prev || !nextKit) return prev
      return nextIds.has(prev) ? prev : null
    })
  }, [])

  const handleCopySetupText = useCallback(async (result) => {
    const text = buildWorkflowSetupClipboardText(result)
    await copyTextToClipboard(text)
    setStatusMessage(`Copied setup notes for ${result.workflowLabel}.`)
  }, [])

  const handleOpenWorkflowInComfy = useCallback(async (workflowId) => {
    const result = await openBundledWorkflowInComfyUi(workflowId)
    setStatusMessage(result.success ? result.hint : result.error)
  }, [])

  const runInstallPlan = useCallback(async ({
    plan,
    startMessage,
    successLabel,
    successStatusMessage,
    emptyMessage,
  }) => {
    if (!plan?.hasActionableTasks) {
      setStatusMessage(emptyMessage || 'There is nothing installable in this selection.')
      return
    }

    if (!rootValidation.isValid) {
      setStatusMessage('Choose a valid ComfyUI folder first.')
      return
    }

    if (!window?.electronAPI?.installWorkflowSetup) {
      setStatusMessage('Workflow setup installation is only available in the desktop build.')
      return
    }

    const totalPlannedTasks = (plan.nodePacks?.length || 0) + (plan.models?.length || 0)
    setInstalling(true)
    setShowInstallOverlay(true)
    setInstallLogs([])
    setInstallProgress({
      ...createInitialInstallProgress(),
      stage: 'install',
      status: 'active',
      message: 'Preparing workflow setup install...',
      currentLabel: successLabel || '',
      totalTasks: totalPlannedTasks,
    })
    setStatusMessage(startMessage || 'Installing selected workflow dependencies...')

    try {
      const result = await window.electronAPI.installWorkflowSetup({
        comfyRootPath: rootValidation.normalizedPath || comfyRootPath,
        plan: {
          nodePacks: Array.isArray(plan.nodePacks) ? plan.nodePacks : [],
          models: Array.isArray(plan.models) ? plan.models : [],
        },
      })

      if (!result?.success) {
        setShowInstallOverlay(false)
        setInstalling(false)
        setStatusMessage(result?.error || 'Workflow setup install failed.')
        return
      }

      const customSuccessMessage = successStatusMessage ? successStatusMessage(result) : null

      // If the install doesn't require a restart, close the overlay and
      // re-scan immediately — same as before.
      if (!result.restartRecommended) {
        setInstallProgress((prev) => ({
          ...prev,
          stage: 'install',
          status: 'success',
          message: 'Install complete',
          currentLabel: successLabel || 'Workflow setup ready',
          taskPercent: 100,
          overallPercent: 100,
          completedTasks: prev.totalTasks || prev.completedTasks,
        }))
        await sleep(500)
        setShowInstallOverlay(false)
        setInstalling(false)
        setStatusMessage(customSuccessMessage || 'Install complete. Re-checking workflow dependencies...')
        await handleScanAll()
        return
      }

      // Restart is needed — record it in the pending-restart banner (so it
      // survives dismiss) and park the overlay in a needs-restart state.
      // The user chooses Restart now vs Later; we don't re-scan until
      // ComfyUI actually comes back.
      const newPackLabels = Array.isArray(plan.nodePacks)
        ? plan.nodePacks.map((entry) => entry?.displayName || entry?.label || entry?.id || 'Node pack').filter(Boolean)
        : []
      setPendingRestart((prev) => ({
        installs: [...(prev?.installs || []), ...newPackLabels.map((label) => ({ label }))],
        since: prev?.since || Date.now(),
      }))

      setInstallProgress((prev) => ({
        ...prev,
        stage: 'install',
        status: 'needs-restart',
        message: customSuccessMessage || 'Install complete. Restart ComfyUI to load the new nodes.',
        currentLabel: successLabel || 'Workflow setup ready',
        taskPercent: 100,
        overallPercent: 100,
        completedTasks: prev.totalTasks || prev.completedTasks,
      }))
      setStatusMessage('Install complete. Restart ComfyUI when you\u2019re ready — additional installs will queue up too.')
      // Keep `installing` true so the Install buttons stay disabled until the
      // user either restarts or dismisses. The overlay stays visible with
      // actionable buttons rendered below.
    } catch (error) {
      setShowInstallOverlay(false)
      setInstalling(false)
      setStatusMessage(error instanceof Error ? error.message : 'Workflow setup install failed.')
    }
  }, [comfyRootPath, handleScanAll, rootValidation])

  const handleRestartAfterInstall = useCallback(async () => {
    const snapshot = isComfyLauncherAvailable() ? getComfyLauncherSnapshot() : null
    const ownsRunning = Boolean(snapshot
      && snapshot.ownership === 'ours'
      && (snapshot.state === 'running' || snapshot.state === 'starting'))
    const canStart = Boolean(snapshot
      && (snapshot.state === 'idle' || snapshot.state === 'stopped' || snapshot.state === 'crashed')
      && snapshot.launcherScript)
    const isExternal = snapshot?.state === 'external'

    if (!ownsRunning && !canStart) {
      setShowInstallOverlay(false)
      setInstalling(false)
      setStatusMessage(isExternal
        ? 'Restart ComfyUI in the window where you started it, then run Re-check. Tip: start ComfyUI from the header chip next time for one-click restarts.'
        : 'No launcher configured — open Settings → ComfyUI Launcher to pick your run_nvidia_gpu.bat, or restart ComfyUI manually.')
      return
    }

    setInstallProgress((prev) => ({
      ...prev,
      stage: 'restart',
      status: 'restarting',
      message: ownsRunning
        ? 'Restarting ComfyUI so the new nodes load.'
        : 'Starting ComfyUI so the new nodes load.',
      currentLabel: ownsRunning ? 'Restarting ComfyUI' : 'Starting ComfyUI',
      taskPercent: null,
    }))

    const actionResult = ownsRunning ? await restartComfyLauncher() : await startComfyLauncher()
    if (actionResult?.success === false) {
      setShowInstallOverlay(false)
      setInstalling(false)
      setStatusMessage(`Failed to ${ownsRunning ? 'restart' : 'start'} ComfyUI: ${actionResult?.error || 'unknown error.'}`)
      return
    }

    const wait = await waitForComfyLauncherState(['running', 'external'], { timeoutMs: 180_000 })
    setShowInstallOverlay(false)
    setInstalling(false)

    if (wait.timedOut || wait.state?.state !== 'running') {
      setStatusMessage('ComfyUI did not come back within 3 minutes. Check the launcher chip for logs, then Re-check when it is ready.')
      return
    }

    setPendingRestart(null)
    setStatusMessage(ownsRunning
      ? 'ComfyUI restarted — dependencies refreshed.'
      : 'ComfyUI started — dependencies refreshed.')
    await handleScanAll()
  }, [handleScanAll])

  const handleDismissRestartOverlay = useCallback(() => {
    setShowInstallOverlay(false)
    setInstalling(false)
    setStatusMessage('Install complete. Restart ComfyUI when you\u2019re ready — the banner above will remind you.')
  }, [])

  const handleDismissPendingRestart = useCallback(() => {
    setPendingRestart(null)
  }, [])

  const handleInstallSelected = useCallback(async () => {
    await runInstallPlan({
      plan: installPlan,
      startMessage: 'Installing selected workflow dependencies...',
      successLabel: 'Workflow setup ready',
      successStatusMessage: (result) => (
        result.restartRecommended
          ? 'Install complete. Restart ComfyUI, then run Re-check again.'
          : 'Install complete. Re-checking workflow dependencies...'
      ),
      emptyMessage: 'Select at least one workflow with actionable installs first.',
    })
  }, [installPlan, runInstallPlan])

  const handleInstallWorkflow = useCallback(async (result) => {
    const singlePlan = buildWorkflowInstallPlan(workflowResults, [result.workflowId])
    await runInstallPlan({
      plan: singlePlan,
      startMessage: `Installing missing dependencies for ${result.workflowLabel}...`,
      successLabel: `${result.workflowLabel} ready`,
      successStatusMessage: (installResult) => (
        installResult.restartRecommended
          ? `${result.workflowLabel} install complete. Restart ComfyUI, then run Re-check again.`
          : `${result.workflowLabel} install complete. Re-checking workflow dependencies...`
      ),
      emptyMessage: `${result.workflowLabel} does not have any curated installs available.`,
    })
  }, [runInstallPlan, workflowResults])

  const handleSelectVisibleInstallable = useCallback(() => {
    if (visibleActionableWorkflowIds.length === 0) {
      const label = activeWorkflowFilter?.label || 'this view'
      setStatusMessage(`No curated installs are available for ${label}. Expand the visible rows for manual steps or API-key setup.`)
      return
    }

    setSelectedWorkflowIds((prev) => {
      const next = new Set(prev)
      for (const workflowId of visibleActionableWorkflowIds) next.add(workflowId)
      return Array.from(next)
    })
    setStatusMessage(`Selected ${visibleActionableWorkflowIds.length} installable workflow${visibleActionableWorkflowIds.length === 1 ? '' : 's'} from ${activeWorkflowFilter?.label || 'the current view'}.`)
  }, [activeWorkflowFilter?.label, visibleActionableWorkflowIds])

  const workflowCount = getWorkflowSetupWorkflows().length
  const actionableWorkflowCount = workflowResults.filter((result) => result.hasActionableInstalls).length
  const readyWorkflowCount = workflowResults.filter((result) => result.setupStatus === 'ready').length
  const currentInstallPercent = clampProgressPercent(installProgress.taskPercent)
  const overallInstallPercent = clampProgressPercent(installProgress.overallPercent) ?? 0
  const computedOverallPercent = installProgress.totalTasks > 0
    ? Math.max(
        overallInstallPercent,
        Math.min(
          100,
          Math.round(
            (
              Math.max(0, Math.min(installProgress.totalTasks, installProgress.currentTaskIndex > 0 ? installProgress.currentTaskIndex - 1 : installProgress.completedTasks))
              + ((currentInstallPercent ?? 0) / 100)
            ) / installProgress.totalTasks * 100
          )
        )
      )
    : overallInstallPercent
  const overlayProgressPercent = currentInstallPercent != null
    ? currentInstallPercent
    : installProgress.currentTaskIndex > 0 && installProgress.totalTasks > 0
      ? Math.max(
          computedOverallPercent,
          Math.min(100, Math.round(((installProgress.currentTaskIndex - 0.35) / installProgress.totalTasks) * 100))
        )
      : computedOverallPercent
  const isInstallSuccessState = installProgress.status === 'success'
  const isInstallRestartingState = installProgress.status === 'restarting'
  const isInstallNeedsRestartState = installProgress.status === 'needs-restart'
  const launcherOwnsLive = Boolean(launcherState
    && launcherState.ownership === 'ours'
    && (launcherState.state === 'running' || launcherState.state === 'starting'))
  const launcherCanStart = Boolean(launcherState
    && (launcherState.state === 'idle' || launcherState.state === 'stopped' || launcherState.state === 'crashed')
    && launcherState.launcherScript)
  const launcherIsExternal = launcherState?.state === 'external'
  const canRestartViaLauncher = launcherOwnsLive || launcherCanStart
  const restartCtaLabel = launcherOwnsLive
    ? 'Restart ComfyUI now'
    : launcherCanStart
      ? 'Start ComfyUI now'
      : 'Restart ComfyUI manually'
  const pendingRestartCount = pendingRestart?.installs?.length || 0
  const pendingRestartLabelPreview = (pendingRestart?.installs || [])
    .slice(-3)
    .map((entry) => entry?.label)
    .filter(Boolean)
    .join(', ')
  const overlayTitle = isInstallSuccessState
    ? 'Workflow setup ready'
    : installProgress.currentLabel
    || (installProgress.taskType === 'node-pack'
      ? 'Installing node pack...'
      : installProgress.taskType === 'model'
        ? 'Downloading model...'
        : 'Preparing workflow setup install...')
  const overlayStepLabel = installProgress.currentTaskIndex > 0 && installProgress.totalTasks > 0
    ? `${Math.min(installProgress.currentTaskIndex, installProgress.totalTasks)} of ${installProgress.totalTasks}`
    : null
  const overlayProgressLabel = isInstallSuccessState
    ? 'Complete'
    : currentInstallPercent != null
    ? `${Math.round(currentInstallPercent)}%`
    : `${Math.round(computedOverallPercent)}%`
  const showOverallSummary = installProgress.totalTasks > 1
  const overlayMetaLabel = isInstallSuccessState
    ? 'All selected workflow dependencies finished installing.'
    : showOverallSummary
      ? `${Math.round(computedOverallPercent)}% overall`
      : null

  return (
    <div className="space-y-3">
      {showInstallOverlay && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/78 backdrop-blur-sm p-4">
          <div className="w-full max-w-xl rounded-2xl border border-sf-dark-600 bg-sf-dark-900/95 shadow-2xl">
            <div className="border-b border-sf-dark-700 px-5 py-4">
              <div className="flex items-center gap-3">
                <div className={`flex h-10 w-10 items-center justify-center rounded-2xl ${
                  isInstallSuccessState
                    ? 'bg-green-500/15 text-green-400'
                    : isInstallNeedsRestartState
                      ? 'bg-amber-500/15 text-amber-300'
                      : isInstallRestartingState
                        ? 'bg-sky-500/15 text-sky-400'
                        : 'bg-sf-accent/15 text-sf-accent'
                }`}>
                  {isInstallSuccessState ? (
                    <CheckCircle2 className="h-5 w-5" />
                  ) : isInstallNeedsRestartState ? (
                    <AlertTriangle className="h-5 w-5" />
                  ) : (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-sf-text-primary">
                    {isInstallSuccessState
                      ? 'Install Complete'
                      : isInstallNeedsRestartState
                        ? 'Install Complete — Restart ComfyUI'
                        : isInstallRestartingState
                          ? 'Restarting ComfyUI'
                          : 'Installing Workflow Dependencies'}
                  </div>
                  <div className="mt-0.5 text-[11px] text-sf-text-muted">
                    {isInstallSuccessState
                      ? 'Everything selected finished successfully'
                      : isInstallNeedsRestartState
                        ? 'New node packs won\u2019t load until ComfyUI restarts'
                        : isInstallRestartingState
                          ? 'Loading newly installed nodes'
                          : overlayStepLabel
                            ? `Step ${overlayStepLabel}`
                            : 'Preparing install plan'}
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div>
                <div className="text-xs uppercase tracking-[0.18em] text-sf-text-muted">
                  {isInstallSuccessState || isInstallRestartingState || isInstallNeedsRestartState
                    ? 'Status'
                    : installProgress.taskType === 'model'
                      ? 'Current Model'
                      : installProgress.taskType === 'node-pack'
                        ? 'Current Node Pack'
                        : 'Current Task'}
                </div>
                <div className="mt-2 truncate text-lg font-medium text-sf-text-primary">{overlayTitle}</div>
                <div className="mt-1 text-sm text-sf-text-secondary">
                  {isInstallSuccessState
                    ? 'Install complete'
                    : isInstallNeedsRestartState
                      ? (installProgress.message || 'Install complete. Restart ComfyUI to load the new nodes.')
                      : isInstallRestartingState
                        ? (installProgress.message || 'Waiting for ComfyUI to come back…')
                        : (installProgress.message || 'Working...')}
                </div>
                {isInstallNeedsRestartState && pendingRestartCount > 1 && (
                  <div className="mt-2 text-[11px] text-sf-text-muted">
                    {pendingRestartCount} node pack{pendingRestartCount === 1 ? '' : 's'} installed this session{pendingRestartLabelPreview ? ` (latest: ${pendingRestartLabelPreview})` : ''}.
                  </div>
                )}
                {isInstallNeedsRestartState && launcherIsExternal && (
                  <div className="mt-3 rounded border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-[11.5px] text-sky-100">
                    ComfyUI is running outside ComfyStudio — restart it in that window, or stop it and let ComfyStudio manage the next launch (the header chip has Start/Stop/Restart).
                  </div>
                )}
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-3 text-sm">
                  <span className="text-sf-text-secondary">Progress</span>
                  <span className="font-medium text-sf-text-primary">{overlayProgressLabel}</span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-sf-dark-700">
                  <div
                    className={`h-full rounded-full bg-gradient-to-r from-sf-accent to-cyan-400 transition-[width] duration-300 ${
                      (currentInstallPercent == null && !isInstallSuccessState && !isInstallNeedsRestartState) || isInstallRestartingState ? 'animate-pulse' : ''
                    }`}
                    style={{ width: `${isInstallRestartingState ? 100 : overlayProgressPercent}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-sf-text-muted">
                  <span>{overlayMetaLabel || ''}</span>
                  <span>
                    {isInstallSuccessState
                      ? 'Closing...'
                      : isInstallNeedsRestartState
                        ? 'Awaiting your call'
                        : isInstallRestartingState
                          ? (launcherState?.state === 'starting' ? 'Booting ComfyUI…' : 'Waiting for /system_stats…')
                          : installProgress.totalBytes > 0
                            ? `${formatBytes(installProgress.bytesDownloaded)} / ${formatBytes(installProgress.totalBytes)}`
                            : installProgress.taskType === 'node-pack'
                              ? 'Running install commands...'
                              : 'Preparing download...'}
                  </span>
                </div>
              </div>

              {isInstallNeedsRestartState && (
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end pt-1">
                  <button
                    type="button"
                    onClick={handleDismissRestartOverlay}
                    className="rounded px-3 py-2 text-xs font-medium text-sf-text-secondary hover:bg-sf-dark-700 transition-colors"
                  >
                    I&apos;ll restart later
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleRestartAfterInstall() }}
                    disabled={!canRestartViaLauncher}
                    className={`inline-flex items-center justify-center gap-1.5 rounded px-3 py-2 text-xs font-semibold transition-colors ${canRestartViaLauncher
                      ? 'bg-sf-accent hover:bg-sf-accent-hover text-white'
                      : 'bg-sf-dark-700 text-sf-text-muted cursor-not-allowed'
                    }`}
                    title={canRestartViaLauncher ? '' : 'Configure your launcher in Settings → ComfyUI Launcher first'}
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    {restartCtaLabel}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-sf-accent" />
              <span className="text-sm font-medium text-sf-text-primary">Workflow Setup Manager</span>
            </div>
            <p className="mt-1 text-[11px] text-sf-text-secondary">
              Check every built-in workflow, download curated local models in-app, and surface the remaining manual steps when automation is unsafe.
            </p>
          </div>
          <button
            type="button"
            onClick={() => { void handleScanAll() }}
            disabled={scanState === 'checking'}
            className={`inline-flex items-center gap-1 rounded px-3 py-1.5 text-xs transition-colors ${
              scanState === 'checking'
                ? 'bg-sf-dark-700 text-sf-text-muted cursor-not-allowed'
                : 'bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-secondary'
            }`}
          >
            {scanState === 'checking' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Re-check all
          </button>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <InstallSummaryRow label="Built-in workflows tracked" value={String(workflowCount)} />
          <InstallSummaryRow label="Ready right now" value={String(readyWorkflowCount)} tone="text-green-400" />
          <InstallSummaryRow label="Workflows with auto installs" value={String(actionableWorkflowCount)} tone="text-orange-300" />
          <InstallSummaryRow
            label="Local ComfyUI connection"
            value={connectionState.message}
            tone={connectionState.status === 'success' ? 'text-green-400' : connectionState.status === 'offline' ? 'text-sf-error' : 'text-sf-text-secondary'}
          />
        </div>
      </div>

      {pendingRestart && !showInstallOverlay && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-300 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0 text-[12px] text-amber-100">
            <div className="font-semibold">
              {pendingRestartCount > 1
                ? `${pendingRestartCount} node packs installed — restart ComfyUI to load them.`
                : 'Node pack installed — restart ComfyUI to load it.'}
            </div>
            <div className="mt-0.5 text-amber-100/80">
              {launcherIsExternal
                ? 'ComfyUI is running outside ComfyStudio — restart it in that window, or stop it and let ComfyStudio manage the next launch.'
                : canRestartViaLauncher
                  ? 'Install more node packs if you\u2019d like, then restart once to apply them all.'
                  : 'No launcher configured. Open Settings → ComfyUI Launcher to set one, or restart manually.'}
              {pendingRestartLabelPreview && (
                <span className="block mt-1 text-amber-100/60 truncate" title={pendingRestartLabelPreview}>
                  Latest: {pendingRestartLabelPreview}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              type="button"
              onClick={() => { void handleRestartAfterInstall() }}
              disabled={!canRestartViaLauncher}
              className={`inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${canRestartViaLauncher
                ? 'bg-amber-500 hover:bg-amber-400 text-amber-950'
                : 'bg-sf-dark-700 text-sf-text-muted cursor-not-allowed'
              }`}
            >
              <RefreshCw className="w-3 h-3" />
              {restartCtaLabel}
            </button>
            <button
              type="button"
              onClick={handleDismissPendingRestart}
              className="p-1 rounded text-amber-100/70 hover:text-amber-100 hover:bg-amber-500/20 transition-colors"
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 p-3">
        <div className="flex items-center gap-2">
          <FolderSearch className="w-4 h-4 text-sf-text-muted" />
          <span className="text-sm font-medium text-sf-text-primary">ComfyUI Folder</span>
        </div>

        <p className="mt-1 text-[11px] text-sf-text-secondary">
          Auto-install needs the root of your local ComfyUI install so ComfyStudio knows where to place custom nodes and models.
        </p>

        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={comfyRootPath}
            onChange={(event) => setComfyRootPath(event.target.value)}
            onBlur={() => { void handleSaveRootPath() }}
            placeholder="C:\\ComfyUI"
            className="flex-1 min-w-0 bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
          />
          <button
            type="button"
            onClick={() => { void handleChooseRoot() }}
            className="px-3 py-2 rounded bg-sf-dark-700 hover:bg-sf-dark-600 text-xs text-sf-text-secondary transition-colors"
          >
            Choose
          </button>
          <button
            type="button"
            onClick={() => { void handleClearRootPath() }}
            className="px-3 py-2 rounded bg-sf-dark-700 hover:bg-sf-dark-600 text-xs text-sf-text-secondary transition-colors"
          >
            Clear
          </button>
        </div>

        <div className="mt-3 space-y-1.5 text-[11px]">
          <div className={`flex items-center gap-2 ${rootValidation.isValid ? 'text-green-400' : 'text-yellow-300'}`}>
            {rootValidation.isValid ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
            <span>{rootValidation.isValid ? 'ComfyUI folder looks valid.' : (rootValidation.error || 'Select your ComfyUI folder to enable installs.')}</span>
          </div>
          {rootValidation.normalizedPath && (
            <div className="text-sf-text-muted">Root: {rootValidation.normalizedPath}</div>
          )}
          {rootValidation.modelsPath && (
            <div className="text-sf-text-muted">Models: {rootValidation.modelsPath}</div>
          )}
          {rootValidation.extraModelPathCount > 0 && (
            <div className="text-sf-text-muted">
              Extra model paths: {rootValidation.extraModelPathCount} from {rootValidation.extraModelConfigPath || 'extra_model_paths.yaml'}
            </div>
          )}
          {rootValidation.customNodesPath && (
            <div className="text-sf-text-muted">Custom nodes: {rootValidation.customNodesPath}</div>
          )}
          {rootValidation.pythonCommand && (
            <div className="text-sf-text-muted">Python: {rootValidation.pythonCommand}</div>
          )}
          {rootValidation.warnings.map((warning) => (
            <div key={warning} className="text-yellow-300">{warning}</div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 p-3">
        <div className="flex items-center gap-2">
          <Download className="w-4 h-4 text-sf-text-muted" />
          <span className="text-sm font-medium text-sf-text-primary">Install Plan</span>
        </div>

        <p className="mt-1 text-[11px] text-sf-text-secondary">
          Select the workflows you want to prepare. The app only attempts curated installs; anything else stays visible as a manual follow-up.
        </p>

        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <InstallSummaryRow label="Selected workflows" value={String(selectedWorkflowIds.length)} />
          <InstallSummaryRow label="Downloadable models" value={String(installPlan.models.length)} tone="text-orange-300" />
          <InstallSummaryRow label="Installable node packs" value={String(installPlan.nodePacks.length)} tone="text-orange-300" />
          <InstallSummaryRow label="Manual follow-ups" value={String(installPlan.manualNodes.length + installPlan.manualModels.length + installPlan.coreNodes.length + installPlan.authWorkflows.length)} tone="text-yellow-300" />
        </div>

        {installPlan.hasActionableTasks && (
          <div className="mt-3 rounded border border-sf-dark-700 bg-sf-dark-950/70 p-3 text-[11px] text-sf-text-secondary space-y-1.5">
            {installPlan.models.length > 0 && (
              <div>{`Will download ${installPlan.models.length} model${installPlan.models.length === 1 ? '' : 's'} into your ComfyUI models folders.`}</div>
            )}
            {installPlan.nodePacks.length > 0 && (
              <div>{`Will install or update ${installPlan.nodePacks.length} curated custom-node pack${installPlan.nodePacks.length === 1 ? '' : 's'}.`}</div>
            )}
            {installPlan.restartRecommended && (
              launcherOwnsLive ? (
                <div className="text-emerald-300">Once the install finishes, ComfyStudio will ask if you want to restart ComfyUI now or batch more installs first.</div>
              ) : launcherCanStart ? (
                <div className="text-emerald-300">After install, ComfyStudio will offer to start ComfyUI so the new nodes load.</div>
              ) : launcherIsExternal ? (
                <div className="text-yellow-300">Restart ComfyUI manually after install so the new nodes load. (Start it from the header chip next time for one-click restarts.)</div>
              ) : (
                <div className="text-yellow-300">If any node packs change, restart ComfyUI after install before you trust the next dependency check.</div>
              )
            )}
          </div>
        )}

        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="text-[11px] text-sf-text-muted">
            Section ID: <code>{WORKFLOW_SETUP_SECTION_ID}</code>
          </div>
          <button
            type="button"
            onClick={() => { void handleInstallSelected() }}
            disabled={installing || !installPlan.hasActionableTasks || !rootValidation.isValid}
            className={`inline-flex items-center gap-1 rounded px-3 py-2 text-xs transition-colors ${
              installing || !installPlan.hasActionableTasks || !rootValidation.isValid
                ? 'bg-sf-dark-700 text-sf-text-muted cursor-not-allowed'
                : 'bg-sf-accent text-white hover:bg-sf-accent-hover'
            }`}
          >
            {installing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />}
            Install selected
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-sf-accent" />
              <span className="text-sm font-medium text-sf-text-primary">Workflow filters</span>
            </div>
            <p className="mt-1 max-w-3xl text-[11px] text-sf-text-secondary">
              Narrow the library by runtime, or show the small bundle needed for music video generation.
            </p>
          </div>
          <button
            type="button"
            onClick={handleSelectVisibleInstallable}
            disabled={visibleWorkflowResults.length === 0}
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded border border-sf-dark-600 px-3 py-2 text-xs font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Wrench className="h-3.5 w-3.5" />
            Select installable in view
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => handleWorkflowFilterChange('all')}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              activeWorkflowFilterId === 'all'
                ? 'border-sf-accent bg-sf-accent/15 text-sf-text-primary'
                : 'border-sf-dark-600 text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary'
            }`}
          >
            All workflows
          </button>
          {WORKFLOW_SETUP_STARTER_KITS.map((kit) => (
            <button
              key={kit.id}
              type="button"
              onClick={() => handleWorkflowFilterChange(kit.id)}
              title={kit.description}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                activeWorkflowFilterId === kit.id
                  ? 'border-sf-accent bg-sf-accent/15 text-sf-text-primary'
                  : 'border-sf-dark-600 text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary'
              }`}
            >
              {kit.label}
            </button>
          ))}
        </div>
        {activeWorkflowFilter && (
          <div className="mt-3 rounded border border-sf-dark-700 bg-sf-dark-950/60 px-3 py-2 text-[11px] text-sf-text-secondary">
            <span className="font-medium text-sf-text-primary">{activeWorkflowFilter.label}:</span> {activeWorkflowFilter.tagline}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="text-sm font-medium text-sf-text-primary">Workflow library</div>
            <p className="mt-0.5 max-w-2xl text-[11px] text-sf-text-secondary">
              Browse {activeWorkflowFilter ? `${visibleWorkflowResults.length} filtered` : 'bundled'} workflows in a visual grid, or switch to list view. Expand a row or card for full dependency details.
            </p>
          </div>
          <div className="inline-flex shrink-0 rounded-lg border border-sf-dark-600 p-0.5">
            <button
              type="button"
              onClick={() => setSetupViewMode('gallery')}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                setupViewMode === 'gallery'
                  ? 'bg-sf-dark-700 text-sf-text-primary'
                  : 'text-sf-text-muted hover:text-sf-text-secondary'
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              Gallery
            </button>
            <button
              type="button"
              onClick={() => setSetupViewMode('list')}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                setupViewMode === 'list'
                  ? 'bg-sf-dark-700 text-sf-text-primary'
                  : 'text-sf-text-muted hover:text-sf-text-secondary'
              }`}
            >
              <List className="h-3.5 w-3.5" />
              List
            </button>
          </div>
        </div>

        {setupViewMode === 'gallery' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {visibleWorkflowResults.map((result) => {
              const isExpanded = expandedWorkflowId === result.workflowId
              const isSelected = selectedWorkflowIds.includes(result.workflowId)
              const statusMeta = getStatusMeta(result)
              const canInstallWorkflow = result.hasActionableInstalls && rootValidation.isValid && !installing
              const galleryMeta = getWorkflowSetupGalleryMeta(result.workflowId)

              const handleCardActivate = () => toggleWorkflowExpanded(result.workflowId)
              const handleCardKeyDown = (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  handleCardActivate()
                }
              }
              return (
                <div
                  key={result.workflowId}
                  className={`min-w-0 ${isExpanded ? 'col-span-full' : ''}`}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onClick={handleCardActivate}
                    onKeyDown={handleCardKeyDown}
                    className={`group flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-sf-dark-900/65 text-left shadow-sm transition-colors hover:border-sf-dark-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent ${
                      isExpanded ? 'border-sf-accent/60 ring-1 ring-sf-accent/30' : 'border-sf-dark-700'
                    }`}
                    title={isExpanded ? 'Hide details' : 'Open details'}
                  >
                    <div className={`relative aspect-[16/10] bg-gradient-to-br ${galleryMeta.gradient}`}>
                      <div
                        className="absolute left-2 top-2 z-20"
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={!result.hasActionableInstalls}
                          onChange={() => toggleWorkflowSelected(result.workflowId)}
                          className="rounded border-sf-dark-500 bg-sf-dark-800"
                          title={result.hasActionableInstalls ? 'Include in batch install' : 'No curated installs for this workflow'}
                        />
                      </div>
                      <div className="absolute right-2 top-2 z-20 max-w-[60%]">
                        <StatusChipOnMedia statusMeta={statusMeta} />
                      </div>
                      {galleryMeta.thumbnailSrc ? (
                        <>
                          <img
                            src={galleryMeta.thumbnailSrc}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            draggable={false}
                            onError={(event) => {
                              event.currentTarget.style.display = 'none'
                            }}
                            style={galleryMeta.invertColors ? { filter: 'invert(1)' } : undefined}
                            className="absolute inset-0 h-full w-full object-cover"
                          />
                          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-14 bg-gradient-to-b from-black/55 to-transparent" />
                          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-16 bg-gradient-to-t from-black/65 to-transparent" />
                        </>
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <WorkflowGalleryHeroIcon name={galleryMeta.icon} className="h-14 w-14 text-white/90 drop-shadow-md" />
                        </div>
                      )}
                      <div className="pointer-events-none absolute bottom-2 left-2 right-2 z-10 flex flex-wrap gap-1">
                        {galleryMeta.badges.slice(0, 5).map((badge) => (
                          <span
                            key={badge}
                            className="rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium text-white/95 ring-1 ring-white/10"
                          >
                            {badge}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-1 flex-col gap-2 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-sf-text-primary line-clamp-2">{result.workflowLabel}</div>
                          <p className="mt-1 line-clamp-2 text-[11px] text-sf-text-muted">{galleryMeta.description}</p>
                        </div>
                        {isExpanded ? (
                          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-sf-text-muted transition-transform" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-sf-text-muted transition-transform group-hover:text-sf-text-secondary" aria-hidden="true" />
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-sf-text-muted">
                        <Boxes className="h-3.5 w-3.5 shrink-0" />
                        <span>Node graph</span>
                        <span className="text-sf-dark-600">·</span>
                        <span>{result.missingNodes.length} node</span>
                        <span>·</span>
                        <span>{result.missingModels.length} model</span>
                        {result.missingAuth ? (
                          <>
                            <span>·</span>
                            <span className="text-yellow-300/90">API key</span>
                          </>
                        ) : null}
                      </div>
                      {result.hasActionableInstalls && (
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              void handleInstallWorkflow(result)
                            }}
                            disabled={!canInstallWorkflow}
                            className={`inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-[10px] font-medium transition-colors ${
                              canInstallWorkflow
                                ? 'border border-orange-400/35 bg-orange-400/15 text-orange-200 hover:border-orange-300/45 hover:bg-orange-400/20'
                                : 'cursor-not-allowed border border-sf-dark-600 bg-sf-dark-800 text-sf-text-muted'
                            }`}
                            title={rootValidation.isValid ? 'Install missing dependencies for this workflow' : 'Choose a valid ComfyUI folder first'}
                          >
                            {installing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
                            Install missing
                          </button>
                        </div>
                      )}
                    </div>

                    {isExpanded && (
                      <div onClick={(event) => event.stopPropagation()}>
                        <WorkflowSetupExpandedBody
                          result={result}
                          rootValidation={rootValidation}
                          installing={installing}
                          galleryMeta={galleryMeta}
                          onCopySetup={handleCopySetupText}
                          onOpenComfy={handleOpenWorkflowInComfy}
                          onInstallWorkflow={handleInstallWorkflow}
                          onConfigureApiKey={() => setApiKeyDialogOpen(true)}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="space-y-2">
            {visibleWorkflowResults.map((result) => {
              const isExpanded = expandedWorkflowId === result.workflowId
              const isSelected = selectedWorkflowIds.includes(result.workflowId)
              const statusMeta = getStatusMeta(result)
              const canInstallWorkflow = result.hasActionableInstalls && rootValidation.isValid && !installing
              const galleryMeta = getWorkflowSetupGalleryMeta(result.workflowId)

              return (
                <div key={result.workflowId} className="overflow-hidden rounded-lg border border-sf-dark-700 bg-sf-dark-900/60">
                  <div className="flex items-center gap-2 px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={!result.hasActionableInstalls}
                      onChange={() => toggleWorkflowSelected(result.workflowId)}
                      className="rounded border-sf-dark-500 bg-sf-dark-800"
                    />
                    <button
                      type="button"
                      onClick={() => toggleWorkflowExpanded(result.workflowId)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      {isExpanded ? <ChevronDown className="h-4 w-4 shrink-0 text-sf-text-muted" /> : <ChevronRight className="h-4 w-4 shrink-0 text-sf-text-muted" />}
                      <div className={`relative h-9 w-14 shrink-0 overflow-hidden rounded border border-sf-dark-700 bg-gradient-to-br ${galleryMeta.gradient}`}>
                        {galleryMeta.thumbnailSrc ? (
                          <img
                            src={galleryMeta.thumbnailSrc}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            draggable={false}
                            onError={(event) => { event.currentTarget.style.display = 'none' }}
                            style={galleryMeta.invertColors ? { filter: 'invert(1)' } : undefined}
                            className="absolute inset-0 h-full w-full object-cover"
                          />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <WorkflowGalleryHeroIcon name={galleryMeta.icon} className="h-4 w-4 text-white/85" />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-sf-text-primary">{result.workflowLabel}</div>
                        <div className="text-[10px] text-sf-text-muted">
                          {result.missingNodes.length} node issue(s), {result.missingModels.length} model issue(s), {result.missingAuth ? 'API key missing' : 'API key ok'}
                        </div>
                      </div>
                    </button>
                    {result.hasActionableInstalls && (
                      <button
                        type="button"
                        onClick={() => { void handleInstallWorkflow(result) }}
                        disabled={!canInstallWorkflow}
                        className={`inline-flex flex-shrink-0 items-center gap-1 rounded px-2.5 py-1.5 text-[10px] font-medium transition-colors ${
                          canInstallWorkflow
                            ? 'border border-orange-400/35 bg-orange-400/15 text-orange-200 hover:border-orange-300/45 hover:bg-orange-400/20'
                            : 'cursor-not-allowed border border-sf-dark-600 bg-sf-dark-800 text-sf-text-muted'
                        }`}
                        title={rootValidation.isValid ? 'Install missing dependencies for this workflow' : 'Choose a valid ComfyUI folder first'}
                      >
                        {installing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
                        Install Missing
                      </button>
                    )}
                    <div className={`rounded-full border px-2 py-1 text-[10px] font-medium ${statusMeta.tone}`}>
                      {statusMeta.label}
                    </div>
                  </div>

                  {isExpanded && (
                    <WorkflowSetupExpandedBody
                      result={result}
                      rootValidation={rootValidation}
                      installing={installing}
                      galleryMeta={galleryMeta}
                      onCopySetup={handleCopySetupText}
                      onOpenComfy={handleOpenWorkflowInComfy}
                      onInstallWorkflow={handleInstallWorkflow}
                      onConfigureApiKey={() => setApiKeyDialogOpen(true)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {(statusMessage || installLogs.length > 0) && (
        <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 p-3 space-y-2">
          {statusMessage && (
            <div className="text-[11px] text-sf-text-secondary">{statusMessage}</div>
          )}
          {installLogs.length > 0 && (
            <div className="max-h-48 overflow-y-auto rounded border border-sf-dark-700 bg-sf-dark-950/70 p-2 space-y-1">
              {installLogs.map((entry) => (
                <div
                  key={entry.id}
                  className={`text-[10px] ${
                    entry.level === 'error'
                      ? 'text-sf-error'
                      : entry.level === 'warning'
                        ? 'text-yellow-300'
                        : 'text-sf-text-secondary'
                  }`}
                >
                  {entry.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <ApiKeyDialog
        open={apiKeyDialogOpen}
        onClose={() => setApiKeyDialogOpen(false)}
      />
    </div>
  )
})

export default WorkflowSetupSection
