import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import { transcribeAsset, transcribeTimelineAudio, getLocalCaptionEngineStatus } from './captionTranscription'
import { buildCaptionAssetName, ensureCaptionsFolder, saveCaptionSidecar } from './captionProject'
import { isElectron, writeGeneratedOverlayToProject } from './fileSystem'
import { generateCaptionVideoBlob } from '../utils/captionRenderer'
import { buildKineticStyleWithColors } from '../utils/kineticCaptionRenderer'
import { CAPTION_PRESETS, DEFAULT_CAPTION_PRESET_ID } from '../config/captionPresets'
import { addCaptionCue, splitCaptionCueAtCaret, retimeCaptionCue } from '../utils/captionCueEditing'
import { captureMcpContext, assertMcpContext } from './mcpContext'

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
let captionDraftRevision = 0

function ownsCaptionContext(context) {
  if (!context) return false
  const current = captureMcpContext()
  return ['session', 'projectKey', 'timelineId', 'timelineSessionId', 'compoundClipId']
    .every(key => context[key] === current[key])
}

function assertCaptionDraft(payload = {}) {
  if (captionDraft && !ownsCaptionContext(captionDraft.owner)) throw new Error('The agent caption draft belongs to another timeline. Reopen that timeline or explicitly replace the draft here.')
  if (payload.expectedDraftRevision !== undefined && payload.expectedDraftRevision !== captionDraftRevision) {
    throw new Error('The caption draft changed after inspection. Read it again before editing or generating.')
  }
}

function assertCaptionJobCurrent(job) {
  assertMcpContext(job.context, 'caption job')
  if (job.draftRevision !== captionDraftRevision) throw new Error('The agent caption draft changed while this job ran. Its result was not applied.')
}

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
    context: captureMcpContext(),
    draftRevision: captionDraftRevision,
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
    context: job.context,
    belongsToCurrentTimeline: ownsCaptionContext(job.context),
  }
}

