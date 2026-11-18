'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn, execFile, execFileSync } = require('node:child_process')
const { promisify } = require('node:util')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { createVeloComputerTools, TOOLS, MAC_TOOLS, WINDOWS_TOOLS, LIMITS, commandEnvironment } = require('../electron/veloComputerTools.cjs')
const { parsePs, WINDOWS_BOOTSTRAP, WINDOWS_COMMAND_VARIABLE } = require('../electron/veloComputerProcesses.cjs')

// This file drives real bash, so it is for Linux and macOS. Real Windows
// behaviour (PowerShell and the job object) is in veloComputerToolsWindows.test.cjs.
if (process.platform === 'win32') return

// These tests start real bash commands, so they run on Linux and on macOS.
// PLATFORM picks which process tracking the tools use. On a Linux machine,
// veloComputerToolsPs.test.cjs runs this whole file a second time with the
// macOS (ps-based) tracking, since Linux has a compatible ps.
const PLATFORM = process.env.VELO_COMPUTER_TEST_PLATFORM || process.platform
const MAC = PLATFORM === 'darwin'
const FIXTURE_PATH = '/usr/bin:/bin'
const COMMAND_PATH = MAC ? `${FIXTURE_PATH}:/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin` : FIXTURE_PATH

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const node = code => `${quote(process.execPath)} -e ${quote(code)}`
const unpack = result => ({ ...JSON.parse(result.content[0].text), isError: result.isError === true })
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture(t, options = {}) {
  // macOS temp folders sit behind a /var -> /private/var link; use the real path.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-computer-tools-')))
  const cwd = path.join(root, 'project'); await fs.mkdir(cwd)
  const controller = new AbortController(), events = [], spawns = []
  let valid = true, checks = 0
  const environment = { HOME: root, PATH: FIXTURE_PATH, USER: 'velorn-fixture', LANG: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8',
    VELO_SERVICE_TOKEN: 'synthetic-service-secret', OPENAI_API_KEY: 'synthetic-provider-key',
    BASH_ENV: path.join(root, 'must-not-source'), NODE_OPTIONS: '--invalid-synthetic-option',
    ...options.environment }
  const executor = createVeloComputerTools({ cwd, signal: controller.signal,
    assertCurrent: async () => { checks++; if (!valid) throw new Error('synthetic native credential must not leak'); await options.assertCurrent?.() },
    environment, onEvent: event => events.push(event),
    spawnImpl: (...args) => { spawns.push(args); return (options.spawnImpl || spawn)(...args) },
    limits: { termMs: 30, killMs: 50, treePollMs: 10, ...options.limits },
    platform: PLATFORM, ...options.factory,
  })
  t.after(async () => { await executor.close(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, cwd, controller, events, spawns, executor, call: async (name, args) => unpack(await executor.callTool(name, args)),
    revoke: () => { valid = false }, checks: () => checks }
}
async function complete(f, command, extra = {}) {
  let result = await f.call('run_computer_command', { command, yieldMs: 1000, ...extra })
  const chunks = [result.output || '']
  for (let attempt = 0; result.status === 'running' && attempt < 20; attempt++) {
    result = await f.call('wait_computer_command', { jobId: result.jobId, yieldMs: 200 })
    chunks.push(result.output || '')
  }
  return { ...result, allOutput: chunks.join('') }
}
async function waitFor(predicate, timeout = 3000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await predicate()) return; await pause(10) }
  assert.fail('Timed out waiting for synthetic fixture state')
}
async function alive(pid) {
  if (process.platform !== 'linux') {
    // No /proc on macOS: ask ps. Empty output or an error means the process has gone.
    try { const state = (await promisify(execFile)('/bin/ps', ['-o', 'stat=', '-p', String(pid)])).stdout.trim(); return Boolean(state) && state[0] !== 'Z' }
    catch { return false }
  }
  try { const text = await fs.readFile(`/proc/${pid}/stat`, 'utf8'); return text.slice(text.lastIndexOf(')') + 2)[0] !== 'Z' }
  catch { return false }
}

test('private catalog is passive, exact, and requires native authority and a supported system', async t => {
  const f = await fixture(t)
  assert.deepEqual(TOOLS.map(tool => tool.name), ['inspect_computer_installation', 'run_computer_command', 'wait_computer_command', 'write_computer_input', 'read_computer_file', 'write_computer_file'])
  assert.ok(TOOLS.every(tool => tool.inputSchema.additionalProperties === false))
  assert.equal(f.executor.has('run_computer_command'), true)
  assert.equal(f.executor.has('sudo'), false)
  assert.equal(f.spawns.length, 0); assert.equal(f.checks(), 0)
  assert.throws(() => createVeloComputerTools({ cwd: f.cwd, signal: f.controller.signal }), /authority/)
  for (const platform of ['freebsd', 'aix']) assert.throws(() => createVeloComputerTools({ cwd: f.cwd, signal: f.controller.signal, assertCurrent() {}, platform }), { code: 'UNSUPPORTED_PLATFORM' })
  // macOS gets the same tools and argument rules; only the wording names macOS.
  assert.deepEqual(MAC_TOOLS.map(tool => [tool.name, tool.inputSchema, tool.annotations]), TOOLS.map(tool => [tool.name, tool.inputSchema, tool.annotations]))
  assert.equal(f.executor.tools, MAC ? MAC_TOOLS : TOOLS)
  const wording = tools => tools.find(tool => tool.name === 'run_computer_command').description
  assert.match(wording(TOOLS), /Linux shell command/); assert.doesNotMatch(wording(TOOLS), /macOS/)
  assert.match(wording(MAC_TOOLS), /macOS shell command/); assert.doesNotMatch(wording(MAC_TOOLS), /Linux/)
  assert.deepEqual(WINDOWS_TOOLS.map(tool => [tool.name, tool.inputSchema, tool.annotations]), TOOLS.map(tool => [tool.name, tool.inputSchema, tool.annotations]))
  assert.match(wording(WINDOWS_TOOLS), /Windows PowerShell command/); assert.doesNotMatch(wording(WINDOWS_TOOLS), /bash --noprofile|Linux|macOS/)
})

