// Actual renderer components/stores with synthetic media and deterministic
// provider replies. No App startup, project IO, credentials, models or network.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { I18nProvider } from '../../src/i18n/I18nContext'
import { stageWorkflowInAgent } from '../../src/utils/workflowAgentHandoff.mjs'

const clone = value => value === undefined ? undefined : structuredClone(value)
const actualInspectorMode = new URLSearchParams(window.location.search).has('inspector')
const actualTimelineMode = new URLSearchParams(window.location.search).has('timeline')
const mobileFixtureMode = new URLSearchParams(window.location.search).get('mobile') === '1'
const setupDownloadsFixtureMode = new URLSearchParams(window.location.search).has('setupDownloads')
const localComfyDisplayFixtureMode = new URLSearchParams(window.location.search).has('localComfyDisplay')
const setupCompletionFixtureMode = new URLSearchParams(window.location.search).has('setupCompletion')
// A browser regression may replay a detached RAM snapshot across a full page
// reload. This never reads or writes the browser profile's real localStorage.
const storage = new Map(Object.entries(window.__connectedAgentFixtureStorage || {}))
if (setupCompletionFixtureMode && !storage.has('velorn.connected-agent.settings.v1')) {
  storage.set('velorn.connected-agent.settings.v1', JSON.stringify({ provider: 'codex', codexModel: 'fixture-codex-fast' }))
}
const requests = [], calls = [], forbiddenCalls = [], pending = new Map(), listeners = new Set()
let setupHelperTurns = 16
const pendingFailures = new Map()
let comfyDisplayStatus = { success: true, integration: 'comfyui', state: 'ready', configuredPort: 8000,
  connections: [{ port: 8000, httpBase: 'http://127.0.0.1:8000' }] }
let holdComfyDisplay = false, comfyDisplaySequence = 0
const pendingComfyDisplay = []
// Native-owned installer receipts are simulated separately from chat history.
// Scope metadata stays in this RAM fixture and is never returned as job content.
const setupJobs = new Map(), setupListeners = new Set(), pendingSetupLists = [], pendingSetupActions = []
let setupListError = '', holdSetupLists = false, setupSequence = 0, setupListenerPeak = 0
const heldSetupActions = new Set(), setupActionResponses = new Map()
const emitSetupChanged = () => { for (const callback of setupListeners) callback() }
const setupJob = value => {
  if (!value) return undefined
  const { projectPath, chatId, ...job } = value
  return clone(job)
}
const setupAction = async (action, options) => {
  const actionId = `fixture-setup-action-${++setupSequence}`
  calls.push({ method: `toolSetup.${action}`, actionId, ...clone(options) })
  const job = setupJobs.get(options.jobId)
  let result = setupActionResponses.has(action) ? clone(setupActionResponses.get(action))
    : !job ? { success: false, error: 'Synthetic installer receipt was not found.' }
      : action === 'status' ? { success: true, ...setupJob(job) }
        : action === 'cancel' ? { success: true, ...setupJob(job), state: 'cancelled', canOpen: false }
          : { success: true, ...setupJob(job), opened: true }
  if (heldSetupActions.has(action)) result = await new Promise(resolve => pendingSetupActions.push({ actionId, action, result, resolve }))
  if (result.success && job && ['cancel', 'open'].includes(action)) {
    Object.assign(job, action === 'cancel' ? { state: 'cancelled', canOpen: false } : { opened: true })
    emitSetupChanged()
  }
  return result
}
let listenerSubscriptions = 0, listenerUnsubscriptions = 0, maxListenerCount = 0
let connectionError = '', connectionErrorCode = '', captureError = '', holdCapture = false
let approvalError = '', holdApproval = false
let holdInspect = false, nextInspectId = 0
let codexInspectResult = null, nextCodexLoginId = 0, activeCodexLoginId = null
let lunaInspectResult = { success: true, provider: 'luna', available: true, eligible: true, status: 'eligible', models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna', defaultReasoningEffort: 'none', supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'].map(reasoningEffort => ({ reasoningEffort })) }], vision: true, readOnly: false }
const codexLoginResponses = new Map(), heldCodexLoginActions = new Set(['start']), pendingCodexLogins = []
const codexSetupStatuses = {
  missing: { available: false, installed: false, signedIn: false, code: 'CODEX_NOT_FOUND', message: 'Codex CLI was not found. Install the official Codex CLI, then find it again.' },
  'login-required': { available: false, installed: true, signedIn: false, code: 'CODEX_LOGIN_REQUIRED', message: 'Codex CLI is installed. Sign in with ChatGPT to connect it.' },
  'chatgpt-required': { available: false, installed: true, signedIn: false, code: 'CODEX_CHATGPT_REQUIRED', message: 'Sign in to Codex with a ChatGPT account to use this connection.' },
  terminated: { available: false, installed: true, signedIn: false, code: 'CODEX_PROCESS_TERMINATED', message: 'Codex was terminated while checking the connection. Try a working official standalone Codex CLI.' },
}
const initialSetupStatus = new URLSearchParams(window.location.search).get('setupStatus')
// General chat tests represent an existing user; explicit setupStatus cases
// start without intent unless the test replays a detached preference snapshot.
if (!initialSetupStatus && !window.__connectedAgentFixtureStorage) storage.set('velorn.agent-entry-intent.v1', '{"acknowledged":true}')
if (codexSetupStatuses[initialSetupStatus]) codexInspectResult = clone(codexSetupStatuses[initialSetupStatus])
let localModels = [{ id: 'fixture-model' }], loadedModelStatus = 'unavailable'
if (setupCompletionFixtureMode) {
  localModels = [{ id: 'fixture-nemotron-4b', displayName: 'NVIDIA Nemotron Nano 4B', loaded: true }]
  loadedModelStatus = 'available'
}
let fullAccessResponse = null, holdFullAccess = false, fullAccessGrant = null, nextFullAccessId = 0
const pendingFullAccess = []
// This mocks the native preference, deliberately separate from localStorage.
let fullAccessRemembered = window.__connectedAgentFixtureFullAccessRemembered === true
let localFullAccessRemembered = false
let holdFullAccessPreference = false
const pendingFullAccessPreferences = []
// Simulated native device policy is separate from renderer chat/preferences.
let spendingPolicy = window.__connectedAgentFixtureSpending || 'local-only'
let spendingResponse = null, spendingStatusResponse = null, holdSpending = false, holdSpendingStatus = false
const spendingListeners = new Set(), pendingSpending = [], pendingSpendingStatus = []
const spendingStatus = () => ({ success: true, policy: spendingPolicy, scope: 'velorn-managed' })
let executable = { path: '/fixture-only/PRIVATE_EXECUTABLE/automatic/codex', source: 'PATH', mode: 'automatic', available: true }
let nextExecutableId = 0
const executableResponses = new Map(), heldExecutableActions = new Set(), pendingExecutables = []
let codexModels = [
  { id: 'fixture-codex-default', displayName: 'Fixture Codex One', description: 'Synthetic general-purpose model.', isDefault: true },
  { id: 'fixture-codex-fast', displayName: 'Fixture Codex Quick', description: 'Synthetic faster model.', isDefault: false },
]
const pendingCaptures = []
const pendingApprovals = []
const pendingInspects = []
const mobileListeners = new Set(), mobileFixtureListeners = new Set()
let nativePhoneRemembered = window.__connectedAgentFixturePhoneRemembered === true
let maxMobileListenerCount = 0
const mobileFixture = { scope: null, status: null, sequence: 0, request: null,
  publicationCount: 0, publication: null, replies: [], nativeApprovals: [] }
const notifyMobileFixture = () => {
  if (mobileFixtureMode) for (const listener of mobileFixtureListeners) listener()
}
const emitMobile = event => {
  for (const listener of mobileListeners) listener(clone(event))
  notifyMobileFixture()
}
const mobileOffStatus = reason => ({ enabled: false, paired: false, transport: 'trusted-lan-http',
  pairingCode: null, urls: [], reason, remoteApprovals: false, fullAccess: false })
