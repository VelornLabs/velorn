function asStringList(values) {
  return Array.isArray(values)
    ? values.map((entry) => String(entry || '').trim()).filter(Boolean)
    : []
}

function choicesFromObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return asStringList(value.values || value.choices || value.options || value.enum)
}

const MODEL_FILE_INPUT_RE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i

function modelPathBasename(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return ''
  const parts = normalized.split(/[\\/]+/)
  return parts[parts.length - 1] || ''
}

function getSchemaInputSpec(nodeSchema, inputKey) {
  const requiredSpec = nodeSchema?.input?.required?.[inputKey]
  if (requiredSpec !== undefined) return requiredSpec
  const optionalSpec = nodeSchema?.input?.optional?.[inputKey]
  if (optionalSpec !== undefined) return optionalSpec
  return null
}

export function workflowHasModelFileInputs(workflow) {
  if (!workflow || typeof workflow !== 'object') return false
  return Object.values(workflow).some((node) => Object.values(node?.inputs || {}).some(
    (value) => typeof value === 'string' && MODEL_FILE_INPUT_RE.test(value.trim()),
  ))
}

/**
 * Read combo choices from the object_info shapes used by older and newer
 * ComfyUI releases and custom nodes.
 */
export function extractComboChoicesFromSpec(inputSpec) {
  if (!inputSpec) return []

  if (Array.isArray(inputSpec)) {
    const [typeOrChoices, config] = inputSpec
    if (Array.isArray(typeOrChoices)) return asStringList(typeOrChoices)

    const inlineChoices = choicesFromObject(typeOrChoices)
    if (inlineChoices.length > 0) return inlineChoices

    // The new COMBO options schema uses ["COMBO", { options: [...] }].
    if (String(typeOrChoices || '').toUpperCase() === 'COMBO') {
      return choicesFromObject(config)
    }
  }

  return choicesFromObject(inputSpec)
}

/**
 * Resolve bare model filenames in a workflow against ComfyUI's object_info.
 * Returns the resolved workflow together with substitution metadata.
 */
export function resolveSubfolderModelPathsFromObjectInfo(workflow, objectInfo) {
  if (!workflow || typeof workflow !== 'object') return { workflow, substitutions: [] }
  if (!objectInfo || typeof objectInfo !== 'object') return { workflow, substitutions: [] }

  const substitutions = []
  for (const [nodeId, node] of Object.entries(workflow)) {
    const inputs = node?.inputs
    if (!inputs || typeof inputs !== 'object') continue
    const classType = String(node?.class_type || '').trim()
    const nodeSchema = objectInfo[classType]
    if (!nodeSchema) continue

    for (const [inputKey, value] of Object.entries(inputs)) {
      if (typeof value !== 'string') continue
      const trimmed = value.trim()
      if (!MODEL_FILE_INPUT_RE.test(trimmed)) continue

      const choices = extractComboChoicesFromSpec(getSchemaInputSpec(nodeSchema, inputKey))
      if (choices.length === 0) continue
      const lowerValue = trimmed.toLowerCase()
      if (choices.some((choice) => String(choice).toLowerCase() === lowerValue)) continue

      const wantedBasename = modelPathBasename(trimmed)
      if (!wantedBasename) continue
      const candidates = choices.filter((choice) => modelPathBasename(choice) === wantedBasename)
      if (candidates.length === 0) continue
      const resolved = [...candidates].sort()[0]
      substitutions.push({ nodeId, classType, inputKey, value: trimmed, resolved, ambiguous: candidates.length > 1 })
    }
  }

  if (substitutions.length === 0) return { workflow, substitutions }
  const resolvedWorkflow = JSON.parse(JSON.stringify(workflow))
  for (const substitution of substitutions) {
    resolvedWorkflow[substitution.nodeId].inputs[substitution.inputKey] = substitution.resolved
  }
  return { workflow: resolvedWorkflow, substitutions }
}
