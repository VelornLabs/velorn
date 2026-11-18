// Actual renderer with RAM-only app/server metadata. No native app, model,
// filesystem picker, account, provider request or network is used here.
import './codex-setup-preview.css'
const host=document.getElementById('preview')
host.innerHTML=`<header><span class="badge">ISOLATED PREVIEW · NOT YOUR INSTALLED APP</span><h1>Try LM Studio setup</h1><p>Real Velorn screens, simulated local models and app controls. Your working apps, accounts and chats stay untouched.</p></header><div class="toolbar"><button id="ready">Server ready</button><button id="stopped">Server stopped</button><button id="empty">No models</button></div><div class="layout"><aside><section class="note"><h2>Try the connection-first flow</h2><p>Choose <strong>LM Studio</strong> inside Velorn. The buttons above reset only this preview.</p><p class="small">Model names are examples, not recommendations. Nothing is installed, downloaded, loaded or sent to an AI. You can leave your working apps open.</p></section><section id="step" class="note active" aria-live="polite"></section><p class="small" id="status" role="status">Loading the isolated screens…</p></aside><iframe title="Velorn LM Studio setup preview" sandbox="allow-scripts allow-same-origin"></iframe></div>`
const frame=host.querySelector('iframe'),step=host.querySelector('#step'),status=host.querySelector('#status')
const sampleModels=[{id:'preview-local-small',displayName:'Example local model · preview',loaded:true,contextLength:8192},
  {id:'preview-local-alternate',displayName:'Second example · preview',loaded:false,contextLength:4096}]
const guides=new Set(['https://lmstudio.ai/download','https://lmstudio.ai/docs/developer/core/server','https://lmstudio.ai/docs/app/basics/download-model'])
let epoch=0,scenario='ready',pendingAction=null
const show=(title,description,buttons=[])=>{
  step.replaceChildren()
  const h=document.createElement('h2');h.textContent=title;step.append(h)
  const p=document.createElement('p');p.textContent=description;step.append(p)
  for(const [label,action] of buttons){const button=document.createElement('button');button.textContent=label;button.onclick=action;step.append(button)}
}
function start(next){
  epoch++;scenario=next
  pendingAction?.({success:true,cancelled:true,opened:false,summary:'Synthetic action cancelled.'});pendingAction=null
  window.lmStudioSetupPreview={ready:false};step.replaceChildren();status.textContent='Loading the isolated screens…'
  frame.src='./codex-setup-preview-frame.html?strict=1&setupStatus=ready'
}
frame.addEventListener('load',async()=>{
  const current=epoch,w=frame.contentWindow
  for(let i=0;i<300&&!w.connectedAgentTest?.ready;i++)await new Promise(resolve=>setTimeout(resolve,20))
  if(current!==epoch)return
  if(!w.connectedAgentTest?.ready){status.textContent='Preview could not load. Choose a scenario to try again.';return}
  const test=w.connectedAgentTest,api=w.electronAPI,actionCalls=[],guideCalls=[],sendAttempts=[]
  test.setConnectionError(scenario==='stopped'?'The simulated LM Studio server is stopped.':'',scenario==='stopped'?'CONNECTION_FAILED':'')
  test.setLocalModels(scenario==='empty'?[]:sampleModels,'available')
  const style=w.document.createElement('style')
  style.textContent='#root>div>header,[data-testid="shared-workspace"]{display:none!important}.connected-agent-panel{width:100%!important;max-width:none!important;flex:1!important;border-left:0}.ca-resize{display:none!important}'
  w.document.head.append(style);w.open=()=>null
  const simulator=()=>show('Simulated LM Studio','In the real app these steps happen in LM Studio. Here they change example metadata only; they do not start a server or load a model.',[
    ['Start simulated local server',()=>{test.setConnectionError('','');status.textContent='Simulated server started. Return to Velorn and choose Check again.'}],
    ['Load example model',()=>{test.setLocalModels(sampleModels,'available');status.textContent='Example model is marked loaded. Return to Velorn and choose Check again.'}],
    ['Back to Velorn',()=>step.replaceChildren()]
  ])
  const openGuide=async url=>{
    if(!guides.has(url))throw Error('Preview permits only fixed LM Studio guide URLs')
    guideCalls.push(url)
    if(current===epoch)show('Simulated official guide','The real app opens this official guide in your browser. This preview does not leave the page or download anything.',[
      ['Continue in simulated LM Studio',simulator],['Back to Velorn',()=>step.replaceChildren()]
    ])
    return {success:true,opened:true,summary:'The simulated official guide was opened.'}
  }
  api.openExternalUrl=openGuide
  api.lmStudioApp={
    performAction:async payload=>{
      if(!payload||Object.keys(payload).length!==1||!['open','choose'].includes(payload.action))throw Error('Unexpected synthetic app action')
      actionCalls.push({...payload})
      if(pendingAction)return {success:false,error:'A simulated app step is already pending.'}
      const opened=payload.action==='open'
      const result=await new Promise(resolve=>{
        pendingAction=resolve
        show(opened?'Simulated LM Studio launch':'Simulated LM Studio location picker',opened
          ?'The real app asks before launching your existing LM Studio. This preview launches nothing.'
          :'The real app lets you locate your installed LM Studio. This preview does not browse your files.',[
          [opened?'Open simulated LM Studio':'Select simulated LM Studio',()=>resolve({success:true,opened,cancelled:false,summary:opened?'The simulated app is open. Its local server has not been checked.':'A simulated installation was located. It was not opened.'})],
          ['Cancel simulated app action',()=>resolve({success:true,opened:false,cancelled:true,summary:'The action was cancelled. Nothing changed.'})]
        ])
      })
      pendingAction=null
      if(current!==epoch)return {success:true,cancelled:true,opened:false,summary:'Synthetic action cancelled.'}
      if(result.opened)simulator();else step.replaceChildren()
      status.textContent=result.summary
      return result
    },
  }
  api.connectedAgent.send=async payload=>{
    sendAttempts.push({...payload})
    return {success:false,error:'Preview only: no message was sent and no allowance was used.'}
  }
  status.textContent='Ready. Choose LM Studio inside Velorn to begin.'
  window.lmStudioSetupPreview={ready:true,scenario,snapshot:()=>test.snapshot(),actionCalls:()=>actionCalls.slice(),guideCalls:()=>guideCalls.slice(),sendAttempts:()=>sendAttempts.slice()}
})
for(const name of ['ready','stopped','empty'])host.querySelector(`#${name}`).onclick=()=>start(name)
start('ready')
