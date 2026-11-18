// Which of the optional top tabs the user has hidden in Settings.
// Editor and Export can never be hidden. Director and Tutorials have their
// own older settings (generateTabVisibilitySettings, discoverTabVisibilitySettings).
import { useEffect, useState } from 'react'

export const HIDEABLE_TOP_TABS = [
  { id: 'create', label: 'Create' },
  { id: 'sound', label: 'Sound' },
  { id: 'stock', label: 'Stock' },
  { id: 'gpu-sharing', label: 'GPU sharing' },
  { id: 'comfyui', label: 'ComfyUI' },
]
const ALLOWED = new Set(HIDEABLE_TOP_TABS.map((tab) => tab.id))
const SETTING_KEY = 'hiddenTopTabs'
const STORAGE_KEY = 'velorn-hidden-top-tabs'
export const HIDDEN_TOP_TABS_CHANGED_EVENT = 'velorn-hidden-top-tabs-changed'
let changedHere = false

function clean(value) {
  let list = value
  if (typeof list === 'string') { try { list = JSON.parse(list) } catch (_) { return null } }
  if (!Array.isArray(list)) return null
  return [...new Set(list.filter((id) => ALLOWED.has(id)))]
}

function keepLocal(list) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(list)) } catch (_) { /* the session value still applies */ }
}

export function getHiddenTopTabs() {
  try { if (typeof localStorage !== 'undefined') return clean(localStorage.getItem(STORAGE_KEY)) || [] } catch (_) { /* fall through */ }
  return []
}

export async function hydrateHiddenTopTabs() {
  try {
    if (!changedHere && typeof window !== 'undefined' && window.electronAPI?.getSetting) {
      const stored = clean(await window.electronAPI.getSetting(SETTING_KEY))
      if (stored && !changedHere) { keepLocal(stored); return stored }
    }
  } catch (_) { /* web previews keep the local value */ }
  return getHiddenTopTabs()
}

export async function setTopTabShown(tabId, show) {
  if (!ALLOWED.has(tabId)) return getHiddenTopTabs()
  const now = getHiddenTopTabs().filter((id) => id !== tabId)
  const next = show ? now : [...now, tabId]
  changedHere = true
  keepLocal(next)
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(HIDDEN_TOP_TABS_CHANGED_EVENT, { detail: { hidden: next } }))
  }
  try { await window.electronAPI?.setSetting?.(SETTING_KEY, next) } catch (_) { /* the local copy remains */ }
  return next
}

export function useHiddenTopTabs() {
  const [hidden, setHidden] = useState(getHiddenTopTabs)
  useEffect(() => {
    let cancelled = false
    const changed = (event) => setHidden(clean(event?.detail?.hidden) || [])
    window.addEventListener(HIDDEN_TOP_TABS_CHANGED_EVENT, changed)
    hydrateHiddenTopTabs().then((value) => { if (!cancelled) setHidden(value) }).catch(() => {})
    return () => { cancelled = true; window.removeEventListener(HIDDEN_TOP_TABS_CHANGED_EVENT, changed) }
  }, [])
  return hidden
}
