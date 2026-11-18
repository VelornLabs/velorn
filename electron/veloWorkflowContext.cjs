'use strict'

const { compactJsonText } = require('./localAgentJson.cjs')

// Only known immutable workflow data may leave the active context. Everything
// else in these native receipts stays verbatim; exact originals remain in the
// turn-local result store. This is not a tool/result success classifier.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const scalar = value => value === null || ['string', 'boolean'].includes(typeof value)
  || (typeof value === 'number' && Number.isFinite(value))
const keysOnly = (value, names) => object(value) && Object.keys(value).every(key => names.includes(key))
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
// Unknown diagnostic/state metadata inside a graph must not disappear merely
// because the graph otherwise resembles API input. Fail closed for that field.
const diagnosticKey = /error|warn|failure|status|state|fingerprint|receipt|running|pending|success|partial|changed/i
function containsMetadata(value) {
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => diagnosticKey.test(key) || containsMetadata(child))
}
function graphData(value) {
  if (!object(value) || !Object.keys(value).length || Object.keys(value).length > 200 || containsMetadata(value)) return false
  return Object.entries(value).every(([id, node]) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(id)
    && keysOnly(node, ['class_type', 'inputs', '_meta']) && typeof node.class_type === 'string' && node.class_type.length > 0
    && object(node.inputs) && Object.values(node.inputs).every(input => scalar(input)
      || (Array.isArray(input) && input.length === 2 && ['string', 'number'].includes(typeof input[0])
        && Number.isSafeInteger(input[1]) && input[1] >= 0))
    && (node._meta === undefined || (keysOnly(node._meta, ['title', 'ver', 'cnr_id', 'aux_id', 'Node name for S&R'])
      && Object.values(node._meta).every(scalar))))
}
function parameterData(value) {
  return Array.isArray(value) && value.length > 0 && value.every(item =>
    keysOnly(item, ['fieldId', 'label', 'nodeId', 'inputKey', 'valueType', 'defaultValue'])
    && ['fieldId', 'label', 'nodeId', 'inputKey'].every(key => typeof item[key] === 'string')
    && ['string', 'integer', 'number', 'boolean'].includes(item.valueType)
    && Object.hasOwn(item, 'defaultValue') && scalar(item.defaultValue))
}
function namedInputData(value) {
  return Array.isArray(value) && value.length > 0 && value.every(item => keysOnly(item, ['name', 'nodeId', 'input'])
    && ['name', 'nodeId', 'input'].every(key => typeof item[key] === 'string'))
}
function workflowProjection(toolName, result, blocks) {
  if (result.isError === true || !blocks || blocks.length !== 1 || !object(blocks[0])) return null
  const data = blocks[0], fields = []
  // JSON.parse alone can discard duplicate keys or round numeric tokens. Native
  // receipts use canonical JSON; keep any non-lossless serialization verbatim.
  if (compactJsonText(result.content[0].text) !== JSON.stringify(data)) return null
  if (toolName === 'inspect_velorn_workflow' && data.action === toolName && data.success === true
    && object(data.workflow) && typeof data.workflow.id === 'string' && fingerprint(data.graphFingerprint)) {
    fields.push([['workflowJson'], graphData], [['bindings', 'parameters'], parameterData], [['queueInputs', 'namedInputs'], namedInputData])
  } else if (toolName === 'import_comfyui_workflow' && data.action === toolName
    && (data.previewOnly === true || (data.previewOnly === false && data.success === true)) && data.success !== false
    && object(data.plan) && data.plan.format === 'api' && typeof data.plan.workflowId === 'string'
    && fingerprint(data.plan.sourceFingerprint) && (data.plan.targetFingerprint === 'absent' || fingerprint(data.plan.targetFingerprint))) {
    fields.push([['plan', 'bindings', 'parameters'], parameterData])
  } else if (toolName === 'inspect_comfyui_run' && data.success === true && typeof data.runId === 'string'
    && data.cannotExactReplay === true && typeof data.redacted === 'boolean' && fingerprint(data.fingerprint)) {
    fields.push([['workflow'], graphData])
  } else return null

  const receipt = JSON.parse(JSON.stringify(data)), retainedFields = []
  for (const [fieldPath, accepts] of fields) {
    let parent = receipt
    for (const key of fieldPath.slice(0, -1)) parent = object(parent) ? parent[key] : undefined
    if (!object(parent)) continue
    const key = fieldPath.at(-1), value = parent[key]
    if (!accepts(value)) continue
    const exactChars = JSON.stringify(value).length
    // Tiny descriptors should not replace smaller originals or add noise.
    if (exactChars < 512) continue
    parent[key] = { kind: 'retained-workflow-data', fieldPath, exactChars }
    retainedFields.push(fieldPath)
  }
  if (!retainedFields.length) return null
  const { content, ...envelope } = result, { text, ...blockFields } = content[0]
  return { kind: 'workflow-data', body: JSON.stringify({ originalMcpEnvelope: envelope,
    originalContentBlockFields: blockFields, workflowReceipt: receipt, retainedFields }) }
}

module.exports = { workflowProjection }
