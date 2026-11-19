'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { Readable } = require('node:stream')
const { gzipSync } = require('node:zlib')
const { createHash } = require('node:crypto')
const { createCodexSetupInstaller, TARGETS, VERSION, sourceFor, allowedDownloadUrl, managedDirectory, writeAll, abortable } = require('../electron/codexSetupInstaller.cjs')
const hash = data => createHash('sha256').update(data).digest('hex')
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setTimeout(resolve, 5))
function executable(machine = 62) {
  const bytes = Buffer.alloc(128); Buffer.from([0x7f, 69, 76, 70, 2, 1]).copy(bytes)
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(machine, 18); return bytes
}
function archive({ name = 'codex-x86_64-unknown-linux-musl', type = 48, body = executable(), extra = false, checksum = true, size = body.length } = {}) {
  const hdr = Buffer.alloc(512); hdr.write(name); hdr.write('0000700\0', 100); hdr.write('0000000\0', 108); hdr.write('0000000\0', 116)
  hdr.write(size.toString(8).padStart(11, '0') + '\0', 124); hdr.write('00000000000\0', 136); hdr.fill(32, 148, 156); hdr[156] = type; hdr.write('ustar\0', 257)
  const sum = hdr.reduce((n, x) => n + x, 0); hdr.write((checksum ? sum : 5).toString(8).padStart(6, '0') + '\0 ', 148)
  const file = Buffer.concat([hdr, body, Buffer.alloc((512 - body.length % 512) % 512)])
  return gzipSync(Buffer.concat([file, extra ? file : Buffer.alloc(0), Buffer.alloc(1024)]))
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-codex-installer-test-'))
  const home = path.join(root, 'home'); await fs.mkdir(home, { mode: 0o700 })
  const originalAuth = path.join(home, '.codex'); await fs.mkdir(originalAuth); await fs.writeFile(path.join(originalAuth, 'auth.json'), 'SYNTHETIC-DO-NOT-CHANGE')
  const contents = options.archive || archive(); const target = { ...TARGETS.x64, bytes: contents.length, sha256: hash(contents) }
  let present = false, approved = true, fetches = 0, inspectCalls = 0, live = true; const approvals = []
  const manager = createCodexSetupInstaller({ getHomeDirectory: () => home,
    platform: options.platform || 'linux', arch: options.arch || 'x64', targets: { x64: target },
    inspectExisting: async () => { inspectCalls++; await options.inspect?.(inspectCalls); return present },
    assertCurrent: async () => { if (!live) throw Error('Fixture stale document') },
    confirm: async p => { approvals.push(p); await options.confirm?.(); return approved },
    fetch: async (url, params) => { fetches++; assert.equal(url, sourceFor(target)); if (options.fetch) return options.fetch(params, contents); return { headers: { 'content-length': String(contents.length) }, body: Readable.from([contents]) } },
    ...options.overrides,
  })
  t.after(async () => {
    manager.dispose()
    assert.equal(await fs.readFile(path.join(originalAuth, 'auth.json'), 'utf8'), 'SYNTHETIC-DO-NOT-CHANGE')
    // This exact disposable test directory was created above; never user data.
    await fs.rm(root, { recursive: true, force: true })
  })
  const owner = 'fixture-owner'
  const plan = () => manager.plan({}, owner)
  const begin = async () => { const p = await plan(); assert.equal(p.success, true); return manager.install({ planId: p.planId }, owner) }
  const finish = async job => { for (let i = 0; i < 400; i++) { const s = await manager.status({ jobId: job.jobId }, owner); if (['completed', 'failed', 'cancelled'].includes(s.state)) return s; await tick() }; throw Error('Fixture installer timed out') }
  return { manager, home, root, target, approvals, plan, begin, finish, owner, destination: path.join(managedDirectory(home), 'codex'),
    setPresent: v => { present = v }, setApprove: v => { approved = v }, setLive: v => { live = v },
    get fetches() { return fetches }, get inspectCalls() { return inspectCalls } }
}

