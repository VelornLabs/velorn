// Real optional setup UI, isolated from App startup and real user profiles.
// All native operations are explicit RAM fixtures: no CLI, login, network,
// files, provider requests, software/model installation or project IO.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { I18nProvider } from '../../src/i18n/I18nContext'

const clone = value => value === undefined ? undefined : structuredClone(value)
const calls = [], forbiddenCalls = []
const welcomeMode = new URLSearchParams(window.location.search).has('welcome')
const storage = new Map(Object.entries(welcomeMode ? {} : window.__optionalSetupStorage || {
  'comfystudio-comfy-connection': JSON.stringify({ port: 8188 }),
  'fixture-agent-preferences': JSON.stringify({ provider: 'lmstudio', model: 'saved-model', thinking: 'high' }),
  'fixture-chat-history': JSON.stringify([{ id: 'saved-chat', messages: [{ role: 'user', content: 'Keep my project history.' }] }]),
}))
const settings = clone(welcomeMode ? { comfyConnection: { host: '127.0.0.1', port: 8188 } } : window.__optionalSetupSettings || {
  comfyConnection: { host: '127.0.0.1', port: 8188 },
  agent: { provider: 'lmstudio', model: 'saved-model', thinking: 'high' },
  editor: { project: 'saved-project', timeline: [{ id: 'clip-to-preserve', duration: 12 }] },
})
const connection = port => ({ port, httpBase: `http://127.0.0.1:${port}`, deviceNames: ['Synthetic test GPU'] })
const statuses = {
  codex: { success: true, integration: 'codex', state: 'missing', summary: 'Codex CLI was not found. Install it only if you want to use a desktop agent.', nextActions: ['install', 'detect'] },
  lmstudio: { success: true, integration: 'lmstudio', state: 'unavailable', summary: 'LM Studio server is not responding. It may be stopped; this does not tell us whether LM Studio is installed.', nextActions: ['start-server', 'check'] },
  comfyui: { success: true, integration: 'comfyui', state: 'unavailable', summary: 'No running ComfyUI connection found.', connections: [], configuredPort: 8188, nextActions: ['open-comfyui', 'check'] },
}
let pendingLogin = null, loginResult = { success: true }, probeFailure = '', saveFailure = '', launcher = { ownership: 'none', state: 'stopped', httpBase: 'http://127.0.0.1:8188' }
let executableResult = { success: true, executable: { available: true, mode: 'automatic', path: '/fixture-only/codex' } }
const pendingInspects = new Map(), heldInspects = new Set()
const installerPlans = {}, installerJobs = new Map(), pendingSetup = new Map(), heldSetup = new Set()
let installerSequence = 0, installerDownloadResult = null, installerStatusFailure = '', installerOpenResult = { success: true, opened: true }
const setupPlan = integration => ({
  success: true, planId: `synthetic-plan-${integration}`, integration, name: integration === 'lmstudio' ? 'LM Studio' : 'ComfyUI',
  host: { platform: 'darwin', arch: 'arm64', memoryGiB: 24 }, readiness: { state: 'unavailable', summary: 'Synthetic local server is not running. Installation has not been verified.' },
  installation: { found: false, summary: 'No application found in the checked standard locations. Other locations were not searched.' },
  download: { supported: true, sourceUrl: integration === 'lmstudio' ? 'https://lmstudio.ai/synthetic-only/installer.dmg' : 'https://download.comfy.org/synthetic-only/installer.dmg', bytes: 400000000, maxBytes: 500000000, destination: `/synthetic-only/Downloads/${integration}-installer.dmg`, canDownload: true },
  steps: ['Download the reviewed official installer after native confirmation.', 'Open the installer yourself and follow its OS prompts.', 'Choose any models in the vendor app only after reviewing size, license and disk use.', 'Start the local server and check setup again.'],
  warnings: ['An installer download does not prove installation or model compatibility.'], expiresAt: Date.now() + 5 * 60000,
  ...clone(installerPlans[integration]),
})
const waitSetup = async method => { if (heldSetup.has(method)) await new Promise(resolve => pendingSetup.set(method, resolve)) }
const record = (method, payload) => calls.push({ method, ...clone(payload) })
const forbid = name => async (...args) => { forbiddenCalls.push({ name, args }); throw Error(`Forbidden fixture operation: ${name}`) }
Object.defineProperty(window, 'localStorage', { value: {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key),
  clear: () => { forbiddenCalls.push({ name: 'clear-storage' }); throw Error('Profile wiping is forbidden') },
  key: index => [...storage.keys()][index] ?? null,
  get length() { return storage.size },
} })
window.electronAPI = {
  isElectron: true,
  platform: 'darwin',
  optionalSetup: {
    inspect: async payload => {
      record('inspect', payload)
      const result = clone(statuses[payload.integration])
      if (heldInspects.has(payload.integration)) await new Promise(resolve => pendingInspects.set(payload.integration, resolve))
      if (result.success && payload.integration === 'comfyui') result.configuredPort = settings.comfyConnection.port
      return result
    },
  },
  toolSetup: {
    plan: async payload => {
      record('toolSetup.plan', payload)
      const result = setupPlan(payload.integration)
      await waitSetup('plan')
      return result
    },
    download: async payload => {
      record('toolSetup.download', payload)
      await waitSetup('download')
      if (installerDownloadResult) return clone(installerDownloadResult)
      const integration = payload.planId.endsWith('lmstudio') ? 'lmstudio' : 'comfyui'
      const job = { success: true, jobId: `synthetic-installer-${++installerSequence}`, integration, state: 'downloading', bytesReceived: 1000000, totalBytes: 400000000, canOpen: false }
      installerJobs.set(job.jobId, job)
      return clone(job)
    },
    status: async payload => {
      record('toolSetup.status', payload)
      const result = installerStatusFailure ? { success: false, error: installerStatusFailure } : clone(installerJobs.get(payload.jobId) || { success: false, error: 'Unknown synthetic download.' })
      await waitSetup('status')
      return result
    },
    cancel: async payload => {
      record('toolSetup.cancel', payload)
      const job = installerJobs.get(payload.jobId)
      if (!job) return { success: false, error: 'Unknown synthetic download.' }
      job.state = 'cancelled'; job.canOpen = false
      return clone(job)
    },
    open: async payload => { record('toolSetup.open', payload); await waitSetup('open'); return clone(installerOpenResult) },
  },
  connectedAgent: {
    codexLogin: async payload => {
      record('codexLogin', payload)
      if (payload.action === 'start') {
        return new Promise(resolve => { pendingLogin = resolve })
      }
      if (payload.action === 'cancel') {
        const resolve = pendingLogin; pendingLogin = null
        resolve?.({ success: false, code: 'CODEX_LOGIN_CANCELLED', error: 'Sign-in cancelled.' })
        return { success: true, cancelled: true }
      }
      throw Error('Unexpected login action')
    },
    codexExecutable: async payload => {
      record('codexExecutable', payload)
      return clone(executableResult)
    },
    send: forbid('send'), setFullAccess: forbid('setFullAccess'),
  },
  openExternalUrl: async url => { record('openExternalUrl', { url }); return { success: true } },
  getSetting: async key => { record('getSetting', { key }); return clone(settings[key]) },
  setSetting: async (key, value) => {
    record('setSetting', { key, value })
    if (key !== 'comfyConnection') return forbid('unexpected-settings-write')(key, value)
    if (saveFailure) return { success: false, error: saveFailure }
    settings[key] = clone(value)
    return { success: true }
  },
  comfyLauncher: {
    getState: async () => { record('getLauncherState'); return clone(launcher) },
    getConfig: async () => ({ autoStart: false, disableAutoLaunch: true }),
    getLogs: async () => [],
    refresh: async () => { record('refreshLauncher'); return clone(launcher) },
    probeConnection: async payload => {
      record('probeConnection', payload)
      return probeFailure ? { success: false, error: probeFailure } : { success: true, connection: connection(payload.port) }
    },
    start: forbid('startComfyUI'), stop: forbid('stopComfyUI'), restart: forbid('restartComfyUI'),
  },
  executeCommand: forbid('executeCommand'), install: forbid('install'),
}
const { ManualToolSetup: OptionalSetup, OptionalSetupDialog } = await import('../../src/components/OptionalSetup.jsx')
const { getLocalComfyConnectionSync } = await import('../../src/services/localComfyConnection.js')
let WelcomeScreen, useProjectStore
if (welcomeMode) {
  // Exercise the actual first-run and normal Welcome branches. Replace only
  // filesystem-facing store actions with deterministic RAM dialog outcomes.
  ;({ default: useProjectStore } = await import('../../src/stores/projectStore'))
  useProjectStore.setState({
    isFirstRun: true, isLoading: false, error: '', currentProject: null,
    defaultProjectsHandle: null, defaultProjectsLocation: null, recentProjects: [], showHeroBackground: false,
    checkBrowserSupport: () => true,
    isElectronMode: () => true,
    getRecentProjectsList: async () => [],
    selectDefaultProjectsLocation: async () => {
      record('selectProjectsFolder')
      useProjectStore.setState({ isFirstRun: false, defaultProjectsHandle: '/synthetic-only/projects', defaultProjectsLocation: '/synthetic-only/projects' })
    },
    openProjectFromPicker: async () => {
      record('openProjectPicker')
      useProjectStore.setState({ currentProject: { id: 'synthetic-open-project', name: 'Editor-only project' } })
    },
  })
  ;({ default: WelcomeScreen } = await import('../../src/components/WelcomeScreen.jsx'))
}
window.optionalSetupTest = {
  ready: true,
  snapshot: () => ({ calls: clone(calls), forbiddenCalls: clone(forbiddenCalls), storage: Object.fromEntries(storage), settings: clone(settings), pendingLogin: Boolean(pendingLogin), pendingInspects: [...pendingInspects.keys()], pendingSetup: [...pendingSetup.keys()], installerJobs: [...installerJobs.values()].map(clone), connection: getLocalComfyConnectionSync() }),
  setStatus: (integration, value) => { statuses[integration] = clone({ integration, ...value }) },
  setProbeFailure: value => { probeFailure = value },
  setSaveFailure: value => { saveFailure = value },
  setLauncher: value => { launcher = clone(value) },
  setLoginResult: value => { loginResult = clone(value) },
  setExecutableResult: value => { executableResult = clone(value) },
  releaseLogin: () => { const resolve = pendingLogin; pendingLogin = null; resolve?.(clone(loginResult)) },
  holdInspect: integration => heldInspects.add(integration),
  releaseInspect: integration => { heldInspects.delete(integration); const resolve = pendingInspects.get(integration); pendingInspects.delete(integration); resolve?.() },
  setInstallerPlan: (integration, value) => { installerPlans[integration] = clone(value) },
  setInstallerDownloadResult: value => { installerDownloadResult = clone(value) },
  setInstallerStatusFailure: value => { installerStatusFailure = value },
  setInstallerOpenResult: value => { installerOpenResult = clone(value) },
  updateInstallerJob: (integration, patch) => { for (const job of installerJobs.values()) if (job.integration === integration) Object.assign(job, clone(patch)) },
  holdSetup: method => heldSetup.add(method),
  releaseSetup: method => { heldSetup.delete(method); const resolve = pendingSetup.get(method); pendingSetup.delete(method); resolve?.() },
}
function Fixture() {
  const [editor, setEditor] = useState(false), [dialog, setDialog] = useState(false)
  const modalMode = new URLSearchParams(window.location.search).has('dialog')
  return <I18nProvider><main style={{ maxWidth: 1040, margin: '0 auto', padding: 24 }}>
    <h1 className="text-xl text-sf-text-primary">Optional setup fixture</h1>
    <button className="px-4 py-3 rounded border border-sf-dark-500 my-4" onClick={() => setEditor(true)}>Continue to editor</button>
    {editor ? <section aria-label="Editor fixture">Editor opened without agent or ComfyUI setup.</section>
      : modalMode ? <button onClick={() => setDialog(true)}>Set up optional tools</button> : <OptionalSetup />}
    {dialog && <OptionalSetupDialog initialView="manual" onClose={() => setDialog(false)} />}
  </main></I18nProvider>
}
function WelcomeFixture() {
  const currentProject = useProjectStore(state => state.currentProject)
  return <I18nProvider>{currentProject
    ? <section aria-label="Editor fixture">Editor opened without agent or ComfyUI setup.</section>
    : <WelcomeScreen />}</I18nProvider>
}
createRoot(document.getElementById('root')).render(welcomeMode ? <WelcomeFixture /> : <Fixture />)
