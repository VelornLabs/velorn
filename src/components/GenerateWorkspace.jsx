import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  Sparkles, Video, Image as ImageIcon, Music, RefreshCw, Loader2,
  ChevronLeft, ChevronRight, Play, Pause, Upload, X, Film, Search,
  FolderOpen, Wand2, Volume2, Mic, Clock, Settings, Terminal, ChevronDown, ChevronUp, PenLine, KeyRound,
  Copy,
} from 'lucide-react'
import { jsPDF } from 'jspdf'
import ImageAnnotationModal from './ImageAnnotationModal'
import ConfirmDialog from './ConfirmDialog'
import ApiKeyDialog from './ApiKeyDialog'
import AdEasyMode from './generate/AdEasyMode'
import MusicVideoEasyMode from './generate/MusicVideoEasyMode'
import ShortFilmEasyMode from './generate/ShortFilmEasyMode'
import WorkflowBrowser from './generate/WorkflowBrowser'
import WorkflowDetail from './generate/WorkflowDetail'
import { COMFY_PARTNER_KEY_CHANGED_EVENT } from '../services/comfyPartnerAuth'
import useComfyUI from '../hooks/useComfyUI'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import useTimelineStore from '../stores/timelineStore'
import { useFrameForAIStore } from '../stores/frameForAIStore'
import { BUILTIN_WORKFLOW_PATHS } from '../config/workflowRegistry'
import { comfyui } from '../services/comfyui'
import { markPromptHandledByApp } from '../services/comfyPromptGuard'
import {
  getProjectFileUrl,
  importAsset,
  isElectron,
  loadProject as loadProjectFile,
  saveProject as saveProjectFile,
} from '../services/fileSystem'
import { enqueuePlaybackTranscode } from '../services/playbackCache'
import { enqueueProxyTranscode, isProxyPlaybackEnabled } from '../services/proxyCache'
import { formatCaptionCuesAsSrt, transcribeWithComfyUI } from '../services/captionComfyTranscription'
import {
  buildYoloPlanFromScript,
  flattenYoloPlanVariants,
  parseStructuredDirectorScript,
} from '../utils/yoloPlanning'
import { checkWorkflowDependencies, buildMissingDependencyClipboardText } from '../services/workflowDependencies'
import { openBundledWorkflowInComfyUi } from '../services/workflowSetupManager'
import {
  getComfyLauncherSnapshot,
  isComfyLauncherAvailable,
  startComfyLauncher,
  subscribeComfyLauncherState,
} from '../services/comfyLauncher'
import {
  GENERATE_WORKFLOW_CATALOG,
  getWorkflowManifestByWorkflowId,
} from '../config/generateWorkflowCatalog'
import {
  ACTIVE_JOB_STATUSES,
  CATEGORY_ORDER,
  DIRECTOR_MODE_BETA_LABEL,
  GENERATED_ASSET_FOLDERS,
  HARDWARE_TIERS,
  NON_TERMINAL_JOB_STATUSES,
  SHOT_CATEGORIES,
  WORKFLOWS,
  YOLO_AD_CAMERA_CHIP_OPTIONS,
  YOLO_AD_COMMERCIAL_BEAT_OPTIONS,
  YOLO_AD_ENERGY_OPTIONS,
  YOLO_AD_FORMAT_PRESETS,
  YOLO_AD_LOCAL_VIDEO_WORKFLOW_OPTIONS,
  YOLO_AD_PLATFORM_PRESETS,
  YOLO_AD_PROFILES,
  YOLO_AD_PROFILE_RUNTIME_OPTIONS,
  YOLO_AD_PRODUCT_VIEW_OPTIONS,
  YOLO_AD_REFERENCE_CONSISTENCY_OPTIONS,
  YOLO_AD_TALENT_MODE_OPTIONS,
  YOLO_CAMERA_PRESET_OPTIONS,
  YOLO_MUSIC_KEYFRAME_WORKFLOW_OPTIONS,
  YOLO_MUSIC_VIDEO_WORKFLOW_OPTIONS,
  YOLO_MUSIC_PROFILES,
  YOLO_QUEUE_CONFIRM_THRESHOLD,
  formatWorkflowHardwareRuntime,
  formatWorkflowTierSummary,
  getVideoDurationPresets,
  getWorkflowDisplayLabel,
  getWorkflowHardwareInfo,
  getWorkflowTierMeta,
} from '../config/generateWorkspaceConfig'
import {
  MUSIC_VIDEO_AUDIO_KIND_OPTIONS,
  MUSIC_VIDEO_CAMERA_MOVE_OPTIONS,
  MUSIC_VIDEO_CAST_ROLE_OPTIONS,
  MUSIC_VIDEO_ENERGY_OPTIONS,
  MUSIC_VIDEO_PERFORMANCE_MODE_OPTIONS,
  MUSIC_VIDEO_SCRIPT_TEMPLATE,
  MUSIC_VIDEO_SHOT_DEFAULTS,
  MUSIC_VIDEO_SHOT_WORKFLOW_ID,
  MUSIC_VIDEO_SHOT_SIZE_OPTIONS,
  MUSIC_VIDEO_STYLE_CARD_OPTIONS,
  VOCAL_EXTRACT_WORKFLOW_ID,
  clampMusicVideoShotLength,
  computeCoverageGaps,
  detectTimedLyricsFormat,
  estimateLyricLineStartSeconds,
  findLyricLineIndex,
  findTimedLyricLineByText,
  formatSecondsAsMMSS,
  getMusicVideoAudioKindOption,
  getMusicVideoShotTypeOption,
  normalizeCastSlug,
  normalizeMusicVideoShot,
  parseLyricLines,
  parseLyricsWithTags,
  parseTimedLyrics,
  parseTimeSpecToSeconds,
  resolveCastMembersFromNameList,
  resolveMusicVideoShotTypeFromText,
  splitCastNameList,
} from '../config/musicVideoShotConfig'
import { TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID } from '../config/topazVideoUpscaleConfig'
import {
  buildShortFilmVideoPrompt,
  ELEVENLABS_TTS_WORKFLOW_ID,
  SHORT_FILM_DIALOGUE_VIDEO_WORKFLOW_ID,
  SHORT_FILM_KEYFRAME_WORKFLOW_OPTIONS,
  SHORT_FILM_VIDEO_WORKFLOW_ID,
} from '../config/shortFilmConfig'

const CATEGORY_ICONS = { video: Video, image: ImageIcon, audio: Music }
const DIRECTOR_SUBTABS = [
  {
    id: 'setup',
    label: '1. Setup',
    helper: 'Step 1: Structure, Quality, and Set References.',
  },
  {
    id: 'plan-script',
    label: '2. Script',
    helper: 'Step 2: define script/lyrics, then build your plan.',
  },
  {
    id: 'scene-shot',
    label: '3. Keyframes',
    helper: 'Step 3: review shots and create keyframe images.',
  },
  {
    id: 'video-pass',
    label: '4. Videos',
    helper: 'Step 4: create videos from keyframe images.',
  },
]

const SINGLE_VIDEO_WORKFLOW_IDS = new Set([
  'wan22-i2v',
  'ltx23-i2v',
  'ltx23-ia2v',
  SHORT_FILM_DIALOGUE_VIDEO_WORKFLOW_ID,
  'frame-interpolation',
  'kling-o3-i2v',
  'grok-video-i2v',
  'vidu-q2-i2v',
  MUSIC_VIDEO_SHOT_WORKFLOW_ID,
])

const WORKFLOW_RUNTIME_GROUPS = Object.freeze({
  local: Object.freeze({
    id: 'local',
    label: 'Local',
    helper: 'Runs on your GPU through local ComfyUI.',
  }),
  cloud: Object.freeze({
    id: 'cloud',
    label: 'Cloud',
    helper: 'Uses ComfyUI partner-node credits.',
  }),
})

function isSingleVideoWorkflowId(workflowId = '') {
  return SINGLE_VIDEO_WORKFLOW_IDS.has(String(workflowId || '').trim())
}

const YOLO_AD_STAGE_TIER_OPTIONS = Object.freeze({
  local: Object.freeze([
    { id: 'low', label: 'Low VRAM' },
    { id: 'quality', label: 'Quality' },
  ]),
  cloud: Object.freeze([
    { id: 'low', label: 'Low Cost' },
    { id: 'quality', label: 'Quality' },
  ]),
})

const DIRECTOR_VIDEO_FPS_OPTIONS = Object.freeze([24, 25, 30])
const IMAGE_RESOLUTION_PRESET_GROUPS = Object.freeze({
  standard: Object.freeze([
    { id: 'landscape_720', label: '720p Landscape', width: 1280, height: 720 },
    { id: 'landscape_1080', label: '1080p Landscape', width: 1920, height: 1080 },
    { id: 'portrait_720', label: '720p Portrait', width: 720, height: 1280 },
    { id: 'portrait_1080', label: '1080p Portrait', width: 1080, height: 1920 },
    { id: 'square_1k', label: 'Square 1K', width: 1024, height: 1024 },
  ]),
  enhanced: Object.freeze([
    { id: 'landscape_720', label: '720p Landscape', width: 1280, height: 720 },
    { id: 'landscape_1080', label: '1080p Landscape', width: 1920, height: 1080 },
    { id: 'portrait_720', label: '720p Portrait', width: 720, height: 1280 },
    { id: 'portrait_1080', label: '1080p Portrait', width: 1080, height: 1920 },
    { id: 'square_1k', label: 'Square 1K', width: 1024, height: 1024 },
    { id: 'square_2k', label: 'Square 2K', width: 2048, height: 2048 },
  ]),
  gptImage2: Object.freeze([
    { id: 'landscape_4k', label: '4K Landscape', width: 3840, height: 2160 },
    { id: 'landscape_2k', label: '2K Landscape', width: 2048, height: 1152 },
    { id: 'landscape_3x2', label: '3:2 Landscape', width: 1536, height: 1024 },
    { id: 'square_1k', label: 'Square 1K', width: 1024, height: 1024 },
    { id: 'square_2k', label: 'Square 2K', width: 2048, height: 2048 },
    { id: 'portrait_2x3', label: '2:3 Portrait', width: 1024, height: 1536 },
    { id: 'portrait_2k', label: '2K Portrait', width: 1152, height: 2048 },
    { id: 'portrait_4k', label: '4K Portrait', width: 2160, height: 3840 },
  ]),
})

const DIRECTOR_SCRIPT_TEMPLATE = `Scene 1: Neon Arrival
Scene context: Futuristic transit terminal, blue and coral neon, reflective black tile, premium cinematic sneaker ad.

Shot 1:
Ad beat: hook
Product mode: hero
Talent mode: lifestyle model
Shot type: Wide shot
Keyframe prompt: Wide shot of the model stepping through sliding glass doors into a futuristic transit terminal, blue and coral neon reflecting across glossy black tile, coral-and-cream sneaker clearly visible.
Motion prompt: Starting from this exact keyframe, the model takes 2 confident steps forward while neon reflections slide across the floor. Keep the sneaker, outfit, and terminal lighting consistent.
Camera: Gentle backward tracking shot
Text overlay: Step into the future.
Duration: 3

Shot 2:
Ad beat: demo
Product mode: macro detail
Talent mode: none
Shot type: Close-up
Keyframe prompt: Close-up of the sneaker landing on reflective black tile, sharp product detail, dramatic neon reflections, premium commercial lighting.
Motion prompt: Starting from this exact close-up, the foot lands fully and rolls forward slightly while reflections shimmer across the tile surface.
Camera: Locked close-up with subtle micro push-in
Duration: 2

Shot 3:
Ad beat: end card
Product mode: packaging
Talent mode: none
Shot type: Locked packshot
Keyframe prompt: Clean hero product packshot on reflective black tile with neon edge light and generous negative space.
Motion prompt: Hold steady for a clean final brand impression.
Camera: Locked packshot
End card: ComfySneak, FutureStep Runner, Shop now, comfysneak.example
Duration: 3`

const GENERATION_QUEUE_STORAGE_KEY = 'generate-workspace-generation-queue'
const PERSISTED_GENERATION_QUEUE_LIMIT = 100
const RECOVERABLE_JOB_STATUSES = new Set(['queued', 'uploading', 'configuring', 'queuing', 'running', 'saving', 'paused'])

async function copyTextToClipboard(text) {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
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
}

function buildGenerationErrorTroubleshootingHints(errorText = '') {
  const text = String(errorText || '')
  const lower = text.toLowerCase()
  const hints = []

  const looksLikeQwenAsr = (
    lower.includes('unifiedasrtranscribenode')
    || lower.includes('qwen3asr')
    || lower.includes('tts-audio-suite')
    || lower.includes('caption transcription')
  )

  if (looksLikeQwenAsr) {
    hints.push('This reached the Caption Transcription (Qwen ASR) workflow and failed inside ComfyUI, not inside the Music Video planner.')
    hints.push('Open the bundled caption_qwen_asr_transcription.json workflow in ComfyUI and run it there to debug the local Python/node/model environment.')
  }

  if (lower.includes('check_model_inputs') && lower.includes('missing 1 required positional argument')) {
    hints.push('The check_model_inputs error points to a Qwen3-ASR / transformers compatibility problem in the ComfyUI Python environment.')
  }

  if (lower.includes('node') && lower.includes('not found')) {
    hints.push('If this happened after installing nodes, restart ComfyUI and re-check Workflow Setup so ComfyUI reloads the new node classes.')
  }

  return hints
}

function buildGenerationErrorClipboardText({
  errorText = '',
  hints = [],
  workflow = null,
  generationMode = '',
} = {}) {
  const lines = [
    'ComfyStudio error report',
    `Timestamp: ${new Date().toISOString()}`,
  ]

  if (workflow?.id || workflow?.label) {
    lines.push(`Workflow: ${workflow?.label || workflow?.id} (${workflow?.id || 'unknown'})`)
  }
  if (generationMode) lines.push(`Mode: ${generationMode}`)

  lines.push('', 'Error:', String(errorText || '').trim() || '(empty)')

  if (Array.isArray(hints) && hints.length > 0) {
    lines.push('', 'Troubleshooting hints:')
    for (const hint of hints) lines.push(`- ${hint}`)
  }

  return lines.join('\n')
}

function formatCountLabel(count, singular, plural = `${singular}s`) {
  const value = Number(count) || 0
  return `${value} ${value === 1 ? singular : plural}`
}

function formatCreditsValue(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 'Unknown'
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(numeric)
}

const COMFY_CREDITS_PER_USD = 211

function formatUsdValue(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 'Unknown'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  }).format(numeric)
}

function formatUsdRangeFromCredits(estimatedCredits, multiplier = 1) {
  if (!estimatedCredits || typeof estimatedCredits !== 'object') return 'Unknown'
  const min = Number(estimatedCredits.min)
  const max = Number(estimatedCredits.max)
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 'Unknown'
  const scaledMin = min * Math.max(0, Number(multiplier) || 0)
  const scaledMax = max * Math.max(0, Number(multiplier) || 0)
  const usdMin = scaledMin / COMFY_CREDITS_PER_USD
  const usdMax = scaledMax / COMFY_CREDITS_PER_USD
  if (Math.abs(usdMax - usdMin) < 1e-9) return `~${formatUsdValue(usdMin)}`
  return `~${formatUsdValue(usdMin)}-${formatUsdValue(usdMax)}`
}

function formatCreditsRange(estimatedCredits, multiplier = 1) {
  if (!estimatedCredits || typeof estimatedCredits !== 'object') return 'Unknown'
  const min = Number(estimatedCredits.min)
  const max = Number(estimatedCredits.max)
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 'Unknown'
  const scaledMin = min * Math.max(0, Number(multiplier) || 0)
  const scaledMax = max * Math.max(0, Number(multiplier) || 0)
  if (Math.abs(scaledMax - scaledMin) < 1e-9) return `${formatCreditsValue(scaledMin)} credits`
  return `${formatCreditsValue(scaledMin)}-${formatCreditsValue(scaledMax)} credits`
}

function summarizeBlockingDependency(checkResult) {
  const workflowLabel = checkResult?.pack?.displayName
    || getWorkflowDisplayLabel(checkResult?.workflowId)
    || String(checkResult?.workflowId || 'workflow')

  const issues = []
  if ((checkResult?.missingNodes?.length || 0) > 0) {
    issues.push(formatCountLabel(checkResult.missingNodes.length, 'node'))
  }
  if ((checkResult?.missingModels?.length || 0) > 0) {
    issues.push(formatCountLabel(checkResult.missingModels.length, 'model'))
  }
  if (checkResult?.missingAuth) {
    issues.push('API key')
  }
  return `${workflowLabel} (${issues.join(', ') || 'requirements missing'})`
}

function buildDependencyResultMap(results = []) {
  const byWorkflow = {}
  for (const result of results) {
    const workflow = String(result?.workflowId || '').trim()
    if (!workflow) continue
    byWorkflow[workflow] = result
  }
  return byWorkflow
}

function getDependencyAggregateStatus(results = []) {
  if (!Array.isArray(results) || results.length === 0) return 'idle'
  if (results.some((result) => result?.hasPack && result?.hasBlockingIssues)) return 'missing'
  if (results.some((result) => result?.status === 'error')) return 'error'
  if (results.some((result) => result?.status === 'partial')) return 'partial'
  if (results.some((result) => result?.status === 'no-pack')) return 'no-pack'
  return 'ready'
}

function ensureAssetFolderPath(pathSegments = []) {
  const segments = (Array.isArray(pathSegments) ? pathSegments : [])
    .map((segment) => String(segment || '').trim())
    .filter(Boolean)

  if (segments.length === 0) return null

  let parentId = null
  for (const segment of segments) {
    const { folders = [], addFolder } = useAssetsStore.getState()
    if (typeof addFolder !== 'function') return parentId

    const segmentKey = segment.toLowerCase()
    let folder = folders.find((entry) => {
      const entryParentId = entry?.parentId || null
      const entryName = String(entry?.name || '').trim().toLowerCase()
      return entryParentId === parentId && entryName === segmentKey
    })

    if (!folder) {
      folder = addFolder({ name: segment, parentId })
    }

    parentId = folder?.id || parentId
  }

  return parentId
}

function normalizeProjectHandleKey(handle) {
  if (!handle) return ''
  if (typeof handle === 'string') {
    return handle.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  }
  return handle
}

function areProjectHandlesSame(a, b) {
  if (!a || !b) return false
  const keyA = normalizeProjectHandleKey(a)
  const keyB = normalizeProjectHandleKey(b)
  return keyA === keyB
}

function snapshotGenerationAsset(asset) {
  if (!asset) return null
  return {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    url: asset.url,
    path: asset.path,
    absolutePath: asset.absolutePath,
    isImported: asset.isImported,
    mimeType: asset.mimeType,
  }
}

function sanitizeProjectOriginForStorage(originProject) {
  if (!originProject) return null
  const path = typeof originProject.path === 'string'
    ? originProject.path
    : (typeof originProject.handle === 'string' ? originProject.handle : null)
  return {
    name: originProject.name || '',
    path,
    handle: path,
    created: originProject.created || null,
  }
}

function sanitizeAssetSnapshotForStorage(asset) {
  if (!asset) return null
  return {
    id: asset.id || null,
    name: asset.name || '',
    type: asset.type || '',
    path: asset.path || null,
    absolutePath: asset.absolutePath || null,
    url: asset.url && !String(asset.url).startsWith('blob:') ? asset.url : null,
    isImported: Boolean(asset.isImported),
    mimeType: asset.mimeType || '',
  }
}

function sanitizeGenerationJobForStorage(job) {
  if (!job?.id) return null
  const assetFields = job.sourceAssets?.assetFields && typeof job.sourceAssets.assetFields === 'object'
    ? Object.fromEntries(
      Object.entries(job.sourceAssets.assetFields)
        .map(([key, asset]) => [key, sanitizeAssetSnapshotForStorage(asset)])
        .filter(([, asset]) => Boolean(asset))
    )
    : null
  const sourceAssets = job.sourceAssets && typeof job.sourceAssets === 'object'
    ? {
      input: sanitizeAssetSnapshotForStorage(job.sourceAssets.input),
      reference1: sanitizeAssetSnapshotForStorage(job.sourceAssets.reference1),
      reference2: sanitizeAssetSnapshotForStorage(job.sourceAssets.reference2),
      audio: sanitizeAssetSnapshotForStorage(job.sourceAssets.audio),
      assetFields,
    }
    : null

  return {
    ...job,
    originProject: sanitizeProjectOriginForStorage(job.originProject),
    sourceAssets,
    node: null,
  }
}

function normalizePersistedGenerationJob(job) {
  if (!job?.id || !RECOVERABLE_JOB_STATUSES.has(job.status)) return null
  const originProject = sanitizeProjectOriginForStorage(job.originProject)
  const hasPromptId = Boolean(job.promptId)
  const status = job.status === 'paused'
    ? 'paused'
    : 'queued'
  const assetFields = job.sourceAssets?.assetFields && typeof job.sourceAssets.assetFields === 'object'
    ? Object.fromEntries(
      Object.entries(job.sourceAssets.assetFields)
        .map(([key, asset]) => [key, sanitizeAssetSnapshotForStorage(asset)])
        .filter(([, asset]) => Boolean(asset))
    )
    : null

  return {
    ...job,
    originProject,
    sourceAssets: job.sourceAssets && typeof job.sourceAssets === 'object'
      ? {
        input: sanitizeAssetSnapshotForStorage(job.sourceAssets.input),
        reference1: sanitizeAssetSnapshotForStorage(job.sourceAssets.reference1),
        reference2: sanitizeAssetSnapshotForStorage(job.sourceAssets.reference2),
        audio: sanitizeAssetSnapshotForStorage(job.sourceAssets.audio),
        assetFields,
      }
      : null,
    status,
    progress: hasPromptId ? Math.max(Number(job.progress) || 0, 45) : 0,
    error: null,
    node: null,
    restoredFromLedger: true,
  }
}

function loadPersistedGenerationQueue() {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(GENERATION_QUEUE_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(normalizePersistedGenerationJob)
      .filter(Boolean)
      .slice(-PERSISTED_GENERATION_QUEUE_LIMIT)
  } catch (error) {
    console.error('Failed to load persisted generation queue:', error)
    return []
  }
}

function ensureProjectDataFolderPath(projectData, pathSegments = []) {
  const segments = (Array.isArray(pathSegments) ? pathSegments : [])
    .map((segment) => String(segment || '').trim())
    .filter(Boolean)

  if (segments.length === 0) {
    return { projectData, folderId: null }
  }

  const existingFolders = Array.isArray(projectData?.folders) ? [...projectData.folders] : []
  const nextFolderCounter = existingFolders.reduce((maxId, folder) => {
    const idNumber = String(folder?.id || '').match(/^folder-(\d+)$/)?.[1]
    return Math.max(maxId, Number(idNumber) || 0)
  }, 0) + 1
  const nextProject = {
    ...(projectData || {}),
    folders: existingFolders,
    folderCounter: Math.max(Number(projectData?.folderCounter) || 1, nextFolderCounter),
  }

  let parentId = null
  for (const segment of segments) {
    const segmentKey = segment.toLowerCase()
    let folder = nextProject.folders.find((entry) => {
      const entryParentId = entry?.parentId || null
      const entryName = String(entry?.name || '').trim().toLowerCase()
      return entryParentId === parentId && entryName === segmentKey
    })

    if (!folder) {
      folder = {
        id: `folder-${nextProject.folderCounter}`,
        name: segment,
        parentId,
        color: null,
        createdAt: new Date().toISOString(),
      }
      nextProject.folders.push(folder)
      nextProject.folderCounter += 1
    }

    parentId = folder?.id || parentId
  }

  return { projectData: nextProject, folderId: parentId }
}

async function appendAssetToProjectFile(projectHandle, asset, folderPathSegments = []) {
  const projectData = await loadProjectFile(projectHandle)
  if (!projectData) {
    throw new Error('Origin project file is unavailable')
  }

  const { projectData: projectWithFolders, folderId } = ensureProjectDataFolderPath(projectData, folderPathSegments)
  const persistedAsset = {
    ...asset,
    createdAt: asset.createdAt || new Date().toISOString(),
    folderId: asset.folderId ?? folderId,
    url: asset.isImported ? null : asset.url,
    playbackCacheUrl: undefined,
    proxyUrl: undefined,
  }
  const updatedProject = {
    ...projectWithFolders,
    assets: [persistedAsset, ...(Array.isArray(projectWithFolders.assets) ? projectWithFolders.assets : [])],
    modified: new Date().toISOString(),
  }

  await saveProjectFile(projectHandle, updatedProject)
  return persistedAsset
}

function getDirectorAngleShortToken(angle = '') {
  const normalized = String(angle || '').trim().toLowerCase()
  if (!normalized) return 'ANG'
  if (normalized.includes('over-the-shoulder') || normalized === 'ots') return 'OTS'
  if (normalized.includes('close')) return 'CU'
  if (normalized.includes('medium')) return 'MS'
  if (normalized.includes('wide') || normalized.includes('establish')) return 'WS'
  if (normalized.includes('low')) return 'LOW'
  if (normalized.includes('high')) return 'HIGH'
  if (normalized.includes('pov')) return 'POV'
  if (normalized.includes('track')) return 'TRK'
  if (normalized.includes('handheld')) return 'HAND'
  if (normalized.includes('eye')) return 'EYE'
  return slugifyNameToken(angle, { fallback: 'ANG', maxLength: 6 }).toUpperCase()
}

function getDirectorWorkflowShortToken(workflowId = '', stage = '') {
  if (stage === 'storyboard') return 'keyframe'
  switch (workflowId) {
    case 'ltx23-i2v':
      return 'ltx23'
    case 'wan22-i2v':
      return 'wan22'
    case 'kling-o3-i2v':
      return 'kling'
    case 'grok-video-i2v':
      return 'grok'
    case 'vidu-q2-i2v':
      return 'vidu'
    case MUSIC_VIDEO_SHOT_WORKFLOW_ID:
      return 'ltx23_audio'
    case SHORT_FILM_DIALOGUE_VIDEO_WORKFLOW_ID:
      return 'ltx23_dialogue'
    case 'nano-banana-2':
    case 'nano-banana-pro':
      return 'keyframe'
    case 'z-image-turbo':
      return 'keyframe'
    case 'grok-text-to-image':
      return 'keyframe'
    case 'seedream-5-lite-image-edit':
    case 'image-edit':
    case 'image-edit-model-product':
      return 'keyframe'
    default:
      return slugifyNameToken(workflowId || stage, { fallback: 'gen', maxLength: 12 })
  }
}

function buildDirectorAssetDisplayName(directorMeta, workflowId = '') {
  if (!directorMeta) return ''
  const sceneNumber = String(directorMeta?.sceneId || '').match(/\d+/)?.[0] || ''
  const shotNumber = String(directorMeta?.shotId || '').match(/\d+/)?.[0] || ''
  const sceneToken = sceneNumber ? `S${sceneNumber.padStart(2, '0')}` : slugifyNameToken(directorMeta?.sceneId, { fallback: 'S', maxLength: 8 }).toUpperCase()
  const shotToken = shotNumber ? `SH${shotNumber.padStart(2, '0')}` : slugifyNameToken(directorMeta?.shotId, { fallback: 'SH', maxLength: 8 }).toUpperCase()
  const angleToken = getDirectorAngleShortToken(directorMeta?.angle)
  const takeToken = `T${Math.max(1, Number(directorMeta?.take) || 1)}`
  const passType = String(directorMeta?.pass?.type || '')
  const passToken = (() => {
    if (!passType || passType === 'master') return ''
    if (passType === 'environmental_broll') return 'env'
    if (passType === 'detail_broll') return 'det'
    if (passType === 'alt_performance') return 'alt'
    return slugifyNameToken(passType, { fallback: '', maxLength: 8 })
  })()
  const workflowToken = getDirectorWorkflowShortToken(directorMeta?.workflowId || workflowId, directorMeta?.stage)

  return [sceneToken, shotToken, angleToken, takeToken, passToken, workflowToken]
    .filter(Boolean)
    .join('_')
}

function clampNumberValue(value, min, max, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

function parseAnglesInput(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
      .slice(0, 8)
  }
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 8)
}

function summarizeSceneText(value = '', fallback = '') {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 0) return String(fallback || '').trim()

  let candidate = lines[0]
  candidate = candidate.replace(/^(?:scene\s+\d+|sc\s*\d+|#\s*scene|\d+\.)\s*[:\-]?\s*/i, '').trim()
  if (!candidate && lines.length > 1) candidate = lines[1]

  const firstSentence = (candidate || lines[0]).split(/(?<=[.!?])\s+/)[0]
  const compact = String(firstSentence || '').replace(/\s+/g, ' ').trim()
  if (compact.length <= 140) return compact
  return `${compact.slice(0, 137)}...`
}

function stripFileExtension(value = '') {
  return String(value || '').replace(/\.[^/.]+$/, '')
}

function slugifyNameToken(value = '', options = {}) {
  const fallback = Object.prototype.hasOwnProperty.call(options, 'fallback')
    ? String(options.fallback || '')
    : 'item'
  const maxLength = Math.max(1, Number(options.maxLength) || 32)
  let normalized = String(value || '').trim()

  try {
    normalized = normalized.normalize('NFKD')
  } catch (_) {
    // Keep original if unicode normalization is unavailable.
  }

  const slug = normalized
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()

  if (!slug) return fallback
  return slug.slice(0, maxLength)
}

function buildAdReferenceStyleNotes({
  hasProduct = false,
  hasModel = false,
  productName = '',
  modelName = '',
  brandName = '',
  productDisplayName = '',
  palette = '',
  constraints = '',
  spokespersonRole = '',
  wardrobeNotes = '',
  formatLabel = '',
  platformLabel = '',
  consistency = 'medium',
} = {}) {
  if (!hasProduct && !hasModel && !brandName && !productDisplayName && !palette && !constraints && !spokespersonRole && !wardrobeNotes && !formatLabel && !platformLabel) return ''

  const notes = []
  if (brandName || productDisplayName) {
    notes.push(`Brand/product brief: ${[brandName, productDisplayName].filter(Boolean).join(' — ')}.`)
  }
  if (formatLabel) {
    notes.push(`Ad format: ${formatLabel}.`)
  }
  if (platformLabel) {
    notes.push(`Target platform: ${platformLabel}. Compose for this delivery shape and leave safe negative space for editor-added graphics.`)
  }
  if (palette) {
    notes.push(`Brand color palette: ${palette}. Use these colors consistently in lighting, backgrounds, wardrobe accents, and editor-added graphics.`)
  }
  if (constraints) {
    notes.push(`Required brand-graphic constraints for the editor stage: ${constraints}. Do not invent claims, captions, labels, or added typography inside generated frames.`)
  }
  if (hasProduct) {
    notes.push(
      `Use the product from the reference image${productName ? ` (${productName})` : ''}. Keep packaging shape, brand colors, logo placement, and label details consistent across all shots.`
    )
  }
  if (hasModel) {
    notes.push(
      `Use the same person from the model reference${modelName ? ` (${modelName})` : ''}. Keep facial identity, hairstyle, skin tone, body proportions, and wardrobe consistent in every shot.`
    )
  }
  if (spokespersonRole) {
    notes.push(`Spokesperson/model role: ${spokespersonRole}.`)
  }
  if (wardrobeNotes) {
    notes.push(`Wardrobe/identity notes: ${wardrobeNotes}.`)
  }
  if (hasProduct && hasModel) {
    notes.push('When both appear, keep the product scale natural in hand and preserve believable interaction between model and product.')
  }

  if (consistency === 'strict') {
    notes.push('Consistency mode: strict. Prioritize matching the references over adding stylistic variation.')
    notes.push('Identity lock: this must be the exact same person in every shot and take. No identity drift, no face morphing, no hairstyle changes, and no wardrobe swaps.')
  } else if (consistency === 'soft') {
    notes.push('Consistency mode: soft. Keep identity anchors but allow moderate styling changes between shots.')
  } else {
    notes.push('Consistency mode: medium. Balance identity consistency with natural cinematic variation.')
  }
  notes.push('Keyframe rule: render a single continuous frame per prompt (no split-screen, no collage, no storyboard grids).')

  return notes.join(' ')
}

const AD_VIDEO_NO_TEXT_GUARD = [
  'Clean natural product footage only.',
  'Preserve the first frame composition, subject identity, product shape, lighting, and camera setup.',
  'Animate only the described subject motion and camera motion.',
].join(' ')

function buildAdVideoPromptWithNoTextGuard(prompt = '', options = {}) {
  const bannedLinePattern = /(text\s*overlay|overlay\s*text|end\s*card|endcard|typograph|caption|subtitle|lower\s*third|title\s*card|cta|call\s*to\s*action|brand\/product\s*brief|required\s*brand-graphic|target\s*platform|editor-added|editor-native|commercial\s*beat|ad\s*format|safe\s*area)/i
  let cleaned = String(prompt || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part && !bannedLinePattern.test(part))
    .join(' ')
  for (const term of options.omitTerms || []) {
    const text = String(term || '').trim()
    if (!text) continue
    cleaned = cleaned.replace(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '')
  }
  cleaned = cleaned
    .replace(/\b(?:advertisement|commercial|ad)\b/gi, 'product film')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return [cleaned, AD_VIDEO_NO_TEXT_GUARD].filter(Boolean).join(' ')
}

function buildAdVideoNegativePrompt(baseNegativePrompt = '') {
  return [
    baseNegativePrompt,
    'text, typography, captions, subtitles, lower thirds, title card, end card text, overlay text, fake text, gibberish text, random letters, unreadable words, watermark, logo overlay, labels, price tag, UI text, handwriting, signage',
  ]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(', ')
}

const DIRECTOR_STYLE_NOTE_CONTAMINATION_PATTERNS = Object.freeze([
  /strict continuity:\s*same person identity,\s*same hairstyle,\s*same outfit colors and fit,\s*same coral\/pink sneaker with teal swoosh;\s*no logo\/color\/shape drift\.?/gi,
])

function sanitizeDirectorStyleNotesInput(value = '') {
  let cleaned = String(value || '')
  for (const pattern of DIRECTOR_STYLE_NOTE_CONTAMINATION_PATTERNS) {
    cleaned = cleaned.replace(pattern, ' ')
  }
  return cleaned.replace(/\s{2,}/g, ' ').trim()
}

function createYoloPlanSignature(payload = {}) {
  try {
    return JSON.stringify(payload)
  } catch (_) {
    return ''
  }
}

function formatReferenceConsistencyLabel(consistency = 'medium') {
  if (consistency === 'strict') return 'Strict'
  if (consistency === 'soft') return 'Soft'
  return 'Medium'
}

function getOwnTextFieldValue(source, key) {
  if (!source || typeof source !== 'object' || !Object.prototype.hasOwnProperty.call(source, key)) {
    return undefined
  }
  return source[key] == null ? '' : String(source[key])
}

function firstDefinedTextValue(...values) {
  const found = values.find((value) => value !== undefined && value !== null)
  return found == null ? '' : String(found)
}

function normalizeShotForScene(sceneId, shot, shotIndex, fallback = {}, options = {}) {
  const minDurationSeconds = Math.max(0.1, Number(options.minDurationSeconds) || 2)
  const maxDurationSeconds = Math.max(minDurationSeconds, Number(options.maxDurationSeconds) || 5)
  const fallbackAngles = parseAnglesInput(fallback?.angles || ['Medium shot'])
  const parsedAngles = parseAnglesInput(shot?.angles)
  // Preserve free-text fields exactly while editing. Prompt builders trim at queue time.
  const fallbackBeat = firstDefinedTextValue(
    getOwnTextFieldValue(fallback, 'videoBeat'),
    getOwnTextFieldValue(fallback, 'imageBeat'),
    getOwnTextFieldValue(fallback, 'beat')
  )
  const imageBeat = firstDefinedTextValue(
    getOwnTextFieldValue(shot, 'imageBeat'),
    getOwnTextFieldValue(shot, 'beat'),
    getOwnTextFieldValue(fallback, 'imageBeat'),
    getOwnTextFieldValue(fallback, 'beat')
  )
  const videoBeat = firstDefinedTextValue(
    getOwnTextFieldValue(shot, 'videoBeat'),
    getOwnTextFieldValue(shot, 'beat'),
    getOwnTextFieldValue(fallback, 'videoBeat'),
    fallbackBeat
  )
  const shotType = String(shot?.shotType || fallback?.shotType || '').trim()
  const cameraDirection = firstDefinedTextValue(
    getOwnTextFieldValue(shot, 'cameraDirection'),
    getOwnTextFieldValue(fallback, 'cameraDirection')
  )
  const duration = clampNumberValue(
    shot?.durationSeconds,
    minDurationSeconds,
    maxDurationSeconds,
    clampNumberValue(fallback?.durationSeconds, minDurationSeconds, maxDurationSeconds, 3)
  )
  const takes = clampNumberValue(
    shot?.takesPerAngle,
    1,
    4,
    clampNumberValue(fallback?.takesPerAngle, 1, 4, 1)
  )

  return {
    // Preserve unknown keys first (music-video payload like musicShotType,
    // audioStart, length, shotPrompt, referenceImagePrompt lives here).
    // Known keys below override so the normalizer stays authoritative for
    // pipeline-critical fields.
    ...(shot && typeof shot === 'object' ? shot : {}),
    id: `${sceneId}_SH${shotIndex + 1}`,
    index: shotIndex + 1,
    beat: videoBeat, // Legacy alias retained for old persisted plans.
    imageBeat,
    videoBeat,
    shotType,
    cameraDirection,
    durationSeconds: Number(duration.toFixed(2)),
    takesPerAngle: Math.round(takes),
    angles: parsedAngles.length > 0 ? parsedAngles : (fallbackAngles.length > 0 ? fallbackAngles : ['Medium shot']),
    cameraPresetId: String(shot?.cameraPresetId || fallback?.cameraPresetId || 'auto'),
  }
}

function resolveCameraPresetAngles(presetId, targetCount = 2) {
  const preset = YOLO_CAMERA_PRESET_OPTIONS.find((option) => option.id === presetId)
  const preferred = Array.isArray(preset?.angles) ? preset.angles : []
  const fallbackPool = ['Medium shot', 'Wide shot', 'Close-up', 'Eye level', 'Low angle', 'High angle', 'POV', 'Tracking shot']
  const count = Math.max(1, Math.min(8, Number(targetCount) || preferred.length || 1))
  return Array.from({ length: count }, (_, index) => preferred[index] || fallbackPool[index % fallbackPool.length])
}

function normalizePersistedYoloPlan(rawPlan = []) {
  if (!Array.isArray(rawPlan)) return []
  return rawPlan.map((scene, sceneIndex) => {
    const sceneId = String(scene?.id || `S${sceneIndex + 1}`)
    const shots = Array.isArray(scene?.shots) ? scene.shots : []
    return {
      ...scene,
      id: sceneId,
      index: Number(scene?.index) || (sceneIndex + 1),
      shots: shots.map((shot, shotIndex) => normalizeShotForScene(sceneId, shot, shotIndex, shot)),
    }
  })
}

/**
 * Compose the motion/video prompt that gets written into the LTX 2.3
 * audio-conditioned workflow (node 1624). Built from the script's Motion
 * prompt + shot-type suffix + concept/style continuity lines + an optional
 * lyric cue for vocal-aligned shots (so the encoder has the line the singer
 * is mouthing without making b-roll look like lip-sync coverage).
 */
function composeMusicShotVideoPrompt({
  motionPromptRaw = '',
  shotTypeOption = null,
  lyricMoment = '',
  concept = '',
  styleNotes = '',
}) {
  const shouldUseLyricCue = Boolean(shotTypeOption?.needsVocalAlignment)
  const lyricCue = shouldUseLyricCue ? String(lyricMoment || '')
    .replace(/["'\u2018\u2019\u201C\u201D]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240) : ''
  const motion = String(motionPromptRaw || '').trim()
  const conceptLine = String(concept || '').trim()
  const styleLine = String(styleNotes || '').trim()
  const shotSuffix = String(shotTypeOption?.promptSuffix || '').trim()

  const parts = [
    motion,
    shotSuffix,
    lyricCue ? `The artist visibly sings this exact lyric phrase: "${lyricCue}".` : '',
    conceptLine ? `Concept: ${conceptLine}.` : '',
    styleLine ? `Style: ${styleLine}.` : '',
  ].filter(Boolean)
  return parts.join(' ')
}

function buildMusicVideoNegativePrompt(baseNegativePrompt = '', shotType = '') {
  return String(baseNegativePrompt || '').trim()
}

/**
 * Compose the reference-image prompt used by the storyboard pass to generate
 * the per-shot keyframe still. Built from the script's Keyframe prompt plus
 * shot-type-specific framing cues (close / wide / b-roll).
 *
 * This is the prompt the stills workflow (nano-banana-2 / Qwen image edit)
 * renders against; the artist reference image (if set) anchors identity.
 */
function composeMusicShotReferencePrompt({
  keyframePromptRaw = '',
  shotTypeOption = null,
  concept = '',
  styleNotes = '',
}) {
  const keyframe = String(keyframePromptRaw || '').trim()
  const conceptLine = String(concept || '').trim()
  const styleLine = String(styleNotes || '').trim()
  const shotFocus = shotTypeOption?.id === 'b_roll'
    ? 'Environment / cutaway composition, no performer singing on camera.'
    : shotTypeOption?.id === 'performance_wide'
      ? 'Artist visible in a wider framing, natural body posture, readable expression.'
      : 'Artist visible with a readable face, natural performance posture.'

  const parts = [
    keyframe,
    shotFocus,
    conceptLine ? `Concept: ${conceptLine}.` : '',
    styleLine ? `Style: ${styleLine}.` : '',
    'Render one cinematic keyframe still, no collage, no split screen, no multiple panels.',
    'Maintain consistent subject identity and wardrobe across the video.',
  ].filter(Boolean)
  return parts.join(' ')
}

/**
 * Build a music-video plan from a director-format script (ad-style grammar
 * extended with `Lyric moment:`, `Length:`, `Artist:`, and `Start at:`).
 *
 * audioStart resolution (Phase 8 — SRT-first):
 *   1. `Start at:` on the shot — parsed via parseTimeSpecToSeconds.
 *   2. `Lyric moment:` fuzzy-matched against the parsed SRT/LRC (if the
 *      single `lyrics` field happens to be in a timed format).
 *   3. `Lyric moment:` fuzzy-matched against plain lyrics + linear estimate
 *      (path when the `lyrics` field is plain text).
 *   4. Cumulative sum of prior shot lengths (the old behavior).
 *
 * The chosen path is recorded on the shot as `audioStartSource` so the
 * inspector / validation layer can surface it and coverage checks can tell
 * pinned vs. inferred placements apart.
 *
 * Input shape:
 *   { script, lyrics, concept, styleNotes, targetDuration,
 *     songDurationSeconds, cast }
 *
 * The `lyrics` field is a single blob that the planner auto-detects as
 * plain text, SRT, or LRC via detectTimedLyricsFormat. When timed, tiers 2
 * (SRT fuzzy) + validation cross-check run; when plain, tier 3 (legacy
 * linear estimate) + [Name] tag resolution run. There is no separate SRT
 * input — the Option A merge in Phase 8 collapsed the two.
 *
 * Output:
 *   { scenes, warnings } — scenes matches flattenYoloPlanVariants' expected
 *   shape; warnings is a flat list of { kind, message, ... } entries.
 */
function buildMusicVideoPlanFromScript(options = {}) {
  const {
    script = '',
    lyrics = '',
    concept = '',
    styleNotes = '',
    targetDuration = 30,
    songDurationSeconds = 0,
    cast = [],
  } = options

  // Warnings accumulator lives at the top of the function so every tier —
  // lyric parsing, artist resolution, and the tail-end coverage/overlap/
  // drift checks — can push into it without order dependency.
  const warnings = []

  const parsed = parseStructuredDirectorScript(script, {
    // Music plan flattens each parsed shot to 1 angle × 1 take. The shared
    // pipeline requires takesPerAngle, so we hardcode 1 here to match the
    // yoloActive*PerScene overrides in music mode.
    takesPerAngle: 1,
    targetDurationSeconds: targetDuration,
    variationSeed: 0,
    styleNotes: '',
    minShotDurationSeconds: MUSIC_VIDEO_SHOT_DEFAULTS.minShotLengthSeconds,
    maxShotDurationSeconds: MUSIC_VIDEO_SHOT_DEFAULTS.maxShotLengthSeconds,
  })
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { scenes: [], warnings }
  }

  // Detect format on the single lyrics blob. 'srt' / 'lrc' route into the
  // timed path; 'unknown' / 'empty' route into the plain-lyrics path.
  const lyricsFormat = detectTimedLyricsFormat(lyrics)
  const lyricsIsTimed = lyricsFormat === 'srt' || lyricsFormat === 'lrc'

  // Timed-lyric parse (only when the format actually looks timed — otherwise
  // parseTimedLyrics returns no lines and we skip the tier-2 fuzzy path).
  const parsedTimed = lyricsIsTimed ? parseTimedLyrics(lyrics) : { lines: [], error: null }
  const timedLyricLines = Array.isArray(parsedTimed.lines) ? parsedTimed.lines : []
  const hasTimedLyrics = timedLyricLines.length > 0
  if (parsedTimed.error) {
    warnings.push({
      shotIndex: 0,
      shotLabel: '',
      kind: 'srt-parse-error',
      raw: lyricsFormat,
      message: `Lyrics Timing: ${parsedTimed.error}`,
    })
  }

  // Plain-lyrics parse: only meaningful when the paste isn't a timed file.
  // When the blob is SRT/LRC, skipping this saves us a weird secondary tag
  // parse against something shaped wrong.
  const taggedLyricLines = lyricsIsTimed ? [] : parseLyricsWithTags(lyrics)
  const lyricLineTexts = taggedLyricLines.map((entry) => entry.text)
  const lyricLinesLegacy = lyricsIsTimed ? [] : parseLyricLines(lyrics)
  // Prefer the tagged parse's line list when we got a tag structure out, but
  // fall back to the legacy cleaner if the user wrote plain lyrics with no
  // brackets at all (behaves identically in that case).
  const effectiveLyricLines = lyricLineTexts.length > 0 ? lyricLineTexts : lyricLinesLegacy

  const safeCast = Array.isArray(cast) ? cast.filter((c) => c?.assetId) : []
  const defaultCastMember = safeCast[0] || null
  const safeTargetDuration = Math.max(10, Number(targetDuration) || 30)
  const safeSongDuration = Math.max(0, Number(songDurationSeconds) || 0)
  const result = []
  const coverageRanges = [] // [{ start, end, shotIndex, label, source }]
  let runningAudioStart = 0
  let flatShotIndex = 0

  for (const scene of parsed) {
    for (const scriptShot of scene?.shots || []) {
      flatShotIndex += 1

      const shotTypeId = resolveMusicVideoShotTypeFromText(scriptShot.shotType) || 'performance'
      const shotTypeOption = getMusicVideoShotTypeOption(shotTypeId)
      const { length: clampedLength } = clampMusicVideoShotLength(scriptShot.durationSeconds)
      const coverageType = String(scriptShot.coverageType || scene?.coverageType || '').trim()
      const coverageLabel = String(scriptShot.coverageLabel || scene?.coverageLabel || '').trim()
      const coverageKey = coverageLabel || coverageType || 'primary'

      const lyricMomentHint = String(scriptShot.lyricMoment || '').trim()
      const startAtRaw = String(scriptShot.startAtRaw || '').trim()
      const isVocalAlignedShot = Boolean(shotTypeOption?.needsVocalAlignment)
      const isEnvironmentOrDetailCoverage = coverageType === 'environmental_broll' || coverageType === 'detail_broll'
      const effectiveLyricMomentHint = isVocalAlignedShot ? lyricMomentHint : ''
      if (lyricMomentHint && !isVocalAlignedShot) {
        warnings.push({
          shotIndex: flatShotIndex,
          shotLabel: scriptShot.label || `Shot ${flatShotIndex}`,
          kind: 'broll-lyric-moment-ignored',
          raw: lyricMomentHint,
          message: `Shot ${flatShotIndex}${scriptShot.label ? ` (${scriptShot.label})` : ''}: Lyric moment was ignored because b-roll/cutaway shots must not lip-sync.`,
          severity: 'info',
        })
      }

      // Tier 1 — explicit `Start at:` from the script (Phase 8).
      const explicitStart = startAtRaw ? parseTimeSpecToSeconds(startAtRaw) : null
      if (startAtRaw && explicitStart === null) {
        warnings.push({
          shotIndex: flatShotIndex,
          shotLabel: scriptShot.label || `Shot ${flatShotIndex}`,
          kind: 'unparseable-start-at',
          raw: startAtRaw,
          message: `Shot ${flatShotIndex}${scriptShot.label ? ` (${scriptShot.label})` : ''}: "Start at: ${startAtRaw}" is not a recognizable time (expected e.g. 0:15, 15s, or 00:00:15,500).`,
        })
      }

      // Tier 2 — fuzzy-match the Lyric moment against parsed SRT/LRC.
      const timedMatch = effectiveLyricMomentHint && hasTimedLyrics
        ? findTimedLyricLineByText(effectiveLyricMomentHint, timedLyricLines)
        : null

      // Tier 3 — legacy linear estimate based on plain lyric line index.
      const lineIdx = effectiveLyricMomentHint && effectiveLyricLines.length > 0
        ? findLyricLineIndex(effectiveLyricMomentHint, effectiveLyricLines)
        : -1

      let audioStart
      let audioStartSource
      if (explicitStart !== null) {
        audioStart = explicitStart
        audioStartSource = 'start-at'
      } else if (timedMatch && typeof timedMatch.startSec === 'number') {
        audioStart = timedMatch.startSec
        audioStartSource = 'srt-fuzzy'
      } else if (lineIdx >= 0) {
        audioStart = estimateLyricLineStartSeconds(lineIdx, effectiveLyricLines.length, safeTargetDuration)
        audioStartSource = 'lyric-linear'
      } else {
        audioStart = runningAudioStart
        audioStartSource = 'continue'
      }

      // Artist resolution priority:
      //   1. Per-shot `Artist:` override from the script
      //   2. The `[Name]` tag on the matched lyric line (if any)
      //   3. The first cast member ("default lead"), if a cast exists
      //   4. No reference (model improvises)
      //
      // We short-circuit as soon as a non-empty resolution is produced, so
      // an explicit `Artist: jane` wins even if the lyric tag says [Rose].
      let resolvedMembers = []
      let resolvedSource = ''
      const artistOverrideRaw = String(scriptShot.artistRaw || '').trim()
      if (artistOverrideRaw && isEnvironmentOrDetailCoverage) {
        warnings.push({
          shotIndex: flatShotIndex,
          shotLabel: scriptShot.label || `Shot ${flatShotIndex}`,
          kind: 'artist-ignored-for-non-character-broll',
          raw: artistOverrideRaw,
          message: `Shot ${flatShotIndex}${scriptShot.label ? ` (${scriptShot.label})` : ''}: Artist was ignored because environmental/detail b-roll should not attach a performer reference.`,
          severity: 'info',
        })
      } else if (artistOverrideRaw) {
        const names = splitCastNameList(artistOverrideRaw)
        const { members, unresolved } = resolveCastMembersFromNameList(names, safeCast)
        if (members.length > 0) {
          resolvedMembers = members
          resolvedSource = 'script-override'
        }
        for (const name of unresolved) {
          warnings.push({
            shotIndex: flatShotIndex,
            shotLabel: scriptShot.label || `Shot ${flatShotIndex}`,
            kind: 'unresolved-artist-override',
            raw: name,
            message: `Shot ${flatShotIndex}${scriptShot.label ? ` (${scriptShot.label})` : ''}: "Artist: ${name}" did not match any cast member.`,
          })
        }
      }
      if (resolvedMembers.length === 0 && !isEnvironmentOrDetailCoverage && lineIdx >= 0) {
        const tags = taggedLyricLines[lineIdx]?.tags || []
        if (tags.length > 0) {
          const { members, unresolved } = resolveCastMembersFromNameList(tags, safeCast)
          if (members.length > 0) {
            resolvedMembers = members
            resolvedSource = 'lyric-tag'
          }
          for (const name of unresolved) {
            warnings.push({
              shotIndex: flatShotIndex,
              shotLabel: scriptShot.label || `Shot ${flatShotIndex}`,
              kind: 'unresolved-lyric-tag',
              raw: name,
              message: `Shot ${flatShotIndex}: lyric tag "[${name}]" did not match any cast member.`,
            })
          }
        }
      }
      if (resolvedMembers.length === 0 && isVocalAlignedShot && defaultCastMember) {
        resolvedMembers = [defaultCastMember]
        resolvedSource = 'default-cast'
      }
      // The queue code currently supports up to two reference-image slots
      // (referenceAssetId1 / referenceAssetId2). If the user specified three+
      // (e.g. Artist: all with a 4-piece band), we keep slots 1–2 and warn.
      if (resolvedMembers.length > 2) {
        const dropped = resolvedMembers.slice(2).map((m) => m?.label || m?.slug).filter(Boolean)
        warnings.push({
          shotIndex: flatShotIndex,
          shotLabel: scriptShot.label || `Shot ${flatShotIndex}`,
          kind: 'too-many-artists',
          raw: dropped.join(', '),
          message: `Shot ${flatShotIndex}: ${resolvedMembers.length} cast members resolved, but only two reference slots are available (${dropped.join(', ')} were dropped).`,
        })
      }
      const slot1 = resolvedMembers[0]?.assetId || null
      const slot2 = resolvedMembers[1]?.assetId || null

      const videoPrompt = composeMusicShotVideoPrompt({
        motionPromptRaw: scriptShot.motionPromptRaw || scriptShot.videoBeat,
        shotTypeOption,
        lyricMoment: effectiveLyricMomentHint,
        concept,
        styleNotes,
      })
      const referencePrompt = composeMusicShotReferencePrompt({
        keyframePromptRaw: scriptShot.keyframePromptRaw || scriptShot.imageBeat,
        shotTypeOption,
        concept,
        styleNotes,
      })

      // Each script shot becomes its own scene with exactly one shot, because
      // the shared storyboard/video pipeline flattens scene → shot → angle
      // and music videos don't use the scene grouping beyond display labels.
      const sceneIdStr = `M${flatShotIndex}`
      const shotIdStr = `${sceneIdStr}_SH1`

      result.push({
        id: sceneIdStr,
        index: flatShotIndex,
        label: scriptShot.label || scene?.label || '',
        coverageType,
        coverageLabel,
        coverageSectionIndex: Number(scene?.coverageSectionIndex || scriptShot?.coverageSectionIndex) || null,
        coverageSectionLabel: String(scene?.coverageSectionLabel || scriptShot?.coverageSectionLabel || '').trim(),
        shots: [{
          id: shotIdStr,
          index: 1,
          // Legacy pipeline fields so flattenYoloPlanVariants + the shared
          // queue code consume this without branching on music vs ad.
          beat: videoPrompt,
          imageBeat: referencePrompt,
          videoBeat: videoPrompt,
          shotType: '',
          cameraDirection: String(scriptShot.cameraDirection || ''),
          durationSeconds: Number(clampedLength.toFixed(2)),
          takesPerAngle: 1,
          angles: ['Medium shot'],
          cameraPresetId: 'auto',
          // Music-video-specific payload consumed by modifyMusicVideoShotWorkflow.
          musicShotType: shotTypeId,
          coverageType,
          coverageLabel,
          coverageSectionIndex: Number(scriptShot?.coverageSectionIndex || scene?.coverageSectionIndex) || null,
          coverageSectionLabel: String(scriptShot?.coverageSectionLabel || scene?.coverageSectionLabel || '').trim(),
          audioStart: Number(Number(audioStart).toFixed(2)),
          length: Number(clampedLength.toFixed(2)),
          shotPrompt: videoPrompt,
          referenceImagePrompt: referencePrompt,
          // Resolved per-shot artist references. queueYoloStoryboardVariants
          // reads these (in music mode) to fill referenceAssetId1/2 before
          // falling back to the default single-artist field.
          resolvedArtistAssetIds: [slot1, slot2].filter(Boolean),
          resolvedArtistSource: resolvedSource,
          resolvedArtistLabels: resolvedMembers.slice(0, 2).map((m) => m?.label || m?.slug || ''),
          // Phase 8 timing diagnostics — surfaced in the shot inspector and
          // consumed by the validation/coverage passes below.
          audioStartSource,
          scriptStartAtRaw: startAtRaw,
          srtMatchedLineIndex: timedMatch ? timedMatch.index : -1,
          // Diagnostic / editable metadata so future UI can show the raw
          // script fields back to the user without reparsing.
          scriptShotLabel: scriptShot.label || '',
          scriptLyricMoment: lyricMomentHint,
          scriptLyricLineIndex: lineIdx,
          scriptArtistRaw: artistOverrideRaw,
        }],
      })

      coverageRanges.push({
        shotIndex: flatShotIndex,
        label: scriptShot.label || `Shot ${flatShotIndex}`,
        start: Number(audioStart),
        end: Number(audioStart) + clampedLength,
        source: audioStartSource,
        lyricMoment: lyricMomentHint,
        srtMatch: timedMatch || null,
        coverageKey,
        coverageType,
        coverageLabel,
      })

      // Advance the cumulative cursor from wherever this shot actually lands
      // so unhinted shots that follow will continue from here (not from some
      // stale previous value). This matters most for mixed scripts that
      // interleave pinned and continue-from-previous shots.
      runningAudioStart = Number(audioStart) + clampedLength
    }
  }

  // ============ Phase 8c — validation pass =============================
  //
  // All three checks push into the same `warnings` array with distinct
  // `kind` values so the UI can group or filter later. They're intentionally
  // non-fatal: a bad coverage ratio still lets the user click Build / Run,
  // because sometimes "leave gaps on purpose" (e.g. instrumental breaks) is
  // what the user wants.

  // 1) Coverage / gap summary — only meaningful once we know the song length.
  const coverageGroups = new Map()
  for (const range of coverageRanges) {
    const key = String(range.coverageKey || 'primary')
    if (!coverageGroups.has(key)) {
      coverageGroups.set(key, {
        key,
        label: String(range.coverageLabel || range.coverageType || '').trim(),
        ranges: [],
      })
    }
    coverageGroups.get(key).ranges.push(range)
  }

  if (safeSongDuration > 0 && coverageGroups.size > 1) {
    for (const group of coverageGroups.values()) {
      const gaps = computeCoverageGaps(
        group.ranges.map((r) => ({ start: r.start, end: r.end })),
        safeSongDuration,
        0.75
      )
      const coveredSeconds = group.ranges.reduce(
        (acc, r) => acc + Math.max(0, Math.min(r.end, safeSongDuration) - Math.max(0, r.start)),
        0
      )
      const coveragePct = Math.round((coveredSeconds / safeSongDuration) * 100)
      const labelPrefix = group.label ? `${group.label}: ` : ''
      warnings.push({
        shotIndex: 0,
        shotLabel: group.label,
        kind: 'coverage-summary',
        raw: '',
        message: `${labelPrefix}Plan covers ${formatSecondsAsMMSS(coveredSeconds)} of your ${formatSecondsAsMMSS(safeSongDuration)} song (${coveragePct}%).${
          gaps.length > 0
            ? ` Gaps: ${gaps.map((g) => `${formatSecondsAsMMSS(g.start)}-${formatSecondsAsMMSS(g.end)}`).join(', ')}.`
            : ' No gaps.'
        }`,
        severity: gaps.length === 0 ? 'info' : coveragePct >= 90 ? 'info' : 'warning',
        gaps,
        coveredSeconds,
        songDuration: safeSongDuration,
        coveragePct,
        coverageKey: group.key,
        coverageLabel: group.label,
      })
    }
  }

  if (safeSongDuration > 0 && coverageRanges.length > 0 && coverageGroups.size <= 1) {
    const gaps = computeCoverageGaps(
      coverageRanges.map((r) => ({ start: r.start, end: r.end })),
      safeSongDuration,
      0.75 // ignore gaps shorter than 0.75s — noise
    )
    const coveredSeconds = coverageRanges.reduce(
      (acc, r) => acc + Math.max(0, Math.min(r.end, safeSongDuration) - Math.max(0, r.start)),
      0
    )
    const coveragePct = Math.round((coveredSeconds / safeSongDuration) * 100)
    warnings.push({
      shotIndex: 0,
      shotLabel: '',
      kind: 'coverage-summary',
      raw: '',
      message: `Plan covers ${formatSecondsAsMMSS(coveredSeconds)} of your ${formatSecondsAsMMSS(safeSongDuration)} song (${coveragePct}%).${
        gaps.length > 0
          ? ` Gaps: ${gaps.map((g) => `${formatSecondsAsMMSS(g.start)}–${formatSecondsAsMMSS(g.end)}`).join(', ')}.`
          : ' No gaps.'
      }`,
      severity: gaps.length === 0 ? 'info' : coveragePct >= 90 ? 'info' : 'warning',
      gaps,
      coveredSeconds,
      songDuration: safeSongDuration,
      coveragePct,
    })
  }

  // 2) Lyric-moment cross-check — for each shot that has BOTH a Start at:
  //    and a Lyric moment that matched a timed line, we can compare them.
  //    Drift above 1s is suspicious; drift above 2.5s almost always means
  //    the LLM got the timing wrong.
  for (const range of coverageRanges) {
    if (range.source !== 'start-at') continue
    if (!range.lyricMoment || !range.srtMatch) continue
    const drift = Math.abs(range.start - range.srtMatch.startSec)
    if (drift >= 1.0) {
      warnings.push({
        shotIndex: range.shotIndex,
        shotLabel: range.label,
        kind: 'lyric-timing-drift',
        raw: '',
        message: `Shot ${range.shotIndex}: Start at (${formatSecondsAsMMSS(range.start)}) disagrees with SRT timing for "${range.lyricMoment}" (${formatSecondsAsMMSS(range.srtMatch.startSec)}) by ${drift.toFixed(1)}s.`,
        severity: drift >= 2.5 ? 'warning' : 'info',
      })
    }
  }

  // 3) Overlap detector — any two shots whose [start, end] intervals
  //    intersect. Adjacent ranges that only touch (a.end === b.start) are
  //    fine. We compare every pair so the warning list stays informative
  //    even when three+ shots stack up.
  for (const group of coverageGroups.values()) {
    const sortedRanges = [...group.ranges].sort((a, b) => a.start - b.start)
    for (let i = 0; i < sortedRanges.length - 1; i += 1) {
      const a = sortedRanges[i]
      const b = sortedRanges[i + 1]
      if (b.start < a.end - 0.01) {
        const overlap = Math.min(a.end, b.end) - b.start
        const labelPrefix = group.label ? `${group.label}: ` : ''
        warnings.push({
          shotIndex: b.shotIndex,
          shotLabel: b.label,
          kind: 'shot-overlap',
          raw: '',
          message: `${labelPrefix}Shot ${b.shotIndex} (${formatSecondsAsMMSS(b.start)}) overlaps Shot ${a.shotIndex} (ends ${formatSecondsAsMMSS(a.end)}) by ${overlap.toFixed(1)}s.`,
          severity: 'warning',
          coverageKey: group.key,
          coverageLabel: group.label,
        })
      }
    }
  }

  return { scenes: result, warnings }
}

/**
 * Short display badge for a pass type. Used on alt-script tabs so the user
 * can tell "alt performance" from "environmental b-roll" at a glance.
 */
function getMusicVideoPassBadge(passType) {
  switch (passType) {
    case 'alt_performance':     return 'ALT'
    case 'environmental_broll': return 'ENV'
    case 'detail_broll':        return 'DET'
    default:                    return '??'
  }
}

/**
 * Human-readable name for a pass type, used in tooltips and header labels.
 */
function getMusicVideoPassDisplayName(passType) {
  switch (passType) {
    case 'alt_performance':     return 'Alt Performance'
    case 'environmental_broll': return 'Environmental B-roll'
    case 'detail_broll':        return 'Detail B-roll'
    default:                    return 'Alt Pass'
  }
}

const MUSIC_VIDEO_TIMELINE_ASSEMBLY_MODE = 'music-video-easy-mode'
const AD_TIMELINE_ASSEMBLY_MODE = 'ad-easy-mode'

function getAdVideoVariantWorkflowKey(variantKey, workflowId) {
  const key = String(variantKey || '').trim()
  const workflow = String(workflowId || '').trim()
  return key && workflow ? `${key}::${workflow}` : ''
}

function buildGeneratedEditTimelineName(prefix, detail = '') {
  const safePrefix = String(prefix || 'Generated Edit').replace(/\s+/g, ' ').trim()
  const safeDetail = String(detail || '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const name = safeDetail ? `${safePrefix} - ${safeDetail}` : safePrefix
  return name.slice(0, 80)
}

async function ensureGeneratedEditTimeline({ name, width, height, fps, color = null } = {}) {
  const projectState = useProjectStore.getState()
  if (!projectState.currentProject) {
    return { ok: false, message: 'Open or create a project before assembling an edit timeline.' }
  }

  const timelineName = buildGeneratedEditTimelineName(name || 'Generated Edit')
  const timelines = projectState.currentProject.timelines || []
  let timeline = timelines.find((candidate) => candidate?.name === timelineName) || null
  if (!timeline) {
    timeline = projectState.createTimeline({
      name: timelineName,
      width: Number(width) || null,
      height: Number(height) || null,
      fps: Number(fps) || null,
      color,
    })
  }
  if (!timeline?.id) {
    return { ok: false, message: `Could not create timeline "${timelineName}".` }
  }

  const freshProjectState = useProjectStore.getState()
  if (freshProjectState.currentTimelineId !== timeline.id) {
    const switched = await freshProjectState.switchTimeline(timeline.id)
    if (!switched) {
      return { ok: false, message: `Could not switch to timeline "${timelineName}".` }
    }
  }

  return { ok: true, timeline, timelineName }
}

function normalizeMusicVideoCoverageTrackKey(value = '') {
  const text = String(value || '').trim().toLowerCase()
  return text
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'main-sequence'
}

function getMusicVideoTimelineCoverageLabel(coverage = {}, fallback = '') {
  const explicitLabel = String(coverage?.label || '').trim()
  if (explicitLabel) return explicitLabel
  const type = String(coverage?.type || fallback || '').trim()
  switch (type) {
    case 'main_sequence': return 'Main sequence'
    case 'performance_pass': return 'Performance pass'
    case 'story_broll': return 'Story b-roll'
    case 'environmental_broll': return 'Environmental b-roll'
    case 'detail_broll': return 'Detail inserts'
    default:
      return String(fallback || type || 'Main sequence')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase())
  }
}

function getMusicVideoTimelineTrackName(coverage = {}, fallback = '') {
  return `MV - ${getMusicVideoTimelineCoverageLabel(coverage, fallback)}`
}

function hasMusicVideoCoverageSectionHeaders(script = '') {
  return /(?:^|\n)\s*(?:coverage|pass)\s+\d+\s*[:\-]/i.test(String(script || ''))
}

/**
 * Derive a sensible default label for a newly-created alt script slot.
 *
 * For alt_performance we fold in the user's variant descriptor so the tab
 * reads as "Alt: Volvo night" instead of generic "Alt Performance". For the
 * b-roll passes we number duplicates so "Env", "Env #2", "Env #3" can coexist
 * — useful when you want to experiment with different environmental angles.
 */
function deriveAltScriptLabel(passType, variantDescriptor, existingScripts) {
  const trimmedVariant = String(variantDescriptor || '').trim()

  if (passType === 'alt_performance') {
    if (trimmedVariant) {
      // Clip to a tab-friendly length, trimming on a word boundary when we can.
      const maxLen = 32
      let clipped = trimmedVariant.slice(0, maxLen)
      if (trimmedVariant.length > maxLen) {
        const lastSpace = clipped.lastIndexOf(' ')
        if (lastSpace > 12) clipped = clipped.slice(0, lastSpace)
        clipped = `${clipped.trim()}…`
      }
      return `Alt: ${clipped}`
    }
    return dedupeLabel('Alt Performance', existingScripts)
  }

  const base = passType === 'environmental_broll' ? 'Environmental' : 'Detail'
  return dedupeLabel(base, existingScripts)
}

function dedupeLabel(base, existingScripts) {
  const existing = Array.isArray(existingScripts) ? existingScripts : []
  const taken = new Set(existing.map((s) => String(s?.label || '').toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${base} #${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${base} #${Date.now()}`
}

function makeAltScriptId() {
  return `alt-script-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Supported music-video prompt "passes". A pass is a full script pointed at
 * the same song timeline but serving a different editorial purpose — think
 * of it like a second unit shoot. The master pass is the backbone; the alt
 * passes give you cutaway coverage that layers on top in the NLE.
 *
 *   - master:              performance-driven backbone script (the default)
 *   - alt_performance:     second performance of the song in a different
 *                          setting (car, rooftop, etc.) to intercut with
 *                          the master. Requires a variantDescriptor.
 *   - environmental_broll: no-performer b-roll of world/atmosphere, tiles
 *                          the master's timings for frame-accurate layering.
 *   - detail_broll:        macro/insert b-roll, subdivides longer master
 *                          beats into shorter textural shots.
 */
const MUSIC_VIDEO_PROMPT_PASSES = Object.freeze([
  'master',
  'alt_performance',
  'environmental_broll',
  'detail_broll',
])

function normalizeMusicVideoCoveragePlan(coveragePlan) {
  if (!coveragePlan || typeof coveragePlan !== 'object') return null
  const rawSections = Array.isArray(coveragePlan.sections) ? coveragePlan.sections : []
  const sections = rawSections
    .map((section, index) => {
      const type = String(section?.type || '').trim() || 'main_sequence'
      const label = String(section?.label || '').trim() || `Coverage ${index + 1}`
      const intent = String(section?.intent || '').trim()
      return { type, label, intent }
    })
    .filter((section) => section.label)
  if (sections.length <= 1) return null
  return {
    sections,
    performancePassCount: Math.max(0, Number(coveragePlan.performancePassCount) || 0),
    includeStoryBroll: Boolean(coveragePlan.includeStoryBroll),
    includeEnvironmentalBroll: Boolean(coveragePlan.includeEnvironmentalBroll),
    includeDetailBroll: Boolean(coveragePlan.includeDetailBroll),
  }
}

function buildMusicVideoCoveragePlanPrompt(coveragePlan) {
  const plan = normalizeMusicVideoCoveragePlan(coveragePlan)
  if (!plan) return ''
  const lines = [
    'Coverage plan:',
    'Return ONE combined script containing these coverage sections in this exact order. Do not return separate files.',
    'Each coverage section contains normal Shot blocks. Every shot still needs Start at, Shot type, Keyframe prompt, Motion prompt, Camera, and Length.',
    'Every non-performance-only coverage section must cover the full audio duration, not only the span containing lyrics. If the final lyric ends before the music ends, continue with outro/instrumental b-roll until the song ends.',
    'B-roll, environmental, and detail coverage must tile as adjacent video clips: each shot has a Start at, and its Length should end exactly at the next shot Start at. The final shot must end at the full audio duration.',
    'B-roll shot starts must NOT be constrained to lyric/SRT offsets. Use lyric timings only as emotional/story landmarks, then create continuous b-roll coverage between and beyond those lyric moments.',
    'Do not write one long take for any pass. Break every pass into 2-8 second clips aligned to the song timing.',
    'Use the exact Coverage type and Coverage label fields shown below so ComfyStudio can group the shots later.',
  ]
  plan.sections.forEach((section, index) => {
    lines.push(`  Coverage ${index + 1}: ${section.label}`)
    lines.push(`    Coverage type: ${section.type}`)
    lines.push(`    Coverage label: ${section.label}`)
    if (section.intent) lines.push(`    Purpose: ${section.intent}`)
    if (section.type === 'performance_pass') {
      lines.push('    Shot rule: use only performance or performance_wide shots for lyric/vocal moments. Keep Artist and Lyric moment fields on every shot. Use exact SRT lyric starts. It is OK and expected for this pass to have gaps during instrumental or non-vocal sections.')
    } else if (section.type === 'story_broll') {
      lines.push('    Shot rule: use b_roll shots for a coherent start-middle-end story across the full song timeline; include Artist only for visible non-singing cast narrative moments, and omit Artist for places, objects, or atmosphere.')
    } else if (section.type === 'environmental_broll') {
      lines.push('    Shot rule: use b_roll shots only across the full song timeline. Show places, atmosphere, empty rooms, exterior locations, weather, signage, vehicles, landscapes, and environmental texture. Do not include Artist, visible performers, or lip-sync.')
    } else if (section.type === 'detail_broll') {
      lines.push('    Shot rule: use b_roll shots only across the full song timeline; focus on short macro/detail inserts, textures, props, instruments, hands, and atmosphere. Do not include Artist unless the shot is explicitly a story_broll cast moment.')
    } else {
      lines.push('    Shot rule: this is the primary sequence and may mix performance, performance_wide, and b_roll based on the song.')
    }
  })
  return lines.join('\n')
}

/**
 * Build a single clipboard-ready prompt the user can paste into an LLM
 * (Claude, GPT, Gemini, etc.) to produce a timing-correct director script
 * for the music-video mode.
 *
 * The prompt bundles together:
 *   - Role + goal statement (pass-specific)
 *   - Song + target duration context
 *   - Cast roster (with slugs the LLM should use in Artist: fields)
 *   - Concept / style notes
 *   - Full lyrics and, if available, an SRT/LRC with real timings
 *   - Pass-specific rules (on top of the universal format rules)
 *   - (Alt passes only) the current master script as a timing/lyric anchor
 *   - A strict format spec the LLM must return verbatim
 *
 * We keep every section labeled so the LLM can see which parts of its
 * output need to quote verbatim (the SRT, the master timings) versus
 * synthesize fresh (the shots).
 */
function buildMusicVideoLLMPrompt(options = {}) {
  const {
    songName = '',
    songDurationSeconds = 0,
    targetDuration = 30,
    concept = '',
    styleNotes = '',
    lyrics = '',
    cast = [],
    pass = 'master',
    variantDescriptor = '',
    masterScript = '',
    coveragePlan = null,
  } = options

  const effectivePass = MUSIC_VIDEO_PROMPT_PASSES.includes(pass) ? pass : 'master'
  const effectiveCoveragePlan = effectivePass === 'master'
    ? normalizeMusicVideoCoveragePlan(coveragePlan)
    : null

  // Detect whether the single lyrics blob is plain text or timed (SRT/LRC).
  // This flips the section label so the LLM knows whether the timings are
  // authoritative (quote verbatim into `Start at:`) or need to be estimated
  // evenly across the song.
  const lyricsFormat = detectTimedLyricsFormat(lyrics)
  const lyricsIsTimed = lyricsFormat === 'srt' || lyricsFormat === 'lrc'

  const sections = []

  // Pass-specific intro — tells the LLM which editorial job this script is
  // serving so it doesn't just rehash the master performance.
  const roleIntro = buildMusicVideoPassIntro(effectivePass, variantDescriptor)
  sections.push(roleIntro)
  sections.push('Return ONLY the script in the exact format shown at the bottom. Do not include commentary, headers, or explanations outside the script.')

  const songMeta = []
  if (songName) songMeta.push(`Song: ${songName}`)
  if (songDurationSeconds > 0) songMeta.push(`Song length: ${formatSecondsAsMMSS(songDurationSeconds)} (${songDurationSeconds.toFixed(1)}s)`)
  songMeta.push(`Target music-video length: ~${targetDuration}s`)
  sections.push(songMeta.join('\n'))

  // B-roll-only passes don't need the cast roster — there are no performers
  // to reference. Keeping it out of the prompt avoids tempting the LLM to
  // slip in an Artist: line on a b_roll shot.
  const isBrollOnlyPass = effectivePass === 'environmental_broll' || effectivePass === 'detail_broll'
  if (!isBrollOnlyPass) {
    if (Array.isArray(cast) && cast.length > 0) {
      const castBlock = ['Cast — use these exact slugs in the Artist: field:']
      for (const c of cast) {
        const slug = c?.slug || ''
        const label = c?.label || slug || 'Artist'
        const role = c?.role ? ` (${c.role})` : ''
        castBlock.push(`  - ${slug}: ${label}${role}`)
      }
      castBlock.push('For duets, use "Artist: slug1, slug2". For the full cast, use "Artist: all".')
      sections.push(castBlock.join('\n'))
    } else {
      sections.push('Cast: (no cast defined — you may omit the Artist: field entirely, or use "Artist: artist" as a generic slot).')
    }
  }

  if (concept.trim()) {
    sections.push(`Concept / story:\n${concept.trim()}`)
  }
  if (styleNotes.trim()) {
    sections.push(`Style / look notes:\n${styleNotes.trim()}`)
  }

  if (lyricsIsTimed) {
    const formatLabel = lyricsFormat.toUpperCase()
    sections.push(`Lyrics (${formatLabel} — authoritative timings, quote these exact times for "Start at:"):\n${lyrics.trim()}`)
  } else if (lyrics.trim()) {
    sections.push(`Lyrics (plain text — no timings provided, estimate evenly across the song):\n${lyrics.trim()}`)
  } else {
    sections.push('Lyrics: (none provided — feel free to write an instrumental-style script; use "Shot type: b_roll" for every shot).')
  }

  // Universal format rules — these apply regardless of pass.
  const coveragePlanPrompt = effectiveCoveragePlan
    ? buildMusicVideoCoveragePlanPrompt(effectiveCoveragePlan)
    : ''
  if (coveragePlanPrompt) sections.push(coveragePlanPrompt)

  const fullTimelineDuration = Math.max(Number(songDurationSeconds) || 0, Number(targetDuration) || 0)
  const timelineRules = fullTimelineDuration > 0 ? [
    `  - The script timeline MUST cover the full audio duration through approximately ${formatSecondsAsMMSS(fullTimelineDuration)} (${fullTimelineDuration.toFixed(1)}s).`,
    '  - Lyrics/SRT lines are timing anchors for vocal moments only; the last lyric is NOT the end of the music video unless it also reaches the full audio duration.',
    '  - If the song continues after the final lyric, fill the outro/instrumental tail with b_roll or non-singing performance_wide shots. Omit Lyric moment during those sections.',
    '  - For b-roll/environment/detail coverage, treat each Start at as a clip boundary: Length must equal the time until the next shot starts, so clips butt together cleanly in the timeline with no manual moving.',
    '  - The final shot should end at, or slightly after, the full song duration. Do not stop the plan at the final lyric line.',
  ].join('\n') : ''
  if (timelineRules) sections.push(timelineRules)

  const rules = [
    'Rules:',
    '  0. The returned script must be self-contained. Put the story, setting, wardrobe, lighting, color, continuity, and camera language directly inside each shot block.',
    '  1. Every shot MUST include a "Start at:" field with a time like "0:15" or "15.5s". If you pasted SRT/LRC, use the exact start of the matching line.',
    '  2. Every shot MUST include "Length:" in seconds (between 2 and 8 — LTX 2.3 works best here).',
    '  3. Main sequence and b-roll/detail/environment sections MUST tile the full song/audio duration with no gaps, including intro, instrumental breaks, and any outro after the final lyric. Performance-only passes may leave gaps during instrumental or non-vocal sections.',
    '  3a. For b-roll/detail/environment sections, every shot Length MUST be calculated from the next shot boundary: current Length = next Start at - current Start at. For the final shot, Length = full song duration - final Start at. Avoid overlaps and avoid uncovered dark gaps.',
    '  4. "Shot type:" must be one of: performance, performance_wide, b_roll. Use performance/performance_wide when the singer\'s face is visible and lip-syncing; use b_roll for everything else.',
    '  4a. A b_roll shot may include Artist only as a visual/non-singing reference in story_broll or main_sequence coverage. If a band/performance cast member is singing or mouthing lyrics, the shot type MUST be performance or performance_wide, not b_roll.',
    '  4b. Environmental_broll and detail_broll shots MUST omit Artist. They should be places, props, textures, hands, silhouettes, or atmosphere, not assigned performer portraits.',
    '  5. For vocal lines, add "Lyric moment:" quoting the specific lyric line. For instrumentals or b_roll, omit Lyric moment.',
    '  6. Use "Artist:" to pick which cast member appears only when that person is visibly present. Omit when the shot is b_roll with no performer visible.',
    '  7. "Keyframe prompt:" describes the opening still and must include location, subject, wardrobe/props, lighting, color palette, composition, and the subject\'s readable emotional state when a person appears.',
    '  8. "Motion prompt:" describes what moves in the clip: lip-sync/performance action, character movement, camera movement, atmosphere, and any story action. Include camera motion and character blocking/emotion, not just a static description.',
    '  9. Keep wardrobe, location, and lighting consistent across adjacent shots unless the script deliberately calls for a hard cut.',
    '  10. Do NOT invent lyrics. If the song is instrumental at a given moment, omit Lyric moment for that shot.',
  ]
  sections.push(rules.join('\n'))

  // Pass-specific rules layer on top of the universal ones. For the master
  // pass this is a no-op; for alt passes it's where we constrain shot types,
  // inherit timings, and forbid copying the master's imagery.
  const passRules = buildMusicVideoPassRules(effectivePass, variantDescriptor)
  if (passRules) sections.push(passRules)

  // For alt passes, feed the current master script in so the LLM can anchor
  // timings + lyric moments without us having to re-emit the SRT separately.
  if (effectivePass !== 'master' && masterScript.trim()) {
    sections.push(`Master performance script (for timing and lyric reference ONLY — do NOT copy shots or imagery):\n${masterScript.trim()}`)
  }

  sections.push(buildMusicVideoPassFormatSpec(effectivePass, effectiveCoveragePlan))

  return sections.join('\n\n')
}

function buildMusicVideoPassIntro(pass, variantDescriptor) {
  switch (pass) {
    case 'alt_performance': {
      const variant = String(variantDescriptor || '').trim()
      const variantLine = variant
        ? `Alt performance variant: ${variant}`
        : 'Alt performance variant: (unspecified — pick a distinct setting/wardrobe/lighting from the master that will cut against it cleanly)'
      return [
        'You are a music video director. I need you to write an ALT PERFORMANCE PASS for the song below.',
        'This is a SECOND lip-sync performance coverage pass for the vocal sections of the song, designed to intercut with the master performance pass (included at the bottom). Think of it as a separate second-unit shoot — different setting, different camera grammar — but same cast lip-syncing the same lyrics.',
        variantLine,
      ].join('\n')
    }
    case 'environmental_broll':
      return [
        'You are a music video director. I need you to write an ENVIRONMENTAL B-ROLL PASS for the song below.',
        'This pass is coverage of PLACES and ATMOSPHERE with NO performers in frame. It will layer alongside the master performance pass (included at the bottom) so the editor can cut to the world whenever the song needs breathing room.',
      ].join('\n')
    case 'detail_broll':
      return [
        'You are a music video director. I need you to write a DETAIL / INSERT B-ROLL PASS for the song below.',
        'This pass is TIGHT, MACRO, TEXTURAL inserts — gear, objects, hands, small story details. It will layer alongside the master performance pass (included at the bottom) so the editor can punch in rhythm and hide cuts.',
      ].join('\n')
    case 'master':
    default:
      return 'You are a music video director. I need you to write a shot-by-shot director script for the song below.'
  }
}

function buildMusicVideoPassRules(pass, variantDescriptor) {
  switch (pass) {
    case 'alt_performance': {
      const variant = String(variantDescriptor || '').trim()
      const variantLine = variant
        ? `  - Every shot MUST be filmed in this variant setting: "${variant}". Do NOT reuse the master script's location, wardrobe, or lighting.`
        : '  - Pick ONE distinct setting/wardrobe/lighting different from the master and use it for every shot in this pass.'
      return [
        'Alt Performance Pass rules (on top of the universal rules above):',
        variantLine,
        '  - Shot type MUST be performance or performance_wide. Do NOT generate any b_roll shots in this pass.',
        '  - Keep Artist: and Lyric moment: fields on every shot — this is still a lip-sync pass.',
        '  - Start at: should follow the vocal/lyric timings. Generate your own shot rhythm appropriate to the variant setting. It is OK for this pass to have gaps during instrumental or non-vocal sections.',
        '  - Do NOT repeat the master script\'s Keyframe prompt or Motion prompt text. Invent fresh imagery that belongs to the variant setting.',
      ].join('\n')
    }
    case 'environmental_broll':
      return [
        'Environmental B-roll Pass rules (on top of the universal rules above):',
        '  - Every shot MUST use Shot type: b_roll.',
        '  - Do NOT include Artist: or Lyric moment: fields on any shot — omit them entirely.',
        '  - Do NOT show any performer\'s face or body in frame. The cast is absent from this pass.',
        '  - Build a clear environmental story with start, middle, and end. Reuse the same locations, symbols, and public pressure as the main/story b-roll idea instead of inventing unrelated places.',
        '  - Every environmental shot should reveal a story consequence: buildup, escalation, threat, aftermath, escape route, public reaction, or final quiet.',
        '  - Do NOT reuse only the master performance shot timings. Create a continuous b-roll shot grid from 0:00 to the full song end, filling every instrumental, intro, outro, and non-vocal gap.',
        '  - Each environmental shot must run until the next environmental shot starts. Calculate Length from the next Start at; the last shot runs until the full song end. This pass should drop into the timeline without moving clips.',
        '  - Use the master script and SRT only as landmarks for where the emotional/story energy changes. B-roll Start at values may fall between lyric offsets and should not require Lyric moment.',
        '  - Favor medium-to-wide framings. Shot lengths should skew 4–7s. Let shots breathe.',
        '  - INVENT NEW IMAGERY. Do NOT copy the master script\'s Keyframe prompt or Motion prompt text.',
      ].join('\n')
    case 'detail_broll':
      return [
        'Detail B-roll Pass rules (on top of the universal rules above):',
        '  - Every shot MUST use Shot type: b_roll.',
        '  - Do NOT include Artist: or Lyric moment: fields on any shot — omit them entirely.',
        '  - You MAY show hands, fingers, feet, backs of heads, silhouettes, or isolated body parts — but NEVER a recognizable face and NEVER a visible lip-sync.',
        '  - Build a clear detail story with start, middle, and end using recurring symbols/props/materials from the same b-roll narrative. Details should feel like evidence from the larger story, not random inserts.',
        '  - Every detail shot should reveal a story clue, emotional pressure point, transformation, damage, warning, decision, or aftermath.',
        '  - You do NOT need to match the master script\'s shot boundaries or lyric offsets. It is ENCOURAGED to subdivide the full song timeline into multiple shorter detail shots.',
        '  - Each detail shot must run until the next detail shot starts. Calculate Length from the next Start at; the last shot runs until the full song end. This pass should drop into the timeline without moving clips.',
        '  - Shot lengths should skew SHORTER: 2–4s is ideal, occasionally up to 5s.',
        '  - Still cover the full song with no gaps at all.',
        '  - INVENT NEW IMAGERY. Do NOT copy the master script\'s Keyframe prompt or Motion prompt text.',
      ].join('\n')
    case 'master':
    default:
      return ''
  }
}

function buildMusicVideoPassFormatSpec(pass, coveragePlan = null) {
  const isBrollOnly = pass === 'environmental_broll' || pass === 'detail_broll'
  const plan = normalizeMusicVideoCoveragePlan(coveragePlan)
  const coverageHeader = plan ? [
    'Coverage 1: Main scripted sequence',
    'Coverage type: main_sequence',
    'Coverage label: Main scripted sequence',
    '',
  ] : []
  if (isBrollOnly) {
    const label = pass === 'environmental_broll' ? 'Environmental establishing' : 'Detail insert'
    const keyframeA = pass === 'environmental_broll'
      ? 'Rain-slick alley at night, sodium streetlamp haloing the wet pavement, no people in frame, deep atmospheric haze.'
      : 'Macro insert on fingers pressing a fret, amber stage glow catching the string, shallow depth, heavy grain.'
    const motionA = pass === 'environmental_broll'
      ? 'Slow drift along the alley, puddles rippling, neon reflection shimmering on the ground.'
      : 'Fingers shift to the next fret, string vibrates, micro camera drift.'
    const keyframeB = pass === 'environmental_broll'
      ? 'Empty highway under overcast sky, pine forest on both shoulders, a single reflector post catching the light.'
      : 'Macro on a cassette tape spinning inside a car deck, dash backlight glowing green across the label.'
    const motionB = pass === 'environmental_broll'
      ? 'Locked-off static, wind pushes a ripple through a puddle in the foreground.'
      : 'Reels turn, dust drifts through the backlight, tape tension flickers.'
    return [
      'Required output format (verbatim — one block per shot):',
      '',
      ...coverageHeader,
      'Scene 1: Opening',
      '',
      `Shot 1: ${label}`,
      'Start at: 0:00',
      'Shot type: b_roll',
      `Keyframe prompt: ${keyframeA}`,
      `Motion prompt: ${motionA}`,
      'Camera: Slow drift, 35mm lens.',
      'Length: 4.5',
      '',
      'Shot 2: Cutaway',
      'Start at: 0:04.5',
      'Shot type: b_roll',
      `Keyframe prompt: ${keyframeB}`,
      `Motion prompt: ${motionB}`,
      'Camera: Locked-off, 85mm macro.',
      'Length: 3.2',
      '',
      '(...continue until the song is covered.)',
    ].join('\n')
  }

  return [
    'Required output format (verbatim — one block per shot):',
    '',
    ...coverageHeader,
    'Scene 1: Opening',
    '',
    'Shot 1: Wide establishing',
    'Start at: 0:00',
    'Lyric moment: "You paint your eyelids with correction fluid moons"',
    'Shot type: performance_wide',
    'Artist: rose',
    'Keyframe prompt: Singer leans against a neon-lit phone booth, rain-slick street behind her, warm sodium-lamp glow.',
    'Motion prompt: Slow push-in on the singer as she mouths the opening line, rain falling around her, headlights flaring in the distance.',
    'Camera: Slow dolly forward, eye level, 35mm lens.',
    'Length: 4.5',
    '',
    'Shot 2: Close-up',
    'Start at: 0:04.5',
    'Lyric moment: "Chewed up saints on the floor"',
    'Shot type: performance',
    'Artist: rose',
    'Keyframe prompt: Tight close-up on the singer\'s eyes, mascara starting to run.',
    'Motion prompt: Hold on her face as she sings, slight tilt down to catch a tear.',
    'Camera: Handheld, 85mm, shallow depth of field.',
    'Length: 3.2',
    '',
    '(...continue until the song is covered.)',
  ].join('\n')
}

// ============================================
// CinematographyTags Sub-component
// ============================================
function CinematographyTags({ onAddTag, selectedTags, onRemoveTag }) {
  const [activeCategory, setActiveCategory] = useState('Shot')
  const tabsRef = useRef(null)
  const scrollTabs = (dir) => tabsRef.current?.scrollBy({ left: dir * 100, behavior: 'smooth' })

  return (
    <div className="space-y-2">
      <div className="relative flex items-center">
        <button onClick={() => scrollTabs(-1)} className="absolute left-0 z-10 p-0.5 bg-sf-dark-900/90 hover:bg-sf-dark-700 rounded text-sf-text-muted"><ChevronLeft className="w-3 h-3" /></button>
        <div ref={tabsRef} className="flex gap-1 overflow-x-auto mx-5 pb-1" style={{ scrollbarWidth: 'none' }}>
          {CATEGORY_ORDER.map(cat => (
            <button key={cat} onClick={() => setActiveCategory(cat)}
              className={`px-2 py-1 rounded text-[10px] font-medium whitespace-nowrap transition-colors ${activeCategory === cat ? 'bg-sf-accent text-white' : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'}`}
            >{cat}</button>
          ))}
        </div>
        <button onClick={() => scrollTabs(1)} className="absolute right-0 z-10 p-0.5 bg-sf-dark-900/90 hover:bg-sf-dark-700 rounded text-sf-text-muted"><ChevronRight className="w-3 h-3" /></button>
      </div>
      <div className="bg-sf-dark-800/50 rounded-lg p-2">
        <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
          {SHOT_CATEGORIES[activeCategory].map(tag => {
            const sel = selectedTags.includes(tag)
            return (
              <button key={tag} onClick={() => sel ? onRemoveTag(tag) : onAddTag(tag)}
                className={`px-2 py-0.5 rounded text-[10px] transition-colors ${sel ? 'bg-sf-accent text-white' : 'bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-secondary'}`}
              >{sel ? '+ ' : ''}{tag}</button>
            )
          })}
        </div>
      </div>
      {selectedTags.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {selectedTags.map(tag => (
            <span key={tag} onClick={() => onRemoveTag(tag)} className="px-1.5 py-0.5 bg-sf-accent/20 text-sf-accent rounded text-[9px] cursor-pointer hover:bg-sf-accent/30">{tag} x</span>
          ))}
          <button onClick={() => selectedTags.forEach(onRemoveTag)} className="text-[9px] text-sf-text-muted hover:text-sf-error ml-1">Clear</button>
        </div>
      )}
    </div>
  )
}

// ============================================
// Asset Input Browser (left column)
// ============================================
function AssetInputBrowser({
  selectedAsset,
  onSelectAsset,
  filterType,
  frameTime,
  onFrameTimeChange,
  assetSlots = [],
  activeSlotId = 'asset',
  onActiveSlotChange = null,
  selectedAssetFields = {},
  onSelectAssetField = null,
}) {
  const { assets, folders } = useAssetsStore()
  const [search, setSearch] = useState('')
  const [currentFolderId, setCurrentFolderId] = useState(null)
  const videoRef = useRef(null)
  const canvasRef = useRef(null)

  const normalizedSearch = search.trim().toLowerCase()
  const activeSlot = assetSlots.find((slot) => slot.id === activeSlotId) || assetSlots[0] || {
    id: 'asset',
    label: 'Input asset',
    assetType: filterType,
    isPrimary: true,
  }
  const selectedAssetForActiveSlot = activeSlot.isPrimary
    ? selectedAsset
    : (selectedAssetFields?.[activeSlot.id] || null)

  const handleSelectAssetForActiveSlot = useCallback((asset) => {
    if (activeSlot.isPrimary || activeSlot.id === 'asset') {
      onSelectAsset(asset)
      return
    }
    onSelectAssetField?.(activeSlot.id, asset)
  }, [activeSlot.id, activeSlot.isPrimary, onSelectAsset, onSelectAssetField])

  const isCompatibleAsset = useCallback((asset) => {
    if (!asset || asset.type === 'mask') return false
    if (activeSlot && !activeSlot.isPrimary && activeSlot.assetType) return asset.type === activeSlot.assetType
    if (filterType === 'image') return asset.type === 'image' || asset.type === 'video'
    if (filterType === 'video') return asset.type === 'video'
    if (filterType === 'audio') return asset.type === 'audio'
    return true
  }, [activeSlot, filterType])

  const compatibleAssets = useMemo(
    () => assets.filter(isCompatibleAsset),
    [assets, isCompatibleAsset]
  )

  const folderById = useMemo(() => {
    const map = new Map()
    ;(folders || []).forEach((folder) => {
      if (folder?.id) map.set(folder.id, folder)
    })
    return map
  }, [folders])

  const foldersByParent = useMemo(() => {
    const map = new Map()
    ;(folders || []).forEach((folder) => {
      const parentId = folder?.parentId || null
      const next = map.get(parentId) || []
      next.push(folder)
      map.set(parentId, next)
    })
    for (const list of map.values()) {
      list.sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')))
    }
    return map
  }, [folders])

  const getFolderPath = useCallback((folderId = currentFolderId) => {
    const path = []
    let cursor = folderId
    const visited = new Set()
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor)
      const folder = folderById.get(cursor)
      if (!folder) break
      path.unshift(folder)
      cursor = folder.parentId || null
    }
    return path
  }, [currentFolderId, folderById])

  const getDescendantFolderIds = useCallback((folderId) => {
    const ids = []
    const walk = (parentId) => {
      const children = foldersByParent.get(parentId) || []
      for (const child of children) {
        if (!child?.id) continue
        ids.push(child.id)
        walk(child.id)
      }
    }
    walk(folderId || null)
    return ids
  }, [foldersByParent])

  const getFolderAssetCount = useCallback((folderId) => {
    const folderIds = new Set([folderId || null, ...getDescendantFolderIds(folderId)])
    return compatibleAssets.filter((asset) => folderIds.has(asset.folderId || null)).length
  }, [compatibleAssets, getDescendantFolderIds])

  useEffect(() => {
    if (currentFolderId && !folderById.has(currentFolderId)) {
      setCurrentFolderId(null)
    }
  }, [currentFolderId, folderById])

  const currentSubfolders = useMemo(
    () => normalizedSearch ? [] : (foldersByParent.get(currentFolderId || null) || []),
    [currentFolderId, foldersByParent, normalizedSearch]
  )

  const visibleAssets = useMemo(() => {
    if (normalizedSearch) {
      return compatibleAssets.filter((asset) => {
        const nameMatches = String(asset.name || '').toLowerCase().includes(normalizedSearch)
        const pathMatches = getFolderPath(asset.folderId || null)
          .some((folder) => String(folder.name || '').toLowerCase().includes(normalizedSearch))
        return nameMatches || pathMatches
      })
    }
    return compatibleAssets.filter((asset) => (asset.folderId || null) === (currentFolderId || null))
  }, [compatibleAssets, currentFolderId, getFolderPath, normalizedSearch])

  const assetTypeLabel = filterType === 'image'
    ? 'image/video'
    : filterType || 'media'

  // When video loads, seek to frameTime
  useEffect(() => {
    if (videoRef.current && selectedAssetForActiveSlot?.type === 'video') {
      videoRef.current.currentTime = frameTime || 0
    }
  }, [frameTime, selectedAssetForActiveSlot])

  const handleVideoSeeked = () => {
    // Draw current frame to canvas for preview
    if (videoRef.current && canvasRef.current) {
      const v = videoRef.current
      const c = canvasRef.current
      c.width = v.videoWidth
      c.height = v.videoHeight
      c.getContext('2d').drawImage(v, 0, 0)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 p-2 border-b border-sf-dark-700">
        <div className="text-[10px] text-sf-text-muted uppercase tracking-wider mb-2">Input Source</div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-sf-text-muted" />
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search assets..."
            className="w-full pl-7 pr-2 py-1 bg-sf-dark-800 border border-sf-dark-600 rounded text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
          />
        </div>
        <div className="mt-2 flex items-center gap-1 overflow-x-auto text-[10px]">
          <button
            type="button"
            onClick={() => setCurrentFolderId(null)}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors ${
              !currentFolderId && !normalizedSearch ? 'bg-sf-accent/15 text-sf-accent' : 'text-sf-text-muted hover:bg-sf-dark-700 hover:text-sf-text-primary'
            }`}
          >
            <FolderOpen className="h-3 w-3" />
            Assets
          </button>
          {getFolderPath().map((folder) => (
            <div key={folder.id} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3 flex-shrink-0 text-sf-text-muted" />
              <button
                type="button"
                onClick={() => setCurrentFolderId(folder.id)}
                className={`max-w-[120px] truncate rounded px-1.5 py-0.5 transition-colors ${
                  folder.id === currentFolderId && !normalizedSearch ? 'bg-sf-accent/15 text-sf-accent' : 'text-sf-text-muted hover:bg-sf-dark-700 hover:text-sf-text-primary'
                }`}
              >
                {folder.name}
              </button>
            </div>
          ))}
        </div>
        {normalizedSearch && (
          <div className="mt-1 text-[9px] text-sf-text-muted">
            Searching all folders
          </div>
        )}
        {assetSlots.length > 0 && (
          <div className="mt-2 space-y-1">
            <div className="text-[9px] uppercase tracking-wider text-sf-text-muted">
              Assign selected asset to
            </div>
            <div className="grid grid-cols-1 gap-1">
              {assetSlots.map((slot) => {
                const slotAsset = slot.isPrimary ? selectedAsset : selectedAssetFields?.[slot.id]
                const isActive = activeSlot.id === slot.id
                return (
                  <button
                    key={slot.id}
                    type="button"
                    onClick={() => onActiveSlotChange?.(slot.id)}
                    className={`rounded border px-2 py-1 text-left transition-colors ${
                      isActive
                        ? 'border-sf-accent bg-sf-accent/15 text-sf-accent'
                        : 'border-sf-dark-700 bg-sf-dark-800/70 text-sf-text-muted hover:border-sf-dark-500 hover:text-sf-text-primary'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[10px] font-medium">{slot.label}</span>
                      <span className="shrink-0 text-[8px] uppercase opacity-70">{slot.assetType || 'media'}</span>
                    </div>
                    <div className={`mt-0.5 truncate text-[9px] ${slotAsset ? 'text-sf-text-secondary' : 'text-sf-text-muted'}`}>
                      {slotAsset?.name || 'Nothing selected'}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Selected asset preview + frame grabber */}
      {selectedAssetForActiveSlot && (
        <div className="flex-shrink-0 border-b border-sf-dark-700 p-2">
          <div className="text-[10px] text-sf-text-muted mb-1">
            {activeSlot.label}: <span className="text-sf-text-primary">{selectedAssetForActiveSlot.name}</span>
          </div>
          {activeSlot.isPrimary && selectedAssetForActiveSlot.type === 'video' && filterType === 'image' ? (
            (() => {
              const durationSec = selectedAssetForActiveSlot.duration ?? selectedAssetForActiveSlot.settings?.duration ?? 5
              const fps = selectedAssetForActiveSlot.fps ?? selectedAssetForActiveSlot.settings?.fps ?? 24
              const totalFrames = Math.max(0, Math.floor(durationSec * fps))
              const currentFrame = Math.min(totalFrames, Math.round((frameTime || 0) * fps))
              return (
                <div className="space-y-2">
                  <div className="relative aspect-video bg-sf-dark-800 rounded overflow-hidden">
                    <video
                      ref={videoRef}
                      src={selectedAssetForActiveSlot.url}
                      className="w-full h-full object-contain"
                      muted
                      onSeeked={handleVideoSeeked}
                      onLoadedMetadata={() => { if (videoRef.current) videoRef.current.currentTime = frameTime || 0 }}
                    />
                    <canvas ref={canvasRef} className="hidden" />
                    <div className="absolute bottom-1 right-1 px-1.5 py-0.5 bg-black/70 rounded text-[9px] text-white">
                      Frame {currentFrame}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] text-sf-text-muted w-6">0</span>
                    <input
                      type="range" min="0" max={durationSec} step={1 / Math.max(1, fps)}
                      value={frameTime || 0} onChange={e => onFrameTimeChange(parseFloat(e.target.value))}
                      className="flex-1 h-1 accent-sf-accent"
                    />
                    <span className="text-[9px] text-sf-text-muted w-8 text-right">{totalFrames}</span>
                  </div>
                  <div className="text-[9px] text-sf-text-muted">Drag slider to pick a frame from this video</div>
                </div>
              )
            })()
          ) : (
            <div className="aspect-video bg-sf-dark-800 rounded overflow-hidden">
              {selectedAssetForActiveSlot.type === 'video' ? (
                <video src={selectedAssetForActiveSlot.url} className="w-full h-full object-contain" muted />
              ) : selectedAssetForActiveSlot.type === 'image' ? (
                <img src={selectedAssetForActiveSlot.url} className="w-full h-full object-contain" alt={selectedAssetForActiveSlot.name} />
              ) : (
                <div className="w-full h-full flex items-center justify-center"><Music className="w-8 h-8 text-sf-text-muted" /></div>
              )}
            </div>
          )}
          <button onClick={() => handleSelectAssetForActiveSlot(null)} className="mt-1 text-[9px] text-sf-text-muted hover:text-sf-error">Clear selection</button>
        </div>
      )}

      {/* Folder-aware asset grid */}
      <div className="flex-1 overflow-auto p-2">
        {currentFolderId && !normalizedSearch && (
          <button
            type="button"
            onClick={() => setCurrentFolderId(folderById.get(currentFolderId)?.parentId || null)}
            className="mb-2 flex w-full items-center gap-2 rounded border border-sf-dark-700 bg-sf-dark-800/70 px-2 py-1.5 text-left text-[10px] text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Up one folder
          </button>
        )}

        {currentSubfolders.length > 0 && (
          <div className="mb-3 space-y-1">
            {currentSubfolders.map((folder) => {
              const count = getFolderAssetCount(folder.id)
              return (
                <button
                  key={folder.id}
                  type="button"
                  onClick={() => setCurrentFolderId(folder.id)}
                  className="flex w-full items-center gap-2 rounded border border-sf-dark-700 bg-sf-dark-800/70 px-2 py-1.5 text-left transition-colors hover:border-sf-dark-500 hover:bg-sf-dark-800"
                >
                  <FolderOpen className="h-4 w-4 flex-shrink-0 text-sf-accent" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium text-sf-text-primary">{folder.name}</div>
                    <div className="text-[9px] text-sf-text-muted">
                      {count} matching {count === 1 ? 'asset' : 'assets'}
                    </div>
                  </div>
                  <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-sf-text-muted" />
                </button>
              )
            })}
          </div>
        )}

        {visibleAssets.length === 0 && currentSubfolders.length === 0 ? (
          <div className="text-center py-8 text-sf-text-muted">
            <FolderOpen className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-xs">
              {normalizedSearch ? 'No matching assets' : `No ${assetTypeLabel} assets here`}
            </p>
            <p className="text-[10px]">
              {normalizedSearch ? 'Try a different search or folder name' : 'Open another folder or import media in the Assets tab'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {visibleAssets.map(asset => {
              const isSelected = selectedAssetForActiveSlot?.id === asset.id
              const folderPath = getFolderPath(asset.folderId || null)
              return (
                <button key={asset.id} onClick={() => handleSelectAssetForActiveSlot(asset)}
                  className={`bg-sf-dark-800 border rounded overflow-hidden text-left transition-all ${isSelected ? 'border-sf-accent ring-1 ring-sf-accent' : 'border-sf-dark-600 hover:border-sf-dark-500'}`}
                >
                  <div className="aspect-video bg-sf-dark-700 flex items-center justify-center relative overflow-hidden">
                    {asset.type === 'video' && asset.url ? (
                      <video src={asset.url} className="w-full h-full object-cover" muted preload="metadata" />
                    ) : asset.type === 'image' && asset.url ? (
                      <img src={asset.url} className="w-full h-full object-cover" alt="" />
                    ) : (
                      <Music className="w-4 h-4 text-sf-text-muted" />
                    )}
                    <div className={`absolute top-0.5 left-0.5 px-1 py-0.5 rounded text-[7px] text-white ${asset.type === 'video' ? 'bg-blue-600/80' : asset.type === 'image' ? 'bg-green-600/80' : 'bg-purple-600/80'}`}>
                      {asset.type === 'video' ? 'VID' : asset.type === 'image' ? 'IMG' : 'AUD'}
                    </div>
                  </div>
                  <div className="px-1 py-0.5">
                    <p className="text-[9px] text-sf-text-primary truncate">{asset.name}</p>
                    {normalizedSearch && folderPath.length > 0 && (
                      <p className="text-[8px] text-sf-text-muted truncate">
                        {folderPath.map((folder) => folder.name).join(' / ')}
                      </p>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================
// Helper: Extract frame from video as File
// ============================================
async function extractFrameAsFile(videoUrl, time, filename = 'frame.png') {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.muted = true
    video.preload = 'auto'
    video.src = videoUrl

    video.onloadedmetadata = () => {
      video.currentTime = Math.min(time, video.duration - 0.01)
    }

    video.onseeked = () => {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.getContext('2d').drawImage(video, 0, 0)
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(new File([blob], filename, { type: 'image/png' }))
        } else {
          reject(new Error('Failed to extract frame'))
        }
      }, 'image/png')
    }

    video.onerror = () => reject(new Error('Failed to load video for frame extraction'))
  })
}

// ============================================
// Main GenerateWorkspace Component
// ============================================
function GenerateWorkspace({ onOpenWorkflowSetup = null }) {
  // Load persisted state from localStorage
  const loadPersistedState = () => {
    try {
      const saved = localStorage.getItem('generate-workspace-state')
      if (saved) {
        const parsed = JSON.parse(saved)
        // Migrate legacy workflow id after Nano Banana 2 replacement.
        if (parsed?.workflowId === 'nano-banana-pro') {
          parsed.workflowId = 'nano-banana-2'
        }
        // Migrate removed LTX2 workflows/targets to WAN 2.2.
        if (parsed?.workflowId === 'ltx2-t2v' || parsed?.workflowId === 'ltx2-i2v') {
          parsed.workflowId = 'wan22-i2v'
        }
        if (parsed?.yoloVideoWorkflowTarget === 'ltx2-i2v' || parsed?.yoloVideoWorkflowTarget === 'both') {
          parsed.yoloVideoWorkflowTarget = 'wan22-i2v'
        }
        return parsed
      }
    } catch (error) {
      console.error('Failed to load persisted Generate workspace state:', error)
    }
    return null
  }

  const persistedState = loadPersistedState()

  // UI mode
  const [generationMode, setGenerationMode] = useState(persistedState?.generationMode || 'single')

  // Category + workflow selection
  const [category, setCategory] = useState(persistedState?.category || 'video')
  const [workflowId, setWorkflowId] = useState(persistedState?.workflowId || 'wan22-i2v')
  const [selectedWorkflowManifestId, setSelectedWorkflowManifestId] = useState(persistedState?.selectedWorkflowManifestId || persistedState?.workflowId || 'wan22-i2v')
  const [workflowRoute, setWorkflowRoute] = useState(() => (
    getWorkflowManifestByWorkflowId(persistedState?.workflowId || 'wan22-i2v')?.route || 'local'
  ))
  const [workflowDetailOpen, setWorkflowDetailOpen] = useState(false)
  const [latestWorkflowPreview, setLatestWorkflowPreview] = useState(null)

  // Input asset (store ID, will resolve to object)
  const [selectedAssetId, setSelectedAssetId] = useState(persistedState?.selectedAssetId || null)
  const [selectedAsset, setSelectedAsset] = useState(null)
  const [selectedAudioAssetId, setSelectedAudioAssetId] = useState(persistedState?.selectedAudioAssetId || null)
  const [selectedAudioAsset, setSelectedAudioAsset] = useState(null)
  const [selectedAssetFieldIds, setSelectedAssetFieldIds] = useState(
    persistedState?.selectedAssetFieldIds && typeof persistedState.selectedAssetFieldIds === 'object'
      ? persistedState.selectedAssetFieldIds
      : {}
  )
  const [selectedAssetFields, setSelectedAssetFields] = useState({})
  const [activeAssetSlotId, setActiveAssetSlotId] = useState(persistedState?.activeAssetSlotId || 'asset')
  const [frameTime, setFrameTime] = useState(persistedState?.frameTime || 0)

  // Common generation state
  const [prompt, setPrompt] = useState(persistedState?.prompt || '')
  const [negativePrompt, setNegativePrompt] = useState(persistedState?.negativePrompt || 'blurry, low quality, watermark')
  const [seed, setSeed] = useState(persistedState?.seed || Math.floor(Math.random() * 1000000))
  const [selectedTags, setSelectedTags] = useState(persistedState?.selectedTags || [])

  // Video settings
  const [duration, setDuration] = useState(persistedState?.duration || 5)
  const [resolution, setResolution] = useState(persistedState?.resolution || { width: 1280, height: 720 })
  const [imageResolution, setImageResolution] = useState(persistedState?.imageResolution || { width: 1280, height: 720 })
  const [fps, setFps] = useState(persistedState?.fps || 24)
  const [interpolationMultiplier, setInterpolationMultiplier] = useState(persistedState?.interpolationMultiplier || 4)
  const [enableFpsMultiplier, setEnableFpsMultiplier] = useState(persistedState?.enableFpsMultiplier || false)
  const [wanQualityPreset, setWanQualityPreset] = useState(persistedState?.wanQualityPreset || 'face-lock')

  // Image edit settings
  const [editSteps, setEditSteps] = useState(persistedState?.editSteps || 40)
  const [editCfg, setEditCfg] = useState(persistedState?.editCfg || 4)
  const [referenceAssetId1, setReferenceAssetId1] = useState(persistedState?.referenceAssetId1 ?? null)
  const [referenceAssetId2, setReferenceAssetId2] = useState(persistedState?.referenceAssetId2 ?? null)
  const [annotationModalOpen, setAnnotationModalOpen] = useState(false)
  const [annotationInitialUrl, setAnnotationInitialUrl] = useState(null)
  const [annotationPreparing, setAnnotationPreparing] = useState(false)
  const annotationBlobUrlRef = useRef(null)

  // Music settings
  const [musicTags, setMusicTags] = useState(persistedState?.musicTags || '')
  const [lyrics, setLyrics] = useState(persistedState?.lyrics || '')
  const [musicDuration, setMusicDuration] = useState(persistedState?.musicDuration || 30)
  const [bpm, setBpm] = useState(persistedState?.bpm || 120)
  const [keyscale, setKeyscale] = useState(persistedState?.keyscale || 'C major')

  // Director mode state
  const [yoloCreationType, setYoloCreationType] = useState(persistedState?.yoloCreationType || 'ad')
  const [directorSubTab, setDirectorSubTab] = useState('setup')
  const [yoloScript, setYoloScript] = useState(persistedState?.yoloScript || '')
  const [directorFormatExpanded, setDirectorFormatExpanded] = useState(false)
  // Expanded state for the alt-pass shot breakdown list. Toggled per-user;
  // not persisted (these panels should collapse between sessions to keep the
  // textarea as the primary focus).
  const [altPassBreakdownExpanded, setAltPassBreakdownExpanded] = useState(false)
  const [yoloStyleNotes, setYoloStyleNotes] = useState('')
  const [yoloAdProductAssetId, setYoloAdProductAssetId] = useState(persistedState?.yoloAdProductAssetId ?? null)
  const [yoloAdModelAssetId, setYoloAdModelAssetId] = useState(persistedState?.yoloAdModelAssetId ?? null)
  const [yoloAdVoiceoverAssetId, setYoloAdVoiceoverAssetId] = useState(persistedState?.yoloAdVoiceoverAssetId ?? null)
  const [yoloAdProductName, setYoloAdProductName] = useState(persistedState?.yoloAdProductName || '')
  const [yoloAdBrandName, setYoloAdBrandName] = useState(persistedState?.yoloAdBrandName || '')
  const [yoloAdColorPalette, setYoloAdColorPalette] = useState(persistedState?.yoloAdColorPalette || '')
  const [yoloAdLogoConstraints, setYoloAdLogoConstraints] = useState(persistedState?.yoloAdLogoConstraints || '')
  const [yoloAdSpokespersonRole, setYoloAdSpokespersonRole] = useState(persistedState?.yoloAdSpokespersonRole || '')
  const [yoloAdWardrobeNotes, setYoloAdWardrobeNotes] = useState(persistedState?.yoloAdWardrobeNotes || '')
  const [yoloAdFormatPreset, setYoloAdFormatPreset] = useState(persistedState?.yoloAdFormatPreset || YOLO_AD_FORMAT_PRESETS[0]?.id || 'product_demo')
  const [yoloAdPlatformPreset, setYoloAdPlatformPreset] = useState(persistedState?.yoloAdPlatformPreset || YOLO_AD_PLATFORM_PRESETS[0]?.id || 'landscape_16x9')
  const [yoloAdLocalVideoWorkflowId, setYoloAdLocalVideoWorkflowId] = useState(() => {
    const saved = String(persistedState?.yoloAdLocalVideoWorkflowId || '').trim()
    return YOLO_AD_LOCAL_VIDEO_WORKFLOW_OPTIONS.some((option) => option.id === saved)
      ? saved
      : 'ltx23-i2v'
  })
  const [yoloAdConsistency, setYoloAdConsistency] = useState(persistedState?.yoloAdConsistency || 'medium')
  const [yoloTargetDuration, setYoloTargetDuration] = useState(persistedState?.yoloTargetDuration || 30)
  const [yoloShotsPerScene, setYoloShotsPerScene] = useState(persistedState?.yoloShotsPerScene || 3)
  const [yoloAnglesPerShot, setYoloAnglesPerShot] = useState(persistedState?.yoloAnglesPerShot || 2)
  const [yoloTakesPerAngle, setYoloTakesPerAngle] = useState(persistedState?.yoloTakesPerAngle || 1)
  const [yoloPlanSignature, setYoloPlanSignature] = useState(persistedState?.yoloPlanSignature || '')
  const [yoloVideoFps, setYoloVideoFps] = useState(() => {
    const parsed = Number(persistedState?.yoloVideoFps)
    return DIRECTOR_VIDEO_FPS_OPTIONS.includes(parsed) ? parsed : 24
  })
  const [yoloAdStoryboardSource, setYoloAdStoryboardSource] = useState(() => {
    const saved = String(persistedState?.yoloAdStoryboardSource || '').trim().toLowerCase()
    if (saved === 'local' || saved === 'cloud') return saved
    const legacyOverride = String(persistedState?.yoloAdStoryboardRuntimeOverride || '').trim().toLowerCase()
    if (legacyOverride === 'local' || legacyOverride === 'cloud') return legacyOverride
    return persistedState?.yoloAdProfileRuntime === 'cloud' ? 'cloud' : 'local'
  })
  const [yoloAdVideoSource, setYoloAdVideoSource] = useState(() => {
    const saved = String(persistedState?.yoloAdVideoSource || '').trim().toLowerCase()
    if (saved === 'local' || saved === 'cloud') return saved
    const legacyOverride = String(persistedState?.yoloAdVideoRuntimeOverride || '').trim().toLowerCase()
    if (legacyOverride === 'local' || legacyOverride === 'cloud') return legacyOverride
    return persistedState?.yoloAdProfileRuntime === 'cloud' ? 'cloud' : 'local'
  })
  const [yoloAdStoryboardTier, setYoloAdStoryboardTier] = useState(() => {
    const saved = String(persistedState?.yoloAdStoryboardTier || '').trim().toLowerCase()
    if (saved === 'low' || saved === 'quality') return saved
    if (saved === 'draft') return 'low'
    if (saved === 'balanced' || saved === 'premium') return 'quality'
    const legacyProfile = String(persistedState?.yoloQualityProfile || '').trim().toLowerCase()
    if (legacyProfile === 'draft') return 'low'
    if (legacyProfile === 'balanced' || legacyProfile === 'premium') return 'quality'
    return 'low'
  })
  const [yoloAdVideoTier, setYoloAdVideoTier] = useState(() => {
    const saved = String(persistedState?.yoloAdVideoTier || '').trim().toLowerCase()
    if (saved === 'low' || saved === 'quality') return saved
    if (saved === 'draft') return 'low'
    if (saved === 'balanced' || saved === 'premium') return 'quality'
    const legacyProfile = String(persistedState?.yoloQualityProfile || '').trim().toLowerCase()
    if (legacyProfile === 'draft') return 'low'
    if (legacyProfile === 'balanced' || legacyProfile === 'premium') return 'quality'
    return 'low'
  })
  const [yoloPlan, setYoloPlan] = useState(() => normalizePersistedYoloPlan(persistedState?.yoloPlan || []))

  // Director Mode Music Video state.
  // Schema mirrors the Ad script-first pattern: one big director script is the
  // source of truth for shot breakdown + per-shot prompts, with side inputs
  // for audio, lyrics, artist reference, and top-level style continuity notes.
  // Ad Creation state is completely independent (yoloAd*) — do not cross
  // the streams when editing either side.
  const [yoloMusicAudioAssetId, setYoloMusicAudioAssetId] = useState(persistedState?.yoloMusicAudioAssetId || null)
  const [yoloMusicAudioKind, setYoloMusicAudioKind] = useState(persistedState?.yoloMusicAudioKind || 'mixed_track')
  // Lyrics field accepts plain text, SRT, or LRC — auto-detected by
  // detectTimedLyricsFormat. When the paste is SRT/LRC the planner uses real
  // per-line timings (tier 2 of audioStart resolution); when it's plain
  // text we fall back to the legacy tagged/linear-estimate path.
  //
  // One-time migration: a Phase 8a intermediate state used a separate
  // `yoloMusicLyricsSrt` textarea. If an old persisted blob has that field
  // populated while the plain `yoloMusicLyrics` is empty, we promote the
  // SRT into the main lyrics slot so the format auto-detect picks it up.
  // If both were populated we keep the plain lyrics (rare but possible —
  // the SRT one is considered the newer data only when lyrics is empty).
  const [yoloMusicLyrics, setYoloMusicLyrics] = useState(() => {
    const plain = String(persistedState?.yoloMusicLyrics || '')
    const legacySrt = String(persistedState?.yoloMusicLyricsSrt || '')
    if (plain.trim()) return plain
    if (legacySrt.trim()) return legacySrt
    return ''
  })
  const [yoloMusicConcept, setYoloMusicConcept] = useState(persistedState?.yoloMusicConcept || '')
  const [yoloMusicStyleNotes, setYoloMusicStyleNotes] = useState(persistedState?.yoloMusicStyleNotes || '')
  // Director script in the ad format (Scene/Shot/Shot type/Keyframe prompt/
  // Motion prompt/Camera/Length + optional Lyric moment). Parsed by
  // buildMusicVideoPlanFromScript. Empty by default — users click "Start from
  // template" or paste their own.
  const [yoloMusicScript, setYoloMusicScript] = useState(persistedState?.yoloMusicScript || '')
  // Alt-pass script library. Each alt script is a second-unit coverage pass
  // of the same song — alt performance (different setting), environmental
  // b-roll (no performers), or detail b-roll (macro inserts). They all share
  // the master's song/cast/concept context but get their own script blob.
  //
  // Shape: [{ id, passType, label, variantDescriptor, script, createdAt,
  //          plan, planSignature, planWarnings }]
  //   - passType: 'alt_performance' | 'environmental_broll' | 'detail_broll'
  //   - variantDescriptor: only meaningful for 'alt_performance' (e.g. "Jake in the car at night")
  //   - label: user-visible tab name; auto-derived on create, editable later
  //   - script: the pasted-back LLM output for this pass (empty until pasted)
  //   - plan: normalized scenes[] produced by "Build Plan" on the alt tab;
  //           empty until the user explicitly builds. Persisted.
  //   - planSignature: signature at the time of last build; compared against
  //                    makeMusicPlanSignature({ script: alt.script }) to detect
  //                    "script edited since build" → stale-plan banner. Persisted.
  //   - planWarnings: transient warnings surfaced by the last build. NOT
  //                    persisted (matches master behavior); regenerated on
  //                    rebuild. Always hydrated as [] on load.
  //
  // Each alt slot now owns its own plan state. The active-target dispatcher
  // (yoloMusicActiveTargetId = null means master, else alt.id) routes plan
  // reads/writes to the right place, so the existing storyboard + shot editor
  // + generation flow can operate on an alt pass without any code that knows
  // "oh we're on an alt" — it just reads yoloActivePlan.
  const [yoloMusicAltScripts, setYoloMusicAltScripts] = useState(() => {
    const saved = Array.isArray(persistedState?.yoloMusicAltScripts) ? persistedState.yoloMusicAltScripts : []
    return saved
      .map((entry, idx) => ({
        id: String(entry?.id || `alt-script-${Date.now()}-${idx}`),
        passType: String(entry?.passType || 'alt_performance'),
        label: String(entry?.label || '').slice(0, 80),
        variantDescriptor: String(entry?.variantDescriptor || ''),
        script: String(entry?.script || ''),
        createdAt: Number(entry?.createdAt) || Date.now(),
        plan: normalizePersistedYoloPlan(Array.isArray(entry?.plan) ? entry.plan : []),
        planSignature: String(entry?.planSignature || ''),
        planWarnings: [],
      }))
      .filter((entry) => entry.passType && entry.label)
  })
  // Null → viewing/editing the master script. Otherwise the id of an alt
  // script. Kept out of persistence so the tab selection resets to Master
  // on a fresh page load; alt scripts themselves survive.
  const [yoloMusicActiveScriptId, setYoloMusicActiveScriptId] = useState(null)
  // Legacy single-artist reference — still honored as a fallback when the
  // cast roster (below) is empty. Phase 6 surfaced it as "Artist Reference";
  // phase 7 treats it as an auto-seeded cast[0] so multi-singer scripts can
  // extend past a single performer.
  const [yoloMusicArtistAssetId, setYoloMusicArtistAssetId] = useState(persistedState?.yoloMusicArtistAssetId ?? null)
  // Cast roster — an ordered list of named performers (singer, duet partner,
  // backing vocalist, band member...). Each entry is:
  //   { id, slug, label, assetId, role }
  // Scripts reference cast members via `Artist: rose`, `Artist: both`, or
  // lyric `[Rose]` / `[Rose, Jake]` tag lines. When a shot can't resolve an
  // explicit name, it falls back to cast[0] (the "default lead").
  const [yoloMusicCast, setYoloMusicCast] = useState(() => {
    const saved = Array.isArray(persistedState?.yoloMusicCast) ? persistedState.yoloMusicCast : []
    return saved
      .map((entry, idx) => ({
        id: String(entry?.id || `cast-${Date.now()}-${idx}`),
        slug: String(entry?.slug || '').trim(),
        label: String(entry?.label || '').trim(),
        assetId: entry?.assetId ?? null,
        role: String(entry?.role || 'lead'),
      }))
      .filter((entry) => entry.assetId || entry.label || entry.slug)
  })
  const [yoloMusicTargetDuration, setYoloMusicTargetDuration] = useState(persistedState?.yoloMusicTargetDuration || 30)
  const [yoloMusicQualityProfile, setYoloMusicQualityProfile] = useState(persistedState?.yoloMusicQualityProfile || 'balanced')
  const [yoloMusicKeyframeWorkflowId, setYoloMusicKeyframeWorkflowId] = useState(() => {
    const saved = String(persistedState?.yoloMusicKeyframeWorkflowId || '').trim()
    if (saved === 'z-image-turbo') return 'image-edit'
    if (YOLO_MUSIC_KEYFRAME_WORKFLOW_OPTIONS.some((option) => option.id === saved)) return saved
    const legacyProfileId = String(persistedState?.yoloMusicQualityProfile || '').trim()
    const legacyWorkflowId = String(YOLO_MUSIC_PROFILES[legacyProfileId]?.storyboardWorkflowId || '').trim()
    if (YOLO_MUSIC_KEYFRAME_WORKFLOW_OPTIONS.some((option) => option.id === legacyWorkflowId)) return legacyWorkflowId
    if (legacyProfileId === 'draft') return 'image-edit'
    return 'nano-banana-2'
  })
  const [yoloMusicVideoWorkflowId, setYoloMusicVideoWorkflowId] = useState(() => {
    const saved = String(persistedState?.yoloMusicVideoWorkflowId || '').trim()
    return YOLO_MUSIC_VIDEO_WORKFLOW_OPTIONS.some((option) => option.id === saved)
      ? saved
      : YOLO_MUSIC_VIDEO_WORKFLOW_OPTIONS[0]?.id || MUSIC_VIDEO_SHOT_WORKFLOW_ID
  })
  const [yoloMusicPlan, setYoloMusicPlan] = useState(() => normalizePersistedYoloPlan(persistedState?.yoloMusicPlan || []))
  const [yoloMusicPlanSignature, setYoloMusicPlanSignature] = useState(persistedState?.yoloMusicPlanSignature || '')
  // Planner warnings surfaced next to the build button: unresolved Artist: /
  // [Name] tags, too-many-artists overflow, etc. Advisory — does not block.
  const [yoloMusicPlanWarnings, setYoloMusicPlanWarnings] = useState([])

  // Generation queue state
  const [generationQueue, setGenerationQueue] = useState(() => loadPersistedGenerationQueue())
  const [activeJobId, setActiveJobId] = useState(null)
  const processingRef = useRef(false)
  const queueRef = useRef([])
  const startedJobIdsRef = useRef(new Set())
  const queuePausedRef = useRef(false)
  const consecutiveRapidFailsRef = useRef(0)
  const lastJobFinishTimeRef = useRef(0)
  const RAPID_FAIL_THRESHOLD_MS = 5000
  const MAX_CONSECUTIVE_RAPID_FAILS = 3
  const MIN_JOB_INTERVAL_MS = 2000
  const [formError, setFormError] = useState(null)
  const [formErrorCopyStatus, setFormErrorCopyStatus] = useState('')
  const [creatingStoryboardPdf, setCreatingStoryboardPdf] = useState(false)
  const [yoloMusicAudioImporting, setYoloMusicAudioImporting] = useState(false)
  const [yoloMusicTranscribingSrt, setYoloMusicTranscribingSrt] = useState(false)
  const [yoloMusicTranscriptionStatus, setYoloMusicTranscriptionStatus] = useState('')
  const [confirmDialog, setConfirmDialog] = useState(null) // { title, message, confirmLabel, cancelLabel, tone }
  const confirmResolverRef = useRef(null)
  const [openWorkflowHint, setOpenWorkflowHint] = useState('')
  const [yoloDependencyCheckInProgress, setYoloDependencyCheckInProgress] = useState(false)
  const [yoloDependencyPanel, setYoloDependencyPanel] = useState({
    status: 'idle',
    byWorkflow: {},
    checkedAt: 0,
    error: '',
  })
  const yoloDependencyPanelVersionRef = useRef(0)
  const [dependencyCheck, setDependencyCheck] = useState({
    status: 'idle',
    hasPack: false,
    hasBlockingIssues: false,
    missingNodes: [],
    missingModels: [],
    unresolvedModels: [],
    missingAuth: false,
    error: '',
    pack: null,
    checkedAt: 0,
    workflowId: '',
  })
  const dependencyCheckVersionRef = useRef(0)
  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false)
  const [comfyLogExpanded, setComfyLogExpanded] = useState(false)
  const [comfyLogLines, setComfyLogLines] = useState([])
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false)
  const [workflowInfoExpanded, setWorkflowInfoExpanded] = useState(true)
  const comfyLogEndRef = useRef(null)
  const importedMediaSignaturesRef = useRef(new Set())
  const storyboardPdfBatchesRef = useRef(new Map())
  const COMFY_LOG_MAX = 400
  const addComfyLog = useCallback((type, msg) => {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false })
    setComfyLogLines(prev => {
      const next = [...prev, { ts, type, msg }]
      return next.slice(-COMFY_LOG_MAX)
    })
  }, [])

  // Hooks
  const { isConnected, wsConnected, queueCount, recheckConnection } = useComfyUI()
  const { addAsset, generateName, assets } = useAssetsStore()
  const { currentProjectHandle, currentProject, saveProject } = useProjectStore()
  const timelineTracks = useTimelineStore((s) => s.tracks)
  const timelineAddTextClip = useTimelineStore((s) => s.addTextClip)
  const timelineAddTrack = useTimelineStore((s) => s.addTrack)
  const timelineAddClip = useTimelineStore((s) => s.addClip)
  const timelineFps = useTimelineStore((s) => s.timelineFps)
  const frameForAI = useFrameForAIStore((s) => s.frame)
  const clearFrameForAI = useFrameForAIStore((s) => s.clearFrame)

  // ComfyUI launcher state (drives gating banner and auto-dispatch behavior)
  const [launcherState, setLauncherState] = useState(() => (
    isComfyLauncherAvailable() ? getComfyLauncherSnapshot() : null
  ))
  useEffect(() => {
    if (!isComfyLauncherAvailable()) return undefined
    return subscribeComfyLauncherState((next) => setLauncherState(next))
  }, [])
  // When the launcher reports the process is up, immediately re-check the
  // ComfyUI HTTP/WebSocket so the queue can drain without waiting for the next
  // 10-30s polling tick.
  useEffect(() => {
    if (!launcherState) return
    if (launcherState.state === 'running' || launcherState.state === 'external') {
      void recheckConnection?.()
    }
  }, [launcherState?.state, recheckConnection])

  const launcherIsBooting = Boolean(launcherState && (launcherState.state === 'starting' || launcherState.state === 'stopping'))
  const launcherCanAutoStart = Boolean(launcherState
    && (launcherState.state === 'idle' || launcherState.state === 'stopped' || launcherState.state === 'crashed')
    && launcherState.launcherScript)
  const launcherWaitingForExternal = Boolean(launcherState && launcherState.state === 'external' && !isConnected)
  const showComfyGatingBanner = !isConnected && (launcherIsBooting || launcherWaitingForExternal || launcherCanAutoStart)
  const allowQueueWhileWaiting = !isConnected && (launcherIsBooting || launcherCanAutoStart || launcherWaitingForExternal)

  // When opened with timeline frame, switch to video i2v and use that frame as input
  useEffect(() => {
    if (frameForAI) {
      setCategory('video')
      setWorkflowId('wan22-i2v')
      setFormError(null)
    }
  }, [frameForAI?.blobUrl])

  // Restore selected asset from ID when assets are available
  useEffect(() => {
    if (selectedAssetId && assets.length > 0) {
      const asset = assets.find(a => a.id === selectedAssetId)
      if (asset) {
        setSelectedAsset(asset)
      } else {
        // Asset no longer exists, clear selection
        setSelectedAssetId(null)
        setSelectedAsset(null)
      }
    }
  }, [selectedAssetId, assets])

  useEffect(() => {
    if (selectedAudioAssetId && assets.length > 0) {
      const asset = assets.find(a => a.id === selectedAudioAssetId && a.type === 'audio')
      if (asset) {
        setSelectedAudioAsset(asset)
      } else {
        setSelectedAudioAssetId(null)
        setSelectedAudioAsset(null)
      }
    } else if (!selectedAudioAssetId) {
      setSelectedAudioAsset(null)
    }
  }, [selectedAudioAssetId, assets])

  useEffect(() => {
    const nextFields = {}
    let changed = false
    for (const [fieldId, assetId] of Object.entries(selectedAssetFieldIds || {})) {
      if (!assetId) continue
      const asset = assets.find((entry) => entry.id === assetId) || null
      if (asset) {
        nextFields[fieldId] = asset
      } else {
        changed = true
      }
    }
    setSelectedAssetFields(nextFields)
    if (changed) {
      setSelectedAssetFieldIds((prev) => {
        const nextIds = {}
        for (const [fieldId, assetId] of Object.entries(prev || {})) {
          if (assetId && assets.some((entry) => entry.id === assetId)) nextIds[fieldId] = assetId
        }
        return nextIds
      })
    }
  }, [selectedAssetFieldIds, assets])

  // Persist state to localStorage whenever it changes
  useEffect(() => {
    try {
      const stateToSave = {
        generationMode,
        category,
        workflowId,
        selectedWorkflowManifestId,
        workflowRoute,
        selectedAssetId,
        selectedAudioAssetId,
        selectedAssetFieldIds,
        activeAssetSlotId,
        frameTime,
        prompt,
        negativePrompt,
        seed,
        selectedTags,
        duration,
        resolution,
        imageResolution,
        fps,
        interpolationMultiplier,
        enableFpsMultiplier,
        wanQualityPreset,
        editSteps,
        editCfg,
        referenceAssetId1,
        referenceAssetId2,
        musicTags,
        lyrics,
        musicDuration,
        bpm,
        keyscale,
        yoloCreationType,
        yoloScript,
        yoloAdProductAssetId,
        yoloAdModelAssetId,
        yoloAdVoiceoverAssetId,
        yoloAdProductName,
        yoloAdBrandName,
        yoloAdColorPalette,
        yoloAdLogoConstraints,
        yoloAdSpokespersonRole,
        yoloAdWardrobeNotes,
        yoloAdFormatPreset,
        yoloAdPlatformPreset,
        yoloAdLocalVideoWorkflowId,
        yoloAdConsistency,
        yoloTargetDuration,
        yoloShotsPerScene,
        yoloAnglesPerShot,
        yoloTakesPerAngle,
        yoloPlanSignature,
        yoloVideoFps,
        yoloAdStoryboardSource,
        yoloAdVideoSource,
        yoloAdStoryboardTier,
        yoloAdVideoTier,
        yoloPlan,
        yoloMusicAudioAssetId,
        yoloMusicAudioKind,
        yoloMusicLyrics,
        yoloMusicConcept,
        yoloMusicStyleNotes,
        yoloMusicScript,
        yoloMusicAltScripts,
        yoloMusicArtistAssetId,
        yoloMusicCast,
        yoloMusicTargetDuration,
        yoloMusicQualityProfile,
        yoloMusicKeyframeWorkflowId,
        yoloMusicVideoWorkflowId,
        yoloMusicPlan,
        yoloMusicPlanSignature,
      }
      localStorage.setItem('generate-workspace-state', JSON.stringify(stateToSave))
    } catch (error) {
      console.error('Failed to save Generate workspace state:', error)
    }
  }, [
    generationMode,
    category,
    workflowId,
    selectedWorkflowManifestId,
    workflowRoute,
    selectedAssetId,
    selectedAudioAssetId,
    selectedAssetFieldIds,
    activeAssetSlotId,
    frameTime,
    prompt,
    negativePrompt,
    seed,
    selectedTags,
    duration,
    resolution,
    imageResolution,
    fps,
    interpolationMultiplier,
    enableFpsMultiplier,
    wanQualityPreset,
    editSteps,
    editCfg,
    referenceAssetId1,
    referenceAssetId2,
    musicTags,
    lyrics,
    musicDuration,
    bpm,
    keyscale,
    yoloCreationType,
    yoloScript,
    yoloAdProductAssetId,
    yoloAdModelAssetId,
    yoloAdVoiceoverAssetId,
    yoloAdProductName,
    yoloAdBrandName,
    yoloAdColorPalette,
    yoloAdLogoConstraints,
    yoloAdSpokespersonRole,
    yoloAdWardrobeNotes,
    yoloAdFormatPreset,
    yoloAdPlatformPreset,
    yoloAdLocalVideoWorkflowId,
    yoloAdConsistency,
    yoloTargetDuration,
    yoloShotsPerScene,
    yoloAnglesPerShot,
    yoloTakesPerAngle,
    yoloPlanSignature,
    yoloVideoFps,
    yoloAdStoryboardSource,
    yoloAdVideoSource,
    yoloAdStoryboardTier,
    yoloAdVideoTier,
    yoloPlan,
    yoloMusicAudioAssetId,
    yoloMusicAudioKind,
    yoloMusicLyrics,
    yoloMusicConcept,
    yoloMusicStyleNotes,
    yoloMusicScript,
    yoloMusicAltScripts,
    yoloMusicArtistAssetId,
    yoloMusicCast,
    yoloMusicTargetDuration,
    yoloMusicQualityProfile,
    yoloMusicKeyframeWorkflowId,
    yoloMusicVideoWorkflowId,
    yoloMusicPlan,
    yoloMusicPlanSignature,
  ])

  // Keep queue ref in sync
  useEffect(() => {
    queueRef.current = generationQueue
  }, [generationQueue])

  useEffect(() => {
    try {
      const jobsToPersist = generationQueue
        .filter((job) => RECOVERABLE_JOB_STATUSES.has(job.status))
        .map(sanitizeGenerationJobForStorage)
        .filter(Boolean)
        .slice(-PERSISTED_GENERATION_QUEUE_LIMIT)
      if (jobsToPersist.length === 0) {
        localStorage.removeItem(GENERATION_QUEUE_STORAGE_KEY)
      } else {
        localStorage.setItem(GENERATION_QUEUE_STORAGE_KEY, JSON.stringify(jobsToPersist))
      }
    } catch (error) {
      console.error('Failed to persist generation queue:', error)
    }
  }, [generationQueue])

  useEffect(() => {
    const restoredCount = generationQueue.filter((job) => job.restoredFromLedger).length
    if (restoredCount > 0) {
      addComfyLog('status', `Restored ${restoredCount} unfinished generation job${restoredCount === 1 ? '' : 's'} from the local ledger`)
    }
  }, [])

  // Open annotation modal with current input image (or extracted video frame)
  const openAnnotationModal = useCallback(async () => {
    if (annotationBlobUrlRef.current) {
      URL.revokeObjectURL(annotationBlobUrlRef.current)
      annotationBlobUrlRef.current = null
    }
    if (!selectedAsset) {
      setAnnotationInitialUrl(null)
      setAnnotationModalOpen(true)
      return
    }
    if (selectedAsset.type === 'image') {
      setAnnotationInitialUrl(selectedAsset.url)
      setAnnotationModalOpen(true)
      return
    }
    if (selectedAsset.type === 'video') {
      setAnnotationPreparing(true)
      try {
        const file = await extractFrameAsFile(selectedAsset.url, frameTime || 0, `frame_${Date.now()}.png`)
        const url = URL.createObjectURL(file)
        annotationBlobUrlRef.current = url
        setAnnotationInitialUrl(url)
        setAnnotationModalOpen(true)
      } catch (e) {
        console.error('Failed to extract frame for annotation', e)
      }
      setAnnotationPreparing(false)
    } else {
      setAnnotationInitialUrl(null)
      setAnnotationModalOpen(true)
    }
  }, [selectedAsset, frameTime])

  const closeAnnotationModal = useCallback(() => {
    setAnnotationModalOpen(false)
    if (annotationBlobUrlRef.current) {
      URL.revokeObjectURL(annotationBlobUrlRef.current)
      annotationBlobUrlRef.current = null
    }
  }, [])

  const handleAnnotationUseAsRef = useCallback((blob, slot) => {
    const url = URL.createObjectURL(blob)
    const name = `Annotated ref ${slot}_${Date.now()}.png`
    const newAsset = addAsset({ name, type: 'image', url })
    if (slot === 1) setReferenceAssetId1(newAsset.id)
    if (slot === 2) setReferenceAssetId2(newAsset.id)
  }, [addAsset])

  const currentCategoryWorkflows = useMemo(
    () => WORKFLOWS[category] || [],
    [category]
  )

  // Current workflow info
  const currentWorkflow = useMemo(
    () => currentCategoryWorkflows.find((workflow) => workflow.id === workflowId) || currentCategoryWorkflows[0],
    [currentCategoryWorkflows, workflowId]
  )
  const formErrorTroubleshootingHints = useMemo(
    () => buildGenerationErrorTroubleshootingHints(formError),
    [formError]
  )
  useEffect(() => {
    setFormErrorCopyStatus('')
  }, [formError])
  const handleCopyFormError = useCallback(async () => {
    if (!formError) return
    const text = buildGenerationErrorClipboardText({
      errorText: formError,
      hints: formErrorTroubleshootingHints,
      workflow: currentWorkflow,
      generationMode,
    })
    try {
      await copyTextToClipboard(text)
      setFormErrorCopyStatus('Copied')
      setTimeout(() => setFormErrorCopyStatus(''), 1600)
    } catch {
      setFormErrorCopyStatus('Copy failed')
      setTimeout(() => setFormErrorCopyStatus(''), 1600)
    }
  }, [currentWorkflow, formError, formErrorTroubleshootingHints, generationMode])
  const activeWorkflowBrowserMode = generationMode === 'yolo' ? 'create' : 'generate'
  const visibleWorkflowManifests = useMemo(() => (
    GENERATE_WORKFLOW_CATALOG.filter((workflow) => (
      workflow.mode === activeWorkflowBrowserMode
        && (activeWorkflowBrowserMode === 'create'
          ? workflow.route === 'local'
          : workflow.route === workflowRoute)
    ))
  ), [activeWorkflowBrowserMode, workflowRoute])
  const selectedWorkflowManifest = useMemo(() => (
    GENERATE_WORKFLOW_CATALOG.find((workflow) => workflow.id === selectedWorkflowManifestId)
      || getWorkflowManifestByWorkflowId(workflowId)
      || visibleWorkflowManifests[0]
      || null
  ), [selectedWorkflowManifestId, visibleWorkflowManifests, workflowId])
  const assetInputSlots = useMemo(() => (
    (selectedWorkflowManifest?.fields || [])
      .filter((field) => (
        (field?.type === 'asset' || field?.type === 'assetSelect') &&
        field.id !== 'audioAsset'
      ))
      .map((field) => ({
        id: field.id || 'asset',
        label: field.label || (field.id === 'asset' ? 'Input asset' : field.id),
        assetType: field.assetType || selectedWorkflowManifest?.inputAssetType || 'image',
        isPrimary: field.type === 'asset' || field.id === 'asset',
      }))
  ), [selectedWorkflowManifest])
  const activeAssetSlot = useMemo(() => (
    assetInputSlots.find((slot) => slot.id === activeAssetSlotId) || assetInputSlots[0] || null
  ), [activeAssetSlotId, assetInputSlots])
  const primaryAssetSlot = useMemo(() => (
    assetInputSlots.find((slot) => slot.isPrimary) || null
  ), [assetInputSlots])
  const videoDurationPresets = useMemo(
    () => getVideoDurationPresets(workflowId),
    [workflowId]
  )

  useEffect(() => {
    if (assetInputSlots.length === 0) return
    if (assetInputSlots.some((slot) => slot.id === activeAssetSlotId)) return
    setActiveAssetSlotId(assetInputSlots[0].id)
  }, [activeAssetSlotId, assetInputSlots])

  const currentCategoryWorkflowGroups = useMemo(() => {
    const groups = {
      local: [],
      cloud: [],
    }

    currentCategoryWorkflows.forEach((workflow) => {
      const runtime = getWorkflowHardwareInfo(workflow.id)?.runtime === 'cloud' ? 'cloud' : 'local'
      groups[runtime].push(workflow)
    })

    return ['local', 'cloud']
      .map((groupId) => {
        const workflows = groups[groupId]
        if (workflows.length === 0) return null
        return {
          ...WORKFLOW_RUNTIME_GROUPS[groupId],
          workflows,
        }
      })
      .filter(Boolean)
  }, [currentCategoryWorkflows])

  // When category changes, pick default workflow
  useEffect(() => {
    if (currentCategoryWorkflows.length > 0 && !currentCategoryWorkflows.find((workflow) => workflow.id === workflowId)) {
      setWorkflowId(currentCategoryWorkflows[0].id)
    }
  }, [currentCategoryWorkflows, workflowId])

  const handleWorkflowManifestSelect = useCallback((manifest) => {
    if (!manifest) return

    setSelectedWorkflowManifestId(manifest.id)
    setWorkflowRoute(manifest.route || 'local')
    setFormError(null)
    setWorkflowDetailOpen(true)

    if (manifest.mode === 'create') {
      setGenerationMode('yolo')
      const createTitle = String(manifest.title || '').toLowerCase()
      setYoloCreationType(
        manifest.id === 'short-film-easy-mode' || createTitle.includes('short')
          ? 'short-film'
          : createTitle.includes('music')
            ? 'music'
            : 'ad'
      )
      if (manifest.id === 'product-ad-easy-mode') {
        setYoloAdStoryboardSource('cloud')
        setYoloAdStoryboardTier('quality')
        setYoloAdVideoSource('local')
        setYoloAdVideoTier('quality')
        setYoloAdLocalVideoWorkflowId('ltx23-i2v')
        setYoloAnglesPerShot(1)
        setYoloTakesPerAngle(1)
        setYoloVideoFps(24)
        setResolution({ width: 720, height: 1280 })
        setImageResolution({ width: 720, height: 1280 })
      }
      return
    }

    setGenerationMode('single')
    if (!manifest.runnable || !manifest.workflowId) {
      setFormError('This workflow is in the catalog as a preview. Add its workflow graph and bindings before queueing it.')
      return
    }

    const nextCategory = manifest.outputType === 'audio'
      ? 'audio'
      : manifest.outputType === 'image'
        ? 'image'
        : 'video'
    setCategory(nextCategory)
    setWorkflowId(manifest.workflowId)
  }, [])

  const handleWorkflowRouteChange = useCallback((nextRoute) => {
    setWorkflowRoute(nextRoute)
    setWorkflowDetailOpen(false)
  }, [])

  useEffect(() => {
    if (generationMode !== 'single' || category !== 'video' || videoDurationPresets.length === 0) return
    if (videoDurationPresets.includes(Number(duration))) return

    setDuration(videoDurationPresets.reduce((closest, candidate) => (
      Math.abs(candidate - duration) < Math.abs(closest - duration) ? candidate : closest
    ), videoDurationPresets[0]))
  }, [category, duration, generationMode, videoDurationPresets])

  useEffect(() => {
    if (generationMode !== 'single' || category !== 'video' || ['ltx23-i2v', 'ltx23-ia2v', 'ltx23-t2v'].includes(workflowId)) return
    if (resolution.width === 3840 && resolution.height === 2160) {
      setResolution({ width: 1920, height: 1080 })
    } else if (resolution.width === 2160 && resolution.height === 3840) {
      setResolution({ width: 1080, height: 1920 })
    }
  }, [category, generationMode, resolution.height, resolution.width, workflowId])

  useEffect(() => {
    setFormError(null)
  }, [generationMode, yoloCreationType])

  useEffect(() => {
    if (generationMode !== 'yolo') return
    setDirectorSubTab((prev) => (prev === 'setup' ? prev : 'setup'))
  }, [generationMode, yoloCreationType])

  useEffect(() => {
    setOpenWorkflowHint('')
  }, [workflowId, generationMode, category])

  useEffect(() => {
    const manifest = getWorkflowManifestByWorkflowId(workflowId)
    if (!manifest) return
    setSelectedWorkflowManifestId(manifest.id)
    setWorkflowRoute(manifest.route || 'local')
  }, [workflowId])

  const runWorkflowDependencyCheck = useCallback(async () => {
    const requestVersion = dependencyCheckVersionRef.current + 1
    dependencyCheckVersionRef.current = requestVersion

    if (generationMode !== 'single' || !workflowId) {
      setDependencyCheck({
        status: 'idle',
        hasPack: false,
        hasBlockingIssues: false,
        missingNodes: [],
        missingModels: [],
        unresolvedModels: [],
        missingAuth: false,
        error: '',
        pack: null,
        checkedAt: Date.now(),
        workflowId: workflowId || '',
      })
      return null
    }

    if (!isConnected) {
      setDependencyCheck((prev) => ({
        ...prev,
        status: 'offline',
        error: '',
        checkedAt: Date.now(),
        workflowId,
      }))
      return null
    }

    setDependencyCheck((prev) => ({
      ...prev,
      status: 'checking',
      error: '',
      checkedAt: Date.now(),
      workflowId,
    }))

    const result = await checkWorkflowDependencies(workflowId)
    if (dependencyCheckVersionRef.current !== requestVersion) return null
    setDependencyCheck(result)
    return result
  }, [generationMode, workflowId, isConnected])

  useEffect(() => {
    void runWorkflowDependencyCheck()
  }, [runWorkflowDependencyCheck])

  useEffect(() => {
    const handler = () => { void runWorkflowDependencyCheck() }
    window.addEventListener(COMFY_PARTNER_KEY_CHANGED_EVENT, handler)
    return () => window.removeEventListener(COMFY_PARTNER_KEY_CHANGED_EVENT, handler)
  }, [runWorkflowDependencyCheck])

  const validateDependenciesForQueue = useCallback(async (workflowIds, queueLabel) => {
    const normalizedIds = Array.from(new Set(
      (Array.isArray(workflowIds) ? workflowIds : [])
        .map((workflow) => String(workflow || '').trim())
        .filter(Boolean)
    ))
    if (normalizedIds.length === 0) return true

    setYoloDependencyCheckInProgress(true)
    try {
      const results = await Promise.all(normalizedIds.map((workflow) => checkWorkflowDependencies(workflow)))
      setYoloDependencyPanel({
        status: getDependencyAggregateStatus(results),
        byWorkflow: buildDependencyResultMap(results),
        checkedAt: Date.now(),
        error: '',
      })

      const blocked = results.filter((result) => result?.hasPack && result?.hasBlockingIssues)
      if (blocked.length > 0) {
        const summary = blocked.map(summarizeBlockingDependency).join('; ')
        setFormError(`Cannot queue ${queueLabel}. Missing dependencies: ${summary}.`)
        addComfyLog('error', `Blocked ${queueLabel}: ${summary}`)
        return false
      }

      const failures = results.filter((result) => result?.status === 'error')
      if (failures.length > 0) {
        addComfyLog(
          'error',
          `${queueLabel}: dependency check unavailable for ${failures.length} workflow${failures.length === 1 ? '' : 's'}. Queueing continues.`
        )
      }
      return true
    } catch (error) {
      setYoloDependencyPanel((prev) => ({
        ...prev,
        status: 'error',
        checkedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error || 'Dependency check failed'),
      }))
      addComfyLog('error', `${queueLabel}: dependency check failed. Queueing continues.`)
      return true
    } finally {
      setYoloDependencyCheckInProgress(false)
    }
  }, [addComfyLog])

  const handleCopyDependencyReport = useCallback(async () => {
    const text = buildMissingDependencyClipboardText(dependencyCheck)
    try {
      await copyTextToClipboard(text)
      addComfyLog('info', 'Dependency report copied to clipboard.')
    } catch (_) {
      setFormError('Could not copy dependency report. Copy manually from the checklist.')
    }
  }, [addComfyLog, dependencyCheck])

  const handleOpenCurrentWorkflowInComfyUi = useCallback(async () => {
    if (generationMode !== 'single') return

    const result = await openBundledWorkflowInComfyUi(workflowId)
    if (result.success) {
      setOpenWorkflowHint(result.hint || 'Loaded workflow in the embedded ComfyUI tab.')
      setFormError(null)
      addComfyLog('info', `Loaded ${getWorkflowDisplayLabel(workflowId)} into the embedded ComfyUI tab.`)
      return
    }

    setFormError(result.error || 'Could not open workflow in ComfyUI.')
    setOpenWorkflowHint('')
  }, [addComfyLog, generationMode, workflowId])

  const dependencyCheckInProgress = generationMode === 'single' && dependencyCheck.status === 'checking'
  const hasBlockingDependencies = generationMode === 'single' && dependencyCheck.hasBlockingIssues
  const isGenerateDisabled = (
    (!isConnected && !allowQueueWhileWaiting)
    || (generationMode === 'single' && selectedWorkflowManifest && !selectedWorkflowManifest.runnable)
    || (generationMode === 'single' && (dependencyCheckInProgress || hasBlockingDependencies))
    || (generationMode === 'yolo' && yoloDependencyCheckInProgress)
  )

  // Build full prompt with tags
  const fullPrompt = useMemo(() => {
    const tagStr = selectedTags.length > 0 ? selectedTags.join(', ') + '. ' : ''
    return tagStr + prompt
  }, [prompt, selectedTags])

  // Frame count helper
  const getFrameCount = () => Math.round(duration * fps) + 1

  const isYoloMusicMode = generationMode === 'yolo' && yoloCreationType === 'music'
  const isYoloShortFilmMode = generationMode === 'yolo' && yoloCreationType === 'short-film'
  const yoloModeKey = isYoloMusicMode ? 'music' : isYoloShortFilmMode ? 'short-film' : 'ad'
  const yoloModeLabel = isYoloMusicMode ? 'Music Video' : isYoloShortFilmMode ? 'Short Film' : 'Ad'
  const isAdEasyMode = generationMode === 'yolo'
    && yoloCreationType === 'ad'
    && selectedWorkflowManifest?.id === 'product-ad-easy-mode'
  // Active-target plan for music mode: null id → master, otherwise the alt
  // slot's own plan[]. Defined inline here (instead of reusing the richer
  // yoloMusicActiveAltScript memo below) to avoid a declaration-order
  // dependency — this block runs before that memo is defined.
  const yoloMusicActiveTargetPlan = useMemo(() => {
    if (!yoloMusicActiveScriptId) return yoloMusicPlan
    const slot = yoloMusicAltScripts.find((entry) => entry.id === yoloMusicActiveScriptId)
    return Array.isArray(slot?.plan) ? slot.plan : []
  }, [yoloMusicActiveScriptId, yoloMusicAltScripts, yoloMusicPlan])
  const yoloActivePlan = isYoloMusicMode ? yoloMusicActiveTargetPlan : yoloPlan
  const yoloCanEditScenes = yoloActivePlan.length > 0
  // Music-mode plan setter: dispatches writes to master state or the active
  // alt slot's plan[]. Supports both "new value" and "(prev) => next" forms so
  // it's a drop-in replacement for the raw React setter used by updateYoloShot.
  const setYoloActiveMusicPlan = useCallback((planOrUpdater) => {
    if (!yoloMusicActiveScriptId) {
      setYoloMusicPlan(planOrUpdater)
      return
    }
    const targetId = yoloMusicActiveScriptId
    setYoloMusicAltScripts((prev) => prev.map((entry) => {
      if (entry.id !== targetId) return entry
      const nextPlan = typeof planOrUpdater === 'function'
        ? planOrUpdater(Array.isArray(entry.plan) ? entry.plan : [])
        : planOrUpdater
      return { ...entry, plan: Array.isArray(nextPlan) ? nextPlan : [] }
    }))
  }, [yoloMusicActiveScriptId])
  const setYoloActivePlan = isYoloMusicMode ? setYoloActiveMusicPlan : setYoloPlan
  const yoloActiveTargetDuration = isYoloMusicMode ? yoloMusicTargetDuration : yoloTargetDuration
  // Music-video mode flattens to exactly one shot per scene, one angle, one take.
  // Per-shot length is driven by the `Length:` field inside the director script
  // (parsed per-shot) instead of multiplication across angle/take dimensions.
  // These `yoloActive*` forks are only read by the Ad-style UI which is hidden
  // in music mode, but we still surface sane values so any shared progress/
  // summary code that reads them does not explode on nulls.
  const yoloActiveShotsPerScene = isYoloMusicMode ? 1 : yoloShotsPerScene
  const yoloActiveAnglesPerShot = isYoloMusicMode ? 1 : yoloAnglesPerShot
  const yoloActiveTakesPerAngle = isYoloMusicMode ? 1 : yoloTakesPerAngle
  const yoloActiveStyleNotes = isYoloMusicMode ? yoloMusicStyleNotes : yoloStyleNotes
  const yoloAdProductAsset = useMemo(
    () => assets.find((asset) => asset?.id === yoloAdProductAssetId && asset?.type === 'image') || null,
    [assets, yoloAdProductAssetId]
  )
  const yoloAdModelAsset = useMemo(
    () => assets.find((asset) => asset?.id === yoloAdModelAssetId && asset?.type === 'image') || null,
    [assets, yoloAdModelAssetId]
  )
  const yoloAdVoiceoverAsset = useMemo(
    () => assets.find((asset) => asset?.id === yoloAdVoiceoverAssetId && asset?.type === 'audio') || null,
    [assets, yoloAdVoiceoverAssetId]
  )
  const yoloSelectedAdFormatPreset = useMemo(
    () => YOLO_AD_FORMAT_PRESETS.find((preset) => preset.id === yoloAdFormatPreset) || YOLO_AD_FORMAT_PRESETS[0],
    [yoloAdFormatPreset]
  )
  const yoloSelectedAdPlatformPreset = useMemo(
    () => YOLO_AD_PLATFORM_PRESETS.find((preset) => preset.id === yoloAdPlatformPreset) || YOLO_AD_PLATFORM_PRESETS[0],
    [yoloAdPlatformPreset]
  )
  const yoloAdHasReferenceAnchors = Boolean(yoloAdProductAsset || yoloAdModelAsset)
  // Music-video artist reference (legacy single-artist field). Auto-migrated
  // into the cast on first render — see the effect just below.
  const yoloMusicArtistAsset = useMemo(
    () => assets.find((asset) => asset?.id === yoloMusicArtistAssetId && asset?.type === 'image') || null,
    [assets, yoloMusicArtistAssetId]
  )
  // Audio asset for the currently-selected song. Used by the planner to
  // bound the coverage report against the real song length (Phase 8) and
  // by the LLM-prompt builder to mention duration in the brief.
  const yoloMusicAudioAssets = useMemo(
    () => assets.filter((asset) => asset?.type === 'audio'),
    [assets]
  )
  const yoloMusicAudioAsset = useMemo(
    () => yoloMusicAudioAssets.find((asset) => asset?.id === yoloMusicAudioAssetId) || null,
    [yoloMusicAudioAssets, yoloMusicAudioAssetId]
  )
  const yoloMusicSongDurationSeconds = useMemo(() => {
    const d = Number(yoloMusicAudioAsset?.duration)
    if (Number.isFinite(d) && d > 0) return d
    const settingsD = Number(yoloMusicAudioAsset?.settings?.duration)
    return Number.isFinite(settingsD) && settingsD > 0 ? settingsD : 0
  }, [yoloMusicAudioAsset])
  // Single-source-of-truth parse of the user-pasted Lyrics field. The field
  // auto-detects whether the paste is plain text, SRT, or LRC. When the
  // format is 'srt' or 'lrc', we consider the lyrics "timed" and the
  // planner uses the per-line timings; when the format is 'unknown' or
  // 'empty' we treat the paste as plain lyrics and fall through to the
  // legacy tagged/linear-estimate resolver.
  const yoloMusicParsedLyrics = useMemo(() => {
    const format = detectTimedLyricsFormat(yoloMusicLyrics)
    if (format === 'srt' || format === 'lrc') {
      return { ...parseTimedLyrics(yoloMusicLyrics), isTimed: true }
    }
    return { format, lines: [], error: null, isTimed: false }
  }, [yoloMusicLyrics])
  const handleImportYoloMusicAudio = useCallback(async () => {
    if (yoloMusicAudioImporting) return
    if (!currentProjectHandle) {
      setFormError('Open or create a project first so ComfyStudio can import the song file.')
      addComfyLog('error', 'Song audio import requires an open project folder.')
      return
    }

    let selectedFile = null
    try {
      if (isElectron() && window.electronAPI?.selectFile) {
        selectedFile = await window.electronAPI.selectFile({
          title: 'Select song audio',
          filters: [
            { name: 'Audio Files', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'] },
            { name: 'All Files', extensions: ['*'] },
          ],
        })
      } else {
        selectedFile = await new Promise((resolve) => {
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = 'audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus'
          input.onchange = () => resolve(input.files?.[0] || null)
          input.click()
        })
      }
    } catch (error) {
      const message = error?.message || 'Unknown file picker error'
      setFormError(`Could not open song audio picker: ${message}`)
      addComfyLog('error', `Could not open song audio picker: ${message}`)
      return
    }
    if (!selectedFile) return

    setFormError(null)
    setYoloMusicAudioImporting(true)

    try {
      const assetInfo = await importAsset(currentProjectHandle, selectedFile, 'audio')
      const sessionUrl = typeof selectedFile !== 'string' ? URL.createObjectURL(selectedFile) : null
      const newAsset = addAsset({
        ...assetInfo,
        type: 'audio',
        url: sessionUrl || assetInfo.url,
        settings: {
          ...(assetInfo.settings || {}),
          duration: assetInfo.duration,
        },
      })
      setYoloMusicAudioAssetId(newAsset.id)
      await saveProject?.()
      addComfyLog('status', `Imported song audio: ${newAsset.name || 'audio file'}`)
    } catch (error) {
      const message = error?.message || 'Unknown import error'
      setFormError(`Could not import song audio: ${message}`)
      addComfyLog('error', `Could not import song audio: ${message}`)
    } finally {
      setYoloMusicAudioImporting(false)
    }
  }, [
    addAsset,
    addComfyLog,
    currentProjectHandle,
    saveProject,
    yoloMusicAudioImporting,
  ])
  const handleYoloMusicTranscribeSrt = useCallback(async () => {
    if (!yoloMusicAudioAsset) {
      setFormError('Select the song audio asset first')
      return
    }
    if (yoloMusicTranscribingSrt) return

    if (yoloMusicLyrics.trim()) {
      const shouldReplace = window.confirm(
        'Replace the current Lyrics/SRT text with a fresh transcription from the selected song audio?'
      )
      if (!shouldReplace) return
    }

    setFormError(null)
    setYoloMusicTranscribingSrt(true)
    setYoloMusicTranscriptionStatus('Preparing Qwen ASR transcription...')

    try {
      const result = await transcribeWithComfyUI(yoloMusicAudioAsset, {
        onProgress: (progress) => {
          setYoloMusicTranscriptionStatus(progress?.message || 'Transcribing song audio...')
        },
      })
      const srt = formatCaptionCuesAsSrt(result?.cues || [])
      if (!srt.trim()) {
        throw new Error('The transcription completed, but no SRT cues were produced.')
      }

      setYoloMusicLyrics(srt)
      setYoloMusicTranscriptionStatus(`Transcribed ${result.cues.length} timed lyric line${result.cues.length === 1 ? '' : 's'} into SRT.`)
      addComfyLog('status', `Music video SRT generated from ${yoloMusicAudioAsset.name || 'song audio'}`)
    } catch (error) {
      const message = error?.message || 'Unknown transcription error'
      setFormError(`Could not transcribe song audio: ${message}`)
      setYoloMusicTranscriptionStatus('')
    } finally {
      setYoloMusicTranscribingSrt(false)
    }
  }, [
    addComfyLog,
    yoloMusicAudioAsset,
    yoloMusicLyrics,
    yoloMusicTranscribingSrt,
  ])
  // Resolved cast: hydrate each entry's assetId to a real image asset so the
  // planner can read label/slug/assetId uniformly. Entries with missing
  // assets are dropped (they show up as "unset" rows in the UI).
  const yoloMusicResolvedCast = useMemo(() => {
    if (!Array.isArray(yoloMusicCast)) return []
    return yoloMusicCast
      .map((entry) => {
        const asset = assets.find((a) => a?.id === entry?.assetId && a?.type === 'image') || null
        if (!asset) return null
        const slug = (entry?.slug && entry.slug.trim()) || normalizeCastSlug(entry?.label || '')
        const label = (entry?.label && entry.label.trim()) || slug || 'Artist'
        return {
          id: String(entry.id || asset.id),
          slug: slug || normalizeCastSlug(label),
          label,
          assetId: asset.id,
          role: entry?.role || 'lead',
        }
      })
      .filter(Boolean)
  }, [yoloMusicCast, assets])
  // Active alt-script derivation.
  //
  // `yoloMusicActiveScriptId === null` means the user is editing the master
  // script (yoloMusicScript). Any other id selects the matching alt script
  // from yoloMusicAltScripts. If the id references a slot that was deleted
  // out from under us (shouldn't normally happen, but persisted state +
  // code edits could race), we fall back to master silently rather than
  // error out.
  const yoloMusicActiveAltScript = useMemo(() => {
    if (!yoloMusicActiveScriptId) return null
    return yoloMusicAltScripts.find((entry) => entry.id === yoloMusicActiveScriptId) || null
  }, [yoloMusicActiveScriptId, yoloMusicAltScripts])
  const yoloMusicIsMasterActive = !yoloMusicActiveAltScript
  // Self-heal: if the selected id doesn't match any slot, snap back to
  // master so the textarea doesn't silently bind to a phantom entry.
  useEffect(() => {
    if (yoloMusicActiveScriptId && !yoloMusicActiveAltScript) {
      setYoloMusicActiveScriptId(null)
    }
  }, [yoloMusicActiveScriptId, yoloMusicActiveAltScript])
  /**
   * Live parse preview for every alt script, keyed by slot id.
   *
   * Each entry is one of:
   *   { state: 'empty' }
   *     — slot has no script text yet (user just created the tab and hasn't
   *       pasted the LLM output in).
   *   { state: 'unparsed', warnings }
   *     — script text exists but the parser could not produce a single shot.
   *       The user pasted something, but it doesn't conform to the shot
   *       grammar (probably an LLM that ignored the format spec).
   *   { state: 'ok' | 'warning', shotCount, totalLengthSec, coverageGaps, warnings, scenes }
   *     — parsed cleanly. 'warning' whenever the planner flagged issues
   *       (unresolved artist, SRT drift, overlap, etc.).
   *
   * Cast is intentionally set to [] for alt scripts because b-roll passes
   * omit Artist fields entirely and alt performance passes use the same
   * cast as the master (warnings about unresolved names would be noise
   * on a b-roll pass). This means alt plans won't carry identity refs —
   * that's the right default until we wire alt passes into generation.
   *
   * Pure-derived state — no mutation. Recomputing on every script edit is
   * fine because the parser is synchronous and the alt script count stays
   * small in practice.
   */
  const yoloMusicAltParseResults = useMemo(() => {
    const out = {}
    for (const alt of yoloMusicAltScripts) {
      const script = String(alt?.script || '').trim()
      if (!script) {
        out[alt.id] = { state: 'empty' }
        continue
      }
      const { scenes, warnings } = buildMusicVideoPlanFromScript({
        script,
        lyrics: yoloMusicLyrics,
        concept: yoloMusicConcept,
        styleNotes: yoloMusicStyleNotes,
        targetDuration: yoloMusicTargetDuration,
        songDurationSeconds: yoloMusicSongDurationSeconds,
        cast: [],
      })
      // Cast-resolution warnings are noise on alts (cast is empty by design).
      // Filter them here so the tab status dot + parse preview match what the
      // eventual Build Plan writes.
      const IRRELEVANT_KINDS_FOR_ALT = new Set(['unresolved-artist-override', 'too-many-artists'])
      const filteredWarnings = Array.isArray(warnings)
        ? warnings.filter((w) => !IRRELEVANT_KINDS_FOR_ALT.has(w?.kind))
        : []
      if (!Array.isArray(scenes) || scenes.length === 0) {
        out[alt.id] = { state: 'unparsed', warnings: filteredWarnings }
        continue
      }
      let shotCount = 0
      let totalLengthSec = 0
      const ranges = []
      for (const scene of scenes) {
        for (const shot of scene?.shots || []) {
          shotCount += 1
          const len = Number(shot?.durationSeconds ?? shot?.length ?? 0) || 0
          const start = Number(shot?.audioStart ?? 0) || 0
          totalLengthSec += len
          if (len > 0) ranges.push({ start, end: start + len })
        }
      }
      const coverageGaps = yoloMusicSongDurationSeconds > 0
        ? computeCoverageGaps(ranges, yoloMusicSongDurationSeconds, 0.5)
        : []
      const safeWarnings = filteredWarnings
      out[alt.id] = {
        state: safeWarnings.length > 0 ? 'warning' : 'ok',
        shotCount,
        totalLengthSec,
        coverageGaps,
        warnings: safeWarnings,
        scenes,
      }
    }
    return out
  }, [
    yoloMusicAltScripts,
    yoloMusicLyrics,
    yoloMusicConcept,
    yoloMusicStyleNotes,
    yoloMusicTargetDuration,
    yoloMusicSongDurationSeconds,
  ])
  const yoloMusicActiveAltParse = yoloMusicActiveAltScript
    ? yoloMusicAltParseResults[yoloMusicActiveAltScript.id] || { state: 'empty' }
    : null
  // One-time migration: if the user has a legacy single-artist selection but
  // no cast entries yet, seed the cast with that artist as a "lead" member
  // named "Artist". After that, the legacy field goes dormant and the cast
  // roster is the source of truth.
  const musicCastMigrationRanRef = useRef(false)
  useEffect(() => {
    if (musicCastMigrationRanRef.current) return
    if (assets.length === 0) return
    if (yoloMusicCast.length > 0) {
      musicCastMigrationRanRef.current = true
      return
    }
    if (!yoloMusicArtistAssetId) {
      musicCastMigrationRanRef.current = true
      return
    }
    const legacyAsset = assets.find((a) => a?.id === yoloMusicArtistAssetId && a?.type === 'image')
    if (!legacyAsset) {
      musicCastMigrationRanRef.current = true
      return
    }
    musicCastMigrationRanRef.current = true
    setYoloMusicCast([{
      id: `cast-${Date.now()}-seed`,
      slug: 'artist',
      label: 'Artist',
      assetId: yoloMusicArtistAssetId,
      role: 'lead',
    }])
  }, [assets, yoloMusicArtistAssetId, yoloMusicCast])
  const yoloAdReferenceStyleNotes = useMemo(() => buildAdReferenceStyleNotes({
    hasProduct: Boolean(yoloAdProductAsset),
    hasModel: Boolean(yoloAdModelAsset),
    productName: yoloAdProductAsset?.name || '',
    modelName: yoloAdModelAsset?.name || '',
    productDisplayName: yoloAdProductName,
    brandName: yoloAdBrandName,
    palette: yoloAdColorPalette,
    constraints: yoloAdLogoConstraints,
    spokespersonRole: yoloAdSpokespersonRole,
    wardrobeNotes: yoloAdWardrobeNotes,
    formatLabel: yoloSelectedAdFormatPreset?.label || '',
    platformLabel: yoloSelectedAdPlatformPreset?.label || '',
    consistency: yoloAdConsistency,
  }), [
    yoloAdConsistency,
    yoloAdProductName,
    yoloAdBrandName,
    yoloAdColorPalette,
    yoloAdLogoConstraints,
    yoloAdSpokespersonRole,
    yoloAdWardrobeNotes,
    yoloSelectedAdFormatPreset?.label,
    yoloSelectedAdPlatformPreset?.label,
    yoloAdModelAsset?.name,
    yoloAdProductAsset?.name,
    yoloAdModelAsset,
    yoloAdProductAsset,
  ])
  useEffect(() => {
    const cleaned = sanitizeDirectorStyleNotesInput(yoloStyleNotes)
    if (cleaned !== yoloStyleNotes) {
      setYoloStyleNotes(cleaned)
    }
  }, [yoloStyleNotes])
  const currentYoloAdPlanSignature = useMemo(() => createYoloPlanSignature({
    mode: 'ad',
    script: yoloScript,
    styleNotes: sanitizeDirectorStyleNotesInput(yoloStyleNotes),
    referenceStyleNotes: yoloAdReferenceStyleNotes,
    targetDuration: yoloTargetDuration,
    shotsPerScene: yoloShotsPerScene,
    anglesPerShot: yoloAnglesPerShot,
    takesPerAngle: yoloTakesPerAngle,
    productAssetId: yoloAdProductAsset?.id || '',
    modelAssetId: yoloAdModelAsset?.id || '',
    voiceoverAssetId: yoloAdVoiceoverAsset?.id || '',
    productName: yoloAdProductName,
    brandName: yoloAdBrandName,
    colorPalette: yoloAdColorPalette,
    logoConstraints: yoloAdLogoConstraints,
    spokespersonRole: yoloAdSpokespersonRole,
    wardrobeNotes: yoloAdWardrobeNotes,
    formatPreset: yoloAdFormatPreset,
    platformPreset: yoloAdPlatformPreset,
    consistency: yoloAdConsistency,
  }), [
    yoloAdConsistency,
    yoloAdProductAsset?.id,
    yoloAdModelAsset?.id,
    yoloAdVoiceoverAsset?.id,
    yoloAdProductName,
    yoloAdBrandName,
    yoloAdColorPalette,
    yoloAdLogoConstraints,
    yoloAdSpokespersonRole,
    yoloAdWardrobeNotes,
    yoloAdFormatPreset,
    yoloAdPlatformPreset,
    yoloAdReferenceStyleNotes,
    yoloAnglesPerShot,
    yoloScript,
    yoloShotsPerScene,
    yoloStyleNotes,
    yoloTakesPerAngle,
    yoloTargetDuration,
  ])
  /**
   * Build a music-mode plan signature for an arbitrary script/style-notes
   * pair. Used by:
   *   - `currentYoloMusicPlanSignature` (master)
   *   - Per-alt-slot signature comparisons (stale-plan detection)
   *   - `buildYoloMusicPlan` writing a fresh signature after build
   *
   * Both arguments fall back to current state, so callers that don't care
   * about overrides (e.g. master) can call `makeMusicPlanSignature()`.
   *
   * The signature includes castSignature and artistAssetId even though
   * alt passes intentionally omit cast from the planner — the inputs still
   * affect the generated plan-shape downstream (keyframe refs, variant
   * fan-out), so we want a rebuild prompt when those change.
   */
  const makeMusicPlanSignature = useCallback(({ script, concept, styleNotes } = {}) => createYoloPlanSignature({
    mode: 'music',
    audioAssetId: yoloMusicAudioAssetId || '',
    audioKind: yoloMusicAudioKind,
    // Legacy field kept in the signature only for migration continuity. Once
    // the cast is populated the planner ignores it, but including it here
    // ensures "I just converted my legacy artist to cast[0]" still invalidates
    // the cached plan and prompts a rebuild.
    artistAssetId: yoloMusicArtistAssetId || '',
    castSignature: yoloMusicResolvedCast
      .map((c) => `${c.slug}:${c.assetId}:${c.role || ''}`)
      .join('|'),
    lyrics: yoloMusicLyrics,
    script: String(script ?? yoloMusicScript),
    concept: String(concept ?? yoloMusicConcept),
    styleNotes: String(styleNotes ?? yoloMusicStyleNotes),
    targetDuration: yoloMusicTargetDuration,
    qualityProfile: yoloMusicQualityProfile,
  }), [
    yoloMusicAudioAssetId,
    yoloMusicAudioKind,
    yoloMusicArtistAssetId,
    yoloMusicConcept,
    yoloMusicLyrics,
    yoloMusicQualityProfile,
    yoloMusicResolvedCast,
    yoloMusicScript,
    yoloMusicStyleNotes,
    yoloMusicTargetDuration,
  ])
  const currentYoloMusicPlanSignature = useMemo(
    () => makeMusicPlanSignature({ script: yoloMusicScript }),
    [makeMusicPlanSignature, yoloMusicScript]
  )
  const yoloAdPlanIsStale = yoloPlan.length > 0 && yoloPlanSignature !== currentYoloAdPlanSignature
  const yoloMusicPlanIsStale = yoloMusicPlan.length > 0 && yoloMusicPlanSignature !== currentYoloMusicPlanSignature
  // Per-alt-slot staleness: a slot's plan is stale if it was built (plan.length > 0)
  // AND its persisted signature disagrees with a freshly-computed signature of its
  // current script. Keyed by slot id so the tab strip + stale-plan banner can read it.
  const yoloMusicAltPlanStaleness = useMemo(() => {
    const out = {}
    for (const alt of yoloMusicAltScripts) {
      const plan = Array.isArray(alt.plan) ? alt.plan : []
      if (plan.length === 0) {
        out[alt.id] = false
        continue
      }
      const currentSig = makeMusicPlanSignature({ script: alt.script })
      out[alt.id] = (alt.planSignature || '') !== currentSig
    }
    return out
  }, [yoloMusicAltScripts, makeMusicPlanSignature])
  const yoloMusicActiveTargetPlanIsStale = yoloMusicActiveScriptId
    ? Boolean(yoloMusicAltPlanStaleness[yoloMusicActiveScriptId])
    : yoloMusicPlanIsStale
  const yoloActivePlanIsStale = isYoloMusicMode ? yoloMusicActiveTargetPlanIsStale : yoloAdPlanIsStale
  // Active-target planner warnings: master warnings live in yoloMusicPlanWarnings,
  // alt-target warnings live on the slot itself. The UI consumer reads this
  // derived value so a single panel works for both.
  const yoloMusicActiveTargetPlanWarnings = useMemo(() => {
    if (!yoloMusicActiveScriptId) return yoloMusicPlanWarnings
    const slot = yoloMusicAltScripts.find((entry) => entry.id === yoloMusicActiveScriptId)
    return Array.isArray(slot?.planWarnings) ? slot.planWarnings : []
  }, [yoloMusicActiveScriptId, yoloMusicAltScripts, yoloMusicPlanWarnings])
  /**
   * Render the pass-switcher tab strip — Master + one chip per alt script,
   * each with badge, label, and a parse-status dot.
   *
   * Used in two places:
   *   - Script step (above the textarea) — always visible in the full form
   *   - Keyframes/Videos step banner — compact form so users can pivot
   *     between passes without bouncing back to the Script step
   *
   * `variant: 'full'` = Script-step chrome (larger click targets).
   * `variant: 'compact'` = banner chrome (smaller, fits on the banner row).
   *
   * Exposed as a plain function instead of a component so both render sites
   * can inline it cleanly without prop/children plumbing; closures over
   * state keep this cheap.
   */
  const renderPassTabStrip = (variant = 'full') => {
    const isCompact = variant === 'compact'
    const basePad = isCompact ? 'px-1.5 py-0.5' : 'px-2 py-1'
    const baseText = 'text-[10px]'
    const badgeSize = isCompact ? 'px-[5px] text-[8px]' : 'px-1 text-[8px]'
    const labelMax = isCompact ? 'max-w-[8rem]' : 'max-w-[12rem]'
    return (
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => setYoloMusicActiveScriptId(null)}
          className={`${basePad} ${baseText} rounded transition-colors ${
            yoloMusicIsMasterActive
              ? 'bg-sf-accent text-white'
              : 'bg-sf-dark-700 text-sf-text-secondary hover:text-sf-text-primary hover:bg-sf-dark-600'
          }`}
          title="The backbone performance script. Alt passes inherit its timings."
        >
          Master
        </button>
        {yoloMusicAltScripts.map((alt) => {
          const isActive = yoloMusicActiveScriptId === alt.id
          const badge = getMusicVideoPassBadge(alt.passType)
          const parse = yoloMusicAltParseResults[alt.id] || { state: 'empty' }
          const dotClass = (() => {
            switch (parse.state) {
              case 'ok':       return 'bg-emerald-400'
              case 'warning':  return 'bg-yellow-400'
              case 'unparsed': return 'bg-red-400'
              case 'empty':    return 'bg-sf-dark-500'
              default:         return 'bg-sf-dark-500'
            }
          })()
          const dotTitle = (() => {
            switch (parse.state) {
              case 'ok':       return `Parses cleanly · ${parse.shotCount} shots`
              case 'warning':  return `Parses with ${parse.warnings.length} warning${parse.warnings.length === 1 ? '' : 's'}`
              case 'unparsed': return 'Script pasted but could not be parsed — check the shot grammar.'
              case 'empty':    return 'Empty — paste the LLM output into the textarea to parse.'
              default:         return ''
            }
          })()
          return (
            <button
              key={alt.id}
              type="button"
              onClick={() => setYoloMusicActiveScriptId(alt.id)}
              className={`${basePad} ${baseText} rounded transition-colors flex items-center gap-1.5 ${
                isActive
                  ? 'bg-sf-accent text-white'
                  : 'bg-sf-dark-700 text-sf-text-secondary hover:text-sf-text-primary hover:bg-sf-dark-600'
              }`}
              title={`${getMusicVideoPassDisplayName(alt.passType)}${alt.variantDescriptor ? `: ${alt.variantDescriptor}` : ''}`}
            >
              <span className={`${badgeSize} py-0 rounded font-bold tracking-wider ${isActive ? 'bg-white/20' : 'bg-sf-dark-900/60'}`}>
                {badge}
              </span>
              <span className={`truncate ${labelMax}`}>{alt.label}</span>
              <span
                className={`h-1.5 w-1.5 rounded-full ${dotClass}`}
                title={dotTitle}
                aria-label={dotTitle}
              />
            </button>
          )
        })}
      </div>
    )
  }
  const yoloQueueNameLabel = useMemo(() => {
    if (isYoloMusicMode) {
      // Pull a human-friendly label from the selected audio asset name first,
      // then the concept/style-notes as fallbacks. Avoids blanks in the job
      // list when the user hasn't named anything.
      const audioAsset = assets.find((asset) => asset?.id === yoloMusicAudioAssetId) || null
      return (
        stripFileExtension(audioAsset?.name || '').trim()
        || String(yoloMusicConcept || '').trim()
        || summarizeSceneText(yoloMusicStyleNotes, 'music video')
      )
    }

    const anchorLabel = [yoloAdProductAsset?.name, yoloAdModelAsset?.name]
      .map((name) => stripFileExtension(name))
      .map((name) => String(name || '').trim())
      .filter(Boolean)
      .join(' ')

    return anchorLabel || summarizeSceneText(yoloScript, 'director ad')
  }, [
    assets,
    isYoloMusicMode,
    yoloAdModelAsset?.name,
    yoloAdProductAsset?.name,
    yoloMusicAudioAssetId,
    yoloMusicConcept,
    yoloMusicStyleNotes,
    yoloScript,
  ])

  const normalizeYoloAdSource = (value) => (
    String(value || '').trim().toLowerCase() === 'cloud' ? 'cloud' : 'local'
  )
  const normalizeYoloAdTier = (value) => {
    const normalized = String(value || '').trim().toLowerCase()
    if (normalized === 'low' || normalized === 'quality') return normalized
    if (normalized === 'draft') return 'low'
    if (normalized === 'balanced' || normalized === 'premium') return 'quality'
    return 'low'
  }
  const yoloAdRuntimeOptions = YOLO_AD_PROFILE_RUNTIME_OPTIONS
  const yoloNormalizedAdStoryboardTier = normalizeYoloAdTier(yoloAdStoryboardTier)
  const yoloNormalizedAdVideoTier = normalizeYoloAdTier(yoloAdVideoTier)
  const yoloStoryboardProfileRuntime = !isYoloMusicMode
    ? normalizeYoloAdSource(yoloAdStoryboardSource)
    : null
  const yoloVideoProfileRuntime = !isYoloMusicMode
    ? normalizeYoloAdSource(yoloAdVideoSource)
    : null
  const yoloStoryboardUsesCloudTier = !isYoloMusicMode && yoloStoryboardProfileRuntime === 'cloud'
  const yoloVideoUsesCloudTier = !isYoloMusicMode && yoloVideoProfileRuntime === 'cloud'
  const yoloStoryboardProfileRuntimeMeta = !isYoloMusicMode
    ? (yoloAdRuntimeOptions.find((runtime) => runtime.id === yoloStoryboardProfileRuntime) || null)
    : null
  const yoloVideoProfileRuntimeMeta = !isYoloMusicMode
    ? (yoloAdRuntimeOptions.find((runtime) => runtime.id === yoloVideoProfileRuntime) || null)
    : null
  const yoloStoryboardTierOptions = !isYoloMusicMode
    ? (YOLO_AD_STAGE_TIER_OPTIONS[yoloStoryboardProfileRuntime] || YOLO_AD_STAGE_TIER_OPTIONS.local)
    : []
  const yoloVideoTierOptions = !isYoloMusicMode
    ? (YOLO_AD_STAGE_TIER_OPTIONS[yoloVideoProfileRuntime] || YOLO_AD_STAGE_TIER_OPTIONS.local)
    : []
  const yoloSelectedStoryboardTierMeta = !isYoloMusicMode
    ? (yoloStoryboardTierOptions.find((option) => option.id === yoloNormalizedAdStoryboardTier) || null)
    : null
  const yoloSelectedVideoTierMeta = !isYoloMusicMode
    ? (yoloVideoTierOptions.find((option) => option.id === yoloNormalizedAdVideoTier) || null)
    : null
  const yoloAdStoryboardProfilesForRuntime = (
    !isYoloMusicMode
      ? (YOLO_AD_PROFILES[yoloStoryboardProfileRuntime] || YOLO_AD_PROFILES.local)
      : YOLO_AD_PROFILES.local
  )
  const yoloAdVideoProfilesForRuntime = (
    !isYoloMusicMode
      ? (YOLO_AD_PROFILES[yoloVideoProfileRuntime] || YOLO_AD_PROFILES.local)
      : YOLO_AD_PROFILES.local
  )
  const yoloMusicProfile = YOLO_MUSIC_PROFILES[yoloMusicQualityProfile] || YOLO_MUSIC_PROFILES.balanced
  const yoloAdStoryboardProfile = (
    yoloAdStoryboardProfilesForRuntime[yoloNormalizedAdStoryboardTier]
    || yoloAdStoryboardProfilesForRuntime.quality
    || yoloAdStoryboardProfilesForRuntime.low
    || {}
  )
  const yoloAdVideoProfile = (
    yoloAdVideoProfilesForRuntime[yoloNormalizedAdVideoTier]
    || yoloAdVideoProfilesForRuntime.quality
    || yoloAdVideoProfilesForRuntime.low
    || {}
  )
  const yoloAdSelectedLocalVideoWorkflow = useMemo(
    () => YOLO_AD_LOCAL_VIDEO_WORKFLOW_OPTIONS.find((option) => option.id === yoloAdLocalVideoWorkflowId) || YOLO_AD_LOCAL_VIDEO_WORKFLOW_OPTIONS[0],
    [yoloAdLocalVideoWorkflowId]
  )
  const yoloMusicSelectedVideoWorkflow = useMemo(() => {
    const saved = YOLO_MUSIC_VIDEO_WORKFLOW_OPTIONS.find((option) => option.id === yoloMusicVideoWorkflowId)
    if (saved) return saved
    const profileDefault = YOLO_MUSIC_VIDEO_WORKFLOW_OPTIONS.find((option) => option.id === yoloMusicProfile?.videoWorkflowId)
    return profileDefault || YOLO_MUSIC_VIDEO_WORKFLOW_OPTIONS[0]
  }, [yoloMusicProfile?.videoWorkflowId, yoloMusicVideoWorkflowId])
  const yoloStoryboardWorkflowId = String(
    isYoloMusicMode
      ? yoloMusicKeyframeWorkflowId || yoloMusicProfile?.storyboardWorkflowId
      : yoloAdStoryboardProfile?.storyboardWorkflowId
  ).trim()
  const yoloDefaultVideoWorkflowId = String(
    isYoloMusicMode
      ? yoloMusicSelectedVideoWorkflow?.id
      : yoloVideoProfileRuntime === 'local'
        ? yoloAdSelectedLocalVideoWorkflow?.id
        : yoloAdVideoProfile?.videoWorkflowId
  ).trim()
  const yoloStoryboardSupportsReferenceAnchors = useMemo(() => (
    ['image-edit', 'nano-banana-2', 'nano-banana-pro', 'image-edit-model-product', 'seedream-5-lite-image-edit'].includes(String(yoloStoryboardWorkflowId || '').trim())
  ), [yoloStoryboardWorkflowId])
  const yoloSelectedVideoWorkflowIds = useMemo(
    () => (yoloDefaultVideoWorkflowId ? [yoloDefaultVideoWorkflowId] : []),
    [yoloDefaultVideoWorkflowId]
  )
  const imageResolutionOptions = useMemo(() => {
    switch (String(workflowId || '').trim()) {
      case 'z-image-turbo':
        return IMAGE_RESOLUTION_PRESET_GROUPS.enhanced
      case 'nano-banana-2':
      case 'nano-banana-pro':
      case 'grok-text-to-image':
        return IMAGE_RESOLUTION_PRESET_GROUPS.enhanced
      case 'gpt-image-2-t2i':
      case 'gpt-image-2-edit':
        return IMAGE_RESOLUTION_PRESET_GROUPS.gptImage2
      default:
        return []
    }
  }, [workflowId])
  const imageResolutionControlVisible = category === 'image' && imageResolutionOptions.length > 0
  const seedreamUsesInputResolution = workflowId === 'seedream-5-lite-image-edit'
  const selectedImageResolutionValue = useMemo(() => (
    `${imageResolution.width}x${imageResolution.height}`
  ), [imageResolution])
  const selectedAssetNativeResolution = useMemo(() => {
    const width = Number(selectedAsset?.settings?.width ?? selectedAsset?.width)
    const height = Number(selectedAsset?.settings?.height ?? selectedAsset?.height)
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null
    return { width, height }
  }, [selectedAsset])
  const effectiveImageResolution = useMemo(() => {
    if (seedreamUsesInputResolution && selectedAssetNativeResolution) {
      return selectedAssetNativeResolution
    }
    return imageResolution
  }, [imageResolution, seedreamUsesInputResolution, selectedAssetNativeResolution])
  const currentOutputResolution = useMemo(
    () => (category === 'image' ? effectiveImageResolution : resolution),
    [category, effectiveImageResolution, resolution]
  )
  const imageResolutionHelperText = useMemo(() => {
    switch (String(workflowId || '').trim()) {
      case 'z-image-turbo':
        return 'Local render sizes. Square 2K (2048x2048) uses significantly more VRAM.'
      case 'nano-banana-2':
      case 'nano-banana-pro':
      case 'grok-text-to-image':
        return 'These map to provider aspect ratio plus a 1K or 2K render tier.'
      case 'gpt-image-2-t2i':
      case 'gpt-image-2-edit':
        return 'GPT Image 2 only supports a strict size list; unsupported sizes are auto-mapped.'
      default:
        return ''
    }
  }, [workflowId])
  const yoloSelectedVideoWorkflowSupportsCustomFps = useMemo(() => {
    // Local workflows that honor a user-supplied FPS in their
    // modify*Workflow() helpers. Cloud partner-node workflows ignore
    // it (the provider returns its own FPS) so they stay excluded.
    const customFpsWorkflowIds = new Set(['wan22-i2v', 'ltx23-i2v', MUSIC_VIDEO_SHOT_WORKFLOW_ID])
    return yoloSelectedVideoWorkflowIds.some((id) => customFpsWorkflowIds.has(String(id || '').trim()))
  }, [yoloSelectedVideoWorkflowIds])
  const yoloSelectedVideoWorkflowLabel = useMemo(
    () => yoloSelectedVideoWorkflowIds.map(getWorkflowDisplayLabel).join(' + '),
    [yoloSelectedVideoWorkflowIds]
  )
  const currentWorkflowTierMeta = useMemo(
    () => getWorkflowTierMeta(workflowId),
    [workflowId]
  )
  const currentWorkflowRuntime = useMemo(
    () => getWorkflowHardwareInfo(workflowId)?.runtime || '',
    [workflowId]
  )
  const currentWorkflowRuntimeLabel = useMemo(
    () => formatWorkflowHardwareRuntime(workflowId),
    [workflowId]
  )
  const currentWorkflowUsesCloud = currentWorkflowRuntime === 'cloud'
  const yoloStoryboardTierSummary = useMemo(
    () => formatWorkflowTierSummary(yoloStoryboardWorkflowId),
    [yoloStoryboardWorkflowId]
  )
  const yoloVideoTargetTierSummary = useMemo(
    () => yoloSelectedVideoWorkflowIds.map((id) => formatWorkflowTierSummary(id)).join(' + '),
    [yoloSelectedVideoWorkflowIds]
  )
  const yoloSelectedAdStageRouting = useMemo(() => {
    if (isYoloMusicMode) return null
    const imageWorkflowId = String(yoloAdStoryboardProfile?.storyboardWorkflowId || '').trim()
    const videoWorkflowId = String(yoloDefaultVideoWorkflowId || yoloAdVideoProfile?.videoWorkflowId || '').trim()
    const imageLabel = imageWorkflowId === 'image-edit-model-product'
      ? 'Qwen Image Edit 2509'
      : imageWorkflowId === 'nano-banana-2'
        ? 'Nano Banana 2'
        : getWorkflowDisplayLabel(imageWorkflowId)
    const videoLabel = videoWorkflowId === 'kling-o3-i2v'
      ? 'Kling 3.0'
      : getWorkflowDisplayLabel(videoWorkflowId)
    return {
      imageWorkflowId,
      videoWorkflowId,
      imageLabel,
      videoLabel,
      storyboardSourceLabel: yoloStoryboardProfileRuntimeMeta?.label || yoloStoryboardProfileRuntime,
      videoSourceLabel: yoloVideoProfileRuntimeMeta?.label || yoloVideoProfileRuntime,
      storyboardTierLabel: yoloSelectedStoryboardTierMeta?.label || yoloNormalizedAdStoryboardTier,
      videoTierLabel: yoloSelectedVideoTierMeta?.label || yoloNormalizedAdVideoTier,
    }
  }, [
    isYoloMusicMode,
    yoloAdStoryboardProfile,
    yoloAdVideoProfile,
    yoloDefaultVideoWorkflowId,
    yoloStoryboardProfileRuntimeMeta,
    yoloStoryboardProfileRuntime,
    yoloVideoProfileRuntimeMeta,
    yoloVideoProfileRuntime,
    yoloSelectedStoryboardTierMeta,
    yoloNormalizedAdStoryboardTier,
    yoloSelectedVideoTierMeta,
    yoloNormalizedAdVideoTier,
  ])
  const yoloDependencyWorkflowIds = useMemo(() => Array.from(new Set([
    yoloStoryboardWorkflowId,
    ...yoloSelectedVideoWorkflowIds,
  ].map((workflow) => String(workflow || '').trim()).filter(Boolean))), [
    yoloStoryboardWorkflowId,
    yoloSelectedVideoWorkflowIds,
  ])

  const runYoloDependencySnapshotCheck = useCallback(async () => {
    const requestVersion = yoloDependencyPanelVersionRef.current + 1
    yoloDependencyPanelVersionRef.current = requestVersion

    if (generationMode !== 'yolo') {
      setYoloDependencyPanel({
        status: 'idle',
        byWorkflow: {},
        checkedAt: Date.now(),
        error: '',
      })
      return null
    }

    if (!isConnected) {
      setYoloDependencyPanel((prev) => ({
        ...prev,
        status: 'offline',
        checkedAt: Date.now(),
        error: '',
      }))
      return null
    }

    if (yoloDependencyWorkflowIds.length === 0) {
      setYoloDependencyPanel({
        status: 'idle',
        byWorkflow: {},
        checkedAt: Date.now(),
        error: '',
      })
      return null
    }

    setYoloDependencyPanel((prev) => ({
      ...prev,
      status: 'checking',
      checkedAt: Date.now(),
      error: '',
    }))

    try {
      const results = await Promise.all(yoloDependencyWorkflowIds.map((workflow) => checkWorkflowDependencies(workflow)))
      if (yoloDependencyPanelVersionRef.current !== requestVersion) return null

      setYoloDependencyPanel({
        status: getDependencyAggregateStatus(results),
        byWorkflow: buildDependencyResultMap(results),
        checkedAt: Date.now(),
        error: '',
      })
      return results
    } catch (error) {
      if (yoloDependencyPanelVersionRef.current !== requestVersion) return null
      setYoloDependencyPanel((prev) => ({
        ...prev,
        status: 'error',
        checkedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error || 'Dependency check failed'),
      }))
      return null
    }
  }, [generationMode, isConnected, yoloDependencyWorkflowIds])

  useEffect(() => {
    void runYoloDependencySnapshotCheck()
  }, [runYoloDependencySnapshotCheck])

  const yoloSceneCount = yoloActivePlan.length
  const yoloVariants = useMemo(() => flattenYoloPlanVariants(yoloActivePlan), [yoloActivePlan])
  const yoloQueueVariants = yoloVariants
  const yoloAdNativeTextEntries = useMemo(() => {
    if (isYoloMusicMode || !Array.isArray(yoloPlan) || yoloPlan.length === 0) return []
    const entries = []
    let cursor = 0
    for (const scene of yoloPlan) {
      for (const shot of scene?.shots || []) {
        const durationSeconds = Math.max(0.5, Number(shot?.durationSeconds) || 3)
        const textOverlay = String(shot?.textOverlay || '').trim()
        const endCard = String(shot?.endCard || '').trim()
        const adBeat = String(shot?.adBeat || '').trim().toLowerCase()
        if (textOverlay) {
          entries.push({
            kind: 'overlay',
            text: textOverlay,
            startTime: cursor + Math.min(0.25, durationSeconds * 0.12),
            duration: Math.max(1.2, durationSeconds - 0.35),
            sceneId: scene.id,
            shotId: shot.id,
          })
        }
        if (endCard || adBeat.includes('end')) {
          const endCardText = [
            yoloAdBrandName || 'Brand',
            yoloAdProductName,
            endCard || 'Call to action',
          ].filter(Boolean).join('\n')
          entries.push({
            kind: 'end-card',
            text: endCardText,
            startTime: cursor,
            duration: Math.max(1.5, durationSeconds),
            sceneId: scene.id,
            shotId: shot.id,
          })
        }
        cursor += durationSeconds
      }
    }
    return entries
  }, [isYoloMusicMode, yoloAdBrandName, yoloAdProductName, yoloPlan])
  const yoloStoryboardAssetMap = useMemo(() => {
    const map = new Map()
    for (const asset of assets) {
      const key = asset?.yolo?.key
      if (!key || asset?.yolo?.stage !== 'storyboard' || asset?.type !== 'image') continue
      const assetMode = asset?.yolo?.mode
      const modeMatches = yoloModeKey === 'music'
        ? assetMode === 'music'
        : assetMode !== 'music'
      if (!modeMatches) continue
      const existing = map.get(key)
      const assetTime = new Date(asset.createdAt || 0).getTime()
      const existingTime = existing ? new Date(existing.createdAt || 0).getTime() : -1
      if (!existing || assetTime >= existingTime) {
        map.set(key, asset)
      }
    }
    return map
  }, [assets, yoloModeKey])
  const yoloStoryboardReadyCount = useMemo(
    () => yoloQueueVariants.filter((variant) => yoloStoryboardAssetMap.has(variant.key)).length,
    [yoloQueueVariants, yoloStoryboardAssetMap]
  )
  const yoloCloudCreditRows = useMemo(() => {
    const rows = []
    const keyframeRunCount = yoloQueueVariants.length
    const keyframeWorkflowId = String(yoloStoryboardWorkflowId || '').trim()
    if (keyframeWorkflowId) {
      const keyframeCheck = yoloDependencyPanel.byWorkflow?.[keyframeWorkflowId] || null
      const keyframeRuntime = getWorkflowHardwareInfo(keyframeWorkflowId)?.runtime || ''
      rows.push({
        id: `keyframes:${keyframeWorkflowId}`,
        stageLabel: 'Keyframes',
        workflowId: keyframeWorkflowId,
        workflowLabel: getWorkflowDisplayLabel(keyframeWorkflowId),
        runCount: keyframeRunCount,
        isCloud: keyframeRuntime === 'cloud',
        estimatedCredits: keyframeCheck?.estimatedCredits || null,
        hasPriceMetadata: Boolean(keyframeCheck?.hasPriceMetadata),
      })
    }

    yoloSelectedVideoWorkflowIds.forEach((videoWorkflowId, index) => {
      const normalized = String(videoWorkflowId || '').trim()
      if (!normalized) return
      const videoCheck = yoloDependencyPanel.byWorkflow?.[normalized] || null
      const videoRuntime = getWorkflowHardwareInfo(normalized)?.runtime || ''
      rows.push({
        id: `video:${normalized}:${index}`,
        stageLabel: yoloSelectedVideoWorkflowIds.length > 1 ? `Video ${index + 1}` : 'Video',
        workflowId: normalized,
        workflowLabel: getWorkflowDisplayLabel(normalized),
        runCount: yoloQueueVariants.length,
        isCloud: videoRuntime === 'cloud',
        estimatedCredits: videoCheck?.estimatedCredits || null,
        hasPriceMetadata: Boolean(videoCheck?.hasPriceMetadata),
      })
    })
    return rows
  }, [
    yoloDependencyPanel.byWorkflow,
    yoloQueueVariants.length,
    yoloSelectedVideoWorkflowIds,
    yoloStoryboardWorkflowId,
  ])
  const yoloCloudCreditProjection = useMemo(() => {
    let minTotal = 0
    let maxTotal = 0
    let hasAnyCloudRows = false
    let hasKnownCloudEstimates = false
    let hasUnknownCloudEstimates = false

    for (const row of yoloCloudCreditRows) {
      if (!row?.isCloud) continue
      hasAnyCloudRows = true
      const estimate = row?.estimatedCredits
      const runCount = Math.max(0, Number(row?.runCount) || 0)
      const min = Number(estimate?.min)
      const max = Number(estimate?.max)
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        hasUnknownCloudEstimates = true
        continue
      }
      hasKnownCloudEstimates = true
      minTotal += min * runCount
      maxTotal += max * runCount
    }

    return {
      hasAnyCloudRows,
      hasKnownCloudEstimates,
      hasUnknownCloudEstimates,
      minTotal,
      maxTotal,
    }
  }, [yoloCloudCreditRows])
  const yoloSubTabMeta = useMemo(
    () => DIRECTOR_SUBTABS.find((tab) => tab.id === directorSubTab) || DIRECTOR_SUBTABS[0],
    [directorSubTab]
  )
  const yoloSubTabHelperText = yoloSubTabMeta?.helper || ''
  const yoloSubTabTitle = yoloSubTabMeta?.label || ''
  const isYoloStillsStep = directorSubTab === 'scene-shot'
  const isYoloVideoStep = directorSubTab === 'video-pass'
  const yoloSceneStats = useMemo(() => {
    const stats = new Map()
    for (const scene of yoloActivePlan || []) {
      stats.set(scene.id, {
        shotCount: Array.isArray(scene?.shots) ? scene.shots.length : 0,
        variantCount: 0,
        readyCount: 0,
      })
    }
    for (const variant of yoloQueueVariants || []) {
      const id = variant?.sceneId
      if (!id) continue
      const current = stats.get(id) || { shotCount: 0, variantCount: 0, readyCount: 0 }
      current.variantCount += 1
      if (yoloStoryboardAssetMap.has(variant.key)) current.readyCount += 1
      stats.set(id, current)
    }
    return stats
  }, [yoloActivePlan, yoloQueueVariants, yoloStoryboardAssetMap])
  const [selectedYoloSceneId, setSelectedYoloSceneId] = useState(null)
  useEffect(() => {
    if (!Array.isArray(yoloActivePlan) || yoloActivePlan.length === 0) {
      if (selectedYoloSceneId !== null) setSelectedYoloSceneId(null)
      return
    }
    const hasSelection = yoloActivePlan.some((scene) => scene.id === selectedYoloSceneId)
    if (!hasSelection) {
      setSelectedYoloSceneId(yoloActivePlan[0].id)
    }
  }, [selectedYoloSceneId, yoloActivePlan])
  const selectedYoloSceneIndex = useMemo(
    () => yoloActivePlan.findIndex((scene) => scene.id === selectedYoloSceneId),
    [selectedYoloSceneId, yoloActivePlan]
  )
  const selectedYoloScene = useMemo(
    () => (selectedYoloSceneIndex >= 0 ? yoloActivePlan[selectedYoloSceneIndex] : null),
    [selectedYoloSceneIndex, yoloActivePlan]
  )
  useEffect(() => {
    if (generationMode !== 'yolo') return
    if ((directorSubTab === 'scene-shot' || directorSubTab === 'video-pass') && !yoloCanEditScenes) {
      setDirectorSubTab('plan-script')
    }
  }, [directorSubTab, generationMode, yoloCanEditScenes])
  const assetNameById = useMemo(() => {
    const map = new Map()
    for (const asset of assets || []) {
      if (asset?.id) map.set(asset.id, asset.name || String(asset.id))
    }
    return map
  }, [assets])

  const queuedJobs = useMemo(
    () => generationQueue.filter(j => j.status === 'queued'),
    [generationQueue]
  )
  const activeJobs = useMemo(
    () => generationQueue.filter(j => ACTIVE_JOB_STATUSES.includes(j.status)),
    [generationQueue]
  )
  const hasJobs = generationQueue.length > 0
  const queuedCount = queuedJobs.length
  const activeCount = activeJobs.length

  useEffect(() => {
    if (!imageResolutionControlVisible) return
    const hasMatchingPreset = imageResolutionOptions.some((option) => (
      option.width === imageResolution.width && option.height === imageResolution.height
    ))
    if (!hasMatchingPreset && imageResolutionOptions[0]) {
      setImageResolution({
        width: imageResolutionOptions[0].width,
        height: imageResolutionOptions[0].height,
      })
    }
  }, [imageResolution, imageResolutionControlVisible, imageResolutionOptions])

  // Calculate aspect ratio mismatch warning (only for workflows that use an input image)
  const aspectRatioWarning = useMemo(() => {
    if (!currentWorkflow?.needsImage) return null
    if (!selectedAsset || !selectedAsset.settings) return null
    
    const inputWidth = selectedAsset.settings.width || selectedAsset.width
    const inputHeight = selectedAsset.settings.height || selectedAsset.height
    
    if (!inputWidth || !inputHeight) return null
    
    const inputAspect = inputWidth / inputHeight
    const outputAspect = currentOutputResolution.width / currentOutputResolution.height
    const aspectDiff = Math.abs(inputAspect - outputAspect)
    
    // Warn if aspect ratio differs by more than 5%
    if (aspectDiff > 0.05) {
      const inputLabel = inputAspect > 1 ? 'landscape' : inputAspect < 1 ? 'portrait' : 'square'
      const outputLabel = outputAspect > 1 ? 'landscape' : outputAspect < 1 ? 'portrait' : 'square'
      
      return {
        inputAspect: inputAspect.toFixed(2),
        outputAspect: outputAspect.toFixed(2),
        inputLabel,
        outputLabel,
        inputResolution: `${inputWidth}x${inputHeight}`,
        outputResolution: `${currentOutputResolution.width}x${currentOutputResolution.height}`,
      }
    }
    
    return null
  }, [currentOutputResolution, currentWorkflow?.needsImage, selectedAsset])

  // ============================================
  // Generation queue + handler
  // ============================================
  const updateJob = useCallback((jobId, updater) => {
    setGenerationQueue(prev => prev.map(job => {
      if (job.id !== jobId) return job
      const updates = typeof updater === 'function' ? updater(job) : updater
      return { ...job, ...updates }
    }))
  }, [])

  const updateJobByPromptId = useCallback((promptId, updater) => {
    if (!promptId) return
    setGenerationQueue(prev => prev.map(job => {
      if (job.promptId !== promptId) return job
      const updates = typeof updater === 'function' ? updater(job) : updater
      return { ...job, ...updates }
    }))
  }, [])

  // Listen for ComfyUI progress events and map to jobs
  useEffect(() => {
    const handleProgress = (data) => {
      if (!data?.promptId) return
      const percent = data.max > 0 ? Math.round((data.value / data.max) * 100) : 0
      updateJobByPromptId(data.promptId, (job) => {
        if (job.status === 'done' || job.status === 'error') return job
        return {
          ...job,
          status: job.status === 'queued' ? 'running' : job.status,
          progress: Math.min(99, Math.max(job.progress || 0, percent))
        }
      })
    }

    const handleExecuting = (data) => {
      if (!data?.promptId) return
      updateJobByPromptId(data.promptId, { node: data.node })
    }

    const handleComplete = (data) => {
      if (!data?.promptId) return
      updateJobByPromptId(data.promptId, (job) => ({
        ...job,
        progress: Math.max(job.progress || 0, 100)
      }))
    }

    comfyui.on('progress', handleProgress)
    comfyui.on('executing', handleExecuting)
    comfyui.on('complete', handleComplete)

    return () => {
      comfyui.off('progress', handleProgress)
      comfyui.off('executing', handleExecuting)
      comfyui.off('complete', handleComplete)
    }
  }, [updateJobByPromptId])

  // ComfyUI activity log (executing, complete, status, errors) for troubleshooting
  const progressPercentRef = useRef({})
  useEffect(() => {
    const handleProgress = (data) => {
      if (!data?.promptId) return
      const pct = data.max > 0 ? Math.round((data.value / data.max) * 100) : 0
      const key = data.promptId
      const last = progressPercentRef.current[key]
      if (last === undefined || pct - last >= 10 || pct === 100) {
        progressPercentRef.current[key] = pct
        addComfyLog('progress', `Prompt ${String(data.promptId).slice(0, 8)}… ${pct}%`)
      }
    }
    const handleExecuting = (data) => {
      if (!data?.promptId) return
      addComfyLog('exec', data.node !== undefined ? `Executing node ${data.node}` : `Executing prompt ${String(data.promptId).slice(0, 8)}…`)
    }
    const handleExecuted = (data) => {
      if (data?.node !== undefined) addComfyLog('exec', `Executed node ${data.node}`)
    }
    const handleComplete = (data) => {
      if (data?.promptId) addComfyLog('ok', `Complete prompt ${String(data.promptId).slice(0, 8)}…`)
    }
    const handleStatus = (data) => {
      if (data?.execution_info?.queue_remaining !== undefined) {
        addComfyLog('status', `Queue: ${data.execution_info.queue_remaining} remaining`)
      }
    }
    comfyui.on('progress', handleProgress)
    comfyui.on('executing', handleExecuting)
    comfyui.on('executed', handleExecuted)
    comfyui.on('complete', handleComplete)
    comfyui.on('status', handleStatus)
    return () => {
      comfyui.off('progress', handleProgress)
      comfyui.off('executing', handleExecuting)
      comfyui.off('executed', handleExecuted)
      comfyui.off('complete', handleComplete)
      comfyui.off('status', handleStatus)
    }
  }, [addComfyLog])
  useEffect(() => {
    if (comfyLogExpanded && comfyLogEndRef.current) comfyLogEndRef.current.scrollIntoView({ behavior: 'smooth' })
  }, [comfyLogExpanded, comfyLogLines])

  const openStoryboardPdfPreview = useCallback((pdfUrl) => {
    if (!pdfUrl || typeof window === 'undefined') return
    try {
      window.open(pdfUrl, '_blank', 'noopener,noreferrer')
    } catch (_) {
      // Ignore popup/open failures.
    }
  }, [])

  const exportStoryboardPdfBatch = useCallback(async (batch) => {
    if (!batch || !currentProjectHandle) return null
    const items = Array.isArray(batch.items) ? batch.items : []
    if (items.length === 0) return null

    const sortedItems = [...items].sort((a, b) => {
      const sequenceDiff = (Number(a.sequence) || 0) - (Number(b.sequence) || 0)
      if (sequenceDiff !== 0) return sequenceDiff
      return (Number(a.itemIndex) || 0) - (Number(b.itemIndex) || 0)
    })

    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter', compress: true })
    const pageWidth = doc.internal.pageSize.getWidth()
    const pageHeight = doc.internal.pageSize.getHeight()
    const margin = 32
    const headerHeight = 52
    const colGap = 18
    // Landscape layout tuned for 6 keyframe images per page (3 columns x 2 rows).
    const rowGap = 12
    const columns = 3
    const cardWidth = (pageWidth - (margin * 2) - (colGap * (columns - 1))) / columns
    const imageHeight = Math.round(cardWidth * (9 / 16))
    const labelHeight = 14
    const promptHeight = 36
    const cardHeight = imageHeight + labelHeight + promptHeight + 10
    const maxPromptLines = 3
    // Render each keyframe image at higher raster DPI to avoid pixelation in the PDF.
    const pdfRasterScale = Math.max(2, Math.min(5, 220 / 72))

    const loadImage = (src) => new Promise((resolve, reject) => {
      const img = new window.Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve(img)
      img.onerror = reject
      img.src = src
    })

    const drawPageHeader = (pageNumber) => {
      // Reset header text color each page so later card styling doesn't tint headers.
      doc.setTextColor(0, 0, 0)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(14)
      const projectName = String(currentProject?.name || '').trim()
      doc.text(
        projectName || `Storyboard ${batch.modeLabel || 'Ad'}`,
        margin,
        margin + 14
      )
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      const subtitle = projectName
        ? `${batch.modeLabel || 'Ad'} storyboard`
        : `Generated ${new Date(batch.createdAt || Date.now()).toLocaleString()}`
      doc.text(subtitle, margin, margin + 28)
      doc.text(`Page ${pageNumber}`, margin, margin + 40)
      doc.setDrawColor(0, 0, 0)
      doc.line(margin, margin + 46, pageWidth - margin, margin + 46)
    }

    let pageNumber = 1
    let row = 0
    let col = 0
    let cursorY = margin + headerHeight
    drawPageHeader(pageNumber)

    for (let index = 0; index < sortedItems.length; index += 1) {
      const item = sortedItems[index]

      if (cursorY + cardHeight > pageHeight - margin) {
        doc.addPage()
        pageNumber += 1
        row = 0
        col = 0
        cursorY = margin + headerHeight
        drawPageHeader(pageNumber)
      }

      const cardX = margin + (col * (cardWidth + colGap))
      const cardY = cursorY
      const imageX = cardX + 1
      const imageY = cardY + 1
      const imageW = cardWidth - 2
      const imageH = imageHeight

      doc.setDrawColor(90, 90, 90)
      doc.setFillColor(20, 20, 20)
      doc.rect(cardX, cardY, cardWidth, imageHeight + labelHeight + promptHeight + 6, 'FD')

      let imagePlaced = false
      if (item?.url) {
        try {
          const img = await loadImage(item.url)
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(2, Math.floor(imageW * pdfRasterScale))
          canvas.height = Math.max(2, Math.floor(imageH * pdfRasterScale))
          const ctx = canvas.getContext('2d')
          if (ctx) {
            ctx.fillStyle = '#111111'
            ctx.fillRect(0, 0, canvas.width, canvas.height)
            ctx.imageSmoothingEnabled = true
            ctx.imageSmoothingQuality = 'high'
            const scale = Math.min(canvas.width / Math.max(1, img.width), canvas.height / Math.max(1, img.height))
            const drawW = Math.max(1, Math.round(img.width * scale))
            const drawH = Math.max(1, Math.round(img.height * scale))
            const drawX = Math.floor((canvas.width - drawW) / 2)
            const drawY = Math.floor((canvas.height - drawH) / 2)
            ctx.drawImage(img, drawX, drawY, drawW, drawH)
            const dataUrl = canvas.toDataURL('image/png')
            doc.addImage(dataUrl, 'PNG', imageX, imageY, imageW, imageH)
            imagePlaced = true
          }
        } catch (_) {
          imagePlaced = false
        }
      }

      if (!imagePlaced) {
        doc.setDrawColor(120, 120, 120)
        doc.rect(imageX, imageY, imageW, imageH)
        doc.setFont('helvetica', 'italic')
        doc.setFontSize(8)
        doc.setTextColor(180, 180, 180)
        doc.text('Image unavailable', imageX + 8, imageY + 14)
      }

      const labelText = String(item?.shotId || item?.sceneId || '').trim().toLowerCase() || `shot_${index + 1}`
      doc.setTextColor(220, 220, 220)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(8)
      doc.text(labelText, cardX + 4, cardY + imageHeight + 11)

      const promptText = String(item?.prompt || '').replace(/\s+/g, ' ').trim() || '(no prompt saved)'
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(7)
      doc.setTextColor(205, 205, 205)
      const wrapped = doc.splitTextToSize(promptText, cardWidth - 8)
      const lines = wrapped.slice(0, maxPromptLines)
      doc.text(lines, cardX + 4, cardY + imageHeight + labelHeight + 10)

      col += 1
      if (col >= columns) {
        col = 0
        row += 1
        cursorY = margin + headerHeight + (row * (cardHeight + rowGap))
      }
    }

    const pdfBlob = doc.output('blob')
    const labelToken = slugifyNameToken(
      stripFileExtension(batch.directorLabel || ''),
      { fallback: 'keyframes', maxLength: 28 }
    )
    const dateStamp = new Date(batch.createdAt || Date.now())
      .toISOString()
      .replace(/[:.]/g, '-')
    const fileName = `director_${batch.modeKey || 'ad'}_${labelToken}_keyframes_${dateStamp}.pdf`
    const file = new File([pdfBlob], fileName, { type: 'application/pdf' })
    const imported = await importAsset(currentProjectHandle, file, 'images')

    let pdfUrl = null
    try {
      if (imported?.path) {
        pdfUrl = await getProjectFileUrl(currentProjectHandle, imported.path)
      }
    } catch (_) {
      pdfUrl = null
    }
    if (!pdfUrl) {
      pdfUrl = URL.createObjectURL(pdfBlob)
    }

    return {
      fileName,
      relativePath: imported?.path || '',
      url: pdfUrl,
      frameCount: sortedItems.length,
    }
  }, [currentProject?.name, currentProjectHandle])

  const finalizeStoryboardPdfBatchForJob = useCallback(async () => {
    // Automatic keyframe PDF export is disabled.
    // Users now explicitly generate PDFs with the "Create Storyboard PDF" button.
  }, [])

  const enqueueJob = useCallback((job) => {
    setGenerationQueue(prev => [...prev, job])
  }, [])

  const requestConfirm = useCallback(({
    title = 'Confirm action',
    message = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    tone = 'danger',
  }) => {
    if (confirmResolverRef.current) {
      confirmResolverRef.current(false)
      confirmResolverRef.current = null
    }
    return new Promise((resolve) => {
      confirmResolverRef.current = resolve
      setConfirmDialog({ title, message, confirmLabel, cancelLabel, tone })
    })
  }, [])

  const resolveConfirmDialog = useCallback((accepted) => {
    setConfirmDialog(null)
    const resolve = confirmResolverRef.current
    confirmResolverRef.current = null
    if (resolve) resolve(Boolean(accepted))
  }, [])

  useEffect(() => () => {
    if (confirmResolverRef.current) {
      confirmResolverRef.current(false)
      confirmResolverRef.current = null
    }
  }, [])

  const confirmLargeQueueBatch = useCallback(async (jobCount, label) => {
    if (jobCount <= YOLO_QUEUE_CONFIRM_THRESHOLD) return true
    return requestConfirm({
      title: 'Large queue batch',
      message: `You are about to queue ${jobCount} ${label} jobs.\n\nTip: use smaller shot/angle/take counts for quicker test batches.`,
      confirmLabel: 'Queue jobs',
      cancelLabel: 'Cancel',
      tone: 'primary',
    })
  }, [requestConfirm])

  const getExistingYoloStageKeys = useCallback((stage) => (
    new Set(
      generationQueue
        .filter((job) => {
          if (job?.yolo?.stage !== stage || !job?.yolo?.key || job.status === 'error') return false
          const jobMode = job?.yolo?.mode
          return yoloModeKey === 'music'
            ? jobMode === 'music'
            : jobMode !== 'music'
        })
        .map((job) => job.yolo.key)
    )
  ), [generationQueue, yoloModeKey])

  const handleClearGenerationQueue = useCallback(async () => {
    if (generationQueue.length === 0) return
    const hasActiveJobs = generationQueue.some((job) => ACTIVE_JOB_STATUSES.includes(job.status))
    const confirmed = await requestConfirm({
      title: 'Clear queue?',
      message: hasActiveJobs
        ? `Clear ${generationQueue.length} jobs and interrupt the active generation?`
        : `Clear ${generationQueue.length} queued/completed jobs from this session?`,
      confirmLabel: 'Clear queue',
      cancelLabel: 'Keep queue',
      tone: 'danger',
    })
    if (!confirmed) return

    if (hasActiveJobs) {
      try {
        await comfyui.interrupt()
      } catch (_) {
        // ignore interrupt failure; queue reset still proceeds
      }
    }

    setGenerationQueue([])
    setActiveJobId(null)
    processingRef.current = false
    startedJobIdsRef.current.clear()
    storyboardPdfBatchesRef.current.clear()
    queuePausedRef.current = false
    consecutiveRapidFailsRef.current = 0
    setFormError(null)
    addComfyLog('status', 'Generation queue cleared')
  }, [addComfyLog, generationQueue, requestConfirm])

  const handleResumeQueue = useCallback(() => {
    const pausedIds = queueRef.current
      .filter((job) => job.status === 'paused')
      .map((job) => job.id)
    for (const jobId of pausedIds) {
      startedJobIdsRef.current.delete(jobId)
    }
    queuePausedRef.current = false
    consecutiveRapidFailsRef.current = 0
    setGenerationQueue(prev => prev.map(j =>
      j.status === 'paused' ? { ...j, status: 'queued' } : j
    ))
    addComfyLog('status', 'Queue resumed')
  }, [addComfyLog])

  const createQueuedJob = useCallback((overrides = {}) => {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const assetFieldIds = {}
    for (const field of selectedWorkflowManifest?.fields || []) {
      if (field?.type !== 'assetSelect' || field.id === 'audioAsset') continue
      const assetId = selectedAssetFields[field.id]?.id || selectedAssetFieldIds[field.id] || null
      if (assetId) assetFieldIds[field.id] = assetId
    }
    const baseJob = {
      id: jobId,
      createdAt: Date.now(),
      category,
      workflowId,
      workflowLabel: selectedWorkflowManifest?.title || currentWorkflow?.label || workflowId,
      needsImage: !!(selectedWorkflowManifest?.needsImage ?? currentWorkflow?.needsImage),
      inputAssetType: selectedWorkflowManifest?.inputAssetType || primaryAssetSlot?.assetType || ((selectedWorkflowManifest?.needsImage ?? currentWorkflow?.needsImage) ? 'image' : null),
      prompt: fullPrompt,
      negativePrompt,
      tags: selectedTags,
      seed,
      duration,
      fps,
      interpolationMultiplier,
      enableFpsMultiplier,
      resolution: category === 'image' ? effectiveImageResolution : resolution,
      wanQualityPreset,
      editSteps,
      editCfg,
      musicTags,
      lyrics,
      musicDuration,
      bpm,
      keyscale,
      inputAssetId: selectedAsset?.id || null,
      inputAssetName: selectedAsset?.name || '',
      audioAssetId: selectedWorkflowManifest?.requiresAudio ? (selectedAudioAsset?.id || null) : null,
      audioAssetName: selectedWorkflowManifest?.requiresAudio ? (selectedAudioAsset?.name || '') : '',
      assetFieldIds,
      inputFromTimelineFrame: false,
      referenceAssetId1: workflowId === 'image-edit' ? referenceAssetId1 : null,
      referenceAssetId2: workflowId === 'image-edit' ? referenceAssetId2 : null,
      frameTime: frameTime || 0,
      status: 'queued',
      progress: 0,
      promptId: null,
      node: null,
      error: null,
      ...overrides,
    }

    const findAssetSnapshot = (assetId) => {
      if (!assetId) return null
      return snapshotGenerationAsset(assets.find((asset) => asset.id === assetId))
    }
    const assetFieldSnapshots = Object.fromEntries(
      Object.entries(baseJob.assetFieldIds || {})
        .map(([fieldId, assetId]) => [fieldId, findAssetSnapshot(assetId)])
        .filter(([, asset]) => Boolean(asset))
    )

    return {
      ...baseJob,
      originProject: currentProjectHandle ? {
        handle: currentProjectHandle,
        name: currentProject?.name || '',
        path: typeof currentProjectHandle === 'string' ? currentProjectHandle : null,
        created: currentProject?.created || null,
      } : null,
      sourceAssets: {
        input: findAssetSnapshot(baseJob.inputAssetId),
        reference1: findAssetSnapshot(baseJob.referenceAssetId1),
        reference2: findAssetSnapshot(baseJob.referenceAssetId2),
        audio: findAssetSnapshot(baseJob.musicAudioAssetId || baseJob.audioAssetId),
        assetFields: assetFieldSnapshots,
      },
    }
  }, [
    assets,
    bpm,
    category,
    currentProject?.created,
    currentProject?.name,
    currentProjectHandle,
    currentWorkflow?.label,
    currentWorkflow?.needsImage,
    duration,
    editCfg,
    editSteps,
    enableFpsMultiplier,
    effectiveImageResolution,
    fps,
    frameTime,
    fullPrompt,
    imageResolution,
    interpolationMultiplier,
    keyscale,
    lyrics,
    musicDuration,
    musicTags,
    negativePrompt,
    primaryAssetSlot?.assetType,
    referenceAssetId1,
    referenceAssetId2,
    resolution,
    selectedAssetNativeResolution,
    seed,
    selectedAsset?.id,
    selectedAsset?.name,
    selectedAssetFieldIds,
    selectedAssetFields,
    selectedAudioAsset?.id,
    selectedAudioAsset?.name,
    seedreamUsesInputResolution,
    selectedTags,
    selectedWorkflowManifest?.requiresAudio,
    selectedWorkflowManifest?.inputAssetType,
    selectedWorkflowManifest?.needsImage,
    selectedWorkflowManifest?.fields,
    selectedWorkflowManifest?.title,
    wanQualityPreset,
    workflowId,
  ])

  const handleQueueShortFilmVoices = useCallback(async (payload = {}) => {
    const {
      dialogueLines = [],
      characters = [],
      title = 'Short Film',
      voiceWorkflow = 'text_to_speech',
    } = payload || {}

    if (voiceWorkflow !== 'text_to_speech') {
      const message = 'Only Text to Speech is wired right now. Text to Dialogue and Speech to Speech can be added after this first voice pass.'
      setFormError(message)
      return { queued: 0, skipped: 0, message }
    }

    const lines = (Array.isArray(dialogueLines) ? dialogueLines : [])
      .map((line, index) => ({
        ...line,
        index,
        text: String(line?.text || '').trim(),
        slug: String(line?.slug || '').trim(),
        speaker: String(line?.speaker || '').trim() || 'Character',
        id: String(line?.id || `dialogue-${index + 1}`),
      }))
      .filter((line) => line.text)

    if (lines.length === 0) {
      const message = 'No dialogue lines found yet. Add CHARACTER: line dialogue in the script, then queue voices.'
      setFormError(message)
      return { queued: 0, skipped: 0, message }
    }

    if (!isConnected) {
      const message = 'ComfyUI is not connected yet. Start ComfyUI, then queue voices.'
      setFormError(message)
      return { queued: 0, skipped: 0, message }
    }

    const depsOk = await validateDependenciesForQueue(
      [ELEVENLABS_TTS_WORKFLOW_ID],
      'short film voices'
    )
    if (!depsOk) {
      return { queued: 0, skipped: 0, message: 'Voice queue blocked by missing ElevenLabs workflow requirements.' }
    }

    const characterBySlug = new Map()
    for (const character of Array.isArray(characters) ? characters : []) {
      if (character?.slug) characterBySlug.set(String(character.slug), character)
    }

    const activeLineIds = new Set(
      generationQueue
        .filter((job) => (
          job?.workflowId === ELEVENLABS_TTS_WORKFLOW_ID &&
          NON_TERMINAL_JOB_STATUSES.includes(job.status) &&
          (!job?.shortFilm?.title || job.shortFilm.title === title) &&
          job?.shortFilm?.dialogueId
        ))
        .map((job) => String(job.shortFilm.dialogueId))
    )

    let skipped = 0
    const titleToken = slugifyNameToken(title, { fallback: 'short_film', maxLength: 24 })
    const jobs = []
    lines.forEach((line) => {
      if (activeLineIds.has(line.id)) {
        skipped += 1
        return
      }

      const character = characterBySlug.get(line.slug) || null
      const voicePreset = String(character?.voicePreset || '').trim() || 'Roger (male, american)'
      const speakerToken = slugifyNameToken(line.speaker || line.slug, { fallback: 'character', maxLength: 18 })

      jobs.push(createQueuedJob({
        category: 'audio',
        workflowId: ELEVENLABS_TTS_WORKFLOW_ID,
        workflowLabel: 'Short Film Voices (ElevenLabs)',
        needsImage: false,
        inputAssetType: null,
        inputAssetId: null,
        inputAssetName: '',
        prompt: line.text,
        musicTags: `${line.speaker}: ${line.text}`,
        duration: null,
        fps: null,
        resolution: null,
        seed: Number(seed) + line.index + 1,
        directorLabel: `${titleToken}_${speakerToken}_${line.index + 1}`,
        elevenLabsTts: {
          text: line.text,
          voice: voicePreset,
          stability: 0.5,
          model: 'eleven_multilingual_v2',
          speed: 1,
          similarityBoost: 0.75,
          useSpeakerBoost: false,
          style: 0,
          languageCode: '',
          outputFormat: 'mp3_44100_192',
        },
        shortFilm: {
          kind: 'dialogue-voice',
          title,
          dialogueId: line.id,
          lineIndex: line.index,
          speaker: line.speaker,
          slug: line.slug,
          text: line.text,
          voicePreset,
          workflow: voiceWorkflow,
        },
      }))
    })

    if (jobs.length === 0) {
      const message = skipped > 0
        ? 'Those voice lines are already queued or generating.'
        : 'No voice jobs were queued.'
      setFormError(message)
      return { queued: 0, skipped, message }
    }

    setGenerationQueue((prev) => [...prev, ...jobs])
    setFormError(null)
    const message = `Queued ${jobs.length} voice line${jobs.length === 1 ? '' : 's'}${skipped > 0 ? ` (${skipped} already active)` : ''}.`
    addComfyLog('status', `Short film voices queued: ${jobs.length} job${jobs.length === 1 ? '' : 's'}`)
    return { queued: jobs.length, skipped, message }
  }, [
    addComfyLog,
    createQueuedJob,
    generationQueue,
    isConnected,
    seed,
    validateDependenciesForQueue,
  ])

  const handleQueueShortFilmKeyframes = useCallback(async (payload = {}) => {
    const {
      shotPlan = [],
      characters = [],
      locations = [],
      title = 'Short Film',
      keyframeWorkflow = 'nano-banana-2',
      resolution: keyframeResolution = null,
    } = payload || {}

    const workflow = String(keyframeWorkflow || '').trim()
    const workflowOption = SHORT_FILM_KEYFRAME_WORKFLOW_OPTIONS.find((option) => option.id === workflow)
      || SHORT_FILM_KEYFRAME_WORKFLOW_OPTIONS[0]
    const workflowIdToUse = workflowOption.id
    const shots = (Array.isArray(shotPlan) ? shotPlan : [])
      .map((shot, index) => ({ ...shot, index }))
      .filter((shot) => String(shot?.keyframe || '').trim())

    if (shots.length === 0) {
      const message = 'No planned shots found. Refresh the shot plan before creating keyframes.'
      setFormError(message)
      return { queued: 0, skipped: 0, missing: 0, message }
    }

    if (!isConnected) {
      const message = 'ComfyUI is not connected yet. Start ComfyUI, then queue keyframes.'
      setFormError(message)
      return { queued: 0, skipped: 0, missing: 0, message }
    }

    const depsOk = await validateDependenciesForQueue(
      [workflowIdToUse],
      'short film keyframes'
    )
    if (!depsOk) {
      return { queued: 0, skipped: 0, missing: 0, message: 'Keyframe queue blocked by missing workflow requirements.' }
    }

    const characterBySlug = new Map()
    for (const character of Array.isArray(characters) ? characters : []) {
      if (character?.slug) characterBySlug.set(String(character.slug), character)
    }
    const locationBySlug = new Map()
    for (const location of Array.isArray(locations) ? locations : []) {
      if (location?.slug) locationBySlug.set(String(location.slug), location)
    }
    const assetExists = (assetId) => Boolean(assetId && assets.some((asset) => asset?.id === assetId))
    const firstExisting = (ids = []) => ids.find((assetId) => assetExists(assetId)) || ''
    const getLocationReferenceId = (location) => firstExisting([
      location?.heroAssetId,
      location?.wideAssetId,
      location?.reverseAssetId,
      location?.detailAssetId,
    ])
    const buildPrompt = ({ shot, character, location, usesQwen }) => {
      const parts = [
        'Create one cinematic keyframe still for a short film shot.',
        `Project: ${title}.`,
        shot?.scene ? `Scene: ${shot.scene}.` : '',
        shot?.title ? `Shot: ${shot.title}.` : '',
        shot?.type ? `Shot type: ${shot.type}.` : '',
        location?.name ? `Location: ${location.name}. ${location.description || ''}` : '',
        character?.name ? `Character visible: ${character.name}. ${character.visualNotes || ''}` : '',
        `Keyframe prompt: ${shot.keyframe}`,
        usesQwen
          ? 'Use the attached reference image as the visual anchor. Preserve identity, wardrobe, room geography, lighting continuity, and cinematic realism while creating the requested shot.'
          : 'Use any attached references for character identity, wardrobe, and location continuity. Make it a production-ready opening frame for image-to-video.',
        'No text overlays, captions, watermarks, logos, UI, or extra typography.',
      ]
      return parts.map((part) => String(part || '').trim()).filter(Boolean).join('\n')
    }

    const activeOrReadyShotIds = new Set()
    for (const job of generationQueue || []) {
      if (job?.shortFilm?.kind !== 'shot-keyframe') continue
      if (job.shortFilm.title && job.shortFilm.title !== title) continue
      if (job.status === 'error') continue
      if (job?.shortFilm?.shotId) activeOrReadyShotIds.add(String(job.shortFilm.shotId))
    }
    for (const asset of assets || []) {
      if (asset?.shortFilm?.title && asset.shortFilm.title !== title) continue
      if (asset?.shortFilm?.kind === 'shot-keyframe' && asset.shortFilm.shotId) {
        activeOrReadyShotIds.add(String(asset.shortFilm.shotId))
      }
    }

    let skipped = 0
    let missing = 0
    const titleToken = slugifyNameToken(title, { fallback: 'short_film', maxLength: 24 })
    const usesQwen = workflowIdToUse === 'image-edit'
    const jobs = []
    shots.forEach((shot) => {
      const shotId = String(shot?.id || `shot-${shot.index + 1}`)
      if (activeOrReadyShotIds.has(shotId)) {
        skipped += 1
        return
      }

      const character = characterBySlug.get(String(shot.characterSlug || '')) || null
      const location = locationBySlug.get(String(shot.locationSlug || '')) || null
      const characterReferenceId = assetExists(character?.referenceAssetId) ? character.referenceAssetId : ''
      const locationReferenceId = getLocationReferenceId(location)
      const primaryReferenceId = characterReferenceId || locationReferenceId

      if (usesQwen && !primaryReferenceId) {
        missing += 1
        return
      }

      const referenceIds = [characterReferenceId, locationReferenceId]
        .filter(Boolean)
        .filter((assetId, index, arr) => arr.indexOf(assetId) === index)

      const prompt = buildPrompt({ shot, character, location, usesQwen })
      const shotToken = slugifyNameToken(shot.title || shotId, { fallback: 'shot', maxLength: 18 })
      const outputResolution = {
        width: Number(keyframeResolution?.width) || resolution.width,
        height: Number(keyframeResolution?.height) || resolution.height,
      }

      jobs.push(createQueuedJob({
        category: 'image',
        workflowId: workflowIdToUse,
        workflowLabel: `Short Film Keyframes (${workflowOption.label})`,
        needsImage: usesQwen,
        inputAssetType: usesQwen ? 'image' : null,
        inputAssetId: usesQwen ? primaryReferenceId : null,
        inputAssetName: '',
        inputFromTimelineFrame: false,
        prompt,
        seed: Number(seed) + shot.index + 1,
        resolution: outputResolution,
        referenceAssetId1: usesQwen ? (referenceIds.find((assetId) => assetId !== primaryReferenceId) || null) : (referenceIds[0] || null),
        referenceAssetId2: usesQwen ? null : (referenceIds[1] || null),
        directorLabel: `${titleToken}_${shotToken}_${shot.index + 1}`,
        shortFilm: {
          kind: 'shot-keyframe',
          title,
          shotId,
          shotIndex: shot.index,
          shotTitle: shot.title || `Shot ${shot.index + 1}`,
          shotType: shot.type || '',
          locationSlug: shot.locationSlug || '',
          characterSlug: shot.characterSlug || '',
          dialogueId: shot.dialogueId || '',
          workflow: workflowIdToUse,
          sourceReferenceAssetId: usesQwen ? primaryReferenceId : '',
          characterReferenceAssetId: characterReferenceId,
          locationReferenceAssetId: locationReferenceId,
          keyframePrompt: shot.keyframe,
          motionPrompt: shot.motion || '',
        },
      }))
    })

    if (jobs.length === 0) {
      const message = missing > 0 && usesQwen
        ? `No keyframes queued. Qwen Image Edit needs a character or location reference image for each shot (${missing} missing).`
        : skipped > 0
          ? 'Those shot keyframes are already queued or ready.'
          : 'No keyframe jobs were queued.'
      setFormError(message)
      return { queued: 0, skipped, missing, message }
    }

    const confirmed = await confirmLargeQueueBatch(jobs.length, 'short-film keyframe')
    if (!confirmed) {
      const message = 'Keyframe queue cancelled.'
      setFormError(message)
      return { queued: 0, skipped, missing, message }
    }

    setGenerationQueue((prev) => [...prev, ...jobs])
    setFormError(missing > 0 ? `Queued ${jobs.length} keyframes (${missing} Qwen shots missing usable references).` : null)
    const message = `Queued ${jobs.length} keyframe${jobs.length === 1 ? '' : 's'} with ${workflowOption.label}${skipped > 0 ? ` (${skipped} already ready/active)` : ''}${missing > 0 ? ` (${missing} missing references)` : ''}.`
    addComfyLog('status', `Short film keyframes queued: ${jobs.length} job${jobs.length === 1 ? '' : 's'}`)
    return { queued: jobs.length, skipped, missing, message }
  }, [
    addComfyLog,
    assets,
    confirmLargeQueueBatch,
    createQueuedJob,
    generationQueue,
    isConnected,
    resolution.height,
    resolution.width,
    seed,
    validateDependenciesForQueue,
  ])

  const handleQueueShortFilmVideos = useCallback(async (payload = {}) => {
    const {
      shotPlan = [],
      dialogueLines = [],
      characters = [],
      locations = [],
      title = 'Short Film',
      resolution: videoResolution = null,
      fps: videoFps = 24,
      shotIds = [],
      promptOverrides = {},
      force = false,
    } = payload || {}

    const targetShotIds = new Set(
      (Array.isArray(shotIds) ? shotIds : [])
        .map((shotId) => String(shotId || '').trim())
        .filter(Boolean)
    )
    const shots = (Array.isArray(shotPlan) ? shotPlan : [])
      .map((shot, index) => ({ ...shot, index }))
      .filter((shot) => targetShotIds.size === 0 || targetShotIds.has(String(shot?.id || `shot-${shot.index + 1}`)))
      .filter((shot) => String(shot?.motion || shot?.keyframe || '').trim())

    if (shots.length === 0) {
      const message = 'No planned shots found. Refresh the shot plan before creating videos.'
      setFormError(message)
      return { queued: 0, skipped: 0, missingKeyframes: 0, missingVoices: 0, message }
    }

    if (!isConnected) {
      const message = 'ComfyUI is not connected yet. Start ComfyUI, then queue videos.'
      setFormError(message)
      return { queued: 0, skipped: 0, missingKeyframes: 0, missingVoices: 0, message }
    }

    const characterBySlug = new Map()
    for (const character of Array.isArray(characters) ? characters : []) {
      if (character?.slug) characterBySlug.set(String(character.slug), character)
    }
    const locationBySlug = new Map()
    for (const location of Array.isArray(locations) ? locations : []) {
      if (location?.slug) locationBySlug.set(String(location.slug), location)
    }
    const dialogueById = new Map()
    for (const line of Array.isArray(dialogueLines) ? dialogueLines : []) {
      if (line?.id) dialogueById.set(String(line.id), line)
    }

    const keyframeAssetByShotId = new Map()
    const voiceAssetByDialogueId = new Map()
    const activeOrReadyWorkflowIdsByShotId = new Map()
    const markActiveOrReady = (shotId, workflowId) => {
      const normalizedShotId = String(shotId || '')
      if (!normalizedShotId) return
      const normalizedWorkflowId = String(workflowId || '')
      const workflowSet = activeOrReadyWorkflowIdsByShotId.get(normalizedShotId) || new Set()
      workflowSet.add(normalizedWorkflowId)
      activeOrReadyWorkflowIdsByShotId.set(normalizedShotId, workflowSet)
    }
    const hasActiveOrReady = (shotId, workflowId) => {
      const workflowSet = activeOrReadyWorkflowIdsByShotId.get(String(shotId || ''))
      if (!workflowSet) return false
      return workflowSet.has(String(workflowId || '')) || workflowSet.has('')
    }
    for (const asset of assets || []) {
      if (asset?.shortFilm?.title && asset.shortFilm.title !== title) continue
      if (asset?.type === 'image' && asset?.shortFilm?.kind === 'shot-keyframe' && asset.shortFilm.shotId) {
        keyframeAssetByShotId.set(String(asset.shortFilm.shotId), asset)
      }
      if (asset?.type === 'audio' && asset?.shortFilm?.kind === 'dialogue-voice' && asset.shortFilm.dialogueId) {
        voiceAssetByDialogueId.set(String(asset.shortFilm.dialogueId), asset)
      }
      if (asset?.type === 'video' && asset?.shortFilm?.kind === 'shot-video' && asset.shortFilm.shotId) {
        markActiveOrReady(asset.shortFilm.shotId, asset.shortFilm.workflow)
      }
    }
    for (const job of generationQueue || []) {
      if (job?.shortFilm?.kind !== 'shot-video') continue
      if (job.shortFilm.title && job.shortFilm.title !== title) continue
      if (job.status === 'error') continue
      if (job?.shortFilm?.shotId) markActiveOrReady(job.shortFilm.shotId, job.workflowId || job.shortFilm.workflow)
    }

    const outputResolution = {
      width: Number(videoResolution?.width) || resolution.width,
      height: Number(videoResolution?.height) || resolution.height,
    }
    const numericFps = Math.max(1, Math.round(Number(videoFps) || 24))
    const titleToken = slugifyNameToken(title, { fallback: 'short_film', maxLength: 24 })

    let skipped = 0
    let missingKeyframes = 0
    let missingVoices = 0
    const jobs = []
    for (const shot of shots) {
      const shotId = String(shot?.id || `shot-${shot.index + 1}`)
      const keyframeAsset = keyframeAssetByShotId.get(shotId)
      if (!keyframeAsset) {
        missingKeyframes += 1
        continue
      }

      const dialogue = shot.dialogueId ? dialogueById.get(String(shot.dialogueId)) : null
      const voiceAsset = shot.dialogueId ? voiceAssetByDialogueId.get(String(shot.dialogueId)) : null
      if (shot.dialogueId && !voiceAsset) {
        missingVoices += 1
        continue
      }

      const character = characterBySlug.get(String(shot.characterSlug || dialogue?.slug || '')) || null
      const location = locationBySlug.get(String(shot.locationSlug || '')) || null
      const usesAudio = Boolean(voiceAsset)
      const workflowIdToUse = usesAudio ? SHORT_FILM_DIALOGUE_VIDEO_WORKFLOW_ID : SHORT_FILM_VIDEO_WORKFLOW_ID
      if (!force && hasActiveOrReady(shotId, workflowIdToUse)) {
        skipped += 1
        continue
      }
      const shotToken = slugifyNameToken(shot.title || shotId, { fallback: 'shot', maxLength: 18 })
      const durationSeconds = Math.max(2, Math.min(8, Number(shot.duration) || 4))
      const promptOverride = String(promptOverrides?.[shotId] || '').trim()
      const prompt = promptOverride || buildShortFilmVideoPrompt({
        title,
        shot,
        character,
        location,
        dialogue,
        usesAudio,
      })

      jobs.push(createQueuedJob({
        category: 'video',
        workflowId: workflowIdToUse,
        workflowLabel: usesAudio ? 'Short Film Videos (LTX 2.3 + Audio)' : 'Short Film Videos (LTX 2.3)',
        needsImage: true,
        inputAssetType: 'image',
        inputAssetId: keyframeAsset.id,
        inputAssetName: keyframeAsset.name || '',
        audioAssetId: usesAudio ? voiceAsset.id : null,
        audioAssetName: usesAudio ? (voiceAsset.name || '') : '',
        prompt,
        negativePrompt: 'low quality, blurry, distorted face, warped hands, changing identity, captions, subtitles, watermark, logo, text overlay',
        seed: Number(seed) + 1000 + shot.index + 1,
        duration: durationSeconds,
        fps: numericFps,
        resolution: outputResolution,
        directorLabel: `${titleToken}_${shotToken}_${shot.index + 1}`,
        shortFilm: {
          kind: 'shot-video',
          title,
          shotId,
          shotIndex: shot.index,
          shotTitle: shot.title || `Shot ${shot.index + 1}`,
          shotType: shot.type || '',
          locationSlug: shot.locationSlug || '',
          characterSlug: shot.characterSlug || dialogue?.slug || '',
          dialogueId: shot.dialogueId || '',
          dialogueText: dialogue?.text || '',
          workflow: workflowIdToUse,
          promptFormat: usesAudio ? 'ltx23-structured-speech' : 'plain-motion',
          customPrompt: Boolean(promptOverride),
          keyframeAssetId: keyframeAsset.id,
          voiceAssetId: usesAudio ? voiceAsset.id : '',
          keyframePrompt: shot.keyframe || '',
          motionPrompt: shot.motion || '',
        },
      }))
    }

    if (jobs.length === 0) {
      const message = missingKeyframes > 0
        ? `No videos queued. ${missingKeyframes} shot${missingKeyframes === 1 ? ' needs' : 's need'} keyframes first.`
        : missingVoices > 0
          ? `No videos queued. ${missingVoices} dialogue shot${missingVoices === 1 ? ' needs' : 's need'} voice audio first.`
          : skipped > 0
            ? 'Those shot videos are already queued or ready.'
            : 'No video jobs were queued.'
      setFormError(message)
      return { queued: 0, skipped, missingKeyframes, missingVoices, message }
    }

    const workflowIdsToValidate = Array.from(new Set(jobs.map((job) => job.workflowId)))
    const depsOk = await validateDependenciesForQueue(workflowIdsToValidate, 'short film videos')
    if (!depsOk) {
      return { queued: 0, skipped, missingKeyframes, missingVoices, message: 'Video queue blocked by missing workflow requirements.' }
    }

    const confirmed = await confirmLargeQueueBatch(jobs.length, 'short-film video')
    if (!confirmed) {
      const message = 'Video queue cancelled.'
      setFormError(message)
      return { queued: 0, skipped, missingKeyframes, missingVoices, message }
    }

    setGenerationQueue((prev) => [...prev, ...jobs])
    const detail = [
      skipped > 0 ? `${skipped} already ready/active` : '',
      missingKeyframes > 0 ? `${missingKeyframes} missing keyframes` : '',
      missingVoices > 0 ? `${missingVoices} missing voices` : '',
    ].filter(Boolean)
    setFormError(detail.length > 0 ? `Queued ${jobs.length} videos (${detail.join(', ')}).` : null)
    const message = `Queued ${jobs.length} LTX 2.3 video${jobs.length === 1 ? '' : 's'}${detail.length > 0 ? ` (${detail.join(', ')})` : ''}.`
    addComfyLog('status', `Short film videos queued: ${jobs.length} job${jobs.length === 1 ? '' : 's'}`)
    return { queued: jobs.length, skipped, missingKeyframes, missingVoices, message }
  }, [
    addComfyLog,
    assets,
    confirmLargeQueueBatch,
    createQueuedJob,
    generationQueue,
    isConnected,
    resolution.height,
    resolution.width,
    seed,
    validateDependenciesForQueue,
  ])

  const normalizeGeneratedYoloPlan = useCallback((rawPlan = [], options = {}) => (
    rawPlan.map((scene, sceneIndex) => {
      const sceneId = `S${sceneIndex + 1}`
      return {
        ...scene,
        id: sceneId,
        index: sceneIndex + 1,
        shots: (scene.shots || []).map((shot, shotIndex) => (
          normalizeShotForScene(sceneId, shot, shotIndex, shot, options)
        )),
      }
    })
  ), [])

  const buildYoloAdPlan = useCallback((options = {}) => {
    const scriptToUse = Object.prototype.hasOwnProperty.call(options, 'scriptOverride')
      ? String(options.scriptOverride || '')
      : yoloScript
    if (!scriptToUse.trim()) {
      setFormError('Paste an ad script first, then click Build Plan')
      return null
    }
    const effectiveAdStyleNotes = Object.prototype.hasOwnProperty.call(options, 'styleNotesOverride')
      ? sanitizeDirectorStyleNotesInput(options.styleNotesOverride)
      : sanitizeDirectorStyleNotesInput(yoloStyleNotes)
    if (effectiveAdStyleNotes !== yoloStyleNotes) {
      setYoloStyleNotes(effectiveAdStyleNotes)
    }
    const combinedAdStyleNotes = [effectiveAdStyleNotes, yoloAdReferenceStyleNotes].filter(Boolean).join(' ')
    const targetDuration = Object.prototype.hasOwnProperty.call(options, 'targetDurationOverride')
      ? Number(options.targetDurationOverride) || yoloTargetDuration
      : yoloTargetDuration
    const shotsPerScene = Object.prototype.hasOwnProperty.call(options, 'shotsPerSceneOverride')
      ? Number(options.shotsPerSceneOverride) || yoloShotsPerScene
      : yoloShotsPerScene
    const anglesPerShot = Object.prototype.hasOwnProperty.call(options, 'anglesPerShotOverride')
      ? Number(options.anglesPerShotOverride) || yoloAnglesPerShot
      : yoloAnglesPerShot
    const takesPerAngle = Object.prototype.hasOwnProperty.call(options, 'takesPerAngleOverride')
      ? Number(options.takesPerAngleOverride) || yoloTakesPerAngle
      : yoloTakesPerAngle
    const nextPlan = buildYoloPlanFromScript(scriptToUse, {
      targetDurationSeconds: targetDuration,
      shotsPerScene,
      anglesPerShot,
      takesPerAngle,
      styleNotes: combinedAdStyleNotes,
    })
    if (nextPlan.length === 0) {
      setFormError('Could not extract scenes from script')
      return null
    }
    const normalizedPlan = normalizeGeneratedYoloPlan(nextPlan)
    const nextPlanSignature = createYoloPlanSignature({
      mode: 'ad',
      script: scriptToUse,
      styleNotes: effectiveAdStyleNotes,
      referenceStyleNotes: yoloAdReferenceStyleNotes,
      targetDuration,
      shotsPerScene,
      anglesPerShot,
      takesPerAngle,
      productAssetId: Object.prototype.hasOwnProperty.call(options, 'productAssetIdOverride') ? (options.productAssetIdOverride || '') : (yoloAdProductAsset?.id || ''),
      modelAssetId: Object.prototype.hasOwnProperty.call(options, 'modelAssetIdOverride') ? (options.modelAssetIdOverride || '') : (yoloAdModelAsset?.id || ''),
      voiceoverAssetId: yoloAdVoiceoverAsset?.id || '',
      productName: Object.prototype.hasOwnProperty.call(options, 'productNameOverride') ? (options.productNameOverride || '') : yoloAdProductName,
      brandName: Object.prototype.hasOwnProperty.call(options, 'brandNameOverride') ? (options.brandNameOverride || '') : yoloAdBrandName,
      colorPalette: Object.prototype.hasOwnProperty.call(options, 'colorPaletteOverride') ? (options.colorPaletteOverride || '') : yoloAdColorPalette,
      logoConstraints: Object.prototype.hasOwnProperty.call(options, 'logoConstraintsOverride') ? (options.logoConstraintsOverride || '') : yoloAdLogoConstraints,
      spokespersonRole: Object.prototype.hasOwnProperty.call(options, 'spokespersonRoleOverride') ? (options.spokespersonRoleOverride || '') : yoloAdSpokespersonRole,
      wardrobeNotes: Object.prototype.hasOwnProperty.call(options, 'wardrobeNotesOverride') ? (options.wardrobeNotesOverride || '') : yoloAdWardrobeNotes,
      formatPreset: Object.prototype.hasOwnProperty.call(options, 'formatPresetOverride') ? (options.formatPresetOverride || '') : yoloAdFormatPreset,
      platformPreset: Object.prototype.hasOwnProperty.call(options, 'platformPresetOverride') ? (options.platformPresetOverride || '') : yoloAdPlatformPreset,
      consistency: yoloAdConsistency,
    })
    setYoloPlan(normalizedPlan)
    setYoloPlanSignature(nextPlanSignature)
    setFormError(null)
    return normalizedPlan
  }, [
    normalizeGeneratedYoloPlan,
    yoloAnglesPerShot,
    yoloScript,
    yoloShotsPerScene,
    yoloAdReferenceStyleNotes,
    yoloStyleNotes,
    yoloTakesPerAngle,
    yoloTargetDuration,
    yoloAdProductAsset?.id,
    yoloAdModelAsset?.id,
    yoloAdVoiceoverAsset?.id,
    yoloAdProductName,
    yoloAdBrandName,
    yoloAdColorPalette,
    yoloAdLogoConstraints,
    yoloAdSpokespersonRole,
    yoloAdWardrobeNotes,
    yoloAdFormatPreset,
    yoloAdPlatformPreset,
    yoloAdConsistency,
  ])

  /**
   * Build a music-mode plan for a specific target.
   *
   * `options.target` selects where the plan gets written:
   *   - undefined / null / 'active'  → active target (yoloMusicActiveScriptId)
   *   - 'master'                      → master regardless of active tab
   *   - <altSlotId>                   → a specific alt slot by id
   *
   * Alt-slot builds intentionally pass cast: [] to the planner because
   * b-roll passes have no performers and alt_performance passes inherit
   * the master's cast via the LLM prompt (the planner itself doesn't need
   * to resolve Artist: fields for alts — the LLM already baked them into
   * the Keyframe/Motion prompts). Keeping cast empty here avoids spurious
   * "unresolved artist" warnings on every b-roll pass.
   */
  const buildYoloMusicPlan = useCallback((options = {}) => {
    const rawTarget = Object.prototype.hasOwnProperty.call(options, 'target') ? options.target : 'active'
    let resolvedTargetId = null // null = master
    if (rawTarget === 'master') {
      resolvedTargetId = null
    } else if (rawTarget === 'active' || rawTarget == null) {
      resolvedTargetId = yoloMusicActiveScriptId || null
    } else {
      resolvedTargetId = String(rawTarget)
    }
    const targetSlot = resolvedTargetId
      ? yoloMusicAltScripts.find((entry) => entry.id === resolvedTargetId) || null
      : null
    if (resolvedTargetId && !targetSlot) {
      setFormError('Alt pass not found. Switch to it again and retry.')
      return null
    }
    const scriptContent = targetSlot ? targetSlot.script : yoloMusicScript
    const isAltTarget = Boolean(targetSlot)

    if (!yoloMusicAudioAssetId) {
      setFormError('Select the song audio asset first')
      return null
    }
    if (!String(scriptContent || '').trim()) {
      setFormError(isAltTarget
        ? 'This alt pass has no script yet — paste the LLM output into it first.'
        : 'Write a director script first (tip: click "Start from template")')
      return null
    }

    const effectiveStyleNotes = Object.prototype.hasOwnProperty.call(options, 'styleNotesOverride')
      ? String(options.styleNotesOverride || '').trim()
      : String(yoloMusicStyleNotes || '').trim()
    if (effectiveStyleNotes !== yoloMusicStyleNotes) {
      setYoloMusicStyleNotes(effectiveStyleNotes)
    }
    const effectiveConcept = Object.prototype.hasOwnProperty.call(options, 'conceptOverride')
      ? String(options.conceptOverride || '').trim()
      : String(yoloMusicConcept || '').trim()
    if (effectiveConcept !== yoloMusicConcept) {
      setYoloMusicConcept(effectiveConcept)
    }

    const { scenes: nextPlan, warnings: planWarnings } = buildMusicVideoPlanFromScript({
      script: scriptContent,
      lyrics: yoloMusicLyrics,
      concept: effectiveConcept,
      styleNotes: effectiveStyleNotes,
      targetDuration: yoloMusicTargetDuration,
      songDurationSeconds: yoloMusicSongDurationSeconds,
      cast: isAltTarget ? [] : yoloMusicResolvedCast,
    })
    if (!Array.isArray(nextPlan) || nextPlan.length === 0) {
      setFormError('Could not parse the director script. Make sure each shot starts with "Shot N:" and includes at least a Keyframe prompt and a Motion prompt.')
      return null
    }

    // Stamp pass identity onto every scene so it survives into
    // flattenYoloPlanVariants → queue jobs → generated assets. Master gets a
    // synthetic `master` type so downstream code can treat every asset
    // uniformly; alt slots contribute their real passType + label so we can
    // distinguish Alt Performance vs Environmental vs Detail B-roll assets.
    const passMeta = isAltTarget
      ? {
        type: String(targetSlot.passType || 'alt_performance'),
        altSlotId: String(targetSlot.id || ''),
        altLabel: String(targetSlot.label || ''),
      }
      : { type: 'master', altSlotId: null, altLabel: 'Master Performance' }
    const normalizedPlan = normalizeGeneratedYoloPlan(nextPlan, {
      minDurationSeconds: MUSIC_VIDEO_SHOT_DEFAULTS.minShotLengthSeconds,
      maxDurationSeconds: MUSIC_VIDEO_SHOT_DEFAULTS.maxShotLengthSeconds,
    }).map((scene) => ({
      ...scene,
      pass: passMeta,
    }))
    const signature = makeMusicPlanSignature({ script: scriptContent, concept: effectiveConcept, styleNotes: effectiveStyleNotes })
    const rawWarnings = Array.isArray(planWarnings) ? planWarnings : []
    // Alt builds pass cast:[] to the planner on purpose (alt passes either
    // have no performers, as for b-roll, or inherit cast via the LLM prompt
    // for alt_performance). Cast-resolution warnings are therefore expected
    // on every Artist-bearing shot and would flood the warnings panel with
    // noise. Strip those kinds for alt targets only.
    const IRRELEVANT_KINDS_FOR_ALT = new Set(['unresolved-artist-override', 'too-many-artists'])
    const safeWarnings = isAltTarget
      ? rawWarnings.filter((w) => !IRRELEVANT_KINDS_FOR_ALT.has(w?.kind))
      : rawWarnings
    if (isAltTarget) {
      setYoloMusicAltScripts((prev) => prev.map((entry) => entry.id === resolvedTargetId
        ? { ...entry, plan: normalizedPlan, planSignature: signature, planWarnings: safeWarnings }
        : entry))
    } else {
      setYoloMusicPlan(normalizedPlan)
      setYoloMusicPlanSignature(signature)
      // Surface planner warnings (unresolved Artist: names, unknown lyric tags,
      // too-many-artists overflow) in the music-mode warning state. These are
      // advisory and do NOT block the build — the plan already fell back to a
      // sensible default.
      setYoloMusicPlanWarnings(safeWarnings)
    }
    setFormError(null)
    return normalizedPlan
  }, [
    makeMusicPlanSignature,
    normalizeGeneratedYoloPlan,
    yoloMusicActiveScriptId,
    yoloMusicAltScripts,
    yoloMusicAudioAssetId,
    yoloMusicResolvedCast,
    yoloMusicConcept,
    yoloMusicLyrics,
    yoloMusicScript,
    yoloMusicSongDurationSeconds,
    yoloMusicStyleNotes,
    yoloMusicTargetDuration,
  ])

  const buildActiveYoloPlan = useCallback((options = {}) => (
    isYoloMusicMode ? buildYoloMusicPlan(options) : buildYoloAdPlan(options)
  ), [buildYoloAdPlan, buildYoloMusicPlan, isYoloMusicMode])
  const handleBuildActiveYoloPlan = useCallback((options = {}) => {
    if (isYoloMusicMode) {
      // Reset the active target's plan first so the Build → reflow
      // produces clean state. Master uses the dedicated yoloMusicPlan
      // setters; alt targets write into the alt slot.
      if (yoloMusicActiveScriptId) {
        const targetId = yoloMusicActiveScriptId
        setYoloMusicAltScripts((prev) => prev.map((entry) => entry.id === targetId
          ? { ...entry, plan: [], planSignature: '', planWarnings: [] }
          : entry))
      } else {
        setYoloMusicPlan([])
        setYoloMusicPlanSignature('')
        setYoloMusicPlanWarnings([])
      }
    } else {
      setYoloPlan([])
      setYoloPlanSignature('')
    }
    const nextPlan = buildActiveYoloPlan({ styleNotesOverride: '', ...(options || {}) })
    if (Array.isArray(nextPlan) && nextPlan.length > 0) {
      setDirectorSubTab('scene-shot')
    }
    return nextPlan
  }, [buildActiveYoloPlan, isYoloMusicMode, yoloMusicActiveScriptId])

  const updateYoloShot = useCallback((sceneId, shotId, updater) => {
    setYoloActivePlan((prevPlan) => prevPlan.map((scene) => {
      if (scene.id !== sceneId) return scene
      const nextShots = (scene.shots || []).map((shot, shotIndex) => {
        if (shot.id !== shotId) return normalizeShotForScene(scene.id, shot, shotIndex, shot)
        const updatedShot = typeof updater === 'function'
          ? updater(shot, shotIndex, scene)
          : { ...shot, ...updater }
        return normalizeShotForScene(scene.id, updatedShot, shotIndex, shot)
      })
      return { ...scene, shots: nextShots }
    }))
  }, [setYoloActivePlan])

  const handleYoloShotImageBeatChange = useCallback((sceneId, shotId, value) => {
    updateYoloShot(sceneId, shotId, (shot) => ({ ...shot, imageBeat: value }))
  }, [updateYoloShot])

  const handleYoloShotVideoBeatChange = useCallback((sceneId, shotId, value) => {
    updateYoloShot(sceneId, shotId, (shot) => ({
      ...shot,
      videoBeat: value,
      beat: value,
      shotPrompt: value,
    }))
  }, [updateYoloShot])

  const handleYoloShotCameraDirectionChange = useCallback((sceneId, shotId, value) => {
    updateYoloShot(sceneId, shotId, (shot) => ({ ...shot, cameraDirection: value }))
  }, [updateYoloShot])

  const handleYoloShotCameraPresetChange = useCallback((sceneId, shotId, presetId) => {
    updateYoloShot(sceneId, shotId, (shot) => {
      const targetCount = Math.max(1, Number(shot?.angles?.length) || Number(yoloActiveAnglesPerShot) || 1)
      if (presetId === 'auto') {
        return {
          ...shot,
          cameraPresetId: 'auto',
          angles: String(shot?.shotType || '').trim()
            ? [String(shot.shotType).trim()]
            : shot.angles,
        }
      }
      return {
        ...shot,
        cameraPresetId: String(presetId || 'auto'),
        angles: resolveCameraPresetAngles(presetId, targetCount),
      }
    })
  }, [updateYoloShot, yoloActiveAnglesPerShot])

  const handleYoloShotDurationChange = useCallback((sceneId, shotId, value) => {
    updateYoloShot(sceneId, shotId, (shot) => ({
      ...shot,
      durationSeconds: clampNumberValue(value, 2, 5, shot.durationSeconds),
    }))
  }, [updateYoloShot])

  const handleYoloShotTakesChange = useCallback((sceneId, shotId, value) => {
    updateYoloShot(sceneId, shotId, (shot) => ({
      ...shot,
      takesPerAngle: Math.round(clampNumberValue(value, 1, 4, shot.takesPerAngle)),
    }))
  }, [updateYoloShot])

  // --- Music-video cast roster handlers -----------------------------------
  // The roster is a flat array; each row is edited by id. When the user picks
  // an image asset we also auto-derive a slug from its name (but leave the
  // slug editable — users sometimes want "rose" even when the asset is named
  // "rose_portrait_v2.png").
  const handleYoloMusicCastAdd = useCallback(() => {
    setYoloMusicCast((prev) => {
      const next = [...(prev || [])]
      next.push({
        id: `cast-${Date.now()}-${next.length}`,
        slug: '',
        label: '',
        assetId: null,
        role: next.length === 0 ? 'lead' : 'co_lead',
      })
      return next
    })
  }, [])
  const handleYoloMusicCastRemove = useCallback((castId) => {
    setYoloMusicCast((prev) => (prev || []).filter((entry) => entry?.id !== castId))
  }, [])
  const handleYoloMusicCastAssetChange = useCallback((castId, nextAssetId) => {
    setYoloMusicCast((prev) => (prev || []).map((entry) => {
      if (entry?.id !== castId) return entry
      const assetId = nextAssetId || null
      // If the row has no slug/label yet, seed them from the picked asset's
      // name so the user immediately sees a usable "rose" / "jake" handle.
      let { slug, label } = entry
      if (assetId && (!slug || !label)) {
        const asset = assets.find((a) => a?.id === assetId)
        const rawName = asset?.name || ''
        const stripped = rawName.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim()
        if (!slug) slug = normalizeCastSlug(stripped) || normalizeCastSlug(rawName)
        if (!label) label = stripped || rawName
      }
      return { ...entry, assetId, slug, label }
    }))
  }, [assets])
  const handleYoloMusicCastSlugChange = useCallback((castId, rawValue) => {
    const slug = normalizeCastSlug(rawValue)
    setYoloMusicCast((prev) => (prev || []).map((entry) => (
      entry?.id === castId ? { ...entry, slug } : entry
    )))
  }, [])
  const handleYoloMusicCastLabelChange = useCallback((castId, label) => {
    setYoloMusicCast((prev) => (prev || []).map((entry) => (
      entry?.id === castId ? { ...entry, label: String(label || '').slice(0, 60) } : entry
    )))
  }, [])
  const handleYoloMusicCastRoleChange = useCallback((castId, role) => {
    setYoloMusicCast((prev) => (prev || []).map((entry) => (
      entry?.id === castId ? { ...entry, role } : entry
    )))
  }, [])

  /**
   * Build the LLM prompt for a given pass configuration using the current
   * song/cast/concept context plus the current master script. Shared by
   * "create a new alt slot" and "re-copy this existing alt slot's prompt".
   */
  const buildMusicVideoAltPrompt = useCallback(({ passType, variantDescriptor }) => (
    buildMusicVideoLLMPrompt({
      songName: yoloMusicAudioAsset?.name || '',
      songDurationSeconds: yoloMusicSongDurationSeconds,
      targetDuration: yoloMusicTargetDuration,
      concept: yoloMusicConcept,
      styleNotes: yoloMusicStyleNotes,
      lyrics: yoloMusicLyrics,
      cast: yoloMusicResolvedCast,
      pass: passType,
      variantDescriptor,
      masterScript: yoloMusicScript,
    })
  ), [
    yoloMusicAudioAsset?.name,
    yoloMusicSongDurationSeconds,
    yoloMusicTargetDuration,
    yoloMusicConcept,
    yoloMusicStyleNotes,
    yoloMusicLyrics,
    yoloMusicResolvedCast,
    yoloMusicScript,
  ])

  const handleCopyMusicVideoLlmPrompt = useCallback(async (options = {}) => {
    const llmPrompt = buildMusicVideoLLMPrompt({
      songName: yoloMusicAudioAsset?.name || '',
      songDurationSeconds: yoloMusicSongDurationSeconds,
      targetDuration: yoloMusicTargetDuration,
      lyrics: yoloMusicLyrics,
      cast: yoloMusicResolvedCast,
      coveragePlan: options.coveragePlan || null,
    })
    await copyTextToClipboard(llmPrompt)
    setFormError(null)
    addComfyLog('status', 'Music video LLM brief copied.')
  }, [
    addComfyLog,
    yoloMusicAudioAsset?.name,
    yoloMusicSongDurationSeconds,
    yoloMusicTargetDuration,
    yoloMusicLyrics,
    yoloMusicResolvedCast,
  ])

  /**
   * Create a new alt-script slot for the given pass type, set it active,
   * and copy the corresponding LLM prompt to the clipboard so the user
   * can immediately paste it into their model of choice.
   *
   * Gated on the master script existing — alt passes inherit the master's
   * timings/lyrics, so without a master there's nothing to anchor to.
   */
  const handleCreateMusicAltScript = useCallback(({ passType, variantDescriptor = '' }) => {
    if (!yoloMusicScript.trim()) {
      setFormError('Write or paste your master Director Script first — alt passes inherit its timings.')
      return null
    }
    const variant = String(variantDescriptor || '').trim()
    const newSlot = {
      id: makeAltScriptId(),
      passType,
      label: deriveAltScriptLabel(passType, variant, yoloMusicAltScripts),
      variantDescriptor: variant,
      script: '',
      createdAt: Date.now(),
    }
    setYoloMusicAltScripts((prev) => [...prev, newSlot])
    setYoloMusicActiveScriptId(newSlot.id)
    setFormError(null)
    const prompt = buildMusicVideoAltPrompt({ passType, variantDescriptor: variant })
    void copyTextToClipboard(prompt)
    return newSlot
  }, [
    yoloMusicScript,
    yoloMusicAltScripts,
    buildMusicVideoAltPrompt,
  ])

  const handleMusicAltScriptRename = useCallback((slotId, label) => {
    setYoloMusicAltScripts((prev) => prev.map((entry) => (
      entry.id === slotId ? { ...entry, label: String(label || '').slice(0, 80) } : entry
    )))
  }, [])

  const handleMusicAltScriptChangeContent = useCallback((slotId, script) => {
    setYoloMusicAltScripts((prev) => prev.map((entry) => (
      entry.id === slotId ? { ...entry, script: String(script || '') } : entry
    )))
  }, [])

  const handleMusicScriptQuickChip = useCallback((scriptLine) => {
    const snippet = String(scriptLine || '').trim()
    if (!snippet) return

    const appendSnippet = (currentScript) => {
      const current = String(currentScript || '').trimEnd()
      const separator = current ? '\n' : ''
      return `${current}${separator}${snippet}\n`
    }

    if (yoloMusicIsMasterActive) {
      setYoloMusicScript((current) => appendSnippet(current))
      return
    }

    if (yoloMusicActiveAltScript?.id) {
      handleMusicAltScriptChangeContent(
        yoloMusicActiveAltScript.id,
        appendSnippet(yoloMusicActiveAltScript.script)
      )
    }
  }, [handleMusicAltScriptChangeContent, yoloMusicActiveAltScript, yoloMusicIsMasterActive])

  const handleAdScriptQuickChip = useCallback((scriptLine) => {
    const snippet = String(scriptLine || '').trim()
    if (!snippet) return
    setYoloScript((currentScript) => {
      const current = String(currentScript || '').trimEnd()
      const separator = current ? '\n' : ''
      return `${current}${separator}${snippet}\n`
    })
  }, [])

  const handleAdStyleSnippetApply = useCallback((notes) => {
    const snippet = String(notes || '').trim()
    if (!snippet) return
    setYoloStyleNotes((current) => {
      const existing = sanitizeDirectorStyleNotesInput(current)
      if (!existing) return snippet
      if (existing.includes(snippet)) return existing
      return `${existing}\n${snippet}`
    })
  }, [])

  const handleAdFormatPresetChange = useCallback((presetId) => {
    const preset = YOLO_AD_FORMAT_PRESETS.find((option) => option.id === presetId) || YOLO_AD_FORMAT_PRESETS[0]
    setYoloAdFormatPreset(preset?.id || presetId)
    if (preset?.styleNotes) {
      handleAdStyleSnippetApply(preset.styleNotes)
    }
  }, [handleAdStyleSnippetApply])

  const handleAdPlatformPresetChange = useCallback((presetId) => {
    const preset = YOLO_AD_PLATFORM_PRESETS.find((option) => option.id === presetId) || YOLO_AD_PLATFORM_PRESETS[0]
    if (!preset) return
    setYoloAdPlatformPreset(preset.id)
    setResolution({ width: preset.width, height: preset.height })
    setImageResolution({ width: preset.width, height: preset.height })
    const preferredDuration = Array.isArray(preset.durationPresets) ? preset.durationPresets[0] : null
    if (preferredDuration) setYoloTargetDuration(preferredDuration)
  }, [])

  const handleInsertAdNativeTextClips = useCallback(() => {
    if (yoloAdNativeTextEntries.length === 0) {
      setFormError('No Text overlay or End card fields found in the current ad plan. Build the plan after adding those fields.')
      return
    }
    const videoTrack = timelineAddTrack
      ? timelineAddTrack('video', { name: 'Ad Text Cards' })
      : (timelineTracks || []).find((track) => track?.type === 'video')
    if (!videoTrack) {
      setFormError('Add a video track on the timeline first, then insert ad text overlays.')
      return
    }

    yoloAdNativeTextEntries.forEach((entry, index) => {
      const isEndCard = entry.kind === 'end-card'
      timelineAddTextClip(videoTrack.id, {
        text: entry.text,
        duration: entry.duration,
        fontSize: isEndCard ? 72 : 46,
        fontWeight: 'bold',
        textColor: '#FFFFFF',
        backgroundColor: isEndCard ? 'rgba(0,0,0,0.78)' : 'rgba(0,0,0,0.35)',
        backgroundOpacity: isEndCard ? 70 : 35,
        backgroundPadding: isEndCard ? 42 : 22,
        textAlign: 'center',
        verticalAlign: isEndCard ? 'center' : 'bottom',
        strokeColor: '#000000',
        strokeWidth: isEndCard ? 0 : 2,
        shadow: true,
        shadowBlur: 12,
        saveHistory: index === 0,
      }, entry.startTime)
    })
    setFormError(null)
    addComfyLog('status', `Inserted ${yoloAdNativeTextEntries.length} editor-native ad text clip${yoloAdNativeTextEntries.length === 1 ? '' : 's'}`)
  }, [addComfyLog, timelineAddTextClip, timelineAddTrack, timelineTracks, yoloAdNativeTextEntries])

  const handleAssembleAdTimeline = useCallback(async (options = {}) => {
    if (isYoloMusicMode) {
      return { ok: false, message: 'Switch to Ad Creation first.' }
    }
    if (yoloActivePlanIsStale) {
      return { ok: false, message: 'Rebuild the current ad plan before assembling the timeline.' }
    }
    if (!Array.isArray(yoloActivePlan) || yoloActivePlan.length === 0) {
      return { ok: false, message: 'Build the ad plan before assembling the timeline.' }
    }
    if (!timelineAddClip || !timelineAddTrack) {
      return { ok: false, message: 'Timeline tools are not ready yet.' }
    }

    const workflowId = String(options?.workflowId || yoloAdLocalVideoWorkflowId || yoloDefaultVideoWorkflowId || '').trim()
    const workflowLabel = String(options?.workflowLabel || getWorkflowDisplayLabel(workflowId) || 'Video pass').trim()
    const timelineResolution = {
      width: Number(options?.resolution?.width || resolution.width) || null,
      height: Number(options?.resolution?.height || resolution.height) || null,
    }
    const timelineResolutionLabel = timelineResolution.width && timelineResolution.height
      ? `${timelineResolution.width}x${timelineResolution.height}`
      : ''
    const adTimelineDetail = [
      [yoloAdBrandName, yoloAdProductName].map((value) => String(value || '').trim()).filter(Boolean).join(' '),
      timelineResolutionLabel,
    ].filter(Boolean).join(' - ') || 'Ad Creation'
    const timelineResult = await ensureGeneratedEditTimeline({
      name: buildGeneratedEditTimelineName('Ad Edit', adTimelineDetail),
      width: timelineResolution.width,
      height: timelineResolution.height,
      fps: Number(yoloVideoFps) || null,
      color: '#22c55e',
    })
    if (!timelineResult.ok) {
      setFormError(timelineResult.message)
      return timelineResult
    }

    const trackName = `Ad - ${workflowLabel || 'Video pass'}`
    const variantByShotKey = new Map()
    for (const variant of yoloQueueVariants || []) {
      const key = `${variant?.sceneId || ''}|${variant?.shotId || ''}`
      if (key !== '|' && !variantByShotKey.has(key)) variantByShotKey.set(key, variant)
    }

    const latestVideoAssetByKey = new Map()
    for (const asset of assets || []) {
      if (asset?.type !== 'video') continue
      if (asset?.yolo?.mode === 'music' || asset?.yolo?.stage !== 'video') continue
      const assetWorkflowId = String(asset?.yolo?.workflowId || '').trim()
      const variantKey = String(asset?.yolo?.variantKey || '').trim()
      const keys = [
        asset?.yolo?.key,
        variantKey && assetWorkflowId ? getAdVideoVariantWorkflowKey(variantKey, assetWorkflowId) : '',
        variantKey && !assetWorkflowId ? variantKey : '',
      ].filter(Boolean)
      if (keys.length === 0) continue
      const assetTime = new Date(asset.createdAt || 0).getTime()
      for (const key of keys) {
        const existing = latestVideoAssetByKey.get(key)
        const existingTime = existing ? new Date(existing.createdAt || 0).getTime() : -1
        if (!existing || assetTime >= existingTime) latestVideoAssetByKey.set(key, asset)
      }
    }

    const fps = Number(useTimelineStore.getState().timelineFps) || Number(timelineFps) || Number(yoloVideoFps) || 24
    const minClipDuration = 1 / Math.max(1, fps)
    const rows = []
    const missingRows = []
    let cursor = 0
    for (const scene of yoloActivePlan || []) {
      for (const shot of scene?.shots || []) {
        const variant = variantByShotKey.get(`${scene?.id || ''}|${shot?.id || ''}`) || null
        const requestedDuration = Math.max(0.5, Number(shot?.durationSeconds ?? variant?.durationSeconds ?? 0) || 3)
        const workflowScopedKey = variant?.key ? getAdVideoVariantWorkflowKey(variant.key, workflowId) : ''
        const videoAsset = workflowScopedKey
          ? latestVideoAssetByKey.get(workflowScopedKey) || null
          : null
        const fallbackAsset = variant?.key ? latestVideoAssetByKey.get(variant.key) || null : null
        const selectedAsset = videoAsset || fallbackAsset
        if (!variant || !selectedAsset) {
          missingRows.push({ scene, shot, variant })
          cursor += requestedDuration
          continue
        }

        const sourceDuration = Number(selectedAsset?.settings?.duration ?? selectedAsset?.duration ?? requestedDuration)
        const safeDuration = Math.max(
          minClipDuration,
          Number.isFinite(sourceDuration) && sourceDuration > 0
            ? Math.min(requestedDuration || sourceDuration, sourceDuration)
            : requestedDuration
        )
        rows.push({
          scene,
          shot,
          variant,
          asset: selectedAsset,
          startTime: cursor,
          duration: safeDuration,
        })
        cursor += requestedDuration
      }
    }

    if (rows.length === 0) {
      const message = missingRows.length > 0
        ? `No ready ${workflowLabel} ad videos found yet. Generate videos first, then assemble the timeline.`
        : 'No ad shots found to assemble.'
      setFormError(message)
      return { ok: false, message }
    }

    const timelineState = useTimelineStore.getState()
    const previousAssemblyClipIds = (timelineState.clips || [])
      .filter((clip) => {
        const meta = clip?.metadata?.adTimelineAssembly
        if (meta?.mode !== AD_TIMELINE_ASSEMBLY_MODE) return false
        if (meta.kind === 'voiceover-audio') return true
        return String(meta.workflowId || '') === workflowId
      })
      .map((clip) => clip.id)
    const previousAssemblyClipIdSet = new Set(previousAssemblyClipIds)
    timelineState.saveToHistory?.()
    if (previousAssemblyClipIds.length > 0) {
      useTimelineStore.setState((state) => {
        const nextTransitions = (state.transitions || []).filter((transition) => (
          !previousAssemblyClipIdSet.has(transition.clipId)
          && !previousAssemblyClipIdSet.has(transition.clipAId)
          && !previousAssemblyClipIdSet.has(transition.clipBId)
        ))
        const selectedTransitionStillExists = nextTransitions.some((transition) => transition.id === state.selectedTransitionId)
        return {
          clips: state.clips.filter((clip) => !previousAssemblyClipIdSet.has(clip.id)),
          transitions: nextTransitions,
          selectedClipIds: state.selectedClipIds.filter((clipId) => !previousAssemblyClipIdSet.has(clipId)),
          selectedTransitionId: selectedTransitionStillExists ? state.selectedTransitionId : null,
        }
      })
    }

    const assembledAt = new Date().toISOString()
    const createdTrackIds = new Set()
    const getOrCreateTrack = (type, name, trackOptions = {}) => {
      let track = useTimelineStore.getState().tracks.find((candidate) => (
        candidate?.type === type && candidate?.name === name
      ))
      if (!track) {
        track = timelineAddTrack(type, { ...trackOptions, name })
        if (track?.id) createdTrackIds.add(track.id)
      }
      return track
    }

    let insertedVideoClips = 0
    const videoTrack = getOrCreateTrack('video', trackName)
    if (!videoTrack) {
      const message = 'Could not create an ad video track on the timeline.'
      setFormError(message)
      return { ok: false, message }
    }
    for (const row of rows) {
      const clip = timelineAddClip(videoTrack.id, row.asset, row.startTime, fps, {
        duration: row.duration,
        saveHistory: false,
        selectAfterAdd: false,
        resolveOverlaps: false,
        metadata: {
          adTimelineAssembly: {
            mode: AD_TIMELINE_ASSEMBLY_MODE,
            kind: 'video',
            assembledAt,
            workflowId,
            workflowLabel,
            sceneId: row.scene?.id || '',
            shotId: row.shot?.id || '',
            variantKey: row.variant?.key || '',
            assetId: row.asset?.id || '',
            startTime: row.startTime,
            length: row.duration,
          },
        },
      })
      if (clip) insertedVideoClips += 1
    }

    let insertedAudioClips = 0
    if (yoloAdVoiceoverAsset) {
      const audioTrack = getOrCreateTrack('audio', 'Ad - Voiceover', { channels: 'stereo' })
      const audioDuration = Number(yoloAdVoiceoverAsset?.settings?.duration || yoloAdVoiceoverAsset?.duration || cursor || 0) || undefined
      if (audioTrack) {
        const clip = timelineAddClip(audioTrack.id, yoloAdVoiceoverAsset, 0, fps, {
          duration: audioDuration,
          saveHistory: false,
          selectAfterAdd: false,
          resolveOverlaps: false,
          metadata: {
            adTimelineAssembly: {
              mode: AD_TIMELINE_ASSEMBLY_MODE,
              kind: 'voiceover-audio',
              assembledAt,
              assetId: yoloAdVoiceoverAsset.id,
              startTime: 0,
              length: audioDuration || null,
            },
          },
        })
        if (clip) insertedAudioClips += 1
      }
    }

    const message = [
      `Assembled ${insertedVideoClips} ${workflowLabel} ad video clip${insertedVideoClips === 1 ? '' : 's'}`,
      insertedAudioClips > 0 ? 'voiceover audio' : '',
      `in "${timelineResult.timelineName}"`,
      `on ${trackName}`,
      missingRows.length > 0 ? `${missingRows.length} missing/failed shot${missingRows.length === 1 ? '' : 's'} skipped` : '',
    ].filter(Boolean).join(' · ')

    setFormError(null)
    addComfyLog('status', `${message}.`)
    if (createdTrackIds.size > 0) {
      addComfyLog('status', `Created ${createdTrackIds.size} ad timeline track${createdTrackIds.size === 1 ? '' : 's'}.`)
    }
    return {
      ok: true,
      message,
      insertedVideoClips,
      insertedAudioClips,
      missingCount: missingRows.length,
      replacedCount: previousAssemblyClipIds.length,
      timelineName: timelineResult.timelineName,
      trackName,
    }
  }, [
    addComfyLog,
    assets,
    buildYoloMusicPlan,
    isYoloMusicMode,
    resolution.height,
    resolution.width,
    setFormError,
    timelineAddClip,
    timelineAddTrack,
    timelineFps,
    yoloActivePlan,
    yoloActivePlanIsStale,
    yoloAdBrandName,
    yoloAdLocalVideoWorkflowId,
    yoloAdProductName,
    yoloAdVoiceoverAsset,
    yoloDefaultVideoWorkflowId,
    yoloQueueVariants,
    yoloVideoFps,
  ])

  const handleAssembleMusicVideoTimeline = useCallback(async () => {
    if (!isYoloMusicMode) {
      return { ok: false, message: 'Switch to Music Video Creation first.' }
    }
    if (yoloActivePlanIsStale) {
      return { ok: false, message: 'Parse the current director script again before assembling the timeline.' }
    }
    if (!Array.isArray(yoloActivePlan) || yoloActivePlan.length === 0) {
      return { ok: false, message: 'Parse the director script before assembling the timeline.' }
    }
    if (!timelineAddClip || !timelineAddTrack) {
      return { ok: false, message: 'Timeline tools are not ready yet.' }
    }

    let planForAssembly = yoloActivePlan
    let variantsForAssembly = yoloQueueVariants
    const activeScriptContent = yoloMusicActiveAltScript
      ? yoloMusicActiveAltScript.script
      : yoloMusicScript
    if (hasMusicVideoCoverageSectionHeaders(activeScriptContent)) {
      const rebuiltPlan = buildYoloMusicPlan({ target: yoloMusicActiveScriptId || 'master' })
      if (Array.isArray(rebuiltPlan) && rebuiltPlan.length > 0) {
        planForAssembly = rebuiltPlan
        variantsForAssembly = flattenYoloPlanVariants(rebuiltPlan)
        addComfyLog('status', 'Re-read music-video coverage sections before assembling the timeline.')
      }
    }

    const timelineResolution = {
      width: Number(resolution.width) || null,
      height: Number(resolution.height) || null,
    }
    const timelineResolutionLabel = timelineResolution.width && timelineResolution.height
      ? `${timelineResolution.width}x${timelineResolution.height}`
      : ''
    const songName = String(yoloMusicAudioAsset?.name || 'Music Video').replace(/\.[a-z0-9]{2,5}$/i, '').trim()
    const timelineResult = await ensureGeneratedEditTimeline({
      name: buildGeneratedEditTimelineName('Music Video', [songName || 'Music Video', timelineResolutionLabel].filter(Boolean).join(' - ')),
      width: timelineResolution.width,
      height: timelineResolution.height,
      fps: Number(yoloVideoFps) || null,
      color: '#3b82f6',
    })
    if (!timelineResult.ok) {
      setFormError(timelineResult.message)
      return timelineResult
    }

    const variantByShotKey = new Map()
    for (const variant of variantsForAssembly || []) {
      const key = `${variant?.sceneId || ''}|${variant?.shotId || ''}`
      if (key !== '|' && !variantByShotKey.has(key)) variantByShotKey.set(key, variant)
    }

    const latestVideoAssetByKey = new Map()
    for (const asset of assets || []) {
      if (asset?.type !== 'video') continue
      if (asset?.yolo?.mode !== 'music' || asset?.yolo?.stage !== 'video') continue
      const keys = [asset?.yolo?.key, asset?.yolo?.variantKey].filter(Boolean)
      if (keys.length === 0) continue
      const assetTime = new Date(asset.createdAt || 0).getTime()
      for (const key of keys) {
        const existing = latestVideoAssetByKey.get(key)
        const existingTime = existing ? new Date(existing.createdAt || 0).getTime() : -1
        if (!existing || assetTime >= existingTime) latestVideoAssetByKey.set(key, asset)
      }
    }

    const fps = Number(useTimelineStore.getState().timelineFps) || Number(timelineFps) || Number(yoloVideoFps) || 24
    const minClipDuration = 1 / Math.max(1, fps)
    const groups = new Map()
    const missingRows = []
    let scannedShots = 0

    for (const scene of planForAssembly) {
      for (const shot of scene?.shots || []) {
        scannedShots += 1
        const variant = variantByShotKey.get(`${scene?.id || ''}|${shot?.id || ''}`) || null
        const videoAsset = variant?.key ? latestVideoAssetByKey.get(variant.key) || null : null
        if (!variant || !videoAsset) {
          missingRows.push({ scene, shot, variant })
          continue
        }

        const coverage = variant.coverage && typeof variant.coverage === 'object'
          ? variant.coverage
          : {
            type: String(shot?.coverageType || scene?.coverageType || '').trim(),
            label: String(shot?.coverageLabel || scene?.coverageLabel || '').trim(),
          }
        const coverageLabel = getMusicVideoTimelineCoverageLabel(coverage, scene?.label || shot?.scriptShotLabel || '')
        const coverageKey = normalizeMusicVideoCoverageTrackKey(`${coverage.type || ''}-${coverageLabel}`)
        const trackName = getMusicVideoTimelineTrackName({ ...coverage, label: coverageLabel })
        const startTime = Math.max(0, Number(shot?.audioStart ?? 0) || 0)
        const requestedDuration = Number(shot?.length ?? shot?.durationSeconds ?? variant?.durationSeconds ?? 0) || 0
        const sourceDuration = Number(videoAsset?.settings?.duration ?? videoAsset?.duration ?? requestedDuration)
        const safeDuration = Math.max(
          minClipDuration,
          Number.isFinite(sourceDuration) && sourceDuration > 0
            ? Math.min(requestedDuration || sourceDuration, sourceDuration)
            : (requestedDuration || 5)
        )

        if (!groups.has(coverageKey)) {
          groups.set(coverageKey, {
            key: coverageKey,
            coverage,
            label: coverageLabel,
            trackName,
            rows: [],
          })
        }
        groups.get(coverageKey).rows.push({
          scene,
          shot,
          variant,
          asset: videoAsset,
          startTime,
          duration: safeDuration,
          coverage,
          coverageLabel,
        })
      }
    }

    const readyClipCount = Array.from(groups.values()).reduce((sum, group) => sum + group.rows.length, 0)
    if (readyClipCount === 0) {
      return {
        ok: false,
        message: scannedShots > 0
          ? 'No ready music-video clips found yet. Generate at least one video first.'
          : 'No parsed music-video shots found yet.',
        missingCount: missingRows.length,
      }
    }

    const timelineState = useTimelineStore.getState()
    const projectAssetById = new Map((assets || []).filter((asset) => asset?.id).map((asset) => [asset.id, asset]))
    const getMusicVideoClipAssemblyKey = (clip) => {
      const assembly = clip?.metadata?.musicVideoAssembly || null
      const asset = clip?.assetId ? projectAssetById.get(clip.assetId) : null
      const yolo = asset?.yolo || asset?.settings?.yolo || null
      const variantKey = assembly?.variantKey || yolo?.variantKey || yolo?.key || ''
      if (variantKey) return 'variant:' + variantKey
      const sceneId = assembly?.sceneId || yolo?.sceneId || ''
      const shotId = assembly?.shotId || yolo?.shotId || ''
      if (sceneId || shotId) return 'shot:' + sceneId + '|' + shotId
      const assetId = assembly?.assetId || clip?.assetId || ''
      return assetId ? 'asset:' + assetId : ''
    }
    const existingVideoAssemblyKeys = new Set(
      (timelineState.clips || [])
        .filter((clip) => {
          if (clip?.type !== 'video') return false
          const assembly = clip?.metadata?.musicVideoAssembly || null
          if (assembly?.mode === MUSIC_VIDEO_TIMELINE_ASSEMBLY_MODE && assembly?.kind === 'video') return true
          const asset = clip?.assetId ? projectAssetById.get(clip.assetId) : null
          const yolo = asset?.yolo || asset?.settings?.yolo || null
          return yolo?.mode === 'music' && yolo?.stage === 'video'
        })
        .map(getMusicVideoClipAssemblyKey)
        .filter(Boolean)
    )
    const initialExistingVideoAssemblyCount = existingVideoAssemblyKeys.size
    const existingSongAudio = (timelineState.clips || []).some((clip) => (
      clip?.metadata?.musicVideoAssembly?.mode === MUSIC_VIDEO_TIMELINE_ASSEMBLY_MODE
      && clip?.metadata?.musicVideoAssembly?.kind === 'song-audio'
    ))
    timelineState.saveToHistory?.()

    const assembledAt = new Date().toISOString()
    const createdTrackIds = new Set()
    const getOrCreateTrack = (type, name, options = {}) => {
      let track = useTimelineStore.getState().tracks.find((candidate) => (
        candidate?.type === type && candidate?.name === name
      ))
      if (!track) {
        track = timelineAddTrack(type, { ...options, name })
        if (track?.id) createdTrackIds.add(track.id)
      }
      return track
    }

    let insertedVideoClips = 0
    for (const group of groups.values()) {
      const track = getOrCreateTrack('video', group.trackName)
      if (!track) continue
      for (const row of group.rows) {
        const rowAssemblyKey = row.variant?.key
          ? 'variant:' + row.variant.key
          : (row.scene?.id || row.shot?.id
            ? 'shot:' + (row.scene?.id || '') + '|' + (row.shot?.id || '')
            : (row.asset?.id ? 'asset:' + row.asset.id : ''))
        if (rowAssemblyKey && existingVideoAssemblyKeys.has(rowAssemblyKey)) continue
        const shotType = row.shot?.musicShotType || row.variant?.musicShotType || row.asset?.yolo?.shotType || ''
        const shotTypeOption = getMusicVideoShotTypeOption(shotType)
        const syncLock = shotTypeOption?.needsVocalAlignment ? {
          source: 'music-video',
          reason: 'song-sync',
          startTime: row.startTime,
          audioStart: row.startTime,
          duration: row.duration,
          length: row.duration,
          shotType,
          sceneId: row.scene?.id || '',
          shotId: row.shot?.id || '',
          variantKey: row.variant?.key || row.asset?.yolo?.variantKey || '',
        } : null
        const clip = timelineAddClip(track.id, row.asset, row.startTime, fps, {
          duration: row.duration,
          saveHistory: false,
          selectAfterAdd: false,
          resolveOverlaps: false,
          ...(syncLock ? { syncLock } : {}),
          metadata: {
            musicVideoAssembly: {
              mode: MUSIC_VIDEO_TIMELINE_ASSEMBLY_MODE,
              kind: 'video',
              assembledAt,
              coverageType: String(row.coverage?.type || ''),
              coverageLabel: row.coverageLabel,
              sceneId: row.scene?.id || '',
              shotId: row.shot?.id || '',
              variantKey: row.variant?.key || '',
              assetId: row.asset?.id || '',
              audioStart: row.startTime,
              length: row.duration,
            },
          },
        })
        if (clip) {
          insertedVideoClips += 1
          if (rowAssemblyKey) existingVideoAssemblyKeys.add(rowAssemblyKey)
        }
      }
    }

    let insertedAudioClips = 0
    if (yoloMusicAudioAsset && !existingSongAudio) {
      const audioTrack = getOrCreateTrack('audio', 'MV - Song', { channels: 'stereo' })
      const audioDuration = Number(yoloMusicSongDurationSeconds || yoloMusicAudioAsset?.settings?.duration || yoloMusicAudioAsset?.duration || 0) || undefined
      if (audioTrack) {
        const clip = timelineAddClip(audioTrack.id, yoloMusicAudioAsset, 0, fps, {
          duration: audioDuration,
          saveHistory: false,
          selectAfterAdd: false,
          resolveOverlaps: false,
          metadata: {
            musicVideoAssembly: {
              mode: MUSIC_VIDEO_TIMELINE_ASSEMBLY_MODE,
              kind: 'song-audio',
              assembledAt,
              assetId: yoloMusicAudioAsset.id,
              audioStart: 0,
              length: audioDuration || null,
            },
          },
        })
        if (clip) insertedAudioClips += 1
      }
    }

    const message = [
      `Assembled ${insertedVideoClips} video clip${insertedVideoClips === 1 ? '' : 's'}`,
      insertedAudioClips > 0 ? 'song audio' : '',
      `in "${timelineResult.timelineName}"`,
      `on ${groups.size} coverage track${groups.size === 1 ? '' : 's'}`,
      initialExistingVideoAssemblyCount > 0 ? `${initialExistingVideoAssemblyCount} existing clip${initialExistingVideoAssemblyCount === 1 ? '' : 's'} kept` : '',
      missingRows.length > 0 ? `${missingRows.length} missing/failed shot${missingRows.length === 1 ? '' : 's'} skipped` : '',
    ].filter(Boolean).join(' · ')

    setFormError(null)
    addComfyLog('status', `${message}.`)
    if (createdTrackIds.size > 0) {
      addComfyLog('status', `Created ${createdTrackIds.size} music-video timeline track${createdTrackIds.size === 1 ? '' : 's'}.`)
    }
    return {
      ok: true,
      message,
      insertedVideoClips,
      insertedAudioClips,
      missingCount: missingRows.length,
      replacedCount: 0,
      keptExistingClipCount: initialExistingVideoAssemblyCount,
      timelineName: timelineResult.timelineName,
      trackCount: groups.size,
    }
  }, [
    addComfyLog,
    assets,
    isYoloMusicMode,
    resolution.height,
    resolution.width,
    setFormError,
    timelineAddClip,
    timelineAddTrack,
    timelineFps,
    yoloActivePlan,
    yoloActivePlanIsStale,
    yoloMusicActiveAltScript,
    yoloMusicActiveScriptId,
    yoloMusicAudioAsset,
    yoloMusicScript,
    yoloMusicSongDurationSeconds,
    yoloQueueVariants,
    yoloVideoFps,
  ])

  const handleMusicStyleCardApply = useCallback((notes) => {
    const snippet = String(notes || '').trim()
    if (!snippet) return
    setYoloMusicStyleNotes((current) => {
      const existing = String(current || '').trim()
      if (!existing) return snippet
      if (existing.includes(snippet)) return existing
      return `${existing}\n${snippet}`
    })
  }, [])

  const handleMusicAltScriptDelete = useCallback((slotId) => {
    const target = yoloMusicAltScripts.find((entry) => entry.id === slotId)
    if (!target) return
    const hasContent = Boolean(String(target.script || '').trim())
    // Only prompt for confirmation when the user would lose pasted work.
    // Empty slots delete silently since they were likely created by an
    // accidental click and are costless to recreate.
    if (hasContent && !window.confirm(`Delete "${target.label}"? This cannot be undone.`)) {
      return
    }
    setYoloMusicAltScripts((prev) => prev.filter((entry) => entry.id !== slotId))
    setYoloMusicActiveScriptId((currentId) => (currentId === slotId ? null : currentId))
  }, [yoloMusicAltScripts])

  const queueYoloStoryboardVariants = useCallback(async (variants, options = {}) => {
    const {
      allowExistingDoneKeys = false,
      skipConfirm = false,
      sourceLabel = `${DIRECTOR_MODE_BETA_LABEL} ${yoloModeLabel.toLowerCase()} keyframe pass`,
      productAssetIdOverride = undefined,
      modelAssetIdOverride = undefined,
      resolutionOverride = null,
    } = options

    if (!Array.isArray(variants) || variants.length === 0) {
      setFormError('No queueable shots. Build a plan first.')
      return 0
    }

    const existingKeys = getExistingYoloStageKeys('storyboard')
    const activeStoryboardKeys = new Set(
      generationQueue
        .filter((job) => (
          job?.yolo?.stage === 'storyboard' &&
          NON_TERMINAL_JOB_STATUSES.includes(job.status) &&
          job?.yolo?.key
        ))
        .map((job) => job.yolo.key)
    )
    const variantsToQueue = variants.filter((variant) => {
      if (!variant?.key) return false
      if (activeStoryboardKeys.has(variant.key)) return false
      if (!allowExistingDoneKeys && existingKeys.has(variant.key)) return false
      return true
    })

    if (variantsToQueue.length === 0) {
      setFormError(
        allowExistingDoneKeys
          ? 'Selected shot is already queued/running. Wait for it to finish, then try again.'
          : 'All selected keyframe variants are already in this queue/run.'
      )
      return 0
    }

    if (!skipConfirm) {
      const confirmed = await confirmLargeQueueBatch(variantsToQueue.length, 'keyframe')
      if (!confirmed) {
        setFormError('Queue cancelled')
        return 0
      }
    }

    const extractNumericId = (value, fallback = 1) => {
      const match = String(value || '').match(/\d+/)
      const parsed = match ? Number(match[0]) : fallback
      return Number.isFinite(parsed) ? parsed : fallback
    }
    const usesModelProductStoryboardWorkflow = yoloStoryboardWorkflowId === 'image-edit-model-product'
    const usesQwenMusicStoryboardWorkflow = isYoloMusicMode && yoloStoryboardWorkflowId === 'image-edit'
    const musicImageAssetById = new Map(
      (assets || [])
        .filter((asset) => asset?.type === 'image')
        .map((asset) => [asset.id, asset])
    )
    const findExistingMusicImageAssetId = (ids = []) => {
      for (const assetId of ids) {
        if (assetId && musicImageAssetById.has(assetId)) return assetId
      }
      return null
    }
    const defaultMusicReferenceAssetId = findExistingMusicImageAssetId([
      ...yoloMusicResolvedCast.map((entry) => entry?.assetId),
      yoloMusicArtistAsset?.id,
    ])
    const resolveQwenMusicStoryboardReferences = (variant) => {
      const resolvedArtistAssetIds = Array.isArray(variant?.resolvedArtistAssetIds)
        ? variant.resolvedArtistAssetIds.filter(Boolean)
        : []
      const primaryAssetId = findExistingMusicImageAssetId([
        ...resolvedArtistAssetIds,
        defaultMusicReferenceAssetId,
      ])
      const secondaryAssetId = findExistingMusicImageAssetId(
        resolvedArtistAssetIds.filter((assetId) => assetId !== primaryAssetId)
      )
      return { primaryAssetId, secondaryAssetId }
    }
    if (usesQwenMusicStoryboardWorkflow) {
      const missingReference = variantsToQueue.some((variant) => (
        !resolveQwenMusicStoryboardReferences(variant).primaryAssetId
      ))
      if (missingReference) {
        setFormError('Qwen Image Edit keyframes need a cast/reference image. Add at least one person in the Music Video People step, or switch keyframes to Nano Banana 2.')
        return 0
      }
    }
    const effectiveAdProductAsset = productAssetIdOverride !== undefined
      ? (assets.find((asset) => asset?.id === productAssetIdOverride) || null)
      : yoloAdProductAsset
    const effectiveAdModelAsset = modelAssetIdOverride !== undefined
      ? (assets.find((asset) => asset?.id === modelAssetIdOverride) || null)
      : yoloAdModelAsset
    const adStoryboardInputAsset = usesModelProductStoryboardWorkflow
      ? (effectiveAdModelAsset || effectiveAdProductAsset || null)
      : null
    const storyboardResolution = {
      width: Number(resolutionOverride?.width) || effectiveImageResolution.width,
      height: Number(resolutionOverride?.height) || effectiveImageResolution.height,
    }
    const jobs = variantsToQueue.map((variant, index) => {
      const sceneNum = extractNumericId(variant.sceneId, index + 1)
      const shotNum = extractNumericId(variant.shotId, 1)
      const angleNum = extractNumericId(variant.angle, 1)
      const takeNum = extractNumericId(variant.take, 1)
      // Keep consistency behavior, but ensure each take gets a distinct seed.
      const strictSeed = Number(seed) + (sceneNum * 1000) + (shotNum * 10) + takeNum
      const mediumSeed = Number(seed) + (sceneNum * 100000) + (shotNum * 1000) + (angleNum * 100) + (takeNum * 10)
      const softSeed = Number(seed) + index + 1
      const storyboardSeed = (
        yoloAdConsistency === 'strict'
          ? strictSeed
          : yoloAdConsistency === 'medium'
            ? mediumSeed
            : softSeed
      )
      const qwenMusicReferences = usesQwenMusicStoryboardWorkflow
        ? resolveQwenMusicStoryboardReferences(variant)
        : { primaryAssetId: null, secondaryAssetId: null }
      const musicReferenceAssetId1 = isYoloMusicMode
        ? (
          usesQwenMusicStoryboardWorkflow
            ? qwenMusicReferences.primaryAssetId
            : (variant.resolvedArtistAssetIds?.[0] || yoloMusicArtistAsset?.id || null)
        )
        : null
      const musicReferenceAssetId2 = isYoloMusicMode
        ? (
          usesQwenMusicStoryboardWorkflow
            ? qwenMusicReferences.secondaryAssetId
            : (variant.resolvedArtistAssetIds?.[1] || null)
        )
        : null
      const qwenMusicInputAsset = usesQwenMusicStoryboardWorkflow && musicReferenceAssetId1
        ? (musicImageAssetById.get(musicReferenceAssetId1) || null)
        : null
      const storyboardInputAsset = usesModelProductStoryboardWorkflow
        ? adStoryboardInputAsset
        : qwenMusicInputAsset
      const storyboardReferenceAssetId1 = isYoloMusicMode
        ? (usesQwenMusicStoryboardWorkflow ? musicReferenceAssetId2 : musicReferenceAssetId1)
        : (effectiveAdProductAsset?.id || null)
      const storyboardReferenceAssetId2 = isYoloMusicMode
        ? (usesQwenMusicStoryboardWorkflow ? null : musicReferenceAssetId2)
        : (effectiveAdModelAsset?.id || null)
      return createQueuedJob({
        category: 'image',
        workflowId: yoloStoryboardWorkflowId,
        workflowLabel: `${DIRECTOR_MODE_BETA_LABEL} ${yoloModeLabel} Keyframe (${yoloStoryboardWorkflowId})`,
        needsImage: usesModelProductStoryboardWorkflow || Boolean(qwenMusicInputAsset),
        prompt: variant.storyboardPrompt || variant.prompt,
        seed: storyboardSeed,
        resolution: storyboardResolution,
        inputAssetId: storyboardInputAsset?.id || null,
        inputAssetName: storyboardInputAsset?.name || '',
        inputFromTimelineFrame: false,
        // Music mode routes resolved cast refs from Artist: overrides and
        // lyric [Name] tags. Qwen uses the first cast image as the primary
        // edit input, so only additional cast images go into reference slots.
        referenceAssetId1: storyboardReferenceAssetId1,
        referenceAssetId2: storyboardReferenceAssetId2,
        directorLabel: yoloQueueNameLabel,
        yolo: {
          mode: yoloModeKey,
          stage: 'storyboard',
          key: variant.key,
          sceneId: variant.sceneId,
          shotId: variant.shotId,
          angle: variant.angle,
          take: variant.take,
          durationSeconds: variant.durationSeconds,
          adBeat: !isYoloMusicMode ? (variant.adBeat || '') : '',
          productMode: !isYoloMusicMode ? (variant.productMode || '') : '',
          talentMode: !isYoloMusicMode ? (variant.talentMode || '') : '',
          textOverlay: !isYoloMusicMode ? (variant.textOverlay || '') : '',
          endCard: !isYoloMusicMode ? (variant.endCard || '') : '',
          dialogue: !isYoloMusicMode ? (variant.dialogue || '') : '',
          profile: isYoloMusicMode ? yoloMusicQualityProfile : yoloNormalizedAdStoryboardTier,
          profileRuntime: !isYoloMusicMode ? yoloStoryboardProfileRuntime : null,
          referenceConsistency: !isYoloMusicMode ? yoloAdConsistency : null,
          // Origin pass (music mode only). flattenYoloPlanVariants threads this
          // through from the scene; the importer writes it onto the asset so
          // the UI can show a pass badge and future filters can group by pass.
          pass: (isYoloMusicMode && variant?.pass && typeof variant.pass === 'object') ? variant.pass : null,
          coverage: (isYoloMusicMode && variant?.coverage && typeof variant.coverage === 'object') ? variant.coverage : null,
        },
      })
    })

    setGenerationQueue(prev => [...prev, ...jobs])
    setFormError(null)
    addComfyLog('status', `${sourceLabel} queued: ${jobs.length} job${jobs.length === 1 ? '' : 's'}`)
    return jobs.length
  }, [
    addComfyLog,
    confirmLargeQueueBatch,
    createQueuedJob,
    generationQueue,
    getExistingYoloStageKeys,
    isYoloMusicMode,
    negativePrompt,
    seed,
    assets,
    yoloAdConsistency,
    yoloAdModelAsset,
    yoloAdModelAsset?.id,
    effectiveImageResolution.height,
    effectiveImageResolution.width,
    yoloMusicArtistAsset,
    yoloMusicArtistAsset?.id,
    yoloMusicResolvedCast,
    yoloMusicQualityProfile,
    yoloNormalizedAdStoryboardTier,
    yoloAdProductAsset,
    yoloAdProductAsset?.id,
    yoloModeKey,
    yoloModeLabel,
    yoloStoryboardProfileRuntime,
    yoloStoryboardWorkflowId,
    yoloQueueNameLabel,
  ])

  const handleQueueYoloStoryboards = useCallback(async (options = {}) => {
    const {
      planOverride = null,
      skipStaleCheck = false,
      skipConfirm = false,
      sourceLabel = `${DIRECTOR_MODE_BETA_LABEL} ${yoloModeLabel.toLowerCase()} keyframe pass`,
      allowExistingDoneKeys = false,
      productAssetIdOverride = undefined,
      modelAssetIdOverride = undefined,
      resolutionOverride = null,
    } = options || {}
    if (!isConnected) {
      setFormError('ComfyUI is not connected yet. Start ComfyUI, then queue keyframes.')
      return 0
    }
    if (yoloActivePlanIsStale && !skipStaleCheck) {
      setFormError('Director plan is out of date. Click Build Plan again to apply the current script, references, and style settings.')
      setDirectorSubTab('plan-script')
      return 0
    }
    const effectiveProductAsset = productAssetIdOverride !== undefined
      ? (assets.find((asset) => asset?.id === productAssetIdOverride) || null)
      : yoloAdProductAsset
    const effectiveModelAsset = modelAssetIdOverride !== undefined
      ? (assets.find((asset) => asset?.id === modelAssetIdOverride) || null)
      : yoloAdModelAsset
    if (
      !isYoloMusicMode &&
      ['image-edit-model-product', 'seedream-5-lite-image-edit'].includes(String(yoloStoryboardWorkflowId || '').trim()) &&
      !effectiveModelAsset &&
      !effectiveProductAsset
    ) {
      setFormError('Selected keyframe workflow needs at least a model or product reference image.')
      return 0
    }
    if (
      !isYoloMusicMode &&
      yoloAdHasReferenceAnchors &&
      !yoloStoryboardSupportsReferenceAnchors
    ) {
      setFormError(`Product/model references are not supported by ${getWorkflowDisplayLabel(yoloStoryboardWorkflowId)} keyframes.`)
      return 0
    }
    const depsOk = await validateDependenciesForQueue(
      [yoloStoryboardWorkflowId],
      sourceLabel
    )
    if (!depsOk) return 0

    const planToUse = Array.isArray(planOverride) && planOverride.length > 0
      ? planOverride
      : (yoloActivePlan.length > 0 ? yoloActivePlan : buildActiveYoloPlan())
    if (!planToUse) return 0

    const variants = flattenYoloPlanVariants(planToUse)
    return await queueYoloStoryboardVariants(variants, {
      allowExistingDoneKeys,
      skipConfirm,
      sourceLabel,
      productAssetIdOverride,
      modelAssetIdOverride,
      resolutionOverride,
    })
  }, [
    assets,
    buildActiveYoloPlan,
    isConnected,
    isYoloMusicMode,
    queueYoloStoryboardVariants,
    yoloActivePlanIsStale,
    validateDependenciesForQueue,
    yoloActivePlan,
    yoloAdModelAsset,
    yoloAdHasReferenceAnchors,
    yoloAdProductAsset,
    yoloStoryboardSupportsReferenceAnchors,
    yoloStoryboardWorkflowId,
    yoloModeLabel,
  ])

  const handleQueueYoloShotStoryboard = useCallback(async (sceneId, shotId, options = {}) => {
    const {
      resolutionOverride = null,
    } = options || {}
    if (!isConnected) return
    if (yoloActivePlanIsStale) {
      setFormError('Director plan is out of date. Click Build Plan again before re-rendering keyframes.')
      setDirectorSubTab('plan-script')
      return
    }
    if (
      !isYoloMusicMode &&
      yoloAdHasReferenceAnchors &&
      !yoloStoryboardSupportsReferenceAnchors
    ) {
      setFormError(`Product/model references are not supported by ${getWorkflowDisplayLabel(yoloStoryboardWorkflowId)} keyframes.`)
      return
    }
    if (
      !isYoloMusicMode &&
      ['image-edit-model-product', 'seedream-5-lite-image-edit'].includes(String(yoloStoryboardWorkflowId || '').trim()) &&
      !yoloAdModelAsset &&
      !yoloAdProductAsset
    ) {
      setFormError('Selected keyframe workflow needs at least a model or product reference image.')
      return
    }
    const depsOk = await validateDependenciesForQueue(
      [yoloStoryboardWorkflowId],
      `keyframe re-render for ${sceneId} ${shotId}`
    )
    if (!depsOk) return

    const planToUse = yoloActivePlan.length > 0 ? yoloActivePlan : buildActiveYoloPlan()
    if (!planToUse) return

    const variants = flattenYoloPlanVariants(planToUse)
      .filter((variant) => variant.sceneId === sceneId && variant.shotId === shotId)
    if (variants.length === 0) {
      setFormError(`No keyframe variants found for ${sceneId} ${shotId}.`)
      return
    }

    await queueYoloStoryboardVariants(variants, {
      allowExistingDoneKeys: true,
      skipConfirm: true,
      sourceLabel: `Queued keyframe re-render for ${sceneId} ${shotId}`,
      resolutionOverride,
    })
  }, [
    buildActiveYoloPlan,
    isConnected,
    isYoloMusicMode,
    queueYoloStoryboardVariants,
    yoloActivePlanIsStale,
    validateDependenciesForQueue,
    yoloActivePlan,
    yoloAdHasReferenceAnchors,
    yoloAdModelAsset,
    yoloAdProductAsset,
    yoloStoryboardSupportsReferenceAnchors,
    yoloStoryboardWorkflowId,
  ])

  const queueYoloVideoVariants = useCallback(async (variants, options = {}) => {
    const {
      allowExistingDoneKeys = false,
      skipConfirm = false,
      workflowId = yoloDefaultVideoWorkflowId,
      suppressEmptyError = false,
      sourceLabel = `${DIRECTOR_MODE_BETA_LABEL} ${yoloModeLabel.toLowerCase()} video pass`,
      resolutionOverride = null,
    } = options

    if (!Array.isArray(variants) || variants.length === 0) {
      if (!suppressEmptyError) setFormError('No queueable shots. Build a plan first.')
      return 0
    }

    const adVariantNeedsLipSync = (variant) => {
      if (isYoloMusicMode) return false
      if (!yoloAdVoiceoverAssetId) return false
      const talent = String(variant?.talentMode || '').toLowerCase()
      const hasTalkingTalent = talent.includes('spokesperson') || talent.includes('testimonial')
      return hasTalkingTalent && Boolean(String(variant?.dialogue || '').trim())
    }
    const resolveVariantWorkflowId = (variant) => (
      adVariantNeedsLipSync(variant) ? MUSIC_VIDEO_SHOT_WORKFLOW_ID : workflowId
    )
    const buildVideoVariantKey = (variantKey, variantWorkflowId = workflowId) => `${String(variantKey || '')}::${variantWorkflowId}`
    const existingKeys = getExistingYoloStageKeys('video')
    const activeVideoKeys = new Set(
      generationQueue
        .filter((job) => (
          job?.yolo?.stage === 'video' &&
          NON_TERMINAL_JOB_STATUSES.includes(job.status) &&
          job?.yolo?.key
        ))
        .map((job) => job.yolo.key)
    )
    const variantsToQueue = variants.filter((variant) => {
      if (!variant?.key) return false
      const variantScopedKey = buildVideoVariantKey(variant.key, resolveVariantWorkflowId(variant))
      if (activeVideoKeys.has(variantScopedKey) || activeVideoKeys.has(variant.key)) return false
      if (!allowExistingDoneKeys && (existingKeys.has(variantScopedKey) || existingKeys.has(variant.key))) return false
      return true
    })

    // Build a lookup from variant.key back to the source shot so we can pull
    // music-video-specific fields (musicShotType, audioStart, shotPrompt, etc.)
    // without coupling flattenYoloPlanVariants to music-video concepts.
    const musicShotByKey = new Map()
    if (isYoloMusicMode) {
      for (const scene of yoloActivePlan || []) {
        for (const shot of scene?.shots || []) {
          // variant keys have the form `${sceneId}|${shotId}|${angle}|T${take}`.
          // Music-video shots always flatten to one variant: angle='Medium shot', take=1.
          const angle = Array.isArray(shot?.angles) && shot.angles.length > 0 ? shot.angles[0] : 'Medium shot'
          const key = `${scene.id}|${shot.id}|${angle}|T1`
          musicShotByKey.set(key, shot)
        }
      }
    }

    const jobs = []
    let missing = 0
    let seedOffset = 0
    const videoResolution = {
      width: Number(resolutionOverride?.width) || resolution.width,
      height: Number(resolutionOverride?.height) || resolution.height,
    }
    for (const variant of variantsToQueue) {
      const storyboardAsset = yoloStoryboardAssetMap.get(variant.key)
      if (!storyboardAsset) {
        missing += 1
        continue
      }
      seedOffset += 1
      const effectiveWorkflowId = resolveVariantWorkflowId(variant)
      const videoDurationOptions = getVideoDurationPresets(effectiveWorkflowId)
      const videoDuration = videoDurationOptions.reduce((closest, candidate) => (
        Math.abs(candidate - variant.durationSeconds) < Math.abs(closest - variant.durationSeconds) ? candidate : closest
      ), videoDurationOptions[0])
      const isAdLipSyncShot = !isYoloMusicMode && effectiveWorkflowId === MUSIC_VIDEO_SHOT_WORKFLOW_ID
      const variantScopedKey = buildVideoVariantKey(variant.key, effectiveWorkflowId)
      // Same set as yoloSelectedVideoWorkflowSupportsCustomFps — only
      // workflows whose modify*Workflow helper accepts an fps input
      // get the user's YOLO FPS setting; cloud providers ignore it.
      const customFpsWorkflowIds = new Set(['wan22-i2v', 'ltx23-i2v', MUSIC_VIDEO_SHOT_WORKFLOW_ID])
      const requestedFps = customFpsWorkflowIds.has(String(effectiveWorkflowId || '').trim())
        ? (Number(yoloVideoFps) || 24)
        : null

      // Music-video-specific payload threaded into the job, consumed by the
      // music-video case in runJob's switch.
      const musicShot = isYoloMusicMode ? musicShotByKey.get(variant.key) : null
      const musicShotPayload = musicShot ? normalizeMusicVideoShot({
        shotType: musicShot.musicShotType,
        audioStart: musicShot.audioStart,
        length: musicShot.length || musicShot.durationSeconds,
        shotPrompt: musicShot.shotPrompt || musicShot.videoBeat || musicShot.beat,
        referenceImagePrompt: musicShot.referenceImagePrompt,
      }) : isAdLipSyncShot ? normalizeMusicVideoShot({
        shotType: 'performance',
        audioStart: 0,
        length: variant.durationSeconds || videoDuration,
        shotPrompt: [
          buildAdVideoPromptWithNoTextGuard(variant.videoPrompt || variant.prompt, {
            omitTerms: [yoloAdBrandName, yoloAdProductName],
          }),
          variant.dialogue ? `The spokesperson lip-syncs this dialogue naturally: "${variant.dialogue}".` : '',
          'Believable commercial facial performance, natural mouth sync, direct-to-camera delivery when appropriate.',
        ].filter(Boolean).join(' '),
        referenceImagePrompt: variant.storyboardPrompt || variant.prompt,
      }) : null

      const adVideoPrompt = !isYoloMusicMode
        ? buildAdVideoPromptWithNoTextGuard(variant.videoPrompt || variant.prompt, {
          omitTerms: [yoloAdBrandName, yoloAdProductName],
        })
        : null
      jobs.push(createQueuedJob({
        category: 'video',
        workflowId: effectiveWorkflowId,
        workflowLabel: `${DIRECTOR_MODE_BETA_LABEL} ${yoloModeLabel} Video (${getWorkflowDisplayLabel(effectiveWorkflowId)})`,
        needsImage: true,
        inputAssetId: storyboardAsset.id,
        inputAssetName: storyboardAsset.name || variant.key,
        inputFromTimelineFrame: false,
        prompt: musicShotPayload?.shotPrompt || adVideoPrompt || variant.videoPrompt || variant.prompt,
        negativePrompt: !isYoloMusicMode
          ? buildAdVideoNegativePrompt(negativePrompt)
          : buildMusicVideoNegativePrompt(negativePrompt, musicShotPayload?.shotType),
        duration: musicShotPayload?.length || videoDuration,
        fps: requestedFps,
        seed: Number(seed) + seedOffset,
        resolution: videoResolution,
        referenceAssetId1: null,
        referenceAssetId2: null,
        directorLabel: yoloQueueNameLabel,
        // Carry the song audio asset id + mode-specific audio metadata so runJob
        // can upload it once per job and pass the uploaded filename into the
        // music-video workflow modifier.
        musicAudioAssetId: isYoloMusicMode ? yoloMusicAudioAssetId : (isAdLipSyncShot ? yoloAdVoiceoverAssetId : null),
        musicAudioKind: isYoloMusicMode ? yoloMusicAudioKind : (isAdLipSyncShot ? 'vocal_stem' : null),
        musicShot: musicShotPayload,
        yolo: {
          mode: yoloModeKey,
          stage: 'video',
          key: variantScopedKey,
          variantKey: variant.key,
          workflowId: effectiveWorkflowId,
          sceneId: variant.sceneId,
          shotId: variant.shotId,
          angle: variant.angle,
          take: variant.take,
          durationSeconds: variant.durationSeconds,
          adBeat: !isYoloMusicMode ? (variant.adBeat || '') : '',
          productMode: !isYoloMusicMode ? (variant.productMode || '') : '',
          talentMode: !isYoloMusicMode ? (variant.talentMode || '') : '',
          textOverlay: !isYoloMusicMode ? (variant.textOverlay || '') : '',
          endCard: !isYoloMusicMode ? (variant.endCard || '') : '',
          dialogue: !isYoloMusicMode ? (variant.dialogue || '') : '',
          profile: isYoloMusicMode ? yoloMusicQualityProfile : yoloNormalizedAdVideoTier,
          profileRuntime: !isYoloMusicMode ? (isAdLipSyncShot ? 'local' : yoloVideoProfileRuntime) : null,
          // Origin pass, mirrored from the keyframe stage so videos
          // inherit the same badge/filename token as their keyframe.
          pass: (isYoloMusicMode && variant?.pass && typeof variant.pass === 'object') ? variant.pass : null,
          coverage: (isYoloMusicMode && variant?.coverage && typeof variant.coverage === 'object') ? variant.coverage : null,
        },
      }))
    }

    if (jobs.length === 0) {
      if (!suppressEmptyError) {
        setFormError(
          variantsToQueue.length === 0
            ? (
              allowExistingDoneKeys
                ? 'Selected shot video is already queued/running. Wait for it to finish, then try again.'
                : 'All selected video variants are already in this queue/run.'
            )
            : 'No keyframe images found yet. Queue or re-render keyframes first, then queue video.'
        )
      }
      return 0
    }

    if (!skipConfirm) {
      const confirmed = await confirmLargeQueueBatch(jobs.length, 'video')
      if (!confirmed) {
        setFormError('Queue cancelled')
        return 0
      }
    }

    setGenerationQueue(prev => [...prev, ...jobs])
    setFormError(missing > 0 ? `Queued ${jobs.length} video jobs (${missing} variants still missing keyframe images)` : null)
    addComfyLog('status', `${sourceLabel} queued: ${jobs.length} job${jobs.length === 1 ? '' : 's'}${missing > 0 ? ` (${missing} missing)` : ''}`)
    return jobs.length
  }, [
    addComfyLog,
    confirmLargeQueueBatch,
    createQueuedJob,
    generationQueue,
    getExistingYoloStageKeys,
    isYoloMusicMode,
    negativePrompt,
    seed,
    resolution.height,
    resolution.width,
    yoloActivePlan,
    yoloAdBrandName,
    yoloAdProductName,
    yoloAdVoiceoverAssetId,
    yoloDefaultVideoWorkflowId,
    yoloMusicAudioAssetId,
    yoloMusicAudioKind,
    yoloMusicQualityProfile,
    yoloNormalizedAdVideoTier,
    yoloVideoProfileRuntime,
    yoloVideoFps,
    yoloModeKey,
    yoloModeLabel,
    yoloQueueNameLabel,
    yoloStoryboardAssetMap,
  ])

  const handleQueueYoloVideos = useCallback(async (options = {}) => {
    const {
      planOverride = null,
      skipStaleCheck = false,
      skipConfirm = false,
      sourceLabel = `${DIRECTOR_MODE_BETA_LABEL} ${yoloModeLabel.toLowerCase()} video pass`,
      allowExistingDoneKeys = false,
      targetWorkflowIds = null,
      resolutionOverride = null,
    } = options || {}
    if (!isConnected) {
      setFormError('ComfyUI is not connected yet. Start ComfyUI, then queue videos.')
      return 0
    }
    if (yoloActivePlanIsStale && !skipStaleCheck) {
      setFormError('Director plan is out of date. Click Build Plan again before queueing videos.')
      setDirectorSubTab('plan-script')
      return 0
    }
    const planToUse = Array.isArray(planOverride) && planOverride.length > 0
      ? planOverride
      : (yoloActivePlan.length > 0 ? yoloActivePlan : buildActiveYoloPlan())
    if (!planToUse) return 0

    const variants = flattenYoloPlanVariants(planToUse)
    if (variants.length === 0) {
      setFormError('No queueable shots. Build a plan first.')
      return 0
    }

    const targets = Array.from(new Set(
      (Array.isArray(targetWorkflowIds) && targetWorkflowIds.length > 0
        ? targetWorkflowIds
        : yoloSelectedVideoWorkflowIds)
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    ))
    if (targets.length === 0) {
      setFormError('Choose a video workflow before queueing videos.')
      return 0
    }
    const depsOk = await validateDependenciesForQueue(
      targets,
      sourceLabel
    )
    if (!depsOk) return 0

    if (targets.length > 1 && !skipConfirm) {
      const estimatedJobs = variants.length * targets.length
      const confirmed = await confirmLargeQueueBatch(estimatedJobs, 'video')
      if (!confirmed) {
        setFormError('Queue cancelled')
        return 0
      }
    }

    let totalQueued = 0
    for (const targetWorkflowId of targets) {
      totalQueued += await queueYoloVideoVariants(variants, {
        workflowId: targetWorkflowId,
        allowExistingDoneKeys,
        skipConfirm: skipConfirm || targets.length > 1,
        suppressEmptyError: targets.length > 1,
        resolutionOverride,
        sourceLabel: targets.length > 1
          ? `${sourceLabel} (${getWorkflowDisplayLabel(targetWorkflowId)})`
          : sourceLabel,
      })
    }
    if (totalQueued === 0) {
      setFormError('No video jobs were queued. If they already completed, use Queue Shot Video for targeted reruns.')
    }
    return totalQueued
  }, [
    buildActiveYoloPlan,
    confirmLargeQueueBatch,
    isConnected,
    queueYoloVideoVariants,
    yoloActivePlanIsStale,
    validateDependenciesForQueue,
    yoloActivePlan,
    yoloSelectedVideoWorkflowIds,
    yoloModeLabel,
  ])

  const handleCreateStoryboardPdf = useCallback(async () => {
    if (creatingStoryboardPdf) return
    if (!currentProjectHandle) {
      setFormError('Open a project folder first so keyframe PDFs can be saved.')
      addComfyLog('error', 'Keyframe PDF export requires an open project folder.')
      return
    }

    const items = []
    const seenAssetIds = new Set()

    for (let index = 0; index < yoloQueueVariants.length; index += 1) {
      const variant = yoloQueueVariants[index]
      const asset = yoloStoryboardAssetMap.get(variant?.key)
      if (!asset?.url) continue
      if (asset?.id && seenAssetIds.has(asset.id)) continue
      if (asset?.id) seenAssetIds.add(asset.id)
      items.push({
        assetId: asset.id || variant?.key || `storyboard-${index + 1}`,
        url: asset.url,
        prompt: String(asset.prompt || variant?.storyboardPrompt || variant?.prompt || '').trim(),
        sequence: index + 1,
        itemIndex: index,
        sceneId: String(variant?.sceneId || asset?.yolo?.sceneId || ''),
        shotId: String(variant?.shotId || asset?.yolo?.shotId || ''),
        angle: String(variant?.angle || asset?.yolo?.angle || ''),
        take: Number(variant?.take ?? asset?.yolo?.take) || null,
      })
    }

    // If the active plan is empty, still allow exporting from any latest keyframe images.
    if (items.length === 0) {
      const extractNumericOrder = (value) => {
        const match = String(value || '').match(/\d+/)
        const parsed = match ? Number(match[0]) : Number.POSITIVE_INFINITY
        return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
      }
      const fallbackAssets = Array.from(yoloStoryboardAssetMap.values()).sort((a, b) => {
        const sceneDiff = extractNumericOrder(a?.yolo?.sceneId) - extractNumericOrder(b?.yolo?.sceneId)
        if (sceneDiff !== 0) return sceneDiff
        const shotDiff = extractNumericOrder(a?.yolo?.shotId) - extractNumericOrder(b?.yolo?.shotId)
        if (shotDiff !== 0) return shotDiff
        const angleDiff = extractNumericOrder(a?.yolo?.angle) - extractNumericOrder(b?.yolo?.angle)
        if (angleDiff !== 0) return angleDiff
        const takeDiff = (Number(a?.yolo?.take) || 0) - (Number(b?.yolo?.take) || 0)
        if (takeDiff !== 0) return takeDiff
        return new Date(a?.createdAt || 0).getTime() - new Date(b?.createdAt || 0).getTime()
      })
      for (let index = 0; index < fallbackAssets.length; index += 1) {
        const asset = fallbackAssets[index]
        if (!asset?.url) continue
        if (asset?.id && seenAssetIds.has(asset.id)) continue
        if (asset?.id) seenAssetIds.add(asset.id)
        items.push({
          assetId: asset.id || `storyboard-fallback-${index + 1}`,
          url: asset.url,
          prompt: String(asset.prompt || '').trim(),
          sequence: index + 1,
          itemIndex: index,
          sceneId: String(asset?.yolo?.sceneId || ''),
          shotId: String(asset?.yolo?.shotId || ''),
          angle: String(asset?.yolo?.angle || ''),
          take: Number(asset?.yolo?.take) || null,
        })
      }
    }

    if (items.length === 0) {
      setFormError('No keyframe images found yet. Queue or re-render keyframes first, then create the PDF.')
      addComfyLog('error', 'Keyframe PDF export skipped: no keyframe images available.')
      return
    }

    setCreatingStoryboardPdf(true)
    setFormError(null)
    addComfyLog('status', `Creating keyframe PDF from ${items.length} frame${items.length === 1 ? '' : 's'}...`)
    try {
      const exported = await exportStoryboardPdfBatch({
        id: `manual_keyframe_${Date.now()}`,
        createdAt: Date.now(),
        modeKey: yoloModeKey,
        modeLabel: yoloModeLabel,
        directorLabel: yoloQueueNameLabel,
        items,
      })

      if (!exported) {
        throw new Error('Keyframe PDF export did not return a file.')
      }
      addComfyLog('ok', `Keyframe PDF saved: ${exported.fileName}`)
      openStoryboardPdfPreview(exported.url)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Keyframe PDF export failed')
      setFormError(`Keyframe PDF export failed: ${message}`)
      addComfyLog('error', `Keyframe PDF export failed: ${message}`)
    } finally {
      setCreatingStoryboardPdf(false)
    }
  }, [
    addComfyLog,
    creatingStoryboardPdf,
    currentProjectHandle,
    exportStoryboardPdfBatch,
    openStoryboardPdfPreview,
    yoloModeKey,
    yoloModeLabel,
    yoloQueueNameLabel,
    yoloQueueVariants,
    yoloStoryboardAssetMap,
  ])

  const handleQueueYoloShotVideo = useCallback(async (sceneId, shotId, options = {}) => {
    const {
      planOverride = null,
      skipStaleCheck = false,
      targetWorkflowIds = null,
      resolutionOverride = null,
    } = options || {}
    if (!isConnected) return
    if (yoloActivePlanIsStale && !skipStaleCheck) {
      setFormError('Director plan is out of date. Click Build Plan again before creating shot video.')
      setDirectorSubTab('plan-script')
      return
    }
    const targets = Array.from(new Set(
      (Array.isArray(targetWorkflowIds) && targetWorkflowIds.length > 0
        ? targetWorkflowIds
        : yoloSelectedVideoWorkflowIds)
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    ))
    if (targets.length === 0) {
      setFormError('Choose a video workflow before creating shot video.')
      return
    }
    const depsOk = await validateDependenciesForQueue(
      targets,
      `video re-render for ${sceneId} ${shotId}`
    )
    if (!depsOk) return

    const planToUse = Array.isArray(planOverride) && planOverride.length > 0
      ? planOverride
      : (yoloActivePlan.length > 0 ? yoloActivePlan : buildActiveYoloPlan())
    if (!planToUse) return

    const variants = flattenYoloPlanVariants(planToUse)
      .filter((variant) => variant.sceneId === sceneId && variant.shotId === shotId)
    if (variants.length === 0) {
      setFormError(`No video variants found for ${sceneId} ${shotId}.`)
      return
    }

    let totalQueued = 0
    for (const targetWorkflowId of targets) {
      totalQueued += await queueYoloVideoVariants(variants, {
        workflowId: targetWorkflowId,
        allowExistingDoneKeys: true,
        skipConfirm: true,
        suppressEmptyError: targets.length > 1,
        resolutionOverride,
        sourceLabel: `Queued video re-render for ${sceneId} ${shotId} (${getWorkflowDisplayLabel(targetWorkflowId)})`,
      })
    }
    if (totalQueued === 0) {
      setFormError(`No video jobs queued for ${sceneId} ${shotId}. Check if target workflows are already running.`)
    }
  }, [
    buildActiveYoloPlan,
    isConnected,
    queueYoloVideoVariants,
    yoloActivePlanIsStale,
    validateDependenciesForQueue,
    yoloActivePlan,
    yoloSelectedVideoWorkflowIds,
  ])

  const handleGenerate = () => {
    if (!isConnected && !allowQueueWhileWaiting) return
    if (!isConnected && launcherCanAutoStart) {
      void startComfyLauncher()
    }
    if (generationMode === 'yolo') {
      void handleQueueYoloStoryboards()
      return
    }
    if (selectedWorkflowManifest && !selectedWorkflowManifest.runnable) {
      setFormError('This workflow is in the catalog as a preview. Add its workflow graph and bindings before queueing it.')
      return
    }
    if (dependencyCheckInProgress) {
      setFormError('Checking workflow dependencies. Please wait a moment and try again.')
      return
    }
    if (hasBlockingDependencies) {
      setFormError('Missing required workflow dependencies. Install the missing items listed below and re-check.')
      return
    }
    const canUseTimelineFrame = isSingleVideoWorkflowId(workflowId)
    const usingTimelineFrame = !!frameForAI?.file && canUseTimelineFrame
    const requiresPrimaryAsset = Boolean(primaryAssetSlot) || (currentWorkflow?.needsImage && assetInputSlots.length === 0)
    if (requiresPrimaryAsset && !selectedAsset && !usingTimelineFrame) {
      const primaryLabel = primaryAssetSlot?.label || 'input asset'
      setFormError(`Please select ${String(primaryLabel).toLowerCase()}${canUseTimelineFrame ? ' or use a timeline frame' : ''} first`)
      return
    }
    if (selectedWorkflowManifest?.requiresAudio && !selectedAudioAsset) {
      setFormError('Please select conditioning audio for this workflow first')
      return
    }
    const missingRequiredAssetField = (selectedWorkflowManifest?.fields || []).find((field) => (
      field?.type === 'assetSelect' &&
      field.required &&
      field.id !== 'audioAsset' &&
      !selectedAssetFields[field.id]
    ))
    if (missingRequiredAssetField) {
      setFormError(`Please select ${String(missingRequiredAssetField.label || missingRequiredAssetField.id).toLowerCase()} for this workflow first`)
      return
    }

    setFormError(null)

    const job = createQueuedJob({
      inputAssetId: usingTimelineFrame ? null : (selectedAsset?.id || null),
      inputAssetName: usingTimelineFrame ? 'Timeline frame' : (selectedAsset?.name || ''),
      audioAssetId: selectedWorkflowManifest?.requiresAudio ? (selectedAudioAsset?.id || null) : null,
      audioAssetName: selectedWorkflowManifest?.requiresAudio ? (selectedAudioAsset?.name || '') : '',
      inputFromTimelineFrame: usingTimelineFrame,
      referenceAssetId1: workflowId === 'image-edit' ? referenceAssetId1 : null,
      referenceAssetId2: workflowId === 'image-edit' ? referenceAssetId2 : null,
    })

    enqueueJob(job)
  }

  // Poll for result
  const pollForResult = async (promptId, wfId, onProgress, expectedOutputPrefix = '') => {
    // Hard absolute cap (belt-and-suspenders). Long video workflows like
    // WAN 2.2 14B i2v routinely take 15–45 minutes on a single 24 GB GPU,
    // so a static 10-minute ceiling was falsely flagging healthy runs as
    // "finished but no output detected". Fall back to idle-activity
    // detection instead of a fixed wall clock.
    const MAX_TOTAL_MS = 4 * 60 * 60 * 1000 // 4 hours absolute ceiling
    const IDLE_TIMEOUT_MS = 10 * 60 * 1000 // bail if no WS activity for 10 min
    const POLL_INTERVAL_MS = 1000
    let consecutivePollErrors = 0
    const maxConsecutivePollErrors = 15

    // Track websocket activity for this specific promptId so we can tell
    // a long-running generation apart from a dead/stalled one.
    const startedAt = Date.now()
    let lastActivityAt = startedAt
    let wsReportedSuccess = false
    let wsReportedComplete = false // executing=null fires on both success and error
    const matchesPrompt = (pid) => !pid || !promptId || String(pid) === String(promptId)
    const bumpActivity = (evt) => {
      if (!evt) return
      if (matchesPrompt(evt.promptId)) lastActivityAt = Date.now()
    }
    const onExecutionSuccess = (evt) => {
      if (matchesPrompt(evt?.promptId)) {
        wsReportedSuccess = true
        lastActivityAt = Date.now()
      }
    }
    const onExecutingComplete = (evt) => {
      if (matchesPrompt(evt?.promptId)) {
        wsReportedComplete = true
        lastActivityAt = Date.now()
      }
    }
    const wsSubs = [
      ['progress', bumpActivity],
      ['executing', bumpActivity],
      ['executed', bumpActivity],
      ['execution_start', bumpActivity],
      ['execution_cached', bumpActivity],
      ['execution_success', onExecutionSuccess],
      ['execution_error', bumpActivity],
      ['execution_interrupted', bumpActivity],
      ['complete', onExecutingComplete],
    ]
    for (const [evt, fn] of wsSubs) {
      try { comfyui.on(evt, fn) } catch (_) { /* ignore */ }
    }
    const detachWsListeners = () => {
      for (const [evt, fn] of wsSubs) {
        try { comfyui.off(evt, fn) } catch (_) { /* ignore */ }
      }
    }

    // Helper: extract filename from various ComfyUI API formats (old dict-based and new SavedResult)
    const getFilename = (item) => item?.filename || item?.file || item?.name
    const getSubfolder = (item) => item?.subfolder || item?.sub_folder || ''
    const getOutputType = (item) => item?.type || item?.folder_type || 'output'

    // Helper: check if a filename looks like a video file
    const isVideoFilename = (fn) => typeof fn === 'string' && /\.(mp4|webm|gif|mov|avi|mkv)$/i.test(fn)
    // Helper: check if a filename looks like an image file
    const isImageFilename = (fn) => typeof fn === 'string' && /\.(png|jpg|jpeg|webp|bmp|tiff)$/i.test(fn)
    // Helper: check if a filename looks like an audio file
    const isAudioFilename = (fn) => typeof fn === 'string' && /\.(mp3|wav|ogg|flac|aac|m4a)$/i.test(fn)

    const normalizedExpectedPrefix = String(expectedOutputPrefix || '')
      .trim()
      .split('/')
      .pop()
      .toLowerCase()
    const matchesExpectedPrefix = (filename) => {
      if (!normalizedExpectedPrefix) return true
      return String(filename || '').toLowerCase().startsWith(normalizedExpectedPrefix)
    }

    // Helper: try to extract a media result from a single output item
    const extractFromItem = (item) => {
      const fn = getFilename(item)
      if (!fn) return null
      return { filename: fn, subfolder: getSubfolder(item), outputType: getOutputType(item) }
    }
    const isInputOutputType = (info) => String(info?.outputType || '').toLowerCase() === 'input'
    const scoreOutput = (info) => {
      const outputType = String(info?.outputType || '').toLowerCase()
      const subfolder = String(info?.subfolder || '').toLowerCase()
      let score = 0
      if (outputType === 'output') score += 100
      if (outputType === 'temp') score -= 50
      if (subfolder.includes('video')) score += 10
      return score
    }
    const pickBestFromItems = (items, predicate) => {
      if (!Array.isArray(items) || items.length === 0) return null
      const candidates = items
        .map(extractFromItem)
        .filter((info) => info && (!predicate || predicate(info)))
      if (candidates.length === 0) return null
      candidates.sort((a, b) => scoreOutput(b) - scoreOutput(a))
      return candidates[0]
    }

    // Prefix-agnostic scan. Used as a last-resort fallback when the strict
    // prefix-bound scan comes up empty but ComfyUI reported the prompt as
    // completed. The history response is already scoped to this promptId
    // (`/history/<id>`), so any output file we see here is guaranteed to
    // belong to *this* generation — the prefix match only existed as a
    // belt-and-suspenders extra check. When ComfyUI sanitizes or truncates
    // the filename (long job IDs, odd characters, custom nodes that mangle
    // the prefix) the strict scan silently drops a valid result; this
    // fallback recovers it.
    const scanOutputsAnyPrefix = (outputsMap, { preferVideo = false } = {}) => {
      if (!outputsMap || typeof outputsMap !== 'object') return null
      const collected = [] // { kind, filename, subfolder, outputType, nodeId, key }
      for (const nodeId of Object.keys(outputsMap)) {
        const nodeOut = outputsMap[nodeId]
        if (!nodeOut || typeof nodeOut !== 'object') continue
        for (const key of Object.keys(nodeOut)) {
          const val = nodeOut[key]
          if (!Array.isArray(val) || val.length === 0) continue
          for (const item of val) {
            const info = extractFromItem(item)
            if (!info || isInputOutputType(info)) continue
            let kind = null
            if (isVideoFilename(info.filename)) kind = 'video'
            else if (isAudioFilename(info.filename)) kind = 'audio'
            else if (isImageFilename(info.filename)) kind = 'image'
            if (!kind) continue
            collected.push({ kind, nodeId, key, ...info })
          }
        }
      }
      if (collected.length === 0) return null
      collected.sort((a, b) => {
        if (preferVideo) {
          const av = a.kind === 'video' ? 1 : 0
          const bv = b.kind === 'video' ? 1 : 0
          if (av !== bv) return bv - av
        }
        return scoreOutput(b) - scoreOutput(a)
      })
      const picked = collected[0]
      if (picked.kind === 'video') {
        return { type: 'video', filename: picked.filename, subfolder: picked.subfolder, outputType: picked.outputType }
      }
      if (picked.kind === 'audio') {
        return { type: 'audio', filename: picked.filename, subfolder: picked.subfolder, outputType: picked.outputType }
      }
      const imageItems = collected
        .filter((c) => c.kind === 'image')
        .map((c) => ({ type: 'image', filename: c.filename, subfolder: c.subfolder, outputType: c.outputType }))
      if (imageItems.length > 0) return { type: 'images', items: imageItems }
      return null
    }

    try {
    let stalledBail = false
    // Hysteresis: once ComfyUI reports success over WS we fetch a few more
    // times if outputs haven't appeared yet (SaveVideo/ffmpeg can finish
    // writing a split second after the success event fires).
    let postSuccessTries = 0
    const MAX_POST_SUCCESS_TRIES = 8
    while (true) {
      const now = Date.now()
      const elapsed = now - startedAt
      const idleFor = now - lastActivityAt
      if (elapsed > MAX_TOTAL_MS) break
      if (!wsReportedSuccess && idleFor > IDLE_TIMEOUT_MS) {
        stalledBail = true
        break
      }
      if (wsReportedSuccess && postSuccessTries >= MAX_POST_SUCCESS_TRIES) break

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
      if (wsReportedSuccess) postSuccessTries += 1

      // Progress heuristic: map elapsed time onto a slow 0→90 curve until
      // we get a real completion signal. (Real fine-grained % comes from
      // the WS `progress` event stream that useComfyUI listens to.)
      const progressPct = Math.min(90, (elapsed / (15 * 60 * 1000)) * 90)
      onProgress(progressPct)

      try {
        const history = await comfyui.getHistory(promptId)
        consecutivePollErrors = 0
        // ComfyUI may return { [promptId]: { outputs } } or (for /history/id) { outputs } at top level
        const outputs = history?.[promptId]?.outputs ?? history?.outputs
        const topStatus = history?.[promptId]?.status ?? history?.status

        // Short-circuit on ComfyUI execution errors. If the prompt failed
        // (e.g. OOM, bad input, crashed custom node) ComfyUI marks the
        // history entry with status_str='error' and completed=false. The
        // old success-only check meant we kept polling for the full 10
        // minute window before giving up with a misleading "output could
        // not be detected" message. Instead, surface the real cause.
        if (topStatus && topStatus.status_str === 'error') {
          let errNodeId = null
          let errNodeType = null
          let errMessage = null
          const msgs = Array.isArray(topStatus.messages) ? topStatus.messages : []
          for (let mi = msgs.length - 1; mi >= 0; mi -= 1) {
            const entry = msgs[mi]
            if (!Array.isArray(entry) || entry.length < 2) continue
            const [evtName, evtData] = entry
            if (evtName === 'execution_error' && evtData && typeof evtData === 'object') {
              errNodeId = evtData.node_id != null ? String(evtData.node_id) : null
              errNodeType = evtData.node_type ? String(evtData.node_type) : null
              errMessage = typeof evtData.exception_message === 'string'
                ? evtData.exception_message
                : null
              break
            }
            if (evtName === 'execution_interrupted' && evtData && typeof evtData === 'object') {
              errNodeId = evtData.node_id != null ? String(evtData.node_id) : null
              errNodeType = evtData.node_type ? String(evtData.node_type) : null
              errMessage = 'Execution interrupted'
              break
            }
          }
          const nodeLabel = errNodeId
            ? `node ${errNodeId}${errNodeType ? ` (${errNodeType})` : ''}`
            : 'unknown node'
          const friendly = errMessage
            ? `ComfyUI failed at ${nodeLabel}: ${errMessage}`
            : `ComfyUI reported an execution error at ${nodeLabel}`
          try {
            window.electronAPI?.comfyLauncher?.appendLog?.({
              stream: 'event',
              text: `✗ Prompt ${String(promptId || '').slice(0, 8)}: ${friendly}`,
            })
          } catch (_) { /* ignore */ }
          console.error('[pollForResult]', friendly, { promptId, messages: msgs })
          const err = new Error(friendly)
          err.comfyNodeId = errNodeId
          err.comfyNodeType = errNodeType
          err.isComfyExecutionError = true
          throw err
        }

        if (!outputs || typeof outputs !== 'object') continue

        // ── VIDEO detection: scan ALL nodes, ALL keys ──
        // Check known video keys first (videos, gifs), then any array key with video-like filenames
        for (const nodeId of Object.keys(outputs)) {
          const nodeOut = outputs[nodeId]
          if (!nodeOut || typeof nodeOut !== 'object') continue

          // Check known video array keys
          for (const key of ['videos', 'gifs', 'video']) {
            const items = nodeOut[key]
            if (Array.isArray(items) && items.length > 0) {
              const info = pickBestFromItems(items, (entry) => (
                isVideoFilename(entry.filename) && matchesExpectedPrefix(entry.filename) && !isInputOutputType(entry)
              ))
              if (info) {
                console.log(`[pollForResult] Found video in node ${nodeId}.${key}:`, info)
                return { type: 'video', ...info }
              }
            }
          }

          // Check ANY array-valued key for items with video-like filenames
          for (const key of Object.keys(nodeOut)) {
            if (['videos', 'gifs', 'video'].includes(key)) continue // already checked
            const val = nodeOut[key]
            if (Array.isArray(val) && val.length > 0) {
              const info = pickBestFromItems(val, (entry) => (
                isVideoFilename(entry.filename) && matchesExpectedPrefix(entry.filename) && !isInputOutputType(entry)
              ))
              if (info && isVideoFilename(info.filename)) {
                console.log(`[pollForResult] Found video in node ${nodeId}.${key} (by extension):`, info)
                return { type: 'video', ...info }
              }
            }
          }
        }

        // ── IMAGE detection: scan ALL nodes, ALL keys ──
        const images = []
        const imageSignatures = new Set()
        const pushUniqueImage = (info) => {
          if (!info || !info.filename) return
          const signature = `${info.filename}|${info.subfolder || ''}|${info.outputType || 'output'}`
          if (imageSignatures.has(signature)) return
          imageSignatures.add(signature)
          images.push({ type: 'image', ...info })
        }
        for (const nodeId of Object.keys(outputs)) {
          const nodeOut = outputs[nodeId]
          if (!nodeOut || typeof nodeOut !== 'object') continue

          // Check known image key
          if (Array.isArray(nodeOut.images)) {
            for (const img of nodeOut.images) {
              const info = extractFromItem(img)
              if (
                info &&
                isImageFilename(info.filename) &&
                matchesExpectedPrefix(info.filename) &&
                !isInputOutputType(info)
              ) {
                pushUniqueImage(info)
              }
            }
          }

          // Check any other array key with image-like filenames
          for (const key of Object.keys(nodeOut)) {
            if (key === 'images') continue
            const val = nodeOut[key]
            if (Array.isArray(val) && val.length > 0) {
              for (const item of val) {
                const info = extractFromItem(item)
                if (info && isImageFilename(info.filename) && matchesExpectedPrefix(info.filename) && !isInputOutputType(info)) {
                  pushUniqueImage(info)
                }
              }
            }
          }
        }
        if (images.length > 0) {
          console.log(`[pollForResult] Found ${images.length} image(s):`, images)
          return { type: 'images', items: images }
        }

        // ── AUDIO detection: scan ALL nodes, ALL keys ──
        for (const nodeId of Object.keys(outputs)) {
          const nodeOut = outputs[nodeId]
          if (!nodeOut || typeof nodeOut !== 'object') continue

          // Check known audio key
          if (nodeOut.audio) {
            const aud = Array.isArray(nodeOut.audio) ? nodeOut.audio[0] : nodeOut.audio
            const info = extractFromItem(aud)
            if (info && matchesExpectedPrefix(info.filename) && !isInputOutputType(info)) {
              console.log(`[pollForResult] Found audio in node ${nodeId}:`, info)
              return { type: 'audio', ...info }
            }
          }

          // Check any array key with audio-like filenames
          for (const key of Object.keys(nodeOut)) {
            if (key === 'audio') continue
            const val = nodeOut[key]
            if (Array.isArray(val) && val.length > 0) {
              const info = extractFromItem(val[0])
              if (info && isAudioFilename(info.filename) && matchesExpectedPrefix(info.filename) && !isInputOutputType(info)) {
                console.log(`[pollForResult] Found audio in node ${nodeId}.${key} (by extension):`, info)
                return { type: 'audio', ...info }
              }
            }
          }
        }

        // Check status for completion - if completed but nothing found, log and keep trying briefly
        const status = history?.[promptId]?.status ?? history?.status
        if (status?.completed || status?.status_str === 'success') {
          // Log the full outputs for debugging
          console.warn('[pollForResult] Generation completed but no output detected. Full outputs:', JSON.stringify(outputs, null, 2))
          console.warn('[pollForResult] Output node keys:', Object.keys(outputs))
          for (const nodeId of Object.keys(outputs)) {
            console.warn(`[pollForResult] Node ${nodeId} keys:`, Object.keys(outputs[nodeId] || {}))
          }
          // Give it a few more tries in case outputs are still being written
          const preferVideoFallback = isSingleVideoWorkflowId(wfId)
          let retryOutputs = null
          if (Date.now() - startedAt < MAX_TOTAL_MS - 5000) {
            onProgress(92)
            await new Promise(r => setTimeout(r, 2000))
            // Re-fetch and try once more
            const retryHistory = await comfyui.getHistory(promptId)
            retryOutputs = retryHistory?.[promptId]?.outputs ?? retryHistory?.outputs
            if (retryOutputs && typeof retryOutputs === 'object') {
              // Re-run the strict scan first — outputs may have finished
              // flushing during the 2s wait.
              for (const nodeId of Object.keys(retryOutputs)) {
                const nodeOut = retryOutputs[nodeId]
                if (!nodeOut || typeof nodeOut !== 'object') continue
                for (const key of Object.keys(nodeOut)) {
                  const val = nodeOut[key]
                  if (Array.isArray(val) && val.length > 0) {
                    const info = pickBestFromItems(val, (entry) => matchesExpectedPrefix(entry.filename) && !isInputOutputType(entry))
                    if (info) {
                      console.log(`[pollForResult] Retry found result in node ${nodeId}.${key}:`, info)
                      if (isVideoFilename(info.filename)) return { type: 'video', ...info }
                      if (isAudioFilename(info.filename)) return { type: 'audio', ...info }
                      if (isImageFilename(info.filename)) return { type: 'images', items: [{ type: 'image', ...info }] }
                      if (preferVideoFallback) return { type: 'video', ...info }
                      return { type: 'images', items: [{ type: 'image', ...info }] }
                    }
                  }
                }
              }
            }
          }

          // Last resort: drop the prefix constraint. The history is already
          // scoped to this promptId, so any non-input output file in the
          // response is necessarily from *this* generation. This recovers
          // the WAN 2.2 / LTX2 "finished but could not find the video
          // output" failure mode where ComfyUI sanitizes the filename (or
          // a custom node mangles the prefix) just enough to break the
          // strict scan.
          const fallbackOutputs = retryOutputs && typeof retryOutputs === 'object' ? retryOutputs : outputs
          const fallback = scanOutputsAnyPrefix(fallbackOutputs, { preferVideo: preferVideoFallback })
          if (fallback) {
            const diag = fallback.type === 'images'
              ? `prefix-agnostic fallback matched ${fallback.items.length} image(s); first=${fallback.items[0]?.filename}`
              : `prefix-agnostic fallback matched ${fallback.type}=${fallback.filename}`
            console.warn(`[pollForResult] ${diag}. Expected prefix was "${normalizedExpectedPrefix}".`)
            try {
              window.electronAPI?.comfyLauncher?.appendLog?.({
                stream: 'event',
                text: `! Prompt ${String(promptId || '').slice(0, 8)}: output filename did not match expected prefix "${normalizedExpectedPrefix}". Recovered via fallback (${diag}).`,
              })
            } catch (_) { /* ignore */ }
            return fallback
          }

          // Absolutely nothing found. Surface enough diagnostic info for
          // the user to see in the launcher log what ComfyUI actually
          // returned — otherwise the failure is silent from the user's
          // perspective ("generation finished but output missing").
          try {
            const diagOutputs = fallbackOutputs || {}
            const nodeSummaries = Object.keys(diagOutputs).map((nodeId) => {
              const keys = Object.keys(diagOutputs[nodeId] || {})
              return `${nodeId}=[${keys.join(',') || 'empty'}]`
            })
            window.electronAPI?.comfyLauncher?.appendLog?.({
              stream: 'event',
              text: `✗ Prompt ${String(promptId || '').slice(0, 8)}: completed but no usable output found. Expected prefix "${normalizedExpectedPrefix}". Node outputs: ${nodeSummaries.join(' ') || '(none)'}`,
            })
            console.error('[pollForResult] Retry also found nothing. Outputs:', JSON.stringify(diagOutputs, null, 2))
          } catch (_) { /* ignore */ }
          break
        }

      } catch (err) {
        if (err && err.isComfyExecutionError) {
          throw err
        }
        consecutivePollErrors += 1
        console.warn(`Poll error (${consecutivePollErrors}/${maxConsecutivePollErrors}):`, err)
        if (consecutivePollErrors >= maxConsecutivePollErrors) {
          throw new Error('Lost connection to ComfyUI while waiting for generation result')
        }
      }
    }

    // Loop exited without finding output.
    if (stalledBail) {
      const minutes = Math.round(IDLE_TIMEOUT_MS / 60000)
      const msg = `ComfyUI stopped reporting progress for more than ${minutes} minutes. The generation may be stuck or ComfyUI may have crashed.`
      try {
        window.electronAPI?.comfyLauncher?.appendLog?.({
          stream: 'event',
          text: `✗ Prompt ${String(promptId || '').slice(0, 8)}: ${msg}`,
        })
      } catch (_) { /* ignore */ }
      throw new Error(msg)
    }
    return null
    } finally {
      detachWsListeners()
    }
  }

  // Save generation result to project assets
  const saveGenerationResult = async (result, wfId, job) => {
    const targetProjectHandle = job?.originProject?.handle || currentProjectHandle
    if (!targetProjectHandle) return { didImportAny: false, importedAssets: [] }
    const importsIntoActiveProject = areProjectHandlesSame(targetProjectHandle, currentProjectHandle)
    let didImportAny = false
    const importedAssets = []

    const markImportedSignature = (type, filename, subfolder = '', outputType = 'output') => {
      if (!filename) return false
      const signature = `${type}:${filename}|${subfolder}|${outputType}`
      if (importedMediaSignaturesRef.current.has(signature)) return true
      importedMediaSignaturesRef.current.add(signature)
      return false
    }

    const jobPrompt = job?.prompt || ''
    const jobTags = job?.musicTags || ''
    const autoName = generateName(jobPrompt || jobTags || wfId)
    const directorMeta = job?.yolo && typeof job.yolo === 'object' ? { ...job.yolo } : null
    const shortFilmMeta = job?.shortFilm && typeof job.shortFilm === 'object' ? { ...job.shortFilm } : null
    const resolvedName = directorMeta
      ? buildDirectorAssetDisplayName(directorMeta, job?.workflowId || wfId)
      : autoName
    const jobDuration = job?.duration
    const jobFps = job?.fps
    const jobResolution = job?.resolution
    const jobSeed = job?.seed
    const sanitizeFolderSegment = (value, fallback = 'Workflow') => {
      const cleaned = String(value || fallback)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      return cleaned || fallback
    }
    const workflowFolderName = sanitizeFolderSegment(
      job?.workflowLabel || getWorkflowDisplayLabel(job?.workflowId || wfId) || wfId,
      'Workflow'
    )
    const generatedFolderPath = (kind) => [
      ...(GENERATED_ASSET_FOLDERS[kind] || ['Generated']),
      workflowFolderName,
    ]
    const saveImportedAssetRecord = async (assetRecord, folderPathSegments) => {
      if (importsIntoActiveProject) {
        const addedAsset = addAsset(assetRecord)
        try {
          await saveProject()
        } catch (error) {
          console.warn('Failed to immediately save generated asset to active project:', error)
        }
        return addedAsset
      }
      const persistedAsset = await appendAssetToProjectFile(targetProjectHandle, assetRecord, folderPathSegments)
      const projectLabel = job?.originProject?.name || job?.originProject?.path || 'origin project'
      addComfyLog('ok', `Imported ${assetRecord.name || assetRecord.type || 'asset'} into ${projectLabel}`)
      return persistedAsset
    }

    if (result.type === 'video') {
      if (markImportedSignature('video', result.filename, result.subfolder, result.outputType)) {
        addComfyLog('status', `Skipped duplicate video import: ${result.filename}`)
        return { didImportAny: false, importedAssets }
      }
      const shortFilmVideoName = shortFilmMeta?.kind === 'shot-video'
        ? `VID ${String((Number(shortFilmMeta.shotIndex) || 0) + 1).padStart(2, '0')} - ${shortFilmMeta.shotTitle || 'Shot'}`
        : ''
      const generatedVideoFolderPath = generatedFolderPath('video')
      const generatedVideoFolderId = importsIntoActiveProject ? ensureAssetFolderPath(generatedVideoFolderPath) : null
      try {
        const videoFile = await comfyui.downloadVideo(result.filename, result.subfolder, result.outputType)
        const assetInfo = await importAsset(targetProjectHandle, videoFile, 'video')
        const blobUrl = importsIntoActiveProject ? URL.createObjectURL(videoFile) : null
        const newAsset = await saveImportedAssetRecord({
          ...assetInfo,
          name: shortFilmVideoName || resolvedName,
          type: 'video',
          url: blobUrl,
          prompt: jobPrompt,
          isImported: true,
          yolo: directorMeta || undefined,
          shortFilm: shortFilmMeta || undefined,
          folderId: generatedVideoFolderId,
          settings: {
            duration: jobDuration,
            fps: jobFps,
            resolution: jobResolution ? `${jobResolution.width}x${jobResolution.height}` : undefined,
            seed: jobSeed
          }
        }, generatedVideoFolderPath)
        if (newAsset) importedAssets.push(newAsset)
        didImportAny = true
        if (isElectron() && importsIntoActiveProject && currentProjectHandle && newAsset?.absolutePath) {
          enqueuePlaybackTranscode(currentProjectHandle, newAsset.id, newAsset.absolutePath).catch(() => {})
          if (isProxyPlaybackEnabled()) {
            enqueueProxyTranscode(currentProjectHandle, newAsset.id, newAsset.absolutePath).catch(() => {})
          }
        }
      } catch (err) {
        console.error('Failed to save video:', err)
        if (!importsIntoActiveProject) throw err
        // Fallback: use ComfyUI URL
        const url = comfyui.getMediaUrl(result.filename, result.subfolder, result.outputType)
        const fallbackAsset = addAsset({
          name: shortFilmVideoName || resolvedName,
          type: 'video',
          url,
          prompt: jobPrompt,
          yolo: directorMeta || undefined,
          shortFilm: shortFilmMeta || undefined,
          folderId: generatedVideoFolderId,
          settings: { duration: jobDuration, fps: jobFps, seed: jobSeed }
        })
        if (fallbackAsset) importedAssets.push(fallbackAsset)
        didImportAny = true
      }
    } else if (result.type === 'images') {
      let generatedImageFolderId = null
      const generatedImageFolderPath = generatedFolderPath('image')
      const rawImageItems = Array.isArray(result.items) ? result.items : []
      const uniqueImageMap = new Map()
      for (const item of rawImageItems) {
        if (!item?.filename) continue
        const filenameOnly = String(item.filename).split(/[\\/]/).pop() || String(item.filename)
        const dedupeKey = filenameOnly.toLowerCase()
        const existing = uniqueImageMap.get(dedupeKey)
        if (!existing) {
          uniqueImageMap.set(dedupeKey, item)
          continue
        }
        const existingIsOutput = String(existing.outputType || '').toLowerCase() === 'output'
        const nextIsOutput = String(item.outputType || '').toLowerCase() === 'output'
        if (!existingIsOutput && nextIsOutput) uniqueImageMap.set(dedupeKey, item)
      }
      let imageItems = Array.from(uniqueImageMap.values())
      if (job?.workflowId === 'multi-angles' || job?.workflowId === 'multi-angles-scene') {
        imageItems = imageItems.slice(0, 8)
      }
      const shortFilmKeyframeName = shortFilmMeta?.kind === 'shot-keyframe'
        ? `KF ${String((Number(shortFilmMeta.shotIndex) || 0) + 1).padStart(2, '0')} - ${shortFilmMeta.shotTitle || 'Shot'}`
        : ''
      for (let imageIndex = 0; imageIndex < imageItems.length; imageIndex += 1) {
        const img = imageItems[imageIndex]
        if (markImportedSignature('image', img.filename, img.subfolder, img.outputType)) continue
        if (!generatedImageFolderId) {
          generatedImageFolderId = importsIntoActiveProject ? ensureAssetFolderPath(generatedImageFolderPath) : null
        }
        try {
          const imageFile = await comfyui.downloadImage(img.filename, img.subfolder, img.outputType)
          const assetInfo = await importAsset(targetProjectHandle, imageFile, 'images')
          const blobUrl = importsIntoActiveProject ? URL.createObjectURL(imageFile) : null
          const baseImageName = shortFilmKeyframeName || resolvedName
          const imageName = imageItems.length > 1 ? `${baseImageName}_I${imageIndex + 1}` : baseImageName
          const newAsset = await saveImportedAssetRecord({
            ...assetInfo,
            name: imageName,
            type: 'image',
            url: blobUrl,
            prompt: jobPrompt,
            isImported: true,
            yolo: directorMeta || undefined,
            shortFilm: shortFilmMeta || undefined,
            folderId: generatedImageFolderId,
          }, generatedImageFolderPath)
          if (newAsset) importedAssets.push(newAsset)
          didImportAny = true
        } catch (err) {
          console.warn('Failed to save image:', err)
          if (!importsIntoActiveProject) throw err
          const url = comfyui.getMediaUrl(img.filename, img.subfolder, img.outputType)
          const baseImageName = shortFilmKeyframeName || resolvedName
          const imageName = imageItems.length > 1 ? `${baseImageName}_I${imageIndex + 1}` : baseImageName
          const fallbackAsset = addAsset({
            name: imageName,
            type: 'image',
            url,
            prompt: jobPrompt,
            yolo: directorMeta || undefined,
            shortFilm: shortFilmMeta || undefined,
            folderId: generatedImageFolderId,
          })
          if (fallbackAsset) importedAssets.push(fallbackAsset)
          didImportAny = true
        }
      }
    } else if (result.type === 'audio') {
      if (markImportedSignature('audio', result.filename, result.subfolder, result.outputType)) {
        addComfyLog('status', `Skipped duplicate audio import: ${result.filename}`)
        return { didImportAny: false, importedAssets }
      }
      const generatedAudioFolderPath = generatedFolderPath('audio')
      const generatedAudioFolderId = importsIntoActiveProject ? ensureAssetFolderPath(generatedAudioFolderPath) : null
      const shortFilmVoiceName = shortFilmMeta?.kind === 'dialogue-voice'
        ? `VO ${String((Number(shortFilmMeta.lineIndex) || 0) + 1).padStart(2, '0')} - ${shortFilmMeta.speaker || 'Character'}`
        : ''
      try {
        const url = comfyui.getMediaUrl(result.filename, result.subfolder, result.outputType)
        const resp = await fetch(url)
        const blob = await resp.blob()
        const file = new File([blob], result.filename, { type: 'audio/mpeg' })
        const assetInfo = await importAsset(targetProjectHandle, file, 'audio')
        const blobUrl = importsIntoActiveProject ? URL.createObjectURL(file) : null
        const newAsset = await saveImportedAssetRecord({
          ...assetInfo,
          name: shortFilmVoiceName || autoName,
          type: 'audio',
          url: blobUrl,
          prompt: jobPrompt || jobTags,
          isImported: true,
          shortFilm: shortFilmMeta || undefined,
          folderId: generatedAudioFolderId,
          settings: { duration: job?.musicDuration, bpm: job?.bpm, keyscale: job?.keyscale, voice: shortFilmMeta?.voicePreset }
        }, generatedAudioFolderPath)
        if (newAsset) importedAssets.push(newAsset)
        didImportAny = true
      } catch (err) {
        console.warn('Failed to save audio:', err)
        if (!importsIntoActiveProject) throw err
        const url = comfyui.getMediaUrl(result.filename, result.subfolder, result.outputType)
        const fallbackAsset = addAsset({
          name: shortFilmVoiceName || autoName,
          type: 'audio',
          url,
          prompt: jobPrompt || jobTags,
          shortFilm: shortFilmMeta || undefined,
          folderId: generatedAudioFolderId,
          settings: { duration: job?.musicDuration, bpm: job?.bpm },
        })
        if (fallbackAsset) importedAssets.push(fallbackAsset)
        didImportAny = true
      }
    }
    return { didImportAny, importedAssets }
  }

  const rememberLatestWorkflowPreview = useCallback((job, importedAssets = []) => {
    const previewAssets = importedAssets.filter((asset) => (
      asset?.url && ['video', 'image', 'audio'].includes(asset.type)
    ))
    const previewAsset = previewAssets[0] || importedAssets[0] || null
    if (!previewAsset || !job?.workflowId) return
    setLatestWorkflowPreview({
      workflowId: job.workflowId,
      asset: previewAsset,
      assets: previewAssets.length > 0 ? previewAssets : [previewAsset],
      index: 0,
      updatedAt: Date.now(),
    })
  }, [])

  const handleCreateAngleSheetForJob = useCallback(async (job) => {
    if (!job || !Array.isArray(job.resultAssetIds) || job.resultAssetIds.length === 0) return
    const targetProjectHandle = job?.originProject?.handle || currentProjectHandle
    if (!targetProjectHandle) {
      addComfyLog('error', 'Open or create a project before creating an angle sheet.')
      return
    }
    const imageAssets = job.resultAssetIds
      .map((id) => assets.find((asset) => asset?.id === id) || null)
      .filter((asset) => asset?.type === 'image')
    if (imageAssets.length === 0) {
      addComfyLog('error', 'No generated image angles found for this job.')
      return
    }
    updateJob(job.id, { isCombiningAngles: true, combineError: null })
    try {
      const resolveAssetUrl = async (asset) => {
        if (asset?.path) {
          try { return await getProjectFileUrl(targetProjectHandle, asset.path) } catch (_) {}
        }
        return asset?.url || null
      }
      const loadImage = (src) => new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error(`Failed to load image: ${src}`))
        img.src = src
      })
      const urls = (await Promise.all(imageAssets.map(resolveAssetUrl))).filter(Boolean)
      if (urls.length === 0) throw new Error('Could not resolve generated image files')
      const images = await Promise.all(urls.map(loadImage))
      const cols = Math.min(4, Math.max(1, images.length))
      const rows = Math.ceil(images.length / cols)
      const cellWidth = 1024
      const cellHeight = 576
      const canvas = document.createElement('canvas')
      canvas.width = cols * cellWidth
      canvas.height = rows * cellHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas initialization failed')
      ctx.fillStyle = '#0b0e14'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      images.forEach((img, index) => {
        const col = index % cols
        const row = Math.floor(index / cols)
        const scale = Math.min(cellWidth / Math.max(1, img.width), cellHeight / Math.max(1, img.height))
        const drawW = Math.max(1, Math.floor(img.width * scale))
        const drawH = Math.max(1, Math.floor(img.height * scale))
        const x = col * cellWidth + Math.floor((cellWidth - drawW) / 2)
        const y = row * cellHeight + Math.floor((cellHeight - drawH) / 2)
        ctx.drawImage(img, x, y, drawW, drawH)
      })
      const sheetBlob = await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Failed to export angle sheet'))), 'image/png')
      })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const file = new File([sheetBlob], `angle_sheet_${stamp}.png`, { type: 'image/png' })
      const assetInfo = await importAsset(targetProjectHandle, file, 'images')
      const newAsset = addAsset({
        name: assetInfo.fileName,
        type: 'image',
        path: assetInfo.path,
        url: areProjectHandlesSame(targetProjectHandle, currentProjectHandle) ? URL.createObjectURL(file) : null,
      })
      if (!newAsset) throw new Error('Failed to register angle sheet in assets')
      await saveProject?.()
      updateJob(job.id, { angleSheetAssetId: newAsset.id, isCombiningAngles: false, combineError: null })
      addComfyLog('ok', `Angle sheet created: ${assetInfo.fileName}`)
    } catch (error) {
      const message = error?.message || 'Failed to create angle sheet'
      updateJob(job.id, { isCombiningAngles: false, combineError: message })
      addComfyLog('error', message)
    }
  }, [addAsset, addComfyLog, assets, currentProjectHandle, saveProject, updateJob])

  const runJob = useCallback(async (job) => {
    updateJob(job.id, { status: 'uploading', progress: 5, error: null })
    let importedAssets = []

    try {
      let uploadedFilename = null
      let uploadedVideoFilename = null
      let referenceFilenames = []
      let assetFieldFilenames = {}
      const outputToken = String(job.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_')
      const originProjectHandle = job?.originProject?.handle || currentProjectHandle
      const findJobAsset = (assetId, snapshotKey) => {
        if (!assetId) return null
        const liveAsset = assets.find((asset) => asset.id === assetId)
        if (liveAsset) return liveAsset
        if (snapshotKey && job?.sourceAssets?.[snapshotKey]?.id === assetId) {
          return job.sourceAssets[snapshotKey]
        }
        if (snapshotKey && job?.sourceAssets?.assetFields?.[snapshotKey]?.id === assetId) {
          return job.sourceAssets.assetFields[snapshotKey]
        }
        return null
      }
      const getJobAssetUrl = async (asset) => {
        if (!asset) return null
        if (asset.path && originProjectHandle) {
          try {
            return await getProjectFileUrl(originProjectHandle, asset.path)
          } catch (_) {
            // Fall back to the session URL below if the project file URL cannot be resolved.
          }
        }
        return asset.url || null
      }
      const getUploadExtension = (asset, blob, fallbackName) => {
        const candidates = [fallbackName, asset?.path, asset?.name].filter(Boolean)
        for (const candidate of candidates) {
          const match = String(candidate).match(/\.([a-zA-Z0-9]{1,8})(?:[?#].*)?$/)
          if (match) return `.${match[1].toLowerCase()}`
        }
        const mimeType = blob?.type || asset?.mimeType || ''
        if (mimeType.includes('jpeg')) return '.jpg'
        if (mimeType.includes('png')) return '.png'
        if (mimeType.includes('webp')) return '.webp'
        if (mimeType.includes('gif')) return '.gif'
        if (mimeType.includes('mp4')) return '.mp4'
        if (mimeType.includes('mpeg')) return '.mp3'
        if (mimeType.includes('wav')) return '.wav'
        return ''
      }
      const getSafeUploadName = (asset, blob, fallbackName) => {
        const fallback = fallbackName || `asset_${Date.now()}`
        const extension = getUploadExtension(asset, blob, fallback)
        const rawBase = String(asset?.name || fallback)
          .replace(/\.[a-zA-Z0-9]{1,8}$/, '')
          .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
          .replace(/\s+/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_+|_+$/g, '')
        const base = rawBase || String(fallback).replace(/\.[a-zA-Z0-9]{1,8}$/, '') || 'asset'
        return `${base.slice(0, 80)}${extension}`
      }
      const createFileFromJobAsset = async (asset, fallbackName) => {
        const assetUrl = await getJobAssetUrl(asset)
        if (!assetUrl) return null
        const resp = await fetch(assetUrl)
        if (!resp.ok) throw new Error(`Could not read asset ${asset.name || fallbackName}`)
        const blob = await resp.blob()
        return new File([blob], getSafeUploadName(asset, blob, fallbackName), {
          type: blob.type || asset.mimeType || 'application/octet-stream',
        })
      }
      const outputPrefix = (
        isSingleVideoWorkflowId(job.workflowId) ||
        job.workflowId === 'ltx23-t2v' ||
        job.workflowId === 'wan22-t2v' ||
        job.workflowId === 'seedance2-t2v' ||
        job.workflowId === 'seedance2-flf2v' ||
        job.workflowId === 'seedance2-r2v' ||
        job.workflowId === TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID
          ? `video/director_${outputToken}`
          : (
            job.workflowId === 'image-edit' ||
            job.workflowId === 'longcat-image-edit' ||
            job.workflowId === 'image-edit-model-product' ||
            job.workflowId === 'seedream-5-lite-image-edit' ||
            job.workflowId === 'z-image-turbo' ||
            job.workflowId === 'longcat-text-to-image' ||
            job.workflowId === 'ernie-image-turbo' ||
            job.workflowId === 'flux2-text-to-image' ||
            job.workflowId === 'nano-banana-2' ||
            job.workflowId === 'gpt-image-2-t2i' ||
            job.workflowId === 'gpt-image-2-edit' ||
            job.workflowId === 'grok-text-to-image' ||
            job.workflowId === 'nano-banana-pro'
          )
            ? `image/comfystudio_${outputToken}`
            : (
              job.workflowId === 'sonilo-v2m' || job.workflowId === ELEVENLABS_TTS_WORKFLOW_ID
                ? `audio/comfystudio_${outputToken}`
                : ''
            )
      )

      if (job.promptId) {
        markPromptHandledByApp(job.promptId)
        updateJob(job.id, {
          status: 'running',
          progress: Math.max(Number(job.progress) || 0, 45),
          error: null,
        })
        addComfyLog('status', `Reconnected to prompt ${String(job.promptId).slice(0, 8)}…`)
        const result = await pollForResult(job.promptId, job.workflowId, (p) => {
          updateJob(job.id, (prev) => ({
            ...prev,
            progress: Math.max(prev.progress || 0, p)
          }))
        }, outputPrefix)

        if (result) {
          updateJob(job.id, { status: 'saving', progress: 95 })
          const saveResult = await saveGenerationResult(result, job.workflowId, job)
          importedAssets = saveResult?.importedAssets || []
          if (!saveResult?.didImportAny) {
            throw new Error('Generation returned a stale/duplicate output; job was not imported. Queue paused for safety.')
          }
          rememberLatestWorkflowPreview(job, importedAssets)
          updateJob(job.id, {
            status: 'done',
            progress: 100,
            restoredFromLedger: false,
            resultAssetIds: importedAssets.map((asset) => asset?.id).filter(Boolean),
          })
        } else {
          const msg = 'Generation finished but the output could not be detected'
          addComfyLog('error', msg)
          updateJob(job.id, {
            status: 'error',
            error: msg,
            progress: 0,
            restoredFromLedger: false,
          })
        }
        return
      }

      // Upload input media if needed
      if (job.needsImage) {
        let fileToUpload = null
        if (job.inputFromTimelineFrame) {
          const frame = useFrameForAIStore.getState().frame
          fileToUpload = frame?.file
          if (!fileToUpload) throw new Error('Timeline frame not available')
        } else {
          const inputAsset = findJobAsset(job.inputAssetId, 'input')
          if (!inputAsset) {
            throw new Error('Input asset not found')
          }
          if (job.inputAssetType === 'video') {
            if (inputAsset.type !== 'video') throw new Error('Selected input must be a video')
            fileToUpload = await createFileFromJobAsset(inputAsset, `input_video_${Date.now()}.mp4`)
          } else if (inputAsset.type === 'video') {
            const inputUrl = await getJobAssetUrl(inputAsset)
            if (!inputUrl) throw new Error('Input video is not accessible')
            fileToUpload = await extractFrameAsFile(inputUrl, job.frameTime || 0, `frame_${Date.now()}.png`)
          } else if (inputAsset.type === 'image') {
            fileToUpload = await createFileFromJobAsset(inputAsset, `input_${Date.now()}.png`)
          }
          if (!fileToUpload) throw new Error('Unsupported input asset')
        }

        const uploadResult = await comfyui.uploadFile(fileToUpload)
        if (job.inputAssetType === 'video') {
          uploadedVideoFilename = uploadResult?.name || fileToUpload.name
        } else {
          uploadedFilename = uploadResult?.name || fileToUpload.name
        }
      }

      // Music-video-shot workflow needs the song audio uploaded once per job.
      // It lives on the job as musicAudioAssetId; we grab the asset, fetch it,
      // upload it to Comfy's input folder, and keep the returned filename so
      // the modifier can reference it on the LoadAudio node.
      let uploadedAudioFilename = null
      const audioUploadAssetId = job.workflowId === MUSIC_VIDEO_SHOT_WORKFLOW_ID
        ? job.musicAudioAssetId
        : (job.workflowId === 'ltx23-ia2v' || job.workflowId === SHORT_FILM_DIALOGUE_VIDEO_WORKFLOW_ID ? job.audioAssetId : null)
      if (audioUploadAssetId) {
        const audioAsset = findJobAsset(audioUploadAssetId, 'audio')
        if (!audioAsset) {
          throw new Error(job.workflowId === MUSIC_VIDEO_SHOT_WORKFLOW_ID
            ? 'Audio asset not found — re-select the song/voiceover in Director setup and rebuild the plan.'
            : 'Audio asset not found — re-select conditioning audio and queue again.')
        }
        try {
          const file = await createFileFromJobAsset(audioAsset, `audio_${Date.now()}.mp3`)
          if (!file) throw new Error('Audio asset is not accessible')
          const uploadResult = await comfyui.uploadFile(file)
          uploadedAudioFilename = uploadResult?.name || file.name
        } catch (audioError) {
          throw new Error(`Failed to upload audio: ${audioError?.message || audioError}`)
        }
      }

      if (job.assetFieldIds && typeof job.assetFieldIds === 'object') {
        for (const [fieldId, assetId] of Object.entries(job.assetFieldIds)) {
          const asset = findJobAsset(assetId, fieldId)
          if (!asset) throw new Error(`Asset not found for ${fieldId}`)
          try {
            const fallbackName = `${fieldId}_${Date.now()}${asset.type === 'video' ? '.mp4' : asset.type === 'audio' ? '.mp3' : '.png'}`
            const file = await createFileFromJobAsset(asset, fallbackName)
            if (!file) throw new Error('Asset is not accessible')
            const uploadResult = await comfyui.uploadFile(file)
            assetFieldFilenames[fieldId] = uploadResult?.name || file.name
          } catch (assetError) {
            throw new Error(`Failed to upload ${fieldId}: ${assetError?.message || assetError}`)
          }
        }
      }

      // Upload optional reference images for workflows that support them
      const supportsReferenceImages = (
        job.workflowId === 'image-edit' ||
        job.workflowId === 'image-edit-model-product' ||
        job.workflowId === 'seedream-5-lite-image-edit' ||
        job.workflowId === 'nano-banana-2' ||
        job.workflowId === 'nano-banana-pro'
      )
      if (supportsReferenceImages && (job.referenceAssetId1 || job.referenceAssetId2)) {
        for (const [index, refId] of [job.referenceAssetId1, job.referenceAssetId2].entries()) {
          if (!refId) {
            referenceFilenames.push(null)
            continue
          }
          const refAsset = findJobAsset(refId, index === 0 ? 'reference1' : 'reference2')
          if (!refAsset || refAsset.type !== 'image') {
            referenceFilenames.push(null)
            continue
          }
          try {
            const file = await createFileFromJobAsset(refAsset, `ref_${Date.now()}.png`)
            if (!file) {
              referenceFilenames.push(null)
              continue
            }
            const uploadResult = await comfyui.uploadFile(file)
            referenceFilenames.push(uploadResult?.name || file.name)
          } catch (_) {
            referenceFilenames.push(null)
          }
        }
      }

      // Load workflow JSON
      updateJob(job.id, { status: 'configuring', progress: 20 })
      let workflowJson = null
      const workflowPath = BUILTIN_WORKFLOW_PATHS[job.workflowId]
      if (!workflowPath) throw new Error('Unknown workflow: ' + job.workflowId)

      const resp = await fetch(workflowPath)
      if (!resp.ok) throw new Error(`Failed to load workflow file: ${workflowPath} (${resp.status})`)
      const workflowText = await resp.text()
      try {
        workflowJson = JSON.parse(workflowText)
      } catch {
        const snippet = workflowText.trim().slice(0, 120)
        throw new Error(
          `Workflow file is not valid JSON: ${workflowPath}. Response starts with: ${snippet || '(empty response)'}`
        )
      }

      // Modify workflow based on type
      updateJob(job.id, { status: 'configuring', progress: 30 })
      const {
        modifyWAN22Workflow,
        modifyLTX23I2VWorkflow,
        modifyLTX23IA2VWorkflow,
        modifyMultipleAnglesWorkflow,
        modifyQwenImageEdit2509Workflow,
        modifyZImageTurboWorkflow,
        modifyNanoBanana2Workflow,
        modifyOpenAIGPTImage2Workflow,
        modifySeedance2Workflow,
        modifySoniloVideoToMusicWorkflow,
        modifyGrokTextToImageWorkflow,
        modifySeedream5LiteImageEditWorkflow,
        modifyGrokVideoI2VWorkflow,
        modifyViduQ2I2VWorkflow,
        modifyKlingO3I2VWorkflow,
        modifyMusicWorkflow,
        modifyMusicVideoShotWorkflow,
        modifyElevenLabsTextToSpeechWorkflow,
        modifyLocalApiWorkflow,
        modifyFrameInterpolationWorkflow,
        modifyTopazVideoUpscaleWorkflow,
      } = await import('../services/comfyui')

      let modifiedWorkflow = null
      switch (job.workflowId) {
        case 'wan22-i2v':
          modifiedWorkflow = modifyWAN22Workflow(workflowJson, {
            prompt: job.prompt,
            negativePrompt: job.negativePrompt,
            inputImage: uploadedFilename,
            width: job.resolution?.width,
            height: job.resolution?.height,
            frames: Math.round(job.duration * job.fps) + 1,
            fps: job.fps,
            seed: job.seed,
            filenamePrefix: outputPrefix || 'video/ComfyStudio_wan',
            qualityPreset: job.wanQualityPreset || 'face-lock',
          })
          break
        case 'ltx23-i2v':
          modifiedWorkflow = modifyLTX23I2VWorkflow(workflowJson, {
            prompt: job.prompt,
            negativePrompt: job.negativePrompt,
            inputImage: uploadedFilename,
            width: job.resolution?.width,
            height: job.resolution?.height,
            frames: Math.round(job.duration * job.fps) + 1,
            fps: job.fps,
            seed: job.seed,
            filenamePrefix: outputPrefix || 'video/ltx23_i2v',
          })
          break
        case 'ltx23-ia2v':
        case SHORT_FILM_DIALOGUE_VIDEO_WORKFLOW_ID:
          modifiedWorkflow = modifyLTX23IA2VWorkflow(workflowJson, {
            prompt: job.prompt,
            negativePrompt: job.negativePrompt,
            inputImage: uploadedFilename,
            inputAudio: uploadedAudioFilename,
            width: job.resolution?.width,
            height: job.resolution?.height,
            duration: job.duration,
            fps: job.fps,
            seed: job.seed,
            filenamePrefix: outputPrefix || (job.workflowId === SHORT_FILM_DIALOGUE_VIDEO_WORKFLOW_ID ? 'video/short_film_dialogue_ltx23' : 'video/ltx23_ia2v'),
          })
          break
        case 'frame-interpolation':
          modifiedWorkflow = modifyFrameInterpolationWorkflow(workflowJson, {
            inputVideo: uploadedVideoFilename,
            interpolationMultiplier: job.interpolationMultiplier || 4,
            enableFpsMultiplier: job.enableFpsMultiplier,
            filenamePrefix: outputPrefix || 'video/frame_interpolation',
          })
          break
        case TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID:
          modifiedWorkflow = modifyTopazVideoUpscaleWorkflow(workflowJson, {
            inputVideo: uploadedVideoFilename,
            filenamePrefix: outputPrefix || 'video/topaz_video_upscale',
          })
          break
        case MUSIC_VIDEO_SHOT_WORKFLOW_ID: {
          // Music-video shot: a single audio-conditioned LTX 2.3 render.
          // The audio has already been uploaded above (uploadedAudioFilename)
          // and the reference still was uploaded via the normal image path
          // (uploadedFilename).
          // The USE_VOCALS_ONLY switch flips on when the user selected a
          // mixed_track and the shot needs vocal alignment — we don't run
          // the vocal-extract preprocessing step yet (next session), so for
          // mixed_track we lean on the workflow's built-in vocal-only mode.
          const audioKind = String(job.musicAudioKind || 'vocal_stem')
          const shotNeedsVocalAlignment = Boolean(job.musicShot?.shotType
            && getMusicVideoShotTypeOption(job.musicShot.shotType)?.needsVocalAlignment)
          const useVocalsOnly = audioKind === 'mixed_track' && shotNeedsVocalAlignment
          modifiedWorkflow = modifyMusicVideoShotWorkflow(workflowJson, {
            shot: {
              ...job.musicShot,
              seed: job.seed,
            },
            inputImage: uploadedFilename,
            inputAudio: uploadedAudioFilename,
            useVocalsOnly,
            width: job.resolution?.width,
            height: job.resolution?.height,
            fps: job.fps,
            negativePrompt: job.negativePrompt,
            filenamePrefix: outputPrefix || 'video/music_shot',
          })
          break
        }
        case 'kling-o3-i2v':
          modifiedWorkflow = modifyKlingO3I2VWorkflow(workflowJson, {
            prompt: job.prompt,
            inputImage: uploadedFilename,
            width: job.resolution?.width,
            height: job.resolution?.height,
            duration: job.duration,
            frames: Math.round(job.duration * job.fps) + 1,
            fps: job.fps,
            seed: job.seed,
            generateAudio: false,
            filenamePrefix: outputPrefix || 'video/kling_o3_i2v',
          })
          break
        case 'grok-video-i2v':
          modifiedWorkflow = modifyGrokVideoI2VWorkflow(workflowJson, {
            prompt: job.prompt,
            inputImage: uploadedFilename,
            width: job.resolution?.width,
            height: job.resolution?.height,
            duration: job.duration,
            seed: job.seed,
            filenamePrefix: outputPrefix || 'video/grok_video_i2v',
          })
          break
        case 'vidu-q2-i2v':
          modifiedWorkflow = modifyViduQ2I2VWorkflow(workflowJson, {
            prompt: job.prompt,
            inputImage: uploadedFilename,
            width: job.resolution?.width,
            height: job.resolution?.height,
            duration: job.duration,
            seed: job.seed,
            filenamePrefix: outputPrefix || 'video/vidu_q2_i2v',
          })
          break
        case 'seedance2-t2v':
        case 'seedance2-flf2v':
        case 'seedance2-r2v':
          modifiedWorkflow = modifySeedance2Workflow(workflowJson, {
            prompt: job.prompt,
            width: job.resolution?.width,
            height: job.resolution?.height,
            duration: job.duration,
            seed: job.seed,
            assetFilenames: assetFieldFilenames,
            filenamePrefix: outputPrefix || `video/${job.workflowId}`,
          })
          break
        case 'multi-angles':
        case 'multi-angles-scene':
          modifiedWorkflow = modifyMultipleAnglesWorkflow(workflowJson, {
            inputImage: uploadedFilename,
            seed: job.seed,
          })
          break
        case 'image-edit':
        case 'image-edit-model-product':
          modifiedWorkflow = modifyQwenImageEdit2509Workflow(workflowJson, {
            prompt: job.prompt,
            inputImage: uploadedFilename,
            seed: job.seed,
            referenceImages: referenceFilenames,
            filenamePrefix: outputPrefix || 'image/ComfyStudio_edit',
          })
          break
        case 'z-image-turbo':
          modifiedWorkflow = modifyZImageTurboWorkflow(workflowJson, {
            prompt: job.prompt,
            seed: job.seed,
            width: job.resolution?.width,
            height: job.resolution?.height,
            filenamePrefix: outputPrefix || 'image/z_image_turbo',
          })
          break
        case 'longcat-text-to-image':
        case 'ernie-image-turbo':
        case 'flux2-text-to-image':
        case 'ltx23-t2v':
        case 'wan22-t2v':
          modifiedWorkflow = modifyLocalApiWorkflow(workflowJson, {
            prompt: job.prompt,
            negativePrompt: job.negativePrompt,
            width: job.resolution?.width,
            height: job.resolution?.height,
            duration: job.duration,
            fps: job.fps,
            seed: job.seed,
            filenamePrefix: outputPrefix || `${job.category === 'video' ? 'video' : 'image'}/${job.workflowId}`,
          })
          break
        case 'longcat-image-edit':
          modifiedWorkflow = modifyLocalApiWorkflow(workflowJson, {
            prompt: job.prompt,
            negativePrompt: job.negativePrompt,
            inputImage: uploadedFilename,
            width: job.resolution?.width,
            height: job.resolution?.height,
            seed: job.seed,
            filenamePrefix: 'image/longcat_image_edit',
          })
          break
        case 'nano-banana-2':
        case 'nano-banana-pro': // legacy id support
          modifiedWorkflow = modifyNanoBanana2Workflow(workflowJson, {
            prompt: job.prompt,
            seed: job.seed,
            width: job.resolution?.width,
            height: job.resolution?.height,
            referenceImages: referenceFilenames,
            filenamePrefix: outputPrefix || 'image/nano_banana_2',
          })
          break
        case 'gpt-image-2-t2i':
          modifiedWorkflow = modifyOpenAIGPTImage2Workflow(workflowJson, {
            prompt: job.prompt,
            seed: job.seed,
            width: job.resolution?.width,
            height: job.resolution?.height,
            filenamePrefix: outputPrefix || 'image/gpt_image_2',
          })
          break
        case 'gpt-image-2-edit':
          modifiedWorkflow = modifyOpenAIGPTImage2Workflow(workflowJson, {
            prompt: job.prompt,
            inputImage: uploadedFilename,
            seed: job.seed,
            width: job.resolution?.width,
            height: job.resolution?.height,
            filenamePrefix: outputPrefix || 'image/gpt_image_2_edit',
          })
          break
        case 'grok-text-to-image':
          modifiedWorkflow = modifyGrokTextToImageWorkflow(workflowJson, {
            prompt: job.prompt,
            seed: job.seed,
            width: job.resolution?.width,
            height: job.resolution?.height,
            filenamePrefix: outputPrefix || 'image/grok_text_to_image',
          })
          break
        case 'seedream-5-lite-image-edit':
          modifiedWorkflow = modifySeedream5LiteImageEditWorkflow(workflowJson, {
            prompt: job.prompt,
            seed: job.seed,
            inputImage: uploadedFilename,
            width: job.resolution?.width,
            height: job.resolution?.height,
            referenceImages: referenceFilenames,
            filenamePrefix: outputPrefix || 'image/seedream_5_lite',
          })
          break
        case 'sonilo-v2m':
          modifiedWorkflow = modifySoniloVideoToMusicWorkflow(workflowJson, {
            prompt: job.prompt,
            inputVideo: uploadedVideoFilename,
            seed: job.seed,
            filenamePrefix: outputPrefix || 'audio/sonilo',
          })
          break
        case 'music-gen':
          modifiedWorkflow = modifyMusicWorkflow(workflowJson, {
            tags: job.musicTags,
            lyrics: job.lyrics,
            duration: job.musicDuration,
            bpm: job.bpm,
            seed: job.seed,
            keyscale: job.keyscale,
          })
          break
        case ELEVENLABS_TTS_WORKFLOW_ID:
          modifiedWorkflow = modifyElevenLabsTextToSpeechWorkflow(workflowJson, {
            ...(job.elevenLabsTts || {}),
            text: job.elevenLabsTts?.text || job.prompt,
            voice: job.elevenLabsTts?.voice || job.shortFilm?.voicePreset,
            seed: job.seed,
            filenamePrefix: outputPrefix || 'audio/short_film_voice',
          })
          break
        default:
          throw new Error('Unhandled workflow: ' + job.workflowId)
      }

      updateJob(job.id, { status: 'queuing', progress: 40 })
      const promptId = await comfyui.queuePrompt(modifiedWorkflow)
      if (!promptId) throw new Error('Failed to queue prompt')

      // Claim this prompt ID so the ComfyUI-tab auto-import bridge
      // doesn't also try to import the same outputs into
      // `Imported from ComfyUI/` (we're already importing them into
      // `Generated/` via saveGenerationResult below).
      markPromptHandledByApp(promptId)

      updateJob(job.id, { status: 'running', progress: 45, promptId })

      // Poll for completion
      const result = await pollForResult(promptId, job.workflowId, (p) => {
        updateJob(job.id, (prev) => ({
          ...prev,
          progress: Math.max(prev.progress || 0, p)
        }))
      }, outputPrefix)

      // Save result to assets
      if (result) {
        updateJob(job.id, { status: 'saving', progress: 95 })
        const saveResult = await saveGenerationResult(result, job.workflowId, job)
        importedAssets = saveResult?.importedAssets || []
        if (!saveResult?.didImportAny) {
          throw new Error('Generation returned a stale/duplicate output; job was not imported. Queue paused for safety.')
        }
        rememberLatestWorkflowPreview(job, importedAssets)
        updateJob(job.id, {
          status: 'done',
          progress: 100,
          resultAssetIds: importedAssets.map((asset) => asset?.id).filter(Boolean),
        })
      } else {
        const msg = 'Generation finished but the output could not be detected'
        addComfyLog('error', msg)
        updateJob(job.id, {
          status: 'error',
          error: msg,
          progress: 0
        })
      }
    } catch (err) {
      const msg = err?.message || 'Generation failed'
      addComfyLog('error', msg)
      updateJob(job.id, {
        status: 'error',
        error: msg,
        progress: 0
      })
    } finally {
      await finalizeStoryboardPdfBatchForJob(job, importedAssets)
    }
  }, [assets, currentProjectHandle, updateJob, saveGenerationResult, pollForResult, addComfyLog, finalizeStoryboardPdfBatchForJob, rememberLatestWorkflowPreview])

  const processQueue = useCallback(async () => {
    if (processingRef.current) return
    if (queuePausedRef.current) return
    if (!isConnected) return
    const nextJob = queueRef.current.find((job) => (
      job.status === 'queued' && !startedJobIdsRef.current.has(job.id)
    ))
    if (!nextJob) return

    startedJobIdsRef.current.add(nextJob.id)
    processingRef.current = true
    setActiveJobId(nextJob.id)

    const jobStartTime = Date.now()
    await runJob(nextJob)
    const jobElapsed = Date.now() - jobStartTime

    processingRef.current = false
    setActiveJobId(null)

    const finishedJob = queueRef.current.find(j => j.id === nextJob.id)
    if (!finishedJob || finishedJob.status === 'queued') {
      const desyncMsg = 'Queue state desynced; blocked repeated execution for this job.'
      addComfyLog('error', `${desyncMsg} (${String(nextJob.id).slice(0, 12)}…)`)
      updateJob(nextJob.id, {
        status: 'error',
        error: desyncMsg,
        progress: 0,
      })
    }
    const didFail = finishedJob?.status === 'error' || finishedJob?.status === 'queued'

    if (didFail && jobElapsed < RAPID_FAIL_THRESHOLD_MS) {
      consecutiveRapidFailsRef.current += 1
    } else {
      consecutiveRapidFailsRef.current = 0
    }

    if (consecutiveRapidFailsRef.current >= MAX_CONSECUTIVE_RAPID_FAILS) {
      queuePausedRef.current = true
      consecutiveRapidFailsRef.current = 0
      const remaining = queueRef.current.filter(j => j.status === 'queued').length
      addComfyLog('error', `Queue auto-paused: ${MAX_CONSECUTIVE_RAPID_FAILS} jobs failed rapidly in a row (${remaining} jobs still queued). Check ComfyUI, then use Clear Queue or resume.`)
      setGenerationQueue(prev => prev.map(j =>
        j.status === 'queued' ? { ...j, status: 'paused' } : j
      ))
      return
    }

    const remaining = queueRef.current.find(j => j.status === 'queued')
    if (!remaining) return

    const timeSinceFinish = Date.now() - jobStartTime
    const delay = Math.max(MIN_JOB_INTERVAL_MS - timeSinceFinish, 0)
    setTimeout(() => {
      processQueue()
    }, delay)
  }, [runJob, addComfyLog, updateJob, isConnected])

  useEffect(() => {
    processQueue()
  }, [generationQueue, processQueue, isConnected])

  const randomizeSeed = () => setSeed(Math.floor(Math.random() * 1000000000))

  // Determine if input column should show
  const showInputColumn = generationMode === 'single' && (
    assetInputSlots.length > 0 ||
    (selectedWorkflowManifest?.needsImage ?? currentWorkflow?.needsImage)
  )
  const inputAssetFilterType = activeAssetSlot?.assetType || selectedWorkflowManifest?.inputAssetType || (showInputColumn ? 'image' : null)
  const selectedPreviewWorkflowId = selectedWorkflowManifest?.workflowId || workflowId
  const workflowPreviewAssets = latestWorkflowPreview?.workflowId === selectedPreviewWorkflowId
    ? (latestWorkflowPreview.assets || (latestWorkflowPreview.asset ? [latestWorkflowPreview.asset] : []))
    : []
  const workflowPreviewAssetIndex = latestWorkflowPreview?.workflowId === selectedPreviewWorkflowId
    ? Math.max(0, Math.min(Number(latestWorkflowPreview.index) || 0, Math.max(0, workflowPreviewAssets.length - 1)))
    : 0
  const workflowPreviewAsset = workflowPreviewAssets.length > 0
    ? workflowPreviewAssets[workflowPreviewAssetIndex]
    : null

  const workflowDetailValues = {
    previewAsset: workflowPreviewAsset,
    previewAssets: workflowPreviewAssets,
    previewAssetIndex: workflowPreviewAssetIndex,
    selectedAsset,
    audioAsset: selectedAudioAsset,
    ...selectedAssetFields,
    prompt,
    musicTags,
    lyrics,
    duration,
    musicDuration,
    resolution,
    imageResolution,
    fps,
    interpolationMultiplier,
    enableFpsMultiplier,
    seed,
  }

  const workflowDetailActions = {
    onGenerate: handleGenerate,
    onPreviewAssetIndexChange: (nextIndex) => {
      setLatestWorkflowPreview((prev) => {
        if (!prev || prev.workflowId !== selectedPreviewWorkflowId) return prev
        const assetsForPreview = prev.assets || (prev.asset ? [prev.asset] : [])
        if (assetsForPreview.length === 0) return prev
        const clampedIndex = Math.max(0, Math.min(Number(nextIndex) || 0, assetsForPreview.length - 1))
        return {
          ...prev,
          asset: assetsForPreview[clampedIndex],
          index: clampedIndex,
        }
      })
    },
    onSelectAsset: (asset) => {
      setSelectedAsset(asset)
      setSelectedAssetId(asset?.id || null)
    },
    onSelectAssetField: (fieldId, asset) => {
      if (fieldId === 'audioAsset') {
        setSelectedAudioAsset(asset)
        setSelectedAudioAssetId(asset?.id || null)
        return
      }
      setSelectedAssetFields((prev) => ({ ...prev, [fieldId]: asset || null }))
      setSelectedAssetFieldIds((prev) => {
        const next = { ...(prev || {}) }
        if (asset?.id) {
          next[fieldId] = asset.id
        } else {
          delete next[fieldId]
        }
        return next
      })
    },
    randomizeSeed,
    setValue: (key, value) => {
      switch (key) {
        case 'prompt':
          setPrompt(value)
          break
        case 'musicTags':
          setMusicTags(value)
          break
        case 'lyrics':
          setLyrics(value)
          break
        case 'duration':
          setDuration(value)
          break
        case 'musicDuration':
          setMusicDuration(value)
          break
        case 'resolution':
          setResolution(value)
          break
        case 'imageResolution':
          setImageResolution(value)
          break
        case 'fps':
          setFps(value)
          break
        case 'interpolationMultiplier':
          setInterpolationMultiplier(value)
          break
        case 'enableFpsMultiplier':
          setEnableFpsMultiplier(Boolean(value))
          break
        case 'seed':
          setSeed(value)
          break
        default:
          break
      }
    },
  }

  // ============================================
  // Render
  // ============================================
  const queuedJobCount = generationQueue.filter((job) => job.status === 'queued').length
  const showLauncherBanner = showComfyGatingBanner

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-sf-dark-950">
      {showLauncherBanner && (
        <div className="px-4 py-2.5 border-b border-sky-500/30 bg-sky-500/10 flex items-center gap-3">
          <Loader2 className={`w-4 h-4 text-sky-300 ${launcherIsBooting || launcherWaitingForExternal ? 'animate-spin' : ''}`} />
          <div className="flex-1 min-w-0 text-[12px] text-sky-100">
            {launcherIsBooting && (
              <>
                <span className="font-semibold">ComfyUI is starting…</span>{' '}
                <span className="text-sky-200/85">Your generations will dispatch automatically the moment it's ready.</span>
                {queuedJobCount > 0 && (
                  <span className="ml-2 text-sky-200/85">{queuedJobCount} job{queuedJobCount === 1 ? '' : 's'} queued.</span>
                )}
              </>
            )}
            {launcherWaitingForExternal && (
              <>
                <span className="font-semibold">Waiting on ComfyUI…</span>{' '}
                <span className="text-sky-200/85">Detected at {launcherState?.httpBase || 'localhost'}, but it isn't responding yet.</span>
              </>
            )}
            {!launcherIsBooting && !launcherWaitingForExternal && launcherCanAutoStart && (
              <>
                <span className="font-semibold">ComfyUI is offline.</span>{' '}
                <span className="text-sky-200/85">Hit Start (or just queue a job) and ComfyStudio will boot it for you.</span>
              </>
            )}
          </div>
          {launcherCanAutoStart && !launcherIsBooting && (
            <button
              type="button"
              onClick={() => { void startComfyLauncher() }}
              className="text-[11px] font-semibold px-2.5 py-1 rounded bg-sky-500 hover:bg-sky-400 text-white transition-colors"
            >
              Start ComfyUI
            </button>
          )}
        </div>
      )}
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-sf-dark-700">
        <div className="flex items-center gap-3">
          <Sparkles className="w-4 h-4 text-sf-accent" />
          <span className="text-sm font-semibold text-sf-text-primary">Generate</span>

          <div className="flex items-center gap-1 ml-4 p-1 rounded-lg bg-sf-dark-800 border border-sf-dark-700">
            <button
              onClick={() => {
                setGenerationMode('single')
                setWorkflowDetailOpen(false)
              }}
              className={`px-3 py-1 rounded text-xs transition-colors ${generationMode === 'single' ? 'bg-sf-accent text-white' : 'text-sf-text-muted hover:text-sf-text-primary'}`}
            >
              Generate
            </button>
            <button
              onClick={() => {
                setGenerationMode('yolo')
                setWorkflowDetailOpen(false)
              }}
              className={`px-3 py-1 rounded text-xs transition-colors ${generationMode === 'yolo' ? 'bg-sf-accent text-white' : 'text-sf-text-muted hover:text-sf-text-primary'}`}
            >
              Create <span className="ml-1 text-[9px] opacity-75">Beta</span>
            </button>
          </div>
        </div>

        {/* Connection status */}
        <div className="flex items-center gap-2">
          {activeCount > 0 && <span className="text-[10px] text-sf-text-muted">Running: {activeCount}</span>}
          {queuedCount > 0 && <span className="text-[10px] text-sf-text-muted">Queued: {queuedCount}</span>}
          {queueCount > 0 && <span className="text-[10px] text-sf-text-muted">ComfyUI Queue: {queueCount}</span>}
          <div className={`w-2 h-2 rounded-full ${isConnected ? (wsConnected ? 'bg-green-500' : 'bg-yellow-500') : 'bg-red-500'}`} title={isConnected ? (wsConnected ? 'Connected (WebSocket)' : 'Connected (HTTP)') : 'Disconnected'} />
          <span className="text-[10px] text-sf-text-muted">{isConnected ? 'ComfyUI' : 'Offline'}</span>
        </div>
      </div>

      {/* Main 3-column layout */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Left: Input browser (conditional) */}
        {showInputColumn && (
          <div className="w-72 flex-shrink-0 border-r border-sf-dark-700 bg-sf-dark-900">
            <AssetInputBrowser
              selectedAsset={selectedAsset}
              onSelectAsset={(asset) => {
                setSelectedAsset(asset)
                setSelectedAssetId(asset?.id || null)
              }}
              filterType={inputAssetFilterType}
              frameTime={frameTime}
              onFrameTimeChange={setFrameTime}
              assetSlots={assetInputSlots}
              activeSlotId={activeAssetSlot?.id || 'asset'}
              onActiveSlotChange={setActiveAssetSlotId}
              selectedAssetFields={selectedAssetFields}
              onSelectAssetField={(fieldId, asset) => {
                setSelectedAssetFields((prev) => ({ ...prev, [fieldId]: asset || null }))
                setSelectedAssetFieldIds((prev) => {
                  const next = { ...(prev || {}) }
                  if (asset?.id) {
                    next[fieldId] = asset.id
                  } else {
                    delete next[fieldId]
                  }
                  return next
                })
              }}
            />
          </div>
        )}

        {/* Center: Settings - extra left padding in yolo mode when sidebar visible to center content with header tabs */}
        <div className={`flex-1 min-w-0 overflow-auto px-5 py-4 ${generationMode === 'yolo' && !rightSidebarCollapsed ? 'pl-40' : ''}`}>
          <div className={`mx-auto w-full space-y-4 ${generationMode === 'yolo' ? 'max-w-6xl' : 'max-w-5xl'}`}>
            {/* Timeline frame from editor (Extend with AI / Starting keyframe for AI) */}
            {frameForAI && generationMode === 'single' && (
              <div className="p-3 rounded-lg border border-sf-accent/40 bg-sf-accent/5">
                <div className="flex items-start gap-3">
                  <div className="w-24 h-14 flex-shrink-0 rounded overflow-hidden bg-sf-dark-800 border border-sf-dark-600">
                    <img src={frameForAI.blobUrl} alt="Timeline frame" className="w-full h-full object-contain" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-sf-text-primary">
                      {frameForAI.mode === 'extend' ? 'Extend with AI' : 'Starting keyframe for AI'}
                    </div>
                    <div className="text-[10px] text-sf-text-muted mt-0.5">
                      Frame from timeline at playhead. Choose any video workflow below, then enter a prompt and generate.
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        type="button"
                        onClick={clearFrameForAI}
                        className="px-2 py-1 rounded text-[10px] bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-muted hover:text-sf-text-primary transition-colors"
                      >
                        Clear timeline frame
                      </button>
                    </div>
                  </div>

                </div>
              </div>
            )}

            {generationMode === 'single' && (
              <>
                {!workflowDetailOpen ? (
                  <WorkflowBrowser
                    workflows={visibleWorkflowManifests}
                    selectedWorkflowId={selectedWorkflowManifest?.id || workflowId}
                    route={workflowRoute}
                    onRouteChange={handleWorkflowRouteChange}
                    onSelectWorkflow={handleWorkflowManifestSelect}
                  />
                ) : (
                  <WorkflowDetail
                    workflow={selectedWorkflowManifest}
                    values={workflowDetailValues}
                    actions={workflowDetailActions}
                    disabled={isGenerateDisabled}
                    disabledReason={formError || ''}
                    onBack={() => setWorkflowDetailOpen(false)}
                  />
                )}
              </>
            )}

            {generationMode === 'single' && false && (
              <>
                {/* Workflow selector */}
                <div>
                  <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Workflow</label>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="flex flex-wrap items-center gap-1">
                      {['lite', 'standard', 'pro', 'cloud'].map((tierId) => {
                        const tierMeta = HARDWARE_TIERS[tierId]
                        if (!tierMeta) return null
                        return (
                          <span key={tierId} className={`px-1.5 py-0.5 rounded border text-[9px] ${tierMeta.badgeClass}`}>
                            {tierMeta.shortLabel}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                  <div className="mt-1 text-[9px] text-sf-text-muted">
                    <span
                      className="underline decoration-dotted cursor-help"
                      title="Quick guide: Lite is usually 6-8GB VRAM, Standard is usually 12-16GB, Pro is usually 24GB+, and Cloud uses partner credits."
                    >
                      Not sure your VRAM?
                    </span>{' '}
                    6-8GB = Lite, 12-16GB = Standard, 24GB+ = Pro, Cloud = credits.
                  </div>
                  {openWorkflowHint && (
                    <div className="mt-1 text-[9px] text-green-400">{openWorkflowHint}</div>
                  )}
                  <div className="mt-2 space-y-2">
                    {currentCategoryWorkflowGroups.map((group) => (
                      <div key={group.id} className="space-y-1">
                        {currentCategoryWorkflowGroups.length > 1 && (
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-[10px] font-medium uppercase tracking-wider text-sf-text-muted">
                              {group.label}
                            </div>
                            <div className="text-[9px] text-sf-text-muted">
                              {group.helper}
                            </div>
                          </div>
                        )}
                        <div className="flex flex-wrap gap-2">
                          {group.workflows.map((wf) => {
                            const isActiveWorkflow = workflowId === wf.id
                            const tierMeta = getWorkflowTierMeta(wf.id)
                            const runtimeLabel = formatWorkflowHardwareRuntime(wf.id)
                            return (
                              <button
                                key={wf.id}
                                onClick={() => setWorkflowId(wf.id)}
                                className={`min-w-[220px] flex-1 px-3 py-2 rounded-lg border text-xs text-left transition-colors ${
                                  isActiveWorkflow
                                    ? 'bg-sf-accent/20 border-sf-accent text-sf-accent'
                                    : 'bg-sf-dark-800 border-sf-dark-600 text-sf-text-muted hover:border-sf-dark-500'
                                }`}
                              >
                                <div className="font-medium">{wf.label}</div>
                                <div className="text-[9px] opacity-70 mt-0.5">{wf.description}</div>
                                <div className="mt-1 flex items-center justify-between gap-1">
                                  <span className={`px-1.5 py-0.5 rounded border text-[9px] ${tierMeta?.badgeClass || 'border-sf-dark-600 bg-sf-dark-700 text-sf-text-muted'}`}>
                                    {tierMeta?.shortLabel || 'Unknown'}
                                  </span>
                                  <span className="text-[9px] opacity-70 whitespace-nowrap">{runtimeLabel}</span>
                                </div>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Workflow-specific settings */}
                {category === 'video' && (
                  <>
                {/* Prompt */}
                <div>
                  <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Prompt</label>
                  <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3}
                    className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded-lg px-3 py-2 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent resize-none"
                    placeholder="Describe the video you want to generate..."
                  />
                </div>
                <div>
                  <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Negative Prompt</label>
                  <textarea value={negativePrompt} onChange={e => setNegativePrompt(e.target.value)} rows={2}
                    className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded-lg px-3 py-2 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent resize-none"
                    placeholder="What to avoid..."
                  />
                </div>
                {/* Cinematography tags */}
                <div>
                  <label className="text-[10px] text-sf-text-muted uppercase tracking-wider mb-1 block">Cinematography Tags</label>
                  <CinematographyTags selectedTags={selectedTags}
                    onAddTag={t => setSelectedTags(prev => [...prev, t])}
                    onRemoveTag={t => setSelectedTags(prev => prev.filter(x => x !== t))}
                  />
                </div>
                {workflowId === 'wan22-i2v' && (
                  <div className="p-2 rounded-lg bg-sf-dark-800/60 border border-sf-dark-700">
                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">WAN 2.2 Quality Preset</label>
                    <select
                      value={wanQualityPreset}
                      onChange={(e) => setWanQualityPreset(e.target.value)}
                      className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                    >
                      <option value="face-lock">Face Lock (recommended for character consistency)</option>
                      <option value="balanced">Balanced (default WAN behavior)</option>
                    </select>
                    <p className="mt-1 text-[9px] text-sf-text-muted">
                      Face Lock increases sampler quality and adds identity-preserving prompt guards. Use Balanced for faster, looser motion.
                    </p>
                  </div>
                )}
                {/* Duration / Resolution / FPS / Seed */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Duration</label>
                    <div className="flex gap-1 mt-1">
                      {videoDurationPresets.map(d => (
                        <button key={d} onClick={() => setDuration(d)}
                          className={`flex-1 py-1 rounded text-xs ${duration === d ? 'bg-sf-accent text-white' : 'bg-sf-dark-800 text-sf-text-muted hover:bg-sf-dark-700'}`}
                        >{d}s</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Resolution</label>
                    <select value={`${resolution.width}x${resolution.height}`}
                      onChange={e => { const [w, h] = e.target.value.split('x').map(Number); setResolution({ width: w, height: h }) }}
                      className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                    >
                      <optgroup label="16:9 Landscape">
                        {['ltx23-i2v', 'ltx23-ia2v', 'ltx23-t2v'].includes(workflowId) && <option value="3840x2160">3840x2160 (UHD)</option>}
                        <option value="1920x1080">1920x1080</option>
                        <option value="1280x720">1280x720</option>
                        <option value="960x540">960x540</option>
                        <option value="1024x576">1024x576</option>
                        <option value="768x512">768x512</option>
                      </optgroup>
                      <optgroup label="9:16 Portrait">
                        {['ltx23-i2v', 'ltx23-ia2v', 'ltx23-t2v'].includes(workflowId) && <option value="2160x3840">2160x3840 (Vertical UHD)</option>}
                        <option value="1080x1920">1080x1920</option>
                        <option value="720x1280">720x1280</option>
                        <option value="540x960">540x960</option>
                        <option value="576x1024">576x1024</option>
                        <option value="512x768">512x768</option>
                      </optgroup>
                    </select>
                    {aspectRatioWarning && (
                      <div className="mt-2 p-2 bg-yellow-500/10 border border-yellow-500/30 rounded text-[10px] text-yellow-400">
                        <div className="font-medium mb-1">⚠ Aspect Ratio Mismatch</div>
                        <div className="text-[9px] opacity-90">
                          Input: <strong>{aspectRatioWarning.inputResolution}</strong> ({aspectRatioWarning.inputLabel})
                          <br />
                          Output: <strong>{aspectRatioWarning.outputResolution}</strong> ({aspectRatioWarning.outputLabel})
                          <br />
                          <span className="mt-1 block">
                            The input image will be resized/stretched to match the output resolution, which may cause distortion or cropping.
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">FPS</label>
                    <select value={fps} onChange={e => setFps(Number(e.target.value))}
                      className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                    >
                      <option value={24}>24 fps</option>
                      <option value={30}>30 fps</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Seed</label>
                    <div className="flex gap-1 mt-1">
                      <input type="number" value={seed} onChange={e => setSeed(Number(e.target.value))}
                        className="flex-1 bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                      />
                      <button onClick={randomizeSeed} className="p-1 bg-sf-dark-700 hover:bg-sf-dark-600 rounded" title="Randomize">
                        <RefreshCw className="w-3 h-3 text-sf-text-muted" />
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}

            {category === 'image' && (
              <>
                <div>
                  <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Prompt</label>
                  <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={3}
                    className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded-lg px-3 py-2 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent resize-none"
                    placeholder={
                      workflowId === 'image-edit' || workflowId === 'seedream-5-lite-image-edit'
                        ? 'Describe the edit (e.g. remove person on left or change color of car)'
                        : (workflowId === 'z-image-turbo' || workflowId === 'nano-banana-2' || workflowId === 'grok-text-to-image' || workflowId === 'nano-banana-pro')
                          ? 'Describe the image you want to generate...'
                          : 'Camera angle prompts are preset for this workflow'
                    }
                  />
                </div>
                {workflowId === 'image-edit' && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Steps</label>
                        <input type="number" value={editSteps} onChange={e => setEditSteps(Number(e.target.value))} min={1} max={100}
                          className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">CFG Scale</label>
                        <input type="number" value={editCfg} onChange={e => setEditCfg(Number(e.target.value))} min={1} max={20} step={0.5}
                          className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Reference images (optional)</label>
                      <p className="text-[9px] text-sf-text-muted mt-0.5 mb-1">Qwen can use 1–2 reference images for style or subject. Annotate the same image with circles and labels (e.g. &quot;remove this&quot;) then use as ref.</p>
                      {assets.filter(a => a.type === 'image').length === 0 && !annotationModalOpen && (
                        <p className="text-[9px] text-sf-text-muted mb-1.5">Add images in the <strong>Assets</strong> panel, or use <strong>Annotate image…</strong> to mark up your input.</p>
                      )}
                      <div className="flex items-center gap-2 mb-1.5">
                        <button
                          type="button"
                          onClick={openAnnotationModal}
                          disabled={annotationPreparing}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-secondary text-xs"
                        >
                          {annotationPreparing ? <Loader2 className="w-3 h-3 animate-spin" /> : <PenLine className="w-3 h-3" />}
                          {annotationPreparing ? 'Preparing frame…' : 'Annotate image…'}
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <select
                          value={referenceAssetId1 || ''}
                          onChange={e => setReferenceAssetId1(e.target.value || null)}
                          className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                        >
                          <option value="">None</option>
                          {assets.filter(a => a.type === 'image').map(a => (
                            <option key={a.id} value={a.id}>{a.name}</option>
                          ))}
                        </select>
                        <select
                          value={referenceAssetId2 || ''}
                          onChange={e => setReferenceAssetId2(e.target.value || null)}
                          className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                        >
                          <option value="">None</option>
                          {assets.filter(a => a.type === 'image').map(a => (
                            <option key={a.id} value={a.id}>{a.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </>
                )}
                {imageResolutionControlVisible && (
                  <div>
                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Image Size</label>
                    <select
                      value={selectedImageResolutionValue}
                      onChange={e => {
                        const [w, h] = e.target.value.split('x').map(Number)
                        setImageResolution({ width: w, height: h })
                      }}
                      className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                    >
                      {imageResolutionOptions.map((option) => (
                        <option
                          key={`image-resolution-${workflowId}-${option.id}`}
                          value={`${option.width}x${option.height}`}
                        >
                          {option.label} ({option.width}x{option.height})
                        </option>
                      ))}
                    </select>
                    {imageResolutionHelperText && (
                      <p className="mt-1 text-[9px] text-sf-text-muted">
                        {imageResolutionHelperText}
                      </p>
                    )}
                  </div>
                )}
                {seedreamUsesInputResolution && (
                  <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/40 px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Image Size</div>
                    <div className="mt-1 text-xs text-sf-text-primary">
                      {selectedAssetNativeResolution
                        ? `${selectedAssetNativeResolution.width}x${selectedAssetNativeResolution.height} (inherits input)`
                        : 'Inherits input image dimensions'}
                    </div>
                    <p className="mt-1 text-[9px] text-sf-text-muted">
                      Seedream edits keep the source image size instead of using a separate output-size preset.
                    </p>
                  </div>
                )}
                {(workflowId === 'multi-angles' || workflowId === 'multi-angles-scene') && (
                  <div className="p-3 bg-sf-dark-800/50 rounded-lg">
                    <div className="text-[10px] text-sf-text-muted">This workflow generates <strong className="text-sf-text-primary">8 camera angles</strong> from your input image:</div>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {['Close-up', 'Wide', '45 Right', '90 Right', 'Aerial', 'Low Angle', '45 Left', '90 Left'].map(a => (
                        <span key={a} className="px-2 py-0.5 bg-sf-dark-700 rounded text-[9px] text-sf-text-secondary">{a}</span>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Seed</label>
                  <div className="flex gap-1 mt-1">
                    <input type="number" value={seed} onChange={e => setSeed(Number(e.target.value))}
                      className="flex-1 bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                    />
                    <button onClick={randomizeSeed} className="p-1 bg-sf-dark-700 hover:bg-sf-dark-600 rounded">
                      <RefreshCw className="w-3 h-3 text-sf-text-muted" />
                    </button>
                  </div>
                </div>
              </>
            )}

            {category === 'audio' && (
              <>
                <div>
                  <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Style Tags</label>
                  <textarea value={musicTags} onChange={e => setMusicTags(e.target.value)} rows={2}
                    className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded-lg px-3 py-2 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent resize-none"
                    placeholder="cinematic orchestral, epic, dramatic, strings, brass"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Lyrics (optional)</label>
                  <textarea value={lyrics} onChange={e => setLyrics(e.target.value)} rows={4}
                    className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded-lg px-3 py-2 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent resize-none"
                    placeholder="Leave empty for instrumental..."
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Duration</label>
                    <div className="flex gap-1 mt-1">
                      {[15, 30, 60, 120].map(d => (
                        <button key={d} onClick={() => setMusicDuration(d)}
                          className={`flex-1 py-1 rounded text-xs ${musicDuration === d ? 'bg-sf-accent text-white' : 'bg-sf-dark-800 text-sf-text-muted hover:bg-sf-dark-700'}`}
                        >{d}s</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">BPM</label>
                    <input type="number" value={bpm} onChange={e => setBpm(Number(e.target.value))} min={40} max={240}
                      className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Key / Scale</label>
                    <select value={keyscale} onChange={e => setKeyscale(e.target.value)}
                      className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                    >
                      {['C major', 'C minor', 'D major', 'D minor', 'E major', 'E minor', 'F major', 'F minor', 'G major', 'G minor', 'A major', 'A minor', 'B major', 'B minor'].map(k => (
                        <option key={k} value={k}>{k}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Seed</label>
                    <div className="flex gap-1 mt-1">
                      <input type="number" value={seed} onChange={e => setSeed(Number(e.target.value))}
                        className="flex-1 bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                      />
                      <button onClick={randomizeSeed} className="p-1 bg-sf-dark-700 hover:bg-sf-dark-600 rounded">
                        <RefreshCw className="w-3 h-3 text-sf-text-muted" />
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}
              </>
            )}

            {generationMode === 'yolo' && (
              <>
                {!workflowDetailOpen ? (
                  <WorkflowBrowser
                    workflows={visibleWorkflowManifests}
                    selectedWorkflowId={selectedWorkflowManifest?.id || ''}
                    route={workflowRoute}
                    variant="create-launcher"
                    onRouteChange={handleWorkflowRouteChange}
                    onSelectWorkflow={handleWorkflowManifestSelect}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setWorkflowDetailOpen(false)}
                      className="sticky top-0 z-20 inline-flex items-center gap-2 self-start rounded-lg border border-sf-dark-700 bg-sf-dark-950/90 px-3 py-1.5 text-xs text-sf-text-secondary shadow-sm backdrop-blur transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                      Back to create workflows
                    </button>

                {isAdEasyMode ? (
                  <AdEasyMode
                    assets={assets}
                    generationQueue={generationQueue}
                    yoloActivePlan={yoloActivePlan}
                    yoloQueueVariants={yoloQueueVariants}
                    yoloStoryboardAssetMap={yoloStoryboardAssetMap}
                    yoloStoryboardReadyCount={yoloStoryboardReadyCount}
                    yoloActivePlanIsStale={yoloActivePlanIsStale}
                    yoloDependencyCheckInProgress={yoloDependencyCheckInProgress}
                    yoloScript={yoloScript}
                    setYoloScript={setYoloScript}
                    setYoloStyleNotes={setYoloStyleNotes}
                    setYoloAdBrandName={setYoloAdBrandName}
                    setYoloAdProductName={setYoloAdProductName}
                    setYoloAdColorPalette={setYoloAdColorPalette}
                    setYoloAdLogoConstraints={setYoloAdLogoConstraints}
                    setYoloAdSpokespersonRole={setYoloAdSpokespersonRole}
                    setYoloAdWardrobeNotes={setYoloAdWardrobeNotes}
                    setYoloAdProductAssetId={setYoloAdProductAssetId}
                    setYoloAdModelAssetId={setYoloAdModelAssetId}
                    setYoloAdFormatPreset={setYoloAdFormatPreset}
                    setYoloAdPlatformPreset={setYoloAdPlatformPreset}
                    setYoloAdStoryboardSource={setYoloAdStoryboardSource}
                    setYoloAdStoryboardTier={setYoloAdStoryboardTier}
                    setYoloAdVideoSource={setYoloAdVideoSource}
                    setYoloAdVideoTier={setYoloAdVideoTier}
                    setYoloAdLocalVideoWorkflowId={setYoloAdLocalVideoWorkflowId}
                    setYoloTargetDuration={setYoloTargetDuration}
                    setYoloShotsPerScene={setYoloShotsPerScene}
                    setYoloAnglesPerShot={setYoloAnglesPerShot}
                    setYoloTakesPerAngle={setYoloTakesPerAngle}
                    setYoloVideoFps={setYoloVideoFps}
                    setResolution={setResolution}
                    setImageResolution={setImageResolution}
                    handleBuildActiveYoloPlan={handleBuildActiveYoloPlan}
                    handleQueueYoloStoryboards={handleQueueYoloStoryboards}
                    handleQueueYoloShotStoryboard={handleQueueYoloShotStoryboard}
                    handleQueueYoloVideos={handleQueueYoloVideos}
                    handleQueueYoloShotVideo={handleQueueYoloShotVideo}
                    handleYoloShotImageBeatChange={handleYoloShotImageBeatChange}
                    handleYoloShotVideoBeatChange={handleYoloShotVideoBeatChange}
                    handleYoloShotTakesChange={handleYoloShotTakesChange}
                    handleAssembleAdTimeline={handleAssembleAdTimeline}
                  />
                ) : isYoloMusicMode ? (
                  <MusicVideoEasyMode
                    assets={assets}
                    yoloMusicAudioAssets={yoloMusicAudioAssets}
                    yoloMusicAudioAssetId={yoloMusicAudioAssetId}
                    setYoloMusicAudioAssetId={setYoloMusicAudioAssetId}
                    yoloMusicAudioKind={yoloMusicAudioKind}
                    setYoloMusicAudioKind={setYoloMusicAudioKind}
                    yoloMusicAudioAsset={yoloMusicAudioAsset}
                    yoloMusicTranscribingSrt={yoloMusicTranscribingSrt}
                    yoloMusicTranscriptionStatus={yoloMusicTranscriptionStatus}
                    handleYoloMusicTranscribeSrt={handleYoloMusicTranscribeSrt}
                    yoloMusicLyrics={yoloMusicLyrics}
                    setYoloMusicLyrics={setYoloMusicLyrics}
                    yoloMusicParsedLyrics={yoloMusicParsedLyrics}
                    yoloMusicScript={yoloMusicScript}
                    setYoloMusicScript={setYoloMusicScript}
                    yoloMusicCast={yoloMusicCast}
                    yoloMusicResolvedCast={yoloMusicResolvedCast}
                    yoloMusicKeyframeWorkflowId={yoloStoryboardWorkflowId}
                    setYoloMusicKeyframeWorkflowId={setYoloMusicKeyframeWorkflowId}
                    yoloMusicKeyframeWorkflowOptions={YOLO_MUSIC_KEYFRAME_WORKFLOW_OPTIONS}
                    yoloMusicVideoWorkflowId={yoloDefaultVideoWorkflowId}
                    setYoloMusicVideoWorkflowId={setYoloMusicVideoWorkflowId}
                    yoloMusicVideoWorkflowOptions={YOLO_MUSIC_VIDEO_WORKFLOW_OPTIONS}
                    handleYoloMusicCastAdd={handleYoloMusicCastAdd}
                    handleYoloMusicCastRemove={handleYoloMusicCastRemove}
                    handleYoloMusicCastAssetChange={handleYoloMusicCastAssetChange}
                    handleYoloMusicCastSlugChange={handleYoloMusicCastSlugChange}
                    handleYoloMusicCastLabelChange={handleYoloMusicCastLabelChange}
                    handleYoloMusicCastRoleChange={handleYoloMusicCastRoleChange}
                    generationQueue={generationQueue}
                    yoloActivePlan={yoloActivePlan}
                    yoloQueueVariants={yoloQueueVariants}
                    yoloStoryboardAssetMap={yoloStoryboardAssetMap}
                    yoloStoryboardReadyCount={yoloStoryboardReadyCount}
                    yoloActivePlanIsStale={yoloActivePlanIsStale}
                    yoloDependencyCheckInProgress={yoloDependencyCheckInProgress}
                    handleBuildActiveYoloPlan={handleBuildActiveYoloPlan}
                    handleQueueYoloStoryboards={handleQueueYoloStoryboards}
                    handleQueueYoloShotStoryboard={handleQueueYoloShotStoryboard}
                    handleQueueYoloVideos={handleQueueYoloVideos}
                    handleQueueYoloShotVideo={handleQueueYoloShotVideo}
                    handleYoloShotImageBeatChange={handleYoloShotImageBeatChange}
                    handleYoloShotVideoBeatChange={handleYoloShotVideoBeatChange}
                    handleCopyMusicVideoLlmPrompt={handleCopyMusicVideoLlmPrompt}
                    handleAssembleMusicVideoTimeline={handleAssembleMusicVideoTimeline}
                    setYoloVideoFps={setYoloVideoFps}
                    setResolution={setResolution}
                    setImageResolution={setImageResolution}
                  />
                ) : isYoloShortFilmMode ? (
                  <ShortFilmEasyMode
                    assets={assets}
                    generationQueue={generationQueue}
                    onQueueVoices={handleQueueShortFilmVoices}
                    onQueueKeyframes={handleQueueShortFilmKeyframes}
                    onQueueVideos={handleQueueShortFilmVideos}
                    setYoloVideoFps={setYoloVideoFps}
                    setResolution={setResolution}
                    setImageResolution={setImageResolution}
                  />
                ) : (
                  <>
                    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/40 p-2">
                      <div
                        role="tablist"
                        aria-label="Director workflow steps"
                        className="flex items-center gap-1 p-1 rounded-lg bg-sf-dark-800 border border-sf-dark-700"
                      >
                        {DIRECTOR_SUBTABS.map((tab) => {
                          const isActive = directorSubTab === tab.id
                          const needsPlan = tab.id === 'scene-shot' || tab.id === 'video-pass'
                          const needsStoryboard = tab.id === 'video-pass' && yoloStoryboardReadyCount === 0
                          const isDisabled = (needsPlan && !yoloCanEditScenes) || needsStoryboard
                          const disabledTitle = !yoloCanEditScenes
                            ? 'Build a plan first to unlock this step'
                            : 'Create at least one keyframe to unlock Videos'
                          return (
                            <button
                              key={tab.id}
                              type="button"
                              role="tab"
                              aria-selected={isActive}
                              disabled={isDisabled}
                              onClick={() => setDirectorSubTab(tab.id)}
                              title={isDisabled ? disabledTitle : ''}
                              className={`flex-1 px-3 py-1.5 rounded text-xs transition-colors ${
                                isDisabled
                                  ? 'text-sf-text-muted/60 cursor-not-allowed'
                                  : isActive
                                    ? 'bg-sf-accent text-white'
                                    : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-700'
                              }`}
                            >
                              {tab.label}
                            </button>
                          )
                        })}
                      </div>
                      <div className="mt-2 rounded-lg border border-sf-accent/40 bg-gradient-to-r from-sf-accent/20 via-sf-dark-800/90 to-sf-dark-900/90 px-3 py-2.5 text-center ring-1 ring-sf-accent/20 shadow-sm">
                        <div className="text-[10px] uppercase tracking-[0.12em] text-sf-accent/90 font-semibold">
                          Current Step: {yoloSubTabTitle}
                        </div>
                        <div className="mt-1 text-sm md:text-base font-semibold leading-snug text-sf-text-primary">
                          {yoloSubTabHelperText}
                        </div>
                      </div>
                    </div>

                    {directorSubTab === 'plan-script' && isYoloMusicMode && (
                      <>
                        {/*
                          Music Video brief — lyrics-first. Produces a plan with
                          {shotType, audioStart, length, shotPrompt, referenceImagePrompt}
                          that feeds the shared storyboard + video passes.
                          Gotcha: the LTX 2.3 audio-conditioned workflow cannot be
                          swapped for cloud (no lip-sync grounding elsewhere) — the
                          Quality picker in Setup only affects the storyboard/still
                          pass, not the video pass.
                        */}
                        <div>
                          <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Audio Type</label>
                          <div className="mt-1 grid grid-cols-3 gap-1">
                            {MUSIC_VIDEO_AUDIO_KIND_OPTIONS.map((option) => {
                              const isSelected = yoloMusicAudioKind === option.id
                              return (
                                <button
                                  key={`audio-kind-${option.id}`}
                                  type="button"
                                  onClick={() => setYoloMusicAudioKind(option.id)}
                                  title={option.description}
                                  className={`rounded px-2 py-1 text-[10px] transition-colors ${
                                    isSelected
                                      ? 'bg-sf-accent text-white'
                                      : 'border border-sf-dark-600 text-sf-text-muted hover:text-sf-text-primary hover:border-sf-dark-500'
                                  }`}
                                >
                                  {option.label}
                                </button>
                              )
                            })}
                          </div>
                          <div className="mt-1 text-[10px] text-sf-text-muted">
                            {getMusicVideoAudioKindOption(yoloMusicAudioKind)?.description || ''}
                          </div>

                          <div className="mt-3">
                            <div className="flex items-center justify-between gap-2">
                              <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Song Audio</label>
                              <button
                                type="button"
                                onClick={handleImportYoloMusicAudio}
                                disabled={yoloMusicAudioImporting || !currentProjectHandle}
                                title={currentProjectHandle ? 'Import a song audio file into this project.' : 'Open or create a project first.'}
                                className="inline-flex items-center gap-1.5 rounded border border-sf-accent/40 bg-sf-accent/10 px-2 py-1 text-[10px] font-medium text-sf-accent transition-colors hover:bg-sf-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {yoloMusicAudioImporting ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Upload className="h-3 w-3" />
                                )}
                                {yoloMusicAudioImporting ? 'Importing' : 'Import song'}
                              </button>
                            </div>
                            <select
                              value={yoloMusicAudioAssetId || ''}
                              onChange={e => setYoloMusicAudioAssetId(e.target.value || null)}
                              className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded-lg px-3 py-2 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                            >
                              <option value="">Pick an audio asset…</option>
                              {yoloMusicAudioAssets.map((asset) => (
                                <option key={asset.id} value={asset.id}>{asset.name}</option>
                              ))}
                            </select>
                            {yoloMusicAudioAssets.length === 0 && (
                              <div className="mt-1 text-[10px] text-yellow-400">
                                No song audio in this project yet.
                              </div>
                            )}
                          </div>
                        </div>

                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">
                              Lyrics (plain text, SRT, or LRC)
                            </label>
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              {yoloMusicParsedLyrics.isTimed && yoloMusicParsedLyrics.lines.length > 0 && (
                                <span className="text-[10px] text-emerald-400">
                                  {yoloMusicParsedLyrics.format.toUpperCase()} · {yoloMusicParsedLyrics.lines.length} timed lines
                                </span>
                              )}
                              {yoloMusicParsedLyrics.format === 'unknown' && yoloMusicLyrics.trim() && (
                                <span className="text-[10px] text-sf-text-muted">Plain text · {parseLyricLines(yoloMusicLyrics).length} lines</span>
                              )}
                              <button
                                type="button"
                                onClick={handleYoloMusicTranscribeSrt}
                                disabled={!yoloMusicAudioAsset || yoloMusicTranscribingSrt}
                                title={yoloMusicAudioAsset
                                  ? 'Transcribe the selected song audio with Qwen ASR and fill this box with SRT timings.'
                                  : 'Select a song audio asset first.'}
                                className="inline-flex items-center gap-1.5 rounded border border-cyan-400/40 bg-cyan-400/10 px-2 py-1 text-[10px] font-medium text-cyan-200 transition-colors hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {yoloMusicTranscribingSrt ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Wand2 className="h-3 w-3" />
                                )}
                                Transcribe to SRT
                              </button>
                            </div>
                          </div>
                          <textarea
                            value={yoloMusicLyrics}
                            onChange={e => setYoloMusicLyrics(e.target.value)}
                            rows={10}
                            className={`mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded-lg px-3 py-2 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent resize-y ${yoloMusicParsedLyrics.isTimed ? 'font-mono' : ''}`}
                            placeholder={'Paste the song lyrics here — plain text, SRT, or LRC (auto-detected).\n\nPlain text (no timings — estimated evenly):\n[Rose]\nYou paint your eyelids with correction fluid moons\nChewed up saints on the floor\n\n[Jake]\nSwollen sound inside my head\n\nSRT (recommended — real timings):\n1\n00:00:08,500 --> 00:00:12,300\nYou paint your eyelids with correction fluid moons\n\n2\n00:00:12,400 --> 00:00:16,800\nChewed up saints on the floor\n\nLRC:\n[00:08.50]You paint your eyelids with correction fluid moons\n[00:12.40]Chewed up saints on the floor\n\nTip: generate an SRT automatically with Whisper, Subtitle Edit, or ElevenLabs STT for perfect lip-sync timing.'}
                          />
                          {yoloMusicParsedLyrics.error && (
                            <div className="mt-1 text-[10px] text-amber-400">
                              {yoloMusicParsedLyrics.error}
                            </div>
                          )}
                          {yoloMusicTranscriptionStatus && (
                            <div className="mt-1 text-[10px] text-cyan-300">
                              {yoloMusicTranscriptionStatus}
                            </div>
                          )}
                          <div className="mt-1 text-[10px] text-sf-text-muted">
                            {yoloMusicParsedLyrics.isTimed
                              ? <>Timed lyrics detected — planner uses real times to resolve each shot's <span className="font-mono text-sf-text-secondary">Lyric moment:</span> and to cross-check any <span className="font-mono text-sf-text-secondary">Start at:</span> the LLM produced.</>
                              : <>Plain text — planner estimates timings linearly across the song. Paste an SRT or LRC for exact lip-sync timing. Optional <span className="font-mono text-sf-text-secondary">[Name]</span> tags above verses pick which cast member sings (plain text only).</>}
                          </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div>
                            <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Concept (optional)</label>
                            <textarea
                              value={yoloMusicConcept}
                              onChange={e => setYoloMusicConcept(e.target.value)}
                              rows={3}
                              className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded-lg px-3 py-2 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent resize-y"
                              placeholder="e.g. a lonely drive through neon-lit city streets, the singer never looks back."
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Style / Look Notes (optional)</label>
                            <textarea
                              value={yoloMusicStyleNotes}
                              onChange={e => setYoloMusicStyleNotes(e.target.value)}
                              rows={3}
                              className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded-lg px-3 py-2 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent resize-y"
                              placeholder="e.g. grainy 16mm, warm tungsten interiors, cool neon exteriors, wardrobe: denim + leather."
                            />
                          </div>
                        </div>

                        <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/35 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Project Style Cards</div>
                              <p className="mt-1 text-[10px] text-sf-text-secondary">
                                Pick a look once, then every shot and chat-AI prompt can inherit it through Style / Look Notes.
                              </p>
                            </div>
                            <span className="rounded-full border border-sf-dark-600 bg-sf-dark-900 px-2 py-0.5 text-[10px] text-sf-text-muted">
                              First-class style
                            </span>
                          </div>
                          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                            {MUSIC_VIDEO_STYLE_CARD_OPTIONS.map((styleCard) => (
                              <button
                                key={styleCard.id}
                                type="button"
                                onClick={() => handleMusicStyleCardApply(styleCard.notes)}
                                className="rounded-lg border border-sf-dark-600 bg-sf-dark-900/70 px-3 py-2 text-left transition-colors hover:border-sf-accent/60 hover:bg-sf-accent/10"
                                title={styleCard.notes}
                              >
                                <div className="text-xs font-semibold text-sf-text-primary">{styleCard.label}</div>
                                <div className="mt-1 line-clamp-2 text-[10px] text-sf-text-muted">{styleCard.notes}</div>
                              </button>
                            ))}
                          </div>
                        </div>

                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">
                              Project Cast {yoloMusicCast.length > 0 ? `(${yoloMusicCast.length})` : ''}
                            </label>
                            <button
                              type="button"
                              onClick={handleYoloMusicCastAdd}
                              className="px-2 py-1 rounded border border-sf-dark-500 text-[10px] text-sf-text-secondary hover:text-sf-text-primary hover:border-sf-dark-400 transition-colors"
                            >
                              + Add cast member
                            </button>
                          </div>
                          {yoloMusicCast.length === 0 ? (
                            <div className="mt-1 rounded-lg border border-dashed border-sf-dark-600 bg-sf-dark-800/40 px-3 py-3 text-[11px] text-sf-text-muted">
                              No cast yet. Click <span className="text-sf-text-secondary">+ Add cast member</span> to pick an image asset (a still of the singer / band member) and give them a short handle like <span className="font-mono text-sf-text-secondary">rose</span>. You can then reference them in your script with <span className="font-mono text-sf-text-secondary">Artist: rose</span> or in lyrics with <span className="font-mono text-sf-text-secondary">[Rose]</span> tag lines. Leave it empty for reference-free shots (the model will improvise the singer's look).
                            </div>
                          ) : (
                            <div className="mt-1 space-y-1.5">
                              {yoloMusicCast.map((entry, idx) => {
                                const assetOption = assets.find((a) => a?.id === entry?.assetId && a?.type === 'image')
                                const isDefault = idx === 0
                                return (
                                  <div
                                    key={entry.id || `cast-row-${idx}`}
                                    className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/60 p-2"
                                  >
                                    <div className="grid grid-cols-1 md:grid-cols-[1fr_120px_1fr_120px_32px] gap-1.5 items-center">
                                      <select
                                        value={entry?.assetId || ''}
                                        onChange={(e) => handleYoloMusicCastAssetChange(entry.id, e.target.value || null)}
                                        className="bg-sf-dark-900 border border-sf-dark-600 rounded px-2 py-1 text-[11px] text-sf-text-primary focus:outline-none focus:border-sf-accent"
                                      >
                                        <option value="">Pick image asset…</option>
                                        {assets.filter((asset) => asset?.type === 'image').map((asset) => (
                                          <option key={`cast-asset-${entry.id}-${asset.id}`} value={asset.id}>{asset.name}</option>
                                        ))}
                                      </select>
                                      <input
                                        type="text"
                                        value={entry?.slug || ''}
                                        onChange={(e) => handleYoloMusicCastSlugChange(entry.id, e.target.value)}
                                        placeholder="slug (e.g. rose)"
                                        className="bg-sf-dark-900 border border-sf-dark-600 rounded px-2 py-1 text-[11px] text-sf-text-primary font-mono focus:outline-none focus:border-sf-accent"
                                      />
                                      <input
                                        type="text"
                                        value={entry?.label || ''}
                                        onChange={(e) => handleYoloMusicCastLabelChange(entry.id, e.target.value)}
                                        placeholder="Display name"
                                        className="bg-sf-dark-900 border border-sf-dark-600 rounded px-2 py-1 text-[11px] text-sf-text-primary focus:outline-none focus:border-sf-accent"
                                      />
                                      <select
                                        value={entry?.role || 'lead'}
                                        onChange={(e) => handleYoloMusicCastRoleChange(entry.id, e.target.value)}
                                        className="bg-sf-dark-900 border border-sf-dark-600 rounded px-2 py-1 text-[11px] text-sf-text-primary focus:outline-none focus:border-sf-accent"
                                      >
                                        {MUSIC_VIDEO_CAST_ROLE_OPTIONS.map((option) => (
                                          <option key={`cast-role-${entry.id}-${option.id}`} value={option.id}>{option.label}</option>
                                        ))}
                                      </select>
                                      <button
                                        type="button"
                                        onClick={() => handleYoloMusicCastRemove(entry.id)}
                                        className="h-7 w-7 rounded border border-sf-dark-600 text-sf-text-muted hover:text-red-400 hover:border-red-500/60 transition-colors flex items-center justify-center"
                                        title="Remove cast member"
                                        aria-label={`Remove cast member ${entry?.label || ''}`.trim()}
                                      >
                                        <X className="h-3 w-3" />
                                      </button>
                                    </div>
                                    {isDefault && (
                                      <div className="mt-1 text-[10px] text-sf-text-muted">
                                        Default lead — used when a shot has no <span className="font-mono">Artist:</span> override and the matched lyric line has no <span className="font-mono">[Name]</span> tag.
                                      </div>
                                    )}
                                    {!assetOption && entry?.assetId && (
                                      <div className="mt-1 text-[10px] text-yellow-400">
                                        Image asset missing — it may have been deleted. Pick a replacement or remove this row.
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}
                          <div className="mt-2 text-[10px] text-sf-text-muted">
                            <div>
                              Reference cast in your script with <span className="font-mono text-sf-text-secondary">Artist: rose</span>, <span className="font-mono text-sf-text-secondary">Artist: jake</span>, or <span className="font-mono text-sf-text-secondary">Artist: both</span> (also <span className="font-mono">all</span> / <span className="font-mono">band</span>). In lyrics, drop a tag line above the verse: <span className="font-mono text-sf-text-secondary">[Rose]</span>, <span className="font-mono text-sf-text-secondary">[Jake]</span>, <span className="font-mono text-sf-text-secondary">[Rose, Jake]</span>. Section markers like <span className="font-mono">[Chorus]</span> and <span className="font-mono">[Verse 1]</span> are ignored.
                            </div>
                          </div>
                        </div>

                        <div>
                          {/* Tab strip — Master + one tab per saved alt pass.
                              Clicking a tab switches the script panel below to
                              that slot; the textarea rebinds automatically.
                              Shared renderer so the banner on Keyframes/Videos
                              can pivot between passes using the same controls. */}
                          {renderPassTabStrip('full')}

                          {/* Header row — contents depend on whether the
                              active tab is Master or an alt pass. */}
                          {yoloMusicIsMasterActive ? (
                            <>
                              <div className="flex items-center justify-between gap-2 mt-2">
                                <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Director Script</label>
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      // Only overwrite when the script is empty — otherwise we'd
                                      // clobber the user's in-progress work. If they want a fresh
                                      // start, they can clear the textarea first.
                                      if (!yoloMusicScript.trim()) {
                                        setYoloMusicScript(MUSIC_VIDEO_SCRIPT_TEMPLATE)
                                      } else if (window.confirm('Replace the current script with the template?')) {
                                        setYoloMusicScript(MUSIC_VIDEO_SCRIPT_TEMPLATE)
                                      }
                                    }}
                                    className="px-2 py-1 rounded border border-sf-dark-500 text-[10px] text-sf-text-secondary hover:text-sf-text-primary hover:border-sf-dark-400 transition-colors"
                                  >
                                    Start from template
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => { void copyTextToClipboard(MUSIC_VIDEO_SCRIPT_TEMPLATE) }}
                                    className="px-2 py-1 rounded border border-sf-dark-500 text-[10px] text-sf-text-secondary hover:text-sf-text-primary hover:border-sf-dark-400 transition-colors"
                                  >
                                    Copy Template
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const llmPrompt = buildMusicVideoLLMPrompt({
                                        songName: yoloMusicAudioAsset?.name || '',
                                        songDurationSeconds: yoloMusicSongDurationSeconds,
                                        targetDuration: yoloMusicTargetDuration,
                                        concept: yoloMusicConcept,
                                        styleNotes: yoloMusicStyleNotes,
                                        lyrics: yoloMusicLyrics,
                                        cast: yoloMusicResolvedCast,
                                      })
                                      void copyTextToClipboard(llmPrompt)
                                    }}
                                    title="Copy a ready-to-paste prompt (cast + concept + lyrics/SRT + strict format spec) you can hand to Claude/GPT/Gemini to generate a timing-correct script."
                                    className="px-2 py-1 rounded border border-sf-accent/50 bg-sf-accent/10 text-[10px] text-sf-accent hover:bg-sf-accent/20 transition-colors"
                                  >
                                    Copy LLM Prompt
                                  </button>
                                </div>
                              </div>
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">
                                  Alt passes:
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (!yoloMusicScript.trim()) {
                                      setFormError('Write or paste your master Director Script first — alt passes inherit its timings.')
                                      return
                                    }
                                    // eslint-disable-next-line no-alert
                                    const variant = window.prompt(
                                      'Describe the alt performance setting (e.g. "Jake alone in the Volvo at night, dash glow on his face"). Leave blank to cancel.',
                                      ''
                                    )
                                    if (!variant || !variant.trim()) return
                                    handleCreateMusicAltScript({ passType: 'alt_performance', variantDescriptor: variant.trim() })
                                  }}
                                  title="Second performance pass in a different setting (car, rooftop, etc.) that intercuts with the master. Creates a new tab and copies the LLM prompt."
                                  className="px-2 py-1 rounded border border-sf-dark-500 text-[10px] text-sf-text-secondary hover:text-sf-text-primary hover:border-sf-dark-400 transition-colors"
                                >
                                  + Alt Performance
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    handleCreateMusicAltScript({ passType: 'environmental_broll' })
                                  }}
                                  title="No-performer b-roll of the world: empty rooms, exteriors, weather, landscapes. Creates a new tab and copies the LLM prompt."
                                  className="px-2 py-1 rounded border border-sf-dark-500 text-[10px] text-sf-text-secondary hover:text-sf-text-primary hover:border-sf-dark-400 transition-colors"
                                >
                                  + Environmental B-roll
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    handleCreateMusicAltScript({ passType: 'detail_broll' })
                                  }}
                                  title="Tight macro/insert b-roll: gear, objects, hands, textures. Creates a new tab and copies the LLM prompt."
                                  className="px-2 py-1 rounded border border-sf-dark-500 text-[10px] text-sf-text-secondary hover:text-sf-text-primary hover:border-sf-dark-400 transition-colors"
                                >
                                  + Detail B-roll
                                </button>
                                <span className="text-[10px] text-sf-text-muted">
                                  Each alt pass opens in its own tab and inherits this master's timings.
                                </span>
                              </div>
                            </>
                          ) : (
                            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0 flex-1">
                                <span className="px-1.5 py-0.5 rounded bg-sf-dark-700 text-[9px] font-bold tracking-wider text-sf-text-secondary">
                                  {getMusicVideoPassBadge(yoloMusicActiveAltScript.passType)}
                                </span>
                                <input
                                  type="text"
                                  value={yoloMusicActiveAltScript.label}
                                  onChange={(e) => handleMusicAltScriptRename(yoloMusicActiveAltScript.id, e.target.value)}
                                  placeholder="Pass label"
                                  className="flex-1 min-w-[8rem] max-w-[20rem] bg-sf-dark-900 border border-sf-dark-600 rounded px-2 py-1 text-[11px] text-sf-text-primary focus:outline-none focus:border-sf-accent"
                                />
                                {yoloMusicActiveAltScript.passType === 'alt_performance' && yoloMusicActiveAltScript.variantDescriptor && (
                                  <span className="text-[10px] text-sf-text-muted truncate" title={yoloMusicActiveAltScript.variantDescriptor}>
                                    variant: {yoloMusicActiveAltScript.variantDescriptor}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (!yoloMusicScript.trim()) {
                                      setFormError('Write or paste your master Director Script first — this alt pass inherits its timings.')
                                      return
                                    }
                                    const prompt = buildMusicVideoAltPrompt({
                                      passType: yoloMusicActiveAltScript.passType,
                                      variantDescriptor: yoloMusicActiveAltScript.variantDescriptor,
                                    })
                                    void copyTextToClipboard(prompt)
                                  }}
                                  title="Re-copy this pass's LLM prompt using the CURRENT master script. Useful when the master changed after the pass was first created."
                                  className="px-2 py-1 rounded border border-sf-accent/50 bg-sf-accent/10 text-[10px] text-sf-accent hover:bg-sf-accent/20 transition-colors"
                                >
                                  Re-copy LLM Prompt
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleMusicAltScriptDelete(yoloMusicActiveAltScript.id)}
                                  title="Delete this alt pass."
                                  className="px-2 py-1 rounded border border-sf-dark-500 text-[10px] text-sf-text-secondary hover:text-red-400 hover:border-red-500/60 transition-colors"
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          )}

                          <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-800/45 p-3">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Shot control chips</div>
                                <p className="mt-1 text-[10px] text-sf-text-secondary">
                                  Click a chip to add director-format guidance to the active script. These compile into the same Camera, Keyframe prompt, Motion prompt, and Shot type fields used by the planner.
                                </p>
                              </div>
                              <span className="rounded-full border border-sf-dark-600 bg-sf-dark-900 px-2 py-0.5 text-[10px] text-sf-text-muted">
                                LTX-style quick controls
                              </span>
                            </div>
                            <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
                              {[
                                ['Camera', MUSIC_VIDEO_CAMERA_MOVE_OPTIONS],
                                ['Shot size', MUSIC_VIDEO_SHOT_SIZE_OPTIONS],
                                ['Energy', MUSIC_VIDEO_ENERGY_OPTIONS],
                                ['Performance mode', MUSIC_VIDEO_PERFORMANCE_MODE_OPTIONS],
                              ].map(([groupLabel, options]) => (
                                <div key={groupLabel} className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/55 p-2">
                                  <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-sf-text-muted">{groupLabel}</div>
                                  <div className="flex flex-wrap gap-1.5">
                                    {options.map((option) => (
                                      <button
                                        key={`${groupLabel}-${option.id}`}
                                        type="button"
                                        onClick={() => handleMusicScriptQuickChip(option.scriptLine)}
                                        className="rounded-full border border-sf-dark-600 px-2 py-1 text-[10px] text-sf-text-secondary transition-colors hover:border-sf-accent/60 hover:bg-sf-accent/10 hover:text-sf-text-primary"
                                        title={option.scriptLine}
                                      >
                                        {option.label}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          <textarea
                            value={yoloMusicIsMasterActive ? yoloMusicScript : yoloMusicActiveAltScript.script}
                            onChange={e => {
                              if (yoloMusicIsMasterActive) {
                                setYoloMusicScript(e.target.value)
                              } else {
                                handleMusicAltScriptChangeContent(yoloMusicActiveAltScript.id, e.target.value)
                              }
                            }}
                            rows={16}
                            className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded-lg px-3 py-2 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent resize-y font-mono"
                            placeholder={yoloMusicIsMasterActive
                              ? 'Shot 1: ...\nStart at: 0:00\nLyric moment: "..."\nShot type: performance | performance_wide | b_roll\nArtist: rose | jake | both\nKeyframe prompt: ...\nMotion prompt: ...\nCamera: ...\nLength: 3\n\nShot 2: ...\n'
                              : 'Paste the alt pass output from your LLM here.\n\nShot 1: ...\nStart at: 0:00\nShot type: b_roll\nKeyframe prompt: ...\nMotion prompt: ...\nCamera: ...\nLength: 4\n\nShot 2: ...\n'
                            }
                          />
                          <div className="mt-1 text-[10px] text-sf-text-muted">
                            {yoloMusicIsMasterActive ? (
                              <>One shot per block. <span className="font-mono text-sf-text-secondary">Start at:</span> pins the shot to an absolute time (use the SRT above). <span className="font-mono text-sf-text-secondary">Shot type</span> drives whether the singer is visible lip-syncing (performance / performance_wide) or cut away (b_roll). Each shot runs the LTX 2.3 audio workflow independently.</>
                            ) : (
                              <>This is an alt <span className="text-sf-text-secondary">{getMusicVideoPassDisplayName(yoloMusicActiveAltScript.passType)}</span> pass. Click <span className="text-sf-text-secondary">Build Plan</span> to parse it into shots — after that the storyboard, keyframe, and video steps operate on this pass&apos;s shots just like the master. Switch back to Master anytime; each pass keeps its own plan.</>
                            )}
                          </div>
                          {!yoloMusicIsMasterActive && yoloMusicActiveAltParse && (() => {
                            const parse = yoloMusicActiveAltParse
                            if (parse.state === 'empty') {
                              return (
                                <div className="mt-2 rounded-lg border border-sf-dark-700 bg-sf-dark-800/40 px-3 py-2 text-[10px] text-sf-text-muted">
                                  Paste the LLM output above to see a parse preview (shot count, coverage, warnings).
                                </div>
                              )
                            }
                            if (parse.state === 'unparsed') {
                              return (
                                <div className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2">
                                  <div className="text-[10px] uppercase tracking-wider text-red-400">
                                    Could not parse this script
                                  </div>
                                  <div className="mt-1 text-[11px] text-red-200/90 leading-snug">
                                    The parser didn't find any valid shot blocks. Make sure each shot starts with <span className="font-mono">Shot N:</span> and includes at least a <span className="font-mono">Keyframe prompt</span> and <span className="font-mono">Motion prompt</span>.
                                  </div>
                                  {parse.warnings.length > 0 && (
                                    <ul className="mt-1 space-y-0.5">
                                      {parse.warnings.slice(0, 4).map((w, idx) => (
                                        <li key={`alt-unparsed-w-${idx}`} className="text-[10px] text-red-200/80 leading-snug">
                                          {w?.message || String(w)}
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                              )
                            }
                            const tone = parse.state === 'warning'
                              ? { border: 'border-yellow-500/40', bg: 'bg-yellow-500/10', label: 'text-yellow-400', body: 'text-yellow-200/90', soft: 'text-yellow-200/60' }
                              : { border: 'border-emerald-500/40', bg: 'bg-emerald-500/10', label: 'text-emerald-400', body: 'text-emerald-200/90', soft: 'text-emerald-200/60' }
                            const coveragePct = yoloMusicSongDurationSeconds > 0
                              ? Math.round((parse.totalLengthSec / yoloMusicSongDurationSeconds) * 100)
                              : null
                            return (
                              <div className={`mt-2 rounded-lg border ${tone.border} ${tone.bg} px-3 py-2`}>
                                <div className={`text-[10px] uppercase tracking-wider ${tone.label}`}>
                                  Parse preview · {parse.state === 'warning' ? `${parse.warnings.length} warning${parse.warnings.length === 1 ? '' : 's'}` : 'clean'}
                                </div>
                                <div className={`mt-1 text-[11px] ${tone.body} leading-snug flex flex-wrap gap-x-3 gap-y-0.5`}>
                                  <span><span className="font-mono">{parse.shotCount}</span> shot{parse.shotCount === 1 ? '' : 's'}</span>
                                  <span><span className="font-mono">{formatSecondsAsMMSS(parse.totalLengthSec)}</span> total length{coveragePct !== null ? ` (${coveragePct}% of song)` : ''}</span>
                                  {parse.coverageGaps.length > 0 && (
                                    <span className={tone.soft}>
                                      {parse.coverageGaps.length} gap{parse.coverageGaps.length === 1 ? '' : 's'}: {parse.coverageGaps.slice(0, 3).map((g) => `${formatSecondsAsMMSS(g.start)}–${formatSecondsAsMMSS(g.end)}`).join(', ')}{parse.coverageGaps.length > 3 ? '…' : ''}
                                    </span>
                                  )}
                                </div>
                                {parse.state === 'warning' && parse.warnings.length > 0 && (
                                  <ul className="mt-1 space-y-0.5">
                                    {parse.warnings.slice(0, 4).map((w, idx) => (
                                      <li key={`alt-w-${idx}`} className={`text-[11px] ${tone.body} leading-snug`}>
                                        {w?.message || String(w)}
                                      </li>
                                    ))}
                                    {parse.warnings.length > 4 && (
                                      <li className={`text-[10px] ${tone.soft}`}>
                                        …and {parse.warnings.length - 4} more.
                                      </li>
                                    )}
                                  </ul>
                                )}
                                <div className={`mt-1 text-[10px] ${tone.soft}`}>
                                  Live parse of the textarea. Click <span className="font-mono">Build Plan</span> to promote this into the shot plan for the Storyboard / Keyframes / Videos steps.
                                </div>
                              </div>
                            )
                          })()}
                          {!yoloMusicIsMasterActive
                            && yoloMusicActiveAltParse
                            && (yoloMusicActiveAltParse.state === 'ok' || yoloMusicActiveAltParse.state === 'warning')
                            && yoloMusicSongDurationSeconds > 0
                            && (() => {
                              // Coverage sparkline — a single-row horizontal bar where each
                              // parsed shot maps to a proportional slice of the song duration.
                              // Overlapping shots will overlap visually (that's fine; the
                              // planner warnings already flag overlaps).
                              const songDur = yoloMusicSongDurationSeconds
                              const scenes = yoloMusicActiveAltParse.scenes || []
                              const isWarning = yoloMusicActiveAltParse.state === 'warning'
                              const barColor = isWarning ? 'bg-yellow-400/80' : 'bg-emerald-400/80'
                              const segments = []
                              for (const scene of scenes) {
                                for (const shot of scene?.shots || []) {
                                  const start = Math.max(0, Number(shot?.audioStart ?? 0) || 0)
                                  const len = Math.max(0, Number(shot?.durationSeconds ?? shot?.length ?? 0) || 0)
                                  if (len <= 0) continue
                                  const leftPct = Math.min(100, (start / songDur) * 100)
                                  const widthPct = Math.max(0.4, Math.min(100 - leftPct, (len / songDur) * 100))
                                  segments.push({
                                    key: `${scene.id}-${shot.id}`,
                                    leftPct,
                                    widthPct,
                                    title: `${scene.label || `Shot ${scene.index}`} · ${formatSecondsAsMMSS(start)}–${formatSecondsAsMMSS(start + len)} (${len.toFixed(1)}s)`,
                                  })
                                }
                              }
                              if (segments.length === 0) return null
                              return (
                                <div className="mt-2 rounded-lg border border-sf-dark-700 bg-sf-dark-800/40 px-3 py-2">
                                  <div className="flex items-center justify-between text-[10px] text-sf-text-muted mb-1">
                                    <span className="uppercase tracking-wider">Coverage map</span>
                                    <span>
                                      <span className="font-mono text-sf-text-secondary">{formatSecondsAsMMSS(0)}</span>
                                      {' → '}
                                      <span className="font-mono text-sf-text-secondary">{formatSecondsAsMMSS(songDur)}</span>
                                    </span>
                                  </div>
                                  <div className="relative h-3 w-full rounded bg-sf-dark-900/70 overflow-hidden">
                                    {segments.map((seg) => (
                                      <div
                                        key={seg.key}
                                        className={`absolute top-0 bottom-0 ${barColor} rounded-sm`}
                                        style={{ left: `${seg.leftPct}%`, width: `${seg.widthPct}%` }}
                                        title={seg.title}
                                      />
                                    ))}
                                  </div>
                                  <div className="mt-1 text-[10px] text-sf-text-muted">
                                    Each bar is one parsed shot placed at its <span className="font-mono">Start at:</span> on the song timeline. Dark gaps are uncovered seconds — fill them in the LLM prompt if the pass needs full coverage.
                                  </div>
                                </div>
                              )
                            })()}
                          {!yoloMusicIsMasterActive
                            && yoloMusicActiveAltParse
                            && (yoloMusicActiveAltParse.state === 'ok' || yoloMusicActiveAltParse.state === 'warning')
                            && (() => {
                              const scenes = yoloMusicActiveAltParse.scenes || []
                              const flatShots = []
                              for (const scene of scenes) {
                                for (const shot of scene?.shots || []) {
                                  flatShots.push({ scene, shot })
                                }
                              }
                              if (flatShots.length === 0) return null
                              const truncate = (text, max = 140) => {
                                const s = String(text || '').trim()
                                if (!s) return ''
                                return s.length > max ? `${s.slice(0, max - 1)}…` : s
                              }
                              return (
                                <div className="mt-2 rounded-lg border border-sf-dark-700 bg-sf-dark-800/40">
                                  <button
                                    type="button"
                                    onClick={() => setAltPassBreakdownExpanded((prev) => !prev)}
                                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
                                  >
                                    <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">
                                      Shot breakdown ({flatShots.length})
                                    </span>
                                    {altPassBreakdownExpanded ? (
                                      <ChevronDown className="h-3.5 w-3.5 text-sf-text-muted" />
                                    ) : (
                                      <ChevronRight className="h-3.5 w-3.5 text-sf-text-muted" />
                                    )}
                                  </button>
                                  {altPassBreakdownExpanded && (
                                    <div className="border-t border-sf-dark-700 px-3 py-2 max-h-80 overflow-y-auto space-y-2">
                                      {flatShots.map(({ scene, shot }) => {
                                        const start = Number(shot?.audioStart ?? 0) || 0
                                        const len = Number(shot?.durationSeconds ?? shot?.length ?? 0) || 0
                                        const musicShotType = String(shot?.musicShotType || '')
                                        const lyricMoment = String(shot?.scriptLyricMoment || '').trim()
                                        const keyframe = truncate(shot?.keyframePromptRaw || shot?.imageBeat)
                                        const motion = truncate(shot?.motionPromptRaw || shot?.videoBeat)
                                        const camera = String(shot?.cameraDirection || '').trim()
                                        return (
                                          <div
                                            key={`${scene.id}-${shot.id}`}
                                            className="rounded border border-sf-dark-700/60 bg-sf-dark-900/40 px-2 py-1.5"
                                          >
                                            <div className="flex items-center justify-between gap-2 text-[10px]">
                                              <span className="font-mono text-sf-text-secondary truncate">
                                                {scene.label || `Shot ${scene.index}`}
                                              </span>
                                              <span className="text-sf-text-muted flex items-center gap-2 flex-shrink-0">
                                                {musicShotType && (
                                                  <span className="rounded bg-sf-dark-700 px-1 py-[1px] text-[9px] uppercase tracking-wider">
                                                    {musicShotType}
                                                  </span>
                                                )}
                                                <span className="font-mono">
                                                  {formatSecondsAsMMSS(start)} · {len.toFixed(1)}s
                                                </span>
                                              </span>
                                            </div>
                                            {lyricMoment && (
                                              <div className="mt-0.5 text-[10px] italic text-sf-text-muted truncate">
                                                “{lyricMoment}”
                                              </div>
                                            )}
                                            {keyframe && (
                                              <div className="mt-1 text-[10px] text-sf-text-secondary leading-snug">
                                                <span className="text-sf-text-muted">Keyframe: </span>
                                                {keyframe}
                                              </div>
                                            )}
                                            {motion && (
                                              <div className="mt-0.5 text-[10px] text-sf-text-secondary leading-snug">
                                                <span className="text-sf-text-muted">Motion: </span>
                                                {motion}
                                              </div>
                                            )}
                                            {camera && (
                                              <div className="mt-0.5 text-[10px] text-sf-text-muted leading-snug">
                                                <span>Camera: </span>
                                                <span className="font-mono text-sf-text-secondary">{camera}</span>
                                              </div>
                                            )}
                                          </div>
                                        )
                                      })}
                                    </div>
                                  )}
                                </div>
                              )
                            })()}
                          <div className="mt-2 rounded-lg border border-sf-dark-700 bg-sf-dark-800/45 p-3">
                            <button
                              type="button"
                              onClick={() => setDirectorFormatExpanded((prev) => !prev)}
                              className="flex w-full items-center justify-between gap-2 text-left"
                            >
                              <span className="text-[10px] uppercase tracking-wider text-yellow-400">Recommended Director Format (Music Video)</span>
                              {directorFormatExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5 text-sf-text-muted" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5 text-sf-text-muted" />
                              )}
                            </button>
                            {directorFormatExpanded && (
                              <>
                                <div className="mt-1 text-[10px] text-sf-text-muted">
                                  Ask your AI to return this exact structure. Each Shot block becomes one generated video clip. <span className="font-mono text-sf-text-secondary">Start at:</span>, Lyric moment, Artist, and Shot type are music-video-only fields; everything else mirrors the ad format. The "Copy LLM Prompt" button assembles this plus your cast, lyrics, and SRT — hand it to Claude/GPT/Gemini and paste the result back.
                                </div>
                                <textarea
                                  readOnly
                                  value={MUSIC_VIDEO_SCRIPT_TEMPLATE}
                                  rows={16}
                                  spellCheck={false}
                                  onFocus={(event) => event.target.select()}
                                  onClick={(event) => event.target.select()}
                                  className="mt-2 w-full resize-y overflow-auto rounded border border-sf-dark-700 bg-sf-dark-900/70 p-2 font-mono text-[10px] leading-5 text-sf-text-secondary focus:outline-none focus:border-sf-accent"
                                />
                              </>
                            )}
                          </div>
                        </div>

                        {yoloMusicActiveTargetPlanWarnings.length > 0 && (
                          <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2">
                            <div className="text-[10px] uppercase tracking-wider text-yellow-400">
                              Planner warnings ({yoloMusicActiveTargetPlanWarnings.length})
                            </div>
                            <ul className="mt-1 space-y-0.5">
                              {yoloMusicActiveTargetPlanWarnings.slice(0, 6).map((warning, idx) => (
                                <li
                                  key={`mv-warning-${idx}`}
                                  className="text-[11px] text-yellow-200/90 leading-snug"
                                >
                                  {warning?.message || String(warning)}
                                </li>
                              ))}
                              {yoloMusicActiveTargetPlanWarnings.length > 6 && (
                                <li className="text-[10px] text-yellow-200/60">
                                  …and {yoloMusicActiveTargetPlanWarnings.length - 6} more. Fix the highlighted rows and rebuild the plan.
                                </li>
                              )}
                            </ul>
                            <div className="mt-1 text-[10px] text-yellow-200/60">
                              These are advisory — the plan still built, but those shots fell back to the default cast member (or no reference at all).
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    {directorSubTab === 'plan-script' && !isYoloMusicMode && (
                      <>
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Ad Script</label>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  if (!yoloScript.trim()) {
                                    setYoloScript(DIRECTOR_SCRIPT_TEMPLATE)
                                  } else if (window.confirm('Replace the current ad script with the template?')) {
                                    setYoloScript(DIRECTOR_SCRIPT_TEMPLATE)
                                  }
                                }}
                                className="px-2 py-1 rounded border border-sf-dark-500 text-[10px] text-sf-text-secondary hover:text-sf-text-primary hover:border-sf-dark-400 transition-colors"
                              >
                                Start from template
                              </button>
                              <button
                                type="button"
                                onClick={() => { void copyTextToClipboard(DIRECTOR_SCRIPT_TEMPLATE) }}
                                className="px-2 py-1 rounded border border-sf-dark-500 text-[10px] text-sf-text-secondary hover:text-sf-text-primary hover:border-sf-dark-400 transition-colors"
                              >
                                Copy Template
                              </button>
                              <button
                                type="button"
                                onClick={handleInsertAdNativeTextClips}
                                disabled={yoloAdNativeTextEntries.length === 0}
                                title={yoloAdNativeTextEntries.length === 0 ? 'Build a plan with Text overlay or End card fields first' : 'Insert text-overlay and end-card fields as timeline text clips'}
                                className={`px-2 py-1 rounded border text-[10px] transition-colors ${
                                  yoloAdNativeTextEntries.length === 0
                                    ? 'border-sf-dark-600 text-sf-text-muted cursor-not-allowed'
                                    : 'border-sf-accent/50 bg-sf-accent/10 text-sf-accent hover:bg-sf-accent/20'
                                }`}
                              >
                                Insert Text Cards
                              </button>
                            </div>
                          </div>
                          <div className="mt-2 rounded-lg border border-sf-dark-700 bg-sf-dark-800/35 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <div>
                                <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Ad shot control chips</div>
                                <p className="mt-1 text-[10px] text-sf-text-muted">
                                  Click a chip to append valid ad director-format lines to the current script.
                                </p>
                              </div>
                              <span className="rounded-full border border-sf-dark-600 bg-sf-dark-900 px-2 py-0.5 text-[10px] text-sf-text-muted">
                                Commercial grammar
                              </span>
                            </div>
                            {[
                              { label: 'Commercial beat', options: YOLO_AD_COMMERCIAL_BEAT_OPTIONS },
                              { label: 'Product view', options: YOLO_AD_PRODUCT_VIEW_OPTIONS },
                              { label: 'Camera', options: YOLO_AD_CAMERA_CHIP_OPTIONS },
                              { label: 'Energy', options: YOLO_AD_ENERGY_OPTIONS },
                              { label: 'Talent', options: YOLO_AD_TALENT_MODE_OPTIONS },
                            ].map((group) => (
                              <div key={`ad-chip-group-${group.label}`} className="mt-3">
                                <div className="mb-1 text-[10px] uppercase tracking-wider text-sf-text-muted">{group.label}</div>
                                <div className="flex flex-wrap gap-1">
                                  {group.options.map((option) => (
                                    <button
                                      key={`ad-chip-${group.label}-${option.id}`}
                                      type="button"
                                      onClick={() => handleAdScriptQuickChip(option.scriptLine)}
                                      className="rounded-full border border-sf-dark-600 bg-sf-dark-900/70 px-2 py-1 text-[10px] text-sf-text-secondary transition-colors hover:border-sf-accent/60 hover:text-sf-text-primary hover:bg-sf-accent/10"
                                      title={option.scriptLine}
                                    >
                                      {option.label}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                          <textarea
                            value={yoloScript}
                            onChange={e => setYoloScript(e.target.value)}
                            rows={12}
                            className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded-lg px-3 py-2 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent resize-y"
                            placeholder="Paste your director script here. Recommended: Scene 1 + Scene context + Shot 1 + Ad beat + Product mode + Talent mode + Shot type + Keyframe prompt + Motion prompt + Camera + Text overlay / End card + Duration."
                          />
                          <div className="mt-2 rounded-lg border border-sf-dark-700 bg-sf-dark-800/45 p-3">
                            <button
                              type="button"
                              onClick={() => setDirectorFormatExpanded((prev) => !prev)}
                              className="flex w-full items-center justify-between gap-2 text-left"
                            >
                              <span className="text-[10px] uppercase tracking-wider text-yellow-400">Recommended Director Format</span>
                              {directorFormatExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5 text-sf-text-muted" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5 text-sf-text-muted" />
                              )}
                            </button>
                            {directorFormatExpanded && (
                              <>
                                <div className="mt-1 text-[10px] text-sf-text-muted">
                                  Ask your AI to return this exact structure. Director Mode uses commercial beat, product mode, talent mode, dialogue, text overlay, end card, prompts, camera notes, and duration when present. Text-heavy fields should become editor-native text clips, not AI-rendered typography.
                                </div>
                                <textarea
                                  readOnly
                                  value={DIRECTOR_SCRIPT_TEMPLATE}
                                  rows={14}
                                  spellCheck={false}
                                  onFocus={(event) => event.target.select()}
                                  onClick={(event) => event.target.select()}
                                  className="mt-2 w-full resize-y overflow-auto rounded border border-sf-dark-700 bg-sf-dark-900/70 p-2 font-mono text-[10px] leading-5 text-sf-text-secondary focus:outline-none focus:border-sf-accent"
                                />
                              </>
                            )}
                          </div>
                        </div>

                        <div>
                          <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Style / Brand Notes (optional)</label>
                          <textarea
                            value={yoloStyleNotes}
                            onChange={e => setYoloStyleNotes(sanitizeDirectorStyleNotesInput(e.target.value))}
                            rows={3}
                            className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded-lg px-3 py-2 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent resize-y"
                            placeholder="e.g. premium skincare brand, warm daylight, soft contrast, modern typography."
                          />
                          <div className="mt-1 text-[10px] text-sf-text-muted">
                            Build/Rebuild Plan combines these notes with the product, brand, model, format, and platform controls above.
                          </div>
                        </div>
                      </>
                    )}

                    {directorSubTab === 'setup' && isYoloMusicMode && (
                      <>
                        {/*
                          Music Video setup — simplified vs Ad. We only need song
                          length, keyframe quality, and a heads-up that the video
                          pass workflow is fixed (LTX 2.3 audio-conditioned).
                        */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-stretch">
                          <div className="h-full p-3 rounded-lg bg-sf-dark-800/45 border border-sf-dark-700">
                            <div className="text-[10px] text-sf-text-muted uppercase tracking-wider">Song Length</div>
                            <p className="mt-1 text-[10px] text-sf-text-muted">
                              Total song duration in seconds. Used to estimate each shot's position
                              in the song when a Lyric moment is declared in the script. Shot count is
                              driven entirely by the director script — one "Shot N:" block = one clip.
                            </p>
                            <div className="mt-2">
                              <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Song Duration (s)</label>
                              <input
                                type="number"
                                min={5}
                                max={600}
                                value={yoloMusicTargetDuration}
                                onChange={e => setYoloMusicTargetDuration(Number(e.target.value) || 30)}
                                className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                              />
                            </div>
                          </div>

                          <div className="h-full p-3 rounded-lg bg-sf-dark-800/45 border border-sf-dark-700">
                            <div className="text-[10px] text-sf-text-muted uppercase tracking-wider">Quality</div>
                            <p className="mt-1 text-[10px] text-sf-text-muted">
                              Picks the keyframe (still) workflow. The video pass is fixed to the
                              LTX 2.3 audio-conditioned workflow because lip-sync grounding only
                              works there.
                            </p>
                            <div className="mt-2 grid grid-cols-3 gap-1">
                              {['draft', 'balanced', 'premium'].map((profileId) => {
                                const isSelected = yoloMusicQualityProfile === profileId
                                return (
                                  <button
                                    key={`mv-quality-${profileId}`}
                                    type="button"
                                    onClick={() => setYoloMusicQualityProfile(profileId)}
                                    className={`rounded px-2 py-1.5 text-[10px] transition-colors capitalize ${
                                      isSelected
                                        ? 'bg-sf-accent text-white'
                                        : 'border border-sf-dark-600 text-sf-text-muted hover:text-sf-text-primary hover:border-sf-dark-500'
                                    }`}
                                  >
                                    {profileId}
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        </div>

                        <div className="p-3 rounded-lg border border-amber-500/25 bg-amber-500/10">
                          <div className="text-[10px] uppercase tracking-[0.14em] text-amber-300 font-semibold">Heads up</div>
                          <div className="mt-1 text-[10px] text-sf-text-secondary leading-relaxed">
                            The Music Video video pass always runs the LTX 2.3 audio-conditioned
                            workflow locally (requires ~24GB VRAM). Cloud upscaling is available
                            after the fact via the Assets panel.
                          </div>
                        </div>
                      </>
                    )}

                    {directorSubTab === 'setup' && !isYoloMusicMode && (
                      <>
                        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3 items-stretch">
                          <div className="h-full p-3 rounded-lg bg-sf-dark-800/45 border border-sf-dark-700">
                            <div className="text-[10px] text-sf-text-muted uppercase tracking-wider">Product / Brand</div>
                            <p className="mt-1 text-[10px] text-sf-text-muted">
                              Product and brand details become global prompt anchors and native end-card defaults.
                            </p>
                            <div className="mt-2 grid grid-cols-1 gap-2">
                              <input
                                type="text"
                                value={yoloAdBrandName}
                                onChange={e => setYoloAdBrandName(e.target.value)}
                                placeholder="Brand name"
                                className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                              />
                              <input
                                type="text"
                                value={yoloAdProductName}
                                onChange={e => setYoloAdProductName(e.target.value)}
                                placeholder="Product name"
                                className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                              />
                              <input
                                type="text"
                                value={yoloAdColorPalette}
                                onChange={e => setYoloAdColorPalette(e.target.value)}
                                placeholder="Color palette (e.g. coral, cream, teal)"
                                className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                              />
                              <textarea
                                value={yoloAdLogoConstraints}
                                onChange={e => setYoloAdLogoConstraints(e.target.value)}
                                rows={2}
                                placeholder="Logo/text constraints, claims, disclaimer rules..."
                                className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent resize-y"
                              />
                            </div>
                          </div>

                          <div className="h-full p-3 rounded-lg bg-sf-dark-800/45 border border-sf-dark-700">
                            <div className="text-[10px] text-sf-text-muted uppercase tracking-wider">Talent / Voice</div>
                            <p className="mt-1 text-[10px] text-sf-text-muted">
                              Spokesperson and testimonial shots can use this voiceover with the audio-conditioned LTX route.
                            </p>
                            <div className="mt-2 grid grid-cols-1 gap-2">
                              <input
                                type="text"
                                value={yoloAdSpokespersonRole}
                                onChange={e => setYoloAdSpokespersonRole(e.target.value)}
                                placeholder="Role (e.g. founder, customer, hand model)"
                                className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                              />
                              <input
                                type="text"
                                value={yoloAdWardrobeNotes}
                                onChange={e => setYoloAdWardrobeNotes(e.target.value)}
                                placeholder="Wardrobe / identity notes"
                                className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                              />
                              <select
                                value={yoloAdVoiceoverAssetId || ''}
                                onChange={e => setYoloAdVoiceoverAssetId(e.target.value || null)}
                                className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                              >
                                <option value="">Voiceover/dialogue audio (none)</option>
                                {assets.filter((asset) => asset?.type === 'audio').map((asset) => (
                                  <option key={`ad-voiceover-${asset.id}`} value={asset.id}>{asset.name}</option>
                                ))}
                              </select>
                              {yoloAdVoiceoverAsset && (
                                <div className="text-[10px] text-emerald-400">
                                  Voiceover selected: {yoloAdVoiceoverAsset.name}
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="h-full p-3 rounded-lg bg-sf-dark-800/45 border border-sf-dark-700">
                            <div className="text-[10px] text-sf-text-muted uppercase tracking-wider">Format / Platform</div>
                            <p className="mt-1 text-[10px] text-sf-text-muted">
                              Choose the commercial pattern and delivery shape before building the script.
                            </p>
                            <div className="mt-2 grid grid-cols-1 gap-2">
                              <select
                                value={yoloAdFormatPreset}
                                onChange={e => handleAdFormatPresetChange(e.target.value)}
                                className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                              >
                                {YOLO_AD_FORMAT_PRESETS.map((preset) => (
                                  <option key={`ad-format-${preset.id}`} value={preset.id}>{preset.label}</option>
                                ))}
                              </select>
                              <div className="text-[10px] text-sf-text-muted">
                                {yoloSelectedAdFormatPreset?.description || ''}
                              </div>
                              <select
                                value={yoloAdPlatformPreset}
                                onChange={e => handleAdPlatformPresetChange(e.target.value)}
                                className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                              >
                                {YOLO_AD_PLATFORM_PRESETS.map((preset) => (
                                  <option key={`ad-platform-${preset.id}`} value={preset.id}>{preset.label}</option>
                                ))}
                              </select>
                              <div className="flex flex-wrap gap-1">
                                {(yoloSelectedAdPlatformPreset?.durationPresets || [6, 15, 30, 60]).map((seconds) => (
                                  <button
                                    key={`ad-duration-preset-${seconds}`}
                                    type="button"
                                    onClick={() => setYoloTargetDuration(seconds)}
                                    className={`rounded px-2 py-1 text-[10px] transition-colors ${
                                      yoloTargetDuration === seconds
                                        ? 'bg-sf-accent text-white'
                                        : 'border border-sf-dark-600 text-sf-text-muted hover:text-sf-text-primary hover:border-sf-dark-500'
                                    }`}
                                  >
                                    {seconds}s
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-stretch">
                          <div className="h-full p-3 rounded-lg bg-sf-dark-800/45 border border-sf-dark-700">
                            <div className="text-[10px] text-sf-text-muted uppercase tracking-wider">Structure</div>
                            <p className="mt-1 text-[10px] text-sf-text-muted">
                              Set ad length and shot density first.
                            </p>
                            <div className="mt-2 grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Target Duration (s)</label>
                                <input
                                  type="number"
                                  min={5}
                                  max={300}
                                  value={yoloTargetDuration}
                                  onChange={e => setYoloTargetDuration(Number(e.target.value) || 5)}
                                  className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                                />
                              </div>
                              <div>
                                <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Shots Per Scene</label>
                                <input
                                  type="number"
                                  min={1}
                                  max={12}
                                  value={yoloShotsPerScene}
                                  onChange={e => setYoloShotsPerScene(Number(e.target.value) || 1)}
                                  className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                                />
                              </div>
                              <div>
                                <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Angles Per Shot</label>
                                <input
                                  type="number"
                                  min={1}
                                  max={8}
                                  value={yoloAnglesPerShot}
                                  onChange={e => setYoloAnglesPerShot(Number(e.target.value) || 1)}
                                  className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                                />
                              </div>
                              <div>
                                <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Takes Per Angle</label>
                                <input
                                  type="number"
                                  min={1}
                                  max={4}
                                  value={yoloTakesPerAngle}
                                  onChange={e => setYoloTakesPerAngle(Number(e.target.value) || 1)}
                                  className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                                />
                              </div>
                            </div>
                          </div>

                          <div className="h-full p-3 rounded-lg bg-sf-dark-800/45 border border-sf-dark-700">
                            <div className="text-[10px] text-sf-text-muted uppercase tracking-wider">Quality</div>
                            <p className="mt-1 text-[10px] text-sf-text-muted">
                              Choose speed versus fidelity.
                            </p>
                            <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
                              <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/35 px-2 py-1.5">
                                <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Keyframes (Images)</div>
                                <div className="mt-1 grid grid-cols-2 gap-1 rounded border border-sf-dark-700 bg-sf-dark-900/40 p-0.5">
                                  {yoloAdRuntimeOptions.map((runtimeOption) => {
                                    const isSelected = yoloStoryboardProfileRuntime === runtimeOption.id
                                    return (
                                      <button
                                        key={`storyboard-${runtimeOption.id}`}
                                        type="button"
                                        onClick={() => setYoloAdStoryboardSource(runtimeOption.id)}
                                        className={`rounded px-2 py-1 text-[10px] transition-colors ${
                                          isSelected
                                            ? 'bg-sf-accent text-white'
                                            : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800'
                                        }`}
                                      >
                                        {runtimeOption.label}
                                      </button>
                                    )
                                  })}
                                </div>
                                {yoloStoryboardUsesCloudTier ? (
                                  <>
                                    <div className="mt-1 text-[10px] text-sf-text-muted uppercase tracking-wider">Cloud Tier</div>
                                    <div className="mt-0.5 grid grid-cols-2 gap-1">
                                      {yoloStoryboardTierOptions.map((tierOption) => {
                                        const isSelectedTier = yoloNormalizedAdStoryboardTier === tierOption.id
                                        return (
                                          <button
                                            key={`storyboard-tier-${tierOption.id}`}
                                            type="button"
                                            onClick={() => setYoloAdStoryboardTier(tierOption.id)}
                                            className={`rounded px-2 py-1 text-[10px] transition-colors ${
                                              isSelectedTier
                                                ? 'bg-sf-accent text-white'
                                                : 'border border-sf-dark-600 text-sf-text-muted hover:text-sf-text-primary hover:border-sf-dark-500'
                                            }`}
                                          >
                                            {tierOption.label}
                                          </button>
                                        )
                                      })}
                                    </div>
                                    <div className="mt-1 text-[10px] text-sf-text-muted">
                                      Workflow: <span className="text-sf-text-secondary">{yoloSelectedAdStageRouting?.imageLabel || getWorkflowDisplayLabel(yoloStoryboardWorkflowId)}</span>
                                    </div>
                                  </>
                                ) : (
                                  <div className="mt-1 text-[10px] text-sf-text-muted">
                                    Local workflow: <span className="text-sf-text-secondary">{yoloSelectedAdStageRouting?.imageLabel || getWorkflowDisplayLabel(yoloStoryboardWorkflowId)}</span>
                                  </div>
                                )}
                              </div>

                              <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/35 px-2 py-1.5">
                                <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Video</div>
                                <div className="mt-1 grid grid-cols-2 gap-1 rounded border border-sf-dark-700 bg-sf-dark-900/40 p-0.5">
                                  {yoloAdRuntimeOptions.map((runtimeOption) => {
                                    const isSelected = yoloVideoProfileRuntime === runtimeOption.id
                                    return (
                                      <button
                                        key={`video-${runtimeOption.id}`}
                                        type="button"
                                        onClick={() => setYoloAdVideoSource(runtimeOption.id)}
                                        className={`rounded px-2 py-1 text-[10px] transition-colors ${
                                          isSelected
                                            ? 'bg-sf-accent text-white'
                                            : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800'
                                        }`}
                                      >
                                        {runtimeOption.label}
                                      </button>
                                    )
                                  })}
                                </div>
                                {yoloVideoUsesCloudTier ? (
                                  <>
                                    <div className="mt-1 text-[10px] text-sf-text-muted uppercase tracking-wider">Cloud Tier</div>
                                    <div className="mt-0.5 grid grid-cols-2 gap-1">
                                      {yoloVideoTierOptions.map((tierOption) => {
                                        const isSelectedTier = yoloNormalizedAdVideoTier === tierOption.id
                                        return (
                                          <button
                                            key={`video-tier-${tierOption.id}`}
                                            type="button"
                                            onClick={() => setYoloAdVideoTier(tierOption.id)}
                                            className={`rounded px-2 py-1 text-[10px] transition-colors ${
                                              isSelectedTier
                                                ? 'bg-sf-accent text-white'
                                                : 'border border-sf-dark-600 text-sf-text-muted hover:text-sf-text-primary hover:border-sf-dark-500'
                                            }`}
                                          >
                                            {tierOption.label}
                                          </button>
                                        )
                                      })}
                                    </div>
                                    <div className="mt-1 text-[10px] text-sf-text-muted">
                                      Workflow: <span className="text-sf-text-secondary">{yoloSelectedAdStageRouting?.videoLabel || getWorkflowDisplayLabel(yoloDefaultVideoWorkflowId)}</span>
                                    </div>
                                  </>
                                ) : (
                                  <div className="mt-2 rounded-lg border border-sf-dark-700 bg-sf-dark-900/40 p-2">
                                    <div className="text-[10px] text-sf-text-muted uppercase tracking-wider">Local Video Model</div>
                                    <div className="mt-1 grid grid-cols-2 gap-1">
                                      {YOLO_AD_LOCAL_VIDEO_WORKFLOW_OPTIONS.map((option) => {
                                        const isSelected = yoloAdLocalVideoWorkflowId === option.id
                                        return (
                                          <button
                                            key={`ad-local-video-${option.id}`}
                                            type="button"
                                            onClick={() => setYoloAdLocalVideoWorkflowId(option.id)}
                                            title={option.description}
                                            className={`rounded px-2 py-1 text-[10px] transition-colors ${
                                              isSelected
                                                ? 'bg-sf-accent text-white'
                                                : 'border border-sf-dark-600 text-sf-text-muted hover:text-sf-text-primary hover:border-sf-dark-500'
                                            }`}
                                          >
                                            {option.label}
                                          </button>
                                        )
                                      })}
                                    </div>
                                    <div className="mt-1 text-[10px] text-sf-text-muted">
                                      {yoloAdSelectedLocalVideoWorkflow?.description || ''}
                                    </div>
                                    <div className="mt-1 text-[10px] text-sf-text-muted">
                                      Current: <span className="text-sf-text-secondary">{yoloSelectedAdStageRouting?.videoLabel || getWorkflowDisplayLabel(yoloDefaultVideoWorkflowId)}</span>
                                    </div>
                                  </div>
                                )}
                                <div className="mt-2">
                                  <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">FPS</label>
                                  <select
                                    value={yoloVideoFps}
                                    onChange={e => setYoloVideoFps(Number(e.target.value) || 24)}
                                    className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                                  >
                                    {DIRECTOR_VIDEO_FPS_OPTIONS.map((fpsOption) => (
                                      <option key={`director-video-fps-${fpsOption}`} value={fpsOption}>
                                        {fpsOption} fps
                                      </option>
                                    ))}
                                  </select>
                                  <div className="mt-1 text-[10px] text-sf-text-muted">
                                    {yoloSelectedVideoWorkflowSupportsCustomFps
                                      ? 'Applied to local renders (LTX 2.3 / WAN 2.2) in Director Mode.'
                                      : 'Cloud video providers may use their own output FPS and ignore this setting.'}
                                  </div>
                                </div>
                              </div>
                            </div>

                          </div>
                        </div>

                        <div className="p-3 rounded-lg bg-sf-dark-800/70 border border-sf-dark-700">
                          <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Set References (optional)</label>
                          <p className="mt-1 text-[10px] text-sf-text-muted">
                            Add a product image and/or model image to keep ad identity consistent across keyframe shots.
                          </p>
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <select
                              value={yoloAdProductAssetId || ''}
                              onChange={e => setYoloAdProductAssetId(e.target.value || null)}
                              className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                            >
                              <option value="">Product image (none)</option>
                              {assets.filter((asset) => asset.type === 'image').map((asset) => (
                                <option key={asset.id} value={asset.id}>{asset.name}</option>
                              ))}
                            </select>
                            <select
                              value={yoloAdModelAssetId || ''}
                              onChange={e => setYoloAdModelAssetId(e.target.value || null)}
                              className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                            >
                              <option value="">Model image (none)</option>
                              {assets.filter((asset) => asset.type === 'image').map((asset) => (
                                <option key={asset.id} value={asset.id}>{asset.name}</option>
                              ))}
                            </select>
                          </div>
                          <div className="mt-2">
                            <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Consistency Strength</label>
                            <select
                              value={yoloAdConsistency}
                              onChange={e => setYoloAdConsistency(e.target.value)}
                              className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                            >
                              {Object.entries(YOLO_AD_REFERENCE_CONSISTENCY_OPTIONS).map(([value, label]) => (
                                <option key={value} value={value}>{label}</option>
                              ))}
                            </select>
                            {yoloAdHasReferenceAnchors && !yoloStoryboardSupportsReferenceAnchors && (
                              <div className="mt-1 text-[10px] text-yellow-400">
                                The selected keyframe workflow does not support product/model anchors.
                              </div>
                            )}
                          </div>
                        </div>
                      </>
                    )}

                    {directorSubTab === 'setup' && (
                  <>
                    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/50 p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">{DIRECTOR_MODE_BETA_LABEL} dependencies</div>
                        <button
                          type="button"
                          onClick={() => {
                            void runYoloDependencySnapshotCheck()
                          }}
                          disabled={!isConnected || yoloDependencyPanel.status === 'checking' || yoloDependencyCheckInProgress}
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] border transition-colors ${
                            !isConnected || yoloDependencyPanel.status === 'checking' || yoloDependencyCheckInProgress
                              ? 'border-sf-dark-600 text-sf-text-muted cursor-not-allowed'
                              : 'border-sf-dark-500 text-sf-text-secondary hover:text-sf-text-primary hover:border-sf-dark-400'
                          }`}
                        >
                          <RefreshCw className={`w-3 h-3 ${
                            yoloDependencyPanel.status === 'checking' || yoloDependencyCheckInProgress ? 'animate-spin' : ''
                          }`} />
                          Re-check
                        </button>
                      </div>

                      {yoloDependencyPanel.status === 'offline' && (
                        <div className="mt-2 text-[10px] text-yellow-400">ComfyUI is offline. Start ComfyUI to verify dependencies.</div>
                      )}
                      {yoloDependencyPanel.status === 'checking' && (
                        <div className="mt-2 text-[10px] text-yellow-400">Checking storyboard/video workflow dependencies...</div>
                      )}
                      {yoloDependencyPanel.status === 'error' && (
                        <div className="mt-2 text-[10px] text-sf-error">
                          Dependency check failed{yoloDependencyPanel.error ? ` (${yoloDependencyPanel.error})` : ''}.
                        </div>
                      )}

                      <div className="mt-2 space-y-1.5">
                        {yoloDependencyWorkflowIds.map((workflow) => {
                          const result = yoloDependencyPanel.byWorkflow?.[workflow]
                          const isMissing = Boolean(result?.hasPack && result?.hasBlockingIssues)
                          const rowStatus = !result
                            ? (yoloDependencyPanel.status === 'checking' ? 'Checking...' : 'Not checked')
                            : result.status === 'error'
                              ? 'Check failed'
                              : result.status === 'no-pack' || !result.hasPack
                                ? 'No manifest'
                                : isMissing
                                  ? 'Missing required'
                                  : result.status === 'partial'
                                    ? 'Partially verified'
                                    : 'Ready'
                          const rowToneClass = isMissing
                            ? 'text-sf-error'
                            : result?.status === 'partial'
                              ? 'text-yellow-400'
                              : result?.status === 'ready'
                                ? 'text-green-400'
                                : 'text-sf-text-muted'

                          return (
                            <details key={workflow} open={isMissing} className="rounded border border-sf-dark-700 bg-sf-dark-900/50 px-2 py-1">
                              <summary className="cursor-pointer list-none flex items-center justify-between gap-2 text-[10px]">
                                <span className="text-sf-text-secondary truncate">{getWorkflowDisplayLabel(workflow)}</span>
                                <span className={rowToneClass}>{rowStatus}</span>
                              </summary>

                              {result && (
                                <div className="mt-1.5 space-y-1 text-[10px]">
                                  {result.missingNodes?.length > 0 && (
                                    <div>
                                      <div className="text-sf-text-muted mb-0.5">Missing nodes</div>
                                      <div className="space-y-0.5">
                                        {result.missingNodes.map((node) => (
                                          <div key={node.classType} className="text-sf-error break-all">{node.classType}</div>
                                        ))}
                                      </div>
                                    </div>
                                  )}

                                  {result.missingModels?.length > 0 && (
                                    <div>
                                      <div className="text-sf-text-muted mb-0.5">Missing models</div>
                                      <div className="space-y-0.5">
                                        {result.missingModels.map((model) => (
                                          <div key={`${model.classType}:${model.inputKey}:${model.filename}`} className="text-sf-error break-all">
                                            {model.filename}
                                            {model.targetSubdir ? (
                                              <span className="text-sf-text-muted">{` -> ComfyUI/models/${model.targetSubdir}`}</span>
                                            ) : null}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}

                                  {result.missingAuth && (
                                    <div className="flex items-center justify-between gap-2 rounded border border-yellow-400/30 bg-yellow-400/5 px-2 py-1.5">
                                      <div className="flex items-center gap-1.5 text-yellow-300">
                                        <KeyRound className="h-3 w-3" />
                                        <span>Cloud API key needed</span>
                                      </div>
                                      <button
                                        type="button"
                                        onClick={(event) => { event.stopPropagation(); setApiKeyDialogOpen(true) }}
                                        className="rounded bg-sf-accent px-2 py-0.5 text-[10px] font-medium text-white transition-colors hover:bg-sf-accent/90"
                                      >
                                        Set up key
                                      </button>
                                    </div>
                                  )}

                                  {result.hasPriceMetadata && (
                                    <div>
                                      <div className="text-sf-text-muted mb-0.5">Price metadata</div>
                                      {result.estimatedCredits ? (
                                        <div className="text-amber-300">
                                          Estimated per run: {formatCreditsRange(result.estimatedCredits, 1)}
                                        </div>
                                      ) : (
                                        <div className="text-yellow-400">
                                          Price badge found, but numeric credits could not be parsed.
                                        </div>
                                      )}
                                      {result.badgeSummaries?.slice(0, 2).map((entry, idx) => (
                                        <div key={`${entry.classType}:${idx}`} className="text-sf-text-muted break-all">
                                          {entry.classType}: {entry.text}
                                        </div>
                                      ))}
                                    </div>
                                  )}

                                  {result.unresolvedModels?.length > 0 && result.status !== 'missing' && (
                                    <div className="text-yellow-400">
                                      {result.unresolvedModels.length} model check(s) could not be auto-verified.
                                    </div>
                                  )}
                                </div>
                              )}
                            </details>
                          )
                        })}
                      </div>
                    </div>

                    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/50 p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Cloud credits (estimate)</div>
                      </div>

                      <div className="mt-2 text-[10px] text-sf-text-secondary space-y-1.5">
                        {yoloCloudCreditRows.map((row) => {
                          const runCountLabel = `${Math.max(0, Number(row.runCount) || 0)} run${Math.max(0, Number(row.runCount) || 0) === 1 ? '' : 's'}`
                          const lineLabel = `${row.stageLabel} (${row.workflowLabel})`
                          if (!row.isCloud) {
                            return (
                              <div key={row.id} className="flex items-center justify-between gap-2">
                                <span className="truncate">{lineLabel}</span>
                                <span className="text-sf-text-muted">Local (no credits)</span>
                              </div>
                            )
                          }
                          if (row.estimatedCredits) {
                            return (
                              <div key={row.id} className="space-y-0.5">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="truncate">{lineLabel}</span>
                                  <span className="flex items-center gap-1 text-amber-300 whitespace-nowrap">
                                    <span>
                                      {formatCreditsRange(row.estimatedCredits, 1)} / run
                                      <span className="text-sf-text-muted"> ({formatUsdRangeFromCredits(row.estimatedCredits, 1)} / run)</span>
                                    </span>
                                    {row.hasPriceMetadata && (
                                      <span className="text-yellow-400">(dynamic pricing)</span>
                                    )}
                                  </span>
                                </div>
                                <div className="text-sf-text-muted">
                                  Plan ({runCountLabel}): {formatCreditsRange(row.estimatedCredits, row.runCount)} ({formatUsdRangeFromCredits(row.estimatedCredits, row.runCount)})
                                </div>
                              </div>
                            )
                          }
                          return (
                            <div key={row.id} className="flex items-center justify-between gap-2">
                              <span className="truncate">{lineLabel}</span>
                              <span className="text-yellow-400">
                                {row.hasPriceMetadata ? 'Dynamic pricing (estimate unavailable)' : 'No credit metadata'}
                              </span>
                            </div>
                          )
                        })}

                        {yoloCloudCreditProjection.hasAnyCloudRows ? (
                          <div className="pt-1.5 border-t border-sf-dark-700">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sf-text-muted">Projected cloud total (current plan)</span>
                              <span className="text-amber-300">
                                {yoloCloudCreditProjection.hasKnownCloudEstimates
                                  ? (
                                    yoloCloudCreditProjection.hasUnknownCloudEstimates
                                      ? `${formatCreditsRange({ min: yoloCloudCreditProjection.minTotal, max: yoloCloudCreditProjection.maxTotal }, 1)} (${formatUsdRangeFromCredits({ min: yoloCloudCreditProjection.minTotal, max: yoloCloudCreditProjection.maxTotal }, 1)}) + unknown`
                                      : `${formatCreditsRange({ min: yoloCloudCreditProjection.minTotal, max: yoloCloudCreditProjection.maxTotal }, 1)} (${formatUsdRangeFromCredits({ min: yoloCloudCreditProjection.minTotal, max: yoloCloudCreditProjection.maxTotal }, 1)})`
                                  )
                                  : 'Unknown'}
                              </span>
                            </div>
                            {yoloCloudCreditProjection.hasUnknownCloudEstimates && (
                              <div className="mt-0.5 text-yellow-400">
                                Some selected cloud workflows have unknown credit estimates.
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="pt-1.5 border-t border-sf-dark-700 text-sf-text-muted">
                            No cloud workflows selected.
                          </div>
                        )}
                      </div>

                      <div className="mt-2 text-[9px] text-sf-text-muted">
                        Estimates are derived from workflow node price metadata when available. USD values use 211 credits = $1. Final billing can vary by runtime provider settings.
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setDirectorSubTab('plan-script')}
                      className="w-full px-3 py-2 rounded-lg bg-sf-accent hover:bg-sf-accent-hover text-white text-xs"
                    >
                      Next: Script
                    </button>
                  </>
                )}

                    {directorSubTab === 'plan-script' && (
                  <>
                    <div className="grid grid-cols-1 gap-2">
                      <button
                        type="button"
                        onClick={handleBuildActiveYoloPlan}
                        className="px-3 py-2 rounded-lg bg-sf-accent hover:bg-sf-accent-hover text-white text-xs"
                      >
                        {(() => {
                          const isAltActive = isYoloMusicMode && !yoloMusicIsMasterActive
                          const verb = yoloActivePlanIsStale ? 'Rebuild' : 'Build'
                          if (isAltActive) {
                            const passName = getMusicVideoPassDisplayName(yoloMusicActiveAltScript.passType)
                            return `${verb} Plan — ${passName}${yoloMusicActiveAltScript.label ? `: ${yoloMusicActiveAltScript.label}` : ''}`
                          }
                          return `${verb} Plan`
                        })()}
                      </button>
                      <div className="text-[10px] text-sf-text-muted">
                        {(() => {
                          const isAltActive = isYoloMusicMode && !yoloMusicIsMasterActive
                          if (yoloActivePlanIsStale) {
                            return isAltActive
                              ? 'This alt pass\u2019s script or the shared settings changed since the last build. Rebuild to refresh its shots.'
                              : 'Your script or reference settings changed since the last build. Rebuild the plan to refresh all keyframe and video prompts.'
                          }
                          return isAltActive
                            ? 'Each alt pass keeps its own plan. Build it, then continue into Storyboard / Keyframes / Videos to generate just this pass.'
                            : 'Build plan, then continue through Keyframes and Videos for batch generation.'
                        })()}
                      </div>
                    </div>

                  </>
                )}

                    {(isYoloStillsStep || isYoloVideoStep) && (
                  yoloCanEditScenes ? (
                  <div className="space-y-3">
                    {yoloDependencyCheckInProgress && (
                      <div className="text-[10px] text-yellow-400">Checking {DIRECTOR_MODE_BETA_LABEL} workflow dependencies...</div>
                    )}

                    {isYoloMusicMode && (() => {
                      // Active-pass banner — always visible on the Keyframes/Videos
                      // steps so the user never has to guess which pass they're
                      // editing. Renders the full pass switcher (Master + every
                      // alt) so the user can pivot between any pass without
                      // bouncing back to the Script step first.
                      //
                      // The banner also flips border/tone between neutral
                      // (master) and accent (alt) so a quick glance confirms
                      // whether the current view is the backbone performance or
                      // an editorial alt pass.
                      const isAltActive = !yoloMusicIsMasterActive
                      const tone = isAltActive
                        ? 'border-sf-accent/60 bg-sf-accent/10'
                        : 'border-sf-dark-700 bg-sf-dark-800/60'
                      return (
                        <div className={`rounded-lg border ${tone} px-3 py-2`}>
                          <div className="flex items-center justify-between gap-3 flex-wrap">
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <span className="text-[10px] uppercase tracking-wider text-sf-text-muted whitespace-nowrap">
                                Editing pass:
                              </span>
                              {renderPassTabStrip('compact')}
                            </div>
                            <button
                              type="button"
                              onClick={() => setDirectorSubTab('plan-script')}
                              className="text-[10px] px-2 py-1 rounded bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-secondary hover:text-sf-text-primary flex-shrink-0"
                              title="Jump to the Script step for the active pass"
                            >
                              Edit script
                            </button>
                          </div>
                        </div>
                      )
                    })()}

                    <div className="p-3 rounded-lg bg-sf-dark-800/70 border border-sf-dark-700 text-xs text-sf-text-secondary">
                      <div className="font-medium text-sf-text-primary mb-1">{yoloModeLabel} Plan Status</div>
                      <div>Scenes: {yoloSceneCount}</div>
                      <div>Planned variants: {yoloVariants.length}</div>
                      <div>Queue variants: {yoloQueueVariants.length}</div>
                      <div>Keyframes ready: {yoloStoryboardReadyCount} / {yoloQueueVariants.length}</div>
                      {yoloActivePlanIsStale && (
                        <div className="mt-1 text-yellow-300">Plan is stale. Rebuild before creating keyframes or videos.</div>
                      )}
                    </div>
                    <div className="text-[10px] text-yellow-300/90 leading-relaxed">
                      Tip: Scene text is reference-only. Refine the keyframe prompt, motion prompt, camera direction, camera preset, duration, and takes before creating keyframes or videos.
                    </div>

                  <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4">
                    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/40 p-3 h-fit sticky top-2">
                      <div className="text-[10px] text-sf-text-muted uppercase tracking-wider">Scene Navigator</div>
                      <div className="mt-2 space-y-1 max-h-[70vh] overflow-y-auto pr-1">
                        {yoloActivePlan.map((scene) => {
                          const stats = yoloSceneStats.get(scene.id) || { shotCount: 0, variantCount: 0, readyCount: 0 }
                          const isSelected = scene.id === selectedYoloSceneId
                          return (
                            <button
                              key={scene.id}
                              type="button"
                              onClick={() => setSelectedYoloSceneId(scene.id)}
                              className={`w-full text-left rounded border px-2 py-1.5 transition-colors ${
                                isSelected
                                  ? 'border-sf-accent bg-sf-accent/15 text-sf-accent'
                                  : 'border-sf-dark-700 bg-sf-dark-900/70 text-sf-text-secondary hover:border-sf-dark-500'
                              }`}
                            >
                              <div className="text-[11px] font-medium">{scene.id}</div>
                              <div className="mt-0.5 text-[9px] opacity-80">
                                Shots: {stats.shotCount}
                              </div>
                              <div className="text-[9px] opacity-80">
                                Keyframes: {stats.readyCount}/{stats.variantCount}
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    <div className="space-y-3">
                      {selectedYoloScene && (
                        <div key={selectedYoloScene.id} className="p-3 rounded-lg border border-sf-dark-700 bg-sf-dark-800/40 space-y-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="text-xs font-semibold text-sf-text-primary">
                              {selectedYoloScene.id}
                              {selectedYoloSceneIndex >= 0 ? ` (${selectedYoloSceneIndex + 1}/${yoloActivePlan.length})` : ''}
                            </div>
                          </div>

                          <div>
                            <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Scene</label>
                            <div className="mt-1 w-full bg-sf-dark-900 border border-sf-dark-700 rounded px-2 py-1 text-xs text-sf-text-secondary">
                              {selectedYoloScene.contextText || selectedYoloScene.summary || selectedYoloScene.rawText || 'Scene details'}
                            </div>
                          </div>

                          <div className="space-y-2">
                            {(selectedYoloScene.shots || []).map((shot) => {
                              const hasShotStoryboardFrame = yoloQueueVariants.some((variant) => (
                                variant.sceneId === selectedYoloScene.id
                                && variant.shotId === shot.id
                                && yoloStoryboardAssetMap.has(variant.key)
                              ))
                              return (
                              <div key={shot.id} className="rounded border border-sf-dark-700 bg-sf-dark-900/70 p-2 space-y-2">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <div className="text-[11px] text-sf-text-primary">{shot.id}</div>
                                  </div>
                                  <div className="flex flex-wrap items-center justify-end gap-2">
                                    {isYoloStillsStep && (
                                      <button
                                        type="button"
                                        onClick={() => { void handleQueueYoloShotStoryboard(selectedYoloScene.id, shot.id) }}
                                        disabled={yoloDependencyCheckInProgress}
                                        className={`px-2 py-1 rounded text-[10px] whitespace-nowrap ${
                                          yoloDependencyCheckInProgress
                                            ? 'bg-sf-dark-700 text-sf-text-muted cursor-not-allowed'
                                            : 'bg-sf-accent hover:bg-sf-accent-hover text-white'
                                        }`}
                                      >
                                        Create Keyframe
                                      </button>
                                    )}
                                    {isYoloVideoStep && (
                                      <button
                                        type="button"
                                        onClick={() => { void handleQueueYoloShotVideo(selectedYoloScene.id, shot.id) }}
                                        disabled={yoloDependencyCheckInProgress || !hasShotStoryboardFrame}
                                        title={!hasShotStoryboardFrame ? 'Create this shot keyframe first' : ''}
                                        className={`px-2 py-1 rounded text-[10px] whitespace-nowrap ${
                                          yoloDependencyCheckInProgress || !hasShotStoryboardFrame
                                            ? 'bg-sf-dark-700 text-sf-text-muted cursor-not-allowed'
                                            : 'bg-sf-accent hover:bg-sf-accent-hover text-white'
                                        }`}
                                      >
                                        {yoloSelectedVideoWorkflowIds.length > 1 ? 'Create Shot Video (A/B)' : 'Create Shot Video'}
                                      </button>
                                    )}
                                  </div>
                                </div>

                                <div className="space-y-2">
                                  <div>
                                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Keyframe Prompt</label>
                                    <input
                                      type="text"
                                      value={shot.imageBeat || shot.beat || ''}
                                      onChange={e => handleYoloShotImageBeatChange(selectedYoloScene.id, shot.id, e.target.value)}
                                      className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                                    />
                                  </div>
                                  <div>
                                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Motion Prompt</label>
                                    <input
                                      type="text"
                                      value={shot.videoBeat || shot.beat || ''}
                                      onChange={e => handleYoloShotVideoBeatChange(selectedYoloScene.id, shot.id, e.target.value)}
                                      className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                                    />
                                  </div>
                                  <div>
                                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Camera Direction</label>
                                    <input
                                      type="text"
                                      value={shot.cameraDirection || ''}
                                      onChange={e => handleYoloShotCameraDirectionChange(selectedYoloScene.id, shot.id, e.target.value)}
                                      className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                                      placeholder="e.g. subtle push-in, locked close-up, gentle backward tracking"
                                    />
                                  </div>
                                </div>

                                <div>
                                  <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Camera Setup Preset</label>
                                  <select
                                    value={shot.cameraPresetId || 'auto'}
                                    onChange={e => handleYoloShotCameraPresetChange(selectedYoloScene.id, shot.id, e.target.value)}
                                    className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                                  >
                                    {YOLO_CAMERA_PRESET_OPTIONS.map((preset) => (
                                      <option key={preset.id} value={preset.id}>{preset.label}</option>
                                    ))}
                                  </select>
                                  <div className="mt-1 text-[10px] text-sf-text-muted">
                                    Active angles: {(shot.angles || []).join(', ')}
                                  </div>
                                </div>

                                <div className="grid grid-cols-2 gap-2">
                                  <div>
                                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Duration (s)</label>
                                    <input
                                      type="number"
                                      min={2}
                                      max={5}
                                      step={0.5}
                                      value={shot.durationSeconds}
                                      onChange={e => handleYoloShotDurationChange(selectedYoloScene.id, shot.id, e.target.value)}
                                      className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                                    />
                                  </div>
                                  <div>
                                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Takes</label>
                                    <input
                                      type="number"
                                      min={1}
                                      max={4}
                                      value={shot.takesPerAngle}
                                      onChange={e => handleYoloShotTakesChange(selectedYoloScene.id, shot.id, e.target.value)}
                                      className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary"
                                    />
                                  </div>
                                </div>
                              </div>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/50 p-3">
                      <div className="text-[10px] uppercase tracking-wider text-sf-text-muted flex items-center gap-2">
                        <span>
                          {isYoloStillsStep ? 'Batch Create Keyframes (All Scenes & Shots)' : 'Batch Create Videos (All Scenes & Shots)'}
                        </span>
                        {isYoloMusicMode && yoloMusicActiveAltScript && (
                          <span
                            className="px-1.5 py-0.5 rounded bg-sf-dark-900 border border-sf-dark-600 text-[9px] tracking-wider text-sf-text-secondary normal-case"
                            title={`Generating for alt pass: ${yoloMusicActiveAltScript.label}`}
                          >
                            For: {getMusicVideoPassBadge(yoloMusicActiveAltScript.passType)} · {yoloMusicActiveAltScript.label}
                          </span>
                        )}
                        {isYoloMusicMode && !yoloMusicActiveAltScript && (
                          <span className="px-1.5 py-0.5 rounded bg-sf-dark-900 border border-sf-dark-600 text-[9px] tracking-wider text-sf-text-secondary normal-case">
                            For: Master Performance
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-[10px] text-sf-text-muted">
                        {isYoloStillsStep
                          ? (
                            isYoloMusicMode
                              ? `These actions run across the full plan of the ${yoloMusicActiveAltScript ? `"${yoloMusicActiveAltScript.label}" alt` : 'Master'} pass. Generated assets will be tagged with this pass.`
                              : 'These actions run across the full plan, not just the selected shot.'
                          )
                          : `Keyframes ready: ${yoloStoryboardReadyCount}/${yoloQueueVariants.length}. Videos use keyframe images.`}
                      </div>
                      <div className={`mt-2 grid grid-cols-1 gap-2 ${isYoloStillsStep ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
                        {isYoloStillsStep ? (
                          <>
                            <button
                              type="button"
                              onClick={() => { void handleQueueYoloStoryboards() }}
                              disabled={yoloDependencyCheckInProgress}
                              title={yoloDependencyCheckInProgress
                                ? 'Wait for dependency check to finish'
                                : (isYoloMusicMode && yoloMusicActiveAltScript
                                  ? `Generate keyframes for the "${yoloMusicActiveAltScript.label}" alt pass. Assets will be tagged with this pass.`
                                  : (isYoloMusicMode
                                    ? 'Generate keyframes for the Master Performance pass.'
                                    : 'Queues still-image jobs for all shots in this plan'))}
                              className={`px-3 py-2 rounded-lg text-xs ${
                                yoloDependencyCheckInProgress
                                  ? 'bg-sf-dark-700 text-sf-text-muted cursor-not-allowed'
                                  : 'bg-sf-accent hover:bg-sf-accent-hover text-white'
                              }`}
                            >
                              {isYoloMusicMode && yoloMusicActiveAltScript
                                ? `Create Keyframes [${getMusicVideoPassBadge(yoloMusicActiveAltScript.passType)}]`
                                : 'Create Keyframes'}
                            </button>
                            <button
                              type="button"
                              onClick={() => { void handleCreateStoryboardPdf() }}
                              disabled={creatingStoryboardPdf || yoloStoryboardAssetMap.size === 0}
                              className={`px-3 py-2 rounded-lg text-xs inline-flex items-center justify-center gap-1 ${
                                creatingStoryboardPdf || yoloStoryboardAssetMap.size === 0
                                  ? 'bg-sf-dark-700 text-sf-text-muted cursor-not-allowed'
                                  : 'bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-secondary'
                              }`}
                              title={yoloStoryboardAssetMap.size === 0 ? 'Generate keyframe images first' : 'Create a PDF from the latest keyframe images'}
                            >
                              {creatingStoryboardPdf && <Loader2 className="w-3 h-3 animate-spin" />}
                              {creatingStoryboardPdf ? 'Creating PDF...' : 'Create Storyboard PDF'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setDirectorSubTab('video-pass')}
                              disabled={yoloStoryboardReadyCount === 0}
                              title={yoloStoryboardReadyCount === 0 ? 'Create at least one keyframe first' : 'Continue to Videos step'}
                              className={`px-3 py-2 rounded-lg text-xs ${
                                yoloStoryboardReadyCount === 0
                                  ? 'bg-sf-dark-700 text-sf-text-muted cursor-not-allowed'
                                  : 'bg-sf-accent hover:bg-sf-accent-hover text-white'
                              }`}
                            >
                              Next: Videos
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => setDirectorSubTab('scene-shot')}
                              className="px-3 py-2 rounded-lg text-xs bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-secondary"
                            >
                              Back: Keyframes
                            </button>
                            <button
                              type="button"
                              onClick={() => { void handleQueueYoloVideos() }}
                              disabled={yoloDependencyCheckInProgress || yoloStoryboardReadyCount === 0}
                              title={yoloDependencyCheckInProgress
                                ? 'Wait for dependency check to finish'
                                : yoloStoryboardReadyCount === 0
                                  ? 'Create keyframes first'
                                  : (isYoloMusicMode && yoloMusicActiveAltScript
                                    ? `Generate videos for the "${yoloMusicActiveAltScript.label}" alt pass. Assets will be tagged with this pass.`
                                    : (isYoloMusicMode
                                      ? 'Generate videos for the Master Performance pass.'
                                      : 'Queues video generation jobs for all shots in this plan'))}
                              className={`px-3 py-2 rounded-lg text-xs ${
                                yoloDependencyCheckInProgress || yoloStoryboardReadyCount === 0
                                  ? 'bg-sf-dark-700 text-sf-text-muted cursor-not-allowed'
                                  : 'bg-sf-accent hover:bg-sf-accent-hover text-white'
                              }`}
                            >
                              {isYoloMusicMode && yoloMusicActiveAltScript
                                ? `Create Videos [${getMusicVideoPassBadge(yoloMusicActiveAltScript.passType)}]`
                                : 'Create Videos'}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  ) : (
                    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/40 p-3 text-xs text-sf-text-secondary space-y-2">
                      <div className="font-medium text-sf-text-primary">Build a plan to unlock Keyframes and Videos</div>
                      <div>Go to Step 2 (Script), click Build Plan, then continue into Steps 3 and 4.</div>
                      <button
                        type="button"
                        onClick={() => setDirectorSubTab('plan-script')}
                        className="px-3 py-1.5 rounded bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-secondary text-[11px]"
                      >
                        Go to Script
                      </button>
                    </div>
                  )
                    )}
                  </>
                )}
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right: Progress + Generate (collapsible) */}
        <div className={`${rightSidebarCollapsed ? 'w-12' : 'w-80'} flex-shrink-0 min-h-0 border-l border-sf-dark-700 bg-sf-dark-900 flex flex-col overflow-hidden transition-all duration-200`}>
          {rightSidebarCollapsed ? (
            <button
              type="button"
              onClick={() => setRightSidebarCollapsed(false)}
              className="flex flex-col items-center justify-center py-4 px-2 text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800 transition-colors"
              title="Expand queue panel"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          ) : (
          <>
          <div className="flex-shrink-0 flex items-center justify-between gap-2 p-2 border-b border-sf-dark-700">
            <span className="text-[10px] text-sf-text-muted uppercase tracking-wider truncate">Queue</span>
            <button
              type="button"
              onClick={() => setRightSidebarCollapsed(true)}
              className="p-1 rounded text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-700 transition-colors flex-shrink-0"
              title="Collapse panel"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
          <div className="flex-shrink-0 p-4 border-b border-sf-dark-700">
            <button
              onClick={handleGenerate}
              disabled={isGenerateDisabled}
              className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
                isGenerateDisabled ? 'bg-sf-dark-700 text-sf-text-muted cursor-not-allowed'
                : 'bg-sf-accent hover:bg-sf-accent-hover text-white'
              }`}
            >
              <Sparkles className="w-4 h-4" />
              {generationMode === 'yolo'
                ? `Queue ${yoloModeLabel} Keyframes`
                : `Queue ${selectedWorkflowManifest?.outputType === 'audio' || category === 'audio' ? 'Audio' : selectedWorkflowManifest?.outputType === 'image' || category === 'image' ? 'Image' : 'Video'}`}
            </button>
            <div className="mt-2 flex gap-2">
              {generationQueue.some(j => j.status === 'paused') && (
                <button
                  type="button"
                  onClick={handleResumeQueue}
                  className="flex-1 px-4 py-2 rounded-lg text-xs font-medium transition-colors bg-sf-accent hover:bg-sf-accent-hover text-white"
                >
                  Resume Queue
                </button>
              )}
              <button
                type="button"
                onClick={handleClearGenerationQueue}
                disabled={!hasJobs}
                className={`flex-1 px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
                  hasJobs
                    ? 'bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-secondary'
                    : 'bg-sf-dark-800 text-sf-text-muted cursor-not-allowed'
                }`}
              >
                Clear Queue
              </button>
            </div>

            {generationMode === 'single' && (
              <div className="mt-3 rounded-lg border border-sf-dark-600 bg-sf-dark-800/60 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Workflow Dependencies</div>
                  <button
                    type="button"
                    onClick={() => { void runWorkflowDependencyCheck() }}
                    disabled={!isConnected || dependencyCheckInProgress}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] border transition-colors ${
                      !isConnected || dependencyCheckInProgress
                        ? 'border-sf-dark-600 text-sf-text-muted cursor-not-allowed'
                        : 'border-sf-dark-500 text-sf-text-secondary hover:text-sf-text-primary hover:border-sf-dark-400'
                    }`}
                    title="Re-check required nodes/models"
                  >
                    <RefreshCw className={`w-3 h-3 ${dependencyCheckInProgress ? 'animate-spin' : ''}`} />
                    Re-check
                  </button>
                </div>

                <div className="mt-1 text-[10px] text-sf-text-muted">{currentWorkflow?.label || workflowId}</div>

                {dependencyCheck.status === 'offline' && (
                  <div className="mt-2 text-[10px] text-yellow-400">ComfyUI is offline. Start ComfyUI to run dependency checks.</div>
                )}

                {dependencyCheck.status === 'checking' && (
                  <div className="mt-2 text-[10px] text-yellow-400">Checking installed nodes and models...</div>
                )}

                {dependencyCheck.status === 'error' && (
                  <div className="mt-2 text-[10px] text-sf-error">
                    Could not validate dependencies ({dependencyCheck.error || 'unknown error'}).
                  </div>
                )}

                {dependencyCheck.status === 'no-pack' && (
                  <div className="mt-2 text-[10px] text-sf-text-muted">
                    No dependency manifest yet for this workflow. Queueing remains enabled.
                  </div>
                )}

                {dependencyCheck.status === 'ready' && (
                  <div className="mt-2 text-[10px] text-green-400">Ready. Required dependencies were detected.</div>
                )}

                {dependencyCheck.status === 'partial' && (
                  <div className="mt-2 text-[10px] text-yellow-400">
                    Partially verified. Some model lists were not exposed by ComfyUI, so manual verification may be needed.
                  </div>
                )}

                {dependencyCheck.status === 'missing' && (
                  <div className="mt-2 space-y-2">
                    <div className="text-[10px] text-sf-error">
                      Missing required dependencies. Queueing is blocked until these are installed.
                    </div>

                    {dependencyCheck.missingNodes.length > 0 && (
                      <div className="text-[10px]">
                        <div className="text-sf-text-muted mb-1">Missing nodes:</div>
                        <div className="space-y-1">
                          {dependencyCheck.missingNodes.map((node) => (
                            <div key={node.classType} className="text-sf-error">{node.classType}</div>
                          ))}
                        </div>
                      </div>
                    )}

                    {dependencyCheck.missingModels.length > 0 && (
                      <div className="text-[10px]">
                        <div className="text-sf-text-muted mb-1">Missing models:</div>
                        <div className="space-y-1">
                          {dependencyCheck.missingModels.map((model) => (
                            <div key={`${model.classType}:${model.inputKey}:${model.filename}`} className="text-sf-error break-all">
                              {model.filename}
                              {model.targetSubdir ? (
                                <span className="text-sf-text-muted">{` -> ComfyUI/models/${model.targetSubdir}`}</span>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {dependencyCheck.missingAuth && (
                      <div className="mt-1 flex items-center justify-between gap-2 rounded border border-yellow-400/30 bg-yellow-400/5 px-2 py-1.5">
                        <div className="flex items-center gap-1.5 text-[10px] text-yellow-300">
                          <KeyRound className="h-3 w-3" />
                          <span>This workflow runs on Comfy.org's API. Add your key to unlock it.</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setApiKeyDialogOpen(true)}
                          className="rounded bg-sf-accent px-2 py-0.5 text-[10px] font-medium text-white transition-colors hover:bg-sf-accent/90"
                        >
                          Set up key
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {dependencyCheck.unresolvedModels.length > 0 && dependencyCheck.status !== 'missing' && (
                  <div className="mt-2 text-[10px] text-yellow-400">
                    {dependencyCheck.unresolvedModels.length} model check(s) could not be auto-verified from ComfyUI metadata.
                  </div>
                )}

                {(dependencyCheck.status === 'missing' || dependencyCheck.status === 'partial') && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => { void handleCopyDependencyReport() }}
                      className="px-2 py-1 rounded border border-sf-dark-500 text-[10px] text-sf-text-secondary hover:text-sf-text-primary hover:border-sf-dark-400 transition-colors"
                    >
                      Copy report
                    </button>
                    <button
                      type="button"
                      onClick={() => { void handleOpenCurrentWorkflowInComfyUi() }}
                      className="px-2 py-1 rounded border border-sf-dark-500 text-[10px] text-sf-text-secondary hover:text-sf-text-primary hover:border-sf-dark-400 transition-colors"
                    >
                      Load in ComfyUI
                    </button>
                    {typeof onOpenWorkflowSetup === 'function' && (
                      <button
                        type="button"
                        onClick={() => onOpenWorkflowSetup()}
                        className="px-2 py-1 rounded border border-sf-dark-500 text-[10px] text-sf-text-secondary hover:text-sf-text-primary hover:border-sf-dark-400 transition-colors"
                      >
                        Workflow Setup
                      </button>
                    )}
                    {dependencyCheck.pack?.docsUrl && (
                      <a
                        href={dependencyCheck.pack.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[10px] text-sf-accent hover:text-sf-accent-hover"
                      >
                        Open node registry
                      </a>
                    )}
                  </div>
                )}
              </div>
            )}

            {!isConnected && (
              <div className="mt-2 text-[10px] text-sf-error text-center">ComfyUI is not running. Start it to generate.</div>
            )}

            {generationMode === 'single' && currentWorkflow?.needsImage && !selectedAsset && !frameForAI && (
              <div className="mt-2 text-[10px] text-yellow-500 text-center">Select an input asset or use a timeline frame (right-click preview → Extend with AI)</div>
            )}
            {generationMode === 'yolo' && yoloQueueVariants.length === 0 && (
              <div className="mt-2 text-[10px] text-yellow-500 text-center">Build a plan first before queueing.</div>
            )}

            {formError && (
              <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-left">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 text-[10px] font-semibold text-red-200">
                    Generation message
                  </div>
                  <button
                    type="button"
                    onClick={() => { void handleCopyFormError() }}
                    className="inline-flex shrink-0 items-center gap-1 rounded border border-red-300/30 bg-sf-dark-950/60 px-1.5 py-0.5 text-[9px] font-medium text-red-100 transition-colors hover:border-red-200/60 hover:text-white"
                    title="Copy this error and troubleshooting context"
                  >
                    <Copy className="h-3 w-3" />
                    {formErrorCopyStatus || 'Copy error'}
                  </button>
                </div>
                <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-words font-sans text-[10px] leading-4 text-sf-error">{formError}</pre>
                {formErrorTroubleshootingHints.length > 0 && (
                  <div className="mt-2 space-y-1 rounded border border-red-300/20 bg-sf-dark-950/50 p-2 text-[9px] leading-4 text-red-100">
                    <div className="font-semibold text-red-50">Troubleshooting hints</div>
                    {formErrorTroubleshootingHints.map((hint) => (
                      <div key={hint}>{hint}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Queue list */}
          {hasJobs && (
            <div className="p-4 border-b border-sf-dark-700 space-y-3">
              {generationQueue.map((job) => {
                const percent = Math.round(job.progress || 0)
                const isYoloAdStoryboardJob = job?.yolo?.stage === 'storyboard' && job?.yolo?.mode !== 'music'
                const referenceRoleParts = []
                if (job.referenceAssetId1) referenceRoleParts.push(isYoloAdStoryboardJob ? 'Product' : 'Ref 1')
                if (job.referenceAssetId2) referenceRoleParts.push(isYoloAdStoryboardJob ? 'Model' : 'Ref 2')
                const referenceCount = referenceRoleParts.length
                const referenceRoleLabel = referenceRoleParts.join(' + ')
                const referenceNameParts = [job.referenceAssetId1, job.referenceAssetId2]
                  .filter(Boolean)
                  .map((id) => assetNameById.get(id))
                  .filter(Boolean)
                const hasReferenceAnchors = referenceCount > 0
                const consistencyLabel = job?.yolo?.referenceConsistency
                  ? formatReferenceConsistencyLabel(job.yolo.referenceConsistency)
                  : null
                // Pass origin (music mode only). When set, render a small
                // badge so the user can see at-a-glance which pass each
                // queued job is generating for — useful while alternating
                // between master/alt builds in rapid succession.
                const jobPassType = String(job?.yolo?.pass?.type || '')
                const showJobPassBadge = jobPassType && jobPassType !== 'master'
                const jobPassBadge = showJobPassBadge ? getMusicVideoPassBadge(jobPassType) : ''
                const jobPassLabel = showJobPassBadge
                  ? (String(job?.yolo?.pass?.altLabel || '') || getMusicVideoPassDisplayName(jobPassType))
                  : ''
                const statusLabel = job.status === 'queued' ? 'Queued'
                  : job.status === 'paused' ? 'Paused'
                  : job.status === 'uploading' ? 'Uploading input'
                  : job.status === 'configuring' ? 'Configuring workflow'
                  : job.status === 'queuing' ? 'Queued in ComfyUI'
                  : job.status === 'running' ? 'Generating'
                  : job.status === 'saving' ? 'Saving to project'
                  : job.status === 'done' ? 'Complete'
                  : job.status === 'error' ? 'Failed'
                  : job.status
                const isStaleOutputError = typeof job.error === 'string'
                  && /stale\/duplicate output|stale output|duplicate output/i.test(job.error)
                const title = `${job.workflowLabel || job.workflowId}${job.prompt ? ` — ${job.prompt}` : ''}`
                const canCreateAngleSheet = (
                  job.status === 'done'
                  && (job.workflowId === 'multi-angles' || job.workflowId === 'multi-angles-scene')
                  && Array.isArray(job.resultAssetIds)
                  && job.resultAssetIds.length > 1
                )
                return (
                  <div key={job.id} className="bg-sf-dark-800 rounded-lg p-3 border border-sf-dark-700">
                    <div className="flex items-center justify-between text-[10px] text-sf-text-muted mb-1">
                      <span className="text-sf-text-primary truncate" title={title}>
                        {job.workflowLabel || job.workflowId}
                      </span>
                      <span className="tabular-nums">{percent}%</span>
                    </div>
                    <div className="h-1.5 bg-sf-dark-900 rounded-full overflow-hidden">
                      <div className="h-full bg-sf-accent transition-all duration-300" style={{ width: `${percent}%` }} />
                    </div>
                    <div className="mt-1 text-[9px] text-sf-text-muted flex items-center gap-1.5 flex-wrap">
                      <span>{statusLabel}{job.node ? ` · Node ${job.node}` : ''}</span>
                      {showJobPassBadge && (
                        <span
                          className="px-1 py-0.5 rounded border border-sf-dark-600 bg-sf-dark-900 text-[8.5px] tracking-wider uppercase text-sf-text-secondary"
                          title={`Pass: ${jobPassLabel}`}
                        >
                          {jobPassBadge}
                        </span>
                      )}
                    </div>
                    {hasReferenceAnchors && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        <span
                          className="px-1.5 py-0.5 rounded border border-sf-accent/30 bg-sf-accent/15 text-[9px] text-sf-accent"
                          title={referenceNameParts.join(' + ')}
                        >
                          {`Anchors: ${referenceRoleLabel}${referenceNameParts.length > 0 ? ` (${referenceNameParts.join(' + ')})` : ''}`}
                        </span>
                        {consistencyLabel && (
                          <span className="px-1.5 py-0.5 rounded border border-sf-dark-600 bg-sf-dark-700 text-[9px] text-sf-text-secondary">
                            Consistency: {consistencyLabel}
                          </span>
                        )}
                      </div>
                    )}
                    {job.error && (
                      <div className="mt-1 space-y-1">
                        {isStaleOutputError && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded border border-yellow-500/30 bg-yellow-500/15 text-[9px] text-yellow-300">
                            Stale output detected
                          </span>
                        )}
                        <div className="text-[9px] text-sf-error">{job.error}</div>
                      </div>
                    )}
                    {canCreateAngleSheet && (
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleCreateAngleSheetForJob(job)}
                          disabled={Boolean(job.isCombiningAngles)}
                          className="px-2 py-1 rounded border border-sf-dark-600 bg-sf-dark-700 hover:bg-sf-dark-600 text-[10px] text-sf-text-primary disabled:opacity-60"
                        >
                          {job.isCombiningAngles ? 'Creating Sheet...' : 'Create Angle Sheet'}
                        </button>
                        {job.combineError && (
                          <span className="text-[9px] text-sf-error">{job.combineError}</span>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Info panel (collapsible) */}
          <div className="p-4">
            <button
              type="button"
              onClick={() => setWorkflowInfoExpanded(prev => !prev)}
              className="w-full flex items-center justify-between gap-2 text-left text-[10px] text-sf-text-muted uppercase tracking-wider mb-2 hover:text-sf-text-primary transition-colors"
            >
              Workflow Info
              {workflowInfoExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
            {workflowInfoExpanded && (
            <div className="space-y-2 text-[11px] text-sf-text-secondary">
              {generationMode === 'single' ? (
                <>
                  <div><span className="text-sf-text-muted">Category:</span> {category}</div>
                  <div><span className="text-sf-text-muted">Workflow:</span> {currentWorkflow?.label}</div>
                  <div><span className="text-sf-text-muted">Hardware tier:</span> {currentWorkflowTierMeta?.label || 'Unknown'}</div>
                  <div><span className="text-sf-text-muted">Runtime:</span> {currentWorkflowRuntimeLabel}</div>
                  {currentWorkflowUsesCloud && (
                    <div>
                      <span className="text-sf-text-muted">Cloud estimate / run:</span>{' '}
                      {dependencyCheck.status === 'checking'
                        ? 'Checking pricing...'
                        : dependencyCheck?.estimatedCredits
                          ? (
                            <>
                              {formatCreditsRange(dependencyCheck.estimatedCredits, 1)} ({formatUsdRangeFromCredits(dependencyCheck.estimatedCredits, 1)})
                              {dependencyCheck?.hasPriceMetadata && (
                                <span className="text-yellow-400"> (dynamic pricing)</span>
                              )}
                            </>
                          )
                          : (
                            dependencyCheck?.hasPriceMetadata
                              ? 'Dynamic pricing (estimate unavailable)'
                              : 'No credit metadata'
                          )}
                    </div>
                  )}
                  <div><span className="text-sf-text-muted">Needs input:</span> {currentWorkflow?.needsImage ? 'Yes (image)' : 'No'}</div>
                  {category === 'video' && (
                    <>
                      <div><span className="text-sf-text-muted">Output:</span> {duration}s @ {fps}fps ({getFrameCount()} frames)</div>
                      <div><span className="text-sf-text-muted">Resolution:</span> {resolution.width}x{resolution.height}</div>
                    </>
                  )}
                  {category === 'image' && currentOutputResolution && (imageResolutionControlVisible || seedreamUsesInputResolution) && (
                    <div><span className="text-sf-text-muted">Output size:</span> {currentOutputResolution.width}x{currentOutputResolution.height}</div>
                  )}
                  {category === 'audio' && (
                    <>
                      <div><span className="text-sf-text-muted">Duration:</span> {musicDuration}s</div>
                      <div><span className="text-sf-text-muted">BPM:</span> {bpm}</div>
                      <div><span className="text-sf-text-muted">Key:</span> {keyscale}</div>
                    </>
                  )}
                  <div><span className="text-sf-text-muted">Seed:</span> {seed}</div>
                </>
              ) : (
                <>
                  <div><span className="text-sf-text-muted">Mode:</span> {DIRECTOR_MODE_BETA_LABEL}</div>
                  <div><span className="text-sf-text-muted">Creation:</span> {yoloModeLabel}</div>
                  {!isYoloMusicMode && (
                    <>
                      <div>
                        <span className="text-sf-text-muted">Keyframe source:</span> {yoloStoryboardProfileRuntimeMeta?.label || yoloStoryboardProfileRuntime}
                      </div>
                      {yoloStoryboardUsesCloudTier ? (
                        <div>
                          <span className="text-sf-text-muted">Keyframe cloud tier:</span> {yoloSelectedStoryboardTierMeta?.label || yoloNormalizedAdStoryboardTier}
                        </div>
                      ) : (
                        <div>
                          <span className="text-sf-text-muted">Keyframe local workflow:</span> {yoloSelectedAdStageRouting?.imageLabel || getWorkflowDisplayLabel(yoloStoryboardWorkflowId)}
                        </div>
                      )}
                      <div>
                        <span className="text-sf-text-muted">Video source:</span> {yoloVideoProfileRuntimeMeta?.label || yoloVideoProfileRuntime}
                      </div>
                      {yoloVideoUsesCloudTier ? (
                        <div>
                          <span className="text-sf-text-muted">Video cloud tier:</span> {yoloSelectedVideoTierMeta?.label || yoloNormalizedAdVideoTier}
                        </div>
                      ) : (
                        <div>
                          <span className="text-sf-text-muted">Video local workflow:</span> {yoloSelectedAdStageRouting?.videoLabel || getWorkflowDisplayLabel(yoloDefaultVideoWorkflowId)}
                        </div>
                      )}
                      <div>
                        <span className="text-sf-text-muted">Requested video FPS:</span> {yoloVideoFps}
                        {!yoloSelectedVideoWorkflowSupportsCustomFps ? ' (provider-dependent)' : ''}
                      </div>
                    </>
                  )}
                  {isYoloMusicMode && (
                    <div><span className="text-sf-text-muted">Profile:</span> {yoloMusicQualityProfile}</div>
                  )}
                  <div><span className="text-sf-text-muted">Keyframe workflow:</span> {yoloStoryboardWorkflowId}</div>
                  <div><span className="text-sf-text-muted">Keyframe runtime:</span> {formatWorkflowHardwareRuntime(yoloStoryboardWorkflowId)}</div>
                  <div><span className="text-sf-text-muted">Video default:</span> {getWorkflowDisplayLabel(yoloDefaultVideoWorkflowId)}</div>
                  <div><span className="text-sf-text-muted">Video runtime:</span> {formatWorkflowHardwareRuntime(yoloDefaultVideoWorkflowId)}</div>
                  <div><span className="text-sf-text-muted">Video queue target:</span> {yoloSelectedVideoWorkflowLabel}</div>
                  <div><span className="text-sf-text-muted">Video target tier:</span> {yoloVideoTargetTierSummary}</div>
                  <div><span className="text-sf-text-muted">Scenes:</span> {yoloSceneCount}</div>
                  <div><span className="text-sf-text-muted">Planned variants:</span> {yoloVariants.length}</div>
                  <div><span className="text-sf-text-muted">Queue variants:</span> {yoloQueueVariants.length}</div>
                  <div><span className="text-sf-text-muted">Keyframes ready:</span> {yoloStoryboardReadyCount}/{yoloQueueVariants.length}</div>
                </>
              )}
            </div>
            )}
          </div>
          </div>
          </>
          )}
        </div>
      </div>

      {/* ComfyUI activity log – always present, expand/collapse for troubleshooting */}
      <div className="flex-shrink-0 border-t border-sf-dark-700 bg-sf-dark-900">
        <button
          type="button"
          onClick={() => setComfyLogExpanded(prev => !prev)}
          className="w-full h-9 flex items-center justify-between gap-2 px-3 text-left text-[11px] text-sf-text-muted hover:bg-sf-dark-800 hover:text-sf-text-primary transition-colors"
          title={comfyLogExpanded ? 'Collapse ComfyUI log' : 'Show ComfyUI activity log'}
        >
          <span className="flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5" />
            ComfyUI log
            {comfyLogLines.length > 0 && (
              <span className="text-[9px] opacity-70">{comfyLogLines.length} lines</span>
            )}
          </span>
          {comfyLogExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </button>
        {comfyLogExpanded && (
          <div className="h-44 overflow-y-auto border-t border-sf-dark-700 bg-black/40 font-mono text-[10px] text-sf-text-secondary">
            {comfyLogLines.length === 0 ? (
              <div className="p-3 text-sf-text-muted">No activity yet. Queue a generation to see ComfyUI events here.</div>
            ) : (
              <div className="p-2 space-y-0.5">
                {comfyLogLines.map((line, i) => (
                  <div key={i} className={`flex gap-2 ${line.type === 'error' ? 'text-sf-error' : ''}`}>
                    <span className="text-sf-text-muted flex-shrink-0">[{line.ts}]</span>
                    <span className="break-all">{line.msg}</span>
                  </div>
                ))}
                <div ref={comfyLogEndRef} />
              </div>
            )}
          </div>
        )}
      </div>

      <ImageAnnotationModal
        isOpen={annotationModalOpen}
        onClose={closeAnnotationModal}
        initialImageUrl={annotationInitialUrl}
        otherImageAssets={assets.filter(a => a.type === 'image')}
        onUseAsRef={handleAnnotationUseAsRef}
      />
      <ConfirmDialog
        isOpen={Boolean(confirmDialog)}
        title={confirmDialog?.title || 'Confirm action'}
        message={confirmDialog?.message || ''}
        confirmLabel={confirmDialog?.confirmLabel || 'Confirm'}
        cancelLabel={confirmDialog?.cancelLabel || 'Cancel'}
        tone={confirmDialog?.tone || 'danger'}
        onConfirm={() => resolveConfirmDialog(true)}
        onCancel={() => resolveConfirmDialog(false)}
      />
      <ApiKeyDialog
        open={apiKeyDialogOpen}
        onClose={() => setApiKeyDialogOpen(false)}
      />
    </div>
  )
}

export default GenerateWorkspace
