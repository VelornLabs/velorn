const fs = require('fs').promises
const http = require('http')
const path = require('path')

const DEFAULT_MCP_PORT = 19790
const MCP_PROTOCOL_VERSION = '2024-11-05'

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
    Math.abs(toFiniteNumber(transform.scaleX, 100) - 100) > 0.001,
    Math.abs(toFiniteNumber(transform.scaleY, 100) - 100) > 0.001,
    Math.abs(toFiniteNumber(transform.rotation, 0)) > 0.001,
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
        id: 'text_motion_graphics',
        title: 'Text And Motion Graphics Pass',
        goal: 'Create tracks and text clips, adjust typography, crop/move/scale/rotate/blur them, and set explicit transform/color keyframes for simple title animation.',
        prompt: 'Create a text title at the playhead, preview the timing/style/transform first, then add it. If I ask for another layer, create a new top video track first. If I ask for a split or cloned title effect, use duplicate_clip to clone the existing text clip, set static crop percentages on each copy, then animate each layer separately. If I ask for motion or color changes, use explicit keyframes so I can ask for things like faster, lower, blur, rotate, bounce, gravity, or change color. For richer motion, use easing strings like cubicBezier(0.55,0,1,0.45).',
        tools: ['get_timeline', 'inspect_timeline_frame', 'add_track', 'add_text_clip', 'duplicate_clip', 'update_text_clip'],
        safeDefaults: {
          previewOnlyFirst: true,
          useExplicitClipIdsForUpdates: true,
          createVideoTrackForNewTextLayer: true,
          supportedStaticCropFields: ['cropTop', 'cropBottom', 'cropLeft', 'cropRight'],
          supportedKeyframes: ['opacity', 'positionX', 'positionY', 'scaleX', 'scaleY', 'rotation', 'blur', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight', 'textColor'],
          supportedEasing: ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold', 'cubicBezier(x1,y1,x2,y2)'],
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
      'Use add_track, add_text_clip, duplicate_clip, and update_text_clip with previewOnly for AI-assisted text/title graphics.',
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

  const visualTypes = new Set(['video', 'image', 'text'])
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
    && ['video', 'image', 'text'].includes(type)
    && getClipDuration(clip) > 0
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
            description: 'Optional absolute transform values. positionX/positionY are pixels relative to center; scale is percent; rotation is degrees; blur is pixels; crop fields are percentages from 0 to 100.',
            properties: {
              positionX: { type: 'number' },
              positionY: { type: 'number' },
              scaleX: { type: 'number' },
              scaleY: { type: 'number' },
              scaleLinked: { type: 'boolean' },
              rotation: { type: 'number' },
              opacity: { type: 'number' },
              blur: { type: 'number', description: 'Blur amount in pixels, 0 to 50.' },
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
                property: { type: 'string', enum: ['opacity', 'positionX', 'positionY', 'scaleX', 'scaleY', 'rotation', 'blur', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight', 'textColor'] },
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
            description: 'Absolute transform values. positionX/positionY are pixels relative to center; scale is percent; rotation is degrees; blur is pixels; crop fields are percentages from 0 to 100.',
            properties: {
              positionX: { type: 'number' },
              positionY: { type: 'number' },
              scaleX: { type: 'number' },
              scaleY: { type: 'number' },
              scaleLinked: { type: 'boolean' },
              rotation: { type: 'number' },
              opacity: { type: 'number' },
              blur: { type: 'number', description: 'Blur amount in pixels, 0 to 50.' },
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
              rotation: { type: 'number' },
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
              { type: 'array', items: { type: 'string', enum: ['opacity', 'positionX', 'positionY', 'scaleX', 'scaleY', 'rotation', 'blur', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight', 'textColor'] } },
            ],
            description: 'Clear all or selected text transform/textColor keyframes before applying new ones.',
          },
          keyframes: {
            type: 'array',
            description: 'Explicit transform and textColor keyframes for text motion, crop reveals, and color changes. Easing supports linear/easeIn/easeOut/easeInOut/hold or cubicBezier(x1,y1,x2,y2).',
            items: {
              type: 'object',
              properties: {
                property: { type: 'string', enum: ['opacity', 'positionX', 'positionY', 'scaleX', 'scaleY', 'rotation', 'blur', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight', 'textColor'] },
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
  constructor({ port = DEFAULT_MCP_PORT, version = '0.1.0', performAction = null } = {}) {
    this.port = port
    this.version = version
    this.performAction = typeof performAction === 'function' ? performAction : null
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
            instructions: 'You are connected to ComfyStudio. Use get_ai_review_passes to choose safe review workflows. Use the tools to inspect the open project, timeline, assets, generation status, music-video workflow state, the composed timeline frame at the playhead, sampled visual timeline ranges, and top-visible shot pages for fast-cut edit review. The write actions currently exposed are clip label coloring, clip enable/disable, timeline marker creation/removal/property updates, text/title clip creation and updates, and starting timeline delivery exports through ComfyStudio export worker. Timeline clip/marker/text actions are undoable in ComfyStudio; export writes a new render file to disk.',
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
    if (!hasSnapshot(snapshot) && name !== 'get_project') {
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
      case 'check_export_readiness':
        return textResult(checkExportReadiness(snapshot, args))
      case 'inspect_clip':
        return this.inspectClip(snapshot, args)
      case 'inspect_timeline_frame':
        return this.inspectTimelineFrame(snapshot, args)
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
      case 'add_track':
        return this.addTrack(snapshot, args)
      case 'duplicate_clip':
        return this.duplicateClip(snapshot, args)
      case 'add_text_clip':
        return this.addTextClip(snapshot, args)
      case 'update_text_clip':
        return this.updateTextClip(snapshot, args)
      case 'export_timeline':
        return this.exportTimeline(snapshot, args)
      default:
        return errorResult(`Unknown tool: ${name}`)
    }
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
    const clipNeedsVideoTrack = ['video', 'image', 'text', 'adjustment', 'caption', 'captions'].includes(clip.type)
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
