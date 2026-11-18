// Real renderer; synthetic requests/media only. No model, ComfyUI or user files.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5217')
assert.equal(base.hostname, '127.0.0.1'); assert.equal(base.protocol, 'http:')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-compact-activity-'))
async function main() {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, serviceWorkers: 'block' })
  await page.addInitScript(() => { window.__connectedAgentFixtureStorage = {} })
  page.setDefaultTimeout(12000)
  const groups = [], errors = [], blocked = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === base.origin && !/^\/(api|v1|prompt|queue|history|view|upload|system_stats)(\/|$)/.test(url.pathname)) return route.continue()
    blocked.push(url.href); return route.abort()
  })
  await page.routeWebSocket(() => true, socket => socket.close())
  const button = name => page.getByRole('button', { name, exact: true })
  const input = () => page.getByRole('textbox', { name: 'Message your agent' })
  const details = () => page.locator('.ca-live-activity')
  const wave = () => page.getByTestId('agent-activity')
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const emit = async (id, events) => {
    await page.evaluate(({ id, events }) => events.forEach(event => window.connectedAgentTest.emitEvent({ requestId: id, ...event })), { id, events })
    await frames()
  }
  const send = async text => {
    const before = (await snapshot()).requests.length
    await input().fill(text); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, before)
    return (await snapshot()).requests.at(-1).requestId
  }
  const settle = async (id, result) => {
    await page.evaluate(({ id, result }) => window.connectedAgentTest.settle(id, result), { id, result })
    await button('Stop response').waitFor({ state: 'hidden' }); await frames()
  }
  try {
    await page.goto(new URL('/tests/fixtures/connected-agent.html?dock=1', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    const authored = (await snapshot()).authored
    await page.evaluate(() => {
      window.electronAPI.agentReviewMedia = { listPlayable: async ({ turnIds }) => ({ success: true, candidates: [],
        items: turnIds.slice(0, 1).map(turnId => ({ id: 'synthetic-video', turnId, name: 'Synthetic result video', type: 'video', unavailable: true })) }) }
    })
    await button('Assistant').click(); await button('Choose Velo').click()
    await page.getByText('Velo ready', { exact: true }).waitFor()
    await button('Assistant settings').click(); await button('Work in Velorn').click(); await button('Back to chat').click()
    const baseline = await snapshot()
    const id = await send('Inspect these synthetic workflows, then ask which reference image to use.')
    await emit(id, [
      { type: 'progress', itemId: 'public', phase: 'commentary', status: 'running', text: 'I will inspect the workflow requirements first.' },
      ...Array.from({ length: 35 }, (_, i) => ({ type: 'tool', callId: `check-${i}`, toolName: 'inspect_comfyui_node', status: 'completed', summary: 'Completed with Full access.', durationMs: 150 })),
      { type: 'tool', callId: 'command', toolName: 'run_command', status: 'running', summary: 'PRIVATE_COMMAND_MARKER '.repeat(20), output: 'Synthetic diagnostic output.' },
      { type: 'timing', phase: 'setup', durationMs: 123 },
    ])
    assert.equal(await details().evaluate(node => node.open), false)
    assert.equal(await details().locator('ol').isVisible(), false)
    assert.equal(await page.locator('.ca-run-details').isVisible(), false)
    assert.equal(await details().locator('[data-activity-id]').count(), 37)
    assert.equal(await wave().isVisible(), true); assert.equal(await button('Stop response').isEnabled(), true)
    assert.doesNotMatch(await wave().innerText(), /PRIVATE_COMMAND_MARKER|inspect_comfyui_node/)
    assert.ok((await details().boundingBox()).height < 50)
    assert.equal(await page.getByText('Synthetic result video', { exact: true }).isVisible(), true)
    await page.screenshot({ path: path.join(output, 'working-collapsed.png') })
    pass('Dozens of tool steps and timing use one collapsed row; compact wave, Stop and media remain visible')

    await details().locator(':scope > summary').focus(); await page.keyboard.press('Enter')
    assert.equal(await details().evaluate(node => node.open), true)
    const command = details().locator('[data-activity-id="tool:command"]')
    await command.locator('.ca-command-output > summary').click()
    await page.evaluate(() => { window.__activityNode = document.querySelector('.ca-live-activity'); window.__commandNode = document.querySelector('[data-activity-id="tool:command"]') })
    await emit(id, [{ type: 'tool', callId: 'command', toolName: 'run_command', status: 'completed', output: 'Synthetic diagnostic output. Completed.', durationMs: 350 }])
    assert.equal(await details().evaluate(node => node === window.__activityNode && node.open), true)
    assert.equal(await command.evaluate(node => node === window.__commandNode), true)
    assert.equal(await command.locator('.ca-command-output').evaluate(node => node.open), true)
    assert.match(await command.locator('pre').last().innerText(), /Completed/)
    await button('Assistant settings').click(); await button('Back to chat').click()
    assert.equal(await details().evaluate(node => node === window.__activityNode && node.open), true)
    pass('Keyboard disclosure works; expanding details/output survives events and settings navigation without rerunning tools')

    const answer = 'The first video is ready. Which reference image should I use next?'
    await emit(id, [
      { type: 'tool', callId: 'recovered', toolName: 'inspect_comfyui_node', status: 'failed', summary: 'Synthetic recoverable inspection failure.' },
      { type: 'progress', itemId: 'answer', phase: 'final_answer', status: 'completed', text: answer },
      { type: 'timing', phase: 'total', durationMs: 9000, outcome: 'completed' },
    ])
    assert.equal(await page.locator('.ca-message[aria-busy="true"]').evaluate(node => !node.closest('details')), true)
    await settle(id, { success: true, text: answer })
    assert.equal(await details().evaluate(node => node === window.__activityNode && node.open), true)
    assert.equal(await command.locator('.ca-command-output').evaluate(node => node.open), true)
    await details().locator(':scope > summary').click()
    assert.equal(await page.getByText(answer, { exact: true }).isVisible(), true)
    assert.equal(await page.getByText('Synthetic result video', { exact: true }).isVisible(), true)
    assert.equal(await page.locator('.ca-assistant').last().evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('.ca-live-activity')) & Node.DOCUMENT_POSITION_FOLLOWING)), true)
    assert.equal(await details().locator('[data-state="failed"]').isVisible(), false)
    assert.equal(await wave().count(), 0)
    await page.screenshot({ path: path.join(output, 'completed-desktop.png') })
    pass('Answer, reference-image question and media precede details; recovered errors stay available inside without expanding the log')

    await details().locator(':scope > summary').click()
    const approvalId = await send('Synthetic approval; do not perform an action.')
    await emit(approvalId, [
      { type: 'tool', callId: 'approval-tool', toolName: 'edit_trim', status: 'running', summary: 'Awaiting synthetic approval.' },
      { type: 'approval', approvalId: 'compact-approval', toolName: 'edit_trim', arguments: { clip: 'synthetic' }, warnings: ['This is a synthetic action warning.'] },
    ])
    assert.equal(await details().evaluate(node => node.open), false, 'New turn resets disclosure')
    const approval = page.getByRole('region', { name: 'Review tool: edit_trim' })
    assert.equal(await approval.isVisible(), true)
    assert.equal(await approval.evaluate(node => !node.closest('.ca-live-activity')), true)
    assert.equal(await approval.getByText('This is a synthetic action warning.', { exact: true }).isVisible(), true)
    assert.equal(await approval.getByRole('button', { name: 'Approve', exact: true }).isEnabled(), true)
    assert.equal(await wave().getAttribute('data-state'), 'approval')
    await approval.getByRole('button', { name: 'Deny', exact: true }).click()
    await settle(approvalId, { success: false, code: 'PROVIDER_ERROR', error: 'Synthetic service failed. No action was performed.',
      toolReceipts: { version: 1, entries: [{ id: 'agent-receipt-00000000-0000-0000-0000-000000000001', toolName: 'edit_trim', outcome: 'denied' }], omitted: 0 } })
    assert.match(await page.locator('.ca-error').innerText(), /Synthetic service failed/)
    assert.match(await page.locator('.ca-assistant').last().innerText(), /Request did not finish/)
    assert.equal(await page.locator('.ca-assistant').last().locator('.ca-tool-receipts').evaluate(node => node.open), false)
    assert.equal(await details().evaluate(node => node.open), false)
    pass('Pending approval and warnings remain visible and actionable; terminal failure is visible while full receipts stay collapsed')

    for (const width of [900, 540]) {
      await page.setViewportSize({ width, height: 900 }); await frames()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      assert.equal(await details().evaluate(node => node.scrollWidth <= node.clientWidth + 1), true)
      await page.screenshot({ path: path.join(output, `failed-${width}.png`) })
    }
    const after = await snapshot()
    assert.deepEqual(after.authored, authored); assert.deepEqual(after.forbiddenCalls, [])
    assert.deepEqual(after.fullAccessGrant, baseline.fullAccessGrant)
    assert.equal(after.requests.length, 2)
    assert.equal(after.calls.filter(call => call.method === 'approveTool' && call.approved).length, 0)
    assert.equal(after.requests.every(request => request.provider === 'luna' && request.reasoningEffort === 'low'), true)
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    pass('Narrow layouts fit; authored project, request policy, Luna Light and permissions unchanged; no real inference, downloads or generations')
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, groups, output, errors, blocked }, null, 2))
    console.log(JSON.stringify({ passed: true, groups, output }))
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
    console.error('Evidence:', output); throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
