// What the right-hand piece of a cut must inherit from the clip it was cut
// from. The razor rebuilds that piece through the ordinary "add clip" actions,
// which only know a handful of fields; everything else the editor authored on
// the clip (speed, keyframes, colour, mask, name, label…) is carried here so
// both pieces look and play exactly like the uncut clip did.

import { getColorAtTime, getSplinePointsAtTime, getValueAtTime } from './keyframes.js'
import { getRampedSourceOffset, hasSpeedRamp } from './timeRemap.js'

// Identity, placement and timing belong to the new piece. Render caches
// describe the uncut clip. Sync locks never split. Audio shaping is divided
// between the pieces by audioClipSplit.js. Keyframes and links are rebuilt.
const NOT_CARRIED = new Set([
  'id', 'trackId', 'startTime', 'duration', 'trimStart', 'trimEnd', 'sourceDuration',
  'type', 'assetId', 'url', 'thumbnail', 'selected', 'enabled',
  'cacheStatus', 'cacheProgress', 'cacheUrl', 'cachePath', 'opticalFlowCache',
  'lockMode', 'syncLock',
  'gainDb', 'fadeIn', 'fadeOut', 'volumeEnvelope', 'audioEq',
  'keyframes', 'linkGroupId',
])

const clone = (value) => (value === undefined ? undefined : structuredClone(value))

const valueAtCut = (propertyKeyframes, time) => {
  const sample = propertyKeyframes.find((keyframe) => keyframe?.value !== undefined)?.value
  if (typeof sample === 'number') return getValueAtTime(propertyKeyframes, time, sample)
  if (typeof sample === 'string') return getColorAtTime(propertyKeyframes, time, sample)
  if (Array.isArray(sample)) return getSplinePointsAtTime(propertyKeyframes, time, sample)
  // Unknown value kind: hold the last keyframe at or before the cut.
  const earlier = propertyKeyframes.filter((keyframe) => keyframe.time <= time)
  return (earlier[earlier.length - 1] || propertyKeyframes[0])?.value
}

/**
 * Keyframes for the right-hand piece. Times are clip-relative, so they move
 * back by the cut time. Keyframes left of the cut are replaced by one
 * keyframe on the new first frame holding the animated value at the cut, so
 * the animation carries on from exactly where the left piece stops.
 */
export function splitKeyframesForRightPiece(keyframes, splitTime, tolerance = 0.0005) {
  if (!keyframes || typeof keyframes !== 'object') return undefined
  const cut = Number(splitTime)
  if (!Number.isFinite(cut)) return clone(keyframes)

  const result = {}
  for (const [property, rawKeyframes] of Object.entries(keyframes)) {
    if (!Array.isArray(rawKeyframes) || rawKeyframes.length === 0) continue
    const sorted = rawKeyframes
      .filter((keyframe) => keyframe && Number.isFinite(Number(keyframe.time)))
      .sort((a, b) => a.time - b.time)
    if (sorted.length === 0) continue

    const later = sorted.filter((keyframe) => keyframe.time > cut + tolerance)
    const atOrBefore = sorted.filter((keyframe) => keyframe.time <= cut + tolerance)
    const next = []
    if (atOrBefore.length > 0) {
      const governing = atOrBefore[atOrBefore.length - 1]
      // A keyframe sitting on the cut is the new first keyframe as it stands.
      const onCut = Math.abs(governing.time - cut) <= tolerance
      next.push({ ...clone(governing), time: 0, value: onCut ? clone(governing.value) : clone(valueAtCut(sorted, cut)) })
    }
    for (const keyframe of later) next.push({ ...clone(keyframe), time: keyframe.time - cut })
    result[property] = next
  }
  return Object.keys(result).length > 0 ? result : undefined
}

const getBaseScale = (clip) => {
  const scale = Number(clip?.sourceTimeScale)
  if (Number.isFinite(scale) && scale > 0) return scale
  const timelineFps = Number(clip?.timelineFps)
  const sourceFps = Number(clip?.sourceFps)
  return timelineFps > 0 && sourceFps > 0 ? timelineFps / sourceFps : 1
}

const isPictureMedia = (clip) => clip?.type === 'video' || clip?.type === 'image'

/**
 * Source in/out points for both pieces where plain "trim start plus elapsed
 * time" is wrong: a reversed clip plays its source backwards, and a speed
 * ramp uses up source at a changing rate. Returns null for ordinary clips.
 */
export function getSplitSourceTrims(clip, splitTime, remainder) {
  if (!isPictureMedia(clip)) return null
  const cut = Number(splitTime)
  const rest = Number(remainder)
  const trimStart = Number(clip.trimStart) || 0
  const trimEnd = Number(clip.trimEnd ?? clip.sourceDuration)
  if (!Number.isFinite(cut) || !Number.isFinite(rest)) return null
  const baseScale = getBaseScale(clip)

  if (clip.reverse === true) {
    if (clip.type !== 'video' || !Number.isFinite(trimEnd)) return null
    const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1
    const lower = Math.min(trimStart, trimEnd)
    const upper = Math.max(trimStart, trimEnd)
    const boundary = Math.max(lower, Math.min(upper, upper - cut * baseScale * speed))
    return {
      left: { trimStart: boundary, trimEnd: upper },
      right: { trimStart: lower, trimEnd: boundary },
    }
  }

  if (hasSpeedRamp(clip)) {
    const sourceAtCut = trimStart + baseScale * getRampedSourceOffset(clip, cut)
    const sourceAtEnd = trimStart + baseScale * getRampedSourceOffset(clip, cut + rest)
    return {
      left: { trimEnd: sourceAtCut },
      right: { trimStart: sourceAtCut, trimEnd: Math.max(sourceAtCut, sourceAtEnd), duration: rest },
    }
  }

  return null
}

/**
 * Fields to lay over the freshly added right-hand piece.
 * `linkGroupId` is whatever link the caller decided the right piece belongs
 * to (undefined leaves it unlinked, so it never joins the left piece's link).
 */
export function buildSplitRightPieceCarryOver(clip, splitTime, { remainder, linkGroupId } = {}) {
  if (!clip || typeof clip !== 'object') return {}
  const carried = {}
  for (const [key, value] of Object.entries(clip)) {
    if (NOT_CARRIED.has(key) || value === undefined) continue
    carried[key] = clone(value)
  }
  const keyframes = splitKeyframesForRightPiece(clip.keyframes, splitTime)
  if (keyframes) carried.keyframes = keyframes
  if (linkGroupId) carried.linkGroupId = linkGroupId
  const trims = getSplitSourceTrims(clip, splitTime, remainder)
  if (trims?.right) Object.assign(carried, trims.right)
  return carried
}

/** Source-trim correction for the left-hand piece, or null when none is needed. */
export function buildSplitLeftPieceUpdates(clip, splitTime, remainder) {
  return getSplitSourceTrims(clip, splitTime, remainder)?.left || null
}
