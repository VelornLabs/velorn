import { buildMcpSnapshot } from './mcpSnapshot'
import { runMcpAction } from './mcpActions'

const MAX_RESULT_CHARS = 18000

const WRITE_TOOL_NAMES = new Set([
  'undo',
  'redo',
  'set_playhead',
  'select_clips',
  'select_assets',
  'create_project_checkpoint',
  'restore_project_checkpoint',
  'set_in_out_range',
  'set_clip_style',
  'set_clip_label_color',
  'set_clips_enabled',
  'inspect_timeline_frame',
  'inspect_timeline_range',
  'add_timeline_markers',
  'remove_timeline_markers',
  'set_timeline_marker_properties',
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
  'replace_clip_with_asset',
  'add_assets_to_timeline',
  'add_solid_color',
  'duplicate_clip',
  'add_text_clip',
  'update_text_clip',
  'add_shape_clip',
  'update_shape_clip',
  'add_adjustment_clip',
  'list_glsl_effects',
  'add_glsl_effect',
  'update_glsl_effect',
  'remove_glsl_effect',
  'set_clip_keyframes',
  'add_dip_to_black',
  'prepare_generation_from_timeline_context',
  'queue_prepared_generation',
  'queue_timeline_generation_batch',
  'queue_prompt_generation_batch',
  'export_timeline',
  'export_fcpxml',
])

export const AGENT_TOOLS = [
  {
    name: 'get_project',
    mode: 'read',
    description: 'Get the open Velorn project summary, settings, timeline counts, and asset counts.',
    arguments: '{}',
  },
  {
    name: 'get_timeline',
    mode: 'read',
    description: 'Get the active timeline. Use includeClips false for a compact overview or true for clip details.',
    arguments: '{ "includeClips": true, "limit": 200 }',
  },
  {
    name: 'get_assets',
    mode: 'read',
    description: 'List project assets and folders. Can filter by type, folderId, generationStatus, or text query.',
    arguments: '{ "type": "video", "limit": 100, "query": "" }',
  },
  {
    name: 'inspect_clip',
    mode: 'read',
    description: 'Inspect one timeline clip by clipId, including track, asset, transform, effects, text, shape, and keyframes.',
    arguments: '{ "clipId": "clip-1" }',
  },
  {
    name: 'find_timeline_items',
    mode: 'read',
    description: 'Find clips, tracks, markers, or assets by query/status. Useful before editing.',
    arguments: '{ "kind": "clips", "disabled": true, "hasTransform": true, "timeRange": { "start": 0, "end": 30 }, "query": "" }',
  },
  {
    name: 'analyze_timeline',
    mode: 'read',
    description: 'Return a readable health summary: clip counts, disabled clips, transforms, labels, markers, selected clips, and missing assets.',
    arguments: '{}',
  },
  {
    name: 'set_clip_label_color',
    mode: 'write',
    description: 'Set labelColor on one or more clips. Good for marking review items. Arguments: clipIds, color.',
    arguments: '{ "clipIds": ["clip-1"], "color": "#ffa500" }',
  },
  {
    name: 'set_clips_enabled',
    mode: 'write',
    description: 'Enable or disable clips. Use previewOnly true before bulk changes.',
    arguments: '{ "clipIds": ["clip-1"], "enabled": false, "previewOnly": true }',
  },
  {
    name: 'add_timeline_markers',
    mode: 'write',
    description: 'Add timeline markers. Use previewOnly true before applying many markers.',
    arguments: '{ "markers": [{ "time": 10, "name": "Review", "color": "#ffa500" }], "previewOnly": true }',
  },
  {
    name: 'remove_timeline_markers',
    mode: 'write',
    description: 'Remove timeline markers by ids, color, time range, or all. Use previewOnly true before clearing many markers.',
    arguments: '{ "all": true, "previewOnly": true }',
  },
  {
    name: 'inspect_timeline_frame',
    mode: 'write',
    description: 'Capture/inspect the composited timeline frame at a time or current playhead. Can return image data for vision-capable agents.',
    arguments: '{ "time": 12.5, "includeImage": true }',
  },
  {
    name: 'inspect_timeline_range',
    mode: 'write',
    description: 'Sample multiple composited frames over a timeline range.',
    arguments: '{ "start": 0, "end": 20, "sampleCount": 6, "includeImages": true }',
  },
  {
    name: 'add_track',
    mode: 'write',
    description: 'Add a timeline track. Use for extra text, graphics, adjustment, audio, or video layers.',
    arguments: '{ "type": "video", "name": "Titles", "position": "top", "previewOnly": true }',
  },
  {
    name: 'add_text_clip',
    mode: 'write',
    description: 'Add a text/title clip with transform, style, timing, and optional keyframes.',
    arguments: '{ "text": "Hello", "startSeconds": 0, "durationSeconds": 4, "previewOnly": true }',
  },
  {
    name: 'update_text_clip',
    mode: 'write',
    description: 'Update an existing text/title clip, including text, color, transform, blur, opacity, and keyframes.',
    arguments: '{ "clipId": "clip-1", "text": "New title", "previewOnly": true }',
  },
  {
    name: 'add_shape_clip',
    mode: 'write',
    description: 'Add simple graphics such as boxes, circles, lines, lower thirds, frames, or accents.',
    arguments: '{ "shapeType": "rectangle", "startSeconds": 0, "durationSeconds": 4, "previewOnly": true }',
  },
  {
    name: 'update_shape_clip',
    mode: 'write',
    description: 'Update an existing shape clip, including fill, stroke, transform, blur, opacity, and keyframes.',
    arguments: '{ "clipId": "clip-1", "fillColor": "#f5c451", "previewOnly": true }',
  },
  {
    name: 'set_clip_keyframes',
    mode: 'write',
    description: 'Set transform, opacity, blur, crop, text, shape, or effect keyframes on a visual clip. Preview first.',
    arguments: '{ "clipId": "clip-1", "keyframes": {}, "previewOnly": true }',
  },
  {
    name: 'export_timeline',
    mode: 'write',
    description: 'Start a timeline export through Velorn. Can render ranges and different aspect targets.',
    arguments: '{ "format": "mp4", "videoCodec": "h264", "start": 0, "end": 5, "previewOnly": true }',
  },
  {
    name: 'export_fcpxml',
    mode: 'write',
    description: 'Export the active timeline as FCPXML for Resolve, Final Cut, or Premiere interchange.',
    arguments: '{ "previewOnly": true }',
  },
]

