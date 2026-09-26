const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const {
  createMediaPreparationService, buildMediaPreparationArgs, validatePreparedMedia, proxyHeight,
} = require('../electron/mediaPreparation')

const inputProbe = {
  success: true, hasVideo: true, hasAudio: true, hasAlpha: false,
  fps: 29.97, duration: 10, width: 1920, height: 1080,
  videoCodec: 'h264', pixelFormat: 'yuv420p',
}

async function until(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise(setImmediate)
  }
  assert.fail('Expected asynchronous queue state was not reached.')
}

function fixture(options = {}) {
  const calls = []
  const probes = []
  const deleted = []
  const renamed = []
  const states = []
  const files = new Map()
  const fileIdentities = new Map()
  let running = 0
  let peak = 0
  const fs = {
    mkdir: async () => {},
    realpath: options.realpath || (async (file) => file),
    stat: options.stat || (async (file) => {
      if (!fileIdentities.has(file)) fileIdentities.set(file, BigInt(fileIdentities.size + 1))
      return { dev: 1n, ino: fileIdentities.get(file) }
    }),
    unlink: async (file) => { deleted.push(file); files.delete(file) },
    rename: async (source, destination) => {
      if (options.renameError) throw new Error(options.renameError)
      assert.ok(files.has(source), 'Temporary file exists before atomic publication')
      renamed.push([source, destination]); files.set(destination, files.get(source)); files.delete(source)
    },
  }
  const spawn = (binary, args) => {
    if (options.throwHardware && binary === '/hardware/ffmpeg') throw new Error('Cannot start hardware FFmpeg')
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kills = []
    const output = args.at(-1)
    let closed = false
    running += 1
    peak = Math.max(peak, running)
    files.set(output, 'encoded')
    const call = { binary, args, child, output, finish(code = 0, error = '') {
      if (closed) return
      closed = true
      running -= 1
      if (error) child.stderr.emit('data', Buffer.from(error))
      child.emit('close', code)
    } }
    child.kill = (signal) => {
      child.kills.push(signal)
      if (!options.manualKill) queueMicrotask(() => call.finish(null))
      return true
    }
    calls.push(call)
    if (!options.manual) queueMicrotask(() => options.onSpawn ? options.onSpawn(call) : call.finish())
    return child
  }
  const service = createMediaPreparationService({
    ffmpegPath: '/bundled/ffmpeg', platform: 'linux', fs, spawn,
    resolveHardwareFfmpeg: async () => ({ path: '/hardware/ffmpeg' }),
    probeHardwareEncoder: async (encoder, binary) => {
      probes.push([encoder, binary]); return options.hardware === false ? { ok: false, error: 'No supported driver' } : { ok: true }
    },
    probeVideoInfo: async (file) => {
      if (!file.endsWith('.tmp.mp4')) return { ...inputProbe, ...options.input }
      const call = calls.find((entry) => entry.output === file)
      const filters = call.args[call.args.indexOf('-vf') + 1]
      const height = Number(filters.match(/scale=-2:(\d+)/)?.[1]) || 1080
      const outputProbe = { ...inputProbe, height, width: Math.round(height * 1920 / 1080) }
      return options.outputProbe ? options.outputProbe(call, outputProbe) : outputProbe
    },
    onStatus: (snapshot) => states.push(snapshot),
    ...options.service,
  })
  return { service, calls, probes, deleted, renamed, states, files, peak: () => peak, running: () => running }
}

const request = (name, extra = {}) => ({ kind: 'playback', inputPath: `/source/${name}.mov`, outputPath: `/cache/${name}.mp4`, ownerId: 1, ...extra })
const value = (args, key) => args[args.indexOf(key) + 1]

