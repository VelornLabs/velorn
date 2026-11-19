const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createMediaPreparationService } = require('../electron/mediaPreparation')

const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
const preparationStart = source.indexOf('const mediaPreparationOwners = new Map()')
const preparationEnd = source.indexOf('// GIF import (static probe', preparationStart)
const trashStart = source.indexOf("ipcMain.handle('fs:trashAssetFiles'")
const trashEnd = source.indexOf("ipcMain.handle('fs:deleteFile'", trashStart)
assert.ok(preparationStart > 0 && preparationEnd > preparationStart && trashStart > 0 && trashEnd > trashStart)

async function until(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise(setImmediate)
  }
  assert.fail('Expected asynchronous native-boundary state was not reached.')
}

function fixture({ probe = async () => ({ success: false, error: 'Synthetic source has no video' }),
  trash = () => ({ success: true, results: [] }) } = {}) {
  const handlers = new Map(), calls = []
  const sender = id => Object.assign(new EventEmitter(), {
    id, mainFrame: {}, isDestroyed: () => false, send() {},
  })
  const editor = sender(1)
  let service, exclusiveCalls = 0
  vm.runInNewContext(source.slice(preparationStart, preparationEnd) + source.slice(trashStart, trashEnd), {
    app: new EventEmitter(), path, ffmpegPath: '/synthetic/ffmpeg',
    resolveHardwareExportFfmpegSelection() {}, probeHardwareEncoder() {}, normalizePlaybackCacheFps() {},
    probeVideoInfo: probe,
    createMediaPreparationService: options => {
      service = createMediaPreparationService({ ...options,
        spawn: () => assert.fail('Boundary tests must never spawn a real encoder'),
      })
      const exclusive = service.runExclusiveWhenIdle
      service.runExclusiveWhenIdle = operation => { exclusiveCalls += 1; return exclusive(operation) }
      return service
    },
    mainWindow: { isDestroyed: () => false, webContents: editor },
    assetTrash: { trashAssetFiles: payload => { calls.push(payload); return trash(payload) } },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  })
  return { service, calls, editor, sender, get exclusiveCalls() { return exclusiveCalls },
    enqueue: (owner, name) => handlers.get('playback:transcode')({ sender: owner }, {
      inputPath: `/synthetic/${name}.mov`, outputPath: `/synthetic/cache/${name}.mp4`,
    }),
    trash: (event = { sender: editor, senderFrame: editor.mainFrame }, payload = { paths: ['/synthetic/a.mov'] }) => (
      handlers.get('fs:trashAssetFiles')(event, payload)
    ),
  }
}

test('native Trash refuses queued microtasks and awaited probes across owners without cancelling work', async () => {
  let resumeProbe
  const f = fixture({ probe: () => new Promise(resolve => { resumeProbe = resolve }) })
  const first = f.enqueue(f.editor, 'first')
  const second = f.enqueue(f.sender(2), 'second')
  const beforeDrain = await f.trash()
  assert.equal(beforeDrain.success, false)
  assert.match(beforeDrain.error, /Wait for playback caches and proxies to finish/)
  assert.equal(beforeDrain.results.length, 0)
  await until(() => resumeProbe)
  const probing = await f.trash()
  assert.equal(probing.success, false)
  assert.equal(f.calls.length, 0)
  assert.equal(f.service.getStatus().cancelledCount, 0)
  f.editor.emit('render-process-gone')
  resumeProbe({ success: false })
  assert.equal((await first).cancelled, true)
  let secondFinished = false
  second.then(() => { secondFinished = true })
  await until(() => f.service.getStatus(2).activeCount === 1)
  assert.equal(secondFinished, false)
  assert.equal((await f.trash()).success, false, 'Another owner still blocks Trash')
  resumeProbe({ success: false })
  await second
  assert.equal((await f.trash()).success, true)
  assert.equal(f.calls.length, 1)
})

test('native Trash holds the preparation lease until success and does not let foreign renderers acquire it', async () => {
  let finishTrash
  const f = fixture({ trash: () => new Promise(resolve => { finishTrash = resolve }) })
  for (const event of [{ sender: f.sender(2), senderFrame: {} }, { sender: f.editor },
    { sender: f.editor, senderFrame: {} }]) {
    const result = await f.trash(event)
    assert.equal(result.success, false)
    assert.match(result.error, /Only the Velorn editor/)
  }
  assert.equal(f.exclusiveCalls, 0, 'Authorization runs before claiming the queue lease')
  assert.equal(f.calls.length, 0)
  const removing = f.trash()
  assert.equal(f.calls.length, 1)
  for (const owner of [f.editor, f.sender(2)]) {
    const refused = await f.enqueue(owner, 'while-removing')
    assert.equal(refused.success, false)
    assert.match(refused.error, /retry media preparation after removal finishes/i)
  }
  assert.equal((await f.trash()).success, false, 'Concurrent Trash cannot overlap the lease')
  assert.equal(f.calls.length, 1)
  finishTrash({ success: true, results: [{ path: '/synthetic/a.mov', success: true }] })
  assert.equal((await removing).success, true)
  const preparation = f.enqueue(f.editor, 'after-removal')
  assert.equal(f.service.getStatus().queuedCount, 1, 'Preparation can enter after the lease releases')
  await preparation
})

test('native Trash reports thrown and rejected failures and always releases its lease', async () => {
  for (const trash of [() => { throw new Error('Synthetic synchronous failure') },
    () => Promise.reject(new Error('Synthetic asynchronous failure'))]) {
    const f = fixture({ trash })
    const result = await f.trash()
    assert.equal(result.success, false)
    assert.equal(result.results.length, 0)
    assert.match(result.error, /Synthetic .* failure/)
    const preparation = f.enqueue(f.editor, 'after-failure')
    assert.equal(f.service.getStatus().queuedCount, 1)
    await preparation
  }
})
