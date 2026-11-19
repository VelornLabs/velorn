'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { createMobileCompanionServer, LIMITS, allowedPeer, privateAddress } = require('../electron/mobileCompanionServer.cjs')

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-companion-server-'))
  await Promise.all(['live.html', 'live.js', 'live.css'].map(name => fs.writeFile(path.join(root, name), name)))
  let clock = 100000
  const calls = [], scope = { projectKey: '/private/project', conversationId: 'chat-one', session: 'renderer-one' }
  const api = createMobileCompanionServer({ clientRoot: root, port: 0, host: '127.0.0.1', now: () => clock,
    networkInterfaces: () => ({ lan: [{ family: 'IPv4', address: '192.168.10.20' }] }),
    onMessage: command => { calls.push(command); return options.result || { success: true } }, ...options })
  t.after(async () => { await api.stop(); await fs.rm(root, { recursive: true, force: true }) })
  const status = await api.start(scope, { project: 'Sample', messages: [], busy: false })
  return { api, status, calls, root, scope, advance: amount => { clock += amount } }
}
function request(status, route, { method = 'POST', value = {}, headers = {}, token, localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof value === 'string' ? value : JSON.stringify(value)
    const req = http.request(`${status.localUrl}${route}`, { method, localAddress,
      headers: { Origin: status.localUrl, 'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); let body
        try { body = JSON.parse(text) } catch { body = text }
        resolve({ status: res.statusCode, headers: res.headers, body })
      })
    })
    req.on('error', reject); req.end(['GET', 'HEAD'].includes(method) ? undefined : data)
  })
}
async function pair(f) {
  const response = await request(f.status, '/api/pair', { value: { code: f.status.pairingCode } })
  assert.equal(response.status, 200)
  return response.body.token
}

test('completed video streaming needs the paired media cookie and supports range, HEAD and download',async t=>{
  let context={contextId:'video-context',projectPath:''}, jobs=[]
  const catalog=require('../electron/mobileCompanionVideos.cjs').createMobileVideoCatalog({getContext:async()=>context,getJobs:()=>jobs})
  const f=await fixture(t,{videoCatalog:catalog})
  context.projectPath=f.root
  const file=path.join(f.root,'review.mp4');await fs.writeFile(file,'0123456789abcdef')
  jobs=[{jobId:'done',status:'completed',projectPath:f.root,outputPath:file,finishedAt:'2026-09-30T20:00:00Z'}]
  f.api.publish(f.scope,{contextId:context.contextId,available:true,shareReviewMedia:true})
  const token=await pair(f), state=await request(f.status,'/api/state',{token})
  const card=state.body.snapshot.videos[0], cookie=state.headers['set-cookie'][0].split(';')[0]
  assert.deepEqual(state.body.snapshot.videoReview,{state:'ready',count:1})
  assert.match(state.headers['set-cookie'][0],/HttpOnly; SameSite=Strict/)
  assert.equal((await request(f.status,card.url,{method:'GET'})).status,401)
  const part=await request(f.status,card.url,{method:'GET',headers:{Cookie:cookie,Range:'bytes=3-7'}})
  assert.equal(part.status,206);assert.equal(String(part.body),'34567')
  assert.equal(part.headers['content-range'],'bytes 3-7/16');assert.equal(part.headers['content-type'],'video/mp4')
  const suffix=await request(f.status,card.url,{method:'GET',headers:{Cookie:cookie,Range:'bytes=-4'}})
  assert.equal(suffix.body,'cdef')
  const head=await request(f.status,card.url,{method:'HEAD',headers:{Cookie:cookie}})
  assert.equal(head.status,200);assert.equal(head.headers['content-length'],'16');assert.equal(head.body,'')
  const download=await request(f.status,card.downloadUrl,{method:'GET',headers:{Cookie:cookie}})
  assert.equal(download.body,'0123456789abcdef');assert.match(download.headers['content-disposition'],/attachment/)
  assert.equal((await request(f.status,card.url,{method:'GET',headers:{Cookie:cookie,Range:'bytes=100-'}})).status,416)
  assert.equal((await request(f.status,card.url,{method:'GET',headers:{Cookie:cookie,Origin:'https://foreign.example'}})).status,403)
  context=null;f.api.publish(f.scope,{contextId:'other',available:true,shareReviewMedia:false})
  assert.equal((await request(f.status,card.url,{method:'GET',headers:{Cookie:cookie}})).status,404)
})

