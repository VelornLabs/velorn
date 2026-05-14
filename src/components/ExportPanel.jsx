import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Plus, Trash2, Play, Settings, Film, Clock, RotateCcw, Sparkles, Square } from 'lucide-react'
import useProjectStore, { RESOLUTION_PRESETS, FPS_PRESETS } from '../stores/projectStore'
import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import exportTimeline from '../services/exporter'
import { runRtxVideoUpscale } from '../services/rtxVideoUpscale'
import { resolveRtx4kDimensions } from '../config/rtxVideoUpscaleConfig'

const EXPORT_SETTINGS_STORAGE_PREFIX = 'comfystudio-export-settings-v1'

const EXPORT_FORMATS = [
  { id: 'mp4', label: 'MP4 (H.264/H.265)' },
  { id: 'webm', label: 'WebM (VP9)' },
  { id: 'prores', label: 'MOV (ProRes)' },
  { id: 'gif', label: 'GIF (Preview - Soon)', disabled: true },
  { id: 'png-seq', label: 'PNG Sequence - Soon', disabled: true },
]

const RANGE_PRESETS = [
  { id: 'full', label: 'Full Timeline' },
  { id: 'inout', label: 'In/Out Range' },
  { id: 'selection', label: 'Selection' },
]

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
  { id: 'timeline-half', label: 'Half Timeline Resolution', scale: 0.5 },
  { id: 'timeline-third', label: 'Third Timeline Resolution', scale: 1 / 3 },
  { id: 'timeline-quarter', label: 'Quarter Timeline Resolution', scale: 0.25 },
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
  useProxyMedia: false,
  useDirectFramePipe: true,
  postProcessUpscale: 'none',
})

const EXPORT_PRESETS = [
  {
    id: 'balanced-mp4',
    label: 'Balanced MP4',
    summary: 'Clean everyday export, project size, H.264.',
    settings: {
      format: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      useHardwareEncoder: false,
      preset: 'medium',
      qualityMode: 'crf',
      crf: 18,
      resolution: 'project',
      fps: 'project',
      includeAudio: true,
      audioBitrateKbps: 192,
      useProxyMedia: false,
      useDirectFramePipe: true,
    },
  },
  {
    id: 'fast-nvenc',
    label: 'Fast NVENC',
    summary: 'Fast H.264 delivery for NVIDIA systems.',
    settings: {
      format: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      useHardwareEncoder: true,
      nvencPreset: 'p5',
      preset: 'fast',
      qualityMode: 'crf',
      crf: 19,
      resolution: 'project',
      fps: 'project',
      includeAudio: true,
      audioBitrateKbps: 192,
      useProxyMedia: false,
      useDirectFramePipe: true,
    },
  },
  {
    id: 'proxy-review',
    label: 'Proxy Review',
    summary: 'Quick review file using proxies and half-res.',
    settings: {
      format: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      useHardwareEncoder: true,
      nvencPreset: 'p3',
      preset: 'veryfast',
      qualityMode: 'crf',
      crf: 23,
      resolution: 'timeline-half',
      fps: 'project',
      includeAudio: true,
      audioBitrateKbps: 160,
      useProxyMedia: true,
      useDirectFramePipe: true,
    },
  },
  {
    id: 'small-h265',
    label: 'Small H.265',
    summary: 'Smaller MP4 for sharing, slower decode.',
    settings: {
      format: 'mp4',
      videoCodec: 'h265',
      audioCodec: 'aac',
      useHardwareEncoder: true,
      nvencPreset: 'p5',
      preset: 'medium',
      qualityMode: 'crf',
      crf: 22,
      resolution: 'project',
      fps: 'project',
      includeAudio: true,
      audioBitrateKbps: 192,
      useProxyMedia: false,
      useDirectFramePipe: true,
    },
  },
  {
    id: 'rtx-4k-master',
    label: 'RTX 4K Master',
    summary: 'Render timeline, then upscale locally to 4K with RTX VSR.',
    settings: {
      format: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      useHardwareEncoder: true,
      nvencPreset: 'p5',
      preset: 'medium',
      qualityMode: 'crf',
      crf: 18,
      resolution: 'project',
      fps: 'project',
      includeAudio: true,
      audioBitrateKbps: 192,
      useProxyMedia: false,
      useDirectFramePipe: true,
      postProcessUpscale: 'rtx-4k',
    },
  },
  {
    id: 'prores-hq',
    label: 'ProRes HQ',
    summary: 'Large editor-friendly MOV master.',
    settings: {
      format: 'prores',
      videoCodec: 'prores',
      audioCodec: 'aac',
      proresProfile: '3',
      useHardwareEncoder: false,
      resolution: 'project',
      fps: 'project',
      includeAudio: true,
      audioBitrateKbps: 320,
      useProxyMedia: false,
      useDirectFramePipe: true,
    },
  },
]

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
    return {
      ...defaultSettings,
      ...saved,
      filename: typeof saved.filename === 'string' && saved.filename.trim()
        ? saved.filename
        : defaultSettings.filename,
      format: EXPORT_FORMATS.some((format) => format.id === saved.format && !format.disabled)
        ? saved.format
        : defaultSettings.format,
      renderMode: 'single',
      useCachedRenders: false,
      fastSeek: false,
      useDirectFramePipe: true,
    }
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

