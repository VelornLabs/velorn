const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
async function main() {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('http://127.0.0.1:5206/tests/fixtures/viewer-presentation.html')
    const viewport = page.locator('[data-preview-viewport]')
    await viewport.waitFor()
    await page.evaluate(() => window.viewerPresentationTest.seedEditingProbe())
    const before = await page.evaluate(() => window.viewerPresentationTest.snapshot().authored)
    const transform = async () => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      return viewport.locator('[style*="translate("]').first().evaluate(el => el.style.transform)
    }
    const original = await transform()
    const box = await viewport.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2
    await page.mouse.move(x, y); await page.mouse.down({ button: 'middle' })
    await page.mouse.move(x + 65, y + 35, { steps: 5 }); await page.mouse.up({ button: 'middle' })
    assert.notEqual(await transform(), original)
    const panned = await transform()
    await page.mouse.move(x + 100, y + 70)
    assert.equal(await transform(), panned)
    await page.getByRole('button', { name: 'Pan preview', exact: true }).click()
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 40, y - 20, { steps: 5 }); await page.mouse.up()
    assert.notEqual(await transform(), panned)
    assert.equal(await page.evaluate(() => window.viewerPresentationTest.snapshot().authored), before)
    await page.keyboard.press('Space')
    await page.waitForFunction(() => window.viewerPresentationTest.snapshot().playing)
    await page.keyboard.press('Space')
    await page.waitForFunction(() => !window.viewerPresentationTest.snapshot().playing)
    await page.mouse.move(x, y); await page.mouse.down({ button: 'middle' }); await page.mouse.move(x + 20, y)
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    const blurred = await transform()
    await page.mouse.move(x + 60, y); await page.mouse.up({ button: 'middle' })
    assert.equal(await transform(), blurred)
    assert.deepEqual(errors, [])
    console.log('PASS: middle-drag, Hand left-drag, no clip edits, release/blur cleanup and Space playback')
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
