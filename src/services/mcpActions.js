import useTimelineStore from '../stores/timelineStore'
import useProjectStore from '../stores/projectStore'
import useAssetsStore from '../stores/assetsStore'
import { captureTimelineFrameAt } from '../utils/captureTimelineFrame'

function normalizeClipLabelColor(color) {
  const value = String(color || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : ''
}

function summarizeClip(clip) {
  return {
    id: clip.id,
    name: clip.name || clip.assetName || clip.id,
    type: clip.type || 'unknown',
    trackId: clip.trackId || null,
    startTime: Number(clip.startTime) || 0,
    duration: Number(clip.duration) || 0,
    labelColor: clip.labelColor || '',
  }
}

function safeClone(value) {
  if (value === null || typeof value === 'undefined') return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

function getNextMcpClipCounter(clips = [], currentCounter = 1) {
  const maxClipNumber = clips.reduce((max, clip) => {
    const match = /^clip-(\d+)$/.exec(String(clip?.id || ''))
    if (!match) return max
    return Math.max(max, Number(match[1]) || 0)
  }, 0)
  return Math.max(Number(currentCounter) || 1, maxClipNumber + 1, 1)
}

function normalizeMarkerColor(color) {
  const value = String(color || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : '#f5c451'
}

function normalizeOptionalMarkerColor(color) {
  const value = String(color || '').trim()
  if (!value) return ''
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase()
  throw new Error('Invalid marker color. Use a hex color like #f97316, or an empty string to clear marker color.')
}

function roundToTimelineFrame(time, fps = 24) {
  const safeFps = Math.max(1, Number(fps) || 24)
  return Math.max(0, Math.round((Number(time) || 0) * safeFps) / safeFps)
}

function makeEvenDimension(value) {
  return Math.max(2, Math.round((Number(value) || 2) / 2) * 2)
}

function sanitizeExportBaseName(value) {
  return String(value || 'ComfyStudio_Timeline')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120)
    || 'ComfyStudio_Timeline'
}

function summarizeMarker(marker) {
  return {
    id: marker.id,
    time: Number(marker.time) || 0,
    label: marker.label || '',
    color: marker.color || '',
  }
}

function summarizeTrack(track) {
  return {
    id: track.id,
    name: track.name || track.id,
    type: track.type || 'unknown',
    muted: !!track.muted,
    locked: !!track.locked,
    visible: track.visible !== false,
    role: track.role || null,
    channels: track.channels || null,
  }
}

function normalizeTrackType(type) {
  const value = String(type || '').trim().toLowerCase()
  if (value === 'audio') return 'audio'
  return 'video'
}

function normalizeAudioChannels(channels) {
  return String(channels || '').trim().toLowerCase() === 'mono' ? 'mono' : 'stereo'
}

const TEXT_STYLE_KEYS = [
  'text',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'textColor',
  'backgroundColor',
  'backgroundOpacity',
  'backgroundPadding',
  'textAlign',
  'verticalAlign',
  'strokeColor',
  'strokeWidth',
  'letterSpacing',
  'lineHeight',
  'shadow',
  'shadowColor',
  'shadowBlur',
  'shadowOffsetX',
  'shadowOffsetY',
]

const TEXT_TRANSFORM_KEYS = [
  'positionX',
  'positionY',
  'scaleX',
  'scaleY',
  'scaleLinked',
  'rotation',
  'anchorX',
  'anchorY',
  'opacity',
  'blur',
  'cropTop',
  'cropBottom',
  'cropLeft',
  'cropRight',
  'flipH',
  'flipV',
]

const TEXT_KEYFRAME_PROPERTIES = new Set([
  'opacity',
  'positionX',
  'positionY',
  'scaleX',
  'scaleY',
  'rotation',
  'blur',
  'cropTop',
  'cropBottom',
  'cropLeft',
  'cropRight',
  'textColor',
])

const TEXT_TRANSFORM_NUMBER_FIELDS = {
  positionX: [0, -20000, 20000],
  positionY: [0, -20000, 20000],
  scaleX: [100, 1, 2000],
  scaleY: [100, 1, 2000],
  rotation: [0, -3600, 3600],
  anchorX: [50, -1000, 1000],
  anchorY: [50, -1000, 1000],
  opacity: [100, 0, 100],
  blur: [0, 0, 50],
  cropTop: [0, 0, 100],
  cropBottom: [0, 0, 100],
  cropLeft: [0, 0, 100],
  cropRight: [0, 0, 100],
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key)
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function normalizeHexColor(value, { allowTransparent = false } = {}) {
  const raw = String(value || '').trim()
  if (allowTransparent && raw.toLowerCase() === 'transparent') return 'transparent'
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase()
  return ''
}

function normalizeTextStyleUpdates(payload = {}) {
  const source = {
    ...(payload.style && typeof payload.style === 'object' ? payload.style : {}),
    ...(payload.textProperties && typeof payload.textProperties === 'object' ? payload.textProperties : {}),
  }

  for (const key of TEXT_STYLE_KEYS) {
    if (hasOwn(payload, key)) source[key] = payload[key]
  }
  if (hasOwn(payload, 'color')) source.textColor = payload.color
  if (hasOwn(payload, 'fill')) source.textColor = payload.fill
  if (hasOwn(payload, 'background')) source.backgroundColor = payload.background

  const updates = {}
  if (hasOwn(source, 'text')) updates.text = String(source.text || '').slice(0, 2000)
  if (hasOwn(source, 'fontFamily')) updates.fontFamily = String(source.fontFamily || 'Inter').slice(0, 120)
  if (hasOwn(source, 'fontWeight')) updates.fontWeight = String(source.fontWeight || 'bold').slice(0, 40)
  if (hasOwn(source, 'fontStyle')) updates.fontStyle = String(source.fontStyle || 'normal').slice(0, 40)
  if (hasOwn(source, 'textAlign')) {
    const value = String(source.textAlign || '').toLowerCase()
    if (['left', 'center', 'right'].includes(value)) updates.textAlign = value
  }
  if (hasOwn(source, 'verticalAlign')) {
    const value = String(source.verticalAlign || '').toLowerCase()
    if (['top', 'center', 'bottom'].includes(value)) updates.verticalAlign = value
  }

  const numberFields = {
    fontSize: [64, 8, 300],
    backgroundOpacity: [0, 0, 100],
    backgroundPadding: [20, 0, 300],
    strokeWidth: [0, 0, 50],
    letterSpacing: [0, -50, 200],
    lineHeight: [1.2, 0.5, 4],
    shadowBlur: [4, 0, 200],
    shadowOffsetX: [2, -500, 500],
    shadowOffsetY: [2, -500, 500],
  }
  for (const [key, [fallback, min, max]] of Object.entries(numberFields)) {
    if (hasOwn(source, key)) updates[key] = clampNumber(source[key], fallback, min, max)
  }

  if (hasOwn(source, 'shadow')) updates.shadow = source.shadow === true
  if (hasOwn(source, 'textColor')) {
    const color = normalizeHexColor(source.textColor)
    if (!color) throw new Error('Invalid text color. Use a hex color like #ffffff.')
    updates.textColor = color
  }
  if (hasOwn(source, 'strokeColor')) {
    const color = normalizeHexColor(source.strokeColor)
    if (!color) throw new Error('Invalid stroke color. Use a hex color like #000000.')
    updates.strokeColor = color
  }
  if (hasOwn(source, 'shadowColor')) {
    updates.shadowColor = String(source.shadowColor || 'rgba(0,0,0,0.5)').slice(0, 120)
  }
  if (hasOwn(source, 'backgroundColor')) {
    const color = normalizeHexColor(source.backgroundColor, { allowTransparent: true })
    if (!color) throw new Error('Invalid background color. Use #000000 or transparent.')
    updates.backgroundColor = color
  }

  return updates
}

function normalizeTransformUpdates(payload = {}) {
  const source = {
    ...(payload.transform && typeof payload.transform === 'object' ? payload.transform : {}),
    ...(payload.crop && typeof payload.crop === 'object' ? payload.crop : {}),
  }
  const deltaSource = {
    ...(payload.transformDelta && typeof payload.transformDelta === 'object' ? payload.transformDelta : {}),
    ...(payload.deltaTransform && typeof payload.deltaTransform === 'object' ? payload.deltaTransform : {}),
  }

  for (const key of TEXT_TRANSFORM_KEYS) {
    if (hasOwn(payload, key)) source[key] = payload[key]
  }
  if (hasOwn(payload, 'x')) source.positionX = payload.x
  if (hasOwn(payload, 'y')) source.positionY = payload.y
  if (hasOwn(payload, 'moveX')) deltaSource.positionX = payload.moveX
  if (hasOwn(payload, 'moveY')) deltaSource.positionY = payload.moveY
  if (hasOwn(payload, 'rotateBy')) deltaSource.rotation = payload.rotateBy

  const updates = {}
  const deltas = {}
  for (const [key, [fallback, min, max]] of Object.entries(TEXT_TRANSFORM_NUMBER_FIELDS)) {
    if (hasOwn(source, key)) updates[key] = clampNumber(source[key], fallback, min, max)
    if (hasOwn(deltaSource, key)) deltas[key] = clampNumber(deltaSource[key], 0, -20000, 20000)
  }
  for (const key of ['scaleLinked', 'flipH', 'flipV']) {
    if (hasOwn(source, key)) updates[key] = source[key] === true
  }

  return { updates, deltas }
}

function buildTextClipSummary(clip) {
  if (!clip) return null
  return {
    ...summarizeClip(clip),
    enabled: clip.enabled !== false,
    textProperties: clip.textProperties || {},
    transform: clip.transform || {},
    titleAnimation: clip.titleAnimation || null,
    keyframes: clip.keyframes || {},
  }
}

function getTextClipById(state, clipId) {
  const id = String(clipId || '').trim()
  if (!id) throw new Error('No text clip ID provided.')
  const clip = (state.clips || []).find((candidate) => candidate.id === id)
  if (!clip) throw new Error(`Text clip ${id} was not found.`)
  if (clip.type !== 'text') throw new Error(`Clip ${id} is a ${clip.type || 'unknown'} clip, not a text clip.`)
  return clip
}

function findDefaultTextTrack(state, requestedTrackId = '') {
  const trackId = String(requestedTrackId || '').trim()
  const tracks = Array.isArray(state.tracks) ? state.tracks : []
  if (trackId) {
    const track = tracks.find((candidate) => candidate.id === trackId)
    if (!track || track.type !== 'video') throw new Error(`Track ${trackId} is not a video track.`)
    if (track.locked) throw new Error(`Track ${trackId} is locked.`)
    return track
  }
  const track = tracks.find((candidate) => candidate.type === 'video' && candidate.locked !== true)
  if (!track) throw new Error('No unlocked video track is available for a text clip.')
  return track
}

function normalizeTextKeyframes(payload = {}) {
  const rawKeyframes = Array.isArray(payload.keyframes) ? payload.keyframes : []
  return rawKeyframes.map((entry) => {
    const property = String(entry?.property || '').trim()
    if (!TEXT_KEYFRAME_PROPERTIES.has(property)) {
      throw new Error(`Unsupported text keyframe property "${property}".`)
    }
    const timeSeconds = Number(entry?.timeSeconds ?? entry?.time)
    let value = entry?.value
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0) {
      throw new Error(`Invalid keyframe time for ${property}.`)
    }
    if (property === 'textColor') {
      value = normalizeHexColor(value)
      if (!value) {
        throw new Error('Invalid textColor keyframe value. Use a hex color like #ffffff.')
      }
    } else {
      value = Number(value)
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid keyframe value for ${property}.`)
      }
    }
    return {
      property,
      timeSeconds,
      value,
      easing: String(entry?.easing || 'easeInOut').slice(0, 120),
    }
  })
}

function resolveNextTransform(currentTransform = {}, transformUpdates = {}, transformDeltas = {}) {
  const next = { ...(currentTransform || {}) }
  for (const [key, value] of Object.entries(transformUpdates || {})) {
    next[key] = value
  }
  for (const [key, value] of Object.entries(transformDeltas || {})) {
    const [, min = -20000, max = 20000] = TEXT_TRANSFORM_NUMBER_FIELDS[key] || []
    next[key] = clampNumber((Number(next[key]) || 0) + value, Number(next[key]) || 0, min, max)
  }
  return next
}

function clearTextKeyframes(clipId, clearKeyframes) {
  if (!clearKeyframes) return []
  const requested = clearKeyframes === true || clearKeyframes === 'all'
    ? [...TEXT_KEYFRAME_PROPERTIES]
    : Array.isArray(clearKeyframes)
      ? clearKeyframes.map((item) => String(item || '').trim()).filter(Boolean)
      : []
  const properties = requested.filter((property) => TEXT_KEYFRAME_PROPERTIES.has(property))
  if (properties.length === 0) return []

  useTimelineStore.setState((currentState) => ({
    clips: (currentState.clips || []).map((clip) => {
      if (clip.id !== clipId || clip.type !== 'text') return clip
      const nextKeyframes = { ...(clip.keyframes || {}) }
      for (const property of properties) {
        delete nextKeyframes[property]
      }
      return { ...clip, keyframes: nextKeyframes }
    }),
  }))
  return properties
}

function applyTextKeyframes(state, clipId, keyframes = [], replaceKeyframes = false) {
  if (keyframes.length === 0) return []
  const replaceProperties = replaceKeyframes
    ? [...new Set(keyframes.map((keyframe) => keyframe.property))]
    : []
  if (replaceProperties.length > 0) {
    clearTextKeyframes(clipId, replaceProperties)
  }
  for (const keyframe of keyframes) {
    state.setKeyframe?.(clipId, keyframe.property, keyframe.timeSeconds, keyframe.value, keyframe.easing, { saveHistory: false })
  }
  return keyframes
}

function getUpdatedTextClip(clipId) {
  return (useTimelineStore.getState().clips || []).find((clip) => clip.id === clipId) || null
}

function handleSetClipLabelColor(payload = {}) {
  const rawColor = String(payload.color || '').trim()
  const color = normalizeClipLabelColor(rawColor)
  if (rawColor && !color) {
    throw new Error('Invalid label color. Use a hex color like #f97316, or an empty string to clear labels.')
  }

  const clipIds = Array.isArray(payload.clipIds)
    ? [...new Set(payload.clipIds.map((clipId) => String(clipId || '').trim()).filter(Boolean))]
    : []
  if (clipIds.length === 0) {
    throw new Error('No clip IDs provided.')
  }

  const state = useTimelineStore.getState()
  const clipsById = new Map((state.clips || []).map((clip) => [clip.id, clip]))
  const targetClips = clipIds.map((clipId) => clipsById.get(clipId)).filter(Boolean)
  const foundIds = new Set(targetClips.map((clip) => clip.id))
  const missingClipIds = clipIds.filter((clipId) => !foundIds.has(clipId))

  if (targetClips.length === 0) {
    throw new Error('No matching clips found.')
  }

  state.setClipLabelColor(targetClips.map((clip) => clip.id), color)

  return {
    color,
    cleared: !color,
    clipCount: targetClips.length,
    missingClipIds,
    clips: targetClips.map(summarizeClip),
  }
}

function handleSetClipsEnabled(payload = {}) {
  if (typeof payload.enabled !== 'boolean') {
    throw new Error('Provide enabled=true or enabled=false.')
  }

  const clipIds = Array.isArray(payload.clipIds)
    ? [...new Set(payload.clipIds.map((clipId) => String(clipId || '').trim()).filter(Boolean))]
    : []
  if (clipIds.length === 0) {
    throw new Error('No clip IDs provided.')
  }

  const state = useTimelineStore.getState()
  const clipsById = new Map((state.clips || []).map((clip) => [clip.id, clip]))
  const targetClips = clipIds.map((clipId) => clipsById.get(clipId)).filter(Boolean)
  const foundIds = new Set(targetClips.map((clip) => clip.id))
  const missingClipIds = clipIds.filter((clipId) => !foundIds.has(clipId))

  if (targetClips.length === 0) {
    throw new Error('No matching clips found.')
  }

  state.setClipsEnabled(targetClips.map((clip) => clip.id), payload.enabled)

  return {
    enabled: payload.enabled,
    clipCount: targetClips.length,
    missingClipIds,
    clips: targetClips.map((clip) => ({
      ...summarizeClip(clip),
      wasEnabled: clip.enabled !== false,
      nextEnabled: payload.enabled,
    })),
  }
}

function handleAddTimelineMarkers(payload = {}) {
  const rawMarkers = Array.isArray(payload.markers) ? payload.markers : []
  if (rawMarkers.length === 0) {
    throw new Error('No markers provided.')
  }

  const state = useTimelineStore.getState()
  const fps = Number(state.timelineFps) || 24
  const duration = Math.max(0, Number(state.duration) || 0)
  const markerCounter = Math.max(1, Number(state.markerCounter) || 1)
  const markers = rawMarkers.map((entry, index) => {
    const timeSeconds = Number(entry?.timeSeconds ?? entry?.time)
    const frame = Number(entry?.frame)
    const rawTime = Number.isFinite(timeSeconds)
      ? timeSeconds
      : Number.isFinite(frame)
        ? frame / fps
        : Number(state.playheadPosition) || 0
    const markerTime = roundToTimelineFrame(Math.max(0, Math.min(duration, rawTime)), fps)
    return {
      id: `marker-${markerCounter + index}`,
      time: markerTime,
      label: String(entry?.label || entry?.name || '').trim().slice(0, 160),
      color: normalizeMarkerColor(entry?.color),
    }
  })

  if (markers.length === 0) {
    throw new Error('No valid markers provided.')
  }

  state.saveToHistory?.()
  useTimelineStore.setState((currentState) => ({
    markers: [...(currentState.markers || []), ...markers].sort((a, b) => a.time - b.time),
    markerCounter: markerCounter + markers.length,
    selectedMarkerId: markers[markers.length - 1]?.id || currentState.selectedMarkerId,
    selectedClipIds: [],
    selectedTransitionId: null,
    selectedGap: null,
  }))

  return {
    markerCount: markers.length,
    markers: markers.map(summarizeMarker),
  }
}

function handleRemoveTimelineMarkers(payload = {}) {
  const markerIds = Array.isArray(payload.markerIds)
    ? [...new Set(payload.markerIds.map((markerId) => String(markerId || '').trim()).filter(Boolean))]
    : []

  const state = useTimelineStore.getState()
  const markers = state.markers || []
  let targetMarkers = []

  if (payload.all === true) {
    targetMarkers = markers
  } else if (markerIds.length > 0) {
    const markerIdsSet = new Set(markerIds)
    targetMarkers = markers.filter((marker) => markerIdsSet.has(marker.id))
  }

  if (targetMarkers.length === 0) {
    return {
      markerCount: 0,
      removedMarkerIds: [],
      missingMarkerIds: markerIds.filter((markerId) => !markers.some((marker) => marker.id === markerId)),
      markers: [],
    }
  }

  const targetIds = new Set(targetMarkers.map((marker) => marker.id))
  state.saveToHistory?.()
  useTimelineStore.setState((currentState) => ({
    markers: (currentState.markers || []).filter((marker) => !targetIds.has(marker.id)),
    selectedMarkerId: targetIds.has(currentState.selectedMarkerId) ? null : currentState.selectedMarkerId,
  }))

  return {
    markerCount: targetMarkers.length,
    removedMarkerIds: [...targetIds],
    missingMarkerIds: markerIds.filter((markerId) => !markers.some((marker) => marker.id === markerId)),
    markers: targetMarkers.map(summarizeMarker),
  }
}

function handleSetTimelineMarkerProperties(payload = {}) {
  const updates = Array.isArray(payload.updates) ? payload.updates : []
  if (updates.length === 0) {
    throw new Error('No marker updates provided.')
  }

  const state = useTimelineStore.getState()
  const markers = state.markers || []
  const markersById = new Map(markers.map((marker) => [marker.id, marker]))
  const fps = Number(state.timelineFps) || 24
  const duration = Math.max(0, Number(state.duration) || 0)
  const normalizedUpdates = []
  const missingMarkerIds = []

  for (const entry of updates) {
    const id = String(entry?.id || '').trim()
    if (!id) continue
    const current = markersById.get(id)
    if (!current) {
      missingMarkerIds.push(id)
      continue
    }

    const rawTime = Number(entry?.timeSeconds ?? entry?.time)
    const frame = Number(entry?.frame)
    const nextTime = Number.isFinite(rawTime)
      ? rawTime
      : Number.isFinite(frame)
        ? frame / fps
        : Number(current.time) || 0
    normalizedUpdates.push({
      id,
      time: roundToTimelineFrame(Math.max(0, Math.min(duration, nextTime)), fps),
      label: Object.prototype.hasOwnProperty.call(entry, 'label')
        ? String(entry.label || '').trim().slice(0, 160)
        : (current.label || ''),
      color: Object.prototype.hasOwnProperty.call(entry, 'color')
        ? normalizeOptionalMarkerColor(entry.color)
        : (current.color || ''),
    })
  }

  if (normalizedUpdates.length === 0) {
    return {
      markerCount: 0,
      missingMarkerIds,
      markers: [],
    }
  }

  const updatesById = new Map(normalizedUpdates.map((entry) => [entry.id, entry]))
  state.saveToHistory?.()
  useTimelineStore.setState((currentState) => ({
    markers: (currentState.markers || [])
      .map((marker) => {
        const update = updatesById.get(marker.id)
        return update ? { ...marker, ...update } : marker
      })
      .sort((a, b) => a.time - b.time),
  }))

  return {
    markerCount: normalizedUpdates.length,
    missingMarkerIds,
    markers: normalizedUpdates.map(summarizeMarker),
  }
}

function handleAddTrack(payload = {}) {
  const state = useTimelineStore.getState()
  const type = normalizeTrackType(payload.type || payload.trackType)
  const options = {}
  const name = String(payload.name || '').trim().slice(0, 80)
  if (name) options.name = name
  if (type === 'audio') options.channels = normalizeAudioChannels(payload.channels)

  state.saveToHistory?.()
  const track = state.addTrack?.(type, options)
  if (!track) throw new Error('Could not create track.')

  const nextState = useTimelineStore.getState()
  return {
    created: true,
    track: summarizeTrack(track),
    trackCount: (nextState.tracks || []).length,
    videoTrackCount: (nextState.tracks || []).filter((candidate) => candidate.type === 'video').length,
    audioTrackCount: (nextState.tracks || []).filter((candidate) => candidate.type === 'audio').length,
  }
}

function handleDuplicateClip(payload = {}) {
  const state = useTimelineStore.getState()
  const clipId = String(payload.clipId || '').trim()
  if (!clipId) throw new Error('Provide clipId for the clip to duplicate.')

  const sourceClip = (state.clips || []).find((clip) => clip.id === clipId)
  if (!sourceClip) throw new Error(`Clip ${clipId} was not found.`)

  const targetTrackId = String(payload.trackId || '').trim() || sourceClip.trackId
  const targetTrack = (state.tracks || []).find((track) => track.id === targetTrackId)
  if (!targetTrack) throw new Error(`Track ${targetTrackId} was not found.`)
  if (targetTrack.locked) throw new Error(`Track ${targetTrackId} is locked.`)

  const sourceTrack = (state.tracks || []).find((track) => track.id === sourceClip.trackId)
  const sourceTrackType = sourceTrack?.type || (sourceClip.type === 'audio' ? 'audio' : 'video')
  const clipNeedsVideoTrack = ['video', 'image', 'text', 'adjustment', 'caption', 'captions'].includes(sourceClip.type)
  const clipNeedsAudioTrack = sourceClip.type === 'audio'
  if (clipNeedsVideoTrack && targetTrack.type !== 'video') {
    throw new Error(`Clip ${clipId} is a ${sourceClip.type} clip and must be duplicated onto a video track.`)
  }
  if (clipNeedsAudioTrack && targetTrack.type !== 'audio') {
    throw new Error(`Clip ${clipId} is an audio clip and must be duplicated onto an audio track.`)
  }
  if (!clipNeedsVideoTrack && !clipNeedsAudioTrack && targetTrack.type !== sourceTrackType) {
    throw new Error(`Clip ${clipId} must be duplicated onto a ${sourceTrackType} track.`)
  }

  const fps = Number(state.timelineFps) || 24
  const requestedStart = Number(payload.startSeconds ?? payload.startTime)
  const startTime = roundToTimelineFrame(
    Number.isFinite(requestedStart)
      ? requestedStart
      : (Number(sourceClip.startTime) || 0) + (Number(sourceClip.duration) || 0) + 0.1,
    fps
  )
  const duration = Math.max(1 / fps, Number(sourceClip.duration) || (1 / fps))
  const nextCounter = getNextMcpClipCounter(state.clips, state.clipCounter)
  const nextName = String(payload.name || '').trim()
  const preserveLinkGroup = payload.preserveLinkGroup === true
  const preserveSyncLock = payload.preserveSyncLock === true
  const duplicate = {
    ...safeClone(sourceClip),
    id: `clip-${nextCounter}`,
    trackId: targetTrack.id,
    startTime,
    duration,
    name: nextName || sourceClip.name,
    selected: false,
    cacheStatus: 'none',
    cacheProgress: 0,
    cacheUrl: null,
    cachePath: null,
    ...(preserveLinkGroup ? {} : { linkGroupId: undefined }),
    ...(preserveSyncLock ? {} : { lockMode: undefined, syncLock: undefined }),
    metadata: {
      ...(safeClone(sourceClip.metadata) || {}),
      duplicatedFromClipId: sourceClip.id,
      duplicatedAt: new Date().toISOString(),
      duplicatedBy: 'mcp',
    },
  }

  if (duplicate.type === 'text' && nextName && duplicate.textProperties?.text) {
    duplicate.name = nextName
  }

  const preview = {
    source: buildTextClipSummary(sourceClip) || summarizeClip(sourceClip),
    duplicate: buildTextClipSummary(duplicate) || summarizeClip(duplicate),
    targetTrack: summarizeTrack(targetTrack),
    preserveLinkGroup,
    preserveSyncLock,
  }

  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      action: 'duplicate_clip',
      message: 'Clip duplicate plan only. No timeline change was made.',
      plan: preview,
    }
  }

  state.saveToHistory?.()
  useTimelineStore.setState((currentState) => {
    const nextClips = [...(currentState.clips || []), duplicate]
    const maxEnd = nextClips.reduce((max, clip) => Math.max(max, (Number(clip.startTime) || 0) + (Number(clip.duration) || 0)), 0)
    return {
      clips: nextClips,
      clipCounter: Math.max(Number(currentState.clipCounter) || 1, nextCounter + 1),
      selectedClipIds: [duplicate.id],
      selectedTransitionId: null,
      selectedMarkerId: null,
      selectedGap: null,
      duration: Math.max(Number(currentState.duration) || 0, maxEnd + 10),
    }
  })

  const createdClip = (useTimelineStore.getState().clips || []).find((clip) => clip.id === duplicate.id) || duplicate
  return {
    created: true,
    action: 'duplicate_clip',
    sourceClipId: sourceClip.id,
    clip: buildTextClipSummary(createdClip) || summarizeClip(createdClip),
    targetTrack: summarizeTrack(targetTrack),
    preserveLinkGroup,
    preserveSyncLock,
  }
}

function handleAddTextClip(payload = {}) {
  const state = useTimelineStore.getState()
  const track = findDefaultTextTrack(state, payload.trackId)
  const textUpdates = normalizeTextStyleUpdates({ ...payload, text: payload.text ?? payload.content ?? 'Text' })
  const { updates: transformUpdates, deltas: transformDeltas } = normalizeTransformUpdates(payload)
  const keyframes = normalizeTextKeyframes(payload)
  const startSeconds = Number(payload.startSeconds ?? payload.startTime)
  const startTime = Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : Number(state.playheadPosition) || 0
  const duration = clampNumber(payload.durationSeconds ?? payload.duration, 5, 1 / (Number(state.timelineFps) || 24), 3600)

  const newClip = state.addTextClip?.(track.id, {
    ...textUpdates,
    duration,
    enabled: payload.enabled !== false,
  }, startTime)
  if (!newClip) throw new Error('Could not create text clip.')

  const nextTransform = resolveNextTransform(newClip.transform || {}, transformUpdates, transformDeltas)
  if (Object.keys(transformUpdates).length > 0 || Object.keys(transformDeltas).length > 0) {
    useTimelineStore.getState().updateClipTransform?.(newClip.id, nextTransform, false)
  }

  const presetId = String(payload.animationPreset || payload.presetId || '').trim()
  if (presetId && presetId !== 'none') {
    useTimelineStore.getState().applyTextAnimationPreset?.(newClip.id, presetId, payload.animationMode || payload.mode || 'inOut', { saveHistory: false })
  }
  const appliedKeyframes = applyTextKeyframes(useTimelineStore.getState(), newClip.id, keyframes, payload.replaceKeyframes === true)

  return {
    created: true,
    clip: buildTextClipSummary(getUpdatedTextClip(newClip.id)),
    track: { id: track.id, name: track.name, type: track.type },
    appliedKeyframes,
  }
}

function handleUpdateTextClip(payload = {}) {
  const state = useTimelineStore.getState()
  const currentClip = getTextClipById(state, payload.clipId)
  const textUpdates = normalizeTextStyleUpdates(payload)
  const { updates: transformUpdates, deltas: transformDeltas } = normalizeTransformUpdates(payload)
  const keyframes = normalizeTextKeyframes(payload)
  const clearKeyframes = payload.clearKeyframes || payload.clearKeyframesForProperties
  const presetId = String(payload.animationPreset || payload.presetId || '').trim()
  const clearAnimationPreset = payload.clearAnimationPreset === true || presetId === 'none'

  const hasStart = hasOwn(payload, 'startSeconds') || hasOwn(payload, 'startTime')
  const hasDuration = hasOwn(payload, 'durationSeconds') || hasOwn(payload, 'duration')
  const nextTrack = hasOwn(payload, 'trackId') ? findDefaultTextTrack(state, payload.trackId) : null
  const nextStart = hasStart
    ? Math.max(0, Number(payload.startSeconds ?? payload.startTime) || 0)
    : currentClip.startTime
  const nextDuration = hasDuration
    ? clampNumber(payload.durationSeconds ?? payload.duration, currentClip.duration || 5, 1 / (Number(state.timelineFps) || 24), 3600)
    : currentClip.duration
  const nextTransform = resolveNextTransform(currentClip.transform || {}, transformUpdates, transformDeltas)
  const nextClipPreview = {
    ...currentClip,
    trackId: nextTrack?.id || currentClip.trackId,
    startTime: nextStart,
    duration: nextDuration,
    textProperties: { ...(currentClip.textProperties || {}), ...textUpdates },
    transform: nextTransform,
  }

  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      clipId: currentClip.id,
      before: buildTextClipSummary(currentClip),
      after: buildTextClipSummary(nextClipPreview),
      requested: {
        textUpdates,
        transformUpdates,
        transformDeltas,
        keyframes,
        clearKeyframes,
        animationPreset: presetId || null,
        clearAnimationPreset,
      },
    }
  }

  state.saveToHistory?.()
  if (nextTrack || hasStart) {
    useTimelineStore.getState().moveClip?.(currentClip.id, nextTrack?.id || currentClip.trackId, nextStart, false)
  }
  if (hasDuration) {
    useTimelineStore.getState().resizeClip?.(currentClip.id, nextDuration)
  }
  if (Object.keys(textUpdates).length > 0) {
    useTimelineStore.getState().updateTextProperties?.(currentClip.id, textUpdates, false)
  }
  if (Object.keys(transformUpdates).length > 0 || Object.keys(transformDeltas).length > 0) {
    useTimelineStore.getState().updateClipTransform?.(currentClip.id, nextTransform, false)
  }
  const clearedKeyframes = clearTextKeyframes(currentClip.id, clearKeyframes)
  if (clearAnimationPreset) {
    useTimelineStore.getState().clearTextAnimationPreset?.(currentClip.id, { saveHistory: false })
  }
  if (presetId && !clearAnimationPreset) {
    useTimelineStore.getState().applyTextAnimationPreset?.(currentClip.id, presetId, payload.animationMode || payload.mode || 'inOut', { saveHistory: false })
  }
  const appliedKeyframes = applyTextKeyframes(useTimelineStore.getState(), currentClip.id, keyframes, payload.replaceKeyframes === true)

  return {
    updated: true,
    clip: buildTextClipSummary(getUpdatedTextClip(currentClip.id)),
    requested: {
      textUpdates,
      transformUpdates,
      transformDeltas,
      clearedKeyframes,
      appliedKeyframes,
      animationPreset: presetId || null,
      clearAnimationPreset,
    },
  }
}

async function handleExportTimeline(payload = {}) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.runExportInWorker || !api?.pathJoin || !api?.createDirectory) {
    throw new Error('Timeline export is only available in the desktop app.')
  }

  const projectState = useProjectStore.getState()
  const timelineState = useTimelineStore.getState()
  const assetsState = useAssetsStore.getState()
  const projectPath = projectState.currentProjectHandle
  if (typeof projectPath !== 'string' || !projectPath) {
    throw new Error('Open a saved project before exporting.')
  }

  const project = projectState.currentProject || {}
  const timelineSettings = typeof projectState.getCurrentTimelineSettings === 'function'
    ? projectState.getCurrentTimelineSettings()
    : (project.settings || {})
  const timelineWidth = makeEvenDimension(timelineSettings?.width || payload.sourceTimelineWidth || payload.width || 1920)
  const timelineHeight = makeEvenDimension(timelineSettings?.height || payload.sourceTimelineHeight || payload.height || 1080)
  const fps = Math.max(1, Number(payload.fps || timelineSettings?.fps || timelineState.timelineFps || 24))
  const timelineEnd = typeof timelineState.getTimelineEndTime === 'function'
    ? timelineState.getTimelineEndTime()
    : Math.max(0, ...(timelineState.clips || []).map((clip) => (Number(clip.startTime) || 0) + (Number(clip.duration) || 0)))
  const rangeStart = Math.max(0, Number(payload.rangeStart) || 0)
  const rangeEnd = Math.max(rangeStart, Number(payload.rangeEnd) || timelineEnd)
  if (rangeEnd <= rangeStart) {
    throw new Error('Export range is empty.')
  }

  const format = String(payload.format || 'mp4').toLowerCase() === 'mp4' ? 'mp4' : 'mp4'
  const videoCodec = String(payload.videoCodec || 'h264').toLowerCase() === 'h265' ? 'h265' : 'h264'
  const outputExtension = 'mp4'
  const filename = sanitizeExportBaseName(payload.filename || `${project.name || 'ComfyStudio'}_export`)
  const outputFolder = await api.pathJoin(projectPath, 'renders')
  await api.createDirectory(outputFolder)
  const defaultOutputPath = await api.pathJoin(outputFolder, `${filename}_${Date.now()}.${outputExtension}`)
  const outputPath = String(payload.outputPath || '').trim() || defaultOutputPath

  const options = {
    filename,
    format,
    videoCodec,
    audioCodec: String(payload.audioCodec || 'aac').toLowerCase() || 'aac',
    proresProfile: '3',
    useHardwareEncoder: payload.useHardwareEncoder === true,
    nvencPreset: String(payload.nvencPreset || 'p5'),
    preset: String(payload.preset || 'medium'),
    qualityMode: String(payload.qualityMode || 'crf').toLowerCase() === 'bitrate' ? 'bitrate' : 'crf',
    crf: Number.isFinite(Number(payload.crf)) ? Number(payload.crf) : 18,
    bitrateKbps: Number.isFinite(Number(payload.bitrateKbps)) ? Number(payload.bitrateKbps) : 8000,
    keyframeInterval: null,
    width: makeEvenDimension(payload.width || 1920),
    height: makeEvenDimension(payload.height || 1080),
    sourceTimelineWidth: timelineWidth,
    sourceTimelineHeight: timelineHeight,
    fps,
    rangeStart,
    rangeEnd,
    includeAudio: payload.includeAudio !== false,
    audioBitrateKbps: Number.isFinite(Number(payload.audioBitrateKbps)) ? Number(payload.audioBitrateKbps) : 192,
    audioSampleRate: Number.isFinite(Number(payload.audioSampleRate)) ? Number(payload.audioSampleRate) : 44100,
    audioChannels: Number.isFinite(Number(payload.audioChannels)) ? Number(payload.audioChannels) : 2,
    normalizeAudio: payload.includeAudio !== false && payload.normalizeAudio === true,
    loudnessTarget: Number.isFinite(Number(payload.loudnessTarget)) ? Number(payload.loudnessTarget) : -14,
    useCachedRenders: false,
    useProxyMedia: payload.useProxyMedia === true,
    fastSeek: false,
    useDirectFramePipe: payload.useDirectFramePipe !== false,
    deliveryFraming: ['fill', 'cover', 'center_crop', 'center-crop'].includes(String(payload.deliveryFraming || payload.framing || '').toLowerCase())
      ? 'fill'
      : 'fit',
    outputPath,
  }

  const assets = Array.isArray(assetsState.assets) ? assetsState.assets : []
  const result = await api.runExportInWorker({
    projectPath,
    outputPath,
    options,
    state: {
      timeline: {
        clips: timelineState.clips || [],
        tracks: timelineState.tracks || [],
        transitions: timelineState.transitions || [],
      },
      assets: assets.map((asset) => ({
        id: asset.id,
        path: asset.path,
        type: asset.type,
        name: asset.name,
        isImported: asset.isImported,
        settings: asset.settings,
        duration: asset.duration,
        proxyPath: asset.proxyPath,
        proxyStatus: asset.proxyStatus,
        maskFrames: asset.maskFrames?.map((frame) => ({ ...frame, url: undefined })),
      })),
    },
  })

  if (result?.success === false || result?.error) {
    throw new Error(result.error || 'Export failed to start.')
  }

  return {
    started: true,
    outputPath,
    options: {
      filename,
      format,
      videoCodec,
      audioCodec: options.audioCodec,
      width: options.width,
      height: options.height,
      fps: options.fps,
      rangeStart,
      rangeEnd,
      includeAudio: options.includeAudio,
      useHardwareEncoder: options.useHardwareEncoder,
      useProxyMedia: options.useProxyMedia,
      deliveryFraming: options.deliveryFraming,
      crf: options.crf,
      qualityMode: options.qualityMode,
    },
    worker: result,
  }
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function getNumberPayloadValue(payload, key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(payload?.[key])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

async function handleInspectTimelineFrame(payload = {}) {
  const state = useTimelineStore.getState()
  const requestedTime = Number(payload.timeSeconds)
  const timeSeconds = Number.isFinite(requestedTime)
    ? requestedTime
    : Number(state.playheadPosition) || 0
  const includeImage = payload.includeImage !== false
  const maxImageBytes = getNumberPayloadValue(payload, 'maxImageBytes', 4 * 1024 * 1024, 1, 12 * 1024 * 1024)
  const maxWidth = getNumberPayloadValue(payload, 'maxWidth', 1280, 16, 3840)
  const maxHeight = getNumberPayloadValue(payload, 'maxHeight', 720, 16, 2160)
  const requestedMimeType = String(payload.mimeType || 'image/jpeg').toLowerCase()
  const mimeType = requestedMimeType === 'image/png' || requestedMimeType === 'image/webp'
    ? requestedMimeType
    : 'image/jpeg'
  const quality = getNumberPayloadValue(payload, 'quality', 0.86, 0.1, 1)

  const captured = await captureTimelineFrameAt(timeSeconds, {
    maxWidth,
    maxHeight,
    mimeType,
    quality,
    createBlobUrl: false,
  })

  if (!captured?.file) {
    return {
      success: false,
      timeSeconds,
      warning: 'No visual timeline frame could be captured at this time.',
    }
  }

  if (!includeImage) {
    return {
      success: true,
      timeSeconds,
      width: captured.width,
      height: captured.height,
      mimeType: captured.mimeType || captured.file.type || mimeType,
      size: captured.file.size,
      image: null,
    }
  }

  if (captured.file.size > maxImageBytes) {
    return {
      success: false,
      timeSeconds,
      width: captured.width,
      height: captured.height,
      mimeType: captured.mimeType || captured.file.type || mimeType,
      size: captured.file.size,
      warning: `Captured frame is ${captured.file.size} bytes, above the ${maxImageBytes} byte MCP embed limit.`,
    }
  }

  return {
    success: true,
    timeSeconds,
    width: captured.width,
    height: captured.height,
    mimeType: captured.mimeType || captured.file.type || mimeType,
    size: captured.file.size,
    image: {
      type: 'image',
      data: await blobToBase64(captured.file),
      mimeType: captured.mimeType || captured.file.type || mimeType,
    },
  }
}

async function canvasToBlob(canvas, mimeType = 'image/jpeg', quality = 0.84) {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), mimeType, quality))
}

async function blobToImageBitmap(blob) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob)
  }

  const objectUrl = URL.createObjectURL(blob)
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = reject
      img.src = objectUrl
    })
    return image
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

async function createRangeContactSheet(captures = [], options = {}) {
  const columns = Math.max(1, Math.min(4, Math.floor(Number(options.columns) || 3)))
  const cellWidth = Math.max(160, Math.min(960, Math.floor(Number(options.cellWidth) || 480)))
  const cellHeight = Math.max(90, Math.min(540, Math.floor(Number(options.cellHeight) || 270)))
  const labelHeight = 30
  const rows = Math.max(1, Math.ceil(Math.max(1, captures.length) / columns))
  const width = columns * cellWidth
  const height = rows * (cellHeight + labelHeight)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return null

  ctx.fillStyle = '#070709'
  ctx.fillRect(0, 0, width, height)
  ctx.font = '12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.textBaseline = 'middle'

  for (let index = 0; index < captures.length; index += 1) {
    const item = captures[index]
    const column = index % columns
    const row = Math.floor(index / columns)
    const x = column * cellWidth
    const y = row * (cellHeight + labelHeight)
    const label = item?.label || `Sample ${index + 1}`

    ctx.fillStyle = '#101014'
    ctx.fillRect(x, y, cellWidth, cellHeight + labelHeight)
    ctx.strokeStyle = '#2a2d36'
    ctx.strokeRect(x + 0.5, y + 0.5, cellWidth - 1, cellHeight + labelHeight - 1)

    if (item?.file) {
      try {
        const bitmap = await blobToImageBitmap(item.file)
        const sourceWidth = bitmap.width || item.width || cellWidth
        const sourceHeight = bitmap.height || item.height || cellHeight
        const scale = Math.min(cellWidth / sourceWidth, cellHeight / sourceHeight)
        const drawWidth = Math.max(1, Math.round(sourceWidth * scale))
        const drawHeight = Math.max(1, Math.round(sourceHeight * scale))
        const drawX = x + Math.round((cellWidth - drawWidth) / 2)
        const drawY = y + Math.round((cellHeight - drawHeight) / 2)
        ctx.drawImage(bitmap, drawX, drawY, drawWidth, drawHeight)
        bitmap.close?.()
      } catch (error) {
        ctx.fillStyle = '#19191f'
        ctx.fillRect(x, y, cellWidth, cellHeight)
        ctx.fillStyle = '#fca5a5'
        ctx.fillText('Frame capture failed', x + 12, y + Math.round(cellHeight / 2))
      }
    } else {
      ctx.fillStyle = '#19191f'
      ctx.fillRect(x, y, cellWidth, cellHeight)
      ctx.fillStyle = '#9ca3af'
      ctx.fillText(item?.warning || 'No visual frame', x + 12, y + Math.round(cellHeight / 2))
    }

    const labelY = y + cellHeight
    ctx.fillStyle = 'rgba(0, 0, 0, 0.82)'
    ctx.fillRect(x, labelY, cellWidth, labelHeight)
    ctx.fillStyle = '#f8fafc'
    ctx.fillText(label, x + 10, labelY + Math.round(labelHeight / 2))
  }

  const mimeType = String(options.mimeType || 'image/jpeg').toLowerCase() === 'image/png'
    ? 'image/png'
    : 'image/jpeg'
  const quality = getNumberPayloadValue(options, 'quality', 0.84, 0.1, 1)
  const blob = await canvasToBlob(canvas, mimeType, quality)
  if (!blob) return null
  return {
    file: new File([blob], `timeline_range_${Date.now()}.${mimeType === 'image/png' ? 'png' : 'jpg'}`, { type: mimeType }),
    width,
    height,
    mimeType,
  }
}

async function handleInspectTimelineRange(payload = {}) {
  const samples = Array.isArray(payload.samples) ? payload.samples : []
  const includeImage = payload.includeImage !== false
  const returnMode = String(payload.returnMode || 'contact_sheet').toLowerCase()
  const maxImageBytes = getNumberPayloadValue(payload, 'maxImageBytes', 6 * 1024 * 1024, 1, 16 * 1024 * 1024)
  const maxWidth = getNumberPayloadValue(payload, 'maxWidth', 640, 16, 1920)
  const maxHeight = getNumberPayloadValue(payload, 'maxHeight', 360, 16, 1080)
  const mimeType = String(payload.mimeType || 'image/jpeg').toLowerCase() === 'image/png'
    ? 'image/png'
    : 'image/jpeg'
  const quality = getNumberPayloadValue(payload, 'quality', 0.82, 0.1, 1)

  if (samples.length === 0) {
    return {
      success: false,
      warning: 'No range samples were provided.',
      samples: [],
    }
  }

  const captures = []
  for (const [index, sample] of samples.entries()) {
    const timeSeconds = Number(sample?.timeSeconds)
    const safeTimeSeconds = Number.isFinite(timeSeconds) ? timeSeconds : 0
    const captured = await captureTimelineFrameAt(safeTimeSeconds, {
      maxWidth,
      maxHeight,
      mimeType,
      quality,
      createBlobUrl: false,
    })

    captures.push({
      index,
      timeSeconds: safeTimeSeconds,
      timecode: sample?.timecode || '',
      label: sample?.label || `${index + 1}. ${sample?.timecode || `${safeTimeSeconds.toFixed(2)}s`}`,
      success: Boolean(captured?.file),
      file: captured?.file || null,
      width: captured?.width || null,
      height: captured?.height || null,
      mimeType: captured?.mimeType || mimeType,
      size: captured?.file?.size || 0,
      warning: captured?.file ? '' : 'No visual timeline frame could be captured at this time.',
    })
  }

  const resultSamples = captures.map((capture) => ({
    index: capture.index,
    timeSeconds: capture.timeSeconds,
    timecode: capture.timecode,
    label: capture.label,
    success: capture.success,
    width: capture.width,
    height: capture.height,
    mimeType: capture.mimeType,
    size: capture.size,
    warning: capture.warning,
  }))

  const result = {
    success: captures.some((capture) => capture.success),
    sampleCount: captures.length,
    capturedCount: captures.filter((capture) => capture.success).length,
    samples: resultSamples,
    contactSheet: null,
    frames: [],
  }

  if (!includeImage) return result

  if (returnMode !== 'frames') {
    const sheet = await createRangeContactSheet(captures, {
      columns: payload.columns,
      cellWidth: maxWidth,
      cellHeight: maxHeight,
      mimeType,
      quality,
    })
    if (sheet?.file) {
      if (sheet.file.size <= maxImageBytes) {
        result.contactSheet = {
          type: 'image',
          data: await blobToBase64(sheet.file),
          mimeType: sheet.mimeType,
          width: sheet.width,
          height: sheet.height,
          size: sheet.file.size,
        }
      } else {
        result.contactSheetWarning = `Contact sheet is ${sheet.file.size} bytes, above the ${maxImageBytes} byte MCP embed limit.`
      }
    }
  }

  if (returnMode === 'frames' || returnMode === 'both') {
    for (const capture of captures) {
      if (!capture.file || capture.file.size > maxImageBytes) continue
      result.frames.push({
        type: 'image',
        data: await blobToBase64(capture.file),
        mimeType: capture.mimeType,
        index: capture.index,
        timeSeconds: capture.timeSeconds,
        timecode: capture.timecode,
        width: capture.width,
        height: capture.height,
        size: capture.size,
      })
    }
  }

  return result
}

async function handleMcpAction(request = {}) {
  switch (request.action) {
    case 'set_clip_label_color':
      return handleSetClipLabelColor(request.payload || {})
    case 'set_clips_enabled':
      return handleSetClipsEnabled(request.payload || {})
    case 'inspect_timeline_frame':
      return handleInspectTimelineFrame(request.payload || {})
    case 'inspect_timeline_range':
      return handleInspectTimelineRange(request.payload || {})
    case 'add_timeline_markers':
      return handleAddTimelineMarkers(request.payload || {})
    case 'remove_timeline_markers':
      return handleRemoveTimelineMarkers(request.payload || {})
    case 'set_timeline_marker_properties':
      return handleSetTimelineMarkerProperties(request.payload || {})
    case 'add_track':
      return handleAddTrack(request.payload || {})
    case 'duplicate_clip':
      return handleDuplicateClip(request.payload || {})
    case 'add_text_clip':
      return handleAddTextClip(request.payload || {})
    case 'update_text_clip':
      return handleUpdateTextClip(request.payload || {})
    case 'export_timeline':
      return handleExportTimeline(request.payload || {})
    default:
      throw new Error(`Unknown MCP action: ${request.action || 'unknown'}`)
  }
}

export function startMcpActionBridge() {
  const api = typeof window !== 'undefined' ? window.electronAPI?.mcp : null
  if (!api?.onAction || !api?.sendActionResult) return () => {}

  return api.onAction(async (request = {}) => {
    try {
      const result = await handleMcpAction(request)
      api.sendActionResult({ id: request.id, success: true, result })
    } catch (error) {
      api.sendActionResult({
        id: request.id,
        success: false,
        error: error?.message || String(error),
      })
    }
  })
}
