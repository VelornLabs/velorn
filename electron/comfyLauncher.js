/**
 * ComfyUI process launcher (Pass 1).
 *
 * Owns the ComfyUI child process: spawn, readiness probing, graceful stop,
 * restart, and a rolling log buffer mirrored to disk. Stays intentionally small
 * so Pass 2/3 can layer auto-start and tighter integrations on top.
 *
 * State model:
 *   unknown  - not yet probed
 *   idle     - no external ComfyUI detected, nothing launched by us
 *   starting - we spawned the process, waiting for HTTP readiness
 *   running  - HTTP ready, child process is ours
 *   external - HTTP ready but the process was started outside ComfyStudio
 *   stopping - user requested stop, we issued kill
 *   stopped  - cleanly stopped by user
 *   crashed  - unexpected exit without explicit stop
 */

const path = require('path')
const fs = require('fs')
const fsp = fs.promises
const http = require('http')
const net = require('net')
const { spawn } = require('child_process')
const { EventEmitter } = require('events')

const LAUNCHER_SETTING_KEY = 'comfyLauncher'
const LOG_RING_MAX = 2000
const LOG_FILE_MAX_BYTES = 50 * 1024 * 1024 // 50 MB per session before rotating
const STATE_EVENT = 'state'
const LOG_EVENT = 'log'

const DEFAULT_CONFIG = Object.freeze({
  launcherMode: 'script',
  launcherScript: '',
  macAppPath: '',
  macAppLaunchHidden: true,
  autoStart: false,
  stopOnQuit: true,
  startupTimeoutMs: 120_000,
  extraArgs: '',
  disableAutoLaunch: true,
})

function nowMs() {
  return Date.now()
}

function safeCloneConfig(config) {
  const base = config && typeof config === 'object' ? config : {}
  const launcherMode = base.launcherMode === 'mac-app' ? 'mac-app' : 'script'
  return {
    launcherMode,
    launcherScript: typeof base.launcherScript === 'string' ? base.launcherScript : '',
    macAppPath: typeof base.macAppPath === 'string' ? base.macAppPath : '',
    macAppLaunchHidden: base.macAppLaunchHidden === undefined ? true : Boolean(base.macAppLaunchHidden),
    autoStart: Boolean(base.autoStart),
    stopOnQuit: base.stopOnQuit === undefined ? true : Boolean(base.stopOnQuit),
    startupTimeoutMs: Number.isFinite(Number(base.startupTimeoutMs)) ? Number(base.startupTimeoutMs) : DEFAULT_CONFIG.startupTimeoutMs,
    extraArgs: typeof base.extraArgs === 'string' ? base.extraArgs : '',
    disableAutoLaunch: base.disableAutoLaunch === undefined ? true : Boolean(base.disableAutoLaunch),
  }
}

/**
 * Detect the classic ComfyUI standalone-portable layout living next to the
 * launcher script (e.g. run_nvidia_gpu.bat). Returns { pythonExe, mainPy }
 * when a valid layout is found, otherwise null. Used so we can spawn python
 * directly and have full control over arguments — the default ComfyUI .bat
 * files don't forward %*, so we'd otherwise be unable to pass flags like
 * --disable-auto-launch.
 */
function detectPortableLayout(launcherScript) {
  try {
    const dir = path.dirname(launcherScript)
    const pythonExe = process.platform === 'win32'
      ? path.join(dir, 'python_embeded', 'python.exe')
      : path.join(dir, 'python_embeded', 'bin', 'python3')
    const mainPy = path.join(dir, 'ComfyUI', 'main.py')
    if (fs.existsSync(pythonExe) && fs.existsSync(mainPy)) {
      return { pythonExe, mainPy, cwd: dir }
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Filter duplicate flags. If `--disable-auto-launch` is requested but already
 * present (e.g. user pasted it into extraArgs), avoid duplication.
 */
function ensureArgFlag(args, flag) {
  return args.includes(flag) ? args : [...args, flag]
}

/**
 * Append `[flag, value]` to an args array unless the flag is already
 * present. Used for ComfyUI args that take a value, e.g.
 * `--enable-cors-header "*"`. If the user supplied the flag themselves
 * (via `extraArgs` in settings) we leave their value untouched rather
 * than emit it twice — aiohttp parses the last occurrence, but it's
 * cleaner to not duplicate.
 */
function ensureArgWithValue(args, flag, value) {
  return args.includes(flag) ? args : [...args, flag, value]
}

function parseHttpBase(httpBase) {
  try {
    const url = new URL(String(httpBase || 'http://127.0.0.1:8188'))
    return {
      hostname: url.hostname || '127.0.0.1',
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
      protocol: url.protocol || 'http:',
    }
  } catch {
    return { hostname: '127.0.0.1', port: 8188, protocol: 'http:' }
  }
}

/**
 * Probe http://.../system_stats. Resolves to { ok, status, body, error }.
 */
function probeHttp(httpBase, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const parsed = parseHttpBase(httpBase)
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: '/system_stats',
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'User-Agent': 'ComfyStudio-Launcher/1.0' },
      },
      (res) => {
        let chunks = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { chunks += chunk })
        res.on('end', () => {
          resolve({ ok: res.statusCode === 200, status: res.statusCode || 0, body: chunks, error: '' })
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', (error) => {
      resolve({ ok: false, status: 0, body: '', error: error?.message || 'unknown' })
    })
    req.end()
  })
}

/**
 * Lightweight check: is something listening on <hostname>:<port>?
 * We use this before HTTP probing so we don't spam ECONNREFUSED logs during boot.
 */
function isPortOpen(httpBase, timeoutMs = 500) {
  return new Promise((resolve) => {
    const parsed = parseHttpBase(httpBase)
    const socket = net.connect({ host: parsed.hostname, port: parsed.port })
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      try { socket.destroy() } catch (_) { /* ignore */ }
      resolve(result)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeoutMs, () => finish(false))
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function escapeAppleScriptString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function runProcess(command, args = [], { timeoutMs = 8_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let proc = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({
        ok: false,
        code: null,
        signal: '',
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        ...result,
      })
    }
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        try { proc?.kill?.('SIGTERM') } catch (_) { /* ignore */ }
        finish({ ok: false, error: 'timeout' })
      }, timeoutMs)
      : null

    try {
      proc = spawn(command, args, {})
      proc.stdout?.on('data', (buf) => { stdout += buf.toString('utf8') })
      proc.stderr?.on('data', (buf) => { stderr += buf.toString('utf8') })
      proc.on('error', (error) => finish({ ok: false, error: error?.message || String(error) }))
      proc.on('exit', (code, signal) => finish({
        ok: code === 0,
        code,
        signal: signal || '',
        error: code === 0 ? '' : (stderr.trim() || `${command} exited with code ${code}`),
      }))
    } catch (error) {
      finish({ ok: false, error: error?.message || String(error) })
    }
  })
}

async function getMacAppBundleIdentifier(appPath) {
  if (process.platform !== 'darwin') return ''
  const infoPlistPath = path.join(String(appPath || ''), 'Contents', 'Info.plist')
  const result = await runProcess('/usr/bin/plutil', [
    '-extract',
    'CFBundleIdentifier',
    'raw',
    '-o',
    '-',
    infoPlistPath,
  ], { timeoutMs: 5_000 })
  if (!result.ok) return ''
  return String(result.stdout || '').split(/\r?\n/)[0]?.trim() || ''
}

