const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { createSongMapEngine, SONG_MODEL_FILES } = require('../electron/songMapEngine.cjs')

function setup({ withModels = true, speech = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'song-engine-test-'))
  const touch = (file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x'); return file }
  if (withModels) for (const name of Object.values(SONG_MODEL_FILES)) touch(path.join(root, 'song-engine', 'models', name))
  const ffmpegPath = touch(path.join(root, 'ffmpeg'))
  const cli = touch(path.join(root, 'whisper-cli'))
  const song = touch(path.join(root, 'song.mp3'))
  const captionService = { getStatus: () => (speech
    ? { binaryPath: cli, models: [{ id: 'small', path: touch(path.join(root, 'small.bin')) }, { id: 'large-v3-turbo', path: touch(path.join(root, 'turbo.bin')) }] }
    : { binaryPath: null, models: [] }) }
  const spawned = []
  const spawnProcess = (exec, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)) }
    spawned.push({ exec, args, options, child })
    return child
  }
  const engine = createSongMapEngine({ app: { getPath: () => root }, ffmpegPath, captionService, spawnProcess, execPath: '/app/electron', workerPath: '/app/worker.cjs' })
  return { engine, spawned, song, root }
}

test('status says ready only when every piece is on the computer', () => {
  assert.deepEqual(setup().engine.status().missing, [])
  assert.equal(setup().engine.status().speechModelId, 'large-v3-turbo')
  const bare = setup({ withModels: false, speech: false }).engine.status()
  assert.equal(bare.ready, false)
  assert.deepEqual(bare.missing.sort(), ['aligner', 'separator', 'speech engine', 'speech model'])
})

test('a song is refused when it is not a song, missing, or the engine is not ready', async () => {
  const { engine, root } = setup()
  assert.equal((await engine.analyze({ inputPath: 'relative.mp3' })).code, 'SONG_MAP_INVALID')
  assert.equal((await engine.analyze({ inputPath: path.join(root, 'notes.txt') })).code, 'SONG_MAP_INVALID')
  assert.equal((await engine.analyze({ inputPath: path.join(root, 'gone.mp3') })).code, 'SONG_MAP_NOT_FOUND')
  const unready = setup({ withModels: false })
  const refused = await unready.engine.analyze({ inputPath: unready.song })
  assert.equal(refused.code, 'SONG_MAP_NOT_READY')
  assert.equal(unready.spawned.length, 0)
})

test('listening runs the worker as plain Node, forwards progress and returns the lines', async () => {
  const { engine, spawned, song } = setup()
  const sent = []
  const pending = engine.analyze({ inputPath: song }, { isDestroyed: () => false, send: (channel, data) => sent.push([channel, data]) })
  const { exec, args, options, child } = spawned[0]
  assert.equal(exec, '/app/electron')
  assert.equal(args[0], '/app/worker.cjs')
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1')
  const request = JSON.parse(args[1])
  assert.equal(request.inputPath, song)
  assert.match(request.whisperModelPath, /turbo\.bin$/)
  assert.equal((await engine.analyze({ inputPath: song })).code, 'SONG_MAP_BUSY')
  child.stdout.emit('data', '{"type":"progress","step":"voice","percent":40}\n{"type":"prog')
  child.stdout.emit('data', 'ress","step":"words","percent":5}\nnot json\n')
  child.stdout.emit('data', '{"type":"result","duration":10,"rows":[{"start":1,"end":2,"text":"la","conf":0.9}],"voice":[[1,2]],"seconds":{}}\n')
  child.emit('close', 0)
  const result = await pending
  assert.equal(result.success, true)
  assert.deepEqual(result.lines, [{ start: 1, end: 2, text: 'la', conf: 0.9 }])
  assert.deepEqual(sent, [['songMap:progress', { step: 'voice', percent: 40 }], ['songMap:progress', { step: 'words', percent: 5 }]])
  assert.equal(engine.status().busy, false)
})

test('a worker error and a stop are both reported plainly', async () => {
  const failed = setup()
  const pending = failed.engine.analyze({ inputPath: failed.song })
  failed.spawned[0].child.stdout.emit('data', '{"type":"error","error":"The song could not be read"}\n')
  failed.spawned[0].child.emit('close', 1)
  assert.deepEqual(await pending, { success: false, code: 'SONG_MAP_FAILED', error: 'The song could not be read' })

  const stopped = setup()
  const running = stopped.engine.analyze({ inputPath: stopped.song })
  assert.deepEqual(stopped.engine.cancel(), { success: true, cancelled: true })
  assert.equal((await running).code, 'SONG_MAP_CANCELLED')
  assert.deepEqual(stopped.engine.cancel(), { success: true, cancelled: false })
})
