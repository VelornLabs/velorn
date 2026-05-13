/**
 * Preview cache (flattened timeline proxy)
 * Renders the current timeline to a single H.264 file for smooth playback when many layers are active.
 * Electron only; reuses export pipeline with playback-friendly encoding.
 */

import { isElectron } from './fileSystem'
import { exportTimeline } from './exporter'
import useTimelineStore from '../stores/timelineStore'
import useProjectStore from '../stores/projectStore'
import useAssetsStore from '../stores/assetsStore'
import { normalizeAdjustmentSettings } from '../utils/adjustments'
import { normalizeClipCompositeMode } from '../utils/layerCompositing'

const CACHE_DIR = 'cache'
const PREFIX = 'preview_'
const CHUNK_PREFIX = 'preview_chunk_'
const EXT = '.mp4'
const PREVIEW_RENDER_VERSION = 2
const DEFAULT_AUTO_THRESHOLD = {
  minConcurrentVideoLayers: 3,
  minComplexityScore: 18,
  minVideoClips: 6,
}

let activeRenderPromise = null
let activeRenderSignature = null

/** Simple string hash for signature (djb2) */
function hashString(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) + str.charCodeAt(i)
  }
  return (h >>> 0).toString(36).slice(0, 12)
}

function roundNumber(value, precision = 4) {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return Number(num.toFixed(precision))
}

function sanitizeText(value, max = 512) {
  if (typeof value !== 'string') return ''
  return value.slice(0, max)
}

function stableSerialize(value) {
  const seen = new WeakSet()
  const normalize = (input) => {
    if (input == null) return null
    if (Array.isArray(input)) return input.map(normalize)
    if (typeof input === 'object') {
      if (seen.has(input)) return '[Circular]'
      seen.add(input)
      const out = {}
      for (const key of Object.keys(input).sort()) {
        out[key] = normalize(input[key])
      }
      return out
    }
    if (typeof input === 'number') return roundNumber(input, 6)
    if (typeof input === 'string') return sanitizeText(input, 4096)
    if (typeof input === 'boolean') return input
    return String(input)
  }
  try {
    return JSON.stringify(normalize(value))
  } catch {
    return ''
  }
}

function safeTimelineId(timelineId) {
  if (!timelineId || typeof timelineId !== 'string') return 'timeline'
  return timelineId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
}