for (const encoder of ['libx264', 'h264_nvenc', 'h264_videotoolbox']) {
  for (const kind of ['playback', 'proxy']) {
    test(`${encoder} ${kind} arguments preserve the preview encoding contract`, () => {
      const args = buildMediaPreparationArgs({ encoder, kind, inputPath: '/original.mov', tempOutputPath: '/cache.tmp.mp4', fps: 29.97, targetHeight: 541, threads: 2 })
      assert.equal(value(args, '-c:v'), encoder)
      assert.equal(value(args, '-g'), '6')
      assert.equal(value(args, '-bf'), '0')
      assert.equal(value(args, '-pix_fmt'), 'yuv420p')
      assert.equal(value(args, '-c:a'), 'aac')
      assert.equal(value(args, '-b:a'), kind === 'proxy' ? '128k' : '192k')
      assert.equal(value(args, '-ar'), '48000')
      assert.equal(value(args, '-ac'), '2')
      assert.equal(value(args, '-vf'), kind === 'proxy' ? 'scale=-2:542,fps=29.97' : 'fps=29.97')
      assert.equal(args.filter((arg) => arg === '-threads').length, 2)
      assert.equal(value(args, '-filter_threads'), '1')
      assert.equal(value(args, '-progress'), 'pipe:1')
      assert.equal(args.at(-1), '/cache.tmp.mp4')
      assert.ok(args.includes('0:a:0?'))
      if (encoder === 'libx264') {
        assert.equal(value(args, '-crf'), kind === 'proxy' ? '28' : '23')
        assert.equal(value(args, '-preset'), kind === 'proxy' ? 'veryfast' : 'fast')
      } else if (encoder === 'h264_nvenc') {
        assert.equal(value(args, '-preset'), 'p2')
        assert.equal(value(args, '-cq'), kind === 'proxy' ? '28' : '23')
      } else assert.equal(value(args, '-allow_sw'), '0')
    })
  }
}

test('proxy sizes are finite, clamped and even', () => {
  assert.equal(proxyHeight(undefined), 540)
  assert.equal(proxyHeight(Infinity), 540)
  assert.equal(proxyHeight(179), 180)
  assert.equal(proxyHeight(9999), 1080)
  assert.equal(proxyHeight(181.5), 182)
})

test('one shared queue bounds concurrency across both preparation tiers and deduplicates output', async () => {
  const harness = fixture({ manual: true })
  const { service, calls } = harness
  const first = service.enqueue(request('one'))
  assert.equal(service.enqueue(request('one')), first)
  const second = service.enqueue(request('two', { kind: 'proxy' }))
  const third = service.enqueue(request('three'))
  await until(() => calls.length === 1)
  assert.equal(service.getStatus(1).activeCount, 1)
  assert.equal(service.getStatus(1).queuedCount, 2)
  assert.equal(service.getStatus(1).total, 3)
  calls[0].finish()
  await until(() => calls.length === 2)
  calls[1].finish()
  await until(() => calls.length === 3)
  calls[2].finish()
  const results = await Promise.all([first, second, third])
  assert.ok(results.every((result) => result.success && result.hardware))
  assert.equal(harness.peak(), 1)
  assert.equal(service.getStatus(1).completed, 3)
  assert.equal(harness.renamed.length, 3)
  assert.ok(calls.every((call) => call.output.endsWith('.tmp.mp4')))
})

test('shared output has independent owners and cancelling one never kills the other', async () => {
  const { service, calls } = fixture({ manual: true })
  const first = service.enqueue(request('shared'))
  const second = service.enqueue(request('shared', { ownerId: 2 }))
  await until(() => calls.length === 1)
  assert.equal(service.getStatus(1).jobs.length, 1)
  assert.equal(service.getStatus(2).jobs.length, 1)
  assert.equal(service.cancelOwner(1).cancelledCount, 1)
  assert.equal((await first).cancelled, true)
  assert.equal(calls[0].child.kills.length, 0)
  calls[0].finish()
  assert.equal((await second).success, true)
  assert.equal(service.getStatus(1).cancelledCount, 1)
  assert.equal(service.getStatus(2).completed, 1)
})

test('unavailable hardware uses only bundled CPU with an observable reason', async () => {
  const { service, calls, probes } = fixture({ hardware: false })
  const result = await service.enqueue(request('cpu'))
  assert.equal(result.success, true)
  assert.equal(result.encoder, 'libx264')
  assert.equal(result.hardware, false)
  assert.match(result.fallbackReason, /No supported driver/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].binary, '/bundled/ffmpeg')
  assert.deepEqual(probes, [['h264_nvenc', '/hardware/ffmpeg']])
})

test('macOS chooses VideoToolbox while Windows chooses NVENC', async () => {
  for (const platform of ['darwin', 'win32']) {
    const { service, probes } = fixture({ service: { platform } })
    const result = await service.enqueue(request(platform))
    assert.equal(result.encoder, platform === 'darwin' ? 'h264_videotoolbox' : 'h264_nvenc')
    assert.equal(probes[0][0], result.encoder)
  }
})

