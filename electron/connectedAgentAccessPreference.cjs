'use strict'

const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

// Changing this consent bundle invalidates older choices. This stores only the
// user's opt-in, never a live permission token, project, chat or mobile binding.
const CONSENT = Object.freeze({ version: 1, scope: 'velorn-full-computer-access', provider: 'codex', shareImagesAndView: true })
const LOCAL_CONSENT = Object.freeze({ version: 1, scope: 'velorn-full-tool-access', provider: 'lmstudio', shareImagesAndView: true })
// Velo's earlier remembered choice covered Velorn tools only. Never migrate
// that opt-in into computer authority: fresh native confirmation is required.
const VELO_CONSENT = Object.freeze({ version: 2, scope: 'velorn-velo-full-computer-access', provider: 'luna', shareImagesAndView: true })
const MAX_BYTES = 2048

function createProviderPreference({ filePath, consent }) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new TypeError('A native absolute preference file is required.')
  let queue = Promise.resolve(); let blocked = false
  const serial = operation => {
    const result = queue.then(operation)
    queue = result.catch(() => {})
    return result
  }
  async function write(remembered) {
    const folder = path.dirname(filePath)
    await fs.mkdir(folder, { recursive: true, mode: 0o700 })
    const temporary = path.join(folder, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
    let handle
    try {
      handle = await fs.open(temporary, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ ...consent, remembered }) + '\n', 'utf8')
      await handle.sync()
      await handle.close(); handle = null
      await fs.rename(temporary, filePath)
    } finally {
      await handle?.close().catch(() => {})
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  }
  return {
    read: () => serial(async () => {
      if (blocked) return false
      let handle
      try {
        handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > MAX_BYTES || (process.platform !== 'win32' && (stat.mode & 0o077))) return false
        const buffer = Buffer.alloc(MAX_BYTES + 1)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        if (bytesRead > MAX_BYTES) return false
        const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
        return value !== null && typeof value === 'object' && !Array.isArray(value)
          && Object.keys(value).length === 5 && Object.entries(consent).every(([key, expected]) => value[key] === expected)
          && value.remembered === true
      } catch { return false } finally { await handle?.close().catch(() => {}) }
    }),
    remember: () => serial(async () => {
      blocked = true
      await write(true)
      blocked = false
    }),
    forget: () => serial(async () => {
      // A failed revocation never allows a subsequent read to restore access
      // from the older file during this process lifetime.
      blocked = true
      try { await write(false) } catch {
        // An explicit revocation may recover from an atomic-write failure by
        // removing this exact native preference file, never its directory.
        try { await fs.unlink(filePath) } catch (error) {
          if (error.code !== 'ENOENT') throw Object.assign(new Error('Full access was revoked for this session, but its remembered choice could not be cleared. Check the application data folder before restarting Velorn.'), { code: 'FULL_ACCESS_PREFERENCE_FAILED' })
        }
      }
      blocked = false
    }),
  }
}

function createFullAccessPreference({ filePath }) {
  const stores = {
    codex: createProviderPreference({ filePath, consent: CONSENT }),
    lmstudio: createProviderPreference({ filePath: `${filePath}.lmstudio`, consent: LOCAL_CONSENT }),
    luna: createProviderPreference({ filePath: `${filePath}.luna`, consent: VELO_CONSENT }),
  }
  const get = provider => {
    if (!Object.hasOwn(stores, provider)) throw new TypeError('Choose Velo, LM Studio or Codex.')
    return stores[provider]
  }
  return {
    read: (provider = 'codex') => get(provider).read(),
    remember: (provider = 'codex') => get(provider).remember(),
    forget: (provider = 'codex') => get(provider).forget(),
  }
}

module.exports = { createFullAccessPreference, CONSENT, LOCAL_CONSENT, VELO_CONSENT }
