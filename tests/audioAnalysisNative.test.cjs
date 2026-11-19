const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const {
  AUDIO_ANALYSIS_LIMITS, resolveAudioAnalysisSource, resolveAudioAnalysisSources, normalizeAudioAnalysisOptions,
  createAnalysisProcessState, runBoundedProcess, buildAudioProbeArgs, buildAudioDecodeArgs,
} = require('../electron/audioAnalysisCore.cjs')
const { createAudioAnalysisService, registerAudioAnalysisHandlers } = require('../electron/audioAnalysisNative.cjs')

const source = { absolutePath: path.resolve('synthetic.wav') }

test('source resolution accepts local POSIX/Windows paths and encoded portable media URLs', () => {
  assert.equal(resolveAudioAnalysisSource({ path: 'media/a b.wav', projectPath: '/project' }, { platform: 'linux' }), '/project/media/a b.wav')
  // Node's fileURLToPath uses the host OS even when the path resolver's test
  // platform is injected. Exercise this URL branch using a real host path.
  const hostFilePath = path.resolve('project', 'a b.wav')
  assert.equal(resolveAudioAnalysisSource({ url: pathToFileURL(hostFilePath).href }), hostFilePath)
  assert.equal(resolveAudioAnalysisSource({ url: 'comfystudio://%2Fproject%2Fa%20b.wav' }, { platform: 'linux' }), '/project/a b.wav')
  assert.equal(resolveAudioAnalysisSource({ absolutePath: 'C:\\Media\\A.wav' }, { platform: 'win32' }), 'C:\\Media\\A.wav')
  assert.equal(resolveAudioAnalysisSource({ url: 'file:///C:/Media/A%20B.wav' }, { platform: 'win32' }), 'C:\\Media\\A B.wav')
  assert.equal(resolveAudioAnalysisSource({ path: 'media\\a.wav', projectPath: 'D:\\Project' }, { platform: 'win32' }), 'D:\\Project\\media\\a.wav')
  assert.equal(resolveAudioAnalysisSource({ absolutePath: '\\\\studio\\share\\Audio.wav' }, { platform: 'win32' }), '\\\\studio\\share\\Audio.wav')
  assert.equal(resolveAudioAnalysisSource({ url: 'file://studio/share/Audio%20take.wav' }, { platform: 'win32' }), '\\\\studio\\share\\Audio take.wav')
  assert.equal(resolveAudioAnalysisSource({ path: 'media/a.wav', projectPath: '\\\\studio\\share\\Project' }, { platform: 'win32' }), '\\\\studio\\share\\Project\\media\\a.wav')
  assert.throws(() => resolveAudioAnalysisSource({ path: '\\root-relative.wav' }, { platform: 'win32' }), { code: 'AUDIO_ANALYSIS_INVALID_SOURCE' })
  assert.deepEqual(resolveAudioAnalysisSources({ path: 'a.wav', projectPath: '/moved', absolutePath: '/old/a.wav', url: 'file:///old/a.wav' }, { platform: 'linux' }), ['/moved/a.wav', '/old/a.wav'])
  assert.deepEqual(resolveAudioAnalysisSources({ path: 'assets\\music.wav', projectPath: '/new/project', absolutePath: 'C:\\old\\project\\assets\\music.wav' }, { platform: 'linux' }), ['/new/project/assets/music.wav'])
  assert.equal(resolveAudioAnalysisSource({ absolutePath: '/project/literal\\name.wav' }, { platform: 'linux' }), '/project/literal\\name.wav')
})

test('remote schemes, malformed URLs, NULs, non-Windows UNC and unanchored paths are rejected before spawning', async () => {
  for (const input of ['https://host/a.wav', 'http://host/a.wav', 'blob:abc', 'data:audio/wav;base64,a', 'pipe:0', 'concat:a|b', 'file://host/a.wav', '\\\\host\\share.wav', '//host/share.wav', 'comfystudio://%zz', 'a\0.wav', 'relative.wav']) {
    assert.throws(() => resolveAudioAnalysisSource({ url: input }, { platform: 'linux' }), { code: 'AUDIO_ANALYSIS_INVALID_SOURCE' }, input)
  }
  const f = workerFixture()
  assert.equal((await f.service.analyze({ source: { url: 'https://example.invalid/audio' } })).success, false)
  assert.equal(f.workers.length, 0)
})

