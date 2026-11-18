// Actual chat renderer + synthetic native proof. No service probes, accounts,
// providers, project IO or persisted browser-profile settings.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const target = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5222')
if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password
  || target.pathname !== '/' || target.search || target.hash) throw Error('Local connection display fixture requires loopback HTTP')
const base = target.origin, output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-local-comfy-display-'))
async function main() {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
  const groups = [], errors = [], blocked = []
  let page
  try {
    page = await browser.newPage({ viewport: { width: 1050, height: 920 } })
    page.setDefaultTimeout(7000)
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin === base && !/^\/(v1|api|prompt|queue|upload)(\/|$)/.test(url.pathname)) return route.continue()
      blocked.push(url.href); return route.abort()
    })
    await page.routeWebSocket(() => true, socket => socket.close())
    const button = name => page.getByRole('button', { name, exact: true })
    const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
    const setup = (method, ...args) => page.evaluate(({ method, args }) => window.connectedAgentTest.localComfyDisplay[method](...args), { method, args })
    const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const reply = () => page.locator('.ca-assistant .ca-message-content').last()
    const checks = async () => (await snapshot()).calls.filter(call => call.method === 'optionalSetup.inspect')
    const send = async () => {
      const count = (await snapshot()).requests.length
      await page.getByRole('textbox', { name: 'Message your agent', exact: true }).fill('Please report the connection.')
      await button('Send message').click()
      await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, count)
      return (await snapshot()).requests.at(-1)
    }
    const settle = (request, text, extras = {}) => page.evaluate(({ id, text, extras }) =>
      window.connectedAgentTest.settle(id, { success: true, text, ...extras }), { id: request.requestId, text, extras })
    const finish = async (text, extras) => {
      const request = await send(); await settle(request, text, extras)
      await button('Stop response').waitFor({ state: 'hidden' }); await frame(); return request
    }
    const ready = { success: true, integration: 'comfyui', state: 'ready', configuredPort: 8000,
      connections: [{ port: 8000, httpBase: 'http://127.0.0.1:8000' }] }
    await page.goto(`${base}/tests/fixtures/connected-agent.html?strict=1&localComfyDisplay=1`)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    const baseline = (await snapshot()).authored
    assert.equal((await checks()).length, 0)
    await finish('Documentation: **https://docs.comfy.org/**. Nothing was installed.')
    assert.equal((await checks()).length, 0)
    assert.equal(await reply().locator('a[href="https://docs.comfy.org/"]').count(), 1)
    groups.push('mount and ordinary public reply never probe setup; public HTTPS link remains')

    await finish('Connected at **http://127.0.0.1:8000**. It returned 976 nodes. Documentation: https://docs.comfy.org/.')
    assert.equal((await checks()).length, 1)
    assert.equal(await reply().locator('strong').innerText(), 'local ComfyUI (127.0.0.1:8000)')
    assert.match(await reply().innerText(), /It returned 976 nodes\./)
    assert.equal(await reply().locator('a[href^="http:"]').count(), 0)
    assert.doesNotMatch(await reply().innerText(), /link omitted|http:\/\/127/)
    assert.equal(await reply().locator('a[href="https://docs.comfy.org/"]').count(), 1)
    groups.push('native verified configured root renders inert plain address with intact bold/sentence/public citation')

    const savedStorage = (await snapshot()).storage
    assert.doesNotMatch(JSON.stringify(savedStorage), /http:\/\/127|configuredPort|verifiedComfySetup/)
    await page.addInitScript(value => { window.__connectedAgentFixtureStorage = value }, savedStorage)
    await page.reload(); await page.waitForFunction(() => window.connectedAgentTest?.ready)
    await page.getByText('local ComfyUI (127.0.0.1:8000)', { exact: true }).waitFor()
    assert.equal((await checks()).length, 0)
    assert.equal((await snapshot()).requests.length, 0)
    assert.equal(await page.locator('.ca-assistant a[href^="http:"]').count(), 0)
    groups.push('true renderer/history reload retains inert display without probes, authority metadata or inference')

    await setup('status', { ...ready, state: 'unavailable' })
    await finish('Connected at **http://127.0.0.1:8000**. Next sentence.', { verifiedComfySetup: ready, allowLocalUrls: true })
    assert.equal(await reply().locator('strong').innerText(), '[link omitted]')
    assert.match(await reply().innerText(), /Next sentence\./)
    assert.doesNotMatch(await reply().innerText(), /127\.0\.0\.1|local ComfyUI/)
    await setup('status', ready)
    const beforeSensitive = (await checks()).length
    await finish('Private http://127.0.0.1:8000/prompt and http://127.0.0.1:8000?token=PRIVATE_QUERY and https://connect.velorn.ai/phone?token=PRIVATE_PHONE. /private/local-file password=PRIVATE_PASSWORD')
    assert.equal((await checks()).length, beforeSensitive)
    assert.doesNotMatch(await reply().innerText(), /PRIVATE_|\/private|\/prompt|127\.0\.0\.1/)
    groups.push('unverified native state and model proof flags cannot promote private links; sensitive forms never probe')

    await setup('hold', true)
    const stopped = await send(); await settle(stopped, 'STALE_STOP_PROOF http://127.0.0.1:8000')
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().localComfyDisplay.pending.length > 0)
    await button('Stop response').click()
    await setup('release'); await frame()
    assert.equal(await page.getByText('STALE_STOP_PROOF', { exact: false }).count(), 0)
    groups.push('Stop while native proof is pending ignores its late completion')

    const timeoutRequest = await send(); await settle(timeoutRequest, 'Bounded proof **http://127.0.0.1:8000**. Reply still arrives.')
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().localComfyDisplay.pending.length > 0)
    await button('Stop response').waitFor({ state: 'hidden', timeout: 6000 }); await frame()
    assert.match(await reply().innerText(), /Bounded proof \[link omitted\]\. Reply still arrives\./)
    await setup('release'); await frame()
    assert.match(await reply().innerText(), /\[link omitted\]/)
    groups.push('hung native proof times out fail-closed without blocking the final response or applying a late proof')

    const closed = await send(); await settle(closed, 'STALE_CLOSED_PROOF http://127.0.0.1:8000')
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().localComfyDisplay.pending.length > 0)
    await button('Close assistant panel').click()
    await setup('release'); await button('Open agent').click(); await frame()
    assert.equal(await page.getByText('STALE_CLOSED_PROOF', { exact: false }).count(), 0)
    groups.push('panel unmount drops pending proof without adding a late reply after remount')

    const projectRequest = await send(); await settle(projectRequest, 'STALE_PROJECT_PROOF http://127.0.0.1:8000')
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().localComfyDisplay.pending.length > 0)
    await page.evaluate(() => window.connectedAgentTest.switchProject('beta'))
    await setup('release'); await frame()
    assert.equal(await page.getByText('STALE_PROJECT_PROOF', { exact: false }).count(), 0)
    await page.evaluate(() => window.connectedAgentTest.switchProject('alpha'))
    await setup('hold', false); await frame()
    assert.equal(await page.getByText('STALE_PROJECT_PROOF', { exact: false }).count(), 0)
    groups.push('project navigation discards pending native proof and never moves the reply into another conversation')

    await finish('[ComfyUI](http://127.0.0.1:8000) is available. **https://docs.comfy.org/** remains a public reference.')
    assert.match(await reply().innerText(), /ComfyUI — local ComfyUI \(127\.0\.0\.1:8000\)/)
    assert.equal(await reply().locator('a').count(), 1)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addStyleTag({ content: '[data-testid="shared-workspace"]{display:none!important}.connected-agent-panel{width:100%!important;max-width:none!important}' })
    await reply().scrollIntoViewIfNeeded(); await frame()
    assert.equal(await reply().evaluate(node => node.scrollWidth <= node.clientWidth + 1), true)
    await page.screenshot({ path: path.join(output, 'inert-local-connection-narrow.png') })
    assert.deepEqual((await snapshot()).authored, baseline)
    assert.deepEqual((await snapshot()).forbiddenCalls, [])
    assert.equal((await snapshot()).calls.filter(call => call.method === 'openExternalUrl').length, 0)
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    groups.push('Markdown destination becomes noninteractive text; narrow rendering and authored state stay intact')
    console.log(JSON.stringify({ success: true, groups, output }, null, 2))
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
    console.error({ output, groups, errors, blocked }); throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
