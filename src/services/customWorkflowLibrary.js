// Personal workflow library: graphs the user saved from the embedded ComfyUI
// tab. Launcher model — each entry stores the UI-format graph so a click can
// load it straight back into the tab. No conversion, no forms, no bindings.

import { getLocalComfyConnectionSync } from './localComfyConnection'
import { openUiWorkflowInComfyUi } from './workflowSetupManager'

const CUSTOM_WORKFLOWS_DIR_NAME = 'custom-workflows'
export const CUSTOM_WORKFLOW_LIBRARY_CHANGED_EVENT = 'comfystudio:custom-workflow-library-changed'

const entriesById = new Map()
let loadPromise = null

function notifyChanged() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(CUSTOM_WORKFLOW_LIBRARY_CHANGED_EVENT))
}

function slugify(title) {
  return String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'workflow'
}

async function getLibraryDir() {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.getAppPath || !api?.pathJoin) return null
  try {
    const userData = await api.getAppPath('userData')
    if (!userData) return null
    return await api.pathJoin(userData, CUSTOM_WORKFLOWS_DIR_NAME)
  } catch {
    return null
  }
}

async function getEntryFilePath(id) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  const dir = await getLibraryDir()
  if (!api?.pathJoin || !dir) return null
  return await api.pathJoin(dir, `${id}.json`)
}

function toListEntry(parsed, filePath) {
  const id = String(parsed?.id || '').trim()
  const title = String(parsed?.title || '').trim()
  if (!id || !title) return null
  return {
    id,
    title,
    savedAt: Number(parsed.savedAt) || 0,
    updatedAt: Number(parsed.updatedAt) || Number(parsed.savedAt) || 0,
    nodeCount: Number(parsed.nodeCount) || 0,
    thumbnail: typeof parsed.thumbnail === 'string' ? parsed.thumbnail : '',
    category: typeof parsed.category === 'string' ? parsed.category.trim() : '',
    filePath,
  }
}

export async function setCustomLibraryWorkflowCategory(id, category) {
  const entry = entriesById.get(String(id || '').trim())
  if (!entry) return { success: false, error: 'That workflow is no longer in the library.' }
  try {
    const record = await readLibraryRecord(entry)
    record.category = String(category || '').trim()
    record.updatedAt = Date.now()
    await writeLibraryRecord(record, entry.filePath)
    entriesById.set(entry.id, toListEntry(record, entry.filePath))
    notifyChanged()
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Could not set the category.' }
  }
}

async function readLibraryRecord(entry) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.readFile) throw new Error('Only available in the desktop build.')
  const read = await api.readFile(entry.filePath, { encoding: 'utf8' })
  if (!read?.success || !read.data) {
    throw new Error(read?.error || 'Could not read the saved workflow file.')
  }
  return JSON.parse(read.data)
}

async function writeLibraryRecord(record, filePath) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  const wrote = await api.writeFile(filePath, JSON.stringify(record, null, 2), { encoding: 'utf8' })
  if (!wrote?.success) throw new Error(wrote?.error || 'Could not save the workflow.')
}

export async function renameCustomLibraryWorkflow(id, newTitle) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  const entry = entriesById.get(String(id || '').trim())
  const title = String(newTitle || '').trim()
  if (!entry) return { success: false, error: 'That workflow is no longer in the library.' }
  if (!title) return { success: false, error: 'Give it a name first.' }

  try {
    const record = await readLibraryRecord(entry)
    const newId = slugify(title)
    record.id = newId
    record.title = title
    record.updatedAt = Date.now()

    const newFilePath = await getEntryFilePath(newId)
    if (!newFilePath) throw new Error('Could not resolve the workflow library folder.')
    await writeLibraryRecord(record, newFilePath)
    if (newId !== entry.id) {
      entriesById.delete(entry.id)
      if (api?.deleteFile) {
        try { await api.deleteFile(entry.filePath) } catch { /* old file may linger */ }
      }
    }
    entriesById.set(newId, toListEntry(record, newFilePath))
    notifyChanged()
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Could not rename the workflow.' }
  }
}

export async function setCustomLibraryWorkflowThumbnail(id, thumbnailDataUrl) {
  const entry = entriesById.get(String(id || '').trim())
  if (!entry) return { success: false, error: 'That workflow is no longer in the library.' }
  try {
    const record = await readLibraryRecord(entry)
    record.thumbnail = String(thumbnailDataUrl || '')
    record.updatedAt = Date.now()
    await writeLibraryRecord(record, entry.filePath)
    entriesById.set(entry.id, toListEntry(record, entry.filePath))
    notifyChanged()
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Could not set the thumbnail.' }
  }
}

