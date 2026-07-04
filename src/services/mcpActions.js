import useTimelineStore from '../stores/timelineStore'
import useProjectStore, { RESOLUTION_PRESETS, FPS_PRESETS } from '../stores/projectStore'
import useAssetsStore from '../stores/assetsStore'
import { useFrameForAIStore } from '../stores/frameForAIStore'
import { captureTimelineFrameAt, getTopmostVideoOrImageClipAtTime } from '../utils/captureTimelineFrame'
import { generateColorMatteBlob } from '../utils/overlayGenerators'
import { DEFAULT_SHAPE_PROPERTIES, getShapeDisplayName, normalizeShapeProperties } from '../utils/shapes'
import { EFFECT_TYPES, getEffectPropertyId, getEffectTypeDefinition } from '../utils/effects'
import { normalizeAdjustmentSettings } from '../utils/adjustments'
import { saveLocalComfyConnectionPort } from './localComfyConnection'
import { getAbsoluteFileUrl, importAsset, writeGeneratedOverlayToProject } from './fileSystem'
import buildFcpXml from './fcpxmlExporter'
import {
  handleTranscribeCaptions,
  handleGetCaptionStatus,
  handleUpdateCaptionCues,
  handleGenerateCaptions,
} from './mcpCaptions'

export const MCP_ACTION_BRIDGE_VERSION = 2

const MCP_PROJECT_CHECKPOINTS = new Map()
const MCP_PROJECT_CHECKPOINT_LIMIT = 20

function normalizeClipLabelColor(color) {
  const value = String(color || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : ''
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return normalizeStringArray(value)
  const raw = String(value || '').trim()
  if (!raw) return []
  return raw.split(',').map((item) => item.trim()).filter(Boolean)
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

function summarizeClipWithAsset(clip, asset = null) {
  return {
    ...summarizeClip(clip),
    assetId: clip?.assetId || null,
    asset: asset ? summarizeAsset(asset) : null,
    enabled: clip?.enabled !== false,
    trimStart: Number(clip?.trimStart) || 0,
    trimEnd: Number.isFinite(Number(clip?.trimEnd)) ? Number(clip.trimEnd) : null,
    sourceDuration: clip?.sourceDuration === Infinity ? 'Infinity' : (Number.isFinite(Number(clip?.sourceDuration)) ? Number(clip.sourceDuration) : null),
    transform: clip?.transform || {},
    keyframes: clip?.keyframes || {},
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

function normalizeMcpGenerationResolution(value) {
  if (!value || typeof value !== 'object') return null
  const width = Number(value.width)
  const height = Number(value.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return {
    width: Math.max(16, Math.round(width)),
    height: Math.max(16, Math.round(height)),
  }
}

function resolveMcpGenerationResolution(payload = {}) {
  return normalizeMcpGenerationResolution({
    width: payload.width ?? payload.outputWidth,
    height: payload.height ?? payload.outputHeight,
  }) || normalizeMcpGenerationResolution(payload.resolution || payload.outputResolution || payload.size)
}

function sanitizeExportBaseName(value) {
  return String(value || 'Velorn_Timeline')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120)
    || 'Velorn_Timeline'
}

function isAbsoluteMcpFilePath(filePath) {
  const value = String(filePath || '')
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

function getTimelineEndTimeForMcp(clips = [], fallback = 0) {
  return Math.max(
    Number(fallback) || 0,
    ...(clips || []).map((clip) => (Number(clip.startTime) || 0) + (Number(clip.duration) || 0))
  )
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

function normalizeProjectName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120)
  if (!name) throw new Error('Provide a project name.')
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw new Error('Project name contains characters that are not allowed in folder names.')
  }
  return name
}

function normalizeProjectDimension(value, fallback) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return Math.max(16, Math.round(parsed))
  return Math.max(16, Math.round(Number(fallback) || 1920))
}

function normalizeProjectFps(value, fallback) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(240, Math.max(1, parsed))
  const fallbackFps = Number(fallback)
  return Number.isFinite(fallbackFps) && fallbackFps > 0 ? fallbackFps : 24
}

function getProjectDefaultResolution(projectState = {}) {
  const preset = RESOLUTION_PRESETS.find((item) => item.name === (projectState.defaultResolution || 'HD 1080p'))
    || RESOLUTION_PRESETS[0]
  return preset || { width: 1920, height: 1080 }
}

function summarizeProject(project, projectHandle = null) {
  if (!project) return null
  return {
    name: project.name || '',
    path: typeof projectHandle === 'string' ? projectHandle : null,
    created: project.created || null,
    modified: project.modified || null,
    width: Number(project.settings?.width) || null,
    height: Number(project.settings?.height) || null,
    fps: Number(project.settings?.fps) || null,
    timelineCount: Array.isArray(project.timelines) ? project.timelines.length : 0,
    assetCount: Array.isArray(project.assets) ? project.assets.length : 0,
    currentTimelineId: project.currentTimelineId || null,
  }
}

async function resolveProjectPath(baseDir, projectName) {
  if (typeof baseDir === 'string' && window.electronAPI?.pathJoin) {
    return window.electronAPI.pathJoin(baseDir, projectName)
  }
  return null
}

async function buildCreateProjectPlan(payload = {}) {
  const projectState = useProjectStore.getState()
  const name = normalizeProjectName(payload.name || payload.projectName || payload.title)
  const defaultResolution = getProjectDefaultResolution(projectState)
  const width = normalizeProjectDimension(payload.width, defaultResolution.width)
  const height = normalizeProjectDimension(payload.height, defaultResolution.height)
  const fps = normalizeProjectFps(payload.fps, projectState.defaultFps ?? FPS_PRESETS.find((item) => item.value === 24)?.value ?? 24)
  const defaultProjectsHandle = projectState.defaultProjectsHandle
  if (!defaultProjectsHandle) {
    throw new Error('No default projects folder is set. Choose a projects folder in Velorn before creating projects through MCP.')
  }

  const targetPath = await resolveProjectPath(defaultProjectsHandle, name)
  const targetExists = targetPath && window.electronAPI?.exists
    ? await window.electronAPI.exists(targetPath)
    : false

  return {
    action: 'create_project',
    previewOnly: payload.previewOnly !== false,
    name,
    width,
    height,
    fps,
    defaultProjectsLocation: projectState.defaultProjectsLocation || (typeof defaultProjectsHandle === 'string' ? defaultProjectsHandle : ''),
    targetPath,
    targetExists: Boolean(targetExists),
    willOpenProject: true,
  }
}

async function handleCreateProject(payload = {}) {
  const projectState = useProjectStore.getState()
  const plan = await buildCreateProjectPlan(payload)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'create_project',
      message: plan.targetExists
        ? 'Project creation plan only. The target folder already exists, so applying this would be rejected.'
        : 'Project creation plan only. No project was created.',
      plan,
    }
  }

  if (plan.targetExists) {
    throw new Error(`Project folder already exists: ${plan.targetPath || plan.name}. Choose a different project name.`)
  }

  const project = await projectState.createProject?.({
    name: plan.name,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
  })
  if (!project) {
    const error = useProjectStore.getState().error
    throw new Error(error || 'Could not create the project.')
  }

  const nextState = useProjectStore.getState()
  return {
    created: true,
    action: 'create_project',
    project: summarizeProject(nextState.currentProject || project, nextState.currentProjectHandle),
    currentTimelineId: nextState.currentTimelineId || null,
  }
}

function handleListRecentProjects(payload = {}) {
  const projectState = useProjectStore.getState()
  const limit = Math.max(1, Math.min(10, Number(payload.limit) || 10))
  const currentPath = typeof projectState.currentProjectHandle === 'string' ? projectState.currentProjectHandle : ''
  const projects = (projectState.recentProjects || []).slice(0, limit).map((project) => ({
    name: project?.name || '',
    path: project?.path || '',
    modified: project?.modified || null,
    isOpen: Boolean(currentPath && project?.path === currentPath),
    ...(project?.settings
      ? {
        settings: {
          width: Number(project.settings.width) || null,
          height: Number(project.settings.height) || null,
          fps: Number(project.settings.fps) || null,
        },
      }
      : {}),
  }))
  return {
    action: 'list_recent_projects',
    count: projects.length,
    currentProjectPath: currentPath || null,
    currentProjectName: projectState.currentProject?.name || null,
    projects,
  }
}

async function handleOpenProject(payload = {}) {
  if (!window.electronAPI) {
    throw new Error('Opening projects through MCP is only available in the desktop app.')
  }

  const projectState = useProjectStore.getState()
  const explicitPath = String(payload.projectPath || payload.path || '').trim()
  const requestedName = String(payload.projectName || payload.name || '').trim()

  let target = null
  if (explicitPath) {
    target = { name: null, path: explicitPath, source: 'explicit path' }
  } else if (requestedName) {
    const requestedNameLower = requestedName.toLowerCase()
    const recent = (projectState.recentProjects || []).find((project) => (
      String(project?.name || '').trim().toLowerCase() === requestedNameLower
    ))
    if (!recent?.path) {
      const knownNames = (projectState.recentProjects || [])
        .map((project) => String(project?.name || '').trim())
        .filter(Boolean)
      throw new Error(`No recent project named "${requestedName}". Known recent projects: ${knownNames.join(', ') || 'none'}.`)
    }
    target = { name: recent.name || null, path: recent.path, source: 'recent project' }
  } else {
    throw new Error('Provide projectPath or projectName. Use list_recent_projects to see known projects.')
  }

  const exists = window.electronAPI.exists ? await window.electronAPI.exists(target.path) : true
  if (!exists) {
    throw new Error(`No project folder found at "${target.path}".`)
  }

  const currentPath = typeof projectState.currentProjectHandle === 'string' ? projectState.currentProjectHandle : ''
  const alreadyOpen = Boolean(currentPath && currentPath === target.path)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'open_project',
      message: alreadyOpen
        ? 'This project is already open. Applying would reload it from disk.'
        : 'Open project plan only. No project was opened.',
      plan: {
        name: target.name,
        path: target.path,
        source: target.source,
        alreadyOpen,
        replacesOpenProject: Boolean(currentPath && !alreadyOpen),
        ...(currentPath && !alreadyOpen ? { currentProjectPath: currentPath } : {}),
      },
    }
  }

  const opened = await projectState.openProject?.(target.path)
  if (!opened) {
    const error = useProjectStore.getState().error
    throw new Error(error || `Could not open the project at "${target.path}".`)
  }

  const nextState = useProjectStore.getState()
  return {
    success: true,
    action: 'open_project',
    message: `Opened project "${nextState.currentProject?.name || target.path}".`,
    project: summarizeProject(nextState.currentProject, nextState.currentProjectHandle),
    currentTimelineId: nextState.currentTimelineId || null,
    reloaded: alreadyOpen,
  }
}

function buildDuplicateProjectSource(payload = {}) {
  const projectState = useProjectStore.getState()
  const explicitPath = String(payload.sourceProjectPath || payload.projectPath || payload.path || '').trim()
  const requestedName = String(payload.sourceProjectName || payload.projectName || '').trim().toLowerCase()
  const currentPath = typeof projectState.currentProjectHandle === 'string' ? projectState.currentProjectHandle : ''
  const currentName = String(projectState.currentProject?.name || '').trim()

  if (explicitPath) {
    return {
      name: String(payload.sourceProjectName || payload.projectName || currentName || '').trim() || null,
      path: explicitPath,
      source: 'explicit path',
    }
  }

  if (requestedName) {
    const recent = (projectState.recentProjects || []).find((project) => (
      String(project?.name || '').trim().toLowerCase() === requestedName
    ))
    if (recent?.path) {
      return {
        name: recent.name || null,
        path: recent.path,
        source: 'recent project',
      }
    }
  }

  if (currentPath) {
    return {
      name: currentName || null,
      path: currentPath,
      source: 'current project',
    }
  }

  return {
    name: null,
    path: '',
    source: '',
  }
}

async function buildDuplicateProjectPlan(payload = {}) {
  if (!window.electronAPI) {
    throw new Error('Project duplication through MCP is only available in the desktop app.')
  }
  const source = buildDuplicateProjectSource(payload)
  if (!source.path) {
    throw new Error('Provide sourceProjectPath/sourceProjectName, or open the project you want to duplicate first.')
  }

  const sourceExists = window.electronAPI.exists
    ? await window.electronAPI.exists(source.path)
    : true
  const sourceFolderName = window.electronAPI.pathBasename
    ? await window.electronAPI.pathBasename(source.path)
    : ''
  const sourceName = source.name || sourceFolderName || 'Project'
  let predictedName = `${sourceName} copy`
  let predictedPath = null
  if (window.electronAPI.pathDirname && window.electronAPI.pathJoin) {
    const parentPath = await window.electronAPI.pathDirname(source.path)
    let index = 1
    predictedPath = await window.electronAPI.pathJoin(parentPath, predictedName)
    while (window.electronAPI.exists && await window.electronAPI.exists(predictedPath)) {
      index += 1
      predictedName = `${sourceName} copy ${index}`
      predictedPath = await window.electronAPI.pathJoin(parentPath, predictedName)
    }
  }

  return {
    action: 'duplicate_project',
    previewOnly: payload.previewOnly !== false,
    sourceProject: {
      name: sourceName,
      path: source.path,
      source: source.source,
      exists: Boolean(sourceExists),
    },
    predictedDuplicate: {
      name: predictedName,
      path: predictedPath,
    },
    willOpenDuplicate: true,
    note: 'Uses Velorn duplicate behavior: copies the whole project folder, remaps saved paths, creates a sibling "copy" project, and opens it.',
  }
}

async function handleDuplicateProject(payload = {}) {
  const projectState = useProjectStore.getState()
  const plan = await buildDuplicateProjectPlan(payload)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'duplicate_project',
      message: 'Project duplicate plan only. No project folder was copied.',
      plan,
    }
  }

  if (!plan.sourceProject.exists) {
    throw new Error(`Source project folder was not found: ${plan.sourceProject.path}`)
  }

  const duplicated = await projectState.duplicateProject?.({
    name: plan.sourceProject.name,
    path: plan.sourceProject.path,
  })
  if (!duplicated) {
    const error = useProjectStore.getState().error
    throw new Error(error || 'Could not duplicate the project.')
  }

  const nextState = useProjectStore.getState()
  return {
    duplicated: true,
    action: 'duplicate_project',
    project: summarizeProject(nextState.currentProject || duplicated, nextState.currentProjectHandle),
    predictedDuplicate: plan.predictedDuplicate,
    currentTimelineId: nextState.currentTimelineId || null,
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

const MCP_ASSET_BATCH_MAX_ITEMS = 24

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
  'positionZ',
  'scaleX',
  'scaleY',
  'scaleLinked',
  'rotation',
  'rotationX',
  'rotationY',
  'perspective',
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
  'motionBlurEnabled',
  'motionBlurMode',
  'motionBlurSamples',
  'motionBlurShutter',
  'blendMode',
]

const TEXT_KEYFRAME_PROPERTIES = new Set([
  'opacity',
  'positionX',
  'positionY',
  'positionZ',
  'scaleX',
  'scaleY',
  'rotation',
  'rotationX',
  'rotationY',
  'perspective',
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
  motionBlurSamples: [8, 2, 48],
  motionBlurShutter: [180, 1, 360],
}

const TRANSFORM_BLEND_MODES = new Set([
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
])

const CLIP_VISUAL_KEYFRAME_TYPES = new Set(['video', 'image', 'text', 'shape', 'adjustment', 'caption', 'captions'])
const GLSL_EFFECT_TYPES = EFFECT_TYPES.filter((effect) => String(effect?.id || '').startsWith('glsl'))
const GLSL_EFFECT_TYPE_IDS = new Set(GLSL_EFFECT_TYPES.map((effect) => effect.id))
const GLSL_EFFECT_ALIASES = new Map([
  ['camerashake', 'glslCameraShake'],
  ['shake', 'glslCameraShake'],
  ['directionalblur', 'glslDirectionalBlur'],
  ['motionblur', 'glslDirectionalBlur'],
  ['lensblur', 'glslLensBlur'],
  ['bokeh', 'glslLensBlur'],
  ['fisheye', 'glslFisheye'],
  ['chromawarp', 'glslChromaWarp'],
  ['chromaticaberration', 'glslChromaWarp'],
  ['digitalglitch', 'glslDigitalGlitch'],
  ['glitch', 'glslDigitalGlitch'],
  ['sharpen', 'glslSharpen'],
  ['filmgrain', 'glslFilmGrain'],
  ['grain', 'glslFilmGrain'],
  ['filmlook', 'glslFilmLook'],
  ['look', 'glslFilmLook'],
  ['flicker', 'glslFlicker'],
  ['vhs', 'glslVhsLook'],
  ['vhslook', 'glslVhsLook'],
  ['vignette', 'glslVignette'],
])

const SHAPE_KEYFRAME_NUMBER_FIELDS = {
  width: [DEFAULT_SHAPE_PROPERTIES.width, 1, 20000],
  height: [DEFAULT_SHAPE_PROPERTIES.height, 1, 20000],
  fillOpacity: [DEFAULT_SHAPE_PROPERTIES.fillOpacity, 0, 100],
  gradientAngle: [DEFAULT_SHAPE_PROPERTIES.gradientAngle, -3600, 3600],
  gradientCenterX: [DEFAULT_SHAPE_PROPERTIES.gradientCenterX, -100, 200],
  gradientCenterY: [DEFAULT_SHAPE_PROPERTIES.gradientCenterY, -100, 200],
  gradientRadius: [DEFAULT_SHAPE_PROPERTIES.gradientRadius, 1, 400],
  strokeWidth: [DEFAULT_SHAPE_PROPERTIES.strokeWidth, 0, 2000],
  strokeOpacity: [DEFAULT_SHAPE_PROPERTIES.strokeOpacity, 0, 100],
  cornerRadius: [DEFAULT_SHAPE_PROPERTIES.cornerRadius, 0, 10000],
  sides: [DEFAULT_SHAPE_PROPERTIES.sides, 3, 64],
}
const SHAPE_KEYFRAME_PROPERTIES = new Set(Object.keys(SHAPE_KEYFRAME_NUMBER_FIELDS))

const CLIP_KEYFRAME_NUMBER_FIELDS = {
  ...TEXT_TRANSFORM_NUMBER_FIELDS,
  ...SHAPE_KEYFRAME_NUMBER_FIELDS,
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
    CLIP_KEYFRAME_NUMBER_FIELDS[`${group}.${property}`] = [0, -100, 100]
  }
  CLIP_KEYFRAME_NUMBER_FIELDS[`${group}.hue`] = [0, -180, 180]
}

const CLIP_KEYFRAME_PROPERTIES = new Set(Object.keys(CLIP_KEYFRAME_NUMBER_FIELDS))

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

