import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import { getProjectFileUrl, isElectron } from './fileSystem'
import {
  FRAME_SAMPLING_MODE,
  OPTICAL_FLOW_CACHE_ENGINE,
  OPTICAL_FLOW_CACHE_MODEL,
  OPTICAL_FLOW_CACHE_VERSION,
  getOpticalFlowCacheUsability,
  getRequiredOpticalFlowHandleSeconds,
  getRequiredOpticalFlowSourceRange,
  getRequiredOpticalFlowTargetFps,
  getOpticalFlowSourceSignature,
  normalizeFrameSamplingMode,
  isSafeOpticalFlowCachePath,
} from '../utils/frameSampling'

const CACHE_DIR = 'cache'
const MAX_INTERPOLATED_FRAMES = 18000
const activeBuilds = new Map() // clipId -> { controller, jobId }

const safeFilename = (value) => String(value || 'clip')
  .replace(/[^a-zA-Z0-9_-]/g, '_')
  .slice(0, 80)

const errorMessage = (error) => error?.message || String(error || 'Optical-flow cache failed.')

const getAssetSourceIdentity = (asset) => JSON.stringify({
  id: asset?.id || null,
  path: asset?.path || null,
  absolutePath: asset?.absolutePath || null,
  url: asset?.url || null,
})

async function resolveAssetSourcePath(projectPath, asset) {
  if (asset?.absolutePath) return asset.absolutePath
  if (!asset?.path || !projectPath || !window.electronAPI?.pathJoin) return null
  return window.electronAPI.pathJoin(projectPath, asset.path)
}

async function buildSourceSignature(sourcePath) {
  if (!sourcePath || !window.electronAPI?.getFileInfo) return null
  try {
    const result = await window.electronAPI.getFileInfo(sourcePath)
    return getOpticalFlowSourceSignature(result)
  } catch {
    return null
  }
}

export function isOpticalFlowBuildActive(clipId) {
  return activeBuilds.has(clipId)
}

function getCurrentBuildClip(context) {
  const projectState = useProjectStore.getState()
  const timelineState = useTimelineStore.getState()
  if (projectState.currentProjectHandle !== context.projectPath) return null
  if (projectState.currentTimelineId !== context.timelineId) return null
  if (timelineState.timelineSessionId !== context.timelineSessionId) return null
  const clip = timelineState.clips.find((item) => item.id === context.clipId)
  if (clip?.assetId !== context.assetId) return null
  const asset = useAssetsStore.getState().getAssetById(clip.assetId)
  if (getAssetSourceIdentity(asset) !== context.sourceIdentity) return null
  if (context.jobId && clip.opticalFlowCache?.jobId !== context.jobId) return null
  return clip
}

function getBuildTimingContract(clip, timelineState, timelineFps, sourceFps) {
  if (!clip) return null
  const handleSeconds = getRequiredOpticalFlowHandleSeconds(
    clip,
    timelineState.transitions,
    timelineState.clips
  )
  const range = getRequiredOpticalFlowSourceRange(clip, { handleSeconds })
  const targetFps = getRequiredOpticalFlowTargetFps(clip, { timelineFps, sourceFps })
  return JSON.stringify({
    mode: normalizeFrameSamplingMode(clip.frameSampling),
    reverse: clip.reverse === true,
    sourceStart: Number(range.sourceStart.toFixed(6)),
    sourceEnd: Number(range.sourceEnd.toFixed(6)),
    targetFps: Number(targetFps.toFixed(6)),
  })
}