export function getCustomLibraryWorkflows() {
  return Array.from(entriesById.values())
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

async function loadFromDiskOnce() {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  const dir = await getLibraryDir()
  if (!api?.listDirectory || !api?.readFile || !dir) return

  let listing = null
  try {
    listing = await api.listDirectory(dir)
  } catch {
    return
  }
  if (!listing?.success || !Array.isArray(listing.items)) return

  for (const item of listing.items) {
    const name = typeof item === 'string' ? item : item?.name
    if (!name || !/\.json$/i.test(name)) continue
    try {
      const filePath = await api.pathJoin(dir, name)
      const read = await api.readFile(filePath, { encoding: 'utf8' })
      if (!read?.success || !read.data) continue
      const entry = toListEntry(JSON.parse(read.data), filePath)
      if (entry) entriesById.set(entry.id, entry)
    } catch {
      // Skip unreadable entries; the rest of the library still loads.
    }
  }

  if (entriesById.size > 0) notifyChanged()
}

export function loadCustomWorkflowLibrary() {
  if (!loadPromise) {
    loadPromise = loadFromDiskOnce().catch(() => {})
  }
  return loadPromise
}

/** Capture whatever graph is open in the embedded ComfyUI tab. */
export async function captureCurrentComfyGraph() {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.captureComfyWorkflowGraph) {
    throw new Error('Saving workflows is only available in the desktop build.')
  }

  const captured = await api.captureComfyWorkflowGraph({
    comfyBaseUrl: getLocalComfyConnectionSync().httpBase,
  })
  if (!captured?.success) {
    throw new Error(captured?.error || 'Could not capture the current ComfyUI graph.')
  }
  if (!captured.workflow || typeof captured.workflow !== 'object') {
    throw new Error('ComfyUI did not return the graph layout — update ComfyUI and try again.')
  }
  return captured
}

/**
 * Save a captured graph to the library under the given name (falls back to
 * ComfyUI's workflow name). Saving under an existing name updates that entry.
 */
export async function saveCapturedGraphToLibrary(captured, titleInput = '') {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.writeFile) {
    throw new Error('Saving workflows is only available in the desktop build.')
  }
  if (!captured?.workflow || typeof captured.workflow !== 'object') {
    throw new Error('Nothing captured to save — try again.')
  }

  const title = String(titleInput || '').trim()
    || String(captured.workflowName || '').trim()
    || `Workflow ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { timeStyle: 'short' })}`
  const id = slugify(title)
  const now = Date.now()
  const existing = entriesById.get(id)

  const record = {
    id,
    title,
    savedAt: existing?.savedAt || now,
    updatedAt: now,
    nodeCount: Array.isArray(captured.workflow?.nodes) ? captured.workflow.nodes.length : 0,
    uiWorkflow: captured.workflow,
  }

  const dir = await getLibraryDir()
  const filePath = await getEntryFilePath(id)
  if (!dir || !filePath) throw new Error('Could not resolve the workflow library folder.')
  await api.createDirectory?.(dir, { recursive: true })
  const wrote = await api.writeFile(filePath, JSON.stringify(record, null, 2), { encoding: 'utf8' })
  if (!wrote?.success) throw new Error(wrote?.error || 'Could not save the workflow.')

  const entry = toListEntry(record, filePath)
  entriesById.set(entry.id, entry)
  notifyChanged()
  return { entry, updated: Boolean(existing) }
}

/** Load a saved workflow back into the embedded ComfyUI tab. */
export async function openCustomLibraryWorkflow(id) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  const entry = entriesById.get(String(id || '').trim())
  if (!entry) return { success: false, error: 'That workflow is no longer in the library.' }
  if (!api?.readFile) return { success: false, error: 'Only available in the desktop build.' }

  try {
    const read = await api.readFile(entry.filePath, { encoding: 'utf8' })
    if (!read?.success || !read.data) {
      throw new Error(read?.error || 'Could not read the saved workflow file.')
    }
    const record = JSON.parse(read.data)
    if (!record?.uiWorkflow) throw new Error('The saved workflow file is missing its graph.')
    return await openUiWorkflowInComfyUi(record.uiWorkflow, { label: entry.title })
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Could not open the saved workflow.',
    }
  }
}

export async function deleteCustomLibraryWorkflow(id) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  const entry = entriesById.get(String(id || '').trim())
  if (!entry) return false
  entriesById.delete(entry.id)
  if (api?.deleteFile) {
    try {
      await api.deleteFile(entry.filePath)
    } catch {
      // The entry is gone from the library either way.
    }
  }
  notifyChanged()
  return true
}