function normalizeShapeStyleUpdates(payload = {}) {
  const source = {
    ...(payload.style && typeof payload.style === 'object' ? payload.style : {}),
    ...(payload.shapeProperties && typeof payload.shapeProperties === 'object' ? payload.shapeProperties : {}),
  }

  for (const key of ['shapeType', 'width', 'height', 'sizeLinked', 'fillType', 'gradientType', 'fillColor', 'fillColorB', 'fillB', 'gradientColor', 'gradientColorB', 'colorB', 'gradientFill', 'fillOpacity', 'gradientAngle', 'gradientCenterX', 'gradientCenterY', 'gradientRadius', 'strokeColor', 'strokeOpacity', 'strokeWidth', 'cornerRadius', 'sides', 'polygonSides']) {
    if (hasOwn(payload, key)) source[key] = payload[key]
  }
  if (hasOwn(payload, 'linkSize')) source.sizeLinked = payload.linkSize
  if (hasOwn(payload, 'linkedSize')) source.sizeLinked = payload.linkedSize
  if (hasOwn(payload, 'lockAspectRatio')) source.sizeLinked = payload.lockAspectRatio
  if (hasOwn(payload, 'type')) source.shapeType = payload.type
  if (hasOwn(payload, 'color')) source.fillColor = payload.color
  if (hasOwn(payload, 'fill')) source.fillColor = payload.fill
  if (hasOwn(payload, 'fillB')) source.fillColorB = payload.fillB
  if (hasOwn(payload, 'gradientFill')) source.fillColorB = payload.gradientFill
  if (hasOwn(payload, 'stroke')) source.strokeColor = payload.stroke
  if (hasOwn(payload, 'opacity')) source.fillOpacity = payload.opacity
  if (hasOwn(source, 'polygonSides') && !hasOwn(source, 'sides')) source.sides = source.polygonSides
  if (hasOwn(source, 'gradientType') && !hasOwn(source, 'fillType')) source.fillType = source.gradientType
  if (hasOwn(source, 'gradientColor') && !hasOwn(source, 'fillColorB')) source.fillColorB = source.gradientColor
  if (hasOwn(source, 'gradientColorB') && !hasOwn(source, 'fillColorB')) source.fillColorB = source.gradientColorB
  if (hasOwn(source, 'colorB') && !hasOwn(source, 'fillColorB')) source.fillColorB = source.colorB
  if (hasOwn(source, 'fillB') && !hasOwn(source, 'fillColorB')) source.fillColorB = source.fillB
  if (hasOwn(source, 'gradientFill') && !hasOwn(source, 'fillColorB')) source.fillColorB = source.gradientFill

  const updates = {}
  if (hasOwn(source, 'shapeType')) {
    const normalizedTypeOnly = normalizeShapeProperties({ shapeType: source.shapeType })
    updates.shapeType = normalizedTypeOnly.shapeType
    if (normalizedTypeOnly.shapeType === 'polygon' && !hasOwn(source, 'sides') && !hasOwn(source, 'polygonSides')) {
      updates.sides = normalizedTypeOnly.sides
    }
  }
  if (hasOwn(source, 'sizeLinked')) updates.sizeLinked = source.sizeLinked !== false
  if (hasOwn(source, 'fillType')) {
    updates.fillType = normalizeShapeProperties({ fillType: source.fillType }).fillType
  }

  const numberFields = {
    width: [DEFAULT_SHAPE_PROPERTIES.width, 1, 20000],
    height: [DEFAULT_SHAPE_PROPERTIES.height, 1, 20000],
    fillOpacity: [100, 0, 100],
    gradientAngle: [DEFAULT_SHAPE_PROPERTIES.gradientAngle, -3600, 3600],
    gradientCenterX: [DEFAULT_SHAPE_PROPERTIES.gradientCenterX, -100, 200],
    gradientCenterY: [DEFAULT_SHAPE_PROPERTIES.gradientCenterY, -100, 200],
    gradientRadius: [DEFAULT_SHAPE_PROPERTIES.gradientRadius, 1, 400],
    strokeOpacity: [100, 0, 100],
    strokeWidth: [0, 0, 2000],
    cornerRadius: [24, 0, 10000],
    sides: [DEFAULT_SHAPE_PROPERTIES.sides, 3, 64],
  }
  for (const [key, [fallback, min, max]] of Object.entries(numberFields)) {
    if (hasOwn(source, key)) {
      const nextValue = clampNumber(source[key], fallback, min, max)
      updates[key] = key === 'sides' ? Math.round(nextValue) : nextValue
    }
  }

  if (hasOwn(source, 'fillColor')) {
    const color = normalizeHexColor(source.fillColor)
    if (!color) throw new Error('Invalid fill color. Use a hex color like #38bdf8.')
    updates.fillColor = color
  }
  if (hasOwn(source, 'fillColorB')) {
    const color = normalizeHexColor(source.fillColorB)
    if (!color) throw new Error('Invalid second fill color. Use a hex color like #a855f7.')
    updates.fillColorB = color
  }
  if (hasOwn(source, 'strokeColor')) {
    const color = normalizeHexColor(source.strokeColor)
    if (!color) throw new Error('Invalid stroke color. Use a hex color like #ffffff.')
    updates.strokeColor = color
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
  for (const key of ['scaleLinked', 'flipH', 'flipV', 'motionBlurEnabled']) {
    if (hasOwn(source, key)) updates[key] = source[key] === true
  }
  if (hasOwn(source, 'motionBlurMode')) {
    const mode = String(source.motionBlurMode || '').trim().toLowerCase()
    updates.motionBlurMode = ['auto', 'velocity', 'sampled'].includes(mode) ? mode : 'auto'
  }
  if (hasOwn(source, 'blendMode')) {
    const mode = String(source.blendMode || '').trim().toLowerCase()
    updates.blendMode = TRANSFORM_BLEND_MODES.has(mode) ? mode : 'normal'
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
    effects: (clip.effects || []).map(summarizeClipEffect).filter(Boolean),
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

function buildShapeClipSummary(clip) {
  if (!clip) return null
  return {
    ...summarizeClip(clip),
    enabled: clip.enabled !== false,
    shapeProperties: clip.shapeProperties || {},
    transform: clip.transform || {},
    effects: (clip.effects || []).map(summarizeClipEffect).filter(Boolean),
    keyframes: clip.keyframes || {},
  }
}

function buildAdjustmentClipSummary(clip) {
  if (!clip) return null
  return {
    ...summarizeClip(clip),
    enabled: clip.enabled !== false,
    adjustments: normalizeAdjustmentSettings(clip.adjustments || {}),
    transform: clip.transform || {},
    effects: (clip.effects || []).map(summarizeClipEffect).filter(Boolean),
    keyframes: clip.keyframes || {},
  }
}

function getShapeClipById(state, clipId) {
  const id = String(clipId || '').trim()
  if (!id) throw new Error('No shape clip ID provided.')
  const clip = (state.clips || []).find((candidate) => candidate.id === id)
  if (!clip) throw new Error(`Shape clip ${id} was not found.`)
  if (clip.type !== 'shape') throw new Error(`Clip ${id} is a ${clip.type || 'unknown'} clip, not a shape clip.`)
  return clip
}

function normalizeAdjustmentClipSettings(payload = {}) {
  const source = {
    ...(payload.adjustments && typeof payload.adjustments === 'object' ? payload.adjustments : {}),
  }
  for (const key of ['brightness', 'contrast', 'saturation', 'gain', 'gamma', 'offset', 'hue', 'blur']) {
    if (hasOwn(payload, key)) source[key] = payload[key]
  }
  for (const group of ['shadows', 'midtones', 'highlights']) {
    if (payload[group] && typeof payload[group] === 'object') source[group] = payload[group]
  }
  return normalizeAdjustmentSettings(source)
}

function normalizeEffectLookupKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

function getGlslEffectDefinition(effectType) {
  const raw = String(effectType || '').trim()
  if (!raw) throw new Error('Provide effectType for the GLSL effect.')
  const direct = getEffectTypeDefinition(raw)
  if (direct && GLSL_EFFECT_TYPE_IDS.has(direct.id)) return direct
  const lookup = normalizeEffectLookupKey(raw)
  const aliasedId = GLSL_EFFECT_ALIASES.get(lookup)
  if (aliasedId) return getEffectTypeDefinition(aliasedId)
  const matched = GLSL_EFFECT_TYPES.find((effect) => (
    normalizeEffectLookupKey(effect.id) === lookup
    || normalizeEffectLookupKey(effect.label) === lookup
  ))
  if (matched) return matched
  throw new Error(`Unsupported GLSL effect "${raw}". Use list_glsl_effects for valid effectType IDs.`)
}

function summarizeGlslEffectDefinition(effect) {
  return {
    id: effect.id,
    label: effect.label,
    category: effect.category,
    description: effect.description,
    defaults: effect.defaults || {},
    params: (effect.params || []).map((param) => ({
      key: param.key,
      label: param.label,
      type: param.type || 'number',
      min: param.min,
      max: param.max,
      step: param.step,
      unit: param.unit || '',
    })),
    presets: (effect.presets || []).map((preset) => ({
      id: preset.id,
      label: preset.label,
      settings: preset.settings || {},
    })),
  }
}

function summarizeClipEffect(effect) {
  if (!effect) return null
  const definition = getEffectTypeDefinition(effect.type)
  return {
    id: effect.id,
    type: effect.type,
    label: definition?.label || effect.type,
    enabled: effect.enabled !== false,
    settings: effect.settings || {},
  }
}

function buildEffectClipSummary(clip) {
  if (!clip) return null
  return {
    ...summarizeClip(clip),
    enabled: clip.enabled !== false,
    effects: (clip.effects || []).map(summarizeClipEffect).filter(Boolean),
    keyframes: clip.keyframes || {},
  }
}

function getClipByIdForEffects(state, clipId) {
  const selectedIds = Array.isArray(state.selectedClipIds) ? state.selectedClipIds.filter(Boolean) : []
  const id = String(clipId || '').trim() || (selectedIds.length === 1 ? selectedIds[0] : '')
  if (!id) throw new Error('Provide clipId for the target clip, or select exactly one visual clip in Velorn.')
  const clip = (state.clips || []).find((candidate) => candidate.id === id)
  if (!clip) throw new Error(`Clip ${id} was not found.`)
  const clipType = String(clip.type || '').toLowerCase()
  if (!CLIP_VISUAL_KEYFRAME_TYPES.has(clipType)) {
    throw new Error(`Clip ${id} is a ${clip.type || 'unknown'} clip. GLSL effects currently support visual clips, not audio clips.`)
  }
  return clip
}

function collectEffectSettingsInput(payload = {}, effectDefinition = null) {
  const source = {
    ...(payload.settings && typeof payload.settings === 'object' ? payload.settings : {}),
  }
  for (const param of effectDefinition?.params || []) {
    if (hasOwn(payload, param.key)) source[param.key] = payload[param.key]
  }
  return source
}

function normalizeEffectToggleValue(value) {
  if (typeof value === 'boolean') return value ? 1 : 0
  const raw = String(value).trim().toLowerCase()
  if (['true', 'on', 'yes', 'enabled'].includes(raw)) return 1
  if (['false', 'off', 'no', 'disabled'].includes(raw)) return 0
  return Number(value) ? 1 : 0
}

function normalizeEffectParamValue(param, value, fallback) {
  if (param.type === 'toggle') return normalizeEffectToggleValue(value)
  return clampNumber(value, fallback ?? 0, param.min ?? -100000, param.max ?? 100000)
}

function getEffectPresetSettings(effectDefinition, presetId) {
  const id = String(presetId || '').trim()
  if (!id) return {}
  const lookup = normalizeEffectLookupKey(id)
  const preset = (effectDefinition.presets || []).find((candidate) => (
    normalizeEffectLookupKey(candidate.id) === lookup
    || normalizeEffectLookupKey(candidate.label) === lookup
  ))
  if (!preset) {
    throw new Error(`Preset "${id}" was not found for ${effectDefinition.id}. Use list_glsl_effects for valid preset IDs.`)
  }
  return preset.settings || {}
}

function normalizeGlslEffectSettings(effectDefinition, {
  existingSettings = {},
  inputSettings = {},
  presetId = '',
  includeDefaults = false,
} = {}) {
  const paramMap = new Map((effectDefinition.params || []).map((param) => [param.key, param]))
  const unknown = Object.keys(inputSettings || {}).filter((key) => !paramMap.has(key))
  if (unknown.length > 0) {
    throw new Error(`Unsupported setting(s) for ${effectDefinition.id}: ${unknown.join(', ')}. Supported settings: ${[...paramMap.keys()].join(', ')}.`)
  }

  const merged = {
    ...(includeDefaults ? (effectDefinition.defaults || {}) : {}),
    ...(existingSettings || {}),
    ...getEffectPresetSettings(effectDefinition, presetId),
    ...(inputSettings || {}),
  }
  const normalized = {}
  for (const param of effectDefinition.params || []) {
    if (!hasOwn(merged, param.key)) continue
    normalized[param.key] = normalizeEffectParamValue(param, merged[param.key], effectDefinition.defaults?.[param.key])
  }
  return normalized
}

function resolveGlslEffectTarget(clip, payload = {}) {
  const effects = (clip.effects || []).filter((effect) => GLSL_EFFECT_TYPE_IDS.has(effect.type))
  const effectId = String(payload.effectId || payload.id || '').trim()
  if (effectId) {
    const effect = effects.find((candidate) => candidate.id === effectId)
    if (!effect) throw new Error(`GLSL effect ${effectId} was not found on clip ${clip.id}.`)
    return effect
  }

  const effectType = String(payload.effectType || payload.type || '').trim()
  if (effectType) {
    const definition = getGlslEffectDefinition(effectType)
    const matches = effects.filter((effect) => effect.type === definition.id)
    if (matches.length === 0) throw new Error(`Clip ${clip.id} does not have a ${definition.id} effect yet.`)
    return matches[matches.length - 1]
  }

  if (effects.length === 1) return effects[0]
  if (effects.length === 0) throw new Error(`Clip ${clip.id} has no GLSL effects.`)
  throw new Error(`Clip ${clip.id} has ${effects.length} GLSL effects. Provide effectId or effectType.`)
}

function normalizeGlslEffectKeyframes(payload = {}, effectDefinition, effectId = '') {
  const paramMap = new Map((effectDefinition.params || []).map((param) => [param.key, param]))
  const rawKeyframes = Array.isArray(payload.keyframes) ? payload.keyframes : []
  return rawKeyframes.map((entry) => {
    const paramKey = String(entry?.param || entry?.parameter || entry?.property || '').trim()
    const param = paramMap.get(paramKey)
    if (!param) {
      throw new Error(`Unsupported keyframed setting "${paramKey}" for ${effectDefinition.id}. Supported settings: ${[...paramMap.keys()].join(', ')}.`)
    }
    const timeSeconds = Number(entry?.timeSeconds ?? entry?.time)
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0) {
      throw new Error(`Invalid keyframe time for ${paramKey}.`)
    }
    return {
      param: paramKey,
      property: effectId ? getEffectPropertyId(effectId, paramKey) : `effect.<new>.${paramKey}`,
      timeSeconds,
      value: normalizeEffectParamValue(param, entry?.value, effectDefinition.defaults?.[paramKey]),
      easing: String(entry?.easing || 'easeInOut').slice(0, 120),
    }
  })
}

function normalizeGlslEffectClearParams(clearKeyframes, effectDefinition) {
  if (!clearKeyframes) return []
  const paramKeys = new Set((effectDefinition.params || []).map((param) => param.key))
  const requested = clearKeyframes === true || clearKeyframes === 'all'
    ? [...paramKeys]
    : Array.isArray(clearKeyframes)
      ? clearKeyframes.map((item) => String(item || '').trim()).filter(Boolean)
      : []
  for (const paramKey of requested) {
    if (!paramKeys.has(paramKey)) {
      throw new Error(`Unsupported clearKeyframes setting "${paramKey}" for ${effectDefinition.id}.`)
    }
  }
  return [...new Set(requested)]
}

function clearGlslEffectKeyframes(clipId, effectId, params = []) {
  const cleared = params.map((paramKey) => getEffectPropertyId(effectId, paramKey))
  if (cleared.length === 0) return []
  useTimelineStore.setState((currentState) => ({
    clips: (currentState.clips || []).map((clip) => {
      if (clip.id !== clipId) return clip
      const nextKeyframes = { ...(clip.keyframes || {}) }
      for (const property of cleared) {
        delete nextKeyframes[property]
      }
      return { ...clip, keyframes: nextKeyframes }
    }),
  }))
  return cleared
}

function clearAllKeyframesForEffect(clipId, effectId) {
  const prefix = `effect.${effectId}.`
  let cleared = []
  useTimelineStore.setState((currentState) => ({
    clips: (currentState.clips || []).map((clip) => {
      if (clip.id !== clipId) return clip
      const nextKeyframes = { ...(clip.keyframes || {}) }
      cleared = Object.keys(nextKeyframes).filter((property) => property.startsWith(prefix))
      for (const property of cleared) {
        delete nextKeyframes[property]
      }
      return { ...clip, keyframes: nextKeyframes }
    }),
  }))
  return cleared
}

function applyGlslEffectKeyframes(state, clipId, effectId, keyframes = [], replaceKeyframes = false) {
  if (keyframes.length === 0) return []
  const hydrated = keyframes.map((keyframe) => ({
    ...keyframe,
    property: getEffectPropertyId(effectId, keyframe.param),
  }))
  if (replaceKeyframes) {
    clearGlslEffectKeyframes(clipId, effectId, [...new Set(hydrated.map((keyframe) => keyframe.param))])
  }
  for (const keyframe of hydrated) {
    state.setKeyframe?.(clipId, keyframe.property, keyframe.timeSeconds, keyframe.value, keyframe.easing, { saveHistory: false })
  }
  return hydrated
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

function normalizeClipKeyframes(payload = {}, clip = null) {
  const rawKeyframes = Array.isArray(payload.keyframes) ? payload.keyframes : []
  return rawKeyframes.map((entry) => {
    const property = String(entry?.property || '').trim()
    const [fallback, min, max] = CLIP_KEYFRAME_NUMBER_FIELDS[property] || []
    if (!CLIP_KEYFRAME_PROPERTIES.has(property)) {
      throw new Error(`Unsupported clip keyframe property "${property}".`)
    }
    if (SHAPE_KEYFRAME_PROPERTIES.has(property) && clip?.type !== 'shape') {
      throw new Error(`Shape keyframe property "${property}" can only be used on shape clips.`)
    }
    const timeSeconds = Number(entry?.timeSeconds ?? entry?.time)
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0) {
      throw new Error(`Invalid keyframe time for ${property}.`)
    }
    const rawValue = Number(entry?.value)
    if (!Number.isFinite(rawValue)) {
      throw new Error(`Invalid keyframe value for ${property}.`)
    }
    const clampedValue = clampNumber(rawValue, fallback, min, max)
    const value = property === 'sides' ? Math.round(clampedValue) : clampedValue
    return {
      property,
      timeSeconds,
      value,
      easing: String(entry?.easing || 'easeInOut').slice(0, 120),
    }
  })
}

function getClipByIdForKeyframes(state, clipId) {
  const id = String(clipId || '').trim()
  if (!id) throw new Error('No clip ID provided.')
  const clip = (state.clips || []).find((candidate) => candidate.id === id)
  if (!clip) throw new Error(`Clip ${id} was not found.`)
  const clipType = String(clip.type || '').toLowerCase()
  if (!CLIP_VISUAL_KEYFRAME_TYPES.has(clipType)) {
    throw new Error(`Clip ${id} is a ${clip.type || 'unknown'} clip. set_clip_keyframes currently supports visual clips, not audio clips.`)
  }
  return clip
}

function buildClipKeyframeSummary(clip) {
  if (!clip) return null
  return {
    ...summarizeClip(clip),
    enabled: clip.enabled !== false,
    transform: clip.transform || {},
    effects: (clip.effects || []).map(summarizeClipEffect).filter(Boolean),
    textProperties: clip.type === 'text' ? (clip.textProperties || {}) : undefined,
    shapeProperties: clip.type === 'shape' ? (clip.shapeProperties || {}) : undefined,
    keyframes: clip.keyframes || {},
  }
}

function validateClipKeyframePropertyForClip(property, clip = null) {
  if (clip && SHAPE_KEYFRAME_PROPERTIES.has(property) && clip.type !== 'shape') {
    throw new Error(`Shape keyframe property "${property}" can only be used on shape clips.`)
  }
}

function resolveClipKeyframeClearProperties(clearKeyframes, clip = null) {
  if (!clearKeyframes) return []
  const allPropertiesForClip = clip?.type === 'shape'
    ? [...CLIP_KEYFRAME_PROPERTIES]
    : [...CLIP_KEYFRAME_PROPERTIES].filter((property) => !SHAPE_KEYFRAME_PROPERTIES.has(property))
  const requested = clearKeyframes === true || clearKeyframes === 'all'
    ? allPropertiesForClip
    : Array.isArray(clearKeyframes)
      ? clearKeyframes.map((item) => String(item || '').trim()).filter(Boolean)
      : []
  for (const property of requested) {
    if (!CLIP_KEYFRAME_PROPERTIES.has(property)) {
      throw new Error(`Unsupported clip keyframe property "${property}".`)
    }
    validateClipKeyframePropertyForClip(property, clip)
  }
  return [...new Set(requested)]
}

function clearClipKeyframes(clipId, clearKeyframes, clip = null) {
  const targetClip = clip || (useTimelineStore.getState().clips || []).find((candidate) => candidate.id === clipId) || null
  const properties = resolveClipKeyframeClearProperties(clearKeyframes, targetClip)
  if (properties.length === 0) return []

  useTimelineStore.setState((currentState) => ({
    clips: (currentState.clips || []).map((clip) => {
      if (clip.id !== clipId) return clip
      const nextKeyframes = { ...(clip.keyframes || {}) }
      for (const property of properties) {
        delete nextKeyframes[property]
      }
      return { ...clip, keyframes: nextKeyframes }
    }),
  }))
  return properties
}

function applyClipKeyframes(state, clipId, keyframes = [], replaceKeyframes = false) {
  if (keyframes.length === 0) return []
  const replaceProperties = replaceKeyframes
    ? [...new Set(keyframes.map((keyframe) => keyframe.property))]
    : []
  if (replaceProperties.length > 0) {
    clearClipKeyframes(clipId, replaceProperties)
  }
  for (const keyframe of keyframes) {
    state.setKeyframe?.(clipId, keyframe.property, keyframe.timeSeconds, keyframe.value, keyframe.easing, { saveHistory: false })
  }
  return keyframes
}

function handleSetClipKeyframes(payload = {}) {
  const state = useTimelineStore.getState()
  const currentClip = getClipByIdForKeyframes(state, payload.clipId)
  const keyframes = normalizeClipKeyframes(payload, currentClip)
  const clearKeyframes = payload.clearKeyframes || payload.clearKeyframesForProperties
  const clearProperties = resolveClipKeyframeClearProperties(clearKeyframes, currentClip)

  if (keyframes.length === 0 && clearProperties.length === 0) {
    throw new Error('Provide at least one keyframe or clearKeyframes property.')
  }

  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      action: 'set_clip_keyframes',
      message: 'Clip keyframe plan only. No timeline change was made.',
      clip: buildClipKeyframeSummary(currentClip),
      requested: {
        keyframes,
        clearKeyframes: clearProperties,
        replaceKeyframes: payload.replaceKeyframes === true,
      },
    }
  }

  state.saveToHistory?.()
  const clearedKeyframes = clearClipKeyframes(currentClip.id, clearProperties, currentClip)
  const appliedKeyframes = applyClipKeyframes(useTimelineStore.getState(), currentClip.id, keyframes, payload.replaceKeyframes === true)
  const updatedClip = (useTimelineStore.getState().clips || []).find((clip) => clip.id === currentClip.id)

  return {
    updated: true,
    action: 'set_clip_keyframes',
    clip: buildClipKeyframeSummary(updatedClip),
    requested: {
      clearedKeyframes,
      appliedKeyframes,
      replaceKeyframes: payload.replaceKeyframes === true,
    },
  }
}

function resolveDipToBlackClipPairs(payload = {}, state = useTimelineStore.getState()) {
  const clips = state.clips || []
  const clipsById = new Map(clips.map((clip) => [clip.id, clip]))
  const explicitPairs = Array.isArray(payload.pairs) ? payload.pairs : (Array.isArray(payload.clipPairs) ? payload.clipPairs : [])

  if (explicitPairs.length > 0) {
    return explicitPairs.map((pair, index) => {
      const outClipId = String(pair?.outClipId || pair?.clipAId || pair?.fromClipId || pair?.firstClipId || '').trim()
      const inClipId = String(pair?.inClipId || pair?.clipBId || pair?.toClipId || pair?.secondClipId || '').trim()
      const outClip = clipsById.get(outClipId)
      const inClip = clipsById.get(inClipId)
      if (!outClip || !inClip) {
        return { index, error: `Pair ${index + 1} references a missing clip.` }
      }
      return { index, outClip, inClip }
    })
  }

  let clipIds = normalizeStringList(payload.clipIds || payload.clipId || payload.ids || payload.id)
  const filter = String(payload.filter || '').trim().toLowerCase()
  if (clipIds.length === 0 && (filter === 'selected' || payload.selected === true)) {
    clipIds = normalizeStringList(state.selectedClipIds || [])
  }

  let targetClips = clipIds.length > 0
    ? clipIds.map((clipId) => clipsById.get(clipId)).filter(Boolean)
    : []

  if (targetClips.length === 0 && (payload.trackId || payload.allAdjacent === true || filter === 'track')) {
    const requestedTrackId = String(payload.trackId || '').trim()
    targetClips = clips.filter((clip) => {
      if (requestedTrackId && clip.trackId !== requestedTrackId) return false
      return clip.enabled !== false && CLIP_VISUAL_KEYFRAME_TYPES.has(String(clip.type || '').toLowerCase())
    })
  }

  targetClips = targetClips
    .filter((clip) => clip && CLIP_VISUAL_KEYFRAME_TYPES.has(String(clip.type || '').toLowerCase()))
    .sort((a, b) => {
      if (a.trackId !== b.trackId) return String(a.trackId || '').localeCompare(String(b.trackId || ''))
      return (Number(a.startTime) || 0) - (Number(b.startTime) || 0)
    })

  if (targetClips.length < 2) {
    throw new Error('Provide at least two visual clip IDs, explicit clip pairs, selected clips, or a trackId for add_dip_to_black.')
  }

  const pairs = []
  for (let index = 0; index < targetClips.length - 1; index += 1) {
    pairs.push({
      index,
      outClip: targetClips[index],
      inClip: targetClips[index + 1],
    })
  }
  return pairs
}

