'use strict'

const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// Installation layouts are best-effort hints, not a desktop-app API. Never
// launch candidates to discover them, run a shell/profile, or inspect account
// files. The caller still verifies the selected CLI's version/capabilities.
const LIMITS = Object.freeze({ pathEntries: 64, directoryEntries: 128, matchingDirectories: 16, candidates: 768, timeoutMs: 5000 })
const failure = (code, message) => Object.assign(new Error(message), { code })
const notFound = () => failure('CODEX_NOT_FOUND', 'Codex was not found in PATH or common installation locations. Install Codex separately or choose its executable in Agent settings.')
const invalidCustom = () => failure('CODEX_EXECUTABLE_INVALID', 'The selected Codex path is not an accessible native executable. Choose the Codex executable or a supported desktop app installation.')
const cancelled = () => failure('CANCELLED', 'Conversation cancelled.')

function environmentValue(environment, name, platform) {
  if (typeof environment?.[name] === 'string') return environment[name]
  if (platform !== 'win32') return ''
  const key = Object.keys(environment || {}).find(key => key.toLowerCase() === name.toLowerCase())
  return key && typeof environment[key] === 'string' ? environment[key] : ''
}

function targetSlots(platform, arch) {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : ''
  if (!cpu) return []
  if (platform === 'darwin') return [`${cpu}-apple-darwin`]
  if (platform === 'linux') return [`${cpu}-unknown-linux-musl`, `${cpu}-unknown-linux-gnu`]
  if (platform === 'win32') return [`${cpu}-pc-windows-msvc`]
  return []
}

function nativeHeader(header, platform) {
  if (header.length < 4) return false
  if (platform === 'win32') return header[0] === 0x4d && header[1] === 0x5a
  if (platform === 'linux') return header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  if (platform === 'darwin') return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(header.readUInt32BE(0))
  return false
}