function buildClipSignature(clip) {
  if (!clip || typeof clip !== 'object') return null
  const transform = clip.transform || {}
  const effects = Array.isArray(clip.effects)
    ? clip.effects
      .filter((effect) => effect && effect.enabled !== false)
      .map((effect) => ({
        id: effect.id || null,
        type: effect.type || null,
        enabled: effect.enabled !== false,
        maskAssetId: effect.maskAssetId || null,
        invertMask: Boolean(effect.invertMask),
        // Include settings to avoid stale proxy when effect controls change.
        settings: effect.settings || null,
      }))
      .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')))
    : []

  const textProperties = clip.textProperties
    ? {
      text: sanitizeText(clip.textProperties.text || '', 1200),
      fontFamily: clip.textProperties.fontFamily || null,
      fontSize: roundNumber(clip.textProperties.fontSize),
      fontWeight: clip.textProperties.fontWeight || null,
      fontStyle: clip.textProperties.fontStyle || null,
      textAlign: clip.textProperties.textAlign || null,
      verticalAlign: clip.textProperties.verticalAlign || null,
      textColor: clip.textProperties.textColor || null,
      backgroundColor: clip.textProperties.backgroundColor || null,
      backgroundOpacity: roundNumber(clip.textProperties.backgroundOpacity),
      strokeColor: clip.textProperties.strokeColor || null,
      strokeWidth: roundNumber(clip.textProperties.strokeWidth),
      lineHeight: roundNumber(clip.textProperties.lineHeight),
      letterSpacing: roundNumber(clip.textProperties.letterSpacing),
      shadow: Boolean(clip.textProperties.shadow),
      animationPreset: clip.textProperties.animationPreset || null,
      customKeyframes: Array.isArray(clip.textProperties.customKeyframes)
        ? clip.textProperties.customKeyframes.map((keyframe) => ({
          time: roundNumber(keyframe.time),
          value: keyframe.value ?? null,
        }))
        : [],
    }
    : null

  return {
    id: clip.id || null,
    trackId: clip.trackId || null,
    assetId: clip.assetId || null,
    type: clip.type || null,
    compositeLowerLayers: normalizeClipCompositeMode(clip.compositeLowerLayers),
    enabled: clip.enabled !== false,
    startTime: roundNumber(clip.startTime),
    duration: roundNumber(clip.duration),
    trimStart: roundNumber(clip.trimStart),
    trimEnd: roundNumber(clip.trimEnd),
    sourceDuration: roundNumber(clip.sourceDuration),
    sourceTimeScale: roundNumber(clip.sourceTimeScale),
    sourceFps: roundNumber(clip.sourceFps),
    timelineFps: roundNumber(clip.timelineFps),
    speed: roundNumber(clip.speed),
    reverse: Boolean(clip.reverse),
    transform: {
      positionX: roundNumber(transform.positionX),
      positionY: roundNumber(transform.positionY),
      scaleX: roundNumber(transform.scaleX),
      scaleY: roundNumber(transform.scaleY),
      rotation: roundNumber(transform.rotation),
      opacity: roundNumber(transform.opacity),
      anchorX: roundNumber(transform.anchorX),
      anchorY: roundNumber(transform.anchorY),
      flipH: Boolean(transform.flipH),
      flipV: Boolean(transform.flipV),
      cropTop: roundNumber(transform.cropTop),
      cropBottom: roundNumber(transform.cropBottom),
      cropLeft: roundNumber(transform.cropLeft),
      cropRight: roundNumber(transform.cropRight),
      blendMode: transform.blendMode || 'normal',
      blur: roundNumber(transform.blur),
    },
    adjustments: (clip.type === 'adjustment' || clip.type === 'video' || clip.type === 'image' || clip.type === 'text')
      ? normalizeAdjustmentSettings(clip.adjustments || {})
      : null,
    effects,
    textProperties,
  }
}

function buildTrackSignature(track) {
  if (!track || typeof track !== 'object') return null
  return {
    id: track.id || null,
    name: track.name || null,
    type: track.type || null,
    visible: track.visible !== false,
    muted: Boolean(track.muted),
    locked: Boolean(track.locked),
    channels: track.channels || null,
  }
}

function buildTransitionSignature(transition) {
  if (!transition || typeof transition !== 'object') return null
  return {
    id: transition.id || null,
    type: transition.type || null,
    kind: transition.kind || null,
    alignment: transition.alignment || null,
    startTime: roundNumber(transition.startTime),
    endTime: roundNumber(transition.endTime),
    duration: roundNumber(transition.duration),
    clipAId: transition.clipAId || null,
    clipBId: transition.clipBId || null,
    settings: transition.settings || null,
  }
}

function buildAssetSignature(asset, assetId) {
  if (!asset || typeof asset !== 'object') {
    return { id: assetId || null, missing: true }
  }

  const sourceRef = asset.path || asset.absolutePath || asset.url || null
  return {
    id: asset.id || assetId || null,
    type: asset.type || null,
    mimeType: asset.mimeType || null,
    size: roundNumber(asset.size, 0),
    duration: roundNumber(asset.duration),
    sourceRef: sourceRef ? sanitizeText(String(sourceRef), 2048) : null,
    settingsHash: hashString(stableSerialize(asset.settings || {})),
  }
}

function getVisibleVideoTrackIds(tracks = []) {
  return new Set(
    tracks
      .filter((track) => track?.type === 'video' && track.visible !== false)
      .map((track) => track.id)
  )
}

