// Real renderer open_comfyui_workflow handler and graph conversion; isolated
// native/ComfyUI boundary. No real desktop, project, provider or ComfyUI access.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5209')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('Use an isolated loopback fixture')
const objectInfo = {
  LoadImage: { input: { required: { image: [['fixture-city.png'], { image_upload: true }] } },
    input_order: { required: ['image'] }, output: ['IMAGE', 'MASK'], output_name: ['IMAGE', 'MASK'] },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'preview' }] } },
    input_order: { required: ['images', 'filename_prefix'] }, output: [], output_node: true },
}
async function main() {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-workflow-opening-'))
  const errors = [], blocked = [], catalogReads = []
  let catalogStatus = 200, groups = 0
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin === 'http://127.0.0.1:59989' && url.pathname === '/object_info' && request.method() === 'GET') {
      catalogReads.push(url.href)
      return route.fulfill({ status: catalogStatus, contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(objectInfo) })
    }
    if (url.origin === base.origin && !/^\/(prompt|queue|history|upload|api|v1)(\/|$)/.test(url.pathname)) return route.continue()
    blocked.push({ method: request.method(), url: url.href }); return route.abort()
  })
  await page.routeWebSocket(() => true, socket => socket.close())
  const state = () => page.evaluate(() => window.workflowOpeningTest.snapshot())
  const run = payload => page.evaluate(payload => window.workflowOpeningTest.run(payload), payload)
  const pass = text => console.log(`PASS ${++groups}: ${text}`)
  try {
    await page.goto(new URL('/tests/fixtures/workflow-opening.html', base).href)
    await page.waitForFunction(() => window.workflowOpeningTest?.ready)
    const baseline = await state()
    const apiPreview = await run({ workflowId: 'tpl-mcp-city' })
    assert.equal(apiPreview.success, true); assert.equal(apiPreview.previewOnly, true)
    assert.equal(apiPreview.opened, false); assert.equal(apiPreview.applied, false)
    assert.equal(apiPreview.generationSubmitted, false); assert.equal(apiPreview.nodeCount, 2)
    const uiPreview = await run({ workflowId: 'my-workflow:portrait', previewOnly: true })
    assert.equal(uiPreview.success, true); assert.equal(uiPreview.format, 'ui')
    assert.deepEqual((await state()).calls.map(call => call.type), ['read', 'read'])
    assert.equal(catalogReads.length, 0)
    assert.match(await page.getByRole('status').innerText(), /editor/)
    pass('UI and API previews inspect saved graphs without tab navigation, graph loads or generation')

    const uiApply = await run(uiPreview.suggestedApplyPayload)
    assert.equal(uiApply.success, true); assert.equal(uiApply.opened, true); assert.equal(uiApply.applied, true)
    assert.equal(uiApply.generationSubmitted, false)
    const uiState = await state(), uiLoad = uiState.calls.find(call => call.type === 'load')
    assert.equal(uiLoad.visible, true)
    assert.deepEqual(uiLoad.args.workflowGraph, baseline.uiWorkflow)
    assert.equal(uiLoad.args.comfyBaseUrl, 'http://127.0.0.1:59989')
    assert.ok(uiState.calls.findIndex(call => call.type === 'tab') < uiState.calls.findIndex(call => call.type === 'load'))
    assert.match(await page.getByRole('status').innerText(), /comfyui/)
    assert.equal(catalogReads.length, 0)
    pass('Saved UI graph opens the embedded tab before loading, preserving its widgets and layout')

    const apiApply = await run(apiPreview.suggestedApplyPayload)
    assert.equal(apiApply.success, true); assert.equal(apiApply.opened, true); assert.equal(apiApply.applied, true)
    assert.equal(apiApply.generationSubmitted, false)
    const apiLoad = (await state()).calls.filter(call => call.type === 'load').at(-1)
    const graph = apiLoad.args.workflowGraph
    assert.equal(apiLoad.visible, true); assert.equal(catalogReads.length, 1)
    assert.equal(graph.nodes.length, 2); assert.equal(graph.links.length, 1)
    assert.equal(graph.nodes.find(node => node.type === 'LoadImage').title, 'City reference')
    assert.equal(graph.nodes.find(node => node.type === 'LoadImage').widgets_values[0], 'fixture-city.png')
    assert.equal(graph.nodes.find(node => node.type === 'SaveImage').widgets_values[0], 'fixture-preview')
    assert.equal(graph.nodes.find(node => node.type === 'SaveImage').inputs[0].name, 'images')
    assert.equal(graph.nodes.find(node => node.type === 'SaveImage').inputs[0].type, 'IMAGE')
    assert.ok(graph.nodes.find(node => node.type === 'LoadImage').outputs[0].links.length)
    await page.getByLabel('Loaded graph').filter({ hasText: 'City reference' }).waitFor()
    await page.screenshot({ path: path.join(output, 'api-workflow-opened.png') })
    pass('API recipe converts through real node schemas into an editable graph with linked image sockets')

    const beforeInvalid = (await state()).calls.filter(call => call.type !== 'read').length
    assert.equal((await run({ previewOnly: false })).success, false)
    const missing = await run({ workflowId: 'my-workflow:missing', previewOnly: false })
    assert.equal(missing.success, false); assert.match(missing.error, /not found/i)
    assert.equal((await run({ workflowId: 'my-workflow:malformed', previewOnly: false })).success, false)
    assert.equal((await state()).calls.filter(call => call.type !== 'read').length, beforeInvalid)
    pass('Missing IDs, missing saved workflows and malformed graphs fail before opening or loading')

    await page.evaluate(() => window.workflowOpeningTest.setLoadError('Synthetic embedded ComfyUI load failed.'))
    const loadFailure = await run({ workflowId: 'my-workflow:portrait', previewOnly: false })
    assert.equal(loadFailure.success, false); assert.match(loadFailure.error, /Synthetic embedded ComfyUI load failed/)
    await page.evaluate(() => window.workflowOpeningTest.setLoadError(''))
    const beforeCatalogFailure = (await state()).calls.filter(call => call.type === 'load').length
    catalogStatus = 503
    const catalogFailure = await run({ workflowId: 'tpl-mcp-city', previewOnly: false })
    assert.equal(catalogFailure.success, false); assert.match(catalogFailure.error, /object info.*503/i)
    assert.equal((await state()).calls.filter(call => call.type === 'load').length, beforeCatalogFailure)
    catalogStatus = 200
    pass('Native loader and schema fetch failures cannot be reported as successful graph opens')

    const beforeExport = (await state()).calls.length
    await page.evaluate(() => window.workflowOpeningTest.setExportBusy(true))
    const exportFailure = await run({ workflowId: 'tpl-mcp-city', previewOnly: false })
    assert.equal(exportFailure.success, false); assert.match(exportFailure.error, /export/i)
    assert.equal((await state()).calls.length, beforeExport)
    await page.evaluate(() => window.workflowOpeningTest.setExportBusy(false))
    const final = await state()
    assert.deepEqual(final.authored, baseline.authored); assert.deepEqual(final.forbiddenCalls, [])
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    pass('Export priority remains intact; no project, timeline, assets, Undo, disk or generation writes')
    console.log(JSON.stringify({ success: true, groups, output }))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
