// Field detection + queue-time value binding for imported ComfyUI templates.
// Works on API-format (prompt) workflows produced by graphToPrompt: node ids
// are string keys, link inputs are [nodeId, slot] arrays, widget inputs are
// plain values. The upstream template `io` metadata names the top-level media
// input nodes; those ids survive conversion because only subgraph-internal
// nodes get composite ids.

const TEXT_INPUT_KEYS = ['text', 'prompt', 'positive_prompt', 'caption', 'text_g']
const SEED_INPUT_KEYS = ['seed', 'noise_seed']
const ASSET_INPUT_KEY_CANDIDATES = {
  image: ['image'],
  audio: ['audio'],
  video: ['file', 'video'],
}

function findTextInputKey(node) {
  for (const key of TEXT_INPUT_KEYS) {
    if (typeof node?.inputs?.[key] === 'string') return key
  }
  // String primitives (PrimitiveStringMultiline etc.) hold their text under
  // "value" — accept it only on string-ish classes so booleans/numbers and
  // generic value widgets don't masquerade as prompts.
  if (
    typeof node?.inputs?.value === 'string'
    && /string|text|note|prompt/i.test(String(node?.class_type || ''))
  ) {
    return 'value'
  }
  return null
}

function resolveTextNodeThroughLinks(apiWorkflow, linkRef, branchKey, depth = 0) {
  if (!Array.isArray(linkRef) || depth > 6) return null
  const node = apiWorkflow[String(linkRef[0])]
  if (!node) return null
  const inputKey = findTextInputKey(node)
  if (inputKey) return { nodeId: String(linkRef[0]), inputKey }

  // Both conditioning chains often route through shared nodes (e.g.
  // LTXVConditioning takes positive AND negative). Stay on our branch by
  // preferring the same-named input at every hop, otherwise a blind DFS can
  // cross over and return the wrong prompt.
  const inputs = node.inputs || {}
  if (Array.isArray(inputs[branchKey])) {
    const resolved = resolveTextNodeThroughLinks(apiWorkflow, inputs[branchKey], branchKey, depth + 1)
    if (resolved) return resolved
  }
  for (const [key, value] of Object.entries(inputs)) {
    if (key === branchKey || !Array.isArray(value)) continue
    // Never wander down the opposite conditioning branch.
    if (key === 'positive' || key === 'negative') continue
    const resolved = resolveTextNodeThroughLinks(apiWorkflow, value, branchKey, depth + 1)
    if (resolved) return resolved
  }
  return null
}

function detectPromptBindings(apiWorkflow) {
  let positive = null
  let negative = null

  // Strongest signal: trace a sampler's positive/negative conditioning links
  // back to the node that actually holds the text widget.
  for (const node of Object.values(apiWorkflow)) {
    const inputs = node?.inputs || {}
    if (!positive && Array.isArray(inputs.positive)) {
      positive = resolveTextNodeThroughLinks(apiWorkflow, inputs.positive, 'positive')
    }
    if (!negative && Array.isArray(inputs.negative)) {
      negative = resolveTextNodeThroughLinks(apiWorkflow, inputs.negative, 'negative')
    }
  }

  // API/partner templates have no sampler — fall back to the most prompt-like
  // string input in the graph ("prompt" key wins, then longest default text).
  if (!positive) {
    let best = null
    for (const [nodeId, node] of Object.entries(apiWorkflow)) {
      const inputKey = findTextInputKey(node)
      if (!inputKey) continue
      const score = (inputKey === 'prompt' ? 100000 : 0) + String(node.inputs[inputKey] || '').length
      if (!best || score > best.score) best = { nodeId, inputKey, score }
    }
    if (best) positive = { nodeId: best.nodeId, inputKey: best.inputKey }
  }

  if (negative && positive && negative.nodeId === positive.nodeId && negative.inputKey === positive.inputKey) {
    negative = null
  }
  return { positive, negative }
}

function detectSeedBindings(apiWorkflow) {
  const seeds = []
  for (const [nodeId, node] of Object.entries(apiWorkflow)) {
    for (const key of SEED_INPUT_KEYS) {
      const value = node?.inputs?.[key]
      if (typeof value === 'number') seeds.push({ nodeId, inputKey: key })
    }
  }
  return seeds
}

function detectOutputPrefixBindings(apiWorkflow) {
  const prefixes = []
  for (const [nodeId, node] of Object.entries(apiWorkflow)) {
    if (typeof node?.inputs?.filename_prefix === 'string') {
      prefixes.push({ nodeId, inputKey: 'filename_prefix' })
    }
  }
  return prefixes
}

function resolveAssetInputKey(apiNode, mediaType) {
  const candidates = ASSET_INPUT_KEY_CANDIDATES[mediaType] || []
  for (const key of candidates) {
    if (apiNode?.inputs && key in apiNode.inputs && !Array.isArray(apiNode.inputs[key])) return key
  }
  for (const [key, value] of Object.entries(apiNode?.inputs || {})) {
    if (typeof value === 'string') return key
  }
  return candidates[0] || 'image'
}

// Loader classes → the media type they feed. Used when there is no upstream
// io metadata (e.g. graphs captured from the embedded ComfyUI tab).
const ASSET_LOADER_CLASSES = Object.freeze({
  LoadImage: 'image',
  LoadImageMask: 'image',
  LoadImageOutput: 'image',
  LoadVideo: 'video',
  VHS_LoadVideo: 'video',
  VHS_LoadVideoPath: 'video',
  LoadAudio: 'audio',
  VHS_LoadAudioUpload: 'audio',
})

