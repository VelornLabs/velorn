import { TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID } from './topazVideoUpscaleConfig'
import { MUSIC_VIDEO_SHOT_WORKFLOW_ID, VOCAL_EXTRACT_WORKFLOW_ID } from './musicVideoShotConfig'
import {
  ELEVENLABS_TTS_WORKFLOW_ID,
  SHORT_FILM_DIALOGUE_VIDEO_WORKFLOW_ID,
} from './shortFilmConfig'

export const SHOT_CATEGORIES = {
  Shot: ['Extreme close-up', 'Close-up', 'Medium close-up', 'Medium shot', 'Medium wide', 'Wide shot', 'Extreme wide', 'Over-the-shoulder', 'POV', 'Two-shot', 'Insert shot'],
  Movement: ['Static', 'Pan', 'Tilt', 'Dolly in', 'Dolly out', 'Push in', 'Pull out', 'Tracking shot', 'Crane shot', 'Steadicam', 'Handheld', 'Drone', 'Aerial', 'Orbit', 'Whip pan'],
  Angle: ['Eye level', 'Low angle', 'High angle', "Bird's eye", 'Overhead', "Worm's eye", 'Dutch angle'],
  Lighting: ['Natural light', 'Golden hour', 'Blue hour', 'High key', 'Low key', 'Dramatic lighting', 'Cinematic lighting', 'Soft lighting', 'Hard lighting', 'Backlit', 'Silhouette', 'Rim lighting', 'Neon', 'Candlelit', 'Moonlit'],
  Mood: ['Cinematic', 'Dramatic', 'Epic', 'Intimate', 'Mysterious', 'Tense', 'Suspenseful', 'Romantic', 'Melancholic', 'Energetic', 'Serene', 'Ethereal', 'Dark'],
  Style: ['Film noir', 'Documentary', 'Commercial', 'Music video', 'Blockbuster', 'Indie film', 'Vintage', 'Retro', 'Sci-fi', 'Fantasy', 'Horror', 'Western'],
  Color: ['Desaturated', 'High contrast', 'Warm tones', 'Cool tones', 'Teal and orange', 'Black and white', 'Vibrant', 'Muted', 'Neon colors'],
  Speed: ['Slow motion', 'Real-time', 'Fast motion', 'Time-lapse', 'Hyperlapse'],
  Depth: ['Shallow DOF', 'Bokeh', 'Deep focus', 'Rack focus'],
  Lens: ['Anamorphic', 'Wide angle', 'Telephoto', 'Fisheye', 'Macro', '35mm film look'],
}

export const CATEGORY_ORDER = ['Shot', 'Movement', 'Angle', 'Lighting', 'Mood', 'Style', 'Color', 'Speed', 'Depth', 'Lens']

export const CUSTOM_GENERATE_IMAGE_WORKFLOW_ID = 'custom-generate-image'
export const CUSTOM_GENERATE_VIDEO_WORKFLOW_ID = 'custom-generate-video'

