const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, screen, nativeImage } = require('electron')
const crypto = require('crypto')
const path = require('path')
const os = require('os')
const fs = require('fs').promises
const fsSync = require('fs')
const http = require('http')
const { spawn } = require('child_process')
const { Readable } = require('stream')
const { fileURLToPath } = require('url')
const yaml = require('js-yaml')
const ffmpegStaticPath = require('ffmpeg-static')
const ffprobeStatic = require('ffprobe-static')
const ffprobeStaticPath = ffprobeStatic?.path || ffprobeStatic
const {
  ComfyLauncher,
  detectLaunchersForComfyRoot,
  DEFAULT_CONFIG: DEFAULT_LAUNCHER_CONFIG,
  LAUNCHER_SETTING_KEY,
  safeCloneConfig: safeCloneLauncherConfig,
} = require('./comfyLauncher')

const isDev = !app.isPackaged

app.commandLine.appendSwitch('disable-features', 'Vulkan,WebGPU')
app.commandLine.appendSwitch('disable-vulkan')
app.commandLine.appendSwitch('disable-gpu-sandbox')

// App icon (build/icon.png) – used for window and taskbar/dock
const iconPath = path.join(__dirname, '..', 'build', 'icon.png')

const SPLASH_MIN_DURATION_MS = 4500  // Minimum time splash is visible (Resolve-style)
const COMFYUI_CHECK_MS = 2500        // Max wait for ComfyUI
const STEP_DELAY_MS = 400            // Delay between status messages
const COMFY_CONNECTION_SETTING_KEY = 'comfyConnection'
const DEFAULT_LOCAL_COMFY_PORT = 8188
const MAIN_WINDOW_STATE_SETTING_KEY = 'mainWindowState'
const DEFAULT_MAIN_WINDOW_BOUNDS = Object.freeze({ width: 1600, height: 1000 })
const EXTRA_MODEL_PATH_CONFIG_NAMES = Object.freeze(['extra_model_paths.yaml', 'extra_model_paths.yml'])
const COMMON_MODEL_SEARCH_KEYS = Object.freeze([
  'checkpoints',
  'text_encoders',
  'loras',
  'upscale_models',
  'vae',
  'diffusion_models',
  'clip',
])
const MODEL_SEARCH_KEY_ALIASES = Object.freeze({
  text_encoders: Object.freeze(['text_encoders', 'clip']),
  diffusion_models: Object.freeze(['diffusion_models', 'unet']),
  latent_upscale_models: Object.freeze(['latent_upscale_models', 'upscale_models']),
  audio_checkpoints: Object.freeze(['audio_checkpoints', 'audio_encoders']),
})

let mainWindow = null
let splashWindow = null
let exportWorkerWindow = null
const activeFramePipeExports = new Map()

function abortAllFramePipeExports() {
  for (const [sessionId, session] of activeFramePipeExports.entries()) {
    activeFramePipeExports.delete(sessionId)
    try {
      if (!session.ffmpeg.killed) session.ffmpeg.kill('SIGKILL')
    } catch {
      // ignore abort errors
    }
  }
}

let restoreFullscreenAfterMinimize = false
let mainWindowStateSaveTimer = null
const settingsPath = path.join(app.getPath('userData'), 'settings.json')
let settingsWriteQueue = Promise.resolve()

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

function resolvePackagedBinaryPath(binaryPath) {
  if (!binaryPath || typeof binaryPath !== 'string') return binaryPath
  if (!app.isPackaged) return binaryPath

  const packagedCandidates = []

  if (binaryPath === ffmpegStaticPath) {
    packagedCandidates.push(path.join(process.resourcesPath, 'bin', path.basename(binaryPath)))
  }

  if (binaryPath === ffprobeStaticPath) {
    packagedCandidates.push(
      path.join(process.resourcesPath, 'bin', 'ffprobe-static', process.platform, process.arch, path.basename(binaryPath))
    )
  }

  packagedCandidates.push(binaryPath.replace(/app\.asar([\\/])/i, 'app.asar.unpacked$1'))

  for (const candidate of packagedCandidates) {
    if (candidate && candidate !== binaryPath && fsSync.existsSync(candidate)) {
      return candidate
    }
  }

  return binaryPath
}

const bundledFfmpegPath = resolvePackagedBinaryPath(ffmpegStaticPath)
const ffprobePath = resolvePackagedBinaryPath(ffprobeStaticPath)
const systemFfmpegCandidates = process.platform === 'win32'
  ? ['ffmpeg.exe', 'ffmpeg']
  : ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']
let preferredFfmpegPath = bundledFfmpegPath
let preferredFfmpegSource = 'bundled'

function getFfmpegPath() {
  return preferredFfmpegPath || bundledFfmpegPath
}

async function writeFileAtomic(filePath, data, options) {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  )

  try {
    await fs.writeFile(tempPath, data, options)
    await fs.rename(tempPath, filePath)
  } catch (error) {
    try {
      await fs.unlink(tempPath)
    } catch (_) {
      // Ignore cleanup failures for temp files.
    }
    throw error
  }
}

function getWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return {
      isMaximized: false,
      isFullScreen: false,
    }
  }

  return {
    isMaximized: mainWindow.isMaximized(),
    isFullScreen: mainWindow.isFullScreen(),
  }
}

function sendWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('window:stateChanged', getWindowState())
}

function sanitizeWindowBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null
  const x = Number(bounds.x)
  const y = Number(bounds.y)
  const width = Number(bounds.width)
  const height = Number(bounds.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1200, Math.round(width)),
    height: Math.max(800, Math.round(height)),
  }
}

function getBoundsIntersectionArea(bounds, area) {
  if (!bounds || !area) return 0
  const left = Math.max(bounds.x, area.x)
  const top = Math.max(bounds.y, area.y)
  const right = Math.min(bounds.x + bounds.width, area.x + area.width)
  const bottom = Math.min(bounds.y + bounds.height, area.y + area.height)
  return Math.max(0, right - left) * Math.max(0, bottom - top)
}

function getDisplayForSavedWindowState(savedState, bounds) {
  const displays = screen.getAllDisplays()
  if (!displays.length) return null

  const savedDisplayId = savedState?.displayId
  if (savedDisplayId != null) {
    const display = displays.find((candidate) => String(candidate.id) === String(savedDisplayId))
    if (display) return display
  }

  let bestDisplay = null
  let bestArea = 0
  for (const display of displays) {
    const area = getBoundsIntersectionArea(bounds, display.workArea)
    if (area > bestArea) {
      bestArea = area
      bestDisplay = display
    }
  }

  return bestDisplay || screen.getPrimaryDisplay()
}

function clampWindowBoundsToDisplay(bounds, display) {
  const workArea = display?.workArea || screen.getPrimaryDisplay().workArea
  const width = Math.min(Math.max(1200, bounds?.width || DEFAULT_MAIN_WINDOW_BOUNDS.width), workArea.width)
  const height = Math.min(Math.max(800, bounds?.height || DEFAULT_MAIN_WINDOW_BOUNDS.height), workArea.height)
  const requestedX = Number(bounds?.x)
  const requestedY = Number(bounds?.y)
  const centeredX = workArea.x + Math.round((workArea.width - width) / 2)
  const centeredY = workArea.y + Math.round((workArea.height - height) / 2)
  const x = Math.min(
    Math.max(workArea.x, Number.isFinite(requestedX) ? requestedX : centeredX),
    workArea.x + Math.max(0, workArea.width - width)
  )
  const y = Math.min(
    Math.max(workArea.y, Number.isFinite(requestedY) ? requestedY : centeredY),
    workArea.y + Math.max(0, workArea.height - height)
  )
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  }
}

async function getRestoredMainWindowState() {
  const settings = await readSettingsRaw()
  const savedState = settings?.[MAIN_WINDOW_STATE_SETTING_KEY] || {}
  const savedBounds = sanitizeWindowBounds(savedState.bounds)
  const primaryDisplay = screen.getPrimaryDisplay()

  if (!savedBounds) {
    return {
      bounds: clampWindowBoundsToDisplay(DEFAULT_MAIN_WINDOW_BOUNDS, primaryDisplay),
      isMaximized: true,
    }
  }

  const display = getDisplayForSavedWindowState(savedState, savedBounds) || primaryDisplay
  return {
    bounds: clampWindowBoundsToDisplay(savedBounds, display),
    isMaximized: savedState.isMaximized !== false,
  }
}

async function saveMainWindowStateNow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) return

  try {
    const currentBounds = mainWindow.getBounds()
    const normalBounds = sanitizeWindowBounds(mainWindow.getNormalBounds?.() || currentBounds)
    const display = screen.getDisplayMatching(currentBounds)
    await writeSettingsRaw((settings) => ({
      ...settings,
      [MAIN_WINDOW_STATE_SETTING_KEY]: {
        bounds: normalBounds || sanitizeWindowBounds(currentBounds),
        displayId: display?.id ?? null,
        isMaximized: mainWindow.isMaximized(),
        updatedAt: new Date().toISOString(),
      },
    }))
  } catch (error) {
    console.warn('[mainWindowState] save failed:', error?.message || error)
  }
}

function scheduleSaveMainWindowState() {
  if (mainWindowStateSaveTimer) {
    clearTimeout(mainWindowStateSaveTimer)
  }
  mainWindowStateSaveTimer = setTimeout(() => {
    mainWindowStateSaveTimer = null
    saveMainWindowStateNow()
  }, 350)
}

function setSplashStatus(text) {
  if (!splashWindow || splashWindow.isDestroyed()) return
  const escaped = JSON.stringify(String(text))
  splashWindow.webContents.executeJavaScript(`document.getElementById('splash-status').textContent = ${escaped}`).catch(() => {})
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function captureCommandOutput(command, args = [], timeoutMs = 2500) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    let child = null
    try {
      child = spawn(command, args, { windowsHide: true })
    } catch (error) {
      resolve({ success: false, output: '', error: error.message })
      return
    }

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }

    const timeout = setTimeout(() => {
      try {
        child.kill()
      } catch (_) {
        // Ignore failures when terminating helper processes.
      }
      finish({ success: false, output: stdout || stderr, error: 'Timed out while gathering system info.' })
    }, timeoutMs)

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    child.on('error', (error) => {
      finish({ success: false, output: stdout || stderr, error: error.message })
    })
    child.on('close', (code) => {
      finish({
        success: code === 0,
        output: (stdout || stderr).trim(),
        error: code === 0 ? null : (stderr.trim() || `Command exited with code ${code}`),
      })
    })
  })
}

function emitWorkflowSetupProgress(payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('workflowSetup:progress', {
    ts: Date.now(),
    level: 'info',
    stage: '',
    message: '',
    ...payload,
  })
}

function clampPercent(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Math.max(0, Math.min(100, numeric))
}

function getWorkflowSetupOverallPercent({ completedTasks = 0, totalTasks = 0, taskPercent = null } = {}) {
  const total = Number(totalTasks)
  if (!Number.isFinite(total) || total <= 0) return 0

  const completed = Math.max(0, Math.min(total, Number(completedTasks) || 0))
  const normalizedTaskPercent = clampPercent(taskPercent)
  const unitsDone = completed + (normalizedTaskPercent == null ? 0 : (normalizedTaskPercent / 100))
  return clampPercent(Math.round((unitsDone / total) * 100)) ?? 0
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function isDirectoryPath(targetPath) {
  try {
    const stat = await fs.stat(targetPath)
    return stat.isDirectory()
  } catch {
    return false
  }
}

function normalizeModelSearchKey(value = '') {
  return String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase()
}

function expandPathVariables(value = '') {
  let expanded = String(value || '').trim()
  if (!expanded) return ''

  if (expanded === '~' || expanded.startsWith(`~${path.sep}`) || expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(os.homedir(), expanded.slice(1))
  }

  expanded = expanded.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match)
  expanded = expanded.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, plain) => {
    const name = braced || plain
    return process.env[name] ?? match
  })

  return expanded
}

function splitExtraModelPathValue(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => splitExtraModelPathValue(entry))
  }
  if (typeof value !== 'string') return []
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function addExtraModelSearchPath(pathsByKey, key, folderPath) {
  const normalizedKey = normalizeModelSearchKey(key)
  const normalizedPath = path.normalize(String(folderPath || '').trim())
  if (!normalizedKey || !normalizedPath) return
  if (!pathsByKey.has(normalizedKey)) pathsByKey.set(normalizedKey, [])
  const entries = pathsByKey.get(normalizedKey)
  if (!entries.some((entry) => entry.toLowerCase() === normalizedPath.toLowerCase())) {
    entries.push(normalizedPath)
  }
}

async function loadExtraModelPathConfigForComfyRoot(rootPath) {
  const normalizedRoot = String(rootPath || '').trim()
  const empty = {
    configPath: '',
    pathsByKey: new Map(),
    pathCount: 0,
    warnings: [],
  }
  if (!normalizedRoot) return empty

  let configPath = ''
  for (const filename of EXTRA_MODEL_PATH_CONFIG_NAMES) {
    const candidate = path.join(normalizedRoot, filename)
    if (await pathExists(candidate)) {
      configPath = candidate
      break
    }
  }
  if (!configPath) return empty

  const pathsByKey = new Map()
  const warnings = []

  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const config = yaml.load(raw) || {}
    const yamlDir = path.dirname(configPath)

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return {
        configPath,
        pathsByKey,
        pathCount: 0,
        warnings: ['extra_model_paths.yaml did not contain a valid mapping of model paths.'],
      }
    }

    for (const sectionName of Object.keys(config)) {
      const section = config[sectionName]
      if (!section || typeof section !== 'object' || Array.isArray(section)) continue

      let basePath = ''
      if (typeof section.base_path === 'string' && section.base_path.trim()) {
        basePath = expandPathVariables(section.base_path)
        if (basePath && !path.isAbsolute(basePath)) {
          basePath = path.resolve(yamlDir, basePath)
        }
      }

      for (const key of Object.keys(section)) {
        if (key === 'base_path' || key === 'is_default') continue

        for (const configuredPath of splitExtraModelPathValue(section[key])) {
          let resolvedPath = expandPathVariables(configuredPath)
          if (!resolvedPath) continue
          if (basePath) {
            resolvedPath = path.join(basePath, resolvedPath)
          } else if (!path.isAbsolute(resolvedPath)) {
            resolvedPath = path.resolve(yamlDir, resolvedPath)
          }
          addExtraModelSearchPath(pathsByKey, key, resolvedPath)
        }
      }
    }
  } catch (error) {
    warnings.push(`Could not read extra_model_paths.yaml: ${error?.message || String(error)}`)
  }

  const pathCount = Array.from(pathsByKey.values()).reduce((total, entries) => total + entries.length, 0)
  return {
    configPath,
    pathsByKey,
    pathCount,
    warnings,
  }
}

function getModelSearchKeys(targetSubdir = '') {
  const keys = new Set()
  const normalizedTarget = normalizeModelSearchKey(targetSubdir)
  if (normalizedTarget) keys.add(normalizedTarget)
  for (const key of COMMON_MODEL_SEARCH_KEYS) keys.add(key)

  const expanded = new Set()
  for (const key of keys) {
    expanded.add(key)
    const aliases = MODEL_SEARCH_KEY_ALIASES[key]
    if (Array.isArray(aliases)) {
      for (const alias of aliases) expanded.add(normalizeModelSearchKey(alias))
    }
  }
  return Array.from(expanded).filter(Boolean)
}

function normalizePythonCommand(pythonInfo = null) {
  if (!pythonInfo?.command) return ''
  return [pythonInfo.command, ...(Array.isArray(pythonInfo.baseArgs) ? pythonInfo.baseArgs : [])].join(' ').trim()
}

