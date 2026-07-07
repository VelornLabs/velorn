/**
 * ACE-Step music generation.
 *
 * Builds the ComfyUI ACE-Step 1.5 turbo text-to-music graph — the same
 * architecture as the app's bundled music_generation.json workflow
 * (UNETLoader acestep_v1.5_turbo + DualCLIPLoader qwen encoders + VAELoader
 * ace_1.5_vae, TextEncodeAceStepAudio1.5, 8-step turbo KSampler,
 * SaveAudioMP3). Queues it, polls history, and imports finished audio into a
 * "Generated Music" asset folder.
 *
 * The 'music-gen' workflow dependency pack (workflowDependencyPacks.js) plus
 * the MODEL_INSTALL_RECIPES catalog cover these four model files, so the
 * popover can detect missing models and download them through the existing
 * installWorkflowSetup pipeline.
 *
 * Ownership: outputs use a `velorn_music_` filename prefix, which matches
 * comfyAutoImport's VELORN_MANAGED_OUTPUT_RE, and every queued prompt id is
 * registered with comfyPromptGuard — so the auto-import bridge never touches
 * these files and this module is the single importer.
 *
 * Jobs are tracked in a module-level registry with a background poll loop,
 * so a generation finishes and imports even if the UI that queued it (the
 * timeline popover) has been closed. UIs subscribe via the
 * 'velorn-music-jobs-updated' window event.
 */

import { comfyui } from './comfyui'
import { importAsset } from './fileSystem'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import { markPromptHandledByApp } from './comfyPromptGuard'
import { checkWorkflowDependencies } from './workflowDependencies'

// ACE-Step 1.5 turbo model files (see the 'music-gen' dependency pack).
export const ACE_STEP_MODELS = Object.freeze({
  diffusion: 'acestep_v1.5_turbo.safetensors',
  vae: 'ace_1.5_vae.safetensors',
  clip1: 'qwen_0.6b_ace15.safetensors',
  clip2: 'qwen_1.7b_ace15.safetensors',
})
export const MUSIC_WORKFLOW_ID = 'music-gen'
export const GENERATED_MUSIC_FOLDER = ['Generated Music']
export const MUSIC_JOBS_UPDATED_EVENT = 'velorn-music-jobs-updated'

export const MUSIC_DURATION_MIN = 5
export const MUSIC_DURATION_MAX = 240
export const MUSIC_VARIATIONS_MAX = 4
export const MUSIC_BPM_MIN = 40
export const MUSIC_BPM_MAX = 220
export const MUSIC_TIME_SIGNATURES = ['2', '3', '4', '6']
export const MUSIC_KEY_SCALES = [
  'C major', 'G major', 'D major', 'A major', 'E major', 'F major',
  'A minor', 'E minor', 'B minor', 'D minor', 'C minor', 'F minor',
]

const AUDIO_EXT_RE = /\.(mp3|wav|ogg|flac|aac|m4a)$/i
const POLL_INTERVAL_MS = 3000
const JOB_TIMEOUT_MS = 15 * 60 * 1000

// promptId -> { promptId, status, params, seed, error, assetIds, createdAt }
const musicJobs = new Map()
let pollTimer = null

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

function notifyJobsUpdated() {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(MUSIC_JOBS_UPDATED_EVENT))
  } catch (_) { /* ignore */ }
}

export function normalizeMusicDuration(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 30
  return clamp(Math.round(parsed), MUSIC_DURATION_MIN, MUSIC_DURATION_MAX)
}

export function normalizeMusicBpm(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 120
  return clamp(Math.round(parsed), MUSIC_BPM_MIN, MUSIC_BPM_MAX)
}

/**
 * ComfyUI ACE-Step 1.5 turbo text-to-music graph (API format), matching the
 * bundled music_generation.json: split UNET/CLIP/VAE loaders,
 * ModelSamplingAuraFlow(shift 3), 8-step euler/simple turbo KSampler,
 * TextEncodeAceStepAudio1.5 conditioning (tags + lyrics + bpm + key + time
 * signature + language) with a zeroed-out negative, VAEDecodeAudio, and an
 * MP3 save. Instrumental = empty lyrics.
 */