export const WORKFLOWS = {
  video: [
    { id: CUSTOM_GENERATE_VIDEO_WORKFLOW_ID, label: 'Custom Video Workflow', needsImage: false, description: 'Run your own ComfyUI video graph from Generate' },
    { id: 'ltx23-i2v', label: 'Image to Video (LTX 2.3)', needsImage: true, description: 'Animate an image with local LTX 2.3' },
    { id: 'ltx23-ia2v', label: 'Image + Audio to Video (LTX 2.3)', needsImage: true, description: 'Animate an image with local LTX 2.3 audio conditioning' },
    { id: 'ltx23-t2v', label: 'Text to Video (LTX 2.3)', needsImage: false, description: 'Generate video from text with local LTX 2.3' },
    { id: 'wan22-i2v', label: 'Image to Video (WAN 2.2)', needsImage: true, description: 'Animate an image into video' },
    { id: 'wan22-t2v', label: 'Text to Video (WAN 2.2)', needsImage: false, description: 'Generate video from text with local WAN 2.2' },
    { id: 'frame-interpolation', label: 'Frame Interpolation', needsImage: true, description: 'Add in-between frames to smooth video motion' },
    { id: 'kling-o3-i2v', label: 'Image to Video (Kling O3 Omni)', needsImage: true, description: 'Premium image-to-video with Kling 3.0 Omni' },
    { id: 'grok-video-i2v', label: 'Image to Video (Grok Imagine Video)', needsImage: true, description: 'Cloud image-to-video with Grok Imagine Video Beta' },
    { id: 'vidu-q2-i2v', label: 'Image to Video (Vidu Q2)', needsImage: true, description: 'Cloud image-to-video with Vidu Q2 Pro Fast' },
    { id: 'seedance2-t2v', label: 'Text to Video (Seedance 2.0)', needsImage: false, description: 'Cloud text-to-video with ByteDance Seedance 2.0' },
    { id: 'seedance2-flf2v', label: 'First/Last Frame to Video (Seedance 2.0)', needsImage: false, description: 'Cloud first/last-frame video with ByteDance Seedance 2.0' },
    { id: 'seedance2-r2v', label: 'Reference to Video (Seedance 2.0)', needsImage: false, description: 'Cloud multi-reference video with ByteDance Seedance 2.0' },
    { id: TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID, label: 'Topaz Video Enhance', needsImage: false, description: 'Cloud video upscaling and enhancement' },
  ],
  image: [
    { id: CUSTOM_GENERATE_IMAGE_WORKFLOW_ID, label: 'Custom Image Workflow', needsImage: false, description: 'Run your own ComfyUI image graph from Generate' },
    { id: 'z-image-turbo', label: 'Text to Image (Z Image Turbo)', needsImage: false, description: 'Generate image from text prompt using Z Image Turbo' },
    { id: 'longcat-text-to-image', label: 'Text to Image (LongCat)', needsImage: false, description: 'Generate image with local LongCat' },
    { id: 'ernie-image-turbo', label: 'Text to Image (Ernie Turbo)', needsImage: false, description: 'Generate image with local Ernie Image Turbo' },
    { id: 'flux2-text-to-image', label: 'Text to Image (Flux 2)', needsImage: false, description: 'Generate image with local Flux 2' },
    { id: 'nano-banana-2', label: 'Nano Banana 2 Image Edit (Cloud)', needsImage: false, description: 'Cloud image generation and reference editing with Nano Banana 2' },
    { id: 'gpt-image-2-t2i', label: 'Text to Image (GPT Image 2)', needsImage: false, description: 'Cloud text-to-image with OpenAI GPT Image 2' },
    { id: 'gpt-image-2-edit', label: 'Image Edit (GPT Image 2)', needsImage: true, description: 'Cloud image edit with OpenAI GPT Image 2' },
    { id: 'grok-text-to-image', label: 'Text to Image (Grok Imagine)', needsImage: false, description: 'Cloud text-to-image using Grok Imagine Image Beta' },
    { id: 'seedream-5-lite-image-edit', label: 'Image Edit (Seedream 5.0 Lite)', needsImage: true, description: 'Cloud image edit with ByteDance Seedream 5.0 Lite' },
    { id: 'multi-angles', label: 'Multiple Angles (Characters)', needsImage: true, description: 'Generate 8 camera angles from one character image' },
    { id: 'multi-angles-scene', label: 'Multiple Angles (Scenes)', needsImage: true, description: 'Generate 8 camera angles from one scene image' },
    { id: 'image-edit', label: 'Image Edit', needsImage: true, description: 'Edit image with text prompt (e.g. remove person on left, change color of car)' },
    { id: 'longcat-image-edit', label: 'LongCat Image Edit', needsImage: true, description: 'Edit image with local LongCat' },
  ],
  audio: [
    { id: 'music-gen', label: 'Music Generation', needsImage: false, description: 'Generate music from tags and lyrics' },
    { id: 'sonilo-v2m', label: 'Video to Music (Sonilo)', needsImage: true, description: 'Cloud video-to-music generation with Sonilo' },
  ],
}

export const DIRECTOR_MODE_BETA_LABEL = 'Director Mode beta'

export const YOLO_AD_PROFILE_RUNTIME_OPTIONS = Object.freeze([
  {
    id: 'local',
    label: 'Local',
    description: 'Run local ComfyUI workflows on your own GPU hardware.',
  },
  {
    id: 'cloud',
    label: 'Cloud',
    description: 'Run paid partner-node APIs (credit-based) for cloud inference.',
  },
])

