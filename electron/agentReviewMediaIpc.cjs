'use strict'
const {pathToFileURL}=require('node:url')
const CHANNELS = { saveFrame: 'agent-review-media:save-frame', listFrames: 'agent-review-media:list-frames', listPlayable:'agent-review-media:list-playable', attachPlayable:'agent-review-media:attach-playable', changed: 'agent-review-media:changed' }
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
function registerAgentReviewMediaIpc({ ipcMain, getMainWindow, getProjectPath, getAssets = async()=>[], store }) {
  function authorize(event) {
    const window = getMainWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()
      || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw Error('Review history is only available to the main editor.')
    return window
  }
  async function project(event, expectedPath) {
    const window = authorize(event), projectPath = await getProjectPath()
    if (getMainWindow() !== window || !projectPath || expectedPath !== projectPath) throw Error('Open the same saved project to restore review media.')
    authorize(event)
    return projectPath
  }
  function changed(value) {
    const window = getMainWindow()
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(CHANNELS.changed,value)
  }
  ipcMain.handle(CHANNELS.saveFrame, async (event, payload = {}) => {
    try {
      if (!id(payload.chatId) || !id(payload.turnId) || !payload.frame || JSON.stringify(payload).length > 400000) throw Error('Invalid review still.')
      const projectPath = await project(event,payload.projectPath)
      const frame = await store.saveFrame(projectPath,{...payload.frame,chatId:payload.chatId,turnId:payload.turnId})
      changed({chatId:payload.chatId})
      return {success:true,frame}
    } catch { return {success:false,error:'Could not save this review still. Check that the project is writable and has free space. The current preview is still available.'} }
  })
  ipcMain.handle(CHANNELS.listFrames, async (event, payload = {}) => {
    try {
      if (!id(payload.chatId) || !Array.isArray(payload.turnIds) || payload.turnIds.length > 100 || !payload.turnIds.every(id)) throw Error('Invalid review history request.')
      const projectPath = await project(event,payload.projectPath)
      const frames = await store.listFrames(projectPath,{chatId:payload.chatId,turnIds:payload.turnIds})
      if (projectPath !== await project(event,payload.projectPath)) throw Error('Project changed.')
      return {success:true,frames}
    } catch { return {success:false,error:'Saved review media could not be loaded. The files have not been deleted. Reopen the project or check its review history folder.'} }
  })
  ipcMain.handle(CHANNELS.listPlayable, async(event,payload={})=>{
    try {
      if (!id(payload.chatId) || !Array.isArray(payload.turnIds) || payload.turnIds.length>100 || !payload.turnIds.every(id)) throw Error('Invalid chat filter.')
      const root=await project(event,payload.projectPath), assets=await getAssets(root)
      await project(event,root)
      const {syncPlayable,eligible}=require('./agentPlayableMedia.cjs')
      const items=await syncPlayable({projectPath:root,assets,store})
      const exports=await store.listExports(root)
      await project(event,root)
      const turns=new Set(payload.turnIds)
      const entries=[...items,...exports.filter(item=>item.origin).map(item=>({...item,id:`export-${item.jobId}`,type:'video'}))]
        .filter(item=>item.origin?.chatId===payload.chatId && turns.has(item.origin.turnId))
        .map(item=>({id:item.id,type:item.type,name:item.name,turnId:item.origin.turnId,unavailable:item.unavailable===true,
          ...(!item.unavailable && item.outputPath ? {url:pathToFileURL(item.outputPath).href}:{})}))
      return {success:true,items:entries,candidates:assets.filter(eligible).slice(0,200).map(a=>({id:a.id,name:a.name,type:a.type}))}
    } catch {return {success:false,error:'Saved audio/video could not be restored. Your media files have not been removed.'}}
  })
  ipcMain.handle(CHANNELS.attachPlayable, async(event,payload={})=>{
    try {
      if (!id(payload.chatId)||!id(payload.turnId)||!Array.isArray(payload.assetIds)||!payload.assetIds.length||payload.assetIds.length>100||!payload.assetIds.every(id)) throw Error('Invalid attachment.')
      const root=await project(event,payload.projectPath), assets=await getAssets(root)
      await project(event,root)
      const wanted=new Set(payload.assetIds), selected=assets.filter(a=>wanted.has(a.id)&&require('./agentPlayableMedia.cjs').eligible(a))
      if(selected.length!==wanted.size) throw Error('Some selected media is unavailable.')
      await store.savePlayable(root,selected,{chatId:payload.chatId,turnId:payload.turnId})
      changed({chatId:payload.chatId});return {success:true}
    }catch{return {success:false,error:'Could not attach the selected project media. No files were imported or generated.'}}
  })
  return {changed,dispose() { for(const key of ['saveFrame','listFrames','listPlayable','attachPlayable']) ipcMain.removeHandler(CHANNELS[key]) }}
}
module.exports = {registerAgentReviewMediaIpc,CHANNELS}
