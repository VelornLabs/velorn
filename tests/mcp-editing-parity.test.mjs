import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
const code = buildSync({ stdin: { contents: `
  export { MCP_EDITING_ACTIONS } from './src/services/mcpEditingParity.js';
  export { useTimelineStore } from './src/stores/timelineStore.js';
  export { default as useAssetsStore } from './src/stores/assetsStore.js';
  export { default as useProjectStore } from './src/stores/projectStore.js';`, resolveDir: root },
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'zustand', 'zustand/*'],
  loader: { '.glsl': 'text', '.png': 'dataurl', '.svg': 'dataurl' },
}).outputFiles[0].text
const module = { exports: {} }
Function('require', 'module', 'exports', 'localStorage', code)(require, module, module.exports,
  { getItem: () => null, setItem() {}, removeItem() {} })
const { MCP_EDITING_ACTIONS: tools, useTimelineStore: timeline, useAssetsStore: assets, useProjectStore: projects } = module.exports
const initial = timeline.getState()
const clip = (id, startTime, duration, patch = {}) => ({ id, name: id, assetId: 'old', type: 'video', trackId: 'v',
  startTime, duration, trimStart: startTime, trimEnd: startTime + duration, sourceDuration: 30, sourceTimeScale: 1,
  timelineFps: 10, sourceFps: 10, speed: 1, reverse: false, url: 'memory:old', transform: { positionX: 0, scaleX: 100, scaleY: 100, scaleLinked: true }, ...patch })
function reset(patch = {}) {
  timeline.setState({ ...initial, clips: [clip('a', 2, 3), clip('b', 5, 2), clip('c', 7, 3)],
    tracks: [{ id: 'v', name: 'Picture', type: 'video', visible: true }, { id: 's', name: 'Sound', type: 'audio', visible: true }],
    transitions: [], markers: [], selectedClipIds: ['a'], activeTrackId: 'v', playheadPosition: 2,
    duration: 60, timelineFps: 10, history: [], historyIndex: -1, historyLastChangedAt: 0,
    clipCounter: 10, transitionCounter: 1, markerCounter: 1, isPlaying: false, compoundEditContext: null, rippleEditMode: false, ...patch })
  assets.setState({ assets: [{ id: 'old', name: 'Old', type: 'video', duration: 30, url: 'memory:old', hasAudio: false, settings: { fps: 10 } },
    { id: 'new', name: 'New', type: 'video', duration: 30, url: 'memory:new', hasAudio: false, settings: { fps: 10 } }], folders: [] })
  projects.setState({ currentProjectHandle: '/__mcp_editing_memory__', currentTimelineId: 'tl',
    currentProject: { id: 'p', name: 'Synthetic', settings: { width: 1920, height: 1080, fps: 10 }, timelines: [{ id: 'tl' }] } })
}
beforeEach(() => reset())
const call = (name, payload) => tools[name](payload)
const apply = (name, payload) => call(name, { ...payload, previewOnly: false })
const current = () => timeline.getState()
const noWrite = fn => {
  const before = current(); let count = 0
  const off = timeline.subscribe(() => count++)
  try { return fn() } finally { off(); assert.equal(count, 0, 'no timeline write'); assert.equal(current(), before) }
}
const atomic = fn => {
  let count = 0; const off = timeline.subscribe(() => count++)
  let result
  try { result = fn() } finally { off() }
  assert.equal(count, 1, 'one atomic store write')
  assert.equal(current().history.length, 1, 'one undo checkpoint')
  return result
}
const document = () => JSON.parse(JSON.stringify({ clips: current().clips, tracks: current().tracks, transitions: current().transitions, markers: current().markers }))

test('schemas and actual handler map agree, previews are default and no generic state write is needed', () => {
  const schemas = require('../electron/mcpEditingTools.cjs')
  assert.deepEqual(schemas.tools.map(tool => tool.name).sort(), Object.keys(tools).sort())
  for (const schema of schemas.tools.filter(tool => schemas.writableTools.includes(tool.name))) assert.equal(schema.inputSchema.properties.previewOnly.default, true)
  const result = noWrite(() => call('set_clip_style', { clipIds: ['a', 'b'], positionX: 10 }))
  assert.equal(result.previewOnly, true)
  assert.equal(result.wouldChange, true)
  assert.ok(result.previewToken)
})

