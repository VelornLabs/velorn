'use strict'

const { resolveCodexExecutable } = require('./connectedAgentExecutable.cjs')

const fault = (code, message) => Object.assign(new Error(message), { code })
const check = ({ signal, isCurrent } = {}) => {
  if (signal?.aborted || (isCurrent && isCurrent() !== true)) throw fault('CANCELLED', 'Codex installation selection was cancelled.')
}

// Device-owned preference only. Renderer messages and project documents never
// supply a command or path. The user chooses the file through a native dialog.
function createCodexExecutableAccess({ readCustomPath, writeCustomPath, choosePath,
  resolutionOptions = {}, resolveImpl = resolveCodexExecutable }) {
  async function read(options) {
    check(options)
    const selected = await readCustomPath()
    check(options)
    if (selected != null && typeof selected !== 'string') throw fault('CODEX_EXECUTABLE_INVALID', 'The saved Codex installation is invalid. Use automatic detection in Agent settings.')
    return selected || ''
  }
  async function resolve(options = {}) {
    const customPath = await read(options)
    return resolveImpl({ ...resolutionOptions, customPath, signal: options.signal })
  }
  async function status(options = {}) {
    let customPath = ''
    try {
      customPath = await read(options)
      const found = await resolveImpl({ ...resolutionOptions, customPath, signal: options.signal })
      check(options)
      return { ...found, available: true }
    } catch (problem) {
      check(options)
      if (problem.code === 'CANCELLED') throw problem
      if (!['CODEX_NOT_FOUND', 'CODEX_EXECUTABLE_INVALID'].includes(problem.code)) throw problem
      return { path: customPath, mode: customPath ? 'custom' : 'automatic', source: customPath ? 'Custom' : '', available: false, error: problem.message }
    }
  }
  async function choose(options = {}) {
    check(options)
    const selected = await choosePath(options.window)
    check(options)
    if (!selected) return null
    const found = await resolveImpl({ ...resolutionOptions, customPath: selected, signal: options.signal })
    check(options)
    // Store the selected alias (.app/shim/symlink), not a versioned canonical
    // target. Re-resolve on each operation so installer updates keep working.
    await writeCustomPath(selected, options)
    check(options)
    return { ...found, available: true }
  }
  async function automatic(options = {}) {
    check(options)
    await writeCustomPath('', options)
    check(options)
    return status(options)
  }
  return { resolve, status, choose, automatic }
}

module.exports = { createCodexExecutableAccess }