export const YOLO_AD_PROFILES = Object.freeze({
  local: Object.freeze({
    low: Object.freeze({
      storyboardWorkflowId: 'image-edit-model-product',
      videoWorkflowId: 'ltx23-i2v',
    }),
    quality: Object.freeze({
      storyboardWorkflowId: 'image-edit-model-product',
      videoWorkflowId: 'ltx23-i2v',
    }),
  }),
  cloud: Object.freeze({
    low: Object.freeze({
      storyboardWorkflowId: 'seedream-5-lite-image-edit',
      videoWorkflowId: 'vidu-q2-i2v',
    }),
    quality: Object.freeze({
      storyboardWorkflowId: 'nano-banana-2',
      videoWorkflowId: 'grok-video-i2v',
    }),
  }),
})

// Music Video defaults to an audio-conditioned per-shot LTX 2.3 workflow for
// vocal grounding. Alternate local i2v passes can be used for animation tests,
// but only the default music workflow consumes song audio for lip-sync.
export const YOLO_MUSIC_PROFILES = Object.freeze({
  draft: Object.freeze({
    storyboardWorkflowId: 'image-edit',
    videoWorkflowId: MUSIC_VIDEO_SHOT_WORKFLOW_ID,
  }),
  balanced: Object.freeze({
    storyboardWorkflowId: 'nano-banana-2',
    videoWorkflowId: MUSIC_VIDEO_SHOT_WORKFLOW_ID,
  }),
  premium: Object.freeze({
    storyboardWorkflowId: 'nano-banana-2',
    videoWorkflowId: MUSIC_VIDEO_SHOT_WORKFLOW_ID,
  }),
})

export const CUSTOM_MUSIC_KEYFRAME_WORKFLOW_ID = 'custom-music-keyframe'
export const CUSTOM_MUSIC_VIDEO_WORKFLOW_ID = 'custom-music-video'

export const YOLO_MUSIC_KEYFRAME_WORKFLOW_OPTIONS = Object.freeze([
  {
    id: 'image-edit',
    label: 'Qwen Image Edit',
    runtimeLabel: 'Local',
    description: 'Fully local keyframes using Qwen Image Edit 2509. Uses the resolved cast/reference image as the edit source.',
  },
  {
    id: 'nano-banana-2',
    label: 'Nano Banana 2',
    runtimeLabel: 'Cloud',
    description: 'Cloud keyframes with stronger reference-image and identity consistency.',
  },
  {
    id: CUSTOM_MUSIC_KEYFRAME_WORKFLOW_ID,
    label: 'Custom Workflow',
    runtimeLabel: 'Advanced',
    description: 'Use your own ComfyUI keyframe workflow as long as it keeps the ComfyStudio input/output endpoints.',
  },
])

export const YOLO_MUSIC_VIDEO_WORKFLOW_OPTIONS = Object.freeze([
  {
    id: MUSIC_VIDEO_SHOT_WORKFLOW_ID,
    label: 'LTX 2.3 Music',
    description: 'Default music-video pass. Uses the song timing/audio payload for performance and lip-sync shots.',
  },
  {
    id: 'wan22-i2v',
    label: 'WAN 2.2',
    description: 'Alternate image-to-video pass. Often gives stronger physical animation, but does not use song audio for lip-sync.',
  },
  {
    id: CUSTOM_MUSIC_VIDEO_WORKFLOW_ID,
    label: 'Custom Workflow',
    runtimeLabel: 'Advanced',
    description: 'Use your own ComfyUI video workflow as long as it keeps the ComfyStudio input/output endpoints.',
  },
])

export const VIDEO_DURATION_PRESETS = Object.freeze([2, 3, 5, 8])
export const LTX23_VIDEO_DURATION_PRESETS = Object.freeze([5, 8, 10, 15])
export const SEEDANCE_VIDEO_DURATION_PRESETS = Object.freeze([5, 7, 10])

export function getVideoDurationPresets(workflowId = '') {
  const normalized = String(workflowId || '').trim()
  if (['ltx23-i2v', 'ltx23-ia2v', 'ltx23-t2v'].includes(normalized)) {
    return LTX23_VIDEO_DURATION_PRESETS
  }
  if (['seedance2-t2v', 'seedance2-flf2v', 'seedance2-r2v'].includes(normalized)) {
    return SEEDANCE_VIDEO_DURATION_PRESETS
  }
  return VIDEO_DURATION_PRESETS
}