function clampResult(value) {
  const text = JSON.stringify(value, null, 2)
  if (text.length <= MAX_RESULT_CHARS) return value
  return {
    truncated: true,
    originalLength: text.length,
    preview: text.slice(0, MAX_RESULT_CHARS),
  }
}

function normalizeString(value) {
  return String(value || '').trim()
}

function includesQuery(value, query) {
  if (!query) return true
  return String(value || '').toLowerCase().includes(query)
}

function secondsToTimecode(seconds, fps = 24) {
  const safeFps = Math.max(1, Number(fps) || 24)
  const totalFrames = Math.max(0, Math.round((Number(seconds) || 0) * safeFps))
  const frames = totalFrames % safeFps
  const totalSeconds = Math.floor(totalFrames / safeFps)
  const s = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const m = totalMinutes % 60
  const h = Math.floor(totalMinutes / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(frames).padStart(2, '0')}`
}

function getSnapshot() {
  return buildMcpSnapshot()
}

function summarizeProject(snapshot) {
  if (!snapshot.project) {
    return {
      app: snapshot.app,
      project: null,
      message: 'No project is currently open.',
    }
  }
  return {
    app: snapshot.app,
    project: snapshot.project,
    currentTimeline: snapshot.currentTimeline ? {
      id: snapshot.currentTimeline.id,
      name: snapshot.currentTimeline.name,
      duration: snapshot.currentTimeline.duration,
      timecodeDuration: secondsToTimecode(snapshot.currentTimeline.duration, snapshot.currentTimeline.fps),
      fps: snapshot.currentTimeline.fps,
      width: snapshot.currentTimeline.width,
      height: snapshot.currentTimeline.height,
      trackCount: snapshot.currentTimeline.trackCount,
      clipCount: snapshot.currentTimeline.clipCount,
      markerCount: snapshot.currentTimeline.markerCount,
      selectedClipCount: snapshot.currentTimeline.selectedClipCount,
    } : null,
    generatedAt: snapshot.generatedAt,
  }
}

function summarizeClip(clip, snapshot) {
  const track = snapshot.currentTimeline?.tracks?.find((item) => item.id === clip.trackId)
  const asset = snapshot.assets?.find((item) => item.id === clip.assetId)
  const fps = snapshot.currentTimeline?.fps || 24
  return {
    id: clip.id,
    name: clip.name,
    type: clip.type,
    trackId: clip.trackId,
    trackName: track?.name || '',
    assetId: clip.assetId,
    assetName: asset?.name || '',
    startTime: clip.startTime,
    endTime: (Number(clip.startTime) || 0) + (Number(clip.duration) || 0),
    duration: clip.duration,
    startTimecode: secondsToTimecode(clip.startTime, fps),
    endTimecode: secondsToTimecode((Number(clip.startTime) || 0) + (Number(clip.duration) || 0), fps),
    enabled: clip.enabled !== false,
    labelColor: clip.labelColor || '',
    lockMode: clip.lockMode || null,
    hasTransform: hasNonDefaultTransform(clip.transform),
    hasEffects: Array.isArray(clip.effects) ? clip.effects.length > 0 : Boolean(clip.effects && Object.keys(clip.effects).length),
    hasKeyframes: Boolean(clip.keyframes && Object.keys(clip.keyframes).length),
    text: clip.text || '',
  }
}

function hasNonDefaultTransform(transform = {}) {
  if (!transform || typeof transform !== 'object') return false
  const numericChecks = [
    ['x', 0],
    ['y', 0],
    ['rotation', 0],
    ['opacity', 100],
    ['blur', 0],
    ['scale', 100],
    ['scaleX', 100],
    ['scaleY', 100],
    ['cropLeft', 0],
    ['cropRight', 0],
    ['cropTop', 0],
    ['cropBottom', 0],
  ]
  return numericChecks.some(([key, defaultValue]) => {
    if (transform[key] === undefined || transform[key] === null) return false
    return Math.abs((Number(transform[key]) || 0) - defaultValue) > 0.001
  })
}

function handleGetTimeline(args = {}) {
  const snapshot = getSnapshot()
  const timeline = snapshot.currentTimeline
  if (!timeline) return { timeline: null, message: 'No active timeline.' }
  const includeClips = args.includeClips !== false
  const limit = Math.max(1, Math.min(1000, Number(args.limit) || 200))
  const allClips = timeline.clips || []
  const activeClipCount = allClips.filter((clip) => clip.enabled !== false).length
  const disabledClipCount = allClips.filter((clip) => clip.enabled === false).length
  const clips = includeClips
    ? allClips.slice(0, limit).map((clip) => summarizeClip(clip, snapshot))
    : undefined
  return clampResult({
    timeline: {
      ...timeline,
      activeClipCount,
      disabledClipCount,
      clips,
      clipLimitApplied: includeClips && allClips.length > limit ? limit : null,
    },
  })
}

function handleGetAssets(args = {}) {
  const snapshot = getSnapshot()
  const query = normalizeString(args.query).toLowerCase()
  const type = normalizeString(args.type).toLowerCase()
  const folderId = normalizeString(args.folderId)
  const generationStatus = normalizeString(args.generationStatus).toLowerCase()
  const limit = Math.max(1, Math.min(1000, Number(args.limit) || 200))

  const assets = (snapshot.assets || [])
    .filter((asset) => !type || String(asset.type || '').toLowerCase() === type)
    .filter((asset) => !folderId || asset.folderId === folderId)
    .filter((asset) => !generationStatus || String(asset.generationStatus || '').toLowerCase() === generationStatus)
    .filter((asset) => includesQuery(`${asset.name} ${asset.path} ${asset.prompt} ${asset.workflowName}`, query))
    .slice(0, limit)

  return clampResult({
    assets,
    folders: snapshot.folders || [],
    totalAssetCount: snapshot.assets?.length || 0,
    returnedAssetCount: assets.length,
  })
}

function handleInspectClip(args = {}) {
  const snapshot = getSnapshot()
  const clipId = normalizeString(args.clipId)
  const clip = snapshot.currentTimeline?.clips?.find((item) => item.id === clipId)
  if (!clip) throw new Error(`Clip not found: ${clipId || '(missing clipId)'}`)
  const track = snapshot.currentTimeline?.tracks?.find((item) => item.id === clip.trackId) || null
  const asset = snapshot.assets?.find((item) => item.id === clip.assetId) || null
  return clampResult({
    clip,
    summary: summarizeClip(clip, snapshot),
    track,
    asset,
  })
}

function handleFindTimelineItems(args = {}) {
  const snapshot = getSnapshot()
  const timeline = snapshot.currentTimeline
  if (!timeline) return { items: [], message: 'No active timeline.' }
  const kind = normalizeString(args.kind || 'clips').toLowerCase()
  const query = normalizeString(args.query).toLowerCase()
  const timeRange = args.timeRange || {}
  const start = Number(timeRange.start ?? args.start)
  const end = Number(timeRange.end ?? args.end)
  const hasStart = Number.isFinite(start)
  const hasEnd = Number.isFinite(end)
  const limit = Math.max(1, Math.min(1000, Number(args.limit) || 200))

  if (kind === 'tracks') {
    return {
      items: (timeline.tracks || [])
        .filter((track) => includesQuery(`${track.name} ${track.type} ${track.role || ''}`, query))
        .slice(0, limit),
    }
  }

  if (kind === 'markers') {
    return {
      items: (timeline.markers || [])
        .filter((marker) => includesQuery(`${marker.name} ${marker.color}`, query))
        .filter((marker) => !hasStart || marker.time >= start)
        .filter((marker) => !hasEnd || marker.time <= end)
        .slice(0, limit),
    }
  }

  if (kind === 'assets') {
    return handleGetAssets(args)
  }

  const disabled = args.disabled === true
  const enabled = args.enabled === true
  const hasTransform = args.hasTransform === true
  const hasEffects = args.hasEffects === true
  const hasKeyframes = args.hasKeyframes === true
  const labelColor = normalizeString(args.labelColor).toLowerCase()
  const type = normalizeString(args.type).toLowerCase()

  const items = (timeline.clips || [])
    .filter((clip) => !disabled || clip.enabled === false)
    .filter((clip) => !enabled || clip.enabled !== false)
    .filter((clip) => !hasTransform || hasNonDefaultTransform(clip.transform))
    .filter((clip) => !hasEffects || (Array.isArray(clip.effects) ? clip.effects.length > 0 : Boolean(clip.effects && Object.keys(clip.effects).length)))
    .filter((clip) => !hasKeyframes || Boolean(clip.keyframes && Object.keys(clip.keyframes).length))
    .filter((clip) => !labelColor || String(clip.labelColor || '').toLowerCase() === labelColor)
    .filter((clip) => !type || String(clip.type || '').toLowerCase() === type)
    .filter((clip) => {
      const clipStart = Number(clip.startTime) || 0
      const clipEnd = clipStart + (Number(clip.duration) || 0)
      if (hasStart && clipEnd < start) return false
      if (hasEnd && clipStart > end) return false
      return true
    })
    .filter((clip) => includesQuery(`${clip.id} ${clip.name} ${clip.text} ${clip.assetId}`, query))
    .slice(0, limit)
    .map((clip) => summarizeClip(clip, snapshot))

  return clampResult({ items, count: items.length, kind: 'clips' })
}

function handleAnalyzeTimeline() {
  const snapshot = getSnapshot()
  const timeline = snapshot.currentTimeline
  if (!snapshot.project || !timeline) {
    return {
      ready: false,
      summary: 'No open project or active timeline.',
      warnings: [],
      notes: [],
    }
  }

  const assetsById = new Set((snapshot.assets || []).map((asset) => asset.id))
  const clips = timeline.clips || []
  const disabledClips = clips.filter((clip) => clip.enabled === false)
  const activeClips = clips.filter((clip) => clip.enabled !== false)
  const transformedClips = clips.filter((clip) => hasNonDefaultTransform(clip.transform))
  const labeledClips = clips.filter((clip) => clip.labelColor)
  const effectClips = clips.filter((clip) => Array.isArray(clip.effects) ? clip.effects.length > 0 : Boolean(clip.effects && Object.keys(clip.effects).length))
  const keyframedClips = clips.filter((clip) => clip.keyframes && Object.keys(clip.keyframes).length)
  const missingAssetClips = clips.filter((clip) => clip.assetId && !assetsById.has(clip.assetId))
  const fps = timeline.fps || 24

  const warnings = []
  if (missingAssetClips.length) warnings.push(`${missingAssetClips.length} clip(s) reference missing assets.`)
  if (disabledClips.length) warnings.push(`${disabledClips.length} disabled clip(s) are still on the timeline.`)

  return clampResult({
    ready: missingAssetClips.length === 0,
    summary: `Timeline "${timeline.name}" has ${clips.length} total clips, ${activeClips.length} active/enabled clips, and ${disabledClips.length} disabled clips across ${timeline.trackCount} tracks. It runs ${secondsToTimecode(timeline.duration, fps)}.`,
    warnings,
    counts: {
      clips: clips.length,
      activeClips: activeClips.length,
      tracks: timeline.trackCount,
      transitions: timeline.transitionCount,
      markers: timeline.markerCount,
      selectedClips: timeline.selectedClipCount,
      disabledClips: disabledClips.length,
      transformedClips: transformedClips.length,
      labeledClips: labeledClips.length,
      clipsWithEffects: effectClips.length,
      clipsWithKeyframes: keyframedClips.length,
      missingAssetClips: missingAssetClips.length,
    },
    examples: {
      disabledClips: disabledClips.slice(0, 20).map((clip) => summarizeClip(clip, snapshot)),
      transformedClips: transformedClips.slice(0, 20).map((clip) => summarizeClip(clip, snapshot)),
      missingAssetClips: missingAssetClips.slice(0, 20).map((clip) => summarizeClip(clip, snapshot)),
    },
  })
}

export function getAgentToolInstructions() {
  const readableTools = AGENT_TOOLS.map((tool) => (
    `- ${tool.name} (${tool.mode}): ${tool.description} Example arguments: ${tool.arguments}`
  )).join('\n')

  return `You have access to Velorn editor tools. Use them by writing one or more fenced tool blocks exactly like this:

\`\`\`velorn-tool
{"tool":"get_project","arguments":{}}
\`\`\`

Available tools:
${readableTools}

Important behavior:
- Do not invent tool names. If you need something unsupported, say so.
- Do not narrate your reasoning or explain which tool you plan to use.
- When a tool is needed, output only the fenced velorn-tool block. Velorn will hide the block from the user and run it.
- Prefer read tools first when you need context.
- For clip counts, timeline health, disabled clips, transforms, labels, or markers, prefer analyze_timeline.
- For write/edit/export tools, use "previewOnly": true first unless the user clearly says to apply, run, do it, export it, delete it, or otherwise confirms the change.
- Keep actions scoped to the open Velorn project. You do not have shell, generic filesystem, browser, OS, or network tools through this Agent tab.
- After a tool result, answer in plain English. Keep it short unless the user asks for details. Do not show raw JSON.`
}

export async function runAgentTool(name, args = {}) {
  const toolName = normalizeString(name)
  if (!toolName) throw new Error('Missing tool name.')

  switch (toolName) {
    case 'get_project':
      return summarizeProject(getSnapshot())
    case 'get_timeline':
      return handleGetTimeline(args)
    case 'get_assets':
      return handleGetAssets(args)
    case 'inspect_clip':
      return handleInspectClip(args)
    case 'find_timeline_items':
      return handleFindTimelineItems(args)
    case 'analyze_timeline':
      return handleAnalyzeTimeline(args)
    default:
      if (WRITE_TOOL_NAMES.has(toolName)) {
        return clampResult(await runMcpAction(toolName, args || {}))
      }
      throw new Error(`Unknown Agent tool: ${toolName}`)
  }
}
