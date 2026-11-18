// Synthetic provider/native replies, RAM-only project/storage, no model calls or edits.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Receipt fixture requires loopback HTTP')
const output = fs.mkdtempSync(path.join(os.tmpdir(),'velorn-agent-receipts-'))
const entry = (n, toolName, outcome) => ({id:`agent-receipt-00000000-0000-0000-0000-${String(n).padStart(12,'0')}`,toolName,outcome})
const toolReceipts = {version:1,entries:[entry(1,'create_project_checkpoint','applied'),entry(2,'edit_trim','preview'),
  entry(3,'edit_trim','applied'),entry(4,'get_timeline','read'),entry(5,'edit_move','unconfirmed'),entry(6,'edit_delete','denied')],omitted:0}
async function main() {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/usr/bin/google-chrome',headless:true})
  const context = await browser.newContext({viewport:{width:1360,height:1000},serviceWorkers:'block'})
  const page = await context.newPage(), errors = [], blocked = []
  page.on('pageerror',error=>errors.push(error.message)); page.setDefaultTimeout(12000)
  await page.route('**/*',route=>{
    const url = new URL(route.request().url())
    if (url.origin === base.origin && !/^\/(?:prompt|queue|interrupt|system_stats|history|upload|view|ws|v1|api)(?:\/|$)/.test(url.pathname)) return route.continue()
    blocked.push(url.href); return route.abort()
  })
  await page.routeWebSocket(()=>true,socket=>socket.close())
  const button = name=>page.getByRole('button',{name,exact:true})
  const snapshot = ()=>page.evaluate(()=>window.connectedAgentTest.snapshot())
  const replies = ()=>page.locator('.ca-message.ca-assistant:not([aria-busy="true"])')
  const settle = async (request,result)=>{
    await page.evaluate(({requestId,result})=>window.connectedAgentTest.settle(requestId,result),{requestId:request.requestId,result})
    await button('Stop response').waitFor({state:'hidden'})
  }
  const send = async text=>{
    const count = (await snapshot()).requests.length
    await page.getByRole('textbox',{name:'Message your agent',exact:true}).fill(text)
    await button('Send message').click()
    await page.waitForFunction(count=>window.connectedAgentTest.snapshot().requests.length>count,count)
    return (await snapshot()).requests.at(-1)
  }
  try {
    await page.goto(new URL('/tests/fixtures/connected-agent.html?dock=1&timeline=1',base).href)
    await page.waitForFunction(()=>window.connectedAgentTest?.ready)
    const baseline = (await snapshot()).authored
    await button('Assistant').click()
    const handle = await page.locator('.fixture-dock-resize').boundingBox()
    await page.mouse.move(handle.x + handle.width / 2,handle.y + handle.height / 2)
    await page.mouse.down(); await page.mouse.move(handle.x-320,handle.y+handle.height/2,{steps:6}); await page.mouse.up()
    await button('Assistant settings').click()
    await page.getByLabel('Assistant selection',{exact:true}).selectOption('lmstudio'); if (await page.getByRole('group', { name: 'Confirm assistant switch' }).count()) await page.getByRole('group', { name: 'Confirm assistant switch' }).getByRole('button', { name: /^Start .* chat$/ }).click()
    if (await button('Assistant settings').getAttribute('aria-expanded') !== 'true') await button('Assistant settings').click()
    await button('Check connection').click()
    await page.waitForFunction(()=>window.connectedAgentTest.snapshot().calls.some(call=>call.method==='inspect'&&call.options.provider==='lmstudio'))
    await button('Work in Velorn').click(); await button('Back to chat').click()
    const first = await send('Synthetic receipt check; do not execute an edit.')
    await settle(first,{success:false,code:'EMPTY_RESPONSE',error:'No public reply',deliveryStatus:'reply-unavailable',toolReceipts,
      localDiagnostics:[{prediction:3,finishReason:'stop',publicContentChars:0,parsedToolCalls:0,promptTokens:300,completionTokens:0,answerRecovery:true,reasoning:'PRIVATE_THOUGHT'}]})
    let status = replies().last()
    assert.match(await status.innerText(),/Velorn status/)
    assert.match(await status.innerText(),/Final reply unavailable · not an agent reply/)
    assert.match(await status.innerText(),/recorded 2 applied actions/)
    assert.equal(await status.locator('.ca-tool-receipts').getAttribute('open'),null)
    await status.locator('.ca-tool-receipts > summary').click()
    assert.equal(await status.locator('[data-receipt-outcome]').count(),6)
    assert.equal(await status.locator('[data-receipt-outcome="applied"]').count(),2)
    assert.equal(await status.locator('[data-receipt-outcome="preview"]').count(),1)
    assert.equal(await status.locator('[data-receipt-outcome="unconfirmed"]').count(),1)
    await status.locator('.ca-local-diagnostics > summary').click()
    assert.match(await status.innerText(),/Answer-only recovery: 0 public characters/)
    assert.doesNotMatch(await status.innerText(),/PRIVATE_THOUGHT/)
    assert.equal((await snapshot()).requests.length,1)
    await status.locator('.ca-local-diagnostics > summary').click()
    await page.getByRole('log',{name:'Agent conversation',exact:true}).evaluate(node=>{node.scrollTop=0})
    await page.screenshot({path:path.join(output,'missing-reply-desktop.png'),fullPage:true,animations:'disabled'})
    console.log('PASS: missing reply shows scoped outcomes and metadata without retry or synthetic agent success')

    const saved = (await snapshot()).storage
    await page.addInitScript(saved=>{window.__connectedAgentFixtureStorage=saved},saved)
    await page.reload(); await page.waitForFunction(()=>window.connectedAgentTest?.ready)
    await button('Assistant').click()
    await page.getByRole('textbox',{name:'Message your agent',exact:true}).waitFor()
    status = replies().last()
    assert.match(await status.innerText(),/Final reply unavailable/)
    assert.equal(await status.locator('[data-receipt-outcome]').count(),6)
    assert.equal((await snapshot()).requests.length,0)
    const second = await send('Inspect only after the missing reply.')
    assert.ok(!second.messages.some(message=>/Velorn recorded|Recorded tool results|PRIVATE_THOUGHT/.test(message.content)))
    await settle(second,{success:true,text:'Synthetic inspection response.',toolReceipts:{version:1,entries:[entry(7,'get_timeline','read')],omitted:0}})
    assert.equal(await replies().last().locator('.ca-tool-receipts').getAttribute('open'),null)
    assert.match(await replies().last().innerText(),/Velorn Assistant/)
    console.log('PASS: saved receipt status survives a fresh renderer and never becomes provider-authored history')

    await button('Assistant settings').click(); await page.getByLabel('Assistant selection',{exact:true}).selectOption('codex'); if (await page.getByRole('group', { name: 'Confirm assistant switch' }).count()) await page.getByRole('group', { name: 'Confirm assistant switch' }).getByRole('button', { name: /^Start .* chat$/ }).click()
    if (await button('Back to chat').isVisible()) await button('Back to chat').click()
    const third = await send('Synthetic Codex missing reply check.')
    await settle(third,{success:false,code:'EMPTY_RESPONSE',error:'No reply',toolReceipts:{version:1,entries:[entry(8,'edit_trim','preview')],omitted:0}})
    assert.match(await replies().last().innerText(),/Final reply unavailable/)
    assert.doesNotMatch(await replies().last().innerText(),/recorded \d+ applied/)
    assert.equal(await replies().last().locator('[data-receipt-outcome="preview"]').count(),1)
    assert.deepEqual((await snapshot()).authored,baseline)
    assert.deepEqual((await snapshot()).forbiddenCalls,[])
    assert.deepEqual(errors,[]); assert.deepEqual(blocked,[])
    console.log('PASS: the same UI path handles either provider without altering the fixture project')
    console.log(`Screenshots: ${output}`)
  } catch (error) {
    console.error((await page.locator('body').innerText()).slice(-2500))
    throw error
  } finally { await browser.close() }
}
main().catch(error=>{console.error(error);process.exitCode=1})
