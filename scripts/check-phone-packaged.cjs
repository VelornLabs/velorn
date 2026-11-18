'use strict'

// Disposable packaged Electron smoke test. It never launches Velorn, uses a
// real user profile, opens a browser, contacts production, or builds a release.
// The ASAR contains only fixture code, required native phone modules, and the
// production ws package. Account replies/native consent are synthetic; the
// final API-only probe owns one temporary loopback listener.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms))
const marker = 'VELORN_PHONE_PACKAGED_RESULT '

async function copyModules(sourceRoot, destinationRoot, filenames, copied = new Set()) {
  for (const filename of filenames) {
    const absolute=path.resolve(sourceRoot,filename)
    assert.ok(absolute.startsWith(path.join(sourceRoot,'electron')+path.sep),'Only native Electron modules may enter the fixture')
    if (copied.has(absolute)) continue
    copied.add(absolute)
    const source=await fs.readFile(absolute,'utf8')
    const destination=path.join(destinationRoot,path.relative(sourceRoot,absolute))
    await fs.mkdir(path.dirname(destination),{recursive:true})
    await fs.copyFile(absolute,destination)
    const dependencies=[...source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)].map(match=>path.relative(sourceRoot,path.resolve(path.dirname(absolute),match[1])))
    await copyModules(sourceRoot,destinationRoot,dependencies,copied)
  }
  return copied
}

async function launch() {
  if (process.argv.length>2) throw Error('Usage: node scripts/check-phone-packaged.cjs')
  if (process.platform!=='linux') throw Error('This disposable packaged smoke harness currently targets Linux Electron; it does not certify other installer platforms.')
  const root=path.resolve(__dirname,'..')
  const output=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-phone-packaged-'))
  const source=path.join(output,'fixture-source'), runtime=path.join(output,'electron-runtime')
  const {createPackage,listPackage}=require('@electron/asar')
  const {spawn}=require('node:child_process')
  const electronBinary=process.env.VELORN_TEST_ELECTRON_BINARY || require('electron')
  const electronDistribution=path.dirname(electronBinary)
  let child
  try {
    await fs.mkdir(path.join(source,'scripts'),{recursive:true})
    await fs.copyFile(__filename,path.join(source,'scripts','check-phone-packaged.cjs'))
    const modules=await copyModules(root,source,['electron/mobileCompanionRuntime.cjs','electron/mobileCompanion.cjs','electron/remoteCompanionGuided.cjs'])
    const packageJson=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'))
    assert.ok(packageJson.dependencies.ws,'ws must be a production dependency')
    await fs.cp(path.dirname(require.resolve('ws/package.json')),path.join(source,'node_modules','ws'),{recursive:true})
    await fs.writeFile(path.join(source,'package.json'),JSON.stringify({name:'velorn-phone-packaged-fixture',version:'0.0.0',main:'scripts/check-phone-packaged.cjs',dependencies:{ws:packageJson.dependencies.ws}}))
    await fs.writeFile(path.join(source,'preload.cjs'),"const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('phoneFixture',{invoke:(channel,payload)=>ipcRenderer.invoke(channel,payload),events:[]});ipcRenderer.on('mobile-companion:event',(_event,value)=>{globalThis.fixtureEvents ||= [];globalThis.fixtureEvents.push(value)});\n")
    await fs.writeFile(path.join(source,'index.html'),'<!doctype html><meta charset="utf-8"><title>Velorn packaged phone fixture</title><h1>Synthetic packaged phone fixture</h1><iframe src="frame.html"></iframe>')
    await fs.writeFile(path.join(source,'frame.html'),'<!doctype html><meta charset="utf-8"><title>Synthetic subframe</title>Fixture subframe')
    const archive=path.join(output,'app.asar')
    await createPackage(source,archive)
    const entries=listPackage(archive).map(entry=>entry.replace(/^\//,''))
    assert.equal(entries.some(entry=>/(?:^|\/)(?:live\.(?:html|css|js)|\.env|phone-account\.json|remote-companion\.json|mobile-companion-device\.json)$/.test(entry)),false,'No private UI/configuration/credential file is shipped')
    assert.ok(entries.includes('node_modules/ws/index.js'))
    await fs.writeFile(path.join(output,'archive-manifest.json'),JSON.stringify(entries,null,2))
    // A separate resources/app.asar and no application argument are essential:
    // passing a source file to the installed Electron binary is not packaged.
    await fs.cp(electronDistribution,runtime,{recursive:true,mode:require('node:fs').constants.COPYFILE_FICLONE})
    await fs.copyFile(archive,path.join(runtime,'resources','app.asar'))
    // Electron's Linux packaged-state check also depends on the executable
    // name: a binary still named "electron" is treated as a development host.
    const executable=path.join(runtime,'velorn-phone-fixture')
    await fs.rename(path.join(runtime,path.basename(electronBinary)),executable)
    const env={...process.env,VELORN_PHONE_PACKAGED_OUTPUT:output}
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    delete env.NODE_PATH
    child=spawn(executable,['--no-sandbox','--disable-gpu'],{cwd:output,env,stdio:['ignore','pipe','pipe'],windowsHide:true})
    let stdout='',stderr=''
    child.stdout.on('data',chunk=>{stdout=(stdout+chunk).slice(-64000)})
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-20000)})
    const exit=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill();reject(Error('Packaged phone smoke timed out'))},45000)
      child.once('error',error=>{clearTimeout(timer);reject(error)})
      child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal})})
    })
    const line=stdout.split(/\r?\n/).find(value=>value.startsWith(marker))
    if (exit.code!==0 || !line) throw Error(`Packaged fixture failed (${exit.signal || exit.code}).\n${stdout}\n${stderr}`)
    const report=JSON.parse(line.slice(marker.length))
    assert.equal(report.success,true)
    assert.equal(report.isPackaged,true)
    assert.equal(report.outboundRequests,0)
    assert.equal(report.startupListeners,0)
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify({...report,nativeModules:modules.size,archive},null,2))
    console.log(JSON.stringify({...report,nativeModules:modules.size,output,archive},null,2))
  } finally {
    if (child && child.exitCode===null && child.signalCode===null) child.kill()
    // Only generated directories under this exact mkdtemp root are removed;
    // preserve the small ASAR, manifest and result for independent inspection.
    await fs.rm(runtime,{recursive:true,force:true})
    await fs.rm(source,{recursive:true,force:true})
  }
}

