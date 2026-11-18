// Device-local presentation metadata only. Workflow graphs and project files are
// deliberately not part of this store, so organizing never changes a recipe.
export const WORKFLOW_ORGANIZATION_SETTING_KEY = 'workflowLibraryOrganization'

const MAX_FOLDERS = 256
const MAX_ENTRIES = 10000
const MAX_FOLDER_NAME_LENGTH = 80
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
let pendingOperation = Promise.resolve()

function emptyOrganization() {
  return { version: 1, folders: [], entries: {}, sort: 'recent' }
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function folderName(value) {
  if (typeof value !== 'string') throw new Error('Enter a folder name.')
  const name = value.trim()
  if (!name) throw new Error('Enter a folder name.')
  if (name.length > MAX_FOLDER_NAME_LENGTH) throw new Error('Folder names can have up to 80 characters.')
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('Folder names cannot contain control characters.')
  return name
}

function validFolderId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id) && !UNSAFE_KEYS.has(id)
}

function validWorkflowId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 256 && id === id.trim()
    && !/[\u0000-\u001f\u007f]/.test(id) && !UNSAFE_KEYS.has(id)
}

function assertKnownFields(value, fields) {
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new Error('Saved workflow organization has unsupported fields. It was left unchanged.')
  }
}

// Fail visibly instead of replacing a corrupt/newer saved layout with defaults.
// Missing settings alone mean a first-use, empty library organization.
export function normalizeWorkflowOrganization(value) {
  if (value === null || value === undefined) return emptyOrganization()
  if (!isRecord(value)) throw new Error('Saved workflow organization is invalid. It was left unchanged.')
  if (value.version !== 1) throw new Error('Saved workflow organization uses an unsupported version. It was left unchanged.')
  assertKnownFields(value, ['version', 'folders', 'entries', 'sort'])
  if (!Array.isArray(value.folders) || value.folders.length > MAX_FOLDERS || !isRecord(value.entries)) {
    throw new Error('Saved workflow organization is invalid. It was left unchanged.')
  }
  if (value.sort !== 'recent' && value.sort !== 'name') throw new Error('Choose a supported workflow sort order.')
  const ids = new Set()
  const names = new Set()
  const folders = value.folders.map((folder) => {
    if (!isRecord(folder) || !validFolderId(folder.id) || ids.has(folder.id)) {
      throw new Error('Saved workflow folders are invalid. They were left unchanged.')
    }
    assertKnownFields(folder, ['id', 'name'])
    const name = folderName(folder.name)
    const key = name.toLocaleLowerCase()
    if (names.has(key)) throw new Error('A folder with that name already exists.')
    ids.add(folder.id)
    names.add(key)
    return { id: folder.id, name }
  })
  const storedEntries = Object.entries(value.entries)
  if (storedEntries.length > MAX_ENTRIES) throw new Error('Saved workflow organization has too many entries. It was left unchanged.')
  const entries = {}
  for (const [id, entry] of storedEntries) {
    if (!validWorkflowId(id) || !isRecord(entry) || typeof entry.favorite !== 'boolean'
      || (entry.folderId !== null && !validFolderId(entry.folderId))) {
      throw new Error('Saved workflow organization has an invalid entry. It was left unchanged.')
    }
    assertKnownFields(entry, ['favorite', 'folderId'])
    // Do not prune IDs absent from a catalog refresh, including temporary read
    // errors or restored recipes. A removed folder is unfiled by its helper.
    entries[id] = { favorite: entry.favorite, folderId: entry.folderId }
  }
  return { version: 1, folders, entries, sort: value.sort }
}

function assertFolderExists(state, id) {
  if (!state.folders.some((folder) => folder.id === id)) throw new Error('That workflow folder no longer exists.')
}