function buildDipToBlackPlan(payload = {}) {
  const state = useTimelineStore.getState()
  const fps = Number(state.timelineFps) || 24
  const requestedDuration = Number(payload.durationSeconds ?? payload.duration ?? payload.fadeDurationSeconds ?? payload.fadeDuration)
  const defaultDuration = Number.isFinite(requestedDuration) && requestedDuration > 0 ? requestedDuration : 0.5
  const easing = String(payload.easing || 'easeInOut').slice(0, 120)
  const replaceOpacityKeyframes = payload.replaceOpacityKeyframes === true || payload.replaceKeyframes === true
  const pairs = resolveDipToBlackClipPairs(payload, state)
  const errors = pairs.filter((pair) => pair.error)
  if (errors.length > 0) {
    return {
      action: 'add_dip_to_black',
      success: false,
      errors,
      pairCount: 0,
      keyframesByClip: [],
    }
  }

  const keyframesByClip = new Map()
  for (const pair of pairs) {
    const outDuration = Math.max(1 / fps, Number(pair.outClip.duration) || (1 / fps))
    const inDuration = Math.max(1 / fps, Number(pair.inClip.duration) || (1 / fps))
    const outFade = roundToTimelineFrame(Math.min(defaultDuration, outDuration), fps)
    const inFade = roundToTimelineFrame(Math.min(defaultDuration, inDuration), fps)
    const outStart = roundToTimelineFrame(Math.max(0, outDuration - outFade), fps)
    const outEnd = roundToTimelineFrame(outDuration, fps)
    const inStart = 0
    const inEnd = roundToTimelineFrame(inFade, fps)

    const outKeyframes = [
      { property: 'opacity', timeSeconds: outStart, value: 100, easing },
      { property: 'opacity', timeSeconds: outEnd, value: 0, easing },
    ]
    const inKeyframes = [
      { property: 'opacity', timeSeconds: inStart, value: 0, easing },
      { property: 'opacity', timeSeconds: inEnd, value: 100, easing },
    ]

    if (!keyframesByClip.has(pair.outClip.id)) keyframesByClip.set(pair.outClip.id, [])
    if (!keyframesByClip.has(pair.inClip.id)) keyframesByClip.set(pair.inClip.id, [])
    keyframesByClip.get(pair.outClip.id).push(...outKeyframes)
    keyframesByClip.get(pair.inClip.id).push(...inKeyframes)
  }

  const dedupedKeyframesByClip = [...keyframesByClip.entries()].map(([clipId, keyframes]) => {
    const clip = (state.clips || []).find((candidate) => candidate.id === clipId)
    const seen = new Set()
    const deduped = keyframes
      .sort((a, b) => a.timeSeconds - b.timeSeconds)
      .filter((keyframe) => {
        const key = `${keyframe.property}:${keyframe.timeSeconds}:${keyframe.value}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    return {
      clip: summarizeClip(clip),
      keyframes: normalizeClipKeyframes({ keyframes: deduped }, clip),
    }
  })

  return {
    action: 'add_dip_to_black',
    previewOnly: payload.previewOnly !== false,
    pairCount: pairs.length,
    fadeDurationSeconds: roundToTimelineFrame(defaultDuration, fps),
    replaceOpacityKeyframes,
    easing,
    pairs: pairs.map((pair) => ({
      index: pair.index,
      outClip: summarizeClip(pair.outClip),
      inClip: summarizeClip(pair.inClip),
      editPointSeconds: roundToTimelineFrame(Number(pair.outClip.startTime || 0) + Number(pair.outClip.duration || 0), fps),
    })),
    keyframesByClip: dedupedKeyframesByClip,
    note: 'This helper only writes opacity keyframes. Put a black plate or empty black background underneath if lower layers should not show through.',
  }
}

function handleAddDipToBlack(payload = {}) {
  const plan = buildDipToBlackPlan(payload)
  if (plan.success === false) return plan

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'add_dip_to_black',
      message: `Dip-to-black plan only. ${plan.pairCount} edit point${plan.pairCount === 1 ? '' : 's'} would get opacity fades.`,
      plan,
    }
  }

  const state = useTimelineStore.getState()
  state.saveToHistory?.()
  const clearedClipIds = []
  if (plan.replaceOpacityKeyframes) {
    for (const entry of plan.keyframesByClip) {
      if (entry.clip?.id) {
        clearClipKeyframes(entry.clip.id, ['opacity'])
        clearedClipIds.push(entry.clip.id)
      }
    }
  }
  const applied = []
  for (const entry of plan.keyframesByClip) {
    if (!entry.clip?.id) continue
    applied.push({
      clipId: entry.clip.id,
      keyframes: applyClipKeyframes(useTimelineStore.getState(), entry.clip.id, entry.keyframes, false),
    })
  }

  return {
    success: true,
    action: 'add_dip_to_black',
    message: `Applied dip-to-black opacity fades to ${plan.pairCount} edit point${plan.pairCount === 1 ? '' : 's'}.`,
    pairCount: plan.pairCount,
    fadeDurationSeconds: plan.fadeDurationSeconds,
    clearedClipIds,
    applied,
  }
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

async function handlePrepareGenerationFromTimelineContext(payload = {}) {
  const state = useTimelineStore.getState()
  const mode = String(payload.mode || 'extend').trim().toLowerCase() === 'keyframe' ? 'keyframe' : 'extend'
  const workflowId = String(payload.workflowId || 'ltx23-i2v').trim() || 'ltx23-i2v'
  const category = String(payload.category || 'video').trim().toLowerCase() || 'video'
  const prompt = String(payload.prompt || '').trim().slice(0, 5000)
  const negativePrompt = String(payload.negativePrompt || '').trim().slice(0, 2000)
  const requestedResolution = resolveMcpGenerationResolution(payload)
  const timeSeconds = Number(payload.timeSeconds ?? payload.time)
  const frame = Number(payload.frame)
  const fps = Number(state.timelineFps) || 24
  const captureTime = roundToTimelineFrame(
    Number.isFinite(timeSeconds)
      ? timeSeconds
      : Number.isFinite(frame)
        ? frame / fps
        : Number(state.playheadPosition) || 0,
    fps
  )

  const top = getTopmostVideoOrImageClipAtTime(captureTime)
  if (!top?.clip) {
    throw new Error('No visible image or video clip is available at that timeline time.')
  }

  const captured = await captureTimelineFrameAt(captureTime, {
    mimeType: payload.mimeType || 'image/png',
    createBlobUrl: true,
  })
  if (!captured?.file) {
    throw new Error('Could not capture the timeline frame for Generate.')
  }

  const framePayload = {
    ...captured,
    mode,
    workflowId,
    prompt,
    negativePrompt,
    source: 'mcp',
    sourceClipId: top.clip.id,
    sourceTrackId: top.track?.id || null,
    capturedAt: captureTime,
    preparedAt: new Date().toISOString(),
  }
  useFrameForAIStore.getState().setFrame(framePayload)

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('comfystudio-mcp-prepare-generation', {
      detail: {
        mode,
        workflowId,
        category,
        prompt,
        negativePrompt,
        duration: Number.isFinite(Number(payload.durationSeconds ?? payload.duration))
          ? Number(payload.durationSeconds ?? payload.duration)
          : null,
        fps: Number.isFinite(Number(payload.fps)) ? Number(payload.fps) : null,
        resolution: requestedResolution,
        sourceClipId: top.clip.id,
        sourceTrackId: top.track?.id || null,
        capturedAt: captureTime,
      },
    }))
    if (payload.openGenerateTab !== false) {
      window.dispatchEvent(new CustomEvent('comfystudio-open-generate-with-frame'))
    }
  }

  return {
    success: true,
    action: 'prepare_generation_from_timeline_context',
    message: 'Timeline frame captured and sent to the Generate tab. No generation was queued.',
    mode,
    workflowId,
    category,
    promptApplied: Boolean(prompt),
    negativePromptApplied: Boolean(negativePrompt),
    openedGenerateTab: payload.openGenerateTab !== false,
    capturedFrame: {
      timeSeconds: captureTime,
      width: captured.width,
      height: captured.height,
      mimeType: captured.mimeType,
      size: captured.file?.size || 0,
    },
    sourceClip: summarizeClip(top.clip),
    sourceTrack: top.track ? summarizeTrack(top.track) : null,
  }
}

async function handleQueuePreparedGeneration(payload = {}) {
  if (typeof window === 'undefined') {
    throw new Error('Generate queue bridge is only available in the renderer.')
  }

  const timeoutMs = Math.min(30000, Math.max(1000, Number(payload.timeoutMs) || 10000))
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback(value)
    }

    const timeout = setTimeout(() => {
      finish(reject, new Error('Generate workspace did not respond to the MCP queue request. Open the Generate tab and try again.'))
    }, timeoutMs)

    window.dispatchEvent(new CustomEvent('comfystudio-mcp-queue-prepared-generation', {
      detail: {
        ...payload,
        respond: (result = {}) => {
          if (result?.success === false) {
            finish(reject, new Error(result.error || result.message || 'Could not queue the prepared generation.'))
            return
          }
          finish(resolve, result)
        },
      },
    }))
  })
}

async function handleQueueTimelineGenerationBatch(payload = {}) {
  if (typeof window === 'undefined') {
    throw new Error('Generate batch queue bridge is only available in the renderer.')
  }

  const jobs = Array.isArray(payload.jobs) ? payload.jobs : []
  if (jobs.length === 0) {
    throw new Error('No generation jobs were provided for the timeline batch.')
  }

  const firstJob = jobs[0] || {}
  const generationSettings = payload.generationSettings || {}
  const requestedResolution = resolveMcpGenerationResolution(generationSettings) || resolveMcpGenerationResolution(payload)
  const prepared = await handlePrepareGenerationFromTimelineContext({
    ...payload,
    workflowId: firstJob.workflowId || payload.workflowId || 'ltx23-i2v',
    category: 'video',
    mode: payload.mode || 'extend',
    timeSeconds: payload.frame?.timeSeconds ?? payload.timeSeconds ?? payload.time,
    frame: payload.frame?.frame ?? payload.frameNumber,
    prompt: firstJob.prompt ?? payload.prompt,
    negativePrompt: firstJob.negativePrompt ?? payload.negativePrompt,
    durationSeconds: generationSettings.durationSeconds ?? payload.durationSeconds ?? payload.duration,
    fps: generationSettings.fps ?? payload.fps,
    resolution: requestedResolution,
    openGenerateTab: payload.openGenerateTab === true,
    previewOnly: false,
  })

  const timeoutMs = Math.min(120000, Math.max(1000, Number(payload.timeoutMs) || 30000))
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback(value)
    }

    const timeout = setTimeout(() => {
      finish(reject, new Error('Generate workspace did not respond to the MCP batch queue request. Open the Generate tab and try again.'))
    }, timeoutMs)

    window.dispatchEvent(new CustomEvent('comfystudio-mcp-queue-timeline-generation-batch', {
      detail: {
        ...payload,
        capturedFrame: prepared?.capturedFrame || null,
        respond: (result = {}) => {
          if (result?.success === false) {
            finish(reject, new Error(result.error || result.message || 'Could not queue the timeline generation batch.'))
            return
          }
          finish(resolve, result)
        },
      },
    }))
  })
}

async function handleQueuePromptGenerationBatch(payload = {}) {
  if (typeof window === 'undefined') {
    throw new Error('Prompt generation batch queue bridge is only available in the renderer.')
  }

  const jobs = Array.isArray(payload.jobs) ? payload.jobs : []
  if (jobs.length === 0) {
    throw new Error('No generation jobs were provided for the prompt batch.')
  }

  const timeoutMs = Math.min(120000, Math.max(1000, Number(payload.timeoutMs) || 30000))
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback(value)
    }

    const timeout = setTimeout(() => {
      finish(reject, new Error('Generate workspace did not respond to the MCP prompt batch queue request. Open the Generate tab and try again.'))
    }, timeoutMs)

    window.dispatchEvent(new CustomEvent('comfystudio-mcp-queue-prompt-generation-batch', {
      detail: {
        ...payload,
        respond: (result = {}) => {
          if (result?.success === false) {
            finish(reject, new Error(result.error || result.message || 'Could not queue the prompt generation batch.'))
            return
          }
          finish(resolve, result)
        },
      },
    }))
  })
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

function summarizeTransition(transition) {
  if (!transition) return null
  return {
    id: transition.id,
    kind: transition.kind || (transition.clipId ? 'edge' : 'between'),
    type: transition.type || 'dissolve',
    duration: Number(transition.duration) || 0,
    clipAId: transition.clipAId || null,
    clipBId: transition.clipBId || null,
    clipId: transition.clipId || null,
    edge: transition.edge || null,
    settings: safeClone(transition.settings || {}),
  }
}

function normalizeTransitionType(value) {
  const normalized = String(value || 'dissolve').trim().toLowerCase()
  return normalized || 'dissolve'
}

function normalizeTransitionEdge(value) {
  return String(value || 'in').trim().toLowerCase() === 'out' ? 'out' : 'in'
}

function normalizeTransitionDuration(value, fallback = 0.5) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(10, parsed)
  return fallback
}

function normalizeTransitionSettings(payload = {}) {
  const settings = payload.settings && typeof payload.settings === 'object'
    ? safeClone(payload.settings)
    : {}
  const alignment = String(payload.alignment || settings.alignment || '').trim().toLowerCase()
  if (['start', 'center', 'end'].includes(alignment)) settings.alignment = alignment
  return settings
}

function handleAddTransition(payload = {}) {
  const state = useTimelineStore.getState()
  const clips = state.clips || []
  const transitions = state.transitions || []
  const clipAId = String(payload.clipAId || '').trim()
  const clipBId = String(payload.clipBId || '').trim()
  const clipId = String(payload.clipId || '').trim()
  const transitionType = normalizeTransitionType(payload.transitionType || payload.type)
  const duration = normalizeTransitionDuration(payload.durationSeconds ?? payload.duration, 0.5)
  const edge = normalizeTransitionEdge(payload.edge)
  const settings = normalizeTransitionSettings(payload)
  const kind = clipAId && clipBId ? 'between' : 'edge'

  if (kind === 'between') {
    const clipA = clips.find((clip) => clip.id === clipAId)
    const clipB = clips.find((clip) => clip.id === clipBId)
    if (!clipA || !clipB) throw new Error('Both clipAId and clipBId must refer to clips on the active timeline.')
    if (clipA.trackId !== clipB.trackId) throw new Error('Between transitions require two clips on the same track.')
    if (payload.previewOnly !== false) {
      return {
        previewOnly: true,
        action: 'add_transition',
        kind,
        transitionType,
        durationSeconds: duration,
        settings,
        clipA: summarizeClip(clipA),
        clipB: summarizeClip(clipB),
        existingTransition: summarizeTransition(transitions.find((transition) => (
          (transition.clipAId === clipAId && transition.clipBId === clipBId)
          || (transition.clipAId === clipBId && transition.clipBId === clipAId)
        ))),
      }
    }

    const created = state.addTransition?.(clipAId, clipBId, transitionType, duration)
    if (!created) throw new Error('Could not add the transition. Check clip timing and available handles.')
    if (Object.keys(settings).length > 0) {
      useTimelineStore.getState().updateTransition?.(created.id, {
        type: transitionType,
        duration,
        settings,
      })
    }
    const nextTransition = (useTimelineStore.getState().transitions || []).find((transition) => transition.id === created.id) || created
    return {
      created: true,
      transition: summarizeTransition(nextTransition),
      transitionCount: (useTimelineStore.getState().transitions || []).length,
    }
  }

  if (!clipId) throw new Error('Provide clipId plus edge for an edge transition, or clipAId and clipBId for a between transition.')
  const clip = clips.find((candidate) => candidate.id === clipId)
  if (!clip) throw new Error(`Clip ${clipId} was not found.`)
  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'add_transition',
      kind,
      transitionType,
      durationSeconds: duration,
      edge,
      settings,
      clip: summarizeClip(clip),
      existingTransition: summarizeTransition(transitions.find((transition) => (
        transition.kind === 'edge' && transition.clipId === clipId && transition.edge === edge
      ))),
    }
  }

  const created = state.addEdgeTransition?.(clipId, edge, transitionType, duration)
  if (!created) throw new Error('Could not add the edge transition. Check clip duration and transition settings.')
  if (Object.keys(settings).length > 0) {
    useTimelineStore.getState().updateTransition?.(created.id, {
      type: transitionType,
      duration,
      settings,
    })
  }
  const nextTransition = (useTimelineStore.getState().transitions || []).find((transition) => transition.id === created.id) || created
  return {
    created: true,
    transition: summarizeTransition(nextTransition),
    transitionCount: (useTimelineStore.getState().transitions || []).length,
  }
}

function handleUpdateTransition(payload = {}) {
  const transitionId = String(payload.transitionId || payload.id || '').trim()
  if (!transitionId) throw new Error('Provide transitionId.')

  const state = useTimelineStore.getState()
  const current = (state.transitions || []).find((transition) => transition.id === transitionId)
  if (!current) throw new Error(`Transition ${transitionId} was not found.`)

  const updates = {}
  if (payload.transitionType || payload.type) updates.type = normalizeTransitionType(payload.transitionType || payload.type)
  if (payload.durationSeconds !== undefined || payload.duration !== undefined) {
    updates.duration = normalizeTransitionDuration(payload.durationSeconds ?? payload.duration, Number(current.duration) || 0.5)
  }
  const settings = normalizeTransitionSettings(payload)
  if (Object.keys(settings).length > 0) updates.settings = settings

  if (Object.keys(updates).length === 0) {
    throw new Error('Provide at least one transition update: type, durationSeconds, alignment, or settings.')
  }

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'update_transition',
      before: summarizeTransition(current),
      updates,
      afterEstimate: {
        ...summarizeTransition(current),
        type: updates.type || current.type,
        duration: updates.duration ?? current.duration,
        settings: {
          ...(current.settings || {}),
          ...(updates.settings || {}),
        },
      },
    }
  }

  state.updateTransition?.(transitionId, updates)
  const next = (useTimelineStore.getState().transitions || []).find((transition) => transition.id === transitionId)
  return {
    updated: Boolean(next),
    transition: summarizeTransition(next),
  }
}

function handleRemoveTransitions(payload = {}) {
  const transitionIds = normalizeStringList(payload.transitionIds || payload.transitionId || payload.ids || payload.id)
  if (transitionIds.length === 0) throw new Error('Provide transitionId or transitionIds.')

  const state = useTimelineStore.getState()
  const transitions = state.transitions || []
  const transitionsById = new Map(transitions.map((transition) => [transition.id, transition]))
  const targets = transitionIds.map((id) => transitionsById.get(id)).filter(Boolean)
  const missingTransitionIds = transitionIds.filter((id) => !transitionsById.has(id))

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'remove_transitions',
      transitionCount: targets.length,
      missingTransitionIds,
      transitions: targets.map(summarizeTransition),
    }
  }

  targets.forEach((transition) => {
    useTimelineStore.getState().removeTransition?.(transition.id)
  })
  return {
    removedCount: targets.length,
    missingTransitionIds,
    removedTransitionIds: targets.map((transition) => transition.id),
    transitionCount: (useTimelineStore.getState().transitions || []).length,
  }
}

function normalizeClipEditEntries(payload = {}) {
  const entries = Array.isArray(payload.clips) || Array.isArray(payload.updates)
    ? (payload.clips || payload.updates)
    : [{ ...payload }]
  return entries
    .map((entry) => ({
      ...entry,
      clipId: String(entry?.clipId || entry?.id || '').trim(),
    }))
    .filter((entry) => entry.clipId)
}

function handleMoveClips(payload = {}) {
  const state = useTimelineStore.getState()
  const clips = state.clips || []
  const tracks = state.tracks || []
  const fps = Number(state.timelineFps) || 24
  const entries = normalizeClipEditEntries(payload)
  if (entries.length === 0) throw new Error('Provide clipId or clips with clipId.')
  if (entries.length > 100) throw new Error('move_clips is limited to 100 clips per call.')

  const plans = entries.map((entry) => {
    const clip = clips.find((candidate) => candidate.id === entry.clipId)
    if (!clip) return { clipId: entry.clipId, error: 'Clip not found.' }
    const trackId = String(entry.trackId || payload.trackId || clip.trackId || '').trim()
    const track = tracks.find((candidate) => candidate.id === trackId)
    if (!track) return { clipId: entry.clipId, error: `Track ${trackId} was not found.` }
    if (track.locked) return { clipId: entry.clipId, error: `Track ${trackId} is locked.` }
    const startValue = entry.startSeconds ?? entry.startTime ?? payload.startSeconds ?? payload.startTime ?? clip.startTime
    const startSeconds = roundToTimelineFrame(Math.max(0, Number(startValue) || 0), fps)
    return {
      clip: summarizeClip(clip),
      targetTrack: summarizeTrack(track),
      startSeconds,
      previousStartSeconds: Number(clip.startTime) || 0,
      previousTrackId: clip.trackId || null,
    }
  })
  const errors = plans.filter((plan) => plan.error)
  if (errors.length > 0) {
    return {
      success: false,
      action: 'move_clips',
      errors,
      validMoveCount: plans.length - errors.length,
    }
  }

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'move_clips',
      resolveOverlaps: payload.resolveOverlaps === true,
      moveCount: plans.length,
      moves: plans,
    }
  }

  state.saveToHistory?.()
  plans.forEach((plan) => {
    useTimelineStore.getState().moveClip?.(plan.clip.id, plan.targetTrack.id, plan.startSeconds, payload.resolveOverlaps === true)
  })
  const nextClips = useTimelineStore.getState().clips || []
  return {
    movedCount: plans.length,
    clips: plans.map((plan) => summarizeClip(nextClips.find((clip) => clip.id === plan.clip.id) || plan.clip)),
  }
}

function handleTrimClips(payload = {}) {
  const state = useTimelineStore.getState()
  const clips = state.clips || []
  const fps = Number(state.timelineFps) || 24
  const entries = normalizeClipEditEntries(payload)
  if (entries.length === 0) throw new Error('Provide clipId or clips with clipId.')
  if (entries.length > 100) throw new Error('trim_clips is limited to 100 clips per call.')

  const plans = entries.map((entry) => {
    const clip = clips.find((candidate) => candidate.id === entry.clipId)
    if (!clip) return { clipId: entry.clipId, error: 'Clip not found.' }
    const updates = {}
    if (entry.startSeconds !== undefined || entry.startTime !== undefined) {
      updates.startTime = roundToTimelineFrame(Math.max(0, Number(entry.startSeconds ?? entry.startTime) || 0), fps)
    }
    if (entry.durationSeconds !== undefined || entry.duration !== undefined) {
      const duration = Number(entry.durationSeconds ?? entry.duration)
      if (!Number.isFinite(duration) || duration <= 0) return { clipId: entry.clipId, error: 'durationSeconds must be greater than 0.' }
      updates.duration = roundToTimelineFrame(duration, fps)
    }
    if (entry.trimStartSeconds !== undefined || entry.trimStart !== undefined) {
      updates.trimStart = Math.max(0, Number(entry.trimStartSeconds ?? entry.trimStart) || 0)
    }
    if (entry.trimEndSeconds !== undefined || entry.trimEnd !== undefined) {
      updates.trimEnd = Math.max(0, Number(entry.trimEndSeconds ?? entry.trimEnd) || 0)
    }
    if (Object.keys(updates).length === 0) return { clipId: entry.clipId, error: 'No trim/timing updates were provided.' }
    return {
      clip: summarizeClip(clip),
      before: {
        startTime: Number(clip.startTime) || 0,
        duration: Number(clip.duration) || 0,
        trimStart: Number(clip.trimStart) || 0,
        trimEnd: Number(clip.trimEnd) || null,
      },
      updates,
    }
  })
  const errors = plans.filter((plan) => plan.error)
  if (errors.length > 0) {
    return {
      success: false,
      action: 'trim_clips',
      errors,
      validTrimCount: plans.length - errors.length,
    }
  }

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'trim_clips',
      trimCount: plans.length,
      trims: plans,
    }
  }

  state.saveToHistory?.()
  plans.forEach((plan) => {
    useTimelineStore.getState().updateClipTrim?.(plan.clip.id, plan.updates)
  })
  const nextClips = useTimelineStore.getState().clips || []
  return {
    trimmedCount: plans.length,
    clips: plans.map((plan) => summarizeClip(nextClips.find((clip) => clip.id === plan.clip.id) || plan.clip)),
  }
}

function resolveDeleteClipIds(payload = {}, clips = []) {
  const explicit = normalizeStringList(payload.clipIds || payload.clipId || payload.ids || payload.id)
  if (explicit.length > 0) return explicit
  const filter = String(payload.filter || '').trim().toLowerCase()
  if (filter === 'disabled') return clips.filter((clip) => clip.enabled === false).map((clip) => clip.id)
  if (filter === 'selected') return normalizeStringList(useTimelineStore.getState().selectedClipIds || [])
  if (filter === 'labeled') return clips.filter((clip) => clip.labelColor).map((clip) => clip.id)
  return []
}

function handleDeleteClips(payload = {}) {
  const state = useTimelineStore.getState()
  const clips = state.clips || []
  const clipIds = [...new Set(resolveDeleteClipIds(payload, clips))]
  if (clipIds.length === 0) throw new Error('Provide clipId/clipIds, or use filter "disabled", "selected", or "labeled".')
  const limit = Math.max(1, Math.min(1000, Number(payload.limit) || 100))
  if (clipIds.length > limit) throw new Error(`delete_clips matched ${clipIds.length} clips, above limit ${limit}.`)

  const clipsById = new Map(clips.map((clip) => [clip.id, clip]))
  const targets = clipIds.map((id) => clipsById.get(id)).filter(Boolean)
  const missingClipIds = clipIds.filter((id) => !clipsById.has(id))

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'delete_clips',
      deleteCount: targets.length,
      ripple: payload.ripple === true,
      filter: payload.filter || null,
      missingClipIds,
      clips: targets.map(summarizeClip),
    }
  }

  if (payload.ripple === true) {
    state.rippleDeleteClipIds?.(targets.map((clip) => clip.id))
  } else {
    targets.forEach((clip) => {
      useTimelineStore.getState().removeClip?.(clip.id)
    })
  }
  return {
    deletedCount: targets.length,
    ripple: payload.ripple === true,
    missingClipIds,
    deletedClipIds: targets.map((clip) => clip.id),
    clipCount: (useTimelineStore.getState().clips || []).length,
  }
}

function handleUpdateTrack(payload = {}) {
  const state = useTimelineStore.getState()
  const trackId = String(payload.trackId || payload.id || '').trim()
  if (!trackId) throw new Error('Provide trackId.')
  const current = (state.tracks || []).find((track) => track.id === trackId)
  if (!current) throw new Error(`Track ${trackId} was not found.`)

  const updates = {}
  if (Object.prototype.hasOwnProperty.call(payload, 'name')) updates.name = String(payload.name || '').trim().slice(0, 80)
  if (Object.prototype.hasOwnProperty.call(payload, 'muted')) updates.muted = payload.muted === true
  if (Object.prototype.hasOwnProperty.call(payload, 'locked')) updates.locked = payload.locked === true
  if (Object.prototype.hasOwnProperty.call(payload, 'visible')) updates.visible = payload.visible !== false
  if (current.type === 'audio' && Object.prototype.hasOwnProperty.call(payload, 'channels')) updates.channels = normalizeAudioChannels(payload.channels)
  const newIndex = Number(payload.index ?? payload.newIndex)
  const shouldReorder = Number.isFinite(newIndex)
  if (Object.keys(updates).length === 0 && !shouldReorder) {
    throw new Error('Provide a track update such as name, muted, locked, visible, channels, or index.')
  }

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'update_track',
      before: summarizeTrack(current),
      updates,
      newIndex: shouldReorder ? Math.max(0, Math.floor(newIndex)) : null,
    }
  }

  state.saveToHistory?.()
  useTimelineStore.setState((currentState) => {
    let tracks = (currentState.tracks || []).map((track) => (
      track.id === trackId
        ? { ...track, ...updates }
        : track
    ))
    if (shouldReorder) {
      const updatedTrack = tracks.find((track) => track.id === trackId)
      const sameType = tracks.filter((track) => track.type === updatedTrack.type)
      const otherType = tracks.filter((track) => track.type !== updatedTrack.type)
      const currentIndex = sameType.findIndex((track) => track.id === trackId)
      const clampedIndex = Math.max(0, Math.min(sameType.length - 1, Math.floor(newIndex)))
      if (currentIndex >= 0 && currentIndex !== clampedIndex) {
        const reordered = [...sameType]
        const [removed] = reordered.splice(currentIndex, 1)
        reordered.splice(clampedIndex, 0, removed)
        const videoTracks = updatedTrack.type === 'video' ? reordered : otherType.filter((track) => track.type === 'video')
        const audioTracks = updatedTrack.type === 'audio' ? reordered : otherType.filter((track) => track.type === 'audio')
        tracks = [...videoTracks, ...audioTracks]
      }
    }
    return { tracks }
  })
  const next = (useTimelineStore.getState().tracks || []).find((track) => track.id === trackId)
  return {
    updated: true,
    track: summarizeTrack(next),
  }
}

function handleRemoveTrack(payload = {}) {
  const state = useTimelineStore.getState()
  const trackId = String(payload.trackId || payload.id || '').trim()
  if (!trackId) throw new Error('Provide trackId.')
  const track = (state.tracks || []).find((candidate) => candidate.id === trackId)
  if (!track) throw new Error(`Track ${trackId} was not found.`)
  const clipsOnTrack = (state.clips || []).filter((clip) => clip.trackId === trackId)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'remove_track',
      track: summarizeTrack(track),
      removedClipCount: clipsOnTrack.length,
      clips: clipsOnTrack.slice(0, 50).map(summarizeClip),
      clipLimitApplied: clipsOnTrack.length > 50,
    }
  }

  const removed = state.removeTrack?.(trackId)
  if (!removed) throw new Error('Could not remove the track. Velorn may be protecting the last track of that type.')
  return {
    removed: true,
    trackId,
    removedClipCount: clipsOnTrack.length,
    trackCount: (useTimelineStore.getState().tracks || []).length,
  }
}

async function handleSwitchTimeline(payload = {}) {
  const timelineId = String(payload.timelineId || payload.id || '').trim()
  if (!timelineId) throw new Error('Provide timelineId.')
  const projectState = useProjectStore.getState()
  const timelines = projectState.currentProject?.timelines || []
  const timeline = timelines.find((candidate) => candidate.id === timelineId)
  if (!timeline) throw new Error(`Timeline ${timelineId} was not found.`)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'switch_timeline',
      timeline: summarizeTimeline(timeline, projectState.currentProject?.settings || {}),
    }
  }

  const switched = await projectState.switchTimeline?.(timelineId)
  return {
    switched: Boolean(switched),
    timeline: summarizeTimeline(timeline, projectState.currentProject?.settings || {}),
  }
}

function handleRenameTimeline(payload = {}) {
  const timelineId = String(payload.timelineId || payload.id || '').trim()
  const name = normalizeTimelineName(payload.name || payload.timelineName || payload.sequenceName, '')
  if (!timelineId) throw new Error('Provide timelineId.')
  if (!name) throw new Error('Provide a new timeline name.')
  const projectState = useProjectStore.getState()
  const timelines = projectState.currentProject?.timelines || []
  const timeline = timelines.find((candidate) => candidate.id === timelineId)
  if (!timeline) throw new Error(`Timeline ${timelineId} was not found.`)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'rename_timeline',
      before: summarizeTimeline(timeline, projectState.currentProject?.settings || {}),
      name,
    }
  }

  projectState.renameTimeline?.(timelineId, name)
  const next = (useProjectStore.getState().currentProject?.timelines || []).find((candidate) => candidate.id === timelineId)
  return {
    renamed: true,
    timeline: summarizeTimeline(next || { ...timeline, name }, projectState.currentProject?.settings || {}),
  }
}

async function handleDuplicateTimeline(payload = {}) {
  const timelineId = String(payload.timelineId || payload.id || '').trim()
  if (!timelineId) throw new Error('Provide timelineId.')
  const projectState = useProjectStore.getState()
  const timelines = projectState.currentProject?.timelines || []
  const timeline = timelines.find((candidate) => candidate.id === timelineId)
  if (!timeline) throw new Error(`Timeline ${timelineId} was not found.`)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'duplicate_timeline',
      source: summarizeTimeline(timeline, projectState.currentProject?.settings || {}),
      switchToTimeline: payload.switchToTimeline === true || payload.activate === true,
    }
  }

  const duplicate = projectState.duplicateTimeline?.(timelineId)
  if (!duplicate) throw new Error('Could not duplicate the timeline.')
  if (payload.name || payload.timelineName || payload.sequenceName) {
    projectState.renameTimeline?.(duplicate.id, normalizeTimelineName(payload.name || payload.timelineName || payload.sequenceName, duplicate.name))
  }
  let switched = false
  if (payload.switchToTimeline === true || payload.activate === true) {
    switched = await projectState.switchTimeline?.(duplicate.id)
  }
  const next = (useProjectStore.getState().currentProject?.timelines || []).find((candidate) => candidate.id === duplicate.id) || duplicate
  return {
    duplicated: true,
    switched: Boolean(switched),
    timeline: summarizeTimeline(next, projectState.currentProject?.settings || {}),
  }
}

function handleDeleteTimeline(payload = {}) {
  const timelineId = String(payload.timelineId || payload.id || '').trim()
  if (!timelineId) throw new Error('Provide timelineId.')
  const projectState = useProjectStore.getState()
  const timelines = projectState.currentProject?.timelines || []
  const timeline = timelines.find((candidate) => candidate.id === timelineId)
  if (!timeline) throw new Error(`Timeline ${timelineId} was not found.`)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'delete_timeline',
      timeline: summarizeTimeline(timeline, projectState.currentProject?.settings || {}),
      warning: 'Deleting a timeline removes that sequence from the project.',
    }
  }

  const deleted = projectState.deleteTimeline?.(timelineId)
  if (!deleted) throw new Error('Could not delete the timeline. Velorn may be protecting the last sequence.')
  return {
    deleted: true,
    timelineId,
    timelineCount: (useProjectStore.getState().currentProject?.timelines || []).length,
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

function normalizeOptionalTimelineColor(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase()
  throw new Error('Invalid timeline color. Use a hex color like #38bdf8 or omit it.')
}

function summarizeTimeline(timeline, projectSettings = {}) {
  if (!timeline) return null
  const tracks = Array.isArray(timeline.tracks) ? timeline.tracks : []
  const clips = Array.isArray(timeline.clips) ? timeline.clips : []
  return {
    id: timeline.id,
    name: timeline.name || timeline.id,
    width: Number(timeline.width || projectSettings.width || 1920),
    height: Number(timeline.height || projectSettings.height || 1080),
    fps: Number(timeline.fps || projectSettings.fps || 24),
    duration: Number(timeline.duration) || 0,
    trackCount: tracks.length,
    clipCount: clips.length,
    color: timeline.color || null,
    folderId: timeline.folderId || null,
  }
}

function buildCreateTimelinePlan(payload = {}) {
  const projectState = useProjectStore.getState()
  const project = projectState.currentProject
  if (!project) throw new Error('Open a saved project before creating a sequence.')

  const timelines = project.timelines || []
  const currentSettings = typeof projectState.getCurrentTimelineSettings === 'function'
    ? projectState.getCurrentTimelineSettings()
    : null
  const projectSettings = project.settings || {}
  const copySettingsFromCurrent = payload.copySettingsFromCurrent !== false
  const settingsSource = copySettingsFromCurrent ? (currentSettings || projectSettings) : projectSettings
  const requestedName = normalizeTimelineName(payload.name || payload.timelineName || payload.sequenceName)
  const name = payload.allowDuplicateName === true
    ? requestedName
    : createUniqueTimelineName(requestedName, timelines)
  const requestedDuration = Number(payload.durationSeconds ?? payload.duration)
  const durationSeconds = Number.isFinite(requestedDuration) && requestedDuration > 0
    ? roundToTimelineFrame(requestedDuration, normalizeTimelineFps(payload.fps, settingsSource?.fps || 24))
    : 60

  return {
    action: 'create_timeline',
    previewOnly: payload.previewOnly !== false,
    requestedName,
    name,
    nameAdjusted: name !== requestedName,
    width: normalizeTimelineDimension(payload.width, settingsSource?.width || projectSettings.width || 1920),
    height: normalizeTimelineDimension(payload.height, settingsSource?.height || projectSettings.height || 1080),
    fps: normalizeTimelineFps(payload.fps, settingsSource?.fps || projectSettings.fps || 24),
    durationSeconds,
    color: normalizeOptionalTimelineColor(payload.color),
    folderId: String(payload.folderId || '').trim() || null,
    copySettingsFromCurrent,
    switchToTimeline: payload.switchToTimeline !== false && payload.activate !== false && payload.makeActive !== false,
    existingTimelineCount: timelines.length,
  }
}

async function handleCreateTimeline(payload = {}) {
  const projectState = useProjectStore.getState()
  const plan = buildCreateTimelinePlan(payload)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'create_timeline',
      message: 'Sequence creation plan only. No timeline was created.',
      plan,
    }
  }

  const timeline = projectState.createTimeline?.({
    name: plan.name,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    durationSeconds: plan.durationSeconds,
    color: plan.color,
    folderId: plan.folderId,
  })
  if (!timeline) throw new Error('Could not create the sequence.')

  let switched = false
  if (plan.switchToTimeline && timeline.id) {
    switched = await useProjectStore.getState().switchTimeline?.(timeline.id)
  }

  const nextProjectState = useProjectStore.getState()
  const createdTimeline = (nextProjectState.currentProject?.timelines || []).find((candidate) => candidate.id === timeline.id) || timeline
  return {
    created: true,
    action: 'create_timeline',
    timeline: summarizeTimeline(createdTimeline, nextProjectState.currentProject?.settings || {}),
    switchToTimeline: plan.switchToTimeline,
    switched,
    currentTimelineId: nextProjectState.currentTimelineId || null,
    timelineCount: (nextProjectState.currentProject?.timelines || []).length,
  }
}

function summarizeAssetFolder(folder = null) {
  if (!folder) return null
  return {
    id: folder.id,
    name: folder.name || folder.id,
    parentId: folder.parentId || null,
    color: folder.color || null,
    createdAt: folder.createdAt || folder.created || null,
  }
}

function normalizeAssetFolderName(value, fallback = 'New Folder') {
  const normalized = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return normalized || fallback
}

function splitAssetFolderPathInput(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeAssetFolderName(entry, '')).filter(Boolean)
  }
  const raw = String(value || '').trim()
  if (!raw) return []
  return raw
    .split(/[\\/]+/)
    .map((entry) => normalizeAssetFolderName(entry, ''))
    .filter(Boolean)
}

function findAssetFolderByName(folders = [], parentId = null, name = '') {
  const key = String(name || '').trim().toLowerCase()
  if (!key) return null
  return (folders || []).find((folder) => (
    (folder?.parentId || null) === (parentId || null)
    && String(folder?.name || '').trim().toLowerCase() === key
  )) || null
}

function makeUniqueAssetFolderName(name, folders = [], parentId = null) {
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

function resolveAssetFolderParent(payload = {}, folders = []) {
  const parentId = String(payload.parentId || payload.parentFolderId || '').trim() || null
  const parentPath = splitAssetFolderPathInput(payload.parentPath || payload.parentFolderPath || [])

  if (parentId) {
    const parent = folders.find((folder) => folder?.id === parentId) || null
    if (!parent) throw new Error(`Parent folder ${parentId} was not found.`)
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
      throw new Error(`Parent folder path "${parentPath.join(' / ')}" was not found. Use path/folderPath to create missing folders.`)
    }
    cursor = folder.id
  }

  return { parentId: cursor, parentPath }
}

function buildCreateAssetFolderPlan(payload = {}) {
  const project = useProjectStore.getState().currentProject
  if (!project) throw new Error('Open a saved project before creating an asset folder.')

  const folders = useAssetsStore.getState().folders || []
  const rawPath = payload.path ?? payload.folderPath ?? payload.segments ?? payload.folderSegments
  const pathSegments = splitAssetFolderPathInput(rawPath)
  const nameSegments = pathSegments.length > 0
    ? pathSegments
    : [normalizeAssetFolderName(payload.name || payload.folderName)]

  if (nameSegments.length === 0) throw new Error('Provide a folder name or folder path.')

  const parent = resolveAssetFolderParent(payload, folders)
  const reuseExisting = payload.reuseExisting !== false
  const allowDuplicateName = payload.allowDuplicateName === true
  const rawColor = String(payload.color || '').trim()
  const color = rawColor ? normalizeClipLabelColor(rawColor) : null
  if (rawColor && !color) throw new Error('Invalid folder color. Use a hex color like #38bdf8 or omit it.')

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
      ? makeUniqueAssetFolderName(segment, simulatedFolders, cursor)
      : segment
    const plannedId = `planned-folder-${steps.length + 1}`
    steps.push({
      action: 'create',
      name,
      requestedName: segment,
      nameAdjusted: name !== segment,
      parentId: cursor,
      folder: {
        id: null,
        name,
        parentId: cursor,
        color: null,
      },
    })
    simulatedFolders.push({
      id: plannedId,
      name,
      parentId: cursor,
      color: null,
    })
    cursor = plannedId
  }

  const lastStep = steps[steps.length - 1] || null
  const leafExistingFolder = lastStep?.action === 'reuse'
    ? folders.find((folder) => folder?.id === lastStep.folderId) || null
    : null

  return {
    action: 'create_asset_folder',
    previewOnly: payload.previewOnly !== false,
    path: [...parent.parentPath, ...nameSegments],
    requestedPath: nameSegments,
    parentId: parent.parentId || null,
    reuseExisting,
    allowDuplicateName,
    color,
    setColorOnExisting: payload.setColorOnExisting === true,
    steps,
    createdCount: steps.filter((step) => step.action === 'create').length,
    reusedCount: steps.filter((step) => step.action === 'reuse').length,
    leafFolder: summarizeAssetFolder(leafExistingFolder),
    leafFolderId: leafExistingFolder?.id || null,
  }
}

async function handleCreateAssetFolder(payload = {}) {
  const plan = buildCreateAssetFolderPlan(payload)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'create_asset_folder',
      message: plan.createdCount === 0
        ? 'Asset folder already exists. No project change was made.'
        : `Asset folder plan only. ${plan.createdCount} folder${plan.createdCount === 1 ? '' : 's'} would be created.`,
      plan,
    }
  }

  const createdFolders = []
  let cursor = plan.parentId || null
  let leafFolder = null

  for (const step of plan.steps) {
    if (step.action === 'reuse') {
      leafFolder = (useAssetsStore.getState().folders || []).find((folder) => folder?.id === step.folderId) || null
      cursor = leafFolder?.id || cursor
      continue
    }

    const state = useAssetsStore.getState()
    if (typeof state.addFolder !== 'function') throw new Error('Asset folder creation is not available.')
    const folder = state.addFolder({
      name: step.name,
      parentId: cursor,
      color: null,
    })
    if (!folder) throw new Error(`Could not create asset folder "${step.name}".`)
    createdFolders.push(folder)
    leafFolder = folder
    cursor = folder.id
  }

  if (plan.color && leafFolder?.id && (createdFolders.some((folder) => folder.id === leafFolder.id) || plan.setColorOnExisting)) {
    useAssetsStore.getState().setFolderColor?.(leafFolder.id, plan.color)
    leafFolder = {
      ...leafFolder,
      color: plan.color,
    }
  }

  const folders = useAssetsStore.getState().folders || []
  const savedProject = typeof useProjectStore.getState().saveProject === 'function'
    ? await useProjectStore.getState().saveProject()
    : null

  return {
    created: createdFolders.length > 0,
    action: 'create_asset_folder',
    message: createdFolders.length > 0
      ? `Created ${createdFolders.length} asset folder${createdFolders.length === 1 ? '' : 's'}.`
      : 'Asset folder already existed.',
    folder: summarizeAssetFolder(leafFolder),
    folderId: leafFolder?.id || null,
    path: getAssetFolderPathSegments(folders, leafFolder?.id || null),
    createdCount: createdFolders.length,
    reusedCount: plan.reusedCount,
    createdFolders: createdFolders.map(summarizeAssetFolder),
    savedProject: Boolean(savedProject),
  }
}

function resolveAssetFolderPathToId(folders = [], pathSegments = []) {
  const segments = Array.isArray(pathSegments) ? pathSegments : []
  let cursor = null
  for (const segment of segments) {
    const folder = findAssetFolderByName(folders, cursor, segment)
    if (!folder) return null
    cursor = folder.id
  }
  return cursor
}

function getDescendantAssetFolderIds(folders = [], folderId = null) {
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

function getAssetMoveCreatedTime(asset) {
  const raw = asset?.createdAt || asset?.imported || asset?.created || asset?.modified || ''
  const parsed = raw ? Date.parse(raw) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function isMcpSolidColorAsset(asset = {}) {
  const settings = asset.settings || {}
  const sourceTool = String(asset.sourceTool || settings.sourceTool || '').trim().toLowerCase()
  const overlayKind = String(asset.overlayKind || settings.overlayKind || '').trim().toLowerCase()
  const generatedBy = String(asset.generatedBy || settings.generatedBy || '').trim().toLowerCase()
  const solidColor = String(asset.solidColor || settings.solidColor || settings.color || asset.color || '').trim()
  const name = String(asset.name || '').trim().toLowerCase()
  return sourceTool === 'add_solid_color'
    || (overlayKind === 'color' && (generatedBy === 'mcp' || /^#[0-9a-fA-F]{6}$/.test(solidColor)))
    || (String(asset.type || '').toLowerCase() === 'image' && name.includes('solid') && /^#[0-9a-fA-F]{6}$/.test(solidColor))
}

function resolveAssetMoveTarget(payload = {}) {
  const folders = useAssetsStore.getState().folders || []
  const wantsRoot = payload.targetRoot === true
    || payload.root === true
    || ['root', 'none', 'null'].includes(String(payload.targetFolderPath || payload.folderPath || payload.targetFolderName || payload.folderName || '').trim().toLowerCase())
  if (wantsRoot) {
    return {
      targetFolderId: null,
      targetFolder: null,
      targetFolderPath: [],
      targetWillBeCreated: false,
      createPlan: null,
    }
  }

  const targetFolderId = String(payload.targetFolderId || payload.folderId || '').trim()
  if (targetFolderId) {
    const folder = folders.find((candidate) => candidate?.id === targetFolderId) || null
    if (!folder) throw new Error(`Target folder ${targetFolderId} was not found.`)
    return {
      targetFolderId,
      targetFolder: summarizeAssetFolder(folder),
      targetFolderPath: getAssetFolderPathSegments(folders, targetFolderId),
      targetWillBeCreated: false,
      createPlan: null,
    }
  }

  const rawPath = payload.targetFolderPath ?? payload.folderPath ?? payload.targetPath ?? payload.path ?? payload.targetFolderName ?? payload.folderName ?? payload.name
  const targetPath = splitAssetFolderPathInput(rawPath)
  if (targetPath.length === 0) throw new Error('Provide targetFolderId, targetFolderPath, folderName, or targetRoot=true.')

  const existingFolderId = resolveAssetFolderPathToId(folders, targetPath)
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

  const createPlan = buildCreateAssetFolderPlan({
    path: targetPath,
    color: payload.targetFolderColor || payload.folderColor || payload.color || '',
    reuseExisting: payload.reuseExisting !== false,
    allowDuplicateName: payload.allowDuplicateName === true,
    previewOnly: true,
  })

  return {
    targetFolderId: createPlan.leafFolderId || null,
    targetFolder: createPlan.leafFolder || null,
    targetFolderPath: createPlan.path || targetPath,
    targetWillBeCreated: createPlan.createdCount > 0,
    createPlan,
  }
}

function resolveAssetMoveSource(payload = {}) {
  const folders = useAssetsStore.getState().folders || []
  if (payload.rootOnly === true || payload.sourceRoot === true || payload.fromRoot === true) {
    return { mode: 'root', folderIds: new Set([null]), sourceFolderPath: [] }
  }

  const sourceFolderId = String(payload.sourceFolderId || payload.fromFolderId || '').trim()
  const sourceFolderPath = splitAssetFolderPathInput(payload.sourceFolderPath || payload.fromFolderPath || [])
  let resolvedSourceFolderId = null

  if (sourceFolderId) {
    const folder = folders.find((candidate) => candidate?.id === sourceFolderId) || null
    if (!folder) throw new Error(`Source folder ${sourceFolderId} was not found.`)
    resolvedSourceFolderId = sourceFolderId
  } else if (sourceFolderPath.length > 0) {
    resolvedSourceFolderId = resolveAssetFolderPathToId(folders, sourceFolderPath)
    if (!resolvedSourceFolderId) throw new Error(`Source folder path "${sourceFolderPath.join(' / ')}" was not found.`)
  }

  if (!resolvedSourceFolderId) return { mode: 'all', folderIds: null, sourceFolderPath: [] }

  const includeSubfolders = payload.includeSubfolders !== false
  return {
    mode: includeSubfolders ? 'sourceFolderWithSubfolders' : 'sourceFolder',
    folderIds: includeSubfolders
      ? getDescendantAssetFolderIds(folders, resolvedSourceFolderId)
      : new Set([resolvedSourceFolderId]),
    sourceFolderPath: getAssetFolderPathSegments(folders, resolvedSourceFolderId),
  }
}

function summarizeAssetForMove(asset = {}) {
  const folders = useAssetsStore.getState().folders || []
  const folderId = asset.folderId || null
  const settings = asset.settings || {}
  return {
    id: asset.id,
    name: asset.name || asset.id,
    type: asset.type || 'unknown',
    folderId,
    folderPath: folderId ? getAssetFolderPathSegments(folders, folderId) : [],
    workflowId: asset.workflowId || settings.workflowId || '',
    workflowName: asset.workflowName || settings.workflowName || '',
    sourceTool: asset.sourceTool || settings.sourceTool || '',
    overlayKind: asset.overlayKind || settings.overlayKind || '',
    generatedBy: asset.generatedBy || settings.generatedBy || '',
    solidColor: asset.solidColor || settings.solidColor || settings.color || asset.color || '',
    createdAt: asset.createdAt || asset.imported || null,
  }
}

function resolveAssetsForFolderMove(payload = {}, target = {}) {
  const assets = useAssetsStore.getState().assets || []
  const source = resolveAssetMoveSource(payload)
  const explicitEntries = []
  if (Array.isArray(payload.assets)) explicitEntries.push(...payload.assets)
  if (payload.assetId) explicitEntries.push(payload.assetId)
  for (const assetId of normalizeStringList(payload.assetIds)) explicitEntries.push({ assetId })
  for (const assetName of normalizeStringList(payload.assetNames || payload.assetName)) explicitEntries.push({ assetName })

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

  const typeFilters = normalizeStringList(payload.types || payload.type || payload.assetType).map((type) => type.toLowerCase())
  if (typeFilters.length > 0) {
    candidates = candidates.filter((asset) => typeFilters.includes(String(asset?.type || '').toLowerCase()))
  }

  const workflowIds = normalizeStringList(payload.workflowIds || payload.workflowId).map((id) => id.toLowerCase())
  if (workflowIds.length > 0) {
    candidates = candidates.filter((asset) => workflowIds.includes(getAssetWorkflowId(asset)))
  }

  const query = String(payload.nameIncludes || payload.nameContains || payload.search || payload.query || '').trim().toLowerCase()
  if (query) {
    candidates = candidates.filter((asset) => String(asset?.name || '').toLowerCase().includes(query))
  }

  const filter = String(payload.filter || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  const solidColorsOnly = payload.solidColorsOnly === true
    || payload.constantsOnly === true
    || payload.solidOnly === true
    || ['solid', 'solids', 'solidcolor', 'solidcolors', 'constant', 'constants'].includes(filter)
  if (solidColorsOnly) candidates = candidates.filter(isMcpSolidColorAsset)
  if (filter === 'generated') candidates = candidates.filter((asset) => asset?.isImported !== true)
  if (filter === 'imported') candidates = candidates.filter((asset) => asset?.isImported === true)

  if (source.folderIds) {
    candidates = candidates.filter((asset) => source.folderIds.has(asset?.folderId || null))
  }

  const statuses = normalizeStringList(payload.statuses || payload.status).map((status) => status.toLowerCase())
  if (statuses.length > 0) {
    candidates = candidates.filter((asset) => statuses.includes(String(asset?.generationStatus || asset?.status || 'none').toLowerCase()))
  }

  const order = String(payload.order || payload.sortOrder || 'oldest_first').trim().toLowerCase()
  candidates = candidates
    .filter((asset) => asset?.id)
    .sort((a, b) => order === 'newest_first'
      ? getAssetMoveCreatedTime(b) - getAssetMoveCreatedTime(a)
      : getAssetMoveCreatedTime(a) - getAssetMoveCreatedTime(b))

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

function buildMoveAssetsToFolderPlan(payload = {}) {
  if (!useProjectStore.getState().currentProject) {
    throw new Error('Open a saved project before moving assets.')
  }

  const target = resolveAssetMoveTarget(payload)
  const resolvedAssets = resolveAssetsForFolderMove(payload, target)
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(payload.limit) || 100)))
  if (resolvedAssets.assetsToMove.length > limit) {
    throw new Error(`Matched ${resolvedAssets.assetsToMove.length} assets to move, above limit ${limit}. Pass a higher limit intentionally if this is expected.`)
  }

  return {
    action: 'move_assets_to_folder',
    previewOnly: payload.previewOnly !== false,
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
    assets: resolvedAssets.assetsToMove.map(summarizeAssetForMove),
    unchangedAssets: resolvedAssets.unchangedAssets.slice(0, 50).map(summarizeAssetForMove),
  }
}

async function handleMoveAssetsToFolder(payload = {}) {
  const plan = buildMoveAssetsToFolderPlan(payload)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'move_assets_to_folder',
      message: plan.moveCount === 0
        ? 'No matching assets need to move.'
        : `Asset move plan only. ${plan.moveCount} asset${plan.moveCount === 1 ? '' : 's'} would move.`,
      plan,
    }
  }

  if (plan.moveCount === 0) {
    return {
      success: false,
      action: 'move_assets_to_folder',
      message: 'No matching assets need to move.',
      plan,
    }
  }

  let targetFolderId = plan.targetFolderId || null
  if (plan.targetWillBeCreated) {
    const created = await handleCreateAssetFolder({
      path: plan.targetFolderPath,
      color: payload.targetFolderColor || payload.folderColor || payload.color || '',
      previewOnly: false,
    })
    targetFolderId = created.folderId || null
  }

  const assetIds = plan.assets.map((asset) => asset.id).filter(Boolean)
  if (assetIds.length === 0) throw new Error('No asset IDs were available to move.')
  const state = useAssetsStore.getState()
  if (typeof state.moveAssetsToFolder !== 'function') throw new Error('Asset folder moving is not available.')
  state.moveAssetsToFolder(assetIds, targetFolderId)
  const savedProject = typeof useProjectStore.getState().saveProject === 'function'
    ? await useProjectStore.getState().saveProject()
    : null
  const nextFolders = useAssetsStore.getState().folders || []

  return {
    success: true,
    action: 'move_assets_to_folder',
    movedCount: assetIds.length,
    assetIds,
    targetFolderId,
    targetFolderPath: targetFolderId ? getAssetFolderPathSegments(nextFolders, targetFolderId) : [],
    targetRoot: !targetFolderId,
    createdTargetFolder: plan.targetWillBeCreated,
    savedProject: Boolean(savedProject),
  }
}

function collectMcpAssetIds(value, usedAssetIds, depth = 0) {
  if (!value || depth > 5) return
  if (Array.isArray(value)) {
    value.forEach((item) => collectMcpAssetIds(item, usedAssetIds, depth + 1))
    return
  }
  if (typeof value !== 'object') return

  Object.entries(value).forEach(([key, entryValue]) => {
    const normalizedKey = String(key || '').toLowerCase()
    if ((normalizedKey === 'assetid' || normalizedKey.endsWith('assetid')) && typeof entryValue === 'string' && entryValue.trim()) {
      usedAssetIds.add(entryValue.trim())
      return
    }
    if (entryValue && typeof entryValue === 'object') {
      collectMcpAssetIds(entryValue, usedAssetIds, depth + 1)
    }
  })
}

function getUsedAssetIdsAcrossProject() {
  const projectState = useProjectStore.getState()
  const timelineState = useTimelineStore.getState()
  const project = projectState.currentProject || null
  const currentTimelineId = projectState.currentTimelineId || project?.currentTimelineId || null
  const usedAssetIds = new Set()

  for (const timeline of project?.timelines || []) {
    const clips = timeline?.id === currentTimelineId
      ? (timelineState.clips || [])
      : (timeline?.clips || [])
    for (const clip of clips || []) {
      collectMcpAssetIds(clip, usedAssetIds)
    }
  }

  if (!project?.timelines?.length) {
    for (const clip of timelineState.clips || []) {
      collectMcpAssetIds(clip, usedAssetIds)
    }
  }

  return usedAssetIds
}

function buildMoveUnusedAssetsToFolderPlan(payload = {}) {
  if (!useProjectStore.getState().currentProject) {
    throw new Error('Open a saved project before organizing unused assets.')
  }

  const assets = useAssetsStore.getState().assets || []
  const folders = useAssetsStore.getState().folders || []
  const usedAssetIds = getUsedAssetIdsAcrossProject()
  const target = resolveAssetMoveTarget({
    ...payload,
    targetFolderPath: payload.targetFolderPath ?? payload.folderPath ?? payload.targetPath ?? payload.path ?? payload.folderName ?? 'Unused Assets',
  })
  const typeFilters = normalizeStringList(payload.types || payload.type || payload.assetType).map((type) => type.toLowerCase())
  const workflowIds = normalizeStringList(payload.workflowIds || payload.workflowId).map((id) => id.toLowerCase())
  const query = String(payload.nameIncludes || payload.nameContains || payload.search || payload.query || '').trim().toLowerCase()
  const filter = String(payload.filter || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  const constantsOnly = payload.constantsOnly === true
    || payload.solidColorsOnly === true
    || payload.solidOnly === true
    || ['constant', 'constants', 'solid', 'solids', 'solidcolor', 'solidcolors'].includes(filter)
  const rootOnly = payload.rootOnly === true || payload.sourceRoot === true || payload.fromRoot === true
  const statuses = normalizeStringList(payload.statuses || payload.status).map((status) => status.toLowerCase())

  let candidates = assets
    .filter((asset) => asset?.id && !usedAssetIds.has(asset.id))
    .filter((asset) => !rootOnly || (asset?.folderId || null) === null)

  if (typeFilters.length > 0) {
    candidates = candidates.filter((asset) => typeFilters.includes(String(asset?.type || '').toLowerCase()))
  }
  if (workflowIds.length > 0) {
    candidates = candidates.filter((asset) => workflowIds.includes(getAssetWorkflowId(asset)))
  }
  if (query) {
    candidates = candidates.filter((asset) => String(asset?.name || '').toLowerCase().includes(query))
  }
  if (constantsOnly) {
    candidates = candidates.filter(isMcpSolidColorAsset)
  }
  if (filter === 'generated') candidates = candidates.filter((asset) => asset?.isImported !== true)
  if (filter === 'imported') candidates = candidates.filter((asset) => asset?.isImported === true)
  if (statuses.length > 0) {
    candidates = candidates.filter((asset) => statuses.includes(String(asset?.generationStatus || asset?.status || 'none').toLowerCase()))
  }

  const order = String(payload.order || payload.sortOrder || 'oldest_first').trim().toLowerCase()
  candidates = candidates.sort((a, b) => order === 'newest_first'
    ? getAssetMoveCreatedTime(b) - getAssetMoveCreatedTime(a)
    : getAssetMoveCreatedTime(a) - getAssetMoveCreatedTime(b))

  const targetFolderId = target.targetWillBeCreated ? '__new_target_folder__' : (target.targetFolderId || null)
  const unchangedAssets = target.targetWillBeCreated
    ? []
    : candidates.filter((asset) => (asset?.folderId || null) === targetFolderId)
  const assetsToMove = target.targetWillBeCreated
    ? candidates
    : candidates.filter((asset) => (asset?.folderId || null) !== targetFolderId)

  const limit = Math.min(1000, Math.max(1, Math.floor(Number(payload.limit) || 100)))
  if (assetsToMove.length > limit) {
    throw new Error(`Matched ${assetsToMove.length} unused assets, above limit ${limit}. Pass a higher limit intentionally if this is expected.`)
  }

  return {
    action: 'move_unused_assets_to_folder',
    previewOnly: payload.previewOnly !== false,
    targetFolderId: target.targetFolderId,
    targetFolder: target.targetFolder,
    targetFolderPath: target.targetFolderPath,
    targetRoot: target.targetFolderId === null && !target.targetWillBeCreated,
    targetWillBeCreated: target.targetWillBeCreated,
    createTargetFolderPlan: target.createPlan,
    totalAssetCount: assets.length,
    usedAssetCount: usedAssetIds.size,
    unusedCandidateCount: candidates.length,
    moveCount: assetsToMove.length,
    unchangedCount: unchangedAssets.length,
    filters: {
      typeFilters,
      workflowIds,
      query,
      filter,
      constantsOnly,
      rootOnly,
      statuses,
    },
    assets: assetsToMove.map(summarizeAssetForMove),
    unchangedAssets: unchangedAssets.slice(0, 50).map(summarizeAssetForMove),
    usedAssetIds: [...usedAssetIds],
    folderCount: folders.length,
  }
}

async function handleMoveUnusedAssetsToFolder(payload = {}) {
  const plan = buildMoveUnusedAssetsToFolderPlan(payload)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'move_unused_assets_to_folder',
      message: plan.moveCount === 0
        ? 'No matching unused assets need to move.'
        : `Unused asset cleanup plan only. ${plan.moveCount} asset${plan.moveCount === 1 ? '' : 's'} would move.`,
      plan,
    }
  }

  if (plan.moveCount === 0) {
    return {
      success: false,
      action: 'move_unused_assets_to_folder',
      message: 'No matching unused assets need to move.',
      plan,
    }
  }

  const result = await handleMoveAssetsToFolder({
    ...payload,
    assetIds: plan.assets.map((asset) => asset.id),
    targetFolderId: plan.targetWillBeCreated ? undefined : (plan.targetFolderId || null),
    targetFolderPath: plan.targetFolderPath,
    targetRoot: plan.targetRoot,
    previewOnly: false,
    limit: Math.max(Number(payload.limit) || 100, plan.moveCount),
  })

  return {
    success: true,
    action: 'move_unused_assets_to_folder',
    message: `Moved ${result.movedCount || plan.moveCount} unused asset${(result.movedCount || plan.moveCount) === 1 ? '' : 's'}.`,
    plan,
    result,
  }
}

function summarizeAsset(asset) {
  return {
    id: asset.id,
    name: asset.name || asset.id,
    type: asset.type || 'unknown',
    folderId: asset.folderId || null,
    duration: Number(asset.duration ?? asset.settings?.duration) || null,
    width: Number(asset.width ?? asset.settings?.width) || null,
    height: Number(asset.height ?? asset.settings?.height) || null,
    workflowId: asset.workflowId || asset.settings?.workflowId || '',
    workflowName: asset.workflowName || asset.settings?.workflowName || '',
    sourceTool: asset.sourceTool || asset.settings?.sourceTool || '',
    overlayKind: asset.overlayKind || asset.settings?.overlayKind || '',
    generatedBy: asset.generatedBy || asset.settings?.generatedBy || '',
    solidColor: asset.solidColor || asset.settings?.solidColor || asset.settings?.color || asset.color || '',
    hasAudio: typeof asset.hasAudio === 'boolean' ? asset.hasAudio : null,
    audioEnabled: typeof asset.audioEnabled === 'boolean' ? asset.audioEnabled : null,
    generationStatus: asset.generationStatus || asset.status || 'none',
    createdAt: asset.createdAt || asset.imported || null,
  }
}

function getMcpAssetDuration(asset) {
  const parsed = Number(asset?.duration ?? asset?.settings?.duration)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function getMcpAssetSourceFps(asset) {
  const parsed = Number(asset?.fps ?? asset?.settings?.fps)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function isMcpVisualMediaType(type) {
  return ['video', 'image'].includes(String(type || '').toLowerCase())
}

function isMcpReplaceableClipType(type) {
  return ['video', 'image', 'audio'].includes(String(type || '').toLowerCase())
}

function resolveMcpClipForReplacement(state, payload = {}) {
  const explicitId = String(payload.clipId || payload.targetClipId || payload.id || '').trim()
  if (explicitId) {
    const clip = (state.clips || []).find((candidate) => candidate.id === explicitId)
    if (!clip) throw new Error(`Clip ${explicitId} was not found.`)
    return clip
  }

  const selectedIds = normalizeStringList(state.selectedClipIds || [])
  if (selectedIds.length === 1) {
    const clip = (state.clips || []).find((candidate) => candidate.id === selectedIds[0])
    if (clip) return clip
  }
  if (selectedIds.length > 1) {
    throw new Error('Multiple clips are selected. Provide clipId so the replacement target is explicit.')
  }

  throw new Error('Provide clipId, or select exactly one timeline clip before calling replace_clip_with_asset.')
}

function buildReplaceClipWithAssetPlan(payload = {}) {
  const state = useTimelineStore.getState()
  const clip = resolveMcpClipForReplacement(state, payload)
  const track = (state.tracks || []).find((candidate) => candidate.id === clip.trackId) || null
  const asset = resolveMcpTimelineAsset({
    ...payload,
    assetId: payload.assetId || payload.replacementAssetId,
    assetName: payload.assetName || payload.replacementAssetName,
    latestGenerated: payload.latestGenerated ?? payload.latestReplacement ?? payload.latest,
  })
  const clipType = String(clip.type || '').toLowerCase()
  const assetType = String(asset.type || '').toLowerCase()

  if (!isMcpReplaceableClipType(clipType)) {
    throw new Error(`Clip ${clip.id} is a ${clip.type || 'unknown'} clip. replace_clip_with_asset supports video, image, and audio clips.`)
  }
  if (!isMcpReplaceableClipType(assetType)) {
    throw new Error(`Asset ${asset.id} is a ${asset.type || 'unknown'} asset. Use a video, image, or audio asset.`)
  }
  if (track?.type === 'audio' && assetType !== 'audio') {
    throw new Error('Audio timeline clips can only be replaced with audio assets.')
  }
  if (track?.type === 'video' && !isMcpVisualMediaType(assetType)) {
    throw new Error('Video timeline clips can only be replaced with video or image assets.')
  }
  if (clipType === 'audio' && assetType !== 'audio') {
    throw new Error('Audio clips can only be replaced with audio assets.')
  }
  if (isMcpVisualMediaType(clipType) && !isMcpVisualMediaType(assetType)) {
    throw new Error('Visual clips can only be replaced with video or image assets.')
  }

  const fps = Number(state.timelineFps) || 24
  const assetDuration = getMcpAssetDuration(asset)
  const sourceDuration = assetType === 'image' ? Infinity : (assetDuration || Number(clip.duration) || 5)
  const fitToAssetDuration = payload.fitToAssetDuration === true || payload.useAssetDuration === true
  const preserveDuration = payload.preserveDuration !== false && !fitToAssetDuration
  const requestedDuration = Number(payload.durationSeconds ?? payload.duration)
  const duration = roundToTimelineFrame(
    preserveDuration
      ? Math.max(1 / fps, Number(clip.duration) || (1 / fps))
      : Math.max(1 / fps, Number.isFinite(requestedDuration) && requestedDuration > 0
        ? requestedDuration
        : (assetType === 'image' ? 5 : (assetDuration || Number(clip.duration) || 5))),
    fps
  )
  const resetTrim = payload.preserveTrim === true ? false : payload.resetTrim !== false
  const trimStart = resetTrim ? 0 : Math.max(0, Number(clip.trimStart) || 0)
  const timeScale = Math.max(0.0001, Number(clip.sourceTimeScale || clip.speed || 1) || 1)
  const unclampedTrimEnd = resetTrim
    ? trimStart + duration * timeScale
    : (Number.isFinite(Number(clip.trimEnd)) ? Number(clip.trimEnd) : trimStart + duration * timeScale)
  const trimEnd = assetType === 'image'
    ? trimStart + duration * timeScale
    : Math.max(trimStart + (1 / fps) * timeScale, Math.min(sourceDuration, unclampedTrimEnd))

  const updates = {
    assetId: asset.id,
    name: String(payload.name || '').trim() || asset.name || clip.name,
    type: assetType,
    duration,
    sourceDuration,
    trimStart,
    trimEnd,
    sourceFps: assetType === 'video' ? getMcpAssetSourceFps(asset) : null,
    timelineFps: fps,
    url: asset.url,
    thumbnail: asset.url,
    cacheStatus: clip.cacheStatus === 'cached' ? 'invalid' : clip.cacheStatus,
    cacheProgress: 0,
    cacheUrl: null,
    cachePath: null,
    metadata: {
      ...(safeClone(clip.metadata) || {}),
      replacedByMcp: true,
      replacedAt: new Date().toISOString(),
      previousAssetId: clip.assetId || null,
      replacementAssetId: asset.id,
      sourceTool: 'replace_clip_with_asset',
    },
  }
  const nextClip = { ...clip, ...updates }

  return {
    action: 'replace_clip_with_asset',
    previewOnly: payload.previewOnly !== false,
    preserveDuration,
    resetTrim,
    track: track ? summarizeTrack(track) : null,
    before: summarizeClipWithAsset(clip),
    replacementAsset: summarizeAsset(asset),
    after: summarizeClipWithAsset(nextClip, asset),
    updates,
  }
}

function handleReplaceClipWithAsset(payload = {}) {
  const plan = buildReplaceClipWithAssetPlan(payload)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'replace_clip_with_asset',
      message: 'Clip replacement plan only. No timeline change was made.',
      plan: {
        ...plan,
        updates: undefined,
      },
    }
  }

  const state = useTimelineStore.getState()
  state.saveToHistory?.()
  useTimelineStore.setState((currentState) => ({
    clips: (currentState.clips || []).map((clip) => (
      clip.id === plan.before.id ? { ...clip, ...plan.updates } : clip
    )),
    selectedClipIds: [plan.before.id],
    selectedTransitionId: null,
    selectedMarkerId: null,
    selectedGap: null,
  }))

  const nextClip = (useTimelineStore.getState().clips || []).find((clip) => clip.id === plan.before.id)
  return {
    success: true,
    action: 'replace_clip_with_asset',
    message: `Replaced ${plan.before.name || plan.before.id} with ${plan.replacementAsset.name || plan.replacementAsset.id}.`,
    preserveDuration: plan.preserveDuration,
    resetTrim: plan.resetTrim,
    clip: summarizeClipWithAsset(nextClip),
    replacementAsset: plan.replacementAsset,
  }
}

function normalizeAssetTimelinePlacement(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (['selectedclipstart', 'selectionstart', 'selectedstart'].includes(normalized)) return 'selected_clip_start'
  if (['selectedclipend', 'selectionend', 'selectedend', 'afterselectedclip', 'afterselection'].includes(normalized)) return 'selected_clip_end'
  if (['timelineend', 'end', 'append'].includes(normalized)) return 'timeline_end'
  if (['trackend', 'endoftrack'].includes(normalized)) return 'track_end'
  return 'playhead'
}

function getAssetCreatedTime(asset) {
  const raw = asset?.createdAt || asset?.imported || asset?.created || asset?.modified || ''
  const parsed = raw ? Date.parse(raw) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function resolveMcpTimelineAsset(payload = {}) {
  const assets = useAssetsStore.getState().assets || []
  const assetId = String(payload.assetId || payload.id || '').trim()
  const assetName = String(payload.assetName || payload.name || '').trim().toLowerCase()
  const type = String(payload.type || payload.assetType || '').trim().toLowerCase()
  const workflowId = String(payload.workflowId || '').trim().toLowerCase()
  const latest = payload.latest === true || payload.latestGenerated === true || payload.latestAsset === true

  let candidates = assets.filter((asset) => asset?.id)
  if (type) candidates = candidates.filter((asset) => String(asset.type || '').toLowerCase() === type)
  if (workflowId) {
    candidates = candidates.filter((asset) => (
      String(asset.workflowId || asset.settings?.workflowId || '').trim().toLowerCase() === workflowId
    ))
  }

  if (assetId) {
    const asset = assets.find((candidate) => candidate?.id === assetId)
    if (!asset) throw new Error(`Asset ${assetId} was not found.`)
    return asset
  }

  if (assetName) {
    const exact = candidates.find((asset) => String(asset.name || '').trim().toLowerCase() === assetName)
    if (exact) return exact
    const partial = candidates.find((asset) => String(asset.name || '').trim().toLowerCase().includes(assetName))
    if (partial) return partial
    throw new Error(`No asset matched "${payload.assetName || payload.name}".`)
  }

  if (latest || candidates.length > 0) {
    const allowedStatuses = new Set(['none', 'done', 'complete', 'completed', 'success', ''])
    const latestCandidate = candidates
      .filter((asset) => allowedStatuses.has(String(asset.generationStatus || asset.status || 'none').toLowerCase()))
      .sort((a, b) => getAssetCreatedTime(b) - getAssetCreatedTime(a))[0]
    if (latestCandidate) return latestCandidate
  }

  throw new Error('No matching asset was found. Provide assetId, assetName, or latestGenerated=true.')
}

function getAssetWorkflowId(asset) {
  return String(asset?.workflowId || asset?.settings?.workflowId || '').trim().toLowerCase()
}

function normalizeMcpStringList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
  }
  const raw = String(value || '').trim()
  if (!raw) return []
  return [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))]
}

function isMcpPlaceableTimelineAsset(asset) {
  return ['video', 'image', 'audio'].includes(String(asset?.type || '').toLowerCase())
}

function resolveMcpTimelineAssets(payload = {}) {
  const assets = useAssetsStore.getState().assets || []
  const explicitEntries = []

  if (Array.isArray(payload.assets)) {
    explicitEntries.push(...payload.assets)
  }
  if (Array.isArray(payload.assetIds)) {
    explicitEntries.push(...payload.assetIds.map((assetId) => ({ assetId })))
  }
  if (Array.isArray(payload.assetNames)) {
    explicitEntries.push(...payload.assetNames.map((assetName) => ({ assetName })))
  }

  if (explicitEntries.length > 0) {
    const seen = new Set()
    const items = []
    for (const rawEntry of explicitEntries) {
      const entry = typeof rawEntry === 'string' ? { assetId: rawEntry } : (rawEntry || {})
      const asset = resolveMcpTimelineAsset({ ...payload, ...entry })
      if (!isMcpPlaceableTimelineAsset(asset)) {
        throw new Error(`Asset ${asset?.name || asset?.id || ''} cannot be placed on the timeline yet.`)
      }
      if (!asset.id || seen.has(asset.id)) continue
      seen.add(asset.id)
      items.push({ asset, entry })
    }
    if (items.length === 0) throw new Error('No unique placeable assets were resolved for batch placement.')
    if (items.length > MCP_ASSET_BATCH_MAX_ITEMS) throw new Error(`Batch placement is limited to ${MCP_ASSET_BATCH_MAX_ITEMS} assets.`)
    return items
  }

  const type = String(payload.type || payload.assetType || '').trim().toLowerCase()
  const workflowIds = normalizeMcpStringList(payload.workflowIds || payload.workflowId).map((id) => id.toLowerCase())
  const requestedStatuses = normalizeMcpStringList(payload.statuses || payload.status).map((status) => status.toLowerCase())
  const allowedStatuses = requestedStatuses.length > 0
    ? new Set(requestedStatuses)
    : new Set(['none', 'done', 'complete', 'completed', 'success', ''])

  let candidates = assets.filter(isMcpPlaceableTimelineAsset)
  if (type) candidates = candidates.filter((asset) => String(asset.type || '').toLowerCase() === type)
  if (workflowIds.length > 0) {
    candidates = candidates.filter((asset) => workflowIds.includes(getAssetWorkflowId(asset)))
  }
  candidates = candidates.filter((asset) => allowedStatuses.has(String(asset.generationStatus || asset.status || 'none').toLowerCase()))
  if (candidates.length === 0) throw new Error('No matching placeable assets were found for batch placement.')

  const requestedCount = Number(payload.latestCount ?? payload.count ?? payload.limit)
  const count = Number.isFinite(requestedCount) && requestedCount > 0
    ? Math.min(MCP_ASSET_BATCH_MAX_ITEMS, Math.floor(requestedCount))
    : Math.min(6, candidates.length, MCP_ASSET_BATCH_MAX_ITEMS)
  const newestFirst = candidates
    .slice()
    .sort((a, b) => getAssetCreatedTime(b) - getAssetCreatedTime(a))
    .slice(0, count)
  const order = String(payload.order || payload.sortOrder || 'oldest_first').trim().toLowerCase()
  const selected = order === 'newest_first' ? newestFirst : newestFirst.reverse()

  return selected.map((asset) => ({ asset, entry: {} }))
}

function getCompatibleTrackTypeForAsset(asset) {
  const type = String(asset?.type || '').toLowerCase()
  if (type === 'audio') return 'audio'
  if (type === 'video' || type === 'image') return 'video'
  throw new Error(`Asset ${asset?.name || asset?.id || ''} has unsupported type "${asset?.type || 'unknown'}" for timeline placement.`)
}

function shouldAddLinkedVideoAudio(asset, payload = {}) {
  if (String(asset?.type || '').toLowerCase() !== 'video') return false
  if (payload.includeAudio === false || payload.includeEmbeddedAudio === false) return false
  if (asset.audioEnabled === false) return false
  if (asset.hasAudio === false) return false
  return true
}

function shouldAddBatchLinkedVideoAudio(payload = {}, layout = '') {
  if (payload.includeAudio === true || payload.includeEmbeddedAudio === true) return true
  if (payload.includeAudio === false || payload.includeEmbeddedAudio === false) return false
  return layout === 'sequential'
}

function getAvailableMcpAudioTrack(state) {
  return (state.tracks || []).find((track) => (
    track.type === 'audio' &&
    track.locked !== true &&
    track.visible !== false
  )) || null
}

function makeMcpLinkGroupId(asset, prefix = 'asset') {
  const safeAssetId = String(asset?.id || 'asset').replace(/[^a-zA-Z0-9_-]+/g, '_')
  return `link-mcp-${prefix}-${safeAssetId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function buildLinkedAudioPlan(state, asset, payload = {}) {
  if (!shouldAddLinkedVideoAudio(asset, payload)) return null
  const track = getAvailableMcpAudioTrack(state)
  return {
    createTrack: !track,
    track: summarizeTrack(track || {
      id: null,
      name: String(payload.audioTrackName || '').trim() || 'MCP Linked Audio',
      type: 'audio',
      muted: false,
      locked: false,
      visible: true,
      channels: normalizeAudioChannels(payload.channels),
    }),
  }
}

function resolveMcpTimelineTrack(state, asset, payload = {}) {
  const targetType = getCompatibleTrackTypeForAsset(asset)
  const trackId = String(payload.trackId || '').trim()
  const createTrack = payload.createTrack === true || payload.newTrack === true || ['new', 'newtop', 'newtrack', 'newtoptrack'].includes(String(payload.trackStrategy || payload.placementTrack || '').trim().toLowerCase().replace(/[\s_-]+/g, ''))

  if (trackId) {
    const track = (state.tracks || []).find((candidate) => candidate.id === trackId)
    if (!track) throw new Error(`Track ${trackId} was not found.`)
    if (track.type !== targetType) throw new Error(`Asset ${asset.name || asset.id} is ${asset.type}; it needs a ${targetType} track.`)
    if (track.locked) throw new Error(`Track ${trackId} is locked.`)
    return { track, createTrack: false, targetType }
  }

  if (createTrack) {
    return { track: null, createTrack: true, targetType }
  }

  const track = (state.tracks || []).find((candidate) => (
    candidate.type === targetType &&
    candidate.locked !== true &&
    candidate.visible !== false &&
    candidate.role !== 'captions'
  ))
  if (!track) {
    return { track: null, createTrack: true, targetType }
  }
  return { track, createTrack: false, targetType }
}

function resolveMcpAssetPlacementStart(state, trackId, payload = {}) {
  const fps = Number(state.timelineFps) || 24
  const explicitStart = Number(payload.startSeconds ?? payload.startTime)
  if (Number.isFinite(explicitStart)) return roundToTimelineFrame(Math.max(0, explicitStart), fps)

  const placement = normalizeAssetTimelinePlacement(payload.at || payload.placement || payload.position)
  const selectedIds = Array.isArray(state.selectedClipIds) ? state.selectedClipIds : []
  const selectedClip = selectedIds.length > 0
    ? (state.clips || []).find((clip) => clip.id === selectedIds[0])
    : null

  if (placement === 'selected_clip_start' && selectedClip) {
    return roundToTimelineFrame(Math.max(0, Number(selectedClip.startTime) || 0), fps)
  }
  if (placement === 'selected_clip_end' && selectedClip) {
    return roundToTimelineFrame(Math.max(0, (Number(selectedClip.startTime) || 0) + (Number(selectedClip.duration) || 0)), fps)
  }
  if (placement === 'track_end' && trackId) {
    const end = (state.clips || [])
      .filter((clip) => clip.trackId === trackId)
      .reduce((max, clip) => Math.max(max, (Number(clip.startTime) || 0) + (Number(clip.duration) || 0)), 0)
    return roundToTimelineFrame(end, fps)
  }
  if (placement === 'timeline_end') {
    const end = (state.clips || [])
      .reduce((max, clip) => Math.max(max, (Number(clip.startTime) || 0) + (Number(clip.duration) || 0)), 0)
    return roundToTimelineFrame(end, fps)
  }

  return roundToTimelineFrame(Math.max(0, Number(state.playheadPosition) || 0), fps)
}

function normalizeSolidColor(value) {
  const raw = String(value || '#000000').trim()
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase()
  throw new Error('Invalid solid color. Use a hex color like #000000 or #ff0000.')
}

function normalizeSolidTrackPlacement(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (['top', 'newtop', 'newtoptrack', 'above'].includes(normalized)) return 'top'
  return 'bottom'
}

function buildSolidColorAssetPlan(payload = {}) {
  const projectState = useProjectStore.getState()
  const timelineState = useTimelineStore.getState()
  const timelineSettings = typeof projectState.getCurrentTimelineSettings === 'function'
    ? projectState.getCurrentTimelineSettings()
    : null
  const color = normalizeSolidColor(payload.color || payload.fill || payload.solidColor || '#000000')
  const width = Math.max(1, Math.round(Number(payload.width || timelineSettings?.width || projectState.currentProject?.settings?.width || 1920)))
  const height = Math.max(1, Math.round(Number(payload.height || timelineSettings?.height || projectState.currentProject?.settings?.height || 1080)))
  const fps = Number(timelineState.timelineFps || timelineSettings?.fps || projectState.currentProject?.settings?.fps || 24) || 24
  const duration = Number(payload.durationSeconds ?? payload.duration)
  const durationSeconds = Number.isFinite(duration) && duration > 0
    ? roundToTimelineFrame(duration, fps)
    : 5
  const name = String(payload.name || payload.assetName || '').trim()
    || `${color === '#000000' ? 'Black' : 'Color'} solid ${width}x${height}`
  const placeOnTimeline = payload.placeOnTimeline !== false && payload.addToTimeline !== false
  const createTrack = payload.createTrack !== false && payload.newTrack !== false && !payload.trackId
  const trackPlacement = normalizeSolidTrackPlacement(payload.trackPlacement || payload.trackPosition || payload.placementTrackPosition)
  const pseudoAsset = {
    id: '__mcp_solid_preview__',
    name,
    type: 'image',
    settings: {
      width,
      height,
      overlayKind: 'color',
      color,
      generatedBy: 'mcp',
    },
  }
  const target = placeOnTimeline
    ? resolveMcpTimelineTrack(timelineState, pseudoAsset, {
      ...payload,
      createTrack,
      newTrack: createTrack,
      trackName: payload.trackName || `${color === '#000000' ? 'Black' : 'Color'} solid`,
    })
    : null
  const plannedTrack = target
    ? (target.track || {
      id: null,
      name: String(payload.trackName || '').trim() || `${color === '#000000' ? 'Black' : 'Color'} solid`,
      type: 'video',
      locked: false,
      muted: false,
      visible: true,
      placement: trackPlacement,
    })
    : null
  const startSeconds = placeOnTimeline
    ? resolveMcpAssetPlacementStart(timelineState, target?.track?.id || '', payload)
    : null

  return {
    action: 'add_solid_color',
    previewOnly: payload.previewOnly !== false,
    asset: {
      name,
      type: 'image',
      width,
      height,
      color,
      duration: durationSeconds,
    },
    placeOnTimeline,
    track: plannedTrack ? summarizeTrack(plannedTrack) : null,
    createTrack: placeOnTimeline ? target?.createTrack === true : false,
    trackPlacement: placeOnTimeline && target?.createTrack === true ? trackPlacement : null,
    startSeconds,
    durationSeconds,
    resolveOverlaps: payload.resolveOverlaps === true,
    selectAfterAdd: payload.selectAfterAdd !== false,
    transform: payload.transform && typeof payload.transform === 'object' ? safeClone(payload.transform) : null,
  }
}

async function handleAddSolidColor(payload = {}) {
  const projectState = useProjectStore.getState()
  const projectPath = projectState.currentProjectHandle
  if (typeof projectPath !== 'string' || !projectPath) {
    throw new Error('Open a saved desktop project before creating a solid color asset.')
  }

  const plan = buildSolidColorAssetPlan(payload)
  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'add_solid_color',
      message: 'Solid color asset plan only. No asset or timeline clip was created.',
      plan,
    }
  }

  const blob = await generateColorMatteBlob(plan.asset.width, plan.asset.height, plan.asset.color)
  const persisted = await writeGeneratedOverlayToProject(
    projectPath,
    blob,
    plan.asset.name,
    'image',
    {
      width: plan.asset.width,
      height: plan.asset.height,
      sourceTool: 'add_solid_color',
      overlayKind: 'color',
      solidColor: plan.asset.color,
      color: plan.asset.color,
      generatedBy: 'mcp',
    }
  )
  const asset = useAssetsStore.getState().addAsset?.({
    ...persisted,
    settings: {
      ...(persisted.settings || {}),
      duration: plan.durationSeconds,
      width: plan.asset.width,
      height: plan.asset.height,
      sourceTool: 'add_solid_color',
      overlayKind: 'color',
      solidColor: plan.asset.color,
      color: plan.asset.color,
      generatedBy: 'mcp',
    },
    duration: plan.durationSeconds,
    width: plan.asset.width,
    height: plan.asset.height,
  })
  if (!asset) throw new Error('Could not add the solid color asset to the project.')

  let clip = null
  let createdTrack = null
  if (plan.placeOnTimeline) {
    const timelineState = useTimelineStore.getState()
    let track = plan.track?.id
      ? (timelineState.tracks || []).find((candidate) => candidate.id === plan.track.id)
      : null
    const options = {
      selectAfterAdd: plan.selectAfterAdd,
      resolveOverlaps: plan.resolveOverlaps,
      duration: plan.durationSeconds,
      ...(plan.transform ? { transform: safeClone(plan.transform) } : {}),
      metadata: {
        addedByMcp: true,
        addedAt: new Date().toISOString(),
        sourceTool: 'add_solid_color',
        solidColor: plan.asset.color,
      },
    }

    if (!track && plan.createTrack) {
      timelineState.saveToHistory?.()
      track = useTimelineStore.getState().addTrack?.('video', {
        name: plan.track?.name || `${plan.asset.color === '#000000' ? 'Black' : 'Color'} solid`,
        position: plan.trackPlacement || 'bottom',
      })
      if (!track) throw new Error('Could not create a target video track for the solid color.')
      createdTrack = track
      options.saveHistory = false
    }
    if (!track?.id) throw new Error('No target video track was available for the solid color.')

    clip = useTimelineStore.getState().addClip?.(
      track.id,
      asset,
      plan.startSeconds,
      Number(useTimelineStore.getState().timelineFps) || 24,
      options
    )
    if (!clip) throw new Error('Could not place the solid color on the timeline.')
  }

  return {
    created: true,
    action: 'add_solid_color',
    asset: summarizeAsset(asset),
    clip: clip ? summarizeClip(clip) : null,
    track: createdTrack ? summarizeTrack(createdTrack) : plan.track,
    plan,
  }
}

function handleAddAssetToTimeline(payload = {}) {
  const initialState = useTimelineStore.getState()
  const asset = resolveMcpTimelineAsset(payload)
  const target = resolveMcpTimelineTrack(initialState, asset, payload)
  const linkedAudioPlan = buildLinkedAudioPlan(initialState, asset, payload)
  const plannedTrack = target.track || {
    id: null,
    name: String(payload.trackName || '').trim() || `MCP ${target.targetType === 'video' ? 'Video' : 'Audio'}`,
    type: target.targetType,
    locked: false,
    muted: false,
    visible: true,
    channels: target.targetType === 'audio' ? normalizeAudioChannels(payload.channels) : null,
  }
  const startTime = resolveMcpAssetPlacementStart(initialState, target.track?.id || '', payload)
  const fps = Number(initialState.timelineFps) || 24
  const duration = Number(payload.durationSeconds ?? payload.duration)
  const options = {
    selectAfterAdd: payload.selectAfterAdd !== false,
    resolveOverlaps: payload.resolveOverlaps !== false,
    ...(Number.isFinite(duration) && duration > 0 ? { duration: roundToTimelineFrame(duration, fps) } : {}),
    ...(payload.transform && typeof payload.transform === 'object' ? { transform: safeClone(payload.transform) } : {}),
    metadata: {
      addedByMcp: true,
      addedAt: new Date().toISOString(),
      sourceTool: 'add_asset_to_timeline',
    },
  }

  const plan = {
    asset: summarizeAsset(asset),
    track: summarizeTrack(plannedTrack),
    createTrack: target.createTrack,
    startSeconds: startTime,
    durationSeconds: options.duration || (asset.type === 'image' ? 5 : (Number(asset.duration ?? asset.settings?.duration) || 5)),
    resolveOverlaps: options.resolveOverlaps,
    selectAfterAdd: options.selectAfterAdd,
    placement: normalizeAssetTimelinePlacement(payload.at || payload.placement || payload.position),
    linkedAudio: linkedAudioPlan ? {
      ...linkedAudioPlan,
      startSeconds: startTime,
      durationSeconds: options.duration || (Number(asset.duration ?? asset.settings?.duration) || 5),
    } : null,
  }

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'add_asset_to_timeline',
      message: 'Asset placement plan only. No timeline change was made.',
      plan,
    }
  }

  let track = target.track
  const needsManualHistory = target.createTrack || linkedAudioPlan?.createTrack
  if (needsManualHistory) {
    initialState.saveToHistory?.()
    options.saveHistory = false
  }
  if (target.createTrack) {
    track = initialState.addTrack?.(target.targetType, {
      name: plannedTrack.name,
      ...(target.targetType === 'audio' ? { channels: plannedTrack.channels || 'stereo' } : {}),
    })
    if (!track) throw new Error('Could not create a compatible target track.')
  }

  let audioTrack = null
  if (linkedAudioPlan) {
    audioTrack = linkedAudioPlan.track?.id
      ? (useTimelineStore.getState().tracks || []).find((candidate) => candidate.id === linkedAudioPlan.track.id)
      : null
    if (!audioTrack && linkedAudioPlan.createTrack) {
      audioTrack = useTimelineStore.getState().addTrack?.('audio', {
        name: linkedAudioPlan.track?.name || 'MCP Linked Audio',
        channels: linkedAudioPlan.track?.channels || 'stereo',
      })
      if (!audioTrack) throw new Error('Could not create a linked audio track for the video asset.')
    }
  }

  const linkGroupId = audioTrack ? makeMcpLinkGroupId(asset, 'single') : undefined
  const clip = useTimelineStore.getState().addClip?.(track.id, asset, startTime, fps, {
    ...options,
    ...(linkGroupId ? { linkGroupId, selectAfterAdd: false } : {}),
  })
  if (!clip) throw new Error('Could not add the asset to the timeline.')

  let audioClip = null
  if (audioTrack && linkGroupId) {
    audioClip = useTimelineStore.getState().addClip?.(audioTrack.id, { ...asset, type: 'audio' }, clip.startTime, fps, {
      saveHistory: false,
      linkGroupId,
      selectAfterAdd: false,
      resolveOverlaps: options.resolveOverlaps,
      duration: clip.duration,
      metadata: {
        addedByMcp: true,
        addedAt: new Date().toISOString(),
        sourceTool: 'add_asset_to_timeline',
        linkedVideoClipId: clip.id,
        embeddedAudioFromVideoAsset: true,
      },
    })
  }

  if (options.selectAfterAdd && linkGroupId) {
    useTimelineStore.setState((state) => ({
      selectedClipIds: audioClip ? [clip.id, audioClip.id] : [clip.id],
    }))
  }

  return {
    created: true,
    action: 'add_asset_to_timeline',
    clip: summarizeClip(clip),
    audioClip: audioClip ? summarizeClip(audioClip) : null,
    asset: summarizeAsset(asset),
    track: summarizeTrack(track),
    audioTrack: audioTrack ? summarizeTrack(audioTrack) : null,
    createdTrack: target.createTrack,
    createdAudioTrack: Boolean(linkedAudioPlan?.createTrack && audioTrack),
  }
}

function normalizeMcpAssetBatchTrackStrategy(value, count) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (['single', 'singletrack', 'singleexisting', 'existing', 'existingtrack', 'onetrack', 'sametrack'].includes(normalized)) {
    return 'single_track'
  }
  if (['sequential', 'singletracksequential'].includes(normalized)) return 'single_track'
  if (count <= 1 && ['auto', ''].includes(normalized)) return 'new_tracks'
  return 'new_tracks'
}

function normalizeMcpAssetBatchLayout(value, trackStrategy) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (['sequential', 'sequence', 'append', 'sidebysideintime'].includes(normalized)) return 'sequential'
  if (['stack', 'stacked', 'lanes', 'reviewlanes', 'samestart'].includes(normalized)) return 'stacked'
  return trackStrategy === 'single_track' ? 'sequential' : 'stacked'
}

