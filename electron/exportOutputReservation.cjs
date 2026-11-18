const fs = require('fs/promises')
const path = require('path')

// Apply-only: prepare the actual destinations, including a distinct final
// post-process path. Never create the PNG sequence directory itself here.
async function prepareExportOutputDirectories(paths, { fsApi = fs } = {}) {
  for (const directory of new Set(paths.map(filePath => path.dirname(filePath)))) {
    await fsApi.mkdir(directory, { recursive: true })
  }
}

/** Exclusively claim a new file before any encoder can use -y/copyFile. PNG
 * sequence directories are instead claimed by their existing exclusive mkdir. */
async function reserveExportOutputs(paths, { fsApi = fs } = {}) {
  const reservations = []
  try {
    for (const filePath of [...new Set(paths)]) {
      const handle = await fsApi.open(filePath, 'wx')
      try {
        const stat = await handle.stat()
        reservations.push({ path: filePath, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs })
      } finally { await handle.close() }
    }
    return reservations
  } catch (error) {
    await releaseEmptyExportOutputs(reservations, { fsApi })
    throw error
  }
}

/** Never remove a replacement inode, touched placeholder, partial export, or
 * completed render. Cleanup is scoped to paths this invocation created. */
async function releaseEmptyExportOutputs(reservations, { fsApi = fs } = {}) {
  for (const reservation of reservations) {
    try {
      const current = await fsApi.lstat(reservation.path)
      if (current.isFile() && current.size === 0 && current.dev === reservation.dev && current.ino === reservation.ino
        && current.mtimeMs === reservation.mtimeMs) await fsApi.unlink(reservation.path)
    } catch { /* a moved/deleted/unavailable file is not ours to recover */ }
  }
}

module.exports = { prepareExportOutputDirectories, reserveExportOutputs, releaseEmptyExportOutputs }
