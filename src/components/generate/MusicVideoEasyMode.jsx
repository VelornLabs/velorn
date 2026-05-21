import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2,
  Clipboard,
  ExternalLink,
  Edit3,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Music,
  Play,
  RefreshCw,
  UserPlus,
  Wand2,
  X,
} from 'lucide-react'
import {
  CUSTOM_MUSIC_KEYFRAME_WORKFLOW_ID,
  CUSTOM_MUSIC_VIDEO_WORKFLOW_ID,
} from '../../config/generateWorkspaceConfig'
import {
  MUSIC_VIDEO_AUDIO_KIND_OPTIONS,
  MUSIC_VIDEO_CAST_ROLE_OPTIONS,
  MUSIC_VIDEO_SCRIPT_TEMPLATE,
  MUSIC_VIDEO_SHOT_WORKFLOW_ID,
  getMusicVideoAudioKindOption,
  getMusicVideoShotTypeOption,
  normalizeCastSlug,
} from '../../config/musicVideoShotConfig'
import {
  getWorkflowDisplayLabel,
} from '../../config/generateWorkspaceConfig'
import { BUILTIN_WORKFLOW_PATHS } from '../../config/workflowRegistry'

const DRAFT_STORAGE_KEY = 'comfystudio-music-video-easy-mode-draft-v1'
const DRAFT_PROJECT_STORAGE_PREFIX = `${DRAFT_STORAGE_KEY}:project:`

const STEPS = [
  { id: 'song', label: 'Song', number: '1' },
  { id: 'people', label: 'People', number: '2' },
  { id: 'script', label: 'Director Script', number: '3' },
  { id: 'keyframes', label: 'Keyframes', number: '4' },
  { id: 'videos', label: 'Videos', number: '5' },
]

const ASPECT_RATIO_OPTIONS = [
  { id: 'landscape_16x9', label: '16:9', helper: 'Landscape music video frame.' },
  { id: 'vertical_9x16', label: '9:16', helper: 'Vertical social frame.' },
  { id: 'square_1x1', label: '1:1', helper: 'Square social frame.' },
]

const RESOLUTION_OPTIONS = [
  { id: '720p', label: '720p' },
  { id: '1080p', label: '1080p' },
]

const PEOPLE_WIZARD_IMAGE_SIZE_OPTIONS = [
  { id: 'hd', label: 'HD', resolution: { width: 720, height: 1280 }, landscapeResolution: { width: 1280, height: 720 } },
  { id: 'fhd', label: 'FHD', resolution: { width: 1080, height: 1920 }, landscapeResolution: { width: 1920, height: 1080 } },
]

const PEOPLE_WIZARD_IMAGE_ORIENTATION_OPTIONS = [
  { id: 'portrait', label: 'Portrait' },
  { id: 'landscape', label: 'Landscape' },
]

const FPS_OPTIONS = [24, 25, 30]
const PERFORMANCE_PASS_OPTIONS = [0, 1, 2, 3]
const COVERAGE_PRESET_OPTIONS = [
  {
    id: 'simple',
    label: 'Simple',
    helper: 'One timing-accurate director script.',
    performancePassCount: 0,
    includeStoryBroll: false,
    includeEnvironmentalBroll: false,
    includeDetailBroll: false,
  },
  {
    id: 'standard',
    label: 'Standard',
    helper: 'Main script, one vocal performance pass, and story b-roll.',
    performancePassCount: 1,
    includeStoryBroll: true,
    includeEnvironmentalBroll: false,
    includeDetailBroll: false,
  },
  {
    id: 'editorial',
    label: 'Editorial',
    helper: 'Main script, two vocal performance passes, story, environment, and detail coverage.',
    performancePassCount: 2,
    includeStoryBroll: true,
    includeEnvironmentalBroll: true,
    includeDetailBroll: true,
  },
]
const COVERAGE_TYPE_LABELS = Object.freeze({
  main_sequence: 'Main sequence',
  performance_pass: 'Performance pass',
  story_broll: 'Story b-roll',
  detail_broll: 'Detail b-roll',
  environmental_broll: 'Environmental b-roll',
})
const DEFAULT_VIDEO_WORKFLOW_OPTIONS = Object.freeze([
  {
    id: MUSIC_VIDEO_SHOT_WORKFLOW_ID,
    label: 'LTX 2.3 Music',
    description: 'Default. Uses song timing/audio for performance and lip-sync shots.',
  },
  {
    id: 'wan22-i2v',
    label: 'WAN 2.2',
    description: 'Alternate animation pass. Strong physical motion, no song-audio lip-sync conditioning.',
  },
  {
    id: CUSTOM_MUSIC_VIDEO_WORKFLOW_ID,
    label: 'Custom Workflow',
    runtimeLabel: 'Advanced',
    description: 'Use your own ComfyUI video workflow as long as it keeps the ComfyStudio input/output endpoints.',
  },
])
const DEFAULT_KEYFRAME_WORKFLOW_OPTIONS = Object.freeze([
  {
    id: 'image-edit',
    label: 'Qwen Image Edit',
    runtimeLabel: 'Local',
    description: 'Fully local keyframes using Qwen Image Edit 2509. Uses the resolved cast/reference image as the edit source.',
  },
  {
    id: 'nano-banana-2',
    label: 'Nano Banana 2',
    runtimeLabel: 'Cloud',
    description: 'Cloud keyframes with stronger reference-image and identity consistency.',
  },
  {
    id: CUSTOM_MUSIC_KEYFRAME_WORKFLOW_ID,
    label: 'Custom Workflow',
    runtimeLabel: 'Advanced',
    description: 'Use your own ComfyUI keyframe workflow as long as it keeps the ComfyStudio input/output endpoints.',
  },
])
const JOB_BUSY_STATUSES = new Set(['queued', 'paused', 'uploading', 'configuring', 'queuing', 'running', 'saving'])
const JOB_ERROR_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled'])

const DEFAULT_DRAFT = Object.freeze({
  step: 'song',
  aspectRatio: 'landscape_16x9',
  resolutionPreset: '720p',
  videoFps: 24,
  coveragePreset: 'standard',
  performancePassCount: 1,
  includeStoryBroll: true,
  includeEnvironmentalBroll: false,
  includeDetailBroll: false,
})

function normalizeDraftOption(value, options, fallback) {
  const normalized = String(value || '').trim()
  return options.some((option) => option?.id === normalized) ? normalized : fallback
}

function normalizeResolutionPreset(value) {
  const normalized = String(value || '').trim()
  if (normalized === '2k') return '1080p'
  return normalizeDraftOption(normalized, RESOLUTION_OPTIONS, DEFAULT_DRAFT.resolutionPreset)
}

function normalizeDraftNumber(value, allowedValues, fallback) {
  const parsed = Number(value)
  return allowedValues.includes(parsed) ? parsed : fallback
}

function normalizeDraftStep(stepId) {
  if (stepId === 'type') return 'script'
  if (stepId === 'complete') return 'videos'
  return STEPS.some((step) => step.id === stepId) ? stepId : DEFAULT_DRAFT.step
}

function normalizeCoveragePreset(presetId) {
  const normalized = String(presetId || '').trim()
  if (normalized === 'custom') return normalized
  return COVERAGE_PRESET_OPTIONS.some((option) => option.id === normalized)
    ? normalized
    : DEFAULT_DRAFT.coveragePreset
}

function normalizeDraftBoolean(value, fallback) {
  if (typeof value === 'boolean') return value
  return fallback
}

function getDraftStorageKey(projectScope = '') {
  return projectScope ? `${DRAFT_PROJECT_STORAGE_PREFIX}${projectScope}` : ''
}

function loadDraft(storageKey = '') {
  if (!storageKey || typeof localStorage === 'undefined') return DEFAULT_DRAFT
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || '{}')
    return {
      step: normalizeDraftStep(parsed.step),
      aspectRatio: normalizeDraftOption(parsed.aspectRatio, ASPECT_RATIO_OPTIONS, DEFAULT_DRAFT.aspectRatio),
      resolutionPreset: normalizeResolutionPreset(parsed.resolutionPreset),
      videoFps: normalizeDraftNumber(parsed.videoFps, FPS_OPTIONS, DEFAULT_DRAFT.videoFps),
      coveragePreset: normalizeCoveragePreset(parsed.coveragePreset),
      performancePassCount: normalizeDraftNumber(parsed.performancePassCount, PERFORMANCE_PASS_OPTIONS, DEFAULT_DRAFT.performancePassCount),
      includeStoryBroll: normalizeDraftBoolean(parsed.includeStoryBroll, DEFAULT_DRAFT.includeStoryBroll),
      includeEnvironmentalBroll: normalizeDraftBoolean(parsed.includeEnvironmentalBroll, DEFAULT_DRAFT.includeEnvironmentalBroll),
      includeDetailBroll: normalizeDraftBoolean(parsed.includeDetailBroll, DEFAULT_DRAFT.includeDetailBroll),
    }
  } catch (_) {
    return DEFAULT_DRAFT
  }
}

function plural(count, singular, pluralLabel = `${singular}s`) {
  const value = Number(count) || 0
  return `${value} ${value === 1 ? singular : pluralLabel}`
}

async function copyTextToClipboard(text) {
  const value = String(text || '')
  if (!value) return false
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return true
  }
  if (typeof document === 'undefined') return false
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } finally {
    document.body.removeChild(textarea)
  }
}

function flattenPlanShots(plan) {
  const shots = []
  if (!Array.isArray(plan)) return shots
  for (const scene of plan) {
    for (const shot of scene?.shots || []) {
      shots.push({ scene, shot })
    }
  }
  return shots
}

function getShotTypeId(shot) {
  return String(shot?.musicShotType || shot?.shotType || '').trim()
}

function resolveOutputResolution(aspectRatio, resolutionPreset) {
  const is1080 = (resolutionPreset === '2k' ? '1080p' : resolutionPreset) === '1080p'
  if (aspectRatio === 'vertical_9x16') {
    return is1080 ? { width: 1080, height: 1920 } : { width: 720, height: 1280 }
  }
  if (aspectRatio === 'square_1x1') {
    return is1080 ? { width: 1080, height: 1080 } : { width: 720, height: 720 }
  }
  return is1080 ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }
}

function resolvePeopleWizardImageResolution(sizeId, orientationId) {
  const size = PEOPLE_WIZARD_IMAGE_SIZE_OPTIONS.find((option) => option.id === String(sizeId || '').trim())
    || PEOPLE_WIZARD_IMAGE_SIZE_OPTIONS[0]
  const isLandscape = String(orientationId || '').trim() === 'landscape'
  return isLandscape ? size.landscapeResolution : size.resolution
}

function workflowSupports1080Resolution(workflowId) {
  return [MUSIC_VIDEO_SHOT_WORKFLOW_ID, CUSTOM_MUSIC_VIDEO_WORKFLOW_ID].includes(String(workflowId || '').trim())
}

function getResolutionFallbackForWorkflow(workflowId, resolutionPreset) {
  const normalizedPreset = resolutionPreset === '2k' ? '1080p' : resolutionPreset
  if (workflowSupports1080Resolution(workflowId)) {
    return normalizedPreset === '1080p' ? '1080p' : '720p'
  }
  return '720p'
}

function formatResolutionLabel(resolution) {
  if (!resolution) return ''
  return `${resolution.width}x${resolution.height}`
}

function normalizeDimension(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null
}

function formatAssetDimensionLabel(asset, runtimeImageDimensions = {}) {
  if (!asset) return ''
  const runtime = asset?.id ? runtimeImageDimensions[asset.id] : null
  const width = normalizeDimension(runtime?.width ?? asset?.width ?? asset?.settings?.width)
  const height = normalizeDimension(runtime?.height ?? asset?.height ?? asset?.settings?.height)
  return width && height ? `${width}x${height}` : ''
}

function buildActualImageResolutionParts(asset, runtimeImageDimensions, requestedResolutionLabel) {
  const actualLabel = formatAssetDimensionLabel(asset, runtimeImageDimensions)
  if (!actualLabel) return requestedResolutionLabel ? [requestedResolutionLabel] : []
  if (requestedResolutionLabel && actualLabel !== requestedResolutionLabel) {
    return [`${actualLabel} image`, `requested ${requestedResolutionLabel}`]
  }
  return [`${actualLabel} image`]
}

function getAssetUrl(asset) {
  return asset?.url || asset?.thumbnailUrl || asset?.proxyUrl || asset?.path || ''
}

function ShotVideoPreview({ hasVideo, keyframeUrl, placeholderLabel = "Needs keyframe" }) {
  if (keyframeUrl) {
    return <img src={keyframeUrl} alt="" className="h-full w-full object-cover opacity-70" loading="lazy" decoding="async" />
  }

  if (hasVideo) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-sf-dark-800 text-sf-text-muted">
        <Play className="h-5 w-5 opacity-70" />
      </div>
    )
  }

  return <span className="flex h-full w-full items-center justify-center text-[10px] text-sf-text-muted">{placeholderLabel}</span>
}

function inferPeopleWizardAssetPrefix(asset, fallbackValue = '') {
  const metadataPrefix = normalizeCastSlug(asset?.peopleWizard?.assetPrefix || '')
  if (metadataPrefix) return metadataPrefix
  const rawName = String(asset?.name || '').trim()
  if (!rawName) return normalizeCastSlug(fallbackValue || '')
  const baseName = rawName
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .replace(/_I\d+$/i, '')
    .replace(/_(image|sheet)$/i, '')
  return normalizeCastSlug(baseName || fallbackValue || '')
}

function getVideoWorkflowScopedKey(variantKey, workflowId) {
  const key = String(variantKey || '').trim()
  const workflow = String(workflowId || '').trim()
  return key && workflow ? `${key}::${workflow}` : ''
}

function buttonClass(selected) {
  return selected
    ? 'border-sf-accent bg-sf-accent/20 text-sf-text-primary ring-1 ring-sf-accent/40'
    : 'border-sf-dark-600 bg-sf-dark-900 text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary'
}

function getAudioModeHelper(kindId) {
  if (kindId === 'vocal_stem') {
    return 'Using isolated vocals. Lip-sync performance shots can use this audio directly.'
  }
  if (kindId === 'instrumental') {
    return 'No vocals expected. The director script should use b-roll or non-lip-sync performance coverage.'
  }
  return 'ComfyStudio assumes a normal finished song by default. Lip-sync and b-roll routing still come from the director script.'
}

function buildCoveragePlan({ performancePassCount, includeStoryBroll, includeEnvironmentalBroll, includeDetailBroll }) {
  const sections = [{
    type: 'main_sequence',
    label: 'Main scripted sequence',
    intent: 'The primary music-video timeline with the core performance, story, and b-roll choices.',
  }]
  const passCount = Math.max(0, Math.min(3, Number(performancePassCount) || 0))
  for (let index = 1; index <= passCount; index += 1) {
    sections.push({
      type: 'performance_pass',
      label: `Performance pass ${index}`,
      intent: 'Lip-sync coverage for the vocal sections only, in a distinct setup, angle language, wardrobe, lighting, or location.',
    })
  }
  if (includeStoryBroll) {
    sections.push({
      type: 'story_broll',
      label: 'Story b-roll pass',
      intent: 'Non-lip-sync cast/person coverage that carries a start-middle-end b-roll story over the main timeline.',
    })
  }
  if (includeEnvironmentalBroll) {
    sections.push({
      type: 'environmental_broll',
      label: 'Environmental b-roll pass',
      intent: 'Places, atmosphere, empty spaces, exteriors, mood, and world-building coverage from the same b-roll story arc.',
    })
  }
  if (includeDetailBroll) {
    sections.push({
      type: 'detail_broll',
      label: 'Detail insert pass',
      intent: 'Short macro, texture, prop, instrument, hand, and atmosphere inserts that reveal clues from the same b-roll story arc.',
    })
  }
  return {
    sections,
    performancePassCount: passCount,
    includeStoryBroll: Boolean(includeStoryBroll),
    includeEnvironmentalBroll: Boolean(includeEnvironmentalBroll),
    includeDetailBroll: Boolean(includeDetailBroll),
  }
}

