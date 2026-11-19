'use strict'

// Real Windows behaviour of Velo's computer tools: Windows PowerShell 5.1 and
// the job object that makes Stop reliable. Runs only on Windows (for example
// on a GitHub Windows runner); on Linux and macOS this file does nothing.
if (process.platform !== 'win32') return

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { createVeloComputerTools, WINDOWS_TOOLS } = require('../electron/veloComputerTools.cjs')
const { WINDOWS_NOT_CONTAINED_EXIT } = require('../electron/veloComputerProcesses.cjs')

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const unpack = result => ({ ...JSON.parse(result.content[0].text), isError: result.isError === true })
// PowerShell single-quoted text: only a single quote needs doubling.
const ps = value => `'${String(value).replaceAll("'", "''")}'`
const NODE = process.execPath
const IDLE = 'setInterval(()=>{},1000)'

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-computer-tools-')))
  const cwd = path.join(root, 'project'); await fs.mkdir(cwd)
  const controller = new AbortController(), events = [], spawns = []
  let valid = true
  // Without the runner's prepared PowerShell module cache: the slowest honest case.
  const { PSModuleAnalysisCachePath: _cache, ...ordinary } = process.env
  const environment = { ...ordinary, VELO_SERVICE_TOKEN: 'synthetic-service-secret', OPENAI_API_KEY: 'synthetic-provider-key',
    NODE_OPTIONS: '--invalid-synthetic-option', ...options.environment }
  const executor = createVeloComputerTools({ cwd, signal: controller.signal,
    assertCurrent: async () => { if (!valid) throw new Error('synthetic native credential must not leak') },
    environment, onEvent: event => events.push(event),
    spawnImpl: (...args) => { spawns.push(args); return spawn(...args) },
    limits: { termMs: 50, killMs: 500, ...options.limits } })
  t.after(async () => { await executor.close(); await pause(100); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {}) })
  return { root, cwd, controller, events, spawns, executor, call: async (name, args) => unpack(await executor.callTool(name, args)), revoke: () => { valid = false } }
}
async function complete(f, command, extra = {}) {
  let result = await f.call('run_computer_command', { command, yieldMs: 20000, ...extra })
  const chunks = [result.output || '']
  for (let attempt = 0; result.status === 'running' && attempt < 20; attempt++) {
    result = await f.call('wait_computer_command', { jobId: result.jobId, yieldMs: 2000 })
    chunks.push(result.output || '')
  }
  return { ...result, allOutput: chunks.join('') }
}
async function waitFor(predicate, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await predicate()) return; await pause(50) }
  assert.fail('Timed out waiting for fixture state')
}
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const numbers = async file => { try { return (await fs.readFile(file, 'utf8')).split(/\s+/).map(Number).filter(value => value > 0) } catch { return [] } }
// A small tree: a program started by PowerShell, which starts a detached
// program of its own. Each writes its process number into one file.
async function treeCommand(f, pidFile) {
  const leaf = path.join(f.root, 'leaf.js'), middle = path.join(f.root, 'middle.js')
  await fs.writeFile(leaf, `require('fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');${IDLE}`)
  await fs.writeFile(middle, `require('fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');
    require('child_process').spawn(process.execPath, [${JSON.stringify(leaf)}], { detached: true, stdio: 'ignore' }).unref();${IDLE}`)
  return `$child = Start-Process -FilePath ${ps(NODE)} -ArgumentList ${ps(`"${middle}"`)} -PassThru -WindowStyle Hidden; Add-Content -Path ${ps(pidFile)} -Value $PID; Start-Sleep -Seconds 600`
}
async function startedTree(f, pidFile) { await waitFor(async () => (await numbers(pidFile)).length >= 3, 30000); return numbers(pidFile) }