const OUTPUT_SAVER_CLASSES = Object.freeze({
  SaveVideo: 'video',
  VHS_VideoCombine: 'video',
  SaveWEBM: 'video',
  SaveAnimatedWEBP: 'video',
  SaveImage: 'image',
  SaveAudio: 'audio',
  SaveAudioMP3: 'audio',
  SaveAudioOpus: 'audio',
})

export function detectOutputMediaFromClasses(apiWorkflow) {
  for (const node of Object.values(apiWorkflow || {})) {
    const media = OUTPUT_SAVER_CLASSES[String(node?.class_type || '').trim()]
    if (media) return media
  }
  return ''
}

function collectMediaInputRefs(apiWorkflow, template) {
  const ioInputs = Array.isArray(template?.io?.inputs) ? template.io.inputs : []
  const refs = []
  if (ioInputs.length > 0) {
    for (const input of ioInputs) {
      const nodeId = String(input?.nodeId ?? '').trim()
      const mediaType = String(input?.mediaType || '').trim()
      if (!nodeId || !['image', 'audio', 'video'].includes(mediaType) || !apiWorkflow[nodeId]) continue
      refs.push({ nodeId, mediaType })
    }
    return refs
  }

  // No upstream metadata — find loader nodes by class (captured graphs).
  for (const [nodeId, node] of Object.entries(apiWorkflow || {})) {
    const mediaType = ASSET_LOADER_CLASSES[String(node?.class_type || '').trim()]
    if (mediaType) refs.push({ nodeId, mediaType })
  }
  return refs
}

function detectAssetBindings(apiWorkflow, template) {
  const assets = []
  let primaryTaken = false
  let referenceIndex = 0

  for (const { nodeId, mediaType } of collectMediaInputRefs(apiWorkflow, template)) {
    const apiNode = apiWorkflow[nodeId]
    const inputKey = resolveAssetInputKey(apiNode, mediaType)
    if (!primaryTaken && (mediaType === 'image' || mediaType === 'video')) {
      primaryTaken = true
      assets.push({ source: 'primary', fieldId: 'asset', nodeId, inputKey, assetType: mediaType })
      continue
    }
    referenceIndex += 1
    assets.push({
      source: 'field',
      fieldId: `templateInput${referenceIndex}`,
      nodeId,
      inputKey,
      assetType: mediaType,
    })
  }

  return assets
}

/**
 * Inspect a converted template and derive everything the Generate form needs:
 * queue-time bindings (node id + input key per value) and the manifest fields
 * that collect those values from the user.
 */
export function detectImportedWorkflowBindings(apiWorkflow, template) {
  const { positive, negative } = detectPromptBindings(apiWorkflow)
  const seeds = detectSeedBindings(apiWorkflow)
  const outputPrefixes = detectOutputPrefixBindings(apiWorkflow)
  const assets = detectAssetBindings(apiWorkflow, template)

  const primaryAsset = assets.find((asset) => asset.source === 'primary') || null

  const fields = []
  for (const asset of assets) {
    if (asset.source === 'primary') {
      fields.push({
        id: 'asset',
        label: asset.assetType === 'video' ? 'Input video' : 'Reference image',
        type: 'asset',
        assetType: asset.assetType,
      })
      continue
    }
    fields.push({
      id: asset.fieldId,
      label: asset.assetType === 'audio' ? 'Input audio'
        : asset.assetType === 'video' ? 'Input video'
          : `Reference image ${asset.fieldId.replace('templateInput', '')}`,
      type: 'assetSelect',
      assetType: asset.assetType,
      required: true,
    })
  }
  if (positive) fields.push({ id: 'prompt', label: 'Prompt', type: 'textarea' })
  if (seeds.length > 0) fields.push({ id: 'seed', label: 'Seed', type: 'seed' })

  return {
    bindings: {
      prompt: positive,
      negativePrompt: negative,
      seeds,
      assets,
      outputPrefixes,
    },
    fields,
    needsImage: Boolean(primaryAsset),
    inputAssetType: primaryAsset ? primaryAsset.assetType : undefined,
  }
}

/**
 * Apply user values onto a fresh copy of an imported API workflow. Empty
 * values leave the template's baked-in defaults untouched.
 */
export function applyImportedWorkflowBindings(workflowJson, bindings, values = {}) {
  const workflow = JSON.parse(JSON.stringify(workflowJson))
  const setInput = (binding, value) => {
    const node = binding ? workflow[binding.nodeId] : null
    if (!node || typeof node !== 'object') return
    if (!node.inputs || typeof node.inputs !== 'object') node.inputs = {}
    node.inputs[binding.inputKey] = value
  }

  const promptText = String(values.prompt || '').trim()
  if (bindings?.prompt && promptText) setInput(bindings.prompt, promptText)

  const negativeText = String(values.negativePrompt || '').trim()
  if (bindings?.negativePrompt && negativeText) setInput(bindings.negativePrompt, negativeText)

  const seed = Number(values.seed)
  if (Number.isFinite(seed)) {
    for (const seedBinding of bindings?.seeds || []) setInput(seedBinding, seed)
  }

  for (const asset of bindings?.assets || []) {
    const filename = asset.source === 'primary'
      ? (asset.assetType === 'video' ? values.inputVideo : values.inputImage)
      : values.assetFieldFilenames?.[asset.fieldId]
    if (filename) setInput(asset, filename)
  }

  const filenamePrefix = String(values.filenamePrefix || '').trim()
  if (filenamePrefix) {
    for (const prefixBinding of bindings?.outputPrefixes || []) setInput(prefixBinding, filenamePrefix)
  }

  return workflow
}
