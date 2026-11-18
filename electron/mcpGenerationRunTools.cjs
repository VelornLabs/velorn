'use strict'

// The public MCP descriptions live separately from the native run manager so
// they can be catalogued with the renderer-parity tools without giving the
// renderer ownership of submissions, queue observation, or output records.
const id = { type: 'string', minLength: 1, maxLength: 200 }
const label = { type: 'string', minLength: 1, maxLength: 240 }
const assetIds = { type: 'array', maxItems: 50, uniqueItems: true, items: id,
  description: 'Existing Velorn project asset IDs used by this run. Paths, credentials, and unregistered files are not accepted here.' }
const targetShotId = { ...id, description: 'Optional existing stable storyboard shot ID this run is intended to support.' }
const workflow = {
  type: 'object', minProperties: 1, maxProperties: 1500, additionalProperties: true,
  description: 'Resolved ComfyUI API/prompt graph keyed by node ID. This is not a Velorn Generate form or a UI workflow export.',
}
const workflowJson = {
  type: 'string', minLength: 2, maxLength: 2 * 1024 * 1024,
  description: 'JSON text for one resolved ComfyUI API/prompt graph. It is validated by the native run manager before any submission.',
}
const sourceProperties = { workflow, workflowJson }
const sourceOneOf = [
  { required: ['workflow'] },
  { required: ['workflowJson'] },
]
const savedSourceProperties = {
  workflowId: { ...id, description: 'Exact saved my-workflow: or tpl-mcp- ID from list_velorn_workflows. Inspect includeGraph:true first. Bundled workflows and raw file paths are not accepted by this source.' },
  graphFingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Fingerprint of the saved API graph from inspection or preview. Required when applying a saved workflow; stale copies are rejected.' },
  resolvedFingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Fingerprint of the exact graph after overrides, returned by queue preview. Required on saved-workflow apply with identical overrides; changed inputs are rejected.' },
  inputOverrides: { description: 'Settings on a saved copy: either a named object using queueInputs.namedInputs (for example {prompt:"...",node_129_161_value:5}), or exact [{nodeId,input,value}] entries. Named reference inputs such as asset accept project asset IDs and upload on apply only. Exact media overrides take already uploaded ComfyUI filenames. Never put a project asset ID in an exact scalar filename override.',
    anyOf: [{ type: 'object', maxProperties: 128, additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } },
    { type: 'array', maxItems: 128, items: { type: 'object', additionalProperties: false, required: ['nodeId', 'input', 'value'], properties: {
      nodeId: { type: 'string', minLength: 1, maxLength: 120 }, input: { type: 'string', minLength: 1, maxLength: 160 },
      value: { type: ['string', 'number', 'boolean', 'null'] },
    } } }] },
  templateParameters: { type: 'object', maxProperties: 128, additionalProperties: { type: ['string', 'number', 'boolean', 'null'] }, description: 'Optional named settings from inspection; same mapping as inputOverrides. Do not supply the same target twice.' },
  assetBindings: { type: 'array', maxItems: 16, description: 'Optional exact reference mapping to registered project-owned media. Preview reads/fingerprints only; apply uploads to configured ComfyUI before queuing. Does not modify the saved graph.',
    items: { type: 'object', additionalProperties: false, required: ['nodeId', 'input', 'assetId'], properties: { nodeId: id, input: id, assetId: id } } },
}

const writableTools = [
  'queue_comfyui_workflow',
  'track_comfyui_prompt',
  'control_comfyui_run',
  'import_comfyui_run_outputs',
]

const nativeToolMethods = Object.freeze({
  queue_comfyui_workflow: 'submit',
  get_comfyui_runs: 'list',
  track_comfyui_prompt: 'adopt',
  inspect_comfyui_run: 'recipe',
  control_comfyui_run: 'control',
})
const nativeToolNames = new Set(Object.keys(nativeToolMethods))
const sourceToolNames = new Set(['queue_comfyui_workflow', 'control_comfyui_run'])
const previewToolNames = new Set(['queue_comfyui_workflow', 'track_comfyui_prompt', 'control_comfyui_run'])

