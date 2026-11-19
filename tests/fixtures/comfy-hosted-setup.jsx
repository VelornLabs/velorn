// Standalone renderer fixture. Synthetic, memory-only credentials and native API.
// Never touches a real account, settings file, provider, model or running app.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { I18nProvider } from '../../src/i18n/I18nContext'
import ComfyHostedSetup from '../../src/components/ComfyHostedSetup'

const FAKE = 'synthetic-hosted-fixture-secret-not-a-real-key'
const params = new URLSearchParams(window.location.search)
const calls = [], forbidden = [], pendingStatus = [], pendingChecks = []
const storage = new Map(), sessionStorage = new Map()
const memoryStorage = map => ({
  getItem: name => map.get(name) ?? null,
  setItem: (name, value) => map.set(String(name), String(value)),
  removeItem: name => map.delete(name), clear: () => map.clear(),
  key: index => [...map.keys()][index] ?? null,
  get length() { return map.size },
})
Object.defineProperty(window, 'localStorage', { value: memoryStorage(storage) })
Object.defineProperty(window, 'sessionStorage', { value: memoryStorage(sessionStorage) })
let configured = params.has('configured'), remembered = params.has('remembered')
let canRemember = !params.has('memoryOnly'), holdStatus = params.has('holdStatus'), holdCheck = false
let mode = 'verified', clearFails = false, guideFails = false, tainted = false
let checkRevision = 0
let mountedSetter

function result(state) {
  return { state, configured, remembered, canRemember,
    summary: tainted ? `${FAKE} <img src=x onerror=alert(1)>` : `Synthetic ${state} summary`,
    ...(tainted ? { key: FAKE, error: FAKE } : {}) }
}
const api = {
  status: async () => {
    calls.push({ method: 'status' })
    const snapshot = result(configured ? 'configured' : 'missing')
    if (holdStatus) await new Promise(resolve => pendingStatus.push(resolve))
    if (params.has('statusThrows')) throw new Error(`${FAKE}: synthetic status failure`)
    if (params.has('statusMalformed')) return { state: 'verified', configured: false, summary: FAKE }
    return snapshot
  },
  check: async payload => {
    const current = ++checkRevision
    calls.push({ method: 'check', payloadKeys: Object.keys(payload || {}).sort(),
      hasKey: Boolean(payload?.key), fixtureKey: payload?.key === FAKE,
      remember: payload?.remember })
    const capturedMode = mode
    if (holdCheck) await new Promise(resolve => pendingChecks.push(resolve))
    if (current !== checkRevision) return result('unavailable')
    if (capturedMode === 'throw') throw new Error(`${FAKE}: synthetic network failure`)
    if (capturedMode === 'malformed') return { success: true, state: 'not-a-real-state', key: FAKE, summary: FAKE }
    if (capturedMode === 'unconfigured-verified') return { state: 'verified', configured: false, remembered: false, canRemember, summary: FAKE }
    if (payload?.key && capturedMode === 'verified') {
      configured = true
      remembered = Boolean(payload.remember && canRemember)
    }
    return result(capturedMode)
  },
  cancel: async () => { calls.push({ method: 'cancel' }); checkRevision++; return { success: true } },
  clear: async () => {
    calls.push({ method: 'clear' })
    if (clearFails) throw new Error(`${FAKE}: synthetic clear failure`)
    configured = false; remembered = false
    return result('missing')
  },
  openGuide: async payload => {
    calls.push({ method: 'openGuide', ...payload })
    if (guideFails) throw new Error(`${FAKE}: synthetic guide failure`)
    return { success: true }
  },
}
window.electronAPI = {
  ...(params.has('noBridge') ? {} : { comfyHostedSetup: api }),
  getSetting: async () => { forbidden.push('getSetting'); throw new Error('Fixture forbids settings reads') },
  setSetting: async () => { forbidden.push('setSetting'); throw new Error('Fixture forbids settings writes') },
  openExternalUrl: async () => { forbidden.push('openExternalUrl'); throw new Error('Only fixed native guides are permitted') },
}
window.hostedSetupTest = {
  ready: true,
  snapshot: () => ({ calls: structuredClone(calls), forbidden: [...forbidden], configured, remembered,
    waitingStatus: pendingStatus.length, waitingChecks: pendingChecks.length,
    storage: Object.fromEntries(storage), sessionStorage: Object.fromEntries(sessionStorage) }),
  mode: value => { mode = value },
  tainted: value => { tainted = value },
  clearFails: value => { clearFails = value },
  guideFails: value => { guideFails = value },
  holdCheck: value => { holdCheck = value },
  releaseChecks: () => { pendingChecks.splice(0).forEach(resolve => resolve()) },
  releaseStatus: () => { holdStatus = false; pendingStatus.splice(0).forEach(resolve => resolve()) },
  mounted: value => mountedSetter(value),
}
function Fixture() {
  const [mounted, setMounted] = useState(true)
  mountedSetter = setMounted
  return <main className="min-h-screen bg-sf-dark-950 p-4 text-sf-text-primary">
    <h1 className="mb-4 text-lg">Hosted cloud setup fixture</h1>
    <div style={{ maxWidth: 920, margin: '0 auto' }}>{mounted && <ComfyHostedSetup />}</div>
  </main>
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>)
