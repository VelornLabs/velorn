// All-workspace renderer persistence checks. Uses only RAM stores, deterministic
// provider/capture mocks and a synthetic srcDoc iframe; never a real provider,
// ComfyUI service, native project, export worker or authored operation.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Workspace fixture requires loopback HTTP')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-connected-agent-workspaces-'))
const workspaces = ['Editor', 'Storyboard', 'Generate', 'Stock', 'ComfyUI', 'Export', 'Discover']
const unsupportedViews = workspaces.slice(2)

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', serviceWorkers: 'block' })
  const page = await context.newPage(), groups = [], errors = [], blockedRequests = []
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
  const input = () => page.getByRole('textbox', { name: 'Message your agent', exact: true })
  const tab = name => page.getByRole('navigation', { name: 'Fixture workspace modes' }).getByRole('button', { name, exact: true })
  const checkbox = name => page.getByRole('checkbox', { name, exact: true })
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const capture = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
  const openSettings = async () => {
    if (await button('Assistant settings').getAttribute('aria-expanded') !== 'true') await button('Assistant settings').click()
    // These legacy regressions intentionally exercise the individual controls.
    const advanced = page.locator('summary').filter({ hasText: /^Access options$/ })
    if (!(await advanced.evaluate(node => node.parentElement.open))) await advanced.click()
  }
  const backToChat = async () => { if (await button('Back to chat').isVisible()) await button('Back to chat').click() }
  const send = async text => {
    await backToChat()
    const count = (await snapshot()).requests.length
    await input().fill(text); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, count)
    return (await snapshot()).requests.at(-1)
  }
  const emit = (request, event) => page.evaluate(event => window.connectedAgentTest.emitEvent(event), { requestId: request.requestId, ...event })
  const settle = async (request, text) => {
    await page.evaluate(({ requestId, text }) => window.connectedAgentTest.settle(requestId, { success: true, text }), { requestId: request.requestId, text })
    await button('Stop response').waitFor({ state: 'hidden' }); await frame()
  }
  let previousListenerScope = null, previousSubscriptions = null
  const assertIdentity = async () => {
    const state = await snapshot()
    assert.equal(state.listenerCount, 1, 'Exactly one live provider event listener')
    assert.equal(state.listenerSubscriptions - state.listenerUnsubscriptions, 1, 'No leaked provider subscriptions across conversation changes')
    const listenerScope = await page.evaluate(() => JSON.stringify([
      document.querySelector('[aria-label="Assistant"]')?.value,
      document.querySelector('[aria-label="Conversation"]')?.value,
    ]))
    // The established permission scope includes the selected conversation, so
    // changing chat/provider refreshes its subscription. Workspace moves do not.
    if (listenerScope === previousListenerScope) assert.equal(state.listenerSubscriptions, previousSubscriptions, 'Workspace navigation never resubscribes/remounts the conversation')
    previousListenerScope = listenerScope; previousSubscriptions = state.listenerSubscriptions
    assert.equal(state.maxListenerCount, 1)
    assert.equal(await page.locator('textarea[aria-label="Message your agent"]').count(), 1)
    assert.equal(await page.evaluate(() => window.__workspaceAgentNodes.composer === document.querySelector('textarea[aria-label="Message your agent"]')
      && window.__workspaceAgentNodes.panel === document.querySelector('.ca-docked')
      && window.__workspaceAgentNodes.settings === document.querySelector('.ca-settings')), true, 'The exact composer, panel and settings DOM nodes survive')
  }
  const assertReachable = async target => {
    await target.scrollIntoViewIfNeeded()
    assert.equal(await target.evaluate(node => {
      const box = node.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2
      return box.width > 10 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && node.contains(document.elementFromPoint(x, y))
    }), true, 'Control remains reachable without an overlapping workspace or iframe')
  }
  try {
    await page.goto(new URL('/tests/fixtures/connected-agent.html?dock=1', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    const baseline = (await snapshot()).authored
    for (const name of workspaces) {
      await tab(name).click(); await page.getByTestId('right-panel-dock').waitFor()
      assert.equal(await button('Assistant').count(), 1)
      assert.equal(await button('Inspector').count(), name === 'Editor' ? 1 : 0)
      assert.equal((await snapshot()).listenerCount, 0, 'Navigation alone never starts the lazy agent')
      assert.equal((await snapshot()).calls.length, 0, 'No connection lookup or provider call before opening Agent')
      if (name !== 'Editor') assert.equal(await page.getByTestId('fixture-inspector').isVisible(), false)
    }
    pass('All seven workspaces have a lazy right rail; only Editor exposes Inspector and no navigation starts provider work')

    await button('Assistant').click(); await input().waitFor()
    await page.evaluate(() => { window.__workspaceAgentNodes = {
      composer: document.querySelector('textarea[aria-label="Message your agent"]'),
      panel: document.querySelector('.ca-docked'), settings: document.querySelector('.ca-settings'),
    } })
    await openSettings()
    await page.getByLabel('Model', { exact: true }).selectOption('fixture-codex-fast')
    // Selecting a model intentionally returns to chat; permissions remain in Settings.
    await openSettings()
    await checkbox('Velorn tools').check(); await checkbox('Research & setup').check()
    await checkbox('Share images').check(); await checkbox('Include current view').check()
    await backToChat()
    const first = await send('First synthetic conversation for cross-workspace review.')
    await settle(first, 'First history remains in its selected conversation.')
    const firstChat = await page.getByLabel('Conversation', { exact: true }).inputValue()
    await button('New chat').click()
    const second = await send('Second synthetic conversation must stay separate.')
    await settle(second, 'Second history stays separate.')
    const secondChat = await page.getByLabel('Conversation', { exact: true }).inputValue()
    assert.notEqual(secondChat, firstChat)
    await input().fill('Second conversation draft survives switching.')
    await page.getByLabel('Conversation', { exact: true }).selectOption(firstChat)
    await input().fill('One selected conversation and draft across all workspaces.')
    await assertIdentity()
    pass('One lazily mounted agent holds two distinct chats, exact model selection and explicit tool/research/image permissions')

    for (const name of workspaces) {
      await tab(name).click(); await input().waitFor()
      assert.equal(await input().inputValue(), 'One selected conversation and draft across all workspaces.')
      assert.equal(await page.getByLabel('Conversation', { exact: true }).inputValue(), firstChat)
      await page.getByText('First history remains in its selected conversation.', { exact: true }).waitFor()
      assert.equal(await page.getByText('Second history stays separate.', { exact: true }).count(), 0)
      assert.match(await page.getByLabel('Selected model', { exact: true }).innerText(), /fixture-codex-fast/)
      assert.match(await page.getByLabel('Current assistant permissions', { exact: true }).innerText(), /Codex.*Tools enabled.*Research & setup/s)
      await assertIdentity()
    }
    pass('Selected chat, unfinished draft, history, exact model and live permissions remain shared across every workspace')

    await openSettings()
    for (const name of workspaces) {
      await tab(name).click(); await button('Back to chat').waitFor()
      assert.equal(await button('Assistant settings').getAttribute('aria-expanded'), 'true')
      assert.equal(await page.getByLabel('Assistant selection', { exact: true }).inputValue(), 'codex')
      assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), 'fixture-codex-fast')
      for (const name of ['Velorn tools', 'Research & setup', 'Share images', 'Include current view']) assert.equal(await checkbox(name).isChecked(), true)
      await assertIdentity()
    }
    await backToChat()
    assert.equal(await input().inputValue(), 'One selected conversation and draft across all workspaces.')
    pass('The open settings surface itself survives every workspace transition without resetting provider, model or consent')

    const held = await send('Hold this synthetic reply while navigating every workspace.')
    await input().fill('Next draft remains beside the held reply.')
    for (const name of workspaces) {
      await tab(name).click()
      await emit(held, { type: 'delta', text: `Live response reached ${name}.` })
      await button('Stop response').waitFor()
      assert.equal(await input().inputValue(), 'Next draft remains beside the held reply.')
      await assertIdentity()
    }
    await openSettings()
    await emit(held, { type: 'delta', text: 'Settings do not end a live response.' })
    assert.equal(await button('Assistant settings').getAttribute('aria-expanded'), 'true')
    await emit(held, { type: 'approval', approvalId: 'workspace-pending', toolName: 'edit_timeline',
      arguments: { operation: 'move', clipId: 'fixture-clip', startTime: 2 }, preview: { changes: ['Synthetic proposed edit only.'] } })
    await button('Approve').waitFor()
    for (const name of workspaces) {
      await tab(name).click(); await button('Approve').waitFor()
      assert.equal(await input().inputValue(), 'Next draft remains beside the held reply.')
      assert.equal((await snapshot()).calls.filter(call => call.method === 'approveTool').length, 0, 'Navigation never answers an approval')
      await assertIdentity()
    }
    await button('Deny').click(); await button('Deny').waitFor({ state: 'hidden' })
    await settle(held, 'The held response survived every workspace and an explicit denial.')
    assert.ok(!(await snapshot()).calls.some(call => call.method === 'cancel' && call.requestId === held.requestId))
    assert.deepEqual((await snapshot()).calls.filter(call => call.method === 'approveTool').map(call => [call.approvalId, call.approved]), [['workspace-pending', false]])
    pass('An in-flight reply and pending approval survive all tabs and settings; navigation neither cancels nor implicitly approves')

    await tab('Generate').click()
    const handle = await page.locator('.fixture-dock-resize').boundingBox()
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down(); await page.mouse.move(handle.x - 65, handle.y + handle.height / 2, { steps: 5 }); await page.mouse.up()
    const resized = (await page.getByTestId('right-dock-wrapper').boundingBox()).width
    for (const name of workspaces) {
      await tab(name).click()
      assert.equal((await page.getByTestId('right-dock-wrapper').boundingBox()).width, resized)
      await button('Collapse right panel').click()
      assert.equal(await input().isVisible(), false)
      assert.ok((await page.getByTestId('right-dock-wrapper').boundingBox()).width <= 49)
      await assertIdentity()
      await button('Expand right panel').click(); await input().waitFor()
      assert.equal(await input().inputValue(), 'Next draft remains beside the held reply.')
    }
    await button('Collapse right panel').click()
    for (const name of workspaces) {
      await tab(name).click()
      assert.equal(await input().isVisible(), false, 'Collapsed state follows workspace navigation')
      assert.ok((await page.getByTestId('right-dock-wrapper').boundingBox()).width <= 49)
      await assertIdentity()
    }
    await button('Expand right panel').click()
    await tab('Editor').click(); await button('Expand right panel to full height').click()
    await tab('ComfyUI').click(); await tab('Editor').click()
    assert.equal(await button('Restore right panel height').count(), 1)
    await button('Restore right panel height').click(); await assertIdentity()
    pass('One width and collapsed state work on every workspace; Editor full-height preference survives leaving and returning')

    for (const name of unsupportedViews) {
      await tab(name).click()
      const captures = (await snapshot()).calls.filter(call => call.method === 'capture').length
      const request = await send(`Discuss the current ${name} workspace using only available context.`)
      assert.equal(request.context.editor.activeTab, name.toLowerCase())
      assert.deepEqual(request.images, [], 'Unsupported workspace never silently substitutes editor/storyboard pixels')
      assert.deepEqual(request.context.visibleShotIds, [])
      assert.equal((await snapshot()).calls.filter(call => call.method === 'capture').length, captures)
      await settle(request, `${name} text-only fixture reply.`)
    }
    pass('Generate, Stock, ComfyUI, Export and Discover send accurate tab context with no unsupported or stale current-view screenshot')

    for (const name of ['Editor', 'Storyboard']) {
      await tab(name).click()
      if (name === 'Storyboard') await page.locator('.pr-shot-card').nth(7).waitFor()
      const request = await send(`Discuss the current ${name} view.`)
      assert.ok(request.images.some(image => image.label.startsWith(`Current ${name === 'Editor' ? 'editor viewer' : 'storyboard workspace'}`)))
      const captureCall = (await snapshot()).calls.filter(call => call.method === 'capture').at(-1)
      const dock = await page.getByTestId('right-dock-wrapper').boundingBox()
      assert.ok(captureCall.rect.x + captureCall.rect.width <= dock.x + 1, 'The shared capture excludes the agent rail')
      await settle(request, `${name} supported view reply.`)
    }
    pass('Explicit Editor and Storyboard current-view sharing remains supported and excludes the agent rail')

    for (const name of unsupportedViews) {
      await tab('Editor').click()
      await page.evaluate(() => window.connectedAgentTest.setHoldCapture(true))
      const before = await snapshot()
      await input().fill(`Reject this held editor snapshot when moving to ${name}.`); await button('Send message').click()
      await page.waitForFunction(count => window.connectedAgentTest.snapshot().calls.filter(call => call.method === 'capture').length > count,
        before.calls.filter(call => call.method === 'capture').length)
      await tab(name).click()
      await page.evaluate(() => { window.connectedAgentTest.releaseCapture(); window.connectedAgentTest.setHoldCapture(false) })
      await button('Stop response').waitFor({ state: 'hidden' })
      assert.equal((await snapshot()).requests.length, before.requests.length, 'Workspace change during capture rejects the stale send')
      await page.getByText('The workspace changed while preparing images. Please send again from the view you want to discuss.', { exact: true }).waitFor()
      await assertIdentity()
    }
    pass('Held Editor screenshots reject changes to each unsupported workspace with zero provider sends and no conversation remount')

    await tab('ComfyUI').click()
    const graphInput = page.frameLocator('iframe[title="Synthetic ComfyUI frame"]').getByLabel('Fixture graph note', { exact: true })
    await graphInput.fill('Local iframe owns its own keys')
    await graphInput.press('End'); await graphInput.press('Space')
    assert.equal(await graphInput.inputValue(), 'Local iframe owns its own keys ')
    await input().fill('Agent owns its own keys'); await input().press('End'); await input().press('Space')
    assert.equal(await input().inputValue(), 'Agent owns its own keys ')
    assert.equal(await page.evaluate(() => window.connectedAgentTest.editorView().isPlaying), false)
    await assertReachable(input()); await assertReachable(button('Assistant settings'))
    await capture('01-comfyui-local-iframe-agent')
    pass('Synthetic local iframe and Agent independently receive focus/Space; the iframe cannot cover the right rail')

    const beforeIframeResize = (await page.getByTestId('right-dock-wrapper').boundingBox()).width
    const iframeHandle = await page.locator('.fixture-dock-resize').boundingBox()
    const iframeBox = await page.locator('iframe[title="Synthetic ComfyUI frame"]').boundingBox()
    const previousBodyStyle = await page.evaluate(() => ({ cursor: document.body.style.cursor, userSelect: document.body.style.userSelect }))
    await page.mouse.move(iframeHandle.x + iframeHandle.width / 2, iframeHandle.y + iframeHandle.height / 2)
    await page.mouse.down()
    // Deliberately jump directly into iframe pixels, beyond the maximum dock
    // width. Document-only mouse listeners lose this move and release.
    const frameX = iframeBox.x + iframeBox.width / 2, frameY = iframeBox.y + iframeBox.height / 2
    await page.mouse.move(frameX, frameY); await frame()
    const acrossIframe = (await page.getByTestId('right-dock-wrapper').boundingBox()).width
    assert.ok(acrossIframe > beforeIframeResize + 100, 'A drag directly across iframe pixels continues resizing')
    await page.mouse.up(); await frame()
    assert.deepEqual(await page.evaluate(() => ({ cursor: document.body.style.cursor, userSelect: document.body.style.userSelect })), previousBodyStyle,
      'Releasing over the iframe restores global cursor and selection styles')
    await page.mouse.move(100, 30); await page.mouse.move(1200, 30); await frame()
    assert.equal((await page.getByTestId('right-dock-wrapper').boundingBox()).width, acrossIframe, 'Later pointer movement cannot resume a finished iframe-crossing drag')
    await assertIdentity()
    pass('The shared resize handle follows a drag into iframe pixels, releases safely there and does not remain stuck resizing')

    const busyRequest = await send('Keep this already-sent review alive through synthetic export activity.')
    await input().fill('Unsent draft retained throughout actual export activity.')
    await emit(busyRequest, { type: 'approval', approvalId: 'export-paused-approval', toolName: 'edit_timeline',
      arguments: { operation: 'move', clipId: 'fixture-clip', startTime: 2 } })
    await button('Approve').waitFor()
    await page.evaluate(() => window.connectedAgentTest.setExportBusy(true))
    await page.waitForFunction(() => window.connectedAgentTest.workspace().activeTab === 'export')
    assert.equal(await button('Approve').isDisabled(), true)
    await button('Approve').evaluate(node => node.click())
    assert.equal((await snapshot()).calls.filter(call => call.method === 'approveTool' && call.approvalId === 'export-paused-approval').length, 0)
    assert.equal(await tab('Editor').isDisabled(), true, 'Synthetic shell preserves export navigation lock')
    assert.equal(await page.getByTestId('shared-workspace').getAttribute('inert'), '', 'Non-agent editing workspace remains inert')
    assert.equal(await input().inputValue(), 'Unsent draft retained throughout actual export activity.')
    await emit(busyRequest, { type: 'delta', text: 'An already-sent reply can finish during export.' })
    await settle(busyRequest, 'Already-sent review completed while export remained busy.')
    await page.getByText('Already-sent review completed while export remained busy.', { exact: true }).waitFor()
    assert.equal(await button('Send message').isDisabled(), true)
    const duringExport = await snapshot()
    await input().evaluate(node => node.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await frame()
    assert.equal((await snapshot()).requests.length, duringExport.requests.length, 'Imperative submit cannot bypass export guard')
    assert.equal((await snapshot()).calls.filter(call => call.method === 'capture').length, duringExport.calls.filter(call => call.method === 'capture').length)
    assert.ok(!(await snapshot()).calls.some(call => call.method === 'cancel' && call.requestId === busyRequest.requestId))
    await assertIdentity()
    await capture('04-export-busy-persistent-agent')
    await page.evaluate(() => window.connectedAgentTest.setExportBusy(false)); await frame()
    assert.equal(await input().inputValue(), 'Unsent draft retained throughout actual export activity.')
    assert.equal(await button('Send message').isEnabled(), true)
    pass('Actual export activity retains the mounted conversation, draft and sent reply while locking new sends, capture, approvals and workspace editing')

    await tab('Editor').click()
    await page.evaluate(() => window.connectedAgentTest.setHoldCapture(true))
    const beforeBusyCapture = await snapshot()
    await input().fill('Preserve this unsent capture draft if export starts.'); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().calls.filter(call => call.method === 'capture').length > count,
      beforeBusyCapture.calls.filter(call => call.method === 'capture').length)
    // Start and finish export before the held IPC resolves. The preparation
    // epoch must still refuse a send, even though the store is no longer busy.
    await page.evaluate(() => { window.connectedAgentTest.setExportBusy(true); window.connectedAgentTest.setExportBusy(false) })
    await page.evaluate(() => { window.connectedAgentTest.releaseCapture(); window.connectedAgentTest.setHoldCapture(false) })
    await button('Stop response').waitFor({ state: 'hidden' })
    await page.getByText('Export paused this message before it was sent. Your draft is preserved; send it again when export finishes.', { exact: true }).waitFor()
    assert.equal((await snapshot()).requests.length, beforeBusyCapture.requests.length)
    assert.equal(await input().inputValue(), 'Preserve this unsent capture draft if export starts.')
    await assertIdentity()
    pass('A brief export entirely inside held screenshot preparation invalidates the send and preserves the unsent draft')

    for (const width of [900, 760]) {
      await page.setViewportSize({ width, height: 800 })
      for (const name of workspaces) {
        await tab(name).click(); await input().waitFor()
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        await assertReachable(input()); await assertReachable(button('Send message')); await assertReachable(button('Assistant'))
        if (name === 'ComfyUI') await capture(`02-comfyui-narrow-${width}`)
      }
      await openSettings()
      for (const target of [page.getByLabel('Assistant selection', { exact: true }), page.getByLabel('Model', { exact: true }), checkbox('Velorn tools'), checkbox('Share images'), button('Back to chat')]) await assertReachable(target)
      await capture(`03-settings-narrow-${width}`)
      await backToChat(); await assertIdentity()
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    pass('All-workspace composer, rail and scrollable settings remain reachable at 900px and 760px without horizontal overflow')

    await page.getByLabel('Conversation', { exact: true }).selectOption(secondChat)
    assert.equal(await input().inputValue(), 'Second conversation draft survives switching.')
    await page.getByText('Second history stays separate.', { exact: true }).waitFor()
    await assertIdentity()
    await openSettings()
    await page.getByLabel('Assistant selection', { exact: true }).selectOption('lmstudio'); if (await page.getByRole('group', { name: 'Confirm assistant switch' }).count()) await page.getByRole('group', { name: 'Confirm assistant switch' }).getByRole('button', { name: /^Start .* chat$/ }).click()
    await openSettings()
    await page.getByLabel('Model', { exact: true }).selectOption('__custom__')
    await page.getByLabel('Custom model ID', { exact: true }).fill('fixture-local-selected')
    await button('Use model').click()
    await openSettings()
    await checkbox('Velorn tools').check(); await checkbox('Research & setup').check()
    await checkbox('Vision-capable model').check(); await checkbox('Share images').check()
    await backToChat()
    const localRequest = await send('Keep this local-model conversation across all workspaces.')
    assert.equal(localRequest.provider, 'lmstudio'); assert.equal(localRequest.model, 'fixture-local-selected')
    await settle(localRequest, 'Local fixture model history remains separate from Codex.')
    await input().fill('Local-provider draft remains selected.')
    await page.evaluate(() => { window.__workspaceAgentNodes = {
      composer: document.querySelector('textarea[aria-label="Message your agent"]'),
      panel: document.querySelector('.ca-docked'), settings: document.querySelector('.ca-settings'),
    } })
    for (const name of workspaces) {
      await tab(name).click(); await input().waitFor()
      assert.equal(await input().inputValue(), 'Local-provider draft remains selected.')
      await page.getByText('Local fixture model history remains separate from Codex.', { exact: true }).waitFor()
      assert.match(await page.getByLabel('Selected model', { exact: true }).innerText(), /LM Studio.*fixture-local-selected/s)
      await openSettings()
      assert.equal(await page.getByLabel('Assistant selection', { exact: true }).inputValue(), 'lmstudio')
      assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), 'fixture-local-selected')
      assert.equal(await page.getByLabel('Custom model ID', { exact: true }).count(), 0, 'A committed custom choice is selected, not an unsaved draft')
      for (const name of ['Velorn tools', 'Research & setup', 'Vision-capable model', 'Share images']) assert.equal(await checkbox(name).isChecked(), true)
      await backToChat(); await assertIdentity()
    }
    pass('LM Studio provider, exact custom model, independent history, draft and explicit vision/tool permissions also survive every workspace')
    const final = await snapshot()
    assert.deepEqual(final.authored, baseline, 'No project, asset, timeline, selection, dirty or Undo changes')
    assert.deepEqual(final.forbiddenCalls, [])
    assert.deepEqual(blockedRequests, [])
    assert.deepEqual(errors, [])
    pass('Independent chat draft/history still exist and the complete all-workspace run performs no authored writes or external requests')
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, groups, output, errors, blockedRequests }, null, 2))
    console.log('CONNECTED_AGENT_WORKSPACES_RESULT ' + JSON.stringify({ success: true, groups, output }))
  } catch (error) {
    await capture('failure').catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, blockedRequests,
      snapshot: await snapshot().catch(() => null), body: await page.locator('body').innerText().catch(() => '') }, null, 2))
    console.error(`Connected agent workspace fixture artifacts: ${output}`)
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
