/**
 * Renderer-side client for the ComfyUI process launcher. Mirrors the IPC API
 * exposed by electron/comfyLauncher.js, with a small pub/sub layer so multiple
 * React components can share a single state subscription.
 */

import { useEffect, useState } from 'react'

const LOG_RING_MAX = 2000

const INITIAL_STATE = Object.freeze({
  state: 'unknown',
  ownership: 'none',
  pid: null,
  startedAt: 0,
  stoppedAt: 0,
  exitCode: null,
  exitSignal: null,
  uptimeMs: 0,
  launcherMode: 'script',
  launcherScript: '',
  macAppPath: '',
  macAppLaunchHidden: true,
  httpBase: '',
  statusMessage: '',
  error: '',
  logFilePath: '',
  probingSince: 0,
})

const INITIAL_CONFIG = Object.freeze({
  launcherMode: 'script',
  launcherScript: '',
  macAppPath: '',
  macAppLaunchHidden: true,
  autoStart: false,
  stopOnQuit: false,
  startupTimeoutMs: 120_000,
  extraArgs: '',
  disableAutoLaunch: true,
})

function getBridge() {
  return typeof window !== 'undefined' ? window.electronAPI?.comfyLauncher : null
}

let currentState = { ...INITIAL_STATE }
let currentConfig = { ...INITIAL_CONFIG }
const logBuffer = []
const stateListeners = new Set()
const logListeners = new Set()
let ipcStateUnsubscribe = null
let ipcLogUnsubscribe = null
let bootstrapPromise = null

function cloneState() { return { ...currentState } }
function cloneConfig() { return { ...currentConfig } }

function notifyState() {
  const snapshot = cloneState()
  stateListeners.forEach((cb) => {
    try { cb(snapshot) } catch (error) { console.warn('[comfyLauncher] state listener error:', error) }
  })
}

function notifyLog(entry) {
  logListeners.forEach((cb) => {
    try { cb(entry) } catch (error) { console.warn('[comfyLauncher] log listener error:', error) }
  })
}

async function ensureBootstrap() {
  if (bootstrapPromise) return bootstrapPromise
  const bridge = getBridge()
  if (!bridge) {
    bootstrapPromise = Promise.resolve()
    return bootstrapPromise
  }

  bootstrapPromise = (async () => {
    try {
      const [state, config, logs] = await Promise.all([
        bridge.getState?.(),
        bridge.getConfig?.(),
        bridge.getLogs?.({ tailLines: 500 }),
      ])
      if (state) { currentState = { ...INITIAL_STATE, ...state } }
      if (config) { currentConfig = { ...INITIAL_CONFIG, ...config } }
      if (Array.isArray(logs)) {
        logBuffer.length = 0
        logBuffer.push(...logs)
      }
    } catch (error) {
      console.warn('[comfyLauncher] bootstrap failed:', error)
    }

    ipcStateUnsubscribe = bridge.onState?.((next) => {
      if (!next) return
      currentState = { ...INITIAL_STATE, ...next }
      notifyState()
    }) || null

    ipcLogUnsubscribe = bridge.onLog?.((entry) => {
      if (!entry) return
      logBuffer.push(entry)
      if (logBuffer.length > LOG_RING_MAX) {
        logBuffer.splice(0, logBuffer.length - LOG_RING_MAX)
      }
      notifyLog(entry)
    }) || null
  })()

  return bootstrapPromise
}

export function isComfyLauncherAvailable() {
  return Boolean(getBridge())
}

export function subscribeComfyLauncherState(callback) {
  if (typeof callback !== 'function') return () => {}
  stateListeners.add(callback)
  ensureBootstrap().then(() => {
    try { callback(cloneState()) } catch (_) { /* ignore */ }
  })
  return () => { stateListeners.delete(callback) }
}

export function subscribeComfyLauncherLogs(callback) {
  if (typeof callback !== 'function') return () => {}
  logListeners.add(callback)
  ensureBootstrap()
  return () => { logListeners.delete(callback) }
}

export function getComfyLauncherSnapshot() {
  return cloneState()
}

export function getComfyLauncherLogs() {
  return logBuffer.slice()
}

export function getComfyLauncherConfig() {
  return cloneConfig()
}

export async function startComfyLauncher() {
  const bridge = getBridge()
  if (!bridge?.start) return { success: false, error: 'Electron bridge unavailable.' }
  return bridge.start()
}

export async function stopComfyLauncher() {
  const bridge = getBridge()
  if (!bridge?.stop) return { success: false, error: 'Electron bridge unavailable.' }
  return bridge.stop()
}

export async function restartComfyLauncher() {
  const bridge = getBridge()
  if (!bridge?.restart) return { success: false, error: 'Electron bridge unavailable.' }
  return bridge.restart()
}

export async function refreshComfyLauncher() {
  const bridge = getBridge()
  if (!bridge?.refresh) return null
  const state = await bridge.refresh()
  if (state) {
    currentState = { ...INITIAL_STATE, ...state }
    notifyState()
  }
  return state
}

