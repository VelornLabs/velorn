import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Loader2, Pause, Play, RefreshCw, RotateCcw, Sparkles, Wand2, X } from 'lucide-react'
import {
  CAPTION_PRESETS,
  DEFAULT_CAPTION_PRESET_ID,
  getCaptionPresetById,
} from '../config/captionPresets'
import { DEFAULT_KINETIC_ACCENT_COLOR, buildKineticStyleWithColors } from '../utils/kineticCaptionRenderer'
import { isElectron, writeGeneratedOverlayToProject } from '../services/fileSystem'
import {
  buildCaptionAssetName,
  ensureCaptionsFolder,
  loadCaptionSidecar,
  saveCaptionSidecar,
} from '../services/captionProject'
import { transcribeWithComfyUI, transcribeTimeline } from '../services/captionComfyTranscription'
import {
  generateCaptionVideoBlob,
  renderCaptionFrame,
  renderCaptionPresetPreviewDataUrl,
} from '../utils/captionRenderer'

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

// Draw a source canvas/image onto ctx using object-cover math (fill the box,
// crop the overflow), centered. Used to put a real video frame behind the
// caption overlay in the positioning preview.
function drawCover(ctx, src, dw, dh) {
  const sw = src.width || src.videoWidth || 0
  const sh = src.height || src.videoHeight || 0
  if (!sw || !sh) return
  const scale = Math.max(dw / sw, dh / sh)
  const w = sw * scale
  const h = sh * scale
  ctx.drawImage(src, (dw - w) / 2, (dh - h) / 2, w, h)
}