async function detectPythonCommandForComfyRoot(rootPath) {
  const windowsCandidates = [
    path.join(rootPath, 'python_embeded', 'python.exe'),
    path.join(rootPath, 'python_embedded', 'python.exe'),
    path.join(rootPath, '.venv', 'Scripts', 'python.exe'),
    path.join(rootPath, 'venv', 'Scripts', 'python.exe'),
    path.join(rootPath, 'env', 'Scripts', 'python.exe'),
  ]
  const posixCandidates = [
    path.join(rootPath, '.venv', 'bin', 'python'),
    path.join(rootPath, 'venv', 'bin', 'python'),
    path.join(rootPath, 'env', 'bin', 'python'),
  ]

  const directCandidates = process.platform === 'win32' ? windowsCandidates : posixCandidates
  for (const candidate of directCandidates) {
    if (!candidate) continue
    if (!(await pathExists(candidate))) continue
    if (await isDirectoryPath(candidate)) continue
    return {
      command: candidate,
      baseArgs: [],
      source: 'embedded',
    }
  }

  const systemCandidates = process.platform === 'win32'
    ? [
        { command: 'python', baseArgs: [] },
        { command: 'py', baseArgs: ['-3'] },
      ]
    : [
        { command: 'python3', baseArgs: [] },
        { command: 'python', baseArgs: [] },
      ]

  for (const candidate of systemCandidates) {
    const result = await captureCommandOutput(candidate.command, [...candidate.baseArgs, '--version'], 3000)
    if (!result.success) continue
    return {
      ...candidate,
      source: 'system',
      version: result.output || '',
    }
  }

  return {
    command: '',
    baseArgs: [],
    source: '',
    version: '',
  }
}

async function validateWorkflowSetupRootInternal(rootPath) {
  const normalizedInput = String(rootPath || '').trim()
  if (!normalizedInput) {
    return {
      success: false,
      isValid: false,
      error: 'Select your local ComfyUI folder first.',
      warnings: [],
      normalizedPath: '',
      customNodesPath: '',
      modelsPath: '',
      pythonCommand: '',
      python: null,
    }
  }

  const normalizedPath = path.resolve(normalizedInput)
  if (!(await pathExists(normalizedPath))) {
    return {
      success: false,
      isValid: false,
      error: 'The selected ComfyUI folder does not exist.',
      warnings: [],
      normalizedPath,
      customNodesPath: '',
      modelsPath: '',
      pythonCommand: '',
      python: null,
    }
  }

  if (!(await isDirectoryPath(normalizedPath))) {
    return {
      success: false,
      isValid: false,
      error: 'The selected ComfyUI path is not a folder.',
      warnings: [],
      normalizedPath,
      customNodesPath: '',
      modelsPath: '',
      pythonCommand: '',
      python: null,
    }
  }

  const mainPyPath = path.join(normalizedPath, 'main.py')
  const customNodesPath = path.join(normalizedPath, 'custom_nodes')
  const modelsPath = path.join(normalizedPath, 'models')
  const looksLikeComfyRoot = (
    await pathExists(mainPyPath)
    || await isDirectoryPath(customNodesPath)
    || await isDirectoryPath(modelsPath)
  )

  if (!looksLikeComfyRoot) {
    return {
      success: false,
      isValid: false,
      error: 'This folder does not look like a ComfyUI root. Pick the folder that contains main.py, custom_nodes, or models.',
      warnings: [],
      normalizedPath,
      customNodesPath,
      modelsPath,
      pythonCommand: '',
      python: null,
    }
  }

  const warnings = []
  if (!(await pathExists(mainPyPath))) {
    warnings.push('Could not find main.py directly inside this folder. If installs fail, pick the top-level ComfyUI directory instead.')
  }

  const python = await detectPythonCommandForComfyRoot(normalizedPath)
  if (!python.command) {
    warnings.push('Could not detect a dedicated Python interpreter for this ComfyUI install. Model downloads can still work, but custom-node dependency installs may fail.')
  }
  const extraModelPaths = await loadExtraModelPathConfigForComfyRoot(normalizedPath)
  warnings.push(...extraModelPaths.warnings)

  return {
    success: true,
    isValid: true,
    error: '',
    warnings,
    normalizedPath,
    customNodesPath,
    modelsPath,
    pythonCommand: normalizePythonCommand(python),
    python,
    extraModelConfigPath: extraModelPaths.configPath,
    extraModelPathCount: extraModelPaths.pathCount,
  }
}

function emitProcessLines(prefix, buffer, level = 'info') {
  const lines = String(buffer || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    emitWorkflowSetupProgress({
      level,
      stage: 'command',
      message: prefix ? `${prefix}: ${line}` : line,
    })
  }
}

function runCommandStreaming({ command, args = [], cwd = undefined, label = 'Command' }) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    emitWorkflowSetupProgress({
      stage: 'command',
      message: `${label}: ${command} ${args.join(' ')}`.trim(),
    })

    let child = null
    try {
      child = spawn(command, args, { cwd, windowsHide: true })
    } catch (error) {
      reject(error)
      return
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      emitProcessLines(label, text, 'info')
    })

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      emitProcessLines(label, text, 'warning')
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }

      reject(new Error(stderr.trim() || stdout.trim() || `${label} exited with code ${code}`))
    })
  })
}

async function makeInstalledNodePackWritable(targetDir, label) {
  if (process.platform === 'win32') return

  const chmodRecursive = async (entryPath) => {
    let stats
    try {
      stats = await fs.lstat(entryPath)
    } catch (_) {
      return
    }

    if (stats.isSymbolicLink()) return

    try {
      await fs.chmod(entryPath, stats.isDirectory() ? 0o777 : 0o666)
    } catch (error) {
      console.warn(`Could not update permissions for ${label} at ${entryPath}:`, error)
    }

    if (!stats.isDirectory()) return

    let entries = []
    try {
      entries = await fs.readdir(entryPath)
    } catch (error) {
      console.warn(`Could not read installed node pack directory for ${label}:`, error)
      return
    }

    for (const entry of entries) {
      await chmodRecursive(path.join(entryPath, entry))
    }
  }

  await chmodRecursive(targetDir)
}

async function installNodePackTask(task, validation, progressMeta = {}) {
  const label = task?.displayName || task?.id || 'Custom node pack'
  const targetDir = path.join(validation.customNodesPath, task.installDirName)
  const currentTaskIndex = Number(progressMeta.currentTaskIndex) || 0
  const totalTasks = Number(progressMeta.totalTasks) || 0
  const completedTasks = Number(progressMeta.completedTasks) || 0

  emitWorkflowSetupProgress({
    stage: 'node-pack',
    status: 'active',
    taskType: 'node-pack',
    currentLabel: label,
    currentTaskIndex,
    totalTasks,
    completedTasks,
    taskPercent: null,
    overallPercent: getWorkflowSetupOverallPercent({ completedTasks, totalTasks }),
    message: `Installing ${label}...`,
  })

  await fs.mkdir(validation.customNodesPath, { recursive: true })

  if (await isDirectoryPath(targetDir)) {
    if (await isDirectoryPath(path.join(targetDir, '.git'))) {
      await runCommandStreaming({
        command: 'git',
        args: ['-C', targetDir, 'pull', '--ff-only'],
        cwd: validation.normalizedPath,
        label: `Update ${label}`,
      })
    } else {
      await makeInstalledNodePackWritable(targetDir, label)
      emitWorkflowSetupProgress({
        stage: 'node-pack',
        status: 'complete',
        level: 'warning',
        taskType: 'node-pack',
        currentLabel: label,
        currentTaskIndex,
        totalTasks,
        completedTasks: completedTasks + 1,
        taskPercent: 100,
        overallPercent: getWorkflowSetupOverallPercent({ completedTasks: completedTasks + 1, totalTasks }),
        message: `${label}: skipped auto-update because ${targetDir} already exists but is not a git checkout.`,
      })
      return {
        id: task.id,
        displayName: label,
        targetDir,
        skipped: true,
      }
    }
  } else {
    await runCommandStreaming({
      command: 'git',
      args: ['clone', task.repoUrl, targetDir],
      cwd: validation.normalizedPath,
      label: `Install ${label}`,
    })
  }

  if (task.requirementsStrategy === 'requirements-txt') {
    const requirementsPath = path.join(targetDir, 'requirements.txt')
    if (await pathExists(requirementsPath)) {
      if (!validation.python?.command) {
        throw new Error(`Could not find a Python interpreter for ${label}.`)
      }

      await runCommandStreaming({
        command: validation.python.command,
        args: [...(validation.python.baseArgs || []), '-m', 'pip', 'install', '-r', requirementsPath],
        cwd: targetDir,
        label: `${label} requirements`,
      })
    }
  }

  await makeInstalledNodePackWritable(targetDir, label)

  emitWorkflowSetupProgress({
    stage: 'node-pack',
    status: 'complete',
    level: 'success',
    taskType: 'node-pack',
    currentLabel: label,
    currentTaskIndex,
    totalTasks,
    completedTasks: completedTasks + 1,
    taskPercent: 100,
    overallPercent: getWorkflowSetupOverallPercent({ completedTasks: completedTasks + 1, totalTasks }),
    message: `${label}: ready in ${targetDir}`,
  })

  return {
    id: task.id,
    displayName: label,
    targetDir,
    skipped: false,
  }
}

async function downloadFileWithProgress(task, targetPath, progressMeta = {}) {
  const currentLabel = task?.displayName || task?.filename || 'Model'
  const currentTaskIndex = Number(progressMeta.currentTaskIndex) || 0
  const totalTasks = Number(progressMeta.totalTasks) || 0
  const completedTasks = Number(progressMeta.completedTasks) || 0

  if (await pathExists(targetPath)) {
    emitWorkflowSetupProgress({
      stage: 'download',
      status: 'complete',
      level: 'info',
      taskType: 'model',
      currentLabel,
      currentTaskIndex,
      totalTasks,
      completedTasks: completedTasks + 1,
      taskPercent: 100,
      overallPercent: getWorkflowSetupOverallPercent({ completedTasks: completedTasks + 1, totalTasks }),
      message: `${task.filename}: already exists, skipping download.`,
    })
    return {
      filename: task.filename,
      targetPath,
      skipped: true,
      sha256: '',
      bytesDownloaded: 0,
    }
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.download`

  emitWorkflowSetupProgress({
    stage: 'download',
    status: 'active',
    taskType: 'model',
    currentLabel,
    currentTaskIndex,
    totalTasks,
    completedTasks,
    taskPercent: 0,
    bytesDownloaded: 0,
    totalBytes: Number(task.sizeBytes) || 0,
    overallPercent: getWorkflowSetupOverallPercent({ completedTasks, totalTasks, taskPercent: 0 }),
    message: `Downloading ${task.filename}...`,
  })

  let response = null
  try {
    response = await net.fetch(task.downloadUrl)
  } catch (error) {
    throw new Error(`Could not reach ${task.downloadUrl}: ${error.message}`)
  }

  if (!response.ok) {
    throw new Error(`Download failed for ${task.filename} (${response.status} ${response.statusText})`)
  }

  const totalBytes = Number(response.headers.get('content-length') || task.sizeBytes || 0)
  const digest = crypto.createHash('sha256')
  let bytesDownloaded = 0
  let lastProgressAt = 0

  try {
    if (!response.body) {
      const arrayBuffer = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      digest.update(buffer)
      bytesDownloaded = buffer.length
      await fs.writeFile(tempPath, buffer)
    } else {
      await new Promise((resolve, reject) => {
        const fileStream = fsSync.createWriteStream(tempPath)
        const sourceStream = Readable.fromWeb(response.body)

        sourceStream.on('data', (chunk) => {
          bytesDownloaded += chunk.length
          digest.update(chunk)
          const now = Date.now()
          if (now - lastProgressAt < 500 && (!totalBytes || bytesDownloaded < totalBytes)) return
          lastProgressAt = now
          const percent = totalBytes > 0
            ? Math.min(100, Math.round((bytesDownloaded / totalBytes) * 100))
            : `${Math.round(bytesDownloaded / (1024 * 1024))} MB`
          emitWorkflowSetupProgress({
            stage: 'download',
            status: 'active',
            taskType: 'model',
            currentLabel,
            currentTaskIndex,
            totalTasks,
            completedTasks,
            taskPercent: Number.isFinite(percent) ? percent : null,
            bytesDownloaded,
            totalBytes,
            overallPercent: getWorkflowSetupOverallPercent({
              completedTasks,
              totalTasks,
              taskPercent: Number.isFinite(percent) ? percent : null,
            }),
            message: Number.isFinite(percent)
              ? `Downloading ${task.filename}: ${percent}%`
              : `Downloading ${task.filename}: ${percent}`,
          })
        })

        sourceStream.on('error', reject)
        fileStream.on('error', reject)
        fileStream.on('finish', resolve)
        sourceStream.pipe(fileStream)
      })
    }

    const actualSha256 = digest.digest('hex')
    if (task.sha256 && actualSha256 !== String(task.sha256).trim().toLowerCase()) {
      throw new Error(`Checksum mismatch for ${task.filename}. Expected ${task.sha256}, got ${actualSha256}.`)
    }

    await fs.rename(tempPath, targetPath)
    emitWorkflowSetupProgress({
      stage: 'download',
      status: 'complete',
      level: 'success',
      taskType: 'model',
      currentLabel,
      currentTaskIndex,
      totalTasks,
      completedTasks: completedTasks + 1,
      taskPercent: 100,
      bytesDownloaded,
      totalBytes,
      overallPercent: getWorkflowSetupOverallPercent({ completedTasks: completedTasks + 1, totalTasks }),
      message: `${task.filename}: downloaded to ${targetPath}`,
    })

    return {
      filename: task.filename,
      targetPath,
      skipped: false,
      sha256: actualSha256,
      bytesDownloaded,
    }
  } catch (error) {
    try {
      await fs.unlink(tempPath)
    } catch (_) {
      // Ignore temp cleanup failures.
    }
    throw error
  }
}

function normalizeFrameUrlForComparison(value) {
  try {
    const parsed = new URL(String(value || ''))
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '')
  } catch {
    return String(value || '').trim().replace(/\/+$/, '')
  }
}

function collectFrameTree(frame, output = []) {
  if (!frame) return output
  output.push(frame)
  const children = Array.isArray(frame.frames) ? frame.frames : []
  for (const child of children) {
    collectFrameTree(child, output)
  }
  return output
}

function getMainWindowFrames() {
  if (!mainWindow || mainWindow.isDestroyed()) return []
  const rootFrame = mainWindow.webContents?.mainFrame
  if (!rootFrame) return []

  if (Array.isArray(rootFrame.framesInSubtree) && rootFrame.framesInSubtree.length > 0) {
    const seen = new Set()
    const frames = [rootFrame, ...rootFrame.framesInSubtree].filter((frame) => {
      if (!frame) return false
      const dedupeKey = `${frame.routingId ?? ''}:${frame.processId ?? ''}:${frame.url ?? ''}`
      if (seen.has(dedupeKey)) return false
      seen.add(dedupeKey)
      return true
    })
    return frames
  }

  return collectFrameTree(rootFrame, [])
}

async function findEmbeddedComfyFrame(comfyBaseUrl, timeoutMs = 12000) {
  const normalizedBase = normalizeFrameUrlForComparison(comfyBaseUrl)
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    const frame = getMainWindowFrames().find((candidate) => {
      const candidateUrl = normalizeFrameUrlForComparison(candidate?.url)
      return candidateUrl && normalizedBase && candidateUrl.startsWith(normalizedBase)
    })

    if (frame) return frame
    await delay(250)
  }

  return null
}

async function loadWorkflowGraphInEmbeddedComfy({ workflowGraph, comfyBaseUrl, waitForMs = 12000 }) {
  const frame = await findEmbeddedComfyFrame(comfyBaseUrl, waitForMs)
  if (!frame) {
    throw new Error('Could not locate the embedded ComfyUI tab. Enable the ComfyUI tab and make sure the local server is running.')
  }

  const script = `
    (async () => {
      const graphData = ${JSON.stringify(workflowGraph)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const ensureCanvasVisible = async (appInstance) => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const canvasEl = appInstance?.canvasEl || appInstance?.canvas?.canvas || document.querySelector('canvas');
          const rect = canvasEl?.getBoundingClientRect?.();
          if (rect && rect.width > 0 && rect.height > 0) {
            return true;
          }
          await sleep(100);
        }
        return false;
      };

      let comfyApp = globalThis.app || globalThis.__COMFYUI_APP__ || null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!comfyApp) {
          try {
            const appModule = await import('/scripts/app.js');
            comfyApp = appModule?.app || globalThis.app || globalThis.__COMFYUI_APP__ || null;
          } catch (_) {
            // Ignore temporary frontend boot timing failures and keep polling.
          }
        }

        if (comfyApp?.loadGraphData) break;
        await sleep(250);
        comfyApp = comfyApp || globalThis.app || globalThis.__COMFYUI_APP__ || null;
      }

      if (!comfyApp?.loadGraphData) {
        return { success: false, error: 'ComfyUI frontend app is not ready yet.' };
      }

      try {
        const canvasVisible = await ensureCanvasVisible(comfyApp);
        if (!canvasVisible) {
          return { success: false, error: 'ComfyUI canvas is still hidden, so the workflow could not be loaded safely yet.' };
        }

        await comfyApp.loadGraphData(graphData);
        await sleep(0);
        if (comfyApp.canvas?.resize) {
          comfyApp.canvas.resize();
        }
        if (comfyApp.canvas?.setDirty) {
          comfyApp.canvas.setDirty(true, true);
        }
        if (comfyApp.canvas?.draw) {
          comfyApp.canvas.draw(true, true);
        }
        return { success: true };
      } catch (error) {
        return { success: false, error: error?.message || String(error) };
      }
    })()
  `

  const result = await frame.executeJavaScript(script, true)
  if (!result?.success) {
    throw new Error(result?.error || 'ComfyUI refused to load the workflow graph.')
  }

  return result
}

async function detectFfmpegEncoders(binaryPath) {
  if (!binaryPath) {
    return { success: false, output: '', error: 'FFmpeg binary not available.' }
  }
  return await new Promise((resolve) => {
    const ffmpeg = spawn(binaryPath, ['-hide_banner', '-encoders'], { windowsHide: true })
    let output = ''

    ffmpeg.stdout.on('data', (data) => {
      output += data.toString()
    })
    ffmpeg.stderr.on('data', (data) => {
      output += data.toString()
    })
    ffmpeg.on('error', (err) => {
      resolve({ success: false, output, error: err.message })
    })
    ffmpeg.on('close', () => {
      resolve({ success: true, output, error: '' })
    })
  })
}

async function refreshPreferredFfmpegPath() {
  const bundled = await detectFfmpegEncoders(bundledFfmpegPath)
  const bundledHasNvenc = bundled.output.includes('h264_nvenc') || bundled.output.includes('hevc_nvenc')
  if (bundled.success && bundledHasNvenc) {
    preferredFfmpegPath = bundledFfmpegPath
    preferredFfmpegSource = 'bundled'
    return
  }

  for (const candidate of systemFfmpegCandidates) {
    if (!candidate || candidate === bundledFfmpegPath) continue
    const result = await detectFfmpegEncoders(candidate)
    if (!result.success) continue
    if (result.output.includes('h264_nvenc') || result.output.includes('hevc_nvenc')) {
      preferredFfmpegPath = candidate
      preferredFfmpegSource = candidate === 'ffmpeg' || candidate === 'ffmpeg.exe' ? 'system PATH' : 'system'
      console.log(`[Export] Using NVENC-capable FFmpeg from ${preferredFfmpegSource}: ${candidate}`)
      return
    }
  }

  preferredFfmpegPath = bundledFfmpegPath
  preferredFfmpegSource = 'bundled'
}

async function detectNvidiaGpuName() {
  const commands = process.platform === 'win32'
    ? [{
        command: 'powershell.exe',
        args: ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'],
      }]
    : [{
        command: 'nvidia-smi',
        args: ['--query-gpu=name', '--format=csv,noheader'],
      }]

  for (const candidate of commands) {
    const result = await captureCommandOutput(candidate.command, candidate.args)
    if (!result.success || !result.output) continue

    const names = result.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    const nvidiaName = names.find((name) => /nvidia|geforce|rtx|gtx|quadro|tesla/i.test(name))
    if (nvidiaName) return nvidiaName
  }

  return null
}

function sanitizeLocalComfyPort(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return null
  if (parsed < 1 || parsed > 65535) return null
  return parsed
}

async function resolveLocalComfyPort() {
  try {
    const data = await fs.readFile(settingsPath, 'utf8')
    const settings = JSON.parse(data)
    const raw = settings?.[COMFY_CONNECTION_SETTING_KEY]
    const rawPort = raw && typeof raw === 'object' ? raw.port : raw
    return sanitizeLocalComfyPort(rawPort) || DEFAULT_LOCAL_COMFY_PORT
  } catch {
    return DEFAULT_LOCAL_COMFY_PORT
  }
}

async function checkComfyUIRunning(portOverride = null) {
  const port = sanitizeLocalComfyPort(portOverride) || await resolveLocalComfyPort()
  const healthUrl = `http://127.0.0.1:${port}/system_stats`
  return new Promise((resolve) => {
    const req = http.get(healthUrl, (res) => {
      resolve({
        ok: res.statusCode === 200 || (res.statusCode >= 200 && res.statusCode < 400),
        port,
      })
    })
    req.on('error', () => resolve({ ok: false, port }))
    req.setTimeout(COMFYUI_CHECK_MS, () => {
      req.destroy()
      resolve({ ok: false, port })
    })
  })
}