test('audio streams only to a paired phone with seeking, HEAD, download and sharing withdrawal',async t=>{
  let context={contextId:'audio-context',projectPath:''}
  const catalog=require('../electron/mobileCompanionAudio.cjs').createMobileAudioCatalog({getContext:async()=>context,
    getAssets:async()=>[{id:'take',type:'audio',duration:45,path:'take.wav'}]})
  const f=await fixture(t,{audioCatalog:catalog});context.projectPath=f.root
  await fs.writeFile(path.join(f.root,'take.wav'),'0123456789abcdef')
  f.api.publish(f.scope,{contextId:context.contextId,available:true,shareReviewMedia:true})
  const token=await pair(f),state=await request(f.status,'/api/state',{token})
  const card=state.body.snapshot.audio[0],cookie=state.headers['set-cookie'][0].split(';')[0]
  assert.equal(state.body.snapshot.audioReview.state,'ready')
  assert.equal((await request(f.status,card.url,{method:'GET'})).status,401)
  const part=await request(f.status,card.url,{method:'GET',headers:{Cookie:cookie,Range:'bytes=3-7'}})
  assert.equal(part.status,206);assert.equal(String(part.body),'34567');assert.equal(part.headers['content-type'],'audio/wav')
  assert.equal((await request(f.status,card.url,{method:'HEAD',headers:{Cookie:cookie}})).headers['content-length'],'16')
  const download=await request(f.status,card.downloadUrl,{method:'GET',headers:{Cookie:cookie}})
  assert.equal(download.body,'0123456789abcdef');assert.match(download.headers['content-disposition'],/attachment/)
  assert.equal((await request(f.status,card.url,{method:'GET',headers:{Cookie:cookie,Range:'bytes=999-'}})).status,416)
  f.api.publish(f.scope,{contextId:context.contextId,available:true,shareReviewMedia:false})
  assert.equal((await request(f.status,card.url,{method:'GET',headers:{Cookie:cookie}})).status,410)
  assert.deepEqual((await request(f.status,'/api/state',{token})).body.snapshot.audio,[])
})

test('video publication failures are visible without exposing native filesystem errors',async t=>{
  const f=await fixture(t,{videoCatalog:{list:async()=>{throw Error('/private/project/secret-video.mp4 failed')}}})
  const token=await pair(f), state=await request(f.status,'/api/state',{token})
  assert.equal(state.status,200)
  assert.deepEqual(state.body.snapshot.videos,[])
  assert.deepEqual(state.body.snapshot.videoReview,{state:'lookup-failed',count:0})
  assert.doesNotMatch(JSON.stringify(state.body),/private|secret-video/)
})
async function tick() { await new Promise(resolve => setImmediate(resolve)) }

test('same-chat image sharing withdrawal during catalog IO cannot return earlier inline stills',async t=>{
  let withdraw
  const f=await fixture(t,{videoCatalog:{list:async()=>{withdraw();return [{id:'old-video'}]}}})
  const initial={contextId:'unchanged',shareReviewMedia:true,available:true,reviews:[{id:'review-old',dataUrl:'private-old-image'}]}
  f.api.publish(f.scope,initial)
  withdraw=()=>f.api.publish(f.scope,{...initial,shareReviewMedia:false,reviews:[]})
  const token=await pair(f),state=await request(f.status,'/api/state',{token})
  assert.deepEqual(state.body.snapshot.reviews,[]);assert.deepEqual(state.body.snapshot.videos,[])
  assert.equal(state.body.snapshot.videoReview.state,'sharing-off')
  assert.doesNotMatch(JSON.stringify(state.body),/private-old-image/)
})

