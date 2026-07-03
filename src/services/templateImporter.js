import { comfyui } from './comfyui'
import { getLocalComfyConnectionSync } from './localComfyConnection'
import { detectImportedWorkflowBindings } from './importedWorkflowBindings'
import {
  IMPORTED_WORKFLOW_ID_PREFIX,
  getImportedWorkflowStoragePaths,
  registerImportedWorkflow,
} from '../config/importedWorkflowRegistry'

// Widget keys that loader nodes commonly use for their model filename, tried
// when the converted prompt doesn't contain an exact value match.
const LOADER_INPUT_KEY_GUESSES = [
  'ckpt_name', 'lora_name', 'vae_name', 'clip_name', 'unet_name',
  'model_name', 'text_encoder', 'audio_vae', 'upscale_model',
]

function collectEmbeddedModelMetadata(uiWorkflow) {
  const nodes = [
    ...(Array.isArray(uiWorkflow?.nodes) ? uiWorkflow.nodes : []),
    ...((uiWorkflow?.definitions?.subgraphs || []).flatMap((subgraph) => (
      Array.isArray(subgraph?.nodes) ? subgraph.nodes : []
    ))),
  ]

  const models = []
  const seen = new Set()
  for (const node of nodes) {
    const nodeModels = node?.properties?.models
    if (!Array.isArray(nodeModels)) continue
    for (const model of nodeModels) {
      const name = String(model?.name || '').trim()
      const url = String(model?.url || '').trim()
      const directory = String(model?.directory || '').trim()
      if (!name || !directory) continue
      const key = `${directory}::${name}`.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      models.push({ name, url, directory, nodeType: String(node?.type || '').trim() })
    }
  }
  return models
}

function resolveModelInputKey(apiWorkflow, model) {
  const apiNodes = Object.values(apiWorkflow || {})

  // Strongest signal: an input on the loader class whose value IS the filename.
  const candidates = apiNodes.filter((node) => !model.nodeType || node?.class_type === model.nodeType)
  for (const pool of [candidates, apiNodes]) {
    for (const node of pool) {
      for (const [inputKey, value] of Object.entries(node?.inputs || {})) {
        if (typeof value === 'string' && value.trim().toLowerCase() === model.name.toLowerCase()) {
          return { classType: node.class_type, inputKey }
        }
      }
    }
  }

  // Fall back to a conventional loader key present on the node. The dependency
  // checker degrades gracefully for a wrong guess (filesystem check by filename).
  for (const node of candidates) {
    for (const guess of LOADER_INPUT_KEY_GUESSES) {
      if (node?.inputs && guess in node.inputs) {
        return { classType: node.class_type, inputKey: guess }
      }
    }
  }

  return model.nodeType
    ? { classType: model.nodeType, inputKey: LOADER_INPUT_KEY_GUESSES[0] }
    : null
}

function deriveCategoryAndOutput(template) {
  const inputs = Array.isArray(template?.io?.inputs) ? template.io.inputs : []
  const outputs = Array.isArray(template?.io?.outputs) ? template.io.outputs : []
  const hasImageInput = inputs.some((entry) => entry?.mediaType === 'image')
  const outputMedia = outputs.find((entry) => entry?.mediaType)?.mediaType
    || (template.categoryId === 'video' ? 'video'
      : template.categoryId === 'audio' ? 'audio'
        : template.categoryId === 'image' ? 'image' : '')

  let category = 'utility'
  if (outputMedia === 'video') category = hasImageInput ? 'image-to-video' : 'text-to-video'
  else if (outputMedia === 'image') category = hasImageInput ? 'image-edit' : 'text-to-image'
  else if (outputMedia === 'audio') category = 'audio'

  return {
    category,
    outputType: outputMedia === 'audio' ? 'audio' : outputMedia === 'image' ? 'image' : 'video',
    needsImage: hasImageInput,
  }
}

function formatVramLabel(vramBytes) {
  const numeric = Number(vramBytes)
  if (!Number.isFinite(numeric) || numeric <= 0) return ''
  return `${Math.ceil(numeric / (1024 ** 3))}GB+ VRAM`
}

function buildManifest(template, derived, detection) {
  const workflowId = `${IMPORTED_WORKFLOW_ID_PREFIX}${template.name}`
  return {
    id: workflowId,
    workflowId,
    title: template.title,
    subtitle: template.models.join(' · ') || 'ComfyUI template',
    description: template.description,
    mode: 'generate',
    route: template.openSource ? 'local' : 'cloud',
    category: derived.category,
    provider: 'ComfyUI',
    cover: template.thumbnailUrl,
    badge: 'Imported',
    runtimeLabel: template.openSource
      ? formatVramLabel(template.vramBytes)
      : 'Requires API key',
    tags: [...template.tags, 'imported', template.name],
    needsImage: detection.needsImage,
    inputAssetType: detection.inputAssetType,
    outputType: derived.outputType,
    fields: detection.fields,
    runnable: true,
    imported: true,
    templateName: template.name,
  }
}

