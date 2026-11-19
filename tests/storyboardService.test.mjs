import test, { beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const previousStorage = globalThis.localStorage
const syntheticStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.localStorage = syntheticStorage
after(() => { if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage })
const memoryFiles = new Map()
let saveWait = null
let thumbnailWait = null
const fileSystem = {
  isElectron: () => false, verifyPermission: async () => true,
  storeDirectoryHandle: async () => {}, removeStoredDirectoryHandle: async () => {},
  loadProject: async handle => structuredClone(memoryFiles.get(handle)),
  saveProject: async (handle, project) => { if (saveWait) await saveWait; memoryFiles.set(handle, structuredClone(project)) },
  getProjectFileUrl: async (_handle, path) => `synthetic:${path}`,
  getAbsoluteFileUrl: async path => `synthetic:${path}`,
}
const bundled = await build({ stdin: { contents: `
  export * from './src/services/storyboard.js';
  export * from './src/services/projectDirtyTracker.js';
  export { default as project } from './src/stores/projectStore.js';
  export { default as timeline } from './src/stores/timelineStore.js';
  export { default as assets } from './src/stores/assetsStore.js';
  export { default as exportActivity } from './src/stores/exportActivityStore.js';
  export { claimAssetRemoval } from './src/services/assetRemovalPlan.mjs';
`, resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false,
  format: 'cjs', platform: 'node', supported: { 'dynamic-import': false }, external: ['react', 'zustand', 'zustand/*'],
  plugins: [{ name: 'synthetic-persistence-only', setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)fileSystem(?:\.js)?$/ }, () => ({ path: 'storyboard-test-fs', external: true }))
    builder.onResolve({ filter: /(?:^|\/)projectThumbnail(?:\.js)?$/ }, () => ({ path: 'storyboard-test-thumbnail', external: true }))
  } }],
})
const module = { exports: {} }
Function('require', 'module', 'exports', 'localStorage', bundled.outputFiles[0].text)(name => {
  if (name === 'storyboard-test-fs') return fileSystem
  if (name === 'storyboard-test-thumbnail') return { captureAndSaveProjectThumbnail: async () => { if (thumbnailWait) await thumbnailWait; return null } }
  return require(name)
}, module, module.exports, syntheticStorage)
const { project, timeline, assets, exportActivity, getStoryboard, getStoryboardRevision,
  previewStoryboardEdit, applyStoryboardEdit, getProductionRun, createStoryboardService, isProjectDirty, markProjectClean, attachProjectDirtyWatchers, claimAssetRemoval } = module.exports
const initialProject = project.getState(), initialTimeline = timeline.getState(), initialAssets = assets.getState()
const handle = { name: 'Synthetic storyboard project' }
const sourceAssets = [{ id: 'image', type: 'image', name: 'Still' }, { id: 'video', type: 'video', hasAudio: true }, { id: 'audio', type: 'audio' }]
const baseTimeline = () => ({ id: 'main', name: 'Timeline 1', duration: 60, tracks: [{ id: 'v1', type: 'video' }], clips: [], transitions: [] })
const baseProject = () => ({ name: 'Synthetic project', settings: { fps: 24, width: 1920, height: 1080 },
  timelines: [baseTimeline()], currentTimelineId: 'main', assets: structuredClone(sourceAssets), folders: [], folderCounter: 1 })
let unwatch
beforeEach(() => {
  saveWait = null; thumbnailWait = null; memoryFiles.clear()
  timeline.setState({ ...initialTimeline, compoundEditContext: null, tracks: [{ id: 'v1', type: 'video' }], clips: [], transitions: [], history: [], historyIndex: -1, historyLastChangedAt: 0 })
  assets.setState({ ...initialAssets, assets: structuredClone(sourceAssets), folders: [] })
  project.setState({ ...initialProject, currentProject: baseProject(), currentProjectHandle: handle,
    currentTimelineId: 'main', projectHistory: [], projectFuture: [], isLoading: false, storyboardRevision: getStoryboardRevision() + 1 })
  exportActivity.setState({ activeJob: null, localActivity: null, localActivities: {} })
  unwatch = attachProjectDirtyWatchers({ projectStore: project, timelineStore: timeline, assetsStore: assets })
  markProjectClean()
})
afterEach(() => { unwatch?.(); saveWait = null; thumbnailWait = null })
const add = (title = 'Opening') => applyStoryboardEdit({ operation: 'add_shot', shot: { title } })
const unchanged = action => {
  const before = project.getState(), board = before.currentProject?.storyboard
  const result = action()
  assert.equal(project.getState(), before)
  assert.equal(project.getState().currentProject?.storyboard, board)
  return result
}