test('persisted stills return after a fresh store/catalog and stream only with current paired media authority',async t=>{
  const {createAgentReviewMediaStore}=require('../electron/agentReviewMediaStore.cjs')
  const {createMobileStillCatalog}=require('../electron/mobileCompanionStills.cjs')
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHacAAAAASUVORK5CYII='
  let context,store=createAgentReviewMediaStore()
  const catalog=createMobileStillCatalog({getContext:async()=>context,store:{listFrames:(...args)=>store.listFrames(...args),readFrame:(...args)=>store.readFrame(...args)}})
  const f=await fixture(t,{stillCatalog:catalog})
  context={projectPath:f.root,contextId:'saved-context',chatId:'chat-one',turnIds:['turn-one']}
  await store.saveFrame(f.root,{id:'review-one',chatId:'chat-one',turnId:'turn-one',label:'Saved still',capturedAt:Date.now(),dataUrl:png})
  store=createAgentReviewMediaStore() // no surviving in-memory image cache
  f.api.publish(f.scope,{contextId:context.contextId,available:true,shareReviewMedia:true,reviews:[],messages:[]})
  const token=await pair(f), state=await request(f.status,'/api/state',{token})
  const frame=state.body.snapshot.reviews[0],cookie=state.headers['set-cookie'][0].split(';')[0]
  assert.equal(frame.id,'review-one');assert.equal(frame.dataUrl,undefined)
  assert.doesNotMatch(JSON.stringify(frame),new RegExp(f.root))
  assert.equal((await request(f.status,frame.url,{method:'GET'})).status,401)
  const image=await request(f.status,frame.url,{method:'GET',headers:{Cookie:cookie}})
  assert.equal(image.status,200);assert.equal(image.headers['content-type'],'image/png')
  assert.equal(Number(image.headers['content-length']),Buffer.from(png.split(',')[1],'base64').length)
  assert.equal((await request(f.status,frame.url,{method:'GET',headers:{Cookie:cookie,Origin:'https://unrelated.test'}})).status,403)
  const manifest=JSON.parse(await fs.readFile(path.join(f.root,'.velorn/agent-review/manifest.json'),'utf8'))
  await fs.unlink(path.join(f.root,'.velorn/agent-review/frames',manifest.frames[0].media.file))
  const missing=await request(f.status,'/api/state',{token})
  assert.equal(missing.body.snapshot.reviews[0].unavailable,true)
  assert.equal((await request(f.status,frame.url,{method:'GET',headers:{Cookie:cookie}})).status,404)
  context={...context,chatId:'different-chat'}
  assert.deepEqual((await request(f.status,'/api/state',{token})).body.snapshot.reviews,[])
})

test('opt-in lifecycle, static allowlist, security headers and one-phone pairing', async t => {
  const f = await fixture(t)
  assert.match(f.status.pairingCode, /^[A-Z2-9]{12}$/)
  assert.equal(f.status.transport, 'trusted-lan-http')
  assert.equal(f.status.fullAccess, false)
  assert.equal(f.status.remoteApprovals, false)
  assert.equal(f.status.pairingExpiresAt - 100000, LIMITS.pairingMs)
  const page = await request(f.status, '/', { method: 'GET' })
  assert.equal(page.status, 200); assert.equal(page.body, 'live.html')
  assert.equal(page.headers['cache-control'], 'no-store, max-age=0')
  assert.equal(page.headers['x-content-type-options'], 'nosniff')
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/)
  assert.equal(page.headers['access-control-allow-origin'], undefined)
  for (const route of ['/live.html', '/../package.json', '/live.js?x=1', '/api/tool', '/mcp']) {
    assert.equal((await request(f.status, route, { method: 'GET' })).status, 404)
  }
  assert.equal((await request(f.status, '/live.js', { method: 'GET' })).body, 'live.js')
  assert.equal((await request(f.status, '/live.css', { method: 'HEAD' })).body, '')
  const token = await pair(f)
  assert.match(token, /^[a-f0-9]{64}$/)
  assert.equal(f.api.getStatus().pairingCode, null)
  assert.equal((await request(f.status, '/api/pair', { value: { code: f.status.pairingCode } })).status, 401)
  const state = await request(f.status, '/api/state', { token })
  assert.equal(state.status, 200)
  assert.doesNotMatch(JSON.stringify(state.body), /private\/project|renderer-one|chat-one|pairingCode/)
  assert.equal(state.body.snapshot.project, 'Sample')
  await f.api.stop()
  assert.equal(f.api.getStatus().enabled, false)
  await assert.rejects(request(f.status, '/api/state', { token }))
})

