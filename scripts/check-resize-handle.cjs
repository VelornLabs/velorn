// Synthetic browser coverage for the shared splitter only. Bundles the real
// component in memory: no app, project, provider, native bridge or server.
const assert = require('node:assert/strict')
const path = require('node:path')
const { build } = require('esbuild')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')

async function main() {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import ResizeHandle from './src/components/ResizeHandle.jsx';
    const events = [];
    function Fixture() {
      const [shown, setShown] = useState(true);
      window.resizeFixture = { events, setShown };
      return <>{shown && <>
        <ResizeHandle className="horizontal" onResize={value => events.push(['horizontal', value])} />
        <ResizeHandle className="vertical" direction="vertical" onResize={value => events.push(['vertical', value])} />
      </>}</>;
    }
    createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture /></React.StrictMode>);
  `, resolveDir: path.resolve(__dirname, '..'), loader: 'jsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' } })
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, hasTouch: true, serviceWorkers: 'block' })
  const page = await context.newPage(), errors = [], groups = []
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  try {
  await page.route('**/*', route => route.abort())
  await page.setContent('<!doctype html><html><head><style>body{margin:0}.horizontal{position:absolute;left:400px;top:30px;width:8px;height:250px}.vertical{position:absolute;left:30px;top:340px;width:600px;height:8px}.touch-none{touch-action:none}</style></head><body><div id="root"></div></body></html>')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.locator('.vertical').waitFor()
  await page.evaluate(() => {
    document.body.style.setProperty('cursor', 'crosshair', 'important')
    document.body.style.setProperty('user-select', 'text', 'important')
    document.addEventListener('pointerdown', event => { window.lastPointerId = event.pointerId }, true)
  })
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const events = () => page.evaluate(() => window.resizeFixture.events.slice())
  const styles = () => page.evaluate(() => ['cursor', 'user-select'].map(key => [document.body.style.getPropertyValue(key), document.body.style.getPropertyPriority(key)]))
  const originalStyles = await styles()
  const begin = async name => {
    const box = await page.locator(`.${name}`).boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    assert.equal(await page.locator(`.${name}`).evaluate(el => el.hasPointerCapture(window.lastPointerId)), true)
  }
  const noMoreResize = async before => {
    await page.mouse.move(780, 620)
    await frame()
    assert.equal((await events()).length, before)
    assert.deepEqual(await styles(), originalStyles)
  }
    for (const name of ['horizontal', 'vertical']) {
      await begin(name)
      assert.equal((await styles())[0][0], name === 'horizontal' ? 'col-resize' : 'row-resize')
      await page.mouse.move(660, 530)
      assert.deepEqual((await events()).at(-1), [name, name === 'horizontal' ? 660 : 530])
      await page.mouse.up()
      await noMoreResize((await events()).length)
    }
    pass('Both splitter directions track the matching coordinate outside their bounds and restore exact inline styles on release')

    for (const type of ['pointercancel', 'lostpointercapture', 'blur']) {
      await begin('vertical')
      const before = (await events()).length
      await page.locator('.vertical').evaluate((el, type) => {
        if (type === 'blur') window.dispatchEvent(new Event('blur'))
        else el.dispatchEvent(new PointerEvent(type, { pointerId: window.lastPointerId, pointerType: 'mouse', isPrimary: true, bubbles: true }))
      }, type)
      await page.mouse.up()
      await noMoreResize(before)
    }
    pass('Pointer cancellation, lost capture and window blur finish a drag without late callbacks or leaked body styles')

    await begin('horizontal')
    const beforeForeign = (await events()).length
    await page.locator('.horizontal').evaluate(el => {
      el.dispatchEvent(new PointerEvent('pointermove', { pointerId: 777, pointerType: 'touch', isPrimary: false, bubbles: true, clientX: 850 }))
      el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 777, pointerType: 'touch', isPrimary: false, bubbles: true }))
    })
    assert.equal((await events()).length, beforeForeign)
    assert.equal(await page.locator('.horizontal').evaluate(el => el.hasPointerCapture(window.lastPointerId)), true)
    await page.mouse.up()
    await page.locator('.horizontal').click({ button: 'right' })
    await noMoreResize((await events()).length)
    pass('Foreign pointer events and secondary-button starts cannot control the active splitter')

    await begin('vertical')
    const beforeUnmount = (await events()).length
    await page.evaluate(() => window.resizeFixture.setShown(false))
    await page.locator('.vertical').waitFor({ state: 'detached' })
    await page.mouse.up()
    await noMoreResize(beforeUnmount)
    await page.evaluate(() => window.resizeFixture.setShown(true))
    await page.locator('.vertical').waitFor()
    pass('Unmounting mid-drag restores styles, releases capture and does not resize detached workspaces')

    const cdp = await context.newCDPSession(page)
    const beforeTouch = (await events()).length
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 320, y: 344 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 320, y: 470 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await frame()
    assert.ok((await events()).length > beforeTouch)
    assert.deepEqual((await events()).at(-1), ['vertical', 470])
    assert.deepEqual(await styles(), originalStyles)
    pass('Real emulated touch resizes the vertical splitter without browser gesture cancellation')
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ success: true, groups }, null, 2))
  } finally { await context.close(); await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
