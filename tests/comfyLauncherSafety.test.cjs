// All process discovery, identities, signals and clocks are injected doubles.
// These regressions never launch an app, open a user profile or signal a real PID.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createRequire } = require('node:module')
const { createProcessSafety, parseLsofPid, parseNetstatPid } = require('../electron/comfyProcessSafety.cjs')

const PID = 424242
const PORT = 18188
const procStat = (start = '123456', name = 'python (worker) odd)') =>
  `${PID} (${name}) S ${Array(18).fill('0').join(' ')} ${start} 0 0 0\n`

function fakeSafety(overrides = {}) {
  const calls = [], signals = [], reads = []
  const { sleep: sleepHook, ...injections } = overrides
  let clock = 0, alive = true, start = '123456', boot = 'synthetic-boot-id'
  const safety = createProcessSafety({
    platform: 'linux',
    async runProcess(command, args, options) {
      calls.push({ command, args, options })
      return { ok: true, stdout: `p${PID}\n` }
    },
    async readFile(filename) {
      reads.push(filename)
      if (filename === `/proc/${PID}/stat` && alive) return procStat(start)
      if (filename === '/proc/sys/kernel/random/boot_id') return `${boot}\n`
      throw Object.assign(new Error('Not found'), { code: 'ENOENT' })
    },
    signal(pid, kind) {
      assert.equal(pid, PID, 'Only the synthetic PID may be signaled')
      if (!alive) throw Object.assign(new Error('No process'), { code: 'ESRCH' })
      signals.push([pid, kind])
      if (kind === 'SIGKILL') alive = false
    },
    async sleep(ms) { clock += ms; await sleepHook?.(ms) },
    now: () => clock,
    ...injections,
  })
  return { safety, calls, signals, reads,
    destructive: () => signals.filter(([, kind]) => kind !== 0),
    setAlive: value => { alive = value }, setStart: value => { start = value }, setBoot: value => { boot = value },
  }
}

test('lsof accepts only one unique valid PID and rejects ambiguous listeners', () => {
  assert.equal(parseLsofPid(`p${PID}\np${PID}\n`), PID)
  for (const output of ['', 'garbage', 'p0\n', 'p-1\n', 'p1.5\n', 'p424242junk\n', 'p9007199254740993\n', `p${PID}\np123\n`]) {
    assert.equal(parseLsofPid(output), null, JSON.stringify(output))
  }
})

