// RAM-only credential fixture. No real key, profile, model, generation or network.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { I18nProvider } from '../../src/i18n/I18nContext'
import AgentComfyCloudSetup from '../../src/components/AgentComfyCloudSetup'
import ApiKeyDialog from '../../src/components/ApiKeyDialog'

const FAKE = 'synthetic-only-not-a-real-key', LEGACY = 'comfystudio-comfy-api-key'
const storage = new Map(), calls = [], receipts = [], keyEvents = [], forbidden = [], requested = new Set(), changed = new Set()
const waitingValidation = [], waitingCommit = [], waitingCurrent = []
let key = '', request = null, sequence = 0, validateMode = 'valid', failSave = false, holdCommit = false, holdCurrent = false, ordinarySaved = 0
const emit = listeners => { for (const listener of listeners) listener() }
const start = () => { request = { requestId: `guided-${++sequence}` }; emit(requested); return request.requestId }
const originalFetch = window.fetch.bind(window)
window.fetch = async (url, options) => {
  if (!String(url).startsWith('https://api.comfy.org/')) return originalFetch(url, options)
  calls.push({ method: 'validate', hasAuthorization: Boolean(options?.headers?.Authorization), methodType: options?.method })
  if (validateMode === 'hold') await new Promise(resolve => waitingValidation.push(resolve))
  const status = validateMode === 'invalid' ? 401 : validateMode === 'unknown' ? 503 : 200
  return { ok: status === 200, status }
}
Object.defineProperty(window, 'localStorage', { value: {
  getItem: name => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, String(value)), removeItem: name => storage.delete(name),
} })
window.addEventListener('comfystudio-partner-key-changed', event => keyEvents.push(structuredClone(event.detail)))
window.electronAPI = {
  getSetting: async name => { if (name !== 'comfyApiKeyComfyOrg') forbidden.push('unexpected-setting-read'); return key },
  setSetting: async (name, value) => {
    calls.push({ method: 'ordinary-save', hasKey: Boolean(value) })
    if (failSave) return { success: false, error: FAKE }
    key = value; return { success: true }
  },
  openExternalUrl: async url => { calls.push({ method: 'external', url }); return { success: true } },
  comfyCloudSetup: {
    onRequested: callback => { requested.add(callback); return () => requested.delete(callback) },
    onChanged: callback => { changed.add(callback); return () => changed.delete(callback) },
    current: async () => {
      calls.push({ method: 'current' }); const snapshot = request ? { ...request } : null
      if (holdCurrent) await new Promise(resolve => waitingCurrent.push(resolve))
      return { success: true, request: snapshot }
    },
    complete: async payload => {
      calls.push({ method: 'complete', ...payload })
      if (payload.requestId !== request?.requestId) return { success: false }
      request = null; receipts.push({ outcome: 'cancelled', validation: payload.validation }); emit(changed)
      return { success: true }
    },
    save: async ({ requestId, key: candidate, validation, useExisting }) => {
      calls.push({ method: 'guided-save', requestId, hasKey: Boolean(candidate), validation, useExisting: Boolean(useExisting) })
      if (holdCommit) await new Promise(resolve => waitingCommit.push(resolve))
      if (!request || request.requestId !== requestId || failSave || validation === 'invalid'
        || candidate.length > 8192 || /[\x00-\x1f\x7f]/.test(candidate) || useExisting && candidate !== key) return { success: false }
      key = candidate; request = null
      const result = { success: true, outcome: key ? 'saved' : 'removed', configured: Boolean(key), validation, status: key ? validation === 'valid' ? 'verified' : 'configured' : 'missing' }
      receipts.push(result); emit(changed); return result
    },
  },
}
let setMounted
window.cloudSetupTest = {
  ready: true,
  snapshot: () => ({ calls: structuredClone(calls), receipts: structuredClone(receipts), keyEvents: structuredClone(keyEvents), forbidden: [...forbidden],
    configured: Boolean(key), legacyPresent: storage.has(LEGACY), ordinarySaved,
    waitingValidation: waitingValidation.length, waitingCommit: waitingCommit.length, waitingCurrent: waitingCurrent.length,
    listeners: requested.size + changed.size, active: request?.requestId || null }),
  request: start, mode: value => { validateMode = value }, failSave: value => { failSave = value },
  existing: value => { key = value ? FAKE : '' }, legacy: () => storage.set(LEGACY, FAKE),
  stop: () => { request = null; emit(changed) }, staleEvent: () => emit(requested),
  holdCommit: value => { holdCommit = value }, releaseCommit: () => { waitingCommit.splice(0).forEach(resolve => resolve()) },
  releaseValidation: () => { validateMode = 'valid'; waitingValidation.splice(0).forEach(resolve => resolve()) },
  holdCurrent: value => { holdCurrent = value }, releaseCurrent: () => { waitingCurrent.splice(0).forEach(resolve => resolve()) },
  mounted: value => setMounted(value),
}
function Fixture() {
  const [mounted, updateMounted] = useState(true), [ordinary, setOrdinary] = useState(false)
  setMounted = updateMounted
  return <div className="min-h-screen bg-sf-dark-950 p-5 text-sf-text-primary">
    <h1>Guided key setup fixture</h1>
    <button id="request-setup" onClick={start}>Request key setup</button>
    <button onClick={() => setOrdinary(true)}>Ordinary key settings</button>
    {mounted && <AgentComfyCloudSetup />}
    <ApiKeyDialog open={ordinary} onClose={() => setOrdinary(false)} onSaved={value => { ordinarySaved++; if (typeof value !== 'string') forbidden.push('legacy-callback-shape') }} />
  </div>
}
createRoot(document.getElementById('root')).render(<React.StrictMode><I18nProvider><Fixture /></I18nProvider></React.StrictMode>)
