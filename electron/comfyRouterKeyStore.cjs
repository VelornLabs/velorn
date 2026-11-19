'use strict'
// Keeps the Comfy Router key between launches, encrypted by the operating
// system's own password store (Electron safeStorage). Native-owned: the key is
// never returned to the renderer, agent tools or settings reads.
//
// Where the OS offers no real protected store (for example a Linux session
// with no keyring, where Electron falls back to a fixed built-in password),
// nothing is written and the key lives only for the session.
const nativeFs = require('node:fs/promises')
const nativeFsSync = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const KEY_MAX = 4096, ENCRYPTED_MAX = 16384
const PROTECTED_LINUX_BACKENDS = ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']
const validKey = v => typeof v === 'string' && v.length > 0 && v.length <= KEY_MAX && !/[\s\x00-\x1f\x7f-\x9f]/.test(v)

function createComfyRouterKeyStore({ safeStorage, file, platform = process.platform, fs = nativeFs, fsSync = nativeFsSync } = {}) {
  if (!path.isAbsolute(file || '')) throw new TypeError('The Router key store needs an absolute file path.')
  let queue = Promise.resolve()
  const queued = work => { const run = queue.then(work); queue = run.catch(() => {}); return run }

  function canRemember() {
    try {
      if (safeStorage?.isEncryptionAvailable?.() !== true || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') return false
      return platform !== 'linux' || PROTECTED_LINUX_BACKENDS.includes(safeStorage.getSelectedStorageBackend?.())
    } catch { return false }
  }

  // Returns the stored key, or '' when there is none or it cannot be read.
  function load() { return queued(async () => {
    if (!canRemember()) return ''
    let handle
    try {
      handle = await fs.open(file, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0))
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size < 1 || stat.size > ENCRYPTED_MAX) return ''
      const bytes = Buffer.alloc(ENCRYPTED_MAX + 1); let length = 0
      while (length < bytes.length) { const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null); if (!bytesRead) break; length += bytesRead }
      if (length > ENCRYPTED_MAX) return ''
      const loaded = safeStorage.decryptString(bytes.subarray(0, length))
      return validKey(loaded) ? loaded : ''
    } catch { return '' }
    finally { try { await handle?.close() } catch {} }
  }) }

  // Writes the key encrypted. Resolves true when stored, false when this
  // computer has no protected store. Throws only when a write that should
  // have worked did not.
  function save(key) { return queued(async () => {
    if (!validKey(key)) throw new TypeError('Invalid Router key.')
    if (!canRemember()) return false
    const encrypted = safeStorage.encryptString(key)
    if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > ENCRYPTED_MAX || encrypted.includes(Buffer.from(key))) throw new Error('Encryption unavailable')
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`
    let handle, renamed = false
    try {
      handle = await fs.open(temporary, 'wx', 0o600)
      await handle.writeFile(encrypted); await handle.sync(); await handle.close(); handle = null
      fsSync.renameSync(temporary, file); renamed = true
    } finally {
      if (handle) { try { await handle.close() } catch {} }
      if (!renamed) { try { await fs.unlink(temporary) } catch {} }
    }
    return true
  }) }

  // Removes the stored key. A missing file is already "forgotten".
  function forget() { return queued(async () => {
    try { fsSync.unlinkSync(file) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }) }

  return { canRemember, load, save, forget }
}

module.exports = { createComfyRouterKeyStore }