test('batch style commits one undo step, preserves UI selection and undoes all clips', () => {
  const before = document(), selected = current().selectedClipIds
  const preview = noWrite(() => call('set_clip_style', { clipIds: ['a', 'b'], positionX: 10, opacity: 60 }))
  atomic(() => call('set_clip_style', preview.suggestedApplyPayload))
  assert.equal(current().clips[0].transform.positionX, 10)
  assert.equal(current().clips[1].transform.opacity, 60)
  assert.equal(current().selectedClipIds, selected)
  current().undo(); assert.deepEqual(document(), before)
})

test('no-op style leaves clips/history/redo references intact', () => {
  noWrite(() => apply('set_clip_style', { clipId: 'a', positionX: 0 }))
  noWrite(() => apply('set_clip_style', { clipId: 'a', enabled: true, labelColor: '', trackMatte: 'none', motionBlurEnabled: false, blur: 0 }))
  assert.equal(current().history.length, 0)
})

test('locked or animated member rejects whole style batch without history', () => {
  for (const patch of [{ locked: true }, { keyframes: { positionX: [{ time: 0, value: 0 }] } }, { keyframes: { 'transform.positionX': [{ time: 0, value: 0 }] } }]) {
    reset({ clips: [clip('a', 2, 3), clip('b', 5, 2, patch)] })
    noWrite(() => assert.throws(() => apply('set_clip_style', { clipIds: ['a', 'b'], positionX: 8 }), /Unlock|Animated/))
  }
})

test('unknown style keys, invalid colors and linked-scale animation reject', () => {
  noWrite(() => assert.throws(() => apply('set_clip_style', { clipId: 'a', transform: { arbitrary: 4 } }), /Unsupported/))
  noWrite(() => assert.throws(() => apply('set_clip_color', { clipId: 'a', adjustments: { imaginary: 20 } }), /Unsupported/))
  reset({ clips: [clip('a', 2, 3, { keyframes: { scaleY: [{ time: 0, value: 100 }] } })] })
  noWrite(() => assert.throws(() => apply('set_clip_style', { clipId: 'a', scaleX: 150 }), /Animated/))
})

test('batch color uses sparse native grading updates and preserves other grades', () => {
  reset({ clips: [clip('a', 2, 3, { adjustments: { saturation: 9, shadows: { tint: 4 } } }), clip('b', 5, 2)] })
  atomic(() => apply('set_clip_color', { clipIds: ['a', 'b'], adjustments: { contrast: 12, shadows: { hue: 4 } } }))
  assert.equal(current().clips[0].adjustments.saturation, 9)
  assert.equal(current().clips[0].adjustments.shadows.tint, 4)
  assert.equal(current().clips[1].adjustments.contrast, 12)
  assert.equal(current().clips[1].adjustments.shadows.hue, 4)
})

test('preview token and context reject stale edits and changed operands', () => {
  const preview = call('set_clip_style', { clipId: 'a', positionX: 10 })
  noWrite(() => assert.throws(() => call('set_clip_style', { ...preview.suggestedApplyPayload, positionX: 20 }), /arguments changed/))
  timeline.setState({ selectedClipIds: ['b'] })
  noWrite(() => assert.throws(() => call('set_clip_style', preview.suggestedApplyPayload), /timeline changed/))
  const preview2 = call('set_clip_style', { clipId: 'a', positionX: 10 })
  assets.setState({ assets: [...assets.getState().assets] })
  noWrite(() => assert.throws(() => call('set_clip_style', preview2.suggestedApplyPayload), /changed after preview/))
})

test('paste attributes is explicit, selective and undoable without changing clipboard/selection', () => {
  reset({ clips: [clip('a', 2, 3, { transform: { opacity: 40 }, adjustments: { contrast: 25 } }), clip('b', 5, 2)], selectedClipIds: ['a'] })
  const before = document(), clipboard = current().attributeClipboard
  atomic(() => apply('paste_clip_attributes', { sourceClipId: 'a', destinationClipIds: ['b'], groups: ['color'] }))
  assert.equal(current().clips[1].adjustments.contrast, 25)
  assert.equal(current().clips[1].transform.opacity, undefined)
  assert.equal(current().attributeClipboard, clipboard)
  current().undo(); assert.deepEqual(document(), before)
})

