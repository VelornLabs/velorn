'use strict'
// Synthetic desktop renderer only: no real account, command, provider or project.
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const { MESSAGES } = require('../electron/connectedAgentLuna.cjs')
const base = process.env.VELORN_TEST_URL || 'http://127.0.0.1:5267'
assert.equal(new URL(base).origin, base)
assert.equal(new URL(base).hostname, '127.0.0.1')
async function main() {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
  const checks = [], errors = [], blocked = []
  try {
    for (const code of ['LUNA_REQUEST_LIMIT', 'LUNA_REQUEST_REJECTED', 'LUNA_SERVICE_UNAVAILABLE',
      'LUNA_RESPONSE_UNCERTAIN', 'LUNA_INVALID_RESPONSE', 'LUNA_UNAVAILABLE',
      'LUNA_AUTH_REQUIRED', 'LUNA_EXHAUSTED', 'LUNA_NOT_ELIGIBLE']) {
      const context = await browser.newContext({ serviceWorkers: 'block' })
      const page = await context.newPage()
      page.setDefaultTimeout(10000)
      page.on('pageerror', e => errors.push(e.message))
      await page.route('**/*', route => new URL(route.request().url()).origin === base
        ? route.continue() : (blocked.push(route.request().url()), route.abort()))
      await page.routeWebSocket(() => true, socket => socket.close())
      await page.addInitScript(() => {
        window.__connectedAgentFixtureStorage = {
          'velorn.connected-agent.settings.v1': JSON.stringify({ provider: 'luna' }),
          'velorn.agent-entry-intent.v1': '{"acknowledged":true}',
        }
      })
      await page.goto(base + '/tests/fixtures/connected-agent.html?strict=1&lunaAuto=1')
      await page.waitForFunction(() => window.connectedAgentTest?.ready)
      const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
      const input = page.getByRole('textbox', { name: 'Message your agent', exact: true })
      const send = page.getByRole('button', { name: 'Send message', exact: true })
      await input.fill('Synthetic maintenance task only')
      await page.waitForFunction(() => !document.querySelector('[aria-label="Send message"]').disabled)
      const baseline = (await snapshot()).authored
      await send.click()
      const allow = page.getByRole('button', { name: 'Allow and send', exact: true })
      if (await allow.count()) await allow.click()
      await page.waitForFunction(() => window.connectedAgentTest.snapshot().requests.length === 1)
      const requestId = (await snapshot()).requests[0].requestId
      await input.fill('Preserve my newer draft')
      await page.evaluate(({ requestId, code, error }) => {
        window.connectedAgentTest.emitEvent({ requestId, type: 'tool', callId: 'already-done',
          toolName: 'Shell command', status: 'completed', summary: 'Synthetic command completed',
          durationMs: 12, output: 'Completed once' })
        // Hold any new access check so its response cannot mask the state update.
        window.connectedAgentTest.setHoldInspect(true)
        window.connectedAgentTest.rejectSend(requestId, { code, error })
      }, { requestId, code, error: MESSAGES[code] })
      await page.waitForFunction(() => !document.querySelector('[aria-label="Stop response"]'))
      await page.getByText(`[${code}]`, { exact: false }).first().waitFor()
      assert.equal(await input.inputValue(), 'Preserve my newer draft')
      assert.equal((await snapshot()).requests.length, 1, 'No implicit resend after an uncertain response')
      const accessFailure = ['LUNA_AUTH_REQUIRED', 'LUNA_EXHAUSTED', 'LUNA_NOT_ELIGIBLE'].includes(code)
      assert.equal(await send.isDisabled(), accessFailure, code)
      assert.deepEqual((await snapshot()).authored, baseline, 'No project mutation from error presentation')
      checks.push({ code, invalidatedAccount: accessFailure, requests: 1, draftPreserved: true })
      await context.close()
    }
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    console.log(JSON.stringify({ success: true, checks, realProviderRequests: 0 }, null, 2))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