test('authentication, exact Host/Origin, methods and request schemas fail closed', async t => {
  const f = await fixture(t), token = await pair(f)
  assert.equal((await request(f.status, '/api/state')).status, 401)
  assert.equal((await request(f.status, '/api/state', { token: 'wrong' })).status, 401)
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: '' }, { Host: 'evil.example' }, { Host: `localhost:${f.status.port}`, Origin: `http://localhost:${f.status.port}` }]) {
    assert.equal((await request(f.status, '/api/state', { token, headers })).status, 403)
  }
  assert.equal((await request(f.status, '/api/state', { token, method: 'GET' })).status, 200)
  assert.equal((await request(f.status, '/api/state', { token, value: { extra: true } })).status, 400)
  assert.equal((await request(f.status, '/api/state', { token, method: 'OPTIONS' })).status, 405)
  assert.equal((await request(f.status, '/api/message', { token, method: 'GET' })).status, 405)
  for (const value of [{ id: '../bad', text: 'hello' }, { id: 'ok', text: ' ' }, { id: 'ok', text: 'x'.repeat(4001) }, { id: 'ok', text: 'hello', fullAccess: true }, []]) {
    assert.equal((await request(f.status, '/api/message', { token, value })).status, 400)
  }
  assert.equal((await request(f.status, '/api/message', { token, value: '{bad' })).status, 400)
  assert.equal((await request(f.status, '/api/message', { token, headers: { 'Content-Type': 'text/plain' } })).status, 415)
  assert.equal((await request(f.status, '/api/message', { token, value: 'x'.repeat(LIMITS.bodyBytes + 1) })).status, 413)
  assert.equal(f.calls.length, 0)
})

test('receipt is reserved before dispatch, duplicate retries do not execute and busy rejects', async t => {
  let complete, calls = 0
  const f = await fixture(t, { onMessage: () => { calls++; return new Promise(resolve => { complete = resolve }) } }), token = await pair(f)
  const first = await request(f.status, '/api/message', { token, value: { id: 'phone-1', text: 'hello' } })
  assert.equal(first.status, 202); assert.equal(first.body.receipt.status, 'pending')
  const repeat = await request(f.status, '/api/message', { token, value: { id: 'phone-1', text: 'hello' } })
  assert.equal(repeat.status, 200); assert.equal(repeat.body.duplicate, true)
  assert.equal((await request(f.status, '/api/message', { token, value: { id: 'phone-1', text: 'changed' } })).status, 409)
  assert.equal((await request(f.status, '/api/message', { token, value: { id: 'phone-2', text: 'hello' } })).body.error, 'BUSY')
  assert.equal(calls, 1)
  complete({ success: true, status: 'accepted' }); await tick()
  let state = await request(f.status, '/api/state', { token })
  assert.equal(state.body.busy, true); assert.equal(state.body.receipt.status, 'accepted')
  assert.equal(f.api.resolveCommand('wrong-scope', 'phone-1', { success: true }), false)
  assert.equal(f.api.resolveCommand(f.scope, 'phone-1', { success: true, status: 'completed' }), true)
  state = await request(f.status, '/api/state', { token })
  assert.equal(state.body.busy, false); assert.equal(state.body.receipt.status, 'completed')
  assert.equal((await request(f.status, '/api/message', { token, value: { id: 'phone-1', text: 'hello' } })).body.duplicate, true)
  assert.equal(calls, 1)
})

test('native failure does not leak details; desktop busy and snapshot publication are enforced', async t => {
  const f = await fixture(t, { onMessage: () => { throw new Error('/private/token-secret') } }), token = await pair(f)
  const snapshot = { busy: true, messages: [] }
  assert.equal(f.api.publish(f.scope, snapshot), true)
  snapshot.busy = false
  assert.equal((await request(f.status, '/api/message', { token, value: { id: 'one', text: 'hello' } })).body.error, 'BUSY')
  f.api.publish(f.scope, { busy: false })
  await request(f.status, '/api/message', { token, value: { id: 'one', text: 'hello' } }); await tick()
  const state = await request(f.status, '/api/state', { token })
  assert.equal(state.body.receipt.status, 'rejected')
  assert.doesNotMatch(JSON.stringify(state.body), /private|token-secret/)
})