async function requestMacAppQuit(appPath) {
  if (process.platform !== 'darwin') {
    return { success: false, error: 'ComfyUI.app quit is only available on macOS.' }
  }

  const bundleId = await getMacAppBundleIdentifier(appPath)
  const appName = path.basename(String(appPath || ''), '.app')
  const attempts = []
  if (bundleId) {
    attempts.push({
      label: `bundle id ${bundleId}`,
      args: ['-e', `tell application id "${escapeAppleScriptString(bundleId)}" to quit`],
    })
  }
  if (appName) {
    attempts.push({
      label: `app name ${appName}`,
      args: ['-e', `tell application "${escapeAppleScriptString(appName)}" to quit`],
    })
  }

  let lastError = ''
  for (const attempt of attempts) {
    const result = await runProcess('/usr/bin/osascript', attempt.args, { timeoutMs: 8_000 })
    if (result.ok) {
      return { success: true, detail: `Requested ComfyUI.app quit via ${attempt.label}.` }
    }
    lastError = result.error || result.stderr || `Could not quit via ${attempt.label}.`
  }

  return {
    success: false,
    error: lastError || 'Could not ask macOS to quit ComfyUI.app.',
  }
}

async function waitForPortClosed(httpBase, timeoutMs = 20_000) {
  const base = String(httpBase || '').trim()
  if (!base) return true
  const startedAt = nowMs()
  while (nowMs() - startedAt < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const open = await isPortOpen(base, 500)
    if (!open) return true
    // eslint-disable-next-line no-await-in-loop
    await sleep(500)
  }
  return false
}

/**
 * Kill a child process tree. Returns a promise that resolves when the OS has
 * confirmed the process is gone (best-effort).
 */
function killProcessTree(child) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) {
      resolve()
      return
    }

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }

    const onExit = () => finish()
    child.once('exit', onExit)
    child.once('close', onExit)

    if (process.platform === 'win32' && child.pid) {
      try {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        killer.on('error', () => {
          // Fallback if taskkill is missing for some reason.
          try { child.kill('SIGKILL') } catch (_) { /* ignore */ }
        })
        killer.on('exit', () => {
          // Give the OS a moment to reap; "exit" on the child follows shortly.
          setTimeout(finish, 500)
        })
      } catch (_) {
        try { child.kill('SIGKILL') } catch (_) { /* ignore */ }
        setTimeout(finish, 500)
      }
    } else {
      try { child.kill('SIGTERM') } catch (_) { /* ignore */ }
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch (_) { /* ignore */ }
      }, 8_000)
      child.once('exit', () => clearTimeout(killTimer))
      setTimeout(finish, 9_000)
    }
  })
}

/**
 * Terminate a process tree by pid only (no child-process handle). Used
 * when we've reclaimed a ComfyUI from a previous ComfyStudio session.
 */
function killByPid(pid) {
  return new Promise((resolve, reject) => {
    const numeric = Number(pid)
    if (!Number.isFinite(numeric) || numeric <= 0) {
      reject(new Error('Invalid pid'))
      return
    }

    if (process.platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/PID', String(numeric), '/T', '/F'], { windowsHide: true })
        let errored = false
        killer.on('error', (err) => {
          errored = true
          reject(err)
        })
        killer.on('exit', (code) => {
          if (errored) return
          // taskkill returns 128 for "process not found" and 0 on success.
          // Either way the pid is gone, which is what we want.
          if (code === 0 || code === 128) {
            resolve()
          } else {
            reject(new Error(`taskkill exited with code ${code}`))
          }
        })
      } catch (error) {
        reject(error)
      }
      return
    }

    try {
      process.kill(numeric, 'SIGTERM')
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        reject(error)
        return
      }
      resolve()
      return
    }
    // Escalate to SIGKILL if still alive after 8s.
    setTimeout(() => {
      try { process.kill(numeric, 'SIGKILL') } catch (_) { /* ignore */ }
      resolve()
    }, 8_000)
  })
}

/**
 * Windows: parse `netstat -ano` output to find the PID listening on a
 * given TCP port. Looks for the first LISTENING row matching the port.
 */
function findPidForPortWindows(port) {
  return new Promise((resolve) => {
    try {
      const proc = spawn('netstat.exe', ['-ano', '-p', 'TCP'], { windowsHide: true })
      let output = ''
      proc.stdout?.on('data', (buf) => { output += buf.toString('utf8') })
      proc.on('error', () => resolve(null))
      proc.on('exit', () => {
        try {
          const lines = output.split(/\r?\n/)
          for (const line of lines) {
            if (!/LISTENING/i.test(line)) continue
            // Columns:  Proto  Local Address       Foreign Address       State       PID
            // We match either 127.0.0.1:<port> or 0.0.0.0:<port>.
            const match = line.match(/\s(\d+(?:\.\d+){3}|\[[^\]]+\]):(\d+)\s.*LISTENING\s+(\d+)/i)
            if (match && Number(match[2]) === Number(port)) {
              resolve(Number(match[3]))
              return
            }
          }
          resolve(null)
        } catch (_) {
          resolve(null)
        }
      })
    } catch (_) {
      resolve(null)
    }
  })
}

function findProcessNameWindows(pid) {
  return new Promise((resolve) => {
    try {
      const proc = spawn('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true })
      let output = ''
      proc.stdout?.on('data', (buf) => { output += buf.toString('utf8') })
      proc.on('error', () => resolve(''))
      proc.on('exit', () => {
        try {
          const line = output.split(/\r?\n/).find((l) => l && !/INFO:/i.test(l))
          if (!line) { resolve(''); return }
          // CSV like: "python.exe","12345","Console","1","512,432 K"
          const match = line.match(/^"([^"]+)"/)
          resolve(match?.[1] || '')
        } catch (_) {
          resolve('')
        }
      })
    } catch (_) {
      resolve('')
    }
  })
}

function findPidForPortPosix(port) {
  return new Promise((resolve) => {
    try {
      const proc = spawn('lsof', ['-nP', '-iTCP', `-sTCP:LISTEN`, `-iTCP:${port}`, '-Fp'], {})
      let output = ''
      proc.stdout?.on('data', (buf) => { output += buf.toString('utf8') })
      proc.on('error', () => resolve(null))
      proc.on('exit', () => {
        const match = output.match(/^p(\d+)/m)
        resolve(match ? Number(match[1]) : null)
      })
    } catch (_) {
      resolve(null)
    }
  })
}

function findProcessNamePosix(pid) {
  return new Promise((resolve) => {
    try {
      const proc = spawn('ps', ['-p', String(pid), '-o', 'comm='], {})
      let output = ''
      proc.stdout?.on('data', (buf) => { output += buf.toString('utf8') })
      proc.on('error', () => resolve(''))
      proc.on('exit', () => resolve(output.trim()))
    } catch (_) {
      resolve('')
    }
  })
}

/**
 * Scan the parent directory of the ComfyUI root for common launcher scripts.
 * Returns an array of candidate launchers ranked by preference.
 */
async function detectLaunchersForComfyRoot(comfyRootPath) {
  const root = String(comfyRootPath || '').trim()
  const results = []
  if (!root) return results

  const parent = path.dirname(root)
  if (!parent) return results

  const preferredNames = [
    { name: 'run_nvidia_gpu.bat', label: 'Portable NVIDIA GPU launcher', kind: 'nvidia_gpu' },
    { name: 'run_nvidia_gpu_fast_fp16_accumulation.bat', label: 'Portable NVIDIA GPU (fast FP16)', kind: 'nvidia_gpu_fast' },
    { name: 'run_cpu.bat', label: 'Portable CPU launcher', kind: 'cpu' },
    { name: 'run_nvidia_gpu.sh', label: 'NVIDIA GPU launcher (POSIX)', kind: 'nvidia_gpu' },
    { name: 'run_cpu.sh', label: 'CPU launcher (POSIX)', kind: 'cpu' },
  ]

  for (const entry of preferredNames) {
    const candidate = path.join(parent, entry.name)
    try {
      const stat = await fsp.stat(candidate)
      if (stat.isFile()) {
        results.push({
          path: candidate,
          label: entry.label,
          kind: entry.kind,
          size: stat.size,
          modified: stat.mtimeMs,
        })
      }
    } catch (_) {
      /* launcher not present, keep scanning */
    }
  }

  return results
}