test('every invalid schema fails without spawning, mutating or checking authority', async t => {
  const f = await fixture(t)
  const calls = [
    ['unknown', {}], ['run_computer_command', null], ['run_computer_command', []], ['run_computer_command', {}],
    ['run_computer_command', { command: '' }], ['run_computer_command', { command: 'true', env: {} }],
    ['run_computer_command', { command: 'true', yieldMs: -1 }], ['run_computer_command', { command: 'true', yieldMs: 300001 }],
    ['run_computer_command', { command: 'a\0b' }], ['run_computer_command', { command: 'é'.repeat(20000) }],
    ['wait_computer_command', { jobId: 'unknown', offset: 0.5 }], ['read_computer_file', { path: 'x', maxBytes: 0 }],
    ['read_computer_file', { path: 'x', encoding: 'hex' }], ['write_computer_input', { jobId: 'x' }],
    ['write_computer_input', { jobId: 'x', closeInput: 1 }], ['write_computer_file', { path: 'x', content: 'x' }],
    ['write_computer_file', { path: 'x', content: '%', encoding: 'base64', mode: 'create' }],
    ['write_computer_file', { path: 'x', content: 'Zh==', encoding: 'base64', mode: 'create' }],
  ]
  for (const [name, args] of calls) { const result = await f.call(name, args); assert.equal(result.success, false); assert.equal(result.possibleChanges, false) }
  assert.equal(f.spawns.length, 0); assert.equal(f.checks(), 0); assert.deepEqual(await fs.readdir(f.cwd), [])
})

