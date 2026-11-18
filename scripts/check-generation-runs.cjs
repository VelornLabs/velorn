'use strict'
// Synthetic browser/service test. All native files and downloads live in RAM.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5204')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('Loopback fixture only')
async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  const errors = [], blocked = [], groups = [], artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-generation-runs-browser-'))
  const pass = name => { groups.push(name); console.log(`PASS ${groups.length}: ${name}`) }
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === base.origin && !/^\/(prompt|queue|history|upload|view|ws|api|v1)(\/|$)/.test(url.pathname)) return route.continue()
    blocked.push(url.href); return route.abort()
  })
  await page.routeWebSocket(() => true, socket => socket.close())
  try {
    await page.goto(new URL('/tests/fixtures/generation-runs.html', base).href)
    await page.waitForFunction(() => window.generationRunsTest?.ready && window.generationRunsTest.monitor().length === 4)
    const initial = await page.evaluate(() => ({ state: window.generationRunsTest.state(), runs: window.generationRunsTest.monitor() }))
    assert.equal(initial.state.listeners, 1)
    assert.ok(initial.state.calls.filter(item => item.method === 'list').every(item => item.payload.includeOtherProjects === true))
    const running = initial.runs.find(item => item.runId === 'running')
    assert.equal(running.projectKey, '/fixture-only/generation-runs/alpha')
    assert.equal(running.progressKnown, false)
    assert.equal(running.createdAt, Date.parse('2026-09-29T10:00:00.000Z'))
    pass('Actual bridge retains internal project identity, ISO times and unknown progress without Generate')

    const preview = await page.evaluate(async () => {
      const api = window.generationRunsTest, before = api.state()
      const result = await api.import('complete')
      return { before, after: api.state(), result }
    })
    assert.equal(preview.result.previewOnly, true); assert.equal(preview.result.importableCount, 1)
    assert.deepEqual(preview.before, preview.after)
    pass('Import preview performs no download, native write, asset change or receipt acknowledgement')

    const imported = await page.evaluate(async () => {
      const api = window.generationRunsTest
      const first = await api.import('complete', { previewOnly: false })
      const second = await api.import('complete', { previewOnly: false })
      const state = api.state(), sidecarPath = state.files.find(value => value.endsWith('.velorn-workflow.json'))
      return { first, second, state, sidecar: JSON.parse(api.files.get(sidecarPath)) }
    })
    assert.equal(imported.first.success, true, JSON.stringify(imported.first)); assert.equal(imported.first.importedCount, 1)
    assert.equal(imported.first.acknowledged, true)
    assert.equal(imported.second.importedCount, 0); assert.equal(imported.state.assets.length, 1)
    assert.equal(imported.state.calls.filter(item => item.method === 'download').length, 1)
    assert.match(imported.state.assets[0].generationRun.recipeSidecar, /^assets\/images\//)
    assert.ok(imported.sidecar.recipe.workflow['1'])
    assert.equal(imported.sidecar.recipe.workflowId, 'tpl-mcp-synthetic-workflow')
    assert.equal(imported.sidecar.recipe.sourceGraphFingerprint, 'a'.repeat(64))
    assert.equal(imported.sidecar.recipe.resolvedFingerprint, 'b'.repeat(64))
    assert.ok(imported.state.calls.some(item => item.method === 'control' && item.payload.operation === 'mark-imported' && item.payload.previewOnly === false))
    pass('Real asset-import helper writes relative media/recipe, saves and acknowledges once; repeated import deduplicates')

    const recovered = await page.evaluate(async () => {
      const api = window.generationRunsTest
      const image = filename => ({ filename, type: 'output', mediaType: 'image', nodeId: '2' })
      api.publish('receipt-recovery', { status: 'done', outputs: [image('receipt.png')] })
      api.failAcknowledgement()
      const first = await api.import('receipt-recovery', { previewOnly: false })
      api.emit()
      const retry = await api.import('receipt-recovery', { previewOnly: false })
      api.publish('partial', { status: 'done', outputs: [image('part-one.png'), image('part-two.png')] })
      api.failFilename('part-two.png')
      const partial = await api.import('partial', { previewOnly: false })
      const completed = await api.import('partial', { previewOnly: false })
      return { first, retry, partial, completed, records: api.records(), state: api.state() }
    })
    assert.ok(recovered.first.failures.length > 0)
    assert.equal(recovered.retry.importedCount, 0)
    assert.equal(recovered.retry.acknowledged, true)
    assert.equal(recovered.records.find(item => item.id === 'receipt-recovery').resultAssetIds.length, 1)
    assert.equal(recovered.partial.importedCount, 1); assert.equal(recovered.completed.importedCount, 1)
    assert.equal(recovered.records.find(item => item.id === 'partial').resultAssetIds.length, 2)
    assert.equal(recovered.state.assets.filter(item => item.generationRun?.runId === 'partial').length, 2)
    assert.equal(recovered.state.calls.filter(item => item.method === 'control' && item.payload.operation === 'mark-imported'
      && item.payload.runId === 'partial').at(-1).payload.resultAssetIds.length, 2)
    pass('Interrupted import acknowledgements recover without duplicate media; partial retries retain all asset receipts')

    const guards = await page.evaluate(async () => {
      const api = window.generationRunsTest, before = api.state()
      const other = await api.import('other', { previewOnly: false })
      api.setExport(true)
      const exporting = await api.import('complete', { previewOnly: false })
      api.setExport(false)
      return { other, exporting, before, after: api.state() }
    })
    assert.equal(guards.other.success, false); assert.equal(guards.exporting.success, false)
    assert.deepEqual(guards.before, guards.after)
    pass('Foreign-project and export guards refuse import before downloads or writes')

    const batchPreview = await page.evaluate(async () => {
      const api = window.generationRunsTest
      api.publish('large-batch', { status: 'done', outputs: Array.from({ length: 65 }, (_, index) => ({
        filename: `batch-${index}.png`, type: 'output', mediaType: 'image', nodeId: '2',
      })) })
      const before = api.state()
      const result = await api.import('large-batch')
      return { before, after: api.state(), result }
    })
    assert.equal(batchPreview.result.importableCount, 65)
    assert.equal(batchPreview.result.outputs.length, 65)
    assert.deepEqual(batchPreview.before, batchPreview.after)
    pass('A 65-output workflow retains every recorded descriptor instead of silently truncating the import plan')

    await page.evaluate(() => {
      const api = window.generationRunsTest
      api.publish('switching', { status: 'done', outputs: [{ filename: 'switch.png', type: 'output', mediaType: 'image', nodeId: '2' }] })
      api.holdDownload(); window.pendingImport = api.import('switching', { previewOnly: false })
    })
    await page.waitForFunction(() => window.generationRunsTest.downloadIsHeld())
    const switched = await page.evaluate(async () => {
      const api = window.generationRunsTest
      api.selectProject(api.rootB); api.releaseDownload()
      const result = await window.pendingImport
      return { result, state: api.state() }
    })
    assert.equal(switched.result.success, false); assert.equal(switched.state.assets.length, 0)
    assert.equal(switched.state.files.some(value => value.endsWith('switch.png')), false)
    pass('Switching projects during a pending download prevents importing media into either wrong session')

    await page.evaluate(() => {
      const api = window.generationRunsTest
      api.selectProject(api.rootA); api.failDownload()
      api.publish('auto-failure', { status: 'done', autoImport: true, outputs: [{ filename: 'fail.png', type: 'output', mediaType: 'image', nodeId: '2' }] })
    })
    await page.waitForFunction(() => window.generationRunsTest.records().find(run => run.id === 'auto-failure')?.importState === 'failed')
    const retries = await page.evaluate(async () => {
      const api = window.generationRunsTest
      const before = api.calls.filter(item => item.method === 'download').length
      api.emit(); api.emit(); await new Promise(resolve => setTimeout(resolve, 30))
      return { before, after: api.calls.filter(item => item.method === 'download').length }
    })
    assert.equal(retries.before, retries.after)
    pass('Failed automatic import records a failure and does not loop on later native events')

    const merge = await page.evaluate(() => {
      const api = window.generationRunsTest
      api.publishLegacy(); const merged = api.status()
      api.resetLegacy(); const reset = api.status()
      return { merged, reset, runs: api.monitor() }
    })
    assert.equal(merge.merged.jobs.filter(item => item.promptId === 'prompt-running').length, 1)
    assert.ok(merge.reset.jobs.some(item => item.promptId === 'prompt-running'))
    assert.equal(merge.reset.live, true)
    pass('Native and legacy prompt receipts deduplicate; leaving/resetting Generate retains native status')

    await page.evaluate(() => { window.generationRunsTest.seed(); window.generationRunsTest.selectProject() })
    const open = () => page.getByRole('button', { name: 'Open generation queue', exact: true }).click()
    await open()
    await page.locator('[data-generation-queue-drawer]').waitFor()
    const completedCard = page.locator('[data-generation-run-id="complete"]')
    const beforeVisibility = await page.evaluate(() => window.generationRunsTest.state())
    assert.ok(await completedCard.locator('time').getAttribute('datetime'))
    await completedCard.getByRole('button', { name: /^Dismiss / }).click()
    assert.equal(await completedCard.count(), 0)
    await page.getByRole('checkbox', { name: /Show dismissed/ }).check()
    await completedCard.getByRole('button', { name: /^Restore / }).click()
    await page.getByRole('checkbox', { name: /Show dismissed/ }).uncheck()
    assert.equal(await completedCard.count(), 1)
    await page.getByRole('button', { name: 'Clear finished', exact: true }).click()
    assert.equal(await completedCard.count(), 0)
    assert.equal(await page.locator('[data-generation-run-id="running"]').count(), 1)
    assert.equal(await page.locator('[data-generation-run-id="unknown"]').count(), 1)
    assert.equal(await page.locator('[data-generation-run-id="running"]').getByRole('button', { name: /^Dismiss / }).count(), 0)
    await page.evaluate(() => window.generationRunsTest.emit())
    await page.getByRole('button', { name: 'Close generation queue', exact: true }).click()
    await open()
    assert.equal(await completedCard.count(), 0)
    await page.getByRole('checkbox', { name: /Show dismissed/ }).check()
    while (await page.getByRole('button', { name: /^Restore / }).count()) await page.getByRole('button', { name: /^Restore / }).first().click()
    await page.getByRole('checkbox', { name: /Show dismissed/ }).uncheck()
    assert.deepEqual(await page.evaluate(() => window.generationRunsTest.state()), beforeVisibility)
    pass('Dismiss/restore and Clear finished preserve native history/files, survive refresh and never hide active/unknown runs; timestamps display')
    assert.equal(await page.locator('[data-generation-run-id="running"]').count(), 1)
    await page.screenshot({ path: path.join(artifacts, 'queue-wide.png') })
    for (const tab of ['Storyboard', 'Editor', 'Generate', 'Stock', 'ComfyUI', 'Export', 'Discover']) {
      await page.getByRole('button', { name: 'Close generation queue', exact: true }).click()
      await page.getByRole('button', { name: tab, exact: true }).click()
      await open()
      assert.equal(await page.locator('[data-generation-run-id="running"]').count(), 1)
    }
    pass('Shared queue remains reachable across every workspace without opening Generate for tracking')

    const observationsBefore = await page.evaluate(() => window.generationRunsTest.calls.filter(item => item.method === 'observe').length)
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.waitForFunction(before => window.generationRunsTest.calls.filter(item => item.method === 'observe').length > before, observationsBefore)
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Refresh')?.disabled)
    assert.equal(await page.getByRole('region', { name: 'Observed external ComfyUI jobs', exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Observe external ComfyUI jobs' }).getAttribute('aria-pressed'), 'false')
    assert.equal(await page.evaluate(() => window.generationRunsTest.calls.filter(item => item.method === 'adopt').length), 0)
    pass('Refresh reconciles known runs without enabling external observation or adopting unrelated work')

    await page.getByRole('button', { name: 'Observe external ComfyUI jobs' }).click()
    await page.getByRole('button', { name: 'Track in this project', exact: true }).click()
    await page.waitForFunction(() => window.generationRunsTest.records().some(run => run.id === 'adopted'))
    const adopt = await page.evaluate(() => window.generationRunsTest.calls.filter(item => item.method === 'adopt'))
    assert.equal(adopt.length, 1); assert.equal(adopt[0].payload.promptId, 'external-prompt'); assert.equal(adopt[0].payload.previewOnly, false)
    pass('Explicit external-job observation and tracking send the exact existing prompt ID once')

    await page.setViewportSize({ width: 520, height: 850 })
    await page.screenshot({ path: path.join(artifacts, 'queue-narrow.png') })
    const box = await page.locator('[data-generation-queue-drawer]').boundingBox()
    assert.ok(box && box.x >= 0 && box.x + box.width <= 521 && box.y + box.height <= 851, JSON.stringify(box))
    pass('Queue fits a narrow viewport without cutting off its controls')

    const lifecycle = await page.evaluate(async () => {
      const api = window.generationRunsTest
      api.start(); const idempotent = api.state().listeners
      api.stop(); const stopped = api.state().listeners
      api.start(); await new Promise(resolve => setTimeout(resolve, 20))
      return { idempotent, stopped, restarted: api.state().listeners, restored: api.monitor().length }
    })
    assert.equal(lifecycle.idempotent, 1); assert.equal(lifecycle.stopped, 0); assert.equal(lifecycle.restarted, 1)
    assert.ok(lifecycle.restored >= 4)
    const repair = await page.evaluate(async () => {
      const api = window.generationRunsTest
      api.selectProject(); api.publish('repair-video', { status: 'done', outputs: [
        { filename: 'generated.mp4', subfolder: 'video', type: 'output', nodeId: '75', mediaType: 'image' },
      ] })
      api.seedMisclassifiedVideo('repair-video')
      const before = api.state()
      const preview = await api.import('repair-video')
      const afterPreview = api.state()
      api.failProbe(true)
      const failed = await api.import('repair-video', { previewOnly: false })
      const afterFailure = api.state()
      api.failProbe(false)
      const result = await api.import('repair-video', { previewOnly: false })
      const after = api.state()
      const repeat = await api.import('repair-video', { previewOnly: false })
      return { before, preview, afterPreview, failed, afterFailure, result, after, repeat, repeated: api.state() }
    })
    assert.equal(repair.preview.outputs[0].mediaType, 'video')
    assert.equal(repair.preview.repairableCount, 1); assert.equal(repair.preview.importableCount, 0)
    assert.deepEqual(repair.before, repair.afterPreview, 'repair preview is read-only')
    assert.equal(repair.failed.complete, false); assert.equal(repair.failed.acknowledged, false)
    assert.equal(repair.afterFailure.assets[0].type, 'image')
    assert.equal(repair.result.repairedCount, 1); assert.equal(repair.result.importedCount, 0)
    assert.equal(repair.result.complete, true)
    const asset = repair.after.assets[0]
    assert.equal(asset.id, repair.before.assets[0].id); assert.equal(asset.path, repair.before.assets[0].path)
    assert.equal(asset.type, 'video'); assert.equal(asset.duration, 5); assert.equal(asset.videoCodec, 'h264')
    assert.equal(repair.after.assets.length, 1); assert.equal(repair.repeated.assets.length, 1)
    assert.equal(repair.repeat.repairedCount, 0); assert.equal(repair.repeat.importedCount, 0)
    assert.ok(!repair.repeated.calls.slice(repair.before.calls.length).some(c => ['download', 'write-media'].includes(c.method)))
    pass('Legacy image-labeled MP4 repairs in place, preserves ID/path, retries safely and never redownloads')

    // Real, tiny MP4 generated in memory. No GPU, ComfyUI, network or user files.
    const mp4 = require('node:child_process').execFileSync(require('ffmpeg-static'), [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=24:d=1',
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1',
    ])
    const freshVideo = await page.evaluate(async data => {
      const api = window.generationRunsTest
      api.selectProject(); api.setVideoData(data)
      api.publish('fresh-video', { status: 'done', outputs: [
        { filename: 'fresh.mp4', subfolder: 'video', type: 'output', nodeId: '108', mediaType: 'image' },
      ] })
      const result = await api.import('fresh-video', { previewOnly: false })
      return { result, state: api.state() }
    }, 'data:video/mp4;base64,' + mp4.toString('base64'))
    assert.equal(freshVideo.result.complete, true)
    assert.equal(freshVideo.result.importedCount, 1)
    assert.equal(freshVideo.state.assets.length, 1)
    assert.equal(freshVideo.state.assets[0].type, 'video')
    assert.equal(freshVideo.state.assets[0].duration, 1)
    assert.match(freshVideo.state.assets[0].path, /^assets\/video\//)
    assert.equal(freshVideo.state.calls.filter(c => c.method === 'download-video' && c.payload === 'fresh.mp4').length, 1)
    pass('Fresh image-bucket MP4 downloads once as video and imports with real video duration')

    const oldPreload = await page.evaluate(() => {
      const api = window.generationRunsTest
      api.stop(); delete window.electronAPI.generationRuns
      api.start(); api.publishLegacy()
      return { state: api.state(), status: api.status() }
    })
    assert.equal(oldPreload.state.listeners, 0)
    assert.equal(oldPreload.status.live, true)
    assert.equal(oldPreload.status.jobs.length, 1)
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    pass('Global subscription is idempotent, cleans up and restores its snapshot without real service traffic')
    pass('An older preload without Runs leaves legacy generation status usable without unsafe fallback')
    const result = { success: true, groups, artifacts, serviceRequests: 0 }
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2))
    console.log('GENERATION_RUNS_BROWSER_RESULT ' + JSON.stringify(result))
  } catch (error) {
    console.error('Browser errors:', errors, 'Blocked:', blocked)
    await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
    console.error('Fixture artifacts:', artifacts)
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
