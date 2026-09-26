/**
 * Playback cache service (Flame-style)
 * Transcodes imported video to a playback-optimized format (constant-FPS H.264,
 * keyframe every 6, no B-frames)
 * so timeline preview is smooth regardless of source format.
 */

import { isElectron } from './fileSystem'
import { getProjectFileUrl } from './fileSystem'
import { canUseOpaqueVideoDerivative } from '../utils/alphaMedia.mjs'
import { createMediaPreparationTarget } from '../utils/mediaPreparationTarget.mjs'

const CACHE_DIR = 'cache'
const PREFIX = 'playback_'
const EXT = '.mp4'
export const PLAYBACK_CACHE_VERSION = 'cfr_h264_kf6_v1'

/**
 * Sanitize asset id for use in filename
 */
function safeFilename(assetId) {
  if (!assetId || typeof assetId !== 'string') return 'asset'
  return assetId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
}

export function hasUsablePlaybackCache(asset) {
  return Boolean(
    canUseOpaqueVideoDerivative(asset)
    && asset?.playbackCacheStatus === 'ready'
    && asset?.playbackCachePath
    && asset?.playbackCacheVersion === PLAYBACK_CACHE_VERSION
  )
}

export function isPlaybackCacheableVideoAsset(asset) {
  if (!asset || asset.type !== 'video') return false
  // The H.264 playback-cache format has no alpha channel. Falling back to the
  // project-owned source is preferable to silently replacing transparency
  // with opaque pixels (notably for normalized animated GIFs).
  if (asset.settings?.hasAlpha === true) return false
  return Boolean(asset.absolutePath || asset.path)
}

async function resolveAssetSourcePath(projectDir, asset, { verifyExists = true } = {}) {
  let resolved = null
  if (asset?.absolutePath) {
    resolved = asset.absolutePath
  } else if (asset?.path && projectDir && window.electronAPI?.pathJoin) {
    try {
      resolved = await window.electronAPI.pathJoin(projectDir, asset.path)
    } catch {
      return null
    }
  }
  if (!resolved) return null

  if (verifyExists && window.electronAPI?.pathExists) {
    try {
      const exists = await window.electronAPI.pathExists(resolved)
      if (!exists) return null
    } catch {
      // Let ffmpeg make the final call if the existence check itself fails.
    }
  }
  return resolved
}

/**
 * Transcode a video file to playback-optimized format and save to project cache.
 * Same dimensions, constant-FPS H.264, keyframe every 6 frames, no B-frames.
 * @param {string} projectDir - Project directory path (Electron)
 * @param {string} assetId - Asset id (used for output filename)
 * @param {string} sourcePath - Absolute path to source video
 * @returns {Promise<{ success: boolean, relativePath?: string, error?: string }>}
 */
