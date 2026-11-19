import { getClipPlaybackTimingAtTimeline } from './clipPlaybackTiming.js'
import { hasSpeedRamp } from './timeRemap.js'

const finite = value => typeof value === 'number' && Number.isFinite(value)
const optionalNumber = (value, predicate) => value == null || (finite(value) && predicate(value))

function unavailableSource(status, reason) {
  return {
    status, reason, reference: 'original-media', mapping: null,
    trimInSeconds: null, trimOutSeconds: null,
    startBoundarySeconds: null, endBoundarySeconds: null,
    midpointSeconds: null, midpointClamped: null,
  }
}

/**
 * Read-only, deterministic timestamps for agents. Timeline end is exclusive;
 * source boundaries describe the mapping at those edges, not seek requests.
 * The midpoint is a seekable timestamp in ORIGINAL media, never cache-local
 * time and never half of sourceDuration. It does not promise a decoded frame,
 * available file, or the composed appearance of the timeline.
 */
export function getClipAgentTiming(clip, { asset = null } = {}) {
  const validTimeline = clip && finite(clip.startTime) && clip.startTime >= 0
    && finite(clip.duration) && clip.duration > 0
    && finite(clip.startTime + clip.duration)
    && clip.startTime + clip.duration > clip.startTime
  const timeline = validTimeline ? {
    status: 'available', startSeconds: clip.startTime, durationSeconds: clip.duration,
    endSeconds: clip.startTime + clip.duration,
    midpointSeconds: clip.startTime + clip.duration / 2, endExclusive: true,
  } : {
    status: 'unavailable', reason: 'invalid-timeline-timing',
    startSeconds: null, durationSeconds: null, endSeconds: null, midpointSeconds: null,
    endExclusive: true,
  }
  const result = source => ({ version: 1, timeline, source })
  if (!validTimeline) return result(unavailableSource('unavailable', 'invalid-timeline-timing'))
  if (clip.compound) return result(unavailableSource('unsupported', 'compound-has-no-single-source'))
  if (clip.type === 'image') return result(unavailableSource('not-applicable', 'still-image-has-no-source-time'))
  if (['text', 'shape', 'captions', 'adjustment'].includes(clip.type)) {
    return result(unavailableSource('not-applicable', 'generated-layer-has-no-source-time'))
  }
  if (clip.type !== 'video') return result(unavailableSource('unsupported', 'source-timing-requires-video'))
  if (!clip.assetId || !asset || asset.id !== clip.assetId) {
    return result(unavailableSource('unavailable', 'source-asset-not-in-project'))
  }
  if (asset.type !== 'video') return result(unavailableSource('unsupported', 'source-asset-type-mismatch'))

  // Reject malformed authored values instead of laundering them through the
  // playback helper's defensive defaults into apparently verified timestamps.
  if (!optionalNumber(clip.trimStart, value => value >= 0)
    || !optionalNumber(clip.trimEnd, value => value > 0)
    || !optionalNumber(clip.sourceDuration, value => value > 0)
    || !optionalNumber(clip.speed, value => value > 0)
    || !optionalNumber(clip.sourceTimeScale, value => value > 0)
    || !optionalNumber(clip.sourceFps, value => value > 0)
    || !optionalNumber(clip.timelineFps, value => value > 0)
    || (clip.reverse != null && typeof clip.reverse !== 'boolean')) {
    return result(unavailableSource('unavailable', 'invalid-source-timing'))
  }
  // Do not build a large speed integral during every snapshot. Non-linear
  // clips remain inspectable through Velorn's source/timeline frame tools.
  if (hasSpeedRamp(clip)) return result(unavailableSource('unsupported', 'active-speed-ramp'))

  const options = { useFrameSampling: false }
  const start = getClipPlaybackTimingAtTimeline(clip, timeline.startSeconds, 0, options)
  const end = getClipPlaybackTimingAtTimeline(clip, timeline.endSeconds, 0, options)
  const midpoint = getClipPlaybackTimingAtTimeline(clip, timeline.midpointSeconds, 0.000001, options)
  const trimIn = clip.trimStart ?? 0
  const trimOut = clip.trimEnd ?? clip.sourceDuration ?? start.maxTime
  if (![trimIn, trimOut, start.time, end.time, midpoint.time].every(finite)
    || trimOut <= trimIn || (clip.sourceDuration != null && trimOut > clip.sourceDuration)) {
    return result(unavailableSource('unavailable', 'invalid-source-bounds'))
  }
  return result({
    status: 'available', reference: 'original-media',
    mapping: clip.reverse ? 'reverse' : 'constant-speed',
    trimInSeconds: trimIn, trimOutSeconds: trimOut,
    startBoundarySeconds: start.time, endBoundarySeconds: end.time,
    midpointSeconds: midpoint.time,
    midpointClamped: midpoint.time !== midpoint.rawTime,
  })
}
