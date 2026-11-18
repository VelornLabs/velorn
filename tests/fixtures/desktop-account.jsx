// Real account/TitleBar/mobile hook, deterministic native bridge and RAM-only
// storage. No App startup, real project, auth session, provider, or service.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'

const clone = value => value === undefined ? undefined : structuredClone(value)
const storage = new Map()
Object.defineProperty(window,'localStorage',{value:{
  getItem:key=>storage.get(key) ?? null,setItem:(key,value)=>storage.set(key,String(value)),
  removeItem:key=>storage.delete(key),clear:()=>storage.clear(),key:index=>[...storage.keys()][index] ?? null,
  get length(){return storage.size},
}})
const calls=[],forbiddenCalls=[],listeners=new Set()
let subscriptions=0,unsubscriptions=0,maxListeners=0,setConfiguration,rerenderFixture
let mode='signedout',hasProject=false,revision=0,holdAction=null,held=[]
const originalDevices=[{id:'synthetic-phone-one',name:'Fixture Android',connected:true},{id:'synthetic-phone-two',name:'Fixture iPhone',connected:false}]
let devices=clone(originalDevices)
let veeResult={success:true,provider:'luna',available:true,status:'eligible'},holdVee=false,veeResolvers=[]
let accountDecision='accept'
let computerName='Fixture desktop'
const registered=()=>['linked','unknown','paused','paused-running','private-only','busy','export','long-name','malicious-name'].includes(mode)
const sharingOff=()=>['paused','paused-running','private-only'].includes(mode)
const displayName=()=>mode==='long-name' ? 'Alexandria Extremely Long Synthetic Account Display Name' : mode==='malicious-name' ? '<img src=x onerror=window.fixtureInjection=true>' : 'Jaime Example'
const status=()=>({
  enabled:registered() && mode!=='paused' || ['waiting','confirm-account'].includes(mode),
  paired:registered() && !sharingOff(),legacyEnabled:mode==='private-only',transport:'loopback-http',urls:[],pairingCode:null,fullAccess:false,
  guided:{registered:registered(),enabled:registered() && !sharingOff() || ['waiting','confirm-account'].includes(mode),
    phase:mode==='waiting' ? 'sign-in' : mode==='confirm-account' ? 'confirm-account' : mode==='error' ? 'reconnecting' : registered() ? 'ready' : 'idle',
    automaticAccountAccess:registered(),automaticAvailable:registered(),
    account:registered() && mode!=='unknown' ? {displayName:displayName(),email:'creator@example.test',emailVerified:true} : null,
    computer:registered() ? {id:'synthetic-computer',name:computerName} : null,
    computerName,
    devices:registered() ? clone(devices) : [],
    message:mode==='waiting' ? 'Finish signing in in your browser.' : mode==='confirm-account' ? 'Confirm phone access in Velorn.' : mode==='error' ? 'Synthetic phone setup failed. Try again.' : '',
  },
})
const preference=()=>({success:true,available:mode!=='unavailable',guidedAvailable:mode!=='unavailable',legacyAvailable:false,enabled:status().guided.enabled,status:status()})
const emit=()=>{for(const listener of listeners)listener({type:'status',status:status()})}
const forbidden=method=>(...args)=>{forbiddenCalls.push({method,args:clone(args)});throw Error(`Forbidden fixture operation: ${method}`)}
const mutate=async(method,payload,next)=>{
  calls.push({method,...clone(payload),userActivated:navigator.userActivation?.isActive===true})
  if(holdAction===method)await new Promise(resolve=>held.push(resolve))
  if(mode==='error')return {success:false,error:'Synthetic phone setup failed. Try again.'}
  next?.()
  emit()
  return {success:true,status:status(),guided:status().guided}
}
window.electronAPI={
  connectedAgent:{veeAvailability:async()=>{
    calls.push({method:'vee-availability'})
    const result=clone(veeResult)
    if(holdVee)await new Promise(resolve=>veeResolvers.push(resolve))
    return result
  },inspect:forbidden('provider-inspect'),send:forbidden('model-send')},
  isElectron:true,platform:'linux',
  getWindowState:async()=>({isMaximized:false,isFullScreen:false}),onWindowStateChanged:()=>()=>{},
  minimizeWindow:()=>calls.push({method:'window-minimize'}),toggleMaximizeWindow:()=>calls.push({method:'window-maximize'}),closeWindow:()=>calls.push({method:'window-close'}),
  getSetting:async()=>null,setSetting:forbidden('setSetting'),getComfyCloudCreditBalance:async()=>({status:'ok',credits:17}),
  comfyLauncher:{getState:async()=>({state:'idle',ownership:'none'}),getConfig:async()=>({disableAutoLaunch:true}),getLogs:async()=>[],onState:()=>()=>{},onLog:()=>()=>{},
    start:forbidden('comfy-start'),stop:forbidden('comfy-stop'),restart:forbidden('comfy-restart')},
  mobileCompanion:{
    desktopAccountControlsVersion:1,
    manageDesktopAccount:async payload=>{
      if(accountDecision==='cancel'){calls.push({method:'account-cancel',...clone(payload)});return {success:true,cancelled:true,status:status()}}
      return mutate('account-'+payload.action,payload,()=>{mode=payload.action==='switch-account'?'waiting':'signedout';devices=[]})
    },
    getPreference:async()=>{calls.push({method:'preference'});return preference()},
    attach:async payload=>{calls.push({method:'attach',scope:payload.scope});return {success:true,status:status(),nativeApprovals:[]}},
    detach:async payload=>{calls.push({method:'detach',scope:payload.scope});return {success:true}},
    publish:async()=>({success:true,status:status()}),
    onEvent:listener=>{listeners.add(listener);subscriptions++;maxListeners=Math.max(maxListeners,listeners.size);return()=>{listeners.delete(listener);unsubscriptions++}},
    connectPhoneAccount:payload=>mutate('connect',payload,()=>{computerName=payload.name;mode='waiting'}),
    disconnectPhoneDevice:payload=>mutate('disconnect-device',payload,()=>{devices=devices.filter(device=>device.id!==payload.deviceId)}),
    disconnectPhoneAccount:payload=>mutate('disconnect-account',payload,()=>{mode='signedout'}),
    disable:payload=>mutate('disable',payload,()=>{mode='paused'}),
    enable:forbidden('legacy-enable'),forget:forbidden('legacy-forget'),checkAccountRequests:forbidden('legacy-account-check'),reply:forbidden('phone-reply'),
  },
}

