'use strict'
const path = require('node:path')
const { createMobileVideoCatalog } = require('./mobileCompanionVideos.cjs')
const MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.webm': 'audio/webm' }

// Registered current-project assets only. Phone requests never supply paths.
// Reuse the reviewed streaming catalog's file identity, project and symlink checks.
function createMobileAudioCatalog({ getContext, getAssets, getOrigins = async () => [], getSavedMedia = async()=>[] }) {
  return createMobileVideoCatalog({ getContext, getJobs: () => [], mimeTypes: MIME, mediaRoute: 'audio', emptyState: 'no-audio',
    getSavedJobs: async projectPath => {
      const assets = await getAssets(projectPath)
      const origins = await getOrigins(projectPath)
      const byReference = new Map(origins.map(ref => [`${ref.kind}:${ref.id}`,ref.origin]))
      const saved=await getSavedMedia(projectPath), paths=new Set(saved.map(item=>item.outputPath))
      return [...saved,...(Array.isArray(assets) ? assets : []).filter(asset => asset?.type === 'audio' && asset.id && typeof asset.path === 'string' && asset.path
        && !path.isAbsolute(asset.path) && !/^[A-Za-z]:/.test(asset.path) && !asset.path.split(/[\\/]+/).includes('..')
        && MIME[path.extname(asset.path).toLowerCase()] && Number(asset.duration) > 0
        && !['pending', 'queued', 'running', 'failed', 'error'].includes(asset.generationStatus || asset.status))
        .map(asset => ({ jobId: `audio-${asset.id}`, projectPath, status: 'completed',
          outputPath: path.resolve(projectPath, asset.path), finishedAt: asset.createdAt || asset.imported || null,
          origin: byReference.get(`prompt:${asset.promptId}`) || byReference.get(`asset:${asset.id}`) })).filter(item=>!paths.has(item.outputPath))]
    },
  })
}
module.exports = { createMobileAudioCatalog }
