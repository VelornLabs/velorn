// Isolated ExportPanel UI/worker-lifecycle fixture. Every desktop operation is
// an in-memory stand-in; no export worker, destination, preload, MCP, user
// project or native filesystem is opened. This is not export-output parity.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import '../../src/index.css'
import ExportPanel from '../../src/components/ExportPanel'
import ExportProgressOverlay from '../../src/components/ExportProgressOverlay'
import useExportActivityStore, { isExportBusy } from '../../src/stores/exportActivityStore'
import { startExportActivityBridge } from '../../src/services/exportActivity'
import { I18nProvider } from '../../src/i18n/I18nContext'
import useTimelineStore from '../../src/stores/timelineStore'
import useProjectStore from '../../src/stores/projectStore'
import useAssetsStore from '../../src/stores/assetsStore'
import { watchStoreForProjectChanges, TIMELINE_PROJECT_KEYS, markProjectClean, isProjectDirty } from '../../src/services/projectDirtyTracker'

const memoryRoot = '/__export_workspace_memory__'
const storageKey = `comfystudio-export-settings-v1:${memoryRoot.replace(/[^\w.-]+/g, '_')}`
const calls = [], jobs = [], writes = [], forbiddenCalls = [], existingPaths = new Set()
const listeners = new Map()
const controls = { nextDialog: undefined, nextDirectory: undefined, workerStartupError: null, hardware: true, imageLoadDelayMs: 0 }
let activeJob = null
let activityRevision = 0
const priorityMode = new URLSearchParams(location.search).has('priority')
const clone = value => JSON.parse(JSON.stringify(value))
const validate = path => {
  if (typeof path !== 'string' || !(path === memoryRoot || path.startsWith(`${memoryRoot}/`)) || path.split('/').includes('..')) {
    throw new Error(`Non-memory path refused: ${path}`)
  }
  return path
}
const subscribe = (name, listener) => {
  if (!listeners.has(name)) listeners.set(name, new Set())
  listeners.get(name).add(listener)
  return () => listeners.get(name).delete(listener)
}
const emit = (name, data, jobId = activeJob?.jobId) => {
  for (const listener of [...(listeners.get(name) || [])]) listener(data, { jobId })
}
const activity = () => ({ revision: activityRevision, activeJob: activeJob ? {
  jobId: activeJob.jobId, owner: activeJob.owner || 'ui', batchId: activeJob.batchId || null,
  progress: activeJob.progress || null, status: activeJob.status || 'running',
} : null })
const publishActivity = () => { activityRevision++; emit('activity', activity()) }
const forbidden = (...args) => {
  forbiddenCalls.push(args)
  calls.push({ method: 'FORBIDDEN', args })
  throw new Error('Fixture refuses real rendering, media writes and native setup')
}
window.electronAPI = {
  isElectron: true, platform: 'linux',
  pathJoin: async (...parts) => validate(parts.join('/').replace(/\/+/g, '/')),
  exists: async path => { validate(path); calls.push({ method: 'exists', path }); return existingPaths.has(path) },
  createDirectory: async (path, options) => {
    validate(path); calls.push({ method: 'createDirectory', path, options }); existingPaths.add(path)
    return { success: true }
  },
  saveFileDialog: async options => {
    if (controls.dialogGate) await controls.dialogGate
    validate(options.defaultPath); calls.push({ method: 'saveFileDialog', options: clone(options) })
    const result = controls.nextDialog === undefined ? options.defaultPath : controls.nextDialog
    controls.nextDialog = undefined
    return result == null ? null : validate(result)
  },
  selectDirectory: async options => {
    validate(options.defaultPath); calls.push({ method: 'selectDirectory', options: clone(options) })
    const result = controls.nextDirectory === undefined ? `${memoryRoot}/delivery` : controls.nextDirectory
    controls.nextDirectory = undefined
    return result == null ? null : validate(result)
  },
  writeFile: async (path, contents, options) => {
    validate(path)
    if (!/\.(fcpxml|xml)$/.test(path) || typeof contents !== 'string') return forbidden(path)
    calls.push({ method: 'writeFile', path, options }); writes.push({ path, contents })
    return { success: true }
  },
  runExportInWorker: async request => {
    validate(request.projectPath); validate(request.outputPath)
    if (activeJob) throw new Error('Fixture detected overlapping export worker jobs')
    calls.push({ method: 'runExportInWorker', jobId: request.jobId })
    jobs.push(clone(request))
    if (controls.workerStartupError) return { success: false, error: controls.workerStartupError }
    activeJob = request
    publishActivity()
    return { success: true, jobId: request.jobId }
  },
  cancelExport: async () => {
    calls.push({ method: 'cancelExport', jobId: activeJob?.jobId })
    if (controls.cancelError) {
      if (activeJob) { activeJob.status = 'cancelling'; publishActivity() }
      return { success: false, error: controls.cancelError }
    }
    const jobId = activeJob?.jobId; activeJob = null
    publishActivity()
    queueMicrotask(() => emit('error', 'Export cancelled', jobId))
    return { success: true }
  },
  onExportProgress: listener => subscribe('progress', listener),
  onExportComplete: listener => subscribe('complete', listener),
  onExportError: listener => subscribe('error', listener),
  getExportActivity: async () => activity(),
  onExportActivity: listener => subscribe('activity', listener),
  onHardwareExportFfmpegChanged: listener => subscribe('hardware', listener),
  checkNvenc: async () => ({ available: controls.hardware, h264: controls.hardware, h265: controls.hardware,
    kind: 'nvenc', gpuName: 'Synthetic encoder capability', ffmpegSource: 'bundled' }),
  checkRtxVideoUpscaleRuntime: async () => ({ ready: false, installAvailable: false, error: 'Synthetic Linux host' }),
  getAudioWaveform: async (path, { sampleCount }) => {
    validate(path); return { success: true, duration: 8, peaks: Array.from({ length: sampleCount }, () => 0.1) }
  },
  getFileUrlDirect: async path => { validate(path); return assets.find(asset => `${memoryRoot}/${asset.path}` === path)?.url || null },
  mixTimelineAudioForCaptions: async () => { throw new Error('Synthetic loudness measurement unavailable') },
  readFileAsBuffer: forbidden, startFramePipe: forbidden, exportVideo: forbidden,
  installRtxVideoUpscaleRuntime: forbidden, runRtxVideoUpscale: forbidden,
  copyFile: forbidden, deleteFile: forbidden, deleteDirectory: forbidden,
}

