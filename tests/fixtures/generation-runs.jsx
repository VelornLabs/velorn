// Actual queue/service/store, synthetic native responses and RAM files only.
// Never import App or mount Generate; no real ComfyUI/project/provider exists.
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'

const clone = value => structuredClone(value)
const rootA = '/fixture-only/generation-runs/alpha', rootB = '/fixture-only/generation-runs/beta'
const endpoint = 'http://127.0.0.1:8188'
const files = new Map(), listeners = new Set(), storage = new Map(), calls = []
let records = [], heldDownload = null, holdDownload = false, failDownload = false, failAck = false, failFilename = null
let failProbe = false
let videoDataUrl = null
Object.defineProperty(window, 'localStorage', { value: {
  getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key), clear: () => storage.clear(),
} })
const checked = value => {
  if (!String(value).startsWith('/fixture-only/generation-runs/') || String(value).split('/').includes('..')) throw new Error('Outside RAM fixture')
  return value
}
const log = (method, payload) => calls.push({ method, payload: clone(payload) })
const snapshot = () => ({ success: true, runs: clone(records), updatedAt: new Date().toISOString() })
const emit = () => { for (const listener of listeners) listener(snapshot()) }
const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32
canvas.getContext('2d').fillRect(0, 0, 32, 32)
const pngUrl = canvas.toDataURL('image/png')
const pngBytes = Uint8Array.from(atob(pngUrl.split(',')[1]), char => char.charCodeAt(0))
const output = { filename: 'synthetic-output.png', subfolder: '', type: 'output', nodeId: '2', mediaType: 'image' }
const workflow = { '1': { class_type: 'KSampler', inputs: { seed: 42 } } }
window.electronAPI = {
  isElectron: true, platform: 'linux', getSetting: async () => null,
  pathJoin: async (...parts) => checked(parts.join('/').replace(/\/+/g, '/')),
  createDirectory: async value => { checked(value); return { success: true } },
  exists: async value => files.has(checked(value)),
  writeFileFromArrayBuffer: async (value, data) => { files.set(checked(value), data.slice(0)); log('write-media', value); return { success: true } },
  writeFile: async (value, data) => { files.set(checked(value), String(data)); log('write-sidecar', value); return { success: true } },
  getFileInfo: async value => ({ name: checked(value).split('/').pop(), size: 128, modified: new Date().toISOString() }),
  getVideoFps: async value => { log('probe', checked(value)); return failProbe ? { success: false } :
    { success: true, duration: 5, width: 1280, height: 720, fps: 24, videoCodec: 'h264', hasAudio: false } },
  getFileUrlDirect: async value => { checked(value); return /\.mp4$/i.test(value) && videoDataUrl ? videoDataUrl : pngUrl },
  generationRuns: {
    list: async args => { log('list', args); return snapshot() },
    onChanged: callback => { listeners.add(callback); return () => listeners.delete(callback) },
    recipe: async args => { log('recipe', args); return { success: true, workflow, cannotExactReplay: true, redacted: false,
      workflowId: 'tpl-mcp-synthetic-workflow', sourceGraphFingerprint: 'a'.repeat(64), resolvedFingerprint: 'b'.repeat(64) } },
    control: async args => {
      log('control', args)
      if (args.previewOnly !== false || !args.operation) throw new Error('Invalid fixture control contract')
      if (args.operation === 'mark-imported' && failAck) { failAck = false; throw new Error('Synthetic acknowledgement interruption') }
      const run = records.find(item => item.id === args.runId)
      if (!run) return { success: false, error: 'Missing synthetic run' }
      if (args.operation === 'mark-imported') {
        run.resultAssetIds = [...new Set([...(run.resultAssetIds || []), ...args.resultAssetIds])]
        run.importState = !run.outputsTruncated && run.resultAssetIds.length >= run.outputs.length ? 'imported' : 'partial'
      }
      else if (args.operation === 'mark-import-failed') run.importState = 'failed'
      else if (args.operation === 'cancel') run.status = 'cancelled'
      else throw new Error('Unsupported synthetic operation')
      emit(); return { success: true, run: clone(run) }
    },
    observe: async () => { log('observe', null); return { success: true, endpoint, updatedAt: new Date().toISOString(), jobs: [
      { promptId: 'external-prompt', status: 'queued', origin: 'external', runId: null, label: 'External ComfyUI job' },
    ] } },
    adopt: async args => {
      log('adopt', args)
      if (args.promptId !== 'external-prompt' || args.previewOnly !== false) throw new Error('Invalid fixture adoption contract')
      const run = makeRun('adopted', { promptId: args.promptId, origin: 'external', adopted: true, status: 'queued' })
      records.push(run); emit(); return { success: true, adopted: true, run }
    },
  },
}

