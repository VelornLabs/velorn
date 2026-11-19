'use strict'

const { compactJsonText } = require('./localAgentJson.cjs')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const pick = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
const failed = value => object(value) && (value.isError === true || value.success === false || Object.hasOwn(value, 'error')
  || value.previewOnly === true || value.applied === true)
const identity = value => typeof value === 'string' && value.length > 0

// Projection of a native get_timeline result, never a model-authored summary.
// Caller gates by the actual tool name and retains the original detail first.
// Null means use ordinary lossless transport, not guess or silently cut rows.
function buildTimelineOverview(result, { maxChars = 12000 } = {}) {
  if (!object(result) || failed(result) || Object.keys(result).some(key => !['content', 'isError'].includes(key))
    || !Array.isArray(result.content) || result.content.length !== 1
    || result.content[0]?.type !== 'text' || typeof result.content[0].text !== 'string') return null
  let timeline
  try { timeline = JSON.parse(result.content[0].text) } catch { return null }
  // Avoid changing duplicate keys, rounded numeric tokens or other ambiguous
  // representations into deceptively authoritative timing/identity facts.
  if (compactJsonText(result.content[0].text) !== JSON.stringify(timeline)
    || !object(timeline) || failed(timeline) || failed(timeline.result) || !identity(timeline.id)
    || !Number.isSafeInteger(timeline.clipCount) || timeline.clipCount < 0
    || typeof timeline.clipLimitApplied !== 'boolean' || !Array.isArray(timeline.clips)
    || !Array.isArray(timeline.tracks)) return null
  const ids = new Set()
  const clips = []
  for (const clip of timeline.clips) {
    if (!object(clip) || !identity(clip.id) || ids.has(clip.id) || !identity(clip.type)) return null
    ids.add(clip.id)
    const row = pick(clip, ['id', 'name', 'type', 'assetId', 'trackId', 'enabled', 'locked', 'syncLocked',
      'startTime', 'duration', 'trimStart', 'trimEnd', 'speed', 'reverse'])
    // Keep native mapping status/reason and times together. Do not fabricate
    // a source time for audio, stills, compound clips or unsupported retiming.
    row.computedTiming = object(clip.computedTiming) ? clip.computedTiming : {
      timeline: { status: 'unavailable', reason: 'computed-timing-not-returned' },
      source: { status: 'unavailable', reason: 'computed-timing-not-returned' },
    }
    clips.push(row)
  }
  if (timeline.tracks.some(track => !object(track) || !identity(track.id))) return null
  if (new Set(timeline.tracks.map(track => track.id)).size !== timeline.tracks.length) return null
  const overview = {
    kind: 'timeline-overview',
    timeline: pick(timeline, ['id', 'name', 'duration', 'fps', 'width', 'height', 'clipCount', 'clipCounts',
      'trackCount', 'transitionCount', 'markerCount', 'selectedClipIds', 'playheadPosition', 'inPoint', 'outPoint']),
    coverage: { returnedClips: clips.length, totalClips: timeline.clipCount,
      allTimelineClipsIncluded: timeline.clipLimitApplied === false && clips.length === timeline.clipCount,
      allReturnedClipsListed: true, clipLimitApplied: timeline.clipLimitApplied },
    ...pick(timeline, ['context', 'editingContext']),
    tracks: timeline.tracks.map(track => pick(track, ['id', 'name', 'type', 'muted', 'visible', 'solo', 'locked', 'syncLocked'])),
    clips,
    detail: 'Identity, timing and basic state only. Effects, keyframes, text, markers, transitions and other details remain in the retained full result. Paging retrieves returned data only, not clips omitted by the native clip limit. Times do not prove media visibility or availability. Timeline duration is the container duration, not necessarily the last picture end.',
  }
  const text = JSON.stringify(overview)
  return Number.isSafeInteger(maxChars) && maxChars > 0 && text.length <= maxChars ? text : null
}

module.exports = { buildTimelineOverview }