function endMobileFixture(reason) {
  const previous = mobileFixture.request
  mobileFixture.request = null; mobileFixture.scope = null
  mobileFixture.status = mobileOffStatus(reason)
  if (previous) emitMobile({ type: 'message-cancelled', id: previous.id, scope: previous.scope })
  emitMobile({ type: 'status', status: mobileFixture.status })
  return { success: true, status: clone(mobileFixture.status) }
}
Object.defineProperty(window, 'localStorage', { value: {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key), clear: () => storage.clear(),
  key: index => [...storage.keys()][index] ?? null, get length() { return storage.size },
} })
const forbidden = method => async (...args) => {
  forbiddenCalls.push({ method, args: clone(args) })
  throw new Error(`Forbidden fixture operation: ${method}`)
}
const seededAssets = ['SIGNAL', 'MARA', 'CITY', 'DAWN'].map((label, index) => {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360
  const context = canvas.getContext('2d')
  context.fillStyle = ['#123f54', '#3c3055', '#245353', '#694a32'][index]; context.fillRect(0, 0, 640, 360)
  context.fillStyle = '#f1f7ff'; context.font = 'bold 40px sans-serif'; context.fillText(label, 28, 66)
  context.font = '14px sans-serif'; context.fillText('SYNTHETIC CONNECTED AGENT FIXTURE — RAM ONLY', 28, 102)
  return { id: `reference-${index + 1}`, type: 'image', name: `${label.toLowerCase()}-study.png`,
    path: `assets/images/PRIVATE_PATH_reference-${index + 1}.png`, url: canvas.toDataURL('image/png'),
    width: 640, height: 360, duration: 5, isImported: true, createdAt: '2026-09-27T00:00:00.000Z' }
})
const mobileCaptureUrl = mobileFixtureMode ? (() => {
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
  const context = canvas.getContext('2d')
  context.fillStyle = '#123f54'; context.fillRect(0, 0, 320, 180)
  context.fillStyle = '#f1f7ff'; context.font = 'bold 22px sans-serif'
  context.fillText('SYNTHETIC MOBILE STILL', 12, 70)
  context.font = '13px sans-serif'; context.fillText('RAM ONLY — NO SCREEN CAPTURE', 12, 105)
  return canvas.toDataURL('image/jpeg', 0.7)
})() : null
window.electronAPI = {
  ...(setupCompletionFixtureMode ? { setupHelper: {
    status: async payload => { calls.push({ method: 'setupHelper.status', payload: clone(payload) }); return { success: true, available: true, mode: 'internal-api', model: 'gpt-6-luna', remainingTurns: setupHelperTurns } },
    send: async payload => {
      calls.push({ method: 'setupHelper.send', payload: clone(payload) })
      if (!['lmstudio', 'codex', 'comfycloud'].includes(payload.integration) || Object.keys(payload).sort().join(',') !== 'integration,message') throw Error('Unexpected synthetic setup question')
      if (payload.integration === 'comfycloud') return {
        success: true, text: 'The stored account check reported active access. No new Comfy request was made.', actions: [], remainingTurns: --setupHelperTurns,
        checks: [{ integration: 'comfycloud', state: 'verified', configured: true, evidence: 'stored-account-check', summary: 'The prior explicit account check reported active access. No generation was run.' }],
      }
      if (payload.integration === 'codex') return {
        success: true, text: 'Codex setup is verified. Your editing assistant has not been changed.', actions: [], remainingTurns: --setupHelperTurns,
        checks: [{ integration: 'codex', state: 'ready', summary: 'Codex CLI is signed in through ChatGPT. No Codex prompt was sent.' }],
      }
      return { success: true, text: 'LM Studio is connected. Your editing assistant has not been changed.', actions: [], remainingTurns: --setupHelperTurns,
        checks: [{ integration: 'lmstudio', state: 'ready', summary: 'Synthetic LM Studio server has a loaded chat model. No inference was run.',
          installation: { state: 'found', canOpen: true, summary: 'Synthetic installed application.' },
          loadedModels: { verified: true, names: ['NVIDIA Nemotron Nano 4B'], truncated: false } }] }
    },
    cancel: async payload => { calls.push({ method: 'setupHelper.cancel', payload: clone(payload) }); return { success: true } },
    reset: async payload => { calls.push({ method: 'setupHelper.reset', payload: clone(payload) }); return { success: true } },
    performAction: forbidden('setupHelper.performAction'),
  }, lmStudioSetup: { load: forbidden('lmStudioSetup.load'), download: forbidden('lmStudioSetup.download') } } : {}),
  ...(localComfyDisplayFixtureMode ? { optionalSetup: {
    inspect: async options => {
      if (JSON.stringify(options) !== JSON.stringify({ integration: 'comfyui' })) throw new Error('Unexpected synthetic setup request')
      const checkId = `fixture-comfy-display-${++comfyDisplaySequence}`
      calls.push({ method: 'optionalSetup.inspect', options: clone(options), checkId })
      const result = clone(comfyDisplayStatus)
      if (holdComfyDisplay) return new Promise(resolve => pendingComfyDisplay.push({ checkId, result, resolve }))
      return result
    },
  } } : {}),
  ...(setupDownloadsFixtureMode ? { toolSetup: {
    plan: forbidden('toolSetup.plan'), download: forbidden('toolSetup.download'),
    agentDownloads: async options => {
      const listId = `fixture-setup-list-${++setupSequence}`
      calls.push({ method: 'toolSetup.agentDownloads', listId, ...clone(options) })
      const result = setupListError ? { success: false, error: setupListError } : { success: true,
        jobs: [...setupJobs.values()].filter(job => job.projectPath === options.projectPath && job.chatId === options.chatId).map(setupJob) }
      if (holdSetupLists) return new Promise(resolve => pendingSetupLists.push({ listId, options: clone(options), result, resolve }))
      return result
    },
    onChanged: callback => {
      setupListeners.add(callback); setupListenerPeak = Math.max(setupListenerPeak, setupListeners.size)
      return () => setupListeners.delete(callback)
    },
    status: options => setupAction('status', options),
    cancel: options => setupAction('cancel', options),
    open: options => setupAction('open', options),
  } } : {}),
  isElectron: true, platform: 'linux',
  openExternalUrl: async url => {
    calls.push({ method: 'openExternalUrl', url })
    if (!['https://learn.chatgpt.com/docs/cli', 'https://learn.chatgpt.com/docs/codex/cli'].includes(url)) throw new Error('Fixture permits only the fixed Codex installation guide')
    return { success: true }
  },
  ...(mobileFixtureMode ? { mobileCompanion: {
    ...(new URLSearchParams(location.search).has('lunaAuto') ? { aiSharingVersion: 1 } : {}),
    getPreference: async () => {
      calls.push({ method: 'mobile.getPreference' })
      return { success: true, enabled: nativePhoneRemembered,
        ...(new URLSearchParams(location.search).has('accountPanel') ? { available: true, legacyAvailable: true, guidedAvailable: false } : {}) }
    },
    attach: async ({ scope, snapshot }) => {
      calls.push({ method: 'mobile.attach', scope })
      mobileFixture.scope = scope; mobileFixture.publication = clone(snapshot)
      if (nativePhoneRemembered && !mobileFixture.status?.enabled) {
        mobileFixture.status = { enabled: true, paired: true, transport: 'trusted-lan-http', pairingCode: null,
          urls: ['http://192.0.2.10:5212/'], remoteApprovals: true }
      }
      return { success: true, status: clone(mobileFixture.status) || mobileOffStatus('fixture-off'), nativeApprovals: clone(mobileFixture.nativeApprovals) }
    },
    detach: async () => ({ success: true }),
    enable: async ({ scope, snapshot }) => {
      calls.push({ method: 'mobile.enable', scope }); nativePhoneRemembered = true
      // Synthetic consent succeeds only after clicking the real renderer's
      // Pair button. There is no native dialog or listening network service.
      mobileFixture.scope = scope; mobileFixture.publication = clone(snapshot)
      mobileFixture.request = null
      mobileFixture.status = { enabled: true, paired: false, transport: 'trusted-lan-http',
        pairingCode: 'SYNTHETIC123', pairingExpiresAt: Date.now() + 300000,
        sessionExpiresAt: Date.now() + 7200000, urls: ['http://192.0.2.10:5212/'],
        remoteApprovals: false, fullAccess: false }
      emitMobile({ type: 'status', status: mobileFixture.status })
      return { success: true, status: clone(mobileFixture.status) }
    },
    disable: async ({ scope }) => {
      if (mobileFixture.scope && mobileFixture.scope !== scope) return { success: false, error: 'Synthetic sharing scope changed.' }
      calls.push({ method: 'mobile.disable', scope }); nativePhoneRemembered = false
      return endMobileFixture('desktop-disabled')
    },
    publish: async ({ scope, snapshot }) => {
      if (!mobileFixture.status?.enabled || mobileFixture.scope !== scope) return { success: false, error: 'Synthetic sharing session ended.' }
      mobileFixture.publicationCount++; mobileFixture.publication = clone(snapshot)
      notifyMobileFixture()
      return { success: true, status: clone(mobileFixture.status) }
    },
    reply: async ({ scope, id, result }) => {
      const request = mobileFixture.request
      if (!mobileFixture.status?.enabled || scope !== mobileFixture.scope || request?.id !== id) {
        return { success: false, error: 'Synthetic phone request expired.' }
      }
      mobileFixture.replies = [...mobileFixture.replies, { id, result: clone(result) }].slice(-20)
      if (result.success === true && result.status === 'accepted') request.status = 'accepted'
      else mobileFixture.request = null
      notifyMobileFixture()
      return { success: true }
    },
    decideNative: async options => {
      calls.push({ method: 'mobile.decideNative', ...clone(options) })
      const approval = mobileFixture.nativeApprovals.find(item => item.approvalId === options.approvalId && item.reviewToken === options.reviewToken)
      if (!approval || (options.approved && approval.requiresRiskAcknowledgement && !options.riskAcknowledged)) return { success: false, error: 'Synthetic native review is unavailable.' }
      mobileFixture.nativeApprovals = mobileFixture.nativeApprovals.filter(item => item.approvalId !== options.approvalId)
      emitMobile({ type: 'native-approvals', scope: mobileFixture.scope, approvals: mobileFixture.nativeApprovals })
      return { success: true }
    },
    onEvent: listener => { mobileListeners.add(listener); maxMobileListenerCount = Math.max(maxMobileListenerCount, mobileListeners.size); return () => mobileListeners.delete(listener) },
  } } : {}),
  ...(!new URLSearchParams(window.location.search).has('legacySpending') ? { generationSpending: {
    getStatus: async () => {
      calls.push({ method: 'spending.getStatus' })
      const result = clone(spendingStatusResponse) ?? spendingStatus()
      if (holdSpendingStatus) await new Promise(resolve => pendingSpendingStatus.push(resolve))
      return result
    },
    setPolicy: async policy => {
      calls.push({ method: 'spending.setPolicy', policy })
      if (holdSpending) await new Promise(resolve => pendingSpending.push(resolve))
      const result = clone(spendingResponse) ?? { success: true, policy, scope: 'velorn-managed' }
      if (result.success && !result.cancelled && ['local-only', 'ask-cloud'].includes(result.policy) && result.scope === 'velorn-managed') {
        spendingPolicy = result.policy
        for (const listener of spendingListeners) listener(spendingStatus())
      }
      return result
    },
    onChanged: callback => { spendingListeners.add(callback); return () => spendingListeners.delete(callback) },
    cancel: async requestId => { calls.push({ method: 'spending.cancel', requestId }); return { success: true } },
  } } : {}),
  connectedAgent: {
    ...(new URLSearchParams(location.search).has('lunaAuto') ? { aiSharingVersion: 1 } : {}),
    reasoningControlVersion: 1,
    codexLogin: async options => {
      const loginId = `fixture-codex-login-${++nextCodexLoginId}`
      calls.push({ method: 'codexLogin', loginId, ...clone(options) })
      if (!['start', 'cancel'].includes(options?.action)) throw new Error('Invalid synthetic Codex login action')
      const cancelledStarts = options.action === 'cancel' ? pendingCodexLogins.filter(item => item.action === 'start') : []
      if (options.action === 'start') {
        activeCodexLoginId = loginId
        fullAccessGrant = null; fullAccessRemembered = false
      } else activeCodexLoginId = null
      let result = clone(codexLoginResponses.get(options.action)) ?? { success: true, ...(options.action === 'cancel' ? { cancelled: true } : {}) }
      if (heldCodexLoginActions.has(options.action)) result = await new Promise(resolve => pendingCodexLogins.push({ loginId, action: options.action, result, resolve }))
      if (options.action === 'cancel') {
        for (const entry of cancelledStarts) {
          const index = pendingCodexLogins.indexOf(entry)
          if (index >= 0) { pendingCodexLogins.splice(index, 1); entry.resolve({ success: true, cancelled: true }) }
        }
      } else if (activeCodexLoginId === loginId) {
        activeCodexLoginId = null
        if (result.success && !result.cancelled) {
          codexInspectResult = null; connectionError = ''; connectionErrorCode = ''
        }
      }
      return result
    },
    codexExecutable: async options => {
      const executableId = `fixture-executable-${++nextExecutableId}`
      calls.push({ method: 'codexExecutable', executableId, ...clone(options) })
      let result = clone(executableResponses.get(options.action)) ?? { success: true, executable: options.action === 'status' ? clone(executable)
        : options.action === 'auto' ? { path: '/fixture-only/PRIVATE_EXECUTABLE/automatic/codex', source: 'PATH', mode: 'automatic', available: true }
          : { path: '/fixture-only/PRIVATE_EXECUTABLE/chosen/codex', source: 'Selected by you', mode: 'custom', available: true } }
      if (heldExecutableActions.has(options.action)) result = await new Promise(resolve => pendingExecutables.push({ executableId, action: options.action, result, resolve }))
      if (options.action !== 'status' && !result.cancelled) {
        if (result.success) executable = clone(result.executable)
        fullAccessGrant = null; fullAccessRemembered = false
      }
      return result
    },
    getFullAccessPreference: async (options = {}) => {
      calls.push({ method: 'getFullAccessPreference', ...clone(options) })
      if (holdFullAccessPreference) await new Promise(resolve => pendingFullAccessPreferences.push(resolve))
      return { success: true, remembered: options.provider === 'lmstudio' ? localFullAccessRemembered : fullAccessRemembered }
    },
    setFullAccess: async options => {
      calls.push({ method: 'setFullAccess', ...clone(options) })
      if (options.restoreOnly && window.__connectedAgentFixtureRestoreFailures > 0) {
        window.__connectedAgentFixtureRestoreFailures--
        return { success:false,code:'STALE_APPROVAL',error:'Synthetic startup context is still loading.' }
      }
      if (!options.enabled) {
        fullAccessGrant = null
        if (options.forget === true) {
          if (options.provider === 'lmstudio') localFullAccessRemembered = false
          else fullAccessRemembered = false
        }
        return { success: true, enabled: false, remembered: options.provider === 'lmstudio' ? localFullAccessRemembered : fullAccessRemembered }
      }
      const remembered = options.provider === 'lmstudio' ? localFullAccessRemembered : fullAccessRemembered
      // Simulate a receipt consumed by native code after the renderer accepted
      // this exact phone command; a caller's fromPhone flag alone is insufficient.
      const phoneBundle = options.fromPhone === true && mobileFixture.request?.status === 'accepted'
        && mobileFixture.request?.bundleVersion === 1 && mobileFixture.request?.mode === 'full'
      const result = options.restoreOnly === true && !remembered
        ? { success: true, enabled: false, remembered: false }
        : (options.restoreOnly === true ? null : clone(fullAccessResponse)) ?? { success: true, enabled: true,
          token: `fixture-full-access-${++nextFullAccessId}`, shareImagesAndView: options.shareImagesAndView === true,
          remembered: phoneBundle || remembered }
      if (holdFullAccess) await new Promise(resolve => pendingFullAccess.push(resolve))
      if (result.success && result.enabled && result.token) {
        if (phoneBundle) {
          spendingPolicy = 'ask-cloud'
          calls.push({ method: 'fixture.phoneBundleConsent', requestId: mobileFixture.request.id })
        }
        fullAccessGrant = { ...clone(options), token: result.token }
        if (typeof result.remembered === 'boolean') {
          if (options.provider === 'lmstudio') localFullAccessRemembered = result.remembered
          else fullAccessRemembered = result.remembered
        }
      }
      return result
    },
    inspect: async options => {
      const inspectId = `fixture-inspect-${++nextInspectId}`
      calls.push({ method: 'inspect', inspectId, options: clone(options) })
      const result = connectionError ? { success: false, error: connectionError, code: connectionErrorCode,
        ...(options.provider === 'codex' ? { executable: clone(executable) } : {}) }
        : options.provider === 'luna' ? clone(lunaInspectResult) : options.provider === 'codex' && codexInspectResult ? {
          success: true, provider: 'codex', models: [], readOnly: true, modelCatalogStatus: 'not-requested',
          executable: clone(executable), ...clone(codexInspectResult),
        } : { success: true, available: true, connected: true, authenticated: true,
          provider: options.provider, model: options.provider === 'codex' ? '' : 'fixture-model',
          models: options.provider === 'codex' ? clone(codexModels) : clone(localModels),
          ...(options.provider === 'lmstudio' ? { loadedModelStatus, available: localModels.length > 0 } : {}),
          ...(options.provider === 'codex' ? { modelCatalogStatus: 'available', modelCatalogError: '', executable: clone(executable) } : {}),
          message: 'Deterministic fixture provider ready' }
      if (holdInspect) return new Promise(resolve => pendingInspects.push({ inspectId, options: clone(options), result, resolve }))
      return result
    },
    send: options => {
      requests.push(clone(options)); calls.push({ method: 'send', requestId: options.requestId })
      notifyMobileFixture()
      return new Promise((resolve, reject) => { pending.set(options.requestId, resolve); pendingFailures.set(options.requestId, reject) })
    },
    cancel: async options => {
      // Deliberately keep the old promise live: test stale completions after a
      // cancellation, provider/project switch or unmount rather than hiding them.
      calls.push({ method: 'cancel', ...clone(options) }); return { success: true }
    },
    approveTool: async options => {
      calls.push({ method: 'approveTool', ...clone(options) })
      if (holdApproval) await new Promise(resolve => pendingApprovals.push(resolve))
      return approvalError ? { success: false, code: 'STALE_APPROVAL', error: approvalError } : { success: true }
    },
    capture: async options => {
      calls.push({ method: 'capture', ...clone(options) })
      if (holdCapture) await new Promise(resolve => pendingCaptures.push(resolve))
      return captureError ? { success: false, error: captureError }
        : { success: true, dataUrl: mobileFixtureMode ? mobileCaptureUrl : seededAssets[0].url }
    },
    onEvent: callback => {
      listenerSubscriptions++; listeners.add(callback); maxListenerCount = Math.max(maxListenerCount, listeners.size)
      return () => { listenerUnsubscriptions++; listeners.delete(callback) }
    },
  },
  readFile: forbidden('readFile'), writeFile: forbidden('writeFile'), createDirectory: forbidden('createDirectory'),
  deleteFile: forbidden('deleteFile'), copyFile: forbidden('copyFile'), selectFile: forbidden('selectFile'),
  selectDirectory: forbidden('selectDirectory'),
  getSetting: async key => {
    if (key === 'freeGpuMemoryAfterGeneration') return false
    if (!actualTimelineMode) return forbidden('getSetting')(key)
    if (!['editorHotkeys', 'comfyConnection'].includes(key)) return forbidden('getSetting')(key)
    // Timeline imports connection-aware tools, but never opens them. Hydrate
    // only deterministic RAM defaults; no native settings or service probes.
    calls.push({ method: 'fixtureSettingRead', key })
    return key === 'comfyConnection' ? { port: Number(window.location.port) } : null
  }, setSetting: forbidden('setSetting'),
  getFileUrlDirect: forbidden('getFileUrlDirect'), writeFileFromArrayBuffer: forbidden('writeFileFromArrayBuffer'),
  transcodeForPlayback: forbidden('transcodeForPlayback'), transcodeForProxy: forbidden('transcodeForProxy'),
  comfyLauncher: { start: forbidden('comfyLauncher.start'), stop: forbidden('comfyLauncher.stop') },
}

