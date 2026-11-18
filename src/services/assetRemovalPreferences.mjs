export const ASSET_REMOVAL_MODE_KEY = 'assetsRemovalModeV2'
export const ASSET_REMOVAL_MODE_EVENT = 'velorn:asset-removal-mode-changed'

// Deliberately do not migrate the old, implicitly enabled permanent-delete
// preference. Trash requires a fresh, explicit choice in Settings.
export function getAssetRemovalMode(storage) {
  try { return (storage ?? globalThis.localStorage)?.getItem(ASSET_REMOVAL_MODE_KEY) === 'trash' ? 'trash' : 'project-only' }
  catch { return 'project-only' }
}

export function setAssetRemovalMode(mode, storage) {
  if (!['project-only', 'trash'].includes(mode)) return { success: false, error: 'Invalid asset removal preference.' }
  try {
    storage ??= globalThis.localStorage
    if (!storage) throw new Error('Preference storage is unavailable.')
    storage.setItem(ASSET_REMOVAL_MODE_KEY, mode)
    globalThis.window?.dispatchEvent(new CustomEvent(ASSET_REMOVAL_MODE_EVENT, { detail: { mode } }))
    return { success: true, mode }
  } catch (error) { return { success: false, error: error.message } }
}
