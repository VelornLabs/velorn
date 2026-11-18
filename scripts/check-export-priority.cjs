// Real renderer components/stores, strict in-memory desktop bridge. No user
// project, generation, cloud calls, or output files are touched.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium, _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = process.env.VELORN_TEST_URL || 'http://127.0.0.1:5198'
const native = process.env.VELORN_TEST_ELECTRON === '1'
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-export-priority-'))
async function main() {
  const browser = native ? await _electron.launch({ executablePath: require('electron'),
    args: [path.resolve(__dirname, '../tests/fixtures/inspector-electron.cjs')], env: { ...process.env, VELORN_TEST_URL: base } })
    : await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const errors = []
  try {
    const page = native ? await browser.firstWindow() : await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    if (native) await browser.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => { errors.push(error.message); console.error(error) })
    await page.routeWebSocket(url => url.hostname === new URL(base).hostname && url.port === new URL(base).port, socket => socket.close())
    await page.goto(`${base}/tests/fixtures/export-workspace.html?priority=1`)
    await page.waitForFunction(() => window.exportWorkspaceTest?.snapshot().settings)
    const api = expression => page.evaluate(expression)
    const snapshot = () => api(() => window.exportWorkspaceTest.snapshot())
    const reset = async () => {
      await api(() => window.exportWorkspaceTest.reset())
      await page.getByTestId('export-start').waitFor()
      await page.waitForFunction(() => !window.exportWorkspaceTest.snapshot().exportBusy)
    }
    const start = async () => {
      await page.getByTestId('export-start').click()
      await page.waitForFunction(() => window.exportWorkspaceTest.snapshot().activeJobId)
      await page.getByTestId('export-priority-overlay').waitFor()
    }
    const unlocked = () => page.waitForFunction(() => !window.exportWorkspaceTest.snapshot().exportBusy
      && !document.querySelector('[data-testid="export-priority-overlay"]'))
    const cancel = () => page.getByTestId('export-priority-cancel').click()
    let count = 0
    const pass = text => console.log(`PASS ${++count}: ${text}`)

    await api(() => { window.exportWorkspaceTest.timeline.setState({ isPlaying: true }); window.exportWorkspaceTest.assets.setState({ isPlaying: true }) })
    await start()
    const before = await snapshot()
    assert.equal(before.isPlaying, false)
    assert.equal(await api(() => window.exportWorkspaceTest.assets.getState().isPlaying), false)
    assert.equal(await page.getByRole('button', { name: 'Other workspace', exact: true }).isDisabled(), true)
    assert.equal(await page.getByTestId('export-fixture-panel').evaluate(node => node.inert), true)
    // Space/Enter on the focused Cancel button intentionally activate it.
    // Exercise editor shortcuts with focus outside that allowed control.
    await api(() => { document.body.tabIndex = -1; document.body.focus() })
    for (const key of ['Space', 'j', 'k', 'l', 'Delete', 'Control+z', 'Escape']) await page.keyboard.press(key)
    const after = await snapshot()
    assert.equal(after.timeline, before.timeline)
    assert.equal(after.history, before.history)
    assert.equal(after.playheadPosition, before.playheadPosition)
    assert.equal(after.isPlaying, false)
    await page.getByRole('button', { name: 'Minimize fixture' }).click()
    assert.equal(await api(() => window.exportWorkspaceTest.controls.minimized), true)
    await api(() => window.exportWorkspaceTest.progress(42))
    await page.getByRole('progressbar', { name: 'Export progress', exact: true }).waitFor()
    assert.match(await page.getByTestId('export-priority-overlay').innerText(), /42%/)
    await page.screenshot({ path: path.join(output, `priority${native ? '-electron' : ''}.png`) })
    await api(() => window.exportWorkspaceTest.complete())
    await unlocked()
    assert.equal(await page.getByTestId('export-fixture-panel').evaluate(node => node.inert), false)
    pass('start pauses both transports, blocks shortcuts/navigation, preserves document, keeps minimize available; completion unlocks')

    await reset(); await start(); await cancel(); await unlocked()
    assert.equal((await snapshot()).calls.filter(item => item.method === 'cancelExport').length, 1)
    pass('pointer Cancel remains usable and unlocks after acknowledgement')
    await reset(); await start()
    await page.getByTestId('export-priority-cancel').focus()
    await page.keyboard.press('Enter'); await unlocked()
    pass('keyboard Cancel works despite global shortcut guard')

    await reset(); await start()
    await api(() => { window.exportWorkspaceTest.controls.cancelError = 'Synthetic cancel failure' })
    await cancel()
    await page.getByRole('alert').filter({ hasText: 'Synthetic cancel failure' }).waitFor()
    assert.equal((await snapshot()).exportBusy, true)
    await api(() => { window.exportWorkspaceTest.controls.cancelError = null })
    await page.getByRole('button', { name: 'Retry cancel', exact: true }).click(); await unlocked()
    pass('failed cancellation keeps editor locked and offers a working retry')

    for (const error of ['Synthetic export failure', 'Export process crashed (crashed, code 9).', 'Export worker closed before reporting completion.']) {
      await reset(); await start(); await page.evaluate(error => window.exportWorkspaceTest.fail(error), error); await unlocked()
    }
    await reset()
    await api(() => { window.exportWorkspaceTest.controls.workerStartupError = 'Synthetic startup failure' })
    await page.getByTestId('export-start').click()
    await page.getByText('Synthetic startup failure', { exact: true }).first().waitFor(); await unlocked()
    pass('worker errors/crash/close/startup failure unlock without a stuck busy flag')

    await reset()
    await api(() => window.exportWorkspaceTest.holdDialog())
    await page.getByTestId('export-start').click()
    await page.getByTestId('export-priority-overlay').waitFor()
    await cancel()
    await api(() => window.exportWorkspaceTest.controls.releaseDialog())
    await unlocked()
    assert.equal((await snapshot()).jobs.length, 0)
    pass('Cancel during destination preparation prevents later worker startup')

    await reset()
    await page.getByTestId('export-add-queue').click(); await page.getByTestId('export-add-queue').click()
    await page.getByTestId('export-queue-start').click()
    await page.waitForFunction(() => window.exportWorkspaceTest.snapshot().jobs.length === 1)
    await api(() => window.exportWorkspaceTest.complete())
    await page.waitForFunction(() => window.exportWorkspaceTest.snapshot().jobs.length === 2)
    assert.equal((await snapshot()).exportBusy, true)
    await api(() => window.exportWorkspaceTest.complete()); await unlocked()
    pass('sequential UI queue remains locked across job boundaries and unlocks when finished')

    await reset()
    await page.getByTestId('export-add-queue').click(); await page.getByTestId('export-add-queue').click()
    await page.getByTestId('export-queue-start').click()
    await page.waitForFunction(() => window.exportWorkspaceTest.snapshot().jobs.length === 1)
    await cancel(); await unlocked()
    assert.equal((await snapshot()).jobs.length, 1)
    pass('Cancel stops the current UI job and pauses remaining queued targets')

    await reset()
    await page.getByTestId('export-add-queue').click(); await page.getByTestId('export-add-queue').click()
    await page.getByTestId('export-queue-start').click()
    await page.waitForFunction(() => window.exportWorkspaceTest.snapshot().jobs.length === 1)
    await page.getByTestId('export-priority-overlay').getByRole('button', { name: 'Pause after current', exact: true }).click()
    assert.equal((await snapshot()).exportBusy, true)
    await api(() => window.exportWorkspaceTest.complete()); await unlocked()
    assert.equal((await snapshot()).jobs.length, 1)
    await page.getByTestId('export-queue-resume').click()
    await page.waitForFunction(() => window.exportWorkspaceTest.snapshot().jobs.length === 2)
    await api(() => window.exportWorkspaceTest.complete()); await unlocked()
    pass('Pause after current finishes its job without cancellation and Resume runs the remaining queue')

    await reset()
    await api(() => window.exportWorkspaceTest.nativeStart())
    await page.getByTestId('export-priority-overlay').waitFor()
    assert.equal((await snapshot()).exportBusy, true)
    await cancel(); await unlocked()
    pass('external MCP/native export locks before first progress and can be cancelled from UI')
    assert.deepEqual(errors, [])
    assert.deepEqual((await snapshot()).forbiddenCalls, [])
    console.log(`Verified ${count} groups. Screenshot: ${output}`)
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