const tools = [
  {
    name: 'queue_comfyui_workflow',
    description: 'Preview or submit a saved workflow by stable workflowId or one inline ComfyUI API graph through Velorn\'s native Runs manager, without Generate. Inspect saved workflows with inspect_velorn_workflow(includeGraph:true), then use named or exact inputOverrides and both graphFingerprint and the queue preview\'s resolvedFingerprint on apply. Named reference inputs accept project asset IDs, uploaded only on apply. Preview is the default; applying uses the existing native spending gate and records the run. Saved originals remain unchanged. UI-only legacy entries need the user to open and save them again in ComfyUI to capture an API copy. No arbitrary file path is accepted.',
    inputSchema: {
      type: 'object', additionalProperties: false, oneOf: [...sourceOneOf, { required: ['workflowId'] }],
      properties: {
        ...sourceProperties,
        ...savedSourceProperties,
        label: { ...label, description: 'Optional human-readable run label stored in the active project record.' },
        inputAssetIds: assetIds,
        targetShotId,
        previewOnly: { type: 'boolean', default: true, description: 'true validates only; false requests execution through the native spending broker. Under ask-cloud, false opens human confirmation automatically when needed. Do not wait for an approval dialog before this call; preview and status reads cannot open one. Denial prevents submission.' },
      },
    },
  },
  {
    name: 'get_comfyui_runs',
    description: 'Read Velorn\'s cached native ComfyUI Runs snapshot. This does not contact ComfyUI, mount Generate, submit work, or import outputs, so it may be repeated to inspect known progress. By default it returns the active project only; includeOtherProjects:true is an app-wide read.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        includeOtherProjects: { type: 'boolean', default: false, description: 'Include cached Runs records from other Velorn projects. This remains read-only.' },
      },
    },
  },
  {
    name: 'track_comfyui_prompt',
    description: 'Preview or adopt one explicit existing ComfyUI prompt ID into the active Velorn project. It verifies that ID against the local ComfyUI queue/history before applying. Tracking records Velorn\'s adoption/correlation of the prompt; it cannot prove who originally submitted a direct external prompt. Use this for an existing direct run rather than requeueing it.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['promptId'],
      properties: {
        promptId: { ...id, description: 'Exact ComfyUI prompt_id to adopt. Never infer or substitute an ID.' },
        ...sourceProperties,
        label: { ...label, description: 'Optional human-readable label for the adopted record.' },
        inputAssetIds: assetIds,
        targetShotId,
        previewOnly: { type: 'boolean', default: true },
      },
    },
  },
  {
    name: 'inspect_comfyui_run',
    description: 'Read the stored redacted recipe and state for a managed or explicitly adopted ComfyUI Run. Recipes are descriptive and may report cannotExactReplay:true; inspect never queues, retries, imports, contacts ComfyUI, or claims original-prompt provenance.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['runId'],
      properties: {
        runId: { ...id, description: 'Velorn run ID from get_comfyui_runs.' },
        includeOtherProjects: { type: 'boolean', default: false, description: 'Permit inspection of an explicitly named cached run from another Velorn project. This remains read-only.' },
      },
    },
  },
  {
    name: 'control_comfyui_run',
    description: 'Preview or control one known Velorn Run. cancel only removes a still-queued known prompt; it never interrupts a running job or changes the global ComfyUI queue. retry is a new managed submission through the same spending gate and requires a fresh inline workflow/workflowJson graph; stored redacted recipes are never silently replayed.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['runId', 'operation'],
      properties: {
        runId: { ...id, description: 'Velorn run ID from get_comfyui_runs.' },
        operation: { type: 'string', enum: ['cancel', 'retry'] },
        ...sourceProperties,
        label: { ...label, description: 'Optional label for the fresh retry record.' },
        inputAssetIds: assetIds,
        targetShotId,
        previewOnly: { type: 'boolean', default: true },
      },
      allOf: [{
        if: { properties: { operation: { const: 'retry' } }, required: ['operation'] },
        then: { oneOf: sourceOneOf },
      }],
    },
  },
  {
    name: 'import_comfyui_run_outputs',
    description: 'Preview or import completed output files already recorded for one Velorn ComfyUI Run into the active project. This is separate from queueing/tracking, uses the renderer\'s normal project asset path, and never starts or retries a ComfyUI job.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['runId'],
      properties: {
        runId: { ...id, description: 'Velorn run ID whose recorded outputs should be imported.' },
        previewOnly: { type: 'boolean', default: true },
      },
    },
  },
]

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sourceKeys(args) {
  return ['workflow', 'workflowJson'].filter((key) => {
    const value = args?.[key]
    return value !== undefined && value !== null && value !== ''
  })
}

