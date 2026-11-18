// Real setup/launcher UI; every native method is an in-memory mock. Never
// imports App, Electron preload, user settings, project data or process control.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { I18nProvider } from '../../src/i18n/I18nContext'
import ComfyConnectionSetup from '../../src/components/ComfyConnectionSetup'
import ComfyLauncherSettingsSection from '../../src/components/ComfyLauncherSettingsSection'
import ComfyLauncherChip from '../../src/components/ComfyLauncherChip'
import { getLocalComfyConnectionSync } from '../../src/services/localComfyConnection'

const query = new URLSearchParams(location.search)
const platform = query.get('platform') || 'linux'
const scenario = query.get('scenario') || 'multiple'
const surface = query.get('surface') || 'setup'
const clone = value => value === undefined ? undefined : structuredClone(value)
const calls = [], writes = [], configWrites = [], connectionEvents = [], forbiddenCalls = []
const settings = { comfyConnection: { host: '127.0.0.1', port: 8188 } }
let config = { launcherMode: 'script', launcherScript: '', macAppPath: '', macAppLaunchHidden: true,
  autoStart: false, stopOnQuit: true, startupTimeoutMs: 120000, extraArgs: '', disableAutoLaunch: true }
let state = { state: 'idle', ownership: 'none', pid: null, httpBase: 'http://127.0.0.1:8188',
  statusMessage: 'ComfyUI is not running.', launcherMode: 'script', launcherScript: '', macAppPath: '' }
if (scenario === 'managed') {
  config.launcherScript = '/fixture-only/run-comfy.sh'
  state = { ...state, state: 'running', ownership: 'ours', pid: 424242, launcherScript: config.launcherScript,
    statusMessage: 'Synthetic managed ComfyUI is running.' }
}
const listeners = new Set()
const record = (method, payload) => calls.push({ method, payload: clone(payload) })
const connection = port => ({ port, httpBase: `http://127.0.0.1:${port}`,
  deviceNames: [port === 8189 ? 'Fixture RTX 5090' : port === 8188 ? 'Fixture CPU' : 'Fixture custom GPU'] })
const launchers = [
  { launcherMode: 'mac-app', path: '/Applications/Fixture ComfyUI.app', label: 'Fixture ComfyUI.app' },
  { launcherMode: 'script', path: platform === 'win32' ? 'C:\\Fixture\\run-comfy.bat' : '/fixture-only/run-comfy.sh', label: 'Fixture launch script' },
]
const forbidden = method => async payload => {
  record(method, payload)
  forbiddenCalls.push(method)
  throw new Error(`The isolated fixture forbids process action: ${method}`)
}
const comfyLauncher = {
  async getState() { record('getState'); return clone(state) },
  async getConfig() { record('getConfig'); return clone(config) },
  async getLogs(payload) { record('getLogs', payload); return [] },
  async refresh() { record('refresh'); return clone(state) },
  onState(callback) { listeners.add(callback); return () => listeners.delete(callback) },
  onLog() { return () => {} },
  async detectLaunchers(payload) { record('detectLaunchers', payload); return { success: true, candidates: clone(launchers) } },
  async discoverConnections(payload) {
    record('discoverConnections', payload)
    return { success: true, connections: scenario === 'none' ? [] : [connection(8188), connection(8189)], checkedPorts: [8188, 8189, 8000] }
  },
  async probeConnection(payload) {
    record('probeConnection', payload)
    if (scenario === 'managed-probe-race') {
      state = { ...state, state: 'running', ownership: 'ours', pid: 424242,
        statusMessage: 'Synthetic managed instance started during the probe.' }
    }
    return scenario === 'probe-failure'
      ? { success: false, error: 'Fixture probe failed: this port is not a ComfyUI server.' }
      : { success: true, connection: connection(Number(payload.port)) }
  },
  async setConfig(partial) {
    record('setConfig', partial)
    configWrites.push(clone(partial))
    config = { ...config, ...partial }
    return { success: true, config: clone(config) }
  },
  async pickLauncherScript() { record('pickLauncherScript'); return { success: false, cancelled: true } },
  async pickMacApp() { record('pickMacApp'); return { success: false, cancelled: true } },
  async openLogFile() { record('openLogFile'); return { success: true } },
  async describePortOwner() { record('describePortOwner'); return { pid: null, name: '', port: 8188 } },
  start: forbidden('start'), stop: forbidden('stop'), restart: forbidden('restart'), connectExternal: forbidden('connectExternal'),
}
if (scenario === 'missing-api') { delete comfyLauncher.discoverConnections; delete comfyLauncher.probeConnection }
window.electronAPI = {
  platform, comfyLauncher,
  async getSetting(key) { record('getSetting', key); return clone(key ? settings[key] : settings) },
  async setSetting(key, value) {
    record('setSetting', { key, value })
    writes.push({ key, value: clone(value) })
    if (scenario === 'save-failure') return { success: false, error: 'Fixture settings save failed.' }
    if (scenario === 'save-throw') throw new Error('Fixture settings save threw.')
    settings[key] = clone(value)
    return { success: true }
  },
  async openExternal(url) { record('openExternal', url); return { success: true } },
}
window.addEventListener('comfystudio-comfy-connection-changed', event => connectionEvents.push(clone(event.detail)))
window.comfySetupTest = {
  ready: false,
  snapshot: () => ({ platform, scenario, surface, calls: clone(calls), writes: clone(writes), configWrites: clone(configWrites),
    settings: clone(settings), config: clone(config), state: clone(state), connectionEvents: clone(connectionEvents),
    connection: getLocalComfyConnectionSync(), localConnection: localStorage.getItem('comfystudio-comfy-connection'),
    forbiddenCalls: clone(forbiddenCalls), text: document.getElementById('fixture-surface')?.innerText || '' }),
  emitState(partial) { state = { ...state, ...partial }; for (const callback of listeners) callback(clone(state)) },
}

function Fixture() {
  React.useEffect(() => { window.comfySetupTest.ready = true }, [])
  return <main className="min-h-screen bg-sf-dark-950 p-6 text-sf-text-primary">
    <header className="mx-auto mb-6 max-w-3xl border-b border-sf-dark-700 pb-4">
      <h1 className="text-lg font-semibold">Velorn · isolated ComfyUI setup</h1>
      <p className="mt-1 text-xs text-sf-text-muted">{platform} / {surface} / {scenario} · synthetic responses only; no real server or settings access</p>
    </header>
    <section id="fixture-surface" className={`mx-auto ${surface === 'chip' || surface === 'compact' ? 'max-w-md' : 'max-w-3xl'}`}>
      {surface === 'settings' ? <ComfyLauncherSettingsSection onOpenLogViewer={() => record('openLogViewer')} />
        : surface === 'chip' ? <ComfyLauncherChip />
          : <ComfyConnectionSetup compact={surface === 'compact'} />}
    </section>
  </main>
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>)