test('production progress and clip baselines persist through save/reopen; Undo is metadata-only', async () => {
  const shotId = add('Production memory').shotId
  applyStoryboardEdit({ operation: 'update_shot', shotId, patch: { storyboardAssetId: 'image' } })
  const clip = { id: 'clip-memory', assetId: 'image', type: 'image', trackId: 'v1', startTime: 0, duration: 5 }
  timeline.setState({ clips: [clip] })
  const bind = previewStoryboardEdit({ operation: 'bind_shot', shotId, slot: 'animatic', timelineId: 'main', clipId: clip.id })
  applyStoryboardEdit(bind.suggestedApplyPayload)
  applyStoryboardEdit({ operation: 'record_attempt', shotId, attemptId: 'attempt-memory', recipe: {
    model: 'Chosen model', workflow: 'Audition', inputAssetIds: ['image'] } })
  applyStoryboardEdit({ operation: 'update_attempt', attemptId: 'attempt-memory', patch: { state: 'uncertain' } })
  const run = getProductionRun().run, live = timeline.getState()
  project.getState().undoTimelineStructureChange()
  assert.equal(getProductionRun().run.attempts[0].state, 'planned')
  assert.equal(timeline.getState(), live)
  project.getState().redoTimelineStructureChange()
  assert.deepEqual(getProductionRun().run, run)
  assert.equal(await project.getState().saveProject(), true)
  assert.deepEqual(memoryFiles.get(handle).storyboard.productionRun, run)
  assert.ok(await project.getState().openProject(handle))
  assert.deepEqual(getProductionRun().run, run)
  assert.equal(getProductionRun().inspection.bindings[0].current.duration, 5)
  const missing = structuredClone(project.getState().currentProject)
  missing.timelines = []; project.setState({ currentProject: missing })
  assert.equal(getProductionRun().inspection.bindings[0].status, 'missing-timeline')
  assert.deepEqual(getProductionRun().run, run, 'Inspection keeps orphaned history for repair')
})

test('binding preview rechecks authored clip values even without a changed store reference', () => {
  const shotId = add().shotId
  applyStoryboardEdit({ operation: 'update_shot', shotId, patch: { storyboardAssetId: 'image' } })
  const clip = { id: 'bind-live', assetId: 'image', type: 'image', trackId: 'v1', startTime: 0, duration: 5 }
  timeline.setState({ clips: [clip] })
  const preview = previewStoryboardEdit({ operation: 'bind_shot', shotId, slot: 'animatic', timelineId: 'main', clipId: clip.id })
  clip.duration = 3
  assert.throws(() => applyStoryboardEdit(preview.suggestedApplyPayload), /changed after preview/)
  assert.equal(getProductionRun().run, null)
})

test('inherited timeline settings are stable across navigation and changes remain detectable', async () => {
  const shotId = add().shotId
  applyStoryboardEdit({ operation: 'update_shot', shotId, patch: { storyboardAssetId: 'image' } })
  timeline.setState({ timelineFps: 24, clips: [{ id: 'clip-settings', assetId: 'image', type: 'image', trackId: 'v1', startTime: 0, duration: 5 }] })
  applyStoryboardEdit({ operation: 'bind_shot', shotId, slot: 'animatic', timelineId: 'main', clipId: 'clip-settings' })
  assert.equal(getProductionRun().inspection.bindings[0].status, 'linked')
  const nextId = project.getState().createTimeline({ name: 'Other timeline' }).id
  assert.equal(await project.getState().switchTimeline(nextId), true)
  assert.equal(getProductionRun().inspection.bindings[0].status, 'linked', 'A navigation is not an authored shot change')
  const p = project.getState().currentProject
  project.setState({ currentProject: { ...p, settings: { ...p.settings, width: 1280, height: 720 } } })
  assert.equal(getProductionRun().inspection.bindings[0].status, 'changed', 'Inherited resolution affects the authored view')
})

