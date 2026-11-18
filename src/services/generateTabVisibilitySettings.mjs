const GENERATE_TAB_VISIBILITY_SETTING_KEY = 'showGenerateTab'
const GENERATE_TAB_VISIBILITY_STORAGE_KEY = 'velorn-show-generate-tab'
let visibilityMutationVersion = 0
let lastKnownVisibility = null
let hasUnsavedLocalVisibility = false

export const GENERATE_TAB_VISIBILITY_CHANGED_EVENT = 'velorn-generate-tab-visibility-changed'

function normalizeStoredVisibility(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return null
}

function persistLocalVisibility(show) {
  lastKnownVisibility = show
  hasUnsavedLocalVisibility = true
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(GENERATE_TAB_VISIBILITY_STORAGE_KEY, String(show))
    hasUnsavedLocalVisibility = false
  } catch (_) {
    // A readable but unwritable older value must not replace the session choice.
  }
}

export function getShowGenerateTab() {
  if (hasUnsavedLocalVisibility) return lastKnownVisibility
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = normalizeStoredVisibility(localStorage.getItem(GENERATE_TAB_VISIBILITY_STORAGE_KEY))
      return stored ?? true
    }
  } catch (_) {
    // Restricted contexts can still use the last known current-session value.
  }
  return lastKnownVisibility ?? true
}

export async function hydrateShowGenerateTab() {
  // Once the user chooses, that session choice takes precedence over a native
  // write still in flight (or one that failed) when Settings mounts again.
  if (visibilityMutationVersion > 0) return getShowGenerateTab()
  const hydrationVersion = visibilityMutationVersion
  const fallback = getShowGenerateTab()
  try {
    if (typeof window !== 'undefined' && window.electronAPI?.getSetting) {
      const stored = normalizeStoredVisibility(
        await window.electronAPI.getSetting(GENERATE_TAB_VISIBILITY_SETTING_KEY)
      )
      if (hydrationVersion !== visibilityMutationVersion) return getShowGenerateTab()
      if (stored !== null) {
        persistLocalVisibility(stored)
        return stored
      }
    }
  } catch (_) {
    // Native settings are primary; web previews keep using the local fallback.
  }
  return hydrationVersion === visibilityMutationVersion ? fallback : getShowGenerateTab()
}

export async function setShowGenerateTab(show) {
  const next = Boolean(show)
  visibilityMutationVersion += 1
  persistLocalVisibility(next)

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(GENERATE_TAB_VISIBILITY_CHANGED_EVENT, {
      detail: { show: next },
    }))
  }

  try {
    if (typeof window !== 'undefined' && window.electronAPI?.setSetting) {
      const result = await window.electronAPI.setSetting(GENERATE_TAB_VISIBILITY_SETTING_KEY, next)
      if (result?.success === false) throw new Error(result.error || 'Could not save the Director tab setting.')
    }
  } catch (_) {
    // Local storage remains a durable fallback, with memory for this session if
    // neither persistence mechanism is available.
  }

  return next
}
