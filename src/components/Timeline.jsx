import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, memo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Volume2, VolumeX, Lock, Unlock, Link, Unlink, Eye, EyeOff,
  Plus, Video, Type, Image as ImageIcon,
  Sparkles, GripVertical, Magnet, ArrowRightLeft, Square, X, Check, Pencil,
  Diamond, Zap, AlertTriangle, Loader2, ChevronLeft, ChevronRight, Maximize2, Flag, Scissors, Clock,
  Copy, ClipboardPaste, Trash2, Music as MusicIcon, MoreHorizontal, Layers, ArrowLeft,
} from 'lucide-react'
import useTimelineStore, { buildClipSyncLock, isMusicVideoSyncCapableClip, isSyncLockedClip, isCaptionsTrack, isCaptionClip } from '../stores/timelineStore'
import useProjectStore from '../stores/projectStore'
import renderCacheService from '../services/renderCache'
import { isClipRenderable, renderClipToCache } from '../services/clipRenderCache'
import { isFullBakeFresh } from '../utils/clipBakeSignature'
import { deleteRenderCache } from '../services/fileSystem'
import { clearDiskCacheUrl } from './VideoLayerRenderer'
import useAssetsStore from '../stores/assetsStore'
import CaptionWorkspace from './CaptionWorkspace'
import PasteAttributesDialog from './PasteAttributesDialog'
import SmartReplaceDialog, { captureSmartReplaceSession, getSmartReplaceEligibility } from './SmartReplaceDialog'
import CompoundClipDialog, { captureCompoundClipSession, captureUncompoundSession, navigateCompoundContents, UncompoundDialog } from './CompoundClipDialog'
import TrimEdgePreview from './TrimEdgePreview'
import RollEditPreview from './RollEditPreview'
import SlipEditPreview from './SlipEditPreview'
import SlideEditPreview from './SlideEditPreview'
import AudioVolumeEnvelope, { getSingleAudioEnvelopeTarget, resetAudioVolumeEnvelopeEditor } from './AudioVolumeEnvelope'
import { buildTrimPreviewFeedback } from '../utils/trimPreview.mjs'
import { resolveTimelineSelectionViewport } from '../utils/timelineSelectionViewport.mjs'
import { createTimelineScrubScheduler, resolveTimelineScrubSample } from '../utils/timelineScrubScheduler.mjs'
import { canSplitActiveTrackAtPlayhead, getActiveTrackSplitTarget } from '../utils/timelineSplitTarget.mjs'
import { findTransitionCutTarget, isTransitionCutTargetCurrent, isTransitionDrag, parseTransitionDrag } from '../utils/transitionCutTarget.mjs'
import { isFrameStepSeekIntentAtTime } from '../utils/previewVideoSeeking'
import { useSnapping, SNAP_TYPES } from '../hooks/useSnapping'
import useViewportClampedPosition from '../hooks/useViewportClampedPosition'
import { getAllKeyframeTimes } from '../utils/keyframes'
import { TRANSITION_TYPES, TRANSITION_DURATIONS, FRAME_RATE } from '../constants/transitions'
import { getAudioClipFadeValues } from '../utils/audioClipFades'
import { buildAudioClipSplitState } from '../utils/audioClipSplit'
import { buildSplitLeftPieceUpdates, buildSplitRightPieceCarryOver } from '../utils/clipSplit.mjs'
import { nudgeSelectedClips, trimToPlayhead } from '../utils/playheadEdits.mjs'
import {
  createMultiClipTrimSession,
  getMultiClipTrimTargetIds,
  resolveMultiClipTrim,
} from '../utils/multiClipTrim.mjs'
import { getSpriteFramePosition } from '../services/thumbnailSprites'
import { getEffectTypeDefinition } from '../utils/effects'
import { isTextEditingElement } from '../utils/keyboardFocus'
import { hasVisibleKeyboardModal, isNativeTextKeyboardEvent } from '../utils/transportKeyboardGuards.mjs'
import {
  formatSecondsFrames,
  formatTimecode as formatFrameTimecode,
  doSegmentsOverlap,
  getSafeTimelineFps,
  getTimecodeFrameRate,
  quantizeTimeToFrame,
} from '../utils/timelineFrames'
import {
  DEFAULT_EDITOR_HOTKEYS,
  EDITOR_HOTKEYS_CHANGED_EVENT,
  EDITOR_HOTKEY_IDS,
  formatEditorHotkey,
  getEditorHotkeys,
  matchEditorHotkey,
} from '../services/editorHotkeys'
import MasterAudioMeter from './AudioMeter'
import GenerateMusicPopover from './GenerateMusicPopover'
import { analyzeAudioSource } from '../services/audioAnalysis'
import { captureBeatMarkerRequest, isBeatMarkerRequestCurrent, buildDetectedBeatMarkers } from '../utils/beatMarkers.mjs'
import { getClipPlaybackTimeAtTimeline } from '../utils/clipPlaybackTiming'
import { canRevealAssetInFileManager, getRevealInFileManagerLabel, revealAssetInFileManager } from '../utils/revealInFileManager'
import { useI18n } from '../i18n/I18nContext'
import { quoteCssFontFamily } from '../utils/fontFamily'

const TRANSITION_DEFAULT_DURATION_KEY = 'comfystudio-transition-default-duration-frames'
const TRANSITION_TYPE_IDS = TRANSITION_TYPES.map(type => type.id)
const DEFAULT_WAVEFORM_SAMPLES = 8192
const MARQUEE_DRAG_THRESHOLD_PX = 6
const MARQUEE_AUTO_SCROLL_EDGE_PX = 32
const MARQUEE_AUTO_SCROLL_STEP_PX = 24
const PLAYHEAD_SCRUB_AUTO_SCROLL_EDGE_PX = 40
const PLAYHEAD_SCRUB_AUTO_SCROLL_MAX_STEP_PX = 28
const SCRUB_CONTEXT_KEYS = ['timelineSessionId', 'compoundEditContext', 'timelineFps', 'zoom', 'duration',
  'isPlaying', 'playbackRate', 'shuttleMode']
const MIN_INTERACTIVE_CLIP_WIDTH_PX = 24
const TIMELINE_VIDEO_THUMB_WIDTH_PX = 90
const MAX_TIMELINE_VIDEO_THUMBNAILS = 12
const CLIP_LABEL_COLOR_OPTIONS = Object.freeze([
  { label: 'Clear label', color: '' },
  { label: 'Red', color: '#ef4444' },
  { label: 'Orange', color: '#f97316' },
  { label: 'Yellow', color: '#eab308' },
  { label: 'Green', color: '#22c55e' },
  { label: 'Cyan', color: '#06b6d4' },
  { label: 'Blue', color: '#3b82f6' },
  { label: 'Purple', color: '#a855f7' },
  { label: 'Pink', color: '#ec4899' },
])
const getClipLabelColorValue = (clip) => (
  typeof clip?.labelColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(clip.labelColor.trim())
    ? clip.labelColor.trim().toLowerCase()
    : ''
)
const getClipLabelTintOpacity = (clip) => {
  if (!clip) return 0.28
  if (clip.type === 'audio') return 0.34
  if (clip.type === 'text' || clip.type === 'adjustment') return 0.42
  return 0.3
}
const getClipLabelFooterOpacity = (clip) => (clip?.type === 'audio' ? 0.5 : 0.62)

// Resolve-style audio track/waveform colors
const AUDIO_TRACK_BG = '#2d4038'
const AUDIO_WAVEFORM_FILL = 'rgba(196, 208, 202, 0.6)'
const AUDIO_WAVEFORM_CENTER_LINE = 'rgba(255,255,255,0.32)'
const AUDIO_CLIP_ACCENT = '#4a6b5c'
const ADJACENT_CLIP_UI_GAP_SECONDS = 0.5
const ROLL_GESTURE_STATE_KEYS = ['clips', 'tracks', 'transitions', 'markers', 'history', 'historyIndex',
  'timelineSessionId', 'timelineFps', 'selectedClipIds', 'duration', 'isPlaying', 'compoundEditContext',
  'clipCounter', 'transitionCounter', 'markerCounter', 'masterAudioVolume', 'masterAudioInserts', 'zoom']
const captureRollGestureState = state => Object.fromEntries(ROLL_GESTURE_STATE_KEYS.map(key => [key, state[key]]))
const SLIDE_GESTURE_STATE_KEYS = [...ROLL_GESTURE_STATE_KEYS, 'rippleEditMode', 'snappingEnabled', 'snappingThreshold']
const captureSlideGestureState = state => Object.fromEntries(SLIDE_GESTURE_STATE_KEYS.map(key => [key, state[key]]))
const RIPPLE_TRIM_STATE_KEYS = [...ROLL_GESTURE_STATE_KEYS, 'rippleEditMode', 'snappingEnabled', 'snappingThreshold',
  'playheadPosition', 'inPoint', 'outPoint']
const captureRippleTrimState = state => Object.fromEntries(RIPPLE_TRIM_STATE_KEYS.map(key => [key, state[key]]))
const AUDIO_WAVEFORM_CACHE = new Map()
const AUDIO_WAVEFORM_PENDING = new Map()
let audioWaveformContext = null
const TIMELINE_TOOL_STORAGE_KEY = 'comfystudio-timeline-active-tool-v1'
const TIMELINE_TOOLS = Object.freeze({
  AUTO: 'auto',
  SELECT: 'select',
  TRIM: 'trim',
  RAZOR: 'razor',
  SLIP: 'slip',
  SLIDE: 'slide',
})
const TIMELINE_TOOL_LABELS = Object.freeze({
  [TIMELINE_TOOLS.AUTO]: 'Auto tool',
  [TIMELINE_TOOLS.SELECT]: 'Move tool',
  [TIMELINE_TOOLS.TRIM]: 'Trim tool',
  [TIMELINE_TOOLS.RAZOR]: 'Razor tool',
  [TIMELINE_TOOLS.SLIP]: 'Slip tool',
  [TIMELINE_TOOLS.SLIDE]: 'Slide tool',
})
const sanitizeTimelineOffsetInput = (value) => {
  const raw = String(value || '').replace(/\s+/g, '')
  if (!raw) return ''

  const sign = raw[0] === '+' || raw[0] === '-' ? raw[0] : ''
  let body = sign ? raw.slice(1) : raw
  body = body.replace(/[^\d:.]/g, '')

  if (!body) return sign

  if (body.includes(':')) {
    body = body.replace(/\./g, '')
    const parts = body
      .split(':')
      .slice(0, 4)
      .map((part, index) => {
        const digits = part.replace(/\D/g, '')
        return index === 0 ? digits : digits.slice(0, 2)
      })
    return sign + parts.join(':')
  }

  const dotIndex = body.indexOf('.')
  if (dotIndex >= 0) {
    body = `${body.slice(0, dotIndex + 1)}${body.slice(dotIndex + 1).replace(/\./g, '')}`
  }

  return sign + body
}

const sanitizeFrameOffsetInput = (value) => {
  const raw = String(value || '').replace(/\s+/g, '')
  if (!raw) return ''

  const sign = raw[0] === '+' || raw[0] === '-' ? raw[0] : ''
  const digits = (sign ? raw.slice(1) : raw).replace(/\D/g, '')
  return sign + digits
}

const parseTimelineOffsetInput = (value, fps) => {
  const raw = String(value || '').trim()
  if (!raw) {
    return { success: false, error: 'Enter a timecode offset like +00:00:02:12.' }
  }

  const roundedFps = Math.max(1, Math.round(Number(fps) || FRAME_RATE))
  const match = raw.match(/^([+-])?\s*(.+)$/)
  const sign = match?.[1] === '-' ? -1 : 1
  const remainder = (match?.[2] || raw).trim()

  if (/^\d+(?:\.\d+)?$/.test(remainder)) {
    return { success: true, seconds: sign * Number(remainder) }
  }

  const parts = remainder.split(':').map(part => part.trim())
  if (parts.length < 2 || parts.length > 4 || parts.some(part => !/^\d+$/.test(part))) {
    return { success: false, error: 'Use signed timecode like +00:00:02:12 or seconds like -1.5.' }
  }

  const normalized = [...parts]
  while (normalized.length < 4) {
    normalized.unshift('0')
  }

  const [hh, mm, ss, ff] = normalized.map(part => Number(part))
  if (mm >= 60 || ss >= 60) {
    return { success: false, error: 'Minutes and seconds must be below 60.' }
  }
  if (ff >= roundedFps) {
    return { success: false, error: `Frames must be below ${roundedFps} at the current timeline FPS.` }
  }

  const seconds = hh * 3600 + mm * 60 + ss + (ff / roundedFps)
  return { success: true, seconds: sign * seconds }
}

const parseFrameOffsetInput = (value, fps) => {
  const raw = String(value || '').trim()
  if (!raw) {
    return { success: false, error: 'Enter a frame offset like +12 or -48.' }
  }

  const roundedFps = Math.max(1, Math.round(Number(fps) || FRAME_RATE))
  const match = raw.match(/^([+-])?\s*(\d+)$/)
  if (!match) {
    return { success: false, error: 'Use signed whole frames like +12 or -48.' }
  }

  const sign = match[1] === '-' ? -1 : 1
  const frames = Number(match[2]) || 0
  return {
    success: true,
    frames: sign * frames,
    seconds: sign * (frames / roundedFps),
  }
}

const getClipSourceDurationForExtension = (clip) => {
  if (!clip) return Infinity
  if (clip.type === 'image' || clip.type === 'adjustment' || clip.type === 'text' || clip.type === 'shape' || clip.type === 'captions') return Infinity
  const raw = clip.sourceDuration
  if (raw === Infinity || raw === 'Infinity') return Infinity
  const parsed = Number(raw)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  const fallbackTrimEnd = Number(clip.trimEnd)
  return Number.isFinite(fallbackTrimEnd) && fallbackTrimEnd > 0 ? fallbackTrimEnd : null
}

const isInfinitelyExtendableClip = (clip) => (
  clip?.type === 'image' || clip?.type === 'adjustment' || clip?.type === 'text' || clip?.type === 'shape' || clip?.type === 'captions'
)

const getAudioWaveformContext = () => {
  if (typeof window === 'undefined') return null
  if (audioWaveformContext) return audioWaveformContext
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) return null
  audioWaveformContext = new Ctx()
  return audioWaveformContext
}

const buildWaveformPeaks = (audioBuffer, sampleCount = DEFAULT_WAVEFORM_SAMPLES) => {
  // Per-channel peaks (up to stereo), true levels — no per-file
  // normalization, matching the main-process ffmpeg extraction.
  const channelCount = Math.max(1, Math.min(2, audioBuffer.numberOfChannels || 1))
  const totalSamples = Math.max(1, audioBuffer.length || 1)
  const buckets = Math.max(32, sampleCount)
  const bucketSize = Math.max(1, Math.floor(totalSamples / buckets))
  const channelPeaks = []

  for (let channel = 0; channel < channelCount; channel++) {
    const data = audioBuffer.getChannelData(channel)
    const peaksForChannel = new Array(buckets).fill(0)
    for (let i = 0; i < buckets; i++) {
      const start = i * bucketSize
      const end = i === buckets - 1 ? totalSamples : Math.min(totalSamples, start + bucketSize)
      let peak = 0
      for (let s = start; s < end; s++) {
        const amp = Math.abs(data[s] || 0)
        if (amp > peak) peak = amp
      }
      peaksForChannel[i] = Math.min(1, peak)
    }
    channelPeaks.push(peaksForChannel)
  }

  const peaks = channelPeaks.length > 1
    ? channelPeaks[0].map((value, i) => Math.max(value, channelPeaks[1][i]))
    : channelPeaks[0]

  return {
    peaks,
    channelPeaks: channelPeaks.length > 1 ? channelPeaks : null,
  }
}

const isNativeMediaUrl = (url) => /^file:\/\//i.test(url) || /^comfystudio:\/\//i.test(url)
const isAbsoluteMediaPath = (value) => (
  /^[a-zA-Z]:[\\/]/.test(String(value || ''))
  || String(value || '').startsWith('/')
)

const getAudioWaveformData = async (url, sampleCount = DEFAULT_WAVEFORM_SAMPLES) => {
  if (!url) return null
  const key = `${url}|${sampleCount}`
  if (AUDIO_WAVEFORM_CACHE.has(key)) return AUDIO_WAVEFORM_CACHE.get(key)
  if (AUDIO_WAVEFORM_PENDING.has(key)) return AUDIO_WAVEFORM_PENDING.get(key)

  const loadPromise = (async () => {
    const isElectronRuntime = typeof window !== 'undefined' && window.electronAPI?.isElectron === true
    // In Electron, decode in the main process (ffmpeg) to avoid renderer crashes.
    if (
      isElectronRuntime
      && typeof window.electronAPI?.getAudioWaveform === 'function'
      && (isNativeMediaUrl(url) || isAbsoluteMediaPath(url))
    ) {
      const result = await window.electronAPI.getAudioWaveform(url, { sampleCount })
      if (result?.success && Array.isArray(result.peaks)) {
        return {
          peaks: result.peaks,
          channelPeaks: Array.isArray(result.channelPeaks) && result.channelPeaks.length >= 2
            ? result.channelPeaks
            : null,
          duration: Number(result.duration) || 0
        }
      }
      throw new Error(result?.error || 'Failed to extract waveform in main process')
    }

    // Safety: keep Electron renderer decode path to blob/data URLs only.
    const isBlobOrDataUrl = /^blob:/i.test(url) || /^data:/i.test(url)
    if (isElectronRuntime && !isBlobOrDataUrl) {
      return null
    }

    const ctx = getAudioWaveformContext()
    if (!ctx) throw new Error('Web Audio API is not available')
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to load audio: ${response.status}`)
    const arrayBuffer = await response.arrayBuffer()
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
    const built = buildWaveformPeaks(audioBuffer, sampleCount)
    return { ...built, duration: audioBuffer.duration || 0 }
  })().then((result) => {
    AUDIO_WAVEFORM_PENDING.delete(key)
    if (result) AUDIO_WAVEFORM_CACHE.set(key, result)
    return result
  }).catch((error) => {
    AUDIO_WAVEFORM_PENDING.delete(key)
    throw error
  })

  AUDIO_WAVEFORM_PENDING.set(key, loadPromise)
  return loadPromise
}

// Pixel count for canvas waveform: one sample per pixel up to 2x display width (Resolve-like resolution)
function getWaveformPixelCount(clipWidthPx) {
  return Math.min(8192, Math.max(96, Math.round(clipWidthPx * 2)))
}

function getWaveformSampleCount(pixelCount) {
  const target = Math.max(DEFAULT_WAVEFORM_SAMPLES, Math.round(Number(pixelCount) || 0) * 2)
  let sampleCount = DEFAULT_WAVEFORM_SAMPLES
  while (sampleCount < target && sampleCount < 32768) {
    sampleCount *= 2
  }
  return Math.min(32768, sampleCount)
}

function AudioWaveformBars({ clip, clipWidth, clipUrl, waveformInput = null, stereo = false }) {
  const [waveform, setWaveform] = useState(null)
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const pixelCount = getWaveformPixelCount(clipWidth)
  const waveformSampleCount = getWaveformSampleCount(pixelCount)

  useEffect(() => {
    let cancelled = false

    const mediaInput = waveformInput || clipUrl
    if (!mediaInput) {
      setWaveform(null)
      return () => { cancelled = true }
    }

    getAudioWaveformData(mediaInput, waveformSampleCount)
      .then((data) => {
        if (!cancelled) setWaveform(data)
      })
      .catch(() => {
        if (!cancelled) setWaveform(null)
      })

    return () => {
      cancelled = true
    }
  }, [clipUrl, waveformInput, waveformSampleCount])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setContainerSize({ w: el.offsetWidth, h: el.offsetHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [clipWidth])

  const lanePixels = useMemo(() => {
    if (!waveform?.peaks?.length) return null

    // One lane per rendered channel: stereo tracks with per-channel data get
    // L and R lanes; everything else renders the combined mono lane.
    const laneSources = stereo && Array.isArray(waveform.channelPeaks) && waveform.channelPeaks.length >= 2
      ? waveform.channelPeaks
      : [waveform.peaks]

    const sourceDurationFromClip = Number(clip.sourceDuration)
    const sourceDuration = Number.isFinite(sourceDurationFromClip) && sourceDurationFromClip > 0
      ? sourceDurationFromClip
      : Math.max(0.001, Number(waveform.duration) || 0.001)
    const trimStart = Math.max(0, Number(clip.trimStart) || 0)
    const rawTrimEnd = clip.trimEnd !== undefined && clip.trimEnd !== null
      ? Number(clip.trimEnd)
      : sourceDuration
    const trimEnd = Math.max(trimStart + 0.0001, Math.min(sourceDuration, Number.isFinite(rawTrimEnd) ? rawTrimEnd : sourceDuration))
    const sourceSpan = Math.max(0.0001, trimEnd - trimStart)
    const isReverse = Boolean(clip.reverse)

    return laneSources.map((peaks) => {
      const out = new Array(pixelCount)
      for (let i = 0; i < pixelCount; i++) {
        const startProgress = i / pixelCount
        const endProgress = (i + 1) / pixelCount
        const startTime = isReverse
          ? trimEnd - (endProgress * sourceSpan)
          : trimStart + (startProgress * sourceSpan)
        const endTime = isReverse
          ? trimEnd - (startProgress * sourceSpan)
          : trimStart + (endProgress * sourceSpan)
        const normalizedStart = Math.max(0, Math.min(0.999999, startTime / sourceDuration))
        const normalizedEnd = Math.max(0, Math.min(0.999999, endTime / sourceDuration))
        const leftIndex = Math.max(0, Math.floor(normalizedStart * (peaks.length - 1)))
        const rightIndex = Math.min(peaks.length - 1, Math.ceil(normalizedEnd * (peaks.length - 1)))
        let peak = 0
        for (let peakIndex = leftIndex; peakIndex <= rightIndex; peakIndex += 1) {
          const value = Number(peaks[peakIndex] || 0)
          if (value > peak) peak = value
        }
        out[i] = Math.max(0.006, Math.min(1, peak))
      }
      return out
    })
  }, [waveform, stereo, clip.sourceDuration, clip.trimStart, clip.trimEnd, clip.reverse, pixelCount])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const w = containerSize.w
    const h = containerSize.h
    if (!canvas || w <= 0 || h <= 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.scale(dpr, dpr)

    ctx.fillStyle = AUDIO_TRACK_BG
    ctx.fillRect(0, 0, w, h)

    // One horizontal lane per channel (stereo pair = L on top, R below),
    // each mirrored around its own lane center — Flame/Resolve style.
    const laneCount = lanePixels ? lanePixels.length : 1
    const laneHeight = h / laneCount

    for (let lane = 0; lane < laneCount; lane++) {
      const centerY = laneHeight * (lane + 0.5)
      const halfH = (laneHeight / 2) * 0.88
      const amps = lanePixels ? lanePixels[lane] : null
      const n = amps ? amps.length : 0

      if (n > 0) {
        // Filled mirrored envelope (top edge across, bottom edge back) —
        // reads as one connected waveform body like Flame/Resolve, instead
        // of isolated per-column sticks.
        ctx.fillStyle = AUDIO_WAVEFORM_FILL
        ctx.beginPath()
        ctx.moveTo(0, centerY - (amps[0] ?? 0) * halfH)
        for (let i = 0; i < n; i++) {
          const x = ((i + 0.5) / n) * w
          ctx.lineTo(x, centerY - (amps[i] ?? 0) * halfH)
        }
        ctx.lineTo(w, centerY - (amps[n - 1] ?? 0) * halfH)
        ctx.lineTo(w, centerY + (amps[n - 1] ?? 0) * halfH)
        for (let i = n - 1; i >= 0; i--) {
          const x = ((i + 0.5) / n) * w
          ctx.lineTo(x, centerY + (amps[i] ?? 0) * halfH)
        }
        ctx.lineTo(0, centerY + (amps[0] ?? 0) * halfH)
        ctx.closePath()
        ctx.fill()
      }

      ctx.strokeStyle = AUDIO_WAVEFORM_CENTER_LINE
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, centerY)
      ctx.lineTo(w, centerY)
      ctx.stroke()
    }
  }, [containerSize, lanePixels])

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 top-[3px] overflow-hidden"
      style={{ backgroundColor: AUDIO_TRACK_BG }}
    >
      <canvas
        ref={canvasRef}
        className="block w-full h-full"
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
    </div>
  )
}

// Timeline subscribes to every store field it renders EXCEPT playheadPosition:
// that field changes every animation frame during playback and scrubbing, and
// re-rendering the full clip area per tick is the difference between ~17 and
// ~24 fps on a 160-clip timeline. The playhead line updates imperatively via
// a direct store subscription; handlers read the live value from getState().
const TIMELINE_STORE_KEYS = [
  'duration', 'zoom', 'tracks', 'clips', 'transitions', 'selectedClipIds',
  'selectedTransitionId', 'selectedGap', 'activeTrackId',
  'showTimelineClipThumbnails', 'setActiveTrack', 'snappingEnabled',
  'activeSnapTime', 'rippleEditMode', 'inPoint', 'outPoint',
  'rangeRenderState', 'markers', 'selectedMarkerId', 'addClip', 'addTextClip',
  'addShapeClip', 'removeClip', 'removeSelectedClips', 'rippleDeleteClipIds',
  'rippleDeleteSelectedClips', 'rippleDeleteSelectedGap', 'moveClip',
  'moveSelectedClips', 'setSelectedClipsStartTimes', 'setSelectedClipPositions',
  'duplicateClipsForDrag', 'removeDragDuplicates',
  'resizeClip', 'updateClipTrim', 'updateClipsTrim', 'updateAudioClipProperties', 'selectClip',
  'selectClips', 'clearSelection', 'setPlayheadPosition', 'setZoom',
  'toggleTrackMute', 'toggleTrackSolo', 'toggleTrackLock', 'toggleTrackVisibility',
  'setClipsEnabled', 'setClipLabelColor', 'addTrack', 'addTransition',
  'removeTransition', 'updateTransition', 'selectTransition',
  'getMaxTransitionDuration', 'addMaskEffect', 'addEffect', 'toggleSnapping',
  'toggleRippleEdit', 'setActiveSnapTime', 'clearActiveSnap', 'removeTrack',
  'renameTrack', 'reorderTrack', 'undo', 'redo', 'canUndo', 'canRedo',
  'saveToHistory', 'clearClipCache', 'requestMaskPicker', 'requestTextEdit',
  'copySelectedClips', 'pasteClipsAtPlayhead', 'copiedClips', 'attributeClipboard',
  'getLinkedClipIds', 'linkSelectedClips', 'unlinkSelectedClips',
  'lockSyncClips', 'unlockSyncLockedClips', 'addMarker', 'removeMarker',
  'selectMarker', 'selectGap', 'addAdjustmentClip',
  'compoundEditContext',
]
const pickTimelineStoreSlice = (state) => {
  const slice = {}
  for (const key of TIMELINE_STORE_KEYS) slice[key] = state[key]
  return slice
}

// Keep playhead-driven enablement local to the button. The clip area remains
// unsubscribed from playback ticks, while crossing a cut/gap updates Split.
const ActiveTrackSplitButton = memo(function ActiveTrackSplitButton({ onClick, className, showLabel, availableTitle, unavailableTitle }) {
  const canSplit = useTimelineStore(canSplitActiveTrackAtPlayhead)
  return (
    <button onClick={onClick} disabled={!canSplit} className={className}
      title={canSplit ? availableTitle : unavailableTitle}>
      <Scissors className="w-3 h-3" />
      {showLabel && 'Split'}
    </button>
  )
})

// Ruler ticks live in their own memoized component: at frame-level zoom a
// long timeline emits thousands of tick elements, and re-reconciling them on
// every playhead tick during playback dwarfs the rest of the ruler. Props
// only change on zoom/duration/fps changes, so playback skips this subtree.
const RulerTickMarks = memo(function RulerTickMarks({ major, minor, pixelsPerSecond, timecodeFps }) {
  return (
    <>
      {/* Minor ticks */}
      {minor.map((time) => (
        <div
          key={`minor-${time}`}
          className="absolute bottom-0 w-px h-1.5 bg-sf-dark-600/80 pointer-events-none"
          style={{ left: `${time * pixelsPerSecond}px` }}
        />
      ))}

      {/* Major ticks + timecode labels */}
      {major.map((time) => (
        <div
          key={`major-${time}`}
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{ left: `${time * pixelsPerSecond}px` }}
        >
          <div className="absolute bottom-0 w-px h-2.5 bg-sf-dark-500/95" />
          <span className="absolute top-0.5 left-1 text-[9px] text-sf-text-muted font-mono tracking-tight whitespace-nowrap">
            {formatFrameTimecode(time, timecodeFps)}
          </span>
        </div>
      ))}
    </>
  )
})

function Timeline({ onActiveToolChange, onStatusChange }) {
  const { t } = useI18n()
  const timelineRef = useRef(null)
  const playheadElRef = useRef(null)
  const trackHeadersRef = useRef(null)
  const trackContentRef = useRef(null)
  const selectionViewRef = useRef(null)
  const pendingSelectionViewRef = useRef(null)
  const viewportNavigationSequenceRef = useRef(0)
  const selectionViewPointerDownRef = useRef(false)
  const [selectionViewRevision, setSelectionViewRevision] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [dragClip, setDragClip] = useState(null)
  const [dropTarget, setDropTarget] = useState(null)
  const [draggedAssetId, setDraggedAssetId] = useState(null)
  const [draggedAssetIds, setDraggedAssetIds] = useState([])
  const [assetDropPreview, setAssetDropPreview] = useState(null) // { assetId, trackId, startTime, duration, assetType, name, willCreateTrack }
  const dragOverRafRef = useRef(null)
  const pendingAssetDragOverRef = useRef(null)
  const cancelPendingAssetDragOver = useCallback(() => {
    if (dragOverRafRef.current !== null) {
      cancelAnimationFrame(dragOverRafRef.current)
      dragOverRafRef.current = null
    }
    pendingAssetDragOverRef.current = null
  }, [])
  
  // Track headers width (resizable) — default wide enough to read labels; persisted
  const TRACK_HEADERS_MIN = 100
  const TRACK_HEADERS_MAX = 400
  const TRACK_HEADERS_STORAGE_KEY = 'comfystudio-timeline-track-headers-width'
  const VIDEO_TRACK_HEIGHT_DEFAULT = 48
  const AUDIO_TRACK_HEIGHT_MONO_DEFAULT = 40
  const AUDIO_TRACK_HEIGHT_STEREO_DEFAULT = 80
  const TRACK_HEIGHT_MIN = 32
  const TRACK_HEIGHT_MAX = 220
  const TRACK_HEIGHTS_STORAGE_KEY = 'comfystudio-timeline-track-heights-v1'
  const TRACK_HEIGHT_PRESET_STORAGE_KEY = 'comfystudio-timeline-track-height-preset'
  // Per-type heights for each preset. 'normal' matches the classic defaults;
  // compact flattens everything to the minimum so dense timelines fit on
  // screen; new tracks follow the active preset via getDefaultTrackHeight.
  const TRACK_HEIGHT_PRESETS = {
    compact: { video: TRACK_HEIGHT_MIN, mono: TRACK_HEIGHT_MIN, stereo: TRACK_HEIGHT_MIN },
    normal: { video: VIDEO_TRACK_HEIGHT_DEFAULT, mono: AUDIO_TRACK_HEIGHT_MONO_DEFAULT, stereo: AUDIO_TRACK_HEIGHT_STEREO_DEFAULT },
    tall: { video: 80, mono: 64, stereo: 128 },
  }
  const [trackHeadersWidth, setTrackHeadersWidth] = useState(() => {
    try {
      const w = localStorage.getItem(TRACK_HEADERS_STORAGE_KEY)
      if (w != null) {
        const n = parseInt(w, 10)
        if (Number.isFinite(n) && n >= TRACK_HEADERS_MIN && n <= TRACK_HEADERS_MAX) return n
      }
    } catch (_) {}
    return 208 // default wider so "Video 1", "AUDIO", icons and P are readable
  })
  const [isResizingHeaders, setIsResizingHeaders] = useState(false)
  const resizeStartX = useRef(0)
  const resizeStartWidth = useRef(0)
  const lastTrackHeadersWidthRef = useRef(null) // for persisting on resize end
  const [trackHeights, setTrackHeights] = useState(() => {
    try {
      const raw = localStorage.getItem(TRACK_HEIGHTS_STORAGE_KEY)
      const parsed = raw ? JSON.parse(raw) : {}
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (_) {
      return {}
    }
  })
  const [activeTimelineTool, setActiveTimelineTool] = useState(() => {
    try {
      const saved = localStorage.getItem(TIMELINE_TOOL_STORAGE_KEY)
      if (Object.values(TIMELINE_TOOLS).includes(saved)) return saved
    } catch (_) {}
    return TIMELINE_TOOLS.AUTO
  })
  const [trackHeightPreset, setTrackHeightPreset] = useState(() => {
    try {
      const saved = localStorage.getItem(TRACK_HEIGHT_PRESET_STORAGE_KEY)
      if (saved && TRACK_HEIGHT_PRESETS[saved]) return saved
    } catch (_) {}
    return 'normal'
  })

  const getDefaultTrackHeight = (track) => {
    const preset = TRACK_HEIGHT_PRESETS[trackHeightPreset] || TRACK_HEIGHT_PRESETS.normal
    if (!track) return preset.video
    if (track.type === 'video') return preset.video
    return track.channels === 'mono' ? preset.mono : preset.stereo
  }

  // Switching presets clears per-track drag overrides so the result is
  // uniform; individual tracks can still be dragged afterward.
  const applyTrackHeightPreset = (presetName) => {
    if (!TRACK_HEIGHT_PRESETS[presetName]) return
    setTrackHeightPreset(presetName)
    setTrackHeights({})
    try { localStorage.setItem(TRACK_HEIGHT_PRESET_STORAGE_KEY, presetName) } catch (_) {}
  }

  const getTrackHeight = (track) => {
    const fallback = getDefaultTrackHeight(track)
    const custom = Number(trackHeights?.[track?.id])
    const raw = Number.isFinite(custom) ? custom : fallback
    return Math.max(TRACK_HEIGHT_MIN, Math.min(TRACK_HEIGHT_MAX, raw))
  }

  const getTrackOffset = (tracksList, index) => {
    let y = 0
    for (let i = 0; i < index; i++) y += getTrackHeight(tracksList[i])
    return y
  }
  
  // Trimming state
  const [trimState, setTrimState] = useState(null) // { clipId, edge: 'left' | 'right', startX, startValue }
  const [trimPreview, setTrimPreview] = useState(null)
  const trimGestureRef = useRef(null)
  const [rippleTrimState, setRippleTrimState] = useState(null)
  const [rippleTrimPreview, setRippleTrimPreview] = useState(null)
  const [rippleTrimRefusal, setRippleTrimRefusal] = useState(null)
  const rippleTrimGestureRef = useRef(null)
  const [slipState, setSlipState] = useState(null) // Validated public session plus pointer startX; token stays private in the gesture ref.
  const [slipPreview, setSlipPreview] = useState(null)
  const [slipRefusal, setSlipRefusal] = useState(null)
  const slipGestureRef = useRef(null)
  const [slideState, setSlideState] = useState(null)
  const [slidePreview, setSlidePreview] = useState(null)
  const [slideRefusal, setSlideRefusal] = useState(null)
  const slideGestureRef = useRef(null)
  const [fadeDragState, setFadeDragState] = useState(null) // { clipId, edge: 'in' | 'out', startX, startFade }

  useEffect(() => {
    try {
      localStorage.setItem(TIMELINE_TOOL_STORAGE_KEY, activeTimelineTool)
    } catch (_) {}
  }, [activeTimelineTool])

  useEffect(() => {
    if (onActiveToolChange) {
      onActiveToolChange(TIMELINE_TOOL_LABELS[activeTimelineTool] || TIMELINE_TOOL_LABELS[TIMELINE_TOOLS.SELECT])
    }
  }, [activeTimelineTool, onActiveToolChange])

  const isAutoToolActive = activeTimelineTool === TIMELINE_TOOLS.AUTO
  const isTrimToolActive = activeTimelineTool === TIMELINE_TOOLS.TRIM
  const trimHandlesEnabled = isTrimToolActive || isAutoToolActive
  const isRazorToolActive = activeTimelineTool === TIMELINE_TOOLS.RAZOR
  const isSlipToolActive = activeTimelineTool === TIMELINE_TOOLS.SLIP
  const isSlideToolActive = activeTimelineTool === TIMELINE_TOOLS.SLIDE

  const getTimeScale = (clip) => {
    if (!clip) return 1
    const baseScale = clip.sourceTimeScale
      || (clip.timelineFps && clip.sourceFps ? clip.timelineFps / clip.sourceFps : 1)
    const speed = Number(clip.speed)
    const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
    return baseScale * speedScale
  }

  // Scrubbing state (for dragging playhead)
  const [isScrubbing, setIsScrubbing] = useState(false)
  const scrubGestureRef = useRef(null)
  const scrubToolRef = useRef(activeTimelineTool)
  scrubToolRef.current = activeTimelineTool
  
  // Clip dragging state (moving clips within timeline)
  const [clipDragState, setClipDragState] = useState(null) // { clipId, startX, originalStartTime, originalTrackId }
  const clipDragHistorySavedRef = useRef(false)
  // Ids spawned by the Alt-drag duplicate gesture; lives outside clipDragState
  // because the drag effect re-runs (and would tear down state) on every move.
  const dragDuplicatesRef = useRef(null)
  
  // Marquee selection state
  const [marqueeState, setMarqueeState] = useState(null) // { startX, startY, currentX, currentY, scrollLeft, scrollTop }
  const [pendingLanePointerState, setPendingLanePointerState] = useState(null) // Click on empty lane; becomes gap selection or marquee after drag threshold
  
  // Direct-cut menu snapshots never change the current clip selection.
  const [transitionMenu, setTransitionMenu] = useState(null) // { x, y, target }
  const transitionMenuRef = useRef(null)
  const transitionMenuPosition = useViewportClampedPosition(transitionMenu, transitionMenuRef)
  const [defaultTransitionFrames, setDefaultTransitionFrames] = useState(() => {
    try {
      const raw = localStorage.getItem(TRANSITION_DEFAULT_DURATION_KEY)
      const parsed = Number(raw)
      if (Number.isFinite(parsed) && parsed >= 1) return Math.round(parsed)
    } catch (_) {}
    return TRANSITION_DURATIONS[1]?.frames || 12
  })
  
  // Transition drag/drop state
  const [transitionDropTarget, setTransitionDropTarget] = useState(null) // `${clipAId}-${clipBId}`
  
  // Transition dragging state
  const [transitionDragState, setTransitionDragState] = useState(null) // { transitionId, startX, startDuration }
  
  // Roll edit state (dragging between two adjacent clips)
  const [rollEditState, setRollEditState] = useState(null) // Validated public session plus pointer startX; the private token lives only in the gesture ref.
  const [rollPreview, setRollPreview] = useState(null)
  const [rollRefusal, setRollRefusal] = useState(null)
  const rollGestureRef = useRef(null)
  
  // Spacebar panning state
  const [isPanning, setIsPanning] = useState(false)
  const [panStart, setPanStart] = useState(null) // { x, y, scrollLeft, scrollTop }
  const [isSpaceHeld, setIsSpaceHeld] = useState(false)
  const spacePanningKeyDownRef = useRef(false)
  
  // Transition types and durations are defined in constants/transitions
  
  // Clip context menu state
  const [clipContextMenu, setClipContextMenu] = useState(null) // { x, y, clipId }
  const [pasteAttributesSession, setPasteAttributesSession] = useState(null)
  const [smartReplaceSession, setSmartReplaceSession] = useState(null)
  const [compoundClipSession, setCompoundClipSession] = useState(null)
  const [uncompoundSession, setUncompoundSession] = useState(null)
  const [compoundNavigationError, setCompoundNavigationError] = useState('')
  const parentTimelineScrollRef = useRef(null)
  const pasteAttributesOpenRef = useRef(false)
  pasteAttributesOpenRef.current = !!pasteAttributesSession || !!smartReplaceSession || !!compoundClipSession || !!uncompoundSession
  const [maskSubmenuOpen, setMaskSubmenuOpen] = useState(false)
  // Refs + viewport-clamped positions keep the menus from spilling below
  // the taskbar or off the right edge when you right-click near a screen
  // boundary. See useViewportClampedPosition for how it measures and flips.
  const clipContextMenuRef = useRef(null)
  const clipContextMenuAnchor = useMemo(
    () => (clipContextMenu ? { x: clipContextMenu.x, y: clipContextMenu.y } : null),
    [clipContextMenu?.x, clipContextMenu?.y]
  )
  const clipContextMenuPosition = useViewportClampedPosition(
    clipContextMenuAnchor,
    clipContextMenuRef,
  )
  
  // Track rename state
  const [renamingTrackId, setRenamingTrackId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  
  // Track reorder drag state
  const [trackDragState, setTrackDragState] = useState(null) // { trackId, trackType, startY, originalIndex }
  const [trackDropTarget, setTrackDropTarget] = useState(null) // index within type group
  const [trackResizeState, setTrackResizeState] = useState(null) // { trackId, startY, startHeight }
  const [isMusicPopoverOpen, setIsMusicPopoverOpen] = useState(false)
  const [musicPopoverAnchor, setMusicPopoverAnchor] = useState(null)
  const [beatAnalysisClipId, setBeatAnalysisClipId] = useState(null)
  const [beatAnalysisError, setBeatAnalysisError] = useState('')
  const beatAnalysisRequestRef = useRef(null)
  useEffect(() => () => { beatAnalysisRequestRef.current = null }, [])

  // "Detect Beats → Markers": run the audio-analysis engine on the clip's
  // trimmed source range and drop a marker on every beat, in one undo step.
  // The context menu stays open while analyzing (and on error) so the user
  // sees the status; it closes itself on success.
  const handleDetectBeatsForClip = useCallback(async (clipId) => {
    if (beatAnalysisRequestRef.current) return
    const state = useTimelineStore.getState()
    const project = useProjectStore.getState()
    const clip = (state.clips || []).find((candidate) => candidate.id === clipId)
    const asset = clip?.assetId ? useAssetsStore.getState().getAssetById(clip.assetId) : null
    if (!clip || !asset) return

    const requestToken = {}
    beatAnalysisRequestRef.current = requestToken
    setBeatAnalysisError('')
    setBeatAnalysisClipId(clipId)
    try {
      const request = captureBeatMarkerRequest(state, project, clip, asset)
      const analysis = await analyzeAudioSource(
        { url: asset.url || '', absolutePath: asset.absolutePath || '', path: asset.path || '',
          projectPath: typeof project.currentProjectHandle === 'string' ? project.currentProjectHandle : '' },
        { startSeconds: request.startSeconds, endSeconds: request.endSeconds, includeLoudnessCurve: false }
      )
      if (beatAnalysisRequestRef.current !== requestToken) return
      const currentState = useTimelineStore.getState()
      if (!isBeatMarkerRequestCurrent(request, currentState, useProjectStore.getState(),
        useAssetsStore.getState().getAssetById(request.assetId))) {
        throw new Error('The clip or timeline changed during analysis. No markers were added; detect beats again.')
      }
      currentState.addMarkersBatch(buildDetectedBeatMarkers(request, analysis))
      setClipContextMenu(null)
    } catch (err) {
      if (beatAnalysisRequestRef.current === requestToken) setBeatAnalysisError(err?.message || 'Beat detection failed.')
    } finally {
      if (beatAnalysisRequestRef.current === requestToken) {
        beatAnalysisRequestRef.current = null
        setBeatAnalysisClipId(null)
      }
    }
  }, [])
  const [moveOffsetDialogOpen, setMoveOffsetDialogOpen] = useState(false)
  const [moveOffsetMode, setMoveOffsetMode] = useState('timecode')
  const [moveOffsetInput, setMoveOffsetInput] = useState('+00:00:00:00')
  const [moveOffsetFramesInput, setMoveOffsetFramesInput] = useState('+0')
  const [moveOffsetError, setMoveOffsetError] = useState('')
  const moveOffsetInputRef = useRef(null)
  const [durationDeltaDialogOpen, setDurationDeltaDialogOpen] = useState(false)
  const [durationDeltaMode, setDurationDeltaMode] = useState('timecode')
  const [durationDeltaInput, setDurationDeltaInput] = useState('+00:00:00:00')
  const [durationDeltaFramesInput, setDurationDeltaFramesInput] = useState('+0')
  const [durationDeltaError, setDurationDeltaError] = useState('')
  const durationDeltaInputRef = useRef(null)
  const [editorHotkeys, setEditorHotkeys] = useState(DEFAULT_EDITOR_HOTKEYS)
  
  // Timeline store
  const {
    duration,
    zoom,
    tracks,
    clips,
    transitions,
    selectedClipIds,
    selectedTransitionId,
    selectedGap,
    activeTrackId,
    showTimelineClipThumbnails,
    setActiveTrack,
    snappingEnabled,
    activeSnapTime,
    rippleEditMode,
    inPoint,
    outPoint,
    rangeRenderState,
    markers,
    selectedMarkerId,
    addClip,
    addTextClip,
    addShapeClip,
    removeClip,
    removeSelectedClips,
    rippleDeleteClipIds,
    rippleDeleteSelectedClips,
    rippleDeleteSelectedGap,
    moveClip,
    moveSelectedClips,
    setSelectedClipsStartTimes,
    setSelectedClipPositions,
    duplicateClipsForDrag,
    removeDragDuplicates,
    resizeClip,
    updateClipTrim,
    updateClipsTrim,
    updateAudioClipProperties,
    selectClip,
    selectClips,
    clearSelection,
    setPlayheadPosition,
    setZoom,
    toggleTrackMute,
    toggleTrackSolo,
    toggleTrackLock,
    toggleTrackVisibility,
    setClipsEnabled,
    setClipLabelColor,
    addTrack,
    addTransition,
    removeTransition,
    updateTransition,
    selectTransition,
    getMaxTransitionDuration,
    addMaskEffect,
    addEffect,
    toggleSnapping,
    toggleRippleEdit,
    setActiveSnapTime,
    clearActiveSnap,
    removeTrack,
    renameTrack,
    reorderTrack,
    undo,
    redo,
    canUndo,
    canRedo,
    saveToHistory,
    clearClipCache,
    requestMaskPicker,
    requestTextEdit,
    copySelectedClips,
    pasteClipsAtPlayhead,
    copiedClips,
    attributeClipboard,
    getLinkedClipIds,
    linkSelectedClips,
    unlinkSelectedClips,
    lockSyncClips,
    unlockSyncLockedClips,
    addMarker,
    removeMarker,
    selectMarker,
    selectGap,
    addAdjustmentClip,
    compoundEditContext,
  } = useTimelineStore(useShallow(pickTimelineStoreSlice))
  const rippleHandlesEnabled = rippleEditMode && trimHandlesEnabled

  // Deliberately not subscribed (see TIMELINE_STORE_KEYS): read the playhead
  // live wherever a handler or render-time expression needs the current value.
  const getLivePlayhead = () => useTimelineStore.getState().playheadPosition

  // Clip/gap/selection readout for the status corner — moved out of the
  // toolbar, where it was occupying button real estate on narrow widths.
  const selectedGapSeconds = selectedGap ? Math.max(0, selectedGap.endTime - selectedGap.startTime) : null
  useEffect(() => {
    if (typeof onStatusChange !== 'function') return undefined
    const parts = []
    if (selectedClipIds.length > 1) parts.push(`${selectedClipIds.length} selected`)
    if (selectedGapSeconds != null) parts.push(`Gap ${selectedGapSeconds.toFixed(2)}s`)
    parts.push(`${clips.length} clips`)
    onStatusChange(parts.join(' · '))
    return () => onStatusChange('')
  }, [onStatusChange, selectedClipIds.length, selectedGapSeconds, clips.length])

  const {
    currentProjectHandle,
    getCurrentTimelineSettings,
    undoTimelineStructureChange,
    redoTimelineStructureChange,
    canUndoTimelineStructureChange,
    canRedoTimelineStructureChange,
    projectHistoryLastChangedAt,
  } = useProjectStore()
  // Assets store needs to be available before we derive sync-lock state.
  // The sync-lock helpers below read asset metadata during render, so keep
  // this destructure above any memo that uses getAssetById.
  const { assets, currentPreview, mediaPreparation, setPreviewMode, getAssetUrl, getAssetById, updateAsset, isPlaying: assetIsPlaying, setIsPlaying: setAssetIsPlaying, folders, addFolder, addAsset, removeAsset } = useAssetsStore()
  const timelineFps = getCurrentTimelineSettings()?.fps
  const timecodeFps = Number.isFinite(Number(timelineFps)) && Number(timelineFps) > 0
    ? Number(timelineFps)
    : FRAME_RATE
  const projectCanUndo = !compoundEditContext && canUndoTimelineStructureChange()
  const projectCanRedo = !compoundEditContext && canRedoTimelineStructureChange()
  const timelineHistoryLastChangedAt = useTimelineStore((state) => state.historyLastChangedAt)
  const timelineIsPlaying = useTimelineStore((state) => state.isPlaying)
  const preferredVideoTrack = useMemo(() => {
    // Never default new text/adjustment clips onto the captions track — it only
    // holds captions. (An active non-captions video track still wins.)
    const activeVideoTrack = tracks.find((track) => track.id === activeTrackId && track.type === 'video' && track.role !== 'captions')
    if (activeVideoTrack) return activeVideoTrack
    return tracks.find((track) => track.type === 'video' && track.role !== 'captions') || null
  }, [tracks, activeTrackId])
  const addTextClipAtPlayhead = useCallback((options = {}) => {
    const targetTrack = preferredVideoTrack
    if (!targetTrack) return null

    const newClip = addTextClip(targetTrack.id, options, getLivePlayhead())
    if (newClip) {
      requestTextEdit(newClip.id, { selectAll: true })
    }
    return newClip
  }, [preferredVideoTrack, addTextClip, requestTextEdit])
  const addShapeClipAtPlayhead = useCallback((options = {}) => {
    const targetTrack = preferredVideoTrack
    if (!targetTrack) return null
    return addShapeClip(targetTrack.id, options, getLivePlayhead())
  }, [preferredVideoTrack, addShapeClip])
  const handleUndoAction = useCallback(() => {
    if (useTimelineStore.getState().compoundEditContext) return undo()
    if (projectCanUndo && (!canUndo() || projectHistoryLastChangedAt > timelineHistoryLastChangedAt)) {
      return undoTimelineStructureChange()
    }
    return undo()
  }, [projectCanUndo, canUndo, projectHistoryLastChangedAt, timelineHistoryLastChangedAt, undoTimelineStructureChange, undo])
  const handleRedoAction = useCallback(() => {
    if (useTimelineStore.getState().compoundEditContext) return redo()
    if (projectCanRedo && (!canRedo() || projectHistoryLastChangedAt > timelineHistoryLastChangedAt)) {
      return redoTimelineStructureChange()
    }
    return redo()
  }, [projectCanRedo, canRedo, projectHistoryLastChangedAt, timelineHistoryLastChangedAt, redoTimelineStructureChange, redo])
  const markerHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.ADD_MARKER])
  const matchFrameHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.MATCH_FRAME])
  const revealInAssetsHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.REVEAL_IN_ASSETS])
  const splitAllHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.SPLIT_ALL])
  const splitActiveHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.SPLIT_ACTIVE])
  const selectFromStartHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.SELECT_FROM_START])
  const selectToEndHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.SELECT_TO_END])
  const moveByHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.OPEN_MOVE_BY])
  const durationByHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.OPEN_DURATION_BY])
  const linkHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.LINK_SELECTION])
  const unlinkHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.UNLINK_SELECTION])
  const snappingHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.TOGGLE_SNAPPING])
  const rippleHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.TOGGLE_RIPPLE])
  const toggleClipEnabledHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.TOGGLE_CLIP_ENABLED])
  const addTextClipHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.ADD_TEXT_CLIP])
  const addTransitionHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.ADD_TRANSITION])
  const frameAllHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.FRAME_ALL])
  // A previously customized U binding keeps its existing action. The tool
  // button remains available without advertising an occupied shortcut.
  const slideShortcutAvailable = !Object.values(editorHotkeys).some(binding => matchEditorHotkey({ key: 'u' }, binding))
  const selectionViewHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.ZOOM_TO_SELECTION])
  const zoomOutHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.ZOOM_OUT])
  const zoomInHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.ZOOM_IN])
  const isMacPlatform = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || '')
  const copyHotkeyLabel = `${isMacPlatform ? 'Cmd' : 'Ctrl'}+C`
  const pasteHotkeyLabel = `${isMacPlatform ? 'Cmd' : 'Ctrl'}+V`
  const durationByHotkeyHint = durationByHotkeyLabel === 'Not set' ? '' : durationByHotkeyLabel
  const frameAllHotkeyHint = frameAllHotkeyLabel === 'Not set' ? '' : ` (${frameAllHotkeyLabel})`
  const zoomOutHotkeyHint = zoomOutHotkeyLabel === 'Not set' ? '' : ` (${zoomOutHotkeyLabel})`
  const zoomInHotkeyHint = zoomInHotkeyLabel === 'Not set' ? '' : ` (${zoomInHotkeyLabel})`
  const isClipEnabled = useCallback((clip) => clip?.enabled !== false, [])
  const getTrackGapAtTime = useCallback((trackId, time) => {
    if (!trackId || !Number.isFinite(time)) return null

    const sortedTrackClips = clips
      .filter((clip) => clip.trackId === trackId)
      .sort((a, b) => a.startTime - b.startTime)

    let previousEnd = 0

    for (const clip of sortedTrackClips) {
      const clipStart = Math.max(0, clip.startTime)
      const clipEnd = Math.max(clipStart, clip.startTime + clip.duration)

      if (time < clipStart) {
        return clipStart > previousEnd
          ? { trackId, startTime: previousEnd, endTime: clipStart }
          : null
      }

      if (time >= clipStart && time <= clipEnd) {
        return null
      }

      previousEnd = Math.max(previousEnd, clipEnd)
    }

    if (time >= previousEnd && time <= duration) {
      return duration > previousEnd
        ? { trackId, startTime: previousEnd, endTime: duration }
        : null
    }

    return null
  }, [clips, duration])
  const handleTrackLaneMouseDown = useCallback((e, track) => {
    if (!track || track.locked) return
    if (
      e.button !== 0 ||
      e.altKey ||
      spacePanningKeyDownRef.current ||
      e.target.closest('[data-gap-ignore]') ||
      e.target.closest('[data-clip]') ||
      e.target.closest('[data-trim-handle]') ||
      e.target.closest('[data-marker-handle]') ||
      e.target.closest('[data-fade-handle]')
    ) {
      return
    }

    const time = getTimeFromMouseEvent(e)
    const gap = getTrackGapAtTime(track.id, time)
    if (!gap || (gap.endTime - gap.startTime) <= 0.001) return

    e.stopPropagation()
    e.preventDefault()

    const { setPreviewMode: setAssetsPreviewMode, isPlaying: isAssetPreviewPlaying, setIsPlaying: setAssetsPlaying } = useAssetsStore.getState()
    setAssetsPreviewMode('timeline')
    if (isAssetPreviewPlaying) {
      setAssetsPlaying(false)
    }

    const pointer = getTimelinePointerPosition(e.clientX, e.clientY)
    if (!pointer) return

    setPendingLanePointerState({
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: pointer.x,
      startY: pointer.y,
      gap,
      time,
      addToSelection: e.shiftKey || e.ctrlKey || e.metaKey,
    })
  }, [getTimeFromMouseEvent, getTimelinePointerPosition, getTrackGapAtTime])
  // Match Frame: open the clip's source asset in the preview source player,
  // parked on the exact source frame under the playhead, with the clip's
  // trimmed range pre-marked as In/Out. Reads all state via getState() so
  // the keydown effect can call it without dependency churn.
  const openMatchFrameForClip = useCallback((targetClip) => {
    if (!targetClip || (targetClip.type !== 'video' && targetClip.type !== 'audio')) return false
    const assetsState = useAssetsStore.getState()
    const asset = targetClip.assetId ? assetsState.getAssetById(targetClip.assetId) : null
    if (!asset || (asset.type !== 'video' && asset.type !== 'audio')) return false

    const playhead = getLivePlayhead()
    const clipStart = Number(targetClip.startTime) || 0
    const clipEnd = clipStart + (Number(targetClip.duration) || 0)
    const playheadInside = playhead >= clipStart && playhead < clipEnd
    // Same speed/ramp/reverse/trim math the preview uses, so the source
    // player lands on the frame the monitor is showing.
    const seekTime = playheadInside
      ? getClipPlaybackTimeAtTimeline(targetClip, playhead, 0, { useFrameSampling: false })
      : (Number(targetClip.trimStart) || 0)

    const trimStart = Number(targetClip.trimStart) || 0
    const trimEnd = Number(targetClip.trimEnd)
    const inPoint = Number.isFinite(trimEnd) ? Math.min(trimStart, trimEnd) : trimStart
    const outPoint = Number.isFinite(trimEnd) ? Math.max(trimStart, trimEnd) : null

    const timelineState = useTimelineStore.getState()
    if (timelineState.isPlaying) timelineState.togglePlay()
    assetsState.requestSourceSeed({ assetId: asset.id, seekTime, inPoint, outPoint })
    assetsState.setPreview(asset)
    return true
    // getLivePlayhead only reads the store; omitting it keeps this stable.
  }, [])

  // Hotkey target: a selected clip passing the predicate (preferring one
  // under the playhead), else the active track's clip at the playhead — the
  // Premiere "targeted track" idiom adapted to Velorn's active track.
  const resolveTargetedClip = useCallback((predicate) => {
    const state = useTimelineStore.getState()
    const playhead = getLivePlayhead()
    const containsPlayhead = (clip) => playhead >= (Number(clip.startTime) || 0)
      && playhead < (Number(clip.startTime) || 0) + (Number(clip.duration) || 0)
    const selected = (state.selectedClipIds || [])
      .map((id) => (state.clips || []).find((clip) => clip.id === id))
      .filter(predicate)
    if (selected.length > 0) return selected.find(containsPlayhead) || selected[0]
    return (state.clips || []).find((clip) => (
      clip.trackId === state.activeTrackId && predicate(clip) && containsPlayhead(clip)
    )) || null
    // getLivePlayhead only reads the store; omitting it keeps this stable.
  }, [])

  const isMatchFrameClip = (clip) => Boolean(clip && (clip.type === 'video' || clip.type === 'audio') && clip.assetId)
  const resolveMatchFrameClip = useCallback(
    () => resolveTargetedClip(isMatchFrameClip),
    [resolveTargetedClip]
  )

  // Reveal works for anything backed by an asset — images included.
  const isRevealableClip = (clip) => Boolean(clip && clip.assetId)
  const revealClipInAssetsPanel = useCallback((targetClip) => {
    if (!isRevealableClip(targetClip)) return false
    const asset = useAssetsStore.getState().getAssetById(targetClip.assetId)
    if (!asset) return false
    window.dispatchEvent(new CustomEvent('comfystudio-reveal-asset', { detail: { assetId: asset.id } }))
    return true
  }, [])

  const handleTrackLaneContextMenu = useCallback((e, track) => {
    if (!track || track.locked) return
    if (
      e.target.closest('[data-gap-ignore]') ||
      e.target.closest('[data-clip]') ||
      e.target.closest('[data-trim-handle]') ||
      e.target.closest('[data-marker-handle]') ||
      e.target.closest('[data-fade-handle]')
    ) {
      return
    }

    const time = getTimeFromMouseEvent(e)
    const gap = getTrackGapAtTime(track.id, time)
    if (!gap || (gap.endTime - gap.startTime) <= 0.001) return

    e.preventDefault()
    e.stopPropagation()
    selectGap(gap)
  }, [getTimeFromMouseEvent, getTrackGapAtTime, selectGap])
  const clipContextSelectionIds = useMemo(() => (
    clipContextMenu ? selectedClipIds : []
  ), [clipContextMenu, selectedClipIds])
  const clipContextSelectionClips = useMemo(
    () => clipContextSelectionIds
      .map((clipId) => clips.find((clip) => clip.id === clipId))
      .filter(Boolean),
    [clips, clipContextSelectionIds]
  )
  const selectedTransitionTargetClips = useMemo(() => (
    clipContextMenu ? clipContextSelectionClips : selectedClipIds
      .map((clipId) => clips.find((clip) => clip.id === clipId))
      .filter(Boolean)
  ), [clips, clipContextMenu, clipContextSelectionClips, selectedClipIds])
  const selectedTransitionClipsOnSameTrack = useMemo(() => {
    if (selectedTransitionTargetClips.length < 2) return []
    const trackId = selectedTransitionTargetClips[0]?.trackId
    if (!trackId) return []
    return selectedTransitionTargetClips.filter((clip) => clip.trackId === trackId)
  }, [selectedTransitionTargetClips])
  const canAddTransitionBetweenClips = useCallback((clipA, clipB) => {
    if (!clipA || !clipB) return false
    if (clipA.type === 'compound' || clipB.type === 'compound') return false
    if (clipA.trackId !== clipB.trackId) return false
    const clipAEnd = Number(clipA.startTime) + Number(clipA.duration)
    const clipBStart = Number(clipB.startTime)
    const gap = clipBStart - clipAEnd
    const frameDuration = 1 / FRAME_RATE
    const tolerance = Math.min(0.001, frameDuration / 10)
    if (gap > tolerance) return false
    const maxDuration = useTimelineStore.getState().getMaxTransitionDurationForAlignment(clipA.id, clipB.id, 'center')
    return maxDuration >= 1 / FRAME_RATE
  }, [])
  const isSyncCapableClip = useCallback((clip) => {
    const asset = clip.assetId ? getAssetById(clip.assetId) : null
    return isMusicVideoSyncCapableClip(clip, asset)
  }, [getAssetById])
  const clipContextSyncEligibleClips = useMemo(
    () => clipContextSelectionClips.filter((clip) => isSyncCapableClip(clip)),
    [clipContextSelectionClips, isSyncCapableClip]
  )
  const clipContextSyncLockByClipId = useMemo(() => (
    clipContextSyncEligibleClips.reduce((acc, clip) => {
      const asset = clip.assetId ? getAssetById(clip.assetId) : null
      const syncLock = buildClipSyncLock({ clip, asset, fps: timecodeFps })
      if (syncLock) {
        acc[clip.id] = syncLock
      }
      return acc
    }, {})
  ), [buildClipSyncLock, clipContextSyncEligibleClips, getAssetById, timecodeFps])
  const clipContextAllSyncLocked = useMemo(
    () => clipContextSyncEligibleClips.length > 0
      && clipContextSyncEligibleClips.every((clip) => isSyncLockedClip(clip)),
    [clipContextSyncEligibleClips]
  )
  const clipContextLinkedGroupIds = useMemo(
    () => [...new Set(clipContextSelectionClips.map((clip) => clip.linkGroupId).filter(Boolean))],
    [clipContextSelectionClips]
  )
  const clipContextCanLink = !clipContextSelectionClips.some(clip => clip.type === 'compound') && clipContextSelectionClips.length > 1 && !(
    clipContextLinkedGroupIds.length === 1 &&
    clipContextSelectionClips.every((clip) => clip.linkGroupId === clipContextLinkedGroupIds[0])
  )
  const clipContextCanUnlink = !clipContextSelectionClips.some(clip => clip.type === 'compound') && clipContextLinkedGroupIds.length > 0
  const clipContextCanAddTransition = useMemo(() => {
    if (selectedTransitionClipsOnSameTrack.length < 2) return false

    const sorted = [...selectedTransitionClipsOnSameTrack].sort((a, b) => a.startTime - b.startTime)
    for (let i = 0; i < sorted.length - 1; i += 1) {
      if (canAddTransitionBetweenClips(sorted[i], sorted[i + 1])) {
        return true
      }
    }

    return false
  }, [canAddTransitionBetweenClips, selectedTransitionClipsOnSameTrack])
  const addTransitionFromSelectedClips = useCallback(() => {
    const selectionByTrack = new Map()
    for (const clip of selectedTransitionTargetClips) {
      const trackId = String(clip.trackId || '')
      if (!selectionByTrack.has(trackId)) selectionByTrack.set(trackId, [])
      selectionByTrack.get(trackId).push(clip)
    }

    let addedAny = false
    for (const clipsOnTrack of selectionByTrack.values()) {
      const sorted = [...clipsOnTrack].sort((a, b) => a.startTime - b.startTime)
      for (let i = 0; i < sorted.length - 1; i += 1) {
        const clipA = sorted[i]
        const clipB = sorted[i + 1]
        if (canAddTransitionBetweenClips(clipA, clipB)) {
          const durationSeconds = Math.max(1 / FRAME_RATE, defaultTransitionFrames / FRAME_RATE)
          addTransition(clipA.id, clipB.id, 'dissolve', durationSeconds)
          addedAny = true
        }
      }
    }

    if (addedAny) {
      setClipContextMenu(null)
    }
    return addedAny
  }, [addTransition, canAddTransitionBetweenClips, defaultTransitionFrames, selectedTransitionTargetClips])
  const clipContextShouldEnable = useMemo(
    () => clipContextSelectionClips.length > 0 && clipContextSelectionClips.every((clip) => !isClipEnabled(clip)),
    [clipContextSelectionClips, isClipEnabled]
  )
  const clipContextActiveLabelColor = useMemo(() => {
    if (clipContextSelectionClips.length === 0) return ''
    const firstColor = getClipLabelColorValue(clipContextSelectionClips[0])
    const allSameColor = clipContextSelectionClips.every((clip) => getClipLabelColorValue(clip) === firstColor)
    return allSameColor ? firstColor : null
  }, [clipContextSelectionClips])

  const setClipSelectionEnabled = useCallback((clipIds, enabled) => {
    if (!Array.isArray(clipIds) || clipIds.length === 0) return
    setClipsEnabled(clipIds, enabled)
  }, [setClipsEnabled])

  const applyClipLabelColor = useCallback((labelColor) => {
    const targetIds = clipContextSelectionIds.length > 0
      ? clipContextSelectionIds
      : (clipContextMenu?.clipId ? [clipContextMenu.clipId] : [])
    if (targetIds.length === 0) return

    setClipLabelColor(targetIds, labelColor)
    setMaskSubmenuOpen(false)
    setClipContextMenu(null)
  }, [clipContextMenu?.clipId, clipContextSelectionIds, setClipLabelColor])

  const toggleClipSelectionEnabled = useCallback((clipIds = selectedClipIds) => {
    const targetClips = (clipIds || [])
      .map((clipId) => clips.find((clip) => clip.id === clipId))
      .filter(Boolean)
    if (targetClips.length === 0) return
    const shouldEnable = targetClips.every((clip) => !isClipEnabled(clip))
    setClipSelectionEnabled(targetClips.map((clip) => clip.id), shouldEnable)
  }, [clips, isClipEnabled, selectedClipIds, setClipSelectionEnabled])
  const selectedClips = useMemo(
    () => selectedClipIds
      .map((clipId) => clips.find((clip) => clip.id === clipId))
      .filter(Boolean),
    [clips, selectedClipIds]
  )
  const selectedClipsShouldEnable = useMemo(
    () => selectedClips.length > 0 && selectedClips.every((clip) => !isClipEnabled(clip)),
    [selectedClips, isClipEnabled]
  )
  const hasCompoundSelection = selectedClips.some(clip => clip.type === 'compound')
  const contextCompoundClip = clips.find(clip => clip.id === clipContextMenu?.clipId && clip.type === 'compound')
  const canDeleteCurrentSelection = selectedClipIds.length > 0
    || Boolean(selectedGap)
    || Boolean(selectedTransitionId)
    || Boolean(selectedMarkerId)
  const [gapDeleteError, setGapDeleteError] = useState('')
  useEffect(() => {
    setGapDeleteError('')
  }, [selectedGap, clips, tracks])

  const handleDeleteCurrentSelection = useCallback(() => {
    setGapDeleteError('')
    if (selectedClipIds.length > 0) {
      if (rippleEditMode) {
        rippleDeleteSelectedClips()
      } else {
        removeSelectedClips()
      }
      return true
    }
    if (selectedGap) {
      const preview = useTimelineStore.getState().previewSelectedGapDelete()
      if (!preview.ok) {
        setGapDeleteError(preview.reason || 'This gap cannot be closed safely. No clips were moved.')
      } else if (!rippleDeleteSelectedGap()) {
        setGapDeleteError(useTimelineStore.getState().previewSelectedGapDelete().reason
          || 'This gap could not be closed safely. No clips were moved.')
      }
      return true
    }
    if (selectedTransitionId) {
      removeTransition(selectedTransitionId)
      return true
    }
    if (selectedMarkerId) {
      removeMarker(selectedMarkerId)
      return true
    }
    return false
  }, [
    removeMarker,
    removeSelectedClips,
    removeTransition,
    rippleDeleteSelectedClips,
    rippleDeleteSelectedGap,
    rippleEditMode,
    selectedClipIds,
    selectedGap,
    selectedMarkerId,
    selectedTransitionId,
  ])

  const handleCopySelection = useCallback(() => {
    if (selectedClipIds.length === 0) return false
    if (useTimelineStore.getState().clips.some(clip => selectedClipIds.includes(clip.id) && clip.type === 'compound')) return false
    copySelectedClips()
    return true
  }, [copySelectedClips, selectedClipIds])

  const openPasteAttributes = useCallback(() => {
    const state = useTimelineStore.getState()
    if (!state.attributeClipboard?.clips?.length || !state.selectedClipIds.length) return
    if (state.clips.some(clip => state.selectedClipIds.includes(clip.id) && clip.type === 'compound')) return
    setPasteAttributesSession({
      clipboard: state.attributeClipboard,
      clipIds: [...state.selectedClipIds],
      expectedClips: state.clips,
      expectedTracks: state.tracks,
      returnFocus: document.activeElement,
    })
    setClipContextMenu(null)
    setMaskSubmenuOpen(false)
  }, [])
  const closePasteAttributes = useCallback(() => setPasteAttributesSession(null), [])
  const openSmartReplace = useCallback((clipId) => {
    const active = document.activeElement
    const returnFocus = active && active !== document.body && !clipContextMenuRef.current?.contains(active)
      ? active : timelineRef.current
    const session = captureSmartReplaceSession(useTimelineStore.getState(), clipId, returnFocus)
    if (!session) return
    setSmartReplaceSession(session)
    setClipContextMenu(null)
    setMaskSubmenuOpen(false)
  }, [])
  const closeSmartReplace = useCallback(() => setSmartReplaceSession(null), [])
  const openCompoundCreate = useCallback(() => {
    const active = document.activeElement
    const returnFocus = active && active !== document.body && !clipContextMenuRef.current?.contains(active) ? active : timelineRef.current
    const session = captureCompoundClipSession(useTimelineStore.getState(), useProjectStore.getState().getCurrentTimelineSettings?.(), returnFocus)
    if (!session) return
    setCompoundClipSession(session)
    setClipContextMenu(null)
    setMaskSubmenuOpen(false)
  }, [])
  const closeCompoundCreate = useCallback(() => setCompoundClipSession(null), [])
  const openUncompound = useCallback((clipId) => {
    const active = document.activeElement
    const returnFocus = active && active !== document.body && !clipContextMenuRef.current?.contains(active) ? active : timelineRef.current
    const session = captureUncompoundSession(useTimelineStore.getState(), clipId, returnFocus, timelineRef.current)
    if (!session) return
    setUncompoundSession(session)
    setClipContextMenu(null)
    setMaskSubmenuOpen(false)
  }, [])
  const closeUncompound = useCallback(() => setUncompoundSession(null), [])
  const openCompoundContents = useCallback((clip) => {
    const result = navigateCompoundContents(clip)
    setCompoundNavigationError(result.ok ? '' : result.reason || 'The compound could not be opened.')
    setClipContextMenu(null)
    setMaskSubmenuOpen(false)
  }, [])
  const backFromCompound = useCallback(() => {
    const result = navigateCompoundContents()
    setCompoundNavigationError(result.ok ? '' : result.reason || 'The contents could not be returned to the parent timeline. Review the edits or undo them and try again.')
  }, [])

  useEffect(() => {
    let previousContext = useTimelineStore.getState().compoundEditContext
    let frame = null
    const unsubscribe = useTimelineStore.subscribe(state => {
      if (state.compoundEditContext === previousContext) return
      const entering = !previousContext && !!state.compoundEditContext
      const leaving = !!previousContext && !state.compoundEditContext
      if (entering) parentTimelineScrollRef.current = {
        left: timelineRef.current?.scrollLeft || 0,
        top: trackContentRef.current?.scrollTop || 0,
      }
      previousContext = state.compoundEditContext
      trimGestureRef.current = null
      setTrimState(null)
      setTrimPreview(null)
      const rippleGesture = rippleTrimGestureRef.current
      rippleTrimGestureRef.current = null
      if (rippleGesture?.token) state.endRippleTrim?.(rippleGesture.token)
      setRippleTrimState(null)
      setRippleTrimPreview(null)
      setRippleTrimRefusal(null)
      setClipDragState(null)
      setTransitionDragState(null)
      setRollEditState(null)
      const rollGesture = rollGestureRef.current
      rollGestureRef.current = null
      if (rollGesture?.token) state.endRollEdit?.(rollGesture.token)
      setRollPreview(null)
      setRollRefusal(null)
      const slipGesture = slipGestureRef.current
      slipGestureRef.current = null
      if (slipGesture?.token) state.endSlipEdit?.(slipGesture.token)
      setSlipState(null)
      setSlipPreview(null)
      setSlipRefusal(null)
      const slideGesture = slideGestureRef.current
      slideGestureRef.current = null
      if (slideGesture?.token) state.endSlideEdit?.(slideGesture.token)
      setSlideState(null)
      setSlidePreview(null)
      setSlideRefusal(null)
      setFadeDragState(null)
      setMarqueeState(null)
      setPendingLanePointerState(null)
      setIsPanning(false)
      setIsScrubbing(false)
      setPanStart(null)
      setIsSpaceHeld(false)
      spacePanningKeyDownRef.current = false
      setClipContextMenu(null)
      setMaskSubmenuOpen(false)
      setPasteAttributesSession(null)
      setSmartReplaceSession(null)
      setCompoundClipSession(null)
      setUncompoundSession(null)
      setMoveOffsetDialogOpen(false)
      setDurationDeltaDialogOpen(false)
      setCompoundNavigationError('')
      resetAudioVolumeEnvelopeEditor()
      state.clearActiveSnap?.()
      if (frame != null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const scroll = leaving ? parentTimelineScrollRef.current : { left: 0, top: 0 }
        if (timelineRef.current) { timelineRef.current.scrollLeft = scroll?.left || 0; timelineRef.current.focus({ preventScroll: true }) }
        if (trackContentRef.current) trackContentRef.current.scrollTop = scroll?.top || 0
        if (trackHeadersRef.current) trackHeadersRef.current.scrollTop = scroll?.top || 0
        if (leaving) parentTimelineScrollRef.current = null
      })
    })
    return () => { unsubscribe(); if (frame != null) cancelAnimationFrame(frame) }
  }, [])

  // Responsive toolbar: full (icon+label) → compact (icons only, tooltips
  // carry the labels) → overflow (low-priority groups spill into a ⋯ menu;
  // the scrollable strip remains as the last-resort fallback).
  // The tier is MEASURED, not guessed: a layout effect downgrades pre-paint
  // whenever the strip's content overflows its width, recording how much
  // width that tier actually needed; it upgrades (optimistically when the
  // need is unknown — a failed attempt bounces back before paint) once that
  // much width plus a hysteresis buffer is available again.
  const toolbarScrollRef = useRef(null)
  const toolbarTierNeedsRef = useRef({})
  const [toolbarTier, setToolbarTier] = useState('full')
  const [toolbarOverflowOpen, setToolbarOverflowOpen] = useState(false)
  const [toolbarOverflowAnchor, setToolbarOverflowAnchor] = useState(null)
  const [, forceToolbarMeasure] = useState(0)
  useEffect(() => {
    const el = toolbarScrollRef.current
    if (!el) return undefined
    const observer = new ResizeObserver(() => forceToolbarMeasure((n) => n + 1))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    const el = toolbarScrollRef.current
    if (!el) return
    const width = el.clientWidth
    const HYSTERESIS = 32
    const needs = toolbarTierNeedsRef.current
    if (el.scrollWidth > width + 1) {
      needs[toolbarTier] = el.scrollWidth
      if (toolbarTier === 'full') setToolbarTier('compact')
      else if (toolbarTier === 'compact') setToolbarTier('overflow')
      return
    }
    if (toolbarTier === 'overflow' && (!needs.compact || width >= needs.compact + HYSTERESIS)) {
      setToolbarTier('compact')
    } else if (toolbarTier === 'compact' && (!needs.full || width >= needs.full + HYSTERESIS)) {
      setToolbarTier('full')
    }
  })
  const showToolbarLabels = toolbarTier === 'full'
  useEffect(() => {
    if (toolbarTier !== 'overflow') setToolbarOverflowOpen(false)
  }, [toolbarTier])
  useEffect(() => {
    if (!toolbarOverflowOpen) return undefined
    const close = () => setToolbarOverflowOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [toolbarOverflowOpen])
  const overflowMenuItemClass = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] text-sf-text-secondary transition-colors hover:bg-sf-dark-700 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-45'

  const toolbarSectionClass = 'inline-flex h-6 items-center gap-0.5 rounded-md border border-sf-dark-700/80 bg-sf-dark-900/55 px-0.5'
  const toolbarButtonClass = 'inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10px] text-sf-text-secondary transition-colors hover:bg-sf-dark-700 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-sf-text-secondary'
  const toolbarDangerButtonClass = 'inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10px] text-sf-error transition-colors hover:bg-sf-error/15 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent'
  const toolbarToggleClass = (active) => `inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10px] transition-colors ${
    active
      ? 'border border-sf-accent/55 bg-sf-accent/18 text-sf-accent'
      : 'border border-transparent text-sf-text-muted hover:bg-sf-dark-700 hover:text-sf-text-primary'
  }`
  const timelineToolOptions = useMemo(() => ([
    {
      id: TIMELINE_TOOLS.AUTO,
      label: 'Auto',
      shortcut: 'A',
      icon: Sparkles,
      title: t('timelineEditor.tooltips.toolAuto'),
    },
    {
      id: TIMELINE_TOOLS.SELECT,
      label: 'Move',
      shortcut: 'V',
      icon: ArrowRightLeft,
      title: t('timelineEditor.tooltips.toolMove'),
    },
    {
      id: TIMELINE_TOOLS.TRIM,
      label: 'Trim',
      shortcut: 'T',
      icon: Square,
      title: t('timelineEditor.tooltips.toolTrim'),
    },
    {
      id: TIMELINE_TOOLS.RAZOR,
      label: 'Razor',
      shortcut: 'B',
      icon: Scissors,
      title: t('timelineEditor.tooltips.toolRazor'),
    },
    {
      id: TIMELINE_TOOLS.SLIP,
      label: 'Slip',
      shortcut: 'Y',
      icon: ArrowRightLeft,
      title: t('timelineEditor.tooltips.toolSlip'),
    },
    {
      id: TIMELINE_TOOLS.SLIDE,
      label: 'Slide',
      shortcut: slideShortcutAvailable ? 'U' : '',
      icon: ArrowRightLeft,
      title: t('timelineEditor.tooltips.toolSlide'),
    },
  ]), [t, slideShortcutAvailable])
  
  const edgeTransitionsByClipId = useMemo(() => {
    const map = new Map()
    transitions
      .filter(t => t.kind === 'edge' && t.clipId)
      .forEach(t => {
        if (!map.has(t.clipId)) {
          map.set(t.clipId, [])
        }
        map.get(t.clipId).push(t)
      })
    return map
  }, [transitions])
  
  // Snapping hook
  const { snapClipPosition, snapTrim, pixelsPerSecond: snapPixelsPerSecond } = useSnapping()

  // Caption workspace state. We mount CaptionWorkspace at the timeline level
  // so captions can span the whole edited program. The session carries the
  // workspace input asset (a lightweight stand-in for timeline scope), which
  // scope to open in, and — for the Edit Captions round-trips — either the
  // baked overlay clip to replace in place on Generate (replaceClipId, asset
  // scope) or the live captions clip to seed the workspace from
  // (seedFromClipId, timeline scope).
  const [captionWorkspaceSession, setCaptionWorkspaceSession] = useState(null) // { asset, scope, replaceClipId, seedFromClipId }
  const handlePasteAtPlayhead = useCallback(() => {
    if (!activeTrackId || copiedClips.length === 0) return false
    if (copiedClips.some(clip => clip.type === 'compound')) return false
    pasteClipsAtPlayhead(activeTrackId, getLivePlayhead(), assets)
    return true
  }, [activeTrackId, assets, copiedClips, pasteClipsAtPlayhead])
  const assetsById = useMemo(() => {
    const map = new Map()
    assets.forEach((asset) => {
      map.set(asset.id, asset)
    })
    return map
  }, [assets])

  const availableMasks = useMemo(() => {
    return assets.filter(a => a.type === 'mask')
  }, [assets])
  
  // Helper to get clip URL - uses asset store URL if available (handles refreshed blob URLs)
  const getClipUrl = (clip) => {
    if (!clip) return null
    if (clip.type === 'text' || clip.type === 'shape' || clip.type === 'captions' || clip.type === 'compound') return null
    // Try to get current URL from assets store (may have been regenerated after refresh)
    if (clip.assetId) {
      const assetUrl = getAssetUrl(clip.assetId)
      if (assetUrl) return assetUrl
    }
    // Fallback to clip's stored URL
    return clip.url
  }

  const getTimelineClipPosterUrl = (clip, asset) => {
    const directPoster = asset?.posterUrl
      || asset?.thumbnailUrl
      || asset?.coverUrl
      || asset?.settings?.posterUrl
      || asset?.settings?.thumbnailUrl
      || asset?.settings?.keyframeUrl
    if (directPoster) return directPoster

    const keyframeAssetId = asset?.settings?.keyframeAssetId
      || asset?.settings?.inputAssetId
      || asset?.yolo?.keyframeAssetId
      || asset?.shortFilm?.keyframeAssetId
      || clip?.metadata?.keyframeAssetId
    if (keyframeAssetId) {
      const posterAsset = assetsById.get(keyframeAssetId)
      if (posterAsset?.type === 'image' && posterAsset?.url) return posterAsset.url
    }

    const variantKeys = new Set([
      asset?.yolo?.variantKey,
      asset?.yolo?.key,
      clip?.metadata?.musicVideoAssembly?.variantKey,
    ].filter(Boolean).map(String))
    if (variantKeys.size > 0) {
      const posterAsset = assets.find((candidate) => {
        if (candidate?.type !== 'image' || !candidate?.url) return false
        if (candidate?.yolo?.stage !== 'storyboard') return false
        return [candidate?.yolo?.variantKey, candidate?.yolo?.key]
          .filter(Boolean)
          .some((key) => variantKeys.has(String(key)))
      })
      if (posterAsset?.url) return posterAsset.url
    }

    const shotId = asset?.shortFilm?.shotId || clip?.metadata?.shortFilm?.shotId
    if (shotId) {
      const posterAsset = assets.find((candidate) => (
        candidate?.type === 'image'
        && candidate?.url
        && candidate?.shortFilm?.kind === 'shot-keyframe'
        && String(candidate.shortFilm.shotId || '') === String(shotId)
      ))
      if (posterAsset?.url) return posterAsset.url
    }

    return null
  }

  const renderTimelineVideoFilmstrip = (clip, renderedClipWidth, thumbCount, contentHeight) => {
    const asset = clip?.assetId ? assetsById.get(clip.assetId) : null
    const sprite = asset?.sprite
    const posterUrl = getTimelineClipPosterUrl(clip, asset)
    const tileWidth = renderedClipWidth / Math.max(1, thumbCount)
    const tileHeight = Math.max(1, contentHeight - 3)

    if (sprite?.url && Array.isArray(sprite.frames) && sprite.frames.length > 0) {
      const duration = Math.max(0, Number(clip?.duration) || 0)
      const trimStart = Number(clip?.trimStart) || 0
      const timeScale = clip?.sourceTimeScale || (clip?.timelineFps && clip?.sourceFps
        ? clip.timelineFps / clip.sourceFps
        : 1)
      const spriteDuration = Math.max(0, Number(sprite.duration) || 0)

      return Array.from({ length: thumbCount }).map((_, i) => {
        const sampleRatio = thumbCount <= 1 ? 0.5 : i / Math.max(1, thumbCount - 1)
        const clipTime = duration * sampleRatio
        const sourceTime = Math.max(0, Math.min(spriteDuration || Infinity, trimStart + clipTime * timeScale))
        const frame = getSpriteFramePosition(sprite, sourceTime) || sprite.frames[0]
        if (!frame) return null

        const scale = Math.max(tileWidth / Math.max(1, frame.width), tileHeight / Math.max(1, frame.height))
        const scaledFrameWidth = frame.width * scale
        const scaledFrameHeight = frame.height * scale
        const x = -frame.x * scale + (tileWidth - scaledFrameWidth) / 2
        const y = -frame.y * scale + (tileHeight - scaledFrameHeight) / 2

        return (
          <div
            key={i}
            className="flex-shrink-0 h-full relative overflow-hidden"
            style={{ width: `${tileWidth}px` }}
          >
            <div
              className="absolute inset-0 opacity-80 pointer-events-none"
              style={{
                backgroundImage: `url(${sprite.url})`,
                backgroundRepeat: 'no-repeat',
                backgroundSize: `${sprite.width * scale}px ${sprite.height * scale}px`,
                backgroundPosition: `${x}px ${y}px`,
              }}
            />
          </div>
        )
      })
    }

    if (posterUrl) {
      return (
        <div className="absolute inset-0 top-[3px] overflow-hidden bg-[#162226]">
          <img
            src={posterUrl}
            alt={asset?.name || clip?.name || 'Video keyframe'}
            className="absolute inset-0 h-full w-full object-cover opacity-80 pointer-events-none"
            draggable={false}
            loading="lazy"
            onContextMenu={(e) => e.preventDefault()}
          />
        </div>
      )
    }

    return (
      <div className="absolute inset-0 top-[3px] flex items-center overflow-hidden bg-[#162226]">
        <div className="flex h-full w-full items-center gap-2 px-2 text-[9px] uppercase tracking-[0.16em] text-white/35">
          <Video className="h-3 w-3 flex-shrink-0" />
          <span className="truncate">Video</span>
        </div>
      </div>
    )
  }

  const handleAddAdjustmentLayer = () => {
    const activeVideoTrack = tracks.find(t => t.id === activeTrackId && t.type === 'video' && !t.locked)
    const fallbackVideoTrack = tracks.find(t => t.type === 'video' && !t.locked)
    const targetTrack = activeVideoTrack || fallbackVideoTrack
    if (!targetTrack) return
    addAdjustmentClip(targetTrack.id, getLivePlayhead(), { duration: 5 })
  }

  // Compute program duration (end of latest clip on any enabled track).
  const computeProgramDuration = useCallback(() => {
    let end = 0
    for (const clip of clips) {
      if (clip.enabled === false) continue
      const s = Number(clip.startTime) || 0
      const d = Math.max(0, Number(clip.duration) || 0)
      if (s + d > end) end = s + d
    }
    return end
  }, [clips])

  // options.editClipId: a live captions clip to edit — the workspace seeds
  // itself from that clip (cues + controls snapshot) instead of its session
  // stash, and Generate replaces the clip in place.
  const handleOpenTimelineCaptions = (options = {}) => {
    const editClipId = options.editClipId || null
    const programDuration = computeProgramDuration()
    if (programDuration <= 0) {
      alert('Add some clips to the timeline before captioning.')
      return
    }

    // Grab the frame under the playhead (topmost video clip covering it) so the
    // captions preview can sit over real footage. Falls back to a neutral
    // background when nothing video is under the playhead.
    let bgVideoUrl = null
    let bgVideoTime = null
    const playheadPosition = getLivePlayhead()
    for (const track of tracks.filter((t) => t.type === 'video' && t.enabled !== false)) {
      const clip = clips.find((c) => (
        c.trackId === track.id
        && c.enabled !== false
        && c.assetId
        && playheadPosition >= (Number(c.startTime) || 0)
        && playheadPosition < (Number(c.startTime) || 0) + (Number(c.duration) || 0)
      ))
      if (!clip) continue
      const asset = getAssetById(clip.assetId)
      if (!asset || asset.type !== 'video' || !asset.url) continue
      // Skip caption / overlay layers (incl. the timeline caption track being
      // replaced) — we want the footage underneath them, not the overlay.
      if (asset.settings?.captionScope || asset.settings?.overlayKind === 'captions' || asset.settings?.source === 'captions') continue
      const trimStart = Number(clip.trimStart) || 0
      const timeScale = clip.sourceTimeScale || (clip.timelineFps && clip.sourceFps
        ? clip.timelineFps / clip.sourceFps
        : 1)
      const clipTime = playheadPosition - (Number(clip.startTime) || 0)
      bgVideoUrl = asset.url
      bgVideoTime = Math.max(0, trimStart + clipTime * timeScale)
      break
    }

    // Opening the editor is non-destructive — any existing timeline caption
    // track stays put. The replace confirmation now lives at generate time
    // (in CaptionWorkspace), since that's when the old track is actually
    // swapped out inside handlePlaceTimelineCaptionOnTimeline.
    setCaptionWorkspaceSession({
      scope: 'timeline',
      replaceClipId: null,
      seedFromClipId: editClipId,
      asset: {
        id: `timeline-mix-${Date.now()}`,
        name: 'Timeline',
        type: 'timeline',
        duration: programDuration,
        hasAudio: true,
        bgVideoUrl,
        bgVideoTime,
      },
    })
  }

  // After the user has generated a caption overlay for the timeline, drop the
  // overlay onto the dedicated captions track (reused across regenerations, so
  // we never pile up empty tracks). Also removes any prior timeline-caption
  // overlay (clip + asset) so we don't stack overlapping transcriptions.
  const handlePlaceTimelineCaptionOnTimeline = async (captionAsset) => {
    if (!captionAsset) return

    // Remove prior timeline-caption overlays (the user already confirmed the
    // replacement before transcription started).
    const state = useTimelineStore.getState()
    const assetsState = useAssetsStore.getState()
    const priorCaptionClips = state.clips.filter((clip) => {
      if (!clip?.assetId) return false
      const a = assetsState.getAssetById(clip.assetId)
      return a?.settings?.captionScope === 'timeline' && a.id !== captionAsset.id
    })
    const priorAssetIds = new Set(priorCaptionClips.map((c) => c.assetId))
    priorCaptionClips.forEach((clip) => state.removeClip(clip.id))
    priorAssetIds.forEach((id) => {
      try { assetsState.removeAsset(id) } catch (_) { /* best-effort cleanup */ }
    })

    // Reuse the dedicated captions track if it exists; otherwise create one at
    // the top (a normal video track tagged role: 'captions'). The user can move,
    // hide, lock, or delete it like any track — it just only holds captions.
    let captionsTrack = state.tracks.find((t) => t.role === 'captions')
    if (!captionsTrack) {
      captionsTrack = state.addTrack('video', { role: 'captions', name: 'Captions' })
    }
    if (!captionsTrack) return

    // Clear anything still on the captions track (e.g. a leftover overlay), then
    // drop the fresh caption clip at t=0 for the full program.
    useTimelineStore.getState().clips
      .filter((c) => c.trackId === captionsTrack.id)
      .forEach((c) => useTimelineStore.getState().removeClip(c.id))

    const programDuration = Math.max(
      Number(captionAsset.duration) || 0,
      Number(captionAsset.settings?.duration) || 0,
      1
    )

    useTimelineStore.getState().addClip(captionsTrack.id, captionAsset, 0, useTimelineStore.getState().timelineFps, {
      duration: programDuration,
      trimStart: 0,
      trimEnd: programDuration,
      metadata: { captionScope: 'timeline' },
    })
  }

  // Edit Captions round-trip: reopen the caption workspace hydrated from the
  // overlay clip that was right-clicked. Timeline-scope overlays reopen the
  // timeline workspace (its restore path hydrates cues + style); asset-scope
  // overlays reopen with their source asset and remember which clip to
  // replace in place on Generate.
  const handleEditCaptionsFromClip = (clip) => {
    setClipContextMenu(null)
    // Live captions clips carry their own cues + workspace snapshot — reopen
    // the timeline workspace seeded straight from the clip.
    if (clip?.type === 'captions') {
      handleOpenTimelineCaptions({ editClipId: clip.id })
      return
    }
    if (!clip?.assetId) return
    const overlayAsset = getAssetById(clip.assetId)
    const overlaySettings = overlayAsset?.settings || {}

    if (overlaySettings.captionScope === 'timeline') {
      handleOpenTimelineCaptions()
      return
    }

    const source = overlaySettings.sourceAssetId ? getAssetById(overlaySettings.sourceAssetId) : null
    const transcriptPath = source?.settings?.captionTranscriptPath
      || overlaySettings.captionTranscriptPath
      || null
    const workspaceAsset = source
      ? {
          ...source,
          settings: {
            ...(source.settings || {}),
            ...(transcriptPath ? { captionTranscriptPath: transcriptPath } : {}),
          },
        }
      : {
          // Source asset no longer in the project: a stand-in can still
          // hydrate the cues from the overlay's own sidecar; re-transcribing
          // just won't be possible.
          id: overlayAsset?.id || clip.assetId,
          name: overlayAsset?.name || clip.name || 'Captions',
          type: 'video',
          duration: Number(overlayAsset?.duration) || Number(clip.duration) || null,
          hasAudio: false,
          settings: transcriptPath ? { captionTranscriptPath: transcriptPath } : {},
        }

    setCaptionWorkspaceSession({ scope: 'asset', asset: workspaceAsset, replaceClipId: clip.id })
  }

  // Double-click a captions clip = Edit Captions (the CapCut reflex). Covers
  // live captions clips (type 'captions') and legacy baked overlays. The
  // caption check runs inside the handler, not at render time, so the
  // per-clip render path stays free of asset lookups. Other clip types keep
  // double-click unbound.
  const handleClipDoubleClick = (e, clip) => {
    if (clip?.type === 'compound') {
      e.preventDefault()
      e.stopPropagation()
      openCompoundContents(clip)
      return
    }
    const isLiveCaptions = clip?.type === 'captions'
    const clipAsset = !isLiveCaptions && clip?.assetId ? getAssetById(clip.assetId) : null
    const isCaptionOverlay = isLiveCaptions || Boolean(
      clipAsset?.settings?.overlayKind === 'captions' || clipAsset?.settings?.captionScope
    )
    if (!isCaptionOverlay) return
    e.preventDefault()
    e.stopPropagation()
    handleEditCaptionsFromClip(clip)
  }

  // Swap a re-generated asset-scope caption overlay into the clip it was
  // opened from: same track, position, and trims. The superseded overlay
  // asset is removed once no timeline references it.
  const handlePlaceAssetCaptionOnTimeline = (captionAsset, replaceClipId) => {
    if (!captionAsset) return
    const state = useTimelineStore.getState()
    const targetClip = replaceClipId ? state.clips.find((c) => c.id === replaceClipId) : null

    if (!targetClip) {
      // The originating clip vanished mid-edit; place like a fresh overlay
      // on the captions track without disturbing anything else.
      let captionsTrack = state.tracks.find((t) => t.role === 'captions')
      if (!captionsTrack) {
        captionsTrack = state.addTrack('video', { role: 'captions', name: 'Captions' })
      }
      if (!captionsTrack) return
      const overlayDuration = Math.max(Number(captionAsset.duration) || 0, 1)
      useTimelineStore.getState().addClip(captionsTrack.id, captionAsset, 0, useTimelineStore.getState().timelineFps, {
        duration: overlayDuration,
        trimStart: 0,
        trimEnd: overlayDuration,
        metadata: { captionScope: 'asset' },
      })
      return
    }

    state.saveToHistory?.()
    const oldAssetId = targetClip.assetId
    const newSourceDuration = Number(captionAsset.duration) || targetClip.sourceDuration
    useTimelineStore.setState((currentState) => ({
      clips: (currentState.clips || []).map((c) => (
        c.id !== targetClip.id ? c : {
          ...c,
          assetId: captionAsset.id,
          name: captionAsset.name,
          url: captionAsset.url,
          thumbnail: captionAsset.url,
          sourceDuration: newSourceDuration,
          trimEnd: Math.min(Number(c.trimEnd) || newSourceDuration, newSourceDuration),
          cacheStatus: c.cacheStatus === 'cached' ? 'invalid' : c.cacheStatus,
          cacheProgress: 0,
          cacheUrl: null,
          cachePath: null,
        }
      )),
    }))

    if (oldAssetId && oldAssetId !== captionAsset.id) {
      const stillOnTimeline = useTimelineStore.getState().clips.some((c) => c.assetId === oldAssetId)
      const projectState = useProjectStore.getState()
      const usedElsewhere = (projectState.currentProject?.timelines || []).some((timeline) => (
        timeline.id !== projectState.currentTimelineId
        && (timeline.clips || []).some((c) => c?.assetId === oldAssetId)
      ))
      if (!stillOnTimeline && !usedElsewhere) {
        try { useAssetsStore.getState().removeAsset(oldAssetId) } catch (_) { /* best-effort cleanup */ }
      }
    }
  }

  // Resolve-like transition pane preview (left/right clip contributions).
  const renderTransitionPreviewPane = (clip, side = 'left') => {
    const url = getClipUrl(clip)
    const objectPosition = side === 'left' ? 'right center' : 'left center'

    if (clip?.type === 'text') {
      return (
        <div className="absolute inset-0 bg-sf-accent/20 flex items-center justify-center">
          <Type className="w-3 h-3 text-white/70" />
        </div>
      )
    }

    if (!url) {
      return <div className="absolute inset-0 bg-sf-dark-700/70" />
    }

    if (clip?.type === 'image') {
      return (
        <img
          src={url}
          alt={clip?.name || 'Transition preview'}
          className="absolute inset-0 w-full h-full object-cover opacity-80 pointer-events-none"
          style={{ objectPosition }}
          draggable={false}
          onContextMenu={(e) => e.preventDefault()}
        />
      )
    }

    return (
      <video
        src={url}
        className="absolute inset-0 w-full h-full object-cover opacity-80 pointer-events-none"
        muted
        style={{ objectPosition }}
        onContextMenu={(e) => e.preventDefault()}
      />
    )
  }

  const renderAssetDropPreviewClip = (track) => {
    if (!assetDropPreview || assetDropPreview.trackId !== track.id) return null

    const previewWidth = Math.max(24, assetDropPreview.duration * pixelsPerSecond)
    const previewLeft = assetDropPreview.startTime * pixelsPerSecond
    const isAudioTrack = track.type === 'audio'
    const typeLabel = assetDropPreview.assetType === 'image'
      ? 'IMG'
      : assetDropPreview.assetType === 'audio'
        ? 'AUD'
        : 'VID'
    const tone = isAudioTrack
      ? {
          background: 'rgba(45, 64, 56, 0.55)',
          border: 'rgba(126, 184, 168, 0.9)',
          accent: AUDIO_CLIP_ACCENT,
        }
      : {
          background: 'rgba(61, 112, 128, 0.42)',
          border: 'rgba(232, 93, 4, 0.9)',
          accent: '#e85d04',
        }

    return (
      <div
        className="absolute top-0.5 bottom-0.5 rounded-sm border border-dashed pointer-events-none z-30 overflow-hidden"
        style={{
          left: `${previewLeft}px`,
          width: `${previewWidth}px`,
          minWidth: '24px',
          backgroundColor: tone.background,
          borderColor: tone.border,
        }}
      >
        <div className="absolute inset-x-0 top-0 h-[3px]" style={{ backgroundColor: tone.accent }} />
        <div className="absolute inset-0 bg-gradient-to-b from-white/15 to-transparent" />
        <div className="absolute top-[5px] left-1 right-1 flex items-center gap-1 min-w-0">
          <span className="text-[8px] uppercase tracking-wide font-semibold text-white/90">{typeLabel}</span>
          <span className="text-[9px] text-white/90 truncate">{assetDropPreview.name}</span>
        </div>
        <div className="absolute bottom-1 right-1 text-[8px] text-white/85 bg-black/45 rounded px-1 py-0.5 font-mono">
          {assetDropPreview.duration.toFixed(1)}s
        </div>
        {assetDropPreview.willCreateTrack && (
          <div className="absolute bottom-1 left-1 text-[8px] text-white/85 bg-black/45 rounded px-1 py-0.5">
            + track on drop
          </div>
        )}
      </div>
    )
  }

  // Pixels per second based on zoom
  const pixelsPerSecond = zoom / 5

  // The zoom floor follows the content: never above the classic floor of
  // 20 (4 px/s), never below what frames the whole timeline — so hour-long
  // edits can zoom out far enough to see everything. 0.5 is the absolute
  // floor (~4 hours visible in a typical viewport).
  const getMinZoom = useCallback(() => {
    const visibleWidth = timelineRef.current?.clientWidth || 0
    if (visibleWidth <= 0) return 20
    let startTime = 0
    let endTime = duration
    if (clips.length > 0) {
      startTime = Math.min(...clips.map(c => c.startTime))
      endTime = Math.max(...clips.map(c => c.startTime + c.duration))
    }
    const timeSpan = Math.max(0.5, endTime - startTime)
    const fitZoom = (5 * visibleWidth * 0.95) / timeSpan
    return Math.max(0.5, Math.min(20, fitZoom))
  }, [clips, duration])
  const sliderMinZoom = Math.max(1, Math.floor(getMinZoom()))

  // A selection focus is transient navigation, not a document edit. Keep one
  // baseline across selection changes and manual panning; Frame All clears it.
  const selectionViewBlockedRef = useRef(false)
  selectionViewBlockedRef.current = !!(trimState || rippleTrimState || rollEditState || slipState || slideState
    || clipDragState || fadeDragState || transitionDragState || marqueeState || pendingLanePointerState
    || isScrubbing || isPanning || isResizingHeaders || trackDragState || trackResizeState
    || isDragging || draggedAssetId || draggedAssetIds.length || moveOffsetDialogOpen || durationDeltaDialogOpen)
  const getSelectionViewKey = (ids) => JSON.stringify([...new Set(ids || [])].sort())
  const canChangeSelectionView = useCallback(() => {
    if (selectionViewBlockedRef.current || selectionViewPointerDownRef.current || pasteAttributesOpenRef.current
      || scrubGestureRef.current || trimGestureRef.current || rippleTrimGestureRef.current || rollGestureRef.current || slipGestureRef.current || slideGestureRef.current) return false
    // Some older app dialogs predate aria-modal. Their visible full-screen
    // backdrops must shield this global command too (for example Settings).
    return ![...document.querySelectorAll('[aria-modal="true"], [role="dialog"], .fixed.inset-0')]
      .some((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
  }, [])

  useEffect(() => {
    const pointerDown = () => { selectionViewPointerDownRef.current = true }
    const pointerUp = () => { selectionViewPointerDownRef.current = false }
    const unsubscribe = useTimelineStore.subscribe((state, previous) => {
      if (state.timelineSessionId === previous.timelineSessionId && state.compoundEditContext === previous.compoundEditContext) return
      selectionViewRef.current = null
      pendingSelectionViewRef.current = null
      viewportNavigationSequenceRef.current += 1
      setSelectionViewRevision((revision) => revision + 1)
    })
    window.addEventListener('pointerdown', pointerDown, true)
    window.addEventListener('pointerup', pointerUp, true)
    window.addEventListener('pointercancel', pointerUp, true)
    window.addEventListener('blur', pointerUp)
    return () => {
      unsubscribe()
      selectionViewRef.current = null
      pendingSelectionViewRef.current = null
      viewportNavigationSequenceRef.current += 1
      window.removeEventListener('pointerdown', pointerDown, true)
      window.removeEventListener('pointerup', pointerUp, true)
      window.removeEventListener('pointercancel', pointerUp, true)
      window.removeEventListener('blur', pointerUp)
    }
  }, [])

  const handleZoomToSelection = useCallback(({ focusTimeline = false } = {}) => {
    const viewport = timelineRef.current
    const content = trackContentRef.current
    if (!viewport || !content || !canChangeSelectionView()) return
    const state = useTimelineStore.getState()
    const selectionKey = getSelectionViewKey(state.selectedClipIds)
    let saved = selectionViewRef.current
    if (saved && (saved.sessionId !== state.timelineSessionId || saved.context !== state.compoundEditContext)) saved = null
    const restore = saved && (saved.selectionKey === selectionKey || !state.selectedClipIds.length)
    const fit = restore ? null : resolveTimelineSelectionViewport({
      clips: state.clips, selectedClipIds: state.selectedClipIds, viewportWidth: viewport.clientWidth,
    })
    if (!restore && !fit) return

    let scrollTop = saved?.scrollTop ?? content.scrollTop
    if (!restore) {
      const selected = new Set(state.selectedClipIds.map(String))
      const contentRect = content.getBoundingClientRect()
      const lanes = [...content.querySelectorAll('[data-clip-id]')]
        .filter((element) => selected.has(element.dataset.clipId))
        .map((element) => element.closest('[data-track-lane]')?.getBoundingClientRect())
        .filter(Boolean)
      if (lanes.length) {
        const top = Math.min(...lanes.map((rect) => rect.top)) - contentRect.top + content.scrollTop
        const bottom = Math.max(...lanes.map((rect) => rect.bottom)) - contentRect.top + content.scrollTop
        scrollTop = Math.max(0, top - Math.max(0, (content.clientHeight - (bottom - top)) / 2))
      }
      selectionViewRef.current = {
        ...(saved || { zoom: state.zoom, scrollLeft: viewport.scrollLeft, scrollTop: content.scrollTop }),
        sessionId: state.timelineSessionId, context: state.compoundEditContext, selectionKey,
      }
    } else {
      selectionViewRef.current = null
    }
    const nextZoom = restore ? saved.zoom : fit.zoom
    pendingSelectionViewRef.current = {
      sequence: ++viewportNavigationSequenceRef.current,
      sessionId: state.timelineSessionId, context: state.compoundEditContext, selectionKey,
      zoom: nextZoom, scrollLeft: restore ? saved.scrollLeft : fit.scrollLeft, scrollTop, focusTimeline,
    }
    state.setZoom(nextZoom, { navigationOnly: true })
    setSelectionViewRevision((revision) => revision + 1)
  }, [canChangeSelectionView])

  useLayoutEffect(() => {
    const pending = pendingSelectionViewRef.current
    if (!pending) return
    pendingSelectionViewRef.current = null
    const state = useTimelineStore.getState()
    if (pending.sequence !== viewportNavigationSequenceRef.current || pending.sessionId !== state.timelineSessionId
      || pending.context !== state.compoundEditContext || pending.selectionKey !== getSelectionViewKey(state.selectedClipIds)
      || pending.zoom !== state.zoom || !timelineRef.current || !trackContentRef.current) return
    const viewport = timelineRef.current
    const content = trackContentRef.current
    viewport.scrollLeft = Math.max(0, Math.min(pending.scrollLeft, viewport.scrollWidth - viewport.clientWidth))
    content.scrollTop = Math.max(0, Math.min(pending.scrollTop, content.scrollHeight - content.clientHeight))
    if (trackHeadersRef.current) trackHeadersRef.current.scrollTop = content.scrollTop
    if (pending.focusTimeline) viewport.focus({ preventScroll: true })
  }, [zoom, selectionViewRevision])

  const selectionViewWillRestore = !!selectionViewRef.current
    && (selectionViewRef.current.selectionKey === getSelectionViewKey(selectedClipIds) || !selectedClipIds.length)

  // Zoom with playhead as pivot so the timeline zooms into/out of the playhead position
  const applyZoomWithPlayheadPivot = useCallback((newZoomValue) => {
    const sequence = ++viewportNavigationSequenceRef.current
    pendingSelectionViewRef.current = null
    const clamped = Math.max(getMinZoom(), Math.min(2000, newZoomValue))
    if (clamped === zoom) return
    if (!timelineRef.current) {
      setZoom(clamped)
      return
    }
    const playheadPosition = getLivePlayhead()
    const scrollLeft = timelineRef.current.scrollLeft
    const playheadViewportX = playheadPosition * pixelsPerSecond - scrollLeft
    setZoom(clamped)
    const newPixelsPerSecond = clamped / 5
    requestAnimationFrame(() => {
      if (timelineRef.current && sequence === viewportNavigationSequenceRef.current) {
        const el = timelineRef.current
        const newScrollLeft = playheadPosition * newPixelsPerSecond - playheadViewportX
        el.scrollLeft = Math.max(0, Math.min(newScrollLeft, el.scrollWidth - el.clientWidth))
      }
    })
  }, [getMinZoom, pixelsPerSecond, setZoom, zoom])

  // Frame all: fit full timeline or all clips in view
  const handleFrameAll = useCallback(() => {
    const sequence = ++viewportNavigationSequenceRef.current
    pendingSelectionViewRef.current = null
    selectionViewRef.current = null
    setSelectionViewRevision((revision) => revision + 1)
    if (!timelineRef.current) return
    const visibleWidth = timelineRef.current.clientWidth
    if (visibleWidth <= 0) return
    let startTime = 0
    let endTime = duration
    if (clips.length > 0) {
      startTime = Math.min(...clips.map(c => c.startTime))
      endTime = Math.max(...clips.map(c => c.startTime + c.duration))
    }
    const timeSpan = Math.max(0.5, endTime - startTime)
    const padding = 0.95
    const newZoom = Math.max(0.5, Math.min(2000, (5 * visibleWidth * padding) / timeSpan))
    setZoom(newZoom)
    const newPixelsPerSecond = newZoom / 5
    requestAnimationFrame(() => {
      if (timelineRef.current && sequence === viewportNavigationSequenceRef.current) {
        timelineRef.current.scrollLeft = Math.max(0, startTime * newPixelsPerSecond)
      }
    })
  }, [clips, duration, setZoom])

  // Filtered tracks by type (moved up for use in effects)
  const videoTracks = tracks.filter(t => t.type === 'video')
  const audioTracks = tracks.filter(t => t.type === 'audio')
  const visibleTrackIds = useMemo(() => (
    new Set(
      tracks
        .filter((track) => track?.visible !== false)
        .map((track) => track.id)
    )
  ), [tracks])
  const visibleClipBoundaryTimes = useMemo(() => {
    const boundaries = clips
      .filter((clip) => visibleTrackIds.has(clip.trackId))
      .flatMap((clip) => {
        const clipStart = Math.max(0, Number(clip.startTime) || 0)
        const clipEnd = Math.max(clipStart, clipStart + (Number(clip.duration) || 0))
        return [clipStart, clipEnd]
      })
      .sort((a, b) => a - b)

    return boundaries.filter((time, index) => (
      index === 0 || Math.abs(time - boundaries[index - 1]) > 0.0001
    ))
  }, [clips, visibleTrackIds])
  const markerNavigationTargets = useMemo(() => (
    [...markers]
      .filter((marker) => Number.isFinite(Number(marker?.time)))
      .sort((a, b) => a.time - b.time)
  ), [markers])
  const autoCreateVideoTrackIndicatorVisible = Boolean(clipDragState?.pendingAutoCreateVideoTrack)
  const autoCreateVideoTrackIndicatorHeight = videoTracks[0]
    ? getTrackHeight(videoTracks[0])
    : getDefaultTrackHeight({ type: 'video' })

  const getClipTrackFamily = useCallback((clip) => {
    if (clip?.type === 'audio') return 'audio'
    return 'video'
  }, [])

  const getTracksForFamily = useCallback((family) => (
    family === 'audio' ? audioTracks : videoTracks
  ), [audioTracks, videoTracks])

  const getHoveredTrackIdForFamily = useCallback((relativeY, family) => {
    const relevantTracks = getTracksForFamily(family)
    if (relevantTracks.length === 0) return null

    const audioSectionHeight = 20
    const totalVideoTracksHeight = videoTracks.reduce((sum, track) => sum + getTrackHeight(track), 0)
    let currentY = family === 'video' ? 0 : totalVideoTracksHeight + audioSectionHeight

    for (const track of relevantTracks) {
      const height = getTrackHeight(track)
      if (relativeY >= currentY && relativeY < currentY + height) {
        return track.locked ? null : track.id
      }
      currentY += height
    }

    return null
  }, [getTracksForFamily, videoTracks, trackHeights])

  const getResolvedGroupTrackDelta = useCallback((originalPositions, requestedDelta) => {
    const numericDelta = Number(requestedDelta)
    if (!Number.isFinite(numericDelta) || numericDelta === 0) return 0

    const step = numericDelta > 0 ? -1 : 1
    for (
      let candidate = Math.trunc(numericDelta);
      numericDelta > 0 ? candidate >= 0 : candidate <= 0;
      candidate += step
    ) {
      const isValid = originalPositions.every((entry) => {
        const relevantTracks = getTracksForFamily(entry.family)
        const originalIndex = relevantTracks.findIndex((track) => track.id === entry.trackId)
        if (originalIndex < 0) return false
        const nextTrack = relevantTracks[originalIndex + candidate]
        return Boolean(nextTrack && !nextTrack.locked)
      })

      if (isValid) return candidate
    }

    return 0
  }, [getTracksForFamily])

  function getTimeFromClientX(clientX) {
    if (!timelineRef.current) return 0
    const rect = timelineRef.current.getBoundingClientRect()
    const x = clientX - rect.left + timelineRef.current.scrollLeft
    const time = Math.max(0, Math.min(duration, x / pixelsPerSecond))
    return quantizeTimeToFrame(time, timecodeFps)
  }

  // Calculate time from mouse position
  function getTimeFromMouseEvent(e) {
    return getTimeFromClientX(e.clientX)
  }

  function getTimelinePointerPosition(clientX, clientY) {
    if (!timelineRef.current) return null
    const rect = timelineRef.current.getBoundingClientRect()
    return {
      x: clientX - rect.left + timelineRef.current.scrollLeft,
      y: clientY - rect.top + (trackContentRef.current?.scrollTop || 0),
    }
  }

  const startTimelinePanning = (e) => {
    e.preventDefault()
    setIsPanning(true)
    setPanStart({
      x: e.clientX,
      y: e.clientY,
      scrollLeft: timelineRef.current?.scrollLeft || 0,
      scrollTop: trackContentRef.current?.scrollTop || 0
    })
  }

  const startTimelinePreview = () => {
    if (clips.length > 0) {
      setPreviewMode('timeline')
      if (assetIsPlaying) {
        setAssetIsPlaying(false)
      }
    }
  }

  const handleTimelinePointerFocus = (event) => {
    const target = event.target
    // Scrub/drag handlers prevent the browser's normal focus transfer. Claim
    // focus before those handlers run, or Space keeps typing into the Agent
    // (or another previously focused field) after a timeline gesture.
    // Portalled dialogs and inline controls keep their own keyboard ownership.
    if (event.button !== 0 || event.isPrimary === false
      || !event.currentTarget.contains(target) || hasVisibleKeyboardModal()
      || isTextEditingElement(target)
      || target.closest('input, textarea, select, summary, a[href], button:not([data-marker-handle]), [role="button"], [role="textbox"], [role="combobox"], [role="spinbutton"], [role="slider"], [role="separator"], [role="menu"], [role="menuitem"], [role="listbox"]')) return
    timelineRef.current?.focus({ preventScroll: true })
  }

  // Container clicks should only pan/marquee. Playhead scrubbing starts from the ruler or playhead handle.
  const handleTimelineMouseDown = (e) => {
    // Don't start scrubbing if clicking on a clip or trim handle
    if (e.target.closest('[data-clip]') || e.target.closest('[data-trim-handle]') || e.target.closest('[data-marker-handle]')) {
      return
    }

    // Check for spacebar held - start panning
    if (spacePanningKeyDownRef.current) {
      startTimelinePanning(e)
      return
    }

    // Check for Alt+Click to start marquee selection
    if (e.altKey) {
      e.preventDefault()
      startTimelinePreview()
      const pointer = getTimelinePointerPosition(e.clientX, e.clientY)
      if (!pointer) return
      const addToSelection = e.shiftKey || e.ctrlKey || e.metaKey
      // Start marquee selection
      setMarqueeState({
        startX: pointer.x,
        startY: pointer.y,
        currentX: pointer.x,
        currentY: pointer.y,
        scrollLeft: timelineRef.current.scrollLeft,
        scrollTop: trackContentRef.current?.scrollTop || 0,
        addToSelection,
      })
      
      // Clear selection unless Shift is held (to add to selection)
      if (!addToSelection) {
        clearSelection()
      }
      return
    }

    // Normal timeline clicks are selection/scrolling only; playhead movement belongs to the ruler/handle.
  }

  const cancelTimelineScrub = useCallback(({ updateUi = true } = {}) => {
    const gesture = scrubGestureRef.current
    if (!gesture) return
    scrubGestureRef.current = null
    gesture.scheduler?.cancel()
    gesture.cleanup?.()
    if (updateUi) setIsScrubbing(false)
  }, [])

  // Set up synchronously on press: even a same-task move/release cannot get
  // lost while waiting for React effects. All coordinates remain CSS pixels.
  const beginTimelineScrub = (event, { ruler = false } = {}) => {
    if (event.button !== 0 || !Number.isFinite(event.clientX)) return
    event.stopPropagation()
    event.preventDefault()
    cancelTimelineScrub()
    const viewport = timelineRef.current
    if (!viewport) return
    if (ruler) startTimelinePreview()
    const initial = useTimelineStore.getState()
    const context = Object.fromEntries(SCRUB_CONTEXT_KEYS.map(key => [key, initial[key]]))
    const gesture = {
      viewport, tool: scrubToolRef.current, context, writing: false, moved: false,
      initialX: event.clientX, position: initial.playheadPosition,
      revision: initial.playheadSeekRevision, intent: initial.playheadSeekIntent,
      geometry: null, geometryDirty: true,
    }
    scrubGestureRef.current = gesture
    const isCurrent = (state = useTimelineStore.getState()) => (
      scrubGestureRef.current === gesture && viewport === timelineRef.current && viewport.isConnected
      && scrubToolRef.current === gesture.tool && SCRUB_CONTEXT_KEYS.every(key => state[key] === context[key])
      && (context.isPlaying
        ? state.playheadSeekIntent == null
        : state.playheadPosition === gesture.position && state.playheadSeekRevision === gesture.revision
          && state.playheadSeekIntent === gesture.intent)
    )
    const readGeometry = () => {
      const rect = viewport.getBoundingClientRect()
      gesture.geometry = { left: rect.left, right: rect.right, scrollLeft: viewport.scrollLeft,
        maxScrollLeft: Math.max(0, viewport.scrollWidth - viewport.clientWidth) }
      gesture.geometryDirty = false
      return gesture.geometry
    }
    const publish = (time, phase) => {
      if (!isCurrent()) { cancelTimelineScrub(); return }
      const state = useTimelineStore.getState()
      const precise = phase === 'release' && !state.isPlaying
      const revision = (Number(state.playheadSeekRevision) || 0) + 1
      gesture.writing = true
      try {
        state.setPlayheadPosition(time, precise ? { snap: true, intent: 'frame-step' } : { snap: true })
      } finally {
        gesture.writing = false
      }
      const result = useTimelineStore.getState()
      // Adopt only our known write, never an arbitrary synchronous subscriber's
      // navigation. A changed project/clock is discarded before another sample.
      const ownIntent = precise
        ? result.playheadSeekIntent?.type === 'frame-step' && result.playheadSeekIntent.targetTime === time
          && result.playheadSeekIntent.revision === revision
        : result.playheadSeekIntent === null
      if (scrubGestureRef.current !== gesture || !SCRUB_CONTEXT_KEYS.every(key => result[key] === context[key])
        || result.playheadPosition !== time || result.playheadSeekRevision !== revision || !ownIntent) {
        cancelTimelineScrub()
        return
      }
      gesture.position = time
      gesture.revision = revision
      gesture.intent = result.playheadSeekIntent
    }
    gesture.scheduler = createTimelineScrubScheduler({
      requestFrame: callback => requestAnimationFrame(callback), cancelFrame: frame => cancelAnimationFrame(frame),
      getCurrentPosition: () => useTimelineStore.getState().playheadPosition,
      forcePublish: (time, phase) => phase === 'release' && !useTimelineStore.getState().isPlaying
        && !isFrameStepSeekIntentAtTime(useTimelineStore.getState().playheadSeekIntent, time),
      readSample: (clientX, phase) => {
        if (!isCurrent()) { cancelTimelineScrub(); return null }
        const geometry = gesture.geometryDirty || phase === 'release' ? readGeometry() : gesture.geometry
        // A handle press/release without movement must not jump by its hit-box
        // offset. A moved/released coordinate still maps exactly under the hand.
        if (!ruler && phase === 'release' && !gesture.moved && clientX === gesture.initialX) {
          return { time: quantizeTimeToFrame(useTimelineStore.getState().playheadPosition, context.timelineFps), continue: false }
        }
        const options = { clientX, geometry, pixelsPerSecond: context.zoom / 5, duration: context.duration,
          fps: getSafeTimelineFps(context.timelineFps, FRAME_RATE), edgePixels: PLAYHEAD_SCRUB_AUTO_SCROLL_EDGE_PX,
          maxStepPixels: PLAYHEAD_SCRUB_AUTO_SCROLL_MAX_STEP_PX }
        let sample = resolveTimelineScrubSample({ ...options, autoScroll: phase === 'update' })
        if (!sample) return null
        if (sample.scrollLeft !== geometry.scrollLeft) {
          const before = geometry.scrollLeft
          viewport.scrollLeft = sample.scrollLeft
          // Only actual auto-scroll needs a post-write read. Central scrubbing
          // uses cached metrics and never alternates per-event layout reads/writes.
          geometry.scrollLeft = viewport.scrollLeft
          sample = { ...resolveTimelineScrubSample({ ...options, autoScroll: false }), continue: geometry.scrollLeft !== before }
        }
        return sample
      },
      onPosition: publish,
    })
    const invalidateGeometry = () => {
      gesture.geometryDirty = true
      gesture.scheduler.invalidate()
    }
    const move = event => {
      if (!isCurrent() || event.buttons === 0) { cancelTimelineScrub(); return }
      gesture.moved = true
      gesture.scheduler.move(event.clientX)
    }
    const release = event => {
      if (event.button !== 0) return
      if (!isCurrent()) { cancelTimelineScrub(); return }
      gesture.scheduler.finish(event.clientX)
      if (!isCurrent()) { cancelTimelineScrub(); return }
      cancelTimelineScrub()
      window.dispatchEvent(new CustomEvent('comfystudio:timeline-scrub-end'))
    }
    const cancel = () => cancelTimelineScrub()
    const escape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      cancel()
    }
    const unsubscribe = useTimelineStore.subscribe(state => { if (!gesture.writing && !isCurrent(state)) cancel() })
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(invalidateGeometry)
    resizeObserver?.observe(viewport)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', release)
    window.addEventListener('blur', cancel)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('scroll', invalidateGeometry, true)
    window.addEventListener('resize', invalidateGeometry)
    gesture.cleanup = () => {
      unsubscribe()
      resizeObserver?.disconnect()
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', release)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('scroll', invalidateGeometry, true)
      window.removeEventListener('resize', invalidateGeometry)
    }
    setIsScrubbing(true)
    readGeometry()
    gesture.scheduler.start(event.clientX, { deferInitial: !ruler, initialPosition: initial.playheadPosition })
  }

  const handleTimelineRulerMouseDown = event => {
    if (event.button !== 0 || event.target.closest('[data-marker-handle]')) return
    event.stopPropagation()
    if (spacePanningKeyDownRef.current) { startTimelinePanning(event); return }
    beginTimelineScrub(event, { ruler: true })
  }

  useLayoutEffect(() => { cancelTimelineScrub() }, [activeTimelineTool, cancelTimelineScrub])
  useEffect(() => () => cancelTimelineScrub({ updateUi: false }), [cancelTimelineScrub])

  useEffect(() => {
    if (!pendingLanePointerState) return

    const handleMouseMove = (e) => {
      const deltaX = e.clientX - pendingLanePointerState.startClientX
      const deltaY = e.clientY - pendingLanePointerState.startClientY
      if (Math.hypot(deltaX, deltaY) < MARQUEE_DRAG_THRESHOLD_PX) return

      const pointer = getTimelinePointerPosition(e.clientX, e.clientY)
      if (!pointer || !timelineRef.current) return

      if (!pendingLanePointerState.addToSelection) {
        clearSelection()
      }

      setMarqueeState({
        startX: pendingLanePointerState.startX,
        startY: pendingLanePointerState.startY,
        currentX: pointer.x,
        currentY: pointer.y,
        scrollLeft: timelineRef.current.scrollLeft,
        scrollTop: trackContentRef.current?.scrollTop || 0,
        addToSelection: pendingLanePointerState.addToSelection,
      })
      setPendingLanePointerState(null)
    }

    const handleMouseUp = () => {
      selectGap(pendingLanePointerState.gap)
      setPendingLanePointerState(null)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [pendingLanePointerState, clearSelection, getTimelinePointerPosition, selectGap])

  // Handle track headers resize
  useEffect(() => {
    if (!isResizingHeaders) return
    
    const handleMouseMove = (e) => {
      const deltaX = e.clientX - resizeStartX.current
      const newWidth = Math.max(TRACK_HEADERS_MIN, Math.min(TRACK_HEADERS_MAX, resizeStartWidth.current + deltaX))
      lastTrackHeadersWidthRef.current = newWidth
      setTrackHeadersWidth(newWidth)
    }
    
    const handleMouseUp = () => {
      const widthToSave = lastTrackHeadersWidthRef.current
      if (widthToSave != null) {
        try {
          localStorage.setItem(TRACK_HEADERS_STORAGE_KEY, String(widthToSave))
        } catch (_) {}
      }
      setIsResizingHeaders(false)
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
  }, [isResizingHeaders])

  // Handle marquee selection mouse move and mouse up
  useEffect(() => {
    if (!marqueeState) return
    
    const handleMouseMove = (e) => {
      if (!timelineRef.current) return
      const timelineRect = timelineRef.current.getBoundingClientRect()
      const maxScrollLeft = Math.max(0, timelineRef.current.scrollWidth - timelineRef.current.clientWidth)
      if (e.clientX > timelineRect.right - MARQUEE_AUTO_SCROLL_EDGE_PX) {
        timelineRef.current.scrollLeft = Math.min(maxScrollLeft, timelineRef.current.scrollLeft + MARQUEE_AUTO_SCROLL_STEP_PX)
      } else if (e.clientX < timelineRect.left + MARQUEE_AUTO_SCROLL_EDGE_PX) {
        timelineRef.current.scrollLeft = Math.max(0, timelineRef.current.scrollLeft - MARQUEE_AUTO_SCROLL_STEP_PX)
      }

      if (trackContentRef.current) {
        const trackRect = trackContentRef.current.getBoundingClientRect()
        const maxScrollTop = Math.max(0, trackContentRef.current.scrollHeight - trackContentRef.current.clientHeight)
        if (e.clientY > trackRect.bottom - MARQUEE_AUTO_SCROLL_EDGE_PX) {
          trackContentRef.current.scrollTop = Math.min(maxScrollTop, trackContentRef.current.scrollTop + MARQUEE_AUTO_SCROLL_STEP_PX)
        } else if (e.clientY < trackRect.top + MARQUEE_AUTO_SCROLL_EDGE_PX) {
          trackContentRef.current.scrollTop = Math.max(0, trackContentRef.current.scrollTop - MARQUEE_AUTO_SCROLL_STEP_PX)
        }
      }

      const pointer = getTimelinePointerPosition(e.clientX, e.clientY)
      if (!pointer) return
      setMarqueeState(prev => ({
        ...prev,
        currentX: pointer.x,
        currentY: pointer.y,
        scrollLeft: timelineRef.current.scrollLeft,
        scrollTop: trackContentRef.current?.scrollTop || 0,
      }))
    }
    
    const handleMouseUp = () => {
      if (!marqueeState || !timelineRef.current) {
        setMarqueeState(null)
        return
      }
      
      // Calculate marquee bounds in timeline coordinates
      const left = Math.min(marqueeState.startX, marqueeState.currentX)
      const right = Math.max(marqueeState.startX, marqueeState.currentX)
      const top = Math.min(marqueeState.startY, marqueeState.currentY)
      const bottom = Math.max(marqueeState.startY, marqueeState.currentY)
      
      // Convert to time range
      const startTime = left / pixelsPerSecond
      const endTime = right / pixelsPerSecond
      
      // Account for ruler height and track positions
      const rulerHeight = 20
      const audioSectionHeight = 20
      const totalVideoTracksHeight = videoTracks.reduce((sum, track) => sum + getTrackHeight(track), 0)
      
      // Find clips that intersect with the marquee
      const clipsToSelect = []
      
      clips.forEach(clip => {
        const clipEnd = clip.startTime + clip.duration
        if (!(clip.startTime >= endTime || clipEnd <= startTime)) {
          const track = tracks.find(t => t.id === clip.trackId)
          if (!track) return
          
          let clipY = rulerHeight
          const trackType = track.type
          
          if (trackType === 'video') {
            const videoTrackIndex = videoTracks.findIndex(t => t.id === clip.trackId)
            clipY += getTrackOffset(videoTracks, videoTrackIndex)
            const clipHeight = getTrackHeight(track)
            const clipBottom = clipY + clipHeight
            if (!(clipY >= bottom || clipBottom <= top)) clipsToSelect.push(clip.id)
          } else {
            const audioTrackIndex = audioTracks.findIndex(t => t.id === clip.trackId)
            clipY += totalVideoTracksHeight + audioSectionHeight + getTrackOffset(audioTracks, audioTrackIndex)
            const clipHeight = getTrackHeight(track)
            const clipBottom = clipY + clipHeight
            if (!(clipY >= bottom || clipBottom <= top)) clipsToSelect.push(clip.id)
          }
        }
      })
      
      // Select the intersecting clips
      if (clipsToSelect.length > 0) {
        if (marqueeState.addToSelection) {
          const newSelection = [...new Set([...selectedClipIds, ...clipsToSelect])]
          useTimelineStore.getState().selectClips(newSelection)
        } else {
          useTimelineStore.getState().selectClips(clipsToSelect)
        }
      }
      
      setMarqueeState(null)
    }
    
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [marqueeState, clips, tracks, videoTracks, audioTracks, pixelsPerSecond, selectedClipIds, getTimelinePointerPosition])

  const selectClipsFromPlayheadToEnd = useCallback(() => {
    const playheadPosition = getLivePlayhead()
    const clipsToSelect = clips
      .filter(c => (c.startTime + c.duration) > playheadPosition)
      .map(c => c.id)

    useTimelineStore.getState().selectClips(clipsToSelect)
    selectMarker(null)
  }, [clips, selectMarker])

  const selectClipsFromTimelineStartToPlayhead = useCallback(() => {
    const playheadPosition = getLivePlayhead()
    const clipsToSelect = clips
      .filter(c => c.startTime <= playheadPosition)
      .map(c => c.id)

    useTimelineStore.getState().selectClips(clipsToSelect)
    selectMarker(null)
  }, [clips, selectMarker])

  const closeMoveOffsetDialog = useCallback(() => {
    setMoveOffsetDialogOpen(false)
    setMoveOffsetError('')
  }, [])

  const closeDurationDeltaDialog = useCallback(() => {
    setDurationDeltaDialogOpen(false)
    setDurationDeltaError('')
  }, [])

  const openMoveOffsetDialog = useCallback(() => {
    if (selectedClipIds.length === 0) return
    setMoveOffsetMode('timecode')
    setMoveOffsetInput('+00:00:00:00')
    setMoveOffsetFramesInput('+0')
    setMoveOffsetError('')
    setMoveOffsetDialogOpen(true)
    setClipContextMenu(null)
    setMaskSubmenuOpen(false)
  }, [selectedClipIds.length])

  const openDurationDeltaDialog = useCallback(() => {
    if (selectedClipIds.length === 0) return
    setDurationDeltaMode('timecode')
    setDurationDeltaInput('+00:00:00:00')
    setDurationDeltaFramesInput('+0')
    setDurationDeltaError('')
    setDurationDeltaDialogOpen(true)
    setClipContextMenu(null)
    setMaskSubmenuOpen(false)
  }, [selectedClipIds.length])

  const applyMoveOffset = useCallback(() => {
    if (selectedClipIds.length === 0) {
      closeMoveOffsetDialog()
      return
    }

    const parsed = moveOffsetMode === 'frames'
      ? parseFrameOffsetInput(moveOffsetFramesInput, timecodeFps)
      : parseTimelineOffsetInput(moveOffsetInput, timecodeFps)
    if (!parsed.success) {
      setMoveOffsetError(parsed.error)
      return
    }

    const selectedClips = clips.filter(clip => selectedClipIds.includes(clip.id))
    if (selectedClips.length === 0) {
      closeMoveOffsetDialog()
      return
    }

    const proposed = selectedClips.map((clip) => ({
      id: clip.id,
      startTime: clip.startTime + parsed.seconds,
    }))
    const minStart = Math.min(...proposed.map(clip => clip.startTime))
    const shift = minStart < 0 ? -minStart : 0
    const updates = proposed.map((clip) => ({
      id: clip.id,
      startTime: clip.startTime + shift,
    }))

    const hasChange = updates.some((update) => {
      const original = selectedClips.find(clip => clip.id === update.id)
      return original && Math.abs(original.startTime - update.startTime) > 0.000001
    })

    if (!hasChange) {
      closeMoveOffsetDialog()
      return
    }

    saveToHistory()
    setSelectedClipsStartTimes(updates)
    moveSelectedClips(0, null, true)
    closeMoveOffsetDialog()
  }, [clips, closeMoveOffsetDialog, moveOffsetFramesInput, moveOffsetInput, moveOffsetMode, moveSelectedClips, saveToHistory, selectedClipIds, setSelectedClipsStartTimes, timecodeFps])

  const applyDurationDelta = useCallback(() => {
    if (selectedClipIds.length === 0) {
      closeDurationDeltaDialog()
      return
    }

    const parsed = durationDeltaMode === 'frames'
      ? parseFrameOffsetInput(durationDeltaFramesInput, timecodeFps)
      : parseTimelineOffsetInput(durationDeltaInput, timecodeFps)
    if (!parsed.success) {
      setDurationDeltaError(parsed.error)
      return
    }

    const fps = Math.max(1, Math.round(timecodeFps))
    const minDurationSec = 1 / fps
    const selectedClips = clips.filter(clip => selectedClipIds.includes(clip.id))
    if (selectedClips.length === 0) {
      closeDurationDeltaDialog()
      return
    }

    const updates = selectedClips.map((clip) => {
      const currentDuration = Math.max(minDurationSec, Number(clip.duration) || minDurationSec)
      const rightNeighbor = clips
        .filter(other =>
          other.id !== clip.id &&
          other.trackId === clip.trackId &&
          other.startTime >= clip.startTime + currentDuration - 0.000001
        )
        .sort((a, b) => a.startTime - b.startTime)[0]

      const neighborCap = rightNeighbor
        ? Math.max(minDurationSec, rightNeighbor.startTime - clip.startTime)
        : Infinity

      const timeScale = Math.max(0.0001, Number(getTimeScale(clip)) || 1)
      const trimStart = Math.max(0, Number(clip.trimStart) || 0)
      const sourceDuration = getClipSourceDurationForExtension(clip)
      const sourceCap = Number.isFinite(sourceDuration)
        ? Math.max(minDurationSec, (sourceDuration - trimStart) / timeScale)
        : Infinity

      const requestedDuration = currentDuration + parsed.seconds
      const nextDuration = Math.max(
        minDurationSec,
        Math.min(requestedDuration, neighborCap, sourceCap)
      )

      return {
        id: clip.id,
        duration: nextDuration,
      }
    })

    const changedUpdates = updates.filter((update) => {
      const original = selectedClips.find(clip => clip.id === update.id)
      return original && Math.abs((original.duration || 0) - update.duration) > 0.000001
    })

    if (changedUpdates.length === 0) {
      closeDurationDeltaDialog()
      return
    }

    saveToHistory()
    changedUpdates.forEach((update) => {
      resizeClip(update.id, update.duration)
    })
    closeDurationDeltaDialog()
  }, [clips, closeDurationDeltaDialog, durationDeltaFramesInput, durationDeltaInput, durationDeltaMode, resizeClip, saveToHistory, selectedClipIds, timecodeFps])

  useEffect(() => {
    if (!moveOffsetDialogOpen) return
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        closeMoveOffsetDialog()
      }
    }

    window.addEventListener('keydown', handleEscape)
    setTimeout(() => {
      moveOffsetInputRef.current?.focus()
      moveOffsetInputRef.current?.select()
    }, 0)
    return () => {
      window.removeEventListener('keydown', handleEscape)
    }
  }, [closeMoveOffsetDialog, moveOffsetDialogOpen, moveOffsetMode])

  useEffect(() => {
    if (!durationDeltaDialogOpen) return
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        closeDurationDeltaDialog()
      }
    }

    window.addEventListener('keydown', handleEscape)
    setTimeout(() => {
      durationDeltaInputRef.current?.focus()
      durationDeltaInputRef.current?.select()
    }, 0)
    return () => {
      window.removeEventListener('keydown', handleEscape)
    }
  }, [closeDurationDeltaDialog, durationDeltaDialogOpen, durationDeltaMode])

  useEffect(() => {
    let isMounted = true
    let hotkeysChanged = false

    getEditorHotkeys().then((next) => {
      if (isMounted && !hotkeysChanged) setEditorHotkeys(next)
    }).catch(() => {
      if (isMounted && !hotkeysChanged) setEditorHotkeys(DEFAULT_EDITOR_HOTKEYS)
    })

    const handleHotkeysChanged = (event) => {
      hotkeysChanged = true
      if (event?.detail) {
        setEditorHotkeys(event.detail)
      } else {
        setEditorHotkeys(DEFAULT_EDITOR_HOTKEYS)
      }
    }

    window.addEventListener(EDITOR_HOTKEYS_CHANGED_EVENT, handleHotkeysChanged)
    return () => {
      isMounted = false
      window.removeEventListener(EDITOR_HOTKEYS_CHANGED_EVENT, handleHotkeysChanged)
    }
  }, [])

  // The add-clip actions only know a few fields, so the right-hand piece is
  // completed here with everything else authored on the uncut clip.
  const finishSplitRightPiece = (clip, newClip, splitTime, remainder, rightLinkGroupId) => {
    if (!newClip?.id) return newClip
    const carryOver = buildSplitRightPieceCarryOver(clip, splitTime, { remainder, linkGroupId: rightLinkGroupId })
    const leftUpdates = buildSplitLeftPieceUpdates(clip, splitTime, remainder)
    let finished = newClip
    useTimelineStore.setState((state) => ({
      clips: state.clips.map((candidate) => {
        if (candidate.id === newClip.id) {
          const { linkGroupId: _unlinked, ...unlinkedCandidate } = candidate
          finished = { ...unlinkedCandidate, ...carryOver }
          return finished
        }
        if (leftUpdates && candidate.id === clip.id) return { ...candidate, ...leftUpdates }
        return candidate
      }),
    }))
    return finished
  }

  const splitClipAtTime = useCallback((clip, splitPosition, { saveHistory = false, rightLinkGroupId = null } = {}) => {
    const snappedSplitPosition = quantizeTimeToFrame(splitPosition, getSafeTimelineFps(timelineFps))
    if (!clip || clip.type === 'compound' || isSyncLockedClip(clip) || snappedSplitPosition <= clip.startTime || snappedSplitPosition >= clip.startTime + clip.duration) return null

    const splitTime = snappedSplitPosition - clip.startTime
    const remainder = clip.duration - splitTime
    const track = tracks.find((candidate) => candidate.id === clip.trackId)

    let asset = null
    if (clip.type !== 'text' && clip.type !== 'shape' && clip.type !== 'adjustment') {
      asset = assets.find(a => a.id === clip.assetId)
      if (!asset) return null
    }

    if (saveHistory) {
      saveToHistory()
    }

    resizeClip(clip.id, splitTime)
    const audioSplitState = buildAudioClipSplitState(clip, track, asset, {
      left: splitTime,
      right: remainder,
    })
    if (audioSplitState) {
      useTimelineStore.setState((state) => ({
        clips: state.clips.map((candidate) => (
          candidate.id === clip.id
            ? { ...candidate, ...audioSplitState.leftClipUpdates }
            : candidate
        )),
      }))
    }

    if (clip.type === 'text') {
      const textOptions = {
        ...(clip.textProperties || {}),
        duration: remainder,
        enabled: isClipEnabled(clip),
        effects: clip.effects,
        saveHistory: false,
      }
      return finishSplitRightPiece(clip, addTextClip(clip.trackId, textOptions, snappedSplitPosition), splitTime, remainder, rightLinkGroupId)
    }

    if (clip.type === 'shape') {
      return finishSplitRightPiece(clip, addShapeClip(clip.trackId, {
        shapeProperties: clip.shapeProperties || {},
        duration: remainder,
        name: clip.name,
        transform: clip.transform || {},
        enabled: isClipEnabled(clip),
        effects: clip.effects,
        saveHistory: false,
      }, snappedSplitPosition), splitTime, remainder, rightLinkGroupId)
    }

    if (clip.type === 'adjustment') {
      return finishSplitRightPiece(clip, addAdjustmentClip(clip.trackId, snappedSplitPosition, {
        duration: remainder,
        name: clip.name,
        adjustments: clip.adjustments || {},
        transform: clip.transform || {},
        enabled: isClipEnabled(clip),
        effects: clip.effects,
        saveHistory: false,
      }), splitTime, remainder, rightLinkGroupId)
    }

    const timeScale = getTimeScale(clip)
    const sourceTimeAtCut = (clip.trimStart || 0) + splitTime * timeScale
    const sourceTrimEnd = sourceTimeAtCut + remainder * timeScale

    // Retiming goes in with the add so the new piece is measured against
    // its source at the right speed (a slowed clip would otherwise be cut short).
    return finishSplitRightPiece(clip, addClip(clip.trackId, audioSplitState?.asset || asset, snappedSplitPosition, timelineFps, {
      duration: remainder,
      trimStart: sourceTimeAtCut,
      trimEnd: sourceTrimEnd,
      enabled: isClipEnabled(clip),
      transform: clip.transform,
      effects: clip.effects,
      frameSampling: clip.type === 'video' ? clip.frameSampling : undefined,
      sourceTimeScale: clip.sourceTimeScale,
      sourceFps: clip.sourceFps,
      timelineFps: clip.timelineFps,
      speed: clip.speed,
      reverse: clip.reverse === true,
      ...(audioSplitState?.rightClipOptions || {}),
      saveHistory: false,
    }), splitTime, remainder, rightLinkGroupId)
  }, [assets, tracks, saveToHistory, resizeClip, addTextClip, addShapeClip, addAdjustmentClip, addClip, timelineFps, isClipEnabled])

  // Cut several clips at one time. Right-hand pieces that came from the same
  // link stay linked to each other, under a link of their own, so the left
  // and right sides of the cut select and move separately.
  const splitClipsTogether = useCallback((clipsToSplit, time) => {
    const linkCounts = new Map()
    for (const clip of clipsToSplit) {
      const linkId = typeof clip.linkGroupId === 'string' ? clip.linkGroupId.trim() : ''
      if (linkId) linkCounts.set(linkId, (linkCounts.get(linkId) || 0) + 1)
    }
    const seed = `${useTimelineStore.getState().clipCounter || 0}-${Date.now().toString(36)}`
    const rightLinkIds = new Map()
    for (const [linkId, count] of linkCounts) {
      if (count > 1) rightLinkIds.set(linkId, `link-split-${seed}-${rightLinkIds.size}`)
    }
    const created = []
    for (const clip of clipsToSplit) {
      const linkId = typeof clip.linkGroupId === 'string' ? clip.linkGroupId.trim() : ''
      const newClip = splitClipAtTime(clip, time, {
        saveHistory: false,
        rightLinkGroupId: rightLinkIds.get(linkId) || null,
      })
      if (newClip?.id) created.push(newClip)
    }
    return created
  }, [splitClipAtTime])

  const splitAllTracksAtPlayhead = useCallback(() => {
    const playheadPosition = getLivePlayhead()
    const clipsToSplit = clips.filter(
      c => playheadPosition > c.startTime && playheadPosition < c.startTime + c.duration
    )

    if (clipsToSplit.length === 0 || clipsToSplit.some(clip => clip.type === 'compound')) return

    saveToHistory()

    const newClipIds = splitClipsTogether(clipsToSplit, playheadPosition).map((newClip) => newClip.id)

    if (newClipIds.length > 0) {
      useTimelineStore.getState().selectClips(newClipIds)
      selectMarker(null)
    }
  }, [clips, saveToHistory, splitClipsTogether, selectMarker])

  // Cutting one side of a linked picture-and-sound pair cuts the other too,
  // as one undo step. Returns the new piece of the clip that was asked for.
  const splitClipWithLinked = useCallback((clip, splitPosition) => {
    if (!clip) return null
    const state = useTimelineStore.getState()
    const time = quantizeTimeToFrame(splitPosition, getSafeTimelineFps(state.timelineFps))
    const linkId = typeof clip.linkGroupId === 'string' ? clip.linkGroupId.trim() : ''
    const mates = linkId ? state.clips.filter((candidate) => (
      candidate.id !== clip.id
      && typeof candidate.linkGroupId === 'string' && candidate.linkGroupId.trim() === linkId
      && candidate.type !== 'compound' && !isSyncLockedClip(candidate)
      && time > candidate.startTime && time < candidate.startTime + candidate.duration
      && state.tracks.find((track) => track.id === candidate.trackId)?.locked !== true
    )) : []
    if (mates.length === 0) return splitClipAtTime(clip, time, { saveHistory: true })
    if (clip.type === 'compound' || isSyncLockedClip(clip) || time <= clip.startTime || time >= clip.startTime + clip.duration) return null
    saveToHistory()
    const created = splitClipsTogether([clip, ...mates], time)
    return created[0] || null
  }, [saveToHistory, splitClipAtTime, splitClipsTogether])

  const handleSplitClipAtPlayhead = useCallback((clip) => {
    if (!clip) return false
    splitClipWithLinked(clip, getLivePlayhead())
    return true
  }, [splitClipWithLinked])

  const handleSplitActiveTrackAtPlayhead = useCallback(() => {
    const state = useTimelineStore.getState()
    const clip = getActiveTrackSplitTarget(state)
    if (!clip) return false
    return Boolean(splitClipWithLinked(clip, state.playheadPosition))
  }, [splitClipWithLinked])

  const ensureTimelineTimeVisible = useCallback((time) => {
    if (!timelineRef.current || !Number.isFinite(Number(time))) return

    const el = timelineRef.current
    const targetX = Number(time) * pixelsPerSecond
    const visibleLeft = el.scrollLeft
    const visibleRight = visibleLeft + el.clientWidth
    const padding = Math.max(80, el.clientWidth * 0.18)
    const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)

    if (targetX > visibleRight - padding) {
      const nextScrollLeft = Math.max(0, targetX - (el.clientWidth * 0.35))
      el.scrollLeft = Math.min(nextScrollLeft, maxScrollLeft)
      return
    }

    if (targetX < visibleLeft + padding) {
      el.scrollLeft = Math.max(0, Math.min(targetX - padding, maxScrollLeft))
    }
  }, [pixelsPerSecond])

  const jumpPlayheadToClipBoundary = useCallback((direction) => {
    if (!Number.isFinite(direction) || direction === 0 || visibleClipBoundaryTimes.length === 0) return false

    const epsilon = 0.0001
    let targetTime = null

    const playheadPosition = getLivePlayhead()
    if (direction > 0) {
      targetTime = visibleClipBoundaryTimes.find((time) => time > playheadPosition + epsilon) ?? null
    } else {
      for (let i = visibleClipBoundaryTimes.length - 1; i >= 0; i -= 1) {
        if (visibleClipBoundaryTimes[i] < playheadPosition - epsilon) {
          targetTime = visibleClipBoundaryTimes[i]
          break
        }
      }
    }

    if (targetTime === null) return false
    setPlayheadPosition(targetTime, { snap: true })
    ensureTimelineTimeVisible(targetTime)
    return true
  }, [ensureTimelineTimeVisible, setPlayheadPosition, visibleClipBoundaryTimes])

  const jumpPlayheadToMarker = useCallback((direction) => {
    if (!Number.isFinite(direction) || direction === 0 || markerNavigationTargets.length === 0) return false

    const epsilon = 0.0001
    let targetMarker = null

    const playheadPosition = getLivePlayhead()
    if (direction > 0) {
      targetMarker = markerNavigationTargets.find((marker) => marker.time > playheadPosition + epsilon) ?? null
    } else {
      for (let i = markerNavigationTargets.length - 1; i >= 0; i -= 1) {
        if (markerNavigationTargets[i].time < playheadPosition - epsilon) {
          targetMarker = markerNavigationTargets[i]
          break
        }
      }
    }

    if (!targetMarker) return false
    setPlayheadPosition(targetMarker.time, { snap: true })
    ensureTimelineTimeVisible(targetMarker.time)
    selectMarker(targetMarker.id)
    return true
  }, [ensureTimelineTimeVisible, markerNavigationTargets, selectMarker, setPlayheadPosition])

  // Envelope point editing is local to one selection and tool context.
  const audioEnvelopeTargetId = useMemo(() => (
    getSingleAudioEnvelopeTarget(clips, tracks, selectedClipIds)?.id
  ), [clips, tracks, selectedClipIds])
  const audioEnvelopeSelectionKey = JSON.stringify(selectedClipIds)
  useEffect(() => {
    resetAudioVolumeEnvelopeEditor()
    return resetAudioVolumeEnvelopeEditor
  }, [audioEnvelopeSelectionKey, activeTimelineTool])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Native text Copy owns the key even when selecting a reply left focus
      // on the timeline. Check before custom bindings as well as clip Copy.
      if (isNativeTextKeyboardEvent(e)) return
      // A modal owns authoring keys as well as transport, including Undo
      // before the ordinary non-dialog text/focus rules below.
      if (hasVisibleKeyboardModal()) return
      if (pasteAttributesOpenRef.current) return
      if (e.target?.closest?.('[data-audio-envelope-editor]')
        && !((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(String(e.key).toLowerCase()) && !isTextEditingElement(e.target))) return
      const key = String(e.key || '').toLowerCase()
      if (key === 'escape' && (useTimelineStore.getState().playAround || e.defaultPrevented)) {
        useTimelineStore.getState().cancelPlayAround()
        e.preventDefault()
        return
      }
      // TransportControls owns this configurable command (and its modal/input
      // guards). Do not also interpret a custom binding as a tool shortcut.
      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.PLAY_AROUND])) return

      // Keep timeline undo/redo responsive even if focus was left on a non-dialog control.
      // If one of the exact-edit dialogs is open, let the input field keep native text undo.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === 'z') {
        if (moveOffsetDialogOpen || durationDeltaDialogOpen) return
        e.preventDefault()
        handleUndoAction()
        return
      }

      if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && key === 'z') || key === 'y')) {
        if (moveOffsetDialogOpen || durationDeltaDialogOpen) return
        e.preventDefault()
        handleRedoAction()
        return
      }

      // Don't trigger when typing text. Sliders can keep focus while editor
      // shortcuts like Space, V/T/B/Y, and zoom still feel global.
      const active = document.activeElement
      if (isTextEditingElement(active)) return

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.ZOOM_TO_SELECTION])) {
        if (e.repeat || isTextEditingElement(e.target)
          || e.target?.closest?.('input, textarea, select, [contenteditable="true"]')
          || active?.closest?.('input, textarea, select, [contenteditable="true"]')) return
        e.preventDefault()
        handleZoomToSelection()
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.FRAME_ALL])) {
        e.preventDefault()
        handleFrameAll()
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.ZOOM_OUT])) {
        e.preventDefault()
        applyZoomWithPlayheadPivot(zoom - 20)
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.ZOOM_IN])) {
        e.preventDefault()
        applyZoomWithPlayheadPivot(zoom + 20)
        return
      }

      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (key === 'a') {
          e.preventDefault()
          setActiveTimelineTool(TIMELINE_TOOLS.AUTO)
          return
        }
        if (key === 'v') {
          e.preventDefault()
          setActiveTimelineTool(TIMELINE_TOOLS.SELECT)
          return
        }
        if (key === 't' && !e.shiftKey) {
          e.preventDefault()
          setActiveTimelineTool(TIMELINE_TOOLS.TRIM)
          return
        }
        if (key === 'b') {
          e.preventDefault()
          setActiveTimelineTool(TIMELINE_TOOLS.RAZOR)
          return
        }
        if (key === 'y') {
          e.preventDefault()
          setActiveTimelineTool(TIMELINE_TOOLS.SLIP)
          return
        }
        if (key === 'u' && !e.shiftKey && slideShortcutAvailable) {
          if (e.repeat || isTextEditingElement(e.target) || moveOffsetDialogOpen || durationDeltaDialogOpen
            || [...document.querySelectorAll('[aria-modal="true"], [role="dialog"], .fixed.inset-0')]
              .some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')) return
          e.preventDefault()
          setActiveTimelineTool(TIMELINE_TOOLS.SLIDE)
          return
        }

        const isZoomInKey = e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '+'
        const isZoomOutKey = e.code === 'Minus' || e.code === 'NumpadSubtract' || e.key === '-'

        if (isZoomInKey) {
          e.preventDefault()
          applyZoomWithPlayheadPivot(zoom + 20)
          return
        }

        if (isZoomOutKey) {
          e.preventDefault()
          applyZoomWithPlayheadPivot(zoom - 20)
          return
        }
      }

      // Keyboard edits at the playhead / on the selection. These read the
      // live store, so they need nothing from this render's closure.
      const playheadEdit = [
        [EDITOR_HOTKEY_IDS.TRIM_START_TO_PLAYHEAD, () => trimToPlayhead(useTimelineStore, 'left')],
        [EDITOR_HOTKEY_IDS.TRIM_END_TO_PLAYHEAD, () => trimToPlayhead(useTimelineStore, 'right')],
        [EDITOR_HOTKEY_IDS.NUDGE_LEFT, () => nudgeSelectedClips(useTimelineStore, -1)],
        [EDITOR_HOTKEY_IDS.NUDGE_RIGHT, () => nudgeSelectedClips(useTimelineStore, 1)],
        [EDITOR_HOTKEY_IDS.NUDGE_LEFT_BIG, () => nudgeSelectedClips(useTimelineStore, -10)],
        [EDITOR_HOTKEY_IDS.NUDGE_RIGHT_BIG, () => nudgeSelectedClips(useTimelineStore, 10)],
      ].find(([hotkeyId]) => matchEditorHotkey(e, editorHotkeys[hotkeyId]))
      if (playheadEdit) {
        e.preventDefault()
        if (!moveOffsetDialogOpen && !durationDeltaDialogOpen) playheadEdit[1]()
        return
      }

      // Configurable editor actions
      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.OPEN_MOVE_BY])) {
        if (selectedClipIds.length > 0) {
          e.preventDefault()
          openMoveOffsetDialog()
        }
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.OPEN_DURATION_BY])) {
        if (selectedClipIds.length > 0) {
          e.preventDefault()
          openDurationDeltaDialog()
        }
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.ADD_TEXT_CLIP])) {
        const newClip = addTextClipAtPlayhead()
        if (newClip) {
          e.preventDefault()
        }
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.ADD_TRANSITION])) {
        if (addTransitionFromSelectedClips()) {
          e.preventDefault()
        }
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.LINK_SELECTION])) {
        if (selectedClipIds.length > 1 && !clips.some(clip => selectedClipIds.includes(clip.id) && clip.type === 'compound')) {
          e.preventDefault()
          linkSelectedClips()
        }
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.UNLINK_SELECTION])) {
        if (clips.some(clip => selectedClipIds.includes(clip.id) && clip.type === 'compound')) return
        const hasLinkedSelection = selectedClipIds.some((clipId) => {
          const clip = clips.find((candidate) => candidate.id === clipId)
          return Boolean(clip?.linkGroupId)
        })
        if (hasLinkedSelection) {
          e.preventDefault()
          unlinkSelectedClips()
        }
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.TOGGLE_CLIP_ENABLED])) {
        if (selectedClipIds.length > 0) {
          e.preventDefault()
          toggleClipSelectionEnabled()
        }
        return
      }
      
      // Configurable editor hotkeys
      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.TOGGLE_SNAPPING])) {
        e.preventDefault()
        toggleSnapping()
        return
      }
      
      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.TOGGLE_RIPPLE])) {
        e.preventDefault()
        toggleRippleEdit()
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.ADD_MARKER])) {
        e.preventDefault()
        addMarker(getLivePlayhead())
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.MATCH_FRAME])) {
        const matchClip = resolveMatchFrameClip()
        if (matchClip) {
          e.preventDefault()
          openMatchFrameForClip(matchClip)
        }
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.REVEAL_IN_ASSETS])) {
        const revealClip = resolveTargetedClip((clip) => Boolean(clip && clip.assetId))
        if (revealClip) {
          e.preventDefault()
          revealClipInAssetsPanel(revealClip)
        }
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.PREVIOUS_CLIP_BOUNDARY])) {
        e.preventDefault()
        jumpPlayheadToClipBoundary(-1)
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.NEXT_CLIP_BOUNDARY])) {
        e.preventDefault()
        jumpPlayheadToClipBoundary(1)
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.PREVIOUS_MARKER])) {
        e.preventDefault()
        jumpPlayheadToMarker(-1)
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.NEXT_MARKER])) {
        e.preventDefault()
        jumpPlayheadToMarker(1)
        return
      }
      
      // Delete/Backspace - delete selected clips or gaps, otherwise selected transition/marker
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (canDeleteCurrentSelection) {
          e.preventDefault()
          handleDeleteCurrentSelection()
        }
      }
      
      // Escape - clear selection
      if (e.key === 'Escape') {
        clearSelection()
        selectMarker(null)
      }
      
      // Ctrl/Cmd + A - select all clips
      if ((e.ctrlKey || e.metaKey) && key === 'a') {
        e.preventDefault()
        const allClipIds = clips.map(c => c.id)
        useTimelineStore.getState().selectClips(allClipIds)
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.SELECT_TO_END])) {
        e.preventDefault()
        selectClipsFromPlayheadToEnd()
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.SELECT_FROM_START])) {
        e.preventDefault()
        selectClipsFromTimelineStartToPlayhead()
        return
      }

      // Ctrl/Cmd + C - copy selected clips
      if ((e.ctrlKey || e.metaKey) && key === 'c') {
        if (selectedClipIds.length > 0) {
          e.preventDefault()
          handleCopySelection()
        }
      }

      // Ctrl/Cmd + V - paste at playhead on active track
      if ((e.ctrlKey || e.metaKey) && key === 'v') {
        if (activeTrackId && copiedClips.length > 0) {
          e.preventDefault()
          handlePasteAtPlayhead()
        }
      }
      
      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.SPLIT_ALL])) {
        e.preventDefault()
        splitAllTracksAtPlayhead()
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.SPLIT_ACTIVE])) {
        if (handleSplitActiveTrackAtPlayhead()) {
          e.preventDefault()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [toggleSnapping, toggleRippleEdit, addMarker, selectedClipIds, selectedGap, selectedTransitionId, selectedMarkerId, removeSelectedClips, rippleDeleteSelectedClips, rippleDeleteSelectedGap, removeTransition, removeMarker, clearSelection, selectMarker, clips, handleUndoAction, handleRedoAction, activeTrackId, saveToHistory, resizeClip, addClip, addTextClip, addShapeClip, addTextClipAtPlayhead, addShapeClipAtPlayhead, addAdjustmentClip, updateClipTrim, assets, timelineFps, copySelectedClips, pasteClipsAtPlayhead, copiedClips, selectClipsFromPlayheadToEnd, selectClipsFromTimelineStartToPlayhead, splitClipAtTime, splitAllTracksAtPlayhead, openMoveOffsetDialog, openDurationDeltaDialog, moveOffsetDialogOpen, durationDeltaDialogOpen, editorHotkeys, linkSelectedClips, unlinkSelectedClips, lockSyncClips, unlockSyncLockedClips, toggleClipSelectionEnabled, applyZoomWithPlayheadPivot, handleFrameAll, handleZoomToSelection, zoom, rippleEditMode, canDeleteCurrentSelection, handleCopySelection, handleDeleteCurrentSelection, handlePasteAtPlayhead, handleSplitActiveTrackAtPlayhead, jumpPlayheadToClipBoundary, jumpPlayheadToMarker, clipContextSyncEligibleClips, clipContextSyncLockByClipId, clipContextAllSyncLocked])

  // Spacebar panning key state (dedicated listeners so keyup cannot get "stuck")
  useEffect(() => {
    const resetSpacePanningState = () => {
      spacePanningKeyDownRef.current = false
      setIsSpaceHeld(false)
      setIsPanning(false)
      setPanStart(null)
    }

    const handleSpaceKeyDown = (e) => {
      if (isNativeTextKeyboardEvent(e)) return
      if (hasVisibleKeyboardModal()) return
      if (pasteAttributesOpenRef.current) return
      if (e.target?.closest?.('[data-audio-envelope-editor]')) return
      if (e.code !== 'Space' || e.repeat) return
      const active = document.activeElement
      if (isTextEditingElement(active)) return
      spacePanningKeyDownRef.current = true
      setIsSpaceHeld(true)
    }

    const handleSpaceKeyUp = (e) => {
      if (e.code !== 'Space') return
      resetSpacePanningState()
    }

    const handleWindowBlur = () => {
      resetSpacePanningState()
    }

    const handleVisibilityChange = () => {
      if (document.hidden) resetSpacePanningState()
    }

    window.addEventListener('keydown', handleSpaceKeyDown)
    window.addEventListener('keyup', handleSpaceKeyUp)
    window.addEventListener('blur', handleWindowBlur)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('keydown', handleSpaceKeyDown)
      window.removeEventListener('keyup', handleSpaceKeyUp)
      window.removeEventListener('blur', handleWindowBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  // Handle spacebar panning
  useEffect(() => {
    if (!isPanning || !panStart) return
    
    const handleMouseMove = (e) => {
      if (!timelineRef.current || !trackContentRef.current) return
      
      const deltaX = e.clientX - panStart.x
      const deltaY = e.clientY - panStart.y
      
      // Scroll the timeline horizontally
      timelineRef.current.scrollLeft = panStart.scrollLeft - deltaX
      
      // Scroll the track content vertically (synced with headers)
      trackContentRef.current.scrollTop = panStart.scrollTop - deltaY
    }
    
    const handleMouseUp = () => {
      setIsPanning(false)
      setPanStart(null)
    }
    
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isPanning, panStart])

  useEffect(() => {
    const handleAssetDragStart = (e) => {
      const nextAssetId = e?.detail?.assetId
      const nextAssetIds = Array.isArray(e?.detail?.assetIds)
        ? e.detail.assetIds.filter((id) => typeof id === 'string' && id)
        : []
      if (typeof nextAssetId === 'string' && nextAssetId) {
        setDraggedAssetId(nextAssetId)
      }
      setDraggedAssetIds(nextAssetIds)
    }
    const handleAssetDragEnd = () => {
      cancelPendingAssetDragOver()
      setDraggedAssetId(null)
      setDraggedAssetIds([])
      setDropTarget(null)
      setAssetDropPreview(null)
      clearActiveSnap()
    }
    window.addEventListener('comfystudio-assets-drag-start', handleAssetDragStart)
    window.addEventListener('comfystudio-assets-drag-end', handleAssetDragEnd)
    return () => {
      window.removeEventListener('comfystudio-assets-drag-start', handleAssetDragStart)
      window.removeEventListener('comfystudio-assets-drag-end', handleAssetDragEnd)
    }
  }, [clearActiveSnap, cancelPendingAssetDragOver])

  useEffect(() => {
    const clearDropFeedback = () => {
      cancelPendingAssetDragOver()
      setDraggedAssetId(null)
      setDraggedAssetIds([])
      setDropTarget(null)
      setAssetDropPreview(null)
      clearActiveSnap()
    }
    window.addEventListener('dragend', clearDropFeedback)
    window.addEventListener('drop', clearDropFeedback)
    return () => {
      window.removeEventListener('dragend', clearDropFeedback)
      window.removeEventListener('drop', clearDropFeedback)
    }
  }, [clearActiveSnap, cancelPendingAssetDragOver])

  useEffect(() => {
    return () => {
      cancelPendingAssetDragOver()
    }
  }, [cancelPendingAssetDragOver])

  // Handle wheel input directly on the DOM node so nested scrollable children
  // cannot perform their own vertical wheel scroll before we remap it.
  const handleWheel = useCallback((e) => {
    if (!timelineRef.current) return
    const sequence = ++viewportNavigationSequenceRef.current
    pendingSelectionViewRef.current = null
    
    // Ctrl/Cmd + Scroll = Zoom (centered on mouse position)
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      
      // Zoom delta - scroll up = zoom in, scroll down = zoom out
      const zoomDelta = e.deltaY > 0 ? -20 : 20
      
      // Get mouse position relative to timeline for zoom centering
      const rect = timelineRef.current.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const scrollLeft = timelineRef.current.scrollLeft
      
      // Calculate time position under mouse before zoom
      const timeAtMouse = (mouseX + scrollLeft) / pixelsPerSecond
      
      // Apply zoom
      const newZoom = Math.max(getMinZoom(), Math.min(2000, zoom + zoomDelta))
      setZoom(newZoom)
      
      // Calculate new pixels per second
      const newPixelsPerSecond = newZoom / 5
      
      // Adjust scroll to keep the time position under the mouse
      const newScrollLeft = (timeAtMouse * newPixelsPerSecond) - mouseX
      
      // Apply scroll adjustment after a tiny delay to let the zoom render
      requestAnimationFrame(() => {
        if (timelineRef.current && sequence === viewportNavigationSequenceRef.current) {
          timelineRef.current.scrollLeft = Math.max(0, newScrollLeft)
        }
      })
    } else {
      // Default wheel behavior: move through the timeline horizontally.
      // Hold Alt to keep vertical track scrolling available when needed.
      if (e.altKey) return
      e.preventDefault()
      const horizontalDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY)
        ? e.deltaX
        : e.deltaY
      timelineRef.current.scrollLeft += horizontalDelta
    }
  }, [getMinZoom, pixelsPerSecond, zoom, setZoom])

  useEffect(() => {
    const timelineEl = timelineRef.current
    if (!timelineEl) return undefined

    const handleNativeWheel = (event) => {
      handleWheel(event)
    }

    timelineEl.addEventListener('wheel', handleNativeWheel, { passive: false, capture: true })

    return () => {
      timelineEl.removeEventListener('wheel', handleNativeWheel, true)
    }
  }, [handleWheel])

  // Per-tick playhead updates bypass React entirely: a direct store
  // subscription moves the playhead element and keeps it in view. This (plus
  // the omission of playheadPosition from the store slice) is what keeps the
  // clip area from re-rendering 24+ times a second during playback.
  useEffect(() => {
    const applyPlayheadLeft = (position) => {
      const node = playheadElRef.current
      if (node) node.style.left = `${position * pixelsPerSecond}px`
    }
    applyPlayheadLeft(useTimelineStore.getState().playheadPosition)

    // The keep-in-view check must not read layout per tick: the style.left
    // write above plus a scrollLeft/clientWidth read is a forced synchronous
    // reflow of the whole clip area — at hundreds of clips that read was the
    // single biggest per-frame cost during playback. Viewport metrics are
    // cached (scroll listener + ResizeObserver) so the hot path is pure
    // arithmetic; layout is only touched when an auto-scroll jump fires.
    const el = timelineRef.current
    let cachedScrollLeft = el ? el.scrollLeft : 0
    let cachedClientWidth = el ? el.clientWidth : 0
    const handleScroll = () => { cachedScrollLeft = el.scrollLeft }
    let resizeObserver = null
    if (el) {
      el.addEventListener('scroll', handleScroll, { passive: true })
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => { cachedClientWidth = el.clientWidth })
        resizeObserver.observe(el)
      }
    }

    const followPlayhead = (time) => {
      if (!el || !Number.isFinite(Number(time))) return
      const targetX = Number(time) * pixelsPerSecond
      const padding = Math.max(80, cachedClientWidth * 0.18)
      if (targetX > cachedScrollLeft + cachedClientWidth - padding) {
        const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
        const next = Math.min(Math.max(0, targetX - (cachedClientWidth * 0.35)), maxScrollLeft)
        el.scrollLeft = next
        cachedScrollLeft = next
      } else if (targetX < cachedScrollLeft + padding) {
        const maxScrollLeft = Math.max(0, el.scrollWidth - el.clientWidth)
        const next = Math.max(0, Math.min(targetX - padding, maxScrollLeft))
        el.scrollLeft = next
        cachedScrollLeft = next
      }
    }

    const unsubscribe = useTimelineStore.subscribe((state, prevState) => {
      if (state.playheadPosition === prevState.playheadPosition) return
      applyPlayheadLeft(state.playheadPosition)
      if (state.isPlaying) {
        followPlayhead(state.playheadPosition)
      }
    })
    return () => {
      unsubscribe()
      if (el) el.removeEventListener('scroll', handleScroll)
      if (resizeObserver) resizeObserver.disconnect()
    }
  }, [pixelsPerSecond])

  const getDraggedAssetIds = (dataTransfer) => {
    if (Array.isArray(draggedAssetIds) && draggedAssetIds.length > 0) return draggedAssetIds
    if (!dataTransfer) return draggedAssetIds
    const directId = dataTransfer.getData('assetId')
    const customPayload = dataTransfer.getData('application/x-comfystudio-asset-ids')
    const plainText = dataTransfer.getData('text/plain')
    const raw = customPayload || plainText
    if (!raw) {
      return directId ? [directId] : draggedAssetIds
    }
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
        return parsed.filter((id) => typeof id === 'string' && id)
      }
    } catch (_) {
      if (directId) return [directId]
      if (raw.startsWith('asset-')) return [raw]
    }
    return directId ? [directId] : draggedAssetIds
  }

  const getDraggedAssetId = (dataTransfer) => {
    const assetIds = getDraggedAssetIds(dataTransfer)
    return Array.isArray(assetIds) && assetIds.length > 0 ? assetIds[0] : null
  }

  const getDropStartTimeFromClientX = (clientX) => {
    if (!timelineRef.current) return 0
    const rect = timelineRef.current.getBoundingClientRect()
    const scrollLeft = timelineRef.current.scrollLeft || 0
    const x = clientX - rect.left + scrollLeft
    const fps = Number.isFinite(Number(timelineFps)) && Number(timelineFps) > 0
      ? Number(timelineFps)
      : FRAME_RATE
    const rawStartTime = Math.max(0, x / pixelsPerSecond)
    return Math.round(rawStartTime * fps) / fps
  }

  const getDropStartTime = (e) => {
    return getDropStartTimeFromClientX(e.clientX)
  }

  const getSnappedDropStartTime = (rawStartTime, clipDuration) => {
    const snapResult = snapClipPosition(null, rawStartTime, clipDuration)
    if (snapResult.snapped) {
      return {
        startTime: Math.max(0, snapResult.startTime),
        snapTime: snapResult.snapInfo?.snapPoint?.time ?? null,
      }
    }
    return { startTime: rawStartTime, snapTime: null }
  }

  const getMusicVideoAssetSyncTiming = (asset) => {
    const yolo = asset?.yolo || asset?.settings?.yolo || null
    const shotType = String(yolo?.shotType || '').trim().toLowerCase()
    if (yolo?.mode !== 'music' || yolo?.stage !== 'video') return null
    if (shotType !== 'performance' && shotType !== 'performance_wide') return null
    const audioStart = Number(yolo.audioStart)
    const length = Number(yolo.length ?? yolo.durationSeconds ?? asset?.settings?.duration ?? asset?.duration)
    return {
      startTime: Number.isFinite(audioStart) ? Math.max(0, audioStart) : 0,
      duration: Number.isFinite(length) && length > 0 ? length : null,
    }
  }

  const getDropPreviewDuration = (asset, startTime) => {
    if (!asset) return 5
    const fps = Number.isFinite(Number(timelineFps)) && Number(timelineFps) > 0
      ? Number(timelineFps)
      : FRAME_RATE
    const minDuration = 1 / fps
    const syncTiming = getMusicVideoAssetSyncTiming(asset)
    if (syncTiming?.duration) {
      return Math.max(minDuration, Math.round(syncTiming.duration * fps) / fps)
    }
    const isImage = asset.type === 'image'
    const assetDuration = Number(asset.duration ?? asset.settings?.duration)
    const sourceDuration = Number.isFinite(assetDuration) && assetDuration > 0 ? assetDuration : 5
    let rawDuration = isImage ? 5 : sourceDuration
    const isGeneratedOverlay = isImage && Boolean(asset?.settings?.overlayKind)

    if (isGeneratedOverlay) {
      const latestClips = useTimelineStore.getState().clips || clips
      const timelineContentEnd = latestClips.length > 0
        ? Math.max(...latestClips.map(c => c.startTime + c.duration))
        : 0
      const remainingDuration = timelineContentEnd - startTime
      rawDuration = Math.max(5, remainingDuration > 0 ? remainingDuration : 0)
    }

    const roundedDuration = Math.round(rawDuration * fps) / fps
    return Math.max(minDuration, roundedDuration)
  }

  const canDropAssetOnTrack = (asset, track) => {
    if (!asset || !track) return false
    const isVideoAsset = asset.type === 'video' || asset.type === 'image'
    const isVideoTrack = track.type === 'video'
    // The dedicated captions track only accepts caption overlay assets.
    const assetIsCaption = !!(asset.settings?.captionScope || asset.settings?.overlayKind === 'captions' || asset.settings?.source === 'captions')
    if (track.role === 'captions') return assetIsCaption
    return (isVideoAsset && isVideoTrack) || (!isVideoAsset && !isVideoTrack)
  }

  const resolveVideoAssetHasAudio = useCallback(async (asset) => {
    if (!asset || asset.type !== 'video') return null
    if (typeof asset.hasAudio === 'boolean') return asset.hasAudio

    const canProbeViaElectron = (
      typeof window !== 'undefined'
      && window.isElectron
      && window.electronAPI
      && typeof window.electronAPI.getVideoFps === 'function'
      && typeof asset.absolutePath === 'string'
      && asset.absolutePath.length > 0
    )
    if (!canProbeViaElectron) return null

    try {
      const fpsResult = await window.electronAPI.getVideoFps(asset.absolutePath)
      if (typeof fpsResult?.hasAudio !== 'boolean') return null
      const hasAudio = fpsResult.hasAudio
      if (hasAudio) {
        updateAsset(asset.id, { hasAudio: true })
      } else {
        updateAsset(asset.id, { hasAudio: false, audioEnabled: false })
      }
      return hasAudio
    } catch (err) {
      console.warn('Failed to probe video audio stream:', err)
      return null
    }
  }, [updateAsset])

  const resolveDropTrackForAsset = (asset, requestedTrackId, { allowCreateTrack = false } = {}) => {
    let targetTrackId = requestedTrackId
    let willCreateTrack = false
    const isOverlayAsset = asset.type === 'image' && Boolean(asset?.settings?.overlayKind)

    if (!isOverlayAsset) {
      return { targetTrackId, willCreateTrack }
    }

    const latestState = useTimelineStore.getState()
    const latestTracks = latestState.tracks || []
    const latestClips = latestState.clips || []
    const unlockedVideoTracks = latestTracks.filter(t => t.type === 'video' && !t.locked)
    const isOverlayClip = (clip) => {
      if (clip.type !== 'image') return false
      const clipAsset = assetsById.get(clip.assetId)
      return Boolean(clipAsset?.settings?.overlayKind)
    }

    const reusableOverlayTrack = unlockedVideoTracks.find((trackCandidate) => {
      const clipsOnTrack = latestClips.filter(c => c.trackId === trackCandidate.id)
      return clipsOnTrack.length === 0 || clipsOnTrack.every(isOverlayClip)
    })

    if (reusableOverlayTrack) {
      targetTrackId = reusableOverlayTrack.id
      return { targetTrackId, willCreateTrack }
    }

    if (allowCreateTrack) {
      const newTrack = addTrack('video')
      if (newTrack?.id) {
        targetTrackId = newTrack.id
        willCreateTrack = true
      }
      return { targetTrackId, willCreateTrack }
    }

    const requestedTrack = latestTracks.find(t => t.id === requestedTrackId)
    if (requestedTrack?.type === 'video' && !requestedTrack.locked) {
      targetTrackId = requestedTrack.id
    } else if (unlockedVideoTracks.length > 0) {
      targetTrackId = unlockedVideoTracks[0].id
    }
    willCreateTrack = true
    return { targetTrackId, willCreateTrack }
  }

  // Handle drag over for drop zones
  const handleDragOver = (e, trackId) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'

    pendingAssetDragOverRef.current = {
      trackId,
      assetId: getDraggedAssetId(e.dataTransfer),
      clientX: e.clientX,
    }

    if (dragOverRafRef.current !== null) return

    dragOverRafRef.current = requestAnimationFrame(() => {
      dragOverRafRef.current = null
      const payload = pendingAssetDragOverRef.current
      pendingAssetDragOverRef.current = null
      if (!payload) return

      const { assetId, clientX, trackId: pendingTrackId } = payload

      if (!assetId) {
        setDropTarget(pendingTrackId)
        setAssetDropPreview(null)
        clearActiveSnap()
        return
      }

      const asset = assetsById.get(assetId)
      if (!asset) {
        setDropTarget(null)
        setAssetDropPreview(null)
        clearActiveSnap()
        return
      }

      const rawStartTime = getDropStartTimeFromClientX(clientX)
      const { targetTrackId, willCreateTrack } = resolveDropTrackForAsset(asset, pendingTrackId, { allowCreateTrack: false })
      const latestTracks = useTimelineStore.getState().tracks
      const targetTrack = latestTracks.find(t => t.id === targetTrackId) || tracks.find(t => t.id === targetTrackId)

      if (!canDropAssetOnTrack(asset, targetTrack)) {
        setDropTarget(null)
        setAssetDropPreview(null)
        clearActiveSnap()
        return
      }

      const syncTiming = getMusicVideoAssetSyncTiming(asset)
      const duration = getDropPreviewDuration(asset, syncTiming?.startTime ?? rawStartTime)
      const { startTime, snapTime } = syncTiming
        ? { startTime: syncTiming.startTime, snapTime: syncTiming.startTime }
        : getSnappedDropStartTime(rawStartTime, duration)
      setDropTarget(targetTrackId)
      if (snapTime !== null) {
        setActiveSnapTime(snapTime)
      } else {
        clearActiveSnap()
      }
      setAssetDropPreview((prev) => {
        const next = {
          assetId: asset.id,
          trackId: targetTrackId,
          startTime,
          duration,
          assetType: asset.type,
          name: asset.name,
          willCreateTrack,
        }
        if (
          prev &&
          prev.assetId === next.assetId &&
          prev.trackId === next.trackId &&
          prev.assetType === next.assetType &&
          prev.name === next.name &&
          prev.willCreateTrack === next.willCreateTrack &&
          Math.abs(prev.startTime - next.startTime) < 0.0001 &&
          Math.abs(prev.duration - next.duration) < 0.0001
        ) {
          return prev
        }
        return next
      })
    })
  }

  const handleDragLeave = (e) => {
    if (e.currentTarget?.contains(e.relatedTarget)) return
    cancelPendingAssetDragOver()
    setDropTarget(null)
    setAssetDropPreview(null)
    clearActiveSnap()
  }

  // Handle drop from assets
  const handleDrop = async (e, trackId) => {
    e.preventDefault()
    cancelPendingAssetDragOver()
    setDropTarget(null)
    setAssetDropPreview(null)
    clearActiveSnap()
    
    const assetIds = getDraggedAssetIds(e.dataTransfer)
    if (!Array.isArray(assetIds) || assetIds.length === 0) return

    const droppedAssets = assetIds
      .map((assetId) => assetsById.get(assetId))
      .filter(Boolean)
    if (droppedAssets.length === 0) return

    let nextStartTime = getDropStartTime(e)
    let insertedAny = false

    for (const asset of droppedAssets) {
      const { targetTrackId } = resolveDropTrackForAsset(asset, trackId, { allowCreateTrack: true })

      // Check if asset type matches target track type
      const latestTracks = useTimelineStore.getState().tracks
      const track = latestTracks.find(t => t.id === targetTrackId) || tracks.find(t => t.id === targetTrackId)
      if (!track || !canDropAssetOnTrack(asset, track)) continue

      let shouldAddAudioClip = false
      if (asset.type === 'video' && track.type === 'video' && asset.audioEnabled !== false) {
        if (asset.hasAudio === false) {
          shouldAddAudioClip = false
        } else if (asset.hasAudio === true) {
          shouldAddAudioClip = true
        } else {
          const probedHasAudio = await resolveVideoAssetHasAudio(asset)
          shouldAddAudioClip = probedHasAudio !== false
        }
      }
      const latestTracksForAudio = shouldAddAudioClip ? useTimelineStore.getState().tracks : []
      const audioTrack = shouldAddAudioClip
        ? latestTracksForAudio.find(t => t.type === 'audio' && !t.locked)
        : null
      const linkGroupId = audioTrack
        ? `link-import-${asset.id || 'asset'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        : undefined

      const duration = getDropPreviewDuration(asset, nextStartTime)
      const { startTime } = insertedAny
        ? { startTime: nextStartTime }
        : getSnappedDropStartTime(nextStartTime, duration)
      const insertedClip = addClip(targetTrackId, asset, startTime, timelineFps, linkGroupId
        ? { linkGroupId, selectAfterAdd: false }
        : undefined)
      if (!insertedClip) continue

      insertedAny = true
      nextStartTime = insertedClip.startTime + insertedClip.duration

      if (audioTrack) {
        const audioAsset = { ...asset, type: 'audio' }
        const insertedAudioClip = addClip(audioTrack.id, audioAsset, insertedClip.startTime, timelineFps, {
          saveHistory: false,
          linkGroupId,
          selectAfterAdd: false,
        })
        if (insertedAudioClip) {
          selectClips([insertedClip.id, insertedAudioClip.id])
        } else {
          selectClip(insertedClip.id)
        }
      }
    }

    if (insertedAny) {
      setPreviewMode('timeline')
      if (assetIsPlaying) {
        setAssetIsPlaying(false)
      }
      // Tell the assets panel to release its selection and focus: after a
      // drop it still owns both, which hijacks the next Delete press into
      // "delete asset?" instead of deleting the just-placed clip.
      try { window.dispatchEvent(new Event('comfystudio-timeline-assets-dropped')) } catch (_) { /* non-browser */ }
    }
  }

  // Handle clip selection (supports multi-select with Shift/Ctrl)
  const handleClipClick = (e, clip) => {
    e.stopPropagation()
    
    // Switch to timeline preview mode when clicking on a clip
    // Also pause asset playback if it's playing
    setPreviewMode('timeline')
    if (assetIsPlaying) {
      setAssetIsPlaying(false)
    }
    
    // Multi-select support
    const isShiftHeld = e.shiftKey
    const isCtrlHeld = e.ctrlKey || e.metaKey // metaKey for Mac Cmd

    // Slide already resolves plain-click selection before its read-only
    // preflight. Do not narrow a rejected group (or reselect after the edit).
    if (isSlideToolActive && !isShiftHeld && !isCtrlHeld
      && useTimelineStore.getState().selectedClipIds.includes(clip.id)) return
    
    selectClip(clip.id, {
      addToSelection: isShiftHeld,
      toggleSelection: isCtrlHeld
    })
    
    // Note: We don't move the playhead when selecting clips - 
    // the playhead stays where it is and the user can scrub independently.
  }

  const handleTextClipDoubleClick = useCallback((e, clip) => {
    if (!clip || clip.type !== 'text') return
    e.preventDefault()
    e.stopPropagation()

    setPreviewMode('timeline')
    if (assetIsPlaying) {
      setAssetIsPlaying(false)
    }

    selectClip(clip.id)
    requestTextEdit(clip.id, { selectAll: true })
  }, [assetIsPlaying, requestTextEdit, selectClip, setAssetIsPlaying, setPreviewMode])

  // Handle clip right-click context menu
  const handleClipContextMenu = (e, clip) => {
    e.preventDefault()
    e.stopPropagation()
    
    // Select the clip if not already selected
    if (!selectedClipIds.includes(clip.id)) {
      selectClip(clip.id)
    }
    
    setClipContextMenu({
      x: e.clientX,
      y: e.clientY,
      clipId: clip.id
    })
    setMaskSubmenuOpen(false)
  }

  // Close clip context menu. We listen in the CAPTURE phase because
  // some downstream handlers (notably handleClipClick on the clip that
  // was right-clicked) call e.stopPropagation(), which would otherwise
  // prevent the bubble-phase window click from firing. Clicking the
  // same clip you right-clicked should still dismiss the menu, so we
  // catch the click on the way down.
  useEffect(() => {
    if (!clipContextMenu) return

    const handleClick = (e) => {
      // Ignore clicks inside the menu itself — its stopPropagation on
      // onClick keeps this from firing for menu-internal clicks anyway,
      // but belt-and-suspenders in case a child forgets to stop it.
      if (clipContextMenuRef.current && clipContextMenuRef.current.contains(e.target)) {
        return
      }
      setClipContextMenu(null)
      setMaskSubmenuOpen(false)
    }
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        setClipContextMenu(null)
        setMaskSubmenuOpen(false)
      }
    }

    window.addEventListener('click', handleClick, true)
    window.addEventListener('keydown', handleEscape)

    return () => {
      window.removeEventListener('click', handleClick, true)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [clipContextMenu])

  // Context menu actions
  const renderableSelectedClips = useMemo(() => (
    selectedClipIds
      .map((id) => clips.find(c => c.id === id))
      .filter((clip) => isClipRenderable(clip))
  ), [selectedClipIds, clips])

  const handleRenderClips = useCallback(async (targetClips) => {
    for (const target of targetClips) {
      if (!isClipRenderable(target)) continue
      try {
        await renderClipToCache(target.id)
      } catch (err) {
        console.warn('[RenderCache] Clip render failed:', target?.id, err)
      }
    }
  }, [])

  const handleContextMenuAction = (action) => {
    const clip = clips.find(c => c.id === clipContextMenu?.clipId)
    if (!clip) return
    if (hasCompoundSelection && !['delete', 'move-by-offset', 'duration-by-amount', 'toggle-enabled'].includes(action)) return

    switch (action) {
      case 'add-mask':
        if (!(clip.type === 'video' || clip.type === 'image')) break
        // Ensure single selection on this clip
        selectClip(clip.id)
        requestMaskPicker(clip.id, { openPicker: true })
        break
      case 'render-cache': {
        const targetIds = selectedClipIds.includes(clip.id) ? selectedClipIds : [clip.id]
        const targets = targetIds
          .map((clipId) => clips.find(c => c.id === clipId))
          .filter(Boolean)
        void handleRenderClips(targets)
        setClipContextMenu(null)
        break
      }
      case 'flush-cache': {
        const targetIds = selectedClipIds.includes(clip.id) ? selectedClipIds : [clip.id]
        targetIds.forEach((clipId) => {
          const targetClip = clips.find(c => c.id === clipId)
          if (!targetClip) return
          renderCacheService.clearCache(clipId)
          clearDiskCacheUrl(clipId)
          if (targetClip.cachePath && currentProjectHandle) {
            deleteRenderCache(currentProjectHandle, targetClip.cachePath).catch(err => {
              console.warn('Failed to delete cache from disk:', err)
            })
          }
          clearClipCache(clipId)
        })
        break
      }
      case 'delete':
        if (rippleEditMode) {
          const targetIds = clipContextSelectionIds.length > 0 ? clipContextSelectionIds : [clip.id]
          rippleDeleteClipIds(targetIds)
        } else if (selectedClipIds.length > 1 && selectedClipIds.includes(clip.id)) {
          removeSelectedClips()
        } else {
          removeClip(clip.id)
        }
        break
      case 'duplicate':
        // Duplicate clip right after current position
        if (clip.type === 'text') {
          const textOptions = { ...(clip.textProperties || {}), duration: clip.duration, enabled: isClipEnabled(clip), effects: clip.effects }
          addTextClip(clip.trackId, textOptions, clip.startTime + clip.duration + 0.1)
        } else if (clip.type === 'shape') {
          addShapeClip(clip.trackId, {
            shapeProperties: clip.shapeProperties || {},
            duration: clip.duration,
            name: clip.name,
            transform: clip.transform || {},
            enabled: isClipEnabled(clip),
            effects: clip.effects,
          }, clip.startTime + clip.duration + 0.1)
        } else if (clip.type === 'adjustment') {
          addAdjustmentClip(clip.trackId, clip.startTime + clip.duration + 0.1, {
            duration: clip.duration,
            name: clip.name,
            adjustments: clip.adjustments || {},
            transform: clip.transform || {},
            enabled: isClipEnabled(clip),
            effects: clip.effects,
          })
        } else {
          const asset = assets.find(a => a.id === clip.assetId)
          if (asset) {
            addClip(clip.trackId, asset, clip.startTime + clip.duration + 0.1, timelineFps, {
              duration: clip.duration,
              trimStart: clip.trimStart,
              trimEnd: clip.trimEnd,
              enabled: isClipEnabled(clip),
              transform: clip.transform,
              effects: clip.effects,
              frameSampling: clip.type === 'video' ? clip.frameSampling : undefined,
              ...(clip.type === 'audio'
                ? {
                    gainDb: clip.gainDb,
                    fadeIn: clip.fadeIn,
                    fadeOut: clip.fadeOut,
                  }
                : {}),
            })
          }
        }
        break
      case 'move-by-offset':
        openMoveOffsetDialog()
        break
      case 'duration-by-amount':
        openDurationDeltaDialog()
        break
      case 'toggle-enabled': {
        const targetIds = clipContextSelectionIds.length > 0 ? clipContextSelectionIds : [clip.id]
        const shouldEnable = targetIds
          .map((clipId) => clips.find((candidate) => candidate.id === clipId))
          .filter(Boolean)
          .every((candidate) => !isClipEnabled(candidate))
        setClipSelectionEnabled(targetIds, shouldEnable)
        break
      }
      case 'link-selection':
        linkSelectedClips()
        break
      case 'unlink-selection':
        unlinkSelectedClips()
        break
      case 'sync-toggle': {
        const targetIds = clipContextSyncEligibleClips.length > 0
          ? clipContextSyncEligibleClips.map((targetClip) => targetClip.id)
          : (clipContextSelectionIds.length > 0 ? clipContextSelectionIds : [clip.id])
        if (clipContextAllSyncLocked) {
          unlockSyncLockedClips(targetIds)
        } else {
          lockSyncClips(targetIds, clipContextSyncLockByClipId)
        }
        break
      }
      case 'split':
        handleSplitClipAtPlayhead(clip)
        break
    }
    
    setMaskSubmenuOpen(false)
    setClipContextMenu(null)
  }

  const handleApplyMaskFromContextMenu = (maskAssetId) => {
    const clip = clips.find(c => c.id === clipContextMenu?.clipId)
    if (!clip) return
    if (!(clip.type === 'video' || clip.type === 'image')) return

    selectClip(clip.id)
    addMaskEffect(clip.id, maskAssetId)
    requestMaskPicker(clip.id, { openPicker: false })
    setMaskSubmenuOpen(false)
    setClipContextMenu(null)
  }

  // Handle clip deletion (deletes all selected if multiple)
  const handleDeleteClip = (e, clipId) => {
    e.stopPropagation()
    // If this clip is selected and there are multiple selections, delete all
    if (selectedClipIds.includes(clipId) && selectedClipIds.length > 1) {
      removeSelectedClips()
    } else {
      removeClip(clipId)
    }
  }

  // Handle trim start (mousedown on handle)
  const endTrimGesture = useCallback(() => {
    trimGestureRef.current = null
    setTrimState(null)
    setTrimPreview(null)
    clearActiveSnap()
  }, [clearActiveSnap])

  const isTrimGestureCurrent = useCallback((gesture, state) => (
    gesture && state.clips === gesture.expectedClips && state.tracks === gesture.expectedTracks
    && state.history === gesture.expectedHistory && state.historyIndex === gesture.historyIndex
    && state.timelineSessionId === gesture.timelineSessionId && state.timelineFps === gesture.fps
    && state.selectedClipIds.length === gesture.selection.length
    && state.selectedClipIds.every(id => gesture.selection.includes(id))
  ), [])

  const endRippleTrimGesture = useCallback(() => {
    const gesture = rippleTrimGestureRef.current
    rippleTrimGestureRef.current = null
    setRippleTrimState(null)
    setRippleTrimPreview(null)
    if (gesture?.token) useTimelineStore.getState().endRippleTrim?.(gesture.token)
    clearActiveSnap()
  }, [clearActiveSnap])

  const isRippleTrimGestureCurrent = useCallback((gesture, state) => (
    gesture && RIPPLE_TRIM_STATE_KEYS.every(key => state[key] === gesture.expectedState[key])
  ), [])

  const showRippleTrimRefusal = useCallback((reason, anchor) => {
    setRippleTrimRefusal({ reason: reason || 'These clips cannot be ripple trimmed safely. Review the target clips and following media.', anchor })
  }, [])

  useEffect(() => {
    if (!rippleTrimRefusal) return undefined
    const dismiss = () => setRippleTrimRefusal(null)
    const onKeyDown = event => { if (event.key === 'Escape') dismiss() }
    const sessionId = useTimelineStore.getState().timelineSessionId
    const unsubscribe = useTimelineStore.subscribe(state => { if (state.timelineSessionId !== sessionId) dismiss() })
    const timer = setTimeout(dismiss, 6000)
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', dismiss)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', dismiss)
      unsubscribe()
    }
  }, [rippleTrimRefusal])

  const endRollGesture = useCallback(() => {
    const gesture = rollGestureRef.current
    rollGestureRef.current = null
    setRollEditState(null)
    setRollPreview(null)
    if (gesture?.token) useTimelineStore.getState().endRollEdit?.(gesture.token)
  }, [])

  const showRollRefusal = useCallback((reason, anchor) => {
    setRollRefusal({ reason: reason || 'This cut cannot be rolled safely. Use the individual trim handles instead.', anchor })
  }, [])

  useEffect(() => {
    if (!rollRefusal) return undefined
    const dismiss = () => setRollRefusal(null)
    const onKeyDown = event => { if (event.key === 'Escape') dismiss() }
    const sessionId = useTimelineStore.getState().timelineSessionId
    const unsubscribe = useTimelineStore.subscribe(state => { if (state.timelineSessionId !== sessionId) dismiss() })
    const timer = setTimeout(dismiss, 6000)
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', dismiss)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', dismiss)
      unsubscribe()
    }
  }, [rollRefusal])

  const isRollGestureCurrent = useCallback((gesture, state) => (
    gesture && ROLL_GESTURE_STATE_KEYS.every(key => state[key] === gesture.expectedState[key])
  ), [])

  const endSlipGesture = useCallback(() => {
    const gesture = slipGestureRef.current
    slipGestureRef.current = null
    setSlipState(null)
    setSlipPreview(null)
    if (gesture?.token) useTimelineStore.getState().endSlipEdit?.(gesture.token)
  }, [])

  const showSlipRefusal = useCallback((reason, anchor) => {
    setSlipRefusal({ reason: reason || 'This clip cannot be slipped safely. Choose a video or audio clip with available source handles.', anchor })
  }, [])

  useEffect(() => {
    if (!slipRefusal) return undefined
    const dismiss = () => setSlipRefusal(null)
    const onKeyDown = event => { if (event.key === 'Escape') dismiss() }
    const sessionId = useTimelineStore.getState().timelineSessionId
    const unsubscribe = useTimelineStore.subscribe(state => { if (state.timelineSessionId !== sessionId) dismiss() })
    const timer = setTimeout(dismiss, 6000)
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', dismiss)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', dismiss)
      unsubscribe()
    }
  }, [slipRefusal])

  // Slip and Roll use the same private-store authored-state guard contract.
  const isSlipGestureCurrent = useCallback((gesture, state) => (
    gesture && ROLL_GESTURE_STATE_KEYS.every(key => state[key] === gesture.expectedState[key])
  ), [])

  const endSlideGesture = useCallback(() => {
    const gesture = slideGestureRef.current
    slideGestureRef.current = null
    setSlideState(null)
    setSlidePreview(null)
    if (gesture?.token) useTimelineStore.getState().endSlideEdit?.(gesture.token)
    clearActiveSnap()
  }, [clearActiveSnap])

  const isSlideGestureCurrent = useCallback((gesture, state) => (
    gesture && SLIDE_GESTURE_STATE_KEYS.every(key => state[key] === gesture.expectedState[key])
  ), [])

  const showSlideRefusal = useCallback((reason, anchor) => {
    setSlideRefusal({ reason: reason || 'Choose one clip between two touching neighbors with available source handles.', anchor })
  }, [])

  useEffect(() => {
    if (!slideRefusal) return undefined
    const dismiss = () => setSlideRefusal(null)
    const onKeyDown = event => { if (event.key === 'Escape') dismiss() }
    const sessionId = useTimelineStore.getState().timelineSessionId
    const unsubscribe = useTimelineStore.subscribe(state => { if (state.timelineSessionId !== sessionId) dismiss() })
    const timer = setTimeout(dismiss, 6000)
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', dismiss)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', dismiss)
      unsubscribe()
    }
  }, [slideRefusal])

  const handleSlideEditStart = (event, clip) => {
    endSlideGesture()
    const anchor = { x: event.clientX, y: event.clientY }
    const current = useTimelineStore.getState()
    if (current.clips.find(candidate => candidate.id === clip.id) !== clip) {
      showSlideRefusal('The clip changed. Grab it again to start a new slide edit.', anchor)
      return
    }
    // Clicking an unselected clip keeps normal selection behavior. Clicking
    // inside an existing group lets the planner explain the single-target rule.
    if (!current.selectedClipIds.includes(clip.id) && !event.shiftKey && !event.ctrlKey && !event.metaKey) current.selectClip(clip.id)
    const selectedState = useTimelineStore.getState()
    if (selectedState.clips.find(candidate => candidate.id === clip.id) !== clip) {
      showSlideRefusal('The clip changed. Grab it again to start a new slide edit.', anchor)
      return
    }
    const result = selectedState.beginSlideEdit?.({ clipId: clip.id })
    if (!result?.ok) {
      showSlideRefusal(result?.reason || 'Slide edit is unavailable. Try again.', anchor)
      return
    }
    setSlideRefusal(null)
    setSlipRefusal(null)
    setRollRefusal(null)
    setRippleTrimRefusal(null)
    if (rippleTrimGestureRef.current) endRippleTrimGesture()
    if (trimGestureRef.current) endTrimGesture()
    if (rollGestureRef.current) endRollGesture()
    if (slipGestureRef.current) endSlipGesture()
    if (clipDragState) setClipDragState(null)
    if (transitionDragState) setTransitionDragState(null)
    if (fadeDragState) setFadeDragState(null)
    clearActiveSnap()
    slideGestureRef.current = {
      token: result.token, expectedState: captureSlideGestureState(useTimelineStore.getState()), anchor, writing: false,
    }
    setSlideState({ ...result.session, startX: event.clientX })
    setSlidePreview({ anchor, feedback: result.feedback })
  }

  const handleSlipEditStart = (event, clip) => {
    if (slideGestureRef.current) endSlideGesture()
    endSlipGesture()
    const anchor = { x: event.clientX, y: event.clientY }
    const current = useTimelineStore.getState()
    if (current.clips.find(candidate => candidate.id === clip.id) !== clip) {
      showSlipRefusal('The clip changed. Grab it again to start a new slip edit.', anchor)
      return
    }
    // Retain ordinary clip selection behavior, before creating the token that
    // binds that selection. This is UI state only, never an Undo checkpoint.
    if (!current.selectedClipIds.includes(clip.id) && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      current.selectClip(clip.id)
    }
    const selectedState = useTimelineStore.getState()
    if (selectedState.clips.find(candidate => candidate.id === clip.id) !== clip) {
      showSlipRefusal('The clip changed. Grab it again to start a new slip edit.', anchor)
      return
    }
    const result = selectedState.beginSlipEdit?.({ clipId: clip.id })
    if (!result?.ok) {
      showSlipRefusal(result?.reason || 'Slip edit is unavailable. Try again.', anchor)
      return
    }
    setSlipRefusal(null)
    setRollRefusal(null)
    if (rippleTrimGestureRef.current) endRippleTrimGesture()
    if (trimState) endTrimGesture()
    if (rollEditState) endRollGesture()
    if (clipDragState) setClipDragState(null)
    if (transitionDragState) setTransitionDragState(null)
    if (fadeDragState) setFadeDragState(null)
    clearActiveSnap()
    slipGestureRef.current = {
      token: result.token, expectedState: captureRollGestureState(useTimelineStore.getState()),
      anchor, writing: false,
    }
    setSlipState({ ...result.session, startX: event.clientX })
    setSlipPreview({ anchor, feedback: result.feedback })
  }

  const handleRollEditStart = (event, clipA, clipB) => {
    if (event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    if (slideGestureRef.current) endSlideGesture()
    endRollGesture()
    const anchor = { x: event.clientX, y: event.clientY }
    const current = useTimelineStore.getState()
    if (current.clips.find(clip => clip.id === clipA.id) !== clipA
      || current.clips.find(clip => clip.id === clipB.id) !== clipB) {
      showRollRefusal('The clips changed. Grab the cut again to start a new rolling edit.', anchor)
      return
    }
    const result = current.beginRollEdit?.({ clipAId: clipA.id, clipBId: clipB.id })
    if (!result?.ok) {
      showRollRefusal(result?.reason || 'Rolling edit is unavailable. Try again.', anchor)
      return
    }

    // Validation is read-only. The store owns one atomic checkpoint on the
    // first effective movement, not on a click or rejected gesture.
    setRollRefusal(null)
    if (rippleTrimGestureRef.current) endRippleTrimGesture()
    if (trimState) endTrimGesture()
    if (clipDragState) setClipDragState(null)
    if (transitionDragState) setTransitionDragState(null)
    if (slipGestureRef.current) endSlipGesture()
    if (fadeDragState) setFadeDragState(null)
    clearActiveSnap()
    rollGestureRef.current = {
      token: result.token, expectedState: captureRollGestureState(useTimelineStore.getState()),
      anchor, writing: false,
    }
    setRollEditState({ ...result.session, startX: event.clientX })
    setRollPreview({ anchor, feedback: result.feedback })
  }

  const handleRippleTrimStart = (event, clipId, edge) => {
    if (slideGestureRef.current) endSlideGesture()
    endRippleTrimGesture()
    if (trimGestureRef.current) endTrimGesture()
    if (rollGestureRef.current) endRollGesture()
    if (slipGestureRef.current) endSlipGesture()
    if (clipDragState) setClipDragState(null)
    if (transitionDragState) setTransitionDragState(null)
    if (fadeDragState) setFadeDragState(null)
    const anchor = { x: event.clientX, y: event.clientY }
    const clickedClip = clips.find(clip => clip.id === clipId)
    const current = useTimelineStore.getState()
    if (!clickedClip || current.clips.find(clip => clip.id === clipId) !== clickedClip) {
      showRippleTrimRefusal('The clip changed. Grab its edge again to start a new ripple trim.', anchor)
      return
    }
    // The planner validates the full selection and expands linked companions.
    // Unlike normal multi-trim, no locked or unsupported target is filtered out.
    const targetClipIds = getMultiClipTrimTargetIds({ selectedClipIds: current.selectedClipIds, primaryClipId: clipId })
    if (!current.selectedClipIds.includes(clipId)) current.selectClip(clipId)
    const selectedState = useTimelineStore.getState()
    if (selectedState.clips.find(clip => clip.id === clipId) !== clickedClip) {
      showRippleTrimRefusal('The clip changed. Grab its edge again to start a new ripple trim.', anchor)
      return
    }
    const result = selectedState.beginRippleTrim?.({ clipId, edge, targetClipIds })
    if (!result?.ok) {
      showRippleTrimRefusal(result?.reason || 'Ripple trim is unavailable. Try again.', anchor)
      return
    }
    setRippleTrimRefusal(null)
    setRollRefusal(null)
    setSlipRefusal(null)
    rippleTrimGestureRef.current = { token: result.token, anchor, writing: false,
      expectedState: captureRippleTrimState(useTimelineStore.getState()) }
    setRippleTrimState({ ...result.session, startX: event.clientX })
    setRippleTrimPreview({ anchor, feedback: result.feedback })
  }

  const handleTrimStart = (e, clipId, edge) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    if (slideGestureRef.current) endSlideGesture()
    if (useTimelineStore.getState().rippleEditMode) {
      if (e.button === 0) handleRippleTrimStart(e, clipId, edge)
      return
    }
    
    const clip = clips.find(c => c.id === clipId)
    if (!clip) return
    if (isSyncLockedClip(clip)) {
      selectClip(clipId)
      return
    }

    // Trimming must be exclusive: cancel any in-flight drag/edit gesture to avoid
    // multiple mousemove handlers fighting and moving neighboring clips.
    if (clipDragState) setClipDragState(null)
    if (transitionDragState) setTransitionDragState(null)
    if (rippleTrimGestureRef.current) endRippleTrimGesture()
    if (rollEditState) endRollGesture()
    if (slipGestureRef.current) endSlipGesture()
    if (fadeDragState) setFadeDragState(null)
    clearActiveSnap()

    const requestedTargetIds = getMultiClipTrimTargetIds({
      selectedClipIds,
      primaryClipId: clipId,
    })
    const editableTargetIds = requestedTargetIds.filter((targetClipId) => {
      const targetClip = clips.find((candidate) => candidate.id === targetClipId)
      const targetTrack = targetClip ? tracks.find((track) => track.id === targetClip.trackId) : null
      return Boolean(targetClip) && !isSyncLockedClip(targetClip) && targetTrack?.locked !== true
    })
    const trimSession = createMultiClipTrimSession({
      clips,
      targetClipIds: editableTargetIds,
      primaryClipId: clipId,
      edge,
      fps: timelineFps || 24,
    })
    if (!trimSession) return

    // One history snapshot covers the full shared gesture, regardless of how
    // many mousemove updates occur or how many selected clips are affected.
    saveToHistory()

    // Grabbing an edge on an already-selected clip must preserve the group.
    // An unselected clip keeps the familiar single-clip trim behavior.
    if (!selectedClipIds.includes(clipId)) {
      selectClip(clipId)
    }
    const state = useTimelineStore.getState()
    const anchor = { x: e.clientX, y: e.clientY }
    trimGestureRef.current = {
      expectedClips: state.clips,
      expectedTracks: state.tracks,
      expectedHistory: state.history,
      historyIndex: state.historyIndex,
      selection: [...state.selectedClipIds],
      timelineSessionId: state.timelineSessionId,
      fps: state.timelineFps,
      anchor,
      writing: false,
    }
    setTrimState({ ...trimSession, clipId, startX: e.clientX })
    setTrimPreview({ anchor, feedback: buildTrimPreviewFeedback({ session: trimSession, clips: state.clips, requestedDelta: 0, fps: state.timelineFps }) })
  }

  const handleFadeDragStart = (e, clip, edge) => {
    e.stopPropagation()
    e.preventDefault()

    if (!clip || clip.type !== 'audio') return

    if (slideGestureRef.current) endSlideGesture()
    if (clipDragState) setClipDragState(null)
    if (transitionDragState) setTransitionDragState(null)
    if (rippleTrimGestureRef.current) endRippleTrimGesture()
    if (rollEditState) endRollGesture()
    if (slipGestureRef.current) endSlipGesture()
    if (trimState) endTrimGesture()
    clearActiveSnap()
    saveToHistory()

    const { fadeIn, fadeOut } = getAudioClipFadeValues(clip)
    setFadeDragState({
      clipId: clip.id,
      edge,
      startX: e.clientX,
      startFade: edge === 'in' ? fadeIn : fadeOut,
    })

    selectClip(clip.id)
  }

  useEffect(() => {
    if (!fadeDragState) return

    const handleMouseMove = (e) => {
      const deltaX = e.clientX - fadeDragState.startX
      const deltaTime = deltaX / pixelsPerSecond
      const clip = clips.find(c => c.id === fadeDragState.clipId)
      if (!clip || clip.type !== 'audio') return

      const nextFade = fadeDragState.edge === 'in'
        ? fadeDragState.startFade + deltaTime
        : fadeDragState.startFade - deltaTime

      updateAudioClipProperties(clip.id, {
        [fadeDragState.edge === 'in' ? 'fadeIn' : 'fadeOut']: Math.max(0, nextFade),
      }, false)
    }

    const handleMouseUp = () => {
      setFadeDragState(null)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [fadeDragState, clips, pixelsPerSecond, updateAudioClipProperties])

  // Ripple uses the original physical edge for pointer movement and snapping;
  // the planner returns the actual retained source frame after collapsing time.
  useEffect(() => {
    if (!rippleTrimState) return
    const handleMouseMove = event => {
      const gesture = rippleTrimGestureRef.current
      if (!isRippleTrimGestureCurrent(gesture, useTimelineStore.getState()) || event.buttons === 0) {
        endRippleTrimGesture()
        return
      }
      const rawDelta = (event.clientX - rippleTrimState.startX) / pixelsPerSecond
      const proposedEdge = rippleTrimState.primaryEdgeTime + rawDelta
      // All targets, followers and foreign linked mates are excluded. Every
      // remaining clip is fixed for this token, so snap targets cannot chase us.
      const snapResult = snapTrim(proposedEdge, rippleTrimState.snapExcludedClipIds)
      const requestedDelta = snapResult.snapped ? snapResult.time - rippleTrimState.primaryEdgeTime : rawDelta
      let result
      gesture.writing = true
      try {
        result = useTimelineStore.getState().applyRippleTrim?.(gesture.token, requestedDelta)
      } catch (error) {
        console.warn('[Timeline] Ripple trim failed:', error)
        result = { ok: false, reason: 'Ripple trim could not be completed. Release the edge and try again.' }
      } finally {
        gesture.expectedState = captureRippleTrimState(useTimelineStore.getState())
        gesture.writing = false
      }
      if (!result?.ok) {
        endRippleTrimGesture()
        showRippleTrimRefusal(result?.reason, gesture.anchor)
        return
      }
      if (snapResult.snapped && Math.abs(result.delta - requestedDelta) < 1e-7) setActiveSnapTime(snapResult.time)
      else clearActiveSnap()
      setRippleTrimPreview({ anchor: gesture.anchor, feedback: result.feedback })
    }
    const handleEscape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      endRippleTrimGesture()
    }
    const unsubscribe = useTimelineStore.subscribe(state => {
      const gesture = rippleTrimGestureRef.current
      if (gesture && !gesture.writing && !isRippleTrimGestureCurrent(gesture, state)) endRippleTrimGesture()
    })
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', endRippleTrimGesture)
    window.addEventListener('blur', endRippleTrimGesture)
    window.addEventListener('pointercancel', endRippleTrimGesture)
    window.addEventListener('keydown', handleEscape, true)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', endRippleTrimGesture)
      window.removeEventListener('blur', endRippleTrimGesture)
      window.removeEventListener('pointercancel', endRippleTrimGesture)
      window.removeEventListener('keydown', handleEscape, true)
      unsubscribe()
    }
  }, [rippleTrimState, pixelsPerSecond, snapTrim, setActiveSnapTime, clearActiveSnap, endRippleTrimGesture,
    isRippleTrimGestureCurrent, showRippleTrimRefusal])

  // Handle trim move (mousemove when trimming)
  useEffect(() => {
    if (!trimState) return
    
    const handleMouseMove = (e) => {
      const gesture = trimGestureRef.current
      if (!isTrimGestureCurrent(gesture, useTimelineStore.getState()) || e.buttons === 0) {
        endTrimGesture()
        return
      }
      const deltaX = e.clientX - trimState.startX
      const rawDelta = deltaX / pixelsPerSecond
      const proposedPrimaryEdge = trimState.primaryEdgeTime + rawDelta
      const snapResult = snapTrim(proposedPrimaryEdge, trimState.targetClipIds)
      const requestedDelta = snapResult.snapped
        ? snapResult.time - trimState.primaryEdgeTime
        : rawDelta
      const resolved = resolveMultiClipTrim(trimState, requestedDelta)

      if (snapResult.snapped && Math.abs(resolved.delta - requestedDelta) < 1e-7) {
        setActiveSnapTime(snapResult.time)
      } else {
        clearActiveSnap()
      }

      // The existing trim action remains the only project write. The inset
      // reads its actual frame-quantized result; it never seeks the playhead.
      gesture.writing = true
      try {
        updateClipsTrim(resolved.updates)
      } finally {
        gesture.expectedClips = useTimelineStore.getState().clips
        gesture.writing = false
      }
      const latest = useTimelineStore.getState()
      if (!isTrimGestureCurrent(gesture, latest)) {
        endTrimGesture()
        return
      }
      setTrimPreview({ anchor: gesture.anchor, feedback: buildTrimPreviewFeedback({ session: trimState, clips: latest.clips, requestedDelta, fps: latest.timelineFps }) })
    }
    
    const handleMouseUp = endTrimGesture
    const handleEscape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      endTrimGesture()
    }
    // A selection, lock, undo or project load must not leave an old edge drag
    // running against new clips. Own trim writes are distinguished explicitly.
    const unsubscribe = useTimelineStore.subscribe(state => {
      const gesture = trimGestureRef.current
      if (gesture && !gesture.writing && !isTrimGestureCurrent(gesture, state)) endTrimGesture()
    })
    
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('blur', handleMouseUp)
    window.addEventListener('pointercancel', handleMouseUp)
    window.addEventListener('keydown', handleEscape, true)
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('blur', handleMouseUp)
      window.removeEventListener('pointercancel', handleMouseUp)
      window.removeEventListener('keydown', handleEscape, true)
      unsubscribe()
    }
  }, [trimState, pixelsPerSecond, snapTrim, setActiveSnapTime, clearActiveSnap, updateClipsTrim, endTrimGesture, isTrimGestureCurrent])

  useEffect(() => () => {
    const rippleGesture = rippleTrimGestureRef.current
    rippleTrimGestureRef.current = null
    if (rippleGesture?.token) useTimelineStore.getState().endRippleTrim?.(rippleGesture.token)
    if (rippleGesture) clearActiveSnap()
    const rollGesture = rollGestureRef.current
    rollGestureRef.current = null
    if (rollGesture?.token) useTimelineStore.getState().endRollEdit?.(rollGesture.token)
    const slipGesture = slipGestureRef.current
    slipGestureRef.current = null
    if (slipGesture?.token) useTimelineStore.getState().endSlipEdit?.(slipGesture.token)
    const slideGesture = slideGestureRef.current
    slideGestureRef.current = null
    if (slideGesture?.token) useTimelineStore.getState().endSlideEdit?.(slideGesture.token)
    if (slideGesture) clearActiveSnap()
    if (trimGestureRef.current) {
      trimGestureRef.current = null
      clearActiveSnap()
    }
  }, [clearActiveSnap])

  useEffect(() => {
    if (trimGestureRef.current) endTrimGesture()
    if (rippleTrimGestureRef.current) endRippleTrimGesture()
    if (rollGestureRef.current) endRollGesture()
    if (slipGestureRef.current) endSlipGesture()
    if (slideGestureRef.current) endSlideGesture()
    setRollRefusal(null)
    setSlipRefusal(null)
    setRippleTrimRefusal(null)
    setSlideRefusal(null)
  }, [activeTimelineTool, endTrimGesture, endRollGesture, endSlipGesture, endSlideGesture, endRippleTrimGesture])

  useEffect(() => {
    if (rippleTrimGestureRef.current) endRippleTrimGesture()
    if (trimGestureRef.current) endTrimGesture()
    setRippleTrimRefusal(null)
  }, [rippleEditMode, endRippleTrimGesture, endTrimGesture])

  // Handle clip drag start (mousedown on clip body, not trim handles)
  const handleClipDragStart = (e, clip) => {
    // A context click must never begin a move, trim or Razor edit.
    if (e.button !== 0) return
    // Don't start drag if clicking on trim handles or delete button
    if (trimState || rippleTrimState || rollEditState || slipState || slideState || fadeDragState || e.target.closest('[data-trim-handle]') || e.target.closest('[data-fade-handle]') || e.target.closest('[data-audio-envelope-editor]') || e.target.closest('button')) {
      return
    }
    
    e.stopPropagation()
    e.preventDefault()

    const isShiftHeld = e.shiftKey
    const isCtrlHeld = e.ctrlKey || e.metaKey // metaKey for Mac Cmd
    const hasSelectionModifier = isShiftHeld || isCtrlHeld

    if (isRazorToolActive) {
      const splitTime = getTimeFromClientX(e.clientX)
      const newClip = splitClipWithLinked(clip, splitTime)
      if (newClip) {
        selectClip(newClip.id)
        setPlayheadPosition(splitTime, { snap: true })
      }
      return
    }

    if (isTrimToolActive) {
      if (!selectedClipIds.includes(clip.id) && !hasSelectionModifier) {
        selectClip(clip.id)
      }
      return
    }
    if (isSlipToolActive) {
      if (e.button === 0) handleSlipEditStart(e, clip)
      // Unsupported sources, locks and linked clips must never fall through
      // to ordinary movement (or Alt-drag duplication) in the Slip tool.
      return
    }
    if (isSlideToolActive) {
      if (e.button === 0) handleSlideEditStart(e, clip)
      // Slide exclusively uses its validated three-clip operation. A refusal
      // must never become ordinary movement, overwrite or Alt duplication.
      return
    }
    
    // Store original positions of all selected clips for multi-drag.
    // If the clicked clip belongs to a linked group, include its linked mates so sync is preserved.
    const clipIdsToMove = [...new Set(
      selectedClipIds.includes(clip.id)
        ? selectedClipIds
        : getLinkedClipIds([clip.id])
    )]
    const clipsToMove = clips.filter((candidate) => clipIdsToMove.includes(candidate.id))
    clipDragHistorySavedRef.current = false
    
    setClipDragState({
      clipId: clip.id,
      startX: e.clientX,
      startY: e.clientY,
      originalStartTime: clip.startTime,
      originalTrackId: clip.trackId,
      hasMoved: false,
      pendingAutoCreateVideoTrack: false,
      lastDeltaTime: 0,
      movingClipIds: clipIdsToMove,
      originalPositions: clipsToMove.map((c) => ({
        id: c.id,
        startTime: c.startTime,
        trackId: c.trackId,
        family: getClipTrackFamily(c),
      }))
    })
    
    // Only change selection if this clip isn't already selected
    if (!selectedClipIds.includes(clip.id) && !hasSelectionModifier) {
      selectClip(clip.id)
    }
  }

  // Slide moves the middle and trims both neighbors in one atomic operation.
  useEffect(() => {
    if (!slideState) return
    const handleMouseMove = event => {
      const gesture = slideGestureRef.current
      if (!isSlideGestureCurrent(gesture, useTimelineStore.getState()) || event.buttons === 0) {
        endSlideGesture()
        return
      }
      const pointerDelta = (event.clientX - slideState.startX) / pixelsPerSecond
      const snap = snapClipPosition(slideState.snapExcludedClipIds,
        slideState.originalStartTime + pointerDelta, slideState.originalDuration)
      // Preserve the raw half-frame boundary when no magnet target won;
      // adding/subtracting the timeline offset can round it just below half.
      const requestedDelta = snap.snapped ? snap.startTime - slideState.originalStartTime : pointerDelta
      let result
      gesture.writing = true
      try {
        result = useTimelineStore.getState().applySlideEdit?.(gesture.token, requestedDelta)
      } catch (error) {
        console.warn('[Timeline] Slide edit failed:', error)
        result = { ok: false, reason: 'Slide edit could not be completed. Release the clip and try again.' }
      } finally {
        gesture.expectedState = captureSlideGestureState(useTimelineStore.getState())
        gesture.writing = false
      }
      if (!result?.ok) {
        endSlideGesture()
        showSlideRefusal(result?.reason, gesture.anchor)
        return
      }
      if (snap.snapped && Math.abs(result.delta - requestedDelta) < 1e-8) setActiveSnapTime(snap.snapInfo.snapPoint.time)
      else clearActiveSnap()
      setSlidePreview({ anchor: gesture.anchor, feedback: result.feedback })
    }
    const handleEscape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      endSlideGesture()
    }
    const unsubscribe = useTimelineStore.subscribe(state => {
      const gesture = slideGestureRef.current
      if (gesture && !gesture.writing && !isSlideGestureCurrent(gesture, state)) endSlideGesture()
    })
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', endSlideGesture)
    window.addEventListener('blur', endSlideGesture)
    window.addEventListener('pointercancel', endSlideGesture)
    window.addEventListener('keydown', handleEscape, true)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', endSlideGesture)
      window.removeEventListener('blur', endSlideGesture)
      window.removeEventListener('pointercancel', endSlideGesture)
      window.removeEventListener('keydown', handleEscape, true)
      unsubscribe()
    }
  }, [slideState, pixelsPerSecond, snapClipPosition, setActiveSnapTime, clearActiveSnap, endSlideGesture, isSlideGestureCurrent, showSlideRefusal])

  // Slip keeps placement fixed and uses one cumulative, atomic source edit.
  useEffect(() => {
    if (!slipState || trimState || rollEditState) return

    const handleMouseMove = event => {
      const gesture = slipGestureRef.current
      if (!isSlipGestureCurrent(gesture, useTimelineStore.getState()) || event.buttons === 0) {
        endSlipGesture()
        return
      }
      const requestedDelta = (event.clientX - slipState.startX) / pixelsPerSecond
      let result
      gesture.writing = true
      try {
        result = useTimelineStore.getState().applySlipEdit?.(gesture.token, requestedDelta)
      } catch (error) {
        console.warn('[Timeline] Slip edit failed:', error)
        result = { ok: false, reason: 'Slip edit could not be completed. Release the clip and try again.' }
      } finally {
        gesture.expectedState = captureRollGestureState(useTimelineStore.getState())
        gesture.writing = false
      }
      if (!result?.ok) {
        endSlipGesture()
        showSlipRefusal(result?.reason, gesture.anchor)
        return
      }
      setSlipPreview({ anchor: gesture.anchor, feedback: result.feedback })
    }

    const handleEscape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      endSlipGesture()
    }
    const unsubscribe = useTimelineStore.subscribe(state => {
      const gesture = slipGestureRef.current
      if (gesture && !gesture.writing && !isSlipGestureCurrent(gesture, state)) endSlipGesture()
    })

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', endSlipGesture)
    window.addEventListener('blur', endSlipGesture)
    window.addEventListener('pointercancel', endSlipGesture)
    window.addEventListener('keydown', handleEscape, true)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', endSlipGesture)
      window.removeEventListener('blur', endSlipGesture)
      window.removeEventListener('pointercancel', endSlipGesture)
      window.removeEventListener('keydown', handleEscape, true)
      unsubscribe()
    }
  }, [slipState, trimState, rollEditState, pixelsPerSecond, endSlipGesture, isSlipGestureCurrent, showSlipRefusal])

  // Handle clip dragging (mousemove when dragging a clip)
  // Supports moving multiple selected clips together
  useEffect(() => {
    if (!clipDragState || trimState || slipState) return

    const movingClipIdsForGesture = clipDragState.movingClipIds || clipDragState.originalPositions.map(({ id }) => id)

    // Alt-drag duplicate (Flame/Resolve style): while Alt is held the dragged
    // originals keep following the pointer and spawned copies hold the
    // gesture-start spots. Alt can engage or disengage at any point before
    // mouse-up; the spawn waits for the drag threshold (history saved) so a
    // plain Alt+click never duplicates. The ref is written before state so a
    // mousemove landing between the two can't double-spawn.
    const syncAltDuplicate = (altHeld) => {
      if (clips.some(clip => movingClipIdsForGesture.includes(clip.id) && clip.type === 'compound')) return
      if (altHeld) {
        if (dragDuplicatesRef.current || !clipDragHistorySavedRef.current) return
        const created = duplicateClipsForDrag(movingClipIdsForGesture, clipDragState.originalPositions)
        if (created) {
          dragDuplicatesRef.current = created
          setClipDragState(prev => (prev ? { ...prev, isDuplicating: true } : prev))
        }
      } else if (dragDuplicatesRef.current) {
        removeDragDuplicates(dragDuplicatesRef.current)
        dragDuplicatesRef.current = null
        setClipDragState(prev => (prev ? { ...prev, isDuplicating: false } : prev))
      }
    }

    const handleMouseMove = (e) => {
      const deltaX = e.clientX - clipDragState.startX
      const deltaY = e.clientY - clipDragState.startY
      
      // Check if we've moved enough to consider it a drag (prevents accidental drags on click)
      const hasMoved = clipDragState.hasMoved || Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3
      
      if (!hasMoved) {
        setClipDragState(prev => ({ ...prev, hasMoved: false }))
        return
      }

      // Save one undo snapshot at the start of an actual drag gesture.
      if (!clipDragHistorySavedRef.current) {
        saveToHistory()
        clipDragHistorySavedRef.current = true
      }

      syncAltDuplicate(e.altKey)

      setClipDragState(prev => ({ ...prev, hasMoved: true }))
      
      const clip = clips.find(c => c.id === clipDragState.clipId)
      if (!clip) return
      const movingClipIds = clipDragState.movingClipIds || clipDragState.originalPositions.map(({ id }) => id)
      
      // Calculate new start time based on mouse movement
      const deltaTime = deltaX / pixelsPerSecond
      let proposedStartTime = Math.max(0, clipDragState.originalStartTime + deltaTime)
      
      // Apply snapping (only for the primary dragged clip)
      const snapResult = snapClipPosition(movingClipIds, proposedStartTime, clip.duration)
      
      let finalDeltaTime = deltaTime
      if (snapResult.snapped) {
        proposedStartTime = snapResult.startTime
        finalDeltaTime = proposedStartTime - clipDragState.originalStartTime
        setActiveSnapTime(snapResult.snapInfo.snapPoint.time)
      } else {
        clearActiveSnap()
      }
      
      // Handle vertical track switching
      let newTrackId = clipDragState.originalTrackId
      const isDraggingMultiple = movingClipIds.length > 1
      let groupTrackDelta = 0
      let pendingAutoCreateVideoTrack = false
      
      // Use track content ref for Y (scrollable area where tracks live)
      if (trackContentRef.current) {
        const contentRect = trackContentRef.current.getBoundingClientRect()
        const relativeY = e.clientY - contentRect.top + trackContentRef.current.scrollTop
        const isPrimaryVideoFamily = getClipTrackFamily(clip) === 'video'
        const canAutoCreateAboveTopVideoTrack = isPrimaryVideoFamily
          && trackContentRef.current.scrollTop <= 4
          && e.clientY < contentRect.top

        pendingAutoCreateVideoTrack = canAutoCreateAboveTopVideoTrack

        if (isDraggingMultiple) {
          const primaryOriginal = clipDragState.originalPositions.find((entry) => entry.id === clipDragState.clipId)
          if (primaryOriginal) {
            const primaryTracks = getTracksForFamily(primaryOriginal.family)
            const hoveredTrackId = getHoveredTrackIdForFamily(relativeY, primaryOriginal.family)
            const originalIndex = primaryTracks.findIndex((track) => track.id === primaryOriginal.trackId)
            const targetIndex = primaryTracks.findIndex((track) => track.id === hoveredTrackId)

            if (originalIndex >= 0 && targetIndex >= 0) {
              groupTrackDelta = getResolvedGroupTrackDelta(
                clipDragState.originalPositions,
                targetIndex - originalIndex
              )
            }

            const primaryTargetTrack = primaryTracks[originalIndex + groupTrackDelta]
            if (primaryTargetTrack && !primaryTargetTrack.locked) {
              newTrackId = primaryTargetTrack.id
            }
          }
        } else {
          const hoveredTrackId = getHoveredTrackIdForFamily(relativeY, getClipTrackFamily(clip))
          if (hoveredTrackId) newTrackId = hoveredTrackId
          // The duplicate path below bypasses moveClip, so mirror its
          // captions-track refusal here: non-caption clips stay on their track.
          if (dragDuplicatesRef.current && newTrackId !== clip.trackId) {
            const destTrack = tracks.find(t => t.id === newTrackId)
            if (isCaptionsTrack(destTrack) && !isCaptionClip(clip)) newTrackId = clip.trackId
          }
        }
      }
      
      // Update clip position(s) - don't resolve overlaps during drag, only on mouse up
      if (isDraggingMultiple) {
        // Set all selected clips to original + total delta and preserve their relative track layout.
        const proposed = clipDragState.originalPositions.map(({ id, startTime, trackId, family }) => {
          const relevantTracks = getTracksForFamily(family)
          const originalIndex = relevantTracks.findIndex((track) => track.id === trackId)
          const targetTrack = originalIndex >= 0 ? relevantTracks[originalIndex + groupTrackDelta] : null
          return {
          id,
          startTime: startTime + finalDeltaTime,
          trackId: targetTrack?.id || trackId,
        }
        })
        const minStart = Math.min(...proposed.map((p) => p.startTime))
        const shift = minStart < 0 ? -minStart : 0
        const updates = proposed.map(({ id, startTime, trackId }) => ({
          id,
          startTime: Math.max(0, startTime + shift),
          trackId,
        }))
        setSelectedClipPositions(updates, movingClipIds)
        setClipDragState(prev => ({
          ...prev,
          currentTrackId: newTrackId,
          pendingAutoCreateVideoTrack,
        }))
      } else {
        if (dragDuplicatesRef.current) {
          // The duplicate gesture never ripples: moveClip's live ripple would
          // treat the just-spawned copy as a downstream clip and drag it along.
          setSelectedClipPositions([{ id: clipDragState.clipId, startTime: proposedStartTime, trackId: newTrackId }], [clipDragState.clipId])
        } else {
          // Move single clip (no overlap resolution yet)
          moveClip(clipDragState.clipId, newTrackId, proposedStartTime, false)
        }
        setClipDragState(prev => ({
          ...prev,
          currentTrackId: newTrackId,
          currentStartTime: proposedStartTime,
          pendingAutoCreateVideoTrack,
        }))
      }
    }
    
    const handleMouseUp = () => {
      const resolveOverlapsOnDrop = true

      try {
        // On mouse up, commit the move with normal overwrite behavior: the dropped clip cuts whatever it covers.
        if (clipDragState && clipDragState.hasMoved) {
          const movingClipIds = clipDragState.movingClipIds || clipDragState.originalPositions.map(({ id }) => id)
          const isDraggingMultiple = movingClipIds.length > 1
          if (clipDragState.pendingAutoCreateVideoTrack) {
            const newTrack = addTrack('video')
            if (newTrack) {
              if (isDraggingMultiple) {
                const latestState = useTimelineStore.getState()
                const latestClipsById = new Map(latestState.clips.map((entry) => [entry.id, entry]))
                const selectedVideoTrackIndices = clipDragState.originalPositions
                  .filter((entry) => entry.family === 'video')
                  .map((entry) => {
                    const latestClip = latestClipsById.get(entry.id)
                    const currentTrackId = latestClip?.trackId || entry.trackId
                    return videoTracks.findIndex((track) => track.id === currentTrackId)
                  })
                  .filter((index) => index >= 0)
                const topSelectedVideoTrackIndex = selectedVideoTrackIndices.length > 0
                  ? Math.min(...selectedVideoTrackIndices)
                  : -1
                const updates = clipDragState.originalPositions.map(({ id, startTime, trackId, family }) => {
                  const latestClip = latestClipsById.get(id)
                  let nextTrackId = latestClip?.trackId || trackId

                  if (family === 'video') {
                    const currentTrackId = latestClip?.trackId || trackId
                    const currentIndex = videoTracks.findIndex((track) => track.id === currentTrackId)
                    nextTrackId = currentIndex <= topSelectedVideoTrackIndex
                      ? newTrack.id
                      : (videoTracks[currentIndex - 1]?.id || newTrack.id)
                  }

                  return {
                    id,
                    startTime: latestClip?.startTime ?? startTime,
                    trackId: nextTrackId,
                  }
                })
                setSelectedClipPositions(updates, movingClipIds)
                moveSelectedClips(0, null, resolveOverlapsOnDrop, movingClipIds)
              } else {
                const latestClip = useTimelineStore.getState().clips.find((entry) => entry.id === clipDragState.clipId)
                const finalStartTime = latestClip?.startTime ?? clipDragState.currentStartTime ?? clipDragState.originalStartTime
                moveClip(clipDragState.clipId, newTrack.id, finalStartTime, resolveOverlapsOnDrop)
              }
            } else if (isDraggingMultiple) {
              moveSelectedClips(0, null, resolveOverlapsOnDrop, movingClipIds)
            } else {
              const clip = clips.find(c => c.id === clipDragState.clipId)
              if (clip) {
                moveClip(clipDragState.clipId, clip.trackId, clip.startTime, resolveOverlapsOnDrop)
              }
            }
          } else if (isDraggingMultiple) {
            // For multi-clip drag, resolve overlaps with delta of 0 (clips already in position)
            moveSelectedClips(0, null, resolveOverlapsOnDrop, movingClipIds)
          } else {
            // For single clip drag, commit the current position and overwrite anything underneath.
            const clip = clips.find(c => c.id === clipDragState.clipId)
            if (clip) {
              moveClip(clipDragState.clipId, clip.trackId, clip.startTime, resolveOverlapsOnDrop)
            }
          }
        }
      } finally {
        setClipDragState(null)
        clipDragHistorySavedRef.current = false
        dragDuplicatesRef.current = null // any Alt-drag copies stay put — that IS the committed duplicate
        clearActiveSnap()
      }
    }

    // Alt can flip while the mouse is still, so track the key directly too.
    // preventDefault keeps Alt from focusing the app menu mid-gesture.
    const handleDragKeyDown = (e) => {
      if (e.key === 'Alt') {
        e.preventDefault()
        syncAltDuplicate(true)
      }
    }
    const handleDragKeyUp = (e) => {
      if (e.key === 'Alt') {
        e.preventDefault()
        syncAltDuplicate(false)
      }
    }
    // Focus loss (e.g. Alt+Tab) is not a deliberate drop: withdraw any
    // Alt-drag copies, then commit the move like before.
    const handleWindowBlur = () => {
      syncAltDuplicate(false)
      handleMouseUp()
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('keydown', handleDragKeyDown)
    window.addEventListener('keyup', handleDragKeyUp)
    if (clipDragState.isDuplicating) document.body.style.cursor = 'copy'

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('keydown', handleDragKeyDown)
      window.removeEventListener('keyup', handleDragKeyUp)
      if (clipDragState.isDuplicating) document.body.style.cursor = ''
    }
  }, [clipDragState, trimState, slipState, clips, tracks, pixelsPerSecond, moveClip, moveSelectedClips, setSelectedClipPositions, duplicateClipsForDrag, removeDragDuplicates, selectedClipIds, snapClipPosition, setActiveSnapTime, clearActiveSnap, saveToHistory, addTrack, getClipTrackFamily, getHoveredTrackIdForFamily, getResolvedGroupTrackDelta, getTracksForFamily, videoTracks])

  // Target the cut geometrically on the lane; no permanent overlay can steal
  // clip-edge trimming. Do not frame-round pointer time: the radius is pixels.
  const getTransitionCutAtPointer = (e, trackId, allowExisting = false) => {
    const viewport = timelineRef.current
    if (!viewport) return null
    const rect = viewport.getBoundingClientRect()
    const time = (e.clientX - rect.left + viewport.scrollLeft) / pixelsPerSecond
    return findTransitionCutTarget(useTimelineStore.getState(), {
      trackId, time, pixelsPerSecond, radiusPx: allowExisting ? 12 : 8, allowExisting,
    })
  }

  const handleCutMouseDownCapture = (e, trackId) => {
    // Contextmenu follows mousedown. Stop trim/roll/razor/body handlers before
    // they can begin a right-button editing gesture or change the selection.
    if (e.button === 2 && getTransitionCutAtPointer(e, trackId, true)) e.stopPropagation()
  }

  const handleCutContextMenuCapture = (e, trackId) => {
    const target = getTransitionCutAtPointer(e, trackId, true)
    if (!target) return
    e.preventDefault()
    e.stopPropagation()
    setClipContextMenu(null)
    setMaskSubmenuOpen(false)
    setTransitionMenu({ x: e.clientX, y: e.clientY + 4, target })
  }

  const handleSelectTransition = () => {
    const state = useTimelineStore.getState()
    const target = transitionMenu?.target
    if (isTransitionCutTargetCurrent(state, target)) {
      const maxDuration = state.getMaxTransitionDuration(target.clipA.id, target.clipB.id)
      if (maxDuration >= 1 / FRAME_RATE) {
        state.addTransition(target.clipA.id, target.clipB.id, 'dissolve',
          Math.min(defaultTransitionFrames / FRAME_RATE, maxDuration))
      }
    }
    setTransitionMenu(null)
  }

  const handlePlayAroundCut = () => {
    const state = useTimelineStore.getState()
    const target = transitionMenu?.target
    if (!useAssetsStore.getState().mediaPreparation?.critical
      && !document.querySelector('[data-play-around-blocked="true"]')
      && isTransitionCutTargetCurrent(state, target, { allowExisting: true })) {
      useAssetsStore.getState().setPreviewMode('timeline')
      state.startPlayAround(target.editPoint)
    }
    setTransitionMenu(null)
  }

  const clearTransitionDropFeedback = () => {
    setTransitionDropTarget(null)
    cancelPendingAssetDragOver()
    setDropTarget(null)
    setAssetDropPreview(null)
    clearActiveSnap()
  }

  const handleTransitionDragOverCapture = (e, trackId) => {
    if (!isTransitionDrag(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    cancelPendingAssetDragOver()
    setDropTarget(null)
    setAssetDropPreview(null)
    clearActiveSnap()
    const target = getTransitionCutAtPointer(e, trackId, true)
    const state = useTimelineStore.getState()
    const canDrop = target && state.getMaxTransitionDuration(target.clipA.id, target.clipB.id) >= 1 / FRAME_RATE
    e.dataTransfer.dropEffect = canDrop ? 'copy' : 'none'
    setTransitionDropTarget(canDrop ? `${target.clipA.id}-${target.clipB.id}` : null)
  }

  const handleTransitionDropCapture = (e, trackId) => {
    if (!isTransitionDrag(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    clearTransitionDropFeedback()
    // Payload is readable only at drop, and the cut must still be valid now.
    const payload = parseTransitionDrag(e.dataTransfer, TRANSITION_TYPE_IDS)
    const target = getTransitionCutAtPointer(e, trackId, true)
    if (!payload || !target) return
    const state = useTimelineStore.getState()
    const maxDuration = state.getMaxTransitionDuration(target.clipA.id, target.clipB.id)
    if (maxDuration < 1 / FRAME_RATE) return
    const duration = Math.min(payload.duration, maxDuration)
    if (target.transition) {
      state.updateTransition(target.transition.id, { type: payload.type, duration })
      state.selectTransition(target.transition.id)
    } else {
      state.addTransition(target.clipA.id, target.clipB.id, payload.type, duration)
    }
  }

  const parseEffectDrop = (e) => {
    const raw = e.dataTransfer.getData('application/x-comfystudio-effect')
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  
  // Keep timeline transition menu in sync with global default duration.
  useEffect(() => {
    const handler = (e) => {
      const next = Number(e?.detail)
      if (Number.isFinite(next) && next >= 1) {
        setDefaultTransitionFrames(Math.round(next))
      }
    }
    window.addEventListener('comfystudio-transition-default-duration-changed', handler)
    return () => window.removeEventListener('comfystudio-transition-default-duration-changed', handler)
  }, [])
  
  // Cancel on outside pointer-down (including children that stop bubbling),
  // Escape, focus loss, or a stale cut/project. Playhead ticks don't dismiss it.
  useEffect(() => {
    if (!transitionMenu) return
    const handlePointerDown = (e) => {
      if (!transitionMenuRef.current?.contains(e.target)) setTransitionMenu(null)
    }
    const close = () => setTransitionMenu(null)
    const handleEscape = (e) => {
      if (e.key === 'Escape') close()
    }
    const unsubscribe = useTimelineStore.subscribe((state, previous) => {
      if (state.clips === previous.clips && state.tracks === previous.tracks
        && state.transitions === previous.transitions && state.timelineSessionId === previous.timelineSessionId
        && state.timelineFps === previous.timelineFps && state.compoundEditContext === previous.compoundEditContext) return
      if (!isTransitionCutTargetCurrent(state, transitionMenu.target, { allowExisting: true })) close()
    })
    transitionMenuRef.current?.querySelector('button')?.focus({ preventScroll: true })
    window.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleEscape)
    window.addEventListener('blur', close)
    return () => {
      unsubscribe()
      window.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleEscape)
      window.removeEventListener('blur', close)
    }
  }, [transitionMenu])

  useEffect(() => {
    const clear = () => setTransitionDropTarget(null)
    const escape = (e) => { if (e.key === 'Escape') clear() }
    window.addEventListener('dragend', clear, true)
    window.addEventListener('drop', clear, true)
    window.addEventListener('blur', clear)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('drop', clear, true)
      window.removeEventListener('blur', clear)
      window.removeEventListener('keydown', escape)
    }
  }, [])

  // Handle transition duration dragging
  useEffect(() => {
    if (!transitionDragState || trimState || slipState) return
    
    const handleMouseMove = (e) => {
      const deltaX = e.clientX - transitionDragState.startX
      // 1:1 with mouse: duration change in seconds = pixels moved / pixels per second
      const deltaDuration = deltaX / pixelsPerSecond
      const minDuration = 1 / FRAME_RATE
      
      let newDuration
      if (transitionDragState.edge === 'left') {
        // Left edge: decreasing duration
        newDuration = Math.max(minDuration, transitionDragState.startDuration - deltaDuration)
      } else {
        // Right edge: increasing duration
        newDuration = Math.max(minDuration, transitionDragState.startDuration + deltaDuration)
      }
      
      updateTransition(transitionDragState.transitionId, { duration: parseFloat(newDuration.toFixed(2)) })
    }
    
    const handleMouseUp = () => {
      setTransitionDragState(null)
    }
    
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [transitionDragState, trimState, slipState, pixelsPerSecond, updateTransition])

  // Handle rolling edits through one validated, atomic store action.
  useEffect(() => {
    if (!rollEditState || trimState || slipState) return

    const handleMouseMove = event => {
      const gesture = rollGestureRef.current
      if (!isRollGestureCurrent(gesture, useTimelineStore.getState()) || event.buttons === 0) {
        endRollGesture()
        return
      }
      const requestedDelta = (event.clientX - rollEditState.startX) / pixelsPerSecond
      let result
      gesture.writing = true
      try {
        result = useTimelineStore.getState().applyRollEdit?.(gesture.token, requestedDelta)
      } catch (error) {
        console.warn('[Timeline] Rolling edit failed:', error)
        result = { ok: false, reason: 'Rolling edit could not be completed. Release the handle and try again.' }
      } finally {
        // The first real movement changes history and clips together. Keep
        // every bound reference current before re-enabling stale checks.
        gesture.expectedState = captureRollGestureState(useTimelineStore.getState())
        gesture.writing = false
      }
      if (!result?.ok) {
        endRollGesture()
        showRollRefusal(result?.reason, gesture.anchor)
        return
      }
      setRollPreview({ anchor: gesture.anchor, feedback: result.feedback })
    }

    const handleEscape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      endRollGesture()
    }
    const unsubscribe = useTimelineStore.subscribe(state => {
      const gesture = rollGestureRef.current
      if (gesture && !gesture.writing && !isRollGestureCurrent(gesture, state)) endRollGesture()
    })

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', endRollGesture)
    window.addEventListener('blur', endRollGesture)
    window.addEventListener('pointercancel', endRollGesture)
    window.addEventListener('keydown', handleEscape, true)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', endRollGesture)
      window.removeEventListener('blur', endRollGesture)
      window.removeEventListener('pointercancel', endRollGesture)
      window.removeEventListener('keydown', handleEscape, true)
      unsubscribe()
    }
  }, [rollEditState, trimState, slipState, pixelsPerSecond, endRollGesture, isRollGestureCurrent, showRollRefusal])

  // Get transition between two clips (if exists)
  const getTransitionBetween = (clipAId, clipBId) => {
    return transitions.find(t => 
      (t.clipAId === clipAId && t.clipBId === clipBId) ||
      (t.clipAId === clipBId && t.clipBId === clipAId)
    )
  }

  // Find adjacent or overlapping clips (for showing transition buttons/zones)
  // With the overlap model, clips with transitions will overlap
  const getAdjacentClips = (trackId) => {
    const trackClips = clips
      .filter(c => c.trackId === trackId)
      .sort((a, b) => a.startTime - b.startTime)
    
    const pairs = []
    for (let i = 0; i < trackClips.length - 1; i++) {
      const clipA = trackClips[i]
      const clipB = trackClips[i + 1]
      const clipAEnd = clipA.startTime + clipA.duration
      
      // Check if clips are adjacent (small gap) OR overlapping (transition exists)
      const gap = clipB.startTime - clipAEnd
      const isOverlapping = clipB.startTime < clipAEnd
      const frameDuration = 1 / (timelineFps || FRAME_RATE)
      const trueEditPointTolerance = Math.min(0.001, frameDuration / 10)
      const isTrueEditPoint = Math.abs(gap) <= trueEditPointTolerance
      
      if (isOverlapping || Math.abs(gap) < ADJACENT_CLIP_UI_GAP_SECONDS) {
        // Check if there's a transition between these clips
        const transition = getTransitionBetween(clipA.id, clipB.id)
        pairs.push({ clipA, clipB, transition, isOverlapping, gap, isTrueEditPoint })
      }
    }
    return pairs
  }

  // Get track icon
  const getTrackIcon = (track) => {
    if (track.type === 'video') return <Video className="w-3 h-3" />
    return <Volume2 className="w-3 h-3" />
  }

  // Get track color class
  const getTrackColor = (track) => {
    if (track.type === 'video') return 'bg-sf-clip-video/30 text-[#5a909a]'
    return 'bg-sf-clip-audio/30 text-[#4d8a70]'
  }

  // Check if track can be deleted (must have at least one of each type)
  const canDeleteTrack = (track) => {
    const tracksOfType = tracks.filter(t => t.type === track.type)
    return tracksOfType.length > 1
  }

  // Handle track rename
  const handleStartRename = (track) => {
    setRenamingTrackId(track.id)
    setRenameValue(track.name)
  }

  const handleFinishRename = () => {
    if (renamingTrackId && renameValue.trim()) {
      renameTrack(renamingTrackId, renameValue.trim())
    }
    setRenamingTrackId(null)
    setRenameValue('')
  }

  const handleCancelRename = () => {
    setRenamingTrackId(null)
    setRenameValue('')
  }

  // Handle track delete with confirmation for tracks that have clips
  const handleDeleteTrack = (track) => {
    const trackClips = clips.filter(c => c.trackId === track.id)
    if (trackClips.length > 0) {
      // Confirm if track has clips
      if (!window.confirm(`Delete "${track.name}"? This will also delete ${trackClips.length} clip${trackClips.length > 1 ? 's' : ''} on this track.`)) {
        return
      }
    }
    removeTrack(track.id)
  }

  // ==================== TRACK REORDER DRAG HANDLERS ====================
  const handleTrackDragStart = (e, track, indexInGroup) => {
    e.stopPropagation()
    setTrackDragState({
      trackId: track.id,
      trackType: track.type,
      startY: e.clientY,
      originalIndex: indexInGroup
    })
    setTrackDropTarget(indexInGroup)
  }

  const handleTrackResizeStart = (e, track) => {
    e.stopPropagation()
    e.preventDefault()
    setTrackResizeState({
      trackId: track.id,
      startY: e.clientY,
      startHeight: getTrackHeight(track)
    })
  }

  const handleTrackDragMove = (e) => {
    if (!trackDragState) return
    
    // Calculate which index we're hovering over
    const tracksOfType = trackDragState.trackType === 'video' ? videoTracks : audioTracks
    const draggedTrack = tracksOfType.find(t => t.id === trackDragState.trackId)
    const trackHeight = draggedTrack ? getTrackHeight(draggedTrack) : VIDEO_TRACK_HEIGHT_DEFAULT
    const deltaY = e.clientY - trackDragState.startY
    const indexDelta = Math.round(deltaY / trackHeight)
    const newIndex = Math.max(0, Math.min(tracksOfType.length - 1, trackDragState.originalIndex + indexDelta))
    
    if (newIndex !== trackDropTarget) {
      setTrackDropTarget(newIndex)
    }
  }

  const handleTrackDragEnd = () => {
    if (trackDragState && trackDropTarget !== null && trackDropTarget !== trackDragState.originalIndex) {
      reorderTrack(trackDragState.trackId, trackDropTarget)
    }
    setTrackDragState(null)
    setTrackDropTarget(null)
  }

  // Track drag mouse move/up listeners
  useEffect(() => {
    if (!trackDragState) return
    
    const handleMouseMove = (e) => handleTrackDragMove(e)
    const handleMouseUp = () => handleTrackDragEnd()
    
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [trackDragState, trackDropTarget])

  // Persist custom track heights
  useEffect(() => {
    try {
      localStorage.setItem(TRACK_HEIGHTS_STORAGE_KEY, JSON.stringify(trackHeights))
    } catch (_) {}
  }, [trackHeights])

  // Drop stale track height entries when tracks are removed.
  useEffect(() => {
    setTrackHeights((prev) => {
      const next = {}
      const validIds = new Set(tracks.map(t => t.id))
      let changed = false
      Object.entries(prev || {}).forEach(([trackId, height]) => {
        if (validIds.has(trackId)) {
          next[trackId] = height
        } else {
          changed = true
        }
      })
      return changed ? next : prev
    })
  }, [tracks])

  // Track height resize drag listeners
  useEffect(() => {
    if (!trackResizeState) return

    const handleMouseMove = (e) => {
      const deltaY = e.clientY - trackResizeState.startY
      const nextHeight = Math.max(
        TRACK_HEIGHT_MIN,
        Math.min(TRACK_HEIGHT_MAX, Math.round(trackResizeState.startHeight + deltaY))
      )
      setTrackHeights(prev => ({
        ...(prev || {}),
        [trackResizeState.trackId]: nextHeight
      }))
    }

    const handleMouseUp = () => {
      setTrackResizeState(null)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [trackResizeState])

  const formatTimelineTimecode = (seconds) => formatFrameTimecode(seconds, timecodeFps)

  const renderRippleTrimHandles = (clip, track) => {
    const stop = event => { event.preventDefault(); event.stopPropagation() }
    const locked = track.locked || clip.locked || isSyncLockedClip(clip)
    return ['left', 'right'].map(edge => <div key={edge} data-trim-handle="true" data-ripple-trim-handle={edge}
      title={`Ripple trim ${edge === 'left' ? 'head' : 'tail'}${locked ? ' · locked' : ''}`}
      className={`absolute top-0 bottom-0 z-50 w-3 ${edge === 'left' ? 'left-0' : 'right-0'} ${locked ? 'cursor-not-allowed' : 'cursor-ew-resize'} bg-accent/0 hover:bg-accent/25`}
      style={{ pointerEvents: 'auto' }} onMouseDown={event => handleTrimStart(event, clip.id, edge)}
      onClick={stop} onDoubleClick={stop} onContextMenu={stop} onDragOver={stop} onDrop={stop} />)
  }

  // Locked lanes normally ignore pointers. In Slip only, expose a guarded
  // refusal surface without enabling their trim/fade/effect controls.
  const renderLockedSlipTarget = clip => {
    const stop = event => { event.preventDefault(); event.stopPropagation() }
    return <div data-testid="slip-edit-locked-target" className="absolute inset-0 z-50 cursor-not-allowed"
      style={{ pointerEvents: 'auto' }}
      onMouseDown={event => { stop(event); if (event.button === 0) handleSlipEditStart(event, clip) }}
      onClick={stop} onDoubleClick={stop} onContextMenu={stop} onDragOver={stop} onDrop={stop} />
  }

  const renderLockedSlideTarget = clip => {
    const stop = event => { event.preventDefault(); event.stopPropagation() }
    return <div data-testid="slide-edit-locked-target" data-slide-edit-target={clip.id}
      className="absolute inset-0 z-50 cursor-not-allowed" style={{ pointerEvents: 'auto' }}
      onMouseDown={event => { stop(event); if (event.button === 0) handleSlideEditStart(event, clip) }}
      onClick={stop} onDoubleClick={stop} onContextMenu={stop} onDragOver={stop} onDrop={stop} />
  }

  const getMajorRulerStep = (pixelsPerSec) => {
    // Keep labels readable while allowing finer granularity at high zoom.
    const candidates = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
    const minSpacingPx = 95
    return candidates.find(step => step * pixelsPerSec >= minSpacingPx) || candidates[candidates.length - 1]
  }

  const rulerTicks = useMemo(() => {
    const majorStep = getMajorRulerStep(pixelsPerSecond)
    const minorDivisions = majorStep >= 60 ? 6 : (majorStep >= 10 ? 5 : (majorStep >= 1 ? 4 : 5))
    const safeFps = getSafeTimelineFps(timecodeFps, FRAME_RATE)
    const displayFps = getTimecodeFrameRate(timecodeFps, FRAME_RATE)
    const majorFrameStep = Math.max(1, Math.round(majorStep * safeFps))
    const minorFrameStep = majorFrameStep <= displayFps
      ? 1
      : Math.max(1, Math.round(majorFrameStep / minorDivisions))
    const maxFrame = Math.ceil(duration * safeFps)
    const major = []
    const minor = []
    const majorFrames = new Set()

    for (let frame = 0; frame <= maxFrame; frame += majorFrameStep) {
      const time = frame / safeFps
      if (time > duration + 1e-6) break
      majorFrames.add(frame)
      major.push(time)
    }

    for (let frame = 0; frame <= maxFrame; frame += minorFrameStep) {
      if (majorFrames.has(frame)) continue
      const time = frame / safeFps
      if (time > duration + 1e-6) break
      minor.push(time)
    }

    return { major, minor, majorStep, minorStep: minorFrameStep / safeFps }
  }, [duration, pixelsPerSecond, timecodeFps])

  return (
    <div className="h-full bg-sf-dark-900 border-t border-sf-dark-700 flex flex-col"
      onPointerDownCapture={handleTimelinePointerFocus}>
      {compoundEditContext && <div data-testid="compound-breadcrumb" className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-violet-400/20 bg-violet-400/10 px-3 py-1.5 text-xs text-sf-text-primary">
        <button type="button" data-testid="compound-back" onClick={backFromCompound} className="flex items-center gap-1 rounded px-1 py-0.5 text-violet-200 hover:bg-violet-400/15"><ArrowLeft className="h-3 w-3" />Back to Timeline</button>
        <span className="min-w-0 break-words">Editing: {compoundEditContext.compoundName || 'Compound Clip'}</span>
        <span className="text-[10px] text-sf-text-muted">Original clips · one level only</span>
      </div>}
      {compoundNavigationError && <p data-testid="compound-navigation-status" role="alert" className="flex-shrink-0 break-words border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">{compoundNavigationError}</p>}
      {gapDeleteError && <div data-testid="gap-delete-status" role="alert" className="flex flex-shrink-0 items-start gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
        <p className="min-w-0 flex-1 break-words">{gapDeleteError}</p>
        <button type="button" onClick={() => setGapDeleteError('')} aria-label="Dismiss gap message" className="rounded p-0.5 hover:bg-amber-500/15"><X className="h-3 w-3" /></button>
      </div>}
      {isMusicPopoverOpen && (
        <GenerateMusicPopover
          anchorRect={musicPopoverAnchor}
          onClose={() => setIsMusicPopoverOpen(false)}
        />
      )}
      {/* Timeline Header - compact editor toolbar and zoom controls */}
      <div className="h-8 bg-sf-dark-800 border-b border-sf-dark-700 flex items-center px-2 gap-2 overflow-hidden">
        <div ref={toolbarScrollRef} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
          <div className={toolbarSectionClass} aria-label="Add tracks">
            <button
              onClick={() => addTrack('video')}
              className={toolbarButtonClass}
              title={t('timelineEditor.tooltips.addVideoTrack')}
            >
              <Plus className="w-3 h-3" />
              {showToolbarLabels && 'Video'}
            </button>
            <button
              onClick={() => addTrack('audio', { channels: 'mono' })}
              className={toolbarButtonClass}
              title={t('timelineEditor.tooltips.addMonoAudioTrack')}
            >
              <Plus className="w-3 h-3" />
              {showToolbarLabels && 'Mono'}
            </button>
            <button
              onClick={() => addTrack('audio', { channels: 'stereo' })}
              className={toolbarButtonClass}
              title={t('timelineEditor.tooltips.addStereoAudioTrack')}
            >
              <Plus className="w-3 h-3" />
              {showToolbarLabels && 'Stereo'}
            </button>
          </div>

          <div className={toolbarSectionClass} aria-label="Insert timeline items">
            <button
              onClick={() => addMarker(getLivePlayhead())}
              className={toolbarButtonClass}
              title={t('timelineEditor.tooltips.addMarker', { shortcut: markerHotkeyLabel })}
            >
              <Flag className="w-3 h-3 text-yellow-400" />
              {showToolbarLabels && 'Marker'}
            </button>
            <button
              onClick={handleAddAdjustmentLayer}
              className={toolbarButtonClass}
              title={t('timelineEditor.tooltips.addAdjustmentLayer')}
            >
              <Square className="w-3 h-3 text-purple-400" />
              {showToolbarLabels && 'Adj'}
            </button>
            <button
              onClick={() => addTextClipAtPlayhead()}
              disabled={!preferredVideoTrack}
              className={toolbarButtonClass}
              title={preferredVideoTrack
                ? t('timelineEditor.tooltips.addText', { track: preferredVideoTrack.name, shortcut: addTextClipHotkeyLabel })
                : t('timelineEditor.tooltips.addTextNeedsTrack', { shortcut: addTextClipHotkeyLabel })}
            >
              <Type className="w-3 h-3" />
              {showToolbarLabels && 'Text'}
            </button>
            <button
              onClick={() => addShapeClipAtPlayhead()}
              disabled={!preferredVideoTrack}
              className={toolbarButtonClass}
              title={preferredVideoTrack
                ? t('timelineEditor.tooltips.addShape', { track: preferredVideoTrack.name })
                : t('timelineEditor.tooltips.addShapeNeedsTrack')}
            >
              <Square className="w-3 h-3 text-cyan-300" />
              {showToolbarLabels && 'Shape'}
            </button>
            <button
              onClick={() => handleOpenTimelineCaptions()}
              className={toolbarButtonClass}
              title={t('timelineEditor.tooltips.addCaptions')}
            >
              <Type className="w-3 h-3 text-cyan-300" />
              {showToolbarLabels && 'Captions'}
            </button>
            {selectedMarkerId && (
              <button
                onClick={() => removeMarker(selectedMarkerId)}
                className={toolbarDangerButtonClass}
                title={t('timelineEditor.tooltips.removeMarker')}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <div className={toolbarSectionClass} aria-label="Edit selection">
            <button
              onClick={splitAllTracksAtPlayhead}
              className={toolbarButtonClass}
              title={t('timelineEditor.tooltips.splitAll', { shortcut: splitAllHotkeyLabel })}
            >
              <Scissors className="w-3 h-3" />
              {showToolbarLabels && 'Cut All'}
            </button>
            <ActiveTrackSplitButton
              onClick={handleSplitActiveTrackAtPlayhead}
              className={toolbarButtonClass}
              showLabel={showToolbarLabels}
              availableTitle={t('timelineEditor.tooltips.splitActive', { shortcut: splitActiveHotkeyLabel })}
              unavailableTitle={t('timelineEditor.tooltips.splitActiveUnavailable', { shortcut: splitActiveHotkeyLabel })}
            />
            <button
              onClick={handleCopySelection}
              disabled={selectedClipIds.length === 0 || hasCompoundSelection}
              className={toolbarButtonClass}
              title={t('timelineEditor.tooltips.copy', { shortcut: copyHotkeyLabel })}
            >
              <Copy className="w-3 h-3" />
              {showToolbarLabels && 'Copy'}
            </button>
            <button
              onClick={handlePasteAtPlayhead}
              disabled={!activeTrackId || copiedClips.length === 0 || copiedClips.some(clip => clip.type === 'compound')}
              className={toolbarButtonClass}
              title={activeTrackId && copiedClips.length > 0
                ? t('timelineEditor.tooltips.paste', { shortcut: pasteHotkeyLabel })
                : t('timelineEditor.tooltips.pasteUnavailable', { shortcut: pasteHotkeyLabel })}
            >
              <ClipboardPaste className="w-3 h-3" />
              {showToolbarLabels && 'Paste'}
            </button>
            <button
              onClick={() => toggleClipSelectionEnabled()}
              disabled={selectedClipIds.length === 0}
              className={toolbarButtonClass}
              title={selectedClipIds.length > 0
                ? t(selectedClipsShouldEnable ? 'timelineEditor.tooltips.enableSelected' : 'timelineEditor.tooltips.disableSelected', { shortcut: toggleClipEnabledHotkeyLabel })
                : t('timelineEditor.tooltips.toggleSelectedUnavailable', { shortcut: toggleClipEnabledHotkeyLabel })}
            >
              {selectedClipsShouldEnable ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
              {showToolbarLabels && (selectedClipsShouldEnable ? 'Enable' : 'Disable')}
            </button>
            <button
              onClick={() => { void handleRenderClips(renderableSelectedClips) }}
              disabled={renderableSelectedClips.length === 0}
              className={toolbarButtonClass}
              title={renderableSelectedClips.length > 0
                ? t(renderableSelectedClips.length > 1 ? 'timelineEditor.tooltips.renderSelectedMany' : 'timelineEditor.tooltips.renderSelectedOne', { count: renderableSelectedClips.length })
                : t('timelineEditor.tooltips.renderUnavailable')}
            >
              <Zap className="w-3 h-3" />
              {showToolbarLabels && 'Render'}
            </button>
            <button
              onClick={handleDeleteCurrentSelection}
              disabled={!canDeleteCurrentSelection}
              className={toolbarDangerButtonClass}
              title={
                selectedClipIds.length > 0
                  ? t(rippleEditMode ? 'timelineEditor.tooltips.rippleDeleteSelected' : 'timelineEditor.tooltips.deleteSelected')
                  : selectedGap
                    ? 'Close this empty gap across all tracks. Stops if any media occupies the same time or affected clips are locked.'
                    : selectedTransitionId
                      ? t('timelineEditor.tooltips.deleteTransition')
                      : selectedMarkerId
                        ? t('timelineEditor.tooltips.deleteMarker')
                        : t('timelineEditor.tooltips.deleteUnavailable')
              }
            >
              <Trash2 className="w-3 h-3" />
              {showToolbarLabels && 'Delete'}
            </button>
          </div>

          <div className="inline-flex h-7 items-center gap-0.5 rounded-md border border-sf-dark-600 bg-sf-dark-950/80 p-0.5 shadow-inner" aria-label="Timeline edit tools">
            {timelineToolOptions.map((tool) => {
              const Icon = tool.icon
              const active = activeTimelineTool === tool.id
              return (
                <button
                  key={tool.id}
                  type="button"
                  data-testid={`timeline-tool-${tool.id}`}
                  onClick={() => setActiveTimelineTool(tool.id)}
                  className={toolbarToggleClass(active)}
                  title={`${tool.title}${tool.shortcut ? ` (${tool.shortcut})` : ''}`}
                  aria-label={tool.label}
                  aria-pressed={active}
                >
                  <Icon className="w-3 h-3" />
                  {showToolbarLabels && tool.label}
                </button>
              )
            })}
          </div>

          <div className={toolbarSectionClass} aria-label="Timeline options">
            <button
              onClick={toggleSnapping}
              className={toolbarToggleClass(snappingEnabled)}
              title={t('timelineEditor.tooltips.snapping', { state: snappingEnabled ? 'ON' : 'OFF', shortcut: snappingHotkeyLabel })}
            >
              <Magnet className="w-3 h-3" />
              {showToolbarLabels && 'Snap'}
            </button>
            {toolbarTier !== 'overflow' && (
              <button
                onClick={toggleRippleEdit}
                data-testid="ripple-edit-toggle"
                aria-pressed={rippleEditMode}
                className={toolbarToggleClass(rippleEditMode)}
                title={t('timelineEditor.tooltips.ripple', { state: rippleEditMode ? 'ON' : 'OFF', shortcut: rippleHotkeyLabel })}
              >
                <ArrowRightLeft className="w-3 h-3" />
                {showToolbarLabels && 'Ripple'}
              </button>
            )}
            {toolbarTier !== 'overflow' && (
              <button
                onClick={(event) => {
                  if (isMusicPopoverOpen) {
                    setIsMusicPopoverOpen(false)
                  } else {
                    setMusicPopoverAnchor(event.currentTarget.getBoundingClientRect())
                    setIsMusicPopoverOpen(true)
                  }
                }}
                className={toolbarToggleClass(isMusicPopoverOpen)}
                title={t('timelineEditor.tooltips.generateMusic')}
              >
                <MusicIcon className="w-3 h-3" />
                {showToolbarLabels && 'Music'}
              </button>
            )}
          </div>

          {toolbarTier !== 'overflow' && (
          <div className={toolbarSectionClass} aria-label="Select timeline ranges">
            <button
              onClick={selectClipsFromTimelineStartToPlayhead}
              className={toolbarButtonClass}
              title={t('timelineEditor.tooltips.selectFromStart', { shortcut: selectFromStartHotkeyLabel })}
            >
              <ChevronLeft className="w-3 h-3" />
              {showToolbarLabels && 'From Start'}
            </button>
            <button
              onClick={selectClipsFromPlayheadToEnd}
              className={toolbarButtonClass}
              title={t('timelineEditor.tooltips.selectToEnd', { shortcut: selectToEndHotkeyLabel })}
            >
              <ChevronRight className="w-3 h-3" />
              {showToolbarLabels && 'To End'}
            </button>
            {selectedClipIds.length > 0 && (
              <button
                onClick={openMoveOffsetDialog}
                className={toolbarButtonClass}
                title={t('timelineEditor.tooltips.moveBy', { shortcut: moveByHotkeyLabel })}
              >
                <ArrowRightLeft className="w-3 h-3" />
                {showToolbarLabels && 'Move By'}
              </button>
            )}
            {selectedClipIds.length > 0 && (
              <button
                onClick={openDurationDeltaDialog}
                className={toolbarButtonClass}
                title={t('timelineEditor.tooltips.durationBy', { shortcut: durationByHotkeyHint ? ` (${durationByHotkeyHint})` : '' })}
              >
                <Clock className="w-3 h-3" />
                {showToolbarLabels && 'Duration By'}
              </button>
            )}
          </div>
          )}
        </div>

        {/* Info & Zoom */}
        <div className="flex shrink-0 items-center gap-2">
          {toolbarTier === 'overflow' && (
            <>
              <button
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  setToolbarOverflowAnchor(event.currentTarget.getBoundingClientRect())
                  setToolbarOverflowOpen((open) => !open)
                }}
                className={toolbarToggleClass(toolbarOverflowOpen)}
                title={t('timelineEditor.tooltips.moreTools')}
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
              {toolbarOverflowOpen && toolbarOverflowAnchor && (
                <div
                  onMouseDown={(event) => event.stopPropagation()}
                  className="fixed z-50 w-48 rounded-md border border-sf-dark-600 bg-sf-dark-800 p-1 shadow-2xl shadow-black/50 flex flex-col gap-0.5"
                  style={{
                    top: toolbarOverflowAnchor.bottom + 4,
                    right: Math.max(8, window.innerWidth - toolbarOverflowAnchor.right),
                  }}
                >
                  <button
                    onClick={() => { toggleRippleEdit(); setToolbarOverflowOpen(false) }}
                    className={overflowMenuItemClass}
                    title={`Ripple Edit (${rippleHotkeyLabel} to toggle)`}
                  >
                    <ArrowRightLeft className="w-3 h-3" />
                    Ripple Edit {rippleEditMode ? '· ON' : ''}
                  </button>
                  <button
                    onClick={(event) => {
                      setMusicPopoverAnchor(event.currentTarget.getBoundingClientRect())
                      setIsMusicPopoverOpen(true)
                      setToolbarOverflowOpen(false)
                    }}
                    className={overflowMenuItemClass}
                    title="Generate music"
                  >
                    <MusicIcon className="w-3 h-3" />
                    Generate Music
                  </button>
                  <button
                    onClick={() => { selectClipsFromTimelineStartToPlayhead(); setToolbarOverflowOpen(false) }}
                    className={overflowMenuItemClass}
                    title={`Select clips from the timeline start to the playhead (${selectFromStartHotkeyLabel})`}
                  >
                    <ChevronLeft className="w-3 h-3" />
                    Select From Start
                  </button>
                  <button
                    onClick={() => { selectClipsFromPlayheadToEnd(); setToolbarOverflowOpen(false) }}
                    className={overflowMenuItemClass}
                    title={`Select clips from the playhead to the end (${selectToEndHotkeyLabel})`}
                  >
                    <ChevronRight className="w-3 h-3" />
                    Select To End
                  </button>
                  <button
                    onClick={() => { openMoveOffsetDialog(); setToolbarOverflowOpen(false) }}
                    disabled={selectedClipIds.length === 0}
                    className={overflowMenuItemClass}
                    title={`Move selected clips by an exact offset (${moveByHotkeyLabel})`}
                  >
                    <ArrowRightLeft className="w-3 h-3" />
                    Move By…
                  </button>
                  <button
                    onClick={() => { openDurationDeltaDialog(); setToolbarOverflowOpen(false) }}
                    disabled={selectedClipIds.length === 0}
                    className={overflowMenuItemClass}
                    title="Change selected clip duration by an exact amount"
                  >
                    <Clock className="w-3 h-3" />
                    Duration By…
                  </button>
                </div>
              )}
            </>
          )}
          <button
            onClick={handleFrameAll}
            className="p-1.5 hover:bg-sf-dark-600 rounded text-sf-text-muted"
            title={`${t('timelineEditor.tooltips.frameAll')}${frameAllHotkeyHint}`}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          {/* Track height presets */}
          <div className="flex items-center gap-0.5 mr-2">
            {[
              ['compact', 'S', t('timelineEditor.tooltips.trackHeightCompact')],
              ['normal', 'M', t('timelineEditor.tooltips.trackHeightNormal')],
              ['tall', 'L', t('timelineEditor.tooltips.trackHeightTall')],
            ].map(([id, label, tip]) => (
              <button
                key={id}
                onClick={() => applyTrackHeightPreset(id)}
                title={tip}
                className={`w-5 h-5 flex items-center justify-center rounded text-[10px] transition-colors ${
                  trackHeightPreset === id
                    ? 'bg-sf-accent/20 text-sf-accent border border-sf-accent/40'
                    : 'text-sf-text-muted hover:bg-sf-dark-600'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => applyZoomWithPlayheadPivot(zoom - 50)}
              className="p-0.5 hover:bg-sf-dark-600 rounded text-sf-text-muted"
              title={`${t('timelineEditor.tooltips.zoomOut')}${zoomOutHotkeyHint}`}
            >
              <span className="text-xs">−</span>
            </button>
            <input
              type="range"
              min={sliderMinZoom}
              max="2000"
              value={zoom}
              onChange={(e) => applyZoomWithPlayheadPivot(parseInt(e.target.value, 10))}
              className="w-24 h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
            />
            <button
              onClick={() => applyZoomWithPlayheadPivot(zoom + 50)}
              className="p-0.5 hover:bg-sf-dark-600 rounded text-sf-text-muted"
              title={`${t('timelineEditor.tooltips.zoomIn')}${zoomInHotkeyHint}`}
            >
              <span className="text-xs">+</span>
            </button>
            <span className="text-[10px] text-sf-text-muted w-12">{Math.round(zoom)}%</span>
          </div>
        </div>
      </div>

      {/* Timeline Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Track Headers - Resizable */}
        <div 
          className="flex-shrink-0 border-r border-sf-dark-700 flex flex-col relative"
          style={{ width: `${trackHeadersWidth}px` }}
        >
          {/* Time ruler header spacer */}
          <div className="h-5 flex-shrink-0 border-b border-sf-dark-700 bg-sf-dark-800" />
          
          {/* Resize handle */}
          <div
            className="absolute right-0 top-0 bottom-0 w-1 cursor-ew-resize hover:bg-sf-accent/50 active:bg-sf-accent z-20 group"
            onMouseDown={(e) => {
              e.preventDefault()
              setIsResizingHeaders(true)
              resizeStartX.current = e.clientX
              resizeStartWidth.current = trackHeadersWidth
            }}
          >
            {/* Visual indicator on hover */}
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-sf-dark-500 rounded opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          
          {/* Scrollable track headers container */}
          <div 
            ref={trackHeadersRef}
            data-testid="timeline-track-headers"
            className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-track-sf-dark-900 scrollbar-thumb-sf-dark-600"
            onScroll={(e) => {
              // Sync scroll with track content
              if (trackContentRef.current) {
                trackContentRef.current.scrollTop = e.target.scrollTop
              }
            }}
          >
          
          {autoCreateVideoTrackIndicatorVisible && (
            <div
              className="relative flex items-center px-2 gap-1.5 border-b border-dashed border-sf-accent/70 bg-sf-accent/8"
              style={{ minHeight: autoCreateVideoTrackIndicatorHeight, height: autoCreateVideoTrackIndicatorHeight }}
            >
              <div className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0 bg-sf-accent/20 text-sf-accent border border-sf-accent/40">
                <Video className="w-3 h-3" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-sf-text-primary font-medium">Release to add video track</div>
                <div className="text-[9px] text-sf-text-muted uppercase tracking-[0.16em]">New top track</div>
              </div>
              <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-sf-accent/15 text-sf-accent text-[10px] font-medium">
                <Plus className="w-3 h-3" />
                <span>Add</span>
              </div>
            </div>
          )}

          {/* Video Tracks */}
          {videoTracks.map((track, index) => {
            const isDragging = trackDragState?.trackId === track.id
            const isDropTarget = trackDragState?.trackType === 'video' && trackDropTarget === index && !isDragging
            const headerHeight = getTrackHeight(track)
            
            return (
            <div 
              key={track.id}
              onClick={() => setActiveTrack(track.id)}
              title={activeTrackId === track.id ? `Active track — press ${splitActiveHotkeyLabel} to split at playhead, or ${splitAllHotkeyLabel} to split all tracks` : `Click to set as active track (${splitActiveHotkeyLabel} cuts at playhead on this track; ${splitAllHotkeyLabel} splits all tracks)`}
              className={`relative flex items-center px-2 gap-1 border-b border-sf-dark-700 hover:bg-sf-dark-800 transition-colors group/track cursor-pointer ${
                track.locked ? 'bg-sf-dark-800/50' : ''
              } ${isDragging ? 'opacity-50 bg-sf-dark-700' : ''} ${isDropTarget ? 'border-t-2 border-t-purple-500' : ''}`}
              style={{ minHeight: headerHeight, height: headerHeight }}
            >
              <div
                className={`p-0.5 rounded hover:bg-sf-dark-600 ${track.locked ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'}`}
                onMouseDown={(e) => {
                  e.stopPropagation()
                  !track.locked && handleTrackDragStart(e, track, index)
                }}
              >
                <GripVertical className={`w-3 h-3 ${track.locked ? 'text-sf-dark-600' : 'text-sf-dark-500'}`} />
              </div>
              {/* Track type box — red outline when active (Resolve style) */}
              <div
                className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 ${getTrackColor(track)} ${
                  activeTrackId === track.id ? 'ring-2 ring-red-500 ring-offset-1 ring-offset-sf-dark-800' : ''
                }`}
              >
                {getTrackIcon(track)}
              </div>
              
              {/* Track name - editable */}
              {renamingTrackId === track.id ? (
                <div className="flex-1 flex items-center gap-1">
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleFinishRename()
                      if (e.key === 'Escape') handleCancelRename()
                    }}
                    autoFocus
                    className="w-full bg-sf-dark-700 text-[11px] text-sf-text-primary px-1 py-0.5 rounded border border-sf-accent outline-none"
                  />
                  <button onClick={(e) => { e.stopPropagation(); handleFinishRename() }} className="p-0.5 hover:bg-sf-dark-600 rounded">
                    <Check className="w-3 h-3 text-green-400" />
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); handleCancelRename() }} className="p-0.5 hover:bg-sf-dark-600 rounded">
                    <X className="w-3 h-3 text-sf-text-muted" />
                  </button>
                </div>
              ) : (
                <span 
                  className="text-[11px] text-sf-text-primary flex-1 truncate cursor-pointer hover:text-sf-accent"
                  onDoubleClick={(e) => { e.stopPropagation(); handleStartRename(track) }}
                  title="Double-click to rename"
                >
                  {track.name}
                </span>
              )}
              
              <div className="flex items-center gap-0.5">
                {/* Rename button */}
                <button 
                  onClick={(e) => { e.stopPropagation(); handleStartRename(track) }}
                  className="p-0.5 hover:bg-sf-dark-600 rounded opacity-0 group-hover/track:opacity-100 transition-opacity"
                  title="Rename track"
                >
                  <Pencil className="w-3 h-3 text-sf-text-muted" />
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); toggleTrackVisibility(track.id) }}
                  className="p-0.5 hover:bg-sf-dark-600 rounded"
                  title={track.visible ? 'Hide video track' : 'Show video track'}
                >
                  {track.visible ? (
                    <Eye className="w-3 h-3 text-sf-text-muted" />
                  ) : (
                    <EyeOff className="w-3 h-3 text-sf-text-muted opacity-50" />
                  )}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); toggleTrackSolo(track.id) }}
                  className={`min-w-[18px] h-[18px] flex items-center justify-center rounded text-[10px] font-bold transition-colors ${
                    track.solo
                      ? 'bg-yellow-500/80 text-black'
                      : 'bg-sf-dark-600 text-sf-text-muted hover:bg-sf-dark-500 hover:text-sf-text-secondary'
                  }`}
                  title={track.solo ? 'Unsolo video track' : 'Solo video track (show only soloed video tracks)'}
                  aria-pressed={track.solo === true}
                  aria-label={`${track.solo ? 'Unsolo' : 'Solo'} video track ${track.name}`}
                >
                  S
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); toggleTrackLock(track.id) }}
                  className="p-0.5 hover:bg-sf-dark-600 rounded"
                >
                  {track.locked ? (
                    <Lock className="w-3 h-3 text-sf-warning" />
                  ) : (
                    <Unlock className="w-3 h-3 text-sf-text-muted" />
                  )}
                </button>
                {/* Delete track button */}
                {canDeleteTrack(track) && (
                  <button 
                    onClick={(e) => { e.stopPropagation(); handleDeleteTrack(track) }}
                    className="p-0.5 hover:bg-sf-error/30 rounded opacity-0 group-hover/track:opacity-100 transition-opacity"
                    title="Delete track"
                  >
                    <X className="w-3 h-3 text-sf-error" />
                  </button>
                )}
                {/* Primary track (Flame style) — click to set as active for X cut */}
                <button
                  onClick={(e) => { e.stopPropagation(); setActiveTrack(track.id) }}
                  className={`min-w-[18px] h-[18px] flex items-center justify-center rounded text-[10px] font-bold transition-colors ${
                    activeTrackId === track.id
                      ? 'bg-red-500 text-white'
                      : 'bg-sf-dark-600 text-sf-text-muted hover:bg-sf-dark-500 hover:text-sf-text-secondary'
                  }`}
                  title={activeTrackId === track.id ? 'Primary track (X cuts here)' : 'Set as primary track'}
                >
                  P
                </button>
              </div>
              {/* Drag bottom edge to resize track vertically */}
              <div
                className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize z-30 group/track-resize"
                onMouseDown={(e) => handleTrackResizeStart(e, track)}
                title="Drag to resize track height"
              >
                <div className="absolute left-7 right-2 top-1/2 -translate-y-1/2 h-px bg-white/0 group-hover/track-resize:bg-white/35 transition-colors" />
              </div>
            </div>
          )})}
          
          {/* Audio Section Divider */}
          <div className="h-5 bg-sf-dark-800 border-b border-sf-dark-700 flex items-center px-2">
            <span className="text-[9px] text-sf-text-muted uppercase tracking-wider">Audio</span>
            <button
              onClick={(event) => {
                if (isMusicPopoverOpen) {
                  setIsMusicPopoverOpen(false)
                } else {
                  setMusicPopoverAnchor(event.currentTarget.getBoundingClientRect())
                  setIsMusicPopoverOpen(true)
                }
              }}
              className="ml-auto p-0.5 hover:bg-sf-dark-700 rounded"
              title="Generate music"
            >
              <MusicIcon className="w-3 h-3 text-sf-accent" />
            </button>
          </div>
          
          {/* Audio Tracks */}
          {audioTracks.map((track, index) => {
            const isDragging = trackDragState?.trackId === track.id
            const isDropTarget = trackDragState?.trackType === 'audio' && trackDropTarget === index && !isDragging
            
            const isStereo = track.type === 'audio' && track.channels !== 'mono'
            const headerHeight = getTrackHeight(track)
            const audioTrackNumber = index + 1
            const channelLabels = isStereo
              ? [`A${audioTrackNumber}.L`, `A${audioTrackNumber}.R`]
              : [`A${audioTrackNumber}`]
            
            return (
            <div 
              key={track.id}
              onClick={() => setActiveTrack(track.id)}
              title={activeTrackId === track.id ? `Active track — press ${splitActiveHotkeyLabel} to split at playhead, or ${splitAllHotkeyLabel} to split all tracks` : `Click to set as active track (${splitActiveHotkeyLabel} cuts at playhead on this track; ${splitAllHotkeyLabel} splits all tracks)`}
              className={`relative flex flex-col px-2 gap-0 border-b border-sf-dark-700 hover:bg-sf-dark-800 transition-colors group/track cursor-pointer ${
                track.locked ? 'bg-sf-dark-800/50' : ''
              } ${isDragging ? 'opacity-50 bg-sf-dark-700' : ''} ${isDropTarget ? 'border-t-2 border-t-purple-500' : ''}`}
              style={{ minHeight: headerHeight, height: headerHeight }}
            >
              <div className="flex-1 flex items-center gap-1 min-h-0">
                <div
                  className={`p-0.5 rounded hover:bg-sf-dark-600 ${track.locked ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'}`}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    !track.locked && handleTrackDragStart(e, track, index)
                  }}
                >
                  <GripVertical className={`w-3 h-3 ${track.locked ? 'text-sf-dark-600' : 'text-sf-dark-500'}`} />
                </div>
                <div
                  className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 ${getTrackColor(track)} ${
                    activeTrackId === track.id ? 'ring-2 ring-red-500 ring-offset-1 ring-offset-sf-dark-800' : ''
                  }`}
                >
                  {getTrackIcon(track)}
                </div>
                {renamingTrackId === track.id ? (
                  <div className="flex-1 flex items-center gap-1">
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleFinishRename()
                        if (e.key === 'Escape') handleCancelRename()
                      }}
                      autoFocus
                      className="w-full bg-sf-dark-700 text-[11px] text-sf-text-primary px-1 py-0.5 rounded border border-sf-accent outline-none"
                    />
                    <button onClick={(e) => { e.stopPropagation(); handleFinishRename() }} className="p-0.5 hover:bg-sf-dark-600 rounded">
                      <Check className="w-3 h-3 text-green-400" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); handleCancelRename() }} className="p-0.5 hover:bg-sf-dark-600 rounded">
                      <X className="w-3 h-3 text-sf-text-muted" />
                    </button>
                  </div>
                ) : (
                  <div
                    className="flex-1 min-w-0 flex items-center gap-2 cursor-pointer"
                    onDoubleClick={(e) => { e.stopPropagation(); handleStartRename(track) }}
                    title="Double-click to rename"
                  >
                    <span className="text-[11px] text-sf-text-primary truncate leading-tight hover:text-sf-accent">
                      {track.name}
                    </span>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {isStereo && (
                        <Link
                          className="w-2.5 h-2.5 text-sf-text-muted/60 flex-shrink-0"
                          title="Stereo pair"
                        />
                      )}
                      <div className={isStereo ? 'flex flex-col gap-1 items-start' : 'flex items-center'}>
                        {channelLabels.map((label) => (
                          <span
                            key={label}
                            className="px-1 py-0.5 rounded border border-sf-dark-500 bg-sf-dark-700/70 text-[9px] text-sf-text-muted leading-none"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              
              <div className="flex items-center gap-0.5">
                {/* Rename button */}
                <button 
                  onClick={(e) => { e.stopPropagation(); handleStartRename(track) }}
                  className="p-0.5 hover:bg-sf-dark-600 rounded opacity-0 group-hover/track:opacity-100 transition-opacity"
                  title="Rename track"
                >
                  <Pencil className="w-3 h-3 text-sf-text-muted" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); toggleTrackMute(track.id) }}
                  className="p-0.5 hover:bg-sf-dark-600 rounded"
                >
                  {track.muted ? (
                    <VolumeX className="w-3 h-3 text-sf-error" />
                  ) : (
                    <Volume2 className="w-3 h-3 text-sf-text-muted" />
                  )}
                </button>
                {/* Solo — same track.solo state the Mixer's S button toggles,
                    so soloing the dialog track for captions never requires
                    leaving the editor. */}
                {track.type === 'audio' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleTrackSolo(track.id) }}
                    className={`min-w-[18px] h-[18px] flex items-center justify-center rounded text-[10px] font-bold transition-colors ${
                      track.solo
                        ? 'bg-yellow-500/80 text-black'
                        : 'bg-sf-dark-600 text-sf-text-muted hover:bg-sf-dark-500 hover:text-sf-text-secondary'
                    }`}
                    title={track.solo ? 'Unsolo track' : 'Solo track (only soloed audio tracks play)'}
                  >
                    S
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); toggleTrackLock(track.id) }}
                  className="p-0.5 hover:bg-sf-dark-600 rounded"
                >
                  {track.locked ? (
                    <Lock className="w-3 h-3 text-sf-warning" />
                  ) : (
                    <Unlock className="w-3 h-3 text-sf-text-muted" />
                  )}
                </button>
                {/* Delete track button */}
                {canDeleteTrack(track) && (
                  <button 
                    onClick={(e) => { e.stopPropagation(); handleDeleteTrack(track) }}
                    className="p-0.5 hover:bg-sf-error/30 rounded opacity-0 group-hover/track:opacity-100 transition-opacity"
                    title="Delete track"
                  >
                    <X className="w-3 h-3 text-sf-error" />
                  </button>
                )}
                {/* Primary track (Flame style) — click to set as active for X cut */}
                <button
                  onClick={(e) => { e.stopPropagation(); setActiveTrack(track.id) }}
                  className={`min-w-[18px] h-[18px] flex items-center justify-center rounded text-[10px] font-bold transition-colors ${
                    activeTrackId === track.id
                      ? 'bg-red-500 text-white'
                      : 'bg-sf-dark-600 text-sf-text-muted hover:bg-sf-dark-500 hover:text-sf-text-secondary'
                  }`}
                  title={activeTrackId === track.id ? 'Primary track (X cuts here)' : 'Set as primary track'}
                >
                  P
                </button>
              </div>
              </div>
              {/* Drag bottom edge to resize track vertically */}
              <div
                className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize z-30 group/track-resize"
                onMouseDown={(e) => handleTrackResizeStart(e, track)}
                title="Drag to resize track height"
              >
                <div className="absolute left-7 right-2 top-1/2 -translate-y-1/2 h-px bg-white/0 group-hover/track-resize:bg-white/35 transition-colors" />
              </div>
            </div>
          )})}
          </div>
        </div>

        {/* Track Content Area */}
        <div 
          ref={timelineRef}
          data-testid="timeline-viewport"
          data-play-around-blocked={Boolean(trimState || rippleTrimState || rollEditState || slipState || slideState
            || clipDragState || fadeDragState || transitionDragState || isScrubbing || isPanning)}
          data-selection-view={selectionViewRef.current ? 'focused' : 'normal'}
          data-compound-timeline-focus
          tabIndex={-1}
          className={`flex-1 min-h-0 overflow-x-auto overflow-y-hidden relative bg-sf-dark-900 flex flex-col ${
            isPanning ? 'cursor-grabbing select-none' : 
            isSpaceHeld ? 'cursor-grab' : 
            isScrubbing ? 'cursor-ew-resize select-none' : ''
          }`}
          onMouseDown={handleTimelineMouseDown}
        >
          {/* Inner container that stretches to fill available space */}
          <div className="min-w-full flex flex-col flex-1 min-h-0" style={{ width: `max(100%, ${duration * pixelsPerSecond}px)` }}>
            {/* Time Ruler - professional timecode style */}
            <div
              className="h-5 flex-shrink-0 bg-gradient-to-b from-sf-dark-800 to-sf-dark-900 border-b border-sf-dark-700 relative select-none"
              onMouseDown={handleTimelineRulerMouseDown}
              data-testid="timeline-scrub-ruler"
              onDoubleClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                const time = getTimeFromMouseEvent(e)
                addMarker(time)
                setPlayheadPosition(time, { snap: true })
              }}
              title="Double-click to add marker"
            >
              <RulerTickMarks
                major={rulerTicks.major}
                minor={rulerTicks.minor}
                pixelsPerSecond={pixelsPerSecond}
                timecodeFps={timecodeFps}
              />

              {/* FPS indicator on far right */}
              <div className="absolute top-0.5 right-1 text-[8px] text-sf-text-muted/80 font-mono pointer-events-none">
                {Math.round(timecodeFps)} fps
              </div>
            </div>

          {/* Scrollable tracks container */}
          <div 
            ref={trackContentRef}
            data-testid="timeline-track-content"
            className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden hide-scrollbar"
            style={{ scrollbarWidth: 'none' }}
            onScroll={(e) => {
              // Sync scroll with track headers
              if (trackHeadersRef.current) {
                trackHeadersRef.current.scrollTop = e.target.scrollTop
              }
            }}
          >
          {autoCreateVideoTrackIndicatorVisible && (
            <div
              className="border-b border-dashed border-sf-accent/70 bg-gradient-to-b from-sf-accent/10 to-sf-accent/5 relative pointer-events-none"
              style={{ minHeight: autoCreateVideoTrackIndicatorHeight, height: autoCreateVideoTrackIndicatorHeight }}
            >
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-3">
                <div className="h-0 border-t border-dashed border-sf-accent/60 relative">
                  <div className="absolute left-3 -top-4 px-2 py-1 rounded-md bg-sf-dark-900/95 border border-sf-accent/40 text-[10px] text-sf-accent font-medium shadow-lg">
                    Release to add new video track
                  </div>
                </div>
              </div>
            </div>
          )}
          {/* Video Tracks Content */}
          {videoTracks.map((track) => {
            const trackClips = clips.filter(c => c.trackId === track.id)
            const contentHeight = getTrackHeight(track)
            
            return (
              <div 
                key={track.id}
                data-track-lane="true"
                className={`border-b border-sf-dark-700 relative ${
                  !track.visible ? 'opacity-40' : ''
                } ${track.locked ? 'pointer-events-none opacity-50 bg-sf-dark-800' : ''} ${
                  dropTarget === track.id ? 'bg-sf-accent/10' : track.locked ? '' : 'bg-sf-dark-900'
                }`}
                style={{ minHeight: contentHeight, height: contentHeight }}
                onMouseDownCapture={(e) => handleCutMouseDownCapture(e, track.id)}
                onContextMenuCapture={(e) => handleCutContextMenuCapture(e, track.id)}
                onMouseDown={(e) => handleTrackLaneMouseDown(e, track)}
                onContextMenu={(e) => handleTrackLaneContextMenu(e, track)}
                onDragOverCapture={(e) => handleTransitionDragOverCapture(e, track.id)}
                onDropCapture={(e) => handleTransitionDropCapture(e, track.id)}
                onDragOver={(e) => handleDragOver(e, track.id)}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget)) setTransitionDropTarget(null)
                  handleDragLeave(e)
                }}
                onDrop={(e) => handleDrop(e, track.id)}
              >
                {selectedGap?.trackId === track.id && selectedGap.endTime > selectedGap.startTime && (
                  <div
                    className="absolute top-1 bottom-1 rounded-sm border border-dashed border-sf-accent/80 bg-sf-accent/12 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] pointer-events-none"
                    style={{
                      left: `${selectedGap.startTime * pixelsPerSecond}px`,
                      width: `${Math.max(2, (selectedGap.endTime - selectedGap.startTime) * pixelsPerSecond)}px`,
                    }}
                  >
                    <div className="absolute inset-x-1 top-1 flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.18em] text-sf-accent/90">
                      <span>Gap</span>
                      <span className="font-mono normal-case tracking-normal">
                        {Math.max(0, selectedGap.endTime - selectedGap.startTime).toFixed(2)}s
                      </span>
                    </div>
                  </div>
                )}
                {trackClips.map((clip) => {
                  const clipWidth = clip.duration * pixelsPerSecond
                  const renderedClipWidth = Math.max(1, clipWidth)
                  const interactiveClipWidth = Math.max(MIN_INTERACTIVE_CLIP_WIDTH_PX, renderedClipWidth)
                  const interactiveClipOffset = Math.max(0, (interactiveClipWidth - renderedClipWidth) / 2)
                  // Calculate how many thumbnail frames to show (roughly one per 60px)
                  const thumbCount = Math.max(1, Math.min(MAX_TIMELINE_VIDEO_THUMBNAILS, Math.ceil(renderedClipWidth / TIMELINE_VIDEO_THUMB_WIDTH_PX)))
                  const isTextClip = clip.type === 'text'
                  const isAdjustmentClip = clip.type === 'adjustment'
                  const clipEnabled = isClipEnabled(clip)
                  const shouldRenderClipThumbnails = showTimelineClipThumbnails !== false
                  const clipMediaUrl = shouldRenderClipThumbnails && (clip.type === 'image' || clip.type === 'video')
                    ? getClipUrl(clip)
                    : null
                  const clipLabelColor = getClipLabelColorValue(clip)
                  
                  return (
                  <div
                    key={clip.id}
                    data-clip="true"
                    data-clip-id={clip.id}
                    data-slide-edit-target={isSlideToolActive && !track.locked ? clip.id : undefined}
                    onMouseDown={(e) => handleClipDragStart(e, clip)}
                    onClick={(e) => handleClipClick(e, clip)}
                    onDoubleClick={isTextClip
                      ? (e) => handleTextClipDoubleClick(e, clip)
                      : (e) => handleClipDoubleClick(e, clip)}
                    onContextMenu={(e) => handleClipContextMenu(e, clip)}
                    onDragOver={(e) => {
                      if (clip.type === 'compound') return
                      if (parseEffectDrop(e)) {
                        e.preventDefault()
                        e.stopPropagation()
                        e.dataTransfer.dropEffect = 'copy'
                      }
                    }}
                    onDrop={(e) => {
                      const payload = parseEffectDrop(e)
                      if (!payload) return
                      e.preventDefault()
                      e.stopPropagation()
                      if (clip.type === 'compound') return
                      const def = getEffectTypeDefinition(payload.effectType)
                      if (!def) return
                      const preset = payload.presetId
                        ? def.presets?.find((p) => p.id === payload.presetId)
                        : null
                      const settings = preset
                        ? { ...def.defaults, ...preset.settings }
                        : { ...def.defaults }
                      addEffect(clip.id, { type: payload.effectType, settings })
                    }}
                    className={`absolute top-0.5 bottom-0.5 rounded-sm group ${
                      isRazorToolActive
                        ? 'cursor-crosshair'
                        : isSlipToolActive || isSlideToolActive
                          ? 'cursor-ew-resize'
                          : isTrimToolActive
                            ? 'cursor-default'
                            : 'cursor-grab'
                    } ${
                      slipState?.clipId === clip.id || slideState?.clipId === clip.id || clipDragState?.movingClipIds?.includes(clip.id) ? 'z-30' : ''
                    }`}
                    style={{ 
                      left: `${(clip.startTime * pixelsPerSecond) - interactiveClipOffset}px`, 
                      width: `${interactiveClipWidth}px`,
                    }}
                  >
                    {rippleHandlesEnabled && renderRippleTrimHandles(clip, track)}
                    {isSlipToolActive && track.locked && renderLockedSlipTarget(clip)}
                    {isSlideToolActive && track.locked && renderLockedSlideTarget(clip)}
                    <div
                      className={`absolute top-0 bottom-0 rounded-sm overflow-hidden ${
                        selectedClipIds.includes(clip.id) ? 'ring-2 ring-white ring-offset-1 ring-offset-sf-dark-900' : ''
                      } ${trimState?.targetClipIds?.includes(clip.id) || rippleTrimState?.targetClipIds?.includes(clip.id) ? 'ring-2 ring-sf-accent' : ''} ${
                        slipState?.clipId === clip.id || slideState?.clipId === clip.id ? 'ring-2 ring-yellow-400 cursor-ew-resize z-30' : ''
                      } ${
                        clipDragState?.movingClipIds?.includes(clip.id)
                          ? (clipDragState?.isDuplicating
                            ? 'ring-2 ring-emerald-400 cursor-copy z-30'
                            : 'ring-2 ring-sf-accent cursor-grabbing z-30') : ''
                      } ${
                        clipEnabled ? '' : 'opacity-60 saturate-0'
                      }`}
                      style={{
                        left: `${interactiveClipOffset}px`,
                        width: `${renderedClipWidth}px`,
                      }}
                    >
                    {/* Render-cache status strip (Resolve-style): purple grows
                        with render progress, green = cached and fresh,
                        amber = content edited since the bake (outdated).
                        Bottom edge — the TOP 3px slot belongs to the clip
                        label-color strip (z-20, later in DOM), which would
                        paint over anything we put there. */}
                    {clip.cacheStatus === 'rendering' && (
                      <div
                        className="absolute bottom-0 left-0 h-[3px] bg-purple-400 z-20 pointer-events-none"
                        style={{ width: `${Math.max(4, Math.min(100, Number(clip.cacheProgress) || 0))}%` }}
                      />
                    )}
                    {clip.cacheStatus === 'cached' && (
                      <div
                        className={`absolute bottom-0 left-0 right-0 h-[3px] z-20 pointer-events-none ${
                          clip.cacheKind !== 'full' || isFullBakeFresh(clip) ? 'bg-emerald-400/90' : 'bg-amber-400/90'
                        }`}
                      />
                    )}
                    {clip.cacheStatus === 'invalid' && (
                      <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-amber-400/90 z-20 pointer-events-none" />
                    )}
                    {(() => {
                      const edgeTransitions = edgeTransitionsByClipId.get(clip.id) || []
                      const hasIn = edgeTransitions.some(t => t.edge === 'in')
                      const hasOut = edgeTransitions.some(t => t.edge === 'out')
                      return (
                        <>
                          {hasIn && (
                            <div className="absolute left-0 top-0 bottom-0 w-2 bg-gradient-to-r from-purple-500/50 to-transparent pointer-events-none" />
                          )}
                          {hasOut && (
                            <div className="absolute right-0 top-0 bottom-0 w-2 bg-gradient-to-l from-purple-500/50 to-transparent pointer-events-none" />
                          )}
                        </>
                      )
                    })()}
                    {/* Text Clip Rendering */}
                    {clip.type === 'compound' ? (
                      <div data-testid="compound-tile" data-compound-clip-id={clip.id} className="absolute inset-0 overflow-hidden border-t-[3px] border-violet-400/60 bg-violet-950/60 text-violet-100">
                        <div className="absolute inset-x-1.5 top-1 flex min-w-0 items-center gap-1.5"><Layers className="h-3 w-3 flex-shrink-0" /><span className="truncate text-[10px] font-medium">{clip.name || 'Compound Clip'}</span></div>
                        <div className="absolute inset-x-1.5 bottom-1 flex items-center justify-between gap-1 text-[8px] text-violet-200/80"><span className="truncate">{clip.compound?.document?.clips?.length || 0} clips · Compound</span><span className="flex-shrink-0">{Number(clip.duration).toFixed(1)}s</span></div>
                      </div>
                    ) : isTextClip ? (
                      <>
                        {/* Text clip background with accent color bar */}
                        <div 
                          className="absolute inset-0 bg-gradient-to-b from-sf-accent/30 to-sf-accent-muted/40"
                          style={{ borderTop: `3px solid ${clip.color}` }}
                        />
                        
                        {/* Text pattern background */}
                        <div className="absolute inset-0 top-[3px] flex items-center justify-center overflow-hidden">
                          <div className="absolute inset-0 opacity-20">
                            {/* Repeating "T" pattern to indicate text */}
                            <div className="flex flex-wrap gap-2 p-1">
                              {Array.from({ length: Math.ceil(clipWidth / 20) }).map((_, i) => (
                                <Type key={i} className="w-4 h-4 text-sf-accent" />
                              ))}
                            </div>
                          </div>
                        </div>
                        
                        {/* Text preview */}
                        <div className="absolute inset-0 top-[3px] flex items-center justify-center px-2 overflow-hidden">
                          <span 
                            className="text-[11px] text-sf-text-primary font-medium truncate"
                            style={{
                              textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                              fontFamily: quoteCssFontFamily(clip.textProperties?.fontFamily)
                            }}
                          >
                            {clip.textProperties?.text || 'Text'}
                          </span>
                        </div>
                        
                        {/* Text icon badge - top left */}
                        <div className="absolute top-1 left-1 z-10 flex items-center gap-1">
                          <div className="bg-sf-accent/80 rounded px-1 py-0.5 flex items-center gap-0.5">
                            <Type className="w-2.5 h-2.5 text-white" />
                            <span className="text-[8px] text-white font-medium">TEXT</span>
                          </div>
                        </div>
                        
                        {/* Duration badge - bottom right */}
                        <div className="absolute bottom-1 right-1 px-1 py-0.5 bg-black/60 rounded text-[8px] text-white/90 font-mono">
                          {clip.duration.toFixed(1)}s
                        </div>
                        
                        {/* Keyframe markers */}
                        {clip.keyframes && Object.keys(clip.keyframes).length > 0 && (
                          <div className="absolute bottom-[3px] left-0 right-0 h-2 pointer-events-none">
                            {getAllKeyframeTimes(clip.keyframes).map((kf, i) => (
                              <div
                                key={`kf-${i}-${kf.time}`}
                                className="absolute w-2 h-2 -translate-x-1/2"
                                style={{ left: `${(kf.time / clip.duration) * 100}%` }}
                                title={`Keyframe at ${kf.time.toFixed(2)}s: ${kf.properties.join(', ')}`}
                              >
                                <Diamond className="w-2 h-2 text-yellow-400 fill-yellow-400" />
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    ) : isAdjustmentClip ? (
                      <>
                        {/* Adjustment Layer Clip Rendering */}
                        <div
                          className="absolute inset-0 bg-[#2a1f3a]"
                          style={{
                            borderTop: '3px solid #a855f7',
                            backgroundImage: 'repeating-linear-gradient(135deg, rgba(168,85,247,0.28) 0px, rgba(168,85,247,0.28) 8px, rgba(30,20,45,0.65) 8px, rgba(30,20,45,0.65) 16px)',
                          }}
                        />

                        <div className="absolute inset-x-0 top-[3px] h-6 bg-gradient-to-b from-black/55 to-transparent pointer-events-none" />

                        <div className="absolute top-1 left-1 z-10 flex items-center gap-1">
                          <div className="bg-purple-600/85 rounded px-1 py-0.5 flex items-center gap-0.5">
                            <Square className="w-2.5 h-2.5 text-white" />
                            <span className="text-[8px] text-white font-medium">ADJ</span>
                          </div>
                        </div>

                        <div className="absolute inset-x-0 bottom-0 h-[14px] bg-[#4d2f69]/95 border-t border-black/45 pointer-events-none" />
                        <div className="absolute bottom-[1px] left-1.5 right-12 z-10">
                          <span className="text-[10px] text-white/95 font-medium truncate block leading-none drop-shadow-sm">
                            {clip.name || 'Adjustment Layer'}
                          </span>
                        </div>

                        <div className="absolute bottom-[1px] right-1 px-1 py-0 rounded bg-black/55 text-[8px] text-white/90 font-mono leading-none">
                          {clip.duration.toFixed(1)}s
                        </div>

                        {clip.keyframes && Object.keys(clip.keyframes).length > 0 && (
                          <div className="absolute bottom-[15px] left-0 right-0 h-2 pointer-events-none">
                            {getAllKeyframeTimes(clip.keyframes).map((kf, i) => (
                              <div
                                key={`kf-${i}-${kf.time}`}
                                className="absolute w-2 h-2 -translate-x-1/2"
                                style={{ left: `${(kf.time / clip.duration) * 100}%` }}
                                title={`Keyframe at ${kf.time.toFixed(2)}s: ${kf.properties.join(', ')}`}
                              >
                                <Diamond className="w-2 h-2 text-yellow-400 fill-yellow-400" />
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    ) : clip.type === 'image' ? (
                      <>
                        {/* Image Clip Rendering */}
                        {/* Clip background with color bar at top - purple tint for images */}
                        <div 
                          className="absolute inset-0 bg-[#1e1a28]"
                          style={{ 
                            borderTop: `3px solid #6b5080`,
                          }}
                        />
                        
                        {/* Single image thumbnail repeated */}
                        {clipMediaUrl && (
                          <div className="absolute inset-0 top-[3px] flex overflow-hidden">
                            <img
                              src={clipMediaUrl}
                              alt={clip.name}
                              className="h-full object-cover opacity-80 pointer-events-none"
                              style={{ 
                                width: '100%',
                                objectFit: 'cover',
                              }}
                              draggable={false}
                              onContextMenu={(e) => e.preventDefault()}
                            />
                          </div>
                        )}
                        
                        {/* Gradient overlay for top badges readability */}
                        <div className="absolute inset-x-0 top-[3px] h-6 bg-gradient-to-b from-black/60 to-transparent pointer-events-none" />
                        
                        {/* Image badge + AI/IMP tag - top left */}
                        <div className="absolute top-1 left-1 z-10 flex items-center gap-1">
                          <div className="bg-purple-500/80 rounded px-1 py-0.5 flex items-center gap-0.5">
                            <ImageIcon className="w-2.5 h-2.5 text-white" />
                            <span className="text-[8px] text-white font-medium">IMG</span>
                          </div>
                          {clip.assetId && (() => {
                            const asset = getAssetById(clip.assetId)
                            if (!asset) return null
                            return (
                              <div className={`rounded px-1 py-0.5 text-[8px] text-white font-medium ${asset.isImported ? 'bg-sf-dark-700/90' : 'bg-sf-accent/90'}`} title={asset.isImported ? 'Imported' : 'AI Generated'}>
                                {asset.isImported ? 'IMP' : 'AI'}
                              </div>
                            )
                          })()}
                        </div>
                        
                        {/* Bottom name strip (Resolve-style) */}
                        <div className="absolute inset-x-0 bottom-0 h-[14px] bg-[#3a6584]/95 border-t border-black/45 pointer-events-none" />
                        <div className="absolute bottom-[1px] left-1.5 right-12 z-10">
                          <span className="text-[10px] text-white/95 font-medium truncate block leading-none drop-shadow-sm">
                            {clip.name}
                          </span>
                        </div>

                        {/* Duration badge - bottom right */}
                        <div className="absolute bottom-[1px] right-1 px-1 py-0 rounded bg-black/55 text-[8px] text-white/90 font-mono leading-none">
                          {clip.duration.toFixed(1)}s
                        </div>
                        
                        {/* Keyframe markers */}
                        {clip.keyframes && Object.keys(clip.keyframes).length > 0 && (
                          <div className="absolute bottom-[15px] left-0 right-0 h-2 pointer-events-none">
                            {getAllKeyframeTimes(clip.keyframes).map((kf, i) => (
                              <div
                                key={`kf-${i}-${kf.time}`}
                                className="absolute w-2 h-2 -translate-x-1/2"
                                style={{ left: `${(kf.time / clip.duration) * 100}%` }}
                                title={`Keyframe at ${kf.time.toFixed(2)}s: ${kf.properties.join(', ')}`}
                              >
                                <Diamond className="w-2 h-2 text-yellow-400 fill-yellow-400" />
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        {/* Video Clip Rendering */}
                        {/* Clip background with color bar at top - Resolve-style desaturated teal */}
                        <div 
                          className="absolute inset-0 bg-[#1a2528]"
                          style={{ 
                            borderTop: `3px solid #3d7080`,
                          }}
                        />
                        
                        {/* Filmstrip thumbnails: render cached sprite frames, never live video elements. */}
                        {shouldRenderClipThumbnails && (
                          <div className="absolute inset-0 top-[3px] flex overflow-hidden">
                            {renderTimelineVideoFilmstrip(clip, renderedClipWidth, thumbCount, contentHeight)}
                          </div>
                        )}
                        
                        {/* Gradient overlay for top badges readability */}
                        <div className="absolute inset-x-0 top-[3px] h-6 bg-gradient-to-b from-black/60 to-transparent pointer-events-none" />
                        
                        {/* AI/IMP tag - top left */}
                        <div className="absolute top-1 left-1.5 right-6 z-10 flex items-center gap-1.5 flex-wrap">
                          {clip.assetId && (() => {
                            const asset = getAssetById(clip.assetId)
                            if (!asset) return null
                            return (
                              <div className={`rounded px-1 py-0.5 text-[8px] text-white font-medium flex-shrink-0 ${asset.isImported ? 'bg-sf-dark-700/90' : 'bg-sf-accent/90'}`} title={asset.isImported ? 'Imported' : 'AI Generated'}>
                                {asset.isImported ? 'IMP' : 'AI'}
                              </div>
                            )
                          })()}
                          {isSyncLockedClip(clip) && (
                            <div className="rounded bg-emerald-500/85 px-1 py-0.5 text-[8px] text-white font-medium flex items-center gap-0.5 flex-shrink-0" title="Locked to song timing">
                              <Lock className="w-2.5 h-2.5" />
                              <span>SYNC</span>
                            </div>
                          )}
                        </div>
                        
                        {/* Effects/Cache indicator - top right area */}
                        {(clip.effects?.length > 0) && (
                          <div className="absolute top-1 right-8 z-10 flex items-center gap-1">
                            {/* Effect badge */}
                            <div className="bg-purple-500/80 rounded px-1 py-0.5 flex items-center gap-0.5" title="Has effects">
                              <Zap className="w-2.5 h-2.5 text-white" />
                            </div>
                            {/* Cache status indicator */}
                            {clip.cacheStatus === 'cached' && (
                              <div className="bg-green-500/80 rounded px-1 py-0.5" title="Cached">
                                <Check className="w-2.5 h-2.5 text-white" />
                              </div>
                            )}
                            {clip.cacheStatus === 'invalid' && (
                              <div className="bg-yellow-500/80 rounded px-1 py-0.5" title="Cache outdated">
                                <AlertTriangle className="w-2.5 h-2.5 text-white" />
                              </div>
                            )}
                            {clip.cacheStatus === 'rendering' && (
                              <div className="bg-blue-500/80 rounded px-1 py-0.5 animate-pulse" title={`Rendering ${clip.cacheProgress || 0}%`}>
                                <Loader2 className="w-2.5 h-2.5 text-white animate-spin" />
                              </div>
                            )}
                          </div>
                        )}
                        
                        {/* Bottom name strip (Resolve-style) */}
                        <div className="absolute inset-x-0 bottom-0 h-[14px] bg-[#3a6584]/95 border-t border-black/45 pointer-events-none" />
                        <div className="absolute bottom-[1px] left-1.5 right-12 z-10">
                          <span className="text-[10px] text-white/95 font-medium truncate block leading-none drop-shadow-sm">
                            {clip.name}
                          </span>
                        </div>

                        {/* Duration badge - bottom right */}
                        <div className="absolute bottom-[1px] right-1 px-1 py-0 rounded bg-black/55 text-[8px] text-white/90 font-mono leading-none">
                          {clip.duration.toFixed(1)}s
                        </div>
                        
                        {/* Keyframe markers */}
                        {clip.keyframes && Object.keys(clip.keyframes).length > 0 && (
                          <div className="absolute bottom-[15px] left-0 right-0 h-2 pointer-events-none">
                            {getAllKeyframeTimes(clip.keyframes).map((kf, i) => (
                              <div
                                key={`kf-${i}-${kf.time}`}
                                className="absolute w-2 h-2 -translate-x-1/2"
                                style={{ left: `${(kf.time / clip.duration) * 100}%` }}
                                title={`Keyframe at ${kf.time.toFixed(2)}s: ${kf.properties.join(', ')}`}
                              >
                                <Diamond className="w-2 h-2 text-yellow-400 fill-yellow-400" />
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    
                    {!clipEnabled && (
                      <>
                        <div className="absolute inset-0 bg-slate-950/35 pointer-events-none z-10" />
                        <div className="absolute top-1 right-1 z-20 flex items-center gap-1 rounded bg-slate-950/85 border border-white/10 px-1 py-0.5 text-[8px] text-slate-100 uppercase tracking-[0.14em] pointer-events-none">
                          <EyeOff className="w-2.5 h-2.5" />
                          <span>Off</span>
                        </div>
                      </>
                    )}

                    {clipLabelColor && (
                      <>
                        <div
                          className="absolute inset-0 z-[6] pointer-events-none"
                          style={{
                            backgroundColor: clipLabelColor,
                            opacity: getClipLabelTintOpacity(clip),
                          }}
                        />
                        <div
                          className="absolute inset-x-0 bottom-0 z-[7] h-[14px] pointer-events-none"
                          style={{
                            backgroundColor: clipLabelColor,
                            opacity: getClipLabelFooterOpacity(clip),
                          }}
                        />
                        <div
                          className="absolute inset-x-0 top-0 z-20 h-[3px] pointer-events-none"
                          style={{ backgroundColor: clipLabelColor }}
                        />
                      </>
                    )}

                    {/* Hover overlay */}
                    <div className="absolute inset-0 bg-white/0 group-hover:bg-white/5 transition-colors pointer-events-none" />
                    
                    {trimHandlesEnabled && !rippleEditMode && !isSyncLockedClip(clip) && (
                      <>
                        {/* Left trim handle - wider hit area for easier grabbing */}
                        <div
                          data-trim-handle="true"
                          onMouseDown={(e) => handleTrimStart(e, clip.id, 'left')}
                          className="absolute left-0 top-0 bottom-0 w-4 bg-white/0 group-hover:bg-white/20 cursor-ew-resize transition-colors flex items-center justify-start z-20"
                        >
                          <div className="w-1 h-8 bg-white/0 group-hover:bg-white/90 rounded-r transition-colors ml-0" />
                        </div>

                        {/* Right trim handle - wider hit area for easier grabbing */}
                        <div
                          data-trim-handle="true"
                          onMouseDown={(e) => handleTrimStart(e, clip.id, 'right')}
                          className="absolute right-0 top-0 bottom-0 w-4 bg-white/0 group-hover:bg-white/20 cursor-ew-resize transition-colors flex items-center justify-end z-20"
                        >
                          <div className="w-1 h-8 bg-white/0 group-hover:bg-white/90 rounded-l transition-colors mr-0" />
                        </div>
                      </>
                    )}
                    
                    {/* Left/Right edge borders */}
                    <div className="absolute left-0 top-0 bottom-0 w-px bg-black/40 pointer-events-none" />
                    <div className="absolute right-0 top-0 bottom-0 w-px bg-black/40 pointer-events-none" />
                    </div>
                  </div>
                  )
                })}
                {renderAssetDropPreviewClip(track)}
                
                {/* Applied transitions and Trim-tool roll handles. Idle cuts have no overlay. */}
                {getAdjacentClips(track.id).map(({ clipA, clipB, transition, isOverlapping, gap, isTrueEditPoint }) => {
                  const clipAEnd = clipA.startTime + clipA.duration
                  const canRollEdit = !rippleHandlesEnabled && isTrimToolActive && isTrueEditPoint
                  const isDropTarget = transitionDropTarget === `${clipA.id}-${clipB.id}`
                  const transitionSplit = transition?.settings?.split || null
                  const transitionAlignment = transition?.settings?.alignment || 'center'
                  const normalizedSplit = (() => {
                    if (transitionSplit && Number.isFinite(Number(transitionSplit.clipA)) && Number.isFinite(Number(transitionSplit.clipB))) {
                      const clipAValue = Math.max(0, Number(transitionSplit.clipA))
                      const clipBValue = Math.max(0, Number(transitionSplit.clipB))
                      const total = clipAValue + clipBValue
                      if (total > 0) return { clipA: clipAValue / total, clipB: clipBValue / total }
                    }
                    if (transitionAlignment === 'start') return { clipA: 1, clipB: 0 }
                    if (transitionAlignment === 'end') return { clipA: 0, clipB: 1 }
                    return { clipA: 0.5, clipB: 0.5 }
                  })()
                  
                  if (transition) {
                    const editPoint = Number.isFinite(Number(transition.editPoint))
                      ? Number(transition.editPoint)
                      : clipAEnd
                    const clipAContribution = (Number(transition.duration) || 0) * normalizedSplit.clipA
                    const clipBContribution = (Number(transition.duration) || 0) * normalizedSplit.clipB
                    const transitionStart = editPoint - clipAContribution
                    const transitionEnd = editPoint + clipBContribution
                    const transitionWidth = Math.max(0, transitionEnd - transitionStart) * pixelsPerSecond
                    const transitionX = transitionStart * pixelsPerSecond
                    const transitionHitWidth = Math.max(32, transitionWidth)
                    const transitionHitInset = (transitionHitWidth - transitionWidth) / 2
                    const transitionHitX = transitionX - transitionHitInset
                    const isSelected = selectedTransitionId === transition.id
                    const transitionMeta = TRANSITION_TYPES.find(t => t.id === transition.type)
                    const transitionName = transitionMeta?.name || transition.type
                    const transitionFrames = Math.round(transition.duration * FRAME_RATE)

                    return (
                      <div
                        key={`transition-${clipA.id}-${clipB.id}`}
                        data-gap-ignore="true"
                        className="absolute top-0 bottom-[14px] z-[35] pointer-events-auto cursor-pointer group/trans"
                        style={{ left: `${transitionHitX}px`, width: `${transitionHitWidth}px` }}
                        onClick={(e) => {
                          e.stopPropagation()
                          selectTransition(transition.id)
                        }}
                        title={`${transitionName} (${transitionFrames}f)`}
                      >
                        {isDropTarget && (
                          <div data-testid="transition-drop-highlight" className="absolute inset-0 border-2 border-purple-400 bg-purple-500/20 pointer-events-none z-10" />
                        )}
                        {/* Resolve-style: dark grey-black overlay container with visible border */}
                        <div
                          className={`absolute top-0 bottom-0 overflow-hidden border border-[#4a4a4a]/90 bg-[#1a1a1a]/85 rounded-[2px] ${
                            isSelected ? 'ring-2 ring-white/80 ring-inset shadow-[0_0_0_1px_rgba(255,255,255,0.4)]' : ''
                          }`}
                          style={{ left: `${transitionHitInset}px`, width: `${transitionWidth}px` }}
                        >
                          {/* Left/Right preview panes (clip A + clip B) - visible through overlay */}
                          <div className="absolute inset-0 flex">
                            <div className="relative h-full w-1/2 overflow-hidden">
                              {renderTransitionPreviewPane(clipA, 'left')}
                              <div className="absolute inset-0 bg-gradient-to-r from-black/30 to-transparent pointer-events-none" />
                            </div>
                            <div className="relative h-full w-1/2 overflow-hidden">
                              {renderTransitionPreviewPane(clipB, 'right')}
                              <div className="absolute inset-0 bg-gradient-to-l from-black/30 to-transparent pointer-events-none" />
                            </div>
                          </div>

                          {/* Center dissolve gradient + center edit line */}
                          <div
                            className="absolute inset-0 pointer-events-none"
                            style={{
                              background: 'linear-gradient(90deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.2) 50%, rgba(255,255,255,0.06) 100%)'
                            }}
                          />
                          <div
                            className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-[1px] bg-white/80 pointer-events-none"
                            style={{ boxShadow: '0 0 0 1px rgba(0,0,0,0.3)' }}
                          />

                          {/* Diagonal line: bottom-left to top-right (dissolve icon) - SVG so it's never clipped */}
                          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                            <line x1="0" y1="100" x2="100" y2="0" stroke="rgba(255,255,255,0.5)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
                          </svg>

                          {/* Resolve-style top bar + vertical handle */}
                          <div className="absolute top-0 left-0 right-0 h-1.5 bg-white/95 rounded-t-[2px] pointer-events-none flex justify-center">
                            <div className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-1 h-2 bg-white rounded-sm shadow-sm" />
                          </div>

                          {/* Transition name - white text, prominent like Resolve */}
                          <div className="absolute top-2 left-1/2 -translate-x-1/2 max-w-[90%] px-2 py-0.5 text-[10px] font-medium text-white leading-none truncate drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]">
                            {transitionName}
                          </div>

                          {/* Duration in grey oval/pill like Resolve */}
                          <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 text-[9px] text-[#b0b0b0] whitespace-nowrap bg-[#2d2d2d]/95 px-2 py-0.5 rounded-full border border-[#404040]/80 leading-none">
                            {transitionFrames}f
                          </div>
                        </div>

                        {/* Resize handles (left/right) */}
                        <div
                          className={`absolute top-0 bottom-0 w-3 flex items-center justify-start z-40 cursor-ew-resize ${
                            isSelected ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none group-hover/trans:opacity-100 group-hover/trans:pointer-events-auto'
                          }`}
                          style={{ left: `${transitionHitInset}px` }}
                          onMouseDown={(e) => {
                            e.stopPropagation()
                            e.preventDefault()
                            setTransitionDragState({
                              transitionId: transition.id,
                              startX: e.clientX,
                              startDuration: transition.duration,
                              edge: 'left',
                            })
                          }}
                          title="Drag to adjust transition duration"
                        >
                          <div className="w-1 h-7 bg-white/90 rounded-r shadow-sm" />
                        </div>
                        <div
                          className={`absolute top-0 bottom-0 w-3 flex items-center justify-end z-40 cursor-ew-resize ${
                            isSelected ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none group-hover/trans:opacity-100 group-hover/trans:pointer-events-auto'
                          }`}
                          style={{ right: `${transitionHitInset}px` }}
                          onMouseDown={(e) => {
                            e.stopPropagation()
                            e.preventDefault()
                            setTransitionDragState({
                              transitionId: transition.id,
                              startX: e.clientX,
                              startDuration: transition.duration,
                              edge: 'right',
                            })
                          }}
                          title="Drag to adjust transition duration"
                        >
                          <div className="w-1 h-7 bg-white/90 rounded-l shadow-sm" />
                        </div>

                        {/* Remove transition button (hover/selected). */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            removeTransition(transition.id)
                          }}
                          className={`absolute top-1 right-1 w-5 h-5 rounded bg-sf-dark-800/90 border border-sf-dark-500 text-sf-text-muted hover:text-sf-error hover:border-sf-error transition-colors ${
                            isSelected ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none group-hover/trans:opacity-100 group-hover/trans:pointer-events-auto'
                          }`}
                          style={{ right: `${transitionHitInset + 4}px` }}
                          title="Remove transition"
                        >
                          ×
                        </button>
                      </div>
                    )
                  }
                  
                  // The lane owns native transition DnD. Feedback is pointer-inert
                  // and only mounted while dragging; trim edges stay unobstructed.
                  if (!isTrueEditPoint || (!canRollEdit && !isDropTarget)) return null
                  const editPointX = clipAEnd * pixelsPerSecond
                  
                  return (
                    <div
                      key={`edit-${clipA.id}-${clipB.id}`}
                      data-gap-ignore="true"
                      className="absolute top-0 bottom-0 z-20 group/edit pointer-events-none"
                      style={{ left: `${editPointX - 4}px`, width: '8px' }}
                    >
                      {isDropTarget && (
                        <div data-testid="transition-drop-highlight" className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-6 rounded-sm border-2 border-purple-400 bg-purple-500/25 pointer-events-none" />
                      )}
                      {canRollEdit && (
                        <div
                          data-testid="roll-edit-handle" data-clip-a-id={clipA.id} data-clip-b-id={clipB.id}
                          className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-1.5 flex items-center justify-center pointer-events-auto cursor-ew-resize"
                          onMouseDown={(e) => handleRollEditStart(e, clipA, clipB)}
                          title="Drag to roll edit (extend one clip, shorten the other)"
                        >
                          <div className="w-0.5 h-full transition-colors bg-white/0 group-hover/edit:bg-yellow-400/70" />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
          
          {/* Audio Section Spacer */}
          <div className="h-5 bg-sf-dark-800 border-b border-sf-dark-700 flex items-center">
            <span className="text-[10px] text-sf-text-muted ml-2 uppercase tracking-wider">Audio</span>
          </div>
          
          {/* Audio Tracks Content */}
          {audioTracks.map((track) => {
            const trackClips = clips.filter(c => c.trackId === track.id)
            const isStereoContent = track.channels !== 'mono'
            const contentHeight = getTrackHeight(track)
            
            return (
              <div 
                key={track.id}
                data-track-lane="true"
                className={`border-b border-sf-dark-700 relative flex flex-col ${
                  track.muted ? 'opacity-40' : ''
                } ${track.locked ? 'pointer-events-none opacity-50 bg-sf-dark-800' : ''} ${
                  dropTarget === track.id ? 'bg-sf-accent/10' : track.locked ? '' : 'bg-sf-dark-900'
                }`}
                style={{ height: contentHeight, minHeight: contentHeight }}
                onMouseDown={(e) => handleTrackLaneMouseDown(e, track)}
                onContextMenu={(e) => handleTrackLaneContextMenu(e, track)}
                onDragOver={(e) => handleDragOver(e, track.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, track.id)}
              >
                {selectedGap?.trackId === track.id && selectedGap.endTime > selectedGap.startTime && (
                  <div
                    className="absolute top-1 bottom-1 rounded-sm border border-dashed border-sf-accent/80 bg-sf-accent/12 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] pointer-events-none"
                    style={{
                      left: `${selectedGap.startTime * pixelsPerSecond}px`,
                      width: `${Math.max(2, (selectedGap.endTime - selectedGap.startTime) * pixelsPerSecond)}px`,
                    }}
                  >
                    <div className="absolute inset-x-1 top-1 flex items-center justify-between gap-2 text-[9px] uppercase tracking-[0.18em] text-sf-accent/90">
                      <span>Gap</span>
                      <span className="font-mono normal-case tracking-normal">
                        {Math.max(0, selectedGap.endTime - selectedGap.startTime).toFixed(2)}s
                      </span>
                    </div>
                  </div>
                )}
                {isStereoContent && (
                  <div className="absolute left-0 right-0 top-1/2 h-px bg-sf-dark-600/80 z-10 pointer-events-none" />
                )}
                {trackClips.map((clip) => {
                  const clipWidth = clip.duration * pixelsPerSecond
                  const renderedClipWidth = Math.max(1, clipWidth)
                  const interactiveClipWidth = Math.max(MIN_INTERACTIVE_CLIP_WIDTH_PX, renderedClipWidth)
                  const interactiveClipOffset = Math.max(0, (interactiveClipWidth - renderedClipWidth) / 2)
                  const clipUrl = getClipUrl(clip)
                  const clipEnabled = isClipEnabled(clip)
                  const { fadeIn, fadeOut } = getAudioClipFadeValues(clip)
                  const fadeInWidth = Math.min(renderedClipWidth, fadeIn * pixelsPerSecond)
                  const fadeOutWidth = Math.min(renderedClipWidth, fadeOut * pixelsPerSecond)
                  const fadeHandleInset = Math.min(6, Math.max(2, renderedClipWidth / 2))
                  const fadeInHandleX = Math.max(fadeHandleInset, Math.min(renderedClipWidth - fadeHandleInset, fadeInWidth))
                  const fadeOutHandleX = Math.max(fadeHandleInset, Math.min(renderedClipWidth - fadeHandleInset, renderedClipWidth - fadeOutWidth))
                  const isDraggingFadeOnClip = fadeDragState?.clipId === clip.id
                  const activeFadeDuration = isDraggingFadeOnClip
                    ? (fadeDragState.edge === 'in' ? fadeIn : fadeOut)
                    : null
                  const activeFadeHandleX = isDraggingFadeOnClip
                    ? (fadeDragState.edge === 'in' ? fadeInHandleX : fadeOutHandleX)
                    : null
                  const fadeBadgeX = activeFadeHandleX == null
                    ? null
                    : Math.max(18, Math.min(renderedClipWidth - 18, activeFadeHandleX))
                  const clipAsset = clip.assetId ? getAssetById(clip.assetId) : null
                  const clipLabelColor = getClipLabelColorValue(clip)
                  const nativeWaveformInput = (
                    (clipAsset?.absolutePath || null)
                    || (isNativeMediaUrl(clipAsset?.playbackCacheUrl) ? clipAsset.playbackCacheUrl : null)
                    || (isNativeMediaUrl(clipAsset?.url) ? clipAsset.url : null)
                    || (isNativeMediaUrl(clip?.url) ? clip.url : null)
                  )
                  const waveformInput = nativeWaveformInput || clipUrl
                  
                  return (
                  <div
                    key={clip.id}
                    data-clip="true"
                    data-clip-id={clip.id}
                    data-slide-edit-target={isSlideToolActive && !track.locked ? clip.id : undefined}
                    onMouseDown={(e) => handleClipDragStart(e, clip)}
                    onClick={(e) => handleClipClick(e, clip)}
                    onContextMenu={(e) => handleClipContextMenu(e, clip)}
                    className={`absolute top-0.5 bottom-0.5 rounded-sm group ${
                      isRazorToolActive
                        ? 'cursor-crosshair'
                        : isSlipToolActive || isSlideToolActive
                          ? 'cursor-ew-resize'
                          : isTrimToolActive
                            ? 'cursor-default'
                            : 'cursor-grab'
                    } ${
                      slipState?.clipId === clip.id || slideState?.clipId === clip.id || clipDragState?.movingClipIds?.includes(clip.id) ? 'z-30' : ''
                    }`}
                    style={{ 
                      left: `${(clip.startTime * pixelsPerSecond) - interactiveClipOffset}px`, 
                      width: `${interactiveClipWidth}px`,
                    }}
                  >
                    {rippleHandlesEnabled && renderRippleTrimHandles(clip, track)}
                    {isSlipToolActive && track.locked && renderLockedSlipTarget(clip)}
                    {isSlideToolActive && track.locked && renderLockedSlideTarget(clip)}
                    <div
                      className={`absolute top-0 bottom-0 rounded-sm overflow-hidden ${
                        selectedClipIds.includes(clip.id) ? 'ring-2 ring-white ring-offset-1 ring-offset-sf-dark-900' : ''
                      } ${slipState?.clipId === clip.id || slideState?.clipId === clip.id ? 'ring-2 ring-yellow-400 cursor-ew-resize z-30' : ''} ${clipDragState?.movingClipIds?.includes(clip.id)
                          ? (clipDragState?.isDuplicating
                            ? 'ring-2 ring-emerald-400 cursor-copy z-30'
                            : 'ring-2 ring-sf-accent cursor-grabbing z-30') : ''} ${clipEnabled ? '' : 'opacity-60 saturate-0'}`}
                      style={{
                        left: `${interactiveClipOffset}px`,
                        width: `${renderedClipWidth}px`,
                      }}
                    >
                    {/* Clip background + top accent (Resolve-style teal) */}
                    <div 
                      className="absolute inset-0"
                      style={{ backgroundColor: AUDIO_TRACK_BG }}
                    />
                    <div 
                      className="absolute inset-x-0 top-0 h-[3px]"
                      style={{ backgroundColor: AUDIO_CLIP_ACCENT }}
                    />
                    
                    {/* Real waveform visualization (Resolve-style colors) */}
                    <AudioWaveformBars
                      clip={clip}
                      clipWidth={clipWidth}
                      clipUrl={clipUrl}
                      waveformInput={waveformInput}
                      stereo={isStereoContent}
                    />

                    {audioEnvelopeTargetId === clip.id && (
                      <AudioVolumeEnvelope clip={clip} track={track} width={renderedClipWidth} height={contentHeight - 4} fps={timelineFps} />
                    )}

                    {fadeInWidth > 0 && (
                      <div
                        className="absolute left-0 top-[3px] bottom-0 z-10 pointer-events-none"
                        style={{
                          width: `${fadeInWidth}px`,
                        }}
                      >
                        <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                          <polygon points="0,100 100,0 100,100" fill="rgba(255,255,255,0.10)" />
                          <line x1="0" y1="100" x2="100" y2="0" stroke="rgba(210,255,246,0.72)" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
                        </svg>
                      </div>
                    )}
                    {fadeOutWidth > 0 && (
                      <div
                        className="absolute right-0 top-[3px] bottom-0 z-10 pointer-events-none"
                        style={{
                          width: `${fadeOutWidth}px`,
                        }}
                      >
                        <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                          <polygon points="0,0 100,100 0,100" fill="rgba(255,255,255,0.10)" />
                          <line x1="0" y1="0" x2="100" y2="100" stroke="rgba(210,255,246,0.72)" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
                        </svg>
                      </div>
                    )}

                    {isDraggingFadeOnClip && activeFadeDuration !== null && fadeBadgeX !== null && (
                      <div
                        className="absolute top-[22px] z-30 -translate-x-1/2 pointer-events-none"
                        style={{ left: `${fadeBadgeX}px` }}
                      >
                        <div className="rounded bg-black/80 border border-white/10 px-1.5 py-0.5 text-[9px] text-white/95 font-mono whitespace-nowrap shadow-lg backdrop-blur-[2px]">
                          {fadeDragState.edge === 'in' ? 'Fade In' : 'Fade Out'} {formatSecondsFrames(activeFadeDuration, timecodeFps)}
                        </div>
                      </div>
                    )}
                    
                    {/* Clip label - top left with background */}
                    <div className="absolute top-[4px] left-1 right-5 z-10">
                      <span 
                        className="text-[9px] text-white font-medium truncate block px-1 py-0.5 rounded"
                        style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
                      >
                        {clip.name}
                      </span>
                    </div>

                    {!clipEnabled && (
                      <>
                        <div className="absolute inset-0 bg-slate-950/35 pointer-events-none z-10" />
                        <div className="absolute top-[4px] right-1 z-20 flex items-center gap-1 rounded bg-slate-950/85 border border-white/10 px-1 py-0.5 text-[8px] text-slate-100 uppercase tracking-[0.14em] pointer-events-none">
                          <EyeOff className="w-2.5 h-2.5" />
                          <span>Off</span>
                        </div>
                      </>
                    )}

                    {clipLabelColor && (
                      <>
                        <div
                          className="absolute inset-0 z-[6] pointer-events-none"
                          style={{
                            backgroundColor: clipLabelColor,
                            opacity: getClipLabelTintOpacity(clip),
                          }}
                        />
                        <div
                          className="absolute inset-x-0 bottom-0 z-[7] h-[14px] pointer-events-none"
                          style={{
                            backgroundColor: clipLabelColor,
                            opacity: getClipLabelFooterOpacity(clip),
                          }}
                        />
                        <div
                          className="absolute inset-x-0 top-0 z-20 h-[3px] pointer-events-none"
                          style={{ backgroundColor: clipLabelColor }}
                        />
                      </>
                    )}
                    
                    {/* Hover overlay */}
                    <div className="absolute inset-0 bg-white/0 group-hover:bg-white/10 transition-colors pointer-events-none" />
                    
                    {/* Left/Right edge borders */}
                    <div className="absolute left-0 top-0 bottom-0 w-px bg-black/40 pointer-events-none" />
                    <div className="absolute right-0 top-0 bottom-0 w-px bg-black/40 pointer-events-none" />
                    
                    {trimHandlesEnabled && !rippleEditMode && !isSyncLockedClip(clip) && (
                      <>
                        {/* Trim handles on hover - wider hit area for easier grabbing */}
                        <div
                          data-trim-handle="true"
                          onMouseDown={(e) => handleTrimStart(e, clip.id, 'left')}
                          className="absolute left-0 top-0 bottom-0 w-4 bg-white/0 group-hover:bg-white/20 cursor-ew-resize transition-colors z-20 flex items-center justify-start"
                        >
                          <div className="w-1 h-6 bg-white/0 group-hover:bg-white/90 rounded-r transition-colors" />
                        </div>
                        <div
                          data-trim-handle="true"
                          onMouseDown={(e) => handleTrimStart(e, clip.id, 'right')}
                          className="absolute right-0 top-0 bottom-0 w-4 bg-white/0 group-hover:bg-white/20 cursor-ew-resize transition-colors z-20 flex items-center justify-end"
                        >
                          <div className="w-1 h-6 bg-white/0 group-hover:bg-white/90 rounded-l transition-colors" />
                        </div>
                      </>
                    )}

                    {/* Fade handles live only in the top strip so the clip edge
                        remains a trim target everywhere else. */}
                    <div
                      data-fade-handle="true"
                      onMouseDown={(e) => handleFadeDragStart(e, clip, 'in')}
                      className="absolute top-[3px] z-30 h-5 w-5 -translate-x-1/2 cursor-ew-resize flex items-start justify-center group/fade"
                      style={{ left: `${fadeInHandleX}px` }}
                      title={`Drag fade in (${formatSecondsFrames(fadeIn, timecodeFps)})`}
                    >
                      <div className="relative h-5 w-5">
                        <div className={`absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 rounded-[2px] border shadow-[0_1px_3px_rgba(0,0,0,0.55)] transition-colors ${
                          fadeDragState?.clipId === clip.id && fadeDragState?.edge === 'in'
                            ? 'border-[#ffd8d2] bg-[#ff7a68]'
                            : 'border-white/80 bg-[#d8e1dc] group-hover/fade:bg-white'
                        }`} />
                        <div className="absolute left-1/2 top-[7px] h-2.5 w-px -translate-x-1/2 bg-[#ff6f61]/95 shadow-[0_0_4px_rgba(255,111,97,0.45)]" />
                        <svg className="absolute left-1/2 top-[12px] h-2.5 w-3.5 -translate-x-1/2 text-[#ff6f61]/95" viewBox="0 0 14 10" fill="none" aria-hidden="true">
                          <path d="M2 8C5.5 8 5.5 2 12 2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
                        </svg>
                      </div>
                      <div className="absolute top-4 left-1/2 -translate-x-1/2 rounded bg-black/80 border border-white/10 px-1 py-0.5 text-[8px] text-white/90 opacity-0 group-hover/fade:opacity-100 pointer-events-none transition-opacity whitespace-nowrap">
                        Fade
                      </div>
                    </div>
                    <div
                      data-fade-handle="true"
                      onMouseDown={(e) => handleFadeDragStart(e, clip, 'out')}
                      className="absolute top-[3px] z-30 h-5 w-5 -translate-x-1/2 cursor-ew-resize flex items-start justify-center group/fade"
                      style={{ left: `${fadeOutHandleX}px` }}
                      title={`Drag fade out (${formatSecondsFrames(fadeOut, timecodeFps)})`}
                    >
                      <div className="relative h-5 w-5">
                        <div className={`absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 rounded-[2px] border shadow-[0_1px_3px_rgba(0,0,0,0.55)] transition-colors ${
                          fadeDragState?.clipId === clip.id && fadeDragState?.edge === 'out'
                            ? 'border-[#ffd8d2] bg-[#ff7a68]'
                            : 'border-white/80 bg-[#d8e1dc] group-hover/fade:bg-white'
                        }`} />
                        <div className="absolute left-1/2 top-[7px] h-2.5 w-px -translate-x-1/2 bg-[#ff6f61]/95 shadow-[0_0_4px_rgba(255,111,97,0.45)]" />
                        <svg className="absolute left-1/2 top-[12px] h-2.5 w-3.5 -translate-x-1/2 scale-x-[-1] text-[#ff6f61]/95" viewBox="0 0 14 10" fill="none" aria-hidden="true">
                          <path d="M2 8C5.5 8 5.5 2 12 2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
                        </svg>
                      </div>
                      <div className="absolute top-4 left-1/2 -translate-x-1/2 rounded bg-black/80 border border-white/10 px-1 py-0.5 text-[8px] text-white/90 opacity-0 group-hover/fade:opacity-100 pointer-events-none transition-opacity whitespace-nowrap">
                        Fade
                      </div>
                    </div>
                    </div>
                  </div>
                  )
                })}
                {renderAssetDropPreviewClip(track)}
                
                {/* Roll edit zones between adjacent audio clips */}
                {getAdjacentClips(track.id).map(({ clipA, clipB, isTrueEditPoint }) => {
                  const canRollEdit = !rippleHandlesEnabled && isTrimToolActive && isTrueEditPoint
                  if (!canRollEdit) return null
                  const editPointX = (clipA.startTime + clipA.duration) * pixelsPerSecond
                  
                  return (
                    <div
                      key={`edit-${clipA.id}-${clipB.id}`}
                      data-gap-ignore="true"
                      className="absolute top-0 bottom-0 z-20 group/edit"
                      style={{ left: `${editPointX - 6}px`, width: '12px' }}
                    >
                      {/* Roll edit handle */}
                      <div
                        data-testid="roll-edit-handle" data-clip-a-id={clipA.id} data-clip-b-id={clipB.id}
                        className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-1.5 cursor-ew-resize flex items-center justify-center"
                        onMouseDown={(e) => handleRollEditStart(e, clipA, clipB)}
                        title="Drag to roll edit"
                      >
                        <div className="w-0.5 h-full bg-white/0 group-hover/edit:bg-yellow-400/70 transition-colors" />
                      </div>
                    </div>
                  )
                })}
                
              </div>
            )
          })}
          </div>

          </div>
          
          {/* Marquee Selection Rectangle */}
          {marqueeState && (
            <div
              className="absolute border-2 border-sf-accent bg-sf-accent/10 z-30 pointer-events-none"
              style={{
                left: `${Math.min(marqueeState.startX, marqueeState.currentX)}px`,
                top: `${Math.min(marqueeState.startY, marqueeState.currentY)}px`,
                width: `${Math.abs(marqueeState.currentX - marqueeState.startX)}px`,
                height: `${Math.abs(marqueeState.currentY - marqueeState.startY)}px`,
              }}
            />
          )}

          {/* Timeline Markers */}
          {markers.map((marker, index) => {
            const isSelected = marker.id === selectedMarkerId
            const markerLabel = marker.label?.trim() || `M${index + 1}`
            const markerColor = /^#[0-9a-fA-F]{6}$/.test(marker.color || '') ? marker.color : '#06b6d4'
            return (
              <div
                key={marker.id}
                className="absolute top-0 bottom-0 z-[18] pointer-events-none"
                style={{ left: `${marker.time * pixelsPerSecond}px` }}
              >
                <div
                  className={`absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-px ${
                    isSelected
                      ? 'bg-cyan-200 shadow-[0_0_8px_rgba(103,232,249,0.45)]'
                      : ''
                  }`}
                  style={isSelected ? undefined : {
                    backgroundColor: markerColor,
                    boxShadow: `0 0 8px ${markerColor}66`,
                  }}
                />
                <button
                  data-marker-handle="true"
                  className={`absolute -top-1 left-1/2 -translate-x-1/2 h-4 min-w-[18px] px-1 pointer-events-auto transition-all rounded-[4px] border shadow-[0_4px_10px_rgba(0,0,0,0.35)] flex items-center justify-center gap-1 ${
                    isSelected
                      ? 'border-cyan-100/80 bg-cyan-300 text-slate-950'
                      : 'text-white hover:brightness-110'
                  }`}
                  style={isSelected ? undefined : {
                    backgroundColor: markerColor,
                    borderColor: `${markerColor}aa`,
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    selectMarker(marker.id)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    removeMarker(marker.id)
                  }}
                  title={`${markerLabel} - ${formatTimelineTimecode(marker.time)} (right-click to remove)`}
                >
                  <Flag className="w-2.5 h-2.5" />
                </button>
                <div
                  className={`absolute top-3 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rotate-45 ${
                    isSelected ? 'bg-cyan-300' : ''
                  }`}
                  style={isSelected ? undefined : { backgroundColor: markerColor }}
                />
                {isSelected && (
                  <div className="absolute top-5 left-2 text-[9px] px-1.5 py-0.5 rounded border border-cyan-400/35 bg-slate-950/92 text-cyan-100 whitespace-nowrap pointer-events-none font-mono shadow-[0_6px_14px_rgba(0,0,0,0.35)]">
                    {markerLabel}
                  </div>
                )}
              </div>
            )
          })}
          
          {/* In Point Marker */}
          {inPoint !== null && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-[#5a7a9e] z-15 pointer-events-none"
              style={{ left: `${inPoint * pixelsPerSecond}px` }}
            >
              {/* In point indicator at top */}
              <div className="absolute -top-0.5 left-0 w-3 h-3 bg-[#5a7a9e] flex items-center justify-center">
                <span className="text-[8px] text-white font-bold">I</span>
              </div>
            </div>
          )}
          
          {/* Out Point Marker */}
          {outPoint !== null && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-[#5a7a9e] z-15 pointer-events-none"
              style={{ left: `${outPoint * pixelsPerSecond}px` }}
            >
              {/* Out point indicator at top */}
              <div className="absolute -top-0.5 right-0 w-3 h-3 bg-[#5a7a9e] flex items-center justify-center">
                <span className="text-[8px] text-white font-bold">O</span>
              </div>
            </div>
          )}
          
          {/* I/O Range Highlight */}
          {inPoint !== null && outPoint !== null && inPoint < outPoint && (
            <div
              className="absolute top-0 bottom-0 bg-[#5a7a9e]/10 z-5 pointer-events-none border-t border-b border-[#5a7a9e]/30"
              style={{
                left: `${inPoint * pixelsPerSecond}px`,
                width: `${(outPoint - inPoint) * pixelsPerSecond}px`
              }}
            >
              {/* Render In→Out status strip — same color language as the
                  per-clip render strip (purple rendering / green fresh /
                  amber stale) */}
              {rangeRenderState
                && Math.abs((rangeRenderState.rangeStart ?? -1) - inPoint) < 0.001
                && Math.abs((rangeRenderState.rangeEnd ?? -1) - outPoint) < 0.001 && (
                <div className="absolute left-0 bottom-0 h-[3px] w-full bg-sf-dark-900/60">
                  {rangeRenderState.status === 'rendering' && (
                    <div
                      className="h-full bg-purple-400/90"
                      style={{ width: `${Math.max(4, Math.min(100, Number(rangeRenderState.progress) || 0))}%` }}
                    />
                  )}
                  {rangeRenderState.status === 'cached' && <div className="h-full w-full bg-emerald-400/90" />}
                  {rangeRenderState.status === 'stale' && <div className="h-full w-full bg-amber-400/90" />}
                </div>
              )}
            </div>
          )}
          
          {/* Snap Guide Lines */}
          {activeSnapTime !== null && snappingEnabled && (
            <div
              className="absolute top-0 bottom-0 w-px bg-white/75 z-20 pointer-events-none"
              style={{ 
                left: `${activeSnapTime * pixelsPerSecond}px`,
                boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.28)'
              }}
            >
              <div className="absolute -top-0.5 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rotate-45 bg-white/80 border border-black/25" />
            </div>
          )}
          
          {rippleTrimState && Number.isFinite(rippleTrimPreview?.feedback?.guideTime)
            && rippleTrimPreview.feedback.guideTime >= 0 && <div
              data-testid="ripple-trim-guide" data-guide-time={rippleTrimPreview.feedback.guideTime}
              className="absolute top-0 bottom-0 z-40 border-l border-dashed border-accent pointer-events-none"
              style={{ left: `${rippleTrimPreview.feedback.guideTime * pixelsPerSecond}px` }} />}

          {/* Playhead — positioned imperatively by the store subscription
              above; the render-time left only covers the first paint. */}
          <div
            ref={playheadElRef}
            className={`absolute top-0 bottom-0 z-10 ${isScrubbing ? 'pointer-events-none' : ''}`}
            style={{ left: `${getLivePlayhead() * pixelsPerSecond}px`, width: '2px' }}
          >
            <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-[2px] bg-orange-400 shadow-[0_0_12px_rgba(251,146,60,0.45)]" />
            {/* Playhead handle (draggable) */}
            <div 
              className="absolute -top-1 left-1/2 -translate-x-1/2 w-5 h-4 cursor-ew-resize flex items-start justify-center"
              data-testid="timeline-playhead-handle"
              onMouseDown={beginTimelineScrub}
              title="Drag to scrub"
            >
              <div
                className="w-3 h-3 bg-orange-400 border border-orange-200/70 hover:bg-orange-300 transition-colors shadow-[0_3px_8px_rgba(0,0,0,0.38)]"
                style={{ clipPath: 'polygon(12% 0, 88% 0, 100% 55%, 50% 100%, 0 55%)' }}
              />
            </div>
            {/* Notch at active track (Flame-style) — aligns with primary track */}
            {activeTrackId && (() => {
              const audioSectionHeight = 20
              const timeRulerHeight = 20
              const notchHeight = 10
              const totalVideoTracksHeight = videoTracks.reduce((sum, track) => sum + getTrackHeight(track), 0)
              const vi = videoTracks.findIndex(t => t.id === activeTrackId)
              const ai = audioTracks.findIndex(t => t.id === activeTrackId)
              let centerY = 0
              if (vi >= 0) {
                const track = videoTracks[vi]
                centerY = timeRulerHeight + getTrackOffset(videoTracks, vi) + getTrackHeight(track) / 2
              }
              else if (ai >= 0) {
                const track = audioTracks[ai]
                centerY = timeRulerHeight + totalVideoTracksHeight + audioSectionHeight + getTrackOffset(audioTracks, ai) + getTrackHeight(track) / 2
              }
              else return null
              const top = centerY - notchHeight / 2
              return (
                <div
                  className="absolute left-0 w-2 h-2.5 bg-orange-400 pointer-events-none shadow-[0_0_8px_rgba(251,146,60,0.35)]"
                  style={{ top: `${top}px`, clipPath: 'polygon(0 50%, 100% 0, 100% 100%)' }}
                  title="Primary track"
                />
              )
            })()}
            {/* Playhead line extension for easier grabbing */}
            <div 
              className="absolute top-0 left-1/2 -translate-x-1/2 w-2 h-full cursor-ew-resize"
              data-testid="timeline-playhead-line"
              onMouseDown={beginTimelineScrub}
            />
          </div>
        </div>
        
        {/* Audio Meter Panel - Right side, full height of track panel, resizes with it */}
        <div className="flex-shrink-0 flex flex-col border-l border-sf-dark-700 w-[72px] min-h-0">
          {/* Time ruler header spacer - aligns with time ruler */}
          <div className="h-5 flex-shrink-0 border-b border-sf-dark-700 bg-sf-dark-800" />
          
          {/* Meter fills remaining height and resizes with track panel */}
          <div className="flex-1 min-h-0 flex flex-col">
            <MasterAudioMeter className="flex-1 min-h-0" />
          </div>
        </div>
      </div>
      
      {/* Cut menu — creation and a temporary Play Around audition. */}
      {transitionMenu && (() => {
        const state = useTimelineStore.getState()
        const target = transitionMenu.target
        const current = isTransitionCutTargetCurrent(state, target, { allowExisting: true })
        const maxDuration = current && !target.transition
          ? state.getMaxTransitionDuration(target.clipA.id, target.clipB.id) : 0
        const canAdd = maxDuration >= 1 / FRAME_RATE

        return (
          <div
            ref={transitionMenuRef}
            data-testid="transition-cut-menu"
            className="fixed z-50 bg-sf-dark-800 border border-sf-dark-600 rounded-lg shadow-xl py-1 w-[220px] max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-auto"
            style={{ left: `${transitionMenuPosition.x}px`, top: `${transitionMenuPosition.y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-2 text-[10px] text-sf-text-muted uppercase tracking-wider border-b border-sf-dark-600">
              At cut
            </div>
            {!target.transition && (canAdd ? (
              <button
                type="button"
                onClick={handleSelectTransition}
                className="w-full px-3 py-2.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 focus-visible:bg-sf-dark-700 focus-visible:outline-none flex items-center gap-2 transition-colors"
              >
                <span>Add transition</span>
              </button>
            ) : (
              <div className="px-3 py-2 text-xs text-sf-text-muted">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="w-4 h-4 text-sf-accent" />
                  <span className="font-medium text-sf-text-primary">Clips too short</span>
                </div>
                <p className="text-[10px] leading-tight">
                  These clips are too short for a transition. Extend a clip and try again.
                </p>
              </div>
            ))}
            <button type="button" data-testid="play-around-cut" disabled={!current || Boolean(mediaPreparation?.critical)}
              onClick={handlePlayAroundCut}
              className="w-full px-3 py-2.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 focus-visible:bg-sf-dark-700 disabled:opacity-40">
              Play around cut
            </button>
          </div>
        )
      })()}
      
      {/* Clip Context Menu (Portal). We deliberately do NOT put
          `overflow-auto` on this container: the mask submenu is an
          absolutely-positioned child that opens to the side, and an
          `overflow: auto` ancestor would clip it into a horizontal
          scrollbar. The viewport-clamped position below already keeps
          the whole menu on-screen for any reasonable window size. */}
      {clipContextMenu && (
        <div
          ref={clipContextMenuRef}
          className="fixed z-50 bg-sf-dark-800 border border-sf-dark-600 rounded-lg shadow-xl py-1 min-w-[240px]"
          style={{
            left: `${clipContextMenuPosition.x}px`,
            top: `${clipContextMenuPosition.y}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" data-testid="zoom-to-selection"
            title={t('timelineEditor.tooltips.zoomToSelectionHelp')}
            onClick={() => {
              handleZoomToSelection({ focusTimeline: true })
              setClipContextMenu(null)
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700">
            <Maximize2 className="h-3 w-3 shrink-0" />
            <span className="min-w-0 flex-1">{t(`timelineEditor.tooltips.${selectionViewWillRestore ? 'restoreSelectionView' : 'zoomToSelection'}`)}</span>
            {selectionViewHotkeyLabel !== 'Not set' && <span className="shrink-0 text-[10px] text-sf-text-muted">{selectionViewHotkeyLabel}</span>}
          </button>
          <div className="my-1 h-px bg-sf-dark-600" />
          {contextCompoundClip ? <>
            <button type="button" data-testid="compound-open" onClick={() => openCompoundContents(contextCompoundClip)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-violet-200 hover:bg-sf-dark-700"><Layers className="h-3 w-3" />Open Contents</button>
            <button type="button" data-testid="compound-uncompound-open" disabled={selectedClipIds.length !== 1 || !!compoundEditContext} onClick={() => openUncompound(contextCompoundClip.id)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 disabled:cursor-not-allowed disabled:opacity-50"><Layers className="h-3 w-3" />Uncompound…</button>
            {selectedClipIds.length !== 1 && <p className="max-w-[260px] px-3 pb-1 text-[10px] text-sf-text-muted">Select just one compound to restore its child clips.</p>}
            <p className="max-w-[260px] px-3 pb-2 text-[10px] leading-relaxed text-sf-text-muted">Move or trim this parent clip. Open its contents for other edits.</p>
            <div className="my-1 h-px bg-sf-dark-600" />
            <button type="button" onClick={() => handleContextMenuAction('move-by-offset')} className="w-full px-3 py-1.5 text-left text-xs hover:bg-sf-dark-700">Move by Offset…</button>
            <button type="button" onClick={() => handleContextMenuAction('duration-by-amount')} className="w-full px-3 py-1.5 text-left text-xs hover:bg-sf-dark-700">Change Duration…</button>
            <button type="button" onClick={() => handleContextMenuAction('toggle-enabled')} className="w-full px-3 py-1.5 text-left text-xs hover:bg-sf-dark-700">{clipContextShouldEnable ? 'Enable' : 'Disable'}</button>
            <div className="my-1 h-px bg-sf-dark-600" />
            <button type="button" onClick={() => handleContextMenuAction('delete')} className="w-full px-3 py-1.5 text-left text-xs text-sf-error hover:bg-sf-error/20">{rippleEditMode ? 'Ripple Delete' : 'Delete'}</button>
          </> : <>
          <button type="button" data-testid="compound-create-open" disabled={!!compoundEditContext || hasCompoundSelection || !selectedClipIds.length} onClick={openCompoundCreate}
            title={compoundEditContext || hasCompoundSelection ? 'Compounds cannot contain another compound' : 'Group selected clips into one editable compound'}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 disabled:cursor-not-allowed disabled:opacity-50"><Layers className="h-3 w-3" />Create Compound Clip…</button>
          {(compoundEditContext || hasCompoundSelection) && <p className="max-w-[260px] px-3 pb-1 text-[10px] text-sf-text-muted">Compounds cannot contain another compound.</p>}
          {(() => {
            const eligibility = getSmartReplaceEligibility({ clips, tracks, selectedClipIds }, clipContextMenu.clipId)
            return <>
              <button type="button" data-testid="smart-replace-open" onClick={() => openSmartReplace(clipContextMenu.clipId)} disabled={!eligibility.ok}
                title={eligibility.reason || 'Swap media while keeping this clip’s edit'}
                className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                <ArrowRightLeft className="h-3 w-3" /><span>Smart Replace…</span>
              </button>
              {!eligibility.ok && <p className="max-w-[260px] px-3 pb-1 text-[10px] leading-relaxed text-sf-text-muted">{eligibility.reason}</p>}
            </>
          })()}
          {(() => {
            const contextClip = clips.find(c => c.id === clipContextMenu.clipId)
            const contextAsset = contextClip?.assetId ? getAssetById(contextClip.assetId) : null
            if (!contextAsset) return null
            const canMatchFrame = (contextClip.type === 'video' || contextClip.type === 'audio')
              && (contextAsset.type === 'video' || contextAsset.type === 'audio')
            const canRevealOnDisk = canRevealAssetInFileManager(contextAsset)
            return (
              <>
                {canMatchFrame && (
                  <button
                    onClick={() => {
                      openMatchFrameForClip(contextClip)
                      setClipContextMenu(null)
                    }}
                    className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
                  >
                    <span>Match Frame in Source Player</span>
                    {matchFrameHotkeyLabel && (
                      <span className="ml-auto text-sf-text-muted text-[10px]">{matchFrameHotkeyLabel}</span>
                    )}
                  </button>
                )}
                <button
                  onClick={() => {
                    revealClipInAssetsPanel(contextClip)
                    setClipContextMenu(null)
                  }}
                  className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
                >
                  <span>Reveal in Assets Panel</span>
                  {revealInAssetsHotkeyLabel && (
                    <span className="ml-auto text-sf-text-muted text-[10px]">{revealInAssetsHotkeyLabel}</span>
                  )}
                </button>
                {canRevealOnDisk && (
                  <button
                    onClick={() => {
                      void revealAssetInFileManager(contextAsset)
                      setClipContextMenu(null)
                    }}
                    className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
                  >
                    <span>{getRevealInFileManagerLabel()}</span>
                  </button>
                )}
                <div className="h-px bg-sf-dark-600 my-1" />
              </>
            )
          })()}
          {(() => {
            const contextClip = clips.find(c => c.id === clipContextMenu.clipId)
            const contextAsset = contextClip?.assetId ? getAssetById(contextClip.assetId) : null
            const isCaptionOverlay = contextClip?.type === 'captions' || Boolean(
              contextAsset?.settings?.overlayKind === 'captions' || contextAsset?.settings?.captionScope
            )
            if (!isCaptionOverlay) return null
            return (
              <>
                <button
                  onClick={() => handleEditCaptionsFromClip(contextClip)}
                  className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
                >
                  <span>Edit Captions…</span>
                </button>
                <div className="h-px bg-sf-dark-600 my-1" />
              </>
            )
          })()}
          {(() => {
            const contextClip = clips.find(c => c.id === clipContextMenu.clipId)
            const canUseMask = contextClip?.type === 'video' || contextClip?.type === 'image'
            if (!canUseMask) return null
            
            return (
              <>
                <div className="relative">
                  <button
                    onClick={() => setMaskSubmenuOpen((prev) => !prev)}
                    className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
                  >
                    <span>Add Mask…</span>
                    <ChevronRight className="ml-auto w-3 h-3 text-sf-text-muted" />
                  </button>
                  
                  {maskSubmenuOpen && (() => {
                    // Decide which side of the parent menu to open the
                    // submenu on. We don't know the exact submenu width
                    // before render, but `min-w-[220px]` is a safe lower
                    // bound; the parent menu is `min-w-[240px]`. If opening
                    // to the right would push the submenu off the viewport
                    // edge (or close enough to it that it would feel
                    // cramped), we flip to the left instead.
                    const SUBMENU_MIN_WIDTH = 220
                    const PARENT_MIN_WIDTH = 240
                    const EDGE_MARGIN = 12
                    const viewportWidth = typeof window !== 'undefined'
                      ? window.innerWidth
                      : Infinity
                    const wouldOverflowRight =
                      clipContextMenuPosition.x + PARENT_MIN_WIDTH
                        + SUBMENU_MIN_WIDTH + EDGE_MARGIN > viewportWidth
                    const sideClasses = wouldOverflowRight
                      ? 'right-full mr-1'
                      : 'left-full ml-1'
                    return (
                    <div
                      className={`absolute top-0 ${sideClasses} bg-sf-dark-800 border border-sf-dark-600 rounded-lg shadow-xl py-1 min-w-[220px] z-50 max-h-60 overflow-y-auto overflow-x-hidden`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => handleContextMenuAction('add-mask')}
                        className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
                      >
                        <span>Open Mask Picker…</span>
                      </button>
                      
                      <div className="h-px bg-sf-dark-600 my-1" />
                      
                      {availableMasks.length > 0 ? (
                        availableMasks.map((mask) => (
                          <button
                            key={mask.id}
                            onClick={() => handleApplyMaskFromContextMenu(mask.id)}
                            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
                          >
                            <span className="truncate">{mask.name}</span>
                          </button>
                        ))
                      ) : (
                        <div className="px-3 py-2 text-xs text-sf-text-muted">
                          No masks found
                        </div>
                      )}
                    </div>
                    )
                  })()}
                </div>
                <div className="h-px bg-sf-dark-600 my-1" />
              </>
            )
          })()}
          {(() => {
            const contextClip = clips.find(c => c.id === clipContextMenu.clipId)
            if (!isClipRenderable(contextClip)) return null
            const isRenderingClip = contextClip?.cacheStatus === 'rendering'
            const renderLabel = isRenderingClip
              ? 'Rendering…'
              : (contextClip?.cacheStatus === 'cached' ? 'Re-render Clip' : 'Render Clip')
            return (
              <>
                <button
                  onClick={() => handleContextMenuAction('render-cache')}
                  disabled={isRenderingClip}
                  className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-default"
                >
                  <Zap className="w-3 h-3 text-sf-text-muted" />
                  <span>{renderLabel}</span>
                </button>
                <div className="h-px bg-sf-dark-600 my-1" />
              </>
            )
          })()}
          {(() => {
            const contextClip = clips.find(c => c.id === clipContextMenu.clipId)
            const canDetectBeats = contextClip
              && (contextClip.type === 'audio' || contextClip.type === 'video')
              && contextClip.assetId
            if (!canDetectBeats) return null
            const isAnalyzing = beatAnalysisClipId === contextClip.id
            return (
              <>
                <button
                  onClick={() => handleDetectBeatsForClip(contextClip.id)}
                  disabled={Boolean(beatAnalysisClipId)}
                  className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-default"
                >
                  {isAnalyzing
                    ? <Loader2 className="w-3 h-3 animate-spin text-sf-text-muted" />
                    : <MusicIcon className="w-3 h-3 text-sf-text-muted" />}
                  <span>{isAnalyzing ? 'Detecting beats…' : 'Detect Beats → Markers'}</span>
                </button>
                {beatAnalysisError && (
                  <div role="alert" data-testid="beat-analysis-error" className="px-3 pb-1 text-[10px] text-sf-error">{beatAnalysisError}</div>
                )}
                <div className="h-px bg-sf-dark-600 my-1" />
              </>
            )
          })()}
          {(() => {
            const contextClip = clips.find(c => c.id === clipContextMenu.clipId)
            const hasCache =
              !!contextClip?.cacheUrl ||
              !!contextClip?.cachePath ||
              (contextClip?.cacheStatus && contextClip.cacheStatus !== 'none')

            if (!hasCache) return null

            return (
              <>
                <button
                  onClick={() => handleContextMenuAction('flush-cache')}
                  className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
                >
                  <span>Flush Render Cache</span>
                </button>
                <div className="h-px bg-sf-dark-600 my-1" />
              </>
            )
          })()}
          <button
            onClick={() => handleContextMenuAction('split')}
            disabled={hasCompoundSelection}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
            title={`Split selected clip at playhead (or press ${splitActiveHotkeyLabel} to split on the active track)`}
          >
            <span>Split at Playhead</span>
            <span className="ml-auto text-sf-text-muted text-[10px]">{splitActiveHotkeyLabel}</span>
          </button>
          
          <button
            onClick={() => handleContextMenuAction('duplicate')}
            disabled={hasCompoundSelection}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
          >
            <span>Duplicate</span>
            <span className="ml-auto text-sf-text-muted text-[10px]">⌘D</span>
          </button>
          <button
            onClick={() => handleContextMenuAction('move-by-offset')}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
            title="Move the current selection by an exact signed timecode offset"
          >
            <span>Move by Offset...</span>
            <span className="ml-auto text-sf-text-muted text-[10px]">{moveByHotkeyLabel}</span>
          </button>
          <button
            onClick={() => handleContextMenuAction('duration-by-amount')}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
            title="Change the current selection duration by an exact signed amount"
          >
            <span>Change Duration...</span>
            {durationByHotkeyHint && (
              <span className="ml-auto text-sf-text-muted text-[10px]">{durationByHotkeyHint}</span>
            )}
          </button>
          {clipContextCanAddTransition && (
            <button
              onClick={() => addTransitionFromSelectedClips()}
              className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
              title={`Add a default transition between the selected touching clips (${addTransitionHotkeyLabel})`}
            >
              <span>Add transition</span>
              <span className="ml-auto text-sf-text-muted text-[10px]">{addTransitionHotkeyLabel}</span>
            </button>
          )}
          <div className="h-px bg-sf-dark-600 my-1" />
          <div className="px-3 py-2">
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-sf-text-muted">
              <Flag className="w-3 h-3" />
              <span>Label color</span>
            </div>
            <div className="grid grid-cols-9 gap-1">
              {CLIP_LABEL_COLOR_OPTIONS.map((option) => {
                const isActive = clipContextActiveLabelColor !== null && clipContextActiveLabelColor === option.color
                return (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => applyClipLabelColor(option.color)}
                    className={`h-5 w-5 rounded border flex items-center justify-center transition-colors ${
                      isActive
                        ? 'border-white ring-1 ring-white/70'
                        : 'border-sf-dark-500 hover:border-sf-text-secondary'
                    } ${option.color ? '' : 'bg-sf-dark-900'}`}
                    style={option.color ? { backgroundColor: option.color } : undefined}
                    title={option.label}
                    aria-label={option.label}
                  >
                    {!option.color && <X className="w-3 h-3 text-sf-text-muted" />}
                    {option.color && isActive && <Check className="w-3 h-3 text-white drop-shadow" />}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="h-px bg-sf-dark-600 my-1" />
          <button
            onClick={() => handleContextMenuAction('toggle-enabled')}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
            title="Enable or disable the current clip selection"
          >
            {clipContextShouldEnable ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
            <span>
              {clipContextShouldEnable
                ? (clipContextSelectionIds.length > 1 ? `Enable ${clipContextSelectionIds.length} clips` : 'Enable Clip')
                : (clipContextSelectionIds.length > 1 ? `Disable ${clipContextSelectionIds.length} clips` : 'Disable Clip')}
            </span>
            <span className="ml-auto text-sf-text-muted text-[10px]">{toggleClipEnabledHotkeyLabel}</span>
          </button>
          <button
            onClick={() => handleContextMenuAction('link-selection')}
            disabled={!clipContextCanLink}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Link the selected clips so they move together"
          >
            <Link className="w-3 h-3" />
            <span>Link Selected</span>
            <span className="ml-auto text-sf-text-muted text-[10px]">{linkHotkeyLabel}</span>
          </button>
          <button
            onClick={() => handleContextMenuAction('unlink-selection')}
            disabled={!clipContextCanUnlink}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Remove linking from the selected clips"
          >
            <Unlink className="w-3 h-3" />
            <span>Unlink Selected</span>
            <span className="ml-auto text-sf-text-muted text-[10px]">{unlinkHotkeyLabel}</span>
          </button>
          {clipContextSyncEligibleClips.length > 0 && (
            <button
              onClick={() => handleContextMenuAction('sync-toggle')}
              className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
              title={clipContextAllSyncLocked
                ? 'Convert synced performance clips back into normal timeline clips'
                : 'Lock synced performance clips to their song timing'}
            >
              {clipContextAllSyncLocked ? (
                <Unlock className="w-3 h-3" />
              ) : (
                <Lock className="w-3 h-3" />
              )}
              <span>{clipContextAllSyncLocked ? 'Unlock Sync' : 'Lock Sync'}</span>
            </button>
          )}
          <button
            onClick={() => { handleCopySelection(); setClipContextMenu(null) }}
            disabled={hasCompoundSelection}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
            title="Copy selected clips to paste at playhead"
          >
            <span>Copy</span>
            <span className="ml-auto text-sf-text-muted text-[10px]">Ctrl+C</span>
          </button>
          <button
            onClick={() => { handlePasteAtPlayhead(); setClipContextMenu(null) }}
            disabled={!activeTrackId || copiedClips.length === 0 || copiedClips.some(clip => clip.type === 'compound')}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Paste at playhead on active track"
          >
            <span>Paste at Playhead</span>
            <span className="ml-auto text-sf-text-muted text-[10px]">Ctrl+V</span>
          </button>
          <button
            data-testid="paste-attributes-open"
            onClick={openPasteAttributes}
            disabled={hasCompoundSelection || !selectedClipIds.length || !attributeClipboard?.clips?.length}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={attributeClipboard?.clips?.length ? 'Choose copied settings to replace on selected clips' : 'Copy a source clip first'}
          >
            <span>Paste Attributes…</span>
          </button>
          
          <div className="h-px bg-sf-dark-600 my-1" />
          
          <button
            onClick={() => handleContextMenuAction('delete')}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-error hover:bg-sf-error/20 flex items-center gap-2 transition-colors"
          >
            <span>{rippleEditMode ? (clipContextSelectionIds.length > 1 ? `Ripple Delete ${clipContextSelectionIds.length} clips` : 'Ripple Delete') : (clipContextSelectionIds.length > 1 ? `Delete ${clipContextSelectionIds.length} clips` : 'Delete')}</span>
            <span className="ml-auto text-sf-text-muted text-[10px]">Del</span>
          </button>
          </>}
        </div>
      )}

      {pasteAttributesSession && <PasteAttributesDialog session={pasteAttributesSession} onClose={closePasteAttributes} />}
      {smartReplaceSession && <SmartReplaceDialog session={smartReplaceSession} onClose={closeSmartReplace} />}
      {compoundClipSession && <CompoundClipDialog session={compoundClipSession} onClose={closeCompoundCreate} />}
      {uncompoundSession && <UncompoundDialog session={uncompoundSession} onClose={closeUncompound} />}
      {trimState && trimPreview?.feedback && <TrimEdgePreview feedback={trimPreview.feedback} anchor={trimPreview.anchor} fps={timecodeFps} />}
      {rippleTrimState && rippleTrimPreview?.feedback && <TrimEdgePreview mode="ripple" feedback={rippleTrimPreview.feedback} anchor={rippleTrimPreview.anchor} fps={timecodeFps} />}
      {rippleTrimRefusal && <TrimEdgePreview mode="ripple" reason={rippleTrimRefusal.reason} anchor={rippleTrimRefusal.anchor} fps={timecodeFps} />}
      {rollEditState && rollPreview?.feedback && <RollEditPreview feedback={rollPreview.feedback} anchor={rollPreview.anchor} fps={timecodeFps} />}
      {rollRefusal && <RollEditPreview reason={rollRefusal.reason} anchor={rollRefusal.anchor} fps={timecodeFps} />}
      {slipState && slipPreview?.feedback && <SlipEditPreview feedback={slipPreview.feedback} anchor={slipPreview.anchor} fps={timecodeFps} />}
      {slipRefusal && <SlipEditPreview reason={slipRefusal.reason} anchor={slipRefusal.anchor} fps={timecodeFps} />}
      {slideState && slidePreview?.feedback && <SlideEditPreview feedback={slidePreview.feedback} anchor={slidePreview.anchor} fps={timecodeFps} />}
      {slideRefusal && <SlideEditPreview reason={slideRefusal.reason} anchor={slideRefusal.anchor} fps={timecodeFps} />}

      {moveOffsetDialogOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              closeMoveOffsetDialog()
            }
          }}
        >
          <div className="w-full max-w-sm rounded-lg border border-sf-dark-600 bg-sf-dark-800 shadow-2xl">
            <div className="border-b border-sf-dark-700 px-4 py-3">
              <h3 className="text-sm font-medium text-sf-text-primary">Move Selected Clips</h3>
              <p className="mt-1 text-xs text-sf-text-muted">
                Apply a signed offset to {selectedClipIds.length} selected clip{selectedClipIds.length === 1 ? '' : 's'}.
              </p>
            </div>

            <form
              className="space-y-3 px-4 py-3"
              onSubmit={(e) => {
                e.preventDefault()
                applyMoveOffset()
              }}
            >
              <div className="flex items-center gap-1 rounded bg-sf-dark-900 p-1">
                <button
                  type="button"
                  onClick={() => {
                    setMoveOffsetMode('timecode')
                    setMoveOffsetError('')
                  }}
                  className={`rounded px-2.5 py-1 text-xs transition-colors ${
                    moveOffsetMode === 'timecode'
                      ? 'bg-sf-accent text-black'
                      : 'text-sf-text-secondary hover:bg-sf-dark-700'
                  }`}
                >
                  Timecode
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMoveOffsetMode('frames')
                    setMoveOffsetError('')
                  }}
                  className={`rounded px-2.5 py-1 text-xs transition-colors ${
                    moveOffsetMode === 'frames'
                      ? 'bg-sf-accent text-black'
                      : 'text-sf-text-secondary hover:bg-sf-dark-700'
                  }`}
                >
                  Frames
                </button>
              </div>

              <div>
                <label htmlFor="move-offset-input" className="mb-1 block text-[11px] uppercase tracking-wider text-sf-text-muted">
                  {moveOffsetMode === 'frames' ? 'Frames' : 'Offset'}
                </label>
                <input
                  id="move-offset-input"
                  ref={moveOffsetInputRef}
                  type="text"
                  inputMode={moveOffsetMode === 'frames' ? 'numeric' : 'text'}
                  value={moveOffsetMode === 'frames' ? moveOffsetFramesInput : moveOffsetInput}
                  onChange={(e) => {
                    if (moveOffsetMode === 'frames') {
                      setMoveOffsetFramesInput(sanitizeFrameOffsetInput(e.target.value))
                    } else {
                      setMoveOffsetInput(sanitizeTimelineOffsetInput(e.target.value))
                    }
                    if (moveOffsetError) setMoveOffsetError('')
                  }}
                  placeholder={moveOffsetMode === 'frames' ? '+12' : '+00:00:02:12'}
                  className="w-full rounded border border-sf-dark-600 bg-sf-dark-700 px-3 py-2 font-mono text-sm text-sf-text-primary focus:border-sf-accent focus:outline-none"
                />
                <p className="mt-1 text-[11px] text-sf-text-muted">
                  {moveOffsetMode === 'frames'
                    ? <>Use signed whole frames like <span className="font-mono">+12</span> or <span className="font-mono">-48</span>.</>
                    : <>Use signed timecode like <span className="font-mono">+00:00:02:12</span> or seconds like <span className="font-mono">-1.5</span>.</>}
                </p>
              </div>

              {!moveOffsetError && (
                <p className="text-xs text-sf-text-secondary">
                  {(() => {
                    const parsed = moveOffsetMode === 'frames'
                      ? parseFrameOffsetInput(moveOffsetFramesInput, timecodeFps)
                      : parseTimelineOffsetInput(moveOffsetInput, timecodeFps)
                    if (!parsed.success) return `Timeline FPS: ${Math.round(timecodeFps)}`
                    const sign = parsed.seconds < 0 ? '-' : '+'
                    const frameCount = Math.round(Math.abs(parsed.seconds) * Math.max(1, Math.round(timecodeFps)))
                    if (moveOffsetMode === 'frames') {
                      return `Parsed offset: ${sign}${frameCount} frames (${sign}${formatFrameTimecode(Math.abs(parsed.seconds), timecodeFps)})`
                    }
                    return `Parsed offset: ${sign}${formatFrameTimecode(Math.abs(parsed.seconds), timecodeFps)} (${sign}${frameCount} frames)`
                  })()}
                </p>
              )}

              {moveOffsetError && (
                <p className="text-xs text-sf-error">{moveOffsetError}</p>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={closeMoveOffsetDialog}
                  className="rounded bg-sf-dark-700 px-3 py-1.5 text-xs text-sf-text-secondary transition-colors hover:bg-sf-dark-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded bg-sf-accent px-3 py-1.5 text-xs font-medium text-black transition-colors hover:bg-sf-accent/90"
                >
                  Move Clips
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {durationDeltaDialogOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              closeDurationDeltaDialog()
            }
          }}
        >
          <div className="w-full max-w-sm rounded-lg border border-sf-dark-600 bg-sf-dark-800 shadow-2xl">
            <div className="border-b border-sf-dark-700 px-4 py-3">
              <h3 className="text-sm font-medium text-sf-text-primary">Change Clip Duration</h3>
              <p className="mt-1 text-xs text-sf-text-muted">
                Adjust the right edge of {selectedClipIds.length} selected clip{selectedClipIds.length === 1 ? '' : 's'} by an exact signed amount.
              </p>
            </div>

            <form
              className="space-y-3 px-4 py-3"
              onSubmit={(e) => {
                e.preventDefault()
                applyDurationDelta()
              }}
            >
              <div className="flex items-center gap-1 rounded bg-sf-dark-900 p-1">
                <button
                  type="button"
                  onClick={() => {
                    setDurationDeltaMode('timecode')
                    setDurationDeltaError('')
                  }}
                  className={`rounded px-2.5 py-1 text-xs transition-colors ${
                    durationDeltaMode === 'timecode'
                      ? 'bg-sf-accent text-black'
                      : 'text-sf-text-secondary hover:bg-sf-dark-700'
                  }`}
                >
                  Timecode
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDurationDeltaMode('frames')
                    setDurationDeltaError('')
                  }}
                  className={`rounded px-2.5 py-1 text-xs transition-colors ${
                    durationDeltaMode === 'frames'
                      ? 'bg-sf-accent text-black'
                      : 'text-sf-text-secondary hover:bg-sf-dark-700'
                  }`}
                >
                  Frames
                </button>
              </div>

              <div>
                <label htmlFor="duration-delta-input" className="mb-1 block text-[11px] uppercase tracking-wider text-sf-text-muted">
                  {durationDeltaMode === 'frames' ? 'Frames' : 'Amount'}
                </label>
                <input
                  id="duration-delta-input"
                  ref={durationDeltaInputRef}
                  type="text"
                  inputMode={durationDeltaMode === 'frames' ? 'numeric' : 'text'}
                  value={durationDeltaMode === 'frames' ? durationDeltaFramesInput : durationDeltaInput}
                  onChange={(e) => {
                    if (durationDeltaMode === 'frames') {
                      setDurationDeltaFramesInput(sanitizeFrameOffsetInput(e.target.value))
                    } else {
                      setDurationDeltaInput(sanitizeTimelineOffsetInput(e.target.value))
                    }
                    if (durationDeltaError) setDurationDeltaError('')
                  }}
                  placeholder={durationDeltaMode === 'frames' ? '+12' : '+00:00:00:12'}
                  className="w-full rounded border border-sf-dark-600 bg-sf-dark-700 px-3 py-2 font-mono text-sm text-sf-text-primary focus:border-sf-accent focus:outline-none"
                />
                <p className="mt-1 text-[11px] text-sf-text-muted">
                  {durationDeltaMode === 'frames'
                    ? <>Use signed whole frames like <span className="font-mono">+12</span> or <span className="font-mono">-8</span>.</>
                    : <>Use signed timecode like <span className="font-mono">+00:00:00:12</span> or seconds like <span className="font-mono">-0.5</span>.</>}
                </p>
              </div>

              {!durationDeltaError && (
                <p className="text-xs text-sf-text-secondary">
                  {(() => {
                    const parsed = durationDeltaMode === 'frames'
                      ? parseFrameOffsetInput(durationDeltaFramesInput, timecodeFps)
                      : parseTimelineOffsetInput(durationDeltaInput, timecodeFps)
                    if (!parsed.success) return `Timeline FPS: ${Math.round(timecodeFps)}`
                    const sign = parsed.seconds < 0 ? '-' : '+'
                    const frameCount = Math.round(Math.abs(parsed.seconds) * Math.max(1, Math.round(timecodeFps)))
                    if (durationDeltaMode === 'frames') {
                      return `Parsed change: ${sign}${frameCount} frames (${sign}${formatFrameTimecode(Math.abs(parsed.seconds), timecodeFps)})`
                    }
                    return `Parsed change: ${sign}${formatFrameTimecode(Math.abs(parsed.seconds), timecodeFps)} (${sign}${frameCount} frames)`
                  })()}
                </p>
              )}

              {durationDeltaError && (
                <p className="text-xs text-sf-error">{durationDeltaError}</p>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={closeDurationDeltaDialog}
                  className="rounded bg-sf-dark-700 px-3 py-1.5 text-xs text-sf-text-secondary transition-colors hover:bg-sf-dark-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded bg-sf-accent px-3 py-1.5 text-xs font-medium text-black transition-colors hover:bg-sf-accent/90"
                >
                  Change Duration
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <CaptionWorkspace
        isOpen={Boolean(captionWorkspaceSession)}
        asset={captionWorkspaceSession?.asset || null}
        scope={captionWorkspaceSession?.scope || 'timeline'}
        hasExistingTimelineCaptions={clips.some((clip) => {
          if (!clip || !clip.assetId) return false
          return getAssetById(clip.assetId)?.settings?.captionScope === 'timeline'
        })}
        seedFromClipId={captionWorkspaceSession?.seedFromClipId || null}
        timelineCaptionSidecarPath={(() => {
          for (const clip of clips) {
            if (!clip?.assetId) continue
            const clipAsset = getAssetById(clip.assetId)
            if (clipAsset?.settings?.captionScope === 'timeline' && clipAsset.settings.captionTranscriptPath) {
              return clipAsset.settings.captionTranscriptPath
            }
          }
          return null
        })()}
        currentProjectHandle={currentProjectHandle}
        timelineSize={(() => {
          const s = useProjectStore.getState().getCurrentTimelineSettings?.()
          return s
            ? { width: s.width, height: s.height, fps: s.fps }
            : { width: 1920, height: 1080, fps: 24 }
        })()}
        folders={folders}
        addFolder={addFolder}
        addAsset={addAsset}
        updateAsset={updateAsset}
        onPlaceOnTimeline={(captionAsset) => (
          captionWorkspaceSession?.scope === 'asset'
            ? handlePlaceAssetCaptionOnTimeline(captionAsset, captionWorkspaceSession?.replaceClipId)
            : handlePlaceTimelineCaptionOnTimeline(captionAsset)
        )}
        onClose={() => setCaptionWorkspaceSession(null)}
      />
    </div>
  )
}

export default Timeline