export function buildAceStepWorkflow({
  tags,
  lyrics = '',
  durationSeconds = 30,
  seed = 0,
  bpm = 120,
  keyScale = 'C major',
  timeSignature = '4',
  language = 'en',
} = {}) {
  const safeTags = String(tags || '').trim()
  const safeLyrics = String(lyrics || '')
  const seconds = normalizeMusicDuration(durationSeconds)
  const safeSeed = Number.isFinite(Number(seed)) ? Math.abs(Math.floor(Number(seed))) : 0
  const safeBpm = normalizeMusicBpm(bpm)
  const safeKeyScale = MUSIC_KEY_SCALES.includes(String(keyScale)) ? String(keyScale) : 'C major'
  const safeTimeSignature = MUSIC_TIME_SIGNATURES.includes(String(timeSignature)) ? String(timeSignature) : '4'
  const safeLanguage = String(language || 'en').trim() || 'en'

  return {
    104: {
      class_type: 'UNETLoader',
      inputs: { unet_name: ACE_STEP_MODELS.diffusion, weight_dtype: 'default' },
    },
    105: {
      class_type: 'DualCLIPLoader',
      inputs: {
        clip_name1: ACE_STEP_MODELS.clip1,
        clip_name2: ACE_STEP_MODELS.clip2,
        type: 'ace',
        device: 'default',
      },
    },
    106: {
      class_type: 'VAELoader',
      inputs: { vae_name: ACE_STEP_MODELS.vae },
    },
    78: {
      class_type: 'ModelSamplingAuraFlow',
      inputs: { shift: 3, model: ['104', 0] },
    },
    94: {
      class_type: 'TextEncodeAceStepAudio1.5',
      inputs: {
        generate_audio_codes: true,
        top_k: 0,
        top_p: 0.9,
        temperature: 1,
        cfg_scale: 1,
        min_p: 0,
        tags: safeTags,
        lyrics: safeLyrics,
        seed: safeSeed,
        bpm: safeBpm,
        duration: seconds,
        timesignature: safeTimeSignature,
        language: safeLanguage,
        keyscale: safeKeyScale,
        clip: ['105', 0],
      },
    },
    47: {
      class_type: 'ConditioningZeroOut',
      inputs: { conditioning: ['94', 0] },
    },
    98: {
      class_type: 'EmptyAceStep1.5LatentAudio',
      inputs: { seconds, batch_size: 1 },
    },
    3: {
      class_type: 'KSampler',
      inputs: {
        model: ['78', 0],
        positive: ['94', 0],
        negative: ['47', 0],
        latent_image: ['98', 0],
        seed: safeSeed,
        steps: 8,
        cfg: 1,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
      },
    },
    18: {
      class_type: 'VAEDecodeAudio',
      inputs: { samples: ['3', 0], vae: ['106', 0] },
    },
    107: {
      class_type: 'SaveAudioMP3',
      inputs: {
        filename_prefix: 'audio/velorn_music_ace',
        quality: 'V0',
        audioUI: '',
        audio: ['18', 0],
      },
    },
  }
}

function ensureGeneratedMusicFolder() {
  const { folders = [], addFolder } = useAssetsStore.getState()
  if (typeof addFolder !== 'function') return null
  let parentId = null
  for (const segment of GENERATED_MUSIC_FOLDER) {
    const key = segment.toLowerCase()
    const currentFolders = useAssetsStore.getState().folders || folders
    let folder = currentFolders.find((entry) => (
      (entry?.parentId || null) === parentId
      && String(entry?.name || '').trim().toLowerCase() === key
    ))
    if (!folder) folder = addFolder({ name: segment, parentId })
    parentId = folder?.id || parentId
  }
  return parentId
}