test('pair rate limiting is per peer and global, with a bounded rolling window', async t => {
  const f = await fixture(t)
  const wrong = { code: 'AAAAAAAAAAAA' }
  for (let index = 0; index < 5; index++) assert.equal((await request(f.status, '/api/pair', { value: wrong })).status, 401)
  assert.equal((await request(f.status, '/api/pair', { value: { code: f.status.pairingCode } })).status, 429)
  for (const localAddress of ['127.0.0.2', '127.0.0.3', '127.0.0.4']) {
    for (let index = 0; index < 5; index++) assert.equal((await request(f.status, '/api/pair', { value: wrong, localAddress })).status, 401)
  }
  assert.equal((await request(f.status, '/api/pair', { value: wrong, localAddress: '127.0.0.5' })).status, 429)
  for (let index = 0; index < 3; index++) { f.advance(20000); assert.equal(f.api.publish(f.scope, {}), true) }
  assert.equal((await request(f.status, '/api/pair', { value: wrong })).status, 401)
})

test('scope changes revoke immediately, abort pending dispatch and ignore late result', async t => {
  let finish, command
  const f = await fixture(t, { onMessage: value => { command = value; return new Promise(resolve => { finish = resolve }) } }), token = await pair(f)
  await request(f.status, '/api/message', { token, value: { id: 'one', text: 'hello' } })
  assert.equal(command.signal.aborted, false)
  assert.equal(f.api.publish({ ...f.scope, conversationId: 'chat-two' }, { busy: false }), false)
  assert.equal(f.api.getStatus().enabled, false); assert.equal(command.signal.aborted, true)
  finish({ success: true }); await tick()
  assert.equal(f.api.resolveCommand(f.scope, 'one', { success: true }), false)
})

test('heartbeat and fixed session expiry fail closed; publication cannot resurrect stale sessions', async t => {
  const f = await fixture(t), token = await pair(f)
  f.advance(LIMITS.heartbeatMs)
  assert.equal((await request(f.status, '/api/state', { token })).status, 410)
  assert.equal(f.api.publish(f.scope, { busy: false }), false)
  assert.equal(f.api.getStatus().reason, 'desktop-unavailable')
  await f.api.stop()
  f.status = await f.api.start(f.scope, { busy: false })
  const secondToken = await pair(f)
  for (let index = 0; index < (LIMITS.sessionMs / 20000) - 1; index++) {
    f.advance(20000); assert.equal(f.api.publish(f.scope, { busy: false }), true)
  }
  f.advance(20000)
  assert.equal((await request(f.status, '/api/state', { token: secondToken })).status, 410)
  assert.equal(f.api.getStatus().reason, 'session-expired')
})

test('pairing expires after five minutes even with fresh renderer snapshots', async t => {
  const f = await fixture(t)
  for (let index = 0; index < 14; index++) { f.advance(20000); assert.equal(f.api.publish(f.scope, {}), true) }
  f.advance(20000)
  assert.equal((await request(f.status, '/api/pair', { value: { code: f.status.pairingCode } })).status, 410)
  assert.equal(f.api.getStatus().reason, 'pairing-expired')
})

test('local phone pairing rotates without closing and one trusted credential survives restarts and long sessions',async t=>{
  let remembered=null
  const deviceStore={read:async()=>remembered,write:async value=>{remembered={...value}},forget:async()=>{remembered=null}}
  const f=await fixture(t,{deviceStore,onCommand:async()=>({success:true,status:'completed'})})
  assert.equal(f.status.sessionExpiresAt,null)
  const firstCode=f.status.pairingCode
  for(let i=0;i<16;i++) {f.advance(20000);assert.equal(f.api.publish(f.scope,{contextId:'context',available:true}),true)}
  assert.equal(f.api.getStatus().enabled,true)
  assert.notEqual(f.api.getStatus().pairingCode,firstCode)
  assert.equal((await request(f.status,'/api/pair',{value:{code:firstCode}})).status,401)
  f.status=f.api.getStatus()
  const token=await pair(f)
  assert.equal(remembered.expiresAt,null)
  assert.equal((await request(f.status,'/api/state',{token})).status,200)
  for(let i=0;i<4321;i++) {f.advance(20000);assert.equal(f.api.publish(f.scope,{contextId:'context',available:true}),true)}
  assert.equal((await request(f.status,'/api/state',{token})).status,200,'No 24-hour forced reconnect')
  await f.api.stop('app-quit')
  f.status=await f.api.start('fresh-renderer-scope',{contextId:'new-context',available:true})
  assert.equal(f.status.paired,true);assert.equal(f.status.pairingCode,null)
  assert.equal((await request(f.status,'/api/state',{token})).status,200)
  assert.equal((await request(f.status,'/api/state',{token:'b'.repeat(64)})).status,401)
  f.advance(LIMITS.heartbeatMs)
  assert.equal(f.api.isCurrentScope('fresh-renderer-scope'),false,'Stale renderer never grants live authority')
  assert.equal((await request(f.status,'/api/state',{token})).status,410)
})

