// Real guided UI and connection service; all native state is synthetic RAM.
// No real user profiles, accounts, processes, downloads, models or projects.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import '../../src/components/OptionalSetup.css'

const clone = value => value === undefined ? undefined : structuredClone(value)
const calls = [], forbiddenCalls = [], held = new Set(), pending = new Map()
const storage = new Map(Object.entries({
  'comfystudio-comfy-connection': JSON.stringify({ port: 8188 }),
  'fixture-agent-preferences': JSON.stringify({ provider: 'codex', model: 'existing-model', thinking: 'medium' }),
  'fixture-chat-history': JSON.stringify([{ id: 'unchanged-chat', messages: [{ role: 'user', content: 'Keep this history.' }] }]),
}))
const settings = {
  comfyConnection: { host: '127.0.0.1', port: 8188 },
  agent: { provider: 'codex', model: 'existing-model', thinking: 'medium', fullAccess: false },
  editor: { project: 'unchanged-project', timeline: [{ id: 'unchanged-clip', duration: 12 }] },
  account: { signedIn: false },
  generation: { spending: 'local-only', queue: [] },
}
let inspection = {
  success: true, integration: 'comfyui', state: 'unavailable', configuredPort: 8188,
  summary: 'No ComfyUI server responded on the checked local ports. It may be stopped or use another port; this does not prove it is uninstalled.',
  connections: [], nextActions: ['open-comfyui', 'check'],
}
let probeFailure = '', saveFailure = ''
let launcher = { ownership: 'none', state: 'stopped', httpBase: 'http://127.0.0.1:8188' }
let installerPlan = {
  success: true, planId: 'synthetic-comfyui-plan', integration: 'comfyui', name: 'ComfyUI',
  host: { platform: 'linux', arch: 'x64', memoryGiB: 16 },
  readiness: { state: 'unavailable', summary: 'No running server was found; installation was not verified.' },
  installation: { found: false, summary: 'No application found in the checked standard locations. Other locations were not searched.' },
  download: { supported: false, sourceUrl: null, bytes: null, maxBytes: 2000000000, destination: null, canDownload: false },
  steps: ['Use the official ComfyUI installation guide for Linux.', 'Review Python, GPU compatibility and model size before installing.', 'Start ComfyUI, then check the connection again.'],
  warnings: ['This plan does not install software or download models.'], expiresAt: Date.now() + 300000,
}
const record = (method, value = {}) => calls.push({ method, ...clone(value) })
const forbid = method => async (...args) => {
  forbiddenCalls.push({ method, args: clone(args) })
  throw new Error(`Forbidden fixture operation: ${method}`)
}
const wait = async method => {
  if (held.has(method)) await new Promise(resolve => pending.set(method, resolve))
}
Object.defineProperty(window, 'localStorage', { value: {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key),
  clear: () => { forbiddenCalls.push({ method: 'clear-storage' }); throw new Error('Profile wiping is forbidden') },
  key: index => [...storage.keys()][index] ?? null,
  get length() { return storage.size },
} })
window.electronAPI = {
  isElectron: true, platform: 'linux',
  optionalSetup: { inspect: async payload => {
    record('inspect', payload)
    const result = clone(inspection)
    await wait('inspect')
    return result
  } },
  comfyLauncher: {
    getState: async () => { record('getLauncherState'); await wait('getLauncherState'); return clone(launcher) },
    getConfig: async () => ({ autoStart: false, disableAutoLaunch: true }),
    getLogs: async () => [],
    refresh: async () => { record('refreshLauncher'); return clone(launcher) },
    probeConnection: async payload => {
      record('probeConnection', payload)
      await wait('probeConnection')
      return probeFailure ? { success: false, error: probeFailure }
        : { success: true, connection: { port: payload.port, httpBase: `http://127.0.0.1:${payload.port}`, deviceNames: ['Synthetic test GPU'] } }
    },
    start: forbid('startComfyUI'), stop: forbid('stopComfyUI'), restart: forbid('restartComfyUI'),
  },
  getSetting: async key => { record('getSetting', { key }); return clone(settings[key]) },
  setSetting: async (key, value) => {
    record('setSetting', { key, value }); await wait('setSetting')
    if (key !== 'comfyConnection') return forbid('unexpected-settings-write')(key, value)
    if (saveFailure) return { success: false, error: saveFailure }
    settings[key] = clone(value)
    return { success: true }
  },
  openExternalUrl: async url => { record('openExternalUrl', { url }); return { success: true } },
  toolSetup: {
    plan: async payload => { record('toolSetup.plan', payload); await wait('toolSetup.plan'); return clone(installerPlan) },
    download: forbid('toolSetup.download'), status: forbid('toolSetup.status'),
    open: forbid('toolSetup.open'), cancel: forbid('toolSetup.cancel'),
  },
  connectedAgent: { send: forbid('send'), setFullAccess: forbid('setFullAccess'), codexLogin: forbid('codexLogin') },
  executeCommand: forbid('executeCommand'), install: forbid('install'),
}
const { default: GuidedComfySetup } = await import('../../src/components/GuidedComfySetup.jsx')
const { default: OptionalSetup } = await import('../../src/components/OptionalSetup.jsx')
const { getLocalComfyConnectionSync } = await import('../../src/services/localComfyConnection.js')
const { beginLocalExportActivity, isExportBusy } = await import('../../src/stores/exportActivityStore.js')
let exportLease = null
window.guidedSetupTest = {
  ready: true,
  snapshot: () => ({ calls: clone(calls), forbiddenCalls: clone(forbiddenCalls), settings: clone(settings), storage: Object.fromEntries(storage),
    connection: getLocalComfyConnectionSync(), pending: [...pending.keys()], exportBusy: isExportBusy() }),
  setInspection: value => { inspection = clone({ integration: 'comfyui', ...value }) },
  setProbeFailure: value => { probeFailure = value },
  setSaveFailure: value => { saveFailure = value },
  setLauncher: value => { launcher = clone(value) },
  setInstallerPlan: value => { installerPlan = clone({ ...installerPlan, ...value }) },
  hold: method => held.add(method),
  release: method => { held.delete(method); const resolve = pending.get(method); pending.delete(method); resolve?.() },
  setExportBusy: value => {
    if (value && !exportLease) exportLease = beginLocalExportActivity({ label: 'Synthetic export guard' })
    if (!value && exportLease) { exportLease.end(); exportLease = null }
  },
}
function Fixture() {
  const [screen, setScreen] = useState('guided')
  const params = new URLSearchParams(location.search)
  const cloudEnabled = !params.has('without-cloud')
  const exit = destination => { record('navigate', { destination }); setScreen(destination) }
  const cloudSetup = cloudEnabled ? () => exit('cloud') : undefined
  return <main style={{ maxWidth: 820, margin: '0 auto', padding: 20 }}>
    <p style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12 }}>Isolated guided setup fixture · synthetic data only</p>
    {screen === 'guided' ? params.has('hub') ? <OptionalSetup onSkip={() => exit('editor')} onCloudSetup={cloudSetup} />
      : <GuidedComfySetup onBack={() => exit('hub')} onSkip={() => exit('editor')}
        onManual={() => exit('manual')} onCloudSetup={cloudSetup} />
      : <section aria-label={`${screen} fixture`}><h1>{screen === 'editor' ? 'Editor remains available' : `${screen} settings`}</h1>
        <button type="button" onClick={() => setScreen('guided')}>Reopen guided setup</button></section>}
  </main>
}
createRoot(document.getElementById('root')).render(<Fixture />)