function getMaxConcurrentVideoLayers(clips = [], tracks = []) {
  const visibleVideoTrackIds = getVisibleVideoTrackIds(tracks)
  if (visibleVideoTrackIds.size === 0) return 0

  const events = []
  for (const clip of clips || []) {
    if (!clip || clip.type !== 'video') continue
    if (clip.enabled === false) continue
    if (!visibleVideoTrackIds.has(clip.trackId)) continue
    const startTime = Number(clip.startTime)
    const duration = Number(clip.duration)
    if (!Number.isFinite(startTime) || !Number.isFinite(duration) || duration <= 0) continue
    const endTime = startTime + duration
    events.push({ time: startTime, delta: 1 })
    events.push({ time: endTime, delta: -1 })
  }

  if (events.length === 0) return 0

  // End events (-1) are processed before start events (+1) at identical timestamps.
  events.sort((a, b) => (a.time - b.time) || (a.delta - b.delta))

  let active = 0
  let maxActive = 0
  for (const event of events) {
    active += event.delta
    if (active > maxActive) maxActive = active
  }
  return maxActive
}

export function getPreviewComplexity(timelineState) {
  const clips = Array.isArray(timelineState?.clips) ? timelineState.clips : []
  const tracks = Array.isArray(timelineState?.tracks) ? timelineState.tracks : []
  const transitions = Array.isArray(timelineState?.transitions) ? timelineState.transitions : []

  const trackById = new Map(tracks.map((track) => [track.id, track]))
  let videoClipCount = 0
  let audioClipCount = 0
  let textClipCount = 0
  let effectCount = 0
  let maskEffectCount = 0

  for (const clip of clips) {
    if (!clip) continue
    if (clip.enabled === false) continue
    const track = trackById.get(clip.trackId)
    if (clip.type === 'video' && track?.type === 'video' && track.visible !== false) {
      videoClipCount += 1
    } else if (clip.type === 'audio' && track?.type === 'audio' && track.visible !== false) {
      audioClipCount += 1
    } else if (clip.type === 'text') {
      textClipCount += 1
    }

    const enabledEffects = Array.isArray(clip.effects)
      ? clip.effects.filter((effect) => effect && effect.enabled !== false)
      : []
    effectCount += enabledEffects.length
    maskEffectCount += enabledEffects.filter((effect) => effect.type === 'mask').length
  }

  const maxConcurrentVideoLayers = getMaxConcurrentVideoLayers(clips, tracks)
  const complexityScore = (
    videoClipCount * 2
    + textClipCount * 1.2
    + transitions.length * 1.5
    + effectCount * 2.5
    + Math.max(0, maxConcurrentVideoLayers - 1) * 5
  )

  return {
    videoClipCount,
    audioClipCount,
    textClipCount,
    transitionCount: transitions.length,
    effectCount,
    maskEffectCount,
    maxConcurrentVideoLayers,
    complexityScore: roundNumber(complexityScore, 2) || 0,
  }
}

export function shouldAutoGeneratePreviewProxy(timelineState, threshold = {}) {
  const complexity = getPreviewComplexity(timelineState)
  const opts = {
    ...DEFAULT_AUTO_THRESHOLD,
    ...(threshold || {}),
  }

  if (complexity.maxConcurrentVideoLayers >= opts.minConcurrentVideoLayers) return true
  if (complexity.complexityScore >= opts.minComplexityScore) return true
  if (complexity.videoClipCount >= opts.minVideoClips && complexity.effectCount > 0) return true
  return false
}

async function cleanupOldTimelinePreviewProxies(projectHandle, timelineId, keepRelativePath) {
  if (!projectHandle || !window.electronAPI?.listDirectory) return
  try {
    const cacheDir = await window.electronAPI.pathJoin(projectHandle, CACHE_DIR)
    const listed = await window.electronAPI.listDirectory(cacheDir)
    if (!listed?.success || !Array.isArray(listed.items)) return

    const safeId = safeTimelineId(timelineId)
    const keepName = String((keepRelativePath || '').split(/[\\/]/).pop() || '')
    const prefix = `${PREFIX}${safeId}_`

    for (const entry of listed.items) {
      if (!entry?.isFile) continue
      if (!entry.name.startsWith(prefix)) continue
      if (!entry.name.endsWith(EXT)) continue
      if (entry.name === keepName) continue
      await window.electronAPI.deleteFile(entry.path)
    }
  } catch (err) {
    console.warn('[PreviewCache] Failed to clean stale preview proxies:', err?.message || err)
  }
}

