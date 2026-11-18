const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MAX_FILES = 2000
const MAX_PROTECTED_FILES = 10000

/** Native boundary for an explicitly confirmed, exact-file Trash plan.
 * There is deliberately no unlink/rm fallback and no directory traversal.
 * shell.trashItem accepts a pathname rather than a file handle, so identity
 * checks reduce but cannot eliminate a final concurrent filesystem race.
 */
function createAssetTrash({ trashItem, lstat = fs.promises.lstat, realpath = fs.promises.realpath,
  platform = process.platform, homeDir = os.homedir(), protectedPaths = [] } = {}) {
  if (typeof trashItem !== 'function') throw new TypeError('A native Trash operation is required.')
  const paths = platform === 'win32' ? path.win32 : path.posix
  const key = value => platform === 'win32' ? value.toLowerCase() : value
  const isMissing = error => error?.code === 'ENOENT'
  const failure = error => ({ success: false, error, results: [] })

  function normalize(value) {
    if (typeof value !== 'string' || !value || value.length > 32768 || /[\x00-\x1f]/.test(value)) {
      throw new Error('Trash requires nonempty absolute file paths without control characters.')
    }
    if (!paths.isAbsolute(value)) throw new Error('Trash requires absolute file paths.')
    const segments = value.split(platform === 'win32' ? /[\\/]/ : /\//)
    if (segments.some(segment => segment === '.' || segment === '..')) throw new Error('Trash paths must not contain dot traversal.')
    if (platform === 'win32') {
      if (/^[\\/]{2}[?.][\\/]/.test(value)) throw new Error('Windows device and extended paths cannot be moved to Trash here.')
      const drive = /^[a-z]:[\\/]/i.test(value)
      const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(value)
      if (!drive && !unc) throw new Error('Windows Trash paths must include a drive or complete network share.')
      const components = drive ? segments.slice(1) : segments.filter(Boolean)
      if (components.some(segment => /:|[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
        throw new Error('Ambiguous Windows paths, device names and alternate data streams cannot be moved to Trash here.')
      }
    }
    return paths.normalize(value)
  }

  const protectedTargets = []
  for (const target of [homeDir, ...protectedPaths]) {
    try { protectedTargets.push(normalize(target)) } catch { /* non-native optional protection */ }
  }
  function rejectBroadTarget(value) {
    if (key(value) === key(paths.parse(value).root)) throw new Error('A filesystem root cannot be moved to Trash.')
    for (const target of protectedTargets) {
      const relative = paths.relative(value, target)
      if (!relative || (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${paths.sep}`))) {
        throw new Error('Home, protected folders and their ancestors cannot be moved to Trash.')
      }
    }
  }
  function validateList(values, max, name, rejectBroad = false) {
    if (!Array.isArray(values) || values.length > max) throw new Error(`${name} must be an array of at most ${max} exact file paths.`)
    const unique = new Map()
    for (const value of values) {
      const normalized = normalize(value)
      if (rejectBroad) rejectBroadTarget(normalized)
      if (!unique.has(key(normalized))) unique.set(key(normalized), normalized)
    }
    return [...unique.values()]
  }
  function inspectFile(info) {
    if (info.isSymbolicLink()) throw new Error('Symbolic links cannot be moved to Trash here. Remove this asset from the project only.')
    if (!info.isFile()) throw new Error('Only regular files can be moved to Trash. Folders and special files are refused.')
    const fields = ['dev', 'ino', 'mode', 'size', 'birthtimeMs', 'mtimeMs', 'ctimeMs']
    const identity = fields.map(field => {
      const value = info[field]
      if (typeof value !== 'bigint' && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error('The file identity could not be verified safely.')
      }
      return String(value)
    })
    return identity.join(':')
  }

  async function execute(targets, retainedPaths) {
    const retained = new Set(retainedPaths.map(key))
    // Resolve remaining-asset aliases before performing any destructive action.
    for (const retainedPath of retainedPaths) {
      try { retained.add(key(normalize(await realpath(retainedPath)))) }
      catch (error) {
        if (!isMissing(error)) return failure('Could not verify a file still referenced by another asset. No files were moved to Trash.')
      }
    }
    const results = []
    for (const target of targets) {
      let nativeMoveStarted = false
      try {
        if (retained.has(key(target))) throw new Error('This file is still referenced by another asset and was not moved to Trash.')
        const first = await lstat(target, { bigint: true })
        const identity = inspectFile(first)
        const canonical = normalize(await realpath(target))
        if (retained.has(key(canonical))) throw new Error('This file is still referenced by another asset and was not moved to Trash.')
        if (key(canonical) !== key(target)) throw new Error('Paths through symbolic links cannot be moved to Trash here. Remove this asset from the project only.')
        // Recheck after asynchronous inspection, immediately before the only
        // mutating call. A replacement directory/symlink/file fails closed.
        if (inspectFile(await lstat(target, { bigint: true })) !== identity) throw new Error('The file changed during review and was not moved to Trash. Please try again.')
        nativeMoveStarted = true
        await trashItem(target)
        results.push({ path: target, success: true })
      } catch (error) {
        // A shell failure with ENOENT can mean its Trash utility is missing,
        // not the user's file. Only inspection can establish a missing file.
        results.push(!nativeMoveStarted && isMissing(error)
          ? { path: target, success: true, missing: true }
          : { path: target, success: false, error: error?.message || 'Could not move this file to Trash.' })
      }
    }
    const success = results.every(result => result.success)
    return { success, results, ...(success ? {} : { error: 'Some files were not moved to Trash. Review the individual results.' }) }
  }

  let queue = Promise.resolve()
  function trashAssetFiles(payload) {
    let targets, retainedPaths
    try {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('An exact-file Trash plan is required.')
      targets = validateList(payload.paths, MAX_FILES, 'paths', true)
      retainedPaths = validateList(payload.protectedPaths ?? [], MAX_PROTECTED_FILES, 'protectedPaths')
    } catch (error) { return Promise.resolve(failure(error.message)) }
    // Serialize separate IPC calls as well as files within one plan. Copy and
    // validate the plan above, before it waits, so callers cannot change it.
    const operation = queue.then(() => execute(targets, retainedPaths))
    queue = operation.catch(() => {})
    return operation
  }

  return { trashAssetFiles }
}

module.exports = { createAssetTrash }