function collectAudioOutputs(historyEntry) {
  const outputs = historyEntry?.outputs || {}
  const results = []
  for (const nodeId of Object.keys(outputs)) {
    const nodeOut = outputs[nodeId]
    if (!nodeOut || typeof nodeOut !== 'object') continue
    for (const key of Object.keys(nodeOut)) {
      const entries = nodeOut[key]
      if (!Array.isArray(entries)) continue
      for (const item of entries) {
        const filename = item?.filename || item?.file || item?.name
        if (!filename || !AUDIO_EXT_RE.test(filename)) continue
        if (String(item?.type || 'output').toLowerCase() !== 'output') continue
        results.push({
          nodeId: String(nodeId),
          filename,
          subfolder: item.subfolder || '',
          type: item.type || 'output',
        })
      }
    }
  }
  return results
}

function findExistingImport(promptId, file) {
  const { assets = [] } = useAssetsStore.getState()
  return assets.find((asset) => (
    asset
    && String(asset.promptId || '').trim() === String(promptId || '').trim()
    && String(asset.sourceFilename || '').toLowerCase() === String(file.filename || '').toLowerCase()
  )) || null
}

async function importMusicOutput(promptId, file, params) {
  const existing = findExistingImport(promptId, file)
  if (existing) return existing

  const folderId = ensureGeneratedMusicFolder()
  const url = comfyui.getMediaUrl(file.filename, file.subfolder || '', file.type || 'output')
  const { addAsset } = useAssetsStore.getState()
  const projectDir = useProjectStore.getState?.()?.currentProjectHandle || null

  const sourceFields = {
    source: 'comfyui-auto-import',
    promptId,
    sourceNodeId: file.nodeId,
    sourceFilename: file.filename,
    sourceSubfolder: file.subfolder || '',
    sourceOutputType: file.type || 'output',
    generatedMusic: {
      tags: params?.tags || '',
      lyrics: params?.lyrics || '',
      durationSeconds: params?.durationSeconds || null,
      seed: params?.seed ?? null,
      bpm: params?.bpm ?? null,
      keyScale: params?.keyScale || null,
      timeSignature: params?.timeSignature || null,
    },
  }
  const displayName = `Music ${String(params?.tags || '').slice(0, 40) || 'ACE-Step'} (${file.filename})`

  let blobFile = null
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`)
    const blob = await response.blob()
    blobFile = new File([blob], file.filename, { type: blob.type || 'audio/mpeg' })
  } catch (err) {
    // Register the direct /view URL so the take is still usable.
    return addAsset({
      name: displayName,
      type: 'audio',
      url,
      folderId,
      isImported: true,
      ...sourceFields,
    })
  }

  if (projectDir) {
    try {
      const assetInfo = await importAsset(projectDir, blobFile, 'audio')
      return addAsset({
        ...assetInfo,
        name: displayName,
        type: 'audio',
        url: URL.createObjectURL(blobFile),
        folderId,
        isImported: true,
        ...sourceFields,
      })
    } catch (err) {
      console.warn('[musicGeneration] importAsset failed, using blob URL:', err?.message || err)
    }
  }

  return addAsset({
    name: displayName,
    type: 'audio',
    url: URL.createObjectURL(blobFile),
    folderId,
    isImported: true,
    ...sourceFields,
  })
}

async function pollJobs() {
  const pending = [...musicJobs.values()].filter((job) => job.status === 'queued' || job.status === 'running')
  if (pending.length === 0) {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    return
  }

  for (const job of pending) {
    try {
      if (Date.now() - job.createdAt > JOB_TIMEOUT_MS) {
        job.status = 'failed'
        job.error = 'Music generation timed out.'
        continue
      }
      const history = await comfyui.getHistory(job.promptId)
      const entry = history?.[job.promptId]
      if (!entry) {
        job.status = 'running'
        continue
      }
      const statusStr = String(entry?.status?.status_str || '').toLowerCase()
      if (statusStr === 'error') {
        const messages = Array.isArray(entry?.status?.messages) ? entry.status.messages : []
        const errorDetail = messages
          .filter((message) => Array.isArray(message) && String(message[0] || '').includes('error'))
          .map((message) => message?.[1]?.exception_message || '')
          .filter(Boolean)
          .join('; ')
        job.status = 'failed'
        job.error = errorDetail || 'ComfyUI reported an execution error.'
        continue
      }
      const audioFiles = collectAudioOutputs(entry)
      if (audioFiles.length === 0) continue

      const assetIds = []
      for (const file of audioFiles) {
        const asset = await importMusicOutput(job.promptId, file, job.params)
        if (asset?.id) assetIds.push(asset.id)
      }
      job.status = 'completed'
      job.assetIds = assetIds
    } catch (err) {
      // Transient (ComfyUI restarting, network) — keep polling until timeout.
      if (Date.now() - job.createdAt > JOB_TIMEOUT_MS) {
        job.status = 'failed'
        job.error = err?.message || 'Music generation failed.'
      }
    }
  }
  notifyJobsUpdated()
}

function ensurePolling() {
  if (pollTimer) return
  pollTimer = setInterval(pollJobs, POLL_INTERVAL_MS)
}

/**
 * Queue one or more ACE-Step music generations.
 * Returns the created job records (status 'queued').
 */
export async function queueMusicGeneration({
  tags,
  lyrics = '',
  instrumental = false,
  durationSeconds = 30,
  variations = 1,
  seed = null,
  bpm = 120,
  keyScale = 'C major',
  timeSignature = '4',
  language = 'en',
} = {}) {
  const safeTags = String(tags || '').trim()
  if (!safeTags) throw new Error('Provide style tags for the music (e.g. "warm lo-fi hip hop, mellow keys, 85 bpm").')

  const safeLyrics = instrumental ? '' : String(lyrics || '').trim()
  const count = clamp(Math.round(Number(variations) || 1), 1, MUSIC_VARIATIONS_MAX)
  const baseSeed = Number.isFinite(Number(seed))
    ? Math.abs(Math.floor(Number(seed)))
    : Math.floor(Math.random() * 2 ** 32)

  const jobs = []
  for (let index = 0; index < count; index += 1) {
    const jobSeed = baseSeed + index
    const params = {
      tags: safeTags,
      lyrics: safeLyrics,
      durationSeconds: normalizeMusicDuration(durationSeconds),
      seed: jobSeed,
      bpm: normalizeMusicBpm(bpm),
      keyScale,
      timeSignature,
      language,
    }
    const workflow = buildAceStepWorkflow(params)
    const promptId = await comfyui.queuePrompt(workflow)
    markPromptHandledByApp(promptId)
    const job = {
      promptId,
      status: 'queued',
      params,
      seed: jobSeed,
      error: null,
      assetIds: [],
      createdAt: Date.now(),
    }
    musicJobs.set(promptId, job)
    jobs.push(job)
  }

  ensurePolling()
  notifyJobsUpdated()
  return jobs.map(summarizeMusicJob)
}

export function summarizeMusicJob(job) {
  if (!job) return null
  return {
    promptId: job.promptId,
    status: job.status,
    seed: job.seed,
    tags: job.params?.tags || '',
    lyrics: job.params?.lyrics || '',
    durationSeconds: job.params?.durationSeconds || null,
    bpm: job.params?.bpm ?? null,
    keyScale: job.params?.keyScale || null,
    timeSignature: job.params?.timeSignature || null,
    error: job.error || null,
    assetIds: [...(job.assetIds || [])],
  }
}

export function getMusicJobs(promptIds = null) {
  const wanted = Array.isArray(promptIds) && promptIds.length > 0
    ? new Set(promptIds.map((id) => String(id || '').trim()))
    : null
  return [...musicJobs.values()]
    .filter((job) => !wanted || wanted.has(String(job.promptId)))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(summarizeMusicJob)
}

/**
 * Force one poll pass now (used by MCP status checks so agents don't have to
 * wait out the interval).
 */
export async function refreshMusicJobs() {
  await pollJobs()
  return getMusicJobs()
}

/**
 * Check whether the ACE-Step 1.5 model files are installed in the connected
 * ComfyUI, via the shared 'music-gen' workflow dependency check.
 * Returns the raw dependency-check result (status, missingModels, ...) that
 * useWorkflowSetupFlow consumes, or null on failure.
 */
export async function checkMusicModelDependencies() {
  try {
    return await checkWorkflowDependencies(MUSIC_WORKFLOW_ID)
  } catch (_) {
    return null
  }
}
