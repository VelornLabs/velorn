import { comfyui } from './comfyui'
import { getLocalComfyConnectionSync } from './localComfyConnection'
import { detectImportedWorkflowBindings, detectOutputMediaFromClasses } from './importedWorkflowBindings'
import {
  IMPORTED_WORKFLOW_ID_PREFIX,
  getImportedWorkflowEntry,
  getImportedWorkflowStoragePaths,
  registerImportedWorkflow,
} from '../config/importedWorkflowRegistry'

const COMFY_REGISTRY_API_BASE = 'https://api.comfy.org'

function packDataToRecipe(data, fallbackName, notes) {
  const repoUrl = String(data?.repository || '').trim().replace(/\/+$/, '')
  if (!/^https:\/\/(github|gitlab)\.com\/[^/]+\/[^/]+$/i.test(repoUrl)) return null
  return {
    id: String(data?.id || fallbackName),
    kind: 'auto',
    displayName: String(data?.name || fallbackName),
    repoUrl,
    installDirName: repoUrl.split('/').pop().replace(/\.git$/i, ''),
    docsUrl: repoUrl,
    requirementsStrategy: 'requirements-txt',
    notes,
  }
}

// Resolve the template's declared node packs against the Comfy Registry (the
// same source ComfyUI Manager uses) so missing custom nodes become one-click
// installs instead of manual homework. Unresolvable packs stay manual.
async function resolveNodePackRecipes(template) {
  const recipes = []
  const unresolved = []
  const seenIds = new Set()

  for (const packName of template.requiresCustomNodes || []) {
    const name = String(packName || '').trim()
    if (!name) continue

    let resolved = null
    for (const candidate of [...new Set([name, name.toLowerCase()])]) {
      try {
        const response = await fetch(`${COMFY_REGISTRY_API_BASE}/nodes/${encodeURIComponent(candidate)}`)
        if (!response.ok) continue
        resolved = packDataToRecipe(
          await response.json(),
          name,
          `Resolved from the Comfy Registry for the "${template.title}" template.`
        )
        if (resolved) break
      } catch {
        // Network hiccup or bad JSON — try the next candidate id.
      }
    }

    if (resolved && !seenIds.has(resolved.id)) {
      seenIds.add(resolved.id)
      recipes.push(resolved)
    } else if (!resolved) {
      unresolved.push(name)
    }
  }

  return { recipes, unresolved }
}

// Template metadata sometimes omits packs the graph actually uses (seen in the
// wild: LTX outpainting needs Float32ColorCorrect from "radiance", undeclared).
// The registry can resolve a node CLASS to its providing pack — use that for
// every class the user's ComfyUI doesn't know.
async function resolveNodeClassPacks(classTypes, template) {
  const recipesById = new Map()
  const uncovered = []

  for (const classType of classTypes) {
    let recipe = null
    try {
      const response = await fetch(`${COMFY_REGISTRY_API_BASE}/comfy-nodes/${encodeURIComponent(classType)}/node`)
      if (response.ok) {
        recipe = packDataToRecipe(
          await response.json(),
          classType,
          `Provides ${classType} — resolved from the Comfy Registry for the "${template.title}" template.`
        )
      }
    } catch {
      // Leave uncovered; the manual fallback stays visible.
    }
    if (recipe) recipesById.set(recipe.id, recipe)
    else uncovered.push(classType)
  }

  return { recipes: Array.from(recipesById.values()), uncovered }
}

// Widget keys that loader nodes commonly use for their model filename, tried
// when the converted prompt doesn't contain an exact value match.
const LOADER_INPUT_KEY_GUESSES = [
  'ckpt_name', 'lora_name', 'vae_name', 'clip_name', 'unet_name',
  'model_name', 'text_encoder', 'audio_vae', 'upscale_model',
]

