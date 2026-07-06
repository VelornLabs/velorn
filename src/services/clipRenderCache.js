/**
 * Per-clip render cache ("render in place", Flame-style).
 *
 * renderClipToCache bakes ONE clip — with its speed, reverse, effects,
 * adjustments, masks, keyframed transform, and text/shape animation — into
 * an alpha-preserving VP9 webm in the project's cache folder, using the
 * same export pipeline that renders deliverables (so the bake is
 * pixel-identical to what export would produce for that clip).
 *
 * Contract: the baked file is a full-frame, timeline-rate video. Consumers
 * (CanvasPreviewRenderer, exporter) draw clips with cacheKind 'full'
 * identity — no transform/effects/adjustments re-applied — keeping only
 * opacity, blend mode, and transitions live. Any edit that changes the
 * baked output must flip cacheStatus to 'invalid' (see timelineStore
 * mutations), after which playback/export automatically fall back to the
 * live path until the user re-renders.
 */
import { exportTimeline } from './exporter'
import useTimelineStore from '../stores/timelineStore'
import useProjectStore from '../stores/projectStore'
import { getClipBakeSignature } from '../utils/clipBakeSignature'

const RENDERABLE_CLIP_TYPES = new Set(['video', 'image', 'text', 'shape'])
const CACHE_DIR = 'cache'

// One in-flight render per clip; used for cancel + to ignore double-clicks.
const activeClipRenders = new Map() // clipId -> AbortController

export const isClipRenderable = (clip) => !!clip && RENDERABLE_CLIP_TYPES.has(clip.type)

export const isClipRenderInProgress = (clipId) => activeClipRenders.has(clipId)

export const cancelClipRender = (clipId) => {
  const controller = activeClipRenders.get(clipId)
  if (controller) controller.abort()
}

export async function renderClipToCache(clipId, { onProgress = () => {} } = {}) {
  if (activeClipRenders.has(clipId)) return null
  const timelineState = useTimelineStore.getState()
  const projectState = useProjectStore.getState()
  const clip = timelineState.clips.find((c) => c.id === clipId)
  if (!clip) throw new Error('Clip not found')
  if (!isClipRenderable(clip)) throw new Error(`"${clip.type}" clips cannot be rendered to cache`)
  if (typeof window === 'undefined' || !window.electronAPI?.isElectron) {
    throw new Error('Clip render cache is available in the desktop app only')
  }
  const projectHandle = projectState.currentProjectHandle
  if (!projectHandle || typeof projectHandle !== 'string') {
    throw new Error('Open a project folder to render clips')
  }

  const settings = projectState.getCurrentTimelineSettings?.() || {}
  const width = Math.max(2, Math.round(Number(settings.width) || 1920))
  const height = Math.max(2, Math.round(Number(settings.height) || 1080))
  const fps = Math.max(1, Number(settings.fps) || 24)

  const controller = new AbortController()
  activeClipRenders.set(clipId, controller)
  timelineState.setCacheStatus(clipId, 'rendering', 0)

  // Captured BEFORE rendering: if the user edits the clip mid-render, the
  // stored signature won't match the edited clip and the bake reads stale.
  const bakeSignature = getClipBakeSignature(clip)
  const cachePath = `${CACHE_DIR}/render_full_${clipId}_${Date.now()}.webm`

  try {
    await window.electronAPI.createDirectory(await window.electronAPI.pathJoin(projectHandle, CACHE_DIR))
    const outputPath = await window.electronAPI.pathJoin(projectHandle, cachePath)

    await exportTimeline({
      soloClipIds: [clipId],
      transparent: true,
      format: 'webm',
      outputPath,
      filename: `render_full_${clipId}`,
      width,
      height,
      fps,
      sourceTimelineWidth: width,
      sourceTimelineHeight: height,
      rangeStart: clip.startTime,
      rangeEnd: clip.startTime + clip.duration,
      includeAudio: false,
      useCachedRenders: false,
      useProxyMedia: false,
      glslQualityScale: 1,
      signal: controller.signal,
    }, (progressInfo) => {
      const progress = Math.max(0, Math.min(100, Number(progressInfo?.progress) || 0))
      useTimelineStore.getState().setCacheStatus(clipId, 'rendering', progress)
      onProgress(progressInfo)
    })

    const { getProjectFileUrl } = await import('./fileSystem')
    const url = await getProjectFileUrl(projectHandle, cachePath)
    if (!url) throw new Error('Failed to resolve cached render URL')
    useTimelineStore.getState().setCacheUrl(clipId, url, cachePath, 'full', bakeSignature)
    return { url, cachePath }
  } catch (err) {
    const latest = useTimelineStore.getState().clips.find((c) => c.id === clipId)
    useTimelineStore.getState().setCacheStatus(clipId, latest?.cacheUrl ? 'invalid' : 'none', 0)
    throw err
  } finally {
    activeClipRenders.delete(clipId)
  }
}

/**
 * Re-resolve file URLs for baked clips after a project loads. cacheUrl is
 * session-scoped (may be stale or stripped); cachePath persists. Without
 * this pass, clips marked 'cached' silently play the live path after a
 * restart.
 */
export async function hydrateClipRenderCaches(projectPath) {
  if (!projectPath || typeof window === 'undefined' || !window.electronAPI?.isElectron) return
  const timelineState = useTimelineStore.getState()
  const candidates = timelineState.clips.filter((clip) => (
    clip?.cachePath
    && clip.cacheStatus === 'cached'
    && (!clip.cacheUrl || String(clip.cacheUrl).startsWith('blob:'))
  ))
  if (candidates.length === 0) return

  const { getProjectFileUrl } = await import('./fileSystem')
  for (const clip of candidates) {
    try {
      const absolutePath = await window.electronAPI.pathJoin(projectPath, clip.cachePath)
      if (!(await window.electronAPI.exists(absolutePath))) {
        useTimelineStore.getState().setCacheStatus(clip.id, 'none', 0)
        continue
      }
      const url = await getProjectFileUrl(projectPath, clip.cachePath)
      if (url) {
        useTimelineStore.getState().setCacheUrl(clip.id, url, clip.cachePath, clip.cacheKind || null, clip.cacheSignature || null)
      }
    } catch (err) {
      console.warn(`Failed to hydrate render cache for clip ${clip.id}:`, err)
    }
  }
}
