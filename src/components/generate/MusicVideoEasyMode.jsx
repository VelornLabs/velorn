import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2,
  Clipboard,
  FileText,
  Film,
  Loader2,
  Maximize2,
  Music,
  Play,
  UserPlus,
  Wand2,
  X,
} from 'lucide-react'
import {
  MUSIC_VIDEO_AUDIO_KIND_OPTIONS,
  MUSIC_VIDEO_CAST_ROLE_OPTIONS,
  MUSIC_VIDEO_SCRIPT_TEMPLATE,
  MUSIC_VIDEO_SHOT_WORKFLOW_ID,
  getMusicVideoAudioKindOption,
  getMusicVideoShotTypeOption,
} from '../../config/musicVideoShotConfig'

const DRAFT_STORAGE_KEY = 'comfystudio-music-video-easy-mode-draft-v1'

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

function loadDraft() {
  if (typeof localStorage === 'undefined') return DEFAULT_DRAFT
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}')
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

function workflowSupports1080Resolution(workflowId) {
  return String(workflowId || '').trim() === MUSIC_VIDEO_SHOT_WORKFLOW_ID
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

function getAssetUrl(asset) {
  return asset?.url || asset?.thumbnailUrl || asset?.proxyUrl || asset?.path || ''
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
  handleYoloMusicCastAdd,
  handleYoloMusicCastRemove,
  handleYoloMusicCastAssetChange,
  handleYoloMusicCastSlugChange,
  handleYoloMusicCastLabelChange,
  handleYoloMusicCastRoleChange,
  yoloMusicKeyframeWorkflowId = 'nano-banana-2',
  setYoloMusicKeyframeWorkflowId,
  yoloMusicKeyframeWorkflowOptions = DEFAULT_KEYFRAME_WORKFLOW_OPTIONS,
  yoloMusicVideoWorkflowId,
  setYoloMusicVideoWorkflowId,
  yoloMusicVideoWorkflowOptions = DEFAULT_VIDEO_WORKFLOW_OPTIONS,
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
  const initialDraft = useMemo(() => loadDraft(), [])
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

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({
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
  ])

  useEffect(() => {
    if (!mediaPreview) return
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setMediaPreview(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [mediaPreview])

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
  const coveragePlan = useMemo(() => buildCoveragePlan({
    performancePassCount,
    includeStoryBroll,
    includeEnvironmentalBroll,
    includeDetailBroll,
  }), [includeDetailBroll, includeEnvironmentalBroll, includeStoryBroll, performancePassCount])
  const coverageSummary = getCoverageSummary(coveragePlan)
  const canBuildPlan = Boolean(String(yoloMusicScript || '').trim())
  const canQueueKeyframes = plannedShotCount > 0 && !yoloActivePlanIsStale
  const canQueueVideos = canQueueKeyframes && yoloStoryboardReadyCount > 0
  const selectedShotRow = flatShots[selectedShotIndex] || flatShots[0] || null
  const keyframeStatusIsWarning = keyframeStatus.startsWith('All your keyframes')

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
        setKeyframeStatus('All your keyframes are already created. To rerun a particular frame, select a shot below and regenerate it, or delete its keyframe asset first.')
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

  const handleRegenerateSelectedKeyframe = async () => {
    if (!selectedShotRow) return
    setIsQueuingKeyframes(true)
    setKeyframeStatus(`Queued ${selectedKeyframeWorkflowLabel} keyframe regeneration for Shot ${selectedShotIndex + 1}.`)
    try {
      await handleQueueYoloShotStoryboard(selectedShotRow.scene.id, selectedShotRow.shot.id, {
        resolutionOverride: outputResolution,
      })
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
        setVideoStatus(`All ${selectedVideoWorkflowLabel} videos are already created. To test or rerun one shot, select it below and run that shot video again.`)
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

  const handleRegenerateSelectedVideo = async () => {
    if (!selectedShotRow) return
    const variant = getVariantForShot(selectedShotRow.scene.id, selectedShotRow.shot.id)
    if (!variant) {
      setVideoStatus(`No video variant found for Shot ${selectedShotIndex + 1}. Parse the script again first.`)
      return
    }
    if (!yoloStoryboardAssetMap?.has(variant.key)) {
      setVideoStatus(`Shot ${selectedShotIndex + 1} needs a keyframe before video can run.`)
      return
    }
    setIsQueuingVideos(true)
    setVideoStatus(`Queueing ${selectedVideoWorkflowLabel} video rerun for Shot ${selectedShotIndex + 1}...`)
    try {
      await handleQueueYoloShotVideo?.(selectedShotRow.scene.id, selectedShotRow.shot.id, {
        targetWorkflowIds: selectedVideoWorkflowId ? [selectedVideoWorkflowId] : null,
        resolutionOverride: outputResolution,
      })
      setVideoStatus(`Queued ${selectedVideoWorkflowLabel} video rerun for Shot ${selectedShotIndex + 1}.`)
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
            onClick={handleYoloMusicCastAdd}
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
          {(yoloMusicCast || []).map((entry, index) => (
            <div key={entry.id || index} className="grid gap-2 rounded-lg border border-sf-dark-700 bg-sf-dark-950/50 p-3 lg:grid-cols-[1fr_1fr_1fr_auto]">
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
                <select
                  value={entry?.assetId || ''}
                  onChange={(event) => handleYoloMusicCastAssetChange(entry.id, event.target.value || null)}
                  className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                >
                  <option value="">Select image asset</option>
                  {imageAssets.map((asset) => (
                    <option key={asset.id} value={asset.id}>{asset.name || asset.id}</option>
                  ))}
                </select>
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
                <button
                  type="button"
                  onClick={() => handleYoloMusicCastRemove(entry.id)}
                  className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-muted transition-colors hover:border-red-400/60 hover:text-red-200"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
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
                Select a shot to inspect or rerun just that keyframe at the current output settings.
              </p>
            </div>
            <button
              type="button"
              onClick={handleRegenerateAllKeyframes}
              disabled={isQueuingKeyframes || yoloDependencyCheckInProgress}
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
                      <img src={url} alt="" className="h-full w-full object-cover" />
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
                    {url && renderPreviewButton(() => setMediaPreview({
                      kind: 'image',
                      url,
                      title: `Shot ${index + 1}: ${shot.scriptShotLabel || scene.label || shot.id}`,
                      subtitle: [coverageLabel, selectedKeyframeWorkflowLabel, outputResolutionLabel, `${videoFps} fps`].filter(Boolean).join(' / '),
                      prompt: shot.imageBeat || shot.beat || shot.referenceImagePrompt || '',
                    }))}
                  </div>
                  <div className="p-2">
                    <div className="text-xs font-semibold text-sf-text-primary">Shot {index + 1}: {shot.scriptShotLabel || scene.label || shot.id}</div>
                    {coverageLabel && (
                      <div className="mt-1 inline-flex rounded-full border border-sf-dark-600 px-2 py-0.5 text-[10px] text-sf-text-muted">
                        {coverageLabel}
                      </div>
                    )}
                    <div className="mt-1 line-clamp-2 text-[10px] text-sf-text-muted">{shot.imageBeat || shot.beat || shot.referenceImagePrompt}</div>
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
          {selectedShotRow && (
            <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 p-3">
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="text-sm font-semibold text-sf-text-primary">
                    Shot {selectedShotIndex + 1}: {selectedShotRow.shot.scriptShotLabel || selectedShotRow.scene.label || selectedShotRow.shot.id}
                  </div>
                  <div className="mt-1 text-[10px] text-sf-text-muted">
                    {[outputResolutionLabel, `${videoFps} fps`, getCoverageLabel(selectedShotRow.scene, selectedShotRow.shot)].filter(Boolean).join(' / ')}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleRegenerateSelectedKeyframe}
                  disabled={isQueuingKeyframes || yoloDependencyCheckInProgress}
                  className="rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Regenerate Selected Shot
                </button>
              </div>
              <label className="mt-3 block text-xs text-sf-text-secondary">
                <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Keyframe prompt</span>
                <textarea
                  value={selectedShotRow.shot.imageBeat || selectedShotRow.shot.beat || ''}
                  onChange={(event) => handleYoloShotImageBeatChange?.(selectedShotRow.scene.id, selectedShotRow.shot.id, event.target.value)}
                  rows={4}
                  className="mt-1 w-full resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                />
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  )

  const renderAdvancedVideoSettings = () => (
    <details className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-4">
      <summary className="cursor-pointer list-none">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-sf-accent">Advanced rerender settings</div>
            <div className="mt-1 text-sm font-semibold text-sf-text-primary">
              {selectedVideoWorkflowLabel} / {outputResolutionLabel} / {videoFps} fps
            </div>
            <p className="mt-1 text-xs leading-5 text-sf-text-secondary">
              Change these only when you want future renders or rerenders to use a different video model or size.
            </p>
          </div>
          <span className="rounded-full border border-sf-dark-600 px-2 py-1 text-[10px] text-sf-text-muted">
            Open settings
          </span>
        </div>
      </summary>
      <div className="mt-4 space-y-3">
        <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-950/50 p-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-sf-text-muted">Video model pass</div>
              <div className="mt-1 text-sm font-semibold text-sf-text-primary">Viewing {selectedVideoWorkflowLabel}</div>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-sf-text-secondary">
                Use the same keyframes to create or rerun this music-video pass with a different animation model.
              </p>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {videoWorkflowOptions.map((option) => (
              <button
                key={`music-video-model-${option.id}`}
                type="button"
                onClick={() => handleVideoWorkflowChange(option.id)}
                title={option.description}
                className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${buttonClass(selectedVideoWorkflowId === option.id)}`}
              >
                <div className="font-semibold">{option.label}</div>
                {option.description && (
                  <div className="mt-1 text-[10px] leading-4 text-sf-text-muted">{option.description}</div>
                )}
              </button>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-950/50 p-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-sf-text-muted">New rerenders use</div>
              <div className="mt-1 text-sm font-semibold text-sf-text-primary">{outputResolutionLabel}</div>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-sf-text-secondary">
                {selectedVideoWorkflowSupports1080
                  ? 'This affects future video renders only. 1080p is the highest LTX 2.3 Music size available here for reliability.'
                  : 'WAN 2.2 rerenders are limited to 720p here, so higher resolutions are disabled for this model.'}
              </p>
            </div>
            <div className="grid min-w-[180px] grid-cols-2 gap-2">
              {RESOLUTION_OPTIONS.map((option) => {
                const disabled = getResolutionFallbackForWorkflow(selectedVideoWorkflowId, option.id) !== option.id
                return (
                  <button
                    key={`music-video-resolution-${option.id}`}
                    type="button"
                    onClick={() => handleResolutionPresetChange(option.id)}
                    disabled={disabled}
                    title={disabled ? 'This video model is limited to 720p here.' : ''}
                    className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
                      disabled
                        ? 'cursor-not-allowed border-sf-dark-700 bg-sf-dark-950/50 text-sf-text-muted/40'
                        : buttonClass(resolutionPreset === option.id)
                    }`}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
        {selectedVideoWorkflowId !== defaultVideoWorkflowId && (
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs leading-5 text-yellow-100">
            {selectedVideoWorkflowLabel} uses the generated keyframes and motion prompts, but it will not use the song audio for lip-sync. Keep the LTX 2.3 Music pass for vocal-sync coverage.
          </div>
        )}
        <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-950/50 p-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-[0.14em] text-sf-text-muted">Batch rerender</div>
              <div className="mt-1 text-sm font-semibold text-sf-text-primary">Regenerate every planned video shot</div>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-sf-text-secondary">
                Use this when you intentionally want to replace or create a full new pass with the current model and rerender size.
              </p>
            </div>
            <button
              type="button"
              onClick={handleRegenerateAllVideos}
              disabled={!canQueueVideos || isQueuingVideos || yoloDependencyCheckInProgress}
              className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs font-semibold text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              Regenerate All With {selectedVideoWorkflowLabel}
            </button>
          </div>
        </div>
      </div>
    </details>
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
      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-sf-text-primary">
              <Play className="h-4 w-4 text-sf-accent" />
              Video jobs from your director script
            </div>
            <p className="mt-1 text-xs leading-5 text-sf-text-secondary">
              The script decides whether each row is lip-sync performance, wide performance coverage, or b-roll.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-sf-text-muted">
              <span className="rounded-full border border-sf-dark-600 px-2 py-1">Current pass: {selectedVideoWorkflowLabel}</span>
              <span className="rounded-full border border-sf-dark-600 px-2 py-1">{outputResolutionLabel} / {videoFps} fps</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleQueueVideos}
              disabled={!canQueueVideos || isQueuingVideos || yoloDependencyCheckInProgress}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isQueuingVideos ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Generate Videos With {selectedVideoWorkflowLabel}
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
        {yoloStoryboardReadyCount === 0 && (
          <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 p-3 text-xs text-sf-text-muted">
            Create keyframes first so each video job has a starting image.
          </div>
        )}
        {videoStatus && <div className="mt-3 text-xs text-sf-text-secondary">{videoStatus}</div>}
        {timelineStatus && (
          <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-100">
            {timelineStatus}
          </div>
        )}
      </div>
      {plannedShotCount > 0 && (
        <div className="space-y-3 rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-4">
          <div>
            <div className="text-sm font-semibold text-sf-text-primary">Shot videos</div>
            <p className="mt-1 text-xs leading-5 text-sf-text-secondary">
              Select a shot to inspect or rerun only that video through {selectedVideoWorkflowLabel}.
            </p>
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
                    {videoUrl ? (
                      <video src={videoUrl} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                    ) : keyframeUrl ? (
                      <img src={keyframeUrl} alt="" className="h-full w-full object-cover opacity-70" />
                    ) : (
                      <span className="text-[10px] text-sf-text-muted">Needs keyframe</span>
                    )}
                    {cardState.state === 'generating' && (
                      <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                    )}
                    {videoUrl && renderPreviewButton(() => setMediaPreview({
                      kind: 'video',
                      url: videoUrl,
                      title: `Shot ${index + 1}: ${shot.scriptShotLabel || scene.label || shot.id}`,
                      subtitle: [coverageLabel, shotTypeOption?.label || shotTypeId || 'Script shot', `${start.toFixed(2)}s`, length > 0 ? `${length.toFixed(1)}s` : '', selectedVideoWorkflowLabel].filter(Boolean).join(' / '),
                      prompt: shot.videoBeat || shot.beat || shot.shotPrompt || '',
                    }))}
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
                    <div className="text-xs font-semibold text-sf-text-primary">Shot {index + 1}: {shot.scriptShotLabel || scene.label || shot.id}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-sf-text-muted">
                      {coverageLabel && <span>{coverageLabel}</span>}
                      <span>{shotTypeOption?.label || shotTypeId || 'Script shot'}</span>
                      <span>{start.toFixed(2)}s</span>
                      {length > 0 && <span>{length.toFixed(1)}s</span>}
                    </div>
                    <div className="mt-1 line-clamp-2 text-[10px] text-sf-text-muted">{shot.videoBeat || shot.beat || shot.shotPrompt}</div>
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
          {selectedShotRow && (
            <div className="space-y-3">
              <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs leading-5 text-yellow-100">
                Not happy with a shot? Select it here, adjust the motion prompt if needed, then rerun just that shot. Use this area for fixes, alternate takes, or trying a different model or resolution without rebuilding the whole music video.
              </div>
              <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 p-3">
                <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="text-sm font-semibold text-sf-text-primary">
                      Shot {selectedShotIndex + 1}: {selectedShotRow.shot.scriptShotLabel || selectedShotRow.scene.label || selectedShotRow.shot.id}
                    </div>
                    <div className="mt-1 text-[10px] text-sf-text-muted">
                      {[selectedVideoWorkflowLabel, outputResolutionLabel, `${videoFps} fps`, getCoverageLabel(selectedShotRow.scene, selectedShotRow.shot)].filter(Boolean).join(' / ')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleRegenerateSelectedVideo}
                    disabled={isQueuingVideos || yoloDependencyCheckInProgress}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isQueuingVideos ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    Run Selected With {selectedVideoWorkflowLabel}
                  </button>
                </div>
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <div>
                    <label className="block text-xs text-sf-text-secondary">
                      <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Edit shot motion prompt</span>
                      <textarea
                        value={selectedShotRow.shot.videoBeat || selectedShotRow.shot.beat || selectedShotRow.shot.shotPrompt || ''}
                        onChange={(event) => handleYoloShotVideoBeatChange?.(selectedShotRow.scene.id, selectedShotRow.shot.id, event.target.value)}
                        rows={5}
                        className="mt-1 w-full resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs leading-5 text-sf-text-primary outline-none focus:border-sf-accent"
                        placeholder="Describe the motion/action for this one video rerun..."
                      />
                    </label>
                    <p className="mt-1 text-[10px] leading-4 text-sf-text-muted">
                      This changes the selected shot's video prompt for new renders only. It does not rewrite the original director script.
                    </p>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Timing</div>
                    <div className="mt-1 rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-xs leading-5 text-sf-text-secondary">
                      <div>Start: {(Number(selectedShotRow.shot.audioStart) || 0).toFixed(2)}s</div>
                      <div>Length: {(Number(selectedShotRow.shot.length || selectedShotRow.shot.durationSeconds) || 0).toFixed(1)}s</div>
                      {selectedShotRow.shot.scriptLyricMoment && (
                        <div className="mt-1 italic text-sf-text-muted">"{selectedShotRow.shot.scriptLyricMoment}"</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {renderAdvancedVideoSettings()}
    </div>
  )

  const renderMediaPreviewModal = () => {
    if (!mediaPreview) return null

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
            {mediaPreview.prompt && (
              <div className="border-t border-sf-dark-700 px-4 py-3 text-xs leading-5 text-sf-text-secondary">
                {mediaPreview.prompt}
              </div>
            )}
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
