// Isolated read-only reference wall. Real renderer/MCP/project services,
// synthetic media and RAM-only IO; retained command name for the lab runner.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Reference fixture requires loopback HTTP')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-reference-wall-'))

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US', serviceWorkers: 'block' })
  await context.addInitScript(() => {
    window.fixtureMediaCalls = []
    for (const method of ['play', 'load']) {
      const original = HTMLMediaElement.prototype[method]
      HTMLMediaElement.prototype[method] = function (...args) {
        window.fixtureMediaCalls.push({ method, tag: this.tagName }); return original.apply(this, args)
      }
    }
  })
  const page = await context.newPage(), groups = [], errors = [], blockedRequests = []
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    const endpoint = /^\/(?:prompt|queue|interrupt|system_stats|history|upload|view|ws)(?:\/|$)/.test(url.pathname)
    if (url.origin === base.origin && !endpoint) return route.continue()
    blockedRequests.push(url.href); return route.abort()
  })
  await page.routeWebSocket(() => true, socket => socket.close())
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const wall = () => page.locator('.production-workspace')
  const cards = () => wall().locator('.pr-shot-card')
  const shot = id => wall().locator(`.pr-shot-card[data-shot-id="${id}"]`)
  const button = name => page.getByRole('button', { name, exact: true })
  const snapshot = () => page.evaluate(() => window.storyboardTest.snapshot())
  const raw = () => page.evaluate(() => window.storyboardTest.rawStoryboard())
  const rpc = (action, payload = {}) => page.evaluate(({ action, payload }) => window.storyboardTest.runMcpAction(action, payload), { action, payload })
  const apply = async request => {
    const preview = await rpc('edit_storyboard', request)
    assert.equal(preview.previewOnly, true)
    assert.ok(preview.suggestedApplyPayload.previewToken && preview.suggestedApplyPayload.expectedContext)
    return rpc('edit_storyboard', preview.suggestedApplyPayload)
  }
  const rejected = payload => page.evaluate(async payload => {
    try { return { result: await window.storyboardTest.runMcpAction('edit_storyboard', payload) } }
    catch (error) { return { error: error.message } }
  }, payload)
  const labels = () => cards().evaluateAll(nodes => nodes.map(node => ({ shotId: node.dataset.shotId,
    label: node.querySelector('.pr-shot-label')?.textContent.trim() || node.dataset.shotLabel })))
  const expectedLabels = inspected => inspected.presentation.shots.map(({ shotId, label }) => ({ shotId, label }))
  const capture = async name => {
    await wall().locator('.pr-board-scroll').evaluateAll(nodes => nodes.forEach(node => { node.scrollTop = 0 }))
    return page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
  }
  const safe = async () => {
    assert.deepEqual((await snapshot()).forbiddenCalls, [])
    assert.deepEqual(blockedRequests, [], 'No external service/model/generation requests')
    assert.deepEqual(errors, [], 'No renderer exceptions')
    assert.deepEqual(await page.evaluate(() => window.fixtureMediaCalls), [], 'The wall never starts or loads a media decoder')
    assert.equal(await page.locator('audio, video').count(), 0)
    assert.equal(await wall().locator('input, textarea, select, form, nav, [role="tab"], [role="tablist"], [contenteditable="true"]').count(), 0)
    assert.equal(await wall().getByRole('button').count(), 1, 'Expand/collapse is the only in-component button')
  }
  try {
    await page.goto(new URL('/tests/fixtures/storyboard.html', base).href)
    await page.waitForFunction(() => window.storyboardTest?.ready)
    await cards().nth(3).waitFor()
    const initial = await snapshot(), initialRaw = await raw(), inspected = await rpc('get_storyboard')
    assert.equal(initial.board.shots.length, 4)
    assert.equal(initial.board.shots.reduce((sum, item) => sum + item.durationSeconds, 0), 45)
    assert.equal(initial.historyCount, 0); assert.equal(initial.dirty, false)
    assert.deepEqual((await labels()).map(item => item.label), ['Shot 01', 'Shot 02', 'Shot 03', 'Shot 04'])
    assert.deepEqual(await labels(), expectedLabels(inspected))
    for (const section of ['Characters', 'Locations', 'References', 'Storyboard']) {
      const region = wall().getByRole('region', { name: section, exact: true })
      await region.waitFor()
      assert.equal(await region.evaluate(node => Boolean(node.closest('.pr-board-scroll'))), true)
    }
    await safe(); await capture('01-read-only-reference-wall')
    pass('A synthetic 45-second board shows characters, locations, other references and labeled shot stills together in one scroll page')

    await page.evaluate(() => {
      window.fixtureEscapedKeys = []
      document.addEventListener('keydown', event => window.fixtureEscapedKeys.push(event.key))
    })
    await cards().first().click()
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.production-workspace'))), true)
    for (const key of ['Enter', 'Space', 'ArrowRight', 'ArrowLeft', 'Delete', 'Backspace', 'Control+z', 'Control+Shift+z']) await page.keyboard.press(key)
    assert.deepEqual(await page.evaluate(() => window.fixtureEscapedKeys), [], 'Focused board keys cannot reach hidden editor/transport shortcuts')
    assert.deepEqual(await raw(), initialRaw)
    assert.equal((await snapshot()).historyCount, 0); assert.equal((await snapshot()).dirty, false)
    assert.equal((await snapshot()).timeline, initial.timeline)
    assert.equal(await cards().locator('button, input, [role="button"], [tabindex="0"]').count(), 0)
    await button('Expand board').click(); await button('Collapse board').waitFor()
    assert.equal(await wall().getAttribute('role'), 'dialog'); assert.equal(await wall().getAttribute('aria-modal'), 'true')
    for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key)
      assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.production-workspace'))), true,
        'Expanded board focus cannot reach obscured editor or fixture controls')
      assert.equal(await page.evaluate(() => document.activeElement.matches('button, .pr-board-scroll')), true)
    }
    await page.keyboard.press('Escape')
    assert.equal(await button('Expand board').evaluate(node => document.activeElement === node), true)
    assert.deepEqual(await raw(), initialRaw)
    pass('Clicks and keyboard cannot edit, select or approve cards; Expand/Escape only changes the view and restores focus')

    const firstId = initial.board.shots[0].id, beforePreview = await snapshot()
    const preview = await rpc('edit_storyboard', { operation: 'update_shot', shotId: firstId,
      patch: { title: 'The assistant updated this visible shot', description: 'The same project data drives this read-only wall.' } })
    assert.deepEqual((await snapshot()).board, beforePreview.board)
    await rpc('edit_storyboard', preview.suggestedApplyPayload)
    await shot(firstId).getByText('The assistant updated this visible shot', { exact: true }).waitFor()
    assert.deepEqual(await labels(), expectedLabels(await rpc('get_storyboard')))
    await rpc('undo', { scope: 'project', previewOnly: false }); assert.deepEqual((await snapshot()).board, beforePreview.board)
    await rpc('redo', { scope: 'project', previewOnly: false })
    await shot(firstId).getByText('The assistant updated this visible shot', { exact: true }).waitFor()
    assert.match((await rejected(preview.suggestedApplyPayload)).error || '', /stale|preview|used|changed/i)
    pass('Real MCP preview/apply and normal project Undo/Redo reactively update the same visible read-only board')

    await apply({ operation: 'add_cast_member', member: { name: 'Mara', role: 'Second named character', referenceAssetIds: ['character-mara-profile'] } })
    await apply({ operation: 'add_location', location: { name: 'Signal city', referenceAssetIds: ['reference-3'] } })
    await page.evaluate(() => {
      window.storyboardTest.setAssetName('character-mara-front', 'Mara reference')
      window.storyboardTest.setAssetName('character-mara-profile', 'Mara reference')
    })
    const duplicateRaw = await raw(), duplicates = (await rpc('get_storyboard')).presentation
    for (const [collection, className, key, name] of [['cast', '.pr-character', 'memberId', 'Mara'], ['locations', '.pr-location', 'locationId', 'Signal city']]) {
      const entries = duplicates[collection].filter(item => item.name === name)
      assert.equal(entries.length, 2); assert.equal(new Set(entries.map(item => item.displayLabel)).size, 2)
      for (const entry of entries) {
        assert.ok(entry.displayLabel.startsWith(`${name} · `))
        assert.equal(await wall().locator(`${className}[data-entity-id="${entry[key]}"] h3`).innerText(), entry.displayLabel)
      }
    }
    const repeatedReferences = duplicates.cast.flatMap(member => member.references)
    const referenceLabels = new Map(repeatedReferences.map(reference => [reference.assetId, reference.displayLabel]))
    assert.equal(new Set(referenceLabels.values()).size, 2)
    for (const [id, label] of referenceLabels) {
      const captions = await wall().locator(`.pr-reference-card[data-asset-id="${id}"] figcaption`).allTextContents()
      assert.ok(captions.length > 0 && captions.every(caption => caption === label))
    }
    assert.deepEqual((await rpc('get_production_guide')).presentation, duplicates)
    assert.deepEqual(await raw(), duplicateRaw, 'Display-only disambiguation does not rewrite authored names')
    await page.evaluate(() => { window.storyboardTest.restoreAsset('character-mara-front'); window.storyboardTest.restoreAsset('character-mara-profile') })
    await safe()
    pass('Duplicate character, location and reference names receive matching unambiguous UI/MCP labels while authored names remain intact')

    const stableLabels = new Map((await labels()).map(item => [item.shotId, item.label]))
    const reverse = (await snapshot()).board.shots.map(item => item.id).reverse()
    await apply({ operation: 'reorder_shots', shotIds: reverse })
    assert.deepEqual((await labels()).map(item => item.shotId), reverse)
    for (const item of await labels()) assert.equal(item.label, stableLabels.get(item.shotId))
    await apply({ operation: 'remove_shot', shotId: initial.board.shots[3].id })
    const added = await apply({ operation: 'add_shot', shot: { title: 'The next beginning', description: 'A new still after the original sequence.',
      durationSeconds: 12, storyboardAssetId: 'reference-4', referenceAssetIds: ['reference-4'] } })
    await shot(added.shotId).waitFor()
    assert.equal((await labels()).find(item => item.shotId === added.shotId).label, 'Shot 05', 'Deleted highest label is not reused')
    for (const item of await labels()) if (stableLabels.has(item.shotId)) assert.equal(item.label, stableLabels.get(item.shotId))
    assert.deepEqual(await labels(), expectedLabels(await rpc('get_storyboard')))
    assert.equal((await snapshot()).timeline, initial.timeline)
    pass('Human-readable labels agree with MCP, stay attached to stable IDs through reorder/removal, and never reuse deleted numbers')

    const stillBefore = await shot(firstId).locator('img').getAttribute('src')
    const alternative = await apply({ operation: 'attach_take', shotId: firstId, assetId: 'reference-3', label: 'Alternative image take' })
    await apply({ operation: 'select_take', shotId: firstId, takeId: alternative.takeId })
    assert.equal(await shot(firstId).locator('img').getAttribute('src'), stillBefore)
    const castId = (await snapshot()).board.production.cast[0].id
    await page.evaluate(() => window.storyboardTest.setVideoPosterPresent('take-2', false))
    await apply({ operation: 'update_cast_member', memberId: castId,
      patch: { referenceAssetIds: ['character-mara-front', 'take-1', 'take-2'] } })
    const posterReference = wall().locator(`.pr-character[data-entity-id="${castId}"] .pr-reference-card[data-asset-id="take-1"]`)
    const noPosterReference = wall().locator(`.pr-character[data-entity-id="${castId}"] .pr-reference-card[data-asset-id="take-2"]`)
    await posterReference.locator('img').waitFor()
    assert.match(await posterReference.locator('img').getAttribute('src'), /^data:image\//)
    assert.equal(await noPosterReference.locator('img').count(), 0)
    assert.ok(await wall().locator('img').evaluateAll(nodes => nodes.every(node => !node.src.startsWith('data:video/'))))
    await safe(); await capture('02-video-reference-posters')
    pass('Explicit storyboard images stay fixed when takes change; video references use only existing posters/placeholders without decoders')

    const beforeMissing = await raw()
    await page.evaluate(() => { window.storyboardTest.removeAsset('reference-1'); window.storyboardTest.removeAsset('character-mara-front') })
    assert.equal((await rpc('get_storyboard')).presentation.shots.find(item => item.shotId === firstId).stillMissing, true)
    assert.equal(await shot(firstId).locator('img').count(), 0, 'Missing explicit still cannot silently switch to an alternate image take')
    assert.deepEqual(await raw(), beforeMissing); await capture('03-missing-reference')
    await page.evaluate(() => { window.storyboardTest.restoreAsset('reference-1'); window.storyboardTest.restoreAsset('character-mara-front') })
    await shot(firstId).locator('img').waitFor()
    assert.equal(await shot(firstId).locator('img').getAttribute('src'), stillBefore)
    await page.evaluate(() => window.storyboardTest.setBrokenImagePreview('reference-1', true))
    await shot(firstId).locator('img').waitFor({ state: 'detached' })
    await page.evaluate(() => window.storyboardTest.setBrokenImagePreview('reference-1', false))
    await shot(firstId).locator('img').waitFor()
    assert.equal(await shot(firstId).locator('img').getAttribute('src'), stillBefore)
    assert.deepEqual(await raw(), beforeMissing)
    pass('Missing/broken media stays explicit without rewriting references; restoring the same asset ID relinks the visible still')

    const beforeSave = await snapshot(), beforeSaveLabels = await labels()
    assert.equal(await page.evaluate(() => window.storyboardTest.save()), true)
    const saved = await page.evaluate(() => window.storyboardTest.saved())
    assert.deepEqual(saved.storyboard, beforeSave.board)
    assert.doesNotMatch(JSON.stringify(saved.storyboard), /data:|blob:|\/fixture-only\//)
    await apply({ operation: 'update_board', patch: { title: 'Temporary unsaved board title' } })
    assert.ok(await page.evaluate(() => window.storyboardTest.reopen()))
    assert.deepEqual((await snapshot()).board, beforeSave.board); assert.deepEqual(await labels(), beforeSaveLabels)
    assert.equal((await snapshot()).historyCount, 0)
    pass('Real project save/open preserves labels, explicit still IDs and existing production data through portable RAM-only serialization')

    const legacy = await raw(); delete legacy.nextShotNumber
    for (const item of legacy.shots) delete item.label
    await page.evaluate(board => { window.storyboardTest.setRawStoryboard(board); window.storyboardTest.markClean() }, legacy)
    const legacyLabels = expectedLabels(await rpc('get_storyboard'))
    assert.deepEqual(await labels(), legacyLabels); assert.deepEqual(await raw(), legacy)
    assert.equal((await snapshot()).dirty, false, 'Rendering and MCP inspection cannot migrate a legacy board by side effect')
    const legacyReorder = await rpc('edit_storyboard', { operation: 'reorder_shots', shotIds: legacy.shots.map(item => item.id).reverse() })
    assert.deepEqual(await raw(), legacy); await rpc('edit_storyboard', legacyReorder.suggestedApplyPayload)
    const legacyMap = new Map(legacyLabels.map(item => [item.shotId, item.label]))
    for (const item of await labels()) assert.equal(item.label, legacyMap.get(item.shotId))
    assert.ok((await raw()).shots.every(item => item.label) && (await raw()).nextShotNumber > 0)
    pass('Legacy labels are computed read-only; the first meaningful edit materializes those same labels before reordering')

    const stale = await rpc('edit_storyboard', { operation: 'update_board', patch: { title: 'Wrong project write' } })
    await page.evaluate(() => window.storyboardTest.switchProject())
    await cards().first().waitFor({ state: 'detached' })
    assert.equal((await snapshot()).board.shots.length, 0)
    assert.match((await rejected(stale.suggestedApplyPayload)).error || '', /stale|preview|changed|project/i)
    await apply({ operation: 'update_board', patch: { referenceAssetIds: ['signal-prop'] } })
    await wall().getByRole('region', { name: 'References', exact: true }).waitFor()
    assert.equal(await cards().count(), 0, 'A visual-reference conversation can start before any shots or production wizard')
    assert.equal((await snapshot()).board.production, undefined)
    await safe()
    await page.evaluate(() => window.storyboardTest.setNoProject())
    assert.equal(await cards().count(), 0); await wall().getByText(/open a project/i).waitFor()
    await page.evaluate(() => window.storyboardTest.reset())
    const future = { ...(await raw()), production: { version: 99, futureReferences: ['must stay intact'] } }
    await page.evaluate(board => window.storyboardTest.setRawStoryboard(board), future)
    await wall().getByRole('alert').waitFor(); assert.deepEqual(await raw(), future)
    assert.equal(await wall().locator('input, form, select, textarea').count(), 0)
    await page.evaluate(() => window.storyboardTest.reset())
    pass('Empty, closed, switched and future-schema projects stay read-only; cross-project writes are rejected and unknown data is preserved')

    for (const width of [1440, 1100, 900, 640, 480]) {
      await page.setViewportSize({ width, height: 1100 })
      const layout = await wall().evaluate(node => ({ page: document.documentElement.scrollWidth, width: innerWidth,
        regions: [node, node.querySelector('.pr-board-scroll')].filter(Boolean).map(region => ({ client: region.clientWidth, scroll: region.scrollWidth })) }))
      assert.ok(layout.page <= width + 1 && layout.regions.every(region => region.scroll <= region.client + 1), JSON.stringify(layout))
      await capture(`04-layout-${width}`)
    }
    await page.setViewportSize({ width: 1100, height: 700 })
    await page.evaluate(() => window.storyboardTest.setPanelHeight(320))
    assert.equal(await wall().evaluate(node => node.getBoundingClientRect().height), 320)
    await cards().last().scrollIntoViewIfNeeded(); await button('Expand board').click()
    assert.ok(await wall().evaluate(node => node.getBoundingClientRect().height > 320))
    await page.keyboard.press('Escape')
    assert.equal(await wall().evaluate(node => node.getBoundingClientRect().height), 320)
    assert.equal(await button('Expand board').evaluate(node => document.activeElement === node), true)
    await capture('04-bottom-panel-320'); await page.evaluate(() => window.storyboardTest.setPanelHeight(null))
    pass('The single-page wall fits five widths and a scrolling 320px Editor panel; expansion restores size and keyboard focus')

    const beforeAnimaticBoard = await raw()
    const beforeAnimatic = await page.evaluate(() => window.storyboardTest.timelineSnapshot())
    const previewApplyTimeline = async (action, payload) => {
      const before = await page.evaluate(() => window.storyboardTest.timelineSnapshot())
      const plan = await rpc(action, { ...payload, previewOnly: true })
      assert.equal(plan.previewOnly, true)
      assert.deepEqual(await page.evaluate(() => window.storyboardTest.timelineSnapshot()), before, `${action} preview is non-mutating`)
      // These inherited renderer handlers expose plan-only preview rather than
      // Storyboard's one-use token protocol. Apply the same inspected request.
      return rpc(action, plan.suggestedApplyPayload || { ...payload, previewOnly: false })
    }
    const checkpoint = await previewApplyTimeline('create_project_checkpoint', { label: 'Before synthetic reference animatic' })
    assert.ok(checkpoint.checkpointId)
    const created = await previewApplyTimeline('create_timeline', { name: 'Signal — Animatic', fps: 24,
      durationSeconds: 45, switchToTimeline: true })
    assert.ok(created.timeline.id && created.timeline.id !== beforeAnimatic.currentTimelineId)
    await previewApplyTimeline('add_assets_to_timeline', { assets: [10, 12, 11, 12].map((durationSeconds, index) => ({
      assetId: `reference-${index + 1}`, durationSeconds })), startSeconds: 0, layout: 'sequential', trackStrategy: 'singleTrack',
      createTrack: true, trackName: 'Animatic frames' })
    await previewApplyTimeline('add_asset_to_timeline', { assetId: 'song-1', createTrack: true, trackName: 'Song',
      startSeconds: 0, sourceInSeconds: 0, durationSeconds: 45 })
    const animatic = await page.evaluate(() => window.storyboardTest.timelineSnapshot())
    assert.equal(animatic.timelines.length, beforeAnimatic.timelines.length + 1)
    assert.equal(animatic.currentTimelineId, created.timeline.id)
    const imageClips = animatic.active.clips.filter(clip => clip.type === 'image').sort((a, b) => a.startTime - b.startTime)
    const audioClips = animatic.active.clips.filter(clip => clip.type === 'audio')
    assert.equal(imageClips.length, 4); assert.equal(audioClips.length, 1)
    assert.deepEqual(imageClips.map(clip => [clip.startTime, clip.duration]), [[0, 10], [10, 12], [22, 11], [33, 12]])
    assert.equal(audioClips[0].assetId, 'song-1'); assert.equal(audioClips[0].startTime, 0)
    assert.equal(audioClips[0].duration, 45); assert.equal(audioClips[0].trimStart, 0)
    assert.equal(Math.max(...animatic.active.clips.map(clip => clip.startTime + clip.duration)), 45)
    assert.deepEqual(await raw(), beforeAnimaticBoard, 'Explicit timeline assembly leaves the authored reference board intact')
    await previewApplyTimeline('switch_timeline', { timelineId: beforeAnimatic.currentTimelineId })
    const returned = await page.evaluate(() => window.storyboardTest.timelineSnapshot())
    assert.deepEqual(returned.active, beforeAnimatic.active, 'The original normal editor timeline remains intact')
    assert.equal(returned.timelines.find(item => item.id === created.timeline.id).clips.length, 5)
    await safe()
    fs.writeFileSync(path.join(output, 'explicit-animatic.json'), JSON.stringify({ checkpointId: checkpoint.checkpointId,
      before: beforeAnimatic, animatic, afterReturning: returned }, null, 2))
    await page.evaluate(() => window.storyboardTest.reset())
    pass('An explicit checkpointed MCP request builds a separate normal 45-second timeline from four stills and song audio, preserving the original timeline and board')

    await safe(); await page.reload(); await cards().nth(3).waitFor()
    assert.equal((await snapshot()).historyCount, 0); assert.equal((await snapshot()).dirty, false)
    await page.setViewportSize({ width: 1440, height: 1100 }); await capture('05-final-visual-demo')
    await page.setViewportSize({ width: 1440, height: 1800 }); await capture('05-final-visual-demo-tall'); await safe()
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, groups, output, errors, blockedRequests,
      mediaCalls: await page.evaluate(() => window.fixtureMediaCalls), snapshot: await snapshot() }, null, 2))
    console.log('REFERENCE_WALL_RESULT ' + JSON.stringify({ success: true, groups, output }))
  } catch (error) {
    await capture('failure').catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, blockedRequests,
      snapshot: await snapshot().catch(() => null), body: await page.locator('body').innerText().catch(() => '') }, null, 2))
    console.error(`Reference wall artifacts: ${output}`); throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
