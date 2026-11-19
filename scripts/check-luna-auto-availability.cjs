// Isolated renderer/native-bridge fixture. No real account, network or inference.
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199'
async function main() {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
  const errors = [], blocked = []
  try {
    const page = await browser.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await page.route('**/*', r => {
      const u = new URL(r.request().url())
      if (u.origin === base && !/^\/(v1|api|prompt|queue|upload)(\/|$)/.test(u.pathname)) return r.continue()
      blocked.push(u.href); return r.abort()
    })
    await page.routeWebSocket(() => true, s => s.close())
    await page.addInitScript(() => {
      window.__connectedAgentFixturePhoneRemembered = true
      window.__connectedAgentFixtureStorage = {
        'velorn.connected-agent.settings.v1': JSON.stringify({ provider: 'luna' }),
        'velorn.agent-entry-intent.v1': '{"acknowledged":true}',
      }
    })
    const open = async () => {
      await page.goto(`${base}/tests/fixtures/connected-agent.html?strict=1&mobile=1&lunaAuto=1`)
      await page.waitForFunction(() => window.connectedAgentTest?.ready)
      await page.waitForFunction(() => /available for this account/.test(window.connectedAgentTest.snapshot().mobile.publication?.modelCatalogStatus || ''))
    }
    const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
    const checks = s => s.calls.filter(c => c.method === 'inspect' && c.options.provider === 'luna')
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    await open()
    let s = await snapshot()
    assert.ok(checks(s).length >= 1 && checks(s).length <= 2, 'StrictMode/startup is bounded')
    assert.equal(s.mobile.publication.models[0].id, 'gpt-6-luna')
    assert.equal(s.requests.length, 0)
    await page.getByRole('textbox', { name: 'Message your agent', exact: true }).fill('Preserve this desktop draft')
    assert.equal(await send.isEnabled(), true)

    // Phone settings refresh invokes the same coalesced read, without a desktop click.
    await page.evaluate(() => window.connectedAgentTest.setHoldInspect(true))
    const before = checks(await snapshot()).length
    await page.evaluate(() => {
      window.connectedAgentTest.phoneChatCommand({ kind: 'models' })
      window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('online'))
    })
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().pendingInspects.length === 1)
    assert.equal(checks(await snapshot()).length, before + 1, 'concurrent refreshes share one read')
    assert.equal(await send.isDisabled(), true)
    await page.evaluate(() => window.connectedAgentTest.releaseInspect())
    await page.waitForFunction(() => !document.querySelector('[aria-label="Send message"]').disabled)
    assert.equal((await snapshot()).requests.length, 0)

    // Old account's late success cannot unlock the new account.
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().pendingInspects.length === 1)
    const old = (await snapshot()).pendingInspects[0].inspectId
    await page.evaluate(() => {
      window.connectedAgentTest.setLunaInspectResult({ success: true, provider: 'luna', available: false, status: 'exhausted', models: [{ id: 'gpt-6-luna' }] })
      window.connectedAgentTest.setPhoneStatus({ enabled: true, paired: true, guided: { enabled: true, registered: true,
        phase: 'account-unavailable', computer: { id: 'new-computer' } } })
    })
    await page.waitForTimeout(100)
    assert.equal((await snapshot()).pendingInspects.length, 1, 'new account waits for the native single-flight read')
    await page.evaluate(id => window.connectedAgentTest.releaseInspect(id), old)
    await page.waitForFunction(id => window.connectedAgentTest.snapshot().pendingInspects.some(p => p.inspectId !== id), old)
    assert.equal(await send.isDisabled(), true)
    await page.evaluate(() => { window.connectedAgentTest.setHoldInspect(false); window.connectedAgentTest.releaseInspect() })
    await page.waitForFunction(() => /used up/.test(window.connectedAgentTest.snapshot().mobile.publication?.modelCatalogStatus || ''))
    assert.equal(await send.isDisabled(), true)
    const settled = checks(await snapshot()).length
    await page.waitForTimeout(1100)
    assert.equal(checks(await snapshot()).length, settled, 'denial does not cause a retry loop')
    assert.equal((await snapshot()).requests.length, 0)

    // Phone pairing alone is independent of this computer's account authority.
    await page.evaluate(() => {
      window.connectedAgentTest.setPhoneStatus({ enabled: true, paired: false, guided: { enabled: true, registered: true,
        phase: 'account-unavailable', computer: { id: 'new-computer' } } })
    })
    await page.waitForTimeout(100)
    assert.equal(checks(await snapshot()).length, settled, 'phone pairing does not refresh or grant funded account access')
    assert.equal(await send.isDisabled(), true)

    // Actual native account recovery changes account-unavailable to ready, not
    // merely the phone's waiting/connected state. Draft/settings stay intact.
    await page.evaluate(() => {
      window.connectedAgentTest.setLunaInspectResult({ success: true, provider: 'luna', available: true, eligible: true, models: [{ id: 'gpt-6-luna' }] })
      window.connectedAgentTest.setPhoneStatus({ enabled: true, paired: true, guided: { enabled: true, registered: true,
        phase: 'ready', computer: { id: 'new-computer' } } })
    })
    await page.waitForFunction(() => !document.querySelector('[aria-label="Send message"]').disabled)
    assert.equal(checks(await snapshot()).length, settled + 1, 'account recovery performs one fresh availability read')
    assert.equal((await snapshot()).requests.length, 0, 'account recovery never sends an inference request')
    assert.equal(await page.getByRole('textbox', { name: 'Message your agent', exact: true }).inputValue(), 'Preserve this desktop draft')
    // An explicit phone send works after automatic discovery, with matching sharing consent.
    await page.evaluate(() => {
      const p = window.connectedAgentTest.snapshot().mobile.publication
      window.connectedAgentTest.phoneChatCommand({ kind: 'message', text: 'Synthetic phone request',
        aiSharingConsent: { provider: 'luna' } }, { version: 1, capabilities: p.aiSharingCapabilities })
    })
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().requests.length === 1)
    s = await snapshot()
    assert.equal(s.requests[0].provider, 'luna')
    assert.equal(s.requests[0].model, 'gpt-6-luna')
    await page.evaluate(id => window.connectedAgentTest.settle(id, { success: true, text: 'Synthetic reply' }), s.requests[0].requestId)
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().pending.length === 0)
    assert.equal((await snapshot()).requests.length, 1, 'no duplicate paid turn')
    await open()
    assert.equal((await snapshot()).requests.length, 0, 'reopen discovers but never sends')
    await page.goto(`${base}/tests/fixtures/connected-agent.html?strict=1&mobile=1&lunaAuto=1&dock=1`)
    await page.waitForFunction(() => /available for this account/.test(window.connectedAgentTest?.snapshot().mobile.publication?.modelCatalogStatus || ''))
    assert.equal(await page.evaluate(() => window.connectedAgentTest.workspace().dockTab), 'inspector')
    assert.equal((await snapshot()).mobile.publication.models[0].id, 'gpt-6-luna', 'hidden Agent panel still publishes the phone catalog')
    assert.equal((await snapshot()).requests.length, 0)
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    console.log('PASS: Luna cold restore, phone catalog/refresh/send, coalescing, stale-account denial, bounded failures and reconnect; zero external requests.')
  } finally { await browser.close() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
