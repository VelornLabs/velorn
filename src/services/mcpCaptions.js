import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import { transcribeTimeline, transcribeWithComfyUI } from './captionComfyTranscription'
import { buildCaptionAssetName, ensureCaptionsFolder } from './captionProject'
import { isElectron, writeGeneratedOverlayToProject } from './fileSystem'
import { generateCaptionVideoBlob } from '../utils/captionRenderer'
import { buildKineticStyleWithColors } from '../utils/kineticCaptionRenderer'
import { CAPTION_PRESETS, DEFAULT_CAPTION_PRESET_ID } from '../config/captionPresets'

// MCP-driven caption flow. Transcription and overlay rendering both outlive the
// 60s MCP action bridge timeout, so they run here as background jobs that MCP
// polls via get_caption_status. The cue draft lives in module state between
// calls (like the dialog's session cache, but independent of it) and is lost on
// app reload.

const VALID_VERTICAL_PLACEMENTS = new Set(['auto', 'top', 'middle', 'bottom'])
const VALID_HORIZONTAL_PLACEMENTS = new Set(['auto', 'left', 'center', 'right'])
const VALID_MOTION_PROFILES = new Set(['auto', 'tamed', 'excited', 'frenetic'])
const VALID_TEXT_STYLES = new Set(['background', 'outline', 'shadow', 'plain'])
const VALID_SUBTITLE_POSITIONS = new Set(['action-safe', 'title-safe', 'center'])
const CAPTION_JOB_HISTORY_LIMIT = 10

const captionJobs = new Map()
let lastCaptionJobId = null
let captionJobCounter = 0
let captionDraft = null

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, numeric))
}

function getCueEnd(cue, fallbackDuration) {
  const start = Number(cue?.start) || 0
  const rawEnd = Number(cue?.end)
  const fallback = Math.max(start + 0.4, Number(fallbackDuration) || start + 1.5)
  return Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : fallback
}

function normalizeCueOverride(override = {}) {
  const safeOverride = override && typeof override === 'object' ? override : {}
  return {
    verticalPlacement: VALID_VERTICAL_PLACEMENTS.has(safeOverride.verticalPlacement)
      ? safeOverride.verticalPlacement
      : 'auto',
    horizontalPlacement: VALID_HORIZONTAL_PLACEMENTS.has(safeOverride.horizontalPlacement)
      ? safeOverride.horizontalPlacement
      : 'auto',
    motionProfile: VALID_MOTION_PROFILES.has(safeOverride.motionProfile)
      ? safeOverride.motionProfile
      : 'auto',
  }
}

function normalizeCueOrder(cues = [], fallbackDuration = 0) {
  return [...cues]
    .map((cue, index) => {
      const start = Math.max(0, Number(cue?.start) || 0)
      const end = getCueEnd(cue, fallbackDuration)
      return {
        ...cue,
        id: cue?.id || `cue-${index + 1}`,
        start,
        end,
        text: String(cue?.text || ''),
        override: normalizeCueOverride(cue?.override),
      }
    })
    .sort((a, b) => a.start - b.start)
}

