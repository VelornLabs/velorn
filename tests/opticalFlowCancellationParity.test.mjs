import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture, loadBody, deferred, until } from './helpers/audioParityHarness.mjs'

function nativeFixture(pauseAt = null) {
  const f = fixture(), gate = deferred(), calls = [], controller = new AbortController()
  f.assets.assets.find(asset => asset.id === 'video-source').absolutePath = undefined
  f.assets.assets.find(asset => asset.id === 'video-source').path = 'assets/video.mp4'
  let pathIndex = 0
  const checkpoint = async (name, value) => { calls.push(name); if (pauseAt === name) await gate.promise; return value }
  const api = {
    pathJoin: async (...parts) => checkpoint(['source-path', 'cache-path', 'output-path'][pathIndex++] || 'later-path', parts.join('/')),
    exists: async () => checkpoint('exists', true),
    createDirectory: async () => checkpoint('mkdir', { success: true }),
    getFileInfo: async () => checkpoint('file-info', { size: 1024, mtimeMs: 1 }),
    onOpticalFlowProgress: () => () => {},
    generateOpticalFlowCache: async () => checkpoint('native', { success: true, sourceStart: 0, sourceEnd: 4, targetFps: 48 }),
    cancelOpticalFlowCache: async () => { calls.push('cancel-native') },
    deleteFile: async () => { calls.push('delete-generated-cache') },
  }
  const service = loadBody('../../src/services/opticalFlowCache.js', { ...f.globals,
    window: { electronAPI: api }, isElectron: () => true,
    getProjectFileUrl: async () => checkpoint('file-url', 'file:///synthetic/cache.mp4'),
  }, ['buildOpticalFlowCache', 'isOpticalFlowBuildActive'])
  return { ...f, gate, calls, controller, service }
}

test('a pre-aborted interpolation request performs no filesystem or GPU work', async () => {
  const f = nativeFixture()
  f.controller.abort()
  await assert.rejects(f.service.buildOpticalFlowCache('video', { signal: f.controller.signal }), /cancelled/)
  assert.equal(f.calls.length, 0)
  assert.equal(f.service.isOpticalFlowBuildActive('video'), false)
})

test('existing UI callers without an AbortSignal still complete normally', async () => {
  const f = nativeFixture()
  const result = await f.service.buildOpticalFlowCache('video')
  assert.equal(result.status, 'ready')
  assert.equal(f.clip('video').opticalFlowCache.status, 'ready')
  assert.equal(f.calls.includes('native'), true)
  assert.equal(f.service.isOpticalFlowBuildActive('video'), false)
})

test('cancel at each asynchronous startup checkpoint prevents any native generation request', async () => {
  for (const stage of ['source-path', 'exists', 'cache-path', 'mkdir', 'output-path', 'file-info']) {
    const f = nativeFixture(stage)
    const running = f.service.buildOpticalFlowCache('video', { signal: f.controller.signal })
    await until(() => f.calls.includes(stage))
    f.controller.abort(); f.gate.resolve()
    await assert.rejects(running, /cancelled/, stage)
    assert.equal(f.calls.includes('native'), false, stage)
    assert.equal(f.service.isOpticalFlowBuildActive('video'), false, stage)
    assert.equal(f.clip('video').opticalFlowCache, undefined, stage)
  }
})

test('switching timeline during asynchronous startup cannot attach a cache or launch the GPU', async () => {
  const f = nativeFixture('file-info')
  const running = f.service.buildOpticalFlowCache('video', { signal: f.controller.signal })
  await until(() => f.calls.includes('file-info'))
  f.project.currentTimelineId = 'different'
  f.gate.resolve()
  await assert.rejects(running, /source clip changed/)
  assert.equal(f.calls.includes('native'), false)
  assert.equal(f.clip('video').opticalFlowCache, undefined)
})

test('abort at registration is observed before the native request even when no progress has fired', async () => {
  const f = nativeFixture()
  const unsubscribe = f.store.subscribe(state => {
    if (state.clips.find(clip => clip.id === 'video')?.opticalFlowCache?.status === 'rendering') f.controller.abort()
  })
  try {
    await assert.rejects(f.service.buildOpticalFlowCache('video', { signal: f.controller.signal }), /cancelled/)
    assert.equal(f.calls.includes('native'), false)
    assert.equal(f.service.isOpticalFlowBuildActive('video'), false)
  } finally { unsubscribe() }
})

test('abort during native generation forwards cancellation and discards the completed derivative', async () => {
  const f = nativeFixture('native')
  const running = f.service.buildOpticalFlowCache('video', { signal: f.controller.signal })
  await until(() => f.calls.includes('native'))
  f.controller.abort()
  assert.equal(f.calls.includes('cancel-native'), true)
  f.gate.resolve()
  await assert.rejects(running, /cancelled/)
  assert.equal(f.calls.includes('delete-generated-cache'), true)
  assert.equal(f.service.isOpticalFlowBuildActive('video'), false)
  assert.notEqual(f.clip('video').opticalFlowCache.status, 'ready')
})

test('abort during final file hydration cannot publish a ready cache', async () => {
  const f = nativeFixture('file-url')
  const running = f.service.buildOpticalFlowCache('video', { signal: f.controller.signal })
  await until(() => f.calls.includes('file-url'))
  f.controller.abort(); f.gate.resolve()
  await assert.rejects(running, /cancelled/)
  assert.equal(f.calls.includes('delete-generated-cache'), true)
  assert.notEqual(f.clip('video').opticalFlowCache.status, 'ready')
})