const [{ default: Chip }, runs, { default: monitor }, { default: project }, { default: assets },
  { default: timeline }, { comfyui }, { captureMcpContext }, { generationQueueOwner, readGenerationQueueStatus }, { default: exports }] = await Promise.all([
  import('../../src/components/GenerationMonitorChip'), import('../../src/services/generationRuns'),
  import('../../src/stores/generationMonitorStore'), import('../../src/stores/projectStore'), import('../../src/stores/assetsStore'),
  import('../../src/stores/timelineStore'), import('../../src/services/comfyui'), import('../../src/services/mcpContext'),
  import('../../src/services/generationQueueStatus.mjs'), import('../../src/stores/exportActivityStore'),
])
function selectProject(key = rootA) {
  project.setState({ currentProjectHandle: key, currentProject: { name: key === rootA ? 'Tower film' : 'Other project', created: key,
    settings: { width: 1920, height: 1080, fps: 24 }, timelines: [{ id: 'main', name: 'Main' }] }, currentTimelineId: 'main', autoSaveEnabled: false,
    saveProject: async () => { log('save-project', key); return true } })
  timeline.setState({ timelineSessionId: (timeline.getState().timelineSessionId || 0) + 1 })
  assets.setState({ assets: [], folders: [], folderCounter: 1, currentPreview: null })
}
selectProject()
comfyui.getHttpBase = () => endpoint
comfyui.downloadImage = async filename => {
  log('download', filename)
  if (failDownload) { failDownload = false; throw new Error('Synthetic download failure') }
  if (filename === failFilename) { failFilename = null; throw new Error('Synthetic partial download failure') }
  if (holdDownload) { holdDownload = false; await new Promise(resolve => { heldDownload = resolve }) }
  return new File([pngBytes], filename, { type: 'image/png' })
}
comfyui.downloadVideo = async filename => {
  log('download-video', filename)
  if (!videoDataUrl) throw new Error('Missing synthetic video')
  const bytes = Uint8Array.from(atob(videoDataUrl.split(',')[1]), char => char.charCodeAt(0))
  return new File([bytes], filename, { type: 'video/mp4' })
}
function makeRun(id, extra = {}) {
  return { id, requestId: `request-${id}`, promptId: `prompt-${id}`, endpoint, projectKey: rootA,
    origin: 'agent', label: 'Tower close-up — local upscale', status: 'running', progress: null, node: null,
    createdAt: '2026-09-29T10:00:00.000Z', startedAt: '2026-09-29T10:00:01.000Z', completedAt: null,
    recipeAvailable: true, outputs: [], resultAssetIds: [], importState: 'pending', autoImport: false,
    assessment: { risk: 'local' }, ...extra }
}
function seed() {
  records = [makeRun('running'), makeRun('complete', { label: 'Storyboard still', origin: 'velorn', status: 'done', progress: 100,
    completedAt: '2026-09-29T10:01:00.000Z', outputs: [output] }),
  makeRun('unknown', { label: 'Connection interrupted', status: 'unknown', error: 'The last result could not be confirmed.' }),
  makeRun('other', { label: 'Another project’s render', projectKey: rootB, status: 'done', outputs: [output] })]
  emit()
}
seed()
window.generationRunsTest = {
  ready: false, calls, files, records: () => clone(records), monitor: () => clone(monitor.getState().runs),
  context: () => captureMcpContext(), selectProject, rootA, rootB, seed,
  state: () => ({ calls: clone(calls), assets: clone(assets.getState().assets), files: [...files.keys()], listeners: listeners.size }),
  import: (id, options) => runs.importGenerationRunResults(id, options),
  seedMisclassifiedVideo: id => assets.getState().addAsset({ id: `old-${id}`, name: 'generated.mp4', type: 'image',
    path: 'assets/images/generated.mp4', mimeType: 'video/mp4', source: 'velorn-generation-run',
    generationRun: { runId: id, outputSignature: 'image:generated.mp4|video|output|75' } }),
  failProbe: value => { failProbe = value },
  setVideoData: value => { videoDataUrl = value },
  publish: (id, extra = {}) => { records.push(makeRun(id, extra)); emit() }, emit,
  setStatus: (id, status) => { const run = records.find(item => item.id === id); run.status = status; emit() },
  stop: () => runs.stopGenerationRuns(), start: () => runs.startGenerationRuns(),
  holdDownload: () => { holdDownload = true }, failDownload: () => { failDownload = true },
  failAcknowledgement: () => { failAck = true }, failFilename: value => { failFilename = value },
  releaseDownload: () => { heldDownload?.(); heldDownload = null }, downloadIsHeld: () => Boolean(heldDownload),
  setExport: active => exports.setState({ activeJob: active ? { jobId: 'synthetic-export', status: 'running' } : null }),
  resetLegacy: () => monitor.getState().reset(),
  publishLegacy: () => monitor.getState().publishQueue({ jobs: [{ id: 'legacy', workflowId: 'fixture', workflowLabel: 'Legacy Generate job',
    status: 'running', progress: 35, promptId: 'prompt-running', endpoint }], isConnected: true,
    owner: generationQueueOwner(project.getState().currentProjectHandle, project.getState().currentProject) }),
  status: () => readGenerationQueueStatus(monitor.getState(), {}, null, generationQueueOwner(project.getState().currentProjectHandle, project.getState().currentProject)),
}
function Fixture() {
  const [tab, setTab] = React.useState('Editor')
  React.useEffect(() => { const stop = runs.startGenerationRuns(); window.generationRunsTest.ready = true; return stop }, [])
  return <div className="min-h-screen bg-sf-dark-950 text-sf-text-primary">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-sf-dark-700 p-3">
      <div className="flex flex-wrap gap-3">{['Storyboard', 'Editor', 'Generate', 'Stock', 'ComfyUI', 'Export', 'Discover'].map(name =>
        <button key={name} onClick={() => setTab(name)} className={tab === name ? 'text-sf-accent' : 'text-sf-text-muted'}>{name}</button>)}</div>
      <Chip onOpenGenerate={() => { throw new Error('Opening Generate is forbidden in this fixture') }} />
    </header>
    <main className="p-8"><h1 className="text-xl">{tab} — synthetic workspace</h1><p className="mt-2 text-sf-text-muted">Queue/service test. No real project or generation is connected.</p></main>
  </div>
}
createRoot(document.getElementById('root')).render(<Fixture />)
