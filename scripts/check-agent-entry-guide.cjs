// Actual Agent dock with RAM settings and synthetic provider metadata only.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5226')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw Error('Loopback fixture required')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-agent-entry-'))
const intentKey = 'velorn.agent-entry-intent.v1', settingsKey = 'velorn.connected-agent.settings.v1'
async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  let page, viewport = { width: 1100, height: 780 }
  const errors = [], blocked = [], groups = []
  const button = name => page.getByRole('button', { name, exact: true })
  const guide = () => page.getByRole('region', { name: 'LM Studio connection help', exact: true })
  const choice = () => page.getByRole('region', { name: 'Choose your assistant', exact: true })
  const composer = () => page.getByRole('textbox', { name: 'Message your agent', exact: true })
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const count = async method => (await snapshot()).calls.filter(call => call.method === method).length
  const call = (method, args = []) => page.evaluate(({ method, args }) => window.connectedAgentTest[method](...args), { method, args })
  const fresh = async (status = 'missing', storage) => {
    await page?.close()
    page = await browser.newPage({ viewport }); page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => new URL(route.request().url()).origin === base.origin ? route.continue() : (blocked.push('external'), route.abort()))
    await page.routeWebSocket(() => true, socket => socket.close())
    if (storage) await page.addInitScript(value => { window.__connectedAgentFixtureStorage = value }, storage)
    await page.goto(new URL(`/tests/fixtures/connected-agent.html?dock=1&strict=1&setupStatus=${status}`, base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    assert.equal(await count('inspect'), 0)
  }
  const noEffects = async baseline => {
    const state = await snapshot()
    assert.deepEqual(state.authored, baseline); assert.deepEqual(state.forbiddenCalls, []); assert.equal(state.requests.length, 0)
    for (const method of ['codexLogin', 'openExternalUrl', 'send', 'setFullAccess', 'spending.setPolicy', 'mobile.enable', 'mobile.disable', 'mobile.decideNative', 'toolSetup.open', 'setupHelper.send']) assert.equal(await count(method), 0, `${method} must not run`)
    assert.equal(state.fullAccessGrant, null)
    assert.equal(state.spendingPolicy, 'local-only')
  }
  try {
    await fresh(); const baseline = (await snapshot()).authored
    await button('Assistant').click(); await choice().waitFor()
    assert.equal(await count('inspect'), 0)
    for (const name of ['Choose Velo', 'Choose Codex', 'Choose LM Studio', 'Not now']) await button(name).waitFor()
    assert.doesNotMatch(await choice().innerText(), /missing|not found|Codex is installed|reconnect/i)
    assert.equal(await composer().isVisible(), false)
    assert.equal(await button('Connect Codex').isVisible(), false, 'No default-Codex prompt before choosing')
    await noEffects(baseline)
    await page.screenshot({ path: path.join(output, 'assistant-first-choice.png'), fullPage: true })
    await choice().screenshot({ path: path.join(output, 'assistant-first-choice-card.png') })
    groups.push('Fresh opening offers all four choices, without a default-Codex prompt or provider probe')

    await button('Not now').click(); await choice().waitFor({ state: 'hidden' })
    await composer().fill('Keep this unsent draft.')
    assert.equal(await page.getByLabel('Current assistant permissions', { exact: true }).isVisible(), true)
    assert.equal(await page.locator('.ca-spending-badge').isVisible(), true)
    await button('Assistant').click(); await button('Assistant').click(); await composer().waitFor()
    assert.equal(await composer().inputValue(), 'Keep this unsent draft.'); assert.equal(await choice().count(), 0)
    assert.equal(await count('inspect'), 0); await noEffects(baseline)
    const skippedStorage = (await snapshot()).storage
    assert.deepEqual(JSON.parse(skippedStorage[intentKey]), { acknowledged: true })
    assert.equal((await snapshot()).storage[settingsKey], undefined)
    groups.push('Not now never saves a provider; stays dismissed on reopen and preserves later drafts')

    await fresh('terminated', skippedStorage); await button('Assistant').click(); await composer().waitFor()
    assert.equal(await choice().count(), 0); assert.equal(await count('inspect'), 0)
    await button('Assistant settings').click(); await page.locator('.ca-setup-help > summary').click(); await button('Setup helper').waitFor()
    assert.equal(await button('Back to chat').isVisible(), true)
    groups.push('Skip survives a fresh renderer; manual settings and Setup helper remain available')

    for (const available of [true, false]) {
      await fresh('ready'); await button('Assistant').click(); await choice().waitFor()
      await call('setLunaInspectResult', [{ success: true, provider: 'luna', available, eligible: available, status: available ? 'eligible' : 'not-eligible', models: [] }])
      await button('Choose Velo').click()
      await page.getByLabel('Selected assistant', { exact: true }).waitFor()
      await page.waitForFunction(() => window.connectedAgentTest.snapshot().calls.some(c => c.method === 'inspect' && c.options.provider === 'luna'))
      if (available) await page.getByText('Velo ready', { exact: true }).waitFor()
      else {
        await button('Sign in to Velorn').waitFor()
        assert.equal(await button('Send message').isDisabled(), true)
      }
      assert.equal(JSON.parse((await snapshot()).storage[settingsKey]).provider, 'luna')
      assert.equal(await choice().count(), 0); await noEffects(baseline)
      assert.equal((await snapshot()).fullAccessGrant, null)
      const savedVelo = (await snapshot()).storage
      await fresh('ready', savedVelo); await button('Assistant').click(); await page.getByLabel('Selected assistant', { exact: true }).waitFor()
      assert.equal(await choice().count(), 0)
    }
    groups.push('Velo selection persists; available/signed-out paths check status only, with no authentication or sends')

    await fresh('ready'); await button('Assistant').click(); await button('Choose LM Studio').click()
    await page.getByRole('region', { name: 'LM Studio setup', exact: true }).waitFor()
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().calls.some(c => c.method === 'inspect' && c.options.provider === 'lmstudio'))
    await page.getByLabel('LM Studio model', { exact: true }).locator('option[value="fixture-model"]').waitFor({ state: 'attached' })
    assert.equal(await page.getByLabel('LM Studio model', { exact: true }).inputValue(), '')
    assert.equal(await button('Use model').isDisabled(), true)
    assert.equal(await page.getByRole('dialog', { name: 'Optional tools', exact: true }).count(), 0)
    assert.equal(JSON.parse((await snapshot()).storage[settingsKey]).lmstudioModel, undefined)
    assert.equal(JSON.parse((await snapshot()).storage[settingsKey]).provider, 'lmstudio')
    await noEffects(baseline)
    const pickedLocal = (await snapshot()).storage
    await fresh('ready', pickedLocal); await button('Assistant').click(); await composer().waitFor()
    assert.equal(await choice().count(), 0); assert.equal(await count('inspect'), 0)
    assert.equal((await snapshot()).storage[settingsKey], pickedLocal[settingsKey])
    groups.push('LM Studio opens one direct setup panel without silently choosing or loading the first model')

    await fresh('login-required'); await button('Assistant').click(); await button('Choose Codex').click()
    await button('Sign in with ChatGPT').waitFor(); assert.equal(await count('inspect'), 1)
    assert.equal(await count('codexLogin'), 0)
    assert.equal(JSON.parse((await snapshot()).storage[settingsKey]).provider, 'codex')
    assert.equal(await page.getByRole('region', { name: 'Codex setup', exact: true }).count(), 1)
    assert.equal(await guide().count(), 0)
    assert.equal(await button('Get setup help').count(), 0)
    assert.equal(await page.getByRole('dialog', { name: 'Optional tools', exact: true }).count(), 0)
    assert.doesNotMatch(await page.getByRole('region', { name: 'Codex setup', exact: true }).innerText(), /Choose LM Studio|Fully quit and reopen/)
    await button('Not now').click(); await composer().waitFor()
    await button('Set up Codex').click(); await button('Sign in with ChatGPT').waitFor()
    assert.equal(await page.getByRole('region', { name: 'Codex setup', exact: true }).count(), 1)
    assert.equal(await count('setupHelper.status'), 0)
    assert.equal((await snapshot()).calls.filter(c=>c.method==='codexExecutable'&&c.action!=='status').length,0)
    await noEffects(baseline)
    groups.push('Codex uses one direct setup panel, no generic tools detour or LM Studio instructions, without sign-in or executable mutation')

    const savedCodex = { [settingsKey]: JSON.stringify({ provider: 'codex', codexModel: '' }) }
    await fresh('terminated', savedCodex); await button('Assistant').click(); await composer().waitFor()
    assert.equal(await guide().count(), 0); assert.equal(await count('inspect'), 0)
    await button('Assistant').click(); await button('Assistant').click(); assert.equal(await count('inspect'), 0)
    assert.equal((await snapshot()).storage[settingsKey], savedCodex[settingsKey])
    groups.push('Existing Codex choice stays quiet when stopped; opening chat never checks or changes settings')

    const savedLocal = { [settingsKey]: JSON.stringify({ provider: 'lmstudio', lmstudioModel: 'selected-local' }) }
    await fresh('ready', savedLocal); await call('setConnectionError', ['Synthetic stopped server', 'CONNECTION_FAILED'])
    await button('Assistant').click(); await composer().waitFor()
    assert.equal(await guide().count(), 0); assert.equal(await count('inspect'), 0)
    assert.equal((await snapshot()).storage[settingsKey], savedLocal[settingsKey])
    groups.push('A selected but intentionally stopped local model causes no automatic warning or probe')

    await button('Assistant settings').click(); await page.getByRole('region', { name: 'Assistant settings', exact: true }).getByText('Synthetic stopped server', { exact: true }).first().waitFor()
    assert.equal(await count('inspect'), 1); await button('Back to chat').click(); await guide().waitFor()
    assert.match(await guide().innerText(), /LM Studio could not be reached/)
    assert.equal((await snapshot()).storage[settingsKey], savedLocal[settingsKey]); await button('Not now').click()
    await button('Assistant').click(); await button('Assistant').click(); assert.equal(await guide().count(), 0); assert.equal(await count('inspect'), 1)
    groups.push('Explicit local check failure offers help without choosing/loading a model or rechecking on reopen')

    await fresh('ready', savedLocal); await call('setLocalModels', [[{ id: 'selected-local', loaded: true }], 'available'])
    await button('Assistant').click(); await button('Assistant settings').click(); await button('Back to chat').waitFor()
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().calls.some(call => call.method === 'inspect'))
    await page.getByRole('region', { name: 'Assistant settings', exact: true }).getByText('Deterministic fixture provider ready', { exact: true }).first().waitFor()
    await button('Back to chat').click(); assert.equal(await guide().count(), 0)
    assert.equal((await snapshot()).storage[settingsKey], savedLocal[settingsKey])
    groups.push('Explicit successful check preserves the selected local model and returns to ordinary chat')

    viewport = { width: 800, height: 670 }; await fresh(); await button('Assistant').click(); await choice().waitFor()
    for (const name of ['Choose Velo', 'Choose Codex', 'Choose LM Studio', 'Not now']) {
      await button(name).scrollIntoViewIfNeeded()
      assert.equal(await button(name).evaluate(node => {
        const bounds = node.closest('.ca-messages').getBoundingClientRect(), rect = node.getBoundingClientRect()
        // Browser scrolling rounds to pixels; allow subpixel layout rounding.
        return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1 && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
      }), true)
    }
    await button('Choose Velo').scrollIntoViewIfNeeded()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: path.join(output, 'agent-first-entry-narrow.png'), fullPage: true })
    await button('Choose Velo').focus()
    for (const name of ['Choose Codex', 'Choose LM Studio', 'Not now']) {
      await page.keyboard.press('Tab')
      assert.equal(await button(name).evaluate(node => node === document.activeElement), true)
    }
    await page.keyboard.press('Enter'); await choice().waitFor({ state: 'hidden' })
    await noEffects(baseline)
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    groups.push('Narrow entry keeps every choice reachable by scroll/keyboard without horizontal overflow, external network or provider calls')
    console.log(JSON.stringify({ success: true, groups: groups.length, results: groups, output }, null, 2))
  } catch (error) {
    await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    console.error({ output, groups, errors, blocked }); throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