async function resolveCodexExecutable({ customPath = '', environment = process.env, platform = process.platform, arch = process.arch,
  homeDirectory, excludedRoots = [], signal, fsImpl = fs } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const custom = typeof customPath !== 'string' || customPath !== ''
  let stopped = false
  let candidates = 0
  const check = () => { if (stopped || signal?.aborted) throw cancelled() }
  const cleanPath = value => {
    if (typeof value !== 'string' || !value || value.length > 32768 || /[\u0000-\u001f\u007f]/.test(value)
      || /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || !paths.isAbsolute(value)) return ''
    // A rooted Windows path without a drive depends on the process cwd.
    if (platform === 'win32' && !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value)) return ''
    if (platform === 'win32' && /^\\\\[?.]\\/.test(value)) return ''
    return paths.normalize(value)
  }
  const key = value => platform === 'win32' ? value.toLowerCase() : value
  const roots = (Array.isArray(excludedRoots) ? excludedRoots : []).map(cleanPath).filter(Boolean)
  const excluded = value => {
    if (/(?:^|[\\/])node_modules[\\/]\.bin(?:[\\/]|$)/i.test(value)) return true
    return roots.some(root => {
      const relative = paths.relative(key(root), key(value))
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))
    })
  }
  const home = cleanPath(homeDirectory ?? (environmentValue(environment, platform === 'win32' ? 'USERPROFILE' : 'HOME', platform)
    || (platform === process.platform ? os.homedir() : '')))
  const visited = new Set()

  function macBundleCandidates(bundle) {
    // Current desktop releases nest the native CLI in its own signed app.
    // Keep the legacy layout and explicit CodexCLI.app selection supported;
    // never interpret the adjacent codex-cli/bin shell launcher.
    if (paths.basename(bundle).toLowerCase() === 'codexcli.app') return [paths.join(bundle, 'Contents', 'MacOS', 'codex')]
    return [
      paths.join(bundle, 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'),
      paths.join(bundle, 'Contents', 'Resources', 'codex'),
    ]
  }

  async function canonical(candidate) {
    check()
    candidate = cleanPath(candidate)
    if (!candidate || excluded(candidate)) return ''
    try {
      const resolved = cleanPath(await fsImpl.realpath(candidate))
      check()
      return resolved && !excluded(resolved) ? resolved : ''
    } catch (error) { check(); return '' }
  }

  async function isNative(candidate) {
    check()
    if (platform === 'win32' && paths.extname(candidate).toLowerCase() !== '.exe') return false
    let handle
    try {
      const info = await fsImpl.stat(candidate)
      check()
      if (!info.isFile()) return false
      if (platform !== 'win32') await fsImpl.access(candidate, constants.X_OK)
      check()
      // Read only the fixed-size executable signature, never entire binaries.
      handle = await fsImpl.open(candidate, 'r')
      check()
      const header = Buffer.alloc(4)
      const { bytesRead } = await handle.read(header, 0, 4, 0)
      check()
      return bytesRead === 4 && nativeHeader(header, platform)
    } catch (error) { check(); return false } finally {
      if (handle) { try { await handle.close() } catch {} }
    }
  }

  function npmNativePaths(original, resolved) {
    // Official npm launchers select a fixed platform package. Resolve those
    // native slots directly, including legacy vendor bundles; do not read or
    // interpret a .cmd, shell, JavaScript, or PowerShell wrapper.
    const base = paths.basename(original).toLowerCase()
    const resolvedParts = resolved.split(/[\\/]/)
    const packageLauncher = resolvedParts.slice(-4).join('/').toLowerCase() === '@openai/codex/bin/codex.js'
    if (!['codex', 'codex.cmd', 'codex.exe'].includes(base) && !packageLauncher) return []
    const binDirectory = paths.dirname(original)
    const packageRoots = [
      paths.join(binDirectory, 'node_modules', '@openai', 'codex'),
      paths.join(binDirectory, '..', 'lib', 'node_modules', '@openai', 'codex'),
    ]
    if (packageLauncher) packageRoots.unshift(paths.dirname(paths.dirname(resolved)))
    const executable = platform === 'win32' ? 'codex.exe' : 'codex'
    const platformPackage = `codex-${platform}-${arch}`
    return packageRoots.flatMap(root => targetSlots(platform, arch).flatMap(target => [
      paths.join(root, 'vendor', target, 'codex', executable),
      paths.join(paths.dirname(root), platformPackage, 'vendor', target, 'codex', executable),
      paths.join(root, 'node_modules', '@openai', platformPackage, 'vendor', target, 'codex', executable),
    ]))
  }

  async function tryCandidate(candidate, source, allowNpm = true) {
    check()
    candidate = cleanPath(candidate)
    if (!candidate || excluded(candidate) || visited.has(key(candidate)) || candidates >= LIMITS.candidates) return null
    visited.add(key(candidate)); candidates++
    const resolved = await canonical(candidate)
    if (!resolved) return null
    if (await isNative(resolved)) return { path: resolved, source, mode: custom ? 'custom' : 'automatic' }
    // A nonexistent launcher must not make an adjacent package discoverable
    // under an unrelated PATH directory. Directories are not npm launchers.
    let info
    try { info = await fsImpl.stat(resolved); check() } catch (error) { check(); return null }
    if (allowNpm && info.isFile()) {
      for (const native of npmNativePaths(candidate, resolved)) {
        const found = await tryCandidate(native, source, false)
        if (found) return found
      }
    }
    return null
  }

  async function scanDirectories(directory, matches) {
    const root = await canonical(directory)
    if (!root) return []
    let handle
    const names = []
    try {
      handle = await fsImpl.opendir(root)
      check()
      for (let count = 0; count < LIMITS.directoryEntries; count++) {
        const entry = await handle.read()
        check()
        if (!entry) break
        if (entry.isDirectory() && matches(entry.name) && !/[\\/]/.test(entry.name)) names.push(entry.name)
      }
    } catch (error) { check() } finally {
      if (handle) { try { await handle.close() } catch {} }
    }
    return names.sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).slice(0, LIMITS.matchingDirectories).map(name => paths.join(root, name))
  }

  async function search() {
    check()
    // Resolve exclusions too, so an alternate spelling/symlink cannot point
    // discovery into the current project or another caller-excluded root.
    for (const root of [...roots]) {
      try { const resolved = cleanPath(await fsImpl.realpath(root)); check(); if (resolved) roots.push(resolved) } catch (error) { check() }
    }
    if (custom) {
      const selected = cleanPath(customPath)
      if (!selected) throw invalidCustom()
      const selectedCandidates = platform === 'darwin' && /\.app$/i.test(selected) ? macBundleCandidates(selected) : [selected]
      for (const candidate of selectedCandidates) {
        const found = await tryCandidate(candidate, 'Custom')
        if (found) return found
      }
      throw invalidCustom()
    }

    const pathEntries = environmentValue(environment, 'PATH', platform).split(paths.delimiter).slice(0, LIMITS.pathEntries)
    for (let directory of pathEntries) {
      if (platform === 'win32' && /^".*"$/.test(directory)) directory = directory.slice(1, -1)
      directory = cleanPath(directory)
      if (!directory || excluded(directory)) continue
      for (const name of platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex']) {
        const found = await tryCandidate(paths.join(directory, name), 'PATH')
        if (found) return found
      }
    }

    const desktop = []
    const common = []
    const desktopScans = []
    const commonScans = []
    const addBin = directory => { if (directory) common.push(...(platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex']).map(name => paths.join(directory, name))) }
    if (platform === 'darwin') {
      for (const directory of ['/Applications', home && paths.join(home, 'Applications')].filter(Boolean)) {
        for (const app of ['Codex.app', 'ChatGPT.app']) desktop.push(...macBundleCandidates(paths.join(directory, app)))
      }
      addBin('/opt/homebrew/bin')
    } else if (platform === 'linux') {
      for (const directory of ['/usr/lib/chatgpt', '/usr/lib/codex', '/opt/ChatGPT', '/opt/Codex', '/opt/chatgpt', '/opt/codex', '/usr/share/chatgpt', '/usr/share/codex']) desktop.push(paths.join(directory, 'resources', 'codex'))
      if (home) for (const app of ['chatgpt', 'codex', 'ChatGPT', 'Codex']) desktop.push(paths.join(home, '.local', 'share', app, 'resources', 'codex'))
    } else if (platform === 'win32') {
      const local = cleanPath(environmentValue(environment, 'LOCALAPPDATA', platform)) || (home && paths.join(home, 'AppData', 'Local'))
      const roaming = cleanPath(environmentValue(environment, 'APPDATA', platform)) || (home && paths.join(home, 'AppData', 'Roaming'))
      const programFiles = cleanPath(environmentValue(environment, 'ProgramFiles', platform))
      addBin(local && paths.join(local, 'Programs', 'OpenAI', 'Codex', 'bin'))
      for (const base of [local && paths.join(local, 'Programs'), local, programFiles].filter(Boolean)) {
        for (const app of ['Codex', 'ChatGPT']) {
          const directory = paths.join(base, app)
          desktop.push(paths.join(directory, 'resources', 'codex.exe'), paths.join(directory, 'app', 'resources', 'codex.exe'))
          desktopScans.push({ directory, matches: name => /^app-\d[\w.-]{0,80}$/i.test(name), suffixes: [['resources', 'codex.exe']] })
        }
      }
      if (programFiles) desktopScans.push({ directory: paths.join(programFiles, 'WindowsApps'), matches: name => /^OpenAI\.(?:Codex|ChatGPT(?:-Desktop)?)_[\w.-]{1,160}$/i.test(name), suffixes: [['app', 'resources', 'codex.exe'], ['resources', 'codex.exe']] })
      addBin(roaming && paths.join(roaming, 'npm'))
      addBin(programFiles && paths.join(programFiles, 'nodejs'))
    }
    if (home) {
      for (const directory of [['.local', 'bin'], ['.cargo', 'bin'], ['bin'], ['.npm-global', 'bin'], ['.npm', 'bin']]) addBin(paths.join(home, ...directory))
      if (platform !== 'win32') commonScans.push({ directory: paths.join(home, '.nvm', 'versions', 'node'), matches: name => /^v\d+\.\d+\.\d+$/.test(name), suffixes: [['bin', 'codex']] })
    }
    if (platform !== 'win32') for (const directory of ['/usr/local/bin', '/usr/bin', '/bin']) addBin(directory)

    const desktopGroup = [desktop, desktopScans, 'Desktop app']
    const commonGroup = [common, commonScans, 'Common installation']
    // Finder-launched apps have a sparse PATH. Prefer a separately installed
    // CLI (including the official ~/.local/bin native symlink) before a Mac
    // desktop bundle. Discovery does not execute or certify either candidate.
    const installationGroups = platform === 'darwin' ? [commonGroup, desktopGroup] : [desktopGroup, commonGroup]
    for (const [list, scans, source] of installationGroups) {
      for (const candidate of list) {
        const found = await tryCandidate(candidate, source)
        if (found) return found
      }
      for (const { directory, matches, suffixes } of scans) {
        for (const root of await scanDirectories(directory, matches)) {
          for (const suffix of suffixes) {
            const found = await tryCandidate(paths.join(root, ...suffix), source)
            if (found) return found
          }
        }
      }
    }
    // Only a last resort: never replace the user's PATH, desktop app, npm,
    // standalone installation or explicit selection with a managed download.
    if (platform === 'linux' && home) {
      const managed = await tryCandidate(paths.join(home, '.local', 'share', 'velorn', 'tools', 'codex', 'codex'), 'Velorn managed installation', false)
      if (managed) return managed
    }
    throw notFound()
  }

  // Filesystem calls cannot all be cancelled natively. Return promptly on
  // cancellation/deadline and stop scheduling work after the pending call;
  // handles opened by a late completion still close in their finally block.
  let timer
  let abortListener
  const interrupted = new Promise((resolve, reject) => {
    abortListener = () => { stopped = true; reject(cancelled()) }
    if (signal?.aborted) { abortListener(); return }
    signal?.addEventListener('abort', abortListener, { once: true })
    timer = setTimeout(() => { stopped = true; reject(custom ? invalidCustom() : notFound()) }, LIMITS.timeoutMs)
  })
  try { return await Promise.race([search(), interrupted]) } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortListener)
  }
}

module.exports = { resolveCodexExecutable, LIMITS }
