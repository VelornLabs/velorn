// Actual panel, synthetic native events, isolated browser storage only.
// No provider, project edit, native grant or external service is exercised.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Timing fixture requires loopback HTTP')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-agent-timing-'))

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', serviceWorkers: 'block' })
  const page = await context.newPage(), groups = [], errors = [], blockedRequests = []
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === base.origin && !/^\/(?:prompt|queue|interrupt|system_stats|history|upload|view|ws|v1|api)(?:\/|$)/.test(url.pathname)) return route.continue()
    blockedRequests.push(url.href); return route.abort()
  })
  await page.routeWebSocket(() => true, socket => socket.close())
  const button = name => page.getByRole('button', { name, exact: true })
  const input = () => page.getByRole('textbox', { name: 'Message your agent', exact: true })
  const details = () => page.locator('.ca-run-details')
  const log = () => page.getByRole('log', { name: 'Agent conversation', exact: true })
  const value = phase => details().locator(`[data-timing-phase="${phase}"]`).innerText()
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const emit = async (request, event) => {
    await page.evaluate(event => window.connectedAgentTest.emitEvent(event), { requestId: request.requestId, ...event })
    await frames()
  }
  const send = async text => {
    const count = (await snapshot()).requests.length
    await input().fill(text); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, count)
    return (await snapshot()).requests.at(-1)
  }
  const settle = async (request, result = { success: true, text: 'Synthetic timing reply.' }) => {
    await page.evaluate(({ requestId, result }) => window.connectedAgentTest.settle(requestId, result), { requestId: request.requestId, result })
    await button('Stop response').waitFor({ state: 'hidden' }); await frames()
  }
  const open = async () => {
    const activity = page.locator('.ca-live-activity')
    if (!await activity.evaluate(node => node.open)) await activity.locator(':scope > summary').click()
    if (!await details().evaluate(node => node.open)) await details().locator('summary').click()
  }
  try {
    await page.goto(new URL('/tests/fixtures/connected-agent.html?dock=1', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    const baseline = (await snapshot()).authored
    await button('Assistant').click(); await input().waitFor()
    assert.equal(await details().count(), 0)
    await button('Assistant settings').click()
    await page.locator('.ca-more-options > summary').click()
    await page.locator('summary').filter({ hasText: /^Access options$/ }).click()
    const learnMore = page.locator('summary').filter({hasText: /^Learn more about Full access$/})
    await learnMore.click()
    const disclosure = await learnMore.locator('..').innerText()
    assert.match(disclosure, /Your message is sent as typed, including paths and links/)
    assert.match(disclosure, /Codex keeps local session files for continuity; turning off access does not erase those files/)
    await page.getByRole('checkbox', { name: 'Velorn tools', exact: true }).check()
    await button('Back to chat').click()
    const first = await send('Synthetic public timing test; do not execute anything.')
    await emit(first, { type: 'timing', phase: 'setup', durationMs: 123, continuity: 'continued', reasoning: 'TIMING_PRIVATE_ONLY' })
    assert.equal(await details().evaluate(node => node.open), false)
    await open()
    assert.equal(await value('setup'), '123 ms'); assert.equal(await value('first-update'), 'Waiting…')
    assert.match(await details().innerText(), /Runtime session\s+Continued/)
    await emit(first, { type: 'timing', phase: 'first-update', durationMs: 2500 })
    assert.equal(await value('first-update'), '2.5 s')
    pass('Run details is collapsed by default; only public setup, first-update and continuity measurements appear')

    await emit(first, { type: 'tool', callId: 'timed-tool', toolName: 'get_generation_queue_status', status: 'completed', summary: 'Synthetic bounded tool.', durationMs: 6100 })
    await emit(first, { type: 'tool', callId: 'invalid-tool', toolName: 'get_generation_queue_status', status: 'completed', summary: 'Synthetic invalid timing.', durationMs: -1 })
    assert.equal(await page.locator('[data-activity-id="tool:timed-tool"] .ca-tool-duration').innerText(), '6.1 s')
    assert.equal(await page.locator('[data-activity-id="tool:invalid-tool"] .ca-tool-duration').count(), 0)
    for (const event of [
      { type: 'timing', phase: 'analysis', durationMs: 8, text: 'TIMING_PRIVATE_ONLY' },
      { requestId: 'foreign-request', type: 'timing', phase: 'total', durationMs: 9 },
      { type: 'timing', phase: 'total', durationMs: '9000' },
      { type: 'timing', phase: 'total', durationMs: 86400001 },
    ]) await emit(first, event)
    assert.equal(await value('total'), 'Waiting…')
    assert.doesNotMatch(await log().innerText(), /TIMING_PRIVATE_ONLY/)
    await emit(first, { type: 'timing', phase: 'total', durationMs: 8000, outcome: 'completed' })
    await settle(first)
    assert.equal(await value('total'), '8.0 s')
    assert.match(await details().innerText(), /Outcome\s+Completed/)
    assert.match(await details().innerText(), /Tool durations include approval waiting and validation, not just execution; they can overlap and are not added together/)
    assert.equal(await details().evaluate(node => Boolean(node.compareDocumentPosition([...document.querySelectorAll('.ca-assistant')].at(-1)) & Node.DOCUMENT_POSITION_PRECEDING)), true)
    pass('Per-tool durations are bounded; native total is used without summing tools, and final reply precedes optional diagnostics')

    await page.setViewportSize({ width: 400, height: 1000 }); await details().scrollIntoViewIfNeeded()
    assert.equal(await details().evaluate(node => node.scrollWidth <= node.clientWidth + 1), true)
    await page.screenshot({ path: path.join(output, 'timing-narrow.png'), fullPage: true, animations: 'disabled' })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.screenshot({ path: path.join(output, 'timing-desktop.png'), fullPage: true, animations: 'disabled' })
    const storage = JSON.stringify((await snapshot()).storage)
    assert.doesNotMatch(storage, /TIMING_PRIVATE_ONLY|durationMs|first-update|continuity|Runtime session/)
    pass('Expanded diagnostics wrap in the narrow dock and remain transient rather than entering saved conversation history')

    const cancelled = await send('Synthetic cancellation timing test.')
    assert.equal(await details().count(), 0)
    await emit(cancelled, { type: 'timing', phase: 'setup', durationMs: 0, continuity: 'new' })
    assert.equal(await details().evaluate(node => node.open), false)
    await button('Stop response').click(); await frames()
    await emit(cancelled, { type: 'timing', phase: 'first-update', durationMs: 400 })
    await emit(cancelled, { type: 'timing', phase: 'total', durationMs: 450, outcome: 'cancelled' })
    await emit(cancelled, { type: 'progress', itemId: 'late', phase: 'commentary', status: 'completed', text: 'TIMING_LATE_REPLY_ONLY' })
    await settle(cancelled, { success: true, text: 'TIMING_LATE_REPLY_ONLY' })
    await open()
    assert.equal(await value('setup'), '0 ms'); assert.equal(await value('first-update'), 'Not recorded')
    assert.equal(await value('total'), '450 ms'); assert.match(await details().innerText(), /Outcome\s+Cancelled/)
    assert.doesNotMatch(await log().innerText(), /TIMING_LATE_REPLY_ONLY/)
    pass('New requests clear measurements and disclosure state; Stop accepts only matching final timing without reviving reply activity')

    const failed = await send('Synthetic failure timing test.')
    await emit(cancelled, { type: 'timing', phase: 'total', durationMs: 99, outcome: 'cancelled' })
    assert.equal(await details().count(), 0)
    await emit(failed, { type: 'timing', phase: 'total', durationMs: 55, outcome: 'failed', continuity: 'reset' })
    await settle(failed, { success: false, error: 'Synthetic failure, no action executed.' })
    await open()
    assert.equal(await value('total'), '55 ms'); assert.equal(await value('setup'), 'Not recorded')
    assert.match(await details().innerText(), /Outcome\s+Failed/)
    await button('New chat').click(); await frames()
    assert.equal(await details().count(), 0)
    await emit(failed, { type: 'timing', phase: 'setup', durationMs: 100, continuity: 'reset' })
    assert.equal(await details().count(), 0)
    pass('Failure remains explicit; new chat and stale-request events cannot restore old diagnostics')

    const final = await snapshot()
    assert.deepEqual(final.authored, baseline); assert.deepEqual(final.forbiddenCalls, [])
    assert.deepEqual(final.calls.filter(call => call.method === 'approveTool' || call.method === 'setFullAccess'), [])
    assert.equal(final.requests.length, 3)
    assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, [])
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, groups, errors, blockedRequests, output }, null, 2))
    console.log('CONNECTED_AGENT_TIMING_RESULT ' + JSON.stringify({ success: true, groups, output }))
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    console.error(`Timing fixture artifacts: ${output}`); throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
