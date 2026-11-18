// Owner-facing, synthetic browser exercise. The iframe imports the actual
// Velorn renderer through the existing RAM-only fixture, never Electron.
import './codex-setup-preview.css'
const host=document.getElementById('preview')
host.innerHTML=`<header><span class="badge">ISOLATED PREVIEW · NOT YOUR INSTALLED APP</span><h1>Try Codex setup</h1><p>Real Velorn screens, simulated installation and sign-in. Your account and chats stay untouched.</p></header><div class="toolbar"><button id="restart">Start from scratch</button><button id="installed">Start with Codex installed</button></div><div class="layout"><aside><section class="note"><h2>Try it as a new user</h2><p>Choose <strong>Codex</strong> in Velorn, then follow its setup buttons.</p><p class="small">No passwords, real downloads, account connections or AI requests. Reloading resets this preview. You can leave your installed Velorn and Codex open.</p></section><section id="step" class="note active" aria-live="polite"></section><p class="small" id="status" role="status">Loading the isolated screens…</p></aside><iframe title="Velorn Codex setup preview" sandbox="allow-scripts allow-same-origin"></iframe></div>`
const frame=host.querySelector('iframe'),step=host.querySelector('#step'),status=host.querySelector('#status')
let epoch=0
const show=(title,description,buttons=[])=>{
  step.replaceChildren()
  const h=document.createElement('h2');h.textContent=title;step.append(h)
  const p=document.createElement('p');p.textContent=description;step.append(p)
  for(const [label,action] of buttons){const b=document.createElement('button');b.textContent=label;b.onclick=action;step.append(b)}
}
function start(state){
  epoch++;window.codexSetupPreview={ready:false};step.replaceChildren();status.textContent='Loading the isolated screens…'
  frame.src=`./codex-setup-preview-frame.html?strict=1&setupStatus=${state}`
}
frame.addEventListener('load',async()=>{
  const current=epoch,w=frame.contentWindow
  for(let i=0;i<300&&!w.connectedAgentTest?.ready;i++)await new Promise(r=>setTimeout(r,20))
  if(current!==epoch)return
  if(!w.connectedAgentTest?.ready){status.textContent='Preview could not load. Try Start from scratch.';return}
  const test=w.connectedAgentTest,api=w.electronAPI
  // Focus the actual assistant panel; none of its controls or copy are replaced.
  const style=w.document.createElement('style')
  style.textContent='#root>div>header,[data-testid="shared-workspace"]{display:none!important}.connected-agent-panel{width:100%!important;max-width:none!important;flex:1!important;border-left:0}.ca-resize{display:none!important}'
  w.document.head.append(style)
  w.open=()=>null
  const guide=api.openExternalUrl,login=api.connectedAgent.codexLogin,chooseExecutable=api.connectedAgent.codexExecutable
  const installerCalls=[]
  let job=null,sequence=0
  api.codexSetupInstaller={
    plan:async options=>{
      if(Object.keys(options||{}).length)throw Error('Preview plan takes no arguments')
      installerCalls.push({method:'plan'})
      return {success:true,supported:true,planId:'synthetic-plan',version:'preview-only',bytes:40000000,
        source:'Official OpenAI download (simulated)',destination:'Isolated preview memory — no files written'}
    },
    install:async options=>{
      if(options?.planId!=='synthetic-plan'||Object.keys(options).length!==1)throw Error('Unexpected preview plan')
      installerCalls.push({method:'install'})
      const approved=await new Promise(resolve=>show('Simulated installer approval',
        'The desktop asks before downloading and installing Codex. This preview only simulates that approval and progress; it writes no files.',[
          ['Approve simulated installation',()=>resolve(true)],['Cancel simulated installation',()=>resolve(false)]
        ]))
      if(current!==epoch||!approved){step.replaceChildren();return {success:false,cancelled:true}}
      job={jobId:`synthetic-job-${++sequence}`,state:'downloading',started:Date.now(),bytesReceived:0,totalBytes:40000000}
      show('Simulated download','Watch the progress inside Velorn. You can cancel there. No software is being downloaded.',[
        ['Simulate download failure',()=>{job.state='failed';job.error='The simulated download was interrupted. Try again.';step.replaceChildren()}]
      ])
      return {success:true,...job}
    },
    status:async options=>{
      if(!job||options?.jobId!==job.jobId||Object.keys(options).length!==1)throw Error('Unexpected preview job')
      if(job.state==='downloading'){
        job.bytesReceived=Math.min(job.totalBytes,Math.floor((Date.now()-job.started)/3500*job.totalBytes))
        if(job.bytesReceived===job.totalBytes){job.state='completed';test.setCodexSetupStatus('login-required');step.replaceChildren();status.textContent='Simulated installation finished. Sign in inside the preview next.'}
      }
      return {success:true,...job}
    },
    cancel:async options=>{
      if(!job||options?.jobId!==job.jobId||Object.keys(options).length!==1)throw Error('Unexpected preview job')
      installerCalls.push({method:'cancel'});job.state='cancelled';step.replaceChildren()
      return {success:true,...job}
    },
  }
  api.openExternalUrl=async url=>{
    const result=await guide(url) // existing fixed-URL stub; never opens a browser
    if(current===epoch)show('Simulated installation guide','In the real app, this opens the Codex CLI installation guide in your browser. Nothing is downloaded here.',[
      ['Simulate installation complete',()=>{test.setCodexSetupStatus('login-required');step.replaceChildren();status.textContent='Simulated Codex is installed. Return to Velorn and choose Check again.'}],
      ['Back without installing',()=>{step.replaceChildren();status.textContent='Nothing installed. You can check again or leave setup.'}]
    ])
    return result
  }
  api.connectedAgent.codexExecutable=async options=>{
    if(options.action!=='choose')return chooseExecutable(options)
    test.setHoldExecutable('choose',true)
    const pending=chooseExecutable(options)
    const select=setupStatus=>{test.setCodexSetupStatus(setupStatus);test.releaseExecutable(null)}
    if(current===epoch)show('Simulated Codex location picker','The real app opens a file picker for your existing Codex installation. This preview only selects a pretend file; your actual files and account stay untouched.',[
      ['Select simulated Codex (signed out)',()=>select('login-required')],
      ['Select simulated Codex (signed in)',()=>select('ready')],
      ['Cancel location selection',()=>test.releaseExecutable(null,{success:true,cancelled:true})]
    ])
    const result=await pending
    test.setHoldExecutable('choose',false)
    if(current===epoch){step.replaceChildren();status.textContent=result.cancelled?'Location selection cancelled. Your existing setup is unchanged.':'Simulated Codex selected. Velorn will check its connection; nothing was installed.'}
    return result
  }
  api.connectedAgent.codexLogin=async options=>{
    if(options.action==='cancel'){if(current===epoch)step.replaceChildren();return login(options)}
    const pending=login(options)
    if(current===epoch)show('Simulated browser sign-in','The real app would open ChatGPT sign-in in your browser. This preview never opens an account page or asks for credentials.',[
      ['Complete simulated sign-in',()=>test.releaseCodexLogin(null,{success:true})],
      ['Back to Velorn',()=>step.replaceChildren()]
    ])
    const result=await pending
    if(current===epoch){step.replaceChildren();status.textContent=result.cancelled?'Simulated sign-in cancelled. Your real account was not touched.':'Preview connected. The model names are test data; no real account or model is connected.'}
    return result
  }
  api.connectedAgent.send=async()=>({success:false,error:'Preview only: no message was sent and no allowance was used.'})
  status.textContent='Ready. Choose Codex inside Velorn to begin.'
  window.codexSetupPreview={ready:true,snapshot:()=>test.snapshot(),installerCalls:()=>installerCalls.slice()}
})
host.querySelector('#restart').onclick=()=>start('missing')
host.querySelector('#installed').onclick=()=>start('login-required')
start('missing')
