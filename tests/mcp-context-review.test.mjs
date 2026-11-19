import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const priorStorage = globalThis.localStorage
const memoryStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.localStorage = memoryStorage
after(() => { if (priorStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = priorStorage })
const root = fileURLToPath(new URL('../', import.meta.url))
const code = buildSync({ stdin: { contents: `
  export * from './src/services/mcpContext';
  export * from './src/services/mcpSnapshot';
  export * from './src/services/mcpReviewParity';
  export { TIMELINE_PROJECT_KEYS } from './src/services/projectDirtyTracker';
  export { default as timeline } from './src/stores/timelineStore';
  export { default as assets } from './src/stores/assetsStore';
  export { default as project } from './src/stores/projectStore';`, resolveDir: root },
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'zustand', 'zustand/*'],
  loader: { '.glsl': 'text', '.png': 'dataurl', '.svg': 'dataurl' },
}).outputFiles[0].text
const module = { exports: {} }, window = { addEventListener() {}, removeEventListener() {} }
Function('require', 'module', 'exports', 'localStorage', 'window', 'document', code)(require, module, module.exports,
  memoryStorage, window, { createElement: () => ({ getContext: () => null }) })
const { timeline, assets, project, captureMcpContext, assertMcpContext, captureAgentInteractionContext, assertAgentInteractionContext, buildMcpSnapshot, startMcpSnapshotPublisher, TIMELINE_PROJECT_KEYS, MCP_REVIEW_ACTIONS: actions } = module.exports
const initial = timeline.getState()
beforeEach(() => {
  project.setState({ currentProjectHandle: '/synthetic/review', currentTimelineId: 'tl', storyboardRevision: 0, currentProject: {
    name: 'Review fixture', settings: { width: 1920, height: 1080, fps: 24 }, timelines: [{ id: 'tl', name: 'Main' }] } })
  assets.setState({ assets: [{ id: 'media', type: 'video', url: 'memory:test', settings: { fps: 24 }, generatedMusic: { backend: 'yue2' } }], folders: [], currentPreview: null })
  timeline.setState({ ...initial, timelineSessionId: timeline.getState().timelineSessionId + 1,
    clips: [{ id: 'a', assetId: 'media', trackId: 'v', type: 'video', startTime: 0, duration: 2, trimStart: 1, trimEnd: 3,
      sourceDuration: 10, sourceFps: 24, timelineFps: 24, speed: 1, reverse: false, gainDb: -4,
      volumeEnvelope: { points: [{ time: 0, gainDb: -3 }], offsetSeconds: 0 }, audioEq: { enabled: true }, bypass: { effects: true },
      adjustments: { temperature: 2 }, captions: { cues: [{ start: 0, end: 1, text: 'Test' }] }, effects: [], frameSampling: 'nearest' }],
    tracks: [{ id: 'v', type: 'video' }], transitions: [], markers: [], timelineFps: 24, playheadPosition: 1,
    duration: 2, inPoint: 0.5, outPoint: 1.5, history: [], historyIndex: -1, selectedClipIds: ['a'] })
})

// Model the final immutable store replacement in saveProject without writing
// any project files. The saved active copy may lag behind the current edit.
const saveShapedReplacement = () => {
  const state = project.getState()
  const data = timeline.getState().getProjectData()
  project.setState({
    currentProject: { ...state.currentProject,
      timelines: state.currentProject.timelines.map(item => item.id === state.currentTimelineId
        ? { ...item, ...data, modified: new Date().toISOString() } : item),
      assets: assets.getState().getProjectData(), folders: assets.getState().folders,
      thumbnail: 'project-thumbnail.webp', modified: new Date().toISOString() },
    lastAutoSave: new Date().toISOString(),
  })
}
const updateSavedTimeline = (id, patch) => {
  const current = project.getState().currentProject
  project.setState({ currentProject: { ...current,
    timelines: current.timelines.map(item => item.id === id ? { ...item, ...patch } : item) } })
}

