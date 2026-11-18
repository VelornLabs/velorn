'use strict'
const fs = require('node:fs'), assert = require('node:assert/strict')
const { _electron } = require('/test-tools/node_modules/playwright')
const executablePath = '/candidate/source/release/linux-unpacked/velorn'
const output = '/state/normal-desktop-startup'
fs.mkdirSync(output, { recursive: true })
const env = Object.fromEntries(['PATH', 'LANG', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'DBUS_SYSTEM_BUS_ADDRESS', 'LIBGL_ALWAYS_SOFTWARE', 'GSETTINGS_BACKEND', 'NO_AT_BRIDGE']
  .map(key => [key, process.env[key]]).filter(([, value]) => value !== undefined))
let app; const rounds = [], errors = []
env.XDG_CONFIG_HOME = '/state/desktop-config'
fs.mkdirSync(env.XDG_CONFIG_HOME, { recursive: true })
async function launch(round) {
  app = await _electron.launch({ executablePath, env, timeout: 45000,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--ozone-platform=wayland', '--disable-background-networking'] })
  app.on('window', page => page.on('pageerror', error => errors.push(error.message)))
  const state = await app.evaluate(({ app }) => ({ name: app.getName(), version: app.getVersion(),
    profile: app.getPath('userData'), packaged: app.isPackaged }))
  assert.equal(state.version, '0.3.38-native-preview.11'); assert.equal(state.packaged, true)
  assert.equal(state.profile, '/state/desktop-config/velorn')
  assert.equal(state.name.toLowerCase(), 'velorn')
  let page
  for (let i = 0; i < 150; i++) {
    page = app.windows().find(p => !p.isClosed() && /\/dist\/index\.html/.test(p.url()))
    if (page) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(page, 'Normal packaged editor replaced splash')
  await page.waitForFunction(() => !!window.electronAPI?.engineCandidateInfo)
  // The network namespace intentionally has no real internet interface. Native
  // IPC below is synthetic, so allow its status display without network access.
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }))
  assert.equal(await page.evaluate(() => window.electronAPI.engineCandidateInfo.mode), 'private-linux-preview')
  // Test-only IPC replacement inside the network/filesystem-isolated process.
  // No synthetic handler is included in the packaged application.
  await app.evaluate(({ ipcMain }, savedMedia) => {
    // Synthetic reply-media bridge only; real native persistence/authorization
    // is exercised separately with disposable WAV/MP4 files.
    globalThis.replyMediaTest = { calls: [], items: savedMedia }
    ipcMain.removeHandler('agent-review-media:list-playable')
    ipcMain.handle('agent-review-media:list-playable', async (_event, payload) => ({ success: true,
      candidates: [{ id: 'fixture-video', name: 'Synthetic saved video', type: 'video' }],
      items: globalThis.replyMediaTest.items.filter(item => item.chatId === payload.chatId && payload.turnIds.includes(item.turnId)) }))
    ipcMain.removeHandler('agent-review-media:attach-playable')
    ipcMain.handle('agent-review-media:attach-playable', async (_event, payload) => {
      if (payload.assetIds.length !== 1 || payload.assetIds[0] !== 'fixture-video') throw Error('Unexpected test attachment')
      globalThis.replyMediaTest.calls.push(payload)
      globalThis.replyMediaTest.items.push({ id: 'fixture-' + payload.turnId, chatId: payload.chatId, turnId: payload.turnId,
        type: 'video', name: 'Synthetic saved video', unavailable: true })
      return { success: true }
    })
    globalThis.stellarTest = { sends: 0, pending: null, requestId: null, sender: null,
      allowance: { remainingPercent: 97.3, pending: false, poolLimited: false } }
    const syntheticStatus = { enabled: true, paired: false, urls: [],
      guided: { registered: true, enabled: false, phase: 'ready', automaticAccountAccess: true,
        account: { displayName: 'Synthetic Owner', email: 'synthetic@example.test', emailVerified: true },
        computer: { id: 'synthetic-computer', name: 'Synthetic computer' }, devices: [] } }
    for (const name of ['preference', 'attach', 'publish', 'detach']) {
      ipcMain.removeHandler('mobile-companion:' + name)
      ipcMain.handle('mobile-companion:' + name, async () => ({ success: true, available: true,
        guidedAvailable: true, enabled: true, status: syntheticStatus, nativeApprovals: [] }))
    }
    ipcMain.removeHandler('connected-agent:vee-availability')
    ipcMain.handle('connected-agent:vee-availability', async () => ({ success: true, provider: 'luna',
      available: true, status: 'eligible', allowance: globalThis.stellarTest.allowance }))
    ipcMain.removeHandler('connected-agent:inspect')
    ipcMain.handle('connected-agent:inspect', async () => ({ success: true, provider: 'luna',
      available: true, eligible: true, status: 'eligible', models: [{ id: 'gpt-6-luna' }] }))
    ipcMain.removeHandler('connected-agent:send')
    ipcMain.handle('connected-agent:send', (event, payload) => {
      globalThis.stellarTest.sends++
      globalThis.stellarTest.allowance.pending = true
      globalThis.stellarTest.requestId = payload.requestId
      globalThis.stellarTest.sender = event.sender
      return new Promise(resolve => { globalThis.stellarTest.pending = resolve })
    })
    ipcMain.removeHandler('connected-agent:cancel')
    ipcMain.handle('connected-agent:cancel', async () => {
      globalThis.stellarTest.allowance.pending = false
      globalThis.stellarTest.pending?.({ success: false, code: 'CANCELLED', error: 'Synthetic cancelled response.' })
      return { success: true }
    })
  }, fs.existsSync(output + '/reply-media.json') ? JSON.parse(fs.readFileSync(output + '/reply-media.json')) : [])
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1)
      if (options.title === 'Select Projects Folder') return { canceled: false, filePaths: ['/workspace'] }
      if (options.title === 'Select Project Folder') return { canceled: false, filePaths: ['/workspace/Normal Desktop Preview Test'] }
      return { canceled: true, filePaths: [] }
    }
  })
  if (round === 1) {
    await page.getByRole('button', { name: 'Choose Projects Folder', exact: true }).click()
    await page.getByRole('button', { name: 'New Project', exact: true }).first().click()
    await page.getByPlaceholder('Enter project name...').fill('Normal Desktop Preview Test')
    await page.getByRole('button', { name: 'Create Project', exact: true }).click()
  } else {
    await page.getByRole('button', { name: 'Open Project', exact: true }).first().click()
  }
  const assistant = page.getByRole('button', { name: 'Assistant', exact: true })
  await assistant.waitFor({ timeout: 30000 })
  if (await assistant.getAttribute('aria-pressed') !== 'true') await assistant.click()
  if (round === 1) {
    await page.getByRole('button', { name: 'Choose Velo', exact: true }).click()
    await page.getByText('Velo ready', { exact: true }).waitFor()
    await page.getByText('97.3% remaining', { exact: true }).waitFor()
    const bar = page.getByRole('progressbar', { name: 'Velo allowance remaining' })
    assert.equal(await bar.getAttribute('aria-valuenow'), '97.3')
    assert.doesNotMatch(await page.locator('.velo-allowance').innerText(), /\$|USD|dollar/i)
    await page.getByRole('button', { name: 'Assistant settings', exact: true }).click()
    await page.getByRole('button', { name: 'Work in Velorn', exact: true }).click()
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click()
    await page.getByRole('textbox', { name: 'Message your agent' }).fill('Synthetic UI animation only.')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const indicator = page.getByTestId('agent-activity')
    await indicator.waitFor()
    await page.getByText('Usage pending · this bar shows confirmed usage.', { exact: true }).waitFor()
    assert.equal(await bar.getAttribute('aria-valuenow'), '97.3', 'Reservation does not consume the percentage')
    assert.equal(await indicator.locator('.ca-stellar-wave > i').count(), 5)
    const style = await indicator.locator('.ca-stellar-wave > i').first().evaluate(node => {
      const css = getComputedStyle(node)
      return { animation: css.animationName, duration: parseFloat(css.animationDuration), shadow: css.boxShadow }
    })
    assert.equal(style.animation, 'ca-stellar-wave')
    assert.ok(Math.abs(style.duration - 1.9 / 1.5) < .0001)
    assert.match(style.shadow, /8\.16px/)
    assert.equal(await indicator.count(), 1)
    assert.equal(await indicator.evaluate(node => node.nextElementSibling === document.querySelector('textarea[aria-label="Message your agent"]')), true)
    assert.equal(await indicator.locator('.ca-stellar-wave').evaluate(node => getComputedStyle(node).width), '51px')
    assert.equal(await page.locator('.connected-agent-panel > .ca-activity').count(), 0)
    assert.equal(await page.getByText('Velo ready', { exact: true }).count(), 0)
    await page.screenshot({ path: output + '/packaged-stellar-wave.png' })
    await page.getByRole('button', { name: 'Assistant settings', exact: true }).click()
    assert.equal(await indicator.count(), 1)
    assert.equal(await indicator.evaluate(node => Boolean(node.closest('.ca-settings-running'))), true)
    assert.equal(await page.getByRole('button', { name: 'Stop response', exact: true }).isVisible(), true)
    await page.screenshot({ path: output + '/packaged-stellar-settings.png' })
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click()
    await app.evaluate(() => globalThis.stellarTest.sender.send('connected-agent:event', {
      requestId: globalThis.stellarTest.requestId, type: 'status', waitingFor: 'velo-service', text: 'Synthetic service wait.'
    }))
    await page.waitForFunction(() => document.querySelector('[data-testid=agent-activity]')?.dataset.state === 'service-wait')
    await app.evaluate(() => {
      const state = globalThis.stellarTest
      for (let i = 0; i < 35; i++) state.sender.send('connected-agent:event', {
        requestId: state.requestId, type: 'tool', callId: `synthetic-${i}`, toolName: 'inspect_comfyui_node',
        status: 'completed', summary: 'Synthetic inspection completed.', durationMs: 100
      })
      state.sender.send('connected-agent:event', { requestId: state.requestId, type: 'timing', phase: 'setup', durationMs: 200 })
    })
    await page.waitForFunction(() => document.querySelectorAll('[data-activity-id]').length === 35)
    const details = page.locator('.ca-live-activity')
    assert.equal(await details.evaluate(node => node.open), false)
    assert.equal(await details.locator('ol').isVisible(), false)
    assert.equal(await page.locator('.ca-run-details').isVisible(), false)
    assert.ok((await details.boundingBox()).height < 50)
    await details.locator(':scope > summary').click()
    await app.evaluate(() => { globalThis.stellarTest.allowance = { remainingPercent: 97.2, pending: false, poolLimited: false }; globalThis.stellarTest.pending({ success: true, text: 'Synthetic result is ready. Which reference image should I use next?' }) })
    await indicator.waitFor({ state: 'detached' })
    await page.getByText('97.2% remaining', { exact: true }).waitFor()
    assert.equal(await details.evaluate(node => node.open), true)
    assert.equal(await page.locator('.ca-assistant').last().evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('.ca-live-activity')) & Node.DOCUMENT_POSITION_FOLLOWING)), true)
    await details.locator(':scope > summary').click()
    await page.getByText('Synthetic result is ready. Which reference image should I use next?', { exact: true }).waitFor()
    const reply = page.locator('.ca-assistant').filter({ hasText: 'Synthetic result is ready. Which reference image should I use next?' })
    const options = reply.getByRole('button', { name: 'Reply options', exact: true })
    assert.equal(await page.getByText('Attach project audio or video', { exact: true }).count(), 0)
    assert.equal(await page.getByRole('group', { name: 'Show project media here' }).count(), 0)
    await options.click()
    const menu = reply.getByRole('menu', { name: 'Reply options' })
    const menuBounds = await menu.boundingBox(), messageBounds = await page.locator('.ca-messages').boundingBox()
    assert.ok(menuBounds.x >= messageBounds.x && menuBounds.x + menuBounds.width <= messageBounds.x + messageBounds.width, 'Menu fits narrow desktop panel')
    await page.screenshot({ path: output + '/packaged-reply-menu.png' })
    await menu.getByRole('menuitem', { name: 'Show project media here' }).click()
    await reply.getByRole('checkbox', { name: 'Synthetic saved video · video' }).check()
    await reply.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(await app.evaluate(() => globalThis.replyMediaTest.calls.length), 0)
    await options.click(); await reply.getByRole('menuitem', { name: 'Show project media here' }).click()
    await reply.getByRole('checkbox', { name: 'Synthetic saved video · video' }).check()
    await reply.getByRole('button', { name: 'Add to reply', exact: true }).click()
    await reply.getByText('File unavailable. The saved attachment is retained.').waitFor()
    assert.equal(await page.getByRole('group', { name: 'Show project media here' }).count(), 0)
    assert.equal(await app.evaluate(() => globalThis.replyMediaTest.calls.length), 1)
    assert.equal(await app.evaluate(() => globalThis.stellarTest.sends), 1, 'Manual media attach does not send a model request')
    await page.screenshot({ path: output + '/packaged-compact-result.png' })
    await page.getByRole('textbox', { name: 'Message your agent' }).fill('Synthetic second turn; verify Stop and reset only.')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await indicator.waitFor()
    await app.evaluate(() => globalThis.stellarTest.sender.send('connected-agent:event', {
      requestId: globalThis.stellarTest.requestId, type: 'tool', callId: 'synthetic-next', toolName: 'get_project', status: 'running'
    }))
    await details.waitFor()
    assert.equal(await details.evaluate(node => node.open), false)
    await page.getByRole('button', { name: 'Stop response', exact: true }).click()
    await indicator.waitFor({ state: 'detached' })
    await page.getByText('Velo ready', { exact: true }).waitFor()
    assert.equal(await app.evaluate(() => globalThis.stellarTest.sends), 2)
    await page.getByRole('textbox', { name: 'Message your agent' }).fill('Unsent preview draft; do not send.')
    await page.getByRole('button', { name: 'Assistant settings', exact: true }).click()
    await page.getByText('Generation and performance', { exact: true }).click()
    await page.getByText('Remembered local workflows', { exact: true }).click()
    await page.getByText(/This works with Local only; you do not need to enable cloud spending/).waitFor()
    await page.getByText('Spending details', { exact: true }).click()
    await page.getByText(/Unrecognized does not mean paid, but custom nodes/).waitFor()
    assert.equal(await page.getByRole('combobox', { name: 'Generation spending', exact: true }).inputValue(), 'local-only')
    await page.screenshot({ path: output + '/packaged-workflow-review-settings.png' })
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click()
  } else {
    assert.equal(await page.locator('.ca-stellar-wave').count(), 0)
    assert.equal(await app.evaluate(() => globalThis.stellarTest.sends), 0, 'Reopening never sends a request')
    await page.getByText('File unavailable. The saved attachment is retained.').waitFor()
    assert.equal(await page.getByRole('group', { name: 'Show project media here' }).count(), 0, 'Reopen keeps media, not the picker')
    assert.equal(await app.evaluate(() => globalThis.replyMediaTest.calls.length), 0, 'Reopen does not repeat attachment')
  }
  await page.screenshot({ path: output + '/startup-' + round + '.png' })
  assert.equal(fs.existsSync(state.profile + '/phone-account.json'), false, 'No fabricated or personal account')
  assert.equal(fs.existsSync(state.profile + '/velo-native'), false, 'Opening editor does not start engine or send inference')
  rounds.push(state)
  fs.writeFileSync(output + '/reply-media.json', JSON.stringify(await app.evaluate(() => globalThis.replyMediaTest.items)))
  await app.close(); app = null
}
(async () => { await launch(1); await launch(2); assert.deepEqual(errors, []);
  fs.writeFileSync(output + '/result.json', JSON.stringify({ passed: true, rounds, errors, paidRequests: 0 }, null, 2))
  console.log(JSON.stringify({ passed: true, packagedStartup: true, projectReopen: true, realAccountAccess: false, inference: false }))
})().catch(error => { console.error(error.stack); process.exitCode = 1 }).finally(async () => { await app?.close() })
