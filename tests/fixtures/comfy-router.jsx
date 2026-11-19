// UI-only synthetic Router. No provider, credentials, ComfyUI or project IO.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import ComfyRouterPanel from '../../src/components/ComfyRouterPanel'
import { createRouterImageImporter } from '../../src/services/comfyRouterImport.mjs'
import { importAsset, getAbsoluteFileUrl, getProjectFileUrl } from '../../src/services/fileSystem'

const clone = value => structuredClone(value)
const storage = new Map(), storageWrites = [], calls = [], jobs = [], imports = [], listeners = new Set()
const assets = [], previewedAssets = []
const projectFiles = new Map(), previewListeners = new Set()
let currentPreview = null
const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1024
const drawing = canvas.getContext('2d')
drawing.fillStyle = '#16475d'; drawing.fillRect(0, 0, 1024, 1024)
drawing.fillStyle = '#e7bc64'; drawing.fillRect(240, 240, 544, 544)
const jpegBytes = Uint8Array.from(atob(canvas.toDataURL('image/jpeg', .85).split(',')[1]), char => char.charCodeAt(0))
const setPreview = asset => { currentPreview = asset; previewedAssets.push(asset.id); for (const listener of previewListeners) listener(asset) }
let connected = false, policy = 'ask-cloud', connectError = false, approve = true
let nextStatus = 'IN_PROGRESS', importError = '', refreshError = '', holdSubmit = false, settleSubmit, uncertainSubmit = false
let model = 'byteplus/seedream-4-0-250828', nextPlan = 0, nextJob = 0, spendingOpens = 0
const estimate = { credits: 6.33, usd: 0.03, label: 'Estimated 6.33 credits (US$0.03)', asOf: '2026-10-01' }
const status = () => ({ success: true, configured: connected, keyAccepted: connected, policy, model, modelLabel: 'Seedream 4.0', width: 1024, height: 1024, estimate, sessionOnly: true })
const plans = new Map()
const emit = () => { for (const listener of listeners) listener() }
Object.defineProperty(window, 'localStorage', { value: {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => { storageWrites.push({ key, value }); storage.set(key, String(value)) },
  removeItem: key => storage.delete(key), clear: () => storage.clear(),
  key: index => [...storage.keys()][index] ?? null, get length() { return storage.size },
} })
window.electronAPI = {
  isElectron: true,
  pathJoin: async (...parts) => parts.join('/'),
  createDirectory: async () => ({ success: true }),
  exists: async path => projectFiles.has(path),
  writeFileFromArrayBuffer: async (path, bytes) => { projectFiles.set(path, { blob: new Blob([bytes], { type: 'image/jpeg' }), url: null }); return { success: true } },
  getFileInfo: async path => ({ success: true, info: { size: projectFiles.get(path).blob.size } }),
  getFileUrlDirect: async path => {
    calls.push({ method: 'resolve-url', path })
    const file = projectFiles.get(path)
    if (!file) throw new Error('Synthetic project image is missing.')
    if (!file.url) file.url = URL.createObjectURL(file.blob)
    return file.url
  },
  comfyRouter: {
  status: async () => { calls.push({ method: 'status' }); return clone(status()) },
  list: async () => { calls.push({ method: 'list' }); return { success: true, jobs: clone(jobs) } },
  onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  openGuide: async () => { calls.push({ method: 'guide' }); return { success: true } },
  connect: async ({ apiKey }) => {
    calls.push({ method: 'connect', correctKey: apiKey === 'synthetic-router-key-only' })
    if (connectError) return { success: false, error: `Synthetic credential detail must not render: ${apiKey}` }
    connected = true; return clone(status())
  },
  clear: async () => { calls.push({ method: 'clear' }); connected = false; return clone(status()) },
  preview: async ({ prompt }) => {
    calls.push({ method: 'preview', prompt })
    const planId = `preview-${++nextPlan}`; plans.set(planId, prompt)
    return { success: true, planId, model, modelLabel: 'Seedream 4.0', estimate, policy, requiresNativeApproval: true }
  },
  submit: async ({ planId }) => {
    calls.push({ method: 'submit', planId, nativeConfirmation: true })
    if (holdSubmit) await new Promise(resolve => { settleSubmit = resolve })
    if (!approve) return { success: false, error: 'Generation cancelled at the native confirmation. Nothing was submitted.' }
    if (policy === 'local-only') return { success: false, error: 'Local-only spending blocks cloud images.' }
    const job = { jobId: `job-${++nextJob}`, status: 'IN_QUEUE', model, modelLabel: 'Seedream 4.0',
      prompt: plans.get(planId), estimate, outputAvailable: false, cancellationRequested: false }
    jobs.unshift(job)
    if (uncertainSubmit) {
      job.status = 'UNCERTAIN'; job.errorType = 'SUBMISSION_UNCERTAIN'
      return { success: false, error: 'Submission outcome is uncertain. Do not resubmit; inspect the recorded job.', job: clone(job) }
    }
    return { success: true, job: clone(job) }
  },
  refresh: async ({ jobId }) => {
    calls.push({ method: 'refresh', jobId })
    if (refreshError) return { success: false, error: refreshError }
    const job = jobs.find(value => value.jobId === jobId)
    Object.assign(job, { status: nextStatus, outputAvailable: nextStatus === 'COMPLETED' })
    return { success: true, job: clone(job) }
  },
  cancel: async ({ jobId }) => {
    calls.push({ method: 'cancel', jobId })
    const job = jobs.find(value => value.jobId === jobId); job.cancellationRequested = true
    return { success: true, job: clone(job) }
  },
  output: async ({ jobId }) => {
    calls.push({ method: 'output', jobId })
    return { success: true, bytes: jpegBytes.slice(), mimeType: 'image/jpeg', filename: `velorn-router-${jobId}.jpg` }
  },
  markImported: async ({ jobId, assetId }) => {
    jobs.find(job => job.jobId === jobId).importedAssetId = assetId
    return { success: true }
  },
} }
const importer = createRouterImageImporter({
  getApi: () => window.electronAPI.comfyRouter,
  getProject: () => ({ currentProject: { id: 'synthetic-project' }, currentProjectHandle: '/synthetic/project' }),
  getAssets: () => ({ assets, addAsset: value => { const asset = { ...value, id: `asset-${imports.length}` }; assets.push(asset); return asset },
    setPreview, updateAssetUrl: (id, url) => { const index = assets.findIndex(asset => asset.id === id); assets[index] = { ...assets[index], url } } }),
  captureContext: () => ({ session: 'fixture-session', projectKey: '/synthetic/project' }), isBusy: () => false,
  importFile: async (handle, file, category) => { imports.push(file.name.replace(/^velorn-router-/, '').replace(/\.jpg$/, '')); return importAsset(handle, file, category) },
  resolveAssetUrl: (handle, asset) => asset.absolutePath ? getAbsoluteFileUrl(asset.absolutePath) : getProjectFileUrl(handle, asset.path),
  makeFile: (...args) => new File(...args),
})
window.routerPanelTest = {
  snapshot: () => ({ calls: clone(calls), jobs: clone(jobs), imports: clone(imports), assets: clone(assets), preview: clone(currentPreview), previewedAssets: clone(previewedAssets), storageWrites: clone(storageWrites),
    spendingOpens, connected, policy, subscribers: listeners.size, timelineWrites: 0 }),
  set: values => {
    if ('policy' in values) policy = values.policy
    if ('connectError' in values) connectError = values.connectError
    if ('approve' in values) approve = values.approve
    if ('nextStatus' in values) nextStatus = values.nextStatus
    if ('importError' in values) importError = values.importError
    if ('refreshError' in values) refreshError = values.refreshError
    if ('holdSubmit' in values) holdSubmit = values.holdSubmit
    if ('uncertainSubmit' in values) uncertainSubmit = values.uncertainSubmit
  },
  releaseSubmit: () => { settleSubmit?.(); settleSubmit = null },
  emit,
  addJob: job => { jobs.push({ model, modelLabel: 'Seedream 4.0', ...clone(job) }); emit() },
  deleteImportedAssets: () => { assets.splice(0) },
  breakPreviewUrl: () => {
    assets[0] = { ...assets[0], url: null, absolutePath: undefined }
    setPreview(assets[0])
  },
}
function Fixture() {
  const [open, setOpen] = React.useState(false)
  const [preview, showPreview] = React.useState(currentPreview)
  React.useEffect(() => { previewListeners.add(showPreview); return () => previewListeners.delete(showPreview) }, [])
  return <main style={{ background: '#090e18', color: '#e7ebf5', minHeight: '100vh', padding: 30 }}>
    <h1>Velorn · Synthetic cloud image panel</h1>
    <button onClick={() => setOpen(true)} style={{ marginTop: 20, padding: 12, border: '1px solid #697080' }}>Open cloud images</button>
    {preview && <img alt="Imported Router image preview" src={preview.url || undefined} width={260} height={260} style={{ display: 'block', marginTop: 20 }} />}
    {open && <ComfyRouterPanel onClose={() => setOpen(false)} onOpenSpending={() => { spendingOpens++ }} onImport={async jobId => {
      calls.push({ method: 'import', jobId })
      if (importError) return { success: false, error: importError }
      return importer(jobId, { previewOnly: false })
    }} />}
  </main>
}
createRoot(document.getElementById('root')).render(<Fixture />)