test('effects add, inspect and update use exact native shared groups including single-clip target', () => {
  const list = call('inspect_clip_effects', { clipIds: ['a', 'b'] })
  const effect = list.supportedTypes.find(item => item.id === 'glslFilmGrain') || list.supportedTypes.find(item => item.params.length && item.params.every(param => !param.type || param.type === 'toggle'))
  assert.ok(effect)
  atomic(() => apply('edit_clip_effects', { clipIds: ['a', 'b'], action: 'add', effectType: effect.id }))
  assert.notEqual(current().clips[0].effects[0].id, current().clips[1].effects[0].id)
  const group = call('inspect_clip_effects', { clipIds: ['a', 'b'] }).sharedGroups.find(group => group.type === effect.id)
  apply('edit_clip_effects', { clipIds: ['a', 'b'], action: 'enabled', group, enabled: false })
  assert.equal(current().clips[1].effects[0].enabled, false)
  apply('edit_clip_effects', { clipId: 'a', action: 'remove', effectId: current().clips[0].effects[0].id })
  assert.equal(current().clips[0].effects.length, 0)
  assert.equal(current().clips[1].effects.length, 1)
})

test('native roll, slip, slide and ripple previews are read-only and commits undo atomically', () => {
  for (const payload of [{ mode: 'normal', clipId: 'a', targetClipIds: ['a', 'b'], edge: 'start', deltaSeconds: .2 },
    { mode: 'roll', clipAId: 'a', clipBId: 'b', deltaSeconds: .2 },
    { mode: 'slip', clipId: 'b', deltaSeconds: .2 }, { mode: 'slide', clipId: 'b', deltaSeconds: .2 },
    { mode: 'ripple', clipId: 'a', edge: 'end', deltaSeconds: .2 }]) {
    reset(); const before = document()
    const preview = noWrite(() => call('edit_trim', payload))
    assert.equal(preview.plan.summary.deltaSeconds, .2)
    atomic(() => call('edit_trim', preview.suggestedApplyPayload))
    current().undo(); assert.deepEqual(document(), before)
  }
})

test('semantic trims preserve reverse source clocks and return accepted bounds', () => {
  reset({ clips: [clip('a', 2, 3, { reverse: true }), clip('b', 5, 2, { reverse: true }), clip('c', 7, 3)] })
  const preview = noWrite(() => call('edit_trim', { mode: 'roll', clipAId: 'a', clipBId: 'b', deltaSeconds: 500 }))
  assert.ok(preview.plan.summary.deltaSeconds < 500)
  assert.ok(preview.plan.summary.bounds)
  atomic(() => call('edit_trim', preview.suggestedApplyPayload))
  assert.equal(current().clips[0].reverse, true)
})

test('basic trim validates every member before one write, rejects source overrun and overlaps', () => {
  noWrite(() => assert.throws(() => apply('trim_clips', { clips: [{ clipId: 'a', durationSeconds: 1 }, { clipId: 'missing', durationSeconds: 1 }] }), /missing/))
  noWrite(() => assert.throws(() => apply('trim_clips', { clipId: 'a', durationSeconds: 100 }), /source bounds/))
  noWrite(() => assert.throws(() => apply('trim_clips', { clipId: 'a', durationSeconds: 4 }), /overlap/))
  const before = document()
  atomic(() => apply('trim_clips', { clips: [{ clipId: 'a', durationSeconds: 2 }, { clipId: 'b', durationSeconds: 1 }] }))
  current().undo(); assert.deepEqual(document(), before)
})

test('source insert freezes time/destinations and inserts linked picture/sound with one undo', () => {
  assets.setState({ assets: assets.getState().assets.map(asset => ({ ...asset, hasAudio: true })) })
  const before = document()
  const preview = noWrite(() => call('edit_source', { assetId: 'new', mode: 'insert', sourceInSeconds: 1, sourceOutSeconds: 2, trackId: 'v', audioTrackId: 's' }))
  atomic(() => call('edit_source', preview.suggestedApplyPayload))
  const placed = current().clips.filter(clip => clip.assetId === 'new')
  assert.equal(placed.length, 2)
  assert.equal(placed[0].linkGroupId, placed[1].linkGroupId)
  assert.equal(current().clips.find(clip => clip.id === 'a').startTime, 3)
  current().undo(); assert.deepEqual(document(), before)
})

