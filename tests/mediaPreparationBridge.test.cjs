const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

const main = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
const start = main.indexOf('const mediaPreparationOwners = new Map()')
const end = main.indexOf('// GIF import (static probe', start)
assert.ok(start > 0 && end > start)
const proxyHandler = main.split('\n').find(line => line.startsWith("ipcMain.handle('proxy:transcode'"))

function fixture() {
  const handlers = new Map(), queued = [], cancelled = [], app = new EventEmitter()
  let notify, shutdown = 0
  vm.runInNewContext(main.slice(start, end) + '\n' + proxyHandler, {
    path, app, ffmpegPath: '/bundled/ffmpeg',
    resolveHardwareExportFfmpegSelection() {}, probeVideoInfo() {}, normalizePlaybackCacheFps() {}, probeHardwareEncoder() {},
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    createMediaPreparationService: options => {
      notify = options.onStatus
      return {
        enqueue: job => { queued.push(job); return Promise.resolve({ success: true }) },
        getStatus: ownerId => ({ ownerId, jobs: queued.filter(job => job.ownerId === ownerId) }),
        cancelOwner: id => cancelled.push(id),
        cancelAll: () => shutdown++,
      }
    },
  })
  const sender = id => {
    const emitter = new EventEmitter()
    emitter.id = id
    emitter.messages = []
    emitter.isDestroyed = () => false
    emitter.send = (channel, snapshot) => emitter.messages.push({ channel, snapshot })
    return emitter
  }
  return { call: (channel, sender, options) => handlers.get(channel)({ sender }, options),
    queued, cancelled, sender, notify: () => notify(), app, get shutdown() { return shutdown } }
}

test('both legacy cache IPC paths share the queue and derive owners from Electron', async () => {
  const f = fixture(), owner = f.sender(7)
  await f.call('playback:transcode', owner, { inputPath: '/project/source.mp4', outputPath: '/project/cache/p.mp4',
    ownerId: 999, kind: 'proxy', assetId: 'clip', label: 'My\nvideo.mp4' })
  await f.call('proxy:transcode', owner, { inputPath: '/project/source.mp4', outputPath: '/project/cache/q.mp4', targetHeight: 540 })
  assert.equal(f.queued[0].ownerId, 7)
  assert.equal(f.queued[0].kind, 'playback')
  assert.equal(f.queued[0].assetId, 'clip')
  assert.equal(f.queued[0].label, 'Myvideo.mp4')
  assert.equal(f.queued[1].kind, 'proxy')
  assert.equal(f.queued[1].targetHeight, 540)
  assert.equal(f.queued[1].label, 'source.mp4')
  assert.equal(owner.listenerCount('destroyed'), 1)
})

test('status events/snapshots are owner-scoped, cannot select another window', async () => {
  const f = fixture(), first = f.sender(1), second = f.sender(2)
  await f.call('playback:transcode', first, { inputPath: '/a.mp4', outputPath: '/cache/a.mp4' })
  await f.call('proxy:transcode', second, { inputPath: '/b.mp4', outputPath: '/cache/b.mp4' })
  const status = f.call('mediaPreparation:getStatus', first, { ownerId: 2 })
  assert.equal(status.jobs.length, 1)
  assert.equal(status.jobs[0].inputPath, '/a.mp4')
  f.notify()
  assert.equal(first.messages[0].snapshot.ownerId, 1)
  assert.equal(second.messages[0].snapshot.ownerId, 2)
  assert.equal(first.messages[0].channel, 'mediaPreparation:status')
})

test('main-frame reload, window destruction and app quit cancel owned work; subframes/hash navigation do not', () => {
  const f = fixture(), owner = f.sender(4)
  f.call('mediaPreparation:getStatus', owner)
  owner.emit('did-start-navigation', {}, 'url', false, false)
  owner.emit('did-start-navigation', {}, 'url#time', true, true)
  assert.deepEqual(f.cancelled, [])
  owner.emit('did-start-navigation', {}, 'url', false, true)
  assert.deepEqual(f.cancelled, [4])
  owner.emit('destroyed')
  f.notify()
  assert.equal(owner.messages.length, 0)
  assert.deepEqual(f.cancelled, [4, 4])
  f.app.emit('will-quit')
  assert.equal(f.shutdown, 1)
})

test('preload preserves legacy transcode methods and exposes a removable read-only status subscription', async () => {
  const renderer = new EventEmitter(), calls = [], exposed = {}
  renderer.invoke = async (...args) => { calls.push(args); return { jobs: [] } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.js'), 'utf8'), {
    process: { platform: 'win32' },
    require: name => {
      assert.equal(name, 'electron')
      return { ipcRenderer: renderer, contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } } }
    },
  })
  const api = exposed.electronAPI, snapshots = []
  await api.transcodeForPlayback({ inputPath: 'input' })
  await api.transcodeForProxy({ inputPath: 'input' })
  await api.getMediaPreparationStatus()
  assert.deepEqual(calls.map(call => call[0]), ['playback:transcode', 'proxy:transcode', 'mediaPreparation:getStatus'])
  const unsubscribe = api.onMediaPreparationStatus(snapshot => snapshots.push(snapshot))
  renderer.emit('mediaPreparation:status', { secret: 'native-event' }, { activeCount: 1 })
  assert.deepEqual(snapshots, [{ activeCount: 1 }])
  unsubscribe()
  assert.equal(renderer.listenerCount('mediaPreparation:status'), 0)
})