test('unsupported production-run versions survive disk round trip unchanged and are read-only', async () => {
  const board = { version: 1, title: 'Future', brief: '', songAssetId: null, shots: [],
    productionRun: { version: 99, futureData: { keep: true } } }
  memoryFiles.set(handle, { ...baseProject(), storyboard: board })
  assert.ok(await project.getState().openProject(handle))
  assert.throws(getProductionRun, /read-only/)
  assert.throws(() => applyStoryboardEdit({ operation: 'update_run', patch: {} }), /read-only/)
  assert.equal(await project.getState().saveProject(), true)
  assert.deepEqual(memoryFiles.get(handle).storyboard, board)
})

test('read, preview and no-op do not persist or dirty; one apply produces one shared Undo entry', () => {
  const live = timeline.getState()
  assert.equal(unchanged(getStoryboard).shots.length, 0)
  assert.equal(isProjectDirty(), false)
  const preview = unchanged(() => previewStoryboardEdit({ operation: 'add_shot', shot: { title: 'Opening' } }))
  assert.equal(isProjectDirty(), false)
  assert.equal(project.getState().projectHistory.length, 0)
  const applied = applyStoryboardEdit(preview.suggestedApplyPayload)
  assert.equal(applied.shotId, preview.shotId)
  assert.equal(project.getState().projectHistory.length, 1)
  assert.equal(project.getState().projectHistory[0].type, 'storyboard')
  assert.equal(isProjectDirty(), true)
  assert.equal(timeline.getState(), live)
  applied.board.shots[0].title = 'Caller mutation'
  assert.equal(getStoryboard().shots[0].title, 'Opening')
  markProjectClean()
  assert.equal(unchanged(() => applyStoryboardEdit({ operation: 'update_board', patch: {} })).changed, false)
  assert.equal(isProjectDirty(), false)
  assert.equal(project.getState().undoTimelineStructureChange(), true)
  assert.equal(Object.hasOwn(project.getState().currentProject, 'storyboard'), false)
  assert.equal(timeline.getState(), live, 'Board Undo never reloads timeline/media/history')
  assert.equal(isProjectDirty(), true)
  assert.equal(project.getState().redoTimelineStructureChange(), true)
  assert.equal(getStoryboard().shots[0].id, preview.shotId)
  assert.equal(timeline.getState(), live)
  assert.ok(getStoryboardRevision() > applied.revision)
})

test('preview tokens are one-use, payload-specific, state-specific and validate current assets', () => {
  const first = previewStoryboardEdit({ operation: 'add_shot', shot: { title: 'First' } })
  unchanged(() => assert.throws(() => applyStoryboardEdit({ ...first.suggestedApplyPayload, shot: { title: 'Altered' } }), /stale/))
  unchanged(() => assert.throws(() => applyStoryboardEdit(first.suggestedApplyPayload), /stale/))
  const stale = previewStoryboardEdit({ operation: 'update_board', patch: { title: 'Preview' } })
  add()
  unchanged(() => assert.throws(() => applyStoryboardEdit(stale.suggestedApplyPayload), /stale/))
  const shotId = getStoryboard().shots[0].id
  const attach = previewStoryboardEdit({ operation: 'attach_take', shotId, assetId: 'image' })
  assets.setState({ assets: sourceAssets.filter(asset => asset.id !== 'image') })
  unchanged(() => assert.throws(() => applyStoryboardEdit(attach.suggestedApplyPayload), /missing from this project/))
  assets.setState({ assets: sourceAssets })
  unchanged(() => assert.throws(() => applyStoryboardEdit(attach.suggestedApplyPayload), /stale/))
  assert.equal(project.getState().projectHistory.length, 1)
})