// Frontend-only node types that never reach the server prompt.
const UI_ONLY_NODE_TYPES = new Set(['MarkdownNote', 'Note', 'Reroute', 'PrimitiveNode', 'GetNode', 'SetNode'])
const SUBGRAPH_INSTANCE_TYPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function collectUiWorkflowNodes(uiWorkflow) {
  return [
    ...(Array.isArray(uiWorkflow?.nodes) ? uiWorkflow.nodes : []),
    ...((uiWorkflow?.definitions?.subgraphs || []).flatMap((subgraph) => (
      Array.isArray(subgraph?.nodes) ? subgraph.nodes : []
    ))),
  ]
}

export function collectUiNodeTypes(uiWorkflow) {
  const types = new Set()
  for (const node of collectUiWorkflowNodes(uiWorkflow)) {
    const type = String(node?.type || '').trim()
    if (!type || UI_ONLY_NODE_TYPES.has(type) || SUBGRAPH_INSTANCE_TYPE_RE.test(type)) continue
    types.add(type)
  }
  return Array.from(types)
}

function collectEmbeddedModelMetadata(uiWorkflow) {
  const nodes = collectUiWorkflowNodes(uiWorkflow)

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

// --- Model-reference scanning for community workflows ----------------------
// Official templates embed properties.models metadata; community workflows
// almost never do. The scanner recovers model references from filename-shaped
// strings in the converted graph (or widget values before conversion) so the
// dependency checker has something to chew on. Report-only by design: a
// scanned model is never downloaded unless a URL arrives via embedded
// metadata, a widget value that is itself a URL, or an explicit hint.
const MODEL_FILE_EXT_RE = /\.(safetensors|sft|ckpt|pt|pth|gguf)$/i

// inputKey → models/ subdir, only where the destination is unambiguous.
const INPUT_KEY_TARGET_SUBDIRS = new Map([
  ['ckpt_name', 'checkpoints'],
  ['lora_name', 'loras'],
  ['vae_name', 'vae'],
  ['clip_name', 'text_encoders'],
  ['unet_name', 'diffusion_models'],
  ['control_net_name', 'controlnet'],
  ['style_model_name', 'style_models'],
])

// Loader-class fallbacks for widget-value scans (no inputKey available yet).
// Ordered: more specific needles first.
const CLASS_HINT_TARGET_SUBDIRS = [
  ['upscale', 'upscale_models'],
  ['controlnet', 'controlnet'],
  ['lora', 'loras'],
  ['checkpoint', 'checkpoints'],
  ['unet', 'diffusion_models'],
  ['clip', 'text_encoders'],
  ['vae', 'vae'],
]

function guessModelTargetSubdir(classType = '', inputKey = '') {
  const lowerClass = String(classType || '').toLowerCase()
  // CLIPVisionLoader also uses clip_name but stores under clip_vision.
  if (lowerClass.includes('clipvision') || lowerClass.includes('clip_vision')) return 'clip_vision'
  const byKey = INPUT_KEY_TARGET_SUBDIRS.get(String(inputKey || '').trim())
  if (byKey) return byKey
  if (String(inputKey || '').trim() === 'model_name' && lowerClass.includes('upscale')) return 'upscale_models'
  for (const [needle, subdir] of CLASS_HINT_TARGET_SUBDIRS) {
    if (lowerClass.includes(needle)) return subdir
  }
  return ''
}

// Loader filenames may carry relative subpaths ("flux/lora/x.safetensors") —
// keep those, but never anything that could escape the models folder.
function normalizeScannedModelPath(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/')
  if (!normalized || !MODEL_FILE_EXT_RE.test(normalized)) return null
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return null
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '..')) return null
  return normalized
}

function sanitizeRelativeSubdir(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!normalized || /^[a-z]:/i.test(normalized)) return ''
  if (normalized.split('/').some((segment) => !segment || segment === '..')) return ''
  return normalized
}

function modelBasename(value) {
  return String(value || '').trim().replace(/\\/g, '/').split('/').pop().toLowerCase()
}

