'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { constants } = require('node:fs')
const { discoverConnectedAgentMediaRuntime, LIMITS } = require('../electron/connectedAgentMediaRuntime.cjs')

const signatures = { linux: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), darwin: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), win32: Buffer.from([0x4d, 0x5a, 0x90, 0]) }
const failure = code => Object.assign(new Error('Private diagnostic secret-token and /private/account.json'), { code })

function fixture({ platform = 'linux', entries = {}, onSpawn } = {}) {
  const calls = []
  const children = []
  const fsImpl = {
    async stat(file) {
      calls.push(['stat', file])
      if (!entries[file]) throw failure('ENOENT')
      if (entries[file].stat) return entries[file].stat()
      return { isFile: () => !entries[file].directory }
    },
    async access(file, mode) { calls.push(['access', file, mode]); if (entries[file].denied) throw failure('EACCES') },
    async open(file, mode) {
      calls.push(['open', file, mode])
      const bytes = entries[file].header || signatures[platform]
      return {
        async read(buffer, offset, length, position) { calls.push(['read', file, length]); return { bytesRead: bytes.copy(buffer, offset, position, position + length) } },
        async close() { calls.push(['close', file]) },
      }
    },
  }
  const spawnImpl = (file, args, options) => {
    calls.push(['spawn', file, args, options])
    if (entries[file].throws) throw failure('EACCES')
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = signal => { calls.push(['kill', file, signal]); return true }
    children.push(child)
    queueMicrotask(() => {
      if (onSpawn) return onSpawn(child, file)
      if (entries[file].hang) return
      if (entries[file].error) { child.emit('error', failure('ENOENT')); return }
      const name = /ffprobe/.test(file) ? 'ffprobe' : 'ffmpeg'
      child.stdout.write(entries[file].output ?? `${name} version 7.1.1-static Copyright (c)\nconfiguration: --secret-diagnostic\n`)
      child.emit('close', entries[file].code ?? 0)
    })
    return child
  }
  return { calls, children, dependencies: { platform, arch: 'x64', fsImpl, spawnImpl, environment: {} } }
}

test('exact native-resolved Linux/macOS/Windows development and packaged binaries are verified in parallel', async () => {
  const variants = [
    ['linux', '/checkout/node_modules/ffmpeg-static/ffmpeg', '/checkout/node_modules/@derhuerst/ffprobe-static/ffprobe'],
    ['linux', '/opt/Velorn/resources/bin/ffmpeg', '/opt/Velorn/resources/bin/ffprobe'],
    ['darwin', '/Applications/Velorn.app/Contents/Resources/bin/ffmpeg', '/Applications/Velorn.app/Contents/Resources/bin/ffprobe'],
    ['darwin', '/Applications/Velorn.app/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg', '/Applications/Velorn.app/Contents/Resources/app.asar.unpacked/node_modules/@derhuerst/ffprobe-static/ffprobe'],
    ['win32', 'C:\\Program Files\\Velorn\\resources\\bin\\ffmpeg.exe', 'C:\\Program Files\\Velorn\\resources\\bin\\ffprobe.exe'],
    ['win32', 'C:\\Program Files\\Velorn\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe', 'C:\\Program Files\\Velorn\\resources\\app.asar.unpacked\\node_modules\\@derhuerst\\ffprobe-static\\ffprobe.exe'],
  ]
  for (const [platform, ffmpegPath, ffprobePath] of variants) {
    const mock = fixture({ platform, entries: { [ffmpegPath]: {}, [ffprobePath]: {} } })
    const result = await discoverConnectedAgentMediaRuntime({ ffmpegPath, ffprobePath }, mock.dependencies)
    assert.deepEqual(result, { platform, arch: 'x64', utilities: {
      ffmpeg: { status: 'available', path: ffmpegPath, version: '7.1.1-static' },
      ffprobe: { status: 'available', path: ffprobePath, version: '7.1.1-static' },
    } })
    assert.deepEqual(mock.calls.filter(call => call[0] === 'read').map(call => call[2]), [4, 4])
    assert.equal(mock.calls.filter(call => call[0] === 'access').length, platform === 'win32' ? 0 : 2)
    for (const call of mock.calls.filter(call => call[0] === 'access')) assert.equal(call[2], constants.X_OK)
    for (const call of mock.calls.filter(call => call[0] === 'spawn')) {
      assert.deepEqual(call[2], ['-hide_banner', '-version'])
      assert.deepEqual(call[3], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { LANG: 'C', LC_ALL: 'C' } })
    }
  }
})

