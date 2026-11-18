// Synthetic renderer-only scroll lifecycle regression. No real provider, native
// project IO, ComfyUI request, authored action or external network is permitted.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Scroll fixture requires loopback HTTP')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-connected-agent-scroll-'))
const workspaces = ['Editor', 'Storyboard', 'Generate', 'Stock', 'ComfyUI', 'Export', 'Discover']

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', serviceWorkers: 'block' })
  const page = await context.newPage(), groups = [], errors = [], blockedRequests = [], measurements = []
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
  const log = () => page.getByRole('log', { name: 'Agent conversation', exact: true })
  const tab = name => page.getByRole('navigation', { name: 'Fixture workspace modes' }).getByRole('button', { name, exact: true })
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const frames = (count = 3) => page.evaluate(count => new Promise(resolve => {
    const next = () => --count <= 0 ? resolve() : requestAnimationFrame(next)
    requestAnimationFrame(next)
  }), count)
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const capture = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
  const position = () => log().evaluate(node => ({ top: node.scrollTop, height: node.clientHeight,
    total: node.scrollHeight, bottomGap: node.scrollHeight - node.clientHeight - node.scrollTop,
    panelTop: node.closest('.ca-docked').scrollTop, pageTop: document.scrollingElement.scrollTop }))
  const assertBottom = async label => {
    await frames(4)
    const current = await position(); measurements.push({ label, ...current })
    assert.ok(current.total > current.height + 1000, 'The fixture must have genuinely scrollable history')
    assert.ok(current.bottomGap <= 2, `${label}: expected bottom, got ${JSON.stringify(current)}`)
    assert.equal(current.panelTop, 0, `${label}: restoring history must not scroll the outer panel`)
    assert.equal(current.pageTop, 0, `${label}: restoring history must not scroll the application page`)
  }
  const assertIdentity = async draft => {
    const state = await snapshot()
    assert.equal(state.listenerCount, 1); assert.equal(state.listenerSubscriptions, 1)
    assert.equal(state.listenerUnsubscriptions, 0); assert.equal(state.maxListenerCount, 1)
    assert.equal(await page.evaluate(() => window.__scrollNodes.log === document.querySelector('.ca-messages')
      && window.__scrollNodes.composer === document.querySelector('textarea[aria-label="Message your agent"]')
      && window.__scrollNodes.panel === document.querySelector('.ca-docked')), true, 'Scroll restoration never replaces the conversation DOM')
    if (draft !== undefined) assert.equal(await input().inputValue(), draft)
  }
  const openSettings = async () => {
    if (await button('Assistant settings').getAttribute('aria-expanded') !== 'true') await button('Assistant settings').click()
    // These legacy regressions intentionally exercise the individual controls.
    const advanced = page.locator('summary').filter({ hasText: /^Access options$/ })
    if (!(await advanced.evaluate(node => node.parentElement.open))) await advanced.click()
  }
  const backToChat = async () => { if (await button('Back to chat').isVisible()) await button('Back to chat').click() }
  const send = async text => {
    const count = (await snapshot()).requests.length
    await input().fill(text); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, count)
    return (await snapshot()).requests.at(-1)
  }
  const settle = async (request, text) => {
    await page.evaluate(({ requestId, text }) => window.connectedAgentTest.settle(requestId, { success: true, text }), { requestId: request.requestId, text })
    await button('Stop response').waitFor({ state: 'hidden' }); await frames()
  }
  const emit = (request, event) => page.evaluate(event => window.connectedAgentTest.emitEvent(event), { requestId: request.requestId, ...event })
  const scrollToOlder = async () => {
    await log().evaluate(node => { node.scrollTop = Math.floor((node.scrollHeight - node.clientHeight) * 0.25) })
    await frames()
    return position()
  }
  const assertApprovalReviewable = async label => {
    await frames(4)
    const result = await log().evaluate(node => {
      const box = node.getBoundingClientRect(), approval = node.querySelector('.ca-tool-approval')
      const heading = approval.querySelector('h3').getBoundingClientRect()
      const warning = approval.querySelector('.ca-tool-warnings').getBoundingClientRect()
      return { top: node.scrollTop, bottomGap: node.scrollHeight - node.clientHeight - node.scrollTop,
        log: { top: box.top, bottom: box.bottom }, heading: { top: heading.top, bottom: heading.bottom },
        warning: { top: warning.top, bottom: warning.bottom } }
    })
    measurements.push({ label, approval: result })
    for (const part of ['heading', 'warning']) assert.ok(result[part].top >= result.log.top && result[part].bottom <= result.log.bottom,
      `${label}: approval ${part} must be visible for review, not merely the bottommost Approve button: ${JSON.stringify(result)}`)
    assert.equal((await snapshot()).calls.filter(call => call.method === 'approveTool').length, 0)
  }
  try {
    await page.goto(new URL('/tests/fixtures/connected-agent.html?dock=1', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    const baseline = (await snapshot()).authored
    await button('Assistant').click(); await input().waitFor()
    for (let turn = 1; turn <= 3; turn++) {
      const request = await send(`Synthetic long transcript turn ${turn}.`)
      const text = Array.from({ length: 44 }, (_, index) => `Review ${turn}, line ${String(index + 1).padStart(2, '0')}: Detailed synthetic editorial context remains available when reading older messages.`).join('\n')
        + `\nLATEST_SYNTHETIC_REPLY_${turn}`
      await settle(request, text)
    }
    await input().fill('Keep this unsent draft while moving between workspaces.')
    const draft = await input().inputValue()
    await page.evaluate(() => { window.__scrollNodes = { log: document.querySelector('.ca-messages'),
      composer: document.querySelector('textarea[aria-label="Message your agent"]'), panel: document.querySelector('.ca-docked') } })
    const history = await log().locator('.ca-message').allTextContents()
    const selectedChat = await page.getByLabel('Conversation', { exact: true }).inputValue()
    // Start from the exact bottom, so the baseline diagnoses a tab transition
    // rather than the legacy scrollIntoView end sentinel's padding tolerance.
    await log().evaluate(node => { node.scrollTop = node.scrollHeight }); await assertBottom('Editor before navigation')
    await tab('Generate').click(); await assertBottom('Editor normal-height → Generate full-height')
    await assertIdentity(draft)
    pass('A long transcript stays at the bottom when moving from the shorter Editor dock into a full-height workspace')

    for (let cycle = 0; cycle < 2; cycle++) {
      for (const name of workspaces) {
        await scrollToOlder()
        await tab(name).click(); await assertBottom(`Workspace cycle ${cycle + 1}: ${name}`)
        await assertIdentity(draft)
        assert.deepEqual(await log().locator('.ca-message').allTextContents(), history)
        assert.equal(await page.getByLabel('Conversation', { exact: true }).inputValue(), selectedChat)
      }
    }
    pass('Every workspace transition returns even manually-scrolled long history to the bottom while retaining exact DOM, selected chat, history and draft')

    for (const height of [1000, 760, 920]) {
      await page.setViewportSize({ width: 1440, height }); await tab('Editor').click()
      await assertBottom(`Editor normal dock at ${height}px`)
      await button('Expand right panel to full height').click(); await assertBottom(`Editor full-height at ${height}px`)
      await tab('Stock').click(); await assertBottom(`Full-height Editor → Stock at ${height}px`)
      await tab('Editor').click(); await assertBottom(`Stock → full-height Editor at ${height}px`)
      await button('Restore right panel height').click(); await assertBottom(`Editor restored shorter dock at ${height}px`)
      await tab('Storyboard').click(); await assertBottom(`Shorter Editor → Storyboard at ${height}px`)
      await assertIdentity(draft)
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    pass('Repeated short/tall Editor and full-height workspace slot changes settle at the bottom after final geometry is established')

    await tab('Discover').click(); await assertBottom('Discover before manual reading')
    await scrollToOlder()
    await log().hover(); await page.mouse.wheel(0, -180); await frames(4)
    const manuallyRead = await position()
    await input().fill(`${draft} Still reading older history.`); await frames(15)
    const afterDraft = await position()
    assert.ok(Math.abs(afterDraft.top - manuallyRead.top) <= 2, 'Ordinary draft rerenders do not fight manual scrolling')
    assert.ok(afterDraft.bottomGap > 1000)
    await input().fill(draft)
    const stillReading = await position(); await frames(15)
    assert.ok(Math.abs((await position()).top - stillReading.top) <= 2, 'Idle frames do not continuously force-scroll the log')
    pass('Manual reading within a workspace stays put during draft edits and idle frames; restoration is not a continuous scroll clamp')

    await openSettings(); await tab('ComfyUI').click(); await button('Back to chat').click()
    await assertBottom('Settings → chat after workspace change'); await assertIdentity(draft)
    await scrollToOlder(); await button('Collapse right panel').click(); await tab('Export').click()
    await button('Expand right panel').click(); await assertBottom('Collapsed → Export → reopened chat'); await assertIdentity(draft)
    await tab('Editor').click(); await scrollToOlder(); await button('Inspector').click(); await button('Assistant').click()
    await assertBottom('Inspector → Agent reveal'); await assertIdentity(draft)
    pass('Returning from settings, a collapsed rail or Inspector reveals the bottom of the same conversation')

    await openSettings(); await page.getByRole('checkbox', { name: 'Velorn tools', exact: true }).check(); await backToChat()
    const pending = await send('Hold a synthetic approval while changing workspaces.')
    await input().fill(draft)
    await emit(pending, { type: 'approval', approvalId: 'scroll-review', toolName: 'edit_timeline',
      arguments: { operation: 'move', clipId: 'fixture-clip', startTime: 2,
        explanation: Array.from({ length: 50 }, (_, index) => `Review this synthetic requested change ${index + 1}.`).join('\n') },
      warnings: ['REVIEW_WARNING: This proposal would change timeline timing; review the full request first.'],
      preview: { changes: ['Synthetic preview only; no authoring occurs.'] } })
    await button('Approve').waitFor(); await assertApprovalReviewable('Incoming approval')
    await emit(pending, { type: 'delta', text: 'A synthetic reply continues, but review the pending action and warning before deciding.' })
    await assertApprovalReviewable('Approval remains priority during streaming')
    for (const name of [...workspaces.slice(1), workspaces[0]]) {
      await log().evaluate(node => { node.scrollTop = 0 })
      await tab(name).click(); await assertApprovalReviewable(`Pending approval in ${name}`)
      await assertIdentity(draft)
    }
    await page.setViewportSize({ width: 1440, height: 760 })
    await assertApprovalReviewable('Pending approval in short Editor dock')
    assert.ok((await position()).bottomGap > 80, 'A tall pending approval must show its warning rather than pinning its action buttons to the bottom')
    await capture('01-pending-approval-review')
    await button('Expand right panel to full height').click(); await assertApprovalReviewable('Pending approval after full-height expansion')
    await button('Restore right panel height').click(); await assertApprovalReviewable('Pending approval after shorter dock restoration')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openSettings(); await tab('Stock').click(); await backToChat(); await assertApprovalReviewable('Pending approval after settings')
    await button('Collapse right panel').click(); await tab('Generate').click(); await button('Expand right panel').click()
    await assertApprovalReviewable('Pending approval after collapse')
    await button('Deny').click(); await button('Deny').waitFor({ state: 'hidden' })
    await settle(pending, 'Synthetic approval explicitly denied; no changes made.')
    await assertBottom('Completed reply after denied approval'); await assertIdentity(draft)
    pass('A pending approval takes precedence over bottom scrolling: action heading and warnings remain reviewable across tabs, settings and collapse')

    await openSettings()
    await button('Full access').click()
    await page.waitForFunction(() => Boolean(window.connectedAgentTest.snapshot().fullAccessGrant))
    assert.equal(await page.locator('.ca-full-access-badge').count(), 0)
    await backToChat()
    assert.equal(await page.locator('.ca-full-access-badge').isVisible(), false)
    assert.equal(await page.getByTestId('agent-approval-status').isVisible(), false)
    for (const height of [1000, 760, 600]) {
      await page.setViewportSize({ width: 1440, height })
      await tab('Editor').click(); await frames(4)
      await input().evaluate(node => { node.style.height = '130px' })
      await frames(4)
      const geometry = await page.locator('.ca-docked').evaluate(node => {
        const rect = node.getBoundingClientRect(), header = node.querySelector('.ca-header').getBoundingClientRect()
        const form = node.querySelector('.ca-compose').getBoundingClientRect()
        return { overflow: getComputedStyle(node).overflowY, top: node.scrollTop, total: node.scrollHeight,
          height: node.clientHeight, headerTop: header.top, panelTop: rect.top, panelBottom: rect.bottom, formBottom: form.bottom,
          regions: ['.ca-chat', '.ca-messages', '.ca-compose', '.ca-conversations'].map(selector => {
            const child = node.querySelector(selector), style = getComputedStyle(child)
            return { selector, height: child.clientHeight, scroll: child.scrollHeight, flex: style.flex, min: style.minHeight, max: style.maxHeight }
          }) }
      })
      assert.notEqual(geometry.overflow, 'auto', 'Outer Agent panel must not be a second wheel scroll surface')
      assert.ok(geometry.formBottom <= geometry.panelBottom + 1, `Composer stays inside the dock: ${JSON.stringify(geometry)}`)
      const footer = page.locator('.ca-send-row')
      await footer.hover(); await page.mouse.wheel(0, 900); await frames(10)
      assert.equal((await position()).panelTop, 0, 'Wheel over footer must not move the whole chat')
      assert.equal(await page.locator('.ca-header').evaluate(node => node.getBoundingClientRect().top), geometry.headerTop)
      await log().evaluate(node => { node.scrollTop = Math.floor((node.scrollHeight - node.clientHeight) / 2) })
      const before = await position()
      await log().hover(); await page.mouse.wheel(0, -180); await frames(10)
      assert.ok((await position()).top < before.top, 'History still scrolls independently')
    }
    await capture('03-full-access-single-scroll')
    await input().evaluate(node => { node.style.height = '' })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await openSettings()
    await page.locator('.ca-settings-scroll').hover(); await page.mouse.wheel(0, 900); await frames(10)
    assert.ok(await page.locator('.ca-settings-scroll').evaluate(node => node.scrollTop > 0))
    assert.equal(await page.locator('.ca-docked').evaluate(node => node.scrollTop), 0)
    await backToChat()
    pass('Full-access chat has no permanent access banners; composer footer wheel cannot scroll the outer dock, while history and settings scroll independently')

    const final = await snapshot()
    assert.deepEqual(final.authored, baseline)
    assert.deepEqual(final.forbiddenCalls, []); assert.deepEqual(blockedRequests, []); assert.deepEqual(errors, [])
    assert.deepEqual(final.calls.filter(call => call.method === 'approveTool').map(call => [call.approvalId, call.approved]), [['scroll-review', false]])
    await capture('02-final-bottom')
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, groups, measurements, output, errors, blockedRequests }, null, 2))
    console.log('CONNECTED_AGENT_SCROLL_RESULT ' + JSON.stringify({ success: true, groups, output }))
  } catch (error) {
    await capture('failure').catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, groups, measurements, errors, blockedRequests,
      snapshot: await snapshot().catch(() => null), body: await page.locator('body').innerText().catch(() => '') }, null, 2))
    console.error(`Connected agent scroll fixture artifacts: ${output}`)
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