export const YOLO_QUEUE_CONFIRM_THRESHOLD = 10
export const ACTIVE_JOB_STATUSES = ['uploading', 'configuring', 'queuing', 'running', 'saving']
export const NON_TERMINAL_JOB_STATUSES = ['queued', 'paused', ...ACTIVE_JOB_STATUSES]

export const YOLO_AD_REFERENCE_CONSISTENCY_OPTIONS = Object.freeze({
  soft: 'Soft (allow stylistic variation)',
  medium: 'Medium (balanced consistency)',
  strict: 'Strict (maximize identity match)',
})

export const YOLO_AD_LOCAL_VIDEO_WORKFLOW_OPTIONS = Object.freeze([
  {
    id: 'ltx23-i2v',
    label: 'LTX 2.3',
    description: 'Better for longer takes, faces, and dialogue-style motion. Use for people-heavy shots.',
  },
  {
    id: 'wan22-i2v',
    label: 'WAN 2.2',
    description: 'Often stronger for product motion and physical movement. Use for product/demo variants.',
  },
])

export const YOLO_AD_FORMAT_PRESETS = Object.freeze([
  {
    id: 'product_demo',
    label: 'Product Demo',
    description: 'Hook, product reveal, feature demo, benefit, CTA.',
    styleNotes: 'Product demo structure: clear product reveal, functional demonstration, benefit-driven proof, clean CTA.',
  },
  {
    id: 'beauty_spot',
    label: 'Beauty Spot',
    description: 'Premium sensory shots, texture, skin/product macro detail.',
    styleNotes: 'Beauty spot structure: premium lighting, macro texture, formula/material detail, elegant packshot, refined end card.',
  },
  {
    id: 'tech_demo',
    label: 'Tech Demo',
    description: 'Exploded views, UI, feature clarity, clean proof moments.',
    styleNotes: 'Tech demo structure: precise feature callouts, exploded view, UI/app screen clarity, before-after proof, clean modern graphics.',
  },
  {
    id: 'fashion_lifestyle',
    label: 'Fashion / Lifestyle',
    description: 'Model-led commercial with product in use and aspirational context.',
    styleNotes: 'Fashion lifestyle structure: consistent model identity, wardrobe coherence, product-in-use moments, aspirational environment.',
  },
  {
    id: 'ugc_testimonial',
    label: 'UGC Testimonial',
    description: 'Spokesperson or customer talks to camera, natural social pacing.',
    styleNotes: 'UGC testimonial structure: handheld authenticity, direct-to-camera proof, natural spokesperson delivery, social-platform pacing.',
  },
  {
    id: 'cinematic_brand',
    label: 'Cinematic Brand Ad',
    description: 'Emotional hero shots, atmosphere, product as brand symbol.',
    styleNotes: 'Cinematic brand structure: emotional hook, atmospheric product reveal, premium camera movement, restrained typography, memorable end card.',
  },
])

export const YOLO_AD_PLATFORM_PRESETS = Object.freeze([
  { id: 'landscape_16x9', label: '16:9 Landscape', width: 1280, height: 720, durationPresets: [15, 30, 60] },
  { id: 'vertical_9x16', label: '9:16 Vertical', width: 720, height: 1280, durationPresets: [6, 15, 30] },
  { id: 'square_1x1', label: '1:1 Square', width: 1024, height: 1024, durationPresets: [6, 15, 30] },
])

export const YOLO_AD_COMMERCIAL_BEAT_OPTIONS = Object.freeze([
  { id: 'hook', label: 'Hook', scriptLine: 'Ad beat: hook\nText overlay: Stop scrolling — see the product transformation.' },
  { id: 'problem', label: 'Problem', scriptLine: 'Ad beat: problem\nText overlay: Show the pain point clearly and visually.' },
  { id: 'reveal', label: 'Reveal', scriptLine: 'Ad beat: product reveal\nProduct mode: hero' },
  { id: 'demo', label: 'Demo', scriptLine: 'Ad beat: demo\nProduct mode: in-hand' },
  { id: 'proof', label: 'Proof', scriptLine: 'Ad beat: proof\nText overlay: Add a concise claim or result.' },
  { id: 'cta', label: 'CTA', scriptLine: 'Ad beat: CTA\nText overlay: Shop now / Learn more / Try it today.' },
  { id: 'end-card', label: 'End Card', scriptLine: 'Ad beat: end card\nEnd card: Brand name, product name, CTA, URL, and disclaimer.' },
])

