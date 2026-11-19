// RAM-only executable-selection UI regression. Picker, native settings, CLI
// discovery, model metadata, and provider replies are deterministic mocks.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Loopback fixture only')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-agent-executable-'))
async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' })
  const page = await context.newPage(), errors = [], blocked = []
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === base.origin && !/^\/(prompt|queue|history|upload|view|ws|v1|api)(\/|$)/.test(url.pathname)) return route.continue()
    blocked.push(url.href); return route.abort()
  })
  await page.routeWebSocket(() => true, socket => socket.close())
  const button = name => page.getByRole('button', { name, exact: true })
  const checkbox = name => page.getByRole('checkbox', { name, exact: true })
  const installation = page.getByRole('region', { name: 'Codex installation', exact: true })
  const choose = () => button('Choose executable…')
  const automatic = () => button('Use automatic detection')
  const executablePath = () => page.getByLabel('Codex executable path', { exact: true })
  const provider = () => page.getByLabel('Assistant selection', { exact: true })
  const model = () => page.locator('select[aria-label="Model"]')
  const composer = () => page.getByRole('textbox', { name: 'Message your agent', exact: true })
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const openSettings = async () => {
    if (await button('Assistant settings').getAttribute('aria-expanded') !== 'true') await button('Assistant settings').click()
    // These legacy regressions intentionally exercise the individual controls.
    const advanced = page.locator('summary').filter({ hasText: /^Access options$/ })
    if (!(await advanced.evaluate(node => node.parentElement.open))) await advanced.click()
    const connection = page.locator('summary').filter({ hasText: /^Connection settings$/ })
    if (!(await connection.evaluate(node => node.parentElement.open))) await connection.click()
  }
  const back = async () => { if (await button('Back to chat').isVisible()) await button('Back to chat').click() }
  const ready = () => choose().waitFor({ state: 'visible' }).then(() => page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent === 'Choose executable…')
    return button && !button.disabled && window.connectedAgentTest.snapshot().calls.some(call => call.method === 'codexExecutable' && call.action === 'status')
  }))
  const calls = async action => (await snapshot()).calls.filter(call => call.method === 'codexExecutable' && (!action || call.action === action))
  const refresh = async () => { await openSettings(); await button('Check connection').click(); await ready() }
  const full = () => checkbox('Full computer access (experimental)')
  const enableFull = async () => {
    await openSettings(); await ready(); await checkbox('Velorn tools').check(); await full().check(); await frame()
    assert.equal(await full().isChecked(), true)
  }
  const send = async text => {
    await back(); const count = (await snapshot()).requests.length
    await composer().fill(text); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, count)
    return (await snapshot()).requests.at(-1)
  }
  const settle = async request => {
    await page.evaluate(id => window.connectedAgentTest.settle(id, { success: true, text: 'Synthetic reply.' }), request.requestId)
    await button('Send message').waitFor()
  }
  const newPage = async () => {
    await page.goto(new URL('/tests/fixtures/connected-agent.html?strict=1', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    await composer().waitFor()
  }
  const held = async action => {
    await page.waitForFunction(action => window.connectedAgentTest.snapshot().pendingExecutables.some(item => item.action === action), action)
    return (await snapshot()).pendingExecutables.find(item => item.action === action).executableId
  }
  let groups = 0
  const pass = label => console.log(`PASS ${++groups}: ${label}`)
  try {
    await newPage()
    const baseline = (await snapshot()).authored
    assert.equal((await calls()).length, 0)
    await composer().fill('Preserve this installation draft.')
    await openSettings(); await ready()
    assert.equal((await calls('status')).length, 1)
    assert.match(await executablePath().innerText(), /PRIVATE_EXECUTABLE\/automatic/)
    assert.match(await installation.innerText(), /Automatic detection.*PATH/s)
    assert.equal(await automatic().count(), 0)
    assert.equal((await snapshot()).requests.length, 0)
    pass('Opening settings lazily detects installation once under StrictMode and displays device-only path/source without inference')

    await model().selectOption('fixture-codex-fast')
    await page.evaluate(() => {
      window.connectedAgentTest.setExecutable({ path: '', source: 'PATH', mode: 'automatic', available: false })
      window.connectedAgentTest.setConnectionError('Codex CLI was not found.', 'CODEX_NOT_FOUND')
    })
    await refresh()
    assert.match(await installation.innerText(), /Install it separately.*choose its executable.*does not install it automatically/s)
    assert.equal(await model().count(), 0)
    assert.match(await page.getByRole('region', { name: 'Codex setup', exact: true }).innerText(), /Install Codex CLI|Find installed Codex/)
    await page.evaluate(() => window.connectedAgentTest.setConnectionError(''))
    await refresh()
    assert.equal(await model().inputValue(), 'fixture-codex-fast')
    pass('Missing CLI shows guided setup and hides unusable model controls while preserving the selected model for recovery')

    await enableFull()
    const retainedGrant = (await snapshot()).fullAccessGrant.token
    await page.evaluate(() => {
      window.connectedAgentTest.setConnectionError('')
      window.connectedAgentTest.setExecutableResponse('choose', { success: true, cancelled: true })
    })
    const beforeCancel = (await snapshot()).calls.filter(call => call.method === 'inspect').length
    await choose().click(); await ready()
    assert.equal((await snapshot()).calls.filter(call => call.method === 'inspect').length, beforeCancel)
    assert.equal(await automatic().count(), 0)
    assert.equal((await snapshot()).fullAccessGrant.token, retainedGrant)
    await page.evaluate(() => window.connectedAgentTest.setExecutableResponse('choose', { success: false, code: 'INVALID_EXECUTABLE', error: 'Selected file is not a runnable Codex executable.' }))
    await choose().click(); await ready(); await frame()
    await installation.getByRole('alert').filter({ hasText: 'not a runnable Codex' }).waitFor()
    assert.equal(await model().inputValue(), 'fixture-codex-fast')
    assert.equal(await automatic().count(), 0)
    assert.equal((await snapshot()).fullAccessGrant, null)
    assert.equal(await full().isChecked(), false)
    pass('Picker cancellation preserves authority; unsuccessful changes revoke the grant while preserving selection/model and showing an actionable error')

    await enableFull()
    await page.evaluate(() => window.connectedAgentTest.setExecutableResponse('choose', null))
    await choose().click(); await ready()
    assert.match(await executablePath().innerText(), /PRIVATE_EXECUTABLE\/chosen/)
    assert.equal(await automatic().isVisible(), true)
    assert.equal(await model().inputValue(), 'fixture-codex-fast')
    assert.equal(await full().isChecked(), false)
    assert.equal(await page.locator('.ca-full-access-badge').count(), 0)
    assert.equal((await snapshot()).fullAccessGrant, null)
    const lastChoice = (await calls('choose')).at(-1)
    assert.deepEqual(Object.keys(lastChoice).sort(), ['action', 'executableId', 'method'])
    await back(); assert.equal(await composer().inputValue(), 'Preserve this installation draft.')
    pass('Choosing an executable uses only native picker authority, refreshes connection, preserves draft/model and revokes full access')

    const request = await send('A normal message after local installation selection.')
    assert.equal(request.model, 'fixture-codex-fast')
    assert.ok(!JSON.stringify(request).includes('PRIVATE_EXECUTABLE'))
    assert.ok(!JSON.stringify((await snapshot()).storage).includes('PRIVATE_EXECUTABLE'))
    await openSettings(); assert.equal(await choose().isDisabled(), true); assert.equal(await automatic().isDisabled(), true)
    await back(); await settle(request)
    await openSettings(); await automatic().click(); await ready()
    assert.match(await executablePath().innerText(), /PRIVATE_EXECUTABLE\/automatic/)
    assert.equal(await automatic().count(), 0); assert.equal(await model().inputValue(), 'fixture-codex-fast')
    pass('Installation paths never enter send payload/history/preferences; busy actions lock and automatic detection preserves exact model choice')

    await page.evaluate(() => window.connectedAgentTest.setHoldInspect(true))
    await button('Check connection').click()
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().pendingInspects.length > 0)
    assert.equal(await choose().isDisabled(), true)
    await page.evaluate(() => { window.connectedAgentTest.releaseInspect(); window.connectedAgentTest.setHoldInspect(false) })
    await ready()
    await page.evaluate(() => window.connectedAgentTest.setExportBusy(true)); await frame()
    assert.equal(await choose().isDisabled(), true)
    await page.evaluate(() => window.connectedAgentTest.setExportBusy(false)); await frame()
    await checkbox('Velorn tools').check()
    await page.evaluate(() => { window.connectedAgentTest.setHoldFullAccess(true); window.connectedAgentTest.setFullAccessResponse({ success: true, enabled: false }) })
    await full().click(); await frame(); assert.equal(await choose().isDisabled(), true)
    await page.evaluate(() => { window.connectedAgentTest.releaseFullAccess(); window.connectedAgentTest.setHoldFullAccess(false) })
    await ready()
    pass('Checking connection, active export and pending full-access confirmation freeze installation changes')

    await page.evaluate(() => window.connectedAgentTest.setHoldExecutable('choose', true))
    await choose().click(); const pickerId = await held('choose')
    assert.equal(await full().isDisabled(), true)
    await back(); await composer().fill('Must not send during installation picker.')
    assert.equal(await button('Send message').isDisabled(), true)
    const beforeHeld = (await snapshot()).requests.length
    await composer().press('Enter'); assert.equal((await snapshot()).requests.length, beforeHeld)
    await page.evaluate(id => { window.connectedAgentTest.releaseExecutable(id); window.connectedAgentTest.setHoldExecutable('choose', false) }, pickerId)
    await openSettings(); await ready()
    pass('Native picker in flight blocks Send, keyboard submission and enabling full computer access')

    await page.evaluate(() => window.connectedAgentTest.setHoldExecutable('status', true))
    await button('Check connection').click(); await held('status'); await frame()
    const oldStatuses = (await snapshot()).pendingExecutables.filter(item => item.action === 'status').map(item => item.executableId)
    await back(); await button('New chat').click(); await openSettings()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().pendingExecutables.filter(item => item.action === 'status').length > count, oldStatuses.length)
    // A second request belongs to the new chat; resolve it first.
    const allPending = (await snapshot()).pendingExecutables.filter(item => item.action === 'status')
    const newest = allPending.at(-1).executableId
    assert.ok(!oldStatuses.includes(newest))
    await page.evaluate(id => window.connectedAgentTest.releaseExecutable(id, { success: true,
      executable: { path: '/fixture-only/PRIVATE_EXECUTABLE/current-chat/codex', source: 'Current chat result', mode: 'custom', available: true } }), newest)
    await ready()
    await page.evaluate(ids => { for (const id of ids) window.connectedAgentTest.releaseExecutable(id, { success: true,
      executable: { path: '/STALE_STATUS_MUST_NOT_APPEAR/codex', source: 'Old chat', mode: 'custom', available: true } }); window.connectedAgentTest.setHoldExecutable('status', false) }, oldStatuses)
    await frame(); assert.ok(!(await installation.innerText()).includes('STALE_STATUS_MUST_NOT_APPEAR'))
    assert.match(await executablePath().innerText(), /current-chat/)
    pass('Delayed status from a previous conversation cannot overwrite the current chat settings')

    await page.evaluate(() => window.connectedAgentTest.setHoldExecutable('choose', true))
    await choose().click(); const oldChoice = await held('choose')
    assert.equal(await provider().isDisabled(), true, 'an active installation picker locks provider changes')
    await page.evaluate(id => { window.connectedAgentTest.releaseExecutable(id, { success: true, cancelled: true }); window.connectedAgentTest.setHoldExecutable('choose', false) }, oldChoice)
    await ready()
    await provider().selectOption('lmstudio'); await frame()
    assert.equal(await installation.count(), 0)
    await openSettings()
    await provider().selectOption('codex'); await openSettings(); await ready()
    await page.evaluate(() => window.connectedAgentTest.setHoldExecutable('choose', true))
    await choose().click(); const oldProject = await held('choose')
    await page.evaluate(() => window.connectedAgentTest.switchProject('beta')); await frame(); await openSettings()
    await page.evaluate(id => { window.connectedAgentTest.releaseExecutable(id, { success: false, error: 'STALE_PROJECT_ERROR' }); window.connectedAgentTest.setHoldExecutable('choose', false) }, oldProject)
    await ready(); assert.ok(!(await installation.innerText()).includes('STALE_PROJECT_ERROR'))
    pass('Pending picker locks provider changes; picker completions from old projects cannot overwrite current settings or errors')

    await newPage(); await openSettings(); await ready()
    assert.deepEqual((await snapshot()).authored, baseline)
    await page.evaluate(() => { delete window.electronAPI.connectedAgent.codexExecutable })
    await button('Check connection').click()
    await installation.getByRole('alert').filter({ hasText: 'Fully quit and reopen Velorn' }).waitFor()
    assert.equal(await choose().isDisabled(), true)
    pass('Older preload bridge reports restart requirement without exposing a renderer path override')

    await newPage(); await openSettings(); await ready(); await choose().click(); await ready()
    for (const width of [900, 760]) {
      await page.setViewportSize({ width, height: 700 })
      await installation.scrollIntoViewIfNeeded()
      const size = await installation.evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }))
      assert.ok(size.scroll <= size.client + 1)
      await page.screenshot({ path: path.join(output, `codex-installation-${width}px.png`), fullPage: true })
    }
    assert.deepEqual((await snapshot()).authored, baseline)
    assert.deepEqual(errors, []); assert.deepEqual(blocked, []); assert.deepEqual((await snapshot()).forbiddenCalls, [])
    pass('Compact installation controls fit narrow settings without authored edits, external requests or real native operations')
    console.log(`Artifacts: ${output}`)
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
