import { create } from 'zustand'
import { nextShuttleRate } from '../utils/shuttlePlayback'
import { createPlaybackJump, getCurrentPlaybackJump } from '../utils/playbackJump.mjs'
import { createPlayAround, getCurrentPlayAround, stopPlayAroundPatch } from '../utils/playAround.mjs'
import { planMultiClipInspectorEdit, planMultiClipInspectorUpdates } from '../utils/multiClipInspector'
import { planMultiClipEffectsEdit } from '../utils/multiClipEffects'
import { planMcpEditing } from '../utils/mcpEditingPlan'
import { getPasteAttributesAvailability, planPasteAttributes } from '../utils/pasteAttributes'
import { getEffectTypeDefinition } from '../utils/effects'
import { planSourceTimelineEdit } from '../utils/sourceTimelineEdit.mjs'
import { buildSmartReplacePlan } from '../utils/smartReplace.mjs'
import { buildCreateCompoundPlan, validateCompoundDocument, getCompoundDocumentExtent, sanitizeCompoundChildren,
  isCompoundClip, isCompoundLocked, isCompoundCacheBusy } from '../utils/compoundDocument.mjs'
import { getClipPlaybackWindow } from '../utils/compoundPlayback.mjs'
import { buildUncompoundPlan } from '../utils/uncompoundDocument.mjs'
import { createRollEditSession, planRollEdit } from '../utils/rollEdit.mjs'
import { buildRollEditPreviewFeedback } from '../utils/rollEditPreview.mjs'
import { createSlipEditSession, planSlipEdit, buildSlipEditPreviewFeedback } from '../utils/slipEdit.mjs'
import { createSlideEditSession, planSlideEdit, buildSlideEditPreviewFeedback } from '../utils/slideEdit.mjs'
import { createRippleTrimSession, planRippleTrim, buildRippleTrimPreviewFeedback } from '../utils/rippleTrim.mjs'
import { planCloseTimelineGap } from '../utils/closeTimelineGap.mjs'
import { persist } from 'zustand/middleware'
import { TRANSITION_DEFAULT_SETTINGS, FRAME_RATE } from '../constants/transitions'
import { buildTextAnimationPresetKeyframes, TEXT_ANIMATION_KEYFRAME_PROPERTIES } from '../utils/textAnimationPresets'
import { getAdjustmentValue, mergeAdjustmentSettings, normalizeAdjustmentSettings } from '../utils/adjustments'
import { clampAudioFadeDuration } from '../utils/audioClipFades'
import { normalizeAudioClipGainDb } from '../utils/audioClipGain'
import { clampTrackPan, clampTrackVolume } from '../utils/audioTrackAudibility'
import { hasVideoSolo, isVideoTrackVisible } from '../utils/videoTrackVisibility'
import { normalizeAudioInserts } from '../utils/audioInserts'
import { isAudioClipRole, normalizeVideoBackedAudioClips } from '../utils/audioClipSplit'
import { normalizeAudioVolumeEnvelope, shiftAudioVolumeEnvelope, validateAudioVolumeEnvelope } from '../utils/audioVolumeEnvelope.mjs'
import { normalizeAudioEq, validateAudioEq } from '../utils/audioEq.mjs'
import { CLIP_COMPOSITE_MODE, normalizeClipCompositeMode } from '../utils/layerCompositing'
import { getKeyframeTimeTolerance } from '../utils/keyframes'
import { DEFAULT_SHAPE_MASK, normalizeShapeMask } from '../utils/shapeMask'
import { normalizeTrackMatte } from '../utils/trackMatte'
import { translateTransitionsForClipMoves } from '../utils/transitionClipMoves.mjs'
import { isBetweenClipTransition } from '../utils/transitionKinds'
import { DEFAULT_LINE_THICKNESS, DEFAULT_SHAPE_PROPERTIES, getShapeDisplayName, normalizeShapeProperties } from '../utils/shapes'
import { normalizeFrameSamplingMode, isOpticalFlowCacheUsable } from '../utils/frameSampling'
import {
  quantizeTimeToFrame as roundToFrame,
  roundDurationToFrame,
} from '../utils/timelineFrames'

// Maximum number of undo states to keep
const MAX_HISTORY_SIZE = 50

// A rate change invalidates an in-flight decoder landing, but must not let the
// clock escape its frozen target before a replacement landing is presented.
const playbackRateUpdate = (state, rate, { starting = false } = {}) => {
  const request = getCurrentPlaybackJump(state)
  const retry = starting && !state.isPlaying && Boolean(state.playbackJumpError)
  if (!request && !retry) return { playbackRate: rate, playbackJump: null }
  if (!retry && rate === state.playbackRate) return { playbackRate: rate }
  const revision = (Number(state.playbackJumpRevision) || 0) + 1
  return { playbackRate: rate, playbackJumpRevision: revision, playbackJumpError: null,
    playbackJump: createPlaybackJump({ ...state, playbackRate: rate }, request?.targetTime ?? state.playheadPosition, revision, Date.now()) }
}

// The persist middleware fires on EVERY store write and re-serializes the
// whole partialized state — it cannot know which field changed. During
// playback the playhead updates ~60x/s, which meant a JSON.stringify of the
// full clip list plus a synchronous localStorage write per animation frame
// (roughly the entire frame budget on a 160-clip timeline). This storage
// queues the latest snapshot and writes it at most once per second;
// last-write-wins, flushed on window close, so session restore loses nothing.
const PERSIST_WRITE_DELAY_MS = 1000
const createDebouncedJSONStorage = (getStorage) => {
  let pending = null
  let timer = 0
  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = 0
    }
    if (!pending) return
    const { name, value } = pending
    pending = null
    try {
      getStorage().setItem(name, JSON.stringify(value))
    } catch (error) {
      console.warn('[timelineStore] persist write failed', error)
    }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', flush)
  }
  return {
    getItem: (name) => {
      try {
        const raw = getStorage().getItem(name)
        return raw == null ? null : JSON.parse(raw)
      } catch (error) {
        console.warn('[timelineStore] persist read failed', error)
        return null
      }
    },
    setItem: (name, value) => {
      pending = { name, value }
      if (!timer) timer = setTimeout(flush, PERSIST_WRITE_DELAY_MS)
    },
    removeItem: (name) => {
      if (pending && pending.name === name) pending = null
      getStorage().removeItem(name)
    },
  }
}
const MIN_TRANSITION_DURATION = 1 / FRAME_RATE
const TRIM_DEBUG_KEY = 'comfystudio-debug-trim'
const KEYFRAME_TIME_TOLERANCE = 0.05
// Frame-aware match window (half a frame, capped at the legacy 0.05s).
const keyframeToleranceForFps = (fps) => getKeyframeTimeTolerance(fps || FRAME_RATE)

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

const normalizeTransitionSplit = (split = null, alignment = 'center') => {
  if (split && Number.isFinite(Number(split.clipA)) && Number.isFinite(Number(split.clipB))) {
    const clipA = Math.max(0, Number(split.clipA))
    const clipB = Math.max(0, Number(split.clipB))
    const total = clipA + clipB
    if (total > 0) return { clipA: clipA / total, clipB: clipB / total }
  }

  switch (alignment) {
    case 'start':
      return { clipA: 1, clipB: 0 }
    case 'end':
      return { clipA: 0, clipB: 1 }
    case 'center':
    default:
      return { clipA: 0.5, clipB: 0.5 }
  }
}