export async function transcodeVideoForPlayback(projectDir, assetId, sourcePath, options = {}) {
  if (!isElectron() || !window.electronAPI?.transcodeForPlayback) {
    return { success: false, error: 'Playback cache only available in Electron' }
  }

  const cacheDirPath = await window.electronAPI.pathJoin(projectDir, CACHE_DIR)
  await window.electronAPI.createDirectory(cacheDirPath)

  const cacheBustSuffix = options.cacheBust
    ? `_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    : ''
  const baseName = `${PREFIX}${safeFilename(assetId)}${cacheBustSuffix}${EXT}`
  const outputPath = await window.electronAPI.pathJoin(cacheDirPath, baseName)
  const relativePath = `${CACHE_DIR}/${baseName}`

  const result = await window.electronAPI.transcodeForPlayback({
    inputPath: sourcePath,
    outputPath,
    assetId,
    label: options.label,
  })

  if (!result.success) {
    return { success: false, error: result.error }
  }
  return { success: true, relativePath }
}

/**
 * Enqueue a transcode job and update the asset when done.
 * Call this after adding a video asset (import, AI generate, Pexels).
 * Runs in background; playback uses original until cache is ready.
 * @param {string} projectDir - Project directory path
 * @param {string} assetId - Asset id
 * @param {string} sourcePath - Absolute path to source video file
 */
export async function enqueuePlaybackTranscode(projectDir, assetId, sourcePath, options = {}) {
  if (!projectDir || !assetId || !sourcePath) {
    return { success: false, error: 'Missing playback cache input.' }
  }
  if (!isElectron()) {
    console.log('[PlaybackCache] Skipped (Electron only). Run the app with: npm run electron:dev')
    return { success: false, error: 'Playback cache only available in Electron' }
  }

  console.log('[PlaybackCache] Transcoding for smooth playback…', { assetId })

  const { useAssetsStore } = await import('../stores/assetsStore')
  const { useProjectStore } = await import('../stores/projectStore')
  const store = useAssetsStore.getState()
  const currentAsset = store.assets.find((asset) => asset.id === assetId)
  if (currentAsset && !isPlaybackCacheableVideoAsset(currentAsset)) {
    return { success: false, skipped: true, error: 'Alpha video uses its original source.' }
  }
  const target = createMediaPreparationTarget({
    projectDir, assetId, kind: 'playback', assetsStore: useAssetsStore, projectStore: useProjectStore,
  })
  if (!target.isCurrent()) {
    target.release()
    return { success: false, skipped: true, error: 'Playback cache target is no longer active.' }
  }
  const previousPlaybackCachePath = currentAsset?.playbackCachePath || ''
  store.setPlaybackCacheStatus?.(assetId, 'encoding')

  try {
    const result = await transcodeVideoForPlayback(projectDir, assetId, sourcePath, { ...options, label: currentAsset?.name })
    if (!target.isCurrent()) return result
    if (!result.success) {
      useAssetsStore.getState().setPlaybackCacheStatus?.(assetId, 'failed')
      console.warn('[PlaybackCache] Transcode failed:', result.error, { assetId })
      return result
    }

    const url = await getProjectFileUrl(projectDir, result.relativePath)
    if (!target.isCurrent()) return result
    useAssetsStore.getState().setPlaybackCache?.(assetId, result.relativePath, url, {
      version: PLAYBACK_CACHE_VERSION,
    })
    useAssetsStore.getState().setPlaybackCacheStatus?.(assetId, 'ready')
    console.log('[PlaybackCache] Ready — using cached file for playback:', { assetId, path: result.relativePath })
    if (
      previousPlaybackCachePath
      && previousPlaybackCachePath !== result.relativePath
      && window.electronAPI?.pathJoin
      && window.electronAPI?.deleteFile
    ) {
      try {
        const previousPath = await window.electronAPI.pathJoin(projectDir, previousPlaybackCachePath)
        await window.electronAPI.deleteFile(previousPath)
      } catch {
        // Chromium may briefly hold the old cache file on Windows. Leaving
        // that orphaned is safer than risking the newly-built cache.
      }
    }
    if (typeof localStorage !== 'undefined' && localStorage.getItem('comfystudio-debug-playback') === '1') {
      console.log('[PlaybackCache] (debug) URL:', url?.slice?.(0, 70) + '...')
    }
    return { success: true, relativePath: result.relativePath }
  } catch (err) {
    if (target.isCurrent()) useAssetsStore.getState().setPlaybackCacheStatus?.(assetId, 'failed')
    console.warn('[PlaybackCache] Transcode error:', err.message || err, { assetId })
    return { success: false, error: err.message || String(err) }
  } finally {
    target.release()
  }
}

export async function generatePlaybackCachesForAllVideos(projectDir, options = {}) {
  if (!isElectron()) {
    return { success: false, skipped: 0, encoded: 0, failed: 0, error: 'Electron only' }
  }
  if (!projectDir) {
    return { success: false, skipped: 0, encoded: 0, failed: 0, error: 'No project open' }
  }

  const { useAssetsStore } = await import('../stores/assetsStore')
  const allAssets = useAssetsStore.getState().assets || []
  const targetAssetIds = Array.isArray(options.assetIds) && options.assetIds.length > 0
    ? new Set(options.assetIds.filter(Boolean))
    : null
  const candidates = allAssets.filter((asset) => {
    if (targetAssetIds && !targetAssetIds.has(asset?.id)) return false
    if (!isPlaybackCacheableVideoAsset(asset)) return false
    if (asset?.playbackCacheStatus === 'encoding') return false
    if (options.force) return true
    if (asset?.playbackCacheStatus === 'failed') return false
    return !hasUsablePlaybackCache(asset)
  })

  let encoded = 0
  let failed = 0
  const videoCount = allAssets.filter((asset) => (
    asset?.type === 'video'
    && (!targetAssetIds || targetAssetIds.has(asset.id))
  )).length
  const skipped = videoCount - candidates.length

  for (const asset of candidates) {
    if (options.shouldAbort?.()) break
    options.onStart?.(asset)
    const sourcePath = await resolveAssetSourcePath(projectDir, asset)
    if (!sourcePath) {
      useAssetsStore.getState().setPlaybackCacheStatus?.(asset.id, 'failed')
      failed += 1
      options.onFinish?.(asset)
      continue
    }
    const result = await enqueuePlaybackTranscode(projectDir, asset.id, sourcePath, { cacheBust: Boolean(options.force) })
    const latest = useAssetsStore.getState().assets.find((item) => item.id === asset.id)
    if (result?.success && hasUsablePlaybackCache(latest)) encoded += 1
    else failed += 1
    options.onFinish?.(latest)
  }

  return { success: true, encoded, failed, skipped }
}
