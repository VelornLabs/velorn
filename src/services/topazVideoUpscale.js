import comfyui, { modifyTopazVideoUpscaleWorkflow } from './comfyui'
import { BUILTIN_WORKFLOW_PATHS } from '../config/workflowRegistry'
import {
  TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID,
  TOPAZ_VIDEO_UPSCALE_DEFAULTS,
  TOPAZ_VIDEO_UPSCALE_MODEL_OPTIONS,
  getTopazVideoUpscaleResolutionShortLabel,
  topazVideoUpscaleModelSupportsCreativity,
} from '../config/topazVideoUpscaleConfig'
import { checkWorkflowDependencies } from './workflowDependencies'
import { importAsset, isElectron } from './fileSystem'
import { enqueuePlaybackTranscode } from './playbackCache'
import { enqueueProxyTranscode, isProxyPlaybackEnabled } from './proxyCache'
import { markPromptHandledByApp } from './comfyPromptGuard'
import { useAssetsStore } from '../stores/assetsStore'
import { useProjectStore } from '../stores/projectStore'
import { getWorkflowHardwareInfo } from '../config/generateWorkspaceConfig'
import { createExactCreditsEstimate, normalizeCreditsEstimate } from '../utils/comfyCredits'

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi'])

function sanitizeNameToken(value = '', fallback = 'topaz_upscale') {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_\-\s]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned || fallback
}

function extensionOf(filename = '') {
  const normalized = String(filename || '').trim()
  const parts = normalized.split('.')
  return parts.length > 1 ? parts.pop().toLowerCase() : ''
}

function isVideoFilename(filename = '') {
  return VIDEO_EXTENSIONS.has(extensionOf(filename))
}

function stripExtension(filename = '') {
  const normalized = String(filename || '').trim()
  if (!normalized.includes('.')) return normalized
  return normalized.replace(/\.[^/.]+$/, '')
}

function basenameFromPath(filePath = '') {
  const normalized = String(filePath || '').trim()
  if (!normalized) return ''
  const parts = normalized.split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

function getAssetFileName(asset = null) {
  const candidates = [
    asset?.path ? basenameFromPath(asset.path) : '',
    asset?.absolutePath ? basenameFromPath(asset.absolutePath) : '',
    asset?.name || '',
  ]
  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim()
    if (normalized) return normalized
  }
  return 'video.mp4'
}

async function assetToVideoUploadFile(asset) {
  if (String(asset?.type || '').trim() !== 'video') {
    throw new Error('Topaz upscale requires a video asset.')
  }

  const uploadFilename = getAssetFileName(asset)

  if (isElectron() && asset?.absolutePath && window.electronAPI?.readFileAsBuffer) {
    const bufferResult = await window.electronAPI.readFileAsBuffer(asset.absolutePath)
    if (!bufferResult?.success) {
      throw new Error(bufferResult?.error || 'Failed to read the source video from disk.')
    }
    return new File([bufferResult.data], uploadFilename, {
      type: asset?.mimeType || 'video/mp4',
    })
  }

  const sourceUrl = String(asset?.url || '').trim()
  if (!sourceUrl) {
    throw new Error('The selected video does not have a playable URL.')
  }

  const response = await fetch(sourceUrl)
  if (!response.ok) {
    throw new Error(`Failed to load the source video (${response.status}).`)
  }
  const blob = await response.blob()
  return new File([blob], uploadFilename, {
    type: blob.type || asset?.mimeType || 'video/mp4',
  })
}

function extractOutputInfo(item) {
  if (!item || typeof item !== 'object') return null
  const filename = String(item.filename || '').trim()
  if (!filename) return null
  return {
    filename,
    subfolder: String(item.subfolder || '').trim(),
    outputType: String(item.type || 'output').trim() || 'output',
  }
}

function findVideoResult(outputs = {}, expectedPrefix = '') {
  const normalizedPrefix = String(expectedPrefix || '').trim().toLowerCase()
  const matchesPrefix = (filename = '') => {
    if (!normalizedPrefix) return true
    return String(filename || '').toLowerCase().includes(normalizedPrefix)
  }

  let fallback = null
  for (const nodeOutput of Object.values(outputs || {})) {
    if (!nodeOutput || typeof nodeOutput !== 'object') continue
    for (const items of Object.values(nodeOutput)) {
      if (!Array.isArray(items) || items.length === 0) continue
      for (const item of items) {
        const info = extractOutputInfo(item)
        if (!info || !isVideoFilename(info.filename)) continue
        if (matchesPrefix(info.filename)) return info
        fallback = fallback || info
      }
    }
  }
  return fallback
}

