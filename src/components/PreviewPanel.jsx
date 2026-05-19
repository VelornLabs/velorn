import { Maximize2, Minimize2, Plus, X, Check, Home, ZoomIn, ZoomOut, Move, Play, Pause, SkipBack, SkipForward, Volume2, Film, Image as ImageIcon, ChevronDown, Grid3X3, Crosshair, Square, Frame, Eye, EyeOff, Layers, Wand2, Camera, Loader2 } from 'lucide-react'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import useAssetsStore from '../stores/assetsStore'
import useTimelineStore from '../stores/timelineStore'
import useProjectStore from '../stores/projectStore'
import { useFrameForAIStore } from '../stores/frameForAIStore'
import { useTimelinePlayback } from '../hooks/useTimelinePlayback'
import useViewportClampedPosition from '../hooks/useViewportClampedPosition'
import { captureTimelineFrameAt, getTopmostVideoOrImageClipAtTime } from '../utils/captureTimelineFrame'
import { getAnimatedTransform } from '../utils/keyframes'
import VideoLayerRenderer from './VideoLayerRenderer'
import CanvasPreviewRenderer from './CanvasPreviewRenderer'
import AudioLayerRenderer from './AudioLayerRenderer'
import PreviewTransformGizmo from './PreviewTransformGizmo'
import {
  getPreviewProxyPath,
  computePreviewSignature,
  renderPreviewProxy,
  renderPreviewChunk,
  getPreviewComplexity,
  shouldAutoGeneratePreviewProxy,
} from '../services/previewCache'
import { generateMissingProxiesForAllVideos, hasUsableProxy, isProxyableVideoAsset } from '../services/proxyCache'
import { importAsset } from '../services/fileSystem'
import { getGlslPreviewQualityScale } from '../utils/glslEffects'

/**
 * MaskPreview - Component for previewing mask assets with frame-by-frame playback
 * Supports both single-frame masks and multi-frame (video) masks
 */
function MaskPreview({ mask, isPlaying, currentFrame, onFrameChange, onDurationSet, onTimeUpdate, onEnded }) {
  const [loadedFrames, setLoadedFrames] = useState({})
  const animationRef = useRef(null)
  const lastFrameTime = useRef(performance.now())
  const lastReportedDuration = useRef(null)
  const lastReportedTime = useRef(null)
  
  // Default to 24fps for mask playback
  const fps = 24
  const frameInterval = 1000 / fps
  
  // Get the frames array or create a single-frame array
  const frames = useMemo(() => {
    if (mask.maskFrames && mask.maskFrames.length > 0) {
      return mask.maskFrames
    }
    // Single frame mask
    return [{ url: mask.url, filename: 'frame_0' }]
  }, [mask])
  
  const totalFrames = frames.length
  const duration = totalFrames / fps
  
  // Report duration to parent (in seconds) - only when it changes
  useEffect(() => {
    if (onDurationSet && totalFrames > 0 && lastReportedDuration.current !== duration) {
      lastReportedDuration.current = duration
      onDurationSet(duration)
    }
  }, [totalFrames, duration, onDurationSet])
  
  // Report time updates when frame changes - only when it changes
  useEffect(() => {
    const currentTime = currentFrame / fps
    if (onTimeUpdate && lastReportedTime.current !== currentTime) {
      lastReportedTime.current = currentTime
      onTimeUpdate(currentTime)
    }
  }, [currentFrame, fps, onTimeUpdate])
  
  // Preload all frames
  useEffect(() => {
    frames.forEach((frame, index) => {
      if (frame.url && !loadedFrames[index]) {
        const img = new Image()
        img.onload = () => {
          setLoadedFrames(prev => ({ ...prev, [index]: true }))
        }
        img.src = frame.url
      }
    })
  }, [frames, loadedFrames])
  
  // Playback animation loop
  useEffect(() => {
    if (!isPlaying || totalFrames <= 1) {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
        animationRef.current = null
      }
      return
    }
    
    const animate = () => {
      const now = performance.now()
      const elapsed = now - lastFrameTime.current
      
      if (elapsed >= frameInterval) {
        lastFrameTime.current = now - (elapsed % frameInterval)
        
        // Advance frame (stop at end instead of looping)
        const nextFrame = currentFrame + 1
        if (nextFrame >= totalFrames) {
          // End of mask - stop playing
          cancelAnimationFrame(animationRef.current)
          animationRef.current = null
          if (onEnded) onEnded()
          return
        }
        onFrameChange(nextFrame)
      }
      
      animationRef.current = requestAnimationFrame(animate)
    }
    
    lastFrameTime.current = performance.now()
    animationRef.current = requestAnimationFrame(animate)
    
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [isPlaying, currentFrame, totalFrames, frameInterval, onFrameChange])
  
  // Get current frame URL
  const currentFrameUrl = frames[currentFrame]?.url || mask.url
  
  return (
    <div 
      className="w-full h-full flex items-center justify-center"
      style={{
        /* Checkered background pattern for transparency visualization */
        backgroundImage: `
          linear-gradient(45deg, #333 25%, transparent 25%),
          linear-gradient(-45deg, #333 25%, transparent 25%),
          linear-gradient(45deg, transparent 75%, #333 75%),
          linear-gradient(-45deg, transparent 75%, #333 75%)
        `,
        backgroundSize: '20px 20px',
        backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
        backgroundColor: '#222',
      }}
    >
      <img
        src={currentFrameUrl}
        alt={`${mask.name} - Frame ${currentFrame + 1}/${totalFrames}`}
        className="max-w-full max-h-full"
        style={{
          display: 'block',
          objectFit: 'contain',
        }}
        onContextMenu={(e) => e.preventDefault()}
        onError={(e) => {
          console.error('Mask frame load error:', e)
        }}
      />
      
      {/* Frame counter overlay for multi-frame masks */}
      {totalFrames > 1 && (
        <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/70 rounded text-xs text-white">
          Frame {currentFrame + 1} / {totalFrames}
        </div>
      )}
    </div>
  )
}

// Zoom presets
const ZOOM_PRESETS = [
  { label: 'Fit', value: 'fit' },
  { label: '25%', value: 25 },
  { label: '50%', value: 50 },
  { label: '75%', value: 75 },
  { label: '100%', value: 100 },
  { label: '150%', value: 150 },
  { label: '200%', value: 200 },
]

// Safe guide presets
const SAFE_GUIDES = [
  { id: 'none', label: 'No Guides', description: 'Hide all guides' },
  { id: 'title-safe', label: 'Title Safe', description: '90% - Keep text inside', percent: 90 },
  { id: 'action-safe', label: 'Action Safe', description: '93% - Keep action inside', percent: 93 },
  { id: 'rule-of-thirds', label: 'Rule of Thirds', description: '3x3 grid overlay' },
  { id: 'center', label: 'Center Crosshair', description: 'Center point marker' },
  { id: 'all-safe', label: 'Title + Action Safe', description: 'Both safe zones' },
]

// Letterbox presets (for visualizing different delivery formats)
const LETTERBOX_PRESETS = [
  { id: 'none', label: 'No Letterbox', ratio: null },
  { id: '2.39:1', label: '2.39:1 Anamorphic', ratio: 2.39 },
  { id: '2.35:1', label: '2.35:1 Cinemascope', ratio: 2.35 },
  { id: '1.85:1', label: '1.85:1 Theatrical', ratio: 1.85 },
  { id: '16:9', label: '16:9 HD', ratio: 16/9 },
  { id: '4:3', label: '4:3 Classic TV', ratio: 4/3 },
  { id: '9:16', label: '9:16 Vertical (TikTok/Reels)', ratio: 9/16 },
  { id: '4:5', label: '4:5 Instagram Portrait', ratio: 4/5 },
  { id: '1:1', label: '1:1 Square (Instagram)', ratio: 1 },
]
const AUTO_SMOOTH_PREVIEW_KEY = 'comfystudio-auto-smooth-preview'
const PREVIEW_TRANSFORM_CONTROLS_KEY = 'previewShowTransformControls'
const PREVIEW_CHUNK_DURATION = 5
const PREVIEW_CHUNK_COUNT = 4
const PREVIEW_CHUNK_EPSILON = 0.03

function isSamePreviewChunkRange(a, b) {
  return Math.abs((Number(a?.rangeStart) || 0) - (Number(b?.rangeStart) || 0)) < 0.001
    && Math.abs((Number(a?.rangeEnd) || 0) - (Number(b?.rangeEnd) || 0)) < 0.001
}

function upsertPreviewChunk(chunks, nextChunk) {
  const filtered = (chunks || []).filter((chunk) => !(
    chunk.signature === nextChunk.signature
    && isSamePreviewChunkRange(chunk, nextChunk)
  ))
  return [...filtered, nextChunk].sort((a, b) => a.rangeStart - b.rangeStart)
}

