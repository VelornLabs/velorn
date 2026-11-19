// Isolated browser UI and in-memory Electron bridge. Never opens the normal
// app, native user settings, a project, MCP, or a ComfyUI/process endpoint.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5198')
if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:') throw new Error('Fixture requires a loopback Vite server')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-comfy-setup-ui-'))

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const groups = [], snapshots = [], errors = [], unexpectedRequests = []
  let context, page
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const snapshot = () => page.evaluate(() => window.comfySetupTest.snapshot())
  const load = async ({ platform = 'linux', scenario = 'multiple', surface = 'setup' } = {}) => {
    await context?.close()
    context = await browser.newContext({ viewport: { width: 1100, height: 1000 }, locale: 'en-US' })
    page = await context.newPage()
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin === base.origin) return route.continue()
      unexpectedRequests.push(url.href)
      return route.abort()
    })
    await page.routeWebSocket(() => true, socket => socket.close())
    const url = new URL('/tests/fixtures/comfy-setup.html', base)
    for (const [key, value] of Object.entries({ platform, scenario, surface })) url.searchParams.set(key, value)
    await page.goto(url.href)
    await page.waitForFunction(() => window.comfySetupTest?.ready)
    if (surface === 'chip') await page.locator('#fixture-surface button').first().click()
  }
  const scan = async () => {
    await page.getByRole('button', { name: 'Find running ComfyUI', exact: true }).click()
    await page.waitForFunction(() => window.comfySetupTest.snapshot().calls.some(call => call.method === 'discoverConnections'))
  }
  const noWrites = state => {
    assert.deepEqual(state.writes, [], 'Discovery/failure must not write settings')
    assert.deepEqual(state.configWrites, [], 'Discovery/connection must not configure a launcher')
    assert.deepEqual(state.forbiddenCalls, [], 'No process action is permitted')
    assert.equal(state.connection.port, 8188)
    assert.equal(state.settings.comfyConnection.port, 8188)
    assert.deepEqual(state.connectionEvents, [], 'No connection-change broadcast before a successful save')
  }
  const capture = async name => {
    const state = await snapshot()
    snapshots.push({ name, ...state })
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
    return state
  }
  const manual = async port => {
    await page.getByText('Enter a port manually', { exact: true }).click()
    await page.getByLabel('ComfyUI port', { exact: true }).fill(String(port))
    await page.getByRole('button', { name: 'Test and connect', exact: true }).click()
  }
  try {
    for (const platform of ['linux', 'win32', 'darwin']) {
      await load({ platform })
      noWrites(await snapshot())
      await scan()
      await page.getByRole('button', { name: 'Connect to ComfyUI on port 8189', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Connect to ComfyUI on port 8188', exact: true }).waitFor()
      const found = await capture(`${platform}-multiple-candidates`)
      noWrites(found)
      assert.equal(found.calls.filter(call => call.method === 'probeConnection').length, 0, 'Discovery must not implicitly connect')
      await page.getByRole('button', { name: 'Connect to ComfyUI on port 8189', exact: true }).click()
      await page.waitForFunction(() => window.comfySetupTest.snapshot().connection.port === 8189)
      const state = await capture(`${platform}-connected`)
      assert.deepEqual(state.writes, [{ key: 'comfyConnection', value: { host: '127.0.0.1', port: 8189 } }])
      assert.equal(state.calls.filter(call => call.method === 'probeConnection' && Number(call.payload.port) === 8189).length, 1)
      assert.equal(state.connectionEvents.length, 1)
      assert.deepEqual(state.configWrites, [])
      assert.deepEqual(state.forbiddenCalls, [])
      pass(`${platform}: multiple servers remain separate choices; only explicit Connect probes and saves one`)
    }

    await load({ surface: 'compact' })
    await manual(43210)
    await page.waitForFunction(() => window.comfySetupTest.snapshot().connection.port === 43210)
    let state = await capture('manual-custom-port')
    assert.equal(state.settings.comfyConnection.port, 43210)
    assert.equal(state.calls.find(call => call.method === 'probeConnection').payload.port, 43210)
    assert.deepEqual(state.forbiddenCalls, [])
    pass('Compact manual setup tests and saves a custom port without launching anything')

    await load({ scenario: 'probe-failure' })
    await manual(43210)
    await page.getByText(/Fixture probe failed/).waitFor()
    noWrites(await capture('failed-probe'))
    pass('Failed probe stays visible and never writes or changes the current connection')

    for (const scenario of ['save-failure', 'save-throw']) {
      await load({ scenario })
      await manual(43210)
      await page.getByText(/Fixture settings save/).waitFor()
      state = await capture(scenario)
      assert.equal(state.writes.length, 1)
      assert.equal(state.settings.comfyConnection.port, 8188)
      assert.equal(state.connection.port, 8188, 'Failed persistence must retain the in-memory connection')
      assert.equal(JSON.parse(state.localConnection || '{"port":8188}').port, 8188)
      assert.deepEqual(state.connectionEvents, [])
      assert.deepEqual(state.forbiddenCalls, [])
      pass(`${scenario}: persistence failure retains native, cached and browser-stored connection state`)
    }

    await load({ scenario: 'managed' })
    await scan()
    const switchButton = page.getByRole('button', { name: 'Connect to ComfyUI on port 8189', exact: true })
    await switchButton.waitFor()
    if (!await switchButton.isDisabled()) {
      await switchButton.click()
      await page.getByText(/Stop it before switching ports/i).first().waitFor()
    }
    noWrites(await capture('managed-port-protected'))
    pass('A managed running ComfyUI instance cannot silently switch to another port')

    await load({ scenario: 'managed-probe-race' })
    await manual(43210)
    await page.getByText(/Stop it before switching ports/i).first().waitFor()
    noWrites(await capture('managed-started-during-probe'))
    pass('A managed instance starting during the probe prevents the later connection write')

    await load({ scenario: 'none' })
    await scan()
    await page.getByRole('status').filter({ hasText: /No running ComfyUI found/ }).waitFor()
    noWrites(await capture('none-found'))
    assert.equal(await page.getByRole('button', { name: /^Connect to ComfyUI on port/ }).count(), 0)
    pass('No server found offers opening ComfyUI and manual setup, without automatically writing settings')

    await load({ scenario: 'missing-api' })
    await page.getByRole('button', { name: 'Find running ComfyUI', exact: true }).click()
    await page.getByText(/(?:restart Velorn|quit and reopen Velorn)/i).first().waitFor()
    noWrites(await capture('restart-guidance'))
    pass('An older native bridge shows restart guidance rather than a broken discovery action')

    for (const surface of ['settings', 'chip']) {
      await load({ platform: 'darwin', surface })
      await scan()
      await page.getByRole('button', { name: 'Connect to ComfyUI on port 8189', exact: true }).waitFor()
      noWrites(await capture(`darwin-${surface}-discovery`))
      await page.getByText('Let Velorn start ComfyUI (optional)', { exact: true }).click()
      const appCandidate = page.getByRole('button', { name: /Fixture ComfyUI\.app/ })
      await appCandidate.click()
      await page.waitForFunction(() => window.comfySetupTest.snapshot().config.launcherMode === 'mac-app')
      await page.waitForFunction(() => [...document.querySelectorAll('button')]
        .some(button => button.textContent.includes('Fixture ComfyUI.app') && button.disabled))
      state = await capture(`darwin-${surface}-app-selected`)
      assert.deepEqual(state.configWrites, [{ launcherMode: 'mac-app', macAppPath: '/Applications/Fixture ComfyUI.app' }])
      assert.equal(state.config.launcherScript, '')
      assert.equal(state.config.autoStart, false)
      assert.deepEqual(state.writes, [])
      assert.deepEqual(state.forbiddenCalls, [])
      pass(`${surface}: real launcher UI shares discovery and saves macOS app candidates as app targets only`)
    }
    assert.deepEqual(errors, [], 'Renderer exceptions')
    assert.deepEqual(unexpectedRequests, [], 'The fixture must never contact a real server')
    const result = { success: true, groups, output, snapshots }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    console.log('COMFY_SETUP_UI_RESULT ' + JSON.stringify({ success: true, groups, output }))
  } catch (error) {
    await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, unexpectedRequests,
      snapshot: await snapshot().catch(() => null), groups, snapshots }, null, 2))
    console.error('COMFY_SETUP_UI_FAILURE ' + output)
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