test('POSIX lookup intersects the exact TCP port with LISTEN instead of broad OR selectors', async () => {
  for (const platform of ['linux', 'darwin']) {
    const fixture = fakeSafety({ platform })
    assert.equal(await fixture.safety.findPidForPort(PORT), PID)
    assert.equal(fixture.calls.length, 1)
    assert.equal(fixture.calls[0].command, 'lsof')
    assert.deepEqual(fixture.calls[0].args, ['-nP', '-a', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-Fp'])
    assert.ok(fixture.calls[0].options.timeoutMs > 0 && fixture.calls[0].options.timeoutMs <= 10000)
  }
})

test('listener lookup fails closed for invalid ports, command errors and partial failed output', async () => {
  const fixture = fakeSafety()
  for (const port of [0, -1, 65536, 1.5, NaN, Infinity, '18188; echo unsafe']) {
    assert.equal(await fixture.safety.findPidForPort(port), null)
  }
  assert.equal(fixture.calls.length, 0)
  for (const runProcess of [
    async () => ({ ok: false, stdout: `p${PID}\n` }),
    async () => { throw Object.assign(new Error('Command unavailable'), { code: 'ENOENT' }) },
    async () => ({ ok: false, timedOut: true, stdout: `p${PID}\n` }),
    async () => ({ ok: true, stdout: `p${PID}\np123\n` }),
  ]) assert.equal(await fakeSafety({ runProcess }).safety.findPidForPort(PORT), null)
})

test('netstat matches only exact local TCP LISTENING ports, including IPv6', () => {
  const irrelevant = [
    `  TCP 127.0.0.1:${PORT + 1} 0.0.0.0:0 LISTENING 111`,
    `  TCP 127.0.0.1:5555 127.0.0.1:${PORT} ESTABLISHED 222`,
    `  TCP 127.0.0.1:${PORT} 127.0.0.1:9999 ESTABLISHED 333`,
    `  UDP 0.0.0.0:${PORT} *:* 444`,
  ].join('\r\n')
  assert.equal(parseNetstatPid(irrelevant, PORT), null)
  const matching = `${irrelevant}\r\n  TCP 0.0.0.0:${PORT} 0.0.0.0:0 LISTENING ${PID}\r\n  TCP [::]:${PORT} [::]:0 LISTENING ${PID}\r\n`
  assert.equal(parseNetstatPid(matching, PORT), PID)
  assert.equal(parseNetstatPid(`${matching}  TCP 127.0.0.1:${PORT} 0.0.0.0:0 LISTENING 123\n`, PORT), null)
  assert.equal(parseNetstatPid(`  TCP 192.168.1.10:${PORT} 0.0.0.0:0 LISTENING 123\n`, PORT), null)
  for (const invalid of ['0', '-1', '1.5', '424242junk', '9007199254740993']) {
    assert.equal(parseNetstatPid(`  TCP 0.0.0.0:${PORT} 0.0.0.0:0 LISTENING ${invalid}\n`, PORT), null)
  }
})

test('Windows lookup uses bounded netstat discovery and rejects multiple owners', async () => {
  const calls = []
  const safety = fakeSafety({ platform: 'win32', async runProcess(command, args, options) {
    calls.push({ command, args, options })
    return { ok: true, stdout: `  TCP [::]:${PORT} [::]:0 LISTENING ${PID}\n` }
  } }).safety
  assert.equal(await safety.findPidForPort(PORT), PID)
  assert.equal(calls[0].command, 'netstat.exe')
  assert.deepEqual(calls[0].args, ['-ano', '-p', 'TCP'])
  assert.ok(calls[0].options.timeoutMs > 0)
})

test('Linux identity survives spaces and closing parentheses in comm but detects PID reuse and reboot', async () => {
  const fixture = fakeSafety()
  const initial = await fixture.safety.readIdentity(PID)
  assert.ok(initial)
  assert.deepEqual(await fixture.safety.readIdentity(PID), initial)
  fixture.setStart('123457')
  assert.notDeepEqual(await fixture.safety.readIdentity(PID), initial)
  fixture.setStart('123456'); fixture.setBoot('different-synthetic-boot')
  assert.notDeepEqual(await fixture.safety.readIdentity(PID), initial)
  assert.ok(fixture.reads.includes(`/proc/${PID}/stat`))
  assert.ok(fixture.reads.includes('/proc/sys/kernel/random/boot_id'))
})

test('unreadable or malformed identities and invalid PIDs fail closed', async () => {
  for (const readFile of [async () => { throw new Error('Permission denied') }, async () => '', async () => 'malformed']) {
    assert.equal(await fakeSafety({ readFile }).safety.readIdentity(PID), null)
  }
  const fixture = fakeSafety()
  for (const pid of [0, -1, 1.5, NaN, Infinity, '424242; unsafe']) assert.equal(await fixture.safety.readIdentity(pid), null)
  assert.deepEqual(fixture.reads, [])
})

test('termination refuses missing/stale identity or an absent/false/throwing owner verifier', async () => {
  for (const mode of ['missing', 'stale', 'absent-verifier', 'false-verifier', 'throwing-verifier']) {
    const fixture = fakeSafety()
    const identity = await fixture.safety.readIdentity(PID)
    if (mode === 'stale') fixture.setStart('changed-start-time')
    const options = { identity, verifyOwner: async () => true }
    if (mode === 'missing') options.identity = null
    if (mode === 'absent-verifier') delete options.verifyOwner
    if (mode === 'false-verifier') options.verifyOwner = async () => false
    if (mode === 'throwing-verifier') options.verifyOwner = async () => { throw new Error('Ownership probe failed') }
    await assert.rejects(() => fixture.safety.terminatePid(PID, options), undefined, mode)
    assert.deepEqual(fixture.destructive(), [], mode)
  }
})

test('termination rechecks ownership before escalation, with fake time and signals only', async () => {
  const fixture = fakeSafety()
  const identity = await fixture.safety.readIdentity(PID)
  let checks = 0
  await fixture.safety.terminatePid(PID, { identity, verifyOwner: async () => { checks++; return true } })
  assert.deepEqual(fixture.destructive(), [[PID, 'SIGTERM'], [PID, 'SIGKILL']])
  assert.ok(checks >= 2, 'Both destructive signals require fresh ownership verification')
})

test('ownership or process identity changing after TERM prevents KILL', async () => {
  for (const mode of ['ownership', 'identity']) {
    let fixture, checks = 0
    fixture = fakeSafety({ async sleep() { if (mode === 'identity') fixture.setStart('123457') } })
    const identity = await fixture.safety.readIdentity(PID)
    const stop = fixture.safety.terminatePid(PID, {
      identity, verifyOwner: async () => { checks++; return mode !== 'ownership' || checks === 1 },
    })
    if (mode === 'ownership') await assert.rejects(() => stop)
    else await stop // The original exited and the reused PID must not be signaled.
    assert.deepEqual(fixture.destructive(), [[PID, 'SIGTERM']], mode)
  }
})

test('a process that exits after TERM is not sent KILL', async () => {
  let fixture
  fixture = fakeSafety({ async sleep() { fixture.setAlive(false) } })
  const identity = await fixture.safety.readIdentity(PID)
  await fixture.safety.terminatePid(PID, { identity, verifyOwner: async () => true })
  assert.deepEqual(fixture.destructive(), [[PID, 'SIGTERM']])
})

test('macOS and Windows identities require successful bounded creation-time queries', async () => {
  for (const [platform, value, prefix] of [
    ['darwin', 'Fri Sep 18 12:34:56 2026 /synthetic/python', 'darwin:'],
    ['win32', '639253028960000000', 'win32:'],
  ]) {
    const calls = []
    const fixture = fakeSafety({ platform, async runProcess(command, args, options) {
      calls.push({ command, args, options }); return { ok: true, stdout: ` ${value}\n` }
    } })
    assert.equal(await fixture.safety.readIdentity(PID), prefix + value)
    assert.ok(calls[0].options.timeoutMs > 0 && calls[0].options.timeoutMs <= 10000)
    if (platform === 'darwin') {
      assert.equal(calls[0].command, 'ps')
      assert.deepEqual(calls[0].args, ['-p', String(PID), '-o', 'lstart=', '-o', 'comm='])
    } else {
      assert.equal(calls[0].command, 'powershell.exe')
      assert.ok(calls[0].args.includes('-NoProfile') && calls[0].args.includes('-NonInteractive'))
      assert.match(calls[0].args.at(-1), new RegExp(`ProcessId = ${PID}`))
      assert.match(calls[0].args.at(-1), /CreationDate/)
    }
    for (const result of [{ ok: false, stdout: value }, { ok: true, stdout: '' }, { ok: true, stdout: 'malformed' }]) {
      assert.equal(await fakeSafety({ platform, runProcess: async () => result }).safety.readIdentity(PID), null)
    }
  }
})

test('identity permission loss while a PID still exists cannot be mistaken for successful exit', async () => {
  let accessible = true, clock = 0
  const signals = []
  const fixture = fakeSafety({
    async readFile(filename) {
      if (!accessible) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
      return filename.endsWith('/stat') ? procStat() : 'synthetic-boot'
    },
    signal(pid, kind) { signals.push([pid, kind]) },
    async sleep(ms) { clock += ms; accessible = false }, now: () => clock,
  })
  const identity = await fixture.safety.readIdentity(PID)
  await assert.rejects(() => fixture.safety.terminatePid(PID, { identity, verifyOwner: async () => true }))
  assert.deepEqual(signals.filter(([, kind]) => kind !== 0), [[PID, 'SIGTERM']])
})

test('Windows taskkill is never invoked without freshly verified identity and ownership', async () => {
  for (const allowed of [false, true]) {
    let alive = true
    const commands = []
    const fixture = fakeSafety({ platform: 'win32',
      async runProcess(command, args) {
        commands.push({ command, args })
        if (command === 'powershell.exe') return { ok: alive, stdout: alive ? '639253028960000000' : '' }
        assert.equal(command, 'taskkill.exe'); alive = false; return { ok: true, stdout: '' }
      },
      signal(pid, kind) {
        assert.equal(kind, 0, 'No POSIX destructive signal on Windows')
        if (!alive) throw Object.assign(new Error('No process'), { code: 'ESRCH' })
      },
    })
    const identity = await fixture.safety.readIdentity(PID)
    const stop = fixture.safety.terminatePid(PID, { identity, verifyOwner: async () => allowed })
    if (allowed) await stop
    else await assert.rejects(() => stop)
    const kills = commands.filter(command => command.command === 'taskkill.exe')
    assert.equal(kills.length, allowed ? 1 : 0)
    if (allowed) assert.deepEqual(kills[0].args, ['/PID', String(PID), '/T', '/F'])
  }
})

// Compile the actual CommonJS launcher with inert native boundaries. Loading a
// separate VM also prevents these doubles from leaking into other test files.
function fakeLauncher(overrides = {}) {
  const state = {
    base: `http://127.0.0.1:${PORT}`, listener: PID, identity: 'linux:synthetic-boot:123456',
    portOpen: true, status: 200,
    body: JSON.stringify({ system: { comfyui_version: '0.3.0', python_version: '3.11' }, devices: [] }),
    lookupCalls: [], identityCalls: [], probes: [], terminations: [], signals: [], writes: [], clears: [],
    ...overrides,
  }
  const safety = {
    async findPidForPort(port) { state.lookupCalls.push(port); return state.listener },
    async readIdentity(pid) { state.identityCalls.push(pid); return state.identity },
    async terminatePid(pid, options) {
      state.terminations.push({ pid, identity: options.identity })
      if (!options.identity || !await options.verifyOwner()) throw new Error('Unverified owner')
      state.signals.push([pid, 'synthetic-stop'])
    },
  }
  const http = { request(options, onResponse) {
    state.probes.push(options)
    const request = new EventEmitter()
    request.destroy = error => { if (error) request.emit('error', error) }
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter()
      response.statusCode = state.status; response.setEncoding = () => {}
      onResponse(response)
      response.emit('data', state.body); response.emit('end')
    })
    return request
  } }
  const net = { connect() {
    const socket = new EventEmitter()
    socket.destroy = () => {}; socket.setTimeout = () => {}
    queueMicrotask(() => socket.emit(state.portOpen ? 'connect' : 'error'))
    return socket
  } }
  const forbidden = () => { throw new Error('Native process/filesystem mutation is forbidden in this fixture') }
  const fakeFs = { promises: { readFile: forbidden, mkdir: forbidden, writeFile: forbidden, unlink: forbidden },
    createWriteStream: forbidden, existsSync: forbidden }
  const filename = path.resolve(__dirname, '../electron/comfyLauncher.js')
  const realRequire = createRequire(filename), module = { exports: {} }
  const injectedRequire = name => {
    if (name === './comfyProcessSafety.cjs') return { createProcessSafety: options => {
      state.runProcess = options.runProcess
      return safety
    } }
    if (name === 'http') return http
    if (name === 'net') return net
    if (name === 'fs') return fakeFs
    if (name === 'child_process') return { spawn: state.spawn || forbidden }
    if (['path', 'events', './comfyPortableArgs.cjs', './comfyConsoleLog.cjs'].includes(name)) return realRequire(name)
    throw new Error(`Unexpected launcher dependency: ${name}`)
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, require: injectedRequire,
    __dirname: path.dirname(filename), __filename: filename,
    process: { platform: 'linux', pid: 999999, kill: forbidden, env: {} },
    console, URL, Buffer, setTimeout, clearTimeout,
  }, { filename })
  const launcher = new module.exports.ComfyLauncher({
    getHttpBase: () => state.base, getConfig: () => ({ launcherMode: 'script', launcherScript: '/synthetic/start.sh', stopOnQuit: true }),
  })
  launcher._writeStateFile = async record => { state.writes.push(record) }
  launcher._clearStateFile = async reason => { state.clears.push(reason) }
  return { launcher, state, safety }
}