function chunkToLines(buffer, trailing) {
  const combined = `${trailing || ''}${buffer.toString('utf8')}`
  const lines = combined.split(/\r?\n/)
  const nextTrailing = lines.pop() ?? ''
  return { lines: lines.filter((line) => line.length > 0), trailing: nextTrailing }
}

function formatLogFilename(date = new Date()) {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  return `comfyui-${yyyy}${mm}${dd}-${hh}${mi}.log`
}

class ComfyLauncher extends EventEmitter {
  constructor({ logDir, stateFilePath, getHttpBase, getConfig, setConfig, getComfyRootPath }) {
    super()
    this._state = 'unknown'
    this._child = null
    this._pid = null
    this._startedAt = 0
    this._stoppedAt = 0
    this._exitCode = null
    this._exitSignal = null
    this._ownership = 'none' // 'ours' | 'external' | 'app' | 'none'
    this._probeTimer = null
    this._probingSince = 0
    this._startupTimeoutMs = DEFAULT_CONFIG.startupTimeoutMs
    this._lastStatusMessage = ''
    this._lastError = ''

    this._logRing = [] // { ts, stream, text }
    this._stdoutTrailing = ''
    this._stderrTrailing = ''
    this._logStream = null
    this._logFilePath = ''
    this._logBytesWritten = 0

    this._logDir = logDir
    this._stateFilePath = stateFilePath || (logDir ? path.join(path.dirname(logDir), 'comfy-launcher.state.json') : '')
    this._getHttpBase = getHttpBase
    this._getConfig = getConfig
    this._setConfig = setConfig
    this._getComfyRootPath = getComfyRootPath
  }

  async init() {
    await this._ensureLogDir()
    const config = safeCloneConfig(this._getConfig?.())
    // Layer 2 — try to reclaim a previously spawned ComfyUI before falling
    // back to plain external detection. This handles the "ComfyStudio
    // crashed but ComfyUI is still running" case where we want full Stop/
    // Restart control again, not just read-only external status.
    const reclaimed = config.launcherMode === 'mac-app' ? false : await this._tryReclaimFromStateFile()
    if (!reclaimed) {
      if (config.launcherMode === 'mac-app') {
        await this._detectMacAppExternal()
      } else {
        await this._detectExternal()
      }
    }
  }

  async _ensureLogDir() {
    try {
      await fsp.mkdir(this._logDir, { recursive: true })
    } catch (error) {
      // Logging failures are non-fatal; we'll still emit to the ring buffer.
      console.warn('[comfyLauncher] failed to create log dir:', error?.message || error)
    }
  }

  _openLogFile() {
    try {
      if (this._logStream) {
        try { this._logStream.end() } catch (_) { /* ignore */ }
        this._logStream = null
      }
      this._logFilePath = path.join(this._logDir, formatLogFilename())
      this._logStream = fs.createWriteStream(this._logFilePath, { flags: 'a' })
      this._logBytesWritten = 0
      this._logStream.on('error', (error) => {
        console.warn('[comfyLauncher] log file error:', error?.message || error)
      })
    } catch (error) {
      console.warn('[comfyLauncher] could not open log file:', error?.message || error)
      this._logStream = null
      this._logFilePath = ''
    }
  }

  _closeLogFile() {
    if (this._logStream) {
      try { this._logStream.end() } catch (_) { /* ignore */ }
      this._logStream = null
    }
  }

  /**
   * Copy our Python runtime-guard package into the user's ComfyUI
   * custom_nodes directory. Idempotent and fast: we compare file contents
   * and skip the write if it already matches. If ComfyUI isn't laid out
   * the way we expect we quietly bail — the guard is a "nice to have",
   * not required for boot.
   *
   * The guarantees the guard provides (see prestartup_script.py for the
   * full rationale):
   *
   *   1. Swallow Windows pipe `OSError [Errno 22]` from
   *      `io.TextIOWrapper.flush`. Fixes the whole "emoji print crashes
   *      ComfyUI" bug class (`💾 CACHE HIT`, `📝 Punctuation / Truecase`,
   *      etc. from tts_audio_suite and friends).
   *
   *   2. Inject `CREATE_NO_WINDOW` into every Python `subprocess.Popen`
   *      call on Windows unless the caller explicitly opted into a new
   *      console. Fixes the UX problem where three or four cmd windows
   *      flash on screen as custom nodes probe pip / git / ffmpeg during
   *      ComfyUI boot — which reads as "my computer has a virus" to
   *      non-technical users.
   *
   * The directory name is kept as `_comfystudio_stdout_guard` for
   * backwards compatibility with existing user installs (renaming would
   * leave orphan directories behind). The name no longer tells the full
   * story but the behavior is documented above.
   */
  async _installStdoutGuard(launcherScript) {
    const portable = detectPortableLayout(launcherScript)
    if (!portable) {
      this._appendLog('system', 'runtime guard skipped: non-portable ComfyUI layout')
      return
    }
    const customNodesDir = path.join(portable.cwd, 'ComfyUI', 'custom_nodes')
    try {
      const stat = await fsp.stat(customNodesDir)
      if (!stat.isDirectory()) {
        this._appendLog('system', `runtime guard skipped: ${customNodesDir} is not a directory`)
        return
      }
    } catch {
      this._appendLog('system', `runtime guard skipped: no custom_nodes dir at ${customNodesDir}`)
      return
    }

    const sourceDir = path.join(__dirname, 'comfyui-injected', '_comfystudio_stdout_guard')
    const targetDir = path.join(customNodesDir, '_comfystudio_stdout_guard')
    await fsp.mkdir(targetDir, { recursive: true })

    let filenames
    try {
      filenames = await fsp.readdir(sourceDir)
    } catch (err) {
      throw new Error(`runtime guard source missing: ${err.message}`)
    }

    let written = 0
    for (const filename of filenames) {
      if (!/\.py$/i.test(filename)) continue
      const src = path.join(sourceDir, filename)
      const dst = path.join(targetDir, filename)
      const desired = await fsp.readFile(src)
      let current = null
      try {
        current = await fsp.readFile(dst)
      } catch {
        // No existing file — fall through to write.
      }
      if (current && Buffer.isBuffer(current) && current.equals(desired)) continue
      await fsp.writeFile(dst, desired)
      written += 1
    }

    if (written > 0) {
      this._appendLog('system', `runtime guard installed (${written} file${written === 1 ? '' : 's'} written to ${targetDir})`)
    } else {
      this._appendLog('system', `runtime guard up to date at ${targetDir}`)
    }
  }

  _appendLog(stream, line) {
    if (!line) return
    const entry = { ts: nowMs(), stream, text: line.length > 4000 ? `${line.slice(0, 4000)}…` : line }
    this._logRing.push(entry)
    if (this._logRing.length > LOG_RING_MAX) {
      this._logRing.splice(0, this._logRing.length - LOG_RING_MAX)
    }
    this.emit(LOG_EVENT, entry)

    if (this._logStream) {
      try {
        const payload = `[${new Date(entry.ts).toISOString()}][${stream}] ${entry.text}\n`
        const ok = this._logStream.write(payload)
        this._logBytesWritten += Buffer.byteLength(payload, 'utf8')
        if (!ok) {
          // Backpressure: ignore; we'll keep the ring buffer canonical.
        }
        if (this._logBytesWritten > LOG_FILE_MAX_BYTES) {
          this._openLogFile()
        }
      } catch (error) {
        console.warn('[comfyLauncher] log write failed:', error?.message || error)
      }
    }
  }

