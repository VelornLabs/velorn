'use strict'

// Router tools only address the fixed native preset and native-owned plans/jobs.
// Credential handling, spending confirmation and project/session checks remain
// in the native manager; retrieving/importing an output remains renderer-owned.
const PROMPT_MAX_LENGTH = 4000
const id = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$' }
const previewOnly = { type: 'boolean', default: true }
const writableTools = ['generate_comfy_router_image', 'generate_create_media', 'control_comfy_router_image', 'import_comfy_router_image']
const nativeToolNames = new Set(['get_comfy_router_status', 'get_create_models', 'generate_comfy_router_image', 'generate_create_media', 'control_comfy_router_image'])
// The choices a Create request may carry. Which of them a given model takes, and
// their allowed values, are checked by the native manager against its model list.
const CREATE_CHOICES = ['shape', 'size', 'seconds', 'resolution', 'voice', 'loop', 'pictureUse']
const previewToolNames = new Set(writableTools)

const tools = [
  {
    name: 'get_comfy_router_status',
    description: 'Read Velorn\'s cached Comfy Router readiness and image jobs. This does not contact Comfy, verify an account, reveal a key, generate, refresh jobs, download media or import outputs. Existing Cloud account checks do not prove Router readiness.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'generate_comfy_router_image',
    description: 'Preview one image from Velorn\'s fixed Comfy Router preset using a prompt, then apply the returned planId in a separate call. Preview is the default and does not generate or spend. Preview with only planId is a pure review of that exact existing plan; it cannot replace its prompt, renew it or create another plan. Apply requires previewOnly:false and only the original planId, not a new prompt. Every paid apply requires native human confirmation regardless of agent access; denial prevents submission. No arbitrary model, URL, workflow, key or spending-policy change is supported. Generation does not import the image into the project.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: PROMPT_MAX_LENGTH, description: 'Image description for preview only. Keep credentials and private account details out of prompts.' },
        planId: { ...id, description: 'Exact native plan ID returned by preview. Use alone to review that unchanged plan or explicitly apply it. An expired plan requires a new prompt preview.' },
        previewOnly,
      },
      oneOf: [
        { required: ['prompt'], properties: { previewOnly: { const: true } }, not: { required: ['planId'] } },
        { required: ['planId'], properties: { previewOnly: { const: true } }, not: { required: ['prompt'] } },
        { required: ['planId', 'previewOnly'], properties: { previewOnly: { const: false } }, not: { required: ['prompt'] } },
      ],
    },
  },
  {
    name: 'get_create_models',
    description: 'Read the models of Velorn\'s Visuals and Sound tabs (Visuals was called Create before) that run through Comfy Router: picture, video, voice and sound-effect models, with each model\'s id, kind, choices (sizes, lengths, resolutions), recorded prices in US dollars, and the voice list. This reads a list kept in Velorn: it does not contact Comfy, reveal a key, check credits, generate or spend. Use the ids with generate_create_media.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'generate_create_media',
    description: 'Make a picture, a video clip, speech or a sound effect with one of the Visuals and Sound models from get_create_models. Two steps. Preview (the default) takes modelId, prompt and that model\'s choices (shape, size, seconds, resolution, voice, loop, count, inputImageAssetId, pictureUse; the kind comes from the model, there is no kind field) and returns a planId with the estimated price; it does not generate or spend, and an input picture is not sent anywhere by a preview. Apply takes only that planId with previewOnly:false. Every apply needs the person\'s own spending confirmation, on the computer or on their paired phone, in every access mode; if they decline, nothing is sent. One plan is one request (or 2 or 4 pictures with count), never resent. A finished result is added to the project with import_comfy_router_image and followed with control_comfy_router_image, using the returned jobId. For speech, prompt is the words to say and voice is required. No arbitrary model, URL, workflow, key or spending-policy change is supported.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        modelId: { ...id, description: 'A model id from get_create_models.' },
        prompt: { type: 'string', minLength: 1, maxLength: PROMPT_MAX_LENGTH, description: 'What to make. For a voice model, the words to say. Keep credentials and private account details out of prompts.' },
        shape: { type: 'string', enum: ['landscape', 'square', 'portrait'], description: 'Pictures and video. Default landscape.' },
        size: { type: 'string', maxLength: 8, description: 'Pictures: one of the model\'s sizes, for example 1K, 2K or 4K. Default 1K.' },
        seconds: { type: 'integer', minimum: 1, maximum: 600, description: 'Video and sound effects: the length, within the model\'s limits.' },
        resolution: { type: 'string', maxLength: 8, description: 'Video: one of the model\'s resolutions, for example 720p. Default 720p.' },
        voice: { type: 'string', maxLength: 64, description: 'Voice models: a voice id from get_create_models.' },
        loop: { type: 'boolean', description: 'Sound effects: make the end run smoothly back into the start.' },
        count: { type: 'integer', enum: [1, 2, 4], description: 'Pictures only: how many to make. Each is its own request and is charged separately.' },
        inputImageAssetId: { ...id, description: 'Optional image asset of the open project to edit or draw from (pictures), or to start a clip from or use as a reference (video). It must be a PNG, JPEG or WebP file inside the project, at most 10 MB.' },
        pictureUse: { type: 'string', enum: ['start', 'reference'], description: 'Video with inputImageAssetId: start the clip from the picture (default) or use it as a reference.' },
        planId: { ...id, description: 'Exact native plan ID returned by preview. Use alone to review that unchanged plan or explicitly apply it. An expired plan requires a new preview.' },
        previewOnly,
      },
      // Deliberately no oneOf here. A host that turns this schema into a call
      // signature kept only the branch properties and hid every field above, so
      // the first real agent guessed one. The combinations (describe a request
      // to preview it; planId alone to review or apply it) are enforced by
      // normalizeComfyRouterArgs, which answers with the exact problem.
    },
  },
  {
    name: 'control_comfy_router_image',
    description: 'Preview or refresh/cancel one known native Comfy Router image job. Preview reads cached jobs only. Refresh contacts Comfy for current status only when a generation job ID exists; rejected submissions retain their cached rejection details without another request. A support request ID is diagnostic correlation, not a generation job ID. Refresh never submits a new generation or downloads the image. Cancel is best-effort and provider work already started may still finish and be charged. This cannot retry, regenerate, control another provider or change account/spending settings.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['jobId', 'operation'],
      properties: {
        jobId: { ...id, description: 'Exact Velorn Router job ID from the cached status snapshot.' },
        operation: { type: 'string', enum: ['refresh', 'cancel'] },
        previewOnly,
      },
    },
  },
  {
    name: 'import_comfy_router_image',
    description: 'Preview or retrieve and import one completed Comfy Router image into the active Velorn project using its normal asset/checkpoint path. Preview reads cached state only. Apply retrieves the image through the native fixed-provider result route, then imports it; this is separate from paid generation. Only a known jobId is accepted, never an arbitrary URL, model or key. It does not generate a new image or modify provider settings. It also works for clips and sounds made with generate_create_media. Once imported, the result is shown in your reply and on the person\'s paired phone by itself: a picture as a still, a clip or sound as a player. To show an older picture, clip or sound again, use get_assets with its assetId and showInChat:true.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['jobId'],
      properties: {
        jobId: { ...id, description: 'Exact Velorn Router job ID whose completed image should be retrieved and imported.' },
        previewOnly,
      },
    },
  },
]

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function failure(code, error) {
  return { success: false, code, error }
}

