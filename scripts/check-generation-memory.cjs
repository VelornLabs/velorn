'use strict'
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = process.env.VELORN_TEST_URL || 'http://127.0.0.1:5208'
async function main() {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
  try {
    const page = await browser.newPage(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
    await page.goto(`${base}/tests/fixtures/generation-memory.html`)
    const checkbox = page.getByRole('checkbox', { name: 'Free GPU memory after generation' })
    await checkbox.waitFor(); await page.waitForFunction(() => !document.querySelector('input').disabled)
    assert.equal(await checkbox.isChecked(), false)
    await checkbox.check(); await page.waitForFunction(() => window.memoryFixture.snapshot().stored)
    await page.evaluate(() => window.memoryFixture.mount()); await page.waitForFunction(() => document.querySelector('input').checked)
    await page.evaluate(() => window.memoryFixture.fail(true)); await checkbox.click()
    await page.getByRole('alert').waitFor(); assert.equal(await checkbox.isChecked(), true)
    await page.evaluate(() => window.memoryFixture.fail(false)); await checkbox.uncheck()
    await page.waitForFunction(() => !window.memoryFixture.snapshot().stored)
    assert.deepEqual(await page.evaluate(() => window.memoryFixture.snapshot().writes), [true, false])
    assert.deepEqual(errors, [])
    console.log('PASS: real memory checkbox defaults off, persists/remounts, reports save failure, and toggles off; no native or ComfyUI calls.')
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