function ownedLauncher(overrides = {}) {
  const fixture = fakeLauncher(overrides), { launcher, state } = fixture
  Object.assign(launcher, { _state: 'running', _ownership: 'ours', _pid: PID,
    _pidIdentity: state.identity, _ownedHttpBase: state.base })
  return fixture
}

test('launcher inspection binds a healthy local ComfyUI API to the exact listener and stable identity', async () => {
  const { launcher, state } = fakeLauncher()
  assert.equal(await launcher._inspectPidProcess(PID, state.base), state.identity)
  assert.deepEqual(state.lookupCalls, [PORT])
  assert.deepEqual(state.identityCalls, [PID, PID])
  assert.equal(state.probes[0].path, '/system_stats')
  assert.equal(state.probes[0].hostname, '127.0.0.1')
  assert.equal(state.probes[0].port, PORT)
  assert.deepEqual(state.signals, [])
})

test('launcher refuses remote, malformed and non-HTTP endpoints without probing local processes', async () => {
  for (const base of ['http://example.invalid:18188', 'http://192.168.1.2:18188',
    'https://127.0.0.1:18188', 'not a URL', 'file:///tmp/synthetic']) {
    const { launcher, state } = fakeLauncher({ base })
    assert.equal(await launcher._inspectPidProcess(PID, base), null, base)
    assert.deepEqual(state.probes, []); assert.deepEqual(state.lookupCalls, [])
  }
})

