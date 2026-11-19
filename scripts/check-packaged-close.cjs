'use strict'
const fs = require('node:fs'), http = require('node:http'), assert = require('node:assert/strict')
const { _electron } = require('/test-tools/node_modules/playwright')
const env = Object.fromEntries(['PATH','LANG','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','DBUS_SYSTEM_BUS_ADDRESS','LIBGL_ALWAYS_SOFTWARE','GSETTINGS_BACKEND','NO_AT_BRIDGE'].map(k=>[k,process.env[k]]).filter(([,v])=>v!==undefined))
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms))
const server = http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<button id="edit">Edit a workflow</button><script>addEventListener('beforeunload',e=>{e.preventDefault();return true})</script>`)})
let app;const results=[];
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  for(const mode of ['window-X','app-Quit']) {
    app=await _electron.launch({executablePath:'/candidate/source/release/linux-unpacked/velorn',env:{...env,XDG_CONFIG_HOME:`/state/${mode}`},args:['--no-sandbox','--disable-gpu','--ozone-platform=wayland','--disable-background-networking'],timeout:45000})
    let exited=false;app.process().once('exit',()=>{exited=true})
    let page;for(let i=0;i<150;i++){page=app.windows().find(p=>/\/dist\/index.html/.test(p.url()));if(page)break;await sleep(100)}
    assert.ok(page);page.on('dialog',()=>{})
    await page.getByRole('button',{name:'Choose Projects Folder',exact:true}).waitFor()
    await app.evaluate(({dialog})=>{
      globalThis.closeProbe={approve:false,prompts:[]}
      dialog.showMessageBoxSync=(_win,options)=>{globalThis.closeProbe.prompts.push(options);return globalThis.closeProbe.approve?1:0}
      dialog.showMessageBox=async(...args)=>{globalThis.closeProbe.prompts.push(args.at(-1));return{response:0}}
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:['/workspace']})
    })
    await page.getByRole('button',{name:'Choose Projects Folder',exact:true}).click()
    await page.getByRole('button',{name:'New Project',exact:true}).first().click()
    await page.getByPlaceholder('Enter project name...').fill(`Close Test ${mode}`)
    await page.getByRole('button',{name:'Create Project',exact:true}).click()
    await page.getByRole('button',{name:'Assistant',exact:true}).waitFor()
    await page.evaluate(url=>{
      for(const old of document.querySelectorAll('iframe'))old.remove()
      const frame=document.createElement('iframe');frame.id='close-frame';frame.src=url
      frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads')
      frame.style='position:fixed;inset:80px;width:600px;height:200px;z-index:999999;background:white';document.body.append(frame)
    },`http://127.0.0.1:${server.address().port}/`)
    await page.frameLocator('#close-frame').locator('#edit').click()
    await page.evaluate(()=>{document.querySelector('#close-frame').style.display='none'})
    async function requestClose(){
      if(mode==='window-X') await page.evaluate(()=>window.electronAPI.closeWindow()).catch(()=>{})
      else await app.evaluate(({app})=>app.quit()).catch(()=>{})
    }
    await requestClose()
    let probe;for(let i=0;i<100;i++){probe=await app.evaluate(()=>globalThis.closeProbe);if(probe.prompts.length)break;await sleep(100)}
    assert.equal(probe.prompts[0]?.title,'Unsaved page changes');assert.equal(probe.prompts[0].defaultId,0)
    assert.equal(exited,false);assert.equal(page.isClosed(),false)
    // Cancel must not dispose account/agent/setup handlers. This synthetic
    // status call has no account or provider connection and sends no prompt.
    const status=await page.evaluate(()=>window.electronAPI.connectedAgent.inspect({provider:'luna'}))
    assert.ok(status && typeof status==='object')
    await page.screenshot({path:`/state/${mode}-after-cancel.png`})
    await app.evaluate(()=>{globalThis.closeProbe.approve=true})
    await requestClose();for(let i=0;i<200&&!exited;i++)await sleep(100)
    assert.equal(exited,true,'Close must actually exit, without force-kill')
    const project=`/workspace/Close Test ${mode}/project.comfystudio`
    assert.equal(JSON.parse(fs.readFileSync(project,'utf8')).name,`Close Test ${mode}`)
    results.push({mode,cancelKeptConnections:true,hiddenIframeHandled:true,projectSaved:true,cleanExit:true})
    await app.close().catch(()=>{});app=null
  }
  fs.writeFileSync('/state/packaged-close-results.json',JSON.stringify({passed:true,results},null,2))
  console.log(JSON.stringify({passed:true,results}))
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(async()=>{
  if(app){await app.evaluate(({app})=>app.exit(1)).catch(()=>{});await app.close().catch(()=>{})}
  server.close()
})