// ============================================
// ComfyUI launcher (process manager)
// ============================================

const COMFY_ROOT_SETTING_KEY = 'comfyRootPath'
const launcherLogDir = path.join(app.getPath('userData'), 'logs')
let cachedLauncherConfig = safeCloneLauncherConfig(DEFAULT_LAUNCHER_CONFIG)
let cachedHttpBase = `http://127.0.0.1:${DEFAULT_LOCAL_COMFY_PORT}`
let launcherQuitConfirmed = false

async function readSettingsRaw() {
  try {
    const data = await fs.readFile(settingsPath, 'utf8')
    return JSON.parse(data)
  } catch {
    return {}
  }
}

async function writeSettingsRaw(mutator) {
  const writeOperation = settingsWriteQueue
    .catch(() => {})
    .then(async () => {
      const current = await readSettingsRaw()
      const mutated = typeof mutator === 'function' ? mutator(current) : current
      const next = mutated && typeof mutated === 'object' && !Array.isArray(mutated) ? mutated : {}
      await writeFileAtomic(settingsPath, JSON.stringify(next, null, 2), 'utf8')
      return next
    })
  settingsWriteQueue = writeOperation.then(() => {}, () => {})
  return writeOperation
}

async function refreshSettingsDependentCaches() {
  try {
    await refreshLauncherConfigCache()
  } catch (error) {
    console.warn('[settings] failed to refresh dependent caches:', error?.message || error)
  }
}

async function refreshLauncherConfigCache() {
  const settings = await readSettingsRaw()
  cachedLauncherConfig = safeCloneLauncherConfig(settings?.[LAUNCHER_SETTING_KEY])
  const port = sanitizeLocalComfyPort(
    settings?.[COMFY_CONNECTION_SETTING_KEY]?.port
    ?? settings?.[COMFY_CONNECTION_SETTING_KEY]
  ) || DEFAULT_LOCAL_COMFY_PORT
  cachedHttpBase = `http://127.0.0.1:${port}`
  return { config: cachedLauncherConfig, httpBase: cachedHttpBase, comfyRootPath: settings?.[COMFY_ROOT_SETTING_KEY] || '' }
}

const comfyLauncher = new ComfyLauncher({
  logDir: launcherLogDir,
  stateFilePath: path.join(app.getPath('userData'), 'comfy-launcher.state.json'),
  getHttpBase: () => cachedHttpBase,
  getConfig: () => cachedLauncherConfig,
  setConfig: async (partial) => {
    await writeSettingsRaw((settings) => ({
      ...settings,
      [LAUNCHER_SETTING_KEY]: safeCloneLauncherConfig({ ...cachedLauncherConfig, ...(partial || {}) }),
    }))
    await refreshLauncherConfigCache()
    return cachedLauncherConfig
  },
  getComfyRootPath: async () => (await readSettingsRaw())?.[COMFY_ROOT_SETTING_KEY] || '',
})

function broadcast(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload)
    }
  } catch (_) {
    /* ignore send errors during shutdown */
  }
}

comfyLauncher.on('state', (state) => {
  broadcast('comfyLauncher:state', state)
})
comfyLauncher.on('log', (entry) => {
  broadcast('comfyLauncher:log', entry)
})

async function initComfyLauncher() {
  await refreshLauncherConfigCache()
  await comfyLauncher.init()
}

async function maybeAutoStartComfyLauncher() {
  try {
    const config = cachedLauncherConfig
    if (!config?.autoStart) return
    if (!config.launcherScript) return
    const state = comfyLauncher.getState()
    if (state.state === 'external' || state.state === 'starting' || state.state === 'running') return
    const result = await comfyLauncher.start()
    if (result?.success === false) {
      console.warn('[comfyLauncher] auto-start failed:', result.error)
    }
  } catch (error) {
    console.warn('[comfyLauncher] auto-start error:', error?.message || error)
  }
}

async function runStartupChecks() {
  const start = Date.now()
  if (!splashWindow || splashWindow.isDestroyed()) return

  const comfyPort = await resolveLocalComfyPort()
  setSplashStatus(`Checking ComfyUI on localhost:${comfyPort}…`)
  const comfyCheck = await checkComfyUIRunning(comfyPort)
  if (comfyCheck.ok) {
    setSplashStatus(`ComfyUI connected (localhost:${comfyCheck.port})`)
  } else {
    setSplashStatus(`ComfyUI not detected on localhost:${comfyCheck.port}`)
  }
  await delay(STEP_DELAY_MS)

  setSplashStatus('Loading project page…')
  await delay(STEP_DELAY_MS)
  setSplashStatus('Loading media page…')
  await delay(STEP_DELAY_MS)
  setSplashStatus('Loading workspace…')
  await delay(STEP_DELAY_MS)

  const elapsed = Date.now() - start
  const remaining = Math.max(0, SPLASH_MIN_DURATION_MS - elapsed)
  if (remaining > 0) {
    await delay(remaining)
  }
}

// ============================================
// Window Controls
// ============================================

ipcMain.handle('window:minimize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false

  restoreFullscreenAfterMinimize = mainWindow.isFullScreen()
  if (!restoreFullscreenAfterMinimize) {
    mainWindow.minimize()
    return true
  }

  const minimizeAfterLeavingFullscreen = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return
    mainWindow.minimize()
  }

  mainWindow.once('leave-full-screen', minimizeAfterLeavingFullscreen)
  mainWindow.setFullScreen(false)
  setTimeout(minimizeAfterLeavingFullscreen, 150)
  return true
})

ipcMain.handle('window:toggleMaximize', () => {
  if (!mainWindow) return false
  if (mainWindow.isFullScreen()) {
    mainWindow.setFullScreen(false)
  } else if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow.maximize()
  }
  return true
})

ipcMain.handle('window:close', () => {
  if (mainWindow) {
    mainWindow.close()
  }
  return true
})

ipcMain.handle('window:isMaximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false
})

ipcMain.handle('window:getState', () => {
  return getWindowState()
})

ipcMain.handle('window:toggleFullScreen', () => {
  if (!mainWindow) return false
  mainWindow.setFullScreen(!mainWindow.isFullScreen())
  return true
})

// Register custom protocol for serving local files
function registerFileProtocol() {
  protocol.handle('comfystudio', async (request) => {
    const url = request.url.replace('comfystudio://', '')
    const filePath = decodeURIComponent(url)
    
    try {
      // Security: Only allow access to files within user's documents or app paths
      const normalizedPath = path.normalize(filePath)
      
      return net.fetch(`file://${normalizedPath}`)
    } catch (err) {
      console.error('Protocol error:', err)
      return new Response('File not found', { status: 404 })
    }
  })
}

function createSplashWindow() {
  const splashPath = isDev
    ? path.join(__dirname, '../public/splash.html')
    : path.join(__dirname, '../dist/splash.html')
  // Match your splash image aspect ratio (1632×656); extra height for status bar
  const SPLASH_ASPECT = 1632 / 656
  const splashWidth = 1200
  const statusBarHeight = 44
  const splashHeight = Math.round(splashWidth / SPLASH_ASPECT) + statusBarHeight
  splashWindow = new BrowserWindow({
    width: splashWidth,
    height: splashHeight,
    icon: iconPath,
    backgroundColor: '#0a0a0b',
    frame: false,
    transparent: false,
    center: true,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  splashWindow.loadFile(splashPath)
  splashWindow.on('closed', () => {
    splashWindow = null
  })
  return splashWindow
}

async function createWindow() {
  const restoredWindowState = await getRestoredMainWindowState()
  mainWindow = new BrowserWindow({
    ...restoredWindowState.bounds,
    minWidth: 1200,
    minHeight: 800,
    icon: iconPath,
    backgroundColor: '#0a0a0b',
    titleBarStyle: 'hiddenInset',
    frame: process.platform === 'darwin' ? true : false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // In dev mode, disable web security to allow file:// URLs from localhost
      // In production, the app loads from file:// so this isn't an issue
      webSecurity: !isDev,
    }
  })

  // Start maximized rather than true fullscreen. Maximized uses the full
  // work area (entire screen minus the OS taskbar/dock) so the user still
  // has access to their taskbar, tray, notifications, and Alt-Tab without
  // having to exit the app. True fullscreen (the old behavior via
  // setFullScreen(true)) hid the taskbar entirely, which users reported as
  // too intrusive for a window they're not actively playing back from.
  // Users who want edge-to-edge can still toggle fullscreen via the
  // title-bar control or the window:toggleFullScreen IPC.
  if (restoredWindowState.isMaximized) {
    mainWindow.maximize()
  }

  // Route every external link to the user's default browser instead of
  // letting Electron spawn an in-app BrowserWindow. This covers:
  //   - window.open(url, '_blank', ...)
  //   - <a href="..." target="_blank">
  //   - plain navigations that target an http(s) URL outside our app bundle.
  //
  // Safe because we only hand off http(s), mailto, and file URLs:
  //   - http(s)/mailto go through shell.openExternal (default browser / mail).
  //   - file:// URLs come from our own project-relative exports (e.g. the
  //     "Create Storyboard PDF" button, which writes the PDF into the
  //     project's Images folder and then asks the OS to preview it). These
  //     go through shell.openPath which opens the file in the user's default
  //     associated app (PDF viewer for .pdf, image viewer for images, etc.).
  //     Anything else is denied.
  {
    const { shell } = require('electron')
    const isSafeExternalUrl = (url) => /^(https?:|mailto:)/i.test(String(url || ''))
    const isLocalFileUrl = (url) => /^file:/i.test(String(url || ''))

    // Resolve a file:// URL back to an OS-native path. We URL-decode first so
    // percent-escapes (spaces, non-ASCII filenames) round-trip correctly, then
    // strip the scheme + leading slashes. On Windows the URL looks like
    // "file:///C:/..." so we end up with "C:/..."; on POSIX it's
    // "file:///Users/..." which stays "/Users/...". shell.openPath handles
    // both forms natively.
    const fileUrlToPath = (url) => {
      try {
        const decoded = decodeURI(String(url || '').trim())
        let path = decoded.replace(/^file:\/+/i, '')
        if (/^[A-Za-z]:/.test(path)) return path // Windows drive letter
        return `/${path}` // POSIX — restore the leading slash we stripped
      } catch (_) {
        return ''
      }
    }

    const handoffExternalUrl = (url) => {
      if (isSafeExternalUrl(url)) {
        shell.openExternal(url).catch((err) => {
          console.warn('[shell.openExternal] failed:', err?.message || err)
        })
        return true
      }
      if (isLocalFileUrl(url)) {
        const filePath = fileUrlToPath(url)
        if (!filePath) return false
        shell.openPath(filePath).then((result) => {
          // shell.openPath resolves with an error string (truthy on failure),
          // not a throw — log it so a broken association doesn't silently fail.
          if (result) {
            console.warn('[shell.openPath] failed:', result, 'path=', filePath)
          }
        }).catch((err) => {
          console.warn('[shell.openPath] threw:', err?.message || err)
        })
        return true
      }
      return false
    }

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      handoffExternalUrl(url)
      return { action: 'deny' }
    })

    mainWindow.webContents.on('will-navigate', (event, url) => {
      // Only intercept real external URLs — let in-app navigations
      // (localhost dev server, file:// bundled assets) through untouched.
      if (!isSafeExternalUrl(url)) return
      try {
        const currentUrl = mainWindow.webContents.getURL()
        const nextOrigin = new URL(url).origin
        const currentOrigin = currentUrl ? new URL(currentUrl).origin : ''
        if (nextOrigin && nextOrigin === currentOrigin) return
      } catch (_) {
        // If URL parsing fails, fall through to the external handoff.
      }
      event.preventDefault()
      shell.openExternal(url).catch((err) => {
        console.warn('[shell.openExternal] failed:', err?.message || err)
      })
    })
  }

  // Load the app
  if (isDev) {
    // Try common Vite ports in case 5173 is in use
    const tryPorts = [5173, 5174, 5175, 5176]
    let loaded = false
    
    for (const port of tryPorts) {
      try {
        await mainWindow.loadURL(`http://127.0.0.1:${port}`)
        console.log(`Loaded from port ${port}`)
        loaded = true
        break
      } catch (err) {
        console.log(`Port ${port} not available, trying next...`)
      }
    }
    
    if (!loaded) {
      console.error('Could not connect to Vite dev server on any port')
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
  
  mainWindow.on('close', async (event) => {
    if (launcherQuitConfirmed) return
    const state = comfyLauncher.getState()
    const ownsRunning = state.ownership === 'ours' && (state.state === 'running' || state.state === 'starting')
    if (!ownsRunning) return

    event.preventDefault()
    try {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Stop ComfyUI & quit', 'Leave ComfyUI running', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'Quit ComfyStudio?',
        message: 'ComfyUI is still running.',
        detail: 'ComfyStudio started ComfyUI. Choose what happens to it when you quit.\n\n• Stop ComfyUI & quit — shuts down ComfyUI and cancels any in-flight generation jobs.\n• Leave ComfyUI running — ComfyStudio will quit but ComfyUI stays up. Handy when you\'re just relaunching ComfyStudio and don\'t want to wait for ComfyUI to boot again.',
      })
      if (choice.response === 2) return
      launcherQuitConfirmed = true
      try {
        if (choice.response === 1) {
          await comfyLauncher.detach()
        } else {
          await comfyLauncher.shutdown({ confirmStop: true })
        }
      } catch (error) {
        console.warn('[comfyLauncher] shutdown/detach during close failed:', error?.message || error)
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close()
      } else {
        app.quit()
      }
    } catch (error) {
      console.warn('[comfyLauncher] close handler error:', error?.message || error)
    }
  })

  mainWindow.on('closed', () => {
    if (mainWindowStateSaveTimer) {
      clearTimeout(mainWindowStateSaveTimer)
      mainWindowStateSaveTimer = null
    }
    mainWindow = null
  })

  mainWindow.on('restore', () => {
    if (!restoreFullscreenAfterMinimize) return
    restoreFullscreenAfterMinimize = false
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.setFullScreen(true)
    }, 0)
  })

  mainWindow.on('move', scheduleSaveMainWindowState)
  mainWindow.on('resize', scheduleSaveMainWindowState)
  mainWindow.on('maximize', () => {
    sendWindowState()
    scheduleSaveMainWindowState()
  })
  mainWindow.on('unmaximize', () => {
    sendWindowState()
    scheduleSaveMainWindowState()
  })
  mainWindow.on('enter-full-screen', sendWindowState)
  mainWindow.on('leave-full-screen', sendWindowState)
  mainWindow.on('close', () => {
    if (mainWindowStateSaveTimer) {
      clearTimeout(mainWindowStateSaveTimer)
      mainWindowStateSaveTimer = null
    }
    saveMainWindowStateNow()
  })
  
  // Register keyboard shortcut for DevTools (F12 or Ctrl+Shift+I)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || 
        (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools()
      event.preventDefault()
    }
  })
}