/**
 * Compute a signature for the current timeline state. When this changes, the preview proxy is invalid.
 */
export function computePreviewSignature(timelineId, timelineState) {
  if (!timelineId || !timelineState) return ''
  const clips = (timelineState.clips || [])
    .map((clip) => buildClipSignature(clip))
    .filter(Boolean)
    .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')))
  const tracks = (timelineState.tracks || [])
    .map((track) => buildTrackSignature(track))
    .filter(Boolean)
  const transitions = (timelineState.transitions || [])
    .map((transition) => buildTransitionSignature(transition))
    .filter(Boolean)
    .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')))
  const referencedAssetIds = Array.from(
    new Set(
      clips
        .map((clip) => clip.assetId)
        .filter(Boolean)
    )
  )
  const sourceAssets = Array.isArray(timelineState.assets)
    ? timelineState.assets
    : (useAssetsStore.getState().assets || [])
  const assetsById = new Map(
    sourceAssets
      .filter((asset) => asset && asset.id)
      .map((asset) => [asset.id, asset])
  )
  const assets = referencedAssetIds
    .map((assetId) => buildAssetSignature(assetsById.get(assetId), assetId))
    .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')))

  const payload = JSON.stringify({
    timelineId,
    previewRenderVersion: PREVIEW_RENDER_VERSION,
    duration: roundNumber(timelineState.duration),
    timelineFps: roundNumber(timelineState.timelineFps),
    clips,
    tracks,
    transitions,
    assets,
  })
  return hashString(payload)
}

/**
 * Get the relative path for a preview proxy file (cache/preview_<timelineId>_<signature>.mp4)
 */
export function getPreviewProxyRelativePath(timelineId, signature) {
  if (!timelineId || !signature) return null
  return `${CACHE_DIR}/${PREFIX}${safeTimelineId(timelineId)}_${signature}${EXT}`
}

function getPreviewChunkFrameRange(rangeStart, rangeEnd, fps) {
  const safeFps = Math.max(1, Number(fps) || 24)
  const startFrame = Math.max(0, Math.round((Number(rangeStart) || 0) * safeFps))
  const endFrame = Math.max(startFrame + 1, Math.round((Number(rangeEnd) || 0) * safeFps))
  return { startFrame, endFrame, fps: safeFps }
}

export function getPreviewChunkRelativePath(timelineId, signature, rangeStart, rangeEnd, fps) {
  if (!timelineId || !signature) return null
  const { startFrame, endFrame } = getPreviewChunkFrameRange(rangeStart, rangeEnd, fps)
  return `${CACHE_DIR}/${CHUNK_PREFIX}${safeTimelineId(timelineId)}_${signature}_${startFrame}_${endFrame}${EXT}`
}

/**
 * Check if a preview proxy file exists on disk for the current timeline state.
 * @returns {Promise<{ path: string, url?: string }|null>} Relative path and optional file URL, or null
 */
export async function getPreviewProxyPath(projectHandle, timelineId, timelineStateOverride = null) {
  if (!isElectron() || !projectHandle || !timelineId) return null
  const timelineState = timelineStateOverride || useTimelineStore.getState()
  const signature = computePreviewSignature(timelineId, timelineState)
  const relativePath = getPreviewProxyRelativePath(timelineId, signature)
  if (!relativePath) return null
  try {
    const fullPath = await window.electronAPI.pathJoin(projectHandle, relativePath)
    const exists = await window.electronAPI.exists(fullPath)
    if (!exists) return null
    const url = await window.electronAPI.getFileUrlDirect(fullPath)
    return { path: relativePath, fullPath, url }
  } catch {
    return null
  }
}

/**
 * Check if a chunked preview-cache file exists on disk for the current timeline state.
 * @returns {Promise<{ path: string, url?: string, rangeStart: number, rangeEnd: number, signature: string }|null>}
 */
