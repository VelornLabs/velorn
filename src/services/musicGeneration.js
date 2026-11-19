/** Timeline music jobs. Legacy callers default to ACE-Step; new UIs select YuE2 explicitly. */
import { comfyui } from './comfyui'
import { importAsset } from './fileSystem'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import { markPromptHandledByApp } from './comfyPromptGuard'
import { checkWorkflowDependencies } from './workflowDependencies'
import {
  buildAceStepWorkflow, buildYue2Workflow, getMusicBackend,
  resolveMusicLength, getMusicCompletion, normalizeMusicBpm, MUSIC_VARIATIONS_MAX,
} from './musicGenerationModels.mjs'

export * from './musicGenerationModels.mjs'
export const MUSIC_WORKFLOW_ID = 'music-gen' // Persisted legacy ID, never repurpose.
export const GENERATED_MUSIC_FOLDER = ['Generated Music']
export const MUSIC_JOBS_UPDATED_EVENT = 'velorn-music-jobs-updated'

const POLL_INTERVAL_MS = 3000
const JOB_TIMEOUT_MS = 60 * 60 * 1000
const musicJobs = new Map()
let pollTimer = null
let pollInFlight = null

function notifyJobsUpdated() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(MUSIC_JOBS_UPDATED_EVENT))
}

function ownsActiveProject(job) {
  return job.projectDir === useProjectStore.getState().currentProjectHandle
}

function ensureGeneratedMusicFolder() {
  const state = useAssetsStore.getState()
  return (state.folders || []).find(folder => !folder.parentId && folder.name === GENERATED_MUSIC_FOLDER[0])?.id
    || state.addFolder({ name: GENERATED_MUSIC_FOLDER[0], parentId: null })?.id
}

// Only import the final saver: planning/preview nodes may also contain audio.
export function collectMusicAudioOutputs(historyEntry, backend) {
  const nodeId = getMusicBackend(backend).outputNodeId
  const files = new Map()
  for (const entries of Object.values(historyEntry?.outputs?.[nodeId] || {})) {
    if (!Array.isArray(entries)) continue
    for (const item of entries) {
      const filename = item?.filename
      if (!filename || !/\.(mp3|wav|ogg|flac|aac|m4a)$/i.test(filename) || (item.type && item.type !== 'output')) continue
      const file = { nodeId, filename, subfolder: item.subfolder || '', type: 'output' }
      files.set(file.subfolder + '/' + filename, file)
    }
  }
  return [...files.values()]
}

async function importMusicOutput(job, file) {
  if (!ownsActiveProject(job)) return null
  const existing = useAssetsStore.getState().assets.find(asset => asset.promptId === job.promptId
    && asset.sourceFilename === file.filename && (asset.sourceSubfolder || '') === file.subfolder)
  if (existing) return existing

  // Save into the initiating project. Keep a completed copy across a project switch.
  const fileKey = file.subfolder + '/' + file.filename
  let assetInfo = job.importedFiles.get(fileKey)
  if (!assetInfo) {
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type })
    const response = await fetch(job.httpBase + '/view?' + query)
    if (!response.ok) throw new Error('Could not download generated audio (' + response.status + ').')
    const blob = await response.blob()
    if (!ownsActiveProject(job)) return null
    const blobFile = new File([blob], file.filename, { type: blob.type || 'audio/flac' })
    assetInfo = await importAsset(job.projectDir, blobFile, 'audio')
    if (!Number.isFinite(Number(assetInfo.duration)) || Number(assetInfo.duration) <= 0) {
      throw new Error('The audio was saved, but its duration could not be read. Reopen it from the project’s assets/audio folder.')
    }
    assetInfo = { ...assetInfo, url: URL.createObjectURL(blobFile) }
    job.importedFiles.set(fileKey, assetInfo)
  }
  if (!ownsActiveProject(job)) return null
  const measured = Number(assetInfo.duration)
  if (!Number.isFinite(measured) || measured <= 0) {
    throw new Error('The audio was saved, but its duration could not be read. Reopen it from the project’s assets/audio folder.')
  }
  const model = getMusicBackend(job.params.backend)
  const completion = getMusicCompletion(job.params, measured)
  return useAssetsStore.getState().addAsset({
    ...assetInfo,
    name: 'Music ' + job.params.tags.slice(0, 40) + ' (' + file.filename + ')',
    type: 'audio', folderId: ensureGeneratedMusicFolder(), isImported: true,
    source: 'comfyui-auto-import', promptId: job.promptId,
    sourceNodeId: file.nodeId, sourceFilename: file.filename,
    sourceSubfolder: file.subfolder, sourceOutputType: file.type,
    generatedMusic: {
      ...job.params, version: 1, workflowId: model.workflowId,
      modelFiles: model.modelFiles, durationMode: model.durationMode,
      measuredDurationSeconds: measured,
      completion, completionWarning: completion.warning,
    },
  })
}

