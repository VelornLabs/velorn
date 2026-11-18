// Model identity UI regression through actual components and RAM-only history.
// Every reply is synthetic: no Codex process, model service or project IO.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Model identity fixture requires loopback HTTP')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-connected-agent-model-identity-'))

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', serviceWorkers: 'block' })
  const page = await context.newPage(), errors = [], blockedRequests = [], groups = []
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    const forbidden = /^\/(?:prompt|queue|interrupt|system_stats|history|upload|view|ws|v1|api)(?:\/|$)/.test(url.pathname)
    if (url.origin === base.origin && !forbidden) return route.continue()
    blockedRequests.push(url.href); return route.abort()
  })
  await page.routeWebSocket(() => true, socket => socket.close())
  const button = name => page.getByRole('button', { name, exact: true })
  const composer = () => page.getByRole('textbox', { name: 'Message your agent', exact: true })
  const chats = () => page.getByRole('combobox', { name: 'Conversation', exact: true })
  const picker = () => page.locator('select[aria-label="Model"]')
  const custom = () => page.getByRole('textbox', { name: 'Custom model ID', exact: true })
  const selected = () => page.locator('.ca-selected-model')
  const running = () => page.locator('.ca-assistant[aria-busy="true"]')
  const reply = text => page.locator('.ca-assistant').filter({ has: page.getByText(text, { exact: true }) })
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const pass = text => { groups.push(text); console.log(`PASS ${groups.length}: ${text}`) }
  const openSettings = async () => {
    if (await button('Assistant settings').getAttribute('aria-expanded') !== 'true') await button('Assistant settings').click()
    // These legacy regressions intentionally exercise the individual controls.
    const advanced = page.locator('summary').filter({ hasText: /^Access options$/ })
    if (!(await advanced.evaluate(node => node.parentElement.open))) await advanced.click()
  }
  const backToChat = async () => { if (await button('Back to chat').isVisible()) await button('Back to chat').click() }
  const setCustom = async value => {
    await openSettings(); await picker().selectOption('__custom__'); await custom().fill(value)
    await button('Use model').click(); await backToChat()
  }
  const send = async text => {
    await backToChat()
    const count = (await snapshot()).requests.length
    await composer().fill(text); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, count)
    return (await snapshot()).requests.at(-1)
  }
  const settle = async (request, text) => {
    await page.evaluate(({ requestId, text }) => window.connectedAgentTest.settle(requestId, { success: true, text }), { requestId: request.requestId, text })
    await frame()
  }
  const finish = async (request, text) => {
    await settle(request, text); await reply(text).waitFor(); await running().waitFor({ state: 'hidden' })
  }
  const reopen = async () => {
    await button('Close assistant panel').click(); await button('Open agent').click(); await composer().waitFor()
  }
  const savedMessages = state => Object.entries(state.storage).filter(([key]) => key.includes('.conversations.v1.'))
    .flatMap(([, value]) => JSON.parse(value).conversations.flatMap(chat => chat.messages))
  try {
    await page.goto(new URL('/tests/fixtures/connected-agent.html?strict=1&legacyChats=1', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    const baseline = (await snapshot()).authored, originalChat = await chats().inputValue()
    assert.equal(await selected().locator('strong').innerText(), 'Connect Codex to choose a model')
    assert.equal(await reply('Legacy Codex reply stays available.').locator('.ca-requested-model').innerText(), 'Model not recorded')
    assert.equal((await snapshot()).requests.length, 0)
    assert.equal((await snapshot()).calls.filter(call => call.method === 'inspect').length, 0)
    pass('Chat shows Connect Codex before discovery; legacy replies stay unknown without metadata discovery or a model turn')

    await page.evaluate(() => window.connectedAgentTest.setCodexModels([
      { id: 'gpt-5.6-luna', displayName: 'Luna', description: 'Synthetic Luna catalog entry.' },
      { id: 'gpt-6-astra', displayName: 'Astra', description: 'Synthetic Astra catalog entry.', isDefault: true },
    ]))
    await composer().fill('Keep this draft while selecting Luna.')
    await openSettings(); await picker().locator('option[value="gpt-5.6-luna"]').waitFor({ state: 'attached' })
    await picker().selectOption('gpt-5.6-luna'); await backToChat()
    assert.equal(await selected().locator('strong').innerText(), 'gpt-5.6-luna · Medium')
    assert.match(await selected().innerText(), /Codex/)
    assert.equal(await composer().inputValue(), 'Keep this draft while selecting Luna.')
    assert.match(await selected().getAttribute('title'), /not server-confirmed execution or billing/)
    await page.screenshot({ path: path.join(output, '01-luna-selected.png'), fullPage: true })
    pass('The selected catalog model is prominent above the composer with its exact Luna ID and provider, preserving the draft')

    await openSettings()
    await page.getByRole('checkbox', { name: 'Share images', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Include current view', exact: true }).check()
    await backToChat()
    await page.evaluate(() => window.connectedAgentTest.setHoldCapture(true))
    const beforeCapture = (await snapshot()).requests.length
    await composer().fill('Discuss this synthetic view using Luna.'); await button('Send message').click()
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().calls.some(call => call.method === 'capture'))
    assert.equal((await snapshot()).requests.length, beforeCapture, 'Model has not been called during held image capture')
    assert.equal(await running().locator('.ca-requested-model').innerText(), 'Requested model: gpt-5.6-luna · Thinking: Medium')
    assert.match(await running().innerText(), /Gathering the current project view/)
    await openSettings()
    assert.equal(await picker().isDisabled(), true)
    await backToChat()
    await page.evaluate(() => { window.connectedAgentTest.setHoldCapture(false); window.connectedAgentTest.releaseCapture() })
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, beforeCapture)
    const luna = (await snapshot()).requests.at(-1)
    assert.equal(luna.model, 'gpt-5.6-luna')
    await page.evaluate(requestId => window.connectedAgentTest.emit(requestId, 'delta', 'Synthetic Luna stream'), luna.requestId)
    await page.getByText('Synthetic Luna stream', { exact: true }).waitFor()
    assert.equal(await running().locator('.ca-requested-model').innerText(), 'Requested model: gpt-5.6-luna · Thinking: Medium')
    await finish(luna, 'Synthetic Luna reply.')
    assert.equal(await reply('Synthetic Luna reply.').locator('.ca-requested-model').innerText(), 'Requested model: gpt-5.6-luna · Thinking: Medium')
    await openSettings(); await page.getByRole('checkbox', { name: 'Share images', exact: true }).uncheck(); await backToChat()
    pass('One frozen Luna request label survives asynchronous image gathering, streaming and saved reply, matching the exact send payload')

    await openSettings(); await picker().selectOption('gpt-6-astra'); await backToChat()
    assert.equal(await selected().locator('strong').innerText(), 'gpt-6-astra · Medium')
    assert.equal(await reply('Synthetic Luna reply.').locator('.ca-requested-model').innerText(), 'Requested model: gpt-5.6-luna · Thinking: Medium')
    assert.equal(await reply('Legacy Codex reply stays available.').locator('.ca-requested-model').innerText(), 'Model not recorded')
    const astra = await send('A synthetic follow-up using a different selection.')
    assert.equal(astra.model, 'gpt-6-astra')
    assert.deepEqual(astra.messages.at(-1), { role: 'user', content: 'A synthetic follow-up using a different selection.' })
    assert.ok(astra.messages.every(message => Object.keys(message).sort().join(',') === 'content,role'), 'Model metadata is never provider content')
    assert.ok(!JSON.stringify(astra.messages).includes('gpt-5.6-luna'), 'Old model labels are not inserted into chat content')
    await finish(astra, 'Synthetic Astra reply.')
    assert.equal(savedMessages(await snapshot()).find(message => message.text === 'Synthetic Luna reply.').requestedModel, 'gpt-5.6-luna')
    assert.equal(savedMessages(await snapshot()).find(message => message.text === 'Synthetic Astra reply.').requestedModel, 'gpt-6-astra')
    pass('Changing selection does not relabel old replies; saved scalar metadata is excluded from every provider message')

    await button('New chat').click(); await frame()
    const defaultChat = await chats().inputValue()
    await openSettings(); await picker().selectOption(''); await backToChat()
    assert.equal(await selected().locator('strong').innerText(), 'Codex default · Medium')
    const defaultRequest = await send('Let Codex choose without claiming an actual model.')
    assert.equal(defaultRequest.model, '')
    assert.equal(await running().locator('.ca-requested-model').innerText(), 'Requested: Codex default (not confirmed) · Thinking: Medium')
    await finish(defaultRequest, 'Synthetic default reply.')
    assert.equal(await reply('Synthetic default reply.').locator('.ca-requested-model').innerText(), 'Requested: Codex default (not confirmed) · Thinking: Medium')
    assert.equal(savedMessages(await snapshot()).find(message => message.text === 'Synthetic default reply.').requestedModel, '')
    assert.ok(!(await page.locator('.ca-chat').innerText()).includes('gpt-6-astra'), 'Advertised catalog default does not become a confirmed/requested model')
    pass('Blank default remains an explicit empty request value and unconfirmed label, never a fabricated catalog model')

    const customId = 'custom-org/saved-model-2026.09-Q4_K_M'
    await setCustom(customId)
    assert.equal(await selected().locator('strong').innerText(), `${customId} · Medium`)
    const unknown = await send('Use an ID absent from the catalog.')
    assert.equal(unknown.model, customId)
    await finish(unknown, 'Synthetic custom reply.')
    assert.equal(await reply('Synthetic custom reply.').locator('.ca-requested-model').innerText(), `Requested model: ${customId} · Thinking: Medium`)
    await reopen()
    assert.equal(await selected().locator('strong').innerText(), `${customId} · Medium`)
    assert.equal(await reply('Synthetic custom reply.').locator('.ca-requested-model').innerText(), `Requested model: ${customId} · Thinking: Medium`)
    pass('Unknown custom IDs retain exact visible and saved identity after conversation remount')

    const stopped = await send('Stop this synthetic response.')
    await button('Stop response').click(); await running().waitFor({ state: 'hidden' })
    await setCustom('gpt-5.6-luna')
    const newer = await send('Continue after stopping, using Luna.')
    await page.evaluate(requestId => window.connectedAgentTest.emit(requestId, 'delta', 'LATE_MODEL_STREAM'), stopped.requestId)
    await settle(stopped, 'LATE_MODEL_RESULT')
    assert.equal(await running().locator('.ca-requested-model').innerText(), 'Requested model: gpt-5.6-luna · Thinking: Medium')
    assert.ok(!(await page.locator('.ca-chat').innerText()).includes('LATE_MODEL'))
    await finish(newer, 'Synthetic post-stop Luna reply.')
    assert.ok(!savedMessages(await snapshot()).some(message => message.text === 'LATE_MODEL_RESULT'))
    pass('Stopped stale streams and completions cannot overwrite or persist a newer request model label')

    await page.evaluate(() => window.connectedAgentTest.setLocalModels([]))
    await openSettings(); await page.getByLabel('Assistant selection', { exact: true }).selectOption('lmstudio'); if (await page.getByRole('group', { name: 'Confirm assistant switch' }).count()) await page.getByRole('group', { name: 'Confirm assistant switch' }).getByRole('button', { name: /^Start .* chat$/ }).click()
    await backToChat()
    assert.equal(await selected().locator('strong').innerText(), 'No model selected')
    assert.equal(await page.locator('.ca-message').count(), 0, 'Changing provider starts a fresh chat')
    assert.ok(savedMessages(await snapshot()).some(message => message.text === 'Legacy local reply stays available.'), 'Previous local history remains saved')
    await setCustom('lmstudio-community/Qwen3-8B-GGUF')
    assert.match(await selected().innerText(), /LM Studio · local/)
    const local = await send('Discuss locally with an organization/model identifier.')
    assert.equal(local.provider, 'lmstudio'); assert.equal(local.model, 'lmstudio-community/Qwen3-8B-GGUF')
    await finish(local, 'Synthetic local reply.')
    assert.equal(await reply('Synthetic local reply.').locator('.ca-requested-model').innerText(), 'Requested model: lmstudio-community/Qwen3-8B-GGUF')
    pass('LM Studio shows its provider and exact organization/model ID without mistaking a valid model ID for a filesystem path')

    await openSettings(); await page.getByLabel('Assistant selection', { exact: true }).selectOption('codex'); if (await page.getByRole('group', { name: 'Confirm assistant switch' }).count()) await page.getByRole('group', { name: 'Confirm assistant switch' }).getByRole('button', { name: /^Start .* chat$/ }).click(); await backToChat()
    assert.notEqual(await chats().inputValue(), defaultChat, 'Changing provider starts a fresh chat, not an older task')
    await chats().selectOption(originalChat); await frame()
    const ramStorage = (await snapshot()).storage
    await page.addInitScript(storage => { window.__connectedAgentFixtureStorage = storage }, ramStorage)
    await page.reload(); await page.waitForFunction(() => window.connectedAgentTest?.ready); await composer().waitFor()
    assert.equal(await chats().inputValue(), originalChat)
    assert.equal(await selected().locator('strong').innerText(), 'gpt-6-astra · Medium')
    assert.equal(await reply('Synthetic Luna reply.').locator('.ca-requested-model').innerText(), 'Requested model: gpt-5.6-luna · Thinking: Medium')
    assert.equal(await reply('Synthetic Astra reply.').locator('.ca-requested-model').innerText(), 'Requested model: gpt-6-astra · Thinking: Medium')
    assert.equal(await reply('Legacy Codex reply stays available.').locator('.ca-requested-model').innerText(), 'Model not recorded')
    await chats().selectOption(defaultChat); await frame()
    assert.equal(await reply('Synthetic default reply.').locator('.ca-requested-model').innerText(), 'Requested: Codex default (not confirmed) · Thinking: Medium')
    assert.equal((await snapshot()).requests.length, 0)
    pass('Full renderer reload preserves each reply identity, explicit default and legacy unknown independently of current settings')

    const longModel = `local-org/${'long-model-segment-'.repeat(10)}Q4_K_M`
    await setCustom(longModel)
    const longRequest = await send('Verify a long exact model ID at narrow width.')
    await finish(longRequest, 'Synthetic narrow-layout reply.')
    await page.setViewportSize({ width: 650, height: 900 })
    const resize = page.getByRole('separator', { name: 'Resize agent panel', exact: true })
    await resize.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight')
    await frame()
    assert.ok(await selected().evaluate(node => node.scrollWidth <= node.clientWidth + 1))
    assert.ok(await reply('Synthetic narrow-layout reply.').locator('.ca-requested-model').evaluate(node => node.scrollWidth <= node.clientWidth + 1))
    assert.equal(await selected().locator('strong').innerText(), `${longModel} · Medium`)
    assert.equal(await composer().isVisible(), true); assert.equal(await button('Send message').isVisible(), true)
    await page.locator('.ca-messages').evaluate(node => { node.scrollTop = node.scrollHeight })
    await page.screenshot({ path: path.join(output, '02-narrow-exact-model.png'), fullPage: true })
    pass('Long model IDs wrap at narrow panel width while preserving the full ID, composer and Send control')

    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(new URL('/tests/fixtures/connected-agent.html?strict=1&dock=1', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    await button('Assistant').click(); await composer().waitFor()
    assert.equal(await selected().locator('strong').innerText(), 'gpt-6-astra · Medium')
    assert.ok(await selected().evaluate(node => node.scrollWidth <= node.clientWidth + 1))
    const dock = await page.locator('.connected-agent-panel').boundingBox()
    assert.ok(dock.width <= 257, 'Actual default dock width exercises the narrower layout')
    for (const control of [selected(), composer(), button('Send message')]) {
      const bounds = await control.boundingBox()
      assert.ok(bounds.y >= dock.y && bounds.y + bounds.height <= dock.y + dock.height + 1, 'Model and composer controls fit inside the normal-height dock')
    }
    await page.screenshot({ path: path.join(output, '03-model-normal-height-dock.png'), fullPage: true })
    pass('The 256 px shared Agent dock keeps saved model identity and composer visible above the timeline at normal panel height')

    const final = await snapshot()
    assert.deepEqual(final.authored, baseline)
    assert.deepEqual(final.forbiddenCalls, [])
    assert.deepEqual(errors, [])
    assert.deepEqual(blockedRequests, [])
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, groups, errors, blockedRequests }, null, 2))
    console.log('CONNECTED_AGENT_MODEL_IDENTITY_RESULT ' + JSON.stringify({ success: true, groups, output }))
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, blockedRequests,
      snapshot: await snapshot().catch(() => null), body: await page.locator('body').innerText().catch(() => '') }, null, 2))
    console.error(`Model identity fixture artifacts: ${output}`)
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
