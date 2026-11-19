'use strict'
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5225')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw Error('Loopback fixture required')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-lmstudio-setup-'))
const job = (patch = {}) => ({ jobId: 'model-1', turnId: 'turn-1', modelName: 'Synthetic local model · Q4', state: 'downloading', bytesReceived: 1024 ** 2, totalBytes: 2 * 1024 ** 2, canLoad: false, ...patch })
async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 850, height: 850 } }), errors = [], blocked = [], groups = []
  page.setDefaultTimeout(8000)
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => new URL(route.request().url()).origin === base.origin ? route.continue() : (blocked.push('external blocked'), route.abort()))
  await page.routeWebSocket(() => true, socket => socket.close())
  const call = (method, value) => page.evaluate(({ method, value }) => window.lmStudioSetupTest[method](value), { method, value })
  const snapshot = () => page.evaluate(() => window.lmStudioSetupTest.snapshot())
  const button = name => page.getByRole('button', { name, exact: true }), cards = () => page.locator('.ca-lmstudio-setup')
  const jobs = items => call('jobs', { jobs: items })
  const count = async method => (await snapshot()).calls.filter(item => item.method === method).length
  const fresh = async (query = '') => {
    await page.goto(new URL(`/tests/fixtures/agent-lmstudio-setup.html${query}`, base).href)
    await page.waitForFunction(() => window.lmStudioSetupTest?.ready)
    if (!query) await page.waitForFunction(() => window.lmStudioSetupTest.snapshot().listeners === 1 && window.lmStudioSetupTest.snapshot().concurrent === 0)
  }
  try {
    await fresh(); const authored = (await snapshot()).authored
    assert.equal(await cards().count(), 0); assert.equal(await count('load'), 0); assert.equal(await count('cancel'), 0)
    assert.equal((await snapshot()).maximum, 1)
    groups.push('StrictMode mount is passive, scoped and has one subscription without model calls')

    await jobs([job()]); await cards().waitFor()
    assert.equal(await cards().getByRole('progressbar').getAttribute('value'), '50')
    assert.match(await cards().innerText(), /1 MiB received of 2 MiB · 50%/)
    await jobs([job({ bytesReceived: 2 * 1024 ** 2 })]); await page.getByText('Finishing model download…', { exact: true }).waitFor()
    assert.equal(await button('Load & check connection').count(), 0)
    await jobs([job({ totalBytes: null })]); await page.getByText(/Size unknown/).waitFor()
    assert.equal(await cards().getByRole('progressbar').getAttribute('value'), null)
    groups.push('Known and unknown progress are accessible; full transfer is not loaded or ready')

    await jobs([job({ state: 'completed', canLoad: true })]); await button('Load & check connection').waitFor()
    assert.match(await cards().innerText(), /Model downloaded — not loaded/); assert.equal(await count('load'), 0)
    await call('exportBusy', true); await page.waitForFunction(() => [...document.querySelectorAll('button')].find(node => node.textContent === 'Load & check connection')?.disabled)
    assert.equal(await button('Load & check connection').isDisabled(), true); await call('exportBusy', false)
    await button('Load & check connection').click(); await button('Waiting for approval…').waitFor()
    assert.equal(await button('Waiting for approval…').isDisabled(), true); assert.equal(await count('load'), 1)
    await call('approve', false); await cards().getByRole('alert').waitFor()
    assert.match(await cards().innerText(), /not approved/); assert.equal(await count('load'), 1)
    assert.match(await cards().innerText(), /not loaded/)
    groups.push('Load is explicit, export-blocked and duplicate-locked; native decline never retries')

    await button('Load & check connection').click(); await button('Waiting for approval…').waitFor(); await call('approve', true)
    await page.getByText('Loading model and checking connection…', { exact: true }).waitFor()
    assert.equal(await button('Cancel model download').count(), 0); assert.equal(await button('Load & check connection').count(), 0)
    assert.equal(await cards().getByRole('progressbar').getAttribute('value'), null)
    const loadingReads = await count('list'); await page.waitForFunction(count => window.lmStudioSetupTest.snapshot().calls.filter(item => item.method === 'list').length > count, loadingReads)
    await jobs([job({ state: 'ready', connectionVerified: true })]); await page.getByText('Model loaded · local server available', { exact: true }).waitFor()
    assert.match(await cards().innerText(), /Prompt and tool support have not been tested/)
    const finalReads = await count('list'); await page.waitForTimeout(1150); assert.equal(await count('list'), finalReads)
    assert.deepEqual((await snapshot()).authored, authored)
    groups.push('Loading polls without cancellation; native verified ready stops polls without selecting a provider or claiming tool support')

    await fresh(); await jobs([job()]); await button('Cancel model download').waitFor(); await call('exportBusy', true)
    assert.equal(await button('Cancel model download').isEnabled(), true); await button('Cancel model download').click()
    await page.getByText('Model download cancelled', { exact: true }).waitFor(); assert.equal(await count('cancel'), 1)
    assert.equal(await button('Load & check connection').count(), 0)
    groups.push('Download cancellation remains available during export and never offers load for cancelled jobs')

    for (const code of ['LOAD_UNKNOWN', 'LM_IDENTITY_UNAVAILABLE']) {
      await fresh(); await jobs([job({ state: 'completed', canLoad: true })]); await button('Load & check connection').waitFor()
      await call('loadError', { code, message: code === 'LOAD_UNKNOWN' ? 'Load result could not be confirmed. Check LM Studio.' : 'Downloaded model did not match an installed model.' })
      await button('Load & check connection').click(); await button('Waiting for approval…').waitFor(); await call('approve', true)
      await cards().getByRole('alert').waitFor()
      assert.equal(await button('Load & check connection').count(), code === 'LOAD_UNKNOWN' ? 0 : 1)
      assert.match(await cards().innerText(), /load not verified/); assert.doesNotMatch(await cards().innerText(), /not loaded/); assert.equal(await count('load'), 1)
    }
    groups.push('Uncertain load blocks retry; known pre-load identity refusal remains explicitly retryable without automatic work')

    await fresh(); await jobs([job()]); await cards().waitFor(); await call('error', 'Synthetic status unavailable')
    await page.getByRole('alert').waitFor(); assert.match(await cards().innerText(), /Downloading model/)
    await button('Refresh model progress').click(); assert.equal(await count('load'), 0)
    await call('error', ''); await page.getByRole('alert').waitFor({ state: 'hidden' })
    assert.equal(await cards().count(), 1)
    groups.push('Read failures retain truthful last state and explicit refresh recovers without model actions')

    await fresh(); await call('holdRead', true); await jobs([job()])
    await page.waitForFunction(() => window.lmStudioSetupTest.snapshot().heldReads === 1)
    await call('scope', { projectPath: '/synthetic/project-b', chatId: 'chat-b' })
    await call('holdRead', false); await call('releaseReads'); await page.waitForTimeout(70)
    assert.equal(await cards().count(), 0)
    await call('jobs', { jobs: [job({ jobId: 'model-b', turnId: 'turn-b' })], scope: { projectPath: '/synthetic/project-b', chatId: 'chat-b' } })
    await page.locator('[data-job-id="model-b"]').waitFor(); assert.equal(await page.locator('[data-job-id="model-1"]').count(), 0)
    await call('mounted', false); await cards().waitFor({ state: 'hidden' }); assert.equal((await snapshot()).listeners, 0)
    await call('mounted', true); await page.locator('[data-job-id="model-b"]').waitFor(); assert.equal((await snapshot()).listeners, 1)
    assert.equal(await count('load'), 0)
    groups.push('Late old-scope reads cannot cross chat/project; remount reattaches scoped native jobs without repeating actions')

    await fresh(); await jobs([job({ state: 'completed', canLoad: true })]); await button('Load & check connection').click()
    await button('Waiting for approval…').waitFor(); await call('mounted', false); await call('approve', true)
    await page.waitForTimeout(70); assert.equal(await cards().count(), 0); assert.equal((await snapshot()).listeners, 0)
    await call('mounted', true); await page.getByText('Loading model and checking connection…', { exact: true }).waitFor()
    assert.equal(await count('load'), 1)
    groups.push('Closing during confirmation ignores late UI completion and later remount observes native state without duplicate load')

    await fresh(); await call('error', 'Synthetic initial read failure'); await page.getByRole('alert').waitFor()
    assert.match(await page.locator('.ca-setup-download-recovery').innerText(), /No current model setup status/)
    await fresh('?missing=1'); await page.waitForTimeout(80); assert.equal(await cards().count(), 0)
    assert.equal(await page.getByRole('alert').count(), 0); assert.equal((await snapshot()).calls.length, 0)
    groups.push('Initial read failure is recoverable; older preload with no bridge stays silent')

    await fresh(); await jobs([job({ state: 'ready' })]); await page.getByText('Model status needs verification', { exact: true }).waitFor()
    assert.equal(await page.getByText('Model loaded · local server available', { exact: true }).count(), 0)
    groups.push('Ready state without native connection verification never claims a confirmed server')

    const context = { contextTargetTokens: 32768, requestedContextTokens: 8192, modelMaxContextTokens: 8192, effectiveContextTokens: 8192, contextVerified: true }
    await jobs([job({ ...context, state: 'completed', canLoad: true })]); await page.getByText(/Load target: up to 32,768 tokens/).waitFor()
    assert.match(await cards().innerText(), /limited by the model\. Larger context uses more RAM/)
    assert.equal(await page.getByText(/Verified context:/).count(), 0)
    await jobs([job({ ...context, state: 'ready', connectionVerified: true })]); await page.getByText('Verified context: 8,192 tokens.', { exact: true }).waitFor()
    assert.equal(await page.getByText(/Load target:/).count(), 0)
    for (const patch of [{ effectiveContextTokens: 4096 }, { effectiveContextTokens: 16384 }, { requestedContextTokens: 4096 },
      { modelMaxContextTokens: null }, { contextTargetTokens: '32768' }, { contextVerified: false }]) {
      await jobs([job({ ...context, ...patch, state: 'ready', connectionVerified: true })])
      await page.getByText(/Verified context:/).waitFor({ state: 'hidden' })
    }
    await jobs([job({ state: 'ready', connectionVerified: true })]); await page.getByText('Model loaded · local server available', { exact: true }).waitFor()
    assert.equal(await page.locator('.ca-lmstudio-context').count(), 0)
    assert.equal(await count('load'), 0); assert.deepEqual((await snapshot()).authored, authored)
    groups.push('Context target, RAM caveat and capped effective context are truthful; legacy or incoherent receipts never invent verification')

    await page.setViewportSize({ width: 390, height: 720 })
    await jobs([job({ modelName: '<img src=x onerror=alert(1)> ' + 'Long model name '.repeat(20), warning: { message: '<script>bad()</script> Synthetic warning' } }),
      job({ jobId: 'model-2', turnId: 'turn-2', state: 'completed', canLoad: true })])
    await page.locator('[data-turn-id="turn-2"] .ca-lmstudio-setup').waitFor()
    assert.equal(await page.locator('[data-turn-id="turn-1"] .ca-lmstudio-setup').count(), 1)
    assert.equal(await cards().locator('img,script,a').count(), 0)
    const scroller = page.locator('#conversation'); await scroller.evaluate(node => { node.scrollTop = 30 })
    const top = await scroller.evaluate(node => node.scrollTop)
    assert.ok(top > 0, 'Exercise real scrolled history, not an unscrollable empty viewport')
    await jobs([job({ modelName: '<img src=x onerror=alert(1)> ' + 'Long model name '.repeat(20), bytesReceived: 1.5 * 1024 ** 2,
      warning: { message: '<script>bad()</script> Synthetic warning' } }), job({ jobId: 'model-2', turnId: 'turn-2', state: 'completed', canLoad: true })])
    await page.getByText(/75%/).waitFor(); assert.equal(await scroller.evaluate(node => node.scrollTop), top)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: path.join(output, 'lmstudio-model-narrow.png'), fullPage: true })
    assert.deepEqual((await snapshot()).authored, authored)
    groups.push('Narrow turn-anchored cards escape text, avoid horizontal overflow and do not move scroll on progress')
    await jobs([job({ ...context, state: 'ready', connectionVerified: true }), job({ jobId: 'model-2', turnId: 'turn-2', state: 'completed', canLoad: true,
      contextTargetTokens: 32768, modelName: 'Another synthetic model · Q4' })])
    await page.getByText('Model loaded · local server available', { exact: true }).waitFor()
    await page.getByText('Verified context: 8,192 tokens.', { exact: true }).waitFor()
    await page.getByText(/Load target: up to 32,768 tokens/).waitFor()
    await scroller.evaluate(node => { node.scrollTop = 0 })
    await page.screenshot({ path: path.join(output, 'lmstudio-model-statuses-narrow.png'), fullPage: true })
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    console.log(JSON.stringify({ success: true, count: groups.length, groups, output, network: false, models: false }, null, 2))
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    console.error({ output, groups, errors, blocked }); throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
