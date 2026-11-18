import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import { normalizeAudioVolumeEnvelope, validateAudioVolumeEnvelope } from '../utils/audioVolumeEnvelope.mjs'
import { normalizeAudioEq, validateAudioEq } from '../utils/audioEq.mjs'
import { normalizeAudioClipGainDb } from '../utils/audioClipGain'
import { clampAudioFadeDuration } from '../utils/audioClipFades'
import { DEFAULT_DUCKING_SETTINGS, getDuckingSources } from '../utils/audioDucking.mjs'
import { analyzeAudioDucking } from './audioDucking.mjs'
import { buildOpticalFlowCache, cancelOpticalFlowCache, getOpticalFlowClipStatus } from './opticalFlowCache'
import { FRAME_SAMPLING_MODE, normalizeFrameSamplingMode, getRequiredOpticalFlowTargetFps } from '../utils/frameSampling'
import { loadSystemFontFamilies } from './systemFonts'
import { captureMcpContext, assertMcpContext } from './mcpContext'

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const copy = value => JSON.parse(JSON.stringify(value))
const locked = value => Boolean(value?.locked || value?.syncLocked || value?.lockMode === 'sync' || value?.syncLock?.mode === 'sync')
const finite = (value, label, min = -Infinity, max = Infinity) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a finite number from ${min} to ${max}.`)
  return value
}

function clipById(id, type = null, writable = false) {
  const state = useTimelineStore.getState()
  const matches = state.clips.filter(clip => clip.id === id)
  if (matches.length !== 1) throw new Error(`Clip "${id}" is missing or ambiguous.`)
  const clip = matches[0]
  if (type && clip.type !== type) throw new Error(`Clip "${id}" must be ${type}.`)
  const tracks = state.tracks.filter(track => track.id === clip.trackId)
  if (tracks.length !== 1) throw new Error(`The track for "${id}" is missing or ambiguous.`)
  if (writable && (locked(clip) || locked(tracks[0]))) throw new Error(`Unlock clip "${id}" and its track first.`)
  return clip
}

function audioTargets(payload, writable = false) {
  const ids = payload.clipId ? [payload.clipId] : payload.clipIds
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('Provide clipId or between 1 and 100 clipIds.')
  }
  const state = useTimelineStore.getState()
  const targets = new Map()
  for (const id of ids) {
    let clip = clipById(id, null, writable)
    if (clip.type === 'video') {
      // Never pick an arbitrary reuse of the same source asset on another edit.
      const linked = state.clips.filter(candidate => candidate.type === 'audio' && (
        clip.linkGroupId ? candidate.linkGroupId === clip.linkGroupId
          : candidate.assetId === clip.assetId && candidate.startTime === clip.startTime
            && candidate.duration === clip.duration && (candidate.trimStart || 0) === (clip.trimStart || 0)
      ))
      if (linked.length !== 1) throw new Error(`Video "${id}" has no unique linked audio. Supply the audio clip ID explicitly.`)
      clip = clipById(linked[0].id, 'audio', writable)
    }
    if (clip.type !== 'audio' || state.tracks.find(track => track.id === clip.trackId)?.type !== 'audio') {
      throw new Error(`Clip "${id}" is not on an audio track.`)
    }
    targets.set(clip.id, clip)
  }
  return [...targets.values()]
}

function audioSummary(clip) {
  return {
    id: clip.id, name: clip.name || clip.id, trackId: clip.trackId, duration: clip.duration,
    gainDb: normalizeAudioClipGainDb(clip.gainDb),
    fadeInSeconds: clampAudioFadeDuration(clip.fadeIn, clip.duration),
    fadeOutSeconds: clampAudioFadeDuration(clip.fadeOut, clip.duration),
    volumeEnvelope: normalizeAudioVolumeEnvelope(clip.volumeEnvelope), audioEq: normalizeAudioEq(clip.audioEq),
  }
}

function inspectClipAudio(payload = {}) {
  return { action: 'inspect_clip_audio', clips: audioTargets(payload).map(audioSummary),
    envelopeCoordinates: 'A point is at clip-local seconds = point.time - offsetSeconds. Hidden trim points are intentionally preserved.',
    context: captureMcpContext() }
}

function setClipAudio(payload = {}) {
  assertMcpContext(payload.expectedContext, 'audio edit')
  const clips = audioTargets(payload, true)
  if (payload.resetEnvelope && own(payload, 'volumeEnvelope')) throw new Error('Use volumeEnvelope or resetEnvelope, not both.')
  if (payload.resetEq && own(payload, 'audioEq')) throw new Error('Use audioEq or resetEq, not both.')
  const updates = {}
  if (own(payload, 'gainDb')) updates.gainDb = normalizeAudioClipGainDb(finite(payload.gainDb, 'gainDb'))
  for (const [key, alias, property] of [['fadeInSeconds', 'fadeIn', 'fadeIn'], ['fadeOutSeconds', 'fadeOut', 'fadeOut']]) {
    if (own(payload, key) || own(payload, alias)) updates[property] = finite(payload[key] ?? payload[alias], key, 0)
  }
  const envelopeInput = own(payload, 'volumeEnvelope') || payload.resetEnvelope === true
  const eqInput = own(payload, 'audioEq') || payload.resetEq === true
  let envelope
  if (envelopeInput) {
    const checked = validateAudioVolumeEnvelope(payload.resetEnvelope ? null : payload.volumeEnvelope)
    if (!checked.ok) throw new Error(checked.reason)
    envelope = checked.envelope
  }
  const plans = clips.map(clip => {
    const next = { ...clip, ...updates }
    if (own(updates, 'fadeIn')) next.fadeIn = clampAudioFadeDuration(updates.fadeIn, clip.duration)
    if (own(updates, 'fadeOut')) next.fadeOut = clampAudioFadeDuration(updates.fadeOut, clip.duration)
    if (envelopeInput) next.volumeEnvelope = envelope
    if (eqInput) {
      if (payload.audioEq !== undefined && (payload.audioEq === null || typeof payload.audioEq !== 'object' || Array.isArray(payload.audioEq))) throw new Error('audioEq must be an object; use resetEq to reset.')
      const checked = validateAudioEq(payload.resetEq ? null : { ...normalizeAudioEq(clip.audioEq), ...payload.audioEq })
      if (!checked.ok) throw new Error(checked.reason)
      next.audioEq = checked.eq
    }
    return { clip, next, changed: JSON.stringify(audioSummary(clip)) !== JSON.stringify(audioSummary(next)) }
  })
  if (!Object.keys(updates).length && !envelopeInput && !eqInput) throw new Error('Provide gain/fades, volumeEnvelope, audioEq, resetEnvelope, or resetEq.')
  const changed = plans.filter(plan => plan.changed)
  if (payload.previewOnly !== false) return { action: 'set_clip_audio', previewOnly: true,
    context: captureMcpContext(), before: clips.map(audioSummary), after: plans.map(plan => audioSummary(plan.next)), changedCount: changed.length }
  if (!changed.length) return { action: 'set_clip_audio', success: true, changedCount: 0, clips: clips.map(audioSummary) }
  // Every target/value is preflighted before the one history boundary. No awaits
  // occur between this check and the existing synchronous store actions.
  useTimelineStore.getState().saveToHistory()
  for (const plan of changed) {
    if (Object.keys(updates).length) useTimelineStore.getState().updateAudioClipProperties(plan.clip.id, updates, false)
    if (envelopeInput) {
      const result = useTimelineStore.getState().updateAudioVolumeEnvelope(plan.clip.id, envelope, false)
      if (!result?.ok) throw new Error(result?.reason || 'Volume update was rejected.')
    }
    if (eqInput) {
      const result = useTimelineStore.getState().updateAudioEq(plan.clip.id, plan.next.audioEq, false)
      if (!result?.ok) throw new Error(result?.reason || 'EQ update was rejected.')
    }
  }
  return { action: 'set_clip_audio', success: true, changedCount: changed.length,
    clips: clips.map(clip => audioSummary(clipById(clip.id))) }
}

const duckingJobs = new Map()
const interpolationJobs = new Map()
let jobSerial = 0
function newJobId(prefix) { return `${prefix}-${Date.now().toString(36)}-${++jobSerial}` }
function retainJobs(jobs) {
  for (const [id, job] of jobs) {
    if (jobs.size <= 20) break
    if (!['running', 'ready'].includes(job.status)) jobs.delete(id)
  }
  if (jobs.size >= 40) throw new Error('Too many pending jobs. Finish or cancel earlier jobs first.')
}
function ownedJob(jobs, id) {
  const job = jobs.get(id)
  if (!job) throw new Error(`Unknown job "${id}".`)
  return job
}
function summarizeDucking(job) {
  let current = true
  try { assertMcpContext(job.context, 'ducking result') } catch (_) { current = false }
  return { jobId: job.id, status: job.status, musicClipId: job.musicId, dialogueTrackId: job.dialogueTrackId,
    context: job.context, applicable: current && job.status === 'ready', message: job.message, error: job.error || null,
    ...(job.result ? { result: copy(job.result) } : {}) }
}

function audioDucking(payload = {}) {
  const operation = payload.operation || 'status'
  if (operation === 'status') return { action: 'audio_ducking', jobs: payload.jobId
    ? [summarizeDucking(ownedJob(duckingJobs, payload.jobId))] : [...duckingJobs.values()].map(summarizeDucking) }
  if (operation === 'cancel' || operation === 'apply') {
    const job = ownedJob(duckingJobs, payload.jobId)
    assertMcpContext(payload.expectedContext, 'ducking edit')
    if (operation === 'apply') {
      assertMcpContext(job.context, 'ducking result')
      if (job.status !== 'ready') throw new Error('Analyze first, then wait for a ready ducking result. Applied results cannot be applied twice.')
      const clip = clipById(job.musicId, 'audio', true)
      const validated = validateAudioVolumeEnvelope(job.result?.envelope)
      if (!validated.ok) throw new Error(validated.reason)
      if (payload.previewOnly !== false) return { action: 'audio_ducking', previewOnly: true, operation,
        before: normalizeAudioVolumeEnvelope(clip.volumeEnvelope), after: validated.envelope, job: summarizeDucking(job) }
      const result = useTimelineStore.getState().updateAudioVolumeEnvelope(clip.id, validated.envelope, true, clip)
      if (!result?.ok) throw new Error(result?.reason || 'The ducking envelope could not be applied.')
      job.status = 'applied'
      return { action: 'audio_ducking', success: true, changed: result.changed, job: summarizeDucking(job) }
    }
    if (!['running', 'ready'].includes(job.status)) throw new Error('Only running or ready ducking jobs can be canceled.')
    if (payload.previewOnly !== false) return { action: 'audio_ducking', previewOnly: true, operation, job: summarizeDucking(job) }
    job.controller.abort(); job.status = 'canceled'; job.message = 'Canceled; the timeline was not changed.'
    return { action: 'audio_ducking', success: true, job: summarizeDucking(job) }
  }
  if (operation !== 'analyze') throw new Error('Use analyze, status, apply, or cancel.')
  assertMcpContext(payload.expectedContext, 'ducking analysis')
  const musicId = String(payload.musicClipId || payload.clipId || '')
  const dialogueTrackId = String(payload.dialogueTrackId || '')
  clipById(musicId, 'audio', true)
  const state = useTimelineStore.getState(), assets = useAssetsStore.getState().assets
  const sources = getDuckingSources(state, assets, musicId, dialogueTrackId)
  if (!sources.ok) throw new Error(sources.reason)
  const settings = { ...DEFAULT_DUCKING_SETTINGS, ...(payload.settings || {}) }
  finite(settings.reductionDb, 'reductionDb', 3, 24)
  finite(settings.fadeSeconds, 'fadeSeconds', 0.05, 1.5)
  finite(settings.thresholdDb, 'thresholdDb', -60, -10)
  const context = captureMcpContext()
  const plan = { musicClipId: musicId, dialogueTrackId, settings,
    note: 'Read-only local level analysis; EQ/inserts are not included. The result is an editable volume-envelope proposal, not an automatic timeline edit.' }
  if (payload.previewOnly !== false) return { action: 'audio_ducking', previewOnly: true, operation, context, plan }
  if ([...duckingJobs.values()].some(job => job.status === 'running')) throw new Error('A ducking analysis is already running. Poll or cancel it first.')
  retainJobs(duckingJobs)
  const job = { id: newJobId('ducking'), status: 'running', musicId, dialogueTrackId, context,
    controller: new AbortController(), message: 'Analyzing local dialogue audio…' }
  duckingJobs.set(job.id, job)
  const isCurrent = () => {
    try { assertMcpContext(context, 'ducking analysis'); return !job.controller.signal.aborted } catch (_) { return false }
  }
  Promise.resolve().then(() => analyzeAudioDucking({ state, assets, projectHandle: useProjectStore.getState().currentProjectHandle,
    musicId, dialogueTrackId, settings, signal: job.controller.signal, isCurrent,
    onProgress: message => { if (job.status === 'running') job.message = message } }))
    .then(result => {
      if (job.status === 'canceled') return
      assertMcpContext(context, 'ducking analysis')
      job.result = result; job.status = 'ready'; job.message = 'Ready for review. Apply explicitly to write one undoable envelope.'
    }).catch(error => {
      if (job.status === 'canceled') return
      job.status = 'failed'; job.error = error?.message || String(error)
    })
  return { action: 'audio_ducking', success: true, plan, job: summarizeDucking(job) }
}

function currentOwner() {
  const project = useProjectStore.getState(), state = useTimelineStore.getState()
  return { project: project.currentProjectHandle, timeline: project.currentTimelineId, session: state.timelineSessionId }
}
function sameOwner(owner) {
  const current = currentOwner()
  return owner.project === current.project && owner.timeline === current.timeline && owner.session === current.session
}
function interpolationSummary(clip) {
  const state = useTimelineStore.getState()
  const asset = useAssetsStore.getState().assets.find(item => item.id === clip.assetId)
  const timelineFps = Number(state.timelineFps) || 24
  const sourceFps = Number(asset?.settings?.fps ?? asset?.fps ?? clip.sourceFps) || timelineFps
  const targetFps = getRequiredOpticalFlowTargetFps(clip, { timelineFps, sourceFps })
  const status = getOpticalFlowClipStatus(clip, { timelineFps, sourceFps })
  return { clipId: clip.id, frameSampling: normalizeFrameSamplingMode(clip.frameSampling), sourceFps, targetFps,
    status: status.state, usable: Boolean(status.usable), progress: clip.opticalFlowCache?.progress || 0,
    phase: clip.opticalFlowCache?.phase || null, error: clip.opticalFlowCache?.error || null,
    engine: 'rife-ncnn-vulkan', model: 'rife-v4.6', cachePath: clip.opticalFlowCache?.path || null,
    unsupportedReason: clip.reverse ? 'Reverse playback is not supported.'
      : asset?.settings?.hasAlpha ? 'Transparent video is not supported.'
        : targetFps <= sourceFps + 0.001 ? 'Slow this clip down before building interpolated frames.' : null }
}
function summarizeInterpolationJob(job) {
  const owns = sameOwner(job.owner)
  const clip = owns && useTimelineStore.getState().clips.find(item => item.id === job.clipId)
  return { jobId: job.id, clipId: job.clipId, status: job.status, belongsToCurrentTimeline: owns, error: job.error || null,
    ...(clip ? { clip: interpolationSummary(clip) } : {}) }
}

async function clipInterpolation(payload = {}) {
  const operation = payload.operation || 'inspect'
  if (!['inspect', 'set', 'build', 'cancel'].includes(operation)) throw new Error('Use inspect, set, build, or cancel.')
  const job = payload.jobId ? ownedJob(interpolationJobs, payload.jobId) : null
  if (operation === 'inspect' && job) return { action: 'clip_interpolation', job: summarizeInterpolationJob(job) }
  assertMcpContext(payload.expectedContext, 'frame interpolation')
  if (job && !sameOwner(job.owner)) throw new Error('Reopen the timeline that started this interpolation job before changing it.')
  const clip = clipById(payload.clipId || job?.clipId, 'video', operation !== 'inspect')
  const summary = interpolationSummary(clip)
  if (operation === 'inspect') return { action: 'clip_interpolation', clip: summary, context: captureMcpContext() }
  if (operation === 'set') {
    if (!Object.values(FRAME_SAMPLING_MODE).includes(payload.frameSampling)) throw new Error('frameSampling must be frame, blend, or optical-flow.')
    if (payload.previewOnly !== false) return { action: 'clip_interpolation', previewOnly: true, operation, before: summary, frameSampling: payload.frameSampling }
    const changed = useTimelineStore.getState().updateClipFrameSampling(clip.id, payload.frameSampling, true)
    return { action: 'clip_interpolation', success: true, changed, clip: interpolationSummary(clipById(clip.id)) }
  }
  if (operation === 'cancel') {
    if (job && job.status !== 'running') throw new Error('This interpolation job is not running.')
    if (payload.previewOnly !== false) return { action: 'clip_interpolation', previewOnly: true, operation, clip: summary }
    if (job) job.controller.abort()
    const canceled = (await cancelOpticalFlowCache(clip.id)) || Boolean(job)
    if (job && canceled) job.status = 'canceled'
    return { action: 'clip_interpolation', success: true, canceled }
  }
  if (summary.frameSampling !== 'optical-flow') throw new Error('Set frameSampling to optical-flow before building its cache.')
  if (summary.unsupportedReason) throw new Error(summary.unsupportedReason)
  if (!useProjectStore.getState().currentProjectHandle) throw new Error('Save the project before building its interpolation cache.')
  if (summary.status === 'rendering' || summary.status === 'hydrating') throw new Error('Interpolation is already busy for this clip. Inspect or cancel it first.')
  if (payload.previewOnly !== false) return { action: 'clip_interpolation', previewOnly: true, operation, clip: summary,
    note: 'Starts native local RIFE GPU work and writes a project cache. Existing source media and audio timing are unchanged.' }
  if ([...interpolationJobs.values()].some(item => item.status === 'running' && sameOwner(item.owner) && item.clipId === clip.id)) throw new Error('This clip already has an active interpolation job.')
  retainJobs(interpolationJobs)
  const buildJob = { id: newJobId('interpolation'), clipId: clip.id, owner: currentOwner(), status: 'running', controller: new AbortController() }
  interpolationJobs.set(buildJob.id, buildJob)
  // The native service itself verifies source/timing identity, aborts on project
  // switches, and publishes transient progress. Do not treat its progress writes
  // as a stale creative revision or hold the MCP request open for the whole job.
  Promise.resolve().then(() => {
    if (!sameOwner(buildJob.owner)) throw new Error('The timeline changed before interpolation started.')
    if (buildJob.controller.signal.aborted) throw new Error('Optical Flow cancelled')
    return buildOpticalFlowCache(clip.id, { signal: buildJob.controller.signal })
  }).then(() => {
    if (buildJob.status === 'canceled') return
    const current = sameOwner(buildJob.owner) && useTimelineStore.getState().clips.find(item => item.id === clip.id)
    if (!current || interpolationSummary(current).status !== 'ready') throw new Error('The interpolation result was canceled or became stale.')
    buildJob.status = 'completed'
  }).catch(error => {
    if (buildJob.status === 'canceled') return
    buildJob.status = 'failed'; buildJob.error = error?.message || String(error)
  })
  return { action: 'clip_interpolation', success: true, job: summarizeInterpolationJob(buildJob) }
}

async function listFonts(payload = {}) {
  const result = await loadSystemFontFamilies({ forceRefresh: payload.forceRefresh === true })
  const query = String(payload.query || '').trim().toLocaleLowerCase()
  const families = result.families.filter(family => !query || family.toLocaleLowerCase().includes(query))
  return { action: 'list_fonts', status: result.status, source: result.source, error: result.error || null,
    families, count: families.length, note: 'Uses the same system-font catalog and curated fallback as the Velorn font selector.' }
}

export const MCP_AUDIO_ACTIONS = Object.freeze({
  inspect_clip_audio: inspectClipAudio,
  set_clip_audio: setClipAudio,
  audio_ducking: audioDucking,
  clip_interpolation: clipInterpolation,
  list_fonts: listFonts,
})