async function runPackaged() {
  const {app,BrowserWindow,ipcMain,session}=require('electron')
  const output=process.env.VELORN_PHONE_PACKAGED_OUTPUT
  assert.ok(output && path.isAbsolute(output) && path.basename(output).startsWith('velorn-phone-packaged-'))
  const profile=path.join(output,'isolated-userData')
  await fs.mkdir(profile,{recursive:true})
  app.setPath('userData',profile)
  app.setPath('sessionData',path.join(output,'isolated-session'))
  app.setAppLogsPath(path.join(output,'logs'))
  for (const name of ['disable-background-networking','disable-component-update','disable-breakpad']) app.commandLine.appendSwitch(name)
  await app.whenReady()
  assert.equal(app.isPackaged,true,'This test must run a genuine resources/app.asar application')
  assert.equal(process.defaultApp,undefined)
  assert.ok(app.getAppPath().endsWith(path.join('resources','app.asar')))
  const rendererRequests=[]
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{
    const allowed=/^(file:|data:|devtools:)/.test(details.url)
    if (!allowed) rendererRequests.push(details.url)
    callback({cancel:!allowed})
  })
  const http=require('node:http'),https=require('node:https'),net=require('node:net')
  const networkAttempts=[],listeners=[]
  let allowedApiOrigin=null
  for (const module of [http,https]) {
    const original=module.request
    module.request=function (...args) {
      const value=args[0]
      const target=typeof value==='string' || value instanceof URL ? new URL(value)
        : new URL(`${module===https ? 'https:' : 'http:'}//${value?.hostname || value?.host}${value?.port ? `:${value.port}` : ''}${value?.path || '/'}`)
      if (target.origin!==allowedApiOrigin) {networkAttempts.push(target.origin);throw Error('Request outside the exact owned API listener blocked by packaged fixture')}
      return original.apply(this,args)
    }
  }
  const originalListen=net.Server.prototype.listen
  net.Server.prototype.listen=function (...args) {
    listeners.push(args.slice(0,2))
    assert.equal(args[1],'127.0.0.1','Native API may listen only on fixture loopback')
    return originalListen.apply(this,args)
  }
  const {desktopPhoneRuntime}=require('../electron/mobileCompanionRuntime.cjs')
  const {registerMobileCompanionIpc,CHANNELS}=require('../electron/mobileCompanion.cjs')
  const {createGuidedCompanion,privateRead}=require('../electron/remoteCompanionGuided.cjs')
  const runtime=desktopPhoneRuntime({isPackaged:app.isPackaged,userData:app.getPath('userData'),electronRoot:path.resolve(__dirname,'../electron')})
  assert.equal(runtime.clientRoot,null)
  assert.equal(runtime.guided.configPath,null)
  assert.equal(require.resolve('ws').includes('app.asar/node_modules/ws/'),true,'Transport loads production ws from the actual archive')
  const windows=[],groups=[],responses=[],opens=[],dialogs=[],requests=[]
  let controller,hub,main,setup=null
  const origin='http://127.0.0.1:48999'
  const request=async input=>{
    assert.equal(input.url.origin,origin,'Synthetic account adapter cannot target production')
    requests.push({route:input.url.pathname,body:structuredClone(input.body),token:input.token})
    const body=input.body
    switch(input.url.pathname) {
      case '/account/setup/start': setup=body;return {setupId:body.setupId,expiresAt:Date.now()+600000}
      case '/account/setup/status': return {status:'approved',accountDisplayName:'Synthetic account',expiresAt:Date.now()+600000,computerId:setup.setupId}
      case '/account/setup/finish': assert.equal(body.approved,true);return {status:'complete',computerId:setup.setupId}
      case '/account/desktop/guided/status': return {computer:{id:setup.setupId,name:setup.name},requests:[],devices:[]}
      case '/account/desktop/guided/presence': return {success:true}
      case '/account/desktop/guided/unregister': return {success:true}
      default: throw Error('Unexpected synthetic account route')
    }
  }
  const register=()=>registerMobileCompanionIpc({ipcMain,app,getMainWindow:()=>main,...runtime,
    dialog:{async showMessageBox(window,options){assert.equal(window,main);dialogs.push(options);return {response:1}}},
    createServer(options){hub=createGuidedCompanion(options,{...runtime.guided,origin,allowLocalTest:true,request,pollMs:1000000,openBrowser:async url=>opens.push(url)});return hub}})
  const makeWindow=async()=>{
    const window=new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'../preload.cjs'),contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:true,sandbox:false}})
    windows.push(window)
    await window.loadFile(path.resolve(__dirname,'../index.html'))
    return window
  }
  const invoke=async(name,payload,frame=main.webContents.mainFrame)=>{
    const result=await frame.executeJavaScript(`window.phoneFixture.invoke(${JSON.stringify(CHANNELS[name])},${JSON.stringify(payload) || 'undefined'})`)
    responses.push(result);return result
  }
  const scope='packaged_fixture_scope_0001'
  const snapshot={protocol:3,contextId:'packaged_context_00000001',chatId:'packaged_chat_00000001',available:true,busy:false,provider:'codex',projectName:'Synthetic packaged project',messages:[],approvals:[]}
  try {
    main=await makeWindow()
    controller=register()
    const fresh=await invoke('preference')
    assert.equal(fresh.success,true)
    assert.equal(fresh.available,true)
    assert.equal(fresh.guidedAvailable,true)
    assert.equal(fresh.legacyAvailable,false)
    assert.equal(fresh.enabled,false)
    assert.equal(fresh.status.enabled,false)
    assert.deepEqual(fresh.status.urls,[])
    await delay(120)
    assert.equal(requests.length,0)
    assert.equal(networkAttempts.length,0)
    assert.equal(listeners.length,0)
    assert.equal(opens.length,0)
    assert.equal(dialogs.length,0)
    for (const filename of [runtime.guided.statePath,runtime.deviceStorePath,runtime.preferencePath]) await assert.rejects(fs.stat(filename),{code:'ENOENT'})
    groups.push('actual packaged ASAR startup advertises hosted access without login, phone-state writes, requests or listeners')
    const other=await makeWindow()
    assert.equal((await invoke('preference',undefined,other.webContents.mainFrame)).code,'MOBILE_COMPANION_UNAUTHORIZED')
    const subframe=main.webContents.mainFrame.frames[0]
    assert.ok(subframe,'Real renderer subframe exists')
    assert.equal((await invoke('preference',undefined,subframe)).code,'MOBILE_COMPANION_UNAUTHORIZED')
    assert.equal((await invoke('enable',{scope,snapshot})).code,'MOBILE_COMPANION_UNAVAILABLE')
    assert.equal(requests.length,0)
    assert.equal(listeners.length,0)
    groups.push('main-frame authorization rejects other windows, subframes, and legacy LAN enable')
    const setupResult=await invoke('guidedSetup',{scope,snapshot,name:'Synthetic packaged desktop',automatic:true})
    assert.equal(setupResult.success,true)
    for (let attempt=0;attempt<30 && !hub.getStatus().guided.registered;attempt++) {await hub.checkGuided();await delay(20)}
    assert.equal(hub.getStatus().guided.registered,true)
    assert.deepEqual(hub.getStatus().guided.account,{displayName:'Synthetic account'})
    assert.equal(dialogs.length,1,'Synthetic registration uses the existing native account confirmation')
    assert.equal(main.isVisible(),true,'Browser approval brings the real packaged confirmation window forward')
    assert.equal(opens.length,1)
    const saved=await privateRead(runtime.guided.statePath)
    assert.equal(saved.enabled,true)
    assert.equal(saved.automaticAccountAccess,true)
    assert.equal(saved.computer.name,'Synthetic packaged desktop')
    assert.equal(opens[0],`${origin}/account#desktop=${saved.computer.id}`)
    assert.equal((await fs.stat(runtime.guided.statePath)).mode & 0o777,0o600)
    assert.equal(listeners.length,0,'Account enrollment alone does not expose a LAN or loopback listener')
    groups.push('explicit synthetic setup uses native consent and private installation-local account persistence')
    await controller.dispose()
    controller=register()
    const restored=await invoke('preference')
    assert.equal(restored.enabled,true)
    assert.equal(restored.status.enabled,false,'Remembered permission does not run until fresh renderer attach')
    assert.deepEqual(restored.status.guided.account,{displayName:'Synthetic account'},'Verified profile survives a packaged restart')
    assert.equal((await invoke('attach',{scope,snapshot})).success,true)
    assert.equal(hub.getStatus().enabled,true)
    assert.equal(hub.getStatus().legacyEnabled,false)
    assert.equal(dialogs.length,1,'Reattachment does not request duplicate enrollment consent')
    assert.equal(opens.length,1,'Reattachment does not open setup again')
    const afterRestore=await privateRead(runtime.guided.statePath)
    assert.equal(afterRestore.computer.token,saved.computer.token)
    const disabled=await invoke('disable',{scope})
    assert.equal(disabled.success,true)
    assert.deepEqual(disabled.status.guided.account,{displayName:'Synthetic account'},'Pausing does not sign the account out')
    assert.equal((await invoke('preference')).enabled,false)
    const serialized=JSON.stringify({responses,status:hub.getStatus(),opens,dialogs})
    assert.equal(serialized.includes(saved.computer.token),false,'IPC/status/browser destinations never contain the native account credential')
    assert.equal(serialized.includes(profile),false,'Renderer metadata does not leak private installation paths')
    assert.equal(networkAttempts.length,0)
    assert.equal(listeners.length,0)
    groups.push('guided-only restart/attach preserves native credentials without legacy listeners; disable persists')
    const requestCount=requests.length
    const unregistered=await invoke('guidedUnregister',{scope})
    assert.equal(unregistered.success,true)
    assert.equal(unregistered.status.enabled,false)
    assert.equal(unregistered.status.guided.registered,false)
    assert.equal(unregistered.status.guided.account,null)
    assert.deepEqual(requests.slice(requestCount).map(item=>item.route),['/account/desktop/guided/unregister'])
    assert.equal(dialogs.length,2,'Paused disconnect still requires the native confirmation')
    assert.equal(opens.length,1)
    assert.equal(listeners.length,0,'Account management never resumes phone transports')
    assert.equal((await invoke('preference')).enabled,false)
    groups.push('paused account disconnect needs native consent but starts no sharing, login, or transport')
    await controller.dispose();controller=null
    const {createMobileCompanionServer}=require('../electron/mobileCompanionServer.cjs')
    const {createDeviceStore}=require('../electron/mobileCompanionDevice.cjs')
    const api=createMobileCompanionServer({apiOnly:true,clientRoot:null,deviceStore:createDeviceStore(path.join(profile,'synthetic-api-device.json')),onMessage:async()=>({success:true,status:'completed'}),onCommand:async()=>({success:true,status:'completed'})})
    try {
      await api.start(scope,snapshot)
      const status=api.getStatus()
      allowedApiOrigin=new URL(status.localUrl).origin
      assert.equal(status.transport,'loopback-http')
      assert.equal(status.pairingCode,null)
      assert.deepEqual(status.urls,[])
      for (const route of ['/','/live.html','/live.js','/live.css','/api/pair']) {
        const statusCode=await new Promise((resolve,reject)=>{
          const target=new URL(route,status.localUrl)
          const req=http.request(target,{method:'GET',headers:{Origin:target.origin}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode))})
          req.once('error',reject);req.end()
        })
        assert.equal(statusCode,404,`No client or browser pairing route ${route}`)
      }
      const readState=authorization=>new Promise((resolve,reject)=>{
        const target=new URL('/api/state',status.localUrl)
        const req=http.request(target,{headers:{Origin:target.origin,...(authorization ? {Authorization:authorization} : {})}},response=>{
          const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}))
        })
        req.once('error',reject);req.end()
      })
      assert.equal((await readState()).status,401)
      const deviceCredential=await api.pairApprovedDevice({isCurrent:()=>true})
      const state=await readState(`Bearer ${deviceCredential}`)
      assert.equal(state.status,200)
      assert.equal(state.body.snapshot.projectName,snapshot.projectName)
      assert.equal(JSON.stringify({state,status:api.getStatus()}).includes(deviceCredential),false,'Native device credential never appears in public state/status')
      assert.equal(listeners.length,1)
      assert.equal(listeners[0][1],'127.0.0.1')
    } finally {await api.stop('fixture-finished');allowedApiOrigin=null}
    groups.push('real API-only loopback module runs authenticated state from ASAR without private assets and rejects UI/pair routes')
    assert.deepEqual(networkAttempts,[])
    assert.deepEqual(rendererRequests,[])
    console.log(marker+JSON.stringify({success:true,isPackaged:app.isPackaged,syntheticOnly:true,startupListeners:0,outboundRequests:0,groups}))
  } finally {
    await controller?.dispose()
    for (const window of windows) if (!window.isDestroyed()) window.destroy()
  }
}

if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
  runPackaged().then(()=>require('electron').app.exit(0),error=>{console.error(error);require('electron').app.exit(1)})
} else launch().catch(error=>{console.error(error);process.exitCode=1})