  _setState(nextState, patch = {}) {
    const changed = this._state !== nextState || Object.keys(patch).length > 0
    this._state = nextState
    if (patch.statusMessage !== undefined) this._lastStatusMessage = patch.statusMessage || ''
    if (patch.error !== undefined) this._lastError = patch.error || ''
    if (changed) this.emit(STATE_EVENT, this.getState())
  }

  getState() {
    const config = this._getConfig?.() || {}
    return {
      state: this._state,
      ownership: this._ownership,
      pid: this._pid,
      startedAt: this._startedAt,
      stoppedAt: this._stoppedAt,
      exitCode: this._exitCode,
      exitSignal: this._exitSignal,
      uptimeMs: this._startedAt && this._state === 'running' ? Math.max(0, nowMs() - this._startedAt) : 0,
      launcherMode: config.launcherMode || 'script',
      launcherScript: config.launcherScript || '',
      macAppPath: config.macAppPath || '',
      macAppLaunchHidden: config.macAppLaunchHidden === undefined ? true : Boolean(config.macAppLaunchHidden),
      httpBase: this._getHttpBase?.() || '',
      statusMessage: this._lastStatusMessage,
      error: this._lastError,
      logFilePath: this._logFilePath,
      probingSince: this._probingSince,
    }
  }

  getLogs({ tailLines = 400 } = {}) {
    const count = Math.max(1, Math.min(LOG_RING_MAX, Number(tailLines) || 400))
    return this._logRing.slice(-count)
  }

  /**
   * Accept a single log line from an external source (e.g. the renderer
   * forwarding ComfyUI websocket events). The whole point is to make the
   * launcher log viewer useful even when ComfyUI was adopted from an
   * external process and we don't own its stdout — and to surface
   * generation progress / errors that otherwise live only in the ComfyUI
   * console window.
   *
   * `stream` is normalised to a small whitelist so we never get an
   * unexpected tag reaching the viewer filter controls.
   */
  appendExternalLog({ stream, text } = {}) {
    const raw = typeof text === 'string' ? text : text == null ? '' : String(text)
    const trimmed = raw.replace(/\r?\n+$/g, '')
    if (!trimmed) return false
    const allowed = new Set(['event', 'generation', 'system', 'stdout', 'stderr'])
    const label = allowed.has(stream) ? stream : 'event'
    this._appendLog(label, trimmed)
    return true
  }

  async _detectExternal() {
    const httpBase = this._getHttpBase?.() || ''
    if (!httpBase) {
      this._ownership = 'none'
      this._setState('idle', { statusMessage: 'ComfyUI not detected.' })
      return
    }

    const portOpen = await isPortOpen(httpBase, 500)
    if (!portOpen) {
      this._ownership = 'none'
      this._setState('idle', { statusMessage: 'ComfyUI is not running.' })
      return
    }

    const probe = await probeHttp(httpBase, 1500)
    if (!probe.ok) {
      this._ownership = 'none'
      this._setState('idle', { statusMessage: `Something is on ${httpBase} but /system_stats did not respond.` })
      return
    }

    // Port is answering ComfyUI. Before settling for a read-only "external"
    // state, try to find its PID via netstat/lsof. If we can identify it,
    // we can offer Stop/Restart just like a process we spawned ourselves.
    // This covers the "ComfyStudio crashed, ComfyUI kept running, no state
    // file" case, as well as users who launched ComfyUI manually.
    const pid = await this._findOwningPidFor(httpBase)
    if (pid) {
      const parsed = parseHttpBase(httpBase)
      this._child = null
      this._pid = pid
      this._ownership = 'ours'
      this._startedAt = nowMs()
      this._exitCode = null
      this._exitSignal = null
      // Persist so subsequent boots can reclaim directly without needing
      // netstat (faster + works on locked-down machines).
      void this._writeStateFile({
        pid,
        port: parsed?.port || null,
        httpBase,
        startedAt: this._startedAt,
      })
      this._appendLog('system', `Adopted running ComfyUI (pid ${pid}) from external process. Stop/Restart enabled.`)
      this._setState('running', {
        statusMessage: `Connected to running ComfyUI (pid ${pid}). ComfyStudio didn't start it, but can stop or restart it.`,
      })
      return
    }

    // Couldn't identify the PID (no netstat permission, locked down, etc.).
    // Fall back to the classic read-only external state.
    this._ownership = 'external'
    this._setState('external', { statusMessage: `ComfyUI already running at ${httpBase}` })
  }

  async _detectMacAppExternal() {
    const httpBase = this._getHttpBase?.() || ''
    if (!httpBase) {
      this._ownership = 'none'
      this._setState('idle', { statusMessage: 'ComfyUI.app not detected.' })
      return
    }

    const adopted = await this._tryAdoptMacAppInstance(httpBase)
    if (adopted) return

    this._child = null
    this._pid = null
    this._ownership = 'none'
    this._setState('idle', { statusMessage: 'ComfyUI.app is not running.' })
  }

  /**
   * Return the PID of the process listening on the HTTP port, or null if
   * we can't determine it. Uses the same platform-specific helpers as
   * describePortOwner().
   */
  async _findOwningPidFor(httpBase) {
    const base = String(httpBase || '').trim()
    if (!base) return null
    const parsed = parseHttpBase(base)
    const port = parsed.port
    try {
      if (process.platform === 'win32') {
        return await findPidForPortWindows(port)
      }
      return await findPidForPortPosix(port)
    } catch (_) {
      return null
    }
  }

  /**
   * If ComfyUI is already answering on httpBase, adopt it instead of
   * spawning a duplicate. Used by start() (Layer 1) and by boot-time
   * reclaim checks (Layer 2).
   *
   * Returns true if we successfully adopted an existing instance.
   */
  async _tryAdoptExistingInstance(httpBase) {
    const base = String(httpBase || '').trim()
    if (!base) return false
    const portOpen = await isPortOpen(base, 500)
    if (!portOpen) return false
    const probe = await probeHttp(base, 2000)
    if (!probe.ok) {
      // Port is taken but the listener isn't ComfyUI (or it's still booting).
      // Surface a clear idle status but let start() continue — spawn will
      // fail fast with EADDRINUSE which is handled in Layer 3.
      this._lastStatusMessage = `Port ${parseHttpBase(base).port} is in use but no ComfyUI responded on /system_stats.`
      return false
    }

    this._appendLog('system', `Detected existing ComfyUI on ${base} — adopting instead of spawning.`)

    // Try to identify the owning PID so we can offer Stop/Restart. If we
    // can't (e.g. netstat unavailable), fall back to read-only external.
    const pid = await this._findOwningPidFor(base)
    this._child = null
    this._exitCode = null
    this._exitSignal = null

    if (pid) {
      const parsed = parseHttpBase(base)
      this._pid = pid
      this._ownership = 'ours'
      this._startedAt = nowMs()
      void this._writeStateFile({
        pid,
        port: parsed?.port || null,
        httpBase: base,
        startedAt: this._startedAt,
      })
      this._setState('running', {
        statusMessage: `Connected to running ComfyUI (pid ${pid}) at ${base}. Stop/Restart enabled.`,
      })
      return true
    }

    this._pid = null
    this._ownership = 'external'
    this._setState('external', {
      statusMessage: `Adopted running ComfyUI at ${base}. Stop or restart it from the window where it was started.`,
    })
    return true
  }