test('export, asset-removal, loading, compound focus and absent-project guards prevent writes and previews', () => {
  const request = { operation: 'update_board', patch: { title: 'Blocked' } }
  const blocked = (pattern, service = { previewStoryboardEdit, applyStoryboardEdit }) => {
    unchanged(() => assert.throws(() => service.previewStoryboardEdit(request), pattern))
    unchanged(() => assert.throws(() => service.applyStoryboardEdit(request), pattern))
  }
  exportActivity.setState({ activeJob: { jobId: 'synthetic' } }); blocked(/export/)
  exportActivity.setState({ activeJob: null })
  const release = claimAssetRemoval(); blocked(/Asset removal/); release()
  blocked(/compound/, createStoryboardService({ timelineStore: { getState: () => ({ compoundEditContext: {} }) } }))
  project.setState({ isLoading: true }); blocked(/opening/)
  project.setState({ isLoading: false, currentProject: null }); blocked(/Open a project/)
  assert.equal(isProjectDirty(), true, 'Fixture project removal is authored state; denied operations do not clear it')
})

test('typed storyboard history composes with timeline-structure Undo and leaves independent timeline edits intact', () => {
  const shot = add('First board')
  project.getState().createTimeline({ name: 'Second timeline' })
  applyStoryboardEdit({ operation: 'update_board', patch: { brief: 'Later board edit' } })
  const liveClips = [{ id: 'live-clip', type: 'image', assetId: 'image', trackId: 'v1', startTime: 0, duration: 2 }]
  timeline.setState({ clips: liveClips })
  project.getState().undoTimelineStructureChange()
  assert.equal(getStoryboard().brief, '')
  assert.equal(project.getState().currentProject.timelines.length, 2)
  assert.equal(timeline.getState().clips, liveClips, 'Board Undo does not replace later live clip edits')
  project.getState().undoTimelineStructureChange()
  assert.equal(project.getState().currentProject.timelines.length, 1)
  assert.equal(getStoryboard().shots[0].id, shot.shotId)
  project.getState().undoTimelineStructureChange()
  assert.equal(Object.hasOwn(project.getState().currentProject, 'storyboard'), false)
  project.getState().redoTimelineStructureChange()
  assert.equal(getStoryboard().shots[0].id, shot.shotId)
  project.getState().redoTimelineStructureChange()
  assert.equal(project.getState().currentProject.timelines.length, 2)
  project.getState().redoTimelineStructureChange()
  assert.equal(getStoryboard().brief, 'Later board edit')
})

test('new board edits clear redo and use the existing bounded project history', () => {
  add()
  for (let index = 0; index < 30; index += 1) applyStoryboardEdit({ operation: 'update_board', patch: { title: `Board ${index}` } })
  assert.equal(project.getState().projectHistory.length, 25)
  project.getState().undoTimelineStructureChange()
  assert.equal(project.getState().projectFuture.length, 1)
  applyStoryboardEdit({ operation: 'update_board', patch: { title: 'New branch' } })
  assert.equal(project.getState().projectFuture.length, 0)
})

test('save/open preserves optional boards and stable IDs; project switching resets history and invalidates previews', async () => {
  const shot = add()
  applyStoryboardEdit({ operation: 'attach_take', shotId: shot.shotId, assetId: 'video', label: 'Choice' })
  applyStoryboardEdit({ operation: 'update_board', patch: { songAssetId: 'audio' } })
  const savedBoard = getStoryboard()
  assert.equal(await project.getState().saveProject(), true)
  assert.deepEqual(memoryFiles.get(handle).storyboard, savedBoard)
  assert.equal(isProjectDirty(), false)
  const preview = previewStoryboardEdit({ operation: 'update_board', patch: { title: 'Stale after reopen' } })
  const beforeRevision = getStoryboardRevision()
  assert.ok(await project.getState().openProject(handle))
  assert.deepEqual(getStoryboard(), savedBoard)
  assert.equal(project.getState().projectHistory.length, 0)
  assert.equal(project.getState().projectFuture.length, 0)
  assert.ok(getStoryboardRevision() > beforeRevision)
  assert.equal(isProjectDirty(), false)
  unchanged(() => assert.throws(() => applyStoryboardEdit(preview.suggestedApplyPayload), /stale/))
  const legacyHandle = { name: 'Legacy synthetic project' }
  memoryFiles.set(legacyHandle, baseProject())
  await project.getState().openProject(legacyHandle)
  assert.equal(getStoryboard().shots.length, 0)
  assert.equal(Object.hasOwn(project.getState().currentProject, 'storyboard'), false)
  assert.equal(await project.getState().saveProject(), true)
  assert.equal(Object.hasOwn(memoryFiles.get(legacyHandle), 'storyboard'), false)
})

