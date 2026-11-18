// Public live-activity renderer regression. Synthetic native events only: no
// provider inference, command execution, authored project edit or real IO.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Live progress fixture requires loopback HTTP')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-agent-live-progress-'))
const outputLimit = 16 * 1024
const workspaces = ['Editor', 'Storyboard', 'Generate', 'Stock', 'ComfyUI', 'Export', 'Discover']

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'en-US', serviceWorkers: 'block' })
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
  const live = () => page.locator('.ca-live-activity[aria-label="Activity details"]')
  const rows = () => live().locator('ol > li[data-activity-id]')
  // IDs below are fixed synthetic strings, never model-supplied selectors.
  const item = id => live().locator(`ol > li[data-activity-id="${id}"]`)
  const indicator = () => page.getByTestId('agent-activity')
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
  const back = async () => { if (await button('Back to chat').isVisible()) await button('Back to chat').click() }
  const send = async text => {
    await back()
    const count = (await snapshot()).requests.length
    await input().fill(text); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, count)
    return (await snapshot()).requests.at(-1)
  }
  const emit = async (request, event) => {
    await page.evaluate(event => window.connectedAgentTest.emitEvent(event), { requestId: request.requestId, ...event })
    await frames()
  }
  const emitBatch = async (request, events) => {
    await page.evaluate(({ requestId, events }) => events.forEach(event => window.connectedAgentTest.emitEvent({ requestId, ...event })),
      { requestId: request.requestId, events })
    await frames()
  }
  const settle = async (request, text) => {
    await page.evaluate(({ requestId, text }) => window.connectedAgentTest.settle(requestId, { success: true, text }), { requestId: request.requestId, text })
    await button('Stop response').waitFor({ state: 'hidden' }); await frames()
  }
  const ids = () => rows().evaluateAll(nodes => nodes.map(node => node.dataset.activityId))
  const countText = async text => log().evaluate((node, value) => node.innerText.split(value).length - 1, text)
  const assertTransient = async () => {
    const storage = JSON.stringify((await snapshot()).storage)
    for (const marker of ['LIVE_COMMENTARY_ONLY', 'LIVE_COMMAND_OUTPUT_ONLY', 'PRIVATE_REASONING_ONLY', 'WRONG_REQUEST_ONLY', 'LATE_CANCELLED_ONLY']) {
      assert.ok(!storage.includes(marker), `${marker} must never enter saved chat/preferences`)
    }
    assert.ok(!storage.includes('data-activity-id'))
  }
  const assertIdentity = async () => {
    assert.equal(await page.evaluate(() => {
      const refs = window.__liveProgressNodes
      return refs.panel === document.querySelector('.ca-docked') && refs.log === document.querySelector('.ca-messages')
        && refs.composer === document.querySelector('textarea[aria-label="Message your agent"]')
        && refs.first === document.querySelector('[data-activity-id="progress:comment-1"]')
        && refs.command === document.querySelector('[data-activity-id="tool:command-1"]')
    }), true, 'Workspace/settings navigation and cumulative updates retain existing DOM nodes')
    const state = await snapshot()
    assert.equal(state.listenerCount, 1); assert.equal(state.listenerSubscriptions, 1)
    assert.equal(state.listenerUnsubscriptions, 0); assert.equal(state.maxListenerCount, 1)
  }
  try {
    await page.goto(new URL('/tests/fixtures/connected-agent.html?dock=1', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    const baseline = (await snapshot()).authored
    await button('Assistant').click(); await input().waitFor()
    assert.equal(await live().count(), 0); assert.equal(await indicator().count(), 0)
    await openSettings()
    await page.getByRole('checkbox', { name: 'Velorn tools', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Full computer access (experimental)', exact: true }).check()
    await page.waitForFunction(() => Boolean(window.connectedAgentTest.snapshot().fullAccessGrant))
    assert.match(await page.locator('.ca-full-access-active').innerText(), /^Full access · automatic/)
    await page.locator('.ca-full-access-details > summary').click()
    assert.match(await page.locator('.ca-full-access-details').innerText(), /Direct computer commands and third-party services can bypass those controls and incur costs/)
    assert.equal(await page.getByRole('radio', { name: 'Ask first', exact: true }).count(), 0)
    assert.equal(await page.getByRole('radio', { name: 'Auto-approve editing', exact: true }).count(), 0)
    await back(); await frames()
    assert.equal(await page.locator('.ca-full-access-badge').isVisible(), false)
    assert.equal(await page.getByTestId('agent-approval-status').isVisible(), false)
    assert.equal((await snapshot()).calls.filter(call => call.method === 'approveTool').length, 0)
    pass('Idle chat has no activity or access banner; settings retain native-confirmed automatic permissions and spending warnings without contradictory radios')

    const first = await send('Synthetic public progress, command output and final-answer ordering check. Do not execute anything.')
    assert.equal(first.fullAccess, true); assert.equal(first.toolsEnabled, true)
    await indicator().waitFor(); assert.equal(await indicator().getAttribute('data-state'), 'working')
    await emit(first, { type: 'progress', itemId: 'comment-1', text: 'LIVE_COMMENTARY_ONLY: Inspecting the synthetic prerequisites.', phase: 'commentary', status: 'running' })
    await live().waitFor()
    assert.equal(await live().evaluate(node => node.open), false)
    await live().locator(':scope > summary').click()
    assert.equal(await item('progress:comment-1').getAttribute('data-kind'), 'progress')
    assert.equal(await item('progress:comment-1').getAttribute('data-state'), 'running')
    assert.equal(await item('progress:comment-1').locator('.ca-progress-text').innerText(), 'LIVE_COMMENTARY_ONLY: Inspecting the synthetic prerequisites.')
    await page.evaluate(() => { window.__liveProgressNodes = { panel: document.querySelector('.ca-docked'),
      log: document.querySelector('.ca-messages'), composer: document.querySelector('textarea[aria-label="Message your agent"]'),
      first: document.querySelector('[data-activity-id="progress:comment-1"]') } })
    await emit(first, { type: 'tool', callId: 'command-1', toolName: 'run_command', status: 'running', summary: 'Inspecting synthetic readiness.',
      output: 'LIVE_COMMAND_OUTPUT_ONLY: first line\n' })
    await page.evaluate(() => { window.__liveProgressNodes.command = document.querySelector('[data-activity-id="tool:command-1"]') })
    await emit(first, { type: 'progress', itemId: 'comment-2', text: 'LIVE_COMMENTARY_ONLY: Checking the result before continuing.', phase: 'commentary', status: 'running' })
    await emit(first, { type: 'tool', callId: 'host-1', toolName: 'get_generation_queue_status', status: 'running', summary: 'Reading a synthetic queue snapshot.' })
    const expectedIds = ['progress:comment-1', 'tool:command-1', 'progress:comment-2', 'tool:host-1']
    assert.deepEqual(await ids(), expectedIds)
    assert.equal(await indicator().getAttribute('data-state'), 'tool')
    pass('Public commentary and native/host tool rows appear live in event order while the composer activity indicator remains active')

    const authoritativeComment = 'LIVE_COMMENTARY_ONLY: Prerequisites inspected; the earlier partial wording is replaced.'
    await emit(first, { type: 'progress', itemId: 'comment-1', text: authoritativeComment, phase: 'commentary', status: 'completed' })
    const commandOutput = 'LIVE_COMMAND_OUTPUT_ONLY: first line\nsecond cumulative line\nAuthorization: [redacted]\n<img src=x onerror="window.__syntheticHtmlExecuted=true">\n'
    await emit(first, { type: 'tool', callId: 'command-1', toolName: 'run_command', status: 'completed', summary: 'Synthetic readiness check completed.', output: commandOutput })
    await emit(first, { type: 'tool', callId: 'host-1', toolName: 'get_generation_queue_status', status: 'completed', summary: 'No synthetic jobs are running.' })
    await emit(first, { type: 'progress', itemId: 'comment-2', text: 'LIVE_COMMENTARY_ONLY: The confirmed tool results are ready.', phase: 'commentary', status: 'completed' })
    assert.deepEqual(await ids(), expectedIds)
    await assertIdentity()
    assert.equal(await item('progress:comment-1').locator('.ca-progress-text').innerText(), authoritativeComment)
    assert.equal(await item('progress:comment-1').getAttribute('data-state'), 'completed')
    assert.equal(await item('tool:command-1').getAttribute('data-kind'), 'tool')
    assert.equal(await item('tool:command-1').getAttribute('data-state'), 'completed')
    const commandText = await item('tool:command-1').innerText()
    assert.match(commandText, /run_command/); assert.match(commandText, /completed/i)
    assert.doesNotMatch(commandText, /Synthetic readiness check completed/, 'Command details are collapsed by default')
    await item('tool:command-1').locator('.ca-command-details > summary').click()
    assert.match(await item('tool:command-1').locator('.ca-command-details pre').innerText(), /Synthetic readiness check completed/)
    await item('tool:command-1').locator('details > summary').filter({ hasText: 'Command output' }).click()
    const renderedOutput = await item('tool:command-1').locator('.ca-command-output pre').innerText()
    assert.equal(renderedOutput.split('LIVE_COMMAND_OUTPUT_ONLY: first line').length - 1, 1, 'Cumulative output is not appended twice')
    assert.match(renderedOutput, /second cumulative line/)
    assert.match(renderedOutput, /\[private value omitted\]/, 'Renderer repeats credential redaction defensively')
    assert.doesNotMatch(renderedOutput, /Authorization:/)
    assert.ok(renderedOutput.includes('<img src=x onerror="window.__syntheticHtmlExecuted=true">'))
    assert.equal(await page.evaluate(() => Boolean(window.__syntheticHtmlExecuted)), false)
    assert.equal(await item('tool:command-1').locator('img, script').count(), 0)
    await emit(first, { type: 'tool', callId: 'command-1', toolName: 'run_command', status: 'running', summary: 'STALE_RUNNING_REPLAY_MUST_NOT_APPEAR', output: 'STALE_RUNNING_REPLAY_MUST_NOT_APPEAR' })
    assert.equal(await item('tool:command-1').getAttribute('data-state'), 'completed')
    assert.equal(await item('tool:command-1').locator('.ca-command-output pre').innerText(), renderedOutput)
    assert.doesNotMatch(await item('tool:command-1').innerText(), /STALE_RUNNING_REPLAY/)
    assert.equal(await indicator().getAttribute('data-state'), 'working')
    await assertTransient()
    pass('Cumulative updates replace text/output in the same rows; completed status is visible and command output is an escaped disclosure, not executable markup')

    await emitBatch(first, [
      { requestId: 'wrong-request', type: 'progress', itemId: 'foreign-progress', text: 'WRONG_REQUEST_ONLY', phase: 'commentary', status: 'completed' },
      { requestId: 'wrong-request', type: 'tool', callId: 'foreign-tool', toolName: 'run_command', status: 'completed', summary: 'WRONG_REQUEST_ONLY', output: 'WRONG_REQUEST_ONLY' },
      { type: 'reasoning', itemId: 'private-1', text: 'PRIVATE_REASONING_ONLY' },
      { type: 'progress', itemId: 'private-2', text: 'PRIVATE_REASONING_ONLY', phase: 'analysis', status: 'completed' },
      { type: 'progress', itemId: 'private-3', text: 'PRIVATE_REASONING_ONLY', phase: 'reasoning', status: 'running' },
      { type: 'tool', callId: 'host-1', toolName: 'get_generation_queue_status', status: 'completed', summary: 'No synthetic jobs are running.', reasoning: 'PRIVATE_REASONING_ONLY', rawResult: 'PRIVATE_REASONING_ONLY' },
    ])
    assert.deepEqual(await ids(), expectedIds)
    assert.doesNotMatch(await log().innerText(), /PRIVATE_REASONING_ONLY|WRONG_REQUEST_ONLY/)
    await assertTransient()
    pass('Wrong-request events, private reasoning event types/phases and unrelated raw-result fields never enter the transcript or storage')

    const longComment = Array.from({ length: 45 }, (_, index) => `LIVE_COMMENTARY_ONLY: Synthetic public step ${index + 1}; inspect, confirm and continue within the approved task.`).join('\n')
    await emit(first, { type: 'progress', itemId: 'comment-long', text: longComment, phase: 'commentary', status: 'running' })
    await input().fill('Keep this unsent draft while public progress continues.')
    const draft = await input().inputValue(), chat = await page.getByLabel('Conversation', { exact: true }).inputValue()
    const beforeNavigation = await ids()
    // Begin with a real transition; re-clicking the already active Editor is
    // not a reveal and must not override somebody reading older activity.
    for (const workspace of [...workspaces.slice(1), workspaces[0]]) {
      await log().evaluate(node => { node.scrollTop = 0 })
      await tab(workspace).click(); await frames(5)
      await assertIdentity()
      assert.deepEqual(await ids(), beforeNavigation)
      assert.equal(await input().inputValue(), draft)
      assert.equal(await page.getByLabel('Conversation', { exact: true }).inputValue(), chat)
      const position = await log().evaluate(node => ({ gap: node.scrollHeight - node.clientHeight - node.scrollTop,
        total: node.scrollHeight, height: node.clientHeight, pageTop: document.scrollingElement.scrollTop }))
      measurements.push({ workspace, ...position })
      assert.ok(position.total > position.height, 'Activity is actually scrollable')
      assert.ok(position.gap <= 2, `${workspace} reveals the newest activity: ${JSON.stringify(position)}`)
      assert.equal(position.pageTop, 0)
      assert.equal(await indicator().count(), 1)
    }
    await openSettings(); await tab('Editor').click(); await back(); await frames(5); await assertIdentity()
    await button('Inspector').click(); await button('Assistant').click(); await frames(5); await assertIdentity()
    await button('Collapse right panel').click(); await tab('Generate').click(); await button('Expand right panel').click()
    await frames(5); await assertIdentity(); assert.deepEqual(await ids(), beforeNavigation)
    assert.equal(await input().inputValue(), draft)
    assert.equal((await snapshot()).calls.filter(call => call.method === 'approveTool').length, 0)
    pass('Long live activity retains order, DOM, selected chat and draft across all workspaces, settings, Inspector and collapsed dock; reveal scrolls to newest activity')

    await emit(first, { type: 'progress', itemId: 'comment-long', text: 'LIVE_COMMENTARY_ONLY: Long synthetic inspection completed.', phase: 'commentary', status: 'completed' })
    await emit(first, { type: 'tool', callId: 'command-wrap', toolName: 'run_command', status: 'running',
      summary: 'Synthetic command with a long single output token.', output: `LIVE_COMMAND_OUTPUT_ONLY: ${'W'.repeat(600)}\n` })
    await item('tool:command-wrap').locator('details > summary').filter({ hasText: 'Command output' }).click()
    for (const width of [900, 400]) {
      await page.setViewportSize({ width, height: 1050 }); await frames(5)
      await item('tool:command-wrap').scrollIntoViewIfNeeded()
      const geometry = await live().evaluate(node => {
        const panel = node.closest('.ca-docked'), rect = panel.getBoundingClientRect()
        return { activityClient: node.clientWidth, activityScroll: node.scrollWidth,
          panelClient: panel.clientWidth, panelScroll: panel.scrollWidth, left: rect.left, right: rect.right, viewport: innerWidth,
          outputs: [...node.querySelectorAll('pre')].map(pre => ({ client: pre.clientWidth, scroll: pre.scrollWidth })) }
      })
      measurements.push({ width, geometry })
      assert.ok(geometry.activityScroll <= geometry.activityClient + 1, `Activity overflows at ${width}px: ${JSON.stringify(geometry)}`)
      assert.ok(geometry.panelScroll <= geometry.panelClient + 1, `Panel overflows at ${width}px`)
      assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewport + 1, `Dock stays on-screen at ${width}px`)
      for (const pre of geometry.outputs) assert.ok(pre.scroll <= pre.client + 1, `Command output wraps at ${width}px`)
      assert.equal(await button('Stop response').isVisible(), true)
      assert.equal(await page.locator('.ca-full-access-badge').isVisible(), false)
      assert.equal(await page.getByTestId('agent-approval-status').isVisible(), false)
      assert.ok((await snapshot()).fullAccessGrant)
      await capture(`live-activity-${width}px`)
    }
    await page.setViewportSize({ width: 1440, height: 1050 }); await frames()
    pass('Public commentary, tool status and expanded output wrap inside 400px/900px docks with Stop visible; automatic access stays enabled without routine banners')

    const finalText = 'FINAL_ANSWER_ONCE: Synthetic checks are complete; no files, project data or generation jobs changed.'
    await emit(first, { type: 'tool', callId: 'command-wrap', toolName: 'run_command', status: 'completed', summary: 'Synthetic output finished.' })
    await emit(first, { type: 'progress', itemId: 'final-1', text: 'FINAL_ANSWER_ONCE: Synthetic checks are complete;', phase: 'final_answer', status: 'running' })
    await emit(first, { type: 'delta', text: 'LEGACY_DUPLICATE_MUST_NOT_APPEAR' })
    await emit(first, { type: 'progress', itemId: 'final-1', text: finalText, phase: 'final_answer', status: 'completed' })
    assert.equal(await item('progress:final-1').count(), 0, 'Final answer is not duplicated as a commentary row')
    assert.equal(await page.locator('.ca-message[aria-busy="true"] .ca-markdown').innerText(), finalText)
    assert.equal(await countText(finalText), 1)
    assert.doesNotMatch(await log().innerText(), /LEGACY_DUPLICATE_MUST_NOT_APPEAR/)
    assert.equal(await button('Stop response').count(), 1, 'An item completion alone is not a completed provider turn')
    await settle(first, finalText)
    assert.equal(await indicator().count(), 0)
    assert.equal(await page.locator('.ca-message[aria-busy="true"]').count(), 0)
    assert.equal(await log().locator('.ca-assistant .ca-markdown').last().innerText(), finalText)
    assert.equal(await countText(finalText), 1)
    const finalAfterActivity = await log().evaluate(node => {
      const activity = node.querySelector('.ca-live-activity'), final = [...node.querySelectorAll('.ca-assistant')].at(-1)
      return Boolean(activity && final && (activity.compareDocumentPosition(final) & Node.DOCUMENT_POSITION_FOLLOWING))
    })
    assert.equal(finalAfterActivity, false, 'Final answer precedes the optional activity sequence')
    assert.equal(await input().inputValue(), draft)
    await assertTransient()
    pass('Final-answer progress updates one response; legacy deltas cannot duplicate it, and provider completion leaves exactly one final answer before optional activity')

    const stopped = await send('Hold this synthetic response until Stop is clicked.')
    await emit(stopped, { type: 'progress', itemId: 'stop-comment', text: 'LIVE_COMMENTARY_ONLY: A synthetic command is still running.', phase: 'commentary', status: 'running' })
    await emit(stopped, { type: 'tool', callId: 'stop-command', toolName: 'run_command', status: 'running', summary: 'Synthetic command waiting.', output: 'LIVE_COMMAND_OUTPUT_ONLY: waiting\n' })
    await openSettings(); await button('Stop response').click(); await back(); await frames()
    assert.equal(await indicator().count(), 0); assert.equal(await button('Stop response').count(), 0)
    const afterStop = await log().innerText()
    await emitBatch(stopped, [
      { type: 'progress', itemId: 'late-comment', text: 'LATE_CANCELLED_ONLY', phase: 'commentary', status: 'running' },
      { type: 'progress', itemId: 'late-final', text: 'LATE_CANCELLED_ONLY', phase: 'final_answer', status: 'completed' },
      { type: 'tool', callId: 'late-command', toolName: 'run_command', status: 'completed', summary: 'LATE_CANCELLED_ONLY', output: 'LATE_CANCELLED_ONLY' },
      { type: 'delta', text: 'LATE_CANCELLED_ONLY' },
    ])
    await settle(stopped, 'LATE_CANCELLED_ONLY')
    assert.equal(await log().innerText(), afterStop)
    assert.equal(await indicator().count(), 0)
    assert.equal((await snapshot()).calls.filter(call => call.method === 'cancel' && call.requestId === stopped.requestId).length, 1)
    await assertTransient()
    pass('Stop works from settings; late cancelled commentary, final answers, outputs and provider completion cannot revive or change the response')

    const bounded = await send('Stress only synthetic public activity bounds; do not execute anything.')
    const events = Array.from({ length: 75 }, (_, index) => index % 2
      ? { type: 'progress', itemId: `bounded-${index}`, text: `LIVE_COMMENTARY_ONLY: ${index} ${'P'.repeat(70000)}`, phase: 'commentary', status: 'completed' }
      : { type: 'tool', callId: `bounded-${index}`, toolName: 'run_command', status: 'completed', summary: `Synthetic bounded output ${index}.`, output: `LIVE_COMMAND_OUTPUT_ONLY: ${index}\n${'O'.repeat(outputLimit * 3)}` })
    await emitBatch(bounded, events)
    const retained = await rows().evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.activityId, kind: node.dataset.kind,
      output: node.querySelector('.ca-command-output pre')?.textContent || '', commentary: node.querySelector('.ca-progress-text')?.textContent || '' })))
    assert.ok(retained.length > 0 && retained.length <= 60, `Activity retains at most 60 rows, got ${retained.length}`)
    assert.equal(new Set(retained.map(entry => entry.id)).size, retained.length)
    const retainedIndices = retained.map(entry => Number(entry.id.split('-').at(-1)))
    assert.deepEqual(retainedIndices, [...retainedIndices].sort((a, b) => a - b), 'Bounded eviction preserves relative event order')
    // Truncation/eviction notices are presentation text, not retained output.
    const retainedOutput = entry => entry.output === 'Earlier output is no longer retained.' ? '' : entry.output.replace(/\n… Output truncated\.$/, '')
    for (const entry of retained) {
      assert.ok(retainedOutput(entry).length <= outputLimit, `Output exceeds ${outputLimit} characters: ${entry.id}`)
      assert.ok(entry.commentary.length <= 12000, `Commentary is bounded per item: ${entry.id}`)
    }
    const outputCharacters = retained.reduce((sum, entry) => sum + retainedOutput(entry).length, 0)
    const textCharacters = retained.reduce((sum, entry) => sum + retainedOutput(entry).length + entry.commentary.length, 0)
    measurements.push({ boundedRows: retained.length, outputCharacters, activityTextCharacters: textCharacters })
    assert.ok(outputCharacters <= 64 * 1024, `Command output retains at most 64 KiB total, got ${outputCharacters} characters`)
    assert.ok(textCharacters <= 60 * 12000 + 64 * 1024, `Aggregate public activity remains bounded, got ${textCharacters} characters`)
    await assertTransient()
    await button('Stop response').click(); await frames()
    pass('Oversized public events are bounded by per-command, total-text and 60-row limits while retaining unique IDs and original relative order')

    const final = await snapshot()
    assert.deepEqual(final.authored, baseline)
    assert.deepEqual(final.forbiddenCalls, []); assert.deepEqual(blockedRequests, []); assert.deepEqual(errors, [])
    assert.deepEqual(final.calls.filter(call => call.method === 'approveTool'), [], 'Display events never approve or dispatch an action')
    assert.equal(final.calls.filter(call => call.method === 'setFullAccess' && call.enabled).length, 1, 'Only the explicit checkbox grants fixture authority')
    assert.equal(final.requests.length, 3, 'Only explicit Send clicks produce synthetic requests')
    await assertTransient()
    const storage = final.storage
    await page.addInitScript(value => { window.__connectedAgentFixtureStorage = value }, storage)
    await page.reload(); await page.waitForFunction(() => window.connectedAgentTest?.ready); await button('Assistant').click(); await input().waitFor()
    assert.equal(await live().count(), 0)
    assert.doesNotMatch(await log().innerText(), /LIVE_COMMENTARY_ONLY|LIVE_COMMAND_OUTPUT_ONLY|PRIVATE_REASONING_ONLY|WRONG_REQUEST_ONLY|LATE_CANCELLED_ONLY/)
    assert.equal((await snapshot()).requests.length, 0)
    assert.equal((await snapshot()).fullAccessGrant, null)
    assert.deepEqual((await snapshot()).authored, baseline)
    assert.deepEqual((await snapshot()).forbiddenCalls, [])
    assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, [])
    pass('Activity/output are RAM-only across saved-history replay; no event gains authority, edits authored state or calls a real provider, command, file or generation service')

    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, groups, measurements, output, errors, blockedRequests }, null, 2))
    console.log('CONNECTED_AGENT_LIVE_PROGRESS_RESULT ' + JSON.stringify({ success: true, groups, output }))
  } catch (error) {
    await capture('failure').catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, groups, measurements, errors, blockedRequests,
      snapshot: await snapshot().catch(() => null), body: await page.locator('body').innerText().catch(() => '') }, null, 2))
    console.error(`Connected agent live progress fixture artifacts: ${output}`)
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
