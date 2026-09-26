import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Bundle the real services, alpha rules and lifecycle guard together. Only the
// Electron filesystem bridge and Zustand stores are replaced; no user project,
// native process, app preference or durable file is opened by these tests.
const compiled = await build({
  stdin: {
    contents: "export * as playback from './playbackCache.js'; export * as proxy from './proxyCache.js'",
    resolveDir: fileURLToPath(new URL('../src/services/', import.meta.url)),
    sourcefile: 'media-preparation-services-fixture.js',
  },
  bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{
    name: 'renderer-service-boundaries',
    setup(builder) {
      builder.onResolve({ filter: /^(\.\/fileSystem|\.\.\/stores\/(assetsStore|projectStore))$/ },
        args => ({ path: args.path, namespace: 'fixture-boundary' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture-boundary' }, args => ({
        contents: args.path === './fileSystem'
          ? 'export const isElectron = () => __testEnvironment.isElectron; export const getProjectFileUrl = (...args) => __testEnvironment.resolveUrl(...args)'
          : args.path.endsWith('/assetsStore')
            ? 'export const useAssetsStore = __testAssetsStore'
            : 'export const useProjectStore = __testProjectStore',
        loader: 'js',
      }))
    },
  }],
})
const code = compiled.outputFiles[0].text
const CPU_SUCCESS = { success: true, encoder: 'libx264', hardware: false, fps: 29.97, fallbackReason: 'GPU unavailable' }
const FILE_INFO = { success: true, info: { size: 100, mtimeMs: 1234 } }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function flush() {
  for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve))
}

