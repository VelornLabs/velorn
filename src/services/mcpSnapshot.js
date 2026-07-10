import useProjectStore from '../stores/projectStore'
import useAssetsStore from '../stores/assetsStore'
import useTimelineStore from '../stores/timelineStore'
import { clampTrackPan, clampTrackVolume } from '../utils/audioTrackAudibility'
import { normalizeAudioInserts } from '../utils/audioInserts'

const SNAPSHOT_VERSION = 1
const MAX_TEXT_LENGTH = 2000

function truncateText(value, maxLength = MAX_TEXT_LENGTH) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function safeClone(value) {
  if (value === null || value === undefined) return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

function safeNumber(value, fallback = null) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function getProjectPath(handle) {
  if (!handle) return ''
  if (typeof handle === 'string') return handle
  return handle.name || ''
}

function sanitizeSettings(settings = {}) {
  return {
    width: safeNumber(settings.width),
    height: safeNumber(settings.height),
    fps: safeNumber(settings.fps),
    resolution: settings.resolution || settings.name || '',
  }
}

function sanitizeFolder(folder = {}) {
  return {
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId || null,
    color: folder.color || null,
    createdAt: folder.createdAt || folder.created || null,
  }
}

function sanitizeAsset(asset = {}) {
  const settings = asset.settings || {}
  const yolo = asset.yolo || settings.yolo || null
  return {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    folderId: asset.folderId || null,
    path: asset.path || '',
    absolutePath: asset.absolutePath || '',
    isImported: Boolean(asset.isImported),
    createdAt: asset.createdAt || asset.imported || null,
    imported: asset.imported || null,
    mimeType: asset.mimeType || '',
    size: safeNumber(asset.size),
    duration: safeNumber(asset.duration ?? settings.duration),
    width: safeNumber(asset.width ?? settings.width),
    height: safeNumber(asset.height ?? settings.height),
    prompt: truncateText(asset.prompt || settings.prompt || ''),
    negativePrompt: truncateText(asset.negativePrompt || settings.negativePrompt || ''),
    workflowId: asset.workflowId || settings.workflowId || '',
    workflowName: asset.workflowName || settings.workflowName || '',
    model: asset.model || settings.model || settings.modelName || '',
    sourceTool: settings.sourceTool || asset.sourceTool || '',
    overlayKind: settings.overlayKind || asset.overlayKind || '',
    generatedBy: settings.generatedBy || asset.generatedBy || '',
    solidColor: settings.solidColor || settings.color || asset.solidColor || asset.color || '',
    generationStatus: asset.generationStatus || asset.status || 'none',
    error: truncateText(asset.error || asset.generationError || settings.error || ''),
    yolo: safeClone(yolo),
    poster: asset.poster ? {
      posterPath: asset.poster.posterPath || '',
      width: safeNumber(asset.poster.width),
      height: safeNumber(asset.poster.height),
      created: asset.poster.created || null,
    } : null,
    sprite: asset.sprite ? {
      spritePath: asset.sprite.spritePath || '',
      width: safeNumber(asset.sprite.width),
      height: safeNumber(asset.sprite.height),
      frameCount: safeNumber(asset.sprite.frameCount),
      duration: safeNumber(asset.sprite.duration),
      frameWidth: safeNumber(asset.sprite.frameWidth),
      frameHeight: safeNumber(asset.sprite.frameHeight),
    } : null,
    playbackCacheStatus: asset.playbackCacheStatus || '',
    proxyStatus: asset.proxyStatus || '',
  }
}

function sanitizeTrack(track = {}) {
  return {
    id: track.id,
    name: track.name,
    type: track.type,
    muted: Boolean(track.muted),
    locked: Boolean(track.locked),
    visible: track.visible !== false,
    role: track.role || null,
    channels: track.channels || null,
    ...(track.type === 'audio'
      ? {
        solo: Boolean(track.solo),
        volume: clampTrackVolume(track.volume),
        pan: clampTrackPan(track.pan),
        inserts: normalizeAudioInserts(track.inserts),
      }
      : {}),
  }
}

function sanitizeClip(clip = {}) {
  return {
    id: clip.id,
    name: clip.name,
    type: clip.type,
    assetId: clip.assetId || null,
    trackId: clip.trackId || null,
    startTime: safeNumber(clip.startTime, 0),
    duration: safeNumber(clip.duration, 0),
    trimStart: safeNumber(clip.trimStart, 0),
    trimEnd: safeNumber(clip.trimEnd),
    sourceDuration: safeNumber(clip.sourceDuration),
    speed: safeNumber(clip.speed, 1),
    enabled: clip.enabled !== false,
    labelColor: clip.labelColor || '',
    trackMatte: clip.trackMatte || 'none',
    lockMode: clip.lockMode || null,
    syncLock: safeClone(clip.syncLock),
    transform: safeClone(clip.transform),
    effects: safeClone(clip.effects),
    textProperties: safeClone(clip.textProperties),
    shapeProperties: safeClone(clip.shapeProperties),
    titleAnimation: safeClone(clip.titleAnimation),
    keyframes: safeClone(clip.keyframes),
    metadata: safeClone(clip.metadata),
    captionScope: clip.captionScope || clip.metadata?.captionScope || null,
    overlayKind: clip.overlayKind || null,
    text: truncateText(clip.textProperties?.text || clip.text || clip.content || ''),
  }
}

function sanitizeTransition(transition = {}) {
  return {
    id: transition.id,
    kind: transition.kind || (transition.clipId ? 'edge' : 'between'),
    type: transition.type,
    clipAId: transition.clipAId || transition.fromClipId || null,
    clipBId: transition.clipBId || transition.toClipId || null,
    clipId: transition.clipId || null,
    edge: transition.edge || null,
    startTime: safeNumber(transition.startTime),
    duration: safeNumber(transition.duration),
    settings: safeClone(transition.settings),
    split: safeClone(transition.split),
    contributions: safeClone(transition.contributions),
  }
}

function buildTimelineSnapshot(timeline = {}, projectSettings = {}, { includeClips = true, selectedClipIds = [] } = {}) {
  const settings = {
    width: safeNumber(timeline.width ?? projectSettings.width, projectSettings.width || null),
    height: safeNumber(timeline.height ?? projectSettings.height, projectSettings.height || null),
    fps: safeNumber(timeline.fps ?? projectSettings.fps, projectSettings.fps || 24),
  }
  const clips = Array.isArray(timeline.clips) ? timeline.clips : []
  const tracks = Array.isArray(timeline.tracks) ? timeline.tracks : []
  const transitions = Array.isArray(timeline.transitions) ? timeline.transitions : []

  return {
    id: timeline.id,
    name: timeline.name,
    created: timeline.created || null,
    modified: timeline.modified || null,
    width: settings.width,
    height: settings.height,
    fps: settings.fps,
    playheadPosition: safeNumber(timeline.playheadPosition, 0),
    duration: safeNumber(timeline.duration, 0),
    trackCount: tracks.length,
    clipCount: clips.length,
    transitionCount: transitions.length,
    markerCount: Array.isArray(timeline.markers) ? timeline.markers.length : 0,
    selectedClipIds: Array.isArray(selectedClipIds) ? selectedClipIds.filter(Boolean) : [],
    selectedClipCount: Array.isArray(selectedClipIds) ? selectedClipIds.filter(Boolean).length : 0,
    masterAudio: {
      volume: clampTrackVolume(timeline.masterAudioVolume),
      inserts: normalizeAudioInserts(timeline.masterAudioInserts),
    },
    tracks: tracks.map(sanitizeTrack),
    clips: includeClips ? clips.map(sanitizeClip) : undefined,
    transitions: transitions.map(sanitizeTransition),
    markers: (timeline.markers || []).map((marker) => ({
      id: marker.id,
      name: marker.name || marker.label || '',
      time: safeNumber(marker.time, 0),
      color: marker.color || '',
    })),
  }
}

export function buildMcpSnapshot() {
  const projectState = useProjectStore.getState()
  const timelineState = useTimelineStore.getState()
  const assetsState = useAssetsStore.getState()
  const project = projectState.currentProject
  const projectSettings = sanitizeSettings(project?.settings || {})
  const projectPath = getProjectPath(projectState.currentProjectHandle)
  const assetProjectData = typeof assetsState.getProjectData === 'function'
    ? assetsState.getProjectData()
    : (assetsState.assets || [])
  const assets = (assetProjectData || []).map(sanitizeAsset)
  const folders = (assetsState.folders || []).map(sanitizeFolder)

  if (!project) {
    return {
      schemaVersion: SNAPSHOT_VERSION,
      generatedAt: new Date().toISOString(),
      app: { name: 'Velorn' },
      project: null,
      timelines: [],
      currentTimeline: null,
      assets: [],
      folders: [],
    }
  }

  const liveTimeline = typeof timelineState.getProjectData === 'function'
    ? timelineState.getProjectData()
    : {}
  const currentTimelineMeta = (project.timelines || []).find((timeline) => timeline.id === projectState.currentTimelineId)
    || (project.timelines || [])[0]
    || {}
  const currentTimeline = {
    ...currentTimelineMeta,
    ...liveTimeline,
    id: currentTimelineMeta.id || projectState.currentTimelineId,
    name: currentTimelineMeta.name || 'Timeline',
    width: currentTimelineMeta.width ?? projectSettings.width,
    height: currentTimelineMeta.height ?? projectSettings.height,
    fps: currentTimelineMeta.fps ?? projectSettings.fps ?? timelineState.timelineFps,
    playheadPosition: timelineState.playheadPosition,
  }

  const timelines = (project.timelines || []).map((timeline) => {
    const source = timeline.id === currentTimeline.id ? currentTimeline : timeline
    return buildTimelineSnapshot(source, projectSettings, {
      includeClips: false,
      selectedClipIds: timeline.id === currentTimeline.id ? timelineState.selectedClipIds : [],
    })
  })

  return {
    schemaVersion: SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    app: { name: 'Velorn' },
    project: {
      name: project.name,
      path: projectPath,
      created: project.created || null,
      modified: project.modified || null,
      settings: projectSettings,
      currentTimelineId: currentTimeline.id,
      timelineCount: timelines.length,
      assetCount: assets.length,
      folderCount: folders.length,
    },
    timelines,
    currentTimeline: buildTimelineSnapshot(currentTimeline, projectSettings, {
      includeClips: true,
      selectedClipIds: timelineState.selectedClipIds,
    }),
    assets,
    folders,
  }
}

export function startMcpSnapshotPublisher({ debounceMs = 350, heartbeatMs = 10000 } = {}) {
  const api = typeof window !== 'undefined' ? window.electronAPI?.mcp : null
  if (!api?.updateSnapshot) return () => {}

  let publishTimer = null
  let stopped = false

  const publish = () => {
    if (stopped) return
    publishTimer = null
    const snapshot = buildMcpSnapshot()
    Promise.resolve(api.updateSnapshot(snapshot)).catch((error) => {
      console.warn('[MCP] snapshot publish failed:', error)
    })
  }

  const schedulePublish = () => {
    if (stopped) return
    if (publishTimer) clearTimeout(publishTimer)
    publishTimer = setTimeout(publish, debounceMs)
  }

  const unsubscribers = [
    useProjectStore.subscribe(schedulePublish),
    useTimelineStore.subscribe(schedulePublish),
    useAssetsStore.subscribe(schedulePublish),
  ]

  publish()
  const heartbeat = setInterval(schedulePublish, heartbeatMs)

  return () => {
    stopped = true
    if (publishTimer) clearTimeout(publishTimer)
    clearInterval(heartbeat)
    unsubscribers.forEach((unsubscribe) => {
      try { unsubscribe?.() } catch (_) {}
    })
  }
}
