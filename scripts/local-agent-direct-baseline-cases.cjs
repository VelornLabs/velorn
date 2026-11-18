'use strict'

// Diagnostic data and pure outcome checks only: no network, model, editor or
// filesystem access. These checks do not prescribe an approval/preview policy.
// Public-answer truthfulness is a separate manual review, not implied by a pass.
const { isDeepStrictEqual: equal } = require('node:util')
const PICTURE_IDS = ['clip-1', 'clip-2', 'clip-3', 'clip-4', 'clip-5', 'clip-6']
const OPENING_ID = 'clip-8'
const LAST_ID = 'clip-6'
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-6
const assertion = (name, passed) => ({ name, passed: Boolean(passed) })

function getSnapshot(input) {
  if (!input || input.isError) return null
  if (Array.isArray(input.content)) {
    for (const block of input.content) if (block.type === 'text') {
      try { const value = getSnapshot(JSON.parse(block.text)); if (value) return value } catch {}
    }
    return null
  }
  const value = input.currentTimeline || input.timeline || input
  return Array.isArray(value.clips) ? value : null
}
function complete(value) {
  const s = getSnapshot(value)
  return Boolean(s && Number.isInteger(s.clipCount) && s.clipCount === s.clips.length
    && s.clipLimitApplied !== true && new Set(s.clips.map(c => c.id)).size === s.clips.length
    && Array.isArray(s.tracks) && Array.isArray(s.markers)
    && (Array.isArray(s.transitions) || s.transitionCount === 0))
}
function getPictures(value) {
  return (getSnapshot(value)?.clips || []).filter(c => ['video', 'image'].includes(c.type))
    .sort((a, b) => a.startTime - b.startTime || String(a.id).localeCompare(String(b.id)))
}
const clip = (value, id) => getSnapshot(value)?.clips.find(c => c.id === id)
function authoredClip(value) {
  if (!value) return null
  const result = clone(value)
  // Derived timing and cache progress are not authored changes. All source,
  // transform, effect, label, text and keyframe fields remain in the comparison.
  for (const key of ['computedTiming', 'cacheStatus', 'cacheProgress', 'cacheKind', 'opticalFlowCache']) delete result[key]
  return result
}
function authoredSnapshot(value) {
  const s = getSnapshot(value)
  if (!s) return null
  const result = {}
  for (const key of ['id', 'name', 'width', 'height', 'fps', 'duration', 'inPoint', 'outPoint', 'masterAudio']) {
    if (Object.hasOwn(s, key)) result[key] = clone(s[key])
  }
  result.clips = s.clips.map(authoredClip).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  result.tracks = clone(s.tracks || [])
  result.markers = clone(s.markers || []).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  result.transitions = clone(s.transitions || []).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return result
}
function sameExcept(before, after, ids = [], allowedClipFields = [], allowedTimelineFields = []) {
  const a = authoredSnapshot(before), b = authoredSnapshot(after)
  if (!a || !b) return false
  for (const value of [a, b]) {
    for (const field of allowedTimelineFields) delete value[field]
    for (const c of value.clips) if (ids.includes(c.id)) for (const field of allowedClipFields) delete c[field]
  }
  return equal(a, b)
}
const isRead = name => /^(get_|inspect_|find_|list_|check_)/.test(name || '') || name === 'analyze_timeline'
const isMutation = event => !isRead(event?.name) && event?.arguments?.previewOnly !== true
function timelineRead(event) {
  if (event?.name !== 'get_timeline' || event.result?.isError) return null
  const result = getSnapshot(event.result)
  return complete(result) ? result : null
}
function common(before, after, events = []) {
  const calls = Array.isArray(events) ? events : []
  const firstWrite = calls.findIndex(isMutation)
  const lastWrite = calls.reduce((last, event, index) => isMutation(event) ? index : last, -1)
  return [
    assertion('Independent before and after snapshots contain every clip', complete(before) && complete(after)),
    assertion('Model inspected the actual initial timeline before editing', calls.some((event, i) => {
      const s = timelineRead(event)
      return s && (firstWrite < 0 || i < firstWrite) && equal(authoredSnapshot(s), authoredSnapshot(before))
    })),
    assertion('Model read back the actual final timeline after its last edit attempt', calls.some((event, i) => {
      const s = timelineRead(event)
      return i > lastWrite && s && equal(authoredSnapshot(s), authoredSnapshot(after))
    })),
  ]
}
function timing(value, duration) {
  return value && close(value.startTime, 17) && close(value.duration, duration) && close(value.startTime + value.duration, 17 + duration)
}
function sourceTrimPreserved(before, after) {
  const a = clip(before, LAST_ID), b = clip(after, LAST_ID)
  if (!a || !b || !close(a.trimStart ?? 0, b.trimStart ?? 0)) return false
  // Native duration edits may update trimEnd or retain a wider source handle.
  // Compare visible source mapping, when supplied, without confusing timeline
  // end (19.5) with source Out (usually 2.5 for a zero-In normal-speed clip).
  const x = a.computedTiming?.source, y = b.computedTiming?.source
  if (x?.status === 'available') {
    const rate = (x.endBoundarySeconds - x.startBoundarySeconds) / a.duration
    return y?.status === 'available' && close(x.startBoundarySeconds, y.startBoundarySeconds)
      && close(y.endBoundarySeconds, x.startBoundarySeconds + b.duration * rate)
  }
  return true
}
function trimCheck(before, after, events, duration) {
  return [...common(before, after, events),
    assertion(`Last picture has absolute timing 17 / ${duration} / ${17 + duration}`, timing(clip(after, LAST_ID), duration)),
    assertion('Source In and visible source mapping are preserved', sourceTrimPreserved(before, after)),
    assertion('Only last-picture duration and source Out may change', sameExcept(before, after, [LAST_ID], ['duration', 'trimEnd'])),
  ]
}
function deletionOnly(before, after) {
  const a = authoredSnapshot(before), b = authoredSnapshot(after)
  if (!a || !b || !clip(before, OPENING_ID) || clip(after, OPENING_ID)) return false
  a.clips = a.clips.filter(c => c.id !== OPENING_ID)
  return equal(a, b)
}
function deletionRecord(previousCases = []) {
  return [...previousCases].reverse().find(record => record.name === '09-delete-opening-title-only' && !record.skipped)
}
function canUndoDeletion(before, previousCases = []) {
  const previous = deletionRecord(previousCases)
  if (!previous || previous.errorCode || !deletionOnly(previous.before, previous.after)
    || !equal(authoredSnapshot(before), authoredSnapshot(previous.after))) return false
  const edits = (previous.events || []).filter(isMutation)
  // Only the established single delete may be at the top of Undo. A later
  // unrelated write or repeated delete attempt makes that premise uncertain.
  return edits.length === 1 && edits[0].name === 'delete_clips'
    && edits[0].arguments?.previewOnly === false && edits[0].arguments?.ripple !== true
    && edits[0].result?.isError !== true
}

