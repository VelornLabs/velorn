import test, { after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Real renderer actions/stores and real native dispatch, without an Electron
// process, listening HTTP server, provider, project files, or user settings.
const require = createRequire(import.meta.url)
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { createAgentToolSession } = require('../electron/connectedAgentTools.cjs')
const { createAgentDispatchScope } = require('../electron/connectedAgentDispatch.cjs')
const previousStorage = globalThis.localStorage
const memoryStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.localStorage = memoryStorage
after(() => { if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage })

let networkCalls = 0
const rejectNetwork = async () => { networkCalls += 1; throw new Error('Network access is forbidden in the synthetic Agent editing fixture.') }
const fakeWindow = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} }
const code = buildSync({ stdin: { contents: `
  export * from './src/services/mcpActions';
  export * from './src/services/mcpContext';
  export * from './src/services/mcpSnapshot';
  export { default as timeline } from './src/stores/timelineStore';
  export { default as assets } from './src/stores/assetsStore';
  export { default as project } from './src/stores/projectStore';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'zustand', 'zustand/*'],
  define: { 'import.meta.env.BASE_URL': '"/"' }, logOverride: { 'empty-import-meta': 'silent' },
  loader: { '.glsl': 'text', '.png': 'dataurl', '.svg': 'dataurl' },
}).outputFiles[0].text
const module = { exports: {} }
Function('require', 'module', 'exports', 'localStorage', 'window', 'fetch', code)(require, module, module.exports,
  memoryStorage, fakeWindow, rejectNetwork)
const { timeline, assets, project, buildMcpSnapshot, captureMcpContext, captureAgentInteractionContext,
  startMcpActionBridge } = module.exports
const initialTimeline = timeline.getState()
const parse = response => JSON.parse(response.content.find(block => block.type === 'text').text)
function requireSuccess(response) {
  assert.notEqual(response.isError, true, response.content.map(block => block.text || '').join('\n'))
  const detail = parse(response)
  assert.notEqual(detail.success, false, JSON.stringify(detail))
  return detail
}

beforeEach(() => {
  networkCalls = 0
  project.setState({ currentProjectHandle: '/synthetic/agent-editing-only', currentTimelineId: 'timeline-one',
    projectHistory: [], projectFuture: [], projectHistoryLastChangedAt: 0, recentProjects: [],
    storyboardRevision: (project.getState().storyboardRevision || 0) + 1,
    currentProject: { name: 'Synthetic Agent editing fixture', settings: { width: 1920, height: 1080, fps: 24 },
      timelines: [{ id: 'timeline-one', name: 'Synthetic sequence', width: 1920, height: 1080, fps: 24 }] } })
  assets.setState({ assets: [], folders: [], currentPreview: null })
  timeline.setState({ ...initialTimeline, timelineSessionId: timeline.getState().timelineSessionId + 1,
    clips: [], tracks: [{ id: 'video-one', name: 'Video 1', type: 'video', visible: true, muted: false, locked: false }],
    markers: [], transitions: [], history: [], historyIndex: -1, historyLastChangedAt: 0,
    timelineFps: 24, duration: 10, playheadPosition: 2, isPlaying: false, compoundEditContext: null,
    markerCounter: 1, trackCounter: 2, selectedClipIds: [], selectedMarkerId: null, selectedTransitionId: null,
    selectedGap: null, activeTrackId: 'video-one', inPoint: null, outPoint: null })
})

async function harness({ approval = () => true, allowedTools, autoApproveEdits = false, trustedFullAccess = false } = {}) {
  const scope = createAgentDispatchScope()
  const abort = new AbortController()
  const pending = new Map(), requests = [], responses = [], approvals = []
  let listener = null, serial = 0, server
  // Exactly the production bridge contract: request carries a native-only
  // guard; completion carries the same action's snapshot and fresh guard.
  fakeWindow.electronAPI = { mcp: {
    onAction(callback) { listener = callback; return () => { listener = null } },
    sendActionResult(response) {
      responses.push(response)
      const waiting = pending.get(response.id)
      assert.ok(waiting, 'Every bridge response must belong to a pending request.')
      pending.delete(response.id)
      try {
        if (response.snapshotError || !server.updateSnapshot(response.snapshot)) throw new Error(response.snapshotError || 'Missing snapshot')
        scope.complete(waiting.scope, response, waiting.action)
        if (response.success === false) throw new Error(response.error || 'Renderer action failed')
        waiting.resolve(response.result || {})
      } catch (error) { waiting.reject(error) }
    },
  } }
  const stop = startMcpActionBridge()
  const performAction = request => {
    const current = scope.current()
    const envelope = { id: `synthetic-agent-action-${++serial}`, action: request.action, payload: request.payload || {},
      ...(current && !current.trustedFullAccess ? { agentGuard: structuredClone(current.current) } : {}) }
    requests.push(envelope)
    return new Promise((resolve, reject) => {
      pending.set(envelope.id, { resolve, reject, scope: current, action: request.action })
      Promise.resolve().then(() => listener(envelope)).catch(reject)
    })
  }
  server = createComfyStudioMcpServer({ performAction })
  server.updateSnapshot(buildMcpSnapshot())
  const session = await createAgentToolSession({ getServer: () => server, expectedContext: captureMcpContext(),
    signal: abort.signal, allowImages: false, autoApproveEdits, trustedFullAccess,
    getContext: async () => (await performAction({ action: 'get_transport_state' })).agentContext,
    executeTool: (name, args, guard) => {
      if (allowedTools && !allowedTools.has(name)) throw new Error(`This synthetic test does not permit ${name}.`)
      return scope.runTool(guard, abort.signal, () => server.callTool(name, args), { trustedFullAccess })
    },
    requestApproval: async details => { approvals.push(details); return approval(details) },
  })
  return { session, server, scope, abort, requests, responses, approvals, performAction,
    close() { stop(); delete fakeWindow.electronAPI; assert.equal(pending.size, 0); assert.equal(networkCalls, 0) } }
}

test('native generated image reaches the real import tool and renderer once without changing the timeline', async () => {
  const fs = await import('node:fs/promises'), path = await import('node:path'), os = await import('node:os')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-generated-import-'))
  const previousSave = project.getState().saveProject
  let saves = 0
  project.setState({ currentProjectHandle: root, saveProject: async () => { saves++; return { saved: true } } })
  const f = await harness({ trustedFullAccess: true })
  Object.assign(fakeWindow.electronAPI, {
    isElectron: true, exists: async file => fs.stat(file).then(() => true, () => false), pathBasename: path.basename,
    pathJoin: path.join, createDirectory: folder => fs.mkdir(folder, { recursive: true }),
    copyFile: async (source, dest) => { await fs.copyFile(source, dest); return { success: true } },
    getFileInfo: async file => ({ info: { size: (await fs.stat(file)).size } }),
    getFileUrlDirect: async () => 'data:image/png;base64,',
  })
  const previousImage = globalThis.Image
  globalThis.Image = class { set src(value) { this.width = 64; this.height = 64; queueMicrotask(() => this.onload?.()) } }
  try {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII='
    const frames = []
    const saved = await require('../electron/connectedAgentImages.cjs').receiveGeneratedImage({ result: png }, {
      toolSession: f.session, onReview: frame => frames.push(frame), nativeImage: { createFromBuffer: () => ({
        isEmpty: () => false, getSize: () => ({ width: 64, height: 64 }), resize: () => ({ toJPEG: () => Buffer.from([255,216,255,217]) }),
      }) },
    })
    assert.equal(assets.getState().assets.length, 1)
    const asset = assets.getState().assets[0]
    assert.equal(asset.id, saved.assetId); assert.equal(asset.type, 'image')
    assert.match(asset.path, /^assets\/images\/gpt-image-.*\.png$/)
    assert.equal((await fs.readFile(path.join(root, asset.path))).toString('base64'), png)
    assert.ok(saves >= 1); assert.equal(frames.length, 1)
    assert.equal(timeline.getState().clips.length, 0)
    assert.equal(f.requests.filter(request => request.action === 'import_asset_from_path').length, 1)
    const receipts = f.session.getReceipts().entries.filter(entry => entry.toolName === 'import_asset_from_path')
    assert.equal(receipts.length, 1); assert.notEqual(receipts[0].outcome, 'failed')
  } finally {
    f.close(); project.setState({ saveProject: previousSave })
    if (previousImage === undefined) delete globalThis.Image; else globalThis.Image = previousImage
    // Only this test-created, fixed-prefix temporary project is removed.
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('clip label writes report the fresh stored color through the real renderer bridge', async () => {
  const clip = { id: 'label-target', name: 'Label target', type: 'video', trackId: 'video-one',
    startTime: 0, duration: 4, trimStart: 0, trimEnd: 4, sourceDuration: 10 }
  timeline.setState({ clips: [clip] })
  const f = await harness()
  try {
    const preview = requireSuccess(await f.server.callTool('set_clip_label_color', {
      clipIds: [clip.id], color: '#f97316', previewOnly: true,
    }))
    assert.equal(preview.clips[0].labelColor, '')
    assert.equal(timeline.getState().clips[0].labelColor, undefined)

    const applied = requireSuccess(await f.server.callTool('set_clip_label_color', {
      clipIds: [clip.id, 'missing-clip'], color: '#f97316', previewOnly: false,
    }))
    assert.equal(timeline.getState().clips[0].labelColor, '#f97316')
    assert.equal(applied.clips[0].labelColor, '#f97316')
    assert.equal(applied.result.clips[0].labelColor, '#f97316')
    assert.deepEqual(applied.missingClipIds, ['missing-clip'])

    const historyLength = timeline.getState().history.length
    const repeated = requireSuccess(await f.server.callTool('set_clip_label_color', {
      clipIds: [clip.id], color: '#f97316', previewOnly: false,
    }))
    assert.equal(repeated.clips[0].labelColor, '#f97316')
    assert.equal(repeated.result.clips[0].labelColor, '#f97316')
    assert.equal(timeline.getState().history.length, historyLength, 'An identical write remains a no-op.')

    const cleared = requireSuccess(await f.server.callTool('set_clip_label_color', {
      clipIds: [clip.id], color: '', previewOnly: false,
    }))
    assert.equal(cleared.clips[0].labelColor, '')
    assert.equal(cleared.result.clips[0].labelColor, '')
    assert.equal(timeline.getState().clips[0].labelColor, undefined)
  } finally { f.close() }
})

test('one agent turn creates, edits, duplicates and switches timelines through the real renderer bridge', async () => {
  const f = await harness({ trustedFullAccess: true })
  try {
    const made = requireSuccess(await f.session.callTool('create_timeline', { name: 'Mobile test', durationSeconds: 20, previewOnly: false }))
    const id = made.result.timeline.id
    assert.equal(made.result.applied, true)
    assert.equal(made.result.changed, true)
    assert.deepEqual(f.session.getReceipts().entries.filter(item => item.toolName === 'create_timeline').map(item => item.outcome), ['applied'])
    assert.equal(project.getState().currentTimelineId, id)
    requireSuccess(await f.session.callTool('get_timeline'))
    requireSuccess(await f.session.callTool('add_timeline_markers', { markers: [{ timeSeconds: 3, label: 'New timeline only' }], previewOnly: false }))
    assert.equal(timeline.getState().markers[0].label, 'New timeline only')
    const duplicate = requireSuccess(await f.session.callTool('duplicate_timeline', { timelineId: id, name: 'Mobile alternate', switchToTimeline: true, previewOnly: false }))
    assert.equal(project.getState().currentTimelineId, duplicate.result.timeline.id)
    requireSuccess(await f.session.callTool('get_timeline'))
    requireSuccess(await f.session.callTool('switch_timeline', { timelineId: 'timeline-one', previewOnly: false }))
    assert.equal(project.getState().currentTimelineId, 'timeline-one')
    assert.deepEqual(timeline.getState().markers, [], 'Original remains unchanged')
    assert.equal(requireSuccess(await f.session.callTool('get_timeline')).id, 'timeline-one')
    requireSuccess(await f.session.callTool('switch_timeline', { timelineId: id, previewOnly: false }))
    assert.equal(timeline.getState().markers[0].label, 'New timeline only')
    requireSuccess(await f.session.callTool('add_timeline_markers', { markers: [{ timeSeconds: 4, label: 'After returning' }], previewOnly: false }))
    assert.equal(f.requests.filter(request => request.action === 'create_project_checkpoint').length, 0,
      'Full access does not require a checkpoint when creating or switching timelines.')
    assert.equal(f.approvals.length, 0)
  } finally { f.close() }
})

test('timeline creation previews stay unchanged; an inactive real sequence reports applied and retains project Undo', async () => {
  const f = await harness()
  try {
    const original = JSON.parse(JSON.stringify(project.getState().currentProject))
    const guard = captureAgentInteractionContext()
    const args = { name: 'Inactive receipt sequence', durationSeconds: 12, switchToTimeline: false }
    const rendererPreview = await f.performAction({ action: 'create_timeline', payload: { ...args, previewOnly: true } })
    assert.equal(rendererPreview.applied, false)
    assert.equal(rendererPreview.changed, false)
    const preview = requireSuccess(await f.session.callTool('create_timeline', { ...args, previewOnly: true }))
    assert.equal(preview.previewOnly, true)
    assert.deepEqual(project.getState().currentProject, original)
    assert.deepEqual(captureAgentInteractionContext(), guard)
    assert.equal(project.getState().projectHistory.length, 0)
    assert.equal(f.approvals.length, 0)
    assert.equal(f.session.getReceipts().entries.at(-1).outcome, 'preview')

    const result = requireSuccess(await f.session.callTool('create_timeline', { ...args, previewOnly: false })).result
    assert.equal(result.created, true)
    assert.equal(result.applied, true)
    assert.equal(result.changed, true)
    assert.equal(result.switched, false)
    assert.equal(project.getState().currentTimelineId, 'timeline-one')
    assert.equal(project.getState().currentProject.timelines.length, 2)
    assert.equal(project.getState().currentProject.timelines.find(item => item.id === result.timeline.id).duration, 12)
    assert.deepEqual(f.session.getReceipts().entries.filter(item => item.toolName === 'create_timeline').map(item => item.outcome), ['preview', 'preview', 'applied'])
    assert.equal(f.requests.filter(item => item.action === 'create_timeline' && item.payload.previewOnly === false).length, 1)
    assert.equal(f.approvals.length, 1)
    assert.equal(project.getState().undoTimelineStructureChange(), true)
    assert.deepEqual(project.getState().currentProject.timelines.map(item => item.id), ['timeline-one'])
  } finally { f.close() }
})

for (const failure of ['refused', 'unstored', 'existing']) {
  test(`timeline creation ${failure} store result cannot claim applied`, async () => {
    const createTimeline = project.getState().createTimeline
    project.setState({ createTimeline: () => failure === 'refused' ? null
      : failure === 'unstored' ? { id: 'timeline-not-stored', name: 'Not stored' }
        : project.getState().currentProject.timelines[0] })
    const f = await harness()
    try {
      const original = JSON.parse(JSON.stringify(project.getState().currentProject))
      const response = await f.session.callTool('create_timeline', { name: 'Cannot create', previewOnly: false })
      assert.equal(response.isError, true)
      assert.match(response.content[0].text, /Could not (create|confirm)/)
      assert.deepEqual(project.getState().currentProject, original)
      assert.equal(project.getState().currentTimelineId, 'timeline-one')
      assert.equal(project.getState().projectHistory.length, 0)
      assert.equal(f.session.getReceipts().entries.some(item => item.outcome === 'applied'), false)
    } finally { project.setState({ createTimeline }); f.close() }
  })
}

test('real clip keyframes report applied from stored curves, preserve previews and restore exactly through Undo', async () => {
  seedLastPictureTrimCase()
  const original = JSON.parse(JSON.stringify(timeline.getState().clips))
  const f = await harness()
  const args = { clipId: 'picture-6', keyframes: [
    { property: 'opacity', timeSeconds: 0, value: 0 },
    { property: 'opacity', timeSeconds: 1, value: 100 },
    { property: 'positionX', timeSeconds: 0, value: 0 },
    { property: 'positionX', timeSeconds: 999, value: 24 },
  ] }
  try {
    const guard = captureAgentInteractionContext()
    const rendererPreview = await f.performAction({ action: 'set_clip_keyframes', payload: { ...args, previewOnly: true } })
    assert.equal(rendererPreview.applied, false)
    assert.equal(rendererPreview.changed, false)
    const preview = requireSuccess(await f.session.callTool('set_clip_keyframes', { ...args, previewOnly: true }))
    assert.equal(preview.previewOnly, true)
    assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), original)
    assert.deepEqual(captureAgentInteractionContext(), guard)
    assert.equal(timeline.getState().history.length, 0)
    assert.equal(f.approvals.length, 0)
    assert.equal(f.session.getReceipts().entries.at(-1).outcome, 'preview')

    const result = requireSuccess(await f.session.callTool('set_clip_keyframes', { ...args, previewOnly: false })).result
    assert.equal(result.updated, true)
    assert.equal(result.applied, true)
    assert.equal(result.changed, true)
    const stored = timeline.getState().clips.find(item => item.id === 'picture-6')
    assert.deepEqual(result.clip.keyframes, stored.keyframes)
    assert.deepEqual(stored.keyframes, {
      opacity: [{ time: 0, value: 0, easing: 'easeInOut' }, { time: 1, value: 100, easing: 'easeInOut' }],
      positionX: [{ time: 0, value: 0, easing: 'easeInOut' }, { time: stored.duration, value: 24, easing: 'easeInOut' }],
    }, 'Actual store-clamped times, not requested times, are the receipt evidence.')
    assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips.slice(0, -1))), original.slice(0, -1))
    const inspected = requireSuccess(await f.session.callTool('inspect_clip', { clipId: 'picture-6' }))
    assert.deepEqual(inspected.clip.keyframes, stored.keyframes)
    assert.deepEqual(f.session.getReceipts().entries.filter(item => item.toolName === 'set_clip_keyframes').map(item => item.outcome), ['preview', 'preview', 'applied'])
    assert.equal(f.requests.filter(item => item.action === 'set_clip_keyframes' && item.payload.previewOnly === false).length, 1)
    assert.equal(f.requests.filter(item => item.action === 'create_project_checkpoint' && item.payload.previewOnly === false).length, 1)
    requireSuccess(await f.session.callTool('undo', { scope: 'timeline', previewOnly: false }))
    assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), original)
  } finally { f.close() }
})

for (const noChange of ['identical', 'replace-identical', 'clear-absent', 'store-refused']) {
  test(`clip keyframes ${noChange} report no-change, never applied`, async () => {
    seedLastPictureTrimCase()
    const existing = { opacity: [{ easing: 'easeInOut', value: 50, time: 2 }], positionX: [{ time: 0, value: 5, easing: 'linear' }] }
    timeline.setState(state => ({ clips: state.clips.map(clip => clip.id === 'picture-6' ? { ...clip, keyframes: existing } : clip) }))
    const original = JSON.parse(JSON.stringify(timeline.getState().clips))
    const setKeyframe = timeline.getState().setKeyframe
    if (noChange === 'store-refused') timeline.setState({ setKeyframe: () => false })
    const f = await harness()
    try {
      const args = noChange === 'clear-absent' ? { clearKeyframes: ['rotation'] }
        : { keyframes: [{ property: 'opacity', timeSeconds: 999, value: noChange === 'store-refused' ? 75 : 50 }],
          replaceKeyframes: noChange === 'replace-identical' }
      const result = requireSuccess(await f.session.callTool('set_clip_keyframes', { ...args, clipId: 'picture-6', previewOnly: false })).result
      assert.equal(result.updated, false)
      assert.equal(result.applied, false)
      assert.equal(result.changed, false)
      assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), original)
      assert.deepEqual(f.session.getReceipts().entries.filter(item => item.toolName === 'set_clip_keyframes').map(item => item.outcome), ['preview', 'no-change'])
      assert.equal(f.requests.filter(item => item.action === 'set_clip_keyframes' && item.payload.previewOnly === false).length, 1)
    } finally { timeline.setState({ setKeyframe }); f.close() }
  })
}

test('clearing existing clip keyframes reports applied and Undo restores those curves without changing other properties', async () => {
  seedLastPictureTrimCase()
  const curves = { opacity: [{ time: 0, value: 50, easing: 'linear' }], positionX: [{ time: 1, value: 20, easing: 'easeInOut' }] }
  timeline.setState(state => ({ clips: state.clips.map(clip => clip.id === 'picture-6' ? { ...clip, keyframes: curves } : clip) }))
  const original = JSON.parse(JSON.stringify(timeline.getState().clips))
  const f = await harness()
  try {
    const result = requireSuccess(await f.session.callTool('set_clip_keyframes', { clipId: 'picture-6', clearKeyframes: ['opacity'], previewOnly: false })).result
    assert.equal(result.applied, true)
    assert.equal(result.changed, true)
    assert.deepEqual(result.clip.keyframes, { positionX: curves.positionX })
    assert.deepEqual(timeline.getState().clips.at(-1).keyframes, { positionX: curves.positionX })
    assert.deepEqual(f.session.getReceipts().entries.filter(item => item.toolName === 'set_clip_keyframes').map(item => item.outcome), ['preview', 'applied'])
    requireSuccess(await f.session.callTool('undo', { scope: 'timeline', previewOnly: false }))
    assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), original)
  } finally { f.close() }
})

for (const toolName of ['create_timeline', 'set_clip_keyframes']) for (const refusal of ['denied', 'stale']) {
  test(`${toolName} ${refusal} approval cannot dispatch apply or claim an applied receipt`, async () => {
    seedLastPictureTrimCase()
    const original = JSON.parse(JSON.stringify(timeline.getState().clips))
    const f = await harness({ approval: () => {
      if (refusal === 'stale') timeline.setState({ selectedClipIds: ['picture-1'] })
      return refusal !== 'denied'
    } })
    try {
      const args = toolName === 'create_timeline' ? { name: 'Blocked sequence' }
        : { clipId: 'picture-6', keyframes: [{ property: 'opacity', timeSeconds: 0, value: 50 }] }
      const response = await f.session.callTool(toolName, { ...args, previewOnly: false })
      assert.equal(response.isError, true)
      assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), original)
      assert.equal(project.getState().currentProject.timelines.length, 1)
      assert.equal(f.requests.some(item => item.action === toolName && item.payload.previewOnly === false), false)
      assert.equal(f.requests.some(item => item.action === 'create_project_checkpoint'), false)
      assert.deepEqual(f.session.getReceipts().entries.filter(item => item.toolName === toolName).map(item => item.outcome), ['preview', refusal === 'denied' ? 'denied' : 'failed'])
    } finally { f.close() }
  })
}

test('Agent marker add/remove/Undo uses real MCP routing and the real timeline history', async () => {
  const f = await harness()
  try {
    const preview = requireSuccess(await f.session.callTool('add_timeline_markers', {
      markers: [{ timeSeconds: 3, label: 'Review this cut', color: '#f97316' }], previewOnly: true,
    }))
    assert.equal(preview.previewOnly, true)
    assert.equal(timeline.getState().markers.length, 0)
    assert.equal(timeline.getState().history.length, 0)
    assert.equal(f.approvals.length, 0)

    requireSuccess(await f.session.callTool('add_timeline_markers', {
      markers: [{ timeSeconds: 3, label: 'Review this cut', color: '#f97316' }], previewOnly: false,
    }))
    const marker = timeline.getState().markers[0]
    assert.equal(marker.label, 'Review this cut')
    assert.equal(marker.time, 3)
    assert.equal(timeline.getState().history.length, 1)
    const inspected = requireSuccess(await f.session.callTool('get_timeline'))
    assert.equal(inspected.markers[0].id, marker.id, 'Immediate reads must see the action-completion snapshot.')

    requireSuccess(await f.session.callTool('remove_timeline_markers', { markerIds: [marker.id], previewOnly: false }))
    assert.equal(timeline.getState().markers.length, 0)
    assert.equal(timeline.getState().history.length, 2)
    requireSuccess(await f.session.callTool('undo', { scope: 'timeline', previewOnly: false }))
    assert.equal(timeline.getState().markers[0].id, marker.id)
    assert.equal(f.approvals.length, 3)
    const write = f.requests.find(request => request.action === 'add_timeline_markers')
    assert.ok(write.agentGuard)
    assert.equal(write.payload.expectedContext, undefined, 'Legacy marker handlers drop payload context; the native envelope must protect them.')
    assert.equal(f.responses.every(response => response.snapshot && response.agentContext?.context), true)
  } finally { f.close() }
})

test('Agent track creation is editable and Undo restores the original track layout', async () => {
  const f = await harness()
  try {
    const originalTracks = structuredClone(timeline.getState().tracks)
    requireSuccess(await f.session.callTool('add_track', { type: 'audio', name: 'Dialogue', channels: 'mono', previewOnly: false }))
    assert.equal(timeline.getState().tracks.length, 2)
    const added = timeline.getState().tracks.find(track => track.name === 'Dialogue')
    assert.equal(added.type, 'audio')
    assert.equal(added.channels, 'mono')
    assert.equal(timeline.getState().history.length, 1)
    requireSuccess(await f.session.callTool('undo', { scope: 'timeline', previewOnly: false }))
    assert.deepEqual(timeline.getState().tracks, originalTracks)
    assert.deepEqual(requireSuccess(await f.session.callTool('get_timeline')).tracks,
      JSON.parse(JSON.stringify(buildMcpSnapshot().currentTimeline.tracks)))
    assert.equal(f.approvals.length, 2)
  } finally { f.close() }
})

test('automatic marker and track edits create one real RAM checkpoint before writes and retain Undo', async () => {
  const f = await harness({ autoApproveEdits: true })
  try {
    const originalTracks = structuredClone(timeline.getState().tracks)
    const response = await f.session.callTool('add_timeline_markers', {
      markers: [{ timeSeconds: 3, label: 'Automatic review marker' }], previewOnly: false,
    })
    requireSuccess(response)
    assert.match(response.content.map(block => block.text).join('\n'), /Safety checkpoint:/)
    assert.equal(timeline.getState().markers.length, 1)
    assert.equal(timeline.getState().history.length, 1)
    requireSuccess(await f.session.callTool('add_track', { type: 'audio', name: 'Automatic dialogue', channels: 'mono', previewOnly: false }))
    assert.equal(timeline.getState().tracks.length, 2)
    assert.equal(timeline.getState().history.length, 2)
    assert.equal(f.approvals.length, 0)
    const checkpoints = f.requests.filter(request => request.action === 'create_project_checkpoint')
    assert.equal(checkpoints.length, 2, 'Real renderer previews and creates exactly one checkpoint for the turn.')
    assert.deepEqual(checkpoints.map(request => request.payload.previewOnly), [true, false])
    const checkpointIndex = f.requests.indexOf(checkpoints[1])
    assert.ok(checkpointIndex < f.requests.findIndex(request => request.action === 'add_timeline_markers'))
    assert.equal(checkpoints.every(request => request.agentGuard?.context), true)
    const checkpoint = f.responses.find(item => item.id === checkpoints[1].id).result
    assert.equal(checkpoint.success, true)
    assert.ok(checkpoint.checkpointId)
    requireSuccess(await f.session.callTool('undo', { scope: 'timeline', previewOnly: false }))
    assert.deepEqual(timeline.getState().tracks, originalTracks)
    assert.equal(timeline.getState().markers.length, 1)
    assert.equal(f.approvals.length, 1, 'Undo stays a manual action, not part of auto-edit authority.')
    requireSuccess(await f.session.callTool('restore_project_checkpoint', { checkpointId: checkpoint.checkpointId, previewOnly: false }))
    assert.equal(timeline.getState().markers.length, 0, 'Checkpoint contains pre-edit state, not post-mutation state.')
    assert.deepEqual(timeline.getState().tracks, originalTracks)
    assert.equal(f.approvals.length, 2, 'Restoring a project snapshot is always manually approved.')
  } finally { f.close() }
})

test('automatic transform, color, built-in effect and trim keep real one-use previews and each Undo step', async () => {
  const clip = { id: 'synthetic-clip', name: 'Synthetic clip', assetId: 'synthetic-asset', type: 'video', trackId: 'video-one',
    startTime: 0, duration: 4, trimStart: 0, trimEnd: 4, sourceDuration: 10, sourceTimeScale: 1,
    timelineFps: 24, sourceFps: 24, speed: 1, reverse: false, url: 'memory:synthetic-clip',
    transform: { positionX: 0, scaleX: 100, scaleY: 100, scaleLinked: true } }
  timeline.setState({ clips: [clip], selectedClipIds: [clip.id] })
  assets.setState({ assets: [{ id: clip.assetId, name: 'Synthetic media', type: 'video', duration: 10,
    url: clip.url, hasAudio: false, settings: { fps: 24 } }] })
  const f = await harness({ autoApproveEdits: true })
  try {
    const actions = [
      ['set_clip_style', { clipId: clip.id, positionX: 15, opacity: 75 }, () => assert.equal(timeline.getState().clips[0].transform.positionX, 15)],
      ['set_clip_color', { clipId: clip.id, adjustments: { contrast: 12, shadows: { hue: 4 } } }, () => assert.equal(timeline.getState().clips[0].adjustments.contrast, 12)],
      ['edit_clip_effects', { clipId: clip.id, action: 'add', effectType: 'gaussianBlur', settings: { amount: 4 } }, () => assert.equal(timeline.getState().clips[0].effects[0].type, 'gaussianBlur')],
      ['trim_clips', { clipId: clip.id, durationSeconds: 2 }, () => assert.equal(timeline.getState().clips[0].duration, 2)],
    ]
    const priorStates = []
    for (const [name, args, verify] of actions) {
      const before = JSON.parse(JSON.stringify(timeline.getState().clips))
      priorStates.push(before)
      requireSuccess(await f.session.callTool(name, { ...args, previewOnly: false }))
      verify()
      const apply = f.requests.findLast(request => request.action === name && request.payload.previewOnly === false)
      assert.ok(apply?.payload.previewToken, `${name} must retain the real one-use preview token.`)
      assert.deepEqual(apply.payload.expectedContext, apply.agentGuard.context)
      assert.equal(f.approvals.filter(request => request.toolName === name).length, 0, name)
    }
    assert.equal(f.requests.filter(request => request.action === 'create_project_checkpoint' && request.payload.previewOnly === false).length, 1)
    assert.equal(f.approvals.length, 0)
    assert.equal(timeline.getState().history.length, actions.length)
    // Exercise the user's native Undo action; repeated identical Agent Undo
    // calls are intentionally de-duplicated by the separate turn safety gate.
    for (let index = actions.length - 1; index >= 0; index -= 1) {
      timeline.getState().undo()
      assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), priorStates[index], `${actions[index][0]} must undo authored state exactly.`)
    }
  } finally { f.close() }
})

test('real bridge rejects a stale native guard before a legacy write lacking payload context', async () => {
  const f = await harness()
  try {
    for (const mutate of [
      () => timeline.setState({ playheadPosition: timeline.getState().playheadPosition + 1 }),
      () => timeline.setState({ selectedMarkerId: 'another-marker' }),
      () => timeline.setState({ tracks: [...timeline.getState().tracks] }),
    ]) {
      const guard = captureAgentInteractionContext()
      mutate()
      await assert.rejects(() => f.scope.run(guard, f.abort.signal, () => f.performAction({
        action: 'add_timeline_markers', payload: { markers: [{ timeSeconds: 1, label: 'Must not exist' }] },
      })), /changed/)
      assert.equal(timeline.getState().markers.length, 0)
      assert.equal(timeline.getState().history.length, 0)
    }
    const refused = f.responses.filter(response => response.success === false)
    assert.equal(refused.length, 3)
    assert.equal(refused.every(response => response.agentContext?.context && response.snapshot), true)
  } finally { f.close() }
})

test('approved action plan advances its own real guard between checkpoint, marker and track writes', async () => {
  const f = await harness()
  try {
    const detail = requireSuccess(await f.session.callTool('run_mcp_action_plan', { label: 'Synthetic reviewed edit', previewOnly: false,
      steps: [
        { tool: 'add_timeline_markers', arguments: { markers: [{ timeSeconds: 1, label: 'First' }] } },
        { tool: 'add_track', arguments: { type: 'video', name: 'Alternate take' } },
        { tool: 'add_timeline_markers', arguments: { markers: [{ timeSeconds: 4, label: 'Second' }] } },
      ] }))
    assert.equal(detail.executedStepCount, 3)
    assert.equal(detail.failedCount, 0)
    assert.ok(detail.checkpoint.result.checkpointId)
    assert.deepEqual(timeline.getState().markers.map(marker => marker.label), ['First', 'Second'])
    assert.equal(timeline.getState().tracks.length, 2)
    assert.equal(timeline.getState().history.length, 3)
    assert.equal(f.approvals.length, 1)
    const edits = f.requests.filter(request => ['add_timeline_markers', 'add_track'].includes(request.action))
    assert.equal(edits.length, 3)
    assert.ok(edits[1].agentGuard.context.revision > edits[0].agentGuard.context.revision)
    assert.ok(edits[2].agentGuard.context.revision > edits[1].agentGuard.context.revision)
    assert.equal(edits[1].agentGuard.selection.selectedMarkerId, timeline.getState().markers[0].id)
    requireSuccess(await f.session.callTool('undo', { scope: 'timeline', previewOnly: false }))
    assert.deepEqual(timeline.getState().markers.map(marker => marker.label), ['First'])
    assert.equal(timeline.getState().tracks.length, 2)
  } finally { f.close() }
})

function seedLastPictureTrimCase() {
  let start = 0
  const clips = [3,4,4,3,3,2].map((duration, index) => {
    const clip = { id:`picture-${index+1}`,name:`Synthetic picture ${index+1}`,assetId:`source-${index+1}`,type:'video',trackId:'video-one',
      startTime:start,duration,trimStart:0,trimEnd:duration,sourceDuration:10,sourceTimeScale:1,timelineFps:24,sourceFps:24,
      speed:1,reverse:false,url:`memory:source-${index+1}` }
    start += duration; return clip
  })
  timeline.setState({clips, duration:30, selectedClipIds:[],playheadPosition:0})
  assets.setState({assets:clips.map(clip=>({id:clip.assetId,name:clip.name,type:'video',duration:10,url:clip.url,hasAudio:false,settings:{fps:24}}))})
  // Like a project with an unsaved last-shot trim: its serialized timeline
  // snapshot still has the older duration, while the live editor owns 2s.
  project.setState(state=>({currentProject:{...state.currentProject,timelines:state.currentProject.timelines.map(item=>({
    ...item,...timeline.getState().getProjectData(),clips:clips.map(clip=>clip.id==='picture-6'?{...clip,duration:3,trimEnd:3}:clip),modified:'2026-01-01T00:00:00Z',
  }))}}))
  return structuredClone(clips)
}

test('Full access direct trim, delete and repeated Undo preserve real authored state without checkpoints', async () => {
  const original = seedLastPictureTrimCase()
  const f = await harness({ trustedFullAccess: true, approval: () => { throw new Error('No approval expected') } })
  try {
    const trim = { clipId: 'picture-6', durationSeconds: 2.5, ripple: false }
    const preview = requireSuccess(await f.session.callTool('trim_clips', { ...trim, previewOnly: true }))
    assert.equal(preview.previewOnly, true)
    assert.deepEqual(timeline.getState().clips, original)
    // The user can scrub/select after an optional preview without making the
    // subsequent direct edit depend on a frozen UI interaction snapshot.
    timeline.setState({ playheadPosition: 7, selectedClipIds: ['picture-1'] })
    requireSuccess(await f.session.callTool('trim_clips', { ...trim, expectedContext: { stale: true }, previewToken: 'expired' }))
    assert.equal(timeline.getState().clips.at(-1).duration, 2.5)
    requireSuccess(await f.session.callTool('get_timeline'))
    requireSuccess(await f.session.callTool('delete_clips', { clipIds: ['picture-6'], ripple: false }))
    assert.equal(timeline.getState().clips.length, 5)
    requireSuccess(await f.session.callTool('undo', { scope: 'timeline' }))
    assert.equal(timeline.getState().clips.length, 6)
    assert.equal(timeline.getState().clips.at(-1).duration, 2.5)
    requireSuccess(await f.session.callTool('undo', { scope: 'timeline' }))
    assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), original)
    assert.equal(f.requests.some(request => request.action === 'create_project_checkpoint'), false)
    assert.equal(f.requests.some(request => request.agentGuard), false)
    assert.equal(f.approvals.length, 0)
    assert.deepEqual(f.session.getReceipts().entries.filter(item => item.toolName === 'trim_clips').map(item => item.outcome), ['preview', 'applied'])
    assert.deepEqual(f.session.getReceipts().entries.filter(item => item.toolName === 'undo').map(item => item.outcome), ['applied', 'applied'])
  } finally { f.close() }
})

test('real timeline Undo and Redo report applied receipts only after restoring authored state, never for previews', async () => {
  const original = seedLastPictureTrimCase()
  const f = await harness()
  try {
    requireSuccess(await f.session.callTool('edit_trim', { clipId: 'picture-6', mode: 'normal', edge: 'end', deltaSeconds: 1, previewOnly: false }))
    const edited = JSON.parse(JSON.stringify(timeline.getState().clips))
    assert.equal(edited.at(-1).duration, 3)
    for (const [direction, expected] of [['undo', original], ['redo', edited]]) {
      const before = JSON.parse(JSON.stringify(timeline.getState().clips))
      const guard = captureAgentInteractionContext()
      const approvalCount = f.approvals.length
      const preview = requireSuccess(await f.session.callTool(direction, { scope: 'timeline', previewOnly: true }))
      assert.equal(preview.previewOnly, true)
      assert.equal(preview.result.applied, false)
      assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), before)
      assert.deepEqual(captureAgentInteractionContext(), guard)
      assert.equal(f.approvals.length, approvalCount)
      assert.equal(f.session.getReceipts().entries.at(-1).outcome, 'preview')

      const applied = requireSuccess(await f.session.callTool(direction, { scope: 'timeline', previewOnly: false }))
      assert.equal(applied.result.applied, true)
      assert.equal(applied.result.scope, 'timeline')
      assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), expected)
      assert.equal(requireSuccess(await f.session.callTool('get_timeline')).clips.at(-1).duration, expected.at(-1).duration)
      assert.deepEqual(f.session.getReceipts().entries.filter(item => item.toolName === direction).map(item => item.outcome),
        ['preview', 'preview', 'applied'])
      assert.equal(f.requests.filter(item => item.action === direction && item.payload.previewOnly === false).length, 1)
    }
    assert.equal(f.requests.filter(item => item.action === 'create_project_checkpoint' && item.payload.previewOnly === false).length, 1,
      'Undo/Redo do not create a new checkpoint or replay the original trim.')
    assert.equal(f.approvals.length, 3)
  } finally { f.close() }
})

test('Undo and Redo with no available history return applied false and never an applied receipt', async () => {
  for (const scope of ['auto', 'timeline', 'project']) for (const direction of ['undo', 'redo']) {
    const f = await harness()
    try {
      const original = JSON.parse(JSON.stringify(timeline.getState().getProjectData()))
      const preview = requireSuccess(await f.session.callTool(direction, { scope, previewOnly: true }))
      assert.equal(preview.result.applied, false)
      assert.equal(f.approvals.length, 0)
      const response = await f.session.callTool(direction, { scope, previewOnly: false })
      const detail = parse(response)
      assert.equal(detail.success, false, `${direction} ${scope}`)
      assert.equal(detail.result.success, false)
      assert.equal(detail.result.applied, false)
      assert.equal(f.session.getReceipts().entries.some(item => item.outcome === 'applied'), false)
      assert.deepEqual(f.session.getReceipts().entries.slice(0, 2).map(item => item.outcome), ['preview', 'preview'])
      assert.equal(f.requests.some(item => item.action === 'create_project_checkpoint'), false)
      assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().getProjectData())), original)
      assert.equal(timeline.getState().history.length, 0)
      assert.equal(project.getState().projectHistory.length, 0)
    } finally { f.close() }
  }
})

for (const direction of ['undo', 'redo']) for (const refusal of ['denied', 'stale']) {
  test(`${direction} ${refusal} during approval never dispatches apply or claims an applied receipt`, async () => {
    seedLastPictureTrimCase()
    const f = await harness({ approval: details => {
      if (details.toolName !== direction) return true
      if (refusal === 'stale') timeline.setState({ selectedClipIds: ['picture-1'] })
      return refusal !== 'denied'
    } })
    try {
      requireSuccess(await f.session.callTool('edit_trim', { clipId: 'picture-6', mode: 'normal', edge: 'end', deltaSeconds: 1, previewOnly: false }))
      if (direction === 'redo') assert.equal(timeline.getState().undo(), true)
      const original = JSON.parse(JSON.stringify(timeline.getState().clips))
      const historyIndex = timeline.getState().historyIndex
      const response = await f.session.callTool(direction, { scope: 'timeline', previewOnly: false })
      assert.equal(response.isError, true)
      if (refusal === 'stale') assert.match(response.content[0].text, /changed while approval/)
      const receipts = f.session.getReceipts().entries.filter(item => item.toolName === direction)
      assert.deepEqual(receipts.map(item => item.outcome), ['preview', refusal === 'denied' ? 'denied' : 'failed'])
      assert.equal(f.requests.filter(item => item.action === direction && item.payload.previewOnly === false).length, 0)
      assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), original)
      assert.equal(timeline.getState().historyIndex, historyIndex)
    } finally { f.close() }
  })
}

test('real project storyboard Undo and Redo report applied while retaining the active timeline identity', async () => {
  const original = { version: 1, title: 'Original synthetic board', brief: '', songAssetId: null, shots: [] }
  project.setState(state => ({ currentProject: { ...state.currentProject, storyboard: original } }))
  const edited = { ...original, title: 'Edited synthetic board' }
  assert.equal(project.getState().setStoryboardWithHistory(edited), true)
  const timelineId = project.getState().currentTimelineId
  const timelineSessionId = timeline.getState().timelineSessionId
  const f = await harness()
  try {
    for (const [direction, expected] of [['undo', original], ['redo', edited]]) {
      const result = requireSuccess(await f.session.callTool(direction, { scope: 'project', previewOnly: false }))
      assert.equal(result.result.applied, true)
      assert.equal(result.result.scope, 'project')
      assert.deepEqual(project.getState().currentProject.storyboard, expected)
      assert.equal(project.getState().currentTimelineId, timelineId)
      assert.equal(timeline.getState().timelineSessionId, timelineSessionId)
      assert.deepEqual(f.session.getReceipts().entries.filter(item => item.toolName === direction).map(item => item.outcome), ['preview', 'applied'])
    }
    assert.equal(f.approvals.length, 2)
    assert.equal(f.requests.some(item => item.action === 'create_project_checkpoint'), false)
  } finally { f.close() }
})

test('project rename Undo and Redo that reload the timeline keep the existing unconfirmed identity guard', async () => {
  const originalName = project.getState().currentProject.timelines[0].name
  assert.equal(project.getState().renameTimeline('timeline-one', 'Renamed synthetic timeline'), true)
  for (const [direction, expected] of [['undo', originalName], ['redo', 'Renamed synthetic timeline']]) {
    const oldSession = timeline.getState().timelineSessionId
    const f = await harness()
    try {
      const result = requireSuccess(await f.session.callTool(direction, { scope: 'project', previewOnly: false }))
      assert.equal(result.result.applied, true, 'The store confirms the operation but this cannot bypass session identity checks.')
      assert.equal(project.getState().currentProject.timelines[0].name, expected)
      assert.equal(project.getState().currentTimelineId, 'timeline-one')
      assert.ok(timeline.getState().timelineSessionId > oldSession)
      assert.deepEqual(f.session.getReceipts().entries.filter(item => item.toolName === direction).map(item => item.outcome), ['preview', 'unconfirmed'])
      const next = await f.session.callTool('get_timeline')
      assert.equal(next.isError, true)
      assert.match(next.content[0].text, /changed the active project or timeline/)
    } finally { f.close() }
  }
})

for (const destination of ['same timeline', 'another timeline']) {
  test(`approved checkpoint restore to ${destination} permits fresh inspection and a newly checkpointed edit without replay`, async () => {
    seedLastPictureTrimCase()
    timeline.getState().loadFromProject(timeline.getState().getProjectData(), assets.getState().assets, 24)
    const original = JSON.parse(JSON.stringify(timeline.getState().clips))
    const f = await harness()
    try {
      const checkpoint = requireSuccess(await f.session.callTool('create_project_checkpoint', { label: 'Exact restore target', previewOnly: false })).result
      requireSuccess(await f.session.callTool('edit_trim', { clipId: 'picture-6', mode: 'normal', edge: 'end', deltaSeconds: 1, previewOnly: false }))
      requireSuccess(await f.session.callTool('add_timeline_markers', { markers: [{ timeSeconds: 3, label: 'Remove with restore' }], previewOnly: false }))
      assert.equal(timeline.getState().clips.at(-1).duration, 3)
      if (destination === 'another timeline') {
        requireSuccess(await f.session.callTool('create_timeline', { name: 'Sequence left by restore', durationSeconds: 12, previewOnly: false }))
        assert.notEqual(project.getState().currentTimelineId, 'timeline-one')
      }
      const before = captureAgentInteractionContext()
      const beforePreview = JSON.parse(JSON.stringify(timeline.getState().getProjectData()))
      const args = { checkpointId: checkpoint.checkpointId, previewOnly: false }
      const preview = requireSuccess(await f.session.callTool('restore_project_checkpoint', { ...args, previewOnly: true }))
      assert.equal(preview.result.applied, false)
      assert.equal(preview.result.restoreTransition, undefined)
      assert.equal(preview.result.checkpoint.id, checkpoint.checkpointId)
      assert.equal(preview.result.checkpoint.currentTimelineId, 'timeline-one')
      assert.deepEqual(captureAgentInteractionContext(), before)
      assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().getProjectData())), beforePreview)

      const restored = requireSuccess(await f.session.callTool('restore_project_checkpoint', args)).result
      assert.equal(restored.applied, true)
      assert.equal(restored.restored, true)
      assert.equal(restored.checkpointId, checkpoint.checkpointId)
      assert.equal(restored.restoredTimelineId, 'timeline-one')
      assert.deepEqual(restored.restoreTransition.before, before)
      assert.deepEqual(restored.restoreTransition.after, captureAgentInteractionContext())
      assert.equal(timeline.getState().timelineSessionId, before.context.timelineSessionId + 1)
      assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), original)
      assert.deepEqual(timeline.getState().markers, [])
      assert.equal(project.getState().currentProject.timelines.length, 1)
      assert.equal(timeline.getState().history.length, 0)
      assert.deepEqual(f.session.getReceipts().entries.filter(item => item.toolName === 'restore_project_checkpoint').map(item => item.outcome), ['preview', 'preview', 'applied'])
      assert.equal(f.approvals.filter(item => item.toolName === 'restore_project_checkpoint').length, 1)
      assert.equal(requireSuccess(await f.session.callTool('get_timeline')).clips.at(-1).duration, 2)
      const replay = await f.session.callTool('restore_project_checkpoint', args)
      assert.equal(replay.isError, true)
      assert.equal(f.requests.filter(item => item.action === 'restore_project_checkpoint' && item.payload.previewOnly === false).length, 1)

      requireSuccess(await f.session.callTool('edit_trim', { clipId: 'picture-6', mode: 'normal', edge: 'end', deltaSeconds: 0.5, previewOnly: false }))
      assert.equal(timeline.getState().clips.at(-1).duration, 2.5)
      const checkpointApplies = f.requests.filter(item => item.action === 'create_project_checkpoint' && item.payload.previewOnly === false)
      assert.equal(checkpointApplies.length, 2, 'Restore invalidates the prior edit-checkpoint lease before another edit.')
      const postRestoreCheckpoint = f.responses.find(item => item.id === checkpointApplies[1].id).result
      assert.notEqual(postRestoreCheckpoint.checkpointId, checkpoint.checkpointId)
      assert.ok(f.requests.indexOf(checkpointApplies[1]) > f.requests.findIndex(item => item.action === 'restore_project_checkpoint' && item.payload.previewOnly === false))
      requireSuccess(await f.session.callTool('undo', { scope: 'timeline', previewOnly: false }))
      assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), original)
    } finally { f.close() }
  })
}

for (const refusal of ['denied', 'stale']) {
  test(`checkpoint restore ${refusal} during approval never replaces the timeline or acquires continuation`, async () => {
    seedLastPictureTrimCase()
    const f = await harness({ approval: details => {
      if (details.toolName !== 'restore_project_checkpoint') return true
      if (refusal === 'stale') timeline.setState({ playheadPosition: 1 })
      return refusal !== 'denied'
    } })
    try {
      const checkpoint = requireSuccess(await f.session.callTool('create_project_checkpoint', { label: 'Refused restore target', previewOnly: false })).result
      requireSuccess(await f.session.callTool('edit_trim', { clipId: 'picture-6', mode: 'normal', edge: 'end', deltaSeconds: 1, previewOnly: false }))
      const before = JSON.parse(JSON.stringify(timeline.getState().clips))
      const session = timeline.getState().timelineSessionId
      const response = await f.session.callTool('restore_project_checkpoint', { checkpointId: checkpoint.checkpointId, previewOnly: false })
      assert.equal(response.isError, true)
      assert.equal(timeline.getState().timelineSessionId, session)
      assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), before)
      assert.equal(f.requests.some(item => item.action === 'restore_project_checkpoint' && item.payload.previewOnly === false), false)
      assert.deepEqual(f.session.getReceipts().entries.filter(item => item.toolName === 'restore_project_checkpoint').map(item => item.outcome), ['preview', refusal === 'denied' ? 'denied' : 'failed'])
      assert.equal(requireSuccess(await f.session.callTool('get_timeline')).clips.at(-1).duration, 3)
    } finally { f.close() }
  })
}

test('latest checkpoint restore freezes the previewed ID even if another checkpoint is created during approval', async () => {
  seedLastPictureTrimCase()
  let addedCheckpoint, f
  f = await harness({ approval: async details => {
    if (details.toolName === 'restore_project_checkpoint') {
      addedCheckpoint = await f.performAction({ action: 'create_project_checkpoint', payload: { label: 'Newer checkpoint during approval', previewOnly: false } })
    }
    return true
  } })
  try {
    const checkpoint = requireSuccess(await f.session.callTool('create_project_checkpoint', { label: 'Previewed latest checkpoint', previewOnly: false })).result
    requireSuccess(await f.session.callTool('edit_trim', { clipId: 'picture-6', mode: 'normal', edge: 'end', deltaSeconds: 1, previewOnly: false }))
    const result = requireSuccess(await f.session.callTool('restore_project_checkpoint', { previewOnly: false })).result
    assert.notEqual(addedCheckpoint.checkpointId, checkpoint.checkpointId)
    assert.equal(result.checkpointId, checkpoint.checkpointId)
    const apply = f.requests.find(item => item.action === 'restore_project_checkpoint' && item.payload.previewOnly === false)
    assert.equal(apply.payload.checkpointId, checkpoint.checkpointId)
    assert.equal(requireSuccess(await f.session.callTool('get_timeline')).clips.at(-1).duration, 2)
    assert.equal(f.session.getReceipts().entries.filter(item => item.toolName === 'restore_project_checkpoint').at(-1).outcome, 'applied')
  } finally { f.close() }
})

for (const origin of ['compound', 'different project']) {
  test(`real restore from ${origin} keeps existing restore behavior without authorizing same-turn continuation`, async () => {
    seedLastPictureTrimCase()
    const checkpoint = await module.exports.runMcpAction('create_project_checkpoint', { label: 'Root restore target', previewOnly: false })
    if (origin === 'compound') {
      const preview = await module.exports.runMcpAction('create_compound', { clipIds: ['picture-1', 'picture-2'], name: 'Synthetic compound', previewOnly: true })
      await module.exports.runMcpAction('create_compound', preview.suggestedApplyPayload)
      const compound = timeline.getState().clips.find(clip => clip.type === 'compound')
      assert.ok(compound)
      const open = await module.exports.runMcpAction('open_compound', { clipId: compound.id, previewOnly: true })
      await module.exports.runMcpAction('open_compound', open.suggestedApplyPayload)
      assert.equal(timeline.getState().compoundEditContext.compoundClipId, compound.id)
    } else {
      project.setState({ currentProjectHandle: '/synthetic/another-project-for-restore' })
    }
    const f = await harness()
    try {
      const before = captureAgentInteractionContext()
      const result = requireSuccess(await f.session.callTool('restore_project_checkpoint', { checkpointId: checkpoint.checkpointId, previewOnly: false })).result
      assert.equal(result.applied, true)
      assert.equal(result.restored, true)
      assert.deepEqual(result.restoreTransition.before, before)
      assert.equal(project.getState().currentProjectHandle, '/synthetic/agent-editing-only')
      assert.equal(timeline.getState().compoundEditContext, null)
      assert.equal(timeline.getState().clips.at(-1).duration, 2)
      assert.equal(f.session.getReceipts().entries.filter(item => item.toolName === 'restore_project_checkpoint').at(-1).outcome, 'unconfirmed')
      const next = await f.session.callTool('get_timeline')
      assert.equal(next.isError, true)
      assert.match(next.content[0].text, /resulting context could not be confirmed/)
    } finally { f.close() }
  })
}

test('checkpoint restore without an actual timeline load cannot report applied', async () => {
  seedLastPictureTrimCase()
  const loadFromProject = timeline.getState().loadFromProject
  const f = await harness()
  try {
    const checkpoint = requireSuccess(await f.session.callTool('create_project_checkpoint', { label: 'Unloaded restore target', previewOnly: false })).result
    requireSuccess(await f.session.callTool('edit_trim', { clipId: 'picture-6', mode: 'normal', edge: 'end', deltaSeconds: 1, previewOnly: false }))
    timeline.setState({ loadFromProject: () => false })
    const response = await f.session.callTool('restore_project_checkpoint', { checkpointId: checkpoint.checkpointId, previewOnly: false })
    assert.equal(response.isError, true)
    assert.match(response.content[0].text, /restore could not be confirmed/)
    assert.equal(timeline.getState().clips.at(-1).duration, 3)
    assert.deepEqual(f.session.getReceipts().entries.filter(item => item.toolName === 'restore_project_checkpoint').map(item => item.outcome), ['preview', 'unconfirmed'])
    const nextEdit = await f.session.callTool('edit_trim', { clipId: 'picture-6', mode: 'normal', edge: 'end', deltaSeconds: 0.5, previewOnly: false })
    assert.equal(nextEdit.isError, true)
    assert.equal(f.requests.filter(item => item.action === 'edit_trim' && item.payload.previewOnly === false).length, 1)
  } finally { timeline.setState({ loadFromProject }); f.close() }
})

for (const saveOutcome of ['unchanged', 'edited', 'failed']) {
  test(`checkpoint restore ${saveOutcome} optional save preserves exact synchronous evidence and does not invent continuation`, async () => {
    seedLastPictureTrimCase()
    const saveProject = project.getState().saveProject
    project.setState({ saveProject: async () => {
      await Promise.resolve()
      if (saveOutcome === 'failed') throw new Error('Synthetic save failed after restore')
      if (saveOutcome === 'edited') timeline.setState(state => ({ clips: state.clips.map(clip => clip.id === 'picture-6' ? { ...clip, name: 'Concurrent synthetic change' } : clip) }))
      return true
    } })
    const f = await harness()
    try {
      const checkpoint = requireSuccess(await f.session.callTool('create_project_checkpoint', { label: 'Restore before optional save', previewOnly: false })).result
      requireSuccess(await f.session.callTool('edit_trim', { clipId: 'picture-6', mode: 'normal', edge: 'end', deltaSeconds: 1, previewOnly: false }))
      const before = captureAgentInteractionContext()
      const response = await f.session.callTool('restore_project_checkpoint', { checkpointId: checkpoint.checkpointId, saveProject: true, previewOnly: false })
      assert.equal(timeline.getState().clips.at(-1).duration, 2, 'The restore really happened even if the save failed or raced.')
      assert.equal(timeline.getState().timelineSessionId, before.context.timelineSessionId + 1)
      if (saveOutcome === 'failed') {
        assert.equal(response.isError, true)
        assert.match(response.content[0].text, /Synthetic save failed/)
      } else {
        const result = requireSuccess(response).result
        assert.equal(result.applied, true)
        assert.deepEqual(result.restoreTransition.before, before)
        assert.equal(result.savedProject, true)
        if (saveOutcome === 'unchanged') assert.deepEqual(result.restoreTransition.after, captureAgentInteractionContext())
        else assert.notDeepEqual(result.restoreTransition.after, captureAgentInteractionContext())
      }
      assert.equal(f.session.getReceipts().entries.filter(item => item.toolName === 'restore_project_checkpoint').at(-1).outcome,
        saveOutcome === 'unchanged' ? 'applied' : 'unconfirmed')
      const inspection = await f.session.callTool('get_timeline')
      if (saveOutcome === 'unchanged') assert.equal(requireSuccess(inspection).clips.at(-1).duration, 2)
      else assert.equal(inspection.isError, true, 'A changed/failed asynchronous save cannot carry authority into the new timeline session.')
      assert.equal(f.requests.filter(item => item.action === 'restore_project_checkpoint' && item.payload.previewOnly === false).length, 1)
    } finally { project.setState({ saveProject }); f.close() }
  })
}

test('checkpoint preview stays a preview; one edit approval creates a real pre-edit checkpoint and preserves Undo', async () => {
  const original = seedLastPictureTrimCase()
  let f
  f = await harness({ approval: details => {
    assert.equal(details.toolName, 'edit_trim', 'Only the edit asks for approval, not its host-owned prerequisite.')
    assert.match(details.warnings.join(' '), /also creates an in-memory Velorn safety checkpoint/)
    assert.equal(f.requests.filter(item => item.action === 'create_project_checkpoint' && item.payload.previewOnly === false).length, 0,
      'No checkpoint may be applied before approving the edit.')
    assert.deepEqual(timeline.getState().clips, original)
    return true
  } })
  try {
    requireSuccess(await f.session.callTool('create_project_checkpoint', { label: 'Model requested preview only', previewOnly: true }))
    assert.equal(f.requests.filter(item => item.action === 'create_project_checkpoint' && item.payload.previewOnly === false).length, 0)
    const args = { clipId: 'picture-6', mode: 'normal', edge: 'end', deltaSeconds: 1, previewOnly: false }
    requireSuccess(await f.session.callTool('edit_trim', args))
    assert.equal(f.approvals.length, 1)
    const checkpointApplies = f.requests.filter(item => item.action === 'create_project_checkpoint' && item.payload.previewOnly === false)
    assert.equal(checkpointApplies.length, 1)
    assert.equal(checkpointApplies[0].payload.label, 'Velorn Agent — before approved undoable edits',
      'The host creates its own checkpoint; it never silently applies the model’s preview-only label.')
    const trimApplies = f.requests.filter(item => item.action === 'edit_trim' && item.payload.previewOnly === false)
    assert.equal(trimApplies.length, 1)
    assert.ok(f.requests.indexOf(checkpointApplies[0]) < f.requests.indexOf(trimApplies[0]))
    assert.equal(timeline.getState().clips.at(-1).duration, 3)
    const last = requireSuccess(await f.session.callTool('get_timeline')).clips.at(-1)
    assert.equal(last.startTime + last.duration, 20)
    const checkpoint = f.responses.find(item => item.id === checkpointApplies[0].id).result
    assert.ok(checkpoint.checkpointId)
    assert.deepEqual(f.session.getReceipts().entries.filter(item => item.outcome === 'applied').map(item => item.toolName),
      ['create_project_checkpoint', 'edit_trim'])
    timeline.getState().undo()
    assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), original)
  } finally { f.close() }
})

test('denying or invalidating an eligible edit approval creates no safety checkpoint and performs no edit', async () => {
  for (const denied of [true, false]) {
    const original = seedLastPictureTrimCase()
    const f = await harness({ approval: () => {
      if (!denied) timeline.setState({ playheadPosition: 1 })
      return !denied
    } })
    try {
      const response = await f.session.callTool('edit_trim', { clipId: 'picture-6', mode: 'normal', edge: 'end', deltaSeconds: 1, previewOnly: false })
      assert.equal(response.isError, true)
      assert.equal(f.approvals.length, 1)
      assert.equal(f.requests.some(item => item.action === 'create_project_checkpoint'), false)
      assert.equal(f.requests.some(item => item.action === 'edit_trim' && item.payload.previewOnly === false), false)
      assert.deepEqual(timeline.getState().clips, original)
    } finally { f.close() }
  }
})

test('malformed trim is not dispatched; corrected operands preview and apply through real guards, approval and Undo', async () => {
  const original = seedLastPictureTrimCase()
  const f = await harness()
  try {
    const invalid = await f.session.callTool('edit_trim', {
      mode: 'normal', deltaSeconds: 1, clipId: '["picture-6"]', expectedContext: {}, previewOnly: true,
    })
    const detail = parse(invalid)
    assert.equal(invalid.isError, true); assert.equal(detail.code, 'INVALID_ARGUMENTS')
    assert.equal(detail.actionExecuted, false)
    assert.deepEqual(detail.error.issues.map(issue => issue.field).sort(), ['clipId', 'edge', 'expectedContext'])
    assert.equal(f.requests.filter(request => request.action === 'edit_trim').length, 0)
    assert.equal(f.approvals.length, 0)
    assert.deepEqual(timeline.getState().clips, original)
    assert.equal(timeline.getState().history.length, 0)

    const args = { clipId: 'picture-6', mode: 'normal', edge: 'end', deltaSeconds: 1 }
    const tool = (await f.session.listTools()).find(item => item.name === 'edit_trim')
    assert.equal(tool.inputSchema.properties.expectedContext, undefined)
    assert.equal(tool.inputSchema.properties.previewToken, undefined)
    requireSuccess(await f.session.callTool('edit_trim', { ...args, previewOnly: true }))
    assert.equal(f.approvals.length, 0)
    assert.deepEqual(timeline.getState().clips, original)
    requireSuccess(await f.session.callTool('create_project_checkpoint', { label: 'Before corrected synthetic trim', previewOnly: false }))
    requireSuccess(await f.session.callTool('edit_trim', { ...args, previewOnly: false }))
    assert.equal(timeline.getState().clips.at(-1).duration, 3)
    assert.deepEqual(timeline.getState().clips.slice(0, -1), original.slice(0, -1))
    const apply = f.requests.filter(request => request.action === 'edit_trim' && request.payload.previewOnly === false)
    assert.equal(apply.length, 1)
    assert.ok(apply[0].payload.previewToken)
    assert.deepEqual(apply[0].payload.expectedContext, apply[0].agentGuard.context)
    assert.equal(f.approvals.filter(item => item.toolName === 'edit_trim').length, 1)
    assert.equal(f.requests.filter(item => item.action === 'create_project_checkpoint' && item.payload.previewOnly === false).length, 1,
      'An explicitly applied, native-proven checkpoint is reused without replacing its chosen label.')
    assert.match(f.approvals.find(item => item.toolName === 'edit_trim').warnings.join(' '), /already created in this message/)
    assert.equal(f.session.getReceipts().entries.filter(item => item.toolName === 'edit_trim' && item.outcome === 'applied').length, 1)
    assert.equal(timeline.getState().history.length, 1)
    timeline.getState().undo()
    assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), original)
  } finally { f.close() }
})

for (const selectedClipIds of [[], ['picture-1', 'picture-6']]) {
  test(`missing primary trim target with ${selectedClipIds.length} selected clips fails before preview; an explicit correction retains checkpoint and Undo`, async () => {
    const original = seedLastPictureTrimCase()
    timeline.setState({ selectedClipIds })
    const f = await harness()
    try {
      const before = requireSuccess(await f.session.callTool('get_timeline'))
      assert.equal(before.clips.at(-1).duration, 2)
      const guard = captureAgentInteractionContext()
      const args = { mode: 'normal', edge: 'end', deltaSeconds: 1, previewOnly: false }
      const invalid = await f.session.callTool('edit_trim', args)
      const detail = parse(invalid)
      assert.equal(invalid.isError, true)
      assert.equal(detail.code, 'INVALID_ARGUMENTS')
      assert.equal(detail.actionExecuted, false)
      assert.equal(detail.outcome, 'not-started')
      assert.deepEqual(detail.error.issues.map(({ field, code }) => ({ field, code })), [
        { field: 'clipId', code: 'trim_target_required' },
      ])
      assert.equal(f.requests.some(item => ['edit_trim', 'create_project_checkpoint'].includes(item.action)), false,
        'Argument rejection precedes even the real renderer edit preview and checkpoint preview.')
      assert.equal(f.approvals.length, 0)
      assert.deepEqual(captureAgentInteractionContext(), guard)
      assert.deepEqual(timeline.getState().clips, original)
      assert.equal(timeline.getState().history.length, 0)

      // Explicit IDs do not require the user to select the intended clip.
      timeline.setState({ selectedClipIds: [] })
      requireSuccess(await f.session.callTool('edit_trim', { ...args, clipId: 'picture-6' }))
      const effects = f.requests.filter(item => ['edit_trim', 'create_project_checkpoint'].includes(item.action))
      assert.deepEqual(effects.map(item => [item.action, item.payload.previewOnly]), [
        ['edit_trim', true], ['create_project_checkpoint', true], ['create_project_checkpoint', false], ['edit_trim', false],
      ])
      assert.equal(f.approvals.length, 1)
      assert.equal(f.approvals[0].toolName, 'edit_trim')
      assert.ok(effects.at(-1).payload.previewToken)
      assert.deepEqual(effects.at(-1).payload.expectedContext, effects.at(-1).agentGuard.context)
      const inspected = requireSuccess(await f.session.callTool('get_timeline'))
      const last = inspected.clips.find(clip => clip.id === 'picture-6')
      assert.equal(last.startTime, 17)
      assert.equal(last.duration, 3)
      assert.equal(last.startTime + last.duration, 20)
      assert.equal(last.trimStart, 0)
      assert.deepEqual(timeline.getState().clips.slice(0, -1), original.slice(0, -1))
      assert.deepEqual(f.session.getReceipts().entries.filter(item => item.outcome === 'applied').map(item => item.toolName),
        ['create_project_checkpoint', 'edit_trim'])
      assert.equal(timeline.getState().history.length, 1)
      timeline.getState().undo()
      assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), original)
    } finally { f.close() }
  })
}

test('single selected clip remains a supported trim target without rewriting its selection or arguments', async () => {
  const original = seedLastPictureTrimCase()
  timeline.setState({ selectedClipIds: ['picture-6'] })
  const f = await harness()
  try {
    requireSuccess(await f.session.callTool('edit_trim', { mode: 'normal', edge: 'end', deltaSeconds: 1, previewOnly: false }))
    assert.equal(f.approvals.length, 1)
    assert.equal(f.approvals[0].arguments.clipId, undefined, 'The host must not invent a model-supplied explicit target.')
    assert.deepEqual(timeline.getState().selectedClipIds, ['picture-6'])
    const trims = f.requests.filter(item => item.action === 'edit_trim')
    assert.deepEqual(trims.map(item => item.payload.previewOnly), [true, false])
    assert.equal(trims.every(item => item.payload.clipId === undefined), true)
    assert.equal(trims.every(item => item.agentGuard.selection.clipIds.length === 1
      && item.agentGuard.selection.clipIds[0] === 'picture-6'), true)
    assert.equal(f.requests.filter(item => item.action === 'create_project_checkpoint' && item.payload.previewOnly === false).length, 1)
    const last = requireSuccess(await f.session.callTool('get_timeline')).clips.at(-1)
    assert.equal(last.startTime + last.duration, 20)
    assert.deepEqual(timeline.getState().clips.slice(0, -1), original.slice(0, -1))
    timeline.getState().undo()
    assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), original)
  } finally { f.close() }
})

test('changing the single selected trim target during approval blocks the checkpoint and edit apply', async () => {
  const original = seedLastPictureTrimCase()
  timeline.setState({ selectedClipIds: ['picture-6'] })
  const f = await harness({ approval: () => {
    timeline.setState({ selectedClipIds: ['picture-5'] })
    return true
  } })
  try {
    const response = await f.session.callTool('edit_trim', { mode: 'normal', edge: 'end', deltaSeconds: 1, previewOnly: false })
    assert.equal(response.isError, true)
    assert.match(response.content[0].text, /changed while approval/)
    assert.equal(f.approvals.length, 1)
    assert.deepEqual(f.requests.filter(item => item.action === 'edit_trim').map(item => item.payload.previewOnly), [true])
    assert.equal(f.requests.some(item => item.action === 'create_project_checkpoint'), false)
    assert.equal(f.session.getReceipts().entries.some(item => item.outcome === 'applied'), false)
    assert.deepEqual(timeline.getState().selectedClipIds, ['picture-5'], 'A rejected approval must not reset the user’s newer selection.')
    assert.deepEqual(timeline.getState().clips, original)
    assert.equal(timeline.getState().history.length, 0)
  } finally { f.close() }
})

test('a genuine legacy selection-based preview token applies its frozen target and cannot be forged or reused', async () => {
  const original = seedLastPictureTrimCase()
  timeline.setState({ selectedClipIds: ['picture-6'] })
  const f = await harness()
  try {
    const preview = requireSuccess(await f.session.callTool('edit_trim', {
      mode: 'normal', edge: 'end', deltaSeconds: 1, previewOnly: true,
    }))
    const apply = preview.suggestedApplyCall.arguments
    assert.equal(apply.clipId, undefined)
    assert.ok(apply.previewToken)
    assert.equal(apply.previewOnly, false)
    const forged = await f.session.callTool('edit_trim', { ...apply, previewToken: 'synthetic-never-issued-preview' })
    assert.equal(forged.isError, true)
    assert.match(forged.content[0].text, /preview expired/i)
    assert.equal(f.approvals.length, 0)
    assert.equal(f.requests.some(item => item.action === 'create_project_checkpoint'), false)
    assert.equal(f.requests.some(item => item.action === 'edit_trim' && item.payload.previewOnly === false), false)
    assert.deepEqual(timeline.getState().clips, original)

    requireSuccess(await f.session.callTool('edit_trim', apply))
    assert.equal(f.approvals.length, 1)
    assert.equal(f.approvals[0].arguments.previewToken, apply.previewToken)
    const trims = f.requests.filter(item => item.action === 'edit_trim' && item.payload.previewOnly === false)
    assert.equal(trims.length, 1)
    assert.equal(trims[0].payload.previewToken, apply.previewToken)
    assert.deepEqual(trims[0].agentGuard.selection.clipIds, ['picture-6'])
    assert.deepEqual(timeline.getState().selectedClipIds, ['picture-6'])
    assert.equal(timeline.getState().clips.at(-1).duration, 3)
    assert.deepEqual(timeline.getState().clips.slice(0, -1), original.slice(0, -1))
    assert.equal(f.requests.filter(item => item.action === 'create_project_checkpoint' && item.payload.previewOnly === false).length, 1)
    timeline.getState().undo()
    assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), original)

    // Omit the old context only to exercise the renderer's consumed-token
    // rejection itself; no current target or replacement token is invented.
    const { expectedContext: _oldContext, ...consumed } = apply
    const reused = await f.session.callTool('edit_trim', consumed)
    assert.equal(reused.isError, true)
    assert.match(reused.content[0].text, /preview expired/i)
    assert.equal(f.approvals.length, 1)
    assert.equal(f.requests.filter(item => item.action === 'edit_trim' && item.payload.previewOnly === false).length, 1)
    assert.equal(f.requests.filter(item => item.action === 'create_project_checkpoint' && item.payload.previewOnly === false).length, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)), original)
  } finally { f.close() }
})

test('clearing selection after a legacy trim preview still reaches the native stale-plan refusal without an edit', async () => {
  const original = seedLastPictureTrimCase()
  timeline.setState({ selectedClipIds: ['picture-6'] })
  const f = await harness()
  try {
    const preview = requireSuccess(await f.session.callTool('edit_trim', {
      mode: 'normal', edge: 'end', deltaSeconds: 1, previewOnly: true,
    }))
    const apply = preview.suggestedApplyCall.arguments
    timeline.setState({ selectedClipIds: [] })
    const response = await f.session.callTool('edit_trim', apply)
    assert.equal(response.isError, true)
    assert.match(response.content[0].text, /timeline changed.*Preview this edit again/i)
    assert.doesNotMatch(response.content[0].text, /INVALID_ARGUMENTS|trim_target_required/,
      'Only the native renderer/store may decide whether a genuine old preview token remains usable.')
    assert.equal(f.approvals.length, 1)
    const trimApplies = f.requests.filter(item => item.action === 'edit_trim' && item.payload.previewOnly === false)
    assert.equal(trimApplies.length, 1, 'The native store receives, but refuses, the stale frozen plan.')
    assert.equal(trimApplies[0].payload.previewToken, apply.previewToken)
    assert.deepEqual(trimApplies[0].agentGuard.selection.clipIds, [])
    assert.equal(f.requests.filter(item => item.action === 'create_project_checkpoint' && item.payload.previewOnly === false).length, 1,
      'The approved prerequisite may already exist when the deeper native edit guard refuses.')
    assert.equal(f.session.getReceipts().entries.some(item => item.toolName === 'edit_trim' && item.outcome === 'applied'), false)
    assert.deepEqual(timeline.getState().selectedClipIds, [])
    assert.deepEqual(timeline.getState().clips, original)
    assert.equal(timeline.getState().history.length, 0)
  } finally { f.close() }
})

test('save during actual checkpoint/trim approvals preserves the real native guard, applied receipts and Undo', async () => {
  const original = seedLastPictureTrimCase()
  const f = await harness({approval: details=>{
    assert.ok(['create_project_checkpoint','edit_trim'].includes(details.toolName))
    const guard = captureAgentInteractionContext()
    const saved = timeline.getState().getProjectData()
    project.setState(state=>({currentProject:{...state.currentProject,modified:'2026-01-01T00:01:00Z',
      timelines:state.currentProject.timelines.map(item=>item.id===state.currentTimelineId
        ? {...item,...saved,modified:'2026-01-01T00:01:00Z'} : item)}}))
    assert.deepEqual(captureAgentInteractionContext(),guard,'Saving unchanged live content must not invalidate approval.')
    return true
  }})
  try {
    assert.equal(requireSuccess(await f.session.callTool('get_timeline')).clips.at(-1).duration,2)
    const checkpoint = requireSuccess(await f.session.callTool('create_project_checkpoint',{label:'Before synthetic restoration',previewOnly:false}))
    assert.ok(checkpoint.result?.checkpointId || checkpoint.checkpointId)
    const args = {clipId:'picture-6',mode:'normal',edge:'end',deltaSeconds:1}
    requireSuccess(await f.session.callTool('edit_trim',{...args,previewOnly:true}))
    assert.deepEqual(timeline.getState().clips,original)
    requireSuccess(await f.session.callTool('edit_trim',{...args,previewOnly:false}))
    const inspected = requireSuccess(await f.session.callTool('get_timeline'))
    const last = inspected.clips.find(clip=>clip.id==='picture-6')
    assert.equal(last.startTime,17); assert.equal(last.duration,3); assert.equal(last.trimStart,0)
    assert.deepEqual(timeline.getState().clips.slice(0,-1),original.slice(0,-1))
    const receipts = f.session.getReceipts().entries
    assert.equal(receipts.filter(item=>item.toolName==='create_project_checkpoint'&&item.outcome==='applied').length,1)
    assert.equal(receipts.filter(item=>item.toolName==='edit_trim'&&item.outcome==='applied').length,1)
    assert.equal(f.requests.filter(item=>item.action==='edit_trim'&&item.payload.previewOnly===false).length,1)
    assert.equal(f.approvals.length,2)
    timeline.getState().undo()
    assert.deepEqual(JSON.parse(JSON.stringify(timeline.getState().clips)),original,'The normal editor Undo restores the pre-test authored timing; discarded transient caches may remain undefined.')
  } finally { f.close() }
})

test('a genuine clip edit while checkpoint approval waits still blocks the native checkpoint apply', async () => {
  seedLastPictureTrimCase()
  const f = await harness({approval:()=>{
    timeline.setState(state=>({clips:state.clips.map(clip=>clip.id==='picture-6'?{...clip,duration:1,trimEnd:1}:clip)}))
    return true
  }})
  try {
    const response = await f.session.callTool('create_project_checkpoint',{label:'Must not apply stale checkpoint',previewOnly:false})
    assert.equal(response.isError,true)
    assert.match(response.content[0].text,/changed while approval/)
    assert.equal(f.requests.filter(item=>item.action==='create_project_checkpoint'&&item.payload.previewOnly===false).length,0)
    assert.equal(f.session.getReceipts().entries.some(item=>item.outcome==='applied'),false)
  } finally { f.close() }
})

test('changing real selection while approval is pending prevents the planned legacy write', async () => {
  const f = await harness({ approval: () => { timeline.setState({ selectedMarkerId: 'changed-during-approval' }); return true } })
  try {
    const response = await f.session.callTool('add_timeline_markers', {
      markers: [{ timeSeconds: 2, label: 'Not approved for this new context' }], previewOnly: false,
    })
    assert.equal(response.isError, true)
    assert.match(response.content[0].text, /changed while approval/)
    assert.equal(timeline.getState().markers.length, 0)
    assert.equal(timeline.getState().history.length, 0)
    assert.equal(f.requests.some(request => request.action === 'add_timeline_markers'), false)
  } finally { f.close() }
})

// Explicit opt-in: this uses the installed Codex CLI's ChatGPT sign-in and
// account limits, not a fake Responses endpoint. All project data and edits
// remain in the RAM-only fixture above. The independent execution allowlist
// prevents the model from dispatching any non-test operation even though it
// sees the complete current catalog. Never enable this in ordinary tests/CI.
test('actual Codex model removes synthetic markers only after host approval', {
  skip: process.env.VELORN_AGENT_CODEX_SMOKE !== '1', timeout: 240000,
}, async t => {
  const { sendCodex } = require('../electron/connectedAgentCodex.cjs')
  const { TOOL_INSTRUCTIONS } = require('../electron/connectedAgent.cjs')
  const markers = [
    { id: 'synthetic-marker-a', time: 2, label: 'Synthetic A', color: '#f97316' },
    { id: 'synthetic-marker-b', time: 6, label: 'Synthetic B', color: '#f97316' },
  ]
  timeline.setState({ markers: structuredClone(markers) })
  const allowedTools = new Set(['get_project', 'get_timeline', 'get_transport_state', 'remove_timeline_markers', 'undo'])
  for (const approved of [false, true]) {
    const f = await harness({ allowedTools, approval: details => {
      assert.ok(['remove_timeline_markers', 'undo'].includes(details.toolName))
      assert.equal(details.arguments.previewOnly, false)
      return approved
    } })
    try {
      const result = await sendCodex({ model: process.env.VELORN_AGENT_CODEX_MODEL || 'gpt-6-astra', images: [],
        context: JSON.stringify({ project: { name: 'Synthetic Agent editing fixture' }, timeline: { id: 'timeline-one' } }),
        messages: [
          { role: 'assistant', content: 'Earlier this conversation was read-only and the code-mode host was disabled.' },
          { role: 'user', content: 'Tools are now enabled. Please inspect the current timeline and remove all its timeline markers. Request the host approval by applying the preview when ready. If approval is denied, stop and tell me. Do not change anything else.' },
        ],
      }, { toolSession: f.session, signal: f.abort.signal, instructions: TOOL_INSTRUCTIONS, timeoutMs: 110000 })
      assert.equal(result.success, true)
      assert.ok(f.approvals.length >= 1, 'The real model must reach the host approval gate, not just describe a plan.')
      const applies = f.requests.filter(request => request.action === 'remove_timeline_markers')
      assert.equal(applies.length, Number(approved), 'Denial must not dispatch; approval must dispatch once.')
      assert.deepEqual(timeline.getState().markers, approved ? [] : markers)
      t.diagnostic(JSON.stringify({ approved, approvalCount: f.approvals.length, applies: applies.length, reply: result.text }))
      if (approved) {
        requireSuccess(await f.session.callTool('undo', { scope: 'timeline', previewOnly: false }))
        assert.deepEqual(timeline.getState().markers, markers, 'Real timeline Undo restores the synthetic markers.')
      }
    } finally { f.abort.abort(); f.close() }
  }
})