function summarizeCaptionDraft(includeCues = true) {
  if (!captionDraft) return null
  return {
    scope: captionDraft.scope,
    source: 'agent-session',
    draftRevision: captionDraftRevision,
    owner: captionDraft.owner,
    belongsToCurrentTimeline: ownsCaptionContext(captionDraft.owner),
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

async function runTranscribeCaptionJob(job, { scope, language, sourceAsset, vocabularyHint, modelId }) {
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
    // vocabularyHint: undefined lets the seam auto-derive from the project;
    // an explicit string (including '') from the MCP caller wins.
    const hintOption = vocabularyHint !== undefined ? { vocabularyHint } : {}
    if (modelId) {
      const status = await getLocalCaptionEngineStatus()
      assertCaptionJobCurrent(job)
      if (!status?.binaryPath || !status.models?.some(model => model.id === modelId)) {
        throw new Error('The requested local caption model is not installed. Use get_caption_engine_status and install_caption_engine, then retry after setup completes.')
      }
      Object.assign(hintOption, { modelId, strictModel: true, engine: 'local' })
    }
    const result = scope === 'asset'
      ? await transcribeAsset(sourceAsset, { onProgress, language, ...hintOption })
      : await transcribeTimelineAudio({ onProgress, ...hintOption })
    assertCaptionJobCurrent(job)

    const audioDuration = Number(result?.audioDuration) || 0
    const cues = normalizeCueOrder(result?.cues || [], audioDuration)
    if (!cues.length) {
      throw new Error('Transcription returned no cues. The audio may be silent or contain no recognizable speech.')
    }

    const timestamp = new Date().toISOString()
    captionDraft = {
      owner: job.context,
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
    captionDraftRevision += 1

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
  assertMcpContext(payload.expectedContext, 'caption transcription')
  if (payload.expectedDraftRevision !== undefined && payload.expectedDraftRevision !== captionDraftRevision) throw new Error('The caption draft changed after preview. Preview transcription again before replacing it.')
  const scope = payload.scope === 'asset' ? 'asset' : 'timeline'
  const language = String(payload.language || 'Auto').trim() || 'Auto'
  const modelId = payload.modelId
  if (modelId !== undefined && !['tiny', 'base', 'small', 'large-v3-turbo'].includes(modelId)) throw new Error('Unknown local caption modelId.')

  // Optional caption vocabulary (brand names, people, jargon). String or
  // array; when omitted the engine auto-derives hints from the project.
  const rawVocabulary = payload.vocabulary ?? payload.vocabularyHint
  const vocabularyHint = rawVocabulary === undefined
    ? undefined
    : Array.isArray(rawVocabulary)
      ? rawVocabulary.map((item) => String(item || '').trim()).filter(Boolean).join(', ')
      : String(rawVocabulary || '').trim()

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
    ...(vocabularyHint !== undefined ? { vocabularyHint } : { vocabularyHint: 'auto (derived from project name, timeline names, text clips)' }),
    ...(sourceAsset
      ? { asset: { id: sourceAsset.id, name: sourceAsset.name, duration: sourceAsset.duration || null } }
      : { note: 'Timeline scope mixes the program audio (mute/enabled respected) before transcribing.' }),
    engine: 'Local whisper engine (ComfyUI Qwen3-ASR only as configured fallback)',
    pollWith: 'get_caption_status',
    ...(modelId ? { modelId, engine: 'Local whisper engine (explicit model)' } : {}),
  }

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'transcribe_captions',
      message: 'Transcription plan only. No job was started.',
      plan,
      suggestedApplyPayload: { ...payload, previewOnly: false, expectedContext: captureMcpContext(), expectedDraftRevision: captionDraftRevision },
      ...(running ? { warning: `Caption job ${running.id} is still running and must finish first.` } : {}),
    }
  }

  if (running) {
    throw new Error(`Caption job ${running.id} (${running.kind}) is still running. Poll get_caption_status until it finishes.`)
  }

  const job = createCaptionJob('transcribe', { scope, language, assetId: sourceAsset?.id || null })
  runTranscribeCaptionJob(job, { scope, language, sourceAsset, vocabularyHint, modelId })

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

  const liveClips = (useTimelineStore.getState().clips || []).filter(clip => clip.type === 'captions'
    && (!payload.clipId || clip.id === payload.clipId))
  if (payload.clipId && !liveClips.length) throw new Error(`No live captions clip found with id "${payload.clipId}".`)
  return {
    action: 'get_caption_status',
    job: summarizeCaptionJob(job),
    draft: summarizeCaptionDraft(payload.includeCues !== false),
    draftSource: 'agent-session',
    draftRevision: captionDraftRevision,
    note: 'The agent-session draft is separate from an open Caption workspace draft. Live clips are shared project state.',
    liveClips: liveClips.map(clip => ({ clipId: clip.id, startTime: clip.startTime, duration: clip.duration,
      cueCount: clip.captions?.cues?.length || 0,
      ...(payload.includeCues !== false ? { cues: clip.captions?.cues || [] } : {}) })),
    context: captureMcpContext(),
    ...(job ? {} : { message: 'No caption job has run in this app session yet.' }),
  }
}

// Apply the tool's edit vocabulary (full replace / per-cue edits / removals)
// to a plain cue list. Shared by the draft target and the live-clip target.
function applyCueEditsToList(baseCues, payload, fallbackDuration) {
  let nextCues
  if (Array.isArray(payload.cues)) {
    nextCues = normalizeCueOrder(payload.cues, fallbackDuration)
  } else {
    nextCues = baseCues.map((cue) => ({ ...cue }))
  }
  const ids = new Set()
  for (const cue of nextCues) {
    if (ids.has(cue.id)) throw new Error(`Duplicate caption cue ID "${cue.id}".`)
    ids.add(cue.id)
  }
  for (const edit of Array.isArray(payload.edits) ? payload.edits : []) {
    const id = String(edit?.id || '').trim()
    const target = nextCues.find(cue => cue.id === id)
    if (!target) throw new Error(`No cue found with id "${id}".`)
    if (typeof edit.text === 'string') target.text = edit.text
    const start = edit.startSeconds ?? edit.start
    const end = edit.endSeconds ?? edit.end
    if (end !== undefined && edit.durationSeconds !== undefined) throw new Error('Provide endSeconds or durationSeconds, not both.')
    if (start !== undefined || end !== undefined || edit.durationSeconds !== undefined) {
      const duration = end !== undefined ? Number(end) - Number(start ?? target.start) : edit.durationSeconds
      nextCues = retimeCaptionCue(nextCues, id, { start, duration, maxEnd: fallbackDuration || null }).cues
    }
  }
  const removeIds = new Set((Array.isArray(payload.removeIds) ? payload.removeIds : []).map(String))
  if (removeIds.size) nextCues = nextCues.filter(cue => !removeIds.has(cue.id))
  for (const add of Array.isArray(payload.add) ? payload.add : []) {
    if (add.id && nextCues.some(cue => cue.id === add.id)) throw new Error(`Duplicate caption cue ID "${add.id}".`)
    const result = addCaptionCue(nextCues, { atTime: add.atTimeSeconds, audioDuration: fallbackDuration || null,
      defaultDuration: add.durationSeconds, ...(add.id ? { idFactory: () => add.id } : {}) })
    nextCues = result.cues
    result.cue.text = String(add.text || '')
  }
  for (const split of Array.isArray(payload.split) ? payload.split : []) {
    if (split.rightId && nextCues.some(cue => cue.id === split.rightId)) throw new Error(`Duplicate caption cue ID "${split.rightId}".`)
    nextCues = splitCaptionCueAtCaret(nextCues, split.id, split.caretOffset,
      split.rightId ? { idFactory: () => split.rightId } : {}).cues
  }
  return normalizeCueOrder(nextCues, fallbackDuration)
}