test('hardware failure removes its partial output before retrying CPU', async () => {
  const harness = fixture({ onSpawn: (call) => call.binary === '/hardware/ffmpeg' ? call.finish(1, 'GPU busy') : call.finish() })
  harness.files.set('/cache/fallback.mp4', 'previous-cache')
  const result = await harness.service.enqueue(request('fallback'))
  assert.equal(result.success, true)
  assert.equal(result.encoder, 'libx264')
  assert.match(result.fallbackReason, /GPU busy/)
  assert.equal(harness.calls.length, 2)
  assert.notEqual(harness.calls[0].output, harness.calls[1].output)
  assert.ok(harness.deleted.includes(harness.calls[0].output))
  assert.equal(harness.renamed.length, 1)
  assert.equal(harness.files.get('/cache/fallback.mp4'), 'encoded')
})

test('spawn exceptions and capability exceptions both fall back to CPU', async () => {
  const thrownSpawn = fixture({ throwHardware: true })
  assert.equal((await thrownSpawn.service.enqueue(request('spawn'))).success, true)
  assert.equal(thrownSpawn.calls[0].binary, '/bundled/ffmpeg')
  const thrownProbe = fixture({ service: { probeHardwareEncoder: async () => { throw new Error('probe unavailable') } } })
  const result = await thrownProbe.service.enqueue(request('probe'))
  assert.equal(result.success, true)
  assert.match(result.fallbackReason, /probe unavailable/)
})

test('invalid hardware media is never published and falls back to validated CPU output', async () => {
  const harness = fixture({ outputProbe: (call, probe) => call.binary === '/hardware/ffmpeg' ? { ...probe, hasVideo: false } : probe })
  const result = await harness.service.enqueue(request('invalid-hardware', { kind: 'proxy' }))
  assert.equal(result.success, true)
  assert.equal(result.hardware, false)
  assert.match(result.fallbackReason, /validation failed/)
  assert.equal(harness.renamed.length, 1)
  assert.equal(harness.renamed[0][0], harness.calls[1].output)
  assert.ok(harness.deleted.includes(harness.calls[0].output))
})

test('a thrown hardware validation probe is cleaned and retried on CPU', async () => {
  const harness = fixture({ outputProbe: (call, probe) => {
    if (call.binary === '/hardware/ffmpeg') throw new Error('Hardware output probe failed')
    return probe
  } })
  const result = await harness.service.enqueue(request('thrown-validation'))
  assert.equal(result.success, true)
  assert.equal(result.encoder, 'libx264')
  assert.match(result.fallbackReason, /Hardware output probe failed/)
  assert.ok(harness.deleted.includes(harness.calls[0].output))
  assert.equal(harness.renamed[0][0], harness.calls[1].output)
})

test('validation failure in both attempts preserves a previous cache and cleans partial files', async () => {
  const harness = fixture({ outputProbe: (_call, probe) => ({ ...probe, duration: 1 }) })
  harness.files.set('/cache/invalid.mp4', 'previous-cache')
  const result = await harness.service.enqueue(request('invalid'))
  assert.equal(result.success, false)
  assert.match(result.error, /ended early/)
  assert.equal(harness.renamed.length, 0)
  assert.equal(harness.files.get('/cache/invalid.mp4'), 'previous-cache')
  assert.ok(harness.calls.every((call) => !harness.files.has(call.output)))
  assert.equal(harness.service.getStatus(1).failed, 1)
})

test('rename failure cleans validated temporary output without a pointless CPU retry', async () => {
  const harness = fixture({ renameError: 'Output is read-only' })
  const result = await harness.service.enqueue(request('rename'))
  assert.equal(result.success, false)
  assert.match(result.error, /read-only/)
  assert.equal(harness.calls.length, 1)
  assert.ok(!harness.files.has(harness.calls[0].output))
})

test('alpha and invalid inputs fail without spawning or changing source media', async () => {
  for (const input of [{ hasAlpha: true }, { hasVideo: false }, { success: false, error: 'Unreadable input' }]) {
    const harness = fixture({ input })
    const result = await harness.service.enqueue(request('source'))
    assert.equal(result.success, false)
    assert.equal(harness.calls.length, 0)
    assert.equal(harness.deleted.length, 0)
  }
  const harness = fixture()
  const result = await harness.service.enqueue(request('source', { outputPath: '/source/source.mov' }))
  assert.match(result.error, /must not overwrite/)
  assert.equal(harness.calls.length, 0)
})