test('ordinary OS environment is retained without application keys or shell startup injection', async t => {
  const f = await fixture(t, { environment: { LC_TIME: 'C', HTTPS_PROXY: 'http://proxy.test:1234', CUSTOM_SERVICE_BEARER: 'synthetic-bearer' } })
  await fs.writeFile(path.join(f.root, 'must-not-source'), `printf BAD_INIT; touch ${quote(path.join(f.root, 'bad-init'))}`)
  const result = await complete(f, 'printf "%s\\n" "$HOME" "$PATH" "${VELO_SERVICE_TOKEN-unset}" "${OPENAI_API_KEY-unset}" "${BASH_ENV-unset}" "${NODE_OPTIONS-unset}"')
  assert.equal(result.exitCode, 0)
  assert.equal(result.allOutput, `${f.root}\n${COMMAND_PATH}\nunset\nunset\nunset\nunset\n`)
  assert.equal(f.spawns[0][0], '/bin/bash')
  assert.deepEqual(f.spawns[0][1].slice(0, 3), ['--noprofile', '--norc', '-c'])
  assert.equal(f.spawns[0][2].detached, true); assert.equal(f.spawns[0][2].shell, false)
  assert.equal(f.spawns[0][2].env.CUSTOM_SERVICE_BEARER, undefined)
  await assert.rejects(fs.stat(path.join(f.root, 'bad-init')), { code: 'ENOENT' })
  const synthetic = { PATH: '/synthetic', HOME: '/synthetic-home', LD_PRELOAD: 'bad', BASH_FUNC_x: 'bad', LC_TIME: 'C',
    DYLD_INSERT_LIBRARIES: 'bad', __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0' }
  assert.deepEqual(commandEnvironment(synthetic, 'linux'), { PATH: '/synthetic', HOME: '/synthetic-home', LC_TIME: 'C' })
  // A Mac app opened from Finder has no Homebrew folders on PATH; they are added last.
  assert.deepEqual(commandEnvironment(synthetic, 'darwin'), { PATH: '/synthetic:/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin',
    HOME: '/synthetic-home', LC_TIME: 'C', __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0' })
  assert.equal(commandEnvironment({ PATH: '/opt/homebrew/bin:/usr/bin:/bin' }, 'darwin').PATH, '/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/sbin')
  assert.equal(commandEnvironment({}, 'darwin').PATH, '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin')
  assert.equal(commandEnvironment({}, 'linux').PATH, '/usr/local/bin:/usr/bin:/bin')
})

test('file-read argument errors report exact runtime byte bounds and the unchanged default', async t => {
  const schema = TOOLS.find(tool => tool.name === 'read_computer_file').inputSchema.properties.maxBytes
  assert.equal(schema.minimum, 1)
  assert.equal(schema.maximum, LIMITS.pageBytes)
  assert.match(schema.description, new RegExp(`default ${LIMITS.pageBytes}`))
  for (const pageBytes of [LIMITS.pageBytes, 64]) {
    const f = await fixture(t, { limits: { pageBytes } })
    const filename = path.join(f.cwd, 'bounded-read.txt')
    await fs.writeFile(filename, 'x'.repeat(pageBytes + 3))
    for (const maxBytes of [-1, 0, 1.5, null, '1', pageBytes + 1, 50000, 1000000]) {
      const result = await f.call('read_computer_file', { path: filename, maxBytes })
      assert.equal(result.isError, true)
      assert.equal(result.code, 'INVALID_ARGUMENTS')
      assert.equal(result.possibleChanges, false)
      assert.equal(result.error, `maxBytes must be an integer from 1 to ${pageBytes} bytes. Omit maxBytes to read the default ${pageBytes} bytes.`)
    }
    assert.equal(f.checks(), 0, 'Invalid arguments stop before native authority or filesystem work')
    assert.equal(f.spawns.length, 0)
    const defaultRead = await f.call('read_computer_file', { path: filename })
    assert.equal(defaultRead.success, true)
    assert.equal(defaultRead.bytesRead, pageBytes)
    assert.equal(defaultRead.nextOffset, pageBytes)
    assert.equal(defaultRead.eof, false)
    for (const maxBytes of [1, pageBytes]) {
      const result = await f.call('read_computer_file', { path: filename, maxBytes })
      assert.equal(result.success, true)
      assert.equal(result.bytesRead, maxBytes)
    }
    assert.equal(await fs.readFile(filename, 'utf8'), 'x'.repeat(pageBytes + 3))
  }
})

test('shell commands and cwd are not whitelisted or confined to the project', async t => {
  const f = await fixture(t), other = path.join(f.root, 'outside-project')
  await fs.mkdir(other)
  const result = await complete(f, 'printf ordinary-shell > output.txt; pwd; printf stderr-line >&2', { cwd: other })
  assert.equal(result.exitCode, 0); assert.match(result.allOutput, /outside-project/); assert.match(result.allOutput, /stderr-line/)
  assert.equal(await fs.readFile(path.join(other, 'output.txt'), 'utf8'), 'ordinary-shell')
  const invalid = await f.call('run_computer_command', { command: 'true', cwd: path.join(other, 'output.txt') })
  assert.equal(invalid.success, false); assert.equal(f.spawns.length, 1)
})

test('real loopback HTTP fixture is reachable with ordinary command network access', async t => {
  const f = await fixture(t)
  const server = http.createServer((_req, res) => res.end('synthetic-loopback-only'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const result = await complete(f, node(`require('node:http').get('http://127.0.0.1:${server.address().port}',r=>r.pipe(process.stdout)).on('error',()=>process.exit(2))`))
  assert.equal(result.exitCode, 0); assert.equal(result.allOutput, 'synthetic-loopback-only')
})

test('nonzero exit and signals are truthful and are never retried', async t => {
  const f = await fixture(t)
  const failed = await complete(f, 'printf partial; exit 17')
  assert.equal(failed.success, false); assert.equal(failed.exitCode, 17); assert.equal(failed.allOutput, 'partial'); assert.equal(failed.possibleChanges, true)
  assert.equal(failed.status, 'failed'); assert.equal(failed.isError, true)
  assert.equal(failed.recovery.automaticRetry, false)
  const signalled = await complete(f, 'kill -TERM $$')
  assert.equal(signalled.success, false); assert.equal(signalled.signal, 'SIGTERM'); assert.equal(signalled.exitCode, null)
  assert.equal(f.spawns.length, 2)
})

test('async job waits and interactive stdin do not restart the command', async t => {
  const f = await fixture(t)
  const job = await f.call('run_computer_command', { command: 'read -r line; printf "received:%s\\n" "$line"; cat', yieldMs: 0 })
  assert.equal(job.status, 'running')
  const pending = await f.call('wait_computer_command', { jobId: job.jobId, yieldMs: 20 })
  assert.equal(pending.status, 'running')
  const sent = await f.call('write_computer_input', { jobId: job.jobId, input: 'hello\nsecond\n', closeInput: true })
  assert.equal(sent.queuedBytes, 13); assert.equal(sent.consumed, 'unknown'); assert.equal(sent.stdinClosed, true)
  const done = await f.call('wait_computer_command', { jobId: job.jobId, yieldMs: 1000, offset: 0 })
  assert.equal(done.status, 'completed'); assert.equal(done.exitCode, 0); assert.equal(done.output, 'received:hello\nsecond\n')
  assert.equal((await f.call('write_computer_input', { jobId: job.jobId, input: 'again' })).code, 'INPUT_CLOSED')
  assert.equal(f.spawns.length, 1)
})

test('job identity is private to its turn and cannot forge authority or stdin', async t => {
  const f = await fixture(t), other = await fixture(t)
  const job = await f.call('run_computer_command', { command: 'read -r line', yieldMs: 0 })
  assert.equal((await other.call('wait_computer_command', { jobId: job.jobId })).code, 'UNKNOWN_JOB')
  assert.equal((await other.call('write_computer_input', { jobId: job.jobId, input: 'x' })).code, 'UNKNOWN_JOB')
  assert.equal((await f.call('run_computer_command', { command: 'true', fullAccess: true })).code, 'INVALID_ARGUMENTS')
})

test('command output is bounded, byte-paged, and explicit about discarded output', async t => {
  const f = await fixture(t, { limits: { retainedBytes: 64, pageBytes: 16 } })
  const done = await complete(f, node('process.stdout.write("0123456789".repeat(20))'))
  assert.equal(done.status, 'completed'); assert.equal(done.totalBytes, 200); assert.equal(done.availableFrom, 136)
  const first = await f.call('wait_computer_command', { jobId: done.jobId, offset: 0, yieldMs: 0 })
  assert.equal(first.offset, 136); assert.equal(first.outputLostBytes, 136); assert.equal(first.output.length, 16); assert.equal(first.hasMore, true)
  const second = await f.call('wait_computer_command', { jobId: done.jobId, yieldMs: 0 })
  assert.equal(second.offset, 152); assert.equal(second.outputLostBytes, 0)
  const repeat = await f.call('wait_computer_command', { jobId: done.jobId, offset: 136, yieldMs: 0 })
  assert.equal(repeat.output, first.output); assert.equal(f.spawns.length, 1)
})

test('activity shows bounded redacted commands/output without raw credential logs', async t => {
  const f = await fixture(t)
  const done = await complete(f, "printf 'public-line\\nAPI_KEY=synthetic-credential\\n'; printf 'Bearer synthetic-bearer\\n'")
  assert.match(done.allOutput, /synthetic-credential/)
  const activity = JSON.stringify(f.events)
  assert.match(activity, /Shell command/); assert.match(activity, /credential.*redacted/)
  assert.doesNotMatch(activity, /synthetic-credential|synthetic-bearer/)
  assert.ok(f.events.every(event => event.type === 'tool' && event.callId.startsWith('velo-computer:')))
  await complete(f, 'printf visible-command')
  assert.ok(f.events.some(event => event.summary === 'printf visible-command'))
})

test('file create, replace, append and binary reads work outside project with explicit semantics', async t => {
  const f = await fixture(t), target = path.join(f.root, 'external.bin')
  const created = await f.call('write_computer_file', { path: target, content: 'first', mode: 'create' })
  assert.equal(created.success, true); assert.equal(created.bytesWritten, 5); assert.equal(created.atomic, false)
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600)
  assert.equal((await f.call('write_computer_file', { path: target, content: 'lost', mode: 'create' })).code, 'EEXIST')
  assert.equal(await fs.readFile(target, 'utf8'), 'first')
  await fs.chmod(target, 0o640)
  const before = await fs.stat(target)
  assert.equal((await f.call('write_computer_file', { path: target, content: 'second', mode: 'replace' })).success, true)
  assert.equal((await f.call('write_computer_file', { path: target, content: 'AAH/', encoding: 'base64', mode: 'append' })).success, true)
  assert.equal((await fs.stat(target)).ino, before.ino); assert.equal((await fs.stat(target)).mode & 0o777, 0o640)
  const read = await f.call('read_computer_file', { path: target, offset: 6, maxBytes: 3, encoding: 'base64' })
  assert.equal(read.content, 'AAH/'); assert.equal(read.bytesRead, 3); assert.equal(read.nextOffset, 9); assert.equal(read.eof, true)
  assert.equal((await f.call('write_computer_file', { path: 'missing', content: 'x', mode: 'append' })).code, 'ENOENT')
})

test('file reads page exactly and symlinks resolve without a project jail', async t => {
  const f = await fixture(t), target = path.join(f.root, 'outside.txt')
  await fs.writeFile(target, 'abcdefghijk'); await fs.symlink(target, path.join(f.cwd, 'alias'))
  const first = await f.call('read_computer_file', { path: 'alias', maxBytes: 4 })
  assert.equal(first.path, target); assert.equal(first.content, 'abcd'); assert.equal(first.eof, false)
  const second = await f.call('read_computer_file', { path: 'alias', offset: first.nextOffset, maxBytes: 4 })
  assert.equal(second.content, 'efgh')
  assert.equal((await f.call('write_computer_file', { path: 'alias', content: 'replacement', mode: 'replace' })).success, true)
  assert.equal(await fs.readFile(target, 'utf8'), 'replacement')
  assert.equal((await fs.lstat(path.join(f.cwd, 'alias'))).isSymbolicLink(), true)
})

test('devices, directories and FIFOs are rejected without blocking or writing', async t => {
  const f = await fixture(t), fifo = path.join(f.root, 'synthetic-fifo')
  await promisify(execFile)('/usr/bin/mkfifo', [fifo], { env: { PATH: '/usr/bin:/bin' } })
  for (const target of [f.cwd, fifo, '/dev/null']) {
    assert.equal((await f.call('read_computer_file', { path: target })).code, 'NOT_REGULAR_FILE')
    assert.equal((await f.call('write_computer_file', { path: target, content: 'x', mode: 'replace' })).code, 'NOT_REGULAR_FILE')
  }
})

test('revoked authority after async path resolution prevents both spawn and file mutation', async t => {
  const hold = defer(), entered = defer()
  const f = await fixture(t, { factory: { fsImpl: { ...fs, realpath: async value => { entered.resolve(); await hold.promise; return fs.realpath(value) } } } })
  const pending = f.call('run_computer_command', { command: 'touch must-not-exist' })
  await entered.promise; f.revoke(); hold.resolve()
  const result = await pending
  assert.equal(result.code, 'UNAUTHORIZED'); assert.equal(f.spawns.length, 0)
  assert.doesNotMatch(JSON.stringify(result), /synthetic native credential/)
  assert.deepEqual(await fs.readdir(f.cwd), [])
  const second = await fixture(t)
  second.revoke()
  assert.equal((await second.call('write_computer_file', { path: 'new', content: 'x', mode: 'create' })).code, 'UNAUTHORIZED')
  assert.deepEqual(await fs.readdir(second.cwd), [])
})

test('abort during pre-spawn async checks never launches a late command', async t => {
  const hold = defer(), entered = defer()
  const f = await fixture(t, { factory: { fsImpl: { ...fs, stat: async value => { entered.resolve(); await hold.promise; return fs.stat(value) } } } })
  const pending = f.call('run_computer_command', { command: 'true' })
  await entered.promise; f.controller.abort(); hold.resolve()
  assert.equal((await pending).code, 'CANCELLED'); assert.equal(f.spawns.length, 0)
})

test('cancellation after truncation reports possible partial changes, never rollback', async t => {
  let f, truncations = 0
  const fsImpl = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args)
    return new Proxy(handle, { get(target, key) {
      if (key === 'truncate') return async size => { await target.truncate(size); truncations++; f.controller.abort() }
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
    } })
  } }
  f = await fixture(t, { factory: { fsImpl } })
  await fs.writeFile(path.join(f.cwd, 'target'), 'original')
  const result = await f.call('write_computer_file', { path: 'target', content: 'replacement', mode: 'replace' })
  assert.equal(result.code, 'CANCELLED'); assert.equal(result.possibleChanges, true); assert.equal(result.bytesWritten, 0)
  assert.equal(truncations, 1); assert.equal(await fs.readFile(path.join(f.cwd, 'target'), 'utf8'), '')
})

test('Stop kills the owned shell process group and normal grandchildren; no new calls after close', async t => {
  const f = await fixture(t)
  const job = await f.call('run_computer_command', { command: 'sleep 30 & printf "%s\\n" "$!"; wait', yieldMs: 30 })
  const childPid = Number(job.output.trim())
  assert.ok(childPid > 0); assert.equal(await alive(childPid), true)
  f.controller.abort()
  const result = await f.executor.close()
  assert.equal(result.success, true)
  await waitFor(async () => !await alive(childPid))
  assert.equal((await f.call('run_computer_command', { command: 'true' })).code, 'CANCELLED')
  assert.equal(f.spawns.length, 1)
})

test('turn close kills observed detached descendants as well as the original group', async t => {
  const f = await fixture(t)
  const command = node(`const {spawn}=require('node:child_process');const c=spawn(${JSON.stringify(process.execPath)},['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)`)
  const job = await f.call('run_computer_command', { command, yieldMs: 200 })
  const childPid = Number(job.output.trim())
  assert.ok(childPid > 0); assert.equal(await alive(childPid), true)
  assert.equal((await f.executor.close()).success, true)
  await waitFor(async () => !await alive(childPid))
})

test('fast-exit orphan cleanup is either identity-confirmed or explicitly unconfirmed, never guessed', async t => {
  const f = await fixture(t)
  const job = await complete(f, 'sleep 30 </dev/null >/dev/null 2>&1 & printf "%s\\n" "$!"')
  const childPid = Number(job.allOutput.trim())
  t.after(() => { try { process.kill(childPid, 'SIGKILL') } catch {} })
  assert.equal(job.status, 'completed'); assert.equal(await alive(childPid), true)
  const result = await f.executor.close()
  if (result.success) await waitFor(async () => !await alive(childPid))
  else assert.equal(result.cleanupConfirmed, false)
})

test('close is idempotent, kills TERM-ignoring owned commands, and releases pending waits', async t => {
  const f = await fixture(t)
  const job = await f.call('run_computer_command', { command: 'trap "" TERM; printf ready; while :; do sleep 1; done', yieldMs: 30 })
  const wait = f.call('wait_computer_command', { jobId: job.jobId, yieldMs: 10000 })
  await pause(10)
  const first = f.executor.close(), second = f.executor.close()
  const cleanup = await first
  assert.equal(first, second); assert.equal(cleanup.success, true, JSON.stringify(cleanup)); assert.equal((await wait).code, 'CANCELLED')
})

test('failed spawn and resource limits are explicit without a command retry', async t => {
  const f = await fixture(t, { spawnImpl: () => { throw Object.assign(new Error('synthetic raw secret'), { code: 'ENOENT' }) } })
  const failed = await f.call('run_computer_command', { command: 'true' })
  assert.equal(failed.code, 'ENOENT'); assert.equal(failed.possibleChanges, false)
  assert.doesNotMatch(JSON.stringify(failed), /synthetic raw secret/); assert.equal(f.spawns.length, 1)
  const other = await fixture(t, { limits: { activeJobs: 1 } })
  await other.call('run_computer_command', { command: 'read -r line', yieldMs: 0 })
  assert.equal((await other.call('run_computer_command', { command: 'true' })).code, 'RESOURCE_LIMIT')
  assert.equal(other.spawns.length, 1)
})

test('file target replacement between inspection and open is rejected before truncation', async t => {
  let swapped = false, f
  const fsImpl = { ...fs, open: async (...args) => {
    if (!swapped && args[0] === path.join(f.cwd, 'target')) {
      swapped = true; await fs.rename(args[0], path.join(f.cwd, 'original')); await fs.writeFile(args[0], 'concurrent')
    }
    return fs.open(...args)
  } }
  f = await fixture(t, { factory: { fsImpl } })
  await fs.writeFile(path.join(f.cwd, 'target'), 'original')
  const result = await f.call('write_computer_file', { path: 'target', content: 'replacement', mode: 'replace' })
  assert.equal(result.code, 'FILE_CHANGED'); assert.equal(result.possibleChanges, false)
  assert.equal(await fs.readFile(path.join(f.cwd, 'target'), 'utf8'), 'concurrent')
  assert.equal(await fs.readFile(path.join(f.cwd, 'original'), 'utf8'), 'original')
})

test('process exit synchronously terminates a synthetic owned group without awaiting close', async t => {
  const f = await fixture(t), pidFile = path.join(f.root, 'exit-child-pid')
  const modulePath = require.resolve('../electron/veloComputerTools.cjs')
  const script = `const {createVeloComputerTools}=require(${JSON.stringify(modulePath)});const controller=new AbortController();
    const tools=createVeloComputerTools({cwd:${JSON.stringify(f.cwd)},signal:controller.signal,assertCurrent:()=>true,
      environment:{HOME:${JSON.stringify(f.root)},PATH:'/usr/bin:/bin'},platform:${JSON.stringify(PLATFORM)}});
    tools.callTool('run_computer_command',{command:${JSON.stringify(`sleep 30 & echo $! > ${quote(pidFile)}; wait`)},yieldMs:100})
      .then(()=>process.exit(0));`
  await promisify(execFile)(process.execPath, ['-e', script], { cwd: f.cwd, env: { HOME: f.root, PATH: '/usr/bin:/bin' }, timeout: 5000 })
  const pid = Number((await fs.readFile(pidFile, 'utf8')).trim())
  assert.ok(pid > 0); await waitFor(async () => !await alive(pid))
})

test('revocation closes existing commands and cleanup removes its process-exit listener', async t => {
  const before = process.listenerCount('exit'), f = await fixture(t)
  assert.equal(process.listenerCount('exit'), before + 1)
  const job = await f.call('run_computer_command', { command: 'sleep 30 & echo $!; wait', yieldMs: 30 })
  const pid = Number(job.output.trim())
  f.revoke()
  const denied = await f.call('wait_computer_command', { jobId: job.jobId, yieldMs: 0 })
  assert.equal(denied.code, 'UNAUTHORIZED')
  assert.equal((await f.executor.close()).success, true); await waitFor(async () => !await alive(pid))
  assert.equal(process.listenerCount('exit'), before)
})

test('resource ceilings do not impose a short command deadline', async t => {
  const f = await fixture(t)
  const job = await f.call('run_computer_command', { command: 'sleep 0.15; printf survived', yieldMs: 5 })
  assert.equal(job.status, 'running')
  await pause(200)
  const done = await f.call('wait_computer_command', { jobId: job.jobId, yieldMs: 0, offset: 0 })
  assert.equal(done.exitCode, 0); assert.equal(done.output, 'survived'); assert.equal(f.spawns.length, 1)
})

function syntheticProcess(pid, start, group = pid) {
  const fields = Array(20).fill('0'); fields[0] = 'S'; fields[1] = '1'; fields[2] = String(group); fields[19] = start
  return `${pid} (synthetic fixture) ${fields.join(' ')}`
}
const syntheticChild = pid => Object.assign(new EventEmitter(), { pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })

test('a recycled PID/PGID is not signalled by synchronous abort or asynchronous cleanup', async t => {
  const pid = 432100, signals = []; let start = '111'
  const f = await fixture(t, { factory: {
    platform: 'linux', spawnImpl: () => syntheticChild(pid), processKillImpl: (...args) => signals.push(args),
    readFileSyncImpl: () => syntheticProcess(pid, start),
    fsImpl: { ...fs, readdir: async value => value === '/proc' ? [String(pid)] : fs.readdir(value),
      readFile: async (value, ...rest) => value === `/proc/${pid}/stat` ? syntheticProcess(pid, start) : fs.readFile(value, ...rest) },
  } })
  const job = await f.call('run_computer_command', { command: 'synthetic command', yieldMs: 0 })
  assert.equal(job.status, 'running')
  start = '222'; f.controller.abort()
  assert.equal((await f.executor.close()).success, true)
  assert.deepEqual(signals, [])
})

test('unavailable process metadata reports unconfirmed cleanup, never false success', async t => {
  const pid = 432101
  const f = await fixture(t, { factory: {
    platform: 'linux', spawnImpl: () => syntheticChild(pid), processKillImpl() {}, readFileSyncImpl: () => syntheticProcess(pid, '111'),
    fsImpl: { ...fs, readdir: async value => { if (value === '/proc') throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); return fs.readdir(value) } },
  } })
  await f.call('run_computer_command', { command: 'synthetic command', yieldMs: 0 })
  const result = await f.executor.close()
  assert.equal(result.success, false); assert.equal(result.cleanupConfirmed, false)
})

