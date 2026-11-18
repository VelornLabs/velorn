// Real Inspector and history, isolated synthetic project. No live media or edits.
const assert = require('node:assert/strict')
const path = require('node:path')
const { chromium, _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
async function main() {
  const native = process.env.VELORN_TEST_ELECTRON === '1'
  const browser = native
    ? await _electron.launch({ executablePath: require('electron'), args: [path.resolve(__dirname, '../tests/fixtures/inspector-electron.cjs')] })
    : await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
  try {
    const page = native ? await browser.firstWindow() : await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
    await page.routeWebSocket(() => true, socket => socket.close())
    await page.goto((process.env.VELORN_TEST_URL || 'http://127.0.0.1:5208') + '/tests/fixtures/multi-clip-inspector.html')
    await page.waitForFunction(() => window.multiClipInspectorTest)
    const reset = () => page.evaluate(() => {
      const store = window.multiClipInspectorTest.timeline
      const clip = { id: 'speed-test', name: 'Before', type: 'video', trackId: 'visual-a', assetId: 'synthetic',
        startTime: 17, duration: 6, trimStart: 2, trimEnd: 8, sourceDuration: 20, speed: 1, effects: [], keyframes: {} }
      store.setState({ clips: [clip], selectedClipIds: [clip.id], history: [], historyIndex: -1,
        timelineSessionId: (store.getState().timelineSessionId || 0) + 1 })
      store.getState().saveToHistory()
      store.setState({ clips: [{ ...clip, name: 'Earlier edit' }] })
    })
    const state = () => page.evaluate(() => {
      const s = window.multiClipInspectorTest.timeline.getState()
      return { speed: s.clips[0].speed, duration: s.clips[0].duration, name: s.clips[0].name, history: s.history.length }
    })
    const undo = () => page.evaluate(() => window.multiClipInspectorTest.timeline.getState().undo())
    const redo = () => page.evaluate(() => window.multiClipInspectorTest.timeline.getState().redo())
    const check = async () => {
      const after = await state()
      assert.notEqual(after.speed, 1); assert.equal(after.history, 2)
      await undo(); assert.equal((await state()).speed, 1); assert.equal((await state()).name, 'Earlier edit')
      await redo(); assert.equal((await state()).speed, after.speed)
    }
    await reset()
    await page.getByRole('button', { name: 'Motion', exact: true }).click()
    const number = page.getByRole('spinbutton', { name: 'Playback speed', exact: true })
    await number.fill('3'); await number.blur(); await check()
    await reset()
    const slider = page.getByRole('slider', { name: 'Playback speed slider' })
    await slider.scrollIntoViewIfNeeded()
    const box = await slider.boundingBox()
    await page.mouse.move(box.x + box.width * .53, box.y + box.height / 2); await page.mouse.down()
    await page.mouse.move(box.x + box.width * .8, box.y + box.height / 2, { steps: 12 }); await page.mouse.up()
    await check()
    await reset(); await slider.focus()
    await page.keyboard.down('End'); await page.keyboard.up('End')
    await slider.blur(); await check()
    assert.deepEqual(errors, [])
    console.log('PASS: typed speed, pointer drag and keyboard gesture each undo/redo independently of the earlier edit' + (native ? ' (Electron)' : ' (Chrome)'))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
