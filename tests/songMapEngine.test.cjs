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

test('the speech model download passes its byte counts on, and stops listening afterwards', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'song-engine-test-'))
  const ffmpegPath = path.join(root, 'ffmpeg'); fs.writeFileSync(ffmpegPath, 'x')
  let listener = null, unsubscribed = 0
  const captionService = {
    getStatus: () => ({ binaryPath: null, models: [] }),
    onProgress: (callback) => { listener = callback; return () => { unsubscribed += 1; listener = null } },
    install: async () => {
      listener({ phase: 'download-model', percent: 0 })
      listener({ phase: 'download-model', receivedBytes: 400, totalBytes: 1000 })
      listener({ phase: 'download-model', receivedBytes: 1200, totalBytes: 1000 })
      return { success: false, error: 'stopped for the test' }
    },
  }
  const engine = createSongMapEngine({ app: { getPath: () => root }, ffmpegPath, captionService, execPath: '/app/electron', workerPath: '/app/worker.cjs' })
  const seen = []
  const result = await engine.install((update) => seen.push(update))
  assert.equal(result.success, false)
  assert.deepEqual(seen, [
    { step: 'speech', doneBytes: 0, totalBytes: 0 },
    { step: 'speech', doneBytes: 400, totalBytes: 1000 },
    { step: 'speech', doneBytes: 1000, totalBytes: 1000 },
  ])
  assert.equal(unsubscribed, 1)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a graphics-card speech program is tried first when there is one, and left alone for the session once it lets us down', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'song-engine-card-'))
  const touch = (file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x'); return file }
  for (const name of Object.values(SONG_MODEL_FILES)) touch(path.join(root, 'song-engine', 'models', name))
  const ffmpegPath = touch(path.join(root, 'ffmpeg')), cli = touch(path.join(root, 'whisper-cli')), card = touch(path.join(root, 'gpu', 'whisper-cli')), song = touch(path.join(root, 'song.mp3'))
  const state = { card }
  const captionService = { getStatus: () => ({ binaryPath: cli, gpuBinaryPath: state.card, models: [{ id: 'large-v3-turbo', path: touch(path.join(root, 'turbo.bin')) }] }) }
  const spawned = []
  const spawnProcess = (exec, args) => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; spawned.push({ args, child }); return child }
  const engine = createSongMapEngine({ app: { getPath: () => root }, ffmpegPath, captionService, spawnProcess, execPath: '/app/electron', workerPath: '/app/worker.cjs' })
  const listen = async speech => {
    const pending = engine.analyze({ inputPath: song }, { isDestroyed: () => false, send: () => {} })
    const { args, child } = spawned.at(-1)
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', speech, duration: 10, rows: [], voice: [], seconds: {} }) + '\n'))
    child.emit('close', 0)
    return { request: JSON.parse(args[1]), result: await pending }
  }
  // The card version is offered beside the plain one, never instead of it.
  const first = await listen({ used: 'card' })
  assert.deepEqual([first.request.whisperCliPath, first.request.whisperGpuCliPath, first.result.speech], [cli, card, { used: 'card' }])
  // It found no card: the words were heard on the processor, and it is not tried again while Velorn runs.
  const second = await listen({ used: 'processor', cardProblem: 'no-card' })
  assert.deepEqual([second.request.whisperGpuCliPath, second.result.speech], [card, { used: 'processor', cardProblem: 'no-card' }])
  const third = await listen({ used: 'processor' })
  assert.deepEqual([third.request.whisperCliPath, third.request.whisperGpuCliPath, third.result.speech], [cli, undefined, { used: 'processor' }])
  // A computer without the card version is asked nothing new.
  const plainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'song-engine-plain-'))
  for (const name of Object.values(SONG_MODEL_FILES)) { fs.mkdirSync(path.join(plainRoot, 'song-engine', 'models'), { recursive: true }); fs.writeFileSync(path.join(plainRoot, 'song-engine', 'models', name), 'x') }
  state.card = null
  const plain = createSongMapEngine({ app: { getPath: () => plainRoot }, ffmpegPath, captionService, spawnProcess, execPath: '/app/electron', workerPath: '/app/worker.cjs' })
  const waiting = plain.analyze({ inputPath: song }, { isDestroyed: () => false, send: () => {} })
  assert.equal('whisperGpuCliPath' in JSON.parse(spawned.at(-1).args[1]), false)
  spawned.at(-1).child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', duration: 1, rows: [], voice: [], seconds: {} }) + '\n')); spawned.at(-1).child.emit('close', 0)
  assert.deepEqual((await waiting).speech, { used: 'processor' })
})

test('a listen that dies without a word is tried once more on the processor alone, and only once', async () => {
  const { engine, spawned, song } = setup()
  const pending = engine.analyze({ inputPath: song }, { isDestroyed: () => false, send: () => {} })
  assert.equal(JSON.parse(spawned[0].args[1]).useCard, undefined)
  spawned[0].child.stderr.emit('data', Buffer.from('the card driver took the process down'))
  spawned[0].child.emit('close', 139)
  await new Promise(resolve => setImmediate(resolve))
  // The second try is told to leave the card alone, and its answer is the answer.
  assert.equal(spawned.length, 2)
  assert.equal(JSON.parse(spawned[1].args[1]).useCard, false)
  spawned[1].child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', speech: { used: 'processor' }, models: { voice: { on: 'processor' }, timing: { on: 'processor' } }, duration: 5, rows: [], voice: [], seconds: {} }) + '\n'))
  spawned[1].child.emit('close', 0)
  const answer = await pending
  assert.deepEqual([answer.success, answer.models, 'stopped' in answer], [true, { voice: 'processor', timing: 'processor' }, false])
  // From then on the card is not asked, and a second silent death is simply reported.
  const next = engine.analyze({ inputPath: song }, { isDestroyed: () => false, send: () => {} })
  assert.equal(JSON.parse(spawned[2].args[1]).useCard, false)
  spawned[2].child.emit('close', 1)
  const failed = await next
  assert.deepEqual([failed.success, failed.code, 'stopped' in failed, spawned.length], [false, 'SONG_MAP_FAILED', false, 3])
})

test('a step that had to leave the card is reported, and the card is left alone afterwards', async () => {
  const { engine, spawned, song } = setup()
  const pending = engine.analyze({ inputPath: song }, { isDestroyed: () => false, send: () => {} })
  spawned[0].child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', speech: { used: 'processor' }, models: { voice: { on: 'processor', problem: 'failed' }, timing: { on: 'card' } }, duration: 5, rows: [], voice: [], seconds: {} }) + '\n'))
  spawned[0].child.emit('close', 0)
  assert.deepEqual((await pending).models, { voice: 'processor', timing: 'card' })
  engine.analyze({ inputPath: song }, { isDestroyed: () => false, send: () => {} })
  assert.equal(JSON.parse(spawned[1].args[1]).useCard, false)
  spawned[1].child.emit('close', 0)
})
