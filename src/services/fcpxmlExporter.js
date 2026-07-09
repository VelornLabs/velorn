import { applySoloAsMute } from '../utils/audioTrackAudibility'

const FCPXML_VERSION = '1.10'
const DEFAULT_FPS = 24

const SUPPORTED_CLIP_TYPES = new Set(['video', 'audio', 'image'])

function safeNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function sanitizeName(value, fallback = 'Untitled') {
  const trimmed = String(value || '').trim()
  return trimmed || fallback
}

function sanitizeId(value, fallback) {
  const base = String(value || fallback || 'item').trim()
  return base.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^([^a-zA-Z_])/, '_$1') || fallback
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function normalizeFps(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FPS
}

function getTimebase(fpsValue) {
  const fps = normalizeFps(fpsValue)
  if (Math.abs(fps - 23.976) < 0.01) {
    return { fps, numerator: 1001, denominator: 24000, frameDuration: '1001/24000s' }
  }
  if (Math.abs(fps - 29.97) < 0.01) {
    return { fps, numerator: 1001, denominator: 30000, frameDuration: '1001/30000s' }
  }
  if (Math.abs(fps - 59.94) < 0.01) {
    return { fps, numerator: 1001, denominator: 60000, frameDuration: '1001/60000s' }
  }
  const rounded = Math.max(1, Math.round(fps))
  return { fps: rounded, numerator: 1, denominator: rounded, frameDuration: `1/${rounded}s` }
}

function secondsToFrames(seconds, timebase) {
  const safeSeconds = Math.max(0, safeNumber(seconds, 0))
  return Math.max(0, Math.round(safeSeconds * timebase.fps))
}

function formatFrames(frames, timebase) {
  const safeFrames = Math.max(0, Math.round(safeNumber(frames, 0)))
  if (safeFrames === 0) return '0s'
  const numerator = safeFrames * timebase.numerator
  const denominator = timebase.denominator
  if (numerator % denominator === 0) return `${numerator / denominator}s`
  return `${numerator}/${denominator}s`
}

function formatSeconds(seconds, timebase) {
  return formatFrames(secondsToFrames(seconds, timebase), timebase)
}

function filePathToFileUri(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/')
  if (!normalized) return ''
  const withLeadingSlash = /^[a-zA-Z]:\//.test(normalized) ? `/${normalized}` : normalized
  return `file://${encodeURI(withLeadingSlash).replace(/#/g, '%23')}`
}

function formatNumber(value, precision = 4) {
  const parsed = safeNumber(value, 0)
  const rounded = Math.round(parsed * (10 ** precision)) / (10 ** precision)
  return String(Object.is(rounded, -0) ? 0 : rounded)
}

function pixelsToFcpXmlPosition(value, sequenceHeight) {
  const height = safeNumber(sequenceHeight, 0)
  if (height <= 0) return safeNumber(value, 0)
  return (safeNumber(value, 0) * 100) / height
}

function getClipTimeScale(clip) {
  const sourceTimeScale = safeNumber(clip?.sourceTimeScale, 0)
  const fpsScale = clip?.timelineFps && clip?.sourceFps
    ? safeNumber(clip.timelineFps, 1) / safeNumber(clip.sourceFps, 1)
    : 1
  const speed = safeNumber(clip?.speed, 1)
  return Math.max(0.0001, (sourceTimeScale > 0 ? sourceTimeScale : fpsScale) * (speed > 0 ? speed : 1))
}

function getAssetMediaDuration(asset, clip, timebase) {
  if (asset?.type === 'image' || clip?.type === 'image') {
    return Math.max(secondsToFrames(clip?.duration || 5, timebase), 1)
  }
  const sourceDuration = safeNumber(clip?.sourceDuration, 0)
  const assetDuration = safeNumber(asset?.duration || asset?.settings?.duration, 0)
  const duration = sourceDuration > 0 ? sourceDuration : assetDuration
  return Math.max(secondsToFrames(duration || clip?.duration || 1, timebase), 1)
}

function getClipLane(clip, track, trackLaneMaps) {
  if (track?.type === 'audio') {
    return trackLaneMaps.audio.get(track.id) || -1
  }
  return trackLaneMaps.video.get(track?.id) || 1
}

function buildTrackLaneMaps(tracks = []) {
  const visibleVideoTracks = tracks.filter((track) => track?.type === 'video' && track.visible !== false)
  const audibleAudioTracks = tracks.filter((track) => track?.type === 'audio' && track.muted !== true)
  return {
    video: new Map(visibleVideoTracks.map((track, index) => [track.id, visibleVideoTracks.length - index])),
    audio: new Map(audibleAudioTracks.map((track, index) => [track.id, -(index + 1)])),
  }
}

