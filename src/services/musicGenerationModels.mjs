/**
 * Pure, shared music-model contracts used by the timeline, Generate and MCP.
 * Keep the legacy music-gen workflow identity assigned to ACE-Step: saved and
 * unfinished jobs must never silently resume on a different model.
 */
export const ACE_STEP_MODELS = Object.freeze({
  diffusion: 'acestep_v1.5_turbo.safetensors',
  vae: 'ace_1.5_vae.safetensors',
  clip1: 'qwen_0.6b_ace15.safetensors',
  clip2: 'qwen_1.7b_ace15.safetensors',
})

export const YUE2_MODEL = 'yue2_3b_int8_convrot.safetensors'
export const MUSIC_DURATION_MIN = 5
export const MUSIC_DURATION_MAX = 240
// Automatic is bounded, not infinite. Keep ACE-Step's old exact-length range.
export const YUE2_AUTOMATIC_DURATION = 360
export const YUE2_CUSTOM_DURATION_MAX = 360
export const MUSIC_VARIATIONS_MAX = 4
export const MUSIC_BPM_MIN = 40
export const MUSIC_BPM_MAX = 220
export const MUSIC_TIME_SIGNATURES = Object.freeze(['2', '3', '4', '6'])
export const MUSIC_KEY_SCALES = Object.freeze([
  'C major', 'G major', 'D major', 'A major', 'E major', 'F major',
  'A minor', 'E minor', 'B minor', 'D minor', 'C minor', 'F minor',
])

export const MUSIC_BACKENDS = Object.freeze([
  Object.freeze({
    id: 'yue2',
    label: 'YuE2',
    workflowId: 'music-gen-yue2',
    durationMode: 'maximum',
    modelFiles: Object.freeze([YUE2_MODEL]),
    outputNodeId: '107',
  }),
  Object.freeze({
    id: 'ace-step',
    label: 'ACE-Step',
    workflowId: 'music-gen',
    durationMode: 'exact',
    modelFiles: Object.freeze(Object.values(ACE_STEP_MODELS)),
    outputNodeId: '107',
  }),
])

/** Omitted model selections are old ACE-Step jobs, not the new UI default. */
export function normalizeMusicBackend(value) {
  if (value === undefined || value === null || value === '') return 'ace-step'
  if (typeof value !== 'string' || !MUSIC_BACKENDS.some(({ id }) => id === value)) {
    throw new Error(`Unknown music model: ${String(value)}. Choose yue2 or ace-step.`)
  }
  return value
}

