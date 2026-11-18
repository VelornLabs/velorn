import { create } from 'zustand'

const VIEW_MODE_KEY = 'assetsViewMode'
const viewModes = new Set(['grid', 'list'])
const resolve = (value, previous) => typeof value === 'function' ? value(previous) : value
const folderId = value => typeof value === 'string' && value ? value : null
const position = value => Number.isFinite(value) ? Math.max(0, value) : 0

function browserStorage() {
  try { return globalThis.localStorage } catch { return undefined }
}

/** Browsing UI outlives AssetsPanel, but never belongs to the project document.
 * Only the user's grid/list preference survives an app restart. Folder IDs,
 * search and scroll belong to the loaded project session, not localStorage.
 * Keeping this separate also avoids serializing the entire asset library on
 * every navigation or scroll event through assetsStore's persist middleware.
 */
export function createAssetBrowserStore({ storage = browserStorage() } = {}) {
  let initialView = 'grid'
  try {
    const saved = storage?.getItem(VIEW_MODE_KEY)
    if (viewModes.has(saved)) initialView = saved
  } catch { /* Browsing remains usable when local storage is unavailable. */ }

  return create((set, get) => ({
    viewMode: initialView,
    currentFolderId: null,
    searchQuery: '',
    expandedFolderIds: new Set(),
    scrollTop: 0,
    projectSession: 0,
    setViewMode(value) {
      const next = resolve(value, get().viewMode)
      if (!viewModes.has(next) || next === get().viewMode) return
      try { storage?.setItem(VIEW_MODE_KEY, next) } catch {}
      set({ viewMode: next, scrollTop: 0 })
    },
    setCurrentFolderId(value) {
      const next = folderId(resolve(value, get().currentFolderId))
      if (next !== get().currentFolderId) set({ currentFolderId: next, scrollTop: 0 })
    },
    setSearchQuery(value) {
      const next = resolve(value, get().searchQuery)
      if (typeof next === 'string' && next !== get().searchQuery) set({ searchQuery: next, scrollTop: 0 })
    },
    setExpandedFolderIds(value) {
      const next = resolve(value, get().expandedFolderIds)
      if (!(next instanceof Set)) return
      set({ expandedFolderIds: new Set([...next].filter(id => folderId(id))) })
    },
    setScrollTop(value) {
      const next = position(value)
      if (next !== get().scrollTop) set({ scrollTop: next })
    },
    resetProject() {
      set(state => ({ currentFolderId: null, searchQuery: '', expandedFolderIds: new Set(),
        scrollTop: 0, projectSession: state.projectSession + 1 }))
    },
    pruneFolders(folders) {
      const ids = new Set((folders || []).map(folder => folder.id))
      const state = get()
      const missingCurrent = state.currentFolderId != null && !ids.has(state.currentFolderId)
      const expanded = new Set([...state.expandedFolderIds].filter(id => ids.has(id)))
      if (!missingCurrent && expanded.size === state.expandedFolderIds.size) return
      set({ expandedFolderIds: expanded,
        ...(missingCurrent ? { currentFolderId: null, scrollTop: 0 } : {}) })
    },
  }))
}

export default createAssetBrowserStore()