test('an HTTP 200 alone, invalid health shape or a different listener never proves ownership', async () => {
  for (const overrides of [
    { body: '<html>Unrelated local app</html>' }, { body: '{}' }, { body: 'null' },
    { body: JSON.stringify({ system: {}, devices: [] }) },
    { body: JSON.stringify({ system: { python_version: '3.11' }, devices: {} }) },
    { status: 503 }, { listener: null }, { listener: PID + 1 }, { identity: null },
  ]) {
    const { launcher, state } = fakeLauncher(overrides)
    assert.equal(await launcher._inspectPidProcess(PID, state.base), null, JSON.stringify(overrides))
    assert.deepEqual(state.signals, [])
  }
})

test('identity changing during the API/port probe invalidates launcher inspection', async () => {
  const { launcher, state, safety } = fakeLauncher()
  let reads = 0
  safety.readIdentity = async () => ++reads === 1 ? state.identity : `${state.identity}-reused`
  assert.equal(await launcher._inspectPidProcess(PID, state.base), null)
  assert.equal(reads, 2)
})

test('both adoption paths persist an identity only after exact ownership inspection', async () => {
  for (const method of ['_detectExternal', '_tryAdoptExistingInstance']) {
    const { launcher, state } = fakeLauncher()
    await launcher[method](state.base)
    assert.equal(launcher._ownership, 'ours', method)
    assert.equal(launcher._pid, PID); assert.equal(launcher._pidIdentity, state.identity)
    assert.equal(launcher._ownedHttpBase, state.base)
    assert.equal(state.writes.length, 1)
    assert.equal(state.writes[0].identity, state.identity)
    assert.equal(state.writes[0].pid, PID); assert.equal(state.writes[0].port, PORT)
  }
})

