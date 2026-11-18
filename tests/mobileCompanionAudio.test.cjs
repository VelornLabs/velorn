const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
const { createMobileAudioCatalog } = require('../electron/mobileCompanionAudio.cjs')
test('registered audio uses project-relative media, survives reopen and revokes stale file/context grants', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-audio-test-')); t.after(() => fs.rm(root,{recursive:true,force:true}))
  await fs.writeFile(path.join(root,'take.flac'),'synthetic audio')
  let context = { contextId:'chat',projectPath:root }, assets = [{ id:'take',type:'audio',path:'take.flac',duration:45 }]
  const dependencies = { getContext:async()=>context,getAssets:async project=>{assert.equal(project,root);return assets} }
  const catalog = createMobileAudioCatalog(dependencies), card = (await catalog.list())[0]
  assert.match(card.url,/^\/media\/audio\/[a-f0-9]{48}$/); assert.doesNotMatch(JSON.stringify(card),new RegExp(root))
  const opened = await catalog.open(card.id); assert.equal(opened.mime,'audio/flac'); await opened.handle.close()
  assert.equal((await catalog.list())[0].id,card.id)
  const reopened = createMobileAudioCatalog(dependencies); assert.equal((await reopened.list()).length,1)
  assert.equal(await reopened.open(card.id),null)
  await fs.rename(path.join(root,'take.flac'),path.join(root,'old.flac')); await fs.writeFile(path.join(root,'take.flac'),'replacement')
  assert.equal(await catalog.open(card.id),null)
  const replacement = (await catalog.list())[0]; context = { ...context,contextId:'other' }
  assert.equal(await catalog.open(replacement.id),null)
  context = { blocked:'sharing-off' }; assert.deepEqual(await catalog.list(),[])
})
test('audio excludes external, unfinished and non-audio assets; missing or symlink media grants no file access',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-audio-invalid-'));t.after(()=>fs.rm(root,{recursive:true,force:true}))
  await fs.writeFile(path.join(root,'take.wav'),'audio'); await fs.symlink(path.join(root,'take.wav'),path.join(root,'link.wav'))
  const base={type:'audio',duration:10}
  const assets=[{...base,id:'external',path:'/external.wav'},{...base,id:'traversal',path:'../take.wav'},
    {...base,id:'windows',path:'C:\\take.wav'},{...base,id:'video',type:'video',path:'take.wav'},
    {...base,id:'pending',status:'running',path:'take.wav'},{...base,id:'empty',duration:0,path:'take.wav'},
    {...base,id:'missing',path:'missing.wav'},{...base,id:'link',path:'link.wav'}]
  const catalog=createMobileAudioCatalog({getContext:async()=>({contextId:'chat',projectPath:root}),getAssets:async()=>assets})
  const cards=await catalog.list();assert.equal(cards.length,2);assert.ok(cards.every(c=>c.unavailable&&!c.url))
  for(const card of cards)assert.equal(await catalog.open(card.id),null)
})