const [{ default: ConnectedAgentPanel }, { default: ProductionWorkspace }, { default: project },
  { default: timeline }, { default: assets }, dirty, { default: RightPanelDock }, { default: ResizeHandle }] = await Promise.all([
  import('../../src/components/ConnectedAgentPanel'), import('../../src/components/ProductionWorkspace'),
  import('../../src/stores/projectStore'), import('../../src/stores/timelineStore'),
  import('../../src/stores/assetsStore'), import('../../src/services/projectDirtyTracker'),
  import('../../src/components/RightPanelDock'), import('../../src/components/ResizeHandle'),
])
const InspectorPanel = actualInspectorMode ? (await import('../../src/components/InspectorPanel')).default : null
const Timeline = actualTimelineMode ? (await import('../../src/components/Timeline')).default : null
const TransportControls = actualTimelineMode ? (await import('../../src/components/TransportControls')).default : null
const { default: exportActivity } = await import('../../src/stores/exportActivityStore')
const timelineDefaults = timeline.getState()
dirty.attachProjectDirtyWatchers({ timelineStore: timeline, assetsStore: assets, projectStore: project })
function switchProject(root = 'alpha') {
  const settings = { width: 1920, height: 1080, fps: 24 }
  const clips = [{ id: 'fixture-clip', name: 'Signal opening', type: 'image', assetId: 'reference-1', trackId: 'video-1',
    start: 0, duration: 5, sourceIn: 0, sourceOut: 5, url: seededAssets[0].url, path: 'PRIVATE_PATH_clip.png' }]
  if (actualTimelineMode) Object.assign(clips[0], { startTime: 0, trimStart: 0, trimEnd: 5,
    sourceDuration: 5, enabled: true, effects: [], keyframes: {} })
  if (actualInspectorMode) clips.push({ id: 'fixture-text', name: 'Synthetic title for ...', type: 'text', trackId: 'video-1',
    startTime: 6, duration: 5, trimStart: 0, trimEnd: 5, sourceDuration: 5, enabled: true, effects: [], keyframes: {},
    transform: { positionX: 0, positionY: 0, scaleX: 100, scaleY: 100, scaleLinked: true, rotation: 0, opacity: 100 },
    textProperties: { text: 'Synthetic title for Inspector focus', fontFamily: 'Inter', fontSize: 64,
      fontWeight: 'bold', fontStyle: 'normal', textColor: '#ffffff', textAlign: 'center' } })
  timeline.setState({ ...timelineDefaults, clips, transitions: [],
    markers: actualTimelineMode ? [{ id: 'fixture-marker', time: 18, label: 'Synthetic marker', color: '#06b6d4' }] : [],
    selectedClipIds: ['fixture-clip'],
    tracks: [{ id: 'video-1', name: 'Video 1', type: 'video', visible: true, locked: false, muted: false }],
    duration: 45, timelineFps: 24, playheadPosition: 2.5, isPlaying: false, history: [], historyIndex: -1,
    timelineSessionId: timeline.getState().timelineSessionId + 1 })
  assets.setState({ assets: clone(seededAssets), folders: [], folderCounter: 1, currentPreview: null, mediaPreparation: null,
    ...(actualTimelineMode ? { previewMode: 'timeline', isPlaying: false } : {}) })
  project.setState({ currentProject: { name: root === 'alpha' ? 'Signal — synthetic project' : 'Other — synthetic project',
    created: `fixture-${root}`, settings, timelines: [{ id: `timeline-${root}`, name: 'Editable animatic', ...settings },
      { id: `timeline-${root}-second`, name: 'Second editable timeline', ...settings }],
    assets: clone(seededAssets), folders: [], storyboard: { version: 1, title: 'SIGNAL / Connected review',
      brief: 'A clearly synthetic city story for read-only conversation checks.', songAssetId: null,
      referenceAssetIds: ['reference-1'], nextShotNumber: 9,
      shots: Array.from({ length: 8 }, (_, index) => ({ id: `shot-${index + 1}`, label: `Shot ${String(index + 1).padStart(2, '0')}`,
        title: `A signal in the city ${index + 1}`, description: `Synthetic shot ${index + 1}: blue city skyline.`,
        durationSeconds: 5, storyboardAssetId: `reference-${index % 4 + 1}`, referenceAssetIds: [], status: 'planned',
        takes: [], selectedTakeId: null })) } }, currentProjectHandle: `/fixture-only/PRIVATE_PATH/${root}`,
    currentTimelineId: `timeline-${root}`, isLoading: false, autoSaveEnabled: false,
    projectHistory: [], projectFuture: [], projectHistoryLastChangedAt: 0, error: null })
  dirty.markProjectClean()
}
switchProject()
function startBlankProject() {
  switchProject('blank')
  const state = project.getState()
  project.setState({ currentProject: { ...state.currentProject, name: 'A new idea', storyboard: undefined,
    assets: [], timelines: state.currentProject.timelines.slice(0, 1) } })
  assets.setState({ assets: [], folders: [] })
  timeline.setState({ clips: [], selectedClipIds: [], duration: 0 })
  dirty.markProjectClean()
}
if (new URLSearchParams(window.location.search).has('blank')) startBlankProject()
if (new URLSearchParams(window.location.search).has('legacyChats') && !window.__connectedAgentFixtureStorage) {
  const { getConnectedAgentHistoryKey } = await import('../../src/utils/connectedAgentContext.mjs')
  for (const [provider, messages] of [
    ['codex', [{ role: 'user', text: 'Legacy storyboard review' }, { role: 'assistant', text: 'Legacy Codex reply stays available.' }]],
    ['lmstudio', [{ role: 'user', text: 'Legacy local review' }, { role: 'assistant', text: 'Legacy local reply stays available.' }]],
  ]) storage.set(getConnectedAgentHistoryKey('path:/fixture-only/PRIVATE_PATH/alpha', provider), JSON.stringify({ version: 1, messages }))
}
window.connectedAgentTest = {
  ready: false, switchProject, startBlankProject,
  ...(setupCompletionFixtureMode ? { setProjectLoading: value => project.setState({ isLoading: value === true }) } : {}),
  localComfyDisplay: {
    status: value => { comfyDisplayStatus = clone(value) },
    hold: value => { holdComfyDisplay = value },
    release: (checkId, override) => {
      const index = checkId ? pendingComfyDisplay.findIndex(item => item.checkId === checkId) : 0
      if (index < 0) return
      const entry = pendingComfyDisplay.splice(index, 1)[0]
      entry?.resolve(override ?? entry.result)
    },
  },
  setupDownloads: {
    seed: jobs => { for (const job of jobs) setupJobs.set(job.jobId, clone(job)); emitSetupChanged() },
    update: (jobId, patch, notify = true) => {
      const job = setupJobs.get(jobId)
      if (!job) throw new Error('Unknown synthetic installer job')
      Object.assign(job, clone(patch)); if (notify) emitSetupChanged()
    },
    emit: emitSetupChanged,
    setListError: error => { setupListError = error },
    setHoldLists: value => { holdSetupLists = value },
    releaseList: (listId, override) => {
      const index = listId ? pendingSetupLists.findIndex(item => item.listId === listId) : 0
      if (index < 0) return
      const entry = pendingSetupLists.splice(index, 1)[0]
      entry?.resolve(override ?? entry.result)
    },
    setActionResponse: (action, result) => { result == null ? setupActionResponses.delete(action) : setupActionResponses.set(action, clone(result)) },
    setHoldAction: (action, value) => { value ? heldSetupActions.add(action) : heldSetupActions.delete(action) },
    releaseAction: (actionId, override) => {
      const index = actionId ? pendingSetupActions.findIndex(item => item.actionId === actionId) : 0
      if (index < 0) return
      const entry = pendingSetupActions.splice(index, 1)[0]
      entry?.resolve(override ?? entry.result)
    },
  },
  emitNativeApprovals: approvals => {
    mobileFixture.nativeApprovals = clone(approvals)
    emitMobile({ type: 'native-approvals', scope: mobileFixture.scope, approvals })
  },
  setPhoneStatus: status => {
    mobileFixture.status = clone(status)
    emitMobile({ type: 'status', status: mobileFixture.status })
  },
  phoneAccess: (mode, { bundleVersion } = {}) => {
    if (!mobileFixtureMode || !mobileFixture.publication) throw Error('Synthetic mobile context is not ready')
    mobileFixture.status = { enabled: true, paired: true, transport: 'trusted-lan-http', urls: [], fullAccess: false }
    const id = `fixture-phone-access-${++mobileFixture.sequence}`
    mobileFixture.request = { id, status: 'pending', mode, ...(bundleVersion === undefined ? {} : { bundleVersion }) }
    emitMobile({ type: 'status', status: mobileFixture.status })
    emitMobile({ type: 'command', scope: mobileFixture.scope,
      command: { id, kind: 'access', mode, contextId: mobileFixture.publication.contextId, ...(bundleVersion === undefined ? {} : { bundleVersion }) } })
  },
  phoneChatCommand: (input, aiSharing) => {
    if (!mobileFixtureMode || !mobileFixture.publication) throw Error('Synthetic mobile context is not ready')
    const command = { id: `fixture-phone-chat-${++mobileFixture.sequence}`, contextId: mobileFixture.publication.contextId, ...clone(input) }
    mobileFixture.request = { id: command.id, status: 'pending' }
    emitMobile({ type: 'command', scope: mobileFixture.scope, command, ...(aiSharing ? { aiSharing: clone(aiSharing) } : {}) })
    return command.id
  },
  interruptPhone: () => endMobileFixture('fixture-restarting'),
  emitPhoneAccessRevoked: reason => {
    fullAccessGrant = null
    emitMobile({ type: 'access-revoked', scope: mobileFixture.scope, reason })
  },
  setExportBusy: busy => exportActivity.setState({ activeJob: busy ? {
    jobId: 'fixture-export', status: 'running', progress: { progress: 25 },
  } : null }),
  // Simulate hydration/navigation only. Both fixture timelines deliberately
  // contain the same authored clips; identity, frame and playhead are transient.
  changeEditorView: ({ timelineId, sessionId, playhead }) => {
    if (timelineId !== undefined) project.setState({ currentTimelineId: timelineId })
    if (sessionId !== undefined) timeline.setState({ timelineSessionId: sessionId })
    if (playhead !== undefined) timeline.setState({ playheadPosition: playhead })
    dirty.markProjectClean()
  },
  editorView: () => ({ timelineId: project.getState().currentTimelineId, sessionId: timeline.getState().timelineSessionId,
    playhead: timeline.getState().playheadPosition, isPlaying: timeline.getState().isPlaying,
    selectedClipIds: clone(timeline.getState().selectedClipIds), selectedMarkerId: timeline.getState().selectedMarkerId }),
  requestInspector: kind => {
    const clipId = kind === 'text' ? 'fixture-text' : 'fixture-clip'
    timeline.setState({ selectedClipIds: [clipId], selectedTransitionId: null })
    if (kind === 'text') timeline.getState().requestTextEdit(clipId)
    else timeline.getState().requestMaskPicker(clipId)
  },
  inspectorRequests: () => ({ text: clone(timeline.getState().textEditRequest), mask: clone(timeline.getState().maskPickerRequest) }),
  emit: (requestId, type, text) => { for (const listener of listeners) listener({ requestId, type, text }) },
  emitEvent: event => {
    if (event.type === 'codex-setup-changed') { fullAccessGrant = null; fullAccessRemembered = false }
    for (const listener of listeners) listener(clone(event))
  },
  settle: (requestId, result) => { const resolve = pending.get(requestId); pending.delete(requestId); pendingFailures.delete(requestId); resolve?.(result) },
  rejectSend: (requestId, result) => {
    const reject = pendingFailures.get(requestId)
    pending.delete(requestId); pendingFailures.delete(requestId)
    reject?.(Object.assign(new Error(result.error || 'Synthetic rejected send.'), clone(result)))
  },
  setConnectionError: (message, code = '') => { connectionError = message; connectionErrorCode = code },
  setCodexSetupStatus: status => {
    if (status !== 'ready' && !codexSetupStatuses[status]) throw new Error('Unknown synthetic Codex setup status')
    codexInspectResult = status === 'ready' ? null : clone(codexSetupStatuses[status])
    connectionError = ''; connectionErrorCode = ''
    executable = { ...executable, available: status !== 'missing',
      path: status === 'missing' ? '' : executable.path || '/fixture-only/PRIVATE_EXECUTABLE/automatic/codex' }
  },
  setCodexInspectResult: result => { codexInspectResult = clone(result) },
  setLunaInspectResult: result => { lunaInspectResult = clone(result) },
  setCodexLoginResponse: (action, result) => { result == null ? codexLoginResponses.delete(action) : codexLoginResponses.set(action, clone(result)) },
  setHoldCodexLogin: (action, enabled) => { enabled ? heldCodexLoginActions.add(action) : heldCodexLoginActions.delete(action) },
  releaseCodexLogin: (loginId, override) => {
    const index = loginId ? pendingCodexLogins.findIndex(item => item.loginId === loginId) : 0
    if (index < 0) return
    const entry = pendingCodexLogins.splice(index, 1)[0]
    entry?.resolve(override ?? entry.result)
  },
  setCodexModels: models => { codexModels = clone(models) },
  setLocalModels: (models, status = 'available') => { localModels = clone(models); loadedModelStatus = status },
  setHoldInspect: enabled => { holdInspect = enabled },
  releaseInspect: (inspectId, override) => {
    const index = inspectId ? pendingInspects.findIndex(item => item.inspectId === inspectId) : 0
    if (index < 0) return
    const entry = pendingInspects.splice(index, 1)[0]
    entry?.resolve(override ?? entry.result)
  },
  setCaptureError: message => { captureError = message },
  setHoldCapture: enabled => { holdCapture = enabled },
  releaseCapture: () => pendingCaptures.shift()?.(),
  setApprovalError: message => { approvalError = message },
  setHoldApproval: enabled => { holdApproval = enabled },
  releaseApproval: () => pendingApprovals.shift()?.(),
  setFullAccessResponse: response => { fullAccessResponse = clone(response) },
  setFullAccessRemembered: value => { fullAccessRemembered = value === true },
  setHoldFullAccessPreference: value => { holdFullAccessPreference = value },
  releaseFullAccessPreference: () => pendingFullAccessPreferences.shift()?.(),
  setHoldFullAccess: enabled => { holdFullAccess = enabled },
  releaseFullAccess: () => pendingFullAccess.shift()?.(),
  setSpendingResponse: response => { spendingResponse = clone(response) },
  setSpendingStatusResponse: response => { spendingStatusResponse = clone(response) },
  setHoldSpending: value => { holdSpending = value },
  releaseSpending: () => pendingSpending.shift()?.(),
  setHoldSpendingStatus: value => { holdSpendingStatus = value },
  releaseSpendingStatus: () => pendingSpendingStatus.shift()?.(),
  emitSpending: result => {
    if (result.success && ['local-only', 'ask-cloud'].includes(result.policy) && result.scope === 'velorn-managed') spendingPolicy = result.policy
    for (const listener of spendingListeners) listener(clone(result))
  },
  setExecutable: value => { executable = clone(value) },
  setExecutableResponse: (action, result) => { result == null ? executableResponses.delete(action) : executableResponses.set(action, clone(result)) },
  setHoldExecutable: (action, enabled) => { enabled ? heldExecutableActions.add(action) : heldExecutableActions.delete(action) },
  releaseExecutable: (executableId, override) => {
    const index = executableId ? pendingExecutables.findIndex(item => item.executableId === executableId) : 0
    if (index < 0) return
    const entry = pendingExecutables.splice(index, 1)[0]
    entry?.resolve(override ?? entry.result)
  },
  snapshot: () => ({ requests: clone(requests), calls: clone(calls), forbiddenCalls: clone(forbiddenCalls),
    localComfyDisplay: { pending: pendingComfyDisplay.map(({ checkId }) => checkId) },
    setupDownloads: { jobs: [...setupJobs.values()].map(clone), listenerCount: setupListeners.size, listenerPeak: setupListenerPeak,
      pendingLists: pendingSetupLists.map(({ listId, options }) => ({ listId, options: clone(options) })),
      pendingActions: pendingSetupActions.map(({ actionId, action }) => ({ actionId, action })) },
    pendingCodexLogins: pendingCodexLogins.map(({ loginId, action }) => ({ loginId, action })),
    codexInspectResult: clone(codexInspectResult),
    pending: [...pending.keys()], listenerCount: listeners.size, listenerSubscriptions, listenerUnsubscriptions,
    pendingInspects: pendingInspects.map(({ inspectId, options }) => ({ inspectId, options: clone(options) })),
    maxListenerCount, storage: Object.fromEntries(storage), fullAccessGrant: clone(fullAccessGrant), fullAccessRemembered, localFullAccessRemembered,
    spendingPolicy, spendingListenerCount: spendingListeners.size,
    mobile: { ...clone(mobileFixture), nativePhoneRemembered, listenerCount: mobileListeners.size, maxListenerCount: maxMobileListenerCount },
    executable: clone(executable), pendingExecutables: pendingExecutables.map(({ executableId, action }) => ({ executableId, action })),
    authored: { project: JSON.stringify(project.getState().currentProject),
      timeline: JSON.stringify(timeline.getState().getProjectData()), assets: JSON.stringify(assets.getState().getProjectData()),
      historyCount: project.getState().projectHistory.length, futureCount: project.getState().projectFuture.length,
      timelineHistory: JSON.stringify(timeline.getState().history), dirty: dirty.isProjectDirty() } }),
}
function MobileFixtureControls() {
  const [, refresh] = React.useState(0)
  React.useEffect(() => {
    const listener = () => refresh(value => value + 1)
    mobileFixtureListeners.add(listener)
    return () => mobileFixtureListeners.delete(listener)
  }, [])
  const last = requests.at(-1), publication = mobileFixture.publication
  const simulatePhone = () => {
    if (!mobileFixture.status?.enabled || mobileFixture.request || !publication?.available || publication.busy) return
    mobileFixture.status = { ...mobileFixture.status, paired: true, pairingCode: null }
    const request = { id: `fixture-phone-${++mobileFixture.sequence}`, scope: mobileFixture.scope,
      text: `Synthetic phone request ${mobileFixture.sequence}: review this project without generating or exporting.`, status: 'pending' }
    mobileFixture.request = request
    emitMobile({ type: 'status', status: mobileFixture.status })
    emitMobile({ type: 'message', id: request.id, scope: request.scope, text: request.text })
  }
  const completeProvider = () => {
    const requestId = requests.at(-1)?.requestId
    const resolve = pending.get(requestId)
    if (!resolve) return
    pending.delete(requestId)
    pendingFailures.delete(requestId)
    resolve({ success: true, text: 'Synthetic mobile review completed in this same conversation. No generation, export, or project changes were made.' })
    notifyMobileFixture()
  }
  const summary = {
    syntheticOnly: true, networkListener: false, realProvider: false,
    enabled: mobileFixture.status?.enabled === true, paired: mobileFixture.status?.paired === true,
    phoneRequest: mobileFixture.request ? { id: mobileFixture.request.id, status: mobileFixture.request.status } : null,
    providerSendCount: requests.length, pendingProviderCount: pending.size,
    lastSend: last ? { provider: last.provider, toolsEnabled: last.toolsEnabled, fullAccess: last.fullAccess,
      researchEnabled: last.researchEnabled, autoApproveEdits: last.autoApproveEdits,
      imageCount: last.images?.length || 0, documentCount: last.documents?.length || 0,
      lastUserText: last.messages?.at(-1)?.content } : null,
    mobileReplyCount: mobileFixture.replies.length, lastMobileReply: mobileFixture.replies.at(-1) || null,
    publicationCount: mobileFixture.publicationCount,
    lastPublication: publication ? { projectName: publication.projectName, chatTitle: publication.chatTitle,
      busy: publication.busy, available: publication.available, awaitingApproval: publication.awaitingApproval,
      status: publication.status, messages: publication.messages,
      preview: publication.preview ? { hasImage: Boolean(publication.preview.dataUrl),
        capturedAt: publication.preview.capturedAt, workspace: publication.preview.workspace } : null } : null,
    forbiddenNativeCallCount: forbiddenCalls.length,
  }
  return <section className="shrink-0 px-4 py-2 border-b border-sf-border bg-sf-dark-900" aria-label="Synthetic mobile fixture controls">
    <div className="flex items-center gap-3 text-xs"><strong>Mobile QA · synthetic RAM only · no network listener</strong>
      <button type="button" className="px-2 py-1 rounded bg-sf-dark-700"
        disabled={!mobileFixture.status?.enabled || Boolean(mobileFixture.request) || !publication?.available || publication.busy}
        onClick={simulatePhone}>Simulate phone request</button>
      <button type="button" className="px-2 py-1 rounded bg-sf-dark-700" disabled={!last || !pending.has(last.requestId)}
        onClick={completeProvider}>Complete provider response</button></div>
    <pre aria-label="Synthetic mobile fixture summary" className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[10px] leading-4">{JSON.stringify(summary, null, 2)}</pre>
  </section>
}
function StandaloneFixture() {
  const currentProject = project(state => state.currentProject)
  const timelineId = project(state => state.currentTimelineId)
  const playhead = timeline(state => state.playheadPosition)
  const [activeTab, setActiveTab] = React.useState('editor'), [open, setOpen] = React.useState(true)
  const [highlightShotIds, setHighlightShotIds] = React.useState([])
  const [modelPickerRequest, setModelPickerRequest] = React.useState(0)
  const workspaceRef = React.useRef(null)
  const workflowReferenceRef = React.useRef(null)
  window.connectedAgentTest.stageWorkflow = entry => workflowReferenceRef.current?.(entry) || { success: false, error: 'No project chat' }
  window.connectedAgentTest.workspace = () => ({ activeTab, open, highlightShotIds })
  if (setupCompletionFixtureMode) window.connectedAgentTest.requestModelPicker = () => { setModelPickerRequest(value => value + 1); setOpen(true) }
  React.useEffect(() => { window.connectedAgentTest.ready = true }, [])
  return <div className="h-screen min-w-0 flex flex-col overflow-hidden bg-sf-dark-950 text-sf-text-primary">
    <header className="flex items-center gap-3 px-4 py-3 border-b border-sf-border min-w-0 shrink-0">
      <strong className="text-sm">Velorn</strong>
      <nav className="flex gap-2" aria-label="Fixture workspace modes">{['storyboard', 'editor'].map(tab =>
        <button key={tab} className="px-2 py-1 text-sm rounded bg-sf-dark-800" aria-current={activeTab === tab ? 'page' : undefined}
          onClick={() => setActiveTab(tab)}>{tab === 'editor' ? 'Editor' : 'Storyboard'}</button>)}</nav>
      <span className="text-xs text-sf-text-muted flex-1 truncate">{currentProject?.name}</span>
      {!open && <button className="px-2 py-1 text-sm rounded bg-sf-dark-800" onClick={() => setOpen(true)}>Open agent</button>}
    </header>
    {mobileFixtureMode && <MobileFixtureControls />}
    <main className="flex flex-1 min-h-0 min-w-0" data-testid="fixture-workspace">
      <div ref={workspaceRef} className="flex-1 min-w-0 min-h-0 overflow-hidden" data-testid="shared-workspace">
        {activeTab === 'storyboard' ? <ProductionWorkspace workspace onBackToEditor={() => setActiveTab('editor')}
          highlightShotIds={highlightShotIds} /> : <section className="h-full flex flex-col p-5" data-testid="editor-fixture">
          <h1 className="text-lg font-semibold">Editor</h1>
          <p className="text-sm text-sf-text-muted mt-2">Synthetic {currentProject?.timelines.find(item => item.id === timelineId)?.name} · one selected clip · {playhead}s</p>
          <img className="min-h-0 object-contain flex-1 mt-5" src={seededAssets[timelineId?.endsWith('-second') ? 1 : playhead > 3 ? 2 : 0].url} alt="Synthetic editor frame" />
          <div className="my-4 p-3 rounded bg-sf-dark-800 text-xs">Video 1 · Signal opening · five seconds</div>
        </section>}
      </div>
      {open && <ConnectedAgentPanel activeTab={activeTab} onClose={() => setOpen(false)} workspaceRef={workspaceRef}
        modelPickerRequest={setupCompletionFixtureMode ? modelPickerRequest : undefined}
        workflowReferenceRef={workflowReferenceRef}
        onHighlight={setHighlightShotIds}
        onShowShot={shotId => { setHighlightShotIds([shotId]); setActiveTab('storyboard') }} />}
    </main>
  </div>
}