  async _tryAdoptMacAppInstance(httpBase) {
    const base = String(httpBase || '').trim()
    if (!base) return false
    const portOpen = await isPortOpen(base, 500)
    if (!portOpen) return false
    const probe = await probeHttp(base, 2000)
    if (!probe.ok) {
      this._lastStatusMessage = `Port ${parseHttpBase(base).port} is in use but no ComfyUI responded on /system_stats.`
      return false
    }

    const pid = await this._findOwningPidFor(base)
    this._child = null
    this._pid = pid || null
    this._ownership = 'app'
    this._startedAt = nowMs()
    this._exitCode = null
    this._exitSignal = null
    this._appendLog('system', `Connected to ComfyUI.app at ${base}${pid ? ` (pid ${pid})` : ''}.`)
    this._setState('running', {
      statusMessage: `Connected to ComfyUI.app at ${base}. Stop/Restart enabled.`,
    })
    return true
  }

  // ---- Layer 3: scan logs for well-known errors -------------------------

  /**
   * Look for the tell-tale bind-failure lines emitted by asyncio / uvicorn /
   * Python and flip the launcher into a "port-in-use" error state the UI
   * can render as an actionable banner. Safe to call on every line; exits
   * early after we've already latched the error so we don't re-fire it on
   * subsequent tracebacks.
   */
  _scanForKnownErrors(line) {
    if (!line || this._lastError === 'port-in-use') return
    const text = String(line)
    const isBindError =
      text.includes('Errno 10048') ||
      /\bWinError\s*10048\b/i.test(text) ||
      /only one usage of each socket address/i.test(text) ||
      text.includes('EADDRINUSE') ||
      /address already in use/i.test(text)
    if (!isBindError) return

    const base = this._getHttpBase?.() || ''
    const parsed = base ? parseHttpBase(base) : null
    const port = parsed?.port || 8188
    this._appendLog('system', `Detected port-in-use error — port ${port} is already bound by another process.`)
    this._setState('crashed', {
      statusMessage: `Port ${port} is already in use. ComfyUI could not bind to it.`,
      error: 'port-in-use',
    })
  }

  /**
   * Best-effort port-owner lookup. Returns { pid, name } when we can
   * identify who's holding the HTTP port, or { pid: null } otherwise.
   * Callers should not block the UI on this — it runs a short-lived
   * system command.
   */
  async describePortOwner() {
    const base = this._getHttpBase?.() || ''
    if (!base) return { pid: null, name: '', port: null }
    const parsed = parseHttpBase(base)
    const port = parsed.port
    try {
      if (process.platform === 'win32') {
        const pid = await findPidForPortWindows(port)
        if (!pid) return { pid: null, name: '', port }
        const name = await findProcessNameWindows(pid)
        return { pid, name, port }
      }
      const pid = await findPidForPortPosix(port)
      if (!pid) return { pid: null, name: '', port }
      const name = await findProcessNamePosix(pid)
      return { pid, name, port }
    } catch (_) {
      return { pid: null, name: '', port }
    }
  }

  // ---- Layer 2: persist + reclaim ---------------------------------------

  async _readStateFile() {
    if (!this._stateFilePath) return null
    try {
      const raw = await fsp.readFile(this._stateFilePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return null
      const pid = Number(parsed.pid)
      if (!Number.isFinite(pid) || pid <= 0) return null
      return {
        pid,
        port: Number(parsed.port) || null,
        httpBase: String(parsed.httpBase || ''),
        startedAt: Number(parsed.startedAt) || 0,
      }
    } catch (_) {
      return null
    }
  }

  async _writeStateFile(record) {
    if (!this._stateFilePath) return
    try {
      await fsp.mkdir(path.dirname(this._stateFilePath), { recursive: true })
      const payload = JSON.stringify(record, null, 2)
      await fsp.writeFile(this._stateFilePath, payload, 'utf8')
    } catch (error) {
      this._appendLog('system', `Could not persist launcher state: ${error?.message || error}`)
    }
  }

  async _clearStateFile(reason = '') {
    if (!this._stateFilePath) return
    try {
      await fsp.unlink(this._stateFilePath)
      if (reason) this._appendLog('system', `Cleared launcher state file (${reason}).`)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this._appendLog('system', `Could not clear launcher state file: ${error?.message || error}`)
      }
    }
  }

  _pidIsAlive(pid) {
    const numeric = Number(pid)
    if (!Number.isFinite(numeric) || numeric <= 0) return false
    try {
      // signal 0 is "just check existence / permissions". Throws ESRCH if
      // the process is gone. On Windows EPERM can happen for processes we
      // don't own — treat that as "alive but not ours" and let the
      // port-probe decide whether it's actually ComfyUI.
      process.kill(numeric, 0)
      return true
    } catch (error) {
      if (error?.code === 'EPERM') return true
      return false
    }
  }

  /**
   * Called once during init(). If a previous ComfyStudio session wrote a
   * state file and the recorded PID is still alive and the HTTP endpoint
   * still answers as ComfyUI, we "reclaim" the process: treat it as our
   * own, so Stop / Restart work normally. Otherwise clear the stale file.
   */
  async _tryReclaimFromStateFile() {
    const record = await this._readStateFile()
    if (!record) return false

    const httpBase = this._getHttpBase?.() || record.httpBase || ''
    if (!httpBase) {
      await this._clearStateFile('no http base')
      return false
    }

    const alive = this._pidIsAlive(record.pid)
    if (!alive) {
      await this._clearStateFile(`pid ${record.pid} is gone`)
      return false
    }

    const portOpen = await isPortOpen(httpBase, 500)
    if (!portOpen) {
      // PID exists but nothing is on the port. Could be a zombie, or a
      // launcher that hasn't finished binding yet. Be conservative: don't
      // claim ownership and don't delete the file — let the normal start
      // flow re-evaluate.
      return false
    }

    const probe = await probeHttp(httpBase, 2000)
    if (!probe.ok) {
      // Something is on the port but it isn't answering ComfyUI.
      // Don't claim ownership of a foreign process.
      await this._clearStateFile('port taken by non-ComfyUI listener')
      return false
    }

    this._child = null // we can't regain stdio pipes for a process we didn't just spawn
    this._pid = record.pid
    this._ownership = 'ours'
    this._startedAt = record.startedAt || nowMs()
    this._exitCode = null
    this._exitSignal = null
    this._appendLog('system', `Reclaimed ComfyUI from previous session (pid ${record.pid}) at ${httpBase}.`)
    this._setState('running', {
      statusMessage: `Reconnected to ComfyUI from previous session (pid ${record.pid}).`,
    })
    return true
  }

