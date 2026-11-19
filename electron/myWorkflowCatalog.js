const fs = require('fs').promises
const path = require('path')

const MY_WORKFLOW_ID_PREFIX = 'my-workflow:'
const CUSTOM_WORKFLOWS_DIR_NAME = 'custom-workflows'

const ENDPOINTS = Object.freeze({
  inputImage: 'VELORN_INPUT_IMAGE',
  prompt: 'VELORN_PROMPT',
  seed: 'VELORN_SEED',
  width: 'VELORN_WIDTH',
  height: 'VELORN_HEIGHT',
  referenceImage1: 'VELORN_REFERENCE_IMAGE_1',
  referenceImage2: 'VELORN_REFERENCE_IMAGE_2',
  fps: 'VELORN_FPS',
  duration: 'VELORN_DURATION',
  inputAudio: 'VELORN_AUDIO',
  outputImage: 'VELORN_OUTPUT_IMAGE',
  outputVideo: 'VELORN_OUTPUT_VIDEO',
})

function normalizeEndpointTitle(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function endpointTitleAliases(endpointName) {
  return [endpointName, endpointName.replace(/^VELORN_/, 'COMFYSTUDIO_')]
}

function titleMatchesEndpoint(title, endpointName) {
  const normalizedTitle = normalizeEndpointTitle(title)
  return Boolean(normalizedTitle) && endpointTitleAliases(endpointName)
    .some((name) => normalizedTitle.includes(normalizeEndpointTitle(name)))
}

function collectUiWorkflowNodes(uiWorkflow) {
  const nodes = []
  if (Array.isArray(uiWorkflow?.nodes)) nodes.push(...uiWorkflow.nodes)
  for (const subgraph of uiWorkflow?.definitions?.subgraphs || []) {
    if (Array.isArray(subgraph?.nodes)) nodes.push(...subgraph.nodes)
  }
  return nodes
}

function findEndpointNodes(uiWorkflow) {
  const result = {}
  for (const node of collectUiWorkflowNodes(uiWorkflow)) {
    for (const [key, endpointName] of Object.entries(ENDPOINTS)) {
      if (!result[key] && titleMatchesEndpoint(node?.title, endpointName)) {
        result[key] = node
      }
    }
  }
  return result
}

function toMyWorkflowId(libraryId = '') {
  const normalized = String(libraryId || '').trim()
  return normalized ? `${MY_WORKFLOW_ID_PREFIX}${normalized}` : ''
}

function fromMyWorkflowId(workflowId = '') {
  const normalized = String(workflowId || '').trim()
  return normalized.startsWith(MY_WORKFLOW_ID_PREFIX)
    ? normalized.slice(MY_WORKFLOW_ID_PREFIX.length).trim()
    : ''
}

function isMyWorkflowId(workflowId = '') {
  return Boolean(fromMyWorkflowId(workflowId))
}

function analyzeMyWorkflowRecord(record = {}) {
  const uiWorkflow = record?.uiWorkflow
  const endpoints = findEndpointNodes(uiWorkflow)
  const hasImageOutput = Boolean(endpoints.outputImage)
  const hasVideoOutput = Boolean(endpoints.outputVideo)
  const blockers = []

  if (!uiWorkflow || typeof uiWorkflow !== 'object' || !Array.isArray(uiWorkflow.nodes)) {
    blockers.push('The saved entry is missing its ComfyUI graph.')
  }
  if (!endpoints.prompt) blockers.push(`Add a node titled ${ENDPOINTS.prompt}.`)
  if (!hasImageOutput && !hasVideoOutput) {
    blockers.push(`Add either ${ENDPOINTS.outputImage} or ${ENDPOINTS.outputVideo}.`)
  }
  if (hasImageOutput && hasVideoOutput) {
    blockers.push(`Keep only one agent output marker: ${ENDPOINTS.outputImage} or ${ENDPOINTS.outputVideo}.`)
  }
  if (hasImageOutput && String(endpoints.outputImage?.type || '') !== 'SaveImage') {
    blockers.push(`${ENDPOINTS.outputImage} must be a SaveImage node.`)
  }

  const outputType = hasImageOutput === hasVideoOutput
    ? null
    : (hasVideoOutput ? 'video' : 'image')
  const needsImage = Boolean(endpoints.inputImage)
  const requiredAssetFields = needsImage
    ? [{ id: 'image', label: 'Input image', assetType: 'image', required: true }]
    : []
  const optionalAssetFields = []
  if (endpoints.referenceImage1) {
    optionalAssetFields.push({ id: 'referenceImage1', label: 'Reference image 1', assetType: 'image', required: false })
  }
  if (endpoints.referenceImage2) {
    optionalAssetFields.push({ id: 'referenceImage2', label: 'Reference image 2', assetType: 'image', required: false })
  }
  if (endpoints.inputAudio) {
    optionalAssetFields.push({ id: 'audio', label: 'Input audio', assetType: 'audio', required: false })
  }

  const markerStatus = Object.fromEntries(
    Object.keys(ENDPOINTS).map((key) => [key, Boolean(endpoints[key])])
  )
  const mcpRunnable = blockers.length === 0

  return {
    mcpRunnable,
    readiness: mcpRunnable ? 'ready' : 'needs-setup',
    readinessMessage: mcpRunnable
      ? `Ready for agent-driven ${outputType} generation.`
      : blockers.join(' '),
    blockers,
    outputType,
    needsImage,
    acceptsAudio: Boolean(endpoints.inputAudio),
    markerStatus,
    requiredAssetFields,
    optionalAssetFields,
  }
}

function createMyWorkflowCatalogEntry(record = {}, filePath = '') {
  const libraryId = String(record?.id || '').trim()
  const label = String(record?.title || '').trim()
  if (!libraryId || !label) return null

  const analysis = analyzeMyWorkflowRecord(record)
  return {
    id: toMyWorkflowId(libraryId),
    libraryId,
    label,
    category: analysis.outputType || 'custom',
    libraryCategory: String(record?.category || '').trim() || null,
    runtime: 'local',
    needsImage: analysis.needsImage,
    description: String(record?.description || '').trim().slice(0, 2000) || analysis.readinessMessage,
    savedDescription: String(record?.description || '').trim().slice(0, 2000),
    hasApiWorkflow: Boolean(record?.apiWorkflow && typeof record.apiWorkflow === 'object' && !Array.isArray(record.apiWorkflow)),
    file: path.basename(filePath || `${libraryId}.json`),
    path: filePath,
    source: 'my-workflows',
    nodeCount: Number(record?.nodeCount) || collectUiWorkflowNodes(record?.uiWorkflow).length,
    savedAt: Number(record?.savedAt) || null,
    updatedAt: Number(record?.updatedAt) || Number(record?.savedAt) || null,
    ...analysis,
  }
}

async function loadMyWorkflowCatalog(userDataPath, options = {}) {
  const fsApi = options.fs || fs
  const workflowsDir = path.join(String(userDataPath || ''), CUSTOM_WORKFLOWS_DIR_NAME)
  const workflows = []
  const errors = []

  let files = []
  try {
    files = await fsApi.readdir(workflowsDir)
  } catch (error) {
    if (error?.code !== 'ENOENT') errors.push(error?.message || String(error))
    return { success: errors.length === 0, workflowsDir, count: 0, workflows, errors }
  }

  for (const file of files.filter((name) => String(name || '').toLowerCase().endsWith('.json')).sort()) {
    const filePath = path.join(workflowsDir, file)
    try {
      const record = JSON.parse(await fsApi.readFile(filePath, 'utf8'))
      const entry = createMyWorkflowCatalogEntry(record, filePath)
      if (entry) workflows.push(entry)
      else errors.push(`${file}: missing workflow id or title.`)
    } catch (error) {
      errors.push(`${file}: ${error?.message || String(error)}`)
    }
  }

  return {
    success: true,
    workflowsDir,
    count: workflows.length,
    workflows,
    errors,
  }
}

module.exports = {
  CUSTOM_WORKFLOWS_DIR_NAME,
  ENDPOINTS,
  MY_WORKFLOW_ID_PREFIX,
  analyzeMyWorkflowRecord,
  createMyWorkflowCatalogEntry,
  fromMyWorkflowId,
  isMyWorkflowId,
  loadMyWorkflowCatalog,
  toMyWorkflowId,
}