test('an unanchored recycled group is not adopted when its new leader has already exited', async t => {
  const pid = 432102, stranger = 432103, signals = []; let reused = false
  const f = await fixture(t, { factory: {
    platform: 'linux', spawnImpl: () => syntheticChild(pid), processKillImpl: (...args) => signals.push(args),
    readFileSyncImpl: () => { if (reused) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return syntheticProcess(pid, '111') },
    fsImpl: { ...fs, readdir: async value => value === '/proc' ? [String(reused ? stranger : pid)] : fs.readdir(value),
      readFile: async (value, ...rest) => value.startsWith('/proc/') ? syntheticProcess(reused ? stranger : pid, reused ? '222' : '111', pid) : fs.readFile(value, ...rest) },
  } })
  await f.call('run_computer_command', { command: 'synthetic command', yieldMs: 0 })
  reused = true; f.controller.abort()
  const result = await f.executor.close()
  assert.deepEqual(signals, []); assert.equal(result.success, false); assert.equal(result.cleanupConfirmed, false)
})

test('missing initial identity never seeds ownership from a later numeric PID', async t => {
  const pid = 432104, signals = []
  const f = await fixture(t, { factory: {
    platform: 'linux', spawnImpl: () => syntheticChild(pid), processKillImpl: (...args) => signals.push(args),
    readFileSyncImpl: () => { throw Object.assign(new Error('initial metadata unavailable'), { code: 'EACCES' }) },
    fsImpl: { ...fs, readdir: async value => value === '/proc' ? [String(pid)] : fs.readdir(value),
      readFile: async (value, ...rest) => value.startsWith('/proc/') ? syntheticProcess(pid, '222') : fs.readFile(value, ...rest) },
  } })
  await f.call('run_computer_command', { command: 'synthetic command', yieldMs: 0 })
  f.controller.abort()
  const result = await f.executor.close()
  assert.deepEqual(signals, []); assert.equal(result.success, false); assert.equal(result.cleanupConfirmed, false)
})