async function loadWorkflowDefinition(workflowId = TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID) {
  const workflowPath = BUILTIN_WORKFLOW_PATHS[String(workflowId || '').trim()]
  if (!workflowPath) {
    throw new Error(`Unknown workflow "${workflowId}"`)
  }
  const response = await fetch(workflowPath)
  if (!response.ok) {
    throw new Error(`Failed to load workflow file: ${workflowPath} (${response.status})`)
  }
  return response.json()
}

async function pollForTopazVideoResult(promptId, expectedOutputPrefix = '', onStatus = () => {}) {
  const startedAt = Date.now()
  let lastActivityAt = Date.now()
  let wsReportedSuccess = false
  let consecutivePollErrors = 0
  let latestEstimatedCredits = null

  const MAX_TOTAL_MS = 4 * 60 * 60 * 1000
  const IDLE_TIMEOUT_MS = 10 * 60 * 1000
  const POLL_INTERVAL_MS = 1000
  const MAX_POST_SUCCESS_TRIES = 8
  const MAX_CONSECUTIVE_POLL_ERRORS = 5

  const markActivity = () => {
    lastActivityAt = Date.now()
  }

  const emitStatus = (status = {}) => {
    onStatus({
      ...status,
      ...(latestEstimatedCredits ? {
        estimatedCredits: latestEstimatedCredits,
        estimatedCreditsSource: 'live-progress-text',
      } : {}),
    })
  }

  const handleProgressText = (event) => {
    if (!event || typeof event !== 'object') return
    if (event.promptId && String(event.promptId) !== String(promptId)) return
    if (event.nodeType && String(event.nodeType).trim() !== 'TopazVideoEnhance') return
    const estimatedCredits = createExactCreditsEstimate(event.credits)
    if (!estimatedCredits) return
    latestEstimatedCredits = estimatedCredits
    const elapsed = Date.now() - startedAt
    const progressPct = Math.min(92, 15 + ((elapsed / (20 * 60 * 1000)) * 77))
    emitStatus({
      status: 'running',
      progress: progressPct,
      statusMessage: 'Waiting for Topaz output…',
    })
  }

  const subs = [
    ['progress', markActivity],
    ['executing', markActivity],
    ['executed', markActivity],
    ['execution_cached', markActivity],
    ['execution_start', markActivity],
    ['status', markActivity],
    ['complete', markActivity],
    ['execution_success', () => {
      markActivity()
      wsReportedSuccess = true
    }],
    ['progress_text', handleProgressText],
  ]

  for (const [eventName, handler] of subs) {
    try {
      comfyui.on(eventName, handler)
    } catch (_) {
      // ignore
    }
  }

  try {
    let postSuccessTries = 0
    while (true) {
      const now = Date.now()
      const elapsed = now - startedAt
      const idleFor = now - lastActivityAt

      if (elapsed > MAX_TOTAL_MS) break
      if (!wsReportedSuccess && idleFor > IDLE_TIMEOUT_MS) {
        throw new Error('ComfyUI stopped reporting progress for more than 10 minutes. The Topaz job may be stuck or the server may have crashed.')
      }
      if (wsReportedSuccess && postSuccessTries >= MAX_POST_SUCCESS_TRIES) break

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      if (wsReportedSuccess) postSuccessTries += 1

      const progressPct = Math.min(92, 15 + ((elapsed / (20 * 60 * 1000)) * 77))
      emitStatus({ status: 'running', progress: progressPct, statusMessage: 'Waiting for Topaz output…' })

      try {
        const history = await comfyui.getHistory(promptId)
        consecutivePollErrors = 0
        const promptHistory = history?.[promptId] || history
        const outputs = promptHistory?.outputs
        const topStatus = promptHistory?.status

        if (topStatus?.status_str === 'error') {
          const messages = Array.isArray(topStatus.messages) ? topStatus.messages : []
          let friendly = 'ComfyUI reported an execution error.'
          for (let index = messages.length - 1; index >= 0; index -= 1) {
            const entry = messages[index]
            if (!Array.isArray(entry) || entry.length < 2) continue
            const [eventName, eventData] = entry
            if (eventName === 'execution_error') {
              const nodeId = eventData?.node_id != null ? String(eventData.node_id) : null
              const nodeType = eventData?.node_type ? String(eventData.node_type) : null
              const detail = String(eventData?.exception_message || '').trim()
              friendly = detail
                ? `ComfyUI failed at node ${nodeId || 'unknown'}${nodeType ? ` (${nodeType})` : ''}: ${detail}`
                : `ComfyUI reported an execution error at node ${nodeId || 'unknown'}${nodeType ? ` (${nodeType})` : ''}`
              break
            }
          }
          throw new Error(friendly)
        }

        if (!outputs || typeof outputs !== 'object') continue

        const videoResult = findVideoResult(outputs, expectedOutputPrefix)
        if (videoResult) {
          return videoResult
        }
      } catch (error) {
        if (error instanceof Error && /ComfyUI reported|ComfyUI failed/.test(error.message)) {
          throw error
        }
        consecutivePollErrors += 1
        if (consecutivePollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          throw new Error('Lost connection to ComfyUI while waiting for the Topaz result.')
        }
      }
    }

    return null
  } finally {
    for (const [eventName, handler] of subs) {
      try {
        comfyui.off(eventName, handler)
      } catch (_) {
        // ignore
      }
    }
  }
}

