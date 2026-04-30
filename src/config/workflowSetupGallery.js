/**
 * Visual metadata for Workflow Setup (gallery cards).
 * Thumbnails are optional; gradients + icons provide a Comfy-like card feel without assets.
 */
import { ALL_WORKFLOWS, getBundledWorkflowPath } from './workflowRegistry'
import { TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID } from './topazVideoUpscaleConfig'
import { MUSIC_VIDEO_SHOT_WORKFLOW_ID, VOCAL_EXTRACT_WORKFLOW_ID } from './musicVideoShotConfig'

function coverPath(filename) {
  return getBundledWorkflowPath(`setup-covers/${filename}`)
}

const CLOUD_WORKFLOW_IDS = new Set([
  'kling-o3-i2v',
  'grok-video-i2v',
  'vidu-q2-i2v',
  TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID,
  'nano-banana-2',
  'grok-text-to-image',
  'seedream-5-lite-image-edit',
  'google-gemini-flash-lite',
])

/** @type {Record<string, { gradient: string, icon: string, thumbnailSrc?: string, extraBadges?: string[] }>} */
const VISUAL_BY_WORKFLOW_ID = {
  'wan22-i2v': {
    gradient: 'from-violet-500/35 via-indigo-900/30 to-sf-dark-950',
    icon: 'film',
    extraBadges: ['I2V'],
    thumbnailSrc: coverPath('wan22-i2v.webp'),
  },
  'ltx23-i2v': {
    gradient: 'from-sky-500/30 via-blue-900/25 to-sf-dark-950',
    icon: 'film',
    extraBadges: ['I2V'],
    thumbnailSrc: coverPath('ltx23-i2v.webp'),
  },
  'kling-o3-i2v': {
    gradient: 'from-amber-500/25 via-orange-900/20 to-sf-dark-950',
    icon: 'cloud',
    extraBadges: ['I2V'],
    thumbnailSrc: coverPath('kling-o3-i2v.webp'),
  },
  'grok-video-i2v': {
    gradient: 'from-zinc-400/20 via-neutral-800/40 to-sf-dark-950',
    icon: 'cloud',
    extraBadges: ['I2V'],
    thumbnailSrc: coverPath('grok-video-i2v.webp'),
  },
  'vidu-q2-i2v': {
    gradient: 'from-cyan-500/25 via-teal-900/20 to-sf-dark-950',
    icon: 'cloud',
    extraBadges: ['I2V'],
    thumbnailSrc: coverPath('vidu-q2-i2v.webp'),
  },
  [TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID]: {
    gradient: 'from-amber-500/25 via-yellow-900/20 to-sf-dark-950',
    icon: 'cloud',
    extraBadges: ['Upscale'],
  },
  [MUSIC_VIDEO_SHOT_WORKFLOW_ID]: {
    gradient: 'from-pink-500/25 via-purple-900/25 to-sf-dark-950',
    icon: 'music',
    extraBadges: ['I2V', 'Lip-sync', 'Director Mode'],
  },
  [VOCAL_EXTRACT_WORKFLOW_ID]: {
    gradient: 'from-teal-500/25 via-cyan-900/25 to-sf-dark-950',
    icon: 'music',
    extraBadges: ['Preprocess', 'Vocal stem'],
  },
  'caption-qwen-asr': {
    gradient: 'from-blue-500/25 via-indigo-900/25 to-sf-dark-950',
    icon: 'music',
    extraBadges: ['ASR', 'SRT', 'Captions'],
  },
  'multi-angles': {
    gradient: 'from-fuchsia-500/25 via-purple-900/25 to-sf-dark-950',
    icon: 'users',
    extraBadges: ['Multi-shot'],
    thumbnailSrc: coverPath('multi-angles.webp'),
  },
  'multi-angles-scene': {
    gradient: 'from-rose-500/25 via-pink-900/20 to-sf-dark-950',
    icon: 'layers',
    extraBadges: ['Multi-shot'],
    thumbnailSrc: coverPath('multi-angles-scene.webp'),
  },
  'image-edit': {
    gradient: 'from-emerald-500/25 via-green-900/20 to-sf-dark-950',
    icon: 'image',
    extraBadges: ['Edit'],
    thumbnailSrc: coverPath('image-edit.webp'),
  },
  'image-edit-model-product': {
    gradient: 'from-emerald-500/25 via-green-900/20 to-sf-dark-950',
    icon: 'image',
    extraBadges: ['Edit', 'Model+Product'],
    thumbnailSrc: coverPath('image-edit.webp'),
  },
  'z-image-turbo': {
    gradient: 'from-lime-500/20 via-emerald-900/25 to-sf-dark-950',
    icon: 'sparkles',
    extraBadges: ['T2I'],
    thumbnailSrc: coverPath('z-image-turbo.webp'),
  },
  'nano-banana-2': {
    gradient: 'from-yellow-500/20 via-amber-900/25 to-sf-dark-950',
    icon: 'cloud',
    extraBadges: ['T2I'],
    thumbnailSrc: coverPath('nano-banana-2.webp'),
  },
  'grok-text-to-image': {
    gradient: 'from-stone-400/15 via-neutral-800/35 to-sf-dark-950',
    icon: 'cloud',
    extraBadges: ['T2I'],
    thumbnailSrc: coverPath('grok-text-to-image.webp'),
  },
  'seedream-5-lite-image-edit': {
    gradient: 'from-orange-500/25 via-red-900/15 to-sf-dark-950',
    icon: 'cloud',
    extraBadges: ['Edit'],
    thumbnailSrc: coverPath('seedream-5-lite-image-edit.webp'),
  },
  'music-gen': {
    gradient: 'from-indigo-500/30 via-violet-900/30 to-sf-dark-950',
    icon: 'music',
    extraBadges: ['Audio'],
    thumbnailSrc: coverPath('music-gen.webp'),
  },
  'google-gemini-flash-lite': {
    gradient: 'from-sky-500/20 via-cyan-900/20 to-sf-dark-950',
    icon: 'cloud',
    extraBadges: ['Prompt'],
  },
  'mask-gen': {
    gradient: 'from-purple-500/30 via-violet-900/25 to-sf-dark-950',
    icon: 'scanline',
    extraBadges: ['SAM3'],
    thumbnailSrc: coverPath('mask-gen.png'),
    invertColors: true,
  },
}

