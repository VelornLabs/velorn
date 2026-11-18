// Real Agent/Timeline renderer, synthetic provider events and RAM-only storage.
// Clipboard APIs are mocked; every native Copy event is cancelled before it can
// touch the OS clipboard. No provider, project IO, media generation or app launch.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Presentation fixture requires loopback HTTP')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-agent-presentation-'))

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
  await page.addInitScript(() => {
    window.__textTest = { writes: [], browserWrites: [], fallbackWrites: [], menus: [], links: [], copies: [], keys: [], reads: 0,
      nativeSuccess: true, browserSuccess: true, fallbackSuccess: true, menuSuccess: true }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { window.__textTest.browserWrites.push(text); if (!window.__textTest.browserSuccess) throw new Error('Synthetic clipboard failure') },
      readText: async () => { window.__textTest.reads++; throw new Error('Clipboard reads forbidden') },
      read: async () => { window.__textTest.reads++; throw new Error('Clipboard reads forbidden') },
    } })
    document.execCommand = command => {
      if (command !== 'copy') throw new Error(`Unexpected fixture execCommand: ${command}`)
      window.__textTest.fallbackWrites.push(document.activeElement?.value || '')
      return window.__textTest.fallbackSuccess
    }
    document.addEventListener('copy', event => {
      event.preventDefault()
      window.__textTest.copies.push({ text: document.getSelection()?.toString() || '', prevented: event.defaultPrevented })
    }, true)
    // Observe final prevention after all editor listeners, including listeners
    // re-registered by React. This never synthesizes an OS clipboard operation.
    window.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') queueMicrotask(() => {
        window.__textTest.keys.push({ key: event.key, ctrl: event.ctrlKey, meta: event.metaKey, prevented: event.defaultPrevented })
      })
    }, true)
  })
  const button = name => page.getByRole('button', { name, exact: true })
  const input = () => page.getByRole('textbox', { name: 'Message your agent', exact: true })
  const log = () => page.getByRole('log', { name: 'Agent conversation', exact: true })
  const replies = () => log().locator('.ca-message.ca-assistant:not([aria-busy="true"])')
  const replyContents = () => replies().locator('.ca-message-content > .ca-markdown').evaluateAll(nodes => nodes.map(node => {
    const copy = node.cloneNode(true)
    copy.querySelectorAll('[data-ca-copy-exclude]').forEach(control => control.remove())
    return copy.textContent
  }))
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const mock = () => page.evaluate(() => structuredClone(window.__textTest))
  const frames = (count = 3) => page.evaluate(count => new Promise(resolve => {
    const next = () => --count <= 0 ? resolve() : requestAnimationFrame(next)
    requestAnimationFrame(next)
  }), count)
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const capture = name => page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
  const installBridge = () => page.evaluate(() => {
    window.electronAPI.writeClipboardText = async text => { window.__textTest.writes.push(text); return { success: window.__textTest.nativeSuccess } }
    window.electronAPI.showTextCopyMenu = async text => { window.__textTest.menus.push(text); return { success: window.__textTest.menuSuccess } }
    window.electronAPI.openExternalUrl = async url => { window.__textTest.links.push(url); return { success: true } }
  })
  const send = async text => {
    const count = (await snapshot()).requests.length
    await input().fill(text); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, count)
    return (await snapshot()).requests.at(-1)
  }
  const settle = async (request, text) => {
    await page.evaluate(({ requestId, text }) => window.connectedAgentTest.settle(requestId, { success: true, text }), { requestId: request.requestId, text })
    await button('Stop response').waitFor({ state: 'hidden' }); await frames()
    return replies().last()
  }
  const reply = async text => settle(await send('Synthetic presentation check. Do not execute anything.'), text)
  const copy = async (scope, label, expected, field = 'writes') => {
    const before = (await mock())[field].length
    await scope.getByRole('button', { name: label, exact: true }).click(); await frames()
    assert.equal((await mock())[field].length, before + 1)
    assert.equal((await mock())[field].at(-1), expected)
    assert.equal(await scope.getByRole('button', { name: label, exact: true }).innerText(), 'Copied')
  }
  const selectParagraph = async (scope, focus) => scope.locator('.ca-markdown > p').first().evaluate((node, focus) => {
    if (focus === 'timeline') document.querySelector('[data-testid="timeline-viewport"]').focus()
    else { document.body.tabIndex = -1; document.body.focus() }
    const range = document.createRange(); range.selectNodeContents(node)
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range)
    return { text: selection.toString(), active: document.activeElement === document.body ? 'body' : document.activeElement?.dataset.testid }
  }, focus)
  const editorState = () => page.evaluate(async () => {
    const { default: timeline } = await import('/src/stores/timelineStore.js')
    const state = timeline.getState()
    return { copied: structuredClone(state.copiedClips), attributeClipboard: structuredClone(state.attributeClipboard),
      snapping: state.snappingEnabled, zoom: state.zoom, selectedClipIds: structuredClone(state.selectedClipIds) }
  })
  try {
    await page.goto(new URL('/tests/fixtures/connected-agent.html?dock=1&timeline=1', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    await page.getByTestId('timeline-viewport').waitFor(); await installBridge(); await frames()
    const baseline = (await snapshot()).authored
    await button('Assistant').click(); await input().waitFor()
    await button('Assistant settings').click()
    // Presentation coverage opts into the granular tools/research controls.
    await page.locator('summary').filter({ hasText: /^Advanced options$/ }).click()
    await page.locator('summary').filter({ hasText: /^Access options$/ }).click()
    await page.locator('select[aria-label="Model"] option[value="fixture-codex-fast"]').waitFor({ state: 'attached' })
    await page.getByLabel('Model', { exact: true }).selectOption('fixture-codex-fast')
    await button('Assistant settings').click()
    await page.getByRole('checkbox', { name: 'Velorn tools', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Research & setup', exact: true }).check()
    await button('Back to chat').click()

    const code = 'const mood = "warm";\nconsole.log(mood);'
    const markdown = ['A clear **creative direction** with `inline code`.', 'A second paragraph keeps the pace readable.',
      '- First creative choice\n- Second creative choice', '1. Establish the scene\n2. Finish on the subject',
      '> Keep the light soft.', `\`\`\`javascript\n${code}\n\`\`\``,
      '[Safe source](https://example.com/creative-guide)', '| Shot | Intent |\n| --- | --- |\n| Opening | Quiet |\n| Closing | Hopeful |'].join('\n\n')
    await reply(markdown)
    const first = replies().nth(0), content = first.locator('.ca-markdown')
    assert.equal(await content.locator(':scope > p').count(), 3)
    assert.equal(await content.locator('strong').innerText(), 'creative direction')
    assert.equal(await content.locator('ul > li').count(), 2); assert.equal(await content.locator('ol > li').count(), 2)
    assert.equal(await content.locator('blockquote').innerText(), 'Keep the light soft.')
    assert.equal(await content.locator('pre code').innerText(), `${code}\n`)
    assert.equal(await content.locator('table tbody tr').count(), 2)
    const link = content.locator('.ca-source-reference')
    assert.equal(await link.innerText(), 'Safe source')
    assert.equal(await link.getAttribute('href'), 'https://example.com/creative-guide')
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer')
    assert.equal(await content.locator('a').count(), 1)
    assert.equal((await mock()).links.length, 0)
    await link.click(); assert.deepEqual((await mock()).links, ['https://example.com/creative-guide'])
    await log().evaluate(node => { node.scrollTop = 0 }); await capture('readable-markdown-1440px')
    pass('Markdown remains readable; a public source opens through the browser bridge only after an explicit click')

    await copy(first, 'Copy response', markdown)
    await copy(first, 'Copy code', code)
    assert.equal((await mock()).browserWrites.length, 0); assert.equal((await mock()).fallbackWrites.length, 0)
    pass('Copy response and Copy code write exact text once through the mocked native bridge with visible success feedback')

    const unsafe = ['Inert markup and links follow.', '<script>window.__presentationExecuted = true</script>',
      '<img src="https://example.com/SHOULD_NOT_FETCH.png" onerror="window.__presentationExecuted=true">',
      '[JavaScript](javascript:alert(1)) [Local file](file:///fixture-only/private.txt) [Data link](data:text/html,test)',
      '![Remote picture](https://example.com/SHOULD_NOT_FETCH_2.png)',
      '<iframe src="https://example.com/SHOULD_NOT_FETCH_3"></iframe>'].join('\n\n')
    const malicious = await reply(unsafe)
    assert.equal(await malicious.locator('script,img,iframe,object,embed').count(), 0)
    assert.equal(await malicious.locator('a').count(), 0)
    assert.equal(await page.evaluate(() => Boolean(window.__presentationExecuted)), false)
    assert.ok(!(await mock()).links.some(url => url.includes('SHOULD_NOT_FETCH')))
    assert.ok(!blockedRequests.some(url => url.includes('SHOULD_NOT_FETCH')), 'Unsafe rendered markup must not even attempt a fetch')
    pass('Raw HTML, scripts, embeds, images and javascript/file/data links remain inert and trigger no automatic fetch')

    const legacy = JSON.stringify({ opinion: 'The intimate arrangement supports the scene.', musicPrompt: 'Warm piano, restrained percussion and a hopeful ending.',
      suggestedStructure: ['Opening: sparse piano', 'Middle: add a soft pulse', 'Ending: let the final note breathe'], importantNote: 'Keep the original dialogue audible.' }, null, 2)
    const legacyReply = await reply(legacy)
    assert.deepEqual(await legacyReply.locator('.ca-markdown h3').allTextContents(), ['Music prompt', 'Suggested structure', 'Note'])
    assert.equal(await legacyReply.locator('.ca-markdown li').count(), 3)
    assert.equal(await legacyReply.locator('.ca-original-response').getAttribute('open'), null)
    await legacyReply.locator('.ca-original-response > summary').click()
    assert.equal(await legacyReply.locator('.ca-original-response pre').innerText(), legacy)
    await copy(legacyReply, 'Copy original response', legacy)
    const readableLegacy = ['The intimate arrangement supports the scene.', '### Music prompt\n\nWarm piano, restrained percussion and a hopeful ending.',
      '### Suggested structure\n\n- Opening: sparse piano\n- Middle: add a soft pulse\n- Ending: let the final note breathe', '### Note\n\nKeep the original dialogue audible.'].join('\n\n')
    await copy(legacyReply, 'Copy response', readableLegacy)
    pass('The known legacy music response becomes readable prose and lists while its exact original JSON remains expandable and copyable')

    const arbitrary = '{\n  "workflow": { "seed": 42, "steps": [1, 2] },\n  "note": "Preserve this JSON exactly"\n}'
    const arbitraryReply = await reply(arbitrary)
    assert.equal(await arbitraryReply.locator('.ca-markdown pre code').innerText(), arbitrary)
    assert.equal(await arbitraryReply.locator('.ca-original-response').count(), 0)
    await copy(arbitraryReply, 'Copy JSON', arbitrary)
    const fenced = `\`\`\`json\n${legacy}\n\`\`\``
    const fencedReply = await reply(fenced)
    assert.equal(await fencedReply.locator('.ca-markdown pre code').innerText(), `${legacy}\n`)
    assert.equal(await fencedReply.locator('.ca-original-response').count(), 0)
    await copy(fencedReply, 'Copy code', legacy)
    pass('Arbitrary workflow JSON and explicitly fenced legacy JSON stay literal and retain exact Copy JSON/Copy code source')

    const progressRequest = await send('Synthetic legacy progress and command disclosure check.')
    for (const source of [markdown, legacy, arbitrary, fenced]) {
      assert.ok(progressRequest.messages.some(message => message.role === 'assistant' && message.content === source), 'Provider history retains original source, not presentation output')
    }
    await page.evaluate(requestId => {
      window.connectedAgentTest.emitEvent({ requestId, type: 'progress', itemId: 'legacy-progress', phase: 'commentary', status: 'running',
        text: JSON.stringify({ status: 'working', message: 'Reading the synthetic scene before answering.' }) })
      window.connectedAgentTest.emitEvent({ requestId, type: 'tool', callId: 'shell-details', toolName: 'run_command', status: 'running',
        summary: 'printf SYNTHETIC_COMMAND_DO_NOT_EXECUTE', output: 'Synthetic command output only.' })
    }, progressRequest.requestId)
    await frames()
    const progress = page.locator('[data-activity-id="progress:legacy-progress"]')
    const command = page.locator('[data-activity-id="tool:shell-details"]')
    // Detailed activity is intentionally collapsed since preview .8.
    await page.locator('.ca-live-activity > summary').click()
    assert.equal(await progress.locator('.ca-markdown').innerText(), 'Reading the synthetic scene before answering.')
    assert.doesNotMatch(await progress.innerText(), /"status"|"message"/)
    assert.match(await command.locator('.ca-tool-heading').innerText(), /(?:run_command|Shell command)\s+Running/)
    assert.equal(await command.locator('.ca-command-details').getAttribute('open'), null)
    assert.equal(await command.locator('.ca-command-details pre').isVisible(), false)
    assert.equal(await command.locator('.ca-command-output').getAttribute('open'), null)
    await command.locator('.ca-command-details > summary').click()
    assert.equal(await command.locator('.ca-command-details pre').innerText(), 'printf SYNTHETIC_COMMAND_DO_NOT_EXECUTE')
    await page.evaluate(requestId => window.connectedAgentTest.emitEvent({ requestId, type: 'tool', callId: 'shell-details',
      toolName: 'run_command', status: 'completed', summary: 'printf SYNTHETIC_COMMAND_DO_NOT_EXECUTE' }), progressRequest.requestId)
    await frames(); assert.match(await command.locator('.ca-tool-heading').innerText(), /Completed/)
    await settle(progressRequest, 'The synthetic scene review is complete.')
    pass('Legacy progress envelopes show their message; shell commands/output start collapsed while running and completed status stay visible')

    await first.scrollIntoViewIfNeeded()
    const beforeEditor = await editorState()
    for (const focus of ['body', 'timeline']) {
      for (const shortcut of ['Control+c', 'Meta+c']) {
        const selected = await selectParagraph(first, focus)
        assert.equal(selected.active, focus === 'body' ? 'body' : 'timeline-viewport')
        assert.equal(selected.text, 'A clear creative direction with inline code.')
        const before = await mock()
        await page.keyboard.press(shortcut); await frames()
        assert.equal((await mock()).keys.length, before.keys.length + 1)
        assert.equal((await mock()).keys.at(-1).prevented, false, `${shortcut} with ${focus} focus remains browser-owned`)
        if (shortcut === 'Control+c') {
          assert.equal((await mock()).copies.length, before.copies.length + 1)
          assert.deepEqual((await mock()).copies.at(-1), { text: selected.text, prevented: true })
        }
        assert.deepEqual(await editorState(), beforeEditor, 'Text Copy must not copy clips or invoke another editor action')
      }
    }
    pass('Selected response Ctrl+C and Cmd+C remain native text gestures with body or actual Timeline focus; OS Copy is cancelled by the test and no clips are copied')

    // Simulate a legacy/custom binding already loaded in RAM, without saving
    // settings or weakening the ordinary reserved-binding validation.
    await page.evaluate(async () => {
      const hotkeys = await import('/src/services/editorHotkeys.js')
      window.dispatchEvent(new CustomEvent(hotkeys.EDITOR_HOTKEYS_CHANGED_EVENT, { detail: {
        ...hotkeys.DEFAULT_EDITOR_HOTKEYS, [hotkeys.EDITOR_HOTKEY_IDS.TOGGLE_SNAPPING]: 'Ctrl+C',
      } }))
    })
    await frames(); await selectParagraph(first, 'timeline'); await page.keyboard.press('Control+c'); await frames()
    assert.equal((await mock()).keys.at(-1).prevented, false)
    assert.deepEqual(await editorState(), beforeEditor)
    await page.evaluate(async () => {
      const hotkeys = await import('/src/services/editorHotkeys.js')
      window.dispatchEvent(new CustomEvent(hotkeys.EDITOR_HOTKEYS_CHANGED_EVENT, { detail: hotkeys.DEFAULT_EDITOR_HOTKEYS }))
    })
    pass('Selected text wins before a pre-existing custom Ctrl+C editor binding without changing settings, snapping or clip clipboard')

    const selected = await selectParagraph(first, 'body')
    await first.locator('.ca-markdown > p').first().dispatchEvent('contextmenu')
    assert.equal((await mock()).menus.at(-1), selected.text)
    await page.evaluate(() => { window.__textTest.menuSuccess = false })
    await first.locator('.ca-markdown > p').first().dispatchEvent('contextmenu')
    await page.getByRole('alert').filter({ hasText: 'Could not open Copy' }).waitFor()
    await page.evaluate(() => { window.__textTest.menuSuccess = true })
    await first.locator('.ca-markdown > p').first().dispatchEvent('contextmenu')
    await page.getByRole('alert').filter({ hasText: 'Could not open Copy' }).waitFor({ state: 'hidden' })
    await page.evaluate(() => document.getSelection().removeAllRanges())
    const menus = (await mock()).menus.length
    await first.locator('.ca-markdown > p').first().dispatchEvent('contextmenu')
    assert.equal((await mock()).menus.length, menus, 'No selection retains the normal browser context menu')
    pass('Selected-response context menu passes only selected text to the mocked native menu and reports native-menu failure')

    await page.evaluate(() => { window.__textTest.nativeSuccess = false })
    await first.getByRole('button', { name: 'Copy response', exact: true }).click()
    await first.getByRole('status').filter({ hasText: 'Could not copy.' }).waitFor()
    assert.equal((await mock()).browserWrites.length, 0, 'Explicit native failure does not silently take another clipboard path')
    await page.evaluate(() => { delete window.electronAPI.writeClipboardText })
    await copy(first, 'Copy response', markdown, 'browserWrites')
    await page.evaluate(() => { window.__textTest.browserSuccess = false })
    await copy(first, 'Copy response', markdown, 'fallbackWrites')
    await page.evaluate(() => { window.__textTest.fallbackSuccess = false })
    await first.getByRole('button', { name: 'Copy response', exact: true }).click()
    await first.getByRole('status').filter({ hasText: 'Could not copy.' }).waitFor()
    await installBridge(); await page.evaluate(() => { window.__textTest.nativeSuccess = true })
    pass('Clipboard failures show actionable feedback; old-preload browser and execCommand fallback paths copy exact text through RAM mocks only')

    await input().fill('Existing draft: ')
    const pasteText = 'First pasted line\nSecond pasted line'
    const paste = await input().evaluate((node, text) => {
      const transfer = new DataTransfer(); transfer.setData('text/plain', text)
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
      const allowed = node.dispatchEvent(event)
      return { allowed, prevented: event.defaultPrevented }
    }, pasteText)
    assert.deepEqual(paste, { allowed: true, prevented: false })
    // Untrusted synthetic paste cannot insert browser text. insertText supplies
    // the normal editing step from RAM without reading the actual OS clipboard.
    await input().press('End'); await page.keyboard.insertText(pasteText)
    assert.equal(await input().inputValue(), `Existing draft: ${pasteText}`)
    assert.equal((await mock()).reads, 0)
    assert.deepEqual(await editorState(), beforeEditor)
    pass('Text-only paste is not prevented by the composer; multiline text insertion stays in the draft with no clipboard read or Timeline mutation')

    const chat = await page.getByLabel('Conversation', { exact: true }).inputValue()
    const draft = await input().inputValue(), savedText = await replyContents()
    for (const workspace of ['Storyboard', 'Generate', 'Stock', 'ComfyUI', 'Export', 'Discover', 'Editor']) {
      await page.getByRole('navigation', { name: 'Fixture workspace modes' }).getByRole('button', { name: workspace, exact: true }).click()
      await frames()
      assert.equal(await page.getByLabel('Conversation', { exact: true }).inputValue(), chat)
      assert.equal(await input().inputValue(), draft)
      assert.deepEqual(await replyContents(), savedText)
      assert.match(await page.locator('.ca-selected-model').innerText(), /fixture-codex-fast/)
    }
    await button('New chat').click(); await frames()
    assert.notEqual(await page.getByLabel('Conversation', { exact: true }).inputValue(), chat)
    await page.getByLabel('Conversation', { exact: true }).selectOption(chat); await frames()
    assert.equal(await input().inputValue(), draft)
    assert.deepEqual(await replyContents(), savedText)
    pass('Rendered history, selected model, selected conversation and unsent multiline draft survive all seven workspaces and conversation switching')

    const layoutText = ['Readable layout at narrow and normal dock widths.', `\`\`\`text\n${'LongToken'.repeat(80)}\n\`\`\``,
      '| First column | Second column | Third column |\n| --- | --- | --- |\n| Detailed creative direction | Keep this editable | Synthetic content |',
      '- A list item stays inside the reply.\n- Another list item can wrap naturally.'].join('\n\n')
    const layoutReply = await reply(layoutText)
    for (const width of [900, 400]) {
      await page.setViewportSize({ width, height: 1050 }); await frames(5)
      await layoutReply.scrollIntoViewIfNeeded()
      const geometry = await layoutReply.evaluate(node => {
        const panel = node.closest('.ca-docked'), rect = panel.getBoundingClientRect()
        return { panelClient: panel.clientWidth, panelScroll: panel.scrollWidth, left: rect.left, right: rect.right, viewport: innerWidth,
          messageClient: node.clientWidth, messageScroll: node.scrollWidth,
          logClient: node.parentElement.clientWidth, logScroll: node.parentElement.scrollWidth,
          code: [...node.querySelectorAll('pre')].map(pre => ({ client: pre.clientWidth, scroll: pre.scrollWidth })) }
      })
      measurements.push({ width, geometry })
      assert.ok(geometry.panelScroll <= geometry.panelClient + 1, `Panel horizontal overflow at ${width}: ${JSON.stringify(geometry)}`)
      assert.ok(geometry.messageScroll <= geometry.messageClient + 1, `Reply horizontal overflow at ${width}`)
      assert.ok(geometry.logScroll <= geometry.logClient + 1, `Conversation horizontal overflow at ${width}`)
      assert.ok(geometry.left >= 0 && geometry.right <= width + 1, `Dock remains on-screen at ${width}`)
      for (const pre of geometry.code) assert.ok(pre.scroll <= pre.client + 1, `Long code wraps at ${width}`)
      await capture(`chat-presentation-${width}px`)
    }
    await page.setViewportSize({ width: 1440, height: 1050 }); await frames()
    pass('Markdown, a wide table and long code stay within 400px/900px viewport docks without horizontal reply, log or panel overflow')

    const sources = Array.from({ length: 16 }, (_, index) => `https://www.youtube.com/watch?v=demo${index}&t=12s`)
    const manySources = await reply(sources.map((url, index) => `[Video ${index}](${url})`).join('\n\n'))
    assert.equal(await manySources.getByRole('link').count(), 16)
    assert.doesNotMatch(await manySources.innerText(), /link omitted/)
    const beforeOpen = (await mock()).links.length
    await frames(); assert.equal((await mock()).links.length, beforeOpen)
    await manySources.getByRole('link', { name: 'Video 15', exact: true }).focus()
    await page.keyboard.press('Enter'); await frames()
    assert.equal((await mock()).links.length, beforeOpen + 1)
    assert.equal((await mock()).links.at(-1), sources[15])
    await page.evaluate(() => { window.electronAPI.openExternalUrl = async () => ({ success: false }) })
    await manySources.getByRole('link', { name: 'Video 0', exact: true }).click()
    await manySources.getByRole('status').filter({ hasText: 'Could not open this link.' }).waitFor()
    await installBridge()
    await manySources.getByRole('link', { name: 'Video 0', exact: true }).click()
    await manySources.getByRole('status').filter({ hasText: 'Could not open this link.' }).waitFor({ state: 'hidden' })
    await capture('public-video-links')
    pass('More than eight video citations survive; keyboard activation opens exactly one source and browser failure offers a copyable URL')

    assert.deepEqual((await snapshot()).authored, baseline, 'Formatting, text gestures and navigation leave authored state unchanged before reload')
    assert.deepEqual((await snapshot()).forbiddenCalls, [])
    const storage = (await snapshot()).storage
    const storedMessages = Object.values(storage).flatMap(value => {
      try { return (JSON.parse(value).conversations || []).flatMap(chat => chat.messages || []) } catch { return [] }
    })
    for (const source of [markdown, legacy, arbitrary, fenced]) {
      assert.ok(storedMessages.some(message => message.role === 'assistant' && message.text === source), 'Saved history retains exact original source, not presentation output')
    }
    const beforeReloadText = await replyContents()
    await page.addInitScript(storage => { window.__connectedAgentFixtureStorage = storage }, storage)
    await page.reload(); await page.waitForFunction(() => window.connectedAgentTest?.ready); await installBridge()
    await button('Assistant').click(); await input().waitFor(); await frames()
    assert.equal(await page.getByLabel('Conversation', { exact: true }).inputValue(), chat)
    assert.deepEqual(await replyContents(), beforeReloadText)
    assert.match(await page.locator('.ca-selected-model').innerText(), /fixture-codex-fast/)
    assert.deepEqual((await snapshot()).authored, baseline)
    assert.deepEqual((await snapshot()).forbiddenCalls, [])
    assert.deepEqual(blockedRequests, [])
    assert.deepEqual(errors, [])
    assert.equal((await mock()).reads, 0)
    pass('RAM-only reload preserves selected model/chat and original stored replies; authored project, Undo history and dirty state remain unchanged with zero forbidden IO')
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, groups, measurements, errors, blockedRequests }, null, 2))
    console.log(`RESULT ${groups.length} presentation groups passed; artifacts: ${output}`)
  } catch (error) {
    await capture('failure').catch(() => {})
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: false, groups, error: error.stack, errors, blockedRequests, measurements }, null, 2))
    console.error(`Artifacts: ${output}`); throw error
  } finally { await context.close(); await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
