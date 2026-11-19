import { parseLocalComfyPortInput, saveLocalComfyConnectionPort } from './localComfyConnection.js'

const unavailable = 'Fully quit and reopen Velorn to enable connection discovery. You can still enter the port in ComfyUI Connection settings.'
const bridge = () => globalThis.window?.electronAPI?.comfyLauncher

export async function discoverRunningComfy() {
  try {
    if (!bridge()?.discoverConnections) return { success: false, error: unavailable, connections: [] }
    return await bridge().discoverConnections()
  } catch (error) {
    return { success: false, error: error?.message || 'Could not look for ComfyUI.', connections: [] }
  }
}

function assertCanSwitch(state, port) {
  if (!state) throw new Error('Could not check the current launcher. Refresh its status before switching connections.')
  if (!['ours', 'app'].includes(state.ownership) || !['running', 'starting', 'stopping'].includes(state.state)) return
  let currentPort
  try { currentPort = Number(new URL(state.httpBase).port) } catch { /* fail closed below */ }
  if (currentPort !== port) {
    throw new Error('Velorn is managing another ComfyUI connection. Stop it before switching ports, or keep the current connection.')
  }
}

// No launching or process adoption here. Re-test an explicitly selected
// endpoint before saving; a failed probe or write preserves the old setting.
export async function connectRunningComfy(input, { isCurrent } = {}) {
  const current = () => {
    try { return isCurrent === undefined || (typeof isCurrent === 'function' && isCurrent() === true) }
    catch { return false }
  }
  const cancelled = () => ({ success: false, cancelled: true })
  if (!current()) return cancelled()
  const parsed = parseLocalComfyPortInput(input)
  if (!parsed.success) return parsed
  const api = bridge()
  if (!api?.probeConnection || !api?.getState) return { success: false, error: unavailable }
  try {
    const initialState = await api.getState()
    if (!current()) return cancelled()
    assertCanSwitch(initialState, parsed.port)
    const probe = await api.probeConnection({ port: parsed.port })
    if (!current()) return cancelled()
    if (!probe?.success || probe.connection?.port !== parsed.port) {
      return { success: false, error: probe?.error || 'ComfyUI is no longer available. Open it and try again.' }
    }
    const latestState = await api.getState()
    if (!current()) return cancelled()
    assertCanSwitch(latestState, parsed.port)
    const result = await saveLocalComfyConnectionPort(parsed.port, { isCurrent: current })
    // Persistence rechecks inside its queue. Once native save starts, report
    // its actual result; closing the guide cannot roll that write back.
    return result.success ? { ...result, connection: probe.connection } : result
  } catch (error) {
    if (!current()) return cancelled()
    return { success: false, error: error?.message || 'Could not connect to ComfyUI.' }
  }
}
