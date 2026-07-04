const fsSync = require('fs')
const fs = fsSync.promises
const http = require('http')
const path = require('path')
const { spawnSync } = require('child_process')

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
const MCP_ACTION_PLAN_MAX_STEPS = 50
const MCP_ACTION_PLAN_WRITABLE_TOOLS = new Set([
  'undo',
  'redo',
  'set_playhead',
  'select_clips',
  'select_assets',
  'create_project_checkpoint',
  'restore_project_checkpoint',
  'set_in_out_range',
  'import_asset_from_path',
  'relink_asset',
  'set_clip_style',
  'set_clip_label_color',
  'set_clips_enabled',
  'add_timeline_markers',
  'remove_timeline_markers',
  'set_timeline_marker_properties',
  'create_project',
  'duplicate_project',
  'create_timeline',
  'switch_timeline',
  'rename_timeline',
  'duplicate_timeline',
  'delete_timeline',
  'create_asset_folder',
  'move_assets_to_folder',
  'move_unused_assets_to_folder',
  'add_track',
  'update_track',
  'remove_track',
  'add_transition',
  'update_transition',
  'remove_transitions',
  'move_clips',
  'trim_clips',
  'delete_clips',
  'add_asset_to_timeline',
  'add_assets_to_timeline',
  'replace_clip_with_asset',
  'add_solid_color',
  'add_adjustment_clip',
  'add_text_clip',
  'add_shape_clip',
  'duplicate_clip',
  'update_text_clip',
  'update_shape_clip',
  'add_glsl_effect',
  'update_glsl_effect',
  'remove_glsl_effect',
  'set_clip_keyframes',
  'add_dip_to_black',
  'export_timeline',
  'export_delivery_batch',
  'export_fcpxml',
])
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
const MCP_TRANSITION_TYPES = new Set([
  'dissolve',
  'fade-black',
  'fade-white',
  'wipe-left',
  'wipe-right',
  'wipe-up',
  'wipe-down',
  'slide-left',
  'slide-right',
  'slide-up',
  'slide-down',
  'zoom-in',
  'zoom-out',
  'blur',
])
const MCP_VISUAL_KEYFRAME_CLIP_TYPES = new Set(['video', 'image', 'text', 'shape', 'adjustment', 'caption', 'captions'])
const MCP_GLSL_EFFECT_IDS = Object.freeze([
  'glslCameraShake',
  'glslDirectionalBlur',
  'glslLensBlur',
  'glslFisheye',
  'glslChromaWarp',
  'glslDigitalGlitch',
  'glslSharpen',
  'glslFilmGrain',
  'glslFilmLook',
  'glslFlicker',
  'glslVhsLook',
  'glslVignette',
])
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

function trackRef(track) {
  if (!track) return null
  return {
    id: track.id,
    name: track.name || track.id,
    type: track.type || 'unknown',
    visible: track.visible !== false,
    muted: Boolean(track.muted),
    locked: Boolean(track.locked),
    role: track.role || null,
    channels: track.channels || null,
  }
}

function transitionRef(transition) {
  if (!transition) return null
  return {
    id: transition.id,
    kind: transition.kind || (transition.clipId ? 'edge' : 'between'),
    type: transition.type || '',
    duration: roundTime(toFiniteNumber(transition.duration, 0)),
    clipAId: transition.clipAId || null,
    clipBId: transition.clipBId || null,
    clipId: transition.clipId || null,
    edge: transition.edge || null,
    settings: transition.settings || null,
  }
}

function timelineRef(timeline, fallbackSettings = {}) {
  if (!timeline) return null
  const tracks = Array.isArray(timeline.tracks) ? timeline.tracks : []
  const clips = Array.isArray(timeline.clips) ? timeline.clips : []
  return {
    id: timeline.id,
    name: timeline.name || timeline.id,
    width: toFiniteNumber(timeline.width, fallbackSettings.width || 1920),
    height: toFiniteNumber(timeline.height, fallbackSettings.height || 1080),
    fps: toFiniteNumber(timeline.fps, fallbackSettings.fps || 24),
    duration: roundTime(toFiniteNumber(timeline.duration, 0)),
    trackCount: tracks.length,
    clipCount: clips.length,
    transitionCount: Array.isArray(timeline.transitions) ? timeline.transitions.length : 0,
    color: timeline.color || null,
    folderId: timeline.folderId || null,
  }
}

function normalizeMcpTransitionType(value) {
  const normalized = String(value || 'dissolve').trim().toLowerCase()
  if (!MCP_TRANSITION_TYPES.has(normalized)) {
    throw new Error(`Unsupported transition type "${normalized || value}". Use one of: ${[...MCP_TRANSITION_TYPES].join(', ')}.`)
  }
  return normalized
}

function normalizeMcpTransitionDuration(value, fallback = 0.5) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return roundTime(Math.min(10, parsed))
  return fallback
}

function normalizeMcpTransitionEdge(value) {
  return String(value || 'in').trim().toLowerCase() === 'out' ? 'out' : 'in'
}

function normalizeMcpTransitionAlignment(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return ['start', 'center', 'end'].includes(normalized) ? normalized : ''
}

function normalizeMcpIdList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
  }
  const raw = String(value || '').trim()
  if (!raw) return []
  return [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))]
}

function buildMcpTransitionSettings(args = {}) {
  const settings = args.settings && typeof args.settings === 'object' ? { ...args.settings } : {}
  const alignment = normalizeMcpTransitionAlignment(args.alignment || settings.alignment)
  if (alignment) settings.alignment = alignment
  return settings
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
    effects: summarizeClipEffectsForMcp(clip),
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
    effects: summarizeClipEffectsForMcp(clip),
    keyframes: clip?.keyframes || {},
  }
}

function summarizeClipEffectsForMcp(clip) {
  return (clip?.effects || []).map((effect) => ({
    id: effect?.id,
    type: effect?.type,
    enabled: effect?.enabled !== false,
    settings: effect?.settings || {},
  }))
}

function summarizeEffectClipForMcp(clip) {
  return {
    ...clipRef(clip),
    enabled: clip?.enabled !== false,
    effects: summarizeClipEffectsForMcp(clip),
    keyframes: clip?.keyframes || {},
  }
}