test('unchanged save keeps document and approval guards valid even when the saved active copy was stale', () => {
  updateSavedTimeline('tl', { clips: [], tracks: [], duration: 60, zoom: 10,
    modified: '2020-01-01T00:00:00.000Z', color: '#123456', folderId: 'folder', customMetadata: { note: 'Keep' } })
  const guard = captureAgentInteractionContext()
  const liveBefore = timeline.getState()
  const savedBefore = project.getState().currentProject.timelines
  saveShapedReplacement()
  assert.notEqual(project.getState().currentProject.timelines, savedBefore)
  assert.equal(project.getState().currentProject.timelines[0].clips[0].duration, 2)
  assert.equal(timeline.getState(), liveBefore)
  assert.deepEqual(captureAgentInteractionContext(), guard)
  assert.doesNotThrow(() => assertMcpContext(guard.context, 'preview'))
  assert.doesNotThrow(() => assertAgentInteractionContext(guard, 'create_project_checkpoint'))
  saveShapedReplacement()
  assert.deepEqual(captureAgentInteractionContext(), guard)
})
test('active saved-document exclusions match the real timeline serialization contract', () => {
  assert.deepEqual(Object.keys(timeline.getState().getProjectData()).sort(), [...TIMELINE_PROJECT_KEYS].sort())
})
test('actual saveProject with memory-only filesystem keeps a pending checkpoint guard valid', async () => {
  const writes = new Map()
  window.electronAPI = { isElectron: true, pathJoin: async (...parts) => parts.join('/'),
    createDirectory: async () => ({ success: true }),
    writeFile: async (path, content) => { writes.set(path, JSON.parse(content)); return { success: true } },
    listDirectory: async () => ({ success: true, items: [] }) }
  try {
    const guard = captureAgentInteractionContext(), liveBefore = timeline.getState()
    const projectBefore = project.getState().currentProject
    assert.equal(await project.getState().saveProject(), true)
    assert.equal(writes.size, 2, 'project and autosave written only to a test Map')
    assert.notEqual(project.getState().currentProject.timelines, projectBefore.timelines)
    assert.equal(timeline.getState(), liveBefore)
    assert.deepEqual(captureAgentInteractionContext(), guard)
    assert.doesNotThrow(() => assertAgentInteractionContext(guard, 'create_project_checkpoint'))
  } finally { delete window.electronAPI }
})
test('equivalent inactive timeline copies and object-key ordering do not invalidate a save', () => {
  const current = project.getState().currentProject
  project.setState({ currentProject: { ...current, timelines: [...current.timelines,
    { id: 'other', name: 'Other', modified: 'old', clips: [{ id: 'b', duration: 4 }], customMetadata: { first: 1, second: 2 } }] } })
  const guard = captureAgentInteractionContext()
  updateSavedTimeline('other', { modified: 'new', clips: [{ duration: 4, id: 'b' }], customMetadata: { second: 2, first: 1 } })
  saveShapedReplacement()
  assert.deepEqual(captureAgentInteractionContext(), guard)
})
test('active and inactive timeline metadata remains guarded, including unknown and nested fields', () => {
  const current = project.getState().currentProject
  project.setState({ currentProject: { ...current, timelines: [...current.timelines, { id: 'other', name: 'Other' }] } })
  for (const id of ['tl', 'other']) {
    for (const patch of [{ name: 'Renamed' }, { color: '#654321' }, { folderId: 'new-folder' },
      { width: 1080 }, { height: 1920 }, { fps: 30 }, { created: 'new-created' },
      { customMetadata: { note: 'Authored' } }, { customMetadata: { modified: 'nested authored field' } }]) {
      const guard = captureAgentInteractionContext()
      updateSavedTimeline(id, patch)
      assert.throws(() => assertAgentInteractionContext(guard, 'edit'), /changed/)
    }
  }
})
test('inactive timeline content and timeline membership/order changes still invalidate approval', () => {
  const current = project.getState().currentProject
  project.setState({ currentProject: { ...current, timelines: [...current.timelines, { id: 'other', name: 'Other' }] } })
  for (const patch of [{ clips: [{ id: 'b', duration: 4 }] }, { clips: [{ id: 'b', duration: 5 }] },
    { tracks: [{ id: 'v2', muted: true }] }, { transitions: [{ id: 'fade', duration: 1 }] },
    { markers: [{ id: 'm', time: 3 }] }, { duration: 90 }, { masterAudioInserts: [{ type: 'eq' }] }]) {
    const guard = captureAgentInteractionContext()
    updateSavedTimeline('other', patch)
    assert.throws(() => assertAgentInteractionContext(guard, 'edit'), /changed/)
  }
  for (const mutate of [items => [...items, { id: 'third' }], items => [...items].reverse(), items => items.slice(1)]) {
    const guard = captureAgentInteractionContext(), state = project.getState().currentProject
    project.setState({ currentProject: { ...state, timelines: mutate(state.timelines) } })
    assert.throws(() => assertAgentInteractionContext(guard, 'edit'), /changed/)
  }
})
test('live authored data remains guarded before and after passive saves', () => {
  const projectPatch = patch => project.setState({ currentProject: { ...project.getState().currentProject, ...patch } })
  for (const mutate of [
    () => timeline.setState({ clips: timeline.getState().clips.map(clip => ({ ...clip, duration: 1 })) }),
    () => timeline.setState({ duration: 50 }),
    () => timeline.setState({ tracks: timeline.getState().tracks.map(track => ({ ...track, muted: true })) }),
    () => timeline.setState({ transitions: [{ id: 'fade' }] }),
    () => timeline.setState({ markers: [{ id: 'marker', time: 1 }] }),
    () => timeline.setState({ masterAudioVolume: 0.5 }),
    () => timeline.setState({ masterAudioInserts: [{ type: 'eq' }] }),
    () => projectPatch({ settings: { ...project.getState().currentProject.settings, fps: 30 } }),
    () => assets.setState({ assets: [...assets.getState().assets, { id: 'second' }] }),
    () => assets.setState({ folders: [{ id: 'folder' }] }),
    () => projectPatch({ storyboard: { shots: [{ id: 'shot' }] } }),
    () => project.setState({ storyboardRevision: project.getState().storyboardRevision + 1 }),
  ]) {
    saveShapedReplacement()
    const guard = captureAgentInteractionContext()
    mutate()
    assert.throws(() => assertAgentInteractionContext(guard, 'edit'), /changed/)
    saveShapedReplacement()
    assert.throws(() => assertAgentInteractionContext(guard, 'edit'), /changed/)
  }
})
test('unchanged captures and active saves reuse inactive fingerprints instead of walking clip data again', () => {
  let reads = 0
  const current = project.getState().currentProject
  project.setState({ currentProject: { ...current, timelines: [...current.timelines,
    { id: 'other', clips: [{ id: 'b', get duration() { reads += 1; return 4 } }] }] } })
  const guard = captureAgentInteractionContext(), firstReads = reads
  assert.ok(firstReads > 0)
  for (let index = 0; index < 30; index += 1) assert.deepEqual(captureAgentInteractionContext(), guard)
  saveShapedReplacement()
  assert.deepEqual(captureAgentInteractionContext(), guard)
  assert.equal(reads, firstReads)
})
test('malformed timeline metadata fails closed on repeated captures without poisoning the cache', () => {
  const current = project.getState().currentProject
  project.setState({ currentProject: { ...current, timelines: [...current.timelines, { id: 'other', name: 'Other' }] } })
  const cyclic = {}; cyclic.self = cyclic
  let nested = {}; for (let index = 0; index < 140; index += 1) nested = { nested }
  const throwing = { get invalid() { throw new Error('Synthetic metadata read failure') } }
  const failures = [[cyclic, /cyclic or excessively nested/], [nested, /cyclic or excessively nested/],
    [throwing, /Synthetic metadata read failure/], [{ unsupported: 1n }, /BigInt/]]
  for (const [index, [customMetadata, errorPattern]] of failures.entries()) {
    const guard = captureAgentInteractionContext()
    updateSavedTimeline('other', { customMetadata })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(() => assertAgentInteractionContext(guard, 'edit'), errorPattern)
    }
    updateSavedTimeline('other', { customMetadata: { note: `Repaired ${index}` } })
    assert.throws(() => assertAgentInteractionContext(guard, 'edit'), /changed/)
    assert.doesNotThrow(() => assertAgentInteractionContext(captureAgentInteractionContext(), 'fresh preview'))
  }
})

