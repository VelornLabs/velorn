'use strict'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.hasOwn(value, key)
const SINGLE_TARGETS = ['clipId', 'clipAId', 'clipBId', 'sourceClipId', 'destinationClipId']
const MANY_TARGETS = ['clipIds', 'targetClipIds', 'destinationClipIds']
const NULLABLE_CONTEXT_IDS = new Set(['projectKey', 'timelineId', 'compoundClipId'])
const HOST_PREVIEW_TOOLS = new Set(['set_clip_style', 'set_clip_color', 'edit_clip_effects', 'paste_clip_attributes',
  'trim_clips', 'edit_trim', 'edit_source', 'replace_clip_with_asset', 'create_compound', 'uncompound',
  'add_transition', 'update_transition', 'remove_transitions', 'open_compound', 'close_compound', 'rename_compound'])
const nativeArgumentFailures = new WeakMap()

function nativeFailureResult(detail) {
  const result = { isError: true, content: [{ type: 'text', text: JSON.stringify(detail) }] }
  nativeArgumentFailures.set(result, detail)
  return result
}
const getNativeArgumentFailure = result => nativeArgumentFailures.get(result) || null

function encodedCollection(value) {
  if (typeof value !== 'string' || !/^[\s]*[\[{]/.test(value)) return false
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) || object(parsed) } catch { return false }
}
const exactId = value => typeof value === 'string' && value.trim().length > 0 && !encodedCollection(value)

/** Small shared contract checks, not a second full schema validator. All
 * authoritative target resolution/planning still happens in the real tool.
 * Never normalize a supplied ID, replace a supplied context, or execute a fix.
 */