function formatMcpBatchTrackName(template, asset, index, total, fallbackPrefix = 'MCP Review') {
  const workflow = asset?.workflowName || asset?.settings?.workflowName || asset?.workflowId || asset?.settings?.workflowId || asset?.model || asset?.type || 'Asset'
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

function getMcpBatchLabelColor(payload = {}, entry = {}, index = 0) {
  const labelColors = Array.isArray(payload.labelColors) ? payload.labelColors : []
  const rawColor = entry.labelColor ?? labelColors[index] ?? payload.labelColor ?? payload.color ?? ''
  const color = normalizeClipLabelColor(rawColor)
  if (rawColor && !color) {
    throw new Error('Invalid label color. Use a hex color like #f97316, or omit labelColor.')
  }
  return color
}

function getMcpBatchDuration(asset, payload = {}, entry = {}) {
  const requestedDuration = Number(entry.durationSeconds ?? entry.duration ?? payload.durationSeconds ?? payload.duration)
  if (Number.isFinite(requestedDuration) && requestedDuration > 0) return requestedDuration
  const assetDuration = Number(asset.duration ?? asset.settings?.duration) || 0
  return asset.type === 'image' ? 5 : (assetDuration || 5)
}

function buildMcpAssetBatchPlacementPlan(state, payload = {}) {
  const items = resolveMcpTimelineAssets(payload)
  if (items.length === 0) throw new Error('No assets were resolved for batch placement.')
  if (items.length > MCP_ASSET_BATCH_MAX_ITEMS) throw new Error(`Batch placement is limited to ${MCP_ASSET_BATCH_MAX_ITEMS} assets.`)

  const trackStrategy = normalizeMcpAssetBatchTrackStrategy(payload.trackStrategy || payload.placementTrack, items.length)
  const layout = normalizeMcpAssetBatchLayout(payload.layout || payload.placementLayout, trackStrategy)
  const includeLinkedAudio = shouldAddBatchLinkedVideoAudio(payload, layout)
  const spacingSeconds = Math.max(0, Number(payload.spacingSeconds ?? payload.spacing) || 0)
  const fps = Number(state.timelineFps) || 24
  const baseStartSeconds = resolveMcpAssetPlacementStart(state, String(payload.trackId || '').trim(), payload)
  const trackNamePrefix = String(payload.trackNamePrefix || payload.trackPrefix || 'MCP Review').trim() || 'MCP Review'
  const trackNameTemplate = payload.trackNameTemplate || payload.trackTemplate || ''
  const placements = []

  if (trackStrategy === 'single_track') {
    const targetTypes = [...new Set(items.map(({ asset }) => getCompatibleTrackTypeForAsset(asset)))]
    if (targetTypes.length !== 1 || !targetTypes[0]) {
      throw new Error('Single-track batch placement requires all assets to use the same compatible track type.')
    }

    const sharedTarget = resolveMcpTimelineTrack(state, items[0].asset, {
      ...payload,
      createTrack: payload.createTrack !== false && payload.newTrack !== false && !payload.trackId,
      newTrack: payload.createTrack !== false && payload.newTrack !== false && !payload.trackId,
    })
    const sharedPlannedTrack = sharedTarget.track || {
      id: null,
      name: String(payload.trackName || '').trim() || `${trackNamePrefix} Batch`,
      type: sharedTarget.targetType,
      locked: false,
      muted: false,
      visible: true,
      channels: sharedTarget.targetType === 'audio' ? normalizeAudioChannels(payload.channels) : null,
    }

    let cursor = baseStartSeconds
    for (let index = 0; index < items.length; index += 1) {
      const { asset, entry } = items[index]
      const durationSeconds = roundToTimelineFrame(getMcpBatchDuration(asset, payload, entry), fps)
      const startSeconds = layout === 'sequential' ? cursor : baseStartSeconds
      placements.push({
        index,
        asset,
        track: sharedPlannedTrack,
        createTrack: sharedTarget.createTrack,
        startSeconds,
        durationSeconds,
        linkedAudio: includeLinkedAudio
          ? buildLinkedAudioPlan(state, asset, { ...payload, includeAudio: true })
          : null,
        labelColor: getMcpBatchLabelColor(payload, entry, index),
        transform: entry.transform && typeof entry.transform === 'object'
          ? safeClone(entry.transform)
          : (payload.transform && typeof payload.transform === 'object' ? safeClone(payload.transform) : null),
      })
      cursor = roundToTimelineFrame(startSeconds + durationSeconds + spacingSeconds, fps)
    }
  } else {
    let cursor = baseStartSeconds
    for (let index = 0; index < items.length; index += 1) {
      const { asset, entry } = items[index]
      const targetType = getCompatibleTrackTypeForAsset(asset)
      const durationSeconds = roundToTimelineFrame(getMcpBatchDuration(asset, payload, entry), fps)
      const startSeconds = layout === 'sequential' ? cursor : baseStartSeconds
      const trackName = String(entry.trackName || '').trim()
        || formatMcpBatchTrackName(trackNameTemplate, asset, index, items.length, trackNamePrefix)
      placements.push({
        index,
        asset,
        track: {
          id: null,
          name: trackName,
          type: targetType,
          locked: false,
          muted: false,
          visible: true,
          channels: targetType === 'audio' ? normalizeAudioChannels(payload.channels) : null,
        },
        createTrack: true,
        startSeconds,
        durationSeconds,
        linkedAudio: includeLinkedAudio
          ? buildLinkedAudioPlan(state, asset, { ...payload, includeAudio: true })
          : null,
        labelColor: getMcpBatchLabelColor(payload, entry, index),
        transform: entry.transform && typeof entry.transform === 'object'
          ? safeClone(entry.transform)
          : (payload.transform && typeof payload.transform === 'object' ? safeClone(payload.transform) : null),
      })
      cursor = roundToTimelineFrame(startSeconds + durationSeconds + spacingSeconds, fps)
    }
  }

  return {
    action: 'add_assets_to_timeline',
    previewOnly: payload.previewOnly !== false,
    assetCount: placements.length,
    layout,
    trackStrategy,
    includeAudio: includeLinkedAudio,
    baseStartSeconds,
    spacingSeconds,
    resolveOverlaps: payload.resolveOverlaps !== false,
    selectAfterAdd: payload.selectAfterAdd !== false,
    placements: placements.map((placement) => ({
      ...placement,
      asset: summarizeAsset(placement.asset),
      track: summarizeTrack(placement.track),
    })),
    _runtimePlacements: placements,
  }
}

function handleAddAssetsToTimeline(payload = {}) {
  const initialState = useTimelineStore.getState()
  const plan = buildMcpAssetBatchPlacementPlan(initialState, payload)

  const publicPlan = {
    ...plan,
    _runtimePlacements: undefined,
  }
  delete publicPlan._runtimePlacements

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'add_assets_to_timeline',
      message: 'Batch asset placement plan only. No timeline change was made.',
      plan: publicPlan,
    }
  }

  const placements = plan._runtimePlacements || []
  if (placements.length === 0) throw new Error('No placements were available to apply.')

  const fps = Number(initialState.timelineFps) || 24
  const trackByPlacementIndex = new Map()
  const createdTracks = []
  const createdClips = []
  const labelColorByClipId = new Map()
  const linkedAudioByClipId = new Map()

  initialState.saveToHistory?.()

  if (plan.trackStrategy === 'single_track') {
    const firstPlacement = placements[0]
    let track = firstPlacement.track?.id
      ? (useTimelineStore.getState().tracks || []).find((candidate) => candidate.id === firstPlacement.track.id)
      : null
    if (!track) {
      track = useTimelineStore.getState().addTrack?.(firstPlacement.track.type, {
        name: firstPlacement.track.name,
        ...(firstPlacement.track.type === 'audio' ? { channels: firstPlacement.track.channels || 'stereo' } : {}),
      })
      if (!track) throw new Error('Could not create the batch placement track.')
      createdTracks.push(track)
    }
    placements.forEach((placement) => trackByPlacementIndex.set(placement.index, track))
  } else {
    const videoPlacements = placements
      .filter((placement) => placement.createTrack && placement.track?.type === 'video')
      .slice()
      .reverse()
    const audioPlacements = placements
      .filter((placement) => placement.createTrack && placement.track?.type === 'audio')

    for (const placement of [...videoPlacements, ...audioPlacements]) {
      const track = useTimelineStore.getState().addTrack?.(placement.track.type, {
        name: placement.track.name,
        ...(placement.track.type === 'audio' ? { channels: placement.track.channels || 'stereo' } : {}),
      })
      if (!track) throw new Error(`Could not create track for ${placement.asset?.name || placement.asset?.id || 'asset'}.`)
      createdTracks.push(track)
      trackByPlacementIndex.set(placement.index, track)
    }
  }

  const placementsWithLinkedAudio = placements.filter((placement) => (
    plan.includeAudio === true &&
    shouldAddLinkedVideoAudio(placement.asset, { ...payload, includeAudio: true })
  ))
  let sharedAudioTrack = null
  if (placementsWithLinkedAudio.length > 0 && plan.layout === 'sequential') {
    sharedAudioTrack = getAvailableMcpAudioTrack(useTimelineStore.getState())
    if (!sharedAudioTrack) {
      sharedAudioTrack = useTimelineStore.getState().addTrack?.('audio', {
        name: String(payload.audioTrackName || '').trim() || `${String(payload.trackNamePrefix || payload.trackPrefix || 'MCP Review').trim() || 'MCP Review'} Audio`,
        channels: normalizeAudioChannels(payload.channels),
      })
      if (!sharedAudioTrack) throw new Error('Could not create a linked audio track for the batch.')
      createdTracks.push(sharedAudioTrack)
    }
  }

  for (const placement of placements) {
    const track = trackByPlacementIndex.get(placement.index) || placement.track
    if (!track?.id) throw new Error(`No target track was available for ${placement.asset?.name || placement.asset?.id || 'asset'}.`)
    let audioTrack = null
    if (placementsWithLinkedAudio.includes(placement)) {
      if (plan.layout === 'sequential') {
        audioTrack = sharedAudioTrack
      } else {
        audioTrack = useTimelineStore.getState().addTrack?.('audio', {
          name: `${placement.track?.name || placement.asset?.name || 'MCP Review'} Audio`.slice(0, 100),
          channels: normalizeAudioChannels(payload.channels),
        })
        if (!audioTrack) throw new Error(`Could not create a linked audio track for ${placement.asset?.name || placement.asset?.id || 'asset'}.`)
        createdTracks.push(audioTrack)
      }
    }
    const linkGroupId = audioTrack ? makeMcpLinkGroupId(placement.asset, `batch-${placement.index + 1}`) : undefined
    const clip = useTimelineStore.getState().addClip?.(track.id, placement.asset, placement.startSeconds, fps, {
      saveHistory: false,
      selectAfterAdd: false,
      resolveOverlaps: plan.resolveOverlaps,
      duration: placement.durationSeconds,
      ...(linkGroupId ? { linkGroupId } : {}),
      ...(placement.transform ? { transform: safeClone(placement.transform) } : {}),
      metadata: {
        addedByMcp: true,
        addedAt: new Date().toISOString(),
        sourceTool: 'add_assets_to_timeline',
        batchIndex: placement.index,
        batchLayout: plan.layout,
      },
    })
    if (!clip) throw new Error(`Could not add ${placement.asset?.name || placement.asset?.id || 'asset'} to the timeline.`)
    createdClips.push(clip)
    if (placement.labelColor) labelColorByClipId.set(clip.id, placement.labelColor)
    if (audioTrack && linkGroupId) {
      const audioClip = useTimelineStore.getState().addClip?.(audioTrack.id, { ...placement.asset, type: 'audio' }, clip.startTime, fps, {
        saveHistory: false,
        linkGroupId,
        selectAfterAdd: false,
        resolveOverlaps: plan.layout === 'sequential' ? plan.resolveOverlaps : false,
        duration: clip.duration,
        metadata: {
          addedByMcp: true,
          addedAt: new Date().toISOString(),
          sourceTool: 'add_assets_to_timeline',
          batchIndex: placement.index,
          batchLayout: plan.layout,
          linkedVideoClipId: clip.id,
          embeddedAudioFromVideoAsset: true,
        },
      })
      if (audioClip) {
        createdClips.push(audioClip)
        linkedAudioByClipId.set(clip.id, audioClip.id)
      }
    }
  }

  if (createdClips.length > 0 && (labelColorByClipId.size > 0 || plan.selectAfterAdd)) {
    const createdClipIds = createdClips.map((clip) => clip.id)
    useTimelineStore.setState((state) => ({
      clips: labelColorByClipId.size > 0
        ? (state.clips || []).map((clip) => (
          labelColorByClipId.has(clip.id)
            ? { ...clip, labelColor: labelColorByClipId.get(clip.id) }
            : clip
        ))
        : state.clips,
      selectedClipIds: plan.selectAfterAdd ? createdClipIds : state.selectedClipIds,
    }))
  }

  const finalState = useTimelineStore.getState()
  const createdClipIds = new Set(createdClips.map((clip) => clip.id))
  const finalClips = (finalState.clips || []).filter((clip) => createdClipIds.has(clip.id))

  return {
    created: true,
    action: 'add_assets_to_timeline',
    assetCount: placements.length,
    clipCount: finalClips.length,
    linkedAudioClipCount: linkedAudioByClipId.size,
    trackCount: createdTracks.length,
    layout: plan.layout,
    trackStrategy: plan.trackStrategy,
    includeAudio: plan.includeAudio,
    clips: finalClips.map(summarizeClip),
    tracks: createdTracks.map(summarizeTrack),
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
  const clipNeedsVideoTrack = ['video', 'image', 'text', 'shape', 'adjustment', 'caption', 'captions'].includes(sourceClip.type)
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
    source: buildTextClipSummary(sourceClip) || buildShapeClipSummary(sourceClip) || summarizeClip(sourceClip),
    duplicate: buildTextClipSummary(duplicate) || buildShapeClipSummary(duplicate) || summarizeClip(duplicate),
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

function getUpdatedShapeClip(clipId) {
  return useTimelineStore.getState().clips.find((clip) => clip.id === clipId) || null
}

function handleAddShapeClip(payload = {}) {
  const state = useTimelineStore.getState()
  const track = findDefaultTextTrack(state, payload.trackId)
  const shapeUpdates = normalizeShapeStyleUpdates(payload)
  const shapeProperties = normalizeShapeProperties(shapeUpdates)
  const { updates: transformUpdates, deltas: transformDeltas } = normalizeTransformUpdates(payload)
  const startSeconds = Number(payload.startSeconds ?? payload.startTime)
  const startTime = Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : Number(state.playheadPosition) || 0
  const duration = clampNumber(payload.durationSeconds ?? payload.duration, 5, 1 / (Number(state.timelineFps) || 24), 3600)
  const keyframes = normalizeClipKeyframes(payload, { type: 'shape', duration })
  const name = String(payload.name || getShapeDisplayName(shapeProperties)).slice(0, 160)

  const newClip = state.addShapeClip?.(track.id, {
    name,
    shapeProperties,
    duration,
    enabled: payload.enabled !== false,
  }, startTime)
  if (!newClip) throw new Error('Could not create shape clip.')

  const nextTransform = resolveNextTransform(newClip.transform || {}, transformUpdates, transformDeltas)
  if (Object.keys(transformUpdates).length > 0 || Object.keys(transformDeltas).length > 0) {
    useTimelineStore.getState().updateClipTransform?.(newClip.id, nextTransform, false)
  }
  const appliedKeyframes = applyClipKeyframes(useTimelineStore.getState(), newClip.id, keyframes, payload.replaceKeyframes === true)

  return {
    created: true,
    clip: buildShapeClipSummary(getUpdatedShapeClip(newClip.id)),
    track: { id: track.id, name: track.name, type: track.type },
    appliedKeyframes,
  }
}

function handleAddAdjustmentClip(payload = {}) {
  const state = useTimelineStore.getState()
  const shouldCreateTrack = payload.createTrack === true
    || payload.newTrack === true
    || ['new', 'newtop', 'newtrack', 'newtoptrack', 'top'].includes(String(payload.trackStrategy || payload.placementTrack || '').trim().toLowerCase().replace(/[\s_-]+/g, ''))
  const requestedTrackId = String(payload.trackId || '').trim()
  const tracks = Array.isArray(state.tracks) ? state.tracks : []
  let track = null
  if (!shouldCreateTrack || requestedTrackId) {
    track = requestedTrackId
      ? tracks.find((candidate) => candidate.id === requestedTrackId)
      : tracks.find((candidate) => candidate.type === 'video' && candidate.locked !== true)
    if (!track) throw new Error(requestedTrackId ? `Track ${requestedTrackId} was not found.` : 'No unlocked video track is available for an adjustment clip.')
    if (track.type !== 'video') throw new Error(`Track ${requestedTrackId || track.id} is not a video track.`)
    if (track.locked) throw new Error(`Track ${track.id} is locked.`)
  } else {
    track = {
      id: null,
      name: String(payload.trackName || payload.name || 'Adjustment Layer').trim().slice(0, 80) || 'Adjustment Layer',
      type: 'video',
      locked: false,
      muted: false,
      visible: true,
    }
  }
  const startSeconds = Number(payload.startSeconds ?? payload.startTime)
  const startTime = Number.isFinite(startSeconds)
    ? Math.max(0, startSeconds)
    : Number(state.playheadPosition) || 0
  const duration = clampNumber(payload.durationSeconds ?? payload.duration, 5, 1 / (Number(state.timelineFps) || 24), 3600)
  const adjustments = normalizeAdjustmentClipSettings(payload)
  const { updates: transformUpdates, deltas: transformDeltas } = normalizeTransformUpdates(payload)
  const keyframes = normalizeClipKeyframes(payload, { type: 'adjustment', duration })

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'add_adjustment_clip',
      message: 'Adjustment clip creation plan only. No timeline change was made.',
      plan: {
        name: String(payload.name || 'Adjustment Layer').trim().slice(0, 160) || 'Adjustment Layer',
        track: summarizeTrack(track),
        createTrack: shouldCreateTrack && !requestedTrackId,
        startSeconds: startTime,
        durationSeconds: duration,
        enabled: payload.enabled !== false,
        adjustments,
        transform: transformUpdates,
        transformDelta: transformDeltas,
        keyframes,
      },
    }
  }

  let targetTrack = track
  let createdTrack = null
  if (shouldCreateTrack && !requestedTrackId) {
    state.saveToHistory?.()
    targetTrack = useTimelineStore.getState().addTrack?.('video', {
      name: track.name || 'Adjustment Layer',
      position: 'top',
    })
    if (!targetTrack) throw new Error('Could not create a target video track for the adjustment clip.')
    createdTrack = targetTrack
  }

  const newClip = useTimelineStore.getState().addAdjustmentClip?.(targetTrack.id, startTime, {
    name: String(payload.name || 'Adjustment Layer').trim().slice(0, 160) || 'Adjustment Layer',
    duration,
    enabled: payload.enabled !== false,
    adjustments,
    saveHistory: !createdTrack,
  })
  if (!newClip) throw new Error('Could not create adjustment clip.')

  const nextTransform = resolveNextTransform(newClip.transform || {}, transformUpdates, transformDeltas)
  if (Object.keys(transformUpdates).length > 0 || Object.keys(transformDeltas).length > 0) {
    useTimelineStore.getState().updateClipTransform?.(newClip.id, nextTransform, false)
  }
  const appliedKeyframes = applyClipKeyframes(useTimelineStore.getState(), newClip.id, keyframes, payload.replaceKeyframes === true)

  return {
    created: true,
    action: 'add_adjustment_clip',
    clip: buildAdjustmentClipSummary((useTimelineStore.getState().clips || []).find((clip) => clip.id === newClip.id) || newClip),
    track: summarizeTrack(targetTrack),
    createdTrack: createdTrack ? summarizeTrack(createdTrack) : null,
    appliedKeyframes,
  }
}

