'use strict'
// Actual renderer importer, synthetic native ledger and RAM-only files.
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5304')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw Error('Loopback fixture only')
async function main() {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
  const page = await browser.newPage({ serviceWorkers: 'block' }), errors = [], blocked = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === base.origin && !/^\/(prompt|queue|history|upload|view|ws|api|v1)(\/|$)/.test(url.pathname)) return route.continue()
    blocked.push(url.href); return route.abort()
  })
  await page.routeWebSocket(() => true, socket => socket.close())
  try {
    await page.goto(new URL('/tests/fixtures/generation-runs.html', base).href)
    await page.waitForFunction(() => window.generationRunsTest?.ready)
    await page.evaluate(() => {
      const api = window.generationRunsTest
      for (let n = 0; n < 10; n++) api.publish(`batch-${n}`, { autoImport: true, status: 'queued', origin: 'agent',
        outputs: [{ filename: `clip-${n}.png`, type: 'output', mediaType: 'image', nodeId: '2' }] })
      for (let n = 0; n < 10; n++) api.setStatus(`batch-${n}`, 'done')
    })
    await page.waitForFunction(() => window.generationRunsTest.records().filter(r => r.id.startsWith('batch-') && r.importState === 'imported').length === 10)
    const first = await page.evaluate(() => window.generationRunsTest.state())
    assert.equal(first.assets.length, 10)
    assert.equal(new Set(first.assets.map(a => a.generationRun.runId)).size, 10)
    assert.equal(first.calls.filter(c => c.method === 'download').length, 10)
    await page.evaluate(async () => {
      const api = window.generationRunsTest
      api.emit(); api.stop(); api.start(); api.emit()
      for (let n = 0; n < 10; n++) await api.import(`batch-${n}`, { previewOnly: false })
    })
    const after = await page.evaluate(() => window.generationRunsTest.state())
    assert.equal(after.assets.length, 10); assert.equal(after.calls.filter(c => c.method === 'download').length, 10)
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    console.log(JSON.stringify({ passed: true, rendererBatchImports: 10, downloads: 10, duplicateImports: 0,
      repeatedDownloads: 0, subscriptionsRestarted: true, realServiceRequests: 0, paidRequests: 0 }))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
