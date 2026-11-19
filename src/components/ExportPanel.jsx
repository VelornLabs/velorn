import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Plus, Trash2, Play, Film, RotateCcw, Sparkles, Square, PanelRightClose, ListVideo, Folder, Pause } from 'lucide-react'
import ExportReviewPreview from './ExportReviewPreview'
import ExportTimelineOverview from './ExportTimelineOverview'
import ExportWorkspaceLayout from './ExportWorkspaceLayout'
import ExportPresetPicker from './ExportPresetPicker'
import ExportReadinessPanel from './ExportReadinessPanel'
import { DELIVERY_PRESETS, resolveDeliveryPresetSettings, resolveDeliveryResolution } from '../utils/exportDeliveryPresets.mjs'
import { LEGACY_EXPORT_PRESETS as EXPORT_PRESETS } from '../utils/exportLegacyPresets.mjs'
import { validateCustomExportPresetSettings } from '../utils/exportPresetLibrary.mjs'
import { timeToFrameIndex } from '../utils/timelineFrames'
import { formatExportOverviewTimecode } from '../utils/exportTimelineOverview.mjs'
import './ExportWorkspace.css'
import useProjectStore, { RESOLUTION_PRESETS, FPS_PRESETS } from '../stores/projectStore'
import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useExportActivityStore, { beginLocalExportActivity, isExportBusy } from '../stores/exportActivityStore'
import exportTimeline from '../services/exporter'
import buildFcpXml from '../services/fcpxmlExporter'
import buildPremiereXml from '../services/premiereXmlExporter'
import { mixTimelineAudioToWav } from '../services/timelineAudioMix'
import { analyzeAudioBuffer } from '../services/audioAnalysis'
import {
  resolveAvailablePngSequenceFolder,
  sanitizePngSequenceBaseName,
} from '../services/pngSequenceExport.mjs'
import {
  classifyExportWorkerEvent,
  createExportWorkerJobId,
  isCleanExportCancellation,
} from '../services/exportWorkerLifecycle.mjs'
import {
  checkRtxVideoUpscaleReadiness,
  installRtxVideoUpscaleRuntime,
} from '../services/rtxVideoUpscale'
import {
  RTX_VIDEO_UPSCALE_DEFAULTS,
  RTX_VIDEO_UPSCALE_QUALITY_OPTIONS,
  resolveRtx4kDimensions,
} from '../config/rtxVideoUpscaleConfig'
import { useI18n } from '../i18n/I18nContext'
import { hasUsableProxy } from '../services/proxyCache'
import { normalizeTransparentExportSettings, supportsTransparentExport } from '../utils/alphaMedia.mjs'

const EXPORT_SETTINGS_STORAGE_PREFIX = 'comfystudio-export-settings-v1'

const EXPORT_FORMATS = [
  { id: 'mp4', label: 'MP4 (H.264/H.265)' },
  { id: 'webm', label: 'WebM (VP9)' },
  { id: 'prores', label: 'MOV (ProRes)' },
  { id: 'audio', label: 'Audio Only (WAV/MP3/M4A)', translationKey: 'export.formatAudio' },
  { id: 'png-seq', label: 'PNG Image Sequence', translationKey: 'export.formatPngSequence' },
  { id: 'gif', label: 'Animated GIF', translationKey: 'export.formatGif' },
]

const XML_EXPORT_FORMATS = [
  {
    id: 'fcpxml',
    label: 'Resolve / Final Cut (FCPXML)',
    buttonLabel: 'Export FCPXML',
    progressLabel: 'FCPXML',
    extension: 'fcpxml',
    dialogTitle: 'Export FCPXML',
    filterName: 'Final Cut Pro XML',
    tooltip: 'Export the current timeline as FCPXML for DaVinci Resolve or Final Cut Pro',
  },
  {
    id: 'premiere',
    label: 'Premiere Pro XML (Beta)',
    buttonLabel: 'Export Premiere XML',
    progressLabel: 'Premiere XML',
    extension: 'xml',
    dialogTitle: 'Export Premiere Pro XML',
    filterName: 'Adobe Premiere Pro XML',
    tooltip: 'Export the current timeline as Final Cut Pro 7 XMEML v5 for Adobe Premiere Pro',
  },
]

const RANGE_PRESETS = [
  { id: 'full', label: 'Full Timeline', translationKey: 'export.rangeFull' },
  { id: 'inout', label: 'In/Out Range', translationKey: 'export.rangeInOut' },
]

// Live code updates can reach a window whose language dictionaries were
// loaded before these controls existed. Keep every new label readable.
const EXPORT_QUEUE_STATUS_LABELS = {
  queued: 'Queued', rendering: 'Rendering', completed: 'Completed', failed: 'Failed', stopped: 'Stopped',
}

const VIDEO_CODECS = {
  mp4: [
    { id: 'h264', label: 'H.264' },
    { id: 'h265', label: 'H.265' },
  ],
  webm: [
    { id: 'vp9', label: 'VP9' },
  ],
  prores: [
    { id: 'prores', label: 'ProRes' },
  ],
  // Audio-only export renders no video; the empty list keeps the format
  // switcher's codec reset from inventing one.
  audio: [],
  'png-seq': [],
  gif: [],
}

const AUDIO_CODECS = {
  mp4: [
    { id: 'aac', label: 'AAC' },
  ],
  webm: [
    { id: 'opus', label: 'Opus' },
  ],
  prores: [
    { id: 'aac', label: 'AAC' },
  ],
  audio: [
    { id: 'wav', label: 'WAV (lossless)' },
    { id: 'mp3', label: 'MP3' },
    { id: 'aac', label: 'M4A (AAC)' },
  ],
  'png-seq': [],
  gif: [],
}

const ENCODER_PRESETS = [
  { id: 'ultrafast', label: 'Ultra Fast' },
  { id: 'superfast', label: 'Super Fast' },
  { id: 'veryfast', label: 'Very Fast' },
  { id: 'faster', label: 'Faster' },
  { id: 'fast', label: 'Fast' },
  { id: 'medium', label: 'Medium' },
  { id: 'slow', label: 'Slow' },
  { id: 'slower', label: 'Slower' },
  { id: 'veryslow', label: 'Very Slow' },
]

const QUALITY_MODES = [
  { id: 'crf', label: 'Automatic (CRF)' },
  { id: 'bitrate', label: 'Restrict to bitrate' },
]

const KEYFRAME_MODES = [
  { id: 'auto', label: 'Automatic' },
  { id: 'manual', label: 'Every' },
]

const NVENC_PRESETS = [
  { id: 'p1', label: 'P1 (Fastest)' },
  { id: 'p2', label: 'P2' },
  { id: 'p3', label: 'P3' },
  { id: 'p4', label: 'P4' },
  { id: 'p5', label: 'P5 (Balanced)' },
  { id: 'p6', label: 'P6' },
  { id: 'p7', label: 'P7 (Best Quality)' },
]

const AUDIO_SAMPLE_RATES = [
  { id: 44100, label: '44.1 kHz' },
  { id: 48000, label: '48 kHz' },
]

const AUDIO_CHANNELS = [
  { id: 2, label: 'Stereo' },
  { id: 1, label: 'Mono' },
]

const EXPORT_RESOLUTION_SCALE_OPTIONS = [
  { id: 'timeline-half', label: 'Half Timeline Resolution', translationKey: 'export.resolutionHalf', scale: 0.5 },
  { id: 'timeline-third', label: 'Third Timeline Resolution', translationKey: 'export.resolutionThird', scale: 1 / 3 },
  { id: 'timeline-quarter', label: 'Quarter Timeline Resolution', translationKey: 'export.resolutionQuarter', scale: 0.25 },
]

const DEFAULT_CRF = {
  h264: 18,
  h265: 20,
  vp9: 32,
}

const createDefaultExportSettings = (filename) => ({
  filename,
  format: 'mp4',
  videoCodec: 'h264',
  audioCodec: 'aac',
  proresProfile: '3',
  useHardwareEncoder: false,
  nvencPreset: 'p5',
  preset: 'medium',
  qualityMode: 'crf',
  crf: DEFAULT_CRF.h264,
  bitrateKbps: 8000,
  keyframeMode: 'auto',
  keyframeInterval: 48,
  resolution: 'project',
  customWidth: 1920,
  customHeight: 1080,
  fps: 'project',
  range: 'full',
  renderMode: 'single',
  includeAudio: true,
  audioBitrateKbps: 192,
  audioSampleRate: 44100,
  audioChannels: 2,
  normalizeAudio: false,
  loudnessTarget: -14,
  useProxyMedia: false,
  useDirectFramePipe: true,
  postProcessUpscale: 'none',
  rtxUpscaleQuality: RTX_VIDEO_UPSCALE_DEFAULTS.quality,
  transparent: false,
})


// FFmpeg prores_ks profile: 0=proxy, 1=lt, 2=standard, 3=hq, 4=4444
const PRORES_PROFILES = [
  { id: '0', label: 'Proxy (smallest)' },
  { id: '1', label: 'LT' },
  { id: '2', label: 'Standard' },
  { id: '3', label: 'HQ' },
  { id: '4', label: '4444 (alpha)' },
]

function getExportSettingsStorageKey(projectHandle, projectName) {
  const rawProjectKey = projectHandle || projectName || 'global'
  const safeProjectKey = String(rawProjectKey).replace(/[^\w.-]+/g, '_').slice(-120)
  return `${EXPORT_SETTINGS_STORAGE_PREFIX}:${safeProjectKey}`
}

function loadSavedExportSettings(storageKey, defaultSettings) {
  if (typeof localStorage === 'undefined') return defaultSettings
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return defaultSettings
    const saved = JSON.parse(raw)
    if (!saved || typeof saved !== 'object') return defaultSettings
    return normalizeTransparentExportSettings({
      ...defaultSettings,
      ...saved,
      filename: typeof saved.filename === 'string' && saved.filename.trim()
        ? saved.filename
        : defaultSettings.filename,
      format: EXPORT_FORMATS.some((format) => format.id === saved.format && !format.disabled)
        ? saved.format
        : defaultSettings.format,
      // Retired options (e.g. the old "selection" range) fall back to the
      // default instead of leaving the dropdown on a value it no longer has.
      range: RANGE_PRESETS.some((preset) => preset.id === saved.range)
        ? saved.range
        : defaultSettings.range,
      renderMode: 'single',
      useCachedRenders: false,
      fastSeek: false,
    })
  } catch (_) {
    return defaultSettings
  }
}

function saveExportSettings(storageKey, settings) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings))
  } catch (_) {
    // Ignore storage failures; export should still work.
  }
}

function isAbsoluteFilePath(filePath) {
  const value = String(filePath || '')
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}

function sanitizeExportBaseName(value) {
  return String(value || 'Velorn_Timeline')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'Velorn_Timeline'
}

function ExportField({ id, label, children }) {
  return <div className="export-field"><label htmlFor={id}>{label}</label>{children}</div>
}

