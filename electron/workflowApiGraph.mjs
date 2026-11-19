// Shared, dependency-free contract for agent-authored API/prompt graphs. Import
// is data authoring only; ComfyUI execution is a separate approved queue action.
// One text may be up to 65536 characters: prompt-rewriter instructions in stock ComfyUI templates run past 32768.
// The whole graph is still held to `bytes` below.
export const API_WORKFLOW_LIMITS = Object.freeze({ bytes: 96 * 1024, nodes: 200, depth: 12, values: 16000 })
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const privateValue = /(?:\b(?:sk-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b|\bBearer\s+[A-Za-z0-9._~+/-]{8,}|[?&](?:token|api_key|access_token|signature|password)=)/i
const fileKey = /(?:^|[._])(?:file|filename|filename_prefix|path|directory|folder|image|audio|video|ckpt_name|lora_name|vae_name|clip_name|unet_name|model_name|text_encoder|audio_vae|upscale_model)$/i
const modelInputSubdirs = Object.freeze({ ckpt_name: 'checkpoints', lora_name: 'loras', vae_name: 'vae', clip_name: 'text_encoders', unet_name: 'diffusion_models', audio_vae: 'vae', text_encoder: 'text_encoders', upscale_model: 'upscale_models' })
function modelTargetSubdir(classType, inputKey) {
  const lowerClass = String(classType || '').toLowerCase()
  // Latent and pixel-space upscalers use different ComfyUI model categories.
  if (['model_name', 'upscale_model'].includes(inputKey) && lowerClass.replace(/[^a-z0-9]/g, '').includes('latentupscalemodelloader')) return 'latent_upscale_models'
  if (inputKey === 'clip_name' && (lowerClass.includes('clipvision') || lowerClass.includes('clip_vision'))) return 'clip_vision'
  if (modelInputSubdirs[inputKey]) return modelInputSubdirs[inputKey]
  if (inputKey === 'model_name' && lowerClass.includes('upscale')) return 'upscale_models'
  return ''
}
export function stableWorkflowJson(value) {
  return JSON.stringify(value, (_, item) => plain(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
}

// Newer ComfyUI widgets store their setting as a small plain object, e.g. ImageCompare's
// compare_view: { __value__: { 0: '', 1: '' } }. Accept those: plain objects only, at most three levels and
// 32 values, scalar leaves, no lists (a list here could be mistaken for a node link). Every text inside has
// already passed the credential and path checks above; a file-like input name also bars URLs inside it.
function settingBundle(value, inputKey, depth = 0, count = { n: 0 }) {
  if (depth > 2 || /(?:api[_-]?key|password|access[_-]?token|secret|authorization)/i.test(inputKey)) return false
  for (const child of Object.values(value)) {
    if (++count.n > 32) return false
    if (plain(child)) { if (!settingBundle(child, inputKey, depth + 1, count)) return false; continue }
    if (child !== null && !['string', 'number', 'boolean'].includes(typeof child)) return false
    if (typeof child === 'number' && !Number.isFinite(child)) return false
    if (typeof child === 'string' && fileKey.test(inputKey) && /^[a-z][a-z0-9+.-]*:\/\//i.test(child)) return false
  }
  return true
}

export function validateApiWorkflow(value) {
  let visits = 0
  const seen = new Set()
  function check(item, depth = 0, key = '') {
    if (++visits > API_WORKFLOW_LIMITS.values || depth > API_WORKFLOW_LIMITS.depth) throw new Error('Workflow JSON exceeds the depth or value limit.')
    if (typeof item === 'string') {
      if (item.length > 65536 || /\x00/.test(item) || privateValue.test(item)
        || /(?:api[_-]?key|password|access[_-]?token|secret|authorization)/i.test(key)) throw new Error('Workflow contains an oversized, unsafe or credential-like value.')
      if (/^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/]|file:)/i.test(item)
        || item.split(/[\\/]/).some(part => part === '..' || part === '.')
        || (fileKey.test(key) && /^[a-z][a-z0-9+.-]*:\/\//i.test(item))) throw new Error('Workflow file inputs must use safe ComfyUI-relative filenames, not paths or URLs.')
      return
    }
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return
    if (typeof item !== 'object' || seen.has(item)) throw new Error('Workflow must contain finite, acyclic JSON values.')
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('Workflow objects must be plain JSON.')
    seen.add(item)
    const entries = Object.entries(item)
    if (entries.length > 512) throw new Error('Workflow object exceeds the field limit.')
    for (const [childKey, child] of entries) {
      if (forbiddenKeys.has(childKey)) throw new Error('Workflow contains a forbidden object key.')
      check(child, depth + 1, childKey)
    }
    seen.delete(item)
  }
  check(value)
  if (!plain(value) || !Object.keys(value).length || Object.keys(value).length > API_WORKFLOW_LIMITS.nodes) throw new Error('API workflow must contain 1–200 nodes.')
  if (new TextEncoder().encode(stableWorkflowJson(value)).length > API_WORKFLOW_LIMITS.bytes) throw new Error('API workflow exceeds the 96 KiB graph limit.')
  for (const [nodeId, node] of Object.entries(value)) {
    if (!idPattern.test(nodeId) || !plain(node) || typeof node.class_type !== 'string' || !node.class_type.trim()
      || node.class_type.length > 160 || /[\x00-\x1f]/.test(node.class_type) || !plain(node.inputs)
      || Object.keys(node).some(key => !['class_type', 'inputs', '_meta'].includes(key))) throw new Error(`Invalid API node: ${nodeId}. Expected class_type and inputs.`)
    for (const [key, input] of Object.entries(node.inputs)) {
      if (!key || key.length > 160) throw new Error(`Invalid input name on node ${nodeId}.`)
      if (Array.isArray(input)) {
        if (input.length !== 2 || !['string', 'number'].includes(typeof input[0]) || !Object.hasOwn(value, String(input[0]))
          || !Number.isSafeInteger(input[1]) || input[1] < 0 || input[1] > 255 || String(input[0]) === nodeId) throw new Error(`Invalid or dangling link at ${nodeId}.${key}.`)
      } else if (plain(input)) {
        if (!settingBundle(input, key)) throw new Error(`Input ${nodeId}.${key} must be a scalar, a node link or a small bundle of scalars.`)
      } else if (input !== null && !['string', 'number', 'boolean'].includes(typeof input)) throw new Error(`Input ${nodeId}.${key} must be a scalar or a node link.`)
    }
  }
  // Cycles cannot form an executable ComfyUI prompt graph.
  const complete = new Set(), visiting = new Set()
  const visit = id => {
    if (visiting.has(id)) throw new Error('Workflow contains a cycle.')
    if (complete.has(id)) return
    visiting.add(id)
    for (const input of Object.values(value[id].inputs)) if (Array.isArray(input)) visit(String(input[0]))
    visiting.delete(id); complete.add(id)
  }
  for (const id of Object.keys(value)) visit(id)
  return JSON.parse(stableWorkflowJson(value))
}

export function buildApiWorkflowMetadata(graph, { name, title, outputType, inspectOnly = false } = {}) {
  const workflow = validateApiWorkflow(graph)
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name || '')) throw new Error('API workflow name must be a 1–48 character lowercase slug (letters, numbers, hyphens).')
  const templateName = `mcp-${name}`, workflowId = `tpl-${templateName}`
  const classes = [...new Set(Object.values(workflow).map(node => node.class_type))]
  const detectedOutput = classes.some(type => /SaveVideo|VideoCombine|SaveWEBM|SaveAnimatedWEBP/i.test(type)) ? 'video'
    : classes.some(type => /SaveAudio/i.test(type)) ? 'audio' : classes.some(type => /SaveImage|PreviewImage/i.test(type)) ? 'image' : null
  const media = outputType || detectedOutput
  if (!['video', 'image', 'audio'].includes(media) && !inspectOnly) throw new Error('Choose outputType because no supported output node could be identified.')
  const bindings = { prompt: null, negativePrompt: null, seeds: [], assets: [], outputPrefixes: [], parameters: [] }
  const fields = [], models = []
  const findText = (id, branch, depth = 0) => {
    if (depth > 12) return null
    const node = workflow[id]
    if (!node) return null
    for (const key of ['text', 'prompt', 'model.prompt', 'positive_prompt', 'caption']) if (typeof node.inputs[key] === 'string') return { nodeId: id, inputKey: key }
    if (/string|text|prompt/i.test(node.class_type) && typeof node.inputs.value === 'string') return { nodeId: id, inputKey: 'value' }
    const links = Object.entries(node.inputs).filter(([key, input]) => Array.isArray(input) && (!['positive', 'negative'].includes(key) || key === branch))
      .sort(([a], [b]) => Number(b === branch) - Number(a === branch))
    for (const [, input] of links) { const found = findText(String(input[0]), branch, depth + 1); if (found) return found }
    return null
  }
  for (const node of Object.values(workflow)) for (const branch of ['positive', 'negative']) {
    const key = branch === 'positive' ? 'prompt' : 'negativePrompt'
    if (!bindings[key] && Array.isArray(node.inputs[branch])) bindings[key] = findText(String(node.inputs[branch][0]), branch)
  }
  let extraAsset = 0
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!bindings.prompt) for (const key of ['prompt', 'model.prompt', 'positive_prompt', 'text']) if (typeof node.inputs[key] === 'string') { bindings.prompt = { nodeId, inputKey: key }; break }
    const assetType = node.class_type === 'LoadImage' ? 'image' : /^(?:LoadAudio|VHS_LoadAudio)$/.test(node.class_type) ? 'audio'
      : /^(?:LoadVideo|VHS_LoadVideo|VHS_LoadVideoPath)$/.test(node.class_type) ? 'video' : null
    if (assetType) {
      const inputKey = assetType === 'image' ? 'image' : assetType === 'audio' ? 'audio' : typeof node.inputs.file === 'string' ? 'file' : 'video'
      const primary = assetType !== 'audio' && !bindings.assets.some(item => item.source === 'primary')
      const fieldId = primary ? 'asset' : `templateInput${++extraAsset}`
      bindings.assets.push({ source: primary ? 'primary' : 'field', fieldId, nodeId, inputKey, assetType })
      fields.push({ id: fieldId, label: `${primary ? 'Primary' : 'Additional'} ${assetType}`, type: primary ? 'asset' : 'assetSelect', assetType, required: true })
    }
    for (const [inputKey, value] of Object.entries(node.inputs)) {
      if (['seed', 'noise_seed'].includes(inputKey) && typeof value === 'number') { bindings.seeds.push({ nodeId, inputKey }); continue }
      if (inputKey === 'filename_prefix' && typeof value === 'string') { bindings.outputPrefixes.push({ nodeId, inputKey }); continue }
      if (/^(?:ckpt_name|lora_name|vae_name|clip_name|unet_name|model_name|audio_vae|text_encoder|upscale_model)$/.test(inputKey) && typeof value === 'string') models.push({ filename: value, nodeType: node.class_type, inputKey, targetSubdir: modelTargetSubdir(node.class_type, inputKey) })
      if (!['number', 'boolean'].includes(typeof value)) continue
      if (bindings.parameters.length >= 128) throw new Error('API workflow exposes more than 128 numeric/boolean parameters. Split it into smaller managed workflows.')
      const fieldId = `node_${nodeId.replace(/[^A-Za-z0-9_]/g, '_')}_${inputKey.replace(/[^A-Za-z0-9_]/g, '_')}`
      if (bindings.parameters.some(item => item.fieldId === fieldId)) throw new Error('Workflow parameter names collide after normalization.')
      const valueType = typeof value === 'boolean' ? 'boolean' : Number.isInteger(value) ? 'integer' : 'number'
      bindings.parameters.push({ fieldId, label: `${nodeId} · ${inputKey}`, nodeId, inputKey, valueType, defaultValue: value })
      fields.push({ id: fieldId, label: `${nodeId} · ${inputKey}`, type: valueType === 'boolean' ? 'toggle' : 'number', templateParameter: true, valueType, defaultValue: value })
    }
  }
  if (stableWorkflowJson(bindings.prompt) === stableWorkflowJson(bindings.negativePrompt)) bindings.negativePrompt = null
  if (bindings.prompt) fields.push({ id: 'prompt', label: 'Prompt', type: 'textarea' })
  if (bindings.seeds.length) fields.push({ id: 'seed', label: 'Seed', type: 'seed' })
  const primary = bindings.assets.find(item => item.source === 'primary')
  return { workflowId, templateName, title: String(title || name).slice(0, 160), outputType: media, nodeClasses: classes, bindings, fields,
    needsImage: Boolean(primary), inputAssetType: primary?.assetType, models }
}