function harness(assetPatch = {}) {
  let project = { currentProjectHandle: '/project' }
  let assets = [{ id: 'asset-one', name: 'My shot', type: 'video', path: 'assets/source.mp4',
    absolutePath: '/project/assets/source.mp4', url: 'source://one', ...assetPatch }]
  const listeners = new Set()
  const writes = [], jobs = [], directories = [], deletes = [], urlCalls = [], fileInfoCalls = []
  const patchAsset = (id, patch) => { assets = assets.map(asset => asset.id === id ? { ...asset, ...patch } : asset) }
  const methods = {
    setPlaybackCacheStatus(id, status) {
      writes.push({ kind: 'playback', action: 'status', id, status })
      patchAsset(id, { playbackCacheStatus: status })
    },
    setPlaybackCache(id, relativePath, url, options) {
      writes.push({ kind: 'playback', action: 'cache', id, relativePath, url, options })
      patchAsset(id, { playbackCachePath: relativePath, playbackCacheUrl: url, playbackCacheVersion: options.version })
    },
    setProxyCacheStatus(id, status) {
      writes.push({ kind: 'proxy', action: 'status', id, status })
      patchAsset(id, { proxyStatus: status })
    },
    setProxyCache(id, relativePath, url, signature) {
      writes.push({ kind: 'proxy', action: 'cache', id, relativePath, url, signature })
      patchAsset(id, { proxyPath: relativePath, proxyUrl: url, proxySourceSignature: signature })
    },
  }
  const assetsStore = { getState: () => ({ assets, ...methods }) }
  const projectStore = {
    getState: () => project,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const environment = {
    isElectron: true,
    fileInfo: async () => FILE_INFO,
    makeUrl: async (projectDir, relativePath) => `cache://${projectDir}/${relativePath}`,
    resolveUrl: async (...args) => { urlCalls.push(args); return await environment.makeUrl(...args) },
  }
  const request = kind => options => {
    const result = deferred()
    jobs.push({ kind, options, ...result })
    return result.promise
  }
  const api = {
    pathJoin: async (...parts) => path.posix.join(...parts),
    pathExists: async () => true,
    createDirectory: async directory => { directories.push(directory) },
    deleteFile: async file => { deletes.push(file) },
    getFileInfo: async file => { fileInfoCalls.push(file); return await environment.fileInfo(file) },
    transcodeForPlayback: request('playback'),
    transcodeForProxy: request('proxy'),
  }
  const module = { exports: {} }
  Function('module', 'exports', '__testAssetsStore', '__testProjectStore', '__testEnvironment', 'window', 'console', code)(
    module, module.exports, assetsStore, projectStore, environment, { electronAPI: api }, { log() {}, warn() {} })
  return {
    ...module.exports, jobs, writes, directories, deletes, urlCalls, fileInfoCalls, environment, api,
    get asset() { return assets[0] },
    get listeners() { return listeners.size },
    updateAsset: patch => patchAsset('asset-one', patch),
    removeAsset() { assets = [] },
    switchProject(handle) { project = { currentProjectHandle: handle }; listeners.forEach(listener => listener(project)) },
    enqueue(kind, options) {
      return kind === 'playback'
        ? module.exports.playback.enqueuePlaybackTranscode('/project', 'asset-one', '/project/assets/source.mp4', options)
        : module.exports.proxy.enqueueProxyTranscode('/project', 'asset-one', '/project/assets/source.mp4', options)
    },
  }
}

for (const kind of ['playback', 'proxy']) {
  test(`${kind}: direct transcode forwards job metadata and preserves the success/failure result contract`, async () => {
    const h = harness()
    const transcode = kind === 'playback' ? h.playback.transcodeVideoForPlayback : h.proxy.transcodeVideoForProxy
    const success = transcode('/project', 'asset-one', '/project/assets/source.mp4', { label: 'A useful label', targetHeight: 720 })
    await flush()
    assert.deepEqual(h.jobs[0].options, {
      inputPath: '/project/assets/source.mp4', outputPath: `/project/cache/${kind}_asset-one.mp4`,
      assetId: 'asset-one', label: 'A useful label', ...(kind === 'proxy' ? { targetHeight: 720 } : {}),
    })
    h.jobs[0].resolve(CPU_SUCCESS)
    assert.deepEqual(await success, { success: true, relativePath: `cache/${kind}_asset-one.mp4` })
    const failure = transcode('/project', 'asset-one', '/project/assets/source.mp4')
    await flush()
    h.jobs[1].resolve({ success: false, error: 'Encoder failed', encoder: 'libx264', hardware: false })
    assert.deepEqual(await failure, { success: false, error: 'Encoder failed' })
    assert.deepEqual(h.directories, ['/project/cache', '/project/cache'])
    assert.equal(h.writes.length, 0)
    assert.equal(h.listeners, 0)
  })

  test(`${kind}: queue success attaches a portable cache after validation and releases its listener`, async () => {
    const h = harness()
    const originalSource = { path: h.asset.path, absolutePath: h.asset.absolutePath, url: h.asset.url }
    const pending = h.enqueue(kind)
    await flush()
    assert.equal(h.jobs.length, 1)
    assert.equal(h.jobs[0].options.assetId, 'asset-one')
    assert.equal(h.jobs[0].options.label, 'My shot')
    assert.equal(h.listeners, 1)
    assert.deepEqual(h.writes.map(write => write.action), ['status'])
    assert.equal(h.writes[0].status, 'encoding')
    h.jobs[0].resolve(CPU_SUCCESS)
    const result = await pending
    assert.deepEqual(h.writes.map(write => write.action), ['status', 'cache', 'status'])
    assert.equal(h.writes[2].status, 'ready')
    assert.equal(h.writes[1].relativePath, `cache/${kind}_asset-one.mp4`)
    assert.equal(h.writes[1].url, `cache:///project/cache/${kind}_asset-one.mp4`)
    if (kind === 'playback') {
      assert.deepEqual(h.writes[1].options, { version: h.playback.PLAYBACK_CACHE_VERSION })
      assert.deepEqual(result, { success: true, relativePath: 'cache/playback_asset-one.mp4' })
    } else {
      assert.equal(h.writes[1].signature, '100|1234')
      assert.equal(result, undefined, 'Existing fire-and-forget proxy return contract remains unchanged')
    }
    assert.deepEqual({ path: h.asset.path, absolutePath: h.asset.absolutePath, url: h.asset.url }, originalSource)
    assert.equal(h.listeners, 0)
  })

  for (const stale of ['project switch', 'project close and reopen', 'source relink', 'asset deletion']) {
    test(`${kind}: ${stale} during encoding prevents completion from mutating the current asset`, async () => {
      const h = harness()
      const pending = h.enqueue(kind)
      await flush()
      assert.equal(h.jobs.length, 1)
      const before = h.writes.length
      if (stale === 'project switch') h.switchProject('/different-project')
      else if (stale === 'project close and reopen') { h.switchProject(null); h.switchProject('/project') }
      else if (stale === 'source relink') h.updateAsset({ path: 'assets/relinked.mp4', absolutePath: '/project/assets/relinked.mp4' })
      else h.removeAsset()
      h.jobs[0].resolve(CPU_SUCCESS)
      await pending
      assert.equal(h.writes.length, before)
      assert.equal(h.urlCalls.length, 0, 'A stale native result is rejected before resolving a cache URL')
      assert.equal(h.listeners, 0)
    })
  }

  test(`${kind}: project switch during asynchronous cache URL resolution prevents attachment`, async () => {
    const h = harness(), url = deferred()
    h.environment.makeUrl = () => url.promise
    const pending = h.enqueue(kind)
    await flush()
    h.jobs[0].resolve(CPU_SUCCESS)
    await flush()
    assert.equal(h.urlCalls.length, 1)
    const before = h.writes.length
    h.switchProject('/different-project')
    url.resolve('cache://late-result')
    await pending
    assert.equal(h.writes.length, before)
    assert.equal(h.listeners, 0)
  })

  for (const failure of ['native failure', 'IPC rejection', 'URL rejection']) {
    test(`${kind}: ${failure} reports failure without replacing the source and releases its listener`, async () => {
      const h = harness()
      if (failure === 'URL rejection') h.environment.makeUrl = async () => { throw new Error('URL failed') }
      const pending = h.enqueue(kind)
      await flush()
      if (failure === 'native failure') h.jobs[0].resolve({ success: false, error: 'Encode failed' })
      else if (failure === 'IPC rejection') h.jobs[0].reject(new Error('IPC failed'))
      else h.jobs[0].resolve(CPU_SUCCESS)
      await pending
      assert.deepEqual(h.writes.map(write => write.status), ['encoding', 'failed'])
      assert.equal(h.asset.path, 'assets/source.mp4')
      assert.equal(h.asset.url, 'source://one')
      assert.equal(h.listeners, 0)
    })
  }

  test(`${kind}: alpha, deleted assets and wrong projects never enqueue native work or leak listeners`, async () => {
    for (const state of ['alpha', 'deleted', 'wrong project']) {
      const h = harness()
      if (state === 'alpha') h.updateAsset({ settings: { hasAlpha: true } })
      else if (state === 'deleted') h.removeAsset()
      else h.switchProject('/other')
      await h.enqueue(kind)
      assert.equal(h.jobs.length, 0)
      assert.equal(h.writes.length, 0)
      assert.equal(h.listeners, 0)
    }
  })
}

test('proxy: duplicate ready-cache no-op during preflight does not invalidate a forced rebuild', async () => {
  const h = harness({ proxyStatus: 'ready', proxyPath: 'cache/proxy_asset-one.mp4', proxySourceSignature: '100|1234' })
  const firstSignature = deferred(), secondSignature = deferred()
  let signatureCalls = 0
  h.environment.fileInfo = () => (++signatureCalls === 1 ? firstSignature.promise : secondSignature.promise)
  const rebuilding = h.enqueue('proxy', { force: true })
  await flush()
  const noOp = h.enqueue('proxy')
  await flush()
  assert.equal(h.listeners, 2)
  firstSignature.resolve(FILE_INFO)
  await flush()
  assert.equal(h.jobs.length, 1)
  assert.equal(h.asset.proxyStatus, 'encoding')
  secondSignature.resolve(FILE_INFO)
  await noOp
  assert.equal(h.listeners, 1)
  assert.equal(h.jobs.length, 1, 'Duplicate no-op must not create a second native request')
  h.jobs[0].resolve(CPU_SUCCESS)
  await rebuilding
  assert.deepEqual(h.writes.map(write => write.action), ['status', 'cache', 'status'])
  assert.equal(h.asset.proxyStatus, 'ready')
  assert.equal(h.listeners, 0)
})

test('proxy: duplicate while encoding does not supersede the running completion target', async () => {
  const h = harness(), pending = h.enqueue('proxy')
  await flush()
  await h.enqueue('proxy')
  assert.equal(h.jobs.length, 1)
  assert.equal(h.listeners, 1)
  h.jobs[0].resolve(CPU_SUCCESS)
  await pending
  assert.equal(h.asset.proxyStatus, 'ready')
  assert.equal(h.writes.filter(write => write.action === 'cache').length, 1)
  assert.equal(h.listeners, 0)
})

test('proxy: project change during source signature preflight prevents a native request', async () => {
  const h = harness(), signature = deferred()
  h.environment.fileInfo = () => signature.promise
  const pending = h.enqueue('proxy')
  await flush()
  assert.equal(h.listeners, 1)
  h.switchProject('/other')
  signature.resolve(FILE_INFO)
  await pending
  assert.equal(h.jobs.length, 0)
  assert.equal(h.writes.length, 0)
  assert.equal(h.listeners, 0)
})

test('playback and proxy completion targets remain independent for the same asset', async () => {
  const h = harness()
  const playback = h.enqueue('playback'), proxy = h.enqueue('proxy')
  await flush()
  assert.equal(h.jobs.length, 2)
  assert.equal(h.listeners, 2)
  for (const job of h.jobs) job.resolve(CPU_SUCCESS)
  await Promise.all([playback, proxy])
  assert.equal(h.asset.playbackCacheStatus, 'ready')
  assert.equal(h.asset.proxyStatus, 'ready')
  assert.equal(h.writes.filter(write => write.action === 'cache').length, 2)
  assert.equal(h.listeners, 0)
})

test('playback rebuild attaches the new portable cache before deleting only its previous cache', async () => {
  const h = harness({ playbackCachePath: 'cache/playback_old.mp4', playbackCacheStatus: 'ready' })
  const pending = h.enqueue('playback', { cacheBust: true })
  await flush()
  assert.match(h.jobs[0].options.outputPath, /^\/project\/cache\/playback_asset-one_[a-z0-9]+_[a-z0-9]+\.mp4$/)
  assert.equal(h.deletes.length, 0)
  h.jobs[0].resolve(CPU_SUCCESS)
  await pending
  assert.equal(h.asset.playbackCacheStatus, 'ready')
  assert.deepEqual(h.deletes, ['/project/cache/playback_old.mp4'])
  assert.equal(h.asset.path, 'assets/source.mp4')
  assert.equal(h.listeners, 0)
})
