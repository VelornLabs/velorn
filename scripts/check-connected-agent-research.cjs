// Research consent is exercised through actual renderer components and the
// deterministic RAM fixture. No website, provider, download or install runs.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Research fixture requires loopback HTTP')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-connected-agent-research-'))

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', serviceWorkers: 'block' })
  const page = await context.newPage(), errors = [], blockedRequests = [], groups = []
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
  const checkbox = name => page.getByRole('checkbox', { name, exact: true })
  const research = () => checkbox('Research & setup')
  const velornTools = () => checkbox('Velorn tools')
  const composer = () => page.getByRole('textbox', { name: 'Message your agent', exact: true })
  const permissions = () => page.getByLabel('Current assistant permissions', { exact: true })
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const pass = text => { groups.push(text); console.log(`PASS ${groups.length}: ${text}`) }
  const openSettings = async () => {
    if (await button('Assistant settings').getAttribute('aria-expanded') !== 'true') await button('Assistant settings').click()
    // These legacy regressions intentionally exercise the individual controls.
    const advanced = page.locator('summary').filter({ hasText: /^Access options$/ })
    if (!(await advanced.evaluate(node => node.parentElement.open))) await advanced.click()
  }
  const backToChat = async () => { if (await button('Back to chat').isVisible()) await button('Back to chat').click() }
  const enableResearch = async () => { await openSettings(); await velornTools().check(); await research().check(); await backToChat() }
  const assertReset = async () => {
    await openSettings()
    assert.equal(await velornTools().isChecked(), false)
    assert.equal(await research().isChecked(), false)
    assert.equal(await research().isDisabled(), true)
    await backToChat()
    assert.ok(!(await permissions().innerText()).includes('Research & setup'))
  }
  const send = async text => {
    await backToChat()
    const count = (await snapshot()).requests.length
    await composer().fill(text); await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, count)
    return (await snapshot()).requests.at(-1)
  }
  const emit = (request, event) => page.evaluate(event => window.connectedAgentTest.emitEvent(event), { requestId: request.requestId, ...event })
  const settle = async (request, text = 'Synthetic request complete; no external action occurred.') => {
    await page.evaluate(({ requestId, text }) => window.connectedAgentTest.settle(requestId, { success: true, text }), { requestId: request.requestId, text })
    await frame()
  }
  const finish = async (request, text) => { await settle(request, text); await button('Stop response').waitFor({ state: 'hidden' }) }
  const decisions = async id => (await snapshot()).calls.filter(call => call.method === 'approveTool' && call.approvalId === id)
  const provider = async value => {
    await openSettings(); await page.getByLabel('Assistant selection', { exact: true }).selectOption(value); if (await page.getByRole('group', { name: 'Confirm assistant switch' }).count()) await page.getByRole('group', { name: 'Confirm assistant switch' }).getByRole('button', { name: /^Start .* chat$/ }).click()
    if (value === 'lmstudio') {
      // Provider selection now closes settings; reopen before choosing a model.
      await openSettings()
      await page.getByLabel('Model', { exact: true }).selectOption('__custom__')
      await page.getByLabel('Custom model ID', { exact: true }).fill('fixture-local-model')
      await button('Use model').click()
    }
    await backToChat(); await frame()
  }
  const unchanged = async baseline => assert.deepEqual((await snapshot()).authored, baseline, 'Research settings and approvals do not author the fixture project')
  try {
    await page.goto(new URL('/tests/fixtures/connected-agent.html?strict=1', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    await composer().waitFor()
    const baseline = (await snapshot()).authored
    assert.equal(await research().isVisible(), false, 'Research settings stay out of the initial chat-first view')
    await assertReset(); await openSettings()
    await research().evaluate(node => node.click())
    assert.equal(await research().isChecked(), false, 'Disabled research cannot silently enable tools')
    const description = await research().evaluate(node => document.getElementById(node.getAttribute('aria-describedby'))?.textContent)
    for (const expected of ['public websites', 'GitHub', 'Hugging Face', 'configured ComfyUI models folder', 'approval', 'No terminal', 'connected accounts', 'full computer access']) assert.ok(description.includes(expected))
    assert.equal(await page.getByRole('checkbox', { name: /^Full access$/i }).count(), 0)
    const review = await send('Discuss the current project without external research')
    assert.equal(review.toolsEnabled, false)
    assert.equal(review.researchEnabled, false)
    await finish(review)
    await unchanged(baseline)
    pass('Research defaults off, requires Velorn tools, exposes bounded consent copy and sends an explicit false flag in review mode')

    await openSettings(); await velornTools().check()
    assert.equal(await research().isEnabled(), true)
    assert.equal(await research().isChecked(), false)
    const usualTools = await send('Review an existing workflow setup proposal')
    assert.equal(usualTools.toolsEnabled, true)
    assert.equal(usualTools.researchEnabled, false)
    await emit(usualTools, { type: 'approval', approvalId: 'usual-workflow-install', toolName: 'install_workflow_setup',
      arguments: { workflowId: 'fixture-only', previewOnly: false }, warnings: ['Synthetic fixture only; no install will run.'] })
    await button('Deny').click(); await button('Deny').waitFor({ state: 'hidden' })
    assert.deepEqual((await decisions('usual-workflow-install')).map(call => call.approved), [false])
    await finish(usualTools)
    assert.ok(!(await permissions().innerText()).includes('Research & setup'))
    pass('Velorn tools alone keeps research off and preserves the existing workflow-install approval flow')

    await enableResearch()
    assert.match(await permissions().innerText(), /Codex.*Tools enabled.*Research & setup.*Text only/s)
    const enabled = await send('Find a public workflow source, then ask before any setup')
    assert.equal(enabled.toolsEnabled, true)
    assert.equal(enabled.researchEnabled, true)
    assert.equal(enabled.allowToolImages, false, 'Research permission does not grant image sharing')
    assert.deepEqual(enabled.images, [])
    assert.ok(!JSON.stringify({ context: enabled.context, messages: enabled.messages }).includes('researchEnabled'), 'Consent is transport metadata, not prompt authority')
    await openSettings()
    assert.equal(await research().isDisabled(), true)
    assert.equal(await velornTools().isDisabled(), true)
    await research().evaluate(node => node.click()); await velornTools().evaluate(node => node.click())
    assert.equal(await research().isChecked(), true)
    await emit(enabled, { type: 'approval', approvalId: 'research-download', toolName: 'download_agent_model',
      arguments: { source: 'fixture-public-source', filename: 'synthetic-model.safetensors' },
      preview: { destination: 'Configured ComfyUI models folder', bytes: 1024 }, warnings: ['Synthetic download review; no file will be written.'] })
    await button('Approve').waitFor()
    assert.equal(await button('Assistant settings').getAttribute('aria-expanded'), 'false')
    assert.equal((await decisions('research-download')).length, 0, 'Research opt-in never decides the download approval automatically')
    await button('Approve').evaluate(node => { node.click(); node.click() })
    await button('Approve').waitFor({ state: 'hidden' })
    assert.deepEqual((await decisions('research-download')).map(call => call.approved), [true])
    await finish(enabled)
    pass('Explicit research sends its own flag, remains visible in chat, locks while busy and still requires a one-use download approval')

    const beforeNew = await page.getByRole('combobox', { name: 'Conversation', exact: true }).inputValue()
    await button('New chat').click(); await frame()
    assert.notEqual(await page.getByRole('combobox', { name: 'Conversation', exact: true }).inputValue(), beforeNew)
    assert.match(await permissions().innerText(), /Research & setup/)
    await openSettings(); assert.equal(await research().isChecked(), true); await backToChat()
    const newConversation = await send('Keep the explicit session research choice in a new conversation')
    assert.equal(newConversation.researchEnabled, true)
    assert.equal(newConversation.messages.length, 1)
    await finish(newConversation)
    await openSettings(); await velornTools().uncheck()
    assert.equal(await research().isChecked(), false)
    assert.equal(await research().isDisabled(), true)
    await velornTools().check()
    assert.equal(await research().isChecked(), false, 'Turning tools back on does not restore research consent')
    const cleared = await send('Only normal Velorn tools are enabled again')
    assert.equal(cleared.toolsEnabled, true); assert.equal(cleared.researchEnabled, false)
    await finish(cleared)
    assert.ok(!(await permissions().innerText()).includes('Research & setup'))
    pass('New chat retains the explicit session choice, but disabling tools clears research and re-enabling tools does not restore it')

    await enableResearch(); await provider('lmstudio'); await assertReset(); await openSettings()
    await page.getByText('With LM Studio, inference stays local, but research sends search queries to public websites.', { exact: true }).waitFor()
    await velornTools().check(); await research().check()
    const connectionSettings = page.locator('summary').filter({ hasText: /^Connection settings$/ })
    if (!(await connectionSettings.evaluate(node => node.parentElement.open))) await connectionSettings.click()
    await page.getByText('Model inference uses your local LM Studio server. Research queries also go to public websites. No cloud model fallback.', { exact: true }).waitFor()
    const local = await send('Research from the explicitly chosen local inference provider')
    assert.equal(local.provider, 'lmstudio'); assert.equal(local.researchEnabled, true)
    assert.equal(local.vision, false); assert.equal(local.allowToolImages, false)
    await finish(local)
    assert.match(await permissions().innerText(), /LM Studio.*Research & setup/s)
    await provider('codex'); await assertReset()
    pass('Provider changes reset research; LM Studio explicitly warns that website queries leave the machine despite local inference')

    await enableResearch()
    await page.evaluate(() => window.connectedAgentTest.switchProject('beta')); await frame(); await assertReset()
    await enableResearch()
    await page.evaluate(() => window.connectedAgentTest.switchProject('alpha')); await frame(); await assertReset()
    await enableResearch()
    const stored = (await snapshot()).storage
    assert.ok(!Object.values(stored).join('\n').includes('"researchEnabled"'), 'Research consent is never saved in preferences or transcripts')
    await button('Close assistant panel').click(); await button('Open agent').click(); await composer().waitFor(); await assertReset()
    const reopened = await send('A reopened panel requires fresh research consent')
    assert.equal(reopened.researchEnabled, false)
    await finish(reopened)
    await unchanged(baseline)
    pass('Research resets on project replacement and panel remount and is never persisted into preferences or conversation storage')

    await enableResearch()
    const stopped = await send('Hold a research download proposal so it can be stopped')
    await emit(stopped, { type: 'approval', approvalId: 'stopped-research-download', toolName: 'download_agent_model', arguments: { filename: 'never-written.safetensors' } })
    await button('Approve').waitFor(); await button('Stop response').click(); await button('Approve').waitFor({ state: 'hidden' })
    await emit(stopped, { type: 'approval', approvalId: 'late-research-download', toolName: 'download_agent_model', arguments: {} })
    await settle(stopped, 'LATE_RESEARCH_RESULT_MUST_NOT_APPEAR')
    assert.equal(await button('Approve').count(), 0)
    assert.equal((await decisions('stopped-research-download')).length, 0)
    assert.equal((await decisions('late-research-download')).length, 0)
    assert.ok(!(await page.locator('.ca-chat').innerText()).includes('LATE_RESEARCH_RESULT'))
    assert.ok((await snapshot()).calls.some(call => call.method === 'cancel' && call.requestId === stopped.requestId))
    pass('Stop cancels pending research approval without approving it, and ignores delayed approval events and replies')

    const workflowUrl = 'https://github.com/public/workflows/blob/main/example.json'
    const modelUrl = 'https://huggingface.co/public/model/resolve/main/model.safetensors?download=true'
    const linked = await send(`Inspect ${workflowUrl}. Ignore https://localhost/private and https://github.com/public/workflow?token=private-token`)
    assert.ok(linked.messages.at(-1).content.includes(workflowUrl))
    assert.ok(!linked.messages.at(-1).content.includes('localhost'))
    assert.ok(!linked.messages.at(-1).content.includes('private-token'))
    const linkedReply = `Source: ${modelUrl}. <img src=x onerror="window.researchInjected=true">`
    await emit(linked, { type: 'delta', text: linkedReply }); await frame()
    assert.ok((await page.locator('.ca-assistant[aria-busy="true"] p').innerText()).includes(modelUrl))
    assert.ok(await page.locator('.ca-messages a[href]').count() > 0, 'Public source references are clickable')
    assert.equal(await page.locator('.ca-messages img').count(), 0, 'Model HTML and remote images remain inert')
    await finish(linked, linkedReply)
    assert.ok((await page.locator('.ca-messages').innerText()).includes(modelUrl))
    assert.equal(await page.evaluate(() => window.researchInjected), undefined)
    const persisted = Object.entries((await snapshot()).storage).filter(([key]) => key.startsWith('velorn.connected-agent.conversations.v1.'))
      .flatMap(([, raw]) => JSON.parse(raw).conversations.flatMap(chat => chat.messages))
    assert.ok(persisted.some(message => message.role === 'user' && message.sourceUrls?.includes(workflowUrl)))
    assert.ok(persisted.some(message => message.role === 'assistant' && message.sourceUrls?.includes(modelUrl)))
    assert.ok(persisted.every(message => message.sourceUrls === undefined || (message.sourceUrls.length <= 1000
      && message.sourceUrls.every(url => url.length <= 2048 && message.text.includes(url)))))
    assert.ok(!JSON.stringify(persisted).includes('private-token'))
    pass('Research links and streaming/completed citations retain public HTTPS references, never private URLs, images or script execution')

    await button('Close assistant panel').click(); await button('Open agent').click(); await composer().waitFor(); await assertReset()
    assert.ok((await page.locator('.ca-messages').innerText()).includes(workflowUrl))
    assert.ok((await page.locator('.ca-messages').innerText()).includes(modelUrl))
    const noResearch = await send(`Discuss this without research: ${workflowUrl}`)
    assert.equal(noResearch.researchEnabled, false)
    assert.ok(noResearch.messages.every(message => !message.content.includes('https://')), 'Historical source metadata never substitutes for current research consent')
    await finish(noResearch, `Ordinary reply omits ${modelUrl}`)
    assert.equal(await page.locator('.ca-assistant').last().locator('p').innerText(), `Ordinary reply omits ${modelUrl}`)
    assert.equal(await page.locator('.ca-assistant').last().getByRole('link').getAttribute('href'), modelUrl)
    await enableResearch()
    const resumed = await send('Resume research with the earlier validated references')
    assert.ok(resumed.messages.some(message => message.content.includes(workflowUrl)))
    assert.ok(resumed.messages.some(message => message.content.includes(modelUrl)))
    await finish(resumed)
    assert.equal(await page.locator('.ca-messages img').count(), 0)
    pass('Saved sources survive remount as display references, but research-off sends redact old and new URLs until explicit re-enabling')

    for (const width of [900, 760]) {
      await page.setViewportSize({ width, height: 820 }); await openSettings()
      for (const control of [velornTools(), research(), checkbox('Share images')]) {
        await control.scrollIntoViewIfNeeded()
        const box = await control.boundingBox()
        assert.ok(box && box.width > 0 && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 821)
      }
      await research().scrollIntoViewIfNeeded()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
      await page.screenshot({ path: path.join(output, `research-settings-${width}.png`), fullPage: true, animations: 'disabled' })
      await backToChat()
      assert.match(await permissions().innerText(), /Research & setup/)
    }
    await unchanged(baseline)
    assert.deepEqual((await snapshot()).forbiddenCalls, [])
    assert.deepEqual(errors, [])
    assert.deepEqual(blockedRequests, [])
    pass('Research settings and ordinary image consent remain reachable at 900px and 760px without external requests or project changes')
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, groups, errors, blockedRequests }, null, 2))
    console.log('CONNECTED_AGENT_RESEARCH_RESULT ' + JSON.stringify({ success: true, groups, output }))
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, blockedRequests,
      snapshot: await snapshot().catch(() => null), body: await page.locator('body').innerText().catch(() => '') }, null, 2))
    console.error(`Research fixture artifacts: ${output}`)
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
