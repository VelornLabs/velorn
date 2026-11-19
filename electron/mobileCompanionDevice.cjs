'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
// Only a digest is stored. The random bearer key stays on the paired phone.
function createDeviceStore(filename, now = Date.now) {
  return {
    async read() {
      if (!filename) return null
      try { const stat = await fs.stat(filename); if (stat.size > 2048) return null
        const data = JSON.parse(await fs.readFile(filename, 'utf8'))
        const validDigest = /^[a-f0-9]{64}$/.test(data.digest)
        if (data.version === 2 && validDigest && data.expiresAt === null) return data
        return data.version === 1 && validDigest && Number.isSafeInteger(data.expiresAt) && data.expiresAt > now() ? data : null
      } catch { return null }
    },
    async write(record) {
      if (!filename) throw Error('Device storage unavailable')
      if (!/^[a-f0-9]{64}$/.test(record?.digest)) throw Error('Invalid phone credential')
      await fs.mkdir(path.dirname(filename), { recursive: true })
      const temporary = `${filename}.tmp`
      await fs.writeFile(temporary, JSON.stringify({ version: 2, digest: record.digest, expiresAt: null }), { mode: 0o600 })
      await fs.chmod(temporary, 0o600); await fs.rename(temporary, filename)
    },
    async forget() { if (filename) await fs.unlink(filename).catch(e => { if (e.code !== 'ENOENT') throw e }) },
  }
}
module.exports = { createDeviceStore }