test('options enforce finite positive ranges, duration/summary bounds and safe defaults', () => {
  assert.deepEqual(normalizeAudioAnalysisOptions(), {
    startSeconds: 0, endSeconds: undefined, includeLoudnessCurve: true, maxCurvePoints: 400, silenceThresholdDb: -45, minSilenceSeconds: 0.35,
  })
  for (const options of [{ startSeconds: -1 }, { startSeconds: Infinity }, { endSeconds: NaN }, { startSeconds: 3, endSeconds: 3 }, { maxCurvePoints: 1001 }, { silenceThresholdDb: 1 }, { minSilenceSeconds: -1 }]) {
    assert.throws(() => normalizeAudioAnalysisOptions(options), { code: 'AUDIO_ANALYSIS_INVALID_OPTIONS' })
  }
  assert.throws(() => normalizeAudioAnalysisOptions({ endSeconds: 600.001 }), { code: 'AUDIO_ANALYSIS_TOO_LONG' })
  assert.equal(normalizeAudioAnalysisOptions({ startSeconds: 5000, endSeconds: 5600 }).endSeconds, 5600)
})

test('direct IPC rejects coercible but malformed option types without starting any native worker', async () => {
  const f = workerFixture(), app = new EventEmitter(), handlers = new Map()
  registerAudioAnalysisHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, app, WorkerClass: f.FakeWorker })
  const call = (options) => handlers.get('media:analyzeAudio')({ sender: owner() }, { source, options })
  for (const field of ['startSeconds', 'endSeconds', 'maxCurvePoints', 'silenceThresholdDb', 'minSilenceSeconds']) {
    for (const value of [null, false, true, '0', '400', [], {}]) {
      assert.equal((await call({ [field]: value })).code, 'AUDIO_ANALYSIS_INVALID_OPTIONS', `${field}: ${JSON.stringify(value)}`)
    }
  }
  for (const value of [null, 0, 1, 'false', {}, []]) assert.equal((await call({ includeLoudnessCurve: value })).code, 'AUDIO_ANALYSIS_INVALID_OPTIONS')
  assert.equal(f.workers.length, 0)
})

test('native argument builders explicitly disable network protocols, seek before decode and preserve first channels', () => {
  const input = '/project/a;not-a-shell-command.wav'
  const probe = buildAudioProbeArgs(input)
  assert.equal(probe[probe.indexOf('-protocol_whitelist') + 1], 'file,pipe')
  assert.equal(probe.at(-1), input)
  const decode = buildAudioDecodeArgs(input, { startSeconds: 18, durationSeconds: 8, channels: 2 })
  assert.ok(decode.indexOf('-ss') < decode.indexOf('-i'))
  assert.equal(decode[decode.indexOf('-t') + 1], '8')
  assert.equal(decode[decode.indexOf('-af') + 1], 'pan=stereo|c0=c0|c1=c1')
  assert.equal(decode[decode.indexOf('-ar') + 1], '24000')
  assert.equal(decode[decode.indexOf('-protocol_whitelist') + 1], 'file,pipe')
  assert.equal(decode[decode.indexOf('-i') + 1], input)
  assert.equal(buildAudioDecodeArgs(input, { startSeconds: 0, durationSeconds: 1, channels: 1 }).includes('pan=mono|c0=c0'), true)
})

function workerFixture(overrides = {}) {
  const workers = [], killed = []
  class FakeWorker extends EventEmitter {
    constructor(workerPath, options) { super(); this.options = options; this.workerPath = workerPath; this.messages = []; this.terminated = 0; workers.push(this) }
    postMessage(message) { this.messages.push(message); if (message.type === 'cancel') queueMicrotask(() => this.emit('message', { type: 'result', result: { success: false, error: 'cancelled', code: 'AUDIO_ANALYSIS_CANCELLED' } })) }
    terminate() { this.terminated += 1; return Promise.resolve(0) }
    result(result = { success: true, analysis: { duration: 12, beats: [0.5] } }) { this.emit('message', { type: 'result', result }) }
  }
  const service = createAudioAnalysisService({ ffmpegPath: '/ffmpeg', ffprobePath: '/ffprobe', WorkerClass: FakeWorker, killProcess: (pid) => killed.push(pid), ...overrides })
  return { workers, killed, service, FakeWorker }
}

function owner(id = 7) { const result = new EventEmitter(); result.id = id; result.isDestroyed = () => false; return result }