test('future schema survives save/open unchanged and cannot be edited', async () => {
  const future = { version: 99, arbitrary: { keep: ['exactly'] }, shots: [{ unknown: true }] }
  memoryFiles.set(handle, { ...baseProject(), storyboard: future })
  assert.ok(await project.getState().openProject(handle))
  unchanged(() => assert.throws(getStoryboard, /read-only/))
  unchanged(() => assert.throws(() => add(), /read-only/))
  assert.equal(await project.getState().saveProject(), true)
  assert.deepEqual(memoryFiles.get(handle).storyboard, future)
})

test('closing a project clears board history and a prior preview cannot edit the next project', async () => {
  add()
  const preview = previewStoryboardEdit({ operation: 'update_board', patch: { title: 'Old project' } })
  const previousRevision = getStoryboardRevision()
  await project.getState().closeProject()
  assert.equal(project.getState().currentProject, null)
  assert.equal(project.getState().projectHistory.length, 0)
  assert.equal(project.getState().projectFuture.length, 0)
  assert.ok(getStoryboardRevision() > previousRevision)
  const nextHandle = { name: 'Next synthetic project' }
  memoryFiles.set(nextHandle, baseProject())
  await project.getState().openProject(nextHandle)
  unchanged(() => assert.throws(() => applyStoryboardEdit(preview.suggestedApplyPayload), /stale/))
  assert.equal(Object.hasOwn(project.getState().currentProject, 'storyboard'), false)
})

test('board edits during asynchronous thumbnail and file writes survive and remain dirty until saved', async () => {
  add()
  for (const phase of ['thumbnail', 'file']) {
    let release
    const waiting = new Promise(resolve => { release = resolve })
    if (phase === 'thumbnail') thumbnailWait = waiting
    else saveWait = waiting
    const saving = project.getState().saveProject()
    await Promise.resolve()
    applyStoryboardEdit({ operation: 'update_board', patch: { brief: `Changed during ${phase}` } })
    release()
    assert.equal(await saving, true)
    assert.equal(getStoryboard().brief, `Changed during ${phase}`)
    assert.equal(isProjectDirty(), true)
    saveWait = null; thumbnailWait = null
    assert.equal(await project.getState().saveProject(), true)
    assert.equal(memoryFiles.get(handle).storyboard.brief, `Changed during ${phase}`)
    assert.equal(isProjectDirty(), false)
  }
})

test('an old pending save cannot replace or clean a reopened session at the same project handle', async () => {
  add('Original session')
  let release
  saveWait = new Promise(resolve => { release = resolve })
  const oldSessionId = timeline.getState().timelineSessionId
  const saving = project.getState().saveProject()
  await new Promise(setImmediate)
  const reopened = { ...baseProject(), settings: { ...baseProject().settings, width: 1280 },
    storyboard: { ...getStoryboard(), title: 'Reopened board' } }
  memoryFiles.set(handle, reopened)
  assert.ok(await project.getState().openProject(handle))
  assert.notEqual(timeline.getState().timelineSessionId, oldSessionId)
  applyStoryboardEdit({ operation: 'update_board', patch: { brief: 'Unsaved edit in the new session' } })
  const newState = project.getState(), newTimeline = timeline.getState()
  assert.equal(isProjectDirty(), true)
  release()
  assert.equal(await saving, true)
  saveWait = null
  assert.equal(project.getState(), newState, 'Old completion must not replace settings, timelines, board, history or save timestamps')
  assert.equal(timeline.getState(), newTimeline)
  assert.equal(project.getState().currentProject.settings.width, 1280)
  assert.equal(getStoryboard().title, 'Reopened board')
  assert.equal(getStoryboard().brief, 'Unsaved edit in the new session')
  assert.equal(isProjectDirty(), true)
})