// The same ownership rules, proven for the macOS source with a synthetic ps.
const psLine = (pid, start, { parent = 1, group = pid, state = 'S' } = {}) => `${String(pid).padStart(5)} ${String(parent).padStart(5)} ${String(group).padStart(5)} ${state.padEnd(4)} ${start}\n`
const START_A = 'Tue Nov 17 10:00:00 2026', START_B = 'Tue Nov 17 10:00:07 2026'
function syntheticPs(listing) {
  const calls = []
  const run = args => { calls.push(args); const text = listing(args); if (text instanceof Error) throw text; return text }
  return { calls,
    execFileImpl: (file, args, options, done) => { assert.equal(file, '/bin/ps'); assert.equal(options.env.LC_ALL, 'C'); assert.equal(options.env.TZ, 'UTC')
      let text; try { text = run(args) } catch (error) { setImmediate(done, error); return }
      setImmediate(done, null, text) },
    execFileSyncImpl: (file, args, options) => { assert.equal(file, '/bin/ps'); assert.equal(options.env.LC_ALL, 'C'); return run(args) } }
}

test('macOS ps listing is parsed strictly; anything odd is unreadable, never guessed', () => {
  const { rows, unreadable } = parsePs(`    1     0     1 Ss   Mon Nov  2 08:15:01 2026\n  812   640   640 R+   ${START_A}\n  813   812   640 Z    ${START_B}\n  900   812   640 S    yesterday\n  901   812     0 S    ${START_A}\nnot a row\n\n`)
  assert.deepEqual(rows.get(1), { pid: 1, state: 'S', parent: 0, group: 1, start: 'Mon Nov 2 08:15:01 2026' })
  assert.deepEqual(rows.get(812), { pid: 812, state: 'R', parent: 640, group: 640, start: START_A })
  assert.equal(rows.get(813).state, 'Z'); assert.equal(rows.size, 3)
  assert.deepEqual([...unreadable], [900, 901])
  const real = parsePs(execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart='],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' } }))
  assert.equal(real.rows.get(process.pid).parent, process.ppid, 'This computer\'s real ps output is understood')
})