function ExportPanel({ active = true }) {
  const globalExportBusy = useExportActivityStore(state => Boolean(state.activeJob || state.localActivity))
  const { t } = useI18n()
  const {
    currentProject,
    currentProjectHandle,
    currentTimelineId,
    getCurrentTimelineSettings,
  } = useProjectStore()
  // Narrow selectors, not a bare useTimelineStore(): this panel stays mounted
  // (lazily) once visited, and a bare subscription re-rendered it on every
  // per-frame playhead write during playback.
  const duration = useTimelineStore((s) => s.duration)
  const inPoint = useTimelineStore((s) => s.inPoint)
  const outPoint = useTimelineStore((s) => s.outPoint)
  const getTimelineEndTime = useTimelineStore((s) => s.getTimelineEndTime)
  const clips = useTimelineStore((s) => s.clips)
  const transitions = useTimelineStore((s) => s.transitions)
  const tracks = useTimelineStore((s) => s.tracks)
  const { assets } = useAssetsStore()
  
  const projectName = currentProject?.name || 'Untitled'
  const currentTimeline = useMemo(() => (
    currentProject?.timelines?.find((timeline) => timeline.id === currentTimelineId) || null
  ), [currentProject?.timelines, currentTimelineId])
  const defaultFilename = `${projectName}_export`
  const defaultSettings = useMemo(() => createDefaultExportSettings(defaultFilename), [defaultFilename])
  const settingsStorageKey = useMemo(
    () => getExportSettingsStorageKey(currentProjectHandle, projectName),
    [currentProjectHandle, projectName]
  )
  
  const [settings, setSettings] = useState(() => loadSavedExportSettings(settingsStorageKey, defaultSettings))
  const [queue, setQueue] = useState([])
  const [queueOpen, setQueueOpen] = useState(true)
  const queueSequenceRef = useRef(0)
  const [loudnessCheck, setLoudnessCheck] = useState({ status: 'idle', result: null, error: '' })
  const [isExporting, setIsExporting] = useState(false)
  const [exportStatus, setExportStatus] = useState('')
  const [exportProgress, setExportProgress] = useState(0)
  const [exportError, setExportError] = useState(null)
  const [exportResult, setExportResult] = useState(null)
  const [externalExportNotice, setExternalExportNotice] = useState(null)
  const [etaSeconds, setEtaSeconds] = useState(null)
  const [renderFps, setRenderFps] = useState(null)
  const activityLeasesRef = useRef(new Set())
  const exportStopRequestedRef = useRef(false)
  useEffect(() => {
    for (const lease of activityLeasesRef.current) lease.update({
      status: exportStatus, progress: { status: exportStatus, progress: exportProgress }, etaSeconds,
    })
  }, [exportStatus, exportProgress, etaSeconds])
  useEffect(() => () => {
    for (const lease of activityLeasesRef.current) lease.end()
    activityLeasesRef.current.clear()
  }, [])
  const [rtxReadiness, setRtxReadiness] = useState({
    status: 'idle',
    ready: false,
    installAvailable: false,
    error: '',
  })
  const [rtxInstallProgress, setRtxInstallProgress] = useState(null)

  // Pre-flight loudness check: render the timeline's program audio (the same
  // mixer captions use) and measure it with the shared analysis engine.
  // Approximate — the mix is 16 kHz and pre-normalization — but plenty to
  // know whether the edit is 6 LU hot before exporting.
  const handleMeasureLoudness = async () => {
    setLoudnessCheck({ status: 'measuring', result: null, error: '' })
    try {
      const mix = await mixTimelineAudioToWav({})
      const arrayBuffer = await mix.blob.arrayBuffer()
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext
      if (!AudioContextCtor) throw new Error('Web Audio API is not available.')
      const audioContext = new AudioContextCtor()
      let audioBuffer
      try {
        audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
      } finally {
        try { audioContext.close() } catch (_) { /* ignore */ }
      }
      const analysis = analyzeAudioBuffer(audioBuffer, { includeLoudnessCurve: false })
      if (analysis?.error) throw new Error(analysis.error)
      setLoudnessCheck({ status: 'done', result: analysis.loudness, error: '' })
    } catch (err) {
      setLoudnessCheck({ status: 'error', result: null, error: err?.message || 'Loudness measurement failed.' })
    }
  }
  const [isXmlExporting, setIsXmlExporting] = useState(false)
  const [xmlExportFormat, setXmlExportFormat] = useState('fcpxml')
  const xmlExportConfig = XML_EXPORT_FORMATS.find((format) => format.id === xmlExportFormat)
    || XML_EXPORT_FORMATS[0]
  const exportStartRef = useRef(null)
  const renderStartRef = useRef(null)
  // The main process permits one hidden export worker at a time. Resolve its
  // lifecycle here so queued jobs wait for completion instead of treating
  // successful worker startup as a completed export.
  const workerExportCompletionRef = useRef(null)
  const nvencCheckRequestRef = useRef(0)
  const [nvencStatus, setNvencStatus] = useState({
    checked: false,
    available: false,
    h264: false,
    h265: false,
    gpuName: null,
    kind: 'nvenc', // 'nvenc' | 'videotoolbox' — set by the platform-aware check
    ffmpegSource: 'bundled',
    ffmpegPath: null,
    ffmpegVersion: null,
    ffmpegWarning: null,
    error: null,
  })
  const [queueRunning, setQueueRunning] = useState(false)
  const [queuePaused, setQueuePaused] = useState(false)
  const [queuePauseRequested, setQueuePauseRequested] = useState(false)
  const queueRef = useRef([])
  const queueControllerRef = useRef({ running: false, paused: false })
  const previousSettingsStorageKeyRef = useRef(settingsStorageKey)

  useEffect(() => {
    if (previousSettingsStorageKeyRef.current === settingsStorageKey) return
    previousSettingsStorageKeyRef.current = settingsStorageKey
    setSettings(loadSavedExportSettings(settingsStorageKey, defaultSettings))
    setQueue([])
  }, [defaultSettings, settingsStorageKey])

  useEffect(() => {
    saveExportSettings(settingsStorageKey, settings)
  }, [settings, settingsStorageKey])

  useEffect(() => {
    queueRef.current = queue
  }, [queue])

  useEffect(() => {
    let cancelled = false
    
    const checkNvenc = async (options = undefined) => {
      const requestId = ++nvencCheckRequestRef.current
      if (!window.electronAPI?.checkNvenc) {
        if (cancelled || requestId !== nvencCheckRequestRef.current) return
        setNvencStatus({ checked: true, available: false, h264: false, h265: false, gpuName: null, kind: 'nvenc', ffmpegSource: 'bundled', ffmpegPath: null, ffmpegVersion: null, ffmpegWarning: null, error: 'Hardware encoder check unavailable' })
        return
      }
      try {
        const result = await window.electronAPI.checkNvenc(options)
        if (cancelled || requestId !== nvencCheckRequestRef.current) return
        setNvencStatus({
          checked: true,
          available: !!result.available,
          h264: !!result.h264,
          h265: !!result.h265,
          gpuName: result.gpuName || null,
          kind: result.kind || 'nvenc',
          ffmpegSource: result.ffmpegSource || 'bundled',
          ffmpegPath: result.ffmpegPath || null,
          ffmpegVersion: result.ffmpegVersion || null,
          ffmpegWarning: result.ffmpegWarning || null,
          error: result.error || null,
        })
      } catch (err) {
        if (cancelled || requestId !== nvencCheckRequestRef.current) return
        setNvencStatus({
          checked: true,
          available: false,
          h264: false,
          h265: false,
          gpuName: null,
          kind: 'nvenc',
          ffmpegSource: 'bundled',
          ffmpegPath: null,
          ffmpegVersion: null,
          ffmpegWarning: null,
          error: err.message,
        })
      }
    }
    
    checkNvenc()
    const unsubscribe = window.electronAPI?.onHardwareExportFfmpegChanged?.(() => {
      if (cancelled) return
      setNvencStatus((current) => ({ ...current, checked: false, error: null }))
      void checkNvenc({ forceRefresh: true })
    })
    return () => {
      cancelled = true
      nvencCheckRequestRef.current += 1
      unsubscribe?.()
    }
  }, [])

  const handleCheckRtxSetup = async () => {
    setRtxReadiness((current) => ({ ...current, status: 'checking', ready: false, error: '' }))
    try {
      const result = await checkRtxVideoUpscaleReadiness()
      setRtxReadiness({
        ...result,
        status: result.ready ? 'ready' : 'error',
        ready: Boolean(result.ready),
        installAvailable: Boolean(result.installAvailable),
        error: result.error || '',
      })
      return result
    } catch (error) {
      const result = {
        ready: false,
        installAvailable: false,
        error: error?.message || 'Could not check the NVIDIA RTX runtime.',
      }
      setRtxReadiness({ ...result, status: 'error' })
      return result
    }
  }

  const handleInstallRtxRuntime = async () => {
    setRtxInstallProgress({ percent: 0, message: 'Preparing the NVIDIA RTX runtime installer...' })
    setRtxReadiness((current) => ({ ...current, status: 'installing', error: '' }))
    try {
      await installRtxVideoUpscaleRuntime({
        onStatus: (status) => setRtxInstallProgress(status),
      })
      setRtxInstallProgress({ percent: 100, message: 'NVIDIA RTX runtime is ready.' })
      return await handleCheckRtxSetup()
    } catch (error) {
      const message = error?.message || 'Could not install the NVIDIA RTX runtime.'
      setRtxReadiness((current) => ({ ...current, status: 'error', ready: false, error: message }))
      setRtxInstallProgress(null)
      return { ready: false, error: message }
    }
  }

  const handleToggleRtxUpscale = () => {
    const enabling = settings.postProcessUpscale !== 'rtx-4k'
    handleSettingChange('postProcessUpscale', enabling ? 'rtx-4k' : 'none')
    if (enabling) void handleCheckRtxSetup()
  }

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.onExportProgress) return
    const onProgress = (data, metadata) => {
      const completion = workerExportCompletionRef.current
      if (completion && classifyExportWorkerEvent(completion.jobId, metadata) === 'external') return
      if (!completion) {
        // Agent/MCP exports intentionally return after startup. Preserve their
        // visible progress without giving them ownership of a UI job promise.
        setIsExporting(true)
        setExportError(null)
        setExportResult(null)
      }
      setExportStatus(data.status || '')
      if (typeof data.progress === 'number') setExportProgress(data.progress)
      if (exportStartRef.current && data.frame != null && data.totalFrames != null) {
        const now = Date.now()
        if (!renderStartRef.current) renderStartRef.current = now
        const elapsed = (now - renderStartRef.current) / 1000
        if (elapsed > 0) {
          setRenderFps(data.frame / elapsed)
          setEtaSeconds(Math.max(0, data.totalFrames - data.frame) / (data.frame / elapsed))
        }
      }
    }
    const onComplete = (data, metadata) => {
      const completion = workerExportCompletionRef.current
      if (completion && classifyExportWorkerEvent(completion.jobId, metadata) === 'external') {
        setExternalExportNotice({
          type: 'success',
          message: data?.outputPath
            ? `Background export completed: ${data.outputPath}`
            : 'Background export completed.',
        })
        return
      }
      // Stringified so saved devtools logs keep nested fields (frameSources,
      // perf) instead of collapsing them to {…}.
      console.log('[ExportPanel] Worker export complete', JSON.stringify(data))
      setExportResult(data)
      setExportStatus('Export complete')
      setExportProgress(100)
      setIsExporting(false)
      workerExportCompletionRef.current = null
      completion?.resolve(data)
    }
    const onError = (err, metadata) => {
      const completion = workerExportCompletionRef.current
      const msg = typeof err === 'string' ? err : (err?.message ?? (err && typeof err === 'object' && err.constructor?.name === 'Event' ? `Export error (${err.type})` : String(err)))
      if (completion && classifyExportWorkerEvent(completion.jobId, metadata) === 'external') {
        const stopped = isCleanExportCancellation(msg)
        setExternalExportNotice({
          type: stopped ? 'stopped' : 'error',
          message: stopped
            ? 'Background export stopped.'
            : `Background export failed: ${msg || 'Unknown error'}`,
        })
        return
      }
      workerExportCompletionRef.current = null
      if (isCleanExportCancellation(msg)) {
        console.log('[ExportPanel] Export stopped by user')
        setExportError(null)
        setExportStatus('Export stopped')
        setIsExporting(false)
        completion?.reject(new Error('Export cancelled'))
        return
      }
      console.error('[ExportPanel] Worker export error', err, '-> displayed:', msg)
      setExportError(msg || 'Export failed')
      setExportStatus('Export failed')
      setIsExporting(false)
      completion?.reject(new Error(msg || 'Export failed'))
    }
    const unsubscribe = [
      window.electronAPI.onExportProgress(onProgress),
      window.electronAPI.onExportComplete(onComplete),
      window.electronAPI.onExportError(onError),
    ]
    return () => {
      for (const removeListener of unsubscribe) {
        if (typeof removeListener === 'function') removeListener()
      }
    }
  }, [])

  // Abort handle for exports running directly in this window (web build);
  // worker exports are cancelled through the main process instead.
  const exportAbortRef = useRef(null)
  const handleStopExport = async () => {
    exportStopRequestedRef.current = true
    if (queueControllerRef.current.running) {
      queueControllerRef.current.paused = true
      setQueuePauseRequested(true)
    }
    setExportStatus('Stopping export...')
    exportAbortRef.current?.abort()
    const result = await window.electronAPI?.cancelExport?.()
    if (result?.success === false) throw new Error(result.error || 'Could not stop export.')
    return result
  }

  const acquireExportActivity = (status) => {
    const pauseAfterCurrent = queueControllerRef.current.running ? () => {
      queueControllerRef.current.paused = true
      setQueuePauseRequested(true)
      for (const item of activityLeasesRef.current) item.update({ pauseRequested: true })
    } : null
    const lease = beginLocalExportActivity({ status, cancel: handleStopExport, pauseAfterCurrent })
    activityLeasesRef.current.add(lease)
    return () => { activityLeasesRef.current.delete(lease); lease.end() }
  }
  const checkExportStopped = () => {
    if (exportStopRequestedRef.current) throw new Error('Export cancelled')
  }

  const handleSettingChange = (key, value) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value }
      
      if (key === 'format') {
        // GIF has no codec controls of its own. Keep every hidden delivery
        // choice untouched so returning to MP4 restores the user's exact
        // codec, CRF, audio, hardware, pipe, RTX, resolution, and FPS setup.
        // Transparency is intentionally cleared because GIF is opaque.
        if (value === 'gif') {
          next.transparent = false
          return next
        }
        const supportedVideo = VIDEO_CODECS[value] || []
        const supportedAudio = AUDIO_CODECS[value] || []
        next.videoCodec = supportedVideo.some((codec) => codec.id === prev.videoCodec)
          ? prev.videoCodec
          : supportedVideo[0]?.id || prev.videoCodec
        const videoCodecChanged = next.videoCodec !== prev.videoCodec
        next.audioCodec = supportedAudio.some((codec) => codec.id === prev.audioCodec)
          ? prev.audioCodec
          : supportedAudio[0]?.id || prev.audioCodec
        if (videoCodecChanged && next.videoCodec && DEFAULT_CRF[next.videoCodec]) {
          next.crf = DEFAULT_CRF[next.videoCodec]
        }
        if (value === 'webm' || value === 'prores' || value === 'audio') {
          next.useHardwareEncoder = false
          next.postProcessUpscale = 'none'
        }
        if (value === 'audio') {
          // The whole export IS the audio — the include toggle is moot.
          next.includeAudio = true
        }
      }
      
      if (key === 'videoCodec') {
        if (DEFAULT_CRF[value]) {
          next.crf = DEFAULT_CRF[value]
        }
        if (value === 'vp9') {
          next.format = 'webm'
          next.useHardwareEncoder = false
          next.postProcessUpscale = 'none'
        } else {
          next.format = 'mp4'
        }
        const supportedAudio = AUDIO_CODECS[next.format] || []
        if (!supportedAudio.find(codec => codec.id === next.audioCodec)) {
          next.audioCodec = supportedAudio[0]?.id || next.audioCodec
        }
      }

      if (key === 'proresProfile' && String(value) !== '4') {
        next.transparent = false
      }

      if (key === 'transparent' && value === true && next.format === 'prores') {
        next.proresProfile = '4'
      }

      if (key === 'resolution' && value === 'custom') {
        const timelineSettings = getCurrentTimelineSettings() || { width: 1920, height: 1080 }
        next.customWidth = Number(prev.customWidth) || timelineSettings.width || 1920
        next.customHeight = Number(prev.customHeight) || timelineSettings.height || 1080
      }

      if (key === 'customWidth' || key === 'customHeight') {
        const minimum = next.format === 'png-seq' || next.format === 'gif' ? 1 : 2
        const numeric = Math.max(minimum, Math.round(Number(value) || minimum))
        next[key] = numeric
      }
      
      return normalizeTransparentExportSettings(next)
    })
  }

  const handleApplyExportPreset = (exportPreset) => {
    if (!exportPreset) return
    // Custom library entries are delivery-only and validated again at this
    // boundary; arbitrary persisted keys must never enter current settings.
    const custom = exportPreset.custom ? validateCustomExportPresetSettings(exportPreset.settings) : null
    if (custom && !custom.ok) return
    setSettings((prev) => {
      const next = {
        ...prev,
        postProcessUpscale: 'none',
        transparent: false,
        ...(custom ? custom.settings : exportPreset.settings),
      }
      const requestedCodec = next.videoCodec
      const requestedHardware = Boolean(next.useHardwareEncoder)
      const hardwareSupported = requestedCodec === 'h265'
        ? nvencStatus.h265
        : requestedCodec === 'h264'
          ? nvencStatus.h264
          : false

      if (requestedHardware && nvencStatus.checked && !hardwareSupported) {
        next.useHardwareEncoder = false
      }
      if (next.format === 'webm' || next.format === 'prores' || next.videoCodec === 'vp9') {
        next.useHardwareEncoder = false
      }
      const supportedVideo = VIDEO_CODECS[next.format] || []
      if (supportedVideo.length && !supportedVideo.find(codec => codec.id === next.videoCodec)) {
        next.videoCodec = supportedVideo[0]?.id || prev.videoCodec
      }
      const supportedAudio = AUDIO_CODECS[next.format] || []
      if (supportedAudio.length && !supportedAudio.find(codec => codec.id === next.audioCodec)) {
        next.audioCodec = supportedAudio[0]?.id || prev.audioCodec
      }
      return normalizeTransparentExportSettings(next)
    })
  }

  const handleResetSettings = () => {
    setSettings(createDefaultExportSettings(defaultFilename))
  }

  const presetTimelineSettings = getCurrentTimelineSettings() || { width: 1920, height: 1080, fps: 24 }
  const allExportPresets = useMemo(() => [
    ...DELIVERY_PRESETS.map(preset => ({ ...preset, settings: resolveDeliveryPresetSettings(preset, presetTimelineSettings) })),
    ...EXPORT_PRESETS,
  ], [presetTimelineSettings.width, presetTimelineSettings.height, presetTimelineSettings.fps])
  const activeExportPresetId = useMemo(() => {
    if (settings.postProcessUpscale === 'rtx-4k' || settings.transparent) return null
    const isEqual = (a, b) => String(a) === String(b)
    return allExportPresets.find((exportPreset) => (
      Object.entries(exportPreset.settings).every(([key, value]) => isEqual(settings[key], value))
    ))?.id || null
  }, [settings, allExportPresets])

  const selectedNvencCodecSupported = settings.videoCodec === 'h265'
    ? nvencStatus.h265
    : settings.videoCodec === 'h264'
      ? nvencStatus.h264
      : false
  // NVENC on Windows/Linux, VideoToolbox on macOS — same toggle, same flow.
  const hardwareKind = nvencStatus.kind || 'nvenc'
  const hardwareLabel = hardwareKind === 'videotoolbox' ? 'VideoToolbox' : 'NVENC'
  const hardwareVendorLabel = hardwareKind === 'videotoolbox' ? 'Apple VideoToolbox' : 'NVIDIA NVENC'
  const nvencToggleDisabledReason = useMemo(() => {
    if (settings.transparent) {
      return 'Transparent exports use a software alpha-capable codec.'
    }
    if (settings.format === 'gif' || settings.format === 'png-seq') {
      return 'Image-based exports do not use hardware video encoding.'
    }
    if (settings.format === 'webm' || settings.videoCodec === 'vp9') {
      return `${hardwareLabel} is only used for MP4 H.264/H.265 exports.`
    }
    if (settings.format === 'prores') {
      return `${hardwareLabel} is not used for ProRes exports.`
    }
    if (nvencStatus.checked && !nvencStatus.available) {
      return `${hardwareLabel} is not available in the active FFmpeg.`
    }
    if (settings.videoCodec === 'h265' && nvencStatus.checked && !nvencStatus.h265) {
      return `HEVC ${hardwareLabel} is not available in the active FFmpeg.`
    }
    if (settings.videoCodec === 'h264' && nvencStatus.checked && !nvencStatus.h264) {
      return `H.264 ${hardwareLabel} is not available in the active FFmpeg.`
    }
    return null
  }, [settings.format, settings.videoCodec, settings.transparent, nvencStatus, hardwareLabel])
  const nvencSummaryText = useMemo(() => {
    if (!nvencStatus.checked) {
      return t('export.hardwareChecking')
    }

    const gpuPrefix = nvencStatus.gpuName
      ? `${t('export.detectedGpu')}: ${nvencStatus.gpuName}. `
      : ''
    const ffmpegSourcePrefix = nvencStatus.ffmpegSource === 'environment'
      ? `${t('export.ffmpegEnvironment')}. `
      : nvencStatus.ffmpegSource === 'setting'
        ? `${t('export.ffmpegCustom')}. `
        : `${t('export.ffmpegBundled')}. `
    const warningSuffix = nvencStatus.ffmpegWarning ? ` ${nvencStatus.ffmpegWarning}` : ''

    if (!nvencStatus.available) {
      return ffmpegSourcePrefix + gpuPrefix + (nvencStatus.error || t('export.hardwareUnavailable', { hardware: hardwareLabel }))
    }

    if (settings.format === 'webm' || settings.videoCodec === 'vp9') {
      return `${ffmpegSourcePrefix}${gpuPrefix}${t('export.hardwareReadySwitch', { hardware: hardwareLabel })}${warningSuffix}`
    }

    if (settings.format === 'prores') {
      return `${ffmpegSourcePrefix}${gpuPrefix}${t('export.hardwareReadyProres', { hardware: hardwareLabel })}${warningSuffix}`
    }

    if (selectedNvencCodecSupported) {
      return `${ffmpegSourcePrefix}${gpuPrefix}${t('export.hardwareReadyCodec', { hardware: hardwareLabel, codec: settings.videoCodec === 'h265' ? 'H.265' : 'H.264' })}${warningSuffix}`
    }

    return `${ffmpegSourcePrefix}${gpuPrefix}${t('export.codecUnavailable', { hardware: hardwareLabel })}${warningSuffix}`
  }, [nvencStatus, selectedNvencCodecSupported, settings.format, settings.videoCodec, hardwareLabel, t])
  const nvencExpectedEncoder = settings.useHardwareEncoder && selectedNvencCodecSupported
    ? (settings.videoCodec === 'h265'
      ? (hardwareKind === 'videotoolbox' ? 'hevc_videotoolbox' : 'hevc_nvenc')
      : (hardwareKind === 'videotoolbox' ? 'h264_videotoolbox' : 'h264_nvenc'))
    : null
  
  const handleAddToQueue = () => {
    const queuedItem = {
      id: `export-${Date.now()}-${++queueSequenceRef.current}`,
      name: settings.filename.trim() || defaultFilename,
      createdAt: new Date().toISOString(),
      status: 'queued',
      settings: { ...settings },
    }
    setQueue((prev) => [queuedItem, ...prev])
    setQueueOpen(true)
  }
  
  const handleRemoveFromQueue = (id) => {
    setQueue((prev) => prev.filter((item) => item.id !== id || item.status === 'rendering'))
  }
  
  const handleClearQueue = () => {
    setQueue([])
  }

  const updateQueueItem = (id, updates) => {
    setQueue((prev) => prev.map(item => item.id === id ? { ...item, ...updates } : item))
  }

  const runQueue = async () => {
    if (queueControllerRef.current.running) return
    queueControllerRef.current.running = true
    queueControllerRef.current.paused = false
    setQueueRunning(true)
    setQueuePaused(false)
    setQueuePauseRequested(false)
    const releaseActivity = acquireExportActivity('Preparing export queue…')
    
    try {
      while (true) {
        if (queueControllerRef.current.paused) break
        const nextItem = queueRef.current.find(item => item.status === 'queued')
        if (!nextItem) break
        
        updateQueueItem(nextItem.id, { status: 'rendering', startedAt: new Date().toISOString() })
        
        try {
          await runExportJob(nextItem.settings, `Queue: ${nextItem.name}`)
          updateQueueItem(nextItem.id, { status: 'completed', completedAt: new Date().toISOString() })
        } catch (err) {
          const cancelled = isCleanExportCancellation(err)
          updateQueueItem(nextItem.id, {
            status: cancelled ? 'stopped' : 'failed',
            error: cancelled ? null : (err.message || 'Export failed'),
          })
        }
      }
    } finally {
      releaseActivity()
      queueControllerRef.current.running = false
      setQueueRunning(false)
      setQueuePaused(queueControllerRef.current.paused)
      setQueuePauseRequested(false)
    }
  }

  const handleStartQueue = () => {
    if (isExporting || isXmlExporting || queueRunning || isExportBusy() || !queueRef.current.some(item => item.status === 'queued')) return
    runQueue()
  }

  const handlePauseQueue = () => {
    if (!queueRunning) return
    queueControllerRef.current.paused = true
    setQueuePauseRequested(true)
  }

  const handleResumeQueue = () => {
    if (isExporting || isXmlExporting || queueRunning || isExportBusy() || !queueRef.current.some(item => item.status === 'queued')) return
    queueControllerRef.current.paused = false
    setQueuePaused(false)
    setQueuePauseRequested(false)
    runQueue()
  }

  const resolveResolution = (exportSettings = settings) => {
    const timelineSettings = getCurrentTimelineSettings() || { width: 1920, height: 1080, fps: 24 }
    const deliveryResolution = resolveDeliveryResolution(exportSettings.resolution, timelineSettings)
    if (deliveryResolution) return deliveryResolution
    const makeEvenDimension = (value) => Math.max(2, Math.round((Number(value) || 2) / 2) * 2)
    const makePngDimension = (value) => Math.max(1, Math.round(Number(value) || 1))
    const normalizeDimension = exportSettings.format === 'png-seq' || exportSettings.format === 'gif'
      ? makePngDimension
      : makeEvenDimension
    if (exportSettings.resolution === 'project') {
      return timelineSettings
    }
    if (exportSettings.resolution === 'custom') {
      return {
        width: normalizeDimension(exportSettings.customWidth || timelineSettings.width),
        height: normalizeDimension(exportSettings.customHeight || timelineSettings.height),
        fps: timelineSettings.fps || 24,
      }
    }
    const scaleOption = EXPORT_RESOLUTION_SCALE_OPTIONS.find(option => option.id === exportSettings.resolution)
    if (scaleOption) {
      return {
        width: normalizeDimension((timelineSettings.width || 1920) * scaleOption.scale),
        height: normalizeDimension((timelineSettings.height || 1080) * scaleOption.scale),
        fps: timelineSettings.fps || 24,
      }
    }
    const preset = RESOLUTION_PRESETS.find(p => p.name === exportSettings.resolution)
    if (preset) {
      return { width: preset.width, height: preset.height, fps: timelineSettings.fps || 24 }
    }
    return timelineSettings
  }

  const getResolutionLabel = (exportSettings = settings) => {
    const timelineSettings = getCurrentTimelineSettings() || { width: 1920, height: 1080, fps: 24 }
    const deliveryResolution = resolveDeliveryResolution(exportSettings.resolution, timelineSettings)
    if (deliveryResolution) return `${exportSettings.resolution === 'youtube-hd' ? 'YouTube HD limit' : 'YouTube 4K limit'} (${deliveryResolution.width}×${deliveryResolution.height})`
    const makeEvenDimension = (value) => Math.max(2, Math.round((Number(value) || 2) / 2) * 2)
    const makePngDimension = (value) => Math.max(1, Math.round(Number(value) || 1))
    const normalizeDimension = exportSettings.format === 'png-seq' || exportSettings.format === 'gif'
      ? makePngDimension
      : makeEvenDimension
    if (exportSettings.resolution === 'project') {
      return `Project (${timelineSettings.width}×${timelineSettings.height})`
    }
    if (exportSettings.resolution === 'custom') {
      return `Custom (${normalizeDimension(exportSettings.customWidth)}×${normalizeDimension(exportSettings.customHeight)})`
    }
    const scaleOption = EXPORT_RESOLUTION_SCALE_OPTIONS.find(option => option.id === exportSettings.resolution)
    if (scaleOption) {
      return `${scaleOption.label} (${normalizeDimension((timelineSettings.width || 1920) * scaleOption.scale)}×${normalizeDimension((timelineSettings.height || 1080) * scaleOption.scale)})`
    }
    return exportSettings.resolution
  }

  const resolveFps = (exportSettings = settings) => {
    if (exportSettings.fps === 'project') {
      return getCurrentTimelineSettings()?.fps || 24
    }
    return Number(exportSettings.fps) || 24
  }

  const rtxUpscaleEnabled = settings.postProcessUpscale === 'rtx-4k'
  const transparentFormatAvailable = ['webm', 'prores'].includes(settings.format)
  const rtxSourceResolution = resolveResolution()
  const rtxTargetResolution = resolveRtx4kDimensions(rtxSourceResolution.width, rtxSourceResolution.height)
  const rtxToggleDisabledReason = !window.electronAPI?.checkRtxVideoUpscaleRuntime
    ? 'RTX upscale is available only in the Velorn desktop app.'
    : settings.transparent
      ? 'RTX upscale does not preserve transparent backgrounds.'
      : window.electronAPI.platform !== 'win32'
      ? 'NVIDIA RTX Video Super Resolution is currently available on Windows only.'
      : settings.format !== 'mp4'
        ? 'NVIDIA RTX Video Super Resolution currently requires an MP4 export.'
        : null

  const rtxReadinessText = rtxReadiness.status === 'checking'
    ? 'Checking the direct NVIDIA RTX runtime...'
    : rtxReadiness.status === 'installing'
      ? (rtxInstallProgress?.message || 'Installing the optional NVIDIA RTX runtime...')
      : rtxReadiness.status === 'ready'
        ? `Direct RTX engine ready${rtxReadiness.gpu ? ` on ${rtxReadiness.gpu}` : ''}.`
        : rtxReadiness.status === 'error'
          ? rtxReadiness.error
          : 'Runs directly on NVIDIA RTX. ComfyUI is not required. Optional runtime is about 1 GB.'

  const resolveRange = (exportSettings = settings) => {
    if (exportSettings.range === 'inout' && inPoint !== null && outPoint !== null) {
      return { start: Math.min(inPoint, outPoint), end: Math.max(inPoint, outPoint) }
    }
    return { start: 0, end: getTimelineEndTime() }
  }

  const formatDuration = (seconds) => {
    if (seconds === null || Number.isNaN(seconds)) return '--:--'
    const clamped = Math.max(0, Math.round(seconds))
    const minutes = Math.floor(clamped / 60)
    const secs = clamped % 60
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  const proxyCoverage = useMemo(() => {
    const videoAssetIds = new Set(
      clips
        .filter((clip) => clip.type === 'video' && clip.assetId)
        .map((clip) => clip.assetId)
    )
    let ready = 0
    let total = 0
    for (const assetId of videoAssetIds) {
      const asset = assets.find((entry) => entry.id === assetId)
      if (!asset || asset.type !== 'video') continue
      total += 1
      if (hasUsableProxy(asset)) ready += 1
    }
    return { ready, total, missing: Math.max(0, total - ready) }
  }, [assets, clips])

  const performanceHints = useMemo(() => {
    const hints = []
    const isPngSequence = settings.format === 'png-seq'
    const isGif = settings.format === 'gif'
    const isVisualOnlyFormat = isPngSequence || isGif
    const timelineSettings = getCurrentTimelineSettings() || { width: 1920, height: 1080, fps: 24 }
    const resolution = resolveResolution()
    const effectiveFps = settings.fps === 'project' ? timelineSettings.fps : Number(settings.fps || timelineSettings.fps)
    const pixelCount = (resolution.width || 1920) * (resolution.height || 1080)
    
    if (pixelCount >= 3840 * 2160) {
      hints.push(t('export.hints.4k'))
    }
    if (settings.postProcessUpscale === 'rtx-4k') {
      if (!isVisualOnlyFormat) {
        hints.push(t('export.hints.rtx'))
      }
    }
    if (settings.transparent) {
      hints.push(t('export.hints.transparent'))
    }
    if (settings.useProxyMedia && proxyCoverage.ready > 0) {
      hints.push(t('export.hints.proxyCount', { ready: proxyCoverage.ready, total: proxyCoverage.total }))
    } else if (settings.useProxyMedia && proxyCoverage.total > 0) {
      hints.push(t('export.hints.proxyMissing'))
    }
    if (effectiveFps >= 60) {
      hints.push(t('export.hints.60fps'))
    }
    if (isPngSequence) {
      hints.push(t('export.hints.pngDiskSpace'))
      hints.push(t('export.hints.pngNoAudio'))
    } else if (isGif) {
      hints.push(t('export.hints.gifPalette'))
      hints.push(t('export.hints.gifNoAudio'))
      if (effectiveFps > 15 || pixelCount > 1280 * 720) {
        hints.push(t('export.hints.gifSize'))
      }
    } else {
      if (!settings.useHardwareEncoder && settings.format === 'mp4' && settings.videoCodec !== 'vp9') {
        hints.push(t('export.hints.nvenc'))
      }
      if (nvencStatus.checked && !nvencStatus.available) {
        hints.push(t('export.hints.nvencMissing'))
      }
      if (settings.format === 'webm' || settings.videoCodec === 'vp9') {
        hints.push(t('export.hints.vp9'))
      }
      if (settings.useDirectFramePipe) {
        hints.push(t('export.hints.fastPipe'))
      } else {
        hints.push(t('export.hints.enableFastPipe'))
      }
    }
    
    const textClips = clips.filter(clip => clip.type === 'text')
    if (textClips.length > 0) {
      hints.push(t('export.hints.text'))
    }
    if (transitions.length > 0) {
      hints.push(t('export.hints.transitions'))
    }
    
    const audioClips = clips.filter(clip => clip.type === 'audio')
    const activeAudioTracks = tracks.filter(track => track.type === 'audio' && track.visible && !track.muted)
    if (!isVisualOnlyFormat && settings.includeAudio && audioClips.length > 0 && activeAudioTracks.length > 0) {
      hints.push(t('export.hints.audio'))
    }
    
    return hints.slice(0, 5)
  }, [clips, transitions, tracks, settings, getCurrentTimelineSettings, nvencStatus, proxyCoverage, t])

  const runExportJob = async (jobSettings, labelOverride = null) => {
    exportStopRequestedRef.current = false
    const releaseActivity = acquireExportActivity('Preparing export…')
    try {
      return await runExportJobInternal(jobSettings, labelOverride)
    } finally {
      exportAbortRef.current = null
      setIsExporting(false)
      releaseActivity()
    }
  }

  const runExportJobInternal = async (jobSettings, labelOverride = null) => {
    const isPngSequence = jobSettings.format === 'png-seq'
    const isGif = jobSettings.format === 'gif'
    const isVisualOnlyFormat = isPngSequence || isGif
    const transparent = jobSettings.transparent === true
    if (transparent && !supportsTransparentExport(jobSettings)) {
      throw new Error('Transparent export requires WebM (VP9) or ProRes 4444.')
    }
    const shouldRunRtxUpscale = !transparent && !isVisualOnlyFormat && jobSettings.postProcessUpscale === 'rtx-4k'
    if (shouldRunRtxUpscale && jobSettings.format !== 'mp4') {
      throw new Error('NVIDIA RTX Video Super Resolution currently requires an MP4 export.')
    }
    if (shouldRunRtxUpscale && window.electronAPI?.platform !== 'win32') {
      throw new Error('NVIDIA RTX Video Super Resolution is currently available on Windows only.')
    }
    if (!isVisualOnlyFormat && jobSettings.useHardwareEncoder && nvencStatus.checked) {
      const codecSupported = jobSettings.videoCodec === 'h265'
        ? nvencStatus.h265
        : nvencStatus.h264
      if (!codecSupported) {
        throw new Error('NVENC is not supported by your FFmpeg build.')
      }
    }

    exportStartRef.current = Date.now()
    renderStartRef.current = null
    setEtaSeconds(null)
    setRenderFps(null)
    setExportError(null)
    setExportResult(null)
    setExternalExportNotice(null)
    setExportProgress(0)
    setExportStatus('Preparing export…')
    setIsExporting(true)

    if (shouldRunRtxUpscale) {
      setExportStatus('Checking the direct NVIDIA RTX runtime...')
      const readiness = await handleCheckRtxSetup()
      checkExportStopped()
      if (!readiness.ready) {
        setIsExporting(false)
        throw new Error(readiness.error || 'The NVIDIA RTX runtime is not ready.')
      }
    }

    const { width, height } = resolveResolution(jobSettings)
    const fps = resolveFps(jobSettings)
    const range = resolveRange(jobSettings)
    const timelineSettings = getCurrentTimelineSettings() || { width: 1920, height: 1080, fps: 24 }
    const options = {
      filename: jobSettings.filename?.trim() || defaultFilename,
      format: jobSettings.format,
      videoCodec: isVisualOnlyFormat ? null : jobSettings.videoCodec,
      audioCodec: isVisualOnlyFormat ? null : jobSettings.audioCodec,
      proresProfile: jobSettings.proresProfile,
      useHardwareEncoder: isVisualOnlyFormat || transparent ? false : jobSettings.useHardwareEncoder,
      nvencPreset: jobSettings.nvencPreset,
      preset: jobSettings.preset,
      qualityMode: jobSettings.qualityMode,
      crf: Number(jobSettings.crf),
      bitrateKbps: Number(jobSettings.bitrateKbps),
      keyframeInterval: jobSettings.keyframeMode === 'auto' ? null : Number(jobSettings.keyframeInterval),
      width,
      height,
      sourceTimelineWidth: timelineSettings.width || width,
      sourceTimelineHeight: timelineSettings.height || height,
      fps,
      rangeStart: range.start,
      rangeEnd: range.end,
      includeAudio: isVisualOnlyFormat ? false : jobSettings.includeAudio,
      audioBitrateKbps: Number(jobSettings.audioBitrateKbps),
      audioSampleRate: Number(jobSettings.audioSampleRate),
      audioChannels: Number(jobSettings.audioChannels),
      normalizeAudio: isVisualOnlyFormat
        ? false
        : (jobSettings.includeAudio || jobSettings.format === 'audio') && !!jobSettings.normalizeAudio,
      loudnessTarget: Number(jobSettings.loudnessTarget) || -14,
      useCachedRenders: false,
      useProxyMedia: jobSettings.useProxyMedia,
      fastSeek: false,
      useDirectFramePipe: isVisualOnlyFormat ? false : jobSettings.useDirectFramePipe,
      postProcessUpscale: isVisualOnlyFormat || transparent ? 'none' : jobSettings.postProcessUpscale,
      transparent,
    }

    if (window.electronAPI?.runExportInWorker && typeof currentProjectHandle === 'string') {
      try {
        const outputFolder = await window.electronAPI.pathJoin(currentProjectHandle, 'renders')
        const createRendersResult = await window.electronAPI.createDirectory(outputFolder)
        if (createRendersResult?.success === false) {
          throw new Error(createRendersResult.error || 'Could not create the project renders folder.')
        }
        checkExportStopped()

        let finalOutputPath
        if (isPngSequence) {
          if (!window.electronAPI.selectDirectory) {
            throw new Error('PNG image sequence folder selection is unavailable. Restart Velorn and try again.')
          }
          setExportStatus('Choose where to save the PNG image sequence...')
          const selectedParentFolder = await window.electronAPI.selectDirectory({
            title: 'Choose PNG Image Sequence Location',
            defaultPath: outputFolder,
          })
          if (!selectedParentFolder) {
            setIsExporting(false)
            throw new Error('Export cancelled')
          }
          finalOutputPath = await resolveAvailablePngSequenceFolder({
            api: window.electronAPI,
            parentFolder: selectedParentFolder,
            filename: options.filename,
          })
          options.filename = sanitizePngSequenceBaseName(options.filename)
          setExportStatus('Preparing PNG image sequence...')
        } else {
          const outputExtension = jobSettings.format === 'audio'
            ? (jobSettings.audioCodec === 'mp3' ? 'mp3' : (jobSettings.audioCodec === 'wav' ? 'wav' : 'm4a'))
            : (isGif ? 'gif' : (jobSettings.format === 'webm' ? 'webm' : (jobSettings.format === 'prores' ? 'mov' : 'mp4')))
          const outputBaseName = shouldRunRtxUpscale ? `${options.filename}_rtx4k` : options.filename
          const defaultPath = await window.electronAPI.pathJoin(outputFolder, `${outputBaseName}.${outputExtension}`)
          finalOutputPath = await window.electronAPI.saveFileDialog({
            title: shouldRunRtxUpscale
              ? 'Export Timeline with NVIDIA RTX 4K Upscale'
              : (isGif ? t('export.exportGif') : 'Export Timeline'),
            defaultPath,
            filters: [{ name: outputExtension.toUpperCase(), extensions: [outputExtension] }],
          })
          if (!finalOutputPath) {
            setIsExporting(false)
            throw new Error('Export cancelled')
          }
        }
        checkExportStopped()
        const sourceOutputPath = shouldRunRtxUpscale
          ? await window.electronAPI.pathJoin(outputFolder, `.velorn-rtx-source-${Date.now()}.mp4`)
          : finalOutputPath
        const postProcess = shouldRunRtxUpscale
          ? {
              type: 'rtx-4k',
              outputPath: finalOutputPath,
              sourceWidth: width,
              sourceHeight: height,
              videoCodec: jobSettings.videoCodec,
              quality: jobSettings.rtxUpscaleQuality || RTX_VIDEO_UPSCALE_DEFAULTS.quality,
            }
          : null
        const state = {
          timeline: { clips, tracks, transitions,
            timelineFps: useTimelineStore.getState().timelineFps,
            masterAudioVolume: useTimelineStore.getState().masterAudioVolume,
            masterAudioInserts: useTimelineStore.getState().masterAudioInserts },
          assets: assets.map((a) => ({
            id: a.id,
            path: a.path,
            type: a.type,
            name: a.name,
            isImported: a.isImported,
            settings: a.settings,
            duration: a.duration,
            proxyPath: a.proxyPath,
            proxyStatus: a.proxyStatus,
            maskFrames: a.maskFrames?.map((f) => ({ ...f, url: undefined })),
          })),
        }
        const jobId = createExportWorkerJobId()
        let resolveWorkerExport
        let rejectWorkerExport
        const workerExportCompletion = new Promise((resolve, reject) => {
          resolveWorkerExport = resolve
          rejectWorkerExport = reject
        })
        // The worker can fail during window startup before the IPC invoke
        // itself resolves; attach a handler immediately to avoid a transient
        // unhandled rejection while we are still awaiting startup.
        workerExportCompletion.catch(() => {})
        const completionRecord = { jobId, resolve: resolveWorkerExport, reject: rejectWorkerExport }
        checkExportStopped()
        workerExportCompletionRef.current = completionRecord
        const workerStart = await window.electronAPI.runExportInWorker({
          jobId,
          projectPath: currentProjectHandle,
          outputPath: sourceOutputPath,
          options: { ...options, outputPath: sourceOutputPath },
          postProcess,
          state,
        })
        if (workerStart?.success === false) {
          if (workerExportCompletionRef.current === completionRecord) {
            workerExportCompletionRef.current = null
          }
          throw new Error(workerStart.error || 'Could not start the export worker.')
        }
        if (workerStart?.jobId !== jobId) {
          if (workerExportCompletionRef.current === completionRecord) {
            workerExportCompletionRef.current = null
          }
          throw new Error('Could not correlate the export worker job. Restart Velorn and try again.')
        }
        // Cancel pressed while native startup was in flight still owns this
        // completion promise; keep the lock until the worker acknowledges it.
        if (exportStopRequestedRef.current) await window.electronAPI.cancelExport?.()
        return await workerExportCompletion
      } catch (err) {
        workerExportCompletionRef.current = null
        const cancelled = isCleanExportCancellation(err)
        setExportError(cancelled ? null : (err?.message || 'Export failed'))
        setExportStatus(cancelled ? 'Export stopped' : 'Export failed')
        setIsExporting(false)
        throw err
      }
    }

    if (window.electronAPI) {
      // The desktop build must never fall back to exporting inside the UI
      // window: it bypasses the worker's crash reporting and memory
      // headroom, and a renderer OOM there takes the whole app down.
      setExportStatus('Export failed')
      setIsExporting(false)
      throw new Error(
        window.electronAPI.runExportInWorker
          ? 'Export worker unavailable: the project location is not a local folder path. Re-open the project from disk and try again.'
          : 'Export worker unavailable. Restart Velorn and try again.'
      )
    }

    if (isVisualOnlyFormat) {
      setExportStatus('Export failed')
      setIsExporting(false)
      throw new Error(`${isGif ? 'Animated GIF' : 'PNG image sequence'} export is available in the Velorn desktop app.`)
    }

    checkExportStopped()
    const directAbortController = new AbortController()
    exportAbortRef.current = directAbortController
    const result = await exportTimeline({ ...options, signal: directAbortController.signal }, (progress) => {
      setExportStatus(labelOverride ? `${labelOverride} • ${progress.status || ''}`.trim() : (progress.status || ''))
      if (typeof progress.progress === 'number') {
        setExportProgress(progress.progress)
      }
      if (exportStartRef.current) {
        const now = Date.now()
        if (progress.frame && progress.totalFrames) {
          if (!renderStartRef.current) {
            renderStartRef.current = now
          }
          const elapsed = (now - renderStartRef.current) / 1000
          if (elapsed > 0) {
            const fpsEstimate = progress.frame / elapsed
            setRenderFps(fpsEstimate)
            const remainingFrames = Math.max(0, progress.totalFrames - progress.frame)
            setEtaSeconds(fpsEstimate > 0 ? remainingFrames / fpsEstimate : null)
          }
        } else if (typeof progress.progress === 'number' && progress.progress > 1) {
          const elapsed = (now - exportStartRef.current) / 1000
          const totalEstimate = elapsed / (progress.progress / 100)
          setEtaSeconds(totalEstimate - elapsed)
        }
      }
    })
    
    setExportResult({ ...result, format: result?.format || jobSettings.format })
    setExportStatus('Export complete')
    setExportProgress(100)
    setIsExporting(false)
    
    return result
  }

  const handleStartExport = async () => {
    if (isExporting || isXmlExporting || queueRunning || isExportBusy()) return
    try {
      await runExportJob(settings)
    } catch (err) {
      const cancelled = isCleanExportCancellation(err)
      setExportError(cancelled ? null : (err.message || 'Export failed'))
      setExportStatus(cancelled ? 'Export stopped' : 'Export failed')
      setIsExporting(false)
    }
  }

  const handleExportXml = async () => {
    if (isExporting || queueRunning || isXmlExporting || isExportBusy()) return
    if (!window.electronAPI?.writeFile || !window.electronAPI?.saveFileDialog || !window.electronAPI?.pathJoin) {
      setExportError(`${xmlExportConfig.progressLabel} export is only available in the desktop app.`)
      return
    }
    if (typeof currentProjectHandle !== 'string') {
      setExportError(`Open a saved project before exporting ${xmlExportConfig.progressLabel}.`)
      return
    }

    setIsXmlExporting(true)
    setExportError(null)
    setExportResult(null)
    setExportProgress(0)
    setEtaSeconds(null)
    setRenderFps(null)
    setExportStatus(`Preparing ${xmlExportConfig.progressLabel}...`)
    exportStopRequestedRef.current = false
    const releaseActivity = acquireExportActivity(`Preparing ${xmlExportConfig.progressLabel}…`)

    try {
      if ((clips || []).some(clip => clip?.type === 'compound' || clip?.compound || clip?.compoundParentId)) {
        throw new Error(`Editable compound clips are not supported by ${xmlExportConfig.progressLabel} export yet. Export a rendered video instead.`)
      }
      const projectPath = currentProjectHandle
      const resolvedAssets = await Promise.all((assets || []).map(async (asset) => {
        if (!asset?.path) return { ...asset, absolutePath: '' }
        const absolutePath = isAbsoluteFilePath(asset.path)
          ? asset.path
          : await window.electronAPI.pathJoin(projectPath, asset.path)
        return {
          ...asset,
          absolutePath,
          hasAudio: asset.hasAudio ?? asset.settings?.hasAudio,
        }
      }))
      const exportableAssetIds = new Set(resolvedAssets.filter((asset) => asset.absolutePath).map((asset) => asset.id))
      const exportableClipCount = (clips || []).filter((clip) => (
        clip?.enabled !== false
        && ['video', 'audio', 'image'].includes(clip?.type)
        && exportableAssetIds.has(clip.assetId)
      )).length
      if (exportableClipCount === 0) {
        throw new Error(`No media clips with project file paths are available for ${xmlExportConfig.progressLabel} export.`)
      }

      const timelineSettings = getCurrentTimelineSettings() || { width: 1920, height: 1080, fps: 24 }
      const timelineName = currentTimeline?.name || 'Timeline'
      const buildXml = xmlExportConfig.id === 'premiere' ? buildPremiereXml : buildFcpXml
      const xml = buildXml({
        projectName,
        timelineName,
        timelineSettings,
        timeline: {
          clips,
          tracks,
          transitions,
          duration: getTimelineEndTime?.() || duration,
          timelineFps: timelineSettings.fps,
        },
        assets: resolvedAssets,
      })

      const outputFolder = await window.electronAPI.pathJoin(projectPath, 'renders')
      await window.electronAPI.createDirectory(outputFolder)
      const defaultPath = await window.electronAPI.pathJoin(
        outputFolder,
        `${sanitizeExportBaseName(`${projectName}_${timelineName}`)}.${xmlExportConfig.extension}`
      )
      const outputPath = await window.electronAPI.saveFileDialog({
        title: xmlExportConfig.dialogTitle,
        defaultPath,
        filters: [{ name: xmlExportConfig.filterName, extensions: [xmlExportConfig.extension] }],
      })
      if (!outputPath) {
        setExportStatus(`${xmlExportConfig.progressLabel} export cancelled`)
        return
      }

      checkExportStopped()
      const writeResult = await window.electronAPI.writeFile(outputPath, xml, { encoding: 'utf8' })
      if (!writeResult?.success) {
        throw new Error(writeResult?.error || `Failed to write ${xmlExportConfig.progressLabel} file.`)
      }

      setExportResult({
        outputPath,
        encoderUsed: xmlExportConfig.progressLabel,
        clipCount: exportableClipCount,
      })
      setExportStatus(`${xmlExportConfig.progressLabel} export complete (${exportableClipCount} clips)`)
    } catch (err) {
      setExportError(err?.message || `${xmlExportConfig.progressLabel} export failed`)
      setExportStatus(`${xmlExportConfig.progressLabel} export failed`)
    } finally {
      setIsXmlExporting(false)
      releaseActivity()
    }
  }

  const timelineSettings = getCurrentTimelineSettings() || { width: 1920, height: 1080, fps: 24 }
  const range = resolveRange()
  const timelineFps = Number(timelineSettings.fps) || 24
  const rangeStartFrame = timeToFrameIndex(range.start, timelineFps)
  const rangeEndFrame = timeToFrameIndex(range.end, timelineFps, 'ceil')
  const hasInOut = Number.isFinite(inPoint) && Number.isFinite(outPoint) && inPoint !== outPoint
  // Match resolveRange without rewriting the saved choice when marks disappear.
  const effectiveRangeMode = settings.range === 'inout' && inPoint !== null && outPoint !== null ? 'inout' : 'full'
  const collapsedMarkedRange = effectiveRangeMode === 'inout' && range.end === range.start
  const hasContent = clips.length > 0 && range.end > range.start
  const previewBusy = isExporting || isXmlExporting || queueRunning || globalExportBusy
  const visualOnly = settings.format === 'png-seq' || settings.format === 'gif'
  const visualExport = settings.format !== 'audio'
  const pendingCount = queue.filter(item => item.status === 'queued').length
  const delivery = (value = settings) => {
    const sourceDimensions = resolveResolution(value)
    const upscaleOutput = !value.transparent && value.postProcessUpscale === 'rtx-4k' && value.format === 'mp4'
    const dimensions = upscaleOutput
      ? resolveRtx4kDimensions(sourceDimensions.width, sourceDimensions.height) : sourceDimensions
    const extension = value.format === 'audio'
      ? (value.audioCodec === 'aac' ? 'm4a' : value.audioCodec)
      : ({ mp4: 'mp4', webm: 'webm', prores: 'mov', gif: 'gif', 'png-seq': 'png' }[value.format] || 'mp4')
    const formatName = value.format === 'audio' ? (extension || 'WAV').toUpperCase()
      : value.format === 'png-seq' ? 'PNG' : value.format === 'gif' ? 'GIF'
        : value.format === 'prores' ? 'ProRes' : String(value.videoCodec).toUpperCase().replace('H264', 'H.264').replace('H265', 'H.265')
    return {
      name: value.format === 'png-seq'
        ? sanitizePngSequenceBaseName(value.filename || defaultFilename) + '_png/'
        : (value.filename?.trim() || defaultFilename) + (upscaleOutput ? '_rtx4k' : '') + '.' + extension,
      summary: value.format === 'audio'
        ? [formatName, (Number(value.audioSampleRate) / 1000) + ' kHz', AUDIO_CHANNELS.find(c => c.id === Number(value.audioChannels))?.label || 'Stereo'].join(' · ')
        : [formatName, dimensions.width + ' × ' + dimensions.height, resolveFps(value) + ' fps'].join(' · '),
    }
  }
  const currentDelivery = delivery()
  const renderSelect = (key, label, options, { numeric = false, disabled = false } = {}) => (
    <ExportField id={'export-' + key} label={label}>
      <select id={'export-' + key} value={settings[key]} disabled={disabled}
        onChange={event => handleSettingChange(key, numeric ? Number(event.target.value) : event.target.value)}>
        {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </ExportField>
  )
  const renderNumber = (key, label, options = {}) => (
    <ExportField id={'export-' + key} label={label}>
      <input id={'export-' + key} type="number" value={settings[key]} {...options}
        onChange={event => handleSettingChange(key, Number(event.target.value))} />
    </ExportField>
  )
  const renderCheck = (key, label, { disabled = false, title } = {}) => (
    <label className="export-check" title={title}>
      <input id={'export-' + key} type="checkbox" checked={!!settings[key]} disabled={disabled}
        onChange={event => handleSettingChange(key, event.target.checked)} />
      <span>{label}</span>
    </label>
  )

  return (
    <div data-testid="export-workspace" className="export-workspace flex-1 min-h-0 flex flex-col min-w-0 overflow-hidden bg-sf-dark-950">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-sf-dark-700 bg-sf-dark-900 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Film className="h-4 w-4 shrink-0 text-sf-accent" />
          <span className="truncate text-xs font-medium text-sf-text-primary">{projectName}</span>
          {currentTimeline?.name && <span className="truncate text-[11px] text-sf-text-muted">/ {currentTimeline.name}</span>}
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-[11px] text-sf-text-muted lg:inline">{timelineSettings.width} × {timelineSettings.height} · {timelineFps} fps</span>
          <button type="button" className="export-action export-action--quiet" aria-expanded={queueOpen}
            aria-controls="export-render-queue" onClick={() => setQueueOpen(open => !open)}
            title={t(queueOpen ? 'export.workspace.hideQueue' : 'export.workspace.showQueue', undefined, queueOpen ? 'Hide queue' : 'Show queue')}>
            <ListVideo className="h-4 w-4" />{t('export.queue')} <span className="text-sf-text-muted">{queue.length}</span>
          </button>
        </div>
      </header>

      <ExportWorkspaceLayout active={active} queueOpen={queueOpen}>
        <section id="export-settings-panel" className="export-workspace__settings" data-testid="export-settings" aria-label={t('export.settings')}>
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="text-xs font-medium text-sf-text-primary">{t('export.settings')}</h2>
            <button type="button" className="export-action export-action--quiet export-action--icon"
              onClick={handleResetSettings} aria-label={t('export.reset')} title={t('export.resetHelp')}>
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="space-y-3">
            <ExportPresetPicker presets={allExportPresets} activePresetId={activeExportPresetId}
              hardwareLabel={hardwareLabel} onApply={handleApplyExportPreset} settings={settings}
              active={active} sessionKey={settingsStorageKey}
              tall={presetTimelineSettings.height > presetTimelineSettings.width} />
            <ExportField id="export-filename" label={t('export.filename')}>
              <input id="export-filename" type="text" value={settings.filename} placeholder={defaultFilename}
                onChange={event => handleSettingChange('filename', event.target.value)} />
            </ExportField>
            <p className="export-help flex items-start gap-2">
              <Folder className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{settings.format === 'png-seq'
                ? t('export.pngOutputLocationHelp', { name: sanitizePngSequenceBaseName(settings.filename || defaultFilename) })
                : t('export.outputLocationHelp')}</span>
            </p>
            <div className="border-t border-sf-dark-700 pt-3">
              {renderSelect('format', t('export.format'), EXPORT_FORMATS.map(item => ({ ...item, label: item.translationKey ? t(item.translationKey) : item.label })))}
            </div>
            {visualOnly && <p className="export-help">{t(settings.format === 'gif' ? 'export.gifHelp' : 'export.imageSequenceHelp')}</p>}
            {visualExport && <>
              {!visualOnly && renderSelect('videoCodec', t('export.videoCodec'), VIDEO_CODECS[settings.format] || [])}
              {settings.format === 'prores' && renderSelect('proresProfile', t('export.proresProfile'), PRORES_PROFILES)}
              {renderSelect('resolution', t('export.resolution'), [
                { id: 'project', label: t('export.projectSettings') + ' · ' + timelineSettings.width + ' × ' + timelineSettings.height },
                ...['youtube-hd', 'youtube-uhd'].map(mode => {
                  const size = resolveDeliveryResolution(mode, timelineSettings)
                  return { id: mode, label: t(mode === 'youtube-hd' ? 'export.deliveryPresets.hdLimit' : 'export.deliveryPresets.uhdLimit',
                    undefined, mode === 'youtube-hd' ? 'YouTube HD limit' : 'YouTube 4K limit') + ' · ' + size.width + ' × ' + size.height }
                }),
                ...EXPORT_RESOLUTION_SCALE_OPTIONS.map(item => ({ id: item.id, label: t(item.translationKey) })),
                { id: 'custom', label: t('export.custom') },
                ...RESOLUTION_PRESETS.map(item => ({ id: item.name, label: item.name })),
              ])}
              {['youtube-hd', 'youtube-uhd'].includes(settings.resolution) && <p className="export-help">
                {t('export.deliveryPresets.sizeHelp', undefined, 'Fits within HD or 4K while keeping the timeline’s orientation. Smaller timelines are not enlarged.')}
              </p>}
              {settings.resolution === 'custom' && <>
                <div className="export-fields-row">
                  {renderNumber('customWidth', t('export.workspace.width', undefined, 'Width'), { min: visualOnly ? 1 : 2, step: visualOnly ? 1 : 2 })}
                  {renderNumber('customHeight', t('export.workspace.height', undefined, 'Height'), { min: visualOnly ? 1 : 2, step: visualOnly ? 1 : 2 })}
                </div>
                {!visualOnly && <p className="export-help">{t('export.evenPixelsHelp')}</p>}
              </>}
              <div className="export-fields-row">
                {renderSelect('fps', t('export.frameRate'), [
                  { id: 'project', label: timelineFps + ' fps' },
                  ...FPS_PRESETS.map(item => ({ id: item.value, label: item.label })),
                ])}
                {!visualOnly && settings.format !== 'prores' && renderNumber(
                  settings.qualityMode === 'crf' ? 'crf' : 'bitrateKbps',
                  settings.qualityMode === 'crf' ? 'CRF' : t('export.bitrate'),
                  { min: settings.qualityMode === 'crf' ? 0 : 100, max: settings.qualityMode === 'crf' ? 63 : 200000 }
                )}
              </div>
              {(transparentFormatAvailable || settings.transparent) && <div className="space-y-1">
                {renderCheck('transparent', t('export.transparentBackground'), { disabled: !transparentFormatAvailable })}
                <p className="export-help">{t('export.transparentBackgroundHelp')}</p>
              </div>}
            </>}

            {!visualOnly && <div className="border-t border-sf-dark-700 pt-3">
              {settings.format === 'audio' ? <p className="export-help">{t('export.audioOnlyHelp')}</p>
                : renderCheck('includeAudio', t('export.includeAudio'))}
              <p className="export-help mt-1">
                {(settings.includeAudio || settings.format === 'audio')
                  ? [String(settings.audioCodec).toUpperCase(), AUDIO_CHANNELS.find(c => c.id === Number(settings.audioChannels))?.label, Number(settings.audioSampleRate) / 1000 + ' kHz'].join(' · ')
                  : t('export.audioDisabled')}
              </p>
            </div>}
          </div>

          {!visualOnly && (settings.includeAudio || settings.format === 'audio') && (
            <details className="export-disclosure" open={settings.format === 'audio' ? true : undefined}>
              <summary>{t('export.workspace.audioSettings', undefined, 'Audio settings')}</summary>
              <div className="space-y-3">
                <div className="export-fields-row">
                  {renderSelect('audioCodec', t('export.audioCodec'), AUDIO_CODECS[settings.format] || [])}
                  {!(settings.format === 'audio' && settings.audioCodec === 'wav')
                    && renderNumber('audioBitrateKbps', t('export.audioBitrate'), { min: 32, max: 512 })}
                </div>
                <div className="export-fields-row">
                  {renderSelect('audioSampleRate', t('export.sampleRate'), AUDIO_SAMPLE_RATES, { numeric: true })}
                  {renderSelect('audioChannels', t('export.channels'), AUDIO_CHANNELS, { numeric: true })}
                </div>
                {renderCheck('normalizeAudio', t('export.normalizeLoudness'))}
                {settings.normalizeAudio && <>
                  {renderSelect('loudnessTarget', t('export.loudnessTarget'), [
                    { id: -14, label: 'Social / Streaming (−14 LUFS)' },
                    { id: -16, label: 'Podcast / Web (−16 LUFS)' },
                    { id: -23, label: 'Broadcast (−23 LUFS)' },
                  ], { numeric: true })}
                  <p className="export-help">{t('export.loudnessHelp')}</p>
                </>}
                <button type="button" className="export-action" onClick={handleMeasureLoudness}
                  disabled={previewBusy || loudnessCheck.status === 'measuring'}>
                  {loudnessCheck.status === 'measuring' ? t('export.measuring') : t('export.measureLoudness')}
                </button>
                {loudnessCheck.status === 'done' && loudnessCheck.result && <p className="export-help" aria-live="polite">
                  ~{loudnessCheck.result.integratedLufsApprox ?? '—'} LUFS · {loudnessCheck.result.peakDb} dBFS
                  {Number.isFinite(loudnessCheck.result.integratedLufsApprox) && Number.isFinite(Number(settings.loudnessTarget))
                    && <> · {(loudnessCheck.result.integratedLufsApprox - Number(settings.loudnessTarget)).toFixed(1)} LU vs {settings.loudnessTarget}</>}
                  <br />{t('export.approximateMix')}
                </p>}
                {loudnessCheck.status === 'error' && <p className="export-help !text-sf-error" role="alert">{loudnessCheck.error}</p>}
              </div>
            </details>
          )}

          {visualExport && !visualOnly && settings.format !== 'prores' && (
            <details className="export-disclosure">
              <summary>{t('export.workspace.advancedEncoding', undefined, 'Advanced encoding')}</summary>
              <div className="space-y-3">
                {renderSelect('qualityMode', t('export.qualityMode'), QUALITY_MODES)}
                {renderSelect('preset', t('export.encoderPreset'), ENCODER_PRESETS)}
                {settings.useHardwareEncoder && hardwareKind === 'nvenc' && renderSelect('nvencPreset', t('export.nvencPreset'), NVENC_PRESETS)}
                {renderSelect('keyframeMode', t('export.keyframes'), KEYFRAME_MODES)}
                {renderNumber('keyframeInterval', t('export.keyframeInterval'), { min: 1, disabled: settings.keyframeMode === 'auto' })}
              </div>
            </details>
          )}

          {visualExport && (
            <details className="export-disclosure">
              <summary>{t('export.workspace.encodingPerformance', undefined, 'Encoding & performance')}</summary>
              <div className="space-y-3">
                {!visualOnly && <>
                  {renderCheck('useHardwareEncoder', t('export.useHardware', { hardware: hardwareVendorLabel }),
                    { disabled: Boolean(nvencToggleDisabledReason), title: nvencToggleDisabledReason || undefined })}
                  <p className={'export-help ' + (!nvencStatus.available ? '!text-sf-warning' : '')}>{nvencSummaryText}</p>
                  {nvencExpectedEncoder && <p className="export-help">{t('export.expectedEncoder')}: {nvencExpectedEncoder}</p>}
                  {renderCheck('useDirectFramePipe', t('export.fastPipe'), { title: t('export.fastPipeHelp') })}
                  <p className="export-help">{t('export.fastPipeShortHelp')}</p>
                </>}
                {renderCheck('useProxyMedia', t('export.useProxies'), { disabled: proxyCoverage.total === 0 })}
                <p className="export-help">{t('export.proxiesHelp')} {t('export.proxyReady', { ready: proxyCoverage.ready, total: proxyCoverage.total })}</p>
                {!visualOnly && <div className="space-y-2 border-t border-sf-dark-700 pt-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex items-center gap-1 text-xs text-sf-text-primary"><Sparkles className="h-3.5 w-3.5 shrink-0 text-sf-accent" />{t('export.rtxUpscale')}</span>
                    <button type="button" role="switch" aria-label="NVIDIA RTX 4K upscale" aria-checked={rtxUpscaleEnabled}
                      disabled={Boolean(rtxToggleDisabledReason) || previewBusy || rtxReadiness.status === 'installing'} onClick={handleToggleRtxUpscale}
                      className={'relative h-5 w-9 shrink-0 rounded-full border border-sf-dark-600 disabled:opacity-50 ' + (rtxUpscaleEnabled ? 'bg-sf-accent' : 'bg-sf-dark-800')}>
                      <span className={'absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-white ' + (rtxUpscaleEnabled ? 'translate-x-4' : '')} />
                    </button>
                  </div>
                  <p className="export-help">{t('export.rtxAfterRender')} {rtxTargetResolution.width} × {rtxTargetResolution.height}</p>
                  {rtxUpscaleEnabled && <>
                    {renderSelect('rtxUpscaleQuality', t('export.quality'), RTX_VIDEO_UPSCALE_QUALITY_OPTIONS, { disabled: rtxReadiness.status === 'installing' })}
                    <button type="button" className="export-action" onClick={() => void handleCheckRtxSetup()}
                      disabled={previewBusy || rtxReadiness.status === 'checking' || rtxReadiness.status === 'installing'}>{t('export.checkSetup')}</button>
                    {rtxReadiness.status === 'error' && rtxReadiness.installAvailable && <button type="button" className="export-action"
                      disabled={previewBusy} onClick={() => void handleInstallRtxRuntime()}>{t('export.installRtx')}</button>}
                  </>}
                  <p className={'export-help ' + (rtxReadiness.status === 'error' ? '!text-sf-warning' : '')}>{rtxToggleDisabledReason || rtxReadinessText}</p>
                  {rtxReadiness.status === 'installing' && <progress className="h-1 w-full accent-sf-accent" max="100" value={Math.max(0, Math.min(100, Number(rtxInstallProgress?.percent) || 0))} />}
                </div>}
              </div>
            </details>
          )}

          <details className="export-disclosure">
            <summary>{t('export.workspace.handoff', undefined, 'Send to another editor')}</summary>
            <div className="space-y-3">
              <ExportField id="export-xml-format" label={t('export.format')}>
                <select id="export-xml-format" aria-label="XML export format" value={xmlExportFormat} disabled={previewBusy}
                  onChange={event => setXmlExportFormat(event.target.value)}>
                  {XML_EXPORT_FORMATS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </ExportField>
              <button type="button" className="export-action" onClick={handleExportXml} disabled={previewBusy} title={xmlExportConfig.tooltip}>
                <Download className="h-3.5 w-3.5" />{isXmlExporting ? t('export.exporting') : xmlExportConfig.buttonLabel}
              </button>
            </div>
          </details>
          {performanceHints.length > 0 && <details className="export-disclosure">
            <summary>{t('export.performanceHints')}</summary>
            <ul className="list-disc space-y-1 pl-4">{performanceHints.map(hint => <li key={hint} className="export-help">{hint}</li>)}</ul>
          </details>}
          <ExportReadinessPanel active={active} rangeStart={range.start} rangeEnd={range.end}
            includeAudio={settings.includeAudio} format={settings.format} useProxyMedia={settings.useProxyMedia}
            disabled={previewBusy} onInspect={time => {
              const timeline = useTimelineStore.getState()
              if (timeline.isPlaying) timeline.togglePlay()
              timeline.setPlayheadPosition(Math.max(range.start, Math.min(time, range.end - 1 / timelineFps)))
            }} />
          <p className="export-help mt-4">{t('export.savedForProject')}</p>
        </section>

        <section className="export-workspace__review" aria-label={t('export.workspace.preview', undefined, 'Timeline preview')}>
          <div className="flex shrink-0 items-center justify-between px-3 py-2.5">
            <h2 className="text-xs font-medium text-sf-text-primary">{t('export.workspace.preview', undefined, 'Timeline preview')}</h2>
            <span className="text-[11px] text-sf-text-muted">{t('preview.fit')}</span>
          </div>
          <div className="export-workspace__viewer">
            <ExportReviewPreview active={active} disabled={previewBusy} rangeStart={range.start} rangeEnd={range.end} />
          </div>
          <div className="shrink-0 border-t border-sf-dark-700 px-3 py-3">
            <div className="export-workspace__scope">
              <div className="flex flex-wrap gap-0.5 rounded border border-sf-dark-700 bg-sf-dark-900 p-0.5" role="group" aria-label={t('export.range')}>
                {RANGE_PRESETS.map(item => <button type="button" key={item.id} data-testid={'export-range-' + item.id}
                  aria-pressed={effectiveRangeMode === item.id} disabled={item.id === 'inout' && !hasInOut}
                  onClick={() => handleSettingChange('range', item.id)}
                  className={'rounded px-2 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ' +
                    (effectiveRangeMode === item.id ? 'bg-sf-accent/20 text-sf-accent' : 'text-sf-text-muted hover:text-sf-text-primary')}>
                  {t(item.translationKey)}
                </button>)}
              </div>
              <span className="text-[11px] text-sf-text-muted">{t('export.workspace.duration', undefined, 'Duration')} <span className="font-mono tabular-nums">{formatExportOverviewTimecode(rangeEndFrame - rangeStartFrame, timelineFps)}</span></span>
            </div>
            {!hasInOut && <p className="export-help mt-2">{t(collapsedMarkedRange
              ? 'export.workspace.collapsedMarks'
              : settings.range === 'inout' ? 'export.workspace.missingMarksFallback' : 'export.workspace.missingMarks', undefined,
              collapsedMarkedRange ? 'In and Out are at the same position. Set distinct marks in the editor or choose Full Timeline.'
                : settings.range === 'inout' ? 'In/Out marks are missing; the full timeline will be exported.'
                  : 'Set both In/Out marks in the editor to use that range.')}</p>}
          </div>
          {active && <ExportTimelineOverview startFrame={rangeStartFrame} endFrame={rangeEndFrame} rangeMode={effectiveRangeMode} disabled={previewBusy || !hasContent} />}
          <p className="export-help shrink-0 border-t border-sf-dark-700 px-3 py-2">{t('export.workspace.previewHelp', undefined, 'Review at timeline settings. Export resolution, encoding and audio settings are applied when rendering.')}</p>
        </section>

        {queueOpen && <aside id="export-render-queue" data-testid="export-queue" className="export-workspace__queue" aria-label={t('export.queue')}>
          <div className="flex shrink-0 items-center justify-between gap-2">
            <h2 className="text-xs font-medium text-sf-text-primary">{t('export.queue')} <span className="ml-1 font-normal text-sf-text-muted">{queue.length}</span></h2>
            <button type="button" className="export-action export-action--quiet export-action--icon"
              aria-label={t('export.workspace.hideQueue', undefined, 'Hide queue')} onClick={() => setQueueOpen(false)}><PanelRightClose className="h-4 w-4" /></button>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
            {queue.length === 0 && <div className="flex flex-col items-center gap-2 px-2 py-10 text-center text-xs text-sf-text-muted">
              <ListVideo className="h-6 w-6 opacity-50" /><span>{t('export.noQueued')}</span>
            </div>}
            {queue.map(item => <article key={item.id} data-testid="export-queue-item" className="export-workspace__queue-item">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className={'text-[11px] ' + (item.status === 'failed' ? 'text-sf-error' : item.status === 'completed' ? 'text-sf-success' : item.status === 'rendering' ? 'text-sf-accent' : 'text-sf-text-muted')}>
                  {t('export.workspace.status.' + item.status, undefined, EXPORT_QUEUE_STATUS_LABELS[item.status] || 'Queued')}
                </span>
                <button type="button" className="export-action export-action--quiet export-action--icon" disabled={item.status === 'rendering'}
                  aria-label={t('export.removeFromQueue') + ': ' + item.name} onClick={() => handleRemoveFromQueue(item.id)}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
              <h3 className="export-workspace__queue-name text-xs font-medium text-sf-text-primary">{delivery(item.settings).name}</h3>
              <p className="export-help mt-1">{delivery(item.settings).summary}</p>
              <p className="export-help">{t(item.settings.range === 'inout' ? 'export.rangeInOut' : 'export.rangeFull')}</p>
              {item.error && <p className="export-help mt-2 !text-sf-error">{item.error}</p>}
            </article>)}
          </div>
          <div className="shrink-0 space-y-2 border-t border-sf-dark-700 pt-3">
            <p className="export-help">{t('export.workspace.queueHelp', undefined, 'Jobs use the current timeline and In/Out marks when started. Save locations are chosen at export.')}</p>
            {queueRunning ? <button type="button" data-testid="export-queue-pause" className="export-action w-full"
              onClick={handlePauseQueue} disabled={queuePauseRequested}><Pause className="h-3.5 w-3.5" />
              {queuePauseRequested ? t('export.pausingAfterCurrent') : t('export.workspace.pauseAfterCurrent', undefined, 'Pause after current')}</button>
              : queuePaused ? <button type="button" data-testid="export-queue-resume" className="export-action w-full"
                onClick={handleResumeQueue} disabled={isExporting || isXmlExporting || pendingCount === 0}><Play className="h-3.5 w-3.5" />{t('export.resume')}</button>
              : <button type="button" data-testid="export-queue-start" className="export-action w-full"
                onClick={handleStartQueue} disabled={isExporting || isXmlExporting || pendingCount === 0}><Play className="h-3.5 w-3.5" />{t('export.startQueue')}</button>}
            {queue.length > 0 && <button type="button" className="export-action export-action--quiet w-full" disabled={queueRunning}
              onClick={handleClearQueue}><Trash2 className="h-3.5 w-3.5" />{t('export.workspace.clearQueue', undefined, 'Clear queue')}</button>}
          </div>
        </aside>}
      </ExportWorkspaceLayout>

      <footer className="shrink-0 border-t border-sf-dark-700 bg-sf-dark-900">
        {(isExporting || isXmlExporting || exportProgress > 0 || exportError || externalExportNotice || exportResult?.outputPath) && (
          <div className="export-workspace__status border-b border-sf-dark-700 px-4 py-2">
            {(isExporting || exportProgress > 0) && <div>
              <div className="mb-1 flex flex-wrap justify-between gap-2 text-[11px] text-sf-text-muted">
                <span>{exportStatus || t('export.exporting')}</span>
                <span>{Math.round(exportProgress)}% · {t('export.eta')} {formatDuration(etaSeconds)}{renderFps ? ' · ' + renderFps.toFixed(1) + ' fps' : ''}</span>
              </div>
              <div role="progressbar" aria-label={t('export.exporting')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(exportProgress)}
                className="h-1 overflow-hidden rounded bg-sf-dark-800"><div className="h-full bg-sf-accent" style={{ width: Math.max(0, Math.min(100, exportProgress)) + '%' }} /></div>
            </div>}
            {isXmlExporting && <p className="export-help">{exportStatus}</p>}
            {exportError && <p className="export-help !text-sf-error" role="alert">{exportError}</p>}
            {externalExportNotice && <p className={'export-help ' + (externalExportNotice.type === 'error' ? '!text-sf-error' : externalExportNotice.type === 'success' ? '!text-sf-success' : '')} role="status">{externalExportNotice.message}</p>}
            {exportResult?.outputPath && !exportError && <div className="export-help" role="status">
              {exportResult.format === 'png-seq' || exportResult.encoderUsed === 'png-sequence' ? t('export.savedPngSequenceTo') : t('export.savedTo')}: {exportResult.outputPath}
              {(exportResult.format === 'png-seq' || exportResult.encoderUsed === 'png-sequence') && Number.isFinite(exportResult.frameCount)
                && <span> · {t('export.pngFrameCount', { count: exportResult.frameCount })}</span>}
              {exportResult.cleanupWarning && <p className="text-sf-warning">{exportResult.cleanupWarning}</p>}
              {exportResult.encoderUsed && <p>{t('export.encoder')}: {exportResult.encoderUsed}</p>}
            </div>}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-sf-text-primary" title={currentDelivery.name}>{currentDelivery.name}</p>
            <p className="export-help">{currentDelivery.summary} · {t(effectiveRangeMode === 'inout' ? 'export.rangeInOut' : 'export.rangeFull')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="export-action" data-testid="export-add-queue" onClick={handleAddToQueue} disabled={!hasContent}>
              <Plus className="h-3.5 w-3.5" />{t('export.addToQueue')}
            </button>
            <button type="button" className="export-action export-action--primary" data-testid="export-start"
              onClick={handleStartExport} disabled={previewBusy || !hasContent}>
              <Download className="h-3.5 w-3.5" />{isExporting ? t('export.exporting') : queueRunning ? t('export.queueRunning') : t('export.workspace.exportNow', undefined, 'Export now')}
            </button>
            {isExporting && <button type="button" data-testid="export-stop" onClick={() => { void handleStopExport().catch(error => setExportError(error.message)) }} className="export-action !border-sf-error/50 !text-sf-error">
              <Square className="h-3.5 w-3.5" />{t('export.stop')}
            </button>}
          </div>
        </div>
      </footer>
    </div>
  )
}

export default ExportPanel
