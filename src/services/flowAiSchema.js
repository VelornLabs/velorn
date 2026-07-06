import { WORKFLOWS, getWorkflowDisplayLabel, getWorkflowHardwareInfo } from '../config/generateWorkspaceConfig'
import {
  TOPAZ_VIDEO_UPSCALE_DEFAULTS,
  TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID,
} from '../config/topazVideoUpscaleConfig'
import { normalizeCreditsEstimate } from '../utils/comfyCredits'

export const FLOW_AI_VERSION = 1
export const FLOW_AI_ASSET_ROOT_FOLDER = 'Flow AI'
export const FLOW_AI_IMAGE_VARIANT_LIMIT = 10
const FLOW_AI_AUTO_OUTPUT_FOLDERS = Object.freeze({
  image: ['Flow AI Images'],
  video: ['Flow AI Videos'],
  audio: ['Flow AI Audio'],
})

export const FLOW_AI_NODE_TYPES = Object.freeze({
  prompt: 'prompt',
  promptAssist: 'prompt-assist',
  textViewer: 'text-viewer',
  imageInput: 'image-input',
  styleReference: 'style-reference',
  imageGen: 'image-gen',
  videoGen: 'video-gen',
  videoUpscale: 'video-upscale',
  musicGen: 'music-gen',
  output: 'output',
})

const DEFAULT_VIEWPORT = Object.freeze({ x: 0, y: 0, zoom: 0.9 })

const FLOW_IMAGE_WORKFLOWS = Object.freeze(
  (WORKFLOWS.image || []).map((workflow) => ({
    id: workflow.id,
    label: workflow.label,
    needsImage: Boolean(workflow.needsImage),
    runtime: getWorkflowHardwareInfo(workflow.id)?.runtime || 'local',
    tierId: getWorkflowHardwareInfo(workflow.id)?.tierId || '',
    description: workflow.description || '',
  }))
)

const FLOW_VIDEO_WORKFLOWS = Object.freeze(
  (WORKFLOWS.video || []).map((workflow) => ({
    id: workflow.id,
    label: workflow.label,
    needsImage: Boolean(workflow.needsImage),
    runtime: getWorkflowHardwareInfo(workflow.id)?.runtime || 'local',
    tierId: getWorkflowHardwareInfo(workflow.id)?.tierId || '',
    description: workflow.description || '',
  }))
)

const FLOW_AUDIO_WORKFLOWS = Object.freeze(
  (WORKFLOWS.audio || []).map((workflow) => ({
    id: workflow.id,
    label: workflow.label,
    needsImage: Boolean(workflow.needsImage),
    runtime: getWorkflowHardwareInfo(workflow.id)?.runtime || 'local',
    tierId: getWorkflowHardwareInfo(workflow.id)?.tierId || '',
    description: workflow.description || '',
  }))
)

const FLOW_VIDEO_UPSCALE_WORKFLOWS = Object.freeze([
  {
    id: TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID,
    label: getWorkflowDisplayLabel(TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID) || 'Topaz Video Upscale',
    needsImage: false,
    acceptsVideo: true,
    runtime: getWorkflowHardwareInfo(TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID)?.runtime || 'cloud',
    tierId: getWorkflowHardwareInfo(TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID)?.tierId || 'cloud',
    description: 'Cloud video upscaling with Topaz Starlight and Astra models.',
  },
])

const FLOW_TEXT_WORKFLOWS = Object.freeze([
  {
    id: 'google-gemini-flash-lite',
    label: getWorkflowDisplayLabel('google-gemini-flash-lite') || 'Prompt Helper (Gemini 3.1 Flash Lite)',
    needsImage: false,
    acceptsImage: true,
    runtime: getWorkflowHardwareInfo('google-gemini-flash-lite')?.runtime || 'cloud',
    tierId: getWorkflowHardwareInfo('google-gemini-flash-lite')?.tierId || 'cloud',
    description: 'Rewrite rough ideas into stronger prompts with optional image context.',
  },
])