const inspect = 'Inspect the current timeline first. '
const finish = ' Inspect the timeline again after the operation and report the observed result. Change nothing else.'
const cases = [
  {
    id: 1, name: '01-inspect-existing-sequence',
    prompt: inspect + 'Without changing anything, report the number of picture clips (video/image clips, excluding titles and audio), the last picture clip ID, and its timeline start, duration and end in seconds.',
    verify: (before, after, events) => [...common(before, after, events),
      assertion('Six picture clips and nine total clips are present', getPictures(after).length === 6 && getSnapshot(after)?.clips.length === 9),
      assertion('Last picture is clip-6 at 17 / 3 / 20', getPictures(after).at(-1)?.id === LAST_ID && timing(clip(after, LAST_ID), 3)),
      assertion('No authored state changed', equal(authoredSnapshot(before), authoredSnapshot(after))),
      assertion('No editing tool was attempted', !(events || []).some(isMutation)),
    ],
  },
  {
    id: 2, name: '02-absolute-trim-last-picture',
    prompt: inspect + 'Directly set the last picture clip (clip-6) to start at 17 seconds and have an absolute duration of 2.5 seconds, ending at 19.5 seconds. Keep its source In, playback settings and all other clips unchanged.' + finish,
    verify: (before, after, events) => trimCheck(before, after, events, 2.5),
  },
  {
    id: 3, name: '03-repeat-absolute-trim',
    prompt: inspect + 'Repeat the same absolute setting for clip-6: start 17 seconds, duration 2.5 seconds, end 19.5 seconds. This is the same requested final duration, not another half-second shortening. If it already has that timing, leave it unchanged.' + finish,
    verify: (before, after, events) => [...trimCheck(before, after, events, 2.5),
      assertion('Prior trim established the repeat-test starting state', timing(clip(before, LAST_ID), 2.5)),
      assertion('Repeat did not change authored state', equal(authoredSnapshot(before), authoredSnapshot(after))),
    ],
  },
  {
    id: 4, name: '04-restore-last-picture-duration',
    prompt: inspect + 'Directly restore clip-6 to the absolute timing start 17 seconds, duration 3 seconds and end 20 seconds. Keep its original source In and playback settings, and leave every other clip unchanged.' + finish,
    verify: (before, after, events) => trimCheck(before, after, events, 3),
  },
  {
    id: 5, name: '05-swap-picture-positions',
    prompt: inspect + 'Swap picture clips clip-2 and clip-4 in the picture sequence, then pack the six pictures from time zero with no gaps or overlaps. The resulting order must be clip-1, clip-4, clip-3, clip-2, clip-5, clip-6. Preserve every clip\'s individual duration, source bounds and playback settings; do not move or change titles or audio.' + finish,
    verify(before, after, events) {
      const pictures = getPictures(after), expected = ['clip-1', 'clip-4', 'clip-3', 'clip-2', 'clip-5', 'clip-6']
      return [...common(before, after, events),
        assertion('Packed picture order is 1, 4, 3, 2, 5, 6', equal(pictures.map(c => c.id), expected)),
        assertion('Packed picture starts are 0, 3, 6, 10, 14, 17', pictures.length === 6 && pictures.every((c, i) => close(c.startTime, [0, 3, 6, 10, 14, 17][i]))),
        assertion('Every picture retains individual duration, source and all other fields', sameExcept(before, after, PICTURE_IDS, ['startTime'])),
      ]
    },
  },
  {
    id: 6, name: '06-change-opening-title-text',
    prompt: inspect + 'Change only the text of the existing opening title clip-8 (the title at 0–3 seconds) to exactly LOCAL AGENT BASELINE. Keep its timing, style, animation and track unchanged; do not create a new title.' + finish,
    verify(before, after, events) {
      const a = authoredClip(clip(before, OPENING_ID)), b = authoredClip(clip(after, OPENING_ID))
      const targetText = b?.textProperties?.text
      for (const c of [a, b]) if (c) { delete c.text; if (c.textProperties) delete c.textProperties.text }
      return [...common(before, after, events),
        assertion('Existing opening title text is exactly LOCAL AGENT BASELINE', targetText === 'LOCAL AGENT BASELINE'),
        assertion('All other opening-title fields are unchanged', equal(a, b)),
        assertion('Every other clip and timeline field is unchanged', sameExcept(before, after, [OPENING_ID], ['text', 'textProperties'])),
      ]
    },
  },
  {
    id: 7, name: '07-opening-title-opacity-keyframes',
    prompt: inspect + 'Set the existing opening title clip-8 opacity animation to exactly four linear keyframes at times relative to the clip start: 0 seconds = 0, 0.5 seconds = 100, 2.5 seconds = 100, 3 seconds = 0. Preserve its text, timing, style and any non-opacity animation.' + finish,
    verify(before, after, events) {
      const a = authoredClip(clip(before, OPENING_ID)), b = authoredClip(clip(after, OPENING_ID))
      const keys = b?.keyframes?.opacity
      for (const c of [a, b]) if (c?.keyframes) delete c.keyframes.opacity
      return [...common(before, after, events),
        assertion('Opacity has exactly the four requested linear keyframes', Array.isArray(keys) && keys.length === 4
          && keys.every((k, i) => close(k.time, [0, 0.5, 2.5, 3][i]) && close(k.value, [0, 100, 100, 0][i]) && k.easing === 'linear')),
        assertion('All non-opacity title fields and animation remain unchanged', equal(a, b)),
        assertion('Every other clip and timeline field is unchanged', sameExcept(before, after, [OPENING_ID], ['keyframes'])),
      ]
    },
  },
  {
    id: 8, name: '08-label-picture-and-add-marker',
    prompt: inspect + 'Set picture clip-2\'s label color to orange #f97316 and add one timeline marker at exactly 4 seconds labeled Local baseline check. Preserve existing markers and all other clip properties.' + finish,
    verify(before, after, events) {
      const old = getSnapshot(before)?.markers || [], current = getSnapshot(after)?.markers || []
      const additions = current.filter(marker => !old.some(previous => previous.id === marker.id))
      return [...common(before, after, events),
        assertion('Picture clip-2 label is orange #f97316', clip(after, 'clip-2')?.labelColor?.toLowerCase() === '#f97316'),
        assertion('Exactly one requested marker was added', current.length === old.length + 1 && additions.length === 1
          && close(additions[0].time, 4) && (additions[0].name ?? additions[0].label) === 'Local baseline check'),
        assertion('Existing markers are unchanged', old.every(marker => equal(marker, current.find(candidate => candidate.id === marker.id)))),
        assertion('Only target label and new marker may change', sameExcept(before, after, ['clip-2'], ['labelColor'], ['markers'])),
      ]
    },
  },
  {
    id: 9, name: '09-delete-opening-title-only',
    prompt: inspect + 'Delete only the existing opening title clip-8 from this timeline, without ripple deletion. Keep all pictures, the closing title, audio and timeline markers exactly as they are. Do not delete any source media files.' + finish,
    prerequisite: before => clip(before, OPENING_ID)?.type === 'text',
    verify: (before, after, events) => [...common(before, after, events),
      assertion('Only the existing opening title was deleted, with no ripple or collateral changes', deletionOnly(before, after)),
    ],
  },
  {
    id: 10, name: '10-undo-opening-title-deletion',
    prompt: inspect + 'Undo the immediately preceding opening-title deletion exactly once. Restore that existing title with its text, timing and animation, while preserving all other edits already made. Do not recreate the title or issue a second Undo.' + finish,
    prerequisite: canUndoDeletion,
    verify(before, after, events, previousCases = []) {
      const previous = deletionRecord(previousCases)
      const edits = (events || []).filter(isMutation)
      return [...common(before, after, events),
        assertion('Immediately preceding single deletion was established', canUndoDeletion(before, previousCases)),
        assertion('Exactly one Undo and no other edit was attempted', edits.length === 1 && edits[0].name === 'undo'),
        assertion('Exact authored pre-deletion timeline was restored', Boolean(previous) && equal(authoredSnapshot(after), authoredSnapshot(previous.before))),
      ]
    },
  },
]

