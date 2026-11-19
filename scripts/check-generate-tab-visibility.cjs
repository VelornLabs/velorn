// Synthetic browser settings/navigation regression. No real project or service.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5206')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('Loopback fixture only')
async function main() {
  const appSource = fs.readFileSync(path.resolve(__dirname, '../src/App.jsx'), 'utf8')
  assert.doesNotMatch(appSource, /\b(?:ComfyRouterPanel|cloudImageOpen|setCloudImageOpen|onOpenCloudImage)\b/,
    'App must not import, mount, or open the parked Router panel')
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' })
  page.setDefaultTimeout(10000)
  const errors = [], blocked = [], groups = [], artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-generate-visibility-'))
  const pass = name => { groups.push(name); console.log(`PASS ${groups.length}: ${name}`) }
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === base.origin && !/^\/(prompt|queue|history|upload|view|ws|api|v1)(\/|$)/.test(url.pathname)) return route.continue()
    blocked.push(url.href); return route.abort()
  })
  await page.routeWebSocket(() => true, socket => socket.close())
  const state = () => page.evaluate(() => window.generateVisibilityTest.state())
  const toggle = () => page.getByRole('switch', { name: 'Show Director tab', exact: true })
  const tab = name => page.getByRole('navigation', { name: 'Workspace modes' }).getByRole('button', { name, exact: true })
  const openSettings = async () => { await page.evaluate(() => window.generateVisibilityTest.openSettings()); await toggle().waitFor() }
  const closeSettings = async () => { await page.evaluate(() => window.generateVisibilityTest.closeSettings()); await toggle().waitFor({ state: 'detached' }) }
  const assertRouterHidden = async () => {
    assert.equal(await page.getByRole('button', { name: /cloud image/i }).count(), 0)
    assert.equal(await page.locator('[title]').filter({ hasText: /cloud image/i }).count(), 0)
    assert.equal(await page.locator('[title*="Comfy Router" i], [title*="cloud image" i], [aria-label*="cloud image" i]').count(), 0)
    assert.equal((await state()).cloudImageCalls, 0, 'Legacy Router callback must never be invoked')
  }
  try {
    await page.goto(new URL('/tests/fixtures/generate-tab-visibility.html', base).href)
    await page.waitForFunction(() => window.generateVisibilityTest?.ready)
    const before = await state()
    await assertRouterHidden()
    assert.equal(before.showGenerateTab, true); assert.equal(before.hasMountedGenerate, false)
    await tab('Director').click()
    await page.waitForFunction(() => window.generateVisibilityTest.state().mounts === 1)
    await openSettings()
    await page.getByLabel('Search settings', { exact: true }).fill('hide generate')
    await page.getByRole('button', { name: /Appearance & navigation/ }).click()
    await toggle().waitFor()
    await page.screenshot({ path: path.join(artifacts, 'settings.png') })
    pass('Generate stays visible by default; Settings search locates the reversible navigation switch')

    await toggle().click()
    await page.waitForFunction(() => !window.generateVisibilityTest.state().showGenerateTab)
    assert.equal(await toggle().getAttribute('aria-checked'), 'false')
    assert.equal(await tab('Director').count(), 0)
    let hidden = await state()
    assert.equal(hidden.activeTab, 'editor'); assert.equal(hidden.mounts, 1); assert.equal(hidden.unmounts, 0)
    assert.equal(hidden.saved, 'false')
    assert.deepEqual(hidden.calls, [{ key: 'showGenerateTab', value: false }])
    assert.deepEqual(hidden.project, before.project); assert.deepEqual(hidden.queue, before.queue)
    await closeSettings()
    await assertRouterHidden()
    for (const name of ['ComfyUI', 'Editor', 'Stock', 'Export', 'Discover']) assert.equal(await tab(name).count(), 1)
    await page.getByRole('button', { name: 'Open generation queue', exact: true }).click()
    await page.locator('[data-generation-run-id="fixture-running"]').waitFor()
    await page.getByRole('button', { name: 'Close generation queue', exact: true }).click()
    await page.screenshot({ path: path.join(artifacts, 'hidden.png') })
    pass('Hide returns to Editor without unmounting existing jobs or altering project/queue; other tabs and global queue remain available')

    await page.reload(); await page.waitForFunction(() => window.generateVisibilityTest?.ready)
    await assertRouterHidden()
    assert.equal(await tab('Director').count(), 0)
    assert.equal((await state()).hasMountedGenerate, false)
    await openSettings(); assert.equal(await toggle().getAttribute('aria-checked'), 'false'); await closeSettings()
    for (const event of ['comfystudio-open-generate-tab', 'comfystudio-open-generate-with-frame']) {
      await page.evaluate(name => window.generateVisibilityTest.requestGenerate(name), event)
      await page.waitForFunction(() => window.generateVisibilityTest.state().mounts === 1)
      assert.equal((await state()).activeTab, 'editor')
      assert.equal(await page.evaluate(() => window.generateVisibilityTest.probe()), true)
      assert.equal(await tab('Director').count(), 0)
    }
    pass('Preference survives reload; legacy generation requests retain background listeners without reopening the hidden tab')

    await openSettings(); await toggle().click()
    await page.waitForFunction(() => window.generateVisibilityTest.state().showGenerateTab)
    await closeSettings(); await tab('Director').click()
    assert.equal((await state()).activeTab, 'generate'); assert.equal((await state()).unmounts, 0)
    await page.reload(); await page.waitForFunction(() => window.generateVisibilityTest?.ready)
    assert.equal(await tab('Director').count(), 1)
    await page.evaluate(() => window.generateVisibilityTest.setDisabled(true))
    await page.evaluate(() => window.generateVisibilityTest.requestGenerate('comfystudio-open-generate-tab'))
    assert.equal((await state()).hasMountedGenerate, false)
    pass('Restoring the tab is persistent and preserves normal navigation; export-disabled requests cannot mount it')

    await assertRouterHidden()
    await page.setViewportSize({ width: 760, height: 900 })
    await assertRouterHidden()
    await page.screenshot({ path: path.join(artifacts, 'router-parked.png') })
    pass('Cloud image button and tooltip stay absent with a legacy callback, after reload and at narrow width; App has no Router panel UI wiring')

    assert.deepEqual((await state()).forbidden, [])
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    console.log('GENERATE_VISIBILITY_RESULT ' + JSON.stringify({ success: true, groups, artifacts }))
  } catch (error) {
    console.error('Errors:', errors, 'Blocked:', blocked, 'Artifacts:', artifacts)
    await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
