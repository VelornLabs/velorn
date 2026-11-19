'use strict'
const path = require('node:path')
const MIME = { '.mp3':'audio/mpeg','.wav':'audio/wav','.flac':'audio/flac','.m4a':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg','.opus':'audio/ogg',
  '.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm' }
const eligible = asset => asset && ['audio','video'].includes(asset.type) && typeof asset.path === 'string'
  && !path.isAbsolute(asset.path) && !/[\\:]/.test(asset.path) && asset.path.split('/').every(part=>part && part!=='.' && part!=='..')
  && MIME[path.extname(asset.path).toLowerCase()]
  && !['pending','queued','running','failed','error'].includes(asset.generationStatus || asset.status)
async function syncPlayable({projectPath, assets, store}) {
  const origins = await store.listAudioOrigins(projectPath)
  const refs = new Map(origins.map(item=>[`${item.kind}:${item.id}`,item.origin]))
  const saved = await store.listPlayable(projectPath)
  const key = (id,owner) => `${id}:${owner.chatId}:${owner.turnId}`
  const existing = new Set(saved.map(item=>key(item.assetId,item.origin)))
  let changed = false
  for (const asset of (Array.isArray(assets) ? assets : []).filter(eligible)) {
    const owner = refs.get(`prompt:${asset.promptId}`) || refs.get(`asset:${asset.id}`)
    if (owner && !existing.has(key(asset.id,owner))) {
      await store.savePlayable(projectPath,[asset],owner)
      existing.add(key(asset.id,owner)); changed = true
    }
  }
  return changed ? store.listPlayable(projectPath) : saved
}
function playableJob(item, projectPath) {
  return { jobId:item.id,projectPath,status:'completed',outputPath:item.outputPath,origin:item.origin,
    unavailable:item.unavailable===true,finishedAt:null }
}
module.exports={MIME,eligible,syncPlayable,playableJob}
