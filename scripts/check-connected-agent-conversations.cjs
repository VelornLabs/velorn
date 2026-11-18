// Multiple-chat regression through the actual renderer and RAM-only stores.
// No model, native project IO, user browser storage or real tool is available.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Conversation fixture requires loopback HTTP')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-connected-agent-conversations-'))

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', serviceWorkers: 'block' })
  await context.addInitScript(() => {
    window.fixtureEscapedKeys = []
    document.addEventListener('keydown', event => window.fixtureEscapedKeys.push(event.key))
  })
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
  const dialog = () => page.getByRole('alertdialog', { name: 'Delete conversation?', exact: true })
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const options = () => chats().locator('option').evaluateAll(entries => entries.map(entry => ({ value: entry.value, text: entry.textContent })))
  const pass = text => { groups.push(text); console.log(`PASS ${groups.length}: ${text}`) }
  const show = text => page.getByText(text, { exact: true }).waitFor()
  const absent = async text => assert.equal(await page.getByText(text, { exact: true }).count(), 0)
  const select = async id => { await chats().selectOption(id); await frame(); assert.equal(await chats().inputValue(), id) }
  const openSettings = async () => {
    if (await button('Assistant settings').getAttribute('aria-expanded') !== 'true') await button('Assistant settings').click()
    // These legacy regressions intentionally exercise the individual controls.
    const advanced = page.locator('summary').filter({ hasText: /^Access options$/ })
    if (!(await advanced.evaluate(node => node.parentElement.open))) await advanced.click()
  }
  const backToChat = async () => { if (await button('Back to chat').isVisible()) await button('Back to chat').click() }
  const provider = async value => {
    await openSettings(); await page.getByLabel('Assistant selection', { exact: true }).selectOption(value); if (await page.getByRole('group', { name: 'Confirm assistant switch' }).count()) await page.getByRole('group', { name: 'Confirm assistant switch' }).getByRole('button', { name: /^Start .* chat$/ }).click()
    if (value === 'lmstudio') {
      await page.getByLabel('Model', { exact: true }).selectOption('__custom__')
      await page.getByLabel('Custom model ID', { exact: true }).fill('fixture-local-model')
    }
    await backToChat(); await frame()
  }
  const send = async text => {
    await backToChat()
    const count = (await snapshot()).requests.length
    await composer().fill(text); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, count)
    return (await snapshot()).requests.at(-1)
  }
  const emit = (request, event) => page.evaluate(event => window.connectedAgentTest.emitEvent(event), { requestId: request.requestId, ...event })
  const settle = async (request, text) => {
    await page.evaluate(({ requestId, text }) => window.connectedAgentTest.settle(requestId, { success: true, text }), { requestId: request.requestId, text })
    await frame()
  }
  const finish = async (request, text) => { await settle(request, text); await show(text); await button('Stop response').waitFor({ state: 'hidden' }) }
  const newChat = async () => {
    const previous = await chats().inputValue()
    await button('New chat').click(); await frame()
    const id = await chats().inputValue(); assert.ok(id); assert.notEqual(id, previous)
    assert.equal(await page.locator('.ca-message').count(), 0)
    return id
  }
  const openDelete = async () => {
    await button('Conversation options').click(); await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click(); await dialog().waitFor()
    await page.waitForFunction(() => {
      const cancel = [...document.querySelectorAll('[role="alertdialog"] button')].find(node => node.textContent.trim() === 'Cancel')
      return cancel && document.activeElement === cancel
    })
  }
  const deleteCurrent = async () => {
    const id = await chats().inputValue()
    await openDelete(); await dialog().getByRole('button', { name: 'Delete conversation', exact: true }).focus(); await page.keyboard.press('Enter')
    await dialog().waitFor({ state: 'hidden' }); await frame()
    assert.equal((await options()).some(option => option.value === id), false, 'Only the explicitly confirmed chat ID is deleted')
    return id
  }
  const assertDisabled = async () => {
    for (const control of [button('New chat'), chats(), button('Conversation options')]) assert.equal(await control.isDisabled(), true)
    const before = await options(), selected = await chats().inputValue()
    await button('New chat').evaluate(node => node.click())
    await button('Conversation options').evaluate(node => node.click())
    assert.deepEqual(await options(), before)
    assert.equal(await chats().inputValue(), selected)
    assert.equal(await dialog().count(), 0)
  }
  const unchanged = async baseline => assert.deepEqual((await snapshot()).authored, baseline, 'Conversation management never changes the project, timeline, media, dirty flag or Undo')
  try {
    await page.goto(new URL('/tests/fixtures/connected-agent.html?strict=1&legacyChats=1', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    await chats().waitFor()
    const baseline = (await snapshot()).authored
    const legacyId = await chats().inputValue()
    assert.ok(legacyId)
    assert.equal((await options()).length, 1)
    await show('Legacy Codex reply stays available.')
    await absent('Legacy local reply stays available.')
    assert.equal((await snapshot()).requests.length, 0, 'Migration is local and does not send a prompt')
    const continued = await send('Continue the original review')
    assert.deepEqual(continued.messages, [
      { role: 'user', content: 'Legacy storyboard review' }, { role: 'assistant', content: 'Legacy Codex reply stays available.' },
      { role: 'user', content: 'Continue the original review' },
    ])
    await finish(continued, 'Original review continued.')
    await unchanged(baseline)
    pass('A legacy transcript migrates once under StrictMode, preserves its full send history and leaves authored state untouched')

    await composer().fill('Unsent original-chat draft')
    const secondId = await newChat()
    assert.equal(await composer().inputValue(), '')
    await composer().fill('Unsent second-chat draft')
    await select(legacyId); await show('Original review continued.')
    assert.equal(await composer().inputValue(), 'Unsent original-chat draft')
    await select(secondId)
    assert.equal(await composer().inputValue(), 'Unsent second-chat draft')
    await absent('Original review continued.')
    const second = await send('Alternate opening discussion')
    assert.deepEqual(second.messages, [{ role: 'user', content: 'Alternate opening discussion' }])
    assert.equal(await chats().inputValue(), secondId)
    assert.equal((await options()).find(option => option.value === secondId).text, 'Alternate opening discussion')
    await finish(second, 'Only the alternate opening belongs here.')
    pass('New chat has a stable ID and first-message title, sends no sibling history, and switches preserve separate unsent drafts')

    await page.evaluate(() => window.connectedAgentTest.changeEditorView({ timelineId: 'timeline-alpha-second', playhead: 9 }))
    const fresh = await send('Discuss the current second timeline')
    assert.equal(fresh.context.project.name, 'Signal — synthetic project')
    assert.equal(fresh.context.editor.timeline.id, 'timeline-alpha-second')
    assert.equal(fresh.context.editor.timeline.playheadSeconds, 9)
    assert.deepEqual(fresh.messages, [
      { role: 'user', content: 'Alternate opening discussion' }, { role: 'assistant', content: 'Only the alternate opening belongs here.' },
      { role: 'user', content: 'Discuss the current second timeline' },
    ])
    await finish(fresh, 'Fresh context, same selected conversation.')
    await page.evaluate(() => window.connectedAgentTest.changeEditorView({ timelineId: 'timeline-alpha', playhead: 2.5 }))
    await unchanged(baseline)
    pass('Each Send uses current project and timeline context while including only the selected conversation messages')

    const beforeReload = await options(), ramStorage = (await snapshot()).storage
    await page.addInitScript(storage => { window.__connectedAgentFixtureStorage = storage }, ramStorage)
    await page.reload(); await page.waitForFunction(() => window.connectedAgentTest?.ready); await chats().waitFor()
    assert.deepEqual(await options(), beforeReload)
    assert.equal(await chats().inputValue(), secondId)
    await show('Fresh context, same selected conversation.')
    assert.equal(await composer().inputValue(), '', 'Unsent drafts are session-only, not persisted chat content')
    assert.equal((await snapshot()).requests.length, 0)
    await select(legacyId); await show('Original review continued.')
    assert.equal((await options()).length, 2, 'Reload does not repeat migration or create a duplicate chat')
    await select(secondId)
    pass('A full renderer reload restores the selected stable ID, conversation list and histories without persisting drafts or duplicating migration')

    const stopped = await send('A slow second-chat response')
    await emit(stopped, { type: 'delta', text: 'Temporary stream that must stay in this request' })
    await assertDisabled()
    await button('Stop response').click(); await button('Stop response').waitFor({ state: 'hidden' })
    const thirdId = await newChat()
    await emit(stopped, { type: 'delta', text: 'LATE_STOPPED_STREAM' }); await settle(stopped, 'LATE_STOPPED_RESULT')
    assert.equal(await page.locator('.ca-message').count(), 0)
    await select(secondId)
    assert.ok(!(await page.locator('.ca-chat').innerText()).includes('LATE_STOPPED'))
    assert.ok((await snapshot()).calls.some(call => call.method === 'cancel' && call.requestId === stopped.requestId))
    await select(thirdId)
    pass('Running replies disable chat creation, switching and deletion; Stop permits navigation and rejects late replies in both chats')

    await openSettings(); await page.getByRole('checkbox', { name: 'Velorn tools', exact: true }).check(); await backToChat()
    const approvalRequest = await send('Ask before a synthetic timeline change')
    await emit(approvalRequest, { type: 'approval', approvalId: 'conversation-pending', toolName: 'edit_timeline', arguments: { operation: 'move', clipId: 'fixture-clip' } })
    await button('Approve').waitFor(); await assertDisabled()
    await button('Stop response').click(); await button('Approve').waitFor({ state: 'hidden' })
    assert.equal(await deleteCurrent(), thirdId)
    const newerApprovalRequest = await send('Continue safely after the stopped approval chat was deleted')
    await emit(approvalRequest, { type: 'approval', approvalId: 'late-deleted-chat', toolName: 'edit_timeline', arguments: {} })
    await settle(approvalRequest, 'LATE_DELETED_CONVERSATION_RESULT')
    assert.equal(await button('Approve').count(), 0)
    assert.equal(await button('Stop response').isVisible(), true)
    assert.ok(!(await snapshot()).calls.some(call => call.method === 'cancel' && call.requestId === newerApprovalRequest.requestId))
    assert.ok(!(await page.locator('.ca-chat').innerText()).includes('LATE_DELETED_CONVERSATION'))
    assert.equal((await options()).some(option => option.value === thirdId), false)
    assert.equal((await snapshot()).calls.filter(call => call.method === 'approveTool').length, 0)
    await finish(newerApprovalRequest, 'The newer request survives old approval events.')
    await unchanged(baseline)
    pass('Pending approvals also lock conversation controls; Stop then delete clears approval and ignores delayed events without deciding a tool')

    await select(secondId)
    const beforeCancel = await options()
    await button('Conversation options').click(); await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).count(), 0)
    assert.equal(await composer().isVisible(), true)
    await openDelete(); await dialog().getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog().waitFor({ state: 'hidden' })
    assert.equal(await button('Conversation options').evaluate(node => document.activeElement === node), true, 'Cancel restores focus after the chat stops being inert')
    assert.deepEqual(await options(), beforeCancel)
    assert.equal(await chats().inputValue(), secondId)
    await show('Fresh context, same selected conversation.')
    await openDelete(); await page.keyboard.press('Enter'); await dialog().waitFor({ state: 'hidden' })
    assert.equal(await button('Conversation options').evaluate(node => document.activeElement === node), true, 'Default Enter cancellation restores focus to conversation options')
    assert.deepEqual(await options(), beforeCancel, 'Enter defaults to Cancel, not deletion')
    await openDelete(); await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' })
    assert.equal(await button('Conversation options').evaluate(node => document.activeElement === node), true, 'Escape cancellation restores focus to conversation options')
    assert.deepEqual(await options(), beforeCancel)
    assert.equal(await deleteCurrent(), secondId)
    assert.equal(await chats().inputValue(), legacyId)
    await show('Original review continued.'); await absent('Fresh context, same selected conversation.')
    await unchanged(baseline)
    pass('Delete requires confirmation; Cancel and Escape keep the chat, while confirmation removes only that chat and selects the remaining history')

    await provider('lmstudio')
    assert.equal((await options()).length, 1)
    await show('Legacy local reply stays available.'); await absent('Original review continued.')
    const localLegacyId = await chats().inputValue()
    const localFirst = await send('Continue the local legacy chat')
    assert.equal(localFirst.provider, 'lmstudio')
    assert.deepEqual(localFirst.messages, [
      { role: 'user', content: 'Legacy local review' }, { role: 'assistant', content: 'Legacy local reply stays available.' },
      { role: 'user', content: 'Continue the local legacy chat' },
    ])
    await finish(localFirst, 'Local legacy continuation only.')
    const localSecondId = await newChat()
    const localSecond = await send('A separate local conversation')
    assert.deepEqual(localSecond.messages, [{ role: 'user', content: 'A separate local conversation' }])
    await finish(localSecond, 'Separate local answer only.')
    await provider('codex')
    assert.equal(await chats().inputValue(), legacyId)
    assert.equal((await options()).length, 1); await show('Original review continued.')
    await provider('lmstudio')
    assert.equal(await chats().inputValue(), localSecondId)
    assert.equal((await options()).length, 2); await show('Separate local answer only.')
    await select(localLegacyId); await show('Local legacy continuation only.')
    await provider('codex')
    pass('Provider lists, selected IDs and migrated histories stay isolated; changing provider never sends sibling-provider messages')

    await page.evaluate(() => window.connectedAgentTest.switchProject('beta')); await frame()
    const betaBaseline = (await snapshot()).authored
    assert.equal((await options()).length, 1)
    assert.equal(await page.locator('.ca-message').count(), 0)
    const betaId = await chats().inputValue()
    const beta = await send('Only the second project conversation')
    assert.equal(beta.context.project.name, 'Other — synthetic project')
    assert.deepEqual(beta.messages, [{ role: 'user', content: 'Only the second project conversation' }])
    await finish(beta, 'Second project answer only.'); await unchanged(betaBaseline)
    await openDelete()
    await page.evaluate(() => window.connectedAgentTest.switchProject('alpha')); await frame()
    assert.equal(await dialog().count(), 0, 'A confirmation for the previous project cannot remain actionable')
    assert.equal(await chats().inputValue(), legacyId); await show('Original review continued.')
    await absent('Second project answer only.')
    await page.evaluate(() => window.connectedAgentTest.switchProject('beta')); await frame()
    assert.equal(await chats().inputValue(), betaId); await show('Second project answer only.')
    await page.evaluate(() => window.connectedAgentTest.switchProject('alpha')); await frame()
    pass('Project replacement restores independent conversation lists and active IDs with the correct fresh project context')

    await composer().fill('Keyboard draft')
    await composer().focus(); await page.evaluate(() => { window.fixtureEscapedKeys.length = 0 })
    await page.keyboard.press('Space'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Second line')
    assert.equal(await composer().inputValue(), 'Keyboard draft \nSecond line')
    assert.deepEqual(await page.evaluate(() => window.fixtureEscapedKeys), [])
    const beforeKeyboard = (await snapshot()).requests.length
    await button('New chat').focus(); await page.keyboard.press('Enter'); await frame()
    const keyboardId = await chats().inputValue()
    assert.notEqual(keyboardId, legacyId)
    assert.equal((await snapshot()).requests.length, beforeKeyboard, 'Keyboard New chat never sends a message')
    await select(legacyId)
    assert.equal(await composer().inputValue(), 'Keyboard draft \nSecond line')
    await chats().focus(); await page.keyboard.press('End'); await frame()
    assert.equal(await chats().inputValue(), keyboardId)
    assert.deepEqual(await page.evaluate(() => window.fixtureEscapedKeys), [])
    pass('Composer typing stays local and keyboard New chat does not submit; returning to a chat restores its exact multiline draft')

    await select(legacyId); await deleteCurrent()
    assert.equal(await chats().inputValue(), keyboardId)
    await deleteCurrent()
    const emptyId = await chats().inputValue()
    assert.equal((await options()).length, 1)
    assert.notEqual(emptyId, keyboardId)
    assert.equal(await page.locator('.ca-message').count(), 0)
    await button('Close assistant panel').click(); await button('Open agent').click(); await chats().waitFor()
    assert.equal((await options()).length, 1)
    assert.equal(await chats().inputValue(), emptyId)
    await absent('Legacy Codex reply stays available.')
    const freshAfterDelete = await send('Start fresh after deleting the last chat')
    assert.deepEqual(freshAfterDelete.messages, [{ role: 'user', content: 'Start fresh after deleting the last chat' }])
    await finish(freshAfterDelete, 'Fresh chat after deletion works.')
    await unchanged(baseline)
    pass('Deleting the last chat leaves a usable empty conversation; reopening never resurrects deleted legacy history or changes the project')

    await openSettings()
    await page.getByRole('checkbox', { name: 'Share images', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Include current view', exact: true }).check()
    await backToChat()
    await page.evaluate(() => window.connectedAgentTest.setHoldCapture(true))
    const captureBefore = await snapshot(), captureChatId = await chats().inputValue()
    await composer().fill('Prepare an image, but stop before sending'); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().calls.filter(call => call.method === 'capture').length > count,
      captureBefore.calls.filter(call => call.method === 'capture').length)
    await assertDisabled()
    await button('Stop response').click(); await button('Stop response').waitFor({ state: 'hidden' })
    const afterCaptureId = await newChat()
    await page.evaluate(() => { window.connectedAgentTest.releaseCapture(); window.connectedAgentTest.setHoldCapture(false) }); await frame()
    assert.equal((await snapshot()).requests.length, captureBefore.requests.length, 'Stopped preparation never sends an image into the next chat')
    assert.equal(await page.locator('.ca-message').count(), 0)
    await select(captureChatId); await show('Fresh chat after deletion works.')
    assert.equal(await composer().inputValue(), 'Prepare an image, but stop before sending')
    await select(afterCaptureId)
    await openSettings(); await page.getByRole('checkbox', { name: 'Share images', exact: true }).uncheck(); await backToChat()
    await unchanged(baseline)
    pass('Image preparation locks conversation controls; Stop then New chat rejects the delayed capture and preserves the unsent source-chat draft')

    for (const width of [900, 760]) {
      await page.setViewportSize({ width, height: 820 }); await frame()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
      for (const control of [button('New chat'), chats(), button('Conversation options'), composer(), button('Send message')]) {
        await control.scrollIntoViewIfNeeded()
        const box = await control.boundingBox()
        assert.ok(box && box.width > 0 && box.height > 0 && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 821, 'Conversation controls remain in reach')
      }
      await openDelete()
      const box = await dialog().boundingBox()
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 821)
      await page.screenshot({ path: path.join(output, `delete-confirmation-${width}.png`), fullPage: true, animations: 'disabled' })
      await dialog().getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.screenshot({ path: path.join(output, `conversations-${width}.png`), fullPage: true, animations: 'disabled' })
    }
    await unchanged(baseline)
    const final = await snapshot()
    assert.deepEqual(final.forbiddenCalls, [])
    assert.deepEqual(errors, [])
    assert.deepEqual(blockedRequests, [])
    pass('At 900px and 760px conversation controls, composer and deletion confirmation remain reachable without overflow or external requests')
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, groups, errors, blockedRequests }, null, 2))
    console.log('CONNECTED_AGENT_CONVERSATIONS_RESULT ' + JSON.stringify({ success: true, groups, output }))
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, blockedRequests,
      snapshot: await snapshot().catch(() => null), body: await page.locator('body').innerText().catch(() => '') }, null, 2))
    console.error(`Conversation fixture artifacts: ${output}`)
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