test('manual connection without a configured launcher stays read-only even when PID is identifiable', async () => {
  const { launcher, state } = fakeLauncher()
  launcher._getConfig = () => ({})
  await launcher._detectExternal()
  assert.equal(launcher._ownership, 'external')
  assert.equal(launcher._pid, null)
  assert.deepEqual(state.lookupCalls, [])
  assert.deepEqual(state.writes, [])
  assert.equal((await launcher.stop()).success, false)
  assert.equal((await launcher.restart()).success, false)
  assert.deepEqual(state.signals, [])
})

test('manual connection rejects an unrelated HTTP 200 server', async () => {
  const { launcher, state } = fakeLauncher({ body: '<html>Unrelated app</html>' })
  launcher._getConfig = () => ({})
  await launcher._detectExternal()
  assert.equal(launcher._ownership, 'none')
  assert.equal(launcher._state, 'idle')
  assert.deepEqual(state.writes, [])
})

test('unverified adoption remains read-only and cannot Stop or Restart a foreign process', async () => {
  for (const method of ['_detectExternal', '_tryAdoptExistingInstance']) {
    for (const overrides of [{ identity: null }, { listener: null }, { body: '{}' }]) {
      const { launcher, state } = fakeLauncher(overrides)
      await launcher[method](state.base)
      assert.equal(launcher._ownership, 'external')
      assert.equal(launcher._pid, null); assert.equal(launcher._pidIdentity, null)
      assert.equal(state.writes.length, 0)
      assert.equal((await launcher.stop()).success, false)
      assert.equal((await launcher.restart()).success, false)
      assert.deepEqual(state.terminations, []); assert.deepEqual(state.signals, [])
    }
  }
})

