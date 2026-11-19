// Real chat panel, RAM-only native installer receipts. No provider, network,
// installer, account, project IO or persistent browser storage is allowed.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const target = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5219')
if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password
  || target.pathname !== '/' || target.search || target.hash) throw new Error('Installer progress fixture requires loopback HTTP')
const base = target.origin
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-agent-setup-downloads-'))

async function main() {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
  const checks = [], errors = [], blocked = []
  let page
  try {
    page = await browser.newPage({ viewport: { width: 1100, height: 960 } })
    page.setDefaultTimeout(7000)
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin === base && !/^\/(v1|api|prompt|queue|upload)(\/|$)/.test(url.pathname)) return route.continue()
      blocked.push(url.href); return route.abort()
    })
    await page.routeWebSocket(() => true, socket => socket.close())
    const button = name => page.getByRole('button', { name, exact: true })
    const chats = () => page.getByRole('combobox', { name: 'Conversation', exact: true })
    const composer = () => page.getByRole('textbox', { name: 'Message your agent', exact: true })
    const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
    const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const card = id => page.locator(`[data-job-id="${id}"]`)
    const setup = (method, ...args) => page.evaluate(({ method, args }) => window.connectedAgentTest.setupDownloads[method](...args), { method, args })
    const waitText = (locator, pattern) => page.waitForFunction(({ selector, source, flags }) => {
      const node = document.querySelector(selector)
      return node && new RegExp(source, flags).test(node.textContent)
    }, { selector: locator, source: pattern.source, flags: pattern.flags })
    const waitCardText = (id, pattern) => waitText(`[data-job-id="${id}"]`, pattern)
    const begin = async text => {
      const count = (await snapshot()).requests.length
      await composer().fill(text); await button('Send message').click()
      await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, count)
      return (await snapshot()).requests.at(-1)
    }
    const finish = async (request, text = 'The installer download has started. Installation is a separate step.') => {
      await page.evaluate(({ id, text }) => window.connectedAgentTest.settle(id, { success: true, text }), { id: request.requestId, text })
      await button('Stop response').waitFor({ state: 'hidden' }); await frame()
    }
    const seed = (request, id, extra = {}) => setup('seed', [{
      jobId: id, integration: 'comfyui', turnId: request.requestId,
      projectPath: '/fixture-only/PRIVATE_PATH/alpha', chatId: request.conversationId,
      state: 'downloading', bytesReceived: 1024 * 1024, totalBytes: 4 * 1024 * 1024,
      canOpen: false, ...extra,
    }])
    const selectChat = async id => { await chats().selectOption(id); await frame() }

    await page.goto(`${base}/tests/fixtures/connected-agent.html?strict=1&setupDownloads=1`)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().calls.some(call => call.method === 'toolSetup.agentDownloads'))
    const baseline = (await snapshot()).authored
    assert.equal(await page.locator('[data-job-id]').count(), 0)
    assert.equal((await snapshot()).requests.length, 0)
    assert.equal((await snapshot()).setupDownloads.listenerCount, 1)
    const request = await begin('Please prepare the approved ComfyUI installer.')
    await seed(request, 'comfy-active')
    await card('comfy-active').waitFor()
    assert.equal(await button('Stop response').isVisible(), true)
    assert.equal(await card('comfy-active').count(), 1)
    assert.equal(await card('comfy-active').getByRole('button', { name: 'Open installer', exact: true }).count(), 0)
    assert.match(await card('comfy-active').innerText(), /25%/)
    await page.setViewportSize({ width: 390, height: 844 })
    const narrowStyle = await page.addStyleTag({ content: '[data-testid="shared-workspace"]{display:none!important}.connected-agent-panel{width:100%!important;max-width:none!important}' })
    await card('comfy-active').scrollIntoViewIfNeeded(); await frame()
    assert.equal(await card('comfy-active').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true)
    await page.screenshot({ path: path.join(output, 'live-installer-progress-narrow.png') })
    await narrowStyle.evaluate(node => node.remove())
    await page.setViewportSize({ width: 1100, height: 960 })
    checks.push('static event discovers new native job during active reply without a prompt')

    await finish(request)
    await card('comfy-active').waitFor()
    assert.equal((await snapshot()).requests.length, 1)
    assert.equal(await card('comfy-active').count(), 1)
    assert.equal(await card('comfy-active').evaluate(node => Boolean(node.closest('.ca-assistant'))), true)
    await setup('update', 'comfy-active', { bytesReceived: 4 * 1024 * 1024 }, false)
    await waitCardText('comfy-active', /Verifying installer/)
    assert.equal(await card('comfy-active').getByRole('button', { name: 'Open installer', exact: true }).count(), 0)
    checks.push('download remains visible after reply; 100% bytes is verification, not ready')

    const second = await begin('A later unrelated conversation message.')
    await finish(second, 'Second reply remains below the original installer receipt.')
    assert.equal(await card('comfy-active').count(), 1)
    const parentText = await card('comfy-active').evaluate(node => node.closest('.ca-assistant')?.textContent)
    assert.match(parentText, /Installation is a separate step/)
    assert.doesNotMatch(parentText, /Second reply/)
    await setup('update', 'comfy-active', { state: 'completed', canOpen: true })
    await card('comfy-active').getByRole('button', { name: 'Open installer', exact: true }).waitFor()
    assert.match(await card('comfy-active').innerText(), /downloaded|download complete/i)
    assert.match(await card('comfy-active').innerText(), /install/i)
    assert.equal((await snapshot()).calls.filter(call => call.method === 'toolSetup.open').length, 0)
    checks.push('one card stays anchored to original reply; completion never opens installer')

    await setup('setActionResponse', 'open', { success: false, code: 'SETUP_CANCELLED', error: 'Installer opening was declined.' })
    await card('comfy-active').getByRole('button', { name: 'Open installer', exact: true }).click()
    await waitCardText('comfy-active', /declined/)
    assert.equal((await snapshot()).setupDownloads.jobs.find(job => job.jobId === 'comfy-active').opened, undefined)
    await setup('setActionResponse', 'open', null)
    await card('comfy-active').getByRole('button', { name: 'Open installer', exact: true }).click()
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().setupDownloads.jobs.find(job => job.jobId === 'comfy-active')?.opened === true)
    checks.push('only explicit Open requests native approval; decline does not claim opened')

    await seed(request, 'lm-unknown', { integration: 'lmstudio', totalBytes: null, bytesReceived: 2 * 1024 * 1024 })
    await card('lm-unknown').waitFor()
    assert.doesNotMatch(await card('lm-unknown').innerText(), /NaN|Infinity|0%|100%/)
    await page.evaluate(() => window.connectedAgentTest.setExportBusy(true))
    await frame()
    assert.equal(await card('comfy-active').getByRole('button', { name: 'Open installer', exact: true }).isDisabled(), true)
    const cancel = card('lm-unknown').getByRole('button', { name: 'Cancel download', exact: true })
    assert.equal(await cancel.isEnabled(), true)
    await cancel.click(); await waitCardText('lm-unknown', /cancelled/i)
    await page.evaluate(() => window.connectedAgentTest.setExportBusy(false))
    checks.push('unknown total stays truthful; cancellation remains available during export')

    await setup('setListError', 'Synthetic receipt service temporarily unavailable.')
    await setup('emit')
    await page.getByText('Synthetic receipt service temporarily unavailable.', { exact: false }).waitFor()
    assert.equal(await card('comfy-active').count(), 1, 'Failed refresh keeps the last known receipt')
    await setup('setListError', '')
    await button('Refresh download progress').click()
    await page.getByText('Synthetic receipt service temporarily unavailable.', { exact: false }).waitFor({ state: 'hidden' })
    checks.push('native status failure preserves last known state and supports explicit retry')

    await seed(request, 'other-chat', { chatId: 'not-this-chat' })
    await seed(request, 'other-project', { projectPath: '/fixture-only/PRIVATE_PATH/beta' })
    await frame()
    assert.equal(await card('other-chat').count(), 0); assert.equal(await card('other-project').count(), 0)
    await button('New chat').click(); await frame()
    const otherChat = await chats().inputValue()
    assert.notEqual(otherChat, request.conversationId)
    assert.equal(await page.locator('[data-job-id]').count(), 0)
    const stopped = await begin('Start another installer, then stop only the agent reply.')
    await seed(stopped, 'stopped-turn')
    await card('stopped-turn').waitFor()
    await button('Stop response').click(); await frame()
    await card('stopped-turn').waitFor()
    assert.equal(await card('stopped-turn').count(), 1)
    assert.equal(await card('stopped-turn').evaluate(node => Boolean(node.closest('.ca-message'))), true)
    await page.evaluate(id => window.connectedAgentTest.settle(id, { success: true, text: 'STALE_STOPPED_REPLY' }), stopped.requestId)
    await frame()
    assert.equal(await page.getByText('STALE_STOPPED_REPLY', { exact: false }).count(), 0)
    await setup('update', 'stopped-turn', { state: 'cancelled', canOpen: false })
    checks.push('stopped agent turn retains one receipt without accepting a stale reply')
    await selectChat(request.conversationId); await card('comfy-active').waitFor()
    await setup('setHoldLists', true); await setup('emit')
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().setupDownloads.pendingLists.length > 0)
    const staleList = (await snapshot()).setupDownloads.pendingLists[0].listId
    await setup('setHoldLists', false)
    await selectChat(otherChat)
    await setup('releaseList', staleList); await frame()
    assert.equal(await card('comfy-active').count(), 0)
    assert.equal(await card('stopped-turn').count(), 1)
    await selectChat(request.conversationId); await card('comfy-active').waitFor()
    checks.push('scope isolation and late native list response cannot leak into another chat')

    await setup('setHoldAction', 'open', true)
    await card('comfy-active').getByRole('button', { name: 'Open installer', exact: true }).click()
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().setupDownloads.pendingActions.length > 0)
    const staleAction = (await snapshot()).setupDownloads.pendingActions[0].actionId
    await selectChat(otherChat)
    await setup('releaseAction', staleAction, { success: false, error: 'STALE_ACTION_MUST_NOT_LEAK' })
    await setup('setHoldAction', 'open', false); await frame()
    assert.equal(await page.getByText('STALE_ACTION_MUST_NOT_LEAK', { exact: false }).count(), 0)
    await selectChat(request.conversationId)
    await card('comfy-active').waitFor()
    assert.equal(await page.getByText('STALE_ACTION_MUST_NOT_LEAK', { exact: false }).count(), 0)
    checks.push('late approval/action response is ignored after chat switch')

    await page.evaluate(() => window.connectedAgentTest.switchProject('beta'))
    await frame()
    assert.equal(await page.locator('[data-job-id]').count(), 0)
    await page.evaluate(() => window.connectedAgentTest.switchProject('alpha'))
    await card('comfy-active').waitFor()
    await setup('setHoldLists', true); await setup('emit')
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().setupDownloads.pendingLists.length > 0)
    const beforeUnmount = (await snapshot()).setupDownloads.pendingLists[0].listId
    await button('Close assistant panel').click()
    assert.equal((await snapshot()).setupDownloads.listenerCount, 0)
    await setup('releaseList', beforeUnmount); await setup('setHoldLists', false)
    await button('Open agent').click(); await card('comfy-active').waitFor()
    assert.equal(await card('comfy-active').count(), 1)
    assert.equal((await snapshot()).setupDownloads.listenerCount, 1)
    assert.equal((await snapshot()).setupDownloads.listenerPeak, 1)
    checks.push('project isolation, unmount cleanup, and native cached receipt restoration')

    const long = await begin('Keep reading earlier replies during another background download.')
    await finish(long, Array.from({ length: 45 }, (_, i) => `Paragraph ${i + 1}: a synthetic response for scroll preservation.`).join('\n\n'))
    await seed(request, 'scroll-job', { bytesReceived: 0 })
    await card('scroll-job').waitFor({ state: 'attached' })
    await page.locator('.ca-messages').evaluate(node => { node.scrollTop = 0 })
    await frame()
    const beforeScroll = await page.locator('.ca-messages').evaluate(node => node.scrollTop)
    await setup('update', 'scroll-job', { bytesReceived: 2 * 1024 * 1024 })
    await waitCardText('scroll-job', /50%/)
    assert.equal(await page.locator('.ca-messages').evaluate(node => node.scrollTop), beforeScroll)
    checks.push('progress updates do not auto-scroll away from an earlier reply')

    await setup('update', 'scroll-job', { state: 'failed', error: 'Synthetic connection ended before verification.', canOpen: false })
    await waitCardText('scroll-job', /Synthetic connection ended/)
    assert.equal(await card('scroll-job').getByRole('button', { name: 'Open installer', exact: true }).count(), 0)
    await page.setViewportSize({ width: 390, height: 844 })
    // The desktop renderer is given one full-width panel in this narrow fixture;
    // its card/controls/CSS are unchanged, not a separate mobile implementation.
    await page.addStyleTag({ content: '[data-testid="shared-workspace"]{display:none!important}.connected-agent-panel{width:100%!important;max-width:none!important}' })
    await card('comfy-active').scrollIntoViewIfNeeded(); await frame()
    const overflow = await page.locator('[data-job-id]').evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.dataset.jobId))
    assert.deepEqual(overflow, [])
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await page.screenshot({ path: path.join(output, 'live-installer-downloads-narrow.png') })
    checks.push('failed download never opens; 390px cards have no horizontal overflow')

    const final = await snapshot()
    assert.deepEqual(final.authored, baseline)
    assert.equal(final.requests.length, 4, 'Progress and actions do not invoke inference')
    assert.equal(final.calls.filter(call => call.method === 'toolSetup.open').length, 3)
    assert.equal(final.calls.filter(call => call.method === 'toolSetup.cancel').length, 1)
    assert.deepEqual(final.forbiddenCalls, [])
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    checks.push('project/editor/undo state unchanged; no downloads, auto-open or extra inference')
    console.log(JSON.stringify({ passed: true, groups: checks.length, checks,
      screenshot: path.join(output, 'live-installer-downloads-narrow.png'),
      progressScreenshot: path.join(output, 'live-installer-progress-narrow.png') }, null, 2))
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
      console.error(JSON.stringify({ output, passedGroups: checks, pageErrors: errors, blocked }))
    }
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