export function scanWorkflowModelReferences(uiWorkflow, apiWorkflow = null) {
  const references = []
  const seen = new Set()

  const push = (rawValue, classType, inputKey, source) => {
    const raw = String(rawValue || '').trim()
    if (!raw || !MODEL_FILE_EXT_RE.test(raw)) return
    let downloadUrl = ''
    let candidate = raw
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      // Widget values are occasionally full download URLs (seen in the wild
      // on comfy.org workflows) — keep the URL, reference the basename.
      if (!/^https:\/\//i.test(raw)) return
      try {
        candidate = decodeURIComponent(new URL(raw).pathname.split('/').pop() || '')
      } catch {
        return
      }
      downloadUrl = raw
    }
    const filename = normalizeScannedModelPath(candidate)
    if (!filename) return
    const key = `${String(classType || '').toLowerCase()}::${String(inputKey || '').toLowerCase()}::${filename.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    references.push({
      filename,
      targetSubdir: guessModelTargetSubdir(classType, inputKey),
      classType: String(classType || '').trim(),
      inputKey: String(inputKey || '').trim(),
      source,
      downloadUrl,
    })
  }

  // Preferred: the converted prompt gives exact class_type/inputKey pairs.
  const apiNodes = Object.values(apiWorkflow || {})
  if (apiNodes.length > 0) {
    for (const node of apiNodes) {
      const classType = String(node?.class_type || '').trim()
      if (!classType) continue
      for (const [inputKey, value] of Object.entries(node?.inputs || {})) {
        if (typeof value === 'string') push(value, classType, inputKey, 'api')
      }
    }
    return references
  }

  // Fallback (preview, or conversion unavailable): scan widget values.
  for (const node of collectUiWorkflowNodes(uiWorkflow)) {
    const classType = String(node?.type || '').trim()
    if (!classType || SUBGRAPH_INSTANCE_TYPE_RE.test(classType)) continue
    const widgetValues = Array.isArray(node?.widgets_values)
      ? node.widgets_values
      : (node?.widgets_values && typeof node.widgets_values === 'object' ? Object.values(node.widgets_values) : [])
    for (const value of widgetValues) {
      if (typeof value === 'string') push(value, classType, '', 'widget')
    }
  }
  return references
}

function buildModelUrlHintMap(modelUrlHints) {
  const hints = new Map()
  for (const hint of Array.isArray(modelUrlHints) ? modelUrlHints : []) {
    const filename = modelBasename(hint?.filename)
    const url = String(hint?.url || '').trim()
    if (!filename || !/^https:\/\//i.test(url)) continue
    if (!hints.has(filename)) {
      hints.set(filename, { url, targetSubdir: sanitizeRelativeSubdir(hint?.targetSubdir) })
    }
  }
  return hints
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

function deriveCategoryAndOutput(template, apiWorkflow = null) {
  const inputs = Array.isArray(template?.io?.inputs) ? template.io.inputs : []
  const outputs = Array.isArray(template?.io?.outputs) ? template.io.outputs : []
  const hasImageInput = inputs.some((entry) => entry?.mediaType === 'image')
  const outputMedia = outputs.find((entry) => entry?.mediaType)?.mediaType
    || (apiWorkflow ? detectOutputMediaFromClasses(apiWorkflow) : '')
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

function buildManifest(template, derived, detection, { conversionIncomplete = false, unknownNodeTypes = [] } = {}) {
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
    runnable: !conversionIncomplete,
    imported: true,
    templateName: template.name,
    unknownNodeTypes,
    requiresCustomNodes: template.requiresCustomNodes || [],
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
 * Preview engine for arbitrary workflow imports: everything worth knowing
 * before committing — node coverage, resolvable packs, model references and
 * which of them can actually be downloaded. No writes, no conversion, no
 * registration.
 */
export async function analyzeWorkflowForImport(uiWorkflow, template, { modelUrlHints = [], objectInfo = null } = {}) {
  const uiNodeTypes = collectUiNodeTypes(uiWorkflow)
  const comfyUiConnected = Boolean(objectInfo)
  const unknownNodeTypes = objectInfo ? uiNodeTypes.filter((type) => !objectInfo?.[type]) : null

  const { recipes: declaredPackRecipes, unresolved: unresolvedNodePacks } = await resolveNodePackRecipes(template)
  const { recipes: classPackRecipes, uncovered: uncoveredNodeTypes } = (unknownNodeTypes && unknownNodeTypes.length > 0)
    ? await resolveNodeClassPacks(unknownNodeTypes, template)
    : { recipes: [], uncovered: [] }
  const resolvedPacks = []
  const seenPackIds = new Set()
  for (const recipe of [...classPackRecipes, ...declaredPackRecipes]) {
    if (seenPackIds.has(recipe.id)) continue
    seenPackIds.add(recipe.id)
    resolvedPacks.push(recipe)
  }

  const hintByBasename = buildModelUrlHintMap(modelUrlHints)
  const matchedHintFilenames = new Set()
  const models = []
  const seenModelBasenames = new Set()

  for (const model of collectEmbeddedModelMetadata(uiWorkflow)) {
    seenModelBasenames.add(modelBasename(model.name))
    const hint = hintByBasename.get(modelBasename(model.name))
    const downloadUrl = model.url || hint?.url || ''
    if (!model.url && hint?.url) matchedHintFilenames.add(modelBasename(model.name))
    models.push({
      filename: model.name,
      targetSubdir: model.directory,
      classType: model.nodeType || '',
      inputKey: '',
      source: 'embedded',
      downloadUrl,
      urlSource: model.url ? 'embedded' : (hint?.url ? 'hint' : null),
    })
  }

  for (const ref of scanWorkflowModelReferences(uiWorkflow, null)) {
    const base = modelBasename(ref.filename)
    if (seenModelBasenames.has(base)) continue
    seenModelBasenames.add(base)
    const hint = hintByBasename.get(base)
    const downloadUrl = ref.downloadUrl || hint?.url || ''
    if (!ref.downloadUrl && hint?.url) matchedHintFilenames.add(base)
    models.push({
      filename: ref.filename,
      targetSubdir: ref.targetSubdir || hint?.targetSubdir || '',
      classType: ref.classType,
      inputKey: ref.inputKey,
      source: ref.source,
      downloadUrl,
      urlSource: ref.downloadUrl ? 'embedded' : (hint?.url ? 'hint' : null),
    })
  }

  const unmatchedModelUrlHints = Array.from(hintByBasename.keys())
    .filter((filename) => !matchedHintFilenames.has(filename) && !models.some((model) => modelBasename(model.filename) === filename))

  const sizeByUrl = await probeModelSizes(models.filter((model) => model.downloadUrl).map((model) => ({ url: model.downloadUrl })))
  let totalKnownDownloadBytes = 0
  for (const model of models) {
    model.sizeBytes = model.downloadUrl ? (sizeByUrl.get(model.downloadUrl) ?? null) : null
    if (Number.isFinite(model.sizeBytes) && model.sizeBytes > 0) totalKnownDownloadBytes += model.sizeBytes
  }

  return {
    nodeTypes: uiNodeTypes,
    unknownNodeTypes,
    comfyUiConnected,
    conversionPossibleNow: comfyUiConnected && Array.isArray(unknownNodeTypes) && unknownNodeTypes.length === 0,
    nodePacks: { resolved: resolvedPacks, unresolved: unresolvedNodePacks, uncoveredNodeTypes },
    models,
    modelsMissingUrl: models.filter((model) => !model.downloadUrl).map((model) => model.filename),
    unmatchedModelUrlHints,
    totalKnownDownloadBytes,
  }
}

/**
 * Import one upstream ComfyUI template: fetch its UI-format workflow, convert
 * it to API format through the embedded ComfyUI frontend, derive a dependency
 * pack + install recipes from the embedded model metadata, persist everything
 * under userData/generate-templates/{name}/, and register it in the runtime
 * registry so it shows up alongside builtin workflows.
 */
export async function importComfyTemplate(template, { onProgress, uiWorkflow: providedUiWorkflow = null, modelUrlHints = [] } = {}) {
  const progress = (step, message) => { try { onProgress?.(step, message) } catch { /* UI only */ } }
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.convertComfyWorkflowGraph || !api?.writeFile) {
    throw new Error('Template import is only available in the desktop build.')
  }

  let uiWorkflow = providedUiWorkflow
  if (!uiWorkflow) {
    progress('fetch', 'Downloading the template workflow...')
    const response = await fetch(template.workflowUrl, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`Could not download the template workflow (${response.status}).`)
    }
    uiWorkflow = await response.json()
  }

  // Compare the template's node types against the live ComfyUI BEFORE
  // converting: the frontend silently loads unknown types as placeholders and
  // graphToPrompt then emits class_type-less husks, which used to slip past
  // the dependency check and only blow up at queue time.
  progress('analyze', 'Checking node requirements against your ComfyUI...')
  let objectInfo = null
  try {
    objectInfo = await comfyui.getObjectInfo()
  } catch {
    throw new Error('Could not read the node list from ComfyUI — make sure it is running, then retry.')
  }
  const uiNodeTypes = collectUiNodeTypes(uiWorkflow)
  const unknownNodeTypes = uiNodeTypes.filter((type) => !objectInfo?.[type])

  let apiWorkflow = null
  if (unknownNodeTypes.length === 0) {
    progress('convert', 'Converting through your ComfyUI...')
    const conversion = await api.convertComfyWorkflowGraph({
      workflowGraph: uiWorkflow,
      comfyBaseUrl: getLocalComfyConnectionSync().httpBase,
    })
    if (!conversion?.success || !conversion.output) {
      throw new Error(conversion?.error || 'ComfyUI could not convert this template.')
    }
    // Defense in depth: object_info said every type exists, but if the
    // conversion still produced placeholder husks, treat it as incomplete
    // rather than saving a workflow that fails at queue time.
    const placeholderNodes = Object.values(conversion.output)
      .filter((node) => !String(node?.class_type || '').trim())
    if (placeholderNodes.length === 0) {
      apiWorkflow = conversion.output
    }
  }
  const conversionIncomplete = !apiWorkflow

  progress('analyze', 'Resolving node packs from the Comfy Registry...')
  const { recipes: declaredPackRecipes, unresolved: unresolvedNodePacks } = await resolveNodePackRecipes(template)
  const { recipes: classPackRecipes, uncovered: uncoveredNodeTypes } = unknownNodeTypes.length > 0
    ? await resolveNodeClassPacks(unknownNodeTypes, template)
    : { recipes: [], uncovered: [] }
  const nodePackRecipes = []
  const seenPackIds = new Set()
  for (const recipe of [...classPackRecipes, ...declaredPackRecipes]) {
    if (seenPackIds.has(recipe.id)) continue
    seenPackIds.add(recipe.id)
    nodePackRecipes.push(recipe)
  }

  progress('analyze', 'Reading models and download sizes...')
  const embeddedModels = collectEmbeddedModelMetadata(uiWorkflow)
  const hintByBasename = buildModelUrlHintMap(modelUrlHints)
  const embeddedBasenames = new Set(embeddedModels.map((model) => modelBasename(model.name)))
  // Community workflows rarely embed properties.models — recover references
  // from the converted graph (or widgets) so the dependency check still sees
  // them; agent-supplied URL hints turn them into downloadable recipes.
  const scannedModels = scanWorkflowModelReferences(uiWorkflow, apiWorkflow)
    .filter((ref) => !embeddedBasenames.has(modelBasename(ref.filename)))
  const seenScannedBasenames = new Set()
  const uniqueScannedModels = scannedModels.filter((ref) => {
    const base = modelBasename(ref.filename)
    if (seenScannedBasenames.has(base)) return false
    seenScannedBasenames.add(base)
    return true
  })

  const hintUrlFor = (filename) => hintByBasename.get(modelBasename(filename))?.url || ''
  const sizeByUrl = await probeModelSizes([
    ...embeddedModels.map((model) => ({ url: model.url || hintUrlFor(model.name) })),
    ...uniqueScannedModels.map((ref) => ({ url: ref.downloadUrl || hintUrlFor(ref.filename) })),
  ].filter((entry) => entry.url))

  const requiredModels = []
  const recipes = []
  for (const model of embeddedModels) {
    const resolved = resolveModelInputKey(apiWorkflow || {}, model)
    if (resolved) {
      requiredModels.push({
        classType: resolved.classType,
        inputKey: resolved.inputKey,
        filename: model.name,
        targetSubdir: model.directory,
      })
    }
    const downloadUrl = model.url || hintUrlFor(model.name)
    if (downloadUrl) {
      recipes.push({
        filename: model.name,
        targetSubdir: model.directory,
        displayName: model.name,
        downloadUrl,
        sourceUrl: downloadUrl,
        licenseUrl: '',
        sizeBytes: sizeByUrl.get(downloadUrl) ?? null,
        sha256: '',
        notes: `From the ComfyUI template "${template.name}".`,
      })
    }
  }

  for (const ref of uniqueScannedModels) {
    const hint = hintByBasename.get(modelBasename(ref.filename))
    const targetSubdir = ref.targetSubdir || hint?.targetSubdir || ''
    // Without a destination folder the reference stays report-only: it can't
    // be checked on disk or downloaded, only surfaced to the agent/user.
    if (!targetSubdir) continue
    requiredModels.push({
      classType: ref.classType,
      inputKey: ref.inputKey || LOADER_INPUT_KEY_GUESSES[0],
      filename: ref.filename,
      targetSubdir,
    })
    const downloadUrl = ref.downloadUrl || hint?.url || ''
    if (downloadUrl) {
      recipes.push({
        filename: ref.filename,
        targetSubdir,
        displayName: ref.filename,
        downloadUrl,
        sourceUrl: downloadUrl,
        licenseUrl: '',
        sizeBytes: sizeByUrl.get(downloadUrl) ?? null,
        sha256: '',
        notes: `Referenced by the "${template.title}" workflow.`,
      })
    }
  }

  // Required nodes come from the UI workflow's declared types — the converted
  // output loses the type string for anything not installed, which is exactly
  // the case the dependency check must catch.
  const requiredNodes = Array.from(new Set([
    ...uiNodeTypes,
    ...Object.values(apiWorkflow || {})
      .map((node) => String(node?.class_type || '').trim())
      .filter(Boolean),
  ])).map((classType) => ({ classType }))

  const derived = deriveCategoryAndOutput(template, apiWorkflow)
  const detection = apiWorkflow
    ? detectImportedWorkflowBindings(apiWorkflow, template, uiWorkflow)
    : { bindings: null, fields: [], needsImage: derived.needsImage, inputAssetType: derived.needsImage ? 'image' : undefined }
  const manifest = buildManifest(template, derived, detection, { conversionIncomplete, unknownNodeTypes })
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
    nodePackRecipes,
    unresolvedNodePacks,
    uncoveredNodeTypes,
    bindings: detection.bindings,
    conversionIncomplete,
    // Full normalized template snapshot so re-imports (e.g. the automatic one
    // after missing nodes get installed) don't depend on the live catalog.
    template,
    importedAt: Date.now(),
    source: {
      workflowUrl: template.workflowUrl,
      sourceUrl: template.sourceUrl,
    },
  }

  if (apiWorkflow) {
    const wroteWorkflow = await api.writeFile(paths.workflowFile, JSON.stringify(apiWorkflow, null, 2), { encoding: 'utf8' })
    if (!wroteWorkflow?.success) throw new Error(wroteWorkflow?.error || 'Could not save the converted workflow.')
  } else if (api.deleteFile) {
    // A previous complete import may have left a workflow.json; don't let a
    // now-incomplete re-import leave a stale runnable graph behind.
    try { await api.deleteFile(paths.workflowFile) } catch { /* may not exist */ }
  }
  const wroteEntry = await api.writeFile(paths.entryFile, JSON.stringify(entry, null, 2), { encoding: 'utf8' })
  if (!wroteEntry?.success) throw new Error(wroteEntry?.error || 'Could not save the imported workflow entry.')

  // Persist the raw UI graph so re-imports (e.g. after node installs) never
  // depend on refetching workflowUrl — MCP/inline imports don't have one.
  if (paths.uiWorkflowFile) {
    const wroteUiWorkflow = await api.writeFile(paths.uiWorkflowFile, JSON.stringify(uiWorkflow), { encoding: 'utf8' })
    if (!wroteUiWorkflow?.success) throw new Error(wroteUiWorkflow?.error || 'Could not save the raw workflow graph.')
  }

  const registered = registerImportedWorkflow({ ...entry, workflowPath: paths.workflowFile })

  return { success: true, entry: registered }
}

/**
 * Re-run the import for an already-imported template using its stored
 * snapshot — used to finish "needs nodes" imports once the packs are in.
 */
export async function reimportImportedWorkflow(workflowId, options = {}) {
  const entry = getImportedWorkflowEntry(workflowId)
  if (!entry) throw new Error('This workflow is not an imported template.')
  if (!entry.template) {
    throw new Error('This import predates re-import support — use Re-import on the template in the ComfyUI tab.')
  }

  // Prefer the raw graph persisted at import time — works for MCP/tab imports
  // with no refetchable workflowUrl and keeps catalog reimports offline-safe.
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (api?.readFile) {
    try {
      const paths = await getImportedWorkflowStoragePaths(entry.templateName)
      const read = paths?.uiWorkflowFile ? await api.readFile(paths.uiWorkflowFile, { encoding: 'utf8' }) : null
      if (read?.success && read.data) {
        const parsed = JSON.parse(read.data)
        if (Array.isArray(parsed?.nodes)) {
          return importComfyTemplate(entry.template, { ...options, uiWorkflow: parsed })
        }
      }
    } catch {
      // Corrupt or missing ui-workflow.json — fall back to the URL path below.
    }
  }

  if (!entry.template.workflowUrl) {
    throw new Error('This workflow was captured from the ComfyUI tab — open it there and import it again to update it.')
  }
  return importComfyTemplate(entry.template, options)
}

// When the user opens a template in the embedded ComfyUI tab (to install
// nodes or tweak the graph), remember which template it was so an import
// from the tab keeps its identity (name, thumbnail, local/cloud routing).
let pendingComfyTabImportContext = null

export function setPendingComfyTabImportContext(template) {
  pendingComfyTabImportContext = template && typeof template === 'object' ? template : null
}

function buildCapturedTemplate(workflowName) {
  const now = new Date()
  const slugBase = String(workflowName || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return {
    name: `comfy-tab-${slugBase || 'workflow'}-${now.getTime().toString(36)}`,
    title: String(workflowName || '').trim() || `ComfyUI workflow (${now.toLocaleDateString()})`,
    description: 'Imported from the embedded ComfyUI tab.',
    tags: ['comfyui-tab'],
    models: [],
    date: '',
    openSource: true,
    sizeBytes: 0,
    vramBytes: 0,
    usage: 0,
    requiresCustomNodes: [],
    io: null,
    mediaType: '',
    mediaSubtype: '',
    thumbnailUrl: '',
    workflowUrl: '',
    sourceUrl: '',
  }
}

/**
 * Synthetic template for MCP-sourced imports (comfy.org URL, local file,
 * inline JSON). Deterministic name — no timestamp — so agents can re-run the
 * same call idempotently; collisions are the caller's overwrite decision.
 */
export function buildMcpImportTemplate({ name = '', title = '', sourceUrl = '' } = {}) {
  const slugify = (value) => String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  const slug = slugify(name) || slugify(title) || 'workflow'
  return {
    name: `mcp-${slug}`,
    title: String(title || '').trim() || String(name || '').trim() || 'Community workflow',
    description: sourceUrl ? `Imported via MCP from ${sourceUrl}` : 'Imported via MCP.',
    tags: ['mcp-import'],
    models: [],
    date: '',
    openSource: true,
    sizeBytes: 0,
    vramBytes: 0,
    usage: 0,
    requiresCustomNodes: [],
    io: null,
    mediaType: '',
    mediaSubtype: '',
    thumbnailUrl: '',
    workflowUrl: '',
    sourceUrl: String(sourceUrl || '').trim(),
  }
}

/**
 * Import whatever graph is currently open in the embedded ComfyUI tab. This
 * is the "fix it with ComfyUI's own tools, then import" path: the graph is
 * live, so its nodes all exist and conversion cannot produce placeholders.
 */
export async function importWorkflowFromComfyTab({ onProgress } = {}) {
  const progress = (step, message) => { try { onProgress?.(step, message) } catch { /* UI only */ } }
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.captureComfyWorkflowGraph || !api?.writeFile) {
    throw new Error('Importing from the ComfyUI tab is only available in the desktop build.')
  }

  progress('capture', 'Reading the current graph from ComfyUI...')
  const captured = await api.captureComfyWorkflowGraph({
    comfyBaseUrl: getLocalComfyConnectionSync().httpBase,
  })
  if (!captured?.success || !captured.output) {
    throw new Error(captured?.error || 'Could not capture the current ComfyUI graph.')
  }
  const apiWorkflow = captured.output
  const uiWorkflow = captured.workflow || null

  const placeholderNodes = Object.values(apiWorkflow)
    .filter((node) => !String(node?.class_type || '').trim())
  if (placeholderNodes.length > 0) {
    throw new Error('The graph still has missing (red) nodes — install them in ComfyUI first, then import again.')
  }

  const template = pendingComfyTabImportContext || buildCapturedTemplate(captured.workflowName)
  pendingComfyTabImportContext = null

  progress('analyze', 'Reading models and node requirements...')
  const { recipes: nodePackRecipes, unresolved: unresolvedNodePacks } = await resolveNodePackRecipes(template)
  const embeddedModels = uiWorkflow ? collectEmbeddedModelMetadata(uiWorkflow) : []
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

  const requiredNodes = Array.from(new Set([
    ...(uiWorkflow ? collectUiNodeTypes(uiWorkflow) : []),
    ...Object.values(apiWorkflow)
      .map((node) => String(node?.class_type || '').trim())
      .filter(Boolean),
  ])).map((classType) => ({ classType }))

  const derived = deriveCategoryAndOutput(template, apiWorkflow)
  const detection = detectImportedWorkflowBindings(apiWorkflow, template, uiWorkflow)
  const manifest = buildManifest(template, derived, detection, { conversionIncomplete: false, unknownNodeTypes: [] })
  const pack = {
    id: manifest.workflowId,
    displayName: template.title,
    requiredNodes,
    requiredModels,
    requiresComfyOrgApiKey: !template.openSource,
    docsUrl: template.sourceUrl || '',
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
    nodePackRecipes,
    unresolvedNodePacks,
    uncoveredNodeTypes: [],
    bindings: detection.bindings,
    conversionIncomplete: false,
    template,
    importedAt: Date.now(),
    source: {
      workflowUrl: template.workflowUrl || '',
      sourceUrl: template.sourceUrl || '',
      capturedFromTab: true,
    },
  }

  const wroteWorkflow = await api.writeFile(paths.workflowFile, JSON.stringify(apiWorkflow, null, 2), { encoding: 'utf8' })
  if (!wroteWorkflow?.success) throw new Error(wroteWorkflow?.error || 'Could not save the captured workflow.')
  const wroteEntry = await api.writeFile(paths.entryFile, JSON.stringify(entry, null, 2), { encoding: 'utf8' })
  if (!wroteEntry?.success) throw new Error(wroteEntry?.error || 'Could not save the imported workflow entry.')

  // Persist the raw UI graph when the capture provided one — makes tab
  // imports re-importable later (they have no workflowUrl to refetch).
  if (uiWorkflow && paths.uiWorkflowFile) {
    const wroteUiWorkflow = await api.writeFile(paths.uiWorkflowFile, JSON.stringify(uiWorkflow), { encoding: 'utf8' })
    if (!wroteUiWorkflow?.success) throw new Error(wroteUiWorkflow?.error || 'Could not save the raw workflow graph.')
  }

  const registered = registerImportedWorkflow({ ...entry, workflowPath: paths.workflowFile })
  return { success: true, entry: registered }
}
