'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

// Sharing is a device preference, not part of a project or a bearer credential.
function createMobileCompanionPreference(filename) {
  let queue = Promise.resolve()
  const serialize = operation => {
    const result = queue.then(operation)
    queue = result.catch(() => {})
    return result
  }
  return {
    read: () => serialize(async () => {
      if (!filename) return false
      try {
        const stat = await fs.stat(filename)
        if (stat.size > 2048) throw Error('Invalid phone-sharing preference')
        const record = JSON.parse(await fs.readFile(filename, 'utf8'))
        if (record.version !== 1 || typeof record.enabled !== 'boolean') throw Error('Invalid phone-sharing preference')
        return record.enabled
      } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
    }),
    write: enabled => serialize(async () => {
      if (!filename || typeof enabled !== 'boolean') throw Error('Phone-sharing preferences are unavailable')
      await fs.mkdir(path.dirname(filename), { recursive: true })
      const temporary = `${filename}.tmp`
      await fs.writeFile(temporary, JSON.stringify({ version: 1, enabled }), { mode: 0o600 })
      await fs.chmod(temporary, 0o600)
      await fs.rename(temporary, filename)
    }),
  }
}

module.exports = { createMobileCompanionPreference }