export async function buildOpticalFlowCache(clipId, options = {}) {
  const throwIfCanceled = () => { if (options.signal?.aborted) throw new Error('Optical Flow cancelled') }
  throwIfCanceled()
  if (activeBuilds.has(clipId)) {
    throw new Error('Optical-flow analysis is already running for this clip.')
  }
  if (!isElectron() || !window.electronAPI?.generateOpticalFlowCache) {
    throw new Error('Optical Flow is available in the Velorn desktop app only.')
  }

  const timelineState = useTimelineStore.getState()
  const projectState = useProjectStore.getState()
  const sourceTimelineId = projectState.currentTimelineId
  const clip = timelineState.clips.find((item) => item.id === clipId)
  if (!clip || clip.type !== 'video') throw new Error('Select a video clip to build Optical Flow.')
  if (clip.reverse) throw new Error('Optical Flow does not support reversed clips yet.')
  if (normalizeFrameSamplingMode(clip.frameSampling) !== FRAME_SAMPLING_MODE.OPTICAL_FLOW) {
    throw new Error('Choose Optical Flow in Frame Sampling first.')
  }

  const projectPath = projectState.currentProjectHandle
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('Save the project before building an Optical Flow cache.')
  }
  const asset = useAssetsStore.getState().getAssetById(clip.assetId)
  if (!asset) throw new Error('The source asset for this clip is missing.')
  if (asset?.settings?.hasAlpha === true) {
    throw new Error('Optical Flow does not support transparent video yet. Use Frame sampling for this clip.')
  }
  const assertSetupCurrent = () => {
    throwIfCanceled()
    const currentProject = useProjectStore.getState()
    const currentTimeline = useTimelineStore.getState()
    if (currentProject.currentProjectHandle !== projectPath || currentProject.currentTimelineId !== sourceTimelineId
      || currentTimeline.timelineSessionId !== timelineState.timelineSessionId
      || currentTimeline.clips.find(item => item.id === clipId) !== clip
      || useAssetsStore.getState().getAssetById(clip.assetId) !== asset) {
      throw new Error('The source clip changed while preparing Optical Flow. Start it again from the intended timeline.')
    }
  }

  const sourcePath = await resolveAssetSourcePath(projectPath, asset)
  assertSetupCurrent()
  if (!sourcePath) throw new Error('Optical Flow requires a local source file.')
  if (window.electronAPI?.exists && !(await window.electronAPI.exists(sourcePath))) {
    throw new Error('The source video is offline. Relink it before building Optical Flow.')
  }
  assertSetupCurrent()

  const timelineFps = Number(projectState.getCurrentTimelineSettings?.()?.fps)
    || Number(timelineState.timelineFps)
    || 24
  const sourceFps = Number(asset?.settings?.fps ?? asset?.fps ?? clip.sourceFps) || timelineFps
  const handleSeconds = getRequiredOpticalFlowHandleSeconds(
    clip,
    timelineState.transitions,
    timelineState.clips
  )
  const range = getRequiredOpticalFlowSourceRange(clip, { handleSeconds })
  const targetFps = getRequiredOpticalFlowTargetFps(clip, { timelineFps, sourceFps })
  if (targetFps <= sourceFps + 0.001) {
    throw new Error(
      'This clip already supplies at least one source frame per timeline frame. '
      + 'Slow it down to use Optical Flow.'
    )
  }
  const expectedFrames = Math.max(1, Math.round(range.duration * targetFps))
  if (!Number.isFinite(range.duration) || range.duration <= 0.04) {
    throw new Error('This clip does not have enough source media to interpolate.')
  }

  const cacheDirectory = await window.electronAPI.pathJoin(projectPath, CACHE_DIR)
  assertSetupCurrent()
  const createResult = await window.electronAPI.createDirectory(cacheDirectory)
  assertSetupCurrent()
  if (createResult?.success === false) {
    throw new Error(createResult.error || 'Could not create the project cache folder.')
  }

  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const filename = `optical_flow_${safeFilename(clip.id)}_${suffix}.mp4`
  const relativePath = `${CACHE_DIR}/${filename}`
  const outputPath = await window.electronAPI.pathJoin(projectPath, relativePath)
  assertSetupCurrent()
  const sourceSignature = await buildSourceSignature(sourcePath)
  assertSetupCurrent()
  if (!sourceSignature) {
    throw new Error('Velorn could not verify the source file before building Optical Flow. Relink it and try again.')
  }
  const jobId = `optical-flow-${safeFilename(clip.id)}-${suffix}`
  const controller = new AbortController()
  const buildContext = {
    projectPath,
    timelineId: sourceTimelineId,
    timelineSessionId: timelineState.timelineSessionId,
    clipId,
    assetId: clip.assetId,
    sourceIdentity: getAssetSourceIdentity(asset),
    timingContract: getBuildTimingContract(clip, timelineState, timelineFps, sourceFps),
    jobId,
  }
  const previousCache = clip.opticalFlowCache ? { ...clip.opticalFlowCache } : null
  activeBuilds.set(clipId, { controller, jobId, ...buildContext })

  useTimelineStore.getState().setOpticalFlowCache(clipId, {
    ...(previousCache || {}),
    version: OPTICAL_FLOW_CACHE_VERSION,
    engine: OPTICAL_FLOW_CACHE_ENGINE,
    modelName: OPTICAL_FLOW_CACHE_MODEL,
    status: 'rendering',
    progress: 0,
    error: null,
    jobId,
  })

  const removeProgressListener = window.electronAPI.onOpticalFlowProgress?.((progress = {}) => {
    if (progress.jobId !== jobId) return
    if (!getCurrentBuildClip(buildContext)) {
      controller.abort()
      return
    }
    const value = Math.max(0, Math.min(99, Number(progress.progress) || 0))
    useTimelineStore.getState().updateOpticalFlowCache(clipId, {
      status: 'rendering',
      progress: value,
      frame: Number(progress.frame) || 0,
      fps: Number(progress.fps) || 0,
      phase: typeof progress.phase === 'string' ? progress.phase : undefined,
    })
    options.onProgress?.(progress)
  })

  const abortNative = () => {
    window.electronAPI.cancelOpticalFlowCache?.(jobId).catch(() => {})
  }
  controller.signal.addEventListener('abort', abortNative, { once: true })
  const abortFromCaller = () => controller.abort()
  options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  if (options.signal?.aborted) controller.abort()
  const unsubscribeTimeline = useTimelineStore.subscribe((state) => {
    if (state.timelineSessionId !== buildContext.timelineSessionId) {
      controller.abort()
      return
    }
    const currentClip = state.clips.find((item) => item.id === buildContext.clipId)
    if (
      getBuildTimingContract(currentClip, state, timelineFps, sourceFps)
      !== buildContext.timingContract
    ) {
      controller.abort()
    }
  })
  const unsubscribeProject = useProjectStore.subscribe((state) => {
    if (
      state.currentProjectHandle !== buildContext.projectPath
      || state.currentTimelineId !== buildContext.timelineId
    ) {
      controller.abort()
    }
  })

  let completedOutputShouldBeRemoved = false

  try {
    if (controller.signal.aborted) throw new Error('Optical Flow cancelled')
    const result = await window.electronAPI.generateOpticalFlowCache({
      jobId,
      projectPath,
      inputPath: sourcePath,
      outputPath,
      sourceStart: range.sourceStart,
      sourceEnd: range.sourceEnd,
      targetFps,
      expectedDuration: range.duration,
      maxFrames: MAX_INTERPOLATED_FRAMES,
    })
    if (!result?.success) throw new Error(result?.error || 'Velorn could not build the smooth-motion cache.')
    completedOutputShouldBeRemoved = true
    if (controller.signal.aborted || result?.cancelled) throw new Error('Optical Flow cancelled')
    if (result.cleanupWarning) {
      console.warn(`[Optical Flow] ${result.cleanupWarning}`)
    }

    const latestClip = getCurrentBuildClip(buildContext)
    if (!latestClip) {
      throw new Error('The source clip changed before Optical Flow finished. The result was discarded.')
    }
    const latestAsset = useAssetsStore.getState().getAssetById(latestClip.assetId)
    const latestSourcePath = await resolveAssetSourcePath(projectPath, latestAsset)
    if (latestSourcePath !== sourcePath) {
      throw new Error('The source media was relinked before Optical Flow finished. The result was discarded.')
    }
    const latestSourceSignature = await buildSourceSignature(sourcePath)
    if (sourceSignature !== latestSourceSignature) {
      throw new Error('The source media changed before Optical Flow finished. Rebuild Optical Flow.')
    }

    const actualSourceStart = Number(result.sourceStart)
    const actualSourceEnd = Number(result.sourceEnd)
    const actualTargetFps = Number(result.targetFps) || targetFps
    const url = await getProjectFileUrl(projectPath, relativePath)
    if (controller.signal.aborted) throw new Error('Optical Flow cancelled')
    const currentBuildClip = getCurrentBuildClip(buildContext)
    if (!currentBuildClip || getBuildTimingContract(currentBuildClip, useTimelineStore.getState(), timelineFps, sourceFps) !== buildContext.timingContract) {
      throw new Error('The source clip changed before Optical Flow finished. The result was discarded.')
    }
    if (!url) throw new Error('Velorn could not open the completed Optical Flow cache.')
    const completedCache = {
      version: OPTICAL_FLOW_CACHE_VERSION,
      status: 'ready',
      progress: 100,
      path: relativePath,
      url,
      sourceStart: Number.isFinite(actualSourceStart) ? actualSourceStart : range.sourceStart,
      sourceEnd: Number.isFinite(actualSourceEnd) ? actualSourceEnd : range.sourceEnd,
      targetFps: actualTargetFps,
      requestedTargetFps: Number(result.requestedTargetFps) || targetFps,
      sourceSignature,
      engine: result.engine || OPTICAL_FLOW_CACHE_ENGINE,
      engineVersion: result.engineVersion || null,
      modelName: result.modelName || OPTICAL_FLOW_CACHE_MODEL,
      generatedAt: new Date().toISOString(),
      sourceFrameCount: Number(result.sourceFrameCount) || null,
      frameCount: Number(result.frameCount) || expectedFrames,
    }
    const latestTimelineState = useTimelineStore.getState()
    const latestHandleSeconds = getRequiredOpticalFlowHandleSeconds(
      latestClip,
      latestTimelineState.transitions,
      latestTimelineState.clips
    )
    const completedUsability = getOpticalFlowCacheUsability(
      { ...latestClip, opticalFlowCache: completedCache },
      { requireUrl: false, timelineFps, sourceFps, handleSeconds: latestHandleSeconds }
    )
    if (!completedUsability.usable) {
      throw new Error('The clip timing changed while Optical Flow was running. Rebuild it for the current timewarp.')
    }
    useTimelineStore.getState().setOpticalFlowCache(clipId, completedCache)
    completedOutputShouldBeRemoved = false

    // Cache files are immutable and descriptors may be shared by duplicated
    // clips or timelines. Do not eagerly delete the superseded derivative;
    // a future project-cache sweep can remove only files with no references.
    return completedCache
  } catch (error) {
    if (completedOutputShouldBeRemoved && window.electronAPI?.deleteFile) {
      try {
        await window.electronAPI.deleteFile(outputPath)
      } catch {
        // This path was uniquely allocated by this build. A failed cleanup is
        // left as an orphan rather than risking deletion outside project cache.
      }
    }
    const message = errorMessage(error)
    const currentClip = getCurrentBuildClip(buildContext)
    if (currentClip) {
      const currentAsset = useAssetsStore.getState().getAssetById(currentClip.assetId)
      const currentSourcePath = await resolveAssetSourcePath(projectPath, currentAsset)
      const currentSignature = currentSourcePath === sourcePath
        ? await buildSourceSignature(currentSourcePath)
        : null
      const sourceStillMatches = getAssetSourceIdentity(currentAsset) === buildContext.sourceIdentity
        && currentSourcePath === sourcePath
        && currentSignature === sourceSignature
      const currentTimelineState = useTimelineStore.getState()
      const currentHandleSeconds = currentClip
        ? getRequiredOpticalFlowHandleSeconds(
            currentClip,
            currentTimelineState.transitions,
            currentTimelineState.clips
          )
        : null
      const previousCacheStillUsable = previousCache?.path && currentClip
        ? getOpticalFlowCacheUsability(
            { ...currentClip, opticalFlowCache: previousCache },
            {
              requireUrl: false,
              timelineFps,
              sourceFps,
              handleSeconds: currentHandleSeconds,
            }
          ).usable
        : false
      if (previousCacheStillUsable && sourceStillMatches) {
        useTimelineStore.getState().setOpticalFlowCache(clipId, previousCache)
      } else if (previousCache?.path) {
        useTimelineStore.getState().setOpticalFlowCache(clipId, {
          ...previousCache,
          status: 'stale',
          progress: 0,
          url: undefined,
          error: 'The clip timing or source media changed. Rebuild Optical Flow.',
          jobId: undefined,
        })
      } else {
        useTimelineStore.getState().setOpticalFlowCache(clipId, {
          version: OPTICAL_FLOW_CACHE_VERSION,
          engine: OPTICAL_FLOW_CACHE_ENGINE,
          modelName: OPTICAL_FLOW_CACHE_MODEL,
          status: /cancelled/i.test(message) ? 'none' : 'failed',
          progress: 0,
          error: /cancelled/i.test(message) ? null : message,
        })
      }
    }
    throw error
  } finally {
    options.signal?.removeEventListener('abort', abortFromCaller)
    controller.signal.removeEventListener('abort', abortNative)
    if (typeof removeProgressListener === 'function') removeProgressListener()
    unsubscribeTimeline()
    unsubscribeProject()
    if (activeBuilds.get(clipId)?.jobId === jobId) activeBuilds.delete(clipId)
  }
}