export const YOLO_AD_PRODUCT_VIEW_OPTIONS = Object.freeze([
  { id: 'hero', label: 'Hero product', scriptLine: 'Product mode: hero\nKeyframe prompt: Premium hero packshot with product centered, clean brand lighting, readable shape and silhouette.' },
  { id: 'macro', label: 'Macro detail', scriptLine: 'Product mode: macro detail\nKeyframe prompt: Extreme macro detail of product material, texture, finish, formula, stitching, glass, metal, or packaging.' },
  { id: 'exploded', label: 'Exploded view', scriptLine: 'Product mode: exploded view\nKeyframe prompt: Professional exploded view of the product components arranged cleanly, premium technical commercial style.' },
  { id: 'in-hand', label: 'In hand', scriptLine: 'Product mode: in-hand\nKeyframe prompt: Product held naturally in hand with believable scale, premium lifestyle lighting.' },
  { id: 'packaging', label: 'Packaging', scriptLine: 'Product mode: packaging\nKeyframe prompt: Product packaging and label hero shot, clean shelf-ready composition, brand colors preserved.' },
  { id: 'app-ui', label: 'App screen', scriptLine: 'Product mode: app UI\nKeyframe prompt: Clean app interface or technology screen shown clearly in context, modern UI commercial style.' },
  { id: 'before-after', label: 'Before/after', scriptLine: 'Product mode: before/after\nKeyframe prompt: Clear before-and-after comparison composition, product benefit visible without clutter.' },
])

export const YOLO_AD_CAMERA_CHIP_OPTIONS = Object.freeze([
  { id: 'push-in', label: 'Push in', scriptLine: 'Camera: Slow premium push-in toward the product or spokesperson.' },
  { id: 'orbit', label: 'Orbit', scriptLine: 'Camera: Smooth product orbit with controlled parallax and premium studio motion.' },
  { id: 'macro-slide', label: 'Macro slide', scriptLine: 'Camera: Slow macro slider move across product details and material texture.' },
  { id: 'top-down', label: 'Top-down', scriptLine: 'Camera: Locked top-down commercial layout, clean hands/product choreography.' },
  { id: 'handheld-ugc', label: 'Handheld UGC', scriptLine: 'Camera: Natural handheld phone-style movement, authentic social testimonial feel.' },
  { id: 'locked-packshot', label: 'Locked packshot', scriptLine: 'Camera: Locked-off packshot frame, product centered and stable for CTA or end card.' },
])

export const YOLO_AD_ENERGY_OPTIONS = Object.freeze([
  { id: 'premium-calm', label: 'Premium calm', scriptLine: 'Motion prompt: Calm premium movement, elegant pacing, no frantic cuts.' },
  { id: 'social-fast', label: 'Social fast-cut', scriptLine: 'Motion prompt: Fast social ad pacing, energetic action, strong first-second hook.' },
  { id: 'technical-clean', label: 'Technical clean', scriptLine: 'Motion prompt: Precise clean motion, clear demonstration, minimal distractions.' },
  { id: 'emotional-cinematic', label: 'Emotional cinematic', scriptLine: 'Motion prompt: Emotional cinematic movement, atmospheric lighting, memorable brand feeling.' },
])

export const YOLO_AD_TALENT_MODE_OPTIONS = Object.freeze([
  { id: 'none', label: 'No talent', scriptLine: 'Talent mode: none' },
  { id: 'hand-model', label: 'Hand model', scriptLine: 'Talent mode: hand model\nKeyframe prompt: Product interaction with natural hands, believable scale, no visible face.' },
  { id: 'spokesperson', label: 'Spokesperson', scriptLine: 'Talent mode: spokesperson\nDialogue: The spokesperson speaks this product benefit clearly to camera.' },
  { id: 'testimonial', label: 'Customer testimonial', scriptLine: 'Talent mode: testimonial\nDialogue: A customer-style testimonial line delivered naturally to camera.' },
  { id: 'lifestyle-model', label: 'Lifestyle model', scriptLine: 'Talent mode: lifestyle model\nKeyframe prompt: Model uses the product naturally in an aspirational lifestyle setting.' },
])