test('one global job rejects double requests immediately and frees the slot only after teardown', async () => {
  const f = workerFixture(), sender = owner()
  const pending = f.service.analyze({ source, options: { startSeconds: 3, endSeconds: 15 } }, sender)
  assert.equal((await f.service.analyze({ source }, owner(9))).code, 'AUDIO_ANALYSIS_BUSY')
  assert.equal(f.workers.length, 1)
  assert.deepEqual(f.workers[0].options.workerData.inputPaths, [source.absolutePath])
  assert.equal(f.workers[0].options.workerData.options.startSeconds, 3)
  f.workers[0].result()
  assert.equal((await pending).success, true)
  assert.equal(f.workers[0].terminated, 1)
  assert.equal(sender.listenerCount('destroyed'), 0)
  assert.equal(sender.listenerCount('render-process-gone'), 0)
  const next = f.service.analyze({ source }, sender)
  f.workers[1].result()
  assert.equal((await next).success, true)
})

test('owner destruction/crash and explicit cancellation kill tracked children and ignore late success', async () => {
  for (const event of ['destroyed', 'render-process-gone', 'explicit']) {
    const f = workerFixture(), sender = owner()
    const pending = f.service.analyze({ source }, sender)
    f.workers[0].emit('message', { type: 'child-start', pid: 8765 })
    f.service.cancelOwner(99)
    assert.equal(f.killed.length, 0)
    if (event === 'explicit') f.service.cancelOwner(sender.id)
    else sender.emit(event)
    f.workers[0].result()
    assert.equal((await pending).code, 'AUDIO_ANALYSIS_CANCELLED')
    assert.ok(f.killed.includes(8765))
    assert.equal(sender.listenerCount('destroyed'), 0)
    const next = f.service.analyze({ source }, sender)
    f.workers[1].result()
    assert.equal((await next).success, true)
  }
})

test('job timeout, worker crash/start error all recover without leaving the busy slot', async () => {
  const f = workerFixture({ jobTimeoutMs: 5 })
  assert.equal((await f.service.analyze({ source })).code, 'AUDIO_ANALYSIS_TIMEOUT')
  const crash = f.service.analyze({ source })
  f.workers[1].emit('error', new Error('synthetic crash'))
  assert.equal((await crash).code, 'AUDIO_ANALYSIS_WORKER_FAILED')
  const unexpected = f.service.analyze({ source })
  f.workers[2].emit('exit', 9)
  assert.equal((await unexpected).code, 'AUDIO_ANALYSIS_WORKER_FAILED')
  const broken = createAudioAnalysisService({ WorkerClass: class { constructor() { throw new Error('synthetic startup failure') } } })
  assert.equal((await broken.analyze({ source })).code, 'AUDIO_ANALYSIS_WORKER_FAILED')
  assert.equal((await broken.analyze({ source })).code, 'AUDIO_ANALYSIS_WORKER_FAILED')
})

test('IPC takes owner only from Electron, cancels on quit and preload exposes narrow request/summary call', async () => {
  const f = workerFixture(), app = new EventEmitter(), handlers = new Map(), sender = owner()
  registerAudioAnalysisHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, app, WorkerClass: f.FakeWorker })
  const pending = handlers.get('media:analyzeAudio')({ sender }, { source, ownerId: 999 })
  app.emit('will-quit')
  assert.equal((await pending).code, 'AUDIO_ANALYSIS_CANCELLED')
  const calls = [], exposed = {}, renderer = new EventEmitter()
  renderer.invoke = (...args) => { calls.push(args); return Promise.resolve({ success: true, analysis: { duration: 1 } }) }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.js'), 'utf8'), {
    process: { platform: 'linux' }, require: (name) => {
      assert.equal(name, 'electron')
      return { ipcRenderer: renderer, contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api } } }
    },
  })
  assert.equal((await exposed.electronAPI.analyzeAudio({ source })).analysis.duration, 1)
  assert.equal(calls[0][0], 'media:analyzeAudio')
  assert.deepEqual(calls[0][1], { source })
})

function processFixture() {
  const child = new EventEmitter()
  child.pid = 5432
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kills = []
  child.kill = (signal) => { child.kills.push(signal); queueMicrotask(() => child.emit('close', null)); return true }
  const events = [], state = createAnalysisProcessState((...args) => events.push(args))
  return { child, events, state, spawnProcess: (_binary, _args, options) => { assert.equal(options.shell, false); return child } }
}

test('native subprocess output cap, timeout and cancellation kill the child and clear tracking', async () => {
  for (const mode of ['output', 'timeout', 'cancel']) {
    const f = processFixture()
    const pending = runBoundedProcess('/test', [], { ...f, timeoutMs: mode === 'timeout' ? 5 : 1000, maxBytes: 4, onData() {} })
    if (mode === 'output') f.child.stdout.write(Buffer.alloc(5))
    if (mode === 'cancel') f.state.cancel()
    await assert.rejects(pending, { code: mode === 'output' ? 'AUDIO_ANALYSIS_OUTPUT_LIMIT' : mode === 'timeout' ? 'AUDIO_ANALYSIS_TIMEOUT' : 'AUDIO_ANALYSIS_CANCELLED' })
    assert.deepEqual(f.child.kills, ['SIGKILL'])
    assert.equal(f.state.activeProcess, null)
    assert.deepEqual(f.events, [['start', 5432], ['end', 5432]])
  }
})

