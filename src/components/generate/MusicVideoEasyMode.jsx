import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  CheckCircle2,
  Clipboard,
  Edit3,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Music,
  Play,
  Upload,
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
import CustomWorkflowSlotCard from './CustomWorkflowSlotCard'
import SongStep from './SongStep'
import { useVeloAllowance, VeloAllowance } from '../VeloAllowance'
import { startWatchingVelo, writeScriptWithVelo } from '../../services/veloScriptWriter.mjs'
import { groupPassBySongPart, groupShotsByPass } from '../../utils/keyframeGroups.mjs'
import { FLUX2_KLEIN_WORKFLOW_ID } from '../../services/flux2KleinWorkflow.mjs'
import { MINIMAX_H3_LOCAL_WORKFLOW_ID, MINIMAX_H3_QUALITY_LEVELS, countPictureShapes } from '../../services/minimaxH3LocalWorkflow.mjs'
import DirectorHero from './DirectorHero'
import { parseStructuredDirectorScript } from '../../utils/yoloPlanning'
import { newPlace, placeNameFromFile, placeSlug } from '../../services/musicVideoPlaces.mjs'
import { collectRouterPicture, dollars, quoteRouterPicture, routerPictureModel, routerPictureProblem, sendRouterPicture } from '../../services/routerPicture.mjs'
import { buildKeyframeBatch, runFewAtATime } from '../../services/routerKeyframes.mjs'
import { importRouterImage } from '../../services/comfyRouterImages'
import LocalModelSetup from './LocalModelSetup'
import { MINIMAX_H3_CLOUD_WORKFLOW_ID, MINIMAX_H3_CLOUD_LEVELS, MINIMAX_H3_LIP_SYNC_WORKFLOW_ID } from '../../services/minimaxH3CloudWorkflow.mjs'
import { describeSongParts, formatClock, guessSongParts, normalizeSongParts, parseSrtLines } from '../../utils/songLyricMap.mjs'

const DRAFT_STORAGE_KEY = 'comfystudio-music-video-easy-mode-draft-v1'
const DRAFT_PROJECT_STORAGE_PREFIX = `${DRAFT_STORAGE_KEY}:project:`

const STEPS = [
  { id: 'song', label: 'Song', number: '1' },
  { id: 'people', label: 'Cast and places', number: '2' },
  { id: 'script', label: 'Director Script', number: '3' },
  { id: 'keyframes', label: 'Keyframes', number: '4' },
  { id: 'videos', label: 'Videos', number: '5' },
  // The last step: putting the videos on a timeline. It used to be a box at
  // the bottom of Videos, below every shot, where it was easy to miss.
  { id: 'timeline', label: 'Timeline', number: '6' },
]