test('reclaim refuses a stale identity, endpoint mismatch or saved PID unrelated to the API', async () => {
  for (const mode of ['identity', 'endpoint', 'port', 'listener', 'health']) {
    const { launcher, state } = fakeLauncher()
    const record = { pid: PID, port: PORT, httpBase: state.base, identity: state.identity, startedAt: 100 }
    if (mode === 'identity') record.identity += '-older-process'
    if (mode === 'endpoint') record.httpBase = `http://127.0.0.1:${PORT + 1}`
    if (mode === 'port') record.port = PORT + 1
    if (mode === 'listener') state.listener = PID + 1
    if (mode === 'health') state.body = '{}'
    launcher._readStateFile = async () => record
    launcher._pidIsAlive = () => true
    assert.equal(await launcher._tryReclaimFromStateFile(), false, mode)
    assert.equal(launcher._ownership, 'none'); assert.equal(launcher._pid, null)
    assert.equal(state.clears.length, 1)
    assert.deepEqual(state.signals, [])
  }
})

test('valid legacy and identity-bearing records are reclaimed only after fresh inspection', async () => {
  for (const legacy of [false, true]) {
    const { launcher, state } = fakeLauncher()
    launcher._readStateFile = async () => ({ pid: PID, port: PORT, httpBase: state.base,
      identity: legacy ? null : state.identity, startedAt: 100 })
    launcher._pidIsAlive = () => true
    assert.equal(await launcher._tryReclaimFromStateFile(), true)
    assert.equal(launcher._pidIdentity, state.identity)
    assert.equal(launcher._ownership, 'ours'); assert.equal(launcher._startedAt, 100)
    assert.equal(state.lookupCalls.length, 1)
    assert.equal(state.identityCalls.length, 2)
  }
})

test('stop revalidates ownership and clears state only after verified termination', async () => {
  const { launcher, state } = ownedLauncher()
  const result = await launcher.stop()
  assert.equal(result.success, true)
  assert.deepEqual(state.signals, [[PID, 'synthetic-stop']])
  assert.equal(state.terminations[0].identity, state.identity)
  assert.equal(launcher._state, 'stopped'); assert.equal(launcher._ownership, 'none')
  assert.equal(launcher._pid, null); assert.equal(launcher._pidIdentity, null)
  assert.equal(launcher._ownedHttpBase, ''); assert.equal(state.clears.length, 1)
})

test('stop and restart fail closed after endpoint, identity, listener or health changes', async () => {
  for (const mode of ['endpoint', 'identity', 'listener', 'health', 'missing-identity']) {
    const { launcher, state } = ownedLauncher()
    let starts = 0
    launcher.start = async () => { starts++; return { success: true } }
    if (mode === 'endpoint') state.base = `http://127.0.0.1:${PORT + 1}`
    if (mode === 'identity') state.identity += '-reused'
    if (mode === 'listener') state.listener = PID + 1
    if (mode === 'health') state.body = '{}'
    if (mode === 'missing-identity') launcher._pidIdentity = null
    assert.equal((await launcher.stop()).success, false, mode)
    assert.equal((await launcher.restart()).success, false, mode)
    assert.equal(starts, 0)
    assert.equal(launcher._pid, PID, 'Failed stop must retain inspectable state')
    assert.deepEqual(state.signals, []); assert.deepEqual(state.clears, [])
  }
})

