import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { TRANSITION_DEFAULT_SETTINGS, FRAME_RATE } from '../constants/transitions'
import { buildTextAnimationPresetKeyframes, TEXT_ANIMATION_KEYFRAME_PROPERTIES } from '../utils/textAnimationPresets'
import { getAdjustmentValue, mergeAdjustmentSettings, normalizeAdjustmentSettings } from '../utils/adjustments'
import { clampAudioFadeDuration } from '../utils/audioClipFades'
import { normalizeAudioClipGainDb } from '../utils/audioClipGain'
import { CLIP_COMPOSITE_MODE, normalizeClipCompositeMode } from '../utils/layerCompositing'
import {
  quantizeTimeToFrame as roundToFrame,
  roundDurationToFrame,
} from '../utils/timelineFrames'

// Maximum number of undo states to keep
const MAX_HISTORY_SIZE = 50
const MIN_TRANSITION_DURATION = 1 / FRAME_RATE
const TRIM_DEBUG_KEY = 'comfystudio-debug-trim'
const KEYFRAME_TIME_TOLERANCE = 0.05

const isTrimDebugEnabled = () => {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(TRIM_DEBUG_KEY) === '1'
}

const getClipTimeScale = (clip) => {
  if (!clip) return 1
  const baseScale = clip.sourceTimeScale
    || (clip.timelineFps && clip.sourceFps ? clip.timelineFps / clip.sourceFps : 1)
  const speed = Number(clip.speed)
  const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
  return baseScale * speedScale
}

const timelineToSourceTime = (clip, timelineSeconds) => {
  return timelineSeconds * getClipTimeScale(clip)
}

const sourceToTimelineTime = (clip, sourceSeconds) => {
  return sourceSeconds / getClipTimeScale(clip)
}

const clampKeyframeTime = (time, clipDuration) => {
  const parsedTime = Number(time)
  if (!Number.isFinite(parsedTime)) return 0

  const parsedDuration = Number(clipDuration)
  if (!Number.isFinite(parsedDuration) || parsedDuration <= 0) {
    return Math.max(0, parsedTime)
  }

  return Math.max(0, Math.min(parsedDuration, parsedTime))
}

const movePropertyKeyframeArray = (propertyKeyframes, fromTime, toTime, tolerance = KEYFRAME_TIME_TOLERANCE) => {
  const sourceFrames = Array.isArray(propertyKeyframes) ? [...propertyKeyframes] : []
  const sourceIndex = sourceFrames.findIndex((keyframe) => Math.abs(keyframe.time - fromTime) < tolerance)
  if (sourceIndex < 0) {
    return { moved: false, keyframes: sourceFrames }
  }

  const sourceKeyframe = sourceFrames[sourceIndex]
  const framesWithoutSource = sourceFrames.filter((_, index) => index !== sourceIndex)
  const collisionIndex = framesWithoutSource.findIndex((keyframe) => Math.abs(keyframe.time - toTime) < tolerance)
  const movedKeyframe = { ...sourceKeyframe, time: toTime }

  if (collisionIndex >= 0) {
    framesWithoutSource[collisionIndex] = movedKeyframe
  } else {
    framesWithoutSource.push(movedKeyframe)
  }

  framesWithoutSource.sort((a, b) => a.time - b.time)
  return { moved: true, keyframes: framesWithoutSource }
}

const getTransitionContributions = (duration, alignment = 'center') => {
  const d = Math.max(0, Number(duration) || 0)
  switch (alignment) {
    case 'start':
      return { clipA: d, clipB: 0 }
    case 'end':
      return { clipA: 0, clipB: d }
    case 'center':
    default:
      return { clipA: d / 2, clipB: d / 2 }
  }
}

