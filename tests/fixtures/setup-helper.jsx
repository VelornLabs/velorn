// Real optional helper UI with RAM-only native responses. Never contacts a
// provider, project, account, user settings, filesystem, process or installer.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../../src/i18n/I18nContext'
import '../../src/index.css'

const clone = value => value === undefined ? undefined : structuredClone(value)
const calls = [], forbidden = [], held = new Set(), pending = new Map()
const params = new URLSearchParams(location.search)
if (params.has('hold-status')) held.add('status')
let status = { success: true, available: !params.has('unavailable'), mode: params.has('unavailable') ? 'unavailable' : 'internal-api', model: 'gpt-6-luna', reason: '' }
let response = { success: true, text: 'I can help you connect this tool. Open the setup checks when you are ready.', actions: [], checks: [], remainingTurns: 7 }
let actionResponse = { success: true, summary: 'Synthetic native action completed. Server readiness has not been verified.' }
let inspectResponse = { success: true, state: 'unavailable', summary: 'Synthetic setup check: server not responding.', configuredPort: 8188, connections: [] }
let actionGestureInactive = false
const HOSTED_FAKE = 'synthetic-PRIVATE_HOSTED_KEY_CANARY-not-a-real-key'
let hostedState = 'missing', hostedConfigured = false, hostedRemembered = false, hostedCheckState = 'verified', storedHostedReply = false
const hostedStatus = () => ({ state: hostedState, configured: hostedConfigured, remembered: hostedRemembered, canRemember: true, summary: 'Synthetic hosted account status.' })
const hostedEvidence = () => ({ integration: 'comfycloud', state: hostedState, configured: hostedConfigured, evidence: 'stored-account-check', summary: 'Stored hosted account status from the previous explicit account check. No new cloud request was sent.' })
const settings = { agent: { provider: params.has('already-local') ? 'lmstudio' : 'codex', model: 'existing-model' }, project: { name: 'PRIVATE_PROJECT_CANARY', path: '/synthetic/private-project', clips: ['PRIVATE_CLIP_CANARY'] }, generation: { policy: 'local-only' }, comfyConnection: { port: 8189 } }
const storage = new Map([['project-chat', 'PRIVATE_CHAT_CANARY'], ['comfystudio-comfy-connection', JSON.stringify(settings.comfyConnection)]])
const launcherConfig = { launcherMode: 'script', launcherScript: '/synthetic/PRIVATE_LAUNCHER_CANARY/start.sh', autoStart: false, stopOnQuit: true, startupTimeoutMs: 120000, extraArgs: '', disableAutoLaunch: true }
const launcherState = { state: params.has('comfy-external') ? 'external' : 'running', ownership: params.has('comfy-external') ? 'external' : 'ours', httpBase: 'http://127.0.0.1:8189', statusMessage: 'Synthetic ComfyUI process is running.', logFilePath: '/synthetic/PRIVATE_LOG_CANARY.log' }
const record = (method, payload = {}) => calls.push({ method, ...clone(payload) })
const wait = method => held.has(method) ? new Promise(resolve => pending.set(method, resolve)) : Promise.resolve()
const reject = method => async payload => { forbidden.push({ method, payload }); throw new Error(`Forbidden fixture operation: ${method}`) }
Object.defineProperty(window, 'localStorage', { value: {
  getItem: key => { record('localStorage.get', { key }); return storage.get(key) ?? null },
  setItem: (key, value) => {
    // Existing connection hydration may mirror the same saved port into its
    // renderer cache. This is not a connection/settings/configuration change.
    if (key === 'comfystudio-comfy-connection' && storage.get(key) === String(value)) { record('localStorage.cacheRefresh', { key }); return }
    forbidden.push({ method: 'localStorage.set', key, value }); throw new Error('No persistent writes in setup helper')
  },
  removeItem: key => { forbidden.push({ method: 'localStorage.remove', key }); throw new Error('No persistent writes in setup helper') },
} })
window.electronAPI = {
  isElectron: true, platform: 'linux',
  setupHelper: {
    status: async payload => { record('status', payload); const result = clone(status); await wait('status'); return result },
    send: async payload => {
      record('send', payload)
      const result = clone(response)
      if (storedHostedReply && payload.integration === 'comfycloud') { record('hosted.readStoredStatus'); result.checks = [hostedEvidence()] }
      await wait('send'); return result
    },
    cancel: async payload => { record('cancel', payload); await wait('cancel'); return { success: true } },
    reset: async payload => { record('reset', payload); await wait('reset'); await new Promise(resolve => setTimeout(resolve, 0)); return { success: true } },
    performAction: async payload => {
      // Mirror the preload's transient-user-activation gate. Reset above crosses
      // a macrotask, like an IPC round trip, before this bridge entry occurs.
      if (actionGestureInactive || !navigator.userActivation?.isActive) throw new Error('Choose a setup action yourself to continue.')
      record('performAction', payload); const result = clone(actionResponse); await wait('performAction'); return result
    },
  },
  comfyHostedSetup: {
    status: async () => { record('hosted.status'); return hostedStatus() },
    check: async payload => {
      record('hosted.check', { hasKey: Boolean(payload?.key), fixtureKey: payload?.key === HOSTED_FAKE, remember: payload?.remember === true })
      await wait('hosted.check')
      hostedState = hostedCheckState
      if (payload?.key && hostedState === 'verified') { hostedConfigured = true; hostedRemembered = payload.remember === true }
      return hostedStatus()
    },
    clear: async () => { record('hosted.clear'); hostedState = 'missing'; hostedConfigured = false; hostedRemembered = false; return hostedStatus() },
    cancel: async () => { record('hosted.cancel'); return { success: true } },
    openGuide: async payload => { record('hosted.openGuide', payload); return { success: true } },
  },
  optionalSetup: { inspect: async payload => { record('inspect', payload); return { integration: payload.integration, ...clone(inspectResponse) } } },
  toolSetup: {
    plan: async payload => { record('plan', payload); return { success: true, integration: payload.integration, name: payload.integration === 'lmstudio' ? 'LM Studio' : 'ComfyUI', planId: 'synthetic-plan', host: { platform: 'linux', arch: 'x64', memoryGiB: 16 }, installation: { found: false, summary: 'Synthetic fixture.' }, readiness: { state: 'unavailable', summary: 'Not checked.' }, download: { supported: false, canDownload: false, bytes: null, sourceUrl: null }, steps: ['Use the official guide.'], warnings: ['No installation started.'] } },
    download: reject('download'), open: reject('openInstaller'), status: reject('installerStatus'), cancel: reject('installerCancel'),
  },
  getSetting: async key => {
    if (key === 'comfyConnection') { record('getSetting', { key }); return clone(settings.comfyConnection) }
    return reject('getSetting')({ key })
  }, setSetting: reject('setSetting'), openExternalUrl: reject('openExternalUrl'),
  connectedAgent: { send: reject('projectAgentSend'), codexLogin: reject('codexLogin'), codexExecutable: reject('codexExecutable'), setFullAccess: reject('setFullAccess') },
  comfyLauncher: {
    getState: async () => { record('launcher.getState'); return clone(launcherState) },
    getConfig: async () => { record('launcher.getConfig'); return clone(launcherConfig) },
    getLogs: async payload => { record('launcher.getLogs', payload); return [{ text: 'PRIVATE_LOG_CONTENT_CANARY', ts: 1, stream: 'stdout' }] },
    onState: () => { record('launcher.onState'); return () => record('launcher.offState') },
    onLog: () => { record('launcher.onLog'); return () => record('launcher.offLog') },
    detectLaunchers: async payload => { record('launcher.detect', payload); return { success: true, candidates: [{ launcherMode: 'script', path: launcherConfig.launcherScript, label: 'Synthetic existing ComfyUI' }] } },
    start: reject('startComfy'), stop: reject('stopComfy'), restart: reject('restartComfy'), refresh: reject('refreshComfy'),
    setConfig: reject('setLauncherConfig'), pickLauncherScript: reject('pickLauncherScript'), pickMacApp: reject('pickMacApp'),
    openLogFile: reject('openLauncherLog'), probeConnection: reject('probeConnection'),
  },
}
const { default: OptionalSetup, OptionalSetupDialog } = await import('../../src/components/OptionalSetup.jsx')
window.setupHelperTest = {
  ready: true,
  snapshot: () => ({ calls: clone(calls), forbidden: clone(forbidden), settings: clone(settings), storage: Object.fromEntries(storage), pending: [...pending.keys()], hosted: hostedStatus() }),
  setStatus: value => { status = clone(value) }, setResponse: value => { response = clone(value) },
  setActionResponse: value => { actionResponse = clone(value) },
  setInspectResponse: value => { inspectResponse = clone(value) },
  setActionGestureInactive: value => { actionGestureInactive = value === true },
  useStoredHostedReply: value => { storedHostedReply = value === true },
  setHostedCheckState: value => { hostedCheckState = value },
  setHostedState: value => { hostedState = value.state; hostedConfigured = value.configured === true; hostedRemembered = value.remembered === true },
  hold: method => held.add(method),
  release: method => { held.delete(method); const resolve = pending.get(method); pending.delete(method); resolve?.() },
}
function Fixture() {
  const [screen, setScreen] = useState('setup'), [open, setOpen] = useState(false)
  const view = ['helper', 'helper-agent', 'helper-comfyui', 'helper-comfycloud'].includes(params.get('view')) ? params.get('view') : 'start'
  const exit = target => { record('navigate', { target }); setScreen(target); setOpen(false) }
  const cloudSetup = params.has('without-cloud') ? undefined : () => exit('cloud')
  const chooseAgentModel = params.has('without-choose') ? undefined : (...args) => { record('chooseAgentModel', { argumentCount: args.length }); exit('model-picker') }
  return <main className="setup-helper-fixture" style={{ maxWidth: 800, margin: '0 auto', padding: 20 }}>
    <p style={{ fontSize: 12, color: '#9ca3af', marginBottom: 15 }}>Isolated setup helper · all replies and native state are synthetic</p>
    {screen === 'setup' ? params.has('dialog') ? <>
      <button type="button" onClick={() => setOpen(true)}>Open optional tools</button>
      {open && <OptionalSetupDialog initialView={view} onClose={() => setOpen(false)} onCloudSetup={cloudSetup} onChooseAgentModel={chooseAgentModel} />}
    </> : <OptionalSetup initialView={view} onSkip={params.has('standalone') ? undefined : () => exit('editor')} onCloudSetup={cloudSetup} onChooseAgentModel={chooseAgentModel} />
      : <section aria-label={`${screen} fixture`}><h1>{screen === 'editor' ? 'Editor remains available' : screen === 'model-picker' ? 'Choose a model explicitly' : 'Private API key settings'}</h1>
        <button type="button" onClick={() => setScreen('setup')}>Reopen setup</button></section>}
  </main>
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>)