function validateConnectedAgentArguments(name, args, definition, currentContext, currentSelection) {
  const issues = []
  const add = (field, code, message) => { if (issues.length < 12) issues.push({ field, code, message }) }
  if (!object(args)) {
    add('$', 'object_required', 'Tool arguments must be a JSON object.')
    return issues
  }
  if (own(args, 'previewOnly') && typeof args.previewOnly !== 'boolean') {
    add('previewOnly', 'boolean_required', 'previewOnly must be a boolean: true for preview, false to request an approved apply.')
  }
  for (const field of ['previewToken', 'exportPlanToken']) {
    if (own(args, field) && (typeof args[field] !== 'string' || !args[field].trim())) {
      add(field, 'token_required', 'Use the exact nonempty token returned by Velorn. Do not construct a token.')
    }
  }
  if (own(args, 'expectedContext')) {
    const expected = args.expectedContext
    const keys = object(currentContext) ? Object.keys(currentContext) : []
    if (!object(expected)) add('expectedContext', 'object_required', 'expectedContext must be the complete unmodified context object returned by Velorn.')
    else if (!keys.length || keys.some(key => !own(expected, key))) {
      add('expectedContext', 'incomplete_context', 'expectedContext is incomplete. For a new host-managed preview, omit this optional field; never supply an empty or reconstructed context.')
    } else if (Object.keys(expected).some(key => !own(currentContext, key))) {
      add('expectedContext', 'unknown_context_fields', 'expectedContext contains fields outside the returned context. Copy the returned object unchanged.')
    } else if (keys.some(key => {
      const value = expected[key], current = currentContext[key]
      if (NULLABLE_CONTEXT_IDS.has(key)) return value !== null && (typeof value !== 'string' || !value)
      if (typeof current === 'number') return typeof value !== 'number' || !Number.isFinite(value)
        || (Number.isInteger(current) && !Number.isInteger(value))
      if (typeof current === 'string') return typeof value !== 'string' || !value
      if (Array.isArray(current)) return !Array.isArray(value)
      if (object(current)) return !object(value)
      return current === null ? value !== null : typeof value !== typeof current
    })) add('expectedContext', 'invalid_context_shape', 'expectedContext field types do not match the context returned by Velorn. Do not reconstruct it.')
  }
  const properties = definition?.inputSchema?.properties || {}
  const single = (field, value) => {
    if (!exactId(value)) add(field, 'single_id_required', 'Use one exact clip ID string returned by inspection, not an array or a JSON-encoded array/object.')
  }
  for (const field of SINGLE_TARGETS) if (own(args, field) && (own(properties, field) || name === 'edit_trim')) single(field, args[field])
  for (const field of MANY_TARGETS) {
    if (!own(args, field) || (!own(properties, field) && name !== 'edit_trim')) continue
    const value = args[field]
    if (!Array.isArray(value) || value.some(item => !exactId(item))) {
      add(field, 'id_array_required', 'Use an array of exact clip ID strings returned by inspection, not a JSON-encoded string or nested arrays.')
    } else if ((properties[field]?.minItems > value.length) || (name === 'edit_trim' && !value.length)) {
      add(field, 'nonempty_targets_required', 'Provide at least one exact target clip ID, or omit the optional target list to use supported selection behavior.')
    }
  }
  if (name === 'trim_clips' && Array.isArray(args.clips)) {
    for (const [index, clip] of args.clips.entries()) {
      if (issues.length >= 12) break
      if (!object(clip)) add(`clips[${index}]`, 'object_required', 'Each trim entry must be an object with one exact clipId.')
      else single(`clips[${index}].clipId`, clip.clipId)
    }
  }
  if (name === 'edit_trim') {
    // Keep the native legacy `trim`, `delta`, `in` and `out` aliases accepted;
    // the public tool's canonical fields stay mode/deltaSeconds/edge.
    if (!['normal', 'trim', 'roll', 'slip', 'slide', 'ripple'].includes(args.mode)) {
      add('mode', 'trim_mode_required', 'Choose normal, roll, slip, slide, or ripple.')
    }
    const delta = args.deltaSeconds ?? args.delta
    if (typeof delta !== 'number' || !Number.isFinite(delta)) add('deltaSeconds', 'number_required', 'Provide a finite numeric trim delta in seconds.')
    if (['normal', 'trim', 'ripple'].includes(args.mode) && !['start', 'end', 'left', 'right', 'in', 'out'].includes(args.edge)) {
      add('edge', 'trim_edge_required', 'Normal and ripple trims require an edge: start or end (left/right aliases are also accepted).')
    }
    // Selection comes only from the native interaction guard, never from model
    // arguments or chat history. A legacy preview token may already bind a
    // resolved target; only the renderer can validate that token and its input.
    // Do not substitute today's selection for a token's frozen target.
    const hasPreviewToken = typeof args.previewToken === 'string' && args.previewToken.trim().length > 0
    if (args.mode === 'roll') {
      for (const field of ['clipAId', 'clipBId']) if (!own(args, field) && !hasPreviewToken) {
        add(field, 'roll_target_required', 'Roll requires exact inspected clipAId (outgoing) and clipBId (incoming) for the adjacent pair. Selection and clipId do not supply this pair.')
      }
      if (exactId(args.clipAId) && args.clipAId === args.clipBId) {
        add('clipBId', 'distinct_roll_targets_required', 'Roll requires two distinct adjacent clip IDs, not the same clip twice.')
      }
    } else if (['normal', 'trim', 'ripple', 'slip', 'slide'].includes(args.mode)) {
      const selected = currentSelection?.clipIds
      const primary = own(args, 'clipId') ? args.clipId
        : !hasPreviewToken && Array.isArray(selected) && selected.length === 1 && exactId(selected[0]) ? selected[0] : undefined
      if (!own(args, 'clipId') && !exactId(primary) && !hasPreviewToken) {
        add('clipId', 'trim_target_required', 'Supply the exact primary clipId from get_timeline or inspect_clip in this call; selecting it first is not required. Omitting clipId only works with exactly one currently selected clip. A previous preview or a target list alone does not carry the target into a new call.')
      }
      // Keep native alias precedence; an unused secondary alias is not a new
      // targeting rule. Membership is checked, never repaired or inferred.
      const field = args.targetClipIds ? 'targetClipIds' : 'clipIds'
      const targets = args[field]
      if (['normal', 'trim', 'ripple'].includes(args.mode) && exactId(primary)
        && Array.isArray(targets) && targets.length && targets.every(exactId) && !targets.includes(primary)) {
        add(field, 'primary_target_required', 'The normal/ripple target list must include its primary clipId (or the single selected primary). Keep that exact ID in the list; the list does not replace clipId.')
      }
    }
  }
  return issues
}