export function getMusicBackend(value) {
  const id = normalizeMusicBackend(value)
  return MUSIC_BACKENDS.find((backend) => backend.id === id)
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

// Keep ACE-Step's existing exact-duration range. YuE2 uses resolveMusicLength
// instead, with its own optional maximum and Automatic safety ceiling.
export function normalizeMusicDuration(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 30
  return clamp(Math.round(parsed), MUSIC_DURATION_MIN, MUSIC_DURATION_MAX)
}

/** Resolve the selected policy once before queueing. Old callers supplying an
 * explicit YuE2 duration retain a custom ceiling; omission means Automatic.
 * Remembered custom seconds do not override an explicit Automatic selection.
 */
export function resolveMusicLength({ backend, durationSeconds, lengthMode } = {}) {
  const model = getMusicBackend(backend)
  if (model.id === 'ace-step') {
    if (lengthMode !== undefined && lengthMode !== 'exact') throw new Error('Automatic/custom song length is available for YuE2 only.')
    return { lengthMode: 'exact', durationSeconds: normalizeMusicDuration(durationSeconds) }
  }
  const mode = lengthMode === undefined ? (durationSeconds === undefined ? 'automatic' : 'custom') : lengthMode
  if (!['automatic', 'custom'].includes(mode)) throw new Error('Choose automatic or custom song length for YuE2.')
  if (mode === 'automatic') return { lengthMode: mode, durationSeconds: YUE2_AUTOMATIC_DURATION }
  const parsed = Number(durationSeconds)
  return { lengthMode: mode, durationSeconds: Number.isFinite(parsed)
    ? clamp(Math.round(parsed), MUSIC_DURATION_MIN, YUE2_CUSTOM_DURATION_MAX) : 30 }
}

/** ComfyUI's standard audio saver does not expose the model's EOS/truncation
 * flag. Warn from measured length, but never label a shorter file as a verified
 * musical ending. No waveform trimming, fading, retry or extra generation.
 */
export function getMusicCompletion(params = {}, measuredSeconds) {
  if (getMusicBackend(params.backend).id !== 'yue2') return {
    status: 'not-applicable', basis: 'none', limitSeconds: null,
    warning: null, naturalEndingVerified: false, truncated: null,
  }
  const { durationSeconds: limitSeconds } = resolveMusicLength(params)
  const measured = Number(measuredSeconds)
  const reached = Number.isFinite(measured) && measured > 0 && measured >= limitSeconds - 0.15
  return {
    status: reached ? 'limit-reached' : 'unknown',
    basis: reached ? 'measured-duration' : 'none',
    limitSeconds, naturalEndingVerified: false, truncated: null,
    warning: reached ? `This take is at the ${limitSeconds}-second limit and may be unfinished. Listen to the ending.` : null,
  }
}

export function normalizeMusicBpm(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 120
  return clamp(Math.round(parsed), MUSIC_BPM_MIN, MUSIC_BPM_MAX)
}

function normalizeWorkflowSeed(value) {
  return Number.isFinite(Number(value)) ? Math.abs(Math.floor(Number(value))) : 0
}

/** The existing ACE-Step 1.5 turbo graph, including its stable node IDs. */
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
  const safeSeed = normalizeWorkflowSeed(seed)
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

/**
 * Native ComfyUI YuE2 full-planning graph. The bundled checkpoint contains
 * MODEL, CLIP and VAE; no third-party node pack is required.
 *
 * Instrumental is a prompt instruction, not a guaranteed model mode. YuE2 can
 * finish before max_duration, so the latent MUST use its returned seconds.
 */
export function buildYue2Workflow({
  tags,
  lyrics = '',
  instrumental = false,
  durationSeconds,
  lengthMode,
  seed = 0,
} = {}) {
  const safeTags = String(tags || '').trim()
  const style = instrumental
    ? `Instrumental music only, no vocals or singing. ${safeTags}`.trim()
    : safeTags
  const safeLyrics = instrumental ? '' : String(lyrics || '')
  const safeSeed = normalizeWorkflowSeed(seed)

  return {
    104: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: YUE2_MODEL },
    },
    94: {
      class_type: 'YuE2GenerateABC',
      inputs: {
        clip: ['104', 1],
        style,
        lyrics: safeLyrics,
        seed: safeSeed,
        mode: 'full',
        max_abc_tokens: 8192,
        temperature: 0.7,
        top_p: 0.9,
        top_k: 30,
        repetition_penalty: 1.005,
        penalty_window: 100,
      },
    },
    95: {
      class_type: 'YuE2GenerateMusic',
      inputs: {
        clip: ['104', 1],
        style,
        lyrics: safeLyrics,
        abc: ['94', 0],
        seed: safeSeed,
        mode: 'full',
        max_duration: resolveMusicLength({ backend: 'yue2', durationSeconds, lengthMode }).durationSeconds,
        temperature: 1,
        top_p: 0.95,
        top_k: 100,
        repetition_penalty: 1.2,
      },
    },
    47: {
      class_type: 'ConditioningZeroOut',
      inputs: { conditioning: ['95', 0] },
    },
    98: {
      class_type: 'EmptyYuE2LatentAudio',
      inputs: { seconds: ['95', 1], batch_size: 1 },
    },
    3: {
      class_type: 'KSampler',
      inputs: {
        model: ['104', 0],
        positive: ['95', 0],
        negative: ['47', 0],
        latent_image: ['98', 0],
        seed: safeSeed,
        steps: 32,
        cfg: 1,
        sampler_name: 'dpm_2',
        scheduler: 'sgm_uniform',
        denoise: 1,
      },
    },
    18: {
      class_type: 'VAEDecodeAudio',
      inputs: { samples: ['3', 0], vae: ['104', 2] },
    },
    107: {
      class_type: 'SaveAudioAdvanced',
      inputs: {
        filename_prefix: 'audio/velorn_music_yue2',
        format: 'flac',
        audio: ['18', 0],
      },
    },
  }
}
