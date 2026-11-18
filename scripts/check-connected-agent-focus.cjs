// Real Agent composer, Timeline gestures and TransportControls in a RAM-only
// fixture. No App startup, native IO, provider connection or user media.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Focus fixture requires loopback HTTP')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-connected-agent-focus-'))

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
  const input = () => page.getByRole('textbox', { name: 'Message your agent', exact: true })
  const viewport = () => page.getByTestId('timeline-viewport')
  const ruler = () => page.getByTestId('timeline-scrub-ruler')
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const view = () => page.evaluate(() => window.connectedAgentTest.editorView())
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const capture = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const assertFocused = async (locator, message) => assert.equal(await locator.evaluate(node => document.activeElement === node), true, message)
  const tapTransport = async draft => {
    await page.keyboard.press('Space'); await frame()
    assert.equal((await view()).isPlaying, true, 'Space starts actual timeline store playback')
    await page.keyboard.press('Space'); await frame()
    assert.equal((await view()).isPlaying, false, 'Second Space pauses actual timeline store playback')
    assert.equal(await input().inputValue(), draft, 'Timeline transport leaves the chat draft unchanged')
    assert.equal((await snapshot()).requests.length, 0, 'Timeline shortcuts do not submit a provider request')
  }
  try {
    await page.goto(new URL('/tests/fixtures/connected-agent.html?dock=1&timeline=1', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    await ruler().waitFor(); await frame()
    const baseline = (await snapshot()).authored
    await page.getByRole('button', { name: 'Assistant', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: 'Assistant settings', exact: true }).getAttribute('aria-expanded'), 'false')
    assert.equal(await page.getByLabel('Assistant selection', { exact: true }).isVisible(), false, 'The focus workflow starts in chat, not configuration')
    await input().fill('Draft remains editable')
    await page.keyboard.press('End'); await page.keyboard.press('Space')
    const draft = 'Draft remains editable '
    assert.equal(await input().inputValue(), draft)
    assert.equal((await view()).isPlaying, false)
    assert.equal((await snapshot()).requests.length, 0)
    pass('Space types into the actual Agent composer without playing or submitting')

    const rulerBox = await ruler().boundingBox()
    await page.mouse.move(rulerBox.x + 180, rulerBox.y + 10)
    await page.mouse.wheel(0, 60); await frame()
    await assertFocused(input(), 'Hover and wheel over timeline do not steal composer focus')
    assert.equal(await input().inputValue(), draft)
    assert.equal((await view()).isPlaying, false)
    pass('Hover and wheel over the timeline preserve composer focus and draft')

    const beforeClick = (await view()).playhead
    await ruler().click({ position: { x: 180, y: 10 } }); await frame()
    assert.notEqual((await view()).playhead, beforeClick, 'Real ruler handler seeks the timeline')
    await assertFocused(viewport(), 'Clicking the ruler must transfer focus from Agent to timeline')
    await tapTransport(draft)
    pass('Deliberate ruler click transfers focus and Space toggles real transport without editing the draft')

    await input().click(); await page.keyboard.press('End')
    const handle = await page.getByTestId('timeline-playhead-handle').boundingBox()
    const beforeScrub = (await view()).playhead
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down(); await page.mouse.move(handle.x + handle.width / 2 + 100, handle.y + handle.height / 2, { steps: 6 }); await page.mouse.up()
    await frame()
    assert.notEqual((await view()).playhead, beforeScrub, 'Real playhead handle scrubs')
    await assertFocused(viewport(), 'Scrubbing the playhead must transfer composer focus')
    await tapTransport(draft)
    pass('Playhead scrubbing transfers focus and restores Space transport with the same draft')

    await input().click()
    await page.locator('[data-clip-id="fixture-clip"]').click({ position: { x: 40, y: 25 } }); await frame()
    await assertFocused(viewport(), 'Clip selection focuses timeline')
    assert.deepEqual((await view()).selectedClipIds, ['fixture-clip'])
    await tapTransport(draft)
    await input().click()
    await page.locator('[data-track-lane="true"]').first().click({ position: { x: 540, y: 25 } }); await frame()
    await assertFocused(viewport(), 'Empty track/gap click focuses timeline')
    assert.deepEqual((await view()).selectedClipIds, [])
    await tapTransport(draft)
    pass('Clip selection and empty track clicks focus timeline without changing authored data')

    await input().click()
    await page.locator('[data-marker-handle="true"]').click(); await frame()
    await assertFocused(viewport(), 'Marker flag selects timeline despite its button and preventDefault handler')
    assert.equal((await view()).selectedMarkerId, 'fixture-marker')
    await tapTransport(draft)
    pass('Existing marker flag selection transfers focus and restores Space transport')

    // A Space that started as typed text cannot become a play toggle merely
    // because the pointer transfers focus before its matching keyup.
    await input().click(); await page.keyboard.press('End'); await page.keyboard.down('Space')
    const heldDraft = `${draft} `
    assert.equal(await input().inputValue(), heldDraft)
    await ruler().click({ position: { x: 210, y: 10 } }); await page.keyboard.up('Space'); await frame()
    await assertFocused(viewport(), 'A deliberate click still transfers focus while Space was held in chat')
    assert.equal((await view()).isPlaying, false, 'Releasing chat-origin Space cannot start playback')
    await tapTransport(heldDraft)
    pass('Chat-origin held Space cannot leak into playback when focus moves before keyup')

    // A real inline Timeline field remains a native editor. Escape cancels
    // this rename so the regression test never authors a project mutation.
    await page.getByTitle('Double-click to rename', { exact: true }).first().dblclick()
    const rename = page.getByTestId('fixture-timeline').locator('input[type="text"]')
    await rename.waitFor(); await rename.click(); await rename.fill('Temporary track')
    await page.keyboard.press('End'); await page.keyboard.press('Space')
    await assertFocused(rename, 'Timeline inline editor retains its own focus')
    assert.equal(await rename.inputValue(), 'Temporary track ')
    assert.equal((await view()).isPlaying, false)
    await page.keyboard.press('Escape'); await frame()
    const zoom = page.getByTestId('fixture-timeline').locator('input[type="range"]')
    const zoomValue = await zoom.inputValue()
    const thumbPosition = await zoom.evaluate(node => ({
      // Native Chromium's default range thumb is 16px, with 8px end insets.
      x: 8 + (Number(node.value) - Number(node.min)) / (Number(node.max) - Number(node.min)) * (node.clientWidth - 16),
      y: node.clientHeight / 2,
    }))
    await zoom.click({ position: thumbPosition }); await page.keyboard.press('Space'); await frame()
    await assertFocused(zoom, 'Native timeline range control keeps focus')
    assert.equal(await zoom.inputValue(), zoomValue, 'Clicking the existing slider thumb does not edit zoom')
    assert.equal((await view()).isPlaying, false)
    pass('Real inline track editor and timeline slider remain editable and do not trigger transport')

    await input().fill('Return to chat'); await page.keyboard.press('End'); await page.keyboard.press('Space')
    assert.equal(await input().inputValue(), 'Return to chat ')
    assert.equal((await view()).isPlaying, false)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().requests.length === 1)
    await frame()
    assert.equal((await snapshot()).requests.length, 1, 'Enter submits exactly one mocked provider request')
    assert.equal((await view()).isPlaying, false, 'Composer Enter never starts transport')
    const request = (await snapshot()).requests[0]
    await page.evaluate(requestId => window.connectedAgentTest.settle(requestId, { success: true, text: 'Synthetic focus check complete.' }), request.requestId)
    await page.getByText('Synthetic focus check complete.', { exact: true }).waitFor()
    pass('Returning to chat restores Space typing and Enter sends once without transport')

    const final = await snapshot()
    assert.deepEqual(final.authored, baseline, 'Focus, selection, transport and chat do not author project/assets/timeline/Undo/dirty changes')
    assert.deepEqual(final.forbiddenCalls, [], 'No native IO, settings writes, media preparation or generation')
    assert.equal(final.calls.filter(call => call.method === 'send').length, 1)
    assert.equal(final.calls.filter(call => call.method === 'capture').length, 0, 'No image capture requested')
    assert.deepEqual(blockedRequests, [], 'No model, cloud or external requests')
    assert.deepEqual(errors, [], 'No renderer errors')
    await capture('real-timeline-composer-focus')
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, groups, output, errors, blockedRequests }, null, 2))
    console.log('CONNECTED_AGENT_FOCUS_RESULT ' + JSON.stringify({ success: true, groups, output }))
  } catch (error) {
    await capture('failure').catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, blockedRequests,
      snapshot: await snapshot().catch(() => null), view: await view().catch(() => null),
      activeElement: await page.evaluate(() => document.activeElement?.outerHTML).catch(() => null) }, null, 2))
    console.error(`Connected agent focus fixture artifacts: ${output}`)
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