function findLiveCaptionsClip(clipId) {
  const clips = useTimelineStore.getState().clips || []
  if (clipId) {
    const clip = clips.find((c) => c.id === clipId)
    if (!clip) throw new Error(`No clip found with id "${clipId}".`)
    if (clip.type !== 'captions') {
      throw new Error(`Clip "${clipId}" is a ${clip.type || 'unknown'} clip, not a live captions clip.`)
    }
    return clip
  }
  return clips.find((c) => c.type === 'captions' && Array.isArray(c.captions?.cues) && c.captions.cues.length) || null
}

// Edit the cues of a placed live captions clip in place. Per-cue
// globalOverrides are preserved by cue id (new cues inherit the first cue's),
// so text/timing edits never disturb the styling baked in at generate time.
function updateLiveCaptionsClipCues(clip, payload) {
  const track = useTimelineStore.getState().tracks.find(item => item.id === clip.trackId)
  const locked = item => item?.locked || item?.syncLocked || item?.lockMode === 'sync' || item?.syncLock?.mode === 'sync'
  if (!track || locked(track) || locked(clip)) throw new Error('Unlock the captions clip and its track before editing cues.')
  const renderCues = clip.captions.cues
  // Shared split helpers copy the originating cue, including its styling. A
  // newly split right half must not inherit an unrelated first cue's style.
  const baseCues = renderCues.map(cue => ({ ...cue }))
  const fallbackDuration = Math.max(Number(clip.sourceDuration) || 0, Number(clip.duration) || 0)
  const nextCues = applyCueEditsToList(baseCues, payload, fallbackDuration)
  if (!nextCues.length) throw new Error('Keep at least one live cue, or delete the captions clip. An agent draft may be cleared with cues: [].')

  const overridesById = new Map(renderCues.map((cue) => [cue.id, cue.globalOverrides]))
  const fallbackOverrides = renderCues[0]?.globalOverrides || {}
  const nextRenderCues = nextCues.map((cue) => ({
    ...cue,
    globalOverrides: overridesById.get(cue.id) || cue.globalOverrides || fallbackOverrides,
  }))

  const maxCueEnd = Math.max(...nextCues.map((cue) => Number(cue.end) || 0), 0.4)
  const prevSourceDuration = Number(clip.sourceDuration) || 0
  const nextSourceDuration = Math.max(prevSourceDuration, maxCueEnd)
  // Respect a deliberate trim: only an untrimmed clip follows the new cue
  // extent (the same shape placeLiveCaptions produces).
  const untrimmed = (Number(clip.trimStart) || 0) === 0
    && Math.abs((Number(clip.trimEnd) || 0) - prevSourceDuration) < 1e-6

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'update_caption_cues',
      target: 'clip',
      clipId: clip.id,
      message: 'Cue update plan only. The captions clip was not changed.',
      cueCount: nextCues.length,
      cues: nextCues,
      durationSeconds: untrimmed ? nextSourceDuration : Number(clip.duration) || 0,
      suggestedApplyPayload: { ...payload, target: 'clip', clipId: clip.id, previewOnly: false, expectedContext: captureMcpContext() },
    }
  }

  if (JSON.stringify(nextRenderCues) === JSON.stringify(renderCues)) return { success: true, changed: false,
    action: 'update_caption_cues', target: 'clip', clipId: clip.id, cueCount: nextCues.length, cues: nextCues }

  const store = useTimelineStore.getState()
  store.saveToHistory?.()
  useTimelineStore.setState({
    clips: useTimelineStore.getState().clips.map((c) => (c.id === clip.id
      ? {
          ...c,
          sourceDuration: nextSourceDuration,
          ...(untrimmed ? { duration: nextSourceDuration, trimEnd: nextSourceDuration } : {}),
          captions: { ...c.captions, cues: nextRenderCues },
        }
      : c)),
    ...(untrimmed
      ? { duration: Math.max(useTimelineStore.getState().duration, nextSourceDuration + 10) }
      : {}),
  })

  // Keep a timeline-scope draft in sync so a later generate_captions doesn't
  // resurrect the pre-edit text.
  if (captionDraft && captionDraft.scope === 'timeline' && ownsCaptionContext(captionDraft.owner)
    && captionDraft.liveClipId === clip.id) {
    const timestamp = new Date().toISOString()
    captionDraft = {
      ...captionDraft,
      cues: nextCues.map((cue) => ({ ...cue })),
      transcriptText: cuesToTranscript(nextCues),
      audioDuration: Math.max(Number(captionDraft.audioDuration) || 0, maxCueEnd),
      updatedAt: timestamp,
    }
    captionDraftRevision += 1
  }

  return {
    success: true,
    action: 'update_caption_cues',
    target: 'clip',
    clipId: clip.id,
    message: `Live captions clip updated (${nextCues.length} cue${nextCues.length === 1 ? '' : 's'}) — the change is visible immediately.`,
    cueCount: nextCues.length,
    cues: nextCues,
  }
}

