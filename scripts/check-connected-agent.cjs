// Isolated real-renderer coverage. Providers/captures are deterministic fixture
// promises; requests to models, clouds, generation or native project IO fail.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Connected agent fixture requires loopback HTTP')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-connected-agent-'))

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', serviceWorkers: 'block' })
  await context.addInitScript(() => {
    window.fixtureEscapedKeys = []
    document.addEventListener('keydown', event => window.fixtureEscapedKeys.push(event.key))
    window.fixtureMediaCalls = []
    for (const method of ['play', 'load']) {
      const original = HTMLMediaElement.prototype[method]
      HTMLMediaElement.prototype[method] = function (...args) {
        window.fixtureMediaCalls.push({ method, tag: this.tagName }); return original.apply(this, args)
      }
    }
  })
  const page = await context.newPage(), groups = [], errors = [], blockedRequests = []
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    // Only Vite modules, static assets and translations from this fixture.
    const forbiddenEndpoint = /^\/(?:prompt|queue|interrupt|system_stats|history|upload|view|ws|v1|api)(?:\/|$)/.test(url.pathname)
    if (url.origin === base.origin && !forbiddenEndpoint) return route.continue()
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
  const tab = name => page.getByRole('navigation', { name: 'Fixture workspace modes' }).getByRole('button', { name, exact: true })
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const authored = async () => (await snapshot()).authored
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const capture = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
  const check = async () => {
    await openSettings()
    const count = (await snapshot()).calls.filter(call => call.method === 'inspect').length
    await button('Check connection').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().calls.filter(call => call.method === 'inspect').length > count, count)
  }
  const provider = async name => {
    await openSettings()
    const select = page.getByLabel('Assistant selection', { exact: true })
    const value = await select.locator('option').evaluateAll((options, name) => options.find(option => option.textContent.replace(/\s/g, '').toLowerCase().includes(name.toLowerCase()))?.value, name.replace(/\s/g, ''))
    assert.ok(value, `Provider ${name} exists`)
    await select.selectOption(value)
    await backToChat()
  }
  const send = async text => {
    await backToChat()
    const count = (await snapshot()).requests.length
    await input().fill(text); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, count)
    return (await snapshot()).requests.at(-1)
  }
  const settle = (request, result) => page.evaluate(({ requestId, result }) => window.connectedAgentTest.settle(requestId, result), { requestId: request.requestId, result })
  const emit = (request, type, text) => page.evaluate(({ requestId, type, text }) => window.connectedAgentTest.emit(requestId, type, text), { requestId: request.requestId, type, text })
  const assertAgentIdentity = async (providerName, busy = false) => {
    await page.getByRole('complementary', { name: 'Velorn Assistant', exact: true }).waitFor()
    assert.equal(await page.getByRole('heading', { name: 'Velorn Assistant', exact: true }).isVisible(), true)
    assert.equal(await page.getByLabel('Current assistant permissions', { exact: true }).locator('span').first().innerText(), providerName, 'Provider status keeps the selected backend name')
    assert.equal(await page.locator('.ca-assistant[aria-busy="true"]').count(), busy ? 1 : 0)
    const assistantLabels = await page.locator('.ca-assistant > strong').allTextContents()
    assert.ok(assistantLabels.length > 0)
    assert.ok(assistantLabels.every(label => label === 'Velorn Assistant'), 'Streaming, completed and restored replies use the product agent name')
    const userLabels = await page.locator('.ca-user > strong').allTextContents()
    assert.ok(userLabels.length > 0)
    assert.ok(userLabels.every(label => label === 'You'), 'User messages retain their sender label')
  }
  const reply = async (request, text, providerName) => {
    await emit(request, 'delta', text)
    await page.getByText(text, { exact: true }).waitFor()
    if (providerName) await assertAgentIdentity(providerName, true)
    await settle(request, { success: true, text })
    await button('Stop response').waitFor({ state: 'hidden' })
    if (providerName) await assertAgentIdentity(providerName)
  }
  const assertUnchanged = async before => assert.deepEqual(await authored(), before, 'Conversation/navigation must not author project, asset, timeline, dirty or Undo state')
  const safe = async () => {
    assert.deepEqual((await snapshot()).forbiddenCalls, [], 'No native project IO, generation, settings or media preparation')
    assert.deepEqual(blockedRequests, [], 'No cloud, model, generation or external network')
    assert.deepEqual(errors, [], 'No renderer errors')
    assert.deepEqual(await page.evaluate(() => window.fixtureMediaCalls), [], 'Conversation does not load or play media')
  }
  try {
    await page.goto(new URL('/tests/fixtures/connected-agent.html', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    await input().waitFor()
    const baseline = await authored()
    assert.equal(baseline.dirty, false)
    assert.equal(await button('Assistant settings').getAttribute('aria-expanded'), 'false')
    for (const control of [page.getByLabel('Assistant selection', { exact: true }), page.getByLabel('Model', { exact: true }),
      button('Check connection'), page.getByRole('checkbox', { name: 'Velorn tools', exact: true }), page.getByRole('checkbox', { name: 'Share images', exact: true })]) {
      assert.equal(await control.isVisible(), false, 'Configuration stays out of the default chat-first view')
    }
    const initialSubscriptions = (await snapshot()).listenerSubscriptions
    assert.equal((await snapshot()).calls.filter(call => call.method === 'inspect').length, 0, 'Chat mount does not inspect Codex until settings are opened')
    await input().fill('Unsent draft survives settings navigation.')
    await button('Assistant settings').focus(); await page.keyboard.press('Enter')
    assert.equal(await button('Assistant settings').getAttribute('aria-expanded'), 'true')
    assert.equal(await input().isVisible(), false)
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Work in Velorn')
    await page.getByLabel('Model', { exact: true }).focus(); await page.keyboard.press('Escape')
    await input().waitFor()
    assert.equal(await button('Assistant settings').evaluate(node => document.activeElement === node), true)
    assert.equal(await input().inputValue(), 'Unsent draft survives settings navigation.')
    await openSettings(); await backToChat()
    assert.equal(await button('Assistant settings').evaluate(node => document.activeElement === node), true)
    assert.equal(await input().inputValue(), 'Unsent draft survives settings navigation.')
    assert.equal((await snapshot()).listenerSubscriptions, initialSubscriptions, 'Settings do not remount the conversation')
    assert.equal((await snapshot()).calls.filter(call => call.method === 'inspect').length, 1, 'First settings open loads the Codex catalog once; revisiting settings does not repeat it')
    assert.equal((await snapshot()).requests.length, 0, 'Catalog discovery never sends a conversation prompt')
    await input().fill(''); await assertUnchanged(baseline)
    pass('Chat opens without setup controls; keyboard gear, Escape and Back preserve draft and restore focus without remounting')
    assert.equal(await setting('Share images', 'isChecked'), false)
    assert.equal((await snapshot()).requests.length, 0)
    await check()
    const first = await send('Compare Shot 7 with Shot 06 before making any changes.')
    assert.ok(first.requestId)
    assert.equal(first.provider, 'codex')
    assert.deepEqual(first.images || [], [], 'No image payload without explicit opt-in')
    const metadata = JSON.stringify(first.context)
    assert.ok(metadata.includes('Shot 07') && metadata.includes('Shot 06'), 'Context uses durable shot labels')
    assert.ok(!metadata.includes('PRIVATE_PATH') && !metadata.includes('data:image') && !metadata.includes('file://'), 'Context excludes paths and image bytes')
    assert.equal(first.context.editor.timeline.playheadSeconds, 2.5)
    assert.equal(first.context.editor.timeline.id, 'timeline-alpha')
    assert.equal(first.context.editor.timeline.name, 'Editable animatic')
    assert.deepEqual(first.context.editor.timeline.selectedClipIds, ['fixture-clip'])
    await emit(first, 'status', 'Fixture is reviewing the shared metadata')
    await reply(first, 'Codex fixture reply: Shot 07 and Shot 06 remain unchanged.', 'Codex')
    await openSettings(); await backToChat()
    await page.getByText('Codex fixture reply: Shot 07 and Shot 06 remain unchanged.', { exact: true }).waitFor()
    await assertUnchanged(baseline)
    pass('Codex connection, metadata-only request, durable shot references and streaming response work without authoring changes')

    const linked = await send('Point to Shot 7 without changing the storyboard.')
    const markerText = 'Review [[shot:shot-7]] beside [[shot:shot-6]]. Unknown [[shot:missing-shot]] is unavailable.'
    await emit(linked, 'delta', markerText)
    await settle(linked, { success: true, text: markerText })
    await button('Stop response').waitFor({ state: 'hidden' })
    await page.getByText('Review Shot 07 beside Shot 06. Unknown [unavailable shot] is unavailable.', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'missing-shot', exact: true }).count(), 0)
    await button('Shot 07').click()
    await page.locator('[data-shot-id="shot-7"].pr-agent-highlight').waitFor()
    assert.equal(await page.evaluate(() => window.connectedAgentTest.workspace().activeTab), 'storyboard')
    await assertUnchanged(baseline)
    pass('Validated response shot links open the real Storyboard and highlight the saved shot, while invalid model references cannot navigate')

    await setting('Share images', 'check')
    assert.equal(await setting('Include current view', 'isChecked'), false)
    const visible = await send('Review only the storyboard stills visible in this workspace.')
    assert.equal(visible.context.editor.activeTab, 'storyboard')
    assert.ok(visible.context.visibleShotIds.length > 0 && visible.context.visibleShotIds.length <= 4)
    assert.equal(visible.images.length, visible.context.visibleShotIds.length)
    assert.ok(visible.images.every(image => visible.context.visibleShotIds.some(id => image.label.includes(`(${id})`))))
    assert.equal((await snapshot()).calls.some(call => call.method === 'capture'), false, 'Existing stills do not silently capture the current screen')
    await reply(visible, 'Visible storyboard stills reviewed; no playback or edit was performed.')
    await setting('Share images', 'uncheck')
    await capture('00-shot-reference-review')
    await assertUnchanged(baseline)
    pass('Opt-in Storyboard stills correspond only to visible cards, are bounded to four, and do not implicitly capture the workspace')

    await tab('Storyboard').click(); await page.locator('.pr-shot-card').nth(7).waitFor()
    await page.getByText('Codex fixture reply: Shot 07 and Shot 06 remain unchanged.', { exact: true }).waitFor()
    await tab('Editor').click()
    await page.getByText('Codex fixture reply: Shot 07 and Shot 06 remain unchanged.', { exact: true }).waitFor()
    await capture('01-editor-conversation')
    await assertUnchanged(baseline)
    pass('The same conversation remains visible across Editor and Storyboard navigation')

    await input().focus(); await page.evaluate(() => { window.fixtureEscapedKeys.length = 0 })
    for (const key of ['Space', 'j', 'k', 'l', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', 'Control+z', 'Control+Shift+z']) await page.keyboard.press(key)
    assert.deepEqual(await page.evaluate(() => window.fixtureEscapedKeys), [], 'Input keys do not escape to editor or transport')
    const beforeKeyboardSend = (await snapshot()).requests.length
    await input().fill('Keyboard first line')
    await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Second line')
    assert.equal(await input().inputValue(), 'Keyboard first line\nSecond line')
    assert.equal((await snapshot()).requests.length, beforeKeyboardSend)
    await page.keyboard.press('Enter')
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, beforeKeyboardSend)
    await reply((await snapshot()).requests.at(-1), 'Enter sent a chat message, not a transport command.')
    assert.deepEqual(await page.evaluate(() => window.fixtureEscapedKeys), [])
    await assertUnchanged(baseline)
    pass('Typing, transport letters, selection keys, delete and Undo shortcuts remain inside the conversation input')

    await provider('LM Studio'); await check()
    assert.equal(await page.getByText('Codex fixture reply: Shot 07 and Shot 06 remain unchanged.', { exact: true }).count(), 0)
    const local = await send('Review only: the local provider conversation is isolated.')
    assert.equal(local.provider, 'lmstudio')
    await reply(local, 'Local fixture reply, isolated from Codex.', 'LM Studio')
    await provider('Codex')
    await page.getByText('Codex fixture reply: Shot 07 and Shot 06 remain unchanged.', { exact: true }).waitFor()
    await assertAgentIdentity('Codex')
    assert.equal(await page.getByText('Local fixture reply, isolated from Codex.', { exact: true }).count(), 0)
    await assertUnchanged(baseline)
    pass('Codex and LM Studio histories are isolated per provider and restored when switching back')

    await page.evaluate(() => window.connectedAgentTest.switchProject('beta'))
    await page.waitForFunction(() => document.body.textContent.includes('Other — synthetic project'))
    const betaBaseline = await authored()
    assert.equal(await page.getByText('Codex fixture reply: Shot 07 and Shot 06 remain unchanged.', { exact: true }).count(), 0)
    const beta = await send('This is only the second project conversation.')
    await reply(beta, 'Second project fixture reply.')
    await assertUnchanged(betaBaseline)
    await page.evaluate(() => window.connectedAgentTest.switchProject('alpha'))
    await page.getByText('Codex fixture reply: Shot 07 and Shot 06 remain unchanged.', { exact: true }).waitFor()
    assert.equal(await page.getByText('Second project fixture reply.', { exact: true }).count(), 0)
    await assertUnchanged(baseline)
    pass('Different projects never share conversations; returning to a project restores its provider history')

    const stale = await send('Slow pending request before switching projects.')
    await page.evaluate(() => window.connectedAgentTest.switchProject('beta'))
    await page.getByText('Second project fixture reply.', { exact: true }).waitFor()
    await emit(stale, 'delta', 'STALE_STREAM_MUST_NOT_APPEAR')
    await settle(stale, { success: true, text: 'STALE_RESULT_MUST_NOT_APPEAR' })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.ok(!(await page.locator('body').innerText()).includes('STALE_'))
    assert.ok((await snapshot()).calls.some(call => call.method === 'cancel' && call.requestId === stale.requestId))
    await assertUnchanged(betaBaseline)
    await page.evaluate(() => window.connectedAgentTest.switchProject('alpha'))
    await page.getByText('Codex fixture reply: Shot 07 and Shot 06 remain unchanged.', { exact: true }).waitFor()
    assert.ok(!(await page.locator('body').innerText()).includes('STALE_'))
    pass('Project switches cancel in-flight work and reject late stream events and completed responses in both projects')

    const staleProvider = await send('Slow pending request before switching providers.')
    await provider('LM Studio')
    await page.getByText('Local fixture reply, isolated from Codex.', { exact: true }).waitFor()
    await assertAgentIdentity('LM Studio')
    await emit(staleProvider, 'delta', 'STALE_PROVIDER_STREAM_MUST_NOT_APPEAR')
    await settle(staleProvider, { success: true, text: 'STALE_PROVIDER_RESULT_MUST_NOT_APPEAR' })
    assert.ok((await snapshot()).calls.some(call => call.method === 'cancel' && call.requestId === staleProvider.requestId))
    await provider('Codex')
    assert.ok(!(await page.locator('body').innerText()).includes('STALE_PROVIDER_'))
    await assertUnchanged(baseline)
    pass('Switching provider cancels its pending request and ignores late results after switching back')

    const cancel = await send('Cancel this synthetic response.')
    await button('Stop response').click()
    await button('Stop response').waitFor({ state: 'hidden' })
    assert.ok((await snapshot()).calls.some(call => call.method === 'cancel' && call.requestId === cancel.requestId))
    await emit(cancel, 'delta', 'CANCELLED_STREAM_MUST_NOT_APPEAR')
    await settle(cancel, { success: true, text: 'CANCELLED_RESULT_MUST_NOT_APPEAR' })
    const recovery = await send('A new request after cancellation.')
    await reply(recovery, 'Cancellation recovery works.')
    assert.ok(!(await page.locator('body').innerText()).includes('CANCELLED_'))
    await assertUnchanged(baseline)
    pass('Stop cancels the current request, late cancelled results are ignored and a new request succeeds')

    await setting('Share images', 'check')
    await setting('Include current view', 'check')
    const visual = await send('Review the current visible workspace without changes.')
    assert.ok(visual.images?.length > 0, 'Explicit opt-in includes a visible workspace image')
    assert.ok(visual.images.every(image => image.label && /^data:image\//.test(image.dataUrl)))
    const lastCapture = (await snapshot()).calls.filter(call => call.method === 'capture').at(-1)
    assert.ok(lastCapture?.rect && lastCapture.rect.width > 0 && lastCapture.rect.height > 0)
    const workspaceBounds = await page.getByTestId('shared-workspace').boundingBox()
    assert.ok(Math.abs(lastCapture.rect.x - workspaceBounds.x) <= 1 && Math.abs(lastCapture.rect.width - workspaceBounds.width) <= 1, 'Screenshot capture excludes the conversation panel')
    await reply(visual, 'Image opt-in fixture reply.')
    await setting('Share images', 'uncheck')
    await assertUnchanged(baseline)
    pass('Images require visible opt-in and workspace capture is cropped to the workspace, excluding the private conversation')

    await page.evaluate(() => window.connectedAgentTest.setCaptureError('Fixture capture unavailable'))
    await setting('Share images', 'check')
    const unavailableImage = await send('Review the current workspace if the screenshot is available.')
    assert.deepEqual(unavailableImage.images, [])
    assert.ok(unavailableImage.context.visualReview.unavailable.includes('Current view'))
    assert.match(unavailableImage.context.visualReview.note, /Text context only/)
    await reply(unavailableImage, 'Capture failure was reported, without pretending to see images.')
    await openSettings()
    await page.getByText('Last message: 0 images · editor', { exact: true }).click()
    await page.getByText('Unavailable: Current view', { exact: true }).waitFor()
    await setting('Share images', 'uncheck')
    await page.evaluate(() => window.connectedAgentTest.setCaptureError(''))
    pass('Unavailable screenshots are visibly disclosed and the provider is told that it received text only')

    await provider('LM Studio'); await check()
    assert.equal(await setting('Vision-capable model', 'isChecked'), false)
    assert.equal(await setting('Share images', 'isDisabled'), true)
    await setting('Vision-capable model', 'check')
    await setting('Share images', 'check')
    const localVisual = await send('Review the explicit vision-model image attachment for Shot 07.')
    assert.equal(localVisual.vision, true)
    assert.ok(localVisual.images?.length > 0)
    await reply(localVisual, 'Local vision fixture reply.')
    await setting('Share images', 'uncheck')
    await provider('Codex')
    pass('LM Studio image sharing requires a separate, explicit vision-capable-model setting')

    await provider('LM Studio')
    await openSettings()
    await page.getByLabel('Model', { exact: true }).fill('fixture-preferred-local-model')
    await backToChat()
    await page.getByRole('button', { name: /Close assistant panel/i }).click()
    await button('Open agent').click(); await input().waitFor()
    await openSettings()
    assert.equal(await page.getByLabel('Assistant selection', { exact: true }).inputValue(), 'lmstudio')
    assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), 'fixture-preferred-local-model')
    assert.equal(await setting('Share images', 'isChecked'), false)
    assert.equal(await setting('Vision-capable model', 'isChecked'), false)
    const localAfterReopen = await send('Reopened local choice must stay local.')
    assert.equal(localAfterReopen.provider, 'lmstudio')
    await reply(localAfterReopen, 'Reopened local provider stayed local.')
    await provider('Codex')
    pass('The explicit local provider and model survive close/reopen with no cloud fallback, while image consent resets')

    await setting('Share images', 'check')
    await setting('Include current view', 'check')
    await page.evaluate(() => window.connectedAgentTest.setHoldCapture(true))
    const beforeCaptureCancel = await snapshot()
    await input().fill('Cancel while preparing a screenshot.'); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().calls.filter(call => call.method === 'capture').length > count,
      beforeCaptureCancel.calls.filter(call => call.method === 'capture').length)
    await button('Stop response').click(); await button('Stop response').waitFor({ state: 'hidden' })
    await page.evaluate(() => window.connectedAgentTest.releaseCapture())
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal((await snapshot()).requests.length, beforeCaptureCancel.requests.length, 'Stopped screenshot preparation must never send its captured frame')
    await page.evaluate(() => window.connectedAgentTest.setHoldCapture(false))
    await setting('Share images', 'uncheck'); await input().fill('')
    await assertUnchanged(baseline)
    pass('Cancelling during asynchronous frame capture prevents any subsequent provider send')

    await setting('Share images', 'check')
    await page.evaluate(() => window.connectedAgentTest.setHoldCapture(true))
    const beforeCaptureSwitch = await snapshot()
    await input().fill('Keep the captured image tied to this editor view.'); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().calls.filter(call => call.method === 'capture').length > count,
      beforeCaptureSwitch.calls.filter(call => call.method === 'capture').length)
    await tab('Storyboard').click(); await page.evaluate(() => window.connectedAgentTest.releaseCapture())
    await page.getByText('The workspace changed while preparing images. Please send again from the view you want to discuss.', { exact: true }).waitFor()
    await button('Stop response').waitFor({ state: 'hidden' })
    assert.equal((await snapshot()).requests.length, beforeCaptureSwitch.requests.length)
    await page.evaluate(() => window.connectedAgentTest.setHoldCapture(false))
    await setting('Share images', 'uncheck'); await input().fill('')
    await tab('Editor').click(); await assertUnchanged(baseline)
    pass('A workspace change during capture refuses the stale frame instead of sending it with mismatched context')

    const originalView = await page.evaluate(() => window.connectedAgentTest.editorView())
    for (const change of [{ timelineId: 'timeline-alpha-second' }, { sessionId: originalView.sessionId + 1 }, { playhead: 7.5 }]) {
      await setting('Share images', 'check')
      await page.evaluate(() => window.connectedAgentTest.setHoldCapture(true))
      const beforeViewChange = await snapshot()
      await input().fill('Keep this capture tied to its original timeline and frame.'); await button('Send message').click()
      await page.waitForFunction(count => window.connectedAgentTest.snapshot().calls.filter(call => call.method === 'capture').length > count,
        beforeViewChange.calls.filter(call => call.method === 'capture').length)
      await page.evaluate(change => window.connectedAgentTest.changeEditorView(change), change)
      assert.equal(await page.evaluate(() => window.connectedAgentTest.workspace().activeTab), 'editor', 'The tab does not change in this regression')
      const afterNavigation = await authored()
      await page.evaluate(() => window.connectedAgentTest.releaseCapture())
      await page.locator('.ca-error').filter({ hasText: /changed|moved/i }).waitFor()
      await button('Stop response').waitFor({ state: 'hidden' })
      assert.equal((await snapshot()).requests.length, beforeViewChange.requests.length, `Stale ${Object.keys(change)[0]} capture must not be sent`)
      await assertUnchanged(afterNavigation)
      await page.evaluate(original => { window.connectedAgentTest.setHoldCapture(false); window.connectedAgentTest.changeEditorView(original) }, originalView)
      await setting('Share images', 'uncheck'); await input().fill('')
      await assertUnchanged(baseline)
    }
    pass('Same-tab timeline, session and playhead changes during capture reject stale frames without sending or authoring changes')

    await page.evaluate(() => window.connectedAgentTest.setConnectionError('Fixture connection is unavailable'))
    await check(); await page.locator('.ca-options').getByText('Fixture connection is unavailable', { exact: false }).waitFor()
    await page.evaluate(() => window.connectedAgentTest.setConnectionError(''))
    await check()
    const failed = await send('Trigger a deterministic provider error.')
    await settle(failed, { success: false, error: 'Fixture provider rejected this request' })
    await page.getByRole('alert').filter({ hasText: 'Fixture provider rejected this request' }).waitFor()
    await button('Stop response').waitFor({ state: 'hidden' })
    const retried = await send('Recover after the deterministic provider error.')
    await reply(retried, 'Provider error recovery works.')
    await assertUnchanged(baseline)
    pass('Connection and request failures are visible, do not edit the project and allow recovery')

    const close = await send('Pending request while the panel closes.')
    await page.getByRole('button', { name: /Close (?:agent|conversation)/i }).click()
    await button('Open agent').waitFor()
    assert.ok((await snapshot()).calls.some(call => call.method === 'cancel' && call.requestId === close.requestId))
    assert.equal((await snapshot()).listenerCount, 0)
    await settle(close, { success: true, text: 'CLOSED_PANEL_RESULT_MUST_NOT_APPEAR' })
    await button('Open agent').click(); await input().waitFor()
    await page.getByText('Codex fixture reply: Shot 07 and Shot 06 remain unchanged.', { exact: true }).waitFor()
    await page.getByText('Provider error recovery works.', { exact: true }).waitFor()
    assert.ok(!(await page.locator('body').innerText()).includes('CLOSED_PANEL_'))
    assert.equal((await snapshot()).listenerCount, 1)
    const histories = Object.entries((await snapshot()).storage).filter(([key]) => key.startsWith('velorn.connected-agent.conversations.v1.'))
    assert.ok(histories.length >= 3)
    for (const [, raw] of histories) {
      const history = JSON.parse(raw)
      assert.deepEqual(Object.keys(history).sort(), ['activeId', 'conversations', 'version'])
      assert.equal(history.version, 1)
      assert.ok(history.conversations.some(chat => chat.id === history.activeId))
      for (const chat of history.conversations) {
        assert.deepEqual(Object.keys(chat).sort(), ['createdAt', 'id', 'messages', 'title', 'updatedAt'])
        for (const message of chat.messages) {
          assert.ok(['user', 'assistant'].includes(message.role))
          assert.equal(typeof message.text, 'string')
          assert.ok(Object.keys(message).every(key => ['role', 'text', 'shotIds', 'sourceUrls', 'requestedModel', 'requestedReasoningEffort', 'turnId', 'deliveryStatus'].includes(key)), 'Only allowlisted conversation display fields persist')
          if (message.turnId !== undefined) {
            assert.equal(typeof message.turnId, 'string')
            assert.match(message.turnId, /^[A-Za-z0-9_-]{1,100}$/)
          }
          if (message.deliveryStatus !== undefined) {
            assert.equal(message.role, 'assistant')
            assert.equal(message.deliveryStatus, 'failed')
          }
          if (message.requestedReasoningEffort !== undefined) {
            assert.equal(message.role, 'assistant')
            assert.ok(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(message.requestedReasoningEffort))
          }
          if (message.requestedModel !== undefined) {
            assert.equal(message.role, 'assistant')
            assert.equal(typeof message.requestedModel, 'string')
            assert.ok(message.requestedModel.length <= 256)
          }
          if (message.sourceUrls !== undefined) {
            assert.ok(Array.isArray(message.sourceUrls) && message.sourceUrls.length <= 1000)
            assert.ok(message.sourceUrls.every(url => typeof url === 'string' && url.length <= 2048 && url.startsWith('https://') && message.text.includes(url)))
          }
        }
      }
    }
    assert.ok(histories.every(([key, value]) => !key.includes('PRIVATE_PATH') && !value.includes('PRIVATE_PATH')
      && !value.includes('data:image') && !value.includes('"context":') && !value.includes('"endpoint":')), 'Persisted chat histories exclude image bytes, paths, provider endpoint and project snapshots')
    await assertUnchanged(baseline)
    pass('Closing cancels and removes stream listeners; reopening restores local conversation history without stale replies')

    await tab('Storyboard').click(); await page.locator('.pr-shot-card').nth(7).waitFor()
    for (const width of [900, 760]) {
      await page.setViewportSize({ width, height: 800 })
      await input().fill(`Narrow layout ${width}`)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No horizontal document overflow at ${width}px`)
      for (const target of [input(), button('Send message'), button('Assistant settings')]) {
        const hit = await target.evaluate(node => {
          const box = node.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2
          return { width: box.width, visible: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight,
            unobscured: node.contains(document.elementFromPoint(x, y)) }
        })
        assert.ok(hit.width > 20 && hit.visible && hit.unobscured, `Conversation control is reachable at ${width}px`)
      }
      const board = await page.getByTestId('shared-workspace').boundingBox()
      assert.ok(board.width > 150, `Storyboard remains present beside the conversation at ${width}px`)
      await openSettings()
      for (const target of [page.getByLabel('Assistant selection', { exact: true }), button('Back to chat')]) {
        await target.scrollIntoViewIfNeeded()
        const reachable = await target.evaluate(node => {
          const box = node.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2
          return x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && node.contains(document.elementFromPoint(x, y))
        })
        assert.equal(reachable, true, `Settings control is reachable at ${width}px`)
      }
      await backToChat()
      await capture(`02-narrow-${width}`)
    }
    await input().fill(''); await page.setViewportSize({ width: 1440, height: 1000 })
    await capture('03-storyboard-conversation'); await assertUnchanged(baseline); await safe()
    pass('At 900px and 760px the board and conversation coexist without horizontal overflow and all key controls remain reachable')
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, groups, output, errors, blockedRequests }, null, 2))
    console.log('CONNECTED_AGENT_RESULT ' + JSON.stringify({ success: true, groups, output }))
  } catch (error) {
    await capture('failure').catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, blockedRequests,
      snapshot: await snapshot().catch(() => null), body: await page.locator('body').innerText().catch(() => '') }, null, 2))
    console.error(`Connected agent fixture artifacts: ${output}`)
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
