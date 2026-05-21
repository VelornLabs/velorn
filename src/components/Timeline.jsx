import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react'
import {
  Volume2, VolumeX, Lock, Unlock, Link, Unlink, Eye, EyeOff,
  Plus, Video, Type, Image as ImageIcon,
  Sparkles, GripVertical, Magnet, ArrowRightLeft, Square, X, Check, Pencil,
  Diamond, Zap, AlertTriangle, Loader2, ChevronLeft, ChevronRight, Maximize2, Flag, Scissors, Clock,
  Copy, ClipboardPaste, Trash2,
} from 'lucide-react'
import useTimelineStore, { buildClipSyncLock, isMusicVideoSyncCapableClip, isSyncLockedClip } from '../stores/timelineStore'
import useProjectStore from '../stores/projectStore'
import renderCacheService from '../services/renderCache'
import { deleteRenderCache } from '../services/fileSystem'
import { clearDiskCacheUrl } from './VideoLayerRenderer'
import useAssetsStore from '../stores/assetsStore'
import CaptionWorkspace from './CaptionWorkspace'
import { useSnapping, SNAP_TYPES } from '../hooks/useSnapping'
import useViewportClampedPosition from '../hooks/useViewportClampedPosition'
import { getAllKeyframeTimes } from '../utils/keyframes'
import { TRANSITION_TYPES, TRANSITION_DURATIONS, FRAME_RATE } from '../constants/transitions'
import { getAudioClipFadeValues } from '../utils/audioClipFades'
import { getSpriteFramePosition } from '../services/thumbnailSprites'
import { getEffectTypeDefinition } from '../utils/effects'
import { isTextEditingElement } from '../utils/keyboardFocus'
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

const TRANSITION_DEFAULT_DURATION_KEY = 'comfystudio-transition-default-duration-frames'
const DEFAULT_WAVEFORM_SAMPLES = 8192
const MARQUEE_DRAG_THRESHOLD_PX = 6
const MARQUEE_AUTO_SCROLL_EDGE_PX = 32
const MARQUEE_AUTO_SCROLL_STEP_PX = 24
const PLAYHEAD_SCRUB_AUTO_SCROLL_EDGE_PX = 40
const PLAYHEAD_SCRUB_AUTO_SCROLL_MAX_STEP_PX = 28
const MIN_INTERACTIVE_CLIP_WIDTH_PX = 24
const TIMELINE_VIDEO_THUMB_WIDTH_PX = 90
const MAX_TIMELINE_VIDEO_THUMBNAILS = 12

// Resolve-style audio track/waveform colors
const AUDIO_TRACK_BG = '#2d4038'
const AUDIO_WAVEFORM_FILL = 'rgba(238, 255, 249, 0.94)'
const AUDIO_WAVEFORM_CENTER_LINE = 'rgba(255,255,255,0.32)'
const AUDIO_CLIP_ACCENT = '#4a6b5c'
const ADJACENT_CLIP_UI_GAP_SECONDS = 0.5
const ROLL_EDIT_MAX_GAP_SECONDS = 1 / FRAME_RATE
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
})
const TIMELINE_TOOL_LABELS = Object.freeze({
  [TIMELINE_TOOLS.AUTO]: 'Auto tool',
  [TIMELINE_TOOLS.SELECT]: 'Move tool',
  [TIMELINE_TOOLS.TRIM]: 'Trim tool',
  [TIMELINE_TOOLS.RAZOR]: 'Razor tool',
  [TIMELINE_TOOLS.SLIP]: 'Slip tool',
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
  if (clip.type === 'image' || clip.type === 'adjustment' || clip.type === 'text') return Infinity
  const raw = clip.sourceDuration
  if (raw === Infinity || raw === 'Infinity') return Infinity
  const parsed = Number(raw)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  const fallbackTrimEnd = Number(clip.trimEnd)
  return Number.isFinite(fallbackTrimEnd) && fallbackTrimEnd > 0 ? fallbackTrimEnd : null
}

const isInfinitelyExtendableClip = (clip) => (
  clip?.type === 'image' || clip?.type === 'adjustment' || clip?.type === 'text'
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
  const channelCount = Math.max(1, audioBuffer.numberOfChannels || 1)
  const totalSamples = Math.max(1, audioBuffer.length || 1)
  const buckets = Math.max(32, sampleCount)
  const bucketSize = Math.max(1, Math.floor(totalSamples / buckets))
  const peaks = new Float32Array(buckets)

  for (let i = 0; i < buckets; i++) {
    const start = i * bucketSize
    const end = i === buckets - 1 ? totalSamples : Math.min(totalSamples, start + bucketSize)
    const span = Math.max(1, end - start)
    const stride = Math.max(1, Math.floor(span / 64))
    let peak = 0

    for (let channel = 0; channel < channelCount; channel++) {
      const data = audioBuffer.getChannelData(channel)
      for (let s = start; s < end; s += stride) {
        const amp = Math.abs(data[s] || 0)
        if (amp > peak) peak = amp
      }
    }
    peaks[i] = peak
  }

  let maxPeak = 0
  for (let i = 0; i < peaks.length; i++) {
    if (peaks[i] > maxPeak) maxPeak = peaks[i]
  }
  if (maxPeak > 0) {
    for (let i = 0; i < peaks.length; i++) {
      peaks[i] = peaks[i] / maxPeak
    }
  }

  return peaks
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
    const peaks = buildWaveformPeaks(audioBuffer, sampleCount)
    return { peaks, duration: audioBuffer.duration || 0 }
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

function AudioWaveformBars({ clip, clipWidth, clipUrl, waveformInput = null }) {
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

  const amplitudePixels = useMemo(() => {
    if (!waveform?.peaks?.length) return null

    const peaks = waveform.peaks
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
      out[i] = Math.max(0.015, Math.min(1, peak))
    }
    return out
  }, [waveform, clip.sourceDuration, clip.trimStart, clip.trimEnd, clip.reverse, pixelCount])

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

    const centerY = h / 2
    const halfH = (h / 2) * 0.88
    const n = amplitudePixels ? amplitudePixels.length : 0

    if (n > 0) {
      ctx.strokeStyle = AUDIO_WAVEFORM_FILL
      ctx.lineWidth = 1
      ctx.lineCap = 'butt'
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const x = ((i + 0.5) / n) * w
        const amp = amplitudePixels[i] ?? 0.1
        const y1 = centerY - amp * halfH
        const y2 = centerY + amp * halfH
        ctx.moveTo(x, y1)
        ctx.lineTo(x, y2)
      }
      ctx.stroke()
    }

    ctx.strokeStyle = AUDIO_WAVEFORM_CENTER_LINE
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, centerY)
    ctx.lineTo(w, centerY)
    ctx.stroke()
  }, [containerSize, amplitudePixels])

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

