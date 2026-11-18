import test, { beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { assertMcpActionAllowedDuringExport, isMcpActionAllowedDuringExport } from '../electron/exportPriorityPolicy.mjs'

const require = createRequire(import.meta.url)
const previousStorage = globalThis.localStorage
const syntheticStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.localStorage = syntheticStorage
after(() => { if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage })
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const definitions = require('../electron/mcpStoryboardTools.cjs')
const renderer = fs.readFileSync(new URL('../src/services/mcpActions.js', import.meta.url), 'utf8')
const dispatchSource = renderer.slice(renderer.indexOf('async function handleMcpAction('), renderer.indexOf('export async function runMcpAction('))
const code = buildSync({ stdin: { contents: `
  export * from './src/services/mcpStoryboard';
  export * from './src/services/storyboard';
  export * from './src/services/mcpContext';
  export * from './src/services/mcpSnapshot';
  export { assertAssetRemovalAllowsMcp } from './src/services/assetRemovalPlan.mjs';
  export { default as timeline } from './src/stores/timelineStore';
  export { default as assets } from './src/stores/assetsStore';
  export { default as project } from './src/stores/projectStore';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'zustand', 'zustand/*'],
  loader: { '.glsl': 'text', '.png': 'dataurl', '.svg': 'dataurl' },
}).outputFiles[0].text
const module = { exports: {} }
Function('require', 'module', 'exports', 'localStorage', 'window', code)(require, module, module.exports,
  syntheticStorage,
  { addEventListener() {}, removeEventListener() {}, dispatchEvent() { throw new Error('Storyboard must not dispatch to Generate or Director.') } })
const { project, assets, timeline, MCP_STORYBOARD_ACTIONS, captureMcpContext, assertMcpContext,
  buildMcpSnapshot, assertAssetRemovalAllowsMcp, applyStoryboardEdit } = module.exports
const initialTimeline = timeline.getState()
let busy = false
const handle = vm.runInNewContext(`${dispatchSource}\nhandleMcpAction`, {
  isExportBusy: () => busy, assertMcpActionAllowedDuringExport, assertAssetRemovalAllowsMcp,
  MCP_PARITY_ACTIONS: MCP_STORYBOARD_ACTIONS, captureMcpContext, assertMcpContext,
})
const run = (action, payload = {}) => handle({ action, payload })
const edit = async payload => {
  const preview = await run('edit_storyboard', payload)
  return run('edit_storyboard', preview.suggestedApplyPayload)
}
const json = result => JSON.parse(result.content[0].text)
test('creative board fields from the reported Luna call save together, adopt into production, and retain Undo', async () => {
  const patch = { title: 'Brooklyn Block Party', brief: 'An animal crew gathers for a neighborhood barbecue.',
    visualStyle: 'Stylized colorful Brooklyn', approach: 'mixed', concept: 'A bear finds his community.' }
  await edit({ operation: 'update_board', patch })
  let board = (await run('get_storyboard')).board
  for (const [key,value] of Object.entries(patch)) assert.equal(board[key],value)
  assert.equal(board.production,undefined,'Saving a brief must not invent the production type')
  for (let i=0;i<8;i++) await edit({ operation:'add_shot',shot:{title:`Beat ${i+1}`,durationSeconds:5} })
  assert.equal((await run('get_storyboard')).board.shots.length,8)
  await edit({operation:'start_production',productionType:'music-video'})
  board=(await run('get_storyboard')).board
  assert.equal(board.visualStyle,undefined)
  assert.equal(board.production.visualStyle,patch.visualStyle)
  assert.equal(board.production.approach,'mixed')
  await edit({operation:'update_board',patch:{title:'New title',visualStyle:'New look',approach:'story'}})
  board=(await run('get_storyboard')).board
  assert.equal(board.title,'New title');assert.equal(board.production.visualStyle,'New look')
  assert.equal(board.production.approach,'story')
  assert.ok(project.getState().projectHistory.length>0)
  assert.equal(project.getState().undoTimelineStructureChange(),true)
  board=(await run('get_storyboard')).board
  assert.equal(board.title,patch.title);assert.equal(board.production.visualStyle,patch.visualStyle)
  assert.equal(project.getState().redoTimelineStructureChange(),true)
  board=(await run('get_storyboard')).board
  assert.deepEqual(timeline.getState().clips,[])
  const before=JSON.stringify(board)
  await assert.rejects(edit({operation:'update_board',patch:{title:'Must not save',approach:'invalid'}}))
  assert.equal(JSON.stringify((await run('get_storyboard')).board),before)
})
beforeEach(() => {
  busy = false
  project.setState({ currentProjectHandle: '/synthetic/storyboard', currentTimelineId: 'timeline',
    projectHistory: [], projectFuture: [], projectHistoryLastChangedAt: 0,
    storyboardRevision: (project.getState().storyboardRevision || 0) + 1,
    currentProject: { name: 'Storyboard fixture', settings: { width: 1920, height: 1080, fps: 24 },
      timelines: [{ id: 'timeline', name: 'Main' }] } })
  assets.setState({ folders: [], assets: [
    { id: 'reference', name: 'Reference', type: 'image', url: 'memory:private', thumbnail: 'data:image/png;base64,private', width: 1920, height: 1080 },
    { id: 'take-a', name: 'Take A', type: 'video', duration: 5, absolutePath: '/private/media/take-a.mp4', settings: { prompt: 'private source metadata' } },
    { id: 'take-b', name: 'Take B', type: 'video', duration: 6 },
    { id: 'song', name: 'Song', type: 'audio', duration: 60 },
  ] })
  timeline.setState({ ...initialTimeline, timelineSessionId: timeline.getState().timelineSessionId + 1,
    clips: [], tracks: [], markers: [], transitions: [], history: [], historyIndex: -1, compoundEditContext: null })
})

test('Storyboard tools are registered independently of Director and route through shared renderer actions', async () => {
  assert.match(renderer, /\.\.\.MCP_STORYBOARD_ACTIONS/)
  const seen = []
  const server = createComfyStudioMcpServer({ performAction: async request => {
    seen.push(request); return run(request.action, request.payload)
  } })
  server.updateSnapshot(buildMcpSnapshot())
  for (const tool of definitions.tools) assert.ok(server.tools.some(item => item.name === tool.name))
  const read = json(await server.callTool('get_storyboard'))
  assert.deepEqual(read.result.board.shots, [])
  const preview = json(await server.callTool('edit_storyboard', { operation: 'add_shot', shot: { title: 'Opening' } }))
  assert.equal(seen.at(-1).payload.previewOnly, true)
  assert.equal(preview.suggestedApplyCall.tool, 'edit_storyboard')
  assert.equal(typeof preview.suggestedApplyCall.arguments.previewToken, 'string')
  assert.ok(preview.suggestedApplyCall.arguments.expectedContext)
  const applied = json(await server.callTool('edit_storyboard', preview.suggestedApplyCall.arguments))
  assert.equal(applied.result.board.shots[0].title, 'Opening')
})

test('inspection and preview do not persist a missing board or alter timeline history', async () => {
  const before = project.getState(), timelineBefore = timeline.getState()
  const read = await run('get_storyboard')
  assert.equal(read.board.version, 1)
  const preview = await run('edit_storyboard', { operation: 'add_shot', shot: { title: 'Opening' } })
  assert.equal(preview.previewOnly, true)
  assert.equal(project.getState(), before)
  assert.equal(timeline.getState(), timelineBefore)
  assert.equal(Object.hasOwn(project.getState().currentProject, 'storyboard'), false)
})

test('MCP edits require their preview token and context and cannot reuse or retarget a preview', async () => {
  await assert.rejects(run('edit_storyboard', { operation: 'add_shot', previewOnly: false }), /Preview.*first/)
  const preview = await run('edit_storyboard', { operation: 'add_shot', shot: { title: 'Original' } })
  await assert.rejects(run('edit_storyboard', { ...preview.suggestedApplyPayload, shot: { title: 'Changed' } }), /preview|changed|match/i)
  const fresh = await run('edit_storyboard', { operation: 'add_shot', shot: { title: 'Original' } })
  await run('edit_storyboard', fresh.suggestedApplyPayload)
  await assert.rejects(run('edit_storyboard', fresh.suggestedApplyPayload), /preview|changed|token/i)
  assert.equal(project.getState().currentProject.storyboard.shots.length, 1)
})

test('human board edits, Undo, project switches and authored timeline changes invalidate agent previews', async () => {
  for (const mutate of [
    () => applyStoryboardEdit({ operation: 'update_board', patch: { title: 'Human edit' } }),
    () => project.setState({ currentProjectHandle: '/synthetic/other' }),
    () => timeline.setState({ clips: [...timeline.getState().clips] }),
  ]) {
    const preview = await run('edit_storyboard', { operation: 'add_shot' })
    mutate()
    await assert.rejects(run('edit_storyboard', preview.suggestedApplyPayload), /changed/)
  }
  await edit({ operation: 'add_shot' })
  const preview = await run('edit_storyboard', { operation: 'add_shot' })
  assert.equal(project.getState().undoTimelineStructureChange(), true)
  await assert.rejects(run('edit_storyboard', preview.suggestedApplyPayload), /changed/)
})

test('shared Storyboard changes invalidate other MCP contexts while playback remains harmless', async () => {
  const context = captureMcpContext()
  timeline.setState({ playheadPosition: 1, selectedClipIds: [], zoom: 2 })
  assert.deepEqual(captureMcpContext(), context)
  await edit({ operation: 'update_board', patch: { title: 'New title' } })
  assert.throws(() => assertMcpContext(context), /changed/)
  assert.ok(captureMcpContext().storyboardRevision > context.storyboardRevision)
})

test('takes and reference summaries are metadata only, use shared state and leave timeline placement separate', async () => {
  await edit({ operation: 'update_board', patch: { songAssetId: 'song' } })
  const shot = await edit({ operation: 'add_shot', shot: { referenceAssetIds: ['reference'] } })
  const first = await edit({ operation: 'attach_take', shotId: shot.shotId, assetId: 'take-a', prompt: 'Authored prompt', workflowLabel: 'Workflow notes' })
  const second = await edit({ operation: 'attach_take', shotId: shot.shotId, assetId: 'take-b' })
  await edit({ operation: 'select_take', shotId: shot.shotId, takeId: second.takeId })
  const read = await run('get_storyboard')
  assert.equal(read.board.shots[0].selectedTakeId, second.takeId)
  assert.equal(read.board.shots[0].takes[0].prompt, 'Authored prompt')
  assert.equal(first.board.shots[0].selectedTakeId, first.takeId)
  assert.deepEqual(read.assets.map(asset => asset.id), ['song', 'reference', 'take-a', 'take-b'])
  assert.equal(JSON.stringify(read).includes('private'), false)
  assert.equal(timeline.getState().clips.length, 0)
  const summary = buildMcpSnapshot().storyboard
  assert.equal(summary.shotCount, 1); assert.equal(summary.takeCount, 2); assert.equal(summary.selectedTakeCount, 1)
  assert.equal(project.getState().undoTimelineStructureChange(), true)
  assert.equal((await run('get_storyboard')).board.shots[0].selectedTakeId, first.takeId)
  assert.equal(project.getState().redoTimelineStructureChange(), true)
  assert.equal((await run('get_storyboard')).board.shots[0].selectedTakeId, second.takeId)
})

test('missing assets remain visible as missing, and unsupported board data is never silently reset', async () => {
  const shot = await edit({ operation: 'add_shot', shot: { referenceAssetIds: ['reference'] } })
  await edit({ operation: 'attach_take', shotId: shot.shotId, assetId: 'take-a' })
  assets.setState({ assets: [] })
  assert.deepEqual((await run('get_storyboard')).assets, [{ id: 'reference', missing: true }, { id: 'take-a', missing: true }])
  const unknown = { version: 9, futureField: 'preserve me' }
  project.setState({ currentProject: { ...project.getState().currentProject, storyboard: unknown } })
  await assert.rejects(run('get_storyboard'), /Unsupported version/)
  await assert.rejects(run('edit_storyboard', { operation: 'add_shot' }), /Unsupported version/)
  assert.equal(project.getState().currentProject.storyboard, unknown)
  const summary = buildMcpSnapshot().storyboard
  assert.equal(summary.available, false); assert.equal(summary.version, 9)
})

test('export allows metadata-only Storyboard reads but blocks previews and writes at both boundaries', async () => {
  busy = true
  assert.equal(isMcpActionAllowedDuringExport('get_storyboard'), true)
  assert.equal(isMcpActionAllowedDuringExport('get_production_guide'), true)
  assert.equal(isMcpActionAllowedDuringExport('edit_storyboard', { previewOnly: true }), false)
  assert.equal((await run('get_storyboard')).board.version, 1)
  assert.ok((await run('get_production_guide')).guide.questions.length <= 2)
  for (const previewOnly of [true, false]) await assert.rejects(run('edit_storyboard', { operation: 'add_shot', previewOnly }), /Export is in progress/)
  const seen = []
  const server = createComfyStudioMcpServer({ isExportBusy: () => busy, performAction: async request => {
    seen.push(request.action); return run(request.action, request.payload)
  } })
  server.updateSnapshot(buildMcpSnapshot())
  assert.notEqual((await server.callTool('get_storyboard')).isError, true)
  assert.notEqual((await server.callTool('get_production_guide')).isError, true)
  assert.equal((await server.callTool('edit_storyboard', { operation: 'add_shot' })).isError, true)
  assert.deepEqual(seen, ['get_storyboard', 'get_production_guide'])
})

test('cached project inspection and recipes expose the shared Storyboard without replacing Director', async () => {
  await edit({ operation: 'add_shot' })
  const server = createComfyStudioMcpServer()
  server.updateSnapshot(buildMcpSnapshot())
  assert.equal(json(await server.callTool('get_project')).storyboard.shotCount, 1)
  const recipes = json(await server.callTool('get_mcp_recipes')).recipes
  assert.ok(recipes.some(recipe => recipe.id === 'project_storyboard' && recipe.tools.includes('edit_storyboard')))
  assert.ok(recipes.some(recipe => recipe.id === 'guided_music_video_creation'))
  const initialized = await server.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.match(initialized.result.instructions, /new model-agnostic production planning, including music videos, begin with get_production_guide/)
  assert.match(initialized.result.instructions, /explicitly wants the existing guided Director workflow or is continuing an existing Director session/)
  assert.ok(recipes.some(recipe => recipe.id === 'guided_production' && recipe.tools.includes('get_production_guide')
    && recipe.safeDefaults.stageApprovalAuthorizesExecution === false))
})

test('missing project or renderer backend returns an explicit error instead of inventing or resetting a board', async () => {
  const unavailable = createComfyStudioMcpServer()
  unavailable.updateSnapshot(buildMcpSnapshot())
  const backendError = await unavailable.callTool('get_storyboard')
  assert.equal(backendError.isError, true)
  assert.match(backendError.content[0].text, /not available.*Restart Velorn/)
  assert.equal(Object.hasOwn(project.getState().currentProject, 'storyboard'), false)
  project.setState({ currentProject: null })
  assert.equal(buildMcpSnapshot().storyboard, null)
  await assert.rejects(run('get_storyboard'), /Open a project/)
  await assert.rejects(run('edit_storyboard', { operation: 'add_shot' }), /Open a project/)
  unavailable.updateSnapshot(buildMcpSnapshot())
  assert.match((await unavailable.callTool('get_storyboard')).content[0].text, /No Velorn project/)
  await assert.rejects(run('get_production_guide'), /Open a project/)
  assert.match((await unavailable.callTool('get_production_guide')).content[0].text, /No Velorn project/)
})

test('production guide is a read-only bounded shared-state view, not an embedded agent or generation queue', async () => {
  const before = project.getState(), timelineBefore = timeline.getState()
  const initial = await run('get_production_guide')
  assert.equal(initial.guide.production, null)
  assert.ok(initial.guide.questions.length > 0 && initial.guide.questions.length <= 2)
  assert.equal(typeof initial.guide.handoffPrompt, 'string')
  assert.equal(project.getState(), before)
  assert.equal(timeline.getState(), timelineBefore)
  const preview = await run('edit_storyboard', { operation: 'start_production', productionType: 'music-video', targetDurationSeconds: 30 })
  assert.equal(project.getState(), before)
  await run('edit_storyboard', preview.suggestedApplyPayload)
  const read = await run('get_production_guide')
  assert.equal(read.guide.production.type, 'music-video')
  assert.ok(read.guide.questions.length <= 2)
  assert.deepEqual(read.context, captureMcpContext())
  assert.equal(read.revision, project.getState().storyboardRevision)
  assert.equal(read.guide.summary.generationAuthorized, false)
  assert.doesNotMatch(JSON.stringify(read), /memory:private|\/private\/media|private source metadata/)
  assert.equal(timeline.getState(), timelineBefore)
  const summary = buildMcpSnapshot().storyboard.production
  assert.equal(summary.type, 'music-video')
  assert.equal(summary.stages.length, 5)
  assert.equal(Object.hasOwn(summary, 'handoffPrompt'), false)
  assert.equal(project.getState().undoTimelineStructureChange(), true)
  assert.equal((await run('get_production_guide')).guide.production, null)
  assert.equal(project.getState().redoTimelineStructureChange(), true)
  assert.equal((await run('get_production_guide')).guide.production.type, 'music-video')
})

const editRun = async payload => {
  const preview = await run('edit_production_run', payload)
  return run('edit_production_run', preview.suggestedApplyPayload)
}
const plannedRecipe = () => ({ model: 'User-chosen local model', workflow: 'Audio-conditioned audition',
  inputAssetIds: ['reference'], songAssetId: 'song', audioStartSeconds: 10,
  audioDurationSeconds: 4, generationDurationSeconds: 5, fps: 24 })

test('production records route through native MCP, remain reported metadata, and never execute jobs or exports', async () => {
  const calls = []
  const server = createComfyStudioMcpServer({ performAction: async request => {
    calls.push(request.action); return run(request.action, request.payload)
  } })
  server.updateSnapshot(buildMcpSnapshot())
  const before = project.getState(), live = timeline.getState()
  assert.equal(json(await server.callTool('get_production_run')).result.run, null)
  assert.equal(project.getState(), before)
  const shot = await edit({ operation: 'add_shot', shot: { storyboardAssetId: 'reference' } })
  server.updateSnapshot(buildMcpSnapshot())
  const request = { operation: 'record_attempt', shotId: shot.shotId, attemptId: 'audition-01', recipe: plannedRecipe() }
  const preview = json(await server.callTool('edit_production_run', request))
  assert.equal(preview.suggestedApplyCall.tool, 'edit_production_run')
  await server.callTool('edit_production_run', preview.suggestedApplyCall.arguments)
  await editRun({ operation: 'update_attempt', attemptId: 'audition-01', patch: { state: 'uncertain', note: 'Connection lost: inspect backend before retry.' } })
  const recorded = await run('get_production_run')
  assert.equal(recorded.run.attempts[0].state, 'uncertain')
  assert.equal(recorded.inspection.summary.statesVerified, false)
  assert.equal(recorded.inspection.summary.exportRequired, false)
  assert.equal(recorded.inspection.summary.needsReconciliationCount, 1)
  assert.equal((await editRun(request)).deduplicated, true)
  assert.equal((await run('get_production_run')).run.attempts.length, 1)
  assert.equal(timeline.getState(), live)
  assert.deepEqual(calls, ['get_production_run', 'edit_production_run', 'edit_production_run'])
  await assert.rejects(run('edit_production_run', { operation: 'remove_shot', shotId: shot.shotId }), /Unsupported/)
  await assert.rejects(run('edit_production_run', { ...request, previewOnly: false }), /Preview/)
  busy = true
  assert.equal((await run('get_production_run')).run.attempts.length, 1)
  await assert.rejects(run('edit_production_run', { operation: 'update_run', patch: { notes: 'blocked' } }), /export/i)
  const guide = (await run('get_production_guide')).guide
  assert.equal(guide.recipe.delivery.exportByDefault, false)
  assert.equal(guide.recipe.capabilitySelection.preferenceFirst, true)
})

test('production bindings inspect the live active timeline and exact timeline/clip pairs without mutating', async () => {
  const shot = await edit({ operation: 'add_shot', shot: { storyboardAssetId: 'reference' } })
  const track = { id: 'v1', type: 'video' }
  const clip = { id: 'same-clip', assetId: 'reference', type: 'image', trackId: 'v1', startTime: 0, duration: 4,
    trimStart: 0, trimEnd: 4, transform: { positionX: 8 }, keyframes: { opacity: [{ time: 0, value: 80 }] } }
  timeline.setState({ tracks: [track], clips: [clip] })
  const p = project.getState().currentProject
  project.setState({ currentProject: { ...p, timelines: [
    { id: 'timeline', name: 'Main', tracks: [track], clips: [{ ...clip, duration: 1 }] },
    { id: 'other', name: 'Alternate', tracks: [track], clips: [{ ...clip, duration: 2 }] },
  ] } })
  await editRun({ operation: 'bind_shot', shotId: shot.shotId, slot: 'animatic', timelineId: 'timeline', clipId: clip.id })
  let read = await run('get_production_run')
  assert.equal(read.inspection.bindings[0].current.duration, 4, 'Read live edits, not the stale saved active copy')
  assert.equal(read.inspection.bindings[0].status, 'linked')
  timeline.setState({ clips: [{ ...clip, duration: 3 }] })
  read = await run('get_production_run')
  assert.equal(read.inspection.bindings[0].status, 'changed')
  assert.equal(read.inspection.bindings[0].baseline.duration, 4)
  assert.equal(read.inspection.bindings[0].current.duration, 3)
  const before = timeline.getState()
  const pending = await run('edit_production_run', { operation: 'bind_shot', shotId: shot.shotId,
    slot: 'animatic', timelineId: 'other', clipId: clip.id, rebind: true })
  assert.equal(timeline.getState(), before)
  const cp = project.getState().currentProject
  project.setState({ currentProject: { ...cp, timelines: cp.timelines.filter(t => t.id !== 'other') } })
  await assert.rejects(run('edit_production_run', pending.suggestedApplyPayload), /changed/)
  assert.equal(timeline.getState(), before)
  assert.deepEqual(before.clips[0].keyframes, clip.keyframes)
  // Deliberately invalid live child: a metadata read must not invoke compound
  // serialization/validation just to inspect unaffected parent bindings.
  timeline.getState().compoundEditContext = { parentDocument: { tracks: [track], clips: [clip], transitions: [] } }
  assert.equal((await run('get_production_run')).compoundFocused, true)
  assert.equal((await run('get_production_run')).inspection.bindings[0].current.duration, 4)
  await assert.rejects(run('edit_production_run', { operation: 'update_run', patch: { notes: 'blocked' } }), /compound/)
})

test('production cast, location and direction operations use the same frozen previews and asset metadata as UI state', async () => {
  await edit({ operation: 'start_production', productionType: 'short-film' })
  const castPreview = await run('edit_storyboard', { operation: 'add_cast_member', member: {
    name: 'Lead', role: 'Protagonist', description: 'A traveler', referenceAssetIds: ['reference'],
  } })
  const cast = await run('edit_storyboard', castPreview.suggestedApplyPayload)
  assert.equal(cast.memberId, castPreview.memberId)
  const locationPreview = await run('edit_storyboard', { operation: 'add_location', location: {
    name: 'Harbor', description: 'Morning by the water', referenceAssetIds: ['take-a'],
  } })
  const location = await run('edit_storyboard', locationPreview.suggestedApplyPayload)
  assert.equal(location.locationId, locationPreview.locationId)
  const shot = await edit({ operation: 'add_shot', shot: { title: 'Arrival' } })
  await edit({ operation: 'set_shot_direction', shotId: shot.shotId,
    patch: { castIds: [cast.memberId], locationId: location.locationId, lipSync: false, notes: 'Slow tracking shot' } })
  const read = await run('get_storyboard')
  assert.deepEqual(read.board, project.getState().currentProject.storyboard)
  assert.deepEqual(read.assets.map(asset => asset.id), ['reference', 'take-a'])
  assert.equal(JSON.stringify(read).includes('private'), false)
  const guide = (await run('get_production_guide')).guide
  assert.deepEqual(guide.production, read.board.production)
  assert.equal(guide.summary.generationAuthorized, false)
  assert.equal(timeline.getState().clips.length, 0)
})

test('stage approvals reject stale previews, become stale after changed decisions, and never grant execution permission', async () => {
  await edit({ operation: 'start_production', productionType: 'music-video', targetDurationSeconds: 30 })
  await edit({ operation: 'update_production', songAssetId: 'song', patch: {
    targetDurationSeconds: 30, songStartSeconds: 0, approach: 'story', concept: 'A traveler reaches the coast.',
    visualStyle: 'Warm natural light.', audience: 'Music fans', mustInclude: 'The sea',
    castMode: 'none', locationMode: 'none', delegation: 'guided',
  } })
  const pending = await run('edit_storyboard', { operation: 'review_production_stage', stage: 'concept', decision: 'approve', note: 'Human reviewed concept.' })
  applyStoryboardEdit({ operation: 'update_production', patch: { visualStyle: 'Cool natural light.' } })
  await assert.rejects(run('edit_storyboard', pending.suggestedApplyPayload), /changed/)
  await edit({ operation: 'review_production_stage', stage: 'concept', decision: 'approve', note: 'Human reviewed revised concept.' })
  let guide = (await run('get_production_guide')).guide
  assert.equal(guide.stages.find(stage => stage.id === 'concept').state, 'approved')
  assert.equal(guide.summary.generationAuthorized, false)
  await edit({ operation: 'update_production', patch: { concept: 'A traveler returns home.' } })
  guide = (await run('get_production_guide')).guide
  assert.equal(guide.stages.find(stage => stage.id === 'concept').state, 'stale')
  assert.equal(guide.summary.generationAuthorized, false)
  assert.equal(timeline.getState().clips.length, 0)
})

test('production schema and native read routing preserve preview safety and never auto-select Director', async () => {
  const names = ['start_production', 'update_production', 'add_cast_member', 'update_cast_member', 'remove_cast_member',
    'add_location', 'update_location', 'remove_location', 'set_shot_direction', 'review_production_stage']
  const schema = definitions.tools.find(tool => tool.name === 'edit_storyboard').inputSchema
  for (const operation of names) assert.ok(schema.properties.operation.enum.includes(operation))
  assert.deepEqual(schema.properties.productionType.enum, ['music-video', 'ad', 'ugc', 'short-film'])
  assert.deepEqual(schema.properties.stage.enum, ['concept', 'cast-locations', 'animatic', 'generate', 'refine'])
  assert.equal(schema.properties.patch.properties.referenceAssetIds.maxItems, 50, 'Existing shot-reference capacity remains available')
  const calls = []
  const server = createComfyStudioMcpServer({ performAction: async request => {
    calls.push(request); return run(request.action, request.payload)
  } })
  server.updateSnapshot(buildMcpSnapshot())
  const response = json(await server.callTool('get_production_guide'))
  assert.equal(response.result.guide.production, null)
  assert.deepEqual(calls.map(request => request.action), ['get_production_guide'])
  assert.equal(calls[0].payload.previewOnly, undefined)
  assert.equal(project.getState().projectHistory.length, 0)
})

test('read-only presentation resolves legacy Shot labels without persisting them, and labels survive MCP reorder', async () => {
  const first = await edit({ operation: 'add_shot', shot: { title: 'Opening', referenceAssetIds: ['reference'] } })
  const second = await edit({ operation: 'add_shot', shot: { title: 'Arrival' } })
  const legacy = structuredClone(project.getState().currentProject.storyboard)
  delete legacy.nextShotNumber
  for (const shot of legacy.shots) delete shot.label
  project.setState({ currentProject: { ...project.getState().currentProject, storyboard: legacy } })
  const before = project.getState(), timelineBefore = timeline.getState()
  const read = await run('get_storyboard')
  assert.deepEqual(read.presentation.shots.map(shot => [shot.label, shot.shotId, shot.stillAssetId]), [
    ['Shot 01', first.shotId, 'reference'], ['Shot 02', second.shotId, null],
  ])
  assert.deepEqual((await run('get_production_guide')).presentation, read.presentation)
  assert.deepEqual(read.board, legacy)
  assert.equal(project.getState(), before)
  assert.equal(timeline.getState(), timelineBefore)
  assert.equal(Object.hasOwn(legacy.shots[0], 'label'), false)
  await edit({ operation: 'reorder_shots', shotIds: [second.shotId, first.shotId] })
  assert.deepEqual((await run('get_storyboard')).presentation.shots.map(shot => [shot.label, shot.shotId]), [
    ['Shot 02', second.shotId], ['Shot 01', first.shotId],
  ])
  await edit({ operation: 'remove_shot', shotId: second.shotId })
  const third = await edit({ operation: 'add_shot' })
  assert.equal((await run('get_storyboard')).presentation.shots.find(shot => shot.shotId === third.shotId).label, 'Shot 03')
  await assert.rejects(run('edit_storyboard', { operation: 'update_shot', shotId: 'Shot 01', patch: { title: 'Wrong target' } }), /shotId must be a valid project ID/)
})

test('explicit storyboard images use preview and metadata-only reads, independently of selected video takes', async () => {
  assets.setState({ assets: [...assets.getState().assets,
    { id: 'first-frame', type: 'image', name: 'Approved first frame', url: 'memory:private-frame', thumbnail: 'data:image/png;base64,private-frame' }] })
  const shot = await edit({ operation: 'add_shot', shot: { referenceAssetIds: ['reference'], storyboardAssetId: 'first-frame' } })
  const take = await edit({ operation: 'attach_take', shotId: shot.shotId, assetId: 'take-a' })
  let read = await run('get_storyboard')
  assert.equal(read.presentation.shots[0].stillAssetId, 'first-frame')
  assert.equal(read.presentation.shots[0].stillSource, 'storyboard')
  assert.equal(read.presentation.shots[0].selectedTakeAssetId, 'take-a')
  assert.equal(read.board.shots[0].selectedTakeId, take.takeId)
  assert.equal(read.assets.find(asset => asset.id === 'first-frame').type, 'image')
  assert.equal(JSON.stringify(read).includes('private'), false)
  const before = project.getState()
  const preview = await run('edit_storyboard', { operation: 'update_shot', shotId: shot.shotId, patch: { storyboardAssetId: null } })
  assert.equal(project.getState(), before)
  await run('edit_storyboard', preview.suggestedApplyPayload)
  assert.equal((await run('get_storyboard')).presentation.shots[0].stillAssetId, null)
  assert.equal(project.getState().undoTimelineStructureChange(), true)
  assert.equal((await run('get_storyboard')).presentation.shots[0].stillAssetId, 'first-frame')
  assets.setState({ assets: assets.getState().assets.filter(asset => asset.id !== 'first-frame') })
  read = await run('get_storyboard')
  assert.equal(read.presentation.shots[0].stillAssetId, 'first-frame')
  assert.equal(read.presentation.shots[0].stillMissing, true)
  assert.deepEqual(read.assets.find(asset => asset.id === 'first-frame'), { id: 'first-frame', missing: true })
  assert.equal(timeline.getState().clips.length, 0)
  await assert.rejects(run('edit_storyboard', { operation: 'update_shot', shotId: shot.shotId, patch: { storyboardAssetId: 'take-a' } }), /storyboard frame asset is not a supported media type/i)
})

test('presentation groups cast and location references with exact IDs and remains available during export', async () => {
  await edit({ operation: 'start_production', productionType: 'short-film' })
  const cast = await edit({ operation: 'add_cast_member', member: { name: 'Lead', referenceAssetIds: ['reference'] } })
  const location = await edit({ operation: 'add_location', location: { name: 'Harbor', referenceAssetIds: ['take-a'] } })
  await edit({ operation: 'add_shot', shot: { storyboardAssetId: null, referenceAssetIds: ['reference', 'take-a', 'song'] } })
  const before = project.getState(), timelineBefore = timeline.getState()
  busy = true
  const read = await run('get_storyboard')
  const guide = await run('get_production_guide')
  assert.equal(read.presentation.cast[0].memberId, cast.memberId)
  assert.equal(read.presentation.cast[0].references[0].assetId, 'reference')
  assert.equal(read.presentation.locations[0].locationId, location.locationId)
  assert.deepEqual(read.presentation.references.map(reference => reference.assetId), ['song'])
  assert.deepEqual(guide.presentation, read.presentation)
  assert.equal(JSON.stringify(read).includes('private'), false)
  assert.equal(project.getState(), before)
  assert.equal(timeline.getState(), timelineBefore)
})

test('assistant recipes ask before creative decisions and use existing timeline tools instead of a board player', async () => {
  const server = createComfyStudioMcpServer()
  server.updateSnapshot(buildMcpSnapshot())
  const recipes = json(await server.callTool('get_mcp_recipes')).recipes
  const toolNames = new Set(server.tools.map(tool => tool.name))
  for (const id of ['guided_production', 'project_storyboard']) {
    const recipe = recipes.find(item => item.id === id)
    for (const tool of recipe.tools) assert.ok(toolNames.has(tool), `${id} must not invent ${tool}`)
    for (const tool of ['create_timeline', 'switch_timeline', 'add_asset_to_timeline', 'add_assets_to_timeline', 'trim_clips', 'add_text_clip', 'add_timeline_markers']) assert.ok(recipe.tools.includes(tool))
    assert.equal(recipe.safeDefaults.askStoryCastAndReferencesFirst, true)
    assert.equal(recipe.safeDefaults.requireYesNoForNextCreativeStepUnlessScopeExplicitlyDelegated, true)
    assert.equal(recipe.safeDefaults.persistedDelegationIsNotAuthorization, true)
    assert.equal(recipe.safeDefaults.boardIsReadOnlyReference, true)
    assert.equal(recipe.safeDefaults.animaticUsesNormalTimeline, true)
    assert.match(recipe.prompt, /story.*cast.*references/i)
    assert.match(recipe.prompt, /yes\/no/)
    assert.match(recipe.prompt, /explicitly delegated/)
    assert.match(recipe.prompt, /storyboardAssetId/)
  }
  const storyboard = recipes.find(item => item.id === 'project_storyboard')
  assert.match(storyboard.prompt, /deduplicates repeated asset IDs/)
  assert.match(storyboard.prompt, /sourceInSeconds/)
  assert.match(storyboard.prompt, /bind exact timelineId and clipId through previewed edit_production_run/)
  assert.equal(storyboard.safeDefaults.exportByDefault, false)
  assert.equal(storyboard.safeDefaults.askWorkflowPreferenceFirst, true)
  const initialized = await server.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.match(initialized.result.instructions, /Never generate first and ask afterward/)
  assert.match(initialized.result.instructions, /read-only reference page/)
  assert.match(initialized.result.instructions, /casting intent and existing references/)
  const schema = definitions.tools.find(tool => tool.name === 'edit_storyboard').inputSchema
  assert.deepEqual(schema.properties.shot.properties.storyboardAssetId.type, ['string', 'null'])
  assert.deepEqual(schema.properties.patch.properties.storyboardAssetId, schema.properties.shot.properties.storyboardAssetId)
  assert.equal(Object.hasOwn(schema.properties.shot.properties, 'label'), false)
  assert.equal(Object.hasOwn(schema.properties.patch.properties, 'label'), false)
  const guide = (await run('get_production_guide')).guide
  assert.match(guide.handoffPrompt, /story.*cast.*reference/i)
  assert.match(guide.handoffPrompt, /Never generate first/i)
})

test('general visual references are shared and undoable before any shot exists, without forcing legacy fields', async () => {
  const initial = await run('get_storyboard')
  assert.equal(Object.hasOwn(initial.board, 'referenceAssetIds'), false)
  const before = project.getState(), timelineBefore = timeline.getState()
  const preview = await run('edit_storyboard', { operation: 'update_board', patch: { referenceAssetIds: ['reference', 'take-a'] } })
  assert.equal(project.getState(), before)
  await run('edit_storyboard', preview.suggestedApplyPayload)
  let read = await run('get_storyboard')
  assert.deepEqual(read.board.referenceAssetIds, ['reference', 'take-a'])
  assert.deepEqual(read.board.shots, [])
  assert.deepEqual(read.assets.map(asset => asset.id), ['reference', 'take-a'])
  assert.deepEqual(read.presentation.references.map(reference => reference.assetId), ['reference', 'take-a'])
  assert.deepEqual((await run('get_production_guide')).presentation, read.presentation)
  assert.equal(JSON.stringify(read).includes('private'), false)
  assert.equal(project.getState().undoTimelineStructureChange(), true)
  assert.equal(Object.hasOwn((await run('get_storyboard')).board, 'referenceAssetIds'), false)
  assert.equal(project.getState().redoTimelineStructureChange(), true)
  assets.setState({ assets: assets.getState().assets.filter(asset => asset.id !== 'reference') })
  read = await run('get_storyboard')
  assert.equal(read.presentation.references[0].missing, true)
  assert.deepEqual(read.assets[0], { id: 'reference', missing: true })
  await edit({ operation: 'update_board', patch: { referenceAssetIds: ['reference'] } })
  await assert.rejects(run('edit_storyboard', { operation: 'update_board', patch: { referenceAssetIds: ['song'] } }), /supported media type|image.*video/i)
  assert.equal(timeline.getState(), timelineBefore)
})
