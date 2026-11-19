// Standalone real component with a synthetic RAM-only native bridge.
// Run only against a separate fixture Vite; all external/API traffic is blocked.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5242')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw Error('Loopback fixture only')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-comfy-hosted-setup-'))
const FAKE = 'synthetic-hosted-fixture-secret-not-a-real-key'

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  let context, page, errors = [], blocked = [], groups = 0
  const button = name => page.getByRole('button', { name, exact: true })
  const key = () => page.getByLabel('Comfy Cloud API key', { exact: true })
  const remember = () => page.getByRole('checkbox', { name: 'Remember on this device', exact: true })
  const snapshot = () => page.evaluate(() => window.hostedSetupTest.snapshot())
  const invoke = (method, value) => page.evaluate(({ method, value }) => window.hostedSetupTest[method](value), { method, value })
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const pass = label => console.log(`PASS ${++groups}: ${label}`)
  const fresh = async (query = '', width = 1280) => {
    await context?.close()
    context = await browser.newContext({ viewport: { width, height: 940 }, serviceWorkers: 'block' })
    page = await context.newPage(); page.setDefaultTimeout(10000); errors = []; blocked = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin === base.origin && !/^\/(v1|api|prompt|queue|history|upload|ws)(\/|$)/.test(url.pathname)) return route.continue()
      blocked.push(url.href); return route.abort()
    })
    await page.routeWebSocket(() => true, socket => socket.close())
    await page.goto(new URL(`/tests/fixtures/comfy-hosted-setup.html${query ? `?${query}` : ''}`, base).href)
    await page.waitForFunction(() => window.hostedSetupTest?.ready)
    await page.getByRole('heading', { name: 'Hosted Comfy Cloud', exact: true }).waitFor()
    await frame()
  }
  const clean = async () => {
    const state = await snapshot()
    assert.deepEqual(state.forbidden, [])
    assert.deepEqual(state.storage, {}, 'No hosted credential in localStorage')
    assert.deepEqual(state.sessionStorage, {}, 'No hosted credential in sessionStorage')
    assert.equal(await page.locator('body').evaluate(node => node.textContent.includes('synthetic-hosted-fixture-secret-not-a-real-key')), false)
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  }
  const checks = async () => (await snapshot()).calls.filter(call => call.method === 'check')
  const settled = async () => {
    await page.waitForFunction(() => !document.querySelector('input[type=password]')?.disabled)
    await frame()
  }
  const checked = async (value = FAKE) => {
    if (value !== null) await key().fill(value)
    await button('Check account access').click(); await settled()
    assert.equal(await key().inputValue(), '', 'Candidate key is cleared after a check')
  }
  try {
    await fresh()
    assert.equal(await key().getAttribute('type'), 'password')
    assert.equal(await remember().isChecked(), false)
    assert.equal(await remember().isEnabled(), false, 'Remember is disabled until a new key is entered')
    assert.equal(await button('Check account access').isEnabled(), false)
    assert.equal(await button('Forget hosted key').count(), 0)
    assert.deepEqual((await snapshot()).calls.map(call => call.method), ['status'])
    assert.match(await page.locator('body').innerText(), /generation/i)
    await clean(); pass('Opening only reads passive status; missing key is masked and remembering is opt-in')

    await button('Get a Comfy API key').click()
    await button('Comfy Cloud guide').click()
    assert.deepEqual((await snapshot()).calls.filter(call => call.method === 'openGuide'), [
      { method: 'openGuide', guide: 'keys' }, { method: 'openGuide', guide: 'cloud' },
    ])
    assert.equal((await checks()).length, 0)
    await clean(); pass('Official links use fixed native guide actions without checking or changing credentials')

    await checked()
    assert.deepEqual(await checks(), [{ method: 'check', payloadKeys: ['key', 'remember'], hasKey: true, fixtureKey: true, remember: false }])
    assert.equal((await snapshot()).configured, true); assert.equal((await snapshot()).remembered, false)
    await button('Forget hosted key').waitFor()
    await page.screenshot({ path: path.join(output, 'hosted-cloud-desktop.png'), fullPage: true })
    await clean(); pass('Explicit account check passes an in-memory candidate and clears the field without storage')

    await fresh(); await key().fill(FAKE); await remember().check(); await checked()
    assert.equal((await checks())[0].remember, true)
    assert.equal((await snapshot()).remembered, true)
    await clean(); pass('Remembering is explicit and passes only the requested native persistence flag')

    await fresh('configured=1&remembered=1')
    assert.equal(await key().inputValue(), '')
    assert.equal((await checks()).length, 0)
    await checked(null)
    assert.deepEqual(await checks(), [{ method: 'check', payloadKeys: [], hasKey: false, fixtureKey: false, remember: undefined }])
    await clean(); pass('Existing saved keys are checked natively without exposing the key to the renderer')

    await button('Forget hosted key').click(); await button('Cancel').waitFor()
    assert.equal((await snapshot()).calls.filter(call => call.method === 'clear').length, 0)
    await button('Cancel').click()
    assert.equal((await snapshot()).configured, true)
    await button('Forget hosted key').click(); await button('Forget key').click(); await settled()
    assert.equal((await snapshot()).configured, false)
    assert.equal((await snapshot()).calls.filter(call => call.method === 'clear').length, 1)
    await clean(); pass('Forgetting a hosted key requires confirmation; cancellation preserves it')

    await fresh('memoryOnly=1')
    assert.equal(await remember().isEnabled(), false)
    assert.equal(await remember().isChecked(), false)
    await checked(); assert.equal((await checks())[0].remember, false)
    await clean(); pass('Unavailable secure storage disables remembering while allowing session-only checks')

    await fresh(); await invoke('holdCheck', true); await key().fill(FAKE)
    await button('Check account access').click()
    await page.waitForFunction(() => window.hostedSetupTest.snapshot().waitingChecks === 1)
    assert.equal(await key().isEnabled(), false)
    assert.equal(await remember().isEnabled(), false)
    assert.equal(await page.getByRole('button', { name: /Check.*account|Checking/i }).isEnabled(), false)
    await page.locator('form').evaluate(form => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    assert.equal((await checks()).length, 1)
    await invoke('releaseChecks'); await settled()
    assert.equal(await key().inputValue(), '')
    await clean(); pass('Pending checks disable input and duplicate submission')

    for (const mode of ['waitlisted', 'auth-rejected', 'subscription-or-rate-limited', 'unavailable', 'throw', 'malformed', 'unconfigured-verified']) {
      await fresh('configured=1'); await checked(null)
      await invoke('mode', mode); await invoke('tainted', true); await checked(null)
      await clean()
      const text = await page.locator('body').innerText()
      assert.doesNotMatch(text, /Synthetic verified summary|<img src=x|synthetic-hosted-fixture/)
      assert.doesNotMatch(await page.getByRole('status').innerText(), /Account access verified/)
      assert.equal((await checks()).length, 2)
      pass(`A ${mode} recheck safely replaces prior verification without provider/error/credential leakage`)
    }

    await fresh(); await invoke('tainted', true); await checked()
    await clean(); pass('Even successful results never render untrusted native summaries or unexpected key fields')

    await fresh('configured=1&remembered=1'); await checked(null)
    await key().fill(`${FAKE} extra text`)
    assert.match(await page.getByRole('status').innerText(), /New key not checked/)
    assert.doesNotMatch(await page.getByRole('status').innerText(), /Account access verified/)
    await button('Check account access').click(); await frame()
    assert.equal((await checks()).length, 1, 'Invalid pasted extra text never reaches native check')
    await page.getByRole('alert').filter({ hasText: 'without spaces or extra text' }).waitFor()
    await key().fill(FAKE); await invoke('mode', 'auth-rejected'); await checked(null)
    assert.equal((await snapshot()).configured, true); assert.equal((await snapshot()).remembered, true)
    assert.doesNotMatch(await page.getByRole('status').innerText(), /Account access verified/)
    await clean(); pass('Typing a replacement invalidates displayed verification; malformed/rejected candidates preserve the old key without reusing old readiness')

    await fresh(); await invoke('mode', 'waitlisted'); await checked()
    assert.equal((await snapshot()).configured, false)
    assert.equal(await button('Forget hosted key').count(), 0)
    assert.match(await page.getByRole('status').innerText(), /Access pending/)
    await clean(); pass('A new waitlisted key is not adopted, remembered or labeled verified')

    await fresh(); await key().fill(FAKE); await key().press('Enter'); await settled()
    assert.equal((await checks()).length, 1)
    assert.equal(await key().inputValue(), '')
    await clean(); pass('The labeled password form supports keyboard submission without an extra check')

    await fresh('configured=1'); await invoke('clearFails', true)
    await button('Forget hosted key').click(); await button('Forget key').click(); await settled()
    assert.equal((await snapshot()).configured, true)
    await clean(); pass('Failed removal keeps the credential configured and renders no raw native error')

    await fresh('holdStatus=1')
    await page.waitForFunction(() => window.hostedSetupTest.snapshot().waitingStatus === 1)
    await invoke('mounted', false); await frame(); await invoke('releaseStatus'); await frame()
    assert.equal(await page.getByRole('heading', { name: 'Hosted Comfy Cloud', exact: true }).count(), 0)
    await invoke('mounted', true); await key().waitFor(); await settled()
    assert.equal((await checks()).length, 0)
    await clean(); pass('Delayed initial status is ignored after unmount and never triggers an account check')

    await fresh(); await invoke('holdCheck', true); await key().fill(FAKE)
    await button('Check account access').click()
    await page.waitForFunction(() => window.hostedSetupTest.snapshot().waitingChecks === 1)
    await invoke('mounted', false); await frame(); await invoke('releaseChecks'); await frame()
    assert.equal(await page.getByRole('heading', { name: 'Hosted Comfy Cloud', exact: true }).count(), 0)
    await invoke('mounted', true); await key().waitFor(); await settled()
    assert.equal(await key().inputValue(), '')
    assert.equal((await checks()).length, 1)
    assert.equal((await snapshot()).calls.filter(call => call.method === 'cancel').length, 1)
    assert.equal((await snapshot()).configured, false, 'Unmount cancellation prevents candidate adoption')
    await clean(); pass('Unmount discards pending renderer results; remount never repeats the check or restores a key')

    await fresh('configured=1', 390)
    await checked(null)
    await button('Forget hosted key').click()
    const width = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }))
    assert.ok(width.document <= width.viewport + 1, `No horizontal overflow: ${JSON.stringify(width)}`)
    for (const name of ['Get a Comfy API key', 'Comfy Cloud guide', 'Forget key', 'Cancel']) assert.equal(await button(name).isVisible(), true)
    assert.equal(await key().getAttribute('type'), 'password')
    await page.screenshot({ path: path.join(output, 'hosted-cloud-mobile.png'), fullPage: true })
    await clean(); pass('390px layout keeps labeled key, links and confirmation controls usable without overflow')

    await fresh('noBridge=1')
    assert.equal((await snapshot()).calls.length, 0)
    assert.equal(await button('Check account access').isEnabled(), false)
    await clean(); pass('Missing desktop bridge fails closed without browser networking or settings access')

    for (const query of ['statusThrows=1', 'statusMalformed=1']) {
      await fresh(query)
      assert.equal(await key().isEnabled(), false)
      assert.equal(await button('Check account access').isEnabled(), false)
      assert.equal((await checks()).length, 0)
      assert.doesNotMatch(await page.getByRole('status').innerText(), /Account access verified/)
      await clean(); pass(`${query}: invalid initial status fails closed without leaking raw errors or credentials`)
    }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: groups, output }, null, 2))
    console.log(JSON.stringify({ passed: groups, output }))
  } finally { await context?.close(); await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