function ExportPanel({ isActive = true }) {
  const { currentProject, currentProjectHandle, getCurrentTimelineSettings } = useProjectStore()
  const { duration, inPoint, outPoint, getTimelineEndTime, selectedClipIds, clips, transitions, tracks } = useTimelineStore()
  const { assets } = useAssetsStore()
  
  const projectName = currentProject?.name || 'Untitled'
  const defaultFilename = `${projectName}_export`
  const defaultSettings = useMemo(() => createDefaultExportSettings(defaultFilename), [defaultFilename])
  const settingsStorageKey = useMemo(
    () => getExportSettingsStorageKey(currentProjectHandle, projectName),
    [currentProjectHandle, projectName]
  )
  
  const [settings, setSettings] = useState(() => loadSavedExportSettings(settingsStorageKey, defaultSettings))
  const [queue, setQueue] = useState([])
  const [isExporting, setIsExporting] = useState(false)
  const [exportStatus, setExportStatus] = useState('')
  const [exportProgress, setExportProgress] = useState(0)
  const [exportError, setExportError] = useState(null)
  const [exportResult, setExportResult] = useState(null)
  const [etaSeconds, setEtaSeconds] = useState(null)
  const [renderFps, setRenderFps] = useState(null)
  const exportStartRef = useRef(null)
  const renderStartRef = useRef(null)
  const activeExportRequestIdRef = useRef(null)
  const activeExportAbortRef = useRef(null)
  const exportCancelledRef = useRef(false)
  const [nvencStatus, setNvencStatus] = useState({
    checked: false,
    available: false,
    h264: false,
    h265: false,
    gpuName: null,
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
    
    const checkNvenc = async () => {
      if (!window.electronAPI?.checkNvenc) {
        setNvencStatus({ checked: true, available: false, h264: false, h265: false, gpuName: null, error: 'NVENC check unavailable' })
        return
      }
      try {
        const result = await window.electronAPI.checkNvenc()
        if (cancelled) return
        setNvencStatus({
          checked: true,
          available: !!result.available,
          h264: !!result.h264,
          h265: !!result.h265,
          gpuName: result.gpuName || null,
          error: result.error || null,
        })
      } catch (err) {
        if (cancelled) return
        setNvencStatus({
          checked: true,
          available: false,
          h264: false,
          h265: false,
          gpuName: null,
          error: err.message,
        })
      }
    }
    
    checkNvenc()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.onExportProgress) return undefined
    const isCurrentExportEvent = (data) => Boolean(data?.requestId && data.requestId === activeExportRequestIdRef.current)
    const onProgress = (data) => {
      if (!isCurrentExportEvent(data)) return
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
    const onComplete = (data) => {
      if (!isCurrentExportEvent(data)) return
      console.log('[ExportPanel] Worker export complete', data)
      activeExportRequestIdRef.current = null
      setExportResult(data)
      setExportStatus('Export complete')
      setExportProgress(100)
      setIsExporting(false)
    }
    const onError = (err) => {
      if (!isCurrentExportEvent(err)) return
      activeExportRequestIdRef.current = null
      activeExportAbortRef.current = null
      const rawError = err?.error ?? err
      const msg = typeof rawError === 'string' ? rawError : (rawError?.message ?? (rawError && typeof rawError === 'object' && rawError.constructor?.name === 'Event' ? `Export error (${rawError.type})` : String(rawError)))
      console.error('[ExportPanel] Worker export error', err, '-> displayed:', msg)
      setExportError(msg || 'Export failed')
      setExportStatus('Export failed')
      setIsExporting(false)
    }
    const offProgress = window.electronAPI.onExportProgress(onProgress)
    const offComplete = window.electronAPI.onExportComplete(onComplete)
    const offError = window.electronAPI.onExportError(onError)
    return () => {
      offProgress?.()
      offComplete?.()
      offError?.()
    }
  }, [])

  const timelineRangeLabel = useMemo(() => {
    if (settings.range === 'inout' && inPoint !== null && outPoint !== null) {
      return `${Math.max(0, inPoint).toFixed(2)}s → ${Math.max(inPoint, outPoint).toFixed(2)}s`
    }
    if (settings.range === 'selection') {
      return 'Current selection'
    }
    return `0s → ${duration.toFixed(2)}s`
  }, [settings.range, inPoint, outPoint, duration])
  
  const handleSettingChange = (key, value) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value }
      
      if (key === 'format') {
        const supportedVideo = VIDEO_CODECS[value] || []
        const supportedAudio = AUDIO_CODECS[value] || []
        next.videoCodec = supportedVideo[0]?.id || prev.videoCodec
        next.audioCodec = supportedAudio[0]?.id || prev.audioCodec
        if (next.videoCodec && DEFAULT_CRF[next.videoCodec]) {
          next.crf = DEFAULT_CRF[next.videoCodec]
        }
        if (value === 'webm' || value === 'prores') {
          next.useHardwareEncoder = false
        }
      }
      
      if (key === 'videoCodec') {
        if (DEFAULT_CRF[value]) {
          next.crf = DEFAULT_CRF[value]
        }
        if (value === 'vp9') {
          next.format = 'webm'
          next.useHardwareEncoder = false
        } else {
          next.format = 'mp4'
        }
        const supportedAudio = AUDIO_CODECS[next.format] || []
        if (!supportedAudio.find(codec => codec.id === next.audioCodec)) {
          next.audioCodec = supportedAudio[0]?.id || next.audioCodec
        }
      }

      if (key === 'resolution' && value === 'custom') {
        const timelineSettings = getCurrentTimelineSettings() || { width: 1920, height: 1080 }
        next.customWidth = Number(prev.customWidth) || timelineSettings.width || 1920
        next.customHeight = Number(prev.customHeight) || timelineSettings.height || 1080
      }

      if (key === 'customWidth' || key === 'customHeight') {
        const numeric = Math.max(2, Math.round(Number(value) || 2))
        next[key] = numeric
      }

      return next
    })
  }

  const handleApplyExportPreset = (exportPreset) => {
    if (!exportPreset) return
    setSettings((prev) => {
      const next = {
        ...prev,
        ...exportPreset.settings,
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
      if (!supportedVideo.find(codec => codec.id === next.videoCodec)) {
        next.videoCodec = supportedVideo[0]?.id || prev.videoCodec
      }
      const supportedAudio = AUDIO_CODECS[next.format] || []
      if (!supportedAudio.find(codec => codec.id === next.audioCodec)) {
        next.audioCodec = supportedAudio[0]?.id || prev.audioCodec
      }
      return next
    })
  }

  const handleResetSettings = () => {
    setSettings(createDefaultExportSettings(defaultFilename))
  }

  const activeExportPresetId = useMemo(() => {
    const isEqual = (a, b) => String(a) === String(b)
    const matchingPresets = EXPORT_PRESETS.filter((exportPreset) => (
      Object.entries(exportPreset.settings).every(([key, value]) => isEqual(settings[key], value))
    ))
    return matchingPresets
      .sort((a, b) => Object.keys(b.settings).length - Object.keys(a.settings).length)[0]?.id || null
  }, [settings])

  const selectedNvencCodecSupported = settings.videoCodec === 'h265'
    ? nvencStatus.h265
    : settings.videoCodec === 'h264'
      ? nvencStatus.h264
      : false
  const nvencToggleDisabledReason = useMemo(() => {
    if (settings.format === 'webm' || settings.videoCodec === 'vp9') {
      return 'NVENC is only used for MP4 H.264/H.265 exports.'
    }
    if (settings.format === 'prores') {
      return 'NVENC is not used for ProRes exports.'
    }
    if (nvencStatus.checked && !nvencStatus.available) {
      return 'NVENC not available in your FFmpeg build.'
    }
    if (settings.videoCodec === 'h265' && nvencStatus.checked && !nvencStatus.h265) {
      return 'HEVC NVENC is not available in your FFmpeg build.'
    }
    if (settings.videoCodec === 'h264' && nvencStatus.checked && !nvencStatus.h264) {
      return 'H.264 NVENC is not available in your FFmpeg build.'
    }
    return null
  }, [settings.format, settings.videoCodec, nvencStatus])
  const nvencSummaryText = useMemo(() => {
    if (!nvencStatus.checked) {
      return 'Checking FFmpeg for NVIDIA NVENC support...'
    }

    const gpuPrefix = nvencStatus.gpuName
      ? `Detected GPU: ${nvencStatus.gpuName}. `
      : ''

    if (!nvencStatus.available) {
      return gpuPrefix + (nvencStatus.error || 'NVENC not detected in FFmpeg. GPU encoding will be unavailable.')
    }

    if (settings.format === 'webm' || settings.videoCodec === 'vp9') {
      return `${gpuPrefix}NVENC is ready for MP4 H.264/H.265 exports. Switch from WebM/VP9 to use it.`
    }

    if (settings.format === 'prores') {
      return `${gpuPrefix}NVENC is ready for MP4 H.264/H.265 exports. ProRes always uses software encoding.`
    }

    if (selectedNvencCodecSupported) {
      return `${gpuPrefix}NVENC is ready for faster ${settings.videoCodec === 'h265' ? 'H.265' : 'H.264'} exports.`
    }

    return `${gpuPrefix}NVENC is detected, but the current codec is not available in this FFmpeg build.`
  }, [nvencStatus, selectedNvencCodecSupported, settings.format, settings.videoCodec])
  const nvencExpectedEncoder = settings.useHardwareEncoder && selectedNvencCodecSupported
    ? (settings.videoCodec === 'h265' ? 'hevc_nvenc' : 'h264_nvenc')
    : null
  
  const handleAddToQueue = () => {
    const queuedItem = {
      id: `export-${Date.now()}`,
      name: settings.filename.trim() || defaultFilename,
      createdAt: new Date().toISOString(),
      status: 'queued',
      settings: { ...settings },
    }
    setQueue((prev) => [queuedItem, ...prev])
  }
  
  const handleRemoveFromQueue = (id) => {
    setQueue((prev) => prev.filter((item) => item.id !== id))
  }
  
  const handleClearQueue = () => {
    setQueue([])
  }

  const updateQueueItem = (id, updates) => {
    setQueue((prev) => prev.map(item => item.id === id ? { ...item, ...updates } : item))
  }

  const runQueue = async () => {
    if (!isActive) return
    if (queueControllerRef.current.running) return
    queueControllerRef.current.running = true
    queueControllerRef.current.paused = false
    setQueueRunning(true)
    setQueuePaused(false)
    setQueuePauseRequested(false)
    
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
          updateQueueItem(nextItem.id, { status: 'failed', error: err.message || 'Export failed' })
        }
      }
    } finally {
      queueControllerRef.current.running = false
      setQueueRunning(false)
      setQueuePaused(queueControllerRef.current.paused)
      setQueuePauseRequested(false)
    }
  }

  const handleStartQueue = () => {
    if (!isActive || queueRunning || queueRef.current.length === 0) return
    runQueue()
  }

  const handlePauseQueue = () => {
    if (!queueRunning) return
    queueControllerRef.current.paused = true
    setQueuePauseRequested(true)
  }

  const handleResumeQueue = () => {
    if (!isActive || queueRunning) return
    queueControllerRef.current.paused = false
    setQueuePaused(false)
    setQueuePauseRequested(false)
    runQueue()
  }

  const resolveResolution = () => {
    const timelineSettings = getCurrentTimelineSettings() || { width: 1920, height: 1080, fps: 24 }
    const makeEvenDimension = (value) => Math.max(2, Math.round((Number(value) || 2) / 2) * 2)
    if (settings.resolution === 'project') {
      return timelineSettings
    }
    if (settings.resolution === 'custom') {
      return {
        width: makeEvenDimension(settings.customWidth || timelineSettings.width),
        height: makeEvenDimension(settings.customHeight || timelineSettings.height),
        fps: timelineSettings.fps || 24,
      }
    }
    const scaleOption = EXPORT_RESOLUTION_SCALE_OPTIONS.find(option => option.id === settings.resolution)
    if (scaleOption) {
      return {
        width: makeEvenDimension((timelineSettings.width || 1920) * scaleOption.scale),
        height: makeEvenDimension((timelineSettings.height || 1080) * scaleOption.scale),
        fps: timelineSettings.fps || 24,
      }
    }
    const preset = RESOLUTION_PRESETS.find(p => p.name === settings.resolution)
    if (preset) {
      return { width: preset.width, height: preset.height, fps: timelineSettings.fps || 24 }
    }
    return timelineSettings
  }

  const getResolutionLabel = (exportSettings = settings) => {
    const timelineSettings = getCurrentTimelineSettings() || { width: 1920, height: 1080, fps: 24 }
    const makeEvenDimension = (value) => Math.max(2, Math.round((Number(value) || 2) / 2) * 2)
    if (exportSettings.resolution === 'project') {
      return `Project (${timelineSettings.width}×${timelineSettings.height})`
    }
    if (exportSettings.resolution === 'custom') {
      return `Custom (${makeEvenDimension(exportSettings.customWidth)}×${makeEvenDimension(exportSettings.customHeight)})`
    }
    const scaleOption = EXPORT_RESOLUTION_SCALE_OPTIONS.find(option => option.id === exportSettings.resolution)
    if (scaleOption) {
      return `${scaleOption.label} (${makeEvenDimension((timelineSettings.width || 1920) * scaleOption.scale)}×${makeEvenDimension((timelineSettings.height || 1080) * scaleOption.scale)})`
    }
    return exportSettings.resolution
  }

  const resolveFps = () => {
    if (settings.fps === 'project') {
      return getCurrentTimelineSettings()?.fps || 24
    }
    return Number(settings.fps) || 24
  }

  const resolveRange = () => {
    if (settings.range === 'inout' && inPoint !== null && outPoint !== null) {
      return { start: Math.min(inPoint, outPoint), end: Math.max(inPoint, outPoint) }
    }
    if (settings.range === 'selection' && selectedClipIds.length > 0) {
      const selected = clips.filter(c => selectedClipIds.includes(c.id))
      const start = Math.min(...selected.map(c => c.startTime))
      const end = Math.max(...selected.map(c => c.startTime + c.duration))
      return { start, end }
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
      if (asset.proxyStatus === 'ready' && asset.proxyPath) ready += 1
    }
    return { ready, total, missing: Math.max(0, total - ready) }
  }, [assets, clips])

  const performanceHints = useMemo(() => {
    const hints = []
    const timelineSettings = getCurrentTimelineSettings() || { width: 1920, height: 1080, fps: 24 }
    const resolution = resolveResolution()
    const effectiveFps = settings.fps === 'project' ? timelineSettings.fps : Number(settings.fps || timelineSettings.fps)
    const pixelCount = (resolution.width || 1920) * (resolution.height || 1080)
    
    if (pixelCount >= 3840 * 2160) {
      hints.push('4K exports are heavy. Consider proxies or lower resolution for previews.')
    }
    if (settings.useProxyMedia && proxyCoverage.ready > 0) {
      hints.push(`Proxy export will use ${proxyCoverage.ready}/${proxyCoverage.total} ready video prox${proxyCoverage.ready === 1 ? 'y' : 'ies'}.`)
    } else if (settings.useProxyMedia && proxyCoverage.total > 0) {
      hints.push('Proxy export is enabled, but no ready proxies were found; originals will be used.')
    }
    if (effectiveFps >= 60) {
      hints.push('60fps export doubles frame workload. Lower FPS for faster renders.')
    }
    if (!settings.useHardwareEncoder && settings.format === 'mp4' && settings.videoCodec !== 'vp9') {
      hints.push('Enable NVIDIA NVENC to speed up H.264/H.265 exports on supported NVIDIA GPUs.')
    }
    if (nvencStatus.checked && !nvencStatus.available) {
      hints.push('NVENC not detected in your FFmpeg build. GPU encoding will be unavailable.')
    }
    if (settings.format === 'webm' || settings.videoCodec === 'vp9') {
      hints.push('VP9/WebM encodes slower than H.264/H.265.')
    }
    hints.push('Fast FFmpeg pipe skips writing PNG frames before encoding.')
    
    const textClips = clips.filter(clip => clip.type === 'text')
    if (textClips.length > 0) {
      hints.push('Text overlays add compositing work; expect longer renders.')
    }
    if (transitions.length > 0) {
      hints.push('Transitions require dual-frame compositing and add export time.')
    }
    
    const audioClips = clips.filter(clip => clip.type === 'audio')
    const activeAudioTracks = tracks.filter(track => track.type === 'audio' && track.visible && !track.muted)
    if (settings.includeAudio && audioClips.length > 0 && activeAudioTracks.length > 0) {
      hints.push('Audio mixdown runs offline; long timelines increase export time.')
    }
    
    return hints.slice(0, 5)
  }, [clips, transitions, tracks, settings, getCurrentTimelineSettings, nvencStatus, proxyCoverage])

  const runExportJob = async (jobSettings, labelOverride = null) => {
    if (jobSettings.format === 'gif' || jobSettings.format === 'png-seq') {
      throw new Error('GIF and PNG sequence export are not wired yet.')
    }
    if (jobSettings.useHardwareEncoder && nvencStatus.checked) {
      const codecSupported = jobSettings.videoCodec === 'h265'
        ? nvencStatus.h265
        : nvencStatus.h264
      if (!codecSupported) {
        throw new Error('NVENC is not supported by your FFmpeg build.')
      }
    }

    const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null
    activeExportAbortRef.current = abortController
    exportCancelledRef.current = false
    exportStartRef.current = null
    renderStartRef.current = null
    setEtaSeconds(null)
    setRenderFps(null)
    setExportError(null)
    setExportResult(null)
    setExportProgress(0)
    setExportStatus('Choose export destination...')
    setIsExporting(true)

    const { width, height } = resolveResolution()
    const fps = resolveFps()
    const range = resolveRange()
    const timelineSettings = getCurrentTimelineSettings() || { width: 1920, height: 1080, fps: 24 }
    const options = {
      filename: jobSettings.filename?.trim() || defaultFilename,
      format: jobSettings.format,
      videoCodec: jobSettings.videoCodec,
      audioCodec: jobSettings.audioCodec,
      proresProfile: jobSettings.proresProfile,
      useHardwareEncoder: jobSettings.useHardwareEncoder,
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
      includeAudio: jobSettings.includeAudio,
      audioBitrateKbps: Number(jobSettings.audioBitrateKbps),
      audioSampleRate: Number(jobSettings.audioSampleRate),
      audioChannels: Number(jobSettings.audioChannels),
      useCachedRenders: false,
      useProxyMedia: jobSettings.useProxyMedia,
      fastSeek: false,
      useDirectFramePipe: true,
      postProcessUpscale: jobSettings.postProcessUpscale || 'none',
    }

    const shouldRunRtxUpscale = jobSettings.postProcessUpscale === 'rtx-4k'

    if (!shouldRunRtxUpscale && window.electronAPI?.runExportInWorker && typeof currentProjectHandle === 'string') {
      try {
        const outputExtension = jobSettings.format === 'webm' ? 'webm' : (jobSettings.format === 'prores' ? 'mov' : 'mp4')
        const outputFolder = await window.electronAPI.pathJoin(currentProjectHandle, 'renders')
        await window.electronAPI.createDirectory(outputFolder)
        const defaultPath = await window.electronAPI.pathJoin(outputFolder, `${options.filename}.${outputExtension}`)
        const outputPath = await window.electronAPI.saveFileDialog({
          title: 'Export Timeline',
          defaultPath,
          filters: [{ name: outputExtension.toUpperCase(), extensions: [outputExtension] }],
        })
        if (!outputPath) {
          setExportStatus('')
          setIsExporting(false)
          return null
        }
        exportStartRef.current = Date.now()
        setExportStatus('Starting export worker...')
        const visibleVideoTrackIds = new Set((tracks || [])
          .filter((track) => track?.type === 'video' && track.visible !== false && !track.muted)
          .map((track) => track.id))
        const visibleAudioTrackIds = new Set((tracks || [])
          .filter((track) => track?.type === 'audio' && track.visible !== false && !track.muted)
          .map((track) => track.id))
        const exportAssetIds = new Set()
        const exportClips = (clips || []).filter((clip) => {
          if (!clip || clip.enabled === false) return false
          if (clip.type === 'audio') return visibleAudioTrackIds.has(clip.trackId)
          return visibleVideoTrackIds.has(clip.trackId)
        })
        for (const clip of exportClips) {
          if (clip?.assetId) exportAssetIds.add(clip.assetId)
          for (const effect of clip?.effects || []) {
            if (effect?.type === 'mask' && effect?.enabled !== false && effect?.maskAssetId) exportAssetIds.add(effect.maskAssetId)
          }
        }
        const referencedAssets = assets.filter((asset) => asset?.id && exportAssetIds.has(asset.id))
        console.log('[ExportPanel] Worker payload assets', referencedAssets.length, '/', assets.length, 'clips', exportClips.length, '/', clips.length)
        const state = {
          timeline: { clips, tracks, transitions },
          assets: referencedAssets.map((a) => ({
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
        const requestId = `export-${Date.now()}-${Math.random().toString(36).slice(2)}`
        activeExportRequestIdRef.current = requestId
        const workerStart = await window.electronAPI.runExportInWorker({
          requestId,
          projectPath: currentProjectHandle,
          outputPath,
          options: { ...options, outputPath },
          state,
        })
        if (workerStart?.success === false) {
          throw new Error(workerStart.error || 'Could not start export worker.')
        }
        return
      } catch (err) {
        activeExportRequestIdRef.current = null
        setExportError(err?.message || 'Export failed')
        setExportStatus('Export failed')
        setIsExporting(false)
        throw err
      }
    }

    if (shouldRunRtxUpscale) {
      if (!window.electronAPI?.saveFileDialog || !window.electronAPI?.pathJoin || !window.electronAPI?.writeFileFromArrayBuffer) {
        throw new Error('RTX 4K export requires the desktop app file APIs.')
      }
      const outputExtension = 'mp4'
      const outputFolder = await window.electronAPI.pathJoin(currentProjectHandle, 'renders')
      await window.electronAPI.createDirectory(outputFolder)
      const defaultPath = await window.electronAPI.pathJoin(outputFolder, `${options.filename}_rtx4k.${outputExtension}`)
      const outputPath = await window.electronAPI.saveFileDialog({
        title: 'Export Timeline with RTX 4K Upscale',
        defaultPath,
        filters: [{ name: outputExtension.toUpperCase(), extensions: [outputExtension] }],
      })
      if (!outputPath) {
        setExportStatus('')
        setIsExporting(false)
        return null
      }
      exportStartRef.current = Date.now()
      const tempBase = `${options.filename}_rtx_source_${Date.now()}.${outputExtension}`
      const tempOutputPath = await window.electronAPI.pathJoin(outputFolder, tempBase)
      setExportStatus('Rendering source export for RTX upscale...')
      const sourceResult = await exportTimeline({
        ...options,
        format: 'mp4',
        videoCodec: 'h264',
        audioCodec: 'aac',
        outputPath: tempOutputPath,
        signal: abortController?.signal || null,
      }, (progress) => {
        setExportStatus(`Source render • ${progress.status || ''}`.trim())
        if (typeof progress.progress === 'number') {
          setExportProgress(Math.max(0, Math.min(55, progress.progress * 0.55)))
        }
      })
      const target = resolveRtx4kDimensions(width, height)
      setExportStatus(`RTX upscaling to ${target.width}x${target.height}...`)
      const rtxResult = await runRtxVideoUpscale({
        inputPath: sourceResult?.outputPath || tempOutputPath,
        outputPath,
        sourceWidth: width,
        sourceHeight: height,
        quality: 'HIGH',
        onStatus: (status) => {
          setExportStatus(status?.statusMessage || 'Running RTX 4K upscale...')
          if (typeof status?.progress === 'number') {
            setExportProgress(55 + Math.max(0, Math.min(40, status.progress * 0.4)))
          }
        },
      })
      if (window.electronAPI?.deleteFile) {
        window.electronAPI.deleteFile(tempOutputPath).catch(() => {})
      }
      const finalResult = {
        ...sourceResult,
        ...rtxResult,
        outputPath,
        encoderUsed: `${sourceResult?.encoderUsed || 'timeline export'} + RTX Video Super Resolution`,
      }
      setExportResult(finalResult)
      setExportStatus('Export complete')
      setExportProgress(100)
      setIsExporting(false)
      return finalResult
    }

    const result = await exportTimeline(options, (progress) => {
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
    
    activeExportAbortRef.current = null
    if (!result) return null
    setExportResult(result)
    setExportStatus('Export complete')
    setExportProgress(100)
    setIsExporting(false)
    
    return result
  }

  const handleStartExport = async () => {
    if (!isActive || isExporting || queueRunning) return
    try {
      await runExportJob(settings)
    } catch (err) {
      if (exportCancelledRef.current || err?.message === 'Export cancelled') {
        setExportError(null)
        setExportStatus('Export cancelled')
      } else {
        setExportError(err.message || 'Export failed')
        setExportStatus('Export failed')
      }
      activeExportAbortRef.current = null
      setIsExporting(false)
    }
  }


  const handleStopExport = async () => {
    if (!isExporting && !queueRunning) return
    exportCancelledRef.current = true
    queueControllerRef.current.paused = true
    setQueuePauseRequested(false)
    setQueuePaused(true)
    setExportStatus('Cancelling export...')
    try {
      activeExportAbortRef.current?.abort?.()
    } catch {
      // ignore abort errors
    }
    try {
      await window.electronAPI?.cancelExportWorker?.()
    } catch {
      // ignore worker cancel errors
    }
    activeExportRequestIdRef.current = null
    activeExportAbortRef.current = null
    setQueueRunning(false)
    setIsExporting(false)
    setExportError(null)
    setExportStatus('Export cancelled')
  }
  
  return (
    <div className="flex-1 min-h-0 flex flex-col min-w-0 overflow-hidden bg-sf-dark-950">
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-sf-dark-700">
        <div className="flex items-center gap-2">
          <Download className="w-4 h-4 text-sf-accent" />
          <span className="text-sm font-semibold text-sf-text-primary">Export</span>
          <span className="text-[10px] text-sf-text-muted">Queue + settings ready</span>
        </div>
        <div className="text-[10px] text-sf-text-muted">
          {isExporting ? exportStatus : 'Ready to export'}
        </div>
      </div>
      
      {/* Content */}
      <div className="flex-1 min-h-0 grid grid-cols-12 gap-4 overflow-hidden p-4">
        {/* Settings */}
        <div className="col-span-7 flex min-h-0 flex-col overflow-hidden bg-sf-dark-900 border border-sf-dark-700 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-3 shrink-0">
            <Settings className="w-4 h-4 text-sf-text-muted" />
            <span className="text-xs font-semibold text-sf-text-primary uppercase tracking-wider">Export Settings</span>
            <span className="ml-auto text-[10px] text-sf-text-muted">Saved for this project</span>
          </div>

          <div className="mb-3 shrink-0 rounded-lg border border-sf-dark-700 bg-sf-dark-950/45 p-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-sf-text-muted">Export presets</div>
                <div className="text-[10px] text-sf-text-secondary">
                  Presets change render settings only. Filename and range stay as-is.
                </div>
              </div>
              <button
                type="button"
                onClick={handleResetSettings}
                className="flex items-center gap-1 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1 text-[10px] text-sf-text-muted transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
                title="Reset export settings to the default ComfyStudio export setup"
              >
                <RotateCcw className="h-3 w-3" />
                Reset defaults
              </button>
            </div>
            <div className="grid grid-cols-5 gap-2">
              {EXPORT_PRESETS.map((exportPreset) => {
                const isActive = activeExportPresetId === exportPreset.id
                return (
                  <button
                    key={exportPreset.id}
                    type="button"
                    onClick={() => handleApplyExportPreset(exportPreset)}
                    className={`rounded border p-2 text-left transition-colors ${
                      isActive
                        ? 'border-sf-accent bg-sf-accent/15 text-sf-text-primary'
                        : 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-secondary hover:border-sf-dark-500 hover:bg-sf-dark-800'
                    }`}
                    title={exportPreset.summary}
                  >
                    <div className="text-[11px] font-semibold">{exportPreset.label}</div>
                    <div className="mt-1 text-[9px] leading-snug text-sf-text-muted">
                      {exportPreset.summary}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
          
          <div className="grid grid-cols-2 gap-3 shrink-0">
            <div>
              <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Filename</label>
              <input
                type="text"
                value={settings.filename}
                onChange={(e) => handleSettingChange('filename', e.target.value)}
                className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                placeholder={defaultFilename}
              />
            </div>
            
            <div>
              <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Format</label>
              <select
                value={settings.format}
                onChange={(e) => handleSettingChange('format', e.target.value)}
                className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
              >
                {EXPORT_FORMATS.map((format) => (
                  <option key={format.id} value={format.id} disabled={format.disabled}>{format.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Range</label>
              <select
                value={settings.range}
                onChange={(e) => handleSettingChange('range', e.target.value)}
                className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
              >
                {RANGE_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.label}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end">
              <p className="text-[10px] text-sf-text-muted flex items-center gap-1">
                <Clock className="w-3 h-3" /> {timelineRangeLabel}
              </p>
            </div>
          </div>
          <p className="mt-1 text-[10px] text-sf-text-muted shrink-0">Output location will be chosen when export starts.</p>
          
          <div className="mt-2 flex items-center gap-2 text-[10px] text-sf-text-muted shrink-0">
            <span className="uppercase tracking-wider">Render</span>
            <button
              onClick={() => handleSettingChange('renderMode', 'single')}
              className={`px-2 py-0.5 rounded border transition-colors ${
                settings.renderMode === 'single'
                  ? 'bg-sf-accent/20 text-sf-accent border-sf-accent/40'
                  : 'bg-sf-dark-800 text-sf-text-muted border-sf-dark-600'
              }`}
            >
              Single clip
            </button>
            <button
              disabled
              className="px-2 py-0.5 rounded border border-sf-dark-700 text-sf-text-muted/60 cursor-not-allowed"
              title="Individual clips export is coming soon"
            >
              Individual clips
            </button>
          </div>
          
          <div className="mt-3 border-t border-sf-dark-700 pt-2 flex-1 min-h-0 overflow-y-auto pr-1 space-y-4">
            {/* Video */}
            <div>
              <div className="text-[10px] text-sf-text-muted uppercase tracking-wider mb-2">Video</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleSettingChange('useHardwareEncoder', !settings.useHardwareEncoder)}
                      disabled={Boolean(nvencToggleDisabledReason)}
                      className={`px-2 py-1 text-xs rounded border transition-colors ${
                        settings.useHardwareEncoder
                          ? 'bg-sf-accent text-white border-sf-accent'
                          : 'bg-sf-dark-800 text-sf-text-muted border-sf-dark-600'
                      } ${nvencToggleDisabledReason ? 'opacity-50 cursor-not-allowed' : ''}`}
                      title={nvencToggleDisabledReason || 'Use NVIDIA NVENC for faster MP4 exports'}
                    >
                      Use NVIDIA NVENC
                    </button>
                    <span className="text-[10px] text-sf-text-muted">
                      Hardware encoding
                    </span>
                  </div>
                  <div className={`mt-1 text-[10px] ${
                    nvencStatus.checked && nvencStatus.available ? 'text-sf-text-secondary' : 'text-sf-warning'
                  }`}>
                    {nvencSummaryText}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className={`px-1.5 py-0.5 rounded border text-[10px] ${
                      nvencStatus.h264
                        ? 'border-sf-accent/40 bg-sf-accent/10 text-sf-accent'
                        : 'border-sf-dark-600 bg-sf-dark-800 text-sf-text-muted'
                    }`}>
                      H.264 NVENC
                    </span>
                    <span className={`px-1.5 py-0.5 rounded border text-[10px] ${
                      nvencStatus.h265
                        ? 'border-sf-accent/40 bg-sf-accent/10 text-sf-accent'
                        : 'border-sf-dark-600 bg-sf-dark-800 text-sf-text-muted'
                    }`}>
                      H.265 NVENC
                    </span>
                    {nvencStatus.gpuName && (
                      <span className="px-1.5 py-0.5 rounded border border-sf-dark-600 bg-sf-dark-800 text-[10px] text-sf-text-secondary">
                        {nvencStatus.gpuName}
                      </span>
                    )}
                  </div>
                  {nvencExpectedEncoder && (
                    <div className="mt-1 text-[10px] text-sf-accent font-mono">
                      Expected encoder: {nvencExpectedEncoder}
                    </div>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      className="px-2 py-1 text-xs rounded border bg-sf-accent text-white border-sf-accent cursor-default opacity-90"
                      title="Stream rendered frames directly into FFmpeg instead of writing PNG frames first"
                      disabled
                    >
                      Fast FFmpeg pipe
                    </button>
                    <span className="text-[10px] text-sf-text-muted">
                      Skips PNG frame files during export
                    </span>
                  </div>
                </div>
                
                <div>
                  <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Video Codec</label>
                  <select
                    value={settings.videoCodec}
                    onChange={(e) => handleSettingChange('videoCodec', e.target.value)}
                    className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                  >
                    {(VIDEO_CODECS[settings.format] || []).map((codec) => (
                      <option key={codec.id} value={codec.id}>{codec.label}</option>
                    ))}
                  </select>
                </div>
                
                {settings.format === 'prores' && (
                  <div>
                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">ProRes Profile</label>
                    <select
                      value={settings.proresProfile}
                      onChange={(e) => handleSettingChange('proresProfile', e.target.value)}
                      className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                    >
                      {PRORES_PROFILES.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                )}
                
                {settings.format !== 'prores' && (
                <div>
                  <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Encoder Preset</label>
                  <select
                    value={settings.preset}
                    onChange={(e) => handleSettingChange('preset', e.target.value)}
                    className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                  >
                    {ENCODER_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.label}</option>
                    ))}
                  </select>
                </div>
                )}

                {settings.format !== 'prores' && settings.useHardwareEncoder && (
                  <div>
                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">NVENC Preset</label>
                    <select
                      value={settings.nvencPreset}
                      onChange={(e) => handleSettingChange('nvencPreset', e.target.value)}
                      className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                    >
                      {NVENC_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>{preset.label}</option>
                      ))}
                    </select>
                  </div>
                )}
                
                {settings.format !== 'prores' && (
                <div>
                  <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Quality Mode</label>
                  <select
                    value={settings.qualityMode}
                    onChange={(e) => handleSettingChange('qualityMode', e.target.value)}
                    className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                  >
                    {QUALITY_MODES.map((mode) => (
                      <option key={mode.id} value={mode.id}>{mode.label}</option>
                    ))}
                  </select>
                </div>
                )}
                
                {settings.format !== 'prores' && (
                <div>
                  <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">
                    {settings.qualityMode === 'crf' ? 'CRF' : 'Bitrate (kbps)'}
                  </label>
                  <input
                    type="number"
                    min={settings.qualityMode === 'crf' ? 0 : 100}
                    max={settings.qualityMode === 'crf' ? 63 : 200000}
                    value={settings.qualityMode === 'crf' ? settings.crf : settings.bitrateKbps}
                    onChange={(e) => handleSettingChange(
                      settings.qualityMode === 'crf' ? 'crf' : 'bitrateKbps',
                      Number(e.target.value)
                    )}
                    className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                  />
                </div>
                )}
                
                {settings.format !== 'prores' && (
                <>
                  <div>
                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Keyframes</label>
                    <select
                      value={settings.keyframeMode}
                      onChange={(e) => handleSettingChange('keyframeMode', e.target.value)}
                      className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                    >
                      {KEYFRAME_MODES.map((mode) => (
                        <option key={mode.id} value={mode.id}>{mode.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Keyframe Interval</label>
                    <input
                      type="number"
                      min={1}
                      value={settings.keyframeInterval}
                      onChange={(e) => handleSettingChange('keyframeInterval', Number(e.target.value))}
                      disabled={settings.keyframeMode === 'auto'}
                      className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary disabled:text-sf-text-muted disabled:opacity-60 focus:outline-none focus:border-sf-accent"
                    />
                  </div>
                </>
                )}
                
                <div>
                  <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Resolution</label>
                  <select
                    value={settings.resolution}
                    onChange={(e) => handleSettingChange('resolution', e.target.value)}
                    className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                  >
                    <option value="project">Project Settings</option>
                    {EXPORT_RESOLUTION_SCALE_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                    <option value="custom">Custom...</option>
                    {RESOLUTION_PRESETS.map((preset) => (
                      <option key={preset.name} value={preset.name}>{preset.name}</option>
                    ))}
                  </select>
                  <div className="mt-1 text-[10px] text-sf-text-muted">
                    Output: {getResolutionLabel()}
                  </div>
                </div>

                {settings.resolution === 'custom' && (
                  <div>
                    <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Custom Size</label>
                    <div className="mt-1 grid grid-cols-[1fr_auto_1fr] items-center gap-1">
                      <input
                        type="number"
                        min={2}
                        step={2}
                        value={settings.customWidth}
                        onChange={(e) => handleSettingChange('customWidth', Number(e.target.value))}
                        className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                        aria-label="Custom export width"
                      />
                      <span className="text-[10px] text-sf-text-muted">×</span>
                      <input
                        type="number"
                        min={2}
                        step={2}
                        value={settings.customHeight}
                        onChange={(e) => handleSettingChange('customHeight', Number(e.target.value))}
                        className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                        aria-label="Custom export height"
                      />
                    </div>
                    <div className="mt-1 text-[10px] text-sf-text-muted">
                      Values are rounded to even pixels for video encoders.
                    </div>
                  </div>
                )}
                
                <div>
                  <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Frame Rate</label>
                  <select
                    value={settings.fps}
                    onChange={(e) => handleSettingChange('fps', e.target.value)}
                    className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                  >
                    <option value="project">Project Settings</option>
                    {FPS_PRESETS.map((preset) => (
                      <option key={preset.value} value={preset.value}>{preset.label}</option>
                    ))}
                  </select>
                </div>
                
                <div className="col-span-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleSettingChange('useProxyMedia', !settings.useProxyMedia)}
                      disabled={proxyCoverage.total === 0}
                      title={proxyCoverage.total === 0
                        ? 'No video clips on this timeline'
                        : `Use ready low-res proxies for faster draft exports. ${proxyCoverage.ready}/${proxyCoverage.total} video asset${proxyCoverage.total === 1 ? '' : 's'} have proxies.`}
                      className={`px-2 py-1 text-xs rounded border transition-colors ${
                        settings.useProxyMedia
                          ? 'bg-sf-accent/20 text-sf-accent border-sf-accent/40'
                          : 'bg-sf-dark-800 text-sf-text-muted border-sf-dark-600'
                      } ${proxyCoverage.total === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      Use video proxies
                    </button>
                  </div>
                  <div className="mt-1 text-[10px] text-sf-text-muted">
                    Video proxies use low-res proxy files when available for faster draft exports.
                    {settings.useProxyMedia && proxyCoverage.total > 0 && (
                      <span className="ml-1 text-sf-accent">
                        {proxyCoverage.ready}/{proxyCoverage.total} ready.
                      </span>
                    )}
                  </div>
                </div>

                <div className="col-span-2">
                  <button
                    onClick={() => handleSettingChange('postProcessUpscale', settings.postProcessUpscale === 'rtx-4k' ? 'none' : 'rtx-4k')}
                    title="Render the timeline first, then upscale the exported video to 4K with local NVIDIA RTX Video Super Resolution"
                    className={`inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded border transition-colors ${
                      settings.postProcessUpscale === 'rtx-4k'
                        ? 'bg-sf-accent/20 text-sf-accent border-sf-accent/40'
                        : 'bg-sf-dark-800 text-sf-text-muted border-sf-dark-600'
                    }`}
                  >
                    <Sparkles className="w-3 h-3" />
                    RTX 4K upscale
                  </button>
                  <div className="mt-1 text-[10px] text-sf-text-muted">
                    {settings.postProcessUpscale === 'rtx-4k'
                      ? `Final output: ${resolveRtx4kDimensions(resolveResolution().width, resolveResolution().height).width}x${resolveRtx4kDimensions(resolveResolution().width, resolveResolution().height).height} via local RTX Video Super Resolution.`
                      : 'Optional post-export upscale through local NVIDIA RTX Video Super Resolution.'}
                  </div>
                </div>
              </div>
            </div>
            
            {/* Audio */}
            <div>
              <div className="text-[10px] text-sf-text-muted uppercase tracking-wider mb-2">Audio</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <button
                    onClick={() => handleSettingChange('includeAudio', !settings.includeAudio)}
                    className={`px-2 py-1 text-xs rounded border transition-colors ${
                      settings.includeAudio
                        ? 'bg-sf-accent text-white border-sf-accent'
                        : 'bg-sf-dark-800 text-sf-text-muted border-sf-dark-600'
                    }`}
                  >
                    Include Audio
                  </button>
                </div>
                
                {settings.includeAudio ? (
                  <>
                    <div>
                      <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Audio Codec</label>
                      <select
                        value={settings.audioCodec}
                        onChange={(e) => handleSettingChange('audioCodec', e.target.value)}
                        className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                      >
                        {(AUDIO_CODECS[settings.format] || []).map((codec) => (
                          <option key={codec.id} value={codec.id}>{codec.label}</option>
                        ))}
                      </select>
                    </div>
                    
                    <div>
                      <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Audio Bitrate (kbps)</label>
                      <input
                        type="number"
                        min={32}
                        max={512}
                        value={settings.audioBitrateKbps}
                        onChange={(e) => handleSettingChange('audioBitrateKbps', Number(e.target.value))}
                        className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                      />
                    </div>
                    
                    <div>
                      <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Sample Rate</label>
                      <select
                        value={settings.audioSampleRate}
                        onChange={(e) => handleSettingChange('audioSampleRate', Number(e.target.value))}
                        className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                      >
                        {AUDIO_SAMPLE_RATES.map((rate) => (
                          <option key={rate.id} value={rate.id}>{rate.label}</option>
                        ))}
                      </select>
                    </div>
                    
                    <div>
                      <label className="text-[10px] text-sf-text-muted uppercase tracking-wider">Channels</label>
                      <select
                        value={settings.audioChannels}
                        onChange={(e) => handleSettingChange('audioChannels', Number(e.target.value))}
                        className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                      >
                        {AUDIO_CHANNELS.map((channel) => (
                          <option key={channel.id} value={channel.id}>{channel.label}</option>
                        ))}
                      </select>
                    </div>
                  </>
                ) : (
                  <div className="col-span-2 text-[10px] text-sf-text-muted">
                    Audio is disabled for this export.
                  </div>
                )}
              </div>
            </div>
            
          </div>
          
          <div className="mt-3 flex items-center justify-end gap-2 shrink-0">
            <button
              onClick={handleAddToQueue}
              className="px-3 py-1.5 text-xs rounded bg-sf-dark-700 text-sf-text-primary hover:bg-sf-dark-600 transition-colors flex items-center gap-1.5"
            >
              <Plus className="w-3 h-3" />
              Add to Queue
            </button>
            {isExporting || queueRunning ? (
              <button
                onClick={handleStopExport}
                className="px-3 py-1.5 text-xs rounded border border-red-500/50 bg-red-500/15 text-red-200 hover:bg-red-500/25 transition-colors flex items-center gap-1.5"
                title="Cancel the current export"
              >
                <Square className="w-3 h-3" />
                Stop Export
              </button>
            ) : (
              <button
                onClick={handleStartExport}
                className="px-3 py-1.5 text-xs rounded border flex items-center gap-1.5 transition-colors bg-sf-accent text-white border-sf-accent hover:bg-sf-accent-hover"
              >
                <Play className="w-3 h-3" />
                Start Export
              </button>
            )}
          </div>

          {(isExporting || exportProgress > 0) && (
            <div className="mt-3 shrink-0">
              <div className="flex items-center justify-between text-[10px] text-sf-text-muted mb-1">
                <span>{exportStatus || 'Exporting...'}</span>
                <span>{exportStatus === 'Choose export destination...' ? 'Waiting for file path' : `${Math.round(exportProgress)}% • ETA ${formatDuration(etaSeconds)}`}</span>
              </div>
              <div className="h-1.5 bg-sf-dark-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-sf-accent transition-all"
                  style={{ width: `${exportProgress}%` }}
                />
              </div>
              {renderFps && (
                <div className="mt-1 text-[10px] text-sf-text-muted">
                  Render speed: {renderFps.toFixed(1)} fps
                </div>
              )}
            </div>
          )}
          
          {exportError && (
            <div className="mt-2 shrink-0 text-[11px] text-sf-error">
              {exportError}
            </div>
          )}
          
          {exportResult?.outputPath && !exportError && (
            <div className="mt-2 shrink-0 text-[11px] text-sf-text-secondary">
              Saved to: {exportResult.outputPath}
              {exportResult.encoderUsed && (
                <div>Encoder: {exportResult.encoderUsed}</div>
              )}
            </div>
          )}
          
          {performanceHints.length > 0 && (
            <div className="mt-3 border-t border-sf-dark-700 pt-2 shrink-0 max-h-24 overflow-y-auto">
              <div className="text-[10px] text-sf-text-muted uppercase tracking-wider mb-1">Performance hints</div>
              <div className="space-y-0.5">
                {performanceHints.map((hint) => (
                  <div key={hint} className="text-[10px] text-sf-text-muted">
                    • {hint}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        
        {/* Queue */}
        <div className="col-span-5 bg-sf-dark-900 border border-sf-dark-700 rounded-lg p-4 flex min-h-0 flex-col overflow-hidden">
          <div className="flex items-center gap-2 mb-4">
            <Film className="w-4 h-4 text-sf-text-muted" />
            <span className="text-xs font-semibold text-sf-text-primary uppercase tracking-wider">Export Queue</span>
            <span className="ml-auto text-[10px] text-sf-text-muted">
              {queueRunning
                ? (queuePauseRequested ? 'Pausing after current…' : 'Running')
                : (queuePaused ? 'Paused' : 'Idle')}
              {' '}• {queue.length} item{queue.length !== 1 ? 's' : ''}
            </span>
          </div>
          
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={handleStartQueue}
              disabled={queueRunning || queue.length === 0}
              className={`px-2 py-1 text-[11px] rounded border transition-colors ${
                queueRunning || queue.length === 0
                  ? 'bg-sf-dark-800 text-sf-text-muted border-sf-dark-600 cursor-not-allowed'
                  : 'bg-sf-dark-700 text-sf-text-primary border-sf-dark-500 hover:bg-sf-dark-600'
              }`}
            >
              Start Queue
            </button>
            <button
              onClick={handlePauseQueue}
              disabled={!queueRunning || queuePauseRequested}
              className={`px-2 py-1 text-[11px] rounded border transition-colors ${
                !queueRunning || queuePauseRequested
                  ? 'bg-sf-dark-800 text-sf-text-muted border-sf-dark-600 cursor-not-allowed'
                  : 'bg-sf-dark-700 text-sf-text-primary border-sf-dark-500 hover:bg-sf-dark-600'
              }`}
            >
              Pause
            </button>
            <button
              onClick={handleResumeQueue}
              disabled={!queuePaused}
              className={`px-2 py-1 text-[11px] rounded border transition-colors ${
                queuePaused
                  ? 'bg-sf-dark-700 text-sf-text-primary border-sf-dark-500 hover:bg-sf-dark-600'
                  : 'bg-sf-dark-800 text-sf-text-muted border-sf-dark-600 cursor-not-allowed'
              }`}
            >
              Resume
            </button>
          </div>
          
          <div className="flex-1 overflow-auto space-y-2">
            {queue.length === 0 && (
              <div className="text-center text-[11px] text-sf-text-muted py-8">
                No exports queued yet
              </div>
            )}
            {queue.map((item) => (
              <div key={item.id} className="border border-sf-dark-700 rounded p-2 bg-sf-dark-800/60">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs text-sf-text-primary truncate">{item.name}</div>
                    <div className="text-[10px] text-sf-text-muted">
                      {item.settings.format.toUpperCase()} • {item.settings.videoCodec?.toUpperCase()} • {getResolutionLabel(item.settings)} • {item.settings.fps} fps
                    </div>
                    <div className="text-[10px] text-sf-text-muted">
                      Range: {item.settings.range}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemoveFromQueue(item.id)}
                    className="p-1 hover:bg-sf-dark-700 rounded"
                    title="Remove from queue"
                  >
                    <Trash2 className="w-3 h-3 text-sf-text-muted" />
                  </button>
                </div>
                <div className="mt-2 text-[10px] text-sf-text-muted">
                  Status: {item.status}
                  {item.error ? ` • ${item.error}` : ''}
                </div>
              </div>
            ))}
          </div>
          
          {queue.length > 0 && (
            <button
              onClick={handleClearQueue}
              disabled={queueRunning}
              className={`mt-3 px-3 py-1.5 text-xs rounded border transition-colors flex items-center justify-center gap-1.5 ${
                queueRunning
                  ? 'bg-sf-dark-800 text-sf-text-muted border-sf-dark-600 cursor-not-allowed'
                  : 'bg-sf-dark-800 text-sf-text-muted border-sf-dark-600 hover:text-sf-text-primary hover:border-sf-dark-500'
              }`}
            >
              <Trash2 className="w-3 h-3" />
              Clear Queue
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default ExportPanel