const finalRoundtripCase = {
  name: '10-delete-undo-opening-title-roundtrip',
  prompt: inspect + 'Delete only the existing opening title clip-8, without ripple deletion. Inspect the timeline to confirm that only this title was removed. Then Undo that deletion exactly once, inspect the timeline again, and verify that the original title and the complete timeline were restored exactly. Preserve all other clips and markers. Do not recreate the title or delete source media files.',
  prerequisite: before => clip(before, OPENING_ID)?.type === 'text',
  verify(before, after, events = []) {
    const native = event => {
      if (event?.result?.isError) return null
      for (const block of event?.result?.content || []) if (block.type === 'text') {
        try {
          const value = JSON.parse(block.text), inner = value.result || value
          if (value.success !== false && value.previewOnly !== true && inner.success !== false && inner.previewOnly !== true) return inner
        } catch {}
      }
      return null
    }
    const deletes = events.map((event, index) => ({ event, index, result: native(event) }))
      .filter(({ event, result }) => event.name === 'delete_clips' && result?.deletedCount > 0)
    const undos = events.map((event, index) => ({ event, index, result: native(event) }))
      .filter(({ event, result }) => event.name === 'undo' && result?.applied === true)
    const deletion = deletes[0], undo = undos[0]
    const ordered = deletes.length === 1 && undos.length === 1 && deletion.index < undo.index
    return [...common(before, after, events),
      assertion('Exactly one native non-ripple deletion removed only clip-8', deletes.length === 1
        && deletion.result.deletedCount === 1 && equal(deletion.result.deletedClipIds, [OPENING_ID])
        && deletion.result.ripple === false),
      assertion('Exactly one native Undo applied after the deletion', ordered),
      assertion('Model observed only the title absent between delete and Undo', ordered && events.some((event, index) => {
        const s = timelineRead(event)
        return index > deletion.index && index < undo.index && s && deletionOnly(before, s)
      })),
      assertion('Model observed the exact restored timeline after Undo', ordered && events.some((event, index) => {
        const s = timelineRead(event)
        return index > undo.index && s && equal(authoredSnapshot(s), authoredSnapshot(before))
      })),
      assertion('Initial authored timeline was restored exactly', equal(authoredSnapshot(before), authoredSnapshot(after))),
    ]
  },
}

module.exports = { cases, finalRoundtripCase, getSnapshot, getPictures, authoredSnapshot, canUndoDeletion }