test('noisy native errors retain bounded stderr only', async () => {
  const f = processFixture()
  const pending = runBoundedProcess('/test', [], { ...f, timeoutMs: 1000, maxBytes: 4, onData() {} })
  f.child.stderr.write(Buffer.alloc(1024 * 1024, 97))
  f.child.stderr.write(Buffer.from('tail'))
  f.child.emit('close', 1)
  await assert.rejects(pending, (error) => error.message.endsWith('tail') && error.message.length < AUDIO_ANALYSIS_LIMITS.maxStderrBytes + 100)
})

function resolveBinary(name, environment) {
  if (process.env[environment]) return process.env[environment]
  try { const binary = require(name); return typeof binary === 'string' ? binary : binary?.path } catch { return null }
}
const ffmpegPath = resolveBinary('ffmpeg-static', 'VELORN_TEST_FFMPEG_PATH')
const ffprobePath = resolveBinary('@derhuerst/ffprobe-static', 'VELORN_TEST_FFPROBE_PATH')
const nativeAvailable = Boolean(ffmpegPath && ffprobePath && fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath))

function synthesizeWav(seconds = 12, channels = 1, sampleRate = 24000, amplitude = 0.6) {
  const frames = Math.round(seconds * sampleRate)
  const wav = Buffer.alloc(44 + frames * channels * 2)
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22)
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * channels * 2, 28)
  wav.writeUInt16LE(channels * 2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
  for (let frame = 0; frame < frames; frame++) {
    const t = frame / sampleRate, phase = t % 0.5
    const click = phase < 0.08 ? amplitude * Math.exp(-phase * 55) * Math.sin(2 * Math.PI * 100 * t) : 0
    for (let channel = 0; channel < channels; channel++) wav.writeInt16LE(Math.round((channel < 2 ? click : Math.sin(t * 8000) * 0.9) * 32767), 44 + (frame * channels + channel) * 2)
  }
  return wav
}

test('real native worker analyzes 120 BPM synthetic audio and trimmed video/audio ranges; no source bytes in result', { skip: !nativeAvailable, timeout: 30000 }, async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'velorn-audio-analysis-test-'))
  const service = createAudioAnalysisService({ ffmpegPath, ffprobePath })
  try {
    const file = path.join(temp, 'synthetic.wav')
    await fsp.writeFile(file, synthesizeWav())
    const result = await service.analyze({ source: { absolutePath: file } })
    assert.equal(result.success, true, result.error)
    assert.equal(result.analysis.duration, 12)
    assert.equal(result.analysis.channels, 1)
    assert.equal(result.analysis.sampleRate, 24000)
    assert.ok(Math.abs(result.analysis.bpm - 120) < 1, String(result.analysis.bpm))
    assert.ok(result.analysis.beats.length > 20)
    assert.ok(JSON.stringify(result).length < 50000)
    const partial = await service.analyze({ source: { path: 'synthetic.wav', projectPath: temp, absolutePath: path.join(temp, 'obsolete.wav') }, options: { startSeconds: 3, endSeconds: 9, includeLoudnessCurve: false } })
    assert.equal(partial.success, true, partial.error)
    assert.equal(partial.analysis.duration, 6)
    assert.equal(partial.analysis.loudnessCurve, undefined)
    assert.ok(partial.analysis.beats.every((beat) => beat >= 0 && beat <= 6))
    const legacy = await service.analyze({ source: { path: 'missing.wav', projectPath: temp, url: pathToFileURL(file).href }, options: { endSeconds: 1 } })
    assert.equal(legacy.success, true, legacy.error)
    const video = path.join(temp, 'synthetic-video.mp4')
    const mux = spawnSync(ffmpegPath, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=5:d=12',
      '-i', file, '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', video], { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true })
    assert.equal(mux.status, 0, mux.stderr?.toString())
    const videoResult = await service.analyze({ source: { absolutePath: video }, options: { startSeconds: 3.123, endSeconds: 9.123 } })
    assert.equal(videoResult.success, true, videoResult.error)
    assert.equal(videoResult.analysis.duration, 6)
    assert.ok(Math.abs(videoResult.analysis.bpm - 120) < 1, String(videoResult.analysis.bpm))
    assert.ok(videoResult.analysis.beats.every((beat) => beat >= 0 && beat <= 6))
    const mp3 = path.join(temp, 'synthetic.mp3')
    const compressed = spawnSync(ffmpegPath, ['-v', 'error', '-nostdin', '-i', file, '-c:a', 'libmp3lame', '-b:a', '96k', mp3],
      { timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true })
    assert.equal(compressed.status, 0, compressed.stderr?.toString())
    const mp3Result = await service.analyze({ source: { absolutePath: mp3 }, options: { startSeconds: 3.123, endSeconds: 9.123 } })
    assert.equal(mp3Result.success, true, mp3Result.error)
    assert.equal(mp3Result.analysis.duration, 6)
    assert.ok(Math.abs(mp3Result.analysis.bpm - 120) < 1, String(mp3Result.analysis.bpm))
    assert.ok(mp3Result.analysis.beats.length >= 10)
    assert.ok(mp3Result.analysis.beats.every((beat) => beat >= 0 && beat <= 6))
  } finally { service.cancelAll(); await fsp.rm(temp, { recursive: true, force: true }) }
})