// Controlled renderer readiness, not fake pixels: the native image decodes
// normally, but this test-only wrapper delays delivery of its onload callback.
// It exposes whether a paused compositor redraws after cold image readiness.
const NativeImage = window.Image
window.Image = function (...args) {
  const image = new NativeImage(...args)
  const delay = Number(controls.imageLoadDelayMs) || 0
  if (!delay) return image
  let onload = null
  Object.defineProperty(image, 'onload', {
    configurable: true,
    get: () => onload,
    set: handler => { onload = handler },
  })
  image.addEventListener('load', event => {
    window.setTimeout(() => {
      calls.push({ method: 'delayedImageLoad', delay, width: image.naturalWidth, height: image.naturalHeight })
      onload?.call(image, event)
    }, delay)
  }, { once: true })
  return image
}
window.Image.prototype = NativeImage.prototype

function still(color, label) {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360
  const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 640, 360)
  context.fillStyle = '#fff'; context.font = '36px sans-serif'; context.fillText(label, 45, 190)
  return canvas.toDataURL('image/png')
}
const assets = [
  { id: 'still-a', name: 'First synthetic image', type: 'image', path: 'assets/first.png', url: still('#30455e', 'VELORN · FIRST'),
    duration: 8, settings: { width: 640, height: 360, fps: 24 } },
  { id: 'still-b', name: 'Second synthetic image', type: 'image', path: 'assets/second.png', url: still('#6e5141', 'VELORN · SECOND'),
    duration: 8, settings: { width: 640, height: 360, fps: 24 } },
  { id: 'audio', name: 'Synthetic audio path', type: 'audio', path: 'assets/sound.wav', duration: 8,
    absolutePath: `${memoryRoot}/assets/sound.wav`, hasAudio: true, settings: { duration: 8, sampleRate: 48000 } },
]
const track = (id, type = 'video') => ({ id, name: id, type, visible: true, muted: false, locked: false, volume: 100, pan: 0, inserts: [] })
const clip = (id, assetId, trackId, startTime, duration, type = 'image') => ({
  id, name: id, assetId, trackId, startTime, duration, type, url: assets.find(asset => asset.id === assetId)?.url,
  trimStart: 0, trimEnd: duration, sourceDuration: 8, sourceFps: 24, timelineFps: 24, sourceTimeScale: 1, speed: 1,
  enabled: true, effects: [], keyframes: {}, transform: { scaleX: 100, scaleY: 100, opacity: 100 },
})
function reset({ kind = 'mixed', settings = null } = {}) {
  if (activeJob) throw new Error('Complete/cancel the synthetic worker before resetting its panel')
  calls.length = 0; jobs.length = 0; writes.length = 0; existingPaths.clear()
  controls.nextDialog = undefined; controls.nextDirectory = undefined; controls.workerStartupError = null; controls.imageLoadDelayMs = 0
  controls.cancelError = null
  localStorage.removeItem(storageKey)
  if (settings) localStorage.setItem(storageKey, JSON.stringify(settings))
  useAssetsStore.setState({ assets, folders: [], selectedAssetIds: [], currentPreview: null, previewMode: 'timeline',
    isPlaying: false, volume: 0, videoRef: null, mediaPreparation: null })
  const sound = clip('Synthetic soundtrack', 'audio', 'Sound', 0, 8, 'audio')
  useTimelineStore.setState(state => ({
    timelineSessionId: state.timelineSessionId + 1, compoundEditContext: null,
    clips: kind === 'empty' ? [] : kind === 'audio' ? [sound]
      : [clip('First shot', 'still-a', 'Picture', 0, 4), clip('Second shot', 'still-b', 'Picture', 4, 4), sound],
    tracks: [track('Picture'), track('Sound', 'audio')], transitions: [],
    markers: [{ id: 'kept-marker', time: 3, name: 'Keep this marker' }],
    selectedClipIds: kind === 'mixed' ? ['Second shot'] : [], selectedTransitionId: null, selectedMarkerId: null,
    selectedGap: null, activeTrackId: 'Picture', history: [], historyIndex: -1, historyLastChangedAt: 0,
    clipCounter: 10, markerCounter: 2, transitionCounter: 1,
    playheadPosition: 3, playheadSeekIntent: null, playbackJump: null, playbackJumpError: null,
    isPlaying: false, playbackRate: 1, shuttleMode: false, loopMode: 'normal', playAround: null,
    duration: 8, timelineFps: 24, inPoint: 6, outPoint: 2, zoom: 100, rangeRenderState: null,
    masterAudioVolume: 100, masterAudioInserts: [], useProxyPlaybackForAssets: false,
    previewCompositorMode: 'canvas', glslPreviewQuality: 'full',
  }))
  useProjectStore.setState({ currentProject: { name: 'Synthetic export review',
    settings: { width: 640, height: 360, fps: 24 }, timelines: [{ id: 'synthetic-export', name: 'Review sequence', width: 640, height: 360, fps: 24 }] },
    currentProjectHandle: memoryRoot, currentTimelineId: 'synthetic-export' })
  markProjectClean()
  window.exportWorkspaceTest?.remount?.()
}
function snapshot() {
  const state = useTimelineStore.getState()
  return { settings: JSON.parse(localStorage.getItem(storageKey) || 'null'), calls: clone(calls), jobs: clone(jobs),
    writes: clone(writes), forbiddenCalls: clone(forbiddenCalls), activeJobId: activeJob?.jobId || null,
    listenerCounts: Object.fromEntries([...listeners].map(([name, set]) => [name, set.size])),
    timeline: JSON.stringify(state.getProjectData()), history: JSON.stringify(state.history),
    selectedClipIds: [...state.selectedClipIds], isPlaying: state.isPlaying, playheadPosition: state.playheadPosition,
    inPoint: state.inPoint, outPoint: state.outPoint, dirty: isProjectDirty(), exportBusy: isExportBusy(),
  }
}
window.exportWorkspaceTest = {
  timeline: useTimelineStore, project: useProjectStore, assets: useAssetsStore, memoryRoot, reset, snapshot,
  calls, jobs, writes, controls, existingPaths,
  nativeStart(jobId = 'external-agent-export') {
    activeJob = { jobId, owner: 'mcp', options: {}, projectPath: memoryRoot, outputPath: `${memoryRoot}/external.mp4` }
    jobs.push(activeJob); publishActivity()
  },
  holdDialog() { controls.dialogGate = new Promise(resolve => { controls.releaseDialog = () => { controls.dialogGate = null; resolve() } }) },
  previewPixel() {
    const canvas = document.querySelector('[data-testid="export-review-preview"] canvas[data-preview-popout-source="canvas"]')
    if (!canvas?.width || !canvas?.height) return null
    return [...canvas.getContext('2d').getImageData(10, 10, 1, 1).data]
  },
  progress(progress = 35, jobId = activeJob?.jobId) {
    const data = { status: `Synthetic render ${progress}%`, progress, frame: progress, totalFrames: 100 }
    if (activeJob?.jobId === jobId) { activeJob.progress = data; publishActivity() }
    emit('progress', data, jobId)
  },
  complete(jobId = activeJob?.jobId, extras = {}) {
    const job = jobs.find(candidate => candidate.jobId === jobId)
    if (activeJob?.jobId === jobId) { activeJob = null; publishActivity() }
    emit('complete', { outputPath: job?.outputPath || `${memoryRoot}/external.mp4`, format: job?.options?.format,
      encoderUsed: 'synthetic-worker', ...extras }, jobId)
  },
  fail(message = 'Synthetic export failure', jobId = activeJob?.jobId) {
    if (activeJob?.jobId === jobId) { activeJob = null; publishActivity() }
    emit('error', message, jobId)
  },
}
watchStoreForProjectChanges(useTimelineStore, TIMELINE_PROJECT_KEYS)
reset()
function Harness() {
  const busy = useExportActivityStore(state => Boolean(state.activeJob || state.localActivity))
  React.useLayoutEffect(() => priorityMode ? startExportActivityBridge() : undefined, [])
  const [active, setActive] = React.useState(true), [mounted, setMounted] = React.useState(true), [version, setVersion] = React.useState(0)
  window.exportWorkspaceTest.setActive = value => flushSync(() => setActive(value))
  window.exportWorkspaceTest.setMounted = value => flushSync(() => setMounted(value))
  window.exportWorkspaceTest.remount = () => flushSync(() => { setVersion(value => value + 1); setMounted(true); setActive(true) })
  return <div className="h-screen flex flex-col overflow-hidden bg-sf-dark-950 text-sf-text-primary">
    <header className="h-10 shrink-0 flex items-center gap-4 border-b border-sf-dark-700 px-4 text-xs">
      <span>Velorn · isolated export verification</span>
      <button disabled={priorityMode && busy} onClick={() => setActive(true)} aria-pressed={active}>Export workspace</button>
      <button disabled={priorityMode && busy} onClick={() => setActive(false)} aria-pressed={!active}>Other workspace</button>
      <button data-export-allowed="true" onClick={() => { controls.minimized = true }}>Minimize fixture</button>
    </header>
    <div inert={priorityMode && busy ? '' : undefined} aria-hidden={priorityMode && busy ? true : undefined} data-testid="export-fixture-panel" className="flex-1 min-h-0 min-w-0 flex" style={{ display: active ? 'flex' : 'none' }}>
      {mounted && <ExportPanel key={version} active={active} />}
    </div>
    {!active && <main className="p-8 text-sm">Another workspace. Export listeners stay mounted behind this tab.</main>}
    {priorityMode && <ExportProgressOverlay />}
  </div>
}
createRoot(document.getElementById('root')).render(<I18nProvider><Harness /></I18nProvider>)
