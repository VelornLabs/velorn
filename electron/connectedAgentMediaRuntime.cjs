'use strict'

const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const LIMITS = Object.freeze({ timeoutMs: 2000, outputBytes: 16 * 1024, pathCharacters: 4096, versionCharacters: 128 })
const unavailable = reason => ({ status: 'unavailable', reason })
const cancelled = () => Object.assign(new Error('Media utility discovery cancelled.'), { name: 'AbortError', code: 'CANCELLED' })

function nativeHeader(header, platform) {
  if (platform === 'win32') return header[0] === 0x4d && header[1] === 0x5a
  if (platform === 'linux') return header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  if (platform === 'darwin') return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(header.readUInt32BE(0))
  return false
}

function validNativePath(value, name, platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (typeof value !== 'string' || !value || value.length > LIMITS.pathCharacters
    || /[\u0000-\u001f\u007f]/.test(value) || !paths.isAbsolute(value)) return false
  // Reject drive-relative/root-relative Windows paths, device paths and command wrappers.
  if (platform === 'win32' && (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value) || /^\\\\[?.]\\/.test(value))) return false
  const expected = `${name}${platform === 'win32' ? '.exe' : ''}`
  return (platform === 'win32' ? paths.basename(value).toLowerCase() : paths.basename(value)) === expected
}

function versionEnvironment(platform, environment) {
  // In particular do not inherit FFREPORT, loader overrides, credentials or
  // PATH. A version query must not write reports or run a discovered wrapper.
  const result = { LANG: 'C', LC_ALL: 'C' }
  if (platform === 'win32') {
    for (const name of ['SystemRoot', 'WINDIR']) {
      const key = Object.keys(environment).find(key => key.toLowerCase() === name.toLowerCase())
      if (key && typeof environment[key] === 'string') result[name] = environment[key]
    }
  }
  return result
}

function inspectUtility(name, binaryPath, { signal, platform, fsImpl, spawnImpl, environment, timeoutMs }) {
  if (signal?.aborted) return Promise.reject(cancelled())
  if (binaryPath == null || binaryPath === '') return Promise.resolve(unavailable('not_resolved'))
  if (!validNativePath(binaryPath, name, platform)) return Promise.resolve(unavailable('invalid_path'))
  // Electron can stat ASAR members as files, but external processes cannot run
  // them. Main must supply its resources/bin or app.asar.unpacked resolution.
  if (/(?:^|[\\/])app\.asar(?:[\\/]|$)/i.test(binaryPath)) return Promise.resolve(unavailable('inside_archive'))

  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    let child = null
    let outputBytes = 0
    const output = []
    const finish = (result, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(result)
    }
    const kill = () => { try { child?.kill('SIGKILL') } catch { /* already exited */ } }
    const onAbort = () => { finish(null, cancelled()); kill() }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) { onAbort(); return }
    timer = setTimeout(() => { finish(unavailable('timeout')); kill() }, timeoutMs)

    const receive = data => {
      if (settled) return
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
      outputBytes += chunk.length
      if (outputBytes > LIMITS.outputBytes) { finish(unavailable('output_limit')); kill(); return }
      output.push(chunk)
    }
    const onClose = code => {
      if (settled) return
      // Publish only the identifier, never copyright, compiler/configuration,
      // diagnostics, arbitrary stdout/stderr or anything from the environment.
      const match = Buffer.concat(output).toString('utf8').match(new RegExp(`^${name} version ([A-Za-z0-9][A-Za-z0-9._+~:/-]{0,${LIMITS.versionCharacters - 1}})(?=\\s|$)`, 'm'))
      finish(code === 0 && match
        ? { status: 'available', path: binaryPath, version: match[1] }
        : unavailable('verification_failed'))
    }
    const run = async () => {
      let handle
      try {
        const info = await fsImpl.stat(binaryPath)
        if (settled) return
        if (!info.isFile()) { finish(unavailable('not_file')); return }
        if (platform !== 'win32') await fsImpl.access(binaryPath, constants.X_OK)
        if (settled) return
        handle = await fsImpl.open(binaryPath, 'r')
        if (settled) return
        const header = Buffer.alloc(4)
        const { bytesRead } = await handle.read(header, 0, 4, 0)
        if (settled) return
        if (bytesRead !== 4 || !nativeHeader(header, platform)) { finish(unavailable('not_native')); return }
      } catch (error) {
        finish(unavailable(error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing'
          : error?.code === 'EACCES' || error?.code === 'EPERM' ? 'not_executable' : 'unreadable'))
        return
      } finally {
        if (handle) { try { await handle.close() } catch {} }
      }
      if (settled) return
      try {
        child = spawnImpl(binaryPath, ['-hide_banner', '-version'], {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: versionEnvironment(platform, environment),
        })
        child.stdout?.on('data', receive)
        child.stderr?.on('data', receive)
        // Retain the error listener after termination to absorb late native
        // process errors; finish/receive ignore every late event.
        child.on('error', () => finish(unavailable('execution_failed')))
        child.on('close', onClose)
        if (settled) kill()
      } catch { finish(unavailable('execution_failed')) }
    }
    void run()
  })
}

// Native-only: pass main's existing resolved bundled paths, never renderer,
// provider or tool arguments. This is descriptive evidence, not a permission
// grant, a tool execution endpoint, an installation step or an export override.
async function discoverConnectedAgentMediaRuntime({ ffmpegPath, ffprobePath, signal } = {}, dependencies = {}) {
  if (signal?.aborted) throw cancelled()
  const platform = dependencies.platform || process.platform
  const arch = dependencies.arch || process.arch
  const host = {
    platform: ['linux', 'darwin', 'win32'].includes(platform) ? platform : 'unsupported',
    arch: ['x64', 'arm64', 'ia32', 'arm', 'riscv64', 'ppc64', 's390x'].includes(arch) ? arch : 'unknown',
  }
  if (host.platform === 'unsupported') return { ...host, utilities: { ffmpeg: unavailable('unsupported_platform'), ffprobe: unavailable('unsupported_platform') } }
  const options = { signal, platform, fsImpl: dependencies.fsImpl || fs, spawnImpl: dependencies.spawnImpl || spawn,
    environment: dependencies.environment || process.env,
    timeoutMs: Number.isFinite(dependencies.timeoutMs) ? Math.max(1, Math.min(LIMITS.timeoutMs, dependencies.timeoutMs)) : LIMITS.timeoutMs }
  const [ffmpeg, ffprobe] = await Promise.all([
    inspectUtility('ffmpeg', ffmpegPath, options),
    inspectUtility('ffprobe', ffprobePath, options),
  ])
  if (signal?.aborted) throw cancelled()
  return { ...host, utilities: { ffmpeg, ffprobe } }
}

module.exports = { discoverConnectedAgentMediaRuntime, LIMITS }