// ============================================
// IPC Handlers - Dialog Operations
// ============================================

ipcMain.handle('dialog:selectDirectory', async (event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: options.title || 'Select Folder',
    defaultPath: options.defaultPath || app.getPath('documents'),
  })
  
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  
  return result.filePaths[0]
})

ipcMain.handle('dialog:selectFile', async (event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', ...(options.multiple ? ['multiSelections'] : [])],
    title: options.title || 'Select File',
    defaultPath: options.defaultPath || app.getPath('documents'),
    filters: options.filters || [
      { name: 'Media Files', extensions: ['mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'jpg', 'jpeg', 'png', 'gif', 'webp'] },
      { name: 'All Files', extensions: ['*'] }
    ],
  })
  
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  
  return options.multiple ? result.filePaths : result.filePaths[0]
})

ipcMain.handle('dialog:saveFile', async (event, options = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title || 'Save File',
    defaultPath: options.defaultPath || app.getPath('documents'),
    filters: options.filters || [
      { name: 'All Files', extensions: ['*'] }
    ],
  })
  
  if (result.canceled) {
    return null
  }
  
  return result.filePath
})

// ============================================
// IPC Handlers - File System Operations
// ============================================

ipcMain.handle('fs:exists', async (event, filePath) => {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
})

ipcMain.handle('fs:isDirectory', async (event, filePath) => {
  try {
    const stat = await fs.stat(filePath)
    return stat.isDirectory()
  } catch {
    return false
  }
})

ipcMain.handle('fs:createDirectory', async (event, dirPath, options = {}) => {
  try {
    await fs.mkdir(dirPath, { recursive: options.recursive !== false })
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:readFile', async (event, filePath, options = {}) => {
  try {
    const encoding = options.encoding || null // null returns Buffer
    const data = await fs.readFile(filePath, encoding)
    
    // If no encoding specified, return as base64 for binary files
    if (!encoding) {
      return { success: true, data: data.toString('base64'), encoding: 'base64' }
    }
    
    return { success: true, data, encoding }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:readFileAsBuffer', async (event, filePath) => {
  try {
    const data = await fs.readFile(filePath)
    const slice = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    return { success: true, data: slice }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:writeFile', async (event, filePath, data, options = {}) => {
  try {
    // Handle different data types
    let writeData = data
    if (options.encoding === 'base64') {
      writeData = Buffer.from(data, 'base64')
    } else if (typeof data === 'object' && !Buffer.isBuffer(data)) {
      // JSON object
      writeData = JSON.stringify(data, null, 2)
    }

    await writeFileAtomic(filePath, writeData, options.encoding === 'base64' ? null : options)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:writeFileFromArrayBuffer', async (event, filePath, arrayBuffer) => {
  try {
    const buffer = Buffer.from(arrayBuffer)
    await writeFileAtomic(filePath, buffer)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:deleteFile', async (event, filePath) => {
  try {
    await fs.unlink(filePath)
    return { success: true }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { success: true } // Already deleted
    }
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:deleteDirectory', async (event, dirPath, options = {}) => {
  try {
    await fs.rm(dirPath, { recursive: options.recursive !== false, force: true })
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:trashItem', async (event, itemPath) => {
  try {
    if (!itemPath || typeof itemPath !== 'string') {
      return { success: false, error: 'No path provided' }
    }
    await shell.trashItem(itemPath)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:copyFile', async (event, srcPath, destPath) => {
  try {
    // Ensure destination directory exists
    const dir = path.dirname(destPath)
    await fs.mkdir(dir, { recursive: true })
    
    await fs.copyFile(srcPath, destPath)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:moveFile', async (event, srcPath, destPath) => {
  try {
    // Ensure destination directory exists
    const dir = path.dirname(destPath)
    await fs.mkdir(dir, { recursive: true })
    
    await fs.rename(srcPath, destPath)
    return { success: true }
  } catch (err) {
    // If rename fails (cross-device), fall back to copy + delete
    if (err.code === 'EXDEV') {
      await fs.copyFile(srcPath, destPath)
      await fs.unlink(srcPath)
      return { success: true }
    }
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:listDirectory', async (event, dirPath, options = {}) => {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    
    const items = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name)
      let stat = null
      
      if (options.includeStats) {
        try {
          stat = await fs.stat(fullPath)
        } catch {
          // Ignore stat errors
        }
      }
      
      return {
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        size: stat?.size,
        modified: stat?.mtime?.toISOString(),
        created: stat?.birthtime?.toISOString(),
      }
    }))
    
    return { success: true, items }
  } catch (err) {
    return { success: false, error: err.message, items: [] }
  }
})

ipcMain.handle('fs:getFileInfo', async (event, filePath) => {
  try {
    const stat = await fs.stat(filePath)
    return {
      success: true,
      info: {
        name: path.basename(filePath),
        path: filePath,
        size: stat.size,
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        modified: stat.mtime.toISOString(),
        created: stat.birthtime.toISOString(),
      }
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ============================================
// IPC Handlers - Path Operations
// ============================================

ipcMain.handle('path:join', (event, ...parts) => {
  return path.join(...parts)
})

ipcMain.handle('path:dirname', (event, filePath) => {
  return path.dirname(filePath)
})

ipcMain.handle('path:basename', (event, filePath, ext) => {
  return path.basename(filePath, ext)
})

ipcMain.handle('path:extname', (event, filePath) => {
  return path.extname(filePath)
})

ipcMain.handle('path:normalize', (event, filePath) => {
  return path.normalize(filePath)
})

ipcMain.handle('path:getAppPath', (event, name) => {
  // Valid names: home, appData, userData, documents, downloads, music, pictures, videos, temp
  return app.getPath(name)
})

// Cheap synchronous existence check. Used by the proxy bulk flow to avoid
// spawning ffmpeg on assets whose source file is missing on disk, and by
// the UI coverage counter to classify broken-link assets as "unavailable"
// instead of hopelessly re-trying them as "missing" forever.
ipcMain.handle('path:exists', (event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return false
  try {
    return fsSync.existsSync(filePath)
  } catch {
    return false
  }
})

// ============================================
// IPC Handlers - Media Info (using HTML5 in renderer for now)
// Future: Replace with FFprobe for frame-accurate info
// ============================================

ipcMain.handle('media:getFileUrl', (event, filePath) => {
  // Convert file path to comfystudio:// protocol URL
  const encodedPath = encodeURIComponent(filePath)
  return `comfystudio://${encodedPath}`
})

ipcMain.handle('media:getFileUrlDirect', (event, filePath) => {
  // Return file:// URL directly (for when protocol isn't working)
  // Normalize path for URL
  let normalizedPath = filePath.replace(/\\/g, '/')
  if (!normalizedPath.startsWith('/')) {
    normalizedPath = '/' + normalizedPath
  }
  return `file://${normalizedPath}`
})

ipcMain.handle('media:createImageThumbnail', async (event, { sourcePath, outputPath, width = 360, height = 204, quality = 78 } = {}) => {
  try {
    if (!sourcePath || !outputPath) {
      return { success: false, error: 'Missing source or output path.' }
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const sourceImage = nativeImage.createFromPath(sourcePath)
    if (sourceImage.isEmpty()) {
      return { success: false, error: 'Could not load source image.' }
    }
    const sourceSize = sourceImage.getSize()
    const maxWidth = Math.max(1, Math.round(Number(width) || 360))
    const maxHeight = Math.max(1, Math.round(Number(height) || 204))
    const scale = Math.min(1, maxWidth / Math.max(1, sourceSize.width), maxHeight / Math.max(1, sourceSize.height))
    const targetWidth = Math.max(1, Math.round(sourceSize.width * scale))
    const targetHeight = Math.max(1, Math.round(sourceSize.height * scale))
    const resized = scale < 1
      ? sourceImage.resize({ width: targetWidth, height: targetHeight, quality: 'good' })
      : sourceImage
    const jpeg = resized.toJPEG(Math.max(1, Math.min(100, Math.round(Number(quality) || 78))))
    await writeFileAtomic(outputPath, jpeg)
    return {
      success: true,
      path: outputPath,
      width: targetWidth,
      height: targetHeight,
      sourceWidth: sourceSize.width,
      sourceHeight: sourceSize.height,
    }
  } catch (err) {
    return { success: false, error: err?.message || String(err) }
  }
})

ipcMain.handle('media:getVideoFps', async (event, filePath) => {
  if (!ffprobePath) {
    return { success: false, error: 'FFprobe binary not available.' }
  }

  const parseFps = (value) => {
    if (!value || value === '0/0') return null
    const [num, den] = String(value).split('/').map(Number)
    if (!den || !num) return null
    return num / den
  }

  return await new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,avg_frame_rate,r_frame_rate',
      '-of', 'json',
      filePath
    ]

    const proc = spawn(ffprobePath, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    proc.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ success: false, error: stderr || `FFprobe exited with code ${code}` })
        return
      }
      try {
        const parsed = JSON.parse(stdout)
        const streams = Array.isArray(parsed?.streams) ? parsed.streams : []
        const videoStream = streams.find((stream) => stream?.codec_type === 'video') || null
        const audioStream = streams.find((stream) => stream?.codec_type === 'audio') || null
        const fps = parseFps(videoStream?.avg_frame_rate) || parseFps(videoStream?.r_frame_rate)
        const hasAudio = streams.some((stream) => stream?.codec_type === 'audio')
        resolve({
          success: true,
          fps: fps || null,
          hasAudio,
          videoCodec: videoStream?.codec_name || null,
          audioCodec: audioStream?.codec_name || null,
        })
      } catch (err) {
        resolve({ success: false, error: err.message })
      }
    })
  })
})

const audioWaveformCache = new Map()

function resolveMediaInputPath(mediaInput) {
  if (!mediaInput || typeof mediaInput !== 'string') return null
  if (mediaInput.startsWith('comfystudio://')) {
    return decodeURIComponent(mediaInput.replace('comfystudio://', ''))
  }
  if (mediaInput.startsWith('file://')) {
    try {
      return fileURLToPath(mediaInput)
    } catch (_) {
      // Fallback for unusual path encodings
      let normalizedPath = mediaInput.replace('file://', '')
      normalizedPath = decodeURIComponent(normalizedPath)
      if (/^\/[a-zA-Z]:\//.test(normalizedPath)) {
        normalizedPath = normalizedPath.slice(1)
      }
      return normalizedPath.replace(/\//g, path.sep)
    }
  }
  return mediaInput
}

ipcMain.handle('media:getAudioWaveform', async (event, mediaInput, options = {}) => {
  if (!getFfmpegPath()) {
    return { success: false, error: 'FFmpeg binary not available.' }
  }

  const filePath = resolveMediaInputPath(mediaInput)
  if (!filePath) {
    return { success: false, error: 'Invalid audio input path.' }
  }

  const sampleCount = Math.max(128, Math.min(8192, Math.round(Number(options?.sampleCount) || 4096)))
  const sampleRate = Math.max(400, Math.min(6000, Math.round(Number(options?.sampleRate) || 2000)))

  let stat
  try {
    stat = await fs.stat(filePath)
  } catch (err) {
    return { success: false, error: `Audio file not found: ${err.message}` }
  }

  const cacheKey = `${filePath}|${sampleCount}|${sampleRate}|${stat.mtimeMs}`
  if (audioWaveformCache.has(cacheKey)) {
    return { success: true, ...audioWaveformCache.get(cacheKey) }
  }

  return await new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-i', filePath,
      '-vn',
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 'f32le',
      'pipe:1',
    ]

    const proc = spawn(getFfmpegPath(), args, { windowsHide: true })
    const chunks = []
    let stderr = ''

    proc.stdout.on('data', (data) => {
      chunks.push(Buffer.from(data))
    })
    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    proc.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ success: false, error: stderr || `FFmpeg exited with code ${code}` })
        return
      }

      try {
        const raw = Buffer.concat(chunks)
        const floatCount = Math.floor(raw.length / 4)
        if (floatCount <= 0) {
          resolve({ success: false, error: 'No audio samples decoded.' })
          return
        }

        const bucketCount = sampleCount
        const bucketSize = Math.max(1, Math.floor(floatCount / bucketCount))
        const peaks = new Array(bucketCount).fill(0)
        let maxPeak = 0

        for (let i = 0; i < bucketCount; i++) {
          const start = i * bucketSize
          const end = i === bucketCount - 1 ? floatCount : Math.min(floatCount, start + bucketSize)
          const span = Math.max(1, end - start)
          const stride = Math.max(1, Math.floor(span / 96))

          let peak = 0
          for (let s = start; s < end; s += stride) {
            const amp = Math.abs(raw.readFloatLE(s * 4))
            if (amp > peak) peak = amp
          }

          peaks[i] = peak
          if (peak > maxPeak) maxPeak = peak
        }

        if (maxPeak > 0) {
          for (let i = 0; i < peaks.length; i++) {
            peaks[i] = peaks[i] / maxPeak
          }
        }

        const result = {
          peaks,
          duration: floatCount / sampleRate,
        }
        audioWaveformCache.set(cacheKey, result)
        resolve({ success: true, ...result })
      } catch (err) {
        resolve({ success: false, error: err.message })
      }
    })
  })
})