test('context is serializable and stable across playback, selection and presentation changes', () => {
  const context = captureMcpContext()
  assert.deepEqual(JSON.parse(JSON.stringify(context)), context)
  timeline.setState({ playheadPosition: 1.2, isPlaying: true, zoom: 120, selectedClipIds: [] })
  assert.deepEqual(captureMcpContext(), context)
  assert.doesNotThrow(() => assertMcpContext(context))
})
test('agent approval guard additionally freezes real selection, asset preview and playhead, not presentation layout', () => {
  for (const mutate of [() => timeline.setState({ playheadPosition: 1.2 }),
    () => timeline.setState({ selectedClipIds: [] }),
    () => timeline.setState({ activeTrackId: 'other-track' }),
    () => timeline.setState({ selectedMarkerId: 'another-marker' }),
    () => assets.setState({ currentPreview: { id: 'other-media' } })]) {
    const guard = captureAgentInteractionContext()
    assert.doesNotThrow(() => assertAgentInteractionContext(guard, 'synthetic edit'))
    mutate()
    assert.throws(() => assertAgentInteractionContext(guard, 'synthetic edit'), /changed/)
  }
  const guard = captureAgentInteractionContext()
  timeline.setState({ zoom: 150 })
  assert.doesNotThrow(() => assertAgentInteractionContext(guard, 'synthetic edit'))
  assert.doesNotThrow(() => assertAgentInteractionContext(undefined, 'legacy external edit'))
  assert.throws(() => assertAgentInteractionContext({}, 'invalid agent edit'), /changed/)
})
test('context rejects authored revisions, timeline switches, reloads and project close', () => {
  for (const mutate of [() => timeline.setState({ clips: [...timeline.getState().clips] }),
    () => timeline.getState().setInPoint(0.2), () => project.setState({ currentTimelineId: 'other' }),
    () => timeline.setState({ timelineSessionId: timeline.getState().timelineSessionId + 1 }),
    () => project.setState({ currentProject: null })]) {
    const context = captureMcpContext(); mutate(); assert.throws(() => assertMcpContext(context), /changed/)
  }
})
test('legacy context omission works; malformed explicit context is rejected', () => {
  assert.doesNotThrow(() => assertMcpContext(undefined))
  for (const value of [null, {}, [], 'x', { ...captureMcpContext(), session: 'prior-renderer' }]) assert.throws(() => assertMcpContext(value), /changed/)
})
test('active sequence dimensions invalidate plans even when project defaults did not change', () => {
  const context = captureMcpContext(), current = project.getState().currentProject
  project.setState({ currentProject: { ...current, timelines: [{ ...current.timelines[0], width: 1080, height: 1920 }] } })
  assert.throws(() => assertMcpContext(context), /changed/)
})
test('snapshot reads all new authored fields, music provenance and transport without state writes', () => {
  const before = timeline.getState(), result = buildMcpSnapshot(), clip = result.currentTimeline.clips[0]
  assert.equal(timeline.getState(), before); assert.equal(result.schemaVersion, 2)
  assert.equal(clip.gainDb, -4); assert.equal(clip.volumeEnvelope.points[0].gainDb, -3)
  assert.equal(clip.audioEq.enabled, true); assert.equal(clip.bypass.effects, true)
  assert.equal(clip.adjustments.temperature, 2); assert.equal(clip.captions.cues[0].text, 'Test')
  assert.equal(result.assets[0].generatedMusic.backend, 'yue2'); assert.equal(result.currentTimeline.inPoint, 0.5)
  assert.equal(result.editingContext.kind, 'timeline')
})
test('transport preview is read-only; apply uses native actions without document history', () => {
  const before = timeline.getState()
  assert.equal(actions.control_transport({ operation: 'play', rate: -0.125 }).previewOnly, true)
  assert.equal(timeline.getState(), before)
  actions.control_transport({ operation: 'play', rate: -0.125, previewOnly: false })
  assert.equal(timeline.getState().isPlaying, true); assert.equal(timeline.getState().playbackRate, -0.125)
  actions.control_transport({ operation: 'pause', previewOnly: false })
  actions.control_transport({ operation: 'step', frames: -2, previewOnly: false })
  assert.equal(timeline.getState().playheadPosition, 22 / 24)
  actions.control_transport({ operation: 'loop', mode: 'loop-in-out', previewOnly: false })
  assert.equal(timeline.getState().loopMode, 'loop-in-out'); assert.equal(timeline.getState().history, before.history)
  assert.equal(timeline.getState().clips, before.clips)
})
test('transport rejects unknown controls, invalid speeds/frame steps and missing ranges', () => {
  for (const payload of [{ operation: 'wrong' }, { operation: 'play', rate: 99 }, { operation: 'step', frames: 0 },
    { operation: 'step', frames: 1.5 }, { operation: 'play_around', centerSeconds: 999 }]) assert.throws(() => actions.control_transport(payload))
  timeline.setState({ inPoint: null, outPoint: null })
  assert.throws(() => actions.control_transport({ operation: 'loop', mode: 'loop-in-out' }), /In and Out/)
})
test('source readback uses last retained edge and correct reverse source mapping without seeking', async () => {
  const before = timeline.getState()
  const result = await actions.inspect_source_frame({ clipId: 'a', edge: 'right', includeImage: false })
  assert.equal(result.timelineSeconds, 47 / 24); assert.ok(Math.abs(result.source.sourceTime - (1 + 47 / 24)) < 0.00001)
  assert.equal(timeline.getState(), before)
  timeline.setState({ clips: [{ ...before.clips[0], reverse: true }] })
  const reverse = await actions.inspect_source_frame({ clipId: 'a', edge: 'right', includeImage: false })
  assert.ok(Math.abs(reverse.source.sourceTime - (3 - 47 / 24)) < 0.00001)
  await assert.rejects(actions.inspect_source_frame({ clipId: 'a', timelineSeconds: 2 }), /end boundary/)
})
test('continuous playback changes do not starve snapshot publishing', async () => {
  const sent = []
  window.electronAPI = { mcp: { updateSnapshot: snapshot => { sent.push(snapshot) } } }
  const stop = startMcpSnapshotPublisher({ debounceMs: 20, heartbeatMs: 1000 })
  const timer = setInterval(() => timeline.setState({ playheadPosition: Math.random() }), 3)
  try { await new Promise(resolve => setTimeout(resolve, 100)); assert.ok(sent.length >= 3) }
  finally { clearInterval(timer); stop(); delete window.electronAPI }
})