function getEffectClipForMcp(snapshot, clipId) {
  const timeline = snapshot?.currentTimeline || null
  const clips = Array.isArray(timeline?.clips) ? timeline.clips : []
  const selectedIds = Array.isArray(timeline?.selectedClipIds) ? timeline.selectedClipIds.filter(Boolean) : []
  const id = String(clipId || '').trim() || (selectedIds.length === 1 ? selectedIds[0] : '')
  if (!id) return { error: 'Provide clipId from get_timeline, or select exactly one visual clip in ComfyStudio.' }
  const clip = clips.find((candidate) => candidate?.id === id)
  if (!clip) return { error: `Clip ${id} was not found.` }
  const clipType = String(clip.type || '').toLowerCase()
  if (!MCP_VISUAL_KEYFRAME_CLIP_TYPES.has(clipType)) {
    return { error: `Clip ${id} is a ${clip.type || 'unknown'} clip. GLSL effects currently support visual clips, not audio clips.` }
  }
  return { clip }
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

function clampMcpAdjustmentNumber(value, min, max, fallback = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function buildMcpAdjustmentSettings(args = {}) {
  const source = args.adjustments && typeof args.adjustments === 'object' ? args.adjustments : {}
  const groupDefaults = {
    brightness: 0,
    contrast: 0,
    saturation: 0,
    gain: 0,
    gamma: 0,
    offset: 0,
    hue: 0,
  }
  const normalizeGroup = (settings = {}) => ({
    brightness: clampMcpAdjustmentNumber(settings.brightness, -100, 100, 0),
    contrast: clampMcpAdjustmentNumber(settings.contrast, -100, 100, 0),
    saturation: clampMcpAdjustmentNumber(settings.saturation, -100, 100, 0),
    gain: clampMcpAdjustmentNumber(settings.gain, -100, 100, 0),
    gamma: clampMcpAdjustmentNumber(settings.gamma, -100, 100, 0),
    offset: clampMcpAdjustmentNumber(settings.offset, -100, 100, 0),
    hue: clampMcpAdjustmentNumber(settings.hue, -180, 180, 0),
  })
  const merged = { ...source }
  for (const key of ['brightness', 'contrast', 'saturation', 'gain', 'gamma', 'offset', 'hue', 'blur']) {
    if (Object.prototype.hasOwnProperty.call(args, key)) merged[key] = args[key]
  }
  for (const group of ['shadows', 'midtones', 'highlights']) {
    if (args[group] && typeof args[group] === 'object') merged[group] = args[group]
  }
  return {
    brightness: clampMcpAdjustmentNumber(merged.brightness, -100, 100, 0),
    contrast: clampMcpAdjustmentNumber(merged.contrast, -100, 100, 0),
    saturation: clampMcpAdjustmentNumber(merged.saturation, -100, 100, 0),
    gain: clampMcpAdjustmentNumber(merged.gain, -100, 100, 0),
    gamma: clampMcpAdjustmentNumber(merged.gamma, -100, 100, 0),
    offset: clampMcpAdjustmentNumber(merged.offset, -100, 100, 0),
    hue: clampMcpAdjustmentNumber(merged.hue, -180, 180, 0),
    blur: clampMcpAdjustmentNumber(merged.blur, 0, 50, 0),
    shadows: normalizeGroup(merged.shadows || groupDefaults),
    midtones: normalizeGroup(merged.midtones || groupDefaults),
    highlights: normalizeGroup(merged.highlights || groupDefaults),
  }
}

function resolveAdjustmentClipPlan(snapshot, args = {}) {
  const timeline = snapshot?.currentTimeline || null
  if (!timeline) return { error: 'No current timeline is available.' }

  const requestedTrackId = String(args.trackId || '').trim()
  const createTrack = (args.createTrack === true || args.newTrack === true || ['new', 'newtop', 'newtrack', 'newtoptrack', 'top'].includes(String(args.trackStrategy || args.placementTrack || '').trim().toLowerCase().replace(/[\s_-]+/g, '')))
    && !requestedTrackId
  const existingTrack = requestedTrackId
    ? getTrackById(timeline, requestedTrackId)
    : (timeline.tracks || []).find((track) => track?.type === 'video' && track.locked !== true)
  if (requestedTrackId && !existingTrack) return { error: `Track ${requestedTrackId} was not found.` }
  if (existingTrack && existingTrack.type !== 'video') return { error: `Adjustment clips must be placed on a video track, not ${existingTrack.type}.` }
  if (existingTrack?.locked) return { error: `Track ${existingTrack.id} is locked.` }

  const track = createTrack
    ? {
      id: null,
      name: String(args.trackName || args.name || 'Adjustment Layer').trim().slice(0, 80) || 'Adjustment Layer',
      type: 'video',
      locked: false,
      muted: false,
      visible: true,
    }
    : existingTrack
  if (!track) return { error: 'No unlocked video track is available for an adjustment clip.' }

  const requestedDuration = Number(args.durationSeconds ?? args.duration)
  const durationSeconds = Number.isFinite(requestedDuration) && requestedDuration > 0
    ? roundTime(requestedDuration)
    : 5
  let keyframes = []
  try {
    keyframes = normalizeMcpClipKeyframes(args, { type: 'adjustment', duration: durationSeconds })
  } catch (error) {
    return { error: error?.message || String(error) }
  }

  return {
    action: 'add_adjustment_clip',
    previewOnly: args.previewOnly !== false,
    name: String(args.name || 'Adjustment Layer').trim().slice(0, 160) || 'Adjustment Layer',
    track: trackRef(track),
    createTrack,
    startSeconds: resolveAssetPlacementStart(timeline, existingTrack?.id || '', args),
    durationSeconds,
    enabled: args.enabled !== false,
    adjustments: buildMcpAdjustmentSettings(args),
    transform: args.transform && typeof args.transform === 'object' ? args.transform : null,
    keyframes,
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
        prompt: 'Find assets that match my cleanup request, preview the exact assets and destination folder first, then move them only after I approve. For unused assets, use move_unused_assets_to_folder instead of guessing. For MCP-created solid/color constants in the root, use rootOnly plus constantsOnly and move them into a Constants folder.',
        tools: ['get_assets', 'create_asset_folder', 'move_assets_to_folder', 'move_unused_assets_to_folder'],
        safeDefaults: {
          previewOnlyFirst: true,
          destructive: false,
          createMissingTargetFolder: true,
          usefulFilters: ['rootOnly', 'constantsOnly', 'type', 'nameIncludes', 'workflowId'],
        },
      },
      {
        id: 'timeline_search',
        title: 'Timeline Search Pass',
        goal: 'Find exact clips, tracks, markers, transitions, or assets before making a change.',
        prompt: 'Search the active timeline for the thing I described, then show me matching timecodes, track names, and clip IDs before doing anything else.',
        tools: ['find_timeline_items', 'inspect_clip', 'select_clips', 'select_assets'],
        safeDefaults: {
          previewOnlyFirst: true,
          usefulFilters: ['disabled', 'enabled', 'selected', 'visual', 'audio', 'labeled', 'transformed', 'keyframed', 'effects'],
          useExplicitIdsForWriteActions: true,
        },
      },
      {
        id: 'media_health_relink',
        title: 'Media Health And Relink Pass',
        goal: 'Find missing/zero-byte/offline media and safely relink assets without touching timeline edits.',
        prompt: 'Check media health first. If anything is missing, tell me the exact asset IDs and paths. Use relink_asset with previewOnly first before changing any asset path.',
        tools: ['check_media_health', 'find_timeline_items', 'relink_asset'],
        safeDefaults: {
          previewOnlyFirst: true,
          destructive: false,
          relinkUpdatesMetadataOnly: true,
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
        id: 'project_sandbox_setup',
        title: 'Project Sandbox Setup',
        goal: 'Create or duplicate a ComfyStudio project before risky AI edits or fresh automated layouts.',
        prompt: 'If I want a fresh project, use create_project with previewOnly first. If I want to experiment safely on the current edit, use duplicate_project with previewOnly first, then apply only after I approve so the duplicate opens before you continue.',
        tools: ['get_project', 'create_project', 'duplicate_project'],
        safeDefaults: {
          previewOnlyFirst: true,
          duplicateBeforeRiskyEdits: true,
          overwritesExistingProjectFolders: false,
        },
      },
      {
        id: 'sequence_setup',
        title: 'Sequence Setup Pass',
        goal: 'Create a named sequence/timeline for alternate edits, selects, generated variations, or AI-built review layouts.',
        prompt: 'If I ask for a new sequence, preview the sequence name/settings first. After I approve, create it and switch into it before placing clips, solids, titles, or generated assets.',
        tools: ['get_project', 'get_timeline', 'create_timeline', 'switch_timeline', 'rename_timeline', 'duplicate_timeline', 'delete_timeline'],
        safeDefaults: {
          previewOnlyFirst: true,
          switchToTimeline: true,
          copySettingsFromCurrent: true,
        },
      },
      {
        id: 'track_cleanup',
        title: 'Track Cleanup Pass',
        goal: 'Rename, reorder, mute, lock, hide, or remove timeline tracks without touching media files.',
        prompt: 'Inspect the timeline tracks first. Preview any track renames, visibility changes, lock/mute changes, reorders, or removals before applying them.',
        tools: ['get_timeline', 'update_track', 'remove_track'],
        safeDefaults: {
          previewOnlyFirst: true,
          destructive: false,
          neverRemoveLastTrackOfType: true,
        },
      },
      {
        id: 'timeline_edit_operations',
        title: 'Timeline Edit Operations Pass',
        goal: 'Move, trim, or delete exact timeline clips during cleanup, review-lane layout, or generated-result assembly.',
        prompt: 'Find the exact clips first, preview the move/trim/delete plan, then apply only after I approve. Use ripple delete only when I explicitly ask to close gaps.',
        tools: ['get_timeline', 'inspect_clip', 'inspect_visible_shots', 'move_clips', 'trim_clips', 'delete_clips'],
        safeDefaults: {
          previewOnlyFirst: true,
          useExplicitClipIds: true,
          deleteLimit: 100,
          rippleRequiresExplicitUserRequest: true,
        },
      },
      {
        id: 'native_transition_polish',
        title: 'Native Transition Polish Pass',
        goal: 'Add, update, or remove ComfyStudio native transitions such as dissolves, fades, wipes, slides, zooms, blur, and dip-to-black style edits.',
        prompt: 'Inspect adjacent clips first. Preview the exact transition type, duration, edge/alignment, and affected clip IDs before applying transitions.',
        tools: ['get_timeline', 'add_transition', 'update_transition', 'remove_transitions'],
        safeDefaults: {
          previewOnlyFirst: true,
          defaultTransitionType: 'dissolve',
          defaultDurationSeconds: 0.5,
          supportedTransitionTypes: Array.from(MCP_TRANSITION_TYPES),
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
        prompt: 'Find the exact visual clips first. Preview the keyframes before applying. Use add_solid_color first if the fade needs an explicit black/color plate underneath the clips. Use add_adjustment_clip when a look, blur, GLSL effect, or color treatment should affect multiple clips below one top layer. Use add_dip_to_black for adjacent clip dips, and use set_clip_keyframes for custom fades, moves, scale, rotation, blur, crop reveals, color adjustment animation, and shape style animation such as width, height, stroke width, rounded corners, and polygon sides.',
        tools: ['get_timeline', 'inspect_clip', 'inspect_visible_shots', 'add_solid_color', 'add_adjustment_clip', 'add_dip_to_black', 'set_clip_keyframes'],
        safeDefaults: {
          previewOnlyFirst: true,
          useExplicitClipIds: true,
          fadeDurationSeconds: 0.5,
          supportedKeyframes: MCP_CLIP_KEYFRAME_PROPERTIES,
        },
      },
      {
        id: 'adjustment_layer_pass',
        title: 'Adjustment Layer Pass',
        goal: 'Create a top adjustment clip that applies color, blur, GLSL effects, or keyframed looks to multiple clips below it.',
        prompt: 'Preview the adjustment layer timing, track, color/blur settings, transform, and keyframes first. After I approve, create the adjustment clip. If I ask for an effect such as vignette, camera shake, directional blur, film grain, or VHS over several clips, create the adjustment clip first, then add/update GLSL effects on that adjustment clip.',
        tools: ['get_timeline', 'add_adjustment_clip', 'add_glsl_effect', 'update_glsl_effect', 'set_clip_keyframes'],
        safeDefaults: {
          previewOnlyFirst: true,
          createTrack: true,
          defaultDurationSeconds: 5,
          supportedAdjustmentKeys: ['brightness', 'contrast', 'saturation', 'gain', 'gamma', 'offset', 'hue', 'blur', 'shadows', 'midtones', 'highlights'],
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
        tools: ['list_comfystudio_workflows', 'create_project_checkpoint', 'create_asset_folder', 'queue_prompt_generation_batch', 'get_generation_status', 'create_timeline', 'add_assets_to_timeline', 'add_text_clip', 'add_shape_clip', 'set_clip_style', 'set_clip_keyframes', 'inspect_timeline_range', 'export_timeline'],
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
        prompt: 'Prepare the selected timeline shot for LTX 2.3 image-to-video. Preview the source frame, workflow, and prompt first; after I approve, open Generate with the frame loaded and the prompt filled in. If I ask for variations across workflows, use queue_timeline_generation_batch with previewOnly first, show the exact workflows/counts/seeds, then apply only after I approve. After generation finishes, use add_asset_to_timeline for one result, add_assets_to_timeline for multiple review lanes, or replace_clip_with_asset when I explicitly approve replacing an existing timeline clip.',
        tools: ['set_playhead', 'inspect_timeline_frame', 'list_comfystudio_workflows', 'prepare_generation_from_timeline_context', 'queue_prepared_generation', 'queue_timeline_generation_batch', 'select_assets', 'add_asset_to_timeline', 'add_assets_to_timeline', 'replace_clip_with_asset'],
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
        id: 'shot_replacement_pass',
        title: 'Shot Replacement Pass',
        goal: 'Replace an existing timeline clip with an approved imported or generated asset while preserving the edit timing and clip treatment.',
        prompt: 'Inspect the timeline clip and candidate replacement asset first. Preview the replacement plan, including whether duration, trim, transforms, effects, and keyframes will be preserved. Apply replace_clip_with_asset only after I approve. Do not delete the old asset unless I explicitly ask for cleanup afterward.',
        tools: ['get_timeline', 'get_assets', 'inspect_clip', 'replace_clip_with_asset'],
        safeDefaults: {
          previewOnlyFirst: true,
          preserveDuration: true,
          keepTransform: true,
          keepEffects: true,
          keepKeyframes: true,
          deleteOldAsset: false,
        },
      },
      {
        id: 'delivery_check',
        title: 'Delivery Check',
        goal: 'Confirm the timeline is ready for a standard H.264 HD delivery export or an interchange XML handoff.',
        prompt: 'Check whether the active timeline is ready for H.264 HD export, social delivery variants, or FCPXML handoff. Tell me any blockers or warnings. If I ask for several versions such as 16:9, 1:1, and 9:16, use export_delivery_batch with previewOnly first, then start the batch only after I approve.',
        tools: ['set_in_out_range', 'check_export_readiness', 'export_timeline', 'export_delivery_batch', 'inspect_export_file', 'export_fcpxml'],
        safeDefaults: {
          target: 'h264_hd',
          resolution: '1080p',
          format: 'mp4',
          videoCodec: 'h264',
          includeAudio: true,
        },
      },
      {
        id: 'checkpointed_action_plan',
        title: 'Checkpointed Action Plan',
        goal: 'Apply a small approved batch of MCP write actions with one safety checkpoint first.',
        prompt: 'When I approve a multi-step edit, use run_mcp_action_plan with previewOnly first. It should create a checkpoint first, run the approved steps in order, and stop on the first error.',
        tools: ['run_mcp_action_plan', 'create_project_checkpoint', 'restore_project_checkpoint'],
        safeDefaults: {
          previewOnlyFirst: true,
          createCheckpointFirst: true,
          stopOnError: true,
          maxSteps: MCP_ACTION_PLAN_MAX_STEPS,
        },
      },
      {
        id: 'fcpxml_interchange',
        title: 'FCPXML Interchange Pass',
        goal: 'Export the active ComfyStudio timeline as FCPXML for Resolve, Final Cut, or Premiere finishing.',
        prompt: 'Preview the FCPXML export plan first, including the active timeline name, clip count, and output path. After I approve, export the FCPXML to the project renders folder or the path I requested.',
        tools: ['get_project', 'get_timeline', 'export_fcpxml'],
        safeDefaults: {
          previewOnlyFirst: true,
          destination: 'project renders folder',
          requiresProjectPath: true,
        },
      },
    ],
    recommendedWorkflow: [
      'Call get_mcp_recipes or get_ai_review_passes to choose the right pass.',
      'Use create_project_checkpoint before risky multi-step AI edits; use restore_project_checkpoint with previewOnly before rolling back to a checkpoint.',
      'Call analyze_timeline for mechanical issues before visual review.',
      'Use find_timeline_items before targeting clips, tracks, markers, transitions, or assets from a natural-language request.',
      'Use check_media_health before delivery or relinking work, then use relink_asset with previewOnly when an existing asset points at a missing file.',
      'Use set_playhead before frame inspection or generation when the user gives a timecode/frame.',
      'Use select_clips or select_assets when the user asks to find, preview, or target existing timeline/project items.',
      'Use inspect_visible_shots in chunks for fast-cut music-video review.',
      'Use add_timeline_markers with previewOnly before marking many shots.',
      'Use set_timeline_marker_properties to rename/recolor review markers as decisions change.',
      'Use remove_timeline_markers with previewOnly before clearing review markers.',
      'Use move_assets_to_folder with previewOnly before organizing root assets, constants, generated results, or imported media into folders.',
      'Use move_unused_assets_to_folder with previewOnly before gathering unused project assets into an archive folder.',
      'Use update_track and remove_track with previewOnly before renaming, hiding, locking, muting, reordering, or removing tracks.',
      'Use move_clips, trim_clips, and delete_clips with previewOnly before timeline cleanup or layout changes.',
      'Use add_transition, update_transition, and remove_transitions with previewOnly before adding native transitions or transition cleanup.',
      'Use add_track, add_text_clip, duplicate_clip, and update_text_clip with previewOnly for AI-assisted text/title graphics.',
      'Use duplicate_project with previewOnly before risky project-wide experiments, or create_project with previewOnly before starting a fresh AI-built project.',
      'Use create_timeline with previewOnly before creating a new named sequence for alternate edits, generated selects, or AI-built layouts.',
      'Use switch_timeline, rename_timeline, duplicate_timeline, and delete_timeline with previewOnly for sequence management.',
      'Use create_asset_folder with previewOnly before generating a batch of source assets that should stay organized in a named folder.',
      'Use add_solid_color with previewOnly before creating black/color plates, especially underneath opacity fades.',
      'Use add_adjustment_clip with previewOnly before creating a look/effects layer that should affect clips below it.',
      'Use add_dip_to_black with previewOnly for adjacent clip dips instead of manually writing both outgoing and incoming opacity fades.',
      'Use set_clip_keyframes with previewOnly before changing visual clip opacity, transform, blur, crop, color, or shape style keyframes.',
      'Use set_clip_style with previewOnly before batch label-color, enable/disable, transform, blur, blend mode, or motion blur changes.',
      'Use import_asset_from_path with previewOnly before copying a local media file into the active project.',
      'Use queue_prompt_generation_batch with previewOnly and explicit approval when creating new stills/videos from a written creative brief.',
      'Use prepare_generation_from_timeline_context with previewOnly before opening Generate from a selected clip or playhead frame.',
      'Use queue_prepared_generation with previewOnly and explicit approval before starting any prepared Generate job.',
      'Use queue_timeline_generation_batch with previewOnly and explicit approval before queueing multiple timeline-frame variations across WAN 2.2/LTX 2.3.',
      'Use add_asset_to_timeline with previewOnly before placing generated assets or imported media back into the edit.',
      'Use add_assets_to_timeline with previewOnly to place multiple generated results as stacked review lanes or a sequential strip.',
      'Use replace_clip_with_asset with previewOnly when an approved generated/imported asset should replace a timeline clip while preserving edit timing and treatment.',
      'Use set_in_out_range before range-based export requests such as "only the first five seconds" or "export the selected section".',
      'Use export_delivery_batch with previewOnly before rendering multiple versions such as 16:9, square, and vertical from the same range.',
      'Use inspect_export_file after rendering when the user asks whether the file exists, has the expected codec, duration, FPS, or dimensions.',
      'Use run_mcp_action_plan with previewOnly before applying an approved multi-step operation in one checkpointed pass.',
      'Use export_fcpxml with previewOnly before writing an interchange XML for Resolve, Final Cut, or Premiere.',
    ],
    generatedAt: new Date().toISOString(),
  }
}

function clipHasKeyframes(clip = {}) {
  const keyframes = clip?.keyframes || {}
  if (!keyframes || typeof keyframes !== 'object') return false
  return Object.values(keyframes).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value))
}

function clipHasEffects(clip = {}) {
  if (Array.isArray(clip.effects) && clip.effects.length > 0) return true
  if (Array.isArray(clip.glslEffects) && clip.glslEffects.length > 0) return true
  if (Array.isArray(clip.adjustments?.effects) && clip.adjustments.effects.length > 0) return true
  if (clip.effect || clip.glslEffect || clip.adjustmentEffect) return true
  return false
}

function itemMatchesQuery(item = {}, query = '') {
  const search = String(query || '').trim().toLowerCase()
  if (!search) return true
  const haystack = [
    item.id,
    item.name,
    item.label,
    item.type,
    item.trackId,
    item.trackName,
    item.assetId,
    item.assetName,
    item.color,
    item.status,
  ].map((value) => String(value || '').toLowerCase()).join(' ')
  return haystack.includes(search)
}

function normalizeTimelineSearchKinds(args = {}) {
  const raw = normalizeStringList(args.kinds || args.kind || args.types || args.searchIn || args.searchKinds)
    .map((value) => value.toLowerCase())
  if (raw.length === 0 || raw.includes('all')) return new Set(['clips', 'tracks', 'markers', 'transitions', 'assets'])
  const aliases = new Map([
    ['clip', 'clips'],
    ['track', 'tracks'],
    ['marker', 'markers'],
    ['transition', 'transitions'],
    ['asset', 'assets'],
  ])
  return new Set(raw.map((value) => aliases.get(value) || value))
}

function findTimelineItems(snapshot, args = {}) {
  const timeline = snapshot?.currentTimeline || null
  const project = snapshot?.project || null
  if (!timeline) return { error: 'No current timeline is available.' }
  const assets = Array.isArray(snapshot.assets) ? snapshot.assets : []
  const assetsById = new Map(assets.map((asset) => [asset?.id, asset]).filter(([id]) => id))
  const tracks = Array.isArray(timeline.tracks) ? timeline.tracks : []
  const tracksById = new Map(tracks.map((track) => [track?.id, track]).filter(([id]) => id))
  const fps = Math.max(1, toFiniteNumber(timeline.fps, project?.settings?.fps || 24))
  const query = String(args.query || args.search || args.nameIncludes || '').trim()
  const kinds = normalizeTimelineSearchKinds(args)
  const limit = clampLimit(args.limit, 100, 1000)
  const startSeconds = Number.isFinite(Number(args.startSeconds)) ? Number(args.startSeconds) : null
  const endSeconds = Number.isFinite(Number(args.endSeconds)) ? Number(args.endSeconds) : null
  const timeSeconds = Number.isFinite(Number(args.timeSeconds)) ? Number(args.timeSeconds) : null
  const filter = String(args.filter || args.status || '').trim().toLowerCase()
  const typeFilter = String(args.type || args.clipType || '').trim().toLowerCase()
  const trackIdFilter = String(args.trackId || '').trim()
  const labelColorFilter = normalizeClipLabelColor(args.labelColor || args.color || '')
  const selectedIds = new Set(Array.isArray(timeline.selectedClipIds) ? timeline.selectedClipIds : [])

  const results = []
  const pushItem = (item) => {
    if (results.length >= limit) return
    if (!itemMatchesQuery(item, query)) return
    results.push(item)
  }

  if (kinds.has('tracks')) {
    for (const track of tracks) {
      pushItem({
        kind: 'track',
        id: track?.id,
        name: track?.name || track?.label || track?.id,
        type: track?.type || 'unknown',
        index: track?.index ?? tracks.indexOf(track),
        locked: Boolean(track?.locked),
        muted: Boolean(track?.muted),
        hidden: Boolean(track?.hidden || track?.visible === false),
      })
    }
  }

  if (kinds.has('clips')) {
    for (const clip of Array.isArray(timeline.clips) ? timeline.clips : []) {
      const start = getClipStart(clip)
      const end = getClipEnd(clip)
      const asset = assetsById.get(clip?.assetId)
      const track = tracksById.get(clip?.trackId)
      const enabled = clip?.enabled !== false
      const hasTransform = hasNonDefaultTransform(clip?.transform)
      const hasKeys = clipHasKeyframes(clip)
      const hasFx = clipHasEffects(clip)
      if (typeFilter && String(clip?.type || '').toLowerCase() !== typeFilter) continue
      if (trackIdFilter && clip?.trackId !== trackIdFilter) continue
      if (labelColorFilter && normalizeClipLabelColor(clip?.labelColor) !== labelColorFilter) continue
      if (timeSeconds !== null && !(start <= timeSeconds && end > timeSeconds)) continue
      if (startSeconds !== null && end < startSeconds) continue
      if (endSeconds !== null && start > endSeconds) continue
      if (filter === 'disabled' && enabled) continue
      if (filter === 'enabled' && !enabled) continue
      if (filter === 'selected' && !selectedIds.has(clip?.id)) continue
      if (filter === 'visual' && !['video', 'image', 'text', 'shape', 'adjustment'].includes(String(clip?.type || '').toLowerCase())) continue
      if (filter === 'audio' && String(clip?.type || '').toLowerCase() !== 'audio') continue
      if (filter === 'labeled' && !clip?.labelColor) continue
      if (filter === 'transformed' && !hasTransform) continue
      if (filter === 'keyframed' && !hasKeys) continue
      if (filter === 'effects' && !hasFx) continue
      if (args.hasTransform === true && !hasTransform) continue
      if (args.hasKeyframes === true && !hasKeys) continue
      if (args.hasEffects === true && !hasFx) continue
      pushItem({
        kind: 'clip',
        id: clip?.id,
        name: clip?.name || clip?.assetName || asset?.name || clip?.id,
        type: clip?.type || 'unknown',
        trackId: clip?.trackId || null,
        trackName: track?.name || track?.label || '',
        assetId: clip?.assetId || null,
        assetName: asset?.name || clip?.assetName || '',
        startTime: roundTime(start),
        endTime: roundTime(end),
        duration: roundTime(getClipDuration(clip)),
        timecode: `${formatTimelineTimecode(start, fps)}-${formatTimelineTimecode(end, fps)}`,
        enabled,
        selected: selectedIds.has(clip?.id),
        labelColor: clip?.labelColor || '',
        hasTransform,
        hasKeyframes: hasKeys,
        hasEffects: hasFx,
      })
    }
  }

  if (kinds.has('markers')) {
    for (const marker of Array.isArray(timeline.markers) ? timeline.markers : []) {
      const time = toFiniteNumber(marker?.time ?? marker?.timeSeconds, 0)
      if (startSeconds !== null && time < startSeconds) continue
      if (endSeconds !== null && time > endSeconds) continue
      if (labelColorFilter && normalizeClipLabelColor(marker?.color) !== labelColorFilter) continue
      pushItem({
        kind: 'marker',
        id: marker?.id,
        name: marker?.label || marker?.name || marker?.id,
        label: marker?.label || marker?.name || '',
        color: marker?.color || '',
        timeSeconds: roundTime(time),
        timecode: formatTimelineTimecode(time, fps),
      })
    }
  }

  if (kinds.has('transitions')) {
    for (const transition of Array.isArray(timeline.transitions) ? timeline.transitions : []) {
      const start = toFiniteNumber(transition?.startTime ?? transition?.time, 0)
      const duration = toFiniteNumber(transition?.duration, 0)
      const end = start + duration
      if (startSeconds !== null && end < startSeconds) continue
      if (endSeconds !== null && start > endSeconds) continue
      pushItem({
        kind: 'transition',
        id: transition?.id,
        name: transition?.name || transition?.type || transition?.id,
        type: transition?.type || 'unknown',
        startTime: roundTime(start),
        duration: roundTime(duration),
        timecode: `${formatTimelineTimecode(start, fps)}-${formatTimelineTimecode(end, fps)}`,
        fromClipId: transition?.fromClipId || transition?.clipAId || null,
        toClipId: transition?.toClipId || transition?.clipBId || null,
      })
    }
  }

  if (kinds.has('assets')) {
    for (const asset of assets) {
      const assetType = String(asset?.type || '').toLowerCase()
      if (typeFilter && assetType !== typeFilter) continue
      pushItem({
        kind: 'asset',
        id: asset?.id,
        name: asset?.name || asset?.id,
        type: asset?.type || 'unknown',
        folderId: asset?.folderId || null,
        status: asset?.generationStatus || asset?.status || 'none',
        path: asset?.absolutePath || asset?.path || '',
        duration: Number.isFinite(Number(asset?.duration)) ? roundTime(asset.duration) : null,
        width: Number(asset?.width) || null,
        height: Number(asset?.height) || null,
      })
    }
  }

  return {
    action: 'find_timeline_items',
    query,
    filters: {
      kinds: Array.from(kinds),
      filter: filter || null,
      type: typeFilter || null,
      trackId: trackIdFilter || null,
      labelColor: labelColorFilter || null,
      timeSeconds,
      startSeconds,
      endSeconds,
    },
    count: results.length,
    limitApplied: results.length >= limit,
    timeline: {
      id: timeline.id,
      name: timeline.name,
      fps,
      duration: roundTime(timeline.duration),
    },
    items: results,
  }
}

function fileUrlToPath(urlValue = '') {
  const raw = String(urlValue || '').trim()
  if (!raw.startsWith('file:')) return ''
  try {
    const url = new URL(raw)
    let pathname = decodeURIComponent(url.pathname || '')
    if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1)
    return pathname.replace(/\//g, path.sep)
  } catch {
    return ''
  }
}

function resolveAssetLocalPath(asset = {}, projectPath = '') {
  const candidates = [
    asset.absolutePath,
    asset.filePath,
    asset.sourcePath,
    asset.localPath,
    asset.path,
    asset.settings?.absolutePath,
    asset.settings?.sourcePath,
    asset.settings?.path,
    asset.url,
  ].map((value) => String(value || '').trim()).filter(Boolean)

  for (const candidate of candidates) {
    if (/^https?:\/\//i.test(candidate) || candidate.startsWith('blob:') || candidate.startsWith('data:')) continue
    const fromUrl = candidate.startsWith('file:') ? fileUrlToPath(candidate) : candidate
    if (!fromUrl) continue
    if (path.isAbsolute(fromUrl)) return path.normalize(fromUrl)
    if (projectPath) return path.normalize(path.join(projectPath, fromUrl))
  }
  return ''
}

function inspectLocalFilePath(filePath = '') {
  const normalized = String(filePath || '').trim()
  if (!normalized) return { path: '', exists: false, missingReason: 'noLocalPath' }
  try {
    const stat = fsSync.statSync(normalized)
    return {
      path: normalized,
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      zeroBytes: stat.isFile() && stat.size <= 0,
    }
  } catch (error) {
    return {
      path: normalized,
      exists: false,
      missingReason: error?.code || error?.message || 'missing',
    }
  }
}

function checkMediaHealth(snapshot, args = {}) {
  const projectPath = String(snapshot?.project?.path || '').trim()
  const timeline = snapshot?.currentTimeline || null
  const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : []
  const clips = Array.isArray(timeline?.clips) ? timeline.clips : []
  const limit = clampLimit(args.limit, 100, 1000)
  const includeUnused = args.includeUnused !== false
  const assetIdsUsedByClips = new Set(clips.map((clip) => clip?.assetId).filter(Boolean))
  const assetsById = new Map(assets.map((asset) => [asset?.id, asset]).filter(([id]) => id))
  const checkedAssets = []
  const missingFiles = []
  const zeroByteFiles = []
  const noLocalPath = []

  for (const asset of assets) {
    const localPath = resolveAssetLocalPath(asset, projectPath)
    const file = inspectLocalFilePath(localPath)
    const entry = {
      id: asset?.id,
      name: asset?.name || asset?.id,
      type: asset?.type || 'unknown',
      folderId: asset?.folderId || null,
      status: asset?.generationStatus || asset?.status || 'none',
      usedByTimeline: assetIdsUsedByClips.has(asset?.id),
      path: localPath,
      file,
    }
    checkedAssets.push(entry)
    if (!localPath) noLocalPath.push(entry)
    else if (!file.exists) missingFiles.push(entry)
    else if (file.zeroBytes) zeroByteFiles.push(entry)
  }

  const clipsMissingAssets = clips
    .filter((clip) => isAssetBackedClip(clip) && clip?.assetId && !assetsById.has(clip.assetId))
    .map((clip) => ({
      id: clip?.id,
      name: clip?.name || clip?.assetName || clip?.id,
      type: clip?.type || 'unknown',
      assetId: clip?.assetId,
      trackId: clip?.trackId || null,
      startTime: roundTime(getClipStart(clip)),
      duration: roundTime(getClipDuration(clip)),
    }))

  const unusedAssets = includeUnused
    ? checkedAssets.filter((asset) => !asset.usedByTimeline)
    : []

  const blockers = []
  if (missingFiles.length > 0) blockers.push(`${missingFiles.length} asset file${missingFiles.length === 1 ? '' : 's'} missing on disk`)
  if (zeroByteFiles.length > 0) blockers.push(`${zeroByteFiles.length} asset file${zeroByteFiles.length === 1 ? '' : 's'} are zero bytes`)
  if (clipsMissingAssets.length > 0) blockers.push(`${clipsMissingAssets.length} timeline clip${clipsMissingAssets.length === 1 ? '' : 's'} reference missing asset IDs`)

  const warnings = []
  if (noLocalPath.length > 0) warnings.push(`${noLocalPath.length} asset${noLocalPath.length === 1 ? '' : 's'} have no local path to check`)
  if (unusedAssets.length > 0) warnings.push(`${unusedAssets.length} asset${unusedAssets.length === 1 ? '' : 's'} are not used by the active timeline`)

  return {
    action: 'check_media_health',
    projectPath,
    timeline: timeline ? {
      id: timeline.id,
      name: timeline.name,
      clipCount: clips.length,
    } : null,
    ready: blockers.length === 0,
    assetCount: assets.length,
    checkedAssetCount: checkedAssets.length,
    blockers,
    warnings,
    counts: {
      missingFiles: missingFiles.length,
      zeroByteFiles: zeroByteFiles.length,
      noLocalPath: noLocalPath.length,
      clipsMissingAssets: clipsMissingAssets.length,
      unusedAssets: unusedAssets.length,
    },
    missingFiles: missingFiles.slice(0, limit),
    zeroByteFiles: zeroByteFiles.slice(0, limit),
    noLocalPath: noLocalPath.slice(0, limit),
    clipsMissingAssets: clipsMissingAssets.slice(0, limit),
    unusedAssets: unusedAssets.slice(0, limit),
    suggestedNextActions: [
      missingFiles.length > 0 ? 'Use relink_asset with previewOnly first for each missing asset, or import replacement media and replace clips intentionally.' : null,
      clipsMissingAssets.length > 0 ? 'Use find_timeline_items or inspect_clip to locate clips referencing missing asset IDs.' : null,
      unusedAssets.length > 0 ? 'Use move_unused_assets_to_folder with previewOnly before organizing unused assets.' : null,
    ].filter(Boolean),
  }
}

function findLatestRenderFile(snapshot, args = {}) {
  const projectPath = String(snapshot?.project?.path || '').trim()
  const rendersDir = String(args.rendersDir || (projectPath ? path.join(projectPath, 'renders') : '')).trim()
  if (!rendersDir) return ''
  const exts = new Set(normalizeStringList(args.extensions || args.extension || ['mp4', 'mov', 'webm', 'mkv', 'fcpxml', 'xml'])
    .map((ext) => ext.toLowerCase().replace(/^\./, '')))
  const found = []
  const walk = (dir, depth = 0) => {
    if (depth > 4 || found.length > 5000) return
    let entries = []
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1)
        continue
      }
      const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase()
      if (!exts.has(ext)) continue
      try {
        const stat = fsSync.statSync(fullPath)
        found.push({ path: fullPath, modifiedMs: stat.mtimeMs, size: stat.size })
      } catch {
        // Ignore files that disappear while scanning.
      }
    }
  }
  walk(rendersDir, 0)
  found.sort((a, b) => b.modifiedMs - a.modifiedMs)
  return found[0]?.path || ''
}

