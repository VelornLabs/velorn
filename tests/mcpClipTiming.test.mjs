import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const code = buildSync({ stdin: { contents: `
  export * from './src/services/mcpSnapshot';
  export { default as timeline } from './src/stores/timelineStore';
  export { default as assets } from './src/stores/assetsStore';
  export { default as project } from './src/stores/projectStore';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'zustand', 'zustand/*'],
  loader: { '.glsl': 'text', '.png': 'dataurl', '.svg': 'dataurl' },
}).outputFiles[0].text
const module = { exports: {} }
Function('require', 'module', 'exports', 'localStorage', 'window', code)(require, module, module.exports,
  { getItem: () => null, setItem() {}, removeItem() {} }, { addEventListener() {}, removeEventListener() {} })
const { timeline, assets, project, buildMcpSnapshot } = module.exports
const initial = timeline.getState()
const json = result => JSON.parse(result.content.find(item => item.type === 'text').text)

beforeEach(() => {
  project.setState({ currentProjectHandle: '/synthetic/clip-timing', currentTimelineId: 'timeline', currentProject: {
    name: 'Clip timing fixture', settings: { width: 1920, height: 1080, fps: 24 },
    timelines: [{ id: 'timeline', name: 'Main' }],
  } })
  assets.setState({ assets: [{ id: 'video', type: 'video', duration: 60 }, { id: 'still', type: 'image' }], folders: [] })
  timeline.setState({ ...initial, timelineSessionId: timeline.getState().timelineSessionId + 1,
    clips: [
      { id: 'picture-1', assetId: 'video', type: 'video', trackId: 'v1', startTime: 0, duration: 3,
        trimStart: 0, trimEnd: 3, sourceDuration: 60, speed: 1, sourceTimeScale: 1 },
      { id: 'picture-2', assetId: 'video', type: 'video', trackId: 'v1', startTime: 3, duration: 4,
        trimStart: 5, trimEnd: 13, sourceDuration: 60, speed: 2, sourceTimeScale: 1, reverse: true },
      { id: 'picture-3', assetId: 'still', type: 'image', trackId: 'v1', startTime: 7, duration: 4 },
      { id: 'title', type: 'text', trackId: 'v2', startTime: 0, duration: 2 },
    ],
    tracks: [{ id: 'v1', type: 'video' }, { id: 'v2', type: 'video' }], transitions: [], markers: [],
    timelineFps: 24, duration: 11, selectedClipIds: [], compoundEditContext: null,
  })
})

test('actual renderer snapshot adds computed timing without modifying authored fields or stores', () => {
  const before = timeline.getState(), clipsBefore = structuredClone(before.clips)
  const snapshot = buildMcpSnapshot()
  assert.equal(timeline.getState(), before)
  assert.deepEqual(before.clips, clipsBefore)
  assert.equal(snapshot.schemaVersion, 2)
  assert.equal(snapshot.currentTimeline.clipCount, 4)
  assert.equal(snapshot.currentTimeline.clips[0].sourceDuration, 60)
  assert.equal(snapshot.currentTimeline.clips[0].trimEnd, 3)
  assert.equal(snapshot.currentTimeline.clips[0].computedTiming.source.midpointSeconds, 1.5)
  assert.equal(snapshot.currentTimeline.clips[1].computedTiming.timeline.midpointSeconds, 5)
  assert.equal(snapshot.currentTimeline.clips[1].computedTiming.source.midpointSeconds, 9)
  assert.equal(snapshot.currentTimeline.clips[2].computedTiming.source.status, 'not-applicable')
  assert.equal(snapshot.currentTimeline.clips[3].computedTiming.timeline.endSeconds, 2)
  const calculated = snapshot.currentTimeline.clips.map(clip => clip.computedTiming)
  assert.deepEqual(JSON.parse(JSON.stringify(calculated)), calculated)
})

test('get_timeline and inspect_clip preserve identical calculated values over the native read boundary', async () => {
  const server = createComfyStudioMcpServer()
  server.updateSnapshot(buildMcpSnapshot())
  const response = json(await server.callTool('get_timeline', { includeClips: true }))
  assert.equal(response.clips.length, 4)
  assert.equal(response.clips[0].computedTiming.source.midpointSeconds, 1.5)
  const inspected = json(await server.callTool('inspect_clip', { clipId: 'picture-2', includeImage: false }))
  assert.deepEqual(inspected.clip.computedTiming, response.clips[1].computedTiming)
  assert.equal(inspected.visual.imageIncluded, false)
  assert.equal(json(await server.callTool('get_timeline', { includeClips: false })).clips, undefined)
})

test('snapshot computes from original authored values, not safeNumber fallback values', () => {
  timeline.setState({ clips: [{ ...timeline.getState().clips[0], speed: '2' }] })
  const clip = buildMcpSnapshot().currentTimeline.clips[0]
  assert.equal(clip.speed, 2, 'Legacy serialized field is preserved')
  assert.equal(clip.computedTiming.source.status, 'unavailable')
  assert.equal(clip.computedTiming.source.midpointSeconds, null)
})

test('snapshot keeps unavailable and unbounded source durations nullable', () => {
  timeline.setState({ clips: [
    { ...timeline.getState().clips[2], sourceDuration: Infinity },
    { ...timeline.getState().clips[3], sourceDuration: null },
  ] })
  const clips = buildMcpSnapshot().currentTimeline.clips
  assert.equal(clips[0].sourceDuration, null)
  assert.equal(clips[1].sourceDuration, null)
})

test('removing a referenced asset changes source availability without changing timeline timing', () => {
  assets.setState({ assets: [] })
  const clip = buildMcpSnapshot().currentTimeline.clips[0]
  assert.equal(clip.computedTiming.timeline.midpointSeconds, 1.5)
  assert.equal(clip.computedTiming.source.status, 'unavailable')
  assert.equal(clip.computedTiming.source.reason, 'source-asset-not-in-project')
})