test('local remembered legacy credential migrates to until-forgotten without exposing its key',async t=>{
  const token='a'.repeat(64),digest=require('node:crypto').createHash('sha256').update(token).digest('hex')
  let remembered={version:1,digest,expiresAt:200000},writes=0
  const deviceStore={read:async()=>remembered,write:async value=>{writes++;remembered={version:2,...value,expiresAt:null}},forget:async()=>{remembered=null}}
  const f=await fixture(t,{deviceStore,onCommand:async()=>({success:true})})
  assert.equal(writes,1)
  assert.equal((await request(f.status,'/api/state',{token})).status,200)
  assert.doesNotMatch(JSON.stringify(f.status),new RegExp(token))
})

test('remembered phone polling during credential loading gets temporary unavailability without breaking startup',async t=>{
  const f=await fixture(t)
  await f.api.stop()
  let release,reading
  const loaded=new Promise(resolve=>{release=resolve}),entered=new Promise(resolve=>{reading=resolve})
  const token='a'.repeat(64),digest=require('node:crypto').createHash('sha256').update(token).digest('hex')
  const api=createMobileCompanionServer({clientRoot:f.root,host:'127.0.0.1',port:f.status.port,
    networkInterfaces:()=>({}),onMessage:async()=>({success:true}),onCommand:async()=>({success:true}),
    deviceStore:{read:async()=>{reading();await loaded;return {version:2,digest,expiresAt:null}},write:async()=>{},forget:async()=>{}}})
  t.after(()=>api.stop())
  const starting=api.start('fresh-scope',{available:true})
  await entered
  assert.equal((await request(f.status,'/api/state',{token})).status,503)
  release()
  const status=await starting
  assert.equal(status.enabled,true)
  assert.equal((await request(status,'/api/state',{token})).status,200)
})

test('long-lived local sessions prune settled receipts and retain recent duplicate protection',async t=>{
  let remembered=null,calls=0
  const deviceStore={read:async()=>remembered,write:async value=>{remembered=value},forget:async()=>{remembered=null}}
  const f=await fixture(t,{deviceStore,onCommand:async()=>{calls++;return {success:true,status:'completed'}}})
  f.api.publish(f.scope,{protocol:3,contextId:'context',available:true})
  const token=await pair(f)
  for(let i=0;i<LIMITS.receipts+5;i++) {
    const response=await request(f.status,'/api/command',{token,value:{id:`request-${i}`,kind:'models',contextId:'context'}})
    assert.equal(response.status,202)
  }
  const count=calls,state=(await request(f.status,'/api/state',{token})).body
  assert.equal(state.receipts.length,LIMITS.receipts)
  assert.equal(state.receipts.some(record=>record.id==='request-0'),false)
  const duplicate=await request(f.status,'/api/command',{token,value:{id:`request-${LIMITS.receipts+4}`,kind:'models',contextId:'context'}})
  assert.equal(duplicate.body.duplicate,true);assert.equal(calls,count)
})

test('missing or escaping client assets refuse startup without listening', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-companion-missing-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const api = createMobileCompanionServer({ clientRoot: root, onMessage: () => {}, port: 0, host: '127.0.0.1' })
  t.after(() => api.stop())
  assert.equal(api.getStatus().enabled, false)
  await assert.rejects(api.start('scope', {}), /could not start/)
  assert.equal(api.getStatus().enabled, false)
  await fs.symlink(__filename, path.join(root, 'live.html'))
  await assert.rejects(api.start('scope', {}), /could not start/)
})

