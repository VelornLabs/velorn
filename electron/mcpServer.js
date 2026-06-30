const fs = require('fs').promises
const http = require('http')
const path = require('path')

const DEFAULT_MCP_PORT = 19790
const MCP_PROTOCOL_VERSION = '2024-11-05'
const MCP_TIMELINE_BATCH_MAX_VARIATIONS_PER_WORKFLOW = 8
const MCP_TIMELINE_BATCH_MAX_TOTAL_JOBS = 24
const MCP_TIMELINE_BATCH_AUTO_TARGET_AREA = 1280 * 720
const MCP_TIMELINE_BATCH_AUTO_MAX_EDGE = 1280
const MCP_TIMELINE_BATCH_AUTO_DIMENSION_MULTIPLE = 16
const MCP_PROMPT_BATCH_MAX_VARIATIONS_PER_WORKFLOW = 8
const MCP_PROMPT_BATCH_MAX_TOTAL_JOBS = 24
const MCP_ASSET_BATCH_MAX_ITEMS = 24
const MCP_TIMELINE_BATCH_WORKFLOW_ALIASES = new Map([
  ['ltx23i2v', 'ltx23-i2v'],
  ['ltx23', 'ltx23-i2v'],
  ['ltx', 'ltx23-i2v'],
  ['ltxvideo', 'ltx23-i2v'],
  ['wan22i2v', 'wan22-i2v'],
  ['wan22', 'wan22-i2v'],
  ['wan2', 'wan22-i2v'],
  ['wan', 'wan22-i2v'],
  ['wanvideo', 'wan22-i2v'],
])
const MCP_TIMELINE_BATCH_SUPPORTED_WORKFLOWS = new Set(['ltx23-i2v', 'wan22-i2v'])
const MCP_PROMPT_BATCH_WORKFLOW_ALIASES = new Map([
  ['zimage', 'z-image-turbo'],
  ['zimageturbo', 'z-image-turbo'],
  ['zturbo', 'z-image-turbo'],
  ['z', 'z-image-turbo'],
  ['longcat', 'longcat-text-to-image'],
  ['longcatt2i', 'longcat-text-to-image'],
  ['longcatimage', 'longcat-text-to-image'],
  ['ernie', 'ernie-image-turbo'],
  ['ernieturbo', 'ernie-image-turbo'],
  ['ernieimage', 'ernie-image-turbo'],
  ['flux2', 'flux2-text-to-image'],
  ['flux', 'flux2-text-to-image'],
  ['gptimage2', 'gpt-image-2-t2i'],
  ['gpt2image', 'gpt-image-2-t2i'],
  ['gptimage', 'gpt-image-2-t2i'],
  ['grokimage', 'grok-text-to-image'],
  ['grokt2i', 'grok-text-to-image'],
  ['ltx23t2v', 'ltx23-t2v'],
  ['ltx23', 'ltx23-t2v'],
  ['ltxt2v', 'ltx23-t2v'],
  ['ltx', 'ltx23-t2v'],
  ['wan22t2v', 'wan22-t2v'],
  ['wan22', 'wan22-t2v'],
  ['wan2', 'wan22-t2v'],
  ['wan', 'wan22-t2v'],
  ['seedance2t2v', 'seedance2-t2v'],
  ['seedancet2v', 'seedance2-t2v'],
  ['seedance', 'seedance2-t2v'],
])
const MCP_PROMPT_BATCH_SUPPORTED_WORKFLOWS = new Map([
  ['z-image-turbo', {
    label: 'Z Image Turbo',
    category: 'image',
    outputType: 'image',
    defaultResolution: { width: 1280, height: 720 },
  }],
  ['longcat-text-to-image', {
    label: 'LongCat Text to Image',
    category: 'image',
    outputType: 'image',
    defaultResolution: { width: 1280, height: 720 },
  }],
  ['ernie-image-turbo', {
    label: 'Ernie Image Turbo',
    category: 'image',
    outputType: 'image',
    defaultResolution: { width: 1280, height: 720 },
  }],
  ['flux2-text-to-image', {
    label: 'Flux 2 Text to Image',
    category: 'image',
    outputType: 'image',
    defaultResolution: { width: 1280, height: 720 },
  }],
  ['gpt-image-2-t2i', {
    label: 'GPT Image 2',
    category: 'image',
    outputType: 'image',
    defaultResolution: { width: 1024, height: 1024 },
  }],
  ['grok-text-to-image', {
    label: 'Grok Text to Image',
    category: 'image',
    outputType: 'image',
    defaultResolution: { width: 1024, height: 1024 },
  }],
  ['ltx23-t2v', {
    label: 'LTX 2.3 Text to Video',
    category: 'video',
    outputType: 'video',
    defaultDurationSeconds: 5,
    defaultFps: 24,
    defaultResolution: { width: 1280, height: 720 },
  }],
  ['wan22-t2v', {
    label: 'WAN 2.2 Text to Video',
    category: 'video',
    outputType: 'video',
    defaultDurationSeconds: 5,
    defaultFps: 24,
    defaultResolution: { width: 1280, height: 720 },
  }],
  ['seedance2-t2v', {
    label: 'Seedance 2.0 Text to Video',
    category: 'video',
    outputType: 'video',
    defaultDurationSeconds: 5,
    defaultFps: 24,
    defaultResolution: { width: 1280, height: 720 },
  }],
])
const MCP_VISUAL_KEYFRAME_CLIP_TYPES = new Set(['video', 'image', 'text', 'shape', 'adjustment', 'caption', 'captions'])
const MCP_CLIP_KEYFRAME_NUMBER_FIELDS = {
  positionX: [0, -20000, 20000],
  positionY: [0, -20000, 20000],
  positionZ: [0, -20000, 20000],
  scaleX: [100, 1, 2000],
  scaleY: [100, 1, 2000],
  rotation: [0, -3600, 3600],
  rotationX: [0, -89, 89],
  rotationY: [0, -89, 89],
  perspective: [1200, 100, 10000],
  anchorX: [50, -1000, 1000],
  anchorY: [50, -1000, 1000],
  opacity: [100, 0, 100],
  blur: [0, 0, 50],
  cropTop: [0, 0, 100],
  cropBottom: [0, 0, 100],
  cropLeft: [0, 0, 100],
  cropRight: [0, 0, 100],
  width: [640, 1, 20000],
  height: [640, 1, 20000],
  fillOpacity: [100, 0, 100],
  gradientAngle: [0, -3600, 3600],
  gradientCenterX: [50, -100, 200],
  gradientCenterY: [50, -100, 200],
  gradientRadius: [100, 1, 400],
  strokeWidth: [0, 0, 2000],
  strokeOpacity: [100, 0, 100],
  cornerRadius: [24, 0, 10000],
  sides: [6, 3, 64],
  brightness: [0, -100, 100],
  contrast: [0, -100, 100],
  saturation: [0, -100, 100],
  gain: [0, -100, 100],
  gamma: [0, -100, 100],
  offset: [0, -100, 100],
  hue: [0, -180, 180],
}
for (const group of ['shadows', 'midtones', 'highlights']) {
  for (const property of ['brightness', 'contrast', 'saturation', 'gain', 'gamma', 'offset']) {
    MCP_CLIP_KEYFRAME_NUMBER_FIELDS[`${group}.${property}`] = [0, -100, 100]
  }
  MCP_CLIP_KEYFRAME_NUMBER_FIELDS[`${group}.hue`] = [0, -180, 180]
}
const MCP_CLIP_KEYFRAME_PROPERTIES = Object.keys(MCP_CLIP_KEYFRAME_NUMBER_FIELDS)
const MCP_CLIP_KEYFRAME_PROPERTY_SET = new Set(MCP_CLIP_KEYFRAME_PROPERTIES)
const MCP_SHAPE_KEYFRAME_PROPERTY_SET = new Set([
  'width',
  'height',
  'fillOpacity',
  'gradientAngle',
  'gradientCenterX',
  'gradientCenterY',
  'gradientRadius',
  'strokeWidth',
  'strokeOpacity',
  'cornerRadius',
  'sides',
])

function safeJsonStringify(value, spacing = 2) {
  try {
    return JSON.stringify(value, null, spacing)
  } catch (error) {
    return JSON.stringify({ error: error?.message || String(error) }, null, spacing)
  }
}

function textResult(value) {
  const text = typeof value === 'string' ? value : safeJsonStringify(value)
  return {
    content: [{ type: 'text', text }],
  }
}

function errorResult(message) {
  return {
    content: [{ type: 'text', text: message || 'Tool failed.' }],
    isError: true,
  }
}

function mixedResult(value, extraContent = []) {
  const text = typeof value === 'string' ? value : safeJsonStringify(value)
  return {
    content: [
      { type: 'text', text },
      ...extraContent,
    ],
  }
}

function clampLimit(value, fallback = 100, max = 500) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(max, Math.max(1, Math.floor(parsed)))
}

function normalizeLocalPort(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return null
  if (parsed < 1 || parsed > 65535) return null
  return parsed
}

function hasSnapshot(snapshot) {
  return Boolean(snapshot && snapshot.project)
}

function getSnapshotOrEmpty(snapshot) {
  return snapshot || {
    app: { name: 'ComfyStudio' },
    project: null,
    timelines: [],
    currentTimeline: null,
    assets: [],
    folders: [],
    generatedAt: null,
  }
}

function summarizeAssetCounts(assets = []) {
  return assets.reduce((counts, asset) => {
    const type = asset?.type || 'unknown'
    counts[type] = (counts[type] || 0) + 1
    return counts
  }, {})
}

function summarizeClipCounts(clips = []) {
  return clips.reduce((counts, clip) => {
    const type = clip?.type || 'unknown'
    counts[type] = (counts[type] || 0) + 1
    return counts
  }, {})
}

function summarizeGenerationAssets(assets = []) {
  const activeStates = new Set(['queued', 'generating', 'downloading', 'encoding', 'running'])
  const failedStates = new Set(['failed', 'error'])
  const active = []
  const failed = []
  const generated = []

  for (const asset of assets) {
    const status = String(asset?.generationStatus || asset?.status || '').toLowerCase()
    const yolo = asset?.yolo || asset?.settings?.yolo || null
    const entry = {
      id: asset?.id,
      name: asset?.name,
      type: asset?.type,
      status: status || 'none',
      prompt: asset?.prompt || asset?.settings?.prompt || '',
      workflow: asset?.workflowName || asset?.settings?.workflowName || asset?.workflowId || asset?.settings?.workflowId || '',
      yolo,
      error: asset?.error || asset?.generationError || asset?.settings?.error || '',
      createdAt: asset?.createdAt || asset?.imported || null,
    }
    if (activeStates.has(status)) active.push(entry)
    if (failedStates.has(status) || entry.error) failed.push(entry)
    if (yolo || asset?.prompt || asset?.workflowId || asset?.settings?.workflowId) generated.push(entry)
  }

  return {
    activeCount: active.length,
    failedCount: failed.length,
    generatedCount: generated.length,
    active,
    failed,
    recentGenerated: generated.slice(0, 50),
  }
}

function summarizeMusicVideoWorkflow(snapshot) {
  const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : []
  const timeline = snapshot?.currentTimeline || null
  const clips = Array.isArray(timeline?.clips) ? timeline.clips : []
  const musicAssets = assets.filter((asset) => {
    const yolo = asset?.yolo || asset?.settings?.yolo
    return yolo?.mode === 'music' || yolo?.workflow === 'music-video' || yolo?.musicVideo
  })

  const byStage = {}
  const byShot = {}
  for (const asset of musicAssets) {
    const yolo = asset?.yolo || asset?.settings?.yolo || {}
    const stage = yolo.stage || asset.type || 'unknown'
    byStage[stage] = (byStage[stage] || 0) + 1
    const shotId = yolo.shotId || yolo.shot_id || yolo.variantKey || ''
    if (shotId) {
      byShot[shotId] = byShot[shotId] || { shotId, assets: 0, stages: {} }
      byShot[shotId].assets += 1
      byShot[shotId].stages[stage] = (byShot[shotId].stages[stage] || 0) + 1
    }
  }

  const assembledClips = clips.filter((clip) => clip?.metadata?.musicVideoAssembly)
  const syncLockedClips = clips.filter((clip) => clip?.lockMode === 'sync' || clip?.syncLock?.mode === 'sync')

  return {
    projectTitle: snapshot?.project?.name || '',
    currentTimeline: timeline ? {
      id: timeline.id,
      name: timeline.name,
      duration: timeline.duration,
      clipCount: clips.length,
    } : null,
    musicAssetCount: musicAssets.length,
    assetsByStage: byStage,
    shots: Object.values(byShot).slice(0, 200),
    assembledClipCount: assembledClips.length,
    syncLockedClipCount: syncLockedClips.length,
  }
}

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function getNumberArg(args, key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(args?.[key])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function roundTime(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.round(parsed * 1000) / 1000
}

function getClipStart(clip) {
  return toFiniteNumber(clip?.startTime, 0)
}

function getClipDuration(clip) {
  return toFiniteNumber(clip?.duration, 0)
}

function getClipEnd(clip) {
  return getClipStart(clip) + getClipDuration(clip)
}

function clipRef(clip) {
  return {
    id: clip?.id,
    name: clip?.name,
    type: clip?.type,
    trackId: clip?.trackId,
    startTime: roundTime(getClipStart(clip)),
    duration: roundTime(getClipDuration(clip)),
    assetId: clip?.assetId || null,
  }
}

function clampMcpKeyframeNumber(property, value) {
  const [, min = -20000, max = 20000] = MCP_CLIP_KEYFRAME_NUMBER_FIELDS[property] || []
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid keyframe value for ${property}.`)
  }
  const clamped = Math.min(max, Math.max(min, parsed))
  return property === 'sides' ? Math.round(clamped) : clamped
}

function normalizeMcpClipKeyframes(args = {}, clip = null) {
  const duration = Math.max(0, getClipDuration(clip))
  const rawKeyframes = Array.isArray(args.keyframes) ? args.keyframes : []
  return rawKeyframes.map((entry) => {
    const property = String(entry?.property || '').trim()
    if (!MCP_CLIP_KEYFRAME_PROPERTY_SET.has(property)) {
      throw new Error(`Unsupported clip keyframe property "${property}".`)
    }
    if (MCP_SHAPE_KEYFRAME_PROPERTY_SET.has(property) && String(clip?.type || '').toLowerCase() !== 'shape') {
      throw new Error(`Shape keyframe property "${property}" can only be used on shape clips.`)
    }
    const rawTime = Number(entry?.timeSeconds ?? entry?.time)
    if (!Number.isFinite(rawTime) || rawTime < 0) {
      throw new Error(`Invalid keyframe time for ${property}.`)
    }
    const timeSeconds = duration > 0 ? Math.min(duration, rawTime) : rawTime
    return {
      property,
      timeSeconds: roundTime(timeSeconds),
      value: clampMcpKeyframeNumber(property, entry?.value),
      easing: String(entry?.easing || 'easeInOut').slice(0, 120),
    }
  })
}

function normalizeMcpClipKeyframeClearProperties(clearKeyframes, clip = null) {
  if (!clearKeyframes) return []
  const isShapeClip = String(clip?.type || '').toLowerCase() === 'shape'
  const allPropertiesForClip = isShapeClip
    ? MCP_CLIP_KEYFRAME_PROPERTIES
    : MCP_CLIP_KEYFRAME_PROPERTIES.filter((property) => !MCP_SHAPE_KEYFRAME_PROPERTY_SET.has(property))
  const requested = clearKeyframes === true || clearKeyframes === 'all'
    ? allPropertiesForClip
    : Array.isArray(clearKeyframes)
      ? clearKeyframes.map((property) => String(property || '').trim()).filter(Boolean)
      : []
  for (const property of requested) {
    if (!MCP_CLIP_KEYFRAME_PROPERTY_SET.has(property)) {
      throw new Error(`Unsupported clip keyframe property "${property}".`)
    }
    if (MCP_SHAPE_KEYFRAME_PROPERTY_SET.has(property) && clip && String(clip.type || '').toLowerCase() !== 'shape') {
      throw new Error(`Shape keyframe property "${property}" can only be used on shape clips.`)
    }
  }
  return [...new Set(requested)]
}

function summarizeClipKeyframeTarget(clip) {
  return {
    ...clipRef(clip),
    enabled: clip?.enabled !== false,
    transform: clip?.transform || null,
    textProperties: clip?.type === 'text' ? (clip?.textProperties || null) : undefined,
    shapeProperties: clip?.type === 'shape' ? (clip?.shapeProperties || null) : undefined,
    keyframes: clip?.keyframes || {},
  }
}

function getAssetById(snapshot, assetId) {
  if (!assetId) return null
  return (snapshot?.assets || []).find((asset) => asset?.id === assetId) || null
}

function getTrackById(timeline, trackId) {
  if (!trackId) return null
  return (timeline?.tracks || []).find((track) => track?.id === trackId) || null
}

function resolveProjectFilePath(snapshot, filePath) {
  const value = String(filePath || '').trim()
  if (!value) return ''
  if (path.isAbsolute(value)) return value
  const projectPath = String(snapshot?.project?.path || '').trim()
  return projectPath ? path.join(projectPath, value) : value
}

function getImageMimeType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return ''
}

function getClipVisualSource(snapshot, clip, asset) {
  const posterPath = asset?.poster?.posterPath || asset?.posterPath || ''
  if (posterPath) {
    return {
      kind: 'poster',
      filePath: resolveProjectFilePath(snapshot, posterPath),
      description: 'Representative poster frame generated by ComfyStudio.',
    }
  }

  if (asset?.type === 'image' || asset?.type === 'mask') {
    const imagePath = asset.absolutePath || asset.path || ''
    if (imagePath) {
      return {
        kind: 'image',
        filePath: resolveProjectFilePath(snapshot, imagePath),
        description: 'Source image asset used by the clip.',
      }
    }
  }

  const spritePath = asset?.sprite?.spritePath || ''
  if (spritePath) {
    return {
      kind: 'sprite',
      filePath: resolveProjectFilePath(snapshot, spritePath),
      description: 'Thumbnail sprite sheet for the source video.',
    }
  }

  return {
    kind: 'none',
    filePath: '',
    description: clip?.assetId ? 'No poster, image, or sprite is available for this clip yet.' : 'This clip has no source asset.',
  }
}

async function readImageContent(filePath, maxBytes = 3 * 1024 * 1024) {
  const resolvedPath = String(filePath || '').trim()
  if (!resolvedPath) return { imageContent: null, warning: 'No image path is available.' }

  const mimeType = getImageMimeType(resolvedPath)
  if (!mimeType) return { imageContent: null, warning: `Unsupported image file type: ${path.extname(resolvedPath) || 'unknown'}.` }

  try {
    const stat = await fs.stat(resolvedPath)
    if (!stat.isFile()) return { imageContent: null, warning: 'Visual source is not a file.' }
    if (stat.size > maxBytes) {
      return {
        imageContent: null,
        warning: `Visual source is ${stat.size} bytes, above the ${maxBytes} byte MCP embed limit.`,
      }
    }
    const data = await fs.readFile(resolvedPath)
    return {
      imageContent: {
        type: 'image',
        data: data.toString('base64'),
        mimeType,
      },
      warning: '',
      size: stat.size,
    }
  } catch (error) {
    return {
      imageContent: null,
      warning: `Could not read visual source: ${error?.message || String(error)}`,
    }
  }
}

function isAssetBackedClip(clip) {
  const type = String(clip?.type || '').toLowerCase()
  return !['adjustment', 'text', 'caption', 'captions', 'marker'].includes(type)
}

function hasNonDefaultTransform(transform = {}) {
  if (!transform || typeof transform !== 'object') return false
  const checks = [
    Math.abs(toFiniteNumber(transform.positionX, 0)) > 0.001,
    Math.abs(toFiniteNumber(transform.positionY, 0)) > 0.001,
    Math.abs(toFiniteNumber(transform.positionZ, 0)) > 0.001,
    Math.abs(toFiniteNumber(transform.scaleX, 100) - 100) > 0.001,
    Math.abs(toFiniteNumber(transform.scaleY, 100) - 100) > 0.001,
    Math.abs(toFiniteNumber(transform.rotation, 0)) > 0.001,
    Math.abs(toFiniteNumber(transform.rotationX, 0)) > 0.001,
    Math.abs(toFiniteNumber(transform.rotationY, 0)) > 0.001,
    Math.abs(toFiniteNumber(transform.perspective, 1200) - 1200) > 0.001,
    Math.abs(toFiniteNumber(transform.opacity, 100) - 100) > 0.001,
    Math.abs(toFiniteNumber(transform.cropTop, 0)) > 0.001,
    Math.abs(toFiniteNumber(transform.cropBottom, 0)) > 0.001,
    Math.abs(toFiniteNumber(transform.cropLeft, 0)) > 0.001,
    Math.abs(toFiniteNumber(transform.cropRight, 0)) > 0.001,
    Math.abs(toFiniteNumber(transform.blur, 0)) > 0.001,
    Boolean(transform.flipH),
    Boolean(transform.flipV),
    Boolean(transform.blendMode && transform.blendMode !== 'normal'),
  ]
  return checks.some(Boolean)
}

function normalizeClipLabelColor(color) {
  const value = String(color || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : ''
}

function hasInvalidClipLabelColor(color) {
  const value = String(color || '').trim()
  return Boolean(value) && !/^#[0-9a-fA-F]{6}$/.test(value)
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
}

function matchesClipLabelFilter(clip, filter) {
  switch (filter) {
    case 'enabled':
      return clip?.enabled !== false
    case 'disabled':
      return clip?.enabled === false
    case 'transformed':
      return hasNonDefaultTransform(clip?.transform)
    case 'sync_locked':
      return clip?.lockMode === 'sync' || clip?.syncLock?.mode === 'sync'
    case 'xml_imported':
      return Boolean(clip?.metadata?.importedFromFcpXml)
    case 'speed_changed':
      return Math.abs(toFiniteNumber(clip?.speed, 1) - 1) > 0.001
    case 'labeled':
      return Boolean(clip?.labelColor)
    case 'unlabeled':
      return !clip?.labelColor
    default:
      return false
  }
}

function resolveClipLabelTargets(snapshot, args = {}) {
  const timeline = snapshot?.currentTimeline || null
  const clips = Array.isArray(timeline?.clips) ? timeline.clips : []
  const explicitClipIds = normalizeStringArray(args.clipIds)
  const filter = String(args.filter || '').trim().toLowerCase()

  if (explicitClipIds.length > 0) {
    const byId = new Map(clips.map((clip) => [clip?.id, clip]).filter(([id]) => id))
    const targetClips = explicitClipIds.map((clipId) => byId.get(clipId)).filter(Boolean)
    const foundIds = new Set(targetClips.map((clip) => clip.id))
    return {
      mode: 'clipIds',
      filter: '',
      clips: targetClips,
      missingClipIds: explicitClipIds.filter((clipId) => !foundIds.has(clipId)),
    }
  }

  if (filter) {
    const allowedFilters = new Set([
      'enabled',
      'disabled',
      'transformed',
      'sync_locked',
      'xml_imported',
      'speed_changed',
      'labeled',
      'unlabeled',
    ])
    if (!allowedFilters.has(filter)) {
      return {
        error: `Unknown clip filter "${filter}".`,
        clips: [],
        missingClipIds: [],
      }
    }
    return {
      mode: 'filter',
      filter,
      clips: clips.filter((clip) => matchesClipLabelFilter(clip, filter)),
      missingClipIds: [],
    }
  }

  return {
    error: 'Provide either clipIds or a filter such as enabled, disabled, transformed, sync_locked, xml_imported, speed_changed, labeled, or unlabeled.',
    clips: [],
    missingClipIds: [],
  }
}

function summarizeTextClipForMcp(clip) {
  return {
    id: clip?.id,
    name: clip?.name || clip?.id,
    type: clip?.type || 'unknown',
    trackId: clip?.trackId || null,
    startTime: roundTime(getClipStart(clip)),
    duration: roundTime(getClipDuration(clip)),
    enabled: clip?.enabled !== false,
    textProperties: clip?.textProperties || {},
    transform: clip?.transform || {},
    titleAnimation: clip?.titleAnimation || null,
    keyframes: clip?.keyframes || {},
  }
}

function summarizeShapeClipForMcp(clip) {
  return {
    id: clip?.id,
    name: clip?.name || clip?.id,
    type: clip?.type || 'unknown',
    trackId: clip?.trackId || null,
    startTime: roundTime(getClipStart(clip)),
    duration: roundTime(getClipDuration(clip)),
    enabled: clip?.enabled !== false,
    shapeProperties: clip?.shapeProperties || {},
    transform: clip?.transform || {},
    keyframes: clip?.keyframes || {},
  }
}

function getTextClipForMcp(snapshot, clipId) {
  const timeline = snapshot?.currentTimeline || null
  const clips = Array.isArray(timeline?.clips) ? timeline.clips : []
  const id = String(clipId || '').trim()
  if (!id) return { error: 'Provide clipId for the text clip.' }
  const clip = clips.find((candidate) => candidate?.id === id)
  if (!clip) return { error: `Text clip ${id} was not found.` }
  if (clip.type !== 'text') return { error: `Clip ${id} is a ${clip.type || 'unknown'} clip, not a text clip.` }
  return { clip }
}

function getShapeClipForMcp(snapshot, clipId) {
  const timeline = snapshot?.currentTimeline || null
  const clips = Array.isArray(timeline?.clips) ? timeline.clips : []
  const id = String(clipId || '').trim()
  if (!id) return { error: 'Provide clipId for the shape clip.' }
  const clip = clips.find((candidate) => candidate?.id === id)
  if (!clip) return { error: `Shape clip ${id} was not found.` }
  if (clip.type !== 'shape') return { error: `Clip ${id} is a ${clip.type || 'unknown'} clip, not a shape clip.` }
  return { clip }
}

function summarizeAssetForPlacement(asset) {
  return {
    id: asset?.id,
    name: asset?.name || asset?.id,
    type: asset?.type || 'unknown',
    duration: asset?.duration || null,
    width: asset?.width || null,
    height: asset?.height || null,
    workflowId: asset?.workflowId || '',
    workflowName: asset?.workflowName || '',
    hasAudio: typeof asset?.hasAudio === 'boolean' ? asset.hasAudio : null,
    audioEnabled: typeof asset?.audioEnabled === 'boolean' ? asset.audioEnabled : null,
    generationStatus: asset?.generationStatus || asset?.status || 'none',
    createdAt: asset?.createdAt || asset?.imported || null,
  }
}

function isPlaceableTimelineAsset(asset) {
  return ['video', 'image', 'audio'].includes(String(asset?.type || '').toLowerCase())
}

function getPlacementAssetCreatedTime(asset) {
  const raw = asset?.createdAt || asset?.imported || asset?.created || asset?.modified || ''
  const parsed = raw ? Date.parse(raw) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeAssetPlacementMode(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (['selectedclipstart', 'selectionstart', 'selectedstart'].includes(normalized)) return 'selected_clip_start'
  if (['selectedclipend', 'selectionend', 'selectedend', 'afterselectedclip', 'afterselection'].includes(normalized)) return 'selected_clip_end'
  if (['timelineend', 'end', 'append'].includes(normalized)) return 'timeline_end'
  if (['trackend', 'endoftrack'].includes(normalized)) return 'track_end'
  return 'playhead'
}

function getCompatibleTrackTypeForPlacementAsset(asset) {
  const type = String(asset?.type || '').toLowerCase()
  if (type === 'audio') return 'audio'
  if (type === 'video' || type === 'image') return 'video'
  return ''
}

function shouldPlanLinkedVideoAudio(asset, args = {}) {
  if (String(asset?.type || '').toLowerCase() !== 'video') return false
  if (args.includeAudio === false || args.includeEmbeddedAudio === false) return false
  if (asset?.audioEnabled === false) return false
  if (asset?.hasAudio === false) return false
  return true
}

function shouldPlanBatchLinkedVideoAudio(args = {}, layout = '') {
  if (args.includeAudio === true || args.includeEmbeddedAudio === true) return true
  if (args.includeAudio === false || args.includeEmbeddedAudio === false) return false
  return layout === 'sequential'
}

function getAvailableAudioTrackForPlacement(timeline) {
  return (timeline?.tracks || []).find((track) => (
    track?.type === 'audio' &&
    track.locked !== true &&
    track.visible !== false
  )) || null
}

function buildLinkedAudioPlacementPlan(timeline, asset, args = {}) {
  if (!shouldPlanLinkedVideoAudio(asset, args)) return null
  const audioTrack = getAvailableAudioTrackForPlacement(timeline)
  return {
    createTrack: !audioTrack,
    track: audioTrack ? {
      id: audioTrack.id,
      name: audioTrack.name,
      type: audioTrack.type,
      locked: Boolean(audioTrack.locked),
      muted: Boolean(audioTrack.muted),
      visible: audioTrack.visible !== false,
      channels: audioTrack.channels || 'stereo',
    } : {
      id: null,
      name: String(args.audioTrackName || '').trim() || 'MCP Linked Audio',
      type: 'audio',
      locked: false,
      muted: false,
      visible: true,
      channels: String(args.channels || '').trim().toLowerCase() === 'mono' ? 'mono' : 'stereo',
    },
  }
}

function resolveAssetForTimelinePlacement(snapshot, args = {}) {
  const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : []
  const assetId = String(args.assetId || args.id || '').trim()
  const assetName = String(args.assetName || args.name || '').trim().toLowerCase()
  const type = String(args.type || args.assetType || '').trim().toLowerCase()
  const workflowId = String(args.workflowId || '').trim().toLowerCase()

  if (assetId) {
    const asset = assets.find((candidate) => candidate?.id === assetId)
    if (!asset) return { error: `Asset ${assetId} was not found.` }
    if (!isPlaceableTimelineAsset(asset)) return { error: `Asset ${assetId} is a ${asset.type || 'unknown'} asset and cannot be placed on the timeline yet.` }
    return { asset }
  }

  let candidates = assets.filter(isPlaceableTimelineAsset)
  if (type) candidates = candidates.filter((asset) => String(asset?.type || '').toLowerCase() === type)
  if (workflowId) {
    candidates = candidates.filter((asset) => String(asset?.workflowId || '').trim().toLowerCase() === workflowId)
  }

  if (assetName) {
    const exact = candidates.find((asset) => String(asset?.name || '').trim().toLowerCase() === assetName)
    if (exact) return { asset: exact }
    const partial = candidates.find((asset) => String(asset?.name || '').trim().toLowerCase().includes(assetName))
    if (partial) return { asset: partial }
    return { error: `No placeable asset matched "${args.assetName || args.name}".` }
  }

  const allowedStatuses = new Set(['none', 'done', 'complete', 'completed', 'success', ''])
  const latest = candidates
    .filter((asset) => allowedStatuses.has(String(asset?.generationStatus || asset?.status || 'none').toLowerCase()))
    .sort((a, b) => getPlacementAssetCreatedTime(b) - getPlacementAssetCreatedTime(a))[0]

  if (latest) return { asset: latest }
  return { error: 'No placeable asset was found. Provide assetId, assetName, or generate/import an asset first.' }
}

function resolveAssetPlacementTrack(timeline, asset, args = {}) {
  const targetType = getCompatibleTrackTypeForPlacementAsset(asset)
  if (!targetType) return { error: `Asset ${asset?.name || asset?.id || ''} cannot be placed on a timeline track.` }

  const trackId = String(args.trackId || '').trim()
  const newTrackMode = String(args.trackStrategy || args.placementTrack || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  const createTrack = args.createTrack === true || args.newTrack === true || ['new', 'newtop', 'newtrack', 'newtoptrack'].includes(newTrackMode)

  if (trackId) {
    const track = getTrackById(timeline, trackId)
    if (!track) return { error: `Track ${trackId} was not found.` }
    if (track.type !== targetType) return { error: `Asset ${asset.name || asset.id} is ${asset.type}; it needs a ${targetType} track.` }
    if (track.locked) return { error: `Track ${trackId} is locked.` }
    return { track, createTrack: false, targetType }
  }

  if (createTrack) {
    return {
      track: null,
      createTrack: true,
      targetType,
      plannedTrack: {
        id: null,
        name: String(args.trackName || '').trim() || `MCP ${targetType === 'video' ? 'Video' : 'Audio'}`,
        type: targetType,
      },
    }
  }

  const track = (timeline?.tracks || []).find((candidate) => (
    candidate?.type === targetType &&
    candidate.locked !== true &&
    candidate.visible !== false &&
    candidate.role !== 'captions'
  ))
  if (track) return { track, createTrack: false, targetType }

  return {
    track: null,
    createTrack: true,
    targetType,
    plannedTrack: {
      id: null,
      name: String(args.trackName || '').trim() || `MCP ${targetType === 'video' ? 'Video' : 'Audio'}`,
      type: targetType,
    },
  }
}

function resolveAssetPlacementStart(timeline, trackId, args = {}) {
  const explicitStart = Number(args.startSeconds ?? args.startTime)
  if (Number.isFinite(explicitStart)) return roundTime(Math.max(0, explicitStart))

  const placement = normalizeAssetPlacementMode(args.at || args.placement || args.position)
  const selectedIds = new Set(Array.isArray(timeline?.selectedClipIds) ? timeline.selectedClipIds : [])
  const selectedClip = selectedIds.size > 0
    ? (timeline?.clips || []).find((clip) => selectedIds.has(clip?.id))
    : null

  if (placement === 'selected_clip_start' && selectedClip) {
    return roundTime(Math.max(0, getClipStart(selectedClip)))
  }
  if (placement === 'selected_clip_end' && selectedClip) {
    return roundTime(Math.max(0, getClipEnd(selectedClip)))
  }
  if (placement === 'track_end' && trackId) {
    const end = (timeline?.clips || [])
      .filter((clip) => clip?.trackId === trackId)
      .reduce((max, clip) => Math.max(max, getClipEnd(clip)), 0)
    return roundTime(end)
  }
  if (placement === 'timeline_end') {
    const end = (timeline?.clips || []).reduce((max, clip) => Math.max(max, getClipEnd(clip)), 0)
    return roundTime(end)
  }

  return roundTime(Math.max(0, toFiniteNumber(timeline?.playheadPosition, 0)))
}

function resolveAssetTimelinePlacementPlan(snapshot, args = {}) {
  const timeline = snapshot?.currentTimeline || null
  if (!timeline) return { error: 'No current timeline is available.' }

  const resolvedAsset = resolveAssetForTimelinePlacement(snapshot, args)
  if (resolvedAsset.error) return { error: resolvedAsset.error }
  const asset = resolvedAsset.asset

  const resolvedTrack = resolveAssetPlacementTrack(timeline, asset, args)
  if (resolvedTrack.error) return { error: resolvedTrack.error }
  const track = resolvedTrack.track || resolvedTrack.plannedTrack || null
  const startSeconds = resolveAssetPlacementStart(timeline, resolvedTrack.track?.id || '', args)
  const requestedDuration = Number(args.durationSeconds ?? args.duration)
  const assetDuration = toFiniteNumber(asset.duration, 0)
  const durationSeconds = Number.isFinite(requestedDuration) && requestedDuration > 0
    ? roundTime(requestedDuration)
    : (asset.type === 'image' ? 5 : roundTime(assetDuration || 5))
  const linkedAudio = buildLinkedAudioPlacementPlan(timeline, asset, args)

  return {
    action: 'add_asset_to_timeline',
    previewOnly: args.previewOnly !== false,
    asset: summarizeAssetForPlacement(asset),
    track: track ? {
      id: track.id || null,
      name: track.name || '',
      type: track.type || resolvedTrack.targetType,
      locked: Boolean(track.locked),
      muted: Boolean(track.muted),
      visible: track.visible !== false,
    } : null,
    createTrack: resolvedTrack.createTrack === true,
    trackType: resolvedTrack.targetType,
    startSeconds,
    durationSeconds,
    linkedAudio: linkedAudio ? {
      ...linkedAudio,
      startSeconds,
      durationSeconds,
    } : null,
    placement: normalizeAssetPlacementMode(args.at || args.placement || args.position),
    resolveOverlaps: args.resolveOverlaps !== false,
    selectAfterAdd: args.selectAfterAdd !== false,
    transform: args.transform && typeof args.transform === 'object' ? args.transform : null,
  }
}

function normalizeSolidTrackPlacement(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (['top', 'newtop', 'newtoptrack', 'above'].includes(normalized)) return 'top'
  return 'bottom'
}

function resolveSolidColorPlan(snapshot, args = {}) {
  const timeline = snapshot?.currentTimeline || null
  const project = snapshot?.project || null
  if (!timeline || !project) return { error: 'Open a saved ComfyStudio project and timeline before creating a solid color.' }

  const rawColor = args.color || args.fill || args.solidColor || '#000000'
  const color = normalizeClipLabelColor(rawColor)
  if (!color) return { error: 'Invalid solid color. Use a hex color like #000000 or #ff0000.' }

  const width = Math.max(1, Math.round(toFiniteNumber(args.width, timeline.width || project.settings?.width || 1920)))
  const height = Math.max(1, Math.round(toFiniteNumber(args.height, timeline.height || project.settings?.height || 1080)))
  const fps = Math.max(1, toFiniteNumber(timeline.fps, project.settings?.fps || 24))
  const requestedDuration = Number(args.durationSeconds ?? args.duration)
  const durationSeconds = Number.isFinite(requestedDuration) && requestedDuration > 0
    ? roundTime(requestedDuration)
    : 5
  const name = String(args.name || args.assetName || '').trim()
    || `${color === '#000000' ? 'Black' : 'Color'} solid ${width}x${height}`
  const placeOnTimeline = args.placeOnTimeline !== false && args.addToTimeline !== false
  const createTrack = args.createTrack !== false && args.newTrack !== false && !String(args.trackId || '').trim()
  const trackPlacement = normalizeSolidTrackPlacement(args.trackPlacement || args.trackPosition || args.placementTrackPosition)
  const startSeconds = placeOnTimeline
    ? resolveAssetPlacementStart(timeline, String(args.trackId || '').trim(), args)
    : null
  const requestedTrackId = String(args.trackId || '').trim()
  const existingTrack = requestedTrackId ? getTrackById(timeline, requestedTrackId) : null
  if (requestedTrackId && !existingTrack) return { error: `Track ${requestedTrackId} was not found.` }
  if (existingTrack && existingTrack.type !== 'video') return { error: `Solid color assets must be placed on a video track, not ${existingTrack.type}.` }
  if (existingTrack?.locked) return { error: `Track ${existingTrack.id} is locked.` }

  const track = placeOnTimeline
    ? (existingTrack || {
      id: null,
      name: String(args.trackName || '').trim() || `${color === '#000000' ? 'Black' : 'Color'} solid`,
      type: 'video',
      locked: false,
      muted: false,
      visible: true,
    })
    : null

  return {
    action: 'add_solid_color',
    previewOnly: args.previewOnly !== false,
    asset: {
      name,
      type: 'image',
      width,
      height,
      color,
      duration: durationSeconds,
      fps,
    },
    placeOnTimeline,
    track: track ? {
      id: track.id || null,
      name: track.name || '',
      type: track.type || 'video',
      locked: Boolean(track.locked),
      muted: Boolean(track.muted),
      visible: track.visible !== false,
    } : null,
    createTrack: placeOnTimeline ? createTrack && !existingTrack : false,
    trackPlacement: placeOnTimeline && createTrack && !existingTrack ? trackPlacement : null,
    startSeconds,
    durationSeconds,
    resolveOverlaps: args.resolveOverlaps === true,
    selectAfterAdd: args.selectAfterAdd !== false,
    transform: args.transform && typeof args.transform === 'object' ? args.transform : null,
    note: placeOnTimeline && createTrack && trackPlacement === 'bottom'
      ? 'A new bottom video track will be created so the solid can sit behind the edit.'
      : '',
  }
}

function normalizeTimelineName(value, fallback = 'New Sequence') {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120)
  return normalized || fallback
}

function createUniqueTimelineName(name, timelines = []) {
  const usedNames = new Set((timelines || []).map((timeline) => String(timeline?.name || '').trim().toLowerCase()))
  if (!usedNames.has(name.toLowerCase())) return name

  let index = 2
  let candidate = `${name} ${index}`
  while (usedNames.has(candidate.toLowerCase())) {
    index += 1
    candidate = `${name} ${index}`
  }
  return candidate
}

function normalizeTimelineDimension(value, fallback) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return Math.max(1, Math.round(parsed))
  return Math.max(1, Math.round(Number(fallback) || 1920))
}

function normalizeTimelineFps(value, fallback) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(240, Math.max(1, parsed))
  const fallbackFps = Number(fallback)
  return Number.isFinite(fallbackFps) && fallbackFps > 0 ? fallbackFps : 24
}

function resolveCreateTimelinePlan(snapshot, args = {}) {
  const project = snapshot?.project || null
  if (!project) return { error: 'Open a saved ComfyStudio project before creating a sequence.' }

  const timelines = Array.isArray(snapshot?.timelines) ? snapshot.timelines : []
  const currentTimeline = snapshot?.currentTimeline || null
  const projectSettings = project.settings || {}
  const copySettingsFromCurrent = args.copySettingsFromCurrent !== false
  const settingsSource = copySettingsFromCurrent ? (currentTimeline || projectSettings) : projectSettings
  const requestedName = normalizeTimelineName(args.name || args.timelineName || args.sequenceName)
  const name = args.allowDuplicateName === true
    ? requestedName
    : createUniqueTimelineName(requestedName, timelines)
  const fps = normalizeTimelineFps(args.fps, settingsSource?.fps || projectSettings.fps || 24)
  const requestedDuration = Number(args.durationSeconds ?? args.duration)
  const durationSeconds = Number.isFinite(requestedDuration) && requestedDuration > 0
    ? roundTime(requestedDuration)
    : 60
  const rawColor = String(args.color || '').trim()
  const color = rawColor ? normalizeClipLabelColor(rawColor) : null
  if (rawColor && !color) return { error: 'Invalid timeline color. Use a hex color like #38bdf8 or omit it.' }

  return {
    action: 'create_timeline',
    previewOnly: args.previewOnly !== false,
    requestedName,
    name,
    nameAdjusted: name !== requestedName,
    width: normalizeTimelineDimension(args.width, settingsSource?.width || projectSettings.width || 1920),
    height: normalizeTimelineDimension(args.height, settingsSource?.height || projectSettings.height || 1080),
    fps,
    durationSeconds,
    color,
    folderId: String(args.folderId || '').trim() || null,
    copySettingsFromCurrent,
    switchToTimeline: args.switchToTimeline !== false && args.activate !== false && args.makeActive !== false,
    existingTimelineCount: timelines.length,
    currentTimeline: currentTimeline ? {
      id: currentTimeline.id,
      name: currentTimeline.name,
      width: currentTimeline.width,
      height: currentTimeline.height,
      fps: currentTimeline.fps,
    } : null,
  }
}

function summarizeAssetFolder(folder = null) {
  if (!folder) return null
  return {
    id: folder.id || null,
    name: folder.name || '',
    parentId: folder.parentId || null,
    color: folder.color || null,
    createdAt: folder.createdAt || folder.created || null,
  }
}

function normalizeFolderName(value, fallback = 'New Folder') {
  const normalized = String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return normalized || fallback
}

function splitFolderPathInput(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeFolderName(entry, '')).filter(Boolean)
  }
  const raw = String(value || '').trim()
  if (!raw) return []
  return raw
    .split(/[\\/]+/)
    .map((entry) => normalizeFolderName(entry, ''))
    .filter(Boolean)
}

function makeUniqueFolderName(name, folders = [], parentId = null) {
  const usedNames = new Set(
    (folders || [])
      .filter((folder) => (folder?.parentId || null) === (parentId || null))
      .map((folder) => String(folder?.name || '').trim().toLowerCase())
  )
  if (!usedNames.has(name.toLowerCase())) return name

  let index = 2
  let candidate = `${name} ${index}`
  while (usedNames.has(candidate.toLowerCase())) {
    index += 1
    candidate = `${name} ${index}`
  }
  return candidate
}

function findAssetFolderByName(folders = [], parentId = null, name = '') {
  const key = String(name || '').trim().toLowerCase()
  if (!key) return null
  return (folders || []).find((folder) => (
    (folder?.parentId || null) === (parentId || null)
    && String(folder?.name || '').trim().toLowerCase() === key
  )) || null
}

function getAssetFolderPathSegments(folders = [], folderId = null) {
  const segments = []
  let cursor = folderId || null
  const seen = new Set()
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const folder = (folders || []).find((entry) => entry?.id === cursor)
    if (!folder) break
    segments.unshift(folder.name || folder.id)
    cursor = folder.parentId || null
  }
  return segments
}

function resolveAssetFolderParent(snapshot, args = {}) {
  const folders = Array.isArray(snapshot?.folders) ? snapshot.folders : []
  const parentId = String(args.parentId || args.folderId || '').trim() || null
  const parentPath = splitFolderPathInput(args.parentPath || args.parentFolderPath || [])

  if (parentId) {
    const parent = folders.find((folder) => folder?.id === parentId) || null
    if (!parent) return { error: `Parent folder ${parentId} was not found.` }
    return {
      parentId,
      parentPath: getAssetFolderPathSegments(folders, parentId),
    }
  }

  if (parentPath.length === 0) return { parentId: null, parentPath: [] }

  let cursor = null
  for (const segment of parentPath) {
    const folder = findAssetFolderByName(folders, cursor, segment)
    if (!folder) {
      return { error: `Parent folder path "${parentPath.join(' / ')}" was not found. Use folderPath/path to create missing folders.` }
    }
    cursor = folder.id
  }

  return { parentId: cursor, parentPath }
}

function resolveCreateAssetFolderPlan(snapshot, args = {}) {
  const project = snapshot?.project || null
  if (!project) return { error: 'Open a saved ComfyStudio project before creating an asset folder.' }

  const folders = Array.isArray(snapshot?.folders) ? snapshot.folders : []
  const rawPath = args.path ?? args.folderPath ?? args.segments ?? args.folderSegments
  const pathSegments = splitFolderPathInput(rawPath)
  const nameSegments = pathSegments.length > 0
    ? pathSegments
    : [normalizeFolderName(args.name || args.folderName)]
  if (nameSegments.length === 0) return { error: 'Provide a folder name or folder path.' }

  const parent = resolveAssetFolderParent(snapshot, args)
  if (parent.error) return { error: parent.error }

  const reuseExisting = args.reuseExisting !== false
  const allowDuplicateName = args.allowDuplicateName === true
  const rawColor = String(args.color || '').trim()
  const color = rawColor ? normalizeClipLabelColor(rawColor) : null
  if (rawColor && !color) return { error: 'Invalid folder color. Use a hex color like #38bdf8 or omit it.' }

  const simulatedFolders = [...folders]
  const steps = []
  let cursor = parent.parentId || null
  for (const segment of nameSegments) {
    const existing = findAssetFolderByName(simulatedFolders, cursor, segment)
    if (existing && reuseExisting) {
      steps.push({
        action: 'reuse',
        name: existing.name || segment,
        folderId: existing.id,
        parentId: cursor,
        folder: summarizeAssetFolder(existing),
      })
      cursor = existing.id
      continue
    }

    const name = existing && !allowDuplicateName
      ? makeUniqueFolderName(segment, simulatedFolders, cursor)
      : segment
    const planned = {
      id: null,
      name,
      parentId: cursor,
      color: null,
    }
    steps.push({
      action: 'create',
      name,
      requestedName: segment,
      nameAdjusted: name !== segment,
      parentId: cursor,
      folder: planned,
    })
    simulatedFolders.push({
      id: `planned-folder-${steps.length}`,
      ...planned,
    })
    cursor = `planned-folder-${steps.length}`
  }

  const lastStep = steps[steps.length - 1] || null
  const leafExistingFolder = lastStep?.action === 'reuse'
    ? folders.find((folder) => folder?.id === lastStep.folderId) || null
    : null

  return {
    action: 'create_asset_folder',
    previewOnly: args.previewOnly !== false,
    path: [...(parent.parentPath || []), ...nameSegments],
    requestedPath: nameSegments,
    parentId: parent.parentId || null,
    reuseExisting,
    allowDuplicateName,
    color,
    setColorOnExisting: args.setColorOnExisting === true,
    steps,
    createdCount: steps.filter((step) => step.action === 'create').length,
    reusedCount: steps.filter((step) => step.action === 'reuse').length,
    leafFolder: summarizeAssetFolder(leafExistingFolder),
    leafFolderId: leafExistingFolder?.id || null,
  }
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return normalizeStringArray(value)
  const raw = String(value || '').trim()
  if (!raw) return []
  return raw.split(',').map((item) => item.trim()).filter(Boolean)
}

function resolveFolderIdByPath(folders = [], pathSegments = []) {
  const segments = Array.isArray(pathSegments) ? pathSegments : []
  let cursor = null
  for (const segment of segments) {
    const folder = findAssetFolderByName(folders, cursor, segment)
    if (!folder) return null
    cursor = folder.id
  }
  return cursor
}

function getDescendantFolderIds(folders = [], folderId = null) {
  const ids = new Set()
  if (!folderId) return ids
  ids.add(folderId)
  let changed = true
  while (changed) {
    changed = false
    for (const folder of folders || []) {
      if (!folder?.id || ids.has(folder.id)) continue
      if (ids.has(folder.parentId || null)) {
        ids.add(folder.id)
        changed = true
      }
    }
  }
  return ids
}

function getMoveAssetCreatedTime(asset) {
  const raw = asset?.createdAt || asset?.imported || asset?.created || asset?.modified || ''
  const parsed = raw ? Date.parse(raw) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function isSolidColorAssetForMove(asset = {}) {
  const sourceTool = String(asset.sourceTool || asset.settings?.sourceTool || '').trim().toLowerCase()
  const overlayKind = String(asset.overlayKind || asset.settings?.overlayKind || '').trim().toLowerCase()
  const generatedBy = String(asset.generatedBy || asset.settings?.generatedBy || '').trim().toLowerCase()
  const solidColor = String(asset.solidColor || asset.settings?.solidColor || asset.settings?.color || asset.color || '').trim()
  const name = String(asset.name || '').trim().toLowerCase()
  return sourceTool === 'add_solid_color'
    || (overlayKind === 'color' && (generatedBy === 'mcp' || /^#[0-9a-fA-F]{6}$/.test(solidColor)))
    || (String(asset.type || '').toLowerCase() === 'image' && name.includes('solid') && /^#[0-9a-fA-F]{6}$/.test(solidColor))
}

function summarizeAssetForOrganization(asset = {}, folders = []) {
  const folderId = asset.folderId || null
  return {
    id: asset.id,
    name: asset.name || asset.id,
    type: asset.type || 'unknown',
    folderId,
    folderPath: folderId ? getAssetFolderPathSegments(folders, folderId) : [],
    workflowId: asset.workflowId || '',
    workflowName: asset.workflowName || '',
    sourceTool: asset.sourceTool || asset.settings?.sourceTool || '',
    overlayKind: asset.overlayKind || asset.settings?.overlayKind || '',
    generatedBy: asset.generatedBy || asset.settings?.generatedBy || '',
    solidColor: asset.solidColor || asset.settings?.solidColor || asset.settings?.color || asset.color || '',
    createdAt: asset.createdAt || asset.imported || null,
  }
}

function resolveAssetMoveTargetFolder(snapshot, args = {}) {
  const folders = Array.isArray(snapshot?.folders) ? snapshot.folders : []
  const wantsRoot = args.targetRoot === true
    || args.root === true
    || ['root', 'none', 'null'].includes(String(args.targetFolderPath || args.folderPath || args.targetFolderName || args.folderName || '').trim().toLowerCase())
  if (wantsRoot) {
    return {
      targetFolderId: null,
      targetFolder: null,
      targetFolderPath: [],
      targetWillBeCreated: false,
      createPlan: null,
    }
  }

  const targetFolderId = String(args.targetFolderId || args.folderId || '').trim()
  if (targetFolderId) {
    const folder = folders.find((candidate) => candidate?.id === targetFolderId) || null
    if (!folder) return { error: `Target folder ${targetFolderId} was not found.` }
    return {
      targetFolderId,
      targetFolder: summarizeAssetFolder(folder),
      targetFolderPath: getAssetFolderPathSegments(folders, targetFolderId),
      targetWillBeCreated: false,
      createPlan: null,
    }
  }

  const rawPath = args.targetFolderPath ?? args.folderPath ?? args.targetPath ?? args.path ?? args.targetFolderName ?? args.folderName ?? args.name
  const targetPath = splitFolderPathInput(rawPath)
  if (targetPath.length === 0) return { error: 'Provide targetFolderId, targetFolderPath, folderName, or targetRoot=true.' }

  const existingFolderId = resolveFolderIdByPath(folders, targetPath)
  if (existingFolderId) {
    const folder = folders.find((candidate) => candidate?.id === existingFolderId) || null
    return {
      targetFolderId: existingFolderId,
      targetFolder: summarizeAssetFolder(folder),
      targetFolderPath: getAssetFolderPathSegments(folders, existingFolderId),
      targetWillBeCreated: false,
      createPlan: null,
    }
  }

  const createPlan = resolveCreateAssetFolderPlan(snapshot, {
    path: targetPath,
    color: args.targetFolderColor || args.folderColor || args.color || '',
    reuseExisting: args.reuseExisting !== false,
    allowDuplicateName: args.allowDuplicateName === true,
    previewOnly: true,
  })
  if (createPlan.error) return { error: createPlan.error }

  return {
    targetFolderId: createPlan.leafFolderId || null,
    targetFolder: createPlan.leafFolder || null,
    targetFolderPath: createPlan.path || targetPath,
    targetWillBeCreated: createPlan.createdCount > 0,
    createPlan,
  }
}

function resolveAssetSourceFolderFilter(snapshot, args = {}) {
  const folders = Array.isArray(snapshot?.folders) ? snapshot.folders : []
  const rootOnly = args.rootOnly === true || args.sourceRoot === true || args.fromRoot === true
  if (rootOnly) return { mode: 'root', folderIds: new Set([null]), sourceFolderPath: [] }

  const sourceFolderId = String(args.sourceFolderId || args.fromFolderId || '').trim()
  const sourceFolderPath = splitFolderPathInput(args.sourceFolderPath || args.fromFolderPath || [])
  let resolvedSourceFolderId = null
  if (sourceFolderId) {
    const folder = folders.find((candidate) => candidate?.id === sourceFolderId) || null
    if (!folder) return { error: `Source folder ${sourceFolderId} was not found.` }
    resolvedSourceFolderId = sourceFolderId
  } else if (sourceFolderPath.length > 0) {
    resolvedSourceFolderId = resolveFolderIdByPath(folders, sourceFolderPath)
    if (!resolvedSourceFolderId) return { error: `Source folder path "${sourceFolderPath.join(' / ')}" was not found.` }
  }

  if (!resolvedSourceFolderId) return { mode: 'all', folderIds: null, sourceFolderPath: [] }

  const includeSubfolders = args.includeSubfolders !== false
  const folderIds = includeSubfolders
    ? getDescendantFolderIds(folders, resolvedSourceFolderId)
    : new Set([resolvedSourceFolderId])

  return {
    mode: includeSubfolders ? 'sourceFolderWithSubfolders' : 'sourceFolder',
    folderIds,
    sourceFolderPath: getAssetFolderPathSegments(folders, resolvedSourceFolderId),
  }
}

function resolveAssetsForFolderMove(snapshot, args = {}, target = {}) {
  const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : []
  const source = resolveAssetSourceFolderFilter(snapshot, args)
  if (source.error) return { error: source.error }

  const explicitEntries = []
  if (Array.isArray(args.assets)) explicitEntries.push(...args.assets)
  if (args.assetId) explicitEntries.push(args.assetId)
  for (const assetId of normalizeStringList(args.assetIds)) explicitEntries.push({ assetId })
  for (const assetName of normalizeStringList(args.assetNames || args.assetName)) explicitEntries.push({ assetName })

  let candidates = []
  const missingAssetIds = []
  const missingAssetNames = []

  if (explicitEntries.length > 0) {
    const byId = new Map(assets.map((asset) => [asset?.id, asset]).filter(([id]) => id))
    const seen = new Set()
    for (const rawEntry of explicitEntries) {
      const entry = typeof rawEntry === 'string' ? { assetId: rawEntry } : (rawEntry || {})
      const assetId = String(entry.assetId || entry.id || '').trim()
      const assetName = String(entry.assetName || entry.name || '').trim().toLowerCase()
      let asset = assetId ? byId.get(assetId) : null
      if (!asset && assetName) {
        asset = assets.find((candidate) => String(candidate?.name || '').trim().toLowerCase() === assetName)
          || assets.find((candidate) => String(candidate?.name || '').trim().toLowerCase().includes(assetName))
      }
      if (!asset) {
        if (assetId) missingAssetIds.push(assetId)
        if (assetName) missingAssetNames.push(entry.assetName || entry.name)
        continue
      }
      if (!seen.has(asset.id)) {
        candidates.push(asset)
        seen.add(asset.id)
      }
    }
  } else {
    candidates = assets.slice()
  }

  const typeFilters = normalizeStringList(args.types || args.type || args.assetType).map((type) => type.toLowerCase())
  if (typeFilters.length > 0) {
    candidates = candidates.filter((asset) => typeFilters.includes(String(asset?.type || '').toLowerCase()))
  }

  const workflowIds = normalizeStringList(args.workflowIds || args.workflowId).map((id) => id.toLowerCase())
  if (workflowIds.length > 0) {
    candidates = candidates.filter((asset) => workflowIds.includes(getAssetWorkflowId(asset)))
  }

  const query = String(args.nameIncludes || args.nameContains || args.search || args.query || '').trim().toLowerCase()
  if (query) {
    candidates = candidates.filter((asset) => String(asset?.name || '').toLowerCase().includes(query))
  }

  const filter = String(args.filter || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  const solidColorsOnly = args.solidColorsOnly === true
    || args.constantsOnly === true
    || args.solidOnly === true
    || ['solid', 'solids', 'solidcolor', 'solidcolors', 'constant', 'constants'].includes(filter)
  if (solidColorsOnly) {
    candidates = candidates.filter(isSolidColorAssetForMove)
  }

  if (filter === 'generated') candidates = candidates.filter((asset) => asset?.isImported !== true)
  if (filter === 'imported') candidates = candidates.filter((asset) => asset?.isImported === true)

  if (source.folderIds) {
    candidates = candidates.filter((asset) => {
      const folderId = asset?.folderId || null
      return source.folderIds.has(folderId)
    })
  }

  const statuses = normalizeStringList(args.statuses || args.status).map((status) => status.toLowerCase())
  if (statuses.length > 0) {
    candidates = candidates.filter((asset) => statuses.includes(String(asset?.generationStatus || asset?.status || 'none').toLowerCase()))
  }

  const order = String(args.order || args.sortOrder || 'oldest_first').trim().toLowerCase()
  candidates = candidates
    .filter((asset) => asset?.id)
    .sort((a, b) => order === 'newest_first'
      ? getMoveAssetCreatedTime(b) - getMoveAssetCreatedTime(a)
      : getMoveAssetCreatedTime(a) - getMoveAssetCreatedTime(b))

  const targetFolderId = target.targetWillBeCreated ? '__new_target_folder__' : (target.targetFolderId || null)
  const unchangedAssets = target.targetWillBeCreated
    ? []
    : candidates.filter((asset) => (asset?.folderId || null) === targetFolderId)
  const assetsToMove = target.targetWillBeCreated
    ? candidates
    : candidates.filter((asset) => (asset?.folderId || null) !== targetFolderId)

  return {
    source,
    candidates,
    assetsToMove,
    unchangedAssets,
    missingAssetIds,
    missingAssetNames,
    mode: explicitEntries.length > 0 ? 'explicit' : 'filter',
    filters: {
      typeFilters,
      workflowIds,
      query,
      filter,
      solidColorsOnly,
      statuses,
    },
  }
}

function resolveMoveAssetsToFolderPlan(snapshot, args = {}) {
  const project = snapshot?.project || null
  if (!project) return { error: 'Open a saved ComfyStudio project before moving assets.' }

  const folders = Array.isArray(snapshot?.folders) ? snapshot.folders : []
  const target = resolveAssetMoveTargetFolder(snapshot, args)
  if (target.error) return { error: target.error }

  const resolvedAssets = resolveAssetsForFolderMove(snapshot, args, target)
  if (resolvedAssets.error) return { error: resolvedAssets.error }

  const limit = clampLimit(args.limit, 100, 1000)
  if (resolvedAssets.assetsToMove.length > limit) {
    return {
      error: `Matched ${resolvedAssets.assetsToMove.length} assets to move, above limit ${limit}. Pass a higher limit intentionally if this is expected.`,
    }
  }

  return {
    action: 'move_assets_to_folder',
    previewOnly: args.previewOnly !== false,
    mode: resolvedAssets.mode,
    targetFolderId: target.targetFolderId,
    targetFolder: target.targetFolder,
    targetFolderPath: target.targetFolderPath,
    targetRoot: target.targetFolderId === null && !target.targetWillBeCreated,
    targetWillBeCreated: target.targetWillBeCreated,
    createTargetFolderPlan: target.createPlan,
    sourceMode: resolvedAssets.source.mode,
    sourceFolderPath: resolvedAssets.source.sourceFolderPath || [],
    filters: resolvedAssets.filters,
    candidateCount: resolvedAssets.candidates.length,
    moveCount: resolvedAssets.assetsToMove.length,
    unchangedCount: resolvedAssets.unchangedAssets.length,
    missingAssetIds: resolvedAssets.missingAssetIds,
    missingAssetNames: resolvedAssets.missingAssetNames,
    assets: resolvedAssets.assetsToMove.map((asset) => summarizeAssetForOrganization(asset, folders)),
    unchangedAssets: resolvedAssets.unchangedAssets.slice(0, 50).map((asset) => summarizeAssetForOrganization(asset, folders)),
  }
}

function getAssetWorkflowId(asset) {
  return String(asset?.workflowId || asset?.settings?.workflowId || '').trim().toLowerCase()
}

function resolveAssetsForTimelineBatchPlacement(snapshot, args = {}) {
  const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : []
  const explicitEntries = []

  if (Array.isArray(args.assets)) {
    explicitEntries.push(...args.assets)
  }
  if (Array.isArray(args.assetIds)) {
    explicitEntries.push(...args.assetIds.map((assetId) => ({ assetId })))
  }
  if (Array.isArray(args.assetNames)) {
    explicitEntries.push(...args.assetNames.map((assetName) => ({ assetName })))
  }

  if (explicitEntries.length > 0) {
    const seen = new Set()
    const items = []
    for (const rawEntry of explicitEntries) {
      const entry = typeof rawEntry === 'string' ? { assetId: rawEntry } : (rawEntry || {})
      const resolved = resolveAssetForTimelinePlacement(snapshot, { ...args, ...entry })
      if (resolved.error) return { error: resolved.error }
      if (!resolved.asset?.id || seen.has(resolved.asset.id)) continue
      seen.add(resolved.asset.id)
      items.push({ asset: resolved.asset, entry })
    }
    if (items.length === 0) return { error: 'No unique placeable assets were resolved for batch placement.' }
    if (items.length > MCP_ASSET_BATCH_MAX_ITEMS) return { error: `Batch placement is limited to ${MCP_ASSET_BATCH_MAX_ITEMS} assets.` }
    return { items }
  }

  const type = String(args.type || args.assetType || '').trim().toLowerCase()
  const workflowIds = normalizeStringList(args.workflowIds || args.workflowId).map((id) => id.toLowerCase())
  const requestedStatuses = normalizeStringList(args.statuses || args.status).map((status) => status.toLowerCase())
  const allowedStatuses = requestedStatuses.length > 0
    ? new Set(requestedStatuses)
    : new Set(['none', 'done', 'complete', 'completed', 'success', ''])

  let candidates = assets.filter(isPlaceableTimelineAsset)
  if (type) candidates = candidates.filter((asset) => String(asset?.type || '').toLowerCase() === type)
  if (workflowIds.length > 0) {
    candidates = candidates.filter((asset) => workflowIds.includes(getAssetWorkflowId(asset)))
  }
  candidates = candidates.filter((asset) => allowedStatuses.has(String(asset?.generationStatus || asset?.status || 'none').toLowerCase()))

  if (candidates.length === 0) {
    return { error: 'No matching placeable assets were found for batch placement.' }
  }

  const requestedCount = Number(args.latestCount ?? args.count ?? args.limit)
  const count = Number.isFinite(requestedCount) && requestedCount > 0
    ? Math.min(MCP_ASSET_BATCH_MAX_ITEMS, Math.floor(requestedCount))
    : Math.min(6, candidates.length, MCP_ASSET_BATCH_MAX_ITEMS)
  const newestFirst = candidates
    .slice()
    .sort((a, b) => getPlacementAssetCreatedTime(b) - getPlacementAssetCreatedTime(a))
    .slice(0, count)
  const order = String(args.order || args.sortOrder || 'oldest_first').trim().toLowerCase()
  const selected = order === 'newest_first' ? newestFirst : newestFirst.reverse()

  return {
    items: selected.map((asset) => ({ asset, entry: {} })),
  }
}

function normalizeAssetBatchTrackStrategy(value, count) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (['single', 'singletrack', 'singleexisting', 'existing', 'existingtrack', 'onetrack', 'sametrack'].includes(normalized)) {
    return 'single_track'
  }
  if (['sequential', 'singletracksequential'].includes(normalized)) return 'single_track'
  if (count <= 1 && ['auto', ''].includes(normalized)) return 'new_tracks'
  return 'new_tracks'
}

function normalizeAssetBatchLayout(value, trackStrategy) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (['sequential', 'sequence', 'append', 'sidebysideintime'].includes(normalized)) return 'sequential'
  if (['stack', 'stacked', 'lanes', 'reviewlanes', 'same start', 'samestart'].includes(normalized)) return 'stacked'
  return trackStrategy === 'single_track' ? 'sequential' : 'stacked'
}

function formatBatchTrackName(template, asset, index, total, fallbackPrefix = 'MCP Review') {
  const workflow = asset?.workflowName || asset?.workflowId || asset?.model || asset?.type || 'Asset'
  const assetName = asset?.name || asset?.id || `Asset ${index + 1}`
  const raw = String(template || '').trim()
    || `${fallbackPrefix} ${index + 1} - ${workflow}`
  return raw
    .replace(/\{index\}/gi, String(index + 1))
    .replace(/\{number\}/gi, String(index + 1))
    .replace(/\{total\}/gi, String(total))
    .replace(/\{asset\}/gi, assetName)
    .replace(/\{name\}/gi, assetName)
    .replace(/\{workflow\}/gi, workflow)
    .slice(0, 100)
}

function getBatchPlacementLabelColor(args = {}, entry = {}, index = 0) {
  const labelColors = Array.isArray(args.labelColors) ? args.labelColors : []
  const rawColor = entry.labelColor ?? labelColors[index] ?? args.labelColor ?? args.color ?? ''
  if (hasInvalidClipLabelColor(rawColor)) {
    return { error: 'Invalid label color. Use a hex color like #f97316, or omit labelColor.' }
  }
  return { color: normalizeClipLabelColor(rawColor) }
}

function getBatchPlacementDuration(asset, args = {}, entry = {}) {
  const requestedDuration = Number(entry.durationSeconds ?? entry.duration ?? args.durationSeconds ?? args.duration)
  if (Number.isFinite(requestedDuration) && requestedDuration > 0) return roundTime(requestedDuration)
  const assetDuration = toFiniteNumber(asset?.duration, 0)
  return asset?.type === 'image' ? 5 : roundTime(assetDuration || 5)
}

function resolveAssetsTimelinePlacementPlan(snapshot, args = {}) {
  const timeline = snapshot?.currentTimeline || null
  if (!timeline) return { error: 'No current timeline is available.' }

  const resolvedAssets = resolveAssetsForTimelineBatchPlacement(snapshot, args)
  if (resolvedAssets.error) return { error: resolvedAssets.error }
  const items = resolvedAssets.items || []
  if (items.length === 0) return { error: 'No assets were resolved for batch placement.' }
  if (items.length > MCP_ASSET_BATCH_MAX_ITEMS) return { error: `Batch placement is limited to ${MCP_ASSET_BATCH_MAX_ITEMS} assets.` }

  const trackStrategy = normalizeAssetBatchTrackStrategy(args.trackStrategy || args.placementTrack, items.length)
  const layout = normalizeAssetBatchLayout(args.layout || args.placementLayout, trackStrategy)
  const includeLinkedAudio = shouldPlanBatchLinkedVideoAudio(args, layout)
  const spacingSeconds = Math.max(0, toFiniteNumber(args.spacingSeconds ?? args.spacing, 0))
  const baseStartSeconds = resolveAssetPlacementStart(timeline, String(args.trackId || '').trim(), args)
  const trackNamePrefix = String(args.trackNamePrefix || args.trackPrefix || 'MCP Review').trim() || 'MCP Review'
  const trackNameTemplate = args.trackNameTemplate || args.trackTemplate || ''
  const placements = []

  if (trackStrategy === 'single_track') {
    const targetTypes = [...new Set(items.map(({ asset }) => getCompatibleTrackTypeForPlacementAsset(asset)))]
    if (targetTypes.length !== 1 || !targetTypes[0]) {
      return { error: 'Single-track batch placement requires all assets to use the same compatible track type.' }
    }

    const sharedTrack = resolveAssetPlacementTrack(timeline, items[0].asset, {
      ...args,
      createTrack: args.createTrack !== false && args.newTrack !== false && !args.trackId,
      newTrack: args.createTrack !== false && args.newTrack !== false && !args.trackId,
      trackName: args.trackName || `${trackNamePrefix} Batch`,
    })
    if (sharedTrack.error) return { error: sharedTrack.error }

    let cursor = baseStartSeconds
    for (let index = 0; index < items.length; index += 1) {
      const { asset, entry } = items[index]
      const durationSeconds = getBatchPlacementDuration(asset, args, entry)
      const colorResult = getBatchPlacementLabelColor(args, entry, index)
      if (colorResult.error) return { error: colorResult.error }
      const startSeconds = layout === 'sequential' ? cursor : baseStartSeconds
      placements.push({
        index,
        asset: summarizeAssetForPlacement(asset),
        track: sharedTrack.track ? {
          id: sharedTrack.track.id,
          name: sharedTrack.track.name,
          type: sharedTrack.track.type,
          locked: Boolean(sharedTrack.track.locked),
          muted: Boolean(sharedTrack.track.muted),
          visible: sharedTrack.track.visible !== false,
        } : {
          id: null,
          name: sharedTrack.plannedTrack?.name || `${trackNamePrefix} Batch`,
          type: sharedTrack.targetType,
          locked: false,
          muted: false,
          visible: true,
        },
        createTrack: sharedTrack.createTrack === true,
        startSeconds,
        durationSeconds,
        linkedAudio: includeLinkedAudio
          ? buildLinkedAudioPlacementPlan(timeline, asset, { ...args, includeAudio: true })
          : null,
        labelColor: colorResult.color,
        transform: entry.transform && typeof entry.transform === 'object'
          ? entry.transform
          : (args.transform && typeof args.transform === 'object' ? args.transform : null),
      })
      cursor = roundTime(startSeconds + durationSeconds + spacingSeconds)
    }
  } else {
    let cursor = baseStartSeconds
    for (let index = 0; index < items.length; index += 1) {
      const { asset, entry } = items[index]
      const targetType = getCompatibleTrackTypeForPlacementAsset(asset)
      if (!targetType) return { error: `Asset ${asset?.name || asset?.id || index + 1} cannot be placed on a timeline track.` }
      const durationSeconds = getBatchPlacementDuration(asset, args, entry)
      const colorResult = getBatchPlacementLabelColor(args, entry, index)
      if (colorResult.error) return { error: colorResult.error }
      const startSeconds = layout === 'sequential' ? cursor : baseStartSeconds
      const trackName = String(entry.trackName || '').trim()
        || formatBatchTrackName(trackNameTemplate, asset, index, items.length, trackNamePrefix)
      placements.push({
        index,
        asset: summarizeAssetForPlacement(asset),
        track: {
          id: null,
          name: trackName,
          type: targetType,
          locked: false,
          muted: false,
          visible: true,
        },
        createTrack: true,
        startSeconds,
        durationSeconds,
        linkedAudio: includeLinkedAudio
          ? buildLinkedAudioPlacementPlan(timeline, asset, { ...args, includeAudio: true })
          : null,
        labelColor: colorResult.color,
        transform: entry.transform && typeof entry.transform === 'object'
          ? entry.transform
          : (args.transform && typeof args.transform === 'object' ? args.transform : null),
      })
      cursor = roundTime(startSeconds + durationSeconds + spacingSeconds)
    }
  }

  return {
    action: 'add_assets_to_timeline',
    previewOnly: args.previewOnly !== false,
    assetCount: placements.length,
    layout,
    trackStrategy,
    includeAudio: includeLinkedAudio,
    baseStartSeconds,
    spacingSeconds,
    resolveOverlaps: args.resolveOverlaps !== false,
    selectAfterAdd: args.selectAfterAdd !== false,
    placements,
  }
}

function resolveTimelineMarkerInputs(snapshot, args = {}) {
  const timeline = snapshot?.currentTimeline || null
  if (!timeline) {
    return { error: 'No current timeline is available.', markers: [] }
  }

  const fps = Math.max(1, toFiniteNumber(timeline?.fps, 24))
  const duration = Math.max(0, toFiniteNumber(timeline?.duration, 0))
  const playhead = toFiniteNumber(timeline?.playheadPosition, 0)
  const rawEntries = Array.isArray(args.markers) && args.markers.length > 0
    ? args.markers
    : [{
      timeSeconds: args.timeSeconds,
      time: args.time,
      frame: args.frame,
      label: args.label,
      name: args.name,
      color: args.color,
    }]

  const defaultColor = normalizeClipLabelColor(args.color) || '#f5c451'
  const markers = []
  for (const [index, entry] of rawEntries.entries()) {
    const rawColor = String(entry?.color || args.color || '').trim()
    if (rawColor && !normalizeClipLabelColor(rawColor)) {
      return { error: `Invalid marker color for marker ${index + 1}. Use a hex color like #f97316.`, markers: [] }
    }

    const explicitTime = Number(entry?.timeSeconds ?? entry?.time)
    const explicitFrame = Number(entry?.frame)
    const rawTime = Number.isFinite(explicitTime)
      ? explicitTime
      : Number.isFinite(explicitFrame)
        ? explicitFrame / fps
        : playhead
    const clampedTime = duration > 0
      ? Math.min(Math.max(0, rawTime), duration)
      : Math.max(0, rawTime)
    const frame = Math.max(0, Math.round(clampedTime * fps))
    const timeSeconds = roundTime(frame / fps)
    const label = String(entry?.label || entry?.name || args.label || '').trim().slice(0, 160)
    markers.push({
      timeSeconds,
      frame,
      timecode: formatTimelineTimecode(timeSeconds, fps),
      label,
      color: normalizeClipLabelColor(rawColor) || defaultColor,
    })
  }

  return { markers }
}

function markerRef(marker, fps = 24) {
  return {
    id: marker?.id,
    time: roundTime(toFiniteNumber(marker?.time, 0)),
    timecode: formatTimelineTimecode(toFiniteNumber(marker?.time, 0), fps),
    label: marker?.label || marker?.name || '',
    color: marker?.color || '',
  }
}

function resolveTimelineMarkerRemovalTargets(snapshot, args = {}) {
  const timeline = snapshot?.currentTimeline || null
  if (!timeline) {
    return { error: 'No current timeline is available.', markers: [], missingMarkerIds: [] }
  }

  const fps = Math.max(1, toFiniteNumber(timeline?.fps, 24))
  const markers = Array.isArray(timeline.markers) ? timeline.markers : []
  const markerIds = normalizeStringArray(args.markerIds)
  const color = normalizeClipLabelColor(args.color)
  const rawColor = String(args.color || '').trim()
  const labelContains = String(args.labelContains || args.label || '').trim().toLowerCase()
  const startSeconds = Number(args.startSeconds)
  const endSeconds = Number(args.endSeconds)
  const hasStart = Number.isFinite(startSeconds)
  const hasEnd = Number.isFinite(endSeconds)

  if (rawColor && !color) {
    return { error: 'Invalid marker color. Use a hex color like #f97316.', markers: [], missingMarkerIds: [] }
  }

  if (args.all === true) {
    return { mode: 'all', markers, missingMarkerIds: [] }
  }

  if (markerIds.length > 0) {
    const byId = new Map(markers.map((marker) => [marker?.id, marker]).filter(([id]) => id))
    const targetMarkers = markerIds.map((markerId) => byId.get(markerId)).filter(Boolean)
    const foundIds = new Set(targetMarkers.map((marker) => marker.id))
    return {
      mode: 'markerIds',
      markers: targetMarkers,
      missingMarkerIds: markerIds.filter((markerId) => !foundIds.has(markerId)),
    }
  }

  if (color || labelContains || hasStart || hasEnd) {
    return {
      mode: 'filter',
      markers: markers.filter((marker) => {
        const markerTime = toFiniteNumber(marker?.time, 0)
        if (color && normalizeClipLabelColor(marker?.color) !== color) return false
        if (labelContains && !String(marker?.label || marker?.name || '').toLowerCase().includes(labelContains)) return false
        if (hasStart && markerTime < startSeconds) return false
        if (hasEnd && markerTime > endSeconds + (1 / fps)) return false
        return true
      }),
      missingMarkerIds: [],
    }
  }

  return {
    error: 'Provide all=true, markerIds, color, labelContains, or a time range to remove timeline markers.',
    markers: [],
    missingMarkerIds: [],
  }
}

function buildAiReviewPasses(snapshot) {
  const timeline = snapshot?.currentTimeline || null
  const fps = Math.max(1, toFiniteNumber(timeline?.fps, 24))
  const duration = Math.max(0, toFiniteNumber(timeline?.duration, 0))
  const clips = Array.isArray(timeline?.clips) ? timeline.clips : []
  const markers = Array.isArray(timeline?.markers) ? timeline.markers : []
  const visibleClipCount = clips.filter((clip) => clip?.enabled !== false && isAssetBackedClip(clip)).length
  const disabledClipCount = clips.filter((clip) => clip?.enabled === false).length
  const transformedClipCount = clips.filter((clip) => hasNonDefaultTransform(clip?.transform)).length

  const suggestedChunkSeconds = duration > 180 ? 45 : duration > 90 ? 30 : 20
  const suggestedShotLimit = duration > 180 ? 40 : 30

  return {
    purpose: 'Use these recipes as safe AI review passes for the open ComfyStudio project. Prefer previewOnly before write actions that alter clips or markers.',
    timeline: timeline ? {
      id: timeline.id,
      name: timeline.name,
      duration: roundTime(duration),
      fps,
      timecodeEnd: formatTimelineTimecode(duration, fps),
      trackCount: Array.isArray(timeline.tracks) ? timeline.tracks.length : 0,
      clipCount: clips.length,
      visibleClipCount,
      disabledClipCount,
      transformedClipCount,
      markerCount: markers.length,
    } : null,
    markerColors: {
      problem: '#ffa500',
      urgent: '#ef4444',
      approved: '#22c55e',
      question: '#38bdf8',
      note: '#f5c451',
    },
    recipes: [
      {
        id: 'timeline_health',
        title: 'Timeline Health Pass',
        goal: 'Find mechanical risks before export: missing assets, disabled clips, tiny clips/gaps, transforms, sync locks, XML imports, and suspicious layout.',
        prompt: 'Analyze the active timeline for export risks. Summarize blockers and warnings, then mark only the urgent spots with red timeline markers after showing me previewOnly first.',
        tools: ['analyze_timeline', 'add_timeline_markers'],
        safeDefaults: {
          maxFindings: 75,
          markerColor: '#ef4444',
          previewOnlyFirst: true,
        },
      },
      {
        id: 'visible_shot_review',
        title: 'Visible Shot Review',
        goal: 'Inspect what is actually visible shot-by-shot, not just what clips exist underneath other tracks.',
        prompt: `Review the active timeline in ${suggestedChunkSeconds}s chunks. Use visible shot inspection, describe what each chunk shows, and add orange markers on shots that look wrong or off-story. Use previewOnly before applying markers.`,
        tools: ['inspect_visible_shots', 'add_timeline_markers'],
        safeDefaults: {
          durationSeconds: suggestedChunkSeconds,
          limit: suggestedShotLimit,
          offsetFrames: 2,
          markerColor: '#ffa500',
          previewOnlyFirst: true,
        },
      },
      {
        id: 'hero_presence',
        title: 'Hero Presence Pass',
        goal: 'Check visible shots for whether a requested subject, character, product, or location is actually on screen.',
        prompt: 'Inspect the visible shots and mark every shot where the hero is not visible. Start with the next 20 visible shots, previewOnly first, then ask before marking the rest.',
        tools: ['inspect_visible_shots', 'add_timeline_markers'],
        safeDefaults: {
          limit: 20,
          offsetFrames: 2,
          markerLabel: 'Hero not visible',
          markerColor: '#ffa500',
          previewOnlyFirst: true,
        },
      },
      {
        id: 'disabled_clip_cleanup',
        title: 'Disabled Clip Cleanup Pass',
        goal: 'Surface disabled clips without deleting anything automatically.',
        prompt: 'Find disabled timeline clips, tell me how many there are, then color-label them orange so I can decide what to delete manually.',
        tools: ['analyze_timeline', 'set_clip_label_color'],
        safeDefaults: {
          filter: 'disabled',
          labelColor: '#ffa500',
          destructive: false,
        },
      },
      {
        id: 'marker_cleanup',
        title: 'Marker Cleanup Pass',
        goal: 'Manage AI review markers after a review pass.',
        prompt: 'Show me how many AI review markers are on the timeline. If I approve, remove the orange review markers and leave my other markers alone.',
        tools: ['get_timeline', 'set_timeline_marker_properties', 'remove_timeline_markers'],
        safeDefaults: {
          color: '#ffa500',
          previewOnlyFirst: true,
        },
      },
      {
        id: 'asset_folder_cleanup',
        title: 'Asset Folder Cleanup Pass',
        goal: 'Organize generated/imported project assets without deleting anything.',
        prompt: 'Find assets that match my cleanup request, preview the exact assets and destination folder first, then move them only after I approve. For MCP-created solid/color constants in the root, use rootOnly plus constantsOnly and move them into a Constants folder.',
        tools: ['get_assets', 'create_asset_folder', 'move_assets_to_folder'],
        safeDefaults: {
          previewOnlyFirst: true,
          destructive: false,
          createMissingTargetFolder: true,
          usefulFilters: ['rootOnly', 'constantsOnly', 'type', 'nameIncludes', 'workflowId'],
        },
      },
      {
        id: 'clip_enable_disable',
        title: 'Clip Enable/Disable Pass',
        goal: 'Preview and apply simple editorial decisions by enabling or disabling exact timeline clips.',
        prompt: 'Find the clips that match my instruction, show me the exact clips you would enable or disable with previewOnly first, then apply only after I approve. Do not delete clips.',
        tools: ['inspect_visible_shots', 'get_timeline', 'set_clips_enabled'],
        safeDefaults: {
          previewOnlyFirst: true,
          destructive: false,
          useExplicitClipIds: true,
        },
      },
      {
        id: 'sequence_setup',
        title: 'Sequence Setup Pass',
        goal: 'Create a named sequence/timeline for alternate edits, selects, generated variations, or AI-built review layouts.',
        prompt: 'If I ask for a new sequence, preview the sequence name/settings first. After I approve, create it and switch into it before placing clips, solids, titles, or generated assets.',
        tools: ['get_project', 'get_timeline', 'create_timeline'],
        safeDefaults: {
          previewOnlyFirst: true,
          switchToTimeline: true,
          copySettingsFromCurrent: true,
        },
      },
      {
        id: 'text_motion_graphics',
        title: 'Text And Motion Graphics Pass',
        goal: 'Create tracks, text clips, and basic shape clips; adjust typography/shape styling; crop/move/scale/rotate/blur them; and set explicit transform/color keyframes for simple motion graphics.',
        prompt: 'Create a text title or basic shape at the playhead, preview the timing/style/transform first, then add it. Use add_shape_clip for rectangles, rounded rectangles, ellipses, polygons, lines, lower-third bars, frames, simple graphic accents, color blocks, and animated UI-style elements. For triangles/hexagons/octagons, use shapeType polygon with sides 3/6/8. If I ask for another layer, create a new top video track first. If I ask for a split or cloned title effect, use duplicate_clip to clone the existing text/shape clip, set static crop percentages on each copy, then animate each layer separately. If I ask for motion, shape-size/style changes, or color changes, use explicit keyframes so I can ask for things like faster, lower, blur, rotate, bounce, gravity, grow, pulse stroke width, round the corners over time, or change color. Use motionBlurEnabled with motionBlurMode auto/velocity/sampled, motionBlurSamples, and motionBlurShutter when fast-moving graphics should smear naturally. For richer motion, use easing strings like cubicBezier(0.55,0,1,0.45). Use set_clip_keyframes for generic visual keyframes once the clip already exists.',
        tools: ['get_timeline', 'inspect_timeline_frame', 'add_track', 'add_text_clip', 'add_shape_clip', 'duplicate_clip', 'update_text_clip', 'update_shape_clip', 'set_clip_keyframes'],
        safeDefaults: {
          previewOnlyFirst: true,
          useExplicitClipIdsForUpdates: true,
          createVideoTrackForNewGraphicLayer: true,
          supportedShapes: ['rectangle', 'roundedRectangle', 'ellipse', 'polygon', 'line'],
          supportedStaticCropFields: ['cropTop', 'cropBottom', 'cropLeft', 'cropRight'],
          supportedKeyframes: ['opacity', 'positionX', 'positionY', 'positionZ', 'scaleX', 'scaleY', 'rotation', 'rotationX', 'rotationY', 'perspective', 'blur', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight', 'textColor'],
          supportedEasing: ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold', 'cubicBezier(x1,y1,x2,y2)'],
        },
      },
      {
        id: 'visual_clip_keyframes',
        title: 'Visual Clip Keyframe Pass',
        goal: 'Preview and apply opacity, transform, blur, crop, color-adjustment, or shape-style keyframes on existing visual clips.',
        prompt: 'Find the exact visual clips first. Preview the keyframes before applying. Use add_solid_color first if the fade needs an explicit black/color plate underneath the clips. Use set_clip_keyframes for fades, dips to black, moves, scale, rotation, blur, crop reveals, color adjustment animation, and shape style animation such as width, height, stroke width, rounded corners, and polygon sides. For dip-to-black between clips, create or target a black solid underneath, then keyframe the outgoing clip opacity from 100 to 0 near its end and the incoming clip opacity from 0 to 100 near its start.',
        tools: ['get_timeline', 'inspect_clip', 'inspect_visible_shots', 'add_solid_color', 'set_clip_keyframes'],
        safeDefaults: {
          previewOnlyFirst: true,
          useExplicitClipIds: true,
          fadeDurationSeconds: 0.5,
          supportedKeyframes: MCP_CLIP_KEYFRAME_PROPERTIES,
        },
      },
      {
        id: 'current_frame_question',
        title: 'Current Frame Question',
        goal: 'Answer visual questions about exactly what is under the current playhead.',
        prompt: 'Inspect the current timeline frame and answer what is visible, which top clip is responsible, and whether anything looks wrong.',
        tools: ['inspect_timeline_frame'],
        safeDefaults: {
          includeImage: true,
          maxWidth: 1280,
          maxHeight: 720,
        },
      },
      {
        id: 'brief_to_generated_assets',
        title: 'Brief To Generated Assets Pass',
        goal: 'Turn a written creative brief into source images or videos that can be assembled into a new ComfyStudio sequence.',
        prompt: 'Break my brief into a small shot/asset plan first. If several new assets will be generated, use create_asset_folder with previewOnly first so the results land in a named/nested project folder instead of the asset root. Use queue_prompt_generation_batch with previewOnly first to show the exact prompts, workflows, variation counts, seeds, resolution, duration, FPS, and folderId. After I approve, queue the generation jobs. Once generated assets exist, create a new timeline if needed, place results with add_assets_to_timeline, add titles/supers/shapes, animate transform/opacity/crop/color/shape style with set_clip_keyframes, inspect sample frames, and export only after I ask.',
        tools: ['list_comfystudio_workflows', 'create_asset_folder', 'queue_prompt_generation_batch', 'get_generation_status', 'create_timeline', 'add_assets_to_timeline', 'add_text_clip', 'add_shape_clip', 'set_clip_keyframes', 'inspect_timeline_range', 'export_timeline'],
        safeDefaults: {
          previewOnlyFirst: true,
          queuesGenerationOnlyAfterApproval: true,
          placeGeneratedAssetsOnlyAfterApproval: true,
          createOutputFolderForGeneratedAssets: true,
          maxPromptBatchVariationsPerWorkflow: MCP_PROMPT_BATCH_MAX_VARIATIONS_PER_WORKFLOW,
          maxPromptBatchJobs: MCP_PROMPT_BATCH_MAX_TOTAL_JOBS,
          defaultImageWorkflowId: 'z-image-turbo',
          defaultVideoWorkflowId: 'ltx23-t2v',
        },
      },
      {
        id: 'generate_from_timeline_context',
        title: 'Generate From Timeline Context',
        goal: 'Turn the selected clip or current playhead frame into a safe Generate-tab image-to-video/keyframe request, or queue an approved multi-workflow variation batch.',
        prompt: 'Prepare the selected timeline shot for LTX 2.3 image-to-video. Preview the source frame, workflow, and prompt first; after I approve, open Generate with the frame loaded and the prompt filled in. If I ask for variations across workflows, use queue_timeline_generation_batch with previewOnly first, show the exact workflows/counts/seeds, then apply only after I approve. After generation finishes, use add_asset_to_timeline for one result or add_assets_to_timeline for multiple review lanes, always with previewOnly first.',
        tools: ['inspect_timeline_frame', 'list_comfystudio_workflows', 'prepare_generation_from_timeline_context', 'queue_prepared_generation', 'queue_timeline_generation_batch', 'add_asset_to_timeline', 'add_assets_to_timeline'],
        safeDefaults: {
          previewOnlyFirst: true,
          defaultWorkflowId: 'ltx23-i2v',
          mode: 'extend',
          queuesGenerationOnlyAfterApproval: true,
          placeGeneratedAssetsOnlyAfterApproval: true,
          maxTimelineBatchVariationsPerWorkflow: MCP_TIMELINE_BATCH_MAX_VARIATIONS_PER_WORKFLOW,
          maxTimelineBatchJobs: MCP_TIMELINE_BATCH_MAX_TOTAL_JOBS,
          openGenerateTabOnApply: true,
          defaultResultPlacementLayout: 'stacked review lanes',
        },
      },
      {
        id: 'delivery_check',
        title: 'Delivery Check',
        goal: 'Confirm the timeline is ready for a standard H.264 HD delivery export.',
        prompt: 'Check whether the active timeline is ready for H.264 HD export. Tell me any blockers or warnings. If it is ready and I ask you to continue, start the export to the project renders folder.',
        tools: ['check_export_readiness', 'export_timeline'],
        safeDefaults: {
          target: 'h264_hd',
          resolution: '1080p',
          format: 'mp4',
          videoCodec: 'h264',
          includeAudio: true,
        },
      },
    ],
    recommendedWorkflow: [
      'Call get_ai_review_passes to choose the right pass.',
      'Call analyze_timeline for mechanical issues before visual review.',
      'Use inspect_visible_shots in chunks for fast-cut music-video review.',
      'Use add_timeline_markers with previewOnly before marking many shots.',
      'Use set_timeline_marker_properties to rename/recolor review markers as decisions change.',
      'Use remove_timeline_markers with previewOnly before clearing review markers.',
      'Use move_assets_to_folder with previewOnly before organizing root assets, constants, generated results, or imported media into folders.',
      'Use add_track, add_text_clip, duplicate_clip, and update_text_clip with previewOnly for AI-assisted text/title graphics.',
      'Use create_timeline with previewOnly before creating a new named sequence for alternate edits, generated selects, or AI-built layouts.',
      'Use create_asset_folder with previewOnly before generating a batch of source assets that should stay organized in a named folder.',
      'Use add_solid_color with previewOnly before creating black/color plates, especially underneath opacity fades.',
      'Use set_clip_keyframes with previewOnly before changing visual clip opacity, transform, blur, crop, color, or shape style keyframes.',
      'Use queue_prompt_generation_batch with previewOnly and explicit approval when creating new stills/videos from a written creative brief.',
      'Use prepare_generation_from_timeline_context with previewOnly before opening Generate from a selected clip or playhead frame.',
      'Use queue_prepared_generation with previewOnly and explicit approval before starting any prepared Generate job.',
      'Use queue_timeline_generation_batch with previewOnly and explicit approval before queueing multiple timeline-frame variations across WAN 2.2/LTX 2.3.',
      'Use add_asset_to_timeline with previewOnly before placing generated assets or imported media back into the edit.',
      'Use add_assets_to_timeline with previewOnly to place multiple generated results as stacked review lanes or a sequential strip.',
    ],
    generatedAt: new Date().toISOString(),
  }
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

function resolveExportDeliveryPlan(snapshot, args = {}) {
  const timeline = snapshot?.currentTimeline || null
  const project = snapshot?.project || null
  if (!project || !timeline) {
    return { error: 'Open a saved ComfyStudio project and timeline before exporting.' }
  }

  const timelineWidth = Math.max(2, Math.round(toFiniteNumber(timeline.width, project?.settings?.width || 1920)))
  const timelineHeight = Math.max(2, Math.round(toFiniteNumber(timeline.height, project?.settings?.height || 1080)))
  const timelineFps = Math.max(1, toFiniteNumber(timeline.fps, project?.settings?.fps || 24))
  const timelineEnd = Math.max(
    0,
    ...(Array.isArray(timeline.clips) ? timeline.clips.map((clip) => getClipEnd(clip)) : [0])
  )
  const duration = Math.max(timelineEnd, toFiniteNumber(timeline.duration, 0))
  const makeEvenDimension = (value) => Math.max(2, Math.round((Number(value) || 2) / 2) * 2)
  const target = String(args.target || args.preset || 'h264_hd').trim().toLowerCase()
  const resolution = String(args.resolution || '').trim().toLowerCase()
  const aspectRatio = String(args.aspectRatio || args.aspect || '').trim().toLowerCase()
  const videoCodec = String(args.videoCodec || args.codec || 'h264').trim().toLowerCase()
  const format = String(args.format || 'mp4').trim().toLowerCase()
  const squareRequested = [
    target,
    resolution,
    aspectRatio,
  ].some((value) => ['square', '1x1', '1:1', 'square_720', 'square_1080', 'h264_square_720', 'h264_square_1080', 'h264_1x1_720', 'h264_1x1_1080'].includes(value))
  const verticalRequested = [
    target,
    resolution,
    aspectRatio,
  ].some((value) => ['vertical', 'portrait', '9x16', '9:16', 'vertical_720', 'vertical_1080', 'h264_vertical_720', 'h264_vertical_1080', 'h264_9x16_720', 'h264_9x16_1080'].includes(value))
  const requestedDeliveryFraming = String(args.deliveryFraming || args.framing || '').trim().toLowerCase()
  const deliveryFraming = ['fill', 'cover', 'center_crop', 'center-crop'].includes(requestedDeliveryFraming)
    ? 'fill'
    : ['fit', 'contain', 'letterbox'].includes(requestedDeliveryFraming)
      ? 'fit'
      : squareRequested || verticalRequested
        ? 'fill'
        : 'fit'

  let width = timelineWidth
  let height = timelineHeight
  if (resolution === 'project' || target === 'h264_project') {
    width = timelineWidth
    height = timelineHeight
  } else if (resolution === '720p' || resolution === 'hd_720p' || target === 'h264_720p') {
    width = 1280
    height = 720
  } else if (resolution === '1080p' || resolution === 'hd' || resolution === 'hd_1080p' || target === 'h264_hd' || target === 'h264_1080p') {
    width = 1920
    height = 1080
  } else if (resolution === 'timeline_half' || resolution === 'timeline-half' || target === 'h264_review_proxy') {
    width = makeEvenDimension(timelineWidth * 0.5)
    height = makeEvenDimension(timelineHeight * 0.5)
  } else if (resolution === 'custom' || Number.isFinite(Number(args.width)) || Number.isFinite(Number(args.height))) {
    width = makeEvenDimension(args.width || timelineWidth)
    height = makeEvenDimension(args.height || timelineHeight)
  }

  if (squareRequested) {
    const explicitSize = Number(args.squareSize || args.size || args.width || args.height)
    const baseSquareSize = target.includes('1080') || resolution.includes('1080')
      ? 1080
      : target.includes('720') || resolution.includes('720')
        ? 720
        : Math.min(width, height)
    const squareSize = makeEvenDimension(Number.isFinite(explicitSize) ? explicitSize : baseSquareSize)
    width = squareSize
    height = squareSize
  } else if (verticalRequested) {
    const explicitWidth = Number(args.width)
    const explicitHeight = Number(args.height)
    if (Number.isFinite(explicitWidth) && Number.isFinite(explicitHeight)) {
      width = makeEvenDimension(explicitWidth)
      height = makeEvenDimension(explicitHeight)
    } else if (target.includes('720') || resolution.includes('720')) {
      width = 720
      height = 1280
    } else {
      width = 1080
      height = 1920
    }
  }

  width = makeEvenDimension(width)
  height = makeEvenDimension(height)

  const range = String(args.range || 'full').trim().toLowerCase()
  const startSeconds = Number(args.startSeconds)
  const endSeconds = Number(args.endSeconds)
  const customRangeRequested = range === 'custom' || Number.isFinite(startSeconds) || Number.isFinite(endSeconds)
  let rangeStart = 0
  let rangeEnd = duration
  if (customRangeRequested) {
    rangeStart = Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : 0
    rangeEnd = Number.isFinite(endSeconds) ? Math.max(rangeStart, endSeconds) : duration
  }
  const rangeDuration = Math.max(0, rangeEnd - rangeStart)

  const safeProjectName = sanitizeExportBaseName(project.name || 'ComfyStudio')
  const safeTimelineName = sanitizeExportBaseName(timeline.name || 'Timeline')
  const targetSuffix = sanitizeExportBaseName(target || 'h264_hd')
  const filename = sanitizeExportBaseName(args.filename || `${safeProjectName}_${safeTimelineName}_${targetSuffix}`)
  const extension = format === 'webm' ? 'webm' : format === 'prores' ? 'mov' : 'mp4'

  return {
    projectPath: project.path || '',
    timeline: {
      id: timeline.id,
      name: timeline.name,
      duration: roundTime(duration),
      fps: timelineFps,
      width: timelineWidth,
      height: timelineHeight,
      clipCount: Array.isArray(timeline.clips) ? timeline.clips.length : 0,
      trackCount: Array.isArray(timeline.tracks) ? timeline.tracks.length : 0,
    },
    settings: {
      filename,
      format,
      videoCodec: videoCodec === 'h265' || videoCodec === 'hevc' ? 'h265' : 'h264',
      audioCodec: String(args.audioCodec || 'aac').trim().toLowerCase() || 'aac',
      width,
      height,
      fps: Math.max(1, toFiniteNumber(args.fps, timelineFps)),
      sourceTimelineWidth: timelineWidth,
      sourceTimelineHeight: timelineHeight,
      range: customRangeRequested ? 'custom' : range,
      rangeStart: roundTime(rangeStart),
      rangeEnd: roundTime(rangeEnd),
      rangeDuration: roundTime(rangeDuration),
      includeAudio: args.includeAudio !== false,
      useHardwareEncoder: args.useHardwareEncoder === true,
      useProxyMedia: args.useProxyMedia === true,
      useDirectFramePipe: args.useDirectFramePipe !== false,
      deliveryFraming,
      qualityMode: String(args.qualityMode || 'crf').trim().toLowerCase() === 'bitrate' ? 'bitrate' : 'crf',
      crf: Number.isFinite(Number(args.crf)) ? Number(args.crf) : 18,
      bitrateKbps: Number.isFinite(Number(args.bitrateKbps)) ? Number(args.bitrateKbps) : 8000,
      audioBitrateKbps: Number.isFinite(Number(args.audioBitrateKbps)) ? Number(args.audioBitrateKbps) : 192,
      audioSampleRate: Number.isFinite(Number(args.audioSampleRate)) ? Number(args.audioSampleRate) : 44100,
      audioChannels: Number.isFinite(Number(args.audioChannels)) ? Number(args.audioChannels) : 2,
      normalizeAudio: args.normalizeAudio === true,
      loudnessTarget: Number.isFinite(Number(args.loudnessTarget)) ? Number(args.loudnessTarget) : -14,
      preset: String(args.encoderPreset || args.encoderSpeed || 'medium').trim() || 'medium',
      nvencPreset: String(args.nvencPreset || 'p5').trim() || 'p5',
      proresProfile: '3',
      extension,
    },
  }
}

function checkExportReadiness(snapshot, args = {}) {
  const plan = resolveExportDeliveryPlan(snapshot, args)
  if (plan.error) return plan

  const timeline = snapshot?.currentTimeline || null
  const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : []
  const clips = Array.isArray(timeline?.clips) ? timeline.clips : []
  const tracks = Array.isArray(timeline?.tracks) ? timeline.tracks : []
  const assetIds = new Set(assets.map((asset) => asset?.id).filter(Boolean))
  const visualTracks = tracks.filter((track) => track?.type !== 'audio')
  const audioTracks = tracks.filter((track) => track?.type === 'audio')
  const activeClips = clips.filter((clip) => clip?.enabled !== false)
  const exportableVisualClips = activeClips.filter((clip) => isAssetBackedClip(clip) && clip?.type !== 'audio')
  const audioClips = activeClips.filter((clip) => clip?.type === 'audio' || (clip?.type === 'video' && clip?.assetId))
  const missingAssetClips = exportableVisualClips.filter((clip) => clip.assetId && !assetIds.has(clip.assetId)).map(clipRef)
  const disabledClips = clips.filter((clip) => clip?.enabled === false).map(clipRef)
  const tinyClips = activeClips
    .filter((clip) => getClipDuration(clip) > 0 && getClipDuration(clip) < (2 / Math.max(1, plan.settings.fps)))
    .map(clipRef)

  const blockers = []
  const warnings = []
  const notes = []

  if (!plan.projectPath) blockers.push('Project path is unavailable. Save/open the project before exporting.')
  if (plan.settings.rangeDuration <= 0) blockers.push('Export range is empty.')
  if (exportableVisualClips.length === 0) blockers.push('No enabled visual media clips are available to export.')
  if (missingAssetClips.length > 0) blockers.push(`${missingAssetClips.length} enabled visual clip(s) reference missing project assets.`)
  if (plan.settings.format !== 'mp4') warnings.push('This delivery target is not MP4.')
  if (plan.settings.videoCodec !== 'h264') warnings.push('This delivery target is not H.264.')
  if (plan.settings.width !== 1920 || plan.settings.height !== 1080) {
    if (plan.settings.width === plan.settings.height) {
      notes.push(`Square 1:1 delivery target: ${plan.settings.width}x${plan.settings.height}.`)
    } else if (plan.settings.height > plan.settings.width && Math.abs((plan.settings.height / plan.settings.width) - (16 / 9)) < 0.05) {
      notes.push(`Vertical 9:16 delivery target: ${plan.settings.width}x${plan.settings.height}.`)
    } else {
      warnings.push(`This delivery target is ${plan.settings.width}x${plan.settings.height}, not 1920x1080 HD.`)
    }
  }
  if (disabledClips.length > 0) warnings.push(`${disabledClips.length} disabled clip(s) are still on the timeline.`)
  if (tinyClips.length > 0) warnings.push(`${tinyClips.length} clip(s) are shorter than two frames and may cause export edge cases.`)
  if (plan.settings.includeAudio && audioTracks.some((track) => track?.muted)) notes.push('One or more audio tracks are muted and will not contribute to export audio.')
  if (plan.settings.includeAudio && audioClips.length === 0) notes.push('Audio export is enabled, but no active audio/video clips with audio were detected.')
  if (visualTracks.some((track) => track?.visible === false)) notes.push('One or more visual tracks are hidden and will not appear in the export.')
  if (plan.settings.useHardwareEncoder) notes.push('Export requests hardware encoding; the renderer will fail if NVENC is unavailable.')
  if (plan.settings.deliveryFraming === 'fill') notes.push('Delivery framing is fill/center-crop, so the export will fill the target aspect ratio instead of letterboxing.')

  return {
    ready: blockers.length === 0,
    deliveryTarget: {
      container: plan.settings.format,
      videoCodec: plan.settings.videoCodec,
      audioCodec: plan.settings.audioCodec,
      width: plan.settings.width,
      height: plan.settings.height,
      fps: plan.settings.fps,
      rangeStart: plan.settings.rangeStart,
      rangeEnd: plan.settings.rangeEnd,
      duration: plan.settings.rangeDuration,
      includeAudio: plan.settings.includeAudio,
      qualityMode: plan.settings.qualityMode,
      crf: plan.settings.crf,
      bitrateKbps: plan.settings.bitrateKbps,
      useHardwareEncoder: plan.settings.useHardwareEncoder,
      deliveryFraming: plan.settings.deliveryFraming,
    },
    timeline: plan.timeline,
    blockers,
    warnings,
    notes,
    counts: {
      enabledClipCount: activeClips.length,
      exportableVisualClipCount: exportableVisualClips.length,
      audioClipCount: audioClips.length,
      disabledClipCount: disabledClips.length,
      missingAssetClipCount: missingAssetClips.length,
      tinyClipCount: tinyClips.length,
      visualTrackCount: visualTracks.length,
      audioTrackCount: audioTracks.length,
    },
    samples: {
      missingAssetClips: missingAssetClips.slice(0, 25),
      disabledClips: disabledClips.slice(0, 25),
      tinyClips: tinyClips.slice(0, 25),
    },
    suggestedNextActions: blockers.length > 0
      ? ['Fix blockers before starting an export.', 'Use analyze_timeline for more detail if needed.']
      : warnings.length > 0
        ? ['Export can start, but review warnings first if this is a final delivery.', 'Use export_timeline when ready.']
        : ['Ready for H.264 HD delivery export.', 'Use export_timeline to start the render.'],
    generatedAt: new Date().toISOString(),
  }
}

function resolveTimelineMarkerUpdateTargets(snapshot, args = {}) {
  const targetArgs = { ...args }
  if (!Object.prototype.hasOwnProperty.call(args, 'labelContains')) {
    delete targetArgs.label
  }
  const target = resolveTimelineMarkerRemovalTargets(snapshot, targetArgs)
  if (target.error) {
    return {
      error: target.error.replace('remove timeline markers', 'update timeline markers'),
      markers: [],
      missingMarkerIds: [],
    }
  }

  const timeline = snapshot?.currentTimeline || null
  const fps = Math.max(1, toFiniteNumber(timeline?.fps, 24))
  const duration = Math.max(0, toFiniteNumber(timeline?.duration, 0))
  const labelProvided = Object.prototype.hasOwnProperty.call(args, 'label')
  const colorProvided = Object.prototype.hasOwnProperty.call(args, 'newColor')
    || Object.prototype.hasOwnProperty.call(args, 'setColor')
  const rawNewColor = String(args.newColor ?? args.setColor ?? '').trim()
  const normalizedNewColor = normalizeClipLabelColor(rawNewColor)
  const timeSeconds = Number(args.timeSeconds)
  const frame = Number(args.frame)
  const timeOffsetSeconds = Number(args.timeOffsetSeconds)
  const hasAbsoluteTime = Number.isFinite(timeSeconds) || Number.isFinite(frame)
  const hasTimeOffset = Number.isFinite(timeOffsetSeconds)

  if (rawNewColor && !normalizedNewColor) {
    return { error: 'Invalid new marker color. Use a hex color like #f97316.', markers: [], missingMarkerIds: [] }
  }

  if (!labelProvided && !colorProvided && !hasAbsoluteTime && !hasTimeOffset) {
    return {
      error: 'Provide label, newColor, setColor, timeSeconds, frame, or timeOffsetSeconds to update timeline markers.',
      markers: [],
      missingMarkerIds: target.missingMarkerIds || [],
    }
  }

  if (hasAbsoluteTime && (target.markers || []).length > 1) {
    return {
      error: 'Absolute timeSeconds/frame updates can only target one marker. Use timeOffsetSeconds to move multiple markers together.',
      markers: [],
      missingMarkerIds: target.missingMarkerIds || [],
    }
  }

  const updates = (target.markers || []).map((marker) => {
    let nextTime = toFiniteNumber(marker?.time, 0)
    if (hasAbsoluteTime) {
      nextTime = Number.isFinite(timeSeconds) ? timeSeconds : frame / fps
    } else if (hasTimeOffset) {
      nextTime += timeOffsetSeconds
    }
    const clampedTime = duration > 0 ? Math.min(Math.max(0, nextTime), duration) : Math.max(0, nextTime)
    const roundedFrame = Math.max(0, Math.round(clampedTime * fps))
    const roundedTime = roundTime(roundedFrame / fps)
    const label = labelProvided
      ? String(args.label || '').trim().slice(0, 160)
      : (marker?.label || marker?.name || '')
    const color = colorProvided ? normalizedNewColor : (marker?.color || '')
    return {
      id: marker.id,
      time: roundedTime,
      timeSeconds: roundedTime,
      frame: roundedFrame,
      timecode: formatTimelineTimecode(roundedTime, fps),
      label,
      color,
      previous: markerRef(marker, fps),
    }
  })

  return {
    mode: target.mode || '',
    markers: target.markers || [],
    updates,
    missingMarkerIds: target.missingMarkerIds || [],
  }
}

function formatTimelineTimecode(seconds, fps = 24) {
  const frameRate = Math.max(1, Math.round(toFiniteNumber(fps, 24)))
  const totalFrames = Math.max(0, Math.round(toFiniteNumber(seconds, 0) * frameRate))
  const frames = totalFrames % frameRate
  const totalWholeSeconds = Math.floor(totalFrames / frameRate)
  const secs = totalWholeSeconds % 60
  const mins = Math.floor(totalWholeSeconds / 60) % 60
  const hours = Math.floor(totalWholeSeconds / 3600)
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}`
}

function resolveTimelineFrameTime(timeline, args = {}) {
  const fps = Math.max(1, toFiniteNumber(timeline?.fps, 24))
  const explicitTime = Number(args.timeSeconds)
  const explicitFrame = Number(args.frame)
  let timeSeconds = Number.isFinite(explicitTime)
    ? explicitTime
    : Number.isFinite(explicitFrame)
      ? explicitFrame / fps
      : toFiniteNumber(timeline?.playheadPosition, 0)
  const duration = toFiniteNumber(timeline?.duration, 0)
  if (duration > 0) {
    timeSeconds = Math.min(Math.max(0, timeSeconds), Math.max(0, duration - (1 / fps)))
  } else {
    timeSeconds = Math.max(0, timeSeconds)
  }
  return {
    timeSeconds: roundTime(timeSeconds),
    frame: Math.max(0, Math.round(timeSeconds * fps)),
    fps,
    timecode: formatTimelineTimecode(timeSeconds, fps),
  }
}

function isClipActiveAtTime(clip, timeSeconds) {
  if (!clip || clip.enabled === false) return false
  const startTime = getClipStart(clip)
  const duration = getClipDuration(clip)
  if (duration <= 0) return false
  return timeSeconds >= startTime && timeSeconds < startTime + duration
}

function getTimelineFrameClips(timeline, timeSeconds) {
  const tracks = Array.isArray(timeline?.tracks) ? timeline.tracks : []
  const trackIndexById = new Map(tracks.map((track, index) => [track?.id, index]))
  const trackById = new Map(tracks.map((track) => [track?.id, track]))
  const activeClips = (timeline?.clips || [])
    .filter((clip) => isClipActiveAtTime(clip, timeSeconds))
    .map((clip) => {
      const track = trackById.get(clip.trackId) || null
      return {
        clip,
        track,
        trackIndex: trackIndexById.has(clip.trackId) ? trackIndexById.get(clip.trackId) : Number.MAX_SAFE_INTEGER,
      }
    })
    .filter(({ track }) => track && track.visible !== false && !track.muted)
    .sort((a, b) => a.trackIndex - b.trackIndex || getClipStart(a.clip) - getClipStart(b.clip))

  const visualTypes = new Set(['video', 'image', 'text', 'shape'])
  const visualClips = activeClips.filter(({ clip, track }) => (
    track?.type === 'video' && visualTypes.has(String(clip?.type || '').toLowerCase())
  ))

  const summarize = ({ clip, track, trackIndex }) => ({
    ...clipRef(clip),
    trackName: track?.name || '',
    trackType: track?.type || '',
    trackIndex,
    enabled: clip.enabled !== false,
    labelColor: clip.labelColor || '',
    transform: clip.transform || null,
    assetId: clip.assetId || null,
  })

  return {
    activeClips: activeClips.map(summarize),
    visualClips: visualClips.map(summarize),
    topVisibleClip: visualClips.length > 0 ? summarize(visualClips[0]) : null,
  }
}

function isVisualTimelineClip(clip, track) {
  const type = String(clip?.type || '').toLowerCase()
  return track?.type === 'video'
    && track.visible !== false
    && !track.muted
    && clip?.enabled !== false
    && ['video', 'image', 'text', 'shape'].includes(type)
    && getClipDuration(clip) > 0
}

function isGenerationSourceClip(clip, track) {
  const type = String(clip?.type || '').toLowerCase()
  return isVisualTimelineClip(clip, track) && (type === 'video' || type === 'image')
}

function getTimelineClipEntries(timeline, predicate = () => true) {
  const tracks = Array.isArray(timeline?.tracks) ? timeline.tracks : []
  const trackById = new Map(tracks.map((track, index) => [track?.id, { track, trackIndex: index }]))
  return (Array.isArray(timeline?.clips) ? timeline.clips : [])
    .map((clip) => {
      const resolved = trackById.get(clip?.trackId) || {}
      return {
        clip,
        track: resolved.track || null,
        trackIndex: Number.isFinite(resolved.trackIndex) ? resolved.trackIndex : Number.MAX_SAFE_INTEGER,
      }
    })
    .filter(({ clip, track, trackIndex }) => clip && track && predicate(clip, track, trackIndex))
}

function getGenerationSourceEntriesAtTime(timeline, timeSeconds) {
  return getTimelineClipEntries(timeline, (clip, track) => (
    isGenerationSourceClip(clip, track) && isClipActiveAtTime(clip, timeSeconds)
  )).sort((a, b) => a.trackIndex - b.trackIndex || getClipStart(a.clip) - getClipStart(b.clip))
}

function getRepresentativeClipTime(clip, fps = 24) {
  const frameDuration = 1 / Math.max(1, toFiniteNumber(fps, 24))
  const start = getClipStart(clip)
  const duration = getClipDuration(clip)
  if (duration <= frameDuration) return start
  const midpoint = start + (duration / 2)
  return roundTime(Math.min(start + duration - (frameDuration / 2), Math.max(start, midpoint)))
}

function summarizeGenerationSource(snapshot, timeline, entry, captureTime) {
  if (!entry?.clip) return null
  const { clip, track, trackIndex } = entry
  const asset = getAssetById(snapshot, clip.assetId)
  return {
    ...clipRef(clip),
    trackName: track?.name || '',
    trackType: track?.type || '',
    trackIndex,
    captureTimeSeconds: roundTime(captureTime),
    captureTimecode: formatTimelineTimecode(captureTime, timeline?.fps || 24),
    enabled: clip.enabled !== false,
    labelColor: clip.labelColor || '',
    transform: clip.transform || null,
    asset: asset ? {
      id: asset.id,
      name: asset.name,
      type: asset.type,
      width: asset.width || null,
      height: asset.height || null,
      duration: asset.duration || null,
      prompt: asset.prompt || '',
      negativePrompt: asset.negativePrompt || '',
      workflowId: asset.workflowId || '',
      workflowName: asset.workflowName || '',
      model: asset.model || '',
    } : null,
  }
}

function resolveGenerationPrompt(snapshot, sourceClip, args = {}) {
  const asset = getAssetById(snapshot, sourceClip?.assetId)
  const prompt = String(
    args.prompt
      ?? sourceClip?.metadata?.prompt
      ?? sourceClip?.textProperties?.text
      ?? sourceClip?.text
      ?? asset?.prompt
      ?? ''
  ).trim()
  const negativePrompt = String(
    args.negativePrompt
      ?? sourceClip?.metadata?.negativePrompt
      ?? asset?.negativePrompt
      ?? ''
  ).trim()
  return {
    prompt: prompt.slice(0, 5000),
    negativePrompt: negativePrompt.slice(0, 2000),
  }
}

function resolveGenerateFromTimelinePlan(snapshot, args = {}) {
  const timeline = snapshot?.currentTimeline || null
  if (!timeline) return { error: 'No current timeline is available.' }

  const fps = Math.max(1, toFiniteNumber(timeline.fps, 24))
  const selectedIds = new Set(Array.isArray(timeline.selectedClipIds) ? timeline.selectedClipIds : [])
  const selectedSources = selectedIds.size > 0
    ? getTimelineClipEntries(timeline, (clip, track) => (
      selectedIds.has(clip?.id) && isGenerationSourceClip(clip, track)
    )).sort((a, b) => a.trackIndex - b.trackIndex || getClipStart(a.clip) - getClipStart(b.clip))
    : []

  const hasExplicitTime = args.timeSeconds !== undefined || args.time !== undefined || args.frame !== undefined
  const timing = resolveTimelineFrameTime(timeline, {
    timeSeconds: args.timeSeconds ?? args.time,
    frame: args.frame,
  })
  let captureTime = timing.timeSeconds
  let requestedSource = 'playhead'

  if (!hasExplicitTime && selectedSources.length > 0) {
    const selectedAtPlayhead = selectedSources.find(({ clip }) => isClipActiveAtTime(clip, captureTime))
    if (selectedAtPlayhead) {
      requestedSource = 'selected_clip_at_playhead'
    } else {
      captureTime = getRepresentativeClipTime(selectedSources[0].clip, fps)
      requestedSource = 'selected_clip_representative_frame'
    }
  } else if (hasExplicitTime) {
    requestedSource = 'explicit_time'
  }

  const sourcesAtCapture = getGenerationSourceEntriesAtTime(timeline, captureTime)
  const selectedAtCapture = selectedSources.find(({ clip }) => isClipActiveAtTime(clip, captureTime))
  const sourceEntry = selectedAtCapture || sourcesAtCapture[0] || null
  if (!sourceEntry) {
    return {
      error: 'No visible video or image clip is available at the requested timeline time.',
      requested: {
        timeSeconds: roundTime(captureTime),
        timecode: formatTimelineTimecode(captureTime, fps),
        selectedClipCount: selectedIds.size,
      },
    }
  }

  const mode = String(args.mode || 'extend').trim().toLowerCase() === 'keyframe' ? 'keyframe' : 'extend'
  const workflowId = String(args.workflowId || 'ltx23-i2v').trim() || 'ltx23-i2v'
  const category = String(args.category || 'video').trim().toLowerCase() || 'video'
  const promptState = resolveGenerationPrompt(snapshot, sourceEntry.clip, args)
  const durationSeconds = Number(args.durationSeconds ?? args.duration)
  const requestedFps = Number(args.fps)
  const timelineSummary = {
    id: timeline.id,
    name: timeline.name,
    fps,
    width: timeline.width || snapshot?.project?.settings?.width || null,
    height: timeline.height || snapshot?.project?.settings?.height || null,
    playheadPosition: roundTime(toFiniteNumber(timeline.playheadPosition, 0)),
  }
  const sourceClipSummary = summarizeGenerationSource(snapshot, timeline, sourceEntry, captureTime)
  const topVisibleSourceClipSummary = summarizeGenerationSource(snapshot, timeline, sourcesAtCapture[0], captureTime)
  const explicitResolution = normalizeTimelineBatchExplicitResolution(args)
  const shouldResolveResolution = Boolean(
    explicitResolution
    || args.resolutionSource !== undefined
    || args.matchResolution !== undefined
    || args.matchAspect !== undefined
  )
  const resolutionPlan = shouldResolveResolution
    ? resolveTimelineBatchGenerationResolution(snapshot, {
      timeline: timelineSummary,
      sourceClip: sourceClipSummary,
      topVisibleSourceClip: topVisibleSourceClipSummary,
    }, args)
    : { resolution: null, source: null, reference: null }

  return {
    action: 'prepare_generation_from_timeline_context',
    mode,
    workflowId,
    category,
    previewOnly: args.previewOnly !== false,
    openGenerateTab: args.openGenerateTab !== false,
    requestedSource,
    timeline: timelineSummary,
    frame: {
      timeSeconds: roundTime(captureTime),
      frame: Math.max(0, Math.round(captureTime * fps)),
      fps,
      timecode: formatTimelineTimecode(captureTime, fps),
    },
    sourceClip: sourceClipSummary,
    topVisibleSourceClip: topVisibleSourceClipSummary,
    selectedClipIds: [...selectedIds],
    selectedGenerationSourceCount: selectedSources.length,
    prompt: promptState.prompt,
    negativePrompt: promptState.negativePrompt,
    generationSettings: {
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
      fps: Number.isFinite(requestedFps) ? requestedFps : null,
      resolution: resolutionPlan.resolution,
      resolutionSource: resolutionPlan.source,
      resolutionReference: resolutionPlan.reference,
    },
  }
}

function normalizeTimelineBatchWorkflowId(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (MCP_TIMELINE_BATCH_SUPPORTED_WORKFLOWS.has(raw)) return raw
  const compact = raw.toLowerCase().replace(/[^a-z0-9]/g, '')
  return MCP_TIMELINE_BATCH_WORKFLOW_ALIASES.get(compact) || raw
}

function getTimelineBatchVariationCount(value, fallback = 1) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(MCP_TIMELINE_BATCH_MAX_VARIATIONS_PER_WORKFLOW, Math.floor(parsed)))
}

function splitWorkflowList(value) {
  if (Array.isArray(value)) return value
  const text = String(value || '').trim()
  if (!text) return []
  return text
    .split(/[;,|]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function makeTimelineBatchSeed(baseSeed, index, explicitSeed) {
  const explicit = Number(explicitSeed)
  if (Number.isFinite(explicit)) return Math.max(0, Math.floor(explicit))
  const base = Number(baseSeed)
  if (Number.isFinite(base)) return Math.max(0, Math.floor(base) + index)
  return Math.floor(Math.random() * 2147483647)
}

function normalizeTimelineBatchResolution(value) {
  if (!value || typeof value !== 'object') return null
  const width = Number(value.width)
  const height = Number(value.height)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  return {
    width: Math.max(16, Math.round(width)),
    height: Math.max(16, Math.round(height)),
  }
}

function normalizeTimelineBatchExplicitResolution(args = {}) {
  const topLevel = normalizeTimelineBatchResolution({
    width: args.width ?? args.outputWidth,
    height: args.height ?? args.outputHeight,
  })
  if (topLevel) return topLevel
  return normalizeTimelineBatchResolution(args.resolution || args.outputResolution || args.size)
}

function roundGenerationDimension(value, multiple = MCP_TIMELINE_BATCH_AUTO_DIMENSION_MULTIPLE) {
  const safeMultiple = Math.max(2, Math.round(Number(multiple) || 2))
  return Math.max(safeMultiple, Math.round((Number(value) || safeMultiple) / safeMultiple) * safeMultiple)
}

function resolveAspectMatchedGenerationResolution(width, height) {
  const sourceWidth = Number(width)
  const sourceHeight = Number(height)
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    return null
  }

  const aspect = sourceWidth / sourceHeight
  let outputWidth = Math.sqrt(MCP_TIMELINE_BATCH_AUTO_TARGET_AREA * aspect)
  let outputHeight = outputWidth / aspect
  const maxEdge = Math.max(outputWidth, outputHeight)
  if (maxEdge > MCP_TIMELINE_BATCH_AUTO_MAX_EDGE) {
    const scale = MCP_TIMELINE_BATCH_AUTO_MAX_EDGE / maxEdge
    outputWidth *= scale
    outputHeight *= scale
  }

  return {
    width: roundGenerationDimension(outputWidth),
    height: roundGenerationDimension(outputHeight),
  }
}

function normalizeTimelineBatchResolutionSource(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!raw || raw === 'auto') return 'source'
  if (['source', 'input', 'inputimage', 'sourceclip', 'clip', 'asset'].includes(raw)) return 'source'
  if (['timeline', 'sequence', 'currenttimeline', 'currentsequence'].includes(raw)) return 'timeline'
  if (['project', 'projectsettings'].includes(raw)) return 'project'
  if (['generate', 'generatedefault', 'current', 'currentgenerate'].includes(raw)) return 'generate'
  return 'source'
}

function resolutionCandidate(width, height, kind) {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  return {
    kind,
    width: Math.round(w),
    height: Math.round(h),
  }
}

function getSourceResolutionCandidate(sourcePlan) {
  const source = sourcePlan?.sourceClip || sourcePlan?.topVisibleSourceClip || null
  return resolutionCandidate(source?.asset?.width, source?.asset?.height, 'source_asset')
    || resolutionCandidate(source?.width, source?.height, 'source_clip')
}

function getTimelineResolutionCandidate(sourcePlan) {
  return resolutionCandidate(sourcePlan?.timeline?.width, sourcePlan?.timeline?.height, 'timeline')
}

function getProjectResolutionCandidate(snapshot) {
  return resolutionCandidate(snapshot?.project?.settings?.width, snapshot?.project?.settings?.height, 'project')
}

function resolveTimelineBatchGenerationResolution(snapshot, sourcePlan, args = {}) {
  const explicit = normalizeTimelineBatchExplicitResolution(args)
  if (explicit) {
    return {
      resolution: explicit,
      source: 'explicit',
      reference: { kind: 'explicit', ...explicit },
    }
  }

  const sourceName = normalizeTimelineBatchResolutionSource(args.resolutionSource ?? args.matchResolution ?? args.matchAspect)
  if (sourceName === 'generate') {
    return {
      resolution: null,
      source: 'generate',
      reference: null,
    }
  }

  let candidate = null
  if (sourceName === 'project') {
    candidate = getProjectResolutionCandidate(snapshot) || getTimelineResolutionCandidate(sourcePlan) || getSourceResolutionCandidate(sourcePlan)
  } else if (sourceName === 'timeline') {
    candidate = getTimelineResolutionCandidate(sourcePlan) || getProjectResolutionCandidate(snapshot) || getSourceResolutionCandidate(sourcePlan)
  } else {
    candidate = getSourceResolutionCandidate(sourcePlan) || getTimelineResolutionCandidate(sourcePlan) || getProjectResolutionCandidate(snapshot)
  }

  const resolution = candidate ? resolveAspectMatchedGenerationResolution(candidate.width, candidate.height) : null
  if (resolution) {
    return {
      resolution,
      source: sourceName,
      reference: candidate,
    }
  }

  return {
    resolution: { width: 1280, height: 720 },
    source: 'default',
    reference: { kind: 'default', width: 1280, height: 720 },
  }
}

function resolveTimelineBatchDuration(args = {}, sourcePlan = {}, fallback = 5) {
  const explicit = getTimelineBatchPositiveNumber(args.durationSeconds ?? args.duration, null)
  if (explicit !== null) {
    return { durationSeconds: explicit, source: 'explicit' }
  }

  const durationSource = String(args.durationSource || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  const shouldUseSource = durationSource
    ? ['source', 'sourceclip', 'clip', 'input', 'inputclip'].includes(durationSource)
    : true
  if (shouldUseSource) {
    const sourceDuration = getTimelineBatchPositiveNumber(sourcePlan?.sourceClip?.duration, null)
    if (sourceDuration !== null) {
      return { durationSeconds: sourceDuration, source: 'source_clip' }
    }
  }

  return {
    durationSeconds: fallback,
    source: 'default',
  }
}

function getTimelineBatchPositiveNumber(value, fallback) {
  if (value === null || typeof value === 'undefined' || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeTimelineBatchWorkflows(args = {}) {
  const fallbackCount = getTimelineBatchVariationCount(
    args.variationsPerWorkflow ?? args.variationCount ?? args.variations ?? args.count,
    1
  )
  const rawEntries = Array.isArray(args.workflows) && args.workflows.length > 0
    ? args.workflows
    : splitWorkflowList(args.workflowIds && args.workflowIds.length !== 0 ? args.workflowIds : (args.workflowId || 'ltx23-i2v'))

  const globalSeeds = Array.isArray(args.seeds) ? args.seeds : []
  const entries = []
  let seedOffset = 0

  for (const rawEntry of rawEntries) {
    const rawWorkflow = typeof rawEntry === 'object' && rawEntry !== null
      ? (rawEntry.workflowId || rawEntry.id || rawEntry.workflow || rawEntry.name || rawEntry.label)
      : rawEntry
    const workflowId = normalizeTimelineBatchWorkflowId(rawWorkflow)
    if (!workflowId) continue
    if (!MCP_TIMELINE_BATCH_SUPPORTED_WORKFLOWS.has(workflowId)) {
      return {
        error: `Unsupported timeline batch workflow "${rawWorkflow}". This first batch tool supports ltx23-i2v and wan22-i2v.`,
      }
    }

    const entryCount = typeof rawEntry === 'object' && rawEntry !== null
      ? getTimelineBatchVariationCount(rawEntry.variations ?? rawEntry.variationCount ?? rawEntry.count, fallbackCount)
      : fallbackCount
    const entrySeeds = typeof rawEntry === 'object' && rawEntry !== null && Array.isArray(rawEntry.seeds)
      ? rawEntry.seeds
      : []
    const seedInputs = Array.from({ length: entryCount }, (_, index) => entrySeeds[index] ?? globalSeeds[seedOffset + index])

    entries.push({
      workflowId,
      variations: entryCount,
      seeds: Array.from({ length: entryCount }, (_, index) => {
        const explicitSeed = entrySeeds[index] ?? globalSeeds[seedOffset + index]
        return makeTimelineBatchSeed(args.baseSeed, seedOffset + index, explicitSeed)
      }),
    })
    seedOffset += entryCount
  }

  if (entries.length === 0) {
    return { error: 'No workflows were provided for the timeline generation batch.' }
  }

  const totalJobs = entries.reduce((sum, entry) => sum + entry.variations, 0)
  if (totalJobs > MCP_TIMELINE_BATCH_MAX_TOTAL_JOBS) {
    return {
      error: `Timeline generation batch is too large (${totalJobs} jobs). Keep it at ${MCP_TIMELINE_BATCH_MAX_TOTAL_JOBS} jobs or fewer.`,
    }
  }

  return { entries, totalJobs }
}

function buildTimelineBatchApplyArguments(args = {}, plan = {}) {
  return {
    ...args,
    previewOnly: false,
    workflowId: undefined,
    workflowIds: undefined,
    workflows: (plan.workflows || []).map((workflow) => ({
      workflowId: workflow.workflowId,
      variations: workflow.variations,
      seeds: Array.isArray(workflow.seeds) ? workflow.seeds : [],
    })),
    durationSeconds: plan.generationSettings?.durationSeconds ?? args.durationSeconds ?? args.duration,
    fps: plan.generationSettings?.fps ?? args.fps,
    resolution: plan.generationSettings?.resolution || args.resolution,
    resolutionSource: plan.generationSettings?.resolutionSource || args.resolutionSource,
  }
}

function resolveTimelineGenerationBatchPlan(snapshot, args = {}) {
  const normalized = normalizeTimelineBatchWorkflows(args)
  if (normalized.error) return { error: normalized.error }

  const firstWorkflowId = normalized.entries[0]?.workflowId || 'ltx23-i2v'
  const sourcePlan = resolveGenerateFromTimelinePlan(snapshot, {
    ...args,
    workflowId: firstWorkflowId,
    category: 'video',
    mode: 'extend',
    previewOnly: true,
    openGenerateTab: args.openGenerateTab === true,
  })
  if (sourcePlan.error) return { error: sourcePlan.error }

  const durationPlan = resolveTimelineBatchDuration(args, sourcePlan, 5)
  const durationSeconds = durationPlan.durationSeconds
  const requestedFps = getTimelineBatchPositiveNumber(
    args.fps ?? sourcePlan.generationSettings?.fps,
    24
  )
  const resolutionPlan = resolveTimelineBatchGenerationResolution(snapshot, sourcePlan, args)
  const resolution = resolutionPlan.resolution
  const prompt = String(args.prompt ?? sourcePlan.prompt ?? '').trim().slice(0, 5000)
  const negativePrompt = String(args.negativePrompt ?? sourcePlan.negativePrompt ?? '').trim().slice(0, 2000)
  const workflows = normalized.entries.map((entry) => ({
    ...entry,
    label: entry.workflowId === 'wan22-i2v' ? 'WAN 2.2' : entry.workflowId === 'ltx23-i2v' ? 'LTX 2.3' : entry.workflowId,
  }))
  const jobs = workflows.flatMap((workflow) => (
    workflow.seeds.map((seed, index) => ({
      workflowId: workflow.workflowId,
      workflowLabel: workflow.label,
      variation: index + 1,
      variationCount: workflow.variations,
      seed,
      prompt,
      negativePrompt,
      durationSeconds,
      durationSource: durationPlan.source,
      fps: requestedFps,
      resolution,
      resolutionSource: resolutionPlan.source,
      resolutionReference: resolutionPlan.reference,
    }))
  ))

  return {
    action: 'queue_timeline_generation_batch',
    previewOnly: args.previewOnly !== false,
    mode: 'extend',
    category: 'video',
    openGenerateTab: args.openGenerateTab === true,
    source: {
      requestedSource: sourcePlan.requestedSource,
      timeline: sourcePlan.timeline,
      frame: sourcePlan.frame,
      sourceClip: sourcePlan.sourceClip,
      topVisibleSourceClip: sourcePlan.topVisibleSourceClip,
      selectedClipIds: sourcePlan.selectedClipIds,
      selectedGenerationSourceCount: sourcePlan.selectedGenerationSourceCount,
    },
    frame: sourcePlan.frame,
    prompt,
    negativePrompt,
    generationSettings: {
      durationSeconds,
      durationSource: durationPlan.source,
      fps: requestedFps,
      resolution,
      resolutionSource: resolutionPlan.source,
      resolutionReference: resolutionPlan.reference,
    },
    workflows,
    jobs,
    totalJobs: jobs.length,
    limits: {
      maxVariationsPerWorkflow: MCP_TIMELINE_BATCH_MAX_VARIATIONS_PER_WORKFLOW,
      maxTotalJobs: MCP_TIMELINE_BATCH_MAX_TOTAL_JOBS,
    },
  }
}

function normalizePromptBatchWorkflowId(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (MCP_PROMPT_BATCH_SUPPORTED_WORKFLOWS.has(raw)) return raw
  const compact = raw.toLowerCase().replace(/[^a-z0-9]/g, '')
  return MCP_PROMPT_BATCH_WORKFLOW_ALIASES.get(compact) || raw
}

function getPromptBatchVariationCount(value, fallback = 1) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(MCP_PROMPT_BATCH_MAX_VARIATIONS_PER_WORKFLOW, Math.floor(parsed)))
}

function makePromptBatchSeed(baseSeed, index, explicitSeed) {
  const explicit = Number(explicitSeed)
  if (Number.isFinite(explicit)) return Math.max(0, Math.floor(explicit))
  const base = Number(baseSeed)
  if (Number.isFinite(base)) return Math.max(0, Math.floor(base) + index)
  return Math.floor(Math.random() * 2147483647)
}

function normalizePromptBatchResolution(value, fallback = null) {
  const resolution = normalizeTimelineBatchResolution(value)
  if (resolution) return resolution
  return fallback ? { ...fallback } : null
}

function normalizePromptBatchPrompts(args = {}) {
  const rawEntries = Array.isArray(args.prompts) && args.prompts.length > 0
    ? args.prompts
    : [args.prompt]
  const globalNegative = String(args.negativePrompt || '').trim().slice(0, 2000)
  const prompts = rawEntries.map((entry, index) => {
    const rawPrompt = typeof entry === 'object' && entry !== null
      ? entry.prompt ?? entry.text ?? entry.description
      : entry
    const prompt = String(rawPrompt || '').trim().slice(0, 5000)
    if (!prompt) return null
    const negativePrompt = typeof entry === 'object' && entry !== null
      ? String(entry.negativePrompt ?? globalNegative).trim().slice(0, 2000)
      : globalNegative
    return {
      prompt,
      negativePrompt,
      label: typeof entry === 'object' && entry !== null
        ? String(entry.label || entry.name || `Prompt ${index + 1}`).trim().slice(0, 120)
        : `Prompt ${index + 1}`,
    }
  }).filter(Boolean)

  if (prompts.length === 0) {
    return { error: 'No prompt was provided for the prompt generation batch.' }
  }
  return { prompts }
}

function normalizePromptBatchWorkflows(args = {}) {
  const fallbackCount = getPromptBatchVariationCount(
    args.variationsPerWorkflow ?? args.variationsPerPrompt ?? args.variationCount ?? args.variations ?? args.count,
    1
  )
  const rawEntries = Array.isArray(args.workflows) && args.workflows.length > 0
    ? args.workflows
    : splitWorkflowList(args.workflowIds && args.workflowIds.length !== 0 ? args.workflowIds : (args.workflowId || 'z-image-turbo'))

  const globalSeeds = Array.isArray(args.seeds) ? args.seeds : []
  const entries = []
  let seedOffset = 0

  for (const rawEntry of rawEntries) {
    const rawWorkflow = typeof rawEntry === 'object' && rawEntry !== null
      ? (rawEntry.workflowId || rawEntry.id || rawEntry.workflow || rawEntry.name || rawEntry.label)
      : rawEntry
    const workflowId = normalizePromptBatchWorkflowId(rawWorkflow)
    if (!workflowId) continue
    const workflowInfo = MCP_PROMPT_BATCH_SUPPORTED_WORKFLOWS.get(workflowId)
    if (!workflowInfo) {
      return {
        error: `Unsupported prompt generation workflow "${rawWorkflow}". Use one of: ${[...MCP_PROMPT_BATCH_SUPPORTED_WORKFLOWS.keys()].join(', ')}.`,
      }
    }

    const entryCount = typeof rawEntry === 'object' && rawEntry !== null
      ? getPromptBatchVariationCount(rawEntry.variations ?? rawEntry.variationCount ?? rawEntry.count, fallbackCount)
      : fallbackCount
    const entrySeeds = typeof rawEntry === 'object' && rawEntry !== null && Array.isArray(rawEntry.seeds)
      ? rawEntry.seeds
      : []
    const seedInputs = Array.from({ length: entryCount }, (_, index) => entrySeeds[index] ?? globalSeeds[seedOffset + index])
    const entryResolution = typeof rawEntry === 'object' && rawEntry !== null
      ? normalizePromptBatchResolution(rawEntry.resolution, workflowInfo.defaultResolution)
      : normalizePromptBatchResolution(args.resolution, workflowInfo.defaultResolution)
    const entryDuration = getTimelineBatchPositiveNumber(
      typeof rawEntry === 'object' && rawEntry !== null
        ? rawEntry.durationSeconds ?? rawEntry.duration ?? args.durationSeconds ?? args.duration
        : args.durationSeconds ?? args.duration,
      workflowInfo.defaultDurationSeconds || null
    )
    const entryFps = getTimelineBatchPositiveNumber(
      typeof rawEntry === 'object' && rawEntry !== null
        ? rawEntry.fps ?? args.fps
        : args.fps,
      workflowInfo.defaultFps || null
    )

    entries.push({
      workflowId,
      label: String((typeof rawEntry === 'object' && rawEntry !== null && rawEntry.workflowLabel) || workflowInfo.label || workflowId),
      category: workflowInfo.category,
      outputType: workflowInfo.outputType,
      variations: entryCount,
      seedInputs,
      seeds: seedInputs.map((explicitSeed, index) => {
        return makePromptBatchSeed(args.baseSeed, seedOffset + index, explicitSeed)
      }),
      resolution: entryResolution,
      durationSeconds: entryDuration,
      fps: entryFps,
    })
    seedOffset += entryCount
  }

  if (entries.length === 0) {
    return { error: 'No workflows were provided for the prompt generation batch.' }
  }

  return { entries }
}

function buildPromptBatchApplyArguments(args = {}, plan = {}) {
  return {
    ...args,
    previewOnly: false,
    workflowId: undefined,
    workflowIds: undefined,
    workflows: (plan.workflows || []).map((workflow) => ({
      workflowId: workflow.workflowId,
      variations: workflow.variations,
      seeds: Array.isArray(workflow.seeds) ? workflow.seeds : [],
      resolution: workflow.resolution || undefined,
      durationSeconds: workflow.durationSeconds || undefined,
      fps: workflow.fps || undefined,
    })),
    prompts: (plan.prompts || []).map((prompt) => ({
      prompt: prompt.prompt,
      negativePrompt: prompt.negativePrompt,
      label: prompt.label,
    })),
    folderId: plan.folderId || args.folderId || undefined,
    jobs: plan.jobs || undefined,
  }
}

function resolvePromptGenerationBatchPlan(_snapshot, args = {}) {
  const folderId = String(args.folderId || args.outputFolderId || '').trim() || null

  if (Array.isArray(args.jobs) && args.jobs.length > 0) {
    if (args.jobs.length > MCP_PROMPT_BATCH_MAX_TOTAL_JOBS) {
      return {
        error: `Prompt generation batch is too large (${args.jobs.length} jobs). Keep it at ${MCP_PROMPT_BATCH_MAX_TOTAL_JOBS} jobs or fewer.`,
      }
    }
    let jobs = []
    try {
      jobs = args.jobs.map((job, index) => {
        const workflowId = normalizePromptBatchWorkflowId(job?.workflowId)
        const workflowInfo = MCP_PROMPT_BATCH_SUPPORTED_WORKFLOWS.get(workflowId)
        if (!workflowInfo) {
          throw new Error(`Unsupported prompt generation workflow "${job?.workflowId || ''}".`)
        }
        const prompt = String(job?.prompt || '').trim().slice(0, 5000)
        if (!prompt) throw new Error(`Prompt generation job ${index + 1} is missing prompt text.`)
        return {
          workflowId,
          workflowLabel: String(job?.workflowLabel || workflowInfo.label || workflowId),
          category: workflowInfo.category,
          outputType: workflowInfo.outputType,
          prompt,
          negativePrompt: String(job?.negativePrompt || '').trim().slice(0, 2000),
          promptLabel: String(job?.promptLabel || '').trim().slice(0, 120),
          promptIndex: Number(job?.promptIndex) || null,
          promptCount: Number(job?.promptCount) || null,
          variation: Number(job?.variation) || null,
          variationCount: Number(job?.variationCount) || null,
          seed: makePromptBatchSeed(undefined, index, job?.seed),
          durationSeconds: getTimelineBatchPositiveNumber(job?.durationSeconds ?? job?.duration, workflowInfo.defaultDurationSeconds || null),
          fps: getTimelineBatchPositiveNumber(job?.fps, workflowInfo.defaultFps || null),
          resolution: normalizePromptBatchResolution(job?.resolution, workflowInfo.defaultResolution),
          folderId: String(job?.folderId || job?.outputFolderId || folderId || '').trim() || null,
        }
      })
    } catch (error) {
      return { error: error?.message || String(error) }
    }
    return {
      action: 'queue_prompt_generation_batch',
      previewOnly: args.previewOnly !== false,
      prompts: args.prompts || [],
      workflows: args.workflows || [],
      jobs,
      folderId,
      totalJobs: jobs.length,
      limits: {
        maxVariationsPerWorkflow: MCP_PROMPT_BATCH_MAX_VARIATIONS_PER_WORKFLOW,
        maxTotalJobs: MCP_PROMPT_BATCH_MAX_TOTAL_JOBS,
      },
    }
  }

  const promptState = normalizePromptBatchPrompts(args)
  if (promptState.error) return { error: promptState.error }
  const workflowState = normalizePromptBatchWorkflows(args)
  if (workflowState.error) return { error: workflowState.error }

  const totalJobs = promptState.prompts.length * workflowState.entries.reduce((sum, entry) => sum + entry.variations, 0)
  if (totalJobs > MCP_PROMPT_BATCH_MAX_TOTAL_JOBS) {
    return {
      error: `Prompt generation batch is too large (${totalJobs} jobs). Keep it at ${MCP_PROMPT_BATCH_MAX_TOTAL_JOBS} jobs or fewer.`,
    }
  }

  const jobs = []
  let jobIndex = 0
  for (const promptEntry of promptState.prompts) {
    for (const workflow of workflowState.entries) {
      for (let variationIndex = 0; variationIndex < workflow.variations; variationIndex += 1) {
        const explicitSeed = Array.isArray(workflow.seedInputs) ? workflow.seedInputs[variationIndex] : undefined
        jobs.push({
          workflowId: workflow.workflowId,
          workflowLabel: workflow.label,
          category: workflow.category,
          outputType: workflow.outputType,
          prompt: promptEntry.prompt,
          negativePrompt: promptEntry.negativePrompt,
          promptLabel: promptEntry.label,
          promptIndex: promptState.prompts.indexOf(promptEntry) + 1,
          promptCount: promptState.prompts.length,
          variation: variationIndex + 1,
          variationCount: workflow.variations,
          seed: makePromptBatchSeed(args.baseSeed, jobIndex, explicitSeed),
          durationSeconds: workflow.durationSeconds,
          fps: workflow.fps,
          resolution: workflow.resolution,
          folderId,
        })
        jobIndex += 1
      }
    }
  }

  return {
    action: 'queue_prompt_generation_batch',
    previewOnly: args.previewOnly !== false,
    prompts: promptState.prompts,
    workflows: workflowState.entries,
    jobs,
    folderId,
    totalJobs: jobs.length,
    limits: {
      maxVariationsPerWorkflow: MCP_PROMPT_BATCH_MAX_VARIATIONS_PER_WORKFLOW,
      maxTotalJobs: MCP_PROMPT_BATCH_MAX_TOTAL_JOBS,
    },
  }
}

function stripCaptureImageData(capture = null) {
  if (!capture || typeof capture !== 'object') return null
  const { image, ...metadata } = capture
  return {
    ...metadata,
    imageIncluded: Boolean(image?.data),
  }
}

function stripRangeCaptureImageData(capture = null) {
  if (!capture || typeof capture !== 'object') return null
  const { contactSheet, frames, ...metadata } = capture
  return {
    ...metadata,
    contactSheet: contactSheet ? {
      imageIncluded: Boolean(contactSheet.data),
      mimeType: contactSheet.mimeType || '',
      width: contactSheet.width || null,
      height: contactSheet.height || null,
      size: contactSheet.size || null,
    } : null,
    frames: Array.isArray(frames)
      ? frames.map(({ data, ...frame }) => ({ ...frame, imageIncluded: Boolean(data) }))
      : [],
  }
}

function resolveVisibleShotRange(timeline, args = {}) {
  const fps = Math.max(1, toFiniteNumber(timeline?.fps, 24))
  const timelineDuration = Math.max(0, toFiniteNumber(timeline?.duration, 0))
  const playhead = toFiniteNumber(timeline?.playheadPosition, 0)
  const useWholeTimeline = args.wholeTimeline === true
  const startSecondsArg = Number(args.startSeconds)
  const startFrameArg = Number(args.startFrame)
  const endSecondsArg = Number(args.endSeconds)
  const endFrameArg = Number(args.endFrame)
  const durationArg = Number(args.durationSeconds)

  let startSeconds = useWholeTimeline
    ? 0
    : Number.isFinite(startSecondsArg)
      ? startSecondsArg
      : Number.isFinite(startFrameArg)
        ? startFrameArg / fps
        : playhead
  let endSeconds = Number.isFinite(endSecondsArg)
    ? endSecondsArg
    : Number.isFinite(endFrameArg)
      ? endFrameArg / fps
      : Number.isFinite(durationArg)
        ? startSeconds + durationArg
        : timelineDuration

  if (endSeconds < startSeconds) {
    const nextStart = endSeconds
    endSeconds = startSeconds
    startSeconds = nextStart
  }

  startSeconds = Math.max(0, startSeconds)
  endSeconds = Math.max(0, endSeconds)
  if (timelineDuration > 0) {
    startSeconds = Math.min(startSeconds, Math.max(0, timelineDuration - (1 / fps)))
    endSeconds = Math.min(endSeconds, timelineDuration)
  }
  if (endSeconds <= startSeconds) {
    endSeconds = timelineDuration > 0
      ? Math.min(timelineDuration, startSeconds + (1 / fps))
      : startSeconds + (1 / fps)
  }

  return {
    startSeconds: roundTime(startSeconds),
    endSeconds: roundTime(endSeconds),
    durationSeconds: roundTime(Math.max(0, endSeconds - startSeconds)),
    fps,
  }
}

function resolveVisibleShotSamples(timeline, args = {}) {
  const range = resolveVisibleShotRange(timeline, args)
  const tracks = Array.isArray(timeline?.tracks) ? timeline.tracks : []
  const trackById = new Map(tracks.map((track) => [track?.id, track]))
  const fps = range.fps
  const frameDuration = 1 / fps
  const offsetFrames = Math.max(0, Math.floor(getNumberArg(args, 'offsetFrames', 2, 0, 24)))
  const offsetSeconds = offsetFrames * frameDuration
  const frameForTime = (time) => Math.max(0, Math.round(toFiniteNumber(time, 0) * fps))
  const timeForFrame = (frame) => frame / fps
  const boundaryFrames = new Set([
    frameForTime(range.startSeconds),
    frameForTime(range.endSeconds),
  ])

  for (const clip of timeline?.clips || []) {
    const track = trackById.get(clip?.trackId)
    if (!isVisualTimelineClip(clip, track)) continue
    const clipStart = getClipStart(clip)
    const clipEnd = getClipEnd(clip)
    if (clipEnd <= range.startSeconds || clipStart >= range.endSeconds) continue
    boundaryFrames.add(frameForTime(Math.max(range.startSeconds, clipStart)))
    boundaryFrames.add(frameForTime(Math.min(range.endSeconds, clipEnd)))
  }

  const boundaries = [...boundaryFrames]
    .sort((a, b) => a - b)
    .map((frame) => timeForFrame(frame))
    .filter((time, index, source) => index === 0 || Math.abs(time - source[index - 1]) > frameDuration / 2)

  const shots = []
  let previousTopClipId = ''
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const segmentStart = Math.max(range.startSeconds, boundaries[index])
    const segmentEnd = Math.min(range.endSeconds, boundaries[index + 1])
    const segmentDuration = segmentEnd - segmentStart
    if (segmentDuration <= frameDuration / 2) continue

    const sampleOffset = segmentDuration > offsetSeconds + frameDuration
      ? offsetSeconds
      : Math.max(frameDuration / 2, segmentDuration / 2)
    const sampleTime = Math.min(segmentEnd - (frameDuration / 4), segmentStart + sampleOffset)
    const sampleFrame = frameForTime(sampleTime)
    const timeSeconds = roundTime(timeForFrame(sampleFrame))
    const frameClips = getTimelineFrameClips(timeline, timeSeconds)
    const topVisibleClip = frameClips.topVisibleClip
    if (!topVisibleClip?.id) continue
    if (topVisibleClip.id === previousTopClipId) continue
    previousTopClipId = topVisibleClip.id

    const shotIndex = shots.length
    const timecode = formatTimelineTimecode(timeSeconds, fps)
    shots.push({
      index: shotIndex,
      shotNumber: shotIndex + 1,
      segmentStart: roundTime(segmentStart),
      segmentEnd: roundTime(segmentEnd),
      segmentDuration: roundTime(segmentDuration),
      timeSeconds,
      frame: sampleFrame,
      fps,
      timecode,
      label: `${shotIndex + 1}. ${timecode}`,
      offsetFrames,
      activeClipCount: frameClips.activeClips.length,
      visualClipCount: frameClips.visualClips.length,
      topVisibleClip,
      activeClips: frameClips.activeClips,
      visualClipsTopFirst: frameClips.visualClips,
    })
  }

  return {
    ...range,
    offsetFrames,
    totalShotCount: shots.length,
    shots,
  }
}

function resolveTimelineRangeSamples(timeline, args = {}) {
  const fps = Math.max(1, toFiniteNumber(timeline?.fps, 24))
  const timelineDuration = Math.max(0, toFiniteNumber(timeline?.duration, 0))
  const playhead = toFiniteNumber(timeline?.playheadPosition, 0)
  const startSecondsArg = Number(args.startSeconds)
  const startFrameArg = Number(args.startFrame)
  const endSecondsArg = Number(args.endSeconds)
  const endFrameArg = Number(args.endFrame)
  const durationArg = Number(args.durationSeconds)
  let startSeconds = Number.isFinite(startSecondsArg)
    ? startSecondsArg
    : Number.isFinite(startFrameArg)
      ? startFrameArg / fps
      : playhead
  let endSeconds = Number.isFinite(endSecondsArg)
    ? endSecondsArg
    : Number.isFinite(endFrameArg)
      ? endFrameArg / fps
      : Number.isFinite(durationArg)
        ? startSeconds + durationArg
        : startSeconds + 10

  if (endSeconds < startSeconds) {
    const nextStart = endSeconds
    endSeconds = startSeconds
    startSeconds = nextStart
  }

  startSeconds = Math.max(0, startSeconds)
  endSeconds = Math.max(0, endSeconds)
  if (timelineDuration > 0) {
    startSeconds = Math.min(startSeconds, Math.max(0, timelineDuration - (1 / fps)))
    endSeconds = Math.min(endSeconds, timelineDuration)
  }
  if (endSeconds <= startSeconds) {
    endSeconds = timelineDuration > 0
      ? Math.min(timelineDuration, startSeconds + (1 / fps))
      : startSeconds + (1 / fps)
  }

  const requestedSampleCount = Math.floor(getNumberArg(args, 'sampleCount', 5, 1, 12))
  const sampleEndSeconds = timelineDuration > 0
    ? Math.min(endSeconds, Math.max(startSeconds, timelineDuration - (1 / fps)))
    : endSeconds
  const sampleCount = Math.max(1, requestedSampleCount)
  const rawTimes = sampleCount === 1
    ? [startSeconds + ((sampleEndSeconds - startSeconds) / 2)]
    : Array.from({ length: sampleCount }, (_entry, index) => {
      const progress = index / Math.max(1, sampleCount - 1)
      return startSeconds + ((sampleEndSeconds - startSeconds) * progress)
    })

  const seenFrames = new Set()
  const samples = []
  for (const time of rawTimes) {
    const clampedTime = timelineDuration > 0
      ? Math.min(Math.max(0, time), Math.max(0, timelineDuration - (1 / fps)))
      : Math.max(0, time)
    const frame = Math.max(0, Math.round(clampedTime * fps))
    if (seenFrames.has(frame)) continue
    seenFrames.add(frame)
    const timeSeconds = roundTime(clampedTime)
    samples.push({
      index: samples.length,
      timeSeconds,
      frame,
      fps,
      timecode: formatTimelineTimecode(clampedTime, fps),
      label: `${samples.length + 1}. ${formatTimelineTimecode(clampedTime, fps)}`,
      ...getTimelineFrameClips(timeline, timeSeconds),
    })
  }

  return {
    startSeconds: roundTime(startSeconds),
    endSeconds: roundTime(endSeconds),
    durationSeconds: roundTime(Math.max(0, endSeconds - startSeconds)),
    fps,
    requestedSampleCount,
    sampleCount: samples.length,
    samples,
  }
}

function addFinding(findings, finding) {
  findings.push({
    severity: finding.severity || 'info',
    code: finding.code || 'note',
    message: finding.message || '',
    ...finding,
  })
}

function countBy(items = [], getKey) {
  return items.reduce((counts, item) => {
    const key = getKey(item) || 'unknown'
    counts[key] = (counts[key] || 0) + 1
    return counts
  }, {})
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

function joinHumanList(items = []) {
  const cleanItems = items.filter(Boolean)
  if (cleanItems.length === 0) return ''
  if (cleanItems.length === 1) return cleanItems[0]
  if (cleanItems.length === 2) return `${cleanItems[0]} and ${cleanItems[1]}`
  return `${cleanItems.slice(0, -1).join(', ')}, and ${cleanItems[cleanItems.length - 1]}`
}

function describeFindingCodes(findings = [], severity = null) {
  const labels = {
    missing_asset: ['missing asset', 'missing assets'],
    invalid_clip_start: ['invalid clip start', 'invalid clip starts'],
    invalid_clip_duration: ['invalid clip duration', 'invalid clip durations'],
    tiny_clip: ['tiny clip', 'tiny clips'],
    clip_without_asset: ['clip without an asset', 'clips without assets'],
    missing_track: ['clip on a missing track', 'clips on missing tracks'],
    invalid_trim_range: ['invalid trim range', 'invalid trim ranges'],
    tiny_track_gap: ['tiny gap', 'tiny gaps'],
    track_overlap: ['clip overlap', 'clip overlaps'],
    hidden_track_with_clips: ['hidden track with clips', 'hidden tracks with clips'],
    disabled_clip: ['disabled clip', 'disabled clips'],
    muted_audio_track_with_clips: ['muted audio track with clips', 'muted audio tracks with clips'],
    locked_track_with_clips: ['locked track with clips', 'locked tracks with clips'],
    speed_changed_clip: ['speed-changed clip', 'speed-changed clips'],
    failed_music_assets: ['failed music-video asset', 'failed music-video assets'],
    active_music_jobs: ['active music-video job', 'active music-video jobs'],
    shots_with_keyframes_no_video: ['shot with keyframes but no video', 'shots with keyframes but no videos'],
    shots_with_videos_no_keyframes: ['shot with video but no keyframe', 'shots with videos but no keyframes'],
    unassembled_music_videos: ['unassembled music-video video', 'unassembled music-video videos'],
    duplicate_video_variants: ['duplicate video variant', 'duplicate video variants'],
    shots_with_multiple_videos: ['shot with multiple videos', 'shots with multiple videos'],
    manual_replacements: ['manual replacement', 'manual replacements'],
  }
  const matching = severity ? findings.filter((finding) => finding.severity === severity) : findings
  const counts = countBy(matching, (finding) => finding.code)
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, count]) => {
      const [singular, plural] = labels[code] || [code.replace(/_/g, ' '), `${code.replace(/_/g, ' ')} items`]
      return pluralize(count, singular, plural)
    })
}

function rankFindings(findings = []) {
  const rank = { error: 0, warning: 1, info: 2 }
  return [...findings].sort((a, b) => {
    const severityDelta = (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9)
    if (severityDelta !== 0) return severityDelta
    return String(a.code || '').localeCompare(String(b.code || ''))
  })
}

function getMusicYolo(asset) {
  return asset?.yolo || asset?.settings?.yolo || null
}

function isMusicVideoAsset(asset) {
  const yolo = getMusicYolo(asset)
  return Boolean(yolo?.mode === 'music' || yolo?.workflow === 'music-video' || yolo?.musicVideo)
}

function getMusicAssetStage(asset) {
  const yolo = getMusicYolo(asset) || {}
  if (yolo.stage) return String(yolo.stage)
  if (asset?.type === 'image') return 'storyboard'
  if (asset?.type === 'video') return 'video'
  return String(asset?.type || 'unknown')
}

function getMusicShotId(assetOrYolo) {
  const yolo = assetOrYolo?.yolo || assetOrYolo?.settings?.yolo || assetOrYolo || {}
  return String(yolo.shotId || yolo.shot_id || '').trim()
}

function getMusicVariantKey(assetOrYolo) {
  const yolo = assetOrYolo?.yolo || assetOrYolo?.settings?.yolo || assetOrYolo || {}
  return String(yolo.variantKey || yolo.key || '').trim()
}

function musicAssetRef(asset) {
  const yolo = getMusicYolo(asset) || {}
  return {
    id: asset?.id,
    name: asset?.name,
    type: asset?.type,
    stage: getMusicAssetStage(asset),
    status: asset?.generationStatus || asset?.status || 'none',
    shotId: getMusicShotId(yolo),
    variantKey: getMusicVariantKey(yolo),
    workflowId: yolo.workflowId || asset?.workflowId || asset?.settings?.workflowId || '',
    coverage: yolo.coverage?.label || yolo.coverage?.type || '',
    manualReplacement: Boolean(yolo.manualReplacement),
    createdAt: asset?.createdAt || asset?.imported || null,
    error: asset?.error || asset?.generationError || asset?.settings?.error || '',
  }
}

function analyzeMusicVideoWorkflow(snapshot, args = {}) {
  const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : []
  const timeline = snapshot?.currentTimeline || null
  const clips = Array.isArray(timeline?.clips) ? timeline.clips : []
  const maxFindings = clampLimit(args.maxFindings, 75, 250)
  const musicAssets = assets.filter(isMusicVideoAsset)
  const musicAssetIds = new Set(musicAssets.map((asset) => asset?.id).filter(Boolean))
  const timelineAssetIds = new Set(clips.map((clip) => clip?.assetId).filter(Boolean))
  const activeStates = new Set(['queued', 'generating', 'downloading', 'encoding', 'running'])
  const failedStates = new Set(['failed', 'error'])
  const findings = []

  if (musicAssets.length === 0) {
    return {
      summary: 'No music-video workflow assets were detected in the open project.',
      project: {
        name: snapshot?.project?.name || '',
        path: snapshot?.project?.path || '',
      },
      health: { status: 'no_music_video_assets', severityCounts: { error: 0, warning: 0, info: 1 } },
      findings: [{
        severity: 'info',
        code: 'no_music_video_assets',
        message: 'This project does not currently expose music-video assets through the MCP snapshot.',
      }],
      suggestedNextActions: ['Open or generate a music-video project, then run this analysis again.'],
      generatedAt: new Date().toISOString(),
    }
  }

  const byStage = countBy(musicAssets, getMusicAssetStage)
  const byWorkflow = countBy(musicAssets, (asset) => musicAssetRef(asset).workflowId || getMusicAssetStage(asset))
  const byCoverage = countBy(musicAssets, (asset) => musicAssetRef(asset).coverage || 'uncategorized')
  const shotsById = new Map()
  const variantsByKey = new Map()
  const failedAssets = []
  const activeAssets = []
  const manualReplacementAssets = []
  const unassembledVideos = []

  const ensureShot = (shotId) => {
    const key = shotId || 'unknown'
    if (!shotsById.has(key)) {
      shotsById.set(key, {
        shotId: key,
        assetCount: 0,
        storyboardCount: 0,
        videoCount: 0,
        failedCount: 0,
        activeCount: 0,
        assembledClipCount: 0,
        syncLockedClipCount: 0,
        manualReplacementCount: 0,
        workflows: {},
        coverage: {},
        variants: {},
      })
    }
    return shotsById.get(key)
  }

  for (const asset of musicAssets) {
    const ref = musicAssetRef(asset)
    const status = String(ref.status || '').toLowerCase()
    const shot = ensureShot(ref.shotId || ref.variantKey || 'unknown')
    shot.assetCount += 1
    if (ref.stage === 'storyboard') shot.storyboardCount += 1
    if (ref.stage === 'video') shot.videoCount += 1
    if (activeStates.has(status)) {
      shot.activeCount += 1
      activeAssets.push(ref)
    }
    if (failedStates.has(status) || ref.error) {
      shot.failedCount += 1
      failedAssets.push(ref)
    }
    if (ref.manualReplacement) {
      shot.manualReplacementCount += 1
      manualReplacementAssets.push(ref)
    }
    if (ref.workflowId) shot.workflows[ref.workflowId] = (shot.workflows[ref.workflowId] || 0) + 1
    if (ref.coverage) shot.coverage[ref.coverage] = (shot.coverage[ref.coverage] || 0) + 1
    if (ref.variantKey) {
      shot.variants[ref.variantKey] = (shot.variants[ref.variantKey] || 0) + 1
      if (!variantsByKey.has(ref.variantKey)) {
        variantsByKey.set(ref.variantKey, {
          variantKey: ref.variantKey,
          shotId: ref.shotId,
          storyboardCount: 0,
          videoCount: 0,
          activeCount: 0,
          failedCount: 0,
          assembledClipCount: 0,
          workflows: {},
        })
      }
      const variant = variantsByKey.get(ref.variantKey)
      if (ref.stage === 'storyboard') variant.storyboardCount += 1
      if (ref.stage === 'video') variant.videoCount += 1
      if (activeStates.has(status)) variant.activeCount += 1
      if (failedStates.has(status) || ref.error) variant.failedCount += 1
      if (ref.workflowId) variant.workflows[ref.workflowId] = (variant.workflows[ref.workflowId] || 0) + 1
    }

    if (ref.stage === 'video' && asset?.id && !timelineAssetIds.has(asset.id)) unassembledVideos.push(ref)
  }

  const assembledClips = clips.filter((clip) => clip?.metadata?.musicVideoAssembly || musicAssetIds.has(clip?.assetId))
  const syncLockedClips = clips.filter((clip) => clip?.lockMode === 'sync' || clip?.syncLock?.mode === 'sync')
  for (const clip of assembledClips) {
    const shotId = String(
      clip?.metadata?.musicVideoAssembly?.shotId
      || clip?.syncLock?.shotId
      || ''
    ).trim()
    const variantKey = String(
      clip?.metadata?.musicVideoAssembly?.variantKey
      || clip?.syncLock?.variantKey
      || ''
    ).trim()
    if (shotId) ensureShot(shotId).assembledClipCount += 1
    if (variantKey && variantsByKey.has(variantKey)) variantsByKey.get(variantKey).assembledClipCount += 1
  }
  for (const clip of syncLockedClips) {
    const shotId = String(clip?.syncLock?.shotId || clip?.metadata?.musicVideoAssembly?.shotId || '').trim()
    if (shotId) ensureShot(shotId).syncLockedClipCount += 1
  }

  const shots = Array.from(shotsById.values())
    .filter((shot) => shot.shotId !== 'unknown')
    .sort((a, b) => a.shotId.localeCompare(b.shotId, undefined, { numeric: true }))
  const variants = Array.from(variantsByKey.values())
  const shotsWithKeyframesNoVideo = shots.filter((shot) => shot.storyboardCount > 0 && shot.videoCount === 0)
  const shotsWithVideosNoKeyframes = shots.filter((shot) => shot.videoCount > 0 && shot.storyboardCount === 0)
  const shotsWithMultipleVideos = shots.filter((shot) => shot.videoCount > 1)
  const variantsWithMultipleVideos = variants.filter((variant) => variant.videoCount > 1)

  if (failedAssets.length > 0) {
    addFinding(findings, {
      severity: 'error',
      code: 'failed_music_assets',
      message: `${pluralize(failedAssets.length, 'music-video asset')} failed or contains an error.`,
      assets: failedAssets.slice(0, 25),
    })
  }
  if (activeAssets.length > 0) {
    addFinding(findings, {
      severity: 'info',
      code: 'active_music_jobs',
      message: `${pluralize(activeAssets.length, 'music-video asset')} still appears active.`,
      assets: activeAssets.slice(0, 25),
    })
  }
  if (shotsWithKeyframesNoVideo.length > 0) {
    addFinding(findings, {
      severity: 'warning',
      code: 'shots_with_keyframes_no_video',
      message: `${pluralize(shotsWithKeyframesNoVideo.length, 'shot')} has keyframes but no detected video asset.`,
      shots: shotsWithKeyframesNoVideo.slice(0, 25).map((shot) => shot.shotId),
    })
  }
  if (shotsWithVideosNoKeyframes.length > 0) {
    addFinding(findings, {
      severity: 'info',
      code: 'shots_with_videos_no_keyframes',
      message: `${pluralize(shotsWithVideosNoKeyframes.length, 'shot')} has video assets but no detected keyframe asset.`,
      shots: shotsWithVideosNoKeyframes.slice(0, 25).map((shot) => shot.shotId),
    })
  }
  if (unassembledVideos.length > 0) {
    addFinding(findings, {
      severity: 'info',
      code: 'unassembled_music_videos',
      message: `${pluralize(unassembledVideos.length, 'music-video video')} exists in assets but is not currently used by a timeline clip.`,
      assets: unassembledVideos.slice(0, 25),
    })
  }
  if (variantsWithMultipleVideos.length > 0) {
    addFinding(findings, {
      severity: 'info',
      code: 'duplicate_video_variants',
      message: `${pluralize(variantsWithMultipleVideos.length, 'variant')} has multiple video assets, usually from reruns or replacements.`,
      variants: variantsWithMultipleVideos.slice(0, 25),
    })
  } else if (shotsWithMultipleVideos.length > 0) {
    addFinding(findings, {
      severity: 'info',
      code: 'shots_with_multiple_videos',
      message: `${pluralize(shotsWithMultipleVideos.length, 'shot')} has multiple video assets, usually from alternate passes or reruns.`,
      shots: shotsWithMultipleVideos.slice(0, 25).map((shot) => shot.shotId),
    })
  }
  if (manualReplacementAssets.length > 0) {
    addFinding(findings, {
      severity: 'info',
      code: 'manual_replacements',
      message: `${pluralize(manualReplacementAssets.length, 'music-video asset')} came from manual replacement/import.`,
      assets: manualReplacementAssets.slice(0, 25),
    })
  }

  const rankedFindings = rankFindings(findings)
  const limitedFindings = rankedFindings.slice(0, maxFindings)
  const severityCounts = rankedFindings.reduce((counts, finding) => {
    counts[finding.severity] = (counts[finding.severity] || 0) + 1
    return counts
  }, { error: 0, warning: 0, info: 0 })
  const status = severityCounts.error > 0
    ? 'needs_attention'
    : severityCounts.warning > 0
      ? 'review_recommended'
      : 'looks_good'
  const summary = `Music-video workflow has ${musicAssets.length} music assets across ${pluralize(shots.length, 'detected shot')}: ${pluralize(byStage.storyboard || 0, 'keyframe/storyboard')} and ${pluralize(byStage.video || 0, 'video')}. ${pluralize(assembledClips.length, 'timeline clip')} ${assembledClips.length === 1 ? 'uses' : 'use'} music-video assets, with ${pluralize(syncLockedClips.length, 'sync-locked clip')}. Found ${severityCounts.error} blocking issue(s), ${severityCounts.warning} warning(s), and ${severityCounts.info} note(s).`
  const warningDetails = describeFindingCodes(rankedFindings, 'warning')
  const errorDetails = describeFindingCodes(rankedFindings, 'error')
  const infoDetails = describeFindingCodes(rankedFindings, 'info')
  const suggestedNextActions = []
  if (severityCounts.error > 0) suggestedNextActions.push(`Fix ${pluralize(severityCounts.error, 'blocking issue')}: ${joinHumanList(errorDetails)}.`)
  if (shotsWithKeyframesNoVideo.length > 0) suggestedNextActions.push(`Queue or import videos for ${pluralize(shotsWithKeyframesNoVideo.length, 'shot')} that already have keyframes.`)
  if (severityCounts.warning > 0 && shotsWithKeyframesNoVideo.length === 0) suggestedNextActions.push(`Review ${pluralize(severityCounts.warning, 'warning')}: ${joinHumanList(warningDetails)}.`)
  if (unassembledVideos.length > 0) suggestedNextActions.push(`${pluralize(unassembledVideos.length, 'video')} ${unassembledVideos.length === 1 ? 'exists' : 'exist'} outside the current timeline; assemble or ignore ${unassembledVideos.length === 1 ? 'it' : 'them'} depending on the edit.`)
  if (suggestedNextActions.length === 0) suggestedNextActions.push('Music-video workflow state looks ready based on the current assets and timeline.')
  if (severityCounts.info > 0 && infoDetails.length > 0) suggestedNextActions.push(`Notes: ${joinHumanList(infoDetails)}.`)

  return {
    summary,
    project: {
      name: snapshot?.project?.name || '',
      path: snapshot?.project?.path || '',
    },
    currentTimeline: timeline ? {
      id: timeline.id,
      name: timeline.name,
      duration: roundTime(timeline.duration),
      clipCount: clips.length,
    } : null,
    health: {
      status,
      severityCounts,
      findingCount: rankedFindings.length,
      returnedFindingCount: limitedFindings.length,
      findingLimitApplied: rankedFindings.length > limitedFindings.length,
    },
    metrics: {
      musicAssetCount: musicAssets.length,
      detectedShotCount: shots.length,
      detectedVariantCount: variants.length,
      assetsByStage: byStage,
      assetsByWorkflow: byWorkflow,
      assetsByCoverage: byCoverage,
      assembledClipCount: assembledClips.length,
      syncLockedClipCount: syncLockedClips.length,
      failedAssetCount: failedAssets.length,
      activeAssetCount: activeAssets.length,
      manualReplacementCount: manualReplacementAssets.length,
      unassembledVideoCount: unassembledVideos.length,
      shotsWithKeyframesNoVideoCount: shotsWithKeyframesNoVideo.length,
      shotsWithVideosNoKeyframesCount: shotsWithVideosNoKeyframes.length,
      duplicateVideoVariantCount: variantsWithMultipleVideos.length,
    },
    findings: limitedFindings,
    notableShots: {
      keyframesNoVideo: shotsWithKeyframesNoVideo.slice(0, 25),
      videosNoKeyframes: shotsWithVideosNoKeyframes.slice(0, 25),
      multipleVideos: shotsWithMultipleVideos.slice(0, 25),
    },
    notableAssets: {
      failed: failedAssets.slice(0, 25),
      active: activeAssets.slice(0, 25),
      unassembledVideos: unassembledVideos.slice(0, 25),
      manualReplacements: manualReplacementAssets.slice(0, 25),
    },
    suggestedNextActions,
    generatedAt: new Date().toISOString(),
  }
}

function analyzeTimeline(snapshot, args = {}) {
  const timeline = snapshot?.currentTimeline || null
  if (!timeline) {
    return {
      summary: 'No current timeline is available to analyze.',
      health: { status: 'blocked', severityCounts: { error: 1, warning: 0, info: 0 } },
      findings: [{
        severity: 'error',
        code: 'no_current_timeline',
        message: 'ComfyStudio does not currently have an active timeline snapshot.',
      }],
    }
  }

  const clips = Array.isArray(timeline.clips) ? timeline.clips : []
  const tracks = Array.isArray(timeline.tracks) ? timeline.tracks : []
  const transitions = Array.isArray(timeline.transitions) ? timeline.transitions : []
  const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : []
  const assetById = new Map(assets.map((asset) => [asset?.id, asset]).filter(([id]) => id))
  const trackById = new Map(tracks.map((track) => [track?.id, track]).filter(([id]) => id))
  const fps = toFiniteNumber(timeline.fps, 24) || 24
  const frameDuration = 1 / fps
  const maxFindings = clampLimit(args.maxFindings, 75, 250)
  const tinyClipSeconds = getNumberArg(args, 'tinyClipSeconds', Math.max(frameDuration * 2, 0.1), 0.001, 2)
  const overlapThresholdSeconds = getNumberArg(args, 'overlapThresholdSeconds', Math.max(frameDuration / 2, 0.01), 0.001, 2)
  const tinyGapMinSeconds = getNumberArg(args, 'tinyGapMinSeconds', Math.max(frameDuration / 4, 0.01), 0.001, 1)
  const tinyGapMaxSeconds = getNumberArg(args, 'tinyGapMaxSeconds', Math.max(frameDuration * 2, 0.1), 0.002, 2)
  const findings = []
  const tinyClips = []
  const missingAssetClips = []
  const transformedClips = []
  const xmlImportedClips = []
  const syncLockedClips = []
  const disabledClips = []
  const labeledClips = []
  const speedChangedClips = []

  for (const clip of clips) {
    const duration = getClipDuration(clip)
    const start = getClipStart(clip)
    const track = trackById.get(clip?.trackId)

    if (!Number.isFinite(Number(clip?.startTime))) {
      addFinding(findings, {
        severity: 'error',
        code: 'invalid_clip_start',
        message: `Clip "${clip?.name || clip?.id}" has an invalid start time.`,
        clip: clipRef(clip),
      })
    }

    if (!Number.isFinite(Number(clip?.duration)) || duration <= 0) {
      addFinding(findings, {
        severity: 'error',
        code: 'invalid_clip_duration',
        message: `Clip "${clip?.name || clip?.id}" has an invalid or zero duration.`,
        clip: clipRef(clip),
      })
    } else if (duration < tinyClipSeconds) {
      tinyClips.push(clipRef(clip))
      addFinding(findings, {
        severity: 'warning',
        code: 'tiny_clip',
        message: `Clip "${clip?.name || clip?.id}" is only ${roundTime(duration)}s long, which can cause export or timeline edge-case issues.`,
        clip: clipRef(clip),
      })
    }

    if (isAssetBackedClip(clip) && clip?.assetId && !assetById.has(clip.assetId)) {
      missingAssetClips.push(clipRef(clip))
      addFinding(findings, {
        severity: 'error',
        code: 'missing_asset',
        message: `Clip "${clip?.name || clip?.id}" references an asset that is not present in the project asset list.`,
        clip: clipRef(clip),
      })
    }

    if (isAssetBackedClip(clip) && !clip?.assetId) {
      addFinding(findings, {
        severity: 'warning',
        code: 'clip_without_asset',
        message: `Clip "${clip?.name || clip?.id}" has no asset reference.`,
        clip: clipRef(clip),
      })
    }

    if (clip?.enabled === false) {
      disabledClips.push(clipRef(clip))
      addFinding(findings, {
        severity: 'info',
        code: 'disabled_clip',
        message: `Clip "${clip?.name || clip?.id}" is disabled and will not play/export normally.`,
        clip: clipRef(clip),
      })
    }

    if (!track && clip?.trackId) {
      addFinding(findings, {
        severity: 'warning',
        code: 'missing_track',
        message: `Clip "${clip?.name || clip?.id}" references a track that is not present in the timeline track list.`,
        clip: clipRef(clip),
      })
    }

    if (hasNonDefaultTransform(clip?.transform)) transformedClips.push(clipRef(clip))
    if (clip?.labelColor) labeledClips.push({ ...clipRef(clip), labelColor: clip.labelColor })
    if (clip?.metadata?.importedFromFcpXml) xmlImportedClips.push(clipRef(clip))
    if (clip?.lockMode === 'sync' || clip?.syncLock?.mode === 'sync') syncLockedClips.push(clipRef(clip))
    if (Math.abs(toFiniteNumber(clip?.speed, 1) - 1) > 0.001) {
      speedChangedClips.push(clipRef(clip))
      addFinding(findings, {
        severity: 'info',
        code: 'speed_changed_clip',
        message: `Clip "${clip?.name || clip?.id}" has a playback speed of ${clip?.speed}.`,
        clip: clipRef(clip),
      })
    }

    const trimStart = Number(clip?.trimStart)
    const trimEnd = Number(clip?.trimEnd)
    if (Number.isFinite(trimStart) && Number.isFinite(trimEnd) && trimEnd <= trimStart) {
      addFinding(findings, {
        severity: 'warning',
        code: 'invalid_trim_range',
        message: `Clip "${clip?.name || clip?.id}" has a trim range where trimEnd is not after trimStart.`,
        clip: clipRef({ ...clip, startTime: start, duration }),
      })
    }
  }

  const trackSummaries = tracks.map((track) => {
    const trackClips = clips
      .filter((clip) => clip?.trackId === track?.id)
      .sort((a, b) => getClipStart(a) - getClipStart(b))
    const enabledClips = trackClips.filter((clip) => clip?.enabled !== false)
    const validClips = enabledClips.filter((clip) => getClipDuration(clip) > 0)
    const tinyTrackClips = validClips.filter((clip) => getClipDuration(clip) < tinyClipSeconds)
    let gapCount = 0
    let tinyGapCount = 0
    let overlapCount = 0
    let firstStart = null
    let lastEnd = null
    let previous = null

    for (const clip of validClips) {
      const start = getClipStart(clip)
      const end = getClipEnd(clip)
      firstStart = firstStart === null ? start : Math.min(firstStart, start)
      lastEnd = lastEnd === null ? end : Math.max(lastEnd, end)

      if (previous) {
        const previousEnd = getClipEnd(previous)
        const gap = start - previousEnd
        const overlap = previousEnd - start
        if (gap > 0) gapCount += 1
        if (gap >= tinyGapMinSeconds && gap <= tinyGapMaxSeconds) {
          tinyGapCount += 1
          addFinding(findings, {
            severity: 'warning',
            code: 'tiny_track_gap',
            message: `Track "${track?.name || track?.id}" has a tiny ${roundTime(gap)}s gap between "${previous?.name || previous?.id}" and "${clip?.name || clip?.id}".`,
            trackId: track?.id,
            clips: [clipRef(previous), clipRef(clip)],
            gapSeconds: roundTime(gap),
          })
        }
        if (overlap > overlapThresholdSeconds) {
          overlapCount += 1
          addFinding(findings, {
            severity: 'warning',
            code: 'track_overlap',
            message: `Track "${track?.name || track?.id}" has a ${roundTime(overlap)}s overlap between "${previous?.name || previous?.id}" and "${clip?.name || clip?.id}".`,
            trackId: track?.id,
            clips: [clipRef(previous), clipRef(clip)],
            overlapSeconds: roundTime(overlap),
          })
        }
      }
      previous = clip
    }

    if (track?.visible === false && enabledClips.length > 0) {
      addFinding(findings, {
        severity: 'warning',
        code: 'hidden_track_with_clips',
        message: `Track "${track?.name || track?.id}" is hidden but contains ${enabledClips.length} enabled clips.`,
        trackId: track?.id,
      })
    }

    if (track?.muted && String(track?.type || '').toLowerCase() === 'audio' && enabledClips.length > 0) {
      addFinding(findings, {
        severity: 'info',
        code: 'muted_audio_track_with_clips',
        message: `Audio track "${track?.name || track?.id}" is muted and contains ${enabledClips.length} enabled clips.`,
        trackId: track?.id,
      })
    }

    if (track?.locked && enabledClips.length > 0) {
      addFinding(findings, {
        severity: 'info',
        code: 'locked_track_with_clips',
        message: `Track "${track?.name || track?.id}" is locked and contains ${enabledClips.length} enabled clips.`,
        trackId: track?.id,
      })
    }

    return {
      id: track?.id,
      name: track?.name,
      type: track?.type,
      visible: track?.visible !== false,
      muted: Boolean(track?.muted),
      locked: Boolean(track?.locked),
      clipCount: trackClips.length,
      enabledClipCount: enabledClips.length,
      startTime: firstStart === null ? null : roundTime(firstStart),
      endTime: lastEnd === null ? null : roundTime(lastEnd),
      gapCount,
      tinyGapCount,
      overlapCount,
      tinyClipCount: tinyTrackClips.length,
    }
  })

  const rankedFindings = rankFindings(findings)
  const limitedFindings = rankedFindings.slice(0, maxFindings)
  const severityCounts = rankedFindings.reduce((counts, finding) => {
    counts[finding.severity] = (counts[finding.severity] || 0) + 1
    return counts
  }, { error: 0, warning: 0, info: 0 })
  const status = severityCounts.error > 0
    ? 'needs_attention'
    : severityCounts.warning > 0
      ? 'review_recommended'
      : 'looks_good'
  const timelineName = timeline.name || 'Untitled timeline'
  const summary = severityCounts.error > 0 || severityCounts.warning > 0
    ? `Timeline "${timelineName}" has ${clips.length} clips across ${tracks.length} tracks. Found ${severityCounts.error} blocking issue(s), ${severityCounts.warning} warning(s), and ${severityCounts.info} informational note(s).`
    : `Timeline "${timelineName}" looks structurally healthy: ${clips.length} clips across ${tracks.length} tracks, with no blocking issues or warnings detected.`

  const suggestedNextActions = []
  const errorDetails = describeFindingCodes(rankedFindings, 'error')
  const warningDetails = describeFindingCodes(rankedFindings, 'warning')
  const infoDetails = describeFindingCodes(rankedFindings, 'info')
  if (severityCounts.error > 0) {
    suggestedNextActions.push(`Fix ${pluralize(severityCounts.error, 'blocking issue')} before exporting: ${joinHumanList(errorDetails)}.`)
  }
  if (severityCounts.warning > 0) {
    suggestedNextActions.push(`Review ${pluralize(severityCounts.warning, 'warning')} before export: ${joinHumanList(warningDetails)}.`)
  }
  if (severityCounts.error === 0 && missingAssetClips.length === 0) {
    suggestedNextActions.push('No missing media or blocking timeline issues were detected.')
  }
  if (severityCounts.info > 0 && infoDetails.length > 0) {
    suggestedNextActions.push(`Informational notes: ${joinHumanList(infoDetails)}.`)
  }
  if (suggestedNextActions.length === 0) suggestedNextActions.push('No immediate timeline cleanup is required based on this read-only analysis.')

  return {
    summary,
    project: {
      name: snapshot?.project?.name || '',
      path: snapshot?.project?.path || '',
    },
    timeline: {
      id: timeline.id,
      name: timelineName,
      duration: roundTime(timeline.duration),
      fps,
      width: timeline.width,
      height: timeline.height,
      trackCount: tracks.length,
      clipCount: clips.length,
      transitionCount: transitions.length,
    },
    health: {
      status,
      severityCounts,
      findingCount: rankedFindings.length,
      returnedFindingCount: limitedFindings.length,
      findingLimitApplied: rankedFindings.length > limitedFindings.length,
    },
    metrics: {
      clipCounts: countBy(clips, (clip) => clip?.type),
      assetCounts: summarizeAssetCounts(assets),
      xmlImportedClipCount: xmlImportedClips.length,
      transformedClipCount: transformedClips.length,
      syncLockedClipCount: syncLockedClips.length,
      disabledClipCount: disabledClips.length,
      labeledClipCount: labeledClips.length,
      speedChangedClipCount: speedChangedClips.length,
      transitionCount: transitions.length,
    },
    findings: limitedFindings,
    trackSummaries,
    notableClips: {
      missingAssets: missingAssetClips.slice(0, 25),
      tiny: tinyClips.slice(0, 25),
      transformed: transformedClips.slice(0, 25),
      xmlImported: xmlImportedClips.slice(0, 25),
      syncLocked: syncLockedClips.slice(0, 25),
      disabled: disabledClips.slice(0, 25),
      labeled: labeledClips.slice(0, 25),
      speedChanged: speedChangedClips.slice(0, 25),
    },
    suggestedNextActions,
    generatedAt: new Date().toISOString(),
  }
}

function createToolDefinitions() {
  return [
    {
      name: 'get_project',
      description: 'Return a concise summary of the open ComfyStudio project, current timeline, asset counts, and MCP snapshot freshness.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_timeline',
      description: 'Return the current timeline with tracks and clips. Clip timing is in seconds. Use assetId values with get_assets.',
      inputSchema: {
        type: 'object',
        properties: {
          includeClips: { type: 'boolean', description: 'Include timeline clips. Defaults to true.' },
          includeTransitions: { type: 'boolean', description: 'Include transitions. Defaults to false.' },
          limit: { type: 'integer', description: 'Maximum clips to return. Defaults to 300.' },
        },
      },
    },
    {
      name: 'get_assets',
      description: 'Return media assets from the open project. Heavy preview URLs and blobs are never exposed.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Optional asset type filter: video, audio, image, mask, etc.' },
          status: { type: 'string', description: 'Optional generationStatus/status filter.' },
          limit: { type: 'integer', description: 'Maximum assets to return. Defaults to 200.' },
        },
      },
    },
    {
      name: 'get_ai_review_passes',
      description: 'Return practical AI review recipes for ComfyStudio MCP clients: timeline health, visible-shot review, hero presence checks, marker cleanup, disabled clip labeling, clip enable/disable previews, delivery checks, and current-frame questions.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'diagnose_comfyui_connection',
      description: 'Diagnose the local ComfyUI connection used by ComfyStudio. Checks the configured localhost port, ComfyUI API endpoints, launcher state, port owner, likely install mode such as portable/Desktop/Docker/manual, and returns support-friendly next steps.',
      inputSchema: {
        type: 'object',
        properties: {
          port: { type: 'integer', description: 'Optional local ComfyUI port to test. Defaults to ComfyStudio Settings > ComfyUI Connection.' },
          timeoutMs: { type: 'integer', description: 'Request timeout in milliseconds. Defaults to 4500, max 30000.' },
        },
      },
    },
    {
      name: 'set_comfyui_connection',
      description: 'Set the local ComfyUI connection port used by ComfyStudio. Supports previewOnly so assistants can propose the change before applying it. This changes ComfyStudio settings only; it does not restart ComfyUI or edit launcher scripts.',
      inputSchema: {
        type: 'object',
        properties: {
          port: { type: 'integer', description: 'Local ComfyUI port to save, for example 8188.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the proposed before/after setting without changing ComfyStudio.' },
        },
        required: ['port'],
      },
    },
    {
      name: 'repair_comfyui_connection',
      description: 'Diagnose the configured ComfyUI port, probe likely local ports, and propose or apply a settings fix when ComfyUI is reachable on a different localhost port. Use previewOnly first unless the user already approved the change.',
      inputSchema: {
        type: 'object',
        properties: {
          strategy: {
            type: 'string',
            enum: ['useReachablePort'],
            description: 'Repair strategy. useReachablePort finds a reachable local ComfyUI port and points ComfyStudio at it.',
          },
          candidatePorts: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Optional local ports to probe. Defaults to common ComfyUI ports plus the configured port.',
          },
          timeoutMs: { type: 'integer', description: 'Request timeout per probe in milliseconds. Defaults to 4500, max 30000.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the proposed repair without changing ComfyStudio. Defaults to true.' },
        },
      },
    },
    {
      name: 'control_comfyui_launcher',
      description: 'Preview or apply ComfyUI launcher actions through ComfyStudio: start, stop, or restart. Defaults to previewOnly for safety. Stop/restart can interrupt running generations and only work for ComfyUI processes owned by ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'stop', 'restart'],
            description: 'Launcher action to preview or run.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the action plan without starting/stopping/restarting ComfyUI. Defaults to true.',
          },
        },
        required: ['action'],
      },
    },
    {
      name: 'get_comfyui_launcher_logs',
      description: 'Return recent ComfyUI launcher log lines from ComfyStudio, with a lightweight summary of common support issues like port conflicts, import errors, missing models/files, and CUDA memory errors.',
      inputSchema: {
        type: 'object',
        properties: {
          tailLines: { type: 'integer', description: 'Number of recent log lines to return. Defaults to 200, max 2000.' },
          streams: {
            type: 'array',
            items: { type: 'string', enum: ['system', 'stdout', 'stderr', 'event', 'generation'] },
            description: 'Optional stream filter.',
          },
          includeIssueSummary: { type: 'boolean', description: 'Include detected issue summary. Defaults to true.' },
        },
      },
    },
    {
      name: 'validate_comfyui_nodes',
      description: 'Check whether specific ComfyUI node class names are available from /object_info. Useful when a workflow fails because custom nodes are missing or not loading.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeClasses: {
            type: 'array',
            items: { type: 'string' },
            description: 'ComfyUI class_type names to check, for example ["KSampler", "LoadImage", "VHS_VideoCombine"].',
          },
          port: { type: 'integer', description: 'Optional local ComfyUI port to test. Defaults to ComfyStudio Settings > ComfyUI Connection.' },
          timeoutMs: { type: 'integer', description: 'Request timeout in milliseconds. Defaults to 4500, max 30000.' },
        },
        required: ['nodeClasses'],
      },
    },
    {
      name: 'list_comfystudio_workflows',
      description: 'List bundled ComfyStudio workflows available on this machine, with category, local/cloud runtime, input-image requirement, and workflow file names. Useful before choosing a workflow for local generation or setup checks.',
      inputSchema: {
        type: 'object',
        properties: {
          runtime: {
            type: 'string',
            enum: ['local', 'cloud'],
            description: 'Optional runtime filter. Use local for workflows intended to run on the user machine.',
          },
          category: {
            type: 'string',
            enum: ['video', 'image', 'audio', 'text'],
            description: 'Optional workflow category filter.',
          },
          query: {
            type: 'string',
            description: 'Optional search text matched against workflow id, label, description, and file.',
          },
          refresh: {
            type: 'boolean',
            description: 'Refresh the workflow catalog from disk. Defaults to false.',
          },
        },
      },
    },
    {
      name: 'inspect_comfystudio_workflow',
      description: 'Inspect a bundled or explicit ComfyStudio workflow JSON, extract required ComfyUI class_type node names, validate them against the configured local ComfyUI /object_info, and return install/update hints for missing nodes.',
      inputSchema: {
        type: 'object',
        properties: {
          workflowId: {
            type: 'string',
            description: 'Workflow id from list_comfystudio_workflows, for example z-image-turbo, ltx23-i2v, image-edit, caption-qwen-asr, or music-video-shot-ltx23.',
          },
          workflowFile: {
            type: 'string',
            description: 'Bundled workflow JSON filename if workflowId is unknown, for example image_z_image_turbo.json.',
          },
          workflowPath: {
            type: 'string',
            description: 'Explicit local workflow JSON path. Use only when inspecting a custom workflow file.',
          },
          includeValidation: {
            type: 'boolean',
            description: 'Validate node classes against local ComfyUI. Defaults to true.',
          },
          includeNodeClasses: {
            type: 'boolean',
            description: 'Include the extracted node class list. Defaults to true.',
          },
          port: {
            type: 'integer',
            description: 'Optional local ComfyUI port to test. Defaults to ComfyStudio Settings > ComfyUI Connection.',
          },
          timeoutMs: {
            type: 'integer',
            description: 'Request timeout in milliseconds. Defaults to 4500, max 30000.',
          },
          refresh: {
            type: 'boolean',
            description: 'Refresh the workflow catalog from disk before resolving workflowId.',
          },
        },
      },
    },
    {
      name: 'check_export_readiness',
      description: 'Check whether the current timeline is ready for a standard delivery export, especially MP4 H.264 HD. Reports blockers, warnings, target codec/resolution/range, and suggested next actions.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: ['h264_hd', 'h264_1080p', 'h264_720p', 'h264_square_1080', 'h264_square_720', 'h264_1x1_1080', 'h264_1x1_720', 'h264_vertical_1080', 'h264_vertical_720', 'h264_9x16_1080', 'h264_9x16_720', 'h264_project', 'h264_review_proxy'],
            description: 'Delivery target preset. Defaults to h264_hd.',
          },
          format: {
            type: 'string',
            enum: ['mp4'],
            description: 'Container format. Currently MP4 is the supported MCP delivery target.',
          },
          videoCodec: {
            type: 'string',
            enum: ['h264', 'h265'],
            description: 'Video codec. Defaults to h264.',
          },
          resolution: {
            type: 'string',
            enum: ['1080p', '720p', 'square_1080', 'square_720', 'square', '1x1', 'vertical_1080', 'vertical_720', '9x16', 'project', 'custom', 'timeline_half'],
            description: 'Export resolution. Defaults to 1080p for h264_hd. Use square_720/square_1080 for 1:1 exports or vertical_720/vertical_1080 for 9:16 exports.',
          },
          aspectRatio: {
            type: 'string',
            enum: ['16:9', '1:1', '1x1', 'square', '9:16', '9x16', 'vertical'],
            description: 'Optional output aspect ratio hint. Use 1:1/square for square exports or 9:16/vertical for portrait exports.',
          },
          width: {
            type: 'integer',
            description: 'Custom export width. Used with resolution=custom.',
          },
          height: {
            type: 'integer',
            description: 'Custom export height. Used with resolution=custom.',
          },
          fps: {
            type: 'number',
            description: 'Export frame rate. Defaults to the current timeline FPS.',
          },
          range: {
            type: 'string',
            enum: ['full', 'custom'],
            description: 'Export range. Defaults to full timeline.',
          },
          startSeconds: {
            type: 'number',
            description: 'Custom export range start in seconds.',
          },
          endSeconds: {
            type: 'number',
            description: 'Custom export range end in seconds.',
          },
          includeAudio: {
            type: 'boolean',
            description: 'Include timeline audio. Defaults to true.',
          },
          deliveryFraming: {
            type: 'string',
            enum: ['fit', 'fill', 'center_crop'],
            description: 'How to adapt timeline framing to a different aspect ratio. fit preserves the full frame with letterbox/pillarbox. fill/center_crop fills the output by cropping from center. Square MCP targets default to fill.',
          },
        },
      },
    },
    {
      name: 'inspect_clip',
      description: 'Inspect one timeline clip with its track, source asset, timing, transform, label, and a representative still image when available.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: {
            type: 'string',
            description: 'Timeline clip ID from get_timeline.',
          },
          includeImage: {
            type: 'boolean',
            description: 'Include best available image content for the clip. Defaults to true.',
          },
          maxImageBytes: {
            type: 'integer',
            description: 'Maximum local image size to embed. Defaults to 3 MB.',
          },
        },
        required: ['clipId'],
      },
    },
    {
      name: 'inspect_timeline_frame',
      description: 'Capture the composed timeline preview frame at the playhead, a time in seconds, or a frame number. Returns visible clip context plus MCP image content when available.',
      inputSchema: {
        type: 'object',
        properties: {
          timeSeconds: {
            type: 'number',
            description: 'Optional timeline time in seconds. Defaults to the current ComfyStudio playhead.',
          },
          frame: {
            type: 'integer',
            description: 'Optional timeline frame number. Used when timeSeconds is omitted.',
          },
          includeImage: {
            type: 'boolean',
            description: 'Include the captured frame image. Defaults to true.',
          },
          maxWidth: {
            type: 'integer',
            description: 'Maximum captured image width. Defaults to 1280.',
          },
          maxHeight: {
            type: 'integer',
            description: 'Maximum captured image height. Defaults to 720.',
          },
          maxImageBytes: {
            type: 'integer',
            description: 'Maximum embedded image size. Defaults to 4 MB.',
          },
        },
      },
    },
    {
      name: 'prepare_generation_from_timeline_context',
      description: 'Prepare the Generate tab from the current timeline context. Uses the selected visible video/image clip when possible, otherwise the playhead frame. Defaults to previewOnly and never queues generation; applying captures the frame, opens Generate, and prefills workflow/prompt/settings for user review.',
      inputSchema: {
        type: 'object',
        properties: {
          timeSeconds: {
            type: 'number',
            description: 'Optional timeline time in seconds. Defaults to current playhead, or a representative frame from the selected clip when the playhead is not on it.',
          },
          time: {
            type: 'number',
            description: 'Alias for timeSeconds.',
          },
          frame: {
            type: 'integer',
            description: 'Optional timeline frame number. Used when timeSeconds is omitted.',
          },
          mode: {
            type: 'string',
            enum: ['extend', 'keyframe'],
            description: 'How the captured frame should be used in Generate. Defaults to extend.',
          },
          workflowId: {
            type: 'string',
            description: 'ComfyStudio workflow id to select in Generate. Defaults to ltx23-i2v.',
          },
          category: {
            type: 'string',
            enum: ['video', 'image', 'audio', 'text'],
            description: 'Generate category to open. Defaults to video.',
          },
          prompt: {
            type: 'string',
            description: 'Prompt to prefill. If omitted, ComfyStudio tries to reuse prompt metadata from the source clip/asset.',
          },
          negativePrompt: {
            type: 'string',
            description: 'Negative prompt to prefill when supported.',
          },
          durationSeconds: {
            type: 'number',
            description: 'Optional generation duration to prefill when the workflow supports it.',
          },
          duration: {
            type: 'number',
            description: 'Alias for durationSeconds.',
          },
          width: {
            type: 'integer',
            description: 'Top-level output width alias. Used with height when resolution is omitted.',
          },
          height: {
            type: 'integer',
            description: 'Top-level output height alias. Used with width when resolution is omitted.',
          },
          fps: {
            type: 'number',
            description: 'Optional generation FPS to prefill when the workflow supports it.',
          },
          resolution: {
            type: 'object',
            description: 'Optional resolution object to prefill, for example { "width": 1280, "height": 720 }.',
            properties: {
              width: { type: 'integer' },
              height: { type: 'integer' },
            },
          },
          resolutionSource: {
            type: 'string',
            enum: ['auto', 'source', 'input', 'timeline', 'sequence', 'project', 'generate'],
            description: 'When width/height/resolution are omitted, choose which aspect to match. source/input uses the visible source asset; timeline/sequence uses the active timeline; project uses project settings; generate leaves the current Generate tab resolution unchanged.',
          },
          openGenerateTab: {
            type: 'boolean',
            description: 'When false, captures and stores the frame without switching tabs. Defaults to true on apply.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the plan without capturing a frame or opening Generate. Defaults to true.',
          },
        },
      },
    },
    {
      name: 'queue_prepared_generation',
      description: 'Queue the generation currently staged in the Generate tab by using the same queue path as ComfyStudio’s Queue button. Use previewOnly first. Applying can start local/credit-backed generation depending on the selected workflow, so only call with previewOnly=false after explicit user approval.',
      inputSchema: {
        type: 'object',
        properties: {
          previewOnly: {
            type: 'boolean',
            description: 'When true, inspects whether the staged Generate request is queueable without queueing it. Defaults to true.',
          },
          requireTimelineFrame: {
            type: 'boolean',
            description: 'When true, refuses to queue unless Generate is staged with a timeline frame from prepare_generation_from_timeline_context. Defaults to true.',
          },
          timeoutMs: {
            type: 'integer',
            description: 'Renderer response timeout in milliseconds. Defaults to 10000.',
          },
        },
      },
    },
    {
      name: 'queue_timeline_generation_batch',
      description: 'Preview or queue a batch of image-to-video generations from the selected clip or current playhead frame. Supports flexible variation counts per workflow, for example 2 WAN 2.2 variations and 7 LTX 2.3 variations. Defaults to previewOnly; applying can start local/credit-backed generation, so require explicit user approval first.',
      inputSchema: {
        type: 'object',
        properties: {
          timeSeconds: {
            type: 'number',
            description: 'Optional timeline time in seconds. Defaults to the current playhead, or a representative frame from the selected clip when useful.',
          },
          time: {
            type: 'number',
            description: 'Alias for timeSeconds.',
          },
          frame: {
            type: 'integer',
            description: 'Optional timeline frame number. Used when timeSeconds is omitted.',
          },
          workflowIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Workflow ids or aliases to queue, for example ["wan22-i2v", "ltx23-i2v"]. Supports WAN 2.2 and LTX 2.3 in this first version.',
          },
          workflows: {
            type: 'array',
            description: 'Per-workflow batch settings. Each item may include workflowId, variations/count, and optional seeds.',
            items: {
              type: 'object',
              properties: {
                workflowId: { type: 'string' },
                id: { type: 'string' },
                name: { type: 'string' },
                variations: { type: 'integer' },
                variationCount: { type: 'integer' },
                count: { type: 'integer' },
                seeds: {
                  type: 'array',
                  items: { type: 'integer' },
                },
              },
            },
          },
          workflowId: {
            type: 'string',
            description: 'Single workflow id or alias when workflowIds/workflows is omitted.',
          },
          variationsPerWorkflow: {
            type: 'integer',
            description: 'Default number of variations for each workflow. Maximum 8 per workflow.',
          },
          variations: {
            type: 'integer',
            description: 'Alias for variationsPerWorkflow.',
          },
          count: {
            type: 'integer',
            description: 'Alias for variationsPerWorkflow.',
          },
          baseSeed: {
            type: 'integer',
            description: 'Optional base seed. If provided, each queued job increments from this seed.',
          },
          seeds: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Optional explicit seeds across the whole batch.',
          },
          prompt: {
            type: 'string',
            description: 'Prompt for every variation. If omitted, ComfyStudio tries to reuse prompt metadata from the source clip/asset.',
          },
          negativePrompt: {
            type: 'string',
            description: 'Negative prompt for every variation when supported.',
          },
          durationSeconds: {
            type: 'number',
            description: 'Optional generation duration for every queued job.',
          },
          duration: {
            type: 'number',
            description: 'Alias for durationSeconds.',
          },
          durationSource: {
            type: 'string',
            enum: ['source', 'source_clip', 'clip', 'default'],
            description: 'When durationSeconds is omitted, source/source_clip/clip matches the visible source clip duration; default uses the standard 5 second generation duration.',
          },
          width: {
            type: 'integer',
            description: 'Top-level output width alias. Used with height when resolution is omitted.',
          },
          height: {
            type: 'integer',
            description: 'Top-level output height alias. Used with width when resolution is omitted.',
          },
          fps: {
            type: 'number',
            description: 'Optional generation FPS for every queued job.',
          },
          resolution: {
            type: 'object',
            description: 'Optional generation resolution object, for example { "width": 1280, "height": 720 }. If omitted, MCP matches the source clip aspect at a model-friendly size such as 1280x720 for 16:9.',
            properties: {
              width: { type: 'integer' },
              height: { type: 'integer' },
            },
          },
          resolutionSource: {
            type: 'string',
            enum: ['auto', 'source', 'input', 'timeline', 'sequence', 'project', 'generate'],
            description: 'When width/height/resolution are omitted, choose which aspect to match. source/input uses the visible source asset; timeline/sequence uses the active timeline; project uses project settings; generate leaves the current Generate tab resolution unchanged.',
          },
          openGenerateTab: {
            type: 'boolean',
            description: 'When true, also opens Generate with the captured frame. Defaults to false for batch queueing.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the batch plan without capturing or queueing. Defaults to true.',
          },
          timeoutMs: {
            type: 'integer',
            description: 'Renderer response timeout in milliseconds. Defaults to 30000.',
          },
        },
      },
    },
    {
      name: 'queue_prompt_generation_batch',
      description: 'Preview or queue text-to-image/text-to-video generation jobs directly from written prompts. Use this for brief-to-assets workflows before assembling a sequence. Defaults to previewOnly; applying can start local/credit-backed generation, so require explicit user approval first.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Single prompt to generate from. Use prompts for multiple source prompts.',
          },
          prompts: {
            type: 'array',
            description: 'Multiple prompts. Items can be strings or objects with prompt/text, negativePrompt, and label.',
            items: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    prompt: { type: 'string' },
                    text: { type: 'string' },
                    negativePrompt: { type: 'string' },
                    label: { type: 'string' },
                  },
                },
              ],
            },
          },
          workflowIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Prompt workflow ids or aliases, for example ["z-image-turbo", "ltx23-t2v"].',
          },
          workflows: {
            type: 'array',
            description: 'Per-workflow batch settings. Each item may include workflowId, variations/count, seeds, resolution, durationSeconds, and fps.',
            items: {
              type: 'object',
              properties: {
                workflowId: { type: 'string' },
                id: { type: 'string' },
                name: { type: 'string' },
                workflowLabel: { type: 'string' },
                variations: { type: 'integer' },
                variationCount: { type: 'integer' },
                count: { type: 'integer' },
                seeds: {
                  type: 'array',
                  items: { type: 'integer' },
                },
                resolution: {
                  type: 'object',
                  properties: {
                    width: { type: 'integer' },
                    height: { type: 'integer' },
                  },
                },
                durationSeconds: { type: 'number' },
                duration: { type: 'number' },
                fps: { type: 'number' },
              },
            },
          },
          workflowId: {
            type: 'string',
            description: 'Single prompt workflow id or alias when workflowIds/workflows is omitted. Defaults to z-image-turbo.',
          },
          variationsPerWorkflow: {
            type: 'integer',
            description: 'Default number of variations for each workflow/prompt pair. Maximum 8 per workflow.',
          },
          variationsPerPrompt: {
            type: 'integer',
            description: 'Alias for variationsPerWorkflow.',
          },
          variations: {
            type: 'integer',
            description: 'Alias for variationsPerWorkflow.',
          },
          count: {
            type: 'integer',
            description: 'Alias for variationsPerWorkflow.',
          },
          baseSeed: {
            type: 'integer',
            description: 'Optional base seed. If provided, each queued job increments from this seed.',
          },
          seeds: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Optional explicit seeds across the whole batch.',
          },
          negativePrompt: {
            type: 'string',
            description: 'Negative prompt used for prompts that do not provide their own negativePrompt.',
          },
          durationSeconds: {
            type: 'number',
            description: 'Optional generation duration for video workflows.',
          },
          duration: {
            type: 'number',
            description: 'Alias for durationSeconds.',
          },
          fps: {
            type: 'number',
            description: 'Optional generation FPS for video workflows.',
          },
          resolution: {
            type: 'object',
            description: 'Optional generation resolution object, for example { "width": 1280, "height": 720 }.',
            properties: {
              width: { type: 'integer' },
              height: { type: 'integer' },
            },
          },
          folderId: {
            type: 'string',
            description: 'Optional existing ComfyStudio asset folder ID where generated result assets should be organized after import. Use create_asset_folder first when a new folder is needed.',
          },
          outputFolderId: {
            type: 'string',
            description: 'Alias for folderId.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the batch plan without queueing. Defaults to true.',
          },
          timeoutMs: {
            type: 'integer',
            description: 'Renderer response timeout in milliseconds. Defaults to 30000.',
          },
        },
      },
    },
    {
      name: 'inspect_timeline_range',
      description: 'Sample a timeline range and return a labeled visual contact sheet/storyboard plus clip context for each sampled frame.',
      inputSchema: {
        type: 'object',
        properties: {
          startSeconds: {
            type: 'number',
            description: 'Optional range start in seconds. Defaults to the current ComfyStudio playhead.',
          },
          endSeconds: {
            type: 'number',
            description: 'Optional range end in seconds. Defaults to startSeconds plus 10 seconds.',
          },
          durationSeconds: {
            type: 'number',
            description: 'Optional duration when endSeconds is omitted.',
          },
          startFrame: {
            type: 'integer',
            description: 'Optional range start frame. Used when startSeconds is omitted.',
          },
          endFrame: {
            type: 'integer',
            description: 'Optional range end frame. Used when endSeconds is omitted.',
          },
          sampleCount: {
            type: 'integer',
            description: 'Number of evenly spaced samples to capture. Defaults to 5, maximum 12.',
          },
          includeImage: {
            type: 'boolean',
            description: 'Include image content. Defaults to true.',
          },
          returnMode: {
            type: 'string',
            enum: ['contact_sheet', 'frames', 'both'],
            description: 'Image return style. Defaults to contact_sheet.',
          },
          maxWidth: {
            type: 'integer',
            description: 'Maximum width of each sampled frame in the contact sheet. Defaults to 640.',
          },
          maxHeight: {
            type: 'integer',
            description: 'Maximum height of each sampled frame in the contact sheet. Defaults to 360.',
          },
          maxImageBytes: {
            type: 'integer',
            description: 'Maximum embedded image size. Defaults to 6 MB.',
          },
        },
      },
    },
    {
      name: 'inspect_visible_shots',
      description: 'Find top-visible shot changes in the timeline, sample near the start of each visible shot, and return a contact sheet plus shot metadata. Designed for fast-cut edit review.',
      inputSchema: {
        type: 'object',
        properties: {
          wholeTimeline: {
            type: 'boolean',
            description: 'When true, inspect from timeline start to end. Otherwise starts at current playhead unless startSeconds/startFrame is provided.',
          },
          startSeconds: {
            type: 'number',
            description: 'Optional range start in seconds. Defaults to current playhead unless wholeTimeline is true.',
          },
          endSeconds: {
            type: 'number',
            description: 'Optional range end in seconds. Defaults to timeline end.',
          },
          durationSeconds: {
            type: 'number',
            description: 'Optional duration when endSeconds is omitted.',
          },
          startFrame: {
            type: 'integer',
            description: 'Optional range start frame. Used when startSeconds is omitted.',
          },
          endFrame: {
            type: 'integer',
            description: 'Optional range end frame. Used when endSeconds is omitted.',
          },
          offsetFrames: {
            type: 'integer',
            description: 'Frames after each visible shot start to sample. Defaults to 2.',
          },
          offset: {
            type: 'integer',
            description: 'Shot-list page offset. Defaults to 0.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum visible shots to capture in this page. Defaults to 30, maximum 120.',
          },
          includeImage: {
            type: 'boolean',
            description: 'Include a contact-sheet image. Defaults to true.',
          },
          returnMode: {
            type: 'string',
            enum: ['contact_sheet', 'frames', 'both'],
            description: 'Image return style. Defaults to contact_sheet.',
          },
          maxWidth: {
            type: 'integer',
            description: 'Maximum width of each sampled shot in the contact sheet. Defaults to 480.',
          },
          maxHeight: {
            type: 'integer',
            description: 'Maximum height of each sampled shot in the contact sheet. Defaults to 270.',
          },
          maxImageBytes: {
            type: 'integer',
            description: 'Maximum embedded image size. Defaults to 8 MB.',
          },
        },
      },
    },
    {
      name: 'get_generation_status',
      description: 'Return active, failed, and recent generated asset status for the open project.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_music_video_status',
      description: 'Summarize ComfyStudio music-video workflow assets, assembled clips, and sync-locked clips in the current project.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'analyze_timeline',
      description: 'Return an AI-friendly read-only timeline health report with likely export risks, missing media, tiny clips/gaps, overlaps, track state, XML imports, transforms, and next actions.',
      inputSchema: {
        type: 'object',
        properties: {
          maxFindings: { type: 'integer', description: 'Maximum findings to return. Defaults to 75.' },
          tinyClipSeconds: { type: 'number', description: 'Clips shorter than this are reported as tiny clip risks. Defaults to about two frames.' },
          overlapThresholdSeconds: { type: 'number', description: 'Overlaps larger than this are reported. Defaults to about half a frame.' },
          tinyGapMinSeconds: { type: 'number', description: 'Minimum gap size to report as a tiny gap.' },
          tinyGapMaxSeconds: { type: 'number', description: 'Maximum gap size to report as a tiny gap.' },
        },
      },
    },
    {
      name: 'analyze_music_video_workflow',
      description: 'Return an AI-friendly read-only health report for the music-video workflow, including generated keyframes/videos, failed or active jobs, assembled clips, sync locks, reruns/replacements, and next actions.',
      inputSchema: {
        type: 'object',
        properties: {
          maxFindings: { type: 'integer', description: 'Maximum findings to return. Defaults to 75.' },
        },
      },
    },
    {
      name: 'set_clip_label_color',
      description: 'Set or clear label colors for current timeline clips by explicit clipIds or a safe built-in filter. Non-destructive and undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          color: {
            type: 'string',
            description: 'Hex #RRGGBB label color. Use an empty string to clear labels.',
          },
          clipIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Explicit clip IDs from get_timeline. Preferred for precise edits.',
          },
          filter: {
            type: 'string',
            enum: ['enabled', 'disabled', 'transformed', 'sync_locked', 'xml_imported', 'speed_changed', 'labeled', 'unlabeled'],
            description: 'Optional target filter when clipIds are omitted.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns matching clips without changing them.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum clips this call may affect. Defaults to 100.',
          },
        },
      },
    },
    {
      name: 'set_clips_enabled',
      description: 'Enable or disable current timeline clips by explicit clipIds or a safe built-in filter. Use previewOnly first for AI-assisted edit decisions. Undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          enabled: {
            type: 'boolean',
            description: 'True to enable clips, false to disable clips.',
          },
          clipIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Explicit clip IDs from get_timeline or inspect_visible_shots. Preferred for precise editorial actions.',
          },
          filter: {
            type: 'string',
            enum: ['enabled', 'disabled', 'transformed', 'sync_locked', 'xml_imported', 'speed_changed', 'labeled', 'unlabeled'],
            description: 'Optional target filter when clipIds are omitted.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns matching clips and the intended enabled state without changing them.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum clips this call may affect. Defaults to 100.',
          },
        },
        required: ['enabled'],
      },
    },
    {
      name: 'add_timeline_markers',
      description: 'Add one or more labeled timeline markers at explicit times, frames, or the current playhead. Non-destructive and undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          markers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                timeSeconds: { type: 'number', description: 'Marker time in seconds.' },
                frame: { type: 'integer', description: 'Marker frame number. Used when timeSeconds is omitted.' },
                label: { type: 'string', description: 'Short marker label.' },
                color: { type: 'string', description: 'Optional hex #RRGGBB marker color.' },
              },
            },
            description: 'Markers to add. If omitted, a single marker is added from top-level fields or the current playhead.',
          },
          timeSeconds: {
            type: 'number',
            description: 'Single-marker time in seconds. Defaults to current playhead.',
          },
          frame: {
            type: 'integer',
            description: 'Single-marker frame number. Used when timeSeconds is omitted.',
          },
          label: {
            type: 'string',
            description: 'Single-marker label.',
          },
          color: {
            type: 'string',
            description: 'Default marker color as hex #RRGGBB. Defaults to yellow.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the markers that would be added without changing the timeline.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum markers this call may add. Defaults to 25.',
          },
        },
      },
    },
    {
      name: 'remove_timeline_markers',
      description: 'Remove timeline markers by ID, all markers, marker color, label text, or time range. Undoable in ComfyStudio; use previewOnly for safety.',
      inputSchema: {
        type: 'object',
        properties: {
          all: {
            type: 'boolean',
            description: 'Remove all timeline markers.',
          },
          markerIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Explicit marker IDs from get_timeline.',
          },
          color: {
            type: 'string',
            description: 'Remove markers matching this hex #RRGGBB color.',
          },
          labelContains: {
            type: 'string',
            description: 'Remove markers whose label contains this text.',
          },
          startSeconds: {
            type: 'number',
            description: 'Only remove markers at or after this time in seconds.',
          },
          endSeconds: {
            type: 'number',
            description: 'Only remove markers at or before this time in seconds.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns matching markers without removing them.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum markers this call may remove. Defaults to 100.',
          },
        },
      },
    },
    {
      name: 'set_timeline_marker_properties',
      description: 'Rename, recolor, or move existing timeline markers by ID, color, label text, or time range. Undoable in ComfyStudio; use previewOnly before changing many review markers.',
      inputSchema: {
        type: 'object',
        properties: {
          all: {
            type: 'boolean',
            description: 'Update all timeline markers.',
          },
          markerIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Explicit marker IDs from get_timeline.',
          },
          color: {
            type: 'string',
            description: 'Target markers currently matching this hex #RRGGBB color.',
          },
          labelContains: {
            type: 'string',
            description: 'Target markers whose label contains this text.',
          },
          startSeconds: {
            type: 'number',
            description: 'Only target markers at or after this time in seconds.',
          },
          endSeconds: {
            type: 'number',
            description: 'Only target markers at or before this time in seconds.',
          },
          label: {
            type: 'string',
            description: 'Replacement marker label. Use an empty string to clear marker labels.',
          },
          newColor: {
            type: 'string',
            description: 'Replacement marker color as hex #RRGGBB. Use an empty string to clear marker colors.',
          },
          setColor: {
            type: 'string',
            description: 'Alias for newColor.',
          },
          timeSeconds: {
            type: 'number',
            description: 'Move a single targeted marker to this absolute time in seconds.',
          },
          frame: {
            type: 'integer',
            description: 'Move a single targeted marker to this absolute frame. Used when timeSeconds is omitted.',
          },
          timeOffsetSeconds: {
            type: 'number',
            description: 'Move all targeted markers by this signed offset in seconds.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the proposed marker changes without applying them.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum markers this call may update. Defaults to 100.',
          },
        },
      },
    },
    {
      name: 'create_timeline',
      description: 'Preview or create a new ComfyStudio sequence/timeline with a name, optional dimensions, fps, duration, and optional switch-to-new-sequence behavior. Defaults to previewOnly; applying is undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name for the new sequence/timeline.',
          },
          sequenceName: {
            type: 'string',
            description: 'Alias for name.',
          },
          timelineName: {
            type: 'string',
            description: 'Alias for name.',
          },
          width: {
            type: 'integer',
            description: 'Optional timeline width. Defaults to the current timeline/project width.',
          },
          height: {
            type: 'integer',
            description: 'Optional timeline height. Defaults to the current timeline/project height.',
          },
          fps: {
            type: 'number',
            description: 'Optional frame rate. Defaults to the current timeline/project fps.',
          },
          durationSeconds: {
            type: 'number',
            description: 'Optional starting timeline duration in seconds. Defaults to 60.',
          },
          duration: {
            type: 'number',
            description: 'Alias for durationSeconds.',
          },
          copySettingsFromCurrent: {
            type: 'boolean',
            description: 'When true, default dimensions/fps come from the active sequence. Defaults to true.',
          },
          switchToTimeline: {
            type: 'boolean',
            description: 'When true, switch ComfyStudio to the new sequence after creation. Defaults to true.',
          },
          activate: {
            type: 'boolean',
            description: 'Alias for switchToTimeline.',
          },
          color: {
            type: 'string',
            description: 'Optional sequence color as #RRGGBB.',
          },
          folderId: {
            type: 'string',
            description: 'Optional project folder ID for the new sequence asset/card.',
          },
          allowDuplicateName: {
            type: 'boolean',
            description: 'When true, allow duplicate sequence names. Defaults to false, which auto-suffixes duplicate names.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the sequence creation plan without changing the project. Defaults to true.',
          },
        },
      },
    },
    {
      name: 'create_asset_folder',
      description: 'Preview or create ComfyStudio asset-panel folders. Accepts a single folder name or a nested path like "AI Spots / July 4th Demo"; reuses existing matching folders by default and creates only missing folders.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Single folder name to create when path/folderPath is omitted.',
          },
          folderName: {
            type: 'string',
            description: 'Alias for name.',
          },
          path: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'Nested folder path to create, for example "Generated Spots / July 4th" or ["Generated Spots", "July 4th"].',
          },
          folderPath: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'Alias for path.',
          },
          parentId: {
            type: 'string',
            description: 'Optional existing parent folder ID. New path/name is created under this folder.',
          },
          parentPath: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'Optional existing parent folder path. Use path/folderPath instead if missing parent folders should be created.',
          },
          color: {
            type: 'string',
            description: 'Optional folder color as #RRGGBB. Applied to the leaf folder when created; existing leaf folders are recolored only when setColorOnExisting=true.',
          },
          reuseExisting: {
            type: 'boolean',
            description: 'When true, reuse existing same-name sibling folders. Defaults to true.',
          },
          setColorOnExisting: {
            type: 'boolean',
            description: 'When true and color is provided, recolor an existing reused leaf folder. Defaults to false.',
          },
          allowDuplicateName: {
            type: 'boolean',
            description: 'When true, allow duplicate sibling folder names if reuseExisting=false. Defaults to false, which auto-suffixes duplicates.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the folder creation plan without changing the project. Defaults to true.',
          },
        },
      },
    },
    {
      name: 'move_assets_to_folder',
      description: 'Preview or move existing ComfyStudio assets into an asset-panel folder. Can target explicit asset IDs/names or safe filters such as rootOnly + constantsOnly. Defaults to previewOnly and can create a missing target folder path before moving.',
      inputSchema: {
        type: 'object',
        properties: {
          targetFolderId: {
            type: 'string',
            description: 'Existing destination folder ID. Use this when create_asset_folder already returned a folderId.',
          },
          folderId: {
            type: 'string',
            description: 'Alias for targetFolderId.',
          },
          targetFolderPath: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'Destination folder path, for example "Constants" or "AI Spots / Constants". Missing folders are created on apply by default.',
          },
          folderPath: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'Alias for targetFolderPath.',
          },
          folderName: {
            type: 'string',
            description: 'Single destination folder name when targetFolderPath is omitted.',
          },
          targetRoot: {
            type: 'boolean',
            description: 'When true, move matching assets back to the asset root instead of into a folder.',
          },
          assetIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Explicit asset IDs to move.',
          },
          assetId: {
            type: 'string',
            description: 'Single asset ID to move.',
          },
          assetNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'Asset names to move. Exact match is preferred, partial match is allowed.',
          },
          assets: {
            type: 'array',
            description: 'Explicit asset references. Items can be asset IDs or objects with assetId/name.',
            items: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    assetId: { type: 'string' },
                    id: { type: 'string' },
                    assetName: { type: 'string' },
                    name: { type: 'string' },
                  },
                },
              ],
            },
          },
          rootOnly: {
            type: 'boolean',
            description: 'When true, only move assets currently in the asset root.',
          },
          sourceFolderId: {
            type: 'string',
            description: 'Only move assets currently inside this source folder.',
          },
          sourceFolderPath: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'Only move assets currently inside this source folder path.',
          },
          includeSubfolders: {
            type: 'boolean',
            description: 'When using a source folder, include nested folders. Defaults to true.',
          },
          type: {
            type: 'string',
            description: 'Optional asset type filter such as image, video, or audio.',
          },
          nameIncludes: {
            type: 'string',
            description: 'Optional case-insensitive name substring filter.',
          },
          workflowId: {
            type: 'string',
            description: 'Optional workflow ID filter.',
          },
          filter: {
            type: 'string',
            enum: ['solid_colors', 'constants', 'generated', 'imported'],
            description: 'Optional preset filter. Use solid_colors/constants for MCP-created color constants.',
          },
          solidColorsOnly: {
            type: 'boolean',
            description: 'When true, only move solid color/constant assets created by the MCP solid tool.',
          },
          constantsOnly: {
            type: 'boolean',
            description: 'Alias for solidColorsOnly.',
          },
          targetFolderColor: {
            type: 'string',
            description: 'Optional #RRGGBB color for a newly-created destination folder.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the exact move plan without changing the project. Defaults to true.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum assets this call may move. Defaults to 100.',
          },
        },
      },
    },
    {
      name: 'add_track',
      description: 'Create a new timeline track. Video tracks are added at the top of the stack, which is useful before adding another text/title layer. Undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['video', 'audio'],
            description: 'Track type. Defaults to video.',
          },
          name: {
            type: 'string',
            description: 'Optional track name, such as Titles 2 or AI Captions.',
          },
          channels: {
            type: 'string',
            enum: ['mono', 'stereo'],
            description: 'Audio track channel layout. Only used for audio tracks. Defaults to stereo.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the track creation plan without changing the timeline.',
          },
        },
      },
    },
    {
      name: 'add_asset_to_timeline',
      description: 'Preview or place a project asset on the active timeline. Can target a specific asset id/name or the latest generated asset, choose playhead/selected-clip/timeline-end placement, use an existing compatible track, or create a new top video/audio track. Defaults to previewOnly; applying is undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          assetId: {
            type: 'string',
            description: 'Project asset ID to place. If omitted, assetName or the latest placeable asset is used.',
          },
          assetName: {
            type: 'string',
            description: 'Exact or partial asset name to place.',
          },
          latestGenerated: {
            type: 'boolean',
            description: 'When true, place the most recent matching generated/placeable asset.',
          },
          latest: {
            type: 'boolean',
            description: 'Alias for latestGenerated.',
          },
          type: {
            type: 'string',
            enum: ['video', 'image', 'audio'],
            description: 'Optional asset type filter when resolving by name/latest.',
          },
          assetType: {
            type: 'string',
            enum: ['video', 'image', 'audio'],
            description: 'Alias for type.',
          },
          workflowId: {
            type: 'string',
            description: 'Optional workflow id filter when resolving the latest generated asset, for example ltx23-i2v.',
          },
          trackId: {
            type: 'string',
            description: 'Optional compatible target track ID. Video/image assets require a video track; audio assets require an audio track.',
          },
          createTrack: {
            type: 'boolean',
            description: 'When true, create a new compatible track before placing the asset. Video tracks are created at the top.',
          },
          newTrack: {
            type: 'boolean',
            description: 'Alias for createTrack.',
          },
          trackName: {
            type: 'string',
            description: 'Optional name for the new track when createTrack/newTrack is true.',
          },
          trackStrategy: {
            type: 'string',
            enum: ['existing', 'new', 'newTopTrack'],
            description: 'Optional track strategy. Use newTopTrack to compare generated variations on separate upper video layers.',
          },
          startSeconds: {
            type: 'number',
            description: 'Absolute timeline start time in seconds. Defaults to the playhead.',
          },
          startTime: {
            type: 'number',
            description: 'Alias for startSeconds.',
          },
          at: {
            type: 'string',
            enum: ['playhead', 'selected_clip_start', 'selected_clip_end', 'timeline_end', 'track_end'],
            description: 'Placement shortcut when startSeconds is omitted.',
          },
          placement: {
            type: 'string',
            description: 'Alias for at.',
          },
          durationSeconds: {
            type: 'number',
            description: 'Optional timeline duration. Defaults to 5 seconds for images, or source duration for video/audio when known.',
          },
          duration: {
            type: 'number',
            description: 'Alias for durationSeconds.',
          },
          resolveOverlaps: {
            type: 'boolean',
            description: 'When true, use normal timeline overwrite behavior on the target track. Defaults to true.',
          },
          selectAfterAdd: {
            type: 'boolean',
            description: 'When true, select the newly added clip. Defaults to true.',
          },
          transform: {
            type: 'object',
            description: 'Optional initial transform values such as positionX, positionY, scaleX, scaleY, rotation, opacity, blur, motion blur settings, or crop fields.',
          },
          includeAudio: {
            type: 'boolean',
            description: 'For video assets with embedded audio, also create a linked audio clip on an audio track. Defaults to true.',
          },
          includeEmbeddedAudio: {
            type: 'boolean',
            description: 'Alias for includeAudio.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the placement plan without changing the timeline. Defaults to true.',
          },
        },
      },
    },
    {
      name: 'add_solid_color',
      description: 'Preview or create a solid-color image asset, optionally placing it on the active timeline as a color/black constant. Useful for black plates under opacity fades, color backgrounds, and simple matte layers. Defaults to previewOnly; applying writes a PNG asset to the project and timeline placement is undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          color: {
            type: 'string',
            description: 'Solid color as #RRGGBB. Defaults to #000000.',
          },
          fill: {
            type: 'string',
            description: 'Alias for color.',
          },
          name: {
            type: 'string',
            description: 'Optional asset/clip base name. Defaults to Black solid or Color solid with dimensions.',
          },
          width: {
            type: 'integer',
            description: 'PNG width. Defaults to the current timeline/project width.',
          },
          height: {
            type: 'integer',
            description: 'PNG height. Defaults to the current timeline/project height.',
          },
          durationSeconds: {
            type: 'number',
            description: 'Timeline clip duration if placed. Defaults to 5 seconds.',
          },
          duration: {
            type: 'number',
            description: 'Alias for durationSeconds.',
          },
          placeOnTimeline: {
            type: 'boolean',
            description: 'When false, create only the asset. Defaults to true.',
          },
          addToTimeline: {
            type: 'boolean',
            description: 'Alias for placeOnTimeline.',
          },
          trackId: {
            type: 'string',
            description: 'Optional existing video track ID for placement.',
          },
          createTrack: {
            type: 'boolean',
            description: 'When true and trackId is omitted, create a video track for the solid. Defaults to true.',
          },
          trackName: {
            type: 'string',
            description: 'Optional new track name when creating a track.',
          },
          trackPlacement: {
            type: 'string',
            enum: ['bottom', 'top'],
            description: 'Where to insert a newly created video track. Defaults to bottom so black/color plates sit behind the edit.',
          },
          startSeconds: {
            type: 'number',
            description: 'Absolute timeline start time in seconds. Defaults to the playhead.',
          },
          startTime: {
            type: 'number',
            description: 'Alias for startSeconds.',
          },
          at: {
            type: 'string',
            enum: ['playhead', 'selected_clip_start', 'selected_clip_end', 'timeline_end', 'track_end'],
            description: 'Placement shortcut when startSeconds is omitted.',
          },
          resolveOverlaps: {
            type: 'boolean',
            description: 'When true, use normal overwrite behavior on the target track. Defaults to false for solids.',
          },
          selectAfterAdd: {
            type: 'boolean',
            description: 'When true, select the created timeline clip. Defaults to true.',
          },
          transform: {
            type: 'object',
            description: 'Optional initial transform values such as opacity, scale, position, crop, blur, or blendMode.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the solid creation/placement plan without writing a file or changing the timeline. Defaults to true.',
          },
        },
      },
    },
    {
      name: 'add_assets_to_timeline',
      description: 'Preview or place multiple project assets onto the active timeline as review lanes or a sequential run. Can target explicit asset IDs/names or the latest matching generated assets, create one new top track per asset, or place sequentially on one compatible track. Defaults to previewOnly; applying is undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          assets: {
            type: 'array',
            description: 'Optional explicit asset placement entries. Each entry can include assetId, assetName, trackName, durationSeconds, labelColor, and transform.',
            items: {
              type: 'object',
              properties: {
                assetId: { type: 'string' },
                assetName: { type: 'string' },
                trackName: { type: 'string' },
                durationSeconds: { type: 'number' },
                labelColor: { type: 'string' },
                transform: { type: 'object' },
              },
            },
          },
          assetIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Explicit asset IDs to place, in order.',
          },
          assetNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'Explicit asset names or partial names to place, in order.',
          },
          latestCount: {
            type: 'integer',
            description: 'When explicit assets are omitted, place the latest N matching placeable assets. Defaults to 6, max 24.',
          },
          count: {
            type: 'integer',
            description: 'Alias for latestCount.',
          },
          type: {
            type: 'string',
            enum: ['video', 'image', 'audio'],
            description: 'Optional asset type filter for latest matching assets. Use video for generated image-to-video results.',
          },
          assetType: {
            type: 'string',
            enum: ['video', 'image', 'audio'],
            description: 'Alias for type.',
          },
          workflowId: {
            type: 'string',
            description: 'Optional workflow id filter for latest assets, for example ltx23-i2v or wan22-i2v.',
          },
          workflowIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional workflow id filters for latest assets.',
          },
          status: {
            type: 'string',
            description: 'Optional asset status filter. Defaults to completed/imported style statuses.',
          },
          trackStrategy: {
            type: 'string',
            enum: ['newTracks', 'singleTrack'],
            description: 'newTracks creates one compatible track per asset, stacked as review lanes. singleTrack places all assets on one compatible track.',
          },
          layout: {
            type: 'string',
            enum: ['stacked', 'sequential'],
            description: 'stacked aligns assets at the same start time. sequential places them one after another. Defaults to stacked for newTracks and sequential for singleTrack.',
          },
          trackId: {
            type: 'string',
            description: 'Optional target track ID for singleTrack placement.',
          },
          trackName: {
            type: 'string',
            description: 'Optional new single-track name when trackStrategy=singleTrack and a track must be created.',
          },
          trackNamePrefix: {
            type: 'string',
            description: 'Prefix for new review lane names. Defaults to MCP Review.',
          },
          trackNameTemplate: {
            type: 'string',
            description: 'Template for new track names. Supports {index}, {total}, {asset}, and {workflow}.',
          },
          startSeconds: {
            type: 'number',
            description: 'Absolute timeline start time in seconds. Defaults to the playhead.',
          },
          startTime: {
            type: 'number',
            description: 'Alias for startSeconds.',
          },
          at: {
            type: 'string',
            enum: ['playhead', 'selected_clip_start', 'selected_clip_end', 'timeline_end', 'track_end'],
            description: 'Placement shortcut when startSeconds is omitted.',
          },
          durationSeconds: {
            type: 'number',
            description: 'Optional duration for every placed asset. Defaults to source duration for video/audio or 5s for images.',
          },
          spacingSeconds: {
            type: 'number',
            description: 'Gap between assets for sequential layout. Defaults to 0.',
          },
          labelColor: {
            type: 'string',
            description: 'Optional clip label color applied to every created clip, as #RRGGBB.',
          },
          labelColors: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional per-clip label colors, as #RRGGBB.',
          },
          transform: {
            type: 'object',
            description: 'Optional initial transform applied to every placed clip.',
          },
          includeAudio: {
            type: 'boolean',
            description: 'For video assets with embedded audio, also create linked audio clips. Defaults to true for sequential layouts; set true explicitly for stacked review lanes.',
          },
          includeEmbeddedAudio: {
            type: 'boolean',
            description: 'Alias for includeAudio.',
          },
          resolveOverlaps: {
            type: 'boolean',
            description: 'When true, use normal timeline overwrite behavior on target tracks. Defaults to true.',
          },
          selectAfterAdd: {
            type: 'boolean',
            description: 'When true, select all newly created clips. Defaults to true.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the full placement plan without changing the timeline. Defaults to true.',
          },
        },
      },
    },
    {
      name: 'duplicate_clip',
      description: 'Duplicate an existing timeline clip onto the same or another compatible track, preserving clip style, transform, effects, and keyframes. Useful for layered text/title effects. Undoable in ComfyStudio; use previewOnly first.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: {
            type: 'string',
            description: 'Existing clip ID from get_timeline.',
          },
          trackId: {
            type: 'string',
            description: 'Optional target track ID. Defaults to the source clip track. Use a new/top video track for layered title effects.',
          },
          startSeconds: {
            type: 'number',
            description: 'Optional duplicate start time in seconds. Defaults to just after the source clip.',
          },
          startTime: {
            type: 'number',
            description: 'Alias for startSeconds.',
          },
          name: {
            type: 'string',
            description: 'Optional replacement clip name. Does not change text contents.',
          },
          preserveLinkGroup: {
            type: 'boolean',
            description: 'When true, keep the original linkGroupId. Defaults to false so duplicates are independent.',
          },
          preserveSyncLock: {
            type: 'boolean',
            description: 'When true, keep sync-lock metadata. Defaults to false so duplicates can be moved independently.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the duplicate plan without changing the timeline.',
          },
        },
        required: ['clipId'],
      },
    },
    {
      name: 'add_text_clip',
      description: 'Create a ComfyStudio text clip on a video track, optionally with typography, transform, timing, preset animation, or explicit transform/text-color keyframes. Undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text content to place on the timeline.' },
          trackId: { type: 'string', description: 'Optional target video track ID. Defaults to the first unlocked video track.' },
          startSeconds: { type: 'number', description: 'Timeline start time in seconds. Defaults to current playhead.' },
          durationSeconds: { type: 'number', description: 'Clip duration in seconds. Defaults to 5.' },
          enabled: { type: 'boolean', description: 'Whether the new text clip is enabled. Defaults to true.' },
          style: {
            type: 'object',
            description: 'Optional text style fields such as fontFamily, fontSize, fontWeight, textColor, backgroundColor, strokeColor, strokeWidth, shadow, textAlign, and verticalAlign.',
            properties: {
              fontFamily: { type: 'string' },
              fontSize: { type: 'number' },
              fontWeight: { type: 'string' },
              fontStyle: { type: 'string' },
              textColor: { type: 'string', description: 'Hex #RRGGBB.' },
              backgroundColor: { type: 'string', description: 'Hex #RRGGBB or transparent.' },
              backgroundOpacity: { type: 'number' },
              textAlign: { type: 'string', enum: ['left', 'center', 'right'] },
              verticalAlign: { type: 'string', enum: ['top', 'center', 'bottom'] },
              strokeColor: { type: 'string' },
              strokeWidth: { type: 'number' },
              shadow: { type: 'boolean' },
            },
          },
          transform: {
            type: 'object',
            description: 'Optional absolute transform values. positionX/positionY/positionZ are pixels relative to center; scale is percent; rotation/rotationX/rotationY are degrees; perspective is pixels; blur is pixels; motionBlurEnabled toggles layer motion blur; motionBlurMode is auto/velocity/sampled; motionBlurSamples is 2-48; motionBlurShutter is 1-360 degrees; crop fields are percentages from 0 to 100.',
            properties: {
              positionX: { type: 'number' },
              positionY: { type: 'number' },
              positionZ: { type: 'number', description: '2.5D depth offset in pixels. Positive moves toward camera.' },
              scaleX: { type: 'number' },
              scaleY: { type: 'number' },
              scaleLinked: { type: 'boolean' },
              rotation: { type: 'number' },
              rotationX: { type: 'number', description: '2.5D X-axis rotation in degrees, -89 to 89.' },
              rotationY: { type: 'number', description: '2.5D Y-axis rotation in degrees, -89 to 89.' },
              perspective: { type: 'number', description: '2.5D perspective distance in pixels, 100 to 10000.' },
              opacity: { type: 'number' },
              blur: { type: 'number', description: 'Blur amount in pixels, 0 to 50.' },
              motionBlurEnabled: { type: 'boolean', description: 'Turn transform/layer motion blur on or off for this clip.' },
              motionBlurMode: { type: 'string', enum: ['auto', 'velocity', 'sampled'], description: 'Motion blur renderer mode. auto uses GPU velocity blur for X/Y motion and sampled fallback; velocity uses only GPU directional blur; sampled uses subframe samples.' },
              motionBlurSamples: { type: 'number', description: 'Motion blur sample count from 2 to 48. Higher values are smoother but heavier.' },
              motionBlurShutter: { type: 'number', description: 'Motion blur shutter angle from 1 to 360 degrees.' },
              blendMode: { type: 'string', enum: ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'], description: 'Layer compositing blend mode. Use multiply to darken/composite colors with layers below.' },
              cropTop: { type: 'number', description: 'Crop from the top as a percent, 0 to 100.' },
              cropBottom: { type: 'number', description: 'Crop from the bottom as a percent, 0 to 100.' },
              cropLeft: { type: 'number', description: 'Crop from the left as a percent, 0 to 100.' },
              cropRight: { type: 'number', description: 'Crop from the right as a percent, 0 to 100.' },
            },
          },
          crop: {
            type: 'object',
            description: 'Alias for static crop transform fields. Useful for split-title effects. Values are percentages from 0 to 100.',
            properties: {
              cropTop: { type: 'number' },
              cropBottom: { type: 'number' },
              cropLeft: { type: 'number' },
              cropRight: { type: 'number' },
            },
          },
          animationPreset: { type: 'string', enum: ['fade', 'slideUp', 'slideDown', 'slideLeft', 'pop', 'spinIn', 'none'], description: 'Optional existing ComfyStudio text animation preset.' },
          animationMode: { type: 'string', enum: ['in', 'out', 'inOut'], description: 'Preset animation direction. Defaults to inOut.' },
          keyframes: {
            type: 'array',
            description: 'Optional explicit transform and textColor keyframes for text motion, crop reveals, and color changes. Use #RRGGBB values for textColor. Easing supports linear/easeIn/easeOut/easeInOut/hold or cubicBezier(x1,y1,x2,y2).',
            items: {
              type: 'object',
              properties: {
                property: { type: 'string', enum: ['opacity', 'positionX', 'positionY', 'positionZ', 'scaleX', 'scaleY', 'rotation', 'rotationX', 'rotationY', 'perspective', 'blur', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight', 'textColor'] },
                timeSeconds: { type: 'number', description: 'Clip-relative keyframe time in seconds.' },
                value: { oneOf: [{ type: 'number' }, { type: 'string' }], description: 'Number for transform fields, or #RRGGBB for textColor.' },
                easing: { type: 'string', description: 'Easing name. Defaults to easeInOut. Supports cubicBezier(x1,y1,x2,y2), for example cubicBezier(0.55,0,1,0.45).' },
              },
              required: ['property', 'timeSeconds', 'value'],
            },
          },
          replaceKeyframes: { type: 'boolean', description: 'When true, replace existing keyframes for properties included in keyframes.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the creation plan without changing the timeline.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'update_text_clip',
      description: 'Update an existing text clip by explicit clipId: text, typography, transform, timing, preset animation, or explicit transform/text-color keyframes. Use previewOnly first for safety.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Existing text clip ID from get_timeline.' },
          text: { type: 'string', description: 'Replacement text content.' },
          trackId: { type: 'string', description: 'Optional new target video track ID.' },
          startSeconds: { type: 'number', description: 'Optional new timeline start time in seconds.' },
          durationSeconds: { type: 'number', description: 'Optional new clip duration in seconds.' },
          style: {
            type: 'object',
            description: 'Text style updates such as fontFamily, fontSize, textColor, backgroundColor, strokeWidth, shadow, textAlign, verticalAlign.',
          },
          transform: {
            type: 'object',
            description: 'Absolute transform values. positionX/positionY/positionZ are pixels relative to center; scale is percent; rotation/rotationX/rotationY are degrees; perspective is pixels; blur is pixels; motionBlurEnabled toggles layer motion blur; motionBlurMode is auto/velocity/sampled; motionBlurSamples is 2-48; motionBlurShutter is 1-360 degrees; crop fields are percentages from 0 to 100.',
            properties: {
              positionX: { type: 'number' },
              positionY: { type: 'number' },
              positionZ: { type: 'number', description: '2.5D depth offset in pixels. Positive moves toward camera.' },
              scaleX: { type: 'number' },
              scaleY: { type: 'number' },
              scaleLinked: { type: 'boolean' },
              rotation: { type: 'number' },
              rotationX: { type: 'number', description: '2.5D X-axis rotation in degrees, -89 to 89.' },
              rotationY: { type: 'number', description: '2.5D Y-axis rotation in degrees, -89 to 89.' },
              perspective: { type: 'number', description: '2.5D perspective distance in pixels, 100 to 10000.' },
              opacity: { type: 'number' },
              blur: { type: 'number', description: 'Blur amount in pixels, 0 to 50.' },
              motionBlurEnabled: { type: 'boolean', description: 'Turn transform/layer motion blur on or off for this clip.' },
              motionBlurMode: { type: 'string', enum: ['auto', 'velocity', 'sampled'], description: 'Motion blur renderer mode. auto uses GPU velocity blur for X/Y motion and sampled fallback; velocity uses only GPU directional blur; sampled uses subframe samples.' },
              motionBlurSamples: { type: 'number', description: 'Motion blur sample count from 2 to 48. Higher values are smoother but heavier.' },
              motionBlurShutter: { type: 'number', description: 'Motion blur shutter angle from 1 to 360 degrees.' },
              blendMode: { type: 'string', enum: ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'], description: 'Layer compositing blend mode. Use multiply to darken/composite colors with layers below.' },
              cropTop: { type: 'number', description: 'Crop from the top as a percent, 0 to 100.' },
              cropBottom: { type: 'number', description: 'Crop from the bottom as a percent, 0 to 100.' },
              cropLeft: { type: 'number', description: 'Crop from the left as a percent, 0 to 100.' },
              cropRight: { type: 'number', description: 'Crop from the right as a percent, 0 to 100.' },
            },
          },
          crop: {
            type: 'object',
            description: 'Alias for static crop transform fields. Useful for split-title effects. Values are percentages from 0 to 100.',
            properties: {
              cropTop: { type: 'number' },
              cropBottom: { type: 'number' },
              cropLeft: { type: 'number' },
              cropRight: { type: 'number' },
            },
          },
          transformDelta: {
            type: 'object',
            description: 'Relative transform changes, for natural requests like move north by 50 pixels, rotate by 10 degrees, or crop another 10 percent.',
            properties: {
              positionX: { type: 'number' },
              positionY: { type: 'number' },
              positionZ: { type: 'number' },
              rotation: { type: 'number' },
              rotationX: { type: 'number' },
              rotationY: { type: 'number' },
              perspective: { type: 'number' },
              blur: { type: 'number' },
              cropTop: { type: 'number' },
              cropBottom: { type: 'number' },
              cropLeft: { type: 'number' },
              cropRight: { type: 'number' },
            },
          },
          animationPreset: { type: 'string', enum: ['fade', 'slideUp', 'slideDown', 'slideLeft', 'pop', 'spinIn', 'none'], description: 'Apply an existing text animation preset, or none to clear preset animation.' },
          animationMode: { type: 'string', enum: ['in', 'out', 'inOut'], description: 'Preset animation direction. Defaults to inOut.' },
          clearAnimationPreset: { type: 'boolean', description: 'Clear preset title animation keyframes.' },
          clearKeyframes: {
            oneOf: [
              { type: 'boolean' },
              { type: 'string', enum: ['all'] },
              { type: 'array', items: { type: 'string', enum: ['opacity', 'positionX', 'positionY', 'positionZ', 'scaleX', 'scaleY', 'rotation', 'rotationX', 'rotationY', 'perspective', 'blur', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight', 'textColor'] } },
            ],
            description: 'Clear all or selected text transform/textColor keyframes before applying new ones.',
          },
          keyframes: {
            type: 'array',
            description: 'Explicit transform and textColor keyframes for text motion, crop reveals, and color changes. Easing supports linear/easeIn/easeOut/easeInOut/hold or cubicBezier(x1,y1,x2,y2).',
            items: {
              type: 'object',
              properties: {
                property: { type: 'string', enum: ['opacity', 'positionX', 'positionY', 'positionZ', 'scaleX', 'scaleY', 'rotation', 'rotationX', 'rotationY', 'perspective', 'blur', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight', 'textColor'] },
                timeSeconds: { type: 'number', description: 'Clip-relative keyframe time in seconds.' },
                value: { oneOf: [{ type: 'number' }, { type: 'string' }], description: 'Number for transform fields, or #RRGGBB for textColor.' },
                easing: { type: 'string', description: 'Easing name. Defaults to easeInOut. Supports cubicBezier(x1,y1,x2,y2), for example cubicBezier(0.55,0,1,0.45).' },
              },
              required: ['property', 'timeSeconds', 'value'],
            },
          },
          replaceKeyframes: { type: 'boolean', description: 'When true, replace existing keyframes for properties included in keyframes.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the planned update without changing the timeline.' },
        },
        required: ['clipId'],
      },
    },
    {
      name: 'add_shape_clip',
      description: 'Create a ComfyStudio shape clip on a video track for motion graphics: rectangle, rounded rectangle, ellipse, polygon, or line. Use polygon with sides=3 for triangles, 6 for hexagons, 8 for octagons, etc. Supports solid, linear-gradient, and radial-gradient fills, stroke styling, transform, crop, blur, 2.5D rotation, and explicit visual keyframes including width, height, fillOpacity, gradient angle/center/radius, strokeWidth, strokeOpacity, cornerRadius, and polygon sides. Undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          shapeType: { type: 'string', enum: ['rectangle', 'roundedRectangle', 'ellipse', 'polygon', 'line'], description: 'Shape kind to create. Defaults to rectangle.' },
          name: { type: 'string', description: 'Optional clip name.' },
          trackId: { type: 'string', description: 'Optional target video track ID. Defaults to the first unlocked video track.' },
          startSeconds: { type: 'number', description: 'Timeline start time in seconds. Defaults to current playhead.' },
          durationSeconds: { type: 'number', description: 'Clip duration in seconds. Defaults to 5.' },
          width: { type: 'number', description: 'Shape width in pixels.' },
          height: { type: 'number', description: 'Shape height in pixels.' },
          sizeLinked: { type: 'boolean', description: 'When true, width/height edits should preserve the current aspect ratio. Defaults to true.' },
          fillType: { type: 'string', enum: ['solid', 'linearGradient', 'radialGradient'], description: 'Fill mode. Use linearGradient or radialGradient for gradient backgrounds and graphic accents.' },
          gradientType: { type: 'string', enum: ['solid', 'linearGradient', 'radialGradient', 'linear', 'radial'], description: 'Alias for fillType.' },
          fillColor: { type: 'string', description: 'Fill color as #RRGGBB.' },
          fillColorB: { type: 'string', description: 'Second gradient color as #RRGGBB. Used when fillType is linearGradient or radialGradient.' },
          gradientColor: { type: 'string', description: 'Alias for fillColorB.' },
          fillOpacity: { type: 'number', description: 'Fill opacity from 0 to 100.' },
          gradientAngle: { type: 'number', description: 'Linear gradient angle in degrees. 0 is left-to-right, 90 is top-to-bottom.' },
          gradientCenterX: { type: 'number', description: 'Radial gradient center X as a percent of shape width.' },
          gradientCenterY: { type: 'number', description: 'Radial gradient center Y as a percent of shape height.' },
          gradientRadius: { type: 'number', description: 'Radial gradient radius as a percent of the larger shape dimension.' },
          strokeColor: { type: 'string', description: 'Stroke color as #RRGGBB.' },
          strokeOpacity: { type: 'number', description: 'Stroke opacity from 0 to 100.' },
          strokeWidth: { type: 'number', description: 'Stroke width in pixels.' },
          cornerRadius: { type: 'number', description: 'Corner radius in pixels for roundedRectangle.' },
          sides: { type: 'number', description: 'Polygon side count from 3 to 64. Only used when shapeType is polygon.' },
          polygonSides: { type: 'number', description: 'Alias for sides.' },
          style: {
            type: 'object',
            description: 'Optional shape style object. Same fields as top-level shape fields.',
          },
          shapeProperties: {
            type: 'object',
            description: 'Optional shapeProperties object. Same fields as top-level shape fields.',
          },
          transform: {
            type: 'object',
            description: 'Optional absolute transform values. positionX/positionY/positionZ are pixels relative to center; scale is percent; rotation/rotationX/rotationY are degrees; perspective is pixels; blur is pixels; motionBlurEnabled toggles layer motion blur; motionBlurMode is auto/velocity/sampled; motionBlurSamples is 2-48; motionBlurShutter is 1-360 degrees; crop fields are percentages from 0 to 100.',
            properties: {
              positionX: { type: 'number' },
              positionY: { type: 'number' },
              positionZ: { type: 'number' },
              scaleX: { type: 'number' },
              scaleY: { type: 'number' },
              scaleLinked: { type: 'boolean' },
              rotation: { type: 'number' },
              rotationX: { type: 'number' },
              rotationY: { type: 'number' },
              perspective: { type: 'number' },
              opacity: { type: 'number' },
              blur: { type: 'number' },
              motionBlurEnabled: { type: 'boolean', description: 'Turn transform/layer motion blur on or off for this clip.' },
              motionBlurMode: { type: 'string', enum: ['auto', 'velocity', 'sampled'], description: 'Motion blur renderer mode. auto uses GPU velocity blur for X/Y motion and sampled fallback; velocity uses only GPU directional blur; sampled uses subframe samples.' },
              motionBlurSamples: { type: 'number', description: 'Motion blur sample count from 2 to 48. Higher values are smoother but heavier.' },
              motionBlurShutter: { type: 'number', description: 'Motion blur shutter angle from 1 to 360 degrees.' },
              blendMode: { type: 'string', enum: ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'], description: 'Layer compositing blend mode. Use multiply to darken/composite colors with layers below.' },
              cropTop: { type: 'number' },
              cropBottom: { type: 'number' },
              cropLeft: { type: 'number' },
              cropRight: { type: 'number' },
            },
          },
          crop: {
            type: 'object',
            description: 'Alias for static crop transform fields. Values are percentages from 0 to 100.',
          },
          keyframes: {
            type: 'array',
            description: 'Optional explicit visual keyframes for shape motion, fades, crop reveals, blur, 2.5D motion, size, fill/stroke opacity, gradient angle/center/radius, stroke width, rounded corners, and polygon sides. Easing supports linear/easeIn/easeOut/easeInOut/hold or cubicBezier(x1,y1,x2,y2).',
            items: {
              type: 'object',
              properties: {
                property: { type: 'string', enum: MCP_CLIP_KEYFRAME_PROPERTIES },
                timeSeconds: { type: 'number', description: 'Clip-relative keyframe time in seconds.' },
                value: { type: 'number' },
                easing: { type: 'string' },
              },
              required: ['property', 'timeSeconds', 'value'],
            },
          },
          replaceKeyframes: { type: 'boolean', description: 'When true, replace existing keyframes for properties included in keyframes.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the creation plan without changing the timeline.' },
        },
      },
    },
    {
      name: 'update_shape_clip',
      description: 'Update an existing shape clip by explicit clipId: shape type, size, solid/gradient fill style, stroke style, transform, timing, or visual keyframes. Shape keyframes can animate width, height, fillOpacity, gradient angle/center/radius, strokeWidth, strokeOpacity, cornerRadius, and polygon sides. Use previewOnly first for safety.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Existing shape clip ID from get_timeline.' },
          shapeType: { type: 'string', enum: ['rectangle', 'roundedRectangle', 'ellipse', 'polygon', 'line'] },
          name: { type: 'string', description: 'Optional replacement clip name.' },
          trackId: { type: 'string', description: 'Optional new target video track ID.' },
          startSeconds: { type: 'number', description: 'Optional new timeline start time in seconds.' },
          durationSeconds: { type: 'number', description: 'Optional new clip duration in seconds.' },
          width: { type: 'number' },
          height: { type: 'number' },
          sizeLinked: { type: 'boolean', description: 'When true, width/height edits should preserve the current aspect ratio.' },
          fillType: { type: 'string', enum: ['solid', 'linearGradient', 'radialGradient'], description: 'Fill mode. Use linearGradient or radialGradient for gradient backgrounds and graphic accents.' },
          gradientType: { type: 'string', enum: ['solid', 'linearGradient', 'radialGradient', 'linear', 'radial'], description: 'Alias for fillType.' },
          fillColor: { type: 'string', description: 'Fill color as #RRGGBB.' },
          fillColorB: { type: 'string', description: 'Second gradient color as #RRGGBB. Used when fillType is linearGradient or radialGradient.' },
          gradientColor: { type: 'string', description: 'Alias for fillColorB.' },
          fillOpacity: { type: 'number', description: 'Fill opacity from 0 to 100.' },
          gradientAngle: { type: 'number', description: 'Linear gradient angle in degrees. 0 is left-to-right, 90 is top-to-bottom.' },
          gradientCenterX: { type: 'number', description: 'Radial gradient center X as a percent of shape width.' },
          gradientCenterY: { type: 'number', description: 'Radial gradient center Y as a percent of shape height.' },
          gradientRadius: { type: 'number', description: 'Radial gradient radius as a percent of the larger shape dimension.' },
          strokeColor: { type: 'string', description: 'Stroke color as #RRGGBB.' },
          strokeOpacity: { type: 'number', description: 'Stroke opacity from 0 to 100.' },
          strokeWidth: { type: 'number' },
          cornerRadius: { type: 'number' },
          sides: { type: 'number', description: 'Polygon side count from 3 to 64. Only used when shapeType is polygon.' },
          polygonSides: { type: 'number', description: 'Alias for sides.' },
          style: {
            type: 'object',
            description: 'Optional shape style updates. Same fields as top-level shape fields.',
          },
          shapeProperties: {
            type: 'object',
            description: 'Optional shapeProperties updates. Same fields as top-level shape fields.',
          },
          transform: {
            type: 'object',
            description: 'Absolute transform values. positionX/positionY/positionZ are pixels relative to center; scale is percent; rotation/rotationX/rotationY are degrees; perspective is pixels; blur is pixels; motionBlurEnabled toggles layer motion blur; motionBlurMode is auto/velocity/sampled; motionBlurSamples is 2-48; motionBlurShutter is 1-360 degrees; crop fields are percentages from 0 to 100.',
            properties: {
              positionX: { type: 'number' },
              positionY: { type: 'number' },
              positionZ: { type: 'number' },
              scaleX: { type: 'number' },
              scaleY: { type: 'number' },
              scaleLinked: { type: 'boolean' },
              rotation: { type: 'number' },
              rotationX: { type: 'number' },
              rotationY: { type: 'number' },
              perspective: { type: 'number' },
              opacity: { type: 'number' },
              blur: { type: 'number' },
              motionBlurEnabled: { type: 'boolean', description: 'Turn transform/layer motion blur on or off for this clip.' },
              motionBlurMode: { type: 'string', enum: ['auto', 'velocity', 'sampled'], description: 'Motion blur renderer mode. auto uses GPU velocity blur for X/Y motion and sampled fallback; velocity uses only GPU directional blur; sampled uses subframe samples.' },
              motionBlurSamples: { type: 'number', description: 'Motion blur sample count from 2 to 48. Higher values are smoother but heavier.' },
              motionBlurShutter: { type: 'number', description: 'Motion blur shutter angle from 1 to 360 degrees.' },
              blendMode: { type: 'string', enum: ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'], description: 'Layer compositing blend mode. Use multiply to darken/composite colors with layers below.' },
              cropTop: { type: 'number' },
              cropBottom: { type: 'number' },
              cropLeft: { type: 'number' },
              cropRight: { type: 'number' },
            },
          },
          crop: {
            type: 'object',
            description: 'Alias for static crop transform fields. Values are percentages from 0 to 100.',
          },
          transformDelta: {
            type: 'object',
            description: 'Relative transform changes, for natural requests like move north by 50 pixels, rotate by 10 degrees, or crop another 10 percent.',
          },
          clearKeyframes: {
            oneOf: [
              { type: 'boolean' },
              { type: 'string', enum: ['all'] },
              { type: 'array', items: { type: 'string', enum: MCP_CLIP_KEYFRAME_PROPERTIES } },
            ],
            description: 'Clear all or selected visual keyframes before applying new ones.',
          },
          keyframes: {
            type: 'array',
            description: 'Explicit visual keyframes for shape motion, fades, crop reveals, blur, 2.5D motion, size, fill/stroke opacity, gradient angle/center/radius, stroke width, rounded corners, and polygon sides. Easing supports linear/easeIn/easeOut/easeInOut/hold or cubicBezier(x1,y1,x2,y2).',
            items: {
              type: 'object',
              properties: {
                property: { type: 'string', enum: MCP_CLIP_KEYFRAME_PROPERTIES },
                timeSeconds: { type: 'number', description: 'Clip-relative keyframe time in seconds.' },
                value: { type: 'number' },
                easing: { type: 'string' },
              },
              required: ['property', 'timeSeconds', 'value'],
            },
          },
          replaceKeyframes: { type: 'boolean', description: 'When true, replace existing keyframes for properties included in keyframes.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the planned update without changing the timeline.' },
        },
        required: ['clipId'],
      },
    },
    {
      name: 'set_clip_keyframes',
      description: 'Preview or set explicit keyframes on an existing visual timeline clip. Use this for video/image/text/shape fades, dips to black, moves, scale/rotation, 2.5D rotation, blur, crop reveals, color-adjustment animation, and shape size/style animation. Defaults to previewOnly; applying is undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: {
            type: 'string',
            description: 'Existing visual clip ID from get_timeline or inspect_visible_shots. Supports video, image, text, shape, adjustment, caption, and captions clips.',
          },
          keyframes: {
            type: 'array',
            description: 'Clip-relative keyframes. timeSeconds is relative to the start of the clip. Values are clamped to the supported range for each property.',
            items: {
              type: 'object',
              properties: {
                property: {
                  type: 'string',
                  enum: MCP_CLIP_KEYFRAME_PROPERTIES,
                  description: 'Visual property to animate. rotation is Z rotation; rotationX/rotationY are 2.5D tilts. width/height/fillOpacity/gradientAngle/gradientCenterX/gradientCenterY/gradientRadius/strokeWidth/strokeOpacity/cornerRadius/sides only apply to shape clips.',
                },
                timeSeconds: {
                  type: 'number',
                  description: 'Clip-relative keyframe time in seconds. Times past the clip duration are clamped.',
                },
                value: {
                  type: 'number',
                  description: 'Numeric keyframe value. Opacity/crop use 0-100, scale uses percent, rotation uses degrees, blur/shape dimensions/stroke/corners use pixels, and polygon sides uses a whole number.',
                },
                easing: {
                  type: 'string',
                  description: 'Easing name. Defaults to easeInOut. Supports linear, easeIn, easeOut, easeInOut, hold, or cubicBezier(x1,y1,x2,y2).',
                },
              },
              required: ['property', 'timeSeconds', 'value'],
            },
          },
          replaceKeyframes: {
            type: 'boolean',
            description: 'When true, replace existing keyframes for the properties included in keyframes.',
          },
          clearKeyframes: {
            oneOf: [
              { type: 'boolean' },
              { type: 'string', enum: ['all'] },
              { type: 'array', items: { type: 'string', enum: MCP_CLIP_KEYFRAME_PROPERTIES } },
            ],
            description: 'Clear all or selected supported keyframe properties before applying new ones.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the keyframe plan without changing the timeline. Defaults to true.',
          },
        },
        required: ['clipId'],
      },
    },
    {
      name: 'export_timeline',
      description: 'Start a ComfyStudio timeline export using the existing hidden export worker. Defaults to MP4 H.264 1080p HD with AAC audio, written to the project renders folder. Use check_export_readiness first for final delivery.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: ['h264_hd', 'h264_1080p', 'h264_720p', 'h264_square_1080', 'h264_square_720', 'h264_1x1_1080', 'h264_1x1_720', 'h264_vertical_1080', 'h264_vertical_720', 'h264_9x16_1080', 'h264_9x16_720', 'h264_project', 'h264_review_proxy'],
            description: 'Delivery target preset. Defaults to h264_hd.',
          },
          filename: {
            type: 'string',
            description: 'Output filename without extension. Defaults to project_timeline_h264_hd.',
          },
          outputPath: {
            type: 'string',
            description: 'Optional absolute output path. If omitted, writes to the project renders folder.',
          },
          format: {
            type: 'string',
            enum: ['mp4'],
            description: 'Container format. Currently MP4 is the supported MCP delivery target.',
          },
          videoCodec: {
            type: 'string',
            enum: ['h264', 'h265'],
            description: 'Video codec. Defaults to h264.',
          },
          resolution: {
            type: 'string',
            enum: ['1080p', '720p', 'square_1080', 'square_720', 'square', '1x1', 'vertical_1080', 'vertical_720', '9x16', 'project', 'custom', 'timeline_half'],
            description: 'Export resolution. Defaults to 1080p for h264_hd. Use square_720/square_1080 for 1:1 exports or vertical_720/vertical_1080 for 9:16 exports.',
          },
          aspectRatio: {
            type: 'string',
            enum: ['16:9', '1:1', '1x1', 'square', '9:16', '9x16', 'vertical'],
            description: 'Optional output aspect ratio hint. Use 1:1/square for square exports or 9:16/vertical for portrait exports.',
          },
          width: {
            type: 'integer',
            description: 'Custom export width. Used with resolution=custom.',
          },
          height: {
            type: 'integer',
            description: 'Custom export height. Used with resolution=custom.',
          },
          fps: {
            type: 'number',
            description: 'Export frame rate. Defaults to the current timeline FPS.',
          },
          range: {
            type: 'string',
            enum: ['full', 'custom'],
            description: 'Export range. Defaults to full timeline.',
          },
          startSeconds: {
            type: 'number',
            description: 'Custom export range start in seconds.',
          },
          endSeconds: {
            type: 'number',
            description: 'Custom export range end in seconds.',
          },
          includeAudio: {
            type: 'boolean',
            description: 'Include timeline audio. Defaults to true.',
          },
          deliveryFraming: {
            type: 'string',
            enum: ['fit', 'fill', 'center_crop'],
            description: 'How to adapt timeline framing to a different aspect ratio. fit preserves the full frame with letterbox/pillarbox. fill/center_crop fills the output by cropping from center. Square MCP targets default to fill.',
          },
          useHardwareEncoder: {
            type: 'boolean',
            description: 'Request NVENC hardware encoding. Defaults to false.',
          },
          useProxyMedia: {
            type: 'boolean',
            description: 'Use ready proxy media where available. Defaults to false for delivery quality.',
          },
          crf: {
            type: 'number',
            description: 'CRF quality value. Defaults to 18 for H.264 delivery.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the export plan without starting the export.',
          },
        },
      },
    },
  ]
}

class ComfyStudioMcpServer {
  constructor({
    port = DEFAULT_MCP_PORT,
    version = '0.1.0',
    performAction = null,
    diagnoseComfyUIConnection = null,
    setComfyUIConnection = null,
    controlComfyLauncher = null,
    getComfyLauncherLogs = null,
    validateComfyUINodes = null,
    listComfyStudioWorkflows = null,
    inspectComfyStudioWorkflow = null,
  } = {}) {
    this.port = port
    this.version = version
    this.performAction = typeof performAction === 'function' ? performAction : null
    this.diagnoseComfyUIConnection = typeof diagnoseComfyUIConnection === 'function' ? diagnoseComfyUIConnection : null
    this.setComfyUIConnection = typeof setComfyUIConnection === 'function' ? setComfyUIConnection : null
    this.controlComfyLauncher = typeof controlComfyLauncher === 'function' ? controlComfyLauncher : null
    this.getComfyLauncherLogs = typeof getComfyLauncherLogs === 'function' ? getComfyLauncherLogs : null
    this.validateComfyUINodes = typeof validateComfyUINodes === 'function' ? validateComfyUINodes : null
    this.listComfyStudioWorkflows = typeof listComfyStudioWorkflows === 'function' ? listComfyStudioWorkflows : null
    this.inspectComfyStudioWorkflow = typeof inspectComfyStudioWorkflow === 'function' ? inspectComfyStudioWorkflow : null
    this.server = null
    this.running = false
    this.error = null
    this.lastSnapshot = null
    this.lastSnapshotAt = null
    this.tools = createToolDefinitions()
  }

  async start() {
    if (this.server) return this.getStatus()

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        this.writeJson(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: error?.message || String(error) },
          id: null,
        })
      })
    })

    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.off('error', reject)
        this.running = true
        this.error = null
        resolve()
      })
    }).catch((error) => {
      this.error = error?.message || String(error)
      this.running = false
      this.server = null
      throw error
    })

    return this.getStatus()
  }

  async stop() {
    const server = this.server
    this.server = null
    this.running = false
    if (!server) return
    await new Promise((resolve) => server.close(resolve))
  }

  updateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false
    this.lastSnapshot = snapshot
    this.lastSnapshotAt = new Date().toISOString()
    return true
  }

  getStatus() {
    return {
      running: this.running,
      port: this.port,
      url: `http://127.0.0.1:${this.port}/mcp`,
      error: this.error,
      toolCount: this.tools.length,
      lastSnapshotAt: this.lastSnapshotAt,
      hasProject: hasSnapshot(this.lastSnapshot),
    }
  }

  async handleRequest(req, res) {
    this.writeCorsHeaders(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`)
    if (url.pathname !== '/mcp' && url.pathname !== '/') {
      this.writeJson(res, 404, { error: 'Not found.' })
      return
    }

    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      return
    }

    if (req.method !== 'POST') {
      this.writeJson(res, 405, { error: 'Method not allowed.' })
      return
    }

    const body = await this.readRequestBody(req)
    let payload
    try {
      payload = body ? JSON.parse(body) : null
    } catch {
      this.writeJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error.' },
        id: null,
      })
      return
    }

    if (Array.isArray(payload)) {
      const responses = (await Promise.all(payload.map((entry) => this.handleJsonRpc(entry)))).filter(Boolean)
      if (responses.length === 0) {
        res.writeHead(202)
        res.end()
        return
      }
      this.writeJson(res, 200, responses)
      return
    }

    const response = await this.handleJsonRpc(payload)
    if (!response) {
      res.writeHead(202)
      res.end()
      return
    }
    this.writeJson(res, 200, response)
  }

  async handleJsonRpc(message) {
    if (!message || typeof message !== 'object') {
      return {
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request.' },
        id: null,
      }
    }

    const id = Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : undefined
    const isNotification = id === undefined || id === null
    const method = String(message.method || '')
    const params = message.params || {}

    if (!method || method.startsWith('notifications/')) return null

    try {
      let result
      switch (method) {
        case 'initialize':
          result = {
            protocolVersion: params.protocolVersion || MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: {
              name: 'comfystudio',
              version: this.version,
            },
            instructions: 'You are connected to ComfyStudio. Use diagnose_comfyui_connection, repair_comfyui_connection, set_comfyui_connection, control_comfyui_launcher, get_comfyui_launcher_logs, validate_comfyui_nodes, list_comfystudio_workflows, and inspect_comfystudio_workflow for local ComfyUI setup/support questions. Use get_ai_review_passes to choose safe review workflows. Use the tools to inspect the open project, timeline, assets, generation status, music-video workflow state, the composed timeline frame at the playhead, sampled visual timeline ranges, and top-visible shot pages for fast-cut edit review. Use create_timeline with previewOnly first when the user wants a new sequence/timeline for an alternate edit, review selects, generated variations, or a fresh AI-built layout. Use create_asset_folder with previewOnly first when a generation batch or AI-built layout should keep its source assets organized in a named/nested asset folder. Use move_assets_to_folder with previewOnly first when assets should be cleaned up or moved into a folder, for example rootOnly + constantsOnly into a Constants folder. Use queue_prompt_generation_batch with previewOnly first when the user wants new images or videos generated from a written brief; show prompts, workflows, counts, seeds, resolution, duration, FPS, and output folder, then apply only after approval. Use prepare_generation_from_timeline_context with previewOnly first when the user wants to turn a timeline frame into a Generate-tab image-to-video or keyframe request; applying it only captures the frame and prefills Generate. Use queue_prepared_generation with previewOnly first and explicit user approval before queueing a staged Generate request. Use queue_timeline_generation_batch with previewOnly first when the user asks for multiple variations or multiple workflows from the same timeline frame; show workflow counts and seeds, then apply only after approval. Use add_asset_to_timeline with previewOnly first when the user wants one generated/imported asset placed back into the edit, or add_assets_to_timeline with previewOnly first when placing multiple results as review lanes or a sequential strip. Use add_solid_color with previewOnly first when the user needs black/color constants or background plates; it can create a bottom video track so solids sit behind the edit. Use add_text_clip, add_shape_clip, update_text_clip, and update_shape_clip with previewOnly first for titles, lower thirds, lines, boxes, circles, frames, graphic accents, and simple motion graphics; use motionBlurEnabled/motionBlurSamples/motionBlurShutter on fast animated layers when requested. Use set_clip_keyframes with previewOnly first for visual clip fades, dips to black, moves, blur, crop reveals, and color/transform/shape style automation. Queue tools use the same path as the ComfyStudio Queue button and may spend credits or start local GPU work depending on the selected workflow. The write actions currently exposed are ComfyUI connection settings, ComfyUI launcher start/stop/restart, asset folder creation, asset folder cleanup/move operations, sequence/timeline creation, clip label coloring, clip enable/disable, timeline marker creation/removal/property updates, text/title/shape clip creation and updates, visual clip keyframes, solid color asset/clip creation, media asset placement, prompt-based generation queueing, preparing/queueing Generate from a timeline frame, and starting timeline delivery exports through ComfyStudio export worker. Timeline/sequence, clip/marker/text/shape/media/keyframe actions are undoable in ComfyStudio; export writes a new render file to disk.',
          }
          break
        case 'ping':
          result = {}
          break
        case 'tools/list':
          result = { tools: this.tools }
          break
        case 'tools/call':
          result = await this.callTool(params?.name, params?.arguments || {})
          break
        case 'resources/list':
          result = { resources: [] }
          break
        default:
          return {
            jsonrpc: '2.0',
            error: { code: -32601, message: `Method not found: ${method}` },
            id: isNotification ? null : id,
          }
      }

      if (isNotification) return null
      return { jsonrpc: '2.0', result, id }
    } catch (error) {
      if (isNotification) return null
      return {
        jsonrpc: '2.0',
        error: { code: -32603, message: error?.message || String(error) },
        id,
      }
    }
  }

  async callTool(name, args = {}) {
    const snapshot = getSnapshotOrEmpty(this.lastSnapshot)
    const toolsAllowedWithoutProject = new Set([
      'get_project',
      'diagnose_comfyui_connection',
      'set_comfyui_connection',
      'repair_comfyui_connection',
      'control_comfyui_launcher',
      'get_comfyui_launcher_logs',
      'validate_comfyui_nodes',
      'list_comfystudio_workflows',
      'inspect_comfystudio_workflow',
    ])
    if (!hasSnapshot(snapshot) && !toolsAllowedWithoutProject.has(name)) {
      return errorResult('No ComfyStudio project is open yet.')
    }

    switch (name) {
      case 'get_project':
        return textResult({
          app: snapshot.app,
          project: snapshot.project,
          currentTimeline: snapshot.currentTimeline ? {
            id: snapshot.currentTimeline.id,
            name: snapshot.currentTimeline.name,
            duration: snapshot.currentTimeline.duration,
            fps: snapshot.currentTimeline.fps,
            width: snapshot.currentTimeline.width,
            height: snapshot.currentTimeline.height,
            trackCount: snapshot.currentTimeline.tracks?.length || 0,
            clipCount: snapshot.currentTimeline.clips?.length || 0,
            transitionCount: snapshot.currentTimeline.transitions?.length || 0,
          } : null,
          timelineCount: snapshot.timelines?.length || 0,
          assetCount: snapshot.assets?.length || 0,
          assetCounts: summarizeAssetCounts(snapshot.assets || []),
          generatedAt: snapshot.generatedAt,
          mcp: this.getStatus(),
        })
      case 'get_timeline': {
        const timeline = snapshot.currentTimeline || null
        if (!timeline) return errorResult('No current timeline is available.')
        const includeClips = args.includeClips !== false
        const includeTransitions = args.includeTransitions === true
        const limit = clampLimit(args.limit, 300, 1000)
        return textResult({
          ...timeline,
          clipCounts: summarizeClipCounts(timeline.clips || []),
          clips: includeClips ? (timeline.clips || []).slice(0, limit) : undefined,
          transitions: includeTransitions ? (timeline.transitions || []) : undefined,
          clipLimitApplied: includeClips && (timeline.clips || []).length > limit,
        })
      }
      case 'get_assets': {
        const type = String(args.type || '').trim().toLowerCase()
        const status = String(args.status || '').trim().toLowerCase()
        const limit = clampLimit(args.limit, 200, 1000)
        let assets = snapshot.assets || []
        if (type) assets = assets.filter((asset) => String(asset?.type || '').toLowerCase() === type)
        if (status) {
          assets = assets.filter((asset) => (
            String(asset?.generationStatus || asset?.status || '').toLowerCase() === status
          ))
        }
        return textResult({
          count: assets.length,
          limitApplied: assets.length > limit,
          assets: assets.slice(0, limit),
        })
      }
      case 'get_ai_review_passes':
        return textResult(buildAiReviewPasses(snapshot))
      case 'diagnose_comfyui_connection':
        return this.runComfyUIConnectionDiagnosis(args)
      case 'set_comfyui_connection':
        return this.setComfyUIConnectionTool(args)
      case 'repair_comfyui_connection':
        return this.repairComfyUIConnection(args)
      case 'control_comfyui_launcher':
        return this.controlComfyUILauncherTool(args)
      case 'get_comfyui_launcher_logs':
        return this.getComfyUILauncherLogsTool(args)
      case 'validate_comfyui_nodes':
        return this.runComfyUINodeValidation(args)
      case 'list_comfystudio_workflows':
        return this.listComfyStudioWorkflowsTool(args)
      case 'inspect_comfystudio_workflow':
        return this.inspectComfyStudioWorkflowTool(args)
      case 'check_export_readiness':
        return textResult(checkExportReadiness(snapshot, args))
      case 'inspect_clip':
        return this.inspectClip(snapshot, args)
      case 'inspect_timeline_frame':
        return this.inspectTimelineFrame(snapshot, args)
      case 'prepare_generation_from_timeline_context':
        return this.prepareGenerationFromTimelineContext(snapshot, args)
      case 'queue_prepared_generation':
        return this.queuePreparedGeneration(snapshot, args)
      case 'queue_timeline_generation_batch':
        return this.queueTimelineGenerationBatch(snapshot, args)
      case 'queue_prompt_generation_batch':
        return this.queuePromptGenerationBatch(snapshot, args)
      case 'inspect_timeline_range':
        return this.inspectTimelineRange(snapshot, args)
      case 'inspect_visible_shots':
        return this.inspectVisibleShots(snapshot, args)
      case 'get_generation_status':
        return textResult(summarizeGenerationAssets(snapshot.assets || []))
      case 'get_music_video_status':
        return textResult(summarizeMusicVideoWorkflow(snapshot))
      case 'analyze_timeline':
        return textResult(analyzeTimeline(snapshot, args))
      case 'analyze_music_video_workflow':
        return textResult(analyzeMusicVideoWorkflow(snapshot, args))
      case 'set_clip_label_color':
        return this.setClipLabelColor(snapshot, args)
      case 'set_clips_enabled':
        return this.setClipsEnabled(snapshot, args)
      case 'add_timeline_markers':
        return this.addTimelineMarkers(snapshot, args)
      case 'remove_timeline_markers':
        return this.removeTimelineMarkers(snapshot, args)
      case 'set_timeline_marker_properties':
        return this.setTimelineMarkerProperties(snapshot, args)
      case 'create_timeline':
        return this.createTimeline(snapshot, args)
      case 'create_asset_folder':
        return this.createAssetFolder(snapshot, args)
      case 'move_assets_to_folder':
        return this.moveAssetsToFolder(snapshot, args)
      case 'add_track':
        return this.addTrack(snapshot, args)
      case 'add_asset_to_timeline':
        return this.addAssetToTimeline(snapshot, args)
      case 'add_solid_color':
        return this.addSolidColor(snapshot, args)
      case 'add_assets_to_timeline':
        return this.addAssetsToTimeline(snapshot, args)
      case 'duplicate_clip':
        return this.duplicateClip(snapshot, args)
      case 'add_text_clip':
        return this.addTextClip(snapshot, args)
      case 'update_text_clip':
        return this.updateTextClip(snapshot, args)
      case 'add_shape_clip':
        return this.addShapeClip(snapshot, args)
      case 'update_shape_clip':
        return this.updateShapeClip(snapshot, args)
      case 'set_clip_keyframes':
        return this.setClipKeyframes(snapshot, args)
      case 'export_timeline':
        return this.exportTimeline(snapshot, args)
      default:
        return errorResult(`Unknown tool: ${name}`)
    }
  }

  async runComfyUIConnectionDiagnosis(args = {}) {
    if (!this.diagnoseComfyUIConnection) {
      return errorResult('ComfyUI connection diagnostics are not available. Restart ComfyStudio and try again.')
    }
    try {
      const result = await this.diagnoseComfyUIConnection(args || {})
      return textResult(result)
    } catch (error) {
      return errorResult(`Could not diagnose ComfyUI connection: ${error?.message || String(error)}`)
    }
  }

  async setComfyUIConnectionTool(args = {}) {
    if (!this.setComfyUIConnection) {
      return errorResult('ComfyUI connection setting is not available. Restart ComfyStudio and try again.')
    }
    const port = normalizeLocalPort(args?.port)
    if (!port) {
      return errorResult('Invalid ComfyUI port. Use a number from 1 to 65535.')
    }
    try {
      const result = await this.setComfyUIConnection({
        port,
        previewOnly: args.previewOnly === true,
      })
      if (result?.success === false) {
        return errorResult(result.error || 'Could not update ComfyUI connection.')
      }
      return textResult({
        action: 'set_comfyui_connection',
        ...result,
      })
    } catch (error) {
      return errorResult(`Could not update ComfyUI connection: ${error?.message || String(error)}`)
    }
  }

  async repairComfyUIConnection(args = {}) {
    if (!this.diagnoseComfyUIConnection || !this.setComfyUIConnection) {
      return errorResult('ComfyUI connection repair is not available. Restart ComfyStudio and try again.')
    }

    const timeoutMs = getNumberArg(args, 'timeoutMs', 4500, 1000, 30000)
    const configured = await this.diagnoseComfyUIConnection({ timeoutMs })
    if (configured?.connection?.ok) {
      return textResult({
        action: 'repair_comfyui_connection',
        previewOnly: args.previewOnly !== false,
        needed: false,
        summary: 'No repair needed. The configured ComfyUI connection is already healthy.',
        configured,
      })
    }

    const configuredPort = normalizeLocalPort(configured?.connection?.port)
    const requestedCandidates = Array.isArray(args.candidatePorts) ? args.candidatePorts : []
    const defaultCandidates = [
      configuredPort,
      8188,
      8189,
      8190,
      8191,
      7860,
    ]
    const candidatePorts = [...new Set([...requestedCandidates, ...defaultCandidates]
      .map(normalizeLocalPort)
      .filter(Boolean))]

    const probes = []
    let reachable = null
    for (const port of candidatePorts) {
      const diagnosis = port === configuredPort
        ? configured
        : await this.diagnoseComfyUIConnection({ port, timeoutMs })
      probes.push({
        port,
        ok: Boolean(diagnosis?.connection?.ok),
        summary: diagnosis?.summary || '',
        nodeClassCount: diagnosis?.api?.objectInfo?.nodeClassCount || 0,
      })
      if (!reachable && diagnosis?.connection?.ok) {
        reachable = diagnosis
      }
    }

    if (!reachable) {
      return textResult({
        action: 'repair_comfyui_connection',
        previewOnly: args.previewOnly !== false,
        needed: true,
        repaired: false,
        summary: 'ComfyStudio is pointed at an unreachable ComfyUI port, and no reachable ComfyUI server was found on the probed local ports.',
        configured,
        probes,
        recommendations: [
          'Start ComfyUI and confirm the local browser URL/port it prints.',
          'Then run repair_comfyui_connection again with that port in candidatePorts, or set the port explicitly with set_comfyui_connection.',
        ],
      })
    }

    const reachablePort = normalizeLocalPort(reachable?.connection?.port)
    const previewOnly = args.previewOnly !== false
    const update = await this.setComfyUIConnection({
      port: reachablePort,
      previewOnly,
    })
    if (update?.success === false) {
      return errorResult(update.error || 'Could not apply ComfyUI connection repair.')
    }

    return textResult({
      action: 'repair_comfyui_connection',
      previewOnly,
      needed: true,
      repaired: !previewOnly,
      summary: previewOnly
        ? `ComfyStudio is pointed at ${configured?.connection?.httpBase}, but ComfyUI is reachable at ${reachable?.connection?.httpBase}. This repair would switch ComfyStudio to port ${reachablePort}.`
        : `ComfyStudio was switched to the reachable ComfyUI port ${reachablePort}.`,
      configured,
      reachable,
      probes,
      proposedChange: {
        from: configured?.connection?.httpBase || null,
        to: reachable?.connection?.httpBase || null,
      },
      update,
      recommendations: previewOnly
        ? [`Ask the user for approval, then call repair_comfyui_connection with previewOnly=false or set_comfyui_connection with port ${reachablePort}.`]
        : ['Re-run diagnose_comfyui_connection to confirm the configured connection is now healthy.'],
    })
  }

  async controlComfyUILauncherTool(args = {}) {
    if (!this.controlComfyLauncher) {
      return errorResult('ComfyUI launcher control is not available. Restart ComfyStudio and try again.')
    }
    const action = String(args?.action || '').trim().toLowerCase()
    if (!['start', 'stop', 'restart'].includes(action)) {
      return errorResult('Launcher action must be start, stop, or restart.')
    }
    try {
      const result = await this.controlComfyLauncher({
        action,
        previewOnly: args.previewOnly !== false,
      })
      if (result?.success === false && result?.blocked !== true) {
        return errorResult(result.error || 'ComfyUI launcher action failed.')
      }
      return textResult(result)
    } catch (error) {
      return errorResult(`Could not run ComfyUI launcher action: ${error?.message || String(error)}`)
    }
  }

  async getComfyUILauncherLogsTool(args = {}) {
    if (!this.getComfyLauncherLogs) {
      return errorResult('ComfyUI launcher logs are not available. Restart ComfyStudio and try again.')
    }
    try {
      const result = await this.getComfyLauncherLogs({
        tailLines: clampLimit(args.tailLines, 200, 2000),
        streams: Array.isArray(args.streams) ? args.streams : [],
        includeIssueSummary: args.includeIssueSummary !== false,
      })
      return textResult(result)
    } catch (error) {
      return errorResult(`Could not read ComfyUI launcher logs: ${error?.message || String(error)}`)
    }
  }

  async runComfyUINodeValidation(args = {}) {
    if (!this.validateComfyUINodes) {
      return errorResult('ComfyUI node validation is not available. Restart ComfyStudio and try again.')
    }
    try {
      const result = await this.validateComfyUINodes(args || {})
      return textResult(result)
    } catch (error) {
      return errorResult(`Could not validate ComfyUI nodes: ${error?.message || String(error)}`)
    }
  }

  async listComfyStudioWorkflowsTool(args = {}) {
    if (!this.listComfyStudioWorkflows) {
      return errorResult('ComfyStudio workflow discovery is not available. Restart ComfyStudio and try again.')
    }
    try {
      const result = await this.listComfyStudioWorkflows({
        runtime: args.runtime,
        category: args.category,
        query: args.query,
        refresh: args.refresh === true,
      })
      if (result?.success === false) return errorResult(result.error || 'Could not list ComfyStudio workflows.')
      return textResult(result)
    } catch (error) {
      return errorResult(`Could not list ComfyStudio workflows: ${error?.message || String(error)}`)
    }
  }

  async inspectComfyStudioWorkflowTool(args = {}) {
    if (!this.inspectComfyStudioWorkflow) {
      return errorResult('ComfyStudio workflow inspection is not available. Restart ComfyStudio and try again.')
    }
    try {
      const result = await this.inspectComfyStudioWorkflow({
        workflowId: args.workflowId,
        workflowFile: args.workflowFile,
        workflowPath: args.workflowPath,
        includeValidation: args.includeValidation !== false,
        includeNodeClasses: args.includeNodeClasses !== false,
        port: args.port,
        timeoutMs: args.timeoutMs,
        refresh: args.refresh === true,
      })
      if (result?.success === false) return errorResult(result.error || 'Could not inspect ComfyStudio workflow.')
      return textResult(result)
    } catch (error) {
      return errorResult(`Could not inspect ComfyStudio workflow: ${error?.message || String(error)}`)
    }
  }

  async prepareGenerationFromTimelineContext(snapshot, args = {}) {
    const plan = resolveGenerateFromTimelinePlan(snapshot, args)
    if (plan.error) return errorResult(plan.error)

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'prepare_generation_from_timeline_context',
        message: 'Generate preparation plan only. No frame was captured and Generate was not opened.',
        plan,
        suggestedApplyCall: {
          tool: 'prepare_generation_from_timeline_context',
          arguments: {
            ...args,
            previewOnly: false,
          },
        },
      })
    }

    if (!this.performAction) {
      return errorResult('MCP Generate preparation bridge is not available. Restart ComfyStudio and try again.')
    }

    const payload = {
      mode: plan.mode,
      workflowId: plan.workflowId,
      category: plan.category,
      timeSeconds: plan.frame.timeSeconds,
      prompt: plan.prompt,
      negativePrompt: plan.negativePrompt,
      openGenerateTab: plan.openGenerateTab,
      ...(plan.generationSettings.durationSeconds !== null ? { durationSeconds: plan.generationSettings.durationSeconds } : {}),
      ...(plan.generationSettings.fps !== null ? { fps: plan.generationSettings.fps } : {}),
      ...(plan.generationSettings.resolution ? { resolution: plan.generationSettings.resolution } : {}),
    }

    const result = await this.performAction({
      action: 'prepare_generation_from_timeline_context',
      payload,
    })

    return textResult({
      success: true,
      action: 'prepare_generation_from_timeline_context',
      message: 'Timeline frame captured and sent to Generate. Review settings in ComfyStudio, then click Generate manually when ready.',
      plan: {
        ...plan,
        previewOnly: false,
      },
      result,
    })
  }

  async queuePreparedGeneration(_snapshot, args = {}) {
    if (!this.performAction) {
      return errorResult('MCP Generate queue bridge is not available. Restart ComfyStudio and try again.')
    }

    const previewOnly = args.previewOnly !== false
    const result = await this.performAction({
      action: 'queue_prepared_generation',
      payload: {
        previewOnly,
        requireTimelineFrame: args.requireTimelineFrame !== false,
        timeoutMs: args.timeoutMs,
      },
    })

    return textResult({
      success: previewOnly ? undefined : true,
      previewOnly,
      action: 'queue_prepared_generation',
      message: previewOnly
        ? 'Prepared Generate state inspected. No generation was queued.'
        : 'Prepared Generate request queued through ComfyStudio.',
      result,
    })
  }

  async queueTimelineGenerationBatch(snapshot, args = {}) {
    const plan = resolveTimelineGenerationBatchPlan(snapshot, args)
    if (plan.error) return errorResult(plan.error)

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'queue_timeline_generation_batch',
        message: `Timeline generation batch plan only. No frame was captured and no generation was queued. Planned ${plan.totalJobs} job${plan.totalJobs === 1 ? '' : 's'}.`,
        plan,
        suggestedApplyCall: {
          tool: 'queue_timeline_generation_batch',
          arguments: buildTimelineBatchApplyArguments(args, plan),
        },
      })
    }

    if (!this.performAction) {
      return errorResult('MCP timeline generation batch bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'queue_timeline_generation_batch',
      payload: {
        ...plan,
        previewOnly: false,
        timeoutMs: args.timeoutMs,
      },
    })

    return textResult({
      success: true,
      previewOnly: false,
      action: 'queue_timeline_generation_batch',
      message: `Queued ${plan.totalJobs} timeline generation job${plan.totalJobs === 1 ? '' : 's'} through ComfyStudio.`,
      plan,
      result,
    })
  }

  async queuePromptGenerationBatch(snapshot, args = {}) {
    const plan = resolvePromptGenerationBatchPlan(snapshot, args)
    if (plan.error) return errorResult(plan.error)

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'queue_prompt_generation_batch',
        message: `Prompt generation batch plan only. No generation was queued. Planned ${plan.totalJobs} job${plan.totalJobs === 1 ? '' : 's'}.`,
        plan,
        suggestedApplyCall: {
          tool: 'queue_prompt_generation_batch',
          arguments: buildPromptBatchApplyArguments(args, plan),
        },
      })
    }

    if (!this.performAction) {
      return errorResult('MCP prompt generation batch bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'queue_prompt_generation_batch',
      payload: {
        ...plan,
        previewOnly: false,
        timeoutMs: args.timeoutMs,
      },
    })

    return textResult({
      success: true,
      previewOnly: false,
      action: 'queue_prompt_generation_batch',
      message: `Queued ${plan.totalJobs} prompt generation job${plan.totalJobs === 1 ? '' : 's'} through ComfyStudio.`,
      plan,
      result,
    })
  }

  async inspectTimelineFrame(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')

    const timing = resolveTimelineFrameTime(timeline, args)
    const frameClips = getTimelineFrameClips(timeline, timing.timeSeconds)
    const includeImage = args.includeImage !== false
    let imageContent = null
    let capture = null
    let warning = ''

    if (includeImage) {
      if (!this.performAction) {
        warning = 'MCP frame capture bridge is not available. Restart ComfyStudio and try again.'
      } else {
        try {
          capture = await this.performAction({
            action: 'inspect_timeline_frame',
            payload: {
              timeSeconds: timing.timeSeconds,
              includeImage: true,
              maxWidth: getNumberArg(args, 'maxWidth', 1280, 16, 3840),
              maxHeight: getNumberArg(args, 'maxHeight', 720, 16, 2160),
              maxImageBytes: getNumberArg(args, 'maxImageBytes', 4 * 1024 * 1024, 1, 12 * 1024 * 1024),
              mimeType: 'image/jpeg',
              quality: 0.86,
            },
          })
          if (capture?.image?.data) {
            imageContent = {
              type: 'image',
              data: capture.image.data,
              mimeType: capture.image.mimeType || 'image/jpeg',
            }
          } else if (capture?.warning) {
            warning = capture.warning
          }
        } catch (error) {
          warning = `Could not capture timeline frame: ${error?.message || String(error)}`
        }
      }
    }

    const metadata = {
      timeline: {
        id: timeline.id,
        name: timeline.name,
        duration: timeline.duration,
        fps: timeline.fps,
        width: timeline.width,
        height: timeline.height,
      },
      requested: {
        timeSeconds: args.timeSeconds ?? null,
        frame: args.frame ?? null,
        usedPlayhead: args.timeSeconds === undefined && args.frame === undefined,
      },
      frame: {
        timeSeconds: timing.timeSeconds,
        frame: timing.frame,
        fps: timing.fps,
        timecode: timing.timecode,
      },
      activeClipCount: frameClips.activeClips.length,
      visualClipCount: frameClips.visualClips.length,
      topVisibleClip: frameClips.topVisibleClip,
      activeClips: frameClips.activeClips,
      visualClipsTopFirst: frameClips.visualClips,
      capture: stripCaptureImageData(capture),
      warning,
      generatedAt: new Date().toISOString(),
    }

    return mixedResult(metadata, imageContent ? [imageContent] : [])
  }

  async inspectTimelineRange(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')

    const range = resolveTimelineRangeSamples(timeline, args)
    const includeImage = args.includeImage !== false
    const returnMode = ['frames', 'both'].includes(String(args.returnMode || '').toLowerCase())
      ? String(args.returnMode).toLowerCase()
      : 'contact_sheet'
    let capture = null
    let warning = ''

    if (includeImage) {
      if (!this.performAction) {
        warning = 'MCP frame capture bridge is not available. Restart ComfyStudio and try again.'
      } else {
        try {
          capture = await this.performAction({
            action: 'inspect_timeline_range',
            payload: {
              samples: range.samples.map((sample) => ({
                index: sample.index,
                timeSeconds: sample.timeSeconds,
                frame: sample.frame,
                timecode: sample.timecode,
                label: sample.label,
              })),
              includeImage: true,
              returnMode,
              columns: getNumberArg(args, 'columns', 3, 1, 4),
              maxWidth: getNumberArg(args, 'maxWidth', 640, 16, 1920),
              maxHeight: getNumberArg(args, 'maxHeight', 360, 16, 1080),
              maxImageBytes: getNumberArg(args, 'maxImageBytes', 6 * 1024 * 1024, 1, 16 * 1024 * 1024),
              mimeType: 'image/jpeg',
              quality: 0.82,
            },
          })
          if (capture?.contactSheetWarning) warning = capture.contactSheetWarning
          if (capture?.warning) warning = capture.warning
        } catch (error) {
          warning = `Could not inspect timeline range: ${error?.message || String(error)}`
        }
      }
    }

    const imageContent = []
    if (capture?.contactSheet?.data) {
      imageContent.push({
        type: 'image',
        data: capture.contactSheet.data,
        mimeType: capture.contactSheet.mimeType || 'image/jpeg',
      })
    }
    if (Array.isArray(capture?.frames)) {
      for (const frame of capture.frames) {
        if (!frame?.data) continue
        imageContent.push({
          type: 'image',
          data: frame.data,
          mimeType: frame.mimeType || 'image/jpeg',
        })
      }
    }

    const metadata = {
      timeline: {
        id: timeline.id,
        name: timeline.name,
        duration: timeline.duration,
        fps: timeline.fps,
        width: timeline.width,
        height: timeline.height,
      },
      requested: {
        startSeconds: args.startSeconds ?? null,
        endSeconds: args.endSeconds ?? null,
        durationSeconds: args.durationSeconds ?? null,
        startFrame: args.startFrame ?? null,
        endFrame: args.endFrame ?? null,
        usedPlayheadStart: args.startSeconds === undefined && args.startFrame === undefined,
        returnMode,
      },
      range,
      capture: stripRangeCaptureImageData(capture),
      warning,
      generatedAt: new Date().toISOString(),
    }

    return mixedResult(metadata, imageContent)
  }

  async inspectVisibleShots(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')

    const visibleShots = resolveVisibleShotSamples(timeline, args)
    const offset = Math.floor(getNumberArg(args, 'offset', 0, 0, Number.MAX_SAFE_INTEGER))
    const limit = clampLimit(args.limit, 30, 120)
    const pageShots = visibleShots.shots.slice(offset, offset + limit)
    const includeImage = args.includeImage !== false
    const returnMode = ['frames', 'both'].includes(String(args.returnMode || '').toLowerCase())
      ? String(args.returnMode).toLowerCase()
      : 'contact_sheet'
    let capture = null
    let warning = ''

    if (pageShots.length === 0) {
      warning = visibleShots.totalShotCount === 0
        ? 'No visible video/image/text shots were found in this range.'
        : 'The requested offset is beyond the visible shot list.'
    } else if (includeImage) {
      if (!this.performAction) {
        warning = 'MCP frame capture bridge is not available. Restart ComfyStudio and try again.'
      } else {
        try {
          capture = await this.performAction({
            action: 'inspect_timeline_range',
            payload: {
              samples: pageShots.map((shot) => ({
                index: shot.index,
                timeSeconds: shot.timeSeconds,
                frame: shot.frame,
                timecode: shot.timecode,
                label: shot.label,
              })),
              includeImage: true,
              returnMode,
              columns: getNumberArg(args, 'columns', 3, 1, 4),
              maxWidth: getNumberArg(args, 'maxWidth', 480, 16, 1920),
              maxHeight: getNumberArg(args, 'maxHeight', 270, 16, 1080),
              maxImageBytes: getNumberArg(args, 'maxImageBytes', 8 * 1024 * 1024, 1, 20 * 1024 * 1024),
              mimeType: 'image/jpeg',
              quality: 0.82,
            },
          })
          if (capture?.contactSheetWarning) warning = capture.contactSheetWarning
          if (capture?.warning) warning = capture.warning
        } catch (error) {
          warning = `Could not inspect visible shots: ${error?.message || String(error)}`
        }
      }
    }

    const imageContent = []
    if (capture?.contactSheet?.data) {
      imageContent.push({
        type: 'image',
        data: capture.contactSheet.data,
        mimeType: capture.contactSheet.mimeType || 'image/jpeg',
      })
    }
    if (Array.isArray(capture?.frames)) {
      for (const frame of capture.frames) {
        if (!frame?.data) continue
        imageContent.push({
          type: 'image',
          data: frame.data,
          mimeType: frame.mimeType || 'image/jpeg',
        })
      }
    }

    const metadata = {
      timeline: {
        id: timeline.id,
        name: timeline.name,
        duration: timeline.duration,
        fps: timeline.fps,
        width: timeline.width,
        height: timeline.height,
      },
      requested: {
        wholeTimeline: args.wholeTimeline === true,
        startSeconds: args.startSeconds ?? null,
        endSeconds: args.endSeconds ?? null,
        durationSeconds: args.durationSeconds ?? null,
        startFrame: args.startFrame ?? null,
        endFrame: args.endFrame ?? null,
        offset,
        limit,
        offsetFrames: visibleShots.offsetFrames,
        usedPlayheadStart: args.wholeTimeline !== true && args.startSeconds === undefined && args.startFrame === undefined,
        returnMode,
      },
      range: {
        startSeconds: visibleShots.startSeconds,
        endSeconds: visibleShots.endSeconds,
        durationSeconds: visibleShots.durationSeconds,
        fps: visibleShots.fps,
      },
      totalShotCount: visibleShots.totalShotCount,
      page: {
        offset,
        limit,
        count: pageShots.length,
        hasMore: offset + pageShots.length < visibleShots.totalShotCount,
        nextOffset: offset + pageShots.length < visibleShots.totalShotCount
          ? offset + pageShots.length
          : null,
      },
      shots: pageShots,
      capture: stripRangeCaptureImageData(capture),
      warning,
      generatedAt: new Date().toISOString(),
    }

    return mixedResult(metadata, imageContent)
  }

  async inspectClip(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')

    const clipId = String(args.clipId || '').trim()
    if (!clipId) return errorResult('Provide a clipId from get_timeline.')

    const clip = (timeline.clips || []).find((candidate) => candidate?.id === clipId)
    if (!clip) return errorResult(`Clip not found: ${clipId}`)

    const track = getTrackById(timeline, clip.trackId)
    const asset = getAssetById(snapshot, clip.assetId)
    const visualSource = getClipVisualSource(snapshot, clip, asset)
    const includeImage = args.includeImage !== false
    const maxImageBytes = clampLimit(args.maxImageBytes, 3 * 1024 * 1024, 10 * 1024 * 1024)
    let imageContent = null
    let imageWarning = ''
    let imageSize = null

    if (includeImage && visualSource.filePath) {
      const imageResult = await readImageContent(visualSource.filePath, maxImageBytes)
      imageContent = imageResult.imageContent
      imageWarning = imageResult.warning || ''
      imageSize = imageResult.size || null
    } else if (includeImage) {
      imageWarning = visualSource.description
    }

    const metadata = {
      clip: {
        ...clipRef(clip),
        enabled: clip.enabled !== false,
        labelColor: clip.labelColor || '',
        trimStart: roundTime(toFiniteNumber(clip.trimStart, 0)),
        trimEnd: clip.trimEnd === null || typeof clip.trimEnd === 'undefined'
          ? null
          : roundTime(toFiniteNumber(clip.trimEnd, 0)),
        sourceDuration: clip.sourceDuration === null || typeof clip.sourceDuration === 'undefined'
          ? null
          : roundTime(toFiniteNumber(clip.sourceDuration, 0)),
        speed: toFiniteNumber(clip.speed, 1),
        transform: clip.transform || null,
        lockMode: clip.lockMode || null,
        syncLock: clip.syncLock || null,
        metadata: clip.metadata || null,
        text: clip.text || '',
      },
      track: track ? {
        id: track.id,
        name: track.name,
        type: track.type,
        visible: track.visible !== false,
        muted: Boolean(track.muted),
        locked: Boolean(track.locked),
      } : null,
      asset: asset ? {
        id: asset.id,
        name: asset.name,
        type: asset.type,
        path: asset.path || '',
        absolutePath: asset.absolutePath || '',
        duration: asset.duration || null,
        width: asset.width || null,
        height: asset.height || null,
        prompt: asset.prompt || '',
        workflowName: asset.workflowName || '',
        model: asset.model || '',
        generationStatus: asset.generationStatus || 'none',
        yolo: asset.yolo || null,
      } : null,
      visual: {
        kind: visualSource.kind,
        path: visualSource.filePath || '',
        description: visualSource.description,
        imageIncluded: Boolean(imageContent),
        imageSize,
        warning: imageWarning,
      },
      generatedAt: new Date().toISOString(),
    }

    return mixedResult(metadata, imageContent ? [imageContent] : [])
  }

  async setClipLabelColor(snapshot, args = {}) {
    if (hasInvalidClipLabelColor(args.color)) {
      return errorResult('Invalid label color. Use a hex color like #f97316, or an empty string to clear labels.')
    }

    const target = resolveClipLabelTargets(snapshot, args)
    if (target.error) return errorResult(target.error)

    const limit = clampLimit(args.limit, 100, 1000)
    const clips = target.clips || []
    if (clips.length === 0) {
      return textResult({
        success: false,
        message: 'No clips matched the requested label color target.',
        color: normalizeClipLabelColor(args.color),
        cleared: !normalizeClipLabelColor(args.color),
        mode: target.mode,
        filter: target.filter,
        clipCount: 0,
        missingClipIds: target.missingClipIds || [],
        clips: [],
      })
    }

    if (clips.length > limit) {
      return errorResult(`Matched ${clips.length} clips, above limit ${limit}. Pass a higher limit intentionally if this is expected.`)
    }

    const color = normalizeClipLabelColor(args.color)
    const clipSummaries = clips.map((clip) => ({
      id: clip.id,
      name: clip.name || clip.assetName || clip.id,
      type: clip.type || 'unknown',
      trackId: clip.trackId || null,
      startTime: toFiniteNumber(clip.startTime, 0),
      duration: toFiniteNumber(clip.duration, 0),
      labelColor: clip.labelColor || '',
    }))

    if (args.previewOnly === true) {
      return textResult({
        previewOnly: true,
        color,
        cleared: !color,
        mode: target.mode,
        filter: target.filter,
        clipCount: clips.length,
        missingClipIds: target.missingClipIds || [],
        clips: clipSummaries,
      })
    }

    if (!this.performAction) {
      return errorResult('MCP write bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'set_clip_label_color',
      payload: {
        clipIds: clips.map((clip) => clip.id),
        color,
      },
    })

    return textResult({
      success: true,
      action: 'set_clip_label_color',
      color,
      cleared: !color,
      mode: target.mode,
      filter: target.filter,
      clipCount: clips.length,
      missingClipIds: target.missingClipIds || [],
      clips: clipSummaries,
      result,
    })
  }

  async setClipsEnabled(snapshot, args = {}) {
    if (typeof args.enabled !== 'boolean') {
      return errorResult('Provide enabled=true or enabled=false.')
    }

    const target = resolveClipLabelTargets(snapshot, args)
    if (target.error) return errorResult(target.error)

    const limit = clampLimit(args.limit, 100, 1000)
    const clips = target.clips || []
    if (clips.length === 0) {
      return textResult({
        success: false,
        message: 'No clips matched the requested enable/disable target.',
        enabled: args.enabled,
        mode: target.mode,
        filter: target.filter,
        clipCount: 0,
        missingClipIds: target.missingClipIds || [],
        clips: [],
      })
    }

    if (clips.length > limit) {
      return errorResult(`Matched ${clips.length} clips, above limit ${limit}. Pass a higher limit intentionally if this is expected.`)
    }

    const clipSummaries = clips.map((clip) => ({
      id: clip.id,
      name: clip.name || clip.assetName || clip.id,
      type: clip.type || 'unknown',
      trackId: clip.trackId || null,
      startTime: toFiniteNumber(clip.startTime, 0),
      duration: toFiniteNumber(clip.duration, 0),
      wasEnabled: clip.enabled !== false,
      nextEnabled: args.enabled,
      labelColor: clip.labelColor || '',
    }))

    if (args.previewOnly === true) {
      return textResult({
        previewOnly: true,
        enabled: args.enabled,
        mode: target.mode,
        filter: target.filter,
        clipCount: clips.length,
        missingClipIds: target.missingClipIds || [],
        clips: clipSummaries,
      })
    }

    if (!this.performAction) {
      return errorResult('MCP write bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'set_clips_enabled',
      payload: {
        clipIds: clips.map((clip) => clip.id),
        enabled: args.enabled,
      },
    })

    return textResult({
      success: true,
      action: 'set_clips_enabled',
      enabled: args.enabled,
      mode: target.mode,
      filter: target.filter,
      clipCount: clips.length,
      missingClipIds: target.missingClipIds || [],
      clips: clipSummaries,
      result,
    })
  }

  async addTimelineMarkers(snapshot, args = {}) {
    const resolved = resolveTimelineMarkerInputs(snapshot, args)
    if (resolved.error) return errorResult(resolved.error)

    const limit = clampLimit(args.limit, 25, 100)
    const markers = resolved.markers || []
    if (markers.length === 0) {
      return textResult({
        success: false,
        message: 'No markers were provided.',
        markerCount: 0,
        markers: [],
      })
    }

    if (markers.length > limit) {
      return errorResult(`Requested ${markers.length} markers, above limit ${limit}. Pass a higher limit intentionally if this is expected.`)
    }

    if (args.previewOnly === true) {
      return textResult({
        previewOnly: true,
        markerCount: markers.length,
        markers,
      })
    }

    if (!this.performAction) {
      return errorResult('MCP write bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'add_timeline_markers',
      payload: { markers },
    })

    return textResult({
      success: true,
      action: 'add_timeline_markers',
      markerCount: markers.length,
      markers,
      result,
    })
  }

  async removeTimelineMarkers(snapshot, args = {}) {
    const target = resolveTimelineMarkerRemovalTargets(snapshot, args)
    if (target.error) return errorResult(target.error)

    const timeline = snapshot.currentTimeline || null
    const fps = Math.max(1, toFiniteNumber(timeline?.fps, 24))
    const limit = clampLimit(args.limit, 100, 1000)
    const markers = target.markers || []
    const markerSummaries = markers.map((marker) => markerRef(marker, fps))

    if (markers.length === 0) {
      return textResult({
        success: false,
        message: 'No markers matched the requested removal target.',
        mode: target.mode || '',
        markerCount: 0,
        missingMarkerIds: target.missingMarkerIds || [],
        markers: [],
      })
    }

    if (markers.length > limit) {
      return errorResult(`Matched ${markers.length} markers, above limit ${limit}. Pass a higher limit intentionally if this is expected.`)
    }

    if (args.previewOnly === true) {
      return textResult({
        previewOnly: true,
        mode: target.mode || '',
        markerCount: markers.length,
        missingMarkerIds: target.missingMarkerIds || [],
        markers: markerSummaries,
      })
    }

    if (!this.performAction) {
      return errorResult('MCP write bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'remove_timeline_markers',
      payload: {
        markerIds: markers.map((marker) => marker.id),
      },
    })

    return textResult({
      success: true,
      action: 'remove_timeline_markers',
      mode: target.mode || '',
      markerCount: markers.length,
      missingMarkerIds: target.missingMarkerIds || [],
      markers: markerSummaries,
      result,
    })
  }

  async setTimelineMarkerProperties(snapshot, args = {}) {
    const target = resolveTimelineMarkerUpdateTargets(snapshot, args)
    if (target.error) return errorResult(target.error)

    const limit = clampLimit(args.limit, 100, 1000)
    const updates = target.updates || []

    if (updates.length === 0) {
      return textResult({
        success: false,
        message: 'No markers matched the requested update target.',
        mode: target.mode || '',
        markerCount: 0,
        missingMarkerIds: target.missingMarkerIds || [],
        markers: [],
      })
    }

    if (updates.length > limit) {
      return errorResult(`Matched ${updates.length} markers, above limit ${limit}. Pass a higher limit intentionally if this is expected.`)
    }

    if (args.previewOnly === true) {
      return textResult({
        previewOnly: true,
        mode: target.mode || '',
        markerCount: updates.length,
        missingMarkerIds: target.missingMarkerIds || [],
        markers: updates,
      })
    }

    if (!this.performAction) {
      return errorResult('MCP write bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'set_timeline_marker_properties',
      payload: {
        updates: updates.map((marker) => ({
          id: marker.id,
          time: marker.time,
          label: marker.label,
          color: marker.color,
        })),
      },
    })

    return textResult({
      success: true,
      action: 'set_timeline_marker_properties',
      mode: target.mode || '',
      markerCount: updates.length,
      missingMarkerIds: target.missingMarkerIds || [],
      markers: updates,
      result,
    })
  }

  async addTrack(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')

    const type = String(args.type || args.trackType || 'video').trim().toLowerCase() === 'audio' ? 'audio' : 'video'
    const name = String(args.name || '').trim().slice(0, 80)
    const channels = String(args.channels || '').trim().toLowerCase() === 'mono' ? 'mono' : 'stereo'
    const plan = {
      type,
      name: name || `${type === 'video' ? 'Video' : 'Audio'} ${(timeline.tracks || []).filter((track) => track.type === type).length + 1}`,
      placement: type === 'video' ? 'top of video stack' : 'bottom of timeline tracks',
      channels: type === 'audio' ? channels : undefined,
    }

    if (args.previewOnly === true) {
      return textResult({
        previewOnly: true,
        action: 'add_track',
        message: 'Track creation plan only. No timeline change was made.',
        plan,
      })
    }

    if (!this.performAction) {
      return errorResult('MCP track bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'add_track',
      payload: {
        type,
        name,
        channels,
      },
    })

    return textResult({
      success: true,
      action: 'add_track',
      plan,
      result,
    })
  }

  async createTimeline(snapshot, args = {}) {
    const plan = resolveCreateTimelinePlan(snapshot, args)
    if (plan.error) return errorResult(plan.error)

    const applyArgs = {
      ...args,
      previewOnly: false,
      name: plan.name,
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      durationSeconds: plan.durationSeconds,
      color: plan.color || undefined,
      folderId: plan.folderId || undefined,
      copySettingsFromCurrent: plan.copySettingsFromCurrent,
      switchToTimeline: plan.switchToTimeline,
    }

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'create_timeline',
        message: 'Sequence creation plan only. No timeline was created.',
        plan,
        suggestedApplyCall: {
          tool: 'create_timeline',
          arguments: applyArgs,
        },
      })
    }

    if (!this.performAction) {
      return errorResult('MCP sequence creation bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'create_timeline',
      payload: applyArgs,
    })

    return textResult({
      success: true,
      action: 'create_timeline',
      message: plan.switchToTimeline
        ? 'Sequence created and ComfyStudio switched to it.'
        : 'Sequence created.',
      plan,
      result,
    })
  }

  async createAssetFolder(snapshot, args = {}) {
    const plan = resolveCreateAssetFolderPlan(snapshot, args)
    if (plan.error) return errorResult(plan.error)

    const applyArgs = {
      ...args,
      previewOnly: false,
      path: plan.requestedPath,
      parentId: plan.parentId || undefined,
      reuseExisting: plan.reuseExisting,
      allowDuplicateName: plan.allowDuplicateName,
      color: plan.color || undefined,
      setColorOnExisting: plan.setColorOnExisting,
    }

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'create_asset_folder',
        message: plan.createdCount === 0
          ? 'Asset folder already exists. No project change was made.'
          : `Asset folder plan only. ${plan.createdCount} folder${plan.createdCount === 1 ? '' : 's'} would be created.`,
        plan,
        suggestedApplyCall: {
          tool: 'create_asset_folder',
          arguments: applyArgs,
        },
      })
    }

    if (!this.performAction) {
      return errorResult('MCP asset folder bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'create_asset_folder',
      payload: applyArgs,
    })

    return textResult({
      success: true,
      action: 'create_asset_folder',
      message: result?.createdCount > 0
        ? `Created ${result.createdCount} asset folder${result.createdCount === 1 ? '' : 's'}.`
        : 'Asset folder already existed.',
      plan,
      result,
    })
  }

  async moveAssetsToFolder(snapshot, args = {}) {
    const plan = resolveMoveAssetsToFolderPlan(snapshot, args)
    if (plan.error) return errorResult(plan.error)

    const applyArgs = {
      ...args,
      previewOnly: false,
      assetIds: plan.assets.map((asset) => asset.id),
      targetFolderId: plan.targetWillBeCreated ? undefined : (plan.targetFolderId || null),
      targetFolderPath: plan.targetFolderPath,
      targetRoot: plan.targetRoot,
      targetFolderColor: args.targetFolderColor || args.folderColor || undefined,
      createTargetFolder: plan.targetWillBeCreated,
    }

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'move_assets_to_folder',
        message: plan.moveCount === 0
          ? 'No matching assets need to move.'
          : `Asset move plan only. ${plan.moveCount} asset${plan.moveCount === 1 ? '' : 's'} would move to ${plan.targetRoot ? 'the asset root' : plan.targetFolderPath.join(' / ')}.`,
        plan,
        suggestedApplyCall: {
          tool: 'move_assets_to_folder',
          arguments: applyArgs,
        },
      })
    }

    if (!this.performAction) {
      return errorResult('MCP asset move bridge is not available. Restart ComfyStudio and try again.')
    }

    if (plan.moveCount === 0) {
      return textResult({
        success: false,
        action: 'move_assets_to_folder',
        message: 'No matching assets need to move.',
        plan,
      })
    }

    const result = await this.performAction({
      action: 'move_assets_to_folder',
      payload: applyArgs,
    })

    return textResult({
      success: true,
      action: 'move_assets_to_folder',
      message: `Moved ${result?.movedCount ?? plan.moveCount} asset${(result?.movedCount ?? plan.moveCount) === 1 ? '' : 's'} to ${result?.targetFolderPath?.join?.(' / ') || (plan.targetRoot ? 'the asset root' : plan.targetFolderPath.join(' / '))}.`,
      plan,
      result,
    })
  }

  async addAssetToTimeline(snapshot, args = {}) {
    const plan = resolveAssetTimelinePlacementPlan(snapshot, args)
    if (plan.error) return errorResult(plan.error)

    const applyArgs = {
      ...args,
      previewOnly: false,
      assetId: plan.asset.id,
      startSeconds: plan.startSeconds,
      durationSeconds: plan.durationSeconds,
      createTrack: plan.createTrack,
      trackName: plan.createTrack ? plan.track?.name : undefined,
      trackId: plan.createTrack ? undefined : plan.track?.id,
    }

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'add_asset_to_timeline',
        message: 'Asset placement plan only. No timeline change was made.',
        plan,
        suggestedApplyCall: {
          tool: 'add_asset_to_timeline',
          arguments: applyArgs,
        },
      })
    }

    if (!this.performAction) {
      return errorResult('MCP asset placement bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'add_asset_to_timeline',
      payload: applyArgs,
    })

    return textResult({
      success: true,
      action: 'add_asset_to_timeline',
      message: 'Asset placed on the timeline through ComfyStudio.',
      plan,
      result,
    })
  }

  async addSolidColor(snapshot, args = {}) {
    const plan = resolveSolidColorPlan(snapshot, args)
    if (plan.error) return errorResult(plan.error)

    const applyArgs = {
      ...args,
      previewOnly: false,
      color: plan.asset.color,
      name: plan.asset.name,
      width: plan.asset.width,
      height: plan.asset.height,
      durationSeconds: plan.durationSeconds,
      placeOnTimeline: plan.placeOnTimeline,
      trackId: plan.track?.id || undefined,
      createTrack: plan.createTrack,
      trackName: plan.createTrack ? plan.track?.name : undefined,
      trackPlacement: plan.trackPlacement || undefined,
      startSeconds: plan.startSeconds ?? undefined,
      resolveOverlaps: plan.resolveOverlaps,
      selectAfterAdd: plan.selectAfterAdd,
      transform: plan.transform || undefined,
    }

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'add_solid_color',
        message: 'Solid color plan only. No asset or timeline clip was created.',
        plan,
        suggestedApplyCall: {
          tool: 'add_solid_color',
          arguments: applyArgs,
        },
      })
    }

    if (!this.performAction) {
      return errorResult('MCP solid color bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'add_solid_color',
      payload: applyArgs,
    })

    return textResult({
      success: true,
      action: 'add_solid_color',
      message: 'Solid color asset created through ComfyStudio.',
      plan,
      result,
    })
  }

  async addAssetsToTimeline(snapshot, args = {}) {
    const plan = resolveAssetsTimelinePlacementPlan(snapshot, args)
    if (plan.error) return errorResult(plan.error)

    const applyArgs = {
      ...args,
      previewOnly: false,
      assets: plan.placements.map((placement) => ({
        assetId: placement.asset.id,
        trackName: placement.createTrack ? placement.track?.name : undefined,
        durationSeconds: placement.durationSeconds,
        labelColor: placement.labelColor || undefined,
        transform: placement.transform || undefined,
      })),
      startSeconds: plan.baseStartSeconds,
      layout: plan.layout,
      trackStrategy: plan.trackStrategy === 'single_track' ? 'singleTrack' : 'newTracks',
      spacingSeconds: plan.spacingSeconds,
      resolveOverlaps: plan.resolveOverlaps,
      selectAfterAdd: plan.selectAfterAdd,
      trackId: plan.trackStrategy === 'single_track' ? args.trackId : undefined,
    }

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'add_assets_to_timeline',
        message: 'Batch asset placement plan only. No timeline change was made.',
        plan,
        suggestedApplyCall: {
          tool: 'add_assets_to_timeline',
          arguments: applyArgs,
        },
      })
    }

    if (!this.performAction) {
      return errorResult('MCP batch asset placement bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'add_assets_to_timeline',
      payload: applyArgs,
    })

    return textResult({
      success: true,
      action: 'add_assets_to_timeline',
      message: 'Assets placed on the timeline through ComfyStudio.',
      plan,
      result,
    })
  }

  async duplicateClip(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')

    const clipId = String(args.clipId || '').trim()
    if (!clipId) return errorResult('Provide clipId from get_timeline.')

    const clip = (timeline.clips || []).find((candidate) => candidate?.id === clipId)
    if (!clip) return errorResult(`Clip ${clipId} was not found.`)

    const sourceTrack = getTrackById(timeline, clip.trackId)
    const requestedTrackId = String(args.trackId || '').trim()
    const targetTrack = requestedTrackId ? getTrackById(timeline, requestedTrackId) : sourceTrack
    if (!targetTrack) return errorResult(`Track ${requestedTrackId || clip.trackId} was not found.`)
    if (targetTrack.locked) return errorResult(`Track ${targetTrack.id} is locked.`)

    const clipNeedsAudioTrack = clip.type === 'audio'
    const clipNeedsVideoTrack = ['video', 'image', 'text', 'shape', 'adjustment', 'caption', 'captions'].includes(clip.type)
    if (clipNeedsAudioTrack && targetTrack.type !== 'audio') {
      return errorResult(`Clip ${clipId} is an audio clip and must be duplicated onto an audio track.`)
    }
    if (clipNeedsVideoTrack && targetTrack.type !== 'video') {
      return errorResult(`Clip ${clipId} is a ${clip.type || 'unknown'} clip and must be duplicated onto a video track.`)
    }

    const startSeconds = Number(args.startSeconds ?? args.startTime)
    const defaultStart = roundTime(getClipEnd(clip) + 0.1)
    const plan = {
      sourceClip: {
        ...clipRef(clip),
        enabled: clip.enabled !== false,
        labelColor: clip.labelColor || '',
        transform: clip.transform || null,
        textProperties: clip.textProperties || null,
        shapeProperties: clip.shapeProperties || null,
        titleAnimation: clip.titleAnimation || null,
        keyframes: clip.keyframes || null,
      },
      sourceTrack: sourceTrack ? {
        id: sourceTrack.id,
        name: sourceTrack.name,
        type: sourceTrack.type,
      } : null,
      targetTrack: {
        id: targetTrack.id,
        name: targetTrack.name,
        type: targetTrack.type,
      },
      startSeconds: Number.isFinite(startSeconds) ? startSeconds : defaultStart,
      durationSeconds: roundTime(getClipDuration(clip)),
      name: String(args.name || '').trim() || clip.name || clip.id,
      preserveLinkGroup: args.preserveLinkGroup === true,
      preserveSyncLock: args.preserveSyncLock === true,
    }

    if (args.previewOnly === true) {
      return textResult({
        previewOnly: true,
        action: 'duplicate_clip',
        message: 'Clip duplicate plan only. No timeline change was made.',
        plan,
      })
    }

    if (!this.performAction) {
      return errorResult('MCP duplicate bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'duplicate_clip',
      payload: args,
    })

    return textResult({
      success: true,
      action: 'duplicate_clip',
      plan,
      result,
    })
  }

  async addTextClip(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')

    const text = String(args.text || '').trim()
    if (!text) return errorResult('Provide text for the new text clip.')

    if (args.previewOnly === true) {
      const requestedTrackId = String(args.trackId || '').trim()
      const videoTracks = (timeline.tracks || []).filter((track) => track?.type === 'video')
      const targetTrack = requestedTrackId
        ? videoTracks.find((track) => track.id === requestedTrackId)
        : videoTracks.find((track) => track.locked !== true)
      return textResult({
        previewOnly: true,
        action: 'add_text_clip',
        message: 'Text clip creation plan only. No timeline change was made.',
        plan: {
          text,
          track: targetTrack ? { id: targetTrack.id, name: targetTrack.name, type: targetTrack.type } : null,
          startSeconds: args.startSeconds ?? args.startTime ?? timeline.playheadPosition ?? 0,
          durationSeconds: args.durationSeconds ?? args.duration ?? 5,
          style: args.style || args.textProperties || {},
          transform: args.transform || {},
          animationPreset: args.animationPreset || args.presetId || null,
          animationMode: args.animationMode || args.mode || 'inOut',
          keyframes: Array.isArray(args.keyframes) ? args.keyframes : [],
        },
        warning: targetTrack ? '' : 'No unlocked video track was found in the MCP snapshot.',
      })
    }

    if (!this.performAction) {
      return errorResult('MCP text bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'add_text_clip',
      payload: args,
    })

    return textResult({
      success: true,
      action: 'add_text_clip',
      result,
    })
  }

  async updateTextClip(snapshot, args = {}) {
    const resolved = getTextClipForMcp(snapshot, args.clipId)
    if (resolved.error) return errorResult(resolved.error)

    if (args.previewOnly === true && !this.performAction) {
      return textResult({
        previewOnly: true,
        action: 'update_text_clip',
        message: 'Text clip update plan only. No timeline change was made.',
        before: summarizeTextClipForMcp(resolved.clip),
        requested: args,
      })
    }

    if (!this.performAction) {
      return errorResult('MCP text bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'update_text_clip',
      payload: args,
    })

    return textResult({
      success: args.previewOnly === true ? undefined : true,
      previewOnly: args.previewOnly === true,
      action: 'update_text_clip',
      before: summarizeTextClipForMcp(resolved.clip),
      result,
    })
  }

  async addShapeClip(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')

    const requestedTrackId = String(args.trackId || '').trim()
    const videoTracks = (timeline.tracks || []).filter((track) => track?.type === 'video')
    const targetTrack = requestedTrackId
      ? videoTracks.find((track) => track.id === requestedTrackId)
      : videoTracks.find((track) => track.locked !== true)

    const style = {
      ...(args.shapeProperties || {}),
      ...(args.style || {}),
    }
    for (const key of ['shapeType', 'type', 'name', 'width', 'height', 'sizeLinked', 'fillType', 'gradientType', 'fillColor', 'color', 'fill', 'fillColorB', 'fillB', 'gradientColor', 'gradientColorB', 'colorB', 'gradientFill', 'fillOpacity', 'gradientAngle', 'gradientCenterX', 'gradientCenterY', 'gradientRadius', 'strokeColor', 'stroke', 'strokeOpacity', 'strokeWidth', 'cornerRadius', 'sides', 'polygonSides']) {
      if (args[key] !== undefined) style[key] = args[key]
    }
    const plannedDuration = args.durationSeconds ?? args.duration ?? 5
    let keyframes = []
    try {
      keyframes = normalizeMcpClipKeyframes(args, { type: 'shape', duration: plannedDuration })
    } catch (error) {
      return errorResult(error?.message || String(error))
    }

    if (args.previewOnly === true) {
      return textResult({
        previewOnly: true,
        action: 'add_shape_clip',
        message: 'Shape clip creation plan only. No timeline change was made.',
        plan: {
          shapeType: args.shapeType || args.type || style.shapeType || 'rectangle',
          name: args.name || style.name || '',
          track: targetTrack ? { id: targetTrack.id, name: targetTrack.name, type: targetTrack.type } : null,
          startSeconds: args.startSeconds ?? args.startTime ?? timeline.playheadPosition ?? 0,
          durationSeconds: plannedDuration,
          style,
          transform: args.transform || {},
          crop: args.crop || {},
          keyframes,
        },
        warning: targetTrack ? '' : 'No unlocked video track was found in the MCP snapshot.',
      })
    }

    if (!this.performAction) {
      return errorResult('MCP shape bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'add_shape_clip',
      payload: args,
    })

    return textResult({
      success: true,
      action: 'add_shape_clip',
      result,
    })
  }

  async updateShapeClip(snapshot, args = {}) {
    const resolved = getShapeClipForMcp(snapshot, args.clipId)
    if (resolved.error) return errorResult(resolved.error)
    let keyframes = []
    let clearKeyframes = []
    try {
      keyframes = normalizeMcpClipKeyframes(args, resolved.clip)
      clearKeyframes = normalizeMcpClipKeyframeClearProperties(args.clearKeyframes || args.clearKeyframesForProperties, resolved.clip)
    } catch (error) {
      return errorResult(error?.message || String(error))
    }

    if (args.previewOnly === true && !this.performAction) {
      return textResult({
        previewOnly: true,
        action: 'update_shape_clip',
        message: 'Shape clip update plan only. No timeline change was made.',
        before: summarizeShapeClipForMcp(resolved.clip),
        requested: { ...args, keyframes, clearKeyframes },
      })
    }

    if (!this.performAction) {
      return errorResult('MCP shape bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'update_shape_clip',
      payload: args,
    })

    return textResult({
      success: args.previewOnly === true ? undefined : true,
      previewOnly: args.previewOnly === true,
      action: 'update_shape_clip',
      before: summarizeShapeClipForMcp(resolved.clip),
      result,
    })
  }

  async setClipKeyframes(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')

    const clipId = String(args.clipId || '').trim()
    if (!clipId) return errorResult('Provide clipId from get_timeline.')

    const clip = (timeline.clips || []).find((candidate) => candidate?.id === clipId)
    if (!clip) return errorResult(`Clip ${clipId} was not found.`)

    const clipType = String(clip.type || '').toLowerCase()
    if (!MCP_VISUAL_KEYFRAME_CLIP_TYPES.has(clipType)) {
      return errorResult(`Clip ${clipId} is a ${clip.type || 'unknown'} clip. set_clip_keyframes currently supports visual clips, not audio clips.`)
    }

    let keyframes
    let clearKeyframes
    try {
      keyframes = normalizeMcpClipKeyframes(args, clip)
      clearKeyframes = normalizeMcpClipKeyframeClearProperties(args.clearKeyframes || args.clearKeyframesForProperties, clip)
    } catch (error) {
      return errorResult(error?.message || String(error))
    }

    if (keyframes.length === 0 && clearKeyframes.length === 0) {
      return errorResult('Provide at least one keyframe or clearKeyframes property.')
    }

    const plan = {
      clip: summarizeClipKeyframeTarget(clip),
      keyframes,
      clearKeyframes,
      replaceKeyframes: args.replaceKeyframes === true,
      supportedProperties: MCP_CLIP_KEYFRAME_PROPERTIES,
    }
    const applyArgs = {
      ...args,
      previewOnly: false,
      clipId,
      keyframes,
      clearKeyframes: clearKeyframes.length > 0 ? clearKeyframes : undefined,
      replaceKeyframes: args.replaceKeyframes === true,
    }

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'set_clip_keyframes',
        message: 'Clip keyframe plan only. No timeline change was made.',
        plan,
        suggestedApplyCall: {
          tool: 'set_clip_keyframes',
          arguments: applyArgs,
        },
      })
    }

    if (!this.performAction) {
      return errorResult('MCP clip keyframe bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'set_clip_keyframes',
      payload: applyArgs,
    })

    return textResult({
      success: true,
      action: 'set_clip_keyframes',
      message: 'Clip keyframes updated through ComfyStudio.',
      plan,
      result,
    })
  }

  async exportTimeline(snapshot, args = {}) {
    const readiness = checkExportReadiness(snapshot, args)
    if (readiness.error) return errorResult(readiness.error)

    const plan = resolveExportDeliveryPlan(snapshot, args)
    if (plan.error) return errorResult(plan.error)

    const outputPath = String(args.outputPath || '').trim()
    const exportPlan = {
      projectPath: plan.projectPath,
      outputPath,
      settings: plan.settings,
      timeline: plan.timeline,
      readiness,
    }

    if (readiness.blockers?.length > 0) {
      return textResult({
        success: false,
        action: 'export_timeline',
        message: 'Export was not started because delivery blockers were found.',
        ...exportPlan,
      })
    }

    if (args.previewOnly === true) {
      return textResult({
        previewOnly: true,
        action: 'export_timeline',
        message: 'Export plan only. No render was started.',
        ...exportPlan,
      })
    }

    if (!this.performAction) {
      return errorResult('MCP export bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'export_timeline',
      payload: {
        ...plan.settings,
        outputPath,
      },
    })

    return textResult({
      success: true,
      action: 'export_timeline',
      message: 'Export started in the ComfyStudio export worker.',
      ...exportPlan,
      result,
    })
  }

  readRequestBody(req) {
    return new Promise((resolve, reject) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 5 * 1024 * 1024) {
          req.destroy()
          reject(new Error('Request body is too large.'))
        }
      })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })
  }

  writeCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, MCP-Protocol-Version')
  }

  writeJson(res, statusCode, payload) {
    this.writeCorsHeaders(res)
    const data = safeJsonStringify(payload, 0)
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    })
    res.end(data)
  }
}

function createComfyStudioMcpServer(options = {}) {
  return new ComfyStudioMcpServer(options)
}

module.exports = {
  DEFAULT_MCP_PORT,
  createComfyStudioMcpServer,
}