function formatSeconds(value) {
  const numeric = Math.max(0, Number(value) || 0)
  const minutes = Math.floor(numeric / 60)
  const seconds = numeric % 60
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}`
}

function getCueEnd(cue, fallbackDuration) {
  const start = Number(cue?.start) || 0
  const rawEnd = Number(cue?.end)
  const fallback = Math.max(start + 0.4, Number(fallbackDuration) || start + 1.5)
  return Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : fallback
}

function getDraftDuration(draft, asset) {
  const cueEnd = Math.max(...((draft?.cues || []).map((cue) => Number(cue?.end) || 0)), 0)
  const assetDuration = Number(asset?.duration) || Number(asset?.settings?.duration) || 0
  return Math.max(0.4, cueEnd || assetDuration || 0.4)
}

function normalizeCueOrder(cues = [], fallbackDuration = 0) {
  return [...cues]
    .map((cue, index) => {
      const start = Math.max(0, Number(cue?.start) || 0)
      const end = getCueEnd(cue, fallbackDuration)
      return {
        ...cue,
        id: cue?.id || `cue-${index + 1}`,
        start,
        end,
        text: String(cue?.text || ''),
        override: normalizeCueOverride(cue?.override),
      }
    })
    .sort((a, b) => a.start - b.start)
}

function cuesToTranscript(cues = []) {
  return cues
    .map((cue) => String(cue?.text || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const CUE_VERTICAL_OPTIONS = [
  { id: 'auto', label: 'Auto' },
  { id: 'top', label: 'Top' },
  { id: 'middle', label: 'Middle' },
  { id: 'bottom', label: 'Bottom' },
]

const CUE_HORIZONTAL_OPTIONS = [
  { id: 'auto', label: 'Auto' },
  { id: 'left', label: 'Left' },
  { id: 'center', label: 'Center' },
  { id: 'right', label: 'Right' },
]

const CUE_MOTION_OPTIONS = [
  { id: 'auto', label: 'Auto' },
  { id: 'tamed', label: 'Tamed' },
  { id: 'excited', label: 'Excited' },
  { id: 'frenetic', label: 'Frenetic' },
]

const VALID_VERTICAL_PLACEMENTS = new Set(CUE_VERTICAL_OPTIONS.map((option) => option.id))
const VALID_HORIZONTAL_PLACEMENTS = new Set(CUE_HORIZONTAL_OPTIONS.map((option) => option.id))
const VALID_MOTION_PROFILES = new Set(CUE_MOTION_OPTIONS.map((option) => option.id))

function normalizeCueOverride(override = {}) {
  const safeOverride = override && typeof override === 'object' ? override : {}
  return {
    verticalPlacement: VALID_VERTICAL_PLACEMENTS.has(safeOverride.verticalPlacement)
      ? safeOverride.verticalPlacement
      : 'auto',
    horizontalPlacement: VALID_HORIZONTAL_PLACEMENTS.has(safeOverride.horizontalPlacement)
      ? safeOverride.horizontalPlacement
      : 'auto',
    motionProfile: VALID_MOTION_PROFILES.has(safeOverride.motionProfile)
      ? safeOverride.motionProfile
      : 'auto',
  }
}

function CueOverrideChips({ label, value, options, onChange }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-[0.12em] text-sf-text-muted">
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            className={`rounded-full border px-2.5 py-1 text-[10px] transition-colors ${
              value === option.id
                ? 'border-sf-accent bg-sf-accent/20 text-sf-text-primary'
                : 'border-sf-dark-600 bg-sf-dark-900 text-sf-text-muted hover:border-sf-dark-500 hover:text-sf-text-primary'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// A free color picker row used for every preset's Text / Accent colors.
function ColorField({ icon: Icon, label, hint, value, onChange, onReset, resetDisabled }) {
  const display = String(value || '#FFFFFF').toUpperCase()
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0">
        {Icon ? <Icon className="w-4 h-4 text-sf-text-muted flex-shrink-0" /> : null}
        <div className="min-w-0">
          <div className="text-xs font-medium text-sf-text-primary">{label}</div>
          {hint ? <div className="text-[11px] text-sf-text-muted truncate">{hint}</div> : null}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <label
          className="relative inline-flex w-9 h-9 rounded-lg overflow-hidden border border-sf-dark-600 cursor-pointer"
          style={{ backgroundColor: display }}
          title="Pick any color"
        >
          <input
            type="color"
            value={display}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            aria-label={label}
          />
        </label>
        <code className="text-[11px] text-sf-text-muted font-mono uppercase w-[58px]">{display}</code>
        {onReset ? (
          <button
            type="button"
            onClick={onReset}
            disabled={resetDisabled}
            className="rounded-md border border-sf-dark-600 bg-sf-dark-900 p-1.5 text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Reset to preset default"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  )
}

function createEmptyDraft(asset) {
  return {
    modelId: null,
    transcriptText: '',
    words: [],
    cues: [],
    audioDuration: Number(asset?.duration) || Number(asset?.settings?.duration) || null,
  }
}

// Session cache for timeline-scope caption work. The timeline has no source
// asset to attach a sidecar to, so without this every reopen would force a
// re-transcribe. Keyed by project handle; lives for the app session only.
const timelineCaptionSessionCache = new Map()

// An approximate TikTok UI overlaid on the positioning preview so the user can
// keep captions clear of the platform chrome (right action rail + bottom
// caption/handle/music). viewBox is the real frame size and the SVG is
// stretched onto the preview image, so coordinates are fractions of the frame.
function TikTokGuideOverlay({ w, h }) {
  const railX = w * 0.9
  const r = w * 0.04
  const glyphFs = w * 0.034
  const labelFs = w * 0.024
  const stroke = Math.max(1, w * 0.005)

  const actions = [
    { cy: h * 0.5, glyph: '♥', label: '24.1k' },
    { cy: h * 0.6, glyph: '▢', label: '318' },
    { cy: h * 0.69, glyph: '⤴', label: '1.2k' },
    { cy: h * 0.78, glyph: '↗', label: '882' },
  ]

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="absolute inset-0 w-full h-full pointer-events-none"
    >
      <defs>
        <linearGradient id="ttBottomFade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(0,0,0,0)" />
          <stop offset="1" stopColor="rgba(0,0,0,0.5)" />
        </linearGradient>
      </defs>

      {/* Bottom scrim where the caption/handle/music sits */}
      <rect x="0" y={h * 0.74} width={w} height={h * 0.26} fill="url(#ttBottomFade)" />

      {/* Right action rail */}
      <circle cx={railX} cy={h * 0.4} r={r} fill="rgba(0,0,0,0.25)" stroke="white" strokeWidth={stroke} opacity="0.9" />
      {actions.map((a, i) => (
        <g key={i} opacity="0.92">
          <circle cx={railX} cy={a.cy} r={r * 0.82} fill="rgba(0,0,0,0.28)" />
          <text x={railX} y={a.cy + glyphFs * 0.35} fontSize={glyphFs} fill="white" textAnchor="middle">{a.glyph}</text>
          <text x={railX} y={a.cy + r + labelFs} fontSize={labelFs} fill="white" textAnchor="middle">{a.label}</text>
        </g>
      ))}
      <circle cx={railX} cy={h * 0.88} r={r} fill="rgba(0,0,0,0.4)" stroke="white" strokeWidth={stroke * 0.8} opacity="0.85" />

      {/* Bottom-left handle / caption / sound */}
      <text x={w * 0.045} y={h * 0.85} fontSize={glyphFs} fill="white" fontWeight="700">@yourbrand</text>
      <text x={w * 0.045} y={h * 0.89} fontSize={labelFs * 1.1} fill="white" opacity="0.9">your caption goes here #fyp</text>
      <text x={w * 0.045} y={h * 0.93} fontSize={labelFs} fill="white" opacity="0.82">♪ original sound</text>

      {/* Recommended safe area (clear of the rail and bottom text) */}
      <rect
        x={w * 0.04}
        y={h * 0.1}
        width={w * 0.78}
        height={h * 0.62}
        fill="none"
        stroke="rgba(125,220,150,0.9)"
        strokeWidth={stroke}
        strokeDasharray={`${w * 0.02} ${w * 0.014}`}
      />
      <text x={w * 0.05} y={h * 0.1 + labelFs * 1.4} fontSize={labelFs} fill="rgba(125,220,150,0.95)">safe area</text>
    </svg>
  )
}

function CaptionWorkspace({
  isOpen,
  asset,
  // 'asset' (default) — transcribe a single source clip/asset.
  // 'timeline'       — transcribe the mixed program audio of the live timeline.
  scope = 'asset',
  // Timeline scope only: whether a caption track already exists on the timeline,
  // so generating can warn that it will be replaced.
  hasExistingTimelineCaptions = false,
  currentProjectHandle,
  timelineSize,
  folders,
  addFolder,
  addAsset,
  updateAsset,
  onPlaceOnTimeline,
  onClose,
}) {
  const isTimelineScope = scope === 'timeline'
  const [selectedPresetId, setSelectedPresetId] = useState(DEFAULT_CAPTION_PRESET_ID)
  const [accentColor, setAccentColor] = useState(DEFAULT_KINETIC_ACCENT_COLOR)
  const [textColor, setTextColor] = useState(null)
  const [draft, setDraft] = useState(() => createEmptyDraft(asset))
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [placeOnTimeline, setPlaceOnTimeline] = useState(true)
  const [statusMessage, setStatusMessage] = useState('')
  const [error, setError] = useState('')
  const [errorExpanded, setErrorExpanded] = useState(false)
  const [errorCopied, setErrorCopied] = useState(false)

  const [globalVertical, setGlobalVertical] = useState('auto')
  const [globalHorizontal, setGlobalHorizontal] = useState('auto')
  const [globalMotion, setGlobalMotion] = useState('auto')
  // Continuous size multiplier (1 = default), shared by both preset modes.
  const [globalSizeScale, setGlobalSizeScale] = useState(1)
  // Continuous up/down nudge as a fraction of frame height (−0.45 = higher, +0.45 = lower).
  const [globalVerticalOffset, setGlobalVerticalOffset] = useState(0)

  const [subtitlePosition, setSubtitlePosition] = useState('action-safe')
  // Shared legibility treatment for all presets (background / outline / shadow / plain).
  const [globalTextStyle, setGlobalTextStyle] = useState('background')

  // A still frame grabbed from the source video, drawn behind the positioning
  // preview so placement can be judged over real footage. bgVersion bumps when
  // a new frame is captured, to re-run the preview memo.
  const bgCanvasRef = useRef(null)
  const [bgVersion, setBgVersion] = useState(0)
  // Preview-only TikTok chrome overlay to gauge caption placement vs platform UI.
  const [showTikTokOverlay, setShowTikTokOverlay] = useState(false)

  // Live animated preview: drives the same renderer at ~60fps so the caption
  // motion/timing can be watched in-window without a full render + timeline trip.
  const previewCanvasRef = useRef(null)
  const overlayCanvasRef = useRef(null)
  const previewTimeRef = useRef(1.2)
  const rafRef = useRef(0)
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false)
  const [scrubDisplay, setScrubDisplay] = useState(1.2)

  const SUBTITLE_POSITION_OPTIONS = useMemo(() => [
    { id: 'action-safe', label: 'Action Safe' },
    { id: 'title-safe', label: 'Title Safe' },
    { id: 'center', label: 'Center' },
  ], [])

  const TEXT_STYLE_OPTIONS = useMemo(() => [
    { id: 'background', label: 'Background' },
    { id: 'outline', label: 'Outline' },
    { id: 'shadow', label: 'Shadow' },
    { id: 'plain', label: 'Plain' },
  ], [])

  const previewUrls = useMemo(() => (
    CAPTION_PRESETS.reduce((map, preset) => {
      map[preset.id] = renderCaptionPresetPreviewDataUrl(preset)
      return map
    }, {})
  ), [])

  const selectedPreset = useMemo(
    () => getCaptionPresetById(selectedPresetId),
    [selectedPresetId]
  )

  const renderPreset = useMemo(() => {
    if (selectedPreset?.renderer === 'kinetic' && !selectedPreset.traditional) {
      return buildKineticStyleWithColors(selectedPreset, accentColor, textColor)
    }
    return selectedPreset
  }, [selectedPreset, accentColor, textColor])

  // The resolved base text color: the user's free pick, or the preset's default.
  // Used for the picker UI and (for subtitles) fed through as the text color.
  const effectiveTextColor = useMemo(() => {
    const presetDefault = selectedPreset?.traditional
      ? (selectedPreset?.subtitleColor || selectedPreset?.textColor)
      : selectedPreset?.textColor
    return textColor || presetDefault || '#FFFFFF'
  }, [textColor, selectedPreset])

  // Shared style overrides fed to both the preset card thumbnail and the
  // larger positioning preview, so they always agree.
  const previewGlobalOverrides = useMemo(() => (
    renderPreset?.traditional
      ? { subtitleColor: effectiveTextColor, subtitlePosition, textStyle: globalTextStyle, sizeScale: globalSizeScale, verticalOffset: globalVerticalOffset }
      : {
          motionProfile: globalMotion !== 'auto' ? globalMotion : undefined,
          sizeScale: globalSizeScale,
          verticalPlacement: globalVertical !== 'auto' ? globalVertical : undefined,
          horizontalPlacement: globalHorizontal !== 'auto' ? globalHorizontal : undefined,
          verticalOffset: globalVerticalOffset,
          textStyle: globalTextStyle,
        }
  ), [renderPreset?.traditional, globalMotion, globalSizeScale, globalVertical, globalHorizontal, globalVerticalOffset, globalTextStyle, effectiveTextColor, subtitlePosition])

  // Live thumbnail for the selected preset card.
  const selectedPreviewUrl = useMemo(() => {
    if (!renderPreset) return null
    return renderCaptionPresetPreviewDataUrl(renderPreset, 240, 140, previewGlobalOverrides)
  }, [renderPreset, previewGlobalOverrides])

  const renderSettings = useMemo(() => ({
    width: Math.max(320, Math.round(Number(timelineSize?.width) || 1920)),
    height: Math.max(180, Math.round(Number(timelineSize?.height) || 1080)),
    fps: Math.max(12, Math.round(Number(timelineSize?.fps) || Number(asset?.fps) || 24)),
  }), [asset?.fps, timelineSize])

  // Preview canvas size at the project aspect ratio (longest edge ~480px).
  const previewDims = useMemo(() => {
    const projW = renderSettings.width
    const projH = renderSettings.height
    const longEdge = 480
    const scale = longEdge / Math.max(projW, projH)
    return {
      w: Math.max(120, Math.round(projW * scale)),
      h: Math.max(120, Math.round(projH * scale)),
    }
  }, [renderSettings])

  // Total timeline the preview plays over: the real cues' span, or the sample.
  const previewDuration = useMemo(() => {
    const maxEnd = (draft.cues || []).reduce((m, c) => Math.max(m, Number(c?.end) || 0), 0)
    return maxEnd > 0.4 ? maxEnd : 2.6
  }, [draft.cues])

  // Cues fed to the preview, each carrying the current global style overrides.
  const previewCues = useMemo(() => {
    const base = (draft.cues && draft.cues.length)
      ? draft.cues
      : [{ id: 'preview-sample', start: 0, end: 2.4, text: renderPreset?.sampleText || 'your caption here' }]
    return base.map((c) => ({ ...c, globalOverrides: previewGlobalOverrides }))
  }, [draft.cues, renderPreset, previewGlobalOverrides])

  // Draw one preview frame: footage (or gradient) behind, caption overlay on top.
  // freeze = settled still (no entrance fade) so paused/scrubbed frames never blank.
  const drawPreview = useCallback((timeSec, freeze) => {
    const canvas = previewCanvasRef.current
    if (!canvas || !renderPreset) return
    const { w, h } = previewDims
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    if (bgCanvasRef.current) {
      drawCover(ctx, bgCanvasRef.current, w, h)
    } else {
      const gradient = ctx.createLinearGradient(0, 0, 0, h)
      gradient.addColorStop(0, '#6b7280')
      gradient.addColorStop(1, '#374151')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, w, h)
    }

    let overlay = overlayCanvasRef.current
    if (!overlay) {
      overlay = document.createElement('canvas')
      overlayCanvasRef.current = overlay
    }
    if (overlay.width !== w) overlay.width = w
    if (overlay.height !== h) overlay.height = h
    const octx = overlay.getContext('2d')
    if (octx) {
      renderCaptionFrame({
        ctx: octx,
        width: w,
        height: h,
        preset: renderPreset,
        cues: previewCues,
        time: timeSec,
        freeze,
        transparent: true,
      })
      ctx.drawImage(overlay, 0, 0)
    }
  }, [previewDims, renderPreset, previewCues])

  // Redraw a settled still whenever paused (style/cue/footage changes, scrubbing).
  useEffect(() => {
    if (isPreviewPlaying) return
    drawPreview(previewTimeRef.current, true)
  }, [isPreviewPlaying, drawPreview, bgVersion])

  // Playback loop: advance time with the real clock and draw full-animation frames.
  useEffect(() => {
    if (!isPreviewPlaying || !isOpen) return
    if (previewTimeRef.current >= previewDuration - 0.01) previewTimeRef.current = 0
    let last = performance.now()
    let acc = 0
    const tick = (ts) => {
      const dt = (ts - last) / 1000
      last = ts
      let nt = previewTimeRef.current + dt
      if (nt >= previewDuration) nt = 0
      previewTimeRef.current = nt
      drawPreview(nt, false)
      acc += dt
      if (acc >= 0.1) { acc = 0; setScrubDisplay(nt) }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [isPreviewPlaying, isOpen, previewDuration, drawPreview])

  useEffect(() => {
    if (!isOpen || !asset) return

    let cancelled = false
    setError('')
    setStatusMessage('Transcribe audio locally to begin.')
    setPlaceOnTimeline(true)
    const nextPresetId = asset?.settings?.lastCaptionPresetId || DEFAULT_CAPTION_PRESET_ID
    setSelectedPresetId(nextPresetId)
    // Seed accent color from the saved preference, falling back to the
    // preset's registered default so the picker starts on-brand.
    const savedAccent = asset?.settings?.lastCaptionAccentColor
    const nextPreset = getCaptionPresetById(nextPresetId)
    const presetDefault = nextPreset?.keyWordColor || DEFAULT_KINETIC_ACCENT_COLOR
    setAccentColor(savedAccent || presetDefault)
    setTextColor(null)
    setGlobalTextStyle(nextPreset?.defaultTextStyle || (nextPreset?.traditional ? 'background' : 'plain'))
    setSubtitlePosition(nextPreset?.subtitlePosition || 'action-safe')
    setIsPreviewPlaying(false)
    previewTimeRef.current = 1.2
    setScrubDisplay(1.2)
    setDraft(createEmptyDraft(asset))

    // Timeline scope has no per-asset sidecar. Restore the session cache so the
    // transcription and style choices survive a reopen (re-transcribe is manual).
    if (isTimelineScope) {
      const cached = currentProjectHandle ? timelineCaptionSessionCache.get(currentProjectHandle) : null
      if (cached?.draft) {
        setDraft(cached.draft)
        if (cached.selectedPresetId) setSelectedPresetId(cached.selectedPresetId)
        if (cached.accentColor) setAccentColor(cached.accentColor)
        setTextColor(cached.textColor ?? null)
        if (cached.globalTextStyle) setGlobalTextStyle(cached.globalTextStyle)
        if (cached.subtitlePosition) setSubtitlePosition(cached.subtitlePosition)
        if (cached.globalVertical) setGlobalVertical(cached.globalVertical)
        if (cached.globalHorizontal) setGlobalHorizontal(cached.globalHorizontal)
        if (cached.globalMotion) setGlobalMotion(cached.globalMotion)
        if (typeof cached.globalSizeScale === 'number') setGlobalSizeScale(cached.globalSizeScale)
        if (typeof cached.globalVerticalOffset === 'number') setGlobalVerticalOffset(cached.globalVerticalOffset)
        setStatusMessage('Restored your last timeline captions — re-transcribe if the audio changed.')
      }
      return undefined
    }

    const transcriptPath = asset?.settings?.captionTranscriptPath
    if (!currentProjectHandle || !transcriptPath) return undefined

    ;(async () => {
      try {
        const existingDraft = await loadCaptionSidecar(currentProjectHandle, transcriptPath)
        if (!existingDraft || cancelled) return

        setDraft({
          modelId: existingDraft.modelId || null,
          transcriptText: String(existingDraft.transcriptText || ''),
          words: Array.isArray(existingDraft.words) ? existingDraft.words : [],
          cues: normalizeCueOrder(existingDraft.cues, existingDraft.audioDuration || asset?.duration),
          audioDuration: existingDraft.audioDuration || Number(asset?.duration) || null,
        })
        setSelectedPresetId(existingDraft.presetId || asset?.settings?.lastCaptionPresetId || DEFAULT_CAPTION_PRESET_ID)
        setStatusMessage('Loaded the last saved caption draft for this video.')
      } catch (loadError) {
        if (!cancelled) {
          console.warn('Could not load existing caption draft:', loadError)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [asset, currentProjectHandle, isOpen])

  // Grab a representative still for the positioning preview. Asset scope uses
  // the source clip (mid-point); timeline scope uses the frame under the
  // playhead (passed in via the pseudo-asset). Falls back to the gradient when
  // there's no video frame available.
  const captureUrl = isTimelineScope ? asset?.bgVideoUrl : asset?.url
  const captureTime = isTimelineScope ? Number(asset?.bgVideoTime) : NaN
  useEffect(() => {
    bgCanvasRef.current = null
    setBgVersion((v) => v + 1)
    if (!isOpen || !captureUrl) return undefined

    let cancelled = false
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'

    const capture = () => {
      if (cancelled) return
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (!vw || !vh) return
      try {
        const cap = 1280
        const s = Math.min(1, cap / Math.max(vw, vh))
        const frame = document.createElement('canvas')
        frame.width = Math.round(vw * s)
        frame.height = Math.round(vh * s)
        const fctx = frame.getContext('2d')
        if (!fctx) return
        fctx.drawImage(video, 0, 0, frame.width, frame.height)
        bgCanvasRef.current = frame
        setBgVersion((v) => v + 1)
      } catch (_) {
        bgCanvasRef.current = null
      }
    }

    const onLoaded = () => {
      const fallback = Math.min(1, (Number(video.duration) || 2) / 2)
      const target = Number.isFinite(captureTime) ? Math.max(0, captureTime) : fallback
      try {
        video.currentTime = target
      } catch (_) {
        capture()
      }
    }

    video.addEventListener('loadeddata', onLoaded, { once: true })
    video.addEventListener('seeked', capture, { once: true })
    video.src = captureUrl

    return () => {
      cancelled = true
      video.removeAttribute('src')
      try { video.load() } catch (_) { /* noop */ }
    }
  }, [captureUrl, captureTime, isOpen])

  if (!isOpen || !asset) return null

  const busy = isTranscribing || isGenerating
  const cueDuration = getDraftDuration(draft, asset)
  // Timeline mode can always transcribe (the audio mixer will report no-audio
  // conditions at mix time with a clear message). Asset mode still needs a
  // video with an audio track.
  const canTranscribe = isTimelineScope
    ? !busy
    : (asset.type === 'video' && asset.hasAudio !== false && !busy)
  const canGenerate = draft.cues.length > 0 && !busy && addAsset

  const updateCue = (cueId, field, value) => {
    setDraft((prev) => {
      const nextCues = normalizeCueOrder(
        prev.cues.map((cue) => (
          cue.id === cueId
            ? { ...cue, [field]: field === 'text' ? value : Number(value) }
            : cue
        )),
        prev.audioDuration || cueDuration
      )
      return {
        ...prev,
        cues: nextCues,
        transcriptText: cuesToTranscript(nextCues),
      }
    })
  }

  const updateCueOverride = (cueId, field, value) => {
    setDraft((prev) => {
      const nextCues = normalizeCueOrder(
        prev.cues.map((cue) => (
          cue.id === cueId
            ? {
                ...cue,
                override: {
                  ...normalizeCueOverride(cue.override),
                  [field]: value,
                },
              }
            : cue
        )),
        prev.audioDuration || cueDuration
      )

      return {
        ...prev,
        cues: nextCues,
        transcriptText: cuesToTranscript(nextCues),
      }
    })
  }

  const removeCue = (cueId) => {
    setDraft((prev) => {
      const nextCues = prev.cues.filter((cue) => cue.id !== cueId)
      return {
        ...prev,
        cues: nextCues,
        transcriptText: cuesToTranscript(nextCues),
      }
    })
  }

  // Persist the timeline caption setup so reopening the dialog restores the
  // transcription and style choices instead of forcing a re-transcribe.
  const stashTimelineSession = (draftToStash) => {
    if (!isTimelineScope || !currentProjectHandle || !draftToStash) return
    timelineCaptionSessionCache.set(currentProjectHandle, {
      draft: draftToStash,
      selectedPresetId,
      accentColor,
      textColor,
      globalTextStyle,
      subtitlePosition,
      globalVertical,
      globalHorizontal,
      globalMotion,
      globalSizeScale,
      globalVerticalOffset,
    })
  }

  const handleTranscribe = async () => {
    setError('')
    setErrorExpanded(false)
    setIsTranscribing(true)
    try {
      setStatusMessage(
        isTimelineScope
          ? 'Mixing timeline audio for Qwen3-ASR…'
          : 'Connecting to ComfyUI for Qwen3-ASR transcription...'
      )

      const onProgress = (progress) => {
        setStatusMessage(progress?.message || 'Transcribing with Qwen3-ASR...')
      }

      const nextDraft = isTimelineScope
        ? await transcribeTimeline({ onProgress })
        : await transcribeWithComfyUI(asset, { onProgress })

      const normalizedDraft = {
        ...nextDraft,
        cues: normalizeCueOrder(nextDraft.cues, nextDraft.audioDuration || asset?.duration),
      }
      setDraft(normalizedDraft)
      stashTimelineSession(normalizedDraft)

      setStatusMessage(`Transcribed ${nextDraft.cues.length} caption cues via Qwen3-ASR (ComfyUI).`)
    } catch (transcriptionError) {
      setError(
        transcriptionError?.message
        || (isTimelineScope
          ? 'Could not transcribe the timeline. Make sure ComfyUI is running with the Subtitle (QwenASR) node installed.'
          : 'Could not transcribe this video. Make sure ComfyUI is running with the Subtitle (QwenASR) node installed.')
      )
    } finally {
      setIsTranscribing(false)
    }
  }

  const handleGenerate = async () => {
    if (!canGenerate) return
    if (!currentProjectHandle || typeof currentProjectHandle !== 'string') {
      setError('Open a desktop project before generating captions.')
      return
    }

    // The destructive step lives here, not at open: generating a timeline pass
    // replaces the caption track already on the timeline.
    if (isTimelineScope && placeOnTimeline && hasExistingTimelineCaptions) {
      const ok = window.confirm(
        'This will replace the captions track currently on your timeline with the new one.\n\nContinue?'
      )
      if (!ok) return
    }

    setError('')
    setIsGenerating(true)

    try {
      const normalizedCues = normalizeCueOrder(draft.cues, cueDuration)
      const timestamp = new Date().toISOString()

      // Keep the timeline setup so reopening to tweak doesn't lose the transcription.
      stashTimelineSession({ ...draft, cues: normalizedCues })

      // Timeline captions aren't tied to a single source asset, so we skip the
      // per-source sidecar & per-source `updateAsset` bookkeeping.
      let sidecar = null
      if (!isTimelineScope) {
        const sidecarPayload = {
          version: 1,
          sourceAssetId: asset.id,
          sourceAssetName: asset.name,
          sourceAssetPath: asset.path || null,
          presetId: selectedPreset.id,
          modelId: draft.modelId,
          transcriptText: cuesToTranscript(normalizedCues),
          words: draft.words,
          cues: normalizedCues,
          audioDuration: draft.audioDuration || cueDuration,
          createdAt: timestamp,
          updatedAt: timestamp,
        }

        setStatusMessage('Saving editable caption draft...')
        sidecar = await saveCaptionSidecar(currentProjectHandle, asset, sidecarPayload)

        if (typeof updateAsset === 'function') {
          updateAsset(asset.id, {
            settings: {
              ...(asset.settings || {}),
              captionTranscriptPath: sidecar.path,
              lastCaptionPresetId: selectedPreset.id,
              lastCaptionUpdatedAt: timestamp,
            },
          })
        }
      }

      setStatusMessage('Rendering animated caption overlay...')
      const renderCues = normalizedCues.map((cue) => ({
        ...cue,
        globalOverrides: {
          verticalPlacement: globalVertical,
          horizontalPlacement: globalHorizontal,
          motionProfile: globalMotion,
          sizeScale: globalSizeScale,
          verticalOffset: globalVerticalOffset,
          textStyle: globalTextStyle,
          subtitleColor: effectiveTextColor,
          subtitlePosition,
        },
      }))
      const overlayBlob = await generateCaptionVideoBlob({
        preset: renderPreset,
        cues: renderCues,
        width: renderSettings.width,
        height: renderSettings.height,
        duration: cueDuration,
        fps: renderSettings.fps,
      })

      const folderId = ensureCaptionsFolder(folders, addFolder)
      const assetName = buildCaptionAssetName(asset, selectedPreset)
      const captionSettings = {
        width: renderSettings.width,
        height: renderSettings.height,
        duration: cueDuration,
        fps: renderSettings.fps,
        hasAlpha: true,
        source: 'captions',
        overlayKind: 'captions',
        // The 'captionScope' tag lets the timeline find (and later replace) an
        // existing timeline-wide caption overlay. Asset-scope overlays keep
        // their source linkage as before.
        captionScope: isTimelineScope ? 'timeline' : 'asset',
        ...(isTimelineScope ? {} : { sourceAssetId: asset.id }),
        captionPresetId: selectedPreset.id,
        ...(sidecar?.path ? { captionTranscriptPath: sidecar.path } : {}),
        captionCueCount: normalizedCues.length,
        captionModelId: draft.modelId,
      }

      let createdAsset
      if (isElectron() && typeof currentProjectHandle === 'string') {
        const persisted = await writeGeneratedOverlayToProject(
          currentProjectHandle,
          overlayBlob,
          assetName,
          'video',
          captionSettings
        )

        createdAsset = addAsset({
          ...persisted,
          folderId,
          settings: {
            ...(persisted.settings || {}),
            ...captionSettings,
          },
        })
      } else {
        createdAsset = addAsset({
          name: assetName,
          type: 'video',
          url: URL.createObjectURL(overlayBlob),
          folderId,
          mimeType: overlayBlob.type || 'video/webm',
          size: overlayBlob.size,
          isImported: false,
          hasAudio: false,
          audioEnabled: false,
          duration: cueDuration,
          settings: captionSettings,
        })
      }

      if (!isTimelineScope && typeof updateAsset === 'function' && createdAsset?.id) {
        updateAsset(asset.id, {
          settings: {
            ...(asset.settings || {}),
            ...(sidecar?.path ? { captionTranscriptPath: sidecar.path } : {}),
            lastCaptionPresetId: selectedPreset.id,
            lastCaptionAccentColor: accentColor,
            lastCaptionAssetId: createdAsset.id,
            lastCaptionUpdatedAt: timestamp,
          },
        })
      }

      if (placeOnTimeline && typeof onPlaceOnTimeline === 'function' && createdAsset) {
        await onPlaceOnTimeline(createdAsset, isTimelineScope ? null : asset)
      }

      setStatusMessage('Caption overlay added to assets.')
      onClose?.()
    } catch (generationError) {
      setError(generationError?.message || 'Could not generate animated captions.')
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-7xl max-h-[92vh] overflow-hidden rounded-2xl border border-sf-dark-700 bg-sf-dark-950 shadow-[0_30px_60px_rgba(0,0,0,0.35)]">
        <div className="flex items-center justify-between border-b border-sf-dark-700 px-5 py-4">
          <div>
            <div className="text-sm font-semibold text-sf-text-primary">
              Add Captions
            </div>
            <div className="text-xs text-sf-text-muted mt-1">
              {isTimelineScope
                ? 'Timeline program audio · places captions on a new top track'
                : `${asset.name} · local-first transcription and animated overlay export`}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-xs text-sf-text-primary hover:bg-sf-dark-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[1.25fr_1fr] gap-0 max-h-[calc(92vh-72px)]">
          <div className="border-r border-sf-dark-700 p-5 overflow-y-auto space-y-5">
            <section className="rounded-2xl border border-sf-dark-700 bg-sf-dark-900/60 p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <div className="text-sm font-medium text-sf-text-primary">
                    {isTimelineScope ? 'Timeline Audio' : 'Source Video'}
                  </div>
                  <div className="text-xs text-sf-text-muted mt-1">
                    {isTimelineScope
                      ? 'Captions follow the edited program audio — trims, gaps, and mutes all honored.'
                      : 'Select a preset, edit the cues, then save a transparent caption overlay.'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleTranscribe}
                  disabled={!canTranscribe}
                  className="inline-flex items-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-xs font-medium text-white hover:bg-sf-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isTranscribing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Wand2 className="w-4 h-4" />
                  )}
                  {draft.cues.length > 0
                    ? 'Re-transcribe'
                    : (isTimelineScope ? 'Transcribe timeline' : 'Transcribe audio')}
                </button>
              </div>
              {isTimelineScope ? (
                <div className="flex items-center gap-3 rounded-xl border border-sf-dark-700 bg-sf-dark-950/60 p-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-sf-text-primary">Edited timeline</div>
                    <div className="text-[11px] text-sf-text-muted truncate">
                      {draft.cues.length > 0
                        ? `${draft.cues.length} cues transcribed`
                        : 'Mixed program audio, transcribed with Qwen3-ASR'}
                    </div>
                  </div>
                  {asset?.duration ? (
                    <div className="ml-auto flex-shrink-0 text-right">
                      <div className="text-[9px] uppercase tracking-[0.12em] text-sf-text-muted">Length</div>
                      <div className="text-sm font-mono text-sf-text-primary">{formatSeconds(asset.duration)}</div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="aspect-video rounded-xl overflow-hidden bg-black border border-sf-dark-700">
                  {asset.url ? (
                    <video
                      src={asset.url}
                      controls
                      className="w-full h-full object-contain bg-black"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-sm text-sf-text-muted">
                      Preview unavailable for this asset.
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-sf-dark-700 bg-sf-dark-900/60 p-4">
              <div className="text-sm font-medium text-sf-text-primary mb-3">
                Style Presets
              </div>
              <div className="space-y-2">
                {CAPTION_PRESETS.map((preset) => {
                  const selected = preset.id === selectedPresetId
                  const thumb = selected ? (selectedPreviewUrl || previewUrls[preset.id]) : previewUrls[preset.id]
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        setSelectedPresetId(preset.id)
                        setAccentColor(preset.keyWordColor || DEFAULT_KINETIC_ACCENT_COLOR)
                        setTextColor(null)
                        setGlobalTextStyle(preset.defaultTextStyle || (preset.traditional ? 'background' : 'plain'))
                        setSubtitlePosition(preset.subtitlePosition || 'action-safe')
                      }}
                      className={`w-full flex items-center gap-3 rounded-xl border p-2 text-left transition-colors ${
                        selected
                          ? 'border-sf-accent bg-sf-dark-800'
                          : 'border-sf-dark-700 bg-sf-dark-900 hover:border-sf-dark-500'
                      }`}
                    >
                      <div className="w-[88px] h-[50px] flex-shrink-0 rounded-lg overflow-hidden bg-sf-dark-950">
                        {thumb ? (
                          <img
                            src={thumb}
                            alt={preset.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-[10px] text-sf-text-muted">
                            {preset.name}
                          </div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-sf-text-primary">{preset.name}</div>
                        <div className="text-xs text-sf-text-muted mt-0.5 line-clamp-2">{preset.description}</div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </section>
          </div>

          <div className="flex flex-col max-h-[calc(92vh-72px)]">
          <div className="p-5 overflow-y-auto flex-1 space-y-5">
            <section className="rounded-2xl border border-sf-dark-700 bg-sf-dark-900/60 p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <div className="text-sm font-medium text-sf-text-primary">Preview</div>
                  <div className="text-xs text-sf-text-muted mt-1">
                    {isTimelineScope
                      ? (asset?.bgVideoUrl
                          ? 'Sample caption over the frame at your playhead.'
                          : 'Sample caption at your timeline aspect ratio.')
                      : 'Sample caption over a frame of your footage. Adjust placement below.'}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowTikTokOverlay((v) => !v)}
                    className={`rounded-full border px-2.5 py-1 text-[10px] transition-colors ${
                      showTikTokOverlay
                        ? 'border-sf-accent bg-sf-accent/20 text-sf-text-primary'
                        : 'border-sf-dark-600 bg-sf-dark-900 text-sf-text-muted hover:border-sf-dark-500 hover:text-sf-text-primary'
                    }`}
                    title="Show an approximate TikTok UI so you can keep captions clear of it"
                  >
                    TikTok overlay
                  </button>
                  <div className="text-[11px] text-sf-text-muted">
                    {renderSettings.width}×{renderSettings.height}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-center rounded-xl bg-black border border-sf-dark-700 overflow-hidden" style={{ maxHeight: 380 }}>
                <div className="relative" style={{ maxHeight: 380, maxWidth: '100%' }}>
                  <canvas
                    ref={previewCanvasRef}
                    className="block"
                    style={{ maxHeight: 380, maxWidth: '100%' }}
                  />
                  {showTikTokOverlay && (
                    <TikTokGuideOverlay w={renderSettings.width} h={renderSettings.height} />
                  )}
                </div>
              </div>

              {/* Play / scrub controls for the live animated preview */}
              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setIsPreviewPlaying((p) => {
                      const next = !p
                      if (next && previewTimeRef.current >= previewDuration - 0.01) {
                        previewTimeRef.current = 0
                        setScrubDisplay(0)
                      }
                      return next
                    })
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-sf-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-sf-accent/90"
                  title="Play the caption animation in this window"
                >
                  {isPreviewPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  {isPreviewPlaying ? 'Pause' : 'Play'}
                </button>
                <input
                  type="range"
                  min={0}
                  max={previewDuration}
                  step={0.01}
                  value={Math.min(scrubDisplay, previewDuration)}
                  onChange={(e) => {
                    const t = Number(e.target.value)
                    previewTimeRef.current = t
                    setScrubDisplay(t)
                    if (isPreviewPlaying) setIsPreviewPlaying(false)
                    else drawPreview(t, true)
                  }}
                  className="flex-1 accent-sf-accent"
                  aria-label="Preview scrubber"
                />
                <span className="text-[10px] text-sf-text-muted font-mono w-16 text-right">
                  {scrubDisplay.toFixed(1)}s / {previewDuration.toFixed(1)}s
                </span>
              </div>
              {showTikTokOverlay && (
                <div className="mt-2 text-[10px] text-sf-text-muted">
                  Approximate TikTok layout — keep key text inside the dashed safe area.
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-sf-dark-700 bg-sf-dark-900/60 p-4 space-y-3">
              <div>
                <div className="text-sm font-medium text-sf-text-primary">Style</div>
                <div className="text-xs text-sf-text-muted mt-1">
                  Applies to all cues. Per-cue overrides take priority.
                </div>
              </div>

              <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-950/40 px-3 py-3 space-y-3">
                <ColorField
                  label="Text color"
                  hint="Base color for the words."
                  value={effectiveTextColor}
                  onChange={setTextColor}
                  onReset={() => setTextColor(null)}
                  resetDisabled={textColor === null}
                />
                {!selectedPreset?.traditional && selectedPreset?.accentCustomizable && (
                  <ColorField
                    label="Accent color"
                    hint="The word currently being spoken."
                    value={accentColor}
                    onChange={setAccentColor}
                    onReset={() => setAccentColor(selectedPreset.keyWordColor || DEFAULT_KINETIC_ACCENT_COLOR)}
                    resetDisabled={accentColor === (selectedPreset.keyWordColor || DEFAULT_KINETIC_ACCENT_COLOR)}
                  />
                )}
              </div>

              <CueOverrideChips
                label="Text Style"
                value={globalTextStyle}
                options={TEXT_STYLE_OPTIONS}
                onChange={setGlobalTextStyle}
              />

              {selectedPreset?.traditional ? (
                <CueOverrideChips
                  label="Position"
                  value={subtitlePosition}
                  options={SUBTITLE_POSITION_OPTIONS}
                  onChange={setSubtitlePosition}
                />
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <CueOverrideChips
                    label="Vertical"
                    value={globalVertical}
                    options={CUE_VERTICAL_OPTIONS}
                    onChange={setGlobalVertical}
                  />
                  <CueOverrideChips
                    label="Horizontal"
                    value={globalHorizontal}
                    options={CUE_HORIZONTAL_OPTIONS}
                    onChange={setGlobalHorizontal}
                  />
                  <CueOverrideChips
                    label="Motion"
                    value={globalMotion}
                    options={CUE_MOTION_OPTIONS}
                    onChange={setGlobalMotion}
                  />
                </div>
              )}

              <div className="space-y-1 pt-1">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] uppercase tracking-[0.12em] text-sf-text-muted">
                    Size
                  </div>
                  <button
                    type="button"
                    onClick={() => setGlobalSizeScale(1)}
                    disabled={globalSizeScale === 1}
                    className="text-[10px] text-sf-text-muted hover:text-sf-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Reset to default size"
                  >
                    Reset
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-sf-text-muted w-10 text-right">Smaller</span>
                  <input
                    type="range"
                    min={30}
                    max={180}
                    step={5}
                    value={Math.round(globalSizeScale * 100)}
                    onChange={(e) => setGlobalSizeScale(Number(e.target.value) / 100)}
                    className="flex-1 accent-sf-accent"
                    aria-label="Caption size"
                  />
                  <span className="text-[10px] text-sf-text-muted w-10">Bigger</span>
                </div>
              </div>

              <div className="space-y-1 pt-1">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] uppercase tracking-[0.12em] text-sf-text-muted">
                    Vertical nudge
                  </div>
                  <button
                    type="button"
                    onClick={() => setGlobalVerticalOffset(0)}
                    disabled={globalVerticalOffset === 0}
                    className="text-[10px] text-sf-text-muted hover:text-sf-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Center the captions vertically"
                  >
                    Reset
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-sf-text-muted w-8 text-right">Up</span>
                  <input
                    type="range"
                    min={-45}
                    max={45}
                    step={1}
                    value={Math.round(globalVerticalOffset * 100)}
                    onChange={(e) => setGlobalVerticalOffset(Number(e.target.value) / 100)}
                    className="flex-1 accent-sf-accent"
                    aria-label="Vertical nudge"
                  />
                  <span className="text-[10px] text-sf-text-muted w-8">Down</span>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-sf-dark-700 bg-sf-dark-900/60 p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <div className="text-sm font-medium text-sf-text-primary">Caption Cues</div>
                  <div className="text-xs text-sf-text-muted mt-1">
                    Adjust the transcribed text and timing before rendering.
                  </div>
                </div>
                <div className="text-[11px] text-sf-text-muted">
                  {draft.cues.length} cues · {cueDuration.toFixed(2)}s
                </div>
              </div>

              {draft.cues.length === 0 ? (
                <div className="rounded-xl border border-dashed border-sf-dark-600 bg-sf-dark-950/70 px-4 py-8 text-center">
                  <div className="text-sm text-sf-text-primary">No caption cues yet.</div>
                  <div className="text-xs text-sf-text-muted mt-2">
                    Run local transcription to generate editable caption phrases from the video audio.
                  </div>
                </div>
              ) : (
                <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                  {draft.cues.map((cue) => (
                    <div
                      key={cue.id}
                      className="rounded-xl border border-sf-dark-700 bg-sf-dark-950/70 p-3 space-y-3"
                    >
                      <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                        <label className="text-[11px] text-sf-text-muted">
                          Start
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={cue.start}
                            onChange={(e) => updateCue(cue.id, 'start', e.target.value)}
                            className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                          />
                        </label>
                        <label className="text-[11px] text-sf-text-muted">
                          End
                          <input
                            type="number"
                            step="0.01"
                            min={cue.start + 0.1}
                            value={cue.end}
                            onChange={(e) => updateCue(cue.id, 'end', e.target.value)}
                            className="mt-1 w-full rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => removeCue(cue.id)}
                          className="mt-5 rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-2.5 py-1.5 text-[11px] text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800"
                        >
                          Remove
                        </button>
                      </div>
                      <textarea
                        value={cue.text}
                        onChange={(e) => updateCue(cue.id, 'text', e.target.value)}
                        className="w-full h-20 rounded-xl border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary resize-none focus:outline-none focus:border-sf-accent"
                      />
                      <div className="grid grid-cols-1 gap-2">
                        <CueOverrideChips
                          label="Vertical"
                          value={cue.override?.verticalPlacement || 'auto'}
                          options={CUE_VERTICAL_OPTIONS}
                          onChange={(nextValue) => updateCueOverride(cue.id, 'verticalPlacement', nextValue)}
                        />
                        <CueOverrideChips
                          label="Horizontal"
                          value={cue.override?.horizontalPlacement || 'auto'}
                          options={CUE_HORIZONTAL_OPTIONS}
                          onChange={(nextValue) => updateCueOverride(cue.id, 'horizontalPlacement', nextValue)}
                        />
                        <CueOverrideChips
                          label="Motion"
                          value={cue.override?.motionProfile || 'auto'}
                          options={CUE_MOTION_OPTIONS}
                          onChange={(nextValue) => updateCueOverride(cue.id, 'motionProfile', nextValue)}
                        />
                      </div>
                      <div className="text-[11px] text-sf-text-muted">
                        {formatSeconds(cue.start)} → {formatSeconds(cue.end)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-sf-dark-700 bg-sf-dark-900/60 p-4 space-y-3">
              <div className="text-sm font-medium text-sf-text-primary">Export</div>
              <label className="flex items-center gap-2 text-xs text-sf-text-primary">
                <input
                  type="checkbox"
                  checked={placeOnTimeline}
                  onChange={(e) => setPlaceOnTimeline(e.target.checked)}
                  className="rounded border-sf-dark-500 bg-sf-dark-900 text-sf-accent focus:ring-sf-accent"
                />
                Place the generated overlay on the top video track after saving
              </label>
              <div className="text-[11px] text-sf-text-muted">
                Output: transparent WebM overlay in the root-level `Captions` asset folder.
              </div>
            </section>

          </div>

          <div className="flex-shrink-0 border-t border-sf-dark-700 px-5 py-4 flex items-start justify-between gap-3">
            {(statusMessage || error) ? (
              <div className="flex items-start gap-2 text-xs min-w-0 flex-1 overflow-hidden">
                {busy ? (
                  <Loader2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-sf-accent animate-spin" />
                ) : error ? (
                  <X className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-sf-error" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-sf-success" />
                )}
                {error ? (
                  (() => {
                    const fullErrorText = String(error)
                    const lines = fullErrorText.split('\n').filter(Boolean)
                    const hasDetails = lines.length > 1
                    const handleCopyError = async () => {
                      try {
                        if (navigator.clipboard?.writeText) {
                          await navigator.clipboard.writeText(fullErrorText)
                        } else {
                          // Execution fallback for ancient runtimes / locked-down clipboards.
                          const ta = document.createElement('textarea')
                          ta.value = fullErrorText
                          ta.style.position = 'fixed'
                          ta.style.opacity = '0'
                          document.body.appendChild(ta)
                          ta.select()
                          document.execCommand('copy')
                          document.body.removeChild(ta)
                        }
                        setErrorCopied(true)
                        setTimeout(() => setErrorCopied(false), 1500)
                      } catch (err) {
                        console.warn('[CaptionWorkspace] clipboard copy failed:', err)
                      }
                    }
                    return (
                      <div className="min-w-0 flex-1 text-sf-error">
                        <div className={hasDetails ? 'select-text' : 'truncate select-text'}>{lines[0] || error}</div>
                        {hasDetails && errorExpanded && (
                          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-sf-dark-900 border border-sf-dark-700 p-2 text-[11px] text-sf-text-muted font-mono select-text cursor-text">
                            {lines.slice(1).join('\n')}
                          </pre>
                        )}
                        <div className="mt-1 flex items-center gap-3 text-[11px]">
                          {hasDetails && (
                            <button
                              type="button"
                              onClick={() => setErrorExpanded((v) => !v)}
                              className="underline text-sf-text-muted hover:text-sf-text-primary"
                            >
                              {errorExpanded ? 'Hide details' : `Show details (${lines.length - 1} line${lines.length - 1 === 1 ? '' : 's'})`}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={handleCopyError}
                            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors ${
                              errorCopied
                                ? 'text-sf-success bg-sf-success/10'
                                : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-700'
                            }`}
                            title="Copy full error message to the clipboard"
                          >
                            {errorCopied ? (
                              <>
                                <Check className="w-3 h-3" />
                                Copied
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3" />
                                Copy error
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    )
                  })()
                ) : (
                  <span className="truncate text-sf-text-muted">{statusMessage}</span>
                )}
              </div>
            ) : (
              <div />
            )}
            <div className="flex items-center gap-3 flex-shrink-0">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="rounded-xl border border-sf-dark-600 bg-sf-dark-900 px-4 py-2 text-sm text-sf-text-primary hover:bg-sf-dark-800 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={!canGenerate}
                className="inline-flex items-center gap-2 rounded-xl bg-sf-accent px-4 py-2 text-sm font-medium text-white hover:bg-sf-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isGenerating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                Generate 1 video with captions
              </button>
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default CaptionWorkspace