test('PowerShell 5.1 runs the command; quotes, pipes and Unicode arrive unchanged; output is UTF-8', async t => {
  const f = await fixture(t)
  const result = await complete(f, `$PSVersionTable.PSVersion.Major; Write-Output "it's ""quoted"" & tricky | 100%"; Write-Output 'héllo ✓ 日本'; 1..3 | ForEach-Object { $_ * 2 }`)
  assert.equal(result.exitCode, 0, result.allOutput); assert.equal(result.status, 'completed')
  assert.deepEqual(result.allOutput.split(/\r?\n/).filter(Boolean), ['5', `it's "quoted" & tricky | 100%`, 'héllo ✓ 日本', '2', '4', '6'])
  assert.match(f.spawns[0][0], /WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
  assert.equal(f.executor.tools, WINDOWS_TOOLS)
})

test('ordinary Windows environment is kept, without application keys or the command text', async t => {
  const f = await fixture(t)
  const result = await complete(f, `"profile=$env:USERPROFILE"; "token=[$env:VELO_SERVICE_TOKEN]"; "key=[$env:OPENAI_API_KEY]"; "node=[$env:NODE_OPTIONS]"; "command=[$env:VELORN_COMMAND]"; "where=$((Get-Location).Path)"; (Get-Command cmd.exe).Name`)
  assert.equal(result.exitCode, 0, result.allOutput)
  const lines = result.allOutput.split(/\r?\n/).filter(Boolean)
  assert.equal(lines[0], `profile=${process.env.USERPROFILE}`)
  assert.deepEqual(lines.slice(1, 5), ['token=[]', 'key=[]', 'node=[]', 'command=[]'])
  assert.equal(lines[5].toLowerCase(), `where=${f.cwd}`.toLowerCase()); assert.equal(lines[6].toLowerCase(), 'cmd.exe')
  assert.doesNotMatch(f.spawns[0][1].join(' '), /USERPROFILE/, 'The command is not on the command line')
})

test('exit codes are truthful: script exit, failing program, PowerShell error, and success', async t => {
  const f = await fixture(t)
  const script = await complete(f, 'Write-Output partial; exit 17')
  assert.equal(script.exitCode, 17, script.allOutput); assert.equal(script.success, false); assert.match(script.allOutput, /partial/)
  const program = await complete(f, 'cmd /c exit 23')
  assert.equal(program.exitCode, 23, program.allOutput); assert.equal(program.success, false)
  const thrown = await complete(f, `Write-Output before; throw 'synthetic failure'`)
  assert.equal(thrown.exitCode, 1, thrown.allOutput); assert.match(thrown.allOutput, /before/); assert.match(thrown.allOutput, /synthetic failure/)
  const syntax = await complete(f, 'if (')
  assert.equal(syntax.exitCode, 1, syntax.allOutput)
  const recovered = await complete(f, 'cmd /c exit 5; Write-Output recovered')
  assert.equal(recovered.exitCode, 0, recovered.allOutput); assert.match(recovered.allOutput, /recovered/)
  const stderr = await complete(f, `cmd /c "echo to-stderr 1>&2"; Write-Output to-stdout`)
  assert.equal(stderr.exitCode, 0, stderr.allOutput); assert.match(stderr.allOutput, /to-stderr/); assert.match(stderr.allOutput, /to-stdout/)
  assert.doesNotMatch(stderr.allOutput, /CLIXML/, 'No PowerShell progress noise in the output')
  assert.equal(f.spawns.length, 6, 'Nothing is retried')
})

test('a command starts promptly even without a prepared PowerShell module cache', async t => {
  const f = await fixture(t), started = Date.now()
  const result = await complete(f, 'Get-Date -Format o; Get-ChildItem Env:SystemRoot | ForEach-Object { $_.Value }')
  assert.equal(result.exitCode, 0, result.allOutput)
  const elapsed = Date.now() - started
  console.log(`# one PowerShell command took ${elapsed} ms`)
  assert.ok(elapsed < 8000, `Start-up took ${elapsed} ms`)
})

test('interactive input reaches the command and it finishes without closing input first', async t => {
  const f = await fixture(t)
  const quick = await complete(f, 'Write-Output no-input-needed')
  assert.equal(quick.exitCode, 0, quick.allOutput); assert.match(quick.allOutput, /no-input-needed/)
  const job = await f.call('run_computer_command', { command: `$line = [Console]::In.ReadLine(); "received:$line"; [Console]::In.ReadToEnd()`, yieldMs: 0 })
  assert.equal(job.status, 'running')
  const sent = await f.call('write_computer_input', { jobId: job.jobId, input: 'hello ✓\nsecond\n', closeInput: true })
  assert.equal(sent.stdinClosed, true)
  const done = await f.call('wait_computer_command', { jobId: job.jobId, yieldMs: 20000, offset: 0 })
  assert.equal(done.status, 'completed', done.output); assert.equal(done.exitCode, 0)
  assert.deepEqual(done.output.split(/\r?\n/).filter(Boolean), ['received:hello ✓', 'second'])
})

test('Stop ends the shell, the program it started, and that program\'s detached child', async t => {
  const f = await fixture(t), pidFile = path.join(f.root, 'pids.txt')
  const job = await f.call('run_computer_command', { command: await treeCommand(f, pidFile), yieldMs: 0 })
  assert.equal(job.status, 'running')
  const pids = await startedTree(f, pidFile)
  assert.equal(pids.length, 3); assert.ok(pids.every(alive), 'Shell, child and detached grandchild are all running')
  f.controller.abort()
  const result = await f.executor.close()
  assert.equal(result.success, true, JSON.stringify(result))
  await waitFor(() => !pids.some(alive))
  assert.equal((await f.call('run_computer_command', { command: 'Write-Output late' })).code, 'CANCELLED')
  assert.equal(f.spawns.length, 1)
})

test('revoked permission stops a silent running command and its tree', async t => {
  const f = await fixture(t, { limits: { authorityPollMs: 50 } }), pidFile = path.join(f.root, 'pids.txt')
  const pending = f.call('run_computer_command', { command: await treeCommand(f, pidFile) })
  const pids = await startedTree(f, pidFile)
  f.revoke()
  const result = await pending
  assert.equal(result.code, 'UNAUTHORIZED'); assert.equal(result.possibleChanges, true)
  assert.equal((await f.executor.close()).success, true)
  await waitFor(() => !pids.some(alive))
})

test('when the command itself ends, programs it left behind are ended with it', async t => {
  const f = await fixture(t), pidFile = path.join(f.root, 'pids.txt'), leaf = path.join(f.root, 'left-behind.js')
  await fs.writeFile(leaf, `require('fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');${IDLE}`)
  const result = await complete(f, `Start-Process -FilePath ${ps(NODE)} -ArgumentList ${ps(`"${leaf}"`)} -WindowStyle Hidden; while (-not (Test-Path ${ps(pidFile)})) { Start-Sleep -Milliseconds 100 }; Write-Output started`)
  assert.equal(result.exitCode, 0, result.allOutput); assert.match(result.allOutput, /started/)
  const [pid] = await numbers(pidFile)
  assert.ok(pid > 0); await waitFor(() => !alive(pid))
})

for (const ending of ['a normal exit', 'being killed outright']) {
  test(`Velorn ending by ${ending} leaves nothing running`, async t => {
    const f = await fixture(t), pidFile = path.join(f.root, 'pids.txt'), host = path.join(f.root, 'host.js')
    const command = await treeCommand(f, pidFile)
    await fs.writeFile(host, `const { createVeloComputerTools } = require(${JSON.stringify(require.resolve('../electron/veloComputerTools.cjs'))})
      const tools = createVeloComputerTools({ cwd: ${JSON.stringify(f.cwd)}, signal: new AbortController().signal, assertCurrent: () => true })
      tools.callTool('run_computer_command', { command: ${JSON.stringify(command)}, yieldMs: 0 })
      process.stdin.on('data', () => process.exit(0)); setInterval(() => {}, 1000)`)
    const child = spawn(NODE, [host], { stdio: ['pipe', 'ignore', 'inherit'] })
    t.after(() => { try { child.kill() } catch {} })
    const pids = await startedTree(f, pidFile)
    assert.ok(pids.every(alive))
    if (ending === 'a normal exit') child.stdin.write('quit\n'); else child.kill('SIGKILL')
    await waitFor(() => !pids.some(alive))
  })
}

test('files: create, replace, append, paged and binary reads; folders are refused', async t => {
  const f = await fixture(t), target = path.join(f.root, 'external.bin')
  assert.equal((await f.call('write_computer_file', { path: target, content: 'first', mode: 'create' })).bytesWritten, 5)
  assert.equal((await f.call('write_computer_file', { path: target, content: 'lost', mode: 'create' })).code, 'EEXIST')
  assert.equal((await f.call('write_computer_file', { path: target, content: 'second', mode: 'replace' })).success, true)
  assert.equal((await f.call('write_computer_file', { path: target, content: 'AAH/', encoding: 'base64', mode: 'append' })).success, true)
  const read = await f.call('read_computer_file', { path: target, offset: 6, maxBytes: 3, encoding: 'base64' })
  assert.equal(read.content, 'AAH/'); assert.equal(read.eof, true)
  const first = await f.call('read_computer_file', { path: target, maxBytes: 4 })
  assert.equal(first.content, 'seco'); assert.equal(first.eof, false); assert.equal(first.path.toLowerCase(), target.toLowerCase())
  assert.equal((await f.call('read_computer_file', { path: f.cwd })).code, 'NOT_REGULAR_FILE')
  assert.equal((await f.call('write_computer_file', { path: f.cwd, content: 'x', mode: 'replace' })).code, 'NOT_REGULAR_FILE')
  assert.equal((await f.call('write_computer_file', { path: 'missing.txt', content: 'x', mode: 'append' })).code, 'ENOENT')
  const relative = await f.call('write_computer_file', { path: 'in-project.txt', content: 'héllo', mode: 'create' })
  assert.equal(relative.success, true); assert.equal(await fs.readFile(path.join(f.cwd, 'in-project.txt'), 'utf8'), 'héllo')
})

test('a missing PowerShell is an explicit failure, not a hang or a retry', async t => {
  const f = await fixture(t, { environment: { SystemRoot: path.join(os.tmpdir(), 'velorn-no-such-windows') } })
  const result = await complete(f, 'Write-Output never')
  assert.equal(result.success, false); assert.doesNotMatch(JSON.stringify(result), /never\\r/)
  assert.equal(f.spawns.length, 1); assert.ok(WINDOWS_NOT_CONTAINED_EXIT > 0)
})
