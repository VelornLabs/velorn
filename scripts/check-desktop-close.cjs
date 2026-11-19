'use strict'
const { _electron } = require('/test-tools/node_modules/playwright')
const fs = require('node:fs'), assert = require('node:assert/strict')
const env = Object.fromEntries(['PATH', 'LANG', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DBUS_SYSTEM_BUS_ADDRESS', 'LIBGL_ALWAYS_SOFTWARE', 'GSETTINGS_BACKEND', 'NO_AT_BRIDGE'].map(k => [k, process.env[k]]).filter(([,v])=>v!==undefined))
let app; const results = []
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms))
async function state() { return app.evaluate(()=>globalThis.closeTest.state()) }
async function until(fn, message) { for(let i=0;i<100;i++){const s=await state();if(fn(s))return s;await sleep(20)}throw Error(message+JSON.stringify(await state())) }
async function create(options = {}, veto = false) {
  await app.evaluate((_, options)=>globalThis.closeTest.create(options), options)
  const page = app.windows().at(-1)
  page.on('dialog', () => {}) // Observe without Playwright auto-dismiss racing native veto.
  await page.locator('#project').fill('synthetic unsaved timeline change')
  if (veto) {
    await page.frameLocator('#comfy').locator('#activate').click()
    await page.evaluate(()=>{document.querySelector('#comfy').style.display='none'})
  } else await page.evaluate(()=>document.querySelector('#comfy').remove())
  return page
}
async function close() { await app.evaluate(()=>globalThis.closeTest.close()) }
async function finish(name) {
  const s = await until(s=>s.records.includes('quit'), 'Did not quit: ')
  assert.ok(s.destroyed); assert.ok(s.records.indexOf('saved') < s.records.indexOf('closed'))
  assert.ok(fs.readFileSync(`/state/saved-project-${s.id}.txt`,'utf8').includes('synthetic'))
  results.push({ name, ...s })
}
(async()=>{
  app = await _electron.launch({ executablePath: '/candidate/electron-fixture/electron', env,
    args: ['--no-sandbox','--disable-gpu','--ozone-platform=wayland','/candidate/source/tests/desktopCloseNativeFixture.cjs'],timeout:45000 })
  for(let i=0;i<150;i++){if(await app.evaluate(()=>globalThis.closeTest?.ready))break;await sleep(50)}
  let page = await create({ saveDelay: 100 }); await page.locator('#close').click(); await close(); await close(); await finish('Repeated X, delayed save')
  assert.equal(results.at(-1).records.filter(x=>x==='save-start').length,1)
  for(const launcherChoice of [0,1]) {
    page = await create({ owned:true,stopOnQuit:true,launcherChoice },true); await close()
    let s = await until(s=>s.records.includes('veto:0'),'No native veto prompt')
    assert.equal(s.destroyed,false);assert.equal(s.cleanupCount,0)
    await page.locator('#project').fill('synthetic edited after cancelling')
    await app.evaluate(()=>globalThis.closeTest.configure({allowUnsaved:true}));await close();await finish(`Hidden ComfyUI Cancel/retry then ${launcherChoice===0?'Stop':'Leave'}`)
    s=results.at(-1);assert.equal(s.cleanupCount,1);assert.ok(s.records.indexOf(launcherChoice===0?'stop':'detach')>s.records.indexOf('closed'))
  }
  await create({owned:true},true);await app.evaluate(()=>globalThis.closeTest.quit());await until(s=>s.records.includes('veto:0'),'Quit veto')
  assert.equal((await state()).cleanupCount,0);await app.evaluate(()=>globalThis.closeTest.configure({allowUnsaved:true}));await app.evaluate(()=>globalThis.closeTest.quit());await finish('Menu Quit Cancel/retry preserves launcher')
  for(const failure of ['saveFail','hangSave']) {
    await create({owned:true,[failure]:true});await close();let s=await until(s=>s.records.includes('dialog:Velorn is still open'),'Missing save warning')
    assert.equal(s.destroyed,false);assert.equal(s.cleanupCount,0);await app.evaluate((_,failure)=>globalThis.closeTest.configure({[failure]:false}),failure)
    await close();await finish(`${failure}: visible failure and successful retry`)
  }
  await create({owned:true,stopOnQuit:true,launcherChoice:2});await close();await until(s=>s.records.includes('dialog:Quit Velorn?'),'Launcher prompt')
  assert.equal((await state()).records.includes('save-start'),false)
  await app.evaluate(()=>globalThis.closeTest.configure({launcherChoice:1}));await close();await finish('Launcher Cancel then Leave')
  await create({owned:true,cleanupDelay:150});await close();await until(s=>s.destroyed,'No close');await app.evaluate(()=>globalThis.closeTest.quit());await finish('Cleanup drains exactly once before quitting')
  fs.writeFileSync('/state/close-native-results.json',JSON.stringify({passed:true,results},null,2));console.log(JSON.stringify({passed:true,groups:results.length}))
})().catch(error=>{console.error(error.stack);process.exitCode=1}).finally(async()=>{ if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{})} })
