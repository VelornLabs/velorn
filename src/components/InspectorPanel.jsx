import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { 
  Move, RotateCw, Maximize2, Clock, Layers,
  ChevronDown, ChevronRight, ChevronLeft, Sparkles,
  Zap, Eye, SlidersHorizontal, CircleDot, Lock, Unlock,
  FlipHorizontal, FlipVertical, Link, Unlink, Crop,
  Anchor, RotateCcw, Type, AlignLeft, AlignCenter, AlignRight,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  Diamond, ChevronFirst, ChevronLast,
  FileVideo, FileImage, FileAudio, HardDrive, Calendar, Info,
  Wand2, Trash2, EyeOff, Plus, Play, Loader2, Check, AlertTriangle, X,
  Copy, ClipboardPaste, Square
} from 'lucide-react'
import useTimelineStore, { buildClipSyncLock, isMusicVideoSyncCapableClip, isSyncLockedClip } from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import renderCacheService from '../services/renderCache'
import { commitAdjustmentRender } from '../services/commitRender'
import { saveRenderCache, deleteRenderCache, writeGeneratedOverlayToProject, isElectron } from '../services/fileSystem'
import { getKeyframeAtTime, getAnimatedTransform, getAnimatedAdjustmentSettings, getAnimatedShapeProperties, EASING_OPTIONS } from '../utils/keyframes'
import { TEXT_ANIMATION_PRESETS, TEXT_ANIMATION_MODE_OPTIONS } from '../utils/textAnimationPresets'
import {
  COLOR_ADJUSTMENT_KEYS,
  DEFAULT_ADJUSTMENT_SETTINGS,
  getAdjustmentValue,
  mergeAdjustmentSettings,
  normalizeAdjustmentSettings,
  setAdjustmentValue,
  TONAL_ADJUSTMENT_GROUP_KEYS,
} from '../utils/adjustments'
import { clearDiskCacheUrl } from './VideoLayerRenderer'
import EffectsStack from './effects/EffectsStack'
import { isManagedEffectType } from '../utils/effects'
import { FRAME_RATE, TRANSITION_TYPES, TRANSITION_DEFAULT_SETTINGS } from '../constants/transitions'

// Clip speed UI: the store accepts 0.1x-8x continuously (timelineStore
// clamps in updateClipSpeed). The slider is log-scaled so the slow-motion
// half (0.1x-1x) gets half the travel instead of a sliver of a linear track.
const CLIP_SPEED_MIN = 0.1
const CLIP_SPEED_MAX = 8
const CLIP_SPEED_PRESETS = [0.25, 0.5, 1, 2, 4]
const speedToSliderPosition = (speed) => {
  const clamped = Math.max(CLIP_SPEED_MIN, Math.min(CLIP_SPEED_MAX, Number(speed) || 1))
  return Math.log(clamped / CLIP_SPEED_MIN) / Math.log(CLIP_SPEED_MAX / CLIP_SPEED_MIN)
}
const sliderPositionToSpeed = (position) => {
  const clamped = Math.max(0, Math.min(1, Number(position) || 0))
  const raw = CLIP_SPEED_MIN * Math.pow(CLIP_SPEED_MAX / CLIP_SPEED_MIN, clamped)
  return Math.round(raw * 100) / 100
}
import {
  DEFAULT_LETTERBOX_ASPECT,
  LETTERBOX_ASPECT_PRESETS,
  resolveLetterboxAspect,
  getLetterboxContentRect,
  generateLetterboxOverlayBlob,
} from '../utils/overlayGenerators'
import {
  DEFAULT_AUDIO_CLIP_GAIN_DB,
  MIN_AUDIO_CLIP_GAIN_DB,
  MAX_AUDIO_CLIP_GAIN_DB,
  normalizeAudioClipGainDb,
} from '../utils/audioClipGain'
import {
  CLIP_COMPOSITE_MODE_OPTIONS,
  getClipLowerLayerCompositeStatus,
  normalizeClipCompositeMode,
} from '../utils/layerCompositing'
import { DEFAULT_LINE_THICKNESS, DEFAULT_POLYGON_SIDES, DEFAULT_SHAPE_PROPERTIES, SHAPE_FILL_TYPES, SHAPE_TYPES, normalizeShapeProperties } from '../utils/shapes'

const TRANSITION_DEFAULT_DURATION_KEY = 'comfystudio-transition-default-duration-frames'
const INSPECTOR_EXPANDED_SECTIONS_KEY = 'comfystudio-inspector-expanded-sections-v1'
const INSPECTOR_EXPANDED_ADJUSTMENT_GROUPS_KEY = 'comfystudio-inspector-expanded-adjustment-groups-v1'
const DEFAULT_INSPECTOR_EXPANDED_SECTIONS = ['clipInfo', 'transform', 'compositing', 'crop', 'timing', 'effects', 'text', 'style', 'shape', 'animation', 'adjustments', 'commit']
const DEFAULT_EXPANDED_ADJUSTMENT_GROUPS = ['global']
const INSPECTOR_SETTINGS_SCOPE = {
  ALL: 'all',
  TRANSFORM: 'transform',
  CROP: 'crop',
  ADJUSTMENTS: 'adjustments',
  TIMING: 'timing',
}
const INSPECTOR_SETTINGS_SCOPE_LABELS = {
  [INSPECTOR_SETTINGS_SCOPE.ALL]: 'all settings',
  [INSPECTOR_SETTINGS_SCOPE.TRANSFORM]: 'transform settings',
  [INSPECTOR_SETTINGS_SCOPE.CROP]: 'crop settings',
  [INSPECTOR_SETTINGS_SCOPE.ADJUSTMENTS]: 'color settings',
  [INSPECTOR_SETTINGS_SCOPE.TIMING]: 'timing settings',
}
const TRANSFORM_SETTINGS_KEYS = ['positionX', 'positionY', 'positionZ', 'scaleX', 'scaleY', 'scaleLinked', 'rotation', 'rotationX', 'rotationY', 'perspective', 'anchorX', 'anchorY', 'opacity', 'flipH', 'flipV', 'motionBlurEnabled', 'motionBlurMode', 'motionBlurPosition', 'motionBlurSamples', 'motionBlurShutter', 'motionBlurSharpness', 'blendMode']
const CROP_SETTINGS_KEYS = ['cropTop', 'cropBottom', 'cropLeft', 'cropRight']
const TONAL_ADJUSTMENT_GROUP_LABELS = {
  shadows: 'Shadows',
  midtones: 'Midtones',
  highlights: 'Highlights',
}
const ADJUSTMENT_CONTROL_DEFINITIONS = [
  { key: 'brightness', label: 'Exposure', min: -100, max: 100, step: 1, resetTitle: 'Double-click to reset to 0', formatValue: (value) => `${Math.round(value)}` },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, resetTitle: 'Double-click to reset to 0', formatValue: (value) => `${Math.round(value)}` },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1, resetTitle: 'Double-click to reset to 0', formatValue: (value) => `${Math.round(value)}` },
  { key: 'gain', label: 'Gain', min: -100, max: 100, step: 1, resetTitle: 'Double-click to reset to 0', formatValue: (value) => `${Math.round(value)}` },
  { key: 'gamma', label: 'Gamma', min: -100, max: 100, step: 1, resetTitle: 'Double-click to reset to 0', formatValue: (value) => `${Math.round(value)}` },
  { key: 'offset', label: 'Offset', min: -100, max: 100, step: 1, resetTitle: 'Double-click to reset to 0', formatValue: (value) => `${Math.round(value)}` },
  { key: 'hue', label: 'Hue', min: -180, max: 180, step: 1, resetTitle: 'Double-click to reset to 0deg', formatValue: (value) => `${Math.round(value)}deg` },
]
const GLOBAL_COLOR_CONTROLS = [...ADJUSTMENT_CONTROL_DEFINITIONS]
const ADJUSTMENT_BLUR_CONTROL = {
  key: 'blur',
  label: 'Blur',
  min: 0,
  max: 50,
  step: 0.25,
  resetTitle: 'Double-click to reset to 0px',
  formatValue: (value) => `${Number(value).toFixed(1)}px`,
}
const RESET_CROP_SETTINGS = {
  cropTop: 0,
  cropBottom: 0,
  cropLeft: 0,
  cropRight: 0,
}

const getCopyableTextStyleProperties = (textProperties = {}) => {
  if (!textProperties || typeof textProperties !== 'object') return {}
  const { text, ...styleProps } = textProperties
  return { ...styleProps }
}

const getInspectorSettingsSourceLabel = (clip, track) => {
  if (!clip) return 'clip'
  if (clip.type === 'text') return 'text clip'
  if (clip.type === 'shape') return 'shape clip'
  if (clip.type === 'adjustment') return 'adjustment clip'
  if (clip.type === 'audio' || track?.type === 'audio') return 'audio clip'
  if (clip.type === 'image') return 'image clip'
  return 'video clip'
}

const objectHasDifferences = (current, next) => {
  if (!next || typeof next !== 'object') return false
  return Object.entries(next).some(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return objectHasDifferences(current?.[key], value)
    }
    return current?.[key] !== value
  })
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key)

const pickInspectorSettings = (source, keys = []) => {
  if (!source || typeof source !== 'object') return null
  const next = keys.reduce((acc, key) => {
    if (hasOwn(source, key)) {
      acc[key] = source[key]
    }
    return acc
  }, {})
  return Object.keys(next).length > 0 ? next : null
}

const padTimecodeUnit = (value) => String(Math.max(0, Math.trunc(value) || 0)).padStart(2, '0')
const normalizeLinkGroupId = (value) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

const formatInspectorTimecode = (seconds, fps = FRAME_RATE) => {
  if (!Number.isFinite(Number(seconds))) return 'Unknown'
  const roundedFps = Math.max(1, Math.round(Number(fps) || FRAME_RATE))
  const totalFrames = Math.max(0, Math.round(Number(seconds) * roundedFps))
  const frames = totalFrames % roundedFps
  const totalSeconds = Math.floor(totalFrames / roundedFps)
  const secs = totalSeconds % 60
  const mins = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return `${padTimecodeUnit(hours)}:${padTimecodeUnit(mins)}:${padTimecodeUnit(secs)}:${padTimecodeUnit(frames)}`
}

const formatInspectorFrameRate = (fps) => {
  if (!Number.isFinite(Number(fps)) || Number(fps) <= 0) return 'Unknown'
  const rounded = Math.round(Number(fps) * 100) / 100
  if (Number.isInteger(rounded)) return String(rounded)
  return rounded.toFixed(2).replace(/\.?0+$/, '')
}

const formatInspectorResolution = (width, height) => {
  const safeWidth = Math.round(Number(width) || 0)
  const safeHeight = Math.round(Number(height) || 0)
  if (safeWidth <= 0 || safeHeight <= 0) return 'Unknown'
  return `${safeWidth}x${safeHeight}`
}

const firstPositiveNumber = (...values) => {
  for (const value of values) {
    const number = Number(value)
    if (Number.isFinite(number) && number > 0) return number
  }
  return null
}

const getAssetInspectorWidth = (asset) => firstPositiveNumber(
  asset?.settings?.width,
  asset?.width,
  asset?.metadata?.width,
  asset?.mediaInfo?.width
)

const getAssetInspectorHeight = (asset) => firstPositiveNumber(
  asset?.settings?.height,
  asset?.height,
  asset?.metadata?.height,
  asset?.mediaInfo?.height
)

const getAssetInspectorSize = (asset) => firstPositiveNumber(
  asset?.size,
  asset?.fileSize,
  asset?.sizeBytes,
  asset?.metadata?.size,
  asset?.metadata?.fileSize,
  asset?.metadata?.sizeBytes
)

const getFileExtensionLabel = (filename) => {
  if (!filename) return 'Unknown'
  const parts = filename.split('.')
  return parts.length > 1 ? parts.pop().toUpperCase() : 'Unknown'
}

const CODEC_LABELS = {
  h264: 'H.264',
  hevc: 'H.265 / HEVC',
  h265: 'H.265 / HEVC',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  aac: 'AAC',
  mp3: 'MP3',
  opus: 'Opus',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  pcm_s16le: 'PCM S16LE',
  pcm_s24le: 'PCM S24LE',
  pcm_f32le: 'PCM F32LE',
}

const formatMediaCodecLabel = (codec) => {
  if (!codec) return 'Unknown'
  const normalized = String(codec).trim().toLowerCase()
  return CODEC_LABELS[normalized] || String(codec).toUpperCase()
}

const formatAssetFormatLabel = (asset) => {
  if (!asset) return 'Unknown'
  const mimeSubtype = asset.mimeType?.split('/')?.[1]
  if (mimeSubtype) {
    return mimeSubtype.split(';')[0].toUpperCase()
  }
  return getFileExtensionLabel(asset.name)
}

// Draggable number input component - click and drag to change value
function DraggableNumberInput({ value, onChange, onCommit, min, max, step = 1, sensitivity = 0.5, suffix = '', className = '', resetValue, onReset }) {
  const [isDragging, setIsDragging] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(value.toString())
  const startX = useRef(0)
  const startValue = useRef(0)
  const inputRef = useRef(null)
  
  // Update edit value when value changes externally
  useEffect(() => {
    if (!isEditing) {
      setEditValue(value.toString())
    }
  }, [value, isEditing])
  
  // Handle drag
  useEffect(() => {
    if (!isDragging) return
    
    const handleMouseMove = (e) => {
      const deltaX = e.clientX - startX.current
      let newValue = startValue.current + (deltaX * sensitivity * step)
      
      // Apply min/max constraints
      if (min !== undefined) newValue = Math.max(min, newValue)
      if (max !== undefined) newValue = Math.min(max, newValue)
      
      // Round to step
      newValue = Math.round(newValue / step) * step
      
      onChange(newValue)
    }
    
    const handleMouseUp = () => {
      setIsDragging(false)
      onCommit && onCommit(value)
    }
    
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isDragging, onChange, onCommit, value, min, max, step, sensitivity])
  
  const handleMouseDown = (e) => {
    if (isEditing) return
    if ((e.altKey || e.shiftKey) && resetToDefault()) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    e.preventDefault()
    startX.current = e.clientX
    startValue.current = value
    setIsDragging(true)
  }
  
  const resetToDefault = () => {
    if (resetValue === undefined) return false
    let newValue = resetValue
    if (min !== undefined) newValue = Math.max(min, newValue)
    if (max !== undefined) newValue = Math.min(max, newValue)
    onChange(newValue)
    if (onReset) {
      onReset(newValue)
    } else {
      onCommit && onCommit(newValue)
    }
    return true
  }

  const handleDoubleClick = (e) => {
    if ((e.altKey || e.shiftKey) && resetToDefault()) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    setIsEditing(true)
    setEditValue(value.toString())
    setTimeout(() => inputRef.current?.select(), 0)
  }
  
  const handleInputBlur = () => {
    setIsEditing(false)
    let newValue = parseFloat(editValue) || 0
    if (min !== undefined) newValue = Math.max(min, newValue)
    if (max !== undefined) newValue = Math.min(max, newValue)
    onChange(newValue)
    onCommit && onCommit(newValue)
  }
  
  const handleInputKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      handleInputBlur()
    } else if (e.key === 'Escape') {
      setIsEditing(false)
      setEditValue(value.toString())
    }
  }
  
  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="number"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleInputBlur}
        onKeyDown={handleInputKeyDown}
        autoFocus
        className={`w-full bg-sf-dark-700 border border-sf-accent rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none ${className}`}
      />
    )
  }
  
  return (
    <div
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      className={`w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary cursor-ew-resize select-none hover:border-sf-dark-500 transition-colors ${className}`}
      title={resetValue === undefined ? 'Drag to adjust, double-click to edit' : 'Drag to adjust, double-click to edit, Alt/Shift-click to reset'}
    >
      {Math.round(value * 100) / 100}{suffix}
    </div>
  )
}

// Available fonts for text clips
const FONT_OPTIONS = [
  'Inter', 'Arial', 'Helvetica', 'Times New Roman', 'Georgia', 
  'Courier New', 'Verdana', 'Impact', 'Comic Sans MS', 'Trebuchet MS'
]

/**
 * Keyframe button component - shows diamond icon that can be clicked to toggle keyframes
 * Yellow = keyframe at current time, Gray = no keyframe, Blue outline = property has keyframes
 */
function KeyframeButton({ clipId, property, clip, playheadPosition }) {
  const { 
    toggleKeyframe, 
    goToNextKeyframe, 
    goToPrevKeyframe,
  } = useTimelineStore()
  
  // Calculate clip-relative time
  const clipTime = playheadPosition - (clip?.startTime || 0)
  
  // Check if keyframe exists at current time
  const keyframes = clip?.keyframes?.[property] || []
  const keyframeAtTime = getKeyframeAtTime(keyframes, clipTime, 0.05)
  const hasKeyframesForProperty = keyframes.length > 0
  
  // Handle click - toggle keyframe at current position
  const handleClick = (e) => {
    e.stopPropagation()
    toggleKeyframe(clipId, property)
  }
  
  // Handle navigation to prev/next keyframe
  const handlePrev = (e) => {
    e.stopPropagation()
    goToPrevKeyframe(clipId, property)
  }
  
  const handleNext = (e) => {
    e.stopPropagation()
    goToNextKeyframe(clipId, property)
  }
  
  return (
    <div className="flex items-center gap-0.5 ml-1">
      {/* Previous keyframe button */}
      {hasKeyframesForProperty && (
        <button
          onClick={handlePrev}
          className="p-0.5 hover:bg-sf-dark-600 rounded transition-colors opacity-60 hover:opacity-100"
          title="Go to previous keyframe"
        >
          <ChevronFirst className="w-3 h-3 text-sf-text-muted" />
        </button>
      )}
      
      {/* Keyframe toggle button (diamond) */}
      <button
        onClick={handleClick}
        className={`p-0.5 rounded transition-colors ${
          keyframeAtTime 
            ? 'bg-yellow-400/18 hover:bg-yellow-400/28 shadow-[0_0_10px_rgba(253,224,71,0.18)]' 
            : hasKeyframesForProperty
              ? 'bg-sf-dark-600 hover:bg-sf-dark-500 ring-1 ring-sky-400/40'
              : 'hover:bg-sf-dark-600'
        }`}
        title={keyframeAtTime ? 'Remove keyframe' : 'Add keyframe'}
      >
        <Diamond 
          className={`w-3 h-3 ${
            keyframeAtTime 
              ? 'text-white fill-yellow-300 drop-shadow-[0_0_8px_rgba(253,224,71,0.85)] scale-110' 
              : hasKeyframesForProperty
                ? 'text-sky-300 fill-sky-400/70'
                : 'text-sf-text-muted'
          }`} 
        />
      </button>
      
      {/* Next keyframe button */}
      {hasKeyframesForProperty && (
        <button
          onClick={handleNext}
          className="p-0.5 hover:bg-sf-dark-600 rounded transition-colors opacity-60 hover:opacity-100"
          title="Go to next keyframe"
        >
          <ChevronLast className="w-3 h-3 text-sf-text-muted" />
        </button>
      )}
    </div>
  )
}