function parseFfprobeRate(value = '') {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (!raw.includes('/')) {
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? roundTime(parsed) : null
  }
  const [num, den] = raw.split('/').map(Number)
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null
  return roundTime(num / den)
}

function inspectExportFile(snapshot, args = {}) {
  const requestedPath = String(args.path || args.filePath || args.outputPath || '').trim()
  const filePath = requestedPath || findLatestRenderFile(snapshot, args)
  if (!filePath) {
    return {
      error: 'Provide an export file path, or open a saved project with files in its renders folder.',
      suggestedArguments: { path: 'C:\\path\\to\\export.mp4' },
    }
  }

  const file = inspectLocalFilePath(filePath)
  const result = {
    action: 'inspect_export_file',
    path: filePath,
    exists: file.exists,
    file,
    ready: Boolean(file.exists && file.isFile && !file.zeroBytes),
    warnings: [],
    blockers: [],
    ffprobe: null,
  }
  if (!file.exists) result.blockers.push('Export file does not exist.')
  if (file.exists && !file.isFile) result.blockers.push('Path is not a file.')
  if (file.zeroBytes) result.blockers.push('Export file is zero bytes.')
  if (result.blockers.length > 0) {
    result.ready = false
    return result
  }

  const probe = spawnSync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], { encoding: 'utf8', windowsHide: true })
  if (probe.status !== 0 || !probe.stdout) {
    result.warnings.push('ffprobe is not available or could not read this file; returning basic filesystem QC only.')
    result.ffprobeAvailable = false
    return result
  }

  try {
    const parsed = JSON.parse(probe.stdout)
    const streams = Array.isArray(parsed.streams) ? parsed.streams : []
    const videoStreams = streams.filter((stream) => stream.codec_type === 'video')
    const audioStreams = streams.filter((stream) => stream.codec_type === 'audio')
    const primaryVideo = videoStreams[0] || null
    result.ffprobeAvailable = true
    result.ffprobe = {
      duration: Number.isFinite(Number(parsed.format?.duration)) ? roundTime(parsed.format.duration) : null,
      bitrate: Number.isFinite(Number(parsed.format?.bit_rate)) ? Number(parsed.format.bit_rate) : null,
      formatName: parsed.format?.format_name || '',
      streamCount: streams.length,
      video: primaryVideo ? {
        codec: primaryVideo.codec_name || '',
        width: primaryVideo.width || null,
        height: primaryVideo.height || null,
        fps: parseFfprobeRate(primaryVideo.avg_frame_rate || primaryVideo.r_frame_rate),
        pixFmt: primaryVideo.pix_fmt || '',
      } : null,
      audio: audioStreams.map((stream) => ({
        codec: stream.codec_name || '',
        channels: stream.channels || null,
        sampleRate: stream.sample_rate ? Number(stream.sample_rate) : null,
      })),
    }

    const targetWidth = Number(args.width || args.expectedWidth)
    const targetHeight = Number(args.height || args.expectedHeight)
    const targetCodec = String(args.videoCodec || args.expectedVideoCodec || '').toLowerCase()
    const targetDuration = Number(args.durationSeconds || args.expectedDurationSeconds)
    if (Number.isFinite(targetWidth) && result.ffprobe.video?.width !== targetWidth) {
      result.warnings.push(`Video width is ${result.ffprobe.video?.width}, expected ${targetWidth}.`)
    }
    if (Number.isFinite(targetHeight) && result.ffprobe.video?.height !== targetHeight) {
      result.warnings.push(`Video height is ${result.ffprobe.video?.height}, expected ${targetHeight}.`)
    }
    if (targetCodec && !String(result.ffprobe.video?.codec || '').toLowerCase().includes(targetCodec.replace(/^h\./, 'h'))) {
      result.warnings.push(`Video codec is ${result.ffprobe.video?.codec || 'unknown'}, expected ${targetCodec}.`)
    }
    if (Number.isFinite(targetDuration) && Math.abs((result.ffprobe.duration || 0) - targetDuration) > 0.15) {
      result.warnings.push(`Duration is ${result.ffprobe.duration}s, expected about ${targetDuration}s.`)
    }
  } catch (error) {
    result.warnings.push(`ffprobe output could not be parsed: ${error?.message || String(error)}`)
  }

  return result
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

function chooseDeliveryBatchSizeTarget(args = {}, baseTarget = 'h264_720p') {
  const resolution = String(args.resolution || args.size || '').trim().toLowerCase()
  if (resolution.includes('1080') || resolution === 'hd') {
    if (baseTarget.includes('square')) return 'h264_square_1080'
    if (baseTarget.includes('vertical') || baseTarget.includes('9x16')) return 'h264_vertical_1080'
    return 'h264_hd'
  }
  if (resolution.includes('720')) {
    if (baseTarget.includes('square')) return 'h264_square_720'
    if (baseTarget.includes('vertical') || baseTarget.includes('9x16')) return 'h264_vertical_720'
    return 'h264_720p'
  }
  return baseTarget
}

function normalizeDeliveryBatchTargetEntry(entry, index, sharedArgs = {}, filenamePrefix = '') {
  let targetArgs = {}
  let label = `target_${index + 1}`

  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    targetArgs = { ...entry }
    label = String(entry.label || entry.name || entry.target || entry.aspectRatio || label)
  } else {
    const raw = String(entry || 'h264_hd').trim()
    const normalized = raw.toLowerCase().replace(/\s+/g, '').replace(/_/g, '-')
    if (['16:9', '16x9', 'horizontal', 'landscape', 'widescreen'].includes(normalized)) {
      targetArgs = { target: chooseDeliveryBatchSizeTarget(sharedArgs, 'h264_hd'), aspectRatio: '16:9' }
      label = '16x9'
    } else if (['1:1', '1x1', 'square'].includes(normalized)) {
      targetArgs = { target: chooseDeliveryBatchSizeTarget(sharedArgs, 'h264_square_720'), aspectRatio: '1:1' }
      label = '1x1'
    } else if (['9:16', '9x16', 'vertical', 'portrait'].includes(normalized)) {
      targetArgs = { target: chooseDeliveryBatchSizeTarget(sharedArgs, 'h264_vertical_720'), aspectRatio: '9:16' }
      label = '9x16'
    } else {
      targetArgs = { target: raw || 'h264_hd' }
      label = raw || 'h264_hd'
    }
  }

  const merged = {
    ...sharedArgs,
    ...targetArgs,
  }
  if (!merged.filename && filenamePrefix) {
    merged.filename = sanitizeExportBaseName(`${filenamePrefix}_${String(index + 1).padStart(2, '0')}_${label}`)
  }
  delete merged.previewOnly
  delete merged.targets
  delete merged.presets
  delete merged.stopOnError
  delete merged.limit
  delete merged.filenamePrefix
  return merged
}