test('a pending save completion also preserves a newly selected timeline and its dirty board', async () => {
  add()
  const other = project.getState().createTimeline({ name: 'Other timeline' })
  let release
  saveWait = new Promise(resolve => { release = resolve })
  const saving = project.getState().saveProject()
  await new Promise(setImmediate)
  assert.equal(await project.getState().switchTimeline(other.id), true)
  applyStoryboardEdit({ operation: 'update_board', patch: { title: 'After timeline switch' } })
  const newState = project.getState(), newTimeline = timeline.getState()
  release()
  assert.equal(await saving, true)
  saveWait = null
  assert.equal(project.getState(), newState)
  assert.equal(timeline.getState(), newTimeline)
  assert.equal(project.getState().currentTimelineId, other.id)
  assert.equal(getStoryboard().title, 'After timeline switch')
  assert.equal(isProjectDirty(), true)
})

test('production uses shared board history, frozen preview entity IDs, atomic song changes, and save/open persistence', async () => {
  const live = timeline.getState()
  const start = unchanged(() => previewStoryboardEdit({ operation: 'start_production', productionType: 'music-video' }))
  assert.equal(isProjectDirty(), false)
  applyStoryboardEdit(start.suggestedApplyPayload)
  const before = project.getState().projectHistory.length
  applyStoryboardEdit({ operation: 'update_production', patch: { concept: 'A traveler finds a place in the city.', visualStyle: 'Natural light', approach: 'mixed' }, songAssetId: 'audio' })
  assert.equal(project.getState().projectHistory.length, before + 1, 'Concept and song produce a single shared Undo entry')
  assert.equal(getStoryboard().songAssetId, 'audio')
  project.getState().undoTimelineStructureChange()
  assert.equal(getStoryboard().songAssetId, null)
  assert.equal(getStoryboard().production.concept, '')
  project.getState().redoTimelineStructureChange()
  for (const [operation, details, key, collection] of [
    ['add_cast_member', { member: { name: 'Mira', referenceAssetIds: ['image'] } }, 'memberId', 'cast'],
    ['add_location', { location: { name: 'Roof', referenceAssetIds: ['image'] } }, 'locationId', 'locations'],
  ]) {
    const preview = unchanged(() => previewStoryboardEdit({ operation, ...details }))
    const applied = applyStoryboardEdit(preview.suggestedApplyPayload)
    assert.equal(applied[key], preview[key])
    assert.equal(getStoryboard().production[collection][0].id, preview[key])
    unchanged(() => assert.throws(() => applyStoryboardEdit(preview.suggestedApplyPayload), /stale/))
  }
  assert.equal(timeline.getState(), live)
  const board = getStoryboard()
  assert.equal(await project.getState().saveProject(), true)
  assert.deepEqual(memoryFiles.get(handle).storyboard, board)
  assert.equal(isProjectDirty(), false)
  assert.ok(await project.getState().openProject(handle))
  assert.deepEqual(getStoryboard(), board)
  assert.equal(project.getState().projectHistory.length, 0)
})

test('production review previews reject changed reference identity even when the new asset still satisfies review gates', () => {
  assets.setState({ assets: sourceAssets.map(asset => asset.id === 'audio' ? { ...asset, duration: 90 } : asset) })
  applyStoryboardEdit({ operation: 'start_production', productionType: 'music-video' })
  applyStoryboardEdit({ operation: 'update_production', patch: { concept: 'A traveler finds a place in the city.', visualStyle: 'Natural light', approach: 'mixed' }, songAssetId: 'audio' })
  const preview = previewStoryboardEdit({ operation: 'review_production_stage', stage: 'concept', decision: 'approve' })
  const count = project.getState().projectHistory.length
  assets.setState({ assets: assets.getState().assets.map(asset => asset.id === 'audio' ? { ...asset, duration: 91 } : asset) })
  unchanged(() => assert.throws(() => applyStoryboardEdit(preview.suggestedApplyPayload), /references changed/))
  assert.equal(getStoryboard().production.reviews.length, 0)
  assert.equal(project.getState().projectHistory.length, count)
  unchanged(() => assert.throws(() => applyStoryboardEdit(preview.suggestedApplyPayload), /stale/))
  const fresh = previewStoryboardEdit({ operation: 'review_production_stage', stage: 'concept', decision: 'approve' })
  assert.equal(applyStoryboardEdit(fresh.suggestedApplyPayload).board.production.reviews[0].decision, 'approve')
})