function assertUniqueName(state, name, exceptId) {
  if (state.folders.some((folder) => folder.id !== exceptId && folder.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new Error('A folder with that name already exists.')
  }
}

export function createWorkflowFolder(state, name) {
  const next = normalizeWorkflowOrganization(state)
  const normalizedName = folderName(name)
  assertUniqueName(next, normalizedName)
  if (next.folders.length >= MAX_FOLDERS) throw new Error('The workflow library can have up to 256 folders.')
  let id
  do {
    const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
    id = `folder-${suffix}`
  } while (next.folders.some((folder) => folder.id === id))
  next.folders.push({ id, name: normalizedName })
  return next
}

export function renameWorkflowFolder(state, id, name) {
  const next = normalizeWorkflowOrganization(state)
  assertFolderExists(next, id)
  const normalizedName = folderName(name)
  assertUniqueName(next, normalizedName, id)
  next.folders = next.folders.map((folder) => folder.id === id ? { ...folder, name: normalizedName } : folder)
  return next
}

export function removeWorkflowFolder(state, id) {
  const next = normalizeWorkflowOrganization(state)
  assertFolderExists(next, id)
  next.folders = next.folders.filter((folder) => folder.id !== id)
  for (const entry of Object.values(next.entries)) {
    if (entry.folderId === id) entry.folderId = null
  }
  return next
}

export function updateWorkflowEntry(state, id, patch) {
  const next = normalizeWorkflowOrganization(state)
  if (!validWorkflowId(id)) throw new Error('Choose a saved workflow to organize.')
  if (!isRecord(patch)) throw new Error('The workflow organization change is invalid.')
  assertKnownFields(patch, ['favorite', 'folderId'])
  const entry = { ...(next.entries[id] || { favorite: false, folderId: null }), ...patch }
  if (typeof entry.favorite !== 'boolean') throw new Error('The favorite choice is invalid.')
  if (Object.hasOwn(patch, 'folderId') && entry.folderId !== null) assertFolderExists(next, entry.folderId)
  next.entries[id] = entry
  return normalizeWorkflowOrganization(next)
}

export function sortWorkflowLibrary(workflows, organization) {
  const state = normalizeWorkflowOrganization(organization)
  const title = (entry) => String(entry.title || entry.label || entry.id || '')
  const titleOrder = (a, b) => title(a).localeCompare(title(b), undefined, { numeric: true, sensitivity: 'base' })
    || String(a.id || '').localeCompare(String(b.id || ''))
  const updated = (entry) => Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : 0
  return [...workflows].sort((a, b) => {
    const pinned = Number(state.entries[b.id]?.favorite === true) - Number(state.entries[a.id]?.favorite === true)
    if (pinned) return pinned
    return state.sort === 'name' ? titleOrder(a, b) : updated(b) - updated(a) || titleOrder(a, b)
  })
}

function serialize(operation) {
  const result = pendingOperation.then(operation)
  // A failed save must not poison the queue for a user's next attempt.
  pendingOperation = result.catch(() => {})
  return result
}

function storageBridge({ write = false } = {}) {
  const bridge = typeof window !== 'undefined' ? window.electronAPI : null
  if (typeof bridge?.getSetting !== 'function' || (write && typeof bridge.setSetting !== 'function')) {
    throw new Error('Workflow organization storage is unavailable. You can still open and use saved workflows.')
  }
  return bridge
}

async function readOrganization(bridge) {
  let stored
  try {
    stored = await bridge.getSetting(WORKFLOW_ORGANIZATION_SETTING_KEY)
  } catch (error) {
    throw new Error(`Could not load workflow organization: ${error?.message || 'Settings storage did not respond.'}`)
  }
  return normalizeWorkflowOrganization(stored)
}

export function loadWorkflowOrganization() {
  return serialize(() => readOrganization(storageBridge()))
}

export function updateWorkflowOrganization(mutator) {
  return serialize(async () => {
    if (typeof mutator !== 'function') throw new Error('The workflow organization change is invalid.')
    const bridge = storageBridge({ write: true })
    const current = await readOrganization(bridge)
    const changed = await mutator(current)
    if (!isRecord(changed)) throw new Error('The workflow organization change is invalid. Nothing was saved.')
    const next = normalizeWorkflowOrganization(changed)
    let result
    try {
      result = await bridge.setSetting(WORKFLOW_ORGANIZATION_SETTING_KEY, next)
    } catch (error) {
      throw new Error(`Could not save workflow organization: ${error?.message || 'Settings storage did not respond.'}`)
    }
    if (result?.success !== true) throw new Error(result?.error || 'Could not save workflow organization. Please try again.')
    return next
  })
}