const parseClipSourceDuration = (value) => {
  if (value === Infinity || value === 'Infinity') return Infinity
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

const getClipTrimEnd = (clip) => {
  if (!clip) return 0
  if (clip.trimEnd !== undefined && clip.trimEnd !== null && Number.isFinite(Number(clip.trimEnd))) {
    return Number(clip.trimEnd)
  }
  const parsedSourceDuration = parseClipSourceDuration(clip.sourceDuration)
  if (parsedSourceDuration !== null) return parsedSourceDuration
  return (clip.trimStart || 0) + timelineToSourceTime(clip, clip.duration || 0)
}

const getNormalizedLinkGroupId = (value) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

const buildLinkGroupId = (seed) => `link-${seed}`
const isClipEnabled = (clip) => clip?.enabled !== false
const MUSIC_VIDEO_SYNC_SHOT_TYPES = new Set(['performance', 'performance_wide'])

export const isSyncLockedClip = (clip) => clip?.lockMode === 'sync' && clip?.syncLock?.mode === 'sync'

const normalizeMusicVideoShotType = (value = '') => String(value || '').trim().toLowerCase()

const isMusicVideoSyncAsset = (asset = null) => {
  const yolo = asset?.yolo || asset?.settings?.yolo || null
  if (!yolo || yolo.mode !== 'music' || yolo.stage !== 'video') return false
  return MUSIC_VIDEO_SYNC_SHOT_TYPES.has(normalizeMusicVideoShotType(yolo.shotType))
}

const resolveClipSyncLock = ({ asset = null, options = null, startTime = 0, duration = 0, fps = FRAME_RATE } = {}) => {
  if (options?.syncLock === false) return null
  const explicit = options?.syncLock && typeof options.syncLock === 'object' ? options.syncLock : null
  const yolo = asset?.yolo || asset?.settings?.yolo || null
  const shouldInferFromAsset = !explicit && isMusicVideoSyncAsset(asset)
  if (!explicit && !shouldInferFromAsset) return null

  const safeFps = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : FRAME_RATE
  const rawStart = explicit?.startTime ?? explicit?.audioStart ?? yolo?.audioStart ?? startTime
  const rawDuration = explicit?.duration ?? explicit?.length ?? yolo?.length ?? yolo?.durationSeconds ?? duration
  const anchoredStartTime = roundToFrame(Math.max(0, Number(rawStart) || 0), safeFps)
  const anchoredDuration = roundDurationToFrame(Math.max(1 / safeFps, Number(rawDuration) || Number(duration) || 1 / safeFps), safeFps)
  const shotType = normalizeMusicVideoShotType(explicit?.shotType || yolo?.shotType || '')

  return {
    mode: 'sync',
    source: explicit?.source || 'music-video',
    reason: explicit?.reason || 'song-sync',
    startTime: anchoredStartTime,
    audioStart: anchoredStartTime,
    duration: anchoredDuration,
    length: anchoredDuration,
    shotType,
    sceneId: explicit?.sceneId || yolo?.sceneId || '',
    shotId: explicit?.shotId || yolo?.shotId || '',
    variantKey: explicit?.variantKey || yolo?.variantKey || yolo?.key || '',
  }
}

const applySyncLockToClip = (clip, fps = FRAME_RATE) => {
  if (!isSyncLockedClip(clip)) return clip
  const safeFps = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : FRAME_RATE
  const startTime = roundToFrame(Math.max(0, Number(clip.syncLock.startTime ?? clip.syncLock.audioStart) || 0), safeFps)
  const duration = roundDurationToFrame(Math.max(1 / safeFps, Number(clip.syncLock.duration ?? clip.syncLock.length) || Number(clip.duration) || 1 / safeFps), safeFps)
  const trimStart = Math.max(0, Number(clip.trimStart) || 0)
  const trimEnd = trimStart + timelineToSourceTime(clip, duration)
  return {
    ...clip,
    lockMode: 'sync',
    syncLock: {
      ...clip.syncLock,
      startTime,
      audioStart: startTime,
      duration,
      length: duration,
    },
    startTime,
    duration,
    trimStart,
    trimEnd,
  }
}

const buildAssetByIdMap = (assets = []) => new Map(
  (Array.isArray(assets) ? assets : [])
    .filter((asset) => asset?.id)
    .map((asset) => [asset.id, asset])
)

const applyInferredSyncLockToClip = (clip, assetsById, fps = FRAME_RATE) => {
  if (!clip) return clip
  if (isSyncLockedClip(clip)) return applySyncLockToClip(clip, fps)
  const asset = assetsById?.get?.(clip.assetId) || null
  const syncLock = resolveClipSyncLock({
    asset,
    startTime: clip.startTime,
    duration: clip.duration,
    fps,
  })
  return syncLock ? applySyncLockToClip({ ...clip, lockMode: 'sync', syncLock }, fps) : clip
}

const dedupeClipIds = (clipIds = []) => [...new Set((clipIds || []).filter(Boolean))]
const RIPPLE_TIME_EPSILON = 1e-6

const expandClipIdsWithLinked = (clips, clipIds = []) => {
  const sourceIds = dedupeClipIds(clipIds)
  if (sourceIds.length === 0) return []

  const clipsById = new Map((clips || []).map((clip) => [clip.id, clip]))
  const expandedIds = new Set(sourceIds)

  sourceIds.forEach((clipId) => {
    const clip = clipsById.get(clipId)
    const linkGroupId = getNormalizedLinkGroupId(clip?.linkGroupId)
    if (!linkGroupId) return

    ;(clips || []).forEach((candidate) => {
      if (getNormalizedLinkGroupId(candidate?.linkGroupId) === linkGroupId) {
        expandedIds.add(candidate.id)
      }
    })
  })

  return [...expandedIds]
}

const mergeTimeRanges = (ranges = []) => {
  if (!Array.isArray(ranges) || ranges.length === 0) return []

  const sortedRanges = ranges
    .map((range) => ({
      start: Number(range?.start) || 0,
      end: Number(range?.end) || 0,
    }))
    .filter((range) => range.end - range.start > RIPPLE_TIME_EPSILON)
    .sort((a, b) => a.start - b.start)

  const mergedRanges = []
  for (const range of sortedRanges) {
    const previous = mergedRanges[mergedRanges.length - 1]
    if (!previous || range.start > previous.end + RIPPLE_TIME_EPSILON) {
      mergedRanges.push({ ...range })
      continue
    }
    previous.end = Math.max(previous.end, range.end)
  }

  return mergedRanges
}

const getClipBaseRange = (clip, transitions = []) => {
  if (!clip) return { start: 0, end: 0 }

  let start = Number(clip.startTime) || 0
  let end = start + (Number(clip.duration) || 0)

  for (const transition of transitions || []) {
    if (transition?.kind !== 'between') continue
    if (transition.clipAId === clip.id && Number.isFinite(Number(transition.originalClipAEnd))) {
      end = Number(transition.originalClipAEnd)
    }
    if (transition.clipBId === clip.id && Number.isFinite(Number(transition.originalClipBStart))) {
      start = Number(transition.originalClipBStart)
    }
  }

  start = Math.max(0, start)
  end = Math.max(start, end)
  return { start, end }
}

const getRippleShiftAmount = (time, ranges = []) => {
  return ranges.reduce((total, range) => {
    const overlapBeforeTime = Math.max(0, Math.min(time, range.end) - range.start)
    return total + overlapBeforeTime
  }, 0)
}

const cleanupBrokenBetweenTransitions = (clips = [], transitions = []) => {
  let finalClips = [...clips]
  let finalTransitions = [...(transitions || [])]

  if (finalTransitions.length === 0) {
    return { clips: finalClips, transitions: finalTransitions }
  }

  const isBroken = (transition, candidateClips) => {
    if (transition.kind !== 'between') return false
    const clipA = candidateClips.find((clip) => clip.id === transition.clipAId)
    const clipB = candidateClips.find((clip) => clip.id === transition.clipBId)
    if (!clipA || !clipB) return true
    if (clipA.trackId !== clipB.trackId) return true
    const trackClips = candidateClips
      .filter((clip) => clip.trackId === clipA.trackId)
      .sort((a, b) => a.startTime - b.startTime)
    const indexA = trackClips.findIndex((clip) => clip.id === clipA.id)
    const indexB = trackClips.findIndex((clip) => clip.id === clipB.id)
    return Math.abs(indexA - indexB) !== 1
  }

  const brokenTransitions = finalTransitions.filter((transition) => isBroken(transition, finalClips))
  if (brokenTransitions.length === 0) {
    return { clips: finalClips, transitions: finalTransitions }
  }

  const brokenIds = new Set(brokenTransitions.map((transition) => transition.id))
  for (const transition of brokenTransitions) {
    finalClips = finalClips.map((clip) => {
      if (clip.id === transition.clipAId && transition.originalClipAEnd != null && transition.originalClipATrimEnd != null) {
        return {
          ...clip,
          duration: transition.originalClipAEnd - clip.startTime,
          trimEnd: transition.originalClipATrimEnd,
        }
      }
      if (clip.id === transition.clipBId && transition.originalClipBStart != null && transition.originalClipBTrimStart != null) {
        const durationDiff = clip.startTime - transition.originalClipBStart
        return {
          ...clip,
          startTime: transition.originalClipBStart,
          duration: clip.duration - durationDiff,
          trimStart: transition.originalClipBTrimStart,
        }
      }
      return clip
    })
  }

  finalTransitions = finalTransitions.filter((transition) => !brokenIds.has(transition.id))
  return { clips: finalClips, transitions: finalTransitions }
}

const normalizeClipTimebases = (clips, assets, timelineFps) => {
  if (!clips || clips.length === 0) return clips || []

  const assetsById = new Map((assets || []).map(asset => [asset.id, asset]))

  return clips.map((clip) => {
    if (!clip || clip.type !== 'video') return clip

    const asset = assetsById.get(clip.assetId)
    const sourceDuration = clip.sourceDuration
      || asset?.settings?.duration
      || asset?.duration
      || clip.duration
    const trimStart = clip.trimStart || 0
    const trimEnd = clip.trimEnd ?? sourceDuration
    const sourceSpan = Math.max(0, Math.min(sourceDuration, trimEnd) - trimStart)
    const sourceFps = Number(asset?.settings?.fps ?? asset?.fps)
    const normalizedTimelineFps = Number(timelineFps)

    const normalizedSpeed = Number.isFinite(Number(clip.speed)) && Number(clip.speed) > 0 ? Number(clip.speed) : 1
    const normalizedReverse = Boolean(clip.reverse)

    // Timeline duration: prefer the user-set value saved with the project.
    // Previously we unconditionally wrote `duration: sourceSpan`, which
    // ignored `speed`: a clip slowed to 0.5x and stretched to 2x its source
    // length on the timeline would be snapped back to the source's native
    // length every reload, and the ensuing trimEnd recomputation in
    // loadFromProject would progressively corrupt the trim on each restart.
    //
    // The saved `duration` IS the timeline length the user intended. Trust
    // it when present and positive; fall back to deriving from source span
    // divided by speed so we don't re-introduce the same bug for clips that
    // arrive without a saved duration (e.g. brand-new imports mid-hydrate).
    const savedDuration = Number(clip.duration)
    const fallbackDuration = normalizedSpeed > 0 ? sourceSpan / normalizedSpeed : sourceSpan
    const resolvedDuration = Number.isFinite(savedDuration) && savedDuration > 0
      ? savedDuration
      : fallbackDuration

    const normalizedClip = {
      ...clip,
      sourceDuration,
      trimStart,
      trimEnd: Math.min(trimEnd, sourceDuration),
      duration: resolvedDuration,
      sourceFps: Number.isFinite(sourceFps) && sourceFps > 0 ? sourceFps : clip.sourceFps ?? null,
      timelineFps: Number.isFinite(normalizedTimelineFps) && normalizedTimelineFps > 0 ? normalizedTimelineFps : clip.timelineFps ?? null,
      sourceTimeScale: 1,
      speed: normalizedSpeed,
      reverse: normalizedReverse,
    }

    return clampFiniteMediaClipToSource(normalizedClip, timelineFps)
  })
}

const getNextClipCounter = (clips = [], fallback = 1) => {
  let maxClipId = 0
  for (const clip of clips) {
    const match = /^clip-(\d+)$/.exec(String(clip?.id ?? ''))
    if (!match) continue
    const idNum = Number(match[1])
    if (Number.isFinite(idNum) && idNum > maxClipId) {
      maxClipId = idNum
    }
  }
  const fallbackNum = Number(fallback)
  const safeFallback = Number.isFinite(fallbackNum) && fallbackNum > 0 ? fallbackNum : 1
  return Math.max(safeFallback, maxClipId + 1)
}

const isAdjustmentClipType = (clip) => clip?.type === 'adjustment'
const isInfinitelyExtendableClipType = (clip) => (
  clip?.type === 'image' || clip?.type === 'adjustment' || clip?.type === 'text'
)
const supportsClipAdjustments = (clip) => (
  clip?.type === 'video'
  || clip?.type === 'image'
  || clip?.type === 'text'
  || clip?.type === 'adjustment'
)

const supportsLowerLayerCompositeMode = (clip) => (
  clip?.type === 'video'
  || clip?.type === 'image'
  || clip?.type === 'text'
)

const floorDurationToFrame = (duration, fps) => {
  const safeFps = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : FRAME_RATE
  const minDuration = 1 / safeFps
  const parsed = Number(duration)
  if (!Number.isFinite(parsed) || parsed <= 0) return minDuration
  return Math.max(minDuration, Math.floor((parsed * safeFps) + 1e-6) / safeFps)
}

const clampFiniteMediaClipToSource = (clip, fps) => {
  if (!clip || (clip.type !== 'video' && clip.type !== 'audio')) return clip
  if (isInfinitelyExtendableClipType(clip)) return clip

  const sourceDuration = parseClipSourceDuration(clip.sourceDuration)
  if (!Number.isFinite(sourceDuration)) return clip

  const safeFps = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : FRAME_RATE
  const timeScale = Math.max(0.0001, Number(getClipTimeScale(clip)) || 1)
  const minDuration = 1 / safeFps
  const minSourceSpan = minDuration * timeScale

  let trimStart = Number(clip.trimStart)
  trimStart = Number.isFinite(trimStart) ? Math.max(0, trimStart) : 0
  trimStart = Math.min(trimStart, Math.max(0, sourceDuration - minSourceSpan))

  let duration = Number(clip.duration)
  if (!Number.isFinite(duration) || duration <= 0) duration = minDuration

  let trimEnd = Number(clip.trimEnd)
  if (!Number.isFinite(trimEnd)) {
    trimEnd = trimStart + timelineToSourceTime(clip, duration)
  }
  trimEnd = Math.min(sourceDuration, Math.max(trimStart + minSourceSpan, trimEnd))

  const maxTimelineDuration = Math.max(minDuration, sourceToTimelineTime(clip, trimEnd - trimStart))
  let alignedDuration = roundDurationToFrame(duration, safeFps)
  if (alignedDuration > maxTimelineDuration + 1e-6) {
    alignedDuration = floorDurationToFrame(maxTimelineDuration, safeFps)
  }
  if (alignedDuration > maxTimelineDuration + 1e-6) {
    alignedDuration = maxTimelineDuration
  }

  const alignedTrimEnd = Math.min(sourceDuration, trimStart + timelineToSourceTime(clip, alignedDuration))
  const minimumTrimEnd = Math.min(sourceDuration, trimStart + minSourceSpan)

  return {
    ...clip,
    sourceDuration,
    duration: Math.max(minDuration, alignedDuration),
    trimStart,
    trimEnd: Math.min(sourceDuration, Math.max(minimumTrimEnd, alignedTrimEnd)),
  }
}

const createDefaultClipTransform = () => ({
  positionX: 0,
  positionY: 0,
  scaleX: 100,
  scaleY: 100,
  scaleLinked: true,
  rotation: 0,
  anchorX: 50,
  anchorY: 50,
  opacity: 100,
  flipH: false,
  flipV: false,
  cropTop: 0,
  cropBottom: 0,
  cropLeft: 0,
  cropRight: 0,
  blendMode: 'normal',
  blur: 0,
})

const createHistorySnapshot = (state) => ({
  clips: JSON.parse(JSON.stringify(state.clips)),
  tracks: JSON.parse(JSON.stringify(state.tracks)),
  transitions: JSON.parse(JSON.stringify(state.transitions)),
  markers: JSON.parse(JSON.stringify(state.markers)),
  clipCounter: state.clipCounter,
  transitionCounter: state.transitionCounter,
  markerCounter: state.markerCounter,
})

const areHistorySnapshotsEqual = (a, b) => {
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Store for managing timeline state
 * Persisted to localStorage for data survival across refreshes
 */
export const useTimelineStore = create(
  persist(
    (set, get) => ({
  // Timeline settings
  duration: 60, // Total timeline duration in seconds
  timelineFps: 24, // Timeline frame rate; clips are quantized to frame boundaries
  zoom: 100, // Zoom level (100 = 1 second = ~20px)
  playheadPosition: 0, // Current playhead position in seconds
  isPlaying: false,
  
  // JKL Shuttle playback
  playbackRate: 1, // Playback speed multiplier (negative = reverse)
  shuttleMode: false, // Whether in JKL shuttle mode
  
  // Playback loop modes: 'normal', 'loop', 'loop-in-out', 'loop-selection', 'ping-pong'
  loopMode: 'normal',
  
  // Tracks (default: 1 video, 1 audio; user can add more)
  tracks: [
    { id: 'video-1', name: 'Video 1', type: 'video', muted: false, locked: false, visible: true },
    { id: 'audio-1', name: 'Audio 1', type: 'audio', channels: 'stereo', muted: false, locked: false, visible: true },
  ],
  
  // Clips on timeline
  clips: [],
  
  // Transitions between clips
  // Types: 'dissolve', 'fade-black', 'fade-white', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down',
  //        'slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom-in', 'zoom-out', 'blur'
  transitions: [],

  // Timeline markers
  markers: [], // [{ id, time, label, color }]
  selectedMarkerId: null,
  
  // Selected clips (multi-select support)
  selectedClipIds: [], // Array of selected clip IDs
  // Selected transition (Resolve-style transition inspector)
  selectedTransitionId: null,
  // Selected empty space / gap on a track
  selectedGap: null, // { trackId, startTime, endTime }

  // Active track for cut-at-playhead (X): only this track is cut when pressing X
  activeTrackId: null,

  // UI request: open Inspector (optionally mask picker) for a clip
  maskPickerRequest: null, // { clipId, openPicker }
  textEditRequest: null, // { clipId, selectAll, requestedAt }
  
  // Clip counter for unique IDs
  clipCounter: 1,
  
  // Transition counter for unique IDs
  transitionCounter: 1,
  markerCounter: 1,

  // Copy/paste: clips copied from timeline (not persisted)
  copiedClips: [],

  // Preview proxy (flattened timeline for smooth playback; not persisted)
  previewProxyStatus: 'none', // 'none' | 'generating' | 'ready'
  previewProxyProgress: 0,
  previewProxyPath: null,
  previewProxySignature: null,

  // Per-asset low-res proxy preference. When true, VideoLayerRenderer prefers
  // asset.proxyUrl over asset.playbackCacheUrl/url for preview only. Export
  // always uses asset.path. Hydrated from localStorage on boot in PreviewPanel.
  useProxyPlaybackForAssets: (typeof localStorage !== 'undefined' && localStorage.getItem('comfystudio-use-playback-proxies') === 'true'),
  glslPreviewQuality: (typeof localStorage !== 'undefined' && localStorage.getItem('comfystudio-glsl-preview-quality')) || 'full',
  previewCompositorMode: (typeof localStorage !== 'undefined' && localStorage.getItem('comfystudio-preview-compositor-mode')) || 'canvas',
  showTimelineClipThumbnails: (typeof localStorage === 'undefined' || localStorage.getItem('comfystudio-show-timeline-clip-thumbnails') !== 'false'),
  
  // Snapping settings
  snappingEnabled: true,
  snappingThreshold: 10, // pixels - distance at which snapping activates
  
  // Active snap indicator (for visual feedback)
  activeSnapTime: null, // Time position being snapped to (null = no active snap)
  
  // Ripple edit mode - when enabled, moving/trimming clips shifts subsequent clips
  rippleEditMode: false,
  
  // In/Out points for three-point editing
  inPoint: null, // Timeline in-point (seconds)
  outPoint: null, // Timeline out-point (seconds)
  
  // Undo/Redo history
  history: [], // Array of past states
  historyIndex: -1, // Current position in history (-1 means at present state)
  historyLastChangedAt: 0,
  
  /**
   * Save current state to history (call before making changes)
   */
  saveToHistory: () => {
    const state = get()
    const snapshot = createHistorySnapshot(state)
    
    set((state) => {
      // If we're not at the end of history, truncate the "future" states
      let newHistory = state.historyIndex >= 0 
        ? state.history.slice(0, state.historyIndex + 1)
        : [...state.history]
      
      // Add current state to history unless it's a duplicate of the last snapshot.
      const lastSnapshot = newHistory[newHistory.length - 1]
      if (!lastSnapshot || !areHistorySnapshotsEqual(lastSnapshot, snapshot)) {
        newHistory.push(snapshot)
      }
      
      // Limit history size
      if (newHistory.length > MAX_HISTORY_SIZE) {
        newHistory = newHistory.slice(newHistory.length - MAX_HISTORY_SIZE)
      }
      
      return {
        history: newHistory,
        // New edits always represent present-time state (outside the history stack).
        historyIndex: -1,
        historyLastChangedAt: Date.now(),
      }
    })
  },
  
  /**
   * Undo - restore previous state
   */
  undo: () => {
    const state = get()
    
    // If historyIndex is -1, we're at present-time state and need to
    // step back to the most recent *different* history snapshot.
    if (state.historyIndex === -1 && state.history.length > 0) {
      const currentSnapshot = createHistorySnapshot(state)
      const lastHistoryIndex = state.history.length - 1
      let targetHistoryIndex = lastHistoryIndex

      // Skip duplicate end snapshots so Undo never appears to "do nothing".
      while (
        targetHistoryIndex >= 0
        && areHistorySnapshotsEqual(state.history[targetHistoryIndex], currentSnapshot)
      ) {
        targetHistoryIndex -= 1
      }

      if (targetHistoryIndex < 0) {
        return false
      }

      const lastHistoryState = state.history[targetHistoryIndex]
      const historyWithCurrent = areHistorySnapshotsEqual(state.history[lastHistoryIndex], currentSnapshot)
        ? [...state.history]
        : [...state.history, currentSnapshot]

      set({
        clips: lastHistoryState.clips,
        tracks: lastHistoryState.tracks,
        transitions: lastHistoryState.transitions,
        markers: lastHistoryState.markers || [],
        clipCounter: lastHistoryState.clipCounter,
        transitionCounter: lastHistoryState.transitionCounter,
        markerCounter: lastHistoryState.markerCounter || 1,
        history: historyWithCurrent,
        historyIndex: targetHistoryIndex,
        historyLastChangedAt: Date.now(),
        selectedClipIds: [], // Clear selection on undo
        selectedTransitionId: null,
        selectedMarkerId: null,
        selectedGap: null,
        textEditRequest: null,
      })
      return true
    }
    
    // Normal undo - go back in history
    if (state.historyIndex > 0) {
      const prevState = state.history[state.historyIndex - 1]
      set({
        clips: prevState.clips,
        tracks: prevState.tracks,
        transitions: prevState.transitions,
        markers: prevState.markers || [],
        clipCounter: prevState.clipCounter,
        transitionCounter: prevState.transitionCounter,
        markerCounter: prevState.markerCounter || 1,
        historyIndex: state.historyIndex - 1,
        historyLastChangedAt: Date.now(),
        selectedClipIds: [], // Clear selection on undo
        selectedTransitionId: null,
        selectedMarkerId: null,
        selectedGap: null,
        textEditRequest: null,
      })
      return true
    }
    
    return false // Nothing to undo
  },
  
  /**
   * Redo - restore next state
   */
  redo: () => {
    const state = get()
    
    if (state.historyIndex >= 0 && state.historyIndex < state.history.length - 1) {
      const nextState = state.history[state.historyIndex + 1]
      set({
        clips: nextState.clips,
        tracks: nextState.tracks,
        transitions: nextState.transitions,
        markers: nextState.markers || [],
        clipCounter: nextState.clipCounter,
        transitionCounter: nextState.transitionCounter,
        markerCounter: nextState.markerCounter || 1,
        historyIndex: state.historyIndex + 1,
        historyLastChangedAt: Date.now(),
        selectedClipIds: [], // Clear selection on redo
        selectedTransitionId: null,
        selectedMarkerId: null,
        selectedGap: null,
        textEditRequest: null,
      })
      return true
    }
    
    return false // Nothing to redo
  },
  
  /**
   * Check if undo is available
   */
  canUndo: () => {
    const state = get()
    return state.history.length > 0 && (state.historyIndex === -1 || state.historyIndex > 0)
  },
  
  /**
   * Check if redo is available
   */
  canRedo: () => {
    const state = get()
    return state.historyIndex >= 0 && state.historyIndex < state.history.length - 1
  },
  
  /**
   * Clear history (e.g., on project clear)
   */
  clearHistory: () => {
    set({ history: [], historyIndex: -1, historyLastChangedAt: 0 })
  },

  /**
   * Handle clip overlaps on the same track (NLE overwrite behavior)
   * When a clip is placed, it cuts/trims any overlapping clips on the same track
   * @param {string} trackId
   * @param {string} newClipId
   * @param {number} newStartTime
   * @param {number} newDuration
   * @param {Array} [baseClips] - If provided, use this array instead of state.clips (for batch paste)
   * @param {number} [idCounter] - Optional start counter for split-clip ids
   */
  resolveOverlaps: (trackId, newClipId, newStartTime, newDuration, baseClips, idCounter) => {
    const state = get()
    const clipsToResolve = baseClips != null ? baseClips : state.clips
    const newEndTime = newStartTime + newDuration
    
    // Find all clips on the same track that overlap with the new clip (excluding itself)
    const overlappingClips = clipsToResolve.filter(clip => 
      clip.trackId === trackId &&
      clip.id !== newClipId &&
      !isSyncLockedClip(clip) &&
      clip.startTime < newEndTime &&
      clip.startTime + clip.duration > newStartTime
    )
    
    if (overlappingClips.length === 0) return { clips: clipsToResolve, addedCount: 0 }
    
    let updatedClips = [...clipsToResolve]
    let clipsToRemove = []
    let clipsToAdd = []
    
    overlappingClips.forEach(clip => {
      const clipEnd = clip.startTime + clip.duration
      
      // Case 1: New clip completely covers existing clip -> remove existing
      if (newStartTime <= clip.startTime && newEndTime >= clipEnd) {
        clipsToRemove.push(clip.id)
      }
      // Case 2: New clip cuts the beginning of existing clip -> trim existing clip's start
      else if (newStartTime <= clip.startTime && newEndTime < clipEnd) {
        const trimAmount = newEndTime - clip.startTime
        const trimAmountSource = timelineToSourceTime(clip, trimAmount)
        const idx = updatedClips.findIndex(c => c.id === clip.id)
        if (idx !== -1) {
          updatedClips[idx] = {
            ...updatedClips[idx],
            startTime: newEndTime,
            duration: clipEnd - newEndTime,
            trimStart: (clip.trimStart || 0) + trimAmountSource
          }
        }
      }
      // Case 3: New clip cuts the end of existing clip -> trim existing clip's end
      else if (newStartTime > clip.startTime && newEndTime >= clipEnd) {
        const idx = updatedClips.findIndex(c => c.id === clip.id)
        if (idx !== -1) {
          const newDuration = newStartTime - clip.startTime
          updatedClips[idx] = {
            ...updatedClips[idx],
            duration: newDuration,
            trimEnd: (clip.trimStart || 0) + timelineToSourceTime(clip, newDuration)
          }
        }
      }
      // Case 4: New clip is in the middle of existing clip -> split into two clips
      else if (newStartTime > clip.startTime && newEndTime < clipEnd) {
        // Trim the existing clip to end at newStartTime
        const idx = updatedClips.findIndex(c => c.id === clip.id)
        if (idx !== -1) {
          const firstPartDuration = newStartTime - clip.startTime
          updatedClips[idx] = {
            ...updatedClips[idx],
            duration: firstPartDuration,
            trimEnd: (clip.trimStart || 0) + timelineToSourceTime(clip, firstPartDuration)
          }
          
          // Create a second clip for the part after the new clip
          const secondPartStart = newEndTime
          const secondPartDuration = clipEnd - newEndTime
          const secondPartTrimStart = (clip.trimStart || 0) + timelineToSourceTime(clip, newEndTime - clip.startTime)
          
          const splitIdBase = idCounter != null
            ? idCounter
            : Math.max((state.clipCounter || 1) + 1, getNextClipCounter(updatedClips, state.clipCounter || 1) + 1)
          const nextId = `clip-${splitIdBase + clipsToAdd.length}`
          clipsToAdd.push({
            ...clip,
            id: nextId,
            startTime: secondPartStart,
            duration: secondPartDuration,
            trimStart: secondPartTrimStart,
            trimEnd: getClipTrimEnd(clip)
          })
        }
      }
    })
    
    // Remove fully covered clips
    updatedClips = updatedClips.filter(c => !clipsToRemove.includes(c.id))
    
    // Add split clips
    updatedClips = [...updatedClips, ...clipsToAdd]
    
    return { clips: updatedClips, addedCount: clipsToAdd.length }
  },

  /**
   * Add a clip to the timeline
   * @param {string} trackId
   * @param {object} asset
   * @param {number|null} startTime
   * @param {number|null} timelineFps
   * @param {object} [options] - Optional overrides for split/second-half: { duration, trimStart, trimEnd }
   */
  addClip: (trackId, asset, startTime = null, timelineFps = null, options = null) => {
    const state = get()
    const track = state.tracks.find(t => t.id === trackId)
    if (!track) return null
    const safeClipCounter = getNextClipCounter(state.clips, state.clipCounter || 1)
    
    if (options?.saveHistory !== false) {
      get().saveToHistory()
    }
    
    const fps = state.timelineFps || Number(timelineFps) || 24
    // Find the end of existing clips on this track if no start time specified
    const trackClips = state.clips.filter(c => c.trackId === trackId)
    const rawStartTime = startTime ?? trackClips.reduce((max, clip) =>
      Math.max(max, clip.startTime + clip.duration), 0
    )
    const calculatedStartTime = roundToFrame(rawStartTime, fps)
    // For images, use a default duration but allow extending (images have infinite source)
    // For videos/audio, use the actual source duration
    // Check both asset.duration and asset.settings.duration (different sources store it differently)
    const isImage = asset.type === 'image'
    const isVideo = asset.type === 'video'
    const assetDuration = asset.duration || asset.settings?.duration || null
    const sourceDuration = isImage ? Infinity : (assetDuration || 5)
    const sourceFps = isVideo ? Number(asset.settings?.fps ?? asset.fps) : null
    const normalizedTimelineFps = Number(timelineFps)
    const assetDefaultTransform = (
      asset?.settings?.defaultTransform
      && typeof asset.settings.defaultTransform === 'object'
    ) ? asset.settings.defaultTransform : null
    const isGeneratedOverlay = isImage && Boolean(asset?.settings?.overlayKind)
    let defaultDuration = isImage ? 5 : sourceDuration // Keep video/audio duration in real seconds
    if (isGeneratedOverlay) {
      // Overlay images (letterbox/vignette/etc.) should span to the current timeline content end
      // by default so they don't appear to "pop off" after 5 seconds.
      const timelineContentEnd = state.clips.length > 0
        ? Math.max(...state.clips.map(c => c.startTime + c.duration))
        : 0
      const remainingDuration = timelineContentEnd - calculatedStartTime
      defaultDuration = Math.max(5, remainingDuration > 0 ? remainingDuration : 0)
    }
    
    // When adding the second half of a split, pass duration/trim so we don't overwrite following clips
    const overrideDuration = options?.duration
    const overrideTrimStart = options?.trimStart
    const overrideTrimEnd = options?.trimEnd
    const linkGroupId = getNormalizedLinkGroupId(options?.linkGroupId)
    const selectAfterAdd = options?.selectAfterAdd !== false
    const shouldResolveOverlaps = options?.resolveOverlaps !== false
    const clipMetadata = options?.metadata && typeof options.metadata === 'object'
      ? JSON.parse(JSON.stringify(options.metadata))
      : null
    const rawDuration = overrideDuration != null ? overrideDuration : defaultDuration
    const finalDuration = roundDurationToFrame(rawDuration, fps)
    const finalTrimStart = overrideTrimStart != null ? overrideTrimStart : 0
    const finalTrimEnd = overrideTrimEnd != null ? overrideTrimEnd : (isImage ? finalDuration : sourceDuration)
    const syncLock = resolveClipSyncLock({
      asset,
      options,
      startTime: calculatedStartTime,
      duration: finalDuration,
      fps,
    })
    const anchoredStartTime = syncLock ? syncLock.startTime : calculatedStartTime
    const anchoredDuration = syncLock ? syncLock.duration : finalDuration
    
    // Log a warning if we couldn't get the actual duration
    if (!isImage && !assetDuration && overrideDuration == null) {
      console.warn(`Could not get duration for asset "${asset.name}", defaulting to 5 seconds`)
    }
    
    const newClip = applySyncLockToClip(clampFiniteMediaClipToSource({
      id: `clip-${safeClipCounter}`,
      trackId,
      assetId: asset.id,
      name: asset.name,
      startTime: anchoredStartTime,
      duration: anchoredDuration, // Visible duration on timeline
      sourceDuration: sourceDuration, // Original media duration (Infinity for images)
      trimStart: finalTrimStart, // In-point (seconds from source start)
      trimEnd: syncLock ? finalTrimStart + anchoredDuration : finalTrimEnd, // Out-point (for images, this can grow)
      sourceFps: Number.isFinite(sourceFps) && sourceFps > 0 ? sourceFps : null,
      timelineFps: Number.isFinite(normalizedTimelineFps) && normalizedTimelineFps > 0 ? normalizedTimelineFps : null,
      sourceTimeScale: 1,
      speed: 1,
      reverse: false,
      gainDb: asset.type === 'audio' ? normalizeAudioClipGainDb(options?.gainDb) : undefined,
      fadeIn: asset.type === 'audio' ? clampAudioFadeDuration(options?.fadeIn, finalDuration) : undefined,
      fadeOut: asset.type === 'audio' ? clampAudioFadeDuration(options?.fadeOut, finalDuration) : undefined,
      color: track.type === 'video' ? getVideoColor(safeClipCounter) : getAudioColor(track.id),
      type: asset.type,
      enabled: options?.enabled !== false,
      ...(track.type === 'video' ? { compositeLowerLayers: CLIP_COMPOSITE_MODE.AUTO } : {}),
      url: asset.url,
      thumbnail: asset.url, // For video clips
      ...(clipMetadata ? { metadata: clipMetadata } : {}),
      ...(syncLock ? { lockMode: 'sync', syncLock } : {}),
      ...(linkGroupId ? { linkGroupId } : {}),
      // 2D Transform properties (NLE-style)
      transform: {
        ...createDefaultClipTransform(),
        ...(assetDefaultTransform || {}),
        blendMode: assetDefaultTransform?.blendMode ?? 'normal',
      },
    }, fps), fps)
    
    // Resolve overlaps with existing clips on the same track (NLE overwrite behavior)
    // Use finalDuration so split second-half doesn't push following clips (when options.duration set)
    const { clips: updatedClips, addedCount } = shouldResolveOverlaps
      ? get().resolveOverlaps(
        trackId,
        newClip.id,
        anchoredStartTime,
        newClip.duration,
        undefined,
        safeClipCounter + 1
      )
      : { clips: state.clips, addedCount: 0 }
    
    set((state) => ({
      clips: [...updatedClips, newClip],
      clipCounter: Math.max(state.clipCounter, safeClipCounter + 1 + addedCount),
      selectedClipIds: selectAfterAdd ? [newClip.id] : state.selectedClipIds,
      // Extend timeline if needed
      duration: Math.max(state.duration, newClip.startTime + newClip.duration + 10)
    }))
    
    return newClip
  },

  /**
   * Add a text clip to the timeline
   * @param {string} trackId - Target video track ID
   * @param {object} textOptions - Text configuration options
   * @param {number|null} startTime - Start time (null = end of existing clips)
   */
  addTextClip: (trackId, textOptions = {}, startTime = null) => {
    const state = get()
    const track = state.tracks.find(t => t.id === trackId)
    if (!track || track.type !== 'video') return null
    const safeClipCounter = getNextClipCounter(state.clips, state.clipCounter || 1)
    
    if (textOptions?.saveHistory !== false) {
      get().saveToHistory()
    }
    
    const fps = state.timelineFps || 24
    // Find the end of existing clips on this track if no start time specified
    const trackClips = state.clips.filter(c => c.trackId === trackId)
    const rawStartTime = startTime ?? trackClips.reduce((max, clip) =>
      Math.max(max, clip.startTime + clip.duration), 0
    )
    const calculatedStartTime = roundToFrame(rawStartTime, fps)
    
    // Default text properties
    const defaultText = {
      text: textOptions.text || 'Sample Text',
      fontFamily: textOptions.fontFamily || 'Inter',
      fontSize: textOptions.fontSize || 64,
      fontWeight: textOptions.fontWeight || 'bold',
      fontStyle: textOptions.fontStyle || 'normal',
      textColor: textOptions.textColor || '#FFFFFF',
      backgroundColor: textOptions.backgroundColor || 'transparent',
      backgroundOpacity: textOptions.backgroundOpacity || 0,
      backgroundPadding: textOptions.backgroundPadding || 20,
      textAlign: textOptions.textAlign || 'center',
      verticalAlign: textOptions.verticalAlign || 'center',
      strokeColor: textOptions.strokeColor || '#000000',
      strokeWidth: textOptions.strokeWidth || 0,
      letterSpacing: textOptions.letterSpacing || 0,
      lineHeight: textOptions.lineHeight || 1.2,
      shadow: textOptions.shadow || false,
      shadowColor: textOptions.shadowColor || 'rgba(0,0,0,0.5)',
      shadowBlur: textOptions.shadowBlur || 4,
      shadowOffsetX: textOptions.shadowOffsetX || 2,
      shadowOffsetY: textOptions.shadowOffsetY || 2,
    }
    
    const duration = roundDurationToFrame(textOptions.duration || 5, fps)
    
    const newClip = {
      id: `clip-${safeClipCounter}`,
      trackId,
      assetId: null, // Text clips don't have asset references
      name: defaultText.text.substring(0, 20) + (defaultText.text.length > 20 ? '...' : ''),
      startTime: calculatedStartTime,
      duration,
      sourceDuration: duration,
      trimStart: 0,
      trimEnd: duration,
      color: '#565C6B', // Muted blue for text clips
      type: 'text',
      enabled: textOptions?.enabled !== false,
      compositeLowerLayers: CLIP_COMPOSITE_MODE.AUTO,
      url: null,
      thumbnail: null,
      // Text-specific properties
      textProperties: defaultText,
      // Metadata for preset-based text title animation
      titleAnimation: null,
      // 2D Transform properties (same as video clips)
      transform: {
        positionX: 0,
        positionY: 0,
        scaleX: 100,
        scaleY: 100,
        scaleLinked: true,
        rotation: 0,
        anchorX: 50,
        anchorY: 50,
        opacity: 100,
        flipH: false,
        flipV: false,
        cropTop: 0,
        cropBottom: 0,
        cropLeft: 0,
        cropRight: 0,
        blendMode: 'normal',
        blur: 0,
      },
    }
    
    // Resolve overlaps with existing clips on the same track
    const { clips: updatedClips, addedCount } = get().resolveOverlaps(
      trackId, 
      newClip.id, 
      calculatedStartTime, 
      duration,
      undefined,
      safeClipCounter + 1
    )
    
    set((state) => ({
      clips: [...updatedClips, newClip],
      clipCounter: Math.max(state.clipCounter, safeClipCounter + 1 + addedCount),
      selectedClipIds: [newClip.id],
      duration: Math.max(state.duration, calculatedStartTime + newClip.duration + 10)
    }))
    
    return newClip
  },

  /**
   * Add an adjustment layer clip to the timeline.
   * Adjustment layers have no media source and apply filters to clips below.
   * @param {string} trackId - Target video track ID
   * @param {number|null} startTime - Start time (null = end of existing clips)
   * @param {object} options - { duration?: number, name?: string, adjustments?: object, transform?: object }
   */
  addAdjustmentClip: (trackId, startTime = null, options = {}) => {
    const state = get()
    const track = state.tracks.find(t => t.id === trackId)
    if (!track || track.type !== 'video') return null
    const safeClipCounter = getNextClipCounter(state.clips, state.clipCounter || 1)

    if (options?.saveHistory !== false) {
      get().saveToHistory()
    }

    const fps = state.timelineFps || 24
    const trackClips = state.clips.filter(c => c.trackId === trackId)
    const rawStartTime = startTime ?? trackClips.reduce((max, clip) =>
      Math.max(max, clip.startTime + clip.duration), 0
    )
    const calculatedStartTime = roundToFrame(rawStartTime, fps)
    const duration = roundDurationToFrame(options?.duration ?? 5, fps)

    const newClip = {
      id: `clip-${safeClipCounter}`,
      trackId,
      assetId: null,
      name: options?.name || 'Adjustment Layer',
      startTime: calculatedStartTime,
      duration,
      sourceDuration: Infinity,
      trimStart: 0,
      trimEnd: duration,
      sourceTimeScale: 1,
      speed: 1,
      reverse: false,
      color: '#6f569a',
      type: 'adjustment',
      enabled: options?.enabled !== false,
      url: null,
      thumbnail: null,
      adjustments: normalizeAdjustmentSettings(options?.adjustments || {}),
      transform: {
        ...createDefaultClipTransform(),
        ...(options?.transform || {}),
        blendMode: options?.transform?.blendMode ?? 'normal',
      },
    }

    const { clips: updatedClips, addedCount } = get().resolveOverlaps(
      trackId,
      newClip.id,
      calculatedStartTime,
      duration,
      undefined,
      safeClipCounter + 1
    )

    set((state) => ({
      clips: [...updatedClips, newClip],
      clipCounter: Math.max(state.clipCounter, safeClipCounter + 1 + addedCount),
      selectedClipIds: [newClip.id],
      duration: Math.max(state.duration, calculatedStartTime + newClip.duration + 10)
    }))

    return newClip
  },

  /**
   * Update text clip properties
   * @param {string} clipId - The text clip to update
   * @param {object} textUpdates - Partial text properties object
   * @param {boolean} saveHistory - Whether to save to history
   */
  updateTextProperties: (clipId, textUpdates, saveHistory = false) => {
    if (saveHistory) {
      get().saveToHistory()
    }
    
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId || clip.type !== 'text') return clip
        
        const currentText = clip.textProperties || {}
        const updatedText = { ...currentText, ...textUpdates }
        
        // Update clip name if text content changed
        const newName = textUpdates.text 
          ? textUpdates.text.substring(0, 20) + (textUpdates.text.length > 20 ? '...' : '')
          : clip.name
        
        return {
          ...clip,
          name: newName,
          textProperties: updatedText
        }
      })
    }))
  },

  /**
   * Remove a clip (or multiple clips if they're selected)
   */
  removeClip: (clipId) => {
    // Save to history before modifying
    get().saveToHistory()

    set((state) => {
      const targetIds = new Set(expandClipIdsWithLinked(state.clips, [clipId]))
      return {
        clips: state.clips.filter(c => !targetIds.has(c.id)),
        selectedClipIds: state.selectedClipIds.filter(id => !targetIds.has(id))
      }
    })
  },

  /**
   * Remove all selected clips
   */
  removeSelectedClips: () => {
    // Save to history before modifying
    get().saveToHistory()

    set((state) => {
      const targetIds = new Set(expandClipIdsWithLinked(state.clips, state.selectedClipIds))
      return {
        clips: state.clips.filter(c => !targetIds.has(c.id)),
        selectedClipIds: []
      }
    })
  },

  rippleDeleteClipIds: (clipIds = []) => {
    const state = get()
    const targetIds = expandClipIdsWithLinked(state.clips, clipIds)
    if (targetIds.length === 0) return false

    const targetIdSet = new Set(targetIds)
    const targetClips = state.clips.filter((clip) => targetIdSet.has(clip.id))
    if (targetClips.length === 0) return false

    const rippleRangesByTrack = new Map()
    targetClips.forEach((clip) => {
      const baseRange = getClipBaseRange(clip, state.transitions)
      const existingRanges = rippleRangesByTrack.get(clip.trackId) || []
      existingRanges.push(baseRange)
      rippleRangesByTrack.set(clip.trackId, existingRanges)
    })

    for (const [trackId, ranges] of rippleRangesByTrack.entries()) {
      rippleRangesByTrack.set(trackId, mergeTimeRanges(ranges))
    }

    const fps = state.timelineFps || 24
    get().saveToHistory()

    set((currentState) => {
      const remainingClips = currentState.clips.filter((clip) => !targetIdSet.has(clip.id))
      const cleanedState = cleanupBrokenBetweenTransitions(remainingClips, currentState.transitions)
      const rippledClips = cleanedState.clips.map((clip) => {
        const trackRanges = rippleRangesByTrack.get(clip.trackId)
        if (!trackRanges || trackRanges.length === 0) return clip

        const shiftAmount = getRippleShiftAmount(clip.startTime, trackRanges)
        if (shiftAmount <= RIPPLE_TIME_EPSILON) return clip

        return {
          ...clip,
          startTime: roundToFrame(Math.max(0, clip.startTime - shiftAmount), fps),
        }
      })

      return {
        clips: rippledClips,
        transitions: cleanedState.transitions,
        selectedClipIds: [],
        selectedTransitionId: null,
        selectedGap: null,
      }
    })

    return true
  },

  rippleDeleteSelectedClips: () => {
    const state = get()
    return get().rippleDeleteClipIds(state.selectedClipIds)
  },

  rippleDeleteSelectedGap: () => {
    const state = get()
    const selectedGap = state.selectedGap
    if (!selectedGap?.trackId || !Number.isFinite(selectedGap?.startTime) || !Number.isFinite(selectedGap?.endTime)) {
      return false
    }

    const gapRange = mergeTimeRanges([{
      start: Math.max(0, selectedGap.startTime),
      end: Math.max(0, selectedGap.endTime),
    }])
    if (gapRange.length === 0) {
      set({ selectedGap: null })
      return false
    }

    const fps = state.timelineFps || 24
    get().saveToHistory()

    set((currentState) => {
      const linkGroupShiftAmounts = new Map()

      currentState.clips.forEach((clip) => {
        if (clip.trackId !== selectedGap.trackId) return

        const shiftAmount = getRippleShiftAmount(clip.startTime, gapRange)
        if (shiftAmount <= RIPPLE_TIME_EPSILON) return

        const linkGroupId = getNormalizedLinkGroupId(clip.linkGroupId)
        if (!linkGroupId) return

        const existingShiftAmount = linkGroupShiftAmounts.get(linkGroupId) || 0
        linkGroupShiftAmounts.set(linkGroupId, Math.max(existingShiftAmount, shiftAmount))
      })

      const shiftedClips = currentState.clips.map((clip) => {
        const directTrackShift = clip.trackId === selectedGap.trackId
          ? getRippleShiftAmount(clip.startTime, gapRange)
          : 0
        const linkedShift = linkGroupShiftAmounts.get(getNormalizedLinkGroupId(clip.linkGroupId)) || 0
        const shiftAmount = Math.max(directTrackShift, linkedShift)

        if (shiftAmount <= RIPPLE_TIME_EPSILON) return clip

        return {
          ...clip,
          startTime: roundToFrame(Math.max(0, clip.startTime - shiftAmount), fps),
        }
      })

      const cleanedState = cleanupBrokenBetweenTransitions(shiftedClips, currentState.transitions)

      return {
        clips: cleanedState.clips,
        transitions: cleanedState.transitions,
        selectedClipIds: [],
        selectedTransitionId: null,
        selectedMarkerId: null,
        selectedGap: null,
      }
    })

    return true
  },

  /**
   * Copy selected clips to internal buffer (for paste at playhead)
   */
  copySelectedClips: () => {
    const state = get()
    if (state.selectedClipIds.length === 0) return
    const selectedIds = expandClipIdsWithLinked(state.clips, state.selectedClipIds)
    const selected = state.clips.filter(c => selectedIds.includes(c.id))
    if (selected.length === 0) return
    const minStart = Math.min(...selected.map(c => c.startTime))
    const withRelative = selected.map(c => ({ ...c, relativeStart: c.startTime - minStart }))
    set({ copiedClips: withRelative })
  },

  /**
   * Paste copied clips at playhead on the given track. Only pastes clips that match track type.
   * @param {string} trackId - Active track ID
   * @param {number} startTime - Playhead position (seconds)
   * @param {Array} assets - Assets array (from assetsStore) to resolve assetId for video/image/audio
   */
  pasteClipsAtPlayhead: (trackId, startTime, assets = []) => {
    const state = get()
    const track = state.tracks.find(t => t.id === trackId)
    if (!track || state.copiedClips.length === 0) return

    const fps = state.timelineFps || 24
    const isVideoTrack = track.type === 'video'
    const isAudioTrack = track.type === 'audio'
    const matchesTrack = (t) =>
      (isVideoTrack && (t.type === 'video' || t.type === 'image' || t.type === 'text' || t.type === 'adjustment')) ||
      (isAudioTrack && t.type === 'audio')

    const toPaste = state.copiedClips.filter(matchesTrack).sort((a, b) => (a.relativeStart ?? 0) - (b.relativeStart ?? 0))
    if (toPaste.length === 0) return

    get().saveToHistory()

    const assetsById = new Map((assets || []).map(a => [a.id, a]))
    let clips = [...state.clips]
    let clipCounter = getNextClipCounter(state.clips, state.clipCounter || 1)
    const newIds = []
    const pastedLinkGroups = new Map()

    const getPastedLinkGroupId = (sourceLinkGroupId) => {
      const normalized = getNormalizedLinkGroupId(sourceLinkGroupId)
      if (!normalized) return undefined
      if (!pastedLinkGroups.has(normalized)) {
        pastedLinkGroups.set(normalized, buildLinkGroupId(`paste-${clipCounter + pastedLinkGroups.size}`))
      }
      return pastedLinkGroups.get(normalized)
    }

    for (const template of toPaste) {
      const clipStartTime = roundToFrame(startTime + (template.relativeStart ?? 0), fps)
      const pastedLinkGroupId = getPastedLinkGroupId(template.linkGroupId)
      if (template.type === 'adjustment') {
        const rawDuration = template.duration ?? 5
        const duration = roundDurationToFrame(rawDuration, fps)
        const newClip = {
          id: `clip-${clipCounter}`,
          trackId,
          assetId: null,
          name: template.name || 'Adjustment Layer',
          startTime: clipStartTime,
          duration,
          sourceDuration: Infinity,
          trimStart: 0,
          trimEnd: duration,
          sourceTimeScale: 1,
          speed: 1,
          reverse: false,
          color: '#6f569a',
          type: 'adjustment',
          enabled: template.enabled !== false,
          url: null,
          thumbnail: null,
          adjustments: normalizeAdjustmentSettings(template.adjustments || {}),
          transform: {
            ...createDefaultClipTransform(),
            ...(template.transform || {}),
            blendMode: template.transform?.blendMode ?? 'normal',
          },
          ...(pastedLinkGroupId ? { linkGroupId: pastedLinkGroupId } : {}),
          keyframes: template.keyframes ? JSON.parse(JSON.stringify(template.keyframes)) : undefined,
        }
        clipCounter += 1
        const result = get().resolveOverlaps(trackId, newClip.id, clipStartTime, duration, clips, clipCounter)
        clips = [...result.clips, newClip]
        clipCounter += result.addedCount
        newIds.push(newClip.id)
      } else if (template.type === 'text') {
        const rawDuration = template.duration ?? 5
        const duration = roundDurationToFrame(rawDuration, fps)
        const textOptions = {
          ...(template.textProperties || {}),
          duration,
        }
        const textLabel = (template.textProperties?.text || template.name || 'Text')
        const newClip = {
          id: `clip-${clipCounter}`,
          trackId,
          assetId: null,
          name: textLabel.substring(0, 20) + (textLabel.length > 20 ? '...' : ''),
          startTime: clipStartTime,
          duration,
          sourceDuration: duration,
          trimStart: 0,
          trimEnd: duration,
          color: '#565C6B',
          type: 'text',
          enabled: template.enabled !== false,
          url: null,
          thumbnail: null,
          textProperties: { ...(template.textProperties || {}) },
          transform: { ...(template.transform || {}), blendMode: template.transform?.blendMode ?? 'normal' },
          ...(pastedLinkGroupId ? { linkGroupId: pastedLinkGroupId } : {}),
          keyframes: template.keyframes ? JSON.parse(JSON.stringify(template.keyframes)) : undefined,
        }
        clipCounter += 1
        const result = get().resolveOverlaps(trackId, newClip.id, clipStartTime, newClip.duration, clips, clipCounter)
        clips = [...result.clips, newClip]
        clipCounter += result.addedCount
        newIds.push(newClip.id)
      } else {
        const asset = template.assetId ? assetsById.get(template.assetId) : null
        if (!asset) continue
        const sourceDuration = template.sourceDuration ?? (asset.duration || asset.settings?.duration) ?? 5
        const isImage = template.type === 'image'
        const rawDuration = template.duration ?? (isImage ? 5 : sourceDuration)
        const duration = roundDurationToFrame(rawDuration, fps)
        const newClip = clampFiniteMediaClipToSource({
          id: `clip-${clipCounter}`,
          trackId,
          assetId: asset.id,
          name: template.name ?? asset.name,
          startTime: clipStartTime,
          duration,
          sourceDuration: isImage ? Infinity : sourceDuration,
          trimStart: template.trimStart ?? 0,
          trimEnd: template.trimEnd ?? (isImage ? duration : sourceDuration),
          sourceFps: template.sourceFps ?? null,
          timelineFps: template.timelineFps ?? null,
          sourceTimeScale: template.sourceTimeScale ?? 1,
          speed: template.speed ?? 1,
          reverse: template.reverse ?? false,
          gainDb: template.type === 'audio' ? normalizeAudioClipGainDb(template.gainDb) : undefined,
          fadeIn: template.type === 'audio' ? clampAudioFadeDuration(template.fadeIn, duration) : undefined,
          fadeOut: template.type === 'audio' ? clampAudioFadeDuration(template.fadeOut, duration) : undefined,
          color: isVideoTrack ? getVideoColor(clipCounter) : getAudioColor(track.id),
          type: template.type,
          enabled: template.enabled !== false,
          url: asset.url,
          thumbnail: asset.url,
          transform: { ...(template.transform || {}), blendMode: template.transform?.blendMode ?? 'normal' },
          ...(pastedLinkGroupId ? { linkGroupId: pastedLinkGroupId } : {}),
          effects: template.effects ? [...template.effects] : undefined,
          keyframes: template.keyframes ? JSON.parse(JSON.stringify(template.keyframes)) : undefined,
        }, fps)
        clipCounter += 1
        const result = get().resolveOverlaps(trackId, newClip.id, clipStartTime, newClip.duration, clips, clipCounter)
        clips = [...result.clips, newClip]
        clipCounter += result.addedCount
        newIds.push(newClip.id)
      }
    }

    const maxEnd = Math.max(...clips.map(c => c.startTime + c.duration), startTime + 1)
    set({
      clips,
      clipCounter,
      selectedClipIds: newIds.length > 0 ? newIds : state.selectedClipIds,
      duration: Math.max(state.duration, maxEnd + 10),
    })
  },

  /**
   * Remove audio clips that reference a specific asset
   */
  removeAudioClipsForAsset: (assetId) => {
    const state = get()
    const audioTrackIds = new Set(state.tracks.filter(t => t.type === 'audio').map(t => t.id))
    const isAudioClipForAsset = (c) => c.assetId === assetId && audioTrackIds.has(c.trackId)
    const nextClips = state.clips.filter(c => !isAudioClipForAsset(c))
    if (nextClips.length === state.clips.length) return

    // Save to history before modifying
    get().saveToHistory()

    const nextSelected = state.selectedClipIds.filter(id => nextClips.some(c => c.id === id))
    set((prev) => ({
      ...prev,
      clips: nextClips,
      selectedClipIds: nextSelected
    }))
  },

  getLinkedClipIds: (clipIds = []) => {
    const state = get()
    return expandClipIdsWithLinked(state.clips, clipIds)
  },

  linkSelectedClips: () => {
    const state = get()
    const targetIds = expandClipIdsWithLinked(state.clips, state.selectedClipIds)
    if (targetIds.length < 2) return false

    const linkGroupId = buildLinkGroupId(`manual-${getNextClipCounter(state.clips, state.clipCounter || 1)}`)
    get().saveToHistory()

    set((state) => ({
      clips: state.clips.map((clip) => (
        targetIds.includes(clip.id)
          ? { ...clip, linkGroupId }
          : clip
      )),
      selectedClipIds: targetIds,
    }))

    return true
  },

  unlinkSelectedClips: () => {
    const state = get()
    const targetIds = expandClipIdsWithLinked(state.clips, state.selectedClipIds)
    const hasLinkedClip = targetIds.some((clipId) => {
      const clip = state.clips.find((candidate) => candidate.id === clipId)
      return Boolean(getNormalizedLinkGroupId(clip?.linkGroupId))
    })
    if (!hasLinkedClip) return false

    get().saveToHistory()
    set((state) => ({
      clips: state.clips.map((clip) => {
        if (!targetIds.includes(clip.id)) return clip
        const { linkGroupId, ...rest } = clip
        return rest
      }),
      selectedClipIds: targetIds,
    }))

    return true
  },

  /**
   * Move a clip to a new position/track
   * @param {string} clipId - The clip to move
   * @param {string} newTrackId - The target track ID
   * @param {number} newStartTime - The new start time
   * @param {boolean} resolveOverlaps - Whether to cut overlapping clips (default: false, set true on drag end)
   */
  moveClip: (clipId, newTrackId, newStartTime, resolveOverlaps = false) => {
    const state = get()
    const clip = state.clips.find(c => c.id === clipId)
    if (!clip) return
    
    // History for interactive drags is captured by the UI gesture start.
    // Keep this mutation history-neutral to avoid no-op undo states.
    
    const fps = state.timelineFps || 24
    const requestedStartTime = roundToFrame(Math.max(0, newStartTime), fps)
    const finalStartTime = isSyncLockedClip(clip)
      ? applySyncLockToClip({ ...clip, startTime: requestedStartTime }, fps).startTime
      : requestedStartTime
    const delta = finalStartTime - clip.startTime
    
    set((state) => {
      // First, update the clip position
      let updatedClips = state.clips.map(c => 
        c.id === clipId 
          ? applySyncLockToClip({ ...c, trackId: newTrackId, startTime: finalStartTime }, fps)
          : c
      )
      
      // If ripple mode is on and we're moving forward, shift subsequent clips
      if (state.rippleEditMode && delta !== 0) {
        updatedClips = updatedClips.map(c => {
          // Only affect clips on the same track that come after the moved clip
          if (c.id !== clipId && c.trackId === clip.trackId && c.startTime > clip.startTime) {
            return { ...c, startTime: Math.max(0, c.startTime + delta) }
          }
          return c
        })
      }
      
      let clipCounterDelta = 0
      // Only resolve overlaps if explicitly requested (on drag end)
      if (resolveOverlaps) {
        const movedClip = updatedClips.find(c => c.id === clipId)
        if (movedClip) {
          const newEndTime = finalStartTime + movedClip.duration
          
          // Find all clips on the same track that overlap (excluding the moved clip)
          const overlappingClips = updatedClips.filter(c => 
            c.trackId === newTrackId &&
            c.id !== clipId &&
            !isSyncLockedClip(c) &&
            c.startTime < newEndTime &&
            c.startTime + c.duration > finalStartTime
          )
          
          if (overlappingClips.length > 0) {
            let clipsToRemove = []
            let clipsToAdd = []
            
            overlappingClips.forEach(existingClip => {
              const clipEnd = existingClip.startTime + existingClip.duration
              
              // Case 1: Moved clip completely covers existing clip -> remove existing
              if (finalStartTime <= existingClip.startTime && newEndTime >= clipEnd) {
                clipsToRemove.push(existingClip.id)
              }
              // Case 2: Moved clip cuts the beginning of existing clip -> trim existing clip's start
              else if (finalStartTime <= existingClip.startTime && newEndTime < clipEnd) {
                const trimAmount = newEndTime - existingClip.startTime
                const trimAmountSource = timelineToSourceTime(existingClip, trimAmount)
                const idx = updatedClips.findIndex(c => c.id === existingClip.id)
                if (idx !== -1) {
                  updatedClips[idx] = {
                    ...updatedClips[idx],
                    startTime: newEndTime,
                    duration: clipEnd - newEndTime,
                    trimStart: (existingClip.trimStart || 0) + trimAmountSource
                  }
                }
              }
              // Case 3: Moved clip cuts the end of existing clip -> trim existing clip's end
              else if (finalStartTime > existingClip.startTime && newEndTime >= clipEnd) {
                const idx = updatedClips.findIndex(c => c.id === existingClip.id)
                if (idx !== -1) {
                  const newDuration = finalStartTime - existingClip.startTime
                  updatedClips[idx] = {
                    ...updatedClips[idx],
                    duration: newDuration,
                    trimEnd: (existingClip.trimStart || 0) + timelineToSourceTime(existingClip, newDuration)
                  }
                }
              }
              // Case 4: Moved clip is in the middle of existing clip -> split into two clips
              else if (finalStartTime > existingClip.startTime && newEndTime < clipEnd) {
                // Trim the existing clip to end at finalStartTime
                const idx = updatedClips.findIndex(c => c.id === existingClip.id)
                if (idx !== -1) {
                  const firstPartDuration = finalStartTime - existingClip.startTime
                  updatedClips[idx] = {
                    ...updatedClips[idx],
                    duration: firstPartDuration,
                    trimEnd: (existingClip.trimStart || 0) + timelineToSourceTime(existingClip, firstPartDuration)
                  }
                  
                  // Create a second clip for the part after the moved clip
                  const secondPartStart = newEndTime
                  const secondPartDuration = clipEnd - newEndTime
                  const secondPartTrimStart = (existingClip.trimStart || 0) + timelineToSourceTime(existingClip, newEndTime - existingClip.startTime)
                  
                  clipsToAdd.push({
                    ...existingClip,
                    id: `clip-${state.clipCounter + clipsToAdd.length + 1}`,
                    startTime: secondPartStart,
                    duration: secondPartDuration,
                    trimStart: secondPartTrimStart,
                    trimEnd: getClipTrimEnd(existingClip)
                  })
                }
              }
            })
            
            // Remove fully covered clips
            updatedClips = updatedClips.filter(c => !clipsToRemove.includes(c.id))
            
            // Add split clips
            updatedClips = [...updatedClips, ...clipsToAdd]
            clipCounterDelta = clipsToAdd.length
          }
        }
      }

      // When committing a move (resolveOverlaps), remove transitions that are now broken:
        // the two clips are no longer adjacent on the same track, so the transition can't be shown/removed in the UI.
        let finalClips = updatedClips
        let finalTransitions = state.transitions
        if (resolveOverlaps && state.transitions.length > 0) {
          const isBroken = (t, clips) => {
            if (t.kind !== 'between') return false
            const a = clips.find(c => c.id === t.clipAId)
            const b = clips.find(c => c.id === t.clipBId)
            if (!a || !b) return true
            if (a.trackId !== b.trackId) return true
            const trackClips = clips.filter(c => c.trackId === a.trackId).sort((x, y) => x.startTime - y.startTime)
            const i = trackClips.findIndex(c => c.id === a.id)
            const j = trackClips.findIndex(c => c.id === b.id)
            return Math.abs(i - j) !== 1
          }
          const broken = state.transitions.filter(t => isBroken(t, finalClips))
          if (broken.length > 0) {
            const brokenIds = new Set(broken.map(t => t.id))
            for (const t of broken) {
              finalClips = finalClips.map(c => {
                if (c.id === t.clipAId && t.originalClipAEnd != null && t.originalClipATrimEnd != null) {
                  return { ...c, duration: t.originalClipAEnd - c.startTime, trimEnd: t.originalClipATrimEnd }
                }
                if (c.id === t.clipBId && t.originalClipBStart != null && t.originalClipBTrimStart != null) {
                  const durationDiff = c.startTime - t.originalClipBStart
                  return { ...c, startTime: t.originalClipBStart, duration: c.duration - durationDiff, trimStart: t.originalClipBTrimStart }
                }
                return c
              })
            }
            finalTransitions = state.transitions.filter(t => !brokenIds.has(t.id))
          }
        }

        const out = { clips: finalClips }
        if (finalTransitions !== state.transitions) out.transitions = finalTransitions
        if (clipCounterDelta > 0) out.clipCounter = state.clipCounter + clipCounterDelta
        return out
    })
  },

  /**
   * Set start times of selected clips to given values (used for multi-clip drag so motion stays 1:1 with mouse).
   * @param {Array<{ id: string, startTime: number }>} updates - Per-clip start times for selected clips
   * @param {Array<string>|null} clipIdsOverride - Optional explicit clip ids to update instead of current selection
   */
  setSelectedClipsStartTimes: (updates, clipIdsOverride = null) => {
    get().setSelectedClipPositions(updates, clipIdsOverride)
  },

  /**
   * Set positions of selected clips to given values (used for multi-clip drag so motion stays 1:1 with mouse).
   * @param {Array<{ id: string, startTime: number, trackId?: string }>} updates - Per-clip position updates
   * @param {Array<string>|null} clipIdsOverride - Optional explicit clip ids to update instead of current selection
   */
  setSelectedClipPositions: (updates, clipIdsOverride = null) => {
    const state = get()
    const fps = state.timelineFps || 24
    const targetIds = new Set(
      Array.isArray(clipIdsOverride) && clipIdsOverride.length > 0
        ? dedupeClipIds(clipIdsOverride)
        : state.selectedClipIds
    )
    const map = new Map(updates.map((u) => [u.id, {
      startTime: roundToFrame(Math.max(0, u.startTime), fps),
      trackId: typeof u.trackId === 'string' ? u.trackId : undefined,
    }]))
    set((state) => ({
      clips: state.clips.map((clip) => {
        if (!targetIds.has(clip.id)) return clip
        const nextPosition = map.get(clip.id)
        if (!nextPosition) return clip
        return applySyncLockToClip({
          ...clip,
          startTime: nextPosition.startTime,
          trackId: nextPosition.trackId ?? clip.trackId,
        }, fps)
      })
    }))
  },

  /**
   * Move all selected clips by a delta amount
   * @param {number} deltaTime - The time delta to move by
   * @param {string|null} newTrackId - Optional new track ID
   * @param {boolean} resolveOverlaps - Whether to cut overlapping clips (default: false, set true on drag end)
   * @param {Array<string>|null} clipIdsOverride - Optional explicit clip ids to move instead of current selection
   */
  moveSelectedClips: (deltaTime, newTrackId = null, resolveOverlaps = false, clipIdsOverride = null) => {
    // History for interactive drags is captured by the UI gesture start.
    // Keep this mutation history-neutral to avoid no-op undo states.
    
    const fps = get().timelineFps || 24
    set((state) => {
      const movingClipIds = dedupeClipIds(
        Array.isArray(clipIdsOverride) && clipIdsOverride.length > 0
          ? clipIdsOverride
          : state.selectedClipIds
      )
      const movingClipIdSet = new Set(movingClipIds)

      // First, move all selected clips (frame-aligned)
      let updatedClips = state.clips.map(clip => {
        if (movingClipIdSet.has(clip.id)) {
          const rawStart = Math.max(0, clip.startTime + deltaTime)
          return applySyncLockToClip({
            ...clip,
            startTime: roundToFrame(rawStart, fps),
            trackId: newTrackId !== null ? newTrackId : clip.trackId
          }, fps)
        }
        return clip
      })
      
      // Only resolve overlaps if explicitly requested (on drag end)
      if (!resolveOverlaps) {
        return { clips: updatedClips }
      }
      
      // Now resolve overlaps for each moved clip (NLE overwrite behavior)
      // This is done after all clips are moved to handle them as a group
      let clipsToRemove = []
      let clipsToAdd = []
      let addedCounter = 0
      const trackOrder = new Map(state.tracks.map((track, index) => [track.id, index]))
      const movedClips = updatedClips
        .filter((clip) => movingClipIdSet.has(clip.id))
        .sort((a, b) => {
          const trackIndexA = trackOrder.get(a.trackId) ?? Number.MAX_SAFE_INTEGER
          const trackIndexB = trackOrder.get(b.trackId) ?? Number.MAX_SAFE_INTEGER
          if (trackIndexA !== trackIndexB) return trackIndexA - trackIndexB
          if (a.startTime !== b.startTime) return a.startTime - b.startTime
          if (a.duration !== b.duration) return b.duration - a.duration
          return String(a.id).localeCompare(String(b.id))
        })
      
      movedClips.forEach((movedClip) => {
        const newStartTime = movedClip.startTime
        const newEndTime = newStartTime + movedClip.duration
        const trackId = movedClip.trackId
        
        // Find all clips on the same track that overlap (excluding moved/selected clips)
        const overlappingClips = updatedClips.filter(c => 
          c.trackId === trackId &&
          !movingClipIdSet.has(c.id) &&
          !clipsToRemove.includes(c.id) &&
          !isSyncLockedClip(c) &&
          c.startTime < newEndTime &&
          c.startTime + c.duration > newStartTime
        )
        
        overlappingClips.forEach(existingClip => {
          const clipEnd = existingClip.startTime + existingClip.duration
          
          // Case 1: Moved clip completely covers existing clip -> remove existing
          if (newStartTime <= existingClip.startTime && newEndTime >= clipEnd) {
            clipsToRemove.push(existingClip.id)
          }
          // Case 2: Moved clip cuts the beginning of existing clip
          else if (newStartTime <= existingClip.startTime && newEndTime < clipEnd) {
            const trimAmount = newEndTime - existingClip.startTime
            const idx = updatedClips.findIndex(c => c.id === existingClip.id)
            if (idx !== -1) {
              const trimAmountSource = timelineToSourceTime(existingClip, trimAmount)
              updatedClips[idx] = {
                ...updatedClips[idx],
                startTime: newEndTime,
                duration: clipEnd - newEndTime,
                trimStart: (existingClip.trimStart || 0) + trimAmountSource
              }
            }
          }
          // Case 3: Moved clip cuts the end of existing clip
          else if (newStartTime > existingClip.startTime && newEndTime >= clipEnd) {
            const idx = updatedClips.findIndex(c => c.id === existingClip.id)
            if (idx !== -1) {
              const newDuration = newStartTime - existingClip.startTime
              updatedClips[idx] = {
                ...updatedClips[idx],
                duration: newDuration,
                trimEnd: (existingClip.trimStart || 0) + timelineToSourceTime(existingClip, newDuration)
              }
            }
          }
          // Case 4: Moved clip is in the middle of existing clip -> split
          else if (newStartTime > existingClip.startTime && newEndTime < clipEnd) {
            const idx = updatedClips.findIndex(c => c.id === existingClip.id)
            if (idx !== -1) {
              const firstPartDuration = newStartTime - existingClip.startTime
              updatedClips[idx] = {
                ...updatedClips[idx],
                duration: firstPartDuration,
                trimEnd: (existingClip.trimStart || 0) + timelineToSourceTime(existingClip, firstPartDuration)
              }
              
              const secondPartStart = newEndTime
              const secondPartDuration = clipEnd - newEndTime
              const secondPartTrimStart = (existingClip.trimStart || 0) + timelineToSourceTime(existingClip, newEndTime - existingClip.startTime)
              
              clipsToAdd.push({
                ...existingClip,
                id: `clip-${state.clipCounter + addedCounter + 1}`,
                startTime: secondPartStart,
                duration: secondPartDuration,
                trimStart: secondPartTrimStart,
                trimEnd: getClipTrimEnd(existingClip)
              })
              addedCounter++
            }
          }
        })
      })
      
      // Remove fully covered clips
      updatedClips = updatedClips.filter(c => !clipsToRemove.includes(c.id))
      
      // Add split clips
      updatedClips = [...updatedClips, ...clipsToAdd]
      
      // Remove transitions that are now broken (clips no longer adjacent on same track)
      let finalClips = updatedClips
      let finalTransitions = state.transitions
      if (state.transitions.length > 0) {
        const isBroken = (t, clips) => {
          if (t.kind !== 'between') return false
          const a = clips.find(c => c.id === t.clipAId)
          const b = clips.find(c => c.id === t.clipBId)
          if (!a || !b) return true
          if (a.trackId !== b.trackId) return true
          const trackClips = clips.filter(c => c.trackId === a.trackId).sort((x, y) => x.startTime - y.startTime)
          const i = trackClips.findIndex(c => c.id === a.id)
          const j = trackClips.findIndex(c => c.id === b.id)
          return Math.abs(i - j) !== 1
        }
        const broken = state.transitions.filter(t => isBroken(t, finalClips))
        if (broken.length > 0) {
          const brokenIds = new Set(broken.map(t => t.id))
          for (const t of broken) {
            finalClips = finalClips.map(c => {
              if (c.id === t.clipAId && t.originalClipAEnd != null && t.originalClipATrimEnd != null) {
                return { ...c, duration: t.originalClipAEnd - c.startTime, trimEnd: t.originalClipATrimEnd }
              }
              if (c.id === t.clipBId && t.originalClipBStart != null && t.originalClipBTrimStart != null) {
                const durationDiff = c.startTime - t.originalClipBStart
                return { ...c, startTime: t.originalClipBStart, duration: c.duration - durationDiff, trimStart: t.originalClipBTrimStart }
              }
              return c
            })
          }
          finalTransitions = state.transitions.filter(t => !brokenIds.has(t.id))
        }
      }
      
      return { 
        clips: finalClips,
        transitions: finalTransitions,
        clipCounter: clipsToAdd.length > 0 ? state.clipCounter + clipsToAdd.length : state.clipCounter
      }
    })
  },

  /**
   * Resize a clip
   */
  resizeClip: (clipId, newDuration) => {
    const fps = get().timelineFps || 24
    set((state) => ({
      clips: state.clips.map(clip =>
        clip.id === clipId
          ? (() => {
              const minDurationSec = 1 / fps
              const nextDuration = roundDurationToFrame(Math.max(minDurationSec, newDuration), fps)
              const timeScale = getClipTimeScale(clip)
              const parsedSourceDuration = parseClipSourceDuration(clip.sourceDuration)
              const computedTrimEnd = (clip.trimStart || 0) + timelineToSourceTime(clip, nextDuration)
              const isInfiniteSource = isInfinitelyExtendableClipType(clip)
                || parsedSourceDuration === Infinity
              const nextTrimEnd = isInfiniteSource
                ? computedTrimEnd
                : (Number.isFinite(parsedSourceDuration) ? Math.min(computedTrimEnd, parsedSourceDuration) : computedTrimEnd)
              const resized = clampFiniteMediaClipToSource({ ...clip, duration: nextDuration, trimEnd: nextTrimEnd }, fps)
              return isSyncLockedClip(clip) ? applySyncLockToClip(resized, fps) : resized
            })()
          : clip
      )
    }))
  },

  /**
   * Update clip playback speed (time stretch)
   * @param {string} clipId - The clip to update
   * @param {number} speed - Playback speed multiplier
   * @param {boolean} saveHistory - Whether to save to history
   */
  updateClipSpeed: (clipId, speed, saveHistory = false) => {
    const nextSpeed = Math.max(0.1, Math.min(8, Number(speed) || 1))
    if (saveHistory) {
      get().saveToHistory()
    }

    set((state) => {
      const target = state.clips.find(c => c.id === clipId)
      if (!target) return {}

      const audioTrackIds = new Set(state.tracks.filter(t => t.type === 'audio').map(t => t.id))
      const shouldSyncAudio = target.type === 'video'
      const isLinkedAudio = (clip) => shouldSyncAudio && clip.assetId === target.assetId && audioTrackIds.has(clip.trackId)

      const computeNext = (clip) => {
        if (clip.type === 'image') return { ...clip, speed: 1 }

        const currentSpeed = Number(clip.speed) > 0 ? Number(clip.speed) : 1
        const trimStart = clip.trimStart || 0
        const sourceDuration = Number.isFinite(clip.sourceDuration) ? clip.sourceDuration : null
        const trimEnd = clip.trimEnd ?? sourceDuration ?? (trimStart + (clip.duration || 0) * currentSpeed)
        const sourceSpan = Math.max(0.01, Math.min(sourceDuration ?? trimEnd, trimEnd) - trimStart)
        const nextDuration = Math.max(0.1, sourceSpan / nextSpeed)

        return {
          ...clip,
          speed: nextSpeed,
          duration: nextDuration,
          sourceTimeScale: 1,
        }
      }

      return {
        clips: state.clips.map(clip =>
          (clip.id === clipId || isLinkedAudio(clip)) ? computeNext(clip) : clip
        )
      }
    })
  },

  /**
   * Update clip reverse playback
   * @param {string} clipId - The clip to update
   * @param {boolean} reverse - Whether to reverse playback
   * @param {boolean} saveHistory - Whether to save to history
   */
  updateClipReverse: (clipId, reverse, saveHistory = true) => {
    if (saveHistory) {
      get().saveToHistory()
    }

    set((state) => {
      const target = state.clips.find(c => c.id === clipId)
      if (!target) return {}

      const audioTrackIds = new Set(state.tracks.filter(t => t.type === 'audio').map(t => t.id))
      const shouldSyncAudio = target.type === 'video'
      const isLinkedAudio = (clip) => shouldSyncAudio && clip.assetId === target.assetId && audioTrackIds.has(clip.trackId)

      return {
        clips: state.clips.map(clip =>
          (clip.id === clipId || isLinkedAudio(clip))
            ? { ...clip, reverse: !!reverse }
            : clip
        )
      }
    })
  },

  /**
   * Update clip trim properties directly (for interactive trimming)
   * @param {string} clipId - The clip to update
   * @param {object} updates - Object with properties to update (startTime, duration, trimStart, trimEnd)
   */
  updateClipTrim: (clipId, updates) => {
    set((state) => ({
      clips: state.clips.map(clip =>
        clip.id === clipId
          ? (() => {
              const next = { ...clip, ...updates }
              const timeScale = Math.max(0.0001, Number(getClipTimeScale(next)) || 1)
              const fps = state.timelineFps || 24
              const minDuration = 1 / fps
              const minSourceSpan = minDuration * timeScale

              const parsedStartTime = Number(next.startTime)
              const startTime = Number.isFinite(parsedStartTime)
                ? Math.max(0, parsedStartTime)
                : Math.max(0, Number(clip.startTime) || 0)

              const parsedTrimStart = Number(next.trimStart)
              let trimStart = Number.isFinite(parsedTrimStart)
                ? Math.max(0, parsedTrimStart)
                : Math.max(0, Number(clip.trimStart) || 0)

              let sourceDuration = parseClipSourceDuration(next.sourceDuration)
              if (isInfinitelyExtendableClipType(next)) {
                sourceDuration = Infinity
              } else if (sourceDuration === null) {
                sourceDuration = parseClipSourceDuration(next.trimEnd) ?? Infinity
              }
              if (Number.isFinite(sourceDuration)) {
                const maxTrimStart = Math.max(0, sourceDuration - minSourceSpan)
                trimStart = Math.min(trimStart, maxTrimStart)
              }

              let trimEnd
              if (next.trimEnd !== undefined && next.trimEnd !== null && Number.isFinite(Number(next.trimEnd))) {
                trimEnd = Number(next.trimEnd)
              } else if (clip.trimEnd !== undefined && clip.trimEnd !== null && Number.isFinite(Number(clip.trimEnd))) {
                trimEnd = Number(clip.trimEnd)
              } else if (Number.isFinite(sourceDuration)) {
                trimEnd = sourceDuration
              } else {
                const fallbackDuration = Number.isFinite(Number(next.duration))
                  ? Number(next.duration)
                  : (Number(clip.duration) || minDuration)
                trimEnd = trimStart + fallbackDuration * timeScale
              }

              if (Number.isFinite(sourceDuration)) {
                trimEnd = Math.min(trimEnd, sourceDuration)
              }
              trimEnd = Math.max(trimStart + minSourceSpan, trimEnd)

              let duration = Number(next.duration)
              if (!Number.isFinite(duration)) duration = Number(clip.duration)
              if (!Number.isFinite(duration)) duration = minDuration
              duration = Math.max(minDuration, duration)

              const hasDurationUpdate = updates.duration !== undefined && updates.duration !== null
              const hasTrimStartUpdate = updates.trimStart !== undefined && updates.trimStart !== null
              const hasTrimEndUpdate = updates.trimEnd !== undefined && updates.trimEnd !== null

              if (hasDurationUpdate && !hasTrimEndUpdate) {
                trimEnd = trimStart + duration * timeScale
                if (Number.isFinite(sourceDuration)) {
                  trimEnd = Math.min(trimEnd, sourceDuration)
                }
                trimEnd = Math.max(trimStart + minSourceSpan, trimEnd)
                duration = (trimEnd - trimStart) / timeScale
              } else if (hasTrimStartUpdate || hasTrimEndUpdate) {
                duration = (trimEnd - trimStart) / timeScale
              } else {
                trimEnd = trimStart + duration * timeScale
                if (Number.isFinite(sourceDuration)) {
                  trimEnd = Math.min(trimEnd, sourceDuration)
                }
                trimEnd = Math.max(trimStart + minSourceSpan, trimEnd)
                duration = (trimEnd - trimStart) / timeScale
              }

              duration = Math.max(minDuration, duration)

              // Quantize to frame boundaries (no sub-frame clip positions)
              const alignedStartTime = roundToFrame(startTime, fps)
              const alignedDuration = roundDurationToFrame(duration, fps)
              let alignedTrimEnd = trimStart + alignedDuration * timeScale
              if (Number.isFinite(sourceDuration)) {
                alignedTrimEnd = Math.min(alignedTrimEnd, sourceDuration)
              }
              alignedTrimEnd = Math.max(trimStart + (1 / fps) * timeScale, alignedTrimEnd)

              const normalized = clampFiniteMediaClipToSource({
                ...next,
                sourceDuration,
                startTime: alignedStartTime,
                duration: alignedDuration,
                trimStart,
                trimEnd: alignedTrimEnd,
              }, fps)

              if (isTrimDebugEnabled()) {
                const durationBefore = Number(next.duration)
                const trimStartBefore = Number(next.trimStart)
                const trimEndBefore = Number(next.trimEnd)
                const changed = (
                  (Number.isFinite(durationBefore) && Math.abs(durationBefore - normalized.duration) > 0.05)
                  || (Number.isFinite(trimStartBefore) && Math.abs(trimStartBefore - trimStart) > 0.05)
                  || (Number.isFinite(trimEndBefore) && Math.abs(trimEndBefore - normalized.trimEnd) > 0.05)
                )
                if (changed) {
                  console.log('[TrimDebug] Normalized trim update', {
                    clipId,
                    updates,
                    before: {
                      startTime: clip.startTime,
                      duration: clip.duration,
                      trimStart: clip.trimStart,
                      trimEnd: clip.trimEnd,
                      speed: clip.speed,
                      sourceDuration: clip.sourceDuration,
                    },
                    after: {
                      startTime: normalized.startTime,
                      duration: normalized.duration,
                      trimStart: normalized.trimStart,
                      trimEnd: normalized.trimEnd,
                      speed: normalized.speed,
                      sourceDuration: normalized.sourceDuration,
                    }
                  })
                }
              }

              return isSyncLockedClip(clip) ? applySyncLockToClip(normalized, fps) : normalized
            })()
          : clip
      )
    }))
  },

  /**
   * Update clip transform properties (position, scale, rotation, flip, crop, opacity)
   * @param {string} clipId - The clip to update
   * @param {object} transformUpdates - Partial transform object with properties to update
   * @param {boolean} saveHistory - Whether to save to history (default: false for realtime sliders)
   */
  updateClipTransform: (clipId, transformUpdates, saveHistory = false) => {
    if (saveHistory) {
      get().saveToHistory()
    }
    
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        
        // Ensure transform object exists (for legacy clips)
        const currentTransform = clip.transform || {
          positionX: 0, positionY: 0,
          scaleX: 100, scaleY: 100, scaleLinked: true,
          rotation: 0, anchorX: 50, anchorY: 50, opacity: 100,
          flipH: false, flipV: false,
          cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0,
          blendMode: 'normal',
          blur: 0,
        }
        
        // Handle linked scale: if scaleLinked and one scale changed, update both
        let finalUpdates = { ...transformUpdates }
        if (currentTransform.scaleLinked) {
          if ('scaleX' in transformUpdates && !('scaleY' in transformUpdates)) {
            finalUpdates.scaleY = transformUpdates.scaleX
          } else if ('scaleY' in transformUpdates && !('scaleX' in transformUpdates)) {
            finalUpdates.scaleX = transformUpdates.scaleY
          }
        }
        
        return {
          ...clip,
          transform: {
            ...currentTransform,
            ...finalUpdates
          }
        }
      })
    }))
  },

  updateClipCompositeMode: (clipId, compositeMode, saveHistory = true) => {
    const normalizedMode = normalizeClipCompositeMode(compositeMode)
    const currentClip = get().clips.find((clip) => clip.id === clipId)
    if (!currentClip || !supportsLowerLayerCompositeMode(currentClip)) return
    if (normalizeClipCompositeMode(currentClip.compositeLowerLayers) === normalizedMode) return

    if (saveHistory) {
      get().saveToHistory()
    }

    set((state) => ({
      clips: state.clips.map((clip) => {
        if (clip.id !== clipId || !supportsLowerLayerCompositeMode(clip)) return clip
        return {
          ...clip,
          compositeLowerLayers: normalizedMode,
        }
      })
    }))
  },

  /**
   * Update adjustment layer properties (brightness/contrast/saturation/gain/gamma/offset/hue/blur)
   * @param {string} clipId - The adjustment clip to update
   * @param {object} adjustmentUpdates - Partial adjustment object
   * @param {boolean} saveHistory - Whether to save to history
   */
  updateClipAdjustments: (clipId, adjustmentUpdates, saveHistory = false) => {
    if (saveHistory) {
      get().saveToHistory()
    }

    set((state) => ({
      clips: state.clips.map((clip) => {
        if (clip.id !== clipId || !supportsClipAdjustments(clip)) return clip
        return {
          ...clip,
          adjustments: mergeAdjustmentSettings(clip.adjustments || {}, adjustmentUpdates || {}),
        }
      })
    }))
  },

  /**
   * Update audio clip properties such as fade-in and fade-out.
   * @param {string} clipId - The audio clip to update
   * @param {object} audioUpdates - Partial audio properties object
   * @param {boolean} saveHistory - Whether to save to history
   */
  updateAudioClipProperties: (clipId, audioUpdates, saveHistory = false) => {
    if (saveHistory) {
      get().saveToHistory()
    }

    set((state) => ({
      clips: state.clips.map((clip) => {
        if (clip.id !== clipId || clip.type !== 'audio') return clip

        return {
          ...clip,
          ...audioUpdates,
          gainDb: Object.prototype.hasOwnProperty.call(audioUpdates || {}, 'gainDb')
            ? normalizeAudioClipGainDb(audioUpdates.gainDb)
            : normalizeAudioClipGainDb(clip.gainDb),
          fadeIn: Object.prototype.hasOwnProperty.call(audioUpdates || {}, 'fadeIn')
            ? clampAudioFadeDuration(audioUpdates.fadeIn, clip.duration)
            : (clip.fadeIn ?? 0),
          fadeOut: Object.prototype.hasOwnProperty.call(audioUpdates || {}, 'fadeOut')
            ? clampAudioFadeDuration(audioUpdates.fadeOut, clip.duration)
            : (clip.fadeOut ?? 0),
        }
      }),
    }))
  },

  /**
   * Reset clip transform to defaults
   * @param {string} clipId - The clip to reset
   */
  resetClipTransform: (clipId) => {
    get().saveToHistory()
    
    set((state) => ({
      clips: state.clips.map(clip =>
        clip.id === clipId
          ? {
              ...clip,
              transform: {
                positionX: 0, positionY: 0,
                scaleX: 100, scaleY: 100, scaleLinked: true,
                rotation: 0, anchorX: 50, anchorY: 50, opacity: 100,
                flipH: false, flipV: false,
                cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0,
                blendMode: 'normal',
                blur: 0,
              }
            }
          : clip
      )
    }))
  },

  /**
   * Get the currently selected clip (first selected)
   */
  getSelectedClip: () => {
    const state = get()
    if (state.selectedClipIds.length === 0) return null
    return state.clips.find(c => c.id === state.selectedClipIds[0]) || null
  },

  // ==================== KEYFRAME MANAGEMENT ====================

  /**
   * Add or update a keyframe for a property
   * @param {string} clipId - The clip ID
   * @param {string} property - Property name (e.g., 'positionX', 'scaleX')
   * @param {number} time - Time in seconds (relative to clip start)
   * @param {number} value - Value at this keyframe
   * @param {string} easing - Easing function (default: 'easeInOut')
   * @param {{ saveHistory?: boolean }} options
   */
  setKeyframe: (clipId, property, time, value, easing = 'easeInOut', options = {}) => {
    const { saveHistory = true } = options || {}
    if (saveHistory) {
      get().saveToHistory()
    }
    
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        
        const safeTime = clampKeyframeTime(time, clip.duration)
        const keyframes = clip.keyframes || {}
        const propKeyframes = [...(keyframes[property] || [])]
        
        // Find existing keyframe at this time (with tolerance)
        const existingIndex = propKeyframes.findIndex(kf => Math.abs(kf.time - safeTime) < KEYFRAME_TIME_TOLERANCE)
        
        if (existingIndex >= 0) {
          // Update existing keyframe
          propKeyframes[existingIndex] = { time: safeTime, value, easing }
        } else {
          // Add new keyframe
          propKeyframes.push({ time: safeTime, value, easing })
        }
        
        // Sort by time
        propKeyframes.sort((a, b) => a.time - b.time)
        
        return {
          ...clip,
          keyframes: {
            ...keyframes,
            [property]: propKeyframes
          }
        }
      })
    }))
  },

  /**
   * Remove a keyframe
   * @param {string} clipId - The clip ID
   * @param {string} property - Property name
   * @param {number} time - Time of keyframe to remove
   * @param {{ saveHistory?: boolean }} options
   */
  removeKeyframe: (clipId, property, time, options = {}) => {
    const { saveHistory = true } = options || {}
    if (saveHistory) {
      get().saveToHistory()
    }
    
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        
        const keyframes = clip.keyframes || {}
        const propKeyframes = keyframes[property] || []
        const safeTime = clampKeyframeTime(time, clip.duration)
        
        // Filter out keyframe at this time
        const newPropKeyframes = propKeyframes.filter(kf => Math.abs(kf.time - safeTime) > KEYFRAME_TIME_TOLERANCE)
        
        // If no keyframes left for this property, remove the property entry
        const newKeyframes = { ...keyframes }
        if (newPropKeyframes.length === 0) {
          delete newKeyframes[property]
        } else {
          newKeyframes[property] = newPropKeyframes
        }
        
        return {
          ...clip,
          keyframes: newKeyframes
        }
      })
    }))
  },

  /**
   * Move a keyframe to a different time for a single property.
   * If a keyframe already exists near the target time, it is replaced.
   * @param {string} clipId - The clip ID
   * @param {string} property - Property name
   * @param {number} fromTime - Existing keyframe time
   * @param {number} toTime - New keyframe time
   * @param {{ saveHistory?: boolean }} options
   * @returns {boolean} True if a keyframe was moved
   */
  moveKeyframeTime: (clipId, property, fromTime, toTime, options = {}) => {
    const { saveHistory = true } = options || {}
    const state = get()
    const clip = state.clips.find((candidate) => candidate.id === clipId)
    if (!clip) return false
    const propKeyframes = clip.keyframes?.[property] || []
    if (propKeyframes.length === 0) return false

    const safeToTime = clampKeyframeTime(toTime, clip.duration)
    const safeFromTime = clampKeyframeTime(fromTime, clip.duration)
    if (Math.abs(safeToTime - safeFromTime) < 0.0005) return false

    const sourceExists = propKeyframes.some((keyframe) => Math.abs(keyframe.time - safeFromTime) < KEYFRAME_TIME_TOLERANCE)
    if (!sourceExists) return false

    if (saveHistory) {
      get().saveToHistory()
    }

    let didMove = false

    set((state) => ({
      clips: state.clips.map((clip) => {
        if (clip.id !== clipId) return clip

        const keyframes = clip.keyframes || {}
        const targetKeyframes = keyframes[property] || []
        if (targetKeyframes.length === 0) return clip

        const result = movePropertyKeyframeArray(targetKeyframes, safeFromTime, safeToTime, KEYFRAME_TIME_TOLERANCE)
        if (!result.moved) return clip

        didMove = true
        return {
          ...clip,
          keyframes: {
            ...keyframes,
            [property]: result.keyframes,
          },
        }
      }),
    }))

    return didMove
  },

  /**
   * Move all keyframes at a given time across multiple properties.
   * If properties are not provided, all properties on the clip are considered.
   * @param {string} clipId - The clip ID
   * @param {number} fromTime - Source keyframe time
   * @param {number} toTime - Destination keyframe time
   * @param {{ saveHistory?: boolean, properties?: string[] }} options
   * @returns {boolean} True if any keyframe moved
   */
  moveKeyframesAtTime: (clipId, fromTime, toTime, options = {}) => {
    const {
      saveHistory = true,
      properties = null,
    } = options || {}

    const state = get()
    const clip = state.clips.find((candidate) => candidate.id === clipId)
    if (!clip) return false

    const keyframes = clip.keyframes || {}
    const propertyIds = Array.isArray(properties) && properties.length > 0
      ? properties
      : Object.keys(keyframes)
    if (propertyIds.length === 0) return false

    const safeToTime = clampKeyframeTime(toTime, clip.duration)
    const safeFromTime = clampKeyframeTime(fromTime, clip.duration)
    if (Math.abs(safeToTime - safeFromTime) < 0.0005) return false

    const hasSource = propertyIds.some((propertyId) => {
      const propKeyframes = keyframes[propertyId] || []
      return propKeyframes.some((keyframe) => Math.abs(keyframe.time - safeFromTime) < KEYFRAME_TIME_TOLERANCE)
    })
    if (!hasSource) return false

    if (saveHistory) {
      get().saveToHistory()
    }

    let didMove = false

    set((state) => ({
      clips: state.clips.map((clip) => {
        if (clip.id !== clipId) return clip

        const keyframes = clip.keyframes || {}
        let clipDidMove = false
        const nextKeyframes = { ...keyframes }

        for (const propertyId of propertyIds) {
          const propKeyframes = nextKeyframes[propertyId] || []
          if (!propKeyframes.length) continue

          const result = movePropertyKeyframeArray(propKeyframes, safeFromTime, safeToTime, KEYFRAME_TIME_TOLERANCE)
          if (!result.moved) continue

          nextKeyframes[propertyId] = result.keyframes
          clipDidMove = true
        }

        if (!clipDidMove) return clip

        didMove = true
        return {
          ...clip,
          keyframes: nextKeyframes,
        }
      }),
    }))

    return didMove
  },

  /**
   * Toggle keyframe at current playhead position
   * If keyframe exists, remove it; if not, add one with current value
   * @param {string} clipId - The clip ID
   * @param {string} property - Property name
   */
  toggleKeyframe: (clipId, property) => {
    const state = get()
    const clip = state.clips.find(c => c.id === clipId)
    if (!clip) return
    
    // Calculate time relative to clip start
    const clipTime = state.playheadPosition - clip.startTime
    if (clipTime < 0 || clipTime > clip.duration) return
    
    const keyframes = clip.keyframes?.[property] || []
    const existingKeyframe = keyframes.find(kf => Math.abs(kf.time - clipTime) < KEYFRAME_TIME_TOLERANCE)
    
    // Determine if we need to handle linked scale
    const isScaleProperty = property === 'scaleX' || property === 'scaleY'
    const isLinked = clip.transform?.scaleLinked && isScaleProperty
    
    if (existingKeyframe) {
      // Remove existing keyframe
      get().removeKeyframe(clipId, property, clipTime, { saveHistory: true })
      // If scale is linked, also remove the other scale keyframe
      if (isLinked) {
        const otherProperty = property === 'scaleX' ? 'scaleY' : 'scaleX'
        get().removeKeyframe(clipId, otherProperty, clipTime, { saveHistory: false })
      }
    } else {
      // Add new keyframe with current transform value
      const adjustmentValue = getAdjustmentValue(clip.adjustments || {}, property)
      const hasAdjustmentValue = adjustmentValue !== undefined
      const currentValue = hasAdjustmentValue
        ? adjustmentValue
        : (clip.transform?.[property] ?? adjustmentValue ?? 0)
      get().setKeyframe(clipId, property, clipTime, currentValue, 'easeInOut', { saveHistory: true })
      // If scale is linked, also add keyframe for the other scale property
      if (isLinked) {
        const otherProperty = property === 'scaleX' ? 'scaleY' : 'scaleX'
        const otherValue = clip.transform?.[otherProperty] ?? 0
        get().setKeyframe(clipId, otherProperty, clipTime, otherValue, 'easeInOut', { saveHistory: false })
      }
    }
  },

  /**
   * Update keyframe easing
   * @param {string} clipId - The clip ID
   * @param {string} property - Property name
   * @param {number} time - Keyframe time
   * @param {string} easing - New easing value
   */
  updateKeyframeEasing: (clipId, property, time, easing) => {
    get().saveToHistory()
    
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        
        const keyframes = clip.keyframes || {}
        const propKeyframes = keyframes[property] || []
        
        const newPropKeyframes = propKeyframes.map(kf => 
          Math.abs(kf.time - time) < KEYFRAME_TIME_TOLERANCE ? { ...kf, easing } : kf
        )
        
        return {
          ...clip,
          keyframes: {
            ...keyframes,
            [property]: newPropKeyframes
          }
        }
      })
    }))
  },

  /**
   * Clear all keyframes for a property
   * @param {string} clipId - The clip ID
   * @param {string} property - Property name
   */
  clearPropertyKeyframes: (clipId, property) => {
    get().saveToHistory()
    
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        
        const newKeyframes = { ...clip.keyframes }
        delete newKeyframes[property]
        
        return {
          ...clip,
          keyframes: newKeyframes
        }
      })
    }))
  },

  /**
   * Clear all keyframes for a clip
   * @param {string} clipId - The clip ID
   */
  clearAllKeyframes: (clipId) => {
    get().saveToHistory()
    
    set((state) => ({
      clips: state.clips.map(clip => 
        clip.id === clipId ? { ...clip, keyframes: {} } : clip
      )
    }))
  },

  /**
   * Apply a preset title animation to a text clip.
   * Replaces only transform-related animation keyframes, preserving non-animation keyframes.
   * @param {string} clipId - The target text clip ID
   * @param {string} presetId - Preset ID from textAnimationPresets
   * @param {'in'|'out'|'inOut'} mode - Animation direction mode
   * @param {{ saveHistory?: boolean }} options
   * @returns {boolean} - Whether the preset was applied
   */
  applyTextAnimationPreset: (clipId, presetId, mode = 'inOut', options = {}) => {
    const { saveHistory = true } = options || {}
    const state = get()
    const targetClip = state.clips.find(c => c.id === clipId)
    if (!targetClip || targetClip.type !== 'text') return false

    if (saveHistory) {
      get().saveToHistory()
    }

    const fps = Number.isFinite(state.timelineFps) && state.timelineFps > 0 ? state.timelineFps : FRAME_RATE
    const { keyframes: presetKeyframes, appliedPresetId, appliedMode } = buildTextAnimationPresetKeyframes({
      presetId,
      mode,
      clipDuration: targetClip.duration,
      fps,
      baseTransform: targetClip.transform || {},
    })

    set((currentState) => ({
      clips: currentState.clips.map((clip) => {
        if (clip.id !== clipId || clip.type !== 'text') return clip

        const retainedKeyframes = { ...(clip.keyframes || {}) }
        for (const property of TEXT_ANIMATION_KEYFRAME_PROPERTIES) {
          delete retainedKeyframes[property]
        }

        return {
          ...clip,
          keyframes: {
            ...retainedKeyframes,
            ...presetKeyframes,
          },
          titleAnimation: appliedPresetId
            ? { presetId: appliedPresetId, mode: appliedMode }
            : null,
        }
      })
    }))

    return true
  },

  /**
   * Remove preset title animation keyframes from a text clip.
   * Preserves any non-title keyframes.
   * @param {string} clipId - The target text clip ID
   * @param {{ saveHistory?: boolean }} options
   * @returns {boolean}
   */
  clearTextAnimationPreset: (clipId, options = {}) => {
    const { saveHistory = true } = options || {}
    const state = get()
    const targetClip = state.clips.find(c => c.id === clipId)
    if (!targetClip || targetClip.type !== 'text') return false

    if (saveHistory) {
      get().saveToHistory()
    }

    set((currentState) => ({
      clips: currentState.clips.map((clip) => {
        if (clip.id !== clipId || clip.type !== 'text') return clip

        const retainedKeyframes = { ...(clip.keyframes || {}) }
        for (const property of TEXT_ANIMATION_KEYFRAME_PROPERTIES) {
          delete retainedKeyframes[property]
        }

        return {
          ...clip,
          keyframes: retainedKeyframes,
          titleAnimation: null,
        }
      })
    }))

    return true
  },

  /**
   * Get keyframe at specific time for a property
   * @param {string} clipId - The clip ID
   * @param {string} property - Property name
   * @param {number} time - Time to check (relative to clip start)
   * @returns {Object|null} - Keyframe object or null
   */
  getKeyframeAtTime: (clipId, property, time) => {
    const state = get()
    const clip = state.clips.find(c => c.id === clipId)
    if (!clip) return null
    
    const keyframes = clip.keyframes?.[property] || []
    return keyframes.find(kf => Math.abs(kf.time - time) < KEYFRAME_TIME_TOLERANCE) || null
  },

  /**
   * Check if property has keyframes
   * @param {string} clipId - The clip ID
   * @param {string} property - Property name
   * @returns {boolean}
   */
  hasKeyframes: (clipId, property) => {
    const state = get()
    const clip = state.clips.find(c => c.id === clipId)
    return clip?.keyframes?.[property]?.length > 0
  },

  /**
   * Navigate to next keyframe for a property
   * @param {string} clipId - The clip ID
   * @param {string} property - Property name (or 'all' for any property)
   */
  goToNextKeyframe: (clipId, property = 'all') => {
    const state = get()
    const clip = state.clips.find(c => c.id === clipId)
    if (!clip) return
    
    const clipTime = state.playheadPosition - clip.startTime
    let nextTime = Infinity
    
    if (property === 'all') {
      // Find next keyframe across all properties
      for (const propKeyframes of Object.values(clip.keyframes || {})) {
        for (const kf of propKeyframes) {
          if (kf.time > clipTime + KEYFRAME_TIME_TOLERANCE && kf.time < nextTime) {
            nextTime = kf.time
          }
        }
      }
    } else {
      // Find next keyframe for specific property
      const keyframes = clip.keyframes?.[property] || []
      for (const kf of keyframes) {
        if (kf.time > clipTime + KEYFRAME_TIME_TOLERANCE && kf.time < nextTime) {
          nextTime = kf.time
        }
      }
    }
    
    if (nextTime !== Infinity) {
      set({ playheadPosition: roundToFrame(clip.startTime + nextTime, state.timelineFps || FRAME_RATE) })
    }
  },

  /**
   * Navigate to previous keyframe for a property
   * @param {string} clipId - The clip ID
   * @param {string} property - Property name (or 'all' for any property)
   */
  goToPrevKeyframe: (clipId, property = 'all') => {
    const state = get()
    const clip = state.clips.find(c => c.id === clipId)
    if (!clip) return
    
    const clipTime = state.playheadPosition - clip.startTime
    let prevTime = -Infinity
    
    if (property === 'all') {
      // Find previous keyframe across all properties
      for (const propKeyframes of Object.values(clip.keyframes || {})) {
        for (const kf of propKeyframes) {
          if (kf.time < clipTime - KEYFRAME_TIME_TOLERANCE && kf.time > prevTime) {
            prevTime = kf.time
          }
        }
      }
    } else {
      // Find previous keyframe for specific property
      const keyframes = clip.keyframes?.[property] || []
      for (const kf of keyframes) {
        if (kf.time < clipTime - KEYFRAME_TIME_TOLERANCE && kf.time > prevTime) {
          prevTime = kf.time
        }
      }
    }
    
    if (prevTime !== -Infinity) {
      set({ playheadPosition: roundToFrame(clip.startTime + prevTime, state.timelineFps || FRAME_RATE) })
    }
  },

  // ==================== END KEYFRAME MANAGEMENT ====================

  // ==================== EFFECTS MANAGEMENT ====================

  /**
   * Add an effect to a clip
   * @param {string} clipId - The clip ID
   * @param {object} effect - Effect configuration { type, ...params }
   * @returns {object} The created effect
   */
  addEffect: (clipId, effect) => {
    get().saveToHistory()
    
    const effectId = `effect-${Date.now()}`
    const newEffect = {
      id: effectId,
      enabled: true,
      ...effect,
    }
    
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        
        const effects = clip.effects || []
        const infiniteTiming = isInfinitelyExtendableClipType(clip)
          ? { sourceDuration: Infinity }
          : {}
        return {
          ...clip,
          ...infiniteTiming,
          effects: [...effects, newEffect],
          // Invalidate cache when effects change
          cacheStatus: clip.cacheStatus === 'cached' ? 'invalid' : clip.cacheStatus,
        }
      })
    }))
    
    return newEffect
  },

  /**
   * Remove an effect from a clip
   * @param {string} clipId - The clip ID
   * @param {string} effectId - The effect ID to remove
   */
  removeEffect: (clipId, effectId) => {
    get().saveToHistory()
    
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        
        const effects = clip.effects || []
        const newEffects = effects.filter(e => e.id !== effectId)
        return {
          ...clip,
          effects: newEffects,
          // Invalidate cache when effects change, or clear if no effects left
          cacheStatus: newEffects.length === 0 ? 'none' : 
                      (clip.cacheStatus === 'cached' ? 'invalid' : clip.cacheStatus),
          cacheUrl: newEffects.length === 0 ? null : clip.cacheUrl,
        }
      })
    }))
  },

  /**
   * Update an effect's properties
   * @param {string} clipId - The clip ID
   * @param {string} effectId - The effect ID
   * @param {object} updates - Properties to update
   * @param {boolean} saveHistory - Whether to save to history (default: false for realtime)
   */
  updateEffect: (clipId, effectId, updates, saveHistory = false) => {
    if (saveHistory) {
      get().saveToHistory()
    }
    
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        
        const effects = clip.effects || []
        return {
          ...clip,
          effects: effects.map(e => 
            e.id === effectId ? { ...e, ...updates } : e
          ),
          // Invalidate cache when effect properties change
          cacheStatus: clip.cacheStatus === 'cached' ? 'invalid' : clip.cacheStatus,
        }
      })
    }))
  },

  /**
   * Toggle an effect's enabled state
   * @param {string} clipId - The clip ID
   * @param {string} effectId - The effect ID
   */
  toggleEffect: (clipId, effectId) => {
    get().saveToHistory()
    
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        
        const effects = clip.effects || []
        return {
          ...clip,
          effects: effects.map(e => 
            e.id === effectId ? { ...e, enabled: !e.enabled } : e
          ),
          // Invalidate cache when effect is toggled
          cacheStatus: clip.cacheStatus === 'cached' ? 'invalid' : clip.cacheStatus,
        }
      })
    }))
  },

  /**
   * Reorder effects (move effect up or down in the stack)
   * @param {string} clipId - The clip ID
   * @param {string} effectId - The effect ID to move
   * @param {number} direction - -1 for up, 1 for down
   */
  reorderEffect: (clipId, effectId, direction) => {
    get().saveToHistory()

    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip

        const effects = [...(clip.effects || [])]
        const index = effects.findIndex(e => e.id === effectId)

        if (index === -1) return clip

        const newIndex = index + direction
        if (newIndex < 0 || newIndex >= effects.length) return clip

        const tmp = effects[index]
        effects[index] = effects[newIndex]
        effects[newIndex] = tmp

        return { ...clip, effects }
      })
    }))
  },

  /**
   * Get all effects for a clip
   * @param {string} clipId - The clip ID
   * @returns {Array} Array of effects
   */
  getClipEffects: (clipId) => {
    const state = get()
    const clip = state.clips.find(c => c.id === clipId)
    return clip?.effects || []
  },

  /**
   * Get enabled effects for a clip (for rendering)
   * @param {string} clipId - The clip ID
   * @returns {Array} Array of enabled effects
   */
  getEnabledEffects: (clipId) => {
    const state = get()
    const clip = state.clips.find(c => c.id === clipId)
    return (clip?.effects || []).filter(e => e.enabled)
  },

  /**
   * Add a mask effect to a clip
   * @param {string} clipId - The clip ID
   * @param {string} maskAssetId - The mask asset ID
   * @returns {object} The created mask effect
   */
  addMaskEffect: (clipId, maskAssetId) => {
    return get().addEffect(clipId, {
      type: 'mask',
      maskAssetId,
      invertMask: false,
      feather: 0,
    })
  },

  // ==================== END EFFECTS MANAGEMENT ====================

  // ==================== RENDER CACHE MANAGEMENT ====================

  /**
   * Set the render cache status for a clip
   * @param {string} clipId - The clip ID
   * @param {string} status - Cache status: 'none', 'rendering', 'cached', 'invalid'
   * @param {number} progress - Render progress (0-100) when rendering
   */
  setCacheStatus: (clipId, status, progress = 0) => {
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        return {
          ...clip,
          cacheStatus: status,
          cacheProgress: progress,
        }
      })
    }))
  },

  /**
   * Set the cached video URL for a clip
   * @param {string} clipId - The clip ID  
   * @param {string} cacheUrl - Blob URL of the cached video
   * @param {string} cachePath - Optional path to the cached file on disk
   */
  setCacheUrl: (clipId, cacheUrl, cachePath = null) => {
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        return {
          ...clip,
          cacheUrl,
          cachePath, // Path to the file on disk (for persistence)
          cacheStatus: cacheUrl ? 'cached' : 'none',
          cacheProgress: cacheUrl ? 100 : 0,
        }
      })
    }))
  },

  /**
   * Invalidate cache for a clip (e.g., when effects change)
   * @param {string} clipId - The clip ID
   */
  invalidateCache: (clipId) => {
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        // Only invalidate if there was a cache
        if (clip.cacheStatus === 'cached' || clip.cacheUrl) {
          return {
            ...clip,
            cacheStatus: 'invalid',
            // Keep cacheUrl for now - will be revoked when new cache is created
          }
        }
        return clip
      })
    }))
  },

  /**
   * Clear cache for a clip
   * @param {string} clipId - The clip ID
   */
  clearClipCache: (clipId) => {
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        return {
          ...clip,
          cacheStatus: 'none',
          cacheProgress: 0,
          cacheUrl: null,
        }
      })
    }))
  },

  /** Preview proxy (flattened timeline for smooth playback) */
  setPreviewProxyGenerating: () => {
    set({ previewProxyStatus: 'generating', previewProxyProgress: 0 })
  },
  setPreviewProxyProgress: (progress) => {
    set({ previewProxyProgress: Math.max(0, Math.min(100, progress)) })
  },
  setPreviewProxyReady: (path, signature) => {
    set({
      previewProxyStatus: 'ready',
      previewProxyProgress: 100,
      previewProxyPath: path,
      previewProxySignature: signature,
    })
  },
  setUseProxyPlaybackForAssets: (enabled) => {
    set({ useProxyPlaybackForAssets: Boolean(enabled) })
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('comfystudio-use-playback-proxies', enabled ? 'true' : 'false')
    }
  },
  setGlslPreviewQuality: (quality) => {
    const normalized = ['full', 'half', 'quarter', 'eighth'].includes(quality) ? quality : 'full'
    set({ glslPreviewQuality: normalized })
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('comfystudio-glsl-preview-quality', normalized)
    }
  },
  setPreviewCompositorMode: (mode) => {
    const normalized = ['canvas', 'dom'].includes(mode) ? mode : 'canvas'
    set({ previewCompositorMode: normalized })
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('comfystudio-preview-compositor-mode', normalized)
    }
  },
  setShowTimelineClipThumbnails: (enabled) => {
    const next = Boolean(enabled)
    set({ showTimelineClipThumbnails: next })
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('comfystudio-show-timeline-clip-thumbnails', next ? 'true' : 'false')
    }
  },
  setPreviewProxyInvalid: () => {
    set({
      previewProxyStatus: 'none',
      previewProxyPath: null,
      previewProxySignature: null,
    })
  },

  /**
   * Get cache status for a clip
   * @param {string} clipId - The clip ID
   * @returns {object} { status, progress, url }
   */
  getClipCacheStatus: (clipId) => {
    const state = get()
    const clip = state.clips.find(c => c.id === clipId)
    return {
      status: clip?.cacheStatus || 'none',
      progress: clip?.cacheProgress || 0,
      url: clip?.cacheUrl || null,
    }
  },

  /**
   * Check if a clip needs caching (has effects but no valid cache)
   * @param {string} clipId - The clip ID
   * @returns {boolean}
   */
  clipNeedsCache: (clipId) => {
    const state = get()
    const clip = state.clips.find(c => c.id === clipId)
    if (!clip) return false
    
    const hasEffects = (clip.effects || []).some(e => e.enabled)
    const hasValidCache = clip.cacheStatus === 'cached' && clip.cacheUrl
    
    return hasEffects && !hasValidCache
  },

  // ==================== END RENDER CACHE MANAGEMENT ====================

  /**
   * Trim a clip from the left (adjust in-point)
   */
  trimClipStart: (clipId, deltaTime) => {
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        
        const timeScale = getClipTimeScale(clip)
        const minSourceDuration = 0.5 * timeScale
        const currentTrimEnd = getClipTrimEnd(clip)
        const newTrimStart = Math.max(
          0,
          Math.min(currentTrimEnd - minSourceDuration, (clip.trimStart || 0) + deltaTime * timeScale)
        )
        const trimDeltaSource = newTrimStart - (clip.trimStart || 0)
        const trimDeltaTimeline = trimDeltaSource / timeScale
        
        return {
          ...clip,
          trimStart: newTrimStart,
          startTime: clip.startTime + trimDeltaTimeline,
          duration: clip.duration - trimDeltaTimeline
        }
      })
    }))
  },

  /**
   * Trim a clip from the right (adjust out-point)
   * Images can be extended indefinitely (sourceDuration = Infinity)
   */
  trimClipEnd: (clipId, deltaTime) => {
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        
        // For images (Infinity source), allow extending without limit
        // For video/audio, cap at source duration
        const timeScale = getClipTimeScale(clip)
        const parsedSourceDuration = parseClipSourceDuration(clip.sourceDuration)
        const maxDuration = isInfinitelyExtendableClipType(clip)
          || parsedSourceDuration === Infinity
          ? Infinity
          : (Number.isFinite(parsedSourceDuration) ? parsedSourceDuration : getClipTrimEnd(clip))
        const minSourceDuration = 0.5 * timeScale
        const currentTrimEnd = getClipTrimEnd(clip)
        const newTrimEnd = Math.max(
          (clip.trimStart || 0) + minSourceDuration,
          Math.min(maxDuration, currentTrimEnd + deltaTime * timeScale)
        )
        const newDuration = (newTrimEnd - (clip.trimStart || 0)) / timeScale
        
        return {
          ...clip,
          trimEnd: newTrimEnd,
          duration: newDuration
        }
      })
    }))
  },

  /**
   * Calculate available handles for a clip
   * Head handle = trimStart (footage available before current in-point)
   * Tail handle = sourceDuration - trimEnd (footage available after current out-point)
   */
  getClipHandles: (clipId) => {
    const state = get()
    const clip = state.clips.find(c => c.id === clipId)
    if (!clip) return { head: 0, tail: 0 }
    
    const headHandle = sourceToTimelineTime(clip, clip.trimStart || 0)
    const parsedSourceDuration = parseClipSourceDuration(clip.sourceDuration)
    const sourceDuration = isInfinitelyExtendableClipType(clip)
      ? Infinity
      : (parsedSourceDuration === null ? getClipTrimEnd(clip) : parsedSourceDuration)
    const trimEnd = getClipTrimEnd(clip)
    const tailHandle = sourceToTimelineTime(clip, sourceDuration - trimEnd)
    
    return {
      head: Math.max(0, headHandle),
      tail: Math.max(0, tailHandle)
    }
  },

  /**
   * Calculate max transition duration between two clips
   * Limited by available handles on both clips
   */
  getMaxTransitionDuration: (clipAId, clipBId) => {
    return get().getMaxTransitionDurationForAlignment(clipAId, clipBId, 'center')
  },

  /**
   * Calculate max transition duration for a specific alignment mode.
   * alignment:
   * - center: half from clipA tail + half from clipB head
   * - start:  all overlap pulled from clipA tail
   * - end:    all overlap pulled from clipB head
   */
  getMaxTransitionDurationForAlignment: (clipAId, clipBId, alignment = 'center', transitionId = null) => {
    const state = get()
    const clipA = state.clips.find(c => c.id === clipAId)
    const clipB = state.clips.find(c => c.id === clipBId)
    
    if (!clipA || !clipB) return 0
    if (isAdjustmentClipType(clipA) || isAdjustmentClipType(clipB)) return 0
    
    // ClipA needs tail handle (to extend past its current end)
    const clipAHandles = get().getClipHandles(clipAId)
    // ClipB needs head handle (to start earlier than its current start)
    const clipBHandles = get().getClipHandles(clipBId)
    
    // If editing an existing transition, add back its currently consumed handles
    // so max duration is relative to the original cut, not the already-overlapped state.
    let consumedA = 0
    let consumedB = 0
    if (transitionId) {
      const transition = state.transitions.find(t => t.id === transitionId)
      if (transition && transition.kind === 'between') {
        const currentAlignment = transition?.settings?.alignment || 'center'
        const consumed = getTransitionContributions(transition.duration, currentAlignment)
        consumedA = consumed.clipA
        consumedB = consumed.clipB
      }
    }
    
    const availableA = Math.max(0, clipAHandles.tail + consumedA)
    const availableB = Math.max(0, clipBHandles.head + consumedB)
    
    // Also keep a conservative cap against current clip durations.
    const maxFromClipA = Math.max(MIN_TRANSITION_DURATION, clipA.duration + consumedA)
    const maxFromClipB = Math.max(MIN_TRANSITION_DURATION, clipB.duration + consumedB)
    
    if (alignment === 'start') {
      return Math.min(availableA, maxFromClipA, maxFromClipB)
    }
    if (alignment === 'end') {
      return Math.min(availableB, maxFromClipA, maxFromClipB)
    }
    // center
    return Math.min(availableA * 2, availableB * 2, maxFromClipA, maxFromClipB)
  },

  /**
   * Calculate max transition duration for a single clip edge (in/out)
   * Limited by the clip's duration
   */
  getMaxEdgeTransitionDuration: (clipId) => {
    const state = get()
    const clip = state.clips.find(c => c.id === clipId)
    if (!clip) return 0
    if (isAdjustmentClipType(clip)) return 0
    return Math.max(0, clip.duration)
  },

  /**
   * Build transition settings with defaults
   */
  buildTransitionSettings: (type, settings = {}) => {
    const merged = {
      ...(TRANSITION_DEFAULT_SETTINGS[type] || {}),
      ...(settings || {})
    }
    if (!merged.alignment) merged.alignment = 'center'
    return merged
  },

  /**
   * Add a transition between two clips (Resolve-style)
   * This creates actual overlap by extending clipA and starting clipB earlier
   */
  addTransition: (clipAId, clipBId, transitionType = 'dissolve', duration = 0.5) => {
    const state = get()
    const clipA = state.clips.find(c => c.id === clipAId)
    const clipB = state.clips.find(c => c.id === clipBId)
    
    if (!clipA || !clipB) return null
    if (isAdjustmentClipType(clipA) || isAdjustmentClipType(clipB)) return null
    
    // Check if transition already exists
    const existingTransition = state.transitions.find(
      t => (t.clipAId === clipAId && t.clipBId === clipBId) ||
           (t.clipAId === clipBId && t.clipBId === clipAId)
    )
    if (existingTransition) {
      set({ selectedTransitionId: existingTransition.id, selectedClipIds: [] })
      return existingTransition
    }
    
    // Validate that clips are on the same track and adjacent
    if (clipA.trackId !== clipB.trackId) {
      console.warn('Cannot add transition between clips on different tracks')
      return null
    }
    
    const initialSettings = get().buildTransitionSettings(transitionType)
    const alignment = initialSettings.alignment || 'center'

    // Get max allowed transition duration based on available handles + alignment
    const maxDuration = get().getMaxTransitionDurationForAlignment(clipAId, clipBId, alignment)
    if (maxDuration < MIN_TRANSITION_DURATION) {
      console.warn('Insufficient handles for transition. Need more footage before/after trim points.')
      return null
    }
    
    // Clamp duration to available handles
    const actualDuration = Math.max(MIN_TRANSITION_DURATION, Math.min(duration, maxDuration))
    const contribution = getTransitionContributions(actualDuration, alignment)
    
    // Store the original edit point (where clips meet)
    const editPoint = clipA.startTime + clipA.duration
    
    // Save to history before modifying
    get().saveToHistory()
    
    const newTransition = {
      id: `transition-${state.transitionCounter}`,
      kind: 'between',
      clipAId,
      clipBId,
      type: transitionType,
      duration: actualDuration,
      settings: initialSettings,
      // Store original positions for removal
      editPoint: editPoint,
      originalClipAEnd: clipA.startTime + clipA.duration,
      originalClipADuration: clipA.duration,
      originalClipATrimEnd: clipA.trimEnd,
      originalClipBStart: clipB.startTime,
      originalClipBDuration: clipB.duration,
      originalClipBTrimStart: clipB.trimStart,
    }
    
    // Modify clips to create overlap:
    // clipA contributes from its tail; clipB contributes from its head.
    set((state) => ({
      clips: state.clips.map(c => {
        if (c.id === clipAId) {
          // Extend clipA's duration/trimEnd by clipA contribution
          const trimEnd = getClipTrimEnd(c)
          const trimEndDelta = timelineToSourceTime(c, contribution.clipA)
          return {
            ...c,
            duration: c.duration + contribution.clipA,
            trimEnd: trimEnd + trimEndDelta
          }
        }
        if (c.id === clipBId) {
          // Start clipB earlier and adjust trimStart by clipB contribution
          const trimStartDelta = timelineToSourceTime(c, contribution.clipB)
          return {
            ...c,
            startTime: c.startTime - contribution.clipB,
            duration: c.duration + contribution.clipB,
            trimStart: Math.max(0, (c.trimStart || 0) - trimStartDelta)
          }
        }
        return c
      }),
      transitions: [...state.transitions, newTransition],
      transitionCounter: state.transitionCounter + 1,
      selectedTransitionId: newTransition.id,
      selectedClipIds: []
    }))
    
    return newTransition
  },

  /**
   * Add a transition to a single clip edge (in/out)
   * This does not modify clip duration, it just applies an effect at the edge.
   */
  addEdgeTransition: (clipId, edge = 'in', transitionType = 'fade-black', duration = 0.5) => {
    const state = get()
    const clip = state.clips.find(c => c.id === clipId)
    if (!clip) return null
    if (isAdjustmentClipType(clip)) return null
    
    // Only one edge transition per clip+edge
    const existing = state.transitions.find(
      t => t.kind === 'edge' && t.clipId === clipId && t.edge === edge
    )
    if (existing) {
      set({ selectedTransitionId: existing.id, selectedClipIds: [] })
      return existing
    }
    
    const maxDuration = get().getMaxEdgeTransitionDuration(clipId)
    if (maxDuration < MIN_TRANSITION_DURATION) return null
    
    const actualDuration = Math.max(MIN_TRANSITION_DURATION, Math.min(duration, maxDuration))
    
    // Save to history before modifying
    get().saveToHistory()
    
    const newTransition = {
      id: `transition-${state.transitionCounter}`,
      kind: 'edge',
      clipId,
      edge,
      type: transitionType,
      duration: actualDuration,
      settings: get().buildTransitionSettings(transitionType),
    }
    
    set((state) => ({
      transitions: [...state.transitions, newTransition],
      transitionCounter: state.transitionCounter + 1,
      selectedTransitionId: newTransition.id,
      selectedClipIds: []
    }))
    
    return newTransition
  },

  /**
   * Remove a transition and restore clips to their original positions
   */
  removeTransition: (transitionId) => {
    const state = get()
    const transition = state.transitions.find(t => t.id === transitionId)
    
    if (!transition) return
    
    // Save to history before modifying
    get().saveToHistory()

    // Edge transitions don't modify clips
    if (transition.kind === 'edge') {
      set((state) => ({
        transitions: state.transitions.filter(t => t.id !== transitionId),
        selectedTransitionId: state.selectedTransitionId === transitionId ? null : state.selectedTransitionId
      }))
      return
    }
    
    // Restore clips to their original positions (between transitions)
    set((state) => ({
      clips: state.clips.map(c => {
        if (c.id === transition.clipAId && transition.originalClipATrimEnd !== undefined) {
          const newDuration = transition.originalClipADuration ?? (transition.originalClipAEnd - c.startTime)
          return {
            ...c,
            duration: newDuration,
            trimEnd: transition.originalClipATrimEnd
          }
        }
        if (c.id === transition.clipBId && transition.originalClipBStart !== undefined) {
          const newDuration = transition.originalClipBDuration ?? (c.duration - (c.startTime - transition.originalClipBStart))
          return {
            ...c,
            startTime: transition.originalClipBStart,
            duration: newDuration,
            trimStart: transition.originalClipBTrimStart
          }
        }
        return c
      }),
      transitions: state.transitions.filter(t => t.id !== transitionId)
      ,
      selectedTransitionId: state.selectedTransitionId === transitionId ? null : state.selectedTransitionId
    }))
  },

  /**
   * Update transition settings/duration.
   * For between transitions, duration and alignment both rebalance overlap.
   */
  updateTransition: (transitionId, updates) => {
    const state = get()
    const transition = state.transitions.find(t => t.id === transitionId)
    
    if (!transition) return

    // Simple update path when overlap does not need rebalancing
    const alignmentUpdate = updates?.settings?.alignment
    const needsBetweenRebalance = transition.kind === 'between' && (updates.duration !== undefined || alignmentUpdate !== undefined)
    const needsEdgeDurationClamp = transition.kind === 'edge' && updates.duration !== undefined
    if (!needsBetweenRebalance && !needsEdgeDurationClamp) {
      set((state) => ({
        transitions: state.transitions.map(t =>
          t.id === transitionId
            ? {
                ...t,
                ...updates,
                settings: updates.settings
                  ? get().buildTransitionSettings(updates.type || t.type, {
                      ...(t.settings || {}),
                      ...updates.settings
                    })
                  : t.settings
              }
            : t
        )
      }))
      return
    }

    // Edge transitions just update duration (clamped)
    if (transition.kind === 'edge') {
      const maxDuration = get().getMaxEdgeTransitionDuration(transition.clipId)
      if (maxDuration < MIN_TRANSITION_DURATION) return
      const actualNewDuration = Math.min(Math.max(MIN_TRANSITION_DURATION, updates.duration), maxDuration)
      
      get().saveToHistory()
      set((state) => ({
        transitions: state.transitions.map(t =>
          t.id === transitionId
            ? {
                ...t,
                ...updates,
                duration: actualNewDuration,
                settings: updates.settings
                  ? get().buildTransitionSettings(updates.type || t.type, {
                      ...(t.settings || {}),
                      ...updates.settings
                    })
                  : t.settings
              }
            : t
        )
      }))
      return
    }
    
    const clipA = state.clips.find(c => c.id === transition.clipAId)
    const clipB = state.clips.find(c => c.id === transition.clipBId)
    if (!clipA || !clipB) return

    // Between transition: rebalance overlap by old/new contribution model
    const oldAlignment = transition?.settings?.alignment || 'center'
    const nextAlignment = alignmentUpdate || oldAlignment
    const newDuration = updates.duration ?? transition.duration
    const oldDuration = transition.duration
    const maxDuration = get().getMaxTransitionDurationForAlignment(
      transition.clipAId,
      transition.clipBId,
      nextAlignment,
      transitionId
    )
    if (maxDuration < MIN_TRANSITION_DURATION) return
    const actualNewDuration = Math.min(Math.max(MIN_TRANSITION_DURATION, newDuration), maxDuration)
    const oldContribution = getTransitionContributions(oldDuration, oldAlignment)
    const newContribution = getTransitionContributions(actualNewDuration, nextAlignment)
    const deltaA = newContribution.clipA - oldContribution.clipA
    const deltaB = newContribution.clipB - oldContribution.clipB
    
    // Save to history
    get().saveToHistory()
    
    set((state) => ({
      clips: state.clips.map(c => {
        if (c.id === transition.clipAId) {
          const trimEnd = getClipTrimEnd(c)
          const trimEndDelta = timelineToSourceTime(c, deltaA)
          return {
            ...c,
            duration: c.duration + deltaA,
            trimEnd: trimEnd + trimEndDelta
          }
        }
        if (c.id === transition.clipBId) {
          const trimStartDelta = timelineToSourceTime(c, deltaB)
          return {
            ...c,
            startTime: c.startTime - deltaB,
            duration: c.duration + deltaB,
            trimStart: Math.max(0, (c.trimStart || 0) - trimStartDelta)
          }
        }
        return c
      }),
      transitions: state.transitions.map(t =>
        t.id === transitionId
          ? {
              ...t,
              ...updates,
              duration: actualNewDuration,
              settings: updates.settings
                ? get().buildTransitionSettings(updates.type || t.type, {
                    ...(t.settings || {}),
                    ...updates.settings
                  })
                : t.settings
            }
          : t
      )
    }))
  },

  /**
   * Set transition alignment (between transitions only): start | center | end
   */
  setTransitionAlignment: (transitionId, alignment = 'center') => {
    const state = get()
    const transition = state.transitions.find(t => t.id === transitionId)
    if (!transition || transition.kind !== 'between') return
    get().updateTransition(transitionId, {
      duration: transition.duration,
      settings: { alignment }
    })
  },

  /**
   * Get the active video clip at a specific time (topmost video track)
   */
  getActiveClipAtTime: (time) => {
    const state = get()
    // Get video tracks in reverse order (top track = highest priority)
    const videoTracks = state.tracks.filter(t => t.type === 'video' && t.visible && !t.muted)
    
    for (const track of videoTracks) {
      const clip = state.clips.find(c => 
        c.trackId === track.id &&
        (c.type === 'video' || c.type === 'image') &&
        isClipEnabled(c) &&
        time >= c.startTime &&
        time < c.startTime + c.duration
      )
      if (clip) return clip
    }
    return null
  },

  /**
   * Get all active clips at a specific time (for compositing)
   */
  getActiveClipsAtTime: (time) => {
    const state = get()
    const activeClips = []
    
    for (const track of state.tracks) {
      if (!track.visible || track.muted) continue
      
      const trackClips = state.clips.filter(c =>
        c.trackId === track.id &&
        isClipEnabled(c) &&
        time >= c.startTime &&
        time < c.startTime + c.duration
      )
      if (trackClips.length > 0) {
        // Keep deterministic order (earlier clips first)
        trackClips
          .sort((a, b) => a.startTime - b.startTime)
          .forEach(clip => activeClips.push({ clip, track }))
      }
    }
    return activeClips
  },

  /**
   * Get transition info at a specific time (if in transition zone)
   * With the new overlap model:
   * - ClipA and ClipB now overlap for transition.duration
   * - The overlap zone IS the transition zone
   * - transitionStart = clipB.startTime (which is now earlier than original edit point)
   * - transitionEnd = clipA.startTime + clipA.duration (which is now later than original edit point)
   */
  getTransitionAtTime: (time) => {
    const state = get()
    const safeTime = Number(time)
    if (!Number.isFinite(safeTime)) return null

    const getTrackPriority = (trackId) => {
      const idx = state.tracks.findIndex(t => t.id === trackId)
      return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER
    }

    const candidates = []

    for (const transition of state.transitions) {
      if (!transition || typeof transition !== 'object') continue

      if (transition.kind === 'edge') {
        const clip = state.clips.find(c => c.id === transition.clipId)
        if (!clip) continue

        const clipTrack = state.tracks.find(t => t.id === clip.trackId)
        if (!clipTrack || clipTrack.type !== 'video') continue

        const duration = Math.min(Number(transition.duration) || 0, Number(clip.duration) || 0)
        if (duration <= 0) continue

        if (transition.edge === 'in') {
          const start = clip.startTime
          const end = start + duration
          if (safeTime >= start && safeTime < end) {
            const progress = (safeTime - start) / duration
            candidates.push({
              trackPriority: getTrackPriority(clip.trackId),
              kindPriority: 1, // Between transitions win ties over edge transitions
              data: { transition, clip, edge: 'in', progress }
            })
          }
        } else {
          const end = clip.startTime + clip.duration
          const start = end - duration
          if (safeTime >= start && safeTime < end) {
            const progress = (safeTime - start) / duration
            candidates.push({
              trackPriority: getTrackPriority(clip.trackId),
              kindPriority: 1,
              data: { transition, clip, edge: 'out', progress }
            })
          }
        }

        continue
      }

      const clipA = state.clips.find(c => c.id === transition.clipAId)
      const clipB = state.clips.find(c => c.id === transition.clipBId)

      if (!clipA || !clipB) continue

      const clipTrack = state.tracks.find(t => t.id === clipA.trackId)
      if (!clipTrack || clipTrack.type !== 'video') continue
      if (clipA.trackId !== clipB.trackId) continue
      const duration = Number(transition.duration)
      if (!Number.isFinite(duration) || duration <= 0) continue

      // With overlap model:
      // - ClipB.startTime is where the transition starts
      // - ClipA.startTime + ClipA.duration is where the transition ends
      // Both clips are visible during this overlap period
      const transitionStart = clipB.startTime
      const clipAEnd = clipA.startTime + clipA.duration

      // The overlap zone is where both clips exist simultaneously
      if (safeTime >= transitionStart && safeTime < clipAEnd) {
        // Progress goes from 0 (start of clipB) to 1 (end of clipA overlap)
        const progress = (safeTime - transitionStart) / duration
        candidates.push({
          trackPriority: getTrackPriority(clipA.trackId),
          kindPriority: 0,
          data: { transition, clipA, clipB, progress: Math.min(1, Math.max(0, progress)) }
        })
      }
    }

    if (candidates.length === 0) return null

    // Pick the top-most active transition in the stack. If two hit on the same track,
    // prefer a between transition over an edge transition.
    candidates.sort((a, b) => {
      if (a.trackPriority !== b.trackPriority) return a.trackPriority - b.trackPriority
      return a.kindPriority - b.kindPriority
    })

    return candidates[0].data
  },

  /**
   * Get the end time of the last clip
   */
  getTimelineEndTime: () => {
    const state = get()
    if (state.clips.length === 0) return 0
    return Math.max(...state.clips.map(c => c.startTime + c.duration))
  },

  /**
   * Select a transition (single selection)
   */
  selectTransition: (transitionId) => {
    set({ selectedTransitionId: transitionId, selectedClipIds: [], selectedMarkerId: null, selectedGap: null })
  },

  /**
   * Clear transition selection only
   */
  clearTransitionSelection: () => {
    set({ selectedTransitionId: null })
  },

  /**
   * Select a clip (supports multi-select modes)
   * @param {string} clipId - The clip to select
   * @param {object} options - Selection options
   * @param {boolean} options.addToSelection - Add to existing selection (Shift+click)
   * @param {boolean} options.toggleSelection - Toggle this clip in selection (Ctrl/Cmd+click)
   */
  selectClip: (clipId, options = {}) => {
    const { addToSelection = false, toggleSelection = false } = options

    set((state) => {
      const linkedClipIds = expandClipIdsWithLinked(state.clips, [clipId])
      if (toggleSelection) {
        // Ctrl/Cmd+click: toggle this clip in selection
        const isSelected = linkedClipIds.every(id => state.selectedClipIds.includes(id))
        if (isSelected) {
          return {
            selectedClipIds: state.selectedClipIds.filter(id => !linkedClipIds.includes(id)),
            selectedTransitionId: null,
            selectedMarkerId: null,
            selectedGap: null,
          }
        } else {
          return {
            selectedClipIds: dedupeClipIds([...state.selectedClipIds, ...linkedClipIds]),
            selectedTransitionId: null,
            selectedMarkerId: null,
            selectedGap: null,
          }
        }
      } else if (addToSelection) {
        // Shift+click: add to selection (or range select)
        if (linkedClipIds.every(id => state.selectedClipIds.includes(id))) {
          return state // Already selected
        }
        return {
          selectedClipIds: dedupeClipIds([...state.selectedClipIds, ...linkedClipIds]),
          selectedTransitionId: null,
          selectedMarkerId: null,
          selectedGap: null,
        }
      } else {
        // Normal click: replace selection
        return { selectedClipIds: linkedClipIds, selectedTransitionId: null, selectedMarkerId: null, selectedGap: null }
      }
    })
  },

  /**
   * Clear all selections
   */
  clearSelection: () => {
    set({
      selectedClipIds: [],
      selectedTransitionId: null,
      selectedMarkerId: null,
      selectedGap: null,
      textEditRequest: null,
    })
  },

  /**
   * Request opening the Inspector for a clip (optionally mask picker)
   */
  requestMaskPicker: (clipId, options = {}) => {
    const { openPicker = true } = options
    set({ maskPickerRequest: { clipId, openPicker } })
  },

  /**
   * Clear mask picker request
   */
  clearMaskPickerRequest: () => {
    set({ maskPickerRequest: null })
  },

  /**
   * Request focusing the selected text clip content field in the Inspector.
   */
  requestTextEdit: (clipId, options = {}) => {
    const { selectAll = true } = options
    if (!clipId) return
    set({
      textEditRequest: {
        clipId,
        selectAll,
        requestedAt: Date.now(),
      },
    })
  },

  /**
   * Clear pending text edit focus request.
   */
  clearTextEditRequest: () => {
    set({ textEditRequest: null })
  },

  /**
   * Select multiple clips at once
   */
  selectClips: (clipIds) => {
    set((state) => ({
      selectedClipIds: expandClipIdsWithLinked(state.clips, clipIds),
      selectedTransitionId: null,
      selectedMarkerId: null,
      selectedGap: null,
    }))
  },

  /**
   * Select an empty gap on a track.
   */
  selectGap: (gap) => {
    if (!gap?.trackId || !Number.isFinite(gap?.startTime) || !Number.isFinite(gap?.endTime)) {
      set({ selectedGap: null })
      return
    }

    set({
      selectedGap: {
        trackId: gap.trackId,
        startTime: Math.max(0, gap.startTime),
        endTime: Math.max(0, gap.endTime),
      },
      selectedClipIds: [],
      selectedTransitionId: null,
      selectedMarkerId: null,
    })
  },

  clearGapSelection: () => {
    set({ selectedGap: null })
  },

  /**
   * Check if a clip is selected
   */
  isClipSelected: (clipId) => {
    return get().selectedClipIds.includes(clipId)
  },

  /**
   * Set playhead position. Playback stays continuous; seek/scrub UI can request frame snapping.
   */
  setPlayheadPosition: (position, options = {}) => {
    const state = get()
    const fps = state.timelineFps || FRAME_RATE
    const parsedPosition = Number(position)
    const safePosition = Number.isFinite(parsedPosition) ? parsedPosition : 0
    const clampedPosition = Math.max(0, safePosition)
    const shouldSnap = options?.snap === true || options?.snapToFrame === true
    set({ playheadPosition: shouldSnap ? roundToFrame(clampedPosition, fps) : clampedPosition })
  },

  /**
   * Set active track for cut-at-playhead (X key). Only the active track is split when pressing X.
   */
  setActiveTrack: (trackId) => {
    set({ activeTrackId: trackId })
  },

  /**
   * Toggle play/pause
   */
  togglePlay: () => {
    set((state) => {
      const nextIsPlaying = !state.isPlaying
      const timelineEnd = state.getTimelineEndTime()
      const atOrPastEnd = timelineEnd > 0 && state.playheadPosition >= (timelineEnd - 0.001)

      return {
        isPlaying: nextIsPlaying,
        // Restart from beginning when pressing play at the timeline end in normal mode.
        playheadPosition: roundToFrame(
          (!state.isPlaying && nextIsPlaying && state.loopMode === 'normal' && atOrPastEnd)
            ? 0
            : state.playheadPosition,
          state.timelineFps || FRAME_RATE
        ),
        playbackRate: state.isPlaying ? state.playbackRate : 1, // Reset to 1x when starting
        shuttleMode: false
      }
    })
  },

  /**
   * Set playback rate (for JKL shuttle)
   */
  setPlaybackRate: (rate) => {
    set({ playbackRate: rate })
  },

  /**
   * JKL Shuttle: J key - play reverse (multiple presses increase speed)
   */
  shuttleReverse: () => {
    set((state) => {
      const speeds = [-1, -2, -4, -8]
      
      if (!state.isPlaying || state.playbackRate > 0) {
        // Not playing or playing forward - start reverse at 1x
        return { isPlaying: true, playbackRate: -1, shuttleMode: true }
      }
      
      // Already playing reverse - increase speed
      const currentIndex = speeds.indexOf(state.playbackRate)
      const nextIndex = Math.min(currentIndex + 1, speeds.length - 1)
      return { playbackRate: speeds[nextIndex], shuttleMode: true }
    })
  },

  /**
   * JKL Shuttle: K key - pause
   */
  shuttlePause: () => {
    set({ isPlaying: false, playbackRate: 1, shuttleMode: false })
  },

  /**
   * JKL Shuttle: L key - play forward (multiple presses increase speed)
   */
  shuttleForward: () => {
    set((state) => {
      const speeds = [1, 2, 4, 8]
      
      if (!state.isPlaying || state.playbackRate < 0) {
        // Not playing or playing reverse - start forward at 1x
        return { isPlaying: true, playbackRate: 1, shuttleMode: true }
      }
      
      // Already playing forward - increase speed
      const currentIndex = speeds.indexOf(state.playbackRate)
      const nextIndex = Math.min(currentIndex + 1, speeds.length - 1)
      return { playbackRate: speeds[nextIndex], shuttleMode: true }
    })
  },

  /**
   * JKL Shuttle: K+J or K+L - slow shuttle (hold K and tap J or L)
   */
  shuttleSlow: (direction) => {
    set((state) => {
      const rate = direction === 'reverse' ? -0.5 : 0.5
      return { isPlaying: true, playbackRate: rate, shuttleMode: true }
    })
  },

  /**
   * Set playback loop mode
   * @param {'normal' | 'loop' | 'loop-in-out' | 'loop-selection' | 'ping-pong'} mode
   */
  setLoopMode: (mode) => {
    set({ loopMode: mode })
  },

  /**
   * Set zoom level (20% - 2000%)
   */
  setZoom: (zoom) => {
    set({ zoom: Math.max(20, Math.min(2000, zoom)) })
  },

  /**
   * Toggle track mute
   */
  toggleTrackMute: (trackId) => {
    set((state) => ({
      tracks: state.tracks.map(track =>
        track.id === trackId ? { ...track, muted: !track.muted } : track
      )
    }))
  },

  /**
   * Toggle track lock
   */
  toggleTrackLock: (trackId) => {
    set((state) => ({
      tracks: state.tracks.map(track =>
        track.id === trackId ? { ...track, locked: !track.locked } : track
      )
    }))
  },

  /**
   * Toggle track visibility
   */
  toggleTrackVisibility: (trackId) => {
    set((state) => ({
      tracks: state.tracks.map(track =>
        track.id === trackId ? { ...track, visible: !track.visible } : track
      )
    }))
  },

  /**
   * Enable or disable one or more clips.
   */
  setClipsEnabled: (clipIds, enabled) => {
    const state = get()
    const targetIds = expandClipIdsWithLinked(state.clips, clipIds)
    if (targetIds.length === 0) return

    const targetSet = new Set(targetIds)
    const desiredEnabled = enabled !== false
    const hasChanges = state.clips.some((clip) => (
      targetSet.has(clip.id) && isClipEnabled(clip) !== desiredEnabled
    ))
    if (!hasChanges) return

    get().saveToHistory()
    set((current) => ({
      clips: current.clips.map((clip) => (
        targetSet.has(clip.id)
          ? { ...clip, enabled: desiredEnabled }
          : clip
      )),
    }))
  },

  /**
   * Add a new track
   * @param {string} type - 'video' | 'audio'
   * @param {object} options - For audio: { channels: 'mono' | 'stereo' }
   */
  addTrack: (type, options = {}) => {
    const state = get()
    const existingTracks = state.tracks.filter(t => t.type === type)
    
    // Generate unique ID by finding the highest existing number
    let maxNum = 0
    existingTracks.forEach(t => {
      const match = t.id.match(new RegExp(`^${type}-(\\d+)$`))
      if (match) {
        maxNum = Math.max(maxNum, parseInt(match[1]))
      }
    })
    
    const customName = typeof options?.name === 'string' ? options.name.trim() : ''
    const newTrack = {
      id: `${type}-${maxNum + 1}`,
      name: customName || `${type === 'video' ? 'Video' : 'Audio'} ${maxNum + 1}`,
      type,
      muted: false,
      locked: false,
      visible: true
    }
    if (type === 'audio') {
      newTrack.channels = options.channels === 'mono' ? 'mono' : 'stereo'
    }
    
    set((state) => {
      // For video tracks, add to the beginning (top)
      // For audio tracks, add to the end (bottom)
      if (type === 'video') {
        const videoTracks = state.tracks.filter(t => t.type === 'video')
        const audioTracks = state.tracks.filter(t => t.type === 'audio')
        return {
          tracks: [newTrack, ...videoTracks, ...audioTracks]
        }
      } else {
        return {
          tracks: [...state.tracks, newTrack]
        }
      }
    })
    
    return newTrack
  },

  /**
   * Remove a track (and all its clips)
   * Prevents removing the last video or audio track
   */
  removeTrack: (trackId) => {
    const state = get()
    const track = state.tracks.find(t => t.id === trackId)
    if (!track) return false
    
    // Count tracks of this type
    const tracksOfType = state.tracks.filter(t => t.type === track.type)
    
    // Prevent removing the last track of a type
    if (tracksOfType.length <= 1) {
      return false
    }
    
    // Save to history before modifying
    get().saveToHistory()
    
    set((state) => ({
      tracks: state.tracks.filter(t => t.id !== trackId),
      // Also remove all clips on this track
      clips: state.clips.filter(c => c.trackId !== trackId),
      // Clear selection if any selected clips were on this track
      selectedClipIds: state.selectedClipIds.filter(id => {
        const clip = state.clips.find(c => c.id === id)
        return clip && clip.trackId !== trackId
      })
    }))
    
    return true
  },

  /**
   * Rename a track
   */
  renameTrack: (trackId, newName) => {
    if (!newName || newName.trim() === '') return false
    
    // Save to history before modifying
    get().saveToHistory()
    
    set((state) => ({
      tracks: state.tracks.map(track =>
        track.id === trackId ? { ...track, name: newName.trim() } : track
      )
    }))
    
    return true
  },

  /**
   * Reorder a track within its type group (video or audio)
   * @param {string} trackId - The track to move
   * @param {number} newIndex - The new index within its type group
   */
  reorderTrack: (trackId, newIndex) => {
    const state = get()
    const track = state.tracks.find(t => t.id === trackId)
    if (!track) return
    
    const trackType = track.type
    const tracksOfType = state.tracks.filter(t => t.type === trackType)
    const otherTracks = state.tracks.filter(t => t.type !== trackType)
    
    // Find current index within type group
    const currentIndex = tracksOfType.findIndex(t => t.id === trackId)
    if (currentIndex === newIndex) return
    
    // Clamp newIndex
    const clampedIndex = Math.max(0, Math.min(tracksOfType.length - 1, newIndex))
    
    // Remove track from current position and insert at new position
    const reorderedTracks = [...tracksOfType]
    reorderedTracks.splice(currentIndex, 1)
    reorderedTracks.splice(clampedIndex, 0, track)
    
    // Save to history
    get().saveToHistory()
    
    // Reconstruct tracks array with video first, then audio
    const videoTracks = trackType === 'video' ? reorderedTracks : otherTracks.filter(t => t.type === 'video')
    const audioTracks = trackType === 'audio' ? reorderedTracks : otherTracks.filter(t => t.type === 'audio')
    
    set({ tracks: [...videoTracks, ...audioTracks] })
  },

  /**
   * Get clip at specific time on specific track
   */
  getClipAtTime: (trackId, time) => {
    const state = get()
    return state.clips.find(clip => 
      clip.trackId === trackId &&
      time >= clip.startTime &&
      time < clip.startTime + clip.duration
    )
  },

  /**
   * Clear all project data (for "New Project")
   */
  clearProject: () => {
    set({
      duration: 60,
      zoom: 100,
      playheadPosition: 0,
      isPlaying: false,
      playbackRate: 1,
      shuttleMode: false,
      loopMode: 'normal',
      tracks: [
        { id: 'video-1', name: 'Video 1', type: 'video', muted: false, locked: false, visible: true },
        { id: 'audio-1', name: 'Audio 1', type: 'audio', channels: 'stereo', muted: false, locked: false, visible: true },
      ],
      clips: [],
      transitions: [],
      markers: [],
      selectedClipIds: [],
      selectedTransitionId: null,
      selectedMarkerId: null,
      activeTrackId: null,
      clipCounter: 1,
      transitionCounter: 1,
      markerCounter: 1,
      snappingEnabled: true,
      snappingThreshold: 10,
      activeSnapTime: null,
      rippleEditMode: false,
      inPoint: null,
      outPoint: null,
      // Clear undo/redo history
      history: [],
      historyIndex: -1,
      historyLastChangedAt: 0,
    })
  },

  /**
   * Load timeline data from a project
   * @param {object} timelineData - Timeline data from project file
   */
  loadFromProject: (timelineData, assets = [], timelineFps = null) => {
    if (!timelineData) return
    const fps = Number(timelineFps) || 24
    const assetsById = buildAssetByIdMap(assets)
    const normalizedClips = normalizeClipTimebases(timelineData.clips || [], assets, fps)
    // Align all clip start times and durations to frame boundaries (no sub-frame)
    const frameAlignedClips = normalizedClips.map((clip) => {
      const startTime = roundToFrame(Math.max(0, clip.startTime || 0), fps)
      const duration = roundDurationToFrame(clip.duration || 0.5, fps)
      const timeScale = getClipTimeScale(clip)
      let sourceDuration = parseClipSourceDuration(clip.sourceDuration)
      if (isInfinitelyExtendableClipType(clip)) {
        sourceDuration = Infinity
      } else if (sourceDuration === null) {
        sourceDuration = parseClipSourceDuration(clip.trimEnd) ?? Infinity
      }
      const trimStart = clip.trimStart ?? 0
      let trimEnd = trimStart + timelineToSourceTime(clip, duration)
      if (Number.isFinite(sourceDuration)) trimEnd = Math.min(trimEnd, sourceDuration)
      trimEnd = Math.max(trimStart + (1 / fps) * timeScale, trimEnd)
      const normalizedAdjustments = supportsClipAdjustments(clip)
        ? normalizeAdjustmentSettings(clip.adjustments || {})
        : clip.adjustments
      const normalizedClip = clampFiniteMediaClipToSource({
        ...clip,
        startTime,
        duration,
        trimEnd,
        sourceDuration,
        adjustments: normalizedAdjustments,
        ...(supportsLowerLayerCompositeMode(clip)
          ? { compositeLowerLayers: normalizeClipCompositeMode(clip.compositeLowerLayers) }
          : {}),
      }, fps)
      return applyInferredSyncLockToClip(normalizedClip, assetsById, fps)
    })
    const restoredClipCounter = Number(timelineData.clipCounter) || 1
    const nextClipCounter = Math.max(restoredClipCounter, getNextClipCounter(frameAlignedClips, 1))

    set({
      duration: timelineData.duration || 60,
      timelineFps: fps,
      zoom: timelineData.zoom || 100,
      tracks: timelineData.tracks || [
        { id: 'video-1', name: 'Video 1', type: 'video', muted: false, locked: false, visible: true },
        { id: 'audio-1', name: 'Audio 1', type: 'audio', channels: 'stereo', muted: false, locked: false, visible: true },
      ],
      clips: frameAlignedClips,
      transitions: timelineData.transitions || [],
      markers: timelineData.markers || [],
      clipCounter: nextClipCounter,
      transitionCounter: timelineData.transitionCounter || 1,
      markerCounter: timelineData.markerCounter || Math.max(1, (timelineData.markers || []).length + 1),
      snappingEnabled: timelineData.snappingEnabled ?? true,
      snappingThreshold: timelineData.snappingThreshold || 10,
      rippleEditMode: timelineData.rippleEditMode || false,
      // Reset playback state
      playheadPosition: 0,
      isPlaying: false,
      playbackRate: 1,
      shuttleMode: false,
      loopMode: 'normal',
      selectedClipIds: [],
      selectedTransitionId: null,
      selectedMarkerId: null,
      activeSnapTime: null,
      inPoint: null,
      outPoint: null,
      // Clear history on load
      history: [],
      historyIndex: -1,
      historyLastChangedAt: 0,
      // Clear preview proxy (different timeline or state)
      previewProxyStatus: 'none',
      previewProxyPath: null,
      previewProxySignature: null,
    })
  },

  /**
   * Get timeline data for saving to project
   */
  getProjectData: () => {
    const state = get()
    return {
      duration: state.duration,
      zoom: state.zoom,
      tracks: state.tracks,
      clips: state.clips,
      transitions: state.transitions,
      markers: state.markers,
      clipCounter: state.clipCounter,
      transitionCounter: state.transitionCounter,
      markerCounter: state.markerCounter,
      snappingEnabled: state.snappingEnabled,
      snappingThreshold: state.snappingThreshold,
      rippleEditMode: state.rippleEditMode,
    }
  },

  /**
   * Set timeline frame rate (used for frame-aligned clip positions). Call when project/timeline FPS changes.
   */
  setTimelineFps: (fps) => {
    const value = Number(fps)
    if (Number.isFinite(value) && value > 0) {
      set((state) => ({
        timelineFps: value,
        playheadPosition: roundToFrame(state.playheadPosition, value),
        inPoint: state.inPoint !== null ? roundToFrame(state.inPoint, value) : null,
        outPoint: state.outPoint !== null ? roundToFrame(state.outPoint, value) : null,
        markers: (state.markers || []).map((marker) => ({
          ...marker,
          time: roundToFrame(marker.time, value),
        })),
      }))
    }
  },

  /**
   * Toggle snapping on/off
   */
  toggleSnapping: () => {
    set((state) => ({ snappingEnabled: !state.snappingEnabled }))
  },

  /**
   * Set snapping enabled/disabled
   */
  setSnappingEnabled: (enabled) => {
    set({ snappingEnabled: enabled })
  },

  /**
   * Set snapping threshold (in pixels)
   */
  setSnappingThreshold: (threshold) => {
    set({ snappingThreshold: Math.max(5, Math.min(30, threshold)) })
  },

  /**
   * Set active snap time for visual feedback
   */
  setActiveSnapTime: (time) => {
    set((state) => {
      if (state.activeSnapTime === time) return state
      return { activeSnapTime: time }
    })
  },

  /**
   * Clear active snap indicator
   */
  clearActiveSnap: () => {
    set((state) => {
      if (state.activeSnapTime === null) return state
      return { activeSnapTime: null }
    })
  },

  /**
   * Toggle ripple edit mode
   */
  toggleRippleEdit: () => {
    set((state) => ({ rippleEditMode: !state.rippleEditMode }))
  },

  /**
   * Set ripple edit mode
   */
  setRippleEditMode: (enabled) => {
    set({ rippleEditMode: enabled })
  },

  /**
   * Get clips that would be affected by ripple edit
   * (clips on the same track after the given time)
   */
  getClipsToRipple: (trackId, afterTime) => {
    const state = get()
    return state.clips
      .filter(c => c.trackId === trackId && c.startTime >= afterTime)
      .sort((a, b) => a.startTime - b.startTime)
  },

  /**
   * Set In point at current playhead position
   */
  setInPoint: (time = null) => {
    set((state) => ({ 
      inPoint: roundToFrame(time !== null ? time : state.playheadPosition, state.timelineFps || FRAME_RATE)
    }))
  },

  /**
   * Set Out point at current playhead position
   */
  setOutPoint: (time = null) => {
    set((state) => ({ 
      outPoint: roundToFrame(time !== null ? time : state.playheadPosition, state.timelineFps || FRAME_RATE)
    }))
  },

  /**
   * Clear In point
   */
  clearInPoint: () => {
    set({ inPoint: null })
  },

  /**
   * Clear Out point
   */
  clearOutPoint: () => {
    set({ outPoint: null })
  },

  /**
   * Clear both In and Out points
   */
  clearInOutPoints: () => {
    set({ inPoint: null, outPoint: null })
  },

  /**
   * Go to In point
   */
  goToInPoint: () => {
    const state = get()
    if (state.inPoint !== null) {
      set({ playheadPosition: roundToFrame(state.inPoint, state.timelineFps || FRAME_RATE) })
    }
  },

  /**
   * Go to Out point
   */
  goToOutPoint: () => {
    const state = get()
    if (state.outPoint !== null) {
      set({ playheadPosition: roundToFrame(state.outPoint, state.timelineFps || FRAME_RATE) })
    }
  },

  /**
   * Add a timeline marker at a specific time (or current playhead).
   */
  addMarker: (time = null, label = '') => {
    const state = get()
    const markerTime = roundToFrame(
      Math.max(0, Math.min(state.duration, time !== null ? time : state.playheadPosition)),
      state.timelineFps || FRAME_RATE
    )
    const marker = {
      id: `marker-${state.markerCounter}`,
      time: markerTime,
      label: label || '',
      color: '#f5c451'
    }

    get().saveToHistory()
    set((s) => ({
      markers: [...s.markers, marker].sort((a, b) => a.time - b.time),
      markerCounter: s.markerCounter + 1,
      selectedMarkerId: marker.id
    }))

    return marker
  },

  /**
   * Select timeline marker by id.
   */
  selectMarker: (markerId = null) => {
    set({ selectedMarkerId: markerId, selectedClipIds: [], selectedTransitionId: null, selectedGap: null })
  },

  /**
   * Remove a timeline marker.
   */
  removeMarker: (markerId) => {
    if (!markerId) return
    const state = get()
    const marker = state.markers.find(m => m.id === markerId)
    if (!marker) return

    get().saveToHistory()
    set((s) => ({
      markers: s.markers.filter(m => m.id !== markerId),
      selectedMarkerId: s.selectedMarkerId === markerId ? null : s.selectedMarkerId
    }))
  },

  /**
   * Clear all timeline markers.
   */
  clearMarkers: () => {
    const state = get()
    if (state.markers.length === 0) return
    get().saveToHistory()
    set({
      markers: [],
      selectedMarkerId: null
    })
  }
    }),
    {
      name: 'comfystudio-timeline', // localStorage key
      partialize: (state) => ({
        // Only persist these fields (exclude transient UI state)
        duration: state.duration,
        timelineFps: state.timelineFps,
        zoom: state.zoom,
        tracks: state.tracks,
        clips: state.clips,
        transitions: state.transitions,
        markers: state.markers,
        clipCounter: state.clipCounter,
        transitionCounter: state.transitionCounter,
        markerCounter: state.markerCounter,
        snappingEnabled: state.snappingEnabled,
        snappingThreshold: state.snappingThreshold,
        rippleEditMode: state.rippleEditMode,
        // Note: Transient UI state NOT persisted:
        // - activeSnapTime, selectedClipIds, playheadPosition
        // - isPlaying, playbackRate, shuttleMode
        // - inPoint, outPoint, selectedMarkerId, selectedGap (session-specific)
      }),
    }
  )
)

// Helper function to get video clip colors (desaturated palette)
function getVideoColor(index) {
  const colors = [
    '#5a7a9e', // desaturated blue
    '#7a6a9e', // desaturated purple
    '#b06a8a', // desaturated pink
    '#4a8a7a', // desaturated green
    '#6a7080', // desaturated blue
    '#b06a6a', // desaturated red
  ]
  return colors[index % colors.length]
}

// Helper function to get audio clip colors (desaturated palette)
function getAudioColor(trackId) {
  const colors = {
    'music': '#4a8a6a', // desaturated green
    'voiceover': '#565C6B', // muted blue
    'sfx': '#8a6a9a', // desaturated purple
  }
  return colors[trackId] || '#6B7280'
}

export default useTimelineStore