function formatPreviewChunkTime(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0))
  const minutes = Math.floor(totalSeconds / 60)
  const secs = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${secs}`
}

function formatPreviewChunkRange(range) {
  return `${formatPreviewChunkTime(range?.rangeStart)}-${formatPreviewChunkTime(range?.rangeEnd)}`
}

function PreviewPanel() {
  const videoRefA = useRef(null) // Used for asset preview mode
  const containerRef = useRef(null)
  const viewportRef = useRef(null)
  const panelRef = useRef(null)
  const holdFrameCanvasRef = useRef(null) // Canvas to hold last frame during video src changes
  const previewTransformHistoryClipRef = useRef(null)
  const [showHoldFrame, setShowHoldFrame] = useState(false) // Whether to show the hold frame canvas
  
  // Track active clips at current playhead position (for overlay display)
  const [activeLayerClips, setActiveLayerClips] = useState([])
  
  // Context menu state
  const [contextMenu, setContextMenu] = useState(null) // { x, y }
  // Keep the context menu on-screen when right-clicking near the bottom
  // or right edge of the preview — see useViewportClampedPosition for how
  // the menu is measured and its origin shifted.
  const contextMenuRef = useRef(null)
  const contextMenuAnchor = useMemo(
    () => (contextMenu ? { x: contextMenu.x, y: contextMenu.y } : null),
    [contextMenu?.x, contextMenu?.y]
  )
  const contextMenuPosition = useViewportClampedPosition(
    contextMenuAnchor,
    contextMenuRef,
  )
  const [capturingFrameForAI, setCapturingFrameForAI] = useState(false)
  const [capturingStillFrame, setCapturingStillFrame] = useState(false)
  
  const setFrameForAI = useFrameForAIStore((s) => s.setFrame)
  
  // Mask preview state (for multi-frame mask playback)
  const [maskFrame, setMaskFrame] = useState(0)
  const [maskDuration, setMaskDuration] = useState(0)

  // Get current preview and playback state from assets store
  const { 
    assets,
    currentPreview, 
    clearPreview,
    addAsset,
    volume,
    registerVideoRef,
    setIsPlaying: setAssetIsPlaying,
    setCurrentTime: setAssetCurrentTime,
    setDuration: setAssetDuration,
    isPlaying: assetIsPlaying,
    currentTime: assetCurrentTime,
    duration: assetDuration,
    togglePlay: assetTogglePlay,
    seekTo: assetSeekTo,
    setVolume,
    previewMode,
    setPreviewMode
  } = useAssetsStore()
  
  // Timeline store for adding clips and playback
  const { 
    addClip, 
    isPlaying: timelineIsPlaying,
    playheadPosition,
    setPlayheadPosition,
    togglePlay: timelineTogglePlay,
    getActiveClipAtTime,
    getActiveClipsAtTime,
    getTransitionAtTime,
    getTimelineEndTime,
    clips,
    tracks,
    transitions,
    selectedClipIds,
    selectClip,
    requestTextEdit,
    saveToHistory,
    updateClipTransform,
    hasKeyframes,
    setKeyframe,
    duration: timelineDuration,
    timelineFps,
    previewProxyStatus,
    previewProxyPath,
    previewProxySignature,
    previewProxyProgress,
    setPreviewProxyGenerating,
    setPreviewProxyReady,
    setPreviewProxyInvalid,
    useProxyPlaybackForAssets,
    setUseProxyPlaybackForAssets,
    glslPreviewQuality,
    setGlslPreviewQuality,
    previewCompositorMode,
    setPreviewCompositorMode,
  } = useTimelineStore()
  
  // Use timeline playback hook
  const {
    activeClip,
    transitionInfo,
    sourceTime,
    endTime,
  } = useTimelinePlayback()
  
  // Get full clip data with transform for the active clip
  const getClipTransform = (clip) => {
    if (!clip) return null
    // Find the full clip object from the store to get transform
    const fullClip = clips.find(c => c.id === clip.id)
    return fullClip?.transform || {
      positionX: 0, positionY: 0,
      scaleX: 100, scaleY: 100, scaleLinked: true,
      rotation: 0, anchorX: 50, anchorY: 50, opacity: 100,
      flipH: false, flipV: false,
      cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0,
      blur: 0,
    }
  }
  
  // Build CSS transform string from clip transform properties
  const buildVideoTransform = (clipTransform) => {
    if (!clipTransform) return {}
    
    const {
      positionX, positionY,
      scaleX, scaleY,
      rotation,
      anchorX, anchorY,
      opacity,
      flipH, flipV,
      cropTop, cropBottom, cropLeft, cropRight,
      blendMode,
      blur = 0,
    } = clipTransform

    // Transform values are authored in timeline-resolution pixels.
    // Scale them into current preview pixels so composition stays identical
    // regardless of preview pane size.
    const previewScaleX = Number.isFinite(previewScale?.x) && previewScale.x > 0 ? previewScale.x : 1
    const previewScaleY = Number.isFinite(previewScale?.y) && previewScale.y > 0 ? previewScale.y : 1
    const previewScaleUniform = Number.isFinite(previewScale?.uniform) && previewScale.uniform > 0
      ? previewScale.uniform
      : 1
    
    // Build transform components
    const transforms = []
    
    // Position (translate)
    const scaledPositionX = positionX * previewScaleX
    const scaledPositionY = positionY * previewScaleY
    if (scaledPositionX !== 0 || scaledPositionY !== 0) {
      transforms.push(`translate(${scaledPositionX}px, ${scaledPositionY}px)`)
    }
    
    // Scale (with flip)
    const finalScaleX = (scaleX / 100) * (flipH ? -1 : 1)
    const finalScaleY = (scaleY / 100) * (flipV ? -1 : 1)
    if (finalScaleX !== 1 || finalScaleY !== 1) {
      transforms.push(`scale(${finalScaleX}, ${finalScaleY})`)
    }
    
    // Rotation
    if (rotation !== 0) {
      transforms.push(`rotate(${rotation}deg)`)
    }
    
    // Build style object
    const style = {}
    
    if (transforms.length > 0) {
      style.transform = transforms.join(' ')
    }
    
    // Transform origin (anchor point)
    style.transformOrigin = `${anchorX}% ${anchorY}%`
    
    // Opacity
    if (opacity !== 100) {
      style.opacity = opacity / 100
    }
    
    // Blend mode (composite with layers below)
    if (blendMode && blendMode !== 'normal') {
      style.mixBlendMode = blendMode
    }
    
    // Crop using clip-path
    if (cropTop > 0 || cropBottom > 0 || cropLeft > 0 || cropRight > 0) {
      style.clipPath = `inset(${cropTop}% ${cropRight}% ${cropBottom}% ${cropLeft}%)`
    }
    
    // Blur (CSS filter)
    if (blur > 0) {
      style.filter = `blur(${blur * previewScaleUniform}px)`
    }

    // Expose preview scale so downstream layers (e.g. text) can match output framing.
    style['--comfystudio-preview-scale'] = String(previewScaleUniform)
    
    return style
  }
  
  // Track if we just added to timeline
  const [justAdded, setJustAdded] = useState(false)
  const [justCapturedStill, setJustCapturedStill] = useState(false)
  
  // Fullscreen state
  const [isFullscreen, setIsFullscreen] = useState(false)
  
  // Zoom and pan state
  const [zoom, setZoom] = useState('fit') // 'fit' or number (percentage)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [isZooming, setIsZooming] = useState(false)
  const [isSpaceHeld, setIsSpaceHeld] = useState(false)
  const [isCtrlHeld, setIsCtrlHeld] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [zoomStart, setZoomStart] = useState(100)
  const [showZoomDropdown, setShowZoomDropdown] = useState(false)
  
  // Safe guides state
  const [safeGuide, setSafeGuide] = useState('none')
  const [letterbox, setLetterbox] = useState('none')
  const [showGuidesDropdown, setShowGuidesDropdown] = useState(false)
  
  // Info overlay visibility (load from localStorage, default to off)
  const [showInfoOverlay, setShowInfoOverlay] = useState(() => {
    try {
      const saved = localStorage.getItem('previewShowInfoOverlay')
      return saved !== null ? JSON.parse(saved) : false
    } catch {
      return false
    }
  })
  const [showPreviewTransformControls, setShowPreviewTransformControls] = useState(() => {
    try {
      const saved = localStorage.getItem(PREVIEW_TRANSFORM_CONTROLS_KEY)
      return saved !== null ? JSON.parse(saved) : true
    } catch {
      return true
    }
  })
  const [autoSmoothPreviewEnabled, setAutoSmoothPreviewEnabled] = useState(() => {
    // Default OFF now that per-asset proxies cover the common case. Users
    // who previously opted in (true) keep their setting; fresh/cleared
    // installs no longer trigger full-timeline re-renders on every edit,
    // which was the main friction for music-video workflows.
    try {
      return localStorage.getItem(AUTO_SMOOTH_PREVIEW_KEY) === 'true'
    } catch {
      return false
    }
  })
  
  // Persist info overlay preference
  useEffect(() => {
    try {
      localStorage.setItem('previewShowInfoOverlay', JSON.stringify(showInfoOverlay))
    } catch {
      // Ignore localStorage errors.
    }
  }, [showInfoOverlay])
  useEffect(() => {
    try {
      localStorage.setItem(PREVIEW_TRANSFORM_CONTROLS_KEY, JSON.stringify(showPreviewTransformControls))
    } catch {
      // Ignore localStorage errors.
    }
  }, [showPreviewTransformControls])
  useEffect(() => {
    try {
      localStorage.setItem(AUTO_SMOOTH_PREVIEW_KEY, autoSmoothPreviewEnabled ? 'true' : 'false')
    } catch {
      // Ignore localStorage errors.
    }
  }, [autoSmoothPreviewEnabled])
  
  // Get timeline-specific settings and project handle for preview proxy
  const { getCurrentTimelineSettings, currentProjectHandle, currentTimelineId } = useProjectStore()
  const timelineSettings = getCurrentTimelineSettings()
  const previewComplexity = useMemo(
    () => getPreviewComplexity({ clips, tracks, transitions }),
    [clips, tracks, transitions]
  )
  // Proxy coverage snapshot: how many video assets have a ready proxy vs.
  // total video assets. Drives the "12/34 ready" hint on the toggle and
  // gates the "Generate missing proxies" CTA. Recomputed when assets change.
  //
  // Buckets (must sum to the total video count):
  //   - ready:       proxy encoded and usable for playback
  //   - encoding:    currently being transcoded
  //   - missing:     *proxyable* (local path present) and hasn't been
  //                  tried yet — "Generate missing" will process these
  //   - unavailable: can't be proxied right now, either because no local
  //                  file was found OR a previous attempt failed (broken
  //                  link, unreadable file, ffmpeg error). Surfaced as an
  //                  amber badge so users understand why the numbers don't
  //                  add up and can re-link / re-import / Rebuild all to
  //                  retry. Keeping failed + not-proxyable together keeps
  //                  the UI to a single "something's wrong here" signal.
  const proxyCoverage = useMemo(() => {
    const videoAssets = (assets || []).filter((a) => a?.type === 'video')
    const total = videoAssets.length
    const ready = videoAssets.filter(hasUsableProxy).length
    const encoding = videoAssets.filter((a) => a.proxyStatus === 'encoding').length
    const proxyableAssets = videoAssets.filter(isProxyableVideoAsset)
    const failedProxyable = proxyableAssets.filter((a) => a.proxyStatus === 'failed').length
    const missing = proxyableAssets.filter((a) => (
      !hasUsableProxy(a)
      && a.proxyStatus !== 'encoding'
      && a.proxyStatus !== 'failed'
    )).length
    const unavailable = (total - proxyableAssets.length) + failedProxyable
    return { total, ready, encoding, missing, unavailable }
  }, [assets])
  const [generatingProxies, setGeneratingProxies] = useState(false)
  const [proxyGenerationMode, setProxyGenerationMode] = useState('missing')
  // Progress indicator for the rebuild/generate flow. Without this the UI
  // can look frozen because the ready-count oscillates around its starting
  // value while each re-encoded asset briefly drops to `encoding`.
  const [proxyGenerationProgress, setProxyGenerationProgress] = useState({ current: 0, total: 0 })
  const generateProxiesForAll = useCallback(async ({ force = false } = {}) => {
    if (!currentProjectHandle || generatingProxies) return
    setGeneratingProxies(true)
    setProxyGenerationMode(force ? 'rebuild' : 'missing')

    // Pre-compute the expected batch size from a store snapshot so the
    // button can show N/total even before the first asset is processed.
    // Uses the same proxyable/ready predicates as the bulk transcoder — any
    // drift here and the progress counter ends up pointing at the wrong
    // denominator. "Generate missing" excludes `failed` (those live in the
    // unavailable badge); "Rebuild all" (`force`) retries everything
    // proxyable so fixing a broken link + Rebuild all recovers cleanly.
    const initialAssets = useAssetsStore.getState().assets || []
    const expectedTotal = initialAssets.filter((a) => {
      if (!isProxyableVideoAsset(a)) return false
      if (force) return true
      if (a.proxyStatus === 'encoding') return false
      if (a.proxyStatus === 'failed') return false
      return !hasUsableProxy(a)
    }).length
    setProxyGenerationProgress({ current: 0, total: expectedTotal })

    try {
      let started = 0
      const label = force ? 'rebuild' : 'generate-missing'
      console.log(`[ProxyCache] ${label} starting for ${expectedTotal} asset(s)`)
      const summary = await generateMissingProxiesForAllVideos(currentProjectHandle, {
        force,
        onStart: (asset) => {
          started += 1
          console.log(`[ProxyCache] ${label} ${started}/${expectedTotal}: ${asset?.name || asset?.id}`)
          setProxyGenerationProgress((prev) => ({
            current: started,
            total: Math.max(prev.total, started),
          }))
        },
      })
      console.log(`[ProxyCache] ${label} complete:`, summary)
    } finally {
      setGeneratingProxies(false)
      setProxyGenerationMode('missing')
      setProxyGenerationProgress({ current: 0, total: 0 })
    }
  }, [currentProjectHandle, generatingProxies])
  const shouldAutoGenerateProxy = useMemo(
    () => shouldAutoGeneratePreviewProxy({ clips, tracks, transitions }),
    [clips, tracks, transitions]
  )
  const currentSignature = useMemo(
    () => computePreviewSignature(currentTimelineId, {
      clips,
      tracks,
      transitions,
      duration: timelineDuration,
      timelineFps,
      assets,
    }),
    [currentTimelineId, clips, tracks, transitions, timelineDuration, timelineFps, assets]
  )
  const useProxyPlayback = Boolean(
    previewProxyPath &&
    previewProxySignature &&
    currentSignature === previewProxySignature
  )
  const lastAutoProxySignatureRef = useRef(null)
  const forceAutoProxyRefreshRef = useRef(false)
  const [proxyVideoUrl, setProxyVideoUrl] = useState(null)
  const proxyVideoRef = useRef(null)
  const chunkVideoRef = useRef(null)
  const chunkCacheAbortRef = useRef(null)
  const [previewChunks, setPreviewChunks] = useState([])
  const previewChunksRef = useRef([])
  const [chunkCacheState, setChunkCacheState] = useState({
    busy: false,
    progress: 0,
    status: '',
    error: null,
    cachedCount: 0,
    totalCount: 0,
    currentRangeLabel: '',
  })
  const runSmoothPreviewRender = useCallback(async ({ force = true, reason = 'manual' } = {}) => {
    if (!currentProjectHandle || !currentTimelineId || !window.electronAPI) {
      return { error: 'Preview cache is unavailable.' }
    }

    const timelineState = useTimelineStore.getState()
    if (timelineState.previewProxyStatus === 'generating') {
      return { skipped: true }
    }

    setPreviewProxyGenerating()
    const result = await renderPreviewProxy(({ progress }) => {
      useTimelineStore.getState().setPreviewProxyProgress(progress)
    }, { force })

    if (result?.path && result?.url) {
      // Avoid enabling a stale proxy when timeline changed while rendering.
      const latestSignature = computePreviewSignature(currentTimelineId, useTimelineStore.getState())
      const renderedSignature = result.signature || latestSignature
      if (renderedSignature !== latestSignature) {
        useTimelineStore.getState().setPreviewProxyInvalid()
        return { ...result, stale: true }
      }
      setPreviewProxyReady(result.path, renderedSignature)
      setProxyVideoUrl(result.url)
      return result
    }

    useTimelineStore.getState().setPreviewProxyInvalid()
    if (result?.error) {
      console.warn(`[PreviewCache:${reason}]`, result.error)
    }
    return result
  }, [currentProjectHandle, currentTimelineId, setPreviewProxyGenerating, setPreviewProxyReady])

  useEffect(() => {
    previewChunksRef.current = previewChunks
  }, [previewChunks])

  useEffect(() => {
    setPreviewChunks((chunks) => chunks.filter((chunk) => chunk.signature === currentSignature))
  }, [currentSignature])

  const buildPreviewChunkRanges = useCallback(() => {
    const timelineEnd = Math.max(0, Number(getTimelineEndTime?.()) || Number(timelineDuration) || 0)
    if (timelineEnd <= 0) return []
    const currentChunkStart = Math.floor((Number(playheadPosition) || 0) / PREVIEW_CHUNK_DURATION) * PREVIEW_CHUNK_DURATION
    const firstStart = Math.max(0, currentChunkStart)
    const ranges = []
    for (let index = 0; index < PREVIEW_CHUNK_COUNT; index += 1) {
      const rangeStart = firstStart + index * PREVIEW_CHUNK_DURATION
      if (rangeStart >= timelineEnd - PREVIEW_CHUNK_EPSILON) break
      const rangeEnd = Math.min(timelineEnd, rangeStart + PREVIEW_CHUNK_DURATION)
      if (rangeEnd - rangeStart > PREVIEW_CHUNK_EPSILON) {
        ranges.push({ rangeStart, rangeEnd })
      }
    }
    return ranges
  }, [getTimelineEndTime, playheadPosition, timelineDuration])

  const previewChunkPlan = useMemo(() => {
    const ranges = buildPreviewChunkRanges()
    const totalSeconds = ranges.reduce((sum, range) => sum + Math.max(0, range.rangeEnd - range.rangeStart), 0)
    return {
      ranges,
      totalSeconds,
      label: totalSeconds > 0 ? `Cache nearby ${Math.round(totalSeconds)}s` : 'Cache nearby',
    }
  }, [buildPreviewChunkRanges])

  const runPreviewChunkCache = useCallback(async () => {
    if (chunkCacheState.busy) return
    if (!currentProjectHandle || !currentTimelineId || !window.electronAPI) {
      setChunkCacheState({
        busy: false,
        progress: 0,
        status: '',
        error: 'Preview chunks are available in the desktop app only.',
        cachedCount: 0,
        totalCount: 0,
        currentRangeLabel: '',
      })
      return
    }

    const ranges = buildPreviewChunkRanges()
    if (ranges.length === 0) {
      setChunkCacheState({
        busy: false,
        progress: 0,
        status: '',
        error: 'No timeline range to cache.',
        cachedCount: 0,
        totalCount: 0,
        currentRangeLabel: '',
      })
      return
    }

    const abortController = new AbortController()
    chunkCacheAbortRef.current = abortController
    setChunkCacheState({
      busy: true,
      progress: 0,
      status: `Caching ${ranges.length} nearby preview chunk${ranges.length === 1 ? '' : 's'}...`,
      error: null,
      cachedCount: 0,
      totalCount: ranges.length,
      currentRangeLabel: formatPreviewChunkRange(ranges[0]),
    })

    let completed = 0
    for (let index = 0; index < ranges.length; index += 1) {
      if (abortController.signal.aborted) break
      const range = ranges[index]
      const rangeLabel = formatPreviewChunkRange(range)
      const existing = previewChunksRef.current.find((chunk) => (
        chunk.signature === currentSignature
        && isSamePreviewChunkRange(chunk, range)
        && chunk.url
      ))
      if (existing) {
        completed += 1
        setChunkCacheState({
          busy: true,
          progress: Math.round((completed / ranges.length) * 100),
          status: `Preview chunk ${completed}/${ranges.length} already cached`,
          error: null,
          cachedCount: completed,
          totalCount: ranges.length,
          currentRangeLabel: rangeLabel,
        })
        continue
      }

      setChunkCacheState({
        busy: true,
        progress: Math.round((index / ranges.length) * 100),
        status: `Caching preview chunk ${index + 1}/${ranges.length} (${rangeLabel})`,
        error: null,
        cachedCount: completed,
        totalCount: ranges.length,
        currentRangeLabel: rangeLabel,
      })

      const result = await renderPreviewChunk(
        range.rangeStart,
        range.rangeEnd,
        ({ progress }) => {
          const chunkProgress = Number.isFinite(progress) ? progress : 0
          setChunkCacheState({
            busy: true,
            progress: Math.round(((index + chunkProgress / 100) / ranges.length) * 100),
            status: `Caching preview chunk ${index + 1}/${ranges.length} (${rangeLabel})`,
            error: null,
            cachedCount: completed,
            totalCount: ranges.length,
            currentRangeLabel: rangeLabel,
          })
        },
        {
          force: false,
          signal: abortController.signal,
          useProxyMedia: useProxyPlaybackForAssets,
          glslQualityScale: getGlslPreviewQualityScale(glslPreviewQuality),
        }
      )

      if (!result?.path || !result?.url) {
        const wasCancelled = abortController.signal.aborted || /cancel/i.test(result?.error || '')
        setChunkCacheState({
          busy: false,
          progress: Math.round((completed / ranges.length) * 100),
          status: wasCancelled ? `Stopped after ${completed}/${ranges.length} cached chunk${completed === 1 ? '' : 's'}.` : '',
          error: wasCancelled ? null : (result?.error || 'Preview chunk render failed.'),
          cachedCount: completed,
          totalCount: ranges.length,
          currentRangeLabel: rangeLabel,
        })
        if (chunkCacheAbortRef.current === abortController) chunkCacheAbortRef.current = null
        return
      }

      const latestSignature = computePreviewSignature(currentTimelineId, useTimelineStore.getState())
      if (result.signature !== latestSignature) {
        setChunkCacheState({
          busy: false,
          progress: Math.round((completed / ranges.length) * 100),
          status: '',
          error: 'Timeline changed while caching. Cache those chunks again when ready.',
          cachedCount: completed,
          totalCount: ranges.length,
          currentRangeLabel: rangeLabel,
        })
        if (chunkCacheAbortRef.current === abortController) chunkCacheAbortRef.current = null
        return
      }

      const nextChunk = {
        path: result.path,
        url: result.url,
        signature: result.signature,
        rangeStart: result.rangeStart,
        rangeEnd: result.rangeEnd,
      }
      setPreviewChunks((chunks) => upsertPreviewChunk(chunks, nextChunk))
      completed += 1
      setChunkCacheState({
        busy: true,
        progress: Math.round((completed / ranges.length) * 100),
        status: `Cached preview chunk ${completed}/${ranges.length} (${rangeLabel})`,
        error: null,
        cachedCount: completed,
        totalCount: ranges.length,
        currentRangeLabel: rangeLabel,
      })
    }

    if (chunkCacheAbortRef.current === abortController) chunkCacheAbortRef.current = null
    setChunkCacheState({
      busy: false,
      progress: 100,
      status: abortController.signal.aborted
        ? `Stopped after ${completed}/${ranges.length} cached chunk${completed === 1 ? '' : 's'}.`
        : `Cached ${completed} nearby preview chunk${completed === 1 ? '' : 's'}.`,
      error: null,
      cachedCount: completed,
      totalCount: ranges.length,
      currentRangeLabel: '',
    })
  }, [
    buildPreviewChunkRanges,
    chunkCacheState.busy,
    currentProjectHandle,
    currentSignature,
    currentTimelineId,
    glslPreviewQuality,
    useProxyPlaybackForAssets,
  ])

  const activePreviewChunk = useMemo(() => {
    if (useProxyPlayback) return null
    return previewChunks.find((chunk) => (
      chunk.signature === currentSignature
      && chunk.url
      && playheadPosition >= chunk.rangeStart - PREVIEW_CHUNK_EPSILON
      && playheadPosition < chunk.rangeEnd - PREVIEW_CHUNK_EPSILON
    )) || null
  }, [currentSignature, playheadPosition, previewChunks, useProxyPlayback])

  const stopPreviewChunkCache = useCallback(() => {
    chunkCacheAbortRef.current?.abort()
    setChunkCacheState((prev) => ({
      ...prev,
      status: 'Stopping preview chunk cache...',
      error: null,
    }))
  }, [])

  useEffect(() => () => {
    chunkCacheAbortRef.current?.abort()
  }, [])

  // If timeline changed, mark proxy state invalid so status stays accurate.
  useEffect(() => {
    if (
      previewProxyStatus === 'ready' &&
      previewProxySignature &&
      currentSignature !== previewProxySignature
    ) {
      forceAutoProxyRefreshRef.current = true
      lastAutoProxySignatureRef.current = null
      setPreviewProxyInvalid()
    }
  }, [previewProxyStatus, previewProxySignature, currentSignature, setPreviewProxyInvalid])

  // Auto-generate smooth preview when timeline is heavy and idle.
  useEffect(() => {
    if (!autoSmoothPreviewEnabled) return
    if (!window.electronAPI || !currentProjectHandle || !currentTimelineId) return
    if (previewMode !== 'timeline') return
    if (timelineIsPlaying) return
    if (clips.length === 0) return
    const shouldForceRefresh = forceAutoProxyRefreshRef.current
    if (!shouldAutoGenerateProxy && !shouldForceRefresh) return
    if (useProxyPlayback) return
    if (previewProxyStatus === 'generating') return
    if (!shouldForceRefresh && lastAutoProxySignatureRef.current === currentSignature) return

    const timer = setTimeout(() => {
      const triggerReason = forceAutoProxyRefreshRef.current ? 'stale-refresh' : 'auto'
      if (forceAutoProxyRefreshRef.current) {
        forceAutoProxyRefreshRef.current = false
      }
      lastAutoProxySignatureRef.current = currentSignature
      void runSmoothPreviewRender({ force: false, reason: triggerReason })
    }, 1200)

    return () => clearTimeout(timer)
  }, [
    autoSmoothPreviewEnabled,
    currentProjectHandle,
    currentTimelineId,
    previewMode,
    timelineIsPlaying,
    clips.length,
    shouldAutoGenerateProxy,
    useProxyPlayback,
    previewProxyStatus,
    currentSignature,
    runSmoothPreviewRender,
  ])

  useEffect(() => {
    if (!currentProjectHandle || !currentTimelineId || previewProxyStatus !== 'ready') {
      setProxyVideoUrl(null)
      return
    }
    let cancelled = false
    getPreviewProxyPath(currentProjectHandle, currentTimelineId).then((result) => {
      if (!cancelled && result?.url) setProxyVideoUrl(result.url)
      else if (!cancelled) setProxyVideoUrl(null)
    })
    return () => { cancelled = true }
  }, [currentProjectHandle, currentTimelineId, previewProxyStatus, previewProxyPath])
  // Sync proxy video with playhead and playback
  useEffect(() => {
    if (!proxyVideoRef.current || !proxyVideoUrl) return
    const video = proxyVideoRef.current
    if (timelineIsPlaying) {
      video.play().catch(() => {})
    } else {
      video.pause()
      setPlayheadPosition(video.currentTime, { snap: true })
    }
  }, [timelineIsPlaying, proxyVideoUrl, setPlayheadPosition])
  useEffect(() => {
    if (!proxyVideoRef.current || !proxyVideoUrl || timelineIsPlaying) return
    proxyVideoRef.current.currentTime = playheadPosition
  }, [playheadPosition, proxyVideoUrl, timelineIsPlaying])

  useEffect(() => {
    if (!chunkVideoRef.current || !activePreviewChunk?.url) return
    const video = chunkVideoRef.current
    const chunkTime = Math.max(0, playheadPosition - activePreviewChunk.rangeStart)
    if (Math.abs((video.currentTime || 0) - chunkTime) > 0.08) {
      video.currentTime = chunkTime
    }
    if (timelineIsPlaying) {
      video.play().catch(() => {})
    } else {
      video.pause()
    }
  }, [activePreviewChunk, playheadPosition, timelineIsPlaying])
  
  // Register video ref with store (for asset preview mode - only for video assets)
  // Use a timeout to ensure the video element is mounted after switching previews
  useEffect(() => {
    // Only register video ref for video assets (not masks or images)
    const isVideoAsset = currentPreview && currentPreview.type !== 'mask' && currentPreview.type !== 'image'
    
    if (previewMode === 'asset' && isVideoAsset) {
      // Use a small timeout to ensure video element is mounted after state change
      const timeoutId = setTimeout(() => {
        if (videoRefA.current) {
          registerVideoRef(videoRefA.current)
          videoRefA.current.volume = volume
        }
      }, 0)
      return () => {
        clearTimeout(timeoutId)
        registerVideoRef(null)
      }
    } else {
      // Clear ref for non-video assets so togglePlay knows to handle them differently
      registerVideoRef(null)
    }
  }, [registerVideoRef, volume, previewMode, currentPreview])

  // Get all active video clips at current playhead position (for overlay display only)
  useEffect(() => {
    if (previewMode !== 'timeline') {
      setActiveLayerClips([])
      return
    }
    
    // Get all video clips at current time (video tracks only)
    const allActiveClips = getActiveClipsAtTime(playheadPosition)
    const videoClips = allActiveClips.filter(({ track }) => track.type === 'video')
    
    // Sort by track index (higher index = lower in stack, first rendered)
    // We want Video 1 on top of Video 2, so reverse the natural order
    const sortedClips = [...videoClips].sort((a, b) => {
      const indexA = tracks.findIndex(t => t.id === a.track.id)
      const indexB = tracks.findIndex(t => t.id === b.track.id)
      return indexB - indexA // Video 2 renders first (behind), Video 1 renders last (on top)
    })
    
    setActiveLayerClips(sortedClips)
  }, [previewMode, playheadPosition, getActiveClipsAtTime, tracks, clips])

  const activeLayerClipById = useMemo(() => {
    const map = new Map()
    activeLayerClips.forEach(({ clip, track }) => {
      map.set(clip.id, { clip, track })
    })
    return map
  }, [activeLayerClips])

  const selectedPreviewClip = useMemo(() => {
    if (previewMode !== 'timeline') return null
    const selectedId = selectedClipIds?.[0]
    if (!selectedId) return null
    const activeEntry = activeLayerClipById.get(selectedId)
    if (!activeEntry) return null
    if (!['video', 'image', 'text'].includes(activeEntry.clip?.type)) return null
    return clips.find(c => c.id === selectedId) || activeEntry.clip
  }, [previewMode, selectedClipIds, activeLayerClipById, clips])

  const selectedPreviewClipId = selectedPreviewClip?.id || null
  const selectedPreviewClipStartTime = selectedPreviewClip?.startTime || 0
  const selectedPreviewScaleLinked = selectedPreviewClip?.transform?.scaleLinked === true
  const selectedPreviewClipTime = selectedPreviewClip
    ? playheadPosition - selectedPreviewClipStartTime
    : 0
  const canShowPreviewTransformControls = previewMode === 'timeline' && !!selectedPreviewClip

  useEffect(() => {
    if (previewTransformHistoryClipRef.current !== selectedPreviewClipId) {
      previewTransformHistoryClipRef.current = null
    }
  }, [selectedPreviewClipId])

  const selectedPreviewTransform = useMemo(() => {
    if (!selectedPreviewClip) return null
    const animated = getAnimatedTransform(selectedPreviewClip, selectedPreviewClipTime)
    if (animated) return animated
    return getClipTransform(selectedPreviewClip)
  }, [selectedPreviewClip, selectedPreviewClipTime, getClipTransform])

  const applyPreviewTransformUpdate = useCallback((updates, finalize = false) => {
    if (!selectedPreviewClipId || !updates || typeof updates !== 'object') return
    const entries = Object.entries(updates)
    if (entries.length === 0) return

    const nextUpdates = {}
    for (const [key, value] of entries) {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) continue
        nextUpdates[key] = value
      } else if (typeof value === 'boolean') {
        nextUpdates[key] = value
      }
    }

    if (selectedPreviewScaleLinked) {
      if ('scaleX' in nextUpdates && !('scaleY' in nextUpdates)) {
        nextUpdates.scaleY = nextUpdates.scaleX
      } else if ('scaleY' in nextUpdates && !('scaleX' in nextUpdates)) {
        nextUpdates.scaleX = nextUpdates.scaleY
      }
    }

    const updateKeys = Object.keys(nextUpdates)
    if (updateKeys.length === 0) return

    const hasChanges = updateKeys.some((property) => selectedPreviewTransform?.[property] !== nextUpdates[property])
    if (!hasChanges) {
      if (finalize) {
        previewTransformHistoryClipRef.current = null
      }
      return
    }

    if (previewTransformHistoryClipRef.current !== selectedPreviewClipId) {
      saveToHistory()
      previewTransformHistoryClipRef.current = selectedPreviewClipId
    }

    const clipTime = playheadPosition - selectedPreviewClipStartTime
    updateClipTransform(selectedPreviewClipId, nextUpdates, false)
    updateKeys.forEach((property) => {
      if (hasKeyframes(selectedPreviewClipId, property)) {
        setKeyframe(selectedPreviewClipId, property, clipTime, nextUpdates[property], 'easeInOut', { saveHistory: false })
      }
    })
    if (finalize) {
      previewTransformHistoryClipRef.current = null
    }
  }, [selectedPreviewClipId, selectedPreviewScaleLinked, selectedPreviewTransform, playheadPosition, selectedPreviewClipStartTime, saveToHistory, updateClipTransform, hasKeyframes, setKeyframe])

  const handlePreviewTransformChange = useCallback((updates) => {
    applyPreviewTransformUpdate(updates)
  }, [applyPreviewTransformUpdate])

  const handlePreviewTransformCommit = useCallback((updates) => {
    applyPreviewTransformUpdate(updates, true)
  }, [applyPreviewTransformUpdate])

  const handlePreviewTransformInteractionStart = useCallback(() => {
    previewTransformHistoryClipRef.current = null
    if (timelineIsPlaying) {
      timelineTogglePlay()
    }
  }, [timelineIsPlaying, timelineTogglePlay])

  // NOTE: Video sync is now handled by VideoLayerRenderer component

  // Get transition styles based on type
  // Uses will-change to hint GPU acceleration and backface-visibility for smoother rendering
  const getTransitionStyles = (transitionInfo, isVideoA) => {
    if (!transitionInfo) {
      return isVideoA ? { opacity: 1 } : { opacity: 0, display: 'none' }
    }
    
    const { transition, progress } = transitionInfo
    const type = transition?.type || 'dissolve'
    const zoomAmount = transition?.settings?.zoomAmount ?? 0.1
    const blurAmount = transition?.settings?.blurAmount ?? 8
    const edgeMode = transition?.kind === 'edge'
    const edge = transitionInfo?.edge
    const effectiveIsVideoA = edgeMode ? edge === 'out' : isVideoA
    
    // Base styles for GPU-accelerated rendering
    const baseStyles = {
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      willChange: 'opacity, transform, clip-path',
      backfaceVisibility: 'hidden',
    }
    
    // Edge transitions: apply to a single clip (in or out)
    if (edgeMode && (type === 'fade-black' || type === 'fade-white')) {
      const opacity = effectiveIsVideoA ? 1 - progress : progress
      return { ...baseStyles, opacity, zIndex: effectiveIsVideoA ? 1 : 2 }
    }
    
    // Video A is outgoing, Video B is incoming
    if (effectiveIsVideoA) {
      switch (type) {
        case 'dissolve':
          // Keep outgoing clip at full opacity and fade incoming on top.
          // If both clips are faded, source-over compositing causes a brightness dip mid-transition.
          return { ...baseStyles, opacity: 1, zIndex: 1 }
        case 'fade-black':
        case 'fade-white':
          // Fade out to color then fade in
          return { ...baseStyles, opacity: progress < 0.5 ? 1 - progress * 2 : 0, zIndex: 1 }
        case 'wipe-left':
          return { ...baseStyles, clipPath: `inset(0 ${progress * 100}% 0 0)`, zIndex: 2 }
        case 'wipe-right':
          return { ...baseStyles, clipPath: `inset(0 0 0 ${progress * 100}%)`, zIndex: 2 }
        case 'wipe-up':
          return { ...baseStyles, clipPath: `inset(0 0 ${progress * 100}% 0)`, zIndex: 2 }
        case 'wipe-down':
          return { ...baseStyles, clipPath: `inset(${progress * 100}% 0 0 0)`, zIndex: 2 }
        case 'slide-left':
          return { ...baseStyles, transform: `translateX(-${progress * 100}%)`, zIndex: 2 }
        case 'slide-right':
          return { ...baseStyles, transform: `translateX(${progress * 100}%)`, zIndex: 2 }
        case 'slide-up':
          return { ...baseStyles, transform: `translateY(-${progress * 100}%)`, zIndex: 2 }
        case 'slide-down':
          return { ...baseStyles, transform: `translateY(${progress * 100}%)`, zIndex: 2 }
        case 'zoom-in':
          return { ...baseStyles, transform: `scale(${1 + progress * zoomAmount})`, opacity: 1 - progress, zIndex: 1 }
        case 'zoom-out':
          return { ...baseStyles, transform: `scale(${1 - progress * zoomAmount})`, opacity: 1 - progress, zIndex: 1 }
        case 'blur':
          return { ...baseStyles, filter: `blur(${progress * blurAmount}px)`, opacity: 1 - progress, zIndex: 1 }
        default:
          return { ...baseStyles, opacity: 1 - progress, zIndex: 1 }
      }
    } else {
      // Video B (incoming)
      switch (type) {
        case 'dissolve':
          return { ...baseStyles, opacity: progress, zIndex: 2 }
        case 'fade-black':
        case 'fade-white':
          // Fade in from color
          return { ...baseStyles, opacity: progress > 0.5 ? (progress - 0.5) * 2 : 0, zIndex: 2 }
        case 'wipe-left':
          return { ...baseStyles, clipPath: `inset(0 0 0 ${(1 - progress) * 100}%)`, zIndex: 1 }
        case 'wipe-right':
          return { ...baseStyles, clipPath: `inset(0 ${(1 - progress) * 100}% 0 0)`, zIndex: 1 }
        case 'wipe-up':
          return { ...baseStyles, clipPath: `inset(${(1 - progress) * 100}% 0 0 0)`, zIndex: 1 }
        case 'wipe-down':
          return { ...baseStyles, clipPath: `inset(0 0 ${(1 - progress) * 100}% 0)`, zIndex: 1 }
        case 'slide-left':
          return { ...baseStyles, transform: `translateX(${(1 - progress) * 100}%)`, zIndex: 1 }
        case 'slide-right':
          return { ...baseStyles, transform: `translateX(-${(1 - progress) * 100}%)`, zIndex: 1 }
        case 'slide-up':
          return { ...baseStyles, transform: `translateY(${(1 - progress) * 100}%)`, zIndex: 1 }
        case 'slide-down':
          return { ...baseStyles, transform: `translateY(-${(1 - progress) * 100}%)`, zIndex: 1 }
        case 'zoom-in':
          return { ...baseStyles, transform: `scale(${1 - zoomAmount + progress * zoomAmount})`, opacity: progress, zIndex: 2 }
        case 'zoom-out':
          return { ...baseStyles, transform: `scale(${1 + zoomAmount - progress * zoomAmount})`, opacity: progress, zIndex: 2 }
        case 'blur':
          return { ...baseStyles, filter: `blur(${(1 - progress) * blurAmount}px)`, opacity: progress, zIndex: 2 }
        default:
          return { ...baseStyles, opacity: progress, zIndex: 2 }
      }
    }
  }
  
  // Get transition overlay (for fade to color)
  const getTransitionOverlay = (transitionInfo) => {
    if (!transitionInfo) return null
    
    const { transition, progress } = transitionInfo
    const type = transition?.type
    const edgeMode = transition?.kind === 'edge'
    const edge = transitionInfo?.edge
    
    if (edgeMode && (type === 'fade-black' || type === 'fade-white')) {
      const overlayOpacity = edge === 'in' ? (1 - progress) : progress
      return (
        <div
          className={`absolute inset-0 pointer-events-none z-10 ${type === 'fade-black' ? 'bg-black' : 'bg-white'}`}
          style={{ opacity: overlayOpacity }}
        />
      )
    }
    
    if (type === 'fade-black') {
      const overlayOpacity = progress < 0.5 ? progress * 2 : (1 - progress) * 2
      return (
        <div 
          className="absolute inset-0 bg-black pointer-events-none z-10"
          style={{ opacity: overlayOpacity }}
        />
      )
    }
    
    if (type === 'fade-white') {
      const overlayOpacity = progress < 0.5 ? progress * 2 : (1 - progress) * 2
      return (
        <div 
          className="absolute inset-0 bg-white pointer-events-none z-10"
          style={{ opacity: overlayOpacity }}
        />
      )
    }
    
    return null
  }

  // Switch to timeline mode when timeline playback starts
  useEffect(() => {
    if (timelineIsPlaying && clips.length > 0) {
      setPreviewMode('timeline')
    }
  }, [timelineIsPlaying, clips.length, setPreviewMode])
  
  // When first clip is added, switch to timeline mode
  useEffect(() => {
    if (clips.length > 0 && previewMode === 'asset' && !currentPreview) {
      setPreviewMode('timeline')
    }
  }, [clips.length, previewMode, currentPreview, setPreviewMode])
  
  // Fullscreen toggle
  const toggleFullscreen = useCallback(async () => {
    if (!panelRef.current) return
    
    try {
      if (!document.fullscreenElement) {
        await panelRef.current.requestFullscreen()
      } else {
        await document.exitFullscreen()
      }
    } catch (err) {
      console.error('Fullscreen error:', err)
    }
  }, [])
  
  // Listen for fullscreen changes (including ESC key)
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])
  
  // Handle add to timeline
  const handleAddToTimeline = () => {
    if (currentPreview) {
      addClip('video-1', currentPreview, null, timelineSettings?.fps)
      setJustAdded(true)
      setTimeout(() => setJustAdded(false), 2000)
    }
  }

  // Handle video time update (asset mode)
  const handleTimeUpdate = () => {
    if (videoRefA.current && previewMode === 'asset') {
      setAssetCurrentTime(videoRefA.current.currentTime)
    }
  }

  // Handle video loaded (asset mode)
  const handleLoadedMetadata = () => {
    if (videoRefA.current && previewMode === 'asset') {
      setAssetDuration(videoRefA.current.duration)
      // Register the video ref now that it's loaded and ready
      registerVideoRef(videoRefA.current)
      videoRefA.current.volume = volume
    }
  }

  // Handle video end (asset mode) - stop at end, don't loop
  const handleEnded = () => {
    if (previewMode === 'asset') {
      setAssetIsPlaying(false)
      // Don't reset to 0, stay at the end so user can see final frame
    }
  }

  // Computed values based on mode
  const isPlaying = previewMode === 'timeline' ? timelineIsPlaying : assetIsPlaying
  const currentTime = previewMode === 'timeline' ? playheadPosition : assetCurrentTime
  const duration = previewMode === 'timeline' ? endTime : assetDuration
  const togglePlay = previewMode === 'timeline' ? timelineTogglePlay : assetTogglePlay
  const seekTo = previewMode === 'timeline' 
    ? (time) => setPlayheadPosition(Math.max(0, Math.min(endTime, time)), { snap: true })
    : assetSeekTo

  // Check if we have content to show
  const hasContent = previewMode === 'timeline' 
    ? (clips.length > 0)
    : (currentPreview !== null)

  const previewFps = useMemo(() => {
    if (!currentPreview) return null
    const rawFps = currentPreview.settings?.fps ?? currentPreview.fps
    const parsed = Number(rawFps)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }, [currentPreview])

  const previewFpsLabel = useMemo(() => {
    if (!previewFps) return null
    return previewFps % 1 === 0 ? String(previewFps) : previewFps.toFixed(2)
  }, [previewFps])

  // When a new asset preview is set, reset video to start and pause
  // (DaVinci Resolve behavior - asset selected shows at start, paused)
  // Capture the current frame before switching to prevent black flicker
  useEffect(() => {
    if (currentPreview && previewMode === 'asset') {
      // Reset mask frame for mask previews
      if (currentPreview.type === 'mask') {
        setMaskFrame(0)
        setAssetIsPlaying(false)
        setAssetCurrentTime(0)
      } else if (videoRefA.current) {
        // Capture current frame to canvas before changing source (prevents black flicker)
        const video = videoRefA.current
        if (video.readyState >= 2 && video.videoWidth > 0 && holdFrameCanvasRef.current) {
          const canvas = holdFrameCanvasRef.current
          canvas.width = video.videoWidth
          canvas.height = video.videoHeight
          const ctx = canvas.getContext('2d')
          ctx.drawImage(video, 0, 0)
          setShowHoldFrame(true)
        }
        
        // Reset to start, paused - user controls playback
        video.pause()
        video.currentTime = 0
        setAssetIsPlaying(false)
        setAssetCurrentTime(0)
      }
    }
    // Reset zoom/pan when preview changes
    setZoom('fit')
    setPan({ x: 0, y: 0 })
  }, [currentPreview, setAssetIsPlaying, setAssetCurrentTime, previewMode])
  
  // Hide the hold frame once the new video has loaded its first frame
  const handleLoadedData = useCallback(() => {
    // Small delay to ensure the frame is actually painted
    requestAnimationFrame(() => {
      setShowHoldFrame(false)
    })
  }, [])
  
  // Ref to track if we're updating mask time internally
  const maskTimeUpdateRef = useRef(false)
  
  // Sync mask frame when assetCurrentTime changes externally (from transport controls seeking)
  useEffect(() => {
    if (currentPreview?.type === 'mask' && !maskTimeUpdateRef.current && maskDuration > 0) {
      const fps = 24
      const totalFrames = currentPreview.maskFrames?.length || 1
      const expectedFrame = Math.min(Math.floor(assetCurrentTime * fps), totalFrames - 1)
      if (expectedFrame !== maskFrame && expectedFrame >= 0) {
        setMaskFrame(expectedFrame)
      }
    }
    maskTimeUpdateRef.current = false
  }, [assetCurrentTime, currentPreview, maskDuration, maskFrame])
  
  // Handle mask time updates (from playback) - sets the ref to avoid re-syncing
  const handleMaskTimeUpdate = useCallback((time) => {
    maskTimeUpdateRef.current = true
    setAssetCurrentTime(time)
  }, [setAssetCurrentTime])
  
  // Handle mask duration set - stable callback to avoid infinite loops
  const handleMaskDurationSet = useCallback((dur) => {
    setMaskDuration(dur)
    setAssetDuration(dur)
  }, [setAssetDuration])
  
  // Handle mask playback ended
  const handleMaskEnded = useCallback(() => {
    setAssetIsPlaying(false)
  }, [setAssetIsPlaying])
  
  // Reset view to center
  const resetView = useCallback(() => {
    setZoom('fit')
    setPan({ x: 0, y: 0 })
  }, [])
  
  // Zoom in/out functions
  const zoomIn = useCallback(() => {
    setZoom(prev => {
      const current = prev === 'fit' ? 100 : prev
      return Math.min(400, current + 25)
    })
  }, [])
  
  const zoomOut = useCallback(() => {
    setZoom(prev => {
      const current = prev === 'fit' ? 100 : prev
      const newZoom = current - 25
      if (newZoom <= 25) return 'fit'
      return newZoom
    })
  }, [])
  
  // Handle keyboard events for spacebar and ctrl
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't capture when typing in inputs (use activeElement so prompt/search work)
      const active = document.activeElement
      if (active && (['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.isContentEditable)) return
      
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault()
        setIsSpaceHeld(true)
      }
      if (e.key === 'Control') {
        setIsCtrlHeld(true)
      }
    }
    
    const handleKeyUp = (e) => {
      if (e.code === 'Space') {
        setIsSpaceHeld(false)
        setIsPanning(false)
        setIsZooming(false)
      }
      if (e.key === 'Control') {
        setIsCtrlHeld(false)
        setIsZooming(false)
      }
    }
    
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])
  
  // Handle mouse events for panning and zooming
  const handleMouseDown = useCallback((e) => {
    if (isSpaceHeld && isCtrlHeld) {
      // Start zooming with mouse drag
      e.preventDefault()
      setIsZooming(true)
      setDragStart({ x: e.clientX, y: e.clientY })
      setZoomStart(zoom === 'fit' ? 100 : zoom)
    } else if (isSpaceHeld) {
      // Start panning
      e.preventDefault()
      setIsPanning(true)
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y })
    }
  }, [isSpaceHeld, isCtrlHeld, pan, zoom])
  
  const handleMouseMove = useCallback((e) => {
    if (isZooming) {
      // Zoom based on horizontal mouse movement (right = zoom in, left = zoom out)
      const deltaX = e.clientX - dragStart.x
      const zoomChange = deltaX * 0.5 // Adjust sensitivity
      const newZoom = Math.max(10, Math.min(400, zoomStart + zoomChange))
      setZoom(Math.round(newZoom))
    } else if (isPanning) {
      setPan({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      })
    }
  }, [isZooming, isPanning, dragStart, zoomStart])
  
  const handleMouseUp = useCallback(() => {
    setIsPanning(false)
    setIsZooming(false)
  }, [])

  const handlePreviewClipPointerDown = useCallback((clip, e) => {
    if (!clip || previewMode !== 'timeline') return
    if (isSpaceHeld || isPanning || isZooming) return
    if (e.button !== 0) return
    e.stopPropagation()
    const isShiftHeld = e.shiftKey
    const isCtrlHeld = e.ctrlKey || e.metaKey
    selectClip(clip.id, {
      addToSelection: isShiftHeld,
      toggleSelection: isCtrlHeld,
    })
  }, [previewMode, isSpaceHeld, isPanning, isZooming, selectClip])

  const handlePreviewTextDoubleClick = useCallback((clip, e) => {
    if (!clip || clip.type !== 'text' || previewMode !== 'timeline') return
    if (isSpaceHeld || isPanning || isZooming) return
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    selectClip(clip.id)
    requestTextEdit(clip.id, { selectAll: true })
  }, [previewMode, isSpaceHeld, isPanning, isZooming, requestTextEdit, selectClip])
  
  // Handle mouse wheel for zooming
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    
    // Determine zoom direction (scroll up = zoom in, scroll down = zoom out)
    const delta = -e.deltaY
    const zoomStep = 10 // Zoom step per scroll tick
    
    setZoom(prev => {
      const current = prev === 'fit' ? 100 : prev
      let newZoom = current + (delta > 0 ? zoomStep : -zoomStep)
      
      // Clamp zoom between 10% and 400%
      newZoom = Math.max(10, Math.min(400, newZoom))
      
      return Math.round(newZoom)
    })
  }, [])
  
  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = () => {
      setShowZoomDropdown(false)
      setShowGuidesDropdown(false)
    }
    if (showZoomDropdown || showGuidesDropdown) {
      document.addEventListener('click', handleClickOutside)
      return () => document.removeEventListener('click', handleClickOutside)
    }
  }, [showZoomDropdown, showGuidesDropdown])
  
  // Get zoom display label
  const getZoomLabel = () => {
    if (zoom === 'fit') return 'Fit'
    return `${zoom}%`
  }
  
  // Format time as MM:SS
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  const formatCaptureTimecode = useCallback((seconds) => {
    const fps = Math.max(1, Math.round(Number(timelineFps) || 24))
    const totalFrames = Math.max(0, Math.round(Number(seconds || 0) * fps))
    const hours = Math.floor(totalFrames / (fps * 3600))
    const minutes = Math.floor((totalFrames % (fps * 3600)) / (fps * 60))
    const secs = Math.floor((totalFrames % (fps * 60)) / fps)
    const frames = totalFrames % fps
    return [hours, minutes, secs, frames].map((value) => String(value).padStart(2, '0')).join('-')
  }, [timelineFps])

  const handleCaptureStill = useCallback(async () => {
    if (previewMode !== 'timeline' || capturingStillFrame) return

    const top = getTopmostVideoOrImageClipAtTime(playheadPosition)
    if (!top) return

    setContextMenu(null)
    setCapturingStillFrame(true)

    try {
      const result = await captureTimelineFrameAt(playheadPosition)
      if (!result?.file) return

      const captureTimecode = formatCaptureTimecode(playheadPosition)
      const fileName = `timeline_still_${captureTimecode}.png`
      const stillFile = new File([result.file], fileName, {
        type: result.file.type || 'image/png',
        lastModified: Date.now(),
      })
      const previewUrl = result.blobUrl || URL.createObjectURL(stillFile)
      const displayName = `Still ${captureTimecode.replace(/-/g, ':')}`

      if (currentProjectHandle) {
        const assetInfo = await importAsset(currentProjectHandle, stillFile, 'images')
        addAsset({
          ...assetInfo,
          name: displayName,
          type: 'image',
          url: previewUrl,
          isImported: true,
          settings: {
            capturedAt: playheadPosition,
            source: 'timeline-still',
          },
        })
      } else {
        addAsset({
          name: displayName,
          type: 'image',
          url: previewUrl,
          size: stillFile.size,
          mimeType: stillFile.type,
          isImported: false,
          settings: {
            capturedAt: playheadPosition,
            source: 'timeline-still',
          },
        })
      }

      setJustCapturedStill(true)
      setTimeout(() => setJustCapturedStill(false), 2000)
    } catch (err) {
      console.error('Failed to capture still frame:', err)
    } finally {
      setCapturingStillFrame(false)
    }
  }, [previewMode, capturingStillFrame, playheadPosition, formatCaptureTimecode, currentProjectHandle, addAsset])
  
  // Transport controls for fullscreen
  const goToStart = () => seekTo(0)
  const goToEnd = () => seekTo(duration)

  // Handle context menu on video
  const handleContextMenu = (e) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }
  
  // Close context menu. Capture-phase listener so nested click handlers
  // that call stopPropagation don't prevent the menu from dismissing.
  useEffect(() => {
    if (!contextMenu) return

    const handleClick = (e) => {
      if (contextMenuRef.current && contextMenuRef.current.contains(e.target)) {
        return
      }
      setContextMenu(null)
    }
    const handleEscape = (e) => {
      if (e.key === 'Escape') setContextMenu(null)
    }

    window.addEventListener('click', handleClick, true)
    window.addEventListener('keydown', handleEscape)

    return () => {
      window.removeEventListener('click', handleClick, true)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [contextMenu])

  // Context menu actions
  const handleContextAction = (action) => {
    switch (action) {
      case 'play':
        togglePlay()
        break
      case 'toggle-transform-controls':
        setShowPreviewTransformControls((value) => !value)
        break
      case 'fullscreen':
        toggleFullscreen()
        break
      case 'add-to-timeline':
        if (currentPreview) {
          addClip('video-1', currentPreview, null, timelineSettings?.fps)
          setJustAdded(true)
          setTimeout(() => setJustAdded(false), 2000)
        }
        break
      case 'reset-view':
        resetView()
        break
      case 'extend-with-ai': {
        setContextMenu(null)
        if (previewMode !== 'timeline') break
        const top = getTopmostVideoOrImageClipAtTime(playheadPosition)
        if (!top) break
        setCapturingFrameForAI(true)
        captureTimelineFrameAt(playheadPosition).then((result) => {
          setCapturingFrameForAI(false)
          if (result) {
            setFrameForAI({ ...result, mode: 'extend' })
            window.dispatchEvent(new CustomEvent('comfystudio-open-generate-with-frame'))
          }
        })
        break
      }
      case 'keyframe-for-ai': {
        setContextMenu(null)
        if (previewMode !== 'timeline') break
        const top = getTopmostVideoOrImageClipAtTime(playheadPosition)
        if (!top) break
        setCapturingFrameForAI(true)
        captureTimelineFrameAt(playheadPosition).then((result) => {
          setCapturingFrameForAI(false)
          if (result) {
            setFrameForAI({ ...result, mode: 'keyframe' })
            window.dispatchEvent(new CustomEvent('comfystudio-open-generate-with-frame'))
          }
        })
        break
      }
      case 'capture-still':
        handleCaptureStill()
        break
      case 'zoom-100':
        setZoom(100)
        setPan({ x: 0, y: 0 })
        break
      case 'zoom-fit':
        setZoom('fit')
        setPan({ x: 0, y: 0 })
        break
    }
    setContextMenu(null)
  }
  
  // Get cursor style
  const getCursor = () => {
    if (isZooming) return 'ew-resize'
    if (isPanning) return 'grabbing'
    if (isSpaceHeld && isCtrlHeld) return 'ew-resize'
    if (isSpaceHeld) return 'grab'
    return 'default'
  }

  // Get timeline aspect ratio from settings
  const getTimelineAspectRatio = () => {
    if (timelineSettings) {
      return timelineSettings.width / timelineSettings.height
    }
    return 16 / 9 // Default fallback
  }
  
  const timelineAspectRatio = getTimelineAspectRatio()
  const timelineWidth = Math.max(1, Number(timelineSettings?.width) || 1920)
  const timelineHeight = Math.max(1, Number(timelineSettings?.height) || 1080)
  const numericZoom = zoom === 'fit'
    ? null
    : Math.max(10, Math.min(400, Number(zoom) || 100))

  // Fit dimensions are measured from the viewport. Numeric zoom levels are
  // derived from project resolution so 50/75/100% mean the same thing on
  // every monitor instead of being relative to each monitor's fit size.
  const [fitVideoDimensions, setFitVideoDimensions] = useState({ width: 0, height: 0 })
  const videoDimensions = useMemo(() => {
    if (numericZoom !== null) {
      const scale = numericZoom / 100
      return {
        width: timelineWidth * scale,
        height: timelineHeight * scale,
      }
    }
    return fitVideoDimensions
  }, [fitVideoDimensions, numericZoom, timelineWidth, timelineHeight])

  const previewScale = useMemo(() => {
    const displayWidth = Number(videoDimensions?.width) > 0 ? Number(videoDimensions.width) : timelineWidth
    const displayHeight = Number(videoDimensions?.height) > 0 ? Number(videoDimensions.height) : timelineHeight

    const x = displayWidth / timelineWidth
    const y = displayHeight / timelineHeight
    return {
      x,
      y,
      uniform: Math.min(x, y),
    }
  }, [timelineWidth, timelineHeight, videoDimensions?.width, videoDimensions?.height])
  
  // Calculate fit-to-view dimensions for the current viewport. Numeric zoom
  // levels are derived from project resolution instead of this measured box.
  useEffect(() => {
    const calculateDimensions = () => {
      if (!viewportRef.current) return
      
      const viewport = viewportRef.current.getBoundingClientRect()
      const ar = timelineAspectRatio
      const padding = 24 // Padding around the video
      
      const availableWidth = viewport.width - padding * 2
      const availableHeight = viewport.height - padding * 2
      
      let width, height
      
      // Calculate dimensions to fit within viewport while maintaining aspect ratio
      if (availableWidth / availableHeight > ar) {
        // Viewport is wider than aspect ratio - constrain by height
        height = availableHeight
        width = height * ar
      } else {
        // Viewport is taller than aspect ratio - constrain by width
        width = availableWidth
        height = width / ar
      }
      
      setFitVideoDimensions({ width, height })
    }
    
    calculateDimensions()
    
    // Recalculate on resize
    const resizeObserver = new ResizeObserver(calculateDimensions)
    if (viewportRef.current) {
      resizeObserver.observe(viewportRef.current)
    }
    
    return () => resizeObserver.disconnect()
  }, [timelineAspectRatio])
  
  // Get video container style with computed dimensions. In `fit` mode this uses
  // measured viewport dimensions; numeric zoom uses project-based dimensions so
  // percentages stay consistent across monitors.
  const getAspectRatioStyle = () => {
    // Use computed dimensions for exact fit in both modes.
    if (videoDimensions.width > 0 && videoDimensions.height > 0) {
      return {
        width: `${videoDimensions.width}px`,
        height: `${videoDimensions.height}px`,
        aspectRatio: `${timelineAspectRatio}`,
      }
    }
    
    // Fallback while computing
    if (isFullscreen) {
      // Keep explicit dimensions during first fullscreen frame until ResizeObserver measures.
      return {
        width: '90vw',
        maxWidth: '90vw',
        aspectRatio: `${timelineAspectRatio}`,
      }
    }
    return { aspectRatio: `${timelineAspectRatio}` }
  }
  
  // Render safe guides overlay
  const renderSafeGuides = () => {
    if (safeGuide === 'none' && letterbox === 'none') return null
    
    const guideColor = 'rgba(255, 255, 255, 0.4)'
    const guides = []
    
    // Title Safe (90% / modern HD default)
    if (safeGuide === 'title-safe' || safeGuide === 'all-safe') {
      const inset = 5 // 5% from each edge = 90% title-safe area
      guides.push(
        <div
          key="title-safe"
          className="absolute pointer-events-none border border-dashed"
          style={{
            top: `${inset}%`,
            left: `${inset}%`,
            right: `${inset}%`,
            bottom: `${inset}%`,
            borderColor: 'rgba(255, 200, 0, 0.5)',
          }}
        >
          <span className="absolute -top-4 left-0 text-[9px] text-yellow-400/70">Title Safe</span>
        </div>
      )
    }
    
    // Action Safe (93% / modern HD default)
    if (safeGuide === 'action-safe' || safeGuide === 'all-safe') {
      const inset = 3.5 // 3.5% from each edge = 93% action-safe area
      guides.push(
        <div
          key="action-safe"
          className="absolute pointer-events-none border"
          style={{
            top: `${inset}%`,
            left: `${inset}%`,
            right: `${inset}%`,
            bottom: `${inset}%`,
            borderColor: 'rgba(0, 200, 255, 0.5)',
          }}
        >
          <span className="absolute -top-4 left-0 text-[9px] text-cyan-400/70">Action Safe</span>
        </div>
      )
    }
    
    // Rule of Thirds
    if (safeGuide === 'rule-of-thirds') {
      guides.push(
        <div key="thirds" className="absolute inset-0 pointer-events-none">
          {/* Vertical lines - full height */}
          <div className="absolute top-0 bottom-0 left-1/3 w-px" style={{ backgroundColor: guideColor }} />
          <div className="absolute top-0 bottom-0 left-2/3 w-px" style={{ backgroundColor: guideColor }} />
          {/* Horizontal lines - full width */}
          <div className="absolute left-0 right-0 top-1/3 h-px" style={{ backgroundColor: guideColor }} />
          <div className="absolute left-0 right-0 top-2/3 h-px" style={{ backgroundColor: guideColor }} />
          {/* Intersection points */}
          {[[1/3, 1/3], [2/3, 1/3], [1/3, 2/3], [2/3, 2/3]].map(([x, y], i) => (
            <div
              key={i}
              className="absolute w-2 h-2 rounded-full"
              style={{
                left: `calc(${x * 100}% - 4px)`,
                top: `calc(${y * 100}% - 4px)`,
                backgroundColor: 'rgba(255, 255, 255, 0.6)',
              }}
            />
          ))}
        </div>
      )
    }
    
    // Center Crosshair - full width and height lines
    if (safeGuide === 'center') {
      guides.push(
        <div key="center" className="absolute inset-0 pointer-events-none">
          {/* Horizontal line - full width */}
          <div className="absolute left-0 right-0 top-1/2 h-px" style={{ backgroundColor: guideColor }} />
          {/* Vertical line - full height */}
          <div className="absolute left-1/2 top-0 bottom-0 w-px" style={{ backgroundColor: guideColor }} />
          {/* Center circle */}
          <div 
            className="absolute w-3 h-3 rounded-full border-2" 
            style={{ 
              borderColor: guideColor,
              left: 'calc(50% - 6px)',
              top: 'calc(50% - 6px)',
            }} 
          />
        </div>
      )
    }
    
    // Letterbox overlay
    if (letterbox !== 'none') {
      const preset = LETTERBOX_PRESETS.find(p => p.id === letterbox)
      if (preset && preset.ratio) {
        const currentRatio = timelineAspectRatio
        const targetRatio = preset.ratio
        
        if (targetRatio > currentRatio) {
          // Letterbox (horizontal bars top/bottom) - target is WIDER than current
          // e.g., showing 2.35:1 on a 16:9 timeline crops top/bottom
          const barHeightPercent = ((1 - (currentRatio / targetRatio)) / 2) * 100
          guides.push(
            <div key="letterbox-top" className="absolute left-0 right-0 top-0 bg-black/80 pointer-events-none" style={{ height: `${barHeightPercent}%` }} />,
            <div key="letterbox-bottom" className="absolute left-0 right-0 bottom-0 bg-black/80 pointer-events-none" style={{ height: `${barHeightPercent}%` }} />
          )
        } else if (targetRatio < currentRatio) {
          // Pillarbox (vertical bars left/right) - target is NARROWER than current
          // e.g., showing 9:16 on a 16:9 timeline crops left/right
          const barWidthPercent = ((1 - (targetRatio / currentRatio)) / 2) * 100
          guides.push(
            <div key="pillarbox-left" className="absolute top-0 bottom-0 left-0 bg-black/80 pointer-events-none" style={{ width: `${barWidthPercent}%` }} />,
            <div key="pillarbox-right" className="absolute top-0 bottom-0 right-0 bg-black/80 pointer-events-none" style={{ width: `${barWidthPercent}%` }} />
          )
        }
      }
    }
    
    return <>{guides}</>
  }

  const previewStageStyle = {
    transform: `translate(${pan.x}px, ${pan.y}px)`,
    transformOrigin: 'center center',
    transition: isZooming || isPanning ? 'none' : 'transform 0.1s ease-out',
  }

  return (
    <div 
      ref={panelRef}
      className={`flex-1 bg-sf-dark-950 flex flex-col h-full ${isFullscreen ? 'fullscreen-panel' : ''}`}
      style={isFullscreen ? { width: '100vw', height: '100vh', minHeight: 0 } : undefined}
    >
      {/* Preview Header */}
      <div className="h-8 bg-sf-dark-900 border-b border-sf-dark-700 flex items-center justify-between px-3 flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-xs text-sf-text-secondary">
            {currentPreview ? `Preview - ${currentPreview.name}` : 'Preview'}
            {isFullscreen && <span className="ml-2 text-sf-text-muted">(Press ESC to exit)</span>}
          </span>

          {previewMode === 'timeline' && getTopmostVideoOrImageClipAtTime(playheadPosition) && (
            <button
              onClick={handleCaptureStill}
              disabled={capturingStillFrame}
              className={`flex items-center gap-1.5 px-2 py-1 rounded transition-colors text-xs ${
                justCapturedStill
                  ? 'text-sf-success bg-sf-success/10'
                  : 'text-sf-text-muted hover:bg-sf-dark-700'
              } disabled:opacity-50`}
              title="Capture a still frame from the preview into project assets"
            >
              {capturingStillFrame ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Saving Still...</span>
                </>
              ) : justCapturedStill ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>Still Saved</span>
                </>
              ) : (
                <>
                  <Camera className="w-3.5 h-3.5" />
                  <span>Still</span>
                </>
              )}
            </button>
          )}
          
          {/* Info Overlay Toggle */}
          <button
            onClick={() => setShowInfoOverlay(!showInfoOverlay)}
            className={`flex items-center gap-1.5 px-2 py-1 hover:bg-sf-dark-700 rounded transition-colors text-xs ${
              showInfoOverlay ? 'text-sf-text-muted' : 'text-sf-text-muted/50'
            }`}
            title={showInfoOverlay ? 'Hide Info Overlay' : 'Show Info Overlay'}
          >
            {showInfoOverlay ? (
              <Eye className="w-3.5 h-3.5" />
            ) : (
              <EyeOff className="w-3.5 h-3.5" />
            )}
            <span>Info</span>
          </button>
          
          {/* Safe Guides Dropdown */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation()
                setShowGuidesDropdown(!showGuidesDropdown)
                setShowZoomDropdown(false)
              }}
              className={`flex items-center gap-1.5 px-2 py-1 hover:bg-sf-dark-700 rounded transition-colors text-xs ${
                safeGuide !== 'none' || letterbox !== 'none' ? 'text-sf-accent' : 'text-sf-text-muted'
              }`}
              title="Safe Guides & Letterbox"
            >
              <Grid3X3 className="w-3.5 h-3.5" />
              <span>Guides</span>
              <ChevronDown className="w-3 h-3" />
            </button>
            
            {showGuidesDropdown && (
              <div 
                className="absolute top-full left-0 mt-1 bg-sf-dark-800 border border-sf-dark-600 rounded-lg shadow-xl py-2 z-50 min-w-[200px]"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Safe Guides Section */}
                <div className="px-3 py-1 text-[10px] text-sf-text-muted uppercase tracking-wider">
                  Safe Guides
                </div>
                {SAFE_GUIDES.map((guide) => (
                  <button
                    key={guide.id}
                    onClick={() => setSafeGuide(guide.id)}
                    className={`w-full px-3 py-1.5 text-left text-xs hover:bg-sf-dark-700 flex items-center gap-2 transition-colors ${
                      safeGuide === guide.id ? 'bg-sf-dark-700' : ''
                    }`}
                  >
                    <div className="w-4 flex justify-center">
                      {guide.id === 'rule-of-thirds' && <Grid3X3 className="w-3.5 h-3.5 text-sf-text-muted" />}
                      {guide.id === 'center' && <Crosshair className="w-3.5 h-3.5 text-sf-text-muted" />}
                      {guide.id === 'title-safe' && <Square className="w-3 h-3 text-yellow-400/70" />}
                      {guide.id === 'action-safe' && <Square className="w-3.5 h-3.5 text-cyan-400/70" />}
                      {guide.id === 'all-safe' && <Frame className="w-3.5 h-3.5 text-sf-text-muted" />}
                      {guide.id === 'none' && <X className="w-3.5 h-3.5 text-sf-text-muted" />}
                    </div>
                    <div className="flex-1">
                      <span className="text-sf-text-primary">{guide.label}</span>
                      <p className="text-[10px] text-sf-text-muted">{guide.description}</p>
                    </div>
                    {safeGuide === guide.id && (
                      <Check className="w-3 h-3 text-sf-accent" />
                    )}
                  </button>
                ))}
                
                {/* Divider */}
                <div className="h-px bg-sf-dark-600 my-2" />
                
                {/* Letterbox Section */}
                <div className="px-3 py-1 text-[10px] text-sf-text-muted uppercase tracking-wider">
                  Letterbox Preview
                </div>
                {LETTERBOX_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => setLetterbox(preset.id)}
                    className={`w-full px-3 py-1.5 text-left text-xs hover:bg-sf-dark-700 flex items-center gap-2 transition-colors ${
                      letterbox === preset.id ? 'bg-sf-dark-700' : ''
                    }`}
                  >
                    <div className="w-4 flex justify-center">
                      {preset.id === 'none' ? (
                        <X className="w-3.5 h-3.5 text-sf-text-muted" />
                      ) : (
                        <div className="w-4 h-2 border border-sf-text-muted rounded-sm" />
                      )}
                    </div>
                    <span className="text-sf-text-primary">{preset.label}</span>
                    {letterbox === preset.id && (
                      <Check className="w-3 h-3 text-sf-accent ml-auto" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          {currentPreview && !isFullscreen && (
            <button 
              onClick={clearPreview}
              className="p-1 hover:bg-sf-dark-700 rounded transition-colors"
              title="Clear preview"
            >
              <X className="w-4 h-4 text-sf-text-muted" />
            </button>
          )}
          {previewMode === 'timeline' && (
            <button
              onClick={() => setShowPreviewTransformControls((value) => !value)}
              disabled={!canShowPreviewTransformControls}
              className={`p-1 rounded transition-colors ${
                canShowPreviewTransformControls
                  ? 'hover:bg-sf-dark-700'
                  : 'opacity-40 cursor-not-allowed'
              } ${showPreviewTransformControls ? 'text-sf-accent' : 'text-sf-text-muted'}`}
              title={
                canShowPreviewTransformControls
                  ? (showPreviewTransformControls ? 'Hide transform controls' : 'Show transform controls')
                  : 'Select an active visual clip to toggle transform controls'
              }
            >
              {showPreviewTransformControls ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </button>
          )}
          <button 
            onClick={toggleFullscreen}
            className="p-1 hover:bg-sf-dark-700 rounded transition-colors"
            title={isFullscreen ? 'Exit Fullscreen (ESC)' : 'Fullscreen'}
          >
            {isFullscreen ? (
              <Minimize2 className="w-4 h-4 text-sf-text-muted" />
            ) : (
              <Maximize2 className="w-4 h-4 text-sf-text-muted" />
            )}
          </button>
        </div>
      </div>
      
      {/* Preview Area with subtle grid pattern */}
      <div 
        ref={viewportRef}
        className="flex-1 flex items-center justify-center min-h-0 overflow-hidden"
        style={{ 
          cursor: getCursor(),
          backgroundColor: '#121212',
          backgroundImage: `
            linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)
          `,
          backgroundSize: '20px 20px',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      >
        {/* Wrapper for video container and guides overlay */}
        <div className="relative" style={getAspectRatioStyle()}>
          <div 
            ref={containerRef}
            className="relative bg-black overflow-hidden w-full h-full"
            style={previewStageStyle}
            onContextMenu={handleContextMenu}
          >
              {/* Timeline Playback Mode */}
            {previewMode === 'timeline' && clips.length > 0 ? (
              <>
                {/* Flattened preview proxy (smooth playback when many layers) or live compositing */}
                {proxyVideoUrl && useProxyPlayback ? (
                  <video
                    ref={proxyVideoRef}
                    src={proxyVideoUrl}
                    className="absolute inset-0 w-full h-full object-contain bg-black"
                    onLoadedMetadata={() => {
                      if (proxyVideoRef.current) {
                        proxyVideoRef.current.currentTime = playheadPosition
                      }
                    }}
                    onTimeUpdate={() => {
                      if (proxyVideoRef.current && timelineIsPlaying) {
                        setPlayheadPosition(proxyVideoRef.current.currentTime)
                      }
                    }}
                    onEnded={() => timelineIsPlaying && timelineTogglePlay()}
                    onContextMenu={(e) => e.preventDefault()}
                  />
                ) : activePreviewChunk ? (
                  <>
                    <AudioLayerRenderer />
                    <video
                      key={activePreviewChunk.path}
                      ref={chunkVideoRef}
                      src={activePreviewChunk.url}
                      className="absolute inset-0 w-full h-full object-contain bg-black"
                      muted
                      playsInline
                      onLoadedMetadata={() => {
                        if (chunkVideoRef.current) {
                          chunkVideoRef.current.currentTime = Math.max(0, playheadPosition - activePreviewChunk.rangeStart)
                          if (timelineIsPlaying) chunkVideoRef.current.play().catch(() => {})
                        }
                      }}
                      onTimeUpdate={() => {
                        if (chunkVideoRef.current && timelineIsPlaying) {
                          setPlayheadPosition(activePreviewChunk.rangeStart + chunkVideoRef.current.currentTime)
                        }
                      }}
                      onEnded={() => {
                        if (timelineIsPlaying) {
                          setPlayheadPosition(activePreviewChunk.rangeEnd, { snap: true })
                        }
                      }}
                      onContextMenu={(e) => e.preventDefault()}
                    />
                  </>
                ) : (
                  <>
                    <AudioLayerRenderer />
                    <CanvasPreviewRenderer
                      timelineWidth={timelineWidth}
                      timelineHeight={timelineHeight}
                      timelineFps={timelineSettings?.fps || timelineFps || 30}
                      onClipPointerDown={handlePreviewClipPointerDown}
                      onClipDoubleClick={handlePreviewTextDoubleClick}
                    />
                  </>
                )}
                
                {/* Timeline Mode Overlay */}
                {showInfoOverlay && (
                  <div className="absolute top-2 left-2 right-2 flex items-start justify-between pointer-events-none z-50">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="px-2 py-1 bg-sf-accent/80 rounded text-xs text-white flex items-center gap-1">
                        <Film className="w-3 h-3" />
                        Timeline
                      </div>
                      {/* Show timeline resolution */}
                      {timelineSettings && (
                        <div className={`px-2 py-1 rounded text-xs ${timelineSettings.isTimelineSpecific ? 'bg-purple-600/80 text-white' : 'bg-sf-dark-900/80 text-sf-text-muted'}`}>
                          {timelineSettings.width}×{timelineSettings.height} @ {timelineSettings.fps}fps
                        </div>
                      )}
                      {activeLayerClips.length > 1 ? (
                        // Show layer count in multi-layer mode
                        <div className="px-2 py-1 bg-green-600/80 rounded text-xs text-white">
                          {activeLayerClips.length} Layers
                        </div>
                      ) : activeClip ? (
                        <div className="px-2 py-1 bg-sf-dark-900/80 rounded text-xs text-sf-text-muted">
                          {activeClip.name}
                        </div>
                      ) : null}
                      {transitionInfo && (
                        <div className="px-2 py-1 bg-purple-600/80 rounded text-xs text-white capitalize">
                          {transitionInfo.transition?.type?.replace('-', ' ') || 'Dissolve'} {Math.round(transitionInfo.progress * 100)}%
                        </div>
                      )}
                      {proxyVideoUrl && useProxyPlayback && (
                        <div className="px-2 py-1 bg-green-600/80 rounded text-xs text-white">
                          Smooth preview
                        </div>
                      )}
                      {activePreviewChunk && (
                        <div className="px-2 py-1 bg-emerald-700/80 rounded text-xs text-white">
                          Cached chunk {formatPreviewChunkRange(activePreviewChunk)}
                        </div>
                      )}
                      {previewChunks.length > 0 && !activePreviewChunk && (
                        <div className="px-2 py-1 bg-emerald-950/80 rounded text-xs text-emerald-200 border border-emerald-800/60">
                          {previewChunks.length} cached chunk{previewChunks.length === 1 ? '' : 's'}
                        </div>
                      )}
                      {!activePreviewChunk && !useProxyPlayback && previewCompositorMode === 'canvas' && (
                        <div className="px-2 py-1 bg-blue-700/80 rounded text-xs text-white">
                          Canvas preview
                        </div>
                      )}
                      {previewComplexity.maxConcurrentVideoLayers >= 2 && (
                        <div className="px-2 py-1 bg-sf-dark-900/80 rounded text-xs text-sf-text-muted">
                          Peak {previewComplexity.maxConcurrentVideoLayers} video layers
                        </div>
                      )}
                      {autoSmoothPreviewEnabled && shouldAutoGenerateProxy && !useProxyPlayback && previewProxyStatus !== 'generating' && (
                        <div className="px-2 py-1 bg-yellow-600/80 rounded text-xs text-white">
                          Auto smooth preview pending
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 pointer-events-auto">
                      {previewProxyStatus === 'generating' && (
                        <div className="px-2 py-1 bg-sf-dark-800 rounded text-xs text-sf-text-muted flex items-center gap-2">
                          <span>Generating smooth preview…</span>
                          <span>{Math.round(previewProxyProgress)}%</span>
                        </div>
                      )}
                      {chunkCacheState.busy && (
                        <div className="px-2 py-1 bg-sf-dark-800 rounded text-xs text-sf-text-muted flex items-center gap-2">
                          <span>{chunkCacheState.status || 'Caching preview chunks...'}</span>
                          <span>{Math.round(chunkCacheState.progress)}%</span>
                          <button
                            type="button"
                            onClick={stopPreviewChunkCache}
                            className="ml-1 rounded bg-sf-dark-700 px-1.5 py-0.5 text-[10px] text-sf-text-secondary hover:bg-sf-dark-600"
                            title="Stop caching after the current frame"
                          >
                            Stop
                          </button>
                        </div>
                      )}
                      {currentProjectHandle && window.electronAPI && (
                        <button
                          type="button"
                          onClick={() => setUseProxyPlaybackForAssets(!useProxyPlaybackForAssets)}
                          className={`px-2 py-1 rounded text-xs transition-colors ${useProxyPlaybackForAssets ? 'bg-green-700/70 hover:bg-green-700 text-white' : 'bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-muted'}`}
                          title={useProxyPlaybackForAssets
                            ? `Using low-res proxies for preview (export still uses originals). ${proxyCoverage.ready}/${proxyCoverage.total} videos have proxies.`
                            : 'Use low-res 540p proxies during timeline playback. Reduces decode load by ~4×. Export always uses originals.'}
                        >
                          {useProxyPlaybackForAssets
                            ? `Proxies: On${proxyCoverage.total > 0 ? ` (${proxyCoverage.ready}/${proxyCoverage.total})` : ''}`
                            : 'Proxies: Off'}
                        </button>
                      )}
                      <label
                        className="flex items-center gap-1 rounded bg-sf-dark-700 px-2 py-1 text-xs text-sf-text-muted"
                        title="Controls live GLSL shader preview resolution only. Export still renders at full quality."
                      >
                        <span>GLSL</span>
                        <select
                          value={glslPreviewQuality}
                          onChange={(event) => setGlslPreviewQuality(event.target.value)}
                          className="bg-sf-dark-800 text-sf-text-secondary outline-none"
                        >
                          <option value="full">Full</option>
                          <option value="half">Half</option>
                          <option value="quarter">Quarter</option>
                          <option value="eighth">Eighth</option>
                        </select>
                      </label>
                      <div
                        className="px-2 py-1 rounded text-xs bg-blue-700/80 text-white"
                        title="Timeline preview now uses the canvas compositor to avoid DOM reparenting flicker."
                      >
                        Canvas preview
                      </div>
                      {useProxyPlaybackForAssets && currentProjectHandle && window.electronAPI && proxyCoverage.total > 0 && (
                        <button
                          type="button"
                          onClick={() => { void generateProxiesForAll({ force: true }) }}
                          disabled={generatingProxies}
                          className={`px-2 py-1 rounded text-xs transition-colors ${generatingProxies ? 'bg-sf-dark-700 text-sf-text-muted cursor-not-allowed' : 'bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-secondary'}`}
                          title={`Force-regenerate proxies for all ${proxyCoverage.total} video${proxyCoverage.total === 1 ? '' : 's'}. Existing proxy files are overwritten.`}
                        >
                          {generatingProxies && proxyGenerationMode === 'rebuild'
                            ? `Rebuilding ${proxyGenerationProgress.current}/${proxyGenerationProgress.total || proxyCoverage.total}…`
                            : 'Rebuild all'}
                        </button>
                      )}
                      {useProxyPlaybackForAssets && currentProjectHandle && window.electronAPI && proxyCoverage.missing > 0 && (
                        <button
                          type="button"
                          onClick={() => { void generateProxiesForAll() }}
                          disabled={generatingProxies}
                          className={`px-2 py-1 rounded text-xs transition-colors ${generatingProxies ? 'bg-sf-dark-700 text-sf-text-muted cursor-not-allowed' : 'bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-secondary'}`}
                          title={`Generate proxies for ${proxyCoverage.missing} video${proxyCoverage.missing === 1 ? '' : 's'} that don't have one yet. Runs in the background.`}
                        >
                          {generatingProxies && proxyGenerationMode === 'missing'
                            ? `Generating ${proxyGenerationProgress.current}/${proxyGenerationProgress.total || proxyCoverage.missing}…`
                            : `Generate ${proxyCoverage.missing} missing`}
                        </button>
                      )}
                      {useProxyPlaybackForAssets && currentProjectHandle && window.electronAPI && proxyCoverage.unavailable > 0 && (
                        <span
                          className="px-2 py-1 rounded text-xs bg-amber-900/40 text-amber-300 border border-amber-700/40 cursor-help select-none"
                          title={`${proxyCoverage.unavailable} video${proxyCoverage.unavailable === 1 ? '' : 's'} can't be proxied right now — either no local file was found, or a previous encode failed (broken link, unreadable file, ffmpeg error). Common causes: the asset was imported with only a remote URL, or the original file was moved or deleted. Re-link or re-import these assets, then click Rebuild all to retry.`}
                        >
                          {proxyCoverage.unavailable} unavailable
                        </span>
                      )}
                      {currentProjectHandle && window.electronAPI && clips.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setAutoSmoothPreviewEnabled(prev => !prev)}
                          className={`px-2 py-1 rounded text-xs transition-colors ${autoSmoothPreviewEnabled ? 'bg-green-700/70 hover:bg-green-700 text-white' : 'bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-muted'}`}
                          title="Automatically generate smooth preview proxies for heavy timelines"
                        >
                          {autoSmoothPreviewEnabled ? 'Auto smooth: On' : 'Auto smooth: Off'}
                        </button>
                      )}
                      {currentProjectHandle && window.electronAPI && clips.length > 0 && (
                        <button
                          type="button"
                          onClick={() => { void runPreviewChunkCache() }}
                          disabled={chunkCacheState.busy || previewProxyStatus === 'generating'}
                          className={`px-2 py-1 rounded text-xs transition-colors ${
                            chunkCacheState.busy || previewProxyStatus === 'generating'
                              ? 'bg-sf-dark-700 text-sf-text-muted cursor-not-allowed'
                              : 'bg-emerald-800/70 hover:bg-emerald-700 text-white'
                          }`}
                          title={`Render ${previewChunkPlan.ranges.length || 0} hidden preview-cache chunk${previewChunkPlan.ranges.length === 1 ? '' : 's'} around the playhead (${Math.round(previewChunkPlan.totalSeconds)}s total). Uses current proxy and GLSL preview-quality settings.`}
                        >
                          {chunkCacheState.busy
                            ? `Caching ${chunkCacheState.cachedCount}/${chunkCacheState.totalCount || previewChunkPlan.ranges.length}`
                            : previewChunkPlan.label}
                        </button>
                      )}
                      {previewProxyStatus !== 'generating' && currentProjectHandle && window.electronAPI && clips.length > 0 && (
                        <button
                          type="button"
                          onClick={() => { void runSmoothPreviewRender({ force: true, reason: 'manual' }) }}
                          className="px-2 py-1 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-xs text-sf-text-muted transition-colors"
                          title="Render timeline to a single file for smoother playback with many layers (Electron only)"
                        >
                          {previewProxyStatus === 'ready' && useProxyPlayback ? 'Re-generate smooth preview' : 'Generate smooth preview'}
                        </button>
                      )}
                      {chunkCacheState.error && (
                        <span
                          className="px-2 py-1 rounded text-xs bg-amber-900/50 text-amber-200 border border-amber-700/40"
                          title={chunkCacheState.error}
                        >
                          Chunk cache warning
                        </span>
                      )}
                      {!chunkCacheState.busy && !chunkCacheState.error && chunkCacheState.status && (
                        <span
                          className="px-2 py-1 rounded text-xs bg-emerald-950/60 text-emerald-200 border border-emerald-800/50"
                          title={chunkCacheState.status}
                        >
                          {chunkCacheState.status}
                        </span>
                      )}
                      {currentPreview && (
                        <button 
                          onClick={() => {
                            setPreviewMode('asset')
                            if (timelineIsPlaying) timelineTogglePlay()
                          }}
                          className="px-2 py-1 bg-sf-dark-900/80 hover:bg-sf-dark-700 rounded text-xs text-sf-text-muted transition-colors"
                        >
                          View Asset
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : currentPreview ? (
              <>
                {/* Asset Preview Mode - Video, Image, or Mask */}
                {currentPreview.type === 'mask' ? (
                  /* Mask Preview - with frame-by-frame playback for video masks */
                  <MaskPreview
                    mask={currentPreview}
                    isPlaying={assetIsPlaying}
                    currentFrame={maskFrame}
                    onFrameChange={setMaskFrame}
                    onDurationSet={handleMaskDurationSet}
                    onTimeUpdate={handleMaskTimeUpdate}
                    onEnded={handleMaskEnded}
                  />
                ) : currentPreview.type === 'image' ? (
                  <img
                    src={currentPreview.url}
                    alt={currentPreview.name}
                    className="w-full h-full"
                    style={{
                      display: 'block',
                      objectFit: 'contain', // Maintain aspect ratio, letterbox if needed (no stretching)
                    }}
                    onContextMenu={(e) => e.preventDefault()}
                  />
                ) : (
                  <>
                    {currentPreview?.settings?.hasAlpha === true && (
                      <div
                        className="absolute inset-0 pointer-events-none"
                        style={{
                          backgroundImage: `
                            linear-gradient(45deg, #333 25%, transparent 25%),
                            linear-gradient(-45deg, #333 25%, transparent 25%),
                            linear-gradient(45deg, transparent 75%, #333 75%),
                            linear-gradient(-45deg, transparent 75%, #333 75%)
                          `,
                          backgroundSize: '20px 20px',
                          backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
                          backgroundColor: '#222',
                          zIndex: 1,
                        }}
                      />
                    )}
                    <video
                      ref={videoRefA}
                      src={currentPreview.url}
                      className="w-full h-full"
                      style={{
                        display: 'block',
                        objectFit: 'contain', // Maintain aspect ratio, letterbox if needed (no stretching)
                        position: 'relative',
                        zIndex: 2,
                      }}
                      onTimeUpdate={handleTimeUpdate}
                      onLoadedMetadata={handleLoadedMetadata}
                      onLoadedData={handleLoadedData}
                      onEnded={handleEnded}
                      onPlay={() => setAssetIsPlaying(true)}
                      onPause={() => setAssetIsPlaying(false)}
                      onContextMenu={(e) => e.preventDefault()}
                      controlsList="nodownload nofullscreen noremoteplayback"
                      disablePictureInPicture
                    />
                    {/* Hold frame canvas - shows last frame during video src transition to prevent black flicker */}
                    <canvas
                      ref={holdFrameCanvasRef}
                      className="absolute inset-0 w-full h-full pointer-events-none"
                      style={{
                        objectFit: 'contain',
                        display: showHoldFrame ? 'block' : 'none',
                        zIndex: 5,
                      }}
                    />
                  </>
                )}
                
                {/* Asset Info Overlay */}
                {showInfoOverlay && (
                  <div className="absolute top-2 left-2 right-2 z-50 flex items-start justify-between pointer-events-none">
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* Type Badge */}
                      <div className={`px-2 py-1 rounded text-xs text-white flex items-center gap-1 ${
                        currentPreview.type === 'mask' ? 'bg-purple-600/80' :
                        currentPreview.type === 'image' ? 'bg-green-600/80' : 
                        currentPreview.type === 'audio' ? 'bg-purple-600/80' : 'bg-blue-600/80'
                      }`}>
                        {currentPreview.type === 'mask' ? (
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10"/>
                            <path d="M12 2a10 10 0 0 1 0 20"/>
                          </svg>
                        ) : currentPreview.type === 'image' ? (
                          <ImageIcon className="w-3 h-3" />
                        ) : (
                          <Film className="w-3 h-3" />
                        )}
                        {currentPreview.type?.charAt(0).toUpperCase() + currentPreview.type?.slice(1)}
                      </div>
                      
                      {/* Resolution/Dimensions */}
                      {(currentPreview.settings?.width || currentPreview.width) && (
                        <div className="px-2 py-1 bg-sf-dark-900/80 rounded text-xs text-sf-text-muted">
                          {currentPreview.settings?.width || currentPreview.width}×{currentPreview.settings?.height || currentPreview.height}
                        </div>
                      )}
                      
                      {/* Duration (video/audio only - not image or mask) */}
                      {currentPreview.type !== 'image' && currentPreview.type !== 'mask' && (currentPreview.settings?.duration || currentPreview.duration) && (
                        <div className="px-2 py-1 bg-sf-dark-900/80 rounded text-xs text-sf-text-muted">
                          {(currentPreview.settings?.duration || currentPreview.duration)?.toFixed(2)}s
                        </div>
                      )}

                      {/* FPS (video only) */}
                      {currentPreview.type === 'video' && previewFpsLabel && (
                        <div className="px-2 py-1 bg-sf-dark-900/80 rounded text-xs text-sf-text-muted">
                          {previewFpsLabel} fps
                        </div>
                      )}
                      
                      {/* Frame count for masks */}
                      {currentPreview.type === 'mask' && currentPreview.frameCount && (
                        <div className="px-2 py-1 bg-sf-dark-900/80 rounded text-xs text-sf-text-muted">
                          {currentPreview.frameCount} frame{currentPreview.frameCount > 1 ? 's' : ''}
                        </div>
                      )}
                      
                      {/* File Size */}
                      {currentPreview.size && (
                        <div className="px-2 py-1 bg-sf-dark-900/80 rounded text-xs text-sf-text-muted">
                          {currentPreview.size < 1024 * 1024 
                            ? `${(currentPreview.size / 1024).toFixed(1)} KB`
                            : `${(currentPreview.size / (1024 * 1024)).toFixed(1)} MB`
                          }
                        </div>
                      )}
                      
                      {/* AI/Imported Badge */}
                      <div className={`px-2 py-1 rounded text-xs ${
                        currentPreview.isImported 
                          ? 'bg-sf-dark-700/90 text-sf-text-muted' 
                          : 'bg-sf-accent/80 text-white'
                      }`}>
                        {currentPreview.isImported ? 'IMP' : 'AI'}
                      </div>
                    </div>
                    <div className="flex gap-2 pointer-events-auto">
                      <button 
                        className={`px-2 py-1 rounded text-xs text-white font-medium flex items-center gap-1 transition-colors ${
                          justAdded 
                            ? 'bg-sf-success' 
                            : 'bg-sf-accent/90 hover:bg-sf-accent'
                        }`}
                        onClick={handleAddToTimeline}
                      >
                        {justAdded ? (
                          <>
                            <Check className="w-3 h-3" />
                            Added!
                          </>
                        ) : (
                          <>
                            <Plus className="w-3 h-3" />
                            Add to Timeline
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {/* Prompt Overlay (bottom) - only for AI-generated assets */}
                {showInfoOverlay && currentPreview.prompt && (
                  <div className="absolute bottom-0 left-0 right-0 z-50 p-3 bg-gradient-to-t from-black/80 to-transparent pointer-events-none">
                    <p className="text-xs text-white/80 line-clamp-2">
                      {currentPreview.prompt}
                    </p>
                  </div>
                )}
              </>
            ) : (
              /* Empty State */
              <div className="w-full h-full flex flex-col items-center justify-center text-sf-text-muted">
                <div className="text-6xl mb-4">🎬</div>
                <p className="text-sm">No Preview Selected</p>
                <p className="text-xs mt-1 text-sf-text-muted">
                  Generate a video or select from Assets
                </p>
                {clips.length > 0 && (
                  <button 
                    onClick={() => {
                      setPreviewMode('timeline')
            setPlayheadPosition(0, { snap: true })
                    }}
                    className="mt-3 px-3 py-1.5 bg-sf-blue hover:bg-sf-blue-hover rounded text-xs text-white flex items-center gap-1 transition-colors"
                  >
                    <Film className="w-3 h-3" />
                    Preview Timeline
                  </button>
                )}
              </div>
            )}
            
            {/* Resolution Indicator (when no content) */}
            {showInfoOverlay && !currentPreview && previewMode !== 'timeline' && timelineSettings && (
              <div className="absolute top-2 left-2 px-2 py-0.5 bg-sf-dark-900/80 rounded text-xs text-sf-text-muted">
                {timelineSettings.width}×{timelineSettings.height}
              </div>
            )}
          </div>

          {showPreviewTransformControls && selectedPreviewClip && selectedPreviewTransform && (
            <div
              className="absolute inset-0 overflow-visible pointer-events-none"
              style={previewStageStyle}
            >
              <PreviewTransformGizmo
                clip={selectedPreviewClip}
                transform={selectedPreviewTransform}
                buildVideoTransform={buildVideoTransform}
                previewScale={previewScale}
                zoomScale={1}
                disabled={isSpaceHeld || isPanning || isZooming}
                onInteractionStart={handlePreviewTransformInteractionStart}
                onTransformChange={handlePreviewTransformChange}
                onTransformCommit={handlePreviewTransformCommit}
              />
            </div>
          )}
          
          {/* Safe Guides Overlay - use the same zoom/pan transform as the stage
              so guides always stay locked to the project frame on every monitor. */}
          <div
            className="absolute inset-0 overflow-visible pointer-events-none z-30"
            style={previewStageStyle}
          >
            {renderSafeGuides()}
          </div>
        </div>
      </div>
      
      {/* Preview Scrubber Bar - Like DaVinci Resolve's viewer scrubber */}
      {hasContent && !isFullscreen && (
        <div className="h-7 bg-sf-dark-900 border-t border-sf-dark-700 flex items-center px-3 gap-2 flex-shrink-0">
          {/* Timecode - Current */}
          <span className="text-[10px] text-sf-text-secondary font-mono w-12 text-right">
            {formatTime(currentTime)}
          </span>
          
          {/* Scrubber Track */}
          <div 
            className="flex-1 h-4 relative cursor-pointer group"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const x = e.clientX - rect.left
              const percent = x / rect.width
              const newTime = percent * duration
              seekTo(Math.max(0, Math.min(duration, newTime)))
            }}
            onMouseDown={(e) => {
              e.preventDefault()
              const scrubber = e.currentTarget
              
              const handleScrub = (moveEvent) => {
                const rect = scrubber.getBoundingClientRect()
                const x = moveEvent.clientX - rect.left
                const percent = Math.max(0, Math.min(1, x / rect.width))
                const newTime = percent * duration
                seekTo(newTime)
              }
              
              const handleMouseUp = () => {
                window.removeEventListener('mousemove', handleScrub)
                window.removeEventListener('mouseup', handleMouseUp)
              }
              
              window.addEventListener('mousemove', handleScrub)
              window.addEventListener('mouseup', handleMouseUp)
              
              // Initial scrub on mousedown
              handleScrub(e)
            }}
          >
            {/* Track Background */}
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-sf-dark-700 rounded-full" />
            
            {/* Progress Fill */}
            <div 
              className="absolute top-1/2 -translate-y-1/2 h-1 bg-sf-accent/60 rounded-full left-0"
              style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
            />
            
            {/* Playhead Indicator */}
            <div 
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-sf-accent rounded-full shadow-md transform -translate-x-1/2 group-hover:scale-110 transition-transform"
              style={{ left: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
            />
            
            {/* Hover time indicator */}
            <div className="absolute inset-0 opacity-0 group-hover:opacity-100">
              <div 
                className="absolute top-1/2 -translate-y-1/2 h-1.5 bg-white/20 rounded-full left-0 pointer-events-none"
                style={{ width: '100%' }}
              />
            </div>
          </div>
          
          {/* Timecode - Duration */}
          <span className="text-[10px] text-sf-text-muted font-mono w-12">
            {formatTime(duration)}
          </span>
        </div>
      )}
      
      {/* Fullscreen Transport Controls */}
      {isFullscreen && (
        <div className="h-12 bg-sf-dark-900 border-t border-sf-dark-700 flex items-center px-4 gap-4 flex-shrink-0">
          {/* Transport buttons */}
          <div className="flex items-center gap-3">
            {/* Skip to Start */}
            <button
              onClick={goToStart}
              className="p-2 hover:bg-sf-dark-700 rounded transition-colors"
              disabled={!hasContent}
              title="Go to Start"
            >
              <SkipBack className="w-5 h-5 text-sf-text-secondary" />
            </button>

            {/* Play/Pause */}
            <button
              onClick={togglePlay}
              className={`p-3 rounded-full transition-colors ${
                hasContent
                  ? 'bg-sf-blue hover:bg-sf-blue-hover'
                  : 'bg-sf-dark-600 cursor-not-allowed'
              }`}
              disabled={!hasContent}
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <Pause className="w-5 h-5 text-white" />
              ) : (
                <Play className="w-5 h-5 text-white ml-0.5" />
              )}
            </button>

            {/* Skip to End */}
            <button
              onClick={goToEnd}
              className="p-2 hover:bg-sf-dark-700 rounded transition-colors"
              disabled={!hasContent}
              title="Go to End"
            >
              <SkipForward className="w-5 h-5 text-sf-text-secondary" />
            </button>
          </div>

          {/* Fullscreen scrubber */}
          <div className="flex-1 min-w-0 flex items-center gap-3">
            <span className="text-xs text-sf-text-secondary font-mono w-14 text-right">
              {formatTime(currentTime)}
            </span>

            <div
              className={`flex-1 h-5 relative ${
                hasContent ? 'cursor-pointer group' : 'cursor-not-allowed opacity-50'
              }`}
              onClick={(e) => {
                if (!hasContent || duration <= 0) return
                const rect = e.currentTarget.getBoundingClientRect()
                const x = e.clientX - rect.left
                const percent = x / rect.width
                const newTime = percent * duration
                seekTo(Math.max(0, Math.min(duration, newTime)))
              }}
              onMouseDown={(e) => {
                if (!hasContent || duration <= 0) return
                e.preventDefault()
                const scrubber = e.currentTarget

                const handleScrub = (moveEvent) => {
                  const rect = scrubber.getBoundingClientRect()
                  const x = moveEvent.clientX - rect.left
                  const percent = Math.max(0, Math.min(1, x / rect.width))
                  const newTime = percent * duration
                  seekTo(newTime)
                }

                const handleMouseUp = () => {
                  window.removeEventListener('mousemove', handleScrub)
                  window.removeEventListener('mouseup', handleMouseUp)
                }

                window.addEventListener('mousemove', handleScrub)
                window.addEventListener('mouseup', handleMouseUp)

                // Initial scrub on mousedown
                handleScrub(e)
              }}
            >
              {/* Track Background */}
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-sf-dark-700 rounded-full" />

              {/* Progress Fill */}
              <div
                className="absolute top-1/2 -translate-y-1/2 h-1 bg-sf-accent/70 rounded-full left-0"
                style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
              />

              {/* Playhead Indicator */}
              <div
                className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-sf-accent rounded-full shadow-md transform -translate-x-1/2 group-hover:scale-110 transition-transform"
                style={{ left: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
              />
            </div>

            <span className="text-xs text-sf-text-muted font-mono w-14">
              {formatTime(duration)}
            </span>
          </div>

          {/* Right side - volume */}
          <div className="flex items-center gap-2">
            <Volume2 className="w-5 h-5 text-sf-text-muted" />
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              className="w-24 h-1.5 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
            />
          </div>
        </div>
      )}
      
      {/* Zoom Controls Bar */}
      <div className="h-8 bg-sf-dark-900 border-t border-sf-dark-700 flex items-center justify-center gap-2 px-3 flex-shrink-0">
        {/* Home/Reset button */}
        <button
          onClick={resetView}
          className="p-1.5 hover:bg-sf-dark-700 rounded transition-colors"
          title="Reset View (Home)"
        >
          <Home className="w-3.5 h-3.5 text-sf-text-secondary" />
        </button>
        
        <div className="w-px h-4 bg-sf-dark-600" />
        
        {/* Zoom out */}
        <button
          onClick={zoomOut}
          className="p-1.5 hover:bg-sf-dark-700 rounded transition-colors"
          title="Zoom Out"
        >
          <ZoomOut className="w-3.5 h-3.5 text-sf-text-secondary" />
        </button>
        
        {/* Zoom dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowZoomDropdown(!showZoomDropdown)}
            className="px-2 py-1 hover:bg-sf-dark-700 rounded transition-colors min-w-[50px] text-center"
          >
            <span className="text-xs text-sf-text-primary font-mono">{getZoomLabel()}</span>
          </button>
          
          {showZoomDropdown && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 bg-sf-dark-800 border border-sf-dark-600 rounded shadow-lg py-1 z-50">
              {ZOOM_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  onClick={() => {
                    setZoom(preset.value)
                    setPan({ x: 0, y: 0 })
                    setShowZoomDropdown(false)
                  }}
                  className={`w-full px-3 py-1 text-xs text-left hover:bg-sf-dark-700 transition-colors ${
                    zoom === preset.value ? 'text-sf-accent' : 'text-sf-text-secondary'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}
        </div>
        
        {/* Zoom in */}
        <button
          onClick={zoomIn}
          className="p-1.5 hover:bg-sf-dark-700 rounded transition-colors"
          title="Zoom In"
        >
          <ZoomIn className="w-3.5 h-3.5 text-sf-text-secondary" />
        </button>
        
        <div className="w-px h-4 bg-sf-dark-600" />
        
        {/* Pan indicator */}
        <div className="flex items-center gap-1 text-[10px] text-sf-text-muted">
          <Move className="w-3 h-3" />
          <span>Space+Drag</span>
        </div>
        
        <div className="w-px h-4 bg-sf-dark-600" />
        
        {/* Zoom indicator */}
        <div className="flex items-center gap-1 text-[10px] text-sf-text-muted">
          <ZoomIn className="w-3 h-3" />
          <span>Space+Ctrl+Drag L/R</span>
        </div>
      </div>
      
      {/* Context Menu (Portal). No overflow-auto here on purpose -- it
          would turn the menu into a scroll container that clips any
          absolutely-positioned submenu children (see Timeline.jsx). The
          viewport-clamped position keeps the menu on-screen for any
          reasonable window size. */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-sf-dark-800 border border-sf-dark-600 rounded-lg shadow-xl py-1 min-w-[150px]"
          style={{
            left: `${contextMenuPosition.x}px`,
            top: `${contextMenuPosition.y}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => handleContextAction('play')}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
          >
            {isPlaying ? (
              <>
                <Pause className="w-3.5 h-3.5" />
                <span>Pause</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                <span>Play</span>
              </>
            )}
            <span className="ml-auto text-sf-text-muted text-[10px]">Space</span>
          </button>
          
          <div className="h-px bg-sf-dark-600 my-1" />
          
          {currentPreview && previewMode === 'asset' && (
            <>
              <button
                onClick={() => handleContextAction('add-to-timeline')}
                className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add to Timeline</span>
              </button>
              <div className="h-px bg-sf-dark-600 my-1" />
            </>
          )}
          
          {previewMode === 'timeline' && getTopmostVideoOrImageClipAtTime(playheadPosition) && (
            <>
              <button
                onClick={() => handleContextAction('capture-still')}
                disabled={capturingStillFrame}
                className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors disabled:opacity-50"
              >
                <Camera className="w-3.5 h-3.5 text-sf-accent" />
                <span>{capturingStillFrame ? 'Saving Still...' : 'Capture Still'}</span>
              </button>
              <button
                onClick={() => handleContextAction('extend-with-ai')}
                disabled={capturingFrameForAI || capturingStillFrame}
                className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors disabled:opacity-50"
              >
                <Wand2 className="w-3.5 h-3.5 text-sf-accent" />
                <span>{capturingFrameForAI ? 'Capturing...' : 'Extend with AI'}</span>
              </button>
              <button
                onClick={() => handleContextAction('keyframe-for-ai')}
                disabled={capturingFrameForAI || capturingStillFrame}
                className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors disabled:opacity-50"
              >
                <Wand2 className="w-3.5 h-3.5 text-sf-accent" />
                <span>{capturingFrameForAI ? 'Capturing...' : 'Starting keyframe for AI'}</span>
              </button>
              <div className="h-px bg-sf-dark-600 my-1" />
            </>
          )}
          
          <button
            onClick={() => handleContextAction('zoom-fit')}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
          >
            <Home className="w-3.5 h-3.5" />
            <span>Fit to View</span>
          </button>
          
          <button
            onClick={() => handleContextAction('zoom-100')}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
          >
            <ZoomIn className="w-3.5 h-3.5" />
            <span>Zoom 100%</span>
          </button>
          
          <div className="h-px bg-sf-dark-600 my-1" />

          {previewMode === 'timeline' && (
            <>
              <button
                onClick={() => handleContextAction('toggle-transform-controls')}
                className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
              >
                {showPreviewTransformControls ? (
                  <EyeOff className="w-3.5 h-3.5" />
                ) : (
                  <Eye className="w-3.5 h-3.5" />
                )}
                <span>{showPreviewTransformControls ? 'Hide Transform Controls' : 'Show Transform Controls'}</span>
              </button>
              
              <div className="h-px bg-sf-dark-600 my-1" />
            </>
          )}
          
          <button
            onClick={() => handleContextAction('fullscreen')}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
          >
            {isFullscreen ? (
              <>
                <Minimize2 className="w-3.5 h-3.5" />
                <span>Exit Fullscreen</span>
              </>
            ) : (
              <>
                <Maximize2 className="w-3.5 h-3.5" />
                <span>Fullscreen</span>
              </>
            )}
            <span className="ml-auto text-sf-text-muted text-[10px]">F</span>
          </button>
        </div>
      )}
    </div>
  )
}

export default PreviewPanel
