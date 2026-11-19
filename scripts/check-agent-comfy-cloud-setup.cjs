'use strict'
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5221')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Loopback fixture only')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-guided-key-'))
const FAKE = 'synthetic-only-not-a-real-key'
async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 900, height: 850 } }), errors = [], blocked = []
  page.setDefaultTimeout(8000)
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => new URL(route.request().url()).origin === base.origin ? route.continue() : (blocked.push('external request blocked'), route.abort()))
  const call = (method, value) => page.evaluate(({ method, value }) => window.cloudSetupTest[method](value), { method, value })
  const snapshot = () => page.evaluate(() => window.cloudSetupTest.snapshot())
  const button = name => page.getByRole('button', { name, exact: true }), dialog = () => page.getByRole('dialog')
  const input = () => dialog().locator('input')
  const fresh = async () => {
    if (await page.evaluate(() => Boolean(window.cloudSetupTest))) {
      assert.ok(!JSON.stringify(await snapshot()).includes('synthetic-only'), 'No fixture credential enters serialized logs or agent receipts')
    }
    await page.goto(new URL('/tests/fixtures/agent-comfy-cloud-setup.html', base).href)
    await button('Ordinary key settings').waitFor()
    await page.waitForFunction(() => window.cloudSetupTest?.snapshot().listeners === 2)
  }
  const open = async () => { await button('Request key setup').click(); await dialog().waitFor(); await page.waitForFunction(() => !document.querySelector('[role=dialog] input')?.disabled) }
  const gone = () => dialog().waitFor({ state: 'detached' })
  let groups = 0
  try {
    await fresh(); assert.equal((await snapshot()).calls.some(item => item.method === 'validate'), false)
    await open(); await input().fill(FAKE); await button('Save key').click(); await gone()
    let state = await snapshot(); assert.equal(state.receipts.at(-1).status, 'verified'); assert.equal(state.configured, true)
    assert.equal(state.calls.filter(item => item.method === 'ordinary-save').length, 0)
    assert.ok(!JSON.stringify(state).includes(FAKE)); groups++

    await fresh(); await call('mode', 'unknown'); await open(); await input().fill(FAKE); await button('Save key').click()
    await button('Save without verification').waitFor(); state = await snapshot()
    assert.equal(state.configured, false); assert.equal(state.receipts.length, 0)
    await button('Save without verification').click(); await gone(); assert.equal((await snapshot()).receipts.at(-1).status, 'configured'); groups++

    await fresh(); await call('mode', 'invalid'); await open(); await input().fill(FAKE); await button('Test').click()
    await dialog().getByRole('alert').waitFor(); assert.equal(await button('Save key').isDisabled(), true)
    assert.equal((await snapshot()).calls.filter(item => item.method === 'guided-save').length, 0)
    await call('mode', 'valid'); await button('Test').click(); await page.waitForFunction(() => [...document.querySelectorAll('[role=status]')].some(node => node.textContent.includes('accepted')))
    await button('Save key').click(); await gone(); groups++

    await fresh(); await call('mode', 'hold'); await open(); await input().fill(FAKE); await button('Save key').click()
    await page.waitForFunction(() => window.cloudSetupTest.snapshot().waitingValidation === 1)
    await button('Cancel').click(); await gone(); await call('releaseValidation'); await page.waitForTimeout(50)
    state = await snapshot(); assert.equal(state.configured, false); assert.equal(state.calls.some(item => item.method === 'guided-save'), false)
    await open(); assert.equal(await input().inputValue(), ''); await button('Cancel').click(); await gone(); groups++

    await fresh(); await call('failSave', true); await open(); await input().fill(FAKE); await button('Save key').click()
    await dialog().getByRole('alert').waitFor(); state = await snapshot(); assert.equal(state.configured, false); assert.equal(state.receipts.length, 0)
    assert.equal(state.keyEvents.length, 0); assert.ok(!(await dialog().innerText()).includes(FAKE))
    await call('failSave', false); await button('Save key').click(); await gone(); groups++

    await fresh(); await call('existing', true); await call('legacy'); await open(); assert.equal(await input().inputValue(), '')
    await button('Test saved key').click(); await page.waitForFunction(() => [...document.querySelectorAll('[role=status]')].some(node => node.textContent.includes('accepted')))
    await button('Use saved key').click(); await gone(); state = await snapshot()
    assert.equal(state.calls.find(item => item.method === 'guided-save').useExisting, true); assert.equal(state.receipts.at(-1).validation, 'valid')
    assert.equal(state.legacyPresent, false); groups++

    await fresh(); await call('existing', true); await open(); await button('Test saved key').click()
    await page.waitForFunction(() => [...document.querySelectorAll('[role=status]')].some(node => node.textContent.includes('accepted')))
    await call('existing', false); await button('Use saved key').click(); await dialog().getByRole('alert').waitFor()
    state = await snapshot(); assert.equal(state.configured, false); assert.equal(state.receipts.length, 0)
    await button('Cancel').click(); await gone(); groups++

    await fresh(); await call('existing', true); await call('legacy'); await open(); await input().fill('synthetic-only-replacement-key'); await button('Replace key').click(); await gone()
    assert.equal((await snapshot()).legacyPresent, false)
    await open(); await button('Remove').click(); await gone(); state = await snapshot()
    assert.equal(state.receipts.at(-1).outcome, 'removed'); assert.equal(state.configured, false); groups++

    await fresh(); await call('mode', 'hold'); await open(); await input().fill(FAKE); await button('Save key').click()
    await page.waitForFunction(() => window.cloudSetupTest.snapshot().waitingValidation === 1)
    await call('stop'); await gone(); await call('releaseValidation'); await page.waitForTimeout(50)
    assert.equal((await snapshot()).calls.some(item => item.method === 'guided-save'), false); groups++

    await fresh(); await open(); await input().fill('   ')
    assert.equal(await button('Save key').isDisabled(), true)
    await input().fill('synthetic-invalid key-shape'); await button('Save key').click()
    await dialog().getByRole('alert').waitFor(); state = await snapshot()
    assert.equal(state.configured, false); assert.equal(state.receipts.length, 0)
    assert.equal(state.keyEvents.length, 0); assert.equal(state.calls.some(item => item.method === 'guided-save'), false)
    await button('Cancel').click(); await gone(); groups++

    await fresh(); await call('mode', 'hold'); await button('Ordinary key settings').click(); await dialog().waitFor(); await input().fill(FAKE); await button('Save key').click()
    await page.waitForFunction(() => window.cloudSetupTest.snapshot().waitingValidation === 1)
    await button('Cancel').click(); await gone(); await call('releaseValidation'); await page.waitForTimeout(50)
    state = await snapshot(); assert.equal(state.calls.some(item => item.method === 'ordinary-save'), false); assert.equal(state.ordinarySaved, 0); groups++

    await fresh(); await call('holdCommit', true); await open(); await input().fill(FAKE); await button('Save key').click()
    await page.waitForFunction(() => window.cloudSetupTest.snapshot().waitingCommit === 1)
    await button('Cancel').click(); await gone(); await call('releaseCommit'); await page.waitForTimeout(50)
    assert.equal((await snapshot()).configured, false); assert.equal((await snapshot()).keyEvents.length, 0); groups++

    await fresh(); await call('mounted', false); await call('request'); assert.equal(await dialog().count(), 0)
    await call('mounted', true); await dialog().waitFor(); await button('Cancel').click(); await gone(); await call('staleEvent'); await page.waitForTimeout(50)
    assert.equal(await dialog().count(), 0); groups++

    await fresh(); await call('holdCurrent', true); await call('request'); await page.waitForFunction(() => window.cloudSetupTest.snapshot().waitingCurrent > 0)
    await call('holdCurrent', false); await call('stop'); await call('releaseCurrent'); await page.waitForTimeout(50)
    assert.equal(await dialog().count(), 0); groups++

    await fresh(); await button('Ordinary key settings').click(); await dialog().waitFor(); await input().fill(FAKE)
    await button('Save key').click(); await gone(); state = await snapshot(); assert.equal(state.ordinarySaved, 1); assert.equal(state.configured, true)
    assert.equal(state.calls.filter(item => item.method === 'guided-save').length, 0)
    await button('Ordinary key settings').click(); await dialog().waitFor(); await button('Remove').click()
    await page.waitForFunction(() => window.cloudSetupTest.snapshot().ordinarySaved === 2)
    await button('Cancel').click(); await gone(); groups++

    await fresh(); await call('failSave', true); await button('Ordinary key settings').click(); await dialog().waitFor(); await input().fill(FAKE); await button('Save key').click()
    await dialog().getByRole('alert').waitFor(); state = await snapshot(); assert.equal(state.ordinarySaved, 0); assert.equal(state.legacyPresent, false); assert.equal(state.keyEvents.length, 0)
    await button('Cancel').click(); await gone(); groups++

    await fresh(); await page.setViewportSize({ width: 390, height: 660 }); await open()
    await input().fill(FAKE); await input().focus(); await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('[role=dialog]'))), true)
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('[role=dialog]'))), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await input().fill(''); await page.screenshot({ path: path.join(output, 'guided-key-narrow.png') })
    await page.keyboard.press('Escape'); await gone(); assert.equal(await page.evaluate(() => document.activeElement.id), 'request-setup')
    await open(); assert.equal(await input().inputValue(), ''); await button('Close').click(); await gone(); groups++

    assert.deepEqual(errors, []); assert.deepEqual(blocked, []); assert.deepEqual((await snapshot()).forbidden, [])
    console.log(JSON.stringify({ groups, output, result: 'passed', realCredentials: false, network: false }))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error.message.replaceAll(FAKE, '[synthetic key redacted]')); process.exitCode = 1 })