test('directory aliases cannot overwrite source media and relative paths are rejected', async () => {
  const harness = fixture({ realpath: async (file) => file === '/cache-alias' ? '/source' : file })
  const aliased = await harness.service.enqueue(request('alias', { outputPath: '/cache-alias/alias.mov' }))
  assert.match(aliased.error, /must not overwrite.*directory alias/)
  assert.equal(harness.calls.length, 0)
  assert.equal(harness.renamed.length, 0)
  const relative = await harness.service.enqueue(request('relative', { inputPath: 'relative.mov' }))
  assert.match(relative.error, /absolute/)
})

test('case-only output aliases cannot overwrite a source on case-insensitive macOS volumes', async () => {
  const statCalls = []
  const harness = fixture({
    service: { platform: 'darwin' },
    stat: async (file, options) => {
      statCalls.push({ file, options })
      return { dev: 7n, ino: 9007199254740993n }
    },
  })
  const result = await harness.service.enqueue(request('Clip', {
    inputPath: '/source/Clip.mp4', outputPath: '/source/clip.mp4',
  }))
  assert.equal(result.success, false)
  assert.match(result.error, /must not overwrite.*file alias/)
  assert.deepEqual(statCalls, [
    { file: '/source/Clip.mp4', options: { bigint: true } },
    { file: '/source/clip.mp4', options: { bigint: true } },
  ])
  assert.equal(harness.calls.length, 0)
  assert.equal(harness.renamed.length, 0)
  assert.equal(harness.deleted.length, 0)
})

test('case-sensitive macOS volumes permit distinct case-only paths with different native identities', async () => {
  const harness = fixture({
    service: { platform: 'darwin' },
    stat: async (file) => ({ dev: 7n, ino: file === '/source/Clip.mp4' ? 9007199254740992n : 9007199254740993n }),
  })
  const result = await harness.service.enqueue(request('Clip', {
    inputPath: '/source/Clip.mp4', outputPath: '/source/clip.mp4',
  }))
  assert.equal(result.success, true, result.error)
  assert.equal(harness.calls.length, 1)
  assert.equal(harness.renamed.length, 1)
})

test('new cache paths remain valid, while unexpected identity-check errors fail safely', async () => {
  for (const code of ['ENOENT', 'EACCES']) {
    const harness = fixture({ stat: async (file) => {
      if (file === '/cache/new.mp4') throw Object.assign(new Error(`Output stat failed: ${code}`), { code })
      return { dev: 7n, ino: 42n }
    } })
    const result = await harness.service.enqueue(request('new'))
    assert.equal(result.success, code === 'ENOENT', result.error)
    assert.equal(harness.calls.length, code === 'ENOENT' ? 1 : 0)
    assert.equal(harness.renamed.length, code === 'ENOENT' ? 1 : 0)
    if (code === 'EACCES') assert.match(result.error, /EACCES/)
  }
})

test('progress handles split FFmpeg records and stays below complete until publication', async () => {
  const { service, calls } = fixture({ manual: true })
  const result = service.enqueue(request('progress'))
  await until(() => calls.length === 1)
  calls[0].child.stdout.emit('data', Buffer.from('out_time_us=500'))
  calls[0].child.stdout.emit('data', Buffer.from('0000\nprogress=continue\n'))
  assert.equal(service.getStatus(1).jobs[0].progress, 0.5)
  calls[0].child.stdout.emit('data', Buffer.from('out_time_ms=20000000\nprogress=end\n'))
  assert.equal(service.getStatus(1).jobs[0].progress, 0.99)
  calls[0].finish()
  await result
  assert.equal(service.getStatus(1).jobs[0].progress, 1)
})

test('cancelling an owner kills only its active process and drains its queued jobs', async () => {
  const harness = fixture({ manual: true, manualKill: true })
  const first = harness.service.enqueue(request('active'))
  const second = harness.service.enqueue(request('queued'))
  const other = harness.service.enqueue(request('other', { ownerId: 2 }))
  await until(() => harness.calls.length === 1)
  let activeSettled = false
  first.then(() => { activeSettled = true })
  assert.equal(harness.service.cancelOwner(1).cancelledCount, 2)
  assert.equal((await second).cancelled, true)
  assert.equal(activeSettled, false, 'Active promise waits for child termination and cleanup')
  assert.deepEqual(harness.calls[0].child.kills, ['SIGKILL'])
  harness.calls[0].finish(null)
  assert.equal((await first).cancelled, true)
  assert.ok(!harness.files.has(harness.calls[0].output))
  await until(() => harness.calls.length === 2)
  assert.equal(value(harness.calls[1].args, '-i'), '/source/other.mov')
  harness.calls[1].finish()
  assert.equal((await other).success, true)
  assert.equal(harness.peak(), 1)
  assert.equal(harness.service.getStatus(1).cancelledCount, 2)
})