/**
 * Longer-form copy shown when a card is expanded. Curated per workflow so users
 * get a clear "what does this do / when do I use it" brief.
 */
const LONG_DESCRIPTIONS = {
  'wan22-i2v': 'Runs locally with the WAN 2.2 14B image-to-video model. Give it a still frame and a short prompt and it produces a short animated clip. Best overall quality of the local image-to-video options, but it is the heaviest download.',
  'ltx23-i2v': 'Fast local image-to-video using LTX 2.3. Good for quick iterations and lighter GPUs. Lower fidelity than WAN 2.2 but much faster to generate, and it keeps everything on your machine.',
  'kling-o3-i2v': 'Cloud image-to-video using the Kling 3.0 Omni model via the Comfy Partner API. Premium quality motion and coherence, especially for people and characters. Requires a Comfy Partner API key and credits.',
  'grok-video-i2v': 'Cloud image-to-video powered by xAI Grok Imagine Video (Beta). Strong at stylised and cinematic shots. Requires a Grok / Comfy Partner API key.',
  'vidu-q2-i2v': 'Cloud image-to-video with Vidu Q2 Pro Fast. Tuned for quick turnaround and consistent character motion. Requires a Comfy Partner API key.',
  [TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID]: 'Cloud video upscaling with Topaz Video Enhance. Feed it an existing video clip and upscale it with Starlight Precise 2.5 or the Astra variants. Requires a Comfy Partner API key.',
  [MUSIC_VIDEO_SHOT_WORKFLOW_ID]: 'Per-shot music video generator built on LTX 2.3 22B. Takes a reference still and an audio segment and produces a lip-synced shot. Used by Director Mode to render an entire music video one shot at a time. Heavy local workflow — needs a 24GB+ GPU and the LTX 2.3 model stack.',
  [VOCAL_EXTRACT_WORKFLOW_ID]: 'One-time preprocessing workflow that isolates vocals from a mixed song using Mel-Band RoFormer. Runs once when you import a song into a music-video project, so every shot afterward can be conditioned on clean vocals without re-running separation each time.',
  'caption-qwen-asr': 'Local caption and timed-lyrics transcription using Qwen ASR through TTS-Audio-Suite. Used by the timeline caption tool and by Music Video\'s "Transcribe to SRT" button to generate timestamped lyrics before building the director script.',
  'multi-angles': 'One-click character turnaround. Give it one character image and it generates 8 matching camera angles so you can build consistent shot sheets or look-dev reference sets.',
  'multi-angles-scene': 'Same idea as the character turnaround, but for environments and scenes. Produces 8 camera angles of a single scene image for coverage, storyboards, or establishing shots.',
  'image-edit': 'Local image editing with Qwen Image Edit 2509. Paint a mask (or describe the change) and apply targeted text-prompted edits to a still image while keeping the rest intact.',
  'image-edit-model-product': 'Specialised Qwen Image Edit graph for putting a product onto a model, or swapping a model/product while keeping the other element anchored. Great for e-commerce mockups.',
  'z-image-turbo': 'Local text-to-image using Z Image Turbo. Extremely fast single-image generation — a good default for quick ideation and for producing reference frames to feed into the image-to-video workflows.',
  'nano-banana-2': 'Cloud text-to-image using Google Nano Banana 2 via the Comfy Partner API. Premium quality, great at typography and layout-heavy prompts. Requires an API key and credits.',
  'grok-text-to-image': 'Cloud text-to-image using xAI Grok Imagine (Beta). Strong stylistic range and text rendering. Requires a Grok / Comfy Partner API key.',
  'seedream-5-lite-image-edit': 'Cloud image edit using ByteDance Seedream 5.0 Lite. Lower cost per generation and a good fit for batch edits. Requires a Comfy Partner API key.',
  'music-gen': 'Local music generation with ACE-Step. Feed it a short tag list and optional lyrics and it produces a short musical clip you can drop straight into a timeline.',
  'google-gemini-flash-lite': 'Cloud prompt helper using Gemini 3.1 Flash Lite. Feed it a rough brief and optional image reference and it returns a cleaner, more descriptive prompt you can pass downstream into image or video generation. Requires a Comfy Partner API key.',
  'mask-gen': 'Text-prompted video/image masking using SAM 3 plus MatAnyone. Describe the subject you want isolated and it produces an alpha mask you can use for rotoscoping, replacement, or compositing.',
}