  async start() {
    if (this._state === 'running' || this._state === 'starting' || this._state === 'external') {
      return { success: false, error: `ComfyUI is already in state "${this._state}".` }
    }

    const httpBase = this._getHttpBase?.() || ''
    const config = safeCloneConfig(this._getConfig?.())

    // Layer 1 — probe before spawn. If ComfyUI is already answering on the
    // configured port (e.g. the user launched it manually, or our previous
    // ComfyStudio session crashed and left ComfyUI alive), adopting it is
    // always the right answer. Spawning a second process would fail with
    // EADDRINUSE and only confuse the user.
    if (httpBase) {
      const adopted = config.launcherMode === 'mac-app'
        ? await this._tryAdoptMacAppInstance(httpBase)
        : await this._tryAdoptExistingInstance(httpBase)
      if (adopted) {
        return { success: true, adopted: true, httpBase }
      }
    }

    if (config.launcherMode === 'mac-app') {
      return this._startMacApp(config, httpBase)
    }

    const launcherScript = String(config.launcherScript || '').trim()
    if (!launcherScript) {
      const message = 'No ComfyUI launcher script is configured. Pick your run_nvidia_gpu.bat (or equivalent) in Settings.'
      this._setState('idle', { statusMessage: message, error: 'missing-launcher' })
      return { success: false, error: message }
    }

    try {
      const stat = await fsp.stat(launcherScript)
      if (!stat.isFile()) throw new Error('Not a file')
    } catch (error) {
      const message = `Launcher script does not exist or is not a file: ${launcherScript}`
      this._setState('idle', { statusMessage: message, error: 'missing-launcher-file' })
      return { success: false, error: message }
    }

    this._startupTimeoutMs = Math.max(10_000, Number(config.startupTimeoutMs) || DEFAULT_CONFIG.startupTimeoutMs)

    this._openLogFile()
    this._appendLog('system', `Starting ComfyUI from ${launcherScript}`)
    this._appendLog('system', `cwd=${path.dirname(launcherScript)} httpBase=${httpBase || 'unknown'}`)

    // Install our runtime guard into the user's custom_nodes/ dir. It's a
    // tiny prestartup hook that (a) swallows the Windows pipe flush quirk
    // so emoji prints in third-party nodes don't take down the workflow,
    // and (b) injects CREATE_NO_WINDOW into Python subprocess calls so
    // custom nodes probing pip/git/ffmpeg at boot don't flash cmd windows
    // on screen. Best-effort — if it fails we log and keep going.
    try {
      await this._installStdoutGuard(launcherScript)
    } catch (err) {
      this._appendLog('system', `runtime guard install skipped: ${err?.message || err}`)
    }

    let child
    try {
      child = await this._spawnLauncher(launcherScript, config)
    } catch (error) {
      const message = `Failed to spawn ComfyUI: ${error?.message || error}`
      this._appendLog('system', message)
      this._setState('idle', { statusMessage: message, error: 'spawn-failed' })
      this._closeLogFile()
      return { success: false, error: message }
    }

    this._child = child
    this._pid = child.pid || null
    this._ownership = 'ours'
    this._startedAt = nowMs()
    this._stoppedAt = 0
    this._exitCode = null
    this._exitSignal = null
    this._probingSince = nowMs()
    this._setState('starting', { statusMessage: `Starting ComfyUI (pid ${this._pid}). First boot can take 30-60s.` })

    // Persist pid/port so a future ComfyStudio boot can reclaim this child
    // if we crash before it exits. Fire-and-forget: we never block startup
    // on disk I/O.
    if (this._pid) {
      const parsed = httpBase ? parseHttpBase(httpBase) : null
      void this._writeStateFile({
        pid: this._pid,
        port: parsed?.port || null,
        httpBase: httpBase || '',
        startedAt: this._startedAt,
      })
    }

    child.stdout?.on('data', (buf) => {
      const result = chunkToLines(buf, this._stdoutTrailing)
      this._stdoutTrailing = result.trailing
      for (const line of result.lines) {
        this._appendLog('stdout', line)
        this._scanForKnownErrors(line)
      }
    })
    child.stderr?.on('data', (buf) => {
      const result = chunkToLines(buf, this._stderrTrailing)
      this._stderrTrailing = result.trailing
      for (const line of result.lines) {
        this._appendLog('stderr', line)
        this._scanForKnownErrors(line)
      }
    })
    child.on('exit', (code, signal) => {
      this._exitCode = typeof code === 'number' ? code : null
      this._exitSignal = signal || null
      this._stoppedAt = nowMs()
      const explicit = this._state === 'stopping'
      this._appendLog('system', `Process exited (code=${this._exitCode}, signal=${this._exitSignal || 'none'}).`)

      this._child = null
      this._pid = null
      this._ownership = 'none'
      this._stopProbing()
      void this._clearStateFile('process exited')

      if (explicit) {
        this._setState('stopped', { statusMessage: 'ComfyUI stopped.' })
      } else if ((this._exitCode ?? -1) === 0) {
        this._setState('stopped', { statusMessage: 'ComfyUI exited.' })
      } else {
        this._setState('crashed', {
          statusMessage: `ComfyUI exited unexpectedly (code ${this._exitCode}${this._exitSignal ? `, signal ${this._exitSignal}` : ''}).`,
          error: 'unexpected-exit',
        })
      }

      this._closeLogFile()
    })
    child.on('error', (error) => {
      this._appendLog('system', `Process error: ${error?.message || error}`)
    })

    this._startProbing(httpBase, this._startupTimeoutMs)
    return { success: true }
  }