export function handleUpdateCaptionCues(payload = {}) {
  assertMcpContext(payload.expectedContext, 'caption cue edit')
  const replacingAll = Array.isArray(payload.cues)
  const explicitClipId = String(payload.clipId || '').trim() || null
  const requested = typeof payload.target === 'string' ? payload.target.trim().toLowerCase() : null

  // Target resolution: an explicit ask wins; then the transcription draft
  // (the transcribe → update → generate flow, unchanged); then a placed live
  // captions clip; then the legacy create-a-draft-from-cues path.
  let target = null
  if (requested === 'clip' || requested === 'live' || requested === 'timeline-clip') target = 'clip'
  else if (requested === 'draft') target = 'draft'
  else if (explicitClipId) target = 'clip'
  else if (captionDraft && ownsCaptionContext(captionDraft.owner)) target = 'draft'
  else if (findLiveCaptionsClip(null)) target = 'clip'
  else if (replacingAll) target = 'draft'
  else {
    throw new Error('No caption draft and no live captions clip found. Run transcribe_captions first, generate captions, or pass a full "cues" array to create a draft manually.')
  }

  if (target === 'clip') {
    const clip = findLiveCaptionsClip(explicitClipId)
    if (!clip) {
      throw new Error('No live captions clip on the timeline. generate_captions (timeline scope) places one, or use target "draft".')
    }
    return updateLiveCaptionsClipCues(clip, payload)
  }

  if (!replacingAll) assertCaptionDraft(payload)
  else if (payload.expectedDraftRevision !== undefined && payload.expectedDraftRevision !== captionDraftRevision) throw new Error('The caption draft changed. Read it again before replacing it.')

  if (!captionDraft && !replacingAll) {
    throw new Error('No caption draft exists yet. Run transcribe_captions first, or pass a full "cues" array to create a draft manually.')
  }

  const ownedDraft = captionDraft && ownsCaptionContext(captionDraft.owner) ? captionDraft : null
  if (payload.audioDuration !== undefined && (typeof payload.audioDuration !== 'number' || !Number.isFinite(payload.audioDuration) || payload.audioDuration <= 0)) throw new Error('audioDuration must be a positive finite number.')
  const fallbackDuration = Math.max(Number(ownedDraft?.audioDuration) || 0, payload.audioDuration || 0)
  const nextCues = applyCueEditsToList(ownedDraft?.cues || [], payload, fallbackDuration)

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'update_caption_cues',
      target: 'draft',
      message: 'Cue update plan only. The draft was not changed.',
      cueCount: nextCues.length,
      cues: nextCues,
      draftRevision: captionDraftRevision,
      draftSource: 'agent-session',
      suggestedApplyPayload: { ...payload, target: 'draft', previewOnly: false, expectedContext: captureMcpContext(), expectedDraftRevision: captionDraftRevision },
    }
  }

  const timestamp = new Date().toISOString()
  const maxCueEnd = Math.max(...nextCues.map((cue) => cue.end), 0)
  if (!ownedDraft) {
    captionDraft = {
      owner: captureMcpContext(),
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
  captionDraftRevision += 1

  return {
    success: true,
    action: 'update_caption_cues',
    target: 'draft',
    message: `Caption draft updated (${nextCues.length} cue${nextCues.length === 1 ? '' : 's'}).`,
    cueCount: nextCues.length,
    cues: nextCues,
    draftRevision: captionDraftRevision,
    draftSource: 'agent-session',
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
    const preset = ctx.preset
    const traditional = preset.traditional === true
    const renderPreset = preset.renderer === 'kinetic' && !traditional
      ? buildKineticStyleWithColors(preset, ctx.accentColor, ctx.textColor)
      : preset
    const effectiveTextColor = ctx.textColor
      || (traditional ? (preset.subtitleColor || preset.textColor) : preset.textColor)
      || '#FFFFFF'

    // The eleven style controls, kept separate from the placement globals so
    // the live clip's workspace snapshot matches what CaptionWorkspace stores.
    const styleControls = {
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
    }
    const globalOverrides = {
      ...styleControls,
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

    // Timeline scope places LIVE captions — the clip type the app has used
    // since 8601a58. Cues render fresh every frame in preview and export, so
    // generate is instant; no overlay video is baked and no asset is created.
    if (ctx.scope === 'timeline' && ctx.placeOnTimeline) {
      job.stage = 'place'
      job.message = 'Placing live captions clip...'
      const timestamp = new Date().toISOString()

      // Sidecar parity with CaptionWorkspace (cold-start restore fallback);
      // non-fatal, and web mode has no sidecars.
      try {
        assertCaptionJobCurrent(job)
        await saveCaptionSidecar(useProjectStore.getState().currentProjectHandle, { name: 'timeline' }, {
          version: 1,
          scope: 'timeline',
          presetId: preset.id,
          accentColor: ctx.accentColor || null,
          textColor: ctx.textColor || null,
          textStyle: globalOverrides.textStyle,
          subtitlePosition: globalOverrides.subtitlePosition,
          styleControls,
          globalVertical: ctx.verticalPlacement,
          globalHorizontal: ctx.horizontalPlacement,
          globalMotion: ctx.motionProfile,
          globalSizeScale: ctx.sizeScale,
          globalVerticalOffset: ctx.verticalOffset,
          modelId: ctx.modelId || null,
          transcriptText: cuesToTranscript(ctx.cues),
          words: ctx.words || [],
          cues: ctx.cues,
          audioDuration: ctx.duration,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      } catch (sidecarError) {
        console.warn('Could not save the MCP caption sidecar:', sidecarError)
      }

      assertCaptionJobCurrent(job)

      const liveClip = useTimelineStore.getState().placeLiveCaptions?.({
        cues: renderCues,
        preset: renderPreset,
        duration: ctx.duration,
        workspace: {
          version: 1,
          presetId: preset.id,
          accentColor: ctx.accentColor || null,
          textColor: ctx.textColor || null,
          textStyle: globalOverrides.textStyle,
          subtitlePosition: globalOverrides.subtitlePosition,
          styleControls,
          globalVertical: ctx.verticalPlacement,
          globalHorizontal: ctx.horizontalPlacement,
          globalMotion: ctx.motionProfile,
          globalSizeScale: ctx.sizeScale,
          globalVerticalOffset: ctx.verticalOffset,
          modelId: ctx.modelId || null,
          words: ctx.words || [],
          audioDuration: ctx.duration,
          updatedAt: timestamp,
        },
      })
      if (!liveClip) throw new Error('Could not place the live captions clip on the timeline.')
      if (captionDraft && ownsCaptionContext(captionDraft.owner)) captionDraft.liveClipId = liveClip.id

      finishCaptionJob(job, {
        live: true,
        assetId: null,
        clipId: liveClip.id,
        trackId: liveClip.trackId,
        placedOnTimeline: true,
        durationSeconds: ctx.duration,
        cueCount: ctx.cues.length,
        presetId: preset.id,
        note: 'Placed a live captions clip — cues render every frame; edit them with update_caption_cues or double-click the clip in Velorn.',
      })
      return
    }

    job.stage = 'render'
    job.message = `Rendering caption overlay (~${Math.ceil(ctx.duration)}s realtime)...`

    const overlayBlob = await generateCaptionVideoBlob({
      preset: renderPreset,
      cues: renderCues,
      width: ctx.width,
      height: ctx.height,
      duration: ctx.duration,
      fps: ctx.fps,
    })
    assertCaptionJobCurrent(job)

    job.stage = 'save'
    job.message = 'Saving caption overlay asset...'
    const assetsState = useAssetsStore.getState()
    const sourceForName = ctx.scope === 'asset' && ctx.sourceAssetId
      ? (assetsState.getAssetById?.(ctx.sourceAssetId) || { name: 'source_video' })
      : { name: 'timeline' }
    const assetName = buildCaptionAssetName(sourceForName, preset)
    const projectHandle = useProjectStore.getState().currentProjectHandle

    // Sidecar parity with CaptionWorkspace: agent-generated overlays are
    // self-describing too, so Edit Captions on their clips hydrates cues and
    // style. Non-fatal — web mode has no sidecars.
    let sidecar = null
    try {
      const timestamp = new Date().toISOString()
      sidecar = await saveCaptionSidecar(projectHandle, sourceForName, {
        version: 1,
        scope: ctx.scope,
        ...(ctx.scope === 'asset' && ctx.sourceAssetId ? { sourceAssetId: ctx.sourceAssetId } : {}),
        presetId: preset.id,
        accentColor: ctx.accentColor || null,
        textColor: ctx.textColor || null,
        textStyle: globalOverrides.textStyle,
        subtitlePosition: globalOverrides.subtitlePosition,
        styleControls,
        globalVertical: ctx.verticalPlacement,
        globalHorizontal: ctx.horizontalPlacement,
        globalMotion: ctx.motionProfile,
        globalSizeScale: ctx.sizeScale,
        globalVerticalOffset: ctx.verticalOffset,
        modelId: ctx.modelId || null,
        transcriptText: cuesToTranscript(ctx.cues),
        words: ctx.words || [],
        cues: ctx.cues,
        audioDuration: ctx.duration,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    } catch (sidecarError) {
      console.warn('Could not save the MCP caption sidecar:', sidecarError)
    }
    assertCaptionJobCurrent(job)

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
      ...(sidecar?.path ? { captionTranscriptPath: sidecar.path } : {}),
      captionCueCount: ctx.cues.length,
      captionModelId: ctx.modelId || '',
      generatedBy: 'mcp',
    }
    let createdAsset
    if (isElectron() && typeof projectHandle === 'string' && projectHandle) {
      const persisted = await writeGeneratedOverlayToProject(
        projectHandle,
        overlayBlob,
        assetName,
        'video',
        captionSettings
      )
      assertCaptionJobCurrent(job)
      const folderId = ensureCaptionsFolder(useAssetsStore.getState().folders || [], useAssetsStore.getState().addFolder)
      createdAsset = assetsState.addAsset?.({
        ...persisted,
        folderId,
        settings: { ...(persisted.settings || {}), ...captionSettings },
      })
    } else {
      const folderId = ensureCaptionsFolder(useAssetsStore.getState().folders || [], useAssetsStore.getState().addFolder)
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
  assertMcpContext(payload.expectedContext, 'caption generation')
  const hasInlineCues = Array.isArray(payload.cues)
  if (!hasInlineCues) assertCaptionDraft(payload)
  const draftForGeneration = hasInlineCues ? null : captionDraft
  const inlineCues = hasInlineCues ? normalizeCueOrder(payload.cues, 0) : null
  const cues = hasInlineCues ? inlineCues : (draftForGeneration?.cues?.length ? draftForGeneration.cues.map((cue) => ({ ...cue })) : null)
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
  const duration = Math.max(1, Math.max(maxCueEnd, Number(draftForGeneration?.audioDuration) || 0))
  const scope = draftForGeneration?.scope === 'asset' ? 'asset' : 'timeline'

  const ctx = {
    cues,
    preset,
    scope,
    sourceAssetId: scope === 'asset' ? draftForGeneration?.sourceAssetId || null : null,
    modelId: draftForGeneration?.modelId || '',
    words: Array.isArray(draftForGeneration?.words) ? draftForGeneration.words : [],
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
    ...(scope === 'timeline' && ctx.placeOnTimeline
      ? { note: 'Places a LIVE captions clip (instant — cues render every frame, no baked overlay). Replaces any captions already on the Captions track; the clip keeps its transform/grade/masks through a regenerate.' }
      : { estimatedRenderSeconds: Math.ceil(duration) }),
    pollWith: 'get_caption_status',
  }

  if (payload.previewOnly !== false) {
    return {
      previewOnly: true,
      action: 'generate_captions',
      message: 'Caption render plan only. No job was started.',
      plan,
      suggestedApplyPayload: { ...payload, previewOnly: false, expectedContext: captureMcpContext(),
        ...(!hasInlineCues ? { expectedDraftRevision: captionDraftRevision } : {}) },
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