function handleUpdateShapeClip(payload = {}) {
  const state = useTimelineStore.getState()
  const currentClip = getShapeClipById(state, payload.clipId)
  const shapeUpdates = normalizeShapeStyleUpdates(payload)
  const { updates: transformUpdates, deltas: transformDeltas } = normalizeTransformUpdates(payload)
  const keyframes = normalizeClipKeyframes(payload, currentClip)
  const clearKeyframes = payload.clearKeyframes || payload.clearKeyframesForProperties
  const clearProperties = resolveClipKeyframeClearProperties(clearKeyframes, currentClip)

  const hasStart = hasOwn(payload, 'startSeconds') || hasOwn(payload, 'startTime')
  const hasDuration = hasOwn(payload, 'durationSeconds') || hasOwn(payload, 'duration')
  const nextTrack = hasOwn(payload, 'trackId') ? findDefaultTextTrack(state, payload.trackId) : null
  const nextStart = hasStart
    ? Math.max(0, Number(payload.startSeconds ?? payload.startTime) || 0)
    : currentClip.startTime
  const nextDuration = hasDuration
    ? clampNumber(payload.durationSeconds ?? payload.duration, currentClip.duration || 5, 1 / (Number(state.timelineFps) || 24), 3600)
    : currentClip.duration
  const currentShapeProperties = normalizeShapeProperties(currentClip.shapeProperties || {})
  const hasWidthUpdate = hasOwn(shapeUpdates, 'width')
  const hasHeightUpdate = hasOwn(shapeUpdates, 'height')
  const nextShapeInput = { ...currentShapeProperties, ...shapeUpdates }
  if (currentShapeProperties.shapeType === 'line' && shapeUpdates?.shapeType && shapeUpdates.shapeType !== 'line') {
    nextShapeInput.sizeLinked = DEFAULT_SHAPE_PROPERTIES.sizeLinked
    if (!hasWidthUpdate && !hasHeightUpdate) {
      nextShapeInput.width = DEFAULT_SHAPE_PROPERTIES.width
      nextShapeInput.height = DEFAULT_SHAPE_PROPERTIES.height
    } else if (hasWidthUpdate && !hasHeightUpdate) {
      nextShapeInput.height = nextShapeInput.sizeLinked
        ? Math.max(1, Number(shapeUpdates.width) || DEFAULT_SHAPE_PROPERTIES.height)
        : DEFAULT_SHAPE_PROPERTIES.height
    } else if (!hasWidthUpdate && hasHeightUpdate) {
      nextShapeInput.width = nextShapeInput.sizeLinked
        ? Math.max(1, Number(shapeUpdates.height) || DEFAULT_SHAPE_PROPERTIES.width)
        : DEFAULT_SHAPE_PROPERTIES.width
    }
  }
  const nextShapeProperties = normalizeShapeProperties(nextShapeInput)
  const nextTransform = resolveNextTransform(currentClip.transform || {}, transformUpdates, transformDeltas)
  const nextClipPreview = {
    ...currentClip,
    name: payload.name || currentClip.name,
    trackId: nextTrack?.id || currentClip.trackId,
    startTime: nextStart,
    duration: nextDuration,
    shapeProperties: nextShapeProperties,
    transform: nextTransform,
  }

  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      clipId: currentClip.id,
      before: buildShapeClipSummary(currentClip),
      after: buildShapeClipSummary(nextClipPreview),
      requested: {
        shapeUpdates,
        transformUpdates,
        transformDeltas,
        keyframes,
        clearKeyframes: clearProperties,
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
  if (Object.keys(shapeUpdates).length > 0 || payload.name) {
    useTimelineStore.getState().updateShapeProperties?.(currentClip.id, { ...shapeUpdates, ...(payload.name ? { name: String(payload.name).slice(0, 160) } : {}) }, false)
  }
  if (Object.keys(transformUpdates).length > 0 || Object.keys(transformDeltas).length > 0) {
    useTimelineStore.getState().updateClipTransform?.(currentClip.id, nextTransform, false)
  }
  const clearedKeyframes = clearClipKeyframes(currentClip.id, clearProperties, currentClip)
  const appliedKeyframes = applyClipKeyframes(useTimelineStore.getState(), currentClip.id, keyframes, payload.replaceKeyframes === true)

  return {
    updated: true,
    clip: buildShapeClipSummary(getUpdatedShapeClip(currentClip.id)),
    requested: {
      shapeUpdates,
      transformUpdates,
      transformDeltas,
      clearedKeyframes,
      appliedKeyframes,
    },
  }
}

function handleListGlslEffects(payload = {}) {
  const includePresets = payload.includePresets !== false
  const includeParams = payload.includeParams !== false
  return {
    effects: GLSL_EFFECT_TYPES.map((effect) => {
      const summary = summarizeGlslEffectDefinition(effect)
      if (!includePresets) delete summary.presets
      if (!includeParams) delete summary.params
      return summary
    }),
  }
}

function handleAddGlslEffect(payload = {}) {
  const state = useTimelineStore.getState()
  const currentClip = getClipByIdForEffects(state, payload.clipId)
  const effectDefinition = getGlslEffectDefinition(payload.effectType || payload.type)
  const inputSettings = collectEffectSettingsInput(payload, effectDefinition)
  const settings = normalizeGlslEffectSettings(effectDefinition, {
    inputSettings,
    presetId: payload.presetId || payload.preset,
    includeDefaults: true,
  })
  const keyframes = normalizeGlslEffectKeyframes(payload, effectDefinition)
  const existingEffects = currentClip.effects || []
  const replaceExisting = payload.replaceExisting === true
  const replacedEffectIds = replaceExisting
    ? existingEffects.filter((effect) => effect.type === effectDefinition.id).map((effect) => effect.id).filter(Boolean)
    : []
  const insertIndexRaw = Number(payload.insertIndex)
  const insertIndex = Number.isFinite(insertIndexRaw)
    ? Math.max(0, Math.min(existingEffects.length, Math.floor(insertIndexRaw)))
    : existingEffects.length
  const effectId = `effect-${Date.now()}`
  const newEffect = {
    id: effectId,
    type: effectDefinition.id,
    enabled: payload.enabled !== false,
    settings,
  }
  const previewEffects = [
    ...(replaceExisting ? existingEffects.filter((effect) => effect.type !== effectDefinition.id) : existingEffects),
  ]
  previewEffects.splice(insertIndex, 0, newEffect)
  const previewClip = {
    ...currentClip,
    effects: previewEffects,
  }

  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      action: 'add_glsl_effect',
      message: 'GLSL effect add plan only. No timeline change was made.',
      before: buildEffectClipSummary(currentClip),
      after: buildEffectClipSummary(previewClip),
      requested: {
        effectType: effectDefinition.id,
        presetId: payload.presetId || payload.preset || '',
        settings,
        keyframes,
        replaceExisting,
      },
    }
  }

  state.saveToHistory?.()
  useTimelineStore.setState((currentState) => ({
    clips: (currentState.clips || []).map((clip) => {
      if (clip.id !== currentClip.id) return clip
      const currentEffects = Array.isArray(clip.effects) ? clip.effects : []
      const nextEffects = replaceExisting
        ? currentEffects.filter((effect) => effect.type !== effectDefinition.id)
        : [...currentEffects]
      nextEffects.splice(Math.min(insertIndex, nextEffects.length), 0, newEffect)
      return {
        ...clip,
        effects: nextEffects,
        cacheStatus: clip.cacheStatus === 'cached' ? 'invalid' : clip.cacheStatus,
      }
    }),
  }))
  const appliedKeyframes = applyGlslEffectKeyframes(
    useTimelineStore.getState(),
    currentClip.id,
    effectId,
    keyframes,
    payload.replaceKeyframes === true
  )
  const clearedReplacedKeyframes = replacedEffectIds.flatMap((id) => clearAllKeyframesForEffect(currentClip.id, id))
  const updatedClip = (useTimelineStore.getState().clips || []).find((clip) => clip.id === currentClip.id)

  return {
    created: true,
    action: 'add_glsl_effect',
    clip: buildEffectClipSummary(updatedClip),
    effect: summarizeClipEffect(newEffect),
    appliedKeyframes,
    clearedReplacedKeyframes,
  }
}