// Mix the full timeline's program audio (video-embedded audio + audio clips) into
// a single mono 16 kHz WAV file using FFmpeg in the main process. This exists as
// a dedicated handler (not part of export:mixAudio) because:
//   1. export:mixAudio only accepts clips whose type === 'audio', skipping video
//      audio — but transcription needs the dialogue on video clips.
//   2. Doing the mix in the renderer via decodeAudioData() on multi-hundred-MB
//      mp4 files reliably OOMs Chromium (renderer goes black). FFmpeg demuxes
//      the audio stream without decoding video, so memory stays flat.
ipcMain.handle('captions:mixTimelineAudio', async (event, options = {}) => {
  if (!getFfmpegPath()) {
    return { success: false, error: 'FFmpeg binary not available.' }
  }

  const {
    projectPath = '',
    clips = [],
    tracks = [],
    assets = [],
    duration: requestedDuration = 0,
    sampleRate = 16000,
    timeoutMs = 180000,
  } = options

  const programDuration = Math.max(0, Number(requestedDuration) || 0)
  if (programDuration <= 0.001) {
    return { success: false, error: 'Timeline duration is zero — nothing to mix.' }
  }

  const trackMap = new Map((tracks || []).map((track) => [track.id, track]))
  const assetMap = new Map((assets || []).map((asset) => [asset.id, asset]))
  const preparedInputs = []

  // Diagnostic: per-clip include/skip decision. Logged at the end so we can
  // eyeball exactly which clips the mixer pulled in when captions show text
  // for a clip the user thought was silenced.
  const decisions = []
  const skip = (clip, reason) => {
    decisions.push({
      clipId: clip?.id,
      type: clip?.type,
      trackId: clip?.trackId,
      decision: 'skip',
      reason,
    })
  }

  for (const clip of clips || []) {
    if (!clip) continue
    if (clip.type !== 'video' && clip.type !== 'audio') { skip(clip, `type=${clip.type}`); continue }
    if (clip.enabled === false) { skip(clip, 'clip.enabled=false'); continue }

    const track = trackMap.get(clip.trackId)
    if (!track) { skip(clip, 'no-matching-track'); continue }
    if (track.muted) { skip(clip, 'track.muted=true'); continue }
    if (track.visible === false) { skip(clip, 'track.visible=false'); continue }

    const asset = assetMap.get(clip.assetId)
    if (!asset) { skip(clip, 'no-matching-asset'); continue }
    if (asset.hasAudio === false) { skip(clip, 'asset.hasAudio=false'); continue }
    if (asset.audioEnabled === false) { skip(clip, 'asset.audioEnabled=false'); continue }
    if (clip.audioEnabled === false) { skip(clip, 'clip.audioEnabled=false'); continue }
    if (clip.reverse) { skip(clip, 'clip.reverse=true'); continue }

    let inputPath = null
    if (asset.path && projectPath) {
      inputPath = path.join(projectPath, asset.path)
    }
    if (!inputPath && asset.absolutePath) {
      inputPath = asset.absolutePath
    }
    if (!inputPath && asset.url) {
      inputPath = resolveMediaInputPath(asset.url)
    }
    if (!inputPath && clip.url) {
      inputPath = resolveMediaInputPath(clip.url)
    }
    if (!inputPath || !fsSync.existsSync(inputPath)) { skip(clip, 'no-resolvable-input-path'); continue }

    const clipStart = Number(clip.startTime) || 0
    const clipDuration = Math.max(0, Number(clip.duration) || 0)
    if (clipDuration <= 0.001) { skip(clip, 'clipDuration<=0'); continue }
    const clipEnd = clipStart + clipDuration

    const visibleStart = Math.max(0, clipStart)
    const visibleEnd = Math.min(programDuration, clipEnd)
    if (visibleEnd <= visibleStart) { skip(clip, 'off-program'); continue }

    const clipOffsetOnTimeline = visibleStart - clipStart
    const timeScale = getExportClipTimeScale(clip)
    if (!Number.isFinite(timeScale) || timeScale <= 0) { skip(clip, `bad-timescale=${timeScale}`); continue }

    const trimStart = Math.max(0, Number(clip.trimStart) || 0)
    const sourceOffsetSec = Math.max(0, trimStart + clipOffsetOnTimeline * timeScale)
    const timelineVisibleSec = visibleEnd - visibleStart
    const sourceDurationSec = Math.max(0, timelineVisibleSec * timeScale)
    if (sourceDurationSec <= 0.001) { skip(clip, 'sourceDurationSec<=0'); continue }

    const delayMs = Math.max(0, Math.round(visibleStart * 1000))
    preparedInputs.push({
      inputPath,
      sourceOffsetSec,
      sourceDurationSec,
      delayMs,
      timeScale,
    })
    decisions.push({
      clipId: clip.id,
      type: clip.type,
      trackId: clip.trackId,
      decision: 'include',
      delayMs,
      sourceDurationSec: Number(sourceDurationSec.toFixed(3)),
    })
  }

  // Compact summary: prints one log line that you can paste back to me.
  console.log('[captions:mix] filter decisions:', JSON.stringify({
    clipCount: (clips || []).length,
    trackCount: (tracks || []).length,
    assetCount: (assets || []).length,
    included: preparedInputs.length,
    skipped: decisions.filter((d) => d.decision === 'skip').length,
    tracks: (tracks || []).map((t) => ({ id: t.id, type: t.type, muted: !!t.muted, visible: t.visible !== false })),
    decisions,
  }))

  if (preparedInputs.length === 0) {
    return { success: false, error: 'No audible clips on the timeline — unmute a track or enable a clip\'s audio.' }
  }

  const tempDir = path.join(app.getPath('temp'), 'comfystudio-caption-audio')
  try {
    await fs.mkdir(tempDir, { recursive: true })
  } catch (err) {
    return { success: false, error: err.message }
  }
  const outputPath = path.join(tempDir, `timeline_mix_${Date.now()}.wav`)

  const normalizedSampleRate = Math.max(8000, Math.min(48000, Math.round(Number(sampleRate) || 16000)))
  const normalizedTimeout = Math.max(30000, Math.round(Number(timeoutMs) || 180000))

  const args = ['-y', '-v', 'error']
  for (const entry of preparedInputs) {
    // -vn on each input tells FFmpeg to skip video streams up front; combined with
    // filter_complex selecting [N:a] below, this means we never decode video frames.
    args.push('-vn', '-i', entry.inputPath)
  }

  const inputFilters = []
  const mixLabels = []
  preparedInputs.forEach((entry, index) => {
    const filters = [
      `atrim=start=${formatFilterNumber(entry.sourceOffsetSec)}:duration=${formatFilterNumber(entry.sourceDurationSec)}`,
      'asetpts=PTS-STARTPTS',
      ...buildAtempoFilterChain(entry.timeScale),
      // Force each input to mono before mixing so inputs with different channel
      // layouts combine cleanly.
      'aformat=channel_layouts=mono',
    ]
    if (entry.delayMs > 0) {
      filters.push(`adelay=${entry.delayMs}:all=1`)
    }
    const label = `m${index}`
    inputFilters.push(`[${index}:a]${filters.join(',')}[${label}]`)
    mixLabels.push(`[${label}]`)
  })

  const durationClip = `atrim=duration=${formatFilterNumber(programDuration)},asetpts=PTS-STARTPTS`
  const finalFilter = mixLabels.length === 1
    ? `${mixLabels[0]}${durationClip}[outa]`
    : `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0:normalize=0,${durationClip}[outa]`

  args.push(
    '-filter_complex', `${inputFilters.join(';')};${finalFilter}`,
    '-map', '[outa]',
    '-ar', String(normalizedSampleRate),
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    outputPath
  )

  return await new Promise((resolve) => {
    const proc = spawn(getFfmpegPath(), args, { windowsHide: true })
    let stderr = ''
    let killedByTimeout = false
    const timeoutHandle = setTimeout(() => {
      killedByTimeout = true
      proc.kill('SIGKILL')
    }, normalizedTimeout)

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle)
      resolve({ success: false, error: err.message })
    })

    proc.on('close', async (code) => {
      clearTimeout(timeoutHandle)
      if (killedByTimeout) {
        try { await fs.unlink(outputPath) } catch (_) { /* ignore */ }
        resolve({ success: false, error: `Audio mix timed out after ${Math.round(normalizedTimeout / 1000)}s` })
        return
      }
      if (code !== 0) {
        try { await fs.unlink(outputPath) } catch (_) { /* ignore */ }
        resolve({ success: false, error: stderr || `FFmpeg exited with code ${code}` })
        return
      }
      try {
        const stat = await fs.stat(outputPath)
        resolve({
          success: true,
          outputPath,
          size: stat.size,
          clipCount: preparedInputs.length,
        })
      } catch (err) {
        resolve({ success: false, error: err.message })
      }
    })
  })
})

// ============================================
// IPC Handlers - App Settings Storage
// ============================================

ipcMain.handle('settings:get', async (event, key) => {
  try {
    const settings = await readSettingsRaw()
    return key ? settings[key] : settings
  } catch {
    return key ? null : {}
  }
})