test('macOS: Stop signals the owned group and members, in one synchronous ps run', async t => {
  const pid = 432200, child = 432201, signals = []
  const ps = syntheticPs(() => psLine(pid, START_A) + psLine(child, START_B, { parent: pid, group: pid }) + psLine(77, START_A, { group: 77 }))
  const f = await fixture(t, { factory: { platform: 'darwin', spawnImpl: () => syntheticChild(pid),
    processKillImpl: (...args) => signals.push(args), ...ps } })
  assert.equal((await f.call('run_computer_command', { command: 'synthetic command', yieldMs: 0 })).status, 'running')
  const before = ps.calls.length
  f.controller.abort()
  const stopCall = ps.calls[before]
  assert.deepEqual(stopCall.slice(0, 2), ['-p', `${pid},${child}`], 'One ps run covers every owned process at Stop')
  assert.deepEqual(signals.slice(0, 3), [[-pid, 'SIGTERM'], [pid, 'SIGTERM'], [child, 'SIGTERM']])
  await f.executor.close()
  assert.ok(signals.some(([target, signal]) => target === -pid && signal === 'SIGKILL'))
  assert.ok(signals.every(([target]) => [pid, child].includes(Math.abs(target))), 'Nothing outside the owned group is signalled')
})

test('macOS: a recycled PID/PGID is not signalled by synchronous abort or asynchronous cleanup', async t => {
  const pid = 432210, signals = []; let start = START_A
  const ps = syntheticPs(() => psLine(pid, start))
  const f = await fixture(t, { factory: { platform: 'darwin', spawnImpl: () => syntheticChild(pid),
    processKillImpl: (...args) => signals.push(args), ...ps } })
  await f.call('run_computer_command', { command: 'synthetic command', yieldMs: 0 })
  start = START_B; f.controller.abort()
  assert.equal((await f.executor.close()).success, true)
  assert.deepEqual(signals, [])
})

test('macOS: a failing ps reports unconfirmed cleanup, never false success', async t => {
  const pid = 432220; let broken = false
  const ps = syntheticPs(() => broken ? Object.assign(new Error('fixture ps failed'), { code: 'ENOENT' }) : psLine(pid, START_A))
  const f = await fixture(t, { factory: { platform: 'darwin', spawnImpl: () => syntheticChild(pid), processKillImpl() {}, ...ps } })
  await f.call('run_computer_command', { command: 'synthetic command', yieldMs: 0 })
  broken = true
  const result = await f.executor.close()
  assert.equal(result.success, false); assert.equal(result.cleanupConfirmed, false)
})

test('macOS: missing initial identity never seeds ownership from a later numeric PID', async t => {
  const pid = 432230, signals = []; let first = true
  const ps = syntheticPs(args => { if (first && args[0] === '-p') { first = false; return Object.assign(new Error('gone'), { status: 1, stdout: '' }) } return psLine(pid, START_B) })
  const f = await fixture(t, { factory: { platform: 'darwin', spawnImpl: () => syntheticChild(pid),
    processKillImpl: (...args) => signals.push(args), ...ps } })
  await f.call('run_computer_command', { command: 'synthetic command', yieldMs: 0 })
  f.controller.abort()
  const result = await f.executor.close()
  assert.deepEqual(signals, []); assert.equal(result.success, false); assert.equal(result.cleanupConfirmed, false)
})