function handleUpdateGlslEffect(payload = {}) {
  const state = useTimelineStore.getState()
  const currentClip = getClipByIdForEffects(state, payload.clipId)
  const currentEffect = resolveGlslEffectTarget(currentClip, payload)
  const effectDefinition = getGlslEffectDefinition(currentEffect.type)
  const inputSettings = collectEffectSettingsInput(payload, effectDefinition)
  const settings = normalizeGlslEffectSettings(effectDefinition, {
    existingSettings: currentEffect.settings || {},
    inputSettings,
    presetId: payload.presetId || payload.preset,
  })
  const hasEnabledUpdate = hasOwn(payload, 'enabled')
  const keyframes = normalizeGlslEffectKeyframes(payload, effectDefinition, currentEffect.id)
  const clearParams = normalizeGlslEffectClearParams(payload.clearKeyframes || payload.clearKeyframesForParams, effectDefinition)
  const nextEffect = {
    ...currentEffect,
    ...(hasEnabledUpdate ? { enabled: payload.enabled !== false } : {}),
    settings,
  }
  const previewClip = {
    ...currentClip,
    effects: (currentClip.effects || []).map((effect) => effect.id === currentEffect.id ? nextEffect : effect),
  }

  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      action: 'update_glsl_effect',
      message: 'GLSL effect update plan only. No timeline change was made.',
      before: buildEffectClipSummary(currentClip),
      after: buildEffectClipSummary(previewClip),
      requested: {
        effectId: currentEffect.id,
        effectType: currentEffect.type,
        presetId: payload.presetId || payload.preset || '',
        settings,
        enabled: hasEnabledUpdate ? payload.enabled !== false : currentEffect.enabled !== false,
        keyframes,
        clearKeyframes: clearParams,
      },
    }
  }

  state.saveToHistory?.()
  useTimelineStore.getState().updateEffect?.(currentClip.id, currentEffect.id, {
    ...(hasEnabledUpdate ? { enabled: payload.enabled !== false } : {}),
    settings,
  }, false)
  const clearedKeyframes = clearGlslEffectKeyframes(currentClip.id, currentEffect.id, clearParams)
  const appliedKeyframes = applyGlslEffectKeyframes(
    useTimelineStore.getState(),
    currentClip.id,
    currentEffect.id,
    keyframes,
    payload.replaceKeyframes === true
  )
  const updatedClip = (useTimelineStore.getState().clips || []).find((clip) => clip.id === currentClip.id)
  const updatedEffect = (updatedClip?.effects || []).find((effect) => effect.id === currentEffect.id) || nextEffect

  return {
    updated: true,
    action: 'update_glsl_effect',
    clip: buildEffectClipSummary(updatedClip),
    effect: summarizeClipEffect(updatedEffect),
    requested: {
      clearedKeyframes,
      appliedKeyframes,
    },
  }
}