const ASPECT_RATIO_OPTIONS = [
  // Named by their ratio, the way cameras and video sites name them. The
  // little rectangle on each button shows the shape for anyone new to ratios.
  { id: 'landscape_16x9', label: '16:9', helper: 'Wide, for YouTube and TV' },
  { id: 'vertical_9x16', label: '9:16', helper: 'Tall, for TikTok, Reels and Shorts' },
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
// The five parts a music video shoot can have, in plain words, with the
// strip colour each one gets on the coverage cards.
const COVERAGE_PARTS = [
  { label: 'Main shots', colour: 'bg-[#8B7CF6]' },
  { label: 'Extra takes', colour: 'bg-[#B9AEFA]' },
  { label: 'Story shots', colour: 'bg-[#5DCAA5]' },
  { label: 'Place shots', colour: 'bg-[#EF9F27]' },
  { label: 'Detail shots', colour: 'bg-[#ED93B1]' },
]
// The parts of a script, in the same plain words as the "What else do you
// want to film?" list.
const SCRIPT_PART_NAMES = {
  main_sequence: 'Main shots',
  performance_pass: 'Extra take',
  story_broll: 'Story shots',
  environmental_broll: 'Place shots',
  detail_broll: 'Detail shots',
}
// A part's name in plain words, from whatever label it carries.
function plainPartName(label) {
  const text = String(label || '')
  if (/main|master|scripted/i.test(text)) return SCRIPT_PART_NAMES.main_sequence
  if (/performance/i.test(text)) {
    const number = text.match(/(\d+)\s*$/)
    return number ? `${SCRIPT_PART_NAMES.performance_pass} ${number[1]}` : SCRIPT_PART_NAMES.performance_pass
  }
  if (/story/i.test(text)) return SCRIPT_PART_NAMES.story_broll
  if (/environment/i.test(text)) return SCRIPT_PART_NAMES.environmental_broll
  if (/detail/i.test(text)) return SCRIPT_PART_NAMES.detail_broll
  return text
}
const COVERAGE_TYPE_LABELS = Object.freeze({
  main_sequence: 'Main sequence',
  performance_pass: 'Performance pass',
  story_broll: 'Story b-roll',
  detail_broll: 'Detail b-roll',
  environmental_broll: 'Environmental b-roll',
})
const DEFAULT_VIDEO_WORKFLOW_OPTIONS = Object.freeze([
  {
    id: MINIMAX_H3_LOCAL_WORKFLOW_ID,
    label: 'MiniMax H3',
    runtimeLabel: 'Local',
    description: 'Best lip sync. Starts from the keyframe and follows the song. Needs a strong graphics card.',
  },
  // Cloud video is parked (2026-11-11): no cloud model gave both movement and
  // lip sync that stays on the song. The H3 Lip Sync and Reference code is kept
  // but not offered. See docs/DIRECTOR_DIRECTION.md.
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
    description: 'Use your own ComfyUI video workflow as long as it keeps the Velorn input/output endpoints.',
  },
])
const DEFAULT_KEYFRAME_WORKFLOW_OPTIONS = Object.freeze([
  {
    id: FLUX2_KLEIN_WORKFLOW_ID,
    label: 'FLUX.2 klein',
    runtimeLabel: 'Local',
    description: 'Light and fast local keyframes. Keeps the cast from their pictures and also makes shots with nobody in them.',
  },
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
    description: 'Use your own ComfyUI keyframe workflow as long as it keeps the Velorn input/output endpoints.',
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

function getGeneratedKeyframeWorkflowLabel(asset, fallbackLabel) {
  const workflowId = String(asset?.yolo?.storyboardWorkflowId || '').trim()
  if (workflowId) return getWorkflowDisplayLabel(workflowId) || workflowId
  if (asset?.yolo?.storyboardFallbackReason === 'reference-free-broll') return 'Z-Image Turbo'
  return fallbackLabel
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

function ShotVideoPreview({ videoUrl, keyframeUrl, placeholderLabel = "Needs keyframe" }) {
  if (videoUrl) {
    return (
      <video
        src={videoUrl}
        className="h-full w-full object-cover opacity-80"
        muted
        playsInline
        preload="metadata"
      />
    )
  }

  if (keyframeUrl) {
    return <img src={keyframeUrl} alt="" className="h-full w-full object-cover opacity-70" loading="lazy" decoding="async" />
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
  return 'Velorn assumes a normal finished song by default. Lip-sync and b-roll routing still come from the director script.'
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

const ASR_LANGUAGE_OPTIONS = Object.freeze([
  'English',
  'Auto',
  'Portuguese',
  'Chinese',
  'Cantonese',
  'Spanish',
  'French',
  'German',
  'Italian',
  'Japanese',
  'Korean',
  'Arabic',
  'Hindi',
  'Russian',
  'Turkish',
  'Vietnamese',
  'Indonesian',
  'Malay',
  'Dutch',
  'Swedish',
  'Danish',
  'Finnish',
  'Polish',
  'Czech',
  'Filipino',
  'Persian',
  'Greek',
  'Romanian',
  'Hungarian',
  'Macedonian',
])

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
  handleImportYoloMusicAudio,
  yoloMusicAudioImporting,
  yoloMusicAudioAssetId,
  setYoloMusicAudioAssetId,
  yoloMusicAudioKind,
  setYoloMusicAudioKind,
  yoloMusicAsrLanguage = 'English',
  setYoloMusicAsrLanguage,
  yoloMusicAudioAsset,
  yoloMusicStyleNotes = '',
  setYoloMusicStyleNotes,
  yoloMusicTranscribingSrt,
  yoloMusicTranscriptionStatus,
  handleYoloMusicTranscribeSrt,
  yoloMusicProvidedLyrics,
  setYoloMusicProvidedLyrics,
  yoloMusicAlignProvidedLyrics,
  setYoloMusicAlignProvidedLyrics,
  yoloMusicSongMap,
  setYoloMusicSongMap,
  yoloMusicConcept = '',
  setYoloMusicConcept,
  yoloMusicLyrics,
  setYoloMusicLyrics,
  yoloMusicParsedLyrics,
  yoloMusicScript,
  setYoloMusicScript,
  yoloMusicCast,
  yoloMusicPlaces = [],
  setYoloMusicPlaces,
  yoloMusicResolvedCast,
  setYoloMusicCast,
  handleYoloMusicCastAdd,
  handleYoloMusicCastRemove,
  handleYoloMusicCastAssetChange,
  handleYoloMusicCastSlugChange,
  handleYoloMusicCastLabelChange,
  handleYoloMusicCastRoleChange,
  handleYoloMusicCastNotesChange,
  handleImportYoloMusicCastImage,
  yoloMusicCastImageImporting = false,
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
  yoloMusicVideoQuality = 'best',
  yoloMusicCloudVideoLevel = 'standard',
  setYoloMusicCloudVideoLevel,
  setYoloMusicVideoQuality,
  yoloMusicVideoWorkflowOptions = DEFAULT_VIDEO_WORKFLOW_OPTIONS,
  yoloMusicCustomVideoWorkflow,
  yoloMusicCustomVideoValidation,
  handleImportYoloMusicCustomVideoWorkflow,
  handleOpenYoloMusicCustomVideoWorkflowInComfyUi,
  handleClearYoloMusicCustomVideoWorkflow,
  handleOpenYoloMusicCustomStarter,
  handleUseYoloMusicLibraryWorkflow,
  yoloActivePlan,
  yoloQueueVariants,
  yoloStoryboardAssetMap,
  yoloStoryboardReadyCount,
  yoloActivePlanIsStale,
  yoloDependencyCheckInProgress,
  handleBuildActiveYoloPlan,
  handleQueueYoloStoryboards,
  handleQueueYoloShotStoryboard,
  handleQueueYoloShotStoryboards,
  handleReplaceYoloMusicKeyframe,
  handleReplaceYoloMusicVideo,
  handleQueueYoloVideos,
  handleQueueYoloShotVideo,
  handleQueueYoloShotVideos,
  handleYoloShotImageBeatChange,
  handleYoloShotNanoBananaReferencesChange,
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
  const [selectedShotIndexes, setSelectedShotIndexes] = useState([0])
  const [selectionAnchorIndex, setSelectionAnchorIndex] = useState(0)
  const [runtimeImageDimensions, setRuntimeImageDimensions] = useState({})
  const [advancedAudioOpen, setAdvancedAudioOpen] = useState(false)
  const [briefStatus, setBriefStatus] = useState('')
  // Writing the script with Velo: idle | writing | done | error
  const [veloScript, setVeloScript] = useState({ status: 'idle', shots: 0, message: '' })
  const [veloSeconds, setVeloSeconds] = useState(0)
  useEffect(() => {
    if (veloScript.status !== 'writing') return undefined
    const tick = () => setVeloSeconds(Math.max(0, Math.round((Date.now() - (veloScript.startedAt || Date.now())) / 1000)))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [veloScript.status, veloScript.startedAt])
  const veloStopRef = useRef(null)
  const veloAllowance = useVeloAllowance({ enabled: step === 'script', accountKey: 'music-video-script', revision: veloScript.status === 'done' ? 1 : 0 })
  useEffect(() => { startWatchingVelo(typeof window !== 'undefined' ? window.electronAPI?.connectedAgent : null) }, [])
  const [peopleStatus, setPeopleStatus] = useState('')
  const [parseStatus, setParseStatus] = useState('')
  const [keyframeStatus, setKeyframeStatus] = useState('')
  const [videoStatus, setVideoStatus] = useState('')
  const [timelineStatus, setTimelineStatus] = useState('')
  const [isQueuingKeyframes, setIsQueuingKeyframes] = useState(false)
  const [isQueuingVideos, setIsQueuingVideos] = useState(false)
  const [isAssemblingTimeline, setIsAssemblingTimeline] = useState(false)
  const [mediaPreview, setMediaPreview] = useState(null)
  const [replaceKeyframeTarget, setReplaceKeyframeTarget] = useState(null)
  const [replacementAssetId, setReplacementAssetId] = useState('')
  const [replacementBusy, setReplacementBusy] = useState(false)
  const [replaceVideoTarget, setReplaceVideoTarget] = useState(null)
  const [videoReplacementAssetId, setVideoReplacementAssetId] = useState('')
  const [videoReplacementBusy, setVideoReplacementBusy] = useState(false)
  const [peopleWizard, setPeopleWizard] = useState(null)
  const replacementFileInputRef = useRef(null)
  const videoReplacementFileInputRef = useRef(null)

  // Cast pictures are made with the same light local model as the keyframes.
  const peopleWizardGenerationEnabled = Boolean(canUsePeopleWizardGeneration && BUILTIN_WORKFLOW_PATHS[FLUX2_KLEIN_WORKFLOW_ID])

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

  useEffect(() => {
    if (!replaceKeyframeTarget) return
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setReplaceKeyframeTarget(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [replaceKeyframeTarget])

  useEffect(() => {
    if (!replaceVideoTarget) return
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setReplaceVideoTarget(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [replaceVideoTarget])

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
      // Simple by default: a name and a picture. "More options" opens the
      // full three-part form with the character sheet.
      advanced: false,
      step: 'image',
      entryId: entry?.id || null,
      name: String(entry?.label || ''),
      slug: String(entry?.slug || ''),
      role: String(entry?.role || 'lead'),
      notes: String(entry?.notes || ''),
      assetPrefix: normalizeCastSlug(entry?.slug || entry?.label || entry?.assetId || 'person') || 'person',
      assetId: entry?.assetId || '',
      sheetAssetId: entry?.assetId || '',
      imagePrompt: String(entryAsset?.name || entry?.label || 'Portrait of a character').trim() || 'Portrait of a character',
      imageSize: 'hd',
      imageOrientation: 'portrait',
      imageSeed: Math.floor(Math.random() * 1000000000),
      imageJobId: null,
      sheetJobId: null,
      sheetSeed: Math.floor(Math.random() * 1000000000),
      imageWorkflow: FLUX2_KLEIN_WORKFLOW_ID,
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
  const peopleWizardSelectedSheetAsset = useMemo(() => {
    if (!peopleWizard?.sheetAssetId) return null
    return imageAssets.find((asset) => asset?.id === peopleWizard.sheetAssetId) || null
  }, [imageAssets, peopleWizard?.sheetAssetId])
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
  // The shots as a storyboard of the song: tabs are the passes of the script,
  // and inside a pass the shots sit under the part of the song they fall in.
  const shotPasses = useMemo(() => groupShotsByPass(flatShots, ({ scene, shot }) => getCoverageLabel(scene, shot)), [flatShots])
  const songPartsForShots = useMemo(() => {
    const lines = parseSrtLines(yoloMusicParsedLyrics?.isTimed ? yoloMusicLyrics : '')
    if (!lines.length) return []
    return describeSongParts(lines, normalizeSongParts(yoloMusicSongMap?.parts, lines.length) || guessSongParts(lines))
  }, [yoloMusicLyrics, yoloMusicParsedLyrics?.isTimed, yoloMusicSongMap?.parts])
  const [shotPassKey, setShotPassKey] = useState('')
  const activeShotPass = shotPasses.find((pass) => pass.key === shotPassKey) || shotPasses[0] || null
  // One plain grid per tab, in shot order. The shots used to sit under verse
  // and chorus headings from the Song step; unless someone had tidied those
  // parts it made many tiny groups, and it put shots out of order when two
  // claimed the same moment (removed 2026-11-12). The Song step keeps its parts.
  const activeShotSections = useMemo(
    () => (activeShotPass ? [{ key: 'all', label: '', indexes: [...activeShotPass.indexes].sort((a, b) => a - b) }] : []),
    [activeShotPass]
  )
  const [editingPromptIndex, setEditingPromptIndex] = useState(-1)
  const [editingMotionIndex, setEditingMotionIndex] = useState(-1)
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
  const nanoBananaKeyframeSelected = selectedKeyframeWorkflowId === 'nano-banana-2' || selectedKeyframeWorkflowId === 'nano-banana-pro'
  const customKeyframeWorkflowSelected = selectedKeyframeWorkflowId === CUSTOM_MUSIC_KEYFRAME_WORKFLOW_ID
  const customVideoWorkflowSelected = selectedVideoWorkflowId === CUSTOM_MUSIC_VIDEO_WORKFLOW_ID
  const customKeyframeWorkflowLoaded = Boolean(String(yoloMusicCustomKeyframeWorkflow?.jsonText || '').trim())
  const customKeyframeWorkflowName = String(yoloMusicCustomKeyframeWorkflow?.name || '').trim()
  const customVideoWorkflowLoaded = Boolean(String(yoloMusicCustomVideoWorkflow?.jsonText || '').trim())
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
  const providedLyricsLineCount = useMemo(
    () => String(yoloMusicProvidedLyrics || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean).length,
    [yoloMusicProvidedLyrics]
  )
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
  // The script was approved before and has been edited since.
  const scriptHasUnusedChanges = Boolean(yoloActivePlanIsStale) && plannedShotCount > 0
  const canQueueVideos = canQueueKeyframes && yoloStoryboardReadyCount > 0 && customVideoReady
  const normalizedSelectedShotIndexes = useMemo(() => {
    if (flatShots.length === 0) return []
    const valid = (Array.isArray(selectedShotIndexes) ? selectedShotIndexes : [])
      .filter((index) => Number.isInteger(index) && index >= 0 && index < flatShots.length)
    const unique = Array.from(new Set(valid))
    if (unique.length === 0) {
      const fallback = Math.max(0, Math.min(selectedShotIndex, flatShots.length - 1))
      return [fallback]
    }
    return unique.sort((a, b) => a - b)
  }, [flatShots.length, selectedShotIndex, selectedShotIndexes])
  const selectedShotIndexSet = useMemo(() => new Set(normalizedSelectedShotIndexes), [normalizedSelectedShotIndexes])
  const selectedShotRows = useMemo(() => (
    normalizedSelectedShotIndexes
      .map((index) => ({ ...(flatShots[index] || {}), index }))
      .filter((row) => row?.scene && row?.shot)
  ), [flatShots, normalizedSelectedShotIndexes])
  const hasMultipleSelectedShots = selectedShotRows.length > 1
  const selectedShotCount = selectedShotRows.length
  const selectedShotRow = selectedShotRows[0] || flatShots[selectedShotIndex] || flatShots[0] || null
  const keyframeStatusIsWarning = keyframeStatus.startsWith('All your keyframes')
  const singleKeyframeActionDisabled = isQueuingKeyframes || yoloDependencyCheckInProgress || !customKeyframeReady || yoloActivePlanIsStale
  const singleVideoActionDisabled = isQueuingVideos || yoloDependencyCheckInProgress || !customVideoReady
  const replaceKeyframeActionDisabled = replacementBusy || !handleReplaceYoloMusicKeyframe || yoloActivePlanIsStale || plannedShotCount === 0
  const replaceVideoActionDisabled = videoReplacementBusy || !handleReplaceYoloMusicVideo || yoloActivePlanIsStale || plannedShotCount === 0
  const canOpenCustomKeyframeWorkflow = !customKeyframeWorkflowLoaded || Boolean(customKeyframeValidation.ok)
  const canOpenCustomVideoWorkflow = !customVideoWorkflowLoaded || Boolean(customVideoValidation.ok)
  const replacementImageAssets = useMemo(() => (
    (assets || [])
      .filter((asset) => {
        if (asset?.type !== 'image') return false
        const mime = String(asset?.mimeType || '').toLowerCase()
        const name = [asset?.name, asset?.path, asset?.url].filter(Boolean).join(' ').toLowerCase()
        if (mime && !mime.startsWith('image/')) return false
        return /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(name) || mime.startsWith('image/')
      })
      .sort((a, b) => new Date(b?.createdAt || b?.imported || 0).getTime() - new Date(a?.createdAt || a?.imported || 0).getTime())
  ), [assets])
  const selectedReplacementAsset = useMemo(
    () => replacementImageAssets.find((asset) => asset?.id === replacementAssetId) || null,
    [replacementAssetId, replacementImageAssets]
  )
  const replacementVideoAssets = useMemo(() => (
    (assets || [])
      .filter((asset) => {
        if (asset?.type !== 'video') return false
        const mime = String(asset?.mimeType || '').toLowerCase()
        const name = [asset?.name, asset?.path, asset?.url].filter(Boolean).join(' ').toLowerCase()
        if (mime && !mime.startsWith('video/')) return false
        return /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(name) || mime.startsWith('video/')
      })
      .sort((a, b) => new Date(b?.createdAt || b?.imported || 0).getTime() - new Date(a?.createdAt || a?.imported || 0).getTime())
  ), [assets])
  const selectedVideoReplacementAsset = useMemo(
    () => replacementVideoAssets.find((asset) => asset?.id === videoReplacementAssetId) || null,
    [videoReplacementAssetId, replacementVideoAssets]
  )

  useEffect(() => {
    if (flatShots.length === 0) {
      if (selectedShotIndex !== 0) setSelectedShotIndex(0)
      setSelectedShotIndexes([])
      setSelectionAnchorIndex(0)
      return
    }
    const clampedSelectedIndex = Math.max(0, Math.min(selectedShotIndex, flatShots.length - 1))
    if (selectedShotIndex !== clampedSelectedIndex) {
      setSelectedShotIndex(clampedSelectedIndex)
    }
    setSelectionAnchorIndex((current) => Math.max(0, Math.min(current, flatShots.length - 1)))
    setSelectedShotIndexes((current) => {
      const valid = (Array.isArray(current) ? current : [])
        .filter((index) => Number.isInteger(index) && index >= 0 && index < flatShots.length)
      const unique = Array.from(new Set(valid)).sort((a, b) => a - b)
      const next = unique.length > 0 ? unique : [clampedSelectedIndex]
      if (next.length === current.length && next.every((value, index) => value === current[index])) return current
      return next
    })
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

  // What is finished, for the ticks in the step bar.
  // Set once the videos have been put on a timeline, for the last step's tick.
  const [timelinePlaced, setTimelinePlaced] = useState(false)
  const stepDone = {
    song: Boolean(yoloMusicAudioAsset && yoloMusicParsedLyrics?.isTimed),
    people: (yoloMusicCast || []).length > 0,
    script: plannedShotCount > 0,
    keyframes: plannedShotCount > 0 && yoloStoryboardReadyCount >= plannedShotCount,
    videos: plannedShotCount > 0 && videoReadyCount >= plannedShotCount,
    timeline: timelinePlaced,
  }


  // The script read as a list of shots, for the Director Script step. The text
  // itself stays the thing that is saved and edited.
  const [scriptTextOpen, setScriptTextOpen] = useState(false)
  const scriptShots = useMemo(() => {
    try {
      const parsed = parseStructuredDirectorScript(yoloMusicScript, { takesPerAngle: 1 })
      const scenes = Array.isArray(parsed) ? parsed : (parsed?.scenes || [])
      return scenes.flatMap((scene) => (scene?.shots || []).map((shot) => ({ ...shot, part: scene?.coverageSectionLabel || scene?.label || '' })))
    } catch {
      return []
    }
  }, [yoloMusicScript])
  // The script's parts, for the tabs above the shot list: the video itself,
  // each extra singing take, story shots, places, close-up details.
  const [scriptTab, setScriptTab] = useState('')
  const scriptParts = useMemo(() => {
    const parts = []
    const byKey = new Map()
    scriptShots.forEach((shot, index) => {
      const type = SCRIPT_PART_NAMES[shot.coverageType] ? shot.coverageType : 'main_sequence'
      const key = `${type}:${shot.coverageSectionIndex || ''}`
      if (!byKey.has(key)) {
        const part = { key, type, rows: [] }
        byKey.set(key, part)
        parts.push(part)
      }
      byKey.get(key).rows.push({ shot, index })
    })
    const takes = parts.filter((part) => part.type === 'performance_pass')
    return parts.map((part) => ({
      ...part,
      label: part.type === 'performance_pass' && takes.length > 1
        ? `${SCRIPT_PART_NAMES.performance_pass} ${takes.indexOf(part) + 1}`
        : SCRIPT_PART_NAMES[part.type],
    }))
  }, [scriptShots])
  const scriptPartShown = scriptTab === 'all' ? null : (scriptParts.find((part) => part.key === scriptTab) || scriptParts[0] || null)
  const scriptRowsShown = scriptParts.length > 1 && scriptPartShown
    ? scriptPartShown.rows
    : scriptShots.map((shot, index) => ({ shot, index }))

  // ---------- Where pictures are made ----------
  // One choice for the Cast and places step: FLUX on this computer (free), or
  // the cloud picture model through Comfy Router (costs credits, asked each time).
  const [pictureMaker, setPictureMaker] = useState(() => {
    try {
      const saved = window.localStorage.getItem('velorn.director.pictureMaker')
      return ['cloud', 'custom'].includes(saved) ? saved : 'local'
    } catch { return 'local' }
  })
  const choosePictureMaker = (next) => {
    setPictureMaker(next)
    setPlaceQuote(null)
    setPlaceCloudError('')
    try { window.localStorage.setItem('velorn.director.pictureMaker', next) } catch { /* the choice still holds for this visit */ }
  }
  const [cloudPictureModel, setCloudPictureModel] = useState(null)
  useEffect(() => {
    let alive = true
    routerPictureModel(window.electronAPI?.comfyRouter).then((model) => { if (alive) setCloudPictureModel(model) })
    return () => { alive = false }
  }, [])
  const cloudPicturesOn = pictureMaker === 'cloud' && Boolean(cloudPictureModel)
  // A price waiting for a yes: { key: 'new' or a place id, planId, usd, description, label }.
  const [placeQuote, setPlaceQuote] = useState(null)
  const [placeQuoteBusy, setPlaceQuoteBusy] = useState(false)
  const [placeCloudError, setPlaceCloudError] = useState('')
  const [placeCloudBusy, setPlaceCloudBusy] = useState({})
  const placePictureText = (description) => `${String(description || '').trim()}. Wide establishing shot of the place, no text.`
  const askPlacePrice = async (key, description, label) => {
    setPlaceCloudError('')
    setPlaceQuote(null)
    setPlaceQuoteBusy(true)
    const quote = await quoteRouterPicture({
      api: window.electronAPI?.comfyRouter,
      modelId: cloudPictureModel.id,
      size: cloudPictureModel.size,
      prompt: placePictureText(description),
      shape: aspectRatio === 'vertical_9x16' ? 'portrait' : 'landscape',
    })
    setPlaceQuoteBusy(false)
    if (!quote.success) { setPlaceCloudError(quote.error); return }
    setPlaceQuote({ key, planId: quote.planId, usd: quote.usd, description, label })
  }
  // Runs straight from the click on the price button: that click is the approval.
  const confirmPlaceQuote = async () => {
    const quote = placeQuote
    if (!quote) return
    const api = window.electronAPI?.comfyRouter
    const sent = await sendRouterPicture({ api, planId: quote.planId })
    if (!sent.success) { setPlaceCloudError(sent.error); return }
    setPlaceQuote(null)
    let placeId = quote.key
    if (quote.key === 'new') {
      const entry = newPlace({ label: quote.label, notes: quote.description, pendingJobTag: `router:${sent.jobId}` }, yoloMusicPlaces || [])
      placeId = entry.id
      setYoloMusicPlaces?.((prev) => [...(Array.isArray(prev) ? prev : []), entry])
      setPlaceIdea('')
      setPlaceIdeaOpen(false)
    } else {
      changePlace(placeId, { pendingJobTag: `router:${sent.jobId}` })
    }
    setPlaceCloudBusy((busy) => ({ ...busy, [placeId]: true }))
    const made = await collectRouterPicture({ api, jobId: sent.jobId, importImage: importRouterImage })
    setPlaceCloudBusy((busy) => { const next = { ...busy }; delete next[placeId]; return next })
    if (made.success) changePlace(placeId, { assetId: made.assetId, pendingJobTag: '' })
    else { changePlace(placeId, { pendingJobTag: '' }); setPlaceCloudError(made.error) }
  }
  const renderPicturePrice = (quote, onYes, onNo) => (
    <div className="rounded-lg border border-sf-accent/40 bg-sf-accent/10 p-3 text-left text-xs leading-5 text-sf-text-secondary">
      <div>
        This picture costs about <span className="font-semibold text-sf-text-primary">{dollars(quote.usd)}</span>
        {cloudPictureModel?.creditsPerUsd && quote.usd != null ? ` (${Math.round(quote.usd * cloudPictureModel.creditsPerUsd)} credits)` : ''} on your Comfy account.
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onYes}
          className="rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent-hover"
        >
          Make it for {dollars(quote.usd)}
        </button>
        <button
          type="button"
          onClick={onNo}
          className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
        >
          Cancel
        </button>
      </div>
    </div>
  )
  const renderPlacePrice = () => renderPicturePrice(placeQuote, confirmPlaceQuote, () => setPlaceQuote(null))

  // A new person's picture through the cloud model, inside the person window.
  const [personQuote, setPersonQuote] = useState(null)
  const [personQuoteBusy, setPersonQuoteBusy] = useState(false)
  const [personCloudBusy, setPersonCloudBusy] = useState(false)
  const [personCloudError, setPersonCloudError] = useState('')
  const askPersonPrice = async () => {
    setPersonCloudError('')
    setPersonQuote(null)
    setPersonQuoteBusy(true)
    const quote = await quoteRouterPicture({
      api: window.electronAPI?.comfyRouter,
      modelId: cloudPictureModel.id,
      size: cloudPictureModel.size,
      prompt: String(peopleWizard?.imagePrompt || '').trim() || `${peopleWizard?.name || 'Character'} portrait`,
      shape: String(peopleWizard?.imageOrientation || '') === 'landscape' ? 'landscape' : 'portrait',
    })
    setPersonQuoteBusy(false)
    if (!quote.success) { setPersonCloudError(quote.error); return }
    setPersonQuote({ planId: quote.planId, usd: quote.usd })
  }
  // Runs straight from the click on the price button: that click is the approval.
  const confirmPersonQuote = async () => {
    const quote = personQuote
    if (!quote) return
    const api = window.electronAPI?.comfyRouter
    const sent = await sendRouterPicture({ api, planId: quote.planId })
    if (!sent.success) { setPersonCloudError(sent.error); return }
    setPersonQuote(null)
    setPersonCloudBusy(true)
    const made = await collectRouterPicture({ api, jobId: sent.jobId, importImage: importRouterImage })
    setPersonCloudBusy(false)
    if (!made.success) { setPersonCloudError(made.error); return }
    // A fresh session id, so a FLUX picture made earlier in this window does
    // not take the place of the new one.
    updatePeopleWizard({ assetId: made.assetId, sessionId: `wizard-${Date.now()}` })
  }

  const renderPictureMakerRow = () => (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 px-4 py-3">
        <span className="text-sm font-semibold text-sf-text-primary">Pictures are made with</span>
        <div role="group" aria-label="Where pictures are made" className="inline-flex overflow-hidden rounded-lg border border-sf-dark-600">
          <button
            type="button"
            aria-pressed={pictureMaker === 'local'}
            onClick={() => choosePictureMaker('local')}
            className={`px-3 py-1.5 text-xs font-semibold transition-colors ${pictureMaker === 'local' ? 'bg-sf-accent text-white' : 'text-sf-text-secondary hover:bg-sf-dark-800 hover:text-sf-text-primary'}`}
          >
            FLUX
          </button>
          <button
            type="button"
            aria-pressed={pictureMaker === 'cloud'}
            disabled={!cloudPictureModel}
            onClick={() => choosePictureMaker('cloud')}
            className={`px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${pictureMaker === 'cloud' ? 'bg-sf-accent text-white' : 'text-sf-text-secondary hover:bg-sf-dark-800 hover:text-sf-text-primary'}`}
          >
            {cloudPictureModel?.name || 'Cloud'}
          </button>
          <button
            type="button"
            aria-pressed={pictureMaker === 'custom'}
            onClick={() => choosePictureMaker('custom')}
            title="For people who build their own ComfyUI workflows."
            className={`px-3 py-1.5 text-xs font-semibold transition-colors ${pictureMaker === 'custom' ? 'bg-sf-accent text-white' : 'text-sf-text-secondary hover:bg-sf-dark-800 hover:text-sf-text-primary'}`}
          >
            My own workflow
          </button>
        </div>
        <span className="text-xs text-sf-text-muted">
          {cloudPicturesOn
            ? `In the cloud, through Comfy. About ${dollars(cloudPictureModel.usd)} a picture, and you see the price before each one.`
            : pictureMaker === 'custom'
              ? 'A ComfyUI workflow of your own makes the keyframes. People and places are still made with FLUX.'
              : 'Free, on this computer.'}
        </span>
      </div>
  )

  // The Keyframes step has one model choice (the row at the top). The older
  // second choice is gone: 'My own workflow' in that row stands for Custom
  // Workflow, and any other local model goes to FLUX.
  useEffect(() => {
    const wanted = pictureMaker === 'custom' ? CUSTOM_MUSIC_KEYFRAME_WORKFLOW_ID : FLUX2_KLEIN_WORKFLOW_ID
    if (selectedKeyframeWorkflowId && selectedKeyframeWorkflowId !== wanted
      && keyframeWorkflowOptions.some((option) => option.id === wanted)) handleKeyframeWorkflowChange(wanted)
    // Only the chosen model and the choice at the top matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKeyframeWorkflowId, pictureMaker])

  // The Videos step offers MiniMax H3, or a ComfyUI workflow of the person's
  // own. Any other model a project had chosen goes to MiniMax H3.
  const [videoMaker, setVideoMaker] = useState(() => {
    try { return window.localStorage.getItem('velorn.director.videoMaker') === 'custom' ? 'custom' : 'h3' } catch { return 'h3' }
  })
  const chooseVideoMaker = (next) => {
    setVideoMaker(next)
    try { window.localStorage.setItem('velorn.director.videoMaker', next) } catch { /* the choice still holds for this visit */ }
  }
  useEffect(() => {
    const wanted = videoMaker === 'custom' ? CUSTOM_MUSIC_VIDEO_WORKFLOW_ID : MINIMAX_H3_LOCAL_WORKFLOW_ID
    if (selectedVideoWorkflowId && selectedVideoWorkflowId !== wanted
      && videoWorkflowOptions.some((option) => option.id === wanted)) handleVideoWorkflowChange(wanted)
    // Only the chosen model and the choice at the top matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVideoWorkflowId, videoMaker])

  // ---------- Keyframes in the cloud ----------
  // With the cloud model chosen, keyframes go through Comfy Router as one
  // batch: one price, one approval, then each picture lands on its shot.
  const [cloudKeyframes, setCloudKeyframes] = useState({ phase: 'idle' })
  // The shots being made in the cloud right now, so their cards can say so.
  const [cloudMakingShots, setCloudMakingShots] = useState({})
  const shotKey = (row) => `${row.scene.id}|${row.shot.id}`
  // The newest version of the "put this picture on this shot" function: a
  // picture that has just arrived is only known to the newest one.
  const placeKeyframeRef = useRef(handleReplaceYoloMusicKeyframe)
  placeKeyframeRef.current = handleReplaceYoloMusicKeyframe
  const picturesNotRead = useRef(0)
  // A reference picture, made small enough to send: at most 1280 on its long side.
  const loadReferencePicture = async (assetId) => {
    const asset = imageAssets.find((entry) => entry?.id === assetId)
    const url = asset ? (getAssetUrl(asset) || asset.url) : ''
    if (!url) { picturesNotRead.current += 1; return null }
    try {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url })
      const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(256, Math.round(image.naturalWidth * scale))
      canvas.height = Math.max(256, Math.round(image.naturalHeight * scale))
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
      const data = canvas.toDataURL('image/jpeg', 0.9)
      return { mimeType: 'image/jpeg', base64: data.slice(data.indexOf(',') + 1) }
    } catch {
      picturesNotRead.current += 1
      return null
    }
  }
  const askCloudKeyframesPrice = async (rows) => {
    if (cloudKeyframes.phase !== 'idle' && cloudKeyframes.phase !== 'confirm') return
    if (!rows.length) { setKeyframeStatus('There are no shots to make.'); return }
    setKeyframeStatus('')
    setCloudKeyframes({ phase: 'pricing', count: rows.length })
    picturesNotRead.current = 0
    const batch = await buildKeyframeBatch({
      rows: rows.map((row) => ({ row, prompt: row.shot.referenceImagePrompt || row.shot.imageBeat || '', assetIds: row.shot.resolvedArtistAssetIds || [] })),
      loadPicture: loadReferencePicture,
      shape: aspectRatio === 'vertical_9x16' ? 'portrait' : 'landscape',
      size: cloudPictureModel.size,
    })
    if (!batch.items.length) { setCloudKeyframes({ phase: 'idle' }); setKeyframeStatus('These shots have no keyframe text yet.'); return }
    let plan = null
    try { plan = await window.electronAPI?.comfyRouter?.previewCreateBatch?.({ modelId: cloudPictureModel.id, items: batch.items, pictures: batch.pictures }) } catch (error) { plan = { success: false, error: error?.message } }
    if (!plan?.success) {
      setCloudKeyframes({ phase: 'idle' })
      setKeyframeStatus(plan ? routerPictureProblem(plan) : 'Cloud keyframes need Velorn to be restarted once.')
      return
    }
    setCloudKeyframes({
      phase: 'confirm', planId: plan.planId, usd: plan.estimate?.usd ?? null, rows: batch.rows.map((entry) => entry.row),
      leftOut: batch.leftOut, clickApproves: Boolean(plan.buttonApproval), picturesNotRead: picturesNotRead.current,
    })
  }
  // Runs straight from the click on the price button.
  const confirmCloudKeyframes = async () => {
    const run = cloudKeyframes
    if (run.phase !== 'confirm') return
    const api = window.electronAPI?.comfyRouter
    const sending = (async () => {
      try { return await api.submitCreate({ planId: run.planId }) } catch { return { success: false, error: 'Press the button once more to send them.' } }
    })()
    setCloudKeyframes({ ...run, phase: 'sending' })
    setCloudMakingShots(Object.fromEntries(run.rows.map((row) => [shotKey(row), true])))
    const sent = await sending
    if (!sent?.success) {
      setCloudMakingShots({})
      setCloudKeyframes(sent?.code === 'COMFY_ROUTER_DECLINED' ? { phase: 'idle' } : { ...run, phase: 'confirm' })
      setKeyframeStatus(sent?.code === 'COMFY_ROUTER_DECLINED' ? 'Nothing was sent.' : routerPictureProblem(sent))
      return
    }
    const jobs = sent.jobs?.length ? sent.jobs : [sent.job]
    let done = 0
    let failed = 0
    let lastError = ''
    let placing = Promise.resolve()
    setCloudKeyframes({ phase: 'making', total: jobs.length, done, failed, notSent: run.rows.length - jobs.length })
    // Only the shots Comfy accepted are still being made.
    setCloudMakingShots(Object.fromEntries(run.rows.slice(0, jobs.length).map((row) => [shotKey(row), true])))
    await runFewAtATime(jobs, async (job, index) => {
      const row = run.rows[index]
      const made = await collectRouterPicture({ api, jobId: job.jobId, importImage: importRouterImage })
      let ok = made.success
      if (ok) {
        // One at a time, and after the screen has taken in the new picture.
        placing = placing.then(async () => {
          await new Promise((resolve) => setTimeout(resolve, 120))
          try { await placeKeyframeRef.current?.({ sceneId: row.scene.id, shotId: row.shot.id, assetId: made.assetId }) } catch (error) { ok = false; lastError = error?.message || '' }
        })
        await placing
      } else {
        lastError = made.error || ''
      }
      if (ok) done += 1; else failed += 1
      setCloudMakingShots((making) => { const next = { ...making }; delete next[shotKey(row)]; return next })
      setCloudKeyframes((current) => (current.phase === 'making' ? { ...current, done, failed } : current))
    }, 4)
    setCloudKeyframes({ phase: 'idle' })
    setCloudMakingShots({})
    const notSent = run.rows.length - jobs.length
    setKeyframeStatus([
      `${plural(done, 'keyframe')} made.`,
      failed ? `${failed} could not be made${lastError ? `: ${lastError}` : '.'}` : '',
      notSent > 0 ? `${notSent} were not sent, because Comfy refused one and Velorn stopped there.` : '',
    ].filter(Boolean).join(' '))
  }
  const cloudKeyframesBusy = ['pricing', 'sending', 'making'].includes(cloudKeyframes.phase)
  const renderCloudKeyframes = () => {
    const run = cloudKeyframes
    if (run.phase === 'idle') return null
    const credits = cloudPictureModel?.creditsPerUsd && run.usd != null ? ` (${Math.round(run.usd * cloudPictureModel.creditsPerUsd)} credits)` : ''
    return (
      // Pinned to the bottom of the window, so it is in view wherever the
      // button that started it sits on a long page.
      <div className="fixed bottom-6 left-1/2 z-[70] w-[min(560px,92vw)] -translate-x-1/2 rounded-xl border border-sf-accent/60 bg-sf-dark-900 p-4 text-xs leading-5 text-sf-text-secondary shadow-2xl ring-1 ring-black/40" role="status" aria-live="polite">
        {run.phase === 'pricing' && <div className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Working out the price for {plural(run.count, 'keyframe')}…</div>}
        {run.phase === 'confirm' && (
          <>
            <div className="text-sm text-sf-text-primary">
              <span className="font-semibold">{plural(run.rows.length, 'keyframe')}</span> with {cloudPictureModel?.name}: about <span className="font-semibold">{dollars(run.usd)}</span>{credits} on your Comfy account.
            </div>
            {!run.clickApproves && <div className="mt-1">Because this is more than $2, Velorn asks you to confirm once more in a small window.</div>}
            {run.leftOut > 0 && <div className="mt-1">{run.leftOut} more shots did not fit in this batch. Make those afterwards.</div>}
            {run.picturesNotRead > 0 && <div className="mt-1 text-amber-200">{plural(run.picturesNotRead, 'reference picture')} could not be read, so those shots go without it.</div>}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={confirmCloudKeyframes} className="rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent-hover">
                Make them for {dollars(run.usd)}
              </button>
              <button type="button" onClick={() => setCloudKeyframes({ phase: 'idle' })} className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary">
                Cancel
              </button>
            </div>
          </>
        )}
        {run.phase === 'sending' && <div className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Sending {plural(run.rows.length, 'keyframe')} to Comfy. A big batch can take a few minutes. Keep Velorn open.</div>}
        {run.phase === 'making' && (
          <>
            <div className="flex items-center justify-between gap-3 text-sm text-sf-text-primary">
              <span>Making keyframes: <span className="font-semibold">{run.done} of {run.total}</span> done</span>
              {run.failed > 0 && <span className="text-xs text-amber-200">{run.failed} failed</span>}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sf-dark-800">
              <div className="h-full rounded-full bg-sf-accent transition-all" style={{ width: `${Math.round(((run.done + run.failed) / Math.max(1, run.total)) * 100)}%` }} />
            </div>
            <div className="mt-2">Each one appears on its shot as it arrives. Keep Velorn open.</div>
          </>
        )}
      </div>
    )
  }

  // ---------- Places ----------
  const [placeIdea, setPlaceIdea] = useState('')
  const [placeIdeaOpen, setPlaceIdeaOpen] = useState(false)
  const changePlace = (id, changes) => setYoloMusicPlaces?.((prev) => (Array.isArray(prev) ? prev : []).map((entry) => {
    if (entry.id !== id) return entry
    const next = { ...entry, ...changes }
    // The script uses the name, so the short name follows it.
    if (Object.prototype.hasOwnProperty.call(changes, 'label')) next.slug = placeSlug(changes.label) || entry.slug
    return next
  }))
  const removePlace = (id) => setYoloMusicPlaces?.((prev) => (Array.isArray(prev) ? prev : []).filter((entry) => entry.id !== id))
  const handleAddPlaceFromPicture = async () => {
    if (!handleImportYoloMusicCastImage || yoloMusicCastImageImporting) return
    const asset = await handleImportYoloMusicCastImage({ addToCast: false })
    if (!asset) return
    setYoloMusicPlaces?.((prev) => {
      const list = Array.isArray(prev) ? prev : []
      return [...list, newPlace({ label: placeNameFromFile(asset.name), assetId: asset.id }, list)]
    })
  }
  // Asks the picture model for a place picture and returns the tag the new
  // picture will carry, so the place can pick it up when it arrives.
  const queuePlacePicture = (description, name) => {
    const tag = `place-${Date.now()}`
    const orientation = aspectRatio === 'vertical_9x16' ? 'portrait' : 'landscape'
    queuePeopleWizardJob({
      workflowId: FLUX2_KLEIN_WORKFLOW_ID,
      workflowLabel: 'FLUX.2 klein',
      prompt: `${description}. Wide establishing shot of the place, no text.`,
      resolution: resolvePeopleWizardImageResolution('hd', orientation),
      needsImage: false,
      peopleWizard: { wizardId: tag, stage: 'image', entryId: null, mode: 'create', assetPrefix: placeSlug(name) || 'place', imageSize: 'hd', imageOrientation: orientation },
    })
    return tag
  }
  // A new picture for a place you already have, from what is written on its
  // card. The old picture stays until the new one arrives.
  const handleRemakePlace = (entry) => {
    const description = String(entry?.notes || '').trim() || String(entry?.label || '').trim()
    if (!description) return
    if (cloudPicturesOn) { void askPlacePrice(entry.id, description, entry.label); return }
    if (!queuePeopleWizardJob) return
    changePlace(entry.id, { pendingJobTag: queuePlacePicture(description, entry.label) })
  }
  const handleMakePlace = () => {
    const idea = placeIdea.trim()
    if (!idea) return
    const label = idea.split(/[,.;:]/)[0].trim().split(/\s+/).slice(0, 4).join(' ')
    if (cloudPicturesOn) { void askPlacePrice('new', idea, label); return }
    if (!queuePeopleWizardJob) return
    const tag = queuePlacePicture(idea, label)
    setYoloMusicPlaces?.((prev) => {
      const list = Array.isArray(prev) ? prev : []
      return [...list, newPlace({ label, notes: idea, pendingJobTag: tag }, list)]
    })
    setPlaceIdea('')
    setPlaceIdeaOpen(false)
  }
  // A place being made gets its picture as soon as the picture arrives.
  useEffect(() => {
    const waiting = (yoloMusicPlaces || []).filter((entry) => entry.pendingJobTag)
    if (waiting.length === 0) return
    const arrived = waiting
      .map((entry) => ({ entry, asset: imageAssets.find((asset) => asset?.peopleWizard?.wizardId === entry.pendingJobTag) }))
      .filter((pair) => pair.asset)
    if (arrived.length === 0) return
    setYoloMusicPlaces?.((prev) => (Array.isArray(prev) ? prev : []).map((entry) => {
      const hit = arrived.find((pair) => pair.entry.id === entry.id)
      return hit ? { ...entry, assetId: hit.asset.id, pendingJobTag: '' } : entry
    }))
  }, [yoloMusicPlaces, imageAssets, setYoloMusicPlaces])
  // How tall the fixed heading is, so a step can pin its own bar right under it.
  const fixedTopRef = useRef(null)
  const [fixedTopHeight, setFixedTopHeight] = useState(0)
  const [fullTopHeight, setFullTopHeight] = useState(0)
  const smallRef = useRef(false)
  useEffect(() => {
    const node = fixedTopRef.current
    if (!node || typeof ResizeObserver === 'undefined') return undefined
    const measure = () => {
      const height = Math.round(node.getBoundingClientRect().height)
      setFixedTopHeight(height)
      // The full size is remembered while the heading is big. When it shrinks, the
      // space it gave up is kept below it, so the step underneath does not jump.
      if (!smallRef.current) setFullTopHeight(height)
    }
    measure()
    const watcher = new ResizeObserver(measure)
    watcher.observe(node)
    return () => watcher.disconnect()
  }, [])
  // Scrolling down shrinks the heading; back at the top it grows again. It only
  // shrinks when there is plenty left to scroll, so a short page never flickers.
  const [scrolledDown, setScrolledDown] = useState(false)
  useEffect(() => {
    let scroller = fixedTopRef.current?.parentElement
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
    if (!scroller) return undefined
    const onScroll = () => {
      const room = scroller.scrollHeight - scroller.clientHeight
      const small = smallRef.current ? scroller.scrollTop > 8 : scroller.scrollTop > 60 && room > 200
      smallRef.current = small
      setScrolledDown(small)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [])
  const isStepDisabled = (stepId) => {
    if (stepId === 'keyframes') return plannedShotCount === 0
    if (stepId === 'videos') return plannedShotCount === 0
    if (stepId === 'timeline') return plannedShotCount === 0
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

  const handleShotSelection = (event, index) => {
    if (!Number.isInteger(index) || index < 0 || index >= flatShots.length) return
    if (event?.shiftKey) {
      const anchor = Math.max(0, Math.min(selectionAnchorIndex, flatShots.length - 1))
      const start = Math.min(anchor, index)
      const end = Math.max(anchor, index)
      const range = []
      for (let cursor = start; cursor <= end; cursor += 1) range.push(cursor)
      setSelectedShotIndexes(range)
      setSelectedShotIndex(index)
      return
    }
    if (event?.metaKey || event?.ctrlKey) {
      const valid = (Array.isArray(selectedShotIndexes) ? selectedShotIndexes : [])
        .filter((value) => Number.isInteger(value) && value >= 0 && value < flatShots.length)
      const isRemoving = valid.includes(index)
      const next = isRemoving
        ? valid.filter((value) => value !== index)
        : [...valid, index]
      const normalized = (next.length > 0 ? Array.from(new Set(next)) : [index]).sort((a, b) => a - b)
      setSelectedShotIndexes(normalized)
      setSelectedShotIndex(isRemoving && normalized[0] !== index ? normalized[0] : index)
      setSelectionAnchorIndex(index)
      return
    }
    setSelectedShotIndex(index)
    setSelectedShotIndexes([index])
    setSelectionAnchorIndex(index)
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
      handleShotSelection(event, index)
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

  const openReplaceVideoDialog = (row, index) => {
    if (!row || replaceVideoActionDisabled) return
    const variant = getVariantForShot(row.scene.id, row.shot.id)
    if (!variant?.key) {
      setVideoStatus('Press Use this script in the Director Script step before replacing a video for this shot.')
      return
    }
    const existingAsset = getVideoAssetForVariant(variant)
    setSelectedShotIndex(index)
    setSelectedShotIndexes([index])
    setSelectionAnchorIndex(index)
    setMediaPreview(null)
    setReplaceVideoTarget({
      sceneId: row.scene.id,
      shotId: row.shot.id,
      shotIndex: index,
      workflowId: selectedVideoWorkflowId,
      label: `Shot ${index + 1}: ${row.shot.scriptShotLabel || row.scene.label || row.shot.id}`,
      existingAssetId: existingAsset?.id || '',
    })
    setVideoReplacementAssetId('')
  }

  const closeReplaceVideoDialog = () => {
    if (videoReplacementBusy) return
    setReplaceVideoTarget(null)
    setVideoReplacementAssetId('')
    if (videoReplacementFileInputRef.current) videoReplacementFileInputRef.current.value = ''
  }

  const replaceVideoWithPayload = async (payload) => {
    if (!replaceVideoTarget || videoReplacementBusy || !handleReplaceYoloMusicVideo) return
    setVideoReplacementBusy(true)
    setVideoStatus(`Replacing video for Shot ${replaceVideoTarget.shotIndex + 1}...`)
    try {
      const replacement = await handleReplaceYoloMusicVideo({
        sceneId: replaceVideoTarget.sceneId,
        shotId: replaceVideoTarget.shotId,
        workflowId: replaceVideoTarget.workflowId || selectedVideoWorkflowId,
        ...payload,
      })
      if (replacement) {
        setVideoStatus(`Replaced video for Shot ${replaceVideoTarget.shotIndex + 1}. Assemble Timeline will use the new clip.`)
        setReplaceVideoTarget(null)
        setVideoReplacementAssetId('')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Could not replace video.')
      setVideoStatus(`Could not replace video: ${message}`)
    } finally {
      setVideoReplacementBusy(false)
      if (videoReplacementFileInputRef.current) videoReplacementFileInputRef.current.value = ''
    }
  }

  const handleUseSelectedVideoReplacementAsset = () => {
    if (!videoReplacementAssetId) {
      setVideoStatus('Choose a video asset to use as the replacement clip.')
      return
    }
    void replaceVideoWithPayload({ assetId: videoReplacementAssetId })
  }

  const handleVideoReplacementFileChange = (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    void replaceVideoWithPayload({ file })
  }

  const renderReplaceVideoButton = (row, index, label = 'Replace') => (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        openReplaceVideoDialog(row, index)
      }}
      disabled={replaceVideoActionDisabled || !row}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-sf-dark-600 bg-sf-dark-900/85 px-2 py-1 text-[10px] font-semibold text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
      title={replaceVideoActionDisabled ? 'Videos cannot be replaced right now.' : 'Replace this shot video with a project/imported video'}
    >
      <Upload className="h-3 w-3" />
      {label}
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

  const openReplaceKeyframeDialog = (row, index) => {
    if (!row || replaceKeyframeActionDisabled) return
    const variant = getVariantForShot(row.scene.id, row.shot.id)
    if (!variant?.key) {
      setKeyframeStatus('Press Use this script in the Director Script step before replacing a keyframe for this shot.')
      return
    }
    const existingAsset = yoloStoryboardAssetMap?.get(variant.key) || null
    setSelectedShotIndex(index)
    setSelectedShotIndexes([index])
    setSelectionAnchorIndex(index)
    setMediaPreview(null)
    setReplaceKeyframeTarget({
      sceneId: row.scene.id,
      shotId: row.shot.id,
      shotIndex: index,
      label: `Shot ${index + 1}: ${row.shot.scriptShotLabel || row.scene.label || row.shot.id}`,
      existingAssetId: existingAsset?.id || '',
    })
    setReplacementAssetId('')
  }

  const closeReplaceKeyframeDialog = () => {
    if (replacementBusy) return
    setReplaceKeyframeTarget(null)
    setReplacementAssetId('')
    if (replacementFileInputRef.current) replacementFileInputRef.current.value = ''
  }

  const replaceKeyframeWithPayload = async (payload) => {
    if (!replaceKeyframeTarget || replacementBusy || !handleReplaceYoloMusicKeyframe) return
    setReplacementBusy(true)
    setKeyframeStatus(`Replacing keyframe for Shot ${replaceKeyframeTarget.shotIndex + 1}...`)
    try {
      const replacement = await handleReplaceYoloMusicKeyframe({
        sceneId: replaceKeyframeTarget.sceneId,
        shotId: replaceKeyframeTarget.shotId,
        ...payload,
      })
      if (replacement) {
        setKeyframeStatus(`Replaced keyframe for Shot ${replaceKeyframeTarget.shotIndex + 1}. Step 5 will use the new image.`)
        setReplaceKeyframeTarget(null)
        setReplacementAssetId('')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Could not replace keyframe.')
      setKeyframeStatus(`Could not replace keyframe: ${message}`)
    } finally {
      setReplacementBusy(false)
      if (replacementFileInputRef.current) replacementFileInputRef.current.value = ''
    }
  }

  const handleUseSelectedReplacementAsset = () => {
    if (!replacementAssetId) {
      setKeyframeStatus('Choose an image asset to use as the replacement keyframe.')
      return
    }
    void replaceKeyframeWithPayload({ assetId: replacementAssetId })
  }

  const handleReplacementFileChange = (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    void replaceKeyframeWithPayload({ file })
  }

  const renderReplaceKeyframeButton = (row, index, label = 'Replace') => (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        openReplaceKeyframeDialog(row, index)
      }}
      disabled={replaceKeyframeActionDisabled || !row}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-sf-dark-600 bg-sf-dark-900/85 px-2 py-1 text-[10px] font-semibold text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
      title={replaceKeyframeActionDisabled ? 'Keyframes cannot be replaced right now.' : 'Replace this keyframe with an image'}
    >
      <Upload className="h-3 w-3" />
      {label}
    </button>
  )

  const updateNanoBananaShotReferences = (row, patch = {}) => {
    if (!row?.scene?.id || !row?.shot?.id || !handleYoloShotNanoBananaReferencesChange) return
    handleYoloShotNanoBananaReferencesChange(row.scene.id, row.shot.id, patch)
  }

  const renderNanoBananaShotReferences = (row, compact = false) => {
    if (!nanoBananaKeyframeSelected || !row?.scene || !row?.shot || hasMultipleSelectedShots) return null
    const overrideEnabled = Boolean(row.shot.nanoBananaReferenceOverrideEnabled)
    const referenceAssetId1 = row.shot.nanoBananaReferenceAssetId1 || ''
    const referenceAssetId2 = row.shot.nanoBananaReferenceAssetId2 || ''
    const hasImages = replacementImageAssets.length > 0

    return (
      <div className={`mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 ${compact ? 'px-3 py-2' : 'p-3'}`}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Nano Banana references</div>
            <div className="mt-0.5 text-xs text-sf-text-secondary">
              {overrideEnabled ? 'This shot uses its own reference selection.' : 'Using the default cast/project references for this shot.'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => updateNanoBananaShotReferences(row, { enabled: !overrideEnabled })}
            disabled={!handleYoloShotNanoBananaReferencesChange}
            className="inline-flex shrink-0 items-center justify-center rounded-md border border-sf-dark-600 bg-sf-dark-950 px-2.5 py-1.5 text-[10px] font-semibold text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {overrideEnabled ? 'Use Defaults' : 'Override References'}
          </button>
        </div>
        {overrideEnabled && (
          <>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {[1, 2].map((slot) => {
                const value = slot === 1 ? referenceAssetId1 : referenceAssetId2
                return (
                  <select
                    key={`nano-ref-${row.scene.id}-${row.shot.id}-${slot}`}
                    value={value}
                    onChange={(event) => updateNanoBananaShotReferences(row, {
                      [`referenceAssetId${slot}`]: event.target.value || '',
                    })}
                    disabled={!hasImages}
                    className="w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-2 py-1.5 text-xs text-sf-text-primary outline-none focus:border-sf-accent disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <option value="">{slot === 1 ? 'No reference / prompt only' : 'No second reference'}</option>
                    {replacementImageAssets.map((asset) => (
                      <option key={`nano-ref-${slot}-${asset.id}`} value={asset.id}>{asset.name || asset.id}</option>
                    ))}
                  </select>
                )
              })}
            </div>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[10px] leading-4 text-sf-text-muted">
                Leave both empty to force Nano Banana to use only this shot's prompt.
              </p>
              <button
                type="button"
                onClick={() => updateNanoBananaShotReferences(row, { clear: true })}
                className="inline-flex shrink-0 items-center justify-center rounded-md border border-sf-dark-600 px-2 py-1 text-[10px] font-semibold text-sf-text-muted transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
              >
                Clear Override
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  const handleCopyBrief = async () => {
    setBriefStatus('')
    await handleCopyMusicVideoLlmPrompt({ coveragePlan })
    setBriefStatus('Copied. Paste it into your AI, then paste the script it writes into the box below.')
    // The pasted script goes into the text box, so make sure it is showing.
    setScriptTextOpen(true)
  }

  const handleStopVelo = () => { veloStopRef.current?.abort() }

  const handleWriteWithVelo = async () => {
    if (veloScript.status === 'writing') return
    if (yoloMusicScript.trim() && !window.confirm('Write a new script? This replaces the one you have now.')) return
    setVeloScript({ status: 'writing', shots: 0, message: '', startedAt: Date.now(), latest: '' })
    const stopper = new AbortController()
    veloStopRef.current = stopper
    try {
      const brief = await handleCopyMusicVideoLlmPrompt({ coveragePlan, copy: false })
      const result = await writeScriptWithVelo({
        api: window.electronAPI?.connectedAgent,
        brief,
        signal: stopper.signal,
        onText: (text) => setVeloScript((current) => {
          if (current.status !== 'writing') return current
          const headings = text.match(/^[ \t#*>-]*shot\s+\d+\b[^\n]*/gim) || []
          const latest = String(headings[headings.length - 1] || '').replace(/^[ \t#*>-]+/, '').replace(/[*#]+\s*$/, '').trim().slice(0, 80)
          return { ...current, shots: headings.length, latest }
        }),
      })
      if (result.code === 'CANCELLED') {
        // The script box is only filled on success, so the old script is untouched.
        setVeloScript({ status: 'stopped', shots: 0, message: '' })
        return
      }
      if (!result.success) { setVeloScript({ status: 'error', shots: 0, message: result.error }); return }
      setYoloMusicScript(result.text)
      setParseStatus('')
      setVeloScript({ status: 'done', shots: result.shots, message: result.warning || '' })
    } catch (error) {
      setVeloScript({ status: 'error', shots: 0, message: error?.message || 'Velo could not write the script.' })
    } finally {
      if (veloStopRef.current === stopper) veloStopRef.current = null
    }
  }

  const handleParseScript = () => {
    setParseStatus('')
    const nextPlan = handleBuildActiveYoloPlan({
      conceptOverride: '',
      styleNotesOverride: yoloMusicStyleNotes,
    })
    const count = flattenPlanShots(nextPlan).length
    if (count > 0) {
      setParseStatus(`${plural(count, 'shot')} ${count === 1 ? 'is' : 'are'} ready. Next: Keyframes.`)
      setStep('keyframes')
    } else {
      setParseStatus('Velorn could not find any shots in this script. Check that it follows the script format.')
    }
  }

  const handleQueueKeyframes = async () => {
    if (cloudPicturesOn) {
      const missing = flatShots.filter((row) => !yoloStoryboardAssetMap?.get(getVariantForShot(row.scene.id, row.shot.id)?.key))
      if (!missing.length) { setKeyframeStatus('All your keyframes are already made.'); return }
      return askCloudKeyframesPrice(missing)
    }
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
      setKeyframeStatus(queued > 0 ? `Queued ${plural(queued, 'keyframe')}.` : 'No keyframes were queued. Any existing shots may already be complete or running.')
    } finally {
      setIsQueuingKeyframes(false)
    }
  }

  const handleGenerateShotKeyframe = async (row, index) => {
    if (!row || singleKeyframeActionDisabled) return
    setSelectedShotIndex(index)
    if (cloudPicturesOn) return askCloudKeyframesPrice([row])
    setIsQueuingKeyframes(true)
    setKeyframeStatus(`Queueing keyframe for Shot ${index + 1}...`)
    try {
      await handleQueueYoloShotStoryboard(row.scene.id, row.shot.id, {
        resolutionOverride: outputResolution,
      })
      setKeyframeStatus(`Queued keyframe for Shot ${index + 1}.`)
    } finally {
      setIsQueuingKeyframes(false)
    }
  }

  const handleRegenerateSelectedKeyframe = async () => {
    if (selectedShotRows.length === 0 || singleKeyframeActionDisabled) return
    if (cloudPicturesOn) return askCloudKeyframesPrice(selectedShotRows)
    setIsQueuingKeyframes(true)
    const targetLabel = hasMultipleSelectedShots
      ? `${selectedShotRows.length} selected shots`
      : `Shot ${selectedShotRows[0].index + 1}`
    setKeyframeStatus(`Queueing keyframe regeneration for ${targetLabel}...`)
    try {
      if (hasMultipleSelectedShots && handleQueueYoloShotStoryboards) {
        const queued = await handleQueueYoloShotStoryboards(
          selectedShotRows.map((row) => ({ sceneId: row.scene.id, shotId: row.shot.id })),
          { resolutionOverride: outputResolution }
        )
        setKeyframeStatus(queued > 0
          ? `Queued ${plural(queued, 'keyframe regeneration job')} for ${selectedShotRows.length} selected shots.`
          : 'No selected keyframe regeneration jobs were queued. Check whether those shots are already running.')
      } else {
        const row = selectedShotRows[0]
        await handleQueueYoloShotStoryboard(row.scene.id, row.shot.id, {
          resolutionOverride: outputResolution,
        })
        setKeyframeStatus(`Queued keyframe regeneration for Shot ${row.index + 1}.`)
      }
    } finally {
      setIsQueuingKeyframes(false)
    }
  }

  const handleRegenerateAllKeyframes = async () => {
    if (plannedShotCount === 0) return
    if (cloudPicturesOn) return askCloudKeyframesPrice(flatShots)
    setIsQueuingKeyframes(true)
    setKeyframeStatus('Queueing keyframe regeneration for all shots...')
    try {
      const queued = await handleQueueYoloStoryboards({
        allowExistingDoneKeys: true,
        sourceLabel: `Music Video Easy Mode ${selectedKeyframeWorkflowLabel} keyframe regeneration pass`,
        resolutionOverride: outputResolution,
      })
      setKeyframeStatus(queued > 0 ? `Queued ${plural(queued, 'keyframe regeneration job')}.` : 'No keyframe regeneration jobs were queued. Check whether those shots are already running.')
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
      setVideoStatus(`No video variant found for Shot ${index + 1}. Press Use the changes in the Director Script step first.`)
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

  const handleRegenerateSelectedVideo = async () => {
    if (selectedShotRows.length === 0 || singleVideoActionDisabled) return
    const queueableRows = []
    let missingVariants = 0
    let missingKeyframes = 0
    for (const row of selectedShotRows) {
      const variant = getVariantForShot(row.scene.id, row.shot.id)
      if (!variant) {
        missingVariants += 1
        continue
      }
      if (!yoloStoryboardAssetMap?.has(variant.key)) {
        missingKeyframes += 1
        continue
      }
      queueableRows.push(row)
    }
    if (queueableRows.length === 0) {
      if (selectedShotRows.length === 1 && missingVariants > 0) {
        setVideoStatus(`No video variant found for Shot ${selectedShotRows[0].index + 1}. Press Use the changes in the Director Script step first.`)
        return
      }
      if (selectedShotRows.length === 1 && missingKeyframes > 0) {
        setVideoStatus(`Shot ${selectedShotRows[0].index + 1} needs a keyframe before video can run.`)
        return
      }
      setVideoStatus('Selected shots need keyframes before video can run.')
      return
    }
    setSelectedShotIndex(queueableRows[0].index)
    setIsQueuingVideos(true)
    const targetLabel = hasMultipleSelectedShots
      ? `${queueableRows.length} selected shots`
      : `Shot ${queueableRows[0].index + 1}`
    setVideoStatus(`Queueing ${selectedVideoWorkflowLabel} video rerun for ${targetLabel}...`)
    try {
      if (queueableRows.length > 1 && handleQueueYoloShotVideos) {
        const queued = await handleQueueYoloShotVideos(
          queueableRows.map((row) => ({ sceneId: row.scene.id, shotId: row.shot.id })),
          {
            targetWorkflowIds: selectedVideoWorkflowId ? [selectedVideoWorkflowId] : null,
            resolutionOverride: outputResolution,
          }
        )
        const skipped = missingVariants + missingKeyframes
        setVideoStatus(queued > 0
          ? `Queued ${plural(queued, `${selectedVideoWorkflowLabel} video rerun job`)}${skipped > 0 ? `; skipped ${plural(skipped, 'selected shot')} without a variant or keyframe.` : '.'}`
          : `No selected ${selectedVideoWorkflowLabel} video jobs were queued. Check whether those shots are already running.`)
      } else {
        const row = queueableRows[0]
        await handleQueueYoloShotVideo?.(row.scene.id, row.shot.id, {
          targetWorkflowIds: selectedVideoWorkflowId ? [selectedVideoWorkflowId] : null,
          resolutionOverride: outputResolution,
        })
        setVideoStatus(`Queued ${selectedVideoWorkflowLabel} video rerun for Shot ${row.index + 1}.`)
      }
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

  // The timeline's shape is asked next to the button. Until the person picks,
  // it follows the videos that are ready: whichever shape there are more of.
  const [timelineShapeChoice, setTimelineShapeChoice] = useState('')
  // 720p matches the videos as they are made; 1080p scales them up to fit.
  const [timelineSize, setTimelineSize] = useState('720p')
  // 'layers' puts every pass on its own layer, to edit by hand. 'ready' makes
  // one layer that already plays as a finished video.
  const [timelineCut, setTimelineCut] = useState('layers')
  const timelineShapeRef = useRef('wide')
  const handleAssembleTimeline = async () => {
    if (!handleAssembleMusicVideoTimeline) return
    setIsAssemblingTimeline(true)
    setTimelineStatus('')
    try {
      const result = await handleAssembleMusicVideoTimeline({ shape: timelineShapeRef.current, size: timelineSize, cut: timelineCut })
      setTimelineStatus(result?.message || 'Timeline assembled.')
      if (result?.ok !== false) setTimelinePlaced(true)
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

  const handleImportCastReferenceImage = async () => {
    if (!handleImportYoloMusicCastImage || yoloMusicCastImageImporting) return
    setPeopleStatus('')
    const importedAsset = await handleImportYoloMusicCastImage()
    if (importedAsset) {
      setPeopleStatus(`Imported ${importedAsset.name || 'reference image'} and added it to the cast.`)
    }
  }

  const handlePeopleWizardImportPicture = async () => {
    if (!handleImportYoloMusicCastImage || yoloMusicCastImageImporting) return
    const asset = await handleImportYoloMusicCastImage({ addToCast: false })
    if (!asset) return
    const fromFile = String(asset.name || '').replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[_-]+/g, ' ').trim()
    updatePeopleWizard({
      assetId: asset.id,
      sheetAssetId: '',
      step: peopleWizard?.advanced ? 'image' : (peopleWizard?.step || 'image'),
      ...(String(peopleWizard?.name || '').trim() ? {} : { name: fromFile }),
    })
  }

  const handlePeopleWizardFieldChange = (field, value) => {
    updatePeopleWizard({ [field]: value })
  }

  const handlePeopleWizardSelectAsset = (assetId) => {
    updatePeopleWizard({
      assetId: assetId || '',
      sheetAssetId: '',
      step: 'image',
    })
  }

  const handlePeopleWizardSelectSheetAsset = (assetId) => {
    updatePeopleWizard({
      sheetAssetId: assetId || '',
      step: 'sheet',
    })
  }

  const handlePeopleWizardCreateImage = () => {
    if (cloudPicturesOn) { void askPersonPrice(); return }
    if (!peopleWizardGenerationEnabled) return
    if (!queuePeopleWizardJob) return
    const prompt = String(peopleWizard?.imagePrompt || '').trim() || `${peopleWizard?.name || 'Character'} portrait`
    const resolution = resolvePeopleWizardImageResolution(peopleWizard?.imageSize, peopleWizard?.imageOrientation)
    const job = queuePeopleWizardJob({
      workflowId: FLUX2_KLEIN_WORKFLOW_ID,
      workflowLabel: 'FLUX.2 klein',
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
      sheetAssetId: '',
    })
  }

  const handlePeopleWizardCreateSheet = () => {
    if (!peopleWizardGenerationEnabled) return
    if (!queuePeopleWizardJob) return
    const baseAsset = peopleWizardGeneratedImageAsset || peopleWizardSelectedAsset || null
    const baseAssetId = baseAsset?.id || peopleWizard?.assetId || ''
    if (!baseAssetId) return
    const prompt = `${peopleWizard?.name || 'Character'} character sheet with front, side, 3/4, expressions, and wardrobe consistency.`
    // The typed ASSET PREFIX always wins — the People step promises "Used
    // for the generated image and sheet file names". Inferring from the
    // base asset is only a fallback for an empty field: a portrait
    // generated before the prefix was typed carries stale "person"
    // metadata, and every cast member inheriting it collides as
    // person_sheet (issue #90).
    const typedAssetPrefix = normalizeCastSlug(peopleWizard?.assetPrefix || '') || ''
    const inheritedAssetPrefix = typedAssetPrefix
      || inferPeopleWizardAssetPrefix(
        baseAsset,
        peopleWizard?.slug || peopleWizard?.name || 'person'
      )
      || 'person'
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
      sheetAssetId: '',
    })
  }

  const handlePeopleWizardSave = () => {
    if (!peopleWizard) return
    const trimmedName = String(peopleWizard.name || '').trim()
    const normalizedSlug = normalizeCastSlug(String(peopleWizard.slug || '').trim()) || normalizeCastSlug(trimmedName)
    const finalAssetId = peopleWizard.step === 'sheet'
      ? peopleWizardSelectedSheetAsset?.id || peopleWizardSheetAsset?.id || ''
      : peopleWizard.step === 'image'
        ? peopleWizardGeneratedImageAsset?.id || peopleWizardSelectedAsset?.id || ''
      : peopleWizardSelectedAsset?.id || peopleWizardSheetAsset?.id || peopleWizardGeneratedImageAsset?.id || ''
    if (!trimmedName || !normalizedSlug || !finalAssetId) return
    const nextEntry = {
      id: peopleWizard.entryId || `cast-${Date.now()}`,
      label: trimmedName,
      slug: normalizedSlug,
      assetId: finalAssetId,
      role: String(peopleWizard.role || 'lead'),
      notes: String(peopleWizard.notes || '').trim().slice(0, 160),
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

  // The song screen. The earlier Song step's other settings (resolution, frame
  // rate, audio type, style, ComfyUI transcription) were removed 2026-11-11:
  // the video model, the listening engine and the Idea box replaced them.
  const renderSongStep = () => (
    <SongStep
      audioAsset={yoloMusicAudioAsset}
      audioAssets={yoloMusicAudioAssets}
      onSelectAudioAsset={setYoloMusicAudioAssetId}
      onImportAudio={handleImportYoloMusicAudio}
      importing={Boolean(yoloMusicAudioImporting)}
      lyrics={yoloMusicParsedLyrics?.isTimed ? yoloMusicLyrics : ''}
      onLyricsChange={setYoloMusicLyrics}
      songMap={yoloMusicSongMap}
      onSongMapChange={setYoloMusicSongMap}
      onDone={() => setStep('people')}
    />
  )

  // The one choice left from the earlier Song step: the shape of the video.
  // It is asked here because keyframes and videos are both made in it.
  // Asked at the top of Keyframes, where the shape first matters. Once pictures
  // exist it shrinks to one line with a Change link.
  // Says so when the pictures are a mix of wide and tall: each video takes its
  // own picture's shape, so a mix of pictures becomes a mix of videos.
  const renderMixedShapesNote = () => {
    const sizes = flatShots.map(({ scene, shot }) => {
      const variant = getVariantForShot(scene.id, shot.id)
      const asset = variant ? yoloStoryboardAssetMap?.get(variant.key) : null
      if (!asset) return null
      const seen = runtimeImageDimensions[asset.id]
      return {
        width: normalizeDimension(seen?.width ?? asset.width ?? asset.settings?.width),
        height: normalizeDimension(seen?.height ?? asset.height ?? asset.settings?.height),
      }
    })
    const shapes = countPictureShapes(sizes)
    if (!shapes.mixed) return null
    const wantTall = aspectRatio === 'vertical_9x16'
    const others = wantTall ? shapes.wide : shapes.tall
    return (
      <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs leading-5 text-amber-100" role="status">
        {plural(shapes.wide, 'picture')} {shapes.wide === 1 ? 'is' : 'are'} 16:9 and {shapes.tall} {shapes.tall === 1 ? 'is' : 'are'} 9:16. Each video takes the shape of its own picture.
        {' '}For a {wantTall ? '9:16' : '16:9'} video all the way through, make the {others} {wantTall ? '16:9' : '9:16'} {others === 1 ? 'one' : 'ones'} again in Keyframes.
      </div>
    )
  }

  const renderShapePicker = () => {
    const chosen = ASPECT_RATIO_OPTIONS.find((option) => option.id === aspectRatio) || ASPECT_RATIO_OPTIONS[0]
    const hasPictures = yoloStoryboardReadyCount > 0
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 px-4 py-3">
        <span className="text-sm font-semibold text-sf-text-primary">Video shape</span>
        <div role="group" aria-label="Shape of the video" className="inline-flex overflow-hidden rounded-lg border border-sf-dark-600">
          {ASPECT_RATIO_OPTIONS.map((option) => {
            const active = aspectRatio === option.id
            const tall = option.id === 'vertical_9x16'
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                onClick={() => setAspectRatio(option.id)}
                className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold transition-colors ${active ? 'bg-sf-accent text-white' : 'text-sf-text-secondary hover:bg-sf-dark-800 hover:text-sf-text-primary'}`}
              >
                <span aria-hidden="true" className={`rounded-[2px] border-[1.5px] border-current ${tall ? 'h-3.5 w-2' : 'h-2 w-3.5'}`} />
                {option.label}
              </button>
            )
          })}
        </div>
        <span className="text-xs text-sf-text-muted">
          {chosen.helper}.{hasPictures ? ' Pictures already made keep the shape they were made in.' : ''}
        </span>
      </div>
    )
  }

  const renderIdeaCard = () => (
      <div className="flex h-full flex-col rounded-xl border border-sf-dark-700 bg-sf-dark-900/70 p-5">
        <div className="text-sm font-semibold text-sf-text-primary">What's the idea?</div>
        <p className="mt-1 text-xs leading-5 text-sf-text-secondary">
          Say it the way you would tell a friend. It steers the whole script, and you can change anything afterwards.
        </p>
        <textarea
          value={yoloMusicConcept || ''}
          onChange={(event) => setYoloMusicConcept?.(event.target.value)}
          rows={3}
          placeholder="She sings on a rooftop at night. In the verses we follow her walking home through the city."
          className="mt-3 min-h-[96px] w-full flex-1 resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-4 py-3 text-sm leading-6 text-sf-text-primary outline-none placeholder:text-sf-text-muted focus:border-sf-accent"
        />
      </div>
  )

  const renderWriteCard = () => {
    const writing = veloScript.status === 'writing'
    const timedLines = Array.isArray(yoloMusicParsedLyrics?.lines) ? yoloMusicParsedLyrics.lines.length : 0
    return (
      <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/70 p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <button
              type="button"
              onClick={handleWriteWithVelo}
              disabled={writing}
              className="inline-flex items-center gap-2 rounded-lg bg-sf-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {writing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              {writing ? (veloScript.shots > 0 ? `Writing… ${plural(veloScript.shots, 'shot')} so far` : 'Writing the script…') : 'Write the script'}
            </button>
            {writing && (
              <button
                type="button"
                onClick={handleStopVelo}
                className="ml-2 inline-flex items-center rounded-lg border border-sf-dark-600 px-4 py-2 text-sm font-semibold text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
              >
                Stop
              </button>
            )}
            <p className="mt-2 max-w-xl text-xs leading-5 text-sf-text-secondary">
              Velo writes it from your song{timedLines > 0 ? `, its ${plural(timedLines, 'timed line')}` : ''}, your people, your idea and the coverage above.
              {' '}This sends them to the Velorn service and uses your Velo allowance.
            </p>
            {writing && (
              <div className="mt-3 max-w-xl rounded-lg border border-sf-accent/30 bg-sf-accent/5 p-3" role="status" aria-live="polite">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="font-semibold text-sf-text-primary">
                    {veloScript.shots > 0 ? `Velo is writing: ${plural(veloScript.shots, 'shot')} so far` : 'Velo is reading your song and planning the shots'}
                  </span>
                  <span className="tabular-nums text-sf-text-muted">{formatClock(veloSeconds)}</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sf-dark-800">
                  <div className="h-full w-full animate-pulse rounded-full bg-sf-accent" />
                </div>
                {veloScript.latest && <div className="mt-2 truncate text-xs text-sf-text-secondary">Now: {veloScript.latest}</div>}
                <p className="mt-2 text-xs leading-5 text-sf-text-muted">
                  This takes a few minutes for a whole song, and the first shot can take a minute to appear. You can look at the other steps while you wait.
                </p>
              </div>
            )}
            {veloScript.status === 'done' && !veloScript.message && (
              <p className="mt-2 text-xs text-emerald-200">Velo wrote {plural(veloScript.shots, 'shot')}. Read it below, change what you like, then press Use this script.</p>
            )}
            {veloScript.status === 'done' && veloScript.message && (
              <p className="mt-2 text-xs text-amber-200">Velo wrote {plural(veloScript.shots, 'shot')}, which are in the box below. {veloScript.message}</p>
            )}
            {veloScript.status === 'stopped' && (
              <p className="mt-2 text-xs text-sf-text-secondary">Stopped. {yoloMusicScript.trim() ? 'Your script was not changed.' : 'Nothing was written.'} What Velo had already written may still count against your allowance.</p>
            )}
            {veloScript.status === 'error' && <p className="mt-2 text-xs text-sf-error">{veloScript.message}</p>}
          </div>
          <div className="w-full flex-shrink-0 md:w-56">
            <VeloAllowance result={veloAllowance.result} checking={veloAllowance.checking} />
          </div>
        </div>

        {/* Writing with your own AI: one link that copies the brief. The panel
            it used to open (status boxes and a second button) was removed 2026-11-12. */}
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <button type="button" onClick={handleCopyBrief} className="inline-flex items-center gap-1.5 text-sf-text-muted underline hover:text-sf-text-primary">
            <Clipboard className="h-3.5 w-3.5" />
            Copy the brief for my own AI
          </button>
          {briefStatus && <span className="text-emerald-200" role="status">{briefStatus}</span>}
        </div>
        {timedLines === 0 && (
          <p className="mt-2 text-xs text-amber-200">The Song step isn't finished yet, so a script written now won't follow the lyrics.</p>
        )}
      </div>
    )
  }

  const renderPeopleWizardModal = () => {
    if (!peopleWizard) return null

    const wizardStep = peopleWizard.step || 'person'
    const advanced = Boolean(peopleWizard.advanced)
    const trimmedName = String(peopleWizard.name || '').trim()
    const normalizedSlug = normalizeCastSlug(String(peopleWizard.slug || '').trim()) || normalizeCastSlug(trimmedName)
    const selectedPreviewAsset = wizardStep === 'sheet'
      ? peopleWizardSelectedSheetAsset || peopleWizardSheetAsset || peopleWizardGeneratedImageAsset || peopleWizardSelectedAsset || null
      : wizardStep === 'image'
        ? peopleWizardGeneratedImageAsset || peopleWizardSelectedAsset || null
        : peopleWizardSelectedAsset || null
    const peopleWizardSaveAssetId = wizardStep === 'sheet'
      ? peopleWizardSelectedSheetAsset?.id || peopleWizardSheetAsset?.id || ''
      : wizardStep === 'image'
        ? peopleWizardGeneratedImageAsset?.id || peopleWizardSelectedAsset?.id || ''
        : ''
    const canContinueToImageStep = Boolean(trimmedName && normalizedSlug)
    const hasSheetReference = Boolean(peopleWizardGeneratedImageAsset || peopleWizardSelectedAsset)
    const canEnterSheetStep = canContinueToImageStep
    const canSavePeopleWizard = Boolean(trimmedName && normalizedSlug && peopleWizardSaveAssetId && !peopleWizardActiveJob)
    const previewTitle = selectedPreviewAsset?.name || 'Preview'
    const wizardStages = [
      { id: 'person', label: '1', title: 'Person data', helper: 'Name, slug, and role.' },
      { id: 'image', label: '2', title: 'Image', helper: 'Create or pick a portrait.', disabled: !canContinueToImageStep },
      { id: 'sheet', label: '3', title: 'Character sheet', helper: 'Generate or choose a sheet.', disabled: !canEnterSheetStep },
    ]
    const previewJob = peopleWizardActiveJob
      && (
        [FLUX2_KLEIN_WORKFLOW_ID, 'z-image-turbo'].includes(peopleWizardActiveJob.workflowId)
        || peopleWizardActiveJob.workflowId === 'multi-angles'
      )
      ? peopleWizardActiveJob
      : null
    const previewJobProgress = Math.min(100, Math.max(0, Number(previewJob?.progress) || 0))
    const statusText = previewJob
      ? `${getWorkflowDisplayLabel(previewJob.workflowId)} is ${previewJob.status || 'running'}...`
      : ''
    const wizardPrimaryAction = !advanced
      ? {
          label: peopleWizardActiveJob ? 'Making the picture…' : peopleWizard.mode === 'edit' ? 'Save' : 'Add to cast',
          onClick: handlePeopleWizardSave,
          disabled: !canSavePeopleWizard,
        }
      : wizardStep === 'person'
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
              <div className="text-[10px] uppercase tracking-[0.14em] text-sf-accent">Cast</div>
              <h3 className="text-base font-semibold text-sf-text-primary">
                {peopleWizard.mode === 'edit' ? 'Edit cast member' : 'Add to cast'}
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
              <div hidden={!advanced} className="rounded-2xl border border-sf-dark-700 bg-sf-dark-900/70 p-3">
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

              {!advanced && (
                <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/70 p-4">
                  <FieldLabel>Name</FieldLabel>
                  <input
                    type="text"
                    value={peopleWizard.name}
                    autoFocus
                    onChange={(event) => handlePeopleWizardFieldChange('name', event.target.value)}
                    className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-sm text-sf-text-primary outline-none focus:border-sf-accent"
                    placeholder="Ava, The Grinch, the drummer"
                  />
                </div>
              )}

              {advanced && wizardStep === 'person' && (
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
                  <div>
                    <FieldLabel>Notes for Director Script</FieldLabel>
                    <textarea
                      value={peopleWizard.notes || ''}
                      onChange={(event) => handlePeopleWizardFieldChange('notes', event.target.value)}
                      rows={2}
                      className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent resize-y"
                      placeholder="Optional: female voice, harsh vocal, guitarist, never sings, lead performer energy."
                    />
                    <p className="mt-1 text-[10px] text-sf-text-muted">
                      Included in the copied LLM brief so the script understands voice and performance context.
                    </p>
                  </div>
                </div>
              )}

              {(wizardStep === 'image' || !advanced) && (
                <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/70 p-4 space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-sf-text-primary">{advanced ? '2. Image selection / creation' : 'Their picture'}</div>
                      <p className="mt-1 text-xs text-sf-text-secondary">
                        {advanced
                          ? 'Choose an existing portrait or create a new one. Once an image is selected, you can continue to the sheet step.'
                          : 'One clear picture is enough. Use your own, or have Velorn make one.'}
                      </p>
                    </div>
                    <div className="text-[10px] text-sf-text-muted">
                      {canUsePeopleWizardGeneration ? (advanced ? 'Portrait generation enabled' : '') : 'Making a picture needs ComfyUI running'}
                    </div>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-950/60 p-3 space-y-3">
                      <div className="flex items-center gap-2 text-sm font-semibold text-sf-text-primary">
                        <ImageIcon className="h-4 w-4 text-sf-accent" />
                        Use my own picture
                      </div>
                      <button
                        type="button"
                        onClick={handlePeopleWizardImportPicture}
                        disabled={!handleImportYoloMusicCastImage || yoloMusicCastImageImporting}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs font-semibold text-sf-text-primary transition-colors hover:border-sf-accent disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {yoloMusicCastImageImporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                        {yoloMusicCastImageImporting ? 'Adding…' : 'Choose a file'}
                      </button>
                      <div className="text-[11px] text-sf-text-muted">Or one already in this project:</div>
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
                        Make one here
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
                      {advanced && (<>
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
                      </>)}
                      {personCloudError && <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" role="alert">{personCloudError}</div>}
                      {personQuote && renderPicturePrice(personQuote, confirmPersonQuote, () => setPersonQuote(null))}
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          hidden={!advanced}
                          onClick={() => updatePeopleWizard({ step: 'person' })}
                          className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
                        >
                          Back
                        </button>
                        <button
                          type="button"
                          onClick={handlePeopleWizardCreateImage}
                          disabled={cloudPicturesOn ? (personQuoteBusy || personCloudBusy) : (!peopleWizardGenerationEnabled || Boolean(peopleWizardActiveJob))}
                          className="rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {cloudPicturesOn
                            ? (personCloudBusy ? 'Making it…' : personQuoteBusy ? 'Asking the price…' : 'See the price')
                            : peopleWizardActiveJob && [FLUX2_KLEIN_WORKFLOW_ID, 'z-image-turbo'].includes(peopleWizardActiveJob.workflowId) ? 'Making it…' : 'Make the picture'}
                        </button>
                      </div>
                    </div>
                  </div>

                </div>
              )}

              {advanced && wizardStep === 'sheet' && (
                <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/70 p-4 space-y-3">
                  <div>
                    <div className="text-sm font-semibold text-sf-text-primary">3. Character sheet</div>
                    <p className="mt-1 text-xs text-sf-text-secondary">
                      Use a finished character sheet you already made, or generate a new one from the portrait/reference image.
                    </p>
                  </div>
                  <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 p-3 text-xs text-sf-text-secondary">
                    <div><span className="text-sf-text-muted">Reference:</span> {peopleWizardGeneratedImageAsset?.name || peopleWizardSelectedAsset?.name || 'No reference selected yet'}</div>
                    <div><span className="text-sf-text-muted">Existing sheet:</span> {peopleWizardSelectedSheetAsset?.name || 'No finished sheet selected yet'}</div>
                    <div><span className="text-sf-text-muted">Sheet workflow:</span> Multiple Angles (Characters)</div>
                  </div>
                  <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-950/60 p-3 space-y-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-sf-text-primary">
                      <ImageIcon className="h-4 w-4 text-sf-accent" />
                      Use existing character sheet
                    </div>
                    <select
                      value={peopleWizard.sheetAssetId || ''}
                      onChange={(event) => handlePeopleWizardSelectSheetAsset(event.target.value || '')}
                      className="w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
                    >
                      <option value="">Select finished character sheet</option>
                      {imageAssets.map((asset) => (
                        <option key={asset.id} value={asset.id}>{asset.name || asset.id}</option>
                      ))}
                    </select>
                    <div className="text-[11px] text-sf-text-muted">
                      {peopleWizardSelectedSheetAsset
                        ? `Selected sheet: ${peopleWizardSelectedSheetAsset.name || peopleWizardSelectedSheetAsset.id}`
                        : 'Pick a finished multi-angle sheet from this project, then save the person.'}
                    </div>
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
                      disabled={!peopleWizardGenerationEnabled || Boolean(peopleWizardActiveJob) || !hasSheetReference}
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
                {String(peopleWizard.notes || '').trim() && (
                  <div><span className="text-sf-text-muted">Notes:</span> {String(peopleWizard.notes || '').trim()}</div>
                )}
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
                  onClick={() => updatePeopleWizard(advanced ? { advanced: false, step: 'image' } : { advanced: true, step: 'person' })}
                  className="mr-auto text-xs text-sf-text-muted hover:text-sf-text-primary"
                >
                  {advanced ? 'Fewer options' : 'More options'}
                </button>
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

  // Cast as picture cards: the face is the card. Name, role and notes are
  // changed in the Edit window; the script's short name is made from the name.
  const renderPeopleStep = () => (
    <div className="space-y-4">
      {renderPictureMakerRow()}
      {placeCloudError && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" role="alert">{placeCloudError}</div>
      )}
      <div>
        <h3 className="text-lg font-semibold text-sf-text-primary">Who is in it?</h3>
        <p className="mt-1 text-xs leading-5 text-sf-text-secondary">Add everyone who appears on camera: a singer, a band, a character. One picture each is enough.</p>
      </div>
      {/* The FLUX download card is only needed when FLUX makes the pictures. */}
      {!cloudPicturesOn && (
        <LocalModelSetup
          key={FLUX2_KLEIN_WORKFLOW_ID}
          workflowId={FLUX2_KLEIN_WORKFLOW_ID}
          name="FLUX.2 klein"
          about="It makes the cast pictures and keyframes on your own computer."
        />
      )}
      {peopleStatus && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          {peopleStatus}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {(yoloMusicCast || []).map((entry, index) => {
          const entryAsset = imageAssets.find((asset) => asset?.id === entry?.assetId) || null
          const pictureUrl = entryAsset ? (getAssetUrl(entryAsset) || entryAsset.url) : ''
          const role = MUSIC_VIDEO_CAST_ROLE_OPTIONS.find((option) => option.id === (entry?.role || 'lead'))
          return (
            <div key={entry.id || index} className="flex overflow-hidden rounded-xl border border-sf-dark-700 bg-sf-dark-900/70">
              <div className="flex aspect-[4/5] w-40 flex-shrink-0 items-center justify-center overflow-hidden bg-sf-dark-950">
                {pictureUrl
                  ? (
                    <button
                      type="button"
                      onClick={() => setMediaPreview({ kind: 'image', url: pictureUrl, title: entry?.label || 'Cast picture', subtitle: role?.label || '' })}
                      title="See it large"
                      aria-label={`See the picture of ${entry?.label || 'this person'} large`}
                      className="h-full w-full cursor-zoom-in"
                    >
                      <img src={pictureUrl} alt="" className="h-full w-full object-cover object-top" loading="lazy" decoding="async" />
                    </button>
                  )
                  : <span className="px-3 text-center text-xs text-sf-text-muted">No picture yet</span>}
              </div>
              <div className="flex min-w-0 flex-1 flex-col p-4">
                <div className="truncate text-base font-semibold text-sf-text-primary">{entry?.label || 'No name yet'}</div>
                {role && <div className="mt-1.5"><span className="rounded-full bg-sf-accent/20 px-2 py-0.5 text-[11px] text-sf-text-primary">{role.label}</span></div>}
                <p className="mt-2 line-clamp-3 flex-1 text-xs leading-5 text-sf-text-muted">{entry?.notes || ''}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => handleOpenPeopleWizard(entry)}
                    className="inline-flex items-center gap-1 rounded-md border border-sf-dark-600 px-2.5 py-1 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
                  >
                    <Edit3 className="h-3 w-3" />
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleYoloMusicCastRemove(entry.id)}
                    className="rounded-md border border-sf-dark-600 px-2.5 py-1 text-xs text-sf-text-secondary transition-colors hover:border-red-500/60 hover:text-red-200"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          )
        })}
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-sf-dark-600 p-4 text-center">
          <UserPlus className="h-5 w-5 text-sf-text-secondary" />
          <div className="text-sm font-semibold text-sf-text-primary">Add someone</div>
          <button
            type="button"
            onClick={() => handleOpenPeopleWizard(null)}
            className="w-56 max-w-full rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent-hover"
          >
            Make a new person
          </button>
          <button
            type="button"
            onClick={handleImportCastReferenceImage}
            disabled={!handleImportYoloMusicCastImage || yoloMusicCastImageImporting}
            className="inline-flex w-56 max-w-full items-center justify-center gap-2 rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-45"
          >
            {yoloMusicCastImageImporting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {yoloMusicCastImageImporting ? 'Adding…' : 'Use my own picture'}
          </button>
        </div>
      </div>
      <div className="pt-2">
        <h3 className="text-lg font-semibold text-sf-text-primary">Where does it happen?</h3>
        <p className="mt-1 text-xs leading-5 text-sf-text-secondary">Add a place and every shot filmed there starts from the same picture, so the room stays the same. You can skip this.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {(yoloMusicPlaces || []).map((entry) => {
          const entryAsset = imageAssets.find((asset) => asset?.id === entry?.assetId) || null
          const pictureUrl = entryAsset ? (getAssetUrl(entryAsset) || entryAsset.url) : ''
          const making = Boolean(entry.pendingJobTag) && !entry.assetId
          const stillMaking = Boolean(placeCloudBusy[entry.id]) || Boolean(entry.pendingJobTag) && generationQueue.some((job) => job?.peopleWizard?.wizardId === entry.pendingJobTag && !['done', 'error', 'cancelled'].includes(job.status))
          return (
            <div key={entry.id} className="flex overflow-hidden rounded-xl border border-sf-dark-700 bg-sf-dark-900/70">
              <div className="flex h-[200px] w-56 flex-shrink-0 items-center justify-center overflow-hidden bg-sf-dark-950">
                {pictureUrl
                  ? (
                    <button
                      type="button"
                      onClick={() => setMediaPreview({ kind: 'image', url: pictureUrl, title: entry.label || 'Place', subtitle: entry.notes || '' })}
                      title="See it large"
                      aria-label={`See the picture of ${entry.label || 'this place'} large`}
                      className="h-full w-full cursor-zoom-in"
                    >
                      <img src={pictureUrl} alt="" className={`h-full w-full object-cover ${stillMaking ? 'opacity-40' : ''}`} loading="lazy" decoding="async" />
                    </button>
                  )
                  : stillMaking
                    ? <span className="inline-flex items-center gap-2 text-xs text-sf-text-secondary"><Loader2 className="h-4 w-4 animate-spin" />Making the picture…</span>
                    : <span className="px-3 text-center text-xs text-sf-text-muted">{making ? 'The picture did not arrive. Remove this place and try again.' : 'No picture yet'}</span>}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
                <input
                  type="text"
                  value={entry.label}
                  onChange={(event) => changePlace(entry.id, { label: event.target.value })}
                  aria-label="Name of this place"
                  placeholder="Name of this place"
                  className="w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-sm font-semibold text-sf-text-primary outline-none focus:border-sf-accent"
                />
                <textarea
                  value={entry.notes}
                  onChange={(event) => changePlace(entry.id, { notes: event.target.value })}
                  aria-label="Notes about this place"
                  placeholder="Describe the place: night, snow outside, warm firelight"
                  rows={2}
                  className="w-full flex-1 resize-none rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs leading-5 text-sf-text-primary outline-none focus:border-sf-accent"
                />
                {placeQuote?.key === entry.id && renderPlacePrice()}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleRemakePlace(entry)}
                    disabled={stillMaking || placeQuoteBusy || (!cloudPicturesOn && !queuePeopleWizardJob) || !(entry.notes || entry.label)}
                    title="Makes a new picture from what is written above"
                    className="inline-flex items-center gap-1.5 rounded-md border border-sf-dark-600 px-2.5 py-1 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {stillMaking && <Loader2 className="h-3 w-3 animate-spin" />}
                    {stillMaking ? 'Making a new picture…' : 'Make the picture again'}
                  </button>
                  <button
                    type="button"
                    onClick={() => removePlace(entry.id)}
                    className="rounded-md border border-sf-dark-600 px-2.5 py-1 text-xs text-sf-text-secondary transition-colors hover:border-red-500/60 hover:text-red-200"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          )
        })}
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-sf-dark-600 p-4 text-center">
          <ImageIcon className="h-5 w-5 text-sf-text-secondary" />
          <div className="text-sm font-semibold text-sf-text-primary">Add a place</div>
          {placeIdeaOpen ? (
            <div className="w-full max-w-sm space-y-2">
              {placeQuote?.key === 'new' && renderPlacePrice()}
              <textarea
                autoFocus
                value={placeIdea}
                onChange={(event) => setPlaceIdea(event.target.value)}
                aria-label="Describe the place"
                placeholder="A cosy cave living room with a stone fireplace and a red armchair"
                rows={3}
                className="w-full resize-none rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs leading-5 text-sf-text-primary outline-none focus:border-sf-accent"
              />
              <div className="flex justify-center gap-2">
                <button
                  type="button"
                  onClick={handleMakePlace}
                  disabled={!placeIdea.trim() || placeQuoteBusy || (!cloudPicturesOn && !queuePeopleWizardJob)}
                  className="rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {placeQuoteBusy ? 'Asking the price…' : cloudPicturesOn ? 'See the price' : 'Make the picture'}
                </button>
                <button
                  type="button"
                  onClick={() => { setPlaceIdeaOpen(false); setPlaceQuote(null) }}
                  className="rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setPlaceIdeaOpen(true)}
                className="w-56 max-w-full rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent-hover"
              >
                Make a new place
              </button>
              <button
                type="button"
                onClick={handleAddPlaceFromPicture}
                disabled={!handleImportYoloMusicCastImage || yoloMusicCastImageImporting}
                className="w-56 max-w-full rounded-lg border border-sf-dark-600 px-3 py-2 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-45"
              >
                Use my own picture
              </button>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-sf-dark-700 pt-3">
        <span className="text-xs text-sf-text-muted">No one on camera? You can skip this step.</span>
        <button
          type="button"
          onClick={() => setStep('script')}
          className="rounded-lg bg-sf-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent-hover"
        >
          Looks good
        </button>
      </div>
      {renderPeopleWizardModal()}
    </div>
  )

  // What gets filmed besides the video itself: one row per extra part, each
  // with a plain explanation. The video itself is always filmed, so it is not
  // listed. (Simple / Standard / Editorial cards were tried and removed
  // 2026-11-12: the list alone is clearer.)
  const renderCoverageCard = () => {
    const timesOver = 1 + performancePassCount + [includeStoryBroll, includeEnvironmentalBroll, includeDetailBroll].filter(Boolean).length
    return (
      <div className="h-full rounded-xl border border-sf-dark-700 bg-sf-dark-900/70 p-5">
        <div className="text-sm font-semibold text-sf-text-primary">What else do you want to film?</div>
        <p className="mt-1 text-xs leading-5 text-sf-text-secondary">The main shots are always filmed. Extras give you more to cut with, and take longer to make.</p>
        <div className="mt-3 divide-y divide-sf-dark-700 rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 px-4">
          <div className="flex items-center gap-3 py-3">
            <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-sm ${COVERAGE_PARTS[1].colour}`} />
            <span className="flex-1 text-xs"><span className="block text-sm font-semibold text-sf-text-primary">Extra takes</span><span className="text-sf-text-muted">The whole song again in a different look</span></span>
            <span className="inline-flex overflow-hidden rounded-lg border border-sf-dark-600" role="group" aria-label="Extra takes">
              {PERFORMANCE_PASS_OPTIONS.map((count) => (
                <button
                  key={count}
                  type="button"
                  aria-pressed={performancePassCount === count}
                  onClick={() => updatePerformancePassCount(count)}
                  className={`px-3 py-1.5 text-xs font-semibold transition-colors ${performancePassCount === count ? 'bg-sf-accent text-white' : 'text-sf-text-secondary hover:bg-sf-dark-800 hover:text-sf-text-primary'}`}
                >
                  {count}
                </button>
              ))}
            </span>
          </div>
          {[
            { part: COVERAGE_PARTS[2], helper: 'A small story to cut away to', on: includeStoryBroll, set: updateStoryBroll },
            { part: COVERAGE_PARTS[3], helper: 'Rooms, streets, weather, with nobody in them', on: includeEnvironmentalBroll, set: updateEnvironmentalBroll },
            { part: COVERAGE_PARTS[4], helper: 'Hands, objects, small moments', on: includeDetailBroll, set: updateDetailBroll },
          ].map((row) => (
            <label key={row.part.label} className="flex cursor-pointer items-center gap-3 py-3">
              <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-sm ${row.part.colour}`} />
              <span className="flex-1 text-xs"><span className="block text-sm font-semibold text-sf-text-primary">{row.part.label}</span><span className="text-sf-text-muted">{row.helper}</span></span>
              <input type="checkbox" checked={row.on} onChange={(event) => row.set(event.target.checked)} className="h-4 w-4 accent-sf-accent" />
            </label>
          ))}
        </div>
        <div className="mt-3 text-xs text-sf-text-muted">{timesOver === 1 ? 'Films the song once.' : `Films the song ${timesOver} times over.`}</div>
      </div>
    )
  }

  const renderScriptStep = () => (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-sf-text-primary">What happens in it?</h3>
        <p className="mt-1 text-xs leading-5 text-sf-text-secondary">Tell Velorn the idea and let Velo write the script, or write it with your own AI. Every shot stays editable.</p>
      </div>
      {/* Idea and extras side by side on a wide window; stacked on a narrow one. */}
      <div className="grid items-stretch gap-4 lg:grid-cols-2">
        {renderIdeaCard()}
        {renderCoverageCard()}
      </div>
      {renderWriteCard()}
      <div>
        <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-sf-text-primary">
                <FileText className="h-4 w-4 text-sf-accent" />
                Director script
              </div>
              <p className="mt-1 text-xs leading-5 text-sf-text-secondary">
                This script becomes the plan for the pictures and videos.
              </p>
            </div>
          </div>
          {scriptShots.length > 0 && (
            <div className="mt-3 flex items-center justify-between gap-3 text-xs text-sf-text-secondary">
              <span>{plural(scriptShots.length, 'shot')}</span>
              <button type="button" onClick={() => setScriptTextOpen((open) => !open)} className="text-sf-text-muted underline hover:text-sf-text-primary">
                {scriptTextOpen ? 'Show the shots' : 'Edit the text'}
              </button>
            </div>
          )}
          {scriptParts.length > 1 && !scriptTextOpen && (
            <div role="tablist" aria-label="Parts of the script" className="mt-2 flex flex-wrap gap-1 rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 p-1">
              {[...scriptParts.map((part) => ({ key: part.key, label: part.label, count: part.rows.length })), { key: 'all', label: 'All', count: scriptShots.length }].map((tab) => {
                const active = tab.key === 'all' ? scriptTab === 'all' : scriptPartShown?.key === tab.key
                return (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setScriptTab(tab.key)}
                    className={`rounded-md px-3 py-1.5 text-xs transition-colors ${active ? 'bg-sf-accent text-white' : 'text-sf-text-secondary hover:bg-sf-dark-800 hover:text-sf-text-primary'}`}
                  >
                    <span className="font-semibold">{tab.label}</span>
                    <span className={`ml-2 tabular-nums ${active ? 'text-white/80' : 'text-sf-text-muted'}`}>{tab.count}</span>
                  </button>
                )
              })}
            </div>
          )}
          {scriptShots.length > 0 && !scriptTextOpen ? (
            <ol className="mt-2 space-y-2">
              {scriptRowsShown.map(({ shot, index }) => {
                const who = String(shot.artistRaw || '').trim()
                const where = String(shot.placeRaw || '').trim()
                const whereName = where ? ((yoloMusicPlaces || []).find((entry) => entry.slug === placeSlug(where) || placeSlug(entry.label) === placeSlug(where))?.label || where) : ''
                const whoName = who ? who.split(/[,&+]/).map((name) => {
                  const wanted = normalizeCastSlug(name)
                  return (yoloMusicCast || []).find((entry) => normalizeCastSlug(entry.slug || entry.label) === wanted)?.label || name.trim()
                }).filter(Boolean).join(', ') : ''
                return (
                  <li key={shot.id || index} className="rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      <span className="font-semibold text-sf-text-primary">Shot {index + 1}</span>
                      {shot.startAtRaw && <span className="tabular-nums text-sf-text-muted">{shot.startAtRaw}</span>}
                      {whoName && <span className="rounded-full bg-sf-accent/20 px-2 py-0.5 text-[11px] text-sf-text-primary">{whoName}</span>}
                      {whereName && <span className="rounded-full border border-sf-dark-500 px-2 py-0.5 text-[11px] text-sf-text-secondary">{whereName}</span>}
                      {shot.part && <span className="text-[11px] text-sf-text-muted">{shot.part}</span>}
                    </div>
                    {shot.lyricMoment && <div className="mt-1 text-xs italic text-sf-text-secondary">“{shot.lyricMoment}”</div>}
                    {(shot.keyframePromptRaw || shot.imageBeat) && <p className="mt-1 text-xs leading-5 text-sf-text-primary">{shot.keyframePromptRaw || shot.imageBeat}</p>}
                    {(shot.motionPromptRaw || shot.videoBeat) && <p className="mt-1 text-xs leading-5 text-sf-text-muted">{shot.motionPromptRaw || shot.videoBeat}</p>}
                  </li>
                )
              })}
            </ol>
          ) : (
            <textarea
            value={yoloMusicScript}
            onChange={(event) => setYoloMusicScript(event.target.value)}
            placeholder="The script appears here. You can also paste one you wrote elsewhere."
            className="mt-4 min-h-[330px] w-full resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 font-mono text-xs leading-5 text-sf-text-primary outline-none focus:border-sf-accent"
          />
          )}
          {!yoloMusicScript.trim() && (
            <button
              type="button"
              onClick={() => { setYoloMusicScript(MUSIC_VIDEO_SCRIPT_TEMPLATE); setScriptTextOpen(true) }}
              className="mt-2 text-xs text-sf-text-muted underline hover:text-sf-text-primary"
            >
              Writing it yourself? Start from an example.
            </button>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-sf-text-muted">
              {parseStatus || (scriptHasUnusedChanges ? 'You changed the script. Press Use the changes to update the shots.' : yoloActivePlanIsStale ? 'Read the script, then press Use this script.' : 'Ready when the script has shots.')}
            </div>
            <button
              type="button"
              onClick={handleParseScript}
              disabled={!canBuildPlan}
              className="rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {scriptHasUnusedChanges ? 'Use the changes' : 'Use this script'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  // The Keyframes step (redesigned 2026-11-12): a plain heading, the model and
  // shape, ONE main button that says what it will do, then the shots as clean
  // cards. Clicking a shot opens its panel under that row.
  const renderKeyframesStep = () => {
    const missingCount = Math.max(0, plannedShotCount - yoloStoryboardReadyCount)
    const missingPrice = cloudPicturesOn && cloudPictureModel?.usd != null && missingCount > 0
      ? ` · about ${dollars(missingCount * cloudPictureModel.usd)}`
      : ''
    // What the big preview needs for one shot.
    const previewFor = (index) => {
      const { scene, shot } = flatShots[index]
      const variant = getVariantForShot(scene.id, shot.id)
      const asset = variant ? yoloStoryboardAssetMap?.get(variant.key) : null
      const url = getAssetUrl(asset)
      if (!url) return null
      // The caption says the picture's real size and what really made it.
      const sizeParts = buildActualImageResolutionParts(asset, runtimeImageDimensions, '')
      const placedFrom = asset?.yolo?.workflowId === 'manual-keyframe-replacement'
        ? imageAssets.find((entry) => entry?.id === asset.yolo?.manualReplacement?.sourceAssetId) || null
        : null
      const madeWith = asset?.yolo?.workflowId === 'manual-keyframe-replacement'
        ? (placedFrom?.routerGeneration ? (cloudPictureModel?.name || 'Cloud picture model') : 'Your own picture')
        : getGeneratedKeyframeWorkflowLabel(asset, selectedKeyframeWorkflowLabel)
      return {
        kind: 'image',
        url,
        title: shot.scriptShotLabel ? `Shot ${index + 1}: ${shot.scriptShotLabel}` : `Shot ${index + 1}`,
        subtitle: [plainPartName(getCoverageLabel(scene, shot)), madeWith, ...sizeParts].filter(Boolean).join(' / '),
        prompt: String(shot.imageBeat || shot.beat || shot.referenceImagePrompt || '').trim(),
        editablePrompt: true,
        sceneId: scene.id,
        shotId: shot.id,
        shotIndex: index,
      }
    }
    const openPreview = (index) => {
      const preview = previewFor(index)
      if (!preview) return
      setSelectedShotIndex(index)
      setMediaPreview(preview)
    }
    // The panel for the shot (or shots) picked, drawn under the row they are in.
    const renderPickedPanel = () => {
      if (!selectedShotRow) return null
      const hasPicture = !hasMultipleSelectedShots && Boolean(previewFor(selectedShotIndex))
      return (
        <div className="rounded-lg border border-sf-accent/50 bg-sf-dark-950/70 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-sf-text-primary">
              {hasMultipleSelectedShots ? `${selectedShotCount} shots picked` : `Shot ${selectedShotIndex + 1}`}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {hasPicture && (
                <button
                  type="button"
                  onClick={() => openPreview(selectedShotIndex)}
                  className="rounded-lg border border-sf-dark-600 px-3 py-1.5 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
                >
                  See it large
                </button>
              )}
              <button
                type="button"
                onClick={handleRegenerateSelectedKeyframe}
                disabled={singleKeyframeActionDisabled || cloudKeyframesBusy}
                className="rounded-lg bg-sf-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {hasMultipleSelectedShots ? `Make these ${selectedShotCount}` : hasPicture ? 'Make again' : 'Make it'}
              </button>
              {!hasMultipleSelectedShots && renderReplaceKeyframeButton(selectedShotRow, selectedShotIndex, 'Use my own picture')}
            </div>
          </div>
          {hasMultipleSelectedShots ? (
            <p className="mt-2 text-xs leading-5 text-sf-text-muted">Pick one shot to change what its picture shows.</p>
          ) : (
            <label className="mt-2 block text-xs text-sf-text-secondary">
              What the picture shows
              <textarea
                value={selectedShotRow.shot.imageBeat || selectedShotRow.shot.beat || ''}
                onChange={(event) => handleYoloShotImageBeatChange?.(selectedShotRow.scene.id, selectedShotRow.shot.id, event.target.value)}
                rows={4}
                className="mt-1 w-full resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs leading-5 text-sf-text-primary outline-none focus:border-sf-accent"
              />
            </label>
          )}
        </div>
      )
    }
    return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-sf-text-primary">Make the pictures</h3>
        <p className="mt-1 text-xs leading-5 text-sf-text-secondary">Each shot gets one picture. The video starts from it.</p>
      </div>
      {renderPictureMakerRow()}
      {pictureMaker === 'custom' && (
        <CustomWorkflowSlotCard
          kind="keyframe"
          workflowName={customKeyframeWorkflowName}
          workflowLoaded={customKeyframeWorkflowLoaded}
          validation={customKeyframeValidation}
          canOpenInComfyUi={canOpenCustomKeyframeWorkflow}
          onOpenInComfyUi={handleOpenYoloMusicCustomKeyframeWorkflowInComfyUi}
          onClear={handleClearYoloMusicCustomKeyframeWorkflow}
          onPickLibrary={(id) => handleUseYoloMusicLibraryWorkflow?.(id, 'keyframe')}
          onOpenStarter={() => handleOpenYoloMusicCustomStarter?.('keyframe')}
        />
      )}
      {!cloudPicturesOn && selectedKeyframeWorkflowId === FLUX2_KLEIN_WORKFLOW_ID && (
        <LocalModelSetup
          key={FLUX2_KLEIN_WORKFLOW_ID}
          workflowId={FLUX2_KLEIN_WORKFLOW_ID}
          name="FLUX.2 klein"
          about="It makes the cast pictures and keyframes on your own computer."
        />
      )}
      {renderShapePicker()}
      {renderMixedShapesNote()}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleQueueKeyframes}
          disabled={!canQueueKeyframes || isQueuingKeyframes || yoloDependencyCheckInProgress || cloudKeyframesBusy || missingCount === 0}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-sf-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isQueuingKeyframes ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
          {missingCount > 0 ? `Make the ${missingCount} missing ${missingCount === 1 ? 'picture' : 'pictures'}${missingPrice}` : 'All the pictures are made'}
        </button>
        <span className="text-sm text-sf-text-secondary">
          <span className="font-semibold text-sf-text-primary">{yoloStoryboardReadyCount} of {plannedShotCount}</span> ready
        </span>
        <span className="flex-1" />
        {plannedShotCount > 0 && (
          <button
            type="button"
            onClick={handleRegenerateAllKeyframes}
            disabled={isQueuingKeyframes || yoloDependencyCheckInProgress || !customKeyframeReady || cloudKeyframesBusy}
            className="text-xs text-sf-text-muted underline transition-colors hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Make them all again
          </button>
        )}
      </div>
      {yoloActivePlanIsStale && (
        <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-100">
          You changed the director script. Go back to Director Script and press Use the changes first.
        </div>
      )}
      {keyframeStatus && (
        <div className={`rounded-lg text-xs ${
          keyframeStatusIsWarning
            ? 'border border-amber-400/30 bg-amber-400/10 p-3 text-amber-100'
            : 'text-sf-text-secondary'
        }`}>
          {keyframeStatus}
        </div>
      )}
      {plannedShotCount > 0 && (
        <div className="space-y-3">
          {shotPasses.length > 1 && (
            <div role="tablist" aria-label="Parts of the script" className="flex flex-wrap gap-1 rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 p-1">
              {shotPasses.map((pass) => {
                const ready = pass.indexes.filter((shotIndex) => {
                  const entry = flatShots[shotIndex]
                  const passVariant = getVariantForShot(entry.scene.id, entry.shot.id)
                  return Boolean(passVariant && yoloStoryboardAssetMap?.get(passVariant.key))
                }).length
                const active = activeShotPass?.key === pass.key
                return (
                  <button
                    key={pass.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setShotPassKey(pass.key)}
                    className={`rounded-md px-3 py-1.5 text-xs transition-colors ${active ? 'bg-sf-accent text-white' : 'text-sf-text-secondary hover:bg-sf-dark-800 hover:text-sf-text-primary'}`}
                  >
                    <span className="font-semibold">{plainPartName(pass.label)}</span>
                    <span className={`ml-2 tabular-nums ${active ? 'text-white/80' : 'text-sf-text-muted'}`}>{ready}/{pass.indexes.length}</span>
                  </button>
                )
              })}
            </div>
          )}
          <p className="text-xs text-sf-text-muted">
            Click a shot to work on it. To make several at once, hold {/Mac/i.test(globalThis.navigator?.platform || '') ? 'Cmd' : 'Ctrl'} and click each one, or hold Shift and click to pick a whole range.
          </p>
          {activeShotSections.map((section) => (
          <div key={`keyframe-section-${section.key}`} className="space-y-2">
          {section.label && (
            <div className="flex items-baseline gap-2 pt-2">
              <span className="text-xs font-semibold text-sf-text-primary">{section.label}</span>
              {Number.isFinite(section.start) && <span className="text-[11px] tabular-nums text-sf-text-muted">{formatClock(section.start)}</span>}
              <span className="text-[11px] text-sf-text-muted">{plural(section.indexes.length, 'shot')}</span>
            </div>
          )}
          <div className="grid grid-flow-row-dense grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
            {section.indexes.map((index) => {
              const { scene, shot } = flatShots[index]
              const variant = getVariantForShot(scene.id, shot.id)
              const asset = variant ? yoloStoryboardAssetMap?.get(variant.key) : null
              const url = getAssetUrl(asset)
              const cloudMaking = Boolean(cloudMakingShots[`${scene.id}|${shot.id}`])
              // A shot being made in the cloud reads the same as one being made here.
              const cardState = cloudMaking ? { state: 'generating', label: 'Making the picture…' } : getKeyframeCardState(variant, asset)
              const keyframePrompt = String(shot.imageBeat || shot.beat || shot.referenceImagePrompt || '').trim()
              return (
                <Fragment key={`music-keyframe-${scene.id}-${shot.id}`}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={(event) => handleShotSelection(event, index)}
                  onKeyDown={(event) => handleShotCardKeyDown(event, index)}
                  aria-pressed={selectedShotIndexSet.has(index)}
                  className={`overflow-hidden rounded-lg border text-left transition-colors ${
                    selectedShotIndexSet.has(index)
                      ? `border-sf-accent bg-sf-accent/10 ${selectedShotIndex === index ? 'ring-1 ring-sf-accent/50' : ''}`
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
                        <span className={`relative text-[11px] ${
                          cardState.state === 'error' ? 'text-red-200' : 'text-sf-text-muted'
                        }`}>
                          {cardState.label}
                        </span>
                      </>
                    )}
                    {url && renderPreviewButton(() => openPreview(index))}
                    {url && cloudMaking && (
                      <span className="absolute bottom-2 left-2 inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2 py-1 text-[11px] text-white backdrop-blur">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Making a new one…
                      </span>
                    )}
                  </div>
                  <div className="p-2">
                    <div className="text-xs font-semibold text-sf-text-primary">
                      <span className="tabular-nums text-sf-text-muted">{formatClock(Number(shot?.audioStart) || 0)}</span>
                      <span className="ml-1.5">Shot {index + 1}</span>
                    </div>
                    <div className={`mt-0.5 line-clamp-1 text-[11px] text-sf-text-secondary ${shot.lyricMoment ? 'italic' : ''}`}>
                      {shot.lyricMoment ? `“${shot.lyricMoment}”` : (keyframePrompt || 'No description yet')}
                    </div>
                    {cardState.job?.progress > 0 && (
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-sf-dark-700">
                        <div className="h-full rounded-full bg-sf-accent" style={{ width: `${Math.min(100, Math.max(0, cardState.job.progress || 0))}%` }} />
                      </div>
                    )}
                  </div>
                </div>
                {/* The picked shot's panel, right under the row that shot is in. */}
                {selectedShotRow && index === selectedShotIndex && <div className="col-span-full">{renderPickedPanel()}</div>}
                </Fragment>
              )
            })}
          </div>
          </div>
          ))}
        </div>
      )}
    </div>
    )
  }

  // The Videos step (redesigned 2026-11-12 to match Keyframes): a plain
  // heading, the model and quality as rows, ONE main button, then the shots as
  // clean cards. Clicking a shot opens its panel under that row.
  // The older settings block (video size, frame rate, Custom Workflow) is
  // gone. MiniMax H3 is the one video model offered: LTX 2.3 Music, WAN 2.2
  // and Custom Workflow are hidden (not deleted) since 2026-11-12.
  const renderVideosStep = () => {
    const missingCount = Math.max(0, plannedShotCount - videoReadyCount)
    const withPicture = Math.max(0, Math.min(missingCount, yoloStoryboardReadyCount - videoReadyCount))
    const previewFor = (index) => {
      const { scene, shot } = flatShots[index]
      const videoUrl = getAssetUrl(getVideoAssetForVariant(getVariantForShot(scene.id, shot.id)))
      if (!videoUrl) return null
      const length = Number(shot?.length ?? shot?.durationSeconds ?? 0) || 0
      return {
        kind: 'video',
        url: videoUrl,
        title: shot.scriptShotLabel ? `Shot ${index + 1}: ${shot.scriptShotLabel}` : `Shot ${index + 1}`,
        subtitle: [plainPartName(getCoverageLabel(scene, shot)), `starts at ${formatClock(Number(shot?.audioStart) || 0)}`, length > 0 ? `${length.toFixed(1)} s long` : '', selectedVideoWorkflowLabel].filter(Boolean).join(' / '),
        prompt: String(shot.videoBeat || shot.beat || shot.shotPrompt || '').trim(),
        editablePrompt: true,
        sceneId: scene.id,
        shotId: shot.id,
        shotIndex: index,
      }
    }
    const openPreview = (index) => {
      const preview = previewFor(index)
      if (!preview) return
      setSelectedShotIndex(index)
      setMediaPreview(preview)
    }
    const renderPickedPanel = () => {
      if (!selectedShotRow) return null
      const hasVideo = !hasMultipleSelectedShots && Boolean(previewFor(selectedShotIndex))
      const start = Number(selectedShotRow.shot.audioStart) || 0
      const length = Number(selectedShotRow.shot.length || selectedShotRow.shot.durationSeconds) || 0
      return (
        <div className="rounded-lg border border-sf-accent/50 bg-sf-dark-950/70 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-sf-text-primary">
              {hasMultipleSelectedShots ? `${selectedShotCount} shots picked` : `Shot ${selectedShotIndex + 1}`}
              {!hasMultipleSelectedShots && (
                <span className="ml-2 text-xs font-normal text-sf-text-muted">
                  starts at {formatClock(start)}{length > 0 ? ` · ${length.toFixed(1)} s long` : ''}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {hasVideo && (
                <button
                  type="button"
                  onClick={() => openPreview(selectedShotIndex)}
                  className="rounded-lg border border-sf-dark-600 px-3 py-1.5 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
                >
                  See it large
                </button>
              )}
              <button
                type="button"
                onClick={handleRegenerateSelectedVideo}
                disabled={singleVideoActionDisabled}
                className="inline-flex items-center gap-2 rounded-lg bg-sf-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isQueuingVideos && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {hasMultipleSelectedShots ? `Make these ${selectedShotCount}` : hasVideo ? 'Make again' : 'Make it'}
              </button>
              {!hasMultipleSelectedShots && renderReplaceVideoButton(selectedShotRow, selectedShotIndex, 'Use my own video')}
            </div>
          </div>
          {hasMultipleSelectedShots ? (
            <p className="mt-2 text-xs leading-5 text-sf-text-muted">Pick one shot to change how it moves.</p>
          ) : (
            <label className="mt-2 block text-xs text-sf-text-secondary">
              How it moves
              <textarea
                value={selectedShotRow.shot.videoBeat || selectedShotRow.shot.beat || selectedShotRow.shot.shotPrompt || ''}
                onChange={(event) => handleYoloShotVideoBeatChange?.(selectedShotRow.scene.id, selectedShotRow.shot.id, event.target.value)}
                rows={4}
                className="mt-1 w-full resize-y rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs leading-5 text-sf-text-primary outline-none focus:border-sf-accent"
              />
            </label>
          )}
          {!hasMultipleSelectedShots && selectedShotRow.shot.scriptLyricMoment && (
            <p className="mt-1 text-xs italic text-sf-text-muted">“{selectedShotRow.shot.scriptLyricMoment}”</p>
          )}
        </div>
      )
    }
    return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-sf-text-primary">Make the videos</h3>
        <p className="mt-1 text-xs leading-5 text-sf-text-secondary">Each shot becomes a short clip that starts from its picture and follows your song.</p>
      </div>
      {/* The same kind of choice as "Pictures are made with" in Keyframes. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 px-4 py-3">
        <span className="text-sm font-semibold text-sf-text-primary">Videos are made with</span>
        <div role="group" aria-label="What makes the videos" className="inline-flex overflow-hidden rounded-lg border border-sf-dark-600">
          {[{ id: 'h3', label: 'MiniMax H3', title: 'Free, on this computer.' }, { id: 'custom', label: 'My own workflow', title: 'For people who build their own ComfyUI workflows.' }].map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={videoMaker === option.id}
              title={option.title}
              onClick={() => chooseVideoMaker(option.id)}
              className={`px-3 py-1.5 text-xs font-semibold transition-colors ${videoMaker === option.id ? 'bg-sf-accent text-white' : 'text-sf-text-secondary hover:bg-sf-dark-800 hover:text-sf-text-primary'}`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-sf-text-muted">
          {videoMaker === 'custom'
            ? 'A ComfyUI workflow of your own makes the videos. Whether the lips follow the song is up to that workflow.'
            : 'Free, on this computer.'}
        </span>
      </div>
      {videoMaker === 'custom' && (
        <CustomWorkflowSlotCard
          kind="video"
          workflowName={customVideoWorkflowName}
          workflowLoaded={customVideoWorkflowLoaded}
          validation={customVideoValidation}
          canOpenInComfyUi={canOpenCustomVideoWorkflow}
          onOpenInComfyUi={handleOpenYoloMusicCustomVideoWorkflowInComfyUi}
          onClear={handleClearYoloMusicCustomVideoWorkflow}
          onPickLibrary={(id) => handleUseYoloMusicLibraryWorkflow?.(id, 'video')}
          onOpenStarter={() => handleOpenYoloMusicCustomStarter?.('video')}
        />
      )}
      {selectedVideoWorkflowId === MINIMAX_H3_LOCAL_WORKFLOW_ID && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 px-4 py-3">
          <span className="text-sm font-semibold text-sf-text-primary">Quality</span>
          <div role="group" aria-label="Video quality" className="inline-flex overflow-hidden rounded-lg border border-sf-dark-600">
            {[...MINIMAX_H3_QUALITY_LEVELS].reverse().map((level) => (
              <button
                key={`music-video-quality-${level.id}`}
                type="button"
                aria-pressed={yoloMusicVideoQuality === level.id}
                onClick={() => setYoloMusicVideoQuality?.(level.id)}
                className={`px-3 py-1.5 text-xs font-semibold transition-colors ${yoloMusicVideoQuality === level.id ? 'bg-sf-accent text-white' : 'text-sf-text-secondary hover:bg-sf-dark-800 hover:text-sf-text-primary'}`}
              >
                {level.label}
              </button>
            ))}
          </div>
          <span className="text-xs text-sf-text-muted">Fast is about twice as quick and good for close-ups. Best is for wide shots and the final video.</span>
        </div>
      )}
      {selectedVideoWorkflowId === MINIMAX_H3_LOCAL_WORKFLOW_ID && (
        <LocalModelSetup
          key={MINIMAX_H3_LOCAL_WORKFLOW_ID}
          workflowId={MINIMAX_H3_LOCAL_WORKFLOW_ID}
          name="MiniMax H3"
          about="It makes the video shots on your own computer, with the lips following your song. It needs a strong graphics card with about 32 GB of memory."
          terms={{ text: 'MiniMax H3 has its own licence.', label: 'Read it on its model page', url: 'https://huggingface.co/Comfy-Org/MiniMax-H3' }}
        />
      )}
      {renderMixedShapesNote()}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleQueueVideos}
          disabled={!canQueueVideos || isQueuingVideos || yoloDependencyCheckInProgress || missingCount === 0}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-sf-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isQueuingVideos ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {missingCount === 0 ? 'All the videos are made' : withPicture === missingCount ? `Make the ${missingCount} missing ${missingCount === 1 ? 'video' : 'videos'}` : `Make ${withPicture === 1 ? 'the 1 video' : `the ${withPicture} videos`} that ${withPicture === 1 ? 'has' : 'have'} a picture`}
        </button>
        <span className="text-sm text-sf-text-secondary">
          <span className="font-semibold text-sf-text-primary">{videoReadyCount} of {plannedShotCount}</span> ready
        </span>
        <span className="flex-1" />
        {plannedShotCount > 0 && (
          <button
            type="button"
            onClick={handleRegenerateAllVideos}
            disabled={!canQueueVideos || isQueuingVideos || yoloDependencyCheckInProgress}
            className="text-xs text-sf-text-muted underline transition-colors hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            Make them all again
          </button>
        )}
      </div>
      {yoloStoryboardReadyCount < plannedShotCount && plannedShotCount > 0 && (
        <div className="text-xs text-sf-text-muted">
          {yoloStoryboardReadyCount === 0
            ? 'Make the pictures first, in Keyframes: every video starts from one.'
            : `${yoloStoryboardReadyCount} of ${plannedShotCount} shots have a picture so far. The rest need one from Keyframes before their video can be made.`}
        </div>
      )}
      {yoloActivePlanIsStale && (
        <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-100">
          You changed the director script. Go back to Director Script and press Use the changes first.
        </div>
      )}
      {videoStatus && <div className="text-xs text-sf-text-secondary">{videoStatus}</div>}
      {plannedShotCount > 0 && (
        <div className="space-y-3">
          {shotPasses.length > 1 && (
            <div role="tablist" aria-label="Parts of the script" className="flex flex-wrap gap-1 rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 p-1">
              {shotPasses.map((pass) => {
                const ready = pass.indexes.filter((shotIndex) => {
                  const entry = flatShots[shotIndex]
                  return Boolean(getVideoAssetForVariant(getVariantForShot(entry.scene.id, entry.shot.id)))
                }).length
                const active = activeShotPass?.key === pass.key
                return (
                  <button
                    key={pass.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setShotPassKey(pass.key)}
                    className={`rounded-md px-3 py-1.5 text-xs transition-colors ${active ? 'bg-sf-accent text-white' : 'text-sf-text-secondary hover:bg-sf-dark-800 hover:text-sf-text-primary'}`}
                  >
                    <span className="font-semibold">{plainPartName(pass.label)}</span>
                    <span className={`ml-2 tabular-nums ${active ? 'text-white/80' : 'text-sf-text-muted'}`}>{ready}/{pass.indexes.length}</span>
                  </button>
                )
              })}
            </div>
          )}
          <p className="text-xs text-sf-text-muted">
            Click a shot to work on it. To make several at once, hold {/Mac/i.test(globalThis.navigator?.platform || '') ? 'Cmd' : 'Ctrl'} and click each one, or hold Shift and click to pick a whole range.
          </p>
          {activeShotSections.map((section) => (
          <div key={`video-section-${section.key}`} className="grid grid-flow-row-dense grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
            {section.indexes.map((index) => {
              const { scene, shot } = flatShots[index]
              const variant = getVariantForShot(scene.id, shot.id)
              const keyframeAsset = variant ? yoloStoryboardAssetMap?.get(variant.key) : null
              const videoAsset = getVideoAssetForVariant(variant)
              const keyframeUrl = getAssetUrl(keyframeAsset)
              const videoUrl = getAssetUrl(videoAsset)
              const cardState = getVideoCardState(variant, videoAsset)
              const videoPrompt = String(shot.videoBeat || shot.beat || shot.shotPrompt || '').trim()
              return (
                <Fragment key={`music-video-${scene.id}-${shot.id}`}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={(event) => handleShotSelection(event, index)}
                  onKeyDown={(event) => handleShotCardKeyDown(event, index)}
                  aria-pressed={selectedShotIndexSet.has(index)}
                  className={`overflow-hidden rounded-lg border text-left transition-colors ${
                    selectedShotIndexSet.has(index)
                      ? `border-sf-accent bg-sf-accent/10 ${selectedShotIndex === index ? 'ring-1 ring-sf-accent/50' : ''}`
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
                    <ShotVideoPreview videoUrl={videoUrl} keyframeUrl={keyframeUrl} />
                    {cardState.state === 'generating' && (
                      <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                    )}
                    {videoUrl && renderPreviewButton(() => openPreview(index))}
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
                    <div className="text-xs font-semibold text-sf-text-primary">
                      <span className="tabular-nums text-sf-text-muted">{formatClock(Number(shot?.audioStart) || 0)}</span>
                      <span className="ml-1.5">Shot {index + 1}</span>
                    </div>
                    <div className={`mt-0.5 line-clamp-1 text-[11px] text-sf-text-secondary ${shot.lyricMoment ? 'italic' : ''}`}>
                      {shot.lyricMoment ? `“${shot.lyricMoment}”` : (videoPrompt || 'No description yet')}
                    </div>
                    {cardState.job?.progress > 0 && (
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-sf-dark-700">
                        <div className="h-full rounded-full bg-sf-accent" style={{ width: `${Math.min(100, Math.max(0, cardState.job.progress || 0))}%` }} />
                      </div>
                    )}
                  </div>
                </div>
                {selectedShotRow && index === selectedShotIndex && <div className="col-span-full">{renderPickedPanel()}</div>}
                </Fragment>
              )
            })}
          </div>
          ))}
        </div>
      )}
      {plannedShotCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-sf-dark-700 pt-3">
          <span className="text-xs text-sf-text-muted">When the videos you want are made, put them on a timeline to edit.</span>
          <button
            type="button"
            onClick={() => setStep('timeline')}
            className="rounded-lg bg-sf-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent-hover"
          >
            Next: Timeline
          </button>
        </div>
      )}
    </div>
    )
  }

  // The last step: the ready videos go onto a new timeline at their song times.
  const renderTimelineStep = () => (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-sf-text-primary">Put it on the timeline</h3>
        <p className="mt-1 text-xs leading-5 text-sf-text-secondary">Your videos are lined up with the song on a new timeline, ready to edit. You can come back and do this again after making more.</p>
      </div>
      <div className="text-sm text-sf-text-secondary">
        <span className="font-semibold text-sf-text-primary">{videoReadyCount} of {plannedShotCount}</span> videos ready
      </div>
      {plannedShotCount > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-5 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <p className="text-sm leading-6 text-sf-text-secondary">
              {videoReadyCount === 0
                ? 'Make at least one video first.'
                : `Velorn places the ${plural(videoReadyCount, 'ready video')} on a new timeline at their song times. You can do this again after making more.`}
            </p>
            {(() => {
              // The shapes of the videos that are ready, read from their pictures.
              const sizes = flatShots.map(({ scene, shot }) => {
                const variant = getVariantForShot(scene.id, shot.id)
                if (!variant || !getVideoAssetForVariant(variant)) return null
                const picture = yoloStoryboardAssetMap?.get(variant.key)
                if (!picture) return null
                const seen = runtimeImageDimensions[picture.id]
                return {
                  width: normalizeDimension(seen?.width ?? picture.width ?? picture.settings?.width),
                  height: normalizeDimension(seen?.height ?? picture.height ?? picture.settings?.height),
                }
              })
              const shapes = countPictureShapes(sizes)
              const suggested = shapes.wide + shapes.tall > 0
                ? (shapes.tall > shapes.wide ? 'tall' : 'wide')
                : (aspectRatio === 'vertical_9x16' ? 'tall' : 'wide')
              const chosen = timelineShapeChoice || suggested
              timelineShapeRef.current = chosen
              return (
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="text-xs font-semibold text-sf-text-primary">Timeline shape</span>
                  <div role="group" aria-label="Shape of the timeline" className="inline-flex overflow-hidden rounded-lg border border-sf-dark-600">
                    {[{ id: 'wide', label: '16:9', tall: false }, { id: 'tall', label: '9:16', tall: true }].map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={chosen === option.id}
                        onClick={() => setTimelineShapeChoice(option.id)}
                        className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold transition-colors ${chosen === option.id ? 'bg-emerald-600 text-white' : 'text-sf-text-secondary hover:bg-sf-dark-800 hover:text-sf-text-primary'}`}
                      >
                        <span aria-hidden="true" className={`rounded-[2px] border-[1.5px] border-current ${option.tall ? 'h-3.5 w-2' : 'h-2 w-3.5'}`} />
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <span className="text-xs font-semibold text-sf-text-primary">Size</span>
                  <div role="group" aria-label="Size of the timeline" className="inline-flex overflow-hidden rounded-lg border border-sf-dark-600">
                    {['720p', '1080p'].map((size) => (
                      <button
                        key={size}
                        type="button"
                        aria-pressed={timelineSize === size}
                        title={size === '720p' ? 'The size the videos are made in.' : 'The videos are scaled up to fit. Common for YouTube.'}
                        onClick={() => setTimelineSize(size)}
                        className={`px-3 py-1.5 text-xs font-semibold transition-colors ${timelineSize === size ? 'bg-emerald-600 text-white' : 'text-sf-text-secondary hover:bg-sf-dark-800 hover:text-sf-text-primary'}`}
                      >
                        {size}
                      </button>
                    ))}
                  </div>
                  <span className="text-xs text-sf-text-muted">
                    {shapes.mixed
                      ? `${plural(shapes.wide, 'ready video')} ${shapes.wide === 1 ? 'is' : 'are'} 16:9 and ${shapes.tall} ${shapes.tall === 1 ? 'is' : 'are'} 9:16.`
                      : shapes.wide + shapes.tall > 0
                        ? `Your ready videos are ${shapes.tall > 0 ? '9:16' : '16:9'}.`
                        : ''}
                  </span>
                </div>
              )
            })()}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-xs font-semibold text-sf-text-primary">Cut</span>
              <div role="group" aria-label="How the timeline is laid out" className="inline-flex overflow-hidden rounded-lg border border-sf-dark-600">
                {[{ id: 'layers', label: 'Layers to edit' }, { id: 'ready', label: 'Ready cut' }].map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={timelineCut === option.id}
                    onClick={() => setTimelineCut(option.id)}
                    className={`px-3 py-1.5 text-xs font-semibold transition-colors ${timelineCut === option.id ? 'bg-emerald-600 text-white' : 'text-sf-text-secondary hover:bg-sf-dark-800 hover:text-sf-text-primary'}`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <span className="text-xs text-sf-text-muted">
                {timelineCut === 'ready'
                  ? 'One layer that plays as a finished video. Velorn picks a take for each sung line and fills the gaps with shots that have no singing.'
                  : 'Each pass gets its own layer. You choose the takes and place the shots.'}
              </span>
            </div>
            {timelineStatus && <p className="mt-2 text-xs text-emerald-100">{timelineStatus}</p>}
          </div>
          <button
            type="button"
            onClick={handleAssembleTimeline}
            disabled={!handleAssembleMusicVideoTimeline || videoReadyCount === 0 || yoloActivePlanIsStale || isAssemblingTimeline}
            className="inline-flex flex-shrink-0 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {isAssemblingTimeline ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />}
            {isAssemblingTimeline ? 'Placing…' : 'Put it on the timeline'}
          </button>
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
    // Follow the shot, not the picture that was showing when the preview
    // opened: after a remake the newest keyframe or video appears here too.
    const previewVariant = previewShotRow ? getVariantForShot(previewShotRow.scene.id, previewShotRow.shot.id) : null
    const previewLiveAsset = !previewVariant ? null
      : editableKeyframePrompt ? yoloStoryboardAssetMap?.get(previewVariant.key)
        : editableVideoPrompt ? getVideoAssetForVariant(previewVariant) : null
    const previewUrl = getAssetUrl(previewLiveAsset) || mediaPreview.url
    const hasImageBeat = previewShot && Object.prototype.hasOwnProperty.call(previewShot, 'imageBeat')
    const previewPromptFallback = editableKeyframePrompt
      ? String(hasImageBeat ? previewShot.imageBeat : (previewShot?.beat || previewShot?.referenceImagePrompt || ''))
      : editableVideoPrompt
        ? String(previewShot?.videoBeat || previewShot?.beat || previewShot?.shotPrompt || '')
        : ''
    const previewPrompt = String(mediaPreview.prompt ?? previewPromptFallback)
    const previewPromptEmpty = editablePreviewPrompt && !previewPrompt.trim()
    const previewRunDisabled = !previewShotRow || previewPromptEmpty || (editableKeyframePrompt ? singleKeyframeActionDisabled : singleVideoActionDisabled)
    const previewPromptLabel = editableKeyframePrompt ? 'Keyframe prompt' : 'Video motion prompt'
    const previewWorkflowLabel = editableKeyframePrompt ? selectedKeyframeWorkflowLabel : selectedVideoWorkflowLabel
    const previewStatusSetter = editableKeyframePrompt ? setKeyframeStatus : setVideoStatus
    const previewCopiedMessage = `Shot ${previewShotIndex + 1} ${editableKeyframePrompt ? 'keyframe' : 'video'} prompt copied.`
    const previewKindLabel = editableKeyframePrompt ? 'keyframe' : 'video'
    const previewActionLabel = editableKeyframePrompt ? 'Regenerate Keyframe' : 'Regenerate Video'
    const previewActionBusy = (editableKeyframePrompt ? isQueuingKeyframes : isQueuingVideos) && selectedShotIndex === previewShotIndex
    const previewActionTitle = previewRunDisabled
      ? previewPromptEmpty
        ? `Add a ${previewKindLabel} prompt before regenerating.`
        : `${editableKeyframePrompt ? 'Keyframes' : 'Videos'} cannot be queued right now.`
      : `Regenerate this ${previewKindLabel} with ${previewWorkflowLabel}.`

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
                  key={previewUrl}
                  src={previewUrl}
                  className="max-h-[72vh] max-w-full object-contain"
                  controls
                  autoPlay
                  playsInline
                />
              ) : (
                <img
                  src={previewUrl}
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
                    {editableKeyframePrompt && previewShotRow ? (
                      renderReplaceKeyframeButton(previewShotRow, previewShotIndex, 'Replace')
                    ) : null}
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
                      title={previewActionTitle}
                    >
                      {previewActionBusy
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : editableKeyframePrompt
                          ? <Wand2 className="h-3 w-3" />
                          : <Play className="h-3 w-3" />}
                      {previewActionLabel}
                    </button>
                  </div>
                </div>
                <textarea
                  value={previewPrompt}
                  aria-label={`Edit ${previewKindLabel} prompt`}
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
                {editableKeyframePrompt && previewShotRow ? renderNanoBananaShotReferences(previewShotRow, true) : null}
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

  const renderReplaceKeyframeModal = () => {
    if (!replaceKeyframeTarget) return null
    const selectedAssetUrl = getAssetUrl(selectedReplacementAsset)

    return (
      <div
        className="fixed inset-0 z-50 overflow-y-auto bg-black/80 px-4 py-6 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-label="Replace keyframe"
        onClick={closeReplaceKeyframeDialog}
      >
        <div className="flex min-h-full items-center justify-center">
          <div
            className="w-[94vw] max-w-2xl rounded-lg border border-sf-dark-600 bg-sf-dark-950 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-sf-dark-700 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-sf-text-primary">Replace keyframe</div>
                <div className="mt-1 truncate text-[10px] text-sf-text-muted">{replaceKeyframeTarget.label}</div>
              </div>
              <button
                type="button"
                onClick={closeReplaceKeyframeDialog}
                disabled={replacementBusy}
                className="rounded-md p-1.5 text-sf-text-muted transition-colors hover:bg-sf-dark-800 hover:text-sf-text-primary focus:outline-none focus:ring-2 focus:ring-sf-accent disabled:cursor-not-allowed disabled:opacity-50"
                title="Close"
                aria-label="Close replace keyframe"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 p-4">
              <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-3">
                <div className="text-xs font-semibold text-sf-text-primary">Import a new image</div>
                <p className="mt-1 text-[11px] leading-5 text-sf-text-secondary">
                  The imported image becomes the keyframe for this shot. Existing images stay untouched.
                </p>
                <input
                  ref={replacementFileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleReplacementFileChange}
                />
                <button
                  type="button"
                  onClick={() => replacementFileInputRef.current?.click()}
                  disabled={replacementBusy}
                  className="mt-3 inline-flex items-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {replacementBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                  Import Image
                </button>
              </div>

              <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-3">
                <div className="text-xs font-semibold text-sf-text-primary">Use an existing project image</div>
                <div className="mt-3 grid gap-3 md:grid-cols-[1fr_120px] md:items-start">
                  <div className="space-y-3">
                    <select
                      value={replacementAssetId}
                      onChange={(event) => setReplacementAssetId(event.target.value)}
                      disabled={replacementBusy || replacementImageAssets.length === 0}
                      className="w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <option value="">{replacementImageAssets.length === 0 ? 'No image assets found' : 'Choose image...'}</option>
                      {replacementImageAssets.map((asset) => (
                        <option key={asset.id} value={asset.id}>
                          {asset.name || asset.path || asset.id}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleUseSelectedReplacementAsset}
                      disabled={replacementBusy || !replacementAssetId}
                      className="inline-flex items-center gap-2 rounded-lg border border-sf-dark-600 px-3 py-2 text-xs font-semibold text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {replacementBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImageIcon className="h-3.5 w-3.5" />}
                      Use Selected Image
                    </button>
                  </div>
                  <div className="flex h-24 items-center justify-center overflow-hidden rounded-lg border border-sf-dark-700 bg-sf-dark-950">
                    {selectedAssetUrl ? (
                      <img src={selectedAssetUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <ImageIcon className="h-5 w-5 text-sf-text-muted" />
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const renderReplaceVideoModal = () => {
    if (!replaceVideoTarget) return null
    const selectedAssetUrl = getAssetUrl(selectedVideoReplacementAsset)

    return (
      <div
        className="fixed inset-0 z-50 overflow-y-auto bg-black/80 px-4 py-6 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-label="Replace video"
        onClick={closeReplaceVideoDialog}
      >
        <div className="flex min-h-full items-center justify-center">
          <div
            className="w-[94vw] max-w-2xl rounded-lg border border-sf-dark-600 bg-sf-dark-950 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-sf-dark-700 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-sf-text-primary">Replace video</div>
                <div className="mt-1 truncate text-[10px] text-sf-text-muted">{replaceVideoTarget.label}</div>
              </div>
              <button
                type="button"
                onClick={closeReplaceVideoDialog}
                disabled={videoReplacementBusy}
                className="rounded-md p-1.5 text-sf-text-muted transition-colors hover:bg-sf-dark-800 hover:text-sf-text-primary focus:outline-none focus:ring-2 focus:ring-sf-accent disabled:cursor-not-allowed disabled:opacity-50"
                title="Close"
                aria-label="Close replace video"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 p-4">
              <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-3">
                <div className="text-xs font-semibold text-sf-text-primary">Import a new video</div>
                <p className="mt-1 text-[11px] leading-5 text-sf-text-secondary">
                  The imported clip becomes the ready video for this shot. Existing videos stay untouched.
                </p>
                <input
                  ref={videoReplacementFileInputRef}
                  type="file"
                  accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi"
                  className="hidden"
                  onChange={handleVideoReplacementFileChange}
                />
                <button
                  type="button"
                  onClick={() => videoReplacementFileInputRef.current?.click()}
                  disabled={videoReplacementBusy}
                  className="mt-3 inline-flex items-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {videoReplacementBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                  Import Video
                </button>
              </div>

              <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-3">
                <div className="text-xs font-semibold text-sf-text-primary">Use an existing project video</div>
                <div className="mt-3 grid gap-3 md:grid-cols-[1fr_160px] md:items-start">
                  <div className="space-y-3">
                    <select
                      value={videoReplacementAssetId}
                      onChange={(event) => setVideoReplacementAssetId(event.target.value)}
                      disabled={videoReplacementBusy || replacementVideoAssets.length === 0}
                      className="w-full rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <option value="">{replacementVideoAssets.length === 0 ? 'No video assets found' : 'Choose video...'}</option>
                      {replacementVideoAssets.map((asset) => (
                        <option key={asset.id} value={asset.id}>
                          {asset.name || asset.path || asset.id}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleUseSelectedVideoReplacementAsset}
                      disabled={videoReplacementBusy || !videoReplacementAssetId}
                      className="inline-flex items-center gap-2 rounded-lg border border-sf-dark-600 px-3 py-2 text-xs font-semibold text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {videoReplacementBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Film className="h-3.5 w-3.5" />}
                      Use Selected Video
                    </button>
                  </div>
                  <div className="flex h-24 items-center justify-center overflow-hidden rounded-lg border border-sf-dark-700 bg-sf-dark-950">
                    {selectedAssetUrl ? (
                      <video src={selectedAssetUrl} className="h-full w-full object-cover" muted playsInline />
                    ) : (
                      <Film className="h-5 w-5 text-sf-text-muted" />
                    )}
                  </div>
                </div>
              </div>
            </div>
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
    timeline: renderTimelineStep,
  }[step] || renderSongStep

  return (
    <div className="dh-colours" style={{ '--dh-top': `${fixedTopHeight}px` }}>
      <div className="space-y-4">
        {/* The heading, pictures and step bar stay put; only the step below scrolls. */}
        <div ref={fixedTopRef} className="sticky -top-4 z-30 -mx-5 -mt-4 space-y-4 bg-sf-dark-950 px-5 pb-3 pt-4" style={{ marginBottom: Math.max(0, fullTopHeight - fixedTopHeight) }}>
        <DirectorHero small={scrolledDown} />
        <nav aria-label="Steps" className="flex items-start justify-center pb-1">
          {STEPS.map((entry, index) => {
            const selected = step === entry.id
            const disabled = isStepDisabled(entry.id)
            const done = !selected && stepDone[entry.id]
            return (
              <Fragment key={entry.id}>
                {index > 0 && <span aria-hidden="true" className={`mt-[19px] h-px w-10 flex-shrink-0 md:w-12 ${stepDone[STEPS[index - 1].id] ? 'dh-step-line-done' : 'bg-sf-dark-600'}`} />}
                <button
                  type="button"
                  onClick={() => setStep(entry.id)}
                  disabled={disabled}
                  aria-current={selected ? 'step' : undefined}
                  className="group flex w-24 flex-col items-center gap-2 disabled:cursor-not-allowed md:w-[120px]"
                >
                  <span className={`flex h-10 w-10 items-center justify-center rounded-full border text-sm font-semibold transition-colors ${
                    selected
                      ? 'dh-step-now'
                      : done
                        ? 'dh-step-done'
                        : disabled
                          ? 'border-sf-dark-700 text-sf-text-muted/50'
                          : 'border-sf-dark-500 text-sf-text-secondary group-hover:border-[#9D86FF]/70 group-hover:text-sf-text-primary'
                  }`}>
                    {done ? <Check className="h-5 w-5" aria-label="Done" /> : entry.number}
                  </span>
                  <span className={`text-sm ${selected ? 'font-semibold text-sf-text-primary' : disabled ? 'text-sf-text-muted/50' : 'text-sf-text-secondary group-hover:text-sf-text-primary'}`}>{entry.label}</span>
                </button>
              </Fragment>
            )
          })}
        </nav>
        </div>

        <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-950/60 p-4 md:p-5">
          {stepRenderer()}
        </div>
      </div>
      {/* In view from every step, so a batch can be followed while looking elsewhere. */}
      {renderCloudKeyframes()}
      {renderMediaPreviewModal()}
      {renderReplaceKeyframeModal()}
      {renderReplaceVideoModal()}
    </div>
  )
}
