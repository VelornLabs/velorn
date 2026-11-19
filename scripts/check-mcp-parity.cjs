// Public JSON-RPC -> renderer dispatcher -> real store -> snapshot. Temporary,
// isolated browser/Electron profile, no main app, cloud, GPU or user project I/O.
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs'), os = require('node:os'), { execFileSync } = require('node:child_process')
const { chromium, _electron } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const { createComfyStudioMcpServer } = require('../electron/mcpServer')
const parityTools = require('../electron/mcpParityTools.cjs')
const base = process.env.VELORN_TEST_URL || 'http://127.0.0.1:5198'
async function main() {
  const native = process.env.VELORN_TEST_ELECTRON === '1'
  const browser = native ? await _electron.launch({ executablePath: require('electron'),
    args: [path.resolve(__dirname, '../tests/fixtures/inspector-electron.cjs')], env: { ...process.env, VELORN_TEST_URL: base } })
    : await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  let server
  try {
    const page = native ? await browser.firstWindow() : await browser.newPage()
    if (native) await browser.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(base + '/tests/fixtures/mcp-parity.html')
    await page.waitForFunction(() => Boolean(window.parity))
    let actionId = 0
    const pending = new Map()
    server = createComfyStudioMcpServer({ port: 0, performAction: ({ action, payload }) => new Promise((resolve, reject) => {
      const id = `fixture-${++actionId}`
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${action}`)) }, 10000)
      pending.set(id, { resolve, reject, timeout })
      page.evaluate(request => window.parity.dispatchMcpRequest(request), { id, action, payload }).catch(error => {
        const request = pending.get(id)
        if (request) { clearTimeout(request.timeout); pending.delete(id); request.reject(error) }
      })
    }) })
    await page.exposeFunction('parityPublishSnapshot', snapshot => ({ success: server.updateSnapshot(snapshot) }))
    await page.exposeFunction('parityActionResult', response => {
      const request = pending.get(response.id)
      if (!request) return
      clearTimeout(request.timeout); pending.delete(response.id)
      // Model native IPC ordering: install the action's fresh snapshot before
      // exposing its completion. No per-RPC refresh can hide a broken bridge.
      try {
        if (response.snapshotError || !server.updateSnapshot(response.snapshot)) {
          throw new Error(response.snapshotError || 'No fresh editor snapshot was received.')
        }
      } catch (error) {
        request.reject(error)
        return
      }
      if (response.success === false) request.reject(new Error(response.error))
      else request.resolve(response.result || {})
    })
    async function waitForUiPublication(predicate) {
      const deadline = Date.now() + 5000
      while (!predicate(server.lastSnapshot)) {
        assert.ok(Date.now() < deadline, 'UI-driven state reached the throttled snapshot publisher')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    await page.evaluate(() => window.parity.startMcpBridge())
    await waitForUiPublication(snapshot => snapshot?.project?.name === 'Isolated parity fixture')
    await server.start()
    const url = `http://127.0.0.1:${server.server.address().port}/mcp`
    let id = 0
    async function rpc(method, params) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
      const result = await response.json(); assert.equal(result.error, undefined, JSON.stringify(result.error)); return result.result
    }
    async function call(name, args = {}, { error = false } = {}) {
      const result = await rpc('tools/call', { name, arguments: args })
      if (error) { assert.equal(result.isError, true, JSON.stringify(result)); return result.content[0].text }
      assert.notEqual(result.isError, true, result.content[0].text)
      return { ...JSON.parse(result.content[0].text), content: result.content }
    }
    const definitions = (await rpc('tools/list')).tools
    assert.equal(new Set(definitions.map(tool => tool.name)).size, definitions.length)
    const actions = await page.evaluate(() => window.parity.actions)
    for (const tool of parityTools.tools) assert.ok(actions.includes(tool.name), `Public tool has renderer handler: ${tool.name}`)
    console.log(`Public MCP catalog: ${definitions.length} tools; ${parityTools.tools.length} parity definitions mapped to real renderer handlers`)
    await page.evaluate(() => window.parity.prepareMemoryProjectStorage())
    await waitForUiPublication(snapshot => snapshot?.project === null)
    assert.equal((await call('get_project')).project, null)
    const newProject = await call('create_project', { name: 'Immediate readback', width: 1280, height: 720, fps: 24 })
    await call('create_project', newProject.suggestedApplyCall.arguments)
    assert.equal((await call('get_project')).project.name, 'Immediate readback', 'create completion publishes the new project immediately')
    assert.equal((await call('get_timeline')).id, 'created-timeline', 'new project passes the server no-project gate immediately')
    const importPlan = await call('import_asset_from_path', { path: '/synthetic/fixture-source.png', asSequence: false })
    const imported = await call('import_asset_from_path', importPlan.suggestedApplyCall.arguments)
    const importedId = imported.result.asset.id
    assert.equal((await call('get_assets')).assets[0].id, importedId, 'import completion publishes the asset immediately')
    assert.equal((await call('get_project')).assetCount, 1)
    const placement = await call('add_asset_to_timeline', { assetId: importedId, trackId: 'v', startSeconds: 0, durationSeconds: 2 })
    await call('add_asset_to_timeline', placement.suggestedApplyCall.arguments)
    assert.equal((await call('get_timeline')).clips[0].assetId, importedId, 'import can immediately feed another write')
    await page.evaluate(() => window.parity.reset())
    await waitForUiPublication(snapshot => snapshot?.project?.name === 'Isolated parity fixture')
    const snapshot = await page.evaluate(() => window.parity.buildMcpSnapshot())
    assert.equal(snapshot.schemaVersion, 2); assert.equal(snapshot.currentTimeline.inPoint, 1)
    assert.equal(snapshot.assets.find(asset => asset.id === 'audio').generatedMusic.backend, 'yue2')
    assert.equal(snapshot.currentTimeline.clips.find(clip => clip.id === 'audio-1').volumeEnvelope.points.length, 1)
    const inspected = await call('inspect_clip', { clipId: 'audio-1', includeImage: false })
    assert.equal(inspected.clip.volumeEnvelope.points.length, 1)
    assert.equal(inspected.asset.generatedMusic.backend, 'yue2')
    const plan = await call('set_clip_style', { clipIds: ['clip-0', 'clip-1'], opacity: 75 })
    assert.equal(plan.previewOnly, true); assert.ok(plan.suggestedApplyCall.arguments.previewToken)
    assert.ok(plan.suggestedApplyCall.arguments.expectedContext.session)
    assert.equal(await page.evaluate(() => window.parity.timeline.getState().clips[0].transform.opacity), 100)
    await call('set_clip_style', plan.suggestedApplyCall.arguments)
    assert.equal((await call('inspect_clip', { clipId: 'clip-0', includeImage: false })).clip.transform.opacity, 75)
    assert.deepEqual(await page.evaluate(() => window.parity.timeline.getState().clips.slice(0, 2).map(clip => clip.transform.opacity)), [75, 75])
    await call('undo', { previewOnly: false })
    assert.equal((await call('inspect_clip', { clipId: 'clip-0', includeImage: false })).clip.transform.opacity, 100)
    assert.deepEqual(await page.evaluate(() => window.parity.timeline.getState().clips.slice(0, 2).map(clip => clip.transform.opacity)), [100, 100])
    const stale = await call('set_clip_style', { clipId: 'clip-0', opacity: 60 })
    await page.evaluate(() => window.parity.timeline.getState().setInPoint(2))
    assert.match(await call('set_clip_style', stale.suggestedApplyCall.arguments, { error: true }), /changed|stale/i)
    assert.equal((await call('get_timeline')).inPoint, 2, 'rejected actions also refresh the inspection snapshot')
    await page.evaluate(() => window.parity.reset())
    await waitForUiPublication(snapshot => snapshot?.currentTimeline?.inPoint === 1)
    const audio = await call('set_clip_audio', { clipId: 'audio-1', gainDb: -4, audioEq: { enabled: true } })
    await call('set_clip_audio', audio.suggestedApplyCall.arguments)
    assert.equal((await call('inspect_clip_audio', { clipId: 'audio-1' })).result.clips[0].gainDb, -4)
    const priorHistory = await page.evaluate(() => window.parity.timeline.getState().history.length)
    const play = await call('control_transport', { operation: 'play', rate: 0.25 })
    await call('control_transport', play.suggestedApplyCall.arguments)
    assert.equal((await call('get_transport_state')).result.playbackRate, 0.25)
    await call('control_transport', { operation: 'pause', previewOnly: false })
    const beforeStep = (await call('get_transport_state')).result.playheadPosition
    await call('control_transport', { operation: 'step', frames: 2, previewOnly: false })
    assert.equal((await call('get_transport_state')).result.playheadPosition, Math.round((beforeStep + 2 / 24) * 24) / 24)
    assert.equal(await page.evaluate(() => window.parity.timeline.getState().history.length), priorHistory)
    const beforeFrame = (await call('get_transport_state')).result.playheadPosition
    const frames = await call('inspect_edit_point', { outgoingClipId: 'clip-0', incomingClipId: 'clip-1' })
    assert.equal(frames.result.success, true); assert.equal(frames.content.filter(item => item.type === 'image').length, 2)
    assert.equal(frames.result.outgoing.timelineSeconds, 119 / 24)
    assert.equal((await call('get_transport_state')).result.playheadPosition, beforeFrame)
    const mediaDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-mcp-frame-review-'))
    const videoPath = path.join(mediaDirectory, 'synthetic.mp4')
    execFileSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24',
      '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath], { timeout: 15000 })
    await page.evaluate(url => {
      const state = window.parity.timeline.getState()
      window.parity.assets.setState({ assets: [...window.parity.assets.getState().assets,
        { id: 'decoder-test', type: 'video', url, duration: 2, settings: { fps: 24 } }] })
      window.parity.timeline.setState({ clips: [...state.clips, { id: 'decoder-clip', assetId: 'decoder-test', trackId: 'v',
        type: 'video', startTime: 20, duration: 2, trimStart: 0, trimEnd: 2, sourceDuration: 2, speed: 1,
        sourceFps: 24, timelineFps: 24 }] })
    }, 'data:video/mp4;base64,' + fs.readFileSync(videoPath).toString('base64'))
    await waitForUiPublication(snapshot => snapshot?.currentTimeline?.clips.some(clip => clip.id === 'decoder-clip'))
    const decoded = await call('inspect_source_frame', { clipId: 'decoder-clip', edge: 'right' })
    assert.equal(decoded.result.success, true, JSON.stringify(decoded.result))
    assert.ok(Math.abs(decoded.result.frame.presentedTime - 47 / 24) < 0.0001)
    assert.equal(decoded.content[1].type, 'image')
    assert.equal((await call('get_transport_state')).result.playheadPosition, beforeFrame)
    await page.evaluate(() => {
      const state = window.parity.timeline.getState()
      window.parity.timeline.setState({ clips: state.clips.filter(clip => clip.id !== 'decoder-clip') })
    })
    await waitForUiPublication(snapshot => !snapshot?.currentTimeline?.clips.some(clip => clip.id === 'decoder-clip'))
    // Leave the tiny synthetic fixture under /tmp for failed-run diagnosis.
    const presets = await call('list_export_presets')
    assert.ok(presets.result)
    const compound = await call('create_compound', { clipIds: ['clip-0', 'clip-1'], name: 'MCP review compound' })
    const created = await call('create_compound', compound.suggestedApplyCall.arguments)
    const compoundId = created.result.clipId || created.result.summary?.clipId
      || await page.evaluate(() => window.parity.timeline.getState().clips.find(clip => clip.compound)?.id)
    assert.ok(compoundId)
    await call('open_compound', { clipId: compoundId, previewOnly: false })
    const child = await page.evaluate(() => window.parity.buildMcpSnapshot())
    assert.equal(child.editingContext.kind, 'compound'); assert.equal(child.currentTimeline.clips.length, 2)
    assert.ok(child.currentTimeline.id.includes('/compound/'))
    const publicChild = await call('get_timeline')
    assert.equal(publicChild.editingContext.compoundClipId, compoundId)
    assert.equal(publicChild.context.compoundClipId, compoundId)
    await call('close_compound', { previewOnly: false })
    assert.equal((await call('get_timeline')).editingContext.kind, 'timeline')
    assert.equal((await page.evaluate(() => window.parity.buildMcpSnapshot())).editingContext.kind, 'timeline')
    assert.deepEqual(errors, [])
    console.log(`PASS: ${native ? 'Electron' : 'Chrome'} public MCP create/import/immediate readback, preview/apply/Undo/stale rejection, real action bridge and throttled publisher, audio, transport, exact source images, compounds, catalog routing`)
  } finally { await server?.stop(); await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
