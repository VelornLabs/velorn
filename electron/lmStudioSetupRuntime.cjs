'use strict'

// Official CLI contracts: lmstudio.ai/docs/cli and lmstudio-ai/lms
// src/subcommands/{list,server}.ts. Only fixed local commands; never shell text,
// caller executable paths, remote hosts, model downloads or auth overrides.
const fsNative = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const object = x => x && typeof x === 'object' && !Array.isArray(x)
const safeText = x => typeof x === 'string' && x.length > 0 && x.length <= 1024 && !/[\x00-\x1f\x7f]/.test(x)
const fault = message => Object.assign(new Error(message), { code: 'LM_STUDIO_RUNTIME_UNAVAILABLE', publicMessage: message })
const check = signal => { if (signal?.aborted) throw fault('LM Studio setup was interrupted. Check its current state before retrying.') }
function environment(source, home, platform) {
  const result = {}
  // Do not pass NODE_OPTIONS, dynamic-library injections, LM remote overrides,
  // provider/API tokens or network proxy variables into the local CLI.
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) if (typeof source[key] === 'string') result[key] = source[key]
  result.HOME = home
  if (platform === 'win32') result.USERPROFILE = home
  result.PATH = platform === 'win32' ? path.join(source.SystemRoot || 'C:\\Windows', 'System32') : '/usr/bin:/bin:/usr/sbin:/sbin'
  result.NO_COLOR = '1'
  return result
}
function parseRows(value) {
  if (!Array.isArray(value) || value.length > 2048) throw fault('LM Studio returned an unsupported model listing. Check models in LM Studio.')
  const rows = []
  for (const item of value) {
    if (!object(item)) throw fault('LM Studio returned an invalid model listing.')
    // Old local-only builds omit deviceIdentifier; newer LM Link builds must
    // explicitly identify a local row. Remote rows can never authorize a load.
    if (item.deviceIdentifier != null || item.type !== 'llm') continue
    if (!safeText(item.modelKey) || !safeText(item.path) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 0) throw fault('LM Studio did not identify its local model files precisely enough to load safely.')
    const relative = item.path.replaceAll('\\', '/')
    if (relative.startsWith('/') || /^[A-Za-z]:/.test(relative) || relative.split('/').some(v => !v || v === '.' || v === '..')) throw fault('LM Studio returned an invalid local model path.')
    if (item.variants !== undefined && (!Array.isArray(item.variants) || item.variants.length > 32 || item.variants.some(x => !safeText(x)))) throw fault('LM Studio returned an unsupported model variant list.')
    rows.push({ path: relative, modelKey: item.modelKey, sizeBytes: item.sizeBytes, type: 'llm', variants: item.variants || [] })
  }
  return rows
}
function createLmStudioSetupRuntime({ fs = fsNative, getHomePath = os.homedir, platform = process.platform,
  run = execFile, env = process.env, timeoutMs = 20000 } = {}) {
  async function inspect() {
    const home = getHomePath()
    if (!safeText(home) || !path.isAbsolute(home)) return { available: false }
    const directory = path.join(home, '.lmstudio', 'bin'), candidate = path.join(directory, platform === 'win32' ? 'lms.exe' : 'lms')
    try {
      // Known per-user installation only. Custom locations require normal LM
      // Studio bootstrap, not an arbitrary executable tool argument.
      const executable = await fs.realpath(candidate), stat = await fs.stat(executable)
      if (!stat.isFile() || stat.size < 1 || platform !== 'win32' && !(stat.mode & 0o111)) return { available: false }
      return { available: true, executable, home }
    } catch { return { available: false } }
  }
  async function command(args, signal, beforeStart) {
    check(signal)
    const runtime = await inspect()
    check(signal)
    if (!runtime.available) throw fault('LM Studio’s command-line helper is unavailable. Open LM Studio once and enable its lms helper, then try again.')
    return new Promise((resolve, reject) => {
      try {
        // Startup inspection/help can await. Recheck native authority only at
        // the final synchronous subprocess boundary, never from model fields.
        const allowed = beforeStart?.()
        if (typeof allowed?.then === 'function') {
          Promise.resolve(allowed).catch(() => {})
          throw fault('The local server startup guard must be synchronous.')
        }
        run(runtime.executable, args, { shell: false, windowsHide: true, cwd: runtime.home,
          env: environment(env, runtime.home, platform), timeout: Math.max(1, Math.min(timeoutMs, 30000)),
          maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', signal }, (error, stdout) => {
          if (signal?.aborted) return reject(fault('LM Studio setup was interrupted. Its server or model may still need review; no automatic retry was started.'))
          if (error || typeof stdout !== 'string') return reject(fault('LM Studio could not complete the local setup command. Open LM Studio and check its server; no automatic retry was started.'))
          resolve(stdout)
        })
      } catch { reject(fault('LM Studio’s local command could not start. Check its installation.')) }
    })
  }
  async function startServer({ signal, beforeStart } = {}) {
    const help = await command(['server', 'start', '--help'], signal)
    if (!/--bind\b/.test(help) || !/--port\b/.test(help)) throw fault('This LM Studio helper cannot confirm loopback-only server startup. Update LM Studio or start its local server yourself.')
    await command(['server', 'start', '--port', '1234', '--bind', '127.0.0.1'], signal, beforeStart)
    return { started: true } // Caller still must verify the fixed local endpoint.
  }
  async function listDownloadedModels({ signal } = {}) {
    const read = async key => {
      const output = await command(['ls', ...(key ? [key] : []), '--json', '--host', '127.0.0.1', '--port', '1234'], signal)
      let value
      try { value = JSON.parse(output) } catch { throw fault('LM Studio did not return machine-readable model details. Check its model list manually.') }
      return parseRows(value)
    }
    const rows = await read(), flattened = []
    let variantQueries = 0
    for (const row of rows) {
      if (row.variants.length) {
        if (++variantQueries > 16 || row.modelKey.startsWith('-')) throw fault('LM Studio has too many or unsupported model groups for automatic setup verification.')
        const variants = await read(row.modelKey)
        for (const variant of variants) {
          if (!row.variants.includes(variant.modelKey) || variant.variants.length) throw fault('LM Studio returned a mismatched model variant. No model was loaded.')
          flattened.push(variant)
        }
      } else flattened.push(row)
      if (flattened.length > 2048) throw fault('LM Studio returned too many model variants.')
    }
    return flattened.filter(row => /\.gguf$/i.test(row.path)).map(({ variants, ...row }) => row)
  }
  return { inspect, startServer, listDownloadedModels }
}
module.exports = { createLmStudioSetupRuntime, parseRows, environment }