function toolArgumentFailure(name, issues) {
  const detail = { success: false, code: 'INVALID_ARGUMENTS', action: name, actionExecuted: false, outcome: 'not-started',
    error: { code: 'INVALID_ARGUMENTS', message: 'Invalid tool arguments. Nothing was dispatched or applied.', issues },
    nextAction: 'Correct the listed fields before making a new request. Do not repeat unchanged arguments; no correction or retry has been executed automatically.' }
  return nativeFailureResult(detail)
}

function staleContextFailure(name) {
  const detail = { success: false, code: 'STALE_EDIT_CONTEXT', action: name, actionExecuted: false, outcome: 'not-started',
    error: { code: 'STALE_EDIT_CONTEXT', message: 'The supplied edit context is stale. Inspect and preview again; nothing was applied.' },
    nextAction: 'Inspect the current project and obtain a fresh preview. Do not reuse or silently replace an old reviewed context.' }
  return nativeFailureResult(detail)
}

/** Only the connected-agent view omits these host-owned controls. External
 * MCP clients keep the original schema and preview/apply protocol unchanged.
 * Explicit legacy controls are still validated and enforced when supplied.
 */
function projectConnectedAgentTool(definition, { trustedFullAccess = false } = {}) {
  // A paid Router request consumes a native, user-reviewed plan in every
  // access mode. Full access cannot turn a prompt-only call into a submission
  // or remove the provider's separate spending confirmation.
  if (definition.name === 'generate_comfy_router_image' || definition.name === 'generate_create_media') return definition
  if (trustedFullAccess) {
    const schema = definition.inputSchema || { type: 'object', properties: {} }
    const { expectedContext, previewToken, exportPlanToken, ...properties } = schema.properties || {}
    const required = schema.required?.filter(key => !['expectedContext', 'previewToken', 'exportPlanToken'].includes(key))
    return { ...definition,
      description: `${definition.description || ''} Full access is enabled: requested actions run directly, without separate approval or a mandatory preview/checkpoint. This overrides review-policy instructions in the generic tool description. Explicit previewOnly:true still requests a dry run.`,
      inputSchema: { ...schema, properties: { ...properties,
        ...(properties.previewOnly ? { previewOnly: { ...properties.previewOnly, default: false,
          description: 'Optional. Omit or set false to apply now. Set true only when a dry-run preview is requested.' } } : {}),
        ...(definition.name === 'run_mcp_action_plan' && properties.createCheckpointFirst ? {
          createCheckpointFirst: { ...properties.createCheckpointFirst, default: false, description: 'Optional checkpoint before the plan; not required in Full access.' },
        } : {}),
      }, ...(required ? { required } : {}) } }
  }
  if (!HOST_PREVIEW_TOOLS.has(definition.name) || !definition.inputSchema?.properties?.previewOnly) return definition
  const schema = definition.inputSchema
  // Do not partially rewrite a future conditional schema with hidden controls.
  if (schema.allOf || schema.anyOf || schema.oneOf || schema.if || schema.dependencies) return definition
  const { expectedContext, previewToken, ...properties } = schema.properties
  const required = schema.required?.filter(key => !['expectedContext', 'previewToken'].includes(key))
  return { ...definition,
    description: `${definition.description || ''} For connected agents, Velorn manages fresh previews, tokens and context checks; supply editing operands and previewOnly, not reconstructed control fields.`,
    inputSchema: { ...schema, properties: { ...properties,
      previewOnly: { ...properties.previewOnly,
        description: 'True previews only. False asks Velorn to create/check the preview, obtain required approval, and apply it. Preview tokens and context are managed by Velorn.' },
      ...(definition.name === 'edit_trim' && properties.edge ? { edge: { ...properties.edge,
        description: 'Required for normal and ripple modes: start or end (left/right aliases accepted). Choose the edge explicitly; it is not inferred.' } } : {}),
    }, ...(required ? { required } : {}) } }
}

module.exports = { validateConnectedAgentArguments, toolArgumentFailure, staleContextFailure, projectConnectedAgentTool, getNativeArgumentFailure }