export const GENERATED_ASSET_FOLDERS = Object.freeze({
  image: ['Generated', 'Images'],
  video: ['Generated', 'Videos'],
  audio: ['Generated', 'Audio'],
})

// Destination folders for unmanaged custom runs observed through the embedded
// ComfyUI tab. Kept separate from GENERATED_ASSET_FOLDERS so users can
// distinguish managed workflow outputs from free-form ComfyUI-tab outputs.
export const IMPORTED_COMFY_ASSET_FOLDERS = Object.freeze({
  image: ['Imported from ComfyUI', 'Images'],
  video: ['Imported from ComfyUI', 'Videos'],
  audio: ['Imported from ComfyUI', 'Audio'],
})

export const YOLO_CAMERA_PRESET_OPTIONS = Object.freeze([
  { id: 'auto', label: 'Auto (from script)', angles: [] },
  { id: 'wide_establishing', label: 'Wide Establishing', angles: ['Wide shot', 'Eye level'] },
  { id: 'hero_product', label: 'Hero Product', angles: ['Close-up', 'Low angle'] },
  { id: 'dialogue_clean', label: 'Dialogue / Performance', angles: ['Medium shot', 'Over-the-shoulder'] },
  { id: 'dynamic_action', label: 'Dynamic Action', angles: ['Tracking shot', 'Low angle'] },
  { id: 'pov_energy', label: 'POV Energy', angles: ['POV', 'Handheld'] },
])

export const YOLO_VIDEO_WORKFLOW_TARGET_OPTIONS = Object.freeze([
  { id: 'profile', label: 'Profile default' },
  { id: 'ltx23-i2v', label: 'LTX 2.3' },
  { id: 'wan22-i2v', label: 'WAN 2.2' },
  { id: 'kling-o3-i2v', label: 'Kling O3 Omni' },
  { id: 'grok-video-i2v', label: 'Grok Imagine Video' },
  { id: 'vidu-q2-i2v', label: 'Vidu Q2' },
])

const WORKFLOW_DISPLAY_LABELS = Object.freeze({
  'z-image-turbo': 'Z-Image Turbo',
  'image-edit': 'Qwen Image Edit 2509',
  'nano-banana-2': 'Nano Banana 2 Image Edit (Cloud)',
  'wan22-i2v': 'WAN 2.2',
  'wan22-t2v': 'WAN 2.2 Text to Video',
  'ltx23-i2v': 'LTX 2.3',
  'ltx23-ia2v': 'LTX 2.3 IA2V',
  'ltx23-t2v': 'LTX 2.3 Text to Video',
  [SHORT_FILM_DIALOGUE_VIDEO_WORKFLOW_ID]: 'Short Film Dialogue (LTX 2.3)',
  'frame-interpolation': 'Frame Interpolation',
  'kling-o3-i2v': 'Kling O3 Omni',
  'grok-video-i2v': 'Grok Imagine Video',
  'vidu-q2-i2v': 'Vidu Q2',
  'seedance2-t2v': 'Seedance 2.0 Text to Video',
  'seedance2-flf2v': 'Seedance 2.0 First/Last Frame',
  'seedance2-r2v': 'Seedance 2.0 Reference to Video',
  [TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID]: 'Topaz Video Upscale',
  [MUSIC_VIDEO_SHOT_WORKFLOW_ID]: 'LTX 2.3 Music Video (Image + Audio)',
  [CUSTOM_GENERATE_IMAGE_WORKFLOW_ID]: 'Custom Image Workflow',
  [CUSTOM_GENERATE_VIDEO_WORKFLOW_ID]: 'Custom Video Workflow',
  [CUSTOM_MUSIC_KEYFRAME_WORKFLOW_ID]: 'Custom Keyframe Workflow',
  [CUSTOM_MUSIC_VIDEO_WORKFLOW_ID]: 'Custom Video Workflow',
  [VOCAL_EXTRACT_WORKFLOW_ID]: 'Vocal Extract (Mel-Band)',
  [ELEVENLABS_TTS_WORKFLOW_ID]: 'ElevenLabs Text to Speech',
  'caption-qwen-asr': 'Caption Transcription (Qwen ASR)',
  'grok-text-to-image': 'Grok Imagine',
  'gpt-image-2-t2i': 'GPT Image 2',
  'gpt-image-2-edit': 'GPT Image 2 Edit',
  'longcat-text-to-image': 'LongCat Text to Image',
  'ernie-image-turbo': 'Ernie Image Turbo',
  'flux2-text-to-image': 'Flux 2 Text to Image',
  'longcat-image-edit': 'LongCat Image Edit',
  'google-gemini-flash-lite': 'Prompt Helper (Gemini 3.1 Flash Lite)',
  'sonilo-v2m': 'Sonilo Video to Music',
  'seedream-5-lite-image-edit': 'Seedream 5.0 Lite',
  'image-edit-model-product': 'Qwen Image Edit 2509 (Model + Product)',
  'mask-gen': 'Mask Generation',
})