async function pollJobsOnce() {
  const pending = [...musicJobs.values()].filter(job => ['queued', 'running', 'awaiting-project'].includes(job.status))
  if (!pending.length) {
    clearInterval(pollTimer)
    pollTimer = null
    return
  }
  for (const job of pending) {
    try {
      if (!job.outputFiles) {
        if (Date.now() - job.createdAt > JOB_TIMEOUT_MS) throw new Error('Music generation timed out. Check ComfyUI history for the output.')
        const response = await fetch(job.httpBase + '/history/' + encodeURIComponent(job.promptId))
        if (!response.ok) throw new Error('Could not check ComfyUI history (' + response.status + ').')
        const history = await response.json()
        const entry = history?.[job.promptId]
        if (!entry) continue
        if (entry.status?.status_str === 'error') {
          const detail = (entry.status.messages || []).filter(message => String(message[0]).includes('error'))
            .map(message => message[1]?.exception_message).filter(Boolean).join('; ')
          job.status = 'failed'
          job.error = detail || 'ComfyUI reported an execution error.'
          continue
        }
        const files = collectMusicAudioOutputs(entry, job.params.backend)
        if (!files.length) {
          if (entry.status?.completed) {
            job.status = 'failed'
            job.error = 'ComfyUI finished without a final audio file.'
          }
          continue
        }
        job.outputFiles = files
      }
      if (!ownsActiveProject(job)) {
        job.status = 'awaiting-project'
        job.error = 'Audio is ready. Reopen the project that started this take to import it.'
        continue
      }
      job.status = 'running'
      const assetIds = [], durations = []
      for (const file of job.outputFiles) {
        const asset = await importMusicOutput(job, file)
        if (asset?.id) { assetIds.push(asset.id); durations.push(asset.duration) }
      }
      if (assetIds.length !== job.outputFiles.length) {
        job.status = 'awaiting-project'
        job.error = 'Reopen the project that started this take to finish importing it.'
        continue
      }
      job.status = 'completed'
      job.error = null
      job.assetIds = assetIds
      job.measuredDurationSeconds = durations[0]
      job.completion = getMusicCompletion(job.params, durations[0])
      job.completionWarning = job.completion.warning
    } catch (error) {
      job.error = error?.message || 'Music generation failed.'
      // Network polling can recover; failed imports must be visible, not ghost assets.
      if (job.outputFiles || Date.now() - job.createdAt > JOB_TIMEOUT_MS) job.status = 'failed'
    }
  }
  notifyJobsUpdated()
}

function pollJobs() {
  if (!pollInFlight) pollInFlight = pollJobsOnce().finally(() => { pollInFlight = null })
  return pollInFlight
}