  async _startMacApp(config, httpBase) {
    if (process.platform !== 'darwin') {
      const message = 'ComfyUI.app launching is only available on macOS.'
      this._setState('idle', { statusMessage: message, error: 'unsupported-launcher-mode' })
      return { success: false, error: message }
    }

    const appPath = String(config.macAppPath || '').trim()
    if (!appPath) {
      const message = 'No ComfyUI.app is configured. Pick the ComfyUI.app bundle in Settings.'
      this._setState('idle', { statusMessage: message, error: 'missing-mac-app' })
      return { success: false, error: message }
    }

    try {
      const stat = await fsp.stat(appPath)
      if (!stat.isDirectory() || path.extname(appPath).toLowerCase() !== '.app') {
        throw new Error('Not a macOS app bundle')
      }
    } catch (error) {
      const message = `ComfyUI.app does not exist or is not an app bundle: ${appPath}`
      this._setState('idle', { statusMessage: message, error: 'missing-mac-app-file' })
      return { success: false, error: message }
    }

    this._startupTimeoutMs = Math.max(10_000, Number(config.startupTimeoutMs) || DEFAULT_CONFIG.startupTimeoutMs)
    this._openLogFile()
    const openArgs = config.macAppLaunchHidden ? ['-g', '-j', appPath] : [appPath]
    this._appendLog('system', `Opening ComfyUI.app from ${appPath}${config.macAppLaunchHidden ? ' (background)' : ''}`)
    this._appendLog('system', `httpBase=${httpBase || 'unknown'}`)

    this._child = null
    this._pid = null
    this._ownership = 'app'
    this._startedAt = nowMs()
    this._stoppedAt = 0
    this._exitCode = null
    this._exitSignal = null
    this._probingSince = nowMs()
    this._setState('starting', { statusMessage: 'Opening ComfyUI.app and waiting for ComfyUI to respond.' })

    try {
      await new Promise((resolve, reject) => {
        const opener = spawn('open', openArgs, {
          stdio: ['ignore', 'ignore', 'pipe'],
          detached: true,
        })
        let stderr = ''
        opener.stderr?.on('data', (buf) => { stderr += buf.toString('utf8') })
        opener.on('error', reject)
        opener.on('exit', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(stderr.trim() || `open exited with code ${code}`))
          }
        })
        opener.unref?.()
      })
    } catch (error) {
      const message = `Failed to open ComfyUI.app: ${error?.message || error}`
      this._appendLog('system', message)
      this._ownership = 'none'
      this._setState('idle', { statusMessage: message, error: 'spawn-failed' })
      this._closeLogFile()
      return { success: false, error: message }
    }

    this._startMacAppProbing(httpBase, this._startupTimeoutMs)
    return { success: true }
  }

  _startMacAppProbing(httpBase, timeoutMs) {
    this._stopProbing()
    const startedAt = nowMs()
    const tick = async () => {
      if (this._state !== 'starting' || this._ownership !== 'app') return
      const elapsed = nowMs() - startedAt
      if (elapsed > timeoutMs) {
        const message = `ComfyUI.app did not respond on ${httpBase || 'the configured endpoint'} after ${Math.round(elapsed / 1000)}s.`
        this._appendLog('system', message)
        this._ownership = 'none'
        this._pid = null
        this._setState('idle', { statusMessage: message, error: 'startup-timeout' })
        this._closeLogFile()
        return
      }

      const portOpen = await isPortOpen(httpBase, 500)
      if (!portOpen) {
        this._probeTimer = setTimeout(tick, 750)
        return
      }
      const probe = await probeHttp(httpBase, 1500)
      if (probe.ok) {
        const pid = await this._findOwningPidFor(httpBase)
        this._pid = pid || null
        this._ownership = 'app'
        this._setState('running', {
          statusMessage: `ComfyUI.app ready at ${httpBase}${pid ? ` (pid ${pid})` : ''}.`,
        })
        this._probeTimer = null
        return
      }
      this._probeTimer = setTimeout(tick, 750)
    }
    this._probeTimer = setTimeout(tick, 500)
  }

  async _spawnLauncher(launcherScript, config) {
    const cwd = path.dirname(launcherScript)
    const extraArgs = String(config.extraArgs || '').trim()
    const extraArgTokens = extraArgs ? splitShellArgs(extraArgs) : []
    const isWindowsBat = /\.(bat|cmd)$/i.test(launcherScript)

    // Env vars needed on every spawn path to keep Python's stdout sane when
    // we're owning the pipes:
    //   PYTHONIOENCODING=utf-8  — so nodes that print non-ASCII (emojis,
    //     CJK) don't hit codec errors on Windows code-page pipes.
    //   PYTHONUTF8=1            — belt-and-suspenders: activates Python's
    //     full UTF-8 Mode (affects more defaults than PYTHONIOENCODING).
    //   PYTHONUNBUFFERED=1      — CRITICAL. Fixes a crash where custom-node
    //     logging wrappers (notably ComfyUI-Manager's prestartup_script)
    //     call `original_stdout.flush()` without a try/except. On Windows
    //     piped stdout, flush() can raise OSError:[Errno 22] for normal
    //     messages, which aborts the whole node. Unbuffered stdout empties
    //     the buffer after every write, so flush() becomes a safe no-op.
    const pythonEnv = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      PYTHONUNBUFFERED: '1',
    }

    // Preferred path: if the launcher lives inside a standard ComfyUI
    // portable build, spawn python directly. This lets us pass flags like
    // --disable-auto-launch reliably because the default .bat files in
    // ComfyUI_windows_portable do NOT forward %* to main.py.
    const portable = detectPortableLayout(launcherScript)
    if (portable) {
      let baseArgs = ['-s', portable.mainPy, '--windows-standalone-build']
      if (config.disableAutoLaunch !== false) {
        baseArgs = ensureArgFlag(baseArgs, '--disable-auto-launch')
      }
      // --enable-cors-header "*" is required for ComfyStudio's renderer to
      // talk to ComfyUI in dev mode (Vite at 127.0.0.1:5173 vs. ComfyUI at
      // 127.0.0.1:8188) and to read mask / render-cache PNGs back into a
      // canvas without being blocked by ComfyUI's origin-only middleware.
      // See comfyui/server.py::origin_only_middleware — when this flag is
      // absent, any request whose Origin host != ComfyUI's Host is
      // rejected with 403, which shows up in the ComfyUI log as a wall of
      // "WARNING: request with non matching host and origin" lines and
      // silently breaks cross-origin image readback. In production Electron
      // the page loads from file:// (Origin: "null") so the check is a
      // no-op and the lack of this flag didn't matter; dev mode exposed it.
      baseArgs = ensureArgWithValue(baseArgs, '--enable-cors-header', '*')
      const mergedArgs = (() => {
        const out = [...baseArgs]
        for (const token of extraArgTokens) {
          if (!out.includes(token)) out.push(token)
        }
        return out
      })()
      this._appendLog('system', `Launching ComfyUI directly: ${portable.pythonExe} ${mergedArgs.join(' ')}`)
      return spawn(portable.pythonExe, mergedArgs, {
        cwd: portable.cwd,
        windowsHide: true,
        // detached:true puts the child in its own process group so it can
        // survive the parent if the user chooses "Leave ComfyUI running" at
        // quit time. We still keep stdio pipes for live log capture while
        // ComfyStudio is running; on detach we release them explicitly.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: pythonEnv,
      })
    }

    // Fallback: run the user's launcher script. Arg forwarding depends on
    // whether the script itself propagates %* / "$@".
    if (process.platform === 'win32' && isWindowsBat) {
      const args = ['/c', launcherScript]
      if (config.disableAutoLaunch !== false) args.push('--disable-auto-launch')
      // See the big comment on --enable-cors-header in the portable branch
      // above. Whether this actually reaches main.py depends on the user's
      // .bat forwarding %*; the stock ComfyUI portable .bat files do NOT,
      // so users on the fallback path may still need to either (a) let us
      // use the portable python directly, or (b) add the flag to their
      // launcher script themselves.
      args.push('--enable-cors-header', '*')
      if (extraArgTokens.length) args.push(...extraArgTokens)
      this._appendLog('system', `Launching ComfyUI via cmd /c ${launcherScript} (args forwarding depends on your .bat)`)
      return spawn('cmd.exe', args, {
        cwd,
        windowsHide: true,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: pythonEnv,
      })
    }

    if (process.platform !== 'win32') {
      const parts = []
      if (config.disableAutoLaunch !== false) parts.push('--disable-auto-launch')
      // Same rationale as the Windows .bat branch. Shell-quoted so the
      // asterisk isn't expanded by bash glob: launchers running in dirs
      // with matching filenames would otherwise expand `*` into the
      // directory listing and confuse aiohttp's arg parser.
      parts.push('--enable-cors-header "*"')
      if (extraArgs) parts.push(extraArgs)
      const cmd = parts.length
        ? `exec "${launcherScript}" ${parts.join(' ')}`
        : `exec "${launcherScript}"`
      return spawn('bash', ['-c', cmd], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: pythonEnv,
      })
    }

    const finalArgs = [...extraArgTokens]
    if (config.disableAutoLaunch !== false) finalArgs.unshift('--disable-auto-launch')
    // See portable-branch comment above for the rationale. Passed directly
    // (no shell quoting needed since we're spawning without a shell).
    finalArgs.push('--enable-cors-header', '*')
    return spawn(launcherScript, finalArgs, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: pythonEnv,
    })
  }

  _startProbing(httpBase, timeoutMs) {
    this._stopProbing()
    const startedAt = nowMs()
    const tick = async () => {
      if (!this._child) return
      const elapsed = nowMs() - startedAt
      if (elapsed > timeoutMs) {
        this._appendLog('system', `Startup probe timed out after ${Math.round(elapsed / 1000)}s. Killing process.`)
        this._setState('stopping', { statusMessage: 'ComfyUI did not become ready in time. Stopping.', error: 'startup-timeout' })
        try { await killProcessTree(this._child) } catch (_) { /* ignore */ }
        return
      }

      const portOpen = await isPortOpen(httpBase, 500)
      if (!portOpen) {
        this._probeTimer = setTimeout(tick, 750)
        return
      }
      const probe = await probeHttp(httpBase, 1500)
      if (probe.ok) {
        this._ownership = 'ours'
        this._setState('running', { statusMessage: `ComfyUI ready at ${httpBase} (pid ${this._pid}).` })
        this._probeTimer = null
        return
      }
      this._probeTimer = setTimeout(tick, 750)
    }
    this._probeTimer = setTimeout(tick, 500)
  }

  _stopProbing() {
    if (this._probeTimer) {
      clearTimeout(this._probeTimer)
      this._probeTimer = null
    }
    this._probingSince = 0
  }

  async _stopMacApp({ restarting = false } = {}) {
    if (process.platform !== 'darwin') {
      const message = 'ComfyUI.app controls are only available on macOS.'
      this._setState('running', { statusMessage: message, error: 'unsupported-launcher-mode' })
      return { success: false, error: message }
    }

    const config = safeCloneConfig(this._getConfig?.())
    const appPath = String(config.macAppPath || '').trim()
    if (!appPath) {
      const message = 'No ComfyUI.app is configured. Pick the ComfyUI.app bundle in Settings.'
      this._setState('running', { statusMessage: message, error: 'missing-mac-app' })
      return { success: false, error: message }
    }

    const httpBase = this._getHttpBase?.() || ''
    const previousPid = this._pid
    this._stopProbing()
    this._openLogFile()
    this._setState('stopping', {
      statusMessage: restarting ? 'Restarting ComfyUI.app...' : 'Quitting ComfyUI.app...',
    })
    this._appendLog('system', restarting ? 'Restart requested for ComfyUI.app.' : 'Stop requested for ComfyUI.app.')

    const quitResult = await requestMacAppQuit(appPath)
    if (!quitResult.success) {
      const message = `Failed to quit ComfyUI.app: ${quitResult.error || 'unknown error'}`
      this._appendLog('system', message)
      this._ownership = 'app'
      this._pid = previousPid || await this._findOwningPidFor(httpBase)
      this._setState('running', { statusMessage: message, error: 'stop-failed' })
      return { success: false, error: message }
    }

    this._appendLog('system', quitResult.detail || 'Requested ComfyUI.app quit.')
    const closed = await waitForPortClosed(httpBase, 20_000)
    if (!closed) {
      const message = 'ComfyUI.app did not stop within 20 seconds. Quit it from macOS and try again.'
      this._appendLog('system', message)
      this._ownership = 'app'
      this._pid = previousPid || await this._findOwningPidFor(httpBase)
      this._setState('running', { statusMessage: message, error: 'stop-timeout' })
      return { success: false, error: message }
    }

    this._child = null
    this._pid = null
    this._ownership = 'none'
    this._stoppedAt = nowMs()
    this._setState('stopped', { statusMessage: 'ComfyUI.app stopped.' })
    this._closeLogFile()
    return { success: true }
  }

  async stop() {
    if (this._ownership === 'app') {
      return this._stopMacApp()
    }
    if (this._state === 'external') {
      return { success: false, error: 'ComfyUI was started outside of ComfyStudio. Stop it from the window where you started it.' }
    }
    if (!this._child && !this._pid) {
      return { success: false, error: 'No ComfyUI process is currently owned by ComfyStudio.' }
    }
    this._setState('stopping', { statusMessage: 'Stopping ComfyUI…' })
    this._appendLog('system', 'Stop requested by user.')

    // Normal case: we spawned the child and have it on `_child`.
    if (this._child) {
      try {
        await killProcessTree(this._child)
        void this._clearStateFile('stop requested')
        return { success: true }
      } catch (error) {
        const message = `Failed to stop ComfyUI: ${error?.message || error}`
        this._appendLog('system', message)
        this._setState('running', { statusMessage: message, error: 'stop-failed' })
        return { success: false, error: message }
      }
    }

    // Reclaimed case: we only have the PID (previous ComfyStudio session
    // spawned it). Kill by PID directly.
    const pid = this._pid
    try {
      await killByPid(pid)
      this._pid = null
      this._ownership = 'none'
      this._stopProbing()
      void this._clearStateFile('stop requested (reclaimed)')
      this._setState('stopped', { statusMessage: 'ComfyUI stopped.' })
      return { success: true }
    } catch (error) {
      const message = `Failed to stop ComfyUI (pid ${pid}): ${error?.message || error}`
      this._appendLog('system', message)
      this._setState('running', { statusMessage: message, error: 'stop-failed' })
      return { success: false, error: message }
    }
  }

  async restart() {
    if (this._ownership === 'app') {
      const stopResult = await this._stopMacApp({ restarting: true })
      if (!stopResult.success) return stopResult
      await sleep(600)
      return this.start()
    }
    if (this._state === 'external') {
      return {
        success: false,
        error: 'ComfyUI is externally managed. Pass 2 will add a soft restart via ComfyUI-Manager for this case.',
      }
    }

    if (this._child || (this._pid && this._ownership === 'ours')) {
      this._appendLog('system', 'Restart requested by user.')
      const stopResult = await this.stop()
      if (!stopResult.success) return stopResult
      // Wait for the child exit to fully settle and the port to close so
      // the subsequent start() doesn't hit EADDRINUSE.
      await sleep(600)
    }

    return this.start()
  }

  async refreshExternal() {
    if (this._ownership === 'ours') return
    const config = safeCloneConfig(this._getConfig?.())
    if (config.launcherMode === 'mac-app') {
      await this._detectMacAppExternal()
    } else {
      await this._detectExternal()
    }
  }

  async shutdown({ confirmStop = true } = {}) {
    if (!this._child && !this._pid) return { stopped: false }
    const config = safeCloneConfig(this._getConfig?.())
    if (!config.stopOnQuit && !confirmStop) return { stopped: false }
    this._setState('stopping', { statusMessage: 'Stopping ComfyUI (app shutting down)…' })
    this._appendLog('system', 'Shutdown requested by host app.')
    try {
      if (this._child) {
        await killProcessTree(this._child)
      } else if (this._pid) {
        await killByPid(this._pid)
      }
    } catch (_) { /* ignore */ }
    void this._clearStateFile('host shutdown')
    return { stopped: true }
  }

  /**
   * Release the child process so it keeps running after ComfyStudio quits.
   *
   * This is a best-effort operation: we unref the subprocess, detach our
   * stdio pipes, and strip listeners so its future exit doesn't touch us.
   * When the parent Electron process exits, the child continues as an
   * orphaned process (on Windows it's already in its own process group from
   * `detached: true`; on POSIX we rely on the existing POSIX launcher which
   * spawns through `bash -c exec …` so the final process has no parent tie).
   *
   * Returns { detached: true, pid } on success, { detached: false } if no
   * owned process is running.
   */
  async detach() {
    if (!this._child) return { detached: false }
    const pid = this._pid
    this._appendLog('system', 'Detach requested — leaving ComfyUI running after ComfyStudio quits.')

    this._stopProbing()

    const child = this._child
    // Remove our listeners so its (eventual) exit doesn't mutate our state
    // after we've already told the UI we detached.
    try { child.removeAllListeners('exit') } catch (_) { /* ignore */ }
    try { child.removeAllListeners('close') } catch (_) { /* ignore */ }
    try { child.removeAllListeners('error') } catch (_) { /* ignore */ }

    // Drain and destroy stdio so node stops holding handles to the child's
    // pipes. The child still owns the write end; Python's default behaviour
    // on a broken pipe is to suppress subsequent print errors (BrokenPipeError
    // is caught globally on shutdown). ComfyUI keeps running.
    try { child.stdout?.removeAllListeners('data'); child.stdout?.destroy() } catch (_) { /* ignore */ }
    try { child.stderr?.removeAllListeners('data'); child.stderr?.destroy() } catch (_) { /* ignore */ }
    try { child.stdin?.destroy() } catch (_) { /* ignore */ }

    try { child.unref() } catch (_) { /* ignore */ }

    // Flip ownership to "external" so if ComfyStudio is relaunched while
    // ComfyUI is still up, the normal detectExternal path adopts it.
    this._ownership = 'external'
    this._child = null
    this._setState('external', {
      statusMessage: pid
        ? `ComfyUI left running (pid ${pid}). It will continue after ComfyStudio quits.`
        : 'ComfyUI left running. It will continue after ComfyStudio quits.',
    })

    this._closeLogFile()
    return { detached: true, pid }
  }
}

/**
 * Quick-and-dirty shell-style argument splitter: keeps quoted substrings
 * together and treats everything else as whitespace-separated tokens.
 */
function splitShellArgs(input) {
  const text = String(input || '').trim()
  if (!text) return []
  const out = []
  let current = ''
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) { quote = '' } else { current += ch }
      continue
    }
    if (ch === '"' || ch === '\'') {
      quote = ch
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (current) { out.push(current); current = '' }
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}

module.exports = {
  ComfyLauncher,
  detectLaunchersForComfyRoot,
  DEFAULT_CONFIG,
  LAUNCHER_SETTING_KEY,
  safeCloneConfig,
  splitShellArgs,
  killProcessTree,
  probeHttp,
  isPortOpen,
}