test('pinned official Linux manifests have exact reviewed URLs, bytes, SHA256', () => {
  assert.equal(VERSION, '0.166.0')
  for (const target of Object.values(TARGETS)) { assert.match(target.sha256, /^[a-f0-9]{64}$/); assert.ok(target.bytes > 1e8); assert.equal(new URL(sourceFor(target)).origin, 'https://github.com') }
})
test('download URL policy blocks caller URLs/private hosts, credentials, downgrade and unexpected redirects', () => {
  const initial = sourceFor(TARGETS.x64)
  assert.equal(allowedDownloadUrl(initial, initial), true)
  assert.equal(allowedDownloadUrl('https://release-assets.githubusercontent.com/github-production-release-asset/123/a-b?sig=fixture', initial), true)
  for (const value of ['http://github.com/openai/codex', 'https://127.0.0.1/a', 'https://github.com/evil/evil', 'https://github.com@evil.test/a', 'https://release-assets.githubusercontent.com/other/a', 'https://release-assets.githubusercontent.com/github-production-release-asset/a#bad']) assert.equal(allowedDownloadUrl(value, initial), false, value)
})
test('plan is read-only; explicit approval installs only managed ELF without launching or auth changes', async t => {
  const f = await fixture(t); const p = await f.plan(); assert.equal(p.supported, true); assert.equal(f.fetches, 0)
  await assert.rejects(fs.lstat(managedDirectory(f.home)), { code: 'ENOENT' })
  const job = await f.manager.install({ planId: p.planId }, f.owner); assert.equal(job.success, true)
  const s = await f.finish(job); assert.equal(s.state, 'completed', JSON.stringify(s)); assert.equal(s.bytesReceived, f.target.bytes)
  assert.deepEqual(await fs.readFile(f.destination), executable()); assert.equal((await fs.stat(f.destination)).mode & 0o777, 0o700)
  assert.equal(f.approvals.length, 1); assert.deepEqual(await fs.readdir(managedDirectory(f.home)), ['codex'])
  assert.equal((await f.plan()).code, 'ALREADY_INSTALLED')
})
test('unsupported platforms do not fetch, install or inspect accounts', async t => {
  const f = await fixture(t, { platform: 'darwin' }); const p = await f.plan(); assert.equal(p.supported, false); assert.equal(f.fetches, 0); assert.equal(f.inspectCalls, 0)
})
test('existing installation/custom choice blocks planning; decline confirmation writes nothing', async t => {
  const f = await fixture(t); f.setPresent(true); assert.equal((await f.plan()).code, 'ALREADY_INSTALLED'); f.setPresent(false)
  f.setApprove(false); assert.equal((await f.begin()).cancelled, true); assert.equal(f.fetches, 0); await assert.rejects(fs.lstat(managedDirectory(f.home)), { code: 'ENOENT' })
})
test('no caller source/path/owner, foreign plan/job, expired plan or duplicate install authority', async t => {
  let now = 1; const f = await fixture(t, { overrides: { now: () => now } })
  for (const args of [null, { source: 'evil' }, { destination: '/tmp' }]) assert.equal((await f.manager.plan(args, f.owner)).code, 'INVALID_REQUEST')
  const p = await f.plan(); assert.equal((await f.manager.install({ planId: p.planId }, 'different-owner')).code, 'STALE_PLAN')
  now = 999999; assert.equal((await f.manager.install({ planId: p.planId }, f.owner)).code, 'STALE_PLAN')
  assert.equal((await f.manager.status({ jobId: 'unknown' }, f.owner)).code, 'UNKNOWN_JOB')
})
test('installation appearing while native approval is open is preserved', async t => {
  const gate = defer(); const f = await fixture(t, { confirm: () => gate.promise }); const starting = f.begin()
  while (!f.approvals.length) await tick(); f.setPresent(true); gate.resolve()
  assert.equal((await starting).code, 'ALREADY_INSTALLED'); assert.equal(f.fetches, 0)
})
test('parent symlink and replaced directory are rejected without touching destination', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'outside')); await fs.symlink(path.join(f.root, 'outside'), path.join(f.home, '.local'))
  assert.equal((await f.plan()).code, 'UNSAFE_DESTINATION'); assert.deepEqual(await fs.readdir(path.join(f.root, 'outside')), [])
})
test('destination creation between plan and confirmation fails closed', async t => {
  const f = await fixture(t); const p = await f.plan(); await fs.mkdir(managedDirectory(f.home), { recursive: true }); await fs.writeFile(f.destination, 'preserve')
  assert.equal((await f.manager.install({ planId: p.planId }, f.owner)).code, 'DESTINATION_CHANGED'); assert.equal(await fs.readFile(f.destination, 'utf8'), 'preserve')
})
test('publicly writable installation parents are rejected without changing permissions', async t => {
  const f = await fixture(t); const folder = path.join(f.home, '.local'); await fs.mkdir(folder); await fs.chmod(folder, 0o777)
  assert.equal((await f.plan()).code, 'UNSAFE_DESTINATION'); assert.equal((await fs.stat(folder)).mode & 0o777, 0o777); assert.equal(f.fetches, 0)
})
test('size and digest failures never publish executable and clear job temporary files', async t => {
  for (const wrongSize of [true, false]) {
    const f = await fixture(t, { fetch: async (_params, contents) => ({ headers: { 'content-length': String(contents.length + (wrongSize ? 1 : 0)) }, body: Readable.from([Buffer.alloc(contents.length)]) }) })
    const result = await f.finish(await f.begin()); assert.equal(result.state, 'failed'); assert.equal(result.code, 'INTEGRITY_FAILED')
    await assert.rejects(fs.lstat(f.destination), { code: 'ENOENT' }); assert.deepEqual(await fs.readdir(managedDirectory(f.home)), [])
  }
})
for (const [name, params, expected] of [
  ['traversal', { name: '../../codex' }, 'INVALID_ARCHIVE'], ['symlink', { type: 50 }, 'INVALID_ARCHIVE'],
  ['hardlink', { type: 49 }, 'INVALID_ARCHIVE'], ['extra file', { extra: true }, 'INVALID_ARCHIVE'],
  ['metadata', { type: 120 }, 'INVALID_ARCHIVE'], ['checksum', { checksum: false }, 'INVALID_ARCHIVE'],
  ['truncated body', { size: 9999 }, 'INVALID_ARCHIVE'], ['wrong architecture', { body: executable(183) }, 'WRONG_ARCHITECTURE'],
  ['script', { body: Buffer.alloc(128, 35) }, 'WRONG_ARCHITECTURE'],
]) test(`archive rejects ${name} despite matching download SHA`, async t => {
  const f = await fixture(t, { archive: archive(params) }); const result = await f.finish(await f.begin())
  assert.equal(result.state, 'failed'); assert.equal(result.code, expected); await assert.rejects(fs.lstat(f.destination), { code: 'ENOENT' })
})
test('cancel during final existing-install check cannot publish', async t => {
  const gate = defer(); const reached = defer()
  const f = await fixture(t, { inspect: async n => { if (n === 5) { reached.resolve(); await gate.promise } } })
  const job = await f.begin(); await reached.promise
  const cancel = f.manager.cancel({ jobId: job.jobId }, f.owner); gate.resolve(); const result = await cancel
  assert.equal(result.state, 'cancelled'); await assert.rejects(fs.lstat(f.destination), { code: 'ENOENT' })
})
test('cancel pending network is bounded and never installs', async t => {
  const f = await fixture(t, { fetch: () => new Promise(() => {}) }); const job = await f.begin()
  const result = await f.manager.cancel({ jobId: job.jobId }, f.owner); assert.equal(result.state, 'cancelled')
  await assert.rejects(fs.lstat(f.destination), { code: 'ENOENT' })
})
test('timeout pending network is bounded and never installs', async t => {
  const f = await fixture(t, { fetch: () => new Promise(() => {}), overrides: { downloadMs: 5 } })
  const result = await f.finish(await f.begin()); assert.equal(result.state, 'cancelled')
  await assert.rejects(fs.lstat(f.destination), { code: 'ENOENT' })
})
test('a destination appearing immediately before commit is not overwritten', async t => {
  let f; f = await fixture(t, { inspect: async n => { if (n === 5) await fs.writeFile(f.destination, 'preserve this racing installation') } })
  const result = await f.finish(await f.begin()); assert.equal(result.state, 'failed')
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'preserve this racing installation')
})
test('owner cancellation invalidates plans without touching user files', async t => {
  const f = await fixture(t); const p = await f.plan(); f.manager.cancelOwner(f.owner)
  assert.equal((await f.manager.install({ planId: p.planId }, f.owner)).code, 'STALE_PLAN'); assert.equal(f.fetches, 0)
})
test('ARM64 extracts only the pinned target shape and architecture in disposable storage', async t => {
  const contents = archive({ name: 'codex-aarch64-unknown-linux-musl', body: executable(183) })
  const target = { ...TARGETS.arm64, bytes: contents.length, sha256: hash(contents) }
  const f = await fixture(t, { arch: 'arm64', archive: contents, overrides: { targets: { arm64: target }, fetch: async () => ({ headers: { 'content-length': String(contents.length) }, body: Readable.from([contents]) }) } })
  const result = await f.finish(await f.begin()); assert.equal(result.state, 'completed'); assert.deepEqual(await fs.readFile(f.destination), executable(183))
})
test('partial file writes are completed and stalled writes fail', async () => {
  const output = []; await writeAll({ write: async (bytes, offset, length) => { const n = Math.min(2, length); output.push(bytes.subarray(offset, offset + n)); return { bytesWritten: n } } }, Buffer.from('abcdef'), new AbortController().signal)
  assert.equal(Buffer.concat(output).toString(), 'abcdef')
  await assert.rejects(writeAll({ write: async () => ({ bytesWritten: 0 }) }, Buffer.from('x')), { code: 'WRITE_FAILED' })
})
test('abort race returns before a hanging resolver completes', async () => {
  const controller = new AbortController(); const waiting = abortable(new Promise(() => {}), controller.signal); controller.abort()
  await assert.rejects(waiting, { code: 'CANCELLED' })
})
