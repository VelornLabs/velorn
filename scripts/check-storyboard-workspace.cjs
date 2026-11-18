// Real shell components + workspace hook; project files/preferences remain in
// fixture RAM. No App import, native app, actual generation or external service.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Workspace fixture requires loopback HTTP')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-storyboard-workspace-'))

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', serviceWorkers: 'block' })
  await context.addInitScript(() => {
    window.fixtureMediaCalls = []
    for (const method of ['play', 'load']) {
      const original = HTMLMediaElement.prototype[method]
      HTMLMediaElement.prototype[method] = function (...args) {
        window.fixtureMediaCalls.push({ method, tag: this.tagName }); return original.apply(this, args)
      }
    }
    window.fixtureEscapedKeys = []
    document.addEventListener('keydown', event => window.fixtureEscapedKeys.push(event.key))
  })
  const page = await context.newPage(), groups = [], errors = [], blockedRequests = []
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    const endpoint = /^\/(?:prompt|queue|interrupt|system_stats|history|upload|view|ws)(?:\/|$)/.test(url.pathname)
    if (url.origin === base.origin && !endpoint) return route.continue()
    blockedRequests.push(url.href); return route.abort()
  })
  await page.routeWebSocket(() => true, socket => socket.close())
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const nav = () => page.getByRole('navigation', { name: 'Workspace modes' })
  const tab = name => nav().getByRole('button', { name, exact: true })
  const button = name => page.getByRole('button', { name, exact: true })
  const wall = () => page.locator('.production-workspace')
  const cards = () => wall().locator('.pr-shot-card')
  const snapshot = () => page.evaluate(() => window.storyboardWorkspaceTest.snapshot())
  const workspace = () => page.evaluate(() => window.storyboardWorkspaceTest.workspace())
  const rpc = (action, payload = {}) => page.evaluate(({ action, payload }) => window.storyboardWorkspaceTest.runMcpAction(action, payload), { action, payload })
  const reset = options => page.evaluate(options => window.storyboardWorkspaceTest.reset(options), options)
  const apply = async request => {
    const preview = await rpc('edit_storyboard', request)
    assert.equal(preview.previewOnly, true)
    assert.ok(preview.suggestedApplyPayload.previewToken && preview.suggestedApplyPayload.expectedContext)
    return rpc('edit_storyboard', preview.suggestedApplyPayload)
  }
  const openFromMenu = async () => { await button('Velorn').click(); await button('Open storyboard').click(); await wall().waitFor() }
  const capture = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
  const viewUnchanged = async before => {
    const after = await snapshot()
    for (const key of ['raw', 'historyCount', 'futureCount', 'dirty', 'timeline', 'calls', 'filePaths', 'preferences']) {
      assert.deepEqual(after[key], before[key], `View navigation does not change ${key}`)
    }
  }
  const safe = async () => {
    assert.deepEqual((await snapshot()).forbiddenCalls, [])
    assert.deepEqual(blockedRequests, [], 'No generation/model/cloud/external requests')
    assert.deepEqual(errors, [], 'No renderer errors')
    assert.deepEqual(await page.evaluate(() => window.fixtureMediaCalls), [], 'The board does not load or play media')
    assert.equal(await page.locator('audio, video').count(), 0)
  }
  try {
    await page.goto(new URL('/tests/fixtures/storyboard-workspace.html', base).href)
    await page.waitForFunction(() => window.storyboardWorkspaceTest?.ready)
    await tab('Editor').waitFor()
    const empty = await snapshot()
    assert.equal((await workspace()).activeTab, 'editor')
    assert.equal(await tab('Storyboard').count(), 0)
    assert.equal(empty.raw, undefined); assert.equal(empty.historyCount, 0); assert.equal(empty.dirty, false)
    await button('Velorn').click(); await button('Open storyboard').waitFor(); await button('Velorn').click()
    await viewUnchanged(empty)
    pass('A project without storyboard content starts in Editor with no Storyboard tab; the Velorn menu always offers Open storyboard')

    await openFromMenu()
    await page.getByText('Your references and storyboard will appear here.', { exact: true }).waitFor()
    assert.equal((await workspace()).activeTab, 'storyboard')
    assert.equal(await tab('Storyboard').getAttribute('aria-current'), 'page')
    assert.equal(await button('Expand board').count(), 0)
    assert.equal(await button('Collapse board').count(), 0)
    assert.equal(await wall().getAttribute('role'), null)
    assert.equal(await wall().getAttribute('aria-modal'), null)
    await button('Back to editor').click()
    await page.waitForFunction(() => !window.storyboardWorkspaceTest.workspace().showStoryboardTab)
    await openFromMenu()
    await wall().getByRole('region', { name: 'References and storyboard' }).focus()
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.storyboardWorkspaceTest.workspace().activeTab === 'editor')
    assert.equal(await tab('Storyboard').count(), 0)
    await viewUnchanged(empty)
    pass('Menu entry intentionally opens an empty full-page board; Back and Escape return to Editor and hide it again without writing project or preferences')

    await reset({ populated: true })
    await tab('Storyboard').waitFor()
    assert.deepEqual(await nav().getByRole('button').allTextContents(), ['Storyboard', 'Editor', 'Generate', 'Stock', 'ComfyUI', 'Export', 'Discover'])
    assert.equal((await workspace()).activeTab, 'editor', 'Existing content reveals navigation without stealing focus')
    const populated = await snapshot()
    await tab('Storyboard').click(); await cards().nth(7).waitFor()
    for (const section of ['Characters', 'Locations', 'References', 'Storyboard']) await wall().getByRole('region', { name: section, exact: true }).waitFor()
    const bounds = await page.evaluate(() => {
      const board = document.querySelector('.production-workspace').getBoundingClientRect()
      const content = document.querySelector('[data-testid="workspace-content"]').getBoundingClientRect()
      return { board: { x: board.x, y: board.y, width: board.width, height: board.height }, content: { x: content.x, y: content.y, width: content.width, height: content.height } }
    })
    assert.deepEqual(bounds.board, bounds.content, 'Board fills all space between title and bottom bars')
    assert.ok(bounds.board.height > 800)
    assert.equal(await button('Default layout').count(), 0)
    await viewUnchanged(populated); await capture('01-populated-full-workspace')
    pass('Populated project reveals Storyboard immediately before Editor, without automatic navigation, and the board uses the complete workspace')

    await cards().first().click()
    await page.evaluate(() => { window.fixtureEscapedKeys.length = 0 })
    for (const key of ['Enter', 'Space', 'ArrowRight', 'ArrowLeft', 'Delete', 'Backspace', 'Control+z', 'Control+Shift+z']) await page.keyboard.press(key)
    assert.deepEqual(await page.evaluate(() => window.fixtureEscapedKeys), [], 'Board keys do not reach editor/transport listeners')
    assert.equal(await wall().locator('input, textarea, select, form, [contenteditable="true"], [role="tablist"], video, audio').count(), 0)
    assert.equal(await cards().locator('button, [role="button"], [tabindex="0"]').count(), 0)
    assert.equal(await wall().getByRole('button').count(), 1, 'Only Back to editor is a board button')
    await wall().getByRole('region', { name: 'References and storyboard' }).focus()
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.production-workspace'))), false, 'Full workspace does not trap focus like a modal')
    await viewUnchanged(populated)
    pass('Cards remain read-only; focused board keyboard shortcuts do not edit the hidden timeline, and normal Tab navigation is not trapped')

    await tab('Editor').click(); await reset({ root: 'beta' })
    await page.waitForFunction(() => !window.storyboardWorkspaceTest.workspace().showStoryboardTab)
    const beforeMcp = await snapshot()
    await rpc('get_storyboard'); await viewUnchanged(beforeMcp)
    const preview = await rpc('edit_storyboard', { operation: 'add_shot', shot: { title: 'Added through guarded MCP', durationSeconds: 5 } })
    assert.equal(preview.previewOnly, true); assert.equal(await tab('Storyboard').count(), 0)
    await rpc('edit_storyboard', preview.suggestedApplyPayload)
    await tab('Storyboard').waitFor(); assert.equal((await workspace()).activeTab, 'editor')
    assert.equal((await snapshot()).historyCount, 1)
    await button('Undo').click()
    await page.waitForFunction(() => !window.storyboardWorkspaceTest.workspace().showStoryboardTab)
    await button('Redo').click(); await tab('Storyboard').waitFor()
    await tab('Storyboard').click(); await cards().first().waitFor()
    await button('Undo').click()
    await page.getByText('Your references and storyboard will appear here.', { exact: true }).waitFor()
    assert.equal((await workspace()).activeTab, 'storyboard', 'Removing last content does not eject an open board')
    await button('Back to editor').click()
    await page.waitForFunction(() => !window.storyboardWorkspaceTest.workspace().showStoryboardTab)
    pass('Guarded MCP preview/read does not reveal the tab; apply does without navigation, real BottomBar Undo/Redo updates it, and last-content removal stays open until leaving')

    await reset({ raw: { version: 1, title: 'Configured project', brief: '', songAssetId: null, shots: [] } })
    await tab('Storyboard').waitFor()
    assert.equal((await workspace()).activeTab, 'editor')
    await tab('Storyboard').click(); await button('Back to editor').click()
    assert.equal(await tab('Storyboard').count(), 1, 'Meaningful board configuration stays visible without shots')
    await reset({ raw: { version: 1, title: 'Storyboard', brief: '', songAssetId: null, shots: [], nextShotNumber: 6 } })
    await page.waitForFunction(() => !window.storyboardWorkspaceTest.workspace().showStoryboardTab)
    pass('Meaningfully configured boards are available before shots, while materialized defaults and retained label counters alone stay hidden')

    await reset({ populated: true })
    await tab('Storyboard').click(); await cards().nth(7).waitFor()
    const toSave = (await snapshot()).raw
    await button('Save').click()
    const saved = await page.evaluate(() => window.storyboardWorkspaceTest.saved())
    assert.deepEqual(saved.storyboard, toSave)
    await page.evaluate(() => window.storyboardWorkspaceTest.close())
    await page.getByTestId('project-selection').waitFor()
    assert.equal(await tab('Storyboard').count(), 0)
    await button('Velorn').click(); assert.equal(await button('Open storyboard').count(), 0); await button('Velorn').click()
    await page.evaluate(() => window.storyboardWorkspaceTest.reopen())
    await tab('Storyboard').waitFor()
    assert.equal((await workspace()).activeTab, 'editor', 'Reopening a populated project does not reopen a prior selected board')
    assert.deepEqual((await snapshot()).raw, toSave)
    await tab('Storyboard').click(); await cards().nth(7).waitFor()
    pass('Real project Save, Close and Open round-trip the board through fixture RAM; reopen reveals the tab without restoring stale workspace selection')

    await reset({ root: 'beta' })
    await page.waitForFunction(() => window.storyboardWorkspaceTest.workspace().activeTab === 'editor')
    assert.equal(await wall().count(), 0); assert.equal(await tab('Storyboard').count(), 0)
    await openFromMenu(); await reset({ root: 'alpha' })
    await page.waitForFunction(() => window.storyboardWorkspaceTest.workspace().activeTab === 'editor')
    assert.equal(await tab('Storyboard').count(), 0, 'Manual empty visibility does not cross projects')
    await openFromMenu()
    await page.evaluate(() => window.storyboardWorkspaceTest.setLoading(true))
    await page.waitForFunction(() => window.storyboardWorkspaceTest.workspace().activeTab === 'editor')
    await page.evaluate(() => window.storyboardWorkspaceTest.setLoading(false))
    assert.equal(await tab('Storyboard').count(), 0, 'Reloading same handle clears manual empty visibility')
    pass('Switching populated-to-empty or manually-open-empty-to-empty projects clears both transient tab visibility and stale board selection, including same-handle loading')

    const future = { version: 999, shots: [], unknownFutureData: { keep: 'untouched' } }
    await reset({ raw: future })
    await tab('Storyboard').waitFor(); await tab('Storyboard').click()
    await wall().getByRole('alert').waitFor()
    assert.deepEqual((await snapshot()).raw, future)
    await button('Back to editor').click()
    assert.equal(await tab('Storyboard').count(), 1)
    pass('Unsupported saved board data remains visible for its read-only explanation and is never normalized or discarded by navigation')

    await reset({ populated: true })
    await page.evaluate(() => window.storyboardWorkspaceTest.setDisabled(true))
    await page.waitForFunction(() => window.storyboardWorkspaceTest.workspace().disabled)
    assert.equal(await tab('Storyboard').isDisabled(), true)
    await page.evaluate(() => window.storyboardWorkspaceTest.selectTab('storyboard'))
    assert.equal((await workspace()).activeTab, 'editor')
    await button('Velorn').click(); assert.equal(await button('Open storyboard').count(), 0); await button('Velorn').click()
    await page.evaluate(() => window.storyboardWorkspaceTest.setDisabled(false))
    await page.waitForFunction(() => !window.storyboardWorkspaceTest.workspace().disabled)
    await tab('Storyboard').click(); await cards().nth(7).waitFor()
    pass('Export-busy disabled guard blocks workspace/menu entry; normal navigation works again after release')

    await page.evaluate(() => window.storyboardWorkspaceTest.setCrowdedTitlebar(true))
    for (const width of [1100, 900, 760]) {
      await page.setViewportSize({ width, height: 800 })
      await tab('Storyboard').focus()
      for (const name of ['Editor', 'Generate', 'Stock', 'ComfyUI', 'Export', 'Discover']) {
        await page.keyboard.press('Tab')
        await page.waitForFunction(name => {
          const node = [...document.querySelectorAll('nav[aria-label="Workspace modes"] button')].find(item => item.textContent.trim() === name)
          const box = node?.getBoundingClientRect()
          return box && node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
        }, name, { timeout: 2000 })
        const focus = await tab(name).evaluate(node => {
          const box = node.getBoundingClientRect()
          return { focused: document.activeElement === node,
            unobscured: node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) }
        })
        assert.equal(focus.focused, true, `${name} is keyboard reachable at ${width}px`)
        assert.equal(focus.unobscured, true, `Keyboard focus scrolls ${name} into view at ${width}px`)
      }
      for (const name of ['Storyboard', 'Editor', 'Discover', 'Storyboard']) {
        await tab(name).click()
        assert.equal(await tab(name).getAttribute('aria-current'), 'page')
        const hit = await tab(name).evaluate(node => {
          const box = node.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2
          return { unobscured: node.contains(document.elementFromPoint(x, y)), x, width: innerWidth }
        })
        assert.equal(hit.unobscured, true, `${name} is not covered by status chips at ${width}px`)
        assert.ok(hit.x > 0 && hit.x < hit.width)
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      const overflow = await wall().getByRole('region', { name: 'References and storyboard' }).evaluate(node => ({ horizontal: node.scrollWidth > node.clientWidth, vertical: node.scrollHeight > node.clientHeight }))
      assert.equal(overflow.horizontal, false); assert.equal(overflow.vertical, true)
      await capture(`02-narrow-${width}`)
    }
    pass('At 1100, 900 and 760px the real titlebar remains pointer and keyboard reachable beside credits, launcher and monitor chips; board content scrolls vertically without horizontal overflow')

    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.evaluate(() => window.storyboardWorkspaceTest.setCrowdedTitlebar(false))
    await capture('03-final-workspace'); await safe()
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, groups, output, errors, blockedRequests, workspace: await workspace(), snapshot: await snapshot() }, null, 2))
    console.log('STORYBOARD_WORKSPACE_RESULT ' + JSON.stringify({ success: true, groups, output }))
  } catch (error) {
    await capture('failure').catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, blockedRequests, workspace: await workspace().catch(() => null),
      snapshot: await snapshot().catch(() => null), body: await page.locator('body').innerText().catch(() => '') }, null, 2))
    console.error(`Storyboard workspace fixture artifacts: ${output}`)
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
