const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const MAX_STATS_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 1500
const KNOWN_PORTS = Object.freeze([8188, 8000, 8189])
const portNumber = value => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) return null
  const number = Number(value)
  return Number.isInteger(number) && number > 0 && number <= 65535 ? number : null
}
const timeoutNumber = value => Number.isFinite(Number(value)) && Number(value) > 0
  ? Math.max(100, Math.min(5000, Math.round(Number(value)))) : DEFAULT_TIMEOUT_MS

function isComfySystemStats(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && value.system && typeof value.system === 'object' && !Array.isArray(value.system)
    && typeof value.system.python_version === 'string' && value.system.python_version.trim()
    && Array.isArray(value.devices))
}

// Read only: the URL, host and method are fixed. Never follow an HTTP redirect
// to a different service, and bound the entire request (including slow bodies).
function requestLocalSystemStats({ port, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const validPort = portNumber(port)
  if (!validPort) return Promise.resolve(null)
  return new Promise(resolve => {
    let settled = false, request, response, timer
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      response?.destroy()
      request?.destroy()
      resolve(value)
    }
    timer = setTimeout(() => finish(null), timeoutNumber(timeoutMs))
    try {
      request = http.get({ hostname: '127.0.0.1', port: validPort, path: '/system_stats',
        agent: false, headers: { Accept: 'application/json' } }, incoming => {
        response = incoming
        incoming.on('error', () => finish(null))
        incoming.on('aborted', () => finish(null))
        if (incoming.statusCode !== 200 || Number(incoming.headers['content-length']) > MAX_STATS_BYTES) {
          finish(null)
          return
        }
        const chunks = []
        let bytes = 0
        incoming.on('data', chunk => {
          bytes += chunk.length
          if (bytes > MAX_STATS_BYTES) { finish(null); return }
          chunks.push(chunk)
        })
        incoming.on('end', () => {
          try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
          catch { finish(null) }
        })
      })
      request.on('error', () => finish(null))
    } catch { finish(null) }
  })
}

/** Bounded discovery only: never launches a process, reads arbitrary URLs,
 * scans directories recursively, installs software, or changes settings. */
function createComfySetup({ platform = process.platform, homeDir = os.homedir(), env = process.env,
  stat = fs.promises.stat, access = fs.promises.access, requestSystemStats = requestLocalSystemStats } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const absolute = value => {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !paths.isAbsolute(value.trim())) return null
    return paths.normalize(value.trim())
  }
  const pathKey = value => platform === 'win32' ? value.toLowerCase() : value

  async function probeConnection(port, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const validPort = portNumber(port)
    if (!validPort) return null
    const httpBase = `http://127.0.0.1:${validPort}`
    try {
      const stats = await requestSystemStats({ port: validPort, httpBase, timeoutMs: timeoutNumber(timeoutMs) })
      if (!isComfySystemStats(stats)) return null
      const deviceNames = [...new Set(stats.devices
        .map(device => typeof device?.name === 'string' ? device.name.trim().slice(0, 200) : '')
        .filter(Boolean))].slice(0, 16)
      return { port: validPort, httpBase, deviceNames }
    } catch { return null }
  }

  async function discoverRunning({ configuredPort, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const ports = [...new Set([portNumber(configuredPort), ...KNOWN_PORTS].filter(Boolean))]
    const candidates = await Promise.all(ports.map(port => probeConnection(port, timeoutMs)))
    return candidates.filter(Boolean)
  }

  async function discoverInstallations({ comfyRootPath = '', launcherScript = '', macAppPath = '' } = {}) {
    const requests = new Map()
    const scripts = platform === 'win32'
      ? [['run_nvidia_gpu.bat', 'Windows portable NVIDIA launcher'],
        ['run_nvidia_gpu_fast_fp16_accumulation.bat', 'Windows portable fast FP16 launcher'],
        ['run_cpu.bat', 'Windows portable CPU launcher']]
      : [['run_nvidia_gpu.sh', 'NVIDIA GPU launcher'], ['run_cpu.sh', 'CPU launcher'],
        ['run_comfyui.sh', 'ComfyUI launcher'], ['run_comfyui.command', 'ComfyUI launcher'],
        ['run-velorn-comfyui.sh', 'ComfyUI launcher for Velorn']]
    const add = (value, label, launcherMode) => {
      const normalized = absolute(value)
      if (!normalized || requests.has(pathKey(normalized))) return
      if (launcherMode === 'mac-app' && (platform !== 'darwin' || paths.extname(normalized).toLowerCase() !== '.app')) return
      // Windows Desktop executables are deliberately connect-only until there
      // is a version-aware app integration; never present one as a run script.
      if (launcherMode === 'script' && platform === 'win32' && !/\.(bat|cmd)$/i.test(normalized)) return
      requests.set(pathKey(normalized), { path: normalized, label, launcherMode })
    }
    const addScripts = directory => {
      const normalized = absolute(directory)
      if (normalized) for (const [name, label] of scripts) add(paths.join(normalized, name), label, 'script')
    }

    add(launcherScript, 'Configured ComfyUI launcher', 'script')
    const root = absolute(comfyRootPath)
    if (root) { addScripts(root); addScripts(paths.dirname(root)) }
    if (platform === 'darwin') {
      add(macAppPath, 'Configured ComfyUI app', 'mac-app')
      add('/Applications/Comfy Desktop.app', 'Comfy Desktop in Applications', 'mac-app')
      add('/Applications/ComfyUI.app', 'ComfyUI app in Applications', 'mac-app')
      const home = absolute(homeDir)
      if (home) {
        add(paths.join(home, 'Applications', 'Comfy Desktop.app'), 'Comfy Desktop in your Applications', 'mac-app')
        add(paths.join(home, 'Applications', 'ComfyUI.app'), 'ComfyUI app in your Applications', 'mac-app')
      }
    } else if (platform === 'win32') {
      const home = absolute(homeDir)
      if (home) {
        for (const folder of ['', 'Downloads', 'Documents', 'Desktop']) {
          addScripts(paths.join(home, folder, 'ComfyUI_windows_portable'))
        }
      }
      const driveRoot = typeof env.SystemDrive === 'string' && /^[a-z]:$/i.test(env.SystemDrive)
        ? `${env.SystemDrive}\\` : home ? paths.parse(home).root : null
      if (driveRoot) addScripts(paths.join(driveRoot, 'ComfyUI_windows_portable'))
    }

    const candidates = await Promise.all([...requests.values()].map(async candidate => {
      try {
        const info = await stat(candidate.path)
        if (candidate.launcherMode === 'mac-app') {
          if (!info.isDirectory() || !(await stat(paths.join(candidate.path, 'Contents', 'Info.plist'))).isFile()) return null
        } else {
          if (!info.isFile()) return null
          if (platform !== 'win32') await access(candidate.path, fs.constants.X_OK)
        }
        return candidate
      } catch { return null }
    }))
    return candidates.filter(Boolean)
  }

  return { probeConnection, discoverRunning, discoverInstallations }
}

module.exports = { createComfySetup, isComfySystemStats, requestLocalSystemStats }
