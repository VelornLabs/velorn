import { TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID } from './topazVideoUpscaleConfig'
import { MUSIC_VIDEO_SHOT_WORKFLOW_ID, VOCAL_EXTRACT_WORKFLOW_ID } from './musicVideoShotConfig'
import {
  ELEVENLABS_TTS_WORKFLOW_ID,
  SHORT_FILM_DIALOGUE_VIDEO_WORKFLOW_ID,
} from './shortFilmConfig'

/**
 * Central workflow registry - shared by GenerateWorkspace, Settings, and workflow store.
 * Defines all known workflows: built-in (always installed) and available (user can download).
 */

export const WORKFLOW_CATEGORIES = {
  video: 'video',
  image: 'image',
  audio: 'audio',
  text: 'text',
}

const WORKFLOW_BASE_URL = (() => {
  const rawBase = typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL
    ? String(import.meta.env.BASE_URL)
    : '/'
  return rawBase.endsWith('/') ? rawBase : `${rawBase}/`
})()

export function getBundledWorkflowPath(filename) {
  const safeFilename = String(filename || '').replace(/^\/+/, '')
  return `${WORKFLOW_BASE_URL}workflows/${safeFilename}`
}

// Built-in workflows shipped with ComfyStudio - always installed, cannot be deleted
export const BUILTIN_WORKFLOWS = [
  { id: 'wan22-i2v', label: 'Image to Video (WAN 2.2)', category: 'video', needsImage: true, description: 'Animate an image into video', file: 'video_wan2_2_14B_i2v.json' },
  { id: 'ltx23-i2v', label: 'Image to Video (LTX 2.3)', category: 'video', needsImage: true, description: 'Animate an image with local LTX 2.3', file: 'video_ltx2_3_i2v.json' },
  { id: 'ltx23-ia2v', label: 'Image + Audio to Video (LTX 2.3)', category: 'video', needsImage: true, description: 'Animate an image with local LTX 2.3 audio conditioning', file: 'video_ltx2_3_ia2v.json' },
  { id: 'ltx23-t2v', label: 'Text to Video (LTX 2.3)', category: 'video', needsImage: false, description: 'Generate video from text with local LTX 2.3', file: 'video_ltx2_3_t2v.json' },
  { id: MUSIC_VIDEO_SHOT_WORKFLOW_ID, label: 'LTX 2.3 Music Video (Image + Audio)', category: 'video', needsImage: true, description: 'Per-shot LTX 2.3 music-video workflow with audio conditioning and lip-sync for Director Mode music videos', file: 'music_video_shot_ltx2_3_i2v_audio.json' },
  { id: 'wan22-t2v', label: 'Text to Video (WAN 2.2)', category: 'video', needsImage: false, description: 'Generate video from text with local WAN 2.2', file: 'video_wan2_2_14B_t2v.json' },
  { id: 'kling-o3-i2v', label: 'Image to Video (Kling O3 Omni)', category: 'video', needsImage: true, description: 'Premium image-to-video with Kling 3.0 Omni', file: 'api_kling_o3_i2v.json' },
  { id: 'grok-video-i2v', label: 'Image to Video (Grok Imagine Video)', category: 'video', needsImage: true, description: 'Cloud image-to-video with Grok Imagine Video Beta', file: 'api_grok_video.json' },
  { id: 'vidu-q2-i2v', label: 'Image to Video (Vidu Q2)', category: 'video', needsImage: true, description: 'Cloud image-to-video with Vidu Q2 Pro Fast', file: 'api_vidu_q2_i2v.json' },
  { id: 'seedance2-t2v', label: 'Text to Video (Seedance 2.0)', category: 'video', needsImage: false, description: 'Cloud text-to-video with ByteDance Seedance 2.0', file: 'api_seedance2_0_t2v.json' },
  { id: 'seedance2-flf2v', label: 'First/Last Frame to Video (Seedance 2.0)', category: 'video', needsImage: false, description: 'Cloud first-frame/last-frame video with ByteDance Seedance 2.0', file: 'api_seedance2_0_flf2v.json' },
  { id: 'seedance2-r2v', label: 'Reference to Video (Seedance 2.0)', category: 'video', needsImage: false, description: 'Cloud multi-reference video with ByteDance Seedance 2.0', file: 'api_seedance2_0_r2v.json' },
  { id: TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID, label: 'Topaz Video Upscale', category: 'video', needsImage: false, description: 'Cloud video upscaling with Topaz Starlight and Astra models', file: 'api_topaz_video_enhance.json' },
  { id: SHORT_FILM_DIALOGUE_VIDEO_WORKFLOW_ID, label: 'Short Film Dialogue Shot (LTX 2.3)', category: 'video', needsImage: true, description: 'Fast short-film dialogue image+audio-to-video workflow using structured speech prompts', file: 'short_film_dialogue_ltx2_3_ia2v.json' },
  { id: VOCAL_EXTRACT_WORKFLOW_ID, label: 'Vocal Extract (Mel-Band RoFormer)', category: 'audio', needsImage: false, description: 'Isolate vocals from a mixed song using Mel-Band RoFormer. Used as a one-time preprocessing step for music-video projects.', file: 'vocal_extract_melband.json' },
  { id: 'caption-qwen-asr', label: 'Caption Transcription (Qwen ASR)', category: 'audio', needsImage: false, description: 'Transcribe timeline audio, video audio, or music-video songs into timed SRT captions using Qwen ASR.', file: 'caption_qwen_asr_transcription.json' },
  { id: ELEVENLABS_TTS_WORKFLOW_ID, label: 'ElevenLabs Text to Speech', category: 'audio', needsImage: false, description: 'Generate one dialogue audio clip from text using an ElevenLabs voice profile. Used by Short Film Creation.', file: 'api_elevenlabs_text_to_speech.json' },
  { id: 'multi-angles', label: 'Multiple Angles (Characters)', category: 'image', needsImage: true, description: 'Generate 8 camera angles from one character image', file: '1_click_multiple_angles.json' },
  { id: 'multi-angles-scene', label: 'Multiple Angles (Scenes)', category: 'image', needsImage: true, description: 'Generate 8 camera angles from one scene image', file: '1_click_multiple_scene_angles-v1.0.json' },
  { id: 'image-edit', label: 'Image Edit', category: 'image', needsImage: true, description: 'Edit image with text prompt', file: 'image_qwen_image_edit_2509.json' },
  { id: 'longcat-image-edit', label: 'LongCat Image Edit', category: 'image', needsImage: true, description: 'Edit image with the local LongCat workflow', file: 'image_longcat_image_edit.json' },
  { id: 'z-image-turbo', label: 'Text to Image (Z Image Turbo)', category: 'image', needsImage: false, description: 'Generate image from text prompt using Z Image Turbo', file: 'image_z_image_turbo.json' },
  { id: 'longcat-text-to-image', label: 'Text to Image (LongCat)', category: 'image', needsImage: false, description: 'Generate image with local LongCat', file: 'image_longcat_text_to_image.json' },
  { id: 'ernie-image-turbo', label: 'Text to Image (Ernie Turbo)', category: 'image', needsImage: false, description: 'Generate image with local Ernie Image Turbo', file: 'image_ernie_image_turbo.json' },
  { id: 'flux2-text-to-image', label: 'Text to Image (Flux 2)', category: 'image', needsImage: false, description: 'Generate image with local Flux 2', file: 'image_flux2_text_to_image.json' },
  { id: 'frame-interpolation', label: 'Frame Interpolation', category: 'video', needsImage: true, description: 'Add in-between frames to smooth video motion', file: 'video_frame_interpolation.json' },
  { id: 'nano-banana-2', label: 'Nano Banana 2 Image Edit (Cloud)', category: 'image', needsImage: false, description: 'Cloud image generation and reference editing with Nano Banana 2', file: 'api_google_nano_banana2_image_edit.json' },
  { id: 'gpt-image-2-t2i', label: 'Text to Image (GPT Image 2)', category: 'image', needsImage: false, description: 'Cloud text-to-image with OpenAI GPT Image 2', file: 'api_openai_gpt_image_2_t2i.json' },
  { id: 'gpt-image-2-edit', label: 'Image Edit (GPT Image 2)', category: 'image', needsImage: true, description: 'Cloud image edit with OpenAI GPT Image 2', file: 'api_openai_gpt_image_2_image_edit.json' },
  { id: 'grok-text-to-image', label: 'Text to Image (Grok Imagine)', category: 'image', needsImage: false, description: 'Cloud text-to-image using Grok Imagine Image Beta', file: 'api_grok_text_to_image.json' },
  { id: 'seedream-5-lite-image-edit', label: 'Image Edit (Seedream 5.0 Lite)', category: 'image', needsImage: true, description: 'Cloud image edit with ByteDance Seedream 5.0 Lite', file: 'api_bytedance_seedream_5_0_lite_image_edit.json' },
  { id: 'music-gen', label: 'Music Generation', category: 'audio', needsImage: false, description: 'Generate music from tags and lyrics', file: 'music_generation.json' },
  { id: 'sonilo-v2m', label: 'Video to Music (Sonilo)', category: 'audio', needsImage: true, description: 'Cloud video-to-music generation with Sonilo', file: 'api_sonilo_v2m.json' },
  { id: 'google-gemini-flash-lite', label: 'Prompt Helper (Gemini 3.1 Flash Lite)', category: 'text', needsImage: false, description: 'Cloud prompt-writing helper using Gemini 3.1 Flash Lite', file: 'api_google_gemini.json' },
]