const getTransitionContributions = (duration, settings = {}) => {
  const d = Math.max(0, Number(duration) || 0)
  const alignment = settings?.alignment || 'center'
  const split = normalizeTransitionSplit(settings?.split, alignment)
  return {
    clipA: d * split.clipA,
    clipB: d * split.clipB,
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
const MUSIC_VIDEO_TIMELINE_ASSEMBLY_MODE = 'music-video-easy-mode'

export const isSyncLockedClip = (clip) => clip?.lockMode === 'sync' && clip?.syncLock?.mode === 'sync'

// A track tagged as the dedicated captions track (a normal video track with a
// role marker). Only caption clips may live on it.
export const isCaptionsTrack = (track) => track?.role === 'captions'
// A caption overlay clip — tagged on creation, or inferred from its asset.
export const isCaptionClip = (clip) => Boolean(
  clip?.metadata?.captionScope
  || clip?.overlayKind === 'captions'
  || clip?.captionScope
)

const normalizeMusicVideoShotType = (value = '') => String(value || '').trim().toLowerCase()

const isMusicVideoSyncAsset = (asset = null) => {
  const yolo = asset?.yolo || asset?.settings?.yolo || null
  if (!yolo || yolo.mode !== 'music' || yolo.stage !== 'video') return false
  return MUSIC_VIDEO_SYNC_SHOT_TYPES.has(normalizeMusicVideoShotType(yolo.shotType))
}

const isMusicVideoAssemblyVideoClip = (clip = null) => (
  clip?.metadata?.musicVideoAssembly?.mode === MUSIC_VIDEO_TIMELINE_ASSEMBLY_MODE
  && clip?.metadata?.musicVideoAssembly?.kind === 'video'
)

export const isMusicVideoSyncCapableClip = (clip = null, asset = null) => (
  isSyncLockedClip(clip)
  || clip?.syncLock?.mode === 'manual'
  || isMusicVideoAssemblyVideoClip(clip)
  || isMusicVideoSyncAsset(asset)
)

export const resolveClipSyncLock = ({ asset = null, options = null, startTime = 0, duration = 0, fps = FRAME_RATE } = {}) => {
  if (options?.syncLock === false) return null
  if (options?.syncLock?.mode === 'manual') return null
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

export const buildClipSyncLock = ({ clip = null, asset = null, fps = FRAME_RATE } = {}) => {
  const safeFps = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : FRAME_RATE

  const resolved = resolveClipSyncLock({
    asset,
    options: {
      syncLock: clip?.syncLock,
    },
    startTime: clip?.startTime || 0,
    duration: clip?.duration || 0,
    fps: safeFps,
  })
  if (resolved) return resolved

  const assembly = clip?.metadata?.musicVideoAssembly || null
  if (assembly?.mode !== MUSIC_VIDEO_TIMELINE_ASSEMBLY_MODE || assembly?.kind !== 'video') return null

  const yolo = asset?.yolo || asset?.settings?.yolo || null
  const startTime = roundToFrame(Math.max(0, Number(assembly.audioStart ?? clip?.startTime) || 0), safeFps)
  const duration = roundDurationToFrame(Math.max(1 / safeFps, Number(assembly.length ?? clip?.duration) || 1 / safeFps), safeFps)
  const shotType = normalizeMusicVideoShotType(clip?.syncLock?.shotType || yolo?.shotType || '')

  return {
    mode: 'sync',
    source: 'music-video',
    reason: 'song-sync',
    startTime,
    audioStart: startTime,
    duration,
    length: duration,
    shotType,
    sceneId: assembly.sceneId || yolo?.sceneId || '',
    shotId: assembly.shotId || yolo?.shotId || '',
    variantKey: assembly.variantKey || yolo?.variantKey || yolo?.key || '',
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
  if (clip.syncLock === false) {
    return {
      ...clip,
      syncLock: {
        mode: 'manual',
        source: 'manual',
        reason: 'manual-unlock',
      },
    }
  }
  if (isSyncLockedClip(clip)) return applySyncLockToClip(clip, fps)
  const asset = assetsById?.get?.(clip.assetId) || null
  const syncLock = resolveClipSyncLock({
    asset,
    options: {
      syncLock: clip.syncLock,
    },
    startTime: clip.startTime,
    duration: clip.duration,
    fps,
  })
  return syncLock ? applySyncLockToClip({ ...clip, lockMode: 'sync', syncLock }, fps) : clip
}

const dedupeClipIds = (clipIds = []) => [...new Set((clipIds || []).filter(Boolean))]
const RIPPLE_TIME_EPSILON = 1e-6
const normalizeClipLabelColor = (color) => {
  const value = String(color || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : ''
}

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
          ...(clip.volumeEnvelope != null ? { volumeEnvelope: shiftAudioVolumeEnvelope(clip, -durationDiff) } : {}),
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
  clip?.type === 'image' || clip?.type === 'adjustment' || clip?.type === 'text' || clip?.type === 'shape' || clip?.type === 'captions'
)
const supportsClipAdjustments = (clip) => (
  clip?.type === 'video'
  || clip?.type === 'image'
  || clip?.type === 'text'
  || clip?.type === 'shape'
  || clip?.type === 'adjustment'
)

const supportsLowerLayerCompositeMode = (clip) => (
  clip?.type === 'video'
  || clip?.type === 'image'
  || clip?.type === 'text'
  || clip?.type === 'shape'
)

const floorDurationToFrame = (duration, fps) => {
  const safeFps = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : FRAME_RATE
  const minDuration = 1 / safeFps
  const parsed = Number(duration)
  if (!Number.isFinite(parsed) || parsed <= 0) return minDuration
  return Math.max(minDuration, Math.floor((parsed * safeFps) + 1e-6) / safeFps)
}

const clampFiniteMediaClipToSource = (clip, fps) => {
  if (!clip || !['video', 'audio', 'compound'].includes(clip.type)) return clip
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

const applyClipTrimUpdate = (clip, updates, timelineFps) => {
  const next = { ...clip, ...updates }
  const timeScale = Math.max(0.0001, Number(getClipTimeScale(next)) || 1)
  const fps = timelineFps || 24
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
        clipId: clip.id,
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

  const trimmed = isSyncLockedClip(clip) ? applySyncLockToClip(normalized, fps) : normalized
  if (clip.volumeEnvelope != null && updates.volumeEnvelope === undefined) {
    const startDelta = Number(trimmed.startTime) - Number(clip.startTime)
    const durationDelta = Number(clip.duration) - Number(trimmed.duration)
    const sourceHeadChanged = Math.abs(Number(trimmed.trimStart) - Number(clip.trimStart)) > 1e-7
    // A move keeps duration; a slip moves both source bounds. Neither changes
    // the local envelope origin. Head trims use the actual normalized timeline
    // delta, never source seconds (which differ for speed/FPS/reverse media).
    const headDelta = Math.abs(durationDelta) <= 1e-7 ? 0
      : updates.startTime != null && Math.abs(startDelta) > 1e-7 ? startDelta
        : updates.trimStart != null && updates.trimEnd == null && sourceHeadChanged ? durationDelta : 0
    if (headDelta !== 0) return { ...trimmed, volumeEnvelope: shiftAudioVolumeEnvelope(clip, headDelta) }
  }
  return trimmed
}

const createDefaultClipTransform = () => ({
  positionX: 0,
  positionY: 0,
  positionZ: 0,
  scaleX: 100,
  scaleY: 100,
  scaleLinked: true,
  rotation: 0,
  rotationX: 0,
  rotationY: 0,
  perspective: 1200,
  anchorX: 50,
  anchorY: 50,
  opacity: 100,
  flipH: false,
  flipV: false,
  cropTop: 0,
  cropBottom: 0,
  cropLeft: 0,
  cropRight: 0,
  motionBlurEnabled: false,
  motionBlurMode: 'auto',
  motionBlurSamples: 8,
  motionBlurShutter: 180,
  blendMode: 'normal',
  blur: 0,
})

// Source-monitor edits are planned without touching the store. Opaque,
// short-lived tokens bind the displayed destinations/range to that exact
// timeline snapshot; neither previews nor rejected clicks create history.
const sourceEditTokens = new WeakMap()
const mcpEditingTokens = new WeakMap()
const smartReplaceTokens = new WeakMap()
const compoundCreateTokens = new WeakMap()
const uncompoundTokens = new WeakMap()
const rollEditTokens = new WeakMap()
const slipEditTokens = new WeakMap()
const slideEditTokens = new WeakMap()
const rippleTrimTokens = new WeakMap()
const SMART_REPLACE_STATE_KEYS = [
  'clips', 'tracks', 'transitions', 'markers', 'timelineFps', 'timelineSessionId',
  'history', 'historyIndex', 'duration', 'isPlaying', 'selectedClipIds',
]
const UNCOMPOUND_STATE_KEYS = [...SMART_REPLACE_STATE_KEYS, 'clipCounter', 'markerCounter', 'compoundEditContext']
const ROLL_EDIT_STATE_KEYS = [...UNCOMPOUND_STATE_KEYS, 'transitionCounter', 'zoom', 'masterAudioVolume', 'masterAudioInserts']
const SLIDE_EDIT_STATE_KEYS = [...ROLL_EDIT_STATE_KEYS, 'rippleEditMode', 'snappingEnabled', 'snappingThreshold']
const RIPPLE_TRIM_STATE_KEYS = [...ROLL_EDIT_STATE_KEYS, 'rippleEditMode', 'snappingEnabled', 'snappingThreshold', 'playheadPosition', 'inPoint', 'outPoint']
const publicRollSession = session => pickFields(session, ['clipAId', 'clipBId', 'originalEditPoint',
  'clipAOriginalDuration', 'clipBOriginalStart', 'clipBOriginalDuration'])
const publicRollResult = (session, plan, changed = plan.changed) => ({ ok: true, changed, delta: plan.delta,
  session: publicRollSession(session), bounds: structuredClone(session.bounds), feedback: plan.feedback })
const publicSlipResult = (session, plan, changed = plan.changed) => ({ ok: true, changed, delta: plan.delta,
  session: pickFields(session, ['clipId', 'originalTrimStart', 'originalTrimEnd', 'originalStartTime', 'originalDuration', 'timeScale']),
  bounds: structuredClone(session.bounds), feedback: plan.feedback })
const publicSlideResult = (session, plan, changed = plan.changed) => ({ ok: true, changed, delta: plan.delta,
  session: structuredClone(pickFields(session, ['clipId', 'previousClipId', 'nextClipId', 'originalStartTime', 'originalDuration', 'snapExcludedClipIds'])),
  bounds: structuredClone(session.bounds), feedback: plan.feedback })
const publicRippleTrimResult = (session, plan, changed = plan.changed) => ({ ok: true, changed,
  delta: plan.delta, durationDelta: plan.durationDelta,
  session: structuredClone(pickFields(session, ['clipId', 'edge', 'primaryEdgeTime', 'originalStartTime', 'originalDuration',
    'targetClipIds', 'snapExcludedClipIds', 'affectedTrackNames', 'shiftedClipCount', 'linkedTargetCount'])),
  bounds: structuredClone(session.bounds), feedback: plan.feedback })
const smartReplaceRequestKey = request => JSON.stringify([
  request.clipId, Object.hasOwn(request, 'sourceInSeconds'), request.sourceInSeconds, request.asset,
])
const SOURCE_EDIT_STATE_KEYS = [
  'clips', 'tracks', 'transitions', 'markers', 'timelineFps', 'activeTrackId',
  'playheadPosition', 'timelineSessionId', 'clipCounter', 'duration',
  'history', 'historyIndex', 'isPlaying',
]
const sourceEditRequestKey = (request) => JSON.stringify([
  request.mode, request.inPoint ?? null, request.outPoint ?? null,
  request.sourceDuration ?? null, request.asset, request.trackId, request.audioTrackId, request.startSeconds,
])

const buildSourceEditPlan = (state, request = {}) => {
  const asset = request.asset
  const mode = request.mode
  const info = { mode, targetTrackNames: [], affectedTrackNames: [], videoTrackName: null, audioTrackName: null }
  const fail = reason => ({ ...info, ok: false, reason })
  if (!['insert', 'overwrite', 'append'].includes(mode)) return fail('Choose Insert, Overwrite, or Add to End.')
  if (!asset?.id || !['video', 'audio'].includes(asset.type)) return fail('Preview a video or audio source first.')
  if (!asset.url) return fail('This source is unavailable. Relink it before editing.')
  const fps = Number(state.timelineFps)
  if (!Number.isFinite(fps) || fps <= 0) return fail('Set a valid timeline frame rate first.')
  const isAudio = asset.type === 'audio'
  const compatible = track => track.type === (isAudio ? 'audio' : 'video')
    && track.locked !== true && !isCaptionsTrack(track)
  const explicitTarget = request.trackId == null ? null : state.tracks.find(track => track.id === request.trackId)
  if (request.trackId != null && (!explicitTarget || !compatible(explicitTarget) || isCompoundLocked(explicitTarget))) return fail('Choose one unlocked compatible destination track.')
  const target = explicitTarget || state.tracks.find(track => track.id === state.activeTrackId && compatible(track))
    || state.tracks.find(compatible)
  if (!target) return fail(`No unlocked ${isAudio ? 'audio' : 'video'} destination is available. Add or unlock a track.`)
  const needsAudio = !isAudio && asset.hasAudio !== false && asset.audioEnabled !== false
  const explicitAudio = request.audioTrackId == null ? null : state.tracks.find(track => track.id === request.audioTrackId)
  if (request.audioTrackId != null && (!explicitAudio || explicitAudio.type !== 'audio' || isCompoundLocked(explicitAudio) || explicitAudio.visible === false || isCaptionsTrack(explicitAudio))) return fail('Choose one unlocked audio destination track.')
  const audioTrack = isAudio ? target : needsAudio
    ? explicitAudio || state.tracks.find(track => track.type === 'audio' && track.locked !== true && track.visible !== false)
    : null
  info.videoTrackName = isAudio ? null : target.name || target.id
  info.audioTrackName = audioTrack ? audioTrack.name || audioTrack.id : null
  const destinations = isAudio || !audioTrack ? [target] : [target, audioTrack]
  info.targetTrackNames = destinations.map(track => track.name || track.id)
  if (needsAudio && !audioTrack) return fail('This source includes audio. Add or unlock an audio track, or disable the source audio first.')
  if (state.isPlaying) return fail('Pause timeline playback before editing from the source viewer.')

  // Stay inside both the known file extent and the auditioned extent. Never
  // invent the old five-second fallback for a source which has not loaded.
  const extents = [request.sourceDuration, asset.duration, asset.settings?.duration]
    .map(Number).filter(value => Number.isFinite(value) && value > 0)
  if (!extents.length) return fail('Wait for the source duration to load before editing.')
  const sourceDuration = Math.min(...extents)
  const sourceIn = request.inPoint == null ? 0 : Number(request.inPoint)
  const sourceOut = request.outPoint == null ? sourceDuration : Number(request.outPoint)
  if (!Number.isFinite(sourceIn) || !Number.isFinite(sourceOut) || sourceIn < 0
    || sourceOut > sourceDuration + 1e-7 || sourceOut <= sourceIn) {
    return fail('Choose an In/Out range inside the available source.')
  }
  // A whole timeline-frame duration must fit inside the requested range.
  // Keep source seconds real-time even when source and timeline FPS differ.
  const frames = Math.floor((Math.min(sourceOut, sourceDuration) - sourceIn) * fps + 1e-7)
  if (frames < 1) return fail('Choose a source range at least one timeline frame long.')
  const duration = frames / fps
  const destinationIds = new Set(destinations.map(track => track.id))
  const destinationEnd = state.clips.filter(clip => destinationIds.has(clip.trackId))
    .reduce((end, clip) => Math.max(end, Number(clip.startTime) + Number(clip.duration)), 0)
  if (request.startSeconds !== undefined && (typeof request.startSeconds !== 'number' || !Number.isFinite(request.startSeconds) || request.startSeconds < 0)) return fail('Destination time must be finite and non-negative.')
  const startTime = mode === 'append'
    ? Math.ceil(destinationEnd * fps - 1e-7) / fps
    : roundToFrame(request.startSeconds ?? Math.max(0, Number(state.playheadPosition) || 0), fps)
  Object.assign(info, { startTime, duration })
  if (!Number.isFinite(startTime)) return fail('The destination contains invalid clip timing. Fix it before adding a source.')
  if (resolveClipSyncLock({ asset, startTime, duration, fps })) {
    return fail('This source is tied to song timing. Use its sync-aware placement workflow instead.')
  }

  let counter = getNextClipCounter(state.clips, state.clipCounter || 1)
  const firstId = `clip-${counter}`
  const usedLinks = new Set(state.clips.map(clip => clip.linkGroupId).filter(Boolean))
  let linkGroupId = needsAudio ? `link-source-edit-${counter}` : null
  while (linkGroupId && usedLinks.has(linkGroupId)) linkGroupId += '-new'
  const defaults = asset.settings?.defaultTransform && typeof asset.settings.defaultTransform === 'object'
    ? structuredClone(asset.settings.defaultTransform) : {}
  const newClips = destinations.map(track => {
    const idNumber = counter++
    const type = track.type === 'audio' ? 'audio' : 'video'
    const sourceFps = Number(asset.settings?.fps ?? asset.fps)
    return {
      id: `clip-${idNumber}`, trackId: track.id, assetId: asset.id,
      name: asset.name, url: asset.url, thumbnail: asset.url, type, enabled: true,
      startTime, duration, trimStart: sourceIn, trimEnd: sourceIn + duration,
      sourceDuration, sourceTimeScale: 1, timelineFps: fps,
      sourceFps: Number.isFinite(sourceFps) && sourceFps > 0 ? sourceFps : null,
      speed: 1, reverse: false,
      color: type === 'video' ? getVideoColor(idNumber) : getAudioColor(track.id),
      transform: { ...createDefaultClipTransform(), ...structuredClone(defaults) },
      ...(type === 'video' ? { frameSampling: normalizeFrameSamplingMode(), compositeLowerLayers: CLIP_COMPOSITE_MODE.AUTO }
        : { gainDb: 0, fadeIn: 0, fadeOut: 0 }),
      ...(linkGroupId ? { linkGroupId } : {}),
      metadata: {
        addedBySourcePlayer: true,
        ...(needsAudio && type === 'audio' ? { linkedVideoClipId: firstId, embeddedAudioFromVideoAsset: true } : {}),
      },
    }
  })
  const plan = planSourceTimelineEdit({
    clips: state.clips, tracks: state.tracks, transitions: state.transitions,
    markers: state.markers, fps, mode, startTime, duration, newClips, clipCounter: counter,
  })
  if (!plan.ok) return fail(plan.reason)
  // Whole-compound moves are safe; splitting, removing or extending its
  // embedded source through overwrite/insert is not supported yet.
  for (const compound of state.clips.filter(isCompoundClip)) {
    const retained = plan.clips.find(clip => clip.id === compound.id)
    if (!retained || retained.duration !== compound.duration || retained.trimStart !== compound.trimStart
      || retained.trimEnd !== compound.trimEnd || plan.clips.some(clip => isCompoundClip(clip) && !state.clips.some(old => old.id === clip.id))) {
      return fail('Source edits cannot cut or overwrite a compound yet. Move the compound or open it to edit its layers.')
    }
  }
  if (state.compoundEditContext) {
    const valid = validateCompoundDocument({ ...getLiveChildDocument(state), clips: plan.clips,
      transitions: plan.transitions, markers: plan.markers })
    if (!valid.ok) return fail(valid.reason)
  }
  return {
    ...info, ok: true, plan, clipIds: newClips.map(clip => clip.id),
    affectedTrackNames: state.tracks.filter(track => plan.affectedTrackIds.includes(track.id)).map(track => track.name || track.id),
  }
}

const sanitizeClipForHistory = (clip) => {
  const cloned = sanitizeCompoundChildren(JSON.parse(JSON.stringify(clip)), sanitizeClipForHistory)
  if (!cloned?.opticalFlowCache) return cloned
  const {
    url: _url,
    progress: _progress,
    error: _error,
    jobId: _jobId,
    frame: _frame,
    fps: _fps,
    ...descriptor
  } = cloned.opticalFlowCache
  return {
    ...cloned,
    opticalFlowCache: descriptor.path
      ? { ...descriptor, status: 'stale', progress: 0 }
      : undefined,
  }
}

const opticalFlowDescriptorKey = cache => {
  if (!cache?.path || !cache.sourceSignature) return null
  const { url, status, progress, error, jobId, frame, fps, ...descriptor } = cache
  return JSON.stringify(Object.fromEntries(Object.entries(descriptor).sort(([a], [b]) => a.localeCompare(b))))
}

const restoreHistoryClips = (snapshotClips = [], currentClips = [], verifiedSourceCaches = null) => {
  // Uncompound changes instance IDs, not source-cache identity. Carry only
  // verified source interpolation across that remap, never a full render bake.
  const caches = verifiedSourceCaches || currentClips.flatMap(clip => isCompoundClip(clip)
    ? clip.compound?.document?.clips || [] : [clip]).filter(clip => clip.assetId
      && clip.opticalFlowCache?.status === 'ready' && !clip.opticalFlowCache.jobId
      && opticalFlowDescriptorKey(clip.opticalFlowCache) && isOpticalFlowCacheUsable(clip))
  const currentById = new Map(currentClips.map((clip) => [clip.id, clip]))
  return snapshotClips.map((snapshotClip) => {
    const currentClip = currentById.get(snapshotClip.id)
    const canKeepRuntimeCache = currentClip
      && currentClip.assetId === snapshotClip.assetId
      && currentClip.opticalFlowCache
    const descriptor = opticalFlowDescriptorKey(snapshotClip.opticalFlowCache)
    const remappedCacheClip = !currentClip && descriptor && caches.find(clip => clip.assetId === snapshotClip.assetId
      && opticalFlowDescriptorKey(clip.opticalFlowCache) === descriptor
      && isOpticalFlowCacheUsable({ ...snapshotClip, opticalFlowCache: clip.opticalFlowCache }))
    const restored = sanitizeCompoundChildren(snapshotClip,
      child => restoreHistoryClips([child], currentClip?.compound?.document?.clips || [], caches)[0])
    return {
      ...restored,
      opticalFlowCache: canKeepRuntimeCache
        ? { ...currentClip.opticalFlowCache }
        : remappedCacheClip ? { ...remappedCacheClip.opticalFlowCache }
        : snapshotClip.opticalFlowCache,
    }
  })
}

const createHistorySnapshot = (state) => ({
  clips: state.clips.map(sanitizeClipForHistory),
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

// Keep selections alive across undo/redo when their targets still exist in
// the restored snapshot. Blanket-clearing forced a re-select after every
// undo (empty Inspector / Dope Sheet); only stale references should drop —
// e.g. undoing past a clip's creation deselects that clip.
const reconcileSelectionWithSnapshot = (state, snapshot) => ({
  selectedClipIds: (state.selectedClipIds || []).filter((clipId) => (
    (snapshot.clips || []).some((clip) => clip.id === clipId)
  )),
  selectedTransitionId: (snapshot.transitions || []).some((transition) => transition.id === state.selectedTransitionId)
    ? state.selectedTransitionId
    : null,
  selectedMarkerId: (snapshot.markers || []).some((marker) => marker.id === state.selectedMarkerId)
    ? state.selectedMarkerId
    : null,
  selectedGap: null,
  textEditRequest: null,
})

const DOCUMENT_KEYS = ['duration', 'zoom', 'masterAudioVolume', 'masterAudioInserts', 'tracks', 'clips', 'transitions',
  'markers', 'clipCounter', 'transitionCounter', 'markerCounter', 'snappingEnabled', 'snappingThreshold', 'rippleEditMode']
const COMPOUND_UI_KEYS = ['timelineFps', 'playheadPosition', 'selectedClipIds', 'selectedTransitionId', 'selectedMarkerId',
  'selectedGap', 'activeTrackId', 'inPoint', 'outPoint', 'history', 'historyIndex', 'historyLastChangedAt', 'zoom', 'viewportNavigation']
const pickFields = (state, keys) => Object.fromEntries(keys.map(key => [key, state[key]]))
// Selection focus is a temporary view, not a saved zoom/compound child edit.
// Ordinary zoom controls still author their existing saved zoom preference.
const getDocumentZoom = state => {
  const navigation = state.viewportNavigation
  return navigation && navigation.zoom === state.zoom && navigation.context === state.compoundEditContext
    ? navigation.documentZoom : state.zoom
}
const rawActiveDocument = state => ({ ...pickFields(state, DOCUMENT_KEYS), zoom: getDocumentZoom(state) })
const compoundProjectionCache = new WeakMap()
const getLiveChildDocument = state => {
  const context = state.compoundEditContext
  const active = rawActiveDocument(state)
  const document = { ...context.originalChildDocument, ...active,
    fps: context.originalChildDocument.fps, width: context.originalChildDocument.width, height: context.originalChildDocument.height,
    duration: getCompoundDocumentExtent({ ...context.originalChildDocument, clips: state.clips }, context.originalChildDocument.duration) }
  const valid = validateCompoundDocument(document)
  if (!valid.ok) throw new Error(valid.reason)
  return document
}
const clearCompoundRenderCache = clip => ({ ...clip, cacheStatus: 'none', cacheProgress: 0, cacheUrl: null,
  cachePath: null, cacheKind: null, cacheSignature: null, opticalFlowCache: undefined })
const compoundCacheKeys = new Set(['cacheStatus', 'cacheProgress', 'cacheUrl', 'cachePath', 'cacheKind', 'cacheSignature', 'opticalFlowCache'])
const compoundAuthoringKey = document => JSON.stringify({ ...document,
  clips: document.clips.map(clip => Object.fromEntries(Object.entries(clip).filter(([key]) => !compoundCacheKeys.has(key)))) })
const getRootDocument = state => {
  const context = state.compoundEditContext
  if (!context) return rawActiveDocument(state)
  const cached = compoundProjectionCache.get(context)
  if (cached && DOCUMENT_KEYS.every(key => cached.fields[key] === (key === 'zoom' ? getDocumentZoom(state) : state[key]))) return cached.document
  const child = getLiveChildDocument(state)
  const changed = compoundAuthoringKey(child) !== compoundAuthoringKey(context.originalChildDocument)
  const document = JSON.stringify(child) === JSON.stringify(context.originalChildDocument) ? context.parentDocument
    : { ...context.parentDocument, clips: context.parentDocument.clips.map(clip => clip.id !== context.compoundClipId ? clip
    : { ...(changed ? clearCompoundRenderCache(clip) : clip), sourceDuration: Math.max(clip.sourceDuration, child.duration), compound: { version: 1, document: child } }) }
  compoundProjectionCache.set(context, { fields: rawActiveDocument(state), document, changed })
  return document
}
const sanitizeProjectClip = clip => sanitizeCompoundChildren({ ...clip,
  ...(clip.opticalFlowCache ? { opticalFlowCache: { ...clip.opticalFlowCache, url: undefined,
    status: clip.opticalFlowCache.path ? 'ready' : 'none', progress: clip.opticalFlowCache.path ? 100 : 0, error: undefined, jobId: undefined } } : {}),
}, child => sanitizeProjectClip({ ...child, cacheUrl: null }))
const serializedProjectClips = new WeakMap()
const serializeRootDocument = state => {
  const document = getRootDocument(state)
  let clips = serializedProjectClips.get(document.clips)
  if (!clips) { clips = document.clips.map(sanitizeProjectClip); serializedProjectClips.set(document.clips, clips) }
  return { ...document, clips }
}
const compoundNavigationReset = { isPlaying: false, playbackRate: 1, shuttleMode: false, loopMode: 'normal',
  playheadSeekIntent: null, playbackJump: null, playbackJumpError: null, playAround: null,
  activeSnapTime: null, textEditRequest: null, maskPickerRequest: null, maskEditActive: false,
  maskDrawActive: false, copiedClips: [], attributeClipboard: null, keyframeClipboard: null,
  previewProxyStatus: 'none', previewProxyProgress: 0, previewProxyPath: null, previewProxySignature: null, rangeRenderState: null }

// These checks run BEFORE each action can save history. Existing ordinary
// clip paths remain unchanged; unsupported parent-compound mutations and
// overlapping writes fail closed until their semantics are implemented.
const withCompoundGuards = (actions, get) => {
  const parentUnsupported = new Set(['setClipBypass', 'updateClipSpeed', 'updateClipReverse', 'updateClipFrameSampling',
    'updateClipTransform', 'updateClipCompositeMode', 'updateClipTrackMatte', 'updateClipAdjustments', 'updateClipShapeMask',
    'updateAudioClipProperties', 'resetClipTransform', 'setKeyframe', 'removeKeyframe', 'moveKeyframeTime',
    'moveKeyframesAtTime', 'pasteKeyframesFromClipboard', 'toggleKeyframe', 'updateKeyframeEasing', 'clearPropertyKeyframes',
    'clearAllKeyframes', 'addEffect', 'removeEffect', 'updateEffect', 'toggleEffect', 'reorderEffect', 'addMaskEffect', 'addEdgeTransition'])
  const childUnsupported = new Set(['placeLiveCaptions', 'addAdjustmentClip', 'addTransition', 'addEdgeTransition',
    'toggleTrackSolo', 'setTrackInserts', 'setMasterAudioVolume', 'setMasterAudioInserts', 'setTimelineFps', 'clearProject'])
  const intersects = (a, b) => a.trackId === b.trackId && a.startTime < b.startTime + b.duration - 1e-7 && a.startTime + a.duration > b.startTime + 1e-7
  const badPositions = (state, changes) => {
    const ids = new Set(changes.map(clip => clip.id))
    const candidates = [...state.clips.filter(clip => !ids.has(clip.id)), ...changes]
    return changes.some(clip => {
      const track = state.tracks.find(track => track.id === clip.trackId)
      if (isCompoundClip(clip) && (!track || track.type !== 'video' || isCaptionsTrack(track) || isCompoundLocked(clip)
        || isCompoundLocked(track) || track.visible === false || track.muted)) return true
      return candidates.some(other => other.id !== clip.id && (isCompoundClip(other) || isCompoundClip(clip)) && intersects(clip, other))
    })
  }
  const denied = name => /^(preview|apply|rename)/.test(name)
    ? { ok: false, changed: false, reason: 'This operation is not supported for compound clips yet. Open the compound to edit its layers.' } : null
  for (const [name, action] of Object.entries(actions)) {
    if (typeof action !== 'function') continue
    actions[name] = (...args) => {
      const state = get()
      const compounds = state.clips.filter(isCompoundClip)
      if (name === 'pasteClipsAtPlayhead' && state.copiedClips.some(isCompoundClip)) return denied(name)
      if (name === 'addClip' && args[1]?.type === 'compound') return denied(name)
      if (!state.compoundEditContext && !compounds.length) return action(...args)
      const first = state.clips.find(clip => clip.id === args[0])
      if (state.compoundEditContext) {
        if (childUnsupported.has(name)) return denied(name)
        if (name === 'addClip' && (!['video', 'image', 'audio'].includes(args[1]?.type)
          || args[1]?.settings?.defaultTransform?.blendMode && args[1].settings.defaultTransform.blendMode !== 'normal'
          || args[4]?.transform?.blendMode && args[4].transform.blendMode !== 'normal')) return denied(name)
        if (name === 'pasteClipsAtPlayhead' && state.copiedClips.some(clip => !validateCompoundDocument({
          ...state.compoundEditContext.originalChildDocument, clips: [{ ...clip, startTime: 0 }] }).ok)) return denied(name)
        if (['applyPasteAttributes', 'applyMultiClipInspectorEdit'].includes(name)) {
          const changes = args[0]?.changes || args[0]?.updates || args[0] || {}
          if (changes.trackMatte && changes.trackMatte !== 'none' || changes.compositeLowerLayers === 'off'
            || changes.transform?.blendMode && changes.transform.blendMode !== 'normal') return denied(name)
        }
        if (name === 'addTrack' && (!['video', 'audio'].includes(args[0]) || args[1]?.role === 'captions')) return denied(name)
        if (name === 'updateClipTrackMatte' && args[1] !== 'none' || name === 'updateClipCompositeMode' && args[1] === 'off'
          || name === 'updateClipTransform' && args[1]?.blendMode && args[1].blendMode !== 'normal') return denied(name)
      }
      if (compounds.length) {
        if (name === 'setTimelineFps' && args[0] !== state.timelineFps) return denied(name)
        if (isCompoundClip(first) && parentUnsupported.has(name)) return denied(name)
        if (name === 'addTransition' && [args[0], args[1]].some(id => compounds.some(clip => clip.id === id))) return denied(name)
        if (['copySelectedClips', 'linkSelectedClips', 'unlinkSelectedClips'].includes(name)
          && compounds.some(clip => state.selectedClipIds.includes(clip.id))) return denied(name)
        if (name === 'duplicateClipsForDrag' && compounds.some(clip => (args[0] || []).includes(clip.id))) return denied(name)
        if (['getPasteAttributesPreview', 'applyPasteAttributes', 'applyMultiClipInspectorEdit', 'applyMultiClipEffectsEdit'].includes(name)
          && compounds.some(clip => (args[0]?.clipIds || state.selectedClipIds).includes(clip.id))) return denied(name)
        const deleting = name === 'removeClip' ? [args[0]] : name === 'removeSelectedClips' ? state.selectedClipIds
          : name === 'rippleDeleteClipIds' || name === 'setClipsEnabled' ? args[0] : []
        if (compounds.some(clip => deleting?.includes(clip.id) && (isCompoundLocked(clip) || isCompoundLocked(state.tracks.find(track => track.id === clip.trackId))))) return denied(name)
      }
      let changes = []
      if (name === 'moveClip' && first) changes = [{ ...first, trackId: args[1], startTime: Math.max(0, args[2]) }]
      if (['setSelectedClipPositions', 'setSelectedClipsStartTimes'].includes(name)) changes = (args[0] || []).map(update => ({ ...state.clips.find(clip => clip.id === update.id), ...update }))
      if (name === 'moveSelectedClips') changes = state.clips.filter(clip => (args[3] || state.selectedClipIds).includes(clip.id))
        .map(clip => ({ ...clip, startTime: Math.max(0, clip.startTime + args[0]), trackId: args[1] || clip.trackId }))
      if (name === 'resizeClip' && first) changes = [{ ...first, duration: isCompoundClip(first) ? Math.min(args[1], first.sourceDuration - first.trimStart) : args[1] }]
      if (name === 'updateClipTrim' && first) {
        if (isCompoundClip(first) && Object.keys(args[1] || {}).some(key => !['startTime', 'duration', 'trimStart', 'trimEnd'].includes(key))) return denied(name)
        changes = [applyClipTrimUpdate(first, args[1], state.timelineFps)]
      }
      if (name === 'updateClipsTrim') {
        for (const item of args[0] || []) {
          const clip = state.clips.find(clip => clip.id === item.id)
          if (isCompoundClip(clip)) {
            if (Object.keys(item.updates || {}).some(key => !['startTime', 'duration', 'trimStart', 'trimEnd'].includes(key))) return denied(name)
          }
          if (clip) changes.push(applyClipTrimUpdate(clip, item.updates, state.timelineFps))
        }
      }
      if (compounds.length && changes.length && (badPositions(state, changes) || state.rippleEditMode)) return denied(name)
      if (compounds.length && ['addClip', 'addTextClip', 'addShapeClip', 'addAdjustmentClip', 'pasteClipsAtPlayhead'].includes(name)) {
        const trackId = args[0]
        const options = name === 'addClip' ? args[4] : name === 'addAdjustmentClip' ? args[2] : args[1]
        const startTime = name === 'addAdjustmentClip' ? args[1] : name === 'pasteClipsAtPlayhead' ? args[1] : args[2]
        const start = startTime ?? Math.max(0, ...state.clips.filter(clip => clip.trackId === trackId).map(clip => clip.startTime + clip.duration))
        const duration = options?.duration ?? (name === 'addClip' && args[1]?.type !== 'image' ? args[1]?.duration || args[1]?.settings?.duration : 5) ?? 5
        const candidates = name === 'pasteClipsAtPlayhead' ? state.copiedClips.map(clip => ({ ...clip, trackId, startTime: start + (clip.relativeStart || 0) })) : [{ trackId, startTime: start, duration }]
        if (candidates.some(candidate => compounds.some(clip => intersects(clip, candidate)))) return denied(name)
      }
      return action(...args)
    }
  }
  return actions
}

/**
 * Store for managing timeline state
 * Persisted to localStorage for data survival across refreshes
 */
export const useTimelineStore = create(
  persist(
    (set, get) => withCompoundGuards({
  // Timeline settings
  duration: 60, // Total timeline duration in seconds
  timelineFps: 24, // Timeline frame rate; clips are quantized to frame boundaries
  timelineSessionId: 1, // Increments whenever a project/timeline payload replaces the store
  compoundEditContext: null,
  compoundNavigationRevision: 0,
  compoundNavigationChangedDocument: false,
  zoom: 100, // Zoom level (100 = 1 second = ~20px)
  viewportNavigation: null, // Transient selection-focus zoom; never serialized
  viewportNavigationRevision: 0,
  playheadPosition: 0, // Current playhead position in seconds
  // Transient transport intent. A one-frame step must survive preview-source
  // swaps (for example Canvas -> rendered In→Out chunk) long enough for the
  // newly mounted renderer to request the exact decoded frame. Ordinary seeks
  // clear it in setPlayheadPosition.
  playheadSeekIntent: null,
  playheadSeekRevision: 0,
  playbackJump: null, // Transient target-picture handoff during active playback
  playbackJumpRevision: 0, // Never reset on timeline replacement: stale tokens cannot recur
  playbackJumpError: null,
  playAround: null, // Temporary Play Around range; never saved or added to Undo
  playAroundRevision: 0,
  isPlaying: false,
  
  // JKL Shuttle playback
  playbackRate: 1, // Playback speed multiplier (negative = reverse)
  shuttleMode: false, // Whether in JKL shuttle mode
  
  // Playback loop modes: 'normal', 'loop', 'loop-in-out', 'loop-selection', 'ping-pong'
  loopMode: 'normal',

  // Program master audio gain (0-200, 100 = unity). Unlike the monitor volume
  // knob, this is part of the program: it applies to export mixdowns too.
  masterAudioVolume: 100,

  // Master bus insert effects (compressor/limiter/reverb), processed before
  // the master fader. Part of the program: export applies them too.
  masterAudioInserts: [],

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
  // Independent, deep attribute snapshots. Never persisted or reused after a
  // project/timeline switch; normal clip paste keeps its existing buffer.
  attributeClipboard: null,

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
  // 'gpu' composites the preview through the shared WebGL2 compositor
  // (services/gpuCompositor.js — same engine as export); 'canvas' is the
  // 2D fallback / kill switch. A stored explicit choice is respected.
  previewCompositorMode: (typeof localStorage !== 'undefined' && localStorage.getItem('comfystudio-preview-compositor-mode')) || 'gpu',
  showTimelineClipThumbnails: (typeof localStorage === 'undefined' || localStorage.getItem('comfystudio-show-timeline-clip-thumbnails') !== 'false'),
  
  // Snapping settings
  snappingEnabled: true,
  snappingThreshold: 10, // pixels - distance at which snapping activates
  
  // Active snap indicator (for visual feedback)
  activeSnapTime: null, // Time position being snapped to (null = no active snap)
  
  // Ripple edit mode - when enabled, moving/trimming clips shifts subsequent clips
  rippleEditMode: false,

  // Mask edit mode (transient, not persisted): true while the Inspector's
  // Mask section is open on a masked clip, so the preview shows the mask
  // gizmo instead of the transform gizmo.
  maskEditActive: false,
  setMaskEditActive: (active) => {
    if (get().maskEditActive === !!active) return
    set({ maskEditActive: !!active })
  },
  // Pen-draw mode for spline masks: the monitor becomes a click-to-place
  // drawing surface while this is on. Transient like maskEditActive.
  maskDrawActive: false,
  setMaskDrawActive: (active) => {
    if (get().maskDrawActive === !!active) return
    set({ maskDrawActive: !!active })
  },
  /**
   * Place (or replace) the live captions clip: a synthetic clip whose cues
   * render fresh every frame in preview and export — no baked overlay video.
   * Reuses the dedicated role:'captions' track exactly like baked overlays.
   */
  placeLiveCaptions: ({ cues, preset, duration, workspace = null, name = 'Captions' } = {}) => {
    const safeCues = Array.isArray(cues) ? cues : []
    if (safeCues.length === 0) return null
    get().saveToHistory()

    let captionsTrack = get().tracks.find((t) => t.role === 'captions')
    if (!captionsTrack) {
      captionsTrack = get().addTrack('video', { role: 'captions', name: 'Captions' })
    }
    if (!captionsTrack) return null

    // One captions clip per timeline. An existing live clip survives as the
    // carrier — its transform, grade, masks, matte, bypass and keyframes ride
    // through a regenerate — while baked leftovers and strays clear out.
    const before = get().clips
    const carrier = before.find((clip) => clip.type === 'captions' && clip.trackId === captionsTrack.id)
      || before.find((clip) => clip.type === 'captions')
    before
      .filter((clip) => (clip.trackId === captionsTrack.id || clip.type === 'captions') && clip.id !== carrier?.id)
      .forEach((clip) => get().removeClip(clip.id))

    const safeDuration = Math.max(
      0.4,
      Number(duration) || Math.max(...safeCues.map((cue) => Number(cue?.end) || 0), 1)
    )
    // `workspace` is the caption workspace's own controls snapshot (preset id,
    // style controls, placement globals, word timings) — render-irrelevant,
    // but it makes the edit round-trip lossless across restarts and machines.
    const captionsPayload = {
      preset: preset || null,
      cues: safeCues,
      ...(workspace ? { workspace } : {}),
    }

    if (carrier) {
      set((state) => ({
        clips: state.clips.map((clip) => (clip.id === carrier.id
          ? {
              ...clip,
              trackId: captionsTrack.id,
              startTime: 0,
              duration: safeDuration,
              sourceDuration: safeDuration,
              trimStart: 0,
              trimEnd: safeDuration,
              captions: captionsPayload,
            }
          : clip)),
        selectedClipIds: [carrier.id],
        duration: Math.max(state.duration, safeDuration + 10),
      }))
      return get().clips.find((clip) => clip.id === carrier.id) || null
    }

    const current = get()
    const safeClipCounter = getNextClipCounter(current.clips, current.clipCounter || 1)
    const newClip = {
      id: `clip-${safeClipCounter}`,
      trackId: captionsTrack.id,
      assetId: null,
      name,
      startTime: 0,
      duration: safeDuration,
      sourceDuration: safeDuration,
      trimStart: 0,
      trimEnd: safeDuration,
      color: '#3E6B5C',
      type: 'captions',
      enabled: true,
      compositeLowerLayers: CLIP_COMPOSITE_MODE.AUTO,
      url: null,
      thumbnail: null,
      captions: captionsPayload,
      transform: {
        positionX: 0,
        positionY: 0,
        positionZ: 0,
        scaleX: 100,
        scaleY: 100,
        scaleLinked: true,
        rotation: 0,
        rotationX: 0,
        rotationY: 0,
        perspective: 1200,
        anchorX: 50,
        anchorY: 50,
        opacity: 100,
        flipH: false,
        flipV: false,
        cropTop: 0,
        cropBottom: 0,
        cropLeft: 0,
        cropRight: 0,
        motionBlurEnabled: false,
        motionBlurMode: 'auto',
        motionBlurSamples: 8,
        motionBlurShutter: 180,
        blendMode: 'normal',
        blur: 0,
      },
    }
    set((state) => ({
      clips: [...state.clips, newClip],
      clipCounter: Math.max(state.clipCounter, safeClipCounter + 1),
      selectedClipIds: [newClip.id],
      duration: Math.max(state.duration, newClip.duration + 10),
    }))
    return newClip
  },
  /**
   * Toggle a per-group bypass on a clip (mask | color | effects) — the
   * Resolve-style A/B switch. Settings are untouched; renderers read the
   * flags through utils/clipBypass.js.
   */
  setClipBypass: (clipId, group, bypassed) => {
    get().saveToHistory()
    set((state) => ({
      clips: state.clips.map((clip) => {
        if (clip.id !== clipId) return clip
        const next = { ...(clip.bypass || {}) }
        if (bypassed) next[group] = true
        else delete next[group]
        if (Object.keys(next).length === 0) {
          const { bypass, ...rest } = clip
          return rest
        }
        return { ...clip, bypass: next }
      })
    }))
  },
  
  // In/Out points for three-point editing
  inPoint: null, // Timeline in-point (seconds)
  outPoint: null, // Timeline out-point (seconds)

  // Render In→Out status for the timeline ruler (transient, not persisted —
  // getProjectData never includes it; PreviewPanel's render flow owns it).
  // { status: 'rendering'|'cached'|'stale', progress, rangeStart, rangeEnd, signature } | null
  rangeRenderState: null,

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
        clips: restoreHistoryClips(lastHistoryState.clips, state.clips),
        tracks: lastHistoryState.tracks,
        transitions: lastHistoryState.transitions,
        markers: lastHistoryState.markers || [],
        clipCounter: lastHistoryState.clipCounter,
        transitionCounter: lastHistoryState.transitionCounter,
        markerCounter: lastHistoryState.markerCounter || 1,
        history: historyWithCurrent,
        historyIndex: targetHistoryIndex,
        historyLastChangedAt: Date.now(),
        ...reconcileSelectionWithSnapshot(state, lastHistoryState),
      })
      return true
    }

    // Normal undo - go back in history
    if (state.historyIndex > 0) {
      const prevState = state.history[state.historyIndex - 1]
      set({
        clips: restoreHistoryClips(prevState.clips, state.clips),
        tracks: prevState.tracks,
        transitions: prevState.transitions,
        markers: prevState.markers || [],
        clipCounter: prevState.clipCounter,
        transitionCounter: prevState.transitionCounter,
        markerCounter: prevState.markerCounter || 1,
        historyIndex: state.historyIndex - 1,
        historyLastChangedAt: Date.now(),
        ...reconcileSelectionWithSnapshot(state, prevState),
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
        clips: restoreHistoryClips(nextState.clips, state.clips),
        tracks: nextState.tracks,
        transitions: nextState.transitions,
        markers: nextState.markers || [],
        clipCounter: nextState.clipCounter,
        transitionCounter: nextState.transitionCounter,
        markerCounter: nextState.markerCounter || 1,
        historyIndex: state.historyIndex + 1,
        historyLastChangedAt: Date.now(),
        ...reconcileSelectionWithSnapshot(state, nextState),
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

  getActiveDocumentData: () => {
    const state = get()
    return state.compoundEditContext ? getLiveChildDocument(state) : rawActiveDocument(state)
  },

  // Both sides are validated before any write. The private token retains the
  // original pair so pointer moves are cumulative, including envelope offsets.
  // Compound parents and same-track compound overlaps are rejected by the
  // planner itself, not only by the generic single-clip mutation wrappers.
  beginRollEdit: (request = {}) => {
    const state = get()
    if (state.isPlaying) return { ok: false, changed: false, reason: 'Pause playback before rolling a cut.' }
    const result = createRollEditSession({ clips: state.clips, tracks: state.tracks, transitions: state.transitions,
      clipAId: request?.clipAId, clipBId: request?.clipBId, fps: state.timelineFps })
    if (!result.ok) return result
    const plan = planRollEdit({ session: result.session, requestedDelta: 0 })
    if (!plan.ok) return plan
    const token = {}
    rollEditTokens.set(token, { session: result.session, expected: pickFields(state, ROLL_EDIT_STATE_KEYS),
      originalHistory: state.history, originalHistoryIndex: state.historyIndex,
      originalHistoryChangedAt: state.historyLastChangedAt, checkpointed: false, delta: 0 })
    return { ...publicRollResult(result.session, plan, false), token }
  },

  applyRollEdit: (token, requestedDelta) => {
    const state = get(), record = token && rollEditTokens.get(token)
    if (!record || record.writing || ROLL_EDIT_STATE_KEYS.some(key => state[key] !== record.expected[key])) {
      return { ok: false, changed: false, reason: 'The timeline or selection changed. Start a new rolling edit.' }
    }
    const plan = planRollEdit({ session: record.session, requestedDelta })
    if (!plan.ok) return plan
    if (plan.delta === record.delta) return publicRollResult(record.session, { ...plan,
      feedback: buildRollEditPreviewFeedback({ session: record.session, clips: state.clips,
        fps: state.timelineFps, requestedDelta, bounds: record.session.bounds }) }, false)
    const update = { clips: plan.clips }
    if (!record.checkpointed) {
      let snapshot
      try { snapshot = createHistorySnapshot(state) } catch (_) {
        return { ok: false, changed: false, reason: 'These clips cannot be checkpointed safely.' }
      }
      let history = state.historyIndex >= 0 ? state.history.slice(0, state.historyIndex + 1) : [...state.history]
      if (!history.length || !areHistorySnapshotsEqual(history[history.length - 1], snapshot)) history.push(snapshot)
      Object.assign(update, { history: history.slice(-MAX_HISTORY_SIZE), historyIndex: -1, historyLastChangedAt: Date.now() })
    }
    const expected = { ...record.expected }
    for (const key of ROLL_EDIT_STATE_KEYS) if (Object.hasOwn(update, key)) expected[key] = update[key]
    record.writing = true
    try { set(update) } finally { record.writing = false }
    record.checkpointed = true
    record.delta = plan.delta
    record.expected = expected
    if (ROLL_EDIT_STATE_KEYS.some(key => get()[key] !== expected[key])) {
      return { ok: false, changed: true, reason: 'The timeline changed during this rolling edit. Start a new gesture.' }
    }
    return publicRollResult(record.session, plan, true)
  },

  endRollEdit: token => {
    const state = get(), record = token && rollEditTokens.get(token)
    if (!record) return { ok: false, changed: false, reason: 'This rolling edit has already ended.' }
    rollEditTokens.delete(token)
    // Returning to the original pair is not an authored edit. Restore the exact
    // pre-gesture history (including a Redo branch), but never erase a later edit.
    if (record.checkpointed && record.delta === 0
      && ROLL_EDIT_STATE_KEYS.every(key => state[key] === record.expected[key])) {
      set({ history: record.originalHistory, historyIndex: record.originalHistoryIndex,
        historyLastChangedAt: record.originalHistoryChangedAt })
    }
    return { ok: true, changed: false }
  },

  // Slip changes only one ordinary source range. The private original clip
  // prevents cumulative drift; an idle gesture never checkpoints the document.
  beginSlipEdit: (request = {}) => {
    const state = get()
    if (state.isPlaying) return { ok: false, changed: false, reason: 'Pause playback before using Slip.' }
    const result = createSlipEditSession({ clips: state.clips, tracks: state.tracks, transitions: state.transitions,
      clipId: request?.clipId, fps: state.timelineFps })
    if (!result.ok) return result
    const plan = planSlipEdit({ session: result.session, requestedDelta: 0 })
    if (!plan.ok) return plan
    const token = {}
    slipEditTokens.set(token, { session: result.session, expected: pickFields(state, ROLL_EDIT_STATE_KEYS),
      originalHistory: state.history, originalHistoryIndex: state.historyIndex,
      originalHistoryChangedAt: state.historyLastChangedAt, checkpointed: false, delta: 0 })
    return { ...publicSlipResult(result.session, plan, false), token }
  },

  applySlipEdit: (token, requestedDelta) => {
    const state = get(), record = token && slipEditTokens.get(token)
    if (!record || record.writing || ROLL_EDIT_STATE_KEYS.some(key => state[key] !== record.expected[key])) {
      return { ok: false, changed: false, reason: 'The timeline or selection changed. Start a new Slip gesture.' }
    }
    const plan = planSlipEdit({ session: record.session, requestedDelta })
    if (!plan.ok) return plan
    if (plan.delta === record.delta) return publicSlipResult(record.session, { ...plan,
      feedback: buildSlipEditPreviewFeedback({ session: record.session, clips: state.clips,
        fps: state.timelineFps, requestedDelta, bounds: record.session.bounds }) }, false)
    const update = { clips: plan.clips }
    if (!record.checkpointed) {
      let snapshot
      try { snapshot = createHistorySnapshot(state) } catch (_) {
        return { ok: false, changed: false, reason: 'This clip cannot be checkpointed safely.' }
      }
      let history = state.historyIndex >= 0 ? state.history.slice(0, state.historyIndex + 1) : [...state.history]
      if (!history.length || !areHistorySnapshotsEqual(history[history.length - 1], snapshot)) history.push(snapshot)
      Object.assign(update, { history: history.slice(-MAX_HISTORY_SIZE), historyIndex: -1, historyLastChangedAt: Date.now() })
    }
    const expected = { ...record.expected }
    for (const key of ROLL_EDIT_STATE_KEYS) if (Object.hasOwn(update, key)) expected[key] = update[key]
    record.writing = true
    try { set(update) } finally { record.writing = false }
    record.checkpointed = true
    record.delta = plan.delta
    record.expected = expected
    if (ROLL_EDIT_STATE_KEYS.some(key => get()[key] !== expected[key])) {
      return { ok: false, changed: true, reason: 'The timeline changed during this Slip edit. Start a new gesture.' }
    }
    return publicSlipResult(record.session, plan, true)
  },

  endSlipEdit: token => {
    const state = get(), record = token && slipEditTokens.get(token)
    if (!record) return { ok: false, changed: false, reason: 'This Slip gesture has already ended.' }
    slipEditTokens.delete(token)
    if (record.checkpointed && record.delta === 0
      && ROLL_EDIT_STATE_KEYS.every(key => state[key] === record.expected[key])) {
      set({ history: record.originalHistory, historyIndex: record.originalHistoryIndex,
        historyLastChangedAt: record.originalHistoryChangedAt })
    }
    return { ok: true, changed: false }
  },

  beginSlideEdit: (request = {}) => {
    const state = get()
    if (state.isPlaying) return { ok: false, changed: false, reason: 'Pause playback before using Slide.' }
    if (!Array.isArray(state.selectedClipIds) || state.selectedClipIds.length > 1
      || state.selectedClipIds.length === 1 && state.selectedClipIds[0] !== request?.clipId) {
      return { ok: false, changed: false, reason: 'Select only the middle clip before using Slide.' }
    }
    const result = createSlideEditSession({ clips: state.clips, tracks: state.tracks, transitions: state.transitions,
      clipId: request?.clipId, fps: state.timelineFps })
    if (!result.ok) return result
    const plan = planSlideEdit({ session: result.session, requestedDelta: 0 })
    if (!plan.ok) return plan
    const token = {}
    slideEditTokens.set(token, { session: result.session, expected: pickFields(state, SLIDE_EDIT_STATE_KEYS),
      originalHistory: state.history, originalHistoryIndex: state.historyIndex,
      originalHistoryChangedAt: state.historyLastChangedAt, checkpointed: false, delta: 0 })
    return { ...publicSlideResult(result.session, plan, false), token }
  },

  applySlideEdit: (token, requestedDelta) => {
    const state = get(), record = token && slideEditTokens.get(token)
    if (!record || record.writing || SLIDE_EDIT_STATE_KEYS.some(key => state[key] !== record.expected[key])) {
      return { ok: false, changed: false, reason: 'The timeline, selection or edit mode changed. Start a new Slide gesture.' }
    }
    const plan = planSlideEdit({ session: record.session, requestedDelta })
    if (!plan.ok) return plan
    if (plan.delta === record.delta) return publicSlideResult(record.session, { ...plan,
      feedback: buildSlideEditPreviewFeedback({ session: record.session, clips: state.clips, requestedDelta }) }, false)
    const update = { clips: plan.clips }
    if (!record.checkpointed) {
      let snapshot
      try { snapshot = createHistorySnapshot(state) } catch (_) {
        return { ok: false, changed: false, reason: 'The Slide clips cannot be checkpointed safely.' }
      }
      let history = state.historyIndex >= 0 ? state.history.slice(0, state.historyIndex + 1) : [...state.history]
      if (!history.length || !areHistorySnapshotsEqual(history[history.length - 1], snapshot)) history.push(snapshot)
      Object.assign(update, { history: history.slice(-MAX_HISTORY_SIZE), historyIndex: -1, historyLastChangedAt: Date.now() })
    }
    const expected = { ...record.expected }
    for (const key of SLIDE_EDIT_STATE_KEYS) if (Object.hasOwn(update, key)) expected[key] = update[key]
    record.writing = true
    try { set(update) } finally { record.writing = false }
    record.checkpointed = true
    record.delta = plan.delta
    record.expected = expected
    if (SLIDE_EDIT_STATE_KEYS.some(key => get()[key] !== expected[key])) {
      return { ok: false, changed: true, reason: 'The timeline changed during this Slide edit. Start a new gesture.' }
    }
    return publicSlideResult(record.session, plan, true)
  },

  endSlideEdit: token => {
    const state = get(), record = token && slideEditTokens.get(token)
    if (!record) return { ok: false, changed: false, reason: 'This Slide gesture has already ended.' }
    slideEditTokens.delete(token)
    if (record.checkpointed && record.delta === 0
      && SLIDE_EDIT_STATE_KEYS.every(key => state[key] === record.expected[key])) {
      set({ history: record.originalHistory, historyIndex: record.originalHistoryIndex,
        historyLastChangedAt: record.originalHistoryChangedAt })
    }
    return { ok: true, changed: false }
  },

  beginRippleTrim: (request = {}) => {
    const state = get()
    if (state.rippleEditMode !== true) return { ok: false, changed: false, reason: 'Turn on Ripple Edit before ripple trimming.' }
    if (state.isPlaying) return { ok: false, changed: false, reason: 'Pause playback before ripple trimming.' }
    const result = createRippleTrimSession({ clips: state.clips, tracks: state.tracks, transitions: state.transitions,
      clipId: request?.clipId, edge: request?.edge, targetClipIds: request?.targetClipIds, fps: state.timelineFps })
    if (!result.ok) return result
    const plan = planRippleTrim({ session: result.session, requestedDelta: 0 })
    if (!plan.ok) return plan
    const token = {}
    rippleTrimTokens.set(token, { session: result.session, expected: pickFields(state, RIPPLE_TRIM_STATE_KEYS),
      originalHistory: state.history, originalHistoryIndex: state.historyIndex,
      originalHistoryChangedAt: state.historyLastChangedAt, originalDuration: state.duration, checkpointed: false, delta: 0 })
    return { ...publicRippleTrimResult(result.session, plan, false), token }
  },

  applyRippleTrim: (token, requestedDelta) => {
    const state = get(), record = token && rippleTrimTokens.get(token)
    if (!record || record.writing || RIPPLE_TRIM_STATE_KEYS.some(key => state[key] !== record.expected[key])) {
      return { ok: false, changed: false, reason: 'The timeline, selection or ripple settings changed. Start a new ripple trim.' }
    }
    const plan = planRippleTrim({ session: record.session, requestedDelta })
    if (!plan.ok) return plan
    if (plan.delta === record.delta) return publicRippleTrimResult(record.session, { ...plan,
      feedback: buildRippleTrimPreviewFeedback({ session: record.session, clips: state.clips, requestedDelta }) }, false)
    const update = { clips: plan.clips, transitions: plan.transitions,
      duration: Math.max(record.originalDuration, ...plan.clips.map(clip => clip.startTime + clip.duration)) }
    if (!record.checkpointed) {
      let snapshot
      try { snapshot = createHistorySnapshot(state) } catch (_) {
        return { ok: false, changed: false, reason: 'The affected clips cannot be checkpointed safely.' }
      }
      let history = state.historyIndex >= 0 ? state.history.slice(0, state.historyIndex + 1) : [...state.history]
      if (!history.length || !areHistorySnapshotsEqual(history[history.length - 1], snapshot)) history.push(snapshot)
      Object.assign(update, { history: history.slice(-MAX_HISTORY_SIZE), historyIndex: -1, historyLastChangedAt: Date.now() })
    }
    const expected = { ...record.expected }
    for (const key of RIPPLE_TRIM_STATE_KEYS) if (Object.hasOwn(update, key)) expected[key] = update[key]
    record.writing = true
    try { set(update) } finally { record.writing = false }
    record.checkpointed = true
    record.delta = plan.delta
    record.expected = expected
    if (RIPPLE_TRIM_STATE_KEYS.some(key => get()[key] !== expected[key])) {
      return { ok: false, changed: true, reason: 'The timeline changed during this ripple trim. Start a new gesture.' }
    }
    return publicRippleTrimResult(record.session, plan, true)
  },

  endRippleTrim: token => {
    const state = get(), record = token && rippleTrimTokens.get(token)
    if (!record) return { ok: false, changed: false, reason: 'This ripple trim has already ended.' }
    rippleTrimTokens.delete(token)
    if (record.checkpointed && record.delta === 0
      && RIPPLE_TRIM_STATE_KEYS.every(key => state[key] === record.expected[key])) {
      set({ history: record.originalHistory, historyIndex: record.originalHistoryIndex,
        historyLastChangedAt: record.originalHistoryChangedAt })
    }
    return { ok: true, changed: false }
  },

  previewUncompound: (request = {}) => {
    const state = get()
    if (state.compoundEditContext) return { ok: false, changed: false, reason: 'Return to the parent timeline before uncompounding.' }
    if (state.isPlaying) return { ok: false, changed: false, reason: 'Pause playback before uncompounding.' }
    const plan = buildUncompoundPlan({ clips: state.clips, tracks: state.tracks, transitions: state.transitions, markers: state.markers,
      clipId: request?.clipId, clipCounter: state.clipCounter, markerCounter: state.markerCounter, fps: state.timelineFps })
    if (!plan.ok) return plan
    const token = {}
    uncompoundTokens.set(token, { plan, clipId: request.clipId, snapshot: pickFields(state, UNCOMPOUND_STATE_KEYS) })
    return { ok: true, changed: true, summary: structuredClone(plan.summary), token }
  },

  applyUncompound: (request = {}, token = null) => {
    const state = get(), record = token && uncompoundTokens.get(token)
    if (!record || request?.clipId !== record.clipId || UNCOMPOUND_STATE_KEYS.some(key => state[key] !== record.snapshot[key])) {
      return { ok: false, changed: false, reason: 'The timeline or selection changed. Review Uncompound again.' }
    }
    let snapshot
    try { snapshot = createHistorySnapshot(state) } catch (_) { return { ok: false, changed: false, reason: 'The compound cannot be checkpointed safely.' } }
    let history = state.historyIndex >= 0 ? state.history.slice(0, state.historyIndex + 1) : [...state.history]
    if (!history.length || !areHistorySnapshotsEqual(history[history.length - 1], snapshot)) history.push(snapshot)
    uncompoundTokens.delete(token)
    const plan = record.plan
    const restoredIds = new Set(plan.restoredClipIds)
    const restoredClips = plan.clips.filter(clip => restoredIds.has(clip.id))
    const firstVisual = restoredClips.find(clip => clip.type !== 'audio'
      && plan.tracks.some(track => track.id === clip.trackId && track.visible !== false && !track.muted))
    const activeTrackId = (firstVisual || restoredClips.find(clip => clip.type === 'audio') || restoredClips[0])?.trackId || state.activeTrackId
    set({ clips: plan.clips, tracks: plan.tracks, markers: plan.markers, clipCounter: plan.clipCounter, markerCounter: plan.markerCounter,
      activeTrackId,
      selectedClipIds: plan.restoredClipIds, selectedTransitionId: null, selectedMarkerId: null, selectedGap: null,
      history: history.slice(-MAX_HISTORY_SIZE), historyIndex: -1, historyLastChangedAt: Date.now() })
    return { ok: true, changed: true, summary: structuredClone(plan.summary), restoredClipIds: [...plan.restoredClipIds] }
  },

  previewCreateCompound: (request = {}) => {
    const state = get()
    if (state.compoundEditContext) return { ok: false, reason: 'Nested compounds are not supported. Return to the parent timeline first.' }
    if (state.isPlaying) return { ok: false, reason: 'Pause playback before creating a compound.' }
    const plan = buildCreateCompoundPlan({ ...request, clips: state.clips, tracks: state.tracks, transitions: state.transitions,
      markers: state.markers, fps: state.timelineFps, clipCounter: state.clipCounter })
    if (!plan.ok) return plan
    const token = {}
    compoundCreateTokens.set(token, { plan, requestKey: JSON.stringify(request),
      snapshot: pickFields(state, SMART_REPLACE_STATE_KEYS) })
    return { ok: true, changed: true, summary: structuredClone(plan.summary), token }
  },

  applyCreateCompound: (request = {}, token = null) => {
    const state = get()
    const record = token && compoundCreateTokens.get(token)
    if (!record || state.compoundEditContext || SMART_REPLACE_STATE_KEYS.some(key => state[key] !== record.snapshot[key])
      || JSON.stringify(request) !== record.requestKey) return { ok: false, reason: 'The timeline or selection changed. Review the compound again.' }
    let snapshot
    try { snapshot = createHistorySnapshot(state) } catch (_) { return { ok: false, reason: 'The selection cannot be checkpointed safely.' } }
    let history = state.historyIndex >= 0 ? state.history.slice(0, state.historyIndex + 1) : [...state.history]
    if (!history.length || !areHistorySnapshotsEqual(history[history.length - 1], snapshot)) history.push(snapshot)
    compoundCreateTokens.delete(token)
    set({ clips: record.plan.clips, clipCounter: record.plan.clipCounter, selectedClipIds: [record.plan.compoundClip.id],
      selectedTransitionId: null, selectedMarkerId: null, selectedGap: null,
      history: history.slice(-MAX_HISTORY_SIZE), historyIndex: -1, historyLastChangedAt: Date.now() })
    return { ok: true, changed: true, summary: structuredClone(record.plan.summary), clipId: record.plan.compoundClip.id }
  },

  openCompound: (clipId, expectedClip = null) => {
    const state = get()
    const matches = state.clips.filter(clip => clip.id === clipId)
    const clip = matches[0]
    if (state.compoundEditContext || matches.length !== 1 || !isCompoundClip(clip) || clip.compound?.version !== 1
      || expectedClip && expectedClip !== clip) return { ok: false, reason: 'Select one current top-level compound to open.' }
    const track = state.tracks.find(item => item.id === clip.trackId)
    if (isCompoundLocked(clip) || isCompoundLocked(track) || isCompoundCacheBusy(clip)) return { ok: false, reason: 'Unlock the compound and wait for render jobs before opening it.' }
    const valid = validateCompoundDocument(clip.compound.document)
    if (!valid.ok) return valid
    const child = structuredClone(clip.compound.document)
    const originalChildDocument = { ...child, zoom: child.zoom ?? 100, masterAudioVolume: child.masterAudioVolume ?? 100,
      masterAudioInserts: child.masterAudioInserts || [], markers: child.markers || [], transitions: child.transitions || [],
      clipCounter: child.clipCounter || getNextClipCounter(child.clips), transitionCounter: child.transitionCounter || 1,
      markerCounter: child.markerCounter || 1, snappingEnabled: child.snappingEnabled ?? true,
      snappingThreshold: child.snappingThreshold ?? 10, rippleEditMode: child.rippleEditMode ?? false }
    const context = { compoundClipId: clip.id, compoundName: clip.name, sessionKey: state.timelineSessionId + 1,
      parentDocument: rawActiveDocument(state), parentUi: pickFields(state, COMPOUND_UI_KEYS), originalChildDocument }
    set({ ...pickFields(originalChildDocument, DOCUMENT_KEYS), ...compoundNavigationReset, timelineFps: child.fps,
      viewportNavigation: null,
      compoundEditContext: context, timelineSessionId: state.timelineSessionId + 1, compoundNavigationRevision: state.compoundNavigationRevision + 1,
      compoundNavigationChangedDocument: false, playheadPosition: Math.max(0, Math.min(child.duration,
        state.playheadPosition - clip.startTime + clip.trimStart)), selectedClipIds: [], selectedTransitionId: null,
      selectedMarkerId: null, selectedGap: null, activeTrackId: child.tracks[0]?.id || null, inPoint: null, outPoint: null,
      history: [], historyIndex: -1, historyLastChangedAt: 0 })
    return { ok: true, changed: false }
  },

  closeCompound: () => {
    const state = get()
    const context = state.compoundEditContext
    if (!context) return { ok: true, changed: false }
    if (state.clips.some(isCompoundCacheBusy)) return { ok: false, reason: 'Wait for child clip render jobs to finish before returning to the parent timeline.' }
    let root
    try { root = getRootDocument(state) } catch (error) { return { ok: false, reason: error.message } }
    const changed = compoundProjectionCache.get(context)?.changed === true
    let history = context.parentUi.history
    if (changed) {
      let snapshot
      try { snapshot = createHistorySnapshot(context.parentDocument) } catch (_) { return { ok: false, reason: 'The parent timeline cannot be checkpointed safely.' } }
      history = context.parentUi.historyIndex >= 0 ? history.slice(0, context.parentUi.historyIndex + 1) : [...history]
      if (!history.length || !areHistorySnapshotsEqual(history[history.length - 1], snapshot)) history.push(snapshot)
      history = history.slice(-MAX_HISTORY_SIZE)
    }
    set({ ...root, ...context.parentUi, ...compoundNavigationReset, compoundEditContext: null,
      history, historyIndex: changed ? -1 : context.parentUi.historyIndex,
      historyLastChangedAt: changed ? Date.now() : context.parentUi.historyLastChangedAt,
      timelineSessionId: state.timelineSessionId + 1, compoundNavigationRevision: state.compoundNavigationRevision + 1,
      compoundNavigationChangedDocument: changed })
    return { ok: true, changed }
  },

  renameCompound: (clipId, name, expectedClip = null) => {
    const state = get()
    const clip = state.clips.find(item => item.id === clipId)
    if (!isCompoundClip(clip) || expectedClip && expectedClip !== clip || isCompoundLocked(clip)
      || isCompoundLocked(state.tracks.find(track => track.id === clip.trackId))) return { ok: false, reason: 'Select an unlocked current compound to rename.' }
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 160) return { ok: false, reason: 'Enter a name between 1 and 160 characters.' }
    if (name.trim() === clip.name) return { ok: true, changed: false }
    get().saveToHistory()
    set({ clips: state.clips.map(item => item === clip ? { ...clip, name: name.trim() } : item) })
    return { ok: true, changed: true }
  },

  // MCP editing uses the same pure editorial planners as the UI. Explicit
  // targets never change UI selection, and only this store owns the atomic
  // document/history commit. Opaque one-use tokens cannot carry caller patches.
  previewMcpEditing: (request = {}) => {
    const state = get()
    const plan = planMcpEditing(state, request, { getDefinition: getEffectTypeDefinition,
      makeId: () => `effect-${globalThis.crypto.randomUUID()}`, applyClipTrimUpdate,
      buildTransitionSettings: state.buildTransitionSettings,
      getMaxEdgeTransitionDuration: state.getMaxEdgeTransitionDuration,
      getMaxTransitionDurationForAlignment: state.getMaxTransitionDurationForAlignment,
      getTransitionContributions })
    if (!plan.ok) return plan
    const token = {}
    mcpEditingTokens.set(token, { plan, requestKey: JSON.stringify(request), snapshot: pickFields(state, RIPPLE_TRIM_STATE_KEYS) })
    return { ok: true, changed: plan.changed, summary: structuredClone(plan.summary), token }
  },

  applyMcpEditing: (request = {}, token = null) => {
    const state = get(), record = token && mcpEditingTokens.get(token)
    if (!record || RIPPLE_TRIM_STATE_KEYS.some(key => state[key] !== record.snapshot[key]) || JSON.stringify(request) !== record.requestKey) {
      return { ok: false, changed: false, reason: 'The timeline changed. Preview this edit again.' }
    }
    mcpEditingTokens.delete(token)
    const { plan } = record
    if (!plan.changed) return { ok: true, changed: false, summary: structuredClone(plan.summary) }
    let snapshot
    try { snapshot = createHistorySnapshot(state) } catch (_) { return { ok: false, changed: false, reason: 'This edit cannot be checkpointed safely.' } }
    let history = state.historyIndex >= 0 ? state.history.slice(0, state.historyIndex + 1) : [...state.history]
    if (!history.length || !areHistorySnapshotsEqual(history[history.length - 1], snapshot)) history.push(snapshot)
    set({ ...plan.patch, history: history.slice(-MAX_HISTORY_SIZE), historyIndex: -1, historyLastChangedAt: Date.now() })
    return { ok: true, changed: true, summary: structuredClone(plan.summary) }
  },

  previewSmartReplace: (request = {}) => {
    const state = get()
    if (state.isPlaying) return { ok: false, changed: false, reason: 'Pause playback before replacing a clip source.' }
    try {
      const plan = buildSmartReplacePlan({ ...request, clips: state.clips, tracks: state.tracks,
        transitions: state.transitions, timelineFps: state.timelineFps })
      if (!plan.ok) return plan
      const { updates, ...publicPreview } = plan
      const token = {}
      smartReplaceTokens.set(token, {
        updates, publicPreview: structuredClone(publicPreview), requestKey: smartReplaceRequestKey(request),
        snapshot: Object.fromEntries(SMART_REPLACE_STATE_KEYS.map(key => [key, state[key]])),
      })
      return { ...publicPreview, token }
    } catch (_) {
      return { ok: false, changed: false, reason: 'This clip or source contains unsupported data. No changes were made.' }
    }
  },

  applySmartReplace: (request = {}, token = null) => {
    const state = get()
    const record = token && smartReplaceTokens.get(token)
    const stale = () => ({ ok: false, changed: false, reason: 'The selected clip, replacement source, or timeline changed. Review Smart Replace again.' })
    if (!record || SMART_REPLACE_STATE_KEYS.some(key => state[key] !== record.snapshot[key])) return stale()
    try {
      if (smartReplaceRequestKey(request) !== record.requestKey) return stale()
    } catch (_) { return stale() }
    const { updates, publicPreview } = record
    if (!publicPreview.changed) {
      smartReplaceTokens.delete(token)
      return structuredClone(publicPreview)
    }
    let snapshot
    try { snapshot = createHistorySnapshot(state) } catch (_) {
      return { ok: false, changed: false, reason: 'This timeline cannot be checkpointed safely. No changes were made.' }
    }
    // Keep a single atomic document/history write: linked companions, clip
    // identity, selection, timing, and every authored editing field survive.
    let history = state.historyIndex >= 0 ? state.history.slice(0, state.historyIndex + 1) : [...state.history]
    if (!history.length || !areHistorySnapshotsEqual(history[history.length - 1], snapshot)) history.push(snapshot)
    if (history.length > MAX_HISTORY_SIZE) history = history.slice(-MAX_HISTORY_SIZE)
    smartReplaceTokens.delete(token)
    set({
      clips: state.clips.map(clip => clip.id === request.clipId ? { ...clip, ...updates } : clip),
      history, historyIndex: -1, historyLastChangedAt: Date.now(),
    })
    return structuredClone(publicPreview)
  },

  previewSourceEdit: (request = {}) => {
    const state = get()
    try {
      const preview = buildSourceEditPlan(state, request)
      if (!preview.ok) return preview
      const { plan, ...publicPreview } = preview
      const token = {}
      sourceEditTokens.set(token, {
        requestKey: sourceEditRequestKey(request), plan, publicPreview: structuredClone(publicPreview),
        snapshot: Object.fromEntries(SOURCE_EDIT_STATE_KEYS.map(key => [key, state[key]])),
      })
      return { ...publicPreview, token }
    } catch (_) {
      return { ok: false, reason: 'This source or timeline contains unsupported data. No changes were made.', targetTrackNames: [], affectedTrackNames: [] }
    }
  },

  applySourceEdit: (request = {}, token = null) => {
    const state = get()
    const record = token && sourceEditTokens.get(token)
    const stale = () => ({ ok: false, reason: 'The source or timeline changed. Review the destinations and try again.' })
    if (!record || SOURCE_EDIT_STATE_KEYS.some(key => state[key] !== record.snapshot[key])) return stale()
    try {
      if (sourceEditRequestKey(request) !== record.requestKey) return stale()
    } catch (_) { return stale() }
    // Consume once and commit picture, sound, existing edits and their history
    // together. No sequential addClip calls or partially placed A/V pair.
    const { plan, publicPreview } = record
    let snapshot
    try { snapshot = createHistorySnapshot(state) } catch (_) {
      return { ok: false, reason: 'This timeline cannot be checkpointed safely. No changes were made.' }
    }
    sourceEditTokens.delete(token)
    let history = state.historyIndex >= 0 ? state.history.slice(0, state.historyIndex + 1) : [...state.history]
    if (!history.length || !areHistorySnapshotsEqual(history[history.length - 1], snapshot)) history.push(snapshot)
    if (history.length > MAX_HISTORY_SIZE) history = history.slice(-MAX_HISTORY_SIZE)
    set({
      clips: plan.clips, transitions: plan.transitions, markers: plan.markers,
      clipCounter: plan.clipCounter, selectedClipIds: [...publicPreview.clipIds],
      selectedTransitionId: null, selectedMarkerId: null, selectedGap: null,
      duration: Math.max(state.duration, ...plan.clips.map(clip => clip.startTime + clip.duration + 10)),
      history, historyIndex: -1, historyLastChangedAt: Date.now(),
    })
    return publicPreview
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
            ...(clip.volumeEnvelope != null ? { volumeEnvelope: shiftAudioVolumeEnvelope(clip, trimAmount) } : {}),
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
            ...(clip.volumeEnvelope != null ? { volumeEnvelope: shiftAudioVolumeEnvelope(clip, secondPartStart - clip.startTime) } : {}),
            trimStart: secondPartTrimStart,
            trimEnd: getClipTrimEnd(clip),
            opticalFlowCache: undefined,
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
   * @param {object} [options] - Optional overrides for split/second-half, including duration, trim, and retime state
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
    const optionSourceFps = Number(options?.sourceFps)
    const optionTimelineFps = Number(options?.timelineFps)
    const optionSourceTimeScale = Number(options?.sourceTimeScale)
    const optionSpeed = Number(options?.speed)
    const assetDefaultTransform = (
      asset?.settings?.defaultTransform
      && typeof asset.settings.defaultTransform === 'object'
    ) ? asset.settings.defaultTransform : null
    const optionTransform = (
      options?.transform
      && typeof options.transform === 'object'
    ) ? options.transform : null
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
      sourceFps: Number.isFinite(optionSourceFps) && optionSourceFps > 0
        ? optionSourceFps
        : (Number.isFinite(sourceFps) && sourceFps > 0 ? sourceFps : null),
      timelineFps: Number.isFinite(optionTimelineFps) && optionTimelineFps > 0
        ? optionTimelineFps
        : (Number.isFinite(normalizedTimelineFps) && normalizedTimelineFps > 0 ? normalizedTimelineFps : null),
      sourceTimeScale: Number.isFinite(optionSourceTimeScale) && optionSourceTimeScale > 0
        ? optionSourceTimeScale
        : 1,
      speed: Number.isFinite(optionSpeed) && optionSpeed > 0 ? optionSpeed : 1,
      reverse: options?.reverse === true,
      frameSampling: isVideo
        ? normalizeFrameSamplingMode(options?.frameSampling)
        : undefined,
      gainDb: asset.type === 'audio' ? normalizeAudioClipGainDb(options?.gainDb) : undefined,
      fadeIn: asset.type === 'audio' ? clampAudioFadeDuration(options?.fadeIn, finalDuration) : undefined,
      fadeOut: asset.type === 'audio' ? clampAudioFadeDuration(options?.fadeOut, finalDuration) : undefined,
      ...(asset.type === 'audio' && options?.volumeEnvelope != null ? { volumeEnvelope: normalizeAudioVolumeEnvelope(options.volumeEnvelope) } : {}),
      ...(asset.type === 'audio' && options?.audioEq != null ? { audioEq: normalizeAudioEq(options.audioEq) } : {}),
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
        ...(optionTransform || {}),
        blendMode: optionTransform?.blendMode ?? assetDefaultTransform?.blendMode ?? 'normal',
      },
      // Carry an effects stack through split/duplicate — otherwise the new
      // half/copy silently loses its GLSL effects.
      ...(Array.isArray(options?.effects) && options.effects.length > 0
        ? { effects: structuredClone(options.effects) }
        : {}),
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
      ...(Array.isArray(textOptions?.effects) && textOptions.effects.length > 0
        ? { effects: structuredClone(textOptions.effects) }
        : {}),
      // Metadata for preset-based text title animation
      titleAnimation: null,
      // 2D Transform properties (same as video clips)
      transform: {
        positionX: 0,
        positionY: 0,
        positionZ: 0,
        scaleX: 100,
        scaleY: 100,
        scaleLinked: true,
        rotation: 0,
        rotationX: 0,
        rotationY: 0,
        perspective: 1200,
        anchorX: 50,
        anchorY: 50,
        opacity: 100,
        flipH: false,
        flipV: false,
        cropTop: 0,
        cropBottom: 0,
        cropLeft: 0,
        cropRight: 0,
        motionBlurEnabled: false,
        motionBlurMode: 'auto',
        motionBlurSamples: 8,
        motionBlurShutter: 180,
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
   * Add a native shape clip to the timeline.
   * @param {string} trackId - Target video track ID
   * @param {object} shapeOptions - Shape configuration options
   * @param {number|null} startTime - Start time (null = end of existing clips)
   */
  addShapeClip: (trackId, shapeOptions = {}, startTime = null) => {
    const state = get()
    const track = state.tracks.find(t => t.id === trackId)
    if (!track || track.type !== 'video') return null
    const safeClipCounter = getNextClipCounter(state.clips, state.clipCounter || 1)

    if (shapeOptions?.saveHistory !== false) {
      get().saveToHistory()
    }

    const fps = state.timelineFps || 24
    const trackClips = state.clips.filter(c => c.trackId === trackId)
    const rawStartTime = startTime ?? trackClips.reduce((max, clip) =>
      Math.max(max, clip.startTime + clip.duration), 0
    )
    const calculatedStartTime = roundToFrame(rawStartTime, fps)
    const duration = roundDurationToFrame(shapeOptions.duration || 5, fps)
    const shapeProperties = normalizeShapeProperties(shapeOptions.shapeProperties || shapeOptions)
    const shapeName = shapeOptions.name || getShapeDisplayName(shapeProperties)

    const newClip = {
      id: `clip-${safeClipCounter}`,
      trackId,
      assetId: null,
      name: shapeName,
      startTime: calculatedStartTime,
      duration,
      sourceDuration: duration,
      trimStart: 0,
      trimEnd: duration,
      color: '#2f6f88',
      type: 'shape',
      enabled: shapeOptions?.enabled !== false,
      compositeLowerLayers: CLIP_COMPOSITE_MODE.AUTO,
      url: null,
      thumbnail: null,
      shapeProperties,
      transform: {
        ...createDefaultClipTransform(),
        ...(shapeOptions.transform || {}),
        blendMode: shapeOptions.transform?.blendMode ?? 'normal',
      },
      ...(Array.isArray(shapeOptions?.effects) && shapeOptions.effects.length > 0
        ? { effects: structuredClone(shapeOptions.effects) }
        : {}),
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
      ...(Array.isArray(options?.effects) && options.effects.length > 0
        ? { effects: structuredClone(options.effects) }
        : {}),
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
   * Update shape clip properties.
   * @param {string} clipId - The shape clip to update
   * @param {object} shapeUpdates - Partial shape properties object
   * @param {boolean} saveHistory - Whether to save to history
   */
  updateShapeProperties: (clipId, shapeUpdates, saveHistory = false) => {
    if (saveHistory) {
      get().saveToHistory()
    }

    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId || clip.type !== 'shape') return clip

        const currentShape = normalizeShapeProperties(clip.shapeProperties || {})
        const hasWidthUpdate = Object.prototype.hasOwnProperty.call(shapeUpdates || {}, 'width')
        const hasHeightUpdate = Object.prototype.hasOwnProperty.call(shapeUpdates || {}, 'height')
        const shouldLinkSize = Object.prototype.hasOwnProperty.call(shapeUpdates || {}, 'sizeLinked')
          ? shapeUpdates.sizeLinked !== false
          : currentShape.sizeLinked !== false
        const nextShapeInput = { ...currentShape, ...shapeUpdates, sizeLinked: shouldLinkSize }
        const switchedFromLineToSolid = currentShape.shapeType === 'line' && shapeUpdates?.shapeType && shapeUpdates.shapeType !== 'line'
        if (shapeUpdates?.shapeType === 'line' && !hasHeightUpdate) {
          nextShapeInput.sizeLinked = false
          nextShapeInput.height = DEFAULT_LINE_THICKNESS
        } else if (switchedFromLineToSolid) {
          nextShapeInput.sizeLinked = DEFAULT_SHAPE_PROPERTIES.sizeLinked
          if (!hasWidthUpdate && !hasHeightUpdate) {
            nextShapeInput.width = DEFAULT_SHAPE_PROPERTIES.width
            nextShapeInput.height = DEFAULT_SHAPE_PROPERTIES.height
          } else if (hasWidthUpdate && !hasHeightUpdate) {
            nextShapeInput.height = nextShapeInput.sizeLinked
              ? Math.max(1, Number(shapeUpdates.width) || DEFAULT_SHAPE_PROPERTIES.height)
              : DEFAULT_SHAPE_PROPERTIES.height
          } else if (!hasWidthUpdate && hasHeightUpdate) {
            nextShapeInput.width = nextShapeInput.sizeLinked
              ? Math.max(1, Number(shapeUpdates.height) || DEFAULT_SHAPE_PROPERTIES.width)
              : DEFAULT_SHAPE_PROPERTIES.width
          }
        }
        if (!switchedFromLineToSolid && nextShapeInput.sizeLinked && hasWidthUpdate && !hasHeightUpdate) {
          const currentWidth = Math.max(1, Number(currentShape.width) || 1)
          const currentHeight = Math.max(1, Number(currentShape.height) || 1)
          nextShapeInput.height = Math.max(1, Math.round((Number(shapeUpdates.width) || currentWidth) * (currentHeight / currentWidth)))
        } else if (!switchedFromLineToSolid && nextShapeInput.sizeLinked && hasHeightUpdate && !hasWidthUpdate) {
          const currentWidth = Math.max(1, Number(currentShape.width) || 1)
          const currentHeight = Math.max(1, Number(currentShape.height) || 1)
          nextShapeInput.width = Math.max(1, Math.round((Number(shapeUpdates.height) || currentHeight) * (currentWidth / currentHeight)))
        }
        const updatedShape = normalizeShapeProperties(nextShapeInput)
        const newName = shapeUpdates?.name || clip.name || getShapeDisplayName(updatedShape)

        return {
          ...clip,
          name: newName,
          shapeProperties: updatedShape,
        }
      })
    }))
  },

  /**
   * Remove a clip (or multiple clips if they're selected)
   */
  removeClip: (clipId, saveHistory = true) => {
    // Save to history before modifying (batch callers that own their own
    // checkpoint pass false to keep the whole edit a single undo step)
    if (saveHistory) {
      get().saveToHistory()
    }

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

  /**
   * Unlock sync-locked clips so they behave like normal timeline clips again.
   * @param {Array<string>|string} clipIds - Clip id(s) to unlock. Defaults to current selection.
   */
  unlockSyncLockedClips: (clipIds = null) => {
    const state = get()
    const targetIds = dedupeClipIds(
      Array.isArray(clipIds)
        ? clipIds
        : (typeof clipIds === 'string' ? [clipIds] : state.selectedClipIds)
    )
    if (targetIds.length === 0) return false

    const hasSyncLockedClip = targetIds.some((clipId) => isSyncLockedClip(state.clips.find((clip) => clip.id === clipId)))
    if (!hasSyncLockedClip) return false

    get().saveToHistory()

    set((nextState) => ({
      clips: nextState.clips.map((clip) => {
        if (!targetIds.includes(clip.id)) return clip
        if (!isSyncLockedClip(clip)) return clip

        const { lockMode, syncLock, ...rest } = clip
        return {
          ...rest,
          syncLock: {
            mode: 'manual',
            source: syncLock?.source || 'manual',
            reason: syncLock?.reason || 'manual-unlock',
          },
        }
      }),
    }))

    return true
  },

  /**
   * Lock sync-capable clips to their anchored song timing.
   * @param {Array<string>|string} clipIds - Clip id(s) to lock. Defaults to current selection.
   */
  lockSyncClips: (clipIds = null, syncLockByClipId = null) => {
    const state = get()
    const targetIds = dedupeClipIds(
      Array.isArray(clipIds)
        ? clipIds
        : (typeof clipIds === 'string' ? [clipIds] : state.selectedClipIds)
    )
    if (targetIds.length === 0) return false

    const fps = state.timelineFps || FRAME_RATE

    const nextClips = state.clips.map((clip) => {
      if (!targetIds.includes(clip.id)) return clip

      const inferredSyncLock = clip.syncLock && clip.syncLock.mode === 'sync'
        ? clip.syncLock
        : (syncLockByClipId && syncLockByClipId[clip.id]) || null
      if (!inferredSyncLock) return clip
      return applySyncLockToClip({
        ...clip,
        lockMode: 'sync',
        syncLock: inferredSyncLock,
      }, fps)
    })

    const changed = nextClips.some((clip, index) => clip !== state.clips[index])
    if (!changed) return false

    get().saveToHistory()
    set({ clips: nextClips })
    return true
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

  previewSelectedGapDelete: () => {
    const state = get()
    const { clips, transitions, ...preview } = planCloseTimelineGap({ clips: state.clips, tracks: state.tracks,
      transitions: state.transitions, gap: state.selectedGap, fps: state.timelineFps })
    return { ...preview, changed: false }
  },

  rippleDeleteSelectedGap: () => {
    const state = get()
    // Re-plan from current state; a preview must never authorize stale edits.
    const plan = planCloseTimelineGap({ clips: state.clips, tracks: state.tracks,
      transitions: state.transitions, gap: state.selectedGap, fps: state.timelineFps })
    if (!plan.ok) return false
    let snapshot
    try { snapshot = createHistorySnapshot(state) } catch (_) { return false }
    let history = state.historyIndex >= 0 ? state.history.slice(0, state.historyIndex + 1) : [...state.history]
    if (!history.length || !areHistorySnapshotsEqual(history[history.length - 1], snapshot)) history.push(snapshot)
    // Publish the checkpoint and every track together so subscribers never see
    // an intermediate edit with picture and independently recorded audio apart.
    set({ clips: plan.clips, transitions: plan.transitions, selectedClipIds: [], selectedTransitionId: null,
      selectedMarkerId: null, selectedGap: null, history: history.slice(-MAX_HISTORY_SIZE),
      historyIndex: -1, historyLastChangedAt: Date.now() })
    return true
  },

  /**
   * Copy selected clips for normal paste and independent attribute snapshots.
   */
  copySelectedClips: () => {
    const state = get()
    if (state.selectedClipIds.length === 0) return
    const selectedIds = expandClipIdsWithLinked(state.clips, state.selectedClipIds)
    const selected = state.clips.filter(c => selectedIds.includes(c.id))
    if (selected.length === 0) return
    const minStart = Math.min(...selected.map(c => c.startTime))
    const withRelative = selected.map(c => ({ ...c, relativeStart: c.startTime - minStart,
      ...(c.volumeEnvelope != null ? { volumeEnvelope: structuredClone(c.volumeEnvelope) } : {}),
      ...(c.audioEq != null ? { audioEq: structuredClone(c.audioEq) } : {}),
    }))
    let attributeClipboard = null
    try {
      const keys = ['id', 'name', 'type', 'duration', 'transform', 'adjustments', 'effects', 'keyframes', 'bypass', 'gainDb', 'fadeIn', 'fadeOut']
      const snapshots = selected.map(clip => structuredClone(Object.fromEntries(
        keys.filter(key => Object.prototype.hasOwnProperty.call(clip, key)).map(key => [key, clip[key]])
      )))
      attributeClipboard = { id: globalThis.crypto.randomUUID(), clips: snapshots }
    } catch (error) {
      // A non-cloneable legacy value must not break ordinary Copy or leave an
      // older attribute source silently active.
      console.warn('[timelineStore] Could not capture clip attributes:', error)
    }
    set({ copiedClips: withRelative, attributeClipboard })
  },

  getPasteAttributesPreview: (request = {}) => {
    const state = get()
    const clipboard = state.attributeClipboard
    const source = clipboard?.clips.find(clip => clip.id === request.sourceId)
    if (!source || clipboard.id !== request.clipboardId) {
      return { ok: false, error: 'Copy a source clip again before pasting attributes.', groups: [] }
    }
    return getPasteAttributesAvailability(state, { source, clipIds: request.clipIds }, { getDefinition: getEffectTypeDefinition })
  },

  applyPasteAttributes: (request = {}) => {
    const state = get()
    const clipboard = state.attributeClipboard
    const source = clipboard?.clips.find(clip => clip.id === request.sourceId)
    const fail = error => ({ ok: false, error, changedCount: 0 })
    if (!source || clipboard.id !== request.clipboardId) return fail('The copied source changed. Reopen Paste Attributes.')
    if (request.expectedClips !== state.clips || request.expectedTracks !== state.tracks) {
      return fail('The timeline changed. Reopen Paste Attributes to review the destinations.')
    }
    const plan = planPasteAttributes(state, { source, clipIds: request.clipIds, groups: request.groups }, {
      getDefinition: getEffectTypeDefinition,
      makeId: () => `effect-${globalThis.crypto.randomUUID()}`,
    })
    if (!plan.ok || !plan.changedCount) return plan
    if (state.compoundEditContext) {
      const valid = validateCompoundDocument({ ...getLiveChildDocument(state), clips: plan.clips })
      if (!valid.ok) return fail(valid.reason)
    }
    get().saveToHistory()
    set({ clips: plan.clips })
    return { ok: true, changedCount: plan.changedCount, targetCount: plan.targetCount }
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
    const captionsTrack = isCaptionsTrack(track)
    const matchesTrack = (t) =>
      // The captions track accepts only caption clips; nothing else can paste in.
      (captionsTrack ? isCaptionClip(t) : (
        (isVideoTrack && (t.type === 'video' || t.type === 'image' || t.type === 'text' || t.type === 'adjustment')) ||
        (isAudioTrack && t.type === 'audio')
      ))

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
      } else if (template.type === 'shape') {
        const rawDuration = template.duration ?? 5
        const duration = roundDurationToFrame(rawDuration, fps)
        const shapeProperties = normalizeShapeProperties(template.shapeProperties || {})
        const newClip = {
          id: `clip-${clipCounter}`,
          trackId,
          assetId: null,
          name: template.name || getShapeDisplayName(shapeProperties),
          startTime: clipStartTime,
          duration,
          sourceDuration: duration,
          trimStart: 0,
          trimEnd: duration,
          color: '#2f6f88',
          type: 'shape',
          enabled: template.enabled !== false,
          compositeLowerLayers: normalizeClipCompositeMode(template.compositeLowerLayers),
          url: null,
          thumbnail: null,
          shapeProperties,
          transform: {
            ...createDefaultClipTransform(),
            ...(template.transform || {}),
            blendMode: template.transform?.blendMode ?? 'normal',
          },
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
          frameSampling: template.type === 'video'
            ? normalizeFrameSamplingMode(template.frameSampling)
            : undefined,
          gainDb: template.type === 'audio' ? normalizeAudioClipGainDb(template.gainDb) : undefined,
          fadeIn: template.type === 'audio' ? clampAudioFadeDuration(template.fadeIn, duration) : undefined,
          fadeOut: template.type === 'audio' ? clampAudioFadeDuration(template.fadeOut, duration) : undefined,
          ...(template.type === 'audio' && template.volumeEnvelope != null ? { volumeEnvelope: normalizeAudioVolumeEnvelope(template.volumeEnvelope) } : {}),
          ...(template.type === 'audio' && template.audioEq != null ? { audioEq: normalizeAudioEq(template.audioEq) } : {}),
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

    // The captions track only holds caption clips — block moving anything else
    // onto it (caption clips can still move freely on/off it).
    if (newTrackId !== clip.trackId) {
      const destTrack = state.tracks.find(t => t.id === newTrackId)
      if (isCaptionsTrack(destTrack) && !isCaptionClip(clip)) return
    }

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
                    ...(existingClip.volumeEnvelope != null ? { volumeEnvelope: shiftAudioVolumeEnvelope(existingClip, trimAmount) } : {}),
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
                    opticalFlowCache: undefined,
                    startTime: secondPartStart,
                    duration: secondPartDuration,
                    ...(existingClip.volumeEnvelope != null ? { volumeEnvelope: shiftAudioVolumeEnvelope(existingClip, secondPartStart - existingClip.startTime) } : {}),
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
                  return { ...c, startTime: t.originalClipBStart, duration: c.duration - durationDiff, trimStart: t.originalClipBTrimStart,
                    ...(c.volumeEnvelope != null ? { volumeEnvelope: shiftAudioVolumeEnvelope(c, -durationDiff) } : {}),
                  }
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
    set((state) => {
      const updatedClips = state.clips.map((clip) => {
        if (!targetIds.has(clip.id)) return clip
        const nextPosition = map.get(clip.id)
        if (!nextPosition) return clip
        return applySyncLockToClip({
          ...clip,
          startTime: nextPosition.startTime,
          trackId: nextPosition.trackId ?? clip.trackId,
        }, fps)
      })
      return {
        clips: updatedClips,
        transitions: translateTransitionsForClipMoves({
          transitions: state.transitions,
          beforeClips: state.clips,
          afterClips: updatedClips,
        }),
      }
    })
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
      const movedTransitions = translateTransitionsForClipMoves({
        transitions: state.transitions,
        beforeClips: state.clips,
        afterClips: updatedClips,
      })
      
      // Only resolve overlaps if explicitly requested (on drag end)
      if (!resolveOverlaps) {
        return { clips: updatedClips, transitions: movedTransitions }
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
                ...(existingClip.volumeEnvelope != null ? { volumeEnvelope: shiftAudioVolumeEnvelope(existingClip, trimAmount) } : {}),
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
                opticalFlowCache: undefined,
                startTime: secondPartStart,
                duration: secondPartDuration,
                ...(existingClip.volumeEnvelope != null ? { volumeEnvelope: shiftAudioVolumeEnvelope(existingClip, secondPartStart - existingClip.startTime) } : {}),
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
      let finalTransitions = movedTransitions
      if (movedTransitions.length > 0) {
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
        const broken = movedTransitions.filter(t => isBroken(t, finalClips))
        if (broken.length > 0) {
          const brokenIds = new Set(broken.map(t => t.id))
          for (const t of broken) {
            finalClips = finalClips.map(c => {
              if (c.id === t.clipAId && t.originalClipAEnd != null && t.originalClipATrimEnd != null) {
                return { ...c, duration: t.originalClipAEnd - c.startTime, trimEnd: t.originalClipATrimEnd }
              }
              if (c.id === t.clipBId && t.originalClipBStart != null && t.originalClipBTrimStart != null) {
                const durationDiff = c.startTime - t.originalClipBStart
                return { ...c, startTime: t.originalClipBStart, duration: c.duration - durationDiff, trimStart: t.originalClipBTrimStart,
                  ...(c.volumeEnvelope != null ? { volumeEnvelope: shiftAudioVolumeEnvelope(c, -durationDiff) } : {}),
                }
              }
              return c
            })
          }
          finalTransitions = movedTransitions.filter(t => !brokenIds.has(t.id))
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
   * Spawn in-place copies of dragged clips for an Alt-drag duplicate gesture
   * (Flame/Resolve style: the copies hold the gesture-start spot while the
   * dragged originals keep following the pointer). Copies get fresh ids,
   * re-linked link groups among themselves, cold render caches, and clones of
   * transitions that live fully inside the duplicated set. Sync-locked clips
   * are skipped: they snap back to their anchor instead of moving, so a copy
   * would stack directly on its original.
   * History-neutral: the drag gesture saves the undo checkpoint, so one undo
   * removes the copies and returns the originals in a single step.
   * @param {Array<string>} clipIds - Ids of the clips being dragged
   * @param {Array<{id: string, startTime: number, trackId: string}>} originalPositions - Gesture-start position per clip
   * @returns {{clipIds: Array<string>, transitionIds: Array<string>}|null} Created ids (for a mid-gesture cancel), or null
   */
  duplicateClipsForDrag: (clipIds = [], originalPositions = []) => {
    const state = get()
    const sourceIds = new Set(dedupeClipIds(clipIds))
    const positionById = new Map((originalPositions || []).map((entry) => [entry.id, entry]))
    const sources = state.clips.filter((clip) => sourceIds.has(clip.id) && !isSyncLockedClip(clip))
    if (sources.length === 0) return null

    let clipCounter = getNextClipCounter(state.clips, state.clipCounter || 1)
    const duplicateLinkGroups = new Map()
    const getDuplicateLinkGroupId = (sourceLinkGroupId) => {
      const normalized = getNormalizedLinkGroupId(sourceLinkGroupId)
      if (!normalized) return undefined
      if (!duplicateLinkGroups.has(normalized)) {
        duplicateLinkGroups.set(normalized, buildLinkGroupId(`dup-${clipCounter + duplicateLinkGroups.size}`))
      }
      return duplicateLinkGroups.get(normalized)
    }

    const idMap = new Map()
    const duplicates = sources.map((clip) => {
      const gestureStart = positionById.get(clip.id)
      const duplicate = {
        ...structuredClone(clip),
        id: `clip-${clipCounter}`,
        startTime: Number.isFinite(gestureStart?.startTime) ? gestureStart.startTime : clip.startTime,
        trackId: gestureStart?.trackId || clip.trackId,
        selected: false,
        cacheStatus: 'none',
        cacheProgress: 0,
        cacheUrl: null,
        cachePath: null,
        opticalFlowCache: undefined,
        linkGroupId: getDuplicateLinkGroupId(clip.linkGroupId),
        lockMode: undefined,
        syncLock: undefined,
      }
      idMap.set(clip.id, duplicate.id)
      clipCounter += 1
      return duplicate
    })
    const duplicatesById = new Map(duplicates.map((clip) => [clip.id, clip]))

    // Transition records carry absolute clip-position bookkeeping; rebuild
    // those fields from the copies so the clone is self-consistent at the
    // gesture-start location instead of inheriting possibly-stale values.
    let transitionCounter = state.transitionCounter || 1
    const duplicatedTransitions = []
    for (const transition of state.transitions) {
      let cloned = null
      if (transition.kind === 'between' && idMap.has(transition.clipAId) && idMap.has(transition.clipBId)) {
        const copyA = duplicatesById.get(idMap.get(transition.clipAId))
        const copyB = duplicatesById.get(idMap.get(transition.clipBId))
        cloned = {
          ...structuredClone(transition),
          id: `transition-${transitionCounter}`,
          clipAId: copyA.id,
          clipBId: copyB.id,
          editPoint: copyA.startTime + copyA.duration,
          originalClipAEnd: copyA.startTime + copyA.duration,
          originalClipADuration: copyA.duration,
          originalClipATrimEnd: copyA.trimEnd,
          originalClipBStart: copyB.startTime,
          originalClipBDuration: copyB.duration,
          originalClipBTrimStart: copyB.trimStart,
        }
      } else if (transition.kind === 'edge' && idMap.has(transition.clipId)) {
        cloned = {
          ...structuredClone(transition),
          id: `transition-${transitionCounter}`,
          clipId: idMap.get(transition.clipId),
        }
      }
      if (cloned) {
        transitionCounter += 1
        duplicatedTransitions.push(cloned)
      }
    }

    set((current) => ({
      clips: [...current.clips, ...duplicates],
      clipCounter: Math.max(current.clipCounter || 1, clipCounter),
      ...(duplicatedTransitions.length > 0
        ? {
          transitions: [...current.transitions, ...duplicatedTransitions],
          transitionCounter: Math.max(current.transitionCounter || 1, transitionCounter),
        }
        : {}),
    }))

    return {
      clipIds: duplicates.map((clip) => clip.id),
      transitionIds: duplicatedTransitions.map((transition) => transition.id),
    }
  },

  /**
   * Remove copies spawned by duplicateClipsForDrag when Alt is released
   * mid-gesture. Removes exactly the given ids (no linked expansion) and is
   * history-neutral, matching the spawn side.
   * @param {{clipIds?: Array<string>, transitionIds?: Array<string>}} created - Ids returned by duplicateClipsForDrag
   */
  removeDragDuplicates: ({ clipIds = [], transitionIds = [] } = {}) => {
    const clipIdSet = new Set(clipIds)
    const transitionIdSet = new Set(transitionIds)
    if (clipIdSet.size === 0 && transitionIdSet.size === 0) return
    set((state) => ({
      clips: state.clips.filter((clip) => !clipIdSet.has(clip.id)),
      transitions: state.transitions.filter((transition) => !transitionIdSet.has(transition.id)),
      selectedClipIds: state.selectedClipIds.filter((id) => !clipIdSet.has(id)),
    }))
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
   * Choose how a video clip synthesizes frames while retimed.
   * Cache generation is intentionally separate: selecting Optical Flow is
   * an undoable creative setting, while native cache progress is transient.
   */
  updateClipFrameSampling: (clipId, mode, saveHistory = true) => {
    const normalizedMode = normalizeFrameSamplingMode(mode)
    const target = get().clips.find((clip) => clip.id === clipId)
    if (!target || target.type !== 'video') return false
    if (normalizeFrameSamplingMode(target.frameSampling) === normalizedMode) return false
    if (saveHistory) get().saveToHistory()
    set((state) => ({
      clips: state.clips.map((clip) => (
        clip.id === clipId ? { ...clip, frameSampling: normalizedMode } : clip
      )),
    }))
    return true
  },

  /** Native optical-flow cache state. This never creates an undo entry. */
  setOpticalFlowCache: (clipId, opticalFlowCache) => {
    set((state) => ({
      clips: state.clips.map((clip) => (
        clip.id === clipId
          ? { ...clip, opticalFlowCache: opticalFlowCache ? { ...opticalFlowCache } : null }
          : clip
      )),
    }))
  },

  updateOpticalFlowCache: (clipId, updates = {}) => {
    set((state) => ({
      clips: state.clips.map((clip) => {
        if (clip.id !== clipId) return clip
        return {
          ...clip,
          opticalFlowCache: {
            ...(clip.opticalFlowCache || {}),
            ...updates,
          },
        }
      }),
    }))
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
          ? applyClipTrimUpdate(clip, updates, state.timelineFps)
          : clip
      )
    }))
  },

  /**
   * Update multiple clips in one store write during a shared trim gesture.
   * @param {Array<{id: string, updates: object}>} trimUpdates
   */
  updateClipsTrim: (trimUpdates) => {
    const entries = Array.isArray(trimUpdates)
      ? trimUpdates.filter((entry) => entry?.id && entry?.updates && typeof entry.updates === 'object')
      : []
    if (entries.length === 0) return
    const updatesById = new Map(entries.map((entry) => [entry.id, entry.updates]))
    set((state) => ({
      clips: state.clips.map((clip) => {
        const updates = updatesById.get(clip.id)
        return updates ? applyClipTrimUpdate(clip, updates, state.timelineFps) : clip
      }),
    }))
  },

  /** Author one clip's manual volume envelope. UI drafts commit once per
   * gesture with the original clip identity, so stale/cancelled/no-op edits
   * cannot create history or land on a replacement clip. */
  updateAudioVolumeEnvelope: (clipId, envelope, saveHistory = true, expectedClip = null) => {
    const state = get()
    const fail = reason => ({ ok: false, changed: false, reason })
    const matches = state.clips.filter(clip => clip.id === clipId)
    const clip = matches[0]
    if (matches.length !== 1 || !clip) return fail('The audio clip changed. Select it again before editing volume.')
    if (expectedClip != null && expectedClip !== clip) return fail('The audio clip changed while editing. Try again.')
    const tracks = state.tracks.filter(track => track.id === clip.trackId)
    const track = tracks[0]
    if (tracks.length !== 1 || track?.type !== 'audio' || !isAudioClipRole(clip, track)) return fail('Select one audio clip on an audio track to edit its volume envelope.')
    if (track.locked || track.syncLocked || track.lockMode === 'sync' || track.syncLock?.mode === 'sync'
      || clip.locked || clip.syncLocked || clip.lockMode === 'sync' || clip.syncLock?.mode === 'sync') {
      return fail('Unlock the audio clip and its track before editing its volume envelope.')
    }
    const validated = validateAudioVolumeEnvelope(envelope)
    if (!validated.ok) return fail(validated.reason)
    const current = normalizeAudioVolumeEnvelope(clip.volumeEnvelope)
    if (JSON.stringify(current) === JSON.stringify(validated.envelope)) return { ok: true, changed: false }
    if (saveHistory) get().saveToHistory()
    set({ clips: state.clips.map(candidate => candidate === clip ? { ...clip, volumeEnvelope: validated.envelope } : candidate) })
    return { ok: true, changed: true }
  },

  /** Fixed-band per-clip audio EQ. Bypass retains the authored values; this is
   * separate from gain/fades, volume envelopes, and static Paste Attributes. */
  updateAudioEq: (clipId, eq, saveHistory = true, expectedClip = null) => {
    const state = get()
    const fail = reason => ({ ok: false, changed: false, reason })
    const matches = state.clips.filter(clip => clip.id === clipId)
    const clip = matches[0]
    if (matches.length !== 1 || !clip) return fail('The audio clip changed. Select it again before editing EQ.')
    if (expectedClip != null && expectedClip !== clip) return fail('The audio clip changed while editing EQ. Try again.')
    const tracks = state.tracks.filter(track => track.id === clip.trackId)
    const track = tracks[0]
    if (tracks.length !== 1 || track?.type !== 'audio' || !isAudioClipRole(clip, track)) return fail('Select one audio clip on an audio track to edit its EQ.')
    if (track.locked || track.syncLocked || track.lockMode === 'sync' || track.syncLock?.mode === 'sync'
      || clip.locked || clip.syncLocked || clip.lockMode === 'sync' || clip.syncLock?.mode === 'sync') {
      return fail('Unlock the audio clip and its track before editing EQ.')
    }
    const validated = validateAudioEq(eq)
    if (!validated.ok) return fail(validated.reason)
    if (JSON.stringify(normalizeAudioEq(clip.audioEq)) === JSON.stringify(validated.eq)) return { ok: true, changed: false }
    if (saveHistory) get().saveToHistory()
    set({ clips: state.clips.map(candidate => candidate === clip ? { ...clip, audioEq: validated.eq } : candidate) })
    return { ok: true, changed: true }
  },

  /**
   * Apply one validated multi-selection property change as a single undo step.
   */
  applyMultiClipInspectorEdit: (request = {}, saveHistory = true) => {
    const state = get()
    // A draft from a previous selection must never land on the new one.
    const requestedIds = new Set(request.clipIds || [])
    const currentIds = new Set(state.selectedClipIds)
    if (requestedIds.size < 2 || requestedIds.size !== currentIds.size
      || [...requestedIds].some(id => !currentIds.has(id))) {
      return { ok: false, error: 'Selection changed. Review the selected clips and try again.', changedCount: 0 }
    }
    const plan = request.updates
      ? planMultiClipInspectorUpdates(state, request)
      : planMultiClipInspectorEdit(state, request)
    if (!plan.ok || plan.changedCount === 0) return plan
    if (state.compoundEditContext) {
      const valid = validateCompoundDocument({ ...getLiveChildDocument(state), clips: plan.clips })
      if (!valid.ok) return { ok: false, error: valid.reason, changedCount: 0 }
    }
    if (saveHistory) get().saveToHistory()
    set({ clips: plan.clips })
    return { ok: true, changedCount: plan.changedCount, targetCount: plan.targetCount }
  },

  /**
   * Update clip transform properties (position, scale, rotation, flip, crop, opacity).
   * @param {string} clipId - The clip to update
   * @param {object} transformUpdates - Partial transform object with properties to update
   * @param {boolean} saveHistory - Whether to save history (false for realtime sliders)
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
          positionX: 0, positionY: 0, positionZ: 0,
          scaleX: 100, scaleY: 100, scaleLinked: true,
          rotation: 0, rotationX: 0, rotationY: 0, perspective: 1200, anchorX: 50, anchorY: 50, opacity: 100,
          flipH: false, flipV: false,
          cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0,
          motionBlurEnabled: false, motionBlurMode: 'auto', motionBlurSamples: 8, motionBlurShutter: 180,
          blendMode: 'normal',
          blur: 0,
        }
        
        // Handle linked scale: if scaleLinked and one scale changed, update both
        let finalUpdates = { ...transformUpdates }
        const shouldKeepScaleLinked = Object.prototype.hasOwnProperty.call(transformUpdates, 'scaleLinked')
          ? transformUpdates.scaleLinked
          : currentTransform.scaleLinked
        if (shouldKeepScaleLinked) {
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
   * Set a clip's track matte mode ('none' | 'alpha' | 'alpha-inverted' |
   * 'luma' | 'luma-inverted'). The visual layer directly above becomes the
   * matte source and is hidden from normal output.
   */
  updateClipTrackMatte: (clipId, trackMatte, saveHistory = true) => {
    const normalized = normalizeTrackMatte(trackMatte)
    const currentClip = get().clips.find((clip) => clip.id === clipId)
    if (!currentClip) return
    if (normalizeTrackMatte(currentClip.trackMatte) === normalized) return

    if (saveHistory) {
      get().saveToHistory()
    }

    set((state) => ({
      clips: state.clips.map((clip) => (
        clip.id === clipId ? { ...clip, trackMatte: normalized } : clip
      ))
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
   * Set or clear a clip's parametric shape mask (rect/ellipse/rounded with
   * feather + invert). Pass partial updates to merge, or null to remove.
   * Video and image clips only — the types the mask compositing paths draw.
   */
  updateClipShapeMask: (clipId, maskUpdates, saveHistory = false) => {
    if (saveHistory) {
      get().saveToHistory()
    }

    set((state) => ({
      clips: state.clips.map((clip) => {
        if (clip.id !== clipId || (clip.type !== 'video' && clip.type !== 'image')) return clip
        if (maskUpdates === null) {
          if (!clip.shapeMask) return clip
          const { shapeMask, ...rest } = clip
          return rest
        }
        return {
          ...clip,
          shapeMask: { ...(clip.shapeMask || {}), ...(maskUpdates || {}) },
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
                positionX: 0, positionY: 0, positionZ: 0,
                scaleX: 100, scaleY: 100, scaleLinked: true,
                rotation: 0, rotationX: 0, rotationY: 0, perspective: 1200, anchorX: 50, anchorY: 50, opacity: 100,
                flipH: false, flipV: false,
                cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0,
                motionBlurEnabled: false, motionBlurMode: 'auto', motionBlurSamples: 8, motionBlurShutter: 180,
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
        const tolerance = keyframeToleranceForFps(state.timelineFps)
        const existingIndex = propKeyframes.findIndex(kf => Math.abs(kf.time - safeTime) < tolerance)
        
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
        const tolerance = keyframeToleranceForFps(state.timelineFps)
        const newPropKeyframes = propKeyframes.filter(kf => Math.abs(kf.time - safeTime) > tolerance)
        
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

    const tolerance = keyframeToleranceForFps(state.timelineFps)
    const sourceExists = propKeyframes.some((keyframe) => Math.abs(keyframe.time - safeFromTime) < tolerance)
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

        const result = movePropertyKeyframeArray(targetKeyframes, safeFromTime, safeToTime, tolerance)
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

    const tolerance = keyframeToleranceForFps(state.timelineFps)
    const hasSource = propertyIds.some((propertyId) => {
      const propKeyframes = keyframes[propertyId] || []
      return propKeyframes.some((keyframe) => Math.abs(keyframe.time - safeFromTime) < tolerance)
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

          const result = movePropertyKeyframeArray(propKeyframes, safeFromTime, safeToTime, tolerance)
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
   * Keyframe clipboard: entries are { propertyId, timeOffset, value, easing }
   * with timeOffset relative to the earliest copied keyframe, so a paste
   * anchors the group at the paste time.
   */
  keyframeClipboard: null,

  copyKeyframesToClipboard: (targets = []) => {
    const valid = targets.filter((target) => (
      target
      && typeof target.propertyId === 'string'
      && Number.isFinite(Number(target.time))
      && Number.isFinite(Number(target.value))
    ))
    if (valid.length === 0) return 0
    const minTime = Math.min(...valid.map((target) => Number(target.time)))
    set({
      keyframeClipboard: valid.map((target) => ({
        propertyId: target.propertyId,
        timeOffset: Number(target.time) - minTime,
        value: Number(target.value),
        easing: target.easing || 'easeInOut',
      })),
    })
    return valid.length
  },

  /**
   * Paste the keyframe clipboard into a clip, anchored at atTime
   * (clip-relative seconds). Returns the pasted entries' final times.
   */
  pasteKeyframesFromClipboard: (clipId, atTime) => {
    const clipboard = get().keyframeClipboard
    if (!Array.isArray(clipboard) || clipboard.length === 0) return []
    const clip = get().clips.find((candidate) => candidate.id === clipId)
    if (!clip) return []

    get().saveToHistory()
    const pasted = []
    for (const entry of clipboard) {
      const time = clampKeyframeTime(Number(atTime) + entry.timeOffset, clip.duration)
      get().setKeyframe(clipId, entry.propertyId, time, entry.value, entry.easing, { saveHistory: false })
      pasted.push({ propertyId: entry.propertyId, time })
    }
    return pasted
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
    const existingKeyframe = keyframes.find(kf => Math.abs(kf.time - clipTime) < keyframeToleranceForFps(state.timelineFps))
    
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
      const shapeProperties = clip.type === 'shape' ? normalizeShapeProperties(clip.shapeProperties || {}) : null
      const hasShapeValue = shapeProperties && Object.prototype.hasOwnProperty.call(shapeProperties, property)
      const maskPropertyKey = property.startsWith('shapeMask.') ? property.slice('shapeMask.'.length) : null
      const maskForKeyframe = maskPropertyKey ? (normalizeShapeMask(clip.shapeMask) || DEFAULT_SHAPE_MASK) : null
      // Shape keyframes snapshot the whole points array; without a spline
      // there is nothing to key.
      if (maskPropertyKey === 'points' && !Array.isArray(maskForKeyframe?.points)) return
      const currentValue = property === 'speed'
        ? (Number(clip.speed) > 0 ? Number(clip.speed) : 1)
        : maskForKeyframe
          ? (maskPropertyKey === 'points'
            ? maskForKeyframe.points.map((p) => ({ x: p.x, y: p.y, hIn: { ...p.hIn }, hOut: { ...p.hOut } }))
            : (Number(maskForKeyframe[maskPropertyKey]) || 0))
          : hasAdjustmentValue
            ? adjustmentValue
            : hasShapeValue
              ? shapeProperties[property]
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
          Math.abs(kf.time - time) < keyframeToleranceForFps(state.timelineFps) ? { ...kf, easing } : kf
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
    return keyframes.find(kf => Math.abs(kf.time - time) < keyframeToleranceForFps(state.timelineFps)) || null
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
    const tolerance = keyframeToleranceForFps(state.timelineFps)
    let nextTime = Infinity

    if (property === 'all') {
      // Find next keyframe across all properties
      for (const propKeyframes of Object.values(clip.keyframes || {})) {
        for (const kf of propKeyframes) {
          if (kf.time > clipTime + tolerance && kf.time < nextTime) {
            nextTime = kf.time
          }
        }
      }
    } else {
      // Find next keyframe for specific property
      const keyframes = clip.keyframes?.[property] || []
      for (const kf of keyframes) {
        if (kf.time > clipTime + tolerance && kf.time < nextTime) {
          nextTime = kf.time
        }
      }
    }
    
    if (nextTime !== Infinity) {
      set({
        playheadPosition: roundToFrame(clip.startTime + nextTime, state.timelineFps || FRAME_RATE),
        playheadSeekIntent: null,
      })
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
    const tolerance = keyframeToleranceForFps(state.timelineFps)
    let prevTime = -Infinity

    if (property === 'all') {
      // Find previous keyframe across all properties
      for (const propKeyframes of Object.values(clip.keyframes || {})) {
        for (const kf of propKeyframes) {
          if (kf.time < clipTime - tolerance && kf.time > prevTime) {
            prevTime = kf.time
          }
        }
      }
    } else {
      // Find previous keyframe for specific property
      const keyframes = clip.keyframes?.[property] || []
      for (const kf of keyframes) {
        if (kf.time < clipTime - tolerance && kf.time > prevTime) {
          prevTime = kf.time
        }
      }
    }
    
    if (prevTime !== -Infinity) {
      set({
        playheadPosition: roundToFrame(clip.startTime + prevTime, state.timelineFps || FRAME_RATE),
        playheadSeekIntent: null,
      })
    }
  },

  // ==================== END KEYFRAME MANAGEMENT ====================

  // ==================== EFFECTS MANAGEMENT ====================

  // Multi-clip effects share the normal history/dirty paths, but validate and
  // publish the entire edit at once rather than looping single-clip actions.
  applyMultiClipEffectsEdit: (request = {}, saveHistory = true) => {
    const state = get()
    const requested = new Set(request.clipIds || [])
    const current = new Set(state.selectedClipIds)
    if (requested.size < 2 || requested.size !== current.size || [...requested].some(id => !current.has(id))) {
      return { ok: false, error: 'Selection changed. Review the selected clips and try again.', changedCount: 0 }
    }
    const plan = planMultiClipEffectsEdit(state, request, {
      getDefinition: getEffectTypeDefinition,
      makeId: () => `effect-${globalThis.crypto.randomUUID()}`,
    })
    if (!plan.ok || !plan.changedCount) return plan
    if (saveHistory) get().saveToHistory()
    set({ clips: plan.clips })
    return { ok: true, changedCount: plan.changedCount }
  },

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
  setCacheUrl: (clipId, cacheUrl, cachePath = null, cacheKind = null, cacheSignature = null) => {
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        return {
          ...clip,
          cacheUrl,
          cachePath, // Path to the file on disk (for persistence)
          // 'full' bakes carry transform/effects/speed/text inside the file
          // and are validated by content signature; legacy (null) bakes keep
          // the old mask-only contract.
          cacheKind: cacheUrl ? cacheKind : null,
          cacheSignature: cacheUrl ? cacheSignature : null,
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
          cachePath: null,
          cacheKind: null,
          cacheSignature: null,
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
    const normalized = ['canvas', 'dom', 'gpu'].includes(mode) ? mode : 'gpu'
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
          duration: clip.duration - trimDeltaTimeline,
          ...(clip.volumeEnvelope != null ? { volumeEnvelope: shiftAudioVolumeEnvelope(clip, trimDeltaTimeline) } : {}),
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
    
    const split = normalizeTransitionSplit(state.transitions.find(t => t.id === transitionId)?.settings?.split, alignment)
    const effectiveA = Math.max(0, Number(clipA.duration) || 0)
    const effectiveB = Math.max(0, Number(clipB.duration) || 0)

    const maxFromA = split.clipA > 0 ? effectiveA / split.clipA : Infinity
    const maxFromB = split.clipB > 0 ? effectiveB / split.clipB : Infinity
    return Math.max(0, Math.min(maxFromA, maxFromB))
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
    if (!merged.split) merged.split = { clipA: 0.5, clipB: 0.5 }
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
    
    // Validate that clips are on the same track and touch or overlap.
    if (clipA.trackId !== clipB.trackId) {
      console.warn('Cannot add transition between clips on different tracks')
      return null
    }

    const initialSettings = get().buildTransitionSettings(transitionType)
    const alignment = initialSettings.alignment || 'center'

    // Cut-anchored transitions consume time from each clip without moving them.
    const maxDuration = get().getMaxTransitionDurationForAlignment(clipAId, clipBId, alignment)
    if (maxDuration < MIN_TRANSITION_DURATION) {
      console.warn('Insufficient clip duration for transition. Need more footage on one or both clips.')
      return null
    }

    // Clamp duration to available handles
    const actualDuration = Math.max(MIN_TRANSITION_DURATION, Math.min(duration, maxDuration))
    const contribution = getTransitionContributions(actualDuration, initialSettings)

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
      split: initialSettings.split || null,
      contributions: contribution,
      // Store original positions for compatibility / rendering
      editPoint: editPoint,
      originalClipAEnd: clipA.startTime + clipA.duration,
      originalClipADuration: clipA.duration,
      originalClipATrimEnd: clipA.trimEnd,
      originalClipBStart: clipB.startTime,
      originalClipBDuration: clipB.duration,
      originalClipBTrimStart: clipB.trimStart,
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

    // Between transitions are metadata-only now, so removing them just drops the record.
    if (transition.kind === 'edge' || transition.kind === 'between') {
      set((state) => ({
        transitions: state.transitions.filter(t => t.id !== transitionId),
        selectedTransitionId: state.selectedTransitionId === transitionId ? null : state.selectedTransitionId
      }))
      return
    }
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

    // Between transition: just update stored metadata and split ratios.
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

    // Save to history
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
    const anyVideoSolo = hasVideoSolo(state.tracks)
    // Get video tracks in reverse order (top track = highest priority)
    const videoTracks = state.tracks.filter(t => isVideoTrackVisible(t, anyVideoSolo))
    
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
  getActiveClipsAtTime: (time, renderState = null) => {
    const state = renderState || get()
    const anyVideoSolo = hasVideoSolo(state.tracks)
    const activeClips = []
    const addedClipIds = new Set()

    const pushActiveClip = (clip, track) => {
      if (!clip || addedClipIds.has(clip.id)) return
      addedClipIds.add(clip.id)
      activeClips.push({ clip, track })
    }

    const removeActiveClip = (clipId) => {
      if (!clipId || !addedClipIds.has(clipId)) return
      const index = activeClips.findIndex(({ clip }) => clip?.id === clipId)
      if (index >= 0) activeClips.splice(index, 1)
      addedClipIds.delete(clipId)
    }

    const addTransitionClipsAtTime = (transition, progress = 0) => {
      if (!isBetweenClipTransition(transition)) return
      const clipA = state.clips.find(c => c.id === transition.clipAId)
      const clipB = state.clips.find(c => c.id === transition.clipBId)
      if (!clipA || !clipB) return
      const track = state.tracks.find(t => t.id === clipA.trackId)
      if (!track || (track.type === 'video'
        ? !isVideoTrackVisible(track, anyVideoSolo)
        : !track.visible || track.muted)) return
      if (clipA.trackId !== clipB.trackId) return
      if (!isClipEnabled(clipA) || !isClipEnabled(clipB)) return
      removeActiveClip(clipA.id)
      removeActiveClip(clipB.id)
      pushActiveClip(clipA, track)
      pushActiveClip(clipB, track)
    }

    for (const track of state.tracks) {
      if (track.type === 'video') {
        if (!isVideoTrackVisible(track, anyVideoSolo)) continue
      } else if (!track.visible || track.muted) continue

      const trackClips = state.clips.filter(c =>
        c.trackId === track.id &&
        isClipEnabled(c) &&
        time >= getClipPlaybackWindow(c).start &&
        time < getClipPlaybackWindow(c).end
      )
      trackClips
        .sort((a, b) => a.startTime - b.startTime)
        .forEach(clip => pushActiveClip(clip, track))
    }

    for (const transition of state.transitions) {
      if (!isBetweenClipTransition(transition)) continue
      const clipA = state.clips.find(c => c.id === transition.clipAId)
      const clipB = state.clips.find(c => c.id === transition.clipBId)
      if (!clipA || !clipB) continue
      if (clipA.trackId !== clipB.trackId) continue
      const track = state.tracks.find(t => t.id === clipA.trackId)
      if (!track || (track.type === 'video'
        ? !isVideoTrackVisible(track, anyVideoSolo)
        : !track.visible || track.muted)) continue
      const split = normalizeTransitionSplit(transition?.settings?.split, transition?.settings?.alignment || 'center')
      const editPoint = Number.isFinite(Number(transition.editPoint))
        ? Number(transition.editPoint)
        : (clipA.startTime + clipA.duration)
      const duration = Math.max(0, Number(transition.duration) || 0)
      const transitionStart = editPoint - (duration * split.clipA)
      const transitionEnd = editPoint + (duration * split.clipB)
      if (time >= transitionStart && time < transitionEnd) {
        addTransitionClipsAtTime(transition)
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
  getTransitionAtTime: (time, renderState = null) => {
    const state = renderState || get()
    const anyVideoSolo = hasVideoSolo(state.tracks)
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
        if (!isVideoTrackVisible(clipTrack, anyVideoSolo)) continue

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
      if (!isVideoTrackVisible(clipTrack, anyVideoSolo)) continue
      if (clipA.trackId !== clipB.trackId) continue
      const duration = Number(transition.duration)
      if (!Number.isFinite(duration) || duration <= 0) continue

      const split = normalizeTransitionSplit(transition?.settings?.split, transition?.settings?.alignment || 'center')
      const editPoint = Number.isFinite(Number(transition.editPoint))
        ? Number(transition.editPoint)
        : (clipA.startTime + clipA.duration)
      const transitionStart = editPoint - (duration * split.clipA)
      const transitionEnd = editPoint + (duration * split.clipB)

      if (safeTime >= transitionStart && safeTime < transitionEnd) {
        const progress = (safeTime - transitionStart) / Math.max(1e-6, transitionEnd - transitionStart)
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
   * User navigation during playback freezes the target until its picture lands.
   * Continuous transport writers must identify themselves; loop wraps additionally
   * set discontinuity so they receive the same handoff as a user jump.
   */
  setPlayheadPosition: (position, options = {}) => {
    const initial = get()
    const isTransport = options?.source === 'transport'
    const cancelPatch = !isTransport ? stopPlayAroundPatch(initial) : {}
    const state = !isTransport && initial.playAround ? { ...initial, ...cancelPatch } : initial
    const currentJump = getCurrentPlaybackJump(state)
    if (isTransport && (!state.isPlaying || currentJump)) return false
    const fps = state.timelineFps || FRAME_RATE
    const parsedPosition = Number(position)
    const safePosition = Number.isFinite(parsedPosition) ? parsedPosition : 0
    const clampedPosition = Math.max(0, safePosition)
    const shouldSnap = options?.snap === true || options?.snapToFrame === true
    const nextPosition = shouldSnap ? roundToFrame(clampedPosition, fps) : clampedPosition
    const nextRevision = (Number(state.playheadSeekRevision) || 0) + 1
    const isNavigation = !isTransport || options?.discontinuity === true
    const needsJump = state.isPlaying && isNavigation
    const reuseJump = needsJump && currentJump && Math.abs(currentJump.targetTime - nextPosition) < 1e-9
    const jumpRevision = (Number(state.playbackJumpRevision) || 0) + (needsJump && !reuseJump ? 1 : 0)
    set({
      ...cancelPatch,
      playheadPosition: nextPosition,
      playheadSeekRevision: nextRevision,
      playheadSeekIntent: options?.intent === 'frame-step'
        ? { type: 'frame-step', targetTime: nextPosition, revision: nextRevision }
        : null,
      playbackJump: needsJump
        ? (reuseJump ? currentJump : createPlaybackJump(state, nextPosition, jumpRevision, Date.now()))
        : null,
      playbackJumpRevision: jumpRevision,
      ...(isNavigation ? { playbackJumpError: null } : {}),
    })
    return true
  },

  // Only a committed target composite may release a matching live request.
  completePlaybackJump: (token) => {
    const request = getCurrentPlaybackJump(get())
    if (!request || request.token !== token) return false
    set({ playbackJump: null, playbackJumpError: null })
    return true
  },

  failPlaybackJump: (token, reason = 'The requested playback frame could not be loaded.') => {
    const state = get()
    const request = getCurrentPlaybackJump(state)
    if (!request || request.token !== token) return false
    const audition = getCurrentPlayAround(state)
    set({ playbackJump: null, playbackJumpError: String(reason || 'The requested playback frame could not be loaded.'),
      isPlaying: false, playbackRate: audition?.previousRate ?? 1,
      shuttleMode: audition?.previousShuttleMode ?? false, playAround: null })
    return true
  },

  startPlayAround: (centerTime = null, auditionClip = null) => {
    const state = get()
    const revision = (Number(state.playAroundRevision) || 0) + 1
    const session = createPlayAround(state, centerTime, revision)
    if (!session) return false
    // Used only by the music-ducking dialog. Reuse the same bounded playback
    // clock and context ownership without altering ordinary Play Around.
    if (auditionClip) {
      if (state.clips.filter(clip => clip === auditionClip).length !== 1 || auditionClip.type !== 'audio'
        || !Number.isFinite(auditionClip.startTime) || !Number.isFinite(auditionClip.duration)
        || auditionClip.startTime < 0 || auditionClip.duration < 1 / state.timelineFps) return false
      session.startTime = auditionClip.startTime
      session.endTime = auditionClip.startTime + auditionClip.duration
    }
    const jumpRevision = (Number(state.playbackJumpRevision) || 0) + 1
    set({ playAround: session, playAroundRevision: revision, isPlaying: true, playbackRate: 1, shuttleMode: false,
      playheadPosition: session.startTime, playheadSeekIntent: null,
      playheadSeekRevision: (Number(state.playheadSeekRevision) || 0) + 1,
      playbackJump: createPlaybackJump({ ...state, playbackRate: 1 }, session.startTime, jumpRevision, Date.now()),
      playbackJumpRevision: jumpRevision, playbackJumpError: null })
    return session.token
  },

  finishPlayAround: (token) => {
    const state = get(), session = getCurrentPlayAround(state)
    if (!session || session.token !== token) return false
    const revision = (Number(state.playheadSeekRevision) || 0) + 1
    set({ ...stopPlayAroundPatch(state), playheadPosition: session.returnTime,
      playheadSeekRevision: revision,
      playheadSeekIntent: { type: 'frame-step', targetTime: session.returnTime, revision }, playbackJumpError: null })
    return true
  },

  cancelPlayAround: (token = null) => {
    const state = get()
    if (!state.playAround || (token !== null && state.playAround.token !== token)) return false
    set(stopPlayAroundPatch(state))
    return true
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
    if (get().playAround) { get().cancelPlayAround(); return }
    set((state) => {
      const nextIsPlaying = !state.isPlaying
      const timelineEnd = state.getTimelineEndTime()
      const atOrPastEnd = timelineEnd > 0 && state.playheadPosition >= (timelineEnd - 0.001)
      const retry = nextIsPlaying && Boolean(state.playbackJumpError)
      const nextPosition = retry ? state.playheadPosition : roundToFrame(
        (!state.isPlaying && nextIsPlaying && state.loopMode === 'normal' && atOrPastEnd) ? 0 : state.playheadPosition,
        state.timelineFps || FRAME_RATE
      )
      const nextRate = state.isPlaying ? state.playbackRate : 1
      const jumpRevision = (Number(state.playbackJumpRevision) || 0) + (retry ? 1 : 0)

      return {
        isPlaying: nextIsPlaying,
        playheadSeekIntent: null,
        playbackJump: retry ? createPlaybackJump({ ...state, playbackRate: nextRate }, nextPosition, jumpRevision, Date.now()) : null,
        playbackJumpRevision: jumpRevision,
        playbackJumpError: null,
        // Restart from beginning when pressing play at the timeline end in normal mode.
        // A failed landing retries that exact target instead.
        playheadPosition: nextPosition,
        playbackRate: nextRate, // Reset to 1x when starting
        shuttleMode: false
      }
    })
  },

  /**
   * Set playback rate (for JKL shuttle)
   */
  setPlaybackRate: (rate) => {
    set((state) => ({ ...playbackRateUpdate(state, rate), playAround: null }))
  },

  /**
   * JKL Shuttle: J key - play reverse (multiple presses increase speed)
   */
  shuttleReverse: () => {
    set((state) => ({ isPlaying: true, ...playbackRateUpdate(state, nextShuttleRate(state, 'reverse'), { starting: true }), shuttleMode: true, playAround: null }))
  },

  /**
   * JKL Shuttle: K key - pause
   */
  shuttlePause: () => {
    if (get().playAround) { get().cancelPlayAround(); return }
    set({ isPlaying: false, playbackRate: 1, shuttleMode: false, playbackJump: null })
  },

  /**
   * JKL Shuttle: L key - play forward (multiple presses increase speed)
   */
  shuttleForward: () => {
    set((state) => ({ isPlaying: true, ...playbackRateUpdate(state, nextShuttleRate(state, 'forward'), { starting: true }), shuttleMode: true, playAround: null }))
  },

  /**
   * JKL Shuttle: K+J or K+L - slow shuttle (hold K and tap J or L)
   */
  shuttleSlow: (direction, step = false) => {
    set((state) => {
      // K+J/L retains fixed half-speed; Shift+J/L steps down to 1/8x.
      const rate = step ? nextShuttleRate(state, direction, true) : direction === 'reverse' ? -0.5 : 0.5
      return { isPlaying: true, ...playbackRateUpdate(state, rate, { starting: true }), shuttleMode: true, playAround: null }
    })
  },

  /**
   * Set playback loop mode
   * @param {'normal' | 'loop' | 'loop-in-out' | 'loop-selection' | 'ping-pong'} mode
   */
  setLoopMode: (mode) => {
    set({ ...stopPlayAroundPatch(get()), loopMode: mode })
  },

  /**
   * Set zoom level (0.5% - 2000%). Absolute bounds only — the timeline
   * enforces its content-aware floor (getMinZoom) at the call sites.
   */
  setZoom: (zoom, options = {}) => {
    if (!Number.isFinite(zoom)) return
    const state = get()
    const value = Math.max(0.5, Math.min(2000, zoom))
    if (value === state.zoom) return
    if (options?.navigationOnly === true) {
      set({ zoom: value, viewportNavigationRevision: state.viewportNavigationRevision + 1,
        viewportNavigation: { zoom: value, documentZoom: getDocumentZoom(state), context: state.compoundEditContext } })
    } else {
      set({ zoom: value, viewportNavigation: null })
    }
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
   * Toggle track solo. Audio solo controls audibility; video solo controls
   * picture visibility. Multiple tracks of the same type can be soloed.
   */
  toggleTrackSolo: (trackId) => {
    set((state) => ({
      tracks: state.tracks.map(track =>
        track.id === trackId && (track.type === 'audio' || track.type === 'video')
          ? { ...track, solo: !track.solo }
          : track
      )
    }))
  },

  /**
   * Set track volume (0-200, 100 = unity). No history entry: fader drags
   * would flood undo, matching mute/solo toggles which also skip history.
   */
  setTrackVolume: (trackId, volume) => {
    const clamped = clampTrackVolume(volume)
    set((state) => ({
      tracks: state.tracks.map(track =>
        track.id === trackId ? { ...track, volume: clamped } : track
      )
    }))
  },

  /**
   * Set program master audio gain (0-200, 100 = unity). Applies to preview
   * and export mixdowns alike.
   */
  setMasterAudioVolume: (volume) => {
    set({ masterAudioVolume: clampTrackVolume(volume) })
  },

  /**
   * Set track pan (-100 = full left, 0 = center, 100 = full right). No
   * history entry, matching fader/mute/solo behavior.
   */
  setTrackPan: (trackId, pan) => {
    const clamped = clampTrackPan(pan)
    set((state) => ({
      tracks: state.tracks.map(track =>
        track.id === trackId && track.type === 'audio'
          ? { ...track, pan: clamped }
          : track
      )
    }))
  },

  /**
   * Replace an audio track's insert effects (normalized). No history entry,
   * matching fader/mute/solo behavior.
   */
  setTrackInserts: (trackId, inserts) => {
    const normalized = normalizeAudioInserts(inserts)
    set((state) => ({
      tracks: state.tracks.map(track =>
        track.id === trackId && track.type === 'audio'
          ? { ...track, inserts: normalized }
          : track
      )
    }))
  },

  /**
   * Replace the master bus insert effects (normalized).
   */
  setMasterAudioInserts: (inserts) => {
    set({ masterAudioInserts: normalizeAudioInserts(inserts) })
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
   * Set or clear the visible label color for one or more timeline clips.
   */
  setClipLabelColor: (clipIds, color) => {
    const state = get()
    const targetIds = dedupeClipIds(Array.isArray(clipIds) ? clipIds : [clipIds])
    if (targetIds.length === 0) return

    const targetSet = new Set(targetIds)
    const labelColor = normalizeClipLabelColor(color)
    const hasChanges = state.clips.some((clip) => (
      targetSet.has(clip.id) && normalizeClipLabelColor(clip.labelColor) !== labelColor
    ))
    if (!hasChanges) return

    get().saveToHistory()
    set((current) => ({
      clips: current.clips.map((clip) => {
        if (!targetSet.has(clip.id)) return clip
        if (!labelColor) {
          const nextClip = { ...clip }
          delete nextClip.labelColor
          return nextClip
        }
        return {
          ...clip,
          labelColor,
        }
      }),
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
    // Optional role marker (e.g. 'captions') — the track still behaves like a
    // normal track of its type; the role just lets callers find/reuse it and
    // restrict what clips may live on it.
    if (typeof options?.role === 'string' && options.role) {
      newTrack.role = options.role
    }
    if (type === 'audio') {
      newTrack.channels = options.channels === 'mono' ? 'mono' : 'stereo'
    }
    
    set((state) => {
      // For video tracks, add to the beginning (top) by default.
      // For audio tracks, add to the end (bottom)
      if (type === 'video') {
        const videoTracks = state.tracks.filter(t => t.type === 'video')
        const audioTracks = state.tracks.filter(t => t.type === 'audio')
        if (options?.position === 'bottom' || options?.placement === 'bottom') {
          return {
            tracks: [...videoTracks, newTrack, ...audioTracks]
          }
        }
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
    set((state) => ({
      timelineSessionId: (Number(state.timelineSessionId) || 0) + 1,
      duration: 60,
      attributeClipboard: null,
      viewportNavigation: null,
      zoom: 100,
      playheadPosition: 0,
      playheadSeekIntent: null,
      playheadSeekRevision: 0,
      playbackJump: null,
      playbackJumpError: null,
      playAround: null,
      isPlaying: false,
      playbackRate: 1,
      shuttleMode: false,
      loopMode: 'normal',
      masterAudioVolume: 100,
      masterAudioInserts: [],
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
    }))
  },

  /**
   * Load timeline data from a project
   * @param {object} timelineData - Timeline data from project file
   */
  loadFromProject: (timelineData, assets = [], timelineFps = null) => {
    if (!timelineData) return
    if (get().compoundEditContext) {
      const closed = get().closeCompound()
      if (!closed.ok) throw new Error(closed.reason)
    }
    const fps = Number(timelineFps) || 24
    const assetsById = buildAssetByIdMap(assets)
    const projectTracks = timelineData.tracks || [
      { id: 'video-1', name: 'Video 1', type: 'video', muted: false, locked: false, visible: true },
      { id: 'audio-1', name: 'Audio 1', type: 'audio', channels: 'stereo', muted: false, locked: false, visible: true },
    ]
    const normalizedClips = normalizeVideoBackedAudioClips(
      normalizeClipTimebases(timelineData.clips || [], assets, fps),
      projectTracks
    )
    // Align all clip start times and durations to frame boundaries (no sub-frame)
    const frameAlignedClips = normalizedClips.map((clip) => {
      if (isCompoundClip(clip)) {
        const hydrated = sanitizeCompoundChildren(clip, child => ({ ...child,
          ...(isInfinitelyExtendableClipType(child) ? { sourceDuration: Infinity } : {}), cacheUrl: null,
          opticalFlowCache: child.opticalFlowCache ? { ...child.opticalFlowCache, url: undefined,
            status: child.opticalFlowCache.path ? 'hydrating' : 'none', progress: 0, jobId: undefined, error: undefined } : undefined }))
        return clampFiniteMediaClipToSource(hydrated, fps)
      }
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
        frameSampling: clip.type === 'video'
          ? normalizeFrameSamplingMode(clip.frameSampling)
          : undefined,
        opticalFlowCache: clip.type === 'video' && clip.opticalFlowCache
          ? {
              ...clip.opticalFlowCache,
              url: undefined,
              status: clip.opticalFlowCache.path ? 'hydrating' : 'none',
              progress: 0,
              error: undefined,
              jobId: undefined,
            }
          : undefined,
        startTime,
        duration,
        trimEnd,
        sourceDuration,
        adjustments: normalizedAdjustments,
        ...(clip.type === 'audio'
          ? {
              gainDb: normalizeAudioClipGainDb(clip.gainDb),
              fadeIn: clampAudioFadeDuration(clip.fadeIn, duration),
              fadeOut: clampAudioFadeDuration(clip.fadeOut, duration),
              ...(clip.volumeEnvelope != null ? { volumeEnvelope: normalizeAudioVolumeEnvelope(clip.volumeEnvelope) } : {}),
              ...(clip.audioEq != null ? { audioEq: normalizeAudioEq(clip.audioEq) } : {}),
            }
          : {}),
        ...(supportsLowerLayerCompositeMode(clip)
          ? { compositeLowerLayers: normalizeClipCompositeMode(clip.compositeLowerLayers) }
          : {}),
      }, fps)
      return applyInferredSyncLockToClip(normalizedClip, assetsById, fps)
    })
    const restoredClipCounter = Number(timelineData.clipCounter) || 1
    const nextClipCounter = Math.max(restoredClipCounter, getNextClipCounter(frameAlignedClips, 1))

    set((state) => ({
      timelineSessionId: (Number(state.timelineSessionId) || 0) + 1,
      compoundEditContext: null,
      viewportNavigation: null,
      duration: timelineData.duration || 60,
      attributeClipboard: null,
      timelineFps: fps,
      zoom: timelineData.zoom || 100,
      masterAudioVolume: clampTrackVolume(timelineData.masterAudioVolume),
      masterAudioInserts: normalizeAudioInserts(timelineData.masterAudioInserts),
      tracks: projectTracks,
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
      playheadSeekIntent: null,
      playheadSeekRevision: 0,
      playbackJump: null,
      playbackJumpError: null,
      playAround: null,
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
    }))
  },

  /**
   * Get timeline data for saving to project
   */
  getProjectData: () => {
    return serializeRootDocument(get())
  },

  /**
   * Set timeline frame rate (used for frame-aligned clip positions). Call when project/timeline FPS changes.
   */
  setTimelineFps: (fps) => {
    const value = Number(fps)
    if (Number.isFinite(value) && value > 0) {
      set((state) => ({
        ...(value !== state.timelineFps ? stopPlayAroundPatch(state) : {}),
        timelineFps: value,
        playheadPosition: roundToFrame(state.playheadPosition, value),
        playheadSeekIntent: null,
        ...(value !== state.timelineFps ? { playbackJump: null, playbackJumpError: null } : {}),
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
   * Update the transient Render In→Out status shown on the timeline ruler.
   */
  setRangeRenderState: (rangeRenderState = null) => {
    set({ rangeRenderState })
  },

  /**
   * Go to In point
   */
  goToInPoint: () => {
    const state = get()
    if (state.inPoint !== null) {
      set({
        playheadPosition: roundToFrame(state.inPoint, state.timelineFps || FRAME_RATE),
        playheadSeekIntent: null,
      })
    }
  },

  /**
   * Go to Out point
   */
  goToOutPoint: () => {
    const state = get()
    if (state.outPoint !== null) {
      set({
        playheadPosition: roundToFrame(state.outPoint, state.timelineFps || FRAME_RATE),
        playheadSeekIntent: null,
      })
    }
  },

  /**
   * Add a timeline marker at a specific time (or current playhead).
   */
  /**
   * Add many markers in one history step (e.g. beat markers from audio
   * analysis). Entries: { time, label?, color? }. Returns the created markers.
   */
  addMarkersBatch: (entries = []) => {
    const state = get()
    const fps = state.timelineFps || FRAME_RATE
    const duration = Math.max(0, Number(state.duration) || 0)
    const startCounter = Math.max(1, Number(state.markerCounter) || 1)
    const markers = entries
      .filter((entry) => Number.isFinite(Number(entry?.time)))
      .map((entry, index) => ({
        id: `marker-${startCounter + index}`,
        time: roundToFrame(Math.max(0, Math.min(duration, Number(entry.time))), fps),
        label: String(entry.label || '').slice(0, 160),
        color: entry.color || '#f5c451',
      }))
    if (markers.length === 0) return []

    get().saveToHistory()
    set((s) => ({
      markers: [...s.markers, ...markers].sort((a, b) => a.time - b.time),
      markerCounter: startCounter + markers.length,
    }))
    return markers
  },

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
    }, get),
    {
      name: 'comfystudio-timeline', // localStorage key
      storage: createDebouncedJSONStorage(() => localStorage),
      partialize: (state) => ({
        // Only persist these fields (exclude transient UI state)
        ...serializeRootDocument(state),
        timelineFps: state.compoundEditContext?.parentUi.timelineFps ?? state.timelineFps,
        // Note: Transient UI state NOT persisted:
        // - activeSnapTime, selectedClipIds, playheadPosition, playheadSeekIntent
        // - isPlaying, playbackRate, shuttleMode, playbackJump, playbackJumpRevision, playbackJumpError, playAround, playAroundRevision
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