// Mirror App's persistent all-workspace dock without starting the real application. The
// actual dock and conversation own all tab/hide/reparent behavior; synthetic
// Inspector and viewer are synthetic. ?timeline=1 opts into the real Timeline
// and TransportControls with one RAM-only image clip and mocked settings reads.
function DockFixture() {
  const currentProject = project(state => state.currentProject)
  const exportBusy = exportActivity(state => Boolean(state.activeJob || state.localActivity))
  const [workspace, setWorkspace] = React.useState('editor')
  const [activeTab, setActiveTab] = React.useState('inspector')
  const [isExpanded, setExpanded] = React.useState(true)
  const [isFullHeight, setFullHeight] = React.useState(false)
  const [width, setWidth] = React.useState(256)
  const [highlightShotIds, setHighlightShotIds] = React.useState([])
  const [modelPickerRequest, setModelPickerRequest] = React.useState(0)
  const hostRef = React.useRef(null), workspaceRef = React.useRef(null)
  const workflowReferenceRef = React.useRef(null)
  window.connectedAgentTest.stageWorkflow = entry => {
    const before = project.getState().currentProjectHandle
    return stageWorkflowInAgent(entry, {
      handlerRef: workflowReferenceRef, reveal: () => { setActiveTab('agent'); setExpanded(true) },
      isCurrent: () => Boolean(project.getState().currentProject) && before === project.getState().currentProjectHandle
        && !project.getState().isLoading && !exportActivity.getState().activeJob,
    })
  }
  const expanded = isExpanded && (workspace === 'editor' || activeTab === 'agent')
  const tabClick = tab => {
    if (activeTab === tab) setExpanded(value => !value)
    else { setActiveTab(tab); setExpanded(true) }
  }
  const toggleExpanded = () => {
    if (workspace !== 'editor' && activeTab !== 'agent') { setActiveTab('agent'); setExpanded(true) }
    else setExpanded(value => !value)
  }
  const revealInspector = React.useCallback(() => { setWorkspace('editor'); setActiveTab('inspector'); setExpanded(true) }, [])
  window.connectedAgentTest.workspace = () => ({ activeTab: workspace, dockTab: activeTab,
    open: isExpanded, isFullHeight, width, highlightShotIds, exportBusy })
  if (setupCompletionFixtureMode) {
    window.connectedAgentTest.requestModelPicker = ({ reveal = true } = {}) => {
      setModelPickerRequest(value => value + 1)
      if (reveal) { setActiveTab('agent'); setExpanded(true) }
    }
    window.connectedAgentTest.revealAgent = () => { setActiveTab('agent'); setExpanded(true) }
  }
  React.useEffect(() => { window.connectedAgentTest.ready = true }, [])
  React.useEffect(() => { if (exportBusy) setWorkspace('export') }, [exportBusy])
  const host = <div className="flex min-h-0 shrink-0" data-testid="right-dock-wrapper"
    style={{ width: expanded ? width + 48 : 48, maxWidth: '60vw' }}>
    {expanded && <ResizeHandle direction="horizontal" className="fixture-dock-resize"
      onResize={clientX => setWidth(Math.max(240, Math.min(600, window.innerWidth - clientX - 48)))} />}
    <div ref={hostRef} className="flex-1 min-w-0 min-h-0" data-testid="right-dock-host" />
  </div>
  return <div className="h-screen min-w-0 flex flex-col overflow-hidden bg-sf-dark-950 text-sf-text-primary">
    <header className="flex items-center gap-3 px-4 py-3 border-b border-sf-border min-w-0 shrink-0" data-testid="fixture-titlebar">
      <strong className="text-sm">Velorn</strong>
      <nav className="flex gap-1 min-w-0" aria-label="Fixture workspace modes">{['storyboard', 'editor', 'generate', 'stock', 'comfyui', 'export', 'discover'].map(tab =>
        <button key={tab} className="px-2 py-1 text-sm rounded bg-sf-dark-800" aria-current={workspace === tab ? 'page' : undefined}
          disabled={exportBusy} onClick={() => setWorkspace(tab)}>{tab === 'comfyui' ? 'ComfyUI' : tab[0].toUpperCase() + tab.slice(1)}</button>)}</nav>
      <span className="text-xs text-sf-text-muted flex-1 truncate">{currentProject?.name}</span>
    </header>
    {mobileFixtureMode && <MobileFixtureControls />}
    <main className="flex flex-1 min-h-0 min-w-0" data-testid="fixture-workspace">
      <div className="flex flex-col flex-1 min-h-0 min-w-0">
        <div className="flex flex-1 min-h-0 min-w-0" data-testid="fixture-upper-area">
          <div ref={workspaceRef} className="flex-1 min-w-0 min-h-0 overflow-hidden" data-testid="shared-workspace"
            inert={exportBusy ? '' : undefined} aria-hidden={exportBusy || undefined}>
            {workspace === 'storyboard' ? <ProductionWorkspace workspace onBackToEditor={() => setWorkspace('editor')}
              highlightShotIds={highlightShotIds} /> : workspace === 'editor' ? <section className="h-full flex flex-col p-5" data-testid="editor-fixture">
              <h1 className="text-lg font-semibold">Editor</h1>
              <p className="text-sm text-sf-text-muted mt-2">Synthetic workspace · one selected clip</p>
              <img className="min-h-0 object-contain flex-1 mt-5" src={seededAssets[0].url} alt="Synthetic editor frame" />
              {TransportControls && <TransportControls />}
            </section> : <section className="h-full min-h-0 flex flex-col p-5" data-testid={`fixture-${workspace}`}>
              <h1>{workspace === 'comfyui' ? 'ComfyUI' : workspace[0].toUpperCase() + workspace.slice(1)} fixture</h1>
              {workspace === 'comfyui' ? <iframe title="Synthetic ComfyUI frame" className="flex-1 mt-4 w-full border-0"
                sandbox="allow-same-origin" srcDoc={'<!doctype html><html><body style="background:#111827;color:#f3f4f6;font:16px sans-serif"><p>Synthetic local iframe — no ComfyUI server.</p><label>Fixture graph note <input aria-label="Fixture graph note" /></label></body></html>'} />
                : <button type="button" className="mt-4 p-2 rounded bg-sf-dark-800 self-start">Synthetic workspace control</button>}
            </section>}
          </div>
          {(workspace !== 'editor' || !isFullHeight) && host}
        </div>
        {workspace === 'editor' && <section className={`${Timeline ? 'h-72' : 'h-44 p-5'} shrink-0 border-t border-sf-border bg-sf-dark-900`} data-testid="fixture-timeline">
          {Timeline ? <Timeline /> : <><h2>Timeline</h2><p className="text-sm text-sf-text-muted mt-4">Video 1 · Signal opening · five seconds</p></>}
        </section>}
      </div>
      {workspace === 'editor' && isFullHeight && host}
    </main>
    <RightPanelDock hostRef={hostRef} activeTab={activeTab} isExpanded={expanded}
      onTabClick={tabClick} onToggleExpanded={toggleExpanded}
      isFullHeight={isFullHeight} onToggleFullHeight={() => setFullHeight(value => !value)}
      fullHeightDisabled={workspace !== 'editor'} inspectorAvailable={workspace === 'editor'}
      inspector={workspace !== 'editor' ? null : InspectorPanel ? <div className="h-full" data-testid="fixture-inspector"><InspectorPanel embedded
        isExpanded={workspace === 'editor' && expanded && activeTab === 'inspector'} onToggleExpanded={revealInspector}
        isFullHeight={isFullHeight} onToggleFullHeight={() => setFullHeight(value => !value)} /></div>
        : <section className="p-4" data-testid="fixture-inspector"><h2>Inspector</h2><p className="mt-4">Selected clip transform controls</p></section>}
      agent={<ConnectedAgentPanel docked
        modelPickerRequest={setupCompletionFixtureMode ? modelPickerRequest : undefined}
        workflowReferenceRef={workflowReferenceRef}
        visible={expanded && activeTab === 'agent'} activeTab={workspace}
        workspaceRef={workspaceRef} onHighlight={setHighlightShotIds}
        onShowShot={shotId => { setHighlightShotIds([shotId]); setWorkspace('storyboard') }} />} />
  </div>
}

const Fixture = new URLSearchParams(window.location.search).has('dock') ? DockFixture : StandaloneFixture
const { DesktopAccountProvider, DesktopAccountButton } = await import('../../src/components/DesktopAccount')
const fixture = <I18nProvider>{new URLSearchParams(location.search).has('accountPanel')
  ? <DesktopAccountProvider hasProject><DesktopAccountButton /><Fixture /></DesktopAccountProvider>
  : <Fixture />}</I18nProvider>
createRoot(document.getElementById('root')).render(new URLSearchParams(window.location.search).has('strict')
  ? <React.StrictMode>{fixture}</React.StrictMode> : fixture)
