// Actual Conversation + phone adapter, isolated RAM-only synthetic projects.
// No user profile, native model request, generation or project file IO.
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5296')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw Error('Loopback fixture required')

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' })
  await context.addInitScript(() => { window.__connectedAgentFixturePhoneRemembered = true })
  const page = await context.newPage(), errors = [], blocked = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === base.origin && !/^\/(?:prompt|queue|interrupt|system_stats|history|upload|view|ws|v1|api)(?:\/|$)/.test(url.pathname)) return route.continue()
    blocked.push(url.href); return route.abort()
  })
  await page.routeWebSocket(() => true, socket => socket.close())
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const composer = () => page.getByRole('textbox', { name: 'Message your agent', exact: true })
  const button = name => page.getByRole('button', { name, exact: true })
  const phone = async command => {
    const id = await page.evaluate(command => window.connectedAgentTest.phoneChatCommand(command), command)
    await page.waitForFunction(id => window.connectedAgentTest.snapshot().mobile.replies.some(reply => reply.id === id && reply.result.status !== 'accepted'), id)
    return (await snapshot()).mobile.replies.findLast(reply => reply.id === id).result
  }
  const waitChat = async id => page.waitForFunction(id => window.connectedAgentTest.snapshot().mobile.publication?.chatId === id, id)
  try {
    await page.goto(new URL('/tests/fixtures/connected-agent.html?dock=1&mobile=1&legacyChats=1', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready && window.connectedAgentTest.snapshot().mobile.publication?.chatNavigation)
    let state = await snapshot()
    const baseline = state.authored, spending = state.spendingPolicy, first = state.mobile.publication
    const local = first.chats.find(chat => chat.provider === 'lmstudio')
    assert.ok(local); assert.equal(first.chats.filter(chat => chat.current).length, 1)
    assert.equal((await phone({ kind: 'chat', chatId: local.id, provider: local.provider })).success, true)
    await waitChat(local.id)
    assert.equal((await snapshot()).mobile.publication.provider, 'lmstudio')
    assert.equal((await phone({ kind: 'chat', chatId: first.chatId, provider: 'codex' })).success, true)
    await waitChat(first.chatId)
    const unchangedContext = (await snapshot()).mobile.publication.contextId
    assert.equal((await phone({ kind: 'chat', chatId: first.chatId, provider: 'codex' })).success, true)
    assert.equal((await snapshot()).mobile.publication.contextId, unchangedContext, 'Selecting the current chat is a successful no-op')
    console.log('PASS 1: hidden desktop navigates both providers through the existing conversation')

    await button('Assistant').click(); await composer().fill('Unsent Codex draft')
    await page.getByRole('button', { name: 'Assistant settings', exact: true }).click()
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click()
    const beforeNew = (await snapshot()).mobile.publication
    assert.equal((await phone({ kind: 'new-chat' })).success, true)
    await page.waitForFunction(old => window.connectedAgentTest.snapshot().mobile.publication.chatId !== old, first.chatId)
    const created = (await snapshot()).mobile.publication
    assert.equal(created.provider, 'codex'); assert.equal(created.messages.length, 0)
    assert.notEqual(created.contextId, beforeNew.contextId)
    assert.equal(await composer().inputValue(), '')
    await composer().fill('Unsent new-chat draft')
    await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'phone-draft.json', mimeType: 'application/json', buffer: Buffer.from('{"reference":"synthetic draft attachment"}') })
    await button('Remove attachment phone-draft.json').waitFor()
    assert.equal((await phone({ kind: 'chat', chatId: first.chatId, provider: 'codex' })).success, true)
    await waitChat(first.chatId); assert.equal(await composer().inputValue(), 'Unsent Codex draft')
    assert.equal((await phone({ kind: 'chat', chatId: created.chatId, provider: 'codex' })).success, true)
    await waitChat(created.chatId); assert.equal(await composer().inputValue(), 'Unsent new-chat draft')
    await button('Remove attachment phone-draft.json').waitFor()
    console.log('PASS 2: new chat stays in current provider and preserves both unsent drafts')

    assert.equal((await phone({ kind: 'chat', chatId: local.id, provider: 'lmstudio' })).success, true)
    await waitChat(local.id); await composer().fill('Unsent local draft')
    assert.equal((await phone({ kind: 'chat', chatId: created.chatId, provider: 'codex' })).success, true)
    await waitChat(created.chatId); assert.equal(await composer().inputValue(), 'Unsent new-chat draft')
    await button('Remove attachment phone-draft.json').waitFor()
    assert.equal((await phone({ kind: 'chat', chatId: local.id, provider: 'lmstudio' })).success, true)
    await waitChat(local.id); assert.equal(await composer().inputValue(), 'Unsent local draft')
    assert.equal((await phone({ kind: 'chat', chatId: '../private', provider: 'lmstudio' })).success, false)
    assert.equal((await phone({ kind: 'new-chat', contextId: first.contextId })).success, false)
    assert.equal((await snapshot()).mobile.publication.chatId, local.id)
    console.log('PASS 3: cross-provider drafts survive remount; invalid and stale navigation cannot move chats')

    await page.evaluate(() => window.connectedAgentTest.setExportBusy(true))
    assert.equal((await phone({ kind: 'new-chat' })).success, false)
    await page.evaluate(() => window.connectedAgentTest.setExportBusy(false))
    state = await snapshot()
    assert.deepEqual(state.authored, baseline)
    assert.equal(state.spendingPolicy, spending)
    assert.equal(state.requests.length, 0)
    assert.equal(state.forbiddenCalls.length, 0)
    assert.equal(state.calls.some(call => call.method === 'setFullAccess' && call.enabled), false)
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    console.log('PASS 4: export blocks navigation; no authored edits, model requests or policy changes')
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