ipcMain.handle('settings:set', async (event, key, value) => {
  try {
    if (!key || typeof key !== 'string') {
      return { success: false, error: 'Missing setting key.' }
    }

    await writeSettingsRaw((settings) => ({
      ...settings,
      [key]: value,
    }))
    await refreshSettingsDependentCaches()
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('settings:delete', async (event, key) => {
  try {
    if (!key || typeof key !== 'string') {
      return { success: false, error: 'Missing setting key.' }
    }

    await writeSettingsRaw((settings) => {
      const next = { ...settings }
      delete next[key]
      return next
    })
    await refreshSettingsDependentCaches()
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ============================================
// ComfyUI Launcher IPC
// ============================================

ipcMain.handle('comfyLauncher:getState', async () => {
  return comfyLauncher.getState()
})

ipcMain.handle('comfyLauncher:getConfig', async () => {
  await refreshLauncherConfigCache()
  return cachedLauncherConfig
})

ipcMain.handle('comfyLauncher:setConfig', async (_event, partial = {}) => {
  try {
    const next = await comfyLauncher._setConfig(partial || {})
    return { success: true, config: next }
  } catch (error) {
    return { success: false, error: error?.message || String(error) }
  }
})

ipcMain.handle('comfyLauncher:start', async () => {
  await refreshLauncherConfigCache()
  return comfyLauncher.start()
})

ipcMain.handle('comfyLauncher:stop', async () => {
  return comfyLauncher.stop()
})

ipcMain.handle('comfyLauncher:restart', async () => {
  await refreshLauncherConfigCache()
  return comfyLauncher.restart()
})

ipcMain.handle('comfyLauncher:detach', async () => {
  return comfyLauncher.detach()
})

ipcMain.handle('comfyLauncher:refresh', async () => {
  await refreshLauncherConfigCache()
  await comfyLauncher.refreshExternal()
  return comfyLauncher.getState()
})

ipcMain.handle('comfyLauncher:getLogs', async (_event, options = {}) => {
  return comfyLauncher.getLogs(options || {})
})

ipcMain.handle('comfyLauncher:appendLog', async (_event, payload = {}) => {
  try {
    const ok = comfyLauncher.appendExternalLog(payload || {})
    return { success: Boolean(ok) }
  } catch (error) {
    return { success: false, error: error?.message || String(error) }
  }
})

ipcMain.handle('comfyLauncher:describePortOwner', async () => {
  try {
    return await comfyLauncher.describePortOwner()
  } catch (error) {
    return { pid: null, name: '', port: null, error: error?.message || String(error) }
  }
})

ipcMain.handle('comfyLauncher:connectExternal', async () => {
  try {
    await comfyLauncher.refreshExternal()
    return { success: true, state: comfyLauncher.getState() }
  } catch (error) {
    return { success: false, error: error?.message || String(error) }
  }
})

ipcMain.handle('shell:openExternal', async (_event, url) => {
  const target = String(url || '').trim()
  if (!target) {
    return { success: false, error: 'No URL provided.' }
  }
  // Allow http(s) and mailto: only to avoid arbitrary protocol handlers.
  if (!/^(https?:|mailto:)/i.test(target)) {
    return { success: false, error: 'Unsupported URL scheme.' }
  }
  try {
    const { shell } = require('electron')
    await shell.openExternal(target)
    return { success: true }
  } catch (error) {
    return { success: false, error: error?.message || 'Failed to open URL.' }
  }
})

ipcMain.handle('comfyLauncher:openLogFile', async () => {
  const state = comfyLauncher.getState()
  const filePath = state?.logFilePath
  if (!filePath) return { success: false, error: 'No log file has been written yet.' }
  try {
    const { shell } = require('electron')
    await shell.openPath(filePath)
    return { success: true, path: filePath }
  } catch (error) {
    return { success: false, error: error?.message || 'Failed to open log file.' }
  }
})

ipcMain.handle('comfyLauncher:detectLaunchers', async (_event, payload = {}) => {
  const explicitRoot = String(payload?.comfyRootPath || '').trim()
  const rootPath = explicitRoot || (await readSettingsRaw())?.[COMFY_ROOT_SETTING_KEY] || ''
  try {
    const candidates = await detectLaunchersForComfyRoot(rootPath)
    return { success: true, comfyRootPath: rootPath, candidates }
  } catch (error) {
    return { success: false, error: error?.message || String(error), candidates: [] }
  }
})

ipcMain.handle('comfyLauncher:pickLauncherScript', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { success: false, error: 'No active window.' }
  }
  const filters = process.platform === 'win32'
    ? [
        { name: 'Launcher scripts', extensions: ['bat', 'cmd'] },
        { name: 'All files', extensions: ['*'] },
      ]
    : [
        { name: 'Launcher scripts', extensions: ['sh', 'command'] },
        { name: 'All files', extensions: ['*'] },
      ]
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select ComfyUI launcher script',
    properties: ['openFile'],
    filters,
  })
  if (result.canceled || !result.filePaths?.length) {
    return { success: false, canceled: true }
  }
  return { success: true, filePath: result.filePaths[0] }
})

// ============================================
// Workflow Setup Manager
// ============================================

ipcMain.handle('comfyui:loadWorkflowGraph', async (event, payload = {}) => {
  try {
    if (!payload?.workflowGraph || typeof payload.workflowGraph !== 'object') {
      return { success: false, error: 'Missing ComfyUI workflow graph payload.' }
    }

    await loadWorkflowGraphInEmbeddedComfy({
      workflowGraph: payload.workflowGraph,
      comfyBaseUrl: payload.comfyBaseUrl || 'http://127.0.0.1:8188',
      waitForMs: payload.waitForMs,
    })

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error?.message || 'Could not load the workflow into the embedded ComfyUI tab.',
    }
  }
})

ipcMain.handle('workflowSetup:validateRoot', async (event, rootPath) => {
  try {
    return await validateWorkflowSetupRootInternal(rootPath)
  } catch (error) {
    return {
      success: false,
      isValid: false,
      error: error?.message || 'Could not validate the selected ComfyUI folder.',
      warnings: [],
      normalizedPath: '',
      customNodesPath: '',
      modelsPath: '',
      pythonCommand: '',
      python: null,
    }
  }
})


ipcMain.handle('workflowSetup:checkPythonModules', async (_event, payload = {}) => {
  const modules = (Array.isArray(payload?.modules) ? payload.modules : [])
    .map((entry) => String(entry?.moduleName || entry || '').trim())
    .filter(Boolean)
  const results = []

  try {
    const validation = await validateWorkflowSetupRootInternal(payload?.comfyRootPath)
    if (!validation.isValid || !validation.python?.command) {
      return {
        success: false,
        error: validation.error || 'ComfyUI Python is not configured.',
        results: modules.map((moduleName) => ({ moduleName, available: false, error: validation.error || 'ComfyUI Python is not configured.' })),
      }
    }

    for (const moduleName of modules) {
      const script = [
        'import importlib.util, importlib, json, sys',
        `name = ${JSON.stringify('${MODULE_NAME}')} `,
      ].join('\n').replace('${MODULE_NAME}', moduleName)
      const probeScript = `${script}\ntry:\n    spec = importlib.util.find_spec(name)\n    if spec is None:\n        print(json.dumps({\"available\": False, \"moduleName\": name}))\n        sys.exit(1)\n    module = importlib.import_module(name)\n    print(json.dumps({\"available\": True, \"moduleName\": name, \"version\": str(getattr(module, \"__version__\", \"\"))}))\nexcept Exception as exc:\n    print(json.dumps({\"available\": False, \"moduleName\": name, \"error\": str(exc)}))\n    sys.exit(1)`
      const probe = await captureCommandOutput(
        validation.python.command,
        [...(validation.python.baseArgs || []), '-c', probeScript],
        5000
      )
      let parsed = null
      try {
        parsed = JSON.parse(String(probe.output || '').trim())
      } catch (_) {
        parsed = null
      }
      results.push({
        moduleName,
        available: Boolean(probe.success && parsed?.available),
        version: String(parsed?.version || '').trim(),
        error: probe.success ? '' : (String(parsed?.error || probe.error || 'Module was not detected.')),
      })
    }

    return { success: true, results }
  } catch (error) {
    return {
      success: false,
      error: error?.message || 'Could not check ComfyUI Python modules.',
      results: modules.map((moduleName) => ({ moduleName, available: false, error: error?.message || 'Could not check ComfyUI Python modules.' })),
    }
  }
})

ipcMain.handle('workflowSetup:checkFiles', async (_event, payload = {}) => {
  const results = []
  try {
    const validation = await validateWorkflowSetupRootInternal(payload?.comfyRootPath)
    if (!validation.isValid || !validation.modelsPath) {
      return {
        success: false,
        error: validation.error || 'ComfyUI root is not configured.',
        results,
      }
    }

    const modelsPath = validation.modelsPath
    const files = Array.isArray(payload?.files) ? payload.files : []
    const extraModelPaths = await loadExtraModelPathConfigForComfyRoot(validation.normalizedPath)

    // Cache per-subdir directory listings so we can do case-insensitive matching
    // on filesystems where casing differs from the declared filename.
    const dirListingCache = new Map()
    const getDirListing = async (absoluteDir) => {
      if (dirListingCache.has(absoluteDir)) return dirListingCache.get(absoluteDir)
      let entries = []
      try {
        entries = await fs.readdir(absoluteDir)
      } catch {
        entries = []
      }
      const lowerSet = new Set(entries.map((name) => String(name || '').toLowerCase()))
      dirListingCache.set(absoluteDir, lowerSet)
      return lowerSet
    }
    const getPathVariants = (value) => {
      const normalized = String(value || '').trim().replace(/\\/g, '/')
      const parts = normalized.split('/').filter(Boolean)
      return {
        normalized,
        basename: parts[parts.length - 1] || normalized,
      }
    }

    for (const file of files) {
      const filename = String(file?.filename || '').trim()
      const targetSubdir = String(file?.targetSubdir || '').trim()
      if (!filename) {
        results.push({ filename: '', targetSubdir, exists: false })
        continue
      }

      const candidateSearchKeys = getModelSearchKeys(targetSubdir)
      const candidateDirs = []
      const seenCandidateDirs = new Set()
      const addCandidateDir = (candidateDir) => {
        const normalizedDir = path.normalize(String(candidateDir || '').trim())
        if (!normalizedDir) return
        const key = normalizedDir.toLowerCase()
        if (seenCandidateDirs.has(key)) return
        seenCandidateDirs.add(key)
        candidateDirs.push(normalizedDir)
      }

      // Some loaders (e.g. LTX AV text encoder) accept either a text_encoders or
      // checkpoints path. Also try common sibling folders so existing but
      // relocated files still resolve without forcing a redundant download.
      for (const searchKey of candidateSearchKeys) {
        addCandidateDir(searchKey ? path.join(modelsPath, searchKey) : modelsPath)
        const extraDirs = extraModelPaths.pathsByKey.get(normalizeModelSearchKey(searchKey)) || []
        for (const extraDir of extraDirs) addCandidateDir(extraDir)
      }

      let exists = false
      let resolvedPath = ''
      const targetVariants = getPathVariants(filename)
      const lowerTarget = targetVariants.normalized.toLowerCase()
      const lowerTargetBasename = targetVariants.basename.toLowerCase()

      if (targetSubdir) {
        const directPath = path.join(modelsPath, targetSubdir, targetVariants.normalized)
        if (await pathExists(directPath)) {
          exists = true
          resolvedPath = directPath
        }
      }

      for (const absoluteDir of candidateDirs) {
        const listing = await getDirListing(absoluteDir)
        if (listing.has(lowerTarget) || listing.has(lowerTargetBasename)) {
          exists = true
          resolvedPath = path.join(absoluteDir, listing.has(lowerTarget) ? targetVariants.normalized : targetVariants.basename)
          break
        }
      }

      results.push({
        filename,
        targetSubdir,
        exists,
        resolvedPath: exists ? resolvedPath : '',
      })
    }

    return {
      success: true,
      results,
      modelsPath,
      extraModelConfigPath: extraModelPaths.configPath,
      extraModelPathCount: extraModelPaths.pathCount,
    }
  } catch (error) {
    return {
      success: false,
      error: error?.message || 'Failed to check model files on disk.',
      results,
    }
  }
})

ipcMain.handle('workflowSetup:install', async (event, payload = {}) => {
  const validation = await validateWorkflowSetupRootInternal(payload?.comfyRootPath)
  if (!validation.isValid) {
    return {
      success: false,
      error: validation.error || 'Choose a valid ComfyUI folder first.',
      validation,
      nodePacks: [],
      models: [],
      errors: [],
      restartRecommended: false,
    }
  }

  const plan = payload?.plan && typeof payload.plan === 'object' ? payload.plan : {}
  const nodePacks = Array.isArray(plan.nodePacks) ? plan.nodePacks : []
  const models = Array.isArray(plan.models) ? plan.models : []

  const nodePackResults = []
  const modelResults = []
  const errors = []
  const totalTasks = nodePacks.length + models.length
  let completedTasks = 0

  emitWorkflowSetupProgress({
    stage: 'install',
    status: 'active',
    totalTasks,
    completedTasks,
    overallPercent: totalTasks > 0 ? 0 : 100,
    message: 'Starting workflow setup install...',
  })

  for (const task of nodePacks) {
    const currentTaskIndex = completedTasks + 1
    try {
      const result = await installNodePackTask(task, validation, {
        currentTaskIndex,
        totalTasks,
        completedTasks,
      })
      nodePackResults.push(result)
    } catch (error) {
      const message = error?.message || `Failed to install ${task?.displayName || task?.id || 'node pack'}.`
      errors.push(message)
      emitWorkflowSetupProgress({
        stage: 'node-pack',
        status: 'complete',
        level: 'error',
        taskType: 'node-pack',
        currentLabel: task?.displayName || task?.id || 'Custom node pack',
        currentTaskIndex,
        totalTasks,
        completedTasks: completedTasks + 1,
        taskPercent: null,
        overallPercent: getWorkflowSetupOverallPercent({ completedTasks: completedTasks + 1, totalTasks }),
        message,
      })
    }
    completedTasks += 1
  }

  for (const task of models) {
    const currentTaskIndex = completedTasks + 1
    const targetFolder = task?.targetSubdir
      ? path.join(validation.modelsPath, task.targetSubdir)
      : validation.modelsPath
    const targetPath = path.join(targetFolder, task.filename)

    try {
      const result = await downloadFileWithProgress(task, targetPath, {
        currentTaskIndex,
        totalTasks,
        completedTasks,
      })
      modelResults.push(result)
    } catch (error) {
      const message = error?.message || `Failed to download ${task?.filename || 'model'}.`
      errors.push(message)
      emitWorkflowSetupProgress({
        stage: 'download',
        status: 'complete',
        level: 'error',
        taskType: 'model',
        currentLabel: task?.displayName || task?.filename || 'Model',
        currentTaskIndex,
        totalTasks,
        completedTasks: completedTasks + 1,
        taskPercent: null,
        overallPercent: getWorkflowSetupOverallPercent({ completedTasks: completedTasks + 1, totalTasks }),
        message,
      })
    }
    completedTasks += 1
  }

  emitWorkflowSetupProgress({
    stage: 'install',
    status: 'finished',
    level: errors.length === 0 ? 'success' : 'warning',
    totalTasks,
    completedTasks: totalTasks,
    overallPercent: 100,
    message: errors.length === 0
      ? 'Workflow setup install finished.'
      : 'Workflow setup install finished with errors.',
  })

  return {
    success: errors.length === 0,
    validation,
    nodePacks: nodePackResults,
    models: modelResults,
    errors,
    restartRecommended: nodePackResults.some((entry) => !entry?.skipped),
  }
})

// ============================================
// Export Operations
// ============================================

ipcMain.handle('export:cancelWorker', async () => {
  try {
    abortAllFramePipeExports()
    if (exportWorkerWindow && !exportWorkerWindow.isDestroyed()) {
      exportWorkerWindow.close()
    }
    exportWorkerWindow = null
    return { success: true }
  } catch (err) {
    return { success: false, error: err?.message || String(err) }
  }
})

ipcMain.handle('export:runInWorker', async (event, payload = {}) => {
  if (exportWorkerWindow && !exportWorkerWindow.isDestroyed()) {
    return { success: false, error: 'Export already in progress' }
  }
  const requestId = String(payload?.requestId || `export-${Date.now()}`)
  const workerUrl = isDev
    ? `http://127.0.0.1:5173?export=worker`
    : `file://${path.join(__dirname, '../dist/index.html')}?export=worker`
  exportWorkerWindow = new BrowserWindow({
    width: 400,
    height: 200,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // Export renders inside a hidden window. Keep timers/rAF/video callbacks
      // unthrottled so frame export speed is not limited by background mode.
      backgroundThrottling: false,
      // Allow loading file:// URLs for video/image elements during export (otherwise "Media load rejected by URL safety check")
      webSecurity: false,
    },
  })
  const workerWindow = exportWorkerWindow
  const workerContents = workerWindow.webContents
  let workerDone = false
  let lastWorkerProgressAt = Date.now()
  let workerWatchdog = null

  const forwardToMain = (channel, data) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      mainWindow.webContents.send(channel, { ...data, requestId })
      return
    }
    mainWindow.webContents.send(channel, { requestId, error: data })
  }
  const closeWorkerWindow = () => {
    if (workerWindow && !workerWindow.isDestroyed()) {
      workerWindow.close()
    }
  }
  const failWorker = (message, details = null) => {
    if (workerDone) return
    workerDone = true
    abortAllFramePipeExports()
    const errorMessage = message || 'Export worker failed.'
    console.error('[Export] Worker failed:', errorMessage, details || '')
    forwardToMain('export:error', { error: errorMessage, details })
    closeWorkerWindow()
  }
  const completeWorker = (data) => {
    if (workerDone) return
    workerDone = true
    forwardToMain('export:complete', data)
    closeWorkerWindow()
  }
  const onProgress = (event, data) => {
    if (event.sender !== workerContents || workerDone) return
    lastWorkerProgressAt = Date.now()
    forwardToMain('export:progress', data)
  }
  const onComplete = (event, data) => {
    if (event.sender === workerContents) completeWorker(data)
  }
  const onError = (event, err) => {
    if (event.sender === workerContents) {
      console.error('[Export] Worker reported error:', err, typeof err)
      failWorker(err?.error || err?.message || err || 'Export worker reported an error.', err)
    }
  }
  const onWorkerReady = (event) => {
    if (event.sender === workerContents) sendJob()
  }
  const cleanupExportWorkerListeners = () => {
    if (workerWatchdog) {
      clearInterval(workerWatchdog)
      workerWatchdog = null
    }
    ipcMain.removeListener('export:progress', onProgress)
    ipcMain.removeListener('export:complete', onComplete)
    ipcMain.removeListener('export:error', onError)
    ipcMain.removeListener('export:workerReady', onWorkerReady)
  }
  ipcMain.on('export:progress', onProgress)
  ipcMain.on('export:complete', onComplete)
  ipcMain.on('export:error', onError)
  const sendJob = () => {
    if (workerWindow && !workerWindow.isDestroyed()) {
      workerWindow.webContents.send('export:job', payload)
    }
  }
  ipcMain.on('export:workerReady', onWorkerReady)
  workerContents.on('console-message', (_event, level, message, line, sourceId) => {
    const prefix = level >= 2 ? 'warn' : 'log'
    console[prefix](`[ExportWorker console] ${message} (${sourceId}:${line})`)
  })
  workerContents.on('render-process-gone', (_event, details) => {
    failWorker(`Export worker renderer stopped (${details?.reason || 'unknown'}).`, details)
  })
  workerWindow.on('unresponsive', () => {
    failWorker('Export worker became unresponsive.')
  })
  workerWatchdog = setInterval(() => {
    if (workerDone) return
    const idleMs = Date.now() - lastWorkerProgressAt
    if (idleMs > 120000) {
      failWorker('Export worker stopped reporting progress for more than 120 seconds.')
    }
  }, 10000)
  workerWindow.on('closed', () => {
    const closedBeforeDone = !workerDone
    cleanupExportWorkerListeners()
    if (exportWorkerWindow === workerWindow) exportWorkerWindow = null
    if (closedBeforeDone) {
      workerDone = true
      abortAllFramePipeExports()
      forwardToMain('export:error', { error: 'Export worker closed before finishing.' })
    }
  })
  await workerWindow.loadURL(workerUrl)
  return { started: true }
})

const formatFilterNumber = (value, fallback = '0.000000') => {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(0, num).toFixed(6)
}

const getExportClipTimeScale = (clip) => {
  if (!clip) return 1
  const sourceScale = Number(clip.sourceTimeScale)
  const timelineFps = Number(clip.timelineFps)
  const sourceFps = Number(clip.sourceFps)
  const baseScale = Number.isFinite(sourceScale) && sourceScale > 0
    ? sourceScale
    : ((Number.isFinite(timelineFps) && timelineFps > 0 && Number.isFinite(sourceFps) && sourceFps > 0)
      ? (timelineFps / sourceFps)
      : 1)
  const speed = Number(clip.speed)
  const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
  return baseScale * speedScale
}

const buildAtempoFilterChain = (rate) => {
  const safeRate = Math.max(0.01, Number(rate) || 1)
  let remaining = safeRate
  const filters = []
  let guard = 0
  while (remaining > 2 && guard < 16) {
    filters.push('atempo=2.0')
    remaining /= 2
    guard += 1
  }
  while (remaining < 0.5 && guard < 32) {
    filters.push('atempo=0.5')
    remaining /= 0.5
    guard += 1
  }
  filters.push(`atempo=${remaining.toFixed(6)}`)
  return filters
}

const clampAudioFadeSeconds = (value, clipDuration = 0) => {
  const duration = Math.max(0, Number(clipDuration) || 0)
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.min(parsed, duration)
}

const MIN_AUDIO_CLIP_GAIN_DB = -24
const MAX_AUDIO_CLIP_GAIN_DB = 24

const normalizeAudioClipGainDb = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(MIN_AUDIO_CLIP_GAIN_DB, Math.min(MAX_AUDIO_CLIP_GAIN_DB, parsed))
}

const audioGainDbToLinear = (value) => Math.pow(10, normalizeAudioClipGainDb(value) / 20)

