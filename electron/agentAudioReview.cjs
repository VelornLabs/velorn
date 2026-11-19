'use strict'
// Bind trusted tool receipts to turns, never infer ownership from model prose
// or whichever reply happens to be at the bottom when a render completes.
const TOOLS = new Set(['generate_music','get_music_generation_status','generate_local_voice','get_local_voice_status','import_comfy_router_image','queue_comfyui_workflow','import_comfyui_run_outputs','import_asset_from_path','get_assets'])
const ID = /^[A-Za-z0-9_-]{1,110}$/
async function recordAudioReview({ name, result, origin, projectPath, store }) {
  if (!TOOLS.has(name) || result?.isError || !projectPath || ![origin?.chatId,origin?.turnId].every(id => typeof id === 'string' && ID.test(id))) return
  let value
  try { value = JSON.parse(result.content.find(item => item.type === 'text').text) } catch { return }
  if (value?.success === false) return
  value = value?.result || value
  if (!value || value.success === false || value.previewOnly === true) return
  if (name === 'get_assets' && value.reviewMedia !== true) return
  if (name === 'get_assets' && value.reviewMedia === true && store.savePlayable) {
    const wanted = new Set(Array.isArray(value.assetIds) ? value.assetIds : [])
    const selected = (Array.isArray(value.assets) ? value.assets : []).filter(asset => wanted.has(asset.id) && require('./agentPlayableMedia.cjs').eligible(asset))
    if (selected.length) await store.savePlayable(projectPath,selected,{chatId:origin.chatId,turnId:origin.turnId})
  }
  const refs = [], keys = new Set()
  const add = (kind,id) => { const key = `${kind}:${id}`; if (typeof id === 'string' && ID.test(id) && !keys.has(key) && refs.length < 512) { refs.push({kind,id}); keys.add(key) } }
  const collect = item => {
    if (!item || item.belongsToCurrentProject === false || item.success === false || item.previewOnly === true) return
    add('prompt',item.promptId || item.prompt_id)
    // A clip or sound made with a Create model, once it is imported into the project.
    if (name === 'import_comfy_router_image') add('asset',item.assetId)
    if (['audio','video'].includes(item.asset?.type)) add('asset',item.asset.id)
    for (const key of ['assetIds','importedAssetIds','reconciledAssetIds']) {
      for (const id of Array.isArray(item[key]) ? item[key].slice(0,512) : []) add('asset',id)
    }
  }
  collect(value); collect(value.body)
  for (const job of Array.isArray(value.jobs) ? value.jobs.slice(0,100) : []) collect(job)
  if (refs.length) await store.bindAudio(projectPath,refs,{chatId:origin.chatId,turnId:origin.turnId})
}
module.exports = { recordAudioReview }