function buildExportDeliveryBatchPlan(snapshot, args = {}) {
  const project = snapshot?.project || null
  const timeline = snapshot?.currentTimeline || null
  if (!project || !timeline) {
    return { error: 'Open a saved ComfyStudio project and timeline before exporting.' }
  }

  const rawTargets = Array.isArray(args.targets) && args.targets.length > 0
    ? args.targets
    : Array.isArray(args.presets) && args.presets.length > 0
      ? args.presets
      : [args.target || 'h264_hd']
  const limit = Math.min(12, Math.max(1, Math.floor(toFiniteNumber(args.limit, 6))))
  const sharedKeys = [
    'range',
    'startSeconds',
    'endSeconds',
    'includeAudio',
    'videoCodec',
    'codec',
    'format',
    'audioCodec',
    'resolution',
    'fps',
    'crf',
    'bitrateKbps',
    'audioBitrateKbps',
    'useHardwareEncoder',
    'useProxyMedia',
    'useDirectFramePipe',
    'deliveryFraming',
    'framing',
    'qualityMode',
    'encoderPreset',
    'encoderSpeed',
    'nvencPreset',
  ]
  const sharedArgs = {}
  for (const key of sharedKeys) {
    if (Object.prototype.hasOwnProperty.call(args, key)) sharedArgs[key] = args[key]
  }

  const safeProjectName = sanitizeExportBaseName(project.name || 'ComfyStudio')
  const safeTimelineName = sanitizeExportBaseName(timeline.name || 'Timeline')
  const filenamePrefix = sanitizeExportBaseName(args.filenamePrefix || `${safeProjectName}_${safeTimelineName}`)

  const targets = rawTargets.slice(0, limit).map((entry, index) => {
    const targetArgs = normalizeDeliveryBatchTargetEntry(entry, index, sharedArgs, filenamePrefix)
    const readiness = checkExportReadiness(snapshot, targetArgs)
    const plan = readiness?.error ? null : resolveExportDeliveryPlan(snapshot, targetArgs)
    const blockers = readiness?.error ? [readiness.error] : readiness?.blockers || []
    return {
      index,
      entry,
      args: targetArgs,
      readiness,
      plan: plan && !plan.error ? plan : null,
      blockers,
      warningCount: readiness?.warnings?.length || 0,
      noteCount: readiness?.notes?.length || 0,
    }
  })

  return {
    action: 'export_delivery_batch',
    targetCount: targets.length,
    readyCount: targets.filter((target) => target.blockers.length === 0).length,
    blockedCount: targets.filter((target) => target.blockers.length > 0).length,
    targets,
    truncated: rawTargets.length > limit,
    requestedCount: rawTargets.length,
    limit,
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
      name: 'get_mcp_recipes',
      description: 'Return practical MCP agent recipes and recommended workflows for ComfyStudio. This is a clearer alias for get_ai_review_passes and should be used when a user asks what the MCP can do.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'find_timeline_items',
      description: 'Search the active timeline and project assets for clips, tracks, markers, transitions, or assets by name, type, time range, track, color, enabled state, transforms, keyframes, or effects. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to search across IDs, names, labels, track names, asset names, colors, and statuses.' },
          kind: { type: 'string', description: 'Single kind to search: clips, tracks, markers, transitions, assets, or all.' },
          kinds: { type: 'array', items: { type: 'string' }, description: 'Kinds to search: clips, tracks, markers, transitions, assets, or all.' },
          filter: { type: 'string', enum: ['disabled', 'enabled', 'selected', 'visual', 'audio', 'labeled', 'transformed', 'keyframed', 'effects'], description: 'Optional timeline clip filter.' },
          type: { type: 'string', description: 'Optional clip or asset type such as video, image, audio, text, shape, adjustment.' },
          trackId: { type: 'string', description: 'Only return clips on this track.' },
          timeSeconds: { type: 'number', description: 'Only return clips covering this time.' },
          startSeconds: { type: 'number', description: 'Range start for clips, markers, and transitions.' },
          endSeconds: { type: 'number', description: 'Range end for clips, markers, and transitions.' },
          labelColor: { type: 'string', description: 'Only return clips or markers with this #RRGGBB label/marker color.' },
          hasTransform: { type: 'boolean', description: 'When true, only return clips with non-default transforms.' },
          hasKeyframes: { type: 'boolean', description: 'When true, only return clips with keyframes.' },
          hasEffects: { type: 'boolean', description: 'When true, only return clips with effects.' },
          limit: { type: 'integer', description: 'Maximum items to return. Defaults to 100.' },
        },
      },
    },
    {
      name: 'check_media_health',
      description: 'Check active project media health: missing files, zero-byte files, assets without local paths, clips referencing missing asset IDs, and unused active-timeline assets. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          includeUnused: { type: 'boolean', description: 'Include assets not used by the active timeline. Defaults to true.' },
          limit: { type: 'integer', description: 'Maximum entries per issue list. Defaults to 100.' },
        },
      },
    },
    {
      name: 'inspect_export_file',
      description: 'Inspect an exported media/XML file on disk. If ffprobe is installed, returns codec, duration, resolution, FPS, audio, and expected-target warnings. If path is omitted, tries the latest file in the project renders folder.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path to inspect.' },
          filePath: { type: 'string', description: 'Alias for path.' },
          outputPath: { type: 'string', description: 'Alias for path.' },
          rendersDir: { type: 'string', description: 'Optional renders directory to scan when path is omitted.' },
          extensions: { type: 'array', items: { type: 'string' }, description: 'Extensions to consider for latest render lookup. Defaults to mp4/mov/webm/mkv/fcpxml/xml.' },
          width: { type: 'integer', description: 'Expected video width for QC warning.' },
          height: { type: 'integer', description: 'Expected video height for QC warning.' },
          videoCodec: { type: 'string', description: 'Expected video codec for QC warning, e.g. h264.' },
          durationSeconds: { type: 'number', description: 'Expected duration for QC warning.' },
        },
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
      name: 'guide_comfyui_setup',
      description: 'Beginner-friendly ComfyStudio-to-ComfyUI setup wizard. Diagnoses the current connection, probes common local ComfyUI ports, explains what to do for Portable/Desktop/Docker/manual installs, and can preview or apply the safe port-setting fix when ComfyUI is found on a different port.',
      inputSchema: {
        type: 'object',
        properties: {
          installType: {
            type: 'string',
            enum: ['auto', 'portable', 'desktop', 'docker', 'manual', 'unknown'],
            description: 'What kind of ComfyUI install the user has. Use auto/unknown when unsure.',
          },
          port: {
            type: 'integer',
            description: 'Optional ComfyUI port the user sees in their browser/terminal, for example 8188.',
          },
          candidatePorts: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Optional extra localhost ports to probe. Common ComfyUI ports are included automatically.',
          },
          timeoutMs: {
            type: 'integer',
            description: 'Request timeout per probe in milliseconds. Defaults to 4500, max 30000.',
          },
          applyFix: {
            type: 'boolean',
            description: 'When true and previewOnly=false, update ComfyStudio to the reachable ComfyUI port if a safe port mismatch is found. Defaults to false.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, diagnose and propose the setup/fix without changing ComfyStudio. Defaults to true.',
          },
          nodeClasses: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional ComfyUI node class names to validate after the connection is healthy, such as KSampler or LoadImage.',
          },
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
      name: 'list_recent_projects',
      description: 'List recently opened ComfyStudio projects (name, path, last modified, whether currently open). Works with no project open. Use with open_project to recover after an app restart or switch projects.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Maximum projects to return. Defaults to 10 (the full recent list).' },
        },
      },
    },
    {
      name: 'open_project',
      description: 'Open a ComfyStudio project by folder path or by recent-project name. Works with no project open; replaces the currently open project (work is autosaved). Defaults to previewOnly.',
      inputSchema: {
        type: 'object',
        properties: {
          projectPath: { type: 'string', description: 'Absolute project folder path.' },
          projectName: { type: 'string', description: 'Name of a recent project from list_recent_projects. Used when projectPath is omitted.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the open plan without switching projects. Defaults to true.' },
        },
      },
    },
    {
      name: 'transcribe_captions',
      description: 'Transcribe spoken audio into timed caption cues with the local ComfyUI Qwen3-ASR workflow. Starts a background job and returns a jobId immediately; poll get_caption_status for progress and the finished editable cue draft. Timeline scope transcribes the mixed program audio; asset scope transcribes one source asset. Requires a reachable ComfyUI connection. Defaults to previewOnly.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['timeline', 'asset'], description: 'Transcribe the mixed timeline program audio or a single source asset. Defaults to timeline.' },
          assetId: { type: 'string', description: 'Source asset ID from get_assets. Required when scope is asset.' },
          language: { type: 'string', description: 'ASR language hint such as English or Auto. Defaults to Auto.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the transcription plan without starting a job. Defaults to true.' },
        },
      },
    },
    {
      name: 'get_caption_status',
      description: 'Return the state of the active or most recent MCP caption job (transcribe_captions / generate_captions) plus the current editable caption cue draft.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Optional caption job ID. Defaults to the most recent job.' },
          includeCues: { type: 'boolean', description: 'Include the full cue list in the draft summary. Defaults to true.' },
        },
      },
    },
    {
      name: 'update_caption_cues',
      description: 'Edit the caption cue draft produced by transcribe_captions before rendering: fix text, retime, remove cues, or replace the whole cue list. Draft-only; the timeline does not change until generate_captions runs.',
      inputSchema: {
        type: 'object',
        properties: {
          cues: {
            type: 'array',
            description: 'Full replacement cue list. Times are in seconds.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                start: { type: 'number' },
                end: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['start', 'end', 'text'],
            },
          },
          edits: {
            type: 'array',
            description: 'Targeted edits to existing cues by id.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
                startSeconds: { type: 'number' },
                endSeconds: { type: 'number' },
              },
              required: ['id'],
            },
          },
          removeIds: { type: 'array', items: { type: 'string' }, description: 'Cue IDs to delete from the draft.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the resulting cue list without saving the draft.' },
        },
      },
    },
    {
      name: 'generate_captions',
      description: 'Render the caption cue draft into a transparent animated overlay and place it on the dedicated Captions track. Starts a background job that renders in real time (a 10s program takes about 10s); poll get_caption_status. Replaces any prior timeline-scope caption overlay. Defaults to previewOnly.',
      inputSchema: {
        type: 'object',
        properties: {
          presetId: { type: 'string', enum: ['kinetic-pop', 'kinetic-traditional', 'kinetic-neon', 'kinetic-bold-dark', 'kinetic-punch'], description: 'Caption style preset. Defaults to kinetic-pop. kinetic-traditional renders static bottom subtitles.' },
          accentColor: { type: 'string', description: 'Spoken-word accent color as #RRGGBB. Defaults to the preset accent.' },
          textColor: { type: 'string', description: 'Base text color as #RRGGBB. Defaults to the preset text color.' },
          textStyle: { type: 'string', enum: ['background', 'outline', 'shadow', 'plain'], description: 'Text treatment. Defaults to the preset default.' },
          fontFamily: { type: 'string', description: 'Font family such as Inter, Arial, Impact, Georgia.' },
          verticalPlacement: { type: 'string', enum: ['auto', 'top', 'middle', 'bottom'] },
          horizontalPlacement: { type: 'string', enum: ['auto', 'left', 'center', 'right'] },
          motionProfile: { type: 'string', enum: ['auto', 'tamed', 'excited', 'frenetic'], description: 'How energetically words move. tamed holds a line; frenetic roams.' },
          sizeScale: { type: 'number', description: 'Font size multiplier from 0.3 to 2. Defaults to 1.' },
          verticalOffset: { type: 'number', description: 'Vertical nudge as a fraction of frame height from -0.45 to 0.45. Defaults to 0.' },
          subtitlePosition: { type: 'string', enum: ['action-safe', 'title-safe', 'center'], description: 'Placement for the kinetic-traditional subtitles preset.' },
          placeOnTimeline: { type: 'boolean', description: 'Place the rendered overlay on the Captions track. Defaults to true.' },
          cues: {
            type: 'array',
            description: 'Optional inline cue list to render instead of the stored draft.',
            items: {
              type: 'object',
              properties: {
                start: { type: 'number' },
                end: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['start', 'end', 'text'],
            },
          },
          previewOnly: { type: 'boolean', description: 'When true, returns the render plan without starting the job. Defaults to true.' },
        },
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
      name: 'undo',
      description: 'Undo the latest ComfyStudio timeline edit or sequence/project-structure edit. Scope can be auto, timeline, or project. Low-risk and mirrors the app undo stack.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['auto', 'timeline', 'project'], description: 'Which undo stack to use. Defaults to auto, choosing the most recent available stack.' },
          previewOnly: { type: 'boolean', description: 'When true, reports what would be undone without changing anything.' },
        },
      },
    },
    {
      name: 'redo',
      description: 'Redo the latest ComfyStudio timeline edit or sequence/project-structure edit. Scope can be auto, timeline, or project. Low-risk and mirrors the app redo stack.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['auto', 'timeline', 'project'], description: 'Which redo stack to use. Defaults to auto, choosing the most recent available stack.' },
          previewOnly: { type: 'boolean', description: 'When true, reports what would be redone without changing anything.' },
        },
      },
    },
    {
      name: 'set_playhead',
      description: 'Move the active timeline playhead to a seconds value, timecode, or frame. Useful before inspecting frames, staging generation, or setting ranges.',
      inputSchema: {
        type: 'object',
        properties: {
          timeSeconds: { type: 'number', description: 'Target playhead time in seconds.' },
          time: { oneOf: [{ type: 'number' }, { type: 'string' }], description: 'Alias for timeSeconds, or a timecode string.' },
          timecode: { type: 'string', description: 'Target timecode such as 00:01:21:08.' },
          frame: { type: 'integer', description: 'Target frame number when seconds/timecode are omitted.' },
          snapToFrame: { type: 'boolean', description: 'When true, snap to the nearest timeline frame. Defaults to true.' },
          previewOnly: { type: 'boolean', description: 'When true, reports the target time without moving the playhead.' },
        },
      },
    },
    {
      name: 'select_clips',
      description: 'Select timeline clips by ID, current selection, filter, track, time, type, label color, or name search. Can optionally move the playhead to the first selected clip.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Single clip ID to select.' },
          clipIds: { type: 'array', items: { type: 'string' }, description: 'Clip IDs to select.' },
          filter: { type: 'string', enum: ['selected', 'disabled', 'enabled', 'visual', 'audio', 'labeled', 'colored'], description: 'Optional clip filter when explicit IDs are omitted.' },
          type: { type: 'string', description: 'Optional clip type filter, for example video, image, audio, text, shape, or adjustment.' },
          trackId: { type: 'string', description: 'Only select clips on this track.' },
          timeSeconds: { type: 'number', description: 'Only select clips covering this timeline time.' },
          timecode: { type: 'string', description: 'Only select clips covering this timeline timecode.' },
          nameIncludes: { type: 'string', description: 'Only select clips whose clip name, asset name, or ID contains this text.' },
          labelColor: { type: 'string', description: 'Only select clips with this #RRGGBB label color.' },
          movePlayheadToStart: { type: 'boolean', description: 'When true, move the playhead to the first selected clip start.' },
          clear: { type: 'boolean', description: 'When true with no matches, clears the selection.' },
          limit: { type: 'integer', description: 'Safety limit for matched clips. Defaults to 200.' },
          previewOnly: { type: 'boolean', description: 'When true, returns matching clips without selecting them.' },
        },
      },
    },
    {
      name: 'select_assets',
      description: 'Select/preview project assets by ID, name, type, folder, status, or latest match. ComfyStudio currently previews the first matched asset.',
      inputSchema: {
        type: 'object',
        properties: {
          assetId: { type: 'string', description: 'Single asset ID to preview/select.' },
          assetIds: { type: 'array', items: { type: 'string' }, description: 'Asset IDs to match.' },
          assetName: { type: 'string', description: 'Exact or partial asset name to match.' },
          assetNames: { type: 'array', items: { type: 'string' }, description: 'Asset names to match.' },
          type: { type: 'string', enum: ['video', 'image', 'audio', 'mask'], description: 'Optional asset type filter.' },
          folderId: { type: 'string', description: 'Only match assets inside this folder.' },
          rootOnly: { type: 'boolean', description: 'Only match assets currently in the asset root.' },
          latest: { type: 'boolean', description: 'When true, only return the newest matching asset.' },
          nameIncludes: { type: 'string', description: 'Optional asset name search.' },
          status: { type: 'string', description: 'Optional generation/status filter.' },
          setPreview: { type: 'boolean', description: 'When true, preview the first matched asset. Defaults to true.' },
          limit: { type: 'integer', description: 'Safety limit for matched assets. Defaults to 200.' },
          previewOnly: { type: 'boolean', description: 'When true, returns matching assets without changing the preview.' },
        },
      },
    },
    {
      name: 'create_project_checkpoint',
      description: 'Create an in-memory MCP safety checkpoint of the open project/timeline/assets for this app session. Use before risky AI edits; this does not create a saved project copy on disk.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short human label for the checkpoint.' },
          name: { type: 'string', description: 'Alias for label.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the checkpoint plan without storing it.' },
        },
      },
    },
    {
      name: 'restore_project_checkpoint',
      description: 'Preview or restore an in-memory MCP project checkpoint created during this ComfyStudio session. Defaults to previewOnly because it can replace current timeline/asset state.',
      inputSchema: {
        type: 'object',
        properties: {
          checkpointId: { type: 'string', description: 'Checkpoint ID to restore. If omitted, restores the latest checkpoint.' },
          id: { type: 'string', description: 'Alias for checkpointId.' },
          saveProject: { type: 'boolean', description: 'When true on apply, save the restored state to the project file. Defaults to false.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the restore plan without changing the project. Defaults to true.' },
        },
      },
    },
    {
      name: 'import_asset_from_path',
      description: 'Preview or import a local media file path into the active ComfyStudio project assets folder. Applies the same copy/import path as the UI import button and can place the new asset into an asset folder.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute local file path to import.' },
          filePath: { type: 'string', description: 'Alias for path.' },
          sourcePath: { type: 'string', description: 'Alias for path.' },
          category: { type: 'string', enum: ['video', 'audio', 'images', 'image'], description: 'Optional category. If omitted, inferred from extension.' },
          folderId: { type: 'string', description: 'Optional existing asset folder ID for the imported asset.' },
          folderPath: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Optional folder path to create/reuse before assigning the imported asset.' },
          folderName: { type: 'string', description: 'Single folder name alias for folderPath.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the import plan without copying the file. Defaults to true.' },
        },
      },
    },
    {
      name: 'relink_asset',
      description: 'Preview or relink an existing ComfyStudio asset record to a different local file path. Useful after check_media_health finds missing media. This updates ComfyStudio project metadata only; it does not copy media. Defaults to previewOnly.',
      inputSchema: {
        type: 'object',
        properties: {
          assetId: { type: 'string', description: 'Asset ID to relink.' },
          assetName: { type: 'string', description: 'Exact or partial asset name to relink when assetId is omitted.' },
          path: { type: 'string', description: 'Absolute replacement local file path.' },
          filePath: { type: 'string', description: 'Alias for path.' },
          sourcePath: { type: 'string', description: 'Alias for path.' },
          setPreview: { type: 'boolean', description: 'When true on apply, preview the relinked asset. Defaults to true.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the relink plan without changing the project. Defaults to true.' },
        },
      },
    },
    {
      name: 'set_clip_style',
      description: 'Preview or batch-update simple clip styling: label color, enabled state, transform fields, crop, blur, blend mode, and motion blur settings. Use for broad AI timeline polish passes. Defaults to previewOnly.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Single clip ID to update.' },
          clipIds: { type: 'array', items: { type: 'string' }, description: 'Clip IDs to update.' },
          filter: { type: 'string', enum: ['selected', 'disabled', 'enabled', 'visual', 'audio', 'labeled', 'colored'], description: 'Optional target filter when IDs are omitted.' },
          trackId: { type: 'string', description: 'Only update clips on this track.' },
          type: { type: 'string', description: 'Only update clips of this type.' },
          nameIncludes: { type: 'string', description: 'Only update clips whose name/asset/id contains this text.' },
          labelColor: { type: 'string', description: 'Set/clear timeline clip label color as #RRGGBB. Empty string clears.' },
          enabled: { type: 'boolean', description: 'Enable or disable matched clips.' },
          transform: { type: 'object', description: 'Transform updates such as positionX, positionY, scaleX, scaleY, rotation, rotationX, rotationY, opacity, blur, blendMode, crop fields, or motion blur fields.' },
          transformDelta: { type: 'object', description: 'Relative transform changes such as positionX/positionY deltas.' },
          positionX: { type: 'number' },
          positionY: { type: 'number' },
          scaleX: { type: 'number' },
          scaleY: { type: 'number' },
          rotation: { type: 'number' },
          opacity: { type: 'number' },
          blur: { type: 'number' },
          blendMode: { type: 'string', description: 'Blend mode such as normal, screen, overlay, multiply, add, etc.' },
          motionBlurEnabled: { type: 'boolean' },
          motionBlurMode: { type: 'string', enum: ['auto', 'velocity', 'sampled'] },
          motionBlurSamples: { type: 'number' },
          motionBlurShutter: { type: 'number' },
          limit: { type: 'integer', description: 'Safety limit for matched clips. Defaults to 100.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the style plan without changing clips. Defaults to true.' },
        },
      },
    },
    {
      name: 'run_mcp_action_plan',
      description: 'Preview or run a small ordered batch of approved ComfyStudio MCP write actions. Use this when an agent has already planned several safe steps and wants one checkpointed apply pass. Defaults to previewOnly.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'Ordered MCP write-tool steps. Each step accepts tool/name/action and arguments/payload.',
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string', description: 'MCP write tool name, e.g. set_playhead, add_text_clip, add_shape_clip.' },
                name: { type: 'string', description: 'Alias for tool.' },
                action: { type: 'string', description: 'Alias for tool.' },
                arguments: { type: 'object', description: 'Tool arguments.' },
                payload: { type: 'object', description: 'Alias for arguments.' },
              },
            },
          },
          label: { type: 'string', description: 'Optional label for the plan/checkpoint.' },
          createCheckpointFirst: { type: 'boolean', description: 'Create an in-memory checkpoint before applying. Defaults to true.' },
          stopOnError: { type: 'boolean', description: 'Stop applying after the first failed step. Defaults to true.' },
          previewOnly: { type: 'boolean', description: 'When true, validates and returns the plan without running it. Defaults to true.' },
        },
        required: ['steps'],
      },
    },
    {
      name: 'set_in_out_range',
      description: 'Set, preview, or clear the active timeline In/Out range. Useful before export_timeline/export_delivery_batch when the user asks for only part of the edit.',
      inputSchema: {
        type: 'object',
        properties: {
          startSeconds: { type: 'number', description: 'In point in seconds.' },
          endSeconds: { type: 'number', description: 'Out point in seconds.' },
          start: { oneOf: [{ type: 'number' }, { type: 'string' }], description: 'Alias for startSeconds or a timecode string.' },
          end: { oneOf: [{ type: 'number' }, { type: 'string' }], description: 'Alias for endSeconds or a timecode string.' },
          durationSeconds: { type: 'number', description: 'Duration from start to out, or backward from out to in.' },
          fromSelection: { type: 'boolean', description: 'Set range to cover the currently selected timeline clips.' },
          clear: { type: 'boolean', description: 'Clear both In and Out points.' },
          clearIn: { type: 'boolean', description: 'Clear only the In point.' },
          clearOut: { type: 'boolean', description: 'Clear only the Out point.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the range plan without changing In/Out points.' },
        },
      },
    },
    {
      name: 'create_project',
      description: 'Preview or create a new ComfyStudio project in the configured Projects folder. Applying opens the new empty project. Defaults to previewOnly so agents cannot accidentally create folders without approval.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name for the new project folder/project.',
          },
          projectName: {
            type: 'string',
            description: 'Alias for name.',
          },
          title: {
            type: 'string',
            description: 'Alias for name.',
          },
          width: {
            type: 'integer',
            description: 'Optional project width. Defaults to ComfyStudio new-project defaults.',
          },
          height: {
            type: 'integer',
            description: 'Optional project height. Defaults to ComfyStudio new-project defaults.',
          },
          fps: {
            type: 'number',
            description: 'Optional project frame rate. Defaults to ComfyStudio new-project defaults.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the project creation plan without creating a folder. Defaults to true.',
          },
        },
      },
    },
    {
      name: 'duplicate_project',
      description: 'Preview or duplicate a ComfyStudio project folder. Defaults to the current open project, copies the whole folder, remaps saved paths, creates a sibling copy, and opens the duplicate on apply.',
      inputSchema: {
        type: 'object',
        properties: {
          sourceProjectPath: {
            type: 'string',
            description: 'Optional absolute path to the source project folder. Defaults to the current open project.',
          },
          projectPath: {
            type: 'string',
            description: 'Alias for sourceProjectPath.',
          },
          path: {
            type: 'string',
            description: 'Alias for sourceProjectPath.',
          },
          sourceProjectName: {
            type: 'string',
            description: 'Optional recent-project name to duplicate if no path is supplied.',
          },
          projectName: {
            type: 'string',
            description: 'Alias for sourceProjectName.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the duplicate plan without copying any folder. Defaults to true.',
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
      name: 'move_unused_assets_to_folder',
      description: 'Preview or move unused project assets into an asset-panel folder without deleting files. Checks all saved project timelines plus the live active timeline, then moves only assets not referenced by any clip/effect metadata. Defaults to previewOnly.',
      inputSchema: {
        type: 'object',
        properties: {
          targetFolderPath: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'Destination folder path. Defaults to "Unused Assets". Missing folders are created on apply.',
          },
          folderPath: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'Alias for targetFolderPath.',
          },
          targetFolderId: { type: 'string', description: 'Existing destination folder ID.' },
          targetRoot: { type: 'boolean', description: 'Move matching unused assets back to the asset root instead of a folder.' },
          rootOnly: { type: 'boolean', description: 'Only consider currently-root-level unused assets.' },
          type: { type: 'string', description: 'Optional asset type filter such as image, video, or audio.' },
          nameIncludes: { type: 'string', description: 'Optional case-insensitive name substring filter.' },
          workflowId: { type: 'string', description: 'Optional workflow ID filter.' },
          filter: {
            type: 'string',
            enum: ['solid_colors', 'constants', 'generated', 'imported'],
            description: 'Optional preset filter. Use constants/solid_colors for MCP-created color constants.',
          },
          constantsOnly: { type: 'boolean', description: 'Only include solid color/constant assets.' },
          solidColorsOnly: { type: 'boolean', description: 'Alias for constantsOnly.' },
          targetFolderColor: { type: 'string', description: 'Optional #RRGGBB color for a newly-created destination folder.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the exact unused-asset move plan without changing the project. Defaults to true.' },
          limit: { type: 'integer', description: 'Maximum assets this call may move. Defaults to 100.' },
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
      name: 'update_track',
      description: 'Preview or update an existing timeline track: rename it, mute/unmute, lock/unlock, show/hide, change audio channels, or reorder within its video/audio group. Undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          trackId: { type: 'string', description: 'Track ID from get_timeline.' },
          name: { type: 'string', description: 'Optional new track name.' },
          muted: { type: 'boolean', description: 'Mute/unmute the track.' },
          locked: { type: 'boolean', description: 'Lock/unlock the track.' },
          visible: { type: 'boolean', description: 'Show/hide the track.' },
          channels: { type: 'string', enum: ['mono', 'stereo'], description: 'Audio channel layout for audio tracks.' },
          index: { type: 'integer', description: 'Optional new index within the track type group. For video, 0 is the top video layer.' },
          newIndex: { type: 'integer', description: 'Alias for index.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the track update plan without changing the timeline. Defaults to true.' },
        },
        required: ['trackId'],
      },
    },
    {
      name: 'remove_track',
      description: 'Preview or remove a timeline track and all clips on it. ComfyStudio protects the last track of each type. Use previewOnly first.',
      inputSchema: {
        type: 'object',
        properties: {
          trackId: { type: 'string', description: 'Track ID from get_timeline.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the removal plan without changing the timeline. Defaults to true.' },
        },
        required: ['trackId'],
      },
    },
    {
      name: 'switch_timeline',
      description: 'Preview or switch the active ComfyStudio sequence/timeline. Useful when an agent creates review timelines and then needs to work inside one.',
      inputSchema: {
        type: 'object',
        properties: {
          timelineId: { type: 'string', description: 'Timeline ID from get_project or get_timeline.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the switch plan without changing the active timeline. Defaults to true.' },
        },
        required: ['timelineId'],
      },
    },
    {
      name: 'rename_timeline',
      description: 'Preview or rename a sequence/timeline. Undoable through project history/save state.',
      inputSchema: {
        type: 'object',
        properties: {
          timelineId: { type: 'string', description: 'Timeline ID from get_project.' },
          name: { type: 'string', description: 'New sequence name.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the rename plan without changing the project. Defaults to true.' },
        },
        required: ['timelineId', 'name'],
      },
    },
    {
      name: 'duplicate_timeline',
      description: 'Preview or duplicate an existing sequence/timeline, optionally rename it and switch to it. Useful before risky AI edits.',
      inputSchema: {
        type: 'object',
        properties: {
          timelineId: { type: 'string', description: 'Timeline ID to duplicate. Defaults should be supplied by the agent from get_project/get_timeline.' },
          name: { type: 'string', description: 'Optional name for the duplicate.' },
          switchToTimeline: { type: 'boolean', description: 'When true, make the duplicate active after creating it.' },
          activate: { type: 'boolean', description: 'Alias for switchToTimeline.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the duplicate plan without changing the project. Defaults to true.' },
        },
        required: ['timelineId'],
      },
    },
    {
      name: 'delete_timeline',
      description: 'Preview or delete a sequence/timeline from the project. Destructive; use previewOnly first.',
      inputSchema: {
        type: 'object',
        properties: {
          timelineId: { type: 'string', description: 'Timeline ID to delete.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the delete plan without changing the project. Defaults to true.' },
        },
        required: ['timelineId'],
      },
    },
    {
      name: 'add_transition',
      description: 'Preview or add a native ComfyStudio transition. Use clipAId+clipBId for a between-clips transition on the same track, or clipId+edge for an in/out edge transition. Undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          clipAId: { type: 'string', description: 'First clip ID for a between-clips transition.' },
          clipBId: { type: 'string', description: 'Second clip ID for a between-clips transition.' },
          clipId: { type: 'string', description: 'Single clip ID for an edge transition.' },
          edge: { type: 'string', enum: ['in', 'out'], description: 'Edge for a single-clip transition. Defaults to in.' },
          transitionType: { type: 'string', enum: ['dissolve', 'fade-black', 'fade-white', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom-in', 'zoom-out', 'blur'], description: 'Transition type. Defaults to dissolve for between clips.' },
          type: { type: 'string', description: 'Alias for transitionType.' },
          durationSeconds: { type: 'number', description: 'Transition duration in seconds. Defaults to 0.5.' },
          duration: { type: 'number', description: 'Alias for durationSeconds.' },
          alignment: { type: 'string', enum: ['start', 'center', 'end'], description: 'Between-transition alignment. Defaults to center.' },
          settings: { type: 'object', description: 'Optional transition settings such as zoomAmount, blurAmount, split, or alignment.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the transition plan without changing the timeline. Defaults to true.' },
        },
      },
    },
    {
      name: 'update_transition',
      description: 'Preview or update a native transition type, duration, alignment, or settings. Undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          transitionId: { type: 'string', description: 'Transition ID from get_timeline includeTransitions=true.' },
          transitionType: { type: 'string', enum: ['dissolve', 'fade-black', 'fade-white', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom-in', 'zoom-out', 'blur'], description: 'Optional new transition type.' },
          type: { type: 'string', description: 'Alias for transitionType.' },
          durationSeconds: { type: 'number', description: 'Optional duration in seconds.' },
          duration: { type: 'number', description: 'Alias for durationSeconds.' },
          alignment: { type: 'string', enum: ['start', 'center', 'end'], description: 'Optional between-transition alignment.' },
          settings: { type: 'object', description: 'Optional transition settings.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the update plan without changing the timeline. Defaults to true.' },
        },
        required: ['transitionId'],
      },
    },
    {
      name: 'remove_transitions',
      description: 'Preview or remove one or more native ComfyStudio transitions. Undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          transitionId: { type: 'string', description: 'Single transition ID.' },
          transitionIds: { type: 'array', items: { type: 'string' }, description: 'Transition IDs to remove.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the removal plan without changing the timeline. Defaults to true.' },
        },
      },
    },
    {
      name: 'move_clips',
      description: 'Preview or move one or more clips to a track and/or start time. Use for AI timeline layout cleanup, review lanes, and repositioning generated assets. Undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Single clip ID to move.' },
          clips: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                clipId: { type: 'string' },
                trackId: { type: 'string' },
                startSeconds: { type: 'number' },
              },
            },
            description: 'Batch move entries.',
          },
          trackId: { type: 'string', description: 'Target track ID for a single move or shared batch target.' },
          startSeconds: { type: 'number', description: 'Target start time in seconds for a single move.' },
          startTime: { type: 'number', description: 'Alias for startSeconds.' },
          resolveOverlaps: { type: 'boolean', description: 'When true, use ComfyStudio overwrite/overlap resolution. Defaults to false.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the move plan without changing the timeline. Defaults to true.' },
        },
      },
    },
    {
      name: 'trim_clips',
      description: 'Preview or update clip timing/trim values for one or more clips. Supports startSeconds, durationSeconds, trimStartSeconds, and trimEndSeconds. Undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Single clip ID to trim.' },
          clips: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                clipId: { type: 'string' },
                startSeconds: { type: 'number' },
                durationSeconds: { type: 'number' },
                trimStartSeconds: { type: 'number' },
                trimEndSeconds: { type: 'number' },
              },
            },
            description: 'Batch trim entries.',
          },
          startSeconds: { type: 'number', description: 'New clip start time for a single clip.' },
          durationSeconds: { type: 'number', description: 'New clip duration for a single clip.' },
          trimStartSeconds: { type: 'number', description: 'New source trim start for a single clip.' },
          trimEndSeconds: { type: 'number', description: 'New source trim end for a single clip.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the trim plan without changing the timeline. Defaults to true.' },
        },
      },
    },
    {
      name: 'delete_clips',
      description: 'Preview or delete timeline clips by ID or simple filter. Supports ripple delete. Destructive but undoable in ComfyStudio; use previewOnly first.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Single clip ID to delete.' },
          clipIds: { type: 'array', items: { type: 'string' }, description: 'Clip IDs to delete.' },
          filter: { type: 'string', enum: ['disabled', 'selected', 'labeled'], description: 'Optional delete target filter.' },
          ripple: { type: 'boolean', description: 'When true, ripple-delete the target clips and close gaps on their tracks.' },
          limit: { type: 'integer', description: 'Safety limit for matched clips. Defaults to 100.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the delete plan without changing the timeline. Defaults to true.' },
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
      name: 'replace_clip_with_asset',
      description: 'Preview or replace an existing video/image/audio timeline clip with another project asset while preserving its timeline slot, transform, label color, effects, and keyframes by default. The old asset is not deleted. Defaults to previewOnly and is undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Timeline clip ID to replace. If omitted, ComfyStudio must have exactly one selected clip.' },
          targetClipId: { type: 'string', description: 'Alias for clipId.' },
          assetId: { type: 'string', description: 'Replacement asset ID from get_assets.' },
          replacementAssetId: { type: 'string', description: 'Alias for assetId.' },
          assetName: { type: 'string', description: 'Replacement asset name or partial name if assetId is omitted.' },
          replacementAssetName: { type: 'string', description: 'Alias for assetName.' },
          latestGenerated: { type: 'boolean', description: 'When true, use the newest matching generated asset if assetId/assetName are omitted.' },
          type: { type: 'string', enum: ['video', 'image', 'audio'], description: 'Optional replacement asset type filter.' },
          assetType: { type: 'string', enum: ['video', 'image', 'audio'], description: 'Alias for type.' },
          workflowId: { type: 'string', description: 'Optional workflow ID filter when resolving latestGenerated, such as ltx23-i2v or wan22-i2v.' },
          name: { type: 'string', description: 'Optional new clip name. Defaults to the replacement asset name.' },
          preserveDuration: { type: 'boolean', description: 'Keep the original timeline duration. Defaults to true.' },
          fitToAssetDuration: { type: 'boolean', description: 'When true, change the timeline duration to the replacement asset duration when known.' },
          resetTrim: { type: 'boolean', description: 'Reset source in/out to the start of the replacement asset. Defaults to true.' },
          preserveTrim: { type: 'boolean', description: 'Alias for resetTrim=false.' },
          durationSeconds: { type: 'number', description: 'Optional replacement duration when preserveDuration=false.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the replacement plan without changing the timeline. Defaults to true.' },
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
      name: 'add_adjustment_clip',
      description: 'Preview or create a ComfyStudio adjustment clip on a video track. Adjustment clips apply color/blur/GLSL/keyframed effects to clips below them. Use previewOnly first; applying is undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Optional adjustment clip name. Defaults to Adjustment Layer.' },
          trackId: { type: 'string', description: 'Optional existing video track ID. Defaults to the first unlocked video track unless createTrack is true.' },
          createTrack: { type: 'boolean', description: 'When true and trackId is omitted, create a new top video track for the adjustment clip.' },
          newTrack: { type: 'boolean', description: 'Alias for createTrack.' },
          trackName: { type: 'string', description: 'Optional new top video track name when createTrack is true.' },
          trackStrategy: { type: 'string', enum: ['existing', 'new', 'newTopTrack'], description: 'Use new/newTopTrack to create a new top video track.' },
          startSeconds: { type: 'number', description: 'Timeline start time in seconds. Defaults to current playhead.' },
          startTime: { type: 'number', description: 'Alias for startSeconds.' },
          durationSeconds: { type: 'number', description: 'Clip duration in seconds. Defaults to 5.' },
          duration: { type: 'number', description: 'Alias for durationSeconds.' },
          enabled: { type: 'boolean', description: 'Whether the new adjustment clip is enabled. Defaults to true.' },
          adjustments: {
            type: 'object',
            description: 'Initial color/blur settings. Global keys: brightness, contrast, saturation, gain, gamma, offset, hue, blur. Tonal groups: shadows, midtones, highlights.',
          },
          brightness: { type: 'number', description: 'Exposure/brightness, -100 to 100.' },
          contrast: { type: 'number', description: 'Contrast, -100 to 100.' },
          saturation: { type: 'number', description: 'Saturation, -100 to 100.' },
          gain: { type: 'number', description: 'Gain, -100 to 100.' },
          gamma: { type: 'number', description: 'Gamma, -100 to 100.' },
          offset: { type: 'number', description: 'Offset, -100 to 100.' },
          hue: { type: 'number', description: 'Hue rotation in degrees, -180 to 180.' },
          blur: { type: 'number', description: 'Adjustment blur amount in pixels, 0 to 50.' },
          shadows: { type: 'object', description: 'Optional shadows tonal adjustment group.' },
          midtones: { type: 'object', description: 'Optional midtones tonal adjustment group.' },
          highlights: { type: 'object', description: 'Optional highlights tonal adjustment group.' },
          transform: {
            type: 'object',
            description: 'Optional transform for the adjustment layer itself: opacity, blendMode, position, scale, rotation, blur, crop, 2.5D, or motion blur fields.',
          },
          keyframes: {
            type: 'array',
            description: 'Optional explicit visual keyframes for transform, opacity, blur, crop, and color adjustment properties. For GLSL effects on the adjustment clip, create the clip first, then use add_glsl_effect/update_glsl_effect.',
            items: {
              type: 'object',
              properties: {
                property: { type: 'string', enum: MCP_CLIP_KEYFRAME_PROPERTIES },
                timeSeconds: { type: 'number', description: 'Clip-relative keyframe time in seconds.' },
                value: { type: 'number' },
                easing: { type: 'string', description: 'Easing name or cubicBezier(x1,y1,x2,y2).' },
              },
              required: ['property', 'timeSeconds', 'value'],
            },
          },
          replaceKeyframes: { type: 'boolean', description: 'When true, replace existing keyframes for properties included in keyframes.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the creation plan without changing the timeline. Defaults to true.' },
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
      name: 'list_glsl_effects',
      description: 'List the GLSL/GPU-backed clip effects ComfyStudio can add through MCP, including supported parameter keys, ranges, defaults, and presets. Use this before adding or changing GLSL effects.',
      inputSchema: {
        type: 'object',
        properties: {
          includeParams: { type: 'boolean', description: 'Include parameter definitions. Defaults to true.' },
          includePresets: { type: 'boolean', description: 'Include presets. Defaults to true.' },
        },
      },
    },
    {
      name: 'add_glsl_effect',
      description: 'Add a GLSL/GPU-backed effect to a visual clip. Supports presets, static parameter settings, and optional effect-parameter keyframes. Defaults to previewOnly; applying is undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Target visual clip ID from get_timeline. If omitted, uses the single selected visual clip.' },
          effectType: { type: 'string', enum: MCP_GLSL_EFFECT_IDS, description: 'GLSL effect type to add. Use list_glsl_effects for parameters and presets.' },
          presetId: { type: 'string', description: 'Optional preset ID or label for the chosen effect.' },
          settings: {
            type: 'object',
            description: 'Effect parameter values by key, such as { amount: 40 }, { speed: 8 }, { samples: 16 }, or { look: 3 }. Unknown keys are rejected.',
          },
          enabled: { type: 'boolean', description: 'Whether the new effect starts enabled. Defaults to true.' },
          replaceExisting: { type: 'boolean', description: 'When true, remove existing effects of the same type on this clip before adding the new one.' },
          insertIndex: { type: 'integer', description: 'Optional effect stack index. Defaults to the end/top of the stack.' },
          keyframes: {
            type: 'array',
            description: 'Optional effect-parameter keyframes. property/param must be one of the effect settings from list_glsl_effects.',
            items: {
              type: 'object',
              properties: {
                param: { type: 'string', description: 'Effect parameter key, e.g. amount, speed, motionBlur, blend, or scanlines.' },
                property: { type: 'string', description: 'Alias for param.' },
                timeSeconds: { type: 'number', description: 'Clip-relative keyframe time in seconds.' },
                value: { type: 'number' },
                easing: { type: 'string' },
              },
              required: ['timeSeconds', 'value'],
            },
          },
          replaceKeyframes: { type: 'boolean', description: 'When true, replace existing keyframes for the included effect parameters.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the add plan without changing the timeline. Defaults to true.' },
        },
        required: ['effectType'],
      },
    },
    {
      name: 'update_glsl_effect',
      description: 'Update an existing GLSL effect on a visual clip: enabled state, preset, static settings, or effect-parameter keyframes. Identify the target by effectId, or by effectType if only one/latest matching effect is intended. Defaults to previewOnly; applying is undoable.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Target visual clip ID from get_timeline. If omitted, uses the single selected visual clip.' },
          effectId: { type: 'string', description: 'Existing effect ID from get_timeline/inspect_clip.' },
          effectType: { type: 'string', enum: MCP_GLSL_EFFECT_IDS, description: 'Fallback target selector. If multiple effects of this type exist, the latest one is updated.' },
          presetId: { type: 'string', description: 'Optional preset ID or label to merge into settings before explicit settings.' },
          settings: {
            type: 'object',
            description: 'Effect parameter updates by key. Unknown keys are rejected.',
          },
          enabled: { type: 'boolean', description: 'Set enabled/disabled state for the effect.' },
          keyframes: {
            type: 'array',
            description: 'Optional effect-parameter keyframes. property/param must be one of the effect settings from list_glsl_effects.',
            items: {
              type: 'object',
              properties: {
                param: { type: 'string', description: 'Effect parameter key.' },
                property: { type: 'string', description: 'Alias for param.' },
                timeSeconds: { type: 'number', description: 'Clip-relative keyframe time in seconds.' },
                value: { type: 'number' },
                easing: { type: 'string' },
              },
              required: ['timeSeconds', 'value'],
            },
          },
          clearKeyframes: {
            oneOf: [
              { type: 'boolean' },
              { type: 'string', enum: ['all'] },
              { type: 'array', items: { type: 'string' } },
            ],
            description: 'Clear all or selected effect-parameter keyframes before applying new ones.',
          },
          replaceKeyframes: { type: 'boolean', description: 'When true, replace existing keyframes for the included effect parameters.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the update plan without changing the timeline. Defaults to true.' },
        },
      },
    },
    {
      name: 'remove_glsl_effect',
      description: 'Remove an existing GLSL effect from a visual clip and clear its effect-parameter keyframes. Identify the target by effectId, or by effectType when there is one/latest matching effect. Defaults to previewOnly; applying is undoable.',
      inputSchema: {
        type: 'object',
        properties: {
          clipId: { type: 'string', description: 'Target visual clip ID from get_timeline. If omitted, uses the single selected visual clip.' },
          effectId: { type: 'string', description: 'Existing effect ID from get_timeline/inspect_clip.' },
          effectType: { type: 'string', enum: MCP_GLSL_EFFECT_IDS, description: 'Fallback target selector.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the removal plan without changing the timeline. Defaults to true.' },
        },
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
      name: 'add_dip_to_black',
      description: 'Preview or apply dip-to-black opacity fades between adjacent visual clips. Accepts explicit clip pairs, a clipIds list, selected clips, or all adjacent clips on a track. This only writes opacity keyframes; use add_solid_color first if a black plate is needed underneath. Defaults to previewOnly and is undoable in ComfyStudio.',
      inputSchema: {
        type: 'object',
        properties: {
          clipPairs: {
            type: 'array',
            description: 'Explicit clip pairs. Each item can use outClipId/inClipId or clipAId/clipBId.',
            items: {
              type: 'object',
              properties: {
                outClipId: { type: 'string' },
                inClipId: { type: 'string' },
                clipAId: { type: 'string' },
                clipBId: { type: 'string' },
              },
            },
          },
          pairs: {
            type: 'array',
            description: 'Alias for clipPairs.',
            items: { type: 'object' },
          },
          clipIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Clips to pair in timeline order. Each adjacent pair gets a dip.',
          },
          trackId: { type: 'string', description: 'When clipIds are omitted, apply to adjacent visual clips on this track.' },
          filter: { type: 'string', enum: ['selected', 'track'], description: 'Use selected clips or the requested track.' },
          selected: { type: 'boolean', description: 'When true and clipIds are omitted, use selected clips.' },
          allAdjacent: { type: 'boolean', description: 'When true, build pairs from all adjacent visual clips, optionally limited by trackId.' },
          durationSeconds: { type: 'number', description: 'Fade duration for each side of the dip. Defaults to 0.5 seconds.' },
          fadeDurationSeconds: { type: 'number', description: 'Alias for durationSeconds.' },
          easing: { type: 'string', description: 'Easing for the opacity keyframes. Defaults to easeInOut.' },
          replaceOpacityKeyframes: { type: 'boolean', description: 'When true, clear existing opacity keyframes on affected clips before applying the dip.' },
          previewOnly: { type: 'boolean', description: 'When true, returns the opacity keyframe plan without changing the timeline. Defaults to true.' },
        },
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
    {
      name: 'export_fcpxml',
      description: 'Preview or export the active ComfyStudio timeline as Final Cut Pro XML for Resolve, Final Cut, or Premiere interchange. Writes to the project renders folder unless outputPath is provided.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Optional output filename without extension. Defaults to project_timeline_timestamp.',
          },
          outputPath: {
            type: 'string',
            description: 'Optional absolute .fcpxml output path. If omitted, writes to the project renders folder.',
          },
          previewOnly: {
            type: 'boolean',
            description: 'When true, returns the FCPXML export plan without writing a file. Defaults to true.',
          },
        },
      },
    },
    {
      name: 'export_delivery_batch',
      description: 'Preview or run several delivery exports in sequence, such as 16:9, 1:1 square, and 9:16 vertical versions of the same range. Each target uses the normal export_timeline worker and readiness checks. Defaults to previewOnly.',
      inputSchema: {
        type: 'object',
        properties: {
          targets: {
            type: 'array',
            description: 'Delivery target entries. Items can be strings like h264_720p, h264_square_720, h264_vertical_720, 16:9, 1:1, or objects with export_timeline settings.',
            items: {
              oneOf: [
                { type: 'string' },
                { type: 'object' },
              ],
            },
          },
          presets: {
            type: 'array',
            items: { type: 'string' },
            description: 'Alias for targets when using string target names.',
          },
          range: { type: 'string', enum: ['full', 'custom'], description: 'Shared export range. Defaults to full.' },
          startSeconds: { type: 'number', description: 'Shared custom range start.' },
          endSeconds: { type: 'number', description: 'Shared custom range end.' },
          includeAudio: { type: 'boolean', description: 'Shared include-audio setting. Defaults to true.' },
          videoCodec: { type: 'string', enum: ['h264', 'h265'], description: 'Shared video codec. Defaults to h264.' },
          crf: { type: 'number', description: 'Shared CRF quality. Defaults to export_timeline behavior.' },
          useHardwareEncoder: { type: 'boolean', description: 'Shared hardware encoder setting.' },
          deliveryFraming: { type: 'string', enum: ['fit', 'fill', 'center_crop'], description: 'Shared framing override. Square/vertical targets default to fill.' },
          filenamePrefix: { type: 'string', description: 'Optional filename prefix for every export. Target suffixes are appended automatically.' },
          previewOnly: { type: 'boolean', description: 'When true, returns all export plans without rendering. Defaults to true.' },
          stopOnError: { type: 'boolean', description: 'When true, stop the batch if one export fails. Defaults to true.' },
          limit: { type: 'integer', description: 'Maximum number of exports. Defaults to 6, max 12.' },
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
            instructions: 'You are connected to ComfyStudio. Use guide_comfyui_setup first for beginner local ComfyUI setup questions like "How do I connect ComfyStudio to ComfyUI?"; it diagnoses, probes likely ports, gives Portable/Desktop/Docker/manual steps, and previews safe port fixes. Use diagnose_comfyui_connection, repair_comfyui_connection, set_comfyui_connection, control_comfyui_launcher, get_comfyui_launcher_logs, validate_comfyui_nodes, list_comfystudio_workflows, and inspect_comfystudio_workflow for deeper local ComfyUI setup/support questions. Use get_mcp_recipes or get_ai_review_passes to choose safe review workflows. Use find_timeline_items before targeting timeline clips, tracks, markers, transitions, or project assets from a natural-language request. Use check_media_health before delivery/relinking work, relink_asset with previewOnly before changing asset paths, and inspect_export_file after rendering when the user asks whether a file exists or has the expected codec, duration, FPS, or dimensions. Use run_mcp_action_plan with previewOnly before applying an approved multi-step edit in one checkpointed pass. Use the tools to inspect the open project, timeline, assets, generation status, music-video workflow state, the composed timeline frame at the playhead, sampled visual timeline ranges, and top-visible shot pages for fast-cut edit review. Use create_project with previewOnly first when the user wants a fresh ComfyStudio project, and use duplicate_project with previewOnly first before risky AI experiments on an existing project. Use create_timeline with previewOnly first when the user wants a new sequence/timeline for an alternate edit, review selects, generated variations, or a fresh AI-built layout; use switch_timeline, rename_timeline, duplicate_timeline, and delete_timeline with previewOnly first for sequence management. Use update_track and remove_track with previewOnly first for track cleanup, locking/muting/showing tracks, renaming, and layer order. Use add_transition, update_transition, and remove_transitions with previewOnly first for native dissolves, fades, wipes, slides, zooms, blur transitions, and dip-to-black style edits. Use move_clips, trim_clips, and delete_clips with previewOnly first for timeline edit operations such as cleanup passes, staggered layouts, trims, and ripple deletes. Use create_asset_folder with previewOnly first when a generation batch or AI-built layout should keep its source assets organized in a named/nested asset folder. Use move_assets_to_folder with previewOnly first when assets should be cleaned up or moved into a folder, for example rootOnly + constantsOnly into a Constants folder. Use queue_prompt_generation_batch with previewOnly first when the user wants new images or videos generated from a written brief; show prompts, workflows, counts, seeds, resolution, duration, FPS, and output folder, then apply only after approval. Use prepare_generation_from_timeline_context with previewOnly first when the user wants to turn a timeline frame into a Generate-tab image-to-video or keyframe request; applying it only captures the frame and prefills Generate. Use queue_prepared_generation with previewOnly first and explicit user approval before queueing a staged Generate request. Use queue_timeline_generation_batch with previewOnly first when the user asks for multiple variations or multiple workflows from the same timeline frame; show workflow counts and seeds, then apply only after approval. Use add_asset_to_timeline with previewOnly first when the user wants one generated/imported asset placed back into the edit, or add_assets_to_timeline with previewOnly first when placing multiple results as review lanes or a sequential strip. Use add_solid_color with previewOnly first when the user needs black/color constants or background plates; it can create a bottom video track so solids sit behind the edit. Use add_adjustment_clip with previewOnly first when the user wants a color look, blur, GLSL effect, camera shake, vignette, grain, or keyframed treatment applied to multiple clips below a single adjustment layer. Use add_text_clip, add_shape_clip, update_text_clip, and update_shape_clip with previewOnly first for titles, lower thirds, lines, boxes, circles, frames, graphic accents, and simple motion graphics; use motionBlurEnabled/motionBlurSamples/motionBlurShutter on fast animated layers when requested. Use list_glsl_effects, add_glsl_effect, update_glsl_effect, and remove_glsl_effect with previewOnly first for GPU effects such as camera shake, directional blur, lens blur, fisheye, chroma warp, digital glitch, film grain, film look, flicker, VHS, and vignette; effect parameters can also be keyframed, including when the target clip is an adjustment clip. Use set_clip_keyframes with previewOnly first for visual clip fades, dips to black, moves, blur, crop reveals, and color/transform/shape style automation. Use export_fcpxml with previewOnly first when the user wants an interchange XML for Resolve, Final Cut, or Premiere. Queue tools use the same path as the ComfyStudio Queue button and may spend credits or start local GPU work depending on the selected workflow. The write actions currently exposed are ComfyUI setup guidance/settings, ComfyUI launcher start/stop/restart, project creation/duplication, asset folder creation, asset folder cleanup/move/relink operations, sequence/timeline creation and management, track management, native transitions, clip move/trim/delete operations, clip label coloring, clip enable/disable, timeline marker creation/removal/property updates, text/title/shape/adjustment clip creation and updates, GLSL effect add/update/remove operations, visual clip keyframes, solid color asset/clip creation, media asset placement, prompt-based generation queueing, preparing/queueing Generate from a timeline frame, checkpointed multi-step action plans, starting timeline delivery exports through ComfyStudio export worker, export-file QC, and FCPXML interchange export. Project creation/duplication writes project folders on disk; timeline/sequence, clip/marker/text/shape/adjustment/effect/media/keyframe actions are undoable in ComfyStudio; exports write new files to disk.',
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
      'list_recent_projects',
      'open_project',
      'diagnose_comfyui_connection',
      'set_comfyui_connection',
      'repair_comfyui_connection',
      'guide_comfyui_setup',
      'control_comfyui_launcher',
      'get_comfyui_launcher_logs',
      'validate_comfyui_nodes',
      'list_comfystudio_workflows',
      'inspect_comfystudio_workflow',
      'list_glsl_effects',
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
      case 'get_mcp_recipes':
        return textResult(buildAiReviewPasses(snapshot))
      case 'find_timeline_items': {
        const result = findTimelineItems(snapshot, args)
        return result.error ? errorResult(result.error) : textResult(result)
      }
      case 'check_media_health':
        return textResult(checkMediaHealth(snapshot, args))
      case 'inspect_export_file': {
        const result = inspectExportFile(snapshot, args)
        return result.error ? errorResult(result.error) : textResult(result)
      }
      case 'diagnose_comfyui_connection':
        return this.runComfyUIConnectionDiagnosis(args)
      case 'set_comfyui_connection':
        return this.setComfyUIConnectionTool(args)
      case 'repair_comfyui_connection':
        return this.repairComfyUIConnection(args)
      case 'guide_comfyui_setup':
        return this.guideComfyUISetup(args)
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
      case 'list_recent_projects':
        return this.runRendererActionTool('list_recent_projects', args, { bridgeName: 'MCP project bridge', suggestedTool: 'list_recent_projects' })
      case 'open_project':
        return this.runRendererActionTool('open_project', args, { bridgeName: 'MCP project bridge', suggestedTool: 'open_project', defaultPreviewOnly: true })
      case 'transcribe_captions':
        return this.runRendererActionTool('transcribe_captions', args, { bridgeName: 'MCP captions bridge', suggestedTool: 'transcribe_captions', defaultPreviewOnly: true })
      case 'get_caption_status':
        return this.runRendererActionTool('get_caption_status', args, { bridgeName: 'MCP captions bridge', suggestedTool: 'get_caption_status' })
      case 'update_caption_cues':
        return this.runRendererActionTool('update_caption_cues', args, { bridgeName: 'MCP captions bridge', suggestedTool: 'update_caption_cues' })
      case 'generate_captions':
        return this.runRendererActionTool('generate_captions', args, { bridgeName: 'MCP captions bridge', suggestedTool: 'generate_captions', defaultPreviewOnly: true })
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
      case 'undo':
        return this.runRendererActionTool('undo', args, { bridgeName: 'MCP undo bridge', suggestedTool: 'undo' })
      case 'redo':
        return this.runRendererActionTool('redo', args, { bridgeName: 'MCP redo bridge', suggestedTool: 'redo' })
      case 'set_playhead':
        return this.runRendererActionTool('set_playhead', args, { bridgeName: 'MCP playhead bridge', suggestedTool: 'set_playhead' })
      case 'select_clips':
        return this.runRendererActionTool('select_clips', args, { bridgeName: 'MCP clip selection bridge', suggestedTool: 'select_clips' })
      case 'select_assets':
        return this.runRendererActionTool('select_assets', args, { bridgeName: 'MCP asset selection bridge', suggestedTool: 'select_assets' })
      case 'create_project_checkpoint':
        return this.runRendererActionTool('create_project_checkpoint', args, { bridgeName: 'MCP checkpoint bridge', suggestedTool: 'create_project_checkpoint' })
      case 'restore_project_checkpoint':
        return this.runRendererActionTool('restore_project_checkpoint', args, { bridgeName: 'MCP checkpoint bridge', suggestedTool: 'restore_project_checkpoint', defaultPreviewOnly: true })
      case 'import_asset_from_path':
        return this.runRendererActionTool('import_asset_from_path', args, { bridgeName: 'MCP asset import bridge', suggestedTool: 'import_asset_from_path', defaultPreviewOnly: true })
      case 'relink_asset':
        return this.runRendererActionTool('relink_asset', args, { bridgeName: 'MCP asset relink bridge', suggestedTool: 'relink_asset', defaultPreviewOnly: true })
      case 'set_clip_style':
        return this.runRendererActionTool('set_clip_style', args, { bridgeName: 'MCP clip style bridge', suggestedTool: 'set_clip_style', defaultPreviewOnly: true })
      case 'run_mcp_action_plan':
        return this.runMcpActionPlan(snapshot, args)
      case 'set_in_out_range':
        return this.runRendererActionTool('set_in_out_range', args, { bridgeName: 'MCP in/out bridge', suggestedTool: 'set_in_out_range' })
      case 'create_project':
        return this.createProject(snapshot, args)
      case 'duplicate_project':
        return this.duplicateProject(snapshot, args)
      case 'create_timeline':
        return this.createTimeline(snapshot, args)
      case 'create_asset_folder':
        return this.createAssetFolder(snapshot, args)
      case 'move_assets_to_folder':
        return this.moveAssetsToFolder(snapshot, args)
      case 'move_unused_assets_to_folder':
        return this.moveUnusedAssetsToFolder(snapshot, args)
      case 'add_track':
        return this.addTrack(snapshot, args)
      case 'update_track':
        return this.updateTrack(snapshot, args)
      case 'remove_track':
        return this.removeTrack(snapshot, args)
      case 'switch_timeline':
        return this.switchTimeline(snapshot, args)
      case 'rename_timeline':
        return this.renameTimeline(snapshot, args)
      case 'duplicate_timeline':
        return this.duplicateTimeline(snapshot, args)
      case 'delete_timeline':
        return this.deleteTimeline(snapshot, args)
      case 'add_transition':
        return this.addTransition(snapshot, args)
      case 'update_transition':
        return this.updateTransition(snapshot, args)
      case 'remove_transitions':
        return this.removeTransitions(snapshot, args)
      case 'move_clips':
        return this.moveClips(snapshot, args)
      case 'trim_clips':
        return this.trimClips(snapshot, args)
      case 'delete_clips':
        return this.deleteClips(snapshot, args)
      case 'add_asset_to_timeline':
        return this.addAssetToTimeline(snapshot, args)
      case 'replace_clip_with_asset':
        return this.replaceClipWithAsset(snapshot, args)
      case 'add_solid_color':
        return this.addSolidColor(snapshot, args)
      case 'add_assets_to_timeline':
        return this.addAssetsToTimeline(snapshot, args)
      case 'add_adjustment_clip':
        return this.addAdjustmentClip(snapshot, args)
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
      case 'list_glsl_effects':
        return this.listGlslEffects(args)
      case 'add_glsl_effect':
        return this.addGlslEffect(snapshot, args)
      case 'update_glsl_effect':
        return this.updateGlslEffect(snapshot, args)
      case 'remove_glsl_effect':
        return this.removeGlslEffect(snapshot, args)
      case 'set_clip_keyframes':
        return this.setClipKeyframes(snapshot, args)
      case 'add_dip_to_black':
        return this.addDipToBlack(snapshot, args)
      case 'export_timeline':
        return this.exportTimeline(snapshot, args)
      case 'export_delivery_batch':
        return this.exportDeliveryBatch(snapshot, args)
      case 'export_fcpxml':
        return this.exportFcpXml(snapshot, args)
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

  getComfySetupInstallSteps(installType = 'unknown', diagnosis = null) {
    const configuredPort = normalizeLocalPort(diagnosis?.connection?.port) || 8188
    const mode = String(installType || 'unknown').toLowerCase()
    const commonFirstStep = `ComfyStudio connects to ComfyUI by local URL, usually http://127.0.0.1:${configuredPort}. The important thing is that the port ComfyUI prints must match Settings > ComfyUI Connection in ComfyStudio.`

    if (mode === 'portable') {
      return [
        commonFirstStep,
        'Open your ComfyUI_windows_portable folder.',
        'Run run_nvidia_gpu.bat if you have an NVIDIA GPU, or run_cpu.bat only if you must use CPU.',
        'Wait until the terminal says something like "To see the GUI go to: http://127.0.0.1:8188".',
        'Use that port in ComfyStudio Settings > ComfyUI Connection, or ask the MCP agent to apply the suggested port fix.',
        'If ComfyStudio launches ComfyUI for you, configure Settings > ComfyUI Launcher to point at that same .bat file.',
      ]
    }

    if (mode === 'desktop') {
      return [
        commonFirstStep,
        'Open ComfyUI Desktop first and wait until it is fully running.',
        'Find the local URL or port shown by ComfyUI Desktop.',
        'Set the same port in ComfyStudio Settings > ComfyUI Connection.',
        'If ComfyUI Desktop uses a different port after updates/restarts, run this setup guide again and let it repair the port mismatch.',
      ]
    }

    if (mode === 'docker') {
      return [
        commonFirstStep,
        'Make sure the Docker container publishes ComfyUI to the host, for example -p 8188:8188.',
        'Inside Docker, ComfyUI often needs to listen on 0.0.0.0 so the host can reach it.',
        'From Windows/macOS, ComfyStudio should still connect to localhost/127.0.0.1 on the published host port, not the container internal IP.',
        'If ComfyUI returns HTTP 403, relaunch it with a permissive CORS/header setup or use the ComfyStudio launcher path when possible.',
      ]
    }

    if (mode === 'manual') {
      return [
        commonFirstStep,
        'Start ComfyUI manually from your terminal before opening or using ComfyStudio generation features.',
        'Look for the URL ComfyUI prints, usually http://127.0.0.1:8188.',
        'If you deliberately use another port, set that exact port in ComfyStudio Settings > ComfyUI Connection.',
        'If ComfyStudio can see /system_stats but not /object_info, update ComfyUI and check custom-node import errors in the ComfyUI terminal.',
      ]
    }

    return [
      commonFirstStep,
      'First start ComfyUI using whichever install you have: Desktop app, Windows portable .bat file, Docker container, or manual python main.py launch.',
      'Copy the port from the local URL ComfyUI prints.',
      'If ComfyStudio is on the wrong port, the MCP guide can propose the exact port change and apply it only after approval.',
      'If you are not sure which install you have, tell the agent "I use portable", "I use desktop", "I use Docker", or "I started it manually" and run this guide again.',
    ]
  }

  buildComfySetupUserMessage({ configured, reachable, probes, installType, previewOnly, appliedFix, validation }) {
    const configuredBase = configured?.connection?.httpBase || 'the configured ComfyUI URL'
    const reachableBase = reachable?.connection?.httpBase || ''
    const portList = probes.map((probe) => `${probe.port}${probe.ok ? ' OK' : ''}`).join(', ')

    if (configured?.connection?.ok) {
      const nodeCount = configured?.api?.objectInfo?.nodeClassCount || 0
      return [
        `Good news: ComfyStudio is already connected to ComfyUI at ${configuredBase}.`,
        nodeCount ? `ComfyUI returned ${nodeCount} node classes, so the API is responding correctly.` : 'The ComfyUI API is responding.',
        validation?.validation?.checkedCount ? (
          validation.validation.ok
            ? 'The requested workflow nodes are available too.'
            : `The connection works, but these requested nodes are missing: ${(validation.validation.missing || []).join(', ')}.`
        ) : '',
        'You can now use local ComfyUI workflows from ComfyStudio.',
      ].filter(Boolean)
    }

    if (reachable) {
      return [
        `I found ComfyUI running at ${reachableBase}, but ComfyStudio is currently pointed at ${configuredBase}.`,
        previewOnly
          ? `No settings were changed. The safe fix is to set ComfyStudio's ComfyUI port to ${reachable.connection.port}.`
          : appliedFix
            ? `I updated ComfyStudio to use ${reachableBase}.`
            : `No settings were changed because applyFix was not requested.`,
        `Ports checked: ${portList}.`,
        previewOnly
          ? `Ask for approval, then call guide_comfyui_setup with applyFix=true and previewOnly=false, or call set_comfyui_connection with port ${reachable.connection.port}.`
          : 'Run diagnose_comfyui_connection again to confirm everything is healthy.',
      ]
    }

    return [
      `I could not find a reachable ComfyUI server yet. Ports checked: ${portList || 'none'}.`,
      `This usually means ComfyUI is not running, is running on a different port, or Docker/Desktop/Portable is not publishing a localhost server.`,
      `Install type assumed: ${installType}.`,
      'Start ComfyUI first, then run this guide again. If you can see the ComfyUI URL in a browser, pass its port to guide_comfyui_setup.',
    ]
  }

  async guideComfyUISetup(args = {}) {
    if (!this.diagnoseComfyUIConnection) {
      return errorResult('ComfyUI setup guidance is not available. Restart ComfyStudio and try again.')
    }

    const timeoutMs = getNumberArg(args, 'timeoutMs', 4500, 1000, 30000)
    const previewOnly = args.previewOnly !== false
    const applyFix = args.applyFix === true
    const requestedPort = normalizeLocalPort(args.port)
    const configured = await this.diagnoseComfyUIConnection({ timeoutMs })
    const configuredPort = normalizeLocalPort(configured?.connection?.port)
    const requestedCandidates = Array.isArray(args.candidatePorts) ? args.candidatePorts : []
    const candidatePorts = [...new Set([
      requestedPort,
      configuredPort,
      ...requestedCandidates,
      8188,
      8189,
      8190,
      8191,
      7860,
    ].map(normalizeLocalPort).filter(Boolean))]

    const probes = []
    let reachable = configured?.connection?.ok ? configured : null
    for (const port of candidatePorts) {
      const diagnosis = port === configuredPort
        ? configured
        : await this.diagnoseComfyUIConnection({ port, timeoutMs })
      const probe = {
        port,
        ok: Boolean(diagnosis?.connection?.ok),
        httpBase: diagnosis?.connection?.httpBase || `http://127.0.0.1:${port}`,
        summary: diagnosis?.summary || '',
        nodeClassCount: diagnosis?.api?.objectInfo?.nodeClassCount || 0,
        installMode: diagnosis?.installMode || null,
        status: diagnosis?.api?.systemStats?.status || diagnosis?.api?.objectInfo?.status || null,
        error: diagnosis?.api?.objectInfo?.error || diagnosis?.api?.systemStats?.error || '',
      }
      probes.push(probe)
      if (!reachable && diagnosis?.connection?.ok) {
        reachable = diagnosis
      }
    }

    const installTypeArg = String(args.installType || 'auto').trim().toLowerCase()
    const detectedMode = configured?.installMode?.mode || reachable?.installMode?.mode || 'unknown'
    const installType = installTypeArg && installTypeArg !== 'auto' ? installTypeArg : detectedMode
    const setupSteps = this.getComfySetupInstallSteps(installType, configured)

    let update = null
    let appliedFix = false
    const reachablePort = normalizeLocalPort(reachable?.connection?.port)
    const needsPortFix = Boolean(reachable?.connection?.ok && reachablePort && configuredPort && reachablePort !== configuredPort)
    if (needsPortFix && this.setComfyUIConnection) {
      update = await this.setComfyUIConnection({
        port: reachablePort,
        previewOnly: previewOnly || !applyFix,
      })
      appliedFix = applyFix && previewOnly === false && update?.success !== false
    }

    let validation = null
    const nodeClasses = Array.isArray(args.nodeClasses)
      ? args.nodeClasses.map((value) => String(value || '').trim()).filter(Boolean)
      : []
    if (reachable?.connection?.ok && nodeClasses.length > 0 && this.validateComfyUINodes) {
      validation = await this.validateComfyUINodes({
        port: reachablePort,
        timeoutMs,
        nodeClasses,
      })
    }

    const connected = Boolean((!needsPortFix && configured?.connection?.ok) || appliedFix)
    const summary = connected
      ? 'ComfyStudio is connected to ComfyUI.'
      : reachable
        ? 'ComfyUI is running, but ComfyStudio needs a port-setting fix.'
        : 'ComfyUI was not found on the checked local ports.'

    const result = {
      action: 'guide_comfyui_setup',
      previewOnly,
      summary,
      connected,
      needsPortFix,
      appliedFix,
      installType,
      configured: {
        summary: configured?.summary || '',
        connection: configured?.connection || null,
        api: configured?.api || null,
        launcher: configured?.launcher || null,
        installMode: configured?.installMode || null,
        recommendations: configured?.recommendations || [],
      },
      reachable: reachable ? {
        summary: reachable.summary || '',
        connection: reachable.connection || null,
        nodeClassCount: reachable?.api?.objectInfo?.nodeClassCount || 0,
      } : null,
      probes,
      proposedChange: needsPortFix ? {
        from: configured?.connection?.httpBase || null,
        to: reachable?.connection?.httpBase || null,
        port: reachablePort,
        update,
      } : null,
      setupSteps,
      validation,
      assistantMessage: this.buildComfySetupUserMessage({
        configured,
        reachable,
        probes,
        installType,
        previewOnly,
        appliedFix,
        validation,
      }),
      nextActions: connected
        ? [
          'Open Generate and run a small local workflow test.',
          'If a workflow fails, inspect that workflow with inspect_comfystudio_workflow or validate_comfyui_nodes for missing custom nodes.',
        ]
        : reachable
          ? [
            previewOnly
              ? `Ask the user for approval, then apply the safe port fix to ${reachable?.connection?.httpBase}.`
              : 'Re-run diagnose_comfyui_connection to confirm the configured port is now healthy.',
          ]
          : [
            "Start ComfyUI using the setup steps for the user's install type.",
            'If the user can open ComfyUI in a browser, ask for the port in that URL and run guide_comfyui_setup again with that port.',
          ],
    }

    return textResult(result)
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

  async runRendererActionTool(action, args = {}, options = {}) {
    const bridgeName = options.bridgeName || 'MCP action bridge'
    const suggestedTool = options.suggestedTool || action
    if (!this.performAction) {
      return errorResult(`${bridgeName} is not available. Restart ComfyStudio and try again.`)
    }
    const payload = { ...(args || {}) }
    if (typeof options.defaultPreviewOnly === 'boolean' && typeof payload.previewOnly !== 'boolean') {
      payload.previewOnly = options.defaultPreviewOnly
    }

    try {
      const result = await this.performAction({ action, payload })
      const previewOnly = result?.previewOnly === true || payload.previewOnly === true
      return textResult({
        success: previewOnly ? undefined : result?.success !== false,
        previewOnly,
        action,
        message: result?.message || (previewOnly
          ? `${suggestedTool} plan returned by ComfyStudio.`
          : `${suggestedTool} applied through ComfyStudio.`),
        result,
        suggestedApplyCall: previewOnly ? {
          tool: suggestedTool,
          arguments: {
            ...payload,
            previewOnly: false,
          },
        } : undefined,
      })
    } catch (error) {
      return errorResult(`${suggestedTool} failed: ${error?.message || String(error)}`)
    }
  }

  normalizeActionPlanSteps(args = {}) {
    const rawSteps = Array.isArray(args.steps) ? args.steps : []
    const steps = rawSteps.slice(0, MCP_ACTION_PLAN_MAX_STEPS).map((step, index) => {
      const tool = String(step?.tool || step?.name || step?.action || '').trim()
      const stepArgs = step?.arguments && typeof step.arguments === 'object'
        ? step.arguments
        : step?.payload && typeof step.payload === 'object'
          ? step.payload
          : {}
      const allowed = MCP_ACTION_PLAN_WRITABLE_TOOLS.has(tool)
      return {
        index,
        tool,
        allowed,
        arguments: stepArgs,
        problem: tool
          ? allowed
            ? ''
            : `Tool ${tool} is not allowed in run_mcp_action_plan.`
          : 'Step is missing a tool/name/action.',
      }
    })
    return {
      steps,
      rawCount: rawSteps.length,
      truncated: rawSteps.length > MCP_ACTION_PLAN_MAX_STEPS,
      invalidSteps: steps.filter((step) => !step.allowed),
    }
  }

  async runMcpActionPlan(snapshot, args = {}) {
    const plan = this.normalizeActionPlanSteps(args)
    const previewOnly = args.previewOnly !== false
    const label = String(args.label || args.name || 'MCP action plan').trim().slice(0, 120) || 'MCP action plan'

    if (plan.steps.length === 0) {
      return errorResult('Provide at least one action-plan step.')
    }
    if (plan.invalidSteps.length > 0) {
      return textResult({
        success: false,
        previewOnly: true,
        action: 'run_mcp_action_plan',
        message: 'Action plan contains unsupported steps. No actions were run.',
        label,
        invalidSteps: plan.invalidSteps,
        steps: plan.steps,
      })
    }

    if (previewOnly) {
      return textResult({
        previewOnly: true,
        action: 'run_mcp_action_plan',
        message: `Action plan validated. ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'} would run after approval.`,
        label,
        stepCount: plan.steps.length,
        rawStepCount: plan.rawCount,
        truncated: plan.truncated,
        createCheckpointFirst: args.createCheckpointFirst !== false,
        stopOnError: args.stopOnError !== false,
        steps: plan.steps,
        suggestedApplyCall: {
          tool: 'run_mcp_action_plan',
          arguments: {
            ...args,
            previewOnly: false,
          },
        },
      })
    }

    if (!this.performAction) {
      return errorResult('MCP action-plan bridge is not available. Restart ComfyStudio and try again.')
    }

    const results = []
    let checkpoint = null
    if (args.createCheckpointFirst !== false) {
      const checkpointResult = await this.callTool('create_project_checkpoint', {
        label,
        previewOnly: false,
      })
      let parsedCheckpoint = null
      try {
        parsedCheckpoint = JSON.parse(checkpointResult?.content?.[0]?.text || 'null')
      } catch {
        parsedCheckpoint = null
      }
      checkpoint = parsedCheckpoint || checkpointResult
      results.push({
        index: -1,
        tool: 'create_project_checkpoint',
        success: !checkpointResult?.isError && parsedCheckpoint?.success !== false,
        result: checkpoint,
      })
      if (checkpointResult?.isError && args.stopOnError !== false) {
        return textResult({
          success: false,
          action: 'run_mcp_action_plan',
          message: 'Action plan stopped because the safety checkpoint could not be created.',
          checkpoint,
          results,
        })
      }
    }

    const stopOnError = args.stopOnError !== false
    for (const step of plan.steps) {
      const stepArgs = {
        ...(step.arguments || {}),
        previewOnly: step.arguments?.previewOnly === true ? true : false,
      }
      const response = await this.callTool(step.tool, stepArgs)
      let parsed = null
      try {
        parsed = JSON.parse(response?.content?.[0]?.text || 'null')
      } catch {
        parsed = null
      }
      const success = !response?.isError && parsed?.success !== false
      results.push({
        index: step.index,
        tool: step.tool,
        success,
        previewOnly: parsed?.previewOnly === true || stepArgs.previewOnly === true,
        result: parsed || response,
      })
      if (!success && stopOnError) break
    }

    const failedCount = results.filter((result) => result.index >= 0 && result.success === false).length
    return textResult({
      success: failedCount === 0,
      action: 'run_mcp_action_plan',
      message: failedCount === 0
        ? `Ran ${plan.steps.length} action-plan step${plan.steps.length === 1 ? '' : 's'}.`
        : `Action plan ran with ${failedCount} failed step${failedCount === 1 ? '' : 's'}.`,
      label,
      checkpoint,
      stepCount: plan.steps.length,
      failedCount,
      results,
    })
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

  async createProject(snapshot, args = {}) {
    if (!this.performAction) {
      return errorResult('MCP project bridge is not available. Restart ComfyStudio and try again.')
    }

    const previewOnly = args.previewOnly !== false
    const result = await this.performAction({
      action: 'create_project',
      payload: {
        ...args,
        previewOnly,
      },
    })

    return textResult({
      success: !previewOnly,
      action: 'create_project',
      message: previewOnly
        ? 'Project creation plan only. No project folder was created.'
        : 'Project created and opened.',
      result,
      suggestedApplyCall: previewOnly ? {
        tool: 'create_project',
        arguments: { ...args, previewOnly: false },
      } : undefined,
    })
  }

  async duplicateProject(snapshot, args = {}) {
    if (!this.performAction) {
      return errorResult('MCP project bridge is not available. Restart ComfyStudio and try again.')
    }

    const previewOnly = args.previewOnly !== false
    const result = await this.performAction({
      action: 'duplicate_project',
      payload: {
        ...args,
        previewOnly,
      },
    })

    return textResult({
      success: !previewOnly,
      action: 'duplicate_project',
      message: previewOnly
        ? 'Project duplicate plan only. No project folder was copied.'
        : 'Project duplicated and opened.',
      result,
      suggestedApplyCall: previewOnly ? {
        tool: 'duplicate_project',
        arguments: { ...args, previewOnly: false },
      } : undefined,
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

  async updateTrack(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')

    const trackId = String(args.trackId || args.id || '').trim()
    if (!trackId) return errorResult('Provide trackId from get_timeline.')
    const track = (timeline.tracks || []).find((candidate) => candidate?.id === trackId)
    if (!track) return errorResult(`Track ${trackId} was not found.`)

    const updates = {}
    if (Object.prototype.hasOwnProperty.call(args, 'name')) updates.name = String(args.name || '').trim().slice(0, 80)
    if (Object.prototype.hasOwnProperty.call(args, 'muted')) updates.muted = args.muted === true
    if (Object.prototype.hasOwnProperty.call(args, 'locked')) updates.locked = args.locked === true
    if (Object.prototype.hasOwnProperty.call(args, 'visible')) updates.visible = args.visible !== false
    if (track.type === 'audio' && Object.prototype.hasOwnProperty.call(args, 'channels')) {
      updates.channels = String(args.channels || '').trim().toLowerCase() === 'mono' ? 'mono' : 'stereo'
    }
    const requestedIndex = Number(args.index ?? args.newIndex)
    const hasIndex = Number.isFinite(requestedIndex)
    if (Object.keys(updates).length === 0 && !hasIndex) {
      return errorResult('Provide at least one update: name, muted, locked, visible, channels, or index.')
    }

    const plan = {
      track: trackRef(track),
      updates,
      newIndex: hasIndex ? Math.max(0, Math.floor(requestedIndex)) : null,
    }

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'update_track',
        message: 'Track update plan only. No timeline change was made.',
        plan,
        suggestedApplyCall: {
          tool: 'update_track',
          arguments: { ...args, previewOnly: false },
        },
      })
    }

    if (!this.performAction) return errorResult('MCP track bridge is not available. Restart ComfyStudio and try again.')
    const result = await this.performAction({
      action: 'update_track',
      payload: { ...args, previewOnly: false },
    })
    return textResult({
      success: true,
      action: 'update_track',
      plan,
      result,
    })
  }

  async removeTrack(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')

    const trackId = String(args.trackId || args.id || '').trim()
    if (!trackId) return errorResult('Provide trackId from get_timeline.')
    const track = (timeline.tracks || []).find((candidate) => candidate?.id === trackId)
    if (!track) return errorResult(`Track ${trackId} was not found.`)
    const clipsOnTrack = (timeline.clips || []).filter((clip) => clip?.trackId === trackId)

    const plan = {
      track: trackRef(track),
      removedClipCount: clipsOnTrack.length,
      clips: clipsOnTrack.slice(0, 50).map(clipRef),
      clipLimitApplied: clipsOnTrack.length > 50,
    }

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'remove_track',
        message: 'Track removal plan only. No timeline change was made.',
        plan,
        suggestedApplyCall: {
          tool: 'remove_track',
          arguments: { trackId, previewOnly: false },
        },
      })
    }

    if (!this.performAction) return errorResult('MCP track bridge is not available. Restart ComfyStudio and try again.')
    const result = await this.performAction({
      action: 'remove_track',
      payload: { trackId, previewOnly: false },
    })
    return textResult({
      success: true,
      action: 'remove_track',
      plan,
      result,
    })
  }

  async switchTimeline(snapshot, args = {}) {
    const timelineId = String(args.timelineId || args.id || '').trim()
    if (!timelineId) return errorResult('Provide timelineId.')
    const timeline = (snapshot.timelines || []).find((candidate) => candidate?.id === timelineId)
    if (!timeline) return errorResult(`Timeline ${timelineId} was not found.`)

    const plan = { timeline: timelineRef(timeline, snapshot.project?.settings || {}) }
    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'switch_timeline',
        message: 'Timeline switch plan only. The active timeline was not changed.',
        plan,
        suggestedApplyCall: {
          tool: 'switch_timeline',
          arguments: { timelineId, previewOnly: false },
        },
      })
    }

    if (!this.performAction) return errorResult('MCP timeline bridge is not available. Restart ComfyStudio and try again.')
    const result = await this.performAction({
      action: 'switch_timeline',
      payload: { timelineId, previewOnly: false },
    })
    return textResult({
      success: true,
      action: 'switch_timeline',
      plan,
      result,
    })
  }

  async renameTimeline(snapshot, args = {}) {
    const timelineId = String(args.timelineId || args.id || '').trim()
    const name = String(args.name || args.timelineName || args.sequenceName || '').trim().replace(/\s+/g, ' ').slice(0, 120)
    if (!timelineId) return errorResult('Provide timelineId.')
    if (!name) return errorResult('Provide a new timeline name.')
    const timeline = (snapshot.timelines || []).find((candidate) => candidate?.id === timelineId)
    if (!timeline) return errorResult(`Timeline ${timelineId} was not found.`)

    const plan = {
      before: timelineRef(timeline, snapshot.project?.settings || {}),
      name,
    }
    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'rename_timeline',
        message: 'Timeline rename plan only. No project change was made.',
        plan,
        suggestedApplyCall: {
          tool: 'rename_timeline',
          arguments: { timelineId, name, previewOnly: false },
        },
      })
    }

    if (!this.performAction) return errorResult('MCP timeline bridge is not available. Restart ComfyStudio and try again.')
    const result = await this.performAction({
      action: 'rename_timeline',
      payload: { timelineId, name, previewOnly: false },
    })
    return textResult({
      success: true,
      action: 'rename_timeline',
      plan,
      result,
    })
  }

  async duplicateTimeline(snapshot, args = {}) {
    const timelineId = String(args.timelineId || args.id || '').trim()
    if (!timelineId) return errorResult('Provide timelineId.')
    const timeline = (snapshot.timelines || []).find((candidate) => candidate?.id === timelineId)
    if (!timeline) return errorResult(`Timeline ${timelineId} was not found.`)

    const name = String(args.name || args.timelineName || args.sequenceName || '').trim().replace(/\s+/g, ' ').slice(0, 120)
    const plan = {
      source: timelineRef(timeline, snapshot.project?.settings || {}),
      name: name || `${timeline.name || 'Timeline'} copy`,
      switchToTimeline: args.switchToTimeline === true || args.activate === true,
    }
    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'duplicate_timeline',
        message: 'Timeline duplicate plan only. No project change was made.',
        plan,
        suggestedApplyCall: {
          tool: 'duplicate_timeline',
          arguments: { ...args, timelineId, previewOnly: false },
        },
      })
    }

    if (!this.performAction) return errorResult('MCP timeline bridge is not available. Restart ComfyStudio and try again.')
    const result = await this.performAction({
      action: 'duplicate_timeline',
      payload: { ...args, timelineId, previewOnly: false },
    })
    return textResult({
      success: true,
      action: 'duplicate_timeline',
      plan,
      result,
    })
  }

  async deleteTimeline(snapshot, args = {}) {
    const timelineId = String(args.timelineId || args.id || '').trim()
    if (!timelineId) return errorResult('Provide timelineId.')
    const timeline = (snapshot.timelines || []).find((candidate) => candidate?.id === timelineId)
    if (!timeline) return errorResult(`Timeline ${timelineId} was not found.`)

    const plan = {
      timeline: timelineRef(timeline, snapshot.project?.settings || {}),
      warning: 'Deleting a timeline removes that sequence from the project.',
    }
    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'delete_timeline',
        message: 'Timeline delete plan only. No project change was made.',
        plan,
        suggestedApplyCall: {
          tool: 'delete_timeline',
          arguments: { timelineId, previewOnly: false },
        },
      })
    }

    if (!this.performAction) return errorResult('MCP timeline bridge is not available. Restart ComfyStudio and try again.')
    const result = await this.performAction({
      action: 'delete_timeline',
      payload: { timelineId, previewOnly: false },
    })
    return textResult({
      success: true,
      action: 'delete_timeline',
      plan,
      result,
    })
  }

  async addTransition(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')

    let transitionType
    try {
      transitionType = normalizeMcpTransitionType(args.transitionType || args.type || (args.clipId ? 'fade-black' : 'dissolve'))
    } catch (error) {
      return errorResult(error.message)
    }
    const durationSeconds = normalizeMcpTransitionDuration(args.durationSeconds ?? args.duration, 0.5)
    const clipAId = String(args.clipAId || '').trim()
    const clipBId = String(args.clipBId || '').trim()
    const clipId = String(args.clipId || '').trim()
    const edge = normalizeMcpTransitionEdge(args.edge)
    const settings = buildMcpTransitionSettings(args)
    const kind = clipAId && clipBId ? 'between' : 'edge'

    let plan
    if (kind === 'between') {
      const clipA = (timeline.clips || []).find((clip) => clip?.id === clipAId)
      const clipB = (timeline.clips || []).find((clip) => clip?.id === clipBId)
      if (!clipA || !clipB) return errorResult('Both clipAId and clipBId must refer to clips on the active timeline.')
      if (clipA.trackId !== clipB.trackId) return errorResult('Between transitions require two clips on the same track.')
      plan = {
        kind,
        transitionType,
        durationSeconds,
        settings,
        clipA: clipRef(clipA),
        clipB: clipRef(clipB),
        track: trackRef(getTrackById(timeline, clipA.trackId)),
        existingTransition: transitionRef((timeline.transitions || []).find((transition) => (
          (transition.clipAId === clipAId && transition.clipBId === clipBId)
          || (transition.clipAId === clipBId && transition.clipBId === clipAId)
        ))),
      }
    } else {
      if (!clipId) return errorResult('Provide clipId plus edge, or clipAId and clipBId.')
      const clip = (timeline.clips || []).find((candidate) => candidate?.id === clipId)
      if (!clip) return errorResult(`Clip ${clipId} was not found.`)
      plan = {
        kind,
        transitionType,
        durationSeconds,
        edge,
        settings,
        clip: clipRef(clip),
        track: trackRef(getTrackById(timeline, clip.trackId)),
        existingTransition: transitionRef((timeline.transitions || []).find((transition) => (
          transition.kind === 'edge' && transition.clipId === clipId && transition.edge === edge
        ))),
      }
    }

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'add_transition',
        message: 'Transition add plan only. No timeline change was made.',
        plan,
        suggestedApplyCall: {
          tool: 'add_transition',
          arguments: { ...args, transitionType, durationSeconds, previewOnly: false },
        },
      })
    }

    if (!this.performAction) return errorResult('MCP transition bridge is not available. Restart ComfyStudio and try again.')
    const result = await this.performAction({
      action: 'add_transition',
      payload: { ...args, transitionType, durationSeconds, settings, previewOnly: false },
    })
    return textResult({
      success: true,
      action: 'add_transition',
      plan,
      result,
    })
  }

  async updateTransition(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')

    const transitionId = String(args.transitionId || args.id || '').trim()
    if (!transitionId) return errorResult('Provide transitionId from get_timeline includeTransitions=true.')
    const transition = (timeline.transitions || []).find((candidate) => candidate?.id === transitionId)
    if (!transition) return errorResult(`Transition ${transitionId} was not found.`)

    const updates = {}
    if (args.transitionType || args.type) {
      try {
        updates.type = normalizeMcpTransitionType(args.transitionType || args.type)
      } catch (error) {
        return errorResult(error.message)
      }
    }
    if (args.durationSeconds !== undefined || args.duration !== undefined) {
      updates.duration = normalizeMcpTransitionDuration(args.durationSeconds ?? args.duration, transition.duration || 0.5)
    }
    const settings = buildMcpTransitionSettings(args)
    if (Object.keys(settings).length > 0) updates.settings = settings
    if (Object.keys(updates).length === 0) return errorResult('Provide at least one update: transitionType, durationSeconds, alignment, or settings.')

    const plan = {
      before: transitionRef(transition),
      updates,
      afterEstimate: {
        ...transitionRef(transition),
        type: updates.type || transition.type,
        duration: roundTime(updates.duration ?? transition.duration),
        settings: {
          ...(transition.settings || {}),
          ...(updates.settings || {}),
        },
      },
    }

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'update_transition',
        message: 'Transition update plan only. No timeline change was made.',
        plan,
        suggestedApplyCall: {
          tool: 'update_transition',
          arguments: { ...args, previewOnly: false },
        },
      })
    }

    if (!this.performAction) return errorResult('MCP transition bridge is not available. Restart ComfyStudio and try again.')
    const result = await this.performAction({
      action: 'update_transition',
      payload: { ...args, previewOnly: false },
    })
    return textResult({
      success: true,
      action: 'update_transition',
      plan,
      result,
    })
  }

  async removeTransitions(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')

    const transitionIds = normalizeMcpIdList(args.transitionIds || args.transitionId || args.ids || args.id)
    if (transitionIds.length === 0) return errorResult('Provide transitionId or transitionIds.')
    const transitionsById = new Map((timeline.transitions || []).map((transition) => [transition.id, transition]))
    const targets = transitionIds.map((id) => transitionsById.get(id)).filter(Boolean)
    const missingTransitionIds = transitionIds.filter((id) => !transitionsById.has(id))
    const plan = {
      transitionCount: targets.length,
      missingTransitionIds,
      transitions: targets.map(transitionRef),
    }

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'remove_transitions',
        message: 'Transition removal plan only. No timeline change was made.',
        plan,
        suggestedApplyCall: {
          tool: 'remove_transitions',
          arguments: { transitionIds: targets.map((transition) => transition.id), previewOnly: false },
        },
      })
    }

    if (!this.performAction) return errorResult('MCP transition bridge is not available. Restart ComfyStudio and try again.')
    const result = await this.performAction({
      action: 'remove_transitions',
      payload: { transitionIds, previewOnly: false },
    })
    return textResult({
      success: true,
      action: 'remove_transitions',
      plan,
      result,
    })
  }

  async moveClips(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')

    const entries = Array.isArray(args.clips) ? args.clips : [{ ...args }]
    const plans = entries.map((entry) => {
      const clipId = String(entry?.clipId || entry?.id || '').trim()
      const clip = (timeline.clips || []).find((candidate) => candidate?.id === clipId)
      if (!clip) return { clipId, error: 'Clip not found.' }
      const targetTrackId = String(entry.trackId || args.trackId || clip.trackId || '').trim()
      const track = getTrackById(timeline, targetTrackId)
      if (!track) return { clipId, error: `Track ${targetTrackId} was not found.` }
      if (track.locked) return { clipId, error: `Track ${targetTrackId} is locked.` }
      const startValue = entry.startSeconds ?? entry.startTime ?? args.startSeconds ?? args.startTime ?? clip.startTime
      return {
        clip: clipRef(clip),
        targetTrack: trackRef(track),
        startSeconds: roundTime(Math.max(0, Number(startValue) || 0)),
        previousTrackId: clip.trackId,
        previousStartSeconds: roundTime(getClipStart(clip)),
      }
    })
    const errors = plans.filter((plan) => plan.error)
    if (errors.length > 0) return errorResult(`Could not build move plan: ${errors.map((entry) => `${entry.clipId || 'unknown'} ${entry.error}`).join('; ')}`)

    const plan = {
      moveCount: plans.length,
      resolveOverlaps: args.resolveOverlaps === true,
      moves: plans,
    }
    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'move_clips',
        message: 'Clip move plan only. No timeline change was made.',
        plan,
        suggestedApplyCall: {
          tool: 'move_clips',
          arguments: { ...args, previewOnly: false },
        },
      })
    }

    if (!this.performAction) return errorResult('MCP clip edit bridge is not available. Restart ComfyStudio and try again.')
    const result = await this.performAction({
      action: 'move_clips',
      payload: { ...args, previewOnly: false },
    })
    return textResult({
      success: true,
      action: 'move_clips',
      plan,
      result,
    })
  }

  async trimClips(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')

    const entries = Array.isArray(args.clips) ? args.clips : [{ ...args }]
    const plans = entries.map((entry) => {
      const clipId = String(entry?.clipId || entry?.id || '').trim()
      const clip = (timeline.clips || []).find((candidate) => candidate?.id === clipId)
      if (!clip) return { clipId, error: 'Clip not found.' }
      const updates = {}
      if (entry.startSeconds !== undefined || entry.startTime !== undefined) updates.startTime = roundTime(Math.max(0, Number(entry.startSeconds ?? entry.startTime) || 0))
      if (entry.durationSeconds !== undefined || entry.duration !== undefined) {
        const duration = Number(entry.durationSeconds ?? entry.duration)
        if (!Number.isFinite(duration) || duration <= 0) return { clipId, error: 'durationSeconds must be greater than 0.' }
        updates.duration = roundTime(duration)
      }
      if (entry.trimStartSeconds !== undefined || entry.trimStart !== undefined) updates.trimStart = Math.max(0, Number(entry.trimStartSeconds ?? entry.trimStart) || 0)
      if (entry.trimEndSeconds !== undefined || entry.trimEnd !== undefined) updates.trimEnd = Math.max(0, Number(entry.trimEndSeconds ?? entry.trimEnd) || 0)
      if (Object.keys(updates).length === 0) return { clipId, error: 'No trim updates were provided.' }
      return {
        clip: clipRef(clip),
        before: {
          startTime: roundTime(getClipStart(clip)),
          duration: roundTime(getClipDuration(clip)),
          trimStart: roundTime(toFiniteNumber(clip.trimStart, 0)),
          trimEnd: Number.isFinite(Number(clip.trimEnd)) ? roundTime(Number(clip.trimEnd)) : null,
        },
        updates,
      }
    })
    const errors = plans.filter((plan) => plan.error)
    if (errors.length > 0) return errorResult(`Could not build trim plan: ${errors.map((entry) => `${entry.clipId || 'unknown'} ${entry.error}`).join('; ')}`)

    const plan = {
      trimCount: plans.length,
      trims: plans,
    }
    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'trim_clips',
        message: 'Clip trim plan only. No timeline change was made.',
        plan,
        suggestedApplyCall: {
          tool: 'trim_clips',
          arguments: { ...args, previewOnly: false },
        },
      })
    }

    if (!this.performAction) return errorResult('MCP clip edit bridge is not available. Restart ComfyStudio and try again.')
    const result = await this.performAction({
      action: 'trim_clips',
      payload: { ...args, previewOnly: false },
    })
    return textResult({
      success: true,
      action: 'trim_clips',
      plan,
      result,
    })
  }

  async deleteClips(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')

    let clipIds = normalizeMcpIdList(args.clipIds || args.clipId || args.ids || args.id)
    const filter = String(args.filter || '').trim().toLowerCase()
    if (clipIds.length === 0 && filter) {
      if (filter === 'disabled') clipIds = (timeline.clips || []).filter((clip) => clip?.enabled === false).map((clip) => clip.id)
      if (filter === 'selected') clipIds = Array.isArray(timeline.selectedClipIds) ? timeline.selectedClipIds : []
      if (filter === 'labeled') clipIds = (timeline.clips || []).filter((clip) => clip?.labelColor).map((clip) => clip.id)
    }
    clipIds = [...new Set(clipIds)]
    if (clipIds.length === 0) return errorResult('Provide clipId/clipIds, or filter disabled, selected, or labeled.')

    const limit = clampLimit(args.limit, 100, 1000)
    if (clipIds.length > limit) return errorResult(`delete_clips matched ${clipIds.length} clips, above limit ${limit}.`)
    const clipsById = new Map((timeline.clips || []).map((clip) => [clip.id, clip]))
    const targets = clipIds.map((id) => clipsById.get(id)).filter(Boolean)
    const missingClipIds = clipIds.filter((id) => !clipsById.has(id))
    const plan = {
      deleteCount: targets.length,
      ripple: args.ripple === true,
      filter: filter || null,
      missingClipIds,
      clips: targets.map(clipRef),
    }

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'delete_clips',
        message: 'Clip delete plan only. No timeline change was made.',
        plan,
        suggestedApplyCall: {
          tool: 'delete_clips',
          arguments: {
            clipIds: targets.map((clip) => clip.id),
            ripple: args.ripple === true,
            limit,
            previewOnly: false,
          },
        },
      })
    }

    if (!this.performAction) return errorResult('MCP clip edit bridge is not available. Restart ComfyStudio and try again.')
    const result = await this.performAction({
      action: 'delete_clips',
      payload: { ...args, clipIds, previewOnly: false },
    })
    return textResult({
      success: true,
      action: 'delete_clips',
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

  async moveUnusedAssetsToFolder(_snapshot, args = {}) {
    if (!this.performAction) {
      return errorResult('MCP unused asset cleanup bridge is not available. Restart ComfyStudio and try again.')
    }

    const previewOnly = args.previewOnly !== false
    try {
      const result = await this.performAction({
        action: 'move_unused_assets_to_folder',
        payload: {
          ...args,
          previewOnly,
        },
      })
      return textResult({
        success: previewOnly ? undefined : true,
        previewOnly,
        action: 'move_unused_assets_to_folder',
        message: result?.message || (previewOnly
          ? 'Unused asset cleanup plan returned by ComfyStudio.'
          : 'Unused assets moved by ComfyStudio.'),
        result,
        suggestedApplyCall: previewOnly ? {
          tool: 'move_unused_assets_to_folder',
          arguments: {
            ...args,
            previewOnly: false,
          },
        } : undefined,
      })
    } catch (error) {
      return errorResult(`Could not prepare unused asset cleanup: ${error?.message || String(error)}`)
    }
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

  async replaceClipWithAsset(_snapshot, args = {}) {
    if (!this.performAction) {
      return errorResult('MCP clip replacement bridge is not available. Restart ComfyStudio and try again.')
    }

    const previewOnly = args.previewOnly !== false
    try {
      const result = await this.performAction({
        action: 'replace_clip_with_asset',
        payload: {
          ...args,
          previewOnly,
        },
      })
      return textResult({
        success: previewOnly ? undefined : true,
        previewOnly,
        action: 'replace_clip_with_asset',
        message: result?.message || (previewOnly
          ? 'Clip replacement plan returned by ComfyStudio.'
          : 'Clip replaced through ComfyStudio.'),
        result,
        suggestedApplyCall: previewOnly ? {
          tool: 'replace_clip_with_asset',
          arguments: {
            ...args,
            previewOnly: false,
          },
        } : undefined,
      })
    } catch (error) {
      return errorResult(`Could not replace clip with asset: ${error?.message || String(error)}`)
    }
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

  async addAdjustmentClip(snapshot, args = {}) {
    const plan = resolveAdjustmentClipPlan(snapshot, args)
    if (plan.error) return errorResult(plan.error)

    const applyArgs = {
      ...args,
      previewOnly: false,
      name: plan.name,
      trackId: plan.createTrack ? undefined : plan.track?.id,
      createTrack: plan.createTrack,
      trackName: plan.createTrack ? plan.track?.name : undefined,
      startSeconds: plan.startSeconds,
      durationSeconds: plan.durationSeconds,
      enabled: plan.enabled,
      adjustments: plan.adjustments,
      transform: plan.transform || undefined,
      keyframes: plan.keyframes,
    }

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'add_adjustment_clip',
        message: 'Adjustment clip creation plan only. No timeline change was made.',
        plan,
        suggestedApplyCall: {
          tool: 'add_adjustment_clip',
          arguments: applyArgs,
        },
      })
    }

    if (!this.performAction) {
      return errorResult('MCP adjustment clip bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'add_adjustment_clip',
      payload: applyArgs,
    })

    return textResult({
      success: true,
      action: 'add_adjustment_clip',
      message: 'Adjustment clip created through ComfyStudio.',
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

  async listGlslEffects(args = {}) {
    if (this.performAction) {
      try {
        const result = await this.performAction({
          action: 'list_glsl_effects',
          payload: args,
        })
        return textResult(result)
      } catch (error) {
        return errorResult(`Could not list GLSL effects: ${error?.message || String(error)}`)
      }
    }

    return textResult({
      warning: 'Renderer effect registry is not available. Restart ComfyStudio for full parameter details.',
      effectIds: MCP_GLSL_EFFECT_IDS,
    })
  }

  async addGlslEffect(snapshot, args = {}) {
    const resolved = getEffectClipForMcp(snapshot, args.clipId)
    if (resolved.error) return errorResult(resolved.error)

    if (!this.performAction) {
      return errorResult('MCP effect bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'add_glsl_effect',
      payload: {
        ...args,
        previewOnly: args.previewOnly !== false,
      },
    })

    return textResult({
      success: args.previewOnly === false ? true : undefined,
      previewOnly: args.previewOnly !== false,
      action: 'add_glsl_effect',
      before: summarizeEffectClipForMcp(resolved.clip),
      result,
    })
  }

  async updateGlslEffect(snapshot, args = {}) {
    const resolved = getEffectClipForMcp(snapshot, args.clipId)
    if (resolved.error) return errorResult(resolved.error)

    if (!this.performAction) {
      return errorResult('MCP effect bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'update_glsl_effect',
      payload: {
        ...args,
        previewOnly: args.previewOnly !== false,
      },
    })

    return textResult({
      success: args.previewOnly === false ? true : undefined,
      previewOnly: args.previewOnly !== false,
      action: 'update_glsl_effect',
      before: summarizeEffectClipForMcp(resolved.clip),
      result,
    })
  }

  async removeGlslEffect(snapshot, args = {}) {
    const resolved = getEffectClipForMcp(snapshot, args.clipId)
    if (resolved.error) return errorResult(resolved.error)

    if (!this.performAction) {
      return errorResult('MCP effect bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'remove_glsl_effect',
      payload: {
        ...args,
        previewOnly: args.previewOnly !== false,
      },
    })

    return textResult({
      success: args.previewOnly === false ? true : undefined,
      previewOnly: args.previewOnly !== false,
      action: 'remove_glsl_effect',
      before: summarizeEffectClipForMcp(resolved.clip),
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

  async addDipToBlack(_snapshot, args = {}) {
    if (!this.performAction) {
      return errorResult('MCP dip-to-black bridge is not available. Restart ComfyStudio and try again.')
    }

    const previewOnly = args.previewOnly !== false
    try {
      const result = await this.performAction({
        action: 'add_dip_to_black',
        payload: {
          ...args,
          previewOnly,
        },
      })

      return textResult({
        success: previewOnly ? undefined : true,
        previewOnly,
        action: 'add_dip_to_black',
        message: result?.message || (previewOnly
          ? 'Dip-to-black opacity keyframe plan returned by ComfyStudio.'
          : 'Dip-to-black opacity keyframes applied through ComfyStudio.'),
        result,
        suggestedApplyCall: previewOnly ? {
          tool: 'add_dip_to_black',
          arguments: {
            ...args,
            previewOnly: false,
          },
        } : undefined,
      })
    } catch (error) {
      return errorResult(`Could not add dip-to-black keyframes: ${error?.message || String(error)}`)
    }
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

  async exportDeliveryBatch(snapshot, args = {}) {
    const batchPlan = buildExportDeliveryBatchPlan(snapshot, args)
    if (batchPlan.error) return errorResult(batchPlan.error)

    const previewOnly = args.previewOnly !== false
    const applyArgs = {
      ...args,
      previewOnly: false,
    }

    if (previewOnly) {
      return textResult({
        previewOnly: true,
        action: 'export_delivery_batch',
        message: 'Batch export plan only. No renders were started.',
        plan: batchPlan,
        suggestedApplyCall: {
          tool: 'export_delivery_batch',
          arguments: applyArgs,
        },
      })
    }

    if (batchPlan.blockedCount > 0) {
      return textResult({
        success: false,
        action: 'export_delivery_batch',
        message: `Batch export was not started because ${batchPlan.blockedCount} target${batchPlan.blockedCount === 1 ? ' has' : 's have'} blockers.`,
        plan: batchPlan,
      })
    }

    if (!this.performAction) {
      return errorResult('MCP batch export bridge is not available. Restart ComfyStudio and try again.')
    }

    const stopOnError = args.stopOnError !== false
    const results = []
    for (const target of batchPlan.targets) {
      const targetResult = await this.exportTimeline(snapshot, {
        ...target.args,
        previewOnly: false,
      })
      let parsed = null
      try {
        parsed = JSON.parse(targetResult?.content?.[0]?.text || 'null')
      } catch {
        parsed = null
      }
      results.push({
        index: target.index,
        filename: target.plan?.settings?.filename || target.args.filename || '',
        target: target.plan?.settings || target.args,
        success: targetResult?.isError ? false : parsed?.success !== false,
        result: parsed || targetResult,
      })
      if (stopOnError && (targetResult?.isError || parsed?.success === false)) break
    }

    const failedCount = results.filter((result) => result.success === false).length
    return textResult({
      success: failedCount === 0,
      action: 'export_delivery_batch',
      message: failedCount === 0
        ? `Started ${results.length} delivery export${results.length === 1 ? '' : 's'} through ComfyStudio.`
        : `Started ${results.length} delivery export${results.length === 1 ? '' : 's'}, with ${failedCount} failure${failedCount === 1 ? '' : 's'}.`,
      plan: batchPlan,
      results,
    })
  }

  async exportFcpXml(snapshot, args = {}) {
    const timeline = snapshot.currentTimeline || null
    if (!timeline) return errorResult('No current timeline is available.')
    const projectPath = String(snapshot.project?.path || '').trim()
    if (!projectPath) return errorResult('Open a saved project before exporting FCPXML.')

    const assetsById = new Map((snapshot.assets || []).map((asset) => [asset.id, asset]))
    const exportableClips = (timeline.clips || []).filter((clip) => {
      if (clip?.enabled === false) return false
      if (!['video', 'audio', 'image'].includes(String(clip?.type || '').toLowerCase())) return false
      const asset = assetsById.get(clip.assetId)
      return Boolean(asset?.absolutePath || asset?.path)
    })
    if (exportableClips.length === 0) {
      return errorResult('No media clips with project file paths are available for FCPXML export.')
    }

    const filename = String(args.filename || `${snapshot.project?.name || 'ComfyStudio'}_${timeline.name || 'Timeline'}`).trim()
    const outputPath = String(args.outputPath || '').trim()
    const plan = {
      projectPath,
      outputPath: outputPath || 'project renders folder',
      filename: filename || `${snapshot.project?.name || 'ComfyStudio'}_${timeline.name || 'Timeline'}`,
      timeline: {
        id: timeline.id,
        name: timeline.name,
        width: timeline.width,
        height: timeline.height,
        fps: timeline.fps,
        duration: timeline.duration,
      },
      exportableClipCount: exportableClips.length,
      skippedClipCount: (timeline.clips || []).length - exportableClips.length,
      note: 'FCPXML exports media clips with project file paths plus static transform data where supported.',
    }

    if (args.previewOnly !== false) {
      return textResult({
        previewOnly: true,
        action: 'export_fcpxml',
        message: 'FCPXML export plan only. No file was written.',
        plan,
        suggestedApplyCall: {
          tool: 'export_fcpxml',
          arguments: {
            filename,
            ...(outputPath ? { outputPath } : {}),
            previewOnly: false,
          },
        },
      })
    }

    if (!this.performAction) {
      return errorResult('MCP FCPXML export bridge is not available. Restart ComfyStudio and try again.')
    }

    const result = await this.performAction({
      action: 'export_fcpxml',
      payload: {
        filename,
        outputPath,
        previewOnly: false,
      },
    })

    return textResult({
      success: true,
      action: 'export_fcpxml',
      message: 'FCPXML exported through ComfyStudio.',
      plan,
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
