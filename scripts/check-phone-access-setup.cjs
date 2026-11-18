'use strict'
// Actual desktop dock and agent renderer with RAM-only native preferences and
// receipts. No real pairing listener, provider request, project IO or generation.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = process.env.VELORN_TEST_URL || 'http://127.0.0.1:5209'
if (new URL(base).hostname !== '127.0.0.1') throw Error('Loopback fixture only')
;(async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-phone-setup-'))
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
  const pages = [], errors = [], blocked = []
  try {
    const makePage = async ({ phone = false, full = false } = {}) => {
      const page = await browser.newPage({ viewport: { width: 1200, height: 950 } }); pages.push(page)
      page.on('pageerror', error => errors.push(error.message))
      await page.route('**/*', route => {
        const url = new URL(route.request().url())
        if (url.origin === base && !/^\/(v1|api|prompt|queue|upload)(\/|$)/.test(url.pathname)) return route.continue()
        blocked.push(url.href); return route.abort()
      })
      await page.routeWebSocket(() => true, socket => socket.close())
      await page.addInitScript(({ phone, full }) => {
        window.__connectedAgentFixturePhoneRemembered = phone
        window.__connectedAgentFixtureFullAccessRemembered = full
      }, { phone, full })
      await page.goto(`${base}/tests/fixtures/connected-agent.html?dock=1&mobile=1`)
      await page.waitForFunction(() => window.connectedAgentTest?.ready
        && window.connectedAgentTest.snapshot().calls.some(call => call.method === 'mobile.getPreference'))
      return page
    }
    const snapshot = page => page.evaluate(() => window.connectedAgentTest.snapshot())
    const count = (value, method) => value.calls.filter(call => call.method === method).length
    const lazy = await makePage()
    assert.equal((await snapshot(lazy)).listenerCount, 0)
    assert.equal((await snapshot(lazy)).listenerSubscriptions, 0)
    assert.equal(count(await snapshot(lazy), 'mobile.attach'), 0)
    assert.equal(await lazy.getByRole('complementary', { name: 'Velorn Assistant', includeHidden: true }).count(), 0)
    assert.equal(await lazy.getByTestId('fixture-inspector').isVisible(), true)

    const page = await makePage({ phone: true, full: true })
    await page.waitForFunction(() => {
      const value = window.connectedAgentTest.snapshot()
      return value.mobile.publicationCount > 0 && value.mobile.publication?.fullAccess === true
        && value.mobile.publication?.preview?.dataUrl?.startsWith('data:image/jpeg;base64,')
    })
    const before = await snapshot(page), baseline = before.authored
    assert.equal(before.listenerCount, 1); assert.equal(before.listenerSubscriptions, 1); assert.equal(before.maxListenerCount, 1)
    assert.equal(before.mobile.listenerCount, 1); assert.equal(before.mobile.maxListenerCount, 1)
    assert.equal(before.mobile.status.enabled, true); assert.equal(before.mobile.status.paired, true)
    assert.equal(count(before, 'mobile.enable'), 0)
    assert.equal(before.requests.length, 0)
    assert.equal(before.mobile.publication.preview.workspace, 'editor', 'The visible workspace preview works while the Agent dock is hidden')
    assert.equal(await page.getByRole('complementary', { name: 'Velorn Assistant', includeHidden: true }).count(), 1)
    assert.equal(await page.getByRole('complementary', { name: 'Velorn Assistant', includeHidden: true }).isVisible(), false)
    assert.equal(await page.getByTestId('fixture-inspector').isVisible(), true)
    assert.equal((await page.evaluate(() => window.connectedAgentTest.workspace())).dockTab, 'inspector')
    assert.equal(before.mobile.publication.fullAccessBundleVersion, 0, 'An old full grant with Local only is not the complete bundle')

    // Existing Full access must not early-return when the new phone bundle also
    // needs remembered spending/media setup. The native mock consumes one receipt.
    const oldGrant = before.fullAccessGrant.token, fullCalls = count(before, 'setFullAccess')
    await page.evaluate(() => window.connectedAgentTest.phoneAccess('full', { bundleVersion: 1 }))
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().mobile.publication?.fullAccessBundleVersion === 1)
    const bundled = await snapshot(page)
    assert.equal(count(bundled, 'fixture.phoneBundleConsent'), 1)
    assert.equal(count(bundled, 'setFullAccess'), fullCalls + 1)
    assert.equal(bundled.calls.filter(call => call.method === 'setFullAccess').at(-1).fromPhone, true)
    assert.notEqual(bundled.fullAccessGrant.token, oldGrant)
    assert.equal(bundled.fullAccessRemembered, true); assert.equal(bundled.spendingPolicy, 'ask-cloud')
    assert.equal(bundled.mobile.publication.toolsEnabled, true); assert.equal(bundled.mobile.publication.researchEnabled, true)
    assert.equal(bundled.mobile.publication.shareReviewMedia, true)
    assert.deepEqual(bundled.mobile.replies.slice(-2).map(reply => reply.result.status), ['accepted', 'completed'])
    assert.equal(bundled.mobile.nativeApprovals.length, 0)
    assert.equal(count(bundled, 'spending.setPolicy'), 0, 'No second renderer spending confirmation')

    const restoreCalls = bundled.calls.filter(call => call.method === 'setFullAccess' && call.restoreOnly).length
    await page.evaluate(() => window.connectedAgentTest.emitPhoneAccessRevoked('shared-context-changed'))
    await page.waitForFunction(previous => {
      const value = window.connectedAgentTest.snapshot()
      return value.calls.filter(call => call.method === 'setFullAccess' && call.restoreOnly).length > previous && value.mobile.publication?.fullAccessBundleVersion === 1
    }, restoreCalls)
    assert.equal(count(await snapshot(page), 'fixture.phoneBundleConsent'), 1, 'Context refresh restores remembered consent, not the old button receipt')

    const beforeReconnect = await snapshot(page)
    await page.evaluate(() => window.connectedAgentTest.interruptPhone())
    await page.waitForFunction(previous => {
      const value = window.connectedAgentTest.snapshot()
      return value.mobile.status?.enabled && value.mobile.publicationCount > previous
    }, beforeReconnect.mobile.publicationCount, { timeout: 15000 })
    const reconnected = await snapshot(page)
    assert.equal(count(reconnected, 'mobile.enable'), 0)
    assert.equal(reconnected.requests.length, 0)
    assert.equal(reconnected.listenerSubscriptions, 1)
    assert.equal(reconnected.mobile.maxListenerCount, 1)
    await page.screenshot({ path: path.join(output, 'hidden-agent-phone-reconnected.png') })

    await page.getByRole('button', { name: 'Assistant', exact: true }).click()
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await page.waitForFunction(() => !window.connectedAgentTest.snapshot().mobile.nativePhoneRemembered && !window.connectedAgentTest.snapshot().mobile.status.enabled)
    const restoreCallsBeforeStop = (await snapshot(page)).calls.filter(call => call.method === 'setFullAccess' && call.restoreOnly).length
    await page.evaluate(() => window.connectedAgentTest.emitPhoneAccessRevoked('desktop-disabled'))
    await page.waitForFunction(() => !window.connectedAgentTest.snapshot().fullAccessGrant)
    const stopped = await snapshot(page), attachCalls = count(stopped, 'mobile.attach'), reads = count(stopped, 'mobile.getPreference')
    await page.getByRole('button', { name: 'Inspector', exact: true }).click()
    // Wait for the real retry tick, which reads the now-disabled native opt-in.
    await page.waitForFunction(previous => window.connectedAgentTest.snapshot().calls.filter(call => call.method === 'mobile.getPreference').length > previous, reads, { timeout: 15000 })
    const final = await snapshot(page)
    assert.equal(final.mobile.status.enabled, false); assert.equal(count(final, 'mobile.attach'), attachCalls)
    assert.equal(final.calls.filter(call => call.method === 'setFullAccess' && call.restoreOnly).length, restoreCallsBeforeStop, 'Stop revocation must not restore an agent grant')
    assert.equal(final.fullAccessGrant, null)
    assert.equal(count(final, 'mobile.enable'), 0)
    assert.equal(final.requests.length, 0); assert.deepEqual(final.authored, baseline)
    for (const candidate of pages) assert.deepEqual((await snapshot(candidate)).forbiddenCalls, [])
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    console.log(JSON.stringify({ success: true, output, checks: ['unpaired dock stays lazy', 'native remembered phone mounts exactly one hidden agent', 'automatic publication without enable/model turn', 'existing grant upgraded by versioned phone bundle', 'shared-context remembered grant restoration', 'automatic listener reattach without action replay', 'explicit Stop remains off', 'project unchanged'] }))
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