/** Queue local-model music. A partial queue error includes already accepted jobs. */
export async function queueMusicGeneration({
  backend, tags, lyrics = '', instrumental = false, durationSeconds, lengthMode,
  variations = 1, seed = null, bpm = 120, keyScale = 'C major', timeSignature = '4', language = 'en',
} = {}) {
  const model = getMusicBackend(backend)
  const length = resolveMusicLength({ backend: model.id, durationSeconds, lengthMode })
  const safeTags = String(tags || '').trim()
  if (!safeTags) throw new Error('Describe the music style, mood, or instruments first.')
  const projectDir = useProjectStore.getState().currentProjectHandle
  if (!projectDir) throw new Error('Create or open a project before generating music so the audio can be saved with it.')
  const dependencies = await checkMusicModelDependencies(model.id)
  if (!dependencies || dependencies.status === 'error') throw new Error('Could not check the music model. Connect ComfyUI and try again.')
  if (dependencies.hasBlockingIssues) throw new Error(model.label + ' is not ready. Check its models and update ComfyUI if nodes are missing.')
  if (projectDir !== useProjectStore.getState().currentProjectHandle) throw new Error('The project changed. Generate again from the intended project.')
  const count = Math.max(1, Math.min(MUSIC_VARIATIONS_MAX, Math.round(Number(variations) || 1)))
  const baseSeed = seed !== null && seed !== '' && Number.isSafeInteger(Number(seed))
    ? Math.abs(Number(seed)) : Math.floor(Math.random() * 2 ** 32)
  const httpBase = comfyui.getHttpBase()
  const jobs = []
  try {
    for (let index = 0; index < count; index++) {
      if (httpBase !== comfyui.getHttpBase()) throw new Error('The ComfyUI connection changed while queueing music.')
      if (projectDir !== useProjectStore.getState().currentProjectHandle) throw new Error('The project changed while queueing music. Earlier accepted takes remain with the original project.')
      const params = {
        backend: model.id, tags: safeTags, lyrics: instrumental ? '' : String(lyrics || '').trim(),
        instrumental: Boolean(instrumental), ...length,
        seed: (baseSeed + index) % Number.MAX_SAFE_INTEGER,
        ...(model.id === 'ace-step' ? { bpm: normalizeMusicBpm(bpm), keyScale, timeSignature, language } : {}),
      }
      const workflow = model.id === 'yue2' ? buildYue2Workflow(params) : buildAceStepWorkflow(params)
      const promptId = await comfyui.queuePrompt(workflow)
      markPromptHandledByApp(promptId)
      const job = { promptId, status: 'queued', params, seed: params.seed, projectDir, httpBase,
        error: null, assetIds: [], importedFiles: new Map(), createdAt: Date.now() }
      musicJobs.set(promptId, job)
      jobs.push(job)
      if (!pollTimer) pollTimer = setInterval(pollJobs, POLL_INTERVAL_MS)
      notifyJobsUpdated()
    }
  } catch (error) {
    error.queuedJobs = jobs.map(summarizeMusicJob)
    throw error
  }
  return jobs.map(summarizeMusicJob)
}

export function summarizeMusicJob(job) {
  if (!job) return null
  const model = getMusicBackend(job.params?.backend)
  const length = resolveMusicLength({ ...job.params, backend: model.id })
  const completion = job.completion || getMusicCompletion({ ...job.params, ...length }, job.measuredDurationSeconds)
  return {
    ...job.params, ...length, backend: model.id, backendLabel: model.label, durationMode: model.durationMode,
    promptId: job.promptId, status: job.status, seed: job.seed,
    measuredDurationSeconds: job.measuredDurationSeconds || null,
    completion, completionWarning: completion.warning,
    belongsToCurrentProject: ownsActiveProject(job),
    error: job.error || null, assetIds: [...job.assetIds],
  }
}

export function getMusicJobs(promptIds = null) {
  const wanted = Array.isArray(promptIds) ? new Set(promptIds) : null
  return [...musicJobs.values()].filter(job => !wanted || wanted.has(job.promptId))
    .sort((a, b) => b.createdAt - a.createdAt).map(summarizeMusicJob)
}

export async function refreshMusicJobs() { await pollJobs(); return getMusicJobs() }

export async function checkMusicModelDependencies(backend) {
  const model = getMusicBackend(backend)
  try { return await checkWorkflowDependencies(model.workflowId) } catch (_) { return null }
}