if (new URLSearchParams(location.search).has('independent')) {
  window.electronAPI.mobileCompanion.desktopAccountVersion = 1
  window.electronAPI.mobileCompanion.desktopAccount = payload => {
    if (accountDecision === 'cancel' && ['sign-out', 'switch-account'].includes(payload.action)) {
      calls.push({ method: 'account-cancel', ...clone(payload) }); return Promise.resolve({ success: true, cancelled: true, status: status() })
    }
    return mutate('desktop-account', payload, () => {
      if (payload.action === 'sign-in') { computerName = payload.name; mode = 'waiting' }
      if (payload.action === 'disable-phone') mode = 'paused'
      if (payload.action === 'enable-phone') mode = 'linked'
      if (payload.action === 'sign-out' || payload.action === 'switch-account') { mode = payload.action === 'switch-account' ? 'waiting' : 'signedout'; devices = [] }
      if (payload.action === 'disconnect-device') devices = devices.filter(device => device.id !== payload.deviceId)
    })
  }
}

const [{default:TitleBar},{DesktopAccountProvider,DesktopAccountBridge},{useMobileCompanion},{I18nProvider}]=await Promise.all([
  import('../../src/components/TitleBar'),import('../../src/components/DesktopAccount'),
  import('../../src/components/MobileCompanion'),import('../../src/i18n/I18nContext'),
])

function AgentBridge({configuration}) {
  const mobile=useMobileCompanion({scopeKey:`synthetic-account-${configuration.revision}`,chatId:'synthetic-chat',projectName:'Synthetic project',chatTitle:'Synthetic conversation',
    provider:'codex',model:'synthetic-model',messages:[],models:[],approvals:[],chats:[],loading:false,busy:configuration.mode==='busy',
    exportBusy:configuration.mode==='export',shareReviewImages:false,fullAccess:false,visible:false,settingsOpen:false,
    isCurrent:()=>true,
    onSend:forbidden('model-send'),onSelectChat:forbidden('chat-select'),onNewChat:forbidden('chat-new')})
  return <DesktopAccountBridge mobile={mobile} disabled={['busy','export'].includes(configuration.mode)} scopeKey={`synthetic-account-${configuration.revision}`} onOpenAdvanced={()=>calls.push({method:'advanced-phone'})} />
}

function Fixture() {
  const [configuration,setConfig]=useState({mode,hasProject,revision,bridge:false})
  rerenderFixture=()=>setConfig(previous=>({...previous}))
  setConfiguration=(next,nextHasProject=true,extra={})=>{
    mode=next;hasProject=nextHasProject;revision++;devices=clone(originalDevices)
    if(registered())computerName='Fixture desktop'
    setConfig({mode,hasProject,revision,bridge:nextHasProject,...extra})
    emit()
  }
  return <I18nProvider><DesktopAccountProvider hasProject={configuration.hasProject} onRequestAgent={()=>{calls.push({method:'request-agent'});setConfig(previous=>({...previous,bridge:true}))}}>
    <div className="h-screen flex flex-col bg-sf-dark-950 text-sf-text-primary">
      <TitleBar projectName={configuration.hasProject ? 'Synthetic project' : undefined} activeTab="editor" showStoryboardTab onTabChange={tab=>calls.push({method:'tab',tab})} onEditorLayoutChange={layout=>calls.push({method:'layout',layout})} exportBusy={configuration.mode==='export'} />
      <main id="fixture-editor" className="flex-1 p-8"><h1 className="text-2xl font-semibold">{configuration.hasProject ? 'Synthetic editor' : 'Welcome to Velorn'}</h1>
        <p className="mt-3 text-sf-text-muted">Account controls fixture. No real projects or accounts are loaded.</p>
        <button id="outside-button" className="mt-8 rounded border border-sf-dark-600 px-4 py-2" onClick={()=>calls.push({method:'outside'})}>Synthetic editor action</button>
      </main>
      {configuration.hasProject && configuration.bridge && <AgentBridge configuration={configuration} />}
    </div>
  </DesktopAccountProvider></I18nProvider>
}
window.desktopAccountFixture={
  accountDecision:value=>{accountDecision=value},
  vee:(result,hold=false)=>{veeResult=result;holdVee=hold},
  releaseVee:()=>{holdVee=false;for(const resolve of veeResolvers.splice(0))resolve()},
  calls,forbiddenCalls,setState:(next,nextHasProject=true,extra)=>setConfiguration(next,nextHasProject,extra),
  rerender:()=>rerenderFixture(),emit,
  hold:method=>{holdAction=method},release:()=>{holdAction=null;for(const resolve of held.splice(0))resolve()},
  stats:()=>({subscriptions,unsubscriptions,listeners:listeners.size,maxListeners}),
}
createRoot(document.getElementById('root')).render(<Fixture />)