function handleRemoveGlslEffect(payload = {}) {
  const state = useTimelineStore.getState()
  const currentClip = getClipByIdForEffects(state, payload.clipId)
  const currentEffect = resolveGlslEffectTarget(currentClip, payload)
  const previewClip = {
    ...currentClip,
    effects: (currentClip.effects || []).filter((effect) => effect.id !== currentEffect.id),
  }

  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      action: 'remove_glsl_effect',
      message: 'GLSL effect removal plan only. No timeline change was made.',
      before: buildEffectClipSummary(currentClip),
      after: buildEffectClipSummary(previewClip),
      effect: summarizeClipEffect(currentEffect),
    }
  }

  useTimelineStore.getState().removeEffect?.(currentClip.id, currentEffect.id)
  const clearedKeyframes = clearAllKeyframesForEffect(currentClip.id, currentEffect.id)
  const updatedClip = (useTimelineStore.getState().clips || []).find((clip) => clip.id === currentClip.id)

  return {
    removed: true,
    action: 'remove_glsl_effect',
    clip: buildEffectClipSummary(updatedClip),
    effect: summarizeClipEffect(currentEffect),
    clearedKeyframes,
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
  const filename = sanitizeExportBaseName(payload.filename || `${project.name || 'Velorn'}_export`)
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

async function handleExportFcpXml(payload = {}) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.writeFile || !api?.pathJoin || !api?.createDirectory) {
    throw new Error('FCPXML export is only available in the desktop app.')
  }

  const projectState = useProjectStore.getState()
  const timelineState = useTimelineStore.getState()
  const assetsState = useAssetsStore.getState()
  const projectPath = projectState.currentProjectHandle
  if (typeof projectPath !== 'string' || !projectPath) {
    throw new Error('Open a saved project before exporting FCPXML.')
  }

  const project = projectState.currentProject || {}
  const timelineSettings = typeof projectState.getCurrentTimelineSettings === 'function'
    ? projectState.getCurrentTimelineSettings()
    : (project.settings || {})
  const currentTimeline = (project.timelines || []).find((timeline) => timeline.id === projectState.currentTimelineId)
  const timelineName = currentTimeline?.name || payload.timelineName || 'Timeline'
  const resolvedAssets = await Promise.all((assetsState.assets || []).map(async (asset) => {
    if (!asset?.path) return { ...asset, absolutePath: asset.absolutePath || '' }
    const absolutePath = isAbsoluteMcpFilePath(asset.path)
      ? asset.path
      : await api.pathJoin(projectPath, asset.path)
    return {
      ...asset,
      absolutePath,
      hasAudio: asset.hasAudio ?? asset.settings?.hasAudio,
    }
  }))
  const exportableAssetIds = new Set(resolvedAssets.filter((asset) => asset.absolutePath).map((asset) => asset.id))
  const exportableClipCount = (timelineState.clips || []).filter((clip) => (
    clip?.enabled !== false
    && ['video', 'audio', 'image'].includes(clip?.type)
    && exportableAssetIds.has(clip.assetId)
  )).length
  if (exportableClipCount === 0) {
    throw new Error('No media clips with project file paths are available for FCPXML export.')
  }

  const width = Math.max(1, Math.round(Number(timelineSettings.width || project.settings?.width || 1920)))
  const height = Math.max(1, Math.round(Number(timelineSettings.height || project.settings?.height || 1080)))
  const fps = Math.max(1, Number(timelineSettings.fps || project.settings?.fps || timelineState.timelineFps || 24))
  const timelineEnd = typeof timelineState.getTimelineEndTime === 'function'
    ? timelineState.getTimelineEndTime()
    : getTimelineEndTimeForMcp(timelineState.clips || [], timelineState.duration || currentTimeline?.duration || 0)
  const xml = buildFcpXml({
    projectName: project.name || 'Velorn Project',
    timelineName,
    timelineSettings: { width, height, fps },
    timeline: {
      clips: timelineState.clips || [],
      tracks: timelineState.tracks || [],
      transitions: timelineState.transitions || [],
      duration: timelineEnd,
      timelineFps: fps,
    },
    assets: resolvedAssets,
  })

  const outputFolder = await api.pathJoin(projectPath, 'renders')
  await api.createDirectory(outputFolder)
  const outputPath = String(payload.outputPath || '').trim()
    || await api.pathJoin(
      outputFolder,
      `${sanitizeExportBaseName(payload.filename || `${project.name || 'Velorn'}_${timelineName}`)}_${Date.now()}.fcpxml`
    )
  const writeResult = await api.writeFile(outputPath, xml, { encoding: 'utf8' })
  if (!writeResult?.success) {
    throw new Error(writeResult?.error || 'Failed to write FCPXML file.')
  }

  return {
    exported: true,
    action: 'export_fcpxml',
    outputPath,
    clipCount: exportableClipCount,
    timeline: {
      name: timelineName,
      width,
      height,
      fps,
      duration: timelineEnd,
    },
  }
}

async function handleSetComfyUIConnection(payload = {}) {
  const port = payload?.port ?? payload?.httpBase ?? payload?.url
  const result = await saveLocalComfyConnectionPort(port)
  if (!result?.success) {
    throw new Error(result?.error || 'Could not update local ComfyUI connection.')
  }
  return {
    updated: true,
    config: result.config,
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

function parseMcpTimeValue(value, fps = 24) {
  if (value === null || typeof value === 'undefined' || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = String(value || '').trim()
  if (!raw) return null
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  const parts = raw.split(':').map((part) => Number(part))
  if (parts.some((part) => !Number.isFinite(part))) return null
  if (parts.length === 4) {
    const [hours, minutes, seconds, frames] = parts
    return (hours * 3600) + (minutes * 60) + seconds + (frames / Math.max(1, fps))
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts
    return (hours * 3600) + (minutes * 60) + seconds
  }
  if (parts.length === 2) {
    const [minutes, seconds] = parts
    return (minutes * 60) + seconds
  }
  return null
}

function getMcpRequestedTime(payload = {}, keys = ['timeSeconds', 'time', 'seconds']) {
  const fps = Number(useTimelineStore.getState().timelineFps) || 24
  if (Number.isFinite(Number(payload.frame))) return Number(payload.frame) / fps
  for (const key of keys) {
    if (hasOwn(payload, key)) {
      const parsed = parseMcpTimeValue(payload[key], fps)
      if (parsed !== null) return parsed
    }
  }
  if (hasOwn(payload, 'timecode')) {
    const parsed = parseMcpTimeValue(payload.timecode, fps)
    if (parsed !== null) return parsed
  }
  return null
}

function inferMcpAssetCategory(filePath = '', requestedCategory = '') {
  const requested = String(requestedCategory || '').trim().toLowerCase()
  if (['video', 'audio', 'images'].includes(requested)) return requested
  if (requested === 'image') return 'images'
  const ext = String(filePath || '').trim().split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() || ''
  if (['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'aif', 'aiff'].includes(ext)) return 'audio'
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff'].includes(ext)) return 'images'
  throw new Error('Could not infer asset type from file extension. Provide category="video", "audio", or "images".')
}

function getMcpAssetCreatedTime(asset = {}) {
  const raw = asset.createdAt || asset.imported || asset.created || asset.modified || ''
  const parsed = raw ? Date.parse(raw) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function resolveMcpAssetTargets(payload = {}) {
  const assets = useAssetsStore.getState().assets || []
  const explicitIds = normalizeStringList(payload.assetIds || payload.assetId || payload.ids || payload.id)
  const explicitNames = normalizeStringList(payload.assetNames || payload.assetName || payload.names || payload.name)
  let candidates = []
  const missingAssetIds = []
  const missingAssetNames = []

  if (explicitIds.length > 0 || explicitNames.length > 0) {
    const byId = new Map(assets.map((asset) => [asset?.id, asset]).filter(([id]) => id))
    const seen = new Set()
    for (const assetId of explicitIds) {
      const asset = byId.get(assetId)
      if (!asset) {
        missingAssetIds.push(assetId)
        continue
      }
      if (!seen.has(asset.id)) {
        candidates.push(asset)
        seen.add(asset.id)
      }
    }
    for (const assetName of explicitNames) {
      const lookup = String(assetName || '').trim().toLowerCase()
      const asset = assets.find((candidate) => String(candidate?.name || '').trim().toLowerCase() === lookup)
        || assets.find((candidate) => String(candidate?.name || '').trim().toLowerCase().includes(lookup))
      if (!asset) {
        missingAssetNames.push(assetName)
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

  const typeFilters = normalizeStringList(payload.types || payload.type || payload.assetType).map((type) => {
    const normalized = type.toLowerCase()
    return normalized === 'images' ? 'image' : normalized
  })
  if (typeFilters.length > 0) {
    candidates = candidates.filter((asset) => typeFilters.includes(String(asset?.type || '').toLowerCase()))
  }

  const folderId = String(payload.folderId || payload.sourceFolderId || '').trim()
  if (folderId) {
    candidates = candidates.filter((asset) => (asset?.folderId || null) === folderId)
  } else if (payload.rootOnly === true || payload.sourceRoot === true) {
    candidates = candidates.filter((asset) => !asset?.folderId)
  }

  const query = String(payload.nameIncludes || payload.nameContains || payload.search || payload.query || '').trim().toLowerCase()
  if (query) {
    candidates = candidates.filter((asset) => String(asset?.name || '').toLowerCase().includes(query))
  }

  const statusFilters = normalizeStringList(payload.statuses || payload.status).map((status) => status.toLowerCase())
  if (statusFilters.length > 0) {
    candidates = candidates.filter((asset) => statusFilters.includes(String(asset?.generationStatus || asset?.status || 'none').toLowerCase()))
  }

  const latest = payload.latest === true || payload.latestGenerated === true || String(payload.filter || '').toLowerCase() === 'latest'
  candidates = candidates
    .filter((asset) => asset?.id)
    .sort((a, b) => getMcpAssetCreatedTime(b) - getMcpAssetCreatedTime(a))
  if (latest && candidates.length > 1) candidates = candidates.slice(0, 1)

  return {
    assets: candidates,
    missingAssetIds,
    missingAssetNames,
  }
}

function resolveMcpClipTargets(payload = {}, state = useTimelineStore.getState()) {
  const clips = state.clips || []
  const explicitIds = normalizeStringList(payload.clipIds || payload.clipId || payload.ids || payload.id)
  const clipsById = new Map(clips.map((clip) => [clip.id, clip]))
  let candidates = []
  const missingClipIds = []

  if (explicitIds.length > 0) {
    const seen = new Set()
    for (const clipId of explicitIds) {
      const clip = clipsById.get(clipId)
      if (!clip) {
        missingClipIds.push(clipId)
        continue
      }
      if (!seen.has(clip.id)) {
        candidates.push(clip)
        seen.add(clip.id)
      }
    }
  } else if (payload.selected === true || String(payload.filter || '').trim().toLowerCase() === 'selected') {
    candidates = normalizeStringList(state.selectedClipIds || []).map((clipId) => clipsById.get(clipId)).filter(Boolean)
  } else {
    candidates = clips.slice()
  }

  const filter = String(payload.filter || payload.mode || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (filter === 'disabled') candidates = candidates.filter((clip) => clip.enabled === false)
  if (filter === 'enabled') candidates = candidates.filter((clip) => clip.enabled !== false)
  if (filter === 'visual') candidates = candidates.filter((clip) => CLIP_VISUAL_KEYFRAME_TYPES.has(String(clip.type || '').toLowerCase()))
  if (filter === 'audio') candidates = candidates.filter((clip) => String(clip.type || '').toLowerCase() === 'audio')
  if (filter === 'labeled' || filter === 'colored') candidates = candidates.filter((clip) => Boolean(clip.labelColor))

  const typeFilters = normalizeStringList(payload.types || payload.type || payload.clipType).map((type) => type.toLowerCase())
  if (typeFilters.length > 0) {
    candidates = candidates.filter((clip) => typeFilters.includes(String(clip.type || '').toLowerCase()))
  }

  const trackId = String(payload.trackId || '').trim()
  if (trackId) candidates = candidates.filter((clip) => clip.trackId === trackId)

  const assetId = String(payload.assetId || '').trim()
  if (assetId) candidates = candidates.filter((clip) => clip.assetId === assetId)

  const labelColor = normalizeClipLabelColor(payload.labelColor || payload.clipLabelColor || '')
  if (labelColor) candidates = candidates.filter((clip) => normalizeClipLabelColor(clip.labelColor) === labelColor)

  const query = String(payload.nameIncludes || payload.nameContains || payload.search || payload.query || '').trim().toLowerCase()
  if (query) {
    candidates = candidates.filter((clip) => (
      String(clip.name || '').toLowerCase().includes(query)
      || String(clip.assetName || '').toLowerCase().includes(query)
      || String(clip.id || '').toLowerCase().includes(query)
    ))
  }

  const timeSeconds = getMcpRequestedTime(payload, ['timeSeconds', 'time', 'atSeconds'])
  if (timeSeconds !== null) {
    candidates = candidates.filter((clip) => {
      const start = Number(clip.startTime) || 0
      const end = start + (Number(clip.duration) || 0)
      return start <= timeSeconds && end > timeSeconds
    })
  }

  candidates = candidates.filter((clip) => clip?.id)
  const order = String(payload.order || 'timeline').trim().toLowerCase()
  if (order === 'top' || order === 'topmost') {
    const tracks = state.tracks || []
    const trackIndex = new Map(tracks.map((track, index) => [track.id, index]))
    candidates.sort((a, b) => (trackIndex.get(a.trackId) ?? 9999) - (trackIndex.get(b.trackId) ?? 9999))
  } else {
    candidates.sort((a, b) => {
      if (a.trackId !== b.trackId) return String(a.trackId || '').localeCompare(String(b.trackId || ''))
      return (Number(a.startTime) || 0) - (Number(b.startTime) || 0)
    })
  }

  return {
    clips: candidates,
    missingClipIds,
    filter,
  }
}

function getMcpUndoRedoAvailability() {
  const timelineState = useTimelineStore.getState()
  const projectState = useProjectStore.getState()
  return {
    timeline: {
      canUndo: Boolean(timelineState.canUndo?.()),
      canRedo: Boolean(timelineState.canRedo?.()),
      lastChangedAt: Number(timelineState.historyLastChangedAt) || 0,
    },
    project: {
      canUndo: Boolean(projectState.canUndoTimelineStructureChange?.()),
      canRedo: Boolean(projectState.canRedoTimelineStructureChange?.()),
      lastChangedAt: Number(projectState.projectHistoryLastChangedAt) || 0,
    },
  }
}

function chooseMcpUndoRedoScope(direction = 'undo', requestedScope = 'auto') {
  const availability = getMcpUndoRedoAvailability()
  const scope = String(requestedScope || 'auto').trim().toLowerCase()
  const capability = direction === 'redo' ? 'canRedo' : 'canUndo'
  if (scope === 'timeline' || scope === 'clip' || scope === 'edit') return { scope: 'timeline', availability }
  if (scope === 'project' || scope === 'structure' || scope === 'sequence') return { scope: 'project', availability }
  const timelineAvailable = availability.timeline[capability]
  const projectAvailable = availability.project[capability]
  if (timelineAvailable && projectAvailable) {
    return {
      scope: availability.project.lastChangedAt > availability.timeline.lastChangedAt ? 'project' : 'timeline',
      availability,
    }
  }
  if (timelineAvailable) return { scope: 'timeline', availability }
  if (projectAvailable) return { scope: 'project', availability }
  return { scope: 'none', availability }
}

function handleUndoRedo(payload = {}) {
  const direction = String(payload.direction || payload.action || 'undo').trim().toLowerCase() === 'redo' ? 'redo' : 'undo'
  const { scope, availability } = chooseMcpUndoRedoScope(direction, payload.scope || 'auto')
  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      action: direction,
      chosenScope: scope,
      availability,
      message: scope === 'none' ? `Nothing available to ${direction}.` : `${direction} would apply to ${scope} history.`,
    }
  }
  if (scope === 'none') {
    return {
      success: false,
      action: direction,
      chosenScope: scope,
      availability,
      message: `Nothing available to ${direction}.`,
    }
  }

  const timelineState = useTimelineStore.getState()
  const projectState = useProjectStore.getState()
  const applied = scope === 'project'
    ? (direction === 'redo'
      ? Boolean(projectState.redoTimelineStructureChange?.())
      : Boolean(projectState.undoTimelineStructureChange?.()))
    : (direction === 'redo'
      ? Boolean(timelineState.redo?.())
      : Boolean(timelineState.undo?.()))

  return {
    success: applied,
    action: direction,
    scope,
    availabilityBefore: availability,
    availabilityAfter: getMcpUndoRedoAvailability(),
  }
}

function handleSetPlayhead(payload = {}) {
  const state = useTimelineStore.getState()
  const fps = Number(state.timelineFps) || 24
  const requestedTime = getMcpRequestedTime(payload, ['timeSeconds', 'time', 'seconds', 'atSeconds'])
  if (requestedTime === null) throw new Error('Provide timeSeconds, timecode, or frame for set_playhead.')
  const timeSeconds = roundToTimelineFrame(Math.max(0, requestedTime), fps)
  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      action: 'set_playhead',
      currentTimeSeconds: Number(state.playheadPosition) || 0,
      nextTimeSeconds: timeSeconds,
    }
  }
  state.setPlayheadPosition?.(timeSeconds, { snap: payload.snapToFrame !== false })
  return {
    success: true,
    action: 'set_playhead',
    timeSeconds,
  }
}

function handleSelectClips(payload = {}) {
  const state = useTimelineStore.getState()
  const { clips, missingClipIds, filter } = resolveMcpClipTargets(payload, state)
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(payload.limit) || 200)))
  if (clips.length > limit) throw new Error(`Matched ${clips.length} clips, above limit ${limit}. Pass a higher limit intentionally if this is expected.`)
  const clear = payload.clear === true || payload.clearSelection === true
  const clipIds = clips.map((clip) => clip.id)
  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      action: 'select_clips',
      clear,
      filter,
      selectedClipIds: clipIds,
      clipCount: clipIds.length,
      missingClipIds,
      clips: clips.map(summarizeClip),
    }
  }
  if (clear && clipIds.length === 0) {
    state.clearSelection?.()
  } else {
    state.selectClips?.(clipIds)
  }
  if ((payload.movePlayheadToStart === true || payload.goToStart === true) && clips[0]) {
    state.setPlayheadPosition?.(Number(clips[0].startTime) || 0, { snap: true })
  }
  return {
    success: true,
    action: 'select_clips',
    selectedClipIds: clear && clipIds.length === 0 ? [] : clipIds,
    clipCount: clipIds.length,
    missingClipIds,
    clips: clips.map(summarizeClip),
  }
}

function handleSelectAssets(payload = {}) {
  const { assets, missingAssetIds, missingAssetNames } = resolveMcpAssetTargets(payload)
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(payload.limit) || 200)))
  if (assets.length > limit) throw new Error(`Matched ${assets.length} assets, above limit ${limit}. Pass a higher limit intentionally if this is expected.`)
  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      action: 'select_assets',
      selectedAssetIds: assets.map((asset) => asset.id),
      assetCount: assets.length,
      missingAssetIds,
      missingAssetNames,
      assets: assets.map(summarizeAsset),
    }
  }
  if (payload.setPreview !== false && assets[0]) {
    useAssetsStore.getState().setPreview?.(assets[0])
  }
  return {
    success: true,
    action: 'select_assets',
    selectedAssetIds: assets.map((asset) => asset.id),
    previewAssetId: payload.setPreview !== false ? (assets[0]?.id || null) : null,
    assetCount: assets.length,
    missingAssetIds,
    missingAssetNames,
    assets: assets.map(summarizeAsset),
  }
}