function buildOutputPrefix(baseName = '') {
  const token = `${sanitizeNameToken(baseName || 'topaz_video_upscale', 'topaz_video_upscale')}_${Date.now()}`
  return `video/${token}`
}

function buildImportedAssetName(sourceAsset, targetResolution, explicitBaseName = '') {
  const baseName = String(explicitBaseName || '').trim()
  if (baseName) return baseName
  const sourceLabel = stripExtension(String(sourceAsset?.name || '').trim()) || stripExtension(getAssetFileName(sourceAsset))
  const resolutionLabel = getTopazVideoUpscaleResolutionShortLabel(targetResolution)
  return `${sourceLabel || 'Video'} ${resolutionLabel} Upscaled`
}

function normalizeTopazModel(model = '') {
  const normalized = String(model || '').trim()
  if (TOPAZ_VIDEO_UPSCALE_MODEL_OPTIONS.some((option) => option.id === normalized)) {
    return normalized
  }
  return TOPAZ_VIDEO_UPSCALE_DEFAULTS.model
}

export function buildTopazVideoUpscaleBaseName(sourceAsset, targetResolution, explicitBaseName = '') {
  return buildImportedAssetName(sourceAsset, targetResolution, explicitBaseName)
}

export async function runTopazVideoUpscale(options = {}) {
  const {
    sourceAsset,
    folderId = null,
    baseName = '',
    workflowId = TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID,
    model = TOPAZ_VIDEO_UPSCALE_DEFAULTS.model,
    targetResolution = TOPAZ_VIDEO_UPSCALE_DEFAULTS.resolution,
    creativity = TOPAZ_VIDEO_UPSCALE_DEFAULTS.creativity,
    skipDependencyCheck = false,
    onStatus = () => {},
    flowMetadata = null,
  } = options

  if (!sourceAsset || String(sourceAsset?.type || '').trim() !== 'video') {
    throw new Error('Select a video before starting a Topaz upscale.')
  }

  let liveEstimatedCredits = null
  const emitStatus = (status = {}) => {
    onStatus({
      ...status,
      ...(liveEstimatedCredits ? {
        estimatedCredits: liveEstimatedCredits,
        estimatedCreditsSource: 'live-progress-text',
      } : {}),
    })
  }

  const projectHandle = useProjectStore.getState().currentProjectHandle
  if (!projectHandle) {
    throw new Error('Open a project before running Topaz video upscale.')
  }

  if (!skipDependencyCheck) {
    emitStatus({
      status: 'checking',
      progress: 0,
      statusMessage: 'Checking workflow readiness…',
    })
    const dependencyCheck = await checkWorkflowDependencies(workflowId)
    if (dependencyCheck?.hasBlockingIssues) {
      if (dependencyCheck.missingAuth) {
        throw new Error('Topaz Video Upscale needs a Comfy Partner API key before it can run.')
      }
      if ((dependencyCheck.missingNodes || []).length > 0 || (dependencyCheck.missingModels || []).length > 0) {
        throw new Error('Topaz Video Upscale is missing required workflow dependencies. Open Workflow Setup to install them.')
      }
    }
  }

  emitStatus({
    status: 'uploading',
    progress: 5,
    statusMessage: 'Uploading source video…',
  })

  const uploadFile = await assetToVideoUploadFile(sourceAsset)
  const uploadResult = await comfyui.uploadFile(uploadFile)
  const uploadedFilename = uploadResult?.name || uploadFile.name
  const workflowJson = await loadWorkflowDefinition(workflowId)
  const normalizedModel = normalizeTopazModel(model)
  const effectiveCreativity = topazVideoUpscaleModelSupportsCreativity(normalizedModel)
    ? String(creativity || TOPAZ_VIDEO_UPSCALE_DEFAULTS.creativity).trim() || TOPAZ_VIDEO_UPSCALE_DEFAULTS.creativity
    : TOPAZ_VIDEO_UPSCALE_DEFAULTS.creativity
  const importedAssetName = buildImportedAssetName(sourceAsset, targetResolution, baseName)
  const outputPrefix = buildOutputPrefix(importedAssetName)
  const modifiedWorkflow = modifyTopazVideoUpscaleWorkflow(workflowJson, {
    inputVideo: uploadedFilename,
    upscalerModel: normalizedModel,
    upscalerResolution: targetResolution,
    upscalerCreativity: effectiveCreativity,
    filenamePrefix: outputPrefix,
  })

  emitStatus({
    status: 'queuing',
    progress: 10,
    statusMessage: 'Queueing Topaz upscale…',
  })

  const promptId = await comfyui.queuePrompt(modifiedWorkflow)
  if (!promptId) {
    throw new Error('Failed to queue the Topaz upscale workflow.')
  }
  markPromptHandledByApp(promptId)

  emitStatus({
    status: 'running',
    progress: 15,
    statusMessage: 'Running Topaz upscale…',
    promptId,
  })

  const result = await pollForTopazVideoResult(promptId, outputPrefix, (status) => {
    if (status?.estimatedCredits) {
      liveEstimatedCredits = status.estimatedCredits
    }
    emitStatus({
      status: 'running',
      promptId,
      progress: Math.max(15, Math.min(94, Number(status?.progress) || 15)),
      statusMessage: status?.statusMessage || 'Running Topaz upscale…',
    })
  })

  if (!result?.filename) {
    throw new Error('Topaz finished but Velorn could not find the upscaled video output.')
  }

  emitStatus({
    status: 'importing',
    progress: 95,
    statusMessage: 'Importing upscaled video…',
    promptId,
  })

  const videoFile = await comfyui.downloadVideo(result.filename, result.subfolder, result.outputType)
  const assetInfo = await importAsset(projectHandle, videoFile, 'video')
  const blobUrl = URL.createObjectURL(videoFile)
  const importedAt = new Date().toISOString()
  const targetFolderId = folderId ?? sourceAsset?.folderId ?? null
  const addAsset = useAssetsStore.getState().addAsset

  const upscaleMetadata = {
    workflowId,
    sourceAssetId: sourceAsset.id || null,
    model: normalizedModel,
    targetResolution,
    creativity: topazVideoUpscaleModelSupportsCreativity(normalizedModel) ? effectiveCreativity : null,
    estimatedCredits: normalizeCreditsEstimate(liveEstimatedCredits),
    promptId,
    runtime: getWorkflowHardwareInfo(workflowId)?.runtime || 'cloud',
    importedAt,
  }

  const asset = addAsset({
    ...assetInfo,
    name: importedAssetName,
    type: 'video',
    url: blobUrl,
    isImported: true,
    folderId: targetFolderId,
    prompt: '',
    settings: {
      ...(assetInfo?.settings || {}),
      topazModel: normalizedModel,
      topazResolution: targetResolution,
      topazCreativity: upscaleMetadata.creativity,
      sourceAssetId: sourceAsset.id || null,
    },
    topazUpscale: upscaleMetadata,
    flowAi: flowMetadata
      ? {
        ...flowMetadata,
        promptId,
        runtime: upscaleMetadata.runtime,
        importedAt,
      }
      : undefined,
  })

  if (isElectron() && projectHandle && asset?.absolutePath) {
    enqueuePlaybackTranscode(projectHandle, asset.id, asset.absolutePath).catch(() => {})
    if (isProxyPlaybackEnabled()) {
      enqueueProxyTranscode(projectHandle, asset.id, asset.absolutePath).catch(() => {})
    }
  }

  emitStatus({
    status: 'done',
    progress: 100,
    statusMessage: 'Imported upscaled video.',
    promptId,
  })

  return {
    promptId,
    importedAssets: asset ? [asset] : [],
    estimatedCredits: normalizeCreditsEstimate(liveEstimatedCredits),
    workflowId,
  }
}
