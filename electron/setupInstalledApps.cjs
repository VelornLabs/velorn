'use strict'

// Setup has no general filesystem or command-execution capability. These fixed
// searches find a GUI application, not a running server, model or CLI. Paths
// remain native-only and are never included in inspection/operation results.
const nativeFs = require('node:fs/promises')
const nativePath = require('node:path')
const { spawn: nativeSpawn } = require('node:child_process')

const MAX_ENTRIES = 256
const MAX_DESKTOP_BYTES = 32768
const INTEGRATION = 'lmstudio'
const isPayload = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 1 && value.integration === INTEGRATION
const cleanPath = value => typeof value === 'string' && value.length > 0 && value.length < 4096
  && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value)
const missing = error => ['ENOENT', 'ENOTDIR'].includes(error?.code)
const current = guard => typeof guard === 'function' && guard() === true
const result = (status, summary) => ({ ok: status === 'opened' || status === 'selected', status, summary })
const unknown = summary => ({ state: 'unknown', canOpen: false, summary })
const envNames = ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'DISPLAY', 'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'DBUS_SESSION_BUS_ADDRESS', 'PULSE_SERVER', 'TMPDIR', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)']

function createSetupInstalledApps({ app, platform = process.platform, fs = nativeFs, spawn = nativeSpawn,
  confirmOpen, chooseExecutable, environment = process.env, getUid = () => process.getuid?.(),
} = {}) {
  const path = platform === 'win32' ? nativePath.win32 : nativePath.posix
  let selected = null
  let busy = false
  const validPath = value => cleanPath(value) && path.isAbsolute(value)
    // Windows network shares/device paths are not local app selections.
    && (platform !== 'win32' || /^[a-z]:\\/i.test(value))
  const getAppPath = name => {
    try { const value = app?.getPath(name); return validPath(value) ? value : null } catch { return null }
  }
  const owned = stat => platform === 'win32' || (stat.mode & 0o022) === 0
    && Number.isInteger(stat.uid) && (stat.uid === 0 || stat.uid === getUid())
  const executableName = name => platform === 'win32' ? /^(?:LM Studio|lm-studio|lmstudio)\.exe$/i.test(name)
    : /^(?:LM Studio|lm-studio|lmstudio)$/i.test(name)
      || /^lm[-_ ]?studio(?:[-_][a-z0-9._-]+)?\.appimage$/i.test(name)
  const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.mode, stat.uid].join(':')

  async function readPrefix(filename, max) {
    const handle = await fs.open(filename, 'r')
    try {
      const buffer = Buffer.alloc(max)
      const { bytesRead } = await handle.read(buffer, 0, max, 0)
      return buffer.subarray(0, bytesRead)
    } finally { await handle.close() }
  }

  async function validate(candidate) {
    if (!validPath(candidate)) return null
    const resolved = await fs.realpath(candidate)
    if (!validPath(resolved)) return null
    let binary = resolved
    const targetStat = await fs.stat(resolved)
    if (!owned(targetStat)) return null
    if (platform === 'darwin') {
      if (!/^LM Studio\.app$/i.test(path.basename(resolved)) || !targetStat.isDirectory()) return null
      binary = path.join(resolved, 'Contents', 'MacOS', 'LM Studio')
      // A bundle symlink must not redirect its main executable outside itself.
      const realBinary = await fs.realpath(binary)
      if (realBinary !== binary) return null
    } else if (!executableName(path.basename(resolved)) || !targetStat.isFile()) return null
    const stat = await fs.stat(binary)
    if (!stat.isFile() || !owned(stat) || platform !== 'win32' && (!(stat.mode & 0o111) || (stat.mode & 0o6000))) return null
    const magic = await readPrefix(binary, 4)
    const signature = magic.toString('hex')
    if (platform === 'linux' && signature !== '7f454c46'
      || platform === 'win32' && magic.subarray(0, 2).toString('ascii') !== 'MZ'
      || platform === 'darwin' && !['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(signature)) return null
    // Reject writable ancestors too, including a symlink's canonical directory.
    // Files in /tmp and other shared writable locations cannot be launched here.
    if (platform !== 'win32') {
      let parent = path.dirname(binary)
      for (let depth = 0; depth < 48; depth++) {
        const parentStat = await fs.stat(parent)
        // macOS's standard /Applications is often root:admin 0775. Its
        // administrator-only group write is not the shared-writable location
        // rejected on Linux or for arbitrary/custom application directories.
        const macApplications = platform === 'darwin' && parent === '/Applications'
          && parentStat.uid === 0 && !(parentStat.mode & 0o002)
        if (!parentStat.isDirectory() || !(owned(parentStat) || macApplications)) return null
        const next = path.dirname(parent)
        if (next === parent) break
        if (depth === 47) return null
        parent = next
      }
    }
    return { path: resolved, identity: `${resolved}|${fingerprint(targetStat)}|${fingerprint(stat)}` }
  }

  function locations() {
    const home = getAppPath('home')
    if (!home) return null
    if (platform === 'darwin') return {
      exact: ['/Applications/LM Studio.app', path.join(home, 'Applications', 'LM Studio.app')], dirs: [], desktop: [],
    }
    if (platform === 'win32') {
      const appData = getAppPath('appData')
      const local = appData ? path.join(path.dirname(appData), 'Local') : path.join(home, 'AppData', 'Local')
      const driveRoot = path.parse(home).root
      return { exact: [path.join(local, 'Programs', 'LM Studio', 'LM Studio.exe'),
        path.join(local, 'Programs', 'lm-studio', 'LM Studio.exe'),
        path.join(driveRoot, 'Program Files', 'LM Studio', 'LM Studio.exe'),
        path.join(driveRoot, 'Program Files (x86)', 'LM Studio', 'LM Studio.exe')], dirs: [], desktop: [] }
    }
    if (platform !== 'linux') return null
    return {
      exact: ['/opt/LM Studio/lm-studio', '/opt/LM Studio/LM Studio', '/opt/lm-studio/lm-studio', '/opt/lmstudio/lmstudio',
        ...['/usr/bin', '/usr/local/bin', path.join(home, '.local', 'bin')].flatMap(directory => ['lm-studio', 'lmstudio', 'LM Studio'].map(name => path.join(directory, name)))],
      dirs: ['/opt', path.join(home, 'Applications'),
        path.join(home, 'Applications', 'LM Studio'), path.join(home, 'Downloads')],
      desktop: ['/usr/share/applications', '/usr/local/share/applications', path.join(home, '.local', 'share', 'applications')],
    }
  }

  async function entries(directory) {
    // opendir avoids collecting an arbitrarily large directory in memory.
    const handle = await fs.opendir(directory)
    const values = []
    try {
      while (values.length <= MAX_ENTRIES) {
        const entry = await handle.read()
        if (!entry) return { values, truncated: false }
        values.push(entry)
      }
      return { values: values.slice(0, MAX_ENTRIES), truncated: true }
    } finally { await handle.close() }
  }

  async function desktopTarget(filename) {
    const resolved = await fs.realpath(filename)
    const stat = await fs.stat(resolved)
    if (!stat.isFile() || !owned(stat) || stat.size > MAX_DESKTOP_BYTES) return null
    const content = await readPrefix(resolved, MAX_DESKTOP_BYTES + 1)
    if (content.length > MAX_DESKTOP_BYTES || content.includes(0)) return null
    const fields = new Map()
    let inEntry = false
    for (const line of content.toString('utf8').split(/\r?\n/)) {
      if (/^\[.*\]$/.test(line.trim())) { inEntry = line.trim() === '[Desktop Entry]'; continue }
      if (!inEntry || !line.trim() || line.trim().startsWith('#')) continue
      const item = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line)
      if (!item) continue
      if (fields.has(item[1])) return null
      fields.set(item[1], item[2].trim())
    }
    if (fields.get('Type') !== 'Application' || !/^LM\s?Studio$/i.test(fields.get('Name') || '')
      || fields.get('Hidden') === 'true' || fields.get('Terminal') === 'true') return null
    // No expansion, shell grammar, env wrapper, switches, URLs or model paths.
    // Freedesktop file placeholders are unused because setup opens no files.
    const match = /^(?:"([^"\r\n]+)"|([^\s"'`\\]+))((?:\s+%[fFuU])*)$/.exec(fields.get('Exec') || '')
    const target = match?.[1] || match?.[2]
    if (!validPath(target) || /[$`<>|;&]/.test(target)) return null
    return target
  }

  async function discover() {
    if (selected) {
      try {
        const value = await validate(selected.path)
        if (value && value.identity === selected.identity) return { candidates: [value], uncertain: false }
      } catch {}
      // A changed selection must be selected again, never silently adopted.
      return { candidates: [], uncertain: true }
    }
    const scan = locations()
    if (!scan) return { candidates: [], uncertain: true }
    const candidates = new Map()
    let uncertain = false
    const consider = async value => {
      try {
        const found = await validate(value)
        if (found) candidates.set(found.path, found)
        else uncertain = true
      } catch (error) { if (!missing(error)) uncertain = true }
    }
    for (const value of scan.exact) await consider(value)
    for (const directory of scan.dirs) {
      try {
        const listed = await entries(directory)
        uncertain ||= listed.truncated
        for (const entry of listed.values) if (executableName(entry.name)) await consider(path.join(directory, entry.name))
      } catch (error) { if (!missing(error)) uncertain = true }
    }
    for (const directory of scan.desktop) {
      try {
        const listed = await entries(directory)
        uncertain ||= listed.truncated
        for (const entry of listed.values) {
          if (!/^(?:lm[-_. ]?studio|com\.lmstudio|appimagekit.*lm[-_. ]?studio).*\.desktop$/i.test(entry.name)) continue
          try {
            const target = await desktopTarget(path.join(directory, entry.name))
            if (target) await consider(target)
            else uncertain = true
          } catch (error) { if (!missing(error)) uncertain = true }
        }
      } catch (error) { if (!missing(error)) uncertain = true }
    }
    return { candidates: [...candidates.values()], uncertain }
  }

  function publicInspection(found) {
    if (found.candidates.length > 1) return { state: 'found', canOpen: false,
      summary: 'More than one LM Studio application was found. Choose your existing application before opening it. Server and model readiness are checked separately.' }
    if (found.candidates.length === 1 && !found.uncertain) return { state: 'found', canOpen: true,
      summary: 'An LM Studio application was found. Opening it requires your approval. This does not tell us whether its server is running or a model is loaded.' }
    // Incomplete inventory is not ambiguity between known executable targets.
    // The native dialog approves this exact validated path, not a claim that it
    // is the only installation on the machine. Unverified launchers are never
    // executed, and multiple known candidates still require explicit selection.
    if (found.candidates.length === 1) return { state: 'found', canOpen: true,
      summary: 'An LM Studio application was found. Some other locations or launchers could not be checked. Review the exact application in the native confirmation before opening it. Server and model readiness are checked separately.' }
    if (found.uncertain) return unknown('LM Studio installation could not be verified in the checked locations. You can choose your existing application; nothing was launched.')
    return { state: 'not_found', canOpen: false,
      summary: 'LM Studio was not found in the checked standard locations. It may be installed elsewhere. Choose your existing application or use the official installation guide.' }
  }

  async function inspect(payload) {
    if (!isPayload(payload)) return unknown('Choose LM Studio to check its installation.')
    try { return publicInspection(await discover()) } catch { return unknown('The installation check could not finish. Nothing was launched.') }
  }

  async function choose(payload, { isCurrent } = {}) {
    if (!isPayload(payload)) return result('unavailable', 'Choose LM Studio to locate an existing application.')
    if (!current(isCurrent)) return result('stale', 'The setup view changed. Nothing was selected.')
    if (busy) return result('busy', 'Another application setup action is in progress.')
    if (typeof chooseExecutable !== 'function') return result('unavailable', 'The native application chooser is unavailable.')
    busy = true
    try {
      const chosen = await chooseExecutable({ integration: INTEGRATION, platform })
      if (!current(isCurrent)) return result('stale', 'The setup view changed. Nothing was selected.')
      if (!chosen) return result('cancelled', 'No application was selected.')
      const value = await validate(chosen)
      if (!current(isCurrent)) return result('stale', 'The setup view changed. Nothing was selected.')
      if (!value) return result('unavailable', 'Select the existing LM Studio application, not an installer, script or launcher with custom arguments.')
      selected = value
      return result('selected', 'LM Studio was selected for this Velorn session. It has not been opened or connected.')
    } catch { return result('unavailable', 'The selected LM Studio application could not be verified. Nothing was opened.') }
    finally { busy = false }
  }

  async function open(payload, { isCurrent } = {}) {
    if (!isPayload(payload)) return result('unavailable', 'Choose LM Studio to open an existing application.')
    if (!current(isCurrent)) return result('stale', 'The setup view changed. Nothing was opened.')
    if (busy) return result('busy', 'Another application setup action is in progress.')
    if (typeof confirmOpen !== 'function') return result('unavailable', 'Native confirmation is unavailable. Nothing was opened.')
    busy = true
    try {
      const before = await discover()
      if (!current(isCurrent)) return result('stale', 'The setup view changed. Nothing was opened.')
      if (!publicInspection(before).canOpen) return result('unavailable', publicInspection(before).summary)
      const target = before.candidates[0]
      const approved = await confirmOpen({ integration: INTEGRATION, label: 'LM Studio', path: target.path, action: 'open' })
      if (!current(isCurrent)) return result('stale', 'The setup view changed. Nothing was opened.')
      if (approved !== true) return result('cancelled', 'LM Studio was not opened.')
      const after = await discover()
      if (!current(isCurrent)) return result('stale', 'The setup view changed. Nothing was opened.')
      if (!publicInspection(after).canOpen || after.candidates[0].identity !== target.identity) {
        return result('changed', 'The LM Studio application changed during confirmation. Check or choose the application again; nothing was opened.')
      }
      const env = Object.fromEntries(envNames.filter(name => typeof environment[name] === 'string').map(name => [name, environment[name]]))
      const command = platform === 'darwin' ? '/usr/bin/open' : target.path
      const args = platform === 'darwin' ? ['-a', target.path] : []
      // Never pass model/server flags, shell input, API keys or Electron/Node
      // control variables. Existing app autoload preferences still belong to it.
      await new Promise((resolve, reject) => {
        const child = spawn(command, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: false,
          cwd: path.dirname(target.path), env })
        child.once('error', reject)
        child.once('spawn', () => { child.unref(); resolve() })
      })
      return result('opened', 'LM Studio was opened. Its existing startup preferences may apply. Check its local server next; no model or server command was sent by Velorn.')
    } catch { return result('failed', 'LM Studio could not be opened. Use its normal desktop launcher; no server or model command was sent.') }
    finally { busy = false }
  }

  return { inspect, open, choose }
}

module.exports = { createSetupInstalledApps }