export async function openComfyLauncherLogFile() {
  const bridge = getBridge()
  if (!bridge?.openLogFile) return { success: false, error: 'Electron bridge unavailable.' }
  return bridge.openLogFile()
}

export async function pickComfyLauncherScript() {
  const bridge = getBridge()
  if (!bridge?.pickLauncherScript) return { success: false, error: 'Electron bridge unavailable.' }
  const result = await bridge.pickLauncherScript()
  if (result?.success && result.filePath) {
    await updateComfyLauncherConfig({ launcherMode: 'script', launcherScript: result.filePath })
  }
  return result
}

export async function pickComfyLauncherMacApp() {
  const bridge = getBridge()
  if (!bridge?.pickMacApp) return { success: false, error: 'Electron bridge unavailable.' }
  const result = await bridge.pickMacApp()
  if (result?.success && result.filePath) {
    await updateComfyLauncherConfig({ launcherMode: 'mac-app', macAppPath: result.filePath })
  }
  return result
}

export async function detectComfyLauncherCandidates(payload = {}) {
  const bridge = getBridge()
  if (!bridge?.detectLaunchers) return { success: false, candidates: [] }
  return bridge.detectLaunchers(payload)
}

export async function describeComfyLauncherPortOwner() {
  const bridge = getBridge()
  if (!bridge?.describePortOwner) return { pid: null, name: '', port: null }
  try {
    return await bridge.describePortOwner()
  } catch (error) {
    return { pid: null, name: '', port: null, error: error?.message || String(error) }
  }
}

export async function connectComfyLauncherExternal() {
  const bridge = getBridge()
  if (!bridge?.connectExternal) return { success: false, error: 'Electron bridge unavailable.' }
  try {
    const result = await bridge.connectExternal()
    if (result?.state) {
      currentState = { ...INITIAL_STATE, ...result.state }
      notifyState()
    }
    return result
  } catch (error) {
    return { success: false, error: error?.message || String(error) }
  }
}

export async function updateComfyLauncherConfig(partial) {
  const bridge = getBridge()
  if (!bridge?.setConfig) return { success: false, error: 'Electron bridge unavailable.' }
  const result = await bridge.setConfig(partial || {})
  if (result?.success && result.config) {
    currentConfig = { ...INITIAL_CONFIG, ...result.config }
  }
  return result
}

export async function fetchComfyLauncherLogsTail({ tailLines = 400 } = {}) {
  const bridge = getBridge()
  if (!bridge?.getLogs) return []
  const logs = await bridge.getLogs({ tailLines })
  if (Array.isArray(logs)) {
    logBuffer.length = 0
    logBuffer.push(...logs)
  }
  return logBuffer.slice()
}

/**
 * React hook: subscribe to launcher state + config. Returns { state, config }.
 */
export function useComfyLauncher() {
  const [state, setState] = useState(() => cloneState())
  const [config, setConfig] = useState(() => cloneConfig())

  useEffect(() => {
    let mounted = true
    const unsubState = subscribeComfyLauncherState((next) => {
      if (mounted) setState({ ...next })
    })
    ensureBootstrap().then(async () => {
      if (!mounted) return
      const bridge = getBridge()
      if (bridge?.getConfig) {
        try {
          const cfg = await bridge.getConfig()
          if (cfg && mounted) {
            currentConfig = { ...INITIAL_CONFIG, ...cfg }
            setConfig(cloneConfig())
          }
        } catch (_) { /* ignore */ }
      }
    })
    return () => {
      mounted = false
      unsubState()
    }
  }, [])

  return { state, config, setConfig }
}

/**
 * Resolve once the launcher reaches any of the target states, or when the
 * timeout elapses. Returns { state, timedOut }.
 */
export function waitForComfyLauncherState(targetStates, { timeoutMs = 180_000 } = {}) {
  const targets = Array.isArray(targetStates) ? targetStates : [targetStates]
  return new Promise((resolve) => {
    const initial = getComfyLauncherSnapshot()
    if (targets.includes(initial.state)) {
      resolve({ state: initial, timedOut: false })
      return
    }
    let timer = null
    let unsub = null
    const finish = (state, timedOut) => {
      if (timer) { clearTimeout(timer); timer = null }
      if (unsub) { unsub(); unsub = null }
      resolve({ state, timedOut })
    }
    unsub = subscribeComfyLauncherState((next) => {
      if (targets.includes(next.state)) finish(next, false)
    })
    timer = setTimeout(() => finish(getComfyLauncherSnapshot(), true), Math.max(5_000, Number(timeoutMs) || 180_000))
  })
}

export function cleanupComfyLauncherBridges() {
  try { ipcStateUnsubscribe?.() } catch (_) { /* ignore */ }
  try { ipcLogUnsubscribe?.() } catch (_) { /* ignore */ }
  ipcStateUnsubscribe = null
  ipcLogUnsubscribe = null
  bootstrapPromise = null
  stateListeners.clear()
  logListeners.clear()
  logBuffer.length = 0
  currentState = { ...INITIAL_STATE }
  currentConfig = { ...INITIAL_CONFIG }
}