test('restart drops old tokens and receipts, and late callback cannot settle the new session', async t => {
  let finish
  const f = await fixture(t, { onMessage: () => new Promise(resolve => { finish = resolve }) }), token = await pair(f)
  await request(f.status, '/api/message', { token, value: { id: 'one', text: 'hello' } })
  await f.api.stop('revoked')
  f.status = await f.api.start('new-scope', { project: 'New project', busy: false })
  assert.equal((await request(f.status, '/api/state', { token })).status, 401)
  const newToken = await pair(f)
  finish({ success: true }); await tick()
  const state = await request(f.status, '/api/state', { token: newToken })
  assert.equal(state.body.receipt, null); assert.deepEqual(state.body.receipts, [])
  assert.equal(state.body.snapshot.project, 'New project')
})

test('phone unpair requires authentication and same origin, then revokes after acknowledging', async t => {
  let command, finish, calls = 0
  const seen = []
  const f = await fixture(t, { onStatus: status => seen.push(status),
    onMessage: value => { command = value; calls++; return new Promise(resolve => { finish = resolve }) } })
  const token = await pair(f)
  assert.equal((await request(f.status, '/api/unpair')).status, 401)
  assert.equal((await request(f.status, '/api/unpair', { token: 'wrong' })).status, 401)
  assert.equal((await request(f.status, '/api/unpair', { token, headers: { Origin: 'https://evil.example' } })).status, 403)
  assert.equal((await request(f.status, '/api/unpair', { token, headers: { Host: 'evil.example' } })).status, 403)
  assert.equal((await request(f.status, '/api/unpair', { token, method: 'GET' })).status, 405)
  assert.equal((await request(f.status, '/api/unpair', { token, value: { confirm: true } })).status, 400)
  assert.equal(f.api.getStatus().enabled, true)
  await request(f.status, '/api/message', { token, value: { id: 'pending-one', text: 'hello' } })
  const response = await request(f.status, '/api/unpair', { token })
  assert.equal(response.status, 200); assert.deepEqual(response.body, { success: true })
  assert.equal(command.signal.aborted, true)
  assert.equal(f.api.getStatus().enabled, false)
  assert.equal(f.api.getStatus().reason, 'unpaired')
  assert.equal(seen.at(-1).reason, 'unpaired')
  await assert.rejects(request(f.status, '/api/state', { token }))
  await assert.rejects(request(f.status, '/api/message', { token, value: { id: 'pending-one', text: 'hello' } }))
  assert.equal(calls, 1)
  finish({ success: true }); await tick()
  f.status = await f.api.start(f.scope, { busy: false })
  assert.notEqual(f.api.getStatus().pairingCode, null)
  assert.equal((await request(f.status, '/api/state', { token })).status, 401)
  const freshToken = await pair(f)
  assert.notEqual(freshToken, token)
  const state = await request(f.status, '/api/state', { token: freshToken })
  assert.deepEqual(state.body.receipts, []); assert.equal(state.body.receipt, null)
  assert.equal(calls, 1)
})

test('scope identity is stable by keys and native status never exports scope or callback error', async t => {
  const seen = []
  const f = await fixture(t, { onStatus: status => { seen.push(status); throw new Error('UI observer failed') } })
  assert.equal(f.api.publish({ session: f.scope.session, conversationId: f.scope.conversationId, projectKey: f.scope.projectKey }, { busy: false }), true)
  assert.equal(seen.length, 1)
  assert.doesNotMatch(JSON.stringify(seen), /private\/project|chat-one|renderer-one/)
  await assert.rejects(f.api.start(f.scope, {}), /already enabled/)
})

test('IPv4 admission rejects public, IPv6, malformed and ambiguous addresses', () => {
  for (const value of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1']) assert.equal(privateAddress(value), true)
  for (const value of ['127.0.0.1', '127.0.0.2', '::ffff:127.0.0.1', '10.0.0.1']) assert.equal(allowedPeer(value), true)
  for (const value of ['8.8.8.8', '172.32.0.1', '169.254.1.1', '::1', '100.64.1.2', '010.0.0.1', '10.0.0.256', 'localhost']) assert.equal(allowedPeer(value), false)
})