function buildProjectCheckpointSnapshot(label = '') {
  const projectState = useProjectStore.getState()
  const timelineState = useTimelineStore.getState()
  const assetsState = useAssetsStore.getState()
  const project = projectState.currentProject
  if (!project) throw new Error('Open a project before creating an MCP checkpoint.')

  const currentTimelineId = projectState.currentTimelineId || project.currentTimelineId
  const currentTimelineData = timelineState.getProjectData?.() || {}
  const timelines = (project.timelines || []).map((timeline) => (
    timeline.id === currentTimelineId
      ? { ...timeline, ...safeClone(currentTimelineData), modified: new Date().toISOString() }
      : safeClone(timeline)
  ))

  return {
    id: `checkpoint-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    label: String(label || 'MCP checkpoint').slice(0, 120),
    createdAt: new Date().toISOString(),
    projectHandle: projectState.currentProjectHandle,
    currentTimelineId,
    project: safeClone({ ...project, timelines, currentTimelineId }),
    assetsState: {
      assets: safeClone(assetsState.assets || []),
      folders: safeClone(assetsState.folders || []),
      assetCounter: assetsState.assetCounter || 1,
      folderCounter: assetsState.folderCounter || 1,
      currentPreviewId: assetsState.currentPreview?.id || null,
    },
    timelineUi: {
      playheadPosition: Number(timelineState.playheadPosition) || 0,
      inPoint: timelineState.inPoint ?? null,
      outPoint: timelineState.outPoint ?? null,
      selectedClipIds: safeClone(timelineState.selectedClipIds || []),
      selectedTransitionId: timelineState.selectedTransitionId || null,
      selectedMarkerId: timelineState.selectedMarkerId || null,
    },
  }
}

function handleCreateProjectCheckpoint(payload = {}) {
  const checkpoint = buildProjectCheckpointSnapshot(payload.label || payload.name || '')
  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      action: 'create_project_checkpoint',
      message: 'Project checkpoint plan only. No checkpoint was stored.',
      checkpoint: {
        id: checkpoint.id,
        label: checkpoint.label,
        createdAt: checkpoint.createdAt,
        timelineCount: checkpoint.project?.timelines?.length || 0,
        assetCount: checkpoint.assetsState.assets.length,
      },
      existingCheckpointCount: MCP_PROJECT_CHECKPOINTS.size,
    }
  }

  MCP_PROJECT_CHECKPOINTS.set(checkpoint.id, checkpoint)
  while (MCP_PROJECT_CHECKPOINTS.size > MCP_PROJECT_CHECKPOINT_LIMIT) {
    const oldest = MCP_PROJECT_CHECKPOINTS.keys().next().value
    MCP_PROJECT_CHECKPOINTS.delete(oldest)
  }
  return {
    success: true,
    action: 'create_project_checkpoint',
    checkpointId: checkpoint.id,
    label: checkpoint.label,
    createdAt: checkpoint.createdAt,
    checkpointCount: MCP_PROJECT_CHECKPOINTS.size,
    message: 'Created an in-memory MCP project checkpoint for this Velorn session.',
  }
}

async function handleRestoreProjectCheckpoint(payload = {}) {
  const requestedId = String(payload.checkpointId || payload.id || '').trim()
  const checkpoint = requestedId
    ? MCP_PROJECT_CHECKPOINTS.get(requestedId)
    : [...MCP_PROJECT_CHECKPOINTS.values()][MCP_PROJECT_CHECKPOINTS.size - 1]
  if (!checkpoint) {
    throw new Error(requestedId
      ? `Checkpoint ${requestedId} was not found.`
      : 'No MCP project checkpoints exist in this app session.')
  }

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'restore_project_checkpoint',
      message: 'Checkpoint restore plan only. No project state was changed.',
      checkpoint: {
        id: checkpoint.id,
        label: checkpoint.label,
        createdAt: checkpoint.createdAt,
        currentTimelineId: checkpoint.currentTimelineId,
        timelineCount: checkpoint.project?.timelines?.length || 0,
        assetCount: checkpoint.assetsState?.assets?.length || 0,
      },
      suggestedApplyPayload: {
        checkpointId: checkpoint.id,
        previewOnly: false,
      },
    }
  }

  const project = safeClone(checkpoint.project)
  const assets = safeClone(checkpoint.assetsState?.assets || [])
  const folders = safeClone(checkpoint.assetsState?.folders || [])
  const currentTimelineId = checkpoint.currentTimelineId || project?.currentTimelineId || project?.timelines?.[0]?.id || null
  const timeline = (project?.timelines || []).find((candidate) => candidate.id === currentTimelineId) || project?.timelines?.[0] || null
  if (!project || !timeline) throw new Error('Checkpoint is missing project or timeline data.')

  const currentPreview = assets.find((asset) => asset.id === checkpoint.assetsState?.currentPreviewId) || null
  useAssetsStore.setState({
    assets,
    folders,
    assetCounter: checkpoint.assetsState?.assetCounter || Math.max(1, assets.length + 1),
    folderCounter: checkpoint.assetsState?.folderCounter || Math.max(1, folders.length + 1),
    currentPreview,
  })
  useProjectStore.setState({
    currentProject: project,
    currentProjectHandle: checkpoint.projectHandle,
    currentTimelineId,
  })
  useTimelineStore.getState().loadFromProject(timeline, assets, timeline.fps || project.settings?.fps || 24)
  useTimelineStore.setState({
    playheadPosition: checkpoint.timelineUi?.playheadPosition || 0,
    inPoint: checkpoint.timelineUi?.inPoint ?? null,
    outPoint: checkpoint.timelineUi?.outPoint ?? null,
    selectedClipIds: checkpoint.timelineUi?.selectedClipIds || [],
    selectedTransitionId: checkpoint.timelineUi?.selectedTransitionId || null,
    selectedMarkerId: checkpoint.timelineUi?.selectedMarkerId || null,
  })

  const savedProject = payload.saveProject === true && typeof useProjectStore.getState().saveProject === 'function'
    ? await useProjectStore.getState().saveProject()
    : null

  return {
    success: true,
    action: 'restore_project_checkpoint',
    checkpointId: checkpoint.id,
    label: checkpoint.label,
    restoredTimelineId: currentTimelineId,
    savedProject: Boolean(savedProject),
    message: savedProject
      ? 'Restored the MCP checkpoint and saved the project file.'
      : 'Restored the MCP checkpoint in the open Velorn session.',
  }
}

async function resolveMcpFolderIdForImportedAsset(payload = {}) {
  const folderId = String(payload.folderId || '').trim()
  if (folderId) {
    const folder = (useAssetsStore.getState().folders || []).find((candidate) => candidate?.id === folderId)
    if (!folder) throw new Error(`Asset folder ${folderId} was not found.`)
    return folderId
  }
  const folderPath = payload.folderPath || payload.targetFolderPath || payload.folderName || payload.folder
  if (!folderPath) return null
  const created = await handleCreateAssetFolder({
    path: folderPath,
    color: payload.folderColor || '',
    previewOnly: false,
  })
  return created.folderId || null
}

async function handleImportAssetFromPath(payload = {}) {
  const sourcePath = String(payload.path || payload.filePath || payload.sourcePath || '').trim()
  if (!sourcePath) throw new Error('Provide path, filePath, or sourcePath for import_asset_from_path.')
  if (!useProjectStore.getState().currentProjectHandle) throw new Error('Open a saved Velorn project before importing assets.')
  if (!isAbsoluteMcpFilePath(sourcePath)) throw new Error('Provide an absolute local file path to import.')
  const category = inferMcpAssetCategory(sourcePath, payload.category || payload.type || payload.assetType)

  let exists = true
  if (typeof window !== 'undefined' && window.electronAPI?.exists) {
    exists = await window.electronAPI.exists(sourcePath)
  }
  if (!exists) throw new Error(`File does not exist: ${sourcePath}`)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'import_asset_from_path',
      message: 'Asset import plan only. No file was copied.',
      sourcePath,
      category,
      targetFolder: payload.folderId || payload.folderPath || payload.folderName || null,
      suggestedApplyPayload: {
        ...payload,
        category,
        previewOnly: false,
      },
    }
  }

  const folderId = await resolveMcpFolderIdForImportedAsset(payload)
  const projectHandle = useProjectStore.getState().currentProjectHandle
  const imported = await importAsset(projectHandle, sourcePath, category)
  const url = imported.absolutePath ? await getAbsoluteFileUrl(imported.absolutePath) : imported.url
  const asset = useAssetsStore.getState().addAsset({
    ...imported,
    url: url || imported.url || null,
    folderId,
    sourceTool: 'import_asset_from_path',
    settings: {
      ...(imported.settings || {}),
      importedViaMcp: true,
      sourcePath,
    },
  })
  const savedProject = typeof useProjectStore.getState().saveProject === 'function'
    ? await useProjectStore.getState().saveProject()
    : null
  return {
    success: true,
    action: 'import_asset_from_path',
    message: 'Imported local file into the active Velorn project.',
    sourcePath,
    category,
    folderId,
    asset: summarizeAsset(asset),
    savedProject: Boolean(savedProject),
  }
}

async function handleRelinkAsset(payload = {}) {
  const newPath = String(payload.path || payload.filePath || payload.sourcePath || '').trim()
  if (!newPath) throw new Error('Provide path, filePath, or sourcePath for relink_asset.')
  if (!isAbsoluteMcpFilePath(newPath)) throw new Error('Provide an absolute local file path to relink an asset.')

  const { assets, missingAssetIds, missingAssetNames } = resolveMcpAssetTargets({
    assetId: payload.assetId || payload.id,
    assetName: payload.assetName || payload.name,
    assetIds: payload.assetIds,
    assetNames: payload.assetNames,
    latest: payload.latest,
    nameIncludes: payload.nameIncludes,
    type: payload.type,
    limit: payload.limit,
  })
  if (assets.length === 0) throw new Error('No matching asset found for relink_asset.')
  if (assets.length > 1) throw new Error(`Matched ${assets.length} assets. Provide a single assetId for relink_asset.`)

  let exists = true
  if (typeof window !== 'undefined' && window.electronAPI?.exists) {
    exists = await window.electronAPI.exists(newPath)
  }
  if (!exists) throw new Error(`Replacement file does not exist: ${newPath}`)

  const asset = assets[0]
  const inferredCategory = inferMcpAssetCategory(newPath, payload.category || payload.type || asset.type)
  const inferredType = inferredCategory === 'images' ? 'image' : inferredCategory
  const currentType = String(asset.type || '').toLowerCase()
  if (currentType && inferredType && currentType !== inferredType && payload.allowTypeChange !== true) {
    throw new Error(`Replacement file looks like ${inferredType}, but asset ${asset.id} is ${currentType}. Pass allowTypeChange=true if that is intentional.`)
  }

  const url = await getAbsoluteFileUrl(newPath)
  const updates = {
    absolutePath: newPath,
    path: newPath,
    url: url || null,
    isImported: true,
    type: payload.allowTypeChange === true ? inferredType : asset.type,
    relinkedAt: new Date().toISOString(),
    playbackCachePath: undefined,
    playbackCacheUrl: undefined,
    playbackCacheStatus: undefined,
    proxyPath: undefined,
    proxyUrl: undefined,
    proxyStatus: undefined,
    sprite: undefined,
    poster: undefined,
    settings: {
      ...(asset.settings || {}),
      relinkedViaMcp: true,
      relinkedFromPath: asset.absolutePath || asset.path || '',
      sourcePath: newPath,
    },
  }

  const plan = {
    action: 'relink_asset',
    asset: summarizeAsset(asset),
    newPath,
    inferredType,
    missingAssetIds,
    missingAssetNames,
    updates: {
      absolutePath: updates.absolutePath,
      path: updates.path,
      isImported: updates.isImported,
      type: updates.type,
    },
  }

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      message: 'Asset relink plan only. No project metadata was changed.',
      ...plan,
      suggestedApplyPayload: {
        ...payload,
        previewOnly: false,
      },
    }
  }

  useAssetsStore.getState().updateAsset(asset.id, updates)
  const updatedAsset = (useAssetsStore.getState().assets || []).find((candidate) => candidate?.id === asset.id) || { ...asset, ...updates }
  if (payload.setPreview !== false && typeof useAssetsStore.getState().setPreview === 'function') {
    useAssetsStore.getState().setPreview(updatedAsset)
  }
  const savedProject = typeof useProjectStore.getState().saveProject === 'function'
    ? await useProjectStore.getState().saveProject()
    : null

  return {
    success: true,
    action: 'relink_asset',
    message: 'Relinked asset to the replacement local file path.',
    asset: summarizeAsset(updatedAsset),
    previousPath: asset.absolutePath || asset.path || '',
    newPath,
    savedProject: Boolean(savedProject),
  }
}

function handleSetClipStyle(payload = {}) {
  const state = useTimelineStore.getState()
  const { clips, missingClipIds, filter } = resolveMcpClipTargets(payload, state)
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(payload.limit) || 100)))
  if (clips.length === 0) throw new Error('No matching clips found for set_clip_style.')
  if (clips.length > limit) throw new Error(`Matched ${clips.length} clips, above limit ${limit}. Pass a higher limit intentionally if this is expected.`)

  const { updates: transformUpdates, deltas: transformDeltas } = normalizeTransformUpdates(payload)
  const hasTransformUpdates = Object.keys(transformUpdates).length > 0 || Object.keys(transformDeltas).length > 0
  const labelWasProvided = hasOwn(payload, 'labelColor') || hasOwn(payload, 'clipLabelColor') || hasOwn(payload, 'timelineColor')
  const labelColor = labelWasProvided ? normalizeClipLabelColor(payload.labelColor || payload.clipLabelColor || payload.timelineColor || '') : ''
  if (labelWasProvided && (payload.labelColor || payload.clipLabelColor || payload.timelineColor) && !labelColor) {
    throw new Error('Invalid label color. Use a hex color like #f97316, or an empty string to clear labels.')
  }
  const enabledWasProvided = hasOwn(payload, 'enabled')
  if (!hasTransformUpdates && !labelWasProvided && !enabledWasProvided) {
    throw new Error('Provide transform updates, labelColor, or enabled for set_clip_style.')
  }

  const plan = {
    action: 'set_clip_style',
    clipCount: clips.length,
    filter,
    missingClipIds,
    changes: {
      transform: hasTransformUpdates ? { updates: transformUpdates, deltas: transformDeltas } : null,
      labelColor: labelWasProvided ? labelColor : undefined,
      enabled: enabledWasProvided ? Boolean(payload.enabled) : undefined,
    },
    clips: clips.map((clip) => ({
      ...summarizeClip(clip),
      enabled: clip.enabled !== false,
      transform: clip.transform || {},
    })),
  }

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      message: 'Clip style plan only. No timeline change was made.',
      plan,
      suggestedApplyPayload: {
        ...payload,
        previewOnly: false,
      },
    }
  }

  const targetIds = new Set(clips.map((clip) => clip.id))
  state.saveToHistory?.()
  useTimelineStore.setState((currentState) => ({
    clips: (currentState.clips || []).map((clip) => {
      if (!targetIds.has(clip.id)) return clip
      const nextClip = { ...clip }
      if (hasTransformUpdates) {
        nextClip.transform = resolveNextTransform(clip.transform || {}, transformUpdates, transformDeltas)
      }
      if (labelWasProvided) nextClip.labelColor = labelColor
      if (enabledWasProvided) nextClip.enabled = Boolean(payload.enabled)
      return nextClip
    }),
  }))

  const updatedClips = (useTimelineStore.getState().clips || []).filter((clip) => targetIds.has(clip.id))
  return {
    success: true,
    action: 'set_clip_style',
    clipCount: updatedClips.length,
    missingClipIds,
    changes: plan.changes,
    clips: updatedClips.map((clip) => ({
      ...summarizeClip(clip),
      enabled: clip.enabled !== false,
      transform: clip.transform || {},
    })),
  }
}

function handleSetInOutRange(payload = {}) {
  const state = useTimelineStore.getState()
  const fps = Number(state.timelineFps) || 24
  const clear = payload.clear === true || payload.clearRange === true
  const clearIn = clear || payload.clearIn === true
  const clearOut = clear || payload.clearOut === true
  let inPoint = null
  let outPoint = null

  if (payload.fromSelection === true || String(payload.from || '').toLowerCase() === 'selection') {
    const selectedIds = new Set(normalizeStringList(state.selectedClipIds || []))
    const selectedClips = (state.clips || []).filter((clip) => selectedIds.has(clip.id))
    if (selectedClips.length === 0) throw new Error('No selected clips are available for fromSelection range.')
    inPoint = Math.min(...selectedClips.map((clip) => Number(clip.startTime) || 0))
    outPoint = Math.max(...selectedClips.map((clip) => (Number(clip.startTime) || 0) + (Number(clip.duration) || 0)))
  } else if (!clear) {
    const start = parseMcpTimeValue(payload.startSeconds ?? payload.start ?? payload.inSeconds ?? payload.inPoint ?? payload.inTimecode, fps)
    const end = parseMcpTimeValue(payload.endSeconds ?? payload.end ?? payload.outSeconds ?? payload.outPoint ?? payload.outTimecode, fps)
    const duration = Number(payload.durationSeconds ?? payload.duration)
    if (start !== null) inPoint = start
    if (end !== null) outPoint = end
    if (inPoint !== null && outPoint === null && Number.isFinite(duration) && duration > 0) outPoint = inPoint + duration
    if (outPoint !== null && inPoint === null && Number.isFinite(duration) && duration > 0) inPoint = Math.max(0, outPoint - duration)
  }

  if (!clear && !clearIn && !clearOut && inPoint === null && outPoint === null) {
    throw new Error('Provide start/end, duration, fromSelection=true, or clear=true for set_in_out_range.')
  }

  const nextIn = clearIn ? null : (inPoint !== null ? roundToTimelineFrame(Math.max(0, inPoint), fps) : state.inPoint)
  const nextOut = clearOut ? null : (outPoint !== null ? roundToTimelineFrame(Math.max(0, outPoint), fps) : state.outPoint)
  if (nextIn !== null && nextOut !== null && nextOut <= nextIn) {
    throw new Error('Out point must be after in point.')
  }

  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      action: 'set_in_out_range',
      current: { inPoint: state.inPoint, outPoint: state.outPoint },
      next: { inPoint: nextIn, outPoint: nextOut },
      rangeSeconds: nextIn !== null && nextOut !== null ? nextOut - nextIn : null,
    }
  }

  if (clear) {
    state.clearInOutPoints?.()
  } else {
    if (clearIn) state.clearInPoint?.()
    if (clearOut) state.clearOutPoint?.()
    if (nextIn !== state.inPoint && nextIn !== null) state.setInPoint?.(nextIn)
    if (nextOut !== state.outPoint && nextOut !== null) state.setOutPoint?.(nextOut)
  }

  const nextState = useTimelineStore.getState()
  return {
    success: true,
    action: 'set_in_out_range',
    inPoint: nextState.inPoint,
    outPoint: nextState.outPoint,
    rangeSeconds: nextState.inPoint !== null && nextState.outPoint !== null
      ? nextState.outPoint - nextState.inPoint
      : null,
  }
}

async function handleMcpAction(request = {}) {
  switch (request.action) {
    case 'undo':
    case 'redo':
    case 'undo_redo':
      return handleUndoRedo({
        ...(request.payload || {}),
        direction: request.action === 'undo_redo'
          ? (request.payload?.direction || request.payload?.action || 'undo')
          : request.action,
      })
    case 'set_playhead':
      return handleSetPlayhead(request.payload || {})
    case 'select_clips':
      return handleSelectClips(request.payload || {})
    case 'select_assets':
      return handleSelectAssets(request.payload || {})
    case 'create_project_checkpoint':
      return handleCreateProjectCheckpoint(request.payload || {})
    case 'restore_project_checkpoint':
      return handleRestoreProjectCheckpoint(request.payload || {})
    case 'import_asset_from_path':
      return handleImportAssetFromPath(request.payload || {})
    case 'relink_asset':
      return handleRelinkAsset(request.payload || {})
    case 'set_clip_style':
      return handleSetClipStyle(request.payload || {})
    case 'set_in_out_range':
      return handleSetInOutRange(request.payload || {})
    case 'create_project':
      return handleCreateProject(request.payload || {})
    case 'duplicate_project':
      return handleDuplicateProject(request.payload || {})
    case 'open_project':
      return handleOpenProject(request.payload || {})
    case 'list_recent_projects':
      return handleListRecentProjects(request.payload || {})
    case 'list_glsl_effects':
      return handleListGlslEffects(request.payload || {})
    case 'set_clip_label_color':
      return handleSetClipLabelColor(request.payload || {})
    case 'set_clips_enabled':
      return handleSetClipsEnabled(request.payload || {})
    case 'prepare_generation_from_timeline_context':
      return handlePrepareGenerationFromTimelineContext(request.payload || {})
    case 'queue_prepared_generation':
      return handleQueuePreparedGeneration(request.payload || {})
    case 'queue_timeline_generation_batch':
      return handleQueueTimelineGenerationBatch(request.payload || {})
    case 'queue_prompt_generation_batch':
      return handleQueuePromptGenerationBatch(request.payload || {})
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
    case 'create_timeline':
      return handleCreateTimeline(request.payload || {})
    case 'create_asset_folder':
      return handleCreateAssetFolder(request.payload || {})
    case 'move_assets_to_folder':
      return handleMoveAssetsToFolder(request.payload || {})
    case 'move_unused_assets_to_folder':
      return handleMoveUnusedAssetsToFolder(request.payload || {})
    case 'add_track':
      return handleAddTrack(request.payload || {})
    case 'update_track':
      return handleUpdateTrack(request.payload || {})
    case 'remove_track':
      return handleRemoveTrack(request.payload || {})
    case 'switch_timeline':
      return handleSwitchTimeline(request.payload || {})
    case 'rename_timeline':
      return handleRenameTimeline(request.payload || {})
    case 'duplicate_timeline':
      return handleDuplicateTimeline(request.payload || {})
    case 'delete_timeline':
      return handleDeleteTimeline(request.payload || {})
    case 'add_transition':
      return handleAddTransition(request.payload || {})
    case 'update_transition':
      return handleUpdateTransition(request.payload || {})
    case 'remove_transitions':
      return handleRemoveTransitions(request.payload || {})
    case 'move_clips':
      return handleMoveClips(request.payload || {})
    case 'trim_clips':
      return handleTrimClips(request.payload || {})
    case 'delete_clips':
      return handleDeleteClips(request.payload || {})
    case 'add_asset_to_timeline':
      return handleAddAssetToTimeline(request.payload || {})
    case 'replace_clip_with_asset':
      return handleReplaceClipWithAsset(request.payload || {})
    case 'add_assets_to_timeline':
      return handleAddAssetsToTimeline(request.payload || {})
    case 'add_solid_color':
      return handleAddSolidColor(request.payload || {})
    case 'duplicate_clip':
      return handleDuplicateClip(request.payload || {})
    case 'add_text_clip':
      return handleAddTextClip(request.payload || {})
    case 'update_text_clip':
      return handleUpdateTextClip(request.payload || {})
    case 'transcribe_captions':
      return handleTranscribeCaptions(request.payload || {})
    case 'get_caption_status':
      return handleGetCaptionStatus(request.payload || {})
    case 'update_caption_cues':
      return handleUpdateCaptionCues(request.payload || {})
    case 'generate_captions':
      return handleGenerateCaptions(request.payload || {})
    case 'add_shape_clip':
      return handleAddShapeClip(request.payload || {})
    case 'update_shape_clip':
      return handleUpdateShapeClip(request.payload || {})
    case 'add_adjustment_clip':
      return handleAddAdjustmentClip(request.payload || {})
    case 'add_glsl_effect':
      return handleAddGlslEffect(request.payload || {})
    case 'update_glsl_effect':
      return handleUpdateGlslEffect(request.payload || {})
    case 'remove_glsl_effect':
      return handleRemoveGlslEffect(request.payload || {})
    case 'set_clip_keyframes':
      return handleSetClipKeyframes(request.payload || {})
    case 'add_dip_to_black':
      return handleAddDipToBlack(request.payload || {})
    case 'set_comfyui_connection':
      return handleSetComfyUIConnection(request.payload || {})
    case 'export_timeline':
      return handleExportTimeline(request.payload || {})
    case 'export_fcpxml':
      return handleExportFcpXml(request.payload || {})
    default:
      throw new Error(`Unknown MCP action: ${request.action || 'unknown'}`)
  }
}

export async function runMcpAction(action, payload = {}) {
  return handleMcpAction({ action, payload })
}

export function startMcpActionBridge() {
  const api = typeof window !== 'undefined' ? window.electronAPI?.mcp : null
  if (!api?.onAction || !api?.sendActionResult) return () => {}

  return api.onAction(async (request = {}) => {
    try {
      const result = await runMcpAction(request.action, request.payload || {})
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
