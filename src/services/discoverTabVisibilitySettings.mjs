const DISCOVER_TAB_VISIBILITY_SETTING_KEY = 'showDiscoverTab'
const DISCOVER_TAB_VISIBILITY_STORAGE_KEY = 'velorn-show-discover-tab'
let visibilityMutationVersion = 0

export const DISCOVER_TAB_VISIBILITY_CHANGED_EVENT = 'velorn-discover-tab-visibility-changed'

function normalizeStoredVisibility(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return null
}

function persistLocalVisibility(show) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(DISCOVER_TAB_VISIBILITY_STORAGE_KEY, String(Boolean(show)))
  } catch (_) {
    // The in-memory preference still applies when storage is unavailable.
  }
}

export function getShowDiscoverTab() {
  if (typeof localStorage === 'undefined') return true
  try {
    const stored = normalizeStoredVisibility(localStorage.getItem(DISCOVER_TAB_VISIBILITY_STORAGE_KEY))
    return stored ?? true
  } catch {
    return true
  }
}

export async function hydrateShowDiscoverTab() {
  const hydrationVersion = visibilityMutationVersion
  const fallback = getShowDiscoverTab()
  try {
    if (typeof window !== 'undefined' && window.electronAPI?.getSetting) {
      const stored = normalizeStoredVisibility(
        await window.electronAPI.getSetting(DISCOVER_TAB_VISIBILITY_SETTING_KEY)
      )
      if (hydrationVersion !== visibilityMutationVersion) return getShowDiscoverTab()
      if (stored !== null) {
        persistLocalVisibility(stored)
        return stored
      }
    }
  } catch (_) {
    // Electron settings are primary, but web previews and restricted contexts
    // should keep working from the local fallback.
  }
  return hydrationVersion === visibilityMutationVersion ? fallback : getShowDiscoverTab()
}

export async function setShowDiscoverTab(show) {
  const next = Boolean(show)
  visibilityMutationVersion += 1
  persistLocalVisibility(next)

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(DISCOVER_TAB_VISIBILITY_CHANGED_EVENT, {
      detail: { show: next },
    }))
  }

  try {
    if (typeof window !== 'undefined' && window.electronAPI?.setSetting) {
      const result = await window.electronAPI.setSetting(DISCOVER_TAB_VISIBILITY_SETTING_KEY, next)
      if (result?.success === false) throw new Error(result.error || 'Could not save the Tutorials tab setting.')
    }
  } catch (_) {
    // localStorage remains a durable fallback if the Electron settings write
    // is temporarily unavailable.
  }

  return next
}