test('missing or invalid resolved paths never search PATH, infer installations or execute user arguments', async () => {
  for (const value of [undefined, null, '', 'ffmpeg', './ffmpeg', '/tmp/ffmpeg;echo secret', '/tmp/ffmpeg\n', '/tmp/ffmpeg\0', '/tmp/ffmpeg.cmd', '/tmp/script', 'x'.repeat(LIMITS.pathCharacters + 1)]) {
    const mock = fixture()
    const result = await discoverConnectedAgentMediaRuntime({ ffmpegPath: value, paths: ['/tmp/ffmpeg'], command: 'do not execute' }, mock.dependencies)
    assert.equal(result.utilities.ffmpeg.status, 'unavailable')
    assert.deepEqual(mock.calls, [])
    assert.equal(result.utilities.ffprobe.reason, 'not_resolved')
  }
  for (const value of ['\\ffmpeg.exe', 'C:ffmpeg.exe', '\\\\?\\C:\\ffmpeg.exe', 'C:\\bin\\ffmpeg.cmd']) {
    const mock = fixture({ platform: 'win32' })
    const result = await discoverConnectedAgentMediaRuntime({ ffmpegPath: value }, mock.dependencies)
    assert.equal(result.utilities.ffmpeg.reason, 'invalid_path')
    assert.deepEqual(mock.calls, [])
  }
})

test('ASAR-only paths are unavailable without execution or silently rewriting native resolver choices', async () => {
  const mock = fixture()
  const result = await discoverConnectedAgentMediaRuntime({ ffmpegPath: '/opt/Velorn/resources/app.asar/node_modules/ffmpeg-static/ffmpeg' }, mock.dependencies)
  assert.deepEqual(result.utilities.ffmpeg, { status: 'unavailable', reason: 'inside_archive' })
  assert.deepEqual(mock.calls, [])
})

test('missing files, directories, non-executables and script wrappers are never spawned', async () => {
  for (const [entry, reason] of [[null, 'missing'], [{ directory: true }, 'not_file'], [{ denied: true }, 'not_executable'], [{ header: Buffer.from('#!/bin/sh') }, 'not_native'], [{ header: Buffer.from('MZ') }, 'not_native']]) {
    const mock = fixture({ entries: entry ? { '/bin/ffmpeg': entry } : {} })
    const result = await discoverConnectedAgentMediaRuntime({ ffmpegPath: '/bin/ffmpeg' }, mock.dependencies)
    assert.deepEqual(result.utilities.ffmpeg, { status: 'unavailable', reason })
    assert.equal(mock.calls.filter(call => call[0] === 'spawn').length, 0)
  }
})