export const WORKFLOW_SETUP_STARTER_KITS = Object.freeze([
  Object.freeze({
    id: 'low-vram-local-video',
    label: 'Low VRAM Local Video',
    tagline: 'Fast local image and video experiments for consumer GPUs.',
    description: 'Start with lighter local workflows before moving to heavier 14B/22B video graphs.',
    workflowIds: Object.freeze(['z-image-turbo', 'ltx23-i2v', 'image-edit']),
  }),
  Object.freeze({
    id: 'best-local-quality',
    label: 'Best Local Quality',
    tagline: 'High-VRAM local workflows for stronger images, references, and motion.',
    description: 'Prepare the bigger local model stack when the machine has room for heavier downloads.',
    workflowIds: Object.freeze(['wan22-i2v', 'ltx23-i2v', 'image-edit', 'multi-angles', 'multi-angles-scene']),
  }),
  Object.freeze({
    id: 'cloud-quality',
    label: 'Cloud Quality',
    tagline: 'Premium video, image, and upscale workflows without relying on local VRAM.',
    description: 'Uses Comfy partner nodes and credits, but keeps the generated assets inside ComfyStudio.',
    workflowIds: Object.freeze(['kling-o3-i2v', 'vidu-q2-i2v', 'grok-video-i2v', 'nano-banana-2', 'grok-text-to-image', 'seedream-5-lite-image-edit', TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID]),
  }),
  Object.freeze({
    id: 'music-video-kit',
    label: 'Music Video Kit',
    tagline: 'Timed lyrics, vocal prep, and LTX audio-conditioned shot generation.',
    description: 'The fastest setup path for Director Mode music videos and lip-sync-oriented shot passes.',
    workflowIds: Object.freeze(['caption-qwen-asr', VOCAL_EXTRACT_WORKFLOW_ID, MUSIC_VIDEO_SHOT_WORKFLOW_ID, 'image-edit']),
  }),
])

function categoryBaseBadge(category) {
  switch (category) {
    case 'video':
      return 'Video'
    case 'image':
      return 'Image'
    case 'audio':
      return 'Audio'
    case 'text':
      return 'Text'
    default:
      return 'Workflow'
  }
}

export function findWorkflowRegistryEntry(workflowId = '') {
  const id = String(workflowId || '').trim()
  return ALL_WORKFLOWS.find((w) => w.id === id) || null
}

/**
 * @returns {{
 *   workflowId: string,
 *   label: string,
 *   description: string,
 *   longDescription: string,
 *   category: string,
 *   gradient: string,
 *   icon: string,
 *   thumbnailSrc: string,
 *   invertColors: boolean,
 *   badges: string[],
 *   runtime: 'local' | 'cloud'
 * }}
 */
export function getWorkflowSetupGalleryMeta(workflowId = '') {
  const id = String(workflowId || '').trim()
  const registry = findWorkflowRegistryEntry(id)
  const visual = VISUAL_BY_WORKFLOW_ID[id] || {
    gradient: 'from-slate-600/35 to-sf-dark-950',
    icon: 'boxes',
    extraBadges: [],
  }

  const runtime = CLOUD_WORKFLOW_IDS.has(id) ? 'cloud' : 'local'
  const category = registry?.category || 'image'
  const badges = [
    categoryBaseBadge(category),
    runtime === 'cloud' ? 'API' : 'Local',
    ...(Array.isArray(visual.extraBadges) ? visual.extraBadges : []),
  ]

  return {
    workflowId: id,
    label: registry?.label || id,
    description: registry?.description || '',
    longDescription: LONG_DESCRIPTIONS[id] || registry?.description || '',
    category,
    gradient: visual.gradient,
    icon: visual.icon,
    thumbnailSrc: typeof visual.thumbnailSrc === 'string' ? visual.thumbnailSrc : '',
    invertColors: Boolean(visual.invertColors),
    badges,
    runtime,
  }
}