function defaultPreviewOnly(name, args = {}) {
  return previewToolNames.has(name) && typeof args?.previewOnly !== 'boolean' ? true : undefined
}

function failure(code, error) {
  return { success: false, code, error }
}

// Runs deliberately has no filePath input. Passing a path
// through MCP would create a new restricted-agent file-read authority. A
// Full-computer-access agent may read an authorized file itself and submit its
// resolved API graph inline; restricted sessions can inspect/import and
// resolve a saved library ID without acquiring unrelated file-read authority.
async function normalizeGenerationRunArgs(name, args = {}) {
  if (!plainObject(args)) return failure('GENERATION_RUNS_INVALID_REQUEST', 'Provide a generation run request object.')
  const payload = { ...args }
  const previewOnly = defaultPreviewOnly(name, payload)
  if (previewOnly !== undefined) payload.previewOnly = previewOnly

  if (!sourceToolNames.has(name)) return { success: true, args: payload }
  const supplied = sourceKeys(payload)
  if (name === 'queue_comfyui_workflow' && payload.workflowId !== undefined) supplied.push('workflowId')
  if (name === 'control_comfyui_run' && payload.operation !== 'retry') {
    if (supplied.length) return failure('GENERATION_RUNS_INVALID_REQUEST', 'Only retry accepts a workflow source.')
    return { success: true, args: payload }
  }
  if (supplied.length !== 1) {
    return failure('GENERATION_RUNS_INVALID_REQUEST', name === 'queue_comfyui_workflow'
      ? 'Provide exactly one of workflow, workflowJson, or saved workflowId.' : 'Provide exactly one of workflow or workflowJson.')
  }
  if (name === 'queue_comfyui_workflow' && !supplied.includes('workflowId') && (payload.inputOverrides !== undefined || payload.templateParameters !== undefined || payload.assetBindings !== undefined || payload.graphFingerprint !== undefined || payload.resolvedFingerprint !== undefined)) {
    return failure('GENERATION_RUNS_INVALID_REQUEST', 'inputOverrides and fingerprints require a saved workflowId.')
  }
  return { success: true, args: payload }
}

async function dispatchGenerationRunTool({ generationRuns, name, args = {} } = {}) {
  const method = nativeToolMethods[name]
  if (!method) return failure('GENERATION_RUNS_INVALID_REQUEST', `Unsupported ComfyUI Runs tool: ${String(name || '')}.`)
  if (!generationRuns || typeof generationRuns[method] !== 'function') {
    return failure('GENERATION_RUNS_UNAVAILABLE', 'ComfyUI Runs are unavailable. Restart Velorn and try again.')
  }
  const normalized = await normalizeGenerationRunArgs(name, args)
  if (normalized.success !== true) return normalized
  try {
    const result = await generationRuns[method](normalized.args)
    return plainObject(result)
      ? result
      : failure('GENERATION_RUNS_INVALID_RESULT', 'The native ComfyUI Runs manager returned an invalid result. Inspect the queue before retrying.')
  } catch (error) {
    return failure(error?.code || 'GENERATION_RUNS_FAILED',
      error?.publicMessage || 'The ComfyUI Runs request could not be completed. Inspect the queue before retrying.')
  }
}

module.exports = {
  tools,
  writableTools,
  nativeToolNames,
  nativeToolMethods,
  defaultPreviewOnly,
  normalizeGenerationRunArgs,
  dispatchGenerationRunTool,
}
