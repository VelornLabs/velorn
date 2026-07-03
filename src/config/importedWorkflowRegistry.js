// Runtime registry for ComfyUI templates the user has imported from the
// official catalog. Static config modules (generateWorkflowCatalog,
// workflowDependencyPacks, workflowInstallCatalog) consult this store from
// their lookup functions, so imported workflows behave like builtins without
// touching the static registries. This module must stay dependency-free to
// avoid import cycles with those config files.

export const IMPORTED_WORKFLOW_ID_PREFIX = 'tpl-'
export const IMPORTED_WORKFLOWS_DIR_NAME = 'generate-templates'
export const IMPORTED_WORKFLOWS_CHANGED_EVENT = 'comfystudio:imported-workflows-changed'

const ENTRY_FILE_NAME = 'entry.json'
export const IMPORTED_WORKFLOW_FILE_NAME = 'workflow.json'

const entriesById = new Map()
const recipesByModelKey = new Map()
let loadPromise = null

function modelRecipeKey(targetSubdir = '', filename = '') {
  return `${String(targetSubdir || '').trim().toLowerCase()}::${String(filename || '').trim().toLowerCase()}`
}

function notifyChanged() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(IMPORTED_WORKFLOWS_CHANGED_EVENT))
}

function indexEntry(entry) {
  entriesById.set(entry.workflowId, entry)
  for (const recipe of entry.recipes || []) {
    const key = modelRecipeKey(recipe.targetSubdir, recipe.filename)
    if (!recipesByModelKey.has(key)) recipesByModelKey.set(key, recipe)
  }
}

function reindexAll() {
  recipesByModelKey.clear()
  const entries = Array.from(entriesById.values())
  entriesById.clear()
  for (const entry of entries) indexEntry(entry)
}

export function getImportedWorkflowEntries() {
  return Array.from(entriesById.values())
}

export function getImportedWorkflowEntry(workflowId) {
  return entriesById.get(String(workflowId || '').trim()) || null
}

export function isImportedWorkflowId(workflowId) {
  return entriesById.has(String(workflowId || '').trim())
}

export function getImportedManifests() {
  return getImportedWorkflowEntries().map((entry) => entry.manifest).filter(Boolean)
}

export function getImportedManifestByWorkflowId(workflowId) {
  return getImportedWorkflowEntry(workflowId)?.manifest || null
}

export function getImportedManifestById(id) {
  const normalized = String(id || '').trim()
  for (const entry of entriesById.values()) {
    if (entry.manifest?.id === normalized) return entry.manifest
  }
  return null
}

export function getImportedDependencyPack(workflowId) {
  return getImportedWorkflowEntry(workflowId)?.pack || null
}

export function getImportedModelRecipe({ filename = '', targetSubdir = '' } = {}) {
  return recipesByModelKey.get(modelRecipeKey(targetSubdir, filename)) || null
}

export function isTemplateImported(templateName) {
  const normalized = String(templateName || '').trim()
  if (!normalized) return false
  for (const entry of entriesById.values()) {
    if (entry.templateName === normalized) return true
  }
  return false
}

async function getImportedWorkflowsDir() {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.getAppPath || !api?.pathJoin) return null
  try {
    const userData = await api.getAppPath('userData')
    if (!userData) return null
    return await api.pathJoin(userData, IMPORTED_WORKFLOWS_DIR_NAME)
  } catch {
    return null
  }
}

export async function getImportedWorkflowStoragePaths(templateName) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  const baseDir = await getImportedWorkflowsDir()
  if (!api?.pathJoin || !baseDir) return null
  const dir = await api.pathJoin(baseDir, String(templateName || '').trim())
  return {
    dir,
    entryFile: await api.pathJoin(dir, ENTRY_FILE_NAME),
    workflowFile: await api.pathJoin(dir, IMPORTED_WORKFLOW_FILE_NAME),
  }
}

function normalizeLoadedEntry(parsed, workflowPath) {
  if (!parsed || typeof parsed !== 'object') return null
  const workflowId = String(parsed.workflowId || '').trim()
  const templateName = String(parsed.templateName || '').trim()
  if (!workflowId || !templateName || !parsed.manifest || !parsed.pack) return null
  return {
    workflowId,
    templateName,
    manifest: parsed.manifest,
    pack: parsed.pack,
    recipes: Array.isArray(parsed.recipes) ? parsed.recipes : [],
    workflowPath,
    importedAt: Number(parsed.importedAt) || 0,
    source: parsed.source && typeof parsed.source === 'object' ? parsed.source : {},
  }
}

async function loadFromDiskOnce() {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  const baseDir = await getImportedWorkflowsDir()
  if (!api?.listDirectory || !api?.readFile || !api?.pathJoin || !baseDir) return

  let listing = null
  try {
    listing = await api.listDirectory(baseDir)
  } catch {
    return
  }
  if (!listing?.success || !Array.isArray(listing.items)) return

  for (const item of listing.items) {
    const name = typeof item === 'string' ? item : item?.name
    if (!name) continue
    try {
      const dir = await api.pathJoin(baseDir, name)
      const entryFile = await api.pathJoin(dir, ENTRY_FILE_NAME)
      const workflowFile = await api.pathJoin(dir, IMPORTED_WORKFLOW_FILE_NAME)
      const read = await api.readFile(entryFile, { encoding: 'utf8' })
      if (!read?.success || !read.data) continue
      const entry = normalizeLoadedEntry(JSON.parse(read.data), workflowFile)
      if (entry) indexEntry(entry)
    } catch {
      // Skip corrupt entries; the rest of the registry still loads.
    }
  }

  if (entriesById.size > 0) notifyChanged()
}

export function loadImportedWorkflowsFromDisk() {
  if (!loadPromise) {
    loadPromise = loadFromDiskOnce().catch(() => {})
  }
  return loadPromise
}

export function registerImportedWorkflow(entry) {
  const normalized = normalizeLoadedEntry(entry, entry?.workflowPath || '')
  if (!normalized) throw new Error('Invalid imported workflow entry.')
  indexEntry(normalized)
  notifyChanged()
  return normalized
}

export async function removeImportedWorkflow(workflowId) {
  const entry = getImportedWorkflowEntry(workflowId)
  if (!entry) return false
  entriesById.delete(entry.workflowId)
  reindexAll()

  const api = typeof window !== 'undefined' ? window.electronAPI : null
  const paths = await getImportedWorkflowStoragePaths(entry.templateName)
  if (api?.deleteDirectory && paths?.dir) {
    try {
      await api.deleteDirectory(paths.dir, { recursive: true })
    } catch {
      // Files may linger; the entry is gone from the registry either way.
    }
  }
  notifyChanged()
  return true
}