function invalid(error) {
  return failure('COMFY_ROUTER_INVALID_REQUEST', error)
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(value)
}

function defaultPreviewOnly(name, args = {}) {
  return previewToolNames.has(name) && args?.previewOnly === undefined ? true : undefined
}

function normalizeComfyRouterArgs(name, args = {}) {
  if (!plainObject(args)) return invalid('Provide a Comfy Router request object.')
  const allowed = {
    get_comfy_router_status: [],
    get_create_models: [],
    generate_comfy_router_image: ['prompt', 'planId', 'previewOnly', 'expectedContext'],
    generate_create_media: ['modelId', 'prompt', ...CREATE_CHOICES, 'count', 'inputImageAssetId', 'planId', 'previewOnly', 'expectedContext'],
    control_comfy_router_image: ['jobId', 'operation', 'previewOnly', 'expectedContext'],
    import_comfy_router_image: ['jobId', 'previewOnly', 'expectedContext'],
  }[name]
  if (!allowed) return invalid('Unsupported Comfy Router tool.')
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unknown.length) return invalid(`Unsupported Comfy Router request field${unknown.length > 1 ? 's' : ''}: ${unknown.slice(0, 5).map((key) => String(key).slice(0, 40)).join(', ')}. ${allowed.length ? `This tool takes: ${allowed.filter((key) => key !== 'expectedContext').join(', ')}.` : 'This tool takes no fields.'}`)
  // expectedContext is checked by the native/renderer dispatch boundary, never
  // interpreted as a provider payload or a replacement for a native plan.
  const { expectedContext, ...payload } = args
  if (previewToolNames.has(name)) {
    if (payload.previewOnly !== undefined && typeof payload.previewOnly !== 'boolean') return invalid('previewOnly must be a boolean.')
    payload.previewOnly ??= true
  }
  if (name === 'generate_comfy_router_image') {
    if (payload.previewOnly) {
      if (Object.hasOwn(payload, 'planId')) {
        if (!validId(payload.planId) || Object.hasOwn(payload, 'prompt')) return invalid('Review an existing plan with only its exact planId, without a prompt override.')
      } else if (typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.length > PROMPT_MAX_LENGTH) {
        return invalid(`Provide a nonempty image prompt of at most ${PROMPT_MAX_LENGTH} characters.`)
      }
    } else if (!validId(payload.planId) || Object.hasOwn(payload, 'prompt')) {
      return invalid('Apply requires only the previewed planId and previewOnly:false; do not supply a prompt.')
    }
  }
  if (name === 'generate_create_media') {
    const described = ['modelId', 'prompt', ...CREATE_CHOICES, 'count', 'inputImageAssetId'].filter((key) => Object.hasOwn(payload, key))
    if (Object.hasOwn(payload, 'planId')) {
      // A plan is reviewed or applied exactly as it was previewed.
      if (!validId(payload.planId) || described.length) return invalid(payload.previewOnly
        ? 'Review an existing plan with only its exact planId.' : 'Apply requires only the previewed planId and previewOnly:false; do not describe the request again.')
    } else if (!payload.previewOnly) {
      return invalid('Apply requires the planId returned by a preview and previewOnly:false.')
    } else {
      if (!validId(payload.modelId)) return invalid('Choose a modelId from get_create_models.')
      if (typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.length > PROMPT_MAX_LENGTH) return invalid(`Provide a nonempty prompt of at most ${PROMPT_MAX_LENGTH} characters.`)
      if (Object.hasOwn(payload, 'count') && ![1, 2, 4].includes(payload.count)) return invalid('count must be 1, 2 or 4.')
      if (Object.hasOwn(payload, 'inputImageAssetId') && !validId(payload.inputImageAssetId)) return invalid('inputImageAssetId must be an image asset id from the open project.')
      if (Object.hasOwn(payload, 'pictureUse') && !Object.hasOwn(payload, 'inputImageAssetId')) return invalid('pictureUse needs inputImageAssetId.')
    }
  }
  if (name === 'control_comfy_router_image' || name === 'import_comfy_router_image') {
    if (!validId(payload.jobId)) return invalid('Provide the exact cached Router jobId.')
    if (name === 'control_comfy_router_image' && !['refresh', 'cancel'].includes(payload.operation)) {
      return invalid('Choose refresh or cancel for this Router image job.')
    }
  }
  return { success: true, args: payload }
}

