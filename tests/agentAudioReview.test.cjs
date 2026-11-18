const test=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path')
const {createAgentReviewMediaStore}=require('../electron/agentReviewMediaStore.cjs')
const {recordAudioReview}=require('../electron/agentAudioReview.cjs')
const {createMobileAudioCatalog}=require('../electron/mobileCompanionAudio.cjs')
const result=value=>({content:[{type:'text',text:JSON.stringify({success:true,result:value})}]})
test('async audio completion remains on originating reply after later turns, project move and store recreation',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-audio-origin-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
 let project=path.join(root,'project');await fs.mkdir(project)
 let store=createAgentReviewMediaStore()
 const first={chatId:'chat-one',turnId:'turn-one'},later={chatId:'chat-one',turnId:'turn-two'}
 await recordAudioReview({name:'generate_music',result:result({jobs:[{promptId:'prompt-one'}]}),origin:first,projectPath:project,store})
 await recordAudioReview({name:'get_music_generation_status',result:result({jobs:[{promptId:'prompt-one',assetIds:['audio-one'],belongsToCurrentProject:true}]}),origin:later,projectPath:project,store})
 await fs.writeFile(path.join(project,'take.wav'),'audio fixture')
 const moved=path.join(root,'moved');await fs.rename(project,moved);project=moved;store=createAgentReviewMediaStore()
 const catalog=createMobileAudioCatalog({getContext:async()=>({contextId:'ctx',projectPath:project,chatId:'chat-one',turnIds:['turn-one']}),
  getAssets:async()=>[{id:'audio-one',promptId:'prompt-one',type:'audio',path:'take.wav',duration:45}],getOrigins:p=>store.listAudioOrigins(p)})
 const card=(await catalog.list())[0];assert.equal(card.chatId,'chat-one');assert.equal(card.turnId,'turn-one')
 assert.doesNotMatch(JSON.stringify(await store.listAudioOrigins(project)),new RegExp(root))
})
test('preview, failed, foreign project and unrelated tools cannot attach audio; old completed status can establish ownership',async()=>{
 const saved=[],store={bindAudio:async(...args)=>saved.push(args)},origin={chatId:'chat',turnId:'turn'},projectPath='/fixture'
 for(const [name,value] of [['generate_music',{previewOnly:true,jobs:[{promptId:'p'}]}],['generate_music',{success:false,jobs:[{promptId:'p'}]}],
  ['get_music_generation_status',{jobs:[{belongsToCurrentProject:false,promptId:'p'}]}],['get_assets',{assetIds:['audio']}]] ) {
   await recordAudioReview({name,result:result(value),origin,projectPath,store})
 }
 assert.equal(saved.length,0)
 await recordAudioReview({name:'get_music_generation_status',result:result({jobs:[{promptId:'p',assetIds:['audio']}]}),origin,projectPath,store})
 assert.deepEqual(saved[0],[projectPath,[{kind:'prompt',id:'p'},{kind:'asset',id:'audio'}],origin])
})