test('ownership is checked again after awaiting the health and listener probes', async () => {
  for (const mode of ['endpoint', 'pid', 'ownership', 'child']) {
    const { launcher, state, safety } = ownedLauncher()
    const capturedBase = state.base, capturedIdentity = state.identity
    safety.findPidForPort = async () => {
      if (mode === 'endpoint') state.base += '/changed'
      if (mode === 'pid') launcher._pid = PID + 1
      if (mode === 'ownership') launcher._ownership = 'external'
      if (mode === 'child') launcher._child = { pid: PID }
      return PID
    }
    assert.equal(await launcher._verifyPidOwnership(PID, capturedBase, capturedIdentity), false, mode)
    assert.deepEqual(state.signals, [])
  }
})

test('a launcher target replaced while termination settles is not erased as successfully stopped', async () => {
  const { launcher, state, safety } = ownedLauncher()
  safety.terminatePid = async (pid, options) => {
    assert.equal(await options.verifyOwner(), true)
    launcher._pid = PID + 1; launcher._pidIdentity = 'replacement'
  }
  assert.equal((await launcher.stop()).success, false)
  assert.equal(launcher._pid, PID + 1)
  assert.equal(launcher._pidIdentity, 'replacement')
  assert.deepEqual(state.clears, [])
})

test('shutdown uses the guarded Stop path and does not report failed/external stops as successful', async () => {
  for (const mode of ['valid', 'stale', 'external']) {
    const { launcher, state } = ownedLauncher()
    if (mode === 'stale') state.identity += '-reused'
    if (mode === 'external') { launcher._ownership = 'external'; launcher._state = 'external' }
    assert.equal((await launcher.shutdown()).stopped, mode === 'valid', mode)
    assert.equal(state.signals.length, mode === 'valid' ? 1 : 0)
    assert.equal(state.clears.length, mode === 'valid' ? 1 : 0)
  }
  const { launcher, state } = fakeLauncher()
  launcher._ownership = 'app'; launcher._pid = null
  let appStops = 0
  launcher._stopMacApp = async () => { appStops++; return { success: true } }
  assert.equal((await launcher.shutdown()).stopped, true)
  assert.equal(appStops, 1); assert.deepEqual(state.terminations, [])
})

test('discovery waits for stdio close so a late second listener cannot be hidden by early exit', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  const { state } = fakeLauncher({ spawn: () => child })
  let settled = false
  const running = state.runProcess('synthetic-lsof', [], { timeoutMs: 1000 }).then(result => { settled = true; return result })
  child.stdout.emit('data', Buffer.from(`p${PID}\n`))
  child.emit('exit', 0)
  await Promise.resolve()
  assert.equal(settled, false, 'Child exit must not parse incomplete stdout')
  child.stdout.emit('data', Buffer.from('p123\n'))
  child.emit('close', 0)
  const result = await running
  assert.equal(result.ok, true)
  assert.equal(parseLsofPid(result.stdout), null)
})

test('discovery command timeout rejects partial PID output and terminates only its synthetic helper', async () => {
  const child = new EventEmitter(), kills = []
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.kill = kind => kills.push(kind)
  const { state } = fakeLauncher({ spawn: () => child })
  const running = state.runProcess('synthetic-lsof', [], { timeoutMs: 5 })
  child.stdout.emit('data', Buffer.from(`p${PID}\n`))
  const result = await running
  assert.equal(result.ok, false); assert.equal(result.timedOut, true)
  assert.deepEqual(kills, ['SIGTERM'])
  assert.deepEqual(state.signals, [])
})

test('a surviving process after forced termination is reported as a failure, not a confirmed stop', async () => {
  const signals = []
  const fixture = fakeSafety({ signal(pid, kind) { signals.push([pid, kind]) } })
  const identity = await fixture.safety.readIdentity(PID)
  await assert.rejects(() => fixture.safety.terminatePid(PID, { identity, verifyOwner: async () => true }), /exit/i)
  assert.deepEqual(signals.filter(([, kind]) => kind !== 0), [[PID, 'SIGTERM'], [PID, 'SIGKILL']])
})
