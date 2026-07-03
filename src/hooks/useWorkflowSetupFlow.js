import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildWorkflowInstallPlan,
  enrichWorkflowDependencyResult,
} from '../services/workflowSetupManager'
import {
  getComfyLauncherSnapshot,
  isComfyLauncherAvailable,
  restartComfyLauncher,
  startComfyLauncher,
  waitForComfyLauncherState,
} from '../services/comfyLauncher'

const COMFY_ROOT_PATH_SETTING_KEY = 'comfyRootPath'
// Downloads need working room beyond the payload itself (temp files, other
// writers on the same volume while a multi-GB pull is in flight).
const DISK_SPACE_HEADROOM_BYTES = 1024 * 1024 * 1024

export function formatBytes(value) {
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

function createInitialProgress() {
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

function parseProgressFromMessage(message) {
  const text = String(message || '').trim()
  if (!text) return null

  const downloadMatch = text.match(/^Downloading\s+(.+?):\s+(\d+)%$/i)
  if (downloadMatch) {
    return {
      currentLabel: downloadMatch[1],
      taskPercent: clampProgressPercent(Number(downloadMatch[2])),
    }
  }

  const downloadStartMatch = text.match(/^Downloading\s+(.+?)\.\.\.$/i)
  if (downloadStartMatch) {
    return { currentLabel: downloadStartMatch[1], taskPercent: 0 }
  }

  return null
}

function getRestartCapability() {
  if (!isComfyLauncherAvailable()) return 'none'
  const snapshot = getComfyLauncherSnapshot()
  if (!snapshot) return 'none'
  if (snapshot.ownership === 'ours' && (snapshot.state === 'running' || snapshot.state === 'starting')) {
    return 'restart'
  }
  if ((snapshot.state === 'idle' || snapshot.state === 'stopped' || snapshot.state === 'crashed') && snapshot.launcherScript) {
    return 'start'
  }
  if (snapshot.state === 'external') return 'external'
  return 'none'
}

/**
 * In-context workflow setup flow for the Generate tab.
 *
 * Wraps the reusable services behind one state machine so the Run button can
 * become "Set up — X GB" when the selected workflow has missing dependencies:
 *   idle -> installing -> (needs-restart -> restarting) -> idle
 *
 * Takes the raw `dependencyCheck` result GenerateWorkspace already maintains,
 * plus its recheck callback; owns the install plan, comfy-root validation,
 * disk-space guard, install progress, and the post-install restart.
 */
export function useWorkflowSetupFlow({ dependencyCheck, isConnected, recheck }) {
  const [phase, setPhase] = useState('idle')
  const [phaseError, setPhaseError] = useState('')
  const [progress, setProgress] = useState(createInitialProgress)
  const [rootValidation, setRootValidation] = useState({ checked: false, isValid: false, normalizedPath: '', error: '' })
  const [diskSpace, setDiskSpace] = useState({ checked: false, freeBytes: null })
  const [restartCapability, setRestartCapability] = useState('none')
  const phaseRef = useRef('idle')
  const installTokenRef = useRef(0)

  const setFlowPhase = useCallback((nextPhase, error = '') => {
    phaseRef.current = nextPhase
    setPhase(nextPhase)
    setPhaseError(error)
  }, [])

  const enriched = useMemo(() => {
    if (!dependencyCheck?.hasPack) return null
    if (dependencyCheck.status === 'checking' || dependencyCheck.status === 'idle') return null
    return enrichWorkflowDependencyResult(dependencyCheck)
  }, [dependencyCheck])

  const plan = useMemo(() => {
    if (!enriched) return null
    return buildWorkflowInstallPlan([enriched], [enriched.workflowId])
  }, [enriched])

  const items = useMemo(() => {
    if (!plan) return []
    const out = []
    for (const pack of plan.nodePacks || []) {
      out.push({
        key: `nodes:${pack.id}`,
        kind: 'nodes',
        label: pack.displayName || pack.id,
        detail: 'Custom nodes',
        sizeBytes: null,
        auto: true,
      })
    }
    for (const model of plan.models || []) {
      out.push({
        key: `model:${model.targetSubdir}:${model.filename}`,
        kind: 'model',
        label: model.displayName || model.filename,
        detail: model.targetSubdir ? `models/${model.targetSubdir}` : 'models',
        sizeBytes: Number.isFinite(model.sizeBytes) ? Number(model.sizeBytes) : null,
        auto: true,
      })
    }
    for (const node of plan.manualNodes || []) {
      out.push({
        key: `manual-node:${node.classType}`,
        kind: 'manual',
        label: node.classType,
        detail: node.install?.notes || 'Manual install via ComfyUI Manager or the registry.',
        docsUrl: node.install?.docsUrl || '',
        sizeBytes: null,
        auto: false,
      })
    }
    for (const node of plan.coreNodes || []) {
      out.push({
        key: `core-node:${node.classType}`,
        kind: 'core',
        label: node.classType,
        detail: node.install?.notes || 'Update ComfyUI to a newer build.',
        docsUrl: node.install?.docsUrl || '',
        sizeBytes: null,
        auto: false,
      })
    }
    for (const model of plan.manualModels || []) {
      out.push({
        key: `manual-model:${model.targetSubdir}:${model.filename}`,
        kind: 'manual',
        label: model.filename,
        detail: model.install?.notes || 'No curated download URL yet — install manually.',
        docsUrl: model.install?.sourceUrl || model.install?.docsUrl || '',
        sizeBytes: null,
        auto: false,
      })
    }
    return out
  }, [plan])

  const totalDownloadBytes = useMemo(() => (
    items.reduce((sum, item) => (item.auto && Number.isFinite(item.sizeBytes) ? sum + item.sizeBytes : sum), 0)
  ), [items])
  const unknownSizeCount = useMemo(() => (
    items.filter((item) => item.auto && !Number.isFinite(item.sizeBytes)).length
  ), [items])

  const hasActionableTasks = Boolean(plan?.hasActionableTasks)
  const manualOnlyBlocked = Boolean(
    enriched?.hasBlockingIssues
    && !hasActionableTasks
    && ((plan?.manualNodes?.length || 0) > 0 || (plan?.coreNodes?.length || 0) > 0 || (plan?.manualModels?.length || 0) > 0)
  )
  const needsAuth = Boolean(enriched?.missingAuth)
  const needsAuthOnly = Boolean(needsAuth && !hasActionableTasks && !manualOnlyBlocked)

  const validateRoot = useCallback(async () => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null
    if (!api?.getSetting || !api?.validateWorkflowSetupRoot) {
      setRootValidation({ checked: true, isValid: false, normalizedPath: '', error: 'Desktop build required.' })
      return null
    }
    try {
      const stored = String(await api.getSetting(COMFY_ROOT_PATH_SETTING_KEY) || '').trim()
      if (!stored) {
        setRootValidation({ checked: true, isValid: false, normalizedPath: '', error: '' })
        return null
      }
      const validation = await api.validateWorkflowSetupRoot(stored)
      const next = {
        checked: true,
        isValid: Boolean(validation?.isValid),
        normalizedPath: validation?.normalizedPath || stored,
        error: validation?.isValid ? '' : (validation?.error || ''),
      }
      setRootValidation(next)
      return next
    } catch (error) {
      setRootValidation({
        checked: true,
        isValid: false,
        normalizedPath: '',
        error: error instanceof Error ? error.message : 'Could not validate the ComfyUI folder.',
      })
      return null
    }
  }, [])

  useEffect(() => {
    if (!hasActionableTasks && !manualOnlyBlocked) return
    void validateRoot()
  }, [hasActionableTasks, manualOnlyBlocked, validateRoot])

  useEffect(() => {
    if (!hasActionableTasks) return
    setRestartCapability(getRestartCapability())
  }, [hasActionableTasks, phase])

  // Free-space probe for the volume that holds the ComfyUI models folder.
  useEffect(() => {
    let cancelled = false
    setDiskSpace({ checked: false, freeBytes: null })
    if (!hasActionableTasks || !rootValidation.isValid) return undefined
    const api = typeof window !== 'undefined' ? window.electronAPI : null
    if (!api?.getWorkflowSetupDiskSpace) return undefined
    ;(async () => {
      try {
        const result = await api.getWorkflowSetupDiskSpace({ comfyRootPath: rootValidation.normalizedPath })
        if (cancelled) return
        setDiskSpace({
          checked: true,
          freeBytes: result?.success && Number.isFinite(result.freeBytes) ? Number(result.freeBytes) : null,
        })
      } catch {
        if (!cancelled) setDiskSpace({ checked: true, freeBytes: null })
      }
    })()
    return () => { cancelled = true }
  }, [hasActionableTasks, rootValidation.isValid, rootValidation.normalizedPath, dependencyCheck?.checkedAt])

  const insufficientDiskSpace = Boolean(
    diskSpace.checked
    && Number.isFinite(diskSpace.freeBytes)
    && totalDownloadBytes > 0
    && diskSpace.freeBytes < totalDownloadBytes + DISK_SPACE_HEADROOM_BYTES
  )

  // Live install progress only matters mid-install; the guard also keeps the
  // Settings-panel install (same broadcast channel) from driving this UI.
  useEffect(() => {
    if (phase !== 'installing') return undefined
    const api = typeof window !== 'undefined' ? window.electronAPI : null
    if (!api?.onWorkflowSetupProgress) return undefined
    return api.onWorkflowSetupProgress((entry) => {
      const normalized = entry && typeof entry === 'object' ? entry : {}
      const parsed = parseProgressFromMessage(normalized.message)
      setProgress((prev) => {
        const next = { ...prev }
        if (hasOwn(normalized, 'stage')) next.stage = normalized.stage || ''
        if (hasOwn(normalized, 'status')) next.status = normalized.status || ''
        if (hasOwn(normalized, 'message')) next.message = normalized.message || ''
        if (hasOwn(normalized, 'currentLabel')) next.currentLabel = normalized.currentLabel || ''
        if (hasOwn(normalized, 'taskType')) next.taskType = normalized.taskType || ''
        if (hasOwn(normalized, 'currentTaskIndex')) next.currentTaskIndex = Number(normalized.currentTaskIndex) || 0
        if (hasOwn(normalized, 'totalTasks')) next.totalTasks = Number(normalized.totalTasks) || 0
        if (hasOwn(normalized, 'completedTasks')) next.completedTasks = Number(normalized.completedTasks) || 0
        if (hasOwn(normalized, 'taskPercent')) next.taskPercent = clampProgressPercent(normalized.taskPercent)
        if (hasOwn(normalized, 'overallPercent')) next.overallPercent = clampProgressPercent(normalized.overallPercent) ?? 0
        if (hasOwn(normalized, 'bytesDownloaded')) next.bytesDownloaded = Number(normalized.bytesDownloaded) || 0
        if (hasOwn(normalized, 'totalBytes')) next.totalBytes = Number(normalized.totalBytes) || 0
        if (!hasOwn(normalized, 'currentLabel') && parsed?.currentLabel) next.currentLabel = parsed.currentLabel
        if (!hasOwn(normalized, 'taskPercent') && parsed && parsed.taskPercent !== undefined) next.taskPercent = parsed.taskPercent
        return next
      })
    })
  }, [phase])

  const chooseComfyFolder = useCallback(async () => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null
    if (!api?.selectDirectory) return
    const picked = await api.selectDirectory({
      title: 'Select your ComfyUI folder',
      defaultPath: rootValidation.normalizedPath || undefined,
    })
    if (!picked) return
    await api.setSetting?.(COMFY_ROOT_PATH_SETTING_KEY, picked)
    await validateRoot()
  }, [rootValidation.normalizedPath, validateRoot])

  const startSetup = useCallback(async () => {
    if (phaseRef.current === 'installing' || phaseRef.current === 'restarting') return
    if (!plan?.hasActionableTasks) return

    const api = typeof window !== 'undefined' ? window.electronAPI : null
    if (!api?.installWorkflowSetup) {
      setFlowPhase('error', 'Workflow setup installation is only available in the desktop build.')
      return
    }

    const rootCheck = rootValidation.isValid ? rootValidation : await validateRoot()
    if (!rootCheck?.isValid) {
      setFlowPhase('error', rootCheck?.error || 'Choose a valid ComfyUI folder first.')
      return
    }

    const token = installTokenRef.current + 1
    installTokenRef.current = token
    setProgress({
      ...createInitialProgress(),
      stage: 'install',
      status: 'active',
      message: 'Preparing workflow setup install...',
      totalTasks: (plan.nodePacks?.length || 0) + (plan.models?.length || 0),
    })
    setFlowPhase('installing')

    try {
      const result = await api.installWorkflowSetup({
        comfyRootPath: rootCheck.normalizedPath,
        plan: {
          nodePacks: Array.isArray(plan.nodePacks) ? plan.nodePacks : [],
          models: Array.isArray(plan.models) ? plan.models : [],
        },
      })
      if (installTokenRef.current !== token) return

      if (!result?.success) {
        setFlowPhase('error', result?.error || 'Workflow setup install failed.')
        return
      }

      const installErrors = Array.isArray(result.errors) ? result.errors.filter(Boolean) : []

      if (result.restartRecommended) {
        setRestartCapability(getRestartCapability())
        setFlowPhase('needs-restart', installErrors.join(' '))
        return
      }

      await recheck?.()
      if (installTokenRef.current !== token) return
      if (installErrors.length > 0) {
        setFlowPhase('error', installErrors.join(' '))
      } else {
        setFlowPhase('idle')
      }
    } catch (error) {
      if (installTokenRef.current !== token) return
      setFlowPhase('error', error instanceof Error ? error.message : 'Workflow setup install failed.')
    }
  }, [plan, recheck, rootValidation, setFlowPhase, validateRoot])

  const restartNow = useCallback(async () => {
    if (phaseRef.current !== 'needs-restart') return
    const capability = getRestartCapability()
    setRestartCapability(capability)
    if (capability !== 'restart' && capability !== 'start') return

    setFlowPhase('restarting')
    const actionResult = capability === 'restart' ? await restartComfyLauncher() : await startComfyLauncher()
    if (actionResult?.success === false) {
      setFlowPhase('needs-restart', `Failed to ${capability === 'restart' ? 'restart' : 'start'} ComfyUI: ${actionResult?.error || 'unknown error.'}`)
      return
    }

    const wait = await waitForComfyLauncherState(['running', 'external'], { timeoutMs: 180_000 })
    if (wait.timedOut || wait.state?.state !== 'running') {
      setFlowPhase('needs-restart', 'ComfyUI did not come back within 3 minutes. Check the launcher chip, then re-check.')
      return
    }

    await recheck?.()
    setFlowPhase('idle')
  }, [recheck, setFlowPhase])

  const recheckAfterManualRestart = useCallback(async () => {
    const result = await recheck?.()
    // Only leave needs-restart once the missing nodes actually resolved;
    // otherwise the user restarted before the install landed (or not at all).
    if (result && !result.hasBlockingIssues) {
      setFlowPhase('idle')
    }
    return result
  }, [recheck, setFlowPhase])

  const dismissError = useCallback(() => {
    if (phaseRef.current === 'error') setFlowPhase('idle')
  }, [setFlowPhase])

  // A new workflow selection (different id) resets any stale flow state.
  const workflowIdRef = useRef(dependencyCheck?.workflowId || '')
  useEffect(() => {
    const nextId = dependencyCheck?.workflowId || ''
    if (nextId === workflowIdRef.current) return
    workflowIdRef.current = nextId
    installTokenRef.current += 1
    setProgress(createInitialProgress())
    setFlowPhase('idle')
  }, [dependencyCheck?.workflowId, setFlowPhase])

  const mode = useMemo(() => {
    if (phase === 'installing') return 'installing'
    if (phase === 'restarting') return 'restarting'
    if (phase === 'needs-restart') return 'needs-restart'
    if (!isConnected) return 'hidden'
    if (!enriched || !enriched.hasBlockingIssues) return 'hidden'
    if (hasActionableTasks) {
      if (rootValidation.checked && !rootValidation.isValid) return 'choose-root'
      return 'setup'
    }
    if (needsAuthOnly) return 'needs-auth'
    if (manualOnlyBlocked) return 'manual-only'
    return 'hidden'
  }, [phase, isConnected, enriched, hasActionableTasks, rootValidation, needsAuthOnly, manualOnlyBlocked])

  return {
    mode,
    phase,
    error: phaseError,
    items,
    totalDownloadBytes,
    unknownSizeCount,
    needsAuth,
    restartCapability,
    diskSpace,
    insufficientDiskSpace,
    rootValidation,
    progress,
    startSetup,
    restartNow,
    recheckAfterManualRestart,
    chooseComfyFolder,
    dismissError,
  }
}