export async function cancelOpticalFlowCache(clipId) {
  const active = activeBuilds.get(clipId)
  if (!active) return false
  active.controller.abort()
  return true
}

export async function hydrateOpticalFlowCaches(projectPath) {
  if (!projectPath || !isElectron() || !window.electronAPI?.exists) return
  const timelineState = useTimelineStore.getState()
  const timelineSessionId = timelineState.timelineSessionId
  const assetsState = useAssetsStore.getState()
  const candidates = timelineState.clips.flatMap(clip => clip?.type === 'compound'
    ? (Array.isArray(clip.compound?.document?.clips) ? clip.compound.document.clips : []).map(child => ({ clip: child, parentId: clip.id }))
    : [{ clip, parentId: null }])
    .filter(({ clip }) => clip?.type === 'video' && clip?.opticalFlowCache?.path && clip.opticalFlowCache.status === 'hydrating')

  for (const { clip, parentId } of candidates) {
    const cache = clip.opticalFlowCache
    const sourceIdentity = getAssetSourceIdentity(assetsState.getAssetById(clip.assetId))
    const findCurrentClip = state => {
      const clips = parentId
        ? state.clips.find(parent => parent.id === parentId && parent.type === 'compound')?.compound?.document?.clips || []
        : state.clips
      return clips.find(item => item.id === clip.id && item.assetId === clip.assetId)
    }
    const stillCurrentSession = () => {
      const currentTimeline = useTimelineStore.getState()
      const currentProjectPath = useProjectStore.getState().currentProjectHandle
      const currentClip = findCurrentClip(currentTimeline)
      return currentTimeline.timelineSessionId === timelineSessionId
        && (!currentProjectPath || currentProjectPath === projectPath)
        && currentClip?.opticalFlowCache?.path === cache.path
        && currentClip.opticalFlowCache?.status === 'hydrating'
        && !currentClip.opticalFlowCache?.jobId
        && getAssetSourceIdentity(useAssetsStore.getState().getAssetById(clip.assetId)) === sourceIdentity
    }
    const updateCache = patch => {
      if (!stillCurrentSession()) return
      if (!parentId) { useTimelineStore.getState().updateOpticalFlowCache(clip.id, patch); return }
      useTimelineStore.setState(state => ({ clips: state.clips.map(parent => parent.id !== parentId ? parent : {
        ...parent, compound: { ...parent.compound, document: { ...parent.compound.document,
          clips: parent.compound.document.clips.map(child => child.id !== clip.id ? child : {
            ...child, opticalFlowCache: { ...child.opticalFlowCache, ...patch },
          }),
        } },
      }) }))
    }
    try {
      if (!stillCurrentSession()) continue
      if (
        cache.version !== OPTICAL_FLOW_CACHE_VERSION
        || cache.engine !== OPTICAL_FLOW_CACHE_ENGINE
        || cache.modelName !== OPTICAL_FLOW_CACHE_MODEL
      ) {
        updateCache({
          status: 'stale',
          progress: 0,
          url: undefined,
          error: 'This cache was created by an older interpolation engine. Rebuild it from the Inspector.',
        })
        continue
      }
      if (!isSafeOpticalFlowCachePath(cache.path)) {
        updateCache({
          status: 'failed',
          progress: 0,
          url: undefined,
          error: 'The persisted Optical Flow cache path is invalid. Rebuild it from the Inspector.',
        })
        continue
      }
      const absoluteCachePath = await window.electronAPI.pathJoin(projectPath, cache.path)
      if (!stillCurrentSession()) continue
      if (!(await window.electronAPI.exists(absoluteCachePath))) {
        if (!stillCurrentSession()) continue
        updateCache({
          status: 'failed',
          progress: 0,
          url: undefined,
          error: 'The Optical Flow cache file is missing. Rebuild it from the Inspector.',
        })
        continue
      }

      const asset = assetsState.getAssetById(clip.assetId)
      const sourcePath = await resolveAssetSourcePath(projectPath, asset)
      const currentSignature = sourcePath ? await buildSourceSignature(sourcePath) : null
      if (!stillCurrentSession()) continue
      if (!cache.sourceSignature || cache.sourceSignature !== currentSignature) {
        updateCache({
          status: 'stale',
          progress: 0,
          url: undefined,
          error: 'The source file changed or could not be verified. Rebuild Optical Flow.',
        })
        continue
      }

      const url = await getProjectFileUrl(projectPath, cache.path)
      if (!stillCurrentSession()) continue
      updateCache({
        status: url ? 'ready' : 'failed',
        progress: url ? 100 : 0,
        url: url || undefined,
        error: url ? null : 'The Optical Flow cache could not be opened.',
      })
    } catch (error) {
      if (!stillCurrentSession()) continue
      updateCache({
        status: 'failed',
        progress: 0,
        url: undefined,
        error: errorMessage(error),
      })
    }
  }
}

export function getOpticalFlowClipStatus(clip, options = {}) {
  const timelineState = useTimelineStore.getState()
  const handleSeconds = options.handleSeconds ?? getRequiredOpticalFlowHandleSeconds(
    clip,
    timelineState.transitions,
    timelineState.clips
  )
  const usability = getOpticalFlowCacheUsability(clip, { ...options, handleSeconds })
  if (usability.usable) return { state: 'ready', ...usability }
  if (clip?.opticalFlowCache?.status === 'hydrating') return { state: 'hydrating', ...usability }
  if (clip?.opticalFlowCache?.status === 'rendering') return { state: 'rendering', ...usability }
  if (clip?.opticalFlowCache?.status === 'failed') return { state: 'failed', ...usability }
  if (clip?.opticalFlowCache?.path) return { state: 'stale', ...usability }
  return { state: 'missing', ...usability }
}
