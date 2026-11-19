'use strict'
// Real picker/chat renderer; isolated RAM settings/history and synthetic IPC.
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = process.env.VELORN_TEST_URL || 'http://127.0.0.1:5209'
if (new URL(base).hostname !== '127.0.0.1') throw Error('Loopback fixture only')
;(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } }), errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin
      ? route.continue() : route.abort())
    await page.routeWebSocket(() => true, socket => socket.close())
    const button = name => page.getByRole('button', { name, exact: true })
    const thinking = () => page.getByRole('combobox', { name: 'Thinking level', exact: true })
    const composer = () => page.getByRole('textbox', { name: 'Message your agent', exact: true })
    const chat = () => page.getByRole('combobox', { name: 'Conversation', exact: true })
    const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
    const openPicker = async () => {
      if (await button('Assistant settings').getAttribute('aria-expanded') !== 'true') await button('Assistant settings').click()
      if (!await page.locator('.ca-more-options').evaluate(node => node.open)) await page.locator('.ca-more-options > summary').click()
      if (!await page.locator('.ca-thinking-options').evaluate(node => node.open)) await page.locator('.ca-thinking-options > summary').click()
      await page.waitForFunction(() => !document.querySelector('[aria-label="Thinking level"]')?.disabled)
    }
    const assertBackInChat = async draft => {
      await thinking().waitFor({ state: 'hidden' })
      assert.equal(await button('Assistant settings').getAttribute('aria-expanded'), 'false')
      assert.equal(await button('Back to chat').count(), 0)
      assert.equal(await composer().inputValue(), draft, 'Changing effort must preserve the unsent draft')
      await page.waitForFunction(() => document.activeElement === document.querySelector('[aria-label="Message your agent"]'))
    }
    const send = async expected => {
      const count = (await snapshot()).requests.length
      await composer().fill('Synthetic read-only request')
      await button('Send message').click()
      await page.waitForFunction(n => window.connectedAgentTest.snapshot().requests.length > n, count)
      const request = (await snapshot()).requests.at(-1)
      assert.equal(request.model, 'fixture-luna'); assert.equal(request.reasoningEffort, expected)
      assert.equal(await button(/^(?:Change assistant or model|Connect Codex)$/).isDisabled(), true)
      await page.evaluate(id => window.connectedAgentTest.settle(id, { success: true, text: 'Synthetic response.' }), request.requestId)
      await button('Stop response').waitFor({ state: 'hidden' })
    }
    await page.goto(`${base}/tests/fixtures/connected-agent.html?strict=1`)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    await page.evaluate(() => window.connectedAgentTest.setCodexModels([
      { id: 'fixture-luna', displayName: 'Fixture Luna', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low', 'medium', 'max'].map(reasoningEffort => ({ reasoningEffort })) },
      { id: 'fixture-sol', displayName: 'Fixture Sol', supportedReasoningEfforts: ['low', 'medium', 'max'].map(reasoningEffort => ({ reasoningEffort })) },
    ]))
    const baseline = (await snapshot()).authored
    await openPicker()
    await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('fixture-luna')
    await openPicker(); await thinking().selectOption('low')
    await assertBackInChat('')
    const id = await chat().inputValue(), chats = await chat().locator('option').count()
    await send('low')
    await composer().fill('Keep this unsent draft while changing to Max.')
    await openPicker(); await thinking().selectOption('max')
    await assertBackInChat('Keep this unsent draft while changing to Max.')
    assert.equal(await chat().inputValue(), id)
    assert.equal(await chat().locator('option').count(), chats)
    assert.match(await page.locator('.ca-selected-model').innerText(), /fixture-luna · Max/)
    assert.match(await page.locator('.ca-requested-model').last().innerText(), /Thinking: Light/)
    // A remount before sending must not restore the old per-chat Light value.
    await button('Close assistant panel').click(); await button('Open agent').click()
    await openPicker()
    assert.equal(await thinking().inputValue(), 'max', 'Same-model effort must survive panel remount before another message')
    await button('Back to chat').click(); await send('max')
    // The same control in Assistant settings must also return to the current chat.
    await composer().fill('Keep this draft when leaving Assistant settings.')
    await openPicker(); await thinking().selectOption('low')
    await assertBackInChat('Keep this draft when leaving Assistant settings.')
    assert.match(await page.locator('.ca-selected-model').innerText(), /fixture-luna · Light/)
    await send('low')
    assert.equal(await chat().inputValue(), id)
    assert.equal(await chat().locator('option').count(), chats)
    assert.deepEqual((await snapshot()).authored, baseline)
    assert.deepEqual(errors, [])
    console.log('PASS: Luna Light → Max → Light closes both pickers, preserves draft and composer focus, same chat/model, remount persistence, exact sent effort, historical labels, busy state, zero project edits.')
  } finally { await browser.close() }
})().catch(e => { console.error(e); process.exitCode = 1 })
