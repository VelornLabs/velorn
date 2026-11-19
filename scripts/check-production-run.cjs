// Production-memory smoke against the isolated reference-board fixture.
// Uses actual renderer MCP/store/persistence paths with synthetic media and
// RAM-only project IO. Never opens the native app or calls a model/export.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) {
  throw new Error('Production-run fixture requires loopback HTTP')
}
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-production-run-'))

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US', serviceWorkers: 'block' })
  await context.addInitScript(() => {
    window.fixtureMediaCalls = []
    for (const method of ['play', 'load']) {
      const original = HTMLMediaElement.prototype[method]
      HTMLMediaElement.prototype[method] = function (...args) {
        window.fixtureMediaCalls.push({ method, tag: this.tagName })
        return original.apply(this, args)
      }
    }
  })
  const page = await context.newPage(), groups = [], errors = [], blockedRequests = [], actions = []
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    const endpoint = /^\/(?:prompt|queue|interrupt|system_stats|history|upload|view|ws)(?:\/|$)/.test(url.pathname)
    if (url.origin === base.origin && !endpoint) return route.continue()
    blockedRequests.push(url.href)
    return route.abort()
  })
  await page.routeWebSocket(() => true, socket => socket.close())
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const wall = () => page.locator('.production-workspace')
  const snapshot = () => page.evaluate(() => window.storyboardTest.snapshot())
  const raw = () => page.evaluate(() => window.storyboardTest.rawStoryboard())
  const timelines = () => page.evaluate(() => window.storyboardTest.timelineSnapshot())
  const rpc = async (action, payload = {}) => {
    actions.push(action)
    return page.evaluate(({ action, payload }) => window.storyboardTest.runMcpAction(action, payload), { action, payload })
  }
  const inspect = () => rpc('get_production_run')
  const edit = async payload => {
    const before = await snapshot(), beforeTimeline = await timelines()
    const preview = await rpc('edit_production_run', { ...payload, previewOnly: true })
    assert.equal(preview.previewOnly, true)
    assert.ok(preview.suggestedApplyPayload?.previewToken, 'Production edits require a one-use preview token')
    assert.ok(preview.suggestedApplyPayload?.expectedContext, 'Production edits require their inspected context')
    assert.deepEqual(await snapshot(), before, 'A production preview is non-mutating')
    assert.deepEqual(await timelines(), beforeTimeline)
    return rpc('edit_production_run', preview.suggestedApplyPayload)
  }
  const editorEdit = async (action, payload) => {
    const before = await timelines()
    const preview = await rpc(action, { ...payload, previewOnly: true })
    assert.equal(preview.previewOnly, true)
    assert.deepEqual(await timelines(), before, `${action} preview cannot modify timeline state`)
    // Some older native handlers are context guarded, while editing-parity
    // handlers additionally return one-use tokens. Preserve both contracts.
    return rpc(action, preview.suggestedApplyPayload || { ...payload, previewOnly: false })
  }
  const binding = (read, shotId, slot) => {
    const matches = read.inspection.bindings.filter(item => item.shotId === shotId && item.slot === slot)
    assert.equal(matches.length, 1, `One explicit ${slot} binding for ${shotId}`)
    return matches[0]
  }
  const safe = async () => {
    const state = await snapshot()
    assert.deepEqual(state.forbiddenCalls, [], 'No forbidden native work')
    assert.deepEqual(blockedRequests, [], 'No generation, cloud, ComfyUI or remote requests')
    assert.deepEqual(errors, [], 'No renderer exceptions')
    assert.deepEqual(await page.evaluate(() => window.fixtureMediaCalls), [], 'Reference board does not run media decoders')
    assert.equal(await page.locator('audio, video').count(), 0)
    assert.equal(await wall().locator('input, textarea, select, form, nav, [role="tab"], [role="tablist"], [contenteditable="true"]').count(), 0)
    assert.equal(await wall().getByRole('button').count(), 1, 'Expand/collapse is the only reference-board button')
    assert.equal(actions.some(action => /export|queue.*generation|download|install|generate/.test(action)), false,
      'This smoke never requests generation, downloads or export')
  }
  try {
    await page.goto(new URL('/tests/fixtures/storyboard.html', base).href)
    await page.waitForFunction(() => window.storyboardTest?.ready)
    await wall().locator('.pr-shot-card').nth(3).waitFor()
    const initial = await snapshot(), initialRaw = await raw(), initialTimelines = await timelines()
    const first = await inspect()
    assert.ok(first.inspection && first.presentation && first.context)
    assert.deepEqual(await snapshot(), initial, 'Inspection cannot create a production record or dirty a project')
    assert.deepEqual(await raw(), initialRaw)
    assert.deepEqual(await timelines(), initialTimelines)
    await safe()
    pass('A production read uses the real MCP dispatcher without creating records, dirtying the project or changing its timeline')

    const shotId = initial.board.shots[0].id
    await edit({ operation: 'update_run', patch: {
      notes: 'Synthetic approval: character and storyboard approved; keep the final editable.',
      nextAction: 'Review the normal Velorn timeline together; export only if requested.',
    } })
    await edit({ operation: 'record_attempt', shotId, attemptId: 'synthetic-browser-attempt-1', recipe: {
      model: 'Synthetic model — not submitted', workflow: 'synthetic-workflow-no-generation',
      inputAssetIds: ['reference-1'], referenceAssetIds: ['character-mara-front'], songAssetId: 'song-1',
      audioStartSeconds: 0, audioDurationSeconds: 2, generationDurationSeconds: 3,
      width: 640, height: 360, fps: 24, seed: 17, prompt: 'Synthetic production ledger fixture only.',
    } })
    const planned = await inspect()
    assert.ok(planned.run.attempts.some(item => item.attemptId === 'synthetic-browser-attempt-1' && item.state === 'planned'))
    assert.deepEqual(await timelines(), initialTimelines, 'Recipe and next-action edits are not timeline operations')
    await safe()
    pass('Notes, next action and an exact synthetic generation recipe persist as metadata, with no job submission or timeline edits')

    await edit({ operation: 'update_attempt', attemptId: 'synthetic-browser-attempt-1', patch: {
      state: 'uncertain', remoteJobId: 'synthetic-unverified-job-1',
      note: 'Connection interrupted in this synthetic record. Inspect the existing job before any retry.',
    } })
    const uncertain = await inspect()
    assert.ok(uncertain.run.attempts.some(item => item.attemptId === 'synthetic-browser-attempt-1'
      && item.state === 'uncertain' && item.remoteJobId === 'synthetic-unverified-job-1'))
    assert.ok(uncertain.inspection.issues.some(item => item.code === 'reconcile-job-before-retry'))
    assert.equal(uncertain.inspection.summary.statesVerified, false)
    assert.equal(uncertain.inspection.summary.exportRequired, false)
    assert.deepEqual(await timelines(), initialTimelines)
    await safe()
    pass('An uncertain attempt is inspectable and never implicitly resubmitted, regenerated or exported')

    const created = await editorEdit('create_timeline', { name: 'Synthetic production-link review', fps: 24,
      durationSeconds: 8, switchToTimeline: true })
    const timelineId = created.timeline.id
    await editorEdit('add_asset_to_timeline', { assetId: 'reference-1', createTrack: true,
      trackName: 'Synthetic shot binding', startSeconds: 0, durationSeconds: 2 })
    const populated = await timelines()
    const clip = populated.active.clips.find(item => item.assetId === 'reference-1')
    assert.ok(clip)
    await edit({ operation: 'bind_shot', shotId, slot: 'animatic', timelineId, clipId: clip.id })
    const linked = binding(await inspect(), shotId, 'animatic')
    assert.equal(linked.timelineId, timelineId)
    assert.equal(linked.clipId, clip.id)
    assert.equal(linked.current.duration, 2)
    const boundRun = (await raw()).productionRun
    // This is the same native trim planner used by editor authoring; it models
    // a human changing the timeline after an assistant recorded the binding.
    await editorEdit('trim_clips', { clipId: clip.id, durationSeconds: 1.5 })
    const edited = await timelines(), afterTrim = binding(await inspect(), shotId, 'animatic')
    assert.equal(edited.active.clips.find(item => item.id === clip.id).duration, 1.5)
    assert.equal(afterTrim.current.duration, 1.5, 'Inspection must use the live edited clip, not its saved project copy')
    assert.equal(afterTrim.status, 'changed')
    assert.notDeepEqual(afterTrim, linked, 'Inspection must reveal the change after binding')
    assert.deepEqual((await raw()).productionRun, boundRun, 'Reading a human edit never rewrites its binding baseline')
    assert.deepEqual(await timelines(), edited, 'Production inspection leaves the human trim untouched')
    await safe()
    pass('Explicit shot links inspect live timeline duration after a native human-style trim without restoring stale timing')

    const duplicate = await editorEdit('duplicate_timeline', { timelineId,
      name: 'Synthetic duplicate with identical clip IDs', switchToTimeline: true })
    const duplicateId = duplicate.timeline.id
    assert.notEqual(duplicateId, timelineId)
    const duplicated = await timelines()
    assert.equal(duplicated.active.clips.find(item => item.id === clip.id).duration, 1.5,
      'Normal timeline duplication intentionally preserves clip IDs')
    // A duplicate is not silently considered the original shot's new target.
    // Give a second explicit storyboard shot the same approved still so that
    // two legitimate bindings can exercise identical clip IDs across timelines.
    const secondShotId = initial.board.shots[1].id
    await editorEdit('edit_storyboard', { operation: 'update_shot', shotId: secondShotId,
      patch: { storyboardAssetId: 'reference-1' } })
    await edit({ operation: 'bind_shot', shotId: secondShotId, slot: 'animatic', timelineId: duplicateId, clipId: clip.id })
    await editorEdit('trim_clips', { clipId: clip.id, durationSeconds: 1 })
    const beforeInactiveRead = await snapshot(), beforeInactiveTimelines = await timelines()
    const duplicateRead = await inspect()
    const inactive = binding(duplicateRead, shotId, 'animatic'), active = binding(duplicateRead, secondShotId, 'animatic')
    assert.equal(inactive.timelineId, timelineId); assert.equal(inactive.current.duration, 1.5)
    assert.equal(active.timelineId, duplicateId); assert.equal(active.current.duration, 1)
    assert.deepEqual(await snapshot(), beforeInactiveRead)
    assert.deepEqual(await timelines(), beforeInactiveTimelines,
      'Inactive timeline inspection must not switch timelines, save, or reload a document')
    await safe()
    pass('Identical clip IDs on separate timelines remain distinct; inactive inspection never navigates or overwrites live changes')

    const retakeShot = await editorEdit('edit_storyboard', { operation: 'add_shot', shot: {
      title: 'Synthetic retake review', durationSeconds: 0.5, storyboardAssetId: 'reference-3',
    } })
    const retakeShotId = retakeShot.shotId
    const originalTake = await editorEdit('edit_storyboard', { operation: 'attach_take', shotId: retakeShotId,
      assetId: 'take-1', label: 'Approved synthetic original' })
    const replacementTake = await editorEdit('edit_storyboard', { operation: 'attach_take', shotId: retakeShotId,
      assetId: 'take-2', label: 'Approved synthetic retake' })
    await editorEdit('edit_storyboard', { operation: 'select_take', shotId: retakeShotId, takeId: originalTake.takeId })
    const finalTimeline = await editorEdit('create_timeline', { name: 'Synthetic final retake review', fps: 24,
      durationSeconds: 2, switchToTimeline: true })
    await editorEdit('add_asset_to_timeline', { assetId: 'take-1', createTrack: true,
      trackName: 'Synthetic final performance', startSeconds: 0.5, sourceInSeconds: 0.125, durationSeconds: 0.5 })
    const retakeClip = (await timelines()).active.clips.find(item => item.assetId === 'take-1')
    assert.ok(retakeClip)
    assert.equal(retakeClip.duration, 0.5)
    await editorEdit('set_clip_style', { clipId: retakeClip.id, scaleX: 117, scaleY: 117, rotation: 3 })
    await editorEdit('set_clip_keyframes', { clipId: retakeClip.id, keyframes: [
      { property: 'positionX', timeSeconds: 0, value: -12, easing: 'linear' },
      { property: 'positionX', timeSeconds: 0.375, value: 19, easing: 'linear' },
    ] })
    await edit({ operation: 'bind_shot', shotId: retakeShotId, slot: 'final',
      timelineId: finalTimeline.timeline.id, clipId: retakeClip.id })
    const beforeRetake = JSON.parse((await snapshot()).timeline).clips.find(item => item.id === retakeClip.id)
    const beforeRetakeRead = await inspect(), retakeTarget = binding(beforeRetakeRead, retakeShotId, 'final')
    assert.equal(beforeRetakeRead.activeTimelineId, finalTimeline.timeline.id)
    assert.equal(retakeTarget.timelineId, beforeRetakeRead.activeTimelineId)
    assert.equal(retakeTarget.status, 'linked')
    assert.equal(retakeTarget.current.sourceAssetId, 'take-1')
    assert.deepEqual(beforeRetake.keyframes.positionX.map(item => item.value), [-12, 19])
    await editorEdit('replace_clip_with_asset', { clipId: retakeTarget.clipId, assetId: 'take-2',
      sourceInSeconds: retakeTarget.current.trimStart ?? 0 })
    const afterRetake = JSON.parse((await snapshot()).timeline).clips.find(item => item.id === retakeClip.id)
    assert.equal(afterRetake.assetId, 'take-2')
    for (const field of ['id', 'name', 'trackId', 'startTime', 'duration', 'trimStart', 'trimEnd', 'transform', 'keyframes', 'effects', 'adjustments']) {
      assert.deepEqual(afterRetake[field], beforeRetake[field], `Smart Replace preserves authored ${field}`)
    }
    const changedRetake = binding(await inspect(), retakeShotId, 'final')
    assert.equal(changedRetake.status, 'changed', 'Replacing media must not silently refresh the production baseline')
    assert.equal(changedRetake.baseline.sourceAssetId, 'take-1')
    assert.equal(changedRetake.current.sourceAssetId, 'take-2')
    await editorEdit('edit_storyboard', { operation: 'select_take', shotId: retakeShotId, takeId: replacementTake.takeId })
    await edit({ operation: 'bind_shot', shotId: retakeShotId, slot: 'final',
      timelineId: finalTimeline.timeline.id, clipId: retakeClip.id, rebind: true })
    const rebound = binding(await inspect(), retakeShotId, 'final')
    assert.equal(rebound.status, 'linked')
    assert.equal(rebound.baseline.sourceAssetId, 'take-2')
    assert.deepEqual(JSON.parse((await snapshot()).timeline).clips.find(item => item.id === retakeClip.id), afterRetake,
      'Selecting a take and explicit rebinding do not rewrite the edited clip')
    const retainedShot = (await raw()).shots.find(item => item.id === retakeShotId)
    assert.deepEqual(retainedShot.takes.map(item => item.assetId), ['take-1', 'take-2'])
    assert.ok((await snapshot()).assetIds.includes('take-1'), 'The previous asset remains recoverable')
    await editorEdit('switch_timeline', { timelineId: duplicateId })
    await safe()
    pass('An explicit native Smart Replace retake preserves the clip edit, transform and keyframes; review and explicit rebind restore the link without deleting the old take')

    const beforeSave = await raw(), beforeSaveRun = await inspect(), beforeSaveTimeline = await timelines()
    assert.equal(await page.evaluate(() => window.storyboardTest.save()), true)
    const saved = await page.evaluate(() => window.storyboardTest.saved())
    assert.deepEqual(saved.storyboard.productionRun, beforeSave.productionRun)
    assert.doesNotMatch(JSON.stringify(saved.storyboard.productionRun), /data:|blob:|\/fixture-only\//,
      'Production records retain portable IDs rather than runtime media URLs or machine paths')
    await edit({ operation: 'update_run', patch: { nextAction: 'Unsaved change that should be discarded on reopen.' } })
    assert.ok(await page.evaluate(() => window.storyboardTest.reopen()))
    const reopened = await inspect(), reopenedTimeline = await timelines()
    assert.deepEqual(reopened.run, beforeSaveRun.run, 'A new assistant can read the exact saved production memory')
    assert.deepEqual((await raw()).productionRun, beforeSave.productionRun)
    assert.equal(reopenedTimeline.currentTimelineId, beforeSaveTimeline.currentTimelineId)
    assert.deepEqual(reopenedTimeline.active.clips, beforeSaveTimeline.active.clips)
    assert.equal(binding(reopened, shotId, 'animatic').current.duration, 1.5)
    assert.equal(binding(reopened, secondShotId, 'animatic').current.duration, 1)
    assert.equal(binding(reopened, retakeShotId, 'final').status, 'linked')
    assert.equal(binding(reopened, retakeShotId, 'final').current.sourceAssetId, 'take-2')
    assert.equal((await snapshot()).historyCount, 0)
    await safe()
    pass('Real RAM-only project save/open retains exact recipes, uncertainty, next action and shot links alongside manual timeline edits')

    const beforeUi = await snapshot(), beforeUiTimeline = await timelines()
    await wall().locator('.pr-shot-card').first().click()
    for (const key of ['Enter', 'Space', 'ArrowRight', 'Delete', 'Backspace']) await page.keyboard.press(key)
    await page.getByRole('button', { name: 'Expand board', exact: true }).click()
    await page.getByRole('button', { name: 'Collapse board', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    assert.deepEqual(await snapshot(), beforeUi)
    assert.deepEqual(await timelines(), beforeUiTimeline)
    await safe()
    await wall().locator('.pr-board-scroll').evaluateAll(nodes => nodes.forEach(node => { node.scrollTop = 0 }))
    await page.screenshot({ path: path.join(output, 'production-run-reference-board.png'), fullPage: true, animations: 'disabled' })
    await wall().locator('.pr-shot-card').last().scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, 'production-run-retake-shot.png'), fullPage: true, animations: 'disabled' })
    pass('Production records add no forms, selectable cards, approval controls, media player or export requirement to the visual board')

    const result = { success: true, groups, output, errors, blockedRequests, actions,
      inspection: await inspect(), timeline: await timelines(), snapshot: await snapshot() }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    console.log('PRODUCTION_RUN_RESULT ' + JSON.stringify({ success: true, groups, output }))
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, groups, errors, blockedRequests,
      actions, snapshot: await snapshot().catch(() => null), body: await page.locator('body').innerText().catch(() => '') }, null, 2))
    console.error(`Production-run artifacts: ${output}`)
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
