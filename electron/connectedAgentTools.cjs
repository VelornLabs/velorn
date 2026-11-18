'use strict'

const { randomUUID } = require('node:crypto')
const { isAutoApprovableEdit } = require('./connectedAgentEditPolicy.cjs')
const { getAgentDispatchReceipt } = require('./connectedAgentDispatch.cjs')
const { createToolReceiptLedger, classifyDispatchOutcome } = require('./connectedAgentReceipts.cjs')
const { validateConnectedAgentArguments, toolArgumentFailure, staleContextFailure, projectConnectedAgentTool, getNativeArgumentFailure } = require('./connectedAgentArguments.cjs')
const { createPausableTimeout } = require('./connectedAgentLocalTools.cjs')
const { REQUEST_TOOL: CLOUD_SETUP_REQUEST } = require('./comfyCloudSetup.cjs')
const { normalizeComfyRouterArgs } = require('./mcpComfyRouterTools.cjs')
const USER_WAIT_TOOLS = new Set([CLOUD_SETUP_REQUEST, 'download_lmstudio_model', 'load_lmstudio_model', 'generate_comfy_router_image', 'generate_create_media'])
// Paid Router plans: previewed first in every access mode, applied only by planId.
const ROUTER_PLAN_TOOLS = new Set(['generate_comfy_router_image', 'generate_create_media'])

