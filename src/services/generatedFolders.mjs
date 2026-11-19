// Where things made in Velorn are filed in the Assets panel, so they do not pile up loose
// at the top: one folder per place they were made in, created the first time it is needed.
// A folder the person renamed or deleted is simply made again under its usual name.
export const GENERATED_FOLDERS = Object.freeze({ visuals: 'Visuals', sound: 'Sound', shared: 'GPU sharing' })

// The id of the top-level folder with this name, making it if it is not there. null when it cannot be made
// (the result is then filed at the top, as before).
export function generatedFolderId(assets, name) {
  try {
    if (typeof name !== 'string' || !name.trim()) return null
    const found = (assets?.folders || []).find(folder => folder && !folder.parentId && folder.name === name)
    if (found?.id) return found.id
    return (typeof assets?.addFolder === 'function' ? assets.addFolder({ name, parentId: null })?.id : null) || null
  } catch { return null }
}
