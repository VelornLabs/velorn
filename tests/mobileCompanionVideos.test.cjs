const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
const {createMobileVideoCatalog,byteRange} = require('../electron/mobileCompanionVideos.cjs')

test('video catalog only shares completed current-project video files with opaque session IDs',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-phone-video-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const file=path.join(root,'review.mp4');await fs.writeFile(file,'synthetic video bytes')
  let context={contextId:'chat-one',projectPath:root}
  let jobs=[{jobId:'completed',projectPath:root,status:'completed',outputPath:file,finishedAt:new Date().toISOString(),origin:{chatId:'chat-one',turnId:'turn-one'}},
    {jobId:'failed',projectPath:root,status:'failed',outputPath:file},{jobId:'foreign',projectPath:'/other',status:'completed',outputPath:file}]
  const catalog=createMobileVideoCatalog({getContext:async()=>context,getJobs:()=>jobs})
  const cards=await catalog.list();assert.equal(cards.length,1)
  assert.equal(cards[0].chatId,'chat-one');assert.equal(cards[0].turnId,'turn-one')
  assert.doesNotMatch(JSON.stringify(cards),new RegExp(root))
  assert.equal((await catalog.list())[0].id,cards[0].id)
  const opened=await catalog.open(cards[0].id);assert.equal(opened.mime,'video/mp4');await opened.handle.close()
  await fs.rename(file,`${file}.old`);await fs.writeFile(file,'replacement with different content')
  assert.equal(await catalog.open(cards[0].id),null,'Old URL cannot read a replacement file')
  const next=(await catalog.list())[0]
  context={...context,contextId:'chat-two'}
  assert.equal(await catalog.open(next.id),null,'Chat change revokes old IDs')
  context=null;assert.deepEqual(await catalog.list(),[])
})
test('catalog preserves unavailable video receipts without granting access to symlinks, missing, empty or non-file exports',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-phone-video-invalid-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  await fs.writeFile(path.join(root,'audio.wav'),'bytes');await fs.writeFile(path.join(root,'empty.mp4'),'')
  await fs.symlink(path.join(root,'audio.wav'),path.join(root,'link.mp4'));await fs.mkdir(path.join(root,'frames.mp4'))
  const jobs=['audio.wav','empty.mp4','link.mp4','frames.mp4','missing.mp4'].map((name,i)=>({jobId:String(i),status:'completed',projectPath:root,outputPath:path.join(root,name)}))
  const catalog=createMobileVideoCatalog({getContext:async()=>({contextId:'ctx',projectPath:root}),getJobs:()=>jobs})
  const cards=await catalog.list()
  assert.equal(cards.length,4,'Non-video exports are still omitted')
  assert.ok(cards.every(card=>card.unavailable===true&&card.reason==='File unavailable'&&!card.url&&!card.downloadUrl))
  assert.deepEqual((await catalog.list()).map(card=>card.id),cards.map(card=>card.id),'Missing-file receipt IDs are stable')
  for(const card of cards)assert.equal(await catalog.open(card.id),null)
  assert.deepEqual(catalog.getStatus(),{state:'files-unavailable',count:4})
})
test('a fresh catalog restores saved completed exports and their reply ownership without live jobs',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-phone-video-restore-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const file=path.join(root,'restored.mp4');await fs.writeFile(file,'restored video bytes')
  const saved={jobId:'saved',projectPath:root,status:'completed',outputPath:file,finishedAt:'2026-09-30T12:00:00Z',origin:{chatId:'chat',turnId:'turn'}}
  const dependencies={getContext:async()=>({contextId:'ctx',projectPath:root,chatId:'chat',turnIds:['turn']}),getJobs:()=>[],getSavedJobs:async projectPath=>{assert.equal(projectPath,root);return [saved]}}
  const before=createMobileVideoCatalog(dependencies),previous=(await before.list())[0]
  const catalog=createMobileVideoCatalog(dependencies),card=(await catalog.list())[0]
  assert.notEqual(card.id,previous.id,'A restart does not revive previous session URL grants')
  assert.equal(card.chatId,'chat');assert.equal(card.turnId,'turn')
  const opened=await catalog.open(card.id);assert.equal((await opened.handle.readFile()).toString(),'restored video bytes');await opened.handle.close()
  assert.equal(await catalog.open(previous.id),null)
  assert.doesNotMatch(JSON.stringify(card),new RegExp(root))
})
test('missing restored media keeps its reply placeholder and a returned file receives a new grant',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-phone-video-return-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const file=path.join(root,'missing.mp4')
  const saved={jobId:'saved',projectPath:root,status:'completed',outputPath:file,origin:{chatId:'chat',turnId:'turn'}}
  const catalog=createMobileVideoCatalog({getContext:async()=>({contextId:'ctx',projectPath:root}),getJobs:()=>[],getSavedJobs:async()=>[saved]})
  const missing=(await catalog.list())[0]
  assert.equal(missing.unavailable,true);assert.equal(missing.turnId,'turn')
  assert.equal((await catalog.list())[0].id,missing.id)
  assert.equal(await catalog.open(missing.id),null)
  await fs.writeFile(file,'returned video')
  const returned=(await catalog.list())[0]
  assert.notEqual(returned.id,missing.id);assert.equal(returned.unavailable,undefined)
  assert.equal(await catalog.open(missing.id),null)
  await fs.rename(file,`${file}.old`);await fs.writeFile(file,'replacement video')
  assert.equal(await catalog.open(returned.id),null)
  const replacement=(await catalog.list())[0];assert.notEqual(replacement.id,returned.id)
  await fs.unlink(file)
  assert.equal(await catalog.open(replacement.id),null)
  assert.equal((await catalog.list())[0].unavailable,true)
})
test('restored exports never escape through project symlinks or unverified external references',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-phone-video-boundary-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const project=path.join(root,'project'),outside=path.join(root,'outside')
  await fs.mkdir(project);await fs.mkdir(outside)
  const file=path.join(outside,'outside.mp4');await fs.writeFile(file,'not project media')
  await fs.symlink(outside,path.join(project,'renders'))
  let saved=[{jobId:'parent-link',projectPath:project,status:'completed',outputPath:path.join(project,'renders','outside.mp4')},
    {jobId:'external',projectPath:project,status:'completed',outputPath:file},
    {jobId:'redacted',projectPath:project,status:'completed',name:'private.mp4',unavailable:true},
    {jobId:'foreign',projectPath:outside,status:'completed',outputPath:file}]
  const catalog=createMobileVideoCatalog({getContext:async()=>({contextId:'ctx',projectPath:project}),getJobs:()=>[],getSavedJobs:async()=>saved})
  const cards=await catalog.list()
  assert.equal(cards.length,3);assert.ok(cards.every(card=>card.unavailable&&!card.url))
  for(const card of cards)assert.equal(await catalog.open(card.id),null)
  const stat=await fs.stat(file)
  saved=[{...saved[1],externalAuthorized:true,expectedIdentity:{dev:stat.dev,ino:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs}}]
  const authorized=(await catalog.list())[0];assert.ok(authorized.url)
  const opened=await catalog.open(authorized.id);await opened.handle.close()
  await fs.rename(file,`${file}.old`);await fs.writeFile(file,'unapproved replacement')
  assert.equal(await catalog.open(authorized.id),null)
  assert.equal((await catalog.list())[0].unavailable,true,'A durable external grant is bound to the authorized identity')
})
test('live jobs win over saved state and only compatible origin metadata is recovered',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-phone-video-merge-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const file=path.join(root,'review.mp4');await fs.writeFile(file,'video')
  const completed=jobId=>({jobId,projectPath:root,status:'completed',outputPath:file,finishedAt:'2026-09-29T12:00:00Z',origin:{chatId:'chat',turnId:jobId}})
  const saved=['kept','failed','running','new-path','own-origin'].map(completed)
  const live=saved.map(({origin,...job})=>({...job,finishedAt:'2026-09-30T12:00:00Z'}))
  live[1].status='failed';live[2].status='running';live[3].outputPath=path.join(root,'other.mp4')
  live[4].origin={chatId:'live-chat',turnId:'live-turn'}
  const catalog=createMobileVideoCatalog({getContext:async()=>({contextId:'ctx',projectPath:root}),getJobs:()=>live,getSavedJobs:async()=>saved})
  const cards=await catalog.list()
  assert.equal(cards.length,3)
  assert.equal(cards[0].turnId,'kept');assert.equal(cards[0].finishedAt,'2026-09-30T12:00:00Z')
  assert.equal(cards[1].turnId,undefined,'A changed output does not borrow stale reply ownership')
  assert.equal(cards[2].turnId,'live-turn');assert.equal(cards[2].chatId,'live-chat')
})
test('older exports remain attached to visible replies beyond the recent project gallery limit',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-phone-video-history-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const file=path.join(root,'review.mp4');await fs.writeFile(file,'video')
  const saved=Array.from({length:140},(_,i)=>({jobId:`job-${i}`,projectPath:root,status:'completed',outputPath:file,
    finishedAt:new Date(Date.UTC(2026,8,30,0,i)).toISOString(),origin:{chatId:'chat',turnId:`turn-${i}`}}))
  let context={contextId:'ctx',projectPath:root,chatId:'chat',turnIds:['turn-0','turn-1']}
  const catalog=createMobileVideoCatalog({getContext:async()=>context,getJobs:()=>[],getSavedJobs:async()=>saved})
  const cards=await catalog.list()
  assert.equal(cards.length,14);assert.ok(cards.some(card=>card.turnId==='turn-0'));assert.equal(cards[0].turnId,'turn-139')
  context={...context,chatId:'different-chat'}
  assert.equal((await catalog.list()).length,12,'Only the active chat gets additional visible-turn attachments')
  context={...context,chatId:'chat',turnIds:saved.map(job=>job.origin.turnId)}
  assert.equal((await catalog.list()).length,100,'Even a long transcript remains bounded')
})
test('empty export history is distinguished from unavailable context or failed lookup',async()=>{
  let context={contextId:'ctx',projectPath:'/synthetic/project'}, fail=false
  const catalog=createMobileVideoCatalog({getContext:async()=>{if(fail)throw Error('Renderer failed');return context},getJobs:()=>[]})
  assert.deepEqual(await catalog.list(),[]);assert.equal(catalog.getStatus().state,'no-exports')
  context={blocked:'sharing-off'}
  assert.deepEqual(await catalog.list(),[]);assert.equal(catalog.getStatus().state,'sharing-off')
  fail=true;await assert.rejects(catalog.list(),/Renderer failed/)
  assert.equal(catalog.getStatus().state,'lookup-failed')
})
test('byte ranges support seeking, suffixes and HEAD metadata without accepting malformed/multiple ranges',()=>{
  assert.deepEqual(byteRange(undefined,100),{start:0,end:99,partial:false})
  assert.deepEqual(byteRange('bytes=20-29',100),{start:20,end:29,partial:true})
  assert.deepEqual(byteRange('bytes=80-',100),{start:80,end:99,partial:true})
  assert.deepEqual(byteRange('bytes=-10',100),{start:90,end:99,partial:true})
  assert.deepEqual(byteRange('bytes=0-1000',100),{start:0,end:99,partial:true})
  for(const range of ['bytes=-0','bytes=100-','bytes=2-1','bytes=0-1,3-4','bytes=-','items=1-3','bytes=9999999999999999999999-']) assert.equal(byteRange(range,100),null)
})