const buildAudioFadeVolumeExpression = (clipDuration, fadeIn, fadeOut, clipOffset = 0, gainDb = 0, trackVolume = 100) => {
  const duration = Math.max(0, Number(clipDuration) || 0)
  const normalizedFadeIn = clampAudioFadeSeconds(fadeIn, duration)
  const normalizedFadeOut = clampAudioFadeSeconds(fadeOut, duration)
  const offset = Math.max(0, Math.min(Number(clipOffset) || 0, duration))
  const trackGain = Math.max(0, Math.min(1, (Number(trackVolume) || 0) / 100))
  const baseGain = audioGainDbToLinear(gainDb) * trackGain

  const fadeInExpr = normalizedFadeIn > 0
    ? `if(lt(t+${formatFilterNumber(offset)},${formatFilterNumber(normalizedFadeIn)}),(t+${formatFilterNumber(offset)})/${formatFilterNumber(normalizedFadeIn)},1)`
    : '1'

  const fadeOutStart = Math.max(0, duration - normalizedFadeOut)
  const fadeOutExpr = normalizedFadeOut > 0
    ? `if(gt(t+${formatFilterNumber(offset)},${formatFilterNumber(fadeOutStart)}),(${formatFilterNumber(duration)}-(t+${formatFilterNumber(offset)}))/${formatFilterNumber(normalizedFadeOut)},1)`
    : '1'

  const fadeExpr = `max(0,min(1,min(${fadeInExpr},${fadeOutExpr})))`
  if (Math.abs(baseGain - 1) < 0.000001) {
    return fadeExpr
  }
  return `${formatFilterNumber(baseGain)}*(${fadeExpr})`
}

ipcMain.handle('export:mixAudio', async (event, options = {}) => {
  if (!getFfmpegPath()) {
    return { success: false, error: 'FFmpeg binary not available.' }
  }

  const {
    projectPath = '',
    outputPath,
    rangeStart = 0,
    rangeEnd = 0,
    sampleRate = 44100,
    channels = 2,
    clips = [],
    tracks = [],
    assets = [],
    timeoutMs = 180000,
  } = options

  if (!outputPath) {
    return { success: false, error: 'Missing output path for audio mix.' }
  }

  const start = Number(rangeStart)
  const end = Number(rangeEnd)
  const rangeStartSec = Number.isFinite(start) ? start : 0
  const rangeEndSec = Number.isFinite(end) ? end : rangeStartSec
  const totalDuration = Math.max(0, rangeEndSec - rangeStartSec)
  if (totalDuration <= 0.000001) {
    return { success: false, error: 'Invalid export range for audio mix.' }
  }

  const trackMap = new Map((tracks || []).map((track) => [track.id, track]))
  const assetMap = new Map((assets || []).map((asset) => [asset.id, asset]))
  const preparedInputs = []

  for (const clip of clips || []) {
    if (!clip || clip.type !== 'audio') continue
    const track = trackMap.get(clip.trackId)
    if (!track || track.type !== 'audio' || track.muted || track.visible === false) continue
    if (clip.reverse) continue // Matches timeline preview behavior (reverse audio is silent).

    const asset = assetMap.get(clip.assetId)
    if (!asset) continue

    let inputPath = null
    if (asset.path && projectPath) {
      inputPath = path.join(projectPath, asset.path)
    }
    if (!inputPath && asset.url) {
      inputPath = resolveMediaInputPath(asset.url)
    }
    if (!inputPath && clip.url) {
      inputPath = resolveMediaInputPath(clip.url)
    }
    if (!inputPath || !fsSync.existsSync(inputPath)) continue

    const clipStart = Number(clip.startTime) || 0
    const clipDuration = Math.max(0, Number(clip.duration) || 0)
    if (clipDuration <= 0.000001) continue
    const clipEnd = clipStart + clipDuration

    const visibleStart = Math.max(rangeStartSec, clipStart)
    const visibleEnd = Math.min(rangeEndSec, clipEnd)
    if (visibleEnd <= visibleStart) continue

    const clipOffsetOnTimeline = visibleStart - clipStart
    const timeScale = getExportClipTimeScale(clip)
    if (!Number.isFinite(timeScale) || timeScale <= 0) continue

    const trimStart = Math.max(0, Number(clip.trimStart) || 0)
    const sourceOffsetSec = Math.max(0, trimStart + clipOffsetOnTimeline * timeScale)
    const timelineVisibleSec = visibleEnd - visibleStart
    const sourceDurationSec = Math.max(0, timelineVisibleSec * timeScale)
    if (sourceDurationSec <= 0.000001) continue

    const delayMs = Math.max(0, Math.round((visibleStart - rangeStartSec) * 1000))
    preparedInputs.push({
      inputPath,
      sourceOffsetSec,
      sourceDurationSec,
      delayMs,
      timeScale,
      clipDuration,
      clipOffsetOnTimeline,
      gainDb: normalizeAudioClipGainDb(clip.gainDb),
      fadeIn: clampAudioFadeSeconds(clip.fadeIn, clipDuration),
      fadeOut: clampAudioFadeSeconds(clip.fadeOut, clipDuration),
      trackVolume: track.volume ?? 100,
      forceMono: track.channels === 'mono',
    })
  }

  if (preparedInputs.length === 0) {
    return { success: false, error: 'No eligible audio clips for mix.' }
  }

  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
  } catch (err) {
    return { success: false, error: err.message || 'Failed to prepare audio mix output folder.' }
  }

  const normalizedSampleRate = Math.max(8000, Math.min(192000, Math.round(Number(sampleRate) || 44100)))
  const normalizedChannels = Math.max(1, Math.min(2, Math.round(Number(channels) || 2)))
  const normalizedTimeout = Math.max(30000, Math.round(Number(timeoutMs) || 180000))

  const args = ['-y']
  for (const entry of preparedInputs) {
    args.push('-i', entry.inputPath)
  }

  const inputFilters = []
  const mixLabels = []
  preparedInputs.forEach((entry, index) => {
    const filters = [
      `atrim=start=${formatFilterNumber(entry.sourceOffsetSec)}:duration=${formatFilterNumber(entry.sourceDurationSec)}`,
      'asetpts=PTS-STARTPTS',
      ...buildAtempoFilterChain(entry.timeScale),
    ]

    if (entry.forceMono) {
      filters.push('aformat=channel_layouts=mono')
    }
    if (entry.fadeIn > 0 || entry.fadeOut > 0 || entry.gainDb !== 0 || entry.trackVolume !== 100) {
      filters.push(`volume='${buildAudioFadeVolumeExpression(entry.clipDuration, entry.fadeIn, entry.fadeOut, entry.clipOffsetOnTimeline, entry.gainDb, entry.trackVolume)}':eval=frame`)
    }
    if (entry.delayMs > 0) {
      filters.push(`adelay=${entry.delayMs}:all=1`)
    }

    const label = `mix${index}`
    inputFilters.push(`[${index}:a]${filters.join(',')}[${label}]`)
    mixLabels.push(`[${label}]`)
  })

  const finalMixFilter = mixLabels.length === 1
    ? `${mixLabels[0]}atrim=duration=${formatFilterNumber(totalDuration)},asetpts=PTS-STARTPTS[outa]`
    : `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0,atrim=duration=${formatFilterNumber(totalDuration)},asetpts=PTS-STARTPTS[outa]`
  const filterComplex = `${inputFilters.join(';')};${finalMixFilter}`

  args.push(
    '-filter_complex', filterComplex,
    '-map', '[outa]',
    '-ar', String(normalizedSampleRate),
    '-ac', String(normalizedChannels),
    '-c:a', 'pcm_s16le',
    outputPath
  )

  return await new Promise((resolve) => {
    const ffmpeg = spawn(getFfmpegPath(), args, { windowsHide: true })
    let stderr = ''
    let killedByTimeout = false
    const timeoutHandle = setTimeout(() => {
      killedByTimeout = true
      ffmpeg.kill('SIGKILL')
    }, normalizedTimeout)

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    ffmpeg.on('error', (err) => {
      clearTimeout(timeoutHandle)
      resolve({ success: false, error: err.message })
    })

    ffmpeg.on('close', (code) => {
      clearTimeout(timeoutHandle)
      if (killedByTimeout) {
        resolve({ success: false, error: `Audio mix timed out after ${Math.round(normalizedTimeout / 1000)}s` })
        return
      }
      if (code === 0) {
        resolve({ success: true, clipCount: preparedInputs.length })
        return
      }
      resolve({ success: false, error: stderr || `FFmpeg exited with code ${code}` })
    })
  })
})

function appendExportVideoEncoderArgs(args, options = {}) {
  const {
    format = 'mp4',
    videoCodec = 'h264',
    proresProfile = '3',
    useHardwareEncoder = false,
    nvencPreset = 'p5',
    preset = 'medium',
    qualityMode = 'crf',
    crf = 18,
    bitrateKbps = 8000,
    keyframeInterval = null,
  } = options

  let encoderUsed = null
  const isProRes = videoCodec === 'prores' || (format === 'mov' && options.proresProfile != null)
  const normalizedCodec = isProRes
    ? 'prores'
    : (format === 'webm' || videoCodec === 'vp9'
      ? 'vp9'
      : (videoCodec === 'h265' ? 'h265' : 'h264'))

  if (normalizedCodec === 'prores') {
    const profileNum = Math.min(4, Math.max(0, parseInt(String(proresProfile), 10) || 3))
    args.push(
      '-c:v', 'prores_ks',
      '-profile:v', String(profileNum),
      '-pix_fmt', profileNum === 4 ? 'yuva444p10le' : 'yuv422p10le'
    )
    encoderUsed = 'prores_ks'
  } else if (normalizedCodec === 'vp9') {
    const vp9SpeedMap = {
      ultrafast: 8,
      superfast: 7,
      veryfast: 6,
      faster: 5,
      fast: 4,
      medium: 3,
      slow: 2,
      slower: 1,
      veryslow: 0,
    }
    args.push(
      '-c:v', 'libvpx-vp9',
      '-pix_fmt', 'yuv420p',
      '-row-mt', '1',
      '-cpu-used', String(vp9SpeedMap[preset] ?? 3)
    )
    encoderUsed = 'libvpx-vp9'
    if (qualityMode === 'bitrate') {
      args.push('-b:v', `${bitrateKbps}k`)
    } else {
      args.push('-crf', String(crf), '-b:v', '0')
    }
  } else if (normalizedCodec === 'h265') {
    if (useHardwareEncoder) {
      args.push(
        '-c:v', 'hevc_nvenc',
        '-preset', nvencPreset,
        '-pix_fmt', 'yuv420p',
        '-rc', qualityMode === 'bitrate' ? 'vbr' : 'vbr'
      )
      encoderUsed = 'hevc_nvenc'
      if (qualityMode === 'bitrate') {
        args.push('-b:v', `${bitrateKbps}k`)
      } else {
        args.push('-cq', String(crf))
      }
    } else {
      args.push(
        '-c:v', 'libx265',
        '-preset', preset,
        '-pix_fmt', 'yuv420p'
      )
      encoderUsed = 'libx265'
      if (qualityMode === 'bitrate') {
        args.push('-b:v', `${bitrateKbps}k`)
      } else {
        args.push('-crf', String(crf))
      }
    }
    args.push('-tag:v', 'hvc1')
  } else {
    // Default to H.264
    if (useHardwareEncoder) {
      args.push(
        '-c:v', 'h264_nvenc',
        '-preset', nvencPreset,
        '-pix_fmt', 'yuv420p',
        '-rc', qualityMode === 'bitrate' ? 'vbr' : 'vbr'
      )
      encoderUsed = 'h264_nvenc'
      if (qualityMode === 'bitrate') {
        args.push('-b:v', `${bitrateKbps}k`)
      } else {
        args.push('-cq', String(crf))
      }
    } else {
      args.push(
        '-c:v', 'libx264',
        '-preset', preset,
        '-pix_fmt', 'yuv420p'
      )
      encoderUsed = 'libx264'
      if (qualityMode === 'bitrate') {
        args.push('-b:v', `${bitrateKbps}k`)
      } else {
        args.push('-crf', String(crf))
      }
    }
  }

  if (keyframeInterval && Number(keyframeInterval) > 0) {
    args.push('-g', String(keyframeInterval), '-keyint_min', String(keyframeInterval))
  }

  if (format === 'mp4') {
    args.push('-movflags', '+faststart')
  }

  return encoderUsed
}

function appendExportAudioEncoderArgs(args, options = {}) {
  const {
    format = 'mp4',
    audioCodec = 'aac',
    audioBitrateKbps = 192,
    audioSampleRate = 44100,
  } = options

  const useOpus = format === 'webm' || audioCodec === 'opus'
  args.push('-c:a', useOpus ? 'libopus' : 'aac')
  args.push('-b:a', `${audioBitrateKbps}k`)
  args.push('-ar', String(audioSampleRate))
}

const appendLimitedStderr = (current, data) => {
  const next = `${current}${data.toString()}`
  return next.length > 24000 ? next.slice(-24000) : next
}

ipcMain.handle('export:encodeVideo', async (event, options = {}) => {
  const {
    framePattern,
    fps = 24,
    outputPath,
    audioPath = null,
    format = 'mp4',
    duration = null,
    audioCodec = 'aac',
    audioBitrateKbps = 192,
    audioSampleRate = 44100,
    useHardwareEncoder = false
  } = options

  if (!getFfmpegPath()) {
    return { success: false, error: 'FFmpeg binary not available.' }
  }
  if (!framePattern || !outputPath) {
    return { success: false, error: 'Missing export inputs.' }
  }

  const args = ['-y', '-framerate', String(fps), '-i', framePattern]
  if (audioPath) {
    args.push('-i', audioPath)
  }
  if (duration) {
    args.push('-t', String(duration))
  }

  const encoderUsed = appendExportVideoEncoderArgs(args, options)

  if (audioPath) {
    appendExportAudioEncoderArgs(args, { format, audioCodec, audioBitrateKbps, audioSampleRate })
  }

  args.push(outputPath)
  console.log(`[Export] Encoding with ${encoderUsed} (${useHardwareEncoder ? 'NVENC' : 'software'})`)

  return await new Promise((resolve) => {
    const ffmpeg = spawn(getFfmpegPath(), args, { windowsHide: true })
    let stderr = ''

    ffmpeg.stderr.on('data', (data) => {
      stderr = appendLimitedStderr(stderr, data)
    })

    ffmpeg.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, encoderUsed })
      } else {
        resolve({ success: false, error: stderr || `FFmpeg exited with code ${code}`, encoderUsed })
      }
    })
  })
})