test('version queries suppress secrets, report-writing and loader environment settings', async () => {
  const mock = fixture({ platform: 'win32', entries: { 'C:\\bin\\ffmpeg.exe': {} } })
  const result = await discoverConnectedAgentMediaRuntime({ ffmpegPath: 'C:\\bin\\ffmpeg.exe' }, { ...mock.dependencies,
    environment: { systemroot: 'C:\\Windows', windir: 'C:\\Windows', OPENAI_API_KEY: 'secret-token', FFREPORT: 'file=secret.log', PATH: '/untrusted', LD_PRELOAD: 'arbitrary', DYLD_INSERT_LIBRARIES: 'arbitrary' } })
  assert.deepEqual(mock.calls.find(call => call[0] === 'spawn')[3].env, { LANG: 'C', LC_ALL: 'C', SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' })
  assert.doesNotMatch(JSON.stringify(result), /secret|diagnostic|configuration|OPENAI|FFREPORT|PATH|LD_PRELOAD/)
})

test('only a successful exact utility version identifies availability; raw failures never escape', async () => {
  for (const entry of [
    { output: 'ffprobe version 7.1\n' }, { output: 'untrusted private secret-token' },
    { output: 'ffmpeg version 7.1\n', code: 1 }, { output: `ffmpeg version ${'9'.repeat(LIMITS.versionCharacters + 1)}\n` },
    { error: true }, { throws: true },
  ]) {
    const mock = fixture({ entries: { '/bin/ffmpeg': entry } })
    const result = await discoverConnectedAgentMediaRuntime({ ffmpegPath: '/bin/ffmpeg' }, mock.dependencies)
    assert.equal(result.utilities.ffmpeg.status, 'unavailable')
    assert.equal(Object.hasOwn(result.utilities.ffmpeg, 'path'), false)
    assert.doesNotMatch(JSON.stringify(result), /private|secret-token|account\.json/)
  }
})

test('bounded aggregate output across stdout/stderr kills the probe without returning output', async () => {
  const mock = fixture({ entries: { '/bin/ffmpeg': {} }, onSpawn(child) {
    child.stdout.write(Buffer.alloc(LIMITS.outputBytes - 5, 'x'))
    child.stderr.write(Buffer.alloc(6, 'y'))
    child.emit('close', 0)
  } })
  const result = await discoverConnectedAgentMediaRuntime({ ffmpegPath: '/bin/ffmpeg' }, mock.dependencies)
  assert.deepEqual(result.utilities.ffmpeg, { status: 'unavailable', reason: 'output_limit' })
  assert.deepEqual(mock.calls.filter(call => call[0] === 'kill'), [['kill', '/bin/ffmpeg', 'SIGKILL']])
})

test('version on stderr is recognized without including copyright or compiler metadata', async () => {
  const mock = fixture({ entries: { '/bin/ffprobe': {} }, onSpawn(child) {
    child.stderr.write('ffprobe version N-12345-gabc123 Copyright (c)\nprivate compiler metadata')
    child.emit('close', 0)
  } })
  const result = await discoverConnectedAgentMediaRuntime({ ffprobePath: '/bin/ffprobe' }, mock.dependencies)
  assert.deepEqual(result.utilities.ffprobe, { status: 'available', path: '/bin/ffprobe', version: 'N-12345-gabc123' })
})

test('hung probes and filesystem checks are time-bounded; late IO never starts a process', async () => {
  let finishStat
  const mock = fixture({ entries: {
    '/bin/ffmpeg': { hang: true },
    '/bin/ffprobe': { stat: () => new Promise(resolve => { finishStat = resolve }) },
  } })
  const result = await discoverConnectedAgentMediaRuntime({ ffmpegPath: '/bin/ffmpeg', ffprobePath: '/bin/ffprobe' }, { ...mock.dependencies, timeoutMs: 10 })
  assert.deepEqual(result.utilities, { ffmpeg: { status: 'unavailable', reason: 'timeout' }, ffprobe: { status: 'unavailable', reason: 'timeout' } })
  finishStat({ isFile: () => true })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(mock.calls.filter(call => call[0] === 'spawn').map(call => call[1]), ['/bin/ffmpeg'])
  assert.deepEqual(mock.calls.filter(call => call[0] === 'kill'), [['kill', '/bin/ffmpeg', 'SIGKILL']])
  mock.children[0].emit('error', failure('ENOENT'))
  mock.children[0].emit('close', 0)
})

test('abort before discovery performs no IO; abort in flight kills both probes and rejects with cancellation', async () => {
  const already = new AbortController()
  already.abort()
  const idle = fixture()
  await assert.rejects(discoverConnectedAgentMediaRuntime({ ffmpegPath: '/bin/ffmpeg', signal: already.signal }, idle.dependencies), { name: 'AbortError', code: 'CANCELLED' })
  assert.deepEqual(idle.calls, [])

  const controller = new AbortController()
  const mock = fixture({ entries: { '/bin/ffmpeg': { hang: true }, '/bin/ffprobe': { hang: true } } })
  const result = discoverConnectedAgentMediaRuntime({ ffmpegPath: '/bin/ffmpeg', ffprobePath: '/bin/ffprobe', signal: controller.signal }, mock.dependencies)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(mock.children.length, 2)
  controller.abort()
  await assert.rejects(result, { name: 'AbortError', code: 'CANCELLED' })
  assert.deepEqual(mock.calls.filter(call => call[0] === 'kill').map(call => call[1]).sort(), ['/bin/ffmpeg', '/bin/ffprobe'])
  for (const child of mock.children) { child.stdout.write('late secret output'); child.emit('error', failure('EACCES')); child.emit('close', 0) }
})

test('abort while opening a native file closes its late handle and never starts a version probe', async () => {
  const controller = new AbortController()
  const mock = fixture({ entries: { '/bin/ffmpeg': {} } })
  let finishOpen
  let closed = 0
  let read = 0
  mock.dependencies.fsImpl.open = () => new Promise(resolve => { finishOpen = resolve })
  const pending = discoverConnectedAgentMediaRuntime({ ffmpegPath: '/bin/ffmpeg', signal: controller.signal }, mock.dependencies)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError', code: 'CANCELLED' })
  finishOpen({ async close() { closed++ }, async read() { read++ } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, 1)
  assert.equal(read, 0)
  assert.equal(mock.children.length, 0)
})

test('unsupported host reports bounded descriptive data without probing anything', async () => {
  const mock = fixture()
  const result = await discoverConnectedAgentMediaRuntime({ ffmpegPath: '/bin/ffmpeg' }, { ...mock.dependencies, platform: 'unexpected-secret-host', arch: 'unexpected-secret-arch' })
  assert.deepEqual(result, { platform: 'unsupported', arch: 'unknown', utilities: { ffmpeg: { status: 'unavailable', reason: 'unsupported_platform' }, ffprobe: { status: 'unavailable', reason: 'unsupported_platform' } } })
  assert.deepEqual(mock.calls, [])
})
