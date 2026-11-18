// Renderer-only activity feedback: deterministic provider, image and approval
// promises. No real model, tool execution, ComfyUI service or project writes.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Activity fixture requires loopback HTTP')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-connected-agent-activity-'))
const labels = { preparing: 'Preparing message…', working: 'Working…', tool: 'Using Velorn tools…',
  approval: 'Waiting for your approval', decision: 'Submitting your decision…' }
const workspaces = ['Editor', 'Storyboard', 'Generate', 'Stock', 'ComfyUI', 'Export', 'Discover']

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', serviceWorkers: 'block', reducedMotion: 'no-preference' })
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
  const activity = () => page.getByTestId('agent-activity')
  const tab = name => page.getByRole('navigation', { name: 'Fixture workspace modes' }).getByRole('button', { name, exact: true })
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const frames = (count = 3) => page.evaluate(count => new Promise(resolve => {
    const next = () => --count <= 0 ? resolve() : requestAnimationFrame(next)
    requestAnimationFrame(next)
  }), count)
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const capture = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
  const openSettings = async () => {
    if (await button('Assistant settings').getAttribute('aria-expanded') !== 'true') await button('Assistant settings').click()
    // These legacy regressions intentionally exercise the individual controls.
    const more = page.locator('.ca-more-options > summary')
    if (!(await more.evaluate(node => node.parentElement.open))) await more.click()
    const advanced = page.locator('summary').filter({ hasText: /^Access options$/ })
    if (!(await advanced.evaluate(node => node.parentElement.open))) await advanced.click()
  }
  const backToChat = async () => { if (await button('Back to chat').isVisible()) await button('Back to chat').click() }
  const assertActivity = async (state, animated = state !== 'approval') => {
    await activity().waitFor(); await frames()
    assert.equal(await activity().getAttribute('data-state'), state)
    assert.ok((await activity().innerText()).includes(labels[state]))
    assert.equal(await activity().count(), 1, 'One compact activity indicator, not duplicate chat/settings instances')
    const wave = activity().locator('.ca-stellar-wave')
    assert.equal(await wave.count(), state === 'approval' ? 0 : 1)
    if (state !== 'approval') {
      assert.equal(await wave.getAttribute('aria-hidden'), 'true')
      assert.equal(await wave.locator('i').count(), 5)
      const style = await wave.locator('i').first().evaluate(node => {
        const css = getComputedStyle(node)
        return { animation: css.animationName, duration: parseFloat(css.animationDuration), shadow: css.boxShadow }
      })
      assert.equal(style.animation, animated ? 'ca-stellar-wave' : 'none')
      if (animated) assert.ok(Math.abs(style.duration - 1.9 / 1.5) < .0001, 'Chosen 1.5x speed')
      assert.match(style.shadow, /8\.16px/, 'Chosen glow scales with the 1.5x larger wave')
    }
    const animations = await activity().evaluate(node => node.getAnimations({ subtree: true })
      .filter(animation => animation.playState === 'running' && Number(animation.effect.getTiming().duration) > 1).length)
    assert.equal(animations > 0, animated, `${state} uses ${animated ? 'a live animation' : 'a static, nonspinning indication'}`)
  }
  const assertIdle = async () => {
    await activity().waitFor({ state: 'detached' })
    assert.equal(await button('Stop response').count(), 0)
  }
  const send = async text => {
    await backToChat()
    const count = (await snapshot()).requests.length
    await input().fill(text); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, count)
    return (await snapshot()).requests.at(-1)
  }
  const settle = async (request, result) => {
    await page.evaluate(({ requestId, result }) => window.connectedAgentTest.settle(requestId, result), { requestId: request.requestId, result })
    await frames()
  }
  const emit = (request, event) => page.evaluate(event => window.connectedAgentTest.emitEvent(event), { requestId: request.requestId, ...event })
  const assertOneAgent = async () => {
    const state = await snapshot()
    assert.equal(state.listenerCount, 1); assert.equal(state.listenerSubscriptions, 1)
    assert.equal(state.listenerUnsubscriptions, 0); assert.equal(state.maxListenerCount, 1)
    assert.equal(await page.locator('textarea[aria-label="Message your agent"]').count(), 1)
    assert.equal(await page.evaluate(() => window.__activityNodes.composer === document.querySelector('textarea[aria-label="Message your agent"]')), true, 'Composer remains the same DOM across workspace/settings navigation')
    assert.equal(await activity().count(), 1, 'Only one status is mounted, in the currently visible footer')
    assert.equal(await activity().evaluate(node => Boolean(node.closest('.ca-compose, .ca-settings-running'))), true)
  }
  try {
    await page.goto(new URL('/tests/fixtures/connected-agent.html?dock=1', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    const baseline = (await snapshot()).authored
    assert.equal(await activity().count(), 0, 'Lazy/closed Agent never implies work')
    await button('Assistant').click(); await input().waitFor(); await assertIdle()
    await openSettings()
    await page.getByLabel('Model', { exact: true }).selectOption('fixture-codex-fast')
    await openSettings()
    await page.getByRole('checkbox', { name: 'Velorn tools', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Share images', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Include current view', exact: true }).check()
    await backToChat(); await assertIdle()
    pass('The indicator is absent when the Agent is closed or idle, including model discovery and settings changes')

    await page.evaluate(() => window.connectedAgentTest.setHoldCapture(true))
    const beforePreparation = await snapshot()
    await input().fill('Prepare one synthetic editor still before the fixture response.'); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().calls.filter(call => call.method === 'capture').length > count,
      beforePreparation.calls.filter(call => call.method === 'capture').length)
    await assertActivity('preparing')
    assert.equal((await snapshot()).requests.length, beforePreparation.requests.length, 'Preparing feedback does not imply a model request was sent')
    assert.match(await page.getByLabel('Selected model', { exact: true }).innerText(), /fixture-codex-fast/)
    assert.equal(await page.locator('.ca-message[aria-busy="true"] .ca-requested-model').innerText(), 'Requested model: fixture-codex-fast · Thinking: Medium')
    await capture('01-preparing-message')
    await page.evaluate(() => { window.connectedAgentTest.releaseCapture(); window.connectedAgentTest.setHoldCapture(false) })
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, beforePreparation.requests.length)
    const first = (await snapshot()).requests.at(-1)
    assert.equal(first.model, 'fixture-codex-fast')
    await assertActivity('working'); await frames(15); await assertActivity('working')
    pass('Held image preparation visibly animates before Send reaches the provider, then working feedback persists before the first token')

    await emit(first, { type: 'delta', text: 'Partial response appears, followed by a quiet synthetic work gap.' })
    await page.getByText('Partial response appears, followed by a quiet synthetic work gap.', { exact: true }).waitFor()
    await emit(first, { type: 'status', text: 'Synthetic provider is doing more work after its partial response.' })
    await assertActivity('working'); await frames(15); await assertActivity('working')
    assert.match(await page.getByLabel('Selected model', { exact: true }).innerText(), /fixture-codex-fast/)
    assert.equal(await page.locator('.ca-message[aria-busy="true"] .ca-requested-model').innerText(), 'Requested model: fixture-codex-fast · Thinking: Medium')
    await page.evaluate(() => { window.__activityNodes = {
      composer: document.querySelector('textarea[aria-label="Message your agent"]'), activity: document.querySelector('[data-testid="agent-activity"]'),
    } })
    await input().fill('Next draft stays unchanged beside background activity.')
    await capture('02-partial-response-working-gap')
    pass('The working animation remains visible after partial text and status events instead of disappearing during a quiet gap; exact model labels stay unchanged')

    for (const name of workspaces) {
      await tab(name).click(); await assertActivity('working'); await assertOneAgent()
      assert.equal(await input().inputValue(), 'Next draft stays unchanged beside background activity.')
      await openSettings(); await assertActivity('working')
      assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), 'fixture-codex-fast')
      assert.equal(await button('Stop response').count(), 1, 'Settings retain one usable Stop action')
      await assertOneAgent(); await backToChat()
    }
    await openSettings(); await capture('03-working-in-settings'); await backToChat()
    pass('One busy indicator survives settings and all seven workspace changes alongside the same conversation, live turn, selected model and draft')

    await emit(first, { type: 'tool', callId: 'activity-tool', toolName: 'get_project', status: 'running', summary: 'Synthetic tool is running.' })
    await assertActivity('tool'); await frames(15); await assertActivity('tool')
    await emit(first, { type: 'tool', callId: 'activity-tool', toolName: 'get_project', status: 'completed', summary: 'Synthetic inspection finished.' })
    await assertActivity('working'); await frames(15); await assertActivity('working')
    pass('Running tools have distinct animated feedback; a completed tool returns to Working while the same reply continues without more tokens')

    await emit(first, { type: 'tool', callId: 'activity-approval-tool', toolName: 'edit_timeline', status: 'running', summary: 'Synthetic proposal needs a decision.' })
    await emit(first, { type: 'approval', approvalId: 'activity-approval', toolName: 'edit_timeline',
      arguments: { operation: 'move', clipId: 'fixture-clip', startTime: 2 }, warnings: ['Synthetic review warning: no edit occurs in this fixture.'] })
    await button('Approve').waitFor(); await assertActivity('approval')
    assert.equal((await snapshot()).calls.filter(call => call.method === 'approveTool').length, 0, 'Activity feedback never answers an approval')
    await openSettings(); await assertActivity('approval'); await backToChat()
    await capture('04-waiting-for-approval')
    await page.evaluate(() => window.connectedAgentTest.setHoldApproval(true))
    await button('Deny').click()
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().calls.some(call => call.method === 'approveTool' && call.approvalId === 'activity-approval'))
    await assertActivity('decision')
    assert.equal(await button('Approve').isDisabled(), true); assert.equal(await button('Deny').isDisabled(), true)
    await page.evaluate(() => { window.connectedAgentTest.releaseApproval(); window.connectedAgentTest.setHoldApproval(false) })
    await button('Approve').waitFor({ state: 'hidden' })
    await assertActivity('tool')
    await emit(first, { type: 'tool', callId: 'activity-approval-tool', toolName: 'edit_timeline', status: 'denied', summary: 'Synthetic change was explicitly denied.' })
    await assertActivity('working')
    assert.deepEqual((await snapshot()).calls.filter(call => call.method === 'approveTool').map(call => [call.approvalId, call.approved]), [['activity-approval', false]])
    pass('Pending approval overrides tool animation with a static waiting state; only explicit Deny starts the animated decision-submission state')

    await page.emulateMedia({ reducedMotion: 'reduce' }); await frames(); await assertActivity('working', false)
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true)
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await frames(); await assertActivity('working')
    await page.setViewportSize({ width: 760, height: 760 }); await tab('Editor').click(); await assertActivity('working')
    const reachable = await activity().evaluate(node => {
      const box = node.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2
      return box.width > 50 && box.height > 10 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && node.contains(document.elementFromPoint(x, y))
    })
    assert.equal(reachable, true, 'Activity feedback remains visible in a narrow, shorter Editor dock')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await capture('05-narrow-working')
    await page.setViewportSize({ width: 1440, height: 1000 })
    pass('Reduced motion keeps readable activity text without animation, and the indicator remains visible in a narrow short dock')

    await settle(first, { success: true, text: 'Synthetic response completed after background work.' }); await assertIdle()
    await page.getByText('Synthetic response completed after background work.', { exact: true }).waitFor()
    assert.equal(await input().inputValue(), 'Next draft stays unchanged beside background activity.')
    assert.equal(await page.locator('.ca-assistant .ca-requested-model').last().innerText(), 'Requested model: fixture-codex-fast · Thinking: Medium')
    pass('Successful completion removes the activity indicator while keeping the next draft, reply and frozen requested-model label')

    await tab('Discover').click()
    const stopped = await send('Stop this synthetic quiet response.')
    await assertActivity('working'); await openSettings(); await button('Stop response').click(); await assertIdle(); await backToChat()
    await emit(stopped, { type: 'delta', text: 'STALE_ACTIVITY_RESPONSE_MUST_NOT_APPEAR' })
    await settle(stopped, { success: true, text: 'STALE_ACTIVITY_RESPONSE_MUST_NOT_APPEAR' }); await assertIdle()
    assert.ok(!(await page.locator('body').innerText()).includes('STALE_ACTIVITY_RESPONSE'))
    const failed = await send('Surface this synthetic provider error.')
    await assertActivity('working')
    await settle(failed, { success: false, error: 'Synthetic activity provider failure.' }); await assertIdle()
    await page.getByRole('alert').filter({ hasText: 'Synthetic activity provider failure.' }).waitFor()
    pass('Stop from settings and provider failure both clear activity; late cancelled events cannot restart it')

    await tab('Editor').click()
    await page.evaluate(() => window.connectedAgentTest.setHoldCapture(true))
    const beforeStoppedCapture = await snapshot()
    await input().fill('Stop during held image preparation.'); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().calls.filter(call => call.method === 'capture').length > count,
      beforeStoppedCapture.calls.filter(call => call.method === 'capture').length)
    await assertActivity('preparing'); await button('Stop response').click(); await assertIdle()
    await page.evaluate(() => { window.connectedAgentTest.releaseCapture(); window.connectedAgentTest.setHoldCapture(false) })
    await frames(8); await assertIdle()
    assert.equal((await snapshot()).requests.length, beforeStoppedCapture.requests.length)
    assert.equal(await input().inputValue(), 'Stop during held image preparation.')
    pass('Stopping image preparation removes feedback immediately, retains the unsent draft and never starts a late provider request')

    const final = await snapshot()
    assert.deepEqual(final.authored, baseline)
    assert.deepEqual(final.forbiddenCalls, []); assert.deepEqual(blockedRequests, []); assert.deepEqual(errors, [])
    assert.equal(final.listenerSubscriptions, 1); assert.equal(final.maxListenerCount, 1)
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, groups, output, errors, blockedRequests }, null, 2))
    console.log('CONNECTED_AGENT_ACTIVITY_RESULT ' + JSON.stringify({ success: true, groups, output }))
  } catch (error) {
    await capture('failure').catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, groups, errors, blockedRequests,
      snapshot: await snapshot().catch(() => null), body: await page.locator('body').innerText().catch(() => '') }, null, 2))
    console.error(`Connected agent activity fixture artifacts: ${output}`)
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