test('source overwrite and append use native planners; explicit locked destination rejects', () => {
  for (const mode of ['overwrite', 'append']) {
    reset(); const before = document()
    atomic(() => apply('edit_source', { assetId: 'new', mode, sourceInSeconds: 0, sourceOutSeconds: 1, trackId: 'v', startSeconds: 3 }))
    const placed = current().clips.find(clip => clip.assetId === 'new')
    assert.equal(placed.startTime, mode === 'append' ? 10 : 3)
    current().undo(); assert.deepEqual(document(), before)
  }
  timeline.setState({ tracks: current().tracks.map(track => ({ ...track, locked: true })) })
  noWrite(() => assert.throws(() => apply('edit_source', { assetId: 'new', mode: 'insert', trackId: 'v' }), /unlocked/))
})

test('Smart Replace keeps edits, custom source In and undo; refuses insufficient replacement media', () => {
  const before = document()
  atomic(() => apply('replace_clip_with_asset', { clipId: 'a', assetId: 'new', sourceInSeconds: 7 }))
  assert.equal(current().clips[0].assetId, 'new')
  assert.equal(current().clips[0].duration, 3)
  assert.equal(current().clips[0].trimStart, 7)
  current().undo(); assert.deepEqual(document(), before)
  assets.setState({ assets: assets.getState().assets.map(asset => asset.id === 'new' ? { ...asset, duration: 1 } : asset) })
  noWrite(() => assert.throws(() => apply('replace_clip_with_asset', { clipId: 'a', assetId: 'new' }), /replacement needs|only/))
})

test('compound creation, closed/open inspection, child edit, close and uncompound use native actions', () => {
  atomic(() => apply('create_compound', { clipIds: ['a', 'b'], name: 'Scene' }))
  const parent = current().clips.find(clip => clip.type === 'compound')
  assert.ok(parent)
  const closed = noWrite(() => call('inspect_compound', { clipId: parent.id }))
  assert.equal(closed.document.clips.length, 2)
  noWrite(() => call('open_compound', { clipId: parent.id }))
  apply('open_compound', { clipId: parent.id })
  const childId = current().clips[0].id
  apply('set_clip_style', { clipId: childId, positionX: 25 })
  const open = noWrite(() => call('inspect_compound', { clipId: parent.id }))
  assert.equal(open.isOpen, true)
  assert.equal(open.document.clips[0].transform.positionX, 25)
  noWrite(() => assert.throws(() => apply('set_clip_style', { clipId: childId, blendMode: 'screen' }), /normal blending/))
  apply('close_compound', {})
  const before = document()
  apply('uncompound', { clipId: parent.id })
  assert.equal(current().clips.some(clip => clip.type === 'compound'), false)
  current().undo(); assert.deepEqual(document(), before)
})

test('compound parent styling and stale native tokens are refused', () => {
  apply('create_compound', { clipIds: ['a', 'b'] })
  const parent = current().clips.find(clip => clip.type === 'compound')
  noWrite(() => assert.throws(() => apply('set_clip_style', { clipId: parent.id, opacity: 40 }), /compound/))
  const preview = call('rename_compound', { clipId: parent.id, name: 'New name' })
  apply('rename_compound', { clipId: parent.id, name: 'Other name' })
  noWrite(() => assert.throws(() => call('rename_compound', preview.suggestedApplyPayload), /changed after preview/))
})

test('transition preview clamps handles and add/update/remove each commit one undo step', () => {
  const preview = noWrite(() => call('add_transition', { clipAId: 'a', clipBId: 'b', durationSeconds: 99, transitionType: 'dissolve' }))
  assert.ok(preview.plan.summary.transition.duration < 99)
  atomic(() => call('add_transition', preview.suggestedApplyPayload))
  const transitionId = current().transitions[0].id
  const before = document()
  apply('update_transition', { transitionId, settings: { color: '#112233' } })
  assert.equal(current().transitions[0].settings.color, '#112233')
  current().undo(); assert.deepEqual(document(), before)
  apply('remove_transitions', { transitionIds: [transitionId] })
  assert.equal(current().transitions.length, 0)
  current().undo(); assert.deepEqual(document(), before)
})

test('transition preflight rejects compound/locked/incompatible clips before mutation', () => {
  timeline.setState({ tracks: current().tracks.map(track => track.id === 'v' ? { ...track, locked: true } : track) })
  noWrite(() => assert.throws(() => apply('add_transition', { clipAId: 'a', clipBId: 'b' }), /Unlock/))
  reset({ clips: [clip('a', 2, 3), clip('b', 10, 2)] })
  noWrite(() => assert.throws(() => apply('add_transition', { clipAId: 'a', clipBId: 'b' }), /handles|timing/))
})
