// Real Luna/optional/private hosted controls; synthetic RAM-only native bridge.
// No real keys, provider requests, settings/profile IO, generation or local Comfy.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5242')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw Error('Loopback fixture only')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-setup-helper-cloud-'))
const FAKE = 'synthetic-PRIVATE_HOSTED_KEY_CANARY-not-a-real-key'
const response = overrides => ({ success: true, text: 'Use the private hosted account controls. Hosted generation is not enabled yet.', actions: [], checks: [], remainingTurns: 6, ...overrides })
const cloudCheck = overrides => ({ integration: 'comfycloud', state: 'verified', configured: true, evidence: 'stored-account-check', summary: 'Stored account status from the previous explicit account check. No new cloud request was sent.', ...overrides })
const topicName = 'Comfy Cloud Hosted account setup'

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  let context, page, errors, blocked, baseline, groups = 0
  const button = name => page.getByRole('button', { name, exact: true })
  const input = () => page.getByRole('textbox', { name: 'Your Comfy Cloud setup question', exact: true })
  const completion = () => page.getByRole('heading', { name: 'Comfy Cloud account check verified', exact: true })
  const snapshot = () => page.evaluate(() => window.setupHelperTest.snapshot())
  const count = async method => (await snapshot()).calls.filter(call => call.method === method).length
  const invoke = (method, value) => page.evaluate(({ method, value }) => window.setupHelperTest[method](value), { method, value })
  const setReply = value => invoke('setResponse', value)
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const idle = () => page.waitForFunction(() => ![...document.querySelectorAll('[role="status"]')].some(node => /Starting a new setup|Checking whether/.test(node.textContent)))
  const pass = label => console.log(`PASS ${++groups}: ${label}`)
  const preserved = async () => {
    const state = await snapshot()
    assert.deepEqual(state.settings, baseline.settings)
    assert.deepEqual(state.storage, baseline.storage)
    assert.deepEqual(state.forbidden, []); assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    assert.equal(await count('inspect'), 0); assert.equal(await count('plan'), 0)
    assert.equal(state.calls.some(call => call.method.startsWith('launcher.')), false)
    for (const send of state.calls.filter(call => call.method === 'send')) {
      assert.deepEqual(Object.keys(send).sort(), ['integration', 'message', 'method'])
      assert.doesNotMatch(JSON.stringify(send), /PRIVATE_\w+_CANARY|private-project|synthetic-PRIVATE/)
    }
    assert.doesNotMatch(JSON.stringify(state.storage), /PRIVATE_HOSTED_KEY_CANARY/)
    assert.equal(await page.locator('body').evaluate(node => node.textContent.includes('PRIVATE_HOSTED_KEY_CANARY')), false)
  }
  const fresh = async (query = '', width = 1100) => {
    await context?.close()
    context = await browser.newContext({ viewport: { width, height: 980 }, locale: 'en-US', serviceWorkers: 'block' })
    page = await context.newPage(); page.setDefaultTimeout(10000); errors = []; blocked = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin === base.origin && !/^\/(prompt|queue|history|upload|view|ws|v1|api)(\/|$)/.test(url.pathname)) return route.continue()
      blocked.push(url.href); return route.abort()
    })
    await page.routeWebSocket(() => true, socket => socket.close())
    await page.goto(new URL(`/tests/fixtures/setup-helper.html?view=helper${query}`, base).href)
    await page.waitForFunction(() => window.setupHelperTest?.ready)
    if (query.includes('dialog=1')) await button('Open optional tools').click()
    await idle(); baseline = await snapshot()
  }
  const openCloud = async (query = '', width = 1100) => {
    await fresh(query, width); await button(topicName).click(); await idle()
  }
  const send = async (text = 'Check my stored Comfy Cloud account status without sending a new cloud request.') => {
    await input().fill(text); await button('Send to Luna').click()
    await button('Send to Luna').waitFor()
    await page.getByRole('log').getByRole('heading', { name: 'Luna · setup guidance' }).last().waitFor()
  }
  const privateControls = async () => {
    await page.getByRole('heading', { name: 'Hosted Comfy Cloud', exact: true }).waitFor()
    await page.waitForFunction(() => !document.querySelector('input[type=password]')?.disabled)
    assert.equal(await page.getByRole('log').count(), 0, 'Transcript is inaccessible while private controls are shown')
    assert.equal(await page.getByRole('region', { name: 'LM Studio setup', exact: true }).count(), 0)
    assert.equal(await page.getByRole('region', { name: 'ComfyUI controls', exact: true }).count(), 0)
  }
  try {
    await fresh()
    for (const name of ['ComfyUI AI media generation', topicName, 'LM Studio A local editing assistant', 'Codex Your ChatGPT editing assistant']) {
      await button(name).waitFor()
      const box = await button(name).boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 1100)
    }
    assert.equal(await count('send'), 0); assert.equal(await count('hosted.status'), 0); assert.equal(await count('hosted.check'), 0)
    await page.screenshot({ path: path.join(output, 'four-topics-desktop.png'), fullPage: true })
    await preserved(); pass('Four clearly separate topics render passively without reading/checking the hosted account')

    for (const destination of ['Configure manually', 'Use guided setup']) {
      await openCloud('&unavailable=1')
      await button(destination).click(); await privateControls()
      assert.equal(await count('send'), 0); assert.equal(await count('hosted.check'), 0)
      assert.equal(await count('hosted.status'), 1)
      await button('Back to Luna setup').click()
      assert.equal(await button(topicName).getAttribute('aria-pressed'), 'true')
      await preserved()
    }
    pass('Unavailable Luna manual and guided buttons both reach passive hosted controls, never local Comfy or LM Studio')

    await openCloud('&unavailable=1')
    await page.getByText('Comfy Cloud controls', { exact: true }).click()
    await button('Open Comfy Cloud controls').click(); await privateControls()
    await button('Back to Luna setup').click()
    await page.getByText('Official Comfy Cloud guides', { exact: true }).click()
    assert.equal(await button('Open official installation guide').count(), 0)
    await button('Open official connection guide').click()
    await page.getByRole('heading', { name: 'Native setup action', exact: true }).waitFor()
    assert.deepEqual((await snapshot()).calls.filter(call => call.method === 'performAction'), [{ method: 'performAction', integration: 'comfycloud', action: 'connection_guide' }])
    assert.equal(await count('hosted.check'), 0); assert.equal(await count('send'), 0)
    await preserved(); pass('Persistent cloud controls and one fixed guide work without Luna, credential reads or paid follow-up')

    await openCloud()
    await setReply(response({ actions: [
      { integration: 'comfycloud', action: 'configure' }, { integration: 'comfycloud', action: 'connection_guide' },
      { integration: 'comfycloud', action: 'check' }, { integration: 'comfycloud', action: 'credentials' },
      { integration: 'comfycloud', action: 'install' }, { integration: 'comfycloud', action: 'installation_guide' },
      { integration: 'comfycloud', action: 'open_app' }, { integration: 'comfyui', action: 'configure' },
    ] }))
    await send('Show me the private hosted Comfy Cloud controls.')
    const log = page.getByRole('log')
    assert.deepEqual(await log.getByRole('button').allTextContents(), ['Open Comfy Cloud controls', 'Open official connection guide'])
    assert.equal(await count('performAction'), 0); assert.equal(await count('hosted.check'), 0)
    await preserved(); pass('Cloud replies expose only same-topic configure and connection guide actions, never install, local checks or generic key actions')

    await input().fill('Keep this cloud setup draft.')
    const before = await snapshot()
    await button('Open Comfy Cloud controls').click(); await privateControls()
    const hidden = page.locator('[inert]')
    assert.ok(await hidden.count() >= 1, 'Helper remains inert during handoff')
    const privateKey = page.getByLabel('Comfy Cloud API key', { exact: true })
    assert.equal(await privateKey.getAttribute('type'), 'password')
    await privateKey.fill(FAKE); await button('Check account access').click()
    await page.getByRole('status').filter({ hasText: 'Account access verified' }).waitFor()
    assert.equal(await privateKey.inputValue(), '')
    await button('Get a Comfy API key').click(); await button('Comfy Cloud guide').click()
    assert.deepEqual((await snapshot()).calls.filter(call => call.method === 'hosted.openGuide'), [
      { method: 'hosted.openGuide', guide: 'keys' }, { method: 'hosted.openGuide', guide: 'cloud' },
    ])
    assert.equal(await count('send'), before.calls.filter(call => call.method === 'send').length)
    assert.equal(await count('hosted.check'), 1)
    await button('Back to Luna setup').click(); await input().waitFor()
    assert.equal(await input().inputValue(), 'Keep this cloud setup draft.')
    await page.getByText('Show me the private hosted Comfy Cloud controls.', { exact: true }).waitFor()
    assert.equal(await completion().count(), 0)
    assert.equal(await count('reset'), before.calls.filter(call => call.method === 'reset').length)
    assert.equal(await count('send'), 1)
    await preserved(); pass('Private hosted check preserves hidden/inert Luna history and draft, clears its key and returns without an automatic message or completion claim')

    await invoke('useStoredHostedReply', true); await setReply(response({}))
    await send()
    await completion().waitFor()
    assert.equal(await count('hosted.check'), 1, 'Luna stored-status read makes no new account request')
    assert.equal(await count('hosted.readStoredStatus'), 1)
    const card = completion().locator('..')
    assert.match(await card.innerText(), /previous|earlier|stored|last explicit account check/i)
    assert.match(await card.innerText(), /no new|did not send|did not contact Comfy Cloud again/i)
    assert.match(await card.innerText(), /generation.*not enabled|not.*generation/i)
    await page.getByText(/Native account status · Comfy Cloud/).waitFor()
    assert.equal(await page.getByText(/Native setup check · Comfy Cloud/).count(), 0)
    await preserved(); pass('Explicit Luna message reads stored account evidence and labels completion as prior account verification, not a fresh network or generation test')

    await input().fill('Retain this draft when I forget the key.')
    const sendsBeforeClear = await count('send')
    await button('Configure manually').click(); await privateControls()
    assert.equal(await count('hosted.check'), 1)
    await button('Forget hosted key').click(); await button('Forget key').click()
    await page.getByRole('status').filter({ hasText: 'Not connected' }).waitFor()
    await button('Back to Luna setup').click()
    assert.equal(await input().inputValue(), 'Retain this draft when I forget the key.')
    assert.equal(await completion().count(), 0); assert.equal(await count('send'), sendsBeforeClear)
    await page.getByText('Earlier account status · Comfy Cloud · Read status again', { exact: true }).waitFor()
    await send('Read my stored account status after forgetting the key.')
    assert.equal(await completion().count(), 0)
    assert.equal(await count('hosted.check'), 1); assert.equal(await count('hosted.clear'), 1)
    await preserved(); pass('Forgetting through the same private controls expires old completion; return is passive and explicit status read reports missing')

    await openCloud(); await setReply(response({ checks: [cloudCheck()] })); await send(); await completion().waitFor()
    for (const checks of [[], [cloudCheck({ state: 'configured' })], [cloudCheck({ state: 'missing', configured: false })],
      [cloudCheck({ state: 'waitlisted' })], [cloudCheck({ state: 'auth-rejected' })], [cloudCheck({ state: 'subscription-or-rate-limited' })],
      [cloudCheck({ state: 'unavailable' })], [cloudCheck({ state: 'problem' })], [cloudCheck({ configured: false })],
      [cloudCheck({ configured: 'true' })], [cloudCheck({ evidence: undefined })], [cloudCheck({ evidence: 'fresh-cloud-request' })],
      [cloudCheck({ summary: undefined })], [cloudCheck({ summary: '' })], [cloudCheck({ summary: ' ' })], [cloudCheck({ summary: 'x'.repeat(1001) })],
      [cloudCheck({ integration: 'comfyui' })], [cloudCheck(), cloudCheck({ state: 'missing' })],
      [cloudCheck(), { integration: 'codex', state: 'ready', summary: 'Unrelated later evidence.' }]]) {
      await setReply(response({ text: 'The cloud is ready for generation!', checks })); await send('Require matching bounded stored-account evidence.')
      assert.equal(await completion().count(), 0); assert.equal(await button('Finish setup — keep current assistant').count(), 0)
      await preserved()
    }
    pass('Completion rejects prose-only, false/malformed configuration, wrong evidence/topic and newer negative/unrelated checks')

    await setReply(response({ checks: [cloudCheck({ summary: `${FAKE} <img src=x onerror=alert(1)>`, key: FAKE, account: { token: FAKE } })] }))
    await send('Read the safe account state only.'); await completion().waitFor()
    assert.equal(await page.getByRole('log').locator('img,a,script').count(), 0)
    await preserved(); pass('Cloud receipt renders fixed local summary copy instead of arbitrary native summary/account/key extras')

    await setReply(response({ checks: [cloudCheck()] })); await send(); await completion().waitFor()
    await invoke('hold', 'send'); await input().fill('Pending cloud recheck.'); await button('Send to Luna').click()
    await page.waitForFunction(() => window.setupHelperTest.snapshot().pending.includes('send'))
    assert.equal(await completion().count(), 0)
    await button('Stop').click(); await button('Send to Luna').waitFor(); await invoke('release', 'send'); await frame()
    assert.equal(await completion().count(), 0)
    await setReply({ success: false, error: 'Synthetic cloud status failed.' }); await input().fill('Try once after cancellation.'); await button('Send to Luna').click()
    await page.getByRole('alert').getByText('Synthetic cloud status failed.', { exact: true }).waitFor()
    assert.equal(await completion().count(), 0)
    await setReply(response({ checks: [cloudCheck()] })); await send(); await completion().waitFor()
    await page.getByText('Official Comfy Cloud guides', { exact: true }).click(); await button('Open official connection guide').click()
    await page.getByRole('heading', { name: 'Native setup action', exact: true }).waitFor()
    assert.equal(await completion().count(), 0)
    await send(); await completion().waitFor(); await button('Start a new setup conversation').click(); await idle()
    assert.equal(await completion().count(), 0)
    await preserved(); pass('Pending/cancelled/failed messages, guide actions and reset immediately invalidate cloud completion; late replies cannot revive it')

    for (const provider of ['', '&already-local=1']) {
      await openCloud(provider); await setReply(response({ checks: [cloudCheck()] })); await send(); await completion().waitFor()
      await button('Finish setup — keep current assistant').click(); await page.getByRole('region', { name: 'editor fixture', exact: true }).waitFor()
      assert.equal(await count('chooseAgentModel'), 0); assert.equal(await count('hosted.check'), 0); assert.equal(await count('send'), 1)
      await preserved()
    }
    pass('Cloud Finish returns to editor preserving current Codex or local assistant, model, chats, local connection and spending policy')

    await openCloud('&dialog=1', 390)
    for (const name of ['ComfyUI AI media generation', topicName, 'LM Studio A local editing assistant', 'Codex Your ChatGPT editing assistant']) {
      const box = await button(name).boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 390)
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.locator('.optional-setup-dialog-body').evaluate(node => { node.scrollTop = 0 })
    await page.screenshot({ path: path.join(output, 'four-topics-mobile.png'), fullPage: true })
    await button('Configure manually').click(); await privateControls()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    const keyBox = await page.getByLabel('Comfy Cloud API key', { exact: true }).boundingBox()
    const rememberBox = await page.getByRole('checkbox', { name: 'Remember on this device', exact: true }).boundingBox()
    assert.ok(keyBox.width > 230, 'Embedded hosted password keeps the full card width, not legacy 120px number-input styling')
    assert.ok(rememberBox.width <= 22, 'Embedded hosted checkbox is not stretched by the legacy input width')
    await page.locator('.optional-setup-dialog-body').evaluate(node => { node.scrollTop = 0 })
    await page.screenshot({ path: path.join(output, 'cloud-private-controls-mobile.png'), fullPage: true })
    await button('Back to Luna setup').click(); await setReply(response({ checks: [cloudCheck()] })); await send()
    await completion().scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, 'cloud-completion-mobile.png'), fullPage: true })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await button('Finish setup — keep current assistant').click(); await page.getByRole('dialog').waitFor({ state: 'detached' })
    assert.equal(await button('Open optional tools').evaluate(node => node === document.activeElement), true)
    await preserved(); pass('Four-topic selector, private hosted controls and honest completion fit 390px; modal Finish closes and restores focus')

    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: groups, output }, null, 2))
    console.log(JSON.stringify({ passed: groups, output }))
  } finally { await context?.close(); await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