export const OPEN_COMFY_TAB_EVENT = 'comfystudio-open-comfyui-tab'

export const HARDWARE_TIERS = Object.freeze({
  lite: {
    id: 'lite',
    shortLabel: 'Lite',
    label: 'Low-end local',
    badgeClass: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  },
  standard: {
    id: 'standard',
    shortLabel: 'Standard',
    label: 'Mid-range local',
    badgeClass: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  },
  pro: {
    id: 'pro',
    shortLabel: 'Pro',
    label: 'High-end local',
    badgeClass: 'border-violet-500/40 bg-violet-500/10 text-violet-300',
  },
  cloud: {
    id: 'cloud',
    shortLabel: 'Cloud',
    label: 'Credits / cloud',
    badgeClass: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  },
})

const WORKFLOW_HARDWARE = Object.freeze({
  'z-image-turbo': {
    tierId: 'lite',
    runtime: 'local',
    minimumVramGb: 8,
    recommendedVramGb: 10,
  },
  'longcat-text-to-image': {
    tierId: 'standard',
    runtime: 'local',
    minimumVramGb: 12,
    recommendedVramGb: 16,
  },
  'ernie-image-turbo': {
    tierId: 'standard',
    runtime: 'local',
    minimumVramGb: 12,
    recommendedVramGb: 16,
  },
  'flux2-text-to-image': {
    tierId: 'pro',
    runtime: 'local',
    minimumVramGb: 16,
    recommendedVramGb: 24,
  },
  'frame-interpolation': {
    tierId: 'standard',
    runtime: 'local',
    minimumVramGb: 6,
    recommendedVramGb: 8,
  },
  'music-gen': {
    tierId: 'lite',
    runtime: 'local',
    minimumVramGb: 4,
    recommendedVramGb: 8,
  },
  'image-edit': {
    tierId: 'standard',
    runtime: 'local',
    minimumVramGb: 12,
    recommendedVramGb: 16,
  },
  'longcat-image-edit': {
    tierId: 'standard',
    runtime: 'local',
    minimumVramGb: 12,
    recommendedVramGb: 16,
  },
  'image-edit-model-product': {
    tierId: 'standard',
    runtime: 'local',
    minimumVramGb: 12,
    recommendedVramGb: 16,
  },
  'multi-angles': {
    tierId: 'standard',
    runtime: 'local',
    minimumVramGb: 12,
    recommendedVramGb: 16,
  },
  'multi-angles-scene': {
    tierId: 'standard',
    runtime: 'local',
    minimumVramGb: 12,
    recommendedVramGb: 16,
  },
  'wan22-i2v': {
    tierId: 'pro',
    runtime: 'local',
    minimumVramGb: 20,
    recommendedVramGb: 24,
  },
  'wan22-t2v': {
    tierId: 'pro',
    runtime: 'local',
    minimumVramGb: 20,
    recommendedVramGb: 24,
  },
  'ltx23-i2v': {
    tierId: 'pro',
    runtime: 'local',
    minimumVramGb: 24,
    recommendedVramGb: 32,
  },
  'ltx23-t2v': {
    tierId: 'pro',
    runtime: 'local',
    minimumVramGb: 24,
    recommendedVramGb: 32,
  },
  'ltx23-ia2v': {
    tierId: 'pro',
    runtime: 'local',
    minimumVramGb: 24,
    recommendedVramGb: 32,
  },
  [SHORT_FILM_DIALOGUE_VIDEO_WORKFLOW_ID]: {
    tierId: 'pro',
    runtime: 'local',
    minimumVramGb: 24,
    recommendedVramGb: 32,
  },
  'nano-banana-2': {
    tierId: 'cloud',
    runtime: 'cloud',
  },
  'gpt-image-2-t2i': {
    tierId: 'cloud',
    runtime: 'cloud',
  },
  'gpt-image-2-edit': {
    tierId: 'cloud',
    runtime: 'cloud',
  },
  'grok-text-to-image': {
    tierId: 'cloud',
    runtime: 'cloud',
  },
  'kling-o3-i2v': {
    tierId: 'cloud',
    runtime: 'cloud',
  },
  'grok-video-i2v': {
    tierId: 'cloud',
    runtime: 'cloud',
  },
  'vidu-q2-i2v': {
    tierId: 'cloud',
    runtime: 'cloud',
  },
  'seedance2-t2v': {
    tierId: 'cloud',
    runtime: 'cloud',
  },
  'seedance2-flf2v': {
    tierId: 'cloud',
    runtime: 'cloud',
  },
  'seedance2-r2v': {
    tierId: 'cloud',
    runtime: 'cloud',
  },
  [TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID]: {
    tierId: 'cloud',
    runtime: 'cloud',
  },
  [MUSIC_VIDEO_SHOT_WORKFLOW_ID]: {
    tierId: 'pro',
    runtime: 'local',
    minimumVramGb: 24,
    recommendedVramGb: 32,
  },
  [CUSTOM_GENERATE_IMAGE_WORKFLOW_ID]: {
    tierId: null,
    runtime: 'custom',
  },
  [CUSTOM_GENERATE_VIDEO_WORKFLOW_ID]: {
    tierId: null,
    runtime: 'custom',
  },
  [CUSTOM_MUSIC_KEYFRAME_WORKFLOW_ID]: {
    tierId: null,
    runtime: 'custom',
  },
  [CUSTOM_MUSIC_VIDEO_WORKFLOW_ID]: {
    tierId: null,
    runtime: 'custom',
  },
  [VOCAL_EXTRACT_WORKFLOW_ID]: {
    tierId: 'standard',
    runtime: 'local',
    minimumVramGb: 6,
    recommendedVramGb: 8,
  },
  [ELEVENLABS_TTS_WORKFLOW_ID]: {
    tierId: 'cloud',
    runtime: 'cloud',
  },
  'seedream-5-lite-image-edit': {
    tierId: 'cloud',
    runtime: 'cloud',
  },
  'google-gemini-flash-lite': {
    tierId: 'cloud',
    runtime: 'cloud',
  },
  'sonilo-v2m': {
    tierId: 'cloud',
    runtime: 'cloud',
  },
})