function getCoverageSummary(plan) {
  const parts = ['main sequence']
  if (plan.performancePassCount > 0) {
    parts.push(plural(plan.performancePassCount, 'performance pass', 'performance passes'))
  }
  if (plan.includeStoryBroll) parts.push('story b-roll')
  if (plan.includeEnvironmentalBroll) parts.push('environmental b-roll')
  if (plan.includeDetailBroll) parts.push('detail inserts')
  return parts.join(' + ')
}

function getCoverageLabel(scene, shot) {
  const label = String(shot?.coverageLabel || scene?.coverageLabel || '').trim()
  if (label) return label
  const type = String(shot?.coverageType || scene?.coverageType || '').trim()
  return COVERAGE_TYPE_LABELS[type] || type.replace(/_/g, ' ')
}

function FieldLabel({ children }) {
  return <label className="text-[10px] uppercase text-sf-text-muted">{children}</label>
}

function Stat({ label, value }) {
  return (
    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 px-3 py-2">
      <div className="text-[10px] uppercase text-sf-text-muted">{label}</div>
      <div className="mt-1 text-sm font-semibold text-sf-text-primary">{value}</div>
    </div>
  )
}

export default function MusicVideoEasyMode({
  draftStorageScope = '',
  assets,
  generationQueue,
  yoloMusicAudioAssets,
  yoloMusicAudioAssetId,
  setYoloMusicAudioAssetId,
  yoloMusicAudioKind,
  setYoloMusicAudioKind,
  yoloMusicAudioAsset,
  yoloMusicTranscribingSrt,
  yoloMusicTranscriptionStatus,
  handleYoloMusicTranscribeSrt,
  yoloMusicLyrics,
  setYoloMusicLyrics,
  yoloMusicParsedLyrics,
  yoloMusicScript,
  setYoloMusicScript,
  yoloMusicCast,
  yoloMusicResolvedCast,
  setYoloMusicCast,
  handleYoloMusicCastAdd,
  handleYoloMusicCastRemove,
  handleYoloMusicCastAssetChange,
  handleYoloMusicCastSlugChange,
  handleYoloMusicCastLabelChange,
  handleYoloMusicCastRoleChange,
  queuePeopleWizardJob,
  canUsePeopleWizardGeneration = false,
  yoloMusicKeyframeWorkflowId = 'nano-banana-2',
  setYoloMusicKeyframeWorkflowId,
  yoloMusicKeyframeWorkflowOptions = DEFAULT_KEYFRAME_WORKFLOW_OPTIONS,
  yoloMusicCustomKeyframeWorkflow,
  yoloMusicCustomKeyframeValidation,
  handleImportYoloMusicCustomKeyframeWorkflow,
  handleOpenYoloMusicCustomKeyframeWorkflowInComfyUi,
  handleClearYoloMusicCustomKeyframeWorkflow,
  customKeyframeBridgeStatus,
  customKeyframeBridgeBusy = false,
  handleInstallYoloMusicCustomKeyframeBridge,
  handleCheckYoloMusicCustomKeyframeBridge,
  yoloMusicVideoWorkflowId,
  setYoloMusicVideoWorkflowId,
  yoloMusicVideoWorkflowOptions = DEFAULT_VIDEO_WORKFLOW_OPTIONS,
  yoloMusicCustomVideoWorkflow,
  yoloMusicCustomVideoValidation,
  handleImportYoloMusicCustomVideoWorkflow,
  handleOpenYoloMusicCustomVideoWorkflowInComfyUi,
  handleClearYoloMusicCustomVideoWorkflow,
  yoloActivePlan,
  yoloQueueVariants,
  yoloStoryboardAssetMap,
  yoloStoryboardReadyCount,
  yoloActivePlanIsStale,
  yoloDependencyCheckInProgress,
  handleBuildActiveYoloPlan,
  handleQueueYoloStoryboards,
  handleQueueYoloShotStoryboard,
  handleQueueYoloVideos,
  handleQueueYoloShotVideo,
  handleYoloShotImageBeatChange,
  handleYoloShotVideoBeatChange,
  handleCopyMusicVideoLlmPrompt,
  handleAssembleMusicVideoTimeline,
  setYoloVideoFps,
  setResolution,
  setImageResolution,
}) {
  const draftStorageKey = useMemo(() => getDraftStorageKey(draftStorageScope), [draftStorageScope])
  const initialDraft = useMemo(() => loadDraft(draftStorageKey), [draftStorageKey])
  const audioDefaultMigratedRef = useRef(false)
  const [step, setStep] = useState(initialDraft.step)
  const [aspectRatio, setAspectRatio] = useState(initialDraft.aspectRatio)
  const [resolutionPreset, setResolutionPreset] = useState(initialDraft.resolutionPreset)
  const [videoFps, setVideoFps] = useState(initialDraft.videoFps)
  const [coveragePreset, setCoveragePreset] = useState(initialDraft.coveragePreset)
  const [performancePassCount, setPerformancePassCount] = useState(initialDraft.performancePassCount)
  const [includeStoryBroll, setIncludeStoryBroll] = useState(initialDraft.includeStoryBroll)
  const [includeEnvironmentalBroll, setIncludeEnvironmentalBroll] = useState(initialDraft.includeEnvironmentalBroll)
  const [includeDetailBroll, setIncludeDetailBroll] = useState(initialDraft.includeDetailBroll)
  const [selectedShotIndex, setSelectedShotIndex] = useState(0)
  const [runtimeImageDimensions, setRuntimeImageDimensions] = useState({})
  const [advancedAudioOpen, setAdvancedAudioOpen] = useState(false)
  const [briefStatus, setBriefStatus] = useState('')
  const [parseStatus, setParseStatus] = useState('')
  const [keyframeStatus, setKeyframeStatus] = useState('')
  const [videoStatus, setVideoStatus] = useState('')
  const [timelineStatus, setTimelineStatus] = useState('')
  const [isQueuingKeyframes, setIsQueuingKeyframes] = useState(false)
  const [isQueuingVideos, setIsQueuingVideos] = useState(false)
  const [isAssemblingTimeline, setIsAssemblingTimeline] = useState(false)
  const [mediaPreview, setMediaPreview] = useState(null)
  const [peopleWizard, setPeopleWizard] = useState(null)

  const peopleWizardGenerationEnabled = Boolean(canUsePeopleWizardGeneration && BUILTIN_WORKFLOW_PATHS['z-image-turbo'] && BUILTIN_WORKFLOW_PATHS['multi-angles'])

  useEffect(() => {
    if (!draftStorageKey || typeof localStorage === 'undefined') return
    localStorage.setItem(draftStorageKey, JSON.stringify({
      step,
      aspectRatio,
      resolutionPreset,
      videoFps,
      coveragePreset,
      performancePassCount,
      includeStoryBroll,
      includeEnvironmentalBroll,
      includeDetailBroll,
    }))
  }, [
    aspectRatio,
    coveragePreset,
    includeDetailBroll,
    includeEnvironmentalBroll,
    includeStoryBroll,
    performancePassCount,
    resolutionPreset,
    step,
    videoFps,
    draftStorageKey,
  ])

  useEffect(() => {
    if (!mediaPreview) return
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setMediaPreview(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [mediaPreview])

  const closePeopleWizard = () => setPeopleWizard(null)
  const handlePeopleWizardBackdropClick = (event) => {
    if (event.target !== event.currentTarget) return
    if (!peopleWizard) return
    const confirmed = window.confirm('Discard this wizard draft and close the people dialog?')
    if (confirmed) closePeopleWizard()
  }
  const openPeopleWizard = (entry = null) => {
    const sessionId = `people-wizard-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const entryAsset = entry?.assetId ? assets.find((asset) => asset?.id === entry.assetId) || null : null
    setPeopleWizard({
      sessionId,
      mode: entry ? 'edit' : 'create',
      step: 'person',
      entryId: entry?.id || null,
      name: String(entry?.label || ''),
      slug: String(entry?.slug || ''),
      role: String(entry?.role || 'lead'),
      assetPrefix: normalizeCastSlug(entry?.slug || entry?.label || entry?.assetId || 'person') || 'person',
      assetId: entry?.assetId || '',
      imagePrompt: String(entryAsset?.name || entry?.label || 'Portrait of a character').trim() || 'Portrait of a character',
      imageSize: 'hd',
      imageOrientation: 'portrait',
      imageSeed: Math.floor(Math.random() * 1000000000),
      imageJobId: null,
      sheetJobId: null,
      sheetSeed: Math.floor(Math.random() * 1000000000),
      imageWorkflow: 'z-image-turbo',
      sheetWorkflow: 'multi-angles',
    })
  }

  useEffect(() => {
    if (audioDefaultMigratedRef.current) return
    audioDefaultMigratedRef.current = true
    if (!yoloMusicAudioAssetId && (!yoloMusicAudioKind || yoloMusicAudioKind === 'vocal_stem')) {
      setYoloMusicAudioKind('mixed_track')
    }
  }, [setYoloMusicAudioKind, yoloMusicAudioAssetId, yoloMusicAudioKind])

  const imageAssets = useMemo(
    () => assets.filter((asset) => asset?.type === 'image'),
    [assets]
  )
  const peopleWizardSelectedAsset = useMemo(() => {
    if (!peopleWizard?.assetId) return null
    return imageAssets.find((asset) => asset?.id === peopleWizard.assetId) || null
  }, [imageAssets, peopleWizard?.assetId])
  const peopleWizardGeneratedImageAsset = useMemo(() => {
    if (!peopleWizard?.sessionId) return null
    const matches = imageAssets.filter((asset) => asset?.peopleWizard?.wizardId === peopleWizard.sessionId && asset?.peopleWizard?.stage === 'image')
    return matches[0] || null
  }, [imageAssets, peopleWizard?.sessionId])
  const peopleWizardSheetAsset = useMemo(() => {
    if (!peopleWizard?.sessionId) return null
    const matches = imageAssets.filter((asset) => asset?.peopleWizard?.wizardId === peopleWizard.sessionId && asset?.peopleWizard?.stage === 'sheet')
    return matches[0] || null
  }, [imageAssets, peopleWizard?.sessionId])
  const peopleWizardActiveJob = useMemo(() => {
    if (!peopleWizard?.sessionId) return null
    const busyJobs = generationQueue.filter((job) => (
      job?.peopleWizard?.wizardId === peopleWizard.sessionId
      && job.status !== 'done'
      && job.status !== 'error'
      && job.status !== 'failed'
      && job.status !== 'cancelled'
      && job.status !== 'canceled'
    ))
    return busyJobs[busyJobs.length - 1] || null
  }, [generationQueue, peopleWizard?.sessionId])
  const flatShots = useMemo(() => flattenPlanShots(yoloActivePlan), [yoloActivePlan])
  const variantByShotKey = useMemo(() => {
    const map = new Map()
    for (const variant of yoloQueueVariants || []) {
      const key = `${variant?.sceneId || ''}|${variant?.shotId || ''}`
      if (key !== '|' && !map.has(key)) map.set(key, variant)
    }
    return map
  }, [yoloQueueVariants])
  const videoWorkflowOptions = useMemo(() => {
    const options = Array.isArray(yoloMusicVideoWorkflowOptions) && yoloMusicVideoWorkflowOptions.length > 0
      ? yoloMusicVideoWorkflowOptions
      : DEFAULT_VIDEO_WORKFLOW_OPTIONS
    return options
      .map((option) => ({
        ...option,
        id: String(option?.id || '').trim(),
        label: String(option?.label || option?.id || '').trim(),
        description: String(option?.description || '').trim(),
      }))
      .filter((option) => option.id)
  }, [yoloMusicVideoWorkflowOptions])
  const keyframeWorkflowOptions = useMemo(() => {
    const options = Array.isArray(yoloMusicKeyframeWorkflowOptions) && yoloMusicKeyframeWorkflowOptions.length > 0
      ? yoloMusicKeyframeWorkflowOptions
      : DEFAULT_KEYFRAME_WORKFLOW_OPTIONS
    return options
      .map((option) => ({
        ...option,
        id: String(option?.id || '').trim(),
        label: String(option?.label || option?.id || '').trim(),
        runtimeLabel: String(option?.runtimeLabel || '').trim(),
        description: String(option?.description || '').trim(),
      }))
      .filter((option) => option.id)
  }, [yoloMusicKeyframeWorkflowOptions])
  const selectedVideoWorkflow = useMemo(() => (
    videoWorkflowOptions.find((option) => option.id === yoloMusicVideoWorkflowId)
      || videoWorkflowOptions[0]
      || DEFAULT_VIDEO_WORKFLOW_OPTIONS[0]
  ), [videoWorkflowOptions, yoloMusicVideoWorkflowId])
  const selectedKeyframeWorkflow = useMemo(() => (
    keyframeWorkflowOptions.find((option) => option.id === yoloMusicKeyframeWorkflowId)
      || keyframeWorkflowOptions[0]
      || DEFAULT_KEYFRAME_WORKFLOW_OPTIONS[0]
  ), [keyframeWorkflowOptions, yoloMusicKeyframeWorkflowId])
  const selectedVideoWorkflowId = String(selectedVideoWorkflow?.id || '').trim()
  const selectedVideoWorkflowLabel = selectedVideoWorkflow?.label || selectedVideoWorkflowId || 'Video model'
  const selectedKeyframeWorkflowId = String(selectedKeyframeWorkflow?.id || '').trim()
  const selectedKeyframeWorkflowLabel = selectedKeyframeWorkflow?.label || selectedKeyframeWorkflowId || 'Keyframe model'
  const customKeyframeWorkflowSelected = selectedKeyframeWorkflowId === CUSTOM_MUSIC_KEYFRAME_WORKFLOW_ID
  const customVideoWorkflowSelected = selectedVideoWorkflowId === CUSTOM_MUSIC_VIDEO_WORKFLOW_ID
  const customKeyframeWorkflowLoaded = Boolean(String(yoloMusicCustomKeyframeWorkflow?.jsonText || '').trim())
  const openCustomKeyframeWorkflowLabel = customKeyframeWorkflowLoaded ? 'Open in ComfyUI' : 'Open Starter in ComfyUI'
  const customKeyframeWorkflowName = String(yoloMusicCustomKeyframeWorkflow?.name || '').trim()
  const customVideoWorkflowLoaded = Boolean(String(yoloMusicCustomVideoWorkflow?.jsonText || '').trim())
  const openCustomVideoWorkflowLabel = customVideoWorkflowLoaded ? 'Open in ComfyUI' : 'Open Starter in ComfyUI'
  const customVideoWorkflowName = String(yoloMusicCustomVideoWorkflow?.name || '').trim()
  const customKeyframeValidation = yoloMusicCustomKeyframeValidation || {
    ok: false,
    message: 'No custom workflow loaded yet.',
    missing: [],
    warnings: [],
    endpoints: {},
  }
  const customVideoValidation = yoloMusicCustomVideoValidation || {
    ok: false,
    message: 'No custom video workflow loaded yet.',
    missing: [],
    warnings: [],
    endpoints: {},
  }
  const bridgeState = String(customKeyframeBridgeStatus?.state || 'unknown').trim()
  const bridgeInstalled = Boolean(customKeyframeBridgeStatus?.installed)
  const bridgeMessage = String(
    customKeyframeBridgeStatus?.message
    || customKeyframeBridgeStatus?.error
    || 'Optional bridge lets ComfyUI send the current graph back to ComfyStudio.'
  ).trim()
  const bridgeBadge = bridgeInstalled
    ? { label: 'Installed', className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' }
    : bridgeState === 'unavailable'
      ? { label: 'Needs setup', className: 'border-amber-500/40 bg-amber-500/10 text-amber-200' }
      : bridgeState === 'not_installed'
        ? { label: 'Optional', className: 'border-sf-accent/40 bg-sf-accent/10 text-sf-accent' }
        : { label: 'Checking', className: 'border-sf-dark-500 bg-sf-dark-800 text-sf-text-secondary' }
  const canInstallBridge = typeof handleInstallYoloMusicCustomKeyframeBridge === 'function'
    && !bridgeInstalled
    && bridgeState !== 'unavailable'
  const defaultVideoWorkflowId = videoWorkflowOptions[0]?.id || MUSIC_VIDEO_SHOT_WORKFLOW_ID
  const selectedVideoWorkflowSupports1080 = workflowSupports1080Resolution(selectedVideoWorkflowId)
  const storyboardJobMap = useMemo(() => {
    const map = new Map()
    for (const job of generationQueue || []) {
      if (job?.yolo?.mode !== 'music') continue
      if (job?.yolo?.stage !== 'storyboard' || !job?.yolo?.key) continue
      map.set(job.yolo.key, job)
    }
    return map
  }, [generationQueue])
  const videoJobMap = useMemo(() => {
    const map = new Map()
    for (const job of generationQueue || []) {
      if (job?.yolo?.mode !== 'music') continue
      if (job?.yolo?.stage !== 'video') continue
      const workflowId = String(job?.yolo?.workflowId || '').trim()
      const variantKey = String(job?.yolo?.variantKey || '').trim()
      const keys = [
        job?.yolo?.key,
        variantKey && workflowId ? getVideoWorkflowScopedKey(variantKey, workflowId) : '',
        variantKey && !workflowId ? variantKey : '',
      ].filter(Boolean)
      for (const key of keys) map.set(key, job)
    }
    return map
  }, [generationQueue])
  const videoAssetMap = useMemo(() => {
    const map = new Map()
    for (const asset of assets || []) {
      if (asset?.type !== 'video') continue
      if (asset?.yolo?.mode !== 'music' || asset?.yolo?.stage !== 'video') continue
      const workflowId = String(asset?.yolo?.workflowId || '').trim()
      const variantKey = String(asset?.yolo?.variantKey || '').trim()
      const keys = [
        asset?.yolo?.key,
        variantKey && workflowId ? getVideoWorkflowScopedKey(variantKey, workflowId) : '',
        variantKey && !workflowId ? variantKey : '',
      ].filter(Boolean)
      if (keys.length === 0) continue
      const assetTime = new Date(asset.createdAt || 0).getTime()
      for (const key of keys) {
        const existing = map.get(key)
        const existingTime = existing ? new Date(existing.createdAt || 0).getTime() : -1
        if (!existing || assetTime >= existingTime) map.set(key, asset)
      }
    }
    return map
  }, [assets])
  const plannedShotCount = flatShots.length
  const queueVariantCount = Array.isArray(yoloQueueVariants) ? yoloQueueVariants.length : 0
  const videoReadyCount = useMemo(
    () => (yoloQueueVariants || []).filter((variant) => {
      if (!variant?.key) return false
      const scopedKey = getVideoWorkflowScopedKey(variant.key, selectedVideoWorkflowId)
      if (scopedKey && videoAssetMap.has(scopedKey)) return true
      return selectedVideoWorkflowId === defaultVideoWorkflowId && videoAssetMap.has(variant.key)
    }).length,
    [defaultVideoWorkflowId, selectedVideoWorkflowId, videoAssetMap, yoloQueueVariants]
  )
  const timedLineCount = Array.isArray(yoloMusicParsedLyrics?.lines) ? yoloMusicParsedLyrics.lines.length : 0
  const selectedAudioKindOption = getMusicVideoAudioKindOption(yoloMusicAudioKind) || getMusicVideoAudioKindOption('mixed_track')
  const selectedAudioModeHelper = getAudioModeHelper(selectedAudioKindOption?.id)
  const outputResolution = useMemo(
    () => resolveOutputResolution(aspectRatio, resolutionPreset),
    [aspectRatio, resolutionPreset]
  )
  const outputResolutionLabel = formatResolutionLabel(outputResolution)
  const rememberImageDimensions = useCallback((asset, imageElement) => {
    if (!asset?.id || !imageElement) return
    const width = normalizeDimension(imageElement.naturalWidth || imageElement.width)
    const height = normalizeDimension(imageElement.naturalHeight || imageElement.height)
    if (!width || !height) return
    setRuntimeImageDimensions((prev) => {
      const current = prev[asset.id]
      if (current?.width === width && current?.height === height) return prev
      return { ...prev, [asset.id]: { width, height } }
    })
  }, [])
  const coveragePlan = useMemo(() => buildCoveragePlan({
    performancePassCount,
    includeStoryBroll,
    includeEnvironmentalBroll,
    includeDetailBroll,
  }), [includeDetailBroll, includeEnvironmentalBroll, includeStoryBroll, performancePassCount])
  const coverageSummary = getCoverageSummary(coveragePlan)
  const canBuildPlan = Boolean(String(yoloMusicScript || '').trim())
  const customKeyframeReady = !customKeyframeWorkflowSelected || Boolean(customKeyframeValidation.ok)
  const customVideoReady = !customVideoWorkflowSelected || Boolean(customVideoValidation.ok)
  const canQueueKeyframes = plannedShotCount > 0 && !yoloActivePlanIsStale && customKeyframeReady
  const canQueueVideos = canQueueKeyframes && yoloStoryboardReadyCount > 0 && customVideoReady
  const keyframeStatusIsWarning = keyframeStatus.startsWith('All your keyframes')
  const singleKeyframeActionDisabled = isQueuingKeyframes || yoloDependencyCheckInProgress || !customKeyframeReady || yoloActivePlanIsStale
  const singleVideoActionDisabled = isQueuingVideos || yoloDependencyCheckInProgress || !customVideoReady
  const canOpenCustomKeyframeWorkflow = !customKeyframeWorkflowLoaded || Boolean(customKeyframeValidation.ok)
  const canOpenCustomVideoWorkflow = !customVideoWorkflowLoaded || Boolean(customVideoValidation.ok)

  useEffect(() => {
    if (selectedShotIndex >= flatShots.length) {
      setSelectedShotIndex(Math.max(0, flatShots.length - 1))
    }
  }, [flatShots.length, selectedShotIndex])

  useEffect(() => {
    const nextPreset = getResolutionFallbackForWorkflow(selectedVideoWorkflowId, resolutionPreset)
    if (nextPreset !== resolutionPreset) {
      setResolutionPreset(nextPreset)
    }
  }, [resolutionPreset, selectedVideoWorkflowId])

  useEffect(() => {
    setResolution(outputResolution)
    setImageResolution(outputResolution)
    setYoloVideoFps(Number(videoFps) || 24)
  }, [
    outputResolution,
    setImageResolution,
    setResolution,
    setYoloVideoFps,
    videoFps,
  ])

  const currentStepIndex = Math.max(0, STEPS.findIndex((entry) => entry.id === step))
  const goNext = () => {
    const nextStep = STEPS[Math.min(STEPS.length - 1, currentStepIndex + 1)]
    if (nextStep) setStep(nextStep.id)
  }
  const goBack = () => {
    const nextStep = STEPS[Math.max(0, currentStepIndex - 1)]
    if (nextStep) setStep(nextStep.id)
  }

  const isStepDisabled = (stepId) => {
    if (stepId === 'keyframes') return plannedShotCount === 0
    if (stepId === 'videos') return plannedShotCount === 0
    return false
  }

  const applyCoveragePreset = (presetId) => {
    const option = COVERAGE_PRESET_OPTIONS.find((entry) => entry.id === presetId)
    if (!option) return
    setCoveragePreset(option.id)
    setPerformancePassCount(option.performancePassCount)
    setIncludeStoryBroll(option.includeStoryBroll)
    setIncludeEnvironmentalBroll(option.includeEnvironmentalBroll)
    setIncludeDetailBroll(option.includeDetailBroll)
  }

  const updatePerformancePassCount = (nextCount) => {
    setCoveragePreset('custom')
    setPerformancePassCount(Math.max(0, Math.min(3, Number(nextCount) || 0)))
  }

  const updateStoryBroll = (enabled) => {
    setCoveragePreset('custom')
    setIncludeStoryBroll(Boolean(enabled))
  }

  const updateEnvironmentalBroll = (enabled) => {
    setCoveragePreset('custom')
    setIncludeEnvironmentalBroll(Boolean(enabled))
  }

  const updateDetailBroll = (enabled) => {
    setCoveragePreset('custom')
    setIncludeDetailBroll(Boolean(enabled))
  }

  const handleVideoWorkflowChange = (workflowId) => {
    if (!workflowId || workflowId === selectedVideoWorkflowId) return
    setResolutionPreset(getResolutionFallbackForWorkflow(workflowId, resolutionPreset))
    setYoloMusicVideoWorkflowId?.(workflowId)
    setVideoStatus('')
  }

  const handleKeyframeWorkflowChange = (workflowId) => {
    if (!workflowId || workflowId === selectedKeyframeWorkflowId) return
    setYoloMusicKeyframeWorkflowId?.(workflowId)
    setKeyframeStatus('')
  }

  const handleResolutionPresetChange = (presetId) => {
    if (!RESOLUTION_OPTIONS.some((option) => option.id === presetId)) return
    if (getResolutionFallbackForWorkflow(selectedVideoWorkflowId, presetId) !== presetId) return
    if (presetId === resolutionPreset) return
    setResolutionPreset(presetId)
    setVideoStatus('')
  }

  const getVariantForShot = (sceneId, shotId) => (
    variantByShotKey.get(`${sceneId || ''}|${shotId || ''}`) || null
  )

  const getVideoAssetForVariant = (variant, workflowId = selectedVideoWorkflowId) => {
    if (!variant?.key) return null
    const scopedKey = getVideoWorkflowScopedKey(variant.key, workflowId)
    if (scopedKey && videoAssetMap.has(scopedKey)) return videoAssetMap.get(scopedKey)
    return workflowId === defaultVideoWorkflowId ? videoAssetMap.get(variant.key) || null : null
  }

  const getKeyframeCardState = (variant, asset) => {
    if (asset) return { state: 'ready', label: 'Keyframe ready', job: null }
    const job = variant?.key ? storyboardJobMap.get(variant.key) : null
    if (job && JOB_ERROR_STATUSES.has(String(job.status || '').toLowerCase())) {
      return { state: 'error', label: 'Keyframe failed', job }
    }
    if (job && JOB_BUSY_STATUSES.has(String(job.status || '').toLowerCase())) {
      return { state: 'generating', label: 'Generating keyframe', job }
    }
    return { state: 'missing', label: 'Needs keyframe', job: null }
  }

  const getVideoJobForVariant = (variant, workflowId = selectedVideoWorkflowId) => {
    if (!variant?.key) return null
    const scopedKey = getVideoWorkflowScopedKey(variant.key, workflowId)
    if (scopedKey && videoJobMap.has(scopedKey)) return videoJobMap.get(scopedKey)
    return workflowId === defaultVideoWorkflowId ? videoJobMap.get(variant.key) || null : null
  }

  const getVideoCardState = (variant, asset) => {
    const job = getVideoJobForVariant(variant)
    if (job && JOB_BUSY_STATUSES.has(String(job.status || '').toLowerCase())) {
      return { state: 'generating', label: 'Generating video', job }
    }
    if (job && JOB_ERROR_STATUSES.has(String(job.status || '').toLowerCase()) && !asset) {
      return { state: 'error', label: 'Video failed', job }
    }
    if (asset) return { state: 'ready', label: 'Video ready', job: null }
    if (!variant) return { state: 'missing', label: 'No video variant', job: null }
    return { state: 'missing', label: 'Needs video', job: null }
  }

  const handleShotCardKeyDown = (event, index) => {
    if (event.target?.closest?.('button, input, textarea, select, a')) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setSelectedShotIndex(index)
    }
  }

  const renderPreviewButton = (onPreview) => (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onPreview()
      }}
      className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-white/20 bg-sf-dark-950/85 px-2 py-1 text-[10px] font-semibold text-white shadow-sm backdrop-blur transition-colors hover:bg-sf-dark-800 focus:outline-none focus:ring-2 focus:ring-sf-accent"
      title="Preview"
    >
      <Maximize2 className="h-3 w-3" />
      Preview
    </button>
  )

  const renderKeyframeRunButton = (row, index) => (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        void handleGenerateShotKeyframe(row, index)
      }}
      disabled={singleKeyframeActionDisabled}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-sf-accent/50 bg-sf-accent/10 px-2 py-1 text-[10px] font-semibold text-sf-accent transition-colors hover:bg-sf-accent/20 disabled:cursor-not-allowed disabled:border-sf-dark-600 disabled:bg-sf-dark-900/60 disabled:text-sf-text-muted"
      title={singleKeyframeActionDisabled ? 'Keyframes cannot be queued right now.' : 'Generate this keyframe'}
    >
      {isQueuingKeyframes && selectedShotIndex === index ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
      Run
    </button>
  )

  const renderVideoRunButton = (row, index) => (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        void handleGenerateShotVideo(row, index)
      }}
      disabled={singleVideoActionDisabled}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-sf-accent/50 bg-sf-accent/10 px-2 py-1 text-[10px] font-semibold text-sf-accent transition-colors hover:bg-sf-accent/20 disabled:cursor-not-allowed disabled:border-sf-dark-600 disabled:bg-sf-dark-900/60 disabled:text-sf-text-muted"
      title={singleVideoActionDisabled ? 'Videos cannot be queued right now.' : `Generate this video with ${selectedVideoWorkflowLabel}`}
    >
      {isQueuingVideos && selectedShotIndex === index ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
      Run
    </button>
  )

  const handleCopyShotPrompt = async (prompt, successMessage, statusSetter) => {
    const text = String(prompt || '').trim()
    if (!text) {
      statusSetter?.('No prompt found to copy for this shot.')
      return
    }
    try {
      const copied = await copyTextToClipboard(text)
      statusSetter?.(copied ? successMessage : 'Could not copy prompt. Select the text and copy it manually.')
    } catch (_) {
      statusSetter?.('Could not copy prompt. Select the text and copy it manually.')
    }
  }

  const renderCopyPromptButton = (prompt, successMessage, statusSetter) => {
    if (!String(prompt || '').trim()) return null
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          void handleCopyShotPrompt(prompt, successMessage, statusSetter)
        }}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-sf-dark-600 bg-sf-dark-900/85 px-2 py-1 text-[10px] font-semibold text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary focus:outline-none focus:ring-2 focus:ring-sf-accent"
        title="Copy prompt"
      >
        <Clipboard className="h-3 w-3" />
        Copy
      </button>
    )
  }

  const handleCopyBrief = async () => {
    setBriefStatus('')
    await handleCopyMusicVideoLlmPrompt({ coveragePlan })
    setBriefStatus('LLM brief copied.')
  }

  const handleParseScript = () => {
    setParseStatus('')
    const nextPlan = handleBuildActiveYoloPlan({
      conceptOverride: '',
      styleNotesOverride: '',
    })
    const count = flattenPlanShots(nextPlan).length
    if (count > 0) {
      setParseStatus(`Parsed ${plural(count, 'shot')}.`)
      setStep('keyframes')
    } else {
      setParseStatus('No shots were parsed yet. Check the required format.')
    }
  }

  const handleQueueKeyframes = async () => {
    setIsQueuingKeyframes(true)
    setKeyframeStatus('')
    try {
      if (queueVariantCount > 0 && yoloStoryboardReadyCount >= queueVariantCount) {
        setKeyframeStatus('All your keyframes are already created. To rerun a particular frame, use Run on a shot card or open its preview, or delete its keyframe asset first.')
        return
      }
      const queued = await handleQueueYoloStoryboards({
        sourceLabel: `Music Video Easy Mode ${selectedKeyframeWorkflowLabel} keyframe pass`,
        resolutionOverride: outputResolution,
      })
      setKeyframeStatus(queued > 0 ? `Queued ${plural(queued, `${selectedKeyframeWorkflowLabel} keyframe`)}.` : 'No keyframes were queued. Any existing shots may already be complete or running.')
    } finally {
      setIsQueuingKeyframes(false)
    }
  }

  const handleGenerateShotKeyframe = async (row, index) => {
    if (!row || singleKeyframeActionDisabled) return
    setSelectedShotIndex(index)
    setIsQueuingKeyframes(true)
    setKeyframeStatus(`Queueing ${selectedKeyframeWorkflowLabel} keyframe for Shot ${index + 1}...`)
    try {
      await handleQueueYoloShotStoryboard(row.scene.id, row.shot.id, {
        resolutionOverride: outputResolution,
      })
      setKeyframeStatus(`Queued ${selectedKeyframeWorkflowLabel} keyframe for Shot ${index + 1}.`)
    } finally {
      setIsQueuingKeyframes(false)
    }
  }

  const handleRegenerateAllKeyframes = async () => {
    if (plannedShotCount === 0) return
    setIsQueuingKeyframes(true)
    setKeyframeStatus('Queueing keyframe regeneration for all shots...')
    try {
      const queued = await handleQueueYoloStoryboards({
        allowExistingDoneKeys: true,
        sourceLabel: `Music Video Easy Mode ${selectedKeyframeWorkflowLabel} keyframe regeneration pass`,
        resolutionOverride: outputResolution,
      })
      setKeyframeStatus(queued > 0 ? `Queued ${plural(queued, `${selectedKeyframeWorkflowLabel} keyframe regeneration job`)}.` : 'No keyframe regeneration jobs were queued. Check whether those shots are already running.')
    } finally {
      setIsQueuingKeyframes(false)
    }
  }

  const handleQueueVideos = async () => {
    setIsQueuingVideos(true)
    setVideoStatus('')
    try {
      if (queueVariantCount > 0 && videoReadyCount >= queueVariantCount) {
        setVideoStatus(`All ${selectedVideoWorkflowLabel} videos are already created. To test or rerun one shot, use Run on a shot card or open its preview.`)
        return
      }
      const queued = await handleQueueYoloVideos({
        sourceLabel: `Music Video Easy Mode ${selectedVideoWorkflowLabel} video pass`,
        targetWorkflowIds: selectedVideoWorkflowId ? [selectedVideoWorkflowId] : null,
        resolutionOverride: outputResolution,
      })
      setVideoStatus(queued > 0 ? `Queued ${plural(queued, `${selectedVideoWorkflowLabel} video`)}.` : 'No videos were queued.')
    } finally {
      setIsQueuingVideos(false)
    }
  }

  const handleGenerateShotVideo = async (row, index) => {
    if (!row || singleVideoActionDisabled) return
    const variant = getVariantForShot(row.scene.id, row.shot.id)
    if (!variant) {
      setVideoStatus(`No video variant found for Shot ${index + 1}. Parse the script again first.`)
      return
    }
    if (!yoloStoryboardAssetMap?.has(variant.key)) {
      setVideoStatus(`Shot ${index + 1} needs a keyframe before video can run.`)
      return
    }
    setSelectedShotIndex(index)
    setIsQueuingVideos(true)
    setVideoStatus(`Queueing ${selectedVideoWorkflowLabel} video rerun for Shot ${index + 1}...`)
    try {
      await handleQueueYoloShotVideo?.(row.scene.id, row.shot.id, {
        targetWorkflowIds: selectedVideoWorkflowId ? [selectedVideoWorkflowId] : null,
        resolutionOverride: outputResolution,
      })
      setVideoStatus(`Queued ${selectedVideoWorkflowLabel} video rerun for Shot ${index + 1}.`)
    } finally {
      setIsQueuingVideos(false)
    }
  }

  const handleRegenerateAllVideos = async () => {
    if (plannedShotCount === 0) return
    setIsQueuingVideos(true)
    setVideoStatus(`Queueing ${selectedVideoWorkflowLabel} video regeneration for all shots...`)
    try {
      const queued = await handleQueueYoloVideos({
        allowExistingDoneKeys: true,
        skipConfirm: true,
        sourceLabel: `Music Video Easy Mode ${selectedVideoWorkflowLabel} video regeneration pass`,
        targetWorkflowIds: selectedVideoWorkflowId ? [selectedVideoWorkflowId] : null,
        resolutionOverride: outputResolution,
      })
      setVideoStatus(queued > 0 ? `Queued ${plural(queued, `${selectedVideoWorkflowLabel} video regeneration job`)}.` : 'No video regeneration jobs were queued. Check whether those shots are already running.')
    } finally {
      setIsQueuingVideos(false)
    }
  }

  const handleAssembleTimeline = async () => {
    if (!handleAssembleMusicVideoTimeline) return
    setIsAssemblingTimeline(true)
    setTimelineStatus('')
    try {
      const result = await handleAssembleMusicVideoTimeline()
      setTimelineStatus(result?.message || 'Timeline assembled.')
    } catch (error) {
      setTimelineStatus(`Could not assemble timeline: ${error?.message || 'Unknown error'}`)
    } finally {
      setIsAssemblingTimeline(false)
    }
  }

  const updatePeopleWizard = (updater) => {
    setPeopleWizard((prev) => {
      if (!prev) return prev
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater }
      return next
    })
  }

  const handleOpenPeopleWizard = (entry = null) => {
    openPeopleWizard(entry)
  }

  const handlePeopleWizardFieldChange = (field, value) => {
    updatePeopleWizard({ [field]: value })
  }

  const handlePeopleWizardSelectAsset = (assetId) => {
    updatePeopleWizard({
      assetId: assetId || '',
      step: 'image',
    })
  }

  const handlePeopleWizardCreateImage = () => {
    if (!peopleWizardGenerationEnabled) return
    if (!queuePeopleWizardJob) return
    const prompt = String(peopleWizard?.imagePrompt || '').trim() || `${peopleWizard?.name || 'Character'} portrait`
    const resolution = resolvePeopleWizardImageResolution(peopleWizard?.imageSize, peopleWizard?.imageOrientation)
    const job = queuePeopleWizardJob({
      workflowId: 'z-image-turbo',
      workflowLabel: 'Z Image Turbo',
      prompt,
      seed: peopleWizard?.imageSeed,
      resolution,
      needsImage: false,
      peopleWizard: {
        wizardId: peopleWizard?.sessionId,
        stage: 'image',
        entryId: peopleWizard?.entryId || null,
        mode: peopleWizard?.mode || 'create',
        assetPrefix: normalizeCastSlug(peopleWizard?.assetPrefix || peopleWizard?.slug || peopleWizard?.name || 'person') || 'person',
        imageSize: peopleWizard?.imageSize || 'hd',
        imageOrientation: peopleWizard?.imageOrientation || 'portrait',
      },
    })
    updatePeopleWizard({
      step: 'image',
      imageJobId: job.id,
    })
  }

  const handlePeopleWizardCreateSheet = () => {
    if (!peopleWizardGenerationEnabled) return
    if (!queuePeopleWizardJob) return
    const baseAsset = peopleWizardGeneratedImageAsset || peopleWizardSelectedAsset || null
    const baseAssetId = baseAsset?.id || peopleWizard?.assetId || ''
    if (!baseAssetId) return
    const prompt = `${peopleWizard?.name || 'Character'} character sheet with front, side, 3/4, expressions, and wardrobe consistency.`
    const inheritedAssetPrefix = inferPeopleWizardAssetPrefix(
      baseAsset,
      peopleWizard?.assetPrefix || peopleWizard?.slug || peopleWizard?.name || 'person'
    ) || 'person'
    const job = queuePeopleWizardJob({
      workflowId: 'multi-angles',
      workflowLabel: 'Multiple Angles (Characters)',
      prompt,
      seed: peopleWizard?.sheetSeed,
      needsImage: true,
      inputAssetId: baseAssetId,
      peopleWizard: {
        wizardId: peopleWizard?.sessionId,
        stage: 'sheet',
        entryId: peopleWizard?.entryId || null,
        mode: peopleWizard?.mode || 'create',
        baseAssetId,
        autoCreateAngleSheet: true,
        assetPrefix: inheritedAssetPrefix,
      },
    })
    updatePeopleWizard({
      step: 'sheet',
      sheetJobId: job.id,
    })
  }

  const handlePeopleWizardSave = () => {
    if (!peopleWizard) return
    const trimmedName = String(peopleWizard.name || '').trim()
    const normalizedSlug = normalizeCastSlug(String(peopleWizard.slug || '').trim())
    const finalAssetId = peopleWizard.step === 'sheet'
      ? peopleWizardSheetAsset?.id || ''
      : peopleWizard.step === 'image'
        ? peopleWizardGeneratedImageAsset?.id || ''
      : peopleWizardSelectedAsset?.id || peopleWizardSheetAsset?.id || peopleWizardGeneratedImageAsset?.id || ''
    if (!trimmedName || !normalizedSlug || !finalAssetId) return
    const nextEntry = {
      id: peopleWizard.entryId || `cast-${Date.now()}`,
      label: trimmedName,
      slug: normalizedSlug,
      assetId: finalAssetId,
      role: String(peopleWizard.role || 'lead'),
    }
    setYoloMusicCast((prev) => {
      const list = Array.isArray(prev) ? [...prev] : []
      const index = list.findIndex((entry) => entry?.id === nextEntry.id)
      if (index >= 0) {
        list[index] = nextEntry
      } else {
        list.push(nextEntry)
      }
      return list
    })
    closePeopleWizard()
  }

  const renderStepHeader = (title, helper) => (
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div>
        <h3 className="text-lg font-semibold text-sf-text-primary">{title}</h3>
        {helper && <p className="mt-1 max-w-3xl text-xs leading-5 text-sf-text-secondary">{helper}</p>}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={goBack}
          disabled={currentStepIndex === 0}
          className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          Back
        </button>
        <button
          type="button"
          onClick={goNext}
          disabled={currentStepIndex === STEPS.length - 1}
          className="rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          Next
        </button>
      </div>
    </div>
  )

  const renderSongStep = () => (
    <div className="space-y-4">
      {renderStepHeader(
        'Choose the song source.',
        'Import your song or vocal stem in the Assets panel first, then select it here. Advanced audio modes are available when needed.'
      )}

      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <FieldLabel>Output Settings</FieldLabel>
            <div className="mt-1 text-sm font-semibold text-sf-text-primary">
              {outputResolutionLabel} / {videoFps} fps
            </div>
            <p className="mt-1 text-xs leading-5 text-sf-text-secondary">
              These settings apply to both keyframes and videos.
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <div>
            <FieldLabel>Aspect Ratio</FieldLabel>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {ASPECT_RATIO_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  title={option.helper}
                  onClick={() => setAspectRatio(option.id)}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${buttonClass(aspectRatio === option.id)}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <FieldLabel>Resolution</FieldLabel>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {RESOLUTION_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => handleResolutionPresetChange(option.id)}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${buttonClass(resolutionPreset === option.id)}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <FieldLabel>Frames Per Second</FieldLabel>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {FPS_OPTIONS.map((fpsOption) => (
                <button
                  key={fpsOption}
                  type="button"
                  onClick={() => setVideoFps(fpsOption)}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${buttonClass(videoFps === fpsOption)}`}
                >
                  {fpsOption} fps
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <FieldLabel>Audio Mode</FieldLabel>
            <div className="mt-1 flex items-center gap-2 text-sm font-semibold text-sf-text-primary">
              <Music className="h-4 w-4 text-sf-accent" />
              {selectedAudioKindOption?.label || 'Finished song (full mix)'}
            </div>
            <p className="mt-2 max-w-3xl text-xs leading-5 text-sf-text-secondary">
              {selectedAudioModeHelper}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAdvancedAudioOpen((open) => !open)}
            className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
          >
            {advancedAudioOpen ? 'Hide Advanced' : 'Advanced Audio'}
          </button>
        </div>
        {advancedAudioOpen && (
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {MUSIC_VIDEO_AUDIO_KIND_OPTIONS.map((option) => {
              const selected = yoloMusicAudioKind === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setYoloMusicAudioKind(option.id)}
                  className={`rounded-lg border p-3 text-left transition-colors ${buttonClass(selected)}`}
                >
                  <div className="flex items-center gap-2">
                    <Music className="h-4 w-4 text-sf-accent" />
                    <span className="text-sm font-semibold">{option.label}</span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-sf-text-muted">{option.description}</p>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.75fr)]">
        <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-4">
          <div>
            <FieldLabel>Song Audio</FieldLabel>
            <div className="mt-1 text-sm font-semibold text-sf-text-primary">
              {yoloMusicAudioAsset?.name || 'Select audio from Assets panel'}
            </div>
            <p className="mt-1 text-xs leading-5 text-sf-text-secondary">
              Add audio in the Assets panel, then pick it from the list below.
            </p>
          </div>

          <div className="mt-4">
            <FieldLabel>Choose Existing Audio</FieldLabel>
            <select
              value={yoloMusicAudioAssetId || ''}
              onChange={(event) => setYoloMusicAudioAssetId(event.target.value || null)}
              className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
            >
              <option value="">Select audio from this project</option>
              {yoloMusicAudioAssets.map((asset) => (
                <option key={asset.id} value={asset.id}>{asset.name || asset.id}</option>
              ))}
            </select>
            {yoloMusicAudioAssets.length === 0 && (
              <p className="mt-2 text-xs text-sf-text-muted">No audio assets in this project yet. Import song audio in Assets first.</p>
            )}
          </div>

          <div className="mt-4 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3">
            <div className="text-xs font-semibold text-amber-200">Preparing lyric timing might take a moment.</div>
            <p className="mt-1 text-xs leading-5 text-sf-text-secondary">
              Wait for this step to finish before copying the LLM brief so the script uses the real song timings.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-4">
          <FieldLabel>Lyrics Timing</FieldLabel>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleYoloMusicTranscribeSrt}
              disabled={!yoloMusicAudioAsset || yoloMusicTranscribingSrt}
              className="inline-flex items-center gap-2 rounded-lg border border-sf-accent/50 bg-sf-accent/10 px-3 py-2 text-xs font-semibold text-sf-accent transition-colors hover:bg-sf-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {yoloMusicTranscribingSrt ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              {yoloMusicTranscribingSrt ? 'Preparing' : 'Prepare Timing'}
            </button>
            {timedLineCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-200">
                <CheckCircle2 className="h-3 w-3" />
                {plural(timedLineCount, 'timed line')}
              </span>
            )}
          </div>
          {(yoloMusicTranscribingSrt || yoloMusicTranscriptionStatus) && (
            <div className="mt-2 text-xs text-sf-text-secondary">
              {yoloMusicTranscriptionStatus || 'Preparing lyrics timing. This might take a moment.'}
            </div>
          )}
          <textarea
            value={yoloMusicLyrics}
            onChange={(event) => setYoloMusicLyrics(event.target.value)}
            placeholder="Paste lyrics, SRT, or LRC timing here."
            className="mt-3 min-h-[220px] w-full resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 font-mono text-xs leading-5 text-sf-text-primary outline-none focus:border-sf-accent"
          />
        </div>
      </div>
    </div>
  )

  const renderPeopleWizardModal = () => {
    if (!peopleWizard) return null

    const wizardStep = peopleWizard.step || 'person'
    const trimmedName = String(peopleWizard.name || '').trim()
    const normalizedSlug = normalizeCastSlug(String(peopleWizard.slug || '').trim())
    const selectedPreviewAsset = wizardStep === 'sheet'
      ? peopleWizardSheetAsset || peopleWizardGeneratedImageAsset || peopleWizardSelectedAsset || null
      : wizardStep === 'image'
        ? peopleWizardGeneratedImageAsset || peopleWizardSelectedAsset || null
        : peopleWizardSelectedAsset || null
    const peopleWizardSaveAssetId = wizardStep === 'sheet'
      ? peopleWizardSheetAsset?.id || ''
      : wizardStep === 'image'
        ? peopleWizardGeneratedImageAsset?.id || peopleWizardSelectedAsset?.id || ''
        : ''
    const canContinueToImageStep = Boolean(trimmedName && normalizedSlug)
    const canEnterSheetStep = Boolean(peopleWizardGeneratedImageAsset || peopleWizardSelectedAsset)
    const canSavePeopleWizard = Boolean(trimmedName && normalizedSlug && peopleWizardSaveAssetId && !peopleWizardActiveJob)
    const previewTitle = selectedPreviewAsset?.name || 'Preview'
    const wizardStages = [
      { id: 'person', label: '1', title: 'Person data', helper: 'Name, slug, and role.' },
      { id: 'image', label: '2', title: 'Image', helper: 'Create or pick a portrait.', disabled: !canContinueToImageStep },
      { id: 'sheet', label: '3', title: 'Character sheet', helper: 'Generate the full sheet.', disabled: !canEnterSheetStep },
    ]
    const previewJob = peopleWizardActiveJob
      && (
        peopleWizardActiveJob.workflowId === 'z-image-turbo'
        || peopleWizardActiveJob.workflowId === 'multi-angles'
      )
      ? peopleWizardActiveJob
      : null
    const previewJobProgress = Math.min(100, Math.max(0, Number(previewJob?.progress) || 0))
    const statusText = previewJob
      ? `${getWorkflowDisplayLabel(previewJob.workflowId)} is ${previewJob.status || 'running'}...`
      : ''
    const wizardPrimaryAction = wizardStep === 'person'
      ? {
          label: 'Continue to image step',
          onClick: () => updatePeopleWizard({ step: 'image' }),
          disabled: !canContinueToImageStep,
        }
      : wizardStep === 'image'
        ? {
            label: 'Continue to character sheet',
            onClick: () => updatePeopleWizard({ step: 'sheet' }),
            disabled: !canEnterSheetStep,
          }
        : {
            label: peopleWizardActiveJob ? 'Generating…' : 'Save',
            onClick: handlePeopleWizardSave,
            disabled: !canSavePeopleWizard,
          }

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3">
        <button
          type="button"
          aria-label="Close people wizard overlay"
          className="absolute inset-0 bg-black/70"
          onClick={handlePeopleWizardBackdropClick}
        />
        <div className="relative z-10 flex max-h-[calc(100vh-6rem)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-sf-dark-700 bg-sf-dark-950 shadow-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-sf-dark-700 px-4 py-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-sf-accent">People Wizard</div>
              <h3 className="text-base font-semibold text-sf-text-primary">
                {peopleWizard.mode === 'edit' ? 'Edit person' : 'Add person'}
              </h3>
            </div>
            <button
              type="button"
              onClick={closePeopleWizard}
              className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
            >
              Close
            </button>
          </div>

          <div className="grid min-h-0 flex-1 overflow-hidden lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)]">
            <div className="space-y-4 overflow-y-auto p-4">
              <div className="rounded-2xl border border-sf-dark-700 bg-sf-dark-900/70 p-3">
                <div className="grid gap-2 md:grid-cols-3">
                  {wizardStages.map((stage, index) => {
                    const active = wizardStep === stage.id
                    const disabled = Boolean(stage.disabled)
                    return (
                      <button
                        key={stage.id}
                        type="button"
                        onClick={() => {
                          if (disabled) return
                          updatePeopleWizard({ step: stage.id })
                        }}
                        disabled={disabled}
                        className={`rounded-xl border px-3 py-3 text-left transition-all duration-300 ease-out ${
                          active
                            ? 'border-sf-accent bg-sf-accent/20 shadow-[0_0_0_1px_rgba(96,165,250,0.25)]'
                            : disabled
                              ? 'border-sf-dark-800 bg-black/70 text-sf-text-muted'
                              : 'border-sf-accent/30 bg-sf-accent/8 text-sf-text-primary hover:-translate-y-0.5 hover:border-sf-accent/50 hover:bg-sf-accent/12'
                        } ${disabled ? 'cursor-not-allowed' : ''}`}
                      >
                        <div className="flex items-center gap-2">
                          <div className={`flex h-6 w-6 items-center justify-center rounded-full border text-[10px] font-semibold ${
                            active
                              ? 'border-sf-accent bg-sf-accent text-white'
                              : disabled
                                ? 'border-sf-dark-700 bg-black/80 text-sf-text-muted'
                                : 'border-sf-accent/40 bg-sf-accent/15 text-sf-text-primary'
                          }`}>
                            {index + 1}
                          </div>
                          <div className="min-w-0">
                            <div className={`text-xs font-semibold ${disabled ? 'text-sf-text-muted' : 'text-sf-text-primary'}`}>{stage.title}</div>
                            <div className={`text-[10px] ${disabled ? 'text-sf-text-muted/80' : 'text-sf-text-muted'}`}>{stage.helper}</div>
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>

              {wizardStep === 'person' && (
                <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/70 p-4 space-y-3">
                  <div className="text-sm font-semibold text-sf-text-primary">1. Person data</div>
                  <p className="text-xs text-sf-text-secondary">
                    Start with the name, slug, and role. Then move to the image step to either create a portrait or select one you already have.
                  </p>
                  <div className="grid gap-3 md:grid-cols-3">
                    <div>
                      <FieldLabel>Name *</FieldLabel>
                      <input
                        type="text"
                        value={peopleWizard.name}
                        required
                        onChange={(event) => handlePeopleWizardFieldChange('name', event.target.value)}
                        className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                        placeholder="Ava"
                      />
                    </div>
                    <div>
                      <FieldLabel>Slug *</FieldLabel>
                      <input
                        type="text"
                        value={peopleWizard.slug}
                        required
                        onChange={(event) => handlePeopleWizardFieldChange('slug', event.target.value)}
                        className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 font-mono text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                        placeholder="ava"
                      />
                    </div>
                    <div>
                      <FieldLabel>Role</FieldLabel>
                      <select
                        value={peopleWizard.role}
                        onChange={(event) => handlePeopleWizardFieldChange('role', event.target.value)}
                        className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                      >
                        {MUSIC_VIDEO_CAST_ROLE_OPTIONS.map((role) => (
                          <option key={role.id} value={role.id}>{role.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="max-w-md">
                    <FieldLabel>Asset Prefix</FieldLabel>
                    <input
                      type="text"
                      value={peopleWizard.assetPrefix}
                      onChange={(event) => handlePeopleWizardFieldChange('assetPrefix', normalizeCastSlug(event.target.value) || '')}
                      className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 font-mono text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                      placeholder="ava_headshot"
                    />
                    <p className="mt-1 text-[10px] text-sf-text-muted">
                      Used for the generated image and sheet file names.
                    </p>
                  </div>
                </div>
              )}

              {wizardStep === 'image' && (
                <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/70 p-4 space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-sf-text-primary">2. Image selection / creation</div>
                      <p className="mt-1 text-xs text-sf-text-secondary">
                        Choose an existing portrait or create a new one. Once an image is selected, you can continue to the sheet step.
                      </p>
                    </div>
                    <div className="text-[10px] text-sf-text-muted">
                      {canUsePeopleWizardGeneration ? 'Portrait generation enabled' : 'Portrait generation unavailable'}
                    </div>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-950/60 p-3 space-y-3">
                      <div className="flex items-center gap-2 text-sm font-semibold text-sf-text-primary">
                        <ImageIcon className="h-4 w-4 text-sf-accent" />
                        Select existing image
                      </div>
                      <select
                        value={peopleWizard.assetId || ''}
                        onChange={(event) => handlePeopleWizardSelectAsset(event.target.value || '')}
                        className="w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                      >
                        <option value="">Select image asset</option>
                        {imageAssets.map((asset) => (
                          <option key={asset.id} value={asset.id}>{asset.name || asset.id}</option>
                        ))}
                      </select>
                      <div className="text-[11px] text-sf-text-muted">
                        {peopleWizardSelectedAsset ? `Selected: ${peopleWizardSelectedAsset.name || peopleWizardSelectedAsset.id}` : 'Pick a portrait from the project.'}
                      </div>
                    </div>

                    <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-950/60 p-3 space-y-3">
                      <div className="flex items-center gap-2 text-sm font-semibold text-sf-text-primary">
                        <Wand2 className="h-4 w-4 text-sf-accent" />
                        Create new image
                      </div>
                      <div>
                        <FieldLabel>Prompt</FieldLabel>
                        <textarea
                          value={peopleWizard.imagePrompt}
                          onChange={(event) => handlePeopleWizardFieldChange('imagePrompt', event.target.value)}
                          rows={4}
                          className="mt-1 w-full resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                          placeholder="Describe the character portrait."
                        />
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div>
                          <FieldLabel>Image Size</FieldLabel>
                          <div className="mt-2 inline-flex rounded-xl border border-sf-dark-700 bg-sf-dark-950/60 p-1">
                            {PEOPLE_WIZARD_IMAGE_SIZE_OPTIONS.map((option) => (
                              <button
                                key={option.id}
                                type="button"
                                onClick={() => handlePeopleWizardFieldChange('imageSize', option.id)}
                                title={`${option.label} image size`}
                                aria-label={`${option.label} image size`}
                                className={`inline-flex h-10 min-w-[3.25rem] items-center justify-center rounded-lg border px-3 text-xs font-semibold transition-colors ${buttonClass(peopleWizard.imageSize === option.id)}`}
                              >
                                <span>{option.label}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <FieldLabel>Orientation</FieldLabel>
                          <div className="mt-2 inline-flex rounded-xl border border-sf-dark-700 bg-sf-dark-950/60 p-1">
                            {PEOPLE_WIZARD_IMAGE_ORIENTATION_OPTIONS.map((option) => (
                              <button
                                key={option.id}
                                type="button"
                                onClick={() => handlePeopleWizardFieldChange('imageOrientation', option.id)}
                                title={`${option.label} orientation`}
                                aria-label={`${option.label} orientation`}
                                className={`inline-flex h-10 w-10 items-center justify-center rounded-lg border text-xs font-semibold transition-all duration-300 ease-out ${buttonClass(peopleWizard.imageOrientation === option.id)}`}
                              >
                                <span
                                  className={`flex items-center justify-center rounded-sm border ${
                                    option.id === 'portrait'
                                      ? 'h-5 w-4'
                                      : 'h-4 w-6'
                                  } ${
                                    peopleWizard.imageOrientation === option.id
                                      ? 'border-white/80 bg-white/15'
                                      : 'border-current/60 bg-current/10'
                                  }`}
                                  aria-hidden="true"
                                />
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 p-3 text-[11px] text-sf-text-secondary">
                        <span className="text-sf-text-muted">Canvas:</span> {formatResolutionLabel(resolvePeopleWizardImageResolution(peopleWizard.imageSize, peopleWizard.imageOrientation))}
                      </div>
                      <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                        <div>
                          <FieldLabel>Seed</FieldLabel>
                          <input
                            type="number"
                            value={peopleWizard.imageSeed}
                            onChange={(event) => handlePeopleWizardFieldChange('imageSeed', Number(event.target.value))}
                            className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                          />
                        </div>
                        <div className="flex items-end">
                          <button
                            type="button"
                            onClick={() => handlePeopleWizardFieldChange('imageSeed', Math.floor(Math.random() * 1000000000))}
                            className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
                          >
                            Randomize
                          </button>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => updatePeopleWizard({ step: 'person' })}
                          className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
                        >
                          Back
                        </button>
                        <button
                          type="button"
                          onClick={handlePeopleWizardCreateImage}
                          disabled={!peopleWizardGenerationEnabled || Boolean(peopleWizardActiveJob)}
                          className="rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {peopleWizardActiveJob && peopleWizardActiveJob.workflowId === 'z-image-turbo' ? 'Generating…' : 'Generate image'}
                        </button>
                      </div>
                    </div>
                  </div>

                </div>
              )}

              {wizardStep === 'sheet' && (
                <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/70 p-4 space-y-3">
                  <div>
                    <div className="text-sm font-semibold text-sf-text-primary">3. Character sheet creation</div>
                    <p className="mt-1 text-xs text-sf-text-secondary">
                      Use the selected or generated image as the reference, then turn it into a multi-angle character sheet.
                    </p>
                  </div>
                  <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 p-3 text-xs text-sf-text-secondary">
                    <div><span className="text-sf-text-muted">Reference:</span> {peopleWizardGeneratedImageAsset?.name || peopleWizardSelectedAsset?.name || 'No reference selected yet'}</div>
                    <div><span className="text-sf-text-muted">Sheet workflow:</span> Multiple Angles (Characters)</div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                    <div>
                      <FieldLabel>Seed</FieldLabel>
                      <input
                        type="number"
                        value={peopleWizard.sheetSeed}
                        onChange={(event) => handlePeopleWizardFieldChange('sheetSeed', Number(event.target.value))}
                        className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                      />
                    </div>
                    <div className="flex items-end">
                      <button
                        type="button"
                        onClick={() => handlePeopleWizardFieldChange('sheetSeed', Math.floor(Math.random() * 1000000000))}
                        className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
                      >
                        Randomize
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handlePeopleWizardCreateSheet}
                      disabled={!peopleWizardGenerationEnabled || Boolean(peopleWizardActiveJob) || !canEnterSheetStep}
                      className="rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {peopleWizardActiveJob && peopleWizardActiveJob.workflowId === 'multi-angles' ? 'Generating…' : 'Generate sheet'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-sf-dark-700 bg-sf-dark-900/70 p-4 lg:border-l lg:border-t-0">
              <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-950/60 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.14em] text-sf-text-muted">Preview</div>
                    <div className="text-sm font-semibold text-sf-text-primary">
                      {previewTitle}
                    </div>
                  </div>
                </div>
                <div className="mt-3 aspect-[4/5] overflow-hidden rounded-lg border border-sf-dark-700 bg-sf-dark-950">
                  {selectedPreviewAsset?.url ? (
                    <img
                      src={selectedPreviewAsset.url}
                      alt={selectedPreviewAsset.name || 'People wizard preview'}
                      className="h-full w-full object-contain"
                    />
                  ) : null}
                </div>
                {statusText && (
                  <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-900/80 p-3">
                    <div className="flex items-center justify-between gap-3 text-[11px] text-sf-text-secondary">
                      <span>{statusText}</span>
                      <span className="font-mono text-sf-text-muted">{Math.round(previewJobProgress)}%</span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-sf-dark-800">
                      <div
                        className="h-full rounded-full bg-sf-accent transition-all duration-300 ease-out"
                        style={{ width: `${previewJobProgress}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-3 space-y-2 rounded-xl border border-sf-dark-700 bg-sf-dark-950/60 p-3 text-xs text-sf-text-secondary">
                <div><span className="text-sf-text-muted">Mode:</span> {peopleWizard.mode === 'edit' ? 'Edit existing person' : 'Create person'}</div>
                <div><span className="text-sf-text-muted">Name:</span> {peopleWizard.name || 'Untitled'}</div>
                <div><span className="text-sf-text-muted">Slug:</span> {peopleWizard.slug || 'unset'}</div>
                <div><span className="text-sf-text-muted">Role:</span> {peopleWizard.role || 'lead'}</div>
                <div><span className="text-sf-text-muted">Path:</span> {wizardStep}</div>
              </div>
            </div>
          </div>
          <div className="border-t border-sf-dark-700 bg-sf-dark-950 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={closePeopleWizard}
                  className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={wizardPrimaryAction.onClick}
                  disabled={wizardPrimaryAction.disabled}
                  className={`rounded-lg px-3 py-2 text-xs font-semibold text-white transition-all duration-300 ease-out ${
                    wizardStep === 'sheet'
                      ? 'bg-sf-accent hover:bg-sf-accent/90 disabled:opacity-50'
                      : wizardPrimaryAction.disabled
                        ? 'cursor-not-allowed border border-sf-dark-800 bg-black/70 text-sf-text-muted'
                        : 'bg-sf-accent/90 hover:bg-sf-accent'
                  }`}
                >
                  {wizardPrimaryAction.label}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const renderPeopleStep = () => (
    <div className="space-y-4">
      {renderStepHeader(
        'Define who appears on camera.',
        'Add reference images for artists, band members, or performers so the script can route shots by Artist fields.'
      )}

      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <FieldLabel>Cast References</FieldLabel>
            <div className="mt-1 text-sm font-semibold text-sf-text-primary">
              {plural(yoloMusicResolvedCast.length, 'resolved person', 'resolved people')}
            </div>
          </div>
          <button
            type="button"
            onClick={() => handleOpenPeopleWizard(null)}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90"
          >
            <UserPlus className="h-4 w-4" />
            Add Person
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {(yoloMusicCast || []).length === 0 && (
            <div className="rounded-lg border border-dashed border-sf-dark-600 px-3 py-6 text-center text-xs text-sf-text-muted">
              Add at least one person if the video has lip-sync performance shots.
            </div>
          )}
          {(yoloMusicCast || []).map((entry, index) => {
            const entryAsset = imageAssets.find((asset) => asset?.id === entry?.assetId) || null
            return (
              <div key={entry.id || index} className="grid gap-2 rounded-lg border border-sf-dark-700 bg-sf-dark-950/50 p-3 lg:grid-cols-[1fr_1fr_1fr_auto_auto]">
                <div>
                  <FieldLabel>Name</FieldLabel>
                  <input
                    type="text"
                    value={entry?.label || ''}
                    onChange={(event) => handleYoloMusicCastLabelChange(entry.id, event.target.value)}
                    placeholder="Ava"
                    className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                  />
                </div>
                <div>
                  <FieldLabel>Script Slug</FieldLabel>
                  <input
                    type="text"
                    value={entry?.slug || ''}
                    onChange={(event) => handleYoloMusicCastSlugChange(entry.id, event.target.value)}
                    placeholder="ava"
                    className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 font-mono text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                  />
                </div>
                <div>
                  <FieldLabel>Reference</FieldLabel>
                  <div className="mt-1 rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary">
                    {entryAsset?.name || 'No reference image'}
                  </div>
                </div>
                <div className="flex items-end gap-2">
                  <select
                    value={entry?.role || 'lead'}
                    onChange={(event) => handleYoloMusicCastRoleChange(entry.id, event.target.value)}
                    className="w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                  >
                    {MUSIC_VIDEO_CAST_ROLE_OPTIONS.map((role) => (
                      <option key={role.id} value={role.id}>{role.label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-end gap-2">
                  <button
                    type="button"
                    onClick={() => handleOpenPeopleWizard(entry)}
                    className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-muted transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
                    title="Edit person"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleYoloMusicCastRemove(entry.id)}
                    className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-muted transition-colors hover:border-red-400/60 hover:text-red-200"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {renderPeopleWizardModal()}
    </div>
  )

  const renderScriptStep = () => (
    <div className="space-y-4">
      {renderStepHeader(
        'Create the director script.',
        'Copy a ready-made LLM brief with timing, cast, and format rules, then paste the returned script here.'
      )}
      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <FieldLabel>Coverage Plan</FieldLabel>
            <div className="mt-1 text-sm font-semibold text-sf-text-primary">
              {plural(coveragePlan.sections.length, 'section')}: {coverageSummary}
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-sf-text-secondary">
              The LLM brief will return one combined director script with labeled coverage sections. B-roll sections are guided to share one start-middle-end story, with environment and detail shots supporting the same arc.
            </p>
          </div>
          {coveragePreset === 'custom' && (
            <span className="rounded-full border border-sf-accent/40 bg-sf-accent/10 px-2 py-1 text-[10px] font-semibold uppercase text-sf-accent">
              Custom
            </span>
          )}
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-3">
          {COVERAGE_PRESET_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => applyCoveragePreset(option.id)}
              className={`rounded-lg border p-3 text-left transition-colors ${buttonClass(coveragePreset === option.id)}`}
            >
              <div className="text-sm font-semibold">{option.label}</div>
              <p className="mt-1 text-xs leading-5 text-sf-text-muted">{option.helper}</p>
            </button>
          ))}
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto_auto] lg:items-end">
          <div>
            <FieldLabel>Performance Passes</FieldLabel>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {PERFORMANCE_PASS_OPTIONS.map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => updatePerformancePassCount(count)}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${buttonClass(performancePassCount === count)}`}
                >
                  {count}
                </button>
              ))}
            </div>
          </div>
          <label className={`flex min-h-[38px] items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${buttonClass(includeStoryBroll)}`}>
            <input
              type="checkbox"
              checked={includeStoryBroll}
              onChange={(event) => updateStoryBroll(event.target.checked)}
              className="h-4 w-4 accent-sf-accent"
            />
            Story b-roll
          </label>
          <label className={`flex min-h-[38px] items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${buttonClass(includeEnvironmentalBroll)}`}>
            <input
              type="checkbox"
              checked={includeEnvironmentalBroll}
              onChange={(event) => updateEnvironmentalBroll(event.target.checked)}
              className="h-4 w-4 accent-sf-accent"
            />
            Environmental
          </label>
          <label className={`flex min-h-[38px] items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${buttonClass(includeDetailBroll)}`}>
            <input
              type="checkbox"
              checked={includeDetailBroll}
              onChange={(event) => updateDetailBroll(event.target.checked)}
              className="h-4 w-4 accent-sf-accent"
            />
            Detail inserts
          </label>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-sf-text-primary">
                <Clipboard className="h-4 w-4 text-sf-accent" />
                Copy LLM brief
              </div>
              <p className="mt-1 text-xs leading-5 text-sf-text-secondary">
                The brief includes song timing, cast slugs, required script format, b-roll story guidance, camera motion, character movement, and emotion cues.
              </p>
            </div>
            <button
              type="button"
              onClick={handleCopyBrief}
              className="rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90"
            >
              Copy Brief
            </button>
          </div>
          <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
            <div className="text-xs font-semibold text-emerald-200">
              {timedLineCount > 0 ? 'SRT timing included' : 'Timing not ready yet'}
            </div>
            <p className="mt-1 text-xs leading-5 text-sf-text-secondary">
              {timedLineCount > 0
                ? `The brief can reference ${plural(timedLineCount, 'timed lyric line')}.`
                : 'Prepare timing in Step 1 before you ask for a timing-accurate script.'}
            </p>
          </div>
          <div className="mt-4 rounded-lg border border-sf-dark-700 bg-sf-dark-950/70 p-3 text-xs leading-5 text-sf-text-secondary">
            <div><span className="text-sf-text-muted">Audio:</span> {getMusicVideoAudioKindOption(yoloMusicAudioKind)?.label || 'Not selected'}</div>
            <div><span className="text-sf-text-muted">Cast:</span> {yoloMusicResolvedCast.length > 0 ? yoloMusicResolvedCast.map((entry) => entry.slug || entry.label).join(', ') : 'No resolved cast yet'}</div>
          </div>
          {briefStatus && <div className="mt-3 text-xs text-emerald-200">{briefStatus}</div>}
        </div>

        <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-sf-text-primary">
                <FileText className="h-4 w-4 text-sf-accent" />
                Paste director script
              </div>
              <p className="mt-1 text-xs leading-5 text-sf-text-secondary">
                This script becomes the plan. Shot type, start time, keyframe prompt, and motion prompt drive the next steps.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                if (!yoloMusicScript.trim() || window.confirm('Replace the current director script with the template?')) {
                  setYoloMusicScript(MUSIC_VIDEO_SCRIPT_TEMPLATE)
                }
              }}
              className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
            >
              Template
            </button>
          </div>
          <textarea
            value={yoloMusicScript}
            onChange={(event) => setYoloMusicScript(event.target.value)}
            placeholder="Paste the LLM director script here."
            className="mt-4 min-h-[330px] w-full resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 font-mono text-xs leading-5 text-sf-text-primary outline-none focus:border-sf-accent"
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-sf-text-muted">
              {parseStatus || (yoloActivePlanIsStale ? 'Script changed since the last parse.' : 'Ready when the script has shots.')}
            </div>
            <button
              type="button"
              onClick={handleParseScript}
              disabled={!canBuildPlan}
              className="rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Parse Script
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  const renderKeyframesStep = () => (
    <div className="space-y-4">
      {renderStepHeader(
        'Create keyframes from the script.',
        'Each parsed script shot gets one starting image. The script, not a separate shot preset list, controls what gets made.'
      )}
      <div className="grid gap-3 md:grid-cols-3">
        <Stat label="Script shots" value={plannedShotCount} />
        <Stat label="Queue variants" value={queueVariantCount} />
        <Stat label="Ready keyframes" value={yoloStoryboardReadyCount} />
      </div>
      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-sf-text-primary">
              <Film className="h-4 w-4 text-sf-accent" />
              Keyframe jobs from your director script
            </div>
            <p className="mt-1 text-xs leading-5 text-sf-text-secondary">
              The keyframe prompt on each shot becomes the still-image prompt for that exact beat.
            </p>
          </div>
          <div className="flex flex-col gap-2 md:items-end">
            <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
              <span className="mr-1 text-[10px] uppercase tracking-wider text-sf-text-muted">Keyframe model</span>
              {keyframeWorkflowOptions.map((option) => (
                <button
                  key={`music-keyframe-model-${option.id}`}
                  type="button"
                  onClick={() => handleKeyframeWorkflowChange(option.id)}
                  title={option.description}
                  className={`rounded-lg border px-2.5 py-1.5 text-left text-[10px] font-semibold transition-colors ${buttonClass(selectedKeyframeWorkflowId === option.id)}`}
                >
                  <span>{option.label}</span>
                  {option.runtimeLabel && <span className="ml-1 text-sf-text-muted">({option.runtimeLabel})</span>}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={handleQueueKeyframes}
              disabled={!canQueueKeyframes || isQueuingKeyframes || yoloDependencyCheckInProgress}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isQueuingKeyframes ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              Create Keyframes
            </button>
          </div>
        </div>
        <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 p-3 text-xs leading-5 text-sf-text-secondary">
          <span className="font-semibold text-sf-text-primary">{selectedKeyframeWorkflowLabel}</span>
          {selectedKeyframeWorkflow?.description
            ? `: ${selectedKeyframeWorkflow.description} New keyframe jobs and rerenders use this model.`
            : ' is used for new or regenerated keyframes.'}
          {selectedKeyframeWorkflowId === 'image-edit' && yoloMusicResolvedCast.length === 0 && (
            <span className="mt-1 block text-amber-200">
              Qwen Image Edit needs a cast/reference image. Add a person in the People step, or switch to Nano Banana 2 for reference-free keyframes.
            </span>
          )}
          {customKeyframeWorkflowSelected && (
            <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-sf-text-muted">Custom workflow contract</span>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] ${
                      customKeyframeValidation.ok
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                        : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                    }`}>
                      {customKeyframeValidation.ok ? 'Ready' : 'Needs setup'}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-sf-text-primary">
                    {customKeyframeWorkflowName || 'No custom workflow loaded'}
                  </div>
                  <p className="mt-1 text-[10px] leading-4 text-sf-text-muted">
                    Keep these node titles in your ComfyUI graph: <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_INPUT_IMAGE</span>, <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_PROMPT</span>, and <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_OUTPUT_IMAGE</span>. Optional: <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_SEED</span>, <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_WIDTH</span>, <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_HEIGHT</span>.
                  </p>
                  <div className={`mt-2 text-[10px] ${customKeyframeValidation.ok ? 'text-emerald-300' : 'text-amber-200'}`}>
                    {customKeyframeValidation.message}
                  </div>
                  {Array.isArray(customKeyframeValidation.warnings) && customKeyframeValidation.warnings.length > 0 && (
                    <div className="mt-1 text-[10px] text-amber-200">
                      {customKeyframeValidation.warnings.slice(0, 2).join(' ')}
                    </div>
                  )}
                </div>
                <div className="grid w-full shrink-0 gap-2 sm:w-auto sm:min-w-[180px]">
                  <button
                    type="button"
                    onClick={handleOpenYoloMusicCustomKeyframeWorkflowInComfyUi}
                    disabled={!canOpenCustomKeyframeWorkflow}
                    className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-accent/50 bg-sf-accent/10 px-2 py-1.5 text-[10px] font-semibold text-sf-accent transition-colors hover:bg-sf-accent/20 disabled:cursor-not-allowed disabled:border-sf-dark-600 disabled:bg-sf-dark-800 disabled:text-sf-text-muted"
                    title={customKeyframeWorkflowLoaded ? 'Open the loaded custom workflow in the embedded ComfyUI tab.' : 'Load the starter workflow and open it in the embedded ComfyUI tab.'}
                  >
                    <ExternalLink className="h-3 w-3" />
                    {openCustomKeyframeWorkflowLabel}
                  </button>
                  <button
                    type="button"
                    onClick={handleImportYoloMusicCustomKeyframeWorkflow}
                    className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-[10px] font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
                    title="Import the API JSON you exported from ComfyUI."
                  >
                    <Clipboard className="h-3 w-3" />
                    Import JSON
                  </button>
                  <button
                    type="button"
                    onClick={handleClearYoloMusicCustomKeyframeWorkflow}
                    className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-[10px] font-medium text-sf-text-muted transition-colors hover:border-red-500/60 hover:text-red-300"
                    title="Clear the loaded custom workflow."
                  >
                    <X className="h-3 w-3" />
                    Clear Custom
                  </button>
                </div>
              </div>
              <div className="mt-3 border-t border-sf-dark-700 pt-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-sf-text-muted">ComfyStudio bridge</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] ${bridgeBadge.className}`}>
                        {bridgeBadge.label}
                      </span>
                    </div>
                    <p className="mt-1 text-[10px] leading-4 text-sf-text-muted">
                      Adds a Send to ComfyStudio button inside ComfyUI. Import JSON stays available as the fallback.
                    </p>
                    {bridgeMessage && (
                      <div className={`mt-2 text-[10px] ${bridgeInstalled ? 'text-emerald-300' : bridgeState === 'unavailable' ? 'text-amber-200' : 'text-sf-text-secondary'}`}>
                        {bridgeMessage}
                      </div>
                    )}
                  </div>
                  <div className="grid w-full shrink-0 gap-2 sm:w-auto sm:min-w-[160px]">
                    <button
                      type="button"
                      onClick={handleInstallYoloMusicCustomKeyframeBridge}
                      disabled={!canInstallBridge || customKeyframeBridgeBusy}
                      className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-accent/50 bg-sf-accent/10 px-2 py-1.5 text-[10px] font-semibold text-sf-accent transition-colors hover:bg-sf-accent/20 disabled:cursor-not-allowed disabled:border-sf-dark-600 disabled:bg-sf-dark-800 disabled:text-sf-text-muted"
                      title={bridgeState === 'unavailable' ? 'Choose a ComfyUI folder or configure the launcher first.' : 'Install the bundled ComfyStudio Bridge into ComfyUI custom_nodes.'}
                    >
                      {customKeyframeBridgeBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                      {bridgeInstalled ? 'Installed' : 'Install Bridge'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCheckYoloMusicCustomKeyframeBridge?.({ silent: false })}
                      disabled={customKeyframeBridgeBusy || typeof handleCheckYoloMusicCustomKeyframeBridge !== 'function'}
                      className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-[10px] font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                      title="Re-check whether the bridge is installed."
                    >
                      <RefreshCw className={`h-3 w-3 ${customKeyframeBridgeBusy ? 'animate-spin' : ''}`} />
                      Re-check
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        {yoloActivePlanIsStale && (
          <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-100">
            The director script changed after the plan was parsed. Parse the script again before queueing.
          </div>
        )}
        {keyframeStatus && (
          <div className={`mt-3 rounded-lg text-xs ${
            keyframeStatusIsWarning
              ? 'border border-amber-400/30 bg-amber-400/10 p-3 text-amber-100'
              : 'text-sf-text-secondary'
          }`}>
            {keyframeStatus}
          </div>
        )}
      </div>
      {plannedShotCount > 0 && (
        <div className="space-y-3 rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm font-semibold text-sf-text-primary">Shot keyframes</div>
              <p className="mt-1 text-xs leading-5 text-sf-text-secondary">
                Preview a shot to inspect the image, edit its prompt, or rerun that keyframe at the current output settings.
              </p>
            </div>
            <button
              type="button"
              onClick={handleRegenerateAllKeyframes}
              disabled={isQueuingKeyframes || yoloDependencyCheckInProgress || !customKeyframeReady}
              className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs font-semibold text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              Regenerate All
            </button>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
            {flatShots.map(({ scene, shot }, index) => {
              const variant = getVariantForShot(scene.id, shot.id)
              const asset = variant ? yoloStoryboardAssetMap?.get(variant.key) : null
              const url = getAssetUrl(asset)
              const cardState = getKeyframeCardState(variant, asset)
              const coverageLabel = getCoverageLabel(scene, shot)
              const keyframePrompt = String(shot.imageBeat || shot.beat || shot.referenceImagePrompt || '').trim()
              const keyframeResolutionParts = buildActualImageResolutionParts(asset, runtimeImageDimensions, outputResolutionLabel)
              return (
                <div
                  key={`music-keyframe-${scene.id}-${shot.id}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedShotIndex(index)}
                  onKeyDown={(event) => handleShotCardKeyDown(event, index)}
                  className={`overflow-hidden rounded-lg border text-left transition-colors ${
                    selectedShotIndex === index
                      ? 'border-sf-accent bg-sf-accent/10'
                      : 'border-sf-dark-700 bg-sf-dark-950/70 hover:border-sf-dark-500'
                  } focus:outline-none focus:ring-2 focus:ring-sf-accent/70`}
                >
                  <div className={`relative flex h-28 items-center justify-center overflow-hidden ${
                    cardState.state === 'generating'
                      ? 'bg-gradient-to-br from-sf-accent/20 via-sf-dark-800 to-blue-500/20'
                      : cardState.state === 'error'
                        ? 'bg-red-950/30'
                        : 'bg-sf-dark-800'
                  }`}>
                    {url ? (
                      <img
                        src={url}
                        alt=""
                        className="h-full w-full object-cover"
                        onLoad={(event) => rememberImageDimensions(asset, event.currentTarget)}
                      />
                    ) : (
                      <>
                        {cardState.state === 'generating' && (
                          <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                        )}
                        <span className={`relative text-[10px] ${
                          cardState.state === 'error' ? 'text-red-200' : 'text-sf-text-muted'
                        }`}>
                          {cardState.label}
                        </span>
                      </>
                    )}
                    {url && renderPreviewButton(() => {
                      setSelectedShotIndex(index)
                      setMediaPreview({
                        kind: 'image',
                        url,
                        title: `Shot ${index + 1}: ${shot.scriptShotLabel || scene.label || shot.id}`,
                        subtitle: [coverageLabel, selectedKeyframeWorkflowLabel, ...keyframeResolutionParts, `${videoFps} fps`].filter(Boolean).join(' / '),
                        prompt: keyframePrompt,
                        editablePrompt: true,
                        sceneId: scene.id,
                        shotId: shot.id,
                        shotIndex: index,
                      })
                    })}
                  </div>
                  <div className="p-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 text-xs font-semibold text-sf-text-primary">Shot {index + 1}: {shot.scriptShotLabel || scene.label || shot.id}</div>
                      <div className="flex shrink-0 items-center gap-1">
                        {renderKeyframeRunButton({ scene, shot }, index)}
                        {renderCopyPromptButton(keyframePrompt, `Shot ${index + 1} keyframe prompt copied.`, setKeyframeStatus)}
                      </div>
                    </div>
                    {coverageLabel && (
                      <div className="mt-1 inline-flex rounded-full border border-sf-dark-600 px-2 py-0.5 text-[10px] text-sf-text-muted">
                        {coverageLabel}
                      </div>
                    )}
                    <div className="mt-1 line-clamp-2 text-[10px] text-sf-text-muted">{keyframePrompt}</div>
                    {cardState.job?.progress > 0 && (
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-sf-dark-700">
                        <div className="h-full rounded-full bg-sf-accent" style={{ width: `${Math.min(100, Math.max(0, cardState.job.progress || 0))}%` }} />
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )

  const renderAdvancedVideoSettings = () => (
    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-sf-text-primary">
            <Play className="h-4 w-4 text-sf-accent" />
            Video jobs from your director script
          </div>
          <p className="mt-1 text-xs leading-5 text-sf-text-secondary">
            The script decides each shot's motion, while the selected video model renders from its matching keyframe.
          </p>
        </div>
        <div className="flex flex-col gap-2 md:items-end">
          <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
            <span className="mr-1 text-[10px] uppercase tracking-wider text-sf-text-muted">Video model</span>
            {videoWorkflowOptions.map((option) => (
              <button
                key={`music-video-model-${option.id}`}
                type="button"
                onClick={() => handleVideoWorkflowChange(option.id)}
                title={option.description}
                className={`rounded-lg border px-2.5 py-1.5 text-left text-[10px] font-semibold transition-colors ${buttonClass(selectedVideoWorkflowId === option.id)}`}
              >
                <span>{option.label}</span>
                {option.runtimeLabel && <span className="ml-1 text-sf-text-muted">({option.runtimeLabel})</span>}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
            <span className="mr-1 text-[10px] uppercase tracking-wider text-sf-text-muted">
              {customVideoWorkflowSelected ? 'Size input' : 'Video size'}
            </span>
            {RESOLUTION_OPTIONS.map((option) => {
              const disabled = getResolutionFallbackForWorkflow(selectedVideoWorkflowId, option.id) !== option.id
              return (
                <button
                  key={`music-video-resolution-${option.id}`}
                  type="button"
                  onClick={() => handleResolutionPresetChange(option.id)}
                  disabled={disabled}
                  title={customVideoWorkflowSelected
                    ? 'Sent to your graph only when it uses COMFYSTUDIO_WIDTH and COMFYSTUDIO_HEIGHT.'
                    : disabled ? 'This video model is limited to 720p here.' : ''}
                  className={`rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold transition-colors ${
                    disabled
                      ? 'cursor-not-allowed border-sf-dark-700 bg-sf-dark-950/50 text-sf-text-muted/40'
                      : buttonClass(resolutionPreset === option.id)
                  }`}
                >
                  {option.label}
                </button>
              )
            })}
            <span className="rounded-lg border border-sf-dark-600 px-2.5 py-1.5 text-[10px] font-semibold text-sf-text-muted">
              {videoFps} fps
            </span>
            {customVideoWorkflowSelected && (
              <span
                className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-1.5 text-[10px] font-semibold text-amber-200"
                title="Custom graphs may use these values, ignore them, or use their own model/provider settings."
              >
                Graph-dependent
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <button
              type="button"
              onClick={handleQueueVideos}
              disabled={!canQueueVideos || isQueuingVideos || yoloDependencyCheckInProgress}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isQueuingVideos ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Generate Videos
            </button>
            <button
              type="button"
              onClick={handleAssembleTimeline}
              disabled={!handleAssembleMusicVideoTimeline || videoReadyCount === 0 || yoloActivePlanIsStale || isAssemblingTimeline}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              title={videoReadyCount === 0 ? 'Generate at least one ready video first.' : 'Place ready videos on timeline tracks using their script timing.'}
            >
              {isAssemblingTimeline ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />}
              Assemble Timeline
            </button>
          </div>
        </div>
      </div>
      <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 p-3 text-xs leading-5 text-sf-text-secondary">
        <span className="font-semibold text-sf-text-primary">{selectedVideoWorkflowLabel}</span>
        {customVideoWorkflowSelected
          ? ': ComfyStudio sends the generated keyframe image, motion prompt, seed, and available video settings into your ComfyUI graph.'
          : selectedVideoWorkflow?.description
          ? `: ${selectedVideoWorkflow.description} New video jobs and rerenders use ${outputResolutionLabel} / ${videoFps} fps.`
          : ` is used for new or regenerated videos at ${outputResolutionLabel} / ${videoFps} fps.`}
        {customVideoWorkflowSelected && (
          <span className="mt-1 block">
            Resolution and FPS are controlled by ComfyStudio only when your graph uses <span className="font-mono text-sf-text-primary">COMFYSTUDIO_WIDTH</span>, <span className="font-mono text-sf-text-primary">COMFYSTUDIO_HEIGHT</span>, and <span className="font-mono text-sf-text-primary">COMFYSTUDIO_FPS</span>; otherwise your graph controls the final output.
          </span>
        )}
        {customVideoWorkflowSelected ? (
          <span className="mt-1 block text-amber-200">
            Lip-sync is not automatic. ComfyStudio can pass song audio through <span className="font-mono text-amber-100">COMFYSTUDIO_AUDIO</span>, but your graph must use that audio in a lip-sync or audio-conditioned video workflow.
          </span>
        ) : selectedVideoWorkflowSupports1080 ? (
          <span className="mt-1 block text-sf-text-muted">
            1080p is available for this model, with 720p kept as the default reliability setting.
          </span>
        ) : (
          <span className="mt-1 block text-sf-text-muted">
            This model is limited to 720p here, so higher sizes are disabled.
          </span>
        )}
        {customVideoWorkflowSelected && (
          <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-sf-text-muted">Custom workflow contract</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] ${
                    customVideoValidation.ok
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                  }`}>
                    {customVideoValidation.ok ? 'Ready' : 'Needs setup'}
                  </span>
                </div>
                <div className="mt-1 text-xs text-sf-text-primary">
                  {customVideoWorkflowName || 'No custom workflow loaded'}
                </div>
                <p className="mt-1 text-[10px] leading-4 text-sf-text-muted">
                  Keep these node titles in your ComfyUI graph: <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_INPUT_IMAGE</span>, <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_PROMPT</span>, and <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_OUTPUT_VIDEO</span>. Optional: <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_SEED</span>, <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_WIDTH</span>, <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_HEIGHT</span>, <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_FPS</span>, <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_DURATION</span>, <span className="font-mono text-sf-text-secondary">COMFYSTUDIO_AUDIO</span>.
                </p>
                <div className={`mt-2 text-[10px] ${customVideoValidation.ok ? 'text-emerald-300' : 'text-amber-200'}`}>
                  {customVideoValidation.message}
                </div>
                {Array.isArray(customVideoValidation.warnings) && customVideoValidation.warnings.length > 0 && (
                  <div className="mt-1 text-[10px] text-amber-200">
                    {customVideoValidation.warnings.slice(0, 2).join(' ')}
                  </div>
                )}
              </div>
              <div className="grid w-full shrink-0 gap-2 sm:w-auto sm:min-w-[180px]">
                <button
                  type="button"
                  onClick={handleOpenYoloMusicCustomVideoWorkflowInComfyUi}
                  disabled={!canOpenCustomVideoWorkflow}
                  className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-accent/50 bg-sf-accent/10 px-2 py-1.5 text-[10px] font-semibold text-sf-accent transition-colors hover:bg-sf-accent/20 disabled:cursor-not-allowed disabled:border-sf-dark-600 disabled:bg-sf-dark-800 disabled:text-sf-text-muted"
                  title={customVideoWorkflowLoaded ? 'Open the loaded custom workflow in the embedded ComfyUI tab.' : 'Load the starter workflow and open it in the embedded ComfyUI tab.'}
                >
                  <ExternalLink className="h-3 w-3" />
                  {openCustomVideoWorkflowLabel}
                </button>
                <button
                  type="button"
                  onClick={handleImportYoloMusicCustomVideoWorkflow}
                  className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-[10px] font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
                  title="Import the API JSON you exported from ComfyUI."
                >
                  <Clipboard className="h-3 w-3" />
                  Import JSON
                </button>
                <button
                  type="button"
                  onClick={handleClearYoloMusicCustomVideoWorkflow}
                  className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-[10px] font-medium text-sf-text-muted transition-colors hover:border-red-500/60 hover:text-red-300"
                  title="Clear the loaded custom workflow."
                >
                  <X className="h-3 w-3" />
                  Clear Custom
                </button>
              </div>
            </div>
            <div className="mt-3 border-t border-sf-dark-700 pt-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-sf-text-muted">ComfyStudio bridge</span>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] ${bridgeBadge.className}`}>
                      {bridgeBadge.label}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] leading-4 text-sf-text-muted">
                    Open the starter from this video panel before using Send to ComfyStudio so the graph returns to Step 5.
                  </p>
                  {bridgeMessage && (
                    <div className={`mt-2 text-[10px] ${bridgeInstalled ? 'text-emerald-300' : bridgeState === 'unavailable' ? 'text-amber-200' : 'text-sf-text-secondary'}`}>
                      {bridgeMessage}
                    </div>
                  )}
                </div>
                <div className="grid w-full shrink-0 gap-2 sm:w-auto sm:min-w-[160px]">
                  <button
                    type="button"
                    onClick={handleInstallYoloMusicCustomKeyframeBridge}
                    disabled={!canInstallBridge || customKeyframeBridgeBusy}
                    className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-accent/50 bg-sf-accent/10 px-2 py-1.5 text-[10px] font-semibold text-sf-accent transition-colors hover:bg-sf-accent/20 disabled:cursor-not-allowed disabled:border-sf-dark-600 disabled:bg-sf-dark-800 disabled:text-sf-text-muted"
                    title={bridgeState === 'unavailable' ? 'Choose a ComfyUI folder or configure the launcher first.' : 'Install the bundled ComfyStudio Bridge into ComfyUI custom_nodes.'}
                  >
                    {customKeyframeBridgeBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                    {bridgeInstalled ? 'Installed' : 'Install Bridge'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCheckYoloMusicCustomKeyframeBridge?.({ silent: false })}
                    disabled={customKeyframeBridgeBusy || typeof handleCheckYoloMusicCustomKeyframeBridge !== 'function'}
                    className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-[10px] font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    title="Re-check whether the bridge is installed."
                  >
                    <RefreshCw className={`h-3 w-3 ${customKeyframeBridgeBusy ? 'animate-spin' : ''}`} />
                    Re-check
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
        {selectedVideoWorkflowId !== defaultVideoWorkflowId && !customVideoWorkflowSelected && (
          <div className="mt-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs leading-5 text-yellow-100">
            {selectedVideoWorkflowLabel} uses the generated keyframes and motion prompts, but it will not use the song audio for lip-sync. Keep the LTX 2.3 Music pass for vocal-sync coverage.
          </div>
        )}
        {yoloStoryboardReadyCount === 0 && (
          <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 p-3 text-xs text-sf-text-muted">
            Create keyframes first so each video job has a starting image.
          </div>
        )}
        {customVideoWorkflowSelected && !customVideoReady && (
          <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-100">
            {customVideoValidation.message || 'Load and validate a custom video workflow before generating videos.'}
          </div>
        )}
        {yoloActivePlanIsStale && (
          <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-100">
            The director script changed after the plan was parsed. Parse the script again before queueing videos.
          </div>
        )}
        {videoStatus && <div className="mt-3 text-xs text-sf-text-secondary">{videoStatus}</div>}
        {timelineStatus && (
          <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-100">
            {timelineStatus}
          </div>
        )}
      </div>
    </div>
  )

  const renderVideosStep = () => (
    <div className="space-y-4">
      {renderStepHeader(
        'Generate videos from the script.',
        'Each parsed shot can be generated or rerun on its own using the matching keyframe and song timing.'
      )}
      <div className="grid gap-3 md:grid-cols-3">
        <Stat label="Script shots" value={plannedShotCount} />
        <Stat label="Ready keyframes" value={yoloStoryboardReadyCount} />
        <Stat label="Ready videos" value={videoReadyCount} />
      </div>
      {renderAdvancedVideoSettings()}
      {plannedShotCount > 0 && (
        <div className="space-y-3 rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm font-semibold text-sf-text-primary">Shot videos</div>
              <p className="mt-1 text-xs leading-5 text-sf-text-secondary">
                Preview a shot to inspect the video, edit its motion prompt, or rerun it through {selectedVideoWorkflowLabel}.
              </p>
            </div>
            <button
              type="button"
              onClick={handleRegenerateAllVideos}
              disabled={!canQueueVideos || isQueuingVideos || yoloDependencyCheckInProgress}
              className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs font-semibold text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              Regenerate All
            </button>
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
            {flatShots.map(({ scene, shot }, index) => {
              const variant = getVariantForShot(scene.id, shot.id)
              const keyframeAsset = variant ? yoloStoryboardAssetMap?.get(variant.key) : null
              const videoAsset = getVideoAssetForVariant(variant)
              const keyframeUrl = getAssetUrl(keyframeAsset)
              const videoUrl = getAssetUrl(videoAsset)
              const cardState = getVideoCardState(variant, videoAsset)
              const shotTypeId = getShotTypeId(shot)
              const shotTypeOption = getMusicVideoShotTypeOption(shotTypeId)
              const start = Number(shot?.audioStart ?? 0) || 0
              const length = Number(shot?.length ?? shot?.durationSeconds ?? 0) || 0
              const coverageLabel = getCoverageLabel(scene, shot)
              const videoPrompt = String(shot.videoBeat || shot.beat || shot.shotPrompt || '').trim()
              return (
                <div
                  key={`music-video-${scene.id}-${shot.id}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedShotIndex(index)}
                  onKeyDown={(event) => handleShotCardKeyDown(event, index)}
                  className={`overflow-hidden rounded-lg border text-left transition-colors ${
                    selectedShotIndex === index
                      ? 'border-sf-accent bg-sf-accent/10'
                      : 'border-sf-dark-700 bg-sf-dark-950/70 hover:border-sf-dark-500'
                  } focus:outline-none focus:ring-2 focus:ring-sf-accent/70`}
                >
                  <div className={`relative flex h-28 items-center justify-center overflow-hidden ${
                    cardState.state === 'generating'
                      ? 'bg-gradient-to-br from-sf-accent/20 via-sf-dark-800 to-blue-500/20'
                      : cardState.state === 'error'
                        ? 'bg-red-950/30'
                        : 'bg-sf-dark-800'
                  }`}>
                    <ShotVideoPreview hasVideo={Boolean(videoUrl)} keyframeUrl={keyframeUrl} />
                    {cardState.state === 'generating' && (
                      <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                    )}
                    {videoUrl && renderPreviewButton(() => {
                      setSelectedShotIndex(index)
                      setMediaPreview({
                        kind: 'video',
                        url: videoUrl,
                        title: `Shot ${index + 1}: ${shot.scriptShotLabel || scene.label || shot.id}`,
                        subtitle: [coverageLabel, shotTypeOption?.label || shotTypeId || 'Script shot', `${start.toFixed(2)}s`, length > 0 ? `${length.toFixed(1)}s` : '', selectedVideoWorkflowLabel].filter(Boolean).join(' / '),
                        prompt: videoPrompt,
                        editablePrompt: true,
                        sceneId: scene.id,
                        shotId: shot.id,
                        shotIndex: index,
                      })
                    })}
                    <div className={`absolute left-2 top-2 rounded-full px-2 py-1 text-[10px] ${
                      cardState.state === 'ready'
                        ? 'bg-emerald-500/80 text-white'
                        : cardState.state === 'generating'
                          ? 'bg-sf-accent/80 text-white'
                          : cardState.state === 'error'
                            ? 'bg-red-500/80 text-white'
                            : 'bg-sf-dark-950/80 text-sf-text-secondary'
                    }`}>
                      {cardState.label}
                    </div>
                  </div>
                  <div className="p-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 text-xs font-semibold text-sf-text-primary">Shot {index + 1}: {shot.scriptShotLabel || scene.label || shot.id}</div>
                      <div className="flex shrink-0 items-center gap-1">
                        {renderVideoRunButton({ scene, shot }, index)}
                        {renderCopyPromptButton(videoPrompt, `Shot ${index + 1} video prompt copied.`, setVideoStatus)}
                      </div>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-sf-text-muted">
                      {coverageLabel && <span>{coverageLabel}</span>}
                      <span>{shotTypeOption?.label || shotTypeId || 'Script shot'}</span>
                      <span>{start.toFixed(2)}s</span>
                      {length > 0 && <span>{length.toFixed(1)}s</span>}
                    </div>
                    <div className="mt-1 line-clamp-2 text-[10px] text-sf-text-muted">{videoPrompt}</div>
                    {cardState.job?.progress > 0 && (
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-sf-dark-700">
                        <div className="h-full rounded-full bg-sf-accent" style={{ width: `${Math.min(100, Math.max(0, cardState.job.progress || 0))}%` }} />
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )

  const renderMediaPreviewModal = () => {
    if (!mediaPreview) return null

    const editableKeyframePrompt = Boolean(mediaPreview.editablePrompt && mediaPreview.kind === 'image')
    const editableVideoPrompt = Boolean(mediaPreview.editablePrompt && mediaPreview.kind === 'video')
    const editablePreviewPrompt = editableKeyframePrompt || editableVideoPrompt
    const previewShotIndex = Number(mediaPreview.shotIndex)
    const previewShotRow = editablePreviewPrompt && Number.isInteger(previewShotIndex)
      ? flatShots[previewShotIndex] || null
      : null
    const previewShot = previewShotRow?.shot || null
    const hasImageBeat = previewShot && Object.prototype.hasOwnProperty.call(previewShot, 'imageBeat')
    const previewPrompt = editableKeyframePrompt
      ? String(hasImageBeat ? previewShot.imageBeat : (previewShot?.beat || previewShot?.referenceImagePrompt || mediaPreview.prompt || ''))
      : editableVideoPrompt
        ? String(previewShot?.videoBeat || previewShot?.beat || previewShot?.shotPrompt || mediaPreview.prompt || '')
        : String(mediaPreview.prompt || '')
    const previewRunDisabled = !previewShotRow || (editableKeyframePrompt ? singleKeyframeActionDisabled : singleVideoActionDisabled)
    const previewPromptLabel = editableKeyframePrompt ? 'Keyframe prompt' : 'Video motion prompt'
    const previewWorkflowLabel = editableKeyframePrompt ? selectedKeyframeWorkflowLabel : selectedVideoWorkflowLabel
    const previewStatusSetter = editableKeyframePrompt ? setKeyframeStatus : setVideoStatus
    const previewCopiedMessage = `Shot ${previewShotIndex + 1} ${editableKeyframePrompt ? 'keyframe' : 'video'} prompt copied.`

    return (
      <div
        className="fixed inset-0 z-50 overflow-y-auto bg-black/80 px-4 py-6 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-label={mediaPreview.title || 'Media preview'}
        onClick={() => setMediaPreview(null)}
      >
        <div className="flex min-h-full items-center justify-center">
          <div
            className="w-[96vw] max-w-6xl overflow-hidden rounded-lg border border-sf-dark-600 bg-sf-dark-950 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-sf-dark-700 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-sf-text-primary">{mediaPreview.title}</div>
                {mediaPreview.subtitle && (
                  <div className="mt-1 truncate text-[10px] text-sf-text-muted">{mediaPreview.subtitle}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setMediaPreview(null)}
                className="rounded-md p-1.5 text-sf-text-muted transition-colors hover:bg-sf-dark-800 hover:text-sf-text-primary focus:outline-none focus:ring-2 focus:ring-sf-accent"
                title="Close preview"
                aria-label="Close preview"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex max-h-[72vh] items-center justify-center bg-black">
              {mediaPreview.kind === 'video' ? (
                <video
                  key={mediaPreview.url}
                  src={mediaPreview.url}
                  className="max-h-[72vh] max-w-full object-contain"
                  controls
                  autoPlay
                  playsInline
                />
              ) : (
                <img
                  src={mediaPreview.url}
                  alt={mediaPreview.title || 'Preview'}
                  className="max-h-[72vh] max-w-full object-contain"
                />
              )}
            </div>
            {editablePreviewPrompt ? (
              <div className="border-t border-sf-dark-700 px-4 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">{previewPromptLabel}</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        void handleCopyShotPrompt(
                          previewPrompt,
                          previewCopiedMessage,
                          previewStatusSetter
                        )
                      }}
                      disabled={!previewPrompt.trim()}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-sf-dark-600 bg-sf-dark-900/85 px-2 py-1 text-[10px] font-semibold text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                      title="Copy prompt"
                    >
                      <Clipboard className="h-3 w-3" />
                      Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!previewShotRow) return
                        if (editableKeyframePrompt) {
                          void handleGenerateShotKeyframe(previewShotRow, previewShotIndex)
                        } else {
                          void handleGenerateShotVideo(previewShotRow, previewShotIndex)
                        }
                      }}
                      disabled={previewRunDisabled}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-sf-accent/50 bg-sf-accent/10 px-2 py-1 text-[10px] font-semibold text-sf-accent transition-colors hover:bg-sf-accent/20 disabled:cursor-not-allowed disabled:border-sf-dark-600 disabled:bg-sf-dark-900/60 disabled:text-sf-text-muted"
                      title={previewRunDisabled ? `${editableKeyframePrompt ? 'Keyframes' : 'Videos'} cannot be queued right now.` : `Generate this ${editableKeyframePrompt ? 'keyframe' : 'video'} with ${previewWorkflowLabel}`}
                    >
                      {(editableKeyframePrompt ? isQueuingKeyframes : isQueuingVideos) && selectedShotIndex === previewShotIndex
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : editableKeyframePrompt
                          ? <Wand2 className="h-3 w-3" />
                          : <Play className="h-3 w-3" />}
                      Run With {previewWorkflowLabel}
                    </button>
                  </div>
                </div>
                <textarea
                  value={previewPrompt}
                  onChange={(event) => {
                    const nextPrompt = event.target.value
                    setMediaPreview((current) => current ? { ...current, prompt: nextPrompt } : current)
                    if (editableKeyframePrompt) {
                      handleYoloShotImageBeatChange?.(mediaPreview.sceneId, mediaPreview.shotId, nextPrompt)
                    } else {
                      handleYoloShotVideoBeatChange?.(mediaPreview.sceneId, mediaPreview.shotId, nextPrompt)
                    }
                  }}
                  rows={4}
                  className="mt-2 w-full resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs leading-5 text-sf-text-primary outline-none focus:border-sf-accent"
                />
              </div>
            ) : previewPrompt ? (
              <div className="border-t border-sf-dark-700 px-4 py-3 text-xs leading-5 text-sf-text-secondary">
                {previewPrompt}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  const stepRenderer = {
    song: renderSongStep,
    people: renderPeopleStep,
    script: renderScriptStep,
    keyframes: renderKeyframesStep,
    videos: renderVideosStep,
  }[step] || renderSongStep

  return (
    <>
      <div className="space-y-4">
        <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/40 p-2">
          <div className="grid gap-2 md:grid-cols-5">
            {STEPS.map((entry) => {
              const selected = step === entry.id
              const disabled = isStepDisabled(entry.id)
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setStep(entry.id)}
                  disabled={disabled}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected
                      ? 'border-sf-accent bg-sf-accent/20 text-sf-text-primary ring-1 ring-sf-accent/40'
                      : disabled
                        ? 'border-sf-dark-700 bg-sf-dark-950/40 text-sf-text-muted/50'
                        : 'border-sf-dark-700 bg-sf-dark-950/70 text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary'
                  }`}
                >
                  <div className="text-[10px] uppercase text-sf-text-muted">Step {entry.number}</div>
                  <div className="mt-1 text-xs font-semibold">{entry.label}</div>
                </button>
              )
            })}
          </div>
        </div>

        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-950/60 p-4 md:p-5">
          {stepRenderer()}
        </div>
      </div>
      {renderMediaPreviewModal()}
    </>
  )
}