function Timeline({ onOpenAudioGenerate, onActiveToolChange }) {
  const timelineRef = useRef(null)
  const trackHeadersRef = useRef(null)
  const trackContentRef = useRef(null)
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

  const getDefaultTrackHeight = (track) => {
    if (!track) return VIDEO_TRACK_HEIGHT_DEFAULT
    if (track.type === 'video') return VIDEO_TRACK_HEIGHT_DEFAULT
    return track.channels === 'mono' ? AUDIO_TRACK_HEIGHT_MONO_DEFAULT : AUDIO_TRACK_HEIGHT_STEREO_DEFAULT
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
  const [slipState, setSlipState] = useState(null) // { clipId, startX, startTrimStart, startTrimEnd, timeScale, minSourceDelta, maxSourceDelta }
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

  const getTimeScale = (clip) => {
    if (!clip) return 1
    const baseScale = clip.sourceTimeScale
      || (clip.timelineFps && clip.sourceFps ? clip.timelineFps / clip.sourceFps : 1)
    const speed = Number(clip.speed)
    const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
    return baseScale * speedScale
  }

  const getSourceDuration = (clip) => {
    if (!clip) return Infinity
    const raw = clip.sourceDuration
    if (raw === Infinity || raw === 'Infinity') return Infinity
    if (raw === null || raw === undefined || raw === '') return Infinity
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Infinity
  }
  
  // Scrubbing state (for dragging playhead)
  const [isScrubbing, setIsScrubbing] = useState(false)
  
  // Clip dragging state (moving clips within timeline)
  const [clipDragState, setClipDragState] = useState(null) // { clipId, startX, originalStartTime, originalTrackId }
  const clipDragHistorySavedRef = useRef(false)
  
  // Marquee selection state
  const [marqueeState, setMarqueeState] = useState(null) // { startX, startY, currentX, currentY, scrollLeft, scrollTop }
  const [pendingLanePointerState, setPendingLanePointerState] = useState(null) // Click on empty lane; becomes gap selection or marquee after drag threshold
  
  // Transition type menu state
  const [transitionMenu, setTransitionMenu] = useState(null) // { x, y, clipA, clipB }
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
  const [rollEditState, setRollEditState] = useState(null) // { clipAId, clipBId, startX, originalEditPoint, clipAOriginalDuration, clipBOriginalStart, clipBOriginalDuration, clipAOriginalTrimStart, clipASourceDuration, clipATimeScale, clipBOriginalTrimStart, clipBOriginalTrimEnd, clipBTimeScale }
  
  // Spacebar panning state
  const [isPanning, setIsPanning] = useState(false)
  const [panStart, setPanStart] = useState(null) // { x, y, scrollLeft, scrollTop }
  const [isSpaceHeld, setIsSpaceHeld] = useState(false)
  const spacePanningKeyDownRef = useRef(false)
  
  // Transition types and durations are defined in constants/transitions
  
  // Clip context menu state
  const [clipContextMenu, setClipContextMenu] = useState(null) // { x, y, clipId }
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
    playheadPosition,
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
    markers,
    selectedMarkerId,
    addClip,
    addTextClip,
    removeClip,
    removeSelectedClips,
    rippleDeleteClipIds,
    rippleDeleteSelectedClips,
    rippleDeleteSelectedGap,
    moveClip,
    moveSelectedClips,
    setSelectedClipsStartTimes,
    setSelectedClipPositions,
    resizeClip,
    updateClipTrim,
    updateAudioClipProperties,
    selectClip,
    selectClips,
    clearSelection,
    setPlayheadPosition,
    setZoom,
    toggleTrackMute,
    toggleTrackLock,
    toggleTrackVisibility,
    setClipsEnabled,
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
  } = useTimelineStore()

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
  const { assets, currentPreview, setPreviewMode, getAssetUrl, getAssetById, updateAsset, isPlaying: assetIsPlaying, setIsPlaying: setAssetIsPlaying, folders, addFolder, addAsset, removeAsset } = useAssetsStore()
  const timelineFps = getCurrentTimelineSettings()?.fps
  const timecodeFps = Number.isFinite(Number(timelineFps)) && Number(timelineFps) > 0
    ? Number(timelineFps)
    : FRAME_RATE
  const projectCanUndo = canUndoTimelineStructureChange()
  const projectCanRedo = canRedoTimelineStructureChange()
  const timelineHistoryLastChangedAt = useTimelineStore((state) => state.historyLastChangedAt)
  const timelineIsPlaying = useTimelineStore((state) => state.isPlaying)
  const preferredVideoTrack = useMemo(() => {
    const activeVideoTrack = tracks.find((track) => track.id === activeTrackId && track.type === 'video')
    if (activeVideoTrack) return activeVideoTrack
    return tracks.find((track) => track.type === 'video') || null
  }, [tracks, activeTrackId])
  const addTextClipAtPlayhead = useCallback((options = {}) => {
    const targetTrack = preferredVideoTrack
    if (!targetTrack) return null

    const newClip = addTextClip(targetTrack.id, options, playheadPosition)
    if (newClip) {
      requestTextEdit(newClip.id, { selectAll: true })
    }
    return newClip
  }, [preferredVideoTrack, addTextClip, playheadPosition, requestTextEdit])
  const handleUndoAction = useCallback(() => {
    if (projectCanUndo && (!canUndo() || projectHistoryLastChangedAt > timelineHistoryLastChangedAt)) {
      return undoTimelineStructureChange()
    }
    return undo()
  }, [projectCanUndo, canUndo, projectHistoryLastChangedAt, timelineHistoryLastChangedAt, undoTimelineStructureChange, undo])
  const handleRedoAction = useCallback(() => {
    if (projectCanRedo && (!canRedo() || projectHistoryLastChangedAt > timelineHistoryLastChangedAt)) {
      return redoTimelineStructureChange()
    }
    return redo()
  }, [projectCanRedo, canRedo, projectHistoryLastChangedAt, timelineHistoryLastChangedAt, redoTimelineStructureChange, redo])
  const markerHotkeyLabel = formatEditorHotkey(editorHotkeys[EDITOR_HOTKEY_IDS.ADD_MARKER])
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
  const isMacPlatform = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || '')
  const copyHotkeyLabel = `${isMacPlatform ? 'Cmd' : 'Ctrl'}+C`
  const pasteHotkeyLabel = `${isMacPlatform ? 'Cmd' : 'Ctrl'}+V`
  const durationByHotkeyHint = durationByHotkeyLabel === 'Not set' ? '' : durationByHotkeyLabel
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
  const clipContextCanLink = clipContextSelectionClips.length > 1 && !(
    clipContextLinkedGroupIds.length === 1 &&
    clipContextSelectionClips.every((clip) => clip.linkGroupId === clipContextLinkedGroupIds[0])
  )
  const clipContextCanUnlink = clipContextLinkedGroupIds.length > 0
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

  const setClipSelectionEnabled = useCallback((clipIds, enabled) => {
    if (!Array.isArray(clipIds) || clipIds.length === 0) return
    setClipsEnabled(clipIds, enabled)
  }, [setClipsEnabled])

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
  const activeTrackClipAtPlayhead = useMemo(() => {
    if (!activeTrackId) return null
    return clips.find(
      (clip) => clip.trackId === activeTrackId
        && playheadPosition > clip.startTime
        && playheadPosition < clip.startTime + clip.duration
    ) || null
  }, [activeTrackId, clips, playheadPosition])
  const canDeleteCurrentSelection = selectedClipIds.length > 0
    || Boolean(selectedGap)
    || Boolean(selectedTransitionId)
    || Boolean(selectedMarkerId)

  const handleDeleteCurrentSelection = useCallback(() => {
    if (selectedClipIds.length > 0) {
      if (rippleEditMode) {
        rippleDeleteSelectedClips()
      } else {
        removeSelectedClips()
      }
      return true
    }
    if (selectedGap) {
      rippleDeleteSelectedGap()
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
    copySelectedClips()
    return true
  }, [copySelectedClips, selectedClipIds])

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
      title: 'Smart edit tool: drag clip centers to move, drag clip edges to trim.',
    },
    {
      id: TIMELINE_TOOLS.SELECT,
      label: 'Move',
      shortcut: 'V',
      icon: ArrowRightLeft,
      title: 'Move/select clips only. Use Auto to trim from clip edges without switching tools.',
    },
    {
      id: TIMELINE_TOOLS.TRIM,
      label: 'Trim',
      shortcut: 'T',
      icon: Square,
      title: 'Trim clip heads/tails from their edges.',
    },
    {
      id: TIMELINE_TOOLS.RAZOR,
      label: 'Razor',
      shortcut: 'B',
      icon: Scissors,
      title: 'Click any clip to split it at the cursor.',
    },
    {
      id: TIMELINE_TOOLS.SLIP,
      label: 'Slip',
      shortcut: 'Y',
      icon: ArrowRightLeft,
      title: 'Drag inside a video/audio clip to slip source timing without moving it.',
    },
  ]), [])
  
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

  // Timeline-wide caption workspace state. We mount CaptionWorkspace at the
  // timeline level (rather than per-asset in AssetsPanel) so captions can span
  // the whole edited program. The `virtualTimelineAsset` is a lightweight
  // stand-in that gives CaptionWorkspace enough shape (id/name/duration) to
  // render without tying the overlay to any single source clip.
  const [timelineCaptionWorkspaceAsset, setTimelineCaptionWorkspaceAsset] = useState(null)
  const handlePasteAtPlayhead = useCallback(() => {
    if (!activeTrackId || copiedClips.length === 0) return false
    pasteClipsAtPlayhead(activeTrackId, playheadPosition, assets)
    return true
  }, [activeTrackId, assets, copiedClips, pasteClipsAtPlayhead, playheadPosition])
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
    if (clip.type === 'text') return null
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
    addAdjustmentClip(targetTrack.id, playheadPosition, { duration: 5 })
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

  const handleOpenTimelineCaptions = () => {
    const programDuration = computeProgramDuration()
    if (programDuration <= 0) {
      alert('Add some clips to the timeline before captioning.')
      return
    }

    // If a timeline caption overlay already exists (tagged via captionScope),
    // let the user decide whether to replace it. The actual replacement
    // happens inside handlePlaceTimelineCaptionOnTimeline once the new
    // overlay asset has been generated.
    const existingTimelineCaptionClip = clips.find((clip) => {
      if (!clip || !clip.assetId) return false
      const asset = getAssetById(clip.assetId)
      return asset?.settings?.captionScope === 'timeline'
    })

    if (existingTimelineCaptionClip) {
      const confirmed = window.confirm(
        'This project already has timeline captions. Replace them with a fresh transcription?\n\n'
        + 'Your existing caption track will be deleted before the new one is added.'
      )
      if (!confirmed) return
    }

    setTimelineCaptionWorkspaceAsset({
      id: `timeline-mix-${Date.now()}`,
      name: 'Timeline',
      type: 'timeline',
      duration: programDuration,
      hasAudio: true,
    })
  }

  // After the user has generated a caption overlay for the timeline, insert a
  // brand-new video track above everything else and drop the overlay at t=0
  // for the full program duration. Also removes any prior timeline-caption
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

    // Fresh top-of-stack video track. addTrack('video') already prepends to
    // the video track list, so new tracks appear visually above existing ones.
    const newTrack = state.addTrack('video')
    if (!newTrack) return

    const programDuration = Math.max(
      Number(captionAsset.duration) || 0,
      Number(captionAsset.settings?.duration) || 0,
      1
    )

    state.addClip(newTrack.id, captionAsset, 0, state.timelineFps, {
      duration: programDuration,
      trimStart: 0,
      trimEnd: programDuration,
    })
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

  // Zoom with playhead as pivot so the timeline zooms into/out of the playhead position
  const applyZoomWithPlayheadPivot = useCallback((newZoomValue) => {
    const clamped = Math.max(20, Math.min(2000, newZoomValue))
    if (clamped === zoom) return
    if (!timelineRef.current) {
      setZoom(clamped)
      return
    }
    const scrollLeft = timelineRef.current.scrollLeft
    const playheadViewportX = playheadPosition * pixelsPerSecond - scrollLeft
    setZoom(clamped)
    const newPixelsPerSecond = clamped / 5
    requestAnimationFrame(() => {
      if (timelineRef.current) {
        const el = timelineRef.current
        const newScrollLeft = playheadPosition * newPixelsPerSecond - playheadViewportX
        el.scrollLeft = Math.max(0, Math.min(newScrollLeft, el.scrollWidth - el.clientWidth))
      }
    })
  }, [pixelsPerSecond, playheadPosition, setZoom, zoom])

  // Frame all: fit full timeline or all clips in view
  const handleFrameAll = () => {
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
    const newZoom = Math.max(20, Math.min(2000, (5 * visibleWidth * padding) / timeSpan))
    setZoom(newZoom)
    const newPixelsPerSecond = newZoom / 5
    requestAnimationFrame(() => {
      if (timelineRef.current) {
        timelineRef.current.scrollLeft = Math.max(0, startTime * newPixelsPerSecond)
      }
    })
  }

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

  function getPlayheadScrubAutoScrollDelta(clientX) {
    if (!timelineRef.current) return 0
    const rect = timelineRef.current.getBoundingClientRect()
    const rightThreshold = rect.right - PLAYHEAD_SCRUB_AUTO_SCROLL_EDGE_PX
    const leftThreshold = rect.left + PLAYHEAD_SCRUB_AUTO_SCROLL_EDGE_PX

    if (clientX >= rightThreshold) {
      const intensity = Math.min(1.5, Math.max(0.2, (clientX - rightThreshold) / PLAYHEAD_SCRUB_AUTO_SCROLL_EDGE_PX))
      return Math.round(PLAYHEAD_SCRUB_AUTO_SCROLL_MAX_STEP_PX * intensity)
    }

    if (clientX <= leftThreshold) {
      const intensity = Math.min(1.5, Math.max(0.2, (leftThreshold - clientX) / PLAYHEAD_SCRUB_AUTO_SCROLL_EDGE_PX))
      return -Math.round(PLAYHEAD_SCRUB_AUTO_SCROLL_MAX_STEP_PX * intensity)
    }

    return 0
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

  const handleTimelineRulerMouseDown = (e) => {
    if (e.button !== 0 || e.target.closest('[data-marker-handle]')) return
    e.stopPropagation()

    if (spacePanningKeyDownRef.current) {
      startTimelinePanning(e)
      return
    }

    e.preventDefault()
    startTimelinePreview()
    setIsScrubbing(true)
    setPlayheadPosition(getTimeFromMouseEvent(e), { snap: true })
  }

  // Handle scrubbing mouse move and mouse up
  useEffect(() => {
    if (!isScrubbing) return

    let latestClientX = null
    let scrubAutoScrollRaf = null

    const stopAutoScroll = () => {
      if (scrubAutoScrollRaf !== null) {
        cancelAnimationFrame(scrubAutoScrollRaf)
        scrubAutoScrollRaf = null
      }
    }

    const syncScrubPosition = (clientX) => {
      if (!timelineRef.current) return false
      const scrollEl = timelineRef.current
      const previousScrollLeft = scrollEl.scrollLeft
      const maxScrollLeft = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth)
      const scrollDelta = getPlayheadScrubAutoScrollDelta(clientX)
      if (scrollDelta !== 0) {
        scrollEl.scrollLeft = Math.max(0, Math.min(maxScrollLeft, previousScrollLeft + scrollDelta))
      }
        setPlayheadPosition(getTimeFromClientX(clientX), { snap: true })
      return scrollEl.scrollLeft !== previousScrollLeft
    }

    const tickAutoScroll = () => {
      if (latestClientX == null) {
        scrubAutoScrollRaf = null
        return
      }
      const didScroll = syncScrubPosition(latestClientX)
      if (didScroll && getPlayheadScrubAutoScrollDelta(latestClientX) !== 0) {
        scrubAutoScrollRaf = requestAnimationFrame(tickAutoScroll)
      } else {
        scrubAutoScrollRaf = null
      }
    }

    const ensureAutoScroll = () => {
      if (scrubAutoScrollRaf !== null) return
      if (latestClientX == null) return
      if (getPlayheadScrubAutoScrollDelta(latestClientX) === 0) return
      scrubAutoScrollRaf = requestAnimationFrame(tickAutoScroll)
    }

    const handleMouseMove = (e) => {
      latestClientX = e.clientX
      syncScrubPosition(e.clientX)
      ensureAutoScroll()
    }

    const handleMouseUp = () => {
      stopAutoScroll()
      setIsScrubbing(false)
    }

    // Add listeners to window so dragging works even outside the timeline
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      stopAutoScroll()
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isScrubbing, pixelsPerSecond, duration, timecodeFps, setPlayheadPosition])

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
    const clipsToSelect = clips
      .filter(c => (c.startTime + c.duration) > playheadPosition)
      .map(c => c.id)

    useTimelineStore.getState().selectClips(clipsToSelect)
    selectMarker(null)
  }, [clips, playheadPosition, selectMarker])

  const selectClipsFromTimelineStartToPlayhead = useCallback(() => {
    const clipsToSelect = clips
      .filter(c => c.startTime <= playheadPosition)
      .map(c => c.id)

    useTimelineStore.getState().selectClips(clipsToSelect)
    selectMarker(null)
  }, [clips, playheadPosition, selectMarker])

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

    getEditorHotkeys().then((next) => {
      if (isMounted) setEditorHotkeys(next)
    }).catch(() => {
      if (isMounted) setEditorHotkeys(DEFAULT_EDITOR_HOTKEYS)
    })

    const handleHotkeysChanged = (event) => {
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

  const splitClipAtTime = useCallback((clip, splitPosition, { saveHistory = false } = {}) => {
    if (!clip || isSyncLockedClip(clip) || splitPosition <= clip.startTime || splitPosition >= clip.startTime + clip.duration) return null

    const splitTime = splitPosition - clip.startTime
    const remainder = clip.duration - splitTime

    let asset = null
    if (clip.type !== 'text' && clip.type !== 'adjustment') {
      asset = assets.find(a => a.id === clip.assetId)
      if (!asset) return null
    }

    if (saveHistory) {
      saveToHistory()
    }

    resizeClip(clip.id, splitTime)

    if (clip.type === 'text') {
      const textOptions = {
        ...(clip.textProperties || {}),
        duration: remainder,
        enabled: isClipEnabled(clip),
        saveHistory: false,
      }
      return addTextClip(clip.trackId, textOptions, splitPosition)
    }

    if (clip.type === 'adjustment') {
      return addAdjustmentClip(clip.trackId, splitPosition, {
        duration: remainder,
        name: clip.name,
        adjustments: clip.adjustments || {},
        transform: clip.transform || {},
        enabled: isClipEnabled(clip),
        saveHistory: false,
      })
    }

    const timeScale = getTimeScale(clip)
    const sourceTimeAtCut = (clip.trimStart || 0) + splitTime * timeScale
    const sourceTrimEnd = sourceTimeAtCut + remainder * timeScale

    return addClip(clip.trackId, asset, splitPosition, timelineFps, {
      duration: remainder,
      trimStart: sourceTimeAtCut,
      trimEnd: sourceTrimEnd,
      enabled: isClipEnabled(clip),
      ...(clip.type === 'audio'
        ? {
            gainDb: clip.gainDb,
          }
        : {}),
      saveHistory: false,
    })
  }, [assets, saveToHistory, resizeClip, addTextClip, addAdjustmentClip, addClip, timelineFps, isClipEnabled])

  const splitAllTracksAtPlayhead = useCallback(() => {
    const clipsToSplit = clips.filter(
      c => playheadPosition > c.startTime && playheadPosition < c.startTime + c.duration
    )

    if (clipsToSplit.length === 0) return

    saveToHistory()

    const newClipIds = []
    clipsToSplit.forEach((clip) => {
      const newClip = splitClipAtTime(clip, playheadPosition, { saveHistory: false })
      if (newClip?.id) {
        newClipIds.push(newClip.id)
      }
    })

    if (newClipIds.length > 0) {
      useTimelineStore.getState().selectClips(newClipIds)
      selectMarker(null)
    }
  }, [clips, playheadPosition, saveToHistory, splitClipAtTime, selectMarker])

  const handleSplitClipAtPlayhead = useCallback((clip) => {
    if (!clip) return false
    splitClipAtTime(clip, playheadPosition, { saveHistory: true })
    return true
  }, [playheadPosition, splitClipAtTime])

  const handleSplitActiveTrackAtPlayhead = useCallback(() => (
    handleSplitClipAtPlayhead(activeTrackClipAtPlayhead)
  ), [activeTrackClipAtPlayhead, handleSplitClipAtPlayhead])

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
  }, [ensureTimelineTimeVisible, playheadPosition, setPlayheadPosition, visibleClipBoundaryTimes])

  const jumpPlayheadToMarker = useCallback((direction) => {
    if (!Number.isFinite(direction) || direction === 0 || markerNavigationTargets.length === 0) return false

    const epsilon = 0.0001
    let targetMarker = null

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
  }, [ensureTimelineTimeVisible, markerNavigationTargets, playheadPosition, selectMarker, setPlayheadPosition])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      const key = String(e.key || '').toLowerCase()

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
        if (selectedClipIds.length > 1) {
          e.preventDefault()
          linkSelectedClips()
        }
        return
      }

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.UNLINK_SELECTION])) {
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
        addMarker(playheadPosition)
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

      if (matchEditorHotkey(e, editorHotkeys[EDITOR_HOTKEY_IDS.SPLIT_ACTIVE]) && activeTrackId) {
        if (activeTrackClipAtPlayhead) {
          e.preventDefault()
          handleSplitActiveTrackAtPlayhead()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [toggleSnapping, toggleRippleEdit, addMarker, selectedClipIds, selectedGap, selectedTransitionId, selectedMarkerId, removeSelectedClips, rippleDeleteSelectedClips, rippleDeleteSelectedGap, removeTransition, removeMarker, clearSelection, selectMarker, clips, handleUndoAction, handleRedoAction, activeTrackId, playheadPosition, saveToHistory, resizeClip, addClip, addTextClip, addTextClipAtPlayhead, addAdjustmentClip, updateClipTrim, assets, timelineFps, copySelectedClips, pasteClipsAtPlayhead, copiedClips, selectClipsFromPlayheadToEnd, selectClipsFromTimelineStartToPlayhead, splitClipAtTime, splitAllTracksAtPlayhead, openMoveOffsetDialog, openDurationDeltaDialog, moveOffsetDialogOpen, durationDeltaDialogOpen, editorHotkeys, linkSelectedClips, unlinkSelectedClips, lockSyncClips, unlockSyncLockedClips, toggleClipSelectionEnabled, applyZoomWithPlayheadPivot, zoom, rippleEditMode, activeTrackClipAtPlayhead, canDeleteCurrentSelection, handleCopySelection, handleDeleteCurrentSelection, handlePasteAtPlayhead, handleSplitActiveTrackAtPlayhead, jumpPlayheadToClipBoundary, jumpPlayheadToMarker, clipContextSyncEligibleClips, clipContextSyncLockByClipId, clipContextAllSyncLocked])

  // Spacebar panning key state (dedicated listeners so keyup cannot get "stuck")
  useEffect(() => {
    const resetSpacePanningState = () => {
      spacePanningKeyDownRef.current = false
      setIsSpaceHeld(false)
      setIsPanning(false)
      setPanStart(null)
    }

    const handleSpaceKeyDown = (e) => {
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
      const newZoom = Math.max(20, Math.min(2000, zoom + zoomDelta))
      setZoom(newZoom)
      
      // Calculate new pixels per second
      const newPixelsPerSecond = newZoom / 5
      
      // Adjust scroll to keep the time position under the mouse
      const newScrollLeft = (timeAtMouse * newPixelsPerSecond) - mouseX
      
      // Apply scroll adjustment after a tiny delay to let the zoom render
      requestAnimationFrame(() => {
        if (timelineRef.current) {
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
  }, [pixelsPerSecond, zoom, setZoom])

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

  useEffect(() => {
    if (!timelineRef.current || !timelineIsPlaying) return

    ensureTimelineTimeVisible(playheadPosition)
  }, [ensureTimelineTimeVisible, playheadPosition, timelineIsPlaying])

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
  const handleContextMenuAction = (action) => {
    const clip = clips.find(c => c.id === clipContextMenu?.clipId)
    if (!clip) return
    
    switch (action) {
      case 'add-mask':
        if (!(clip.type === 'video' || clip.type === 'image')) break
        // Ensure single selection on this clip
        selectClip(clip.id)
        requestMaskPicker(clip.id, { openPicker: true })
        break
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
          const textOptions = { ...(clip.textProperties || {}), duration: clip.duration, enabled: isClipEnabled(clip) }
          addTextClip(clip.trackId, textOptions, clip.startTime + clip.duration + 0.1)
        } else if (clip.type === 'adjustment') {
          addAdjustmentClip(clip.trackId, clip.startTime + clip.duration + 0.1, {
            duration: clip.duration,
            name: clip.name,
            adjustments: clip.adjustments || {},
            transform: clip.transform || {},
            enabled: isClipEnabled(clip),
          })
        } else {
          const asset = assets.find(a => a.id === clip.assetId)
          if (asset) {
            addClip(clip.trackId, asset, clip.startTime + clip.duration + 0.1, timelineFps, {
              enabled: isClipEnabled(clip),
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
  const handleTrimStart = (e, clipId, edge) => {
    e.stopPropagation()
    e.preventDefault()
    
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
    if (rollEditState) setRollEditState(null)
    if (slipState) setSlipState(null)
    if (fadeDragState) setFadeDragState(null)
    clearActiveSnap()
    
    // Save to history before trimming starts
    saveToHistory()
    
    const timeScale = getTimeScale(clip)
    const startTrimEnd = clip.trimEnd ?? clip.sourceDuration ?? ((clip.trimStart || 0) + clip.duration * timeScale)

    setTrimState({
      clipId,
      edge,
      startX: e.clientX,
      startTime: clip.startTime,
      startDuration: clip.duration,
      startTrimStart: clip.trimStart || 0,
      startTrimEnd: startTrimEnd,
    })
    
    selectClip(clipId)
  }

  const handleFadeDragStart = (e, clip, edge) => {
    e.stopPropagation()
    e.preventDefault()

    if (!clip || clip.type !== 'audio') return

    if (clipDragState) setClipDragState(null)
    if (transitionDragState) setTransitionDragState(null)
    if (rollEditState) setRollEditState(null)
    if (slipState) setSlipState(null)
    if (trimState) setTrimState(null)
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

  // Handle trim move (mousemove when trimming)
  useEffect(() => {
    if (!trimState) return
    
    const handleMouseMove = (e) => {
      const deltaX = e.clientX - trimState.startX
      const deltaTime = deltaX / pixelsPerSecond
      
      const clip = clips.find(c => c.id === trimState.clipId)
      if (!clip) return
      const timeScale = getTimeScale(clip)
      
      // Find neighboring clips on the same track to prevent trimming past them
      const trackClips = clips.filter(c => c.trackId === clip.trackId && c.id !== clip.id)
      
      // Find the clip immediately to the left (ends before or at our start)
      const leftNeighbor = trackClips
        .filter(c => c.startTime + c.duration <= clip.startTime + 0.01) // Small tolerance
        .sort((a, b) => (b.startTime + b.duration) - (a.startTime + a.duration))[0]
      
      // Find the clip immediately to the right (starts at or after our end)
      const rightNeighbor = trackClips
        .filter(c => c.startTime >= clip.startTime + clip.duration - 0.01) // Small tolerance
        .sort((a, b) => a.startTime - b.startTime)[0]
      
      if (trimState.edge === 'left') {
        // Trimming from left: adjust startTime, duration, and trimStart
        // When extending the head (dragging left), we're revealing more footage from the start
        // When shortening the head (dragging right), we're hiding footage from the start
        
        let newStartTime = Math.max(0, trimState.startTime + deltaTime)
        const minClipDurationSec = 1 / (timelineFps || 24)
        const maxStartTime = trimState.startTime + trimState.startDuration - minClipDurationSec
        newStartTime = Math.min(newStartTime, maxStartTime)
        
        // Calculate how much we're trying to change the head position
        let timeDelta = newStartTime - trimState.startTime
        
        // Calculate what the new trimStart would be
        // If timeDelta is negative (extending left), trimStart decreases
        // trimStart can't go below 0 (can't reveal footage before the source start)
        let newTrimStart = trimState.startTrimStart + timeDelta * timeScale
        if (newTrimStart < 0 && !isInfinitelyExtendableClip(clip)) {
          // Clamp: can only extend to where trimStart would be 0
          const minStartTime = trimState.startTime - (trimState.startTrimStart / timeScale)
          newStartTime = Math.max(newStartTime, minStartTime)
          timeDelta = newStartTime - trimState.startTime
          newTrimStart = 0
        }
        
        // Don't trim past the left neighbor's end
        if (leftNeighbor) {
          const leftNeighborEnd = leftNeighbor.startTime + leftNeighbor.duration
          if (newStartTime < leftNeighborEnd) {
            newStartTime = leftNeighborEnd
            timeDelta = newStartTime - trimState.startTime
            newTrimStart = trimState.startTrimStart + timeDelta * timeScale
          }
        }
        
        // Apply snapping to the new start time
        const snapResult = snapTrim(newStartTime, trimState.clipId)
        if (snapResult.snapped) {
          // Only apply snap if it doesn't violate constraints
          let snappedTime = snapResult.time
          
          // Check source footage constraint
          const snappedTrimStart = trimState.startTrimStart + (snappedTime - trimState.startTime) * timeScale
          if (snappedTrimStart < 0 && !isInfinitelyExtendableClip(clip)) {
            snappedTime = trimState.startTime - (trimState.startTrimStart / timeScale)
          }
          
          // Check neighbor constraint
          if (leftNeighbor) {
            snappedTime = Math.max(snappedTime, leftNeighbor.startTime + leftNeighbor.duration)
          }
          
          if (snappedTime === snapResult.time) {
            newStartTime = snapResult.time
            timeDelta = newStartTime - trimState.startTime
            newTrimStart = trimState.startTrimStart + timeDelta * timeScale
            setActiveSnapTime(snapResult.time)
          } else {
            clearActiveSnap()
          }
        } else {
          clearActiveSnap()
        }
        
        // Calculate the new duration
        const newDuration = trimState.startDuration - timeDelta
        
        // Update the clip with all trim-related properties at once
        updateClipTrim(trimState.clipId, {
          startTime: newStartTime,
          duration: newDuration,
          trimStart: Math.max(0, newTrimStart) // Ensure trimStart doesn't go negative
        })
      } else {
        // Trimming from right: adjust duration and trimEnd
        let newEndTime = trimState.startTime + trimState.startDuration + deltaTime
        
        // Don't trim past the right neighbor's start
        if (rightNeighbor) {
          newEndTime = Math.min(newEndTime, rightNeighbor.startTime)
        }
        
        // Apply snapping to the new end time
        const snapResult = snapTrim(newEndTime, trimState.clipId)
        if (snapResult.snapped) {
          // Only apply snap if it doesn't go past the neighbor
          let snappedTime = snapResult.time
          if (rightNeighbor) {
            snappedTime = Math.min(snappedTime, rightNeighbor.startTime)
          }
          if (snappedTime === snapResult.time) {
            newEndTime = snapResult.time
            setActiveSnapTime(snapResult.time)
          } else {
            clearActiveSnap()
          }
        } else {
          clearActiveSnap()
        }
        
        const minClipDurationSec = 1 / (timelineFps || 24)
        let newDuration = Math.max(minClipDurationSec, newEndTime - trimState.startTime)
        
        // Don't exceed source duration if we have it
        // The maximum duration is limited by how much source footage is available
        // from the current trimStart to the end of the source
        const currentTrimStart = trimState.startTrimStart
        const rawSourceDuration = clip.sourceDuration
        const parsedSourceDuration = rawSourceDuration === Infinity || rawSourceDuration === 'Infinity'
          ? Infinity
          : (rawSourceDuration === null || rawSourceDuration === undefined || rawSourceDuration === ''
              ? null
              : Number(rawSourceDuration))
        const sourceDuration = parsedSourceDuration === Infinity || isInfinitelyExtendableClip(clip)
          ? Infinity
          : ((Number.isFinite(parsedSourceDuration) && parsedSourceDuration > 0)
              ? parsedSourceDuration
              : trimState.startTrimEnd)
        if (Number.isFinite(sourceDuration)) {
          const maxPossibleDuration = (sourceDuration - currentTrimStart) / timeScale
          newDuration = Math.max(0.01, Math.min(newDuration, maxPossibleDuration))
        }
        
        // Calculate the new trimEnd (where in the source footage the clip ends)
        const unclampedTrimEnd = currentTrimStart + (newDuration * timeScale)
        const newTrimEnd = Number.isFinite(sourceDuration)
          ? Math.min(unclampedTrimEnd, sourceDuration)
          : unclampedTrimEnd
        
        updateClipTrim(trimState.clipId, {
          duration: newDuration,
          trimEnd: newTrimEnd
        })
      }
    }
    
    const handleMouseUp = () => {
      setTrimState(null)
      clearActiveSnap()
    }
    
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [trimState, clips, pixelsPerSecond, moveClip, resizeClip, snapTrim, setActiveSnapTime, clearActiveSnap])

  // Handle clip drag start (mousedown on clip body, not trim handles)
  const handleClipDragStart = (e, clip) => {
    // Don't start drag if clicking on trim handles or delete button
    if (trimState || slipState || fadeDragState || e.target.closest('[data-trim-handle]') || e.target.closest('[data-fade-handle]') || e.target.closest('button')) {
      return
    }
    
    e.stopPropagation()
    e.preventDefault()

    const isShiftHeld = e.shiftKey
    const isCtrlHeld = e.ctrlKey || e.metaKey // metaKey for Mac Cmd
    const hasSelectionModifier = isShiftHeld || isCtrlHeld

    if (isRazorToolActive) {
      const splitTime = getTimeFromClientX(e.clientX)
      const newClip = splitClipAtTime(clip, splitTime, { saveHistory: true })
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

    const sourceDuration = getSourceDuration(clip)
    const canSlip = !isSyncLockedClip(clip)
      && (isSlipToolActive || e.altKey)
      && (clip.type === 'video' || clip.type === 'audio')
      && Number.isFinite(sourceDuration)
    if (canSlip) {
      if (clipDragState) setClipDragState(null)
      if (transitionDragState) setTransitionDragState(null)
      if (rollEditState) setRollEditState(null)
      clearActiveSnap()
      saveToHistory()

      const timeScale = Math.max(0.0001, getTimeScale(clip))
      const startTrimStart = Math.max(0, Number(clip.trimStart) || 0)
      const computedTrimEnd = startTrimStart + clip.duration * timeScale
      const explicitTrimEnd = Number(clip.trimEnd)
      const baseTrimEnd = Number.isFinite(explicitTrimEnd) ? explicitTrimEnd : computedTrimEnd
      const startTrimEnd = Math.max(
        startTrimStart + 0.0001,
        Math.min(sourceDuration, baseTrimEnd)
      )
      const minSourceDelta = -startTrimStart
      const maxSourceDelta = Number.isFinite(sourceDuration)
        ? (sourceDuration - startTrimEnd)
        : Infinity

      setSlipState({
        clipId: clip.id,
        startX: e.clientX,
        startTrimStart,
        startTrimEnd,
        timeScale,
        minSourceDelta,
        maxSourceDelta: Math.max(minSourceDelta, maxSourceDelta),
      })

      if (!selectedClipIds.includes(clip.id) && !hasSelectionModifier) {
        selectClip(clip.id)
      }
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

  // Handle slip edit (Alt+drag on clip body)
  useEffect(() => {
    if (!slipState || trimState) return

    const handleMouseMove = (e) => {
      const deltaX = e.clientX - slipState.startX
      const deltaTime = deltaX / pixelsPerSecond
      const fps = timelineFps || 24
      const quantizedDeltaTime = Math.round(deltaTime * fps) / fps
      const proposedSourceDelta = quantizedDeltaTime * slipState.timeScale
      const boundedSourceDelta = Math.max(
        slipState.minSourceDelta,
        Math.min(proposedSourceDelta, slipState.maxSourceDelta)
      )

      const newTrimStart = slipState.startTrimStart + boundedSourceDelta
      const newTrimEnd = slipState.startTrimEnd + boundedSourceDelta
      updateClipTrim(slipState.clipId, {
        trimStart: Math.max(0, newTrimStart),
        trimEnd: Math.max(newTrimStart + 0.0001, newTrimEnd),
      })
    }

    const handleMouseUp = () => {
      setSlipState(null)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [slipState, trimState, pixelsPerSecond, timelineFps, updateClipTrim])

  // Handle clip dragging (mousemove when dragging a clip)
  // Supports moving multiple selected clips together
  useEffect(() => {
    if (!clipDragState || trimState || slipState) return
    
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
        // Move single clip (no overlap resolution yet)
        moveClip(clipDragState.clipId, newTrackId, proposedStartTime, false)
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
        clearActiveSnap()
      }
    }
    
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('blur', handleMouseUp)
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('blur', handleMouseUp)
    }
  }, [clipDragState, trimState, slipState, clips, pixelsPerSecond, moveClip, moveSelectedClips, setSelectedClipPositions, selectedClipIds, snapClipPosition, setActiveSnapTime, clearActiveSnap, saveToHistory, addTrack, getClipTrackFamily, getHoveredTrackIdForFamily, getResolvedGroupTrackDelta, getTracksForFamily, videoTracks])

  // Handle adding transition between adjacent clips - show type menu
  const handleAddTransition = (e, clipA, clipB) => {
    e.stopPropagation()
    // Show transition type menu at click position
    setTransitionMenu({
      x: e.clientX,
      y: e.clientY,
      clipA,
      clipB
    })
  }
  
  // Select transition type and duration from menu
  const handleSelectTransition = (type, durationSeconds) => {
    if (transitionMenu) {
      const result = addTransition(transitionMenu.clipA.id, transitionMenu.clipB.id, type, durationSeconds)
      if (!result) {
        // Show warning if transition couldn't be added (insufficient handles)
        console.warn('Could not add transition - insufficient handles')
      }
      setTransitionMenu(null)
    }
  }
  
  const parseTransitionDrop = (e) => {
    const raw = e.dataTransfer.getData('application/x-comfystudio-transition')
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
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
  
  // Close transition menu when clicking outside
  useEffect(() => {
    if (!transitionMenu) return
    
    const handleClick = () => setTransitionMenu(null)
    const handleEscape = (e) => {
      if (e.key === 'Escape') setTransitionMenu(null)
    }
    
    window.addEventListener('click', handleClick)
    window.addEventListener('keydown', handleEscape)
    
    return () => {
      window.removeEventListener('click', handleClick)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [transitionMenu])

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

  // Handle roll edit (dragging between two adjacent clips)
  useEffect(() => {
    if (!rollEditState || trimState || slipState) return
    
    const handleMouseMove = (e) => {
      const deltaX = e.clientX - rollEditState.startX
      const proposedDelta = deltaX / pixelsPerSecond
      const fps = timelineFps || 24
      const minDuration = 1 / fps
      const clipATimeScale = Math.max(0.0001, Number(rollEditState.clipATimeScale) || 1)
      const clipBTimeScale = Math.max(0.0001, Number(rollEditState.clipBTimeScale) || 1)

      // Duration constraints: both clips keep at least minDuration.
      const minDeltaFromClipA = minDuration - rollEditState.clipAOriginalDuration
      const maxDeltaFromClipB = rollEditState.clipBOriginalDuration - minDuration

      // Media handle constraints:
      // - Clip A can only roll right while it still has tail handle.
      // - Clip B can only roll left while it still has head handle.
      let maxDeltaFromClipAHandles = Infinity
      if (Number.isFinite(Number(rollEditState.clipASourceDuration))) {
        const maxClipADuration = (Number(rollEditState.clipASourceDuration) - rollEditState.clipAOriginalTrimStart) / clipATimeScale
        maxDeltaFromClipAHandles = maxClipADuration - rollEditState.clipAOriginalDuration
      }
      const minDeltaFromClipBHandles = -(rollEditState.clipBOriginalTrimStart / clipBTimeScale)

      let minDelta = Math.max(minDeltaFromClipA, minDeltaFromClipBHandles)
      let maxDelta = Math.min(maxDeltaFromClipB, maxDeltaFromClipAHandles)
      if (maxDelta < minDelta) {
        const pinned = (minDelta + maxDelta) / 2
        minDelta = pinned
        maxDelta = pinned
      }

      const actualDelta = Math.max(minDelta, Math.min(proposedDelta, maxDelta))
      const newClipADuration = rollEditState.clipAOriginalDuration + actualDelta
      const newClipBStart = rollEditState.clipBOriginalStart + actualDelta
      const newClipBTrimStart = Math.max(0, rollEditState.clipBOriginalTrimStart + actualDelta * clipBTimeScale)
      
      // Rolling edit semantics:
      // - Clip A tail: adjust out-point (duration/trimEnd)
      // - Clip B head: adjust in-point (startTime/trimStart), keeping trimEnd fixed
      updateClipTrim(rollEditState.clipAId, {
        duration: newClipADuration,
        trimStart: rollEditState.clipAOriginalTrimStart,
      })
      updateClipTrim(rollEditState.clipBId, {
        startTime: newClipBStart,
        trimStart: newClipBTrimStart,
        trimEnd: rollEditState.clipBOriginalTrimEnd,
      })
    }
    
    const handleMouseUp = () => {
      setRollEditState(null)
    }
    
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [rollEditState, trimState, slipState, pixelsPerSecond, timelineFps, updateClipTrim])

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

  const getMajorRulerStep = (pixelsPerSec) => {
    // Keep labels readable while allowing finer granularity at high zoom.
    const candidates = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
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
    <div className="h-full bg-sf-dark-900 border-t border-sf-dark-700 flex flex-col">
      {/* Timeline Header - compact editor toolbar and zoom controls */}
      <div className="h-8 bg-sf-dark-800 border-b border-sf-dark-700 flex items-center px-2 gap-2 overflow-hidden">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
          <div className={toolbarSectionClass} aria-label="Add tracks">
            <button
              onClick={() => addTrack('video')}
              className={toolbarButtonClass}
              title="Add video track"
            >
              <Plus className="w-3 h-3" />
              Video
            </button>
            <button
              onClick={() => addTrack('audio', { channels: 'mono' })}
              className={toolbarButtonClass}
              title="Add mono audio track"
            >
              <Plus className="w-3 h-3" />
              Mono
            </button>
            <button
              onClick={() => addTrack('audio', { channels: 'stereo' })}
              className={toolbarButtonClass}
              title="Add stereo audio track"
            >
              <Plus className="w-3 h-3" />
              Stereo
            </button>
          </div>

          <div className={toolbarSectionClass} aria-label="Insert timeline items">
            <button
              onClick={() => addMarker(playheadPosition)}
              className={toolbarButtonClass}
              title={`Add timeline marker at playhead (${markerHotkeyLabel})`}
            >
              <Flag className="w-3 h-3 text-yellow-400" />
              Marker
            </button>
            <button
              onClick={handleAddAdjustmentLayer}
              className={toolbarButtonClass}
              title="Add adjustment layer on active video track"
            >
              <Square className="w-3 h-3 text-purple-400" />
              Adj
            </button>
            <button
              onClick={() => addTextClipAtPlayhead()}
              disabled={!preferredVideoTrack}
              className={toolbarButtonClass}
              title={preferredVideoTrack
                ? `Add a text clip on ${preferredVideoTrack.name} at the playhead (${addTextClipHotkeyLabel})`
                : `Add a video track to create text at the playhead (${addTextClipHotkeyLabel})`}
            >
              <Type className="w-3 h-3" />
              Text
            </button>
            <button
              onClick={handleOpenTimelineCaptions}
              className={toolbarButtonClass}
              title="Transcribe the timeline's audio and add animated captions on a new top track"
            >
              <Type className="w-3 h-3 text-cyan-300" />
              Captions
            </button>
            {selectedMarkerId && (
              <button
                onClick={() => removeMarker(selectedMarkerId)}
                className={toolbarDangerButtonClass}
                title="Remove selected marker"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <div className={toolbarSectionClass} aria-label="Edit selection">
            <button
              onClick={splitAllTracksAtPlayhead}
              className={toolbarButtonClass}
              title={`Split all clips at the playhead across every track (${splitAllHotkeyLabel})`}
            >
              <Scissors className="w-3 h-3" />
              Cut All
            </button>
            <button
              onClick={handleSplitActiveTrackAtPlayhead}
              disabled={!activeTrackClipAtPlayhead}
              className={toolbarButtonClass}
              title={activeTrackClipAtPlayhead
                ? `Split the clip under the playhead on the active track (${splitActiveHotkeyLabel})`
                : `Set an active track and park the playhead over a clip to split it (${splitActiveHotkeyLabel})`}
            >
              <Scissors className="w-3 h-3" />
              Split
            </button>
            <button
              onClick={handleCopySelection}
              disabled={selectedClipIds.length === 0}
              className={toolbarButtonClass}
              title={`Copy the selected clips (${copyHotkeyLabel})`}
            >
              <Copy className="w-3 h-3" />
              Copy
            </button>
            <button
              onClick={handlePasteAtPlayhead}
              disabled={!activeTrackId || copiedClips.length === 0}
              className={toolbarButtonClass}
              title={activeTrackId && copiedClips.length > 0
                ? `Paste copied clips at the playhead on the active track (${pasteHotkeyLabel})`
                : `Copy clips first, then choose an active track to paste at the playhead (${pasteHotkeyLabel})`}
            >
              <ClipboardPaste className="w-3 h-3" />
              Paste
            </button>
            <button
              onClick={() => toggleClipSelectionEnabled()}
              disabled={selectedClipIds.length === 0}
              className={toolbarButtonClass}
              title={selectedClipIds.length > 0
                ? `${selectedClipsShouldEnable ? 'Enable' : 'Disable'} the selected clips (${toggleClipEnabledHotkeyLabel})`
                : `Select clips to enable or disable them (${toggleClipEnabledHotkeyLabel})`}
            >
              {selectedClipsShouldEnable ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
              {selectedClipsShouldEnable ? 'Enable' : 'Disable'}
            </button>
            <button
              onClick={handleDeleteCurrentSelection}
              disabled={!canDeleteCurrentSelection}
              className={toolbarDangerButtonClass}
              title={
                selectedClipIds.length > 0
                  ? `${rippleEditMode ? 'Ripple delete' : 'Delete'} the selected clips (Delete or Backspace)`
                  : selectedGap
                    ? 'Delete the selected gap and close it (Delete or Backspace)'
                    : selectedTransitionId
                      ? 'Delete the selected transition (Delete or Backspace)'
                      : selectedMarkerId
                        ? 'Delete the selected marker (Delete or Backspace)'
                        : 'Select clips, a gap, a transition, or a marker to delete'
              }
            >
              <Trash2 className="w-3 h-3" />
              Delete
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
                  onClick={() => setActiveTimelineTool(tool.id)}
                  className={toolbarToggleClass(active)}
                  title={`${tool.title} (${tool.shortcut})`}
                  aria-pressed={active}
                >
                  <Icon className="w-3 h-3" />
                  {tool.label}
                </button>
              )
            })}
          </div>

          <div className={toolbarSectionClass} aria-label="Timeline options">
            <button
              onClick={toggleSnapping}
              className={toolbarToggleClass(snappingEnabled)}
              title={`Snapping ${snappingEnabled ? 'ON' : 'OFF'} (${snappingHotkeyLabel} to toggle)`}
            >
              <Magnet className="w-3 h-3" />
              Snap
            </button>
            <button
              onClick={toggleRippleEdit}
              className={toolbarToggleClass(rippleEditMode)}
              title={`Ripple Edit ${rippleEditMode ? 'ON' : 'OFF'} (${rippleHotkeyLabel} to toggle) - Moving clips shifts subsequent clips`}
            >
              <ArrowRightLeft className="w-3 h-3" />
              Ripple
            </button>
          </div>

          <div className={toolbarSectionClass} aria-label="Select timeline ranges">
            <button
              onClick={selectClipsFromTimelineStartToPlayhead}
              className={toolbarButtonClass}
              title={`Select clips from the start of the timeline to the playhead (${selectFromStartHotkeyLabel})`}
            >
              <ChevronLeft className="w-3 h-3" />
              From Start
            </button>
            <button
              onClick={selectClipsFromPlayheadToEnd}
              className={toolbarButtonClass}
              title={`Select clips from the playhead to the end of the timeline (${selectToEndHotkeyLabel})`}
            >
              <ChevronRight className="w-3 h-3" />
              To End
            </button>
            {selectedClipIds.length > 0 && (
              <button
                onClick={openMoveOffsetDialog}
                className={toolbarButtonClass}
                title={`Move selected clips by an exact signed timecode offset (${moveByHotkeyLabel})`}
              >
                <ArrowRightLeft className="w-3 h-3" />
                Move By
              </button>
            )}
            {selectedClipIds.length > 0 && (
              <button
                onClick={openDurationDeltaDialog}
                className={toolbarButtonClass}
                title={`Change selected clip duration by an exact signed amount${durationByHotkeyHint ? ` (${durationByHotkeyHint})` : ''}`}
              >
                <Clock className="w-3 h-3" />
                Duration By
              </button>
            )}
          </div>

          <div className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-sf-dark-700/70 bg-sf-dark-900/45 px-1.5">
            {selectedClipIds.length > 1 && (
              <span className="text-[10px] text-sf-accent">{selectedClipIds.length} selected</span>
            )}
            {selectedGap && (
              <span
                className="text-[10px] text-sf-accent"
                title={`Selected gap from ${formatTimelineTimecode(selectedGap.startTime)} to ${formatTimelineTimecode(selectedGap.endTime)}`}
              >
                Gap {Math.max(0, selectedGap.endTime - selectedGap.startTime).toFixed(2)}s
              </span>
            )}
            <span className="text-[10px] text-sf-text-muted">{clips.length} clips</span>
          </div>
        </div>

        {/* Info & Zoom */}
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={handleFrameAll}
            className="p-1.5 hover:bg-sf-dark-600 rounded text-sf-text-muted"
            title="Frame all – fit timeline or all clips in view"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <div className="flex items-center gap-1">
            <button
              onClick={() => applyZoomWithPlayheadPivot(zoom - 50)}
              className="p-0.5 hover:bg-sf-dark-600 rounded text-sf-text-muted"
              title="Zoom Out"
            >
              <span className="text-xs">−</span>
            </button>
            <input
              type="range"
              min="20"
              max="2000"
              value={zoom}
              onChange={(e) => applyZoomWithPlayheadPivot(parseInt(e.target.value, 10))}
              className="w-24 h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
            />
            <button
              onClick={() => applyZoomWithPlayheadPivot(zoom + 50)}
              className="p-0.5 hover:bg-sf-dark-600 rounded text-sf-text-muted"
              title="Zoom In"
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
                >
                  {track.visible ? (
                    <Eye className="w-3 h-3 text-sf-text-muted" />
                  ) : (
                    <EyeOff className="w-3 h-3 text-sf-text-muted opacity-50" />
                  )}
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
              onClick={() => onOpenAudioGenerate && onOpenAudioGenerate('music')}
              className="ml-auto p-0.5 hover:bg-sf-dark-700 rounded" 
              title="Generate AI Audio"
            >
              <Sparkles className="w-3 h-3 text-sf-accent" />
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
              ? [`A${audioTrackNumber}L`, `A${audioTrackNumber}R`]
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
                    className="flex-1 min-w-0 cursor-pointer"
                    onDoubleClick={(e) => { e.stopPropagation(); handleStartRename(track) }}
                    title="Double-click to rename"
                  >
                    <span className="text-[11px] text-sf-text-primary truncate block leading-tight hover:text-sf-accent">
                      {track.name}
                    </span>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      {channelLabels.map((label) => (
                        <span
                          key={label}
                          className="px-1 py-0 rounded border border-sf-dark-500 bg-sf-dark-700/70 text-[9px] text-sf-text-muted leading-none"
                        >
                          {label}
                        </span>
                      ))}
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
              onDoubleClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                const time = getTimeFromMouseEvent(e)
                addMarker(time)
                setPlayheadPosition(time, { snap: true })
              }}
              title="Double-click to add marker"
            >
              {/* Minor ticks */}
              {rulerTicks.minor.map((time) => (
                <div
                  key={`minor-${time}`}
                  className="absolute bottom-0 w-px h-1.5 bg-sf-dark-600/80 pointer-events-none"
                  style={{ left: `${time * pixelsPerSecond}px` }}
                />
              ))}

              {/* Major ticks + timecode labels */}
              {rulerTicks.major.map((time) => (
                <div
                  key={`major-${time}`}
                  className="absolute top-0 bottom-0 pointer-events-none"
                  style={{ left: `${time * pixelsPerSecond}px` }}
                >
                  <div className="absolute bottom-0 w-px h-2.5 bg-sf-dark-500/95" />
                  <span className="absolute top-0.5 left-1 text-[9px] text-sf-text-muted font-mono tracking-tight whitespace-nowrap">
                    {formatTimelineTimecode(time)}
                  </span>
                </div>
              ))}

              {/* FPS indicator on far right */}
              <div className="absolute top-0.5 right-1 text-[8px] text-sf-text-muted/80 font-mono pointer-events-none">
                {Math.round(timecodeFps)} fps
              </div>
            </div>

          {/* Scrollable tracks container */}
          <div 
            ref={trackContentRef}
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
                  
                  return (
                  <div
                    key={clip.id}
                    data-clip="true"
                    onMouseDown={(e) => handleClipDragStart(e, clip)}
                    onClick={(e) => handleClipClick(e, clip)}
                    onDoubleClick={isTextClip ? (e) => handleTextClipDoubleClick(e, clip) : undefined}
                    onContextMenu={(e) => handleClipContextMenu(e, clip)}
                    onDragOver={(e) => {
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
                        : isSlipToolActive
                          ? 'cursor-ew-resize'
                          : isTrimToolActive
                            ? 'cursor-default'
                            : 'cursor-grab'
                    } ${
                      slipState?.clipId === clip.id || clipDragState?.movingClipIds?.includes(clip.id) ? 'z-30' : ''
                    }`}
                    style={{ 
                      left: `${(clip.startTime * pixelsPerSecond) - interactiveClipOffset}px`, 
                      width: `${interactiveClipWidth}px`,
                    }}
                  >
                    <div
                      className={`absolute top-0 bottom-0 rounded-sm overflow-hidden ${
                        selectedClipIds.includes(clip.id) ? 'ring-2 ring-white ring-offset-1 ring-offset-sf-dark-900' : ''
                      } ${trimState?.clipId === clip.id ? 'ring-2 ring-sf-accent' : ''} ${
                        slipState?.clipId === clip.id ? 'ring-2 ring-yellow-400 cursor-ew-resize z-30' : ''
                      } ${
                        clipDragState?.movingClipIds?.includes(clip.id)
                          ? 'ring-2 ring-sf-accent cursor-grabbing z-30' : ''
                      } ${
                        clipEnabled ? '' : 'opacity-60 saturate-0'
                      }`}
                      style={{
                        left: `${interactiveClipOffset}px`,
                        width: `${renderedClipWidth}px`,
                      }}
                    >
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
                    {isTextClip ? (
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
                              fontFamily: clip.textProperties?.fontFamily || 'Inter'
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

                    {/* Hover overlay */}
                    <div className="absolute inset-0 bg-white/0 group-hover:bg-white/5 transition-colors pointer-events-none" />
                    
                    {trimHandlesEnabled && !isSyncLockedClip(clip) && (
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
                
                {/* Roll edit zones and transition buttons/overlays between adjacent clips */}
                {getAdjacentClips(track.id).map(({ clipA, clipB, transition, isOverlapping, gap, isTrueEditPoint }) => {
                  const clipAEnd = clipA.startTime + clipA.duration
                  const canRollEdit = isTrimToolActive && (isOverlapping || Math.abs(gap) <= ROLL_EDIT_MAX_GAP_SECONDS)
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
                    const isSelected = selectedTransitionId === transition.id
                    const transitionMeta = TRANSITION_TYPES.find(t => t.id === transition.type)
                    const transitionName = transitionMeta?.name || transition.type
                    const transitionFrames = Math.round(transition.duration * FRAME_RATE)

                    return (
                      <div
                        key={`transition-${clipA.id}-${clipB.id}`}
                        data-gap-ignore="true"
                        className={`absolute top-0 bottom-[14px] z-25 pointer-events-auto cursor-pointer group/trans ${
                          isSelected ? 'ring-2 ring-white/80 ring-inset shadow-[0_0_0_1px_rgba(255,255,255,0.4)]' : ''
                        }`}
                        style={{ left: `${transitionX}px`, width: `${transitionWidth}px` }}
                        onClick={(e) => {
                          e.stopPropagation()
                          selectTransition(transition.id)
                        }}
                        title={`${transitionName} (${transitionFrames}f)`}
                      >
                        {/* Resolve-style: dark grey-black overlay container with visible border */}
                        <div className="absolute inset-0 overflow-hidden border border-[#4a4a4a]/90 bg-[#1a1a1a]/85 rounded-[2px]">
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
                          className={`absolute left-0 top-0 bottom-0 w-3 flex items-center justify-start z-30 cursor-ew-resize ${
                            isSelected ? 'opacity-100' : 'opacity-0 group-hover/trans:opacity-100'
                          }`}
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
                          className={`absolute right-0 top-0 bottom-0 w-3 flex items-center justify-end z-30 cursor-ew-resize ${
                            isSelected ? 'opacity-100' : 'opacity-0 group-hover/trans:opacity-100'
                          }`}
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
                            isSelected ? 'opacity-100' : 'opacity-0 group-hover/trans:opacity-100'
                          }`}
                          title="Remove transition"
                        >
                          ×
                        </button>
                      </div>
                    )
                  }
                  
                  // Non-overlapping adjacent clips - show add transition button / drop target.
                  // The transition affordance should only appear on a true butt cut,
                  // not near misses or short gaps that are only useful for roll-edit hover zones.
                  if (!isTrueEditPoint && !canRollEdit) return null
                  const editPointX = clipAEnd * pixelsPerSecond
                  const dropKey = `${clipA.id}-${clipB.id}`
                  const isDropTarget = transitionDropTarget === dropKey
                  
                  return (
                    <div
                      key={`edit-${clipA.id}-${clipB.id}`}
                      data-gap-ignore="true"
                      className={`absolute top-0 bottom-0 z-20 group/edit ${isDropTarget && isTrueEditPoint ? 'bg-purple-500/10' : ''}`}
                      style={{ left: `${editPointX - 4}px`, width: '8px' }}
                      onDragOver={(e) => {
                        if (!isTrueEditPoint) return
                        const payload = parseTransitionDrop(e)
                        if (!payload) return
                        e.preventDefault()
                        if (transitionDropTarget !== dropKey) {
                          setTransitionDropTarget(dropKey)
                        }
                      }}
                      onDragLeave={() => {
                        if (!isTrueEditPoint) return
                        if (transitionDropTarget === dropKey) {
                          setTransitionDropTarget(null)
                        }
                      }}
                      onDrop={(e) => {
                        if (!isTrueEditPoint) return
                        const payload = parseTransitionDrop(e)
                        if (!payload) return
                        e.preventDefault()
                        setTransitionDropTarget(null)
                        const { type, duration } = payload
                        const existingTransition = getTransitionBetween(clipA.id, clipB.id)
                        if (existingTransition) {
                          updateTransition(existingTransition.id, { type, duration })
                          selectTransition(existingTransition.id)
                        } else {
                          addTransition(clipA.id, clipB.id, type, duration)
                        }
                      }}
                    >
                      {/* Roll edit handle */}
                      <div
                        className={`absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-1.5 flex items-center justify-center ${
                          canRollEdit ? 'cursor-ew-resize' : 'pointer-events-none cursor-default'
                        }`}
                        onMouseDown={(e) => {
                          if (!canRollEdit) return
                          e.stopPropagation()
                          e.preventDefault()
                          saveToHistory()
                          const clipATimeScale = getTimeScale(clipA)
                          const clipBTimeScale = getTimeScale(clipB)
                          const clipAOriginalTrimStart = clipA.trimStart || 0
                          const clipBOriginalTrimStart = clipB.trimStart || 0
                          const clipBOriginalTrimEnd = clipB.trimEnd
                            ?? clipB.sourceDuration
                            ?? (clipBOriginalTrimStart + clipB.duration * clipBTimeScale)
                          const clipASourceDuration = Number.isFinite(Number(clipA.sourceDuration))
                            ? Number(clipA.sourceDuration)
                            : null
                          setRollEditState({
                            clipAId: clipA.id,
                            clipBId: clipB.id,
                            startX: e.clientX,
                            originalEditPoint: clipAEnd,
                            clipAOriginalDuration: clipA.duration,
                            clipBOriginalStart: clipB.startTime,
                            clipBOriginalDuration: clipB.duration,
                            clipAOriginalTrimStart,
                            clipASourceDuration,
                            clipATimeScale,
                            clipBOriginalTrimStart,
                            clipBOriginalTrimEnd,
                            clipBTimeScale,
                          })
                        }}
                        title={canRollEdit ? 'Drag to roll edit (extend one clip, shorten the other)' : 'Roll edit available when clips touch'}
                      >
                        <div className={`w-0.5 h-full transition-colors ${canRollEdit ? 'bg-white/0 group-hover/edit:bg-yellow-400/70' : 'bg-white/0'}`} />
                      </div>
                      
                      {/* Add transition button */}
                      {isTrueEditPoint && canAddTransitionBetweenClips(clipA, clipB) && (
                        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-auto">
                          <button
                            onClick={(e) => handleAddTransition(e, clipA, clipB)}
                            className="w-3 h-3 rounded-full bg-sf-dark-700/90 border border-sf-dark-400/80 flex items-center justify-center hover:bg-purple-600 hover:border-purple-400 transition-colors opacity-0 group-hover/edit:opacity-100 shadow-[0_1px_4px_rgba(0,0,0,0.45)]"
                            title="Add transition"
                          >
                            <Plus className="w-2 h-2 text-white" />
                          </button>
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
                    onMouseDown={(e) => handleClipDragStart(e, clip)}
                    onClick={(e) => handleClipClick(e, clip)}
                    onContextMenu={(e) => handleClipContextMenu(e, clip)}
                    className={`absolute top-0.5 bottom-0.5 rounded-sm group ${
                      isRazorToolActive
                        ? 'cursor-crosshair'
                        : isSlipToolActive
                          ? 'cursor-ew-resize'
                          : isTrimToolActive
                            ? 'cursor-default'
                            : 'cursor-grab'
                    } ${
                      slipState?.clipId === clip.id || clipDragState?.movingClipIds?.includes(clip.id) ? 'z-30' : ''
                    }`}
                    style={{ 
                      left: `${(clip.startTime * pixelsPerSecond) - interactiveClipOffset}px`, 
                      width: `${interactiveClipWidth}px`,
                    }}
                  >
                    <div
                      className={`absolute top-0 bottom-0 rounded-sm overflow-hidden ${
                        selectedClipIds.includes(clip.id) ? 'ring-2 ring-white ring-offset-1 ring-offset-sf-dark-900' : ''
                      } ${slipState?.clipId === clip.id ? 'ring-2 ring-yellow-400 cursor-ew-resize z-30' : ''} ${clipDragState?.movingClipIds?.includes(clip.id)
                          ? 'ring-2 ring-sf-accent cursor-grabbing z-30' : ''} ${clipEnabled ? '' : 'opacity-60 saturate-0'}`}
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
                    />

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
                    
                    {/* Hover overlay */}
                    <div className="absolute inset-0 bg-white/0 group-hover:bg-white/10 transition-colors pointer-events-none" />
                    
                    {/* Left/Right edge borders */}
                    <div className="absolute left-0 top-0 bottom-0 w-px bg-black/40 pointer-events-none" />
                    <div className="absolute right-0 top-0 bottom-0 w-px bg-black/40 pointer-events-none" />
                    
                    {trimHandlesEnabled && !isSyncLockedClip(clip) && (
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
                {getAdjacentClips(track.id).map(({ clipA, clipB, isOverlapping, gap }) => {
                  const canRollEdit = isTrimToolActive && (isOverlapping || Math.abs(gap) <= ROLL_EDIT_MAX_GAP_SECONDS)
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
                        className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-1.5 cursor-ew-resize flex items-center justify-center"
                        onMouseDown={(e) => {
                          e.stopPropagation()
                          e.preventDefault()
                          saveToHistory()
                          const clipATimeScale = getTimeScale(clipA)
                          const clipBTimeScale = getTimeScale(clipB)
                          const clipAOriginalTrimStart = clipA.trimStart || 0
                          const clipBOriginalTrimStart = clipB.trimStart || 0
                          const clipBOriginalTrimEnd = clipB.trimEnd
                            ?? clipB.sourceDuration
                            ?? (clipBOriginalTrimStart + clipB.duration * clipBTimeScale)
                          const clipASourceDuration = Number.isFinite(Number(clipA.sourceDuration))
                            ? Number(clipA.sourceDuration)
                            : null
                          setRollEditState({
                            clipAId: clipA.id,
                            clipBId: clipB.id,
                            startX: e.clientX,
                            originalEditPoint: clipA.startTime + clipA.duration,
                            clipAOriginalDuration: clipA.duration,
                            clipBOriginalStart: clipB.startTime,
                            clipBOriginalDuration: clipB.duration,
                            clipAOriginalTrimStart,
                            clipASourceDuration,
                            clipATimeScale,
                            clipBOriginalTrimStart,
                            clipBOriginalTrimEnd,
                            clipBTimeScale,
                          })
                        }}
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
                      : 'bg-cyan-400/70'
                  }`}
                />
                <button
                  data-marker-handle="true"
                  className={`absolute -top-1 left-1/2 -translate-x-1/2 h-4 min-w-[18px] px-1 pointer-events-auto transition-all rounded-[4px] border shadow-[0_4px_10px_rgba(0,0,0,0.35)] flex items-center justify-center gap-1 ${
                    isSelected
                      ? 'border-cyan-100/80 bg-cyan-300 text-slate-950'
                      : 'border-cyan-300/45 bg-cyan-500/85 text-white hover:bg-cyan-400'
                  }`}
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
                    isSelected ? 'bg-cyan-300' : 'bg-cyan-500/90'
                  }`}
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
            />
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
          
          {/* Playhead */}
          <div
            className={`absolute top-0 bottom-0 z-10 ${isScrubbing ? 'pointer-events-none' : ''}`}
            style={{ left: `${playheadPosition * pixelsPerSecond}px`, width: '2px' }}
          >
            <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-[2px] bg-orange-400 shadow-[0_0_12px_rgba(251,146,60,0.45)]" />
            {/* Playhead handle (draggable) */}
            <div 
              className="absolute -top-1 left-1/2 -translate-x-1/2 w-5 h-4 cursor-ew-resize flex items-start justify-center"
              onMouseDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
                setIsScrubbing(true)
              }}
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
              onMouseDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
                setIsScrubbing(true)
              }}
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
      
      {/* Transition menu: single "Add transition" — change type/duration in Inspector */}
      {transitionMenu && (() => {
        const maxDuration = getMaxTransitionDuration(transitionMenu.clipA.id, transitionMenu.clipB.id)
        const preferredSeconds = defaultTransitionFrames / FRAME_RATE
        const defaultSeconds = Math.min(preferredSeconds, Math.max(1 / FRAME_RATE, maxDuration))
        const canAdd = maxDuration >= 1 / FRAME_RATE

        return (
          <div
            className="fixed z-50 bg-sf-dark-800 border border-sf-dark-600 rounded-lg shadow-xl py-1 min-w-[180px]"
            style={{ 
              left: `${transitionMenu.x}px`, 
              top: `${transitionMenu.y}px`,
              transform: 'translate(-50%, 8px)'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-2 text-[10px] text-sf-text-muted uppercase tracking-wider border-b border-sf-dark-600">
              Add transition
            </div>
            {canAdd ? (
              <button
                onClick={() => handleSelectTransition('dissolve', defaultSeconds)}
                className="w-full px-3 py-2.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
              >
                <span>Add transition</span>
              </button>
            ) : (
              <div className="px-3 py-2 text-xs text-sf-text-muted">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="w-4 h-4 text-sf-accent" />
                  <span className="font-medium text-sf-text-primary">Insufficient Handles</span>
                </div>
                <p className="text-[10px] leading-tight">
                  Cannot add transition. The clips need more footage before/after their trim points.
                  Extend the clips or use source media with more footage.
                </p>
              </div>
            )}
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
          className="fixed z-50 bg-sf-dark-800 border border-sf-dark-600 rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{
            left: `${clipContextMenuPosition.x}px`,
            top: `${clipContextMenuPosition.y}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
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
                    // bound; the parent menu is `min-w-[160px]`. If opening
                    // to the right would push the submenu off the viewport
                    // edge (or close enough to it that it would feel
                    // cramped), we flip to the left instead.
                    const SUBMENU_MIN_WIDTH = 220
                    const PARENT_MIN_WIDTH = 160
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
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
            title={`Split selected clip at playhead (or press ${splitActiveHotkeyLabel} to split on the active track)`}
          >
            <span>Split at Playhead</span>
            <span className="ml-auto text-sf-text-muted text-[10px]">{splitActiveHotkeyLabel}</span>
          </button>
          
          <button
            onClick={() => handleContextMenuAction('duplicate')}
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
            onClick={() => { copySelectedClips(); setClipContextMenu(null) }}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
            title="Copy selected clips to paste at playhead"
          >
            <span>Copy</span>
            <span className="ml-auto text-sf-text-muted text-[10px]">Ctrl+C</span>
          </button>
          <button
            onClick={() => { pasteClipsAtPlayhead(activeTrackId, playheadPosition, assets); setClipContextMenu(null) }}
            disabled={!activeTrackId || copiedClips.length === 0}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Paste at playhead on active track"
          >
            <span>Paste at Playhead</span>
            <span className="ml-auto text-sf-text-muted text-[10px]">Ctrl+V</span>
          </button>
          
          <div className="h-px bg-sf-dark-600 my-1" />
          
          <button
            onClick={() => handleContextMenuAction('delete')}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-error hover:bg-sf-error/20 flex items-center gap-2 transition-colors"
          >
            <span>{rippleEditMode ? (clipContextSelectionIds.length > 1 ? `Ripple Delete ${clipContextSelectionIds.length} clips` : 'Ripple Delete') : (clipContextSelectionIds.length > 1 ? `Delete ${clipContextSelectionIds.length} clips` : 'Delete')}</span>
            <span className="ml-auto text-sf-text-muted text-[10px]">Del</span>
          </button>
        </div>
      )}

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
        isOpen={Boolean(timelineCaptionWorkspaceAsset)}
        asset={timelineCaptionWorkspaceAsset}
        scope="timeline"
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
        onPlaceOnTimeline={handlePlaceTimelineCaptionOnTimeline}
        onClose={() => setTimelineCaptionWorkspaceAsset(null)}
      />
    </div>
  )
}

export default Timeline
