import useProjectStore from '../stores/projectStore'
import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import { TIMELINE_PROJECT_KEYS } from './projectDirtyTracker'

// A preview belongs to one renderer session and one authored document revision.
// Playback/selection/UI layout do not edit the document and must not invalidate it.
// Native planners freeze any selection/playhead-dependent operands separately.
const session = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
const handles = new WeakMap()
let nextHandle = 0
let revision = 0
let previous = null

// Saving copies the live document into currentProject.timelines and replaces
// that array even when the edit did not change. The live store remains the
// authority for its document fields; only metadata comes from its saved copy.
// Inactive timelines have no live store, so retain all of their content. Do
// not broadly discard timestamps or unknown metadata: only the timeline's
// top-level `modified` field is rewritten by an unchanged save.
const liveDocumentKeys = new Set(TIMELINE_PROJECT_KEYS)
const timelineFingerprints = new WeakMap()
let cachedTimelines = null
let cachedTimelineId = null
let cachedTimelineFingerprint = null

function canonicalTimelineValue(value, ancestors = new Set(), depth = 0) {
  if (!value || typeof value !== 'object') return value
  if (depth > 128 || ancestors.has(value)) throw new Error('Cannot inspect timeline metadata: cyclic or excessively nested data.')
  ancestors.add(value)
  try {
    return Array.isArray(value)
      ? value.map(item => canonicalTimelineValue(item, ancestors, depth + 1))
      : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalTimelineValue(value[key], ancestors, depth + 1)]))
  } finally { ancestors.delete(value) }
}

function timelineFingerprint(item, active) {
  if (!item || typeof item !== 'object') return JSON.stringify(item)
  const cached = timelineFingerprints.get(item)
  const variant = active ? 'active' : 'inactive'
  if (cached && Object.hasOwn(cached, variant)) return cached[variant]
  const authored = Object.fromEntries(Object.entries(item).filter(([key]) =>
    key !== 'modified' && !(active && liveDocumentKeys.has(key))))
  // Object-key order is not authored state. Timeline/clip array order is.
  const fingerprint = JSON.stringify(canonicalTimelineValue(authored))
  timelineFingerprints.set(item, { ...cached, [variant]: fingerprint })
  return fingerprint
}

function projectTimelinesFingerprint(project) {
  const timelines = project.currentProject?.timelines
  if (timelines === cachedTimelines && project.currentTimelineId === cachedTimelineId) return cachedTimelineFingerprint
  const fingerprint = Array.isArray(timelines)
    ? JSON.stringify(timelines.map(item => timelineFingerprint(item, item?.id === project.currentTimelineId)))
    : JSON.stringify(timelines)
  // A failed serialization must fail closed on every capture, not cache new
  // identities against the previous valid fingerprint.
  cachedTimelines = timelines
  cachedTimelineId = project.currentTimelineId
  cachedTimelineFingerprint = fingerprint
  return cachedTimelineFingerprint
}

function projectKey(state) {
  if (!state.currentProject) return null
  const handle = state.currentProjectHandle
  if (typeof handle === 'string') return handle
  if (handle && typeof handle === 'object') {
    if (!handles.has(handle)) handles.set(handle, `browser-project-${++nextHandle}`)
    return handles.get(handle)
  }
  return state.currentProject.id || state.currentProject.name || 'unsaved-project'
}

export function captureMcpContext() {
  const project = useProjectStore.getState()
  const timeline = useTimelineStore.getState()
  const assets = useAssetsStore.getState()
  const key = projectKey(project)
  const activeTimeline = project.currentProject?.timelines?.find(item => item.id === project.currentTimelineId)
  const signature = [key, project.currentTimelineId, timeline.timelineSessionId,
    timeline.compoundEditContext, timeline.clips, timeline.tracks, timeline.transitions,
    timeline.markers, timeline.timelineFps, timeline.inPoint, timeline.outPoint,
    timeline.masterAudioVolume, timeline.masterAudioInserts, timeline.duration,
    project.currentProject?.settings, activeTimeline?.width, activeTimeline?.height, activeTimeline?.fps,
    project.currentProject?.storyboard, project.storyboardRevision,
    projectTimelinesFingerprint(project),
    assets.assets, assets.folders]
  if (!previous || signature.some((value, index) => value !== previous[index])) {
    previous = signature
    revision += 1
  }
  return {
    schemaVersion: 1,
    session,
    projectKey: key,
    timelineId: project.currentTimelineId || null,
    timelineSessionId: timeline.timelineSessionId,
    compoundClipId: timeline.compoundEditContext?.compoundClipId || null,
    storyboardRevision: project.storyboardRevision || 0,
    revision,
  }
}

export function assertMcpContext(expectedContext, label = 'operation') {
  // Existing clients remain compatible; new previews return this guard explicitly.
  if (expectedContext === undefined) return
  const actual = captureMcpContext()
  if (!expectedContext || typeof expectedContext !== 'object' || Array.isArray(expectedContext)
    || Object.keys(actual).some(key => expectedContext[key] !== actual[key])) {
    throw new Error(`Cannot apply ${label}: the project or timeline changed after preview. Inspect and preview again.`)
  }
}

// Native connected-agent approvals also freeze UI-dependent operands. This is
// kept separate from the public document revision (scrubbing is not an edit).
export function captureAgentInteractionContext() {
  const timeline = useTimelineStore.getState()
  const assets = useAssetsStore.getState()
  return {
    context: captureMcpContext(),
    selection: {
      clipIds: [...(timeline.selectedClipIds || [])],
      previewAssetId: assets.currentPreview?.id || null,
      selectedMarkerId: timeline.selectedMarkerId || null,
      selectedTransitionId: timeline.selectedTransitionId || null,
      activeTrackId: timeline.activeTrackId || null,
      selectedGap: timeline.selectedGap || null,
    },
    playhead: timeline.playheadPosition,
  }
}

export function assertAgentInteractionContext(expected, label) {
  if (expected === undefined) return
  assertMcpContext(expected?.context, label)
  const actual = captureAgentInteractionContext()
  if (!expected?.context || JSON.stringify(expected.selection) !== JSON.stringify(actual.selection)
    || expected.playhead !== actual.playhead) {
    throw new Error(`Cannot apply ${label}: the selection or playhead changed after approval. Inspect and preview again.`)
  }
}