// This is a safety classification, not a second tool catalog. Definitions and
// dispatch always come from the running Velorn MCP server. New tools default to
// approval; neither a name prefix nor an MCP annotation grants authority.
const READ_TOOLS = new Set([
  ...require('./optionalSetup.cjs').names,
  ...require('./toolSetupTools.cjs').readNames,
  ...require('./lmStudioSetupTools.cjs').readNames,
  ...require('./comfyCloudSetup.cjs').readNames,
  ...require('./comfyWorkflowAuthoring.cjs').names,
  'get_project', 'get_timeline', 'get_assets', 'get_ai_review_passes', 'get_mcp_recipes',
  'find_timeline_items', 'check_media_health', 'inspect_export_file',
  'diagnose_comfyui_connection', 'get_comfyui_launcher_logs', 'validate_comfyui_nodes',
  'list_velorn_workflows', 'inspect_velorn_workflow', 'inspect_clip', 'list_comfyui_templates',
  'get_workflow_install_status', 'get_audio_analysis', 'get_generation_status',
  'get_caption_engine_status',
  // Queue inspection reads a published snapshot without mounting Generate.
  'get_generation_queue_status', 'get_comfyui_runs', 'inspect_comfyui_run',
  'get_comfy_router_status', 'get_create_models', 'get_local_voice_status',
  'list_recent_projects', 'get_caption_status', 'get_music_video_status', 'analyze_timeline',
  'analyze_music_video_workflow', 'list_glsl_effects', 'inspect_clip_effects', 'inspect_compound',
  'inspect_clip_audio', 'list_fonts', 'list_export_presets', 'get_export_status',
  'get_transport_state', 'inspect_source_frame', 'inspect_edit_point', 'get_storyboard',
  'get_production_guide', 'get_production_run', 'check_export_readiness',
  'search_research_sources', 'read_research_page', 'get_agent_download_status',
])
const LIVE_CAPTURE_TOOLS = new Set(['inspect_timeline_frame', 'inspect_timeline_range', 'inspect_visible_shots'])
const IMAGE_TOOLS = new Set([
  ...LIVE_CAPTURE_TOOLS, 'inspect_clip', 'inspect_source_frame', 'inspect_edit_point',
  'inspect_music_video_keyframe', 'inspect_music_video_video',
])
// These apparent reads and previews have visible or durable side effects.
// In particular music status imports finished files, irrespective of previewOnly.
const EFFECTFUL_PREVIEW_TOOLS = new Set([
  'search_stock_media', 'import_stock_media', 'get_music_generation_status',
  'get_music_video_session', 'get_music_video_plan',
  'inspect_music_video_keyframe', 'inspect_music_video_video', 'configure_music_video',
  'update_music_video_session', 'manage_music_video_cast', 'queue_music_video_character_asset',
  'manage_music_video_pass', 'set_music_video_director_script', 'update_music_video_shot',
  'queue_music_video_keyframes', 'queue_music_video_videos', 'replace_music_video_keyframe',
  'replace_music_video_video', 'transcribe_music_video_audio', 'assemble_music_video_timeline',
  'replace_music_video_timeline_shot', 'regenerate_music_video_keyframe', 'regenerate_music_video_video',
])
const SAFE_PREVIEW_TOOLS = new Set([
  'install_caption_engine',
  'set_comfyui_connection', 'repair_comfyui_connection', 'guide_comfyui_setup', 'control_comfyui_launcher',
  'prepare_generation_from_timeline_context', 'queue_prepared_generation', 'queue_timeline_generation_batch',
  'queue_timeline_template_generation', 'import_comfyui_workflow', 'open_comfyui_workflow', 'install_workflow_setup', 'generate_music', 'generate_local_voice',
  // Native Runs previews validate/adopt/plan without mounting Generate or
  // mutating a project until previewOnly:false is explicitly approved.
  'queue_comfyui_workflow', 'track_comfyui_prompt', 'control_comfyui_run', 'import_comfyui_run_outputs',
  'generate_comfy_router_image', 'generate_create_media', 'control_comfy_router_image', 'import_comfy_router_image',
  'queue_h3_reference_video', 'queue_prompt_generation_batch', 'split_clip', 'extract_range', 'set_clip_speed',
  'set_clip_audio', 'open_project', 'transcribe_captions', 'update_caption_cues', 'generate_captions', 'save_project',
  'set_clip_label_color', 'set_clips_enabled', 'add_timeline_markers', 'remove_timeline_markers',
  'set_timeline_marker_properties', 'undo', 'redo', 'set_playhead', 'select_clips', 'select_assets',
  'create_project_checkpoint', 'restore_project_checkpoint', 'import_asset_from_path', 'relink_asset',
  'set_clip_style', 'set_clip_mask', 'run_mcp_action_plan', 'set_in_out_range', 'create_project', 'duplicate_project',
  'create_timeline', 'create_asset_folder', 'move_assets_to_folder', 'move_unused_assets_to_folder', 'add_track',
  'update_track', 'set_master_audio', 'remove_track', 'switch_timeline', 'rename_timeline', 'duplicate_timeline',
  'delete_timeline', 'add_transition', 'update_transition', 'remove_transitions', 'move_clips', 'trim_clips',
  'delete_clips', 'add_asset_to_timeline', 'replace_clip_with_asset', 'add_solid_color', 'add_adjustment_clip',
  'add_assets_to_timeline', 'duplicate_clip', 'add_text_clip', 'update_text_clip', 'add_shape_clip', 'update_shape_clip',
  'add_glsl_effect', 'update_glsl_effect', 'remove_glsl_effect', 'set_clip_keyframes', 'add_dip_to_black',
  'export_timeline', 'export_fcpxml', 'export_delivery_batch', 'set_clip_color', 'edit_clip_effects',
  'paste_clip_attributes', 'edit_source', 'edit_trim', 'create_compound', 'open_compound', 'close_compound',
  'rename_compound', 'uncompound', 'audio_ducking', 'clip_interpolation', 'save_export_preset', 'rename_export_preset',
  'delete_export_preset', 'cancel_export', 'control_export_batch', 'control_transport', 'edit_storyboard', 'edit_production_run',
  'download_agent_model',
])
const IDENTITY_FIELDS = ['session', 'projectKey', 'timelineId', 'timelineSessionId', 'compoundClipId']
const LIMITS = Object.freeze({
  argumentBytes: 256 * 1024, contextBytes: 128 * 1024,
  catalogBytes: 2 * 1024 * 1024, resultBytes: 128 * 1024,
  imageBytes: 5 * 1024 * 1024, images: 4, contentBlocks: 24,
  operationTimeoutMs: 65000, approvalTimeoutMs: 5 * 60 * 1000,
})

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const errorResult = message => ({ isError: true, content: [{ type: 'text', text: truncateUtf8(String(message), 4096) }] })
function stable(value) {
  return JSON.stringify(value, (_, item) => plainObject(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
}
function cloneBounded(value, maxBytes, label) {
  let serialized
  try { serialized = JSON.stringify(value) } catch { throw new Error(`${label} must be JSON serializable.`) }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > maxBytes) {
    throw new Error(`${label} exceeds the allowed size.`)
  }
  return JSON.parse(serialized)
}
function contextOf(guard) { return guard?.context || guard }
function requireContext(guard) {
  const context = contextOf(guard)
  if (!plainObject(context) || !context.session || !Number.isFinite(context.revision)
    || !Object.hasOwn(context, 'projectKey') || !Object.hasOwn(context, 'timelineId')
    || !Object.hasOwn(context, 'timelineSessionId') || !Object.hasOwn(context, 'compoundClipId')) {
    throw new Error('The live Velorn project context is unavailable. Inspect the project and start a new message.')
  }
  return context
}
function sameIdentity(left, right) {
  return IDENTITY_FIELDS.every(key => contextOf(left)?.[key] === contextOf(right)?.[key])
}
function confirmedTimelineNavigation(name, args, result, before, after) {
  if (!['create_timeline', 'switch_timeline', 'duplicate_timeline'].includes(name)
    || args.previewOnly !== false || failedResult(result)) return false
  const from = contextOf(before), to = contextOf(after)
  if (from.session !== to.session || from.projectKey !== to.projectKey
    || from.compoundClipId !== null || to.compoundClipId !== null) return false
  const receipt = getAgentDispatchReceipt(result), detail = parseResult(result), record = detail?.result
  const completion = receipt?.completions?.[0]
  if (receipt?.completions?.length !== 1 || completion.action !== name || completion.success !== true
    || stable(receipt.before) !== stable(before) || stable(completion.after) !== stable(after)
    || detail?.action !== name || detail.success !== true || record?.switched !== true
    || typeof record.timeline?.id !== 'string' || record.timeline.id !== to.timelineId) return false
  if (name === 'switch_timeline') return String(args.timelineId || args.id || '').trim() === to.timelineId
  if (name === 'create_timeline') return record.created === true && record.currentTimelineId === to.timelineId
    && args.switchToTimeline !== false && args.activate !== false && args.makeActive !== false
  return record.duplicated === true && (args.switchToTimeline === true || args.activate === true)
}
function freezeCheckpointRestoreTarget(preview, args, guard) {
  // This target comes from the exact host preview, not model-supplied transition
  // fields or the mutable meaning of "latest checkpoint" at apply time.
  const proof = getAgentDispatchReceipt(preview), completion = proof?.completions?.[0]
  const detail = parseResult(preview), record = detail?.result, checkpoint = record?.checkpoint
  if (proof?.completions?.length !== 1 || completion.action !== 'restore_project_checkpoint'
    || completion.success !== true || stable(proof.before) !== stable(guard)
    || stable(completion.after) !== stable(guard) || detail?.action !== 'restore_project_checkpoint'
    || record?.previewOnly !== true || record.applied !== false
    || typeof checkpoint?.id !== 'string' || !checkpoint.id
    || checkpoint.id !== String(args.checkpointId || args.id || '').trim()
    || typeof checkpoint.currentTimelineId !== 'string' || !checkpoint.currentTimelineId) {
    throw new Error('The checkpoint restore target could not be confirmed from its native preview. Nothing was applied.')
  }
  return Object.freeze({ checkpointId: checkpoint.id, timelineId: checkpoint.currentTimelineId })
}
function confirmedCheckpointRestore(name, args, result, before, after, target) {
  if (name !== 'restore_project_checkpoint' || !target || args.previewOnly !== false || failedResult(result)) return false
  const from = contextOf(before), to = contextOf(after)
  if (from.session !== to.session || from.projectKey !== to.projectKey
    || from.compoundClipId !== null || to.compoundClipId !== null
    || !Number.isSafeInteger(from.timelineSessionId) || !Number.isSafeInteger(to.timelineSessionId)
    || to.timelineSessionId !== from.timelineSessionId + 1 || to.timelineId !== target.timelineId) return false
  const proof = getAgentDispatchReceipt(result), completion = proof?.completions?.[0]
  const detail = parseResult(result), record = detail?.result
  return proof?.completions?.length === 1 && completion.action === name && completion.success === true
    && stable(proof.before) === stable(before) && stable(completion.after) === stable(after)
    && detail?.action === name && detail.success === true && detail.previewOnly !== true
    && record?.action === name && record.success === true && record.previewOnly !== true
    && record.applied === true && record.restored === true
    && record.checkpointId === target.checkpointId && args.checkpointId === target.checkpointId
    && record.restoredTimelineId === target.timelineId
    // Captured synchronously at the restore, before optional saving/bridge awaits.
    // Neither an intervening edit nor a second reload may grant new authority.
    && stable(record.restoreTransition?.before) === stable(before)
    && stable(record.restoreTransition?.after) === stable(after)
    && (args.saveProject !== true || record.savedProject === true)
}
function isRead(name, args) {
  return READ_TOOLS.has(name)
    || (LIVE_CAPTURE_TOOLS.has(name) && args.includeImage === false)
    || (name === 'audio_ducking' && (args.operation || 'status') === 'status')
    || (name === 'clip_interpolation' && (args.operation || 'inspect') === 'inspect')
}
function parseResult(result) {
  const text = result?.content?.find(block => block.type === 'text')?.text
  if (typeof text !== 'string') return null
  try { return JSON.parse(text) } catch { return null }
}
function failedResult(result) {
  const detail = parseResult(result)
  // Legacy create/duplicate-project wrappers use success:false to mean "not
  // applied yet" even for a valid renderer preview. Do not mistake that for a
  // failed plan, but never forgive an explicitly failed/invalid inner result.
  const validNestedPreview = detail?.result?.previewOnly === true
    && detail.result.success !== false && !detail.result.error && !detail.error
  return result?.isError === true || (detail?.success === false && !validNestedPreview)
    || detail?.result?.success === false
}
// Only this host-owned generation handler can certify that dependency refusal
// happened before setup or submission. Never infer this from error prose or
// model arguments; unknown errors/timeouts keep the uncertain-write lock.
function confirmedPrequeueRefusal(name, result) {
  const detail = parseResult(result)
  return name === 'queue_timeline_template_generation' && result?.isError === true
    && detail?.success === false && detail.code === 'WORKFLOW_DEPENDENCIES_MISSING'
    && detail.action === name
    && detail.outcome === 'not-started' && detail.generationSubmitted === false
    && typeof detail.workflowId === 'string' && detail.workflowId.length > 0
    && plainObject(detail.dependencyCheck)
    && detail.dependencyCheck.hasBlockingIssues === true
    && detail.dependencyCheck.workflowId === detail.workflowId
}
function confirmedExportRefusal(name, result) {
  const detail = parseResult(result), refusal = detail?.result
  return name === 'export_timeline' && detail?.action === name && detail.success === false
    && detail.previewOnly === false && refusal?.success === false && refusal.started === false
    && refusal.code === 'EXPORT_NOT_STARTED' && refusal.outcome === 'not-started'
    && refusal.workerStarted === false && refusal.phase === 'destination'
    && typeof refusal.jobId === 'string' && refusal.jobId.startsWith('mcp-export-')
    && typeof refusal.outputPath === 'string' && refusal.outputPath.length > 0
}
const confirmedNoStart = (name, result) => confirmedPrequeueRefusal(name, result) || confirmedExportRefusal(name, result)
function canonicalActionArguments(name, args) {
  const transient = new Set(['previewOnly', 'expectedContext', 'previewToken', 'exportPlanToken'])
  const clean = Object.fromEntries(Object.entries(args).filter(([key]) => !transient.has(key)))
  if (name !== 'add_timeline_markers') return clean

  // The marker handler accepts a legacy scalar form and the current array
  // form. They resolve to the same native edit, so fingerprint the resolved
  // shape instead of allowing a local model to repeat a write by changing
  // aliases such as name/label or time/timeSeconds.
  const entries = Array.isArray(clean.markers) && clean.markers.length > 0 ? clean.markers : [clean]
  const markers = entries.map(entry => {
    const marker = {}
    const time = entry?.timeSeconds ?? entry?.time
    if (time !== undefined && time !== null) marker.timeSeconds = time
    else if (entry?.frame !== undefined && entry?.frame !== null) marker.frame = entry.frame
    const label = entry?.label || entry?.name || clean.label || clean.name
    const color = entry?.color || clean.color
    if (label) marker.label = label
    if (color) marker.color = color
    return marker
  })
  return { markers }
}
function actionKey(name, args) {
  return stable({ name, args: canonicalActionArguments(name, args) })
}
function truncateUtf8(text, bytes) {
  const buffer = Buffer.from(text)
  return buffer.length <= bytes ? text : buffer.subarray(0, bytes).toString('utf8').replace(/\uFFFD$/, '')
}
function redactInlineMedia(text) {
  // Media travels only in explicitly bounded MCP image blocks. Never permit a
  // text/result field to bypass the still-image consent and size controls.
  const redactString = value => value.replace(/data:(?:image|audio|video)\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[inline media omitted]')
  const visit = value => {
    if (typeof value === 'string') return redactString(value)
    if (Array.isArray(value)) return value.map(visit)
    if (!plainObject(value)) return value
    const media = ['image', 'audio', 'video'].includes(value.type) || /^(image|audio|video)\//i.test(value.mimeType || '')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      media && ['data', 'blob', 'base64'].includes(key) && typeof item === 'string' ? '[inline media omitted]' : visit(item)]))
  }
  try { return JSON.stringify(visit(JSON.parse(text))) } catch { return redactString(text) }
}
function boundedResult(result, allowImages, limits, extraNotes = []) {
  const content = [], notes = [...extraNotes]
  let remaining = limits.resultBytes, imageBytes = 0, images = 0
  const blocks = Array.isArray(result?.content) ? result.content : [{ type: 'text', text: JSON.stringify(result ?? null) }]
  for (const block of blocks.slice(0, limits.contentBlocks)) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const text = redactInlineMedia(block.text)
      const trimmed = truncateUtf8(text, Math.max(0, remaining))
      if (trimmed) content.push({ type: 'text', text: trimmed })
      remaining -= Buffer.byteLength(trimmed)
      if (trimmed !== text) notes.push('Tool output was truncated. Narrow the next inspection; do not repeat an applied action.')
    } else if (block?.type === 'image') {
      const bytes = typeof block.data === 'string' ? Buffer.byteLength(block.data, 'base64') : Infinity
      if (allowImages && ['image/png', 'image/jpeg', 'image/webp'].includes(block.mimeType)
        && typeof block.data === 'string' && /^[A-Za-z0-9+/=]+$/.test(block.data)
        && images < limits.images && imageBytes + bytes <= limits.imageBytes) {
        content.push({ type: 'image', mimeType: block.mimeType, data: block.data })
        images += 1; imageBytes += bytes
      } else notes.push('A tool image was withheld because image sharing is disabled or its size/format exceeds the allowed limit.')
    } else {
      notes.push('Non-text/non-still-image tool content was withheld.')
    }
  }
  if (blocks.length > limits.contentBlocks) notes.push('Additional tool content was omitted to keep the response bounded.')
  if (notes.length) content.push({ type: 'text', text: [...new Set(notes)].join('\n') })
  return { ...(result?.isError === true ? { isError: true } : {}), content }
}
function warningFor(name, args, depth = 0) {
  const warnings = []
  if (name === 'get_music_generation_status') warnings.push('Checking music status can import completed music files and add project assets. This tool has no dry-run mode.')
  if (['search_stock_media', 'import_stock_media'].includes(name)) warnings.push('Even a stock search/import preview updates the Stock panel and can open its workspace; it contacts the configured stock service.')
  if (EFFECTFUL_PREVIEW_TOOLS.has(name) && !['get_music_generation_status', 'search_stock_media', 'import_stock_media'].includes(name)) {
    warnings.push('This tool opens the Generate workspace even when inspecting or previewing.')
  }
  if (LIVE_CAPTURE_TOOLS.has(name) && args.includeImage !== false) warnings.push('Frame inspection can temporarily seek the live viewer, then restore the playhead. Still images will be shared with the connected model.')
  if (/^(queue_|generate_|regenerate_)/.test(name)) warnings.push('Applying this request can start local generation or spend cloud credits. Review the exact workflow, count and settings.')
  if (name === 'track_comfyui_prompt') warnings.push('Applying this request records a supplied existing ComfyUI prompt in the active Velorn project. It is correlation, not proof of who originally submitted that prompt.')
  if (name === 'control_comfyui_run' && args.operation === 'retry') warnings.push('Retry submits a fresh managed ComfyUI job and can start local generation or spend cloud credits. Review the new explicit graph; stored recipes are not replayed automatically.')
  if (name === 'control_comfyui_run' && args.operation === 'cancel') warnings.push('Cancellation affects only a known prompt that is still queued. Velorn will not interrupt a running job or the global ComfyUI queue.')
  if (name === 'import_comfyui_run_outputs') warnings.push('Applying this request imports the Run\'s recorded output files as project assets. It does not start or retry ComfyUI work.')
  if (name === 'install_workflow_setup') warnings.push('Applying this request can install third-party node code or download model files.')
  if (name === 'install_caption_engine') warnings.push('Downloads the local caption engine/model to this device. Review the size; a native confirmation is required. Installation is not a timeline Undo action.')
  if (name === 'download_agent_model') warnings.push('Downloads a model file into the configured ComfyUI models folder, up to the displayed byte limit. No overwrite or automatic execution. Completed downloads are not undone by Velorn Undo. Review source, destination, size and checksum before approving.')
  if (name === 'cancel_agent_download') warnings.push('Cancels only this project’s selected model-download job and removes its incomplete file. Completed files are kept.')
  if (name === 'run_mcp_action_plan') {
    warnings.push('This preview validates tool names, not each edit. Review every step; the existing MCP action-plan checkpoint/stop-on-error behavior is preserved.')
    if (args.createCheckpointFirst === false) warnings.push('This action plan explicitly disables its safety checkpoint.')
    if (args.stopOnError === false) warnings.push('This action plan explicitly continues after an error; later steps may run after partial failure.')
    if (depth === 0 && Array.isArray(args.steps)) for (const [index, step] of args.steps.slice(0, 50).entries()) {
      const tool = String(step?.tool || step?.name || step?.action || '').trim()
      for (const warning of warningFor(tool, step?.arguments || step?.payload || {}, 1)) warnings.push(`Step ${index + 1} (${tool}): ${warning}`)
    }
  }
  if (name.startsWith('export_')) warnings.push('Applying this request writes delivery files.')
  return warnings
}