function InspectorPanel({ isExpanded, onToggleExpanded }) {
  const [expandedSections, setExpandedSections] = useState(() => {
    try {
      const raw = localStorage.getItem(INSPECTOR_EXPANDED_SECTIONS_KEY)
      const parsed = raw ? JSON.parse(raw) : null
      if (Array.isArray(parsed)) {
        const normalized = parsed.filter((section) => typeof section === 'string')
        if (normalized.length > 0) {
          return normalized
        }
      }
    } catch (_) {}
    return DEFAULT_INSPECTOR_EXPANDED_SECTIONS
  })
  const [expandedAdjustmentGroups, setExpandedAdjustmentGroups] = useState(() => {
    try {
      const raw = localStorage.getItem(INSPECTOR_EXPANDED_ADJUSTMENT_GROUPS_KEY)
      const parsed = raw ? JSON.parse(raw) : null
      if (Array.isArray(parsed)) {
        const normalized = parsed.filter((section) => typeof section === 'string')
        if (normalized.length > 0) {
          return normalized
        }
      }
    } catch (_) {}
    return DEFAULT_EXPANDED_ADJUSTMENT_GROUPS
  })
  const [showMaskPicker, setShowMaskPicker] = useState(false)
  const [renderProgress, setRenderProgress] = useState(null) // { status, progress, error }
  const [isRendering, setIsRendering] = useState(false)
  const [textAnimationMode, setTextAnimationMode] = useState('inOut')
  const [letterboxAspectPreset, setLetterboxAspectPreset] = useState(String(DEFAULT_LETTERBOX_ASPECT))
  const [letterboxCustomAspect, setLetterboxCustomAspect] = useState(String(DEFAULT_LETTERBOX_ASPECT))
  const [letterboxBarColor, setLetterboxBarColor] = useState('#000000')
  const [isUpdatingLetterbox, setIsUpdatingLetterbox] = useState(false)
  const [letterboxUpdateError, setLetterboxUpdateError] = useState(null)
  const [inspectorSettingsClipboard, setInspectorSettingsClipboard] = useState(null)
  // Flame-style "commit render" (flatten adjustment clip onto the stack).
  // Progress shape matches the exporter's onProgress payload.
  const [commitRenderState, setCommitRenderState] = useState({
    busy: false,
    progress: 0,
    status: '',
    error: null,
    lastSuccessAt: 0,
  })
  const textContentInputRef = useRef(null)
  
  // Get selected clip from timeline store
  const { 
    selectedClipIds, 
    selectedTransitionId,
    clips, 
    tracks,
    transitions,
    playheadPosition,
    updateClipTransform, 
    updateClipCompositeMode,
    updateClipAdjustments,
    resetClipTransform,
    updateTextProperties,
    updateShapeProperties,
    applyTextAnimationPreset,
    clearTextAnimationPreset,
    removeClip,
    resizeClip,
    updateClipSpeed,
    updateClipReverse,
    updateAudioClipProperties,
    toggleKeyframe,
    setKeyframe,
    removeKeyframe,
    goToNextKeyframe,
    goToPrevKeyframe,
    saveToHistory,
    // Effects
    addEffect,
    removeEffect,
    updateEffect,
    toggleEffect,
    reorderEffect,
    addMaskEffect,
    getClipEffects,
    updateTransition,
    setTransitionAlignment,
    removeTransition,
    getMaxTransitionDurationForAlignment,
    getMaxEdgeTransitionDuration,
    lockSyncClips,
    unlockSyncLockedClips,
    // Cache
    setCacheStatus,
    setCacheUrl,
    clearClipCache,
    maskPickerRequest,
    clearMaskPickerRequest,
    textEditRequest,
    clearTextEditRequest,
  } = useTimelineStore()
  
  // Get assets store functions (needed for render cache)
  const { assets, getAssetById, getAllMasks, updateAsset } = useAssetsStore()
  const timelineSettings = useProjectStore(state => state.getCurrentTimelineSettings?.())
  const { currentProjectHandle, getCurrentTimelineSettings } = useProjectStore()
  const currentTimelineSettings = getCurrentTimelineSettings?.() || null
  const timecodeFps = Math.max(1, Math.round(Number(currentTimelineSettings?.fps) || FRAME_RATE))
  
  const selectedTransition = selectedTransitionId
    ? transitions.find(t => t.id === selectedTransitionId) || null
    : null
  const orderedSelectedClips = useMemo(
    () => selectedClipIds
      .map((clipId) => clips.find((clip) => clip.id === clipId))
      .filter(Boolean),
    [clips, selectedClipIds]
  )
  const linkedInspectorPair = useMemo(() => {
    if (orderedSelectedClips.length !== 2) return null

    const [firstClip, secondClip] = orderedSelectedClips
    const linkGroupId = normalizeLinkGroupId(firstClip?.linkGroupId)
    if (!linkGroupId || linkGroupId !== normalizeLinkGroupId(secondClip?.linkGroupId)) {
      return null
    }

    const firstTrack = tracks.find((track) => track.id === firstClip.trackId)
    const secondTrack = tracks.find((track) => track.id === secondClip.trackId)
    if (!firstTrack || !secondTrack) return null

    const audioClip = firstTrack.type === 'audio'
      ? firstClip
      : (secondTrack.type === 'audio' ? secondClip : null)
    const visualClip = firstTrack.type === 'video'
      ? firstClip
      : (secondTrack.type === 'video' ? secondClip : null)

    if (!audioClip || !visualClip) return null

    return {
      linkGroupId,
      audioClip,
      visualClip,
    }
  }, [orderedSelectedClips, tracks])
  const selectionSignature = useMemo(
    () => orderedSelectedClips.map((clip) => clip.id).join('|'),
    [orderedSelectedClips]
  )
  const isSyncCapableClip = useCallback((clip) => {
    const asset = clip?.assetId ? getAssetById(clip.assetId) : null
    return isMusicVideoSyncCapableClip(clip, asset)
  }, [getAssetById])
  const selectedSyncEligibleClips = useMemo(
    () => orderedSelectedClips.filter((clip) => isSyncCapableClip(clip)),
    [orderedSelectedClips, isSyncCapableClip]
  )
  const selectedSyncLockByClipId = useMemo(() => (
    selectedSyncEligibleClips.reduce((acc, clip) => {
      const asset = clip.assetId ? getAssetById(clip.assetId) : null
      const syncLock = buildClipSyncLock({ clip, asset, fps: timecodeFps })
      if (syncLock) {
        acc[clip.id] = syncLock
      }
      return acc
    }, {})
  ), [buildClipSyncLock, getAssetById, selectedSyncEligibleClips, timecodeFps])
  const selectedSyncAllLocked = useMemo(
    () => selectedSyncEligibleClips.length > 0 && selectedSyncEligibleClips.every((clip) => isSyncLockedClip(clip)),
    [selectedSyncEligibleClips]
  )
  const [inspectorClipId, setInspectorClipId] = useState(null)
  useEffect(() => {
    setInspectorClipId(orderedSelectedClips[0]?.id || null)
  }, [selectionSignature])
  const selectedClip = useMemo(() => {
    if (orderedSelectedClips.length === 0) return null
    if (inspectorClipId) {
      const focusedClip = orderedSelectedClips.find((clip) => clip.id === inspectorClipId)
      if (focusedClip) return focusedClip
    }
    return orderedSelectedClips[0] || null
  }, [orderedSelectedClips, inspectorClipId])
  const transformHistorySessionClipRef = useRef(null)
  const adjustmentHistorySessionClipRef = useRef(null)

  useEffect(() => {
    if (!selectedClip || selectedClip.type !== 'text') return
    const mode = selectedClip?.titleAnimation?.mode
    if (mode === 'in' || mode === 'out' || mode === 'inOut') {
      setTextAnimationMode(mode)
    }
  }, [selectedClip?.id, selectedClip?.type, selectedClip?.titleAnimation?.mode])

  // If a mask picker request comes in for this clip, open inspector + effects
  useEffect(() => {
    if (!maskPickerRequest || !selectedClip) return
    if (maskPickerRequest.clipId !== selectedClip.id) return
    
    if (!isExpanded) {
      onToggleExpanded()
    }
    setExpandedSections(prev =>
      prev.includes('effects') ? prev : [...prev, 'effects']
    )
    if (maskPickerRequest.openPicker) {
      setShowMaskPicker(true)
    } else {
      setShowMaskPicker(false)
    }
    clearMaskPickerRequest()
  }, [maskPickerRequest, selectedClip?.id, isExpanded, onToggleExpanded, clearMaskPickerRequest])

  useEffect(() => {
    if (!textEditRequest) return

    if (!selectedClipIds.includes(textEditRequest.clipId)) {
      clearTextEditRequest()
      return
    }

    if (!selectedClip || selectedClip.id !== textEditRequest.clipId || selectedClip.type !== 'text') {
      return
    }

    if (!isExpanded) {
      onToggleExpanded()
    }
    setExpandedSections((prev) => (
      prev.includes('text') ? prev : [...prev, 'text']
    ))

    let frameId = 0
    let attempts = 0
    let isCancelled = false

    const focusTextContent = () => {
      if (isCancelled) return

      const textarea = textContentInputRef.current
      if (textarea) {
        textarea.focus()
        if (textEditRequest.selectAll !== false) {
          textarea.select()
        } else {
          const length = textarea.value.length
          textarea.setSelectionRange(length, length)
        }
        clearTextEditRequest()
        return
      }

      attempts += 1
      if (attempts < 8) {
        frameId = window.requestAnimationFrame(focusTextContent)
      } else {
        clearTextEditRequest()
      }
    }

    frameId = window.requestAnimationFrame(focusTextContent)
    return () => {
      isCancelled = true
      if (frameId) {
        window.cancelAnimationFrame(frameId)
      }
    }
  }, [
    textEditRequest,
    selectedClipIds,
    selectedClip,
    isExpanded,
    onToggleExpanded,
    clearTextEditRequest,
  ])
  
  // Get track info for the selected clip
  const selectedTrack = selectedClip 
    ? tracks.find(t => t.id === selectedClip.trackId) 
    : null
  const selectedAsset = selectedClip?.assetId ? getAssetById(selectedClip.assetId) : null
  
  // Check if it's a video, text, or audio clip
  const isTextClip = selectedClip?.type === 'text'
  const isShapeClip = selectedClip?.type === 'shape'
  const isAdjustmentClip = selectedClip?.type === 'adjustment'
  const isVideoClip = selectedTrack?.type === 'video' && !isTextClip && !isAdjustmentClip
  const isAudioClip = selectedTrack?.type === 'audio'
  
  // Get transform with defaults for legacy clips
  const getTransform = useCallback(() => {
    if (!selectedClip) return null
    return selectedClip.transform || {
      positionX: 0, positionY: 0, positionZ: 0,
      scaleX: 100, scaleY: 100, scaleLinked: true,
      rotation: 0, rotationX: 0, rotationY: 0, perspective: 1200, anchorX: 50, anchorY: 50, opacity: 100,
      flipH: false, flipV: false,
      cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0,
      motionBlurEnabled: false, motionBlurMode: 'auto', motionBlurPosition: 'center', motionBlurSamples: 8, motionBlurShutter: 180, motionBlurSharpness: 0,
      blendMode: 'normal',
      blur: 0,
    }
  }, [selectedClip])

  // Blend mode options (CSS mix-blend-mode values)
  const BLEND_MODES = [
    { value: 'normal', label: 'Normal' },
    { value: 'multiply', label: 'Multiply' },
    { value: 'screen', label: 'Screen' },
    { value: 'overlay', label: 'Overlay' },
    { value: 'darken', label: 'Darken' },
    { value: 'lighten', label: 'Lighten' },
    { value: 'color-dodge', label: 'Color Dodge' },
    { value: 'color-burn', label: 'Color Burn' },
    { value: 'hard-light', label: 'Hard Light' },
    { value: 'soft-light', label: 'Soft Light' },
    { value: 'difference', label: 'Difference' },
    { value: 'exclusion', label: 'Exclusion' },
    { value: 'hue', label: 'Hue' },
    { value: 'saturation', label: 'Saturation' },
    { value: 'color', label: 'Color' },
    { value: 'luminosity', label: 'Luminosity' },
  ]

  const MOTION_BLUR_MODE_OPTIONS = [
    { value: 'auto', label: 'Auto', description: 'Use GPU velocity blur for X/Y movement and sampled blur as a fallback.' },
    { value: 'velocity', label: 'Velocity / GPU', description: 'Use directional GPU blur for X/Y movement only.' },
    { value: 'sampled', label: 'Subframe / Sampled', description: 'Use repeated subframe samples. Better for some non-position animation, but slower.' },
  ]
  
  const transform = getTransform()
  
  // Calculate clip-relative time for keyframes
  const clipTime = selectedClip ? playheadPosition - selectedClip.startTime : 0
  
  // Get animated transform values (with keyframes applied)
  const animatedTransform = useMemo(() => {
    if (!selectedClip) return transform
    return getAnimatedTransform(selectedClip, clipTime) || transform
  }, [selectedClip, clipTime, transform])

  const compositeMode = normalizeClipCompositeMode(selectedClip?.compositeLowerLayers)
  const compositeStatus = useMemo(() => (
    getClipLowerLayerCompositeStatus(selectedClip, {
      time: playheadPosition,
      getAssetById,
      timelineWidth: timelineSettings?.width || 1920,
      timelineHeight: timelineSettings?.height || 1080,
    })
  ), [
    getAssetById,
    playheadPosition,
    selectedClip,
    timelineSettings?.height,
    timelineSettings?.width,
  ])

  const animatedAdjustments = useMemo(() => {
    if (!selectedClip || selectedClip.type !== 'adjustment') {
      return normalizeAdjustmentSettings(selectedClip?.adjustments || {})
    }
    return normalizeAdjustmentSettings(
      getAnimatedAdjustmentSettings(selectedClip, clipTime) || selectedClip.adjustments || {}
    )
  }, [selectedClip, clipTime])

  const getTextProps = useCallback(() => {
    if (!selectedClip || selectedClip.type !== 'text') return null
    return selectedClip.textProperties || {
      text: 'Sample Text',
      fontFamily: 'Inter',
      fontSize: 64,
      fontWeight: 'bold',
      fontStyle: 'normal',
      textColor: '#FFFFFF',
      backgroundColor: '#000000',
      backgroundOpacity: 0,
      backgroundPadding: 20,
      textAlign: 'center',
      verticalAlign: 'center',
      strokeColor: '#000000',
      strokeWidth: 0,
      letterSpacing: 0,
      lineHeight: 1.2,
      shadow: false,
      shadowColor: 'rgba(0,0,0,0.5)',
      shadowBlur: 4,
      shadowOffsetX: 2,
      shadowOffsetY: 2,
    }
  }, [selectedClip])

  const getShapeProps = useCallback(() => {
    if (!selectedClip || selectedClip.type !== 'shape') return null
    return getAnimatedShapeProperties(selectedClip, clipTime) || normalizeShapeProperties(selectedClip.shapeProperties || {})
  }, [clipTime, selectedClip])
  
  // Check if a property has keyframes
  const propertyHasKeyframes = useCallback((property) => {
    return selectedClip?.keyframes?.[property]?.length > 0
  }, [selectedClip])

  useEffect(() => {
    transformHistorySessionClipRef.current = null
    adjustmentHistorySessionClipRef.current = null
  }, [selectedClip?.id])

  const hasTransformChanges = useCallback((updates) => {
    if (!transform || !updates || typeof updates !== 'object') return false
    return Object.entries(updates).some(([property, nextValue]) => transform[property] !== nextValue)
  }, [transform])

  const baseAdjustments = useMemo(
    () => normalizeAdjustmentSettings(selectedClip?.adjustments || {}),
    [selectedClip?.adjustments]
  )

  const buildGlobalTimingSettings = useCallback((clip) => {
    if (!clip || clip.type !== 'video') return null
    return {
      speed: Number.isFinite(Number(clip.speed)) ? Number(clip.speed) : 1,
      reverse: !!clip.reverse,
    }
  }, [])

  const buildScopedTimingSettings = useCallback((clip) => {
    if (!clip || clip.type === 'audio') return null
    const next = {}
    if (Number.isFinite(Number(clip.duration))) {
      next.duration = Number(clip.duration)
    }
    if (clip.type === 'video') {
      next.speed = Number.isFinite(Number(clip.speed)) ? Number(clip.speed) : 1
      next.reverse = !!clip.reverse
    }
    return Object.keys(next).length > 0 ? next : null
  }, [])

  const getCompatibleTimingSettings = useCallback((scope, clip, timingPayload) => {
    if (!clip || !timingPayload || typeof timingPayload !== 'object') return null
    const next = {}

    if (scope === INSPECTOR_SETTINGS_SCOPE.TIMING && clip.type !== 'audio' && Number.isFinite(Number(timingPayload.duration))) {
      next.duration = Number(timingPayload.duration)
    }
    if (clip.type === 'video') {
      if (Number.isFinite(Number(timingPayload.speed))) {
        next.speed = Number(timingPayload.speed)
      }
      if (hasOwn(timingPayload, 'reverse')) {
        next.reverse = !!timingPayload.reverse
      }
    }

    return Object.keys(next).length > 0 ? next : null
  }, [])

  const buildInspectorClipboardPayload = useCallback((scope = INSPECTOR_SETTINGS_SCOPE.ALL) => {
    if (!selectedClip) return null

    const supportsVisualSettings = selectedTrack?.type === 'video'
    const clipSourceLabel = getInspectorSettingsSourceLabel(selectedClip, selectedTrack)
    const fullTransform = supportsVisualSettings && transform ? { ...transform } : null
    const transformSettings = pickInspectorSettings(fullTransform, TRANSFORM_SETTINGS_KEYS)
    const cropSettings = pickInspectorSettings(fullTransform, CROP_SETTINGS_KEYS)
    const globalTimingSettings = buildGlobalTimingSettings(selectedClip)
    const scopedTimingSettings = buildScopedTimingSettings(selectedClip)
    const nextClipboard = {
      version: 2,
      scope,
      scopeLabel: INSPECTOR_SETTINGS_SCOPE_LABELS[scope] || 'settings',
      sourceClipId: selectedClip.id,
      sourceClipType: selectedClip.type,
      sourceLabel: clipSourceLabel,
      transform: null,
      crop: null,
      adjustments: null,
      timing: null,
      textStyle: null,
      titleAnimation: undefined,
      audio: null,
    }

    switch (scope) {
      case INSPECTOR_SETTINGS_SCOPE.TRANSFORM:
        nextClipboard.transform = transformSettings
        break
      case INSPECTOR_SETTINGS_SCOPE.CROP:
        nextClipboard.crop = cropSettings
        break
      case INSPECTOR_SETTINGS_SCOPE.ADJUSTMENTS:
        if (supportsVisualSettings) {
          const { blur, ...colorSettings } = normalizeAdjustmentSettings(selectedClip.adjustments || {})
          nextClipboard.adjustments = colorSettings
        }
        break
      case INSPECTOR_SETTINGS_SCOPE.TIMING:
        nextClipboard.timing = scopedTimingSettings
        break
      case INSPECTOR_SETTINGS_SCOPE.ALL:
      default:
        nextClipboard.transform = fullTransform
        nextClipboard.adjustments = supportsVisualSettings
          ? normalizeAdjustmentSettings(selectedClip.adjustments || {})
          : null
        nextClipboard.timing = globalTimingSettings
        nextClipboard.textStyle = selectedClip.type === 'text'
          ? getCopyableTextStyleProperties(getTextProps() || {})
          : null
        nextClipboard.titleAnimation = selectedClip.type === 'text'
          ? (selectedClip.titleAnimation?.presetId
              ? {
                  presetId: selectedClip.titleAnimation.presetId,
                  mode: selectedClip.titleAnimation.mode || 'inOut',
                }
              : null)
          : undefined
        nextClipboard.audio = selectedClip.type === 'audio'
          ? {
              gainDb: normalizeAudioClipGainDb(selectedClip.gainDb),
              fadeIn: Number.isFinite(Number(selectedClip.fadeIn)) ? Number(selectedClip.fadeIn) : 0,
              fadeOut: Number.isFinite(Number(selectedClip.fadeOut)) ? Number(selectedClip.fadeOut) : 0,
            }
          : null
        break
    }

    return nextClipboard
  }, [buildGlobalTimingSettings, buildScopedTimingSettings, getTextProps, selectedClip, selectedTrack, transform])

  const canCopyInspectorSettings = useMemo(
    () => Boolean(selectedClip) && !selectedTransition,
    [selectedClip, selectedTransition]
  )

  const canPasteInspectorSettings = useCallback((scope = INSPECTOR_SETTINGS_SCOPE.ALL) => {
    if (!selectedClip || selectedTransition || !inspectorSettingsClipboard) return false
    if (inspectorSettingsClipboard.scope !== scope) return false

    const supportsVisualSettings = selectedTrack?.type === 'video'
    const supportsTextSettings = selectedClip.type === 'text'
    const supportsAudioSettings = selectedClip.type === 'audio'

    switch (scope) {
      case INSPECTOR_SETTINGS_SCOPE.TRANSFORM:
        return Boolean(supportsVisualSettings && inspectorSettingsClipboard.transform)
      case INSPECTOR_SETTINGS_SCOPE.CROP:
        return Boolean(supportsVisualSettings && inspectorSettingsClipboard.crop)
      case INSPECTOR_SETTINGS_SCOPE.ADJUSTMENTS:
        return Boolean(supportsVisualSettings && inspectorSettingsClipboard.adjustments)
      case INSPECTOR_SETTINGS_SCOPE.TIMING:
        return Boolean(getCompatibleTimingSettings(scope, selectedClip, inspectorSettingsClipboard.timing))
      case INSPECTOR_SETTINGS_SCOPE.ALL:
      default:
        return Boolean(
          (supportsVisualSettings && (inspectorSettingsClipboard.transform || inspectorSettingsClipboard.adjustments))
          || getCompatibleTimingSettings(scope, selectedClip, inspectorSettingsClipboard.timing)
          || (supportsTextSettings && (
            inspectorSettingsClipboard.textStyle
            || inspectorSettingsClipboard.titleAnimation !== undefined
          ))
          || (supportsAudioSettings && inspectorSettingsClipboard.audio)
        )
    }
  }, [getCompatibleTimingSettings, inspectorSettingsClipboard, selectedClip, selectedTrack?.type, selectedTransition])

  const hasAdjustmentChanges = useCallback((updates) => {
    if (!updates || typeof updates !== 'object') return false
    const nextAdjustments = mergeAdjustmentSettings(baseAdjustments, updates)
    return JSON.stringify(nextAdjustments) !== JSON.stringify(baseAdjustments)
  }, [baseAdjustments])

  const applyTransformUpdatesWithHistory = useCallback((updates, keepSessionOpen = false) => {
    if (!selectedClip || !updates || typeof updates !== 'object') return false

    const hasPendingSession = transformHistorySessionClipRef.current === selectedClip.id
    const changed = hasTransformChanges(updates)
    if (!hasPendingSession && !changed) return false

    if (!hasPendingSession) {
      saveToHistory()
    }
    if (changed) {
      updateClipTransform(selectedClip.id, updates, false)
    }

    transformHistorySessionClipRef.current = keepSessionOpen ? selectedClip.id : null
    return true
  }, [selectedClip, hasTransformChanges, saveToHistory, updateClipTransform])

  const applyAdjustmentUpdatesWithHistory = useCallback((updates, keepSessionOpen = false) => {
    if (!selectedClip || !updates || typeof updates !== 'object') return false

    const hasPendingSession = adjustmentHistorySessionClipRef.current === selectedClip.id
    const changed = hasAdjustmentChanges(updates)
    if (!hasPendingSession && !changed) return false

    if (!hasPendingSession) {
      saveToHistory()
    }
    if (changed) {
      updateClipAdjustments(selectedClip.id, updates, false)
    }

    adjustmentHistorySessionClipRef.current = keepSessionOpen ? selectedClip.id : null
    return true
  }, [selectedClip, hasAdjustmentChanges, saveToHistory, updateClipAdjustments])
  
  // Update transform handler (doesn't save to history for realtime sliders)
  // Also adds/updates keyframe if property is keyframed
  const handleTransformChange = useCallback((key, value) => {
    if (!selectedClip) return
    const applied = applyTransformUpdatesWithHistory({ [key]: value }, true)
    if (!applied) return
    
    // If this property has keyframes, also update the keyframe at current time
    if (propertyHasKeyframes(key)) {
      setKeyframe(selectedClip.id, key, clipTime, value, 'easeInOut', { saveHistory: false })
    }
    
    // Handle linked scale: if scaleX or scaleY changes and scale is linked, also update the other
    const isScaleProperty = key === 'scaleX' || key === 'scaleY'
    const isLinked = transform?.scaleLinked && isScaleProperty
    if (isLinked) {
      const otherKey = key === 'scaleX' ? 'scaleY' : 'scaleX'
      if (propertyHasKeyframes(otherKey)) {
        setKeyframe(selectedClip.id, otherKey, clipTime, value, 'easeInOut', { saveHistory: false })
      }
    }
  }, [selectedClip, applyTransformUpdatesWithHistory, propertyHasKeyframes, setKeyframe, clipTime, transform])
  
  // Save to history when user finishes editing (on blur or mouse up)
  const handleTransformCommit = useCallback((key, value) => {
    if (!selectedClip) return
    applyTransformUpdatesWithHistory({ [key]: value }, false)
  }, [selectedClip, applyTransformUpdatesWithHistory])

  // Reset individual slider to default on double-click
  const handleSliderReset = useCallback((property, defaultValue) => {
    if (!selectedClip) return
    const isScale = property === 'scaleX' || property === 'scaleY'
    const isLinked = transform?.scaleLinked && isScale
    const updates = isScale && isLinked
      ? { scaleX: 100, scaleY: 100 }
      : { [property]: defaultValue }
    const applied = applyTransformUpdatesWithHistory(updates, false)
    if (!applied) return
    for (const key of Object.keys(updates)) {
      if (propertyHasKeyframes(key)) {
        setKeyframe(selectedClip.id, key, clipTime, updates[key], 'easeInOut', { saveHistory: false })
      }
    }
  }, [selectedClip, transform?.scaleLinked, applyTransformUpdatesWithHistory, propertyHasKeyframes, setKeyframe, clipTime])
  
  // Reset all transform
  const handleResetTransform = useCallback(() => {
    if (!selectedClip) return
    resetClipTransform(selectedClip.id)
  }, [selectedClip, resetClipTransform])

  const handleCompositeModeCommit = useCallback((mode) => {
    if (!selectedClip) return
    updateClipCompositeMode(selectedClip.id, mode, true)
  }, [selectedClip, updateClipCompositeMode])

  // Shared clip adjustment handlers (video/image/text/adjustment)
  const buildAdjustmentUpdatePayload = useCallback((propertyPath, value) => {
    return setAdjustmentValue(baseAdjustments, propertyPath, value)
  }, [baseAdjustments])

  const handleClipAdjustmentChange = useCallback((key, value) => {
    if (!selectedClip) return
    const applied = applyAdjustmentUpdatesWithHistory(buildAdjustmentUpdatePayload(key, value), true)
    if (!applied) return
    if (propertyHasKeyframes(key)) {
      setKeyframe(selectedClip.id, key, clipTime, value, 'easeInOut', { saveHistory: false })
    }
  }, [selectedClip, applyAdjustmentUpdatesWithHistory, buildAdjustmentUpdatePayload, propertyHasKeyframes, setKeyframe, clipTime])

  const handleClipAdjustmentCommit = useCallback((key, value) => {
    if (!selectedClip) return
    applyAdjustmentUpdatesWithHistory(buildAdjustmentUpdatePayload(key, value), false)
  }, [selectedClip, applyAdjustmentUpdatesWithHistory, buildAdjustmentUpdatePayload])

  const handleClipAdjustmentGroupReset = useCallback((groupKey = 'all') => {
    if (!selectedClip) return false

    const updates = groupKey === 'all'
      ? DEFAULT_ADJUSTMENT_SETTINGS
      : groupKey === 'global'
        ? GLOBAL_COLOR_CONTROLS.reduce((acc, { key }) => {
            acc[key] = DEFAULT_ADJUSTMENT_SETTINGS[key]
            return acc
          }, {})
        : { [groupKey]: DEFAULT_ADJUSTMENT_SETTINGS[groupKey] }
    const applied = applyAdjustmentUpdatesWithHistory(updates, false)
    if (!applied) return false

    const propertyPaths = groupKey === 'all'
      ? [
        ...GLOBAL_COLOR_CONTROLS.map(({ key }) => key),
        ADJUSTMENT_BLUR_CONTROL.key,
        ...TONAL_ADJUSTMENT_GROUP_KEYS.flatMap((tonalGroupKey) => (
          COLOR_ADJUSTMENT_KEYS.map((key) => `${tonalGroupKey}.${key}`)
        )),
      ]
      : groupKey === 'global'
        ? GLOBAL_COLOR_CONTROLS.map(({ key }) => key)
        : COLOR_ADJUSTMENT_KEYS.map((key) => `${groupKey}.${key}`)

    for (const propertyPath of propertyPaths) {
      if (propertyHasKeyframes(propertyPath)) {
        const resetValue = groupKey === 'all'
          ? getAdjustmentValue(updates, propertyPath) ?? 0
          : groupKey === 'global'
            ? updates[propertyPath] ?? 0
            : getAdjustmentValue(updates, propertyPath) ?? 0
        setKeyframe(selectedClip.id, propertyPath, clipTime, resetValue, 'easeInOut', { saveHistory: false })
      }
    }

    return true
  }, [applyAdjustmentUpdatesWithHistory, clipTime, propertyHasKeyframes, selectedClip, setKeyframe])

  const handleClipAdjustmentsReset = useCallback(() => {
    handleClipAdjustmentGroupReset('all')
  }, [handleClipAdjustmentGroupReset])

  const handleResetCrop = useCallback(() => {
    if (!selectedClip) return false
    const applied = applyTransformUpdatesWithHistory(RESET_CROP_SETTINGS, false)
    if (!applied) return false

    for (const [property, value] of Object.entries(RESET_CROP_SETTINGS)) {
      if (propertyHasKeyframes(property)) {
        setKeyframe(selectedClip.id, property, clipTime, value, 'easeInOut', { saveHistory: false })
      }
    }
    return true
  }, [applyTransformUpdatesWithHistory, clipTime, propertyHasKeyframes, selectedClip, setKeyframe])

  const canResetTiming = useMemo(
    () => selectedClip?.type === 'video' || selectedClip?.type === 'audio',
    [selectedClip?.type]
  )

  const hasTimingResetChanges = useMemo(() => {
    if (!selectedClip || !canResetTiming) return false
    const currentSpeed = Number.isFinite(Number(selectedClip.speed)) ? Number(selectedClip.speed) : 1
    const currentReverse = !!selectedClip.reverse
    return currentSpeed !== 1 || (selectedClip.type === 'video' && currentReverse)
  }, [canResetTiming, selectedClip])

  const handleResetTiming = useCallback(() => {
    if (!selectedClip || !canResetTiming || !hasTimingResetChanges) return false

    const currentSpeed = Number.isFinite(Number(selectedClip.speed)) ? Number(selectedClip.speed) : 1
    const currentReverse = !!selectedClip.reverse
    const shouldResetSpeed = currentSpeed !== 1
    const shouldResetReverse = selectedClip.type === 'video' && currentReverse

    if (!shouldResetSpeed && !shouldResetReverse) {
      return false
    }

    saveToHistory()
    if (shouldResetSpeed) {
      updateClipSpeed(selectedClip.id, 1, false)
    }
    if (shouldResetReverse) {
      updateClipReverse(selectedClip.id, false, false)
    }
    return true
  }, [canResetTiming, hasTimingResetChanges, saveToHistory, selectedClip, updateClipReverse, updateClipSpeed])

  const renderAdjustmentSlider = (control, values, groupKey = null) => {
    const propertyPath = groupKey ? `${groupKey}.${control.key}` : control.key
    const defaultValue = getAdjustmentValue(DEFAULT_ADJUSTMENT_SETTINGS, propertyPath) ?? 0
    const currentValue = getAdjustmentValue(values, propertyPath) ?? defaultValue

    return (
      <div key={propertyPath}>
        <div className="flex justify-between items-center mb-1">
          <label className="text-[10px] text-sf-text-muted">{control.label}</label>
          <div className="flex items-center gap-1">
            <KeyframeButton
              clipId={selectedClip?.id}
              property={propertyPath}
              clip={selectedClip}
              playheadPosition={playheadPosition}
            />
            <span className="text-[10px] text-sf-text-secondary">{control.formatValue(currentValue)}</span>
          </div>
        </div>
        <input
          type="range"
          min={control.min}
          max={control.max}
          step={control.step}
          value={currentValue}
          onChange={(e) => handleClipAdjustmentChange(propertyPath, Number(e.target.value))}
          onMouseUp={(e) => handleClipAdjustmentCommit(propertyPath, Number(e.target.value))}
          onDoubleClick={() => handleClipAdjustmentCommit(propertyPath, defaultValue)}
          title={control.resetTitle}
          className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
        />
      </div>
    )
  }

  const renderAdjustmentGroup = ({
    title,
    values,
    groupKey = null,
    description = null,
  }) => {
    const controls = groupKey ? ADJUSTMENT_CONTROL_DEFINITIONS : GLOBAL_COLOR_CONTROLS
    const groupId = groupKey || 'global'
    const isCollapsible = true
    const isExpanded = expandedAdjustmentGroups.includes(groupId)
    const wrapperClassName = groupKey
      ? 'rounded-md border border-sf-dark-700 bg-sf-dark-800/50'
      : 'rounded-md border border-sf-dark-700 bg-sf-dark-900/40'
    const resetLabel = groupKey ? `Reset ${title}` : 'Reset Global'
    const resetTitle = groupKey ? `Reset ${title.toLowerCase()} controls` : 'Reset global controls'
    const headerContent = (
      <div className="min-w-0">
        <div className="text-[11px] font-medium text-sf-text-primary">{title}</div>
        {description && (
          <div className="text-[10px] text-sf-text-muted">{description}</div>
        )}
      </div>
    )

    return (
      <div key={groupKey || 'global'} className={wrapperClassName}>
        <div className="flex items-start justify-between gap-2 p-3">
          {isCollapsible ? (
            <button
              type="button"
              onClick={() => toggleAdjustmentGroup(groupId)}
              className="flex min-w-0 flex-1 items-start gap-2 text-left"
              aria-expanded={isExpanded}
              title={`${isExpanded ? 'Collapse' : 'Expand'} ${title.toLowerCase()} controls`}
            >
              {isExpanded ? (
                <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sf-text-muted" />
              ) : (
                <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sf-text-muted" />
              )}
              {headerContent}
            </button>
          ) : (
            <div className="min-w-0 flex-1">
              {headerContent}
            </div>
          )}
          {renderHeaderActionButton({
            icon: RotateCcw,
            label: resetLabel,
            onClick: () => handleClipAdjustmentGroupReset(groupKey || 'global'),
            title: resetTitle,
          })}
        </div>
        {isExpanded && (
          <div className="space-y-3 px-3 pb-3">
            {controls.map((control) => renderAdjustmentSlider(control, values, groupKey))}
          </div>
        )}
      </div>
    )
  }

  const renderSharedAdjustmentsContent = (values, description) => (
    <div className="p-3 space-y-3 border-b border-sf-dark-700">
      <p className="text-[10px] text-sf-text-muted">
        {description}
      </p>
      {renderAdjustmentGroup({
        title: 'Global',
        values,
      })}
      {TONAL_ADJUSTMENT_GROUP_KEYS.map((groupKey) => renderAdjustmentGroup({
        title: TONAL_ADJUSTMENT_GROUP_LABELS[groupKey],
        values,
        groupKey,
      }))}
    </div>
  )

  const renderAdjustmentBlurControl = (description = null) => {
    const currentValue = animatedAdjustments?.blur ?? baseAdjustments?.blur ?? 0

    return (
      <div className="rounded-md border border-sf-dark-700 bg-sf-dark-800/50 p-3 space-y-3">
        {description && (
          <p className="text-[10px] text-sf-text-muted">
            {description}
          </p>
        )}
        <div>
          <div className="flex justify-between items-center mb-1">
            <label className="text-[10px] text-sf-text-muted">{ADJUSTMENT_BLUR_CONTROL.label}</label>
            <div className="flex items-center gap-1">
              <KeyframeButton
                clipId={selectedClip?.id}
                property={ADJUSTMENT_BLUR_CONTROL.key}
                clip={selectedClip}
                playheadPosition={playheadPosition}
              />
              <span className="text-[10px] text-sf-text-secondary">{ADJUSTMENT_BLUR_CONTROL.formatValue(currentValue)}</span>
            </div>
          </div>
          <input
            type="range"
            min={ADJUSTMENT_BLUR_CONTROL.min}
            max={ADJUSTMENT_BLUR_CONTROL.max}
            step={ADJUSTMENT_BLUR_CONTROL.step}
            value={currentValue}
            onChange={(e) => handleClipAdjustmentChange(ADJUSTMENT_BLUR_CONTROL.key, Number(e.target.value))}
            onMouseUp={(e) => handleClipAdjustmentCommit(ADJUSTMENT_BLUR_CONTROL.key, Number(e.target.value))}
            onDoubleClick={() => handleClipAdjustmentCommit(ADJUSTMENT_BLUR_CONTROL.key, DEFAULT_ADJUSTMENT_SETTINGS.blur)}
            title={ADJUSTMENT_BLUR_CONTROL.resetTitle}
            className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
          />
        </div>
      </div>
    )
  }

  const handleCopyInspectorSettings = useCallback((scope = INSPECTOR_SETTINGS_SCOPE.ALL) => {
    const nextClipboard = buildInspectorClipboardPayload(scope)
    if (!nextClipboard) return false
    setInspectorSettingsClipboard(nextClipboard)
    return true
  }, [buildInspectorClipboardPayload])

  const handlePasteInspectorSettings = useCallback((scope = INSPECTOR_SETTINGS_SCOPE.ALL) => {
    if (!selectedClip || !selectedTrack || !inspectorSettingsClipboard) return false
    if (!canPasteInspectorSettings(scope)) return false

    const supportsVisualSettings = selectedTrack.type === 'video'
    const supportsTextSettings = selectedClip.type === 'text'
    const supportsAudioSettings = selectedClip.type === 'audio'
    const targetTransformSettings = pickInspectorSettings(transform || {}, TRANSFORM_SETTINGS_KEYS) || {}
    const targetCropSettings = pickInspectorSettings(transform || {}, CROP_SETTINGS_KEYS) || {}
    const targetAllTransformSettings = transform || {}
    const targetAllTimingSettings = buildGlobalTimingSettings(selectedClip) || {}
    const targetScopedTimingSettings = buildScopedTimingSettings(selectedClip) || {}
    const targetAudioSettings = {
      gainDb: normalizeAudioClipGainDb(selectedClip.gainDb),
      fadeIn: Number.isFinite(Number(selectedClip.fadeIn)) ? Number(selectedClip.fadeIn) : 0,
      fadeOut: Number.isFinite(Number(selectedClip.fadeOut)) ? Number(selectedClip.fadeOut) : 0,
    }
    const targetTextStyle = supportsTextSettings ? getCopyableTextStyleProperties(getTextProps() || {}) : {}

    const nextAllTransformSettings = supportsVisualSettings && inspectorSettingsClipboard.transform
      ? inspectorSettingsClipboard.transform
      : null
    const nextTransformSettings = supportsVisualSettings
      ? pickInspectorSettings(inspectorSettingsClipboard.transform, TRANSFORM_SETTINGS_KEYS)
      : null
    const nextCropSettings = supportsVisualSettings
      ? pickInspectorSettings(inspectorSettingsClipboard.crop, CROP_SETTINGS_KEYS)
      : null
    const nextAdjustments = supportsVisualSettings && inspectorSettingsClipboard.adjustments
      ? inspectorSettingsClipboard.adjustments
      : null
    const nextTiming = getCompatibleTimingSettings(scope, selectedClip, inspectorSettingsClipboard.timing)
    const nextAudio = supportsAudioSettings && inspectorSettingsClipboard.audio
      ? inspectorSettingsClipboard.audio
      : null
    const nextTextStyle = supportsTextSettings && inspectorSettingsClipboard.textStyle
      ? inspectorSettingsClipboard.textStyle
      : null
    const nextTitleAnimation = supportsTextSettings && scope === INSPECTOR_SETTINGS_SCOPE.ALL && hasOwn(inspectorSettingsClipboard, 'titleAnimation')
      ? inspectorSettingsClipboard.titleAnimation
      : undefined

    const shouldApplyTransform = scope === INSPECTOR_SETTINGS_SCOPE.ALL
      ? objectHasDifferences(targetAllTransformSettings, nextAllTransformSettings)
      : objectHasDifferences(targetTransformSettings, nextTransformSettings)
    const shouldApplyCrop = objectHasDifferences(targetCropSettings, nextCropSettings)
    const shouldApplyAdjustments = objectHasDifferences(baseAdjustments, nextAdjustments)
    const currentTimingSettings = scope === INSPECTOR_SETTINGS_SCOPE.ALL
      ? targetAllTimingSettings
      : targetScopedTimingSettings
    const shouldApplyTimingSpeed = Boolean(nextTiming && hasOwn(nextTiming, 'speed') && currentTimingSettings.speed !== nextTiming.speed)
    const shouldApplyTimingReverse = Boolean(nextTiming && hasOwn(nextTiming, 'reverse') && currentTimingSettings.reverse !== nextTiming.reverse)
    const shouldApplyTimingDuration = Boolean(nextTiming && hasOwn(nextTiming, 'duration') && currentTimingSettings.duration !== nextTiming.duration)
    const shouldApplyTiming = shouldApplyTimingSpeed || shouldApplyTimingReverse || shouldApplyTimingDuration
    const shouldApplyAudio = objectHasDifferences(targetAudioSettings, nextAudio)
    const shouldApplyTextStyle = objectHasDifferences(targetTextStyle, nextTextStyle)
    const shouldApplyTitleAnimation = nextTitleAnimation !== undefined && (
      (selectedClip.titleAnimation?.presetId || null) !== (nextTitleAnimation?.presetId || null)
      || (selectedClip.titleAnimation?.mode || 'inOut') !== (nextTitleAnimation?.mode || 'inOut')
    )

    if (
      !shouldApplyTransform
      && !shouldApplyCrop
      && !shouldApplyAdjustments
      && !shouldApplyTiming
      && !shouldApplyAudio
      && !shouldApplyTextStyle
      && !shouldApplyTitleAnimation
    ) {
      return false
    }

    saveToHistory()

    if (scope === INSPECTOR_SETTINGS_SCOPE.ALL && shouldApplyTransform) {
      updateClipTransform(selectedClip.id, nextAllTransformSettings, false)
    } else if (scope === INSPECTOR_SETTINGS_SCOPE.TRANSFORM && shouldApplyTransform) {
      updateClipTransform(selectedClip.id, nextTransformSettings, false)
    }
    if (scope === INSPECTOR_SETTINGS_SCOPE.CROP && shouldApplyCrop) {
      updateClipTransform(selectedClip.id, nextCropSettings, false)
    }
    if ((scope === INSPECTOR_SETTINGS_SCOPE.ALL || scope === INSPECTOR_SETTINGS_SCOPE.ADJUSTMENTS) && shouldApplyAdjustments) {
      updateClipAdjustments(selectedClip.id, nextAdjustments, false)
    }
    if (shouldApplyTimingSpeed) {
      updateClipSpeed(selectedClip.id, nextTiming.speed, false)
    }
    if (shouldApplyTimingReverse) {
      updateClipReverse(selectedClip.id, nextTiming.reverse, false)
    }
    if (shouldApplyTimingDuration) {
      resizeClip(selectedClip.id, nextTiming.duration)
    }
    if (scope === INSPECTOR_SETTINGS_SCOPE.ALL && shouldApplyAudio) {
      updateAudioClipProperties(selectedClip.id, nextAudio, false)
    }
    if (scope === INSPECTOR_SETTINGS_SCOPE.ALL && shouldApplyTextStyle) {
      updateTextProperties(selectedClip.id, nextTextStyle, false)
    }
    if (scope === INSPECTOR_SETTINGS_SCOPE.ALL && shouldApplyTitleAnimation) {
      if (nextTitleAnimation?.presetId) {
        applyTextAnimationPreset(selectedClip.id, nextTitleAnimation.presetId, nextTitleAnimation.mode || 'inOut', { saveHistory: false })
      } else {
        clearTextAnimationPreset(selectedClip.id, { saveHistory: false })
      }
    }

    return true
  }, [
    applyTextAnimationPreset,
    baseAdjustments,
    buildGlobalTimingSettings,
    buildScopedTimingSettings,
    canPasteInspectorSettings,
    clearTextAnimationPreset,
    getCompatibleTimingSettings,
    getTextProps,
    inspectorSettingsClipboard,
    resizeClip,
    saveToHistory,
    selectedClip,
    selectedTrack,
    transform,
    updateAudioClipProperties,
    updateClipAdjustments,
    updateClipReverse,
    updateClipSpeed,
    updateClipTransform,
    updateTextProperties,
  ])
  
  const [audioData, setAudioData] = useState({
    name: '',
    type: 'audio',
    gainDb: DEFAULT_AUDIO_CLIP_GAIN_DB,
    fadeIn: 0,
    fadeOut: 0,
  })

  useEffect(() => {
    if (!selectedClip || !isAudioClip) return
    setAudioData((prev) => ({
      ...prev,
      name: selectedClip.name || '',
      type: selectedClip.type || 'audio',
      gainDb: normalizeAudioClipGainDb(selectedClip.gainDb),
      fadeIn: Number.isFinite(Number(selectedClip.fadeIn)) ? Number(selectedClip.fadeIn) : 0,
      fadeOut: Number.isFinite(Number(selectedClip.fadeOut)) ? Number(selectedClip.fadeOut) : 0,
    }))
  }, [selectedClip?.id, selectedClip?.name, selectedClip?.type, selectedClip?.gainDb, selectedClip?.fadeIn, selectedClip?.fadeOut, isAudioClip])

  const handleAudioGainChange = useCallback((nextValue) => {
    const value = normalizeAudioClipGainDb(nextValue)
    setAudioData((prev) => ({ ...prev, gainDb: value }))
    if (selectedClip?.type === 'audio') {
      updateAudioClipProperties(selectedClip.id, { gainDb: value }, true)
    }
  }, [selectedClip, updateAudioClipProperties])

  const toggleSection = (section) => {
    setExpandedSections(prev => 
      prev.includes(section) 
        ? prev.filter(s => s !== section)
        : [...prev, section]
    )
  }

  const toggleAdjustmentGroup = useCallback((groupId) => {
    setExpandedAdjustmentGroups((prev) => (
      prev.includes(groupId)
        ? prev.filter((value) => value !== groupId)
        : [...prev, groupId]
    ))
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(INSPECTOR_EXPANDED_SECTIONS_KEY, JSON.stringify(expandedSections))
    } catch (_) {}
  }, [expandedSections])

  useEffect(() => {
    try {
      localStorage.setItem(INSPECTOR_EXPANDED_ADJUSTMENT_GROUPS_KEY, JSON.stringify(expandedAdjustmentGroups))
    } catch (_) {}
  }, [expandedAdjustmentGroups])

  useEffect(() => {
    if (!selectedAsset || selectedAsset.type !== 'video') return
    if (!isElectron() || typeof window === 'undefined' || typeof window.electronAPI?.getVideoFps !== 'function') return
    if (!selectedAsset.absolutePath) return
    if (selectedAsset.videoCodec && selectedAsset.audioCodec && selectedAsset.fps) return

    let cancelled = false

    window.electronAPI.getVideoFps(selectedAsset.absolutePath)
      .then((result) => {
        if (cancelled || !result?.success) return

        const mergedSettings = { ...(selectedAsset.settings || {}) }
        let didChange = false

        if (Number.isFinite(Number(result.fps)) && !Number.isFinite(Number(selectedAsset.fps))) {
          mergedSettings.fps = result.fps
          didChange = true
        }

        if (result.videoCodec && result.videoCodec !== selectedAsset.videoCodec) {
          didChange = true
        }

        if (result.audioCodec && result.audioCodec !== selectedAsset.audioCodec) {
          didChange = true
        }

        if (!didChange) return

        updateAsset(selectedAsset.id, {
          fps: Number.isFinite(Number(result.fps)) ? result.fps : selectedAsset.fps,
          videoCodec: result.videoCodec || selectedAsset.videoCodec || null,
          audioCodec: result.audioCodec || selectedAsset.audioCodec || null,
          settings: mergedSettings,
        })
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [
    selectedAsset,
    selectedAsset?.absolutePath,
    selectedAsset?.audioCodec,
    selectedAsset?.fps,
    selectedAsset?.id,
    selectedAsset?.settings,
    selectedAsset?.type,
    selectedAsset?.videoCodec,
    updateAsset,
  ])

  useEffect(() => {
    if (!selectedAsset || selectedAsset.type !== 'image') return
    if (typeof window === 'undefined') return

    const knownWidth = getAssetInspectorWidth(selectedAsset)
    const knownHeight = getAssetInspectorHeight(selectedAsset)
    const knownSize = getAssetInspectorSize(selectedAsset)
    const needsResolution = !(knownWidth && knownHeight)
    const needsSize = !knownSize
    if (!needsResolution && !needsSize) return

    let cancelled = false

    const loadImageDimensions = (url) => new Promise((resolve) => {
      if (!url) {
        resolve(null)
        return
      }
      const image = new Image()
      image.onload = () => {
        resolve({
          width: image.naturalWidth || image.width || null,
          height: image.naturalHeight || image.height || null,
        })
      }
      image.onerror = () => resolve(null)
      image.src = url
    })

    const hydrateImageMetadata = async () => {
      let imageUrl = selectedAsset.url || selectedClip?.url || null
      let filePath = selectedAsset.absolutePath || null
      if (!filePath && selectedAsset.path && typeof currentProjectHandle === 'string' && isElectron() && window.electronAPI?.pathJoin) {
        try {
          filePath = await window.electronAPI.pathJoin(currentProjectHandle, selectedAsset.path)
        } catch (_) {}
      }

      if (needsResolution && !imageUrl && filePath && isElectron() && window.electronAPI?.getFileUrlDirect) {
        try {
          imageUrl = await window.electronAPI.getFileUrlDirect(filePath)
        } catch (_) {}
      }

      const [dimensions, fileInfo] = await Promise.all([
        needsResolution ? loadImageDimensions(imageUrl) : Promise.resolve(null),
        needsSize && filePath && isElectron() && window.electronAPI?.getFileInfo
          ? window.electronAPI.getFileInfo(filePath).catch(() => null)
          : Promise.resolve(null),
      ])

      if (cancelled) return

      const nextSettings = { ...(selectedAsset.settings || {}) }
      const updates = {}

      const resolvedWidth = firstPositiveNumber(dimensions?.width)
      const resolvedHeight = firstPositiveNumber(dimensions?.height)
      if (resolvedWidth && resolvedHeight) {
        if (!knownWidth) {
          updates.width = resolvedWidth
          nextSettings.width = resolvedWidth
        }
        if (!knownHeight) {
          updates.height = resolvedHeight
          nextSettings.height = resolvedHeight
        }
      }

      const resolvedSize = firstPositiveNumber(fileInfo?.info?.size)
      if (resolvedSize && !knownSize) {
        updates.size = resolvedSize
      }

      if (nextSettings.width !== selectedAsset.settings?.width || nextSettings.height !== selectedAsset.settings?.height) {
        updates.settings = nextSettings
      }

      if (Object.keys(updates).length > 0) {
        updateAsset(selectedAsset.id, updates)
      }
    }

    hydrateImageMetadata().catch(() => {})

    return () => {
      cancelled = true
    }
  }, [
    selectedAsset,
    selectedAsset?.absolutePath,
    selectedAsset?.id,
    selectedAsset?.settings,
    selectedAsset?.size,
    selectedAsset?.type,
    selectedAsset?.url,
    selectedAsset?.width,
    selectedAsset?.height,
    selectedAsset?.path,
    selectedClip?.url,
    currentProjectHandle,
    updateAsset,
  ])

  // Handle render cache for clips with effects
  const handleRenderCache = useCallback(async () => {
    if (!selectedClip || isRendering) return
    
    const enabledEffects = (selectedClip.effects || []).filter(
      (e) => e.enabled && !isManagedEffectType(e?.type)
    )
    if (enabledEffects.length === 0) return

    // Get the video URL
    const asset = getAssetById(selectedClip.assetId)
    const videoUrl = asset?.url || selectedClip.url
    if (!videoUrl) {
      setRenderProgress({ status: 'error', error: 'No video URL found' })
      return
    }

    // Stale-lock recovery: if our local `isRendering` is false (we think
    // nothing's running for this clip from this component) but the render
    // service still believes the clip is mid-render, that entry is orphaned
    // — almost certainly from a prior hang, an HMR reset, or a panel unmount
    // while a render was in flight. Clear it so the call below doesn't bail
    // with "Clip is already being rendered" and leave the user stuck with no
    // way to retry from the UI.
    if (renderCacheService.isRendering(selectedClip.id)) {
      const cleared = renderCacheService.forceClearRender(selectedClip.id)
      if (cleared) {
        console.warn('Cleared stale render lock for clip', selectedClip.id)
      }
    }

    setIsRendering(true)
    setCacheStatus(selectedClip.id, 'rendering', 0)
    setRenderProgress({ status: 'starting', progress: 0 })

    try {
      // Get the blob from render service
      const { blobUrl, blob } = await renderCacheService.renderClipWithEffects(
        selectedClip,
        videoUrl,
        enabledEffects,
        getAssetById,
        {
          fps: 30,
          onProgress: (progress) => {
            setRenderProgress(progress)
            if (progress.progress !== undefined) {
              setCacheStatus(selectedClip.id, 'rendering', progress.progress)
            }
          }
        }
      )

      // Save to disk if we have a project handle
      let cachePath = null
      if (currentProjectHandle && blob) {
        try {
          setRenderProgress({ status: 'saving', progress: 98 })
          cachePath = await saveRenderCache(currentProjectHandle, selectedClip.id, blob, {
            clipId: selectedClip.id,
            duration: selectedClip.duration,
            effects: enabledEffects.map(e => ({ id: e.id, type: e.type })),
          })
          console.log('Saved render cache to:', cachePath)
        } catch (saveErr) {
          console.warn('Failed to save cache to disk:', saveErr)
          // Continue with blob URL even if disk save fails
        }
      }

      // Store the cached URL in the clip (and path if saved)
      setCacheUrl(selectedClip.id, blobUrl, cachePath)
      setRenderProgress({ status: 'complete', progress: 100 })
    } catch (err) {
      console.error('Render cache failed:', err)
      setRenderProgress({ status: 'error', error: err.message })
      setCacheStatus(selectedClip.id, 'none', 0)
    } finally {
      setIsRendering(false)
    }
  }, [selectedClip, isRendering, getAssetById, setCacheStatus, setCacheUrl, currentProjectHandle])

  // Cancel render
  const handleCancelRender = useCallback(() => {
    if (selectedClip && isRendering) {
      renderCacheService.cancelRender(selectedClip.id)
      setIsRendering(false)
      setRenderProgress(null)
      setCacheStatus(selectedClip.id, 'none', 0)
    }
  }, [selectedClip, isRendering, setCacheStatus])

  // Clear cache
  const handleClearCache = useCallback(async () => {
    if (selectedClip) {
      // Clear from memory (render cache service)
      renderCacheService.clearCache(selectedClip.id)
      
      // Clear from disk cache URL map (VideoLayerRenderer)
      clearDiskCacheUrl(selectedClip.id)
      
      // Delete from disk if we have a cache path
      if (selectedClip.cachePath && currentProjectHandle) {
        try {
          await deleteRenderCache(currentProjectHandle, selectedClip.cachePath)
          console.log('Deleted render cache from disk:', selectedClip.cachePath)
        } catch (err) {
          console.warn('Failed to delete cache from disk:', err)
        }
      }
      
      clearClipCache(selectedClip.id)
      setRenderProgress(null)
    }
  }, [selectedClip, clearClipCache, currentProjectHandle])

  const renderSectionHeader = (id, title, icon, options = {}) => {
    const { actions = null } = options
    const Icon = icon
    const isSectionExpanded = expandedSections.includes(id)
    return (
      <div className="w-full flex items-center bg-sf-dark-800">
        <button
          type="button"
          onClick={() => toggleSection(id)}
          className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 hover:bg-sf-dark-700 transition-colors"
        >
          {isSectionExpanded ? (
            <ChevronDown className="w-3 h-3 text-sf-text-muted" />
          ) : (
            <ChevronRight className="w-3 h-3 text-sf-text-muted" />
          )}
          <Icon className="w-4 h-4 text-sf-text-muted" />
          <span className="text-xs font-medium text-sf-text-primary uppercase tracking-wider">{title}</span>
        </button>
        {actions && (
          <div className="flex items-center gap-1 pr-2">
            {actions}
          </div>
        )}
      </div>
    )
  }

  const renderHeaderActionButton = ({ icon: Icon, label, onClick, title, disabled = false }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label || title}
      className={`inline-flex h-7 w-7 items-center justify-center rounded transition-colors ${
        disabled
          ? 'bg-sf-dark-800 text-sf-text-muted/50 cursor-not-allowed'
          : 'bg-sf-dark-700 text-sf-text-secondary hover:bg-sf-dark-600 hover:text-sf-text-primary'
      }`}
      title={title}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  )

  const renderInspectorClipboardButtons = ({ scope, extraActions = null }) => {
    const scopeLabel = INSPECTOR_SETTINGS_SCOPE_LABELS[scope] || 'settings'
    const canPasteForScope = canPasteInspectorSettings(scope)

    return (
      <>
        {renderHeaderActionButton({
          icon: Copy,
          label: scope === INSPECTOR_SETTINGS_SCOPE.ALL ? 'Copy All' : 'Copy',
          onClick: () => handleCopyInspectorSettings(scope),
          disabled: !canCopyInspectorSettings,
          title: `Copy ${scopeLabel} from this clip`,
        })}
        {renderHeaderActionButton({
          icon: ClipboardPaste,
          label: scope === INSPECTOR_SETTINGS_SCOPE.ALL ? 'Paste All' : 'Paste',
          onClick: () => handlePasteInspectorSettings(scope),
          disabled: !canPasteForScope,
          title: canPasteForScope
            ? `Paste copied ${scopeLabel} onto this clip`
            : `Copy ${scopeLabel} first`,
        })}
        {extraActions}
      </>
    )
  }

  const renderInspectorSettingsHeaderActions = () => {
    return renderInspectorClipboardButtons({
      scope: INSPECTOR_SETTINGS_SCOPE.ALL,
      extraActions: selectedSyncEligibleClips.length > 0
        ? renderHeaderActionButton({
            icon: selectedSyncAllLocked ? Unlock : Lock,
            label: selectedSyncAllLocked ? 'Unlock Sync' : 'Lock Sync',
            onClick: () => {
              const targetIds = selectedSyncEligibleClips.map((clip) => clip.id)
              if (selectedSyncAllLocked) {
                unlockSyncLockedClips(targetIds)
              } else {
                lockSyncClips(targetIds, selectedSyncLockByClipId)
              }
            },
            title: selectedSyncAllLocked
              ? `Unlock sync on ${selectedSyncEligibleClips.length} selected clips`
              : `Lock sync on ${selectedSyncEligibleClips.length} selected clips`,
          })
        : null,
    })
  }

  const renderCompositingSection = () => {
    if (!selectedClip || selectedTrack?.type !== 'video' || selectedClip.type === 'adjustment') {
      return null
    }

    return (
      <>
        {renderSectionHeader('compositing', 'Compositing', Layers)}
        {expandedSections.includes('compositing') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">
                  Look at lower layers
                </label>
                <span className={`px-1.5 py-0.5 rounded text-[9px] border ${
                  compositeStatus.compositeLowerLayers
                    ? 'bg-sky-950/70 text-sky-200 border-sky-800/60'
                    : 'bg-emerald-950/70 text-emerald-200 border-emerald-800/60'
                }`}>
                  {compositeStatus.label}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1">
                {CLIP_COMPOSITE_MODE_OPTIONS.map((option) => {
                  const isActive = compositeMode === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => handleCompositeModeCommit(option.value)}
                      title={option.description}
                      className={`py-1.5 rounded text-[10px] transition-colors ${
                        isActive
                          ? 'bg-sf-accent text-white'
                          : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                      }`}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <p className="text-[10px] text-sf-text-muted leading-relaxed">
              {compositeStatus.description}
            </p>
            <p className="text-[10px] text-sf-text-secondary leading-relaxed">
              Auto speeds up preview/cache/export when a clip safely covers everything below. Opacity, scale-down, crop,
              masks, rotation, and blend modes automatically keep lower layers active.
            </p>
          </div>
        )}
      </>
    )
  }

  const renderMotionBlurControl = () => {
    if (!selectedClip || !transform || selectedClip.type === 'adjustment') return null

    const enabled = transform.motionBlurEnabled === true
    const mode = ['auto', 'velocity', 'sampled'].includes(String(transform.motionBlurMode || '').toLowerCase())
      ? String(transform.motionBlurMode).toLowerCase()
      : 'auto'
    const shutterPosition = ['center', 'trail'].includes(String(transform.motionBlurPosition || '').toLowerCase())
      ? String(transform.motionBlurPosition).toLowerCase()
      : 'center'
    const samples = Math.max(2, Math.min(48, Math.round(Number(transform.motionBlurSamples) || 8)))
    const shutter = Math.max(1, Math.min(360, Math.round(Number(transform.motionBlurShutter) || 180)))
    const sharpnessRaw = Number(transform.motionBlurSharpness)
    const sharpnessPct = Math.round(Math.max(0, Math.min(1, Number.isFinite(sharpnessRaw) ? sharpnessRaw : 0)) * 100)
    const selectedMode = MOTION_BLUR_MODE_OPTIONS.find((option) => option.value === mode) || MOTION_BLUR_MODE_OPTIONS[0]

    return (
      <div className="rounded-md border border-sf-dark-700 bg-sf-dark-800/50 p-3 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <label className="text-[10px] text-sf-text-muted block">Motion Blur</label>
            <p className="mt-1 text-[10px] text-sf-text-secondary">
              Blends sub-frame samples for animated layer movement.
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleTransformCommit('motionBlurEnabled', !enabled)}
            className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
              enabled
                ? 'bg-sf-accent text-white'
                : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
            }`}
            title={enabled ? 'Turn motion blur off for this clip' : 'Turn motion blur on for this clip'}
          >
            {enabled ? 'On' : 'Off'}
          </button>
        </div>

        <div className={enabled ? 'space-y-3' : 'space-y-3 opacity-45 pointer-events-none'}>
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-[10px] text-sf-text-muted">Mode</span>
              <span className="text-[10px] text-sf-text-secondary">{selectedMode.label}</span>
            </div>
            <select
              value={mode}
              onChange={(e) => handleTransformCommit('motionBlurMode', e.target.value)}
              title={selectedMode.description}
              className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
            >
              {MOTION_BLUR_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <p className="mt-1 text-[10px] text-sf-text-secondary leading-relaxed">
              {selectedMode.description}
            </p>
          </div>

          <div>
            <div className="flex justify-between mb-1">
              <span className="text-[10px] text-sf-text-muted">Shutter Position</span>
              <span className="text-[10px] text-sf-text-secondary">{shutterPosition === 'center' ? 'Centered' : 'Trailing'}</span>
            </div>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => handleTransformCommit('motionBlurPosition', 'center')}
                className={`px-2 py-1 rounded text-[10px] transition-colors ${
                  shutterPosition === 'center'
                    ? 'bg-sf-accent/20 text-sf-accent border border-sf-accent/30'
                    : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                }`}
                title="Camera-style shutter centered on the frame — symmetric blur (Resolve/AE default)"
              >
                Centered
              </button>
              <button
                type="button"
                onClick={() => handleTransformCommit('motionBlurPosition', 'trail')}
                className={`px-2 py-1 rounded text-[10px] transition-colors ${
                  shutterPosition === 'trail'
                    ? 'bg-sf-accent/20 text-sf-accent border border-sf-accent/30'
                    : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                }`}
                title="Echo-style blur that trails behind the motion with a sharp current frame"
              >
                Trailing
              </button>
            </div>
          </div>

          <div>
            <div className="flex justify-between mb-1">
              <span className="text-[10px] text-sf-text-muted">Samples</span>
              <span className="text-[10px] text-sf-text-secondary">{samples}</span>
            </div>
            <input
              type="range"
              min="2"
              max="48"
              step="1"
              value={samples}
              onChange={(e) => handleTransformChange('motionBlurSamples', parseInt(e.target.value, 10))}
              onMouseUp={(e) => handleTransformCommit('motionBlurSamples', parseInt(e.target.value, 10))}
              onDoubleClick={() => handleTransformCommit('motionBlurSamples', 8)}
              title="Double-click to reset to 8 samples"
              className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
            />
          </div>

          <div>
            <div className="flex justify-between mb-1">
              <span className="text-[10px] text-sf-text-muted">Shutter</span>
              <span className="text-[10px] text-sf-text-secondary">{shutter} deg</span>
            </div>
            <input
              type="range"
              min="1"
              max="360"
              step="1"
              value={shutter}
              onChange={(e) => handleTransformChange('motionBlurShutter', parseInt(e.target.value, 10))}
              onMouseUp={(e) => handleTransformCommit('motionBlurShutter', parseInt(e.target.value, 10))}
              onDoubleClick={() => handleTransformCommit('motionBlurShutter', 180)}
              title="Double-click to reset to 180 deg"
              className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
            />
          </div>

          <div>
            <div className="flex justify-between mb-1">
              <span className="text-[10px] text-sf-text-muted">Sharpness</span>
              <span className="text-[10px] text-sf-text-secondary">{sharpnessPct}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={sharpnessPct}
              onChange={(e) => handleTransformChange('motionBlurSharpness', parseInt(e.target.value, 10) / 100)}
              onMouseUp={(e) => handleTransformCommit('motionBlurSharpness', parseInt(e.target.value, 10) / 100)}
              onDoubleClick={() => handleTransformCommit('motionBlurSharpness', 0)}
              title="Blends an unblurred copy of the frame over the smear. 0% = physically correct motion blur. Double-click to reset."
              className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
            />
          </div>
        </div>
      </div>
    )
  }

  const renderShapeControlsSection = () => {
    if (!selectedClip || selectedClip.type !== 'shape') return null
    const shapeProps = getShapeProps()
    if (!shapeProps) return null
    const isLineShape = shapeProps.shapeType === 'line'
    const isPolygonShape = shapeProps.shapeType === 'polygon'

    return (
      <>
        {renderSectionHeader('shape', 'Shape', Square)}
        {expandedSections.includes('shape') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1">Type</label>
              <select
                value={shapeProps.shapeType}
                onChange={(e) => handleShapeTypeCommit(e.target.value)}
                className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
              >
                {SHAPE_TYPES.map((shape) => (
                  <option key={shape.value} value={shape.value}>{shape.label}</option>
                ))}
              </select>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] text-sf-text-muted flex items-center gap-1">
                  <Maximize2 className="w-3 h-3" /> Size
                </label>
                {!isLineShape && (
                  <button
                    onClick={() => handleShapePropertyCommit('sizeLinked', !shapeProps.sizeLinked)}
                    className={`p-1 rounded transition-colors ${shapeProps.sizeLinked ? 'bg-sf-accent/30 text-sf-accent' : 'hover:bg-sf-dark-700 text-sf-text-muted'}`}
                    title={shapeProps.sizeLinked ? 'Unlink Width/Height' : 'Link Width/Height'}
                  >
                    {shapeProps.sizeLinked ? <Link className="w-3 h-3" /> : <Unlink className="w-3 h-3" />}
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[9px] text-sf-text-muted">{isLineShape ? 'Length' : 'Width'}</label>
                  <KeyframeButton
                    clipId={selectedClip?.id}
                    property="width"
                    clip={selectedClip}
                    playheadPosition={playheadPosition}
                  />
                </div>
                <DraggableNumberInput
                  value={shapeProps.width}
                  onChange={(val) => handleShapePropertyChange('width', val)}
                  onCommit={(val) => handleShapePropertyCommit('width', val)}
                  min={1}
                  max={20000}
                  step={1}
                  sensitivity={1}
                  suffix="px"
                  resetValue={DEFAULT_SHAPE_PROPERTIES.width}
                  onReset={() => handleShapeSizeReset('width')}
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[9px] text-sf-text-muted">{isLineShape ? 'Thickness' : 'Height'}</label>
                  <KeyframeButton
                    clipId={selectedClip?.id}
                    property="height"
                    clip={selectedClip}
                    playheadPosition={playheadPosition}
                  />
                </div>
                <DraggableNumberInput
                  value={shapeProps.height}
                  onChange={(val) => handleShapePropertyChange('height', val)}
                  onCommit={(val) => handleShapePropertyCommit('height', val)}
                  min={1}
                  max={20000}
                  step={1}
                  sensitivity={1}
                  suffix="px"
                  resetValue={isLineShape ? DEFAULT_LINE_THICKNESS : DEFAULT_SHAPE_PROPERTIES.height}
                  onReset={() => handleShapeSizeReset('height')}
                />
              </div>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] text-sf-text-muted">{isLineShape ? 'Line' : 'Fill'}</label>
                <select
                  value={shapeProps.fillType}
                  onChange={(e) => handleShapePropertyCommit('fillType', e.target.value)}
                  className="bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-[10px] text-sf-text-primary focus:outline-none focus:border-sf-accent"
                >
                  {SHAPE_FILL_TYPES.map((fillType) => (
                    <option key={fillType.value} value={fillType.value}>{fillType.label}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={shapeProps.fillColor}
                  onChange={(e) => handleShapePropertyChange('fillColor', e.target.value)}
                  onBlur={(e) => handleShapePropertyCommit('fillColor', e.target.value)}
                  className="w-8 h-8 rounded border border-sf-dark-600 cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={shapeProps.fillColor}
                  onChange={(e) => handleShapePropertyChange('fillColor', e.target.value)}
                  onBlur={(e) => handleShapePropertyCommit('fillColor', e.target.value)}
                  className="flex-1 bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                />
              </div>
              {shapeProps.fillType !== 'solid' && (
                <>
                  <div className="mt-2 flex gap-2">
                    <input
                      type="color"
                      value={shapeProps.fillColorB}
                      onChange={(e) => handleShapePropertyChange('fillColorB', e.target.value)}
                      onBlur={(e) => handleShapePropertyCommit('fillColorB', e.target.value)}
                      className="w-8 h-8 rounded border border-sf-dark-600 cursor-pointer bg-transparent"
                    />
                    <input
                      type="text"
                      value={shapeProps.fillColorB}
                      onChange={(e) => handleShapePropertyChange('fillColorB', e.target.value)}
                      onBlur={(e) => handleShapePropertyCommit('fillColorB', e.target.value)}
                      className="flex-1 bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                    />
                  </div>
                  {shapeProps.fillType === 'linearGradient' && (
                    <div className="mt-2">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[9px] text-sf-text-muted">Angle</span>
                        <div className="flex items-center gap-1">
                          <KeyframeButton
                            clipId={selectedClip?.id}
                            property="gradientAngle"
                            clip={selectedClip}
                            playheadPosition={playheadPosition}
                          />
                          <span className="text-[9px] text-sf-text-secondary">{Math.round(shapeProps.gradientAngle)}deg</span>
                        </div>
                      </div>
                      <input
                        type="range"
                        min="-180"
                        max="180"
                        step="1"
                        value={shapeProps.gradientAngle}
                        onChange={(e) => handleShapePropertyChange('gradientAngle', parseInt(e.target.value, 10))}
                        onMouseUp={(e) => handleShapePropertyCommit('gradientAngle', parseInt(e.target.value, 10))}
                        onDoubleClick={() => handleShapePropertyCommit('gradientAngle', DEFAULT_SHAPE_PROPERTIES.gradientAngle)}
                        title="Double-click to reset to 0deg"
                        className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                      />
                    </div>
                  )}
                  {shapeProps.fillType === 'radialGradient' && (
                    <div className="mt-2 space-y-2">
                      {[
                        ['gradientCenterX', 'Center X', DEFAULT_SHAPE_PROPERTIES.gradientCenterX],
                        ['gradientCenterY', 'Center Y', DEFAULT_SHAPE_PROPERTIES.gradientCenterY],
                        ['gradientRadius', 'Radius', DEFAULT_SHAPE_PROPERTIES.gradientRadius],
                      ].map(([property, label, resetValue]) => (
                        <div key={property}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[9px] text-sf-text-muted">{label}</span>
                            <div className="flex items-center gap-1">
                              <KeyframeButton
                                clipId={selectedClip?.id}
                                property={property}
                                clip={selectedClip}
                                playheadPosition={playheadPosition}
                              />
                              <span className="text-[9px] text-sf-text-secondary">{Math.round(shapeProps[property])}%</span>
                            </div>
                          </div>
                          <input
                            type="range"
                            min={property === 'gradientRadius' ? '1' : '0'}
                            max={property === 'gradientRadius' ? '200' : '100'}
                            step="1"
                            value={shapeProps[property]}
                            onChange={(e) => handleShapePropertyChange(property, parseInt(e.target.value, 10))}
                            onMouseUp={(e) => handleShapePropertyCommit(property, parseInt(e.target.value, 10))}
                            onDoubleClick={() => handleShapePropertyCommit(property, resetValue)}
                            title={`Double-click to reset ${label.toLowerCase()}`}
                            className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              <div className="mt-2 flex items-center gap-2">
                <span className="w-12 text-[9px] text-sf-text-muted">Opacity</span>
                <KeyframeButton
                  clipId={selectedClip?.id}
                  property="fillOpacity"
                  clip={selectedClip}
                  playheadPosition={playheadPosition}
                />
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={shapeProps.fillOpacity}
                  onChange={(e) => handleShapePropertyChange('fillOpacity', parseInt(e.target.value))}
                  onMouseUp={(e) => handleShapePropertyCommit('fillOpacity', parseInt(e.target.value))}
                  className="flex-1 h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                />
                <span className="w-9 text-right text-[9px] text-sf-text-secondary">{Math.round(shapeProps.fillOpacity)}%</span>
              </div>
            </div>

            {!isLineShape && (
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1">Stroke</label>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={shapeProps.strokeColor}
                  onChange={(e) => handleShapePropertyChange('strokeColor', e.target.value)}
                  onBlur={(e) => handleShapePropertyCommit('strokeColor', e.target.value)}
                  className="w-8 h-8 rounded border border-sf-dark-600 cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={shapeProps.strokeColor}
                  onChange={(e) => handleShapePropertyChange('strokeColor', e.target.value)}
                  onBlur={(e) => handleShapePropertyCommit('strokeColor', e.target.value)}
                  className="flex-1 bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                />
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="w-12 text-[9px] text-sf-text-muted">Width</span>
                <KeyframeButton
                  clipId={selectedClip?.id}
                  property="strokeWidth"
                  clip={selectedClip}
                  playheadPosition={playheadPosition}
                />
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={shapeProps.strokeWidth}
                  onChange={(e) => handleShapePropertyChange('strokeWidth', parseInt(e.target.value))}
                  onMouseUp={(e) => handleShapePropertyCommit('strokeWidth', parseInt(e.target.value))}
                  className="flex-1 h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                />
                <span className="w-9 text-right text-[9px] text-sf-text-secondary">{Math.round(shapeProps.strokeWidth)}px</span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <span className="w-12 text-[9px] text-sf-text-muted">Opacity</span>
                <KeyframeButton
                  clipId={selectedClip?.id}
                  property="strokeOpacity"
                  clip={selectedClip}
                  playheadPosition={playheadPosition}
                />
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={shapeProps.strokeOpacity}
                  onChange={(e) => handleShapePropertyChange('strokeOpacity', parseInt(e.target.value))}
                  onMouseUp={(e) => handleShapePropertyCommit('strokeOpacity', parseInt(e.target.value))}
                  className="flex-1 h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                />
                <span className="w-9 text-right text-[9px] text-sf-text-secondary">{Math.round(shapeProps.strokeOpacity)}%</span>
              </div>
            </div>
            )}

            {shapeProps.shapeType === 'roundedRectangle' && (
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[10px] text-sf-text-muted">Corner Radius</label>
                  <div className="flex items-center gap-1">
                    <KeyframeButton
                      clipId={selectedClip?.id}
                      property="cornerRadius"
                      clip={selectedClip}
                      playheadPosition={playheadPosition}
                    />
                    <span className="text-[10px] text-sf-text-secondary">{Math.round(shapeProps.cornerRadius)}px</span>
                  </div>
                </div>
                <input
                  type="range"
                  min="0"
                  max="500"
                  value={shapeProps.cornerRadius}
                  onChange={(e) => handleShapePropertyChange('cornerRadius', parseInt(e.target.value))}
                  onMouseUp={(e) => handleShapePropertyCommit('cornerRadius', parseInt(e.target.value))}
                  className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                />
              </div>
            )}

            {isPolygonShape && (
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[10px] text-sf-text-muted">Sides</label>
                  <div className="flex items-center gap-1">
                    <KeyframeButton
                      clipId={selectedClip?.id}
                      property="sides"
                      clip={selectedClip}
                      playheadPosition={playheadPosition}
                    />
                    <span className="text-[10px] text-sf-text-secondary">{Math.round(shapeProps.sides)}</span>
                  </div>
                </div>
                <input
                  type="range"
                  min="3"
                  max="64"
                  step="1"
                  value={shapeProps.sides}
                  onChange={(e) => handleShapePropertyChange('sides', parseInt(e.target.value))}
                  onMouseUp={(e) => handleShapePropertyCommit('sides', parseInt(e.target.value))}
                  onDoubleClick={() => handleShapePropertyCommit('sides', DEFAULT_POLYGON_SIDES)}
                  title="Double-click to reset to 6 sides"
                  className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                />
              </div>
            )}
          </div>
        )}
      </>
    )
  }

  // Render Video Clip Inspector (with 2D transforms)
  const renderVideoClipInspector = () => {
    if (!selectedClip || !transform) return null
    const isShapeInspector = selectedClip.type === 'shape'
    const isImageInspector = selectedClip.type === 'image'
    const summaryTitle = selectedClip.name || (isShapeInspector ? 'Shape Clip' : (isImageInspector ? 'Image Clip' : 'Video Clip'))
    const summarySubtitle = `${selectedTrack?.name || 'Unknown Track'} - ${isShapeInspector ? 'Shape clip' : (isImageInspector ? 'Image clip' : 'Video clip')}`
    const SummaryIcon = isShapeInspector ? Square : (isImageInspector ? FileImage : FileVideo)
    const iconToneClassName = isShapeInspector ? 'text-cyan-100' : (isImageInspector ? 'text-emerald-200' : 'text-blue-100')
    const iconBgClassName = isShapeInspector ? 'bg-cyan-500/20' : (isImageInspector ? 'bg-emerald-500/20' : 'bg-blue-500/20')
    const typeBadgeClassName = isShapeInspector
      ? 'bg-cyan-500/15 text-cyan-300'
      : (isImageInspector ? 'bg-emerald-500/15 text-emerald-300' : 'bg-blue-500/15 text-blue-300')

    return (
      <>
        {renderClipSummaryHeader({
          title: summaryTitle,
          subtitle: summarySubtitle,
          icon: SummaryIcon,
          iconToneClassName,
          iconBgClassName,
          badges: [
            {
              label: 'type',
              value: isShapeInspector ? 'SHAPE' : (isImageInspector ? 'IMAGE' : 'VIDEO'),
              className: typeBadgeClassName,
            },
            {
              label: 'timeline-fps',
              value: `${timecodeFps} FPS`,
            },
          ],
        })}

        {renderShapeControlsSection()}

        {/* Transform Section */}
        {renderSectionHeader('transform', 'Transform', Move, {
          actions: renderInspectorClipboardButtons({
            scope: INSPECTOR_SETTINGS_SCOPE.TRANSFORM,
            extraActions: renderHeaderActionButton({
              icon: RotateCcw,
              label: 'Reset',
              onClick: handleResetTransform,
              title: 'Reset all transform properties to default',
            }),
          }),
        })}
        {expandedSections.includes('transform') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            {/* Position */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1.5 flex items-center gap-1">
                <Move className="w-3 h-3" /> Position
              </label>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label
                      className="text-[9px] text-sf-text-muted cursor-pointer select-none"
                      title="Double-click to reset X position"
                      onDoubleClick={() => handleSliderReset('positionX', 0)}
                    >
                      X
                    </label>
                    <KeyframeButton 
                      clipId={selectedClip?.id} 
                      property="positionX" 
                      clip={selectedClip}
                      playheadPosition={playheadPosition}
                    />
                  </div>
                  <div className="flex items-center">
                    <DraggableNumberInput
                      value={animatedTransform?.positionX ?? transform.positionX}
                      onChange={(val) => handleTransformChange('positionX', val)}
                      onCommit={(val) => handleTransformCommit('positionX', val)}
                      resetValue={0}
                      onReset={(val) => handleSliderReset('positionX', val)}
                      step={1}
                      sensitivity={1}
                    />
                    <span className="ml-1 text-[9px] text-sf-text-muted">px</span>
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label
                      className="text-[9px] text-sf-text-muted cursor-pointer select-none"
                      title="Double-click to reset Y position"
                      onDoubleClick={() => handleSliderReset('positionY', 0)}
                    >
                      Y
                    </label>
                    <KeyframeButton 
                      clipId={selectedClip?.id} 
                      property="positionY" 
                      clip={selectedClip}
                      playheadPosition={playheadPosition}
                    />
                  </div>
                  <div className="flex items-center">
                    <DraggableNumberInput
                      value={animatedTransform?.positionY ?? transform.positionY}
                      onChange={(val) => handleTransformChange('positionY', val)}
                      onCommit={(val) => handleTransformCommit('positionY', val)}
                      resetValue={0}
                      onReset={(val) => handleSliderReset('positionY', val)}
                      step={1}
                      sensitivity={1}
                    />
                    <span className="ml-1 text-[9px] text-sf-text-muted">px</span>
                  </div>
                </div>
              </div>
              <div className="mt-2">
                <div className="flex items-center justify-between mb-0.5">
                  <label
                    className="text-[9px] text-sf-text-muted cursor-pointer select-none"
                    title="Double-click to reset Z position"
                    onDoubleClick={() => handleSliderReset('positionZ', 0)}
                  >
                    Z
                  </label>
                  <KeyframeButton
                    clipId={selectedClip?.id}
                    property="positionZ"
                    clip={selectedClip}
                    playheadPosition={playheadPosition}
                  />
                </div>
                <div className="flex items-center">
                  <DraggableNumberInput
                    value={animatedTransform?.positionZ ?? transform.positionZ ?? 0}
                    onChange={(val) => handleTransformChange('positionZ', val)}
                    onCommit={(val) => handleTransformCommit('positionZ', val)}
                    resetValue={0}
                    onReset={(val) => handleSliderReset('positionZ', val)}
                    step={1}
                    sensitivity={1}
                  />
                  <span className="ml-1 text-[9px] text-sf-text-muted">px</span>
                </div>
              </div>
            </div>

            {/* Scale with Link toggle */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] text-sf-text-muted flex items-center gap-1">
                  <Maximize2 className="w-3 h-3" /> Scale
                </label>
                <div className="flex items-center gap-1">
                  <KeyframeButton 
                    clipId={selectedClip?.id} 
                    property="scaleX" 
                    clip={selectedClip}
                    playheadPosition={playheadPosition}
                  />
                  <button
                    onClick={() => handleTransformCommit('scaleLinked', !transform.scaleLinked)}
                    className={`p-1 rounded transition-colors ${transform.scaleLinked ? 'bg-sf-accent/30 text-sf-accent' : 'hover:bg-sf-dark-700 text-sf-text-muted'}`}
                    title={transform.scaleLinked ? 'Unlink X/Y Scale' : 'Link X/Y Scale'}
                  >
                    {transform.scaleLinked ? <Link className="w-3 h-3" /> : <Unlink className="w-3 h-3" />}
                  </button>
                </div>
              </div>
              
              {transform.scaleLinked ? (
                // Single scale slider when linked
                <div>
                  <div className="flex justify-between mb-1">
                    <span className="text-[9px] text-sf-text-muted">Uniform</span>
                    <span className="text-[10px] text-sf-text-secondary">{Math.round(animatedTransform?.scaleX ?? transform.scaleX)}%</span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="400"
                    value={animatedTransform?.scaleX ?? transform.scaleX}
                    onChange={(e) => handleTransformChange('scaleX', parseInt(e.target.value))}
                    onMouseUp={(e) => handleTransformCommit('scaleX', parseInt(e.target.value))}
                    onDoubleClick={() => handleSliderReset('scaleX', 100)}
                    title="Double-click to reset to 100%"
                    className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                  />
                </div>
              ) : (
                // Separate X/Y sliders when unlinked
                <div className="space-y-2">
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-[9px] text-sf-text-muted">Width (X)</span>
                      <span className="text-[10px] text-sf-text-secondary">{Math.round(animatedTransform?.scaleX ?? transform.scaleX)}%</span>
                    </div>
                    <input
                      type="range"
                      min="10"
                      max="400"
                      value={transform.scaleX}
                      onChange={(e) => handleTransformChange('scaleX', parseInt(e.target.value))}
                      onMouseUp={(e) => handleTransformCommit('scaleX', parseInt(e.target.value))}
                      onDoubleClick={() => handleSliderReset('scaleX', 100)}
                      title="Double-click to reset to 100%"
                      className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-[9px] text-sf-text-muted">Height (Y)</span>
                      <span className="text-[10px] text-sf-text-secondary">{transform.scaleY}%</span>
                    </div>
                    <input
                      type="range"
                      min="10"
                      max="400"
                      value={transform.scaleY}
                      onChange={(e) => handleTransformChange('scaleY', parseInt(e.target.value))}
                      onMouseUp={(e) => handleTransformCommit('scaleY', parseInt(e.target.value))}
                      onDoubleClick={() => handleSliderReset('scaleY', 100)}
                      title="Double-click to reset to 100%"
                      className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Rotation */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-[10px] text-sf-text-muted flex items-center gap-1">
                  <RotateCw className="w-3 h-3" /> Rotate Z
                </label>
                <div className="flex items-center gap-1">
                  <KeyframeButton 
                    clipId={selectedClip?.id} 
                    property="rotation" 
                    clip={selectedClip}
                    playheadPosition={playheadPosition}
                  />
                  <input
                    type="number"
                    value={Math.round(animatedTransform?.rotation ?? transform.rotation)}
                    onChange={(e) => handleTransformChange('rotation', parseFloat(e.target.value) || 0)}
                    onBlur={(e) => handleTransformCommit('rotation', parseFloat(e.target.value) || 0)}
                    onDoubleClick={() => handleSliderReset('rotation', 0)}
                    title="Double-click to reset to 0deg"
                    className="w-14 bg-sf-dark-700 border border-sf-dark-600 rounded px-1.5 py-0.5 text-[10px] text-sf-text-primary focus:outline-none focus:border-sf-accent text-right"
                  />
                  <span className="text-[10px] text-sf-text-secondary">°</span>
                </div>
              </div>
              <input
                type="range"
                min="-180"
                max="180"
                value={animatedTransform?.rotation ?? transform.rotation}
                onChange={(e) => handleTransformChange('rotation', parseInt(e.target.value))}
                onMouseUp={(e) => handleTransformCommit('rotation', parseInt(e.target.value))}
                onDoubleClick={() => handleSliderReset('rotation', 0)}
                title="Double-click to reset to 0°"
                className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
              />
            </div>

            {/* 3D Rotation */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1.5">
                3D Rotation
              </label>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label
                      className="text-[9px] text-sf-text-muted cursor-pointer select-none"
                      title="Double-click to reset X rotation"
                      onDoubleClick={() => handleSliderReset('rotationX', 0)}
                    >
                      Rotate X
                    </label>
                    <KeyframeButton
                      clipId={selectedClip?.id}
                      property="rotationX"
                      clip={selectedClip}
                      playheadPosition={playheadPosition}
                    />
                  </div>
                  <div className="flex items-center">
                    <DraggableNumberInput
                      value={animatedTransform?.rotationX ?? transform.rotationX ?? 0}
                      onChange={(val) => handleTransformChange('rotationX', val)}
                      onCommit={(val) => handleTransformCommit('rotationX', val)}
                      resetValue={0}
                      onReset={(val) => handleSliderReset('rotationX', val)}
                      min={-89}
                      max={89}
                      step={1}
                      sensitivity={0.5}
                    />
                    <span className="ml-1 text-[9px] text-sf-text-muted">deg</span>
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label
                      className="text-[9px] text-sf-text-muted cursor-pointer select-none"
                      title="Double-click to reset Y rotation"
                      onDoubleClick={() => handleSliderReset('rotationY', 0)}
                    >
                      Rotate Y
                    </label>
                    <KeyframeButton
                      clipId={selectedClip?.id}
                      property="rotationY"
                      clip={selectedClip}
                      playheadPosition={playheadPosition}
                    />
                  </div>
                  <div className="flex items-center">
                    <DraggableNumberInput
                      value={animatedTransform?.rotationY ?? transform.rotationY ?? 0}
                      onChange={(val) => handleTransformChange('rotationY', val)}
                      onCommit={(val) => handleTransformCommit('rotationY', val)}
                      resetValue={0}
                      onReset={(val) => handleSliderReset('rotationY', val)}
                      min={-89}
                      max={89}
                      step={1}
                      sensitivity={0.5}
                    />
                    <span className="ml-1 text-[9px] text-sf-text-muted">deg</span>
                  </div>
                </div>
              </div>
              <div className="mt-2">
                <div className="flex items-center justify-between mb-0.5">
                  <label
                    className="text-[9px] text-sf-text-muted cursor-pointer select-none"
                    title="Double-click to reset perspective"
                    onDoubleClick={() => handleSliderReset('perspective', 1200)}
                  >
                    Perspective
                  </label>
                  <KeyframeButton
                    clipId={selectedClip?.id}
                    property="perspective"
                    clip={selectedClip}
                    playheadPosition={playheadPosition}
                  />
                </div>
                <div className="flex items-center">
                  <DraggableNumberInput
                    value={animatedTransform?.perspective ?? transform.perspective ?? 1200}
                    onChange={(val) => handleTransformChange('perspective', val)}
                    onCommit={(val) => handleTransformCommit('perspective', val)}
                    resetValue={1200}
                    onReset={(val) => handleSliderReset('perspective', val)}
                    min={100}
                    max={10000}
                    step={10}
                    sensitivity={4}
                  />
                  <span className="ml-1 text-[9px] text-sf-text-muted">px</span>
                </div>
              </div>
            </div>

            {/* Flip Controls */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1.5">Flip</label>
              <div className="flex gap-2">
                <button
                  onClick={() => handleTransformCommit('flipH', !transform.flipH)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs transition-colors ${
                    transform.flipH 
                      ? 'bg-sf-accent text-white' 
                      : 'bg-sf-dark-700 text-sf-text-secondary hover:bg-sf-dark-600'
                  }`}
                >
                  <FlipHorizontal className="w-3.5 h-3.5" />
                  Horizontal
                </button>
                <button
                  onClick={() => handleTransformCommit('flipV', !transform.flipV)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs transition-colors ${
                    transform.flipV 
                      ? 'bg-sf-accent text-white' 
                      : 'bg-sf-dark-700 text-sf-text-secondary hover:bg-sf-dark-600'
                  }`}
                >
                  <FlipVertical className="w-3.5 h-3.5" />
                  Vertical
                </button>
              </div>
            </div>

            {/* Opacity */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-[10px] text-sf-text-muted flex items-center gap-1">
                  <Eye className="w-3 h-3" /> Opacity
                </label>
                <div className="flex items-center gap-1">
                  <KeyframeButton 
                    clipId={selectedClip?.id} 
                    property="opacity" 
                    clip={selectedClip}
                    playheadPosition={playheadPosition}
                  />
                  <span className="text-[10px] text-sf-text-secondary">{Math.round(animatedTransform?.opacity ?? transform.opacity)}%</span>
                </div>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={animatedTransform?.opacity ?? transform.opacity}
                onChange={(e) => handleTransformChange('opacity', parseInt(e.target.value))}
                onMouseUp={(e) => handleTransformCommit('opacity', parseInt(e.target.value))}
                onDoubleClick={() => handleSliderReset('opacity', 100)}
                title="Double-click to reset to 100%"
                className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
              />
            </div>

            {/* Blend Mode (visual clips only) */}
            {(selectedClip?.type === 'video' || selectedClip?.type === 'image' || selectedClip?.type === 'text' || selectedClip?.type === 'shape') && (
              <div>
                <label className="text-[10px] text-sf-text-muted block mb-1">
                  Blend Mode
                </label>
                <select
                  value={transform.blendMode ?? 'normal'}
                  onChange={(e) => {
                    handleTransformChange('blendMode', e.target.value)
                    handleTransformCommit('blendMode', e.target.value)
                  }}
                  className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                >
                  {BLEND_MODES.map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Anchor Point */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1.5 flex items-center gap-1">
                <Anchor className="w-3 h-3" /> Anchor Point
              </label>
              <div className="grid grid-cols-3 gap-1">
                {[
                  [0, 0], [50, 0], [100, 0],
                  [0, 50], [50, 50], [100, 50],
                  [0, 100], [50, 100], [100, 100],
                ].map(([x, y], i) => (
                  <button
                    key={i}
                    onClick={() => {
                      handleTransformChange('anchorX', x)
                      handleTransformCommit('anchorY', y)
                    }}
                    className={`h-6 rounded text-[9px] transition-colors ${
                      transform.anchorX === x && transform.anchorY === y
                        ? 'bg-sf-accent text-white'
                        : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                    }`}
                    title={`Anchor ${x}%, ${y}%`}
                  >
                    {x === 50 && y === 50 ? '●' : '○'}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div>
                  <label className="text-[9px] text-sf-text-muted block mb-0.5">X</label>
                  <DraggableNumberInput
                    value={transform.anchorX}
                    onChange={(val) => handleTransformChange('anchorX', val)}
                    onCommit={(val) => handleTransformCommit('anchorX', val)}
                    min={0}
                    max={100}
                    step={1}
                    sensitivity={0.5}
                  />
                </div>
                <div>
                  <label className="text-[9px] text-sf-text-muted block mb-0.5">Y</label>
                  <DraggableNumberInput
                    value={transform.anchorY}
                    onChange={(val) => handleTransformChange('anchorY', val)}
                    onCommit={(val) => handleTransformCommit('anchorY', val)}
                    min={0}
                    max={100}
                    step={1}
                    sensitivity={0.5}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {renderCompositingSection()}

        {/* Crop Section */}
        {renderSectionHeader('crop', 'Crop', Crop, {
          actions: renderInspectorClipboardButtons({
            scope: INSPECTOR_SETTINGS_SCOPE.CROP,
            extraActions: renderHeaderActionButton({
              icon: RotateCcw,
              label: 'Reset Crop',
              onClick: handleResetCrop,
              title: 'Reset crop to 0 on all sides',
            }),
          }),
        })}
        {expandedSections.includes('crop') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            {/* Visual Crop Preview */}
            <div className="relative w-full aspect-video bg-sf-dark-800 rounded overflow-hidden">
              <div 
                className="absolute bg-sf-dark-600 border border-sf-dark-500"
                style={{
                  left: `${transform.cropLeft}%`,
                  right: `${transform.cropRight}%`,
                  top: `${transform.cropTop}%`,
                  bottom: `${transform.cropBottom}%`,
                }}
              >
                <div className="w-full h-full flex items-center justify-center text-[9px] text-sf-text-muted">
                  Preview
                </div>
              </div>
            </div>

            {/* Crop Sliders */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-[9px] text-sf-text-muted">Top</label>
                  <span className="text-[9px] text-sf-text-secondary">{transform.cropTop}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={transform.cropTop}
                  onChange={(e) => handleTransformChange('cropTop', parseInt(e.target.value))}
                  onMouseUp={(e) => handleTransformCommit('cropTop', parseInt(e.target.value))}
                  onDoubleClick={() => { handleTransformChange('cropTop', 0); handleTransformCommit('cropTop', 0) }}
                  title="Double-click to reset to 0"
                  className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                />
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-[9px] text-sf-text-muted">Bottom</label>
                  <span className="text-[9px] text-sf-text-secondary">{transform.cropBottom}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={transform.cropBottom}
                  onChange={(e) => handleTransformChange('cropBottom', parseInt(e.target.value))}
                  onMouseUp={(e) => handleTransformCommit('cropBottom', parseInt(e.target.value))}
                  onDoubleClick={() => { handleTransformChange('cropBottom', 0); handleTransformCommit('cropBottom', 0) }}
                  title="Double-click to reset to 0"
                  className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                />
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-[9px] text-sf-text-muted">Left</label>
                  <span className="text-[9px] text-sf-text-secondary">{transform.cropLeft}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={transform.cropLeft}
                  onChange={(e) => handleTransformChange('cropLeft', parseInt(e.target.value))}
                  onMouseUp={(e) => handleTransformCommit('cropLeft', parseInt(e.target.value))}
                  onDoubleClick={() => { handleTransformChange('cropLeft', 0); handleTransformCommit('cropLeft', 0) }}
                  title="Double-click to reset to 0"
                  className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                />
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-[9px] text-sf-text-muted">Right</label>
                  <span className="text-[9px] text-sf-text-secondary">{transform.cropRight}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={transform.cropRight}
                  onChange={(e) => handleTransformChange('cropRight', parseInt(e.target.value))}
                  onMouseUp={(e) => handleTransformCommit('cropRight', parseInt(e.target.value))}
                  onDoubleClick={() => { handleTransformChange('cropRight', 0); handleTransformCommit('cropRight', 0) }}
                  title="Double-click to reset to 0"
                  className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                />
              </div>
            </div>

          </div>
        )}

        {renderStandardClipAdjustmentsSection()}

        {/* Timing Section */}
        {renderSectionHeader('timing', 'Timing', Clock, {
          actions: renderInspectorClipboardButtons({
            scope: INSPECTOR_SETTINGS_SCOPE.TIMING,
            extraActions: canResetTiming ? renderHeaderActionButton({
              icon: RotateCcw,
              label: 'Reset Timing',
              onClick: handleResetTiming,
              disabled: !hasTimingResetChanges,
              title: 'Reset speed to 1x and clear reverse',
            }) : null,
          }),
        })}
        {expandedSections.includes('timing') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Start Time</label>
                <div className="flex items-center">
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={selectedClip.startTime?.toFixed(2)}
                    disabled
                    className="w-full bg-sf-dark-800 border border-sf-dark-700 rounded px-2 py-1 text-xs text-sf-text-muted cursor-not-allowed"
                  />
                  <span className="ml-1 text-[9px] text-sf-text-muted">s</span>
                </div>
              </div>
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Duration</label>
                <div className="flex items-center">
                  <input
                    type="number"
                    step="0.01"
                    min="0.04"
                    value={selectedClip.duration?.toFixed(3)}
                    onChange={(e) => {
                      const parsed = parseFloat(e.target.value)
                      if (Number.isFinite(parsed)) resizeClip(selectedClip.id, parsed)
                    }}
                    className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                  />
                  <span className="ml-1 text-[9px] text-sf-text-muted">s</span>
                </div>
              </div>
            </div>

            {(selectedClip.type === 'video' || selectedClip.type === 'audio') && (
              <div className="space-y-2">
                <div>
                  <label className="text-[9px] text-sf-text-muted block mb-1">Speed</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.001"
                      value={speedToSliderPosition(selectedClip.speed)}
                      onChange={(e) => updateClipSpeed(selectedClip.id, sliderPositionToSpeed(parseFloat(e.target.value)), false)}
                      onMouseUp={(e) => updateClipSpeed(selectedClip.id, sliderPositionToSpeed(parseFloat(e.target.value)), true)}
                      className="flex-1"
                    />
                    <input
                      type="number"
                      min={CLIP_SPEED_MIN}
                      max={CLIP_SPEED_MAX}
                      step="0.01"
                      value={(Number.isFinite(Number(selectedClip.speed)) ? Number(selectedClip.speed) : 1).toFixed(2)}
                      onChange={(e) => updateClipSpeed(selectedClip.id, parseFloat(e.target.value) || 1, false)}
                      onBlur={(e) => updateClipSpeed(selectedClip.id, parseFloat(e.target.value) || 1, true)}
                      className="w-16 bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                    />
                    <span className="text-[9px] text-sf-text-muted">x</span>
                  </div>
                  <div className="flex items-center gap-1 mt-1">
                    {CLIP_SPEED_PRESETS.map((preset) => {
                      const currentSpeed = Number.isFinite(Number(selectedClip.speed)) ? Number(selectedClip.speed) : 1
                      const isActive = Math.abs(currentSpeed - preset) < 0.005
                      return (
                        <button
                          key={preset}
                          onClick={() => updateClipSpeed(selectedClip.id, preset, true)}
                          className={`px-1.5 py-0.5 rounded text-[9px] border transition-colors ${
                            isActive
                              ? 'bg-sf-accent/20 border-sf-accent text-sf-accent'
                              : 'bg-sf-dark-700 border-sf-dark-600 text-sf-text-muted hover:text-sf-text-primary hover:border-sf-dark-500'
                          }`}
                        >
                          {preset}x
                        </button>
                      )
                    })}
                  </div>
                </div>

                {selectedClip.type === 'video' && (
                  <label className="flex items-center gap-2 text-[9px] text-sf-text-muted">
                    <input
                      type="checkbox"
                      checked={!!selectedClip.reverse}
                      onChange={(e) => updateClipReverse(selectedClip.id, e.target.checked, true)}
                    />
                    Reverse
                  </label>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Trim Start</label>
                <div className="flex items-center">
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={selectedClip.trimStart?.toFixed(2)}
                    disabled
                    className="w-full bg-sf-dark-800 border border-sf-dark-700 rounded px-2 py-1 text-xs text-sf-text-muted cursor-not-allowed"
                  />
                  <span className="ml-1 text-[9px] text-sf-text-muted">s</span>
                </div>
              </div>
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Trim End</label>
                <div className="flex items-center">
                  <input
                    type="number"
                    step="0.1"
                    value={selectedClip.trimEnd?.toFixed(2)}
                    disabled
                    className="w-full bg-sf-dark-800 border border-sf-dark-700 rounded px-2 py-1 text-xs text-sf-text-muted cursor-not-allowed"
                  />
                  <span className="ml-1 text-[9px] text-sf-text-muted">s</span>
                </div>
              </div>
            </div>

            <div className="text-[9px] text-sf-text-muted">
              Source Duration:{' '}
              {selectedClip.type === 'image' || selectedClip.sourceDuration === Infinity || selectedClip.sourceDuration === 'Infinity'
                ? 'Infinity'
                : (Number.isFinite(Number(selectedClip.sourceDuration)) && Number(selectedClip.sourceDuration) > 0
                    ? `${Number(selectedClip.sourceDuration).toFixed(2)}s`
                    : 'Unknown')}
            </div>
          </div>
        )}

        {/* Effects Section */}
        {renderSectionHeader('effects', 'Effects', Zap)}
        {expandedSections.includes('effects') && (
          <div className="p-3 space-y-2 border-b border-sf-dark-700">
            {renderAdjustmentBlurControl('Applies blur as an effect on this clip.')}
            {renderMotionBlurControl()}

            {/* Stylistic effects (camera shake, chromatic aberration, film grain, vignette) */}
            <EffectsStack
              clip={selectedClip}
              playheadPosition={playheadPosition}
              addEffect={addEffect}
              removeEffect={removeEffect}
              updateEffect={updateEffect}
              toggleEffect={toggleEffect}
              reorderEffect={reorderEffect}
              setKeyframe={setKeyframe}
              removeKeyframe={removeKeyframe}
              goToNextKeyframe={goToNextKeyframe}
              goToPrevKeyframe={goToPrevKeyframe}
            />

            {/* Render mask effects inline (managed effects handled by EffectsStack above) */}
            {(selectedClip.effects || []).filter((e) => !isManagedEffectType(e?.type)).map((effect, index) => (
              <div key={effect.id} className="bg-sf-dark-800 rounded overflow-hidden">
                {/* Effect Header */}
                <div className="flex items-center gap-2 px-2 py-1.5 bg-sf-dark-700">
                  <button
                    onClick={() => toggleEffect(selectedClip.id, effect.id)}
                    className={`p-1 rounded transition-colors ${
                      effect.enabled ? 'text-purple-400' : 'text-sf-text-muted'
                    }`}
                    title={effect.enabled ? 'Disable effect' : 'Enable effect'}
                  >
                    {effect.enabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  </button>
                  <span className="flex-1 text-xs text-sf-text-primary capitalize">
                    {effect.type === 'mask' ? 'Mask' : effect.type}
                  </span>
                  <button
                    onClick={() => removeEffect(selectedClip.id, effect.id)}
                    className="p-1 hover:bg-sf-dark-600 rounded text-sf-text-muted hover:text-sf-error transition-colors"
                    title="Remove effect"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
                
                {/* Mask Effect Controls */}
                {effect.type === 'mask' && effect.enabled && (
                  <div className="p-2 space-y-2">
                    {/* Mask Asset Info */}
                    {(() => {
                      const maskAsset = getAssetById(effect.maskAssetId)
                      return maskAsset ? (
                        <div className="flex items-center gap-2 p-2 bg-sf-dark-900 rounded">
                          <Wand2 className="w-3.5 h-3.5 text-purple-400" />
                          <div className="flex-1 min-w-0">
                            <p className="text-[10px] text-sf-text-primary truncate">{maskAsset.name}</p>
                            <p className="text-[9px] text-sf-text-muted">
                              {maskAsset.frameCount > 1 ? `${maskAsset.frameCount} frames` : 'Single frame'}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div className="text-[10px] text-sf-text-muted p-2 bg-sf-dark-900 rounded">
                          Mask asset not found
                        </div>
                      )
                    })()}
                    
                    {/* Invert Toggle */}
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-sf-text-secondary">Invert Mask</span>
                      <button
                        onClick={() => updateEffect(selectedClip.id, effect.id, { invertMask: !effect.invertMask }, true)}
                        className={`w-8 h-4 rounded-full transition-colors ${
                          effect.invertMask ? 'bg-purple-500' : 'bg-sf-dark-600'
                        }`}
                      >
                        <div className={`w-3 h-3 rounded-full bg-white transition-transform ${
                          effect.invertMask ? 'translate-x-4' : 'translate-x-0.5'
                        }`} />
                      </button>
                    </div>
                    
                    {/* Feather (future implementation) */}
                    {/* <div className="flex items-center justify-between">
                      <span className="text-[10px] text-sf-text-secondary">Feather</span>
                      <input
                        type="range"
                        min="0"
                        max="20"
                        value={effect.feather || 0}
                        onChange={(e) => updateEffect(selectedClip.id, effect.id, { feather: parseInt(e.target.value) })}
                        className="w-20 h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-purple-500"
                      />
                    </div> */}
                  </div>
                )}
              </div>
            ))}
            
            {/* Render Cache Section - Only show if clip has non-managed (mask) effects enabled */}
            {(selectedClip.effects || []).some(e => e.enabled && !isManagedEffectType(e?.type)) && (
              <div className="bg-sf-dark-800 rounded p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-sf-text-secondary uppercase tracking-wider">Render Cache</span>
                  {/* Cache Status Badge */}
                  {selectedClip.cacheStatus === 'cached' && (
                    <span className="flex items-center gap-1 text-[9px] text-green-400">
                      <Check className="w-3 h-3" />
                      Cached
                    </span>
                  )}
                  {selectedClip.cacheStatus === 'invalid' && (
                    <span className="flex items-center gap-1 text-[9px] text-yellow-400">
                      <AlertTriangle className="w-3 h-3" />
                      Outdated
                    </span>
                  )}
                  {(!selectedClip.cacheStatus || selectedClip.cacheStatus === 'none') && (
                    <span className="flex items-center gap-1 text-[9px] text-sf-text-muted">
                      Not cached
                    </span>
                  )}
                </div>
                
                {/* Progress Bar (when rendering) */}
                {isRendering && renderProgress && (
                  <div className="space-y-1">
                    <div className="h-1.5 bg-sf-dark-600 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-purple-500 transition-all duration-200"
                        style={{ width: `${renderProgress.progress || 0}%` }}
                      />
                    </div>
                    <p className="text-[9px] text-sf-text-muted">
                      {renderProgress.status === 'loading' && 'Loading video...'}
                      {renderProgress.status === 'loading_masks' && 'Loading mask frames...'}
                      {renderProgress.status === 'rendering' && `Rendering frame ${renderProgress.frame || 0}/${renderProgress.totalFrames || '?'}...`}
                      {renderProgress.status === 'encoding' && 'Encoding video...'}
                    </p>
                  </div>
                )}
                
                {/* Error message */}
                {renderProgress?.status === 'error' && (
                  <p className="text-[9px] text-red-400">
                    Error: {renderProgress.error}
                  </p>
                )}
                
                {/* Action Buttons */}
                <div className="flex gap-2">
                  {!isRendering ? (
                    <>
                      <button
                        onClick={handleRenderCache}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-[10px] rounded transition-colors"
                      >
                        <Play className="w-3 h-3" />
                        {selectedClip.cacheStatus === 'cached' ? 'Re-render' : 
                         selectedClip.cacheStatus === 'invalid' ? 'Update Cache' : 'Render Cache'}
                      </button>
                      {selectedClip.cacheStatus === 'cached' && (
                        <button
                          onClick={handleClearCache}
                          className="px-2 py-1.5 bg-sf-dark-600 hover:bg-sf-dark-500 text-sf-text-muted hover:text-sf-text-primary text-[10px] rounded transition-colors"
                          title="Clear cache"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      onClick={handleCancelRender}
                      className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-red-600 hover:bg-red-500 text-white text-[10px] rounded transition-colors"
                    >
                      <X className="w-3 h-3" />
                      Cancel
                    </button>
                  )}
                </div>
                
                {/* Info text */}
                <p className="text-[9px] text-sf-text-muted">
                  {selectedClip.cacheStatus === 'cached' 
                    ? 'Using cached render for smooth playback'
                    : 'Render cache for smooth masked playback'}
                </p>
              </div>
            )}
            
            {/* Add Mask Effect Button */}
            {availableMasks.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setShowMaskPicker(!showMaskPicker)}
                  className="w-full flex items-center justify-center gap-2 py-2 border border-dashed border-purple-500/50 rounded text-xs text-purple-400 hover:border-purple-500 hover:bg-purple-500/10 transition-colors"
                >
                  <Wand2 className="w-3 h-3" />
                  Add Mask Effect
                </button>
                
                {/* Mask Picker Dropdown */}
                {showMaskPicker && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-sf-dark-800 border border-sf-dark-600 rounded-lg shadow-xl z-10 max-h-48 overflow-auto">
                    <div className="p-2 border-b border-sf-dark-600">
                      <span className="text-[10px] text-sf-text-muted uppercase tracking-wider">Select Mask</span>
                    </div>
                    {availableMasks.map(mask => (
                      <button
                        key={mask.id}
                        onClick={() => {
                          addMaskEffect(selectedClip.id, mask.id)
                          setShowMaskPicker(false)
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 transition-colors"
                      >
                        <Layers className="w-3.5 h-3.5 text-purple-400" />
                        <div className="flex-1 min-w-0">
                          <p className="truncate">{mask.name}</p>
                          <p className="text-[9px] text-sf-text-muted">
                            {mask.prompt ? `"${mask.prompt}"` : 'No prompt'}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            
            {/* No masks available message */}
            {availableMasks.length === 0 && (selectedClip.effects || []).filter((e) => !isManagedEffectType(e?.type)).length === 0 && (
              <div className="text-center py-3">
                <Wand2 className="w-6 h-6 text-sf-text-muted mx-auto mb-2 opacity-50" />
                <p className="text-[10px] text-sf-text-muted">No mask effects applied</p>
                <p className="text-[9px] text-sf-text-muted mt-1">
                  Generate masks from the Assets panel
                </p>
              </div>
            )}
            
          </div>
        )}
      </>
    )
  }

  const handleCommitRender = async () => {
    if (!selectedClip || selectedClip.type !== 'adjustment') return
    if (commitRenderState.busy) return
    setCommitRenderState({
      busy: true,
      progress: 0,
      status: 'Preparing commit render…',
      error: null,
      lastSuccessAt: 0,
    })
    const result = await commitAdjustmentRender(selectedClip.id, {
      onProgress: ({ status, progress }) => {
        setCommitRenderState((prev) => ({
          ...prev,
          busy: true,
          status: typeof status === 'string' ? status : prev.status,
          progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : prev.progress,
        }))
      },
    })
    if (result?.success) {
      setCommitRenderState({
        busy: false,
        progress: 100,
        status: 'Commit layer added on top.',
        error: null,
        lastSuccessAt: Date.now(),
      })
    } else {
      setCommitRenderState({
        busy: false,
        progress: 0,
        status: '',
        error: result?.error || 'Commit render failed.',
        lastSuccessAt: 0,
      })
    }
  }

  const renderAdjustmentClipInspector = () => {
    if (!selectedClip || !transform) return null
    const adjustments = animatedAdjustments
    const commitDisabledReason = !isElectron()
      ? 'Available in the desktop app only.'
      : !currentProjectHandle
        ? 'Open a project folder first.'
        : !(Number(selectedClip?.duration) > 0)
          ? 'Adjustment clip has zero duration.'
          : null
    const commitDisabled = commitRenderState.busy || !!commitDisabledReason

    return (
      <>
        {renderClipSummaryHeader({
          title: selectedClip.name || 'Adjustment Layer',
          subtitle: `${selectedTrack?.name || 'Unknown Track'} • Adjustment clip`,
          icon: SlidersHorizontal,
          iconToneClassName: 'text-violet-100',
          iconBgClassName: 'bg-violet-500/20',
          badges: [
            {
              label: 'type',
              value: 'ADJUSTMENT',
              className: 'bg-violet-500/15 text-violet-300',
            },
            {
              label: 'timeline-fps',
              value: `${timecodeFps} FPS`,
            },
          ],
        })}

        {renderSectionHeader('transform', 'Transform', Move, {
          actions: renderInspectorClipboardButtons({
            scope: INSPECTOR_SETTINGS_SCOPE.TRANSFORM,
            extraActions: renderHeaderActionButton({
              icon: RotateCcw,
              label: 'Reset',
              onClick: handleResetTransform,
              title: 'Reset transform properties',
            }),
          }),
        })}
        {expandedSections.includes('transform') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1.5 flex items-center gap-1">
                <Move className="w-3 h-3" /> Position
              </label>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[9px] text-sf-text-muted">X</label>
                    <KeyframeButton
                      clipId={selectedClip?.id}
                      property="positionX"
                      clip={selectedClip}
                      playheadPosition={playheadPosition}
                    />
                  </div>
                  <div className="flex items-center">
                    <DraggableNumberInput
                      value={animatedTransform?.positionX ?? transform.positionX}
                      onChange={(val) => handleTransformChange('positionX', val)}
                      onCommit={(val) => handleTransformCommit('positionX', val)}
                      step={1}
                      sensitivity={1}
                    />
                    <span className="ml-1 text-[9px] text-sf-text-muted">px</span>
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[9px] text-sf-text-muted">Y</label>
                    <KeyframeButton
                      clipId={selectedClip?.id}
                      property="positionY"
                      clip={selectedClip}
                      playheadPosition={playheadPosition}
                    />
                  </div>
                  <div className="flex items-center">
                    <DraggableNumberInput
                      value={animatedTransform?.positionY ?? transform.positionY}
                      onChange={(val) => handleTransformChange('positionY', val)}
                      onCommit={(val) => handleTransformCommit('positionY', val)}
                      step={1}
                      sensitivity={1}
                    />
                    <span className="ml-1 text-[9px] text-sf-text-muted">px</span>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-[10px] text-sf-text-muted flex items-center gap-1">
                  <Maximize2 className="w-3 h-3" /> Scale
                </label>
                <div className="flex items-center gap-1">
                  <KeyframeButton
                    clipId={selectedClip?.id}
                    property="scaleX"
                    clip={selectedClip}
                    playheadPosition={playheadPosition}
                  />
                  <span className="text-[10px] text-sf-text-secondary">{Math.round(animatedTransform?.scaleX ?? transform.scaleX)}%</span>
                </div>
              </div>
              <input
                type="range"
                min="10"
                max="400"
                value={animatedTransform?.scaleX ?? transform.scaleX}
                onChange={(e) => handleTransformChange('scaleX', parseInt(e.target.value))}
                onMouseUp={(e) => handleTransformCommit('scaleX', parseInt(e.target.value))}
                onDoubleClick={() => handleSliderReset('scaleX', 100)}
                title="Double-click to reset to 100%"
                className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-[10px] text-sf-text-muted flex items-center gap-1">
                  <RotateCw className="w-3 h-3" /> Rotation
                </label>
                <KeyframeButton
                  clipId={selectedClip?.id}
                  property="rotation"
                  clip={selectedClip}
                  playheadPosition={playheadPosition}
                />
                <div className="flex items-center gap-1">
                  <KeyframeButton
                    clipId={selectedClip?.id}
                    property="rotation"
                    clip={selectedClip}
                    playheadPosition={playheadPosition}
                  />
                  <span className="text-[10px] text-sf-text-secondary">{Math.round(animatedTransform?.rotation ?? transform.rotation)}deg</span>
                </div>
              </div>
              <input
                type="range"
                min="-180"
                max="180"
                value={animatedTransform?.rotation ?? transform.rotation}
                onChange={(e) => handleTransformChange('rotation', parseInt(e.target.value))}
                onMouseUp={(e) => handleTransformCommit('rotation', parseInt(e.target.value))}
                onDoubleClick={() => handleSliderReset('rotation', 0)}
                title="Double-click to reset to 0deg"
                className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
              />
            </div>

            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1.5">Flip</label>
              <div className="flex gap-2">
                <button
                  onClick={() => handleTransformCommit('flipH', !(animatedTransform?.flipH ?? transform.flipH))}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs transition-colors ${
                    (animatedTransform?.flipH ?? transform.flipH)
                      ? 'bg-sf-accent text-white'
                      : 'bg-sf-dark-700 text-sf-text-secondary hover:bg-sf-dark-600'
                  }`}
                >
                  <FlipHorizontal className="w-3.5 h-3.5" />
                  Horizontal
                </button>
                <button
                  onClick={() => handleTransformCommit('flipV', !(animatedTransform?.flipV ?? transform.flipV))}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs transition-colors ${
                    (animatedTransform?.flipV ?? transform.flipV)
                      ? 'bg-sf-accent text-white'
                      : 'bg-sf-dark-700 text-sf-text-secondary hover:bg-sf-dark-600'
                  }`}
                >
                  <FlipVertical className="w-3.5 h-3.5" />
                  Vertical
                </button>
              </div>
            </div>

            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1.5 flex items-center gap-1">
                <Anchor className="w-3 h-3" /> Anchor Point
              </label>
              <div className="grid grid-cols-3 gap-1">
                {[
                  [0, 0], [50, 0], [100, 0],
                  [0, 50], [50, 50], [100, 50],
                  [0, 100], [50, 100], [100, 100],
                ].map(([x, y], i) => (
                  <button
                    key={i}
                    onClick={() => {
                      const applied = applyTransformUpdatesWithHistory({ anchorX: x, anchorY: y }, false)
                      if (!applied) return
                      if (propertyHasKeyframes('anchorX')) {
                        setKeyframe(selectedClip.id, 'anchorX', clipTime, x, 'easeInOut', { saveHistory: false })
                      }
                      if (propertyHasKeyframes('anchorY')) {
                        setKeyframe(selectedClip.id, 'anchorY', clipTime, y, 'easeInOut', { saveHistory: false })
                      }
                    }}
                    className={`h-6 rounded text-[9px] transition-colors ${
                      Math.round(animatedTransform?.anchorX ?? transform.anchorX) === x
                        && Math.round(animatedTransform?.anchorY ?? transform.anchorY) === y
                        ? 'bg-sf-accent text-white'
                        : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                    }`}
                    title={`Anchor ${x}%, ${y}%`}
                  >
                    {x === 50 && y === 50 ? '●' : '○'}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[9px] text-sf-text-muted">X</label>
                    <KeyframeButton
                      clipId={selectedClip?.id}
                      property="anchorX"
                      clip={selectedClip}
                      playheadPosition={playheadPosition}
                    />
                  </div>
                  <DraggableNumberInput
                    value={animatedTransform?.anchorX ?? transform.anchorX}
                    onChange={(val) => handleTransformChange('anchorX', val)}
                    onCommit={(val) => handleTransformCommit('anchorX', val)}
                    min={0}
                    max={100}
                    step={1}
                    sensitivity={0.5}
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[9px] text-sf-text-muted">Y</label>
                    <KeyframeButton
                      clipId={selectedClip?.id}
                      property="anchorY"
                      clip={selectedClip}
                      playheadPosition={playheadPosition}
                    />
                  </div>
                  <DraggableNumberInput
                    value={animatedTransform?.anchorY ?? transform.anchorY}
                    onChange={(val) => handleTransformChange('anchorY', val)}
                    onCommit={(val) => handleTransformCommit('anchorY', val)}
                    min={0}
                    max={100}
                    step={1}
                    sensitivity={0.5}
                  />
                </div>
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-[10px] text-sf-text-muted flex items-center gap-1">
                  <Eye className="w-3 h-3" /> Opacity
                </label>
                <div className="flex items-center gap-1">
                  <KeyframeButton
                    clipId={selectedClip?.id}
                    property="opacity"
                    clip={selectedClip}
                    playheadPosition={playheadPosition}
                  />
                  <span className="text-[10px] text-sf-text-secondary">{Math.round(animatedTransform?.opacity ?? transform.opacity)}%</span>
                </div>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={animatedTransform?.opacity ?? transform.opacity}
                onChange={(e) => handleTransformChange('opacity', parseInt(e.target.value))}
                onMouseUp={(e) => handleTransformCommit('opacity', parseInt(e.target.value))}
                onDoubleClick={() => handleSliderReset('opacity', 100)}
                title="Double-click to reset to 100%"
                className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
              />
            </div>

            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1">
                Blend Mode
              </label>
              <select
                value={transform.blendMode ?? 'normal'}
                onChange={(e) => {
                  handleTransformChange('blendMode', e.target.value)
                  handleTransformCommit('blendMode', e.target.value)
                }}
                className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
              >
                {BLEND_MODES.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {renderSectionHeader('crop', 'Crop', Crop, {
          actions: renderInspectorClipboardButtons({
            scope: INSPECTOR_SETTINGS_SCOPE.CROP,
            extraActions: renderHeaderActionButton({
              icon: RotateCcw,
              label: 'Reset Crop',
              onClick: handleResetCrop,
              title: 'Reset crop to 0 on all sides',
            }),
          }),
        })}
        {expandedSections.includes('crop') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            <div className="relative w-full aspect-video bg-sf-dark-800 rounded overflow-hidden">
              <div
                className="absolute bg-sf-dark-600 border border-sf-dark-500"
                style={{
                  left: `${animatedTransform?.cropLeft ?? transform.cropLeft}%`,
                  right: `${animatedTransform?.cropRight ?? transform.cropRight}%`,
                  top: `${animatedTransform?.cropTop ?? transform.cropTop}%`,
                  bottom: `${animatedTransform?.cropBottom ?? transform.cropBottom}%`,
                }}
              >
                <div className="w-full h-full flex items-center justify-center text-[9px] text-sf-text-muted">
                  Preview
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[9px] text-sf-text-muted">Top</label>
                  <div className="flex items-center gap-1">
                    <KeyframeButton
                      clipId={selectedClip?.id}
                      property="cropTop"
                      clip={selectedClip}
                      playheadPosition={playheadPosition}
                    />
                    <span className="text-[9px] text-sf-text-secondary">{Math.round(animatedTransform?.cropTop ?? transform.cropTop)}%</span>
                  </div>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={animatedTransform?.cropTop ?? transform.cropTop}
                  onChange={(e) => handleTransformChange('cropTop', parseInt(e.target.value))}
                  onMouseUp={(e) => handleTransformCommit('cropTop', parseInt(e.target.value))}
                  onDoubleClick={() => handleSliderReset('cropTop', 0)}
                  title="Double-click to reset to 0"
                  className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[9px] text-sf-text-muted">Bottom</label>
                  <div className="flex items-center gap-1">
                    <KeyframeButton
                      clipId={selectedClip?.id}
                      property="cropBottom"
                      clip={selectedClip}
                      playheadPosition={playheadPosition}
                    />
                    <span className="text-[9px] text-sf-text-secondary">{Math.round(animatedTransform?.cropBottom ?? transform.cropBottom)}%</span>
                  </div>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={animatedTransform?.cropBottom ?? transform.cropBottom}
                  onChange={(e) => handleTransformChange('cropBottom', parseInt(e.target.value))}
                  onMouseUp={(e) => handleTransformCommit('cropBottom', parseInt(e.target.value))}
                  onDoubleClick={() => handleSliderReset('cropBottom', 0)}
                  title="Double-click to reset to 0"
                  className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[9px] text-sf-text-muted">Left</label>
                  <div className="flex items-center gap-1">
                    <KeyframeButton
                      clipId={selectedClip?.id}
                      property="cropLeft"
                      clip={selectedClip}
                      playheadPosition={playheadPosition}
                    />
                    <span className="text-[9px] text-sf-text-secondary">{Math.round(animatedTransform?.cropLeft ?? transform.cropLeft)}%</span>
                  </div>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={animatedTransform?.cropLeft ?? transform.cropLeft}
                  onChange={(e) => handleTransformChange('cropLeft', parseInt(e.target.value))}
                  onMouseUp={(e) => handleTransformCommit('cropLeft', parseInt(e.target.value))}
                  onDoubleClick={() => handleSliderReset('cropLeft', 0)}
                  title="Double-click to reset to 0"
                  className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[9px] text-sf-text-muted">Right</label>
                  <div className="flex items-center gap-1">
                    <KeyframeButton
                      clipId={selectedClip?.id}
                      property="cropRight"
                      clip={selectedClip}
                      playheadPosition={playheadPosition}
                    />
                    <span className="text-[9px] text-sf-text-secondary">{Math.round(animatedTransform?.cropRight ?? transform.cropRight)}%</span>
                  </div>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={animatedTransform?.cropRight ?? transform.cropRight}
                  onChange={(e) => handleTransformChange('cropRight', parseInt(e.target.value))}
                  onMouseUp={(e) => handleTransformCommit('cropRight', parseInt(e.target.value))}
                  onDoubleClick={() => handleSliderReset('cropRight', 0)}
                  title="Double-click to reset to 0"
                  className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                />
              </div>
            </div>

          </div>
        )}

        {renderSectionHeader('effects', 'Effects', Zap)}
        {expandedSections.includes('effects') && (
          <div className="p-3 space-y-2 border-b border-sf-dark-700">
            {renderAdjustmentBlurControl('Applies blur as an effect on the clips below this layer.')}

            {/* Stylistic effects applied to all layers beneath this adjustment */}
            <EffectsStack
              clip={selectedClip}
              playheadPosition={playheadPosition}
              addEffect={addEffect}
              removeEffect={removeEffect}
              updateEffect={updateEffect}
              toggleEffect={toggleEffect}
              reorderEffect={reorderEffect}
              setKeyframe={setKeyframe}
              removeKeyframe={removeKeyframe}
              goToNextKeyframe={goToNextKeyframe}
              goToPrevKeyframe={goToPrevKeyframe}
            />
          </div>
        )}

        {renderSectionHeader('adjustments', 'Color', Sparkles, {
          actions: renderInspectorClipboardButtons({
            scope: INSPECTOR_SETTINGS_SCOPE.ADJUSTMENTS,
            extraActions: renderHeaderActionButton({
              icon: RotateCcw,
              label: 'Reset',
              onClick: handleClipAdjustmentsReset,
              title: 'Reset color controls',
            }),
          }),
        })}
        {expandedSections.includes('adjustments') && (
          renderSharedAdjustmentsContent(adjustments, 'Applies color controls to clips below this layer.')
        )}

        {renderSectionHeader('timing', 'Timing', Clock, {
          actions: renderInspectorClipboardButtons({
            scope: INSPECTOR_SETTINGS_SCOPE.TIMING,
            extraActions: canResetTiming ? renderHeaderActionButton({
              icon: RotateCcw,
              label: 'Reset Timing',
              onClick: handleResetTiming,
              disabled: !hasTimingResetChanges,
              title: 'Reset speed to 1x and clear reverse',
            }) : null,
          }),
        })}
        {expandedSections.includes('timing') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Start Time</label>
                <div className="flex items-center">
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={selectedClip.startTime?.toFixed(2)}
                    disabled
                    className="w-full bg-sf-dark-800 border border-sf-dark-700 rounded px-2 py-1 text-xs text-sf-text-muted cursor-not-allowed"
                  />
                  <span className="ml-1 text-[9px] text-sf-text-muted">s</span>
                </div>
              </div>
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Duration</label>
                <div className="flex items-center">
                  <input
                    type="number"
                    step="0.01"
                    min="0.04"
                    value={selectedClip.duration?.toFixed(3)}
                    onChange={(e) => {
                      const parsed = parseFloat(e.target.value)
                      if (Number.isFinite(parsed)) resizeClip(selectedClip.id, parsed)
                    }}
                    className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                  />
                  <span className="ml-1 text-[9px] text-sf-text-muted">s</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {renderSectionHeader('commit', 'Commit Render', HardDrive)}
        {expandedSections.includes('commit') && (
          <div className="p-3 space-y-2 border-b border-sf-dark-700">
            <p className="text-[10px] text-sf-text-muted leading-relaxed">
              Flatten this adjustment and everything beneath it into a single video
              clip on a new &quot;Commits&quot; track. Playback becomes smooth because the
              compositor plays one layer instead of running live effects. Delete the
              commit clip to re-expose the live composite for editing.
            </p>
            <button
              type="button"
              onClick={() => { void handleCommitRender() }}
              disabled={commitDisabled}
              title={commitDisabledReason || 'Render this adjustment and its underlying layers to a single clip'}
              className={`w-full flex items-center justify-center gap-2 py-2 rounded text-xs font-medium transition-colors ${
                commitDisabled
                  ? 'bg-sf-dark-800 text-sf-text-muted cursor-not-allowed'
                  : 'bg-violet-600 hover:bg-violet-500 text-white'
              }`}
            >
              {commitRenderState.busy ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Committing… {Math.round(commitRenderState.progress)}%</span>
                </>
              ) : (
                <>
                  <HardDrive className="w-3.5 h-3.5" />
                  <span>Commit render</span>
                </>
              )}
            </button>
            {commitRenderState.busy && commitRenderState.status && (
              <p className="text-[10px] text-sf-text-muted truncate" title={commitRenderState.status}>
                {commitRenderState.status}
              </p>
            )}
            {!commitRenderState.busy && commitRenderState.error && (
              <div className="flex items-start gap-1.5 text-[10px] text-red-300 bg-red-900/20 border border-red-800/40 rounded px-2 py-1.5">
                <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-[1px]" />
                <span className="break-words">{commitRenderState.error}</span>
              </div>
            )}
            {!commitRenderState.busy && !commitRenderState.error && commitRenderState.lastSuccessAt > 0 && (
              <div className="flex items-start gap-1.5 text-[10px] text-emerald-300 bg-emerald-900/20 border border-emerald-800/40 rounded px-2 py-1.5">
                <Check className="w-3 h-3 flex-shrink-0 mt-[1px]" />
                <span>Commit layer added on top. Delete it to edit again.</span>
              </div>
            )}
            {!commitRenderState.busy && commitDisabledReason && (
              <p className="text-[10px] text-sf-text-muted">{commitDisabledReason}</p>
            )}
          </div>
        )}
      </>
    )
  }

  const renderStandardClipAdjustmentsSection = () => (
    <>
      {renderSectionHeader('adjustments', 'Color', Sparkles, {
        actions: renderInspectorClipboardButtons({
          scope: INSPECTOR_SETTINGS_SCOPE.ADJUSTMENTS,
          extraActions: renderHeaderActionButton({
            icon: RotateCcw,
            label: 'Reset',
            onClick: handleClipAdjustmentsReset,
            title: 'Reset color controls',
          }),
        }),
      })}
      {expandedSections.includes('adjustments') && (
        renderSharedAdjustmentsContent(animatedAdjustments, 'Applies color controls to this clip.')
      )}
    </>
  )

  // Text property handlers
  const handleTextPropertyChange = useCallback((key, value) => {
    if (!selectedClip) return
    updateTextProperties(selectedClip.id, { [key]: value }, false)
  }, [selectedClip, updateTextProperties])
  
  const handleTextPropertyCommit = useCallback((key, value) => {
    if (!selectedClip) return
    updateTextProperties(selectedClip.id, { [key]: value }, true)
  }, [selectedClip, updateTextProperties])

  const buildShapePropertyUpdates = useCallback((key, value) => {
    if (!selectedClip || selectedClip.type !== 'shape') return null

    const currentShape = normalizeShapeProperties(selectedClip.shapeProperties || {})
    const isSizeProperty = key === 'width' || key === 'height'
    if (!isSizeProperty || !currentShape.sizeLinked) {
      return { [key]: value }
    }

    const nextValue = Math.max(1, Number(value) || currentShape[key] || DEFAULT_SHAPE_PROPERTIES[key])
    const currentWidth = Math.max(1, Number(currentShape.width) || DEFAULT_SHAPE_PROPERTIES.width)
    const currentHeight = Math.max(1, Number(currentShape.height) || DEFAULT_SHAPE_PROPERTIES.height)
    if (key === 'width') {
      const ratio = currentHeight / currentWidth
      return {
        width: nextValue,
        height: Math.max(1, Math.round(nextValue * ratio)),
      }
    }

    const ratio = currentWidth / currentHeight
    return {
      width: Math.max(1, Math.round(nextValue * ratio)),
      height: nextValue,
    }
  }, [selectedClip])

  const handleShapePropertyChange = useCallback((key, value) => {
    if (!selectedClip || selectedClip.type !== 'shape') return
    const updates = buildShapePropertyUpdates(key, value)
    if (!updates) return
    updateShapeProperties(selectedClip.id, updates, false)
    for (const [property, nextValue] of Object.entries(updates)) {
      if (propertyHasKeyframes(property)) {
        setKeyframe(selectedClip.id, property, clipTime, nextValue, 'easeInOut', { saveHistory: false })
      }
    }
  }, [selectedClip, buildShapePropertyUpdates, updateShapeProperties, propertyHasKeyframes, setKeyframe, clipTime])

  const handleShapePropertyCommit = useCallback((key, value) => {
    if (!selectedClip || selectedClip.type !== 'shape') return
    const updates = buildShapePropertyUpdates(key, value)
    if (!updates) return
    updateShapeProperties(selectedClip.id, updates, true)
  }, [selectedClip, buildShapePropertyUpdates, updateShapeProperties])

  const handleShapeTypeCommit = useCallback((shapeType) => {
    if (!selectedClip || selectedClip.type !== 'shape') return
    const currentShape = normalizeShapeProperties(selectedClip.shapeProperties || {})
    const updates = { shapeType }
    if (shapeType === 'line') {
      updates.sizeLinked = false
      updates.height = DEFAULT_LINE_THICKNESS
    } else if (currentShape.shapeType === 'line') {
      updates.sizeLinked = DEFAULT_SHAPE_PROPERTIES.sizeLinked
      updates.width = DEFAULT_SHAPE_PROPERTIES.width
      updates.height = DEFAULT_SHAPE_PROPERTIES.height
    }
    updateShapeProperties(selectedClip.id, updates, true)
  }, [selectedClip, updateShapeProperties])

  const handleShapeSizeReset = useCallback((key) => {
    if (!selectedClip || selectedClip.type !== 'shape') return
    const currentShape = normalizeShapeProperties(selectedClip.shapeProperties || {})
    const updates = currentShape.shapeType === 'line'
      ? {
          [key]: key === 'height' ? DEFAULT_LINE_THICKNESS : DEFAULT_SHAPE_PROPERTIES.width,
        }
      : currentShape.sizeLinked
      ? {
          width: DEFAULT_SHAPE_PROPERTIES.width,
          height: DEFAULT_SHAPE_PROPERTIES.height,
        }
      : {
          [key]: DEFAULT_SHAPE_PROPERTIES[key],
        }
    updateShapeProperties(selectedClip.id, updates, true)
    for (const [property, nextValue] of Object.entries(updates)) {
      if (propertyHasKeyframes(property)) {
        setKeyframe(selectedClip.id, property, clipTime, nextValue, 'easeInOut', { saveHistory: false })
      }
    }
  }, [clipTime, propertyHasKeyframes, selectedClip, setKeyframe, updateShapeProperties])

  const handleApplyTextAnimationPreset = useCallback((presetId) => {
    if (!selectedClip || selectedClip.type !== 'text') return
    applyTextAnimationPreset(selectedClip.id, presetId, textAnimationMode)
  }, [selectedClip, applyTextAnimationPreset, textAnimationMode])

  const handleClearTextAnimationPreset = useCallback(() => {
    if (!selectedClip || selectedClip.type !== 'text') return
    clearTextAnimationPreset(selectedClip.id)
  }, [selectedClip, clearTextAnimationPreset])

  // Render Text Clip Inspector
  const renderTextClipInspector = () => {
    if (!selectedClip || !transform) return null
    const textProps = getTextProps()
    if (!textProps) return null
    const activeAnimationPresetId = selectedClip?.titleAnimation?.presetId || 'none'
    
    return (
      <>
        {renderClipSummaryHeader({
          title: selectedClip.name || 'Text Clip',
          subtitle: `${selectedTrack?.name || 'Unknown Track'} • Text clip`,
          icon: Type,
          iconToneClassName: 'text-amber-100',
          iconBgClassName: 'bg-amber-500/20',
          badges: [
            {
              label: 'type',
              value: 'TEXT',
              className: 'bg-amber-500/15 text-amber-300',
            },
            {
              label: 'timeline-fps',
              value: `${timecodeFps} FPS`,
            },
          ],
        })}

        {/* Text Content Section */}
        {renderSectionHeader('text', 'Text Content', Type)}
        {expandedSections.includes('text') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            {/* Text Content */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1">Content</label>
              <textarea
                ref={textContentInputRef}
                value={textProps.text}
                onChange={(e) => handleTextPropertyChange('text', e.target.value)}
                onBlur={(e) => handleTextPropertyCommit('text', e.target.value)}
                className="w-full h-20 bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary resize-none focus:outline-none focus:border-sf-accent"
                placeholder="Enter text..."
              />
            </div>

            {/* Font Family */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1">Font</label>
              <select
                value={textProps.fontFamily}
                onChange={(e) => handleTextPropertyCommit('fontFamily', e.target.value)}
                className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
              >
                {FONT_OPTIONS.map(font => (
                  <option key={font} value={font} style={{ fontFamily: font }}>{font}</option>
                ))}
              </select>
            </div>

            {/* Font Size and Weight */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Size</label>
                <DraggableNumberInput
                  value={textProps.fontSize}
                  onChange={(val) => handleTextPropertyChange('fontSize', val)}
                  onCommit={(val) => handleTextPropertyCommit('fontSize', val)}
                  min={8}
                  max={300}
                  step={1}
                  sensitivity={0.5}
                  suffix="px"
                />
              </div>
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Weight</label>
                <select
                  value={textProps.fontWeight}
                  onChange={(e) => handleTextPropertyCommit('fontWeight', e.target.value)}
                  className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                >
                  <option value="normal">Normal</option>
                  <option value="bold">Bold</option>
                  <option value="100">Thin</option>
                  <option value="300">Light</option>
                  <option value="500">Medium</option>
                  <option value="600">Semi Bold</option>
                  <option value="800">Extra Bold</option>
                </select>
              </div>
            </div>

            {/* Text Alignment */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1.5">Alignment</label>
              <div className="grid grid-cols-2 gap-2">
                {/* Horizontal */}
                <div className="flex gap-1">
                  {[
                    { value: 'left', icon: AlignLeft },
                    { value: 'center', icon: AlignCenter },
                    { value: 'right', icon: AlignRight },
                  ].map(({ value, icon: Icon }) => (
                    <button
                      key={value}
                      onClick={() => handleTextPropertyCommit('textAlign', value)}
                      className={`flex-1 p-1.5 rounded text-xs transition-colors ${
                        textProps.textAlign === value
                          ? 'bg-sf-accent text-white'
                          : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                      }`}
                      title={`Align ${value}`}
                    >
                      <Icon className="w-3.5 h-3.5 mx-auto" />
                    </button>
                  ))}
                </div>
                {/* Vertical */}
                <div className="flex gap-1">
                  {[
                    { value: 'top', icon: AlignVerticalJustifyStart },
                    { value: 'center', icon: AlignVerticalJustifyCenter },
                    { value: 'bottom', icon: AlignVerticalJustifyEnd },
                  ].map(({ value, icon: Icon }) => (
                    <button
                      key={value}
                      onClick={() => handleTextPropertyCommit('verticalAlign', value)}
                      className={`flex-1 p-1.5 rounded text-xs transition-colors ${
                        textProps.verticalAlign === value
                          ? 'bg-sf-accent text-white'
                          : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                      }`}
                      title={`Vertical ${value}`}
                    >
                      <Icon className="w-3.5 h-3.5 mx-auto" />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Colors & Style Section */}
        {renderSectionHeader('style', 'Colors & Style', Sparkles)}
        {expandedSections.includes('style') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            {/* Text Color */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1">Text Color</label>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={textProps.textColor}
                  onChange={(e) => handleTextPropertyChange('textColor', e.target.value)}
                  onBlur={(e) => handleTextPropertyCommit('textColor', e.target.value)}
                  className="w-8 h-8 rounded border border-sf-dark-600 cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={textProps.textColor}
                  onChange={(e) => handleTextPropertyChange('textColor', e.target.value)}
                  onBlur={(e) => handleTextPropertyCommit('textColor', e.target.value)}
                  className="flex-1 bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                />
              </div>
            </div>

            {/* Stroke */}
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-[10px] text-sf-text-muted">Stroke</label>
                <span className="text-[10px] text-sf-text-secondary">{textProps.strokeWidth}px</span>
              </div>
              <div className="flex gap-2 mb-2">
                <input
                  type="color"
                  value={textProps.strokeColor}
                  onChange={(e) => handleTextPropertyChange('strokeColor', e.target.value)}
                  onBlur={(e) => handleTextPropertyCommit('strokeColor', e.target.value)}
                  className="w-8 h-8 rounded border border-sf-dark-600 cursor-pointer bg-transparent"
                />
                <input
                  type="range"
                  min="0"
                  max="10"
                  value={textProps.strokeWidth}
                  onChange={(e) => handleTextPropertyChange('strokeWidth', parseInt(e.target.value))}
                  onMouseUp={(e) => handleTextPropertyCommit('strokeWidth', parseInt(e.target.value))}
                  className="flex-1 h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent self-center"
                />
              </div>
            </div>

            {/* Background */}
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-[10px] text-sf-text-muted">Background</label>
                <span className="text-[10px] text-sf-text-secondary">{textProps.backgroundOpacity}%</span>
              </div>
              <div className="flex gap-2 mb-2">
                <input
                  type="color"
                  value={textProps.backgroundColor}
                  onChange={(e) => handleTextPropertyChange('backgroundColor', e.target.value)}
                  onBlur={(e) => handleTextPropertyCommit('backgroundColor', e.target.value)}
                  className="w-8 h-8 rounded border border-sf-dark-600 cursor-pointer bg-transparent"
                />
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={textProps.backgroundOpacity}
                  onChange={(e) => handleTextPropertyChange('backgroundOpacity', parseInt(e.target.value))}
                  onMouseUp={(e) => handleTextPropertyCommit('backgroundOpacity', parseInt(e.target.value))}
                  className="flex-1 h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent self-center"
                />
              </div>
            </div>

            {/* Shadow Toggle */}
            <div className="flex items-center gap-2 p-2 bg-sf-dark-800 rounded">
              <input
                type="checkbox"
                id="textShadowInspector"
                checked={textProps.shadow}
                onChange={(e) => handleTextPropertyCommit('shadow', e.target.checked)}
                className="w-3.5 h-3.5 rounded border-sf-dark-600 bg-sf-dark-700 text-sf-accent focus:ring-sf-accent cursor-pointer"
              />
              <label htmlFor="textShadowInspector" className="text-[11px] text-sf-text-secondary cursor-pointer flex-1">
                Drop shadow
              </label>
            </div>
          </div>
        )}

        {/* Title Animation Section */}
        {renderSectionHeader('animation', 'Animation', Sparkles)}
        {expandedSections.includes('animation') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            <div>
              <label className="text-[10px] text-sf-text-muted uppercase tracking-wider block mb-1.5">Mode</label>
              <div className="grid grid-cols-3 gap-1">
                {TEXT_ANIMATION_MODE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => setTextAnimationMode(option.id)}
                    className={`py-1 rounded text-[10px] transition-colors ${
                      textAnimationMode === option.id
                        ? 'bg-sf-accent text-white'
                        : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[10px] text-sf-text-muted uppercase tracking-wider block mb-1.5">Presets</label>
              <div className="grid grid-cols-2 gap-1">
                <button
                  onClick={handleClearTextAnimationPreset}
                  className={`px-2 py-1 rounded text-[10px] transition-colors ${
                    activeAnimationPresetId === 'none'
                      ? 'bg-sf-accent text-white'
                      : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                  }`}
                >
                  None
                </button>
                {TEXT_ANIMATION_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => handleApplyTextAnimationPreset(preset.id)}
                    className={`px-2 py-1 rounded text-[10px] transition-colors ${
                      activeAnimationPresetId === preset.id
                        ? 'bg-sf-accent text-white'
                        : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                    }`}
                    title={`Apply ${preset.name}`}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            </div>

            <p className="text-[10px] text-sf-text-muted">
              Presets add keyframes for position, scale, rotation, and opacity.
            </p>
          </div>
        )}

        {renderSectionHeader('effects', 'Effects', Zap)}
        {expandedSections.includes('effects') && (
          <div className="p-3 space-y-2 border-b border-sf-dark-700">
            {renderAdjustmentBlurControl('Applies blur as an effect on this text clip.')}
            {renderMotionBlurControl()}
            <EffectsStack
              clip={selectedClip}
              playheadPosition={playheadPosition}
              addEffect={addEffect}
              removeEffect={removeEffect}
              updateEffect={updateEffect}
              toggleEffect={toggleEffect}
              reorderEffect={reorderEffect}
              setKeyframe={setKeyframe}
              removeKeyframe={removeKeyframe}
              goToNextKeyframe={goToNextKeyframe}
              goToPrevKeyframe={goToPrevKeyframe}
            />
          </div>
        )}

        {/* Transform Section (shared with video) */}
        {renderSectionHeader('transform', 'Transform', Move, {
          actions: renderInspectorClipboardButtons({
            scope: INSPECTOR_SETTINGS_SCOPE.TRANSFORM,
            extraActions: renderHeaderActionButton({
              icon: RotateCcw,
              label: 'Reset',
              onClick: handleResetTransform,
              title: 'Reset all transform properties to default',
            }),
          }),
        })}
        {expandedSections.includes('transform') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            {/* Position */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1.5 flex items-center gap-1">
                <Move className="w-3 h-3" /> Position
              </label>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[9px] text-sf-text-muted">X</label>
                    <KeyframeButton
                      clipId={selectedClip?.id}
                      property="positionX"
                      clip={selectedClip}
                      playheadPosition={playheadPosition}
                    />
                  </div>
                  <div className="flex items-center">
                    <DraggableNumberInput
                      value={animatedTransform?.positionX ?? transform.positionX}
                      onChange={(val) => handleTransformChange('positionX', val)}
                      onCommit={(val) => handleTransformCommit('positionX', val)}
                      step={1}
                      sensitivity={1}
                    />
                    <span className="ml-1 text-[9px] text-sf-text-muted">px</span>
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[9px] text-sf-text-muted">Y</label>
                    <KeyframeButton
                      clipId={selectedClip?.id}
                      property="positionY"
                      clip={selectedClip}
                      playheadPosition={playheadPosition}
                    />
                  </div>
                  <div className="flex items-center">
                    <DraggableNumberInput
                      value={animatedTransform?.positionY ?? transform.positionY}
                      onChange={(val) => handleTransformChange('positionY', val)}
                      onCommit={(val) => handleTransformCommit('positionY', val)}
                      step={1}
                      sensitivity={1}
                    />
                    <span className="ml-1 text-[9px] text-sf-text-muted">px</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Scale */}
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-[10px] text-sf-text-muted flex items-center gap-1">
                  <Maximize2 className="w-3 h-3" /> Scale
                </label>
                <div className="flex items-center gap-1">
                  <KeyframeButton
                    clipId={selectedClip?.id}
                    property="scaleX"
                    clip={selectedClip}
                    playheadPosition={playheadPosition}
                  />
                  <span className="text-[10px] text-sf-text-secondary">{Math.round(animatedTransform?.scaleX ?? transform.scaleX)}%</span>
                </div>
              </div>
              <input
                type="range"
                min="10"
                max="400"
                value={animatedTransform?.scaleX ?? transform.scaleX}
                onChange={(e) => handleTransformChange('scaleX', parseInt(e.target.value))}
                onMouseUp={(e) => handleTransformCommit('scaleX', parseInt(e.target.value))}
                onDoubleClick={() => handleSliderReset('scaleX', 100)}
                title="Double-click to reset to 100%"
                className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
              />
            </div>

            {/* Rotation */}
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-[10px] text-sf-text-muted flex items-center gap-1">
                  <RotateCw className="w-3 h-3" /> Rotation
                </label>
                <KeyframeButton
                  clipId={selectedClip?.id}
                  property="rotation"
                  clip={selectedClip}
                  playheadPosition={playheadPosition}
                />
                <span className="text-[10px] text-sf-text-secondary">{Math.round(animatedTransform?.rotation ?? transform.rotation)}°</span>
              </div>
              <input
                type="range"
                min="-180"
                max="180"
                value={animatedTransform?.rotation ?? transform.rotation}
                onChange={(e) => handleTransformChange('rotation', parseInt(e.target.value))}
                onMouseUp={(e) => handleTransformCommit('rotation', parseInt(e.target.value))}
                onDoubleClick={() => handleSliderReset('rotation', 0)}
                title="Double-click to reset to 0°"
                className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
              />
            </div>

            {/* Opacity */}
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-[10px] text-sf-text-muted flex items-center gap-1">
                  <Eye className="w-3 h-3" /> Opacity
                </label>
                <div className="flex items-center gap-1">
                  <KeyframeButton
                    clipId={selectedClip?.id}
                    property="opacity"
                    clip={selectedClip}
                    playheadPosition={playheadPosition}
                  />
                  <span className="text-[10px] text-sf-text-secondary">{Math.round(animatedTransform?.opacity ?? transform.opacity)}%</span>
                </div>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={animatedTransform?.opacity ?? transform.opacity}
                onChange={(e) => handleTransformChange('opacity', parseInt(e.target.value))}
                onMouseUp={(e) => handleTransformCommit('opacity', parseInt(e.target.value))}
                onDoubleClick={() => handleSliderReset('opacity', 100)}
                title="Double-click to reset to 100%"
                className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
              />
            </div>

            {/* Blend Mode */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1">
                Blend Mode
              </label>
              <select
                value={transform.blendMode ?? 'normal'}
                onChange={(e) => {
                  handleTransformChange('blendMode', e.target.value)
                  handleTransformCommit('blendMode', e.target.value)
                }}
                className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
              >
                {BLEND_MODES.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {renderCompositingSection()}

        {renderStandardClipAdjustmentsSection()}

        {/* Timing Section */}
        {renderSectionHeader('timing', 'Timing', Clock, {
          actions: renderInspectorClipboardButtons({
            scope: INSPECTOR_SETTINGS_SCOPE.TIMING,
          }),
        })}
        {expandedSections.includes('timing') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Start Time</label>
                <div className="flex items-center">
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={selectedClip.startTime?.toFixed(2)}
                    disabled
                    className="w-full bg-sf-dark-800 border border-sf-dark-700 rounded px-2 py-1 text-xs text-sf-text-muted cursor-not-allowed"
                  />
                  <span className="ml-1 text-[9px] text-sf-text-muted">s</span>
                </div>
              </div>
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Duration</label>
                <div className="flex items-center">
                  <input
                    type="number"
                    step="0.01"
                    min="0.04"
                    value={selectedClip.duration?.toFixed(3)}
                    onChange={(e) => {
                      const parsed = parseFloat(e.target.value)
                      if (Number.isFinite(parsed)) resizeClip(selectedClip.id, parsed)
                    }}
                    className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                  />
                  <span className="ml-1 text-[9px] text-sf-text-muted">s</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </>
    )
  }

  // Render Audio Inspector
  const renderAudioInspector = () => (
    <>
      {renderClipSummaryHeader({
        title: selectedClip?.name || audioData.name || 'Audio Clip',
        subtitle: `${selectedTrack?.name || 'Unknown Track'} • Audio clip`,
        icon: FileAudio,
        iconToneClassName: 'text-fuchsia-100',
        iconBgClassName: 'bg-fuchsia-500/20',
        badges: [
          {
            label: 'type',
            value: 'AUDIO',
            className: 'bg-fuchsia-500/15 text-fuchsia-300',
          },
          {
            label: 'timeline-fps',
            value: `${timecodeFps} FPS`,
          },
        ],
      })}

      {/* Gain */}
      <div className="p-3 space-y-3 border-b border-sf-dark-700">
        <div className="flex items-end justify-between gap-3">
          <div>
            <label className="text-[10px] text-sf-text-muted">Gain</label>
            <p className="mt-1 text-[10px] text-sf-text-secondary">
              Boost or trim this clip for preview playback and export.
            </p>
          </div>
          <div className="w-24">
            <input
              type="number"
              min={MIN_AUDIO_CLIP_GAIN_DB}
              max={MAX_AUDIO_CLIP_GAIN_DB}
              step="0.5"
              value={audioData.gainDb}
              onChange={(e) => handleAudioGainChange(e.target.value)}
              className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-right text-sf-text-primary focus:outline-none focus:border-sf-accent"
            />
          </div>
        </div>
        <div>
          <div className="flex justify-between mb-1">
            <span className="text-[10px] text-sf-text-muted">Clip Gain</span>
            <span className="text-[10px] text-sf-text-secondary">
              {audioData.gainDb > 0 ? '+' : ''}{audioData.gainDb.toFixed(1)} dB
            </span>
          </div>
          <input
            type="range"
            min={MIN_AUDIO_CLIP_GAIN_DB}
            max={MAX_AUDIO_CLIP_GAIN_DB}
            step="0.5"
            value={audioData.gainDb}
            onChange={(e) => handleAudioGainChange(e.target.value)}
            className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
          />
          <div className="mt-1 flex justify-between text-[10px] text-sf-text-muted">
            <span>{MIN_AUDIO_CLIP_GAIN_DB} dB</span>
            <span>0 dB</span>
            <span>+{MAX_AUDIO_CLIP_GAIN_DB} dB</span>
          </div>
        </div>
      </div>

      {/* Fades */}
      <div className="p-3 space-y-3 border-b border-sf-dark-700">
        <h4 className="text-[10px] text-sf-text-muted uppercase tracking-wider">Fades</h4>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-sf-text-muted block mb-1">Fade In</label>
            <div className="flex items-center">
              <input
                type="number"
                step="0.1"
                min="0"
                value={audioData.fadeIn}
                onChange={(e) => {
                  const value = Math.max(0, parseFloat(e.target.value) || 0)
                  setAudioData({ ...audioData, fadeIn: value })
                  if (selectedClip) {
                    updateAudioClipProperties(selectedClip.id, { fadeIn: value }, true)
                  }
                }}
                className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
              />
              <span className="ml-1 text-[10px] text-sf-text-muted">s</span>
            </div>
          </div>
          <div>
            <label className="text-[10px] text-sf-text-muted block mb-1">Fade Out</label>
            <div className="flex items-center">
              <input
                type="number"
                step="0.1"
                min="0"
                value={audioData.fadeOut}
                onChange={(e) => {
                  const value = Math.max(0, parseFloat(e.target.value) || 0)
                  setAudioData({ ...audioData, fadeOut: value })
                  if (selectedClip) {
                    updateAudioClipProperties(selectedClip.id, { fadeOut: value }, true)
                  }
                }}
                className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
              />
              <span className="ml-1 text-[10px] text-sf-text-muted">s</span>
            </div>
          </div>
        </div>
      </div>
    </>
  )

  // Get current preview from assets store (assets, getAssetById, getAllMasks already destructured above)
  const { currentPreview, previewMode } = useAssetsStore()
  const isCurrentPreviewLetterbox = currentPreview?.settings?.overlayKind === 'letterbox'
  const resolvedLetterboxAspect = useMemo(
    () => resolveLetterboxAspect(letterboxAspectPreset, letterboxCustomAspect, DEFAULT_LETTERBOX_ASPECT),
    [letterboxAspectPreset, letterboxCustomAspect]
  )
  const hasValidLetterboxAspect = Number.isFinite(resolvedLetterboxAspect) && resolvedLetterboxAspect > 0
  const letterboxPreviewDimensions = useMemo(() => {
    if (!isCurrentPreviewLetterbox) return { width: 1920, height: 1080 }
    const width = Math.max(1, Math.round(Number(currentPreview?.settings?.width ?? currentPreview?.width ?? 1920) || 1920))
    const height = Math.max(1, Math.round(Number(currentPreview?.settings?.height ?? currentPreview?.height ?? 1080) || 1080))
    return { width, height }
  }, [isCurrentPreviewLetterbox, currentPreview?.settings?.width, currentPreview?.settings?.height, currentPreview?.width, currentPreview?.height])
  const letterboxPreviewBars = useMemo(() => {
    if (!hasValidLetterboxAspect) return null
    const rect = getLetterboxContentRect(
      letterboxPreviewDimensions.width,
      letterboxPreviewDimensions.height,
      resolvedLetterboxAspect
    )
    return {
      topPct: (rect.offsetY / letterboxPreviewDimensions.height) * 100,
      bottomPct: ((letterboxPreviewDimensions.height - (rect.offsetY + rect.height)) / letterboxPreviewDimensions.height) * 100,
      leftPct: (rect.offsetX / letterboxPreviewDimensions.width) * 100,
      rightPct: ((letterboxPreviewDimensions.width - (rect.offsetX + rect.width)) / letterboxPreviewDimensions.width) * 100,
    }
  }, [letterboxPreviewDimensions.width, letterboxPreviewDimensions.height, resolvedLetterboxAspect, hasValidLetterboxAspect])

  useEffect(() => {
    if (!isCurrentPreviewLetterbox) return
    const settings = currentPreview?.settings || {}
    const targetAspect = resolveLetterboxAspect(
      String(settings.aspectPreset || settings.targetAspect || DEFAULT_LETTERBOX_ASPECT),
      settings.customAspect,
      DEFAULT_LETTERBOX_ASPECT
    )
    const explicitPreset = String(settings.aspectPreset || '')
    const knownPreset = LETTERBOX_ASPECT_PRESETS.find((preset) => preset.id === explicitPreset)
    const approxPreset = LETTERBOX_ASPECT_PRESETS.find(
      (preset) => preset.value != null && Math.abs(Number(preset.value) - Number(targetAspect)) < 0.005
    )
    const nextPreset = knownPreset
      ? knownPreset.id
      : (approxPreset?.id || 'custom')

    setLetterboxAspectPreset(nextPreset)
    setLetterboxCustomAspect(String(settings.customAspect || targetAspect.toFixed(2)))
    setLetterboxBarColor(settings.barColor || '#000000')
    setLetterboxUpdateError(null)
  }, [
    isCurrentPreviewLetterbox,
    currentPreview?.id,
    currentPreview?.settings?.targetAspect,
    currentPreview?.settings?.aspectPreset,
    currentPreview?.settings?.customAspect,
    currentPreview?.settings?.barColor,
  ])

  const handleApplyLetterboxOverlay = useCallback(async () => {
    if (!currentPreview || currentPreview.settings?.overlayKind !== 'letterbox') return
    if (!hasValidLetterboxAspect) {
      setLetterboxUpdateError('Enter a valid aspect ratio greater than 0.')
      return
    }

    const width = letterboxPreviewDimensions.width
    const height = letterboxPreviewDimensions.height
    const nextSettings = {
      ...(currentPreview.settings || {}),
      width,
      height,
      overlayKind: 'letterbox',
      targetAspect: resolvedLetterboxAspect,
      aspectPreset: letterboxAspectPreset,
      customAspect: letterboxAspectPreset === 'custom' ? letterboxCustomAspect : null,
      barColor: letterboxBarColor,
    }

    setLetterboxUpdateError(null)
    setIsUpdatingLetterbox(true)
    try {
      const blob = await generateLetterboxOverlayBlob(width, height, resolvedLetterboxAspect, letterboxBarColor)
      if (isElectron() && typeof currentProjectHandle === 'string' && currentProjectHandle) {
        const persisted = await writeGeneratedOverlayToProject(
          currentProjectHandle,
          blob,
          currentPreview.name || `Letterbox ${resolvedLetterboxAspect.toFixed(2)}:1`,
          'image',
          nextSettings
        )
        updateAsset(currentPreview.id, {
          ...persisted,
          settings: nextSettings,
          width,
          height,
          type: 'image',
        })
      } else {
        const url = URL.createObjectURL(blob)
        updateAsset(currentPreview.id, {
          url,
          mimeType: 'image/png',
          size: blob.size,
          isImported: false,
          path: null,
          absolutePath: null,
          settings: nextSettings,
          width,
          height,
          type: 'image',
        })
      }
    } catch (err) {
      setLetterboxUpdateError(err?.message || 'Could not update letterbox overlay.')
    } finally {
      setIsUpdatingLetterbox(false)
    }
  }, [
    currentPreview,
    hasValidLetterboxAspect,
    letterboxPreviewDimensions.width,
    letterboxPreviewDimensions.height,
    resolvedLetterboxAspect,
    letterboxAspectPreset,
    letterboxCustomAspect,
    letterboxBarColor,
    currentProjectHandle,
    updateAsset,
  ])
  
  // Get available mask assets for the effect picker
  const availableMasks = useMemo(() => {
    return assets.filter(a => a.type === 'mask')
  }, [assets])
  
  // Format file size
  const formatFileSize = (bytes) => {
    if (!bytes) return 'Unknown'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }
  
  // Format duration
  const formatDuration = (seconds) => {
    if (!seconds && seconds !== 0) return 'Unknown'
    const mins = Math.floor(seconds / 60)
    const secs = (seconds % 60).toFixed(2)
    return mins > 0 ? `${mins}m ${parseFloat(secs).toFixed(1)}s` : `${parseFloat(secs).toFixed(2)}s`
  }

  function renderClipSummaryHeader({
    title,
    subtitle,
    icon: Icon,
    iconToneClassName = 'text-sf-text-primary',
    iconBgClassName = 'bg-sf-dark-700',
    badges = [],
    actions = null,
  }) {
    if (!selectedClip) return null

    const clipStart = Number(selectedClip.startTime) || 0
    const clipDuration = Math.max(0, Number(selectedClip.duration) || 0)
    const clipEnd = clipStart + clipDuration

    const sourceDuration = Number(selectedAsset?.settings?.duration ?? selectedAsset?.duration)
    const clipSourceFps = Number(selectedAsset?.settings?.fps ?? selectedAsset?.fps)
    const sourceTimecodeFps = Math.max(1, Math.round(clipSourceFps || timecodeFps || FRAME_RATE))
    const rawTimeScale = Number(selectedClip?.sourceTimeScale)
    const speed = Number(selectedClip?.speed)
    const effectiveTimeScale = (Number.isFinite(rawTimeScale) && rawTimeScale > 0 ? rawTimeScale : 1)
      * (Number.isFinite(speed) && speed > 0 ? speed : 1)
    const sourceIn = Number.isFinite(Number(selectedClip?.trimStart))
      ? Number(selectedClip.trimStart)
      : null
    const sourceOut = Number.isFinite(Number(selectedClip?.trimEnd))
      ? Number(selectedClip.trimEnd)
      : (sourceIn !== null
          ? sourceIn + clipDuration * effectiveTimeScale
          : (Number.isFinite(sourceDuration) ? sourceDuration : null))

    const assetWidth = getAssetInspectorWidth(selectedAsset)
    const assetHeight = getAssetInspectorHeight(selectedAsset)
    const assetFps = selectedAsset?.settings?.fps ?? selectedAsset?.fps
    const assetSize = getAssetInspectorSize(selectedAsset)
    const videoCodec = selectedAsset?.videoCodec || null
    const audioCodec = selectedAsset?.audioCodec || null
    const formatLabel = formatAssetFormatLabel(selectedAsset)

    const infoItems = [
      { label: 'Start', value: formatInspectorTimecode(clipStart, timecodeFps) },
      { label: 'Duration', value: formatInspectorTimecode(clipDuration, timecodeFps) },
      { label: 'End', value: formatInspectorTimecode(clipEnd, timecodeFps) },
    ]

    if ((selectedClip.type === 'video' || selectedClip.type === 'audio') && sourceIn !== null) {
      infoItems.push({ label: 'Source In', value: formatInspectorTimecode(sourceIn, sourceTimecodeFps) })
    }
    if ((selectedClip.type === 'video' || selectedClip.type === 'audio') && sourceOut !== null) {
      infoItems.push({ label: 'Source Out', value: formatInspectorTimecode(sourceOut, sourceTimecodeFps) })
    }
    if (assetWidth || assetHeight) {
      infoItems.push({ label: 'Resolution', value: formatInspectorResolution(assetWidth, assetHeight) })
    }
    if (Number.isFinite(Number(assetFps)) && Number(assetFps) > 0) {
      infoItems.push({ label: 'FPS', value: `${formatInspectorFrameRate(assetFps)} fps` })
    }
    if (selectedClip.type === 'video' && videoCodec) {
      infoItems.push({ label: 'Codec', value: formatMediaCodecLabel(videoCodec) })
    }
    if (selectedClip.type === 'video' && audioCodec) {
      infoItems.push({ label: 'Audio Codec', value: formatMediaCodecLabel(audioCodec) })
    }
    if (selectedClip.type === 'audio' && audioCodec) {
      infoItems.push({ label: 'Codec', value: formatMediaCodecLabel(audioCodec) })
    }
    if (selectedAsset) {
      infoItems.push({ label: 'Format', value: formatLabel })
    }
    if (assetSize) {
      infoItems.push({ label: 'Size', value: formatFileSize(assetSize) })
    }

    return (
      <>
        {renderSectionHeader('clipInfo', 'Clip Info', Info)}
        {expandedSections.includes('clipInfo') && (
          <div className="p-3 border-b border-sf-dark-700 space-y-3">
            <div className="flex items-start gap-3">
              <div className={`w-10 h-10 rounded-lg ${iconBgClassName} flex items-center justify-center flex-shrink-0`}>
                <Icon className={`w-5 h-5 ${iconToneClassName}`} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-sf-text-primary truncate" title={title}>
                  {title}
                </p>
                <p className="text-[10px] text-sf-text-muted truncate">
                  {subtitle}
                </p>
              </div>
              {badges.length > 0 && (
                <div className="flex flex-wrap justify-end gap-1 max-w-[45%]">
                  {badges.map((badge) => (
                    <span
                      key={`${badge.label}-${badge.value}`}
                      className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium ${badge.className || 'bg-sf-dark-700 text-sf-text-secondary'}`}
                    >
                      {badge.value}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              {infoItems.map((item) => (
                <div key={`${item.label}-${item.value}`} className="rounded border border-sf-dark-700 bg-sf-dark-900/70 px-2 py-1.5 min-w-0">
                  <div className="text-[9px] uppercase tracking-wider text-sf-text-muted">{item.label}</div>
                  <div className="mt-0.5 truncate text-[11px] font-medium text-sf-text-primary" title={item.value}>
                    {item.value}
                  </div>
                </div>
              ))}
            </div>

            {actions && (
              <div className="space-y-2">
                {actions}
              </div>
            )}
          </div>
        )}
      </>
    )
  }
  
  // Format date
  const formatDate = (isoString) => {
    if (!isoString) return 'Unknown'
    const date = new Date(isoString)
    return date.toLocaleDateString(undefined, { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }
  
  // Get file extension
  const getFileExtension = (filename) => {
    return getFileExtensionLabel(filename)
  }
  
  // Render Asset Info Panel
  const renderAssetInfo = () => {
    if (!currentPreview) return null
    
    const asset = currentPreview
    const isVideo = asset.type === 'video'
    const isImage = asset.type === 'image'
    const isAudio = asset.type === 'audio'
    
    // Get icon based on type
    const TypeIcon = isVideo ? FileVideo : isImage ? FileImage : FileAudio
    const typeColor = isVideo ? 'text-blue-400' : isImage ? 'text-green-400' : 'text-purple-400'
    const typeBgColor = isVideo ? 'bg-blue-500' : isImage ? 'bg-green-500' : 'bg-purple-500'
    
    return (
      <>
        {/* Asset Info Header */}
        <div className="p-3 border-b border-sf-dark-700">
          <div className="flex items-center gap-2 mb-3">
            <div className={`w-10 h-10 ${typeBgColor} rounded flex items-center justify-center flex-shrink-0`}>
              <TypeIcon className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-sf-text-primary truncate" title={asset.name}>
                {asset.name}
              </p>
              <p className="text-[10px] text-sf-text-muted">
                {asset.isImported ? 'Imported' : 'AI Generated'} • {asset.type?.charAt(0).toUpperCase() + asset.type?.slice(1)}
              </p>
            </div>
          </div>
          
          {/* Badge */}
          <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium ${
            asset.isImported ? 'bg-sf-dark-700 text-sf-text-secondary' : 'bg-sf-accent/20 text-sf-accent'
          }`}>
            {asset.isImported ? 'IMPORTED' : 'AI GENERATED'}
          </div>
        </div>

        {/* File Details Section */}
        <div className="p-3 border-b border-sf-dark-700">
          <h4 className="text-[10px] text-sf-text-muted uppercase tracking-wider mb-3 flex items-center gap-1">
            <Info className="w-3 h-3" />
            File Details
          </h4>
          
          <div className="space-y-2.5">
            {/* File Type */}
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-sf-text-muted">Type</span>
              <span className={`text-[11px] font-medium ${typeColor}`}>
                {asset.type?.toUpperCase() || 'Unknown'}
              </span>
            </div>
            
            {/* Format/Extension */}
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-sf-text-muted">Format</span>
              <span className="text-[11px] text-sf-text-primary">
                {asset.mimeType?.split('/')[1]?.toUpperCase() || getFileExtension(asset.name)}
              </span>
            </div>
            
            {/* File Size */}
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-sf-text-muted flex items-center gap-1">
                <HardDrive className="w-3 h-3" />
                Size
              </span>
              <span className="text-[11px] text-sf-text-primary">
                {formatFileSize(asset.size)}
              </span>
            </div>
            
            {/* Duration (video/audio only) */}
            {(isVideo || isAudio) && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-sf-text-muted flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  Duration
                </span>
                <span className="text-[11px] text-sf-text-primary">
                  {formatDuration(asset.settings?.duration || asset.duration)}
                </span>
              </div>
            )}
            
            {/* Resolution (video/image only) */}
            {(isVideo || isImage) && (asset.settings?.width || asset.width) && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-sf-text-muted flex items-center gap-1">
                  <Maximize2 className="w-3 h-3" />
                  Resolution
                </span>
                <span className="text-[11px] text-sf-text-primary">
                  {asset.settings?.width || asset.width}×{asset.settings?.height || asset.height}
                </span>
              </div>
            )}
            
            {/* Frame Rate (video only) */}
            {isVideo && (asset.settings?.fps || asset.fps) && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-sf-text-muted">Frame Rate</span>
                <span className="text-[11px] text-sf-text-primary">
                  {formatInspectorFrameRate(asset.settings?.fps || asset.fps)} fps
                </span>
              </div>
            )}

            {isVideo && asset.videoCodec && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-sf-text-muted">Video Codec</span>
                <span className="text-[11px] text-sf-text-primary">
                  {formatMediaCodecLabel(asset.videoCodec)}
                </span>
              </div>
            )}

            {(isVideo || isAudio) && asset.audioCodec && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-sf-text-muted">{isAudio ? 'Codec' : 'Audio Codec'}</span>
                <span className="text-[11px] text-sf-text-primary">
                  {formatMediaCodecLabel(asset.audioCodec)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Letterbox Overlay Controls */}
        {asset.settings?.overlayKind === 'letterbox' && (
          <div className="p-3 border-b border-sf-dark-700 space-y-3">
            <h4 className="text-[10px] text-sf-text-muted uppercase tracking-wider mb-1">Letterbox Overlay</h4>
            <p className="text-[11px] text-sf-text-muted">
              Update ratio and bar color, then re-generate this overlay.
            </p>

            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1">Aspect ratio</label>
              <select
                value={letterboxAspectPreset}
                onChange={(e) => setLetterboxAspectPreset(e.target.value)}
                className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
              >
                {LETTERBOX_ASPECT_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.label}</option>
                ))}
              </select>
            </div>

            {letterboxAspectPreset === 'custom' && (
              <div>
                <label className="text-[10px] text-sf-text-muted block mb-1">Custom ratio (W:H)</label>
                <input
                  type="number"
                  min={0.1}
                  max={10}
                  step={0.01}
                  value={letterboxCustomAspect}
                  onChange={(e) => setLetterboxCustomAspect(e.target.value)}
                  className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                />
              </div>
            )}

            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1">Bar color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={letterboxBarColor}
                  onChange={(e) => setLetterboxBarColor(e.target.value)}
                  className="w-10 h-8 rounded border border-sf-dark-600 cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={letterboxBarColor}
                  onChange={(e) => setLetterboxBarColor(e.target.value)}
                  className="flex-1 bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary font-mono focus:outline-none focus:border-sf-accent"
                />
              </div>
            </div>

            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1">Preview</label>
              <div
                className="relative w-full rounded border border-sf-dark-600 overflow-hidden bg-sf-dark-900"
                style={{ aspectRatio: `${letterboxPreviewDimensions.width} / ${letterboxPreviewDimensions.height}` }}
              >
                <div className="absolute inset-0 bg-gradient-to-br from-sf-accent/30 via-sf-dark-700 to-purple-500/25" />
                {letterboxPreviewBars && (
                  <>
                    {letterboxPreviewBars.topPct > 0.001 && (
                      <div className="absolute left-0 right-0 top-0" style={{ height: `${letterboxPreviewBars.topPct}%`, backgroundColor: letterboxBarColor }} />
                    )}
                    {letterboxPreviewBars.bottomPct > 0.001 && (
                      <div className="absolute left-0 right-0 bottom-0" style={{ height: `${letterboxPreviewBars.bottomPct}%`, backgroundColor: letterboxBarColor }} />
                    )}
                    {letterboxPreviewBars.leftPct > 0.001 && (
                      <div className="absolute top-0 bottom-0 left-0" style={{ width: `${letterboxPreviewBars.leftPct}%`, backgroundColor: letterboxBarColor }} />
                    )}
                    {letterboxPreviewBars.rightPct > 0.001 && (
                      <div className="absolute top-0 bottom-0 right-0" style={{ width: `${letterboxPreviewBars.rightPct}%`, backgroundColor: letterboxBarColor }} />
                    )}
                  </>
                )}
                <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/60 text-[10px] text-white">
                  {hasValidLetterboxAspect ? `${resolvedLetterboxAspect.toFixed(2)}:1` : 'Invalid ratio'}
                </div>
              </div>
            </div>

            {letterboxUpdateError && (
              <p className="text-[11px] text-sf-error">{letterboxUpdateError}</p>
            )}

            <button
              type="button"
              onClick={() => { void handleApplyLetterboxOverlay() }}
              disabled={isUpdatingLetterbox || !hasValidLetterboxAspect}
              className="w-full px-3 py-1.5 text-xs text-white rounded bg-sf-accent hover:bg-sf-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isUpdatingLetterbox ? 'Updating overlay…' : 'Update Letterbox Overlay'}
            </button>
          </div>
        )}
        
        {/* Metadata Section */}
        <div className="p-3 border-b border-sf-dark-700">
          <h4 className="text-[10px] text-sf-text-muted uppercase tracking-wider mb-3 flex items-center gap-1">
            <Calendar className="w-3 h-3" />
            Metadata
          </h4>
          
          <div className="space-y-2.5">
            {/* Created Date */}
            <div className="flex items-start justify-between">
              <span className="text-[11px] text-sf-text-muted">Created</span>
              <span className="text-[11px] text-sf-text-primary text-right">
                {formatDate(asset.createdAt)}
              </span>
            </div>
            
            {/* Imported Date (if imported) */}
            {asset.imported && (
              <div className="flex items-start justify-between">
                <span className="text-[11px] text-sf-text-muted">Imported</span>
                <span className="text-[11px] text-sf-text-primary text-right">
                  {formatDate(asset.imported)}
                </span>
              </div>
            )}
            
            {/* File Path (if imported) */}
            {asset.path && (
              <div>
                <span className="text-[11px] text-sf-text-muted block mb-1">Path</span>
                <span className="text-[10px] text-sf-text-secondary block break-all bg-sf-dark-800 rounded px-2 py-1">
                  {asset.path}
                </span>
              </div>
            )}
          </div>
        </div>
        
        {/* AI Generation Info (if AI-generated) */}
        {!asset.isImported && asset.prompt && (
          <div className="p-3 border-b border-sf-dark-700">
            <h4 className="text-[10px] text-sf-text-muted uppercase tracking-wider mb-3 flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              Generation Details
            </h4>
            
            <div className="space-y-2.5">
              {/* Prompt */}
              <div>
                <span className="text-[11px] text-sf-text-muted block mb-1">Prompt</span>
                <p className="text-[11px] text-sf-text-primary bg-sf-dark-800 rounded px-2 py-1.5 leading-relaxed">
                  {asset.prompt}
                </p>
              </div>
              
              {/* Negative Prompt */}
              {asset.negativePrompt && (
                <div>
                  <span className="text-[11px] text-sf-text-muted block mb-1">Negative Prompt</span>
                  <p className="text-[10px] text-sf-text-secondary bg-sf-dark-800 rounded px-2 py-1.5">
                    {asset.negativePrompt}
                  </p>
                </div>
              )}
              
              {/* Seed */}
              {asset.seed !== undefined && (
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-sf-text-muted">Seed</span>
                  <span className="text-[11px] text-sf-text-primary font-mono">
                    {asset.seed}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </>
    )
  }
  
  // Resolve-style transition inspector
  const renderTransitionInspector = () => {
    if (!selectedTransition) return null

    const transitionMeta = TRANSITION_TYPES.find(t => t.id === selectedTransition.type)
    const alignment = selectedTransition?.settings?.alignment || 'center'
    const durationFrames = Math.max(1, Math.round((selectedTransition.duration || 0.5) * FRAME_RATE))
    const maxDurationSeconds = selectedTransition.kind === 'between'
      ? getMaxTransitionDurationForAlignment(
          selectedTransition.clipAId,
          selectedTransition.clipBId,
          alignment,
          selectedTransition.id
        )
      : getMaxEdgeTransitionDuration(selectedTransition.clipId)
    const maxFrames = Math.max(1, Math.floor((maxDurationSeconds || selectedTransition.duration || 0.5) * FRAME_RATE))
    const settings = selectedTransition.settings || {}
    const supportsZoom = ['zoom-in', 'zoom-out', 'cross-zoom'].includes(selectedTransition.type)
    const supportsBlur = ['blur', 'cross-zoom', 'whip-left', 'whip-right'].includes(selectedTransition.type)
    const supportsColor = ['flash', 'dip-color'].includes(selectedTransition.type)
    const isCrossZoom = selectedTransition.type === 'cross-zoom'
    const isWhip = selectedTransition.type === 'whip-left' || selectedTransition.type === 'whip-right'
    const zoomDefault = isCrossZoom ? 0.4 : 0.1
    const zoomMax = isCrossZoom ? 1 : 0.3
    const blurDefault = isWhip ? 16 : (isCrossZoom ? 12 : 8)
    const blurMax = (isWhip || isCrossZoom) ? 40 : 20
    const colorDefault = selectedTransition.type === 'dip-color' ? '#000000' : '#FFFFFF'
    const transitionKindLabel = selectedTransition.kind === 'between'
      ? 'Between Clips'
      : `Edge (${selectedTransition.edge === 'in' ? 'In' : 'Out'})`

    const handleTypeChange = (nextType) => {
      updateTransition(selectedTransition.id, {
        type: nextType,
        settings: TRANSITION_DEFAULT_SETTINGS[nextType] || {},
      })
    }

    const handleDurationFramesChange = (nextFrames) => {
      const frames = Math.max(1, Math.min(maxFrames, Number(nextFrames) || 1))
      updateTransition(selectedTransition.id, { duration: frames / FRAME_RATE })
    }

    const handleSettingChange = (key, value) => {
      updateTransition(selectedTransition.id, { settings: { [key]: value } })
    }

    const handleSetDefaultDuration = () => {
      try {
        localStorage.setItem(TRANSITION_DEFAULT_DURATION_KEY, String(durationFrames))
        window.dispatchEvent(new CustomEvent('comfystudio-transition-default-duration-changed', { detail: durationFrames }))
      } catch (_) {}
    }

    return (
      <div className="p-3 space-y-3">
        <div className="bg-sf-dark-800 border border-sf-dark-600 rounded-lg p-3">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-medium text-sf-text-primary">
              Transition - {transitionMeta?.name || selectedTransition.type}
            </h3>
            <span className="text-[10px] px-2 py-0.5 rounded bg-sf-dark-700 text-sf-text-muted">
              {transitionKindLabel}
            </span>
          </div>
          <p className="text-[11px] text-sf-text-muted">
            Select the transition segment on the timeline to edit its settings.
          </p>
        </div>

        <div className="bg-sf-dark-800 border border-sf-dark-600 rounded-lg p-3 space-y-3">
          <div>
            <label className="block text-[11px] text-sf-text-muted mb-1">Transition Type</label>
            <select
              value={selectedTransition.type}
              onChange={(e) => handleTypeChange(e.target.value)}
              className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
            >
              {TRANSITION_TYPES.map(type => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="block text-[11px] text-sf-text-muted">Duration</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={maxFrames}
                value={durationFrames}
                onChange={(e) => handleDurationFramesChange(e.target.value)}
                className="w-20 bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
              />
              <span className="text-xs text-sf-text-secondary">frames</span>
              <span className="text-xs text-sf-text-muted">
                {(durationFrames / FRAME_RATE).toFixed(2)}s
              </span>
            </div>
            <div className="text-[10px] text-sf-text-muted">
              Max available: {maxFrames}f
            </div>
            <button
              onClick={handleSetDefaultDuration}
              className="mt-1 w-full px-2 py-1 rounded border border-sf-dark-600 bg-sf-dark-700 hover:bg-sf-dark-600 text-[10px] text-sf-text-secondary transition-colors"
            >
              Set as Default Duration
            </button>
          </div>

          {selectedTransition.kind === 'between' && (
            <div>
              <label className="block text-[11px] text-sf-text-muted mb-1">Alignment</label>
              <div className="grid grid-cols-3 gap-1">
                <button
                  onClick={() => setTransitionAlignment(selectedTransition.id, 'start')}
                  className={`px-2 py-1 rounded text-[10px] transition-colors ${
                    alignment === 'start'
                      ? 'bg-sf-accent/20 text-sf-accent border border-sf-accent/30'
                      : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                  }`}
                >
                  Start
                </button>
                <button
                  onClick={() => setTransitionAlignment(selectedTransition.id, 'center')}
                  className={`px-2 py-1 rounded text-[10px] transition-colors ${
                    alignment === 'center'
                      ? 'bg-sf-accent/20 text-sf-accent border border-sf-accent/30'
                      : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                  }`}
                >
                  Center
                </button>
                <button
                  onClick={() => setTransitionAlignment(selectedTransition.id, 'end')}
                  className={`px-2 py-1 rounded text-[10px] transition-colors ${
                    alignment === 'end'
                      ? 'bg-sf-accent/20 text-sf-accent border border-sf-accent/30'
                      : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                  }`}
                >
                  End
                </button>
              </div>
            </div>
          )}

          {supportsZoom && (
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-sf-text-muted w-24">Zoom Amount</label>
              <input
                type="range"
                min={0.02}
                max={zoomMax}
                step={0.01}
                value={settings.zoomAmount ?? zoomDefault}
                onChange={(e) => handleSettingChange('zoomAmount', Number(e.target.value))}
                className="flex-1"
              />
              <span className="text-[10px] text-sf-text-muted w-10 text-right">
                {(settings.zoomAmount ?? zoomDefault).toFixed(2)}
              </span>
            </div>
          )}

          {supportsBlur && (
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-sf-text-muted w-24">Blur Amount</label>
              <input
                type="range"
                min={0}
                max={blurMax}
                step={1}
                value={settings.blurAmount ?? blurDefault}
                onChange={(e) => handleSettingChange('blurAmount', Number(e.target.value))}
                className="flex-1"
              />
              <span className="text-[10px] text-sf-text-muted w-10 text-right">
                {Math.round(settings.blurAmount ?? blurDefault)}px
              </span>
            </div>
          )}

          {supportsColor && (
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-sf-text-muted w-24">Color</label>
              <input
                type="color"
                value={settings.color || colorDefault}
                onChange={(e) => handleSettingChange('color', e.target.value)}
                className="h-7 w-10 bg-sf-dark-700 border border-sf-dark-600 rounded cursor-pointer p-0.5"
              />
              <span className="text-[10px] text-sf-text-muted font-mono uppercase">
                {settings.color || colorDefault}
              </span>
            </div>
          )}
        </div>

        <button
          onClick={() => removeTransition(selectedTransition.id)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-sf-error/20 border border-sf-error/30 hover:bg-sf-error/30 text-sf-error rounded text-xs transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Remove Transition
        </button>
      </div>
    )
  }

  // Empty state
  const renderEmptyState = () => {
    // If an asset is being previewed, show its info instead
    if (currentPreview && previewMode === 'asset') {
      return renderAssetInfo()
    }
    
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-4">
        <Layers className="w-10 h-10 text-sf-dark-600 mb-3" />
        <h3 className="text-sm font-medium text-sf-text-primary mb-1">No Selection</h3>
        <p className="text-xs text-sf-text-muted">
          Select a clip or transition on the timeline to edit its properties
        </p>
      </div>
    )
  }

  // Multi-selection info
  const renderMultiSelectInfo = () => (
    <div className="h-full flex flex-col items-center justify-center text-center p-4">
      <Layers className="w-10 h-10 text-sf-accent mb-3" />
      <h3 className="text-sm font-medium text-sf-text-primary mb-1">
        {selectedClipIds.length} Clips Selected
      </h3>
      <p className="text-xs text-sf-text-muted">
        Select a single clip to edit its transform properties
      </p>
    </div>
  )

  const renderLinkedPairInspectorSelector = () => {
    if (!linkedInspectorPair) return null

    const options = [
      {
        id: linkedInspectorPair.visualClip.id,
        label: 'Video',
        icon: FileVideo,
      },
      {
        id: linkedInspectorPair.audioClip.id,
        label: 'Audio',
        icon: FileAudio,
      },
    ]

    return (
      <div className="px-3 py-2 border-b border-sf-dark-700 bg-sf-dark-900/70">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-sf-text-muted">
              <Link className="w-3 h-3" />
              <span>Linked Pair</span>
            </div>
            <p className="mt-1 text-[10px] text-sf-text-secondary">
              Both clips stay selected. Choose which side of the pair to inspect.
            </p>
          </div>
          <div className="inline-flex rounded-md border border-sf-dark-600 bg-sf-dark-800 p-0.5 shrink-0">
            {options.map(({ id, label, icon: Icon }) => {
              const isActive = selectedClip?.id === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setInspectorClipId(id)}
                  className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[10px] font-medium transition-colors ${
                    isActive
                      ? 'bg-sf-accent text-white'
                      : 'text-sf-text-secondary hover:bg-sf-dark-700 hover:text-sf-text-primary'
                  }`}
                >
                  <Icon className="w-3 h-3" />
                  <span>{label}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  const renderSelectedClipInspector = () => {
    if (isAdjustmentClip) return renderAdjustmentClipInspector()
    if (isTextClip) return renderTextClipInspector()
    if (isVideoClip) return renderVideoClipInspector()
    if (isAudioClip) return renderAudioInspector()
    return renderEmptyState()
  }

  // Content to render
  const renderContent = () => {
    // Transition selection has priority (Resolve-style)
    if (selectedTransition) return renderTransitionInspector()

    // No selection
    if (selectedClipIds.length === 0) return renderEmptyState()
    
    // Multi-selection (show info only)
    if (selectedClipIds.length > 1 && !linkedInspectorPair) return renderMultiSelectInfo()

    return (
      <>
        {renderLinkedPairInspectorSelector()}
        {renderSelectedClipInspector()}
      </>
    )
  }

  return (
    <div className="h-full flex">
      {/* Content Panel - Collapsible (on the left side of icon bar) */}
      {isExpanded && (
        <div className="flex-1 bg-sf-dark-900 border-l border-sf-dark-700 flex flex-col min-w-0 overflow-hidden">
          {/* Panel Header */}
          <div className="flex-shrink-0 h-9 bg-sf-dark-800 border-b border-sf-dark-700 flex items-center justify-between gap-2 px-3">
            <span className="text-xs font-medium text-sf-text-primary">Inspector</span>
            <div className="flex items-center gap-1">
              {renderInspectorSettingsHeaderActions()}
            </div>
          </div>
          
          {/* Panel Content */}
          <div className="flex-1 overflow-y-auto">
            {renderContent()}
          </div>
        </div>
      )}
      
      {/* Icon Toolbar - Always Visible (on the right edge) */}
      <div className="w-12 flex-shrink-0 bg-sf-dark-950 border-l border-sf-dark-700 flex flex-col">
        {/* Inspector Icon */}
        <div className="flex-1 flex flex-col pt-2">
          <button
            onClick={onToggleExpanded}
            className={`w-full h-11 flex items-center justify-center transition-all relative group ${
              isExpanded
                ? 'text-sf-accent bg-sf-dark-800'
                : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800/50'
            }`}
            title="Inspector"
          >
            {/* Active indicator bar (on right side for right panel) */}
            {isExpanded && (
              <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-sf-accent rounded-l" />
            )}
            <SlidersHorizontal className="w-5 h-5" />
            
            {/* Tooltip */}
            <div className="absolute right-full mr-2 px-2 py-1 bg-sf-dark-700 text-sf-text-primary text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity">
              Inspector
            </div>
          </button>
        </div>
        
        {/* Collapse/Expand Button */}
        <div className="border-t border-sf-dark-700">
          <button
            onClick={onToggleExpanded}
            className="w-full h-10 flex items-center justify-center text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800/50 transition-colors"
            title={isExpanded ? 'Collapse panel' : 'Expand panel'}
          >
            {isExpanded ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

export default InspectorPanel
