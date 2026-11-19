// A read-only, browser-safe inventory. Never derive recursive directories or
// expand an image sequence into unreviewed source files.
const windowsPath = value => /^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]/.test(value)
let activeRemoval = null
// Survives panel remounts: a second review cannot queue behind an in-flight
// native batch using an already stale project snapshot.
export function claimAssetRemoval() {
  if (activeRemoval) return null
  const token = {}
  activeRemoval = token
  return () => { if (activeRemoval === token) activeRemoval = null }
}
export function assertAssetRemovalAllowsMcp(action) {
  // Other operations can import results even when they sound read-only.
  // Fail closed for the short confirmation/native transaction.
  if (!activeRemoval || ['get_project', 'get_timeline', 'get_assets', 'get_transport_state', 'get_mcp_recipes'].includes(action)) return
  const error = new Error('Asset removal is being reviewed or completed. Finish the removal dialog before changing the project through MCP.')
  error.code = 'ASSET_REMOVAL_IN_PROGRESS'
  throw error
}
export function normalizeAssetFilePath(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)) throw new Error('Invalid media path.')
  const windows = windowsPath(value)
  const path = windows ? value.replaceAll('\\', '/') : value
  if (!windows && !path.startsWith('/')) throw new Error('Media path must be absolute.')
  if (path.split('/').some(part => part === '..' || part === '.')) throw new Error('Media path contains unsafe traversal.')
  return path.replace(/\/$/, '')
}
const pathKey = value => windowsPath(value) ? value.toLowerCase() : value
function relativeFile(root, value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || /^[a-z]:/i.test(value) || value.startsWith('\\')) throw new Error('Expected a project-relative media path.')
  const path = value.replaceAll('\\', '/')
  if (path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe project-relative media path.')
  return normalizeAssetFilePath(`${normalizeAssetFilePath(root)}/${path}`)
}

function assetFiles(asset, projectRoot) {
  const files = []
  const relative = (value, kind) => {
    if (!value) return
    if (typeof projectRoot !== 'string') throw new Error('Open a local project to move project media to Trash.')
    files.push({ path: relativeFile(projectRoot, value), external: false, kind })
  }
  const absolute = (value, kind) => {
    if (!value) return
    const path = normalizeAssetFilePath(value)
    const root = typeof projectRoot === 'string' ? normalizeAssetFilePath(projectRoot) : null
    files.push({ path, external: !root || !pathKey(path).startsWith(`${pathKey(root)}/`), kind })
  }
  if (asset.path && (asset.path.startsWith('/') || windowsPath(asset.path))) absolute(asset.path, 'media')
  else if (asset.path) relative(asset.path, 'media')
  else absolute(asset.absolutePath, 'media')
  relative(asset.playbackCachePath, 'playback cache')
  relative(asset.proxyPath, 'proxy')
  absolute(asset.sprite?.spritePath, 'thumbnail')
  absolute(asset.poster?.posterPath, 'poster')
  return files
}

export function buildAssetRemovalPlan({ assets = [], assetIds = [], projectRoot = null } = {}) {
  const ids = [...new Set(assetIds)].sort()
  const selected = assets.filter(asset => ids.includes(asset.id))
  if (selected.length !== ids.length) throw new Error('The asset selection changed. Please review the removal again.')
  const remaining = assets.filter(asset => !ids.includes(asset.id))
  const protectedPaths = [...new Set(remaining.flatMap(asset => [
    ...assetFiles(asset, projectRoot).map(file => file.path),
    ...(asset.absolutePath ? [normalizeAssetFilePath(asset.absolutePath)] : []),
  ]))].sort()
  const protectedKeys = new Set(protectedPaths.map(pathKey))
  const files = new Map(), shared = new Set()
  for (const asset of selected) {
    for (const file of assetFiles(asset, projectRoot)) {
      const key = pathKey(file.path)
      if (protectedKeys.has(key)) { shared.add(file.path); continue }
      files.set(key, { ...file, assetName: asset.name || asset.id })
    }
  }
  return { assetIds: ids, projectRoot, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    protectedPaths, sharedPaths: [...shared].sort() }
}

export function describeAssetRemovalPlan(plan) {
  const external = plan.files.some(file => file.external)
  const lines = [
    `Remove ${plan.assetIds.length} asset${plan.assetIds.length === 1 ? '' : 's'} from this project and move ${plan.files.length} file${plan.files.length === 1 ? '' : 's'} to the system Trash / Recycle Bin?`,
    'Files can be recovered through your operating system. Velorn cannot undo this file operation.',
  ]
  if (external) lines.push('WARNING: This includes original files OUTSIDE the project folder. Other projects or applications may use them.')
  if (plan.sharedPaths.length) lines.push(`${plan.sharedPaths.length} shared file(s) will be kept because other assets in this project still refer to them.`)
  lines.push(plan.files.length ? `Files to move:\n${plan.files.map(file => `${file.external ? '[EXTERNAL] ' : ''}${file.path}`).join('\n')}` : 'There are no unshared local files to move. Only project entries will be removed.')
  return lines.join('\n\n')
}

export async function trashAssetRemovalPlan(plan, api = globalThis.window?.electronAPI) {
  if (!plan.files.length) return { success: true, results: [] }
  if (typeof api?.trashAssetFiles !== 'function') throw new Error('Safe Trash is unavailable. Fully quit and reopen the updated Velorn desktop app, or choose Remove from project to keep the files.')
  const paths = plan.files.map(file => file.path)
  const response = await api.trashAssetFiles({ paths, protectedPaths: plan.protectedPaths })
  // Do not remove project entries on partial, malformed or ambiguous results.
  const acknowledged = result => {
    try { return result.success === true ? pathKey(normalizeAssetFilePath(result.path)) : null }
    catch { return null }
  }
  if (!response?.success || !Array.isArray(response.results) || !paths.every(path => response.results.some(result => acknowledged(result) === pathKey(path)))) {
    const moved = response?.results?.filter(result => result.success && !result.missing).length || 0
    const failures = response?.results?.filter(result => !result.success).map(result => `${result.path}: ${result.error || 'Could not move file'}`).join('\n')
    throw new Error(`${moved ? `${moved} file(s) were moved to Trash; you can restore them there. ` : ''}Project entries were kept. No permanent deletion was attempted.\n${failures || response?.error || 'Trash did not confirm every file.'}`)
  }
  return response
}
