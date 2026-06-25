const DEFAULT_FPS = 24

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff'])
const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'm4a', 'aac', 'aif', 'aiff', 'ogg', 'flac'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mpeg', 'mpg'])

function safeNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function sanitizeName(value, fallback = 'Imported FCPXML') {
  const trimmed = String(value || '').trim()
  return trimmed || fallback
}

function getLocalName(node) {
  return String(node?.localName || node?.nodeName || '').toLowerCase()
}

function getDirectChildren(node) {
  return Array.from(node?.children || [])
}

function getFirstElementByTagName(doc, tagName) {
  return doc.getElementsByTagName(tagName)?.[0] || null
}

function getAssetSource(assetElement) {
  const directSrc = assetElement.getAttribute('src')
  if (directSrc) return directSrc

  const mediaReps = Array.from(assetElement.getElementsByTagName('media-rep') || [])
  const originalMedia = mediaReps.find((entry) => entry.getAttribute('kind') === 'original-media')
  return originalMedia?.getAttribute('src') || mediaReps[0]?.getAttribute('src') || ''
}

function parseXml(xmlText) {
  if (typeof DOMParser === 'undefined') {
    throw new Error('FCPXML import needs the desktop app browser parser.')
  }
  const doc = new DOMParser().parseFromString(String(xmlText || ''), 'application/xml')
  const parserError = doc.getElementsByTagName('parsererror')?.[0]
  if (parserError) {
    throw new Error('Could not parse FCPXML. The file may be invalid or incomplete.')
  }
  return doc
}

export function parseFcpXmlTime(value, fallback = 0) {
  const raw = String(value || '').trim()
  if (!raw) return fallback
  const withoutSeconds = raw.endsWith('s') ? raw.slice(0, -1) : raw
  const fractionMatch = withoutSeconds.match(/^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/)
  if (fractionMatch) {
    const numerator = Number(fractionMatch[1])
    const denominator = Number(fractionMatch[2])
    return denominator ? numerator / denominator : fallback
  }
  const plain = Number(withoutSeconds)
  if (Number.isFinite(plain)) return plain
  const timecodeMatch = withoutSeconds.match(/^(\d+):(\d{2}):(\d{2})(?:[;:.](\d{2}))?$/)
  if (timecodeMatch) {
    const hours = Number(timecodeMatch[1])
    const minutes = Number(timecodeMatch[2])
    const seconds = Number(timecodeMatch[3])
    const frames = Number(timecodeMatch[4] || 0)
    return (hours * 3600) + (minutes * 60) + seconds + (frames / DEFAULT_FPS)
  }
  return fallback
}

function fpsFromFrameDuration(frameDuration) {
  const seconds = parseFcpXmlTime(frameDuration, 0)
  if (!seconds || seconds <= 0) return DEFAULT_FPS
  const fps = 1 / seconds
  if (Math.abs(fps - 23.976) < 0.02) return 23.976
  if (Math.abs(fps - 29.97) < 0.02) return 29.97
  if (Math.abs(fps - 59.94) < 0.02) return 59.94
  return Math.max(1, Math.round(fps * 1000) / 1000)
}

