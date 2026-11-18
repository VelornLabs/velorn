// Direct Electron launch preserves the renderer sandbox. Playwright connects
// over a loopback-only CDP endpoint; the host owns a fresh temporary profile.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net')
const { spawn } = require('node:child_process')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5198')
if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:') throw new Error('Fixture requires a loopback Vite server')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-viewer-presentation-results-'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function unusedPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function main() {
  const port = await unusedPort()
  const child = spawn(require('electron'), ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
    path.resolve(__dirname, '../tests/fixtures/viewer-presentation-electron.cjs')],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = '', browser, page
  child.stdout.on('data', data => { logs = (logs + data).slice(-30000) })
  child.stderr.on('data', data => { logs = (logs + data).slice(-30000) })
  const errors = [], groups = []
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  try {
    const endpoint = `http://127.0.0.1:${port}`
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode != null) throw new Error(`Fixture exited early: ${logs}`)
      try { const response = await fetch(endpoint + '/json/version'); if (response.ok) break } catch {}
      if (attempt === 149) throw new Error(`Fixture debugger did not start: ${logs}`)
      await sleep(100)
    }
    browser = await chromium.connectOverCDP(endpoint)
    const context = browser.contexts()[0]
    page = context.pages()[0] || await context.waitForEvent('page')
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push(error.message))
    await page.routeWebSocket(url => url.hostname === base.hostname && url.port === base.port, socket => socket.close())
    await page.goto(new URL('/tests/fixtures/viewer-presentation.html', base).href)
    await page.waitForFunction(() => window.viewerPresentationTest?.setMounted && document.querySelector('canvas[data-preview-popout-source="canvas"]'))
    assert.equal(await page.evaluate(() => window.viewerPresentationNative.sandboxed), true)
    const command = action => page.evaluate(action => window.viewerPresentationNative.command({ action }), action)
    const snapshot = () => page.evaluate(() => window.viewerPresentationTest.snapshot())
    const enter = () => page.getByTitle('Fullscreen', { exact: true }).click()
    const exited = async () => {
      await page.waitForFunction(() => !document.fullscreenElement && !document.querySelector('.fullscreen-panel'))
      await page.waitForFunction(async () => {
        const native = await window.viewerPresentationNative.command({ action: 'snapshot' })
        return !native.state.active && !native.fullscreen && !native.simpleFullscreen && !native.persistent
      })
    }
    const active = async () => {
      await page.waitForFunction(() => window.viewerPresentationTest.snapshot().fullscreenOwnsPanel && document.querySelector('.fullscreen-panel'))
      await page.waitForFunction(async () => (await window.viewerPresentationNative.command({ action: 'snapshot' })).state.active)
    }
    await command('show')
    await page.waitForFunction(() => window.viewerPresentationTest.snapshot().canvasPixel?.some((value, index) => index < 3 && value > 20))
    // Real Timeline remains mounted with a selected, undoable clip, making
    // Delete/Undo/I isolation checks meaningful rather than empty no-ops.
    await page.evaluate(() => window.viewerPresentationTest.seedEditingProbe())
    const viewer = page.getByTestId('viewer-host')
    await viewer.getByTitle('Zoom Out', { exact: true }).click()
    await viewer.getByTitle('Zoom Out', { exact: true }).click()
    await viewer.getByRole('button', { name: '50%', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.viewerPresentationTest.markNodes()), true)
    const baseline = await snapshot(), nativeBaseline = await command('snapshot')
    assert.ok(baseline.historyCount > 0, 'Hidden editor has no undoable document change')
    await enter(); await active()
    await viewer.getByRole('button', { name: 'Fit', exact: true }).waitFor()
    const presented = await snapshot(), nativePresented = await command('snapshot')
    assert.equal(presented.samePanel, true); assert.equal(presented.sameCanvas, true)
    assert.equal(presented.editorOutsideFullscreen, true); assert.equal(presented.authored, baseline.authored)
    assert.ok(Math.abs(presented.viewerBounds.width - presented.viewport.width) < 3)
    assert.ok(Math.abs(presented.viewerBounds.height - presented.viewport.height) < 3)
    if (nativePresented.platform === 'darwin') {
      assert.equal(nativePresented.simpleFullscreen, true); assert.equal(nativePresented.fullscreen, false, 'Viewer entered a macOS fullscreen Space')
    } else assert.equal(nativePresented.fullscreen, true)
    await page.screenshot({ path: path.join(output, 'viewer-fullscreen.png') })
    pass('Viewer-only DOM fullscreen keeps the original panel/canvas and uses the platform presentation controller')

    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Space')
    await page.waitForFunction(() => window.viewerPresentationTest.snapshot().playing)
    await page.waitForFunction(start => window.viewerPresentationTest.snapshot().time > start + 0.15, presented.time)
    await page.keyboard.press('Space')
    await page.waitForFunction(() => !window.viewerPresentationTest.snapshot().playing)
    assert.equal((await snapshot()).sameCanvas, true)

    await page.evaluate(() => window.viewerPresentationTest.setTime(2))
    await page.keyboard.press('ArrowRight')
    assert.ok(Math.abs((await snapshot()).time - (2 + 1 / 24)) < 1e-8, 'Viewer ArrowRight did not advance exactly one frame')
    await page.keyboard.press('ArrowLeft')
    assert.ok(Math.abs((await snapshot()).time - 2) < 1e-8, 'Viewer ArrowLeft did not return one frame')
    for (const [key, rate] of [['l', 1], ['l', 2], ['j', -1], ['k', null], ['Shift+l', 0.5], ['Shift+l', 0.25], ['k', null]]) {
      await page.keyboard.press(key)
      const state = await snapshot()
      if (rate == null) assert.equal(state.playing, false, 'K did not pause the fullscreen viewer')
      else { assert.equal(state.playing, true, `${key} did not play`); assert.equal(state.rate, rate, `${key} shuttle rate`) }
    }
    pass('Fullscreen Arrow keys step exact frames, JKL changes direction/speed, Shift+L uses slow rates and K pauses')

    const beforeEditingKeys = await snapshot()
    for (const key of ['Delete', 'Control+z', 'i']) {
      await page.keyboard.press(key)
      const after = await snapshot()
      assert.equal(after.authored, beforeEditingKeys.authored, `${key} reached hidden timeline authoring`)
      assert.equal(after.time, beforeEditingKeys.time, `${key} changed the fullscreen playhead`)
      assert.equal(after.playing, false)
    }
    pass('Delete, Ctrl+Z and I leave the real hidden timeline selection, undo history and range marks untouched')

    const volume = viewer.locator('input[type="range"]')
    const volumeBefore = Number(await volume.inputValue()), timeBeforeVolume = (await snapshot()).time
    await volume.focus()
    await page.keyboard.press('ArrowLeft')
    assert.ok(Math.abs(Number(await volume.inputValue()) - (volumeBefore - 0.1)) < 1e-8, 'Native volume slider lost its ArrowLeft default')
    assert.ok(Math.abs((await snapshot()).volume - (volumeBefore - 0.1)) < 1e-8, 'Native volume key did not update the real store')
    assert.equal((await snapshot()).time, timeBeforeVolume, 'Volume ArrowLeft also stepped the timeline')
    await page.keyboard.press('ArrowRight')
    assert.ok(Math.abs(Number(await volume.inputValue()) - volumeBefore) < 1e-8)
    await page.evaluate(() => document.activeElement?.blur())
    pass('Focused volume range keeps native arrow-key behavior without stepping or playing the timeline')

    await page.keyboard.press('Escape'); await exited()
    await viewer.getByRole('button', { name: '50%', exact: true }).waitFor()
    assert.equal((await snapshot()).samePanel, true); assert.equal((await snapshot()).sameCanvas, true)
    assert.equal((await snapshot()).authored, baseline.authored)
    assert.deepEqual((await command('snapshot')).bounds, nativeBaseline.bounds)
    pass('Space playback survives fullscreen; entry fits the viewer and Escape restores manual zoom, original canvas and native bounds')

    await command('fail-next-entry'); await enter()
    await page.getByRole('alert').filter({ hasText: 'Synthetic native presentation failure' }).waitFor()
    await exited()
    assert.equal((await snapshot()).sameCanvas, true)
    await page.evaluate(() => window.viewerPresentationTest.failNextHtmlRequest())
    await enter()
    await page.getByRole('alert').filter({ hasText: 'Synthetic HTML fullscreen failure' }).waitFor()
    await exited()
    assert.equal((await snapshot()).sameCanvas, true)
    pass('Native and HTML fullscreen failures roll back without replacing the viewer')

    await enter(); await active()
    await command('exit-native'); await exited()
    pass('Native presentation exit also clears the HTML viewer fullscreen state')

    await enter(); await active()
    await page.evaluate(() => window.viewerPresentationTest.setMounted(false))
    await exited()
    assert.equal((await snapshot()).mounted, false)
    await page.evaluate(() => window.viewerPresentationTest.setMounted(true))
    await page.waitForFunction(() => Boolean(document.querySelector('canvas[data-preview-popout-source="canvas"]')))
    assert.equal(await page.evaluate(() => window.viewerPresentationTest.markNodes()), true)
    pass('Unmount exits both fullscreen layers and a fresh viewer mounts normally')

    await command('hold-next-entry'); await enter(); await active()
    await page.waitForFunction(async () => (await window.viewerPresentationNative.command({ action: 'snapshot' })).heldEntries === 1)
    await page.keyboard.press('Escape')
    await page.waitForFunction(async () => !(await window.viewerPresentationNative.command({ action: 'snapshot' })).state.active)
    // The renderer deliberately waits for its in-flight entry to settle
    // before cleanup, so release the stale ACK before expecting HTML exit.
    await command('release-entries')
    await exited()
    await sleep(150)
    await exited()
    assert.equal((await snapshot()).samePanel, true); assert.equal((await snapshot()).sameCanvas, true)
    pass('A delayed successful entry reply cannot reopen fullscreen after Escape')
    await page.screenshot({ path: path.join(output, 'editor-restored.png') })
    assert.deepEqual(errors, [], 'Renderer exceptions')
    const result = { success: true, groups, output, native: await command('snapshot'), sandboxed: true }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    console.log('VIEWER_PRESENTATION_RESULT ' + JSON.stringify(result))
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.log'), `${error.stack}\n${logs}`)
    throw error
  } finally {
    await browser?.close().catch(() => {})
    child.kill()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
