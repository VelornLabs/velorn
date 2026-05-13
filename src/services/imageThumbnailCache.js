import { isElectron } from './fileSystem'

const IMAGE_THUMB_DIR = 'thumbnails/images'
const DEFAULT_WIDTH = 360
const DEFAULT_HEIGHT = 204
const DEFAULT_QUALITY = 78
const pendingThumbnails = new Map()

function hashString(value) {
  let hash = 5381
  const input = String(value || '')
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) + input.charCodeAt(index)
  }
  return (hash >>> 0).toString(36)
}

function safeName(value) {
  return String(value || 'image')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'image'
}

function fileUrlToPath(url) {
  if (!url || !String(url).startsWith('file://')) return null
  try {
    const parsed = new URL(url)
    return decodeURIComponent(parsed.pathname || '')
  } catch {
    return String(url).replace(/^file:\/\//, '')
  }
}

function getSourcePath(projectHandle, asset) {
  if (!asset) return null
  if (asset.path && projectHandle && window.electronAPI?.pathJoin) {
    return window.electronAPI.pathJoin(projectHandle, asset.path)
  }
  if (asset.absolutePath) return asset.absolutePath
  if (asset.url) return fileUrlToPath(asset.url)
  return null
}

function getThumbnailKey(asset, options) {
  const sourceRef = asset?.path || asset?.absolutePath || asset?.url || asset?.id || ''
  const versionRef = asset?.modified || asset?.updatedAt || asset?.createdAt || asset?.size || ''
  const sizeRef = `${options.width}x${options.height}q${options.quality}`
  return `${safeName(asset?.id || asset?.name || 'image')}_${hashString(`${sourceRef}|${versionRef}|${sizeRef}`)}.jpg`
}

export async function getOrCreateImageThumbnail(projectHandle, asset, options = {}) {
  const sourceUrl = asset?.url || asset?.thumbnailUrl || ''
  if (!sourceUrl) return null
  if (!isElectron() || !projectHandle || !window.electronAPI?.createImageThumbnail) {
    return sourceUrl
  }

  const width = Math.max(1, Math.round(Number(options.width) || DEFAULT_WIDTH))
  const height = Math.max(1, Math.round(Number(options.height) || DEFAULT_HEIGHT))
  const quality = Math.max(1, Math.min(100, Math.round(Number(options.quality) || DEFAULT_QUALITY)))
  const key = getThumbnailKey(asset, { width, height, quality })
  const pendingKey = `${projectHandle}|${key}`
  if (pendingThumbnails.has(pendingKey)) return pendingThumbnails.get(pendingKey)

  const promise = (async () => {
    try {
      const thumbDir = await window.electronAPI.pathJoin(projectHandle, IMAGE_THUMB_DIR)
      await window.electronAPI.createDirectory(thumbDir)
      const outputPath = await window.electronAPI.pathJoin(thumbDir, key)
      if (await window.electronAPI.exists(outputPath)) {
        return await window.electronAPI.getFileUrlDirect(outputPath)
      }

      const sourcePath = await getSourcePath(projectHandle, asset)
      if (!sourcePath || !(await window.electronAPI.exists(sourcePath))) {
        return sourceUrl
      }

      const result = await window.electronAPI.createImageThumbnail({
        sourcePath,
        outputPath,
        width,
        height,
        quality,
      })
      if (!result?.success) {
        console.warn('Image thumbnail generation failed:', result?.error || 'Unknown error')
        return sourceUrl
      }
      return await window.electronAPI.getFileUrlDirect(outputPath)
    } catch (error) {
      console.warn('Image thumbnail lookup failed:', error)
      return sourceUrl
    } finally {
      pendingThumbnails.delete(pendingKey)
    }
  })()

  pendingThumbnails.set(pendingKey, promise)
  return promise
}