/**
 * Native turn-scoped adapter. getContext returns the authoritative renderer
 * envelope {context, selection, playhead}. executeTool must atomically enforce
 * its third argument at the real native/renderer dispatch boundary; the checks
 * here alone cannot close a cross-process check-to-use race.
 *
 * This module never opens an HTTP listener, calls a provider, or accepts an
 * approval claim from model arguments. The host's Full access grant selects the
 * direct native tool path; the optional Ask first mode retains its review policy.
 */
async function createAgentToolSession({ getServer, signal, expectedContext, allowImages = false,
  autoApproveEdits = false, trustedFullAccess = false,
  onEvent = () => {}, requestApproval, getContext, executeTool, limits: overrides = {} } = {}) {
  if (![getServer, getContext, executeTool, requestApproval].every(fn => typeof fn === 'function')) {
    throw new Error('The Agent tool session requires catalog, live-context, dispatch and approval callbacks.')
  }
  if (typeof autoApproveEdits !== 'boolean') throw new Error('autoApproveEdits must be a boolean supplied by the host.')
  if (typeof trustedFullAccess !== 'boolean') throw new Error('trustedFullAccess must be a boolean supplied by the host.')
  const limits = { ...LIMITS, ...overrides }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid Agent tool limit: ${key}.`)
  }
  let identity = null, tail = Promise.resolve(), calls = 0, closedReason = '', uncertainReason = ''
  let reviewBytes = 0, reviewCount = 0
  const applied = new Set(), autoApprovedCalls = new Set(), trustedApprovedCalls = new Set()
  const toolReceipts = createToolReceiptLedger()
  const userWaitingListeners = new Set()
  let userWaiting = false, generationWaits = 0
  const setUserWaiting = value => {
    userWaiting = Boolean(value)
    for (const listener of userWaitingListeners) { try { listener(userWaiting || generationWaits > 0) } catch {} }
  }
  let editCheckpointId = null
  const emit = (callId, toolName, status, summary) => {
    try { onEvent({ type: 'tool', callId, toolName, status, summary,
      ...((autoApprovedCalls.has(callId) || trustedApprovedCalls.has(callId)) ? { autoApproved: true } : {}) }) } catch { /* UI telemetry is not authority. */ }
  }
  const assertActive = () => {
    if (signal?.aborted) throw new Error('The Agent request was canceled. No further tool was dispatched.')
    if (closedReason) throw new Error(closedReason)
  }
  const wait = (operation, timeoutMs, label, userWait = false) => new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true; if (userWait) { timer?.dispose(); setUserWaiting(false) } else clearTimeout(timer)
      signal?.removeEventListener('abort', abort); fn(value)
    }
    const abort = () => finish(reject, new Error('The Agent request was canceled. An already dispatched action may still finish; inspect before retrying.'))
    const timeout = () => finish(reject, new Error(`${label} timed out. Do not automatically retry an already dispatched action.`))
    const timer = userWait ? createPausableTimeout(timeout, timeoutMs ?? 0) : timeoutMs == null ? null : setTimeout(timeout, timeoutMs)
    const onWaiting = waiting => { if (!settled && userWait) { timer.setWaiting(waiting); setUserWaiting(waiting) } }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    Promise.resolve().then(() => operation(onWaiting)).then(value => finish(resolve, value), error => finish(reject, error))
  })
  async function readGuard() {
    assertActive()
    const guard = cloneBounded(await wait(() => getContext(), limits.operationTimeoutMs, 'Project context check'), limits.contextBytes, 'Project context')
    requireContext(guard)
    if (identity && !sameIdentity(identity, guard)) {
      closedReason = 'The active project, timeline or renderer session changed. Start a new Agent message in the intended context.'
      throw new Error(closedReason)
    }
    return guard
  }
  // Full access uses the editor's current state, just like a direct MCP client.
  // Context snapshots are evidence for receipts, not permission gates in this mode.
  async function observeContext() {
    try { return cloneBounded(await wait(() => getContext(), limits.operationTimeoutMs, 'Project inspection'), limits.contextBytes, 'Project context') }
    catch { assertActive(); return null }
  }
  identity = trustedFullAccess ? await observeContext() : await readGuard()
  if (!trustedFullAccess && expectedContext !== undefined && !sameIdentity(expectedContext, identity)) {
    throw new Error('The Agent message belongs to a different project or timeline. Refresh its context and send it again.')
  }

  async function readCatalog() {
    assertActive()
    const server = getServer()
    if (!server || !Array.isArray(server.tools)) throw new Error('The Velorn MCP tool catalog is not available.')
    const catalog = cloneBounded(server.tools, limits.catalogBytes, 'Tool catalog')
    toolReceipts.allow(catalog.map(tool => tool.name))
    return catalog
  }
  async function listTools() { return (await readCatalog()).map(tool => projectConnectedAgentTool(tool, { trustedFullAccess })) }
  async function approve(name, args, guard, preview, callId, warnings) {
    assertActive()
    const approved = await wait(() => requestApproval({ toolName: name,
      arguments: cloneBounded(args, limits.argumentBytes, 'Tool arguments'),
      ...(preview ? { preview: boundedResult(preview, false, limits) } : {}), warnings }), limits.approvalTimeoutMs, 'Tool approval')
    assertActive()
    if (approved !== true) {
      toolReceipts.record(name, 'denied')
      emit(callId, name, 'denied', 'The requested action was not approved.')
      return false
    }
    const current = await readGuard()
    if (stable(current) !== stable(guard)) throw new Error('The project, timeline, selection or playhead changed while approval was pending. Inspect and preview again; nothing was applied.')
    return true
  }
  async function dispatch(name, args, guard, effectful, restoreTarget = null) {
    assertActive()
    if (effectful && uncertainReason) throw new Error(uncertainReason)
    const before = await readGuard()
    if (stable(before) !== stable(guard)) throw new Error('The project, timeline, selection or playhead changed after inspection. Inspect and preview again; nothing was applied.')
    assertActive()
    let result, receipt
    try {
      result = await wait(onWaiting => {
        assertActive()
        // Begin before invoking the actual host operation. Cancellation can
        // return a snapshot immediately; until confirmed, its outcome is unknown.
        receipt = toolReceipts.begin(name)
        return executeTool(name, cloneBounded(args, limits.argumentBytes, 'Tool arguments'), cloneBounded(guard, limits.contextBytes, 'Project context'),
          USER_WAIT_TOOLS.has(name) ? { onWaiting } : undefined)
      }, limits.operationTimeoutMs, 'Tool execution', USER_WAIT_TOOLS.has(name))
      if (!plainObject(result) || !Array.isArray(result.content)) throw new Error('The tool returned an invalid result. Inspect before retrying an action.')
    } catch (error) {
      if (effectful) uncertainReason = 'A dispatched action did not return a confirmed result. Inspect the project before starting a new Agent message; this message will not dispatch further side effects or retry it.'
      throw error
    }
    if (effectful && failedResult(result) && !confirmedNoStart(name, result)) uncertainReason = 'A dispatched action reported an error and may have partially completed. Inspect the project before starting a new Agent message; this message will not retry or dispatch further side effects.'
    // Only an exact native completion may carry this turn into an intentionally
    // selected timeline in the SAME project. Never adopt unrelated navigation.
    try {
      assertActive()
      const after = cloneBounded(await wait(() => getContext(), limits.operationTimeoutMs, 'Post-tool context check'), limits.contextBytes, 'Project context')
      requireContext(after)
      let contextVerified = true
      if (effectful && name === 'restore_project_checkpoint') {
        if (!uncertainReason && confirmedCheckpointRestore(name, args, result, before, after, restoreTarget)) {
          identity = after
          // Restore replaces authored state/history. A checkpoint from the
          // previous edit sequence must not silently cover subsequent edits.
          editCheckpointId = null
        } else {
          closedReason = 'The checkpoint restore returned but its resulting context could not be confirmed. Inspect in a new Agent message; do not repeat the restore.'
          contextVerified = false
        }
      } else if (!sameIdentity(identity, after)) {
        if (effectful && !uncertainReason && confirmedTimelineNavigation(name, args, result, before, after)) {
          identity = after
          editCheckpointId = null
        } else {
          closedReason = 'The tool changed the active project or timeline. Continue with a new Agent message in that context.'
          contextVerified = false
        }
      }
      // Receipt failures cannot change or replay a native action. This records
      // outcomes, not approval authority and not a model's claim of completion.
      try {
        const outcome = classifyDispatchOutcome({ toolName: name, result, readOnly: isRead(name, args),
          effectful, before, after, contextVerified, failed: failedResult(result), confirmedNoStart: confirmedNoStart(name, result) })
        toolReceipts.finish(receipt, outcome)
        // A model-requested checkpoint can cover later edits only after its
        // actual apply has native dispatch proof and unchanged context. Merely
        // previewing a named checkpoint never creates or adopts one.
        if (name === 'create_project_checkpoint' && args.previewOnly === false && effectful
          && outcome === 'applied' && !closedReason && !uncertainReason && stable(before) === stable(after)) {
          const detail = parseResult(result), record = detail?.result || detail
          if (record?.success === true && record.action === name && typeof record.checkpointId === 'string'
            && /^checkpoint-[a-zA-Z0-9_-]{1,180}$/.test(record.checkpointId)) editCheckpointId = record.checkpointId
        }
      }
      catch { toolReceipts.finish(receipt, 'unconfirmed') }
    } catch (error) {
      if (effectful) uncertainReason ||= 'The action returned but its current project context could not be verified. Inspect before starting a new message; do not repeat the action.'
      return boundedResult(result, allowImages, limits, [`Post-action verification failed: ${error.message}. Do not repeat an applied action.`])
    }
    return result
  }
  async function dispatchDirect(name, args, effectful) {
    assertActive()
    const before = await observeContext()
    let receipt, result
    result = await wait(onWaiting => {
      assertActive()
      receipt = toolReceipts.begin(name)
      return executeTool(name, cloneBounded(args, limits.argumentBytes, 'Tool arguments'), before,
        USER_WAIT_TOOLS.has(name) ? { onWaiting } : undefined)
    }, Object.hasOwn(overrides, 'operationTimeoutMs') ? limits.operationTimeoutMs : null, 'Tool execution', USER_WAIT_TOOLS.has(name))
    if (!plainObject(result) || !Array.isArray(result.content)) throw new Error('The tool returned an invalid result. Inspect before retrying an action.')
    const after = await observeContext()
    try {
      toolReceipts.finish(receipt, classifyDispatchOutcome({ toolName: name, result,
        readOnly: isRead(name, args), effectful, before, after,
        contextVerified: Boolean(before && after), failed: failedResult(result), confirmedNoStart: confirmedNoStart(name, result) }))
    } catch { toolReceipts.finish(receipt, 'unconfirmed') }
    return result
  }
  async function runDirect(name, args, definition, callId, notes) {
    // These are review-session controls, not editing operands. Full access
    // executes against today's native state, without an old preview lease.
    delete args.expectedContext
    delete args.previewToken
    delete args.exportPlanToken
    const supportsPreview = Boolean(definition.inputSchema?.properties?.previewOnly)
    if (supportsPreview && args.previewOnly === undefined) args.previewOnly = ROUTER_PLAN_TOOLS.has(name) ? true : false
    if (args.previewOnly !== undefined && typeof args.previewOnly !== 'boolean') {
      return toolArgumentFailure(name, [{ field: 'previewOnly', code: 'boolean_required', message: 'previewOnly must be true or false.' }])
    }
    if (name === 'run_mcp_action_plan' && args.createCheckpointFirst === undefined) args.createCheckpointFirst = false
    const effectful = !isRead(name, args) && args.previewOnly !== true
    trustedApprovedCalls.add(callId)
    emit(callId, name, 'running', args.previewOnly === true ? 'Previewing as requested.' : 'Running with Full access.')
    // These native APIs use a prepared record as their execution input. Prepare
    // it within this call (no model round trip or approval card). Ordinary edits,
    // Undo, exports and file operations go directly to their native handler.
    if (effectful && ['edit_storyboard', 'edit_production_run', 'queue_prepared_generation', 'download_agent_model', 'install_caption_engine'].includes(name)) {
      const preview = await dispatchDirect(name, { ...args, previewOnly: true }, false)
      if (failedResult(preview)) return boundedResult(preview, allowImages, limits, notes)
      const detail = parseResult(preview)
      args = { ...args, ...(detail?.suggestedApplyCall?.arguments || {}),
        ...(detail?.result?.suggestedApplyPayload || {}), ...(detail?.suggestedApplyPayload || {}), previewOnly: false }
    }
    const result = await dispatchDirect(name, args, effectful)
    return boundedResult(result, allowImages, limits, notes)
  }
  async function ensureEditCheckpoint(guard, callId, name) {
    try {
      // Approval authorizes this exact frozen edit plus its prerequisite, not
      // a checkpoint in a context that changed while the user was deciding.
      const current = await readGuard()
      if (closedReason || uncertainReason || stable(current) !== stable(guard)) throw new Error('The project context changed before the safety checkpoint.')
      if (editCheckpointId) return
      const checkpointTool = (await listTools()).find(tool => tool.name === 'create_project_checkpoint')
      if (!checkpointTool?.inputSchema?.properties?.previewOnly) throw new Error('The safety checkpoint tool is unavailable.')
      const checkpointArgs = { label: 'Velorn Agent — before approved undoable edits', previewOnly: true }
      const preview = await dispatch('create_project_checkpoint', checkpointArgs, guard, false)
      const previewDetail = parseResult(preview)
      if (failedResult(preview) || (previewDetail?.previewOnly !== true && previewDetail?.result?.previewOnly !== true)) {
        throw new Error('The safety checkpoint preview was not confirmed.')
      }
      emit(callId, name, 'running', 'Creating a safety checkpoint before the approved undoable edit.')
      const checkpoint = await dispatch('create_project_checkpoint', { ...checkpointArgs, previewOnly: false }, guard, true)
      const detail = parseResult(checkpoint), record = detail?.result || detail
      if (failedResult(checkpoint) || detail?.previewOnly === true || record?.previewOnly === true
        || record?.success !== true || typeof record.checkpointId !== 'string' || !record.checkpointId
        || record.checkpointId.length > 200) throw new Error('The safety checkpoint was not confirmed.')
      const after = await readGuard()
      if (closedReason || uncertainReason || stable(after) !== stable(guard)) throw new Error('The project context changed while creating the safety checkpoint.')
      editCheckpointId = record.checkpointId
    } catch (error) {
      uncertainReason ||= 'The safety checkpoint could not be confirmed. The requested edit was not dispatched; this message will not dispatch further side effects. Inspect before trying a new message.'
      throw new Error(`${uncertainReason} ${error.message}`)
    }
  }
  async function run(name, supplied, callId) {
    assertActive()
    if (typeof name !== 'string' || name.length > 160) throw new Error('A valid tool name is required.')
    const definition = (await readCatalog()).find(tool => tool.name === name)
    if (!definition) throw new Error(`Unknown Velorn tool: ${name}. Read the current tool catalog.`)
    if (!plainObject(supplied)) return toolArgumentFailure(name, [{ field: '$', code: 'object_required', message: 'Tool arguments must be a JSON object.' }])
    let args = cloneBounded(supplied, limits.argumentBytes, 'Tool arguments')
    if (ROUTER_PLAN_TOOLS.has(name)) {
      const checked = normalizeComfyRouterArgs(name, args)
      if (!checked.success) return errorResult(checked.error)
    }
    const originalAutoEligible = isAutoApprovableEdit(name, args)
    const notes = []
    if (!allowImages && IMAGE_TOOLS.has(name) && args.includeImage !== false) {
      args.includeImage = false
      notes.push('Image sharing is disabled for this message. This inspection returned metadata only.')
    }
    if (!allowImages && name === 'run_mcp_action_plan' && Array.isArray(args.steps)) {
      for (const step of args.steps) {
        const tool = String(step?.tool || step?.name || step?.action || '').trim()
        if (!IMAGE_TOOLS.has(tool)) continue
        const key = plainObject(step.arguments) ? 'arguments' : plainObject(step.payload) ? 'payload' : 'arguments'
        step[key] = { ...(step[key] || {}), includeImage: false }
        notes.push('Image sharing is disabled. Nested image inspections were restricted to metadata only.')
      }
    }
    emit(callId, name, 'running', `Inspecting ${name.replaceAll('_', ' ')}.`)
    if (trustedFullAccess) return runDirect(name, args, definition, callId, notes)
    let guard = await readGuard()
    const argumentIssues = validateConnectedAgentArguments(name, args, definition, contextOf(guard), guard.selection)
    if (argumentIssues.length) return toolArgumentFailure(name, argumentIssues)
    if (args.expectedContext !== undefined && stable(args.expectedContext) !== stable(contextOf(guard))) {
      return staleContextFailure(name)
    }
    const readOnly = isRead(name, args)
    const supportsPreview = Boolean(definition.inputSchema?.properties?.previewOnly)
    const previewMayHaveEffects = !SAFE_PREVIEW_TOOLS.has(name)
    const warnings = warningFor(name, args)
    let result
    if (readOnly) {
      result = await dispatch(name, args, guard, false)
    } else if (supportsPreview) {
      if (uncertainReason) throw new Error(uncertainReason)
      const applyRequested = args.previewOnly === false
      const previewArgs = { ...args, previewOnly: true }
      if (previewMayHaveEffects && !await approve(name, previewArgs, guard, null, callId, warnings)) return errorResult('The user declined this tool preview. Nothing was dispatched.')
      const preview = await dispatch(name, previewArgs, guard, previewMayHaveEffects)
      if (failedResult(preview)) return boundedResult(preview, allowImages, limits, notes)
      const detail = parseResult(preview)
      // Never fall through to a write if an unfamiliar tool ignored dry-run.
      if (detail?.previewOnly !== true && detail?.result?.previewOnly !== true) {
        uncertainReason = 'The tool did not confirm a dry-run preview. Inspect its result before starting a new message; no apply call was dispatched.'
        throw new Error(uncertainReason)
      }
      if (!applyRequested) return boundedResult(preview, allowImages, limits, notes)
      if (closedReason || uncertainReason) throw new Error(closedReason || uncertainReason)
      const afterPreview = await readGuard()
      if (stable(afterPreview) !== stable(guard)) throw new Error('The project, timeline, selection or playhead changed during preview. Inspect and preview again; nothing was applied.')
      const suggested = detail?.suggestedApplyCall
      if (suggested?.tool && suggested.tool !== name) throw new Error('The preview suggested a different tool. Inspect that tool separately; nothing was applied.')
      args = { ...args, ...(plainObject(suggested?.arguments) ? suggested.arguments : {}),
        ...(plainObject(detail?.result?.suggestedApplyPayload) ? detail.result.suggestedApplyPayload : {}),
        ...(plainObject(detail?.suggestedApplyPayload) ? detail.suggestedApplyPayload : {}), previewOnly: false }
      args = cloneBounded(args, limits.argumentBytes, 'Previewed apply arguments')
      guard = await readGuard()
      if (args.expectedContext !== undefined && stable(args.expectedContext) !== stable(contextOf(guard))) throw new Error('The project changed during preview. Inspect and preview again; nothing was applied.')
      const restoreTarget = name === 'restore_project_checkpoint' ? freezeCheckpointRestoreTarget(preview, args, guard) : null
      const key = actionKey(name, args)
      if (applied.has(key)) throw new Error('This exact action was already dispatched in this message. Inspect the result; it will not be repeated.')
      // Reclassify the exact frozen apply operands, including the preview's
      // suggestions. Neither the original tool name nor model approval flags
      // are enough to opt an operation into this narrowly scoped permission.
      const needsEditCheckpoint = !previewMayHaveEffects && originalAutoEligible && isAutoApprovableEdit(name, args)
      if (autoApproveEdits && needsEditCheckpoint) {
        await ensureEditCheckpoint(guard, callId, name)
        autoApprovedCalls.add(callId)
        emit(callId, name, 'running', `Auto-approved undoable edit; safety checkpoint ${editCheckpointId}. Applying through Velorn Undo.`)
        notes.push(`Auto-approved under this message's undoable-edit permission. Safety checkpoint: ${editCheckpointId}. Existing Velorn Undo remains available.`)
      } else {
        const applyWarnings = warningFor(name, args)
        if (needsEditCheckpoint) applyWarnings.push(editCheckpointId
          ? 'This edit is covered by the in-memory safety checkpoint already created in this message. Existing Velorn Undo remains available.'
          : 'Approving this edit also creates an in-memory Velorn safety checkpoint before it is applied. Existing Velorn Undo remains available.')
        if (!await approve(name, args, guard, preview, callId, applyWarnings)) return errorResult('The user declined this apply request. The preview did not authorize the edit.')
        if (needsEditCheckpoint) {
          await ensureEditCheckpoint(guard, callId, name)
          notes.push(`Safety checkpoint: ${editCheckpointId}. Existing Velorn Undo remains available.`)
        }
      }
      applied.add(key)
      result = await dispatch(name, args, guard, true, restoreTarget)
      // A fresh preview/recheck may run after a confirmed prerequisite refusal.
      // No generation/export was started; destination folders may now exist.
      if (!uncertainReason && !closedReason && confirmedNoStart(name, result)) applied.delete(key)
    } else {
      if (uncertainReason) throw new Error(uncertainReason)
      const key = actionKey(name, args)
      if (applied.has(key)) throw new Error('This exact side-effectful action was already dispatched in this message. Inspect the result; it will not be repeated.')
      if (!await approve(name, args, guard, null, callId, warnings)) return errorResult('The user declined this action. Nothing was dispatched.')
      applied.add(key)
      result = await dispatch(name, args, guard, true)
    }
    return boundedResult(result, allowImages, limits, notes)
  }
  function callTool(name, args = {}) {
    const callId = `agent-tool-${randomUUID()}`
    if (++calls > (limits.calls ?? Infinity)) {
      const message = 'This Agent message reached its tool-call limit. Review progress before continuing in another message.'
      toolReceipts.record(name, 'failed')
      emit(callId, name, 'failed', message)
      return Promise.resolve(errorResult(message))
    }
    const operation = tail.then(async () => {
      const receiptMark = toolReceipts.mark()
      const recordCallFailure = () => {
        // Keep a dispatched uncertainty or explicit denial, rather than hiding
        // it beneath a generic failure. A pre-dispatch failure can still be
        // recorded after an earlier successful preview or checkpoint.
        if (!['failed', 'denied', 'unconfirmed'].includes(toolReceipts.latestSince(receiptMark, name))) toolReceipts.record(name, 'failed')
      }
      try {
        const result = await run(name, args, callId)
        if (failedResult(result)) recordCallFailure()
        else if (!toolReceipts.latestSince(receiptMark, name)) toolReceipts.record(name, 'returned')
        if (allowImages && !signal?.aborted) {
          for (const frame of require('./connectedAgentReviews.cjs').reviewFrames(name, result)) {
            if (reviewCount >= 12 || reviewBytes + frame.dataUrl.length > 6 * 1024 * 1024) break
            reviewCount++; reviewBytes += frame.dataUrl.length
            try { onEvent({ type: 'review-frame', frame }) } catch { /* A display failure cannot replay a tool. */ }
          }
        }
        const argumentFailure = getNativeArgumentFailure(result)
        emit(callId, name, failedResult(result) ? 'failed' : 'completed', failedResult(result)
          ? argumentFailure?.code === 'INVALID_ARGUMENTS'
            ? `Invalid arguments: ${argumentFailure.error.issues.map(issue => `${issue.field}: ${issue.message}`).join(' ').slice(0, 720)} Nothing was applied.`
            : argumentFailure?.code === 'STALE_EDIT_CONTEXT'
            ? 'The supplied edit context is stale. Inspect and preview again; nothing was applied.'
            : confirmedExportRefusal(name, result)
            ? 'Export did not start: inspect the destination, then preview again. No render was started.'
            : confirmedPrequeueRefusal(name, result)
            ? 'Not queued: workflow dependencies need attention. No generation or setup started; inspect the dependency report and repair before retrying.'
            : `${autoApprovedCalls.has(callId) ? 'Auto-approved edit: ' : ''}The tool reported an error. Review its result.`
          : autoApprovedCalls.has(callId) ? 'Auto-approved undoable edit completed. Velorn Undo and the safety checkpoint remain available.'
            : trustedApprovedCalls.has(callId) ? 'Completed with Full access.' : 'Tool response received.')
        return result
      } catch (error) {
        recordCallFailure()
        emit(callId, name, 'failed', String(error?.message || error).slice(0, 800))
        return errorResult(error?.message || String(error))
      }
    })
    tail = operation.then(() => {}, () => {})
    return operation
  }
  // Host-only native monitor. Reads the existing project ledger, never submits
  // a workflow and never increments the model's tool-call count per poll.
  async function monitorGenerationRuns(args, { signal: waitSignal = signal, onProgress } = {}) {
    assertActive()
    const catalog = await readCatalog()
    if (!catalog.some(item => item.name === 'get_comfyui_runs')) throw new Error('Generation inspection is unavailable.')
    const original = requireContext(await getContext())
    const read = async () => {
      assertActive()
      if (waitSignal?.aborted) throw new Error('Generation monitoring stopped; jobs were not cancelled.')
      const before = await getContext(), current = requireContext(before)
      if (current.projectKey !== original.projectKey || current.session !== original.session) throw new Error('Project changed. Existing generations continue; no further action was taken.')
      const result = await wait(() => executeTool('get_comfyui_runs', {}, before), limits.operationTimeoutMs, 'Read generation ledger')
      const after = requireContext(await getContext())
      if (after.projectKey !== original.projectKey || after.session !== original.session) throw new Error('Project changed while checking generations.')
      if (failedResult(result)) throw new Error('Generation state could not be verified; jobs were not changed.')
      return parseResult(result)
    }
    generationWaits++; setUserWaiting(userWaiting)
    try { return await require('./veloGenerationWait.cjs').waitForGenerationRuns(args, { read, signal: waitSignal, onProgress }) }
    finally { generationWaits--; setUserWaiting(userWaiting) }
  }
  return { listTools, callTool, monitorGenerationRuns, getReceipts: () => toolReceipts.snapshot(),
    subscribeUserWaiting(listener) {
      if (typeof listener !== 'function') return () => {}
      userWaitingListeners.add(listener); listener(userWaiting || generationWaits > 0)
      return () => userWaitingListeners.delete(listener)
    },
  }
}

module.exports = { createAgentToolSession, LIMITS }