export function getWorkflowDisplayLabel(workflowId = '') {
  return WORKFLOW_DISPLAY_LABELS[workflowId] || String(workflowId || '')
}

export function getWorkflowHardwareInfo(workflowId = '') {
  const normalized = String(workflowId || '').trim() === 'nano-banana-pro'
    ? 'nano-banana-2'
    : String(workflowId || '').trim()
  return WORKFLOW_HARDWARE[normalized] || null
}

export function getWorkflowTierMeta(workflowId = '') {
  const hardware = getWorkflowHardwareInfo(workflowId)
  if (!hardware) return null
  return HARDWARE_TIERS[hardware.tierId] || null
}

export function formatWorkflowHardwareRuntime(workflowId = '') {
  const hardware = getWorkflowHardwareInfo(workflowId)
  if (!hardware) return 'VRAM unknown'
  if (hardware.runtime === 'custom') {
    return 'Graph-dependent'
  }
  if (hardware.runtime === 'cloud') {
    return 'Credits via ComfyUI partner nodes'
  }
  const min = Number(hardware.minimumVramGb)
  const rec = Number(hardware.recommendedVramGb)
  if (Number.isFinite(min) && min > 0 && Number.isFinite(rec) && rec >= min) {
    return `${min}GB min / ${rec}GB rec`
  }
  if (Number.isFinite(min) && min > 0) {
    return `${min}GB minimum`
  }
  return 'Local GPU'
}

export function formatWorkflowTierSummary(workflowId = '') {
  const tier = getWorkflowTierMeta(workflowId)
  const label = getWorkflowDisplayLabel(workflowId)
  const runtime = formatWorkflowHardwareRuntime(workflowId)
  if (!tier) return `${label}: ${runtime}`
  return `${label}: ${tier.label} (${runtime})`
}