function cuesToTranscript(cues = []) {
  return cues
    .map((cue) => String(cue?.text || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function resolveRenderSettings() {
  const projectState = useProjectStore.getState?.()
  const settings = projectState?.getCurrentTimelineSettings?.()
    || projectState?.currentProject?.settings
    || {}
  return {
    width: Math.max(16, Math.min(7680, Number(settings.width) || 1920)),
    height: Math.max(16, Math.min(4320, Number(settings.height) || 1080)),
    fps: Math.max(6, Math.min(60, Number(settings.fps) || 24)),
  }
}

function getRunningCaptionJob() {
  for (const job of captionJobs.values()) {
    if (job.status === 'running') return job
  }
  return null
}

function createCaptionJob(kind, detail = {}) {
  captionJobCounter += 1
  const job = {
    id: `caption-job-${captionJobCounter}-${Date.now().toString(36)}`,
    kind,
    status: 'running',
    stage: 'start',
    progress: 0,
    message: `Caption ${kind} job started.`,
    detail,
    error: '',
    result: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  }
  captionJobs.set(job.id, job)
  lastCaptionJobId = job.id
  while (captionJobs.size > CAPTION_JOB_HISTORY_LIMIT) {
    const oldestId = captionJobs.keys().next().value
    if (oldestId === job.id) break
    captionJobs.delete(oldestId)
  }
  return job
}

function finishCaptionJob(job, result) {
  job.status = 'done'
  job.progress = 100
  job.result = result
  job.finishedAt = new Date().toISOString()
  job.message = `Caption ${job.kind} job finished.`
}

function failCaptionJob(job, error) {
  job.status = 'error'
  job.error = error?.message || String(error)
  job.finishedAt = new Date().toISOString()
  job.message = `Caption ${job.kind} job failed.`
}

function summarizeCaptionJob(job) {
  if (!job) return null
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    detail: job.detail,
    error: job.error || '',
    result: job.result,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  }
}

function summarizeCaptionDraft(includeCues = true) {
  if (!captionDraft) return null
  return {
    scope: captionDraft.scope,
    language: captionDraft.language || 'Auto',
    sourceAssetId: captionDraft.sourceAssetId || null,
    sourceAssetName: captionDraft.sourceAssetName || null,
    modelId: captionDraft.modelId || '',
    cueCount: captionDraft.cues.length,
    audioDuration: captionDraft.audioDuration,
    transcriptText: captionDraft.transcriptText,
    createdAt: captionDraft.createdAt,
    updatedAt: captionDraft.updatedAt,
    ...(includeCues ? { cues: captionDraft.cues } : {}),
  }
}

async function runTranscribeCaptionJob(job, { scope, language, sourceAsset }) {
  // transcribeTimeline reports (message, percent) from the audio mix and
  // { stage, message, progress } from the ASR leg — accept both shapes.
  const onProgress = (update, maybeProgress) => {
    if (typeof update === 'string') {
      job.message = update
      if (Number.isFinite(Number(maybeProgress))) job.progress = Math.round(Number(maybeProgress))
    } else if (update && typeof update === 'object') {
      if (update.stage) job.stage = String(update.stage)
      if (update.message) job.message = String(update.message)
      if (Number.isFinite(Number(update.progress))) job.progress = Math.round(Number(update.progress))
    }
  }

  try {
    const result = scope === 'asset'
      ? await transcribeWithComfyUI(sourceAsset, { onProgress, language })
      : await transcribeTimeline({ onProgress })

    const audioDuration = Number(result?.audioDuration) || 0
    const cues = normalizeCueOrder(result?.cues || [], audioDuration)
    if (!cues.length) {
      throw new Error('Transcription returned no cues. The audio may be silent or contain no recognizable speech.')
    }

    const timestamp = new Date().toISOString()
    captionDraft = {
      scope,
      language,
      sourceAssetId: sourceAsset?.id || null,
      sourceAssetName: sourceAsset?.name || null,
      modelId: result?.modelId || '',
      transcriptText: result?.transcriptText || cuesToTranscript(cues),
      words: Array.isArray(result?.words) ? result.words : [],
      cues,
      audioDuration: audioDuration || Math.max(...cues.map((cue) => cue.end), 0),
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    finishCaptionJob(job, {
      cueCount: cues.length,
      audioDuration: captionDraft.audioDuration,
      transcriptText: captionDraft.transcriptText,
      modelId: captionDraft.modelId,
    })
  } catch (error) {
    failCaptionJob(job, error)
  }
}

export function handleTranscribeCaptions(payload = {}) {
  const scope = payload.scope === 'asset' ? 'asset' : 'timeline'
  const language = String(payload.language || 'Auto').trim() || 'Auto'

  let sourceAsset = null
  if (scope === 'asset') {
    const assetId = String(payload.assetId || '').trim()
    if (!assetId) throw new Error('assetId is required when scope is "asset".')
    sourceAsset = useAssetsStore.getState().getAssetById?.(assetId)
    if (!sourceAsset) throw new Error(`No asset found with id "${assetId}".`)
    if (sourceAsset.hasAudio === false) {
      throw new Error(`Asset "${sourceAsset.name}" has no audio to transcribe.`)
    }
  }

  const running = getRunningCaptionJob()
  const plan = {
    scope,
    language,
    ...(sourceAsset
      ? { asset: { id: sourceAsset.id, name: sourceAsset.name, duration: sourceAsset.duration || null } }
      : { note: 'Timeline scope mixes the program audio (mute/enabled respected) before transcribing.' }),
    workflow: 'ComfyUI Qwen3-ASR (local)',
    pollWith: 'get_caption_status',
  }

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'transcribe_captions',
      message: 'Transcription plan only. No job was started.',
      plan,
      ...(running ? { warning: `Caption job ${running.id} is still running and must finish first.` } : {}),
    }
  }

  if (running) {
    throw new Error(`Caption job ${running.id} (${running.kind}) is still running. Poll get_caption_status until it finishes.`)
  }

  const job = createCaptionJob('transcribe', { scope, language, assetId: sourceAsset?.id || null })
  runTranscribeCaptionJob(job, { scope, language, sourceAsset })

  return {
    success: true,
    action: 'transcribe_captions',
    message: `Transcription job ${job.id} started (${scope} scope). Poll get_caption_status for progress and the finished cue draft.`,
    jobId: job.id,
    scope,
  }
}

export function handleGetCaptionStatus(payload = {}) {
  const jobId = String(payload.jobId || '').trim()
  const job = jobId
    ? captionJobs.get(jobId)
    : (lastCaptionJobId ? captionJobs.get(lastCaptionJobId) : null)
  if (jobId && !job) throw new Error(`No caption job found with id "${jobId}".`)

  return {
    action: 'get_caption_status',
    job: summarizeCaptionJob(job),
    draft: summarizeCaptionDraft(payload.includeCues !== false),
    ...(job ? {} : { message: 'No caption job has run in this app session yet.' }),
  }
}

export function handleUpdateCaptionCues(payload = {}) {
  const replacingAll = Array.isArray(payload.cues)
  if (!captionDraft && !replacingAll) {
    throw new Error('No caption draft exists yet. Run transcribe_captions first, or pass a full "cues" array to create a draft manually.')
  }

  const fallbackDuration = Number(captionDraft?.audioDuration) || 0
  let nextCues
  if (replacingAll) {
    nextCues = normalizeCueOrder(payload.cues, fallbackDuration)
  } else {
    nextCues = captionDraft.cues.map((cue) => ({ ...cue }))
    const edits = Array.isArray(payload.edits) ? payload.edits : []
    for (const edit of edits) {
      const id = String(edit?.id || '').trim()
      const target = nextCues.find((cue) => cue.id === id)
      if (!target) throw new Error(`No cue found with id "${id}".`)
      if (typeof edit.text === 'string') target.text = edit.text
      const start = edit.startSeconds ?? edit.start
      const end = edit.endSeconds ?? edit.end
      if (Number.isFinite(Number(start))) target.start = Math.max(0, Number(start))
      if (Number.isFinite(Number(end))) target.end = Number(end)
    }
    const removeIds = new Set((Array.isArray(payload.removeIds) ? payload.removeIds : []).map((id) => String(id)))
    if (removeIds.size) nextCues = nextCues.filter((cue) => !removeIds.has(cue.id))
    nextCues = normalizeCueOrder(nextCues, fallbackDuration)
  }

  if (!nextCues.length) {
    throw new Error('The update would leave zero cues. Keep at least one cue, or re-run transcribe_captions.')
  }

  if (payload.previewOnly === true) {
    return {
      previewOnly: true,
      action: 'update_caption_cues',
      message: 'Cue update plan only. The draft was not changed.',
      cueCount: nextCues.length,
      cues: nextCues,
    }
  }

  const timestamp = new Date().toISOString()
  const maxCueEnd = Math.max(...nextCues.map((cue) => cue.end), 0)
  if (!captionDraft) {
    captionDraft = {
      scope: 'timeline',
      language: 'Auto',
      sourceAssetId: null,
      sourceAssetName: null,
      modelId: '',
      words: [],
      createdAt: timestamp,
    }
  }
  captionDraft = {
    ...captionDraft,
    cues: nextCues,
    transcriptText: cuesToTranscript(nextCues),
    audioDuration: Math.max(fallbackDuration, maxCueEnd),
    updatedAt: timestamp,
  }

  return {
    success: true,
    action: 'update_caption_cues',
    message: `Caption draft updated (${nextCues.length} cue${nextCues.length === 1 ? '' : 's'}).`,
    cueCount: nextCues.length,
    cues: nextCues,
  }
}

function placeCaptionOverlayOnTimeline(captionAsset, ctx) {
  const timelineState = useTimelineStore.getState()
  const assetsState = useAssetsStore.getState()

  // Mirrors Timeline.jsx handlePlaceTimelineCaptionOnTimeline: timeline-scope
  // regenerations replace the prior overlay (clip + asset) instead of stacking.
  if (ctx.scope === 'timeline') {
    const priorClips = (timelineState.clips || []).filter((clip) => {
      if (!clip?.assetId) return false
      const asset = assetsState.getAssetById?.(clip.assetId)
      return asset?.settings?.captionScope === 'timeline' && asset.id !== captionAsset.id
    })
    const priorAssetIds = new Set(priorClips.map((clip) => clip.assetId))
    priorClips.forEach((clip) => useTimelineStore.getState().removeClip?.(clip.id))
    priorAssetIds.forEach((id) => {
      try { assetsState.removeAsset?.(id) } catch (_) { /* best-effort cleanup */ }
    })
  }

  let track = (useTimelineStore.getState().tracks || []).find((t) => t.role === 'captions')
  if (!track) {
    track = useTimelineStore.getState().addTrack?.('video', { role: 'captions', name: 'Captions' })
  }
  if (!track) throw new Error('Could not find or create the Captions track.')

  if (ctx.scope === 'timeline') {
    useTimelineStore.getState().clips
      .filter((clip) => clip.trackId === track.id)
      .forEach((clip) => useTimelineStore.getState().removeClip?.(clip.id))
  }

  // Asset-scope cues are timed in source-asset time, so align the overlay with
  // the first timeline clip that uses the source asset when there is one.
  let startSeconds = 0
  if (ctx.scope === 'asset' && ctx.sourceAssetId) {
    const sourceClip = (useTimelineStore.getState().clips || [])
      .filter((clip) => clip.assetId === ctx.sourceAssetId)
      .sort((a, b) => (Number(a.startTime) || 0) - (Number(b.startTime) || 0))[0]
    if (sourceClip) startSeconds = Number(sourceClip.startTime) || 0
  }

  const fps = Number(useTimelineStore.getState().timelineFps) || ctx.fps || 24
  const clip = useTimelineStore.getState().addClip?.(track.id, captionAsset, startSeconds, fps, {
    duration: ctx.duration,
    trimStart: 0,
    trimEnd: ctx.duration,
    metadata: { captionScope: ctx.scope, addedByMcp: true },
  })
  if (!clip) throw new Error('Could not place the caption overlay on the timeline.')
  return { clip, track }
}

async function runGenerateCaptionJob(job, ctx) {
  try {
    job.stage = 'render'
    job.message = `Rendering caption overlay (~${Math.ceil(ctx.duration)}s realtime)...`

    const preset = ctx.preset
    const traditional = preset.traditional === true
    const renderPreset = preset.renderer === 'kinetic' && !traditional
      ? buildKineticStyleWithColors(preset, ctx.accentColor, ctx.textColor)
      : preset
    const effectiveTextColor = ctx.textColor
      || (traditional ? (preset.subtitleColor || preset.textColor) : preset.textColor)
      || '#FFFFFF'

    const globalOverrides = {
      fontFamily: ctx.fontFamily || preset.fontFamily || 'Inter',
      backgroundColor: '#000000',
      backgroundOpacity: 65,
      backgroundPadding: traditional ? 60 : 45,
      backgroundRadius: traditional ? 30 : 25,
      outlineColor: '#000000',
      outlineThickness: 9,
      shadowColor: '#000000',
      shadowOpacity: 75,
      shadowBlur: traditional ? 25 : 18,
      shadowDistance: 5,
      verticalPlacement: ctx.verticalPlacement,
      horizontalPlacement: ctx.horizontalPlacement,
      motionProfile: ctx.motionProfile,
      sizeScale: ctx.sizeScale,
      verticalOffset: ctx.verticalOffset,
      textStyle: ctx.textStyle || preset.defaultTextStyle || (traditional ? 'background' : 'plain'),
      subtitleColor: effectiveTextColor,
      subtitlePosition: ctx.subtitlePosition || preset.subtitlePosition || 'action-safe',
    }
    const renderCues = ctx.cues.map((cue) => ({ ...cue, globalOverrides }))

    const overlayBlob = await generateCaptionVideoBlob({
      preset: renderPreset,
      cues: renderCues,
      width: ctx.width,
      height: ctx.height,
      duration: ctx.duration,
      fps: ctx.fps,
    })

    job.stage = 'save'
    job.message = 'Saving caption overlay asset...'
    const assetsState = useAssetsStore.getState()
    const folderId = ensureCaptionsFolder(assetsState.folders || [], assetsState.addFolder)
    const sourceForName = ctx.scope === 'asset' && ctx.sourceAssetId
      ? (assetsState.getAssetById?.(ctx.sourceAssetId) || { name: 'source_video' })
      : { name: 'timeline' }
    const assetName = buildCaptionAssetName(sourceForName, preset)
    const captionSettings = {
      width: ctx.width,
      height: ctx.height,
      duration: ctx.duration,
      fps: ctx.fps,
      hasAlpha: true,
      source: 'captions',
      overlayKind: 'captions',
      captionScope: ctx.scope,
      ...(ctx.scope === 'asset' && ctx.sourceAssetId ? { sourceAssetId: ctx.sourceAssetId } : {}),
      captionPresetId: preset.id,
      captionCueCount: ctx.cues.length,
      captionModelId: ctx.modelId || '',
      generatedBy: 'mcp',
    }

    const projectHandle = useProjectStore.getState().currentProjectHandle
    let createdAsset
    if (isElectron() && typeof projectHandle === 'string' && projectHandle) {
      const persisted = await writeGeneratedOverlayToProject(
        projectHandle,
        overlayBlob,
        assetName,
        'video',
        captionSettings
      )
      createdAsset = assetsState.addAsset?.({
        ...persisted,
        folderId,
        settings: { ...(persisted.settings || {}), ...captionSettings },
      })
    } else {
      createdAsset = assetsState.addAsset?.({
        name: assetName,
        type: 'video',
        url: URL.createObjectURL(overlayBlob),
        folderId,
        mimeType: overlayBlob.type || 'video/webm',
        size: overlayBlob.size,
        isImported: false,
        hasAudio: false,
        audioEnabled: false,
        duration: ctx.duration,
        settings: captionSettings,
      })
    }
    if (!createdAsset) throw new Error('Could not add the caption overlay to the project assets.')

    let placed = null
    if (ctx.placeOnTimeline) {
      job.stage = 'place'
      job.message = 'Placing caption overlay on the Captions track...'
      placed = placeCaptionOverlayOnTimeline(createdAsset, ctx)
    }

    finishCaptionJob(job, {
      assetId: createdAsset.id,
      assetName: createdAsset.name || assetName,
      clipId: placed?.clip?.id || null,
      trackId: placed?.track?.id || null,
      placedOnTimeline: Boolean(placed?.clip),
      durationSeconds: ctx.duration,
      cueCount: ctx.cues.length,
      presetId: preset.id,
    })
  } catch (error) {
    failCaptionJob(job, error)
  }
}

export function handleGenerateCaptions(payload = {}) {
  const inlineCues = Array.isArray(payload.cues) && payload.cues.length
    ? normalizeCueOrder(payload.cues, 0)
    : null
  const cues = inlineCues || (captionDraft?.cues?.length ? captionDraft.cues.map((cue) => ({ ...cue })) : null)
  if (!cues || !cues.length) {
    throw new Error('No caption cues available. Run transcribe_captions first (optionally update_caption_cues), or pass "cues" inline.')
  }

  const presetId = String(payload.presetId || DEFAULT_CAPTION_PRESET_ID)
  const preset = CAPTION_PRESETS.find((candidate) => candidate.id === presetId)
  if (!preset) {
    throw new Error(`Unknown caption preset "${presetId}". Valid presets: ${CAPTION_PRESETS.map((p) => p.id).join(', ')}.`)
  }

  const validateEnum = (value, validSet, label) => {
    if (value == null || value === '') return null
    const normalized = String(value)
    if (!validSet.has(normalized)) {
      throw new Error(`Invalid ${label} "${normalized}". Valid values: ${[...validSet].join(', ')}.`)
    }
    return normalized
  }
  const textStyle = validateEnum(payload.textStyle, VALID_TEXT_STYLES, 'textStyle')
  const verticalPlacement = validateEnum(payload.verticalPlacement, VALID_VERTICAL_PLACEMENTS, 'verticalPlacement') || 'auto'
  const horizontalPlacement = validateEnum(payload.horizontalPlacement, VALID_HORIZONTAL_PLACEMENTS, 'horizontalPlacement') || 'auto'
  const motionProfile = validateEnum(payload.motionProfile, VALID_MOTION_PROFILES, 'motionProfile') || 'auto'
  const subtitlePosition = validateEnum(payload.subtitlePosition, VALID_SUBTITLE_POSITIONS, 'subtitlePosition')

  const settings = resolveRenderSettings()
  const maxCueEnd = Math.max(...cues.map((cue) => Number(cue.end) || 0), 0)
  const duration = Math.max(1, Math.max(maxCueEnd, Number(captionDraft?.audioDuration) || 0))
  const scope = captionDraft?.scope === 'asset' && !inlineCues ? 'asset' : 'timeline'

  const ctx = {
    cues,
    preset,
    scope,
    sourceAssetId: scope === 'asset' ? captionDraft?.sourceAssetId || null : null,
    modelId: captionDraft?.modelId || '',
    accentColor: typeof payload.accentColor === 'string' && payload.accentColor.trim() ? payload.accentColor.trim() : null,
    textColor: typeof payload.textColor === 'string' && payload.textColor.trim() ? payload.textColor.trim() : null,
    fontFamily: typeof payload.fontFamily === 'string' && payload.fontFamily.trim() ? payload.fontFamily.trim() : null,
    textStyle,
    verticalPlacement,
    horizontalPlacement,
    motionProfile,
    subtitlePosition,
    sizeScale: clampNumber(payload.sizeScale, 0.3, 2, 1),
    verticalOffset: clampNumber(payload.verticalOffset, -0.45, 0.45, 0),
    width: settings.width,
    height: settings.height,
    fps: settings.fps,
    duration,
    placeOnTimeline: payload.placeOnTimeline !== false,
  }

  const running = getRunningCaptionJob()
  const plan = {
    presetId: preset.id,
    presetName: preset.name,
    scope,
    cueCount: cues.length,
    durationSeconds: Math.round(duration * 100) / 100,
    width: ctx.width,
    height: ctx.height,
    fps: ctx.fps,
    placeOnTimeline: ctx.placeOnTimeline,
    estimatedRenderSeconds: Math.ceil(duration),
    ...(scope === 'timeline' ? { note: 'Replaces any prior timeline-scope caption overlay on the Captions track.' } : {}),
    pollWith: 'get_caption_status',
  }

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'generate_captions',
      message: 'Caption render plan only. No job was started.',
      plan,
      ...(running ? { warning: `Caption job ${running.id} is still running and must finish first.` } : {}),
    }
  }

  if (running) {
    throw new Error(`Caption job ${running.id} (${running.kind}) is still running. Poll get_caption_status until it finishes.`)
  }

  const job = createCaptionJob('generate', { presetId: preset.id, cueCount: cues.length, scope })
  runGenerateCaptionJob(job, ctx)

  return {
    success: true,
    action: 'generate_captions',
    message: `Caption render job ${job.id} started. The overlay renders in real time (~${Math.ceil(duration)}s); poll get_caption_status.`,
    jobId: job.id,
    plan,
  }
}
