'use strict'
// Real children here are bounded synthetic Node writers in a private temp
// directory. They never launch ComfyUI, touch a project, or signal a user PID.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { spawn } = require('node:child_process')
const { once, EventEmitter } = require('node:events')
const { createRequire } = require('node:module')
const { createComfyConsoleLog, validRecord } = require('../electron/comfyConsoleLog.cjs')
const { ComfyLauncher } = require('../electron/comfyLauncher.js')

const temp = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-console-lifetime-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
const waitUntil = async (predicate, timeout = 8000) => {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('Timed out waiting for synthetic writer')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('console descriptors are private append-only files and retain live stream labels', async t => {
  const logDir = temp(t), lines = []
  const logs = createComfyConsoleLog({ logDir, onLine: (stream, text) => lines.push([stream, text]) })
  t.after(() => logs.stop())
  assert.equal(logs.stdio[0], 'ignore')
  for (const fd of logs.stdio.slice(1)) assert.ok(Number.isInteger(fd))
  fs.writeSync(logs.stdio[1], 'stdout line\n')
  fs.writeSync(logs.stdio[2], 'stderr progress\rnext progress\n')
  await logs.poll()
  assert.deepEqual(lines.filter(([stream]) => stream === 'stdout'), [['stdout', 'stdout line']])
  assert.deepEqual(lines.filter(([stream]) => stream === 'stderr'), [['stderr', 'stderr progress'], ['stderr', 'next progress']])
  if (process.platform !== 'win32') {
    for (const file of Object.values(logs.record)) assert.equal(fs.statSync(path.join(logDir, file)).mode & 0o777, 0o600)
  }
})

test('UTF-8 split writes and partial lines are bounded without corrupting normal text', async t => {
  const logDir = temp(t), lines = []
  const logs = createComfyConsoleLog({ logDir, carryChars: 12, onLine: (_, text) => lines.push(text) })
  t.after(() => logs.stop())
  const emoji = Buffer.from('🙂')
  fs.writeSync(logs.stdio[1], emoji.subarray(0, 2)); await logs.poll()
  fs.writeSync(logs.stdio[1], Buffer.concat([emoji.subarray(2), Buffer.from(' done\n')]))
  await logs.poll()
  assert.deepEqual(lines, ['🙂 done'])
  fs.writeSync(logs.stdio[1], 'x'.repeat(5000)); await logs.poll()
  fs.writeSync(logs.stdio[1], '\n'); await logs.poll()
  assert.equal(lines.at(-1), 'x'.repeat(12))
})

test('active file caps truncate the same inode and append descriptors remain writable', async t => {
  const logDir = temp(t), lines = [], warnings = []
  const logs = createComfyConsoleLog({ logDir, maxBytes: 32, readBytes: 32,
    onLine: (_, text) => lines.push(text), onWarning: text => warnings.push(text) })
  t.after(() => logs.stop())
  const filename = path.join(logDir, logs.record.stdout), inode = fs.statSync(filename).ino
  fs.writeSync(logs.stdio[1], `${'old\n'.repeat(20)}last line\n`)
  await logs.poll()
  assert.ok(lines.includes('last line'))
  assert.equal(fs.statSync(filename).size, 0)
  assert.equal(fs.statSync(filename).ino, inode)
  fs.writeSync(logs.stdio[1], 'after cap\n'); await logs.poll()
  assert.ok(lines.includes('after cap'))
  assert.equal(fs.readFileSync(filename, 'utf8'), 'after cap\n')
  assert.ok(warnings.some(text => text.includes('in place')))
})

test('bounded tails resume persisted console files after the old viewer closes', async t => {
  const logDir = temp(t), initial = createComfyConsoleLog({ logDir })
  fs.writeSync(initial.stdio[1], `${'old line\n'.repeat(30)}retained tail\n`)
  const record = initial.record
  await initial.stop()
  const lines = [], restored = createComfyConsoleLog({ logDir, record, readBytes: 64, onLine: (_, text) => lines.push(text) })
  t.after(() => restored.stop())
  await restored.poll()
  assert.ok(lines.includes('retained tail'))
  assert.ok(lines.length < 10)
  fs.appendFileSync(path.join(logDir, record.stdout), 'new process output\n')
  await restored.poll()
  assert.equal(lines.at(-1), 'new process output')
})

test('persisted console names cannot redirect the tailer outside application logs', async t => {
  const logDir = temp(t), logs = createComfyConsoleLog({ logDir })
  t.after(() => logs.stop())
  assert.deepEqual(validRecord(logDir, logs.record), logs.record)
  for (const record of [null, {}, { ...logs.record, stdout: `../${logs.record.stdout}` },
    { ...logs.record, stdout: path.join(logDir, logs.record.stdout) },
    { ...logs.record, stderr: logs.record.stdout }, { ...logs.record, stderr: 'comfyui-console-1-aaaaaaaaaaaa-stderr.log' }]) {
    assert.equal(validRecord(logDir, record), null)
  }
  const warnings = [], invalid = createComfyConsoleLog({ logDir, record: { stdout: '../outside', stderr: '../outside' }, onWarning: text => warnings.push(text) })
  assert.deepEqual(invalid.stdio, ['ignore', 'ignore', 'ignore'])
  assert.equal(invalid.record, null)
  assert.equal(warnings.length, 1)
  await invalid.stop()
})

test('unavailable console storage falls back to ignore, never parent-owned pipes', async t => {
  const root = temp(t), logDir = path.join(root, 'not-a-directory'), warnings = []
  fs.writeFileSync(logDir, 'fixture')
  const logs = createComfyConsoleLog({ logDir, onWarning: text => warnings.push(text) })
  assert.deepEqual(logs.stdio, ['ignore', 'ignore', 'ignore'])
  assert.equal(logs.record, null)
  assert.match(warnings[0], /capture is unavailable.*survive Velorn closing/)
  await logs.stop()
})

test('launcher state persists only console basenames and a resumed viewer receives fresh logs', async t => {
  const logDir = temp(t), stateFilePath = path.join(logDir, 'state.json')
  const first = new ComfyLauncher({ logDir, stateFilePath })
  const consoleLog = await first._prepareConsoleLog()
  fs.writeSync(consoleLog.stdio[1], 'before reload\n')
  await first._writeStateFile({ pid: 424242, identity: 'fixture', consoleLogs: consoleLog.record })
  await first._stopConsoleLog()
  const second = new ComfyLauncher({ logDir, stateFilePath })
  const record = await second._readStateFile()
  assert.deepEqual(record.consoleLogs, consoleLog.record)
  const resumed = await second._prepareConsoleLog(record.consoleLogs)
  t.after(() => second._stopConsoleLog())
  fs.appendFileSync(path.join(logDir, record.consoleLogs.stderr), 'after reload\n')
  await resumed.poll()
  assert.ok(second.getLogs().some(line => line.stream === 'stderr' && line.text === 'after reload'))
})

test('detaching a reclaimed process stops its viewer without signaling or changing durable logs', async t => {
  const logDir = temp(t), launcher = new ComfyLauncher({ logDir })
  const logs = await launcher._prepareConsoleLog()
  fs.writeSync(logs.stdio[1], 'reclaimed output\n')
  logs.closeDescriptors()
  launcher._child = null; launcher._pid = 424242; launcher._ownership = 'ours'; launcher._state = 'running'
  assert.deepEqual(await launcher.detach(), { detached: true, pid: 424242 })
  assert.equal(launcher._consoleLog, null)
  assert.equal(launcher.getState().ownership, 'external')
  assert.match(fs.readFileSync(path.join(logDir, logs.record.stdout), 'utf8'), /reclaimed output/)
})

function syntheticStart(t) {
  const logDir = temp(t), launcherScript = path.join(logDir, 'never-executed.sh')
  fs.writeFileSync(launcherScript, '# synthetic fixture only')
  const launcher = new ComfyLauncher({ logDir, getHttpBase: () => '', getConfig: () => ({ launcherScript }) })
  launcher._installStdoutGuard = async () => {}
  launcher._openLogFile = () => {}; launcher._closeLogFile = () => {}
  launcher._startProbing = () => {}; launcher._readProcessIdentity = async () => 'fixture'
  launcher._writeStateFile = async () => {}; launcher._clearStateFile = async () => {}
  return launcher
}

test('spawn throw and asynchronous spawn errors close parent descriptors and console viewers', async t => {
  for (const asynchronous of [false, true]) {
    const launcher = syntheticStart(t), child = new EventEmitter()
    let descriptors
    launcher._spawnLauncher = async () => {
      descriptors = launcher._consoleLog.stdio.slice(1)
      if (!asynchronous) throw Error('Synthetic spawn failure')
      return child
    }
    const result = await launcher.start()
    if (asynchronous) {
      child.emit('error', Object.assign(Error('Synthetic missing executable'), { code: 'ENOENT' }))
      await new Promise(resolve => setImmediate(resolve))
      await waitUntil(() => launcher._consoleLog === null)
    } else assert.equal(result.success, false)
    assert.equal(launcher._consoleLog, null)
    assert.equal(launcher.getState().state, 'idle')
    for (const fd of descriptors) assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' })
  }
})

test('an old exit finishing its console flush cannot erase a replacement launcher process', async t => {
  const launcher = syntheticStart(t), child = new EventEmitter()
  child.pid = 424242
  launcher._spawnLauncher = async () => child
  await launcher.start()
  const oldConsole = launcher._consoleLog
  let release
  const stopped = oldConsole.stop.bind(oldConsole)
  oldConsole.stop = async () => { await new Promise(resolve => { release = resolve }); return stopped() }
  child.emit('exit', 0, null)
  assert.equal(typeof release, 'function')
  const replacement = new EventEmitter(), nextConsole = { stop: async () => {} }
  launcher._child = replacement; launcher._pid = 525252; launcher._ownership = 'ours'
  launcher._state = 'running'; launcher._consoleLog = nextConsole
  release()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(launcher._child, replacement)
  assert.equal(launcher._consoleLog, nextConsole)
  assert.equal(launcher.getState().pid, 525252)
  assert.equal(launcher.getState().state, 'running')
  await stopped()
})

function platformLauncher(platform, portable) {
  const filename = path.resolve(__dirname, '../electron/comfyLauncher.js')
  const realRequire = createRequire(filename), module = { exports: {} }, calls = []
  const source = fs.readFileSync(filename, 'utf8')
  vm.runInNewContext(source, {
    module, exports: module.exports, __dirname: path.dirname(filename), __filename: filename,
    require(name) {
      if (name === 'fs') return { promises: {}, existsSync: () => portable }
      if (name === 'child_process') return { spawn(command, args, options) {
        calls.push({ command, args: [...args], options }); return new EventEmitter()
      } }
      return realRequire(name)
    },
    process: { platform, env: {}, pid: 424242 }, console, URL, Buffer, setTimeout, clearTimeout,
  }, { filename })
  const launcher = new module.exports.ComfyLauncher({ getHttpBase: () => 'http://127.0.0.1:18189' })
  launcher._consoleLog = { stdio: ['ignore', 801, 802] }
  return { launcher, calls }
}

test('Windows portable, batch and executable plus Linux/macOS script paths inherit durable descriptors', async () => {
  for (const [platform, portable, script, expected] of [
    ['win32', true, '/fixture/run.bat', 'python.exe'], ['win32', false, '/fixture/run.bat', 'cmd.exe'],
    ['win32', false, '/fixture/python.exe', 'python.exe'], ['linux', false, '/fixture/run.sh', 'bash'],
    ['darwin', false, '/fixture/run.sh', 'bash'], ['linux', true, '/fixture/run.sh', 'python3'],
  ]) {
    const { launcher, calls } = platformLauncher(platform, portable)
    await launcher._spawnLauncher(script, { extraArgs: '', disableAutoLaunch: true })
    assert.equal(calls.length, 1)
    assert.equal(path.basename(calls[0].command), expected)
    assert.deepEqual([...calls[0].options.stdio], ['ignore', 801, 802])
    assert.equal(calls[0].options.detached, true)
    assert.equal(calls[0].options.env.PYTHONUNBUFFERED, '1')
    assert.equal(calls[0].options.env.PYTHONIOENCODING, 'utf-8')
  }
})

for (const exitKind of ['detach', 'crash']) test(`real child stdout/stderr still flush after its launcher parent ${exitKind}`, { timeout: 15000 }, async t => {
  const logDir = temp(t), trigger = path.join(logDir, 'continue'), done = path.join(logDir, 'done.json')
  const launcherModule = path.resolve(__dirname, '../electron/comfyLauncher.js')
  const childSource = `
    const fs = require('node:fs');
    const [trigger, done] = process.argv.slice(1);
    const deadline = Date.now() + 9000;
    fs.writeSync(1, 'before stdout\\n'); fs.writeSync(2, 'before stderr\\n');
    const timer = setInterval(() => {
      if (!fs.existsSync(trigger) && Date.now() < deadline) return;
      clearInterval(timer);
      try {
        fs.writeSync(1, 'after stdout 🙂\\n'); fs.fsyncSync(1);
        fs.writeSync(2, 'after stderr\\n'); fs.fsyncSync(2);
        fs.writeFileSync(done, JSON.stringify({ success: true })); process.exit(0);
      } catch (error) { fs.writeFileSync(done, JSON.stringify({ success: false, code: error.code })); process.exit(1); }
    }, 10);
  `
  const parentSource = `
    const { spawn } = require('node:child_process');
    const { ComfyLauncher } = require(${JSON.stringify(launcherModule)});
    (async () => {
      const launcher = new ComfyLauncher({ logDir: ${JSON.stringify(logDir)} });
      const logs = await launcher._prepareConsoleLog();
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}, ${JSON.stringify(trigger)}, ${JSON.stringify(done)}],
        { detached: true, stdio: logs.stdio });
      logs.closeDescriptors();
      launcher._child = child; launcher._pid = child.pid; launcher._ownership = 'ours'; launcher._state = 'running';
      child.unref();
      process.send({ pid: child.pid, record: logs.record });
      process.on('message', async () => { await launcher.detach(); process.disconnect(); process.exit(0); });
    })().catch(error => { console.error(error); process.exit(1); });
  `
  const parent = spawn(process.execPath, ['-e', parentSource], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  t.after(() => { if (parent.exitCode === null && parent.signalCode === null) parent.kill() })
  let errors = ''; parent.stderr.on('data', buffer => { errors += buffer })
  const [message] = await once(parent, 'message')
  assert.ok(message.pid > 1)
  const exited = once(parent, 'exit')
  if (exitKind === 'detach') parent.send('detach')
  else parent.kill('SIGKILL')
  await exited
  assert.equal(errors, '')
  fs.writeFileSync(trigger, 'go')
  await waitUntil(() => fs.existsSync(done))
  assert.deepEqual(JSON.parse(fs.readFileSync(done, 'utf8')), { success: true })
  assert.match(fs.readFileSync(path.join(logDir, message.record.stdout), 'utf8'), /after stdout 🙂/)
  assert.match(fs.readFileSync(path.join(logDir, message.record.stderr), 'utf8'), /after stderr/)
})