async function probeModelSizes(models) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  const urls = models.map((model) => model.url).filter(Boolean)
  if (!api?.probeWorkflowSetupUrlSizes || urls.length === 0) return new Map()
  try {
    const response = await api.probeWorkflowSetupUrlSizes({ urls })
    const sizeByUrl = new Map()
    for (const result of Array.isArray(response?.results) ? response.results : []) {
      if (result?.url) sizeByUrl.set(result.url, Number.isFinite(result.sizeBytes) ? result.sizeBytes : null)
    }
    return sizeByUrl
  } catch {
    return new Map()
  }
}

/**
 * Import one upstream ComfyUI template: fetch its UI-format workflow, convert
 * it to API format through the embedded ComfyUI frontend, derive a dependency
 * pack + install recipes from the embedded model metadata, persist everything
 * under userData/generate-templates/{name}/, and register it in the runtime
 * registry so it shows up alongside builtin workflows.
 */
export async function importComfyTemplate(template, { onProgress } = {}) {
  const progress = (step, message) => { try { onProgress?.(step, message) } catch { /* UI only */ } }
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.convertComfyWorkflowGraph || !api?.writeFile) {
    throw new Error('Template import is only available in the desktop build.')
  }

  progress('fetch', 'Downloading the template workflow...')
  const response = await fetch(template.workflowUrl, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`Could not download the template workflow (${response.status}).`)
  }
  const uiWorkflow = await response.json()

  progress('convert', 'Converting through your ComfyUI...')
  const conversion = await api.convertComfyWorkflowGraph({
    workflowGraph: uiWorkflow,
    comfyBaseUrl: getLocalComfyConnectionSync().httpBase,
  })
  if (!conversion?.success || !conversion.output) {
    throw new Error(conversion?.error || 'ComfyUI could not convert this template.')
  }
  const apiWorkflow = conversion.output

  progress('analyze', 'Reading models and node requirements...')
  const embeddedModels = collectEmbeddedModelMetadata(uiWorkflow)
  const sizeByUrl = await probeModelSizes(embeddedModels)

  const requiredModels = []
  const recipes = []
  for (const model of embeddedModels) {
    const resolved = resolveModelInputKey(apiWorkflow, model)
    if (resolved) {
      requiredModels.push({
        classType: resolved.classType,
        inputKey: resolved.inputKey,
        filename: model.name,
        targetSubdir: model.directory,
      })
    }
    if (model.url) {
      recipes.push({
        filename: model.name,
        targetSubdir: model.directory,
        displayName: model.name,
        downloadUrl: model.url,
        sourceUrl: model.url,
        licenseUrl: '',
        sizeBytes: sizeByUrl.get(model.url) ?? null,
        sha256: '',
        notes: `From the ComfyUI template "${template.name}".`,
      })
    }
  }

  const requiredNodes = Array.from(new Set(
    Object.values(apiWorkflow)
      .map((node) => String(node?.class_type || '').trim())
      .filter(Boolean)
  )).map((classType) => ({ classType }))

  const derived = deriveCategoryAndOutput(template)
  const detection = detectImportedWorkflowBindings(apiWorkflow, template)
  const manifest = buildManifest(template, derived, detection)
  const pack = {
    id: manifest.workflowId,
    displayName: template.title,
    requiredNodes,
    requiredModels,
    requiresComfyOrgApiKey: !template.openSource,
    docsUrl: template.sourceUrl,
  }

  progress('save', 'Saving the imported workflow...')
  const paths = await getImportedWorkflowStoragePaths(template.name)
  if (!paths) throw new Error('Could not resolve the imported-workflow storage folder.')
  await api.createDirectory?.(paths.dir, { recursive: true })

  const entry = {
    workflowId: manifest.workflowId,
    templateName: template.name,
    manifest,
    pack,
    recipes,
    bindings: detection.bindings,
    importedAt: Date.now(),
    source: {
      workflowUrl: template.workflowUrl,
      sourceUrl: template.sourceUrl,
    },
  }

  const wroteWorkflow = await api.writeFile(paths.workflowFile, JSON.stringify(apiWorkflow, null, 2), { encoding: 'utf8' })
  if (!wroteWorkflow?.success) throw new Error(wroteWorkflow?.error || 'Could not save the converted workflow.')
  const wroteEntry = await api.writeFile(paths.entryFile, JSON.stringify(entry, null, 2), { encoding: 'utf8' })
  if (!wroteEntry?.success) throw new Error(wroteEntry?.error || 'Could not save the imported workflow entry.')

  const registered = registerImportedWorkflow({ ...entry, workflowPath: paths.workflowFile })

  // Nudge the dependency scanner so "Set up — X GB" reflects reality right away.
  try { await comfyui.getObjectInfo() } catch { /* offline is fine here */ }

  return { success: true, entry: registered }
}