function validResult(value) {
  return plainObject(value) && typeof value.success === 'boolean'
}

function invalidResult() {
  return failure('COMFY_ROUTER_INVALID_RESULT', 'The native Router manager returned an invalid result. Inspect cached jobs before retrying.')
}

async function dispatchComfyRouterTool({ comfyRouter, name, args = {} } = {}) {
  if (!nativeToolNames.has(name)) return invalid('Unsupported native Comfy Router tool.')
  const normalized = normalizeComfyRouterArgs(name, args)
  if (!normalized.success) return normalized
  const payload = normalized.args
  const methods = name === 'get_comfy_router_status' ? ['status', 'list']
    : name === 'get_create_models' ? ['models']
    : name === 'generate_comfy_router_image' ? [payload.previewOnly ? Object.hasOwn(payload, 'planId') ? 'inspectPlan' : 'preview' : 'submit']
    : name === 'generate_create_media' ? [payload.previewOnly ? Object.hasOwn(payload, 'planId') ? 'inspectPlan' : 'previewCreate' : 'submit']
      : [payload.previewOnly ? 'list' : payload.operation]
  if (!comfyRouter || methods.some((method) => typeof comfyRouter[method] !== 'function')) {
    return failure('COMFY_ROUTER_UNAVAILABLE', 'Comfy Router is unavailable. Restart Velorn and try again.')
  }
  try {
    if (name === 'get_comfy_router_status') {
      const status = await comfyRouter.status({})
      if (!validResult(status)) return invalidResult()
      if (!status.success) return status
      const snapshot = await comfyRouter.list({})
      if (!validResult(snapshot)) return invalidResult()
      if (!snapshot.success) return snapshot
      if (!Array.isArray(snapshot.jobs)) return invalidResult()
      return { ...status, jobs: snapshot.jobs }
    }
    if (name === 'control_comfy_router_image' && payload.previewOnly) {
      const snapshot = await comfyRouter.list({})
      if (!validResult(snapshot)) return invalidResult()
      if (!snapshot.success) return snapshot
      if (!Array.isArray(snapshot.jobs)) return invalidResult()
      const job = snapshot.jobs.find((entry) => plainObject(entry) && entry.jobId === payload.jobId)
      if (!job) return failure('COMFY_ROUTER_JOB_NOT_FOUND', 'This Router image job is not in the current cached snapshot.')
      return {
        success: true, previewOnly: true, applied: false, jobId: payload.jobId,
        operation: payload.operation, job,
        summary: payload.operation === 'cancel'
          ? 'Would request cancellation. Work already started may still finish and be charged.'
          : job.canRefresh === false
            ? job.errorMessage || 'There is no confirmed generation job ID to refresh. Inspect the cached result or your Comfy account; no new generation is submitted.'
            : 'Would refresh the status of this known Router job. No new generation or output download is requested.',
      }
    }
    if (name === 'get_create_models') {
      const listed = await comfyRouter.models({})
      if (!validResult(listed)) return invalidResult()
      return listed
    }
    let input
    if (name === 'generate_create_media' && !Object.hasOwn(payload, 'planId')) {
      // Only the choices that were given are passed on; the manager fills in each
      // model's defaults and refuses a choice the model does not take.
      const choices = { prompt: payload.prompt }
      for (const key of CREATE_CHOICES) if (Object.hasOwn(payload, key)) choices[key] = payload[key]
      input = { modelId: payload.modelId, choices, ...(Object.hasOwn(payload, 'count') ? { count: payload.count } : {}),
        ...(Object.hasOwn(payload, 'inputImageAssetId') ? { inputImageAssetId: payload.inputImageAssetId } : {}) }
    } else {
      input = name === 'generate_comfy_router_image' || name === 'generate_create_media'
        ? Object.hasOwn(payload, 'planId') ? { planId: payload.planId } : { prompt: payload.prompt }
        : { jobId: payload.jobId }
    }
    const result = await comfyRouter[methods[0]](input)
    if (!validResult(result)) return invalidResult()
    return result.success && payload.previewOnly ? { ...result, previewOnly: true, applied: false } : result
  } catch {
    // Provider/native exceptions may contain credentials or signed URLs. Never
    // turn an arbitrary thrown message into an agent-visible diagnostic.
    return failure('COMFY_ROUTER_FAILED', 'The Router request could not be completed. Inspect cached jobs before retrying; do not submit a new generation to recover an existing one.')
  }
}

module.exports = {
  tools, writableTools, nativeToolNames, defaultPreviewOnly,
  normalizeComfyRouterArgs, dispatchComfyRouterTool,
}
