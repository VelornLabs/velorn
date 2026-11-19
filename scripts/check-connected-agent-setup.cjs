// First-run Codex setup through the real renderer with RAM-only fixtures.
// No installer, CLI, browser authentication, provider or project IO is run.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Loopback fixture only')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-agent-setup-'))

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', serviceWorkers: 'block' })
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
  const setup = () => page.getByRole('region', { name: 'Codex setup', exact: true })
  const model = () => page.getByRole('combobox', { name: 'Model', exact: true })
  // Setup temporarily hides the composer; preservation checks inspect its
  // unchanged DOM value without making the input visible or sending anything.
  const composer = () => page.locator('textarea[aria-label="Message your agent"]')
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const callCount = async (method, action) => (await snapshot()).calls.filter(call => call.method === method && (!action || call.action === action)).length
  const status = value => page.evaluate(value => window.connectedAgentTest.setCodexSetupStatus(value), value)
  const login = () => button('Sign in with ChatGPT')
  const cancel = () => button('Cancel sign-in')
  const actionFullyVisible = async action => {
    const bounds = await action.evaluate(node => {
      const box = node.getBoundingClientRect()
      const clippedBy = []
      const scrollingBounds = []
      if (box.width <= 0 || box.height <= 0 || box.top < -1 || box.left < -1 || box.bottom > window.innerHeight + 1 || box.right > window.innerWidth + 1) clippedBy.push('viewport')
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), rect = parent.getBoundingClientRect()
        const top = rect.top + parent.clientTop, left = rect.left + parent.clientLeft
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) scrollingBounds.push({ name: parent.className, top, bottom: top + parent.clientHeight, scrollTop: parent.scrollTop })
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (box.top < top - 1 || box.bottom > top + parent.clientHeight + 1)) clippedBy.push(`${parent.className}:vertical`)
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (box.left < left - 1 || box.right > left + parent.clientWidth + 1)) clippedBy.push(`${parent.className}:horizontal`)
      }
      return { text: node.textContent, clippedBy, buttonTop: box.top, buttonBottom: box.bottom, scrollingBounds }
    })
    if (bounds.clippedBy.length) await page.screenshot({ path: path.join(output, 'clipped-recovery-action.png'), fullPage: true })
    assert.deepEqual(bounds.clippedBy, [], `${bounds.text} must be fully visible before Playwright can auto-scroll it: ${JSON.stringify(bounds)}`)
  }
  const activeError = () => page.locator('.ca-error')
  const chats = () => page.getByRole('combobox', { name: 'Conversation', exact: true })
  const pendingLogin = async action => {
    await page.waitForFunction(action => window.connectedAgentTest.snapshot().pendingCodexLogins.some(item => item.action === action), action)
    return (await snapshot()).pendingCodexLogins.find(item => item.action === action).loginId
  }
  const checkAgain = async () => {
    if (!await setup().getByRole('button', { name: 'Check again', exact: true }).first().isVisible()) await setup().getByText('Troubleshooting', { exact: true }).click()
    await setup().getByRole('button', { name: 'Check again', exact: true }).first().click()
    await page.waitForFunction(() => !document.querySelector('.ca-codex-setup')?.textContent.includes('Checking Codex…'))
  }
  const refresh = async () => {
    if (await setup().isVisible()) { await checkAgain(); return }
    await button('Check connection').click()
    await page.waitForFunction(() => {
      const check = [...document.querySelectorAll('button')].find(node => node.textContent === 'Check connection')
      return check && !check.disabled
    })
    await frame()
    if (!await setup().isVisible() && await button('Set up Codex').first().isVisible()) await button('Set up Codex').first().click()
  }
  const openSettings = async () => {
    if (await button('Assistant settings').getAttribute('aria-expanded') !== 'true') await button('Assistant settings').click()
  }
  const back = async () => { if (await button('Back to chat').isVisible()) await button('Back to chat').click() }
  const openModels = async () => {
    if (!await model().isVisible()) await button('Change assistant or model').click()
    await model().waitFor()
  }
  const fresh = async initial => {
    await page.goto(new URL(`/tests/fixtures/connected-agent.html?strict=1&setupStatus=${encodeURIComponent(initial || 'ready')}`, base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    await button('Choose Codex').waitFor()
    assert.equal(await callCount('inspect'), 0, 'Opening Agent alone must not probe the default provider')
    await button('Choose Codex').click()
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().calls.some(call => call.method === 'inspect')
      && !document.querySelector('.ca-codex-setup')?.textContent.includes('Checking Codex…'))
    if (!initial || initial === 'ready') await composer().waitFor()
  }
  const startSend = async () => {
    const before = (await snapshot()).requests.length
    await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, before)
    return (await snapshot()).requests.at(-1)
  }
  const settle = async (request, result, reject = false) => {
    await page.evaluate(({ requestId, result, reject }) => window.connectedAgentTest[reject ? 'rejectSend' : 'settle'](requestId, result), { requestId: request.requestId, result, reject })
    await page.locator('.ca-assistant[aria-busy="true"]').waitFor({ state: 'hidden' })
    await frame()
  }
  const attachRecoveryFiles = async () => {
    await page.getByLabel('Attach files', { exact: true }).setInputFiles([
      { name: 'signin-recovery.json', mimeType: 'application/json', buffer: Buffer.from('{"fixture":"PRIVATE_RECOVERY_JSON_9287"}') },
      { name: 'signin-recovery.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQWQAAAAASUVORK5CYII=', 'base64') },
    ])
    await button('Remove attachment signin-recovery.json').waitFor()
    await button('Remove attachment signin-recovery.png').waitFor()
  }
  const preservedRecoveryInput = async ({ draft, chatId, requestedModel, requestCount }) => {
    assert.equal(await composer().inputValue(), draft)
    assert.equal(await chats().inputValue(), chatId)
    assert.equal(await page.locator('[aria-label="Remove attachment signin-recovery.json"]').count(), 1)
    assert.equal(await page.locator('[aria-label="Remove attachment signin-recovery.png"]').count(), 1)
    assert.equal(await page.locator('img[alt="Attachment: signin-recovery.png"]').count(), 1)
    const state = await snapshot()
    assert.equal(state.requests.length, requestCount, 'setup and sign-in must never replay the failed message')
    assert.equal(state.requests.at(-1).model, requestedModel)
    assert.ok(!JSON.stringify(state.storage).includes('PRIVATE_RECOVERY_JSON_9287'), 'attachment contents stay in RAM, not saved chat history')
    assert.equal(state.fullAccessGrant, null)
    assert.deepEqual(state.forbiddenCalls, [])
  }
  const noSideEffects = async baseline => {
    const state = await snapshot()
    assert.deepEqual(state.authored, baseline)
    assert.deepEqual(state.forbiddenCalls, [])
    assert.equal(state.requests.length, 0)
  }
  let groups = 0
  const pass = label => console.log(`PASS ${++groups}: ${label}`)
  try {
    await fresh('missing')
    const baseline = (await snapshot()).authored
    assert.equal(await setup().isVisible(), true)
    assert.equal(await callCount('inspect'), 1)
    assert.equal(await callCount('codexLogin'), 0)
    assert.equal(await callCount('openExternalUrl'), 0)
    await button('Not now').click(); await composer().fill('Keep my first-run draft.'); await button('Set up Codex').click()
    await setup().waitFor()
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().calls.some(call => call.method === 'inspect'))
    await frame()
    assert.equal(await model().count(), 0)
    assert.equal(await page.getByRole('combobox', { name: 'Thinking level', exact: true }).count(), 0)
    assert.equal(await button('Open installation guide').isVisible(), true)
    assert.equal(await callCount('codexLogin'), 0)
    await button('Open installation guide').click()
    assert.deepEqual((await snapshot()).calls.filter(call => call.method === 'openExternalUrl').map(call => call.url), ['https://learn.chatgpt.com/docs/codex/cli'])
    assert.equal(await callCount('codexLogin'), 0)
    await button('Not now').click(); await button('Send message').click()
    assert.equal((await snapshot()).requests.length, 0, 'a known-blocked connection cannot send a model request')
    assert.equal(await composer().inputValue(), 'Keep my first-run draft.')
    await noSideEffects(baseline)
    if (!await setup().isVisible()) await button('Set up Codex').first().click()
    await page.screenshot({ path: path.join(output, '01-missing-codex.png'), fullPage: true })
    pass('First-run Connect Codex exposes guided recovery, hides unusable models and opens only the fixed installation guide after an explicit click')

    await status('ready')
    await checkAgain(); await openModels()
    assert.equal(await page.getByRole('alert').filter({ hasText: 'Connect Codex before sending. Your draft is saved here.' }).count(), 0)
    await model().selectOption('fixture-codex-fast')
    await openSettings()
    await model().waitFor()
    await status('missing'); await refresh()
    assert.equal(await model().count(), 0)
    await status('ready'); await checkAgain(); await openModels()
    assert.equal(await model().inputValue(), 'fixture-codex-fast')
    await back()
    assert.equal(await composer().inputValue(), 'Keep my first-run draft.')
    assert.equal(await callCount('codexLogin'), 0)
    assert.equal(await callCount('codexExecutable', 'auto'), 0, 'Read-only checks never change executable selection or revoke access')
    pass('Explicit detection recovers the model catalog and preserves selected model/draft across later missing-installation checks')

    await openSettings(); await status('terminated'); await refresh()
    await setup().waitFor()
    assert.match(await setup().innerText(), /terminated|stopped|launch/i)
    assert.doesNotMatch(await setup().innerText(), /signature invalid|code signature/i)
    assert.equal(await model().count(), 0)
    assert.equal(await callCount('codexLogin'), 0)
    await page.screenshot({ path: path.join(output, '02-codex-terminated.png'), fullPage: true })
    pass('OS-terminated runtime is shown as a launch problem without claiming a signing diagnosis or exposing model configuration')

    await status('ready'); await refresh(); await openSettings()
    await page.evaluate(() => window.connectedAgentTest.setFullAccessResponse({ success: true, enabled: true,
      token: 'fixture-before-codex-login', remembered: true, shareImagesAndView: true }))
    await button('Full access').click()
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().fullAccessGrant !== null)
    await status('login-required'); await refresh()
    assert.equal(await login().isVisible(), true)
    assert.equal(await callCount('codexLogin'), 0)
    await login().click()
    const firstLogin = await pendingLogin('start')
    await cancel().waitFor()
    assert.match(await setup().innerText(), /Finish signing in in your browser/)
    assert.equal((await snapshot()).fullAccessGrant, null)
    assert.equal((await snapshot()).fullAccessRemembered, false)
    assert.equal(await page.locator('.ca-full-access-badge').count(), 0)
    assert.equal(await button('Find installed Codex').count(), 0)
    assert.equal(await button('Assistant settings').isDisabled(), true)
    assert.equal(await page.locator('[aria-label="Send message"]').isDisabled(), true)
    assert.equal(await page.getByRole('combobox', { name: 'Conversation', exact: true }).isDisabled(), true)
    await page.evaluate(id => window.connectedAgentTest.releaseCodexLogin(id), firstLogin)
    await cancel().waitFor({ state: 'hidden' })
    await openModels()
    assert.equal(await model().inputValue(), 'fixture-codex-fast')
    assert.equal((await snapshot()).fullAccessGrant, null, 'sign-in never restores full computer authority')
    assert.equal((await snapshot()).fullAccessRemembered, false)
    assert.equal(await callCount('codexLogin', 'start'), 1)
    pass('Sign-in begins only on request, revokes remembered Full access, blocks conflicting setup, refreshes models on completion and does not restore authority')

    await openSettings(); await status('login-required'); await refresh(); await login().click()
    await pendingLogin('start')
    await page.evaluate(() => window.connectedAgentTest.setHoldCodexLogin('cancel', true))
    await cancel().click()
    const cancelId = await pendingLogin('cancel')
    assert.equal(await button('Find installed Codex').count(), 0)
    await page.evaluate(id => {
      window.connectedAgentTest.releaseCodexLogin(id)
      window.connectedAgentTest.setHoldCodexLogin('cancel', false)
    }, cancelId)
    await cancel().waitFor({ state: 'hidden' })
    assert.equal(await login().isVisible(), true)
    assert.equal(await model().count(), 0)
    assert.equal((await snapshot()).pendingCodexLogins.length, 0)
    pass('Cancel sign-in waits for native cleanup and returns to the signed-out setup without a false connected state')

    await page.evaluate(() => window.connectedAgentTest.setCodexLoginResponse('start', { success: false, code: 'CODEX_LOGIN_FAILED', error: 'Synthetic sign-in did not complete.' }))
    await login().click(); const failedId = await pendingLogin('start')
    await page.evaluate(id => window.connectedAgentTest.releaseCodexLogin(id), failedId)
    await cancel().waitFor({ state: 'hidden' })
    await setup().getByRole('alert').filter({ hasText: 'Synthetic sign-in did not complete.' }).waitFor()
    assert.equal(await login().isEnabled(), true)
    assert.equal(await model().count(), 0)
    await page.evaluate(() => window.connectedAgentTest.setCodexLoginResponse('start', null))
    pass('Explicit sign-in errors stay actionable and retryable without exposing unusable models')

    for (const lateResult of [{ success: false, error: 'STALE_LOGIN_ERROR_MUST_NOT_APPEAR' }, { success: true }]) {
      await login().click(); const abandonedId = await pendingLogin('start')
      await page.evaluate(() => window.connectedAgentTest.setHoldCodexLogin('cancel', true))
      const beforeUnmountCancels = await callCount('codexLogin', 'cancel')
      await button('Close assistant panel').click()
      await page.waitForFunction(count => window.connectedAgentTest.snapshot().calls.filter(call => call.method === 'codexLogin' && call.action === 'cancel').length > count, beforeUnmountCancels)
      const abandonedCancel = await pendingLogin('cancel')
      await button('Open agent').click(); await openSettings(); await button('Set up Codex').first().click(); await setup().waitFor(); await login().waitFor()
      // Only opening settings requests a catalog refresh. Settle that explicit
      // request before testing late login output; plain panel entry stays passive.
      await frame()
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(node => node.textContent === 'Sign in with ChatGPT' && !node.disabled))
      await frame()
      const currentInspections = await callCount('inspect')
      await page.evaluate(({ id, result }) => window.connectedAgentTest.releaseCodexLogin(id, result), { id: abandonedId, result: lateResult })
      await page.evaluate(id => { window.connectedAgentTest.releaseCodexLogin(id); window.connectedAgentTest.setHoldCodexLogin('cancel', false) }, abandonedCancel)
      await frame()
      assert.ok(!(await page.locator('body').innerText()).includes('STALE_LOGIN_ERROR_MUST_NOT_APPEAR'))
      assert.equal(await callCount('inspect'), currentInspections, 'abandoned success cannot refresh the new panel')
      assert.equal(await model().count(), 0)
      assert.equal((await snapshot()).fullAccessGrant, null)
    }
    pass('Unmount cancels login and ignores late success and failure after the panel is reopened')

    for (const width of [900, 760]) {
      await page.setViewportSize({ width, height: 700 })
      await setup().scrollIntoViewIfNeeded()
      const size = await setup().evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }))
      assert.ok(size.scroll <= size.client + 1)
      await page.screenshot({ path: path.join(output, `setup-${width}px.png`), fullPage: true })
    }
    await noSideEffects(baseline)
    await page.setViewportSize({ width: 1440, height: 1000 })

    // Exercise the actual send result, not a settings-only connection check.
    // No native account process is run: the RAM fixture supplies each result.
    for (const initial of ['entry-ready', 'stale-ready', 'rejected-send']) {
      await fresh()
      const recoveryBaseline = (await snapshot()).authored
      if (initial === 'stale-ready') {
        await openSettings(); await model().waitFor()
        await model().selectOption('fixture-codex-fast'); await back()
        await openSettings()
        await page.evaluate(() => window.connectedAgentTest.setFullAccessResponse({ success: true, enabled: true,
          token: 'fixture-expiring-codex-session', remembered: true, shareImagesAndView: false }))
        await button('Full access').click()
        await page.waitForFunction(() => window.connectedAgentTest.snapshot().fullAccessGrant !== null)
        await back()
      } else assert.equal(await callCount('inspect'), 1)
      const draft = `  Preserve ${initial} sign-in recovery draft.\nKeep my references attached.  `
      const chatId = await chats().inputValue()
      const requestedModel = initial === 'stale-ready' ? 'fixture-codex-fast' : ''
      const authCode = initial === 'stale-ready' ? 'CODEX_CHATGPT_REQUIRED' : 'CODEX_LOGIN_REQUIRED'
      const setupStatus = initial === 'stale-ready' ? 'chatgpt-required' : 'login-required'
      await composer().fill(draft); await attachRecoveryFiles()
      await status(setupStatus)
      const request = await startSend()
      assert.equal(request.model, requestedModel)
      assert.equal(request.fullAccess, initial === 'stale-ready')
      assert.equal(request.documents[0].text, '{"fixture":"PRIVATE_RECOVERY_JSON_9287"}')
      assert.equal(request.images.length, 1)
      await settle(request, { success: false, code: authCode, promptNotSent: true,
        toolReceipts: { version: 1, entries: [], omitted: 0 },
        error: 'Synthetic Codex sign-in is required before this request can start.' }, initial === 'rejected-send')
      await setup().waitFor(); await login().waitFor()
      await actionFullyVisible(login())
      assert.equal(await model().count(), 0)
      assert.equal(await callCount('codexLogin'), 0, 'a failed send cannot start browser sign-in automatically')
      assert.equal(await callCount('openExternalUrl'), 0)
      assert.match(await activeError().innerText(), /sign.in|ChatGPT/i)
      const input = { draft, chatId, requestedModel, requestCount: 1 }
      await preservedRecoveryInput(input)
      assert.equal((await snapshot()).fullAccessRemembered, false)
      await page.screenshot({ path: path.join(output, `send-${initial}-signin-recovery.png`), fullPage: true })
      if (initial === 'entry-ready' || initial === 'stale-ready') {
        await page.setViewportSize({ width: 760, height: 700 }); await frame()
        await actionFullyVisible(login())
        await page.screenshot({ path: path.join(output, `send-${initial}-signin-recovery-760px.png`), fullPage: true })
        await page.setViewportSize({ width: 1440, height: 1000 }); await frame()
      }
      pass(`${initial} send authentication failure opens sign-in setup and restores the exact draft, attachments, model and chat without login or replay`)

      if (initial === 'entry-ready') {
        // A native CLI exit is not account verification. Keep the old active
        // auth error until the normal read-only inspection proves readiness.
        await page.evaluate(() => window.connectedAgentTest.setHoldInspect(true))
        await login().click(); const unverifiedLogin = await pendingLogin('start')
        await actionFullyVisible(cancel())
        await page.setViewportSize({ width: 760, height: 700 }); await frame()
        await actionFullyVisible(cancel())
        await page.screenshot({ path: path.join(output, 'send-signin-pending-760px.png'), fullPage: true })
        await page.setViewportSize({ width: 1440, height: 1000 }); await frame()
        await page.evaluate(id => window.connectedAgentTest.releaseCodexLogin(id), unverifiedLogin)
        await page.waitForFunction(() => window.connectedAgentTest.snapshot().pendingInspects.length === 1)
        assert.match(await activeError().innerText(), /sign.in|ChatGPT/i)
        await preservedRecoveryInput(input)
        const inspectionId = (await snapshot()).pendingInspects[0].inspectId
        await page.evaluate(id => {
          window.connectedAgentTest.setCodexSetupStatus('login-required')
          window.connectedAgentTest.releaseInspect(id, { success: true, available: false, installed: true, signedIn: false,
            code: 'CODEX_LOGIN_REQUIRED', models: [], modelCatalogStatus: 'not-requested', message: 'Synthetic account verification still requires sign-in.' })
          window.connectedAgentTest.setHoldInspect(false)
        }, inspectionId)
        await cancel().waitFor({ state: 'hidden' }); await login().waitFor()
        assert.equal(await model().count(), 0)
        assert.match(await activeError().innerText(), /sign.in|ChatGPT/i)
        await preservedRecoveryInput(input)

        await login().click(); await pendingLogin('start'); await cancel().click()
        await cancel().waitFor({ state: 'hidden' }); await login().waitFor()
        assert.equal(await login().isEnabled(), true)
        assert.match(await setup().innerText(), /cancelled/i)
        await preservedRecoveryInput(input)
        pass('Unverified sign-in success and explicit cancellation leave recovery actionable with original input intact and no automatic resend')
      }

      await login().click(); const verifiedLogin = await pendingLogin('start')
      await actionFullyVisible(cancel())
      await page.evaluate(id => window.connectedAgentTest.releaseCodexLogin(id), verifiedLogin)
      await cancel().waitFor({ state: 'hidden' }); await openModels()
      assert.equal(await model().inputValue(), requestedModel)
      assert.equal(await activeError().count(), 0, 'verified readiness clears the stale active authentication error')
      await preservedRecoveryInput(input)
      assert.deepEqual((await snapshot()).authored, recoveryBaseline)
      await button(/^(?:Change assistant|Change assistant or model)$/).click()
      const explicitRetry = await startSend()
      assert.equal(explicitRetry.model, requestedModel)
      assert.deepEqual(explicitRetry.documents, request.documents)
      assert.deepEqual(explicitRetry.images, request.images)
      assert.equal(explicitRetry.conversationId, request.conversationId)
      assert.equal(explicitRetry.messages.filter(message => message.role === 'user').length, 1,
        'a pre-turn auth failure must not duplicate the user prompt when explicitly retried')
      await settle(explicitRetry, { success: true, text: 'Synthetic explicit retry succeeded.' })
      assert.equal((await snapshot()).requests.length, 2)
      assert.equal(await composer().inputValue(), '')
      assert.equal(await page.getByLabel('Message attachments', { exact: true }).count(), 0)
      assert.equal(await chats().inputValue(), chatId)
      assert.deepEqual((await snapshot()).authored, recoveryBaseline)
      pass(`${initial} verified recovery clears only the active error; an explicit Send retries once with the original model and attachments`)
    }

    await fresh()
    const newerBaseline = (await snapshot()).authored
    const originalDraft = 'Preserve this unsent original in a receipt if I type something newer.'
    const newerDraft = '  A different newer draft must remain mine.  '
    await composer().fill(originalDraft); await attachRecoveryFiles()
    const originalRequest = await startSend()
    await composer().fill(newerDraft)
    await status('login-required')
    await settle(originalRequest, { success: false, code: 'CODEX_LOGIN_REQUIRED', promptNotSent: true,
      error: 'Synthetic session expired before the original prompt was sent.' })
    await setup().waitFor(); await login().waitFor()
    assert.equal(await composer().inputValue(), newerDraft)
    assert.equal(await page.getByLabel('Message attachments', { exact: true }).count(), 0,
      'old reference images must not silently attach themselves to a different new draft')
    const receipt = await page.locator('.ca-message.ca-assistant').innerText()
    assert.ok(receipt.includes(originalDraft))
    assert.ok(receipt.includes('signin-recovery.json') && receipt.includes('signin-recovery.png'))
    assert.equal(await callCount('codexLogin'), 0)
    await login().click(); const newerLogin = await pendingLogin('start')
    await page.evaluate(id => window.connectedAgentTest.releaseCodexLogin(id), newerLogin)
    await cancel().waitFor({ state: 'hidden' }); await openModels()
    await button(/^(?:Change assistant|Change assistant or model)$/).click()
    await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'newer-selection.json', mimeType: 'application/json',
      buffer: Buffer.from('{"fixture":"NEWER_REFERENCE_ONLY"}') })
    await button('Remove attachment newer-selection.json').waitFor()
    assert.equal(await composer().inputValue(), newerDraft)
    const newerRequest = await startSend()
    assert.deepEqual(newerRequest.documents, [{ name: 'newer-selection.json', text: '{"fixture":"NEWER_REFERENCE_ONLY"}' }])
    assert.deepEqual(newerRequest.images, [])
    assert.equal(newerRequest.messages.filter(message => message.role === 'user').length, 1)
    assert.equal(newerRequest.messages.at(-1).content.includes(originalDraft), false)
    await settle(newerRequest, { success: true, text: 'Synthetic newer draft response.' })
    assert.deepEqual((await snapshot()).authored, newerBaseline)
    assert.deepEqual((await snapshot()).forbiddenCalls, [])
    pass('Typing a newer draft during the failed send preserves that composer pair; original references are not rebound and a new attachment selection sends only when requested')

    await fresh()
    const staleCheckBaseline = (await snapshot()).authored
    await openSettings(); await model().locator('option[value="fixture-codex-fast"]').waitFor({ state: 'attached' })
    await page.evaluate(() => window.connectedAgentTest.setHoldInspect(true))
    await button('Check connection').click()
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().pendingInspects.length === 1)
    const staleInspectionId = (await snapshot()).pendingInspects[0].inspectId
    await back()
    const staleCheckDraft = 'Keep this draft when an old ready inspection arrives.'
    const staleCheckChat = await chats().inputValue()
    await composer().fill(staleCheckDraft); await attachRecoveryFiles()
    await status('login-required')
    const staleCheckRequest = await startSend()
    await settle(staleCheckRequest, { success: false, code: 'CODEX_LOGIN_REQUIRED', promptNotSent: true,
      error: 'Synthetic sign-in needed while an older connection check is pending.' })
    await setup().waitFor(); await login().waitFor()
    await page.evaluate(id => { window.connectedAgentTest.releaseInspect(id); window.connectedAgentTest.setHoldInspect(false) }, staleInspectionId)
    await frame()
    assert.equal(await login().isVisible(), true)
    assert.equal(await model().count(), 0)
    assert.match(await activeError().innerText(), /sign.in|ChatGPT/i)
    assert.equal(await callCount('codexLogin'), 0)
    await preservedRecoveryInput({ draft: staleCheckDraft, chatId: staleCheckChat, requestedModel: '', requestCount: 1 })
    await status('ready'); await refresh(); await openModels()
    assert.equal(await activeError().count(), 0)
    assert.equal((await snapshot()).requests.length, 1)
    assert.deepEqual((await snapshot()).authored, staleCheckBaseline)
    pass('A stale ready inspection cannot erase send authentication recovery; only a new verified check clears its active error')

    await fresh('ready')
    await status('chatgpt-required')
    const ambiguousBaseline = (await snapshot()).authored
    await composer().fill('An ambiguous auth failure must not restore a possibly completed action.')
    await attachRecoveryFiles()
    const ambiguousRequest = await startSend()
    await settle(ambiguousRequest, { success: false, code: 'CODEX_CHATGPT_REQUIRED',
      error: 'Synthetic authentication changed after a prompt may have started.' })
    await setup().waitFor(); await login().waitFor()
    assert.equal(await composer().inputValue(), '')
    assert.equal(await page.getByLabel('Message attachments', { exact: true }).count(), 0)
    assert.equal(await callCount('codexLogin'), 0)
    assert.equal((await snapshot()).requests.length, 1)
    assert.match(await page.locator('.ca-message.ca-assistant').innerText(), /action may already have completed|inspect.*before repeating/i)
    assert.deepEqual((await snapshot()).authored, ambiguousBaseline)
    assert.deepEqual((await snapshot()).forbiddenCalls, [])
    pass('An auth failure without native pre-prompt proof offers sign-in but does not restore or replay potentially completed work')

    await fresh()
    const genericBaseline = (await snapshot()).authored
    await composer().fill('A normal provider failure must not trigger sign-in.')
    const genericRequest = await startSend()
    await settle(genericRequest, { success: false, code: 'MODEL_UNAVAILABLE', promptNotSent: true,
      error: 'Synthetic selected model is unavailable.' })
    assert.equal(await setup().count(), 0)
    assert.equal(await callCount('codexLogin'), 0)
    assert.equal((await snapshot()).requests.length, 1)
    assert.equal(await composer().inputValue(), '', 'ordinary ambiguous provider failures keep the existing no-replay behavior')
    assert.match(await activeError().innerText(), /selected model is unavailable/)
    assert.deepEqual((await snapshot()).authored, genericBaseline)
    assert.deepEqual((await snapshot()).forbiddenCalls, [])
    pass('A non-authentication provider error cannot use a pre-prompt flag to invent sign-in recovery or replay work')

    await fresh('ready')
    await openSettings(); await model().waitFor()
    await model().selectOption('fixture-codex-fast')
    await back(); await composer().fill('Keep my draft while optional tool setup changes.')
    await attachRecoveryFiles()
    const externalChat = await chats().inputValue()
    await openSettings()
    await page.evaluate(() => window.connectedAgentTest.setFullAccessResponse({ success: true, enabled: true,
      token: 'fixture-before-external-setup', remembered: true, shareImagesAndView: true }))
    await button('Full access').click()
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().fullAccessGrant !== null)
    await page.evaluate(() => window.connectedAgentTest.setHoldInspect(true))
    await button('Check connection').click()
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().pendingInspects.length === 1)
    const externalBefore = await snapshot()
    await page.evaluate(() => window.connectedAgentTest.emitEvent({ type: 'codex-setup-changed' }))
    await frame()
    assert.equal(await page.locator('.ca-full-access-badge').count(), 0)
    assert.equal(await model().locator('option[value="fixture-codex-fast"]').count(), 0, 'old catalog must be invalidated')
    assert.match(await page.getByLabel('Custom model ID', { exact: true }).inputValue(), /fixture-codex-fast/)
    await page.evaluate(() => { window.connectedAgentTest.setHoldInspect(false); window.connectedAgentTest.releaseInspect() })
    await frame()
    const externalAfter = await snapshot()
    assert.equal(externalAfter.fullAccessGrant, null)
    assert.equal(externalAfter.fullAccessRemembered, false)
    assert.deepEqual(externalAfter.calls, externalBefore.calls, 'native setup event does not inspect, authenticate or mutate permissions again')
    assert.deepEqual(externalAfter.storage, externalBefore.storage, 'selected provider/model/thinking/chat settings stay unchanged')
    assert.deepEqual(externalAfter.authored, externalBefore.authored)
    assert.equal(await model().locator('option[value="fixture-codex-fast"]').count(), 0, 'late ready inspection cannot restore the old catalog')
    await back()
    assert.equal(await composer().inputValue(), 'Keep my draft while optional tool setup changes.')
    assert.equal(await chats().inputValue(), externalChat)
    assert.equal(await button('Remove attachment signin-recovery.json').count(), 1)
    assert.equal(await button('Remove attachment signin-recovery.png').count(), 1)
    assert.equal(externalAfter.requests.length, 0)
    pass('App-wide Codex setup invalidates stale grants and catalogs without probing, restoring authority or changing the selected model, chat, draft or attachments')

    await fresh('ready'); await openSettings()
    await page.getByLabel('Assistant selection', { exact: true }).selectOption('lmstudio'); if (await page.getByRole('group', { name: 'Confirm assistant switch' }).count()) await page.getByRole('group', { name: 'Confirm assistant switch' }).getByRole('button', { name: /^Start .* chat$/ }).click()
    await openSettings(); await model().waitFor()
    await page.evaluate(() => window.connectedAgentTest.setFullAccessResponse({ success: true, enabled: true,
      token: 'fixture-local-before-codex-setup', remembered: true, shareImagesAndView: true }))
    await button('Full access').click()
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().fullAccessGrant !== null)
    const localBefore = await snapshot()
    const localModel = await model().inputValue()
    await page.evaluate(() => window.connectedAgentTest.emitEvent({ type: 'codex-setup-changed' }))
    await frame()
    const localAfter = await snapshot()
    assert.equal(localAfter.fullAccessGrant, null)
    assert.equal(localAfter.localFullAccessRemembered, true, 'Codex setup must not forget the LM Studio preference')
    assert.equal(await page.locator('.ca-full-access-badge').count(), 0)
    assert.equal(await page.getByLabel('Assistant selection', { exact: true }).inputValue(), 'lmstudio')
    assert.equal(await model().inputValue(), localModel)
    assert.deepEqual(localAfter.calls, localBefore.calls)
    assert.deepEqual(localAfter.storage, localBefore.storage)
    assert.deepEqual(localAfter.authored, localBefore.authored)
    assert.equal(localAfter.requests.length, 0)
    pass('Codex setup clears a mounted local-agent grant without switching provider, clearing its model, forgetting LM Studio preferences or automatically restoring access')

    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    pass('Setup fits compact settings; all scenarios leave the project unchanged and perform no installer, provider or external network operations')
    console.log(`Artifacts: ${output}`)
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