// Map workflow id -> public path (for loading JSON)
export const BUILTIN_WORKFLOW_PATHS = {
  'wan22-i2v': getBundledWorkflowPath('video_wan2_2_14B_i2v.json'),
  'ltx23-i2v': getBundledWorkflowPath('video_ltx2_3_i2v.json'),
  'ltx23-ia2v': getBundledWorkflowPath('video_ltx2_3_ia2v.json'),
  'ltx23-t2v': getBundledWorkflowPath('video_ltx2_3_t2v.json'),
  'wan22-t2v': getBundledWorkflowPath('video_wan2_2_14B_t2v.json'),
  'kling-o3-i2v': getBundledWorkflowPath('api_kling_o3_i2v.json'),
  'grok-video-i2v': getBundledWorkflowPath('api_grok_video.json'),
  'vidu-q2-i2v': getBundledWorkflowPath('api_vidu_q2_i2v.json'),
  'seedance2-t2v': getBundledWorkflowPath('api_seedance2_0_t2v.json'),
  'seedance2-flf2v': getBundledWorkflowPath('api_seedance2_0_flf2v.json'),
  'seedance2-r2v': getBundledWorkflowPath('api_seedance2_0_r2v.json'),
  [TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID]: getBundledWorkflowPath('api_topaz_video_enhance.json'),
  [MUSIC_VIDEO_SHOT_WORKFLOW_ID]: getBundledWorkflowPath('music_video_shot_ltx2_3_i2v_audio.json'),
  [SHORT_FILM_DIALOGUE_VIDEO_WORKFLOW_ID]: getBundledWorkflowPath('short_film_dialogue_ltx2_3_ia2v.json'),
  [VOCAL_EXTRACT_WORKFLOW_ID]: getBundledWorkflowPath('vocal_extract_melband.json'),
  [ELEVENLABS_TTS_WORKFLOW_ID]: getBundledWorkflowPath('api_elevenlabs_text_to_speech.json'),
  'multi-angles': getBundledWorkflowPath('1_click_multiple_angles.json'),
  'multi-angles-scene': getBundledWorkflowPath('1_click_multiple_scene_angles-v1.0.json'),
  'image-edit': getBundledWorkflowPath('image_qwen_image_edit_2509.json'),
  'image-edit-model-product': getBundledWorkflowPath('image_qwen_image_edit_2509_Model_and_Product.json'),
  'longcat-image-edit': getBundledWorkflowPath('image_longcat_image_edit.json'),
  'z-image-turbo': getBundledWorkflowPath('image_z_image_turbo.json'),
  'longcat-text-to-image': getBundledWorkflowPath('image_longcat_text_to_image.json'),
  'ernie-image-turbo': getBundledWorkflowPath('image_ernie_image_turbo.json'),
  'flux2-text-to-image': getBundledWorkflowPath('image_flux2_text_to_image.json'),
  'frame-interpolation': getBundledWorkflowPath('video_frame_interpolation.json'),
  'nano-banana-2': getBundledWorkflowPath('api_google_nano_banana2_image_edit.json'),
  'gpt-image-2-t2i': getBundledWorkflowPath('api_openai_gpt_image_2_t2i.json'),
  'gpt-image-2-edit': getBundledWorkflowPath('api_openai_gpt_image_2_image_edit.json'),
  'grok-text-to-image': getBundledWorkflowPath('api_grok_text_to_image.json'),
  'seedream-5-lite-image-edit': getBundledWorkflowPath('api_bytedance_seedream_5_0_lite_image_edit.json'),
  'nano-banana-pro': getBundledWorkflowPath('api_google_nano_banana2_image_edit.json'), // legacy id alias
  'music-gen': getBundledWorkflowPath('music_generation.json'),
  'sonilo-v2m': getBundledWorkflowPath('api_sonilo_v2m.json'),
  'google-gemini-flash-lite': getBundledWorkflowPath('api_google_gemini.json'),
  'caption-qwen-asr': getBundledWorkflowPath('caption_qwen_asr_transcription.json'),
  'mask-gen': getBundledWorkflowPath('mask_generation_text_prompt.json'),
}

// Optional workflows - user can download to enable (not in Generate until installed)
export const AVAILABLE_WORKFLOWS = [
  { id: 'mask-gen', label: 'Mask Generation', category: 'image', needsImage: true, description: 'Generate masks from images/videos using text prompts (SAM3)', file: 'mask_generation_text_prompt.json' },
]

// All workflows for display (built-in + available)
export const ALL_WORKFLOWS = [...BUILTIN_WORKFLOWS, ...AVAILABLE_WORKFLOWS]

// Category labels for UI
export const CATEGORY_LABELS = {
  video: 'Video',
  image: 'Image',
  audio: 'Audio',
  text: 'Text',
}
