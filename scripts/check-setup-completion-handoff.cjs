// Real setup/helper/agent components, synthetic RAM-only native responses.
// No provider, model loading, credentials, project IO or persistent profile.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5238')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw Error('Loopback fixture only')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-setup-completion-'))
const settingsKey = 'velorn.connected-agent.settings.v1'
async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  let context, page, errors, blocked, groups = 0
  const button = name => page.getByRole('button', { name, exact: true })
  const composer = () => page.getByRole('textbox', { name: 'Message your agent', exact: true })
  const chats = () => page.getByRole('combobox', { name: 'Conversation', exact: true })
  const selected = () => page.getByLabel('Selected model', { exact: true })
  const picker = () => page.locator('.ca-chat-model-picker')
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const invoke = (method, args = []) => page.evaluate(({ method, args }) => window.connectedAgentTest[method](...args), { method, args })
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const handoffFocus = async () => {
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Assistant selection'
      && document.querySelector('.ca-chat-model-picker')?.scrollTop === 0)
    assert.equal(await picker().evaluate(node => node.scrollTop), 0, 'Handoff guidance starts in view without moving focus away from Agent')
  }
  const pass = label => { console.log(`PASS ${++groups}: ${label}`) }
  const fresh = async (dock = false, settings = null) => {
    await context?.close()
    context = await browser.newContext({ viewport: { width: 1280, height: 950 }, serviceWorkers: 'block' })
    page = await context.newPage(); page.setDefaultTimeout(10000); errors = []; blocked = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin === base.origin && !/^\/(v1|api|prompt|queue|history|upload|ws)(\/|$)/.test(url.pathname)) return route.continue()
      blocked.push(url.href); return route.abort()
    })
    await page.routeWebSocket(() => true, socket => socket.close())
    if (settings) await page.addInitScript(({ settingsKey, settings }) => {
      window.__connectedAgentFixtureStorage = { [settingsKey]: JSON.stringify(settings), 'velorn.agent-entry-intent.v1': '{"acknowledged":true}' }
    }, { settingsKey, settings })
    await page.goto(new URL(`/tests/fixtures/connected-agent.html?strict=1&setupCompletion=1&legacyChats=1${dock ? '&dock=1' : ''}`, base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    if (!dock) await composer().waitFor()
    await frame()
  }
  const noEffects = async (authored, setupSends) => {
    const state = await snapshot()
    assert.deepEqual(state.authored, authored)
    assert.deepEqual(state.forbiddenCalls, [])
    assert.equal(state.requests.length, 0, 'No editing-agent prompt')
    assert.equal(state.calls.filter(call => call.method === 'setupHelper.send').length, setupSends)
    assert.deepEqual(state.calls.filter(call => /^(?:setSetting|codexLogin|openExternalUrl|toolSetup\.|lmStudioSetup\.|comfyLauncher\.|setupHelper\.performAction)/.test(call.method)
      || call.method === 'codexExecutable' && !['get', 'status'].includes(call.action)), [])
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
  }
  const openReadyHelper = async (integration = 'lmstudio') => {
    await button('Assistant settings').click()
    if (!await page.locator('.ca-setup-help').evaluate(node => node.open)) await page.locator('.ca-setup-help > summary').click()
    await button('Setup helper').click()
    const dialog = page.getByRole('dialog', { name: 'Optional tools', exact: true })
    await dialog.waitFor()
    await dialog.getByRole('heading', { name: 'What would you like help setting up?', exact: true }).waitFor()
    assert.equal(await dialog.getByRole('button', { name: 'Send to Luna', exact: true }).count(), 0)
    await dialog.locator('summary').filter({ hasText: /^Advanced options$/ }).click()
    await dialog.getByRole('button', { name: 'Open experimental setup chat', exact: true }).click()
    const name = integration === 'comfycloud' ? 'Comfy Cloud' : integration === 'codex' ? 'Codex' : 'LM Studio'
    const topic = integration === 'comfycloud' ? 'Comfy Cloud Hosted account setup' : integration === 'codex' ? 'Codex Your ChatGPT editing assistant' : 'LM Studio A local editing assistant'
    await dialog.getByRole('button', { name: topic, exact: true }).click()
    const input = dialog.getByRole('textbox', { name: `Your ${name} setup question`, exact: true })
    await input.fill(`Check my existing ${name} connection without making changes.`)
    await dialog.getByRole('button', { name: 'Send to Luna', exact: true }).click()
    await dialog.getByRole('region', { name: `${name}${integration === 'comfycloud' ? ' account' : ''} setup complete`, exact: true }).waitFor()
    if (integration === 'lmstudio') await dialog.getByText('NVIDIA Nemotron Nano 4B', { exact: true }).waitFor()
    return dialog
  }
  const original = async () => ({ authored: (await snapshot()).authored, settings: (await snapshot()).storage[settingsKey],
    chat: await chats().inputValue(), messages: await page.locator('.ca-message').allTextContents(),
    count: await chats().locator('option').count(), model: await selected().innerText(), draft: await composer().inputValue() })
  const unchanged = async before => {
    assert.equal((await snapshot()).storage[settingsKey], before.settings)
    assert.equal(await chats().inputValue(), before.chat)
    assert.equal(await chats().locator('option').count(), before.count)
    assert.deepEqual(await page.locator('.ca-message').allTextContents(), before.messages)
    assert.equal(await selected().innerText(), before.model)
    assert.equal(await composer().inputValue(), before.draft)
  }
  try {
    // Existing Assistant settings auto-select the first local model when no model
    // is saved. Use an actual selected local model here to isolate setup Finish
    // from that pre-existing initialization; chooser tests below cover empty
    // selections under the explicit setup model-picker handoff guard.
    for (const settings of [null, { provider: 'lmstudio', lmstudioModel: 'fixture-existing-choice' }]) {
      await fresh(false, settings)
      await composer().fill('Keep my current assistant, conversation and unsent draft after Codex setup.')
      const before = await original()
      const dialog = await openReadyHelper('codex')
      const completion = dialog.getByRole('region', { name: 'Codex setup complete', exact: true })
      await completion.getByRole('heading', { name: 'Codex setup verified', exact: true }).waitFor()
      await page.screenshot({ path: path.join(output, `codex-completion-${settings ? 'local-selected' : 'codex'}.png`), fullPage: true })
      await completion.getByRole('button', { name: 'Finish setup — keep current assistant', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      await composer().waitFor(); await frame()
      assert.equal(await button('Back to chat').count(), 0, 'Finish returns directly to the current chat')
      await unchanged(before)
      assert.equal(await picker().count(), 0, 'Codex Finish does not open provider/model selection')
      assert.equal((await snapshot()).calls.filter(call => call.method === 'setupHelper.send')[0].payload.integration, 'codex')
      await noEffects(before.authored, 1)
      pass(`Codex Finish preserves ${settings ? 'LM Studio with an existing model choice' : 'Codex'}, chat history and draft without login, settings, prompts or model picker`)
    }

    for (const settings of [null, { provider: 'lmstudio', lmstudioModel: 'fixture-existing-choice' }]) {
      await fresh(false, settings)
      await composer().fill('Keep my current assistant and draft after hosted account setup.')
      const before = await original()
      const dialog = await openReadyHelper('comfycloud')
      await dialog.getByText(/Luna only read that result/).waitFor()
      await dialog.getByText(/Hosted generation is not enabled in Velorn yet/).waitFor()
      await page.screenshot({ path: path.join(output, `cloud-completion-${settings ? 'local-selected' : 'codex'}.png`), fullPage: true })
      await dialog.getByRole('button', { name: 'Finish setup — keep current assistant', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      await composer().waitFor(); await frame()
      await unchanged(before)
      assert.equal(await picker().count(), 0)
      assert.equal((await snapshot()).calls.filter(call => call.method === 'setupHelper.send')[0].payload.integration, 'comfycloud')
      await noEffects(before.authored, 1)
      pass(`Hosted account Finish preserves ${settings ? 'selected local model' : 'Codex'}, chats and draft with no provider switch or extra prompt`)
    }

    await fresh(); await composer().fill('Keep my Codex draft and current chat.')
    const finishBefore = await original()
    await openReadyHelper()
    await button('Finish setup — keep current assistant').click()
    await page.getByRole('dialog', { name: 'Optional tools', exact: true }).waitFor({ state: 'detached' })
    await composer().waitFor(); await frame()
    assert.equal(await button('Back to chat').count(), 0, 'Finish returns directly to the current chat')
    await unchanged(finishBefore)
    assert.equal(await picker().count(), 0)
    await noEffects(finishBefore.authored, 1)
    pass('Finish closes setup while preserving Codex, model, conversation, messages and draft with no extra requests')

    await openReadyHelper()
    await button('Choose an LM Studio model').click()
    await page.getByRole('dialog', { name: 'Optional tools', exact: true }).waitFor({ state: 'detached' })
    await picker().waitFor(); await frame()
    await unchanged(finishBefore)
    assert.equal(await page.getByLabel('Assistant selection', { exact: true }).inputValue(), 'codex')
    await page.getByText(/Choose LM Studio under Assistant, then choose a model/).waitFor()
    await handoffFocus()
    await noEffects(finishBefore.authored, 2)
    pass('Choose hands off to the existing model picker without selecting provider, model or a new chat')

    await page.getByLabel('Assistant selection', { exact: true }).selectOption('lmstudio')
    await page.getByRole('button', { name: 'Start LM Studio chat', exact: true }).click()
    await page.getByLabel('Assistant selection', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('Assistant selection', { exact: true }).inputValue(), 'lmstudio')
    await page.getByLabel('Model', { exact: true }).locator('option[value="fixture-nemotron-4b"]').waitFor({ state: 'attached' })
    assert.notEqual(await chats().inputValue(), finishBefore.chat, 'Only explicit provider switch starts its normal new conversation')
    assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), '', 'No model auto-selected')
    await page.getByLabel('Model', { exact: true }).selectOption('fixture-nemotron-4b')
    await picker().waitFor({ state: 'detached' })
    assert.match(await selected().innerText(), /fixture-nemotron-4b/)
    await chats().selectOption(`codex:${finishBefore.chat}`); await frame()
    assert.equal(await composer().inputValue(), finishBefore.draft)
    assert.deepEqual(await page.locator('.ca-message').allTextContents(), finishBefore.messages)
    assert.equal(await picker().count(), 0, 'Consumed setup handoff does not replay after provider remount')
    await noEffects(finishBefore.authored, 2)
    pass('Explicit Agent/model choices work normally; returning to Codex restores its draft/history without re-opening the picker')

    await fresh(true)
    const hiddenBefore = await snapshot()
    await invoke('requestModelPicker', [{ reveal: false }]); await frame()
    assert.equal(await picker().isVisible(), false, 'Hidden request must not expose controls or check a provider')
    assert.equal((await snapshot()).calls.filter(call => call.method === 'inspect').length, 0)
    await invoke('revealAgent'); await picker().waitFor(); await frame()
    assert.equal(await page.getByLabel('Assistant selection', { exact: true }).inputValue(), 'codex')
    assert.equal((await snapshot()).storage[settingsKey], hiddenBefore.storage[settingsKey])
    await noEffects(hiddenBefore.authored, 0)
    pass('External request waits while hidden and opens the unchanged Codex picker once the dock is visible')

    await button(/^(?:Change assistant or model|Connect Codex)$/).click(); await picker().waitFor({ state: 'detached' })
    await button('Assistant').click(); await button('Assistant').click(); await composer().waitFor(); await frame()
    assert.equal(await picker().count(), 0, 'Consumed request must not replay on dock visibility')
    await invoke('switchProject', ['beta']); await frame(); await composer().waitFor()
    assert.equal(await picker().count(), 0, 'Consumed request must not replay on project remount')
    await invoke('requestModelPicker'); await picker().waitFor()
    assert.equal(await page.getByLabel('Assistant selection', { exact: true }).inputValue(), 'codex')
    await handoffFocus()
    await noEffects((await snapshot()).authored, 0)
    pass('Consumed request is not replayed on hide/show or project remount; a fresh request opens the picker')
    await page.screenshot({ path: path.join(output, 'completion-picker-handoff.png'), fullPage: true })

    await button(/^(?:Change assistant or model|Connect Codex)$/).click(); await picker().waitFor({ state: 'detached' })
    await button('Assistant').click(); await invoke('requestModelPicker', [{ reveal: false }]); await frame()
    await invoke('switchProject', ['alpha']); await frame()
    await invoke('revealAgent'); await composer().waitFor(); await frame()
    assert.equal(await picker().count(), 0, 'Pending hidden request expires on project change')
    await noEffects((await snapshot()).authored, 0)
    pass('A pending hidden request is scoped to its original project and is discarded on navigation')

    await button('Assistant').click(); await invoke('requestModelPicker', [{ reveal: false }]); await frame()
    await invoke('setProjectLoading', [true]); await frame()
    await invoke('setProjectLoading', [false]); await invoke('revealAgent'); await composer().waitFor(); await frame()
    assert.equal(await picker().count(), 0, 'Pending hidden request expires during project loading')
    await noEffects((await snapshot()).authored, 0)
    pass('A pending hidden request is not replayed after project-loading remount')

    for (const lmstudioModel of ['', 'fixture-existing-choice']) {
      await fresh(false, { provider: 'lmstudio', lmstudioModel })
      await composer().fill('Keep this local draft too.')
      const before = await original()
      await invoke('requestModelPicker'); await picker().waitFor()
      await page.getByLabel('Model', { exact: true }).locator('option[value="fixture-nemotron-4b"]').waitFor({ state: 'attached' })
      await page.waitForFunction(() => !document.querySelector('select[aria-label="Model"]')?.disabled)
      await unchanged(before)
      assert.equal(await page.getByLabel('Assistant selection', { exact: true }).inputValue(), 'lmstudio')
      assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), lmstudioModel)
      await noEffects(before.authored, 0)
    }
    pass('Direct setup handoff into LM Studio preserves both an empty model choice and an existing saved choice')

    await fresh(false, { provider: 'lmstudio', lmstudioModel: '' })
    await composer().fill('Preserve local draft across delayed metadata.')
    const delayedBefore = await original()
    await invoke('setHoldInspect', [true]); await button('Assistant settings').click()
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().pendingInspects.length === 1)
    await invoke('requestModelPicker'); await picker().waitFor()
    await invoke('setHoldInspect', [false]); await invoke('releaseInspect')
    await page.getByLabel('Model', { exact: true }).locator('option[value="fixture-nemotron-4b"]').waitFor({ state: 'attached' })
    await page.waitForFunction(() => !document.querySelector('select[aria-label="Model"]')?.disabled)
    await unchanged(delayedBefore)
    assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), '')
    await noEffects(delayedBefore.authored, 0)
    pass('An inspection started before the setup handoff cannot auto-select a model when it completes later')
    console.log(JSON.stringify({ passed: groups, providerCalls: 0, screenshots: output }))
  } catch (error) {
    await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    console.error({ groups, errors, blocked, output }); throw error
  } finally { await context?.close(); await browser.close() }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