ipcMain.handle('export:renderTimelineVideo', async (event, options = {}) => {
  const {
    segments = [],
    outputPath,
    format = 'mp4',
    fps = 24,
    width = 1920,
    height = 1080,
    videoCodec = 'h264',
    useHardwareEncoder = false,
    nvencPreset = 'p5',
    preset = 'medium',
    qualityMode = 'crf',
    crf = 18,
    bitrateKbps = 8000,
    keyframeInterval = null,
    audioPath = null,
    audioCodec = 'aac',
    audioBitrateKbps = 192,
    audioSampleRate = 44100,
    duration = null,
  } = options

  if (!getFfmpegPath()) {
    return { success: false, error: 'FFmpeg binary not available.' }
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    return { success: false, error: 'Missing timeline segments.' }
  }
  if (!outputPath) {
    return { success: false, error: 'Missing output path.' }
  }

  const args = ['-y', '-hide_banner']
  const inputFilters = []
  const concatLabels = []
  const normalizedWidth = Math.max(1, Math.round(Number(width) || 1920))
  const normalizedHeight = Math.max(1, Math.round(Number(height) || 1080))

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] || {}
    const inputPath = String(segment.inputPath || '').trim()
    const sourceOffsetSec = Math.max(0, Number(segment.sourceOffsetSec) || 0)
    const sourceDurationSec = Math.max(0, Number(segment.sourceDurationSec) || 0)
    const isImage = !!segment.isImage
    const isBlank = !!segment.isBlank
    if (isBlank) {
      args.push('-f', 'lavfi', '-i', `color=c=black:s=${normalizedWidth}x${normalizedHeight}:r=${Math.max(1, Math.round(Number(fps) || 24))}`)
    } else if (!inputPath) {
      return { success: false, error: `Timeline segment ${i} is missing inputPath.` }
    } else if (isImage) {
      args.push('-loop', '1', '-i', inputPath)
    } else {
      args.push('-i', inputPath)
    }

    const label = `v${i}`
    const filters = []
    if (isBlank) {
      if (sourceDurationSec > 0) {
        filters.push(`trim=duration=${formatFilterNumber(sourceDurationSec)}`)
      }
      filters.push('setpts=PTS-STARTPTS')
    } else if (isImage) {
      filters.push(`scale=${normalizedWidth}:${normalizedHeight}:force_original_aspect_ratio=decrease`)
      filters.push(`pad=${normalizedWidth}:${normalizedHeight}:(ow-iw)/2:(oh-ih)/2`)
      filters.push('format=rgba')
      if (sourceDurationSec > 0) {
        filters.push(`trim=duration=${formatFilterNumber(sourceDurationSec)}`)
      }
      filters.push('setpts=PTS-STARTPTS')
    } else {
      if (sourceDurationSec > 0 || sourceOffsetSec > 0) {
        filters.push(`trim=start=${formatFilterNumber(sourceOffsetSec)}:duration=${formatFilterNumber(sourceDurationSec)}`)
      }
      filters.push(`scale=${normalizedWidth}:${normalizedHeight}:force_original_aspect_ratio=decrease`)
      filters.push(`pad=${normalizedWidth}:${normalizedHeight}:(ow-iw)/2:(oh-ih)/2`)
      filters.push('format=rgba')
      filters.push('setpts=PTS-STARTPTS')
    }
    inputFilters.push(`[${i}:v]${filters.join(',')}[${label}]`)
    concatLabels.push(`[${label}]`)
  }

  const finalVideoFilter = `${concatLabels.join('')}concat=n=${concatLabels.length}:v=1:a=0[outv]`
  args.push('-filter_complex', `${inputFilters.join(';')};${finalVideoFilter}`)
  args.push('-map', '[outv]')
  if (duration) {
    args.push('-t', String(duration))
  }
  args.push('-r', String(Math.max(1, Math.round(Number(fps) || 24))))
  const encoderUsed = appendExportVideoEncoderArgs(args, {
    format,
    videoCodec,
    useHardwareEncoder,
    nvencPreset,
    preset,
    qualityMode,
    crf,
    bitrateKbps,
    keyframeInterval,
  })
  if (audioPath) {
    args.push('-i', audioPath)
    args.push('-map', '1:a:0')
    appendExportAudioEncoderArgs(args, { format, audioCodec, audioBitrateKbps, audioSampleRate })
  }
  args.push(outputPath)

  console.log(`[Export] Rendering native timeline with ${encoderUsed} (${useHardwareEncoder ? 'NVENC' : 'software'})`)

  return await new Promise((resolve) => {
    const ffmpeg = spawn(getFfmpegPath(), args, { windowsHide: true })
    let stderr = ''

    ffmpeg.stderr.on('data', (data) => {
      stderr = appendLimitedStderr(stderr, data)
    })

    ffmpeg.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, encoderUsed })
      } else {
        resolve({ success: false, error: stderr || `FFmpeg exited with code ${code}`, encoderUsed })
      }
    })
  })
})

ipcMain.handle('export:concatVideoSegments', async (event, options = {}) => {
  const {
    concatListPath,
    outputPath,
    format = 'mp4',
    videoCodec = 'h264',
    useHardwareEncoder = false,
    nvencPreset = 'p5',
    preset = 'medium',
    qualityMode = 'crf',
    crf = 18,
    bitrateKbps = 8000,
    keyframeInterval = null,
  } = options
  if (!getFfmpegPath()) {
    return { success: false, error: 'FFmpeg binary not available.' }
  }
  if (!concatListPath || !outputPath) {
    return { success: false, error: 'Missing concat inputs.' }
  }
  const args = [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-fflags', '+genpts',
    '-avoid_negative_ts', 'make_zero',
    '-i', concatListPath,
    '-vsync', 'cfr',
    '-fps_mode', 'cfr',
  ]
  appendExportVideoEncoderArgs(args, {
    format,
    videoCodec,
    useHardwareEncoder,
    nvencPreset,
    preset,
    qualityMode,
    crf,
    bitrateKbps,
    keyframeInterval,
  })
  if (format === 'mp4') {
    args.push('-movflags', '+faststart')
  }
  args.push(outputPath)
  return await new Promise((resolve) => {
    const ffmpeg = spawn(getFfmpegPath(), args, { windowsHide: true })
    let stderr = ''
    ffmpeg.stderr.on('data', (data) => {
      stderr = appendLimitedStderr(stderr, data)
    })
    ffmpeg.on('error', (err) => resolve({ success: false, error: err.message }))
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve({ success: true })
      else resolve({ success: false, error: stderr || `FFmpeg exited with code ${code}` })
    })
  })
})

ipcMain.handle('export:startFramePipe', async (event, options = {}) => {
  const {
    width,
    height,
    fps = 24,
    outputPath,
    format = 'mp4',
    duration = null,
  } = options

  if (!getFfmpegPath()) {
    return { success: false, error: 'FFmpeg binary not available.' }
  }
  if (!width || !height || !outputPath) {
    return { success: false, error: 'Missing frame pipe inputs.' }
  }

  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-video_size', `${Math.round(Number(width))}x${Math.round(Number(height))}`,
    '-framerate', String(fps),
    '-i', 'pipe:0',
  ]
  if (duration) {
    args.push('-t', String(duration))
  }

  const encoderUsed = appendExportVideoEncoderArgs(args, options)
  args.push(outputPath)

  const sessionId = crypto.randomUUID()
  const ffmpeg = spawn(getFfmpegPath(), args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  let closed = false
  let closeCode = null
  let spawnError = null

  const closePromise = new Promise((resolve) => {
    ffmpeg.stderr.on('data', (data) => {
      stderr = appendLimitedStderr(stderr, data)
    })
    ffmpeg.on('error', (err) => {
      spawnError = err
    })
    ffmpeg.on('close', (code) => {
      closed = true
      closeCode = code
      resolve({ code })
    })
  })

  activeFramePipeExports.set(sessionId, {
    ffmpeg,
    closePromise,
    encoderUsed,
    getClosed: () => closed,
    getCloseCode: () => closeCode,
    getError: () => spawnError,
    getStderr: () => stderr,
  })

  console.log(`[Export] Frame pipe started with ${encoderUsed} (${options.useHardwareEncoder ? 'NVENC' : 'software'})`)
  return { success: true, sessionId, encoderUsed }
})

ipcMain.handle('export:writeFrameToPipe', async (event, sessionId, frameBuffer) => {
  const session = activeFramePipeExports.get(sessionId)
  if (!session) {
    return { success: false, error: 'Frame pipe session not found.' }
  }
  if (session.getClosed()) {
    return {
      success: false,
      error: session.getStderr() || `Frame pipe closed with code ${session.getCloseCode()}`,
    }
  }
  if (!frameBuffer) {
    return { success: false, error: 'Missing frame buffer.' }
  }

  try {
    const buffer = Buffer.from(frameBuffer)
    const stream = session.ffmpeg.stdin
    const canContinue = stream.write(buffer)
    if (!canContinue) {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          stream.removeListener('drain', onDrain)
          stream.removeListener('error', onError)
        }
        const onDrain = () => {
          cleanup()
          resolve()
        }
        const onError = (err) => {
          cleanup()
          reject(err)
        }
        stream.once('drain', onDrain)
        stream.once('error', onError)
      })
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || String(err) }
  }
})

ipcMain.handle('export:finishFramePipe', async (event, sessionId) => {
  const session = activeFramePipeExports.get(sessionId)
  if (!session) {
    return { success: false, error: 'Frame pipe session not found.' }
  }

  try {
    if (!session.getClosed()) {
      session.ffmpeg.stdin.end()
    }
    await session.closePromise
    activeFramePipeExports.delete(sessionId)
    if (session.getError()) {
      return { success: false, error: session.getError().message || String(session.getError()), encoderUsed: session.encoderUsed }
    }
    if (session.getCloseCode() !== 0) {
      return {
        success: false,
        error: session.getStderr() || `FFmpeg exited with code ${session.getCloseCode()}`,
        encoderUsed: session.encoderUsed,
      }
    }
    return { success: true, encoderUsed: session.encoderUsed }
  } catch (err) {
    activeFramePipeExports.delete(sessionId)
    return { success: false, error: err.message || String(err), encoderUsed: session.encoderUsed }
  }
})

ipcMain.handle('export:abortFramePipe', async (event, sessionId) => {
  const session = activeFramePipeExports.get(sessionId)
  if (!session) return { success: true }
  activeFramePipeExports.delete(sessionId)
  try {
    if (!session.ffmpeg.killed) {
      session.ffmpeg.kill('SIGKILL')
    }
  } catch {
    // ignore abort errors
  }
  return { success: true }
})

ipcMain.handle('export:muxAudioVideo', async (event, options = {}) => {
  const {
    videoPath,
    audioPath,
    outputPath,
    format = 'mp4',
    duration = null,
    audioCodec = 'aac',
    audioBitrateKbps = 192,
    audioSampleRate = 44100,
  } = options

  if (!getFfmpegPath()) {
    return { success: false, error: 'FFmpeg binary not available.' }
  }
  if (!videoPath || !outputPath) {
    return { success: false, error: 'Missing mux inputs.' }
  }

  const args = ['-y', '-i', videoPath]
  if (audioPath) {
    args.push('-i', audioPath)
  }
  if (duration) {
    args.push('-t', String(duration))
  }
  args.push('-map', '0:v:0')
  if (audioPath) {
    args.push('-map', '1:a:0', '-c:v', 'copy')
    appendExportAudioEncoderArgs(args, { format, audioCodec, audioBitrateKbps, audioSampleRate })
  } else {
    args.push('-c:v', 'copy')
  }
  if (format === 'mp4') {
    args.push('-movflags', '+faststart')
  }
  args.push(outputPath)

  return await new Promise((resolve) => {
    const ffmpeg = spawn(getFfmpegPath(), args, { windowsHide: true })
    let stderr = ''

    ffmpeg.stderr.on('data', (data) => {
      stderr = appendLimitedStderr(stderr, data)
    })

    ffmpeg.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true })
      } else {
        resolve({ success: false, error: stderr || `FFmpeg exited with code ${code}` })
      }
    })
  })
})

// ============================================
// Playback cache (Flame-style: transcode for smooth playback)
// ============================================
ipcMain.handle('playback:transcode', async (event, { inputPath, outputPath }) => {
  if (!getFfmpegPath()) {
    return { success: false, error: 'FFmpeg binary not available.' }
  }
  if (!inputPath || !outputPath) {
    return { success: false, error: 'Missing inputPath or outputPath.' }
  }

  // Same dimensions, H.264, keyframe every 6 frames, no B-frames = easy decode
  const args = [
    '-y',
    '-i', inputPath,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-g', '6',
    '-keyint_min', '6',
    '-bf', '0',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '192k',
    outputPath
  ]

  return await new Promise((resolve) => {
    const ffmpeg = spawn(getFfmpegPath(), args, { windowsHide: true })
    let stderr = ''

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    ffmpeg.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true })
      } else {
        resolve({ success: false, error: stderr || `FFmpeg exited with code ${code}` })
      }
    })
  })
})

// ============================================
// Proxy cache (NLE-style: low-res preview proxies)
//
// Separate from the playback cache above. The playback cache keeps source
// resolution so single-layer preview is smooth; the proxy cache drops to
// a short dimension (default 540px) so multi-layer timelines with heavy
// effect stacks decode a fraction of the pixels. Export never uses these.
// ============================================
ipcMain.handle('proxy:transcode', async (event, { inputPath, outputPath, targetHeight = 540 }) => {
  if (!getFfmpegPath()) {
    return { success: false, error: 'FFmpeg binary not available.' }
  }
  if (!inputPath || !outputPath) {
    return { success: false, error: 'Missing inputPath or outputPath.' }
  }

  // scale=-2:H → preserve aspect, force-even width (H.264 requirement).
  // veryfast + crf 28 gives small files (~1/4 playback-cache size) and
  // keeps ffmpeg fast enough to run in the background at import time.
  // Keyframe every 6 frames matches the playback cache so scrubbing is
  // identical across both tiers.
  const scaleFilter = `scale=-2:${Math.max(180, Math.min(1080, Number(targetHeight) || 540))}`
  const args = [
    '-y',
    '-i', inputPath,
    '-vf', scaleFilter,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '28',
    '-g', '6',
    '-keyint_min', '6',
    '-bf', '0',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '128k',
    outputPath
  ]

  return await new Promise((resolve) => {
    const ffmpeg = spawn(getFfmpegPath(), args, { windowsHide: true })
    let stderr = ''

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    ffmpeg.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true })
      } else {
        resolve({ success: false, error: stderr || `FFmpeg exited with code ${code}` })
      }
    })
  })
})

ipcMain.handle('export:checkNvenc', async () => {
  const gpuName = await detectNvidiaGpuName()
  await refreshPreferredFfmpegPath()

  const activeFfmpegPath = getFfmpegPath()
  if (!activeFfmpegPath) {
    return { available: false, h264: false, h265: false, gpuName, error: 'FFmpeg binary not available.' }
  }

  const result = await detectFfmpegEncoders(activeFfmpegPath)
  if (!result.success) {
    return { available: false, h264: false, h265: false, gpuName, error: result.error || 'Could not inspect FFmpeg encoders.' }
  }

  const hasH264 = result.output.includes('h264_nvenc')
  const hasH265 = result.output.includes('hevc_nvenc')
  return {
    available: hasH264 || hasH265,
    h264: hasH264,
    h265: hasH265,
    gpuName,
    ffmpegPath: activeFfmpegPath,
    ffmpegSource: preferredFfmpegSource,
  }
})

// ============================================
// App Lifecycle
// ============================================

app.whenReady().then(() => {
  registerFileProtocol()
  refreshPreferredFfmpegPath().catch((error) => {
    console.warn('[Export] FFmpeg capability check failed:', error?.message || error)
  })
  initComfyLauncher()
    .then(() => maybeAutoStartComfyLauncher())
    .catch((error) => {
      console.warn('[comfyLauncher] init failed:', error?.message || error)
    })
  const splash = createSplashWindow()
  splash.webContents.once('did-finish-load', () => {
    runStartupChecks()
      .then(async () => {
        await createWindow()
        if (splashWindow && !splashWindow.isDestroyed()) {
          splashWindow.close()
          splashWindow = null
        }
      })
      .catch(async (err) => {
        console.error('Startup checks failed:', err)
        await createWindow()
        if (splashWindow && !splashWindow.isDestroyed()) {
          splashWindow.close()
          splashWindow = null
        }
      })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((error) => {
        console.error('Failed to create window:', error)
      })
    }
  })
})

app.on('before-quit', async (event) => {
  if (launcherQuitConfirmed) return
  const state = comfyLauncher.getState()
  const ownsRunning = state.ownership === 'ours' && (state.state === 'running' || state.state === 'starting')
  if (!ownsRunning) return

  event.preventDefault()
  try {
    const choice = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : null, {
      type: 'question',
      buttons: ['Stop ComfyUI & quit', 'Leave ComfyUI running', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Quit ComfyStudio?',
      message: 'ComfyUI is still running.',
      detail: 'ComfyStudio started ComfyUI. Choose what happens to it when you quit.\n\n• Stop ComfyUI & quit — shuts down ComfyUI and cancels any in-flight generation jobs.\n• Leave ComfyUI running — ComfyStudio will quit but ComfyUI stays up. Handy when you\'re just relaunching ComfyStudio and don\'t want to wait for ComfyUI to boot again.',
    })
    if (choice.response === 2) {
      return
    }
    if (choice.response === 1) {
      await comfyLauncher.detach()
    } else {
      await comfyLauncher.shutdown({ confirmStop: true })
    }
  } catch (error) {
    console.warn('[comfyLauncher] before-quit shutdown error:', error?.message || error)
  }
  launcherQuitConfirmed = true
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Handle any uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
})