function shouldExportClip(clip, track, asset) {
  if (!clip || clip.enabled === false) return false
  if (!SUPPORTED_CLIP_TYPES.has(clip.type)) return false
  if (!asset?.absolutePath) return false
  if (track?.type === 'video' && track.visible === false) return false
  if (track?.type === 'audio' && track.muted === true) return false
  return safeNumber(clip.duration, 0) > 0
}

function getClipMediaRole(clip, track, asset) {
  if (track?.type === 'audio' || clip?.type === 'audio') return 'audio'
  if (clip?.type === 'image' || asset?.type === 'image') return 'image'
  return 'video'
}

function getResourceKey(asset, mediaRole) {
  return `${asset.id}:${mediaRole}`
}

function buildResourceEntries(exportClips, timebase, formatId) {
  const seenResources = new Map()
  const entries = []

  for (const item of exportClips) {
    const asset = item.asset
    const resourceKey = getResourceKey(asset, item.mediaRole)
    if (seenResources.has(resourceKey)) {
      item.resourceId = seenResources.get(resourceKey)
      continue
    }

    const resourceId = `r${seenResources.size + 2}`
    seenResources.set(resourceKey, resourceId)
    item.resourceId = resourceId

    const isImage = item.mediaRole === 'image'
    const isAudio = item.mediaRole === 'audio'
    const isVideoOnly = item.mediaRole === 'video'
    const mediaDurationFrames = Math.max(
      ...exportClips
        .filter((entry) => getResourceKey(entry.asset, entry.mediaRole) === resourceKey)
        .map((entry) => getAssetMediaDuration(asset, entry.clip, timebase))
    )
    const attrs = [
      `id="${resourceId}"`,
      `name="${escapeXml(sanitizeName(asset.name, 'Media'))}"`,
      `uid="${escapeXml(`${asset.id}-${item.mediaRole}`)}"`,
      `src="${escapeXml(filePathToFileUri(asset.absolutePath))}"`,
      'start="0s"',
      `duration="${formatFrames(mediaDurationFrames, timebase)}"`,
      `hasVideo="${isAudio ? '0' : '1'}"`,
      `hasAudio="${isImage || isVideoOnly ? '0' : (asset.hasAudio === false ? '0' : '1')}"`,
    ]
    if (!isAudio) attrs.push(`format="${formatId}"`)
    entries.push(`    <asset ${attrs.join(' ')}/>`)
  }

  return entries
}

function buildAdjustTransformElement(clip, timelineHeight) {
  const transform = clip?.transform || {}
  const positionX = safeNumber(transform.positionX, 0)
  const positionY = safeNumber(transform.positionY, 0)
  const scaleX = safeNumber(transform.scaleX, 100)
  const scaleY = safeNumber(transform.scaleY, scaleX)
  const rotation = safeNumber(transform.rotation, 0)
  const hasPosition = Math.abs(positionX) > 0.0001 || Math.abs(positionY) > 0.0001
  const hasScale = Math.abs(scaleX - 100) > 0.0001 || Math.abs(scaleY - 100) > 0.0001
  const hasRotation = Math.abs(rotation) > 0.0001

  if (!hasPosition && !hasScale && !hasRotation) return ''

  const attrs = [
    'anchor="0 0"',
    `scale="${formatNumber(scaleX / 100)} ${formatNumber(scaleY / 100)}"`,
    `position="${formatNumber(pixelsToFcpXmlPosition(positionX, timelineHeight))} ${formatNumber(pixelsToFcpXmlPosition(positionY, timelineHeight))}"`,
  ]
  if (hasRotation) attrs.push(`rotation="${formatNumber(rotation)}"`)
  return `        <adjust-transform ${attrs.join(' ')}/>`
}