test('legacy label reads and saves preserve raw shape; meaningful edits stamp labels in the existing shared Undo', async () => {
  add('Opening'); add('Closing')
  const legacyBoard = getStoryboard()
  delete legacyBoard.nextShotNumber
  legacyBoard.shots.forEach(shot => { delete shot.label })
  memoryFiles.set(handle, { ...baseProject(), storyboard: legacyBoard })
  assert.ok(await project.getState().openProject(handle))
  assert.deepEqual(unchanged(getStoryboard), legacyBoard)
  assert.equal(isProjectDirty(), false)
  assert.equal(await project.getState().saveProject(), true)
  assert.deepEqual(memoryFiles.get(handle).storyboard, legacyBoard)
  const preview = unchanged(() => previewStoryboardEdit({ operation: 'reorder_shots', shotIds: legacyBoard.shots.map(shot => shot.id).reverse() }))
  assert.equal(isProjectDirty(), false)
  assert.deepEqual(preview.board.shots.map(shot => shot.label), ['Shot 02', 'Shot 01'])
  applyStoryboardEdit(preview.suggestedApplyPayload)
  assert.equal(project.getState().projectHistory.length, 1)
  assert.equal(getStoryboard().nextShotNumber, 3)
  project.getState().undoTimelineStructureChange()
  assert.deepEqual(getStoryboard(), legacyBoard, 'Undo restores exact legacy authored shape, not an invisible read migration')
  project.getState().redoTimelineStructureChange()
  assert.deepEqual(getStoryboard().shots.map(shot => shot.label), ['Shot 02', 'Shot 01'])
  assert.equal(await project.getState().saveProject(), true)
  assert.ok(await project.getState().openProject(handle))
  assert.deepEqual(getStoryboard().shots.map(shot => shot.label), ['Shot 02', 'Shot 01'])
})

test('frame-only preview validation and deleted-shot counter survive shared history and save/open', async () => {
  const first = add(), second = add('Closing')
  applyStoryboardEdit({ operation: 'remove_shot', shotId: second.shotId })
  const next = previewStoryboardEdit({ operation: 'add_shot', shot: { storyboardAssetId: 'image' } })
  assert.equal(next.board.shots.at(-1).label, 'Shot 03')
  const applied = applyStoryboardEdit(next.suggestedApplyPayload)
  assert.equal(applied.board.shots.at(-1).label, 'Shot 03')
  assert.equal(applied.board.nextShotNumber, 4)
  project.getState().undoTimelineStructureChange()
  assert.equal(getStoryboard().shots.length, 1)
  project.getState().redoTimelineStructureChange()
  assert.equal(getStoryboard().shots.at(-1).storyboardAssetId, 'image')
  const frame = previewStoryboardEdit({ operation: 'update_shot', shotId: first.shotId, patch: { storyboardAssetId: 'image' } })
  assets.setState({ assets: sourceAssets.filter(asset => asset.id !== 'image') })
  unchanged(() => assert.throws(() => applyStoryboardEdit(frame.suggestedApplyPayload), /missing/))
  assets.setState({ assets: sourceAssets })
  assert.equal(await project.getState().saveProject(), true)
  assert.ok(await project.getState().openProject(handle))
  assert.equal(getStoryboard().nextShotNumber, 4)
  assert.equal(getStoryboard().shots.at(-1).storyboardAssetId, 'image')
  assert.equal(add('Another').board.shots.at(-1).label, 'Shot 04')
})
