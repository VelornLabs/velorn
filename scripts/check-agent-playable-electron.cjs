// Verify production attachment URLs in an isolated, hidden Electron
// renderer. No running editor, account, project or generation is touched.
const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict')
const {createAgentReviewMediaStore}=require('../electron/agentReviewMediaStore.cjs')
const {registerAgentReviewMediaIpc,CHANNELS}=require('../electron/agentReviewMediaIpc.cjs')
const {execFileSync}=require('node:child_process')
const root=fs.mkdtempSync(path.join(os.tmpdir(),'velorn-electron-media-'))
app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration()
app.whenReady().then(async()=>{
 const audio=path.join(root,'Audio #1.wav'),video=path.join(root,'Video #1.mp4')
 execFileSync(require('ffmpeg-static'),['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','3',audio])
 execFileSync(require('ffmpeg-static'),['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-t','3','-c:v','libx264','-pix_fmt','yuv420p',video])
 const window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,autoplayPolicy:'no-user-gesture-required'}})
 const store=createAgentReviewMediaStore(),handlers=new Map()
 await store.savePlayable(root,[{id:'audio',type:'audio',path:path.basename(audio)},{id:'video',type:'video',path:path.basename(video)}],{chatId:'chat',turnId:'one'})
 registerAgentReviewMediaIpc({ipcMain:{handle:(key,fn)=>handlers.set(key,fn)},getMainWindow:()=>window,getProjectPath:async()=>root,store})
 const resultUrls=await handlers.get(CHANNELS.listPlayable)({sender:window.webContents,senderFrame:window.webContents.mainFrame},{projectPath:root,chatId:'chat',turnIds:['one']})
 assert.equal(resultUrls.success,true)
 const url=type=>resultUrls.items.find(item=>item.type===type).url
 const html=path.join(root,'index.html')
 fs.writeFileSync(html,`<audio controls preload="metadata" src="${url('audio')}"></audio><video controls muted preload="metadata" src="${url('video')}"></video>`)
 await window.loadFile(html)
 const result=await window.webContents.executeJavaScript(`Promise.all([...document.querySelectorAll('audio,video')].map(async media=>{
   await Promise.race([new Promise((resolve,reject)=>{if(media.readyState>=1)return resolve();if(media.error)return reject(Error(media.tagName+': '+media.error.message));media.onloadedmetadata=resolve;media.onerror=()=>reject(Error(media.tagName+': '+(media.error?.message||'Decode failed')))}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Metadata timeout '+media.tagName+' state='+media.networkState+' error='+media.error?.message)),10000))]);
   media.muted=true;await media.play();await new Promise(resolve=>setTimeout(resolve,300));media.pause();return {type:media.tagName,duration:media.duration,time:media.currentTime};
 }))`)
 assert.equal(result.length,2);for(const item of result){assert.ok(item.duration>=2.9);assert.ok(item.time>0)}
 console.log(JSON.stringify({success:true,result}));window.destroy();app.quit()
}).catch(error=>{console.error(error);app.exit(1)})