export async function getPreviewChunkPath(projectHandle, timelineId, rangeStart, rangeEnd, timelineStateOverride = null) {
  if (!isElectron() || !projectHandle || !timelineId) return null
  const timelineState = timelineStateOverride || useTimelineStore.getState()
  const timelineSettings = useProjectStore.getState().getCurrentTimelineSettings?.() || { fps: 24 }
  const signature = computePreviewSignature(timelineId, timelineState)
  const relativePath = getPreviewChunkRelativePath(timelineId, signature, rangeStart, rangeEnd, timelineSettings.fps ?? 24)
  if (!relativePath) return null
  try {
    const fullPath = await window.electronAPI.pathJoin(projectHandle, relativePath)
    const exists = await window.electronAPI.exists(fullPath)
    if (!exists) return null
    const url = await window.electronAPI.getFileUrlDirect(fullPath)
    return { path: relativePath, fullPath, url, rangeStart, rangeEnd, signature }
  } catch {
    return null
  }
}

/**
 * Render the current timeline to a preview proxy file (flattened H.264 for smooth playback).
 * Runs in background; use onProgress for UI. Invalidates any previous proxy for this timeline.
 * @param {object} onProgress - { status, progress } callback
 * @returns {Promise<{ path: string, url: string }|{ error: string }>}
 */
export async function renderPreviewProxy(onProgress = () => {}, options = {}) {
  if (!isElectron() || !window.electronAPI?.pathJoin) {
    return { error: 'Preview cache is only available in Electron. Run: npm run electron:dev' }
  }

  const projectState = useProjectStore.getState()
  const projectHandle = projectState.currentProjectHandle
  const currentTimelineId = projectState.currentTimelineId
  if (!projectHandle || typeof projectHandle !== 'string') {
    return { error: 'No project folder open.' }
  }
  if (!currentTimelineId) {
    return { error: 'No timeline selected.' }
  }

  const timelineState = useTimelineStore.getState()
  const timelineSettings = projectState.getCurrentTimelineSettings?.() || { width: 1920, height: 1080, fps: 24 }
  const signature = computePreviewSignature(currentTimelineId, timelineState)
  const relativePath = getPreviewProxyRelativePath(currentTimelineId, signature)
  const force = Boolean(options?.force)
  const signal = options?.signal || null
  if (signal?.aborted) {
    return { error: 'Preview render cancelled.' }
  }
  if (!relativePath) {
    return { error: 'Could not compute preview signature.' }
  }

  if (!force) {
    const existing = await getPreviewProxyPath(projectHandle, currentTimelineId, timelineState)
    if (existing?.path && existing?.url) {
      return { ...existing, signature, reused: true }
    }
  }
  const renderKey = `proxy:${signature}`
  if (activeRenderPromise) {
    if (activeRenderSignature === renderKey) {
      return await activeRenderPromise
    }
    return { error: 'A smooth preview render is already in progress.' }
  }

  const cacheDir = await window.electronAPI.pathJoin(projectHandle, CACHE_DIR)
  await window.electronAPI.createDirectory(cacheDir)
  const outputPath = await window.electronAPI.pathJoin(projectHandle, relativePath)

  const renderPromise = (async () => {
    await exportTimeline(
      {
        outputPath,
        width: timelineSettings.width ?? 1920,
        height: timelineSettings.height ?? 1080,
        fps: timelineSettings.fps ?? 24,
        rangeStart: 0,
        rangeEnd: timelineState.getTimelineEndTime?.(),
        format: 'mp4',
        includeAudio: true,
        videoCodec: 'h264',
        keyframeInterval: 6,
        preset: 'fast',
        crf: 23,
        useCachedRenders: true,
        fastSeek: true,
        signal,
      },
      onProgress
    )
    const url = await window.electronAPI.getFileUrlDirect(outputPath)
    await cleanupOldTimelinePreviewProxies(projectHandle, currentTimelineId, relativePath)
    return { path: relativePath, url, signature }
  })().catch((err) => ({ error: err?.message || String(err) }))

  activeRenderPromise = renderPromise
  activeRenderSignature = renderKey
  try {
    return await renderPromise
  } finally {
    if (activeRenderPromise === renderPromise) {
      activeRenderPromise = null
      activeRenderSignature = null
    }
  }
}

