// Isolated shared-dock coverage. Uses the real dock/conversation with synthetic
// Inspector, viewer and timeline; never starts App, models, project IO or media.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Dock fixture requires loopback HTTP')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-connected-agent-dock-'))

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
  const openSettings = async () => {
    if (await button('Assistant settings').getAttribute('aria-expanded') !== 'true') await button('Assistant settings').click()
    // These legacy regressions intentionally exercise the individual controls.
    const advanced = page.locator('summary').filter({ hasText: /^Access options$/ })
    if (!(await advanced.evaluate(node => node.parentElement.open))) await advanced.click()
  }
  const backToChat = async () => { if (await button('Back to chat').isVisible()) await button('Back to chat').click() }
  const setting = async (name, method) => {
    await openSettings()
    const result = await page.getByRole('checkbox', { name, exact: true })[method]()
    await backToChat()
    return result
  }
  const allInputs = () => page.locator('textarea[aria-label="Message your agent"]')
  const tab = name => page.getByRole('navigation', { name: 'Fixture workspace modes' }).getByRole('button', { name, exact: true })
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const capture = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const send = async text => {
    const count = (await snapshot()).requests.length
    await input().fill(text); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, count)
    return (await snapshot()).requests.at(-1)
  }
  const emit = (request, text) => page.evaluate(({ requestId, text }) => window.connectedAgentTest.emit(requestId, 'delta', text), { requestId: request.requestId, text })
  const settle = async (request, text) => {
    await page.evaluate(({ requestId, text }) => window.connectedAgentTest.settle(requestId, { success: true, text }), { requestId: request.requestId, text })
    await frame()
  }
  const dockWidth = async () => (await page.getByTestId('right-dock-wrapper').boundingBox()).width
  const assertFullTimeline = async () => {
    const main = await page.getByTestId('fixture-workspace').boundingBox()
    const timeline = await page.getByTestId('fixture-timeline').boundingBox()
    const dock = await page.getByTestId('right-dock-wrapper').boundingBox()
    assert.ok(Math.abs(main.width - timeline.width) <= 1 && Math.abs(main.x - timeline.x) <= 1, 'Timeline spans the complete Editor width in normal height')
    assert.ok(dock.y + dock.height <= timeline.y + 1, 'Normal dock stops above the timeline')
  }
  const assertOneAgent = async (subscriptions = 1) => {
    const state = await snapshot()
    assert.equal(state.listenerCount, 1, 'Exactly one active stream listener')
    assert.equal(state.listenerSubscriptions, subscriptions, 'Dock switches do not remount the conversation')
    assert.equal(state.maxListenerCount, 1, 'Never duplicate active agents/listeners')
    assert.equal(await allInputs().count(), 1, 'One conversation DOM instance in the visible workspace')
  }
  try {
    await page.goto(new URL('/tests/fixtures/connected-agent.html?dock=1', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    const baseline = (await snapshot()).authored
    await page.getByTestId('fixture-inspector').waitFor()
    assert.equal(await button('Inspector').getAttribute('aria-pressed'), 'true')
    assert.equal(await button('Assistant').getAttribute('aria-pressed'), 'false')
    assert.equal((await snapshot()).listenerCount, 0, 'No agent mount or provider access before first selection')
    assert.equal(await page.getByTestId('fixture-titlebar').getByRole('button', { name: /agent/i }).count(), 0, 'Agent entry exists only in the right rail')
    await assertFullTimeline()
    pass('Inspector and Agent share a right rail; Inspector starts selected, Agent is lazy and normal timeline keeps full width')

    await tab('Storyboard').click(); await page.locator('.pr-shot-card').nth(7).waitFor()
    assert.ok(await dockWidth() <= 49, 'Storyboard does not show empty Inspector space')
    await button('Expand right panel').click(); await input().waitFor()
    assert.equal(await button('Assistant').getAttribute('aria-pressed'), 'true', 'Storyboard expand opens the useful Agent pane')
    assert.equal(await button('Inspector').count(), 0, 'Non-editor workspaces expose only the Agent rail')
    await tab('Editor').click(); await button('Inspector').click(); await page.getByTestId('fixture-inspector').waitFor()
    await assertOneAgent(); await assertFullTimeline()
    pass('Storyboard keeps an Agent-only rail instead of an empty Inspector; Editor retains both rail choices')

    await button('Assistant').click(); await input().waitFor()
    await input().fill('Keep this unfinished editorial thought.')
    const initialWidth = await dockWidth()
    await assertOneAgent()
    assert.equal(await page.getByRole('separator', { name: 'Resize agent panel', exact: true }).count(), 0)
    assert.equal(await button('Close assistant panel').count(), 0, 'Docked Agent does not retain its independent close/resize chrome')
    await button('Inspector').click(); await page.getByTestId('fixture-inspector').waitFor()
    assert.equal(await allInputs().isVisible(), false)
    assert.equal(await dockWidth(), initialWidth)
    await button('Assistant').click(); await input().waitFor()
    assert.equal(await input().inputValue(), 'Keep this unfinished editorial thought.')
    await assertOneAgent(); await assertFullTimeline()
    pass('Inspector/Agent selection shows only one pane and preserves the same Agent instance and unsent draft')

    await capture('00-chat-first-dock')
    await openSettings()
    assert.equal(await input().isVisible(), false, 'Settings replace the composer rather than squeezing both into the dock')
    await capture('00-agent-settings')
    await button('Inspector').click(); await button('Assistant').click()
    await button('Back to chat').waitFor()
    await backToChat(); await input().waitFor()
    assert.equal(await input().inputValue(), 'Keep this unfinished editorial thought.')
    assert.equal(await button('Assistant settings').evaluate(node => document.activeElement === node), true)
    assert.equal(await page.getByLabel('Assistant selection', { exact: true }).isVisible(), false)
    await assertOneAgent(); await assertFullTimeline()
    pass('Assistant settings survive dock hiding without remounting; Back restores the same chat draft and gear focus')

    const resize = await page.locator('.fixture-dock-resize').boundingBox()
    await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2)
    await page.mouse.down(); await page.mouse.move(resize.x - 90, resize.y + resize.height / 2, { steps: 6 }); await page.mouse.up()
    const resized = await dockWidth()
    assert.ok(resized > initialWidth + 70, 'Shared resize grows the dock')
    await button('Inspector').click(); assert.equal(await dockWidth(), resized)
    await button('Assistant').click(); assert.equal(await dockWidth(), resized)
    await button('Collapse right panel').click()
    assert.equal(await allInputs().isVisible(), false)
    assert.ok(await dockWidth() <= 49, 'Collapsed dock leaves only its icon rail')
    assert.equal((await snapshot()).listenerCount, 1)
    await assertFullTimeline()
    await button('Expand right panel').click(); await input().waitFor()
    assert.equal(await dockWidth(), resized)
    assert.equal(await input().inputValue(), 'Keep this unfinished editorial thought.')
    await assertOneAgent()
    pass('Both panes reuse one draggable width and collapse control without losing conversation state')

    const hiddenRequest = await send('Continue this response while I inspect the clip.')
    await input().fill('Next question drafted while the response runs.')
    await button('Inspector').click()
    await emit(hiddenRequest, 'The hidden response is streaming.')
    await settle(hiddenRequest, 'Response completed while Inspector was selected.')
    await button('Assistant').click()
    await page.getByText('Response completed while Inspector was selected.', { exact: true }).waitFor()
    assert.equal(await input().inputValue(), 'Next question drafted while the response runs.')
    assert.ok(!(await snapshot()).calls.some(call => call.method === 'cancel' && call.requestId === hiddenRequest.requestId))
    await assertOneAgent()
    pass('A request continues and completes while Inspector is selected, without cancelling, duplicating or dropping its draft')

    const tabRequest = await send('Continue this response across workspace navigation.')
    await emit(tabRequest, 'Editor request moving to Storyboard.')
    await input().fill('A draft that follows the shared dock.')
    await tab('Storyboard').click(); await input().waitFor()
    await page.locator('.pr-shot-card').nth(7).waitFor()
    await page.getByText('Editor request moving to Storyboard.', { exact: true }).waitFor()
    assert.equal(await input().inputValue(), 'A draft that follows the shared dock.')
    assert.equal(await dockWidth(), resized)
    await assertOneAgent()
    await tab('Generate').click()
    assert.equal(await allInputs().count(), 1, 'Other workspaces retain the one visible conversation')
    assert.equal(await allInputs().isVisible(), true)
    assert.equal((await snapshot()).listenerCount, 1, 'All-workspace dock retains its stream')
    await emit(tabRequest, 'Reply progressed in Generate.')
    await settle(tabRequest, 'Workspace navigation kept the single in-flight response.')
    await tab('Editor').click(); await input().waitFor()
    await page.getByText('Workspace navigation kept the single in-flight response.', { exact: true }).waitFor()
    assert.equal(await input().inputValue(), 'A draft that follows the shared dock.')
    assert.ok(!(await snapshot()).calls.some(call => call.method === 'cancel' && call.requestId === tabRequest.requestId))
    await assertOneAgent(); await assertFullTimeline()
    pass('Reparenting between Editor, Storyboard and Generate preserves the visible draft, history and in-flight response')

    await button('Expand right panel to full height').click(); await input().waitFor()
    const fullMain = await page.getByTestId('fixture-workspace').boundingBox()
    const fullTimeline = await page.getByTestId('fixture-timeline').boundingBox()
    const fullDock = await page.getByTestId('right-dock-wrapper').boundingBox()
    assert.ok(fullTimeline.width < fullMain.width - 200 && Math.abs(fullDock.height - fullMain.height) <= 1, 'Explicit full-height preference still works')
    assert.equal(await input().inputValue(), 'A draft that follows the shared dock.')
    await button('Restore right panel height').click(); await input().waitFor()
    for (let i = 0; i < 3; i++) {
      await button('Inspector').click(); await button('Assistant').click()
      await tab('Storyboard').click(); await tab('Editor').click()
    }
    await assertFullTimeline(); await assertOneAgent()
    await capture('00-editor-shared-dock')
    pass('Normal/full-height layout slot changes keep one mounted Agent, preserve its draft and restore the full-width timeline')

    const collapsed = await send('Finish this response while the right dock is collapsed.')
    await input().fill('Preserve this collapsed draft.')
    await button('Collapse right panel').click()
    await emit(collapsed, 'The collapsed response is streaming.')
    await settle(collapsed, 'Collapsed response completed safely.')
    await button('Assistant').click(); await input().waitFor()
    await page.getByText('Collapsed response completed safely.', { exact: true }).waitFor()
    assert.equal(await input().inputValue(), 'Preserve this collapsed draft.')
    assert.ok(!(await snapshot()).calls.some(call => call.method === 'cancel' && call.requestId === collapsed.requestId))
    await assertOneAgent()
    pass('Collapsing is a layout action: the active response and next draft survive, and the Agent rail icon reopens it')

    await setting('Share images', 'check')
    await setting('Include current view', 'check')
    await page.evaluate(() => window.connectedAgentTest.setHoldCapture(true))
    const beforeCapture = await snapshot()
    await input().fill('Do not send this screenshot if I hide Agent during preparation.')
    await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().calls.filter(call => call.method === 'capture').length > count,
      beforeCapture.calls.filter(call => call.method === 'capture').length)
    await button('Inspector').click()
    await page.evaluate(() => window.connectedAgentTest.releaseCapture()); await frame()
    assert.equal((await snapshot()).requests.length, beforeCapture.requests.length, 'Hiding during image preparation cannot initiate an unseen provider request')
    await button('Assistant').click(); await input().waitFor()
    await button('Stop response').waitFor({ state: 'hidden' })
    await page.evaluate(() => window.connectedAgentTest.setHoldCapture(false))
    await setting('Share images', 'uncheck')
    pass('Hiding Agent during asynchronous image preparation refuses the stale send without cancelling already-sent reviews')

    for (const layout of ['dock width', 'full-height workspace resize']) {
      await setting('Share images', 'check')
      assert.equal(await setting('Include current view', 'isChecked'), true)
      await page.evaluate(() => window.connectedAgentTest.setHoldCapture(true))
      const beforeLayout = await snapshot()
      const editorView = await page.evaluate(() => window.connectedAgentTest.editorView())
      await input().fill(`Do not send a stale screenshot after ${layout} changes.`)
      await button('Send message').click()
      await page.waitForFunction(count => window.connectedAgentTest.snapshot().calls.filter(call => call.method === 'capture').length > count,
        beforeLayout.calls.filter(call => call.method === 'capture').length)
      if (layout === 'dock width') {
        const handle = await page.locator('.fixture-dock-resize').boundingBox()
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
        await page.mouse.down(); await page.mouse.move(handle.x - 36, handle.y + handle.height / 2, { steps: 4 }); await page.mouse.up()
      } else {
        await button('Expand right panel to full height').click()
        // Full-height alone can leave the viewer rectangle unchanged. A
        // simultaneous window/layout resize exercises the actual stale region.
        await page.setViewportSize({ width: 1440, height: 900 })
      }
      await frame()
      assert.equal(await page.evaluate(() => window.connectedAgentTest.workspace().activeTab), 'editor')
      assert.deepEqual(await page.evaluate(() => window.connectedAgentTest.editorView()), editorView, 'Only layout geometry changes, not workspace/timeline/session/playhead')
      await page.evaluate(() => window.connectedAgentTest.releaseCapture())
      await page.getByText('The viewer layout changed while capturing its view. Keep the layout steady and send again.', { exact: true }).waitFor()
      await button('Stop response').waitFor({ state: 'hidden' })
      assert.equal((await snapshot()).requests.length, beforeLayout.requests.length, `${layout} during capture must not send stale pixels`)
      await page.evaluate(() => window.connectedAgentTest.setHoldCapture(false))
      await setting('Share images', 'uncheck')
      if (layout !== 'dock width') {
        await page.setViewportSize({ width: 1440, height: 1000 })
        await button('Restore right panel height').click()
      }
      await assertOneAgent(); await assertFullTimeline()
    }
    pass('Held screenshots reject dock-width and full-height workspace geometry changes with zero sends and unchanged timeline identity')

    const exportRequest = await send('Pending review when the export workspace takes over.')
    await input().fill('Export navigation keeps this unsent draft.')
    await tab('Export').click(); await frame()
    await input().waitFor()
    await assertOneAgent()
    assert.ok(!(await snapshot()).calls.some(call => call.method === 'cancel' && call.requestId === exportRequest.requestId))
    await settle(exportRequest, 'Export navigation retained this running review.')
    await page.getByText('Export navigation retained this running review.', { exact: true }).waitFor()
    await tab('Editor').click(); await input().waitFor()
    await page.getByText('Collapsed response completed safely.', { exact: true }).waitFor()
    assert.equal(await input().inputValue(), 'Export navigation keeps this unsent draft.')
    await assertOneAgent()
    pass('Export tab navigation preserves the same running review and unsent draft without cancelling or remounting')

    // Exercise chat and its separate settings view in a narrow upper pane.
    for (const width of [900, 760]) {
      await page.setViewportSize({ width, height: 800 })
      await input().fill(`Narrow dock ${width}`)
      await assertFullTimeline()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No horizontal overflow at ${width}px`)
      for (const target of [input(), button('Send message'), button('Inspector'), button('Assistant')]) {
        const hit = await target.evaluate(node => {
          const box = node.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2
          return { width: box.width, visible: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight,
            unobscured: node.contains(document.elementFromPoint(x, y)) }
        })
        assert.ok(hit.width > 20 && hit.visible && hit.unobscured, `Shared dock control remains reachable at ${width}px`)
      }
      await capture(`01-narrow-${width}`)
      await openSettings()
      for (const target of [page.getByLabel('Assistant selection', { exact: true }), page.getByLabel('Model', { exact: true }),
        button('Check connection'), page.getByRole('checkbox', { name: 'Velorn tools', exact: true }),
        page.getByRole('checkbox', { name: 'Share images', exact: true }), button('Back to chat')]) {
        await target.scrollIntoViewIfNeeded()
        const reachable = await target.evaluate(node => {
          const box = node.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2
          return x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && node.contains(document.elementFromPoint(x, y))
        })
        assert.equal(reachable, true, `Dock settings control remains reachable at ${width}px`)
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await capture(`01-narrow-settings-${width}`)
      await backToChat()
      assert.equal(await input().inputValue(), `Narrow dock ${width}`)
    }
    await input().fill(''); await page.setViewportSize({ width: 1440, height: 1000 })
    await tab('Storyboard').click(); await capture('02-storyboard-shared-dock')
    pass('At 900px and 760px chat, scrollable settings and the normal timeline remain reachable without horizontal overflow')

    await tab('Editor').click(); await page.setViewportSize({ width: 900, height: 680 })
    await input().fill('The composer must remain reachable in a short Editor.')
    for (const target of [input(), button('Send message')]) {
      await target.scrollIntoViewIfNeeded()
      const reachable = await target.evaluate(node => {
        const box = node.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2
        return x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && node.contains(document.elementFromPoint(x, y))
      })
      assert.ok(reachable, 'Short Editor composer and Send remain reachable by scrolling instead of clipping')
    }
    // The current panel keeps history and composer independently scrollable;
    // the outer dock deliberately clips instead of scrolling both together.
    assert.equal(await page.locator('.ca-compose').evaluate(node => getComputedStyle(node).overflowY), 'auto')
    assert.equal(await page.locator('.ca-messages').evaluate(node => getComputedStyle(node).overflowY), 'auto')
    await assertFullTimeline(); await page.setViewportSize({ width: 1440, height: 1000 })
    pass('At 680px window height the dock scrolls its composer and Send into reach while preserving the timeline below')

    const final = await snapshot()
    assert.deepEqual(final.authored, baseline, 'Layout and conversation do not author project/timeline/assets/dirty/Undo state')
    assert.deepEqual(final.forbiddenCalls, [], 'No native project IO, settings, generation or media preparation')
    assert.deepEqual(blockedRequests, [], 'No model, cloud or external requests')
    assert.deepEqual(errors, [], 'No renderer errors')
    assert.equal(final.maxListenerCount, 1)

    for (const kind of ['text', 'mask']) {
      for (const collapsed of [false, true]) {
        // Independent focus requests: the existing text field commits on blur
        // even if unchanged. That legacy edit path is not the reveal under test.
        await page.goto(new URL('/tests/fixtures/connected-agent.html?dock=1&inspector=1', base).href)
        await page.waitForFunction(() => window.connectedAgentTest?.ready)
        await page.getByTestId('single-clip-inspector').waitFor()
        const inspectorBaseline = (await snapshot()).authored
        await button('Assistant').click(); await input().waitFor()
        await input().fill(`Keep draft while ${kind} Inspector is requested${collapsed ? ' from collapsed dock' : ''}.`)
        const draft = await input().inputValue()
        if (collapsed) await button('Collapse right panel').click()
        await page.evaluate(kind => window.connectedAgentTest.requestInspector(kind), kind)
        await page.waitForFunction(() => {
          const state = window.connectedAgentTest.workspace()
          return state.dockTab === 'inspector' && state.open
        })
        assert.equal(await button('Inspector').getAttribute('aria-pressed'), 'true')
        await page.getByTestId('single-clip-inspector').waitFor()
        if (kind === 'text') {
          const text = page.getByPlaceholder('Enter text...', { exact: true })
          await text.waitFor()
          await page.waitForFunction(() => document.activeElement?.getAttribute('placeholder') === 'Enter text...')
          assert.deepEqual(await text.evaluate(node => [node.selectionStart, node.selectionEnd]), [0, 'Synthetic title for Inspector focus'.length])
        }
        await page.waitForFunction(() => {
          const requests = window.connectedAgentTest.inspectorRequests()
          return requests.text === null && requests.mask === null
        })
        await assertOneAgent()
        assert.deepEqual((await snapshot()).authored, inspectorBaseline, 'Inspector reveal/focus consumes only transient requests and authors no clip change')
        await button('Assistant').click(); await input().waitFor()
        assert.equal(await input().inputValue(), draft)
        await button('Inspector').click()
      }
    }
    await capture('03-real-inspector-request-reveal')
    const inspectorFinal = await snapshot()
    assert.deepEqual(inspectorFinal.forbiddenCalls, [], 'Actual Inspector reveal performs no native project IO or generation')
    assert.deepEqual(blockedRequests, [])
    assert.deepEqual(errors, [])
    pass('Actual Inspector text/mask requests select and expand Inspector from active or collapsed Agent, preserve its draft and focus text without authoring edits')

    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, groups, output, errors, blockedRequests }, null, 2))
    console.log('CONNECTED_AGENT_DOCK_RESULT ' + JSON.stringify({ success: true, groups, output }))
  } catch (error) {
    await capture('failure').catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, blockedRequests,
      snapshot: await snapshot().catch(() => null), body: await page.locator('body').innerText().catch(() => '') }, null, 2))
    console.error(`Connected agent dock fixture artifacts: ${output}`)
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
