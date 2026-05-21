import { isElectron } from './fileSystem'

const POSTER_IMAGE_SUFFIX = '_poster.jpg'
const POSTER_META_SUFFIX = '_poster.json'

function normalizeSignature(signature = null) {
  if (!signature || typeof signature !== 'object') return null
  return {
    sourcePath: String(signature.sourcePath || '').trim() || null,
    sourceSize: Number(signature.sourceSize) || 0,
    sourceModified: Number(signature.sourceModified) || 0,
  }
}

function signaturesMatch(left, right) {
  const a = normalizeSignature(left)
  const b = normalizeSignature(right)
  if (!a || !b) return false
  return a.sourcePath === b.sourcePath
    && a.sourceSize === b.sourceSize
    && a.sourceModified === b.sourceModified
}

export function buildPosterSignature(fileInfo, sourcePath) {
  return normalizeSignature({
    sourcePath,
    sourceSize: Number(fileInfo?.info?.size) || 0,
    sourceModified: fileInfo?.info?.modified ? new Date(fileInfo.info.modified).getTime() : 0,
  })
}

export async function loadVideoPosterFromProject(projectPath, assetId, expectedSignature = null) {
  if (!isElectron() || !projectPath || !assetId) return null
  const api = window.electronAPI
  try {
    const posterDir = await api.pathJoin(projectPath, 'thumbnails')
    const posterPath = await api.pathJoin(posterDir, `${assetId}${POSTER_IMAGE_SUFFIX}`)
    const metaPath = await api.pathJoin(posterDir, `${assetId}${POSTER_META_SUFFIX}`)
    if (!await api.exists(posterPath)) return null

    let posterMeta = null
    if (await api.exists(metaPath)) {
      const metaResult = await api.readFile(metaPath, { encoding: 'utf8' })
      if (metaResult?.success && metaResult.data) {
        try {
          posterMeta = JSON.parse(metaResult.data)
        } catch (_) {
          posterMeta = null
        }
      }
    }

    if (expectedSignature && posterMeta?.sourceSignature && !signaturesMatch(posterMeta.sourceSignature, expectedSignature)) {
      return null
    }

    const url = await api.getFileUrlDirect(posterPath)
    return {
      posterPath,
      metaPath,
      url,
      posterData: {
        url,
        posterPath,
        sourceSignature: posterMeta?.sourceSignature || null,
        width: posterMeta?.width || null,
        height: posterMeta?.height || null,
        created: posterMeta?.created || null,
      },
    }
  } catch (err) {
    console.warn('Failed to load video poster:', err)
    return null
  }
}

export async function generateVideoPosterInProject(projectPath, assetId, sourcePath, sourceSignature, options = {}) {
  if (!isElectron() || !projectPath || !assetId || !sourcePath) return null
  const api = window.electronAPI
  const posterDir = await api.pathJoin(projectPath, 'thumbnails')
  await api.createDirectory(posterDir)
  const posterPath = await api.pathJoin(posterDir, `${assetId}${POSTER_IMAGE_SUFFIX}`)
  const metaPath = await api.pathJoin(posterDir, `${assetId}${POSTER_META_SUFFIX}`)

  const result = await api.extractVideoPoster(sourcePath, posterPath, options)
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to extract video poster')
  }

  const posterUrl = await api.getFileUrlDirect(posterPath)
  const posterData = {
    url: posterUrl,
    posterPath,
    sourceSignature: normalizeSignature(sourceSignature),
    width: result.width || null,
    height: result.height || null,
    created: new Date().toISOString(),
  }
  await api.writeFile(metaPath, JSON.stringify(posterData, null, 2))
  return { posterPath, metaPath, url: posterUrl, posterData }
}

export async function deleteVideoPosterFromProject(projectPath, assetId) {
  if (!isElectron() || !projectPath || !assetId) return
  const api = window.electronAPI
  const posterDir = await api.pathJoin(projectPath, 'thumbnails')
  const posterPath = await api.pathJoin(posterDir, `${assetId}${POSTER_IMAGE_SUFFIX}`)
  const metaPath = await api.pathJoin(posterDir, `${assetId}${POSTER_META_SUFFIX}`)
  try { await api.deleteFile(posterPath) } catch (_) {}
  try { await api.deleteFile(metaPath) } catch (_) {}
}