test('macOS: an exited, uncollected shell keeps its identity so late group members are still stopped', async t => {
  const pid = 432240, child = 432241, late = 432242, signals = []; let exited = false
  // Some ps builds may print a different start for a zombie; ownership must not be lost.
  const ps = syntheticPs(() => psLine(pid, exited ? 'Thu Jan 1 00:00:00 1970' : START_A, { state: exited ? 'Z' : 'S' })
    + psLine(child, START_B, { parent: pid, group: pid }) + (exited ? psLine(late, START_B, { parent: 1, group: pid }) : ''))
  const f = await fixture(t, { factory: { platform: 'darwin', spawnImpl: () => syntheticChild(pid),
    processKillImpl: (...args) => signals.push(args), ...ps } })
  await f.call('run_computer_command', { command: 'synthetic command', yieldMs: 0 })
  exited = true; await pause(60); f.controller.abort()
  assert.deepEqual(signals.slice(0, 3), [[-pid, 'SIGTERM'], [child, 'SIGTERM'], [late, 'SIGTERM']])
  await f.executor.close()
})

// Windows logic that can be checked without Windows: how the shell is started,
// what it is given, and that Stop ends it through its own handle. The real
// job-object behaviour is proven on Windows in veloComputerToolsWindows.test.cjs.
test('Windows: PowerShell is started with a fixed script; the command travels only in the environment', async t => {
  const child = syntheticChild(432300); child.kill = () => true
  const f = await fixture(t, { environment: { SystemRoot: 'D:\\Win', Path: 'D:\\Win\\System32', NODE_OPTIONS: '--bad', PSModulePath: 'x' },
    spawnImpl: () => child, factory: { platform: 'win32' } })
  const command = 'Write-Output "it\'s `"quoted`" & tricky | $env:USERNAME"'
  assert.equal((await f.call('run_computer_command', { command, yieldMs: 0 })).status, 'running')
  const [file, args, options] = f.spawns[0]
  assert.equal(file, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.deepEqual(args.slice(0, 8), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand'])
  assert.equal(Buffer.from(args[8], 'base64').toString('utf16le'), WINDOWS_BOOTSTRAP)
  assert.ok(!args.join(' ').includes('tricky'), 'The user command is never on the command line')
  assert.equal(options.env[WINDOWS_COMMAND_VARIABLE], command)
  assert.equal(options.detached, false, 'Not detached: Windows then ends the shell if Velorn itself dies')
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true)
  assert.equal(options.env.NODE_OPTIONS, undefined); assert.equal(options.env.PSModulePath, undefined); assert.equal(options.env.VELO_SERVICE_TOKEN, undefined)
  assert.equal(f.executor.tools, WINDOWS_TOOLS)
  // The start-up script must contain the command only after the job is in place.
  assert.ok(WINDOWS_BOOTSTRAP.indexOf('AssignProcessToJobObject(job, GetCurrentProcess())') > 0)
  assert.ok(WINDOWS_BOOTSTRAP.indexOf('[Velorn.CommandJob]::Contain()') < WINDOWS_BOOTSTRAP.indexOf('& $velornBlock'))
  assert.match(WINDOWS_BOOTSTRAP, /0x2000/, 'Kill-on-close limit')
  assert.deepEqual(commandEnvironment({ Path: 'C:\\x', PATH: 'dup', SystemRoot: 'C:\\Windows', UserProfile: 'C:\\Users\\a', ELECTRON_RUN_AS_NODE: '1', OPENAI_API_KEY: 'k' }, 'win32'),
    { Path: 'C:\\x', SystemRoot: 'C:\\Windows', UserProfile: 'C:\\Users\\a' })
  assert.equal(commandEnvironment({}, 'win32').Path, 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0')
})

test('Windows: Stop ends the shell by its own handle, never by number, and confirms only after it has gone', async t => {
  const signals = [], kills = []
  const make = pid => { const child = syntheticChild(pid); child.kill = signal => { kills.push([pid, signal]); setTimeout(() => { child.emit('exit', null, 'SIGKILL'); child.emit('close') }, 30); return true }; return child }
  const children = [make(432310), make(432311)]
  const f = await fixture(t, { factory: { platform: 'win32', spawnImpl: () => children.shift(), processKillImpl: (...args) => signals.push(args),
    execFileImpl: () => assert.fail('No process listing on Windows'), execFileSyncImpl: () => assert.fail('No process listing on Windows') } })
  await f.call('run_computer_command', { command: 'Start-Sleep 600', yieldMs: 0 })
  await f.call('run_computer_command', { command: 'Start-Sleep 600', yieldMs: 0 })
  f.controller.abort()
  assert.deepEqual(kills.slice(0, 2), [[432310, 'SIGKILL'], [432311, 'SIGKILL']], 'Stop is immediate and synchronous')
  const result = await f.executor.close()
  assert.equal(result.success, true); assert.equal(result.survivingProcessCount, 0)
  assert.deepEqual(signals, [], 'No signal is ever sent to a bare process number')
})

test('Windows: a shell that will not go away is reported, never called clean', async t => {
  const child = syntheticChild(432320); child.kill = () => true
  const f = await fixture(t, { limits: { termMs: 10, killMs: 10 }, factory: { platform: 'win32', spawnImpl: () => child } })
  await f.call('run_computer_command', { command: 'Start-Sleep 600', yieldMs: 0 })
  const result = await f.executor.close()
  assert.equal(result.success, false); assert.equal(result.survivingProcessCount, 1)
})

test('omitted yield waits through a real multi-second command with no running return or model polling', async t => {
  const f = await fixture(t)
  let settled = false
  const pending = f.call('run_computer_command', { command: 'printf "started\\n"; sleep 2.2; printf "finished\\n"' })
    .then(result => { settled = true; return result })
  await waitFor(() => f.spawns.length === 1)
  await pause(1250)
  assert.equal(settled, false, 'The one native call must not return a running job at the old one-second default.')
  const result = await pending
  assert.equal(result.status, 'completed'); assert.equal(result.exitCode, 0)
  assert.equal(result.output, 'started\nfinished\n'); assert.equal(f.spawns.length, 1)
  assert.ok(f.checks() >= 5, 'Native authority is rechecked during the long wait.')
  assert.ok(f.events.some(event => event.status === 'running' && event.durationMs >= 1800 && event.output.includes('started')))
  assert.ok(f.events.filter(event => event.status === 'completed').every(event => event.durationMs >= 2000))
  assert.equal(new Set(f.events.map(event => event.callId)).size, 1)
})

test('explicit long yields are accepted but never postpone a completed command', async t => {
  const f = await fixture(t)
  assert.equal(LIMITS.yieldMs, 300000)
  assert.equal(TOOLS.find(tool => tool.name === 'run_computer_command').inputSchema.properties.yieldMs.maximum, 300000)
  const started = performance.now()
  const result = await f.call('run_computer_command', { command: 'sleep 0.15; printf done', yieldMs: 120000 })
  assert.equal(result.status, 'completed'); assert.equal(result.output, 'done')
  assert.ok(performance.now() - started < 5000)
  assert.equal(f.spawns.length, 1)
})

test('omitted wait yield completes an intentionally yielded interactive job without repeated polls', async t => {
  const f = await fixture(t)
  const job = await f.call('run_computer_command', { command: 'read -r value; sleep 0.25; printf "%s" "$value"', yieldMs: 0 })
  assert.equal(job.status, 'running')
  await f.call('write_computer_input', { jobId: job.jobId, input: 'interactive-success\n', closeInput: true })
  let settled = false
  const pending = f.call('wait_computer_command', { jobId: job.jobId }).then(result => { settled = true; return result })
  await pause(100); assert.equal(settled, false)
  const result = await pending
  assert.equal(result.status, 'completed'); assert.equal(result.output, 'interactive-success'); assert.equal(f.spawns.length, 1)
  const page = await f.call('wait_computer_command', { jobId: job.jobId, offset: 0 })
  assert.equal(page.output, result.output)
})

test('silent waits emit bounded visible elapsed updates on the same activity row', async t => {
  const f = await fixture(t, { limits: { authorityPollMs: 20, outputProgressMs: 50, silentProgressMs: 100 } })
  const result = await f.call('run_computer_command', { command: 'sleep 0.45' })
  assert.equal(result.exitCode, 0)
  const running = f.events.filter(event => event.status === 'running')
  assert.ok(running.length >= 3 && running.length <= 7, `Unexpected activity volume: ${running.length}`)
  assert.ok(running.some(event => event.durationMs >= 200))
  assert.ok(running.every(event => event.output === '' && event.toolName === 'Shell command'))
  assert.equal(new Set(running.map(event => event.callId)).size, 1)
  for (let index = 1; index < running.length; index++) assert.ok(running[index].durationMs - running[index - 1].durationMs >= 80)
  assert.match(TOOLS.find(tool => tool.name === 'run_computer_command').description, /normally omit yieldMs/)
})

test('Stop interrupts a silent default wait and cleans its real owned command', async t => {
  const f = await fixture(t), pidFile = path.join(f.cwd, 'silent-stop-pid')
  const pending = f.call('run_computer_command', { command: `echo $$ > ${quote(pidFile)}; sleep 30` })
  await waitFor(async () => { try { return Number((await fs.readFile(pidFile, 'utf8')).trim()) > 0 } catch { return false } })
  const pid = Number((await fs.readFile(pidFile, 'utf8')).trim())
  await pause(50); f.controller.abort()
  const result = await pending
  assert.equal(result.code, 'CANCELLED'); assert.equal(result.possibleChanges, true)
  assert.equal((await f.executor.close()).success, true)
  await waitFor(async () => !await alive(pid)); assert.equal(f.spawns.length, 1)
})

test('periodic authority revocation stops a silent command without another model call or external abort', async t => {
  const f = await fixture(t, { limits: { authorityPollMs: 30 } }), pidFile = path.join(f.cwd, 'silent-revoke-pid')
  const pending = f.call('run_computer_command', { command: `echo $$ > ${quote(pidFile)}; sleep 30` })
  await waitFor(async () => { try { return Number((await fs.readFile(pidFile, 'utf8')).trim()) > 0 } catch { return false } })
  const pid = Number((await fs.readFile(pidFile, 'utf8')).trim())
  f.revoke()
  const result = await pending
  assert.equal(result.code, 'UNAUTHORIZED'); assert.equal(result.possibleChanges, true); assert.equal(f.controller.signal.aborted, false)
  assert.equal((await f.executor.close()).success, true)
  await waitFor(async () => !await alive(pid)); assert.equal(f.spawns.length, 1)
})

test('pending authority checks remain serialized, allow local progress, and are interrupted by Stop', async t => {
  const hold = defer(), entered = defer(); let started = false, simultaneous = 0, highest = 0
  const f = await fixture(t, { limits: { authorityPollMs: 20, outputProgressMs: 50, silentProgressMs: 100 },
    spawnImpl: (...args) => { started = true; return spawn(...args) },
    assertCurrent: async () => {
      if (!started) return
      simultaneous++; highest = Math.max(highest, simultaneous); entered.resolve()
      try { await hold.promise } finally { simultaneous-- }
    },
  })
  t.after(() => hold.resolve())
  const pending = f.call('run_computer_command', { command: 'printf "still-local\\n"; sleep 30' })
  await entered.promise; await pause(250)
  assert.equal(highest, 1)
  assert.ok(f.events.some(event => event.status === 'running' && event.durationMs >= 100))
  assert.ok(f.events.some(event => event.status === 'running' && event.output.includes('still-local')))
  const stoppedAt = performance.now(); f.controller.abort()
  const result = await pending
  assert.equal(result.code, 'CANCELLED'); assert.ok(performance.now() - stoppedAt < 1000)
  assert.equal((await f.executor.close()).success, true)
  hold.resolve(); await pause(20); assert.equal(f.spawns.length, 1)
})

test('a genuinely uncertain authority check stops work using the existing 60-second policy, not a command deadline', async t => {
  assert.equal(LIMITS.authorityCheckMs, 60000)
  let started = false
  const f = await fixture(t, { limits: { authorityCheckMs: 80, authorityPollMs: 20 },
    spawnImpl: (...args) => { started = true; return spawn(...args) },
    assertCurrent: () => started ? new Promise(() => {}) : undefined,
  })
  const result = await f.call('run_computer_command', { command: 'sleep 30' })
  assert.equal(result.code, 'AUTHORITY_UNCONFIRMED'); assert.equal(result.possibleChanges, true)
  assert.match(result.error, /authority-check window/)
  assert.equal((await f.executor.close()).success, true); assert.equal(f.spawns.length, 1)
})

test('periodic output activity remains bounded and redacts credentials split across writes', async t => {
  const f = await fixture(t, { limits: { authorityPollMs: 10, outputProgressMs: 50, silentProgressMs: 1000 } })
  const result = await f.call('run_computer_command', { command: node(`process.stdout.write('API_KEY=synthetic-');setTimeout(()=>process.stdout.write('split-credential\\n'),100);let n=0;const timer=setInterval(()=>{console.log('public-line-'+n++);if(n===10)clearInterval(timer)},30)`) })
  assert.equal(result.exitCode, 0)
  const running = f.events.filter(event => event.status === 'running')
  assert.ok(running.length <= 9)
  assert.doesNotMatch(JSON.stringify(f.events), /synthetic-split-credential|API_KEY=synthetic-/)
  assert.ok(f.events.some(event => event.output.includes('public-line')))
  assert.equal(new Set(f.events.map(event => event.callId)).size, 1)
})
