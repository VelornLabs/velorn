'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path')
const {createAgentReviewMediaStore}=require('../electron/agentReviewMediaStore.cjs')
const {syncPlayable,playableJob}=require('../electron/agentPlayableMedia.cjs')
const {recordAudioReview}=require('../electron/agentAudioReview.cjs')
const {registerAgentReviewMediaIpc,CHANNELS}=require('../electron/agentReviewMediaIpc.cjs')
const owner={chatId:'chat',turnId:'one'}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-playable-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const project=path.join(root,'project');await fs.mkdir(project)
  const assets=[{id:'audio',type:'audio',name:'Music',path:'Music.flac',promptId:'music-job'},{id:'video',type:'video',name:'Film',path:'Film.mp4'}]
  for(const asset of assets)await fs.writeFile(path.join(project,asset.path),'synthetic media')
  return {root,project,assets,store:createAgentReviewMediaStore()}
}
test('audio and video survive store recreation and project move, without asset inventory or session jobs',async t=>{
  const {root,project,assets,store}=await fixture(t)
  await store.savePlayable(project,assets,owner);await store.savePlayable(project,assets,owner)
  assert.equal((await store.listPlayable(project)).length,2)
  const metadata=await fs.readFile(path.join(project,'.velorn/agent-review/manifest.json'),'utf8')
  assert.equal(metadata.includes(project),false)
  const moved=path.join(root,'moved');await fs.rename(project,moved)
  const reopened=createAgentReviewMediaStore()
  const restored=await syncPlayable({projectPath:moved,assets:[],store:reopened})
  assert.equal(restored.length,2)
  for(const item of restored){assert.deepEqual(item.origin,owner);assert.equal(item.unavailable,undefined);assert.equal(item.outputPath,path.join(moved,item.path))}
  await fs.unlink(path.join(moved,'Film.mp4'))
  assert.equal((await reopened.listPlayable(moved)).find(i=>i.type==='video').unavailable,true)
  assert.equal((await reopened.listPlayable(moved)).length,2,'missing files retain attachment records')
  await assert.rejects(reopened.savePlayable(moved,[{...assets[0],path:'../secret'}],owner))
})
test('receipts automatically link async output; ordinary inspection does not; explicit reshare has its own reply',async t=>{
  const {project,assets,store}=await fixture(t)
  const receipt=async(name,value,origin=owner)=>recordAudioReview({name,projectPath:project,store,origin,result:{content:[{type:'text',text:JSON.stringify(value)}]}})
  await receipt('generate_music',{jobs:[{promptId:'music-job'}]})
  assert.equal((await syncPlayable({projectPath:project,assets:[],store})).length,0)
  await syncPlayable({projectPath:project,assets,store})
  await receipt('get_assets',{assets,assetIds:assets.map(a=>a.id)},{chatId:'chat',turnId:'two'})
  assert.equal((await store.listPlayable(project)).length,1)
  await receipt('get_assets',{reviewMedia:true,assets,assetIds:assets.map(a=>a.id)},{chatId:'chat',turnId:'two'})
  const saved=await syncPlayable({projectPath:project,assets,store})
  assert.equal(saved.length,3)
  assert.equal(saved.filter(i=>i.origin.turnId==='one').length,1)
  assert.equal(saved.filter(i=>i.origin.turnId==='two').length,2)
})
test('desktop IPC attaches existing media and restores only requested chat turns; stale or foreign frames cannot attach',async t=>{
  const {project,assets,store}=await fixture(t),handlers=new Map()
  const wc={mainFrame:{},isDestroyed:()=>false,send:()=>{}},window={isDestroyed:()=>false,webContents:wc},event={sender:wc,senderFrame:wc.mainFrame}
  let active=project
  const ipc=registerAgentReviewMediaIpc({ipcMain:{handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)},getMainWindow:()=>window,getProjectPath:async()=>active,getAssets:async()=>assets,store})
  const payload={projectPath:project,...owner,assetIds:['audio','video']}
  assert.equal((await handlers.get(CHANNELS.attachPlayable)(event,payload)).success,true)
  const list=extra=>handlers.get(CHANNELS.listPlayable)(event,{projectPath:project,chatId:'chat',turnIds:['one'],...extra})
  let result=await list();assert.equal(result.items.length,2);assert.equal(result.candidates.length,2)
  assert.match(result.items[0].url,/^file:\/\//)
  assert.deepEqual((await list({chatId:'other'})).items,[])
  assert.deepEqual((await list({turnIds:['other']})).items,[])
  assert.equal((await handlers.get(CHANNELS.attachPlayable)({...event,senderFrame:{}},payload)).success,false)
  active='/different-project';assert.equal((await list()).success,false)
  assert.equal((await handlers.get(CHANNELS.attachPlayable)(event,payload)).success,false)
  ipc.dispose();assert.equal(handlers.size,0)
})
test('phone catalogs restore audio and imported video attachments from durable references with empty live inventory',async t=>{
  const {project,assets,store}=await fixture(t)
  await store.savePlayable(project,assets,owner)
  const saved=async type=>(await createAgentReviewMediaStore().listPlayable(project)).filter(i=>i.type===type).map(i=>playableJob(i,project))
  const getContext=async()=>({projectPath:project,contextId:'context',chatId:'chat',turnIds:['one']})
  const audio=require('../electron/mobileCompanionAudio.cjs').createMobileAudioCatalog({getContext,getAssets:async()=>[],getSavedMedia:()=>saved('audio')})
  const video=require('../electron/mobileCompanionVideos.cjs').createMobileVideoCatalog({getContext,getJobs:()=>[],getSavedJobs:()=>saved('video')})
  for(const catalog of [audio,video]){
    const result=await catalog.list();assert.equal(result.length,1);assert.equal(result[0].chatId,owner.chatId);assert.equal(result[0].turnId,owner.turnId)
    assert.equal(JSON.stringify(result).includes(project),false)
  }
})