function buildClipElement(item, timebase, timelineHeight) {
  const { clip, asset, track, resourceId, lane } = item
  const durationFrames = Math.max(secondsToFrames(clip.duration, timebase), 1)
  const startFrames = secondsToFrames(clip.startTime, timebase)
  const sourceStart = Math.max(0, safeNumber(clip.trimStart, 0))
  const sourceStartFrames = secondsToFrames(sourceStart, timebase)
  const name = sanitizeName(clip.name || asset.name, 'Clip')
  const audioAttrs = item.mediaRole === 'audio' && asset.hasAudio !== false
    ? ' audioRole="dialogue"'
    : ''
  const enabledAttr = clip.enabled === false ? ' enabled="0"' : ''
  const laneAttr = lane ? ` lane="${lane}"` : ''
  const note = `comfystudio:clipId=${clip.id};assetId=${asset.id};trackId=${track?.id || 'unknown'}`
  const adjustTransform = item.mediaRole === 'video' || item.mediaRole === 'image'
    ? buildAdjustTransformElement(clip, timelineHeight)
    : ''
  const lines = [
    `      <asset-clip name="${escapeXml(name)}" ref="${resourceId}" offset="${formatFrames(startFrames, timebase)}" start="${formatFrames(sourceStartFrames, timebase)}" duration="${formatFrames(durationFrames, timebase)}"${laneAttr}${audioAttrs}${enabledAttr}>`,
    `        <note>${escapeXml(note)}</note>`,
  ]
  if (adjustTransform) lines.push(adjustTransform)
  lines.push(
    '      </asset-clip>',
  )
  return lines.join('\n')
}

export function buildFcpXml({
  projectName = 'Velorn Project',
  timelineName = 'Timeline',
  timelineSettings = {},
  timeline = {},
  assets = [],
} = {}) {
  const timebase = getTimebase(timelineSettings.fps || timeline.timelineFps || DEFAULT_FPS)
  const width = Math.max(1, Math.round(safeNumber(timelineSettings.width, 1920)))
  const height = Math.max(1, Math.round(safeNumber(timelineSettings.height, 1080)))
  const clips = Array.isArray(timeline.clips) ? timeline.clips : []
  // Fold solo into muted so the mute checks below export what the mixer plays.
  const tracks = applySoloAsMute(Array.isArray(timeline.tracks) ? timeline.tracks : [])
  const assetsById = new Map((Array.isArray(assets) ? assets : []).map((asset) => [asset.id, asset]))
  const tracksById = new Map(tracks.map((track) => [track.id, track]))
  const trackLaneMaps = buildTrackLaneMaps(tracks)

  const exportClips = clips
    .map((clip) => {
      const asset = assetsById.get(clip.assetId)
      const track = tracksById.get(clip.trackId)
      return { clip, asset, track }
    })
    .filter(({ clip, asset, track }) => shouldExportClip(clip, track, asset))
    .map((entry) => ({
      ...entry,
      lane: getClipLane(entry.clip, entry.track, trackLaneMaps),
      mediaRole: getClipMediaRole(entry.clip, entry.track, entry.asset),
    }))
    .sort((a, b) => (
      safeNumber(a.clip.startTime, 0) - safeNumber(b.clip.startTime, 0)
      || safeNumber(a.lane, 0) - safeNumber(b.lane, 0)
      || String(a.clip.id).localeCompare(String(b.clip.id))
    ))

  const computedEnd = exportClips.reduce((max, entry) => (
    Math.max(max, safeNumber(entry.clip.startTime, 0) + safeNumber(entry.clip.duration, 0))
  ), safeNumber(timeline.duration, 0))
  const sequenceDurationFrames = Math.max(secondsToFrames(computedEnd || 1, timebase), 1)
  const formatId = 'r1'
  const resourceEntries = [
    `    <format id="${formatId}" name="Velorn ${width}x${height} ${timebase.fps}fps" frameDuration="${timebase.frameDuration}" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)"/>`,
    ...buildResourceEntries(exportClips, timebase, formatId),
  ]
  const clipElements = exportClips.map((item) => buildClipElement(item, timebase, height))
  const safeProjectId = sanitizeId(projectName, 'comfystudio_project')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    `<fcpxml version="${FCPXML_VERSION}">`,
    '  <resources>',
    ...resourceEntries,
    '  </resources>',
    '  <library>',
    `    <event name="${escapeXml(sanitizeName(projectName, 'Velorn Project'))}">`,
    `      <project name="${escapeXml(sanitizeName(timelineName, 'Timeline'))}" uid="${escapeXml(safeProjectId)}">`,
    `        <sequence format="${formatId}" duration="${formatFrames(sequenceDurationFrames, timebase)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
    '          <spine>',
    `            <gap name="Velorn Timeline" offset="0s" start="0s" duration="${formatFrames(sequenceDurationFrames, timebase)}">`,
    ...clipElements,
    '            </gap>',
    '          </spine>',
    '        </sequence>',
    '      </project>',
    '    </event>',
    '  </library>',
    '</fcpxml>',
    '',
  ].join('\n')
}

export default buildFcpXml