test('real mono/stereo/multichannel loudness preserves original first channels without mono upmix', { skip: !nativeAvailable, timeout: 30000 }, async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'velorn-audio-channels-test-'))
  const service = createAudioAnalysisService({ ffmpegPath, ffprobePath })
  try {
    const results = []
    for (const channels of [1, 2, 6]) {
      const file = path.join(temp, `channels-${channels}.wav`)
      await fsp.writeFile(file, synthesizeWav(2, channels))
      const result = await service.analyze({ source: { absolutePath: file } })
      assert.equal(result.success, true, result.error)
      assert.equal(result.analysis.channels, channels)
      results.push(result.analysis)
    }
    assert.ok(Math.abs(results[1].loudness.integratedLufsApprox - results[0].loudness.integratedLufsApprox - 3) < 0.15)
    assert.deepEqual(results[2].loudness, results[1].loudness)
  } finally { service.cancelAll(); await fsp.rm(temp, { recursive: true, force: true }) }
})

test('real native errors (missing, corrupt, no audio, too short/long, missing binary) are recoverable', { skip: !nativeAvailable, timeout: 30000 }, async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'velorn-audio-errors-test-'))
  const service = createAudioAnalysisService({ ffmpegPath, ffprobePath })
  try {
    const file = path.join(temp, 'valid.wav')
    await fsp.writeFile(file, synthesizeWav(1))
    assert.equal((await service.analyze({ source: { absolutePath: path.join(temp, 'missing.wav') } })).code, 'AUDIO_ANALYSIS_SOURCE_MISSING')
    assert.equal((await service.analyze({ source: { absolutePath: file }, options: { endSeconds: 0.1 } })).code, 'AUDIO_ANALYSIS_TOO_SHORT')
    const corrupt = path.join(temp, 'corrupt.wav')
    await fsp.writeFile(corrupt, 'not media')
    assert.equal((await service.analyze({ source: { absolutePath: corrupt } })).code, 'AUDIO_ANALYSIS_DECODE_FAILED')
    const image = path.join(temp, 'no-audio.ppm')
    await fsp.writeFile(image, Buffer.concat([Buffer.from('P6\n1 1\n255\n'), Buffer.from([255, 0, 0])]))
    assert.equal((await service.analyze({ source: { absolutePath: image } })).code, 'AUDIO_ANALYSIS_NO_AUDIO')
    const long = path.join(temp, 'long.wav'), header = synthesizeWav(0, 1, 8000)
    const bytes = 601 * 8000 * 2
    header.writeUInt32LE(bytes + 36, 4); header.writeUInt32LE(bytes, 40)
    await fsp.writeFile(long, header)
    await fsp.truncate(long, bytes + 44)
    assert.equal((await service.analyze({ source: { absolutePath: long } })).code, 'AUDIO_ANALYSIS_TOO_LONG')
    assert.equal((await service.analyze({ source: { absolutePath: long }, options: { startSeconds: 599, endSeconds: 601 } })).success, true)
    const broken = createAudioAnalysisService({ ffmpegPath: path.join(temp, 'missing-ffmpeg'), ffprobePath })
    assert.equal((await broken.analyze({ source: { absolutePath: file } })).code, 'AUDIO_ANALYSIS_NATIVE_UNAVAILABLE')
    assert.equal((await service.analyze({ source: { absolutePath: file } })).success, true)
  } finally { service.cancelAll(); await fsp.rm(temp, { recursive: true, force: true }) }
})