function createNodeId(prefix = 'node') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function createEdgeId() {
  return `edge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function randomSeed() {
  return Math.floor(Math.random() * 1000000)
}

export function getFlowImageWorkflowOptions() {
  return FLOW_IMAGE_WORKFLOWS
}

export function getFlowVideoWorkflowOptions() {
  return FLOW_VIDEO_WORKFLOWS
}

export function getFlowAudioWorkflowOptions() {
  return FLOW_AUDIO_WORKFLOWS
}

export function getFlowVideoUpscaleWorkflowOptions() {
  return FLOW_VIDEO_UPSCALE_WORKFLOWS
}

export function getFlowTextWorkflowOptions() {
  return FLOW_TEXT_WORKFLOWS
}

export function getDefaultWorkflowId(nodeType) {
  switch (nodeType) {
    case FLOW_AI_NODE_TYPES.promptAssist:
      return FLOW_TEXT_WORKFLOWS[0]?.id || 'google-gemini-flash-lite'
    case FLOW_AI_NODE_TYPES.imageGen:
      return FLOW_IMAGE_WORKFLOWS[0]?.id || 'z-image-turbo'
    case FLOW_AI_NODE_TYPES.videoGen:
      return FLOW_VIDEO_WORKFLOWS[0]?.id || 'ltx23-i2v'
    case FLOW_AI_NODE_TYPES.videoUpscale:
      return FLOW_VIDEO_UPSCALE_WORKFLOWS[0]?.id || TOPAZ_VIDEO_UPSCALE_WORKFLOW_ID
    case FLOW_AI_NODE_TYPES.musicGen:
      return FLOW_AUDIO_WORKFLOWS[0]?.id || 'music-gen'
    default:
      return ''
  }
}

const DEFAULT_IMAGE_VARIANT_BEHAVIOR = Object.freeze({
  mode: 'repeat',
  max: FLOW_AI_IMAGE_VARIANT_LIMIT,
})

const FIXED_IMAGE_VARIANT_BEHAVIOR = Object.freeze({
  mode: 'fixed',
  fixedCount: 8,
  max: 1,
})

const FLOW_IMAGE_VARIANT_BEHAVIORS = Object.freeze({
  'z-image-turbo': Object.freeze({
    mode: 'native',
    max: FLOW_AI_IMAGE_VARIANT_LIMIT,
  }),
  'grok-text-to-image': Object.freeze({
    mode: 'native',
    max: FLOW_AI_IMAGE_VARIANT_LIMIT,
  }),
  'seedream-5-lite-image-edit': Object.freeze({
    mode: 'native',
    max: FLOW_AI_IMAGE_VARIANT_LIMIT,
  }),
  'multi-angles': FIXED_IMAGE_VARIANT_BEHAVIOR,
  'multi-angles-scene': FIXED_IMAGE_VARIANT_BEHAVIOR,
})

export function getFlowImageVariantBehavior(workflowId = '') {
  return FLOW_IMAGE_VARIANT_BEHAVIORS[String(workflowId || '').trim()] || DEFAULT_IMAGE_VARIANT_BEHAVIOR
}

export function normalizeFlowImageVariantCount(value, workflowId = '') {
  const behavior = getFlowImageVariantBehavior(workflowId)
  if (behavior.mode === 'fixed') return 1
  const numericValue = Math.round(Number(value) || 1)
  const safeMax = Math.max(1, Math.round(Number(behavior.max) || FLOW_AI_IMAGE_VARIANT_LIMIT))
  return Math.max(1, Math.min(safeMax, numericValue))
}

export function getFlowOutputFolderSegments(folderName = '', assetKind = '') {
  const normalized = String(folderName || '').trim()
  if (normalized) {
    return [FLOW_AI_ASSET_ROOT_FOLDER, normalized]
  }
  return FLOW_AI_AUTO_OUTPUT_FOLDERS[String(assetKind || '').trim()] || [FLOW_AI_ASSET_ROOT_FOLDER]
}

export function getFlowOutputDestinationLabel(folderName = '', assetKind = '') {
  return `Assets / ${getFlowOutputFolderSegments(folderName, assetKind).join(' / ')}`
}

export const FLOW_AI_NODE_LIBRARY = Object.freeze([
  {
    type: FLOW_AI_NODE_TYPES.prompt,
    label: 'Prompt',
    category: 'Inputs',
    description: 'Reusable text prompt block for image, video, or music nodes.',
    accentClass: 'text-violet-300',
    supported: true,
    outputs: [{ id: 'out:text', type: 'text', label: 'Text' }],
    inputs: [],
  },
  {
    type: FLOW_AI_NODE_TYPES.imageInput,
    label: 'Image Input',
    category: 'Inputs',
    description: 'Pick an image or video asset from the current project.',
    accentClass: 'text-emerald-300',
    supported: true,
    outputs: [{ id: 'out:image', type: 'image', label: 'Image' }],
    inputs: [],
  },
  {
    type: FLOW_AI_NODE_TYPES.styleReference,
    label: 'Style Reference',
    category: 'Inputs',
    description: 'Feed one or more reference images into edit-capable image nodes.',
    accentClass: 'text-fuchsia-300',
    supported: true,
    outputs: [{ id: 'out:image', type: 'image', label: 'Style' }],
    inputs: [],
  },
  {
    type: FLOW_AI_NODE_TYPES.promptAssist,
    label: 'Prompt Assist',
    category: 'Helpers',
    description: 'Refine a rough brief into a stronger prompt with Gemini.',
    accentClass: 'text-sky-200',
    supported: true,
    inputs: [
      { id: 'in:text', type: 'text', label: 'Brief' },
      { id: 'in:image', type: 'image', label: 'Reference' },
    ],
    outputs: [{ id: 'out:text', type: 'text', label: 'Prompt' }],
  },
  {
    type: FLOW_AI_NODE_TYPES.textViewer,
    label: 'Text Viewer',
    category: 'Helpers',
    description: 'Inspect text in the graph and pass it downstream unchanged.',
    accentClass: 'text-violet-200',
    supported: true,
    inputs: [{ id: 'in:text', type: 'text', label: 'Text' }],
    outputs: [{ id: 'out:text', type: 'text', label: 'Text' }],
  },
  {
    type: FLOW_AI_NODE_TYPES.imageGen,
    label: 'Image Gen',
    category: 'Generate',
    description: 'Run a built-in local or cloud image workflow.',
    accentClass: 'text-sky-300',
    supported: true,
    inputs: [
      { id: 'in:text', type: 'text', label: 'Prompt' },
      { id: 'in:image', type: 'image', label: 'Input' },
      { id: 'in:style', type: 'style', label: 'Style', multiple: true },
    ],
    outputs: [{ id: 'out:image', type: 'image', label: 'Image' }],
  },
  {
    type: FLOW_AI_NODE_TYPES.videoGen,
    label: 'Video Gen',
    category: 'Generate',
    description: 'Run a built-in local or cloud image-to-video workflow.',
    accentClass: 'text-cyan-300',
    supported: true,
    inputs: [
      { id: 'in:text', type: 'text', label: 'Prompt' },
      { id: 'in:image', type: 'image', label: 'Input' },
    ],
    outputs: [{ id: 'out:video', type: 'video', label: 'Video' }],
  },
  {
    type: FLOW_AI_NODE_TYPES.videoUpscale,
    label: 'Upscale Video',
    category: 'Generate',
    description: 'Run a cloud video upscale workflow on an upstream video clip.',
    accentClass: 'text-amber-300',
    supported: true,
    inputs: [{ id: 'in:video', type: 'video', label: 'Video' }],
    outputs: [{ id: 'out:video', type: 'video', label: 'Video' }],
  },
  {
    type: FLOW_AI_NODE_TYPES.musicGen,
    label: 'Music',
    category: 'Generate',
    description: 'Generate music from tags and optional lyrics.',
    accentClass: 'text-amber-300',
    supported: true,
    inputs: [{ id: 'in:text', type: 'text', label: 'Lyrics' }],
    outputs: [{ id: 'out:audio', type: 'audio', label: 'Audio' }],
  },
  {
    type: FLOW_AI_NODE_TYPES.output,
    label: 'Asset Output',
    category: 'Outputs',
    description: 'Send final image, video, or audio results into the Assets panel.',
    accentClass: 'text-slate-200',
    supported: true,
    inputs: [
      { id: 'in:image', type: 'image', label: 'Image' },
      { id: 'in:video', type: 'video', label: 'Video' },
      { id: 'in:audio', type: 'audio', label: 'Audio' },
    ],
    outputs: [],
  },
])

export const FLOW_AI_TEMPLATES = Object.freeze([
  {
    id: 'blank',
    label: 'Blank Canvas',
    description: 'Start with a clean canvas and add nodes yourself.',
  },
  {
    id: 'text-to-video',
    label: 'Text -> Image -> Video',
    description: 'Generate a keyframe image, then animate it into a video.',
  },
  {
    id: 'music-cue',
    label: 'Music Cue',
    description: 'Write tags/lyrics and generate a music stem.',
  },
  {
    id: 'style-edit',
    label: 'Image Edit With References',
    description: 'Drive an edit workflow with an input image and style references.',
  },
])

export function getFlowNodeDefinition(type) {
  return FLOW_AI_NODE_LIBRARY.find((entry) => entry.type === type) || null
}

export function getFlowNodeSupportsExecution(type) {
  return (
    type === FLOW_AI_NODE_TYPES.promptAssist
    || type === FLOW_AI_NODE_TYPES.imageGen
    || type === FLOW_AI_NODE_TYPES.videoGen
    || type === FLOW_AI_NODE_TYPES.videoUpscale
    || type === FLOW_AI_NODE_TYPES.musicGen
  )
}

export function parsePortType(handleId = '') {
  const normalized = String(handleId || '').trim()
  if (!normalized.includes(':')) return ''
  return normalized.split(':')[1]
}

export function isSingletonTargetHandle(handleId = '') {
  return String(handleId || '').trim() !== 'in:style'
}

export function isValidFlowConnection(connection) {
  const sourceType = parsePortType(connection?.sourceHandle)
  const targetType = parsePortType(connection?.targetHandle)
  if (!sourceType || !targetType) return false
  if (sourceType === targetType) return true
  if (targetType === 'style') return sourceType === 'image'
  if (targetType === 'any') return ['image', 'video', 'audio', 'text'].includes(sourceType)
  return false
}

function createBaseNodeData(type) {
  switch (type) {
    case FLOW_AI_NODE_TYPES.promptAssist:
      return {
        label: 'Prompt Assist',
        workflowId: getDefaultWorkflowId(type),
        inlinePrompt: 'Turn this into a vivid, production-ready image generation prompt.',
        systemPrompt: '',
        frameTime: 0,
        seed: randomSeed(),
        outputText: '',
        outputAssetIds: [],
        status: 'idle',
        statusMessage: 'Write a brief or connect a Prompt node, then run to refine it.',
        error: '',
        dependencyStatus: 'unknown',
        lastPromptId: null,
        lastRunAt: null,
      }
    case FLOW_AI_NODE_TYPES.textViewer:
      return {
        label: 'Text Viewer',
        note: '',
        status: 'idle',
        statusMessage: 'Connect a text-producing node to inspect it here.',
        error: '',
      }
    case FLOW_AI_NODE_TYPES.prompt:
      return {
        label: 'Prompt',
        promptText: 'A cinematic hero frame with dramatic lighting',
        note: '',
        status: 'idle',
        statusMessage: '',
        error: '',
      }
    case FLOW_AI_NODE_TYPES.imageInput:
      return {
        label: 'Image Input',
        assetId: '',
        frameTime: 0,
        note: '',
        status: 'idle',
        statusMessage: 'Pick an asset from the project.',
        error: '',
      }
    case FLOW_AI_NODE_TYPES.styleReference:
      return {
        label: 'Style Reference',
        assetId: '',
        note: '',
        status: 'idle',
        statusMessage: 'Optional reference for edit-capable image workflows.',
        error: '',
      }
    case FLOW_AI_NODE_TYPES.imageGen:
      return {
        label: 'Image Gen',
        workflowId: getDefaultWorkflowId(type),
        inlinePrompt: '',
        negativePrompt: 'blurry, low quality, watermark',
        width: 1280,
        height: 720,
        variantCount: 1,
        seed: randomSeed(),
        status: 'idle',
        statusMessage: '',
        error: '',
        outputAssetIds: [],
        dependencyStatus: 'unknown',
      }
    case FLOW_AI_NODE_TYPES.videoGen:
      return {
        label: 'Video Gen',
        workflowId: getDefaultWorkflowId(type),
        inlinePrompt: '',
        negativePrompt: 'blurry, low quality, watermark',
        width: 1280,
        height: 720,
        duration: 5,
        fps: 24,
        seed: randomSeed(),
        wanQualityPreset: 'balanced',
        status: 'idle',
        statusMessage: '',
        error: '',
        outputAssetIds: [],
        dependencyStatus: 'unknown',
      }
    case FLOW_AI_NODE_TYPES.videoUpscale:
      return {
        label: 'Upscale Video',
        workflowId: getDefaultWorkflowId(type),
        upscaleModel: TOPAZ_VIDEO_UPSCALE_DEFAULTS.model,
        targetResolution: TOPAZ_VIDEO_UPSCALE_DEFAULTS.resolution,
        upscaleCreativity: TOPAZ_VIDEO_UPSCALE_DEFAULTS.creativity,
        estimatedCredits: null,
        estimatedCreditsSource: null,
        status: 'idle',
        statusMessage: 'Connect a video result and run to upscale it.',
        error: '',
        outputAssetIds: [],
        dependencyStatus: 'unknown',
      }
    case FLOW_AI_NODE_TYPES.musicGen:
      return {
        label: 'Music',
        workflowId: getDefaultWorkflowId(type),
        tags: 'cinematic, pulsing, uplifting',
        lyrics: '',
        duration: 8,
        bpm: 120,
        keyscale: 'C Major',
        seed: randomSeed(),
        status: 'idle',
        statusMessage: '',
        error: '',
        outputAssetIds: [],
        dependencyStatus: 'unknown',
      }
    case FLOW_AI_NODE_TYPES.output:
      return {
        label: 'Asset Output',
        folderName: '',
        note: '',
        status: 'idle',
        statusMessage: 'Sends connected results to the Assets panel.',
        error: '',
        resolvedAssetIds: [],
      }
    default:
      return {
        label: getFlowNodeDefinition(type)?.label || 'Node',
        status: 'idle',
        statusMessage: '',
        error: '',
      }
  }
}

export function createFlowNode(type, options = {}) {
  const definition = getFlowNodeDefinition(type)
  if (!definition) {
    throw new Error(`Unknown Flow AI node type: ${type}`)
  }

  return {
    id: options.id || createNodeId(type.replace(/[^a-z0-9]+/gi, '_')),
    type,
    position: options.position || { x: 80, y: 80 },
    data: {
      ...createBaseNodeData(type),
      ...options.data,
    },
  }
}

export function createFlowEdge(options = {}) {
  return {
    id: options.id || createEdgeId(),
    source: options.source,
    target: options.target,
    sourceHandle: options.sourceHandle || null,
    targetHandle: options.targetHandle || null,
    animated: false,
  }
}

function buildBlankTemplate() {
  const promptNode = createFlowNode(FLOW_AI_NODE_TYPES.prompt, {
    position: { x: 80, y: 120 },
  })
  const imageNode = createFlowNode(FLOW_AI_NODE_TYPES.imageGen, {
    position: { x: 420, y: 100 },
    data: { label: 'Keyframe', workflowId: 'z-image-turbo' },
  })
  const outputNode = createFlowNode(FLOW_AI_NODE_TYPES.output, {
    position: { x: 760, y: 120 },
  })

  return {
    nodes: [promptNode, imageNode, outputNode],
    edges: [
      createFlowEdge({
        source: promptNode.id,
        sourceHandle: 'out:text',
        target: imageNode.id,
        targetHandle: 'in:text',
      }),
      createFlowEdge({
        source: imageNode.id,
        sourceHandle: 'out:image',
        target: outputNode.id,
        targetHandle: 'in:image',
      }),
    ],
  }
}

function buildTextToVideoTemplate() {
  const promptNode = createFlowNode(FLOW_AI_NODE_TYPES.prompt, {
    position: { x: 80, y: 120 },
    data: { promptText: 'A cinematic superhero dog landing on a rooftop at sunset' },
  })
  const imageNode = createFlowNode(FLOW_AI_NODE_TYPES.imageGen, {
    position: { x: 420, y: 80 },
    data: { label: 'Keyframe', workflowId: 'z-image-turbo', width: 1280, height: 720 },
  })
  const videoNode = createFlowNode(FLOW_AI_NODE_TYPES.videoGen, {
    position: { x: 760, y: 80 },
    data: { label: 'Animate', workflowId: 'ltx23-i2v', duration: 5, fps: 24 },
  })
  const outputNode = createFlowNode(FLOW_AI_NODE_TYPES.output, {
    position: { x: 1100, y: 120 },
  })

  return {
    nodes: [promptNode, imageNode, videoNode, outputNode],
    edges: [
      createFlowEdge({
        source: promptNode.id,
        sourceHandle: 'out:text',
        target: imageNode.id,
        targetHandle: 'in:text',
      }),
      createFlowEdge({
        source: promptNode.id,
        sourceHandle: 'out:text',
        target: videoNode.id,
        targetHandle: 'in:text',
      }),
      createFlowEdge({
        source: imageNode.id,
        sourceHandle: 'out:image',
        target: videoNode.id,
        targetHandle: 'in:image',
      }),
      createFlowEdge({
        source: videoNode.id,
        sourceHandle: 'out:video',
        target: outputNode.id,
        targetHandle: 'in:video',
      }),
    ],
  }
}

function buildMusicTemplate() {
  const promptNode = createFlowNode(FLOW_AI_NODE_TYPES.prompt, {
    position: { x: 80, y: 120 },
    data: { label: 'Lyrics', promptText: 'Rise up, lights on, city in motion, we are not done yet.' },
  })
  const musicNode = createFlowNode(FLOW_AI_NODE_TYPES.musicGen, {
    position: { x: 420, y: 100 },
    data: { label: 'Cue', duration: 16, bpm: 118 },
  })
  const outputNode = createFlowNode(FLOW_AI_NODE_TYPES.output, {
    position: { x: 760, y: 120 },
  })

  return {
    nodes: [promptNode, musicNode, outputNode],
    edges: [
      createFlowEdge({
        source: promptNode.id,
        sourceHandle: 'out:text',
        target: musicNode.id,
        targetHandle: 'in:text',
      }),
      createFlowEdge({
        source: musicNode.id,
        sourceHandle: 'out:audio',
        target: outputNode.id,
        targetHandle: 'in:audio',
      }),
    ],
  }
}

function buildStyleEditTemplate() {
  const inputNode = createFlowNode(FLOW_AI_NODE_TYPES.imageInput, {
    position: { x: 80, y: 160 },
    data: { label: 'Source Image' },
  })
  const promptNode = createFlowNode(FLOW_AI_NODE_TYPES.prompt, {
    position: { x: 80, y: 20 },
    data: { promptText: 'Turn this into a premium ad still with stronger rim lighting' },
  })
  const styleNode = createFlowNode(FLOW_AI_NODE_TYPES.styleReference, {
    position: { x: 80, y: 320 },
  })
  const editNode = createFlowNode(FLOW_AI_NODE_TYPES.imageGen, {
    position: { x: 420, y: 140 },
    data: { label: 'Edit', workflowId: 'image-edit' },
  })
  const outputNode = createFlowNode(FLOW_AI_NODE_TYPES.output, {
    position: { x: 760, y: 160 },
  })

  return {
    nodes: [inputNode, promptNode, styleNode, editNode, outputNode],
    edges: [
      createFlowEdge({
        source: inputNode.id,
        sourceHandle: 'out:image',
        target: editNode.id,
        targetHandle: 'in:image',
      }),
      createFlowEdge({
        source: promptNode.id,
        sourceHandle: 'out:text',
        target: editNode.id,
        targetHandle: 'in:text',
      }),
      createFlowEdge({
        source: styleNode.id,
        sourceHandle: 'out:image',
        target: editNode.id,
        targetHandle: 'in:style',
      }),
      createFlowEdge({
        source: editNode.id,
        sourceHandle: 'out:image',
        target: outputNode.id,
        targetHandle: 'in:image',
      }),
    ],
  }
}

export function createFlowDocument(options = {}) {
  const templateId = String(options.templateId || 'blank').trim()

  let template = buildBlankTemplate()
  if (templateId === 'text-to-video') template = buildTextToVideoTemplate()
  if (templateId === 'music-cue') template = buildMusicTemplate()
  if (templateId === 'style-edit') template = buildStyleEditTemplate()

  return {
    id: options.id || createNodeId('flow'),
    version: FLOW_AI_VERSION,
    name: options.name || FLOW_AI_TEMPLATES.find((entry) => entry.id === templateId)?.label || 'Flow',
    templateId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: options.nodes || template.nodes,
    edges: options.edges || template.edges,
    viewport: options.viewport || { ...DEFAULT_VIEWPORT },
  }
}

export function createDefaultFlowAiProjectData() {
  const starter = createFlowDocument({
    name: 'Story Flow',
    templateId: 'text-to-video',
  })
  return {
    version: FLOW_AI_VERSION,
    activeDocumentId: starter.id,
    documents: [starter],
  }
}

export function normalizeFlowNode(node = {}) {
  const type = String(node?.type || '').trim()
  const definition = getFlowNodeDefinition(type)
  if (!definition) return null
  const baseData = createBaseNodeData(type)
  const rawData = node.data && typeof node.data === 'object' ? node.data : {}
  const rawStyle = node?.style && typeof node.style === 'object' ? node.style : {}
  const legacyWidth = Number(rawData.nodeWidth)
  const legacyHeight = Number(rawData.nodeHeight)
  const styleWidth = Number(rawStyle.width)
  const styleHeight = Number(rawStyle.height)
  const resolvedWidth = Number.isFinite(styleWidth) && styleWidth > 0
    ? styleWidth
    : (Number.isFinite(legacyWidth) && legacyWidth > 0 ? legacyWidth : null)
  const resolvedHeight = Number.isFinite(styleHeight) && styleHeight > 0
    ? styleHeight
    : (Number.isFinite(legacyHeight) && legacyHeight > 0 ? legacyHeight : null)
  const normalizedData = {
    ...baseData,
    ...rawData,
    outputAssetIds: Array.isArray(node?.data?.outputAssetIds) ? node.data.outputAssetIds.filter(Boolean) : baseData.outputAssetIds,
    resolvedAssetIds: Array.isArray(node?.data?.resolvedAssetIds) ? node.data.resolvedAssetIds.filter(Boolean) : baseData.resolvedAssetIds,
  }
  delete normalizedData.nodeWidth
  delete normalizedData.nodeHeight

  if (type === FLOW_AI_NODE_TYPES.output) {
    const rawLabel = String(rawData.label || '').trim()
    const rawStatusMessage = String(rawData.statusMessage || '').trim()
    normalizedData.label = !rawLabel || rawLabel === 'Output' ? baseData.label : rawData.label
    normalizedData.statusMessage = (
      !rawStatusMessage || rawStatusMessage === 'Connect final image, video, or audio nodes here.'
    )
      ? baseData.statusMessage
      : rawData.statusMessage
    normalizedData.folderName = String(rawData.folderName || '').trim()
  }

  if (type === FLOW_AI_NODE_TYPES.imageGen) {
    normalizedData.variantCount = normalizeFlowImageVariantCount(rawData.variantCount, normalizedData.workflowId)
  }

  if (type === FLOW_AI_NODE_TYPES.videoUpscale) {
    normalizedData.upscaleModel = String(rawData.upscaleModel || baseData.upscaleModel).trim() || baseData.upscaleModel
    normalizedData.targetResolution = String(rawData.targetResolution || baseData.targetResolution).trim() || baseData.targetResolution
    normalizedData.upscaleCreativity = String(rawData.upscaleCreativity || baseData.upscaleCreativity).trim() || baseData.upscaleCreativity
    normalizedData.estimatedCredits = normalizeCreditsEstimate(rawData.estimatedCredits)
    normalizedData.estimatedCreditsSource = String(rawData.estimatedCreditsSource || '').trim() || null
  }

  if (type === FLOW_AI_NODE_TYPES.promptAssist) {
    normalizedData.outputText = typeof rawData.outputText === 'string' ? rawData.outputText : baseData.outputText
    normalizedData.systemPrompt = typeof rawData.systemPrompt === 'string' ? rawData.systemPrompt : baseData.systemPrompt
    normalizedData.frameTime = Number(rawData.frameTime) || 0
  }

  const nextStyle = { ...rawStyle }
  if (resolvedWidth && resolvedWidth > 0) nextStyle.width = resolvedWidth
  else delete nextStyle.width
  if (resolvedHeight && resolvedHeight > 0) nextStyle.height = resolvedHeight
  else delete nextStyle.height

  const result = {
    id: String(node.id || createNodeId(type.replace(/[^a-z0-9]+/gi, '_'))),
    type,
    position: {
      x: Number(node?.position?.x) || 0,
      y: Number(node?.position?.y) || 0,
    },
    data: normalizedData,
  }
  if (Object.keys(nextStyle).length > 0) {
    result.style = nextStyle
  }
  return result
}

export function normalizeFlowDocument(document = {}, fallbackName = 'Flow') {
  const normalizedNodes = (Array.isArray(document?.nodes) ? document.nodes : [])
    .map((node) => normalizeFlowNode(node))
    .filter(Boolean)
  const validNodeIds = new Set(normalizedNodes.map((node) => node.id))
  const normalizedEdges = (Array.isArray(document?.edges) ? document.edges : [])
    .filter((edge) => validNodeIds.has(edge?.source) && validNodeIds.has(edge?.target))
    .map((edge) => ({
      id: String(edge.id || createEdgeId()),
      source: String(edge.source),
      target: String(edge.target),
      sourceHandle: edge.sourceHandle || null,
      targetHandle: edge.targetHandle || null,
      animated: Boolean(edge.animated),
    }))

  return {
    id: String(document?.id || createNodeId('flow')),
    version: FLOW_AI_VERSION,
    name: String(document?.name || fallbackName || 'Flow'),
    templateId: String(document?.templateId || 'blank'),
    createdAt: document?.createdAt || new Date().toISOString(),
    updatedAt: document?.updatedAt || new Date().toISOString(),
    nodes: normalizedNodes,
    edges: normalizedEdges,
    viewport: {
      x: Number(document?.viewport?.x) || DEFAULT_VIEWPORT.x,
      y: Number(document?.viewport?.y) || DEFAULT_VIEWPORT.y,
      zoom: Number(document?.viewport?.zoom) || DEFAULT_VIEWPORT.zoom,
    },
  }
}

export function normalizeFlowAiProjectData(projectData) {
  const rawDocuments = Array.isArray(projectData?.documents) ? projectData.documents : []
  const documents = rawDocuments.length > 0
    ? rawDocuments.map((document, index) => normalizeFlowDocument(document, `Flow ${index + 1}`))
    : [createFlowDocument({ name: 'Story Flow', templateId: 'text-to-video' })]

  const activeDocumentId = documents.some((document) => document.id === projectData?.activeDocumentId)
    ? String(projectData.activeDocumentId)
    : documents[0].id

  return {
    version: FLOW_AI_VERSION,
    activeDocumentId,
    documents,
  }
}

export function getFlowWorkflowSummary(workflowId = '') {
  if (!workflowId) return null
  const label = getWorkflowDisplayLabel(workflowId)
  const hardware = getWorkflowHardwareInfo(workflowId)
  return {
    id: workflowId,
    label: label || workflowId,
    runtime: hardware?.runtime || 'local',
    tierId: hardware?.tierId || '',
  }
}

export function buildNodeStatusSummary(node) {
  const status = String(node?.data?.status || 'idle')
  if (status === 'running') return 'Running'
  if (status === 'checking') return 'Checking'
  if (status === 'queuing') return 'Queueing'
  if (status === 'done') return 'Ready'
  if (status === 'error') return 'Error'
  if (status === 'blocked') return 'Blocked'
  return 'Idle'
}