function getExtensionFromPath(value) {
  const clean = String(value || '').split(/[?#]/)[0]
  const match = clean.match(/\.([a-zA-Z0-9]+)$/)
  return match ? match[1].toLowerCase() : ''
}

function fileUriToPath(src) {
  const raw = String(src || '').trim()
  if (!raw) return ''
  if (!/^file:/i.test(raw)) return raw

  let path = raw.replace(/^file:\/\//i, '')
  path = path.replace(/^localhost\//i, '')
  try {
    path = decodeURIComponent(path)
  } catch (_) {
    // Keep the original best-effort path if decoding fails.
  }
  if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1)
  if (/^[a-zA-Z]:\//.test(path)) return path.replace(/\//g, '\\')
  return path
}

function inferAssetKind(resource) {
  const extension = getExtensionFromPath(resource.sourcePath || resource.src || resource.name)
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (resource.hasVideo && !resource.hasAudio) return 'video'
  if (!resource.hasVideo && resource.hasAudio) return 'audio'
  return resource.hasVideo ? 'video' : 'audio'
}

function inferClipMediaType(element, resource, lane) {
  const tagName = getLocalName(element)
  if (tagName === 'audio' || lane < 0) return 'audio'
  if (tagName === 'video') return 'video'
  const assetKind = inferAssetKind(resource)
  if (assetKind === 'image') return 'image'
  if (assetKind === 'audio') return 'audio'
  return 'video'
}

function getResourceMaps(doc) {
  const formatMap = new Map()
  const assetMap = new Map()

  for (const format of Array.from(doc.getElementsByTagName('format') || [])) {
    const id = format.getAttribute('id')
    if (!id) continue
    const width = safeNumber(format.getAttribute('width'), null)
    const height = safeNumber(format.getAttribute('height'), null)
    formatMap.set(id, {
      id,
      width,
      height,
      fps: fpsFromFrameDuration(format.getAttribute('frameDuration')),
    })
  }

  for (const asset of Array.from(doc.getElementsByTagName('asset') || [])) {
    const id = asset.getAttribute('id')
    if (!id) continue
    const src = getAssetSource(asset)
    const sourcePath = fileUriToPath(src)
    const resource = {
      id,
      name: sanitizeName(asset.getAttribute('name'), sourcePath ? sourcePath.split(/[\\/]/).pop() : 'Media'),
      src,
      sourcePath,
      duration: parseFcpXmlTime(asset.getAttribute('duration'), 0),
      start: parseFcpXmlTime(asset.getAttribute('start'), 0),
      formatId: asset.getAttribute('format') || '',
      hasVideo: asset.getAttribute('hasVideo') !== '0',
      hasAudio: asset.getAttribute('hasAudio') === '1',
    }
    resource.kind = inferAssetKind(resource)
    assetMap.set(id, resource)
  }

  return { formatMap, assetMap }
}

function getSequenceInfo(doc, formatMap) {
  const project = getFirstElementByTagName(doc, 'project')
  const sequence = project?.getElementsByTagName('sequence')?.[0] || getFirstElementByTagName(doc, 'sequence')
  const format = sequence ? formatMap.get(sequence.getAttribute('format')) : null
  return {
    projectName: sanitizeName(project?.getAttribute('name'), 'Imported FCPXML'),
    sequence,
    duration: parseFcpXmlTime(sequence?.getAttribute('duration'), 60),
    tcStart: parseFcpXmlTime(sequence?.getAttribute('tcStart'), 0),
    width: format?.width || 1920,
    height: format?.height || 1080,
    fps: format?.fps || DEFAULT_FPS,
  }
}

function collectMediaClips(root, assetMap, warnings) {
  const clips = []

  const addMediaClip = (clip) => {
    clips.push(clip)

    if (clip.mediaType === 'video' && clip.hasEmbeddedAudio) {
      clips.push({
        ...clip,
        id: `${clip.id}-audio`,
        name: `${clip.name} Audio`,
        mediaType: 'audio',
        lane: -1,
      })
    }
  }

  const walk = (node, parentOffset = 0) => {
    for (const child of getDirectChildren(node)) {
      const tagName = getLocalName(child)
      const isMediaTag = ['asset-clip', 'video', 'audio', 'clip'].includes(tagName)
      const ref = child.getAttribute('ref')
      const resource = ref ? assetMap.get(ref) : null
      const offset = parentOffset + parseFcpXmlTime(child.getAttribute('offset'), 0)

      if (isMediaTag && ref) {
        if (!resource) {
          warnings.push(`Skipped a clip because FCPXML resource "${ref}" was not found.`)
        } else {
          const lane = safeNumber(child.getAttribute('lane'), 0)
          const mediaType = inferClipMediaType(child, resource, lane)
          const duration = parseFcpXmlTime(child.getAttribute('duration'), resource.duration || 1)
          const sourceStart = Math.max(0, parseFcpXmlTime(child.getAttribute('start'), resource.start || 0) - (resource.start || 0))
          const clipNumber = clips.length + 1
          const linkGroupId = mediaType === 'video' && resource.hasAudio
            ? `fcpxml-link-${clipNumber}`
            : null
          addMediaClip({
            id: `fcpxml-clip-${clipNumber}`,
            name: sanitizeName(child.getAttribute('name'), resource.name),
            resourceId: ref,
            mediaType,
            lane,
            startTime: Math.max(0, offset),
            duration: Math.max(1 / DEFAULT_FPS, duration),
            trimStart: sourceStart,
            sourceDuration: resource.duration || 0,
            hasEmbeddedAudio: mediaType === 'video' && resource.hasAudio,
            ...(linkGroupId ? { linkGroupId } : {}),
          })
          continue
        }
      }

      if (['spine', 'gap', 'clip', 'mc-clip', 'sync-clip', 'sequence'].includes(tagName)) {
        walk(child, offset)
      }
    }
  }

  walk(root, 0)
  return clips
}

function buildTracksAndAssignClips(clips) {
  const videoLanes = Array.from(new Set(
    clips
      .filter((clip) => clip.mediaType === 'video' || clip.mediaType === 'image')
      .map((clip) => clip.lane > 0 ? clip.lane : 1)
  )).sort((a, b) => b - a)
  const audioLanes = Array.from(new Set(
    clips
      .filter((clip) => clip.mediaType === 'audio')
      .map((clip) => clip.lane < 0 ? clip.lane : -1)
  )).sort((a, b) => b - a)

  const tracks = []
  const videoTrackByLane = new Map()
  const audioTrackByLane = new Map()

  videoLanes.forEach((lane, index) => {
    const id = `fcpxml-video-${index + 1}`
    videoTrackByLane.set(lane, id)
    tracks.push({ id, name: `Video ${index + 1}`, type: 'video', muted: false, locked: false, visible: true })
  })
  audioLanes.forEach((lane, index) => {
    const id = `fcpxml-audio-${index + 1}`
    audioTrackByLane.set(lane, id)
    tracks.push({ id, name: `Audio ${index + 1}`, type: 'audio', channels: 'stereo', muted: false, locked: false, visible: true })
  })

  const assignedClips = clips.map((clip) => {
    const lane = clip.mediaType === 'audio'
      ? (clip.lane < 0 ? clip.lane : -1)
      : (clip.lane > 0 ? clip.lane : 1)
    const trackId = clip.mediaType === 'audio'
      ? audioTrackByLane.get(lane)
      : videoTrackByLane.get(lane)
    return { ...clip, lane, trackId }
  })

  return {
    tracks: tracks.length > 0 ? tracks : [
      { id: 'fcpxml-video-1', name: 'Video 1', type: 'video', muted: false, locked: false, visible: true },
      { id: 'fcpxml-audio-1', name: 'Audio 1', type: 'audio', channels: 'stereo', muted: false, locked: false, visible: true },
    ],
    clips: assignedClips,
  }
}

export function parseFcpXml(xmlText, options = {}) {
  const warnings = []
  const doc = parseXml(xmlText)
  const { formatMap, assetMap } = getResourceMaps(doc)
  const sequenceInfo = getSequenceInfo(doc, formatMap)
  if (!sequenceInfo.sequence) {
    throw new Error('No FCPXML sequence found.')
  }

  const spine = sequenceInfo.sequence.getElementsByTagName('spine')?.[0] || sequenceInfo.sequence
  const rawClips = collectMediaClips(spine, assetMap, warnings)
  const shouldApplyTcStart = sequenceInfo.tcStart > 0
    && rawClips.length > 0
    && rawClips.every((clip) => clip.startTime >= sequenceInfo.tcStart)
  const normalizedRawClips = shouldApplyTcStart
    ? rawClips.map((clip) => ({ ...clip, startTime: Math.max(0, clip.startTime - sequenceInfo.tcStart) }))
    : rawClips
  const { tracks, clips } = buildTracksAndAssignClips(normalizedRawClips)
  const usedResourceIds = new Set(clips.map((clip) => clip.resourceId))
  const assets = Array.from(assetMap.values()).filter((asset) => usedResourceIds.has(asset.id))
  const computedDuration = clips.reduce((max, clip) => Math.max(max, clip.startTime + clip.duration), sequenceInfo.duration || 0)

  return {
    name: sanitizeName(options.name, sequenceInfo.projectName),
    settings: {
      width: sequenceInfo.width,
      height: sequenceInfo.height,
      fps: sequenceInfo.fps,
    },
    duration: Math.max(1, computedDuration || sequenceInfo.duration || 60),
    assets,
    tracks,
    clips,
    warnings,
  }
}

export default parseFcpXml