/**
 * Render a short flattened timeline chunk for immediate smooth playback.
 * The chunk intentionally omits audio; the preview panel keeps using live
 * timeline audio so cached chunks can be swapped in and out without audio
 * handoff glitches.
 */
export async function renderPreviewChunk(rangeStart, rangeEnd, onProgress = () => {}, options = {}) {
  if (!isElectron() || !window.electronAPI?.pathJoin) {
    return { error: 'Preview cache is only available in Electron. Run: npm run electron:dev' }
  }

  const safeStart = Math.max(0, Number(rangeStart) || 0)
  const safeEnd = Math.max(safeStart, Number(rangeEnd) || 0)
  if (safeEnd - safeStart <= 0.05) {
    return { error: 'Preview chunk range is too short.' }
  }

  const projectState = useProjectStore.getState()
  const projectHandle = projectState.currentProjectHandle
  const currentTimelineId = projectState.currentTimelineId
  if (!projectHandle || typeof projectHandle !== 'string') {
    return { error: 'No project folder open.' }
  }
  if (!currentTimelineId) {
    return { error: 'No timeline selected.' }
  }

  const timelineState = useTimelineStore.getState()
  const timelineSettings = projectState.getCurrentTimelineSettings?.() || { width: 1920, height: 1080, fps: 24 }
  const signature = computePreviewSignature(currentTimelineId, timelineState)
  const relativePath = getPreviewChunkRelativePath(
    currentTimelineId,
    signature,
    safeStart,
    safeEnd,
    timelineSettings.fps ?? 24
  )
  const force = Boolean(options?.force)
  if (!relativePath) {
    return { error: 'Could not compute preview chunk path.' }
  }

  if (!force) {
    const existing = await getPreviewChunkPath(projectHandle, currentTimelineId, safeStart, safeEnd, timelineState)
    if (existing?.path && existing?.url) {
      return { ...existing, signature, reused: true }
    }
  }
  const renderKey = `chunk:${signature}:${safeStart}:${safeEnd}`
  if (activeRenderPromise) {
    if (activeRenderSignature === renderKey) {
      return await activeRenderPromise
    }
    return { error: 'A smooth preview render is already in progress.' }
  }

  const cacheDir = await window.electronAPI.pathJoin(projectHandle, CACHE_DIR)
  await window.electronAPI.createDirectory(cacheDir)
  const outputPath = await window.electronAPI.pathJoin(projectHandle, relativePath)

  const renderPromise = (async () => {
    await exportTimeline(
      {
        outputPath,
        width: timelineSettings.width ?? 1920,
        height: timelineSettings.height ?? 1080,
        fps: timelineSettings.fps ?? 24,
        rangeStart: safeStart,
        rangeEnd: safeEnd,
        format: 'mp4',
        includeAudio: false,
        videoCodec: 'h264',
        keyframeInterval: 6,
        preset: 'fast',
        crf: 23,
        useCachedRenders: true,
        useProxyMedia: Boolean(options?.useProxyMedia),
        glslQualityScale: Math.max(0.05, Math.min(1, Number(options?.glslQualityScale) || 1)),
        fastSeek: true,
        signal: options?.signal || null,
      },
      onProgress
    )
    const url = await window.electronAPI.getFileUrlDirect(outputPath)
    return {
      path: relativePath,
      fullPath: outputPath,
      url,
      signature,
      rangeStart: safeStart,
      rangeEnd: safeEnd,
    }
  })().catch((err) => ({ error: err?.message || String(err) }))

  activeRenderPromise = renderPromise
  activeRenderSignature = renderKey
  try {
    return await renderPromise
  } finally {
    if (activeRenderPromise === renderPromise) {
      activeRenderPromise = null
      activeRenderSignature = null
    }
  }
}