test('cancellation during hardware selection prevents any encode or fallback', async () => {
  let resolveSelection
  let selecting = false
  const harness = fixture({ service: { resolveHardwareFfmpeg: () => {
    selecting = true
    return new Promise((resolve) => { resolveSelection = resolve })
  } } })
  const result = harness.service.enqueue(request('selecting'))
  await until(() => selecting)
  harness.service.cancelOwner(1)
  resolveSelection({ path: '/hardware/ffmpeg' })
  assert.equal((await result).cancelled, true)
  assert.equal(harness.calls.length, 0)
})

test('cancellation while validating never publishes or falls back', async () => {
  let resolveValidation
  const harness = fixture({ outputProbe: () => new Promise((resolve) => { resolveValidation = resolve }) })
  const result = harness.service.enqueue(request('validating'))
  await until(() => resolveValidation)
  harness.service.cancelOwner(1)
  resolveValidation(inputProbe)
  assert.equal((await result).cancelled, true)
  assert.equal(harness.calls.length, 1)
  assert.equal(harness.renamed.length, 0)
  assert.ok(!harness.files.has(harness.calls[0].output))
})

test('terminal history is bounded while batch counters retain all completed work', async () => {
  const harness = fixture({ service: { maxHistory: 3 } })
  await Promise.all(Array.from({ length: 12 }, (_, index) => harness.service.enqueue(request(`batch-${index}`))))
  const status = harness.service.getStatus(1)
  assert.equal(status.total, 12)
  assert.equal(status.completed, 12)
  assert.equal(status.jobs.length, 3)
  assert.equal(status.activeCount, 0)
  assert.equal(status.queuedCount, 0)
  status.jobs[0].label = 'Not authoritative'
  assert.notEqual(harness.service.getStatus(1).jobs[0].label, 'Not authoritative')
  assert.equal('resolve' in status.jobs[0], false)
  await harness.service.enqueue(request('new-batch'))
  assert.equal(harness.service.getStatus(1).total, 1)
  assert.equal(harness.service.getStatus(1).completed, 1)
})

test('different inputs and proxy dimensions cannot collide at one output path', async () => {
  const { service, calls } = fixture({ manual: true })
  const result = service.enqueue(request('collision', { kind: 'proxy', targetHeight: 540 }))
  const inputConflict = await service.enqueue(request('collision', { kind: 'proxy', inputPath: '/another.mov' }))
  const sizeConflict = await service.enqueue(request('collision', { kind: 'proxy', targetHeight: 720 }))
  assert.equal(inputConflict.success, false)
  assert.equal(sizeConflict.success, false)
  await until(() => calls.length === 1)
  calls[0].finish()
  assert.equal((await result).success, true)
})

test('cancelAll settles shared and queued owners without launching new work', async () => {
  const { service, calls } = fixture({ manual: true })
  const requests = [service.enqueue(request('one')), service.enqueue(request('one', { ownerId: 2 })), service.enqueue(request('two', { ownerId: 2 }))]
  await until(() => calls.length === 1)
  assert.equal(service.cancelAll().cancelledCount, 3)
  assert.ok((await Promise.all(requests)).every((result) => result.cancelled))
  assert.equal(calls.length, 1)
})

test('validation detects contract changes but accepts display rotation', () => {
  const options = { kind: 'playback', fps: 29.97 }
  assert.match(validatePreparedMedia(inputProbe, { ...inputProbe, hasAudio: false }, options), /audio/)
  assert.match(validatePreparedMedia(inputProbe, { ...inputProbe, pixelFormat: 'yuv444p' }, options), /YUV420/)
  assert.match(validatePreparedMedia(inputProbe, { ...inputProbe, fps: 60 }, options), /frame rate/)
  assert.match(validatePreparedMedia(inputProbe, { ...inputProbe, width: 960 }, options), /resolution/)
  assert.equal(validatePreparedMedia(inputProbe, { ...inputProbe, width: 1080, height: 1920 }, options), null)
})
