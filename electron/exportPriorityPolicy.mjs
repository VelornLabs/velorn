// Shared by the renderer and native MCP entry points. Keep this in electron/
// so the exact same policy is also present in packaged desktop builds.
// An action being a "preview" or starting with "get" does not make it cheap:
// several previews decode media, and music status can import finished takes.
const lightweightReads = new Set([
  'get_project', 'get_timeline', 'get_assets', 'get_storyboard', 'get_production_guide', 'get_production_run', 'find_timeline_items',
  'get_ai_review_passes', 'get_mcp_recipes', 'analyze_timeline',
  'analyze_music_video_workflow', 'get_generation_status', 'get_music_video_status',
  'get_transport_state', 'get_caption_status', 'get_workflow_install_status', 'get_generation_queue_status',
  'get_caption_engine_status',
  // Cached installer receipts and cancellation do not probe or begin downloads.
  'get_tool_setup_download', 'cancel_tool_setup_download',
  'get_lmstudio_model_download', 'cancel_lmstudio_model_download',
  // Reads only native credential presence/session validation; no key or network.
  'get_comfy_cloud_setup_status',
  'get_comfy_router_status',
  // A list kept in Velorn, and this session's local voice jobs: no network, nothing started.
  'get_create_models', 'get_local_voice_status',
  // Native Runs reads use only the manager's cached local snapshot/record;
  // they never poll ComfyUI, decode outputs, submit work, or import assets.
  'get_comfyui_runs', 'inspect_comfyui_run',
  'list_recent_projects', 'list_glsl_effects', 'list_export_presets',
  'inspect_compound', 'inspect_clip_effects', 'inspect_clip_audio',
  'get_export_status', 'cancel_export',
])

export function isMcpActionAllowedDuringExport(action, payload = {}) {
  if (lightweightReads.has(action)) return true
  // Permit explicit metadata-only inspection; never create decoders or capture
  // timeline pictures while an export has priority.
  if (['inspect_clip', 'inspect_source_frame', 'inspect_edit_point', 'inspect_visible_shots'].includes(action)) {
    return payload?.includeImage === false
  }
  if (action === 'control_transport') return payload?.operation === 'pause'
  if (action === 'control_export_batch') return ['pause', 'cancel'].includes(payload?.operation)
  if (action === 'audio_ducking') return ['status', 'cancel'].includes(payload?.operation || 'status')
  if (action === 'clip_interpolation') return ['inspect', 'cancel'].includes(payload?.operation || 'inspect')
  // Unknown future tools fail closed until their cost/side effects are reviewed.
  return false
}

export function assertMcpActionAllowedDuringExport(action, payload, busy) {
  if (!busy || isMcpActionAllowedDuringExport(action, payload)) return
  const error = new Error(`Export is in progress. "${String(action || 'unknown')}" is temporarily paused so export has priority. Use get_export_status to check progress, or cancel the export before editing, playback, generation, or other heavy work.`)
  error.code = 'EXPORT_IN_PROGRESS'
  throw error
}
