'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { EventEmitter } = require('node:events')
const { Readable } = require('node:stream')
const { createModelDownloadManager, LIMITS } = require('../electron/agentModelDownloads.cjs')
const { createPublicWebClient } = require('../electron/agentResearchWeb.cjs')

const owner = 'host-project-session-a'
const baseArgs = { url: 'https://huggingface.co/example/model/resolve/main/model.safetensors?download=true', targetSubdir: 'checkpoints', filename: 'example-model.safetensors', maxBytes: 4096 }
const tick = () => new Promise(resolve => setImmediate(resolve))
function safetensors() {
  const header = Buffer.from(JSON.stringify({ tensor: { dtype: 'F32', shape: [1], data_offsets: [0, 4] } }))
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(header.length))
  return Buffer.concat([length, header, Buffer.alloc(4)])
}
function gguf() { const buffer = Buffer.alloc(24); buffer.write('GGUF'); buffer.writeUInt32LE(3, 4); return buffer }
const body = safetensors()
function response(data = body, headers = {}) {
  return { statusCode: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(data.length), ...headers }, finalUrl: 'https://cdn.example.com/model?secret=not-returned', stream: (async function* () { yield data })() }
}
async function fixture(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-model-download-test-'))
  const root = path.join(temporary, 'ComfyUI')
  await fs.mkdir(path.join(root, 'models', 'checkpoints'), { recursive: true })
  await fs.writeFile(path.join(root, 'main.py'), '# synthetic fixture; never executed')
  let configured = root; const requests = []
  const manager = createModelDownloadManager({ getComfyRoot: () => configured, webClient: { open: async (...args) => { requests.push(args); return response() } }, ...options })
  t.after(async () => { await manager.dispose(); await fs.rm(temporary, { recursive: true, force: true }) })
  return { manager, root, temporary, requests, category: path.join(root, 'models', 'checkpoints'), setRoot: value => { configured = value } }
}
async function launch(fixture, args = baseArgs, options = {}) {
  const preview = await fixture.manager.preview(args, { owner, ...options })
  const job = await fixture.manager.start({ previewToken: preview.previewToken }, { owner, ...options })
  return { preview, job }
}
async function settled(manager, jobId, jobOwner = owner) {
  for (let count = 0; count < 2000; count++) {
    const status = manager.status({ jobId }, { owner: jobOwner })
    if (['completed', 'failed', 'cancelled'].includes(status.state)) return status
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('Synthetic download did not settle')
}
async function until(predicate) { for (let count = 0; count < 2000; count++) { if (await predicate()) return; await tick() } throw new Error('Condition did not occur') }

test('preview is read-only; approved download is bounded, verified, and atomically installed', async t => {
  const f = await fixture(t)
  const args = { ...baseArgs, expectedSha256: createHash('sha256').update(body).digest('hex') }
  const preview = await f.manager.preview(args, { owner })
  assert.equal(preview.previewOnly, true)
  assert.equal(preview.destination, path.join(f.category, args.filename))
  assert.deepEqual(await fs.readdir(f.category), [])
  assert.equal(f.requests.length, 0)
  const job = await f.manager.start({ previewToken: preview.previewToken }, { owner })
  const done = await settled(f.manager, job.jobId)
  assert.equal(done.state, 'completed')
  assert.equal(done.downloadedBytes, body.length)
  assert.equal(done.sha256, args.expectedSha256)
  assert.equal(done.source, 'https://huggingface.co/example/model/resolve/main/model.safetensors')
  assert.doesNotMatch(JSON.stringify(done), /secret|download=true|partial|host-project/)
  assert.deepEqual(await fs.readFile(path.join(f.category, args.filename)), body)
  assert.deepEqual(await fs.readdir(f.category), [args.filename])
  assert.equal(f.requests[0][1].maxBytes, args.maxBytes)
  assert.equal(f.requests[0][1].method, 'GET')
})

test('GGUF v2/v3 is supported; downloads never execute or load the result', async t => {
  const f = await fixture(t, { webClient: { open: async () => response(gguf()) } })
  const { job } = await launch(f, { ...baseArgs, filename: 'test.gguf' })
  assert.equal((await settled(f.manager, job.jobId)).state, 'completed')
  assert.deepEqual(await fs.readdir(f.category), ['test.gguf'])
})

test('public URL, credentials, traversal, Windows aliases, unsupported files, and limits fail at preview', async t => {
  const f = await fixture(t)
  const invalidUrls = ['http://example.com/a', 'https://user:pass@example.com/a', 'https://example.com:8443/a', 'https://localhost/a', 'https://127.0.0.1/a', 'https://0x7f000001/a', 'https://[::1]/a', 'https://server.local/a', 'https://example.com/a#private', 'https://example.com/a?token=secret', 'https://example.com/a?X-Amz-Signature=secret', 'https://example.com/\u0000a', 'https://example.com\\@localhost/a']
  for (const url of invalidUrls) await assert.rejects(f.manager.preview({ ...baseArgs, url }, { owner }), { code: 'INVALID_URL' }, url)
  const invalidNames = ['../evil.safetensors', '..\\evil.safetensors', '/tmp/evil.gguf', 'C:\\models\\evil.gguf', 'NUL.safetensors', 'nul.other.safetensors', 'COM1.gguf', 'LPT9.GGUF', 'AUX.gguf', 'CON.safetensors', 'CON .gguf', 'nul .safetensors', 'model:stream.gguf', 'model.safetensors.', 'model.safetensors ', 'model\0.gguf', 'model.bin', 'model.pt', 'installer.py', 'two..dots.gguf', '.hidden.gguf']
  for (const filename of invalidNames) await assert.rejects(f.manager.preview({ ...baseArgs, filename }, { owner }), { code: 'INVALID_FILENAME' }, filename)
  for (const targetSubdir of ['../custom_nodes', 'checkpoints/subfolder', '/tmp', 'custom_nodes', 'checkpoints\\..\\..']) await assert.rejects(f.manager.preview({ ...baseArgs, targetSubdir }, { owner }), { code: 'INVALID_TARGET' })
  for (const maxBytes of [0, -1, 1.5, Infinity, LIMITS.maxBytes + 1, undefined]) await assert.rejects(f.manager.preview({ ...baseArgs, maxBytes }, { owner }), { code: 'INVALID_LIMIT' })
  await assert.rejects(f.manager.preview({ ...baseArgs, headers: { Authorization: 'secret' } }, { owner }), { code: 'INVALID_DOWNLOAD' })
  await assert.rejects(f.manager.preview({ ...baseArgs, expectedSha256: 'no' }, { owner }), { code: 'INVALID_HASH' })
  await assert.rejects(f.manager.preview(baseArgs), { code: 'INVALID_OWNER' })
  assert.equal(f.requests.length, 0)
  assert.deepEqual(await fs.readdir(f.category), [])
})

test('one-use preview binds exact arguments, owner, expiry, and configured root', async t => {
  let clock = 1000
  const f = await fixture(t, { now: () => clock, previewTtlMs: 100 })
  const p = await f.manager.preview(baseArgs, { owner })
  await assert.rejects(f.manager.start({ previewToken: p.previewToken }, { owner: 'other' }), { code: 'PREVIEW_REQUIRED' })
  await assert.rejects(f.manager.start({ ...baseArgs, maxBytes: 5000, previewToken: p.previewToken }, { owner }), { code: 'PREVIEW_CHANGED' })
  clock += 101
  await assert.rejects(f.manager.start({ previewToken: p.previewToken }, { owner }), { code: 'PREVIEW_REQUIRED' })
  const next = await f.manager.preview(baseArgs, { owner })
  const starts = await Promise.allSettled([f.manager.start({ previewToken: next.previewToken }, { owner }), f.manager.start({ previewToken: next.previewToken }, { owner })])
  assert.equal(starts.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(starts.find(result => result.status === 'rejected').reason.code, 'PREVIEW_REQUIRED')
  await settled(f.manager, starts.find(result => result.status === 'fulfilled').value.jobId)
})

test('configured root changes and replaced directory identities invalidate approval without network or file writes', async t => {
  const f = await fixture(t)
  const p = await f.manager.preview(baseArgs, { owner })
  const second = path.join(f.temporary, 'OtherComfyUI')
  await fs.mkdir(path.join(second, 'models', 'checkpoints'), { recursive: true }); await fs.writeFile(path.join(second, 'main.py'), '# fixture')
  f.setRoot(second)
  await assert.rejects(f.manager.start({ previewToken: p.previewToken }, { owner }), { code: 'ROOT_CHANGED' })
  f.setRoot(f.root)
  const next = await f.manager.preview(baseArgs, { owner })
  await fs.rename(f.category, path.join(f.root, 'models', 'old-checkpoints')); await fs.mkdir(f.category)
  await assert.rejects(f.manager.start({ previewToken: next.previewToken }, { owner }), { code: 'ROOT_CHANGED' })
  assert.equal(f.requests.length, 0)
  assert.deepEqual(await fs.readdir(f.category), [])
})

test('invalid ComfyUI roots, main.py symlinks, and model/category symlink escapes are rejected', async t => {
  const f = await fixture(t)
  f.setRoot(f.temporary)
  await assert.rejects(f.manager.preview(baseArgs, { owner }), { code: 'INVALID_ROOT' })
  f.setRoot(f.root)
  const outside = path.join(f.temporary, 'outside'); await fs.mkdir(outside)
  await fs.rename(f.category, path.join(f.root, 'models', 'real-checkpoints')); await fs.symlink(outside, f.category)
  await assert.rejects(f.manager.preview(baseArgs, { owner }), { code: 'UNSAFE_PATH' })
  await fs.unlink(f.category); await fs.mkdir(f.category)
  await fs.rename(path.join(f.root, 'main.py'), path.join(f.root, 'actual-main.py')); await fs.symlink(path.join(f.root, 'actual-main.py'), path.join(f.root, 'main.py'))
  await assert.rejects(f.manager.preview(baseArgs, { owner }), { code: 'INVALID_ROOT' })
  assert.deepEqual(await fs.readdir(outside), [])
})

test('an absent allowlisted category is an explicit read-only setup prerequisite', async t => {
  const f = await fixture(t)
  await assert.rejects(f.manager.preview({ ...baseArgs, targetSubdir: 'text_encoders' }, { owner }), { code: 'MISSING_CATEGORY' })
  assert.deepEqual(await fs.readdir(path.join(f.root, 'models')), ['checkpoints'])
  assert.equal(f.requests.length, 0)
})

test('existing files, dangling links, and case aliases are never replaced', async t => {
  const f = await fixture(t)
  const destination = path.join(f.category, baseArgs.filename)
  await fs.writeFile(destination, 'existing')
  await assert.rejects(f.manager.preview(baseArgs, { owner }), { code: 'DESTINATION_EXISTS' })
  await fs.unlink(destination); await fs.symlink(path.join(f.temporary, 'missing'), destination)
  await assert.rejects(f.manager.preview(baseArgs, { owner }), { code: 'DESTINATION_EXISTS' })
  await fs.unlink(destination); await fs.writeFile(path.join(f.category, baseArgs.filename.toUpperCase()), 'existing')
  await assert.rejects(f.manager.preview(baseArgs, { owner }), { code: 'DESTINATION_EXISTS' })
  assert.equal(f.requests.length, 0)
})

test('disk-space checks require the approved upper bound, while unavailable statfs is best effort', async t => {
  const noSpace = await fixture(t, { fs: { ...fs, statfs: async () => ({ bavail: 1, bsize: 1 }) } })
  await assert.rejects(noSpace.manager.preview(baseArgs, { owner }), { code: 'INSUFFICIENT_SPACE' })
  const unsupported = await fixture(t, { fs: { ...fs, statfs: async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOSYS' }) } } })
  assert.equal((await unsupported.manager.preview(baseArgs, { owner })).freeBytes, null)
})

test('oversized, incomplete, compressed, HTTP-error, wrong-hash, and disguised responses leave no final or partial files', async t => {
  const cases = [
    [{ ...response(), statusCode: 206 }, {}, 'DOWNLOAD_RESPONSE'],
    [response(body, { 'content-length': '99999999' }), {}, 'DOWNLOAD_TOO_LARGE'],
    [response(body, { 'content-length': String(body.length + 1) }), {}, 'DOWNLOAD_INCOMPLETE'],
    [response(body, { 'content-type': 'text/html' }), {}, 'INVALID_MODEL'],
    [response(body, { 'content-encoding': 'gzip' }), {}, 'DOWNLOAD_RESPONSE'],
    [response(Buffer.from('<html>not a model</html>')), {}, 'INVALID_MODEL'],
    [response(body), { expectedSha256: '0'.repeat(64) }, 'HASH_MISMATCH'],
    [response(Buffer.alloc(24)), { filename: 'false.gguf' }, 'INVALID_MODEL'],
    [{ ...response(Buffer.alloc(4097)), headers: {} }, {}, 'DOWNLOAD_TOO_LARGE'],
  ]
  for (const [reply, args, code] of cases) {
    const f = await fixture(t, { webClient: { open: async () => reply } })
    const { job } = await launch(f, { ...baseArgs, ...args })
    const done = await settled(f.manager, job.jobId)
    assert.equal(done.state, 'failed'); assert.equal(done.error.code, code)
    assert.deepEqual(await fs.readdir(f.category), [])
  }
})

test('network exceptions cannot leak private URLs, filesystem paths, or credentials into status', async t => {
  const f = await fixture(t, { webClient: { open: async () => { throw new Error('https://user:password@example.com/?token=secret /private/root') } } })
  const { job } = await launch(f)
  const done = await settled(f.manager, job.jobId)
  assert.equal(done.state, 'failed')
  assert.doesNotMatch(JSON.stringify(done), /password|secret|private\/root/)
  assert.deepEqual(await fs.readdir(f.category), [])
})

test('owner-scoped status/cancel and explicit Stop abort a stalled stream and remove only owned partials', async t => {
  let reading = false
  const f = await fixture(t, { webClient: { open: async () => ({ statusCode: 200, headers: {}, stream: { [Symbol.asyncIterator]() { return { next: () => { reading = true; return new Promise(() => {}) }, return: async () => ({ done: true }) } } } }) } })
  const unrelated = path.join(f.category, '.velorn-model-unrelated.partial'); await fs.writeFile(unrelated, 'leave me')
  const controller = new AbortController()
  const { job } = await launch(f, baseArgs, { signal: controller.signal })
  await until(() => reading)
  await assert.rejects(f.manager.cancel({ jobId: job.jobId }, { owner: 'other' }), { code: 'UNKNOWN_JOB' })
  assert.deepEqual(f.manager.status({}, { owner: 'other' }), { jobs: [] })
  assert.throws(() => f.manager.status({ jobId: job.jobId }, { owner: 'other' }), { code: 'UNKNOWN_JOB' })
  controller.abort('stopped')
  const done = await settled(f.manager, job.jobId)
  assert.equal(done.state, 'cancelled')
  assert.deepEqual(await fs.readdir(f.category), [path.basename(unrelated)])
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'leave me')
})

test('a normally finished agent turn detaches, leaving the background job visible and cancellable from a later turn', async t => {
  let release, reading = false
  const f = await fixture(t, { webClient: { open: async () => ({ ...response(), stream: (async function* () { reading = true; await new Promise(resolve => { release = resolve }); yield body })() }) } })
  const controller = new AbortController()
  const { job } = await launch(f, baseArgs, { signal: controller.signal })
  await until(() => reading)
  controller.abort('finished')
  assert.equal(f.manager.status({ jobId: job.jobId }, { owner }).state, 'downloading')
  release()
  assert.equal((await settled(f.manager, job.jobId)).state, 'completed')
})

test('manager deadline cancels an unresponsive open request and cleans its partial', async t => {
  const f = await fixture(t, { timeoutMs: 20, webClient: { open: () => new Promise(() => {}) } })
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive))
  const { job } = await launch(f)
  const done = await settled(f.manager, job.jobId)
  assert.equal(done.state, 'failed'); assert.equal(done.error.code, 'DOWNLOAD_TIMEOUT')
  assert.deepEqual(await fs.readdir(f.category), [])
})

test('root changed during transfer prevents promotion and cleans the originally pinned directory', async t => {
  let release, reading = false
  const f = await fixture(t, { webClient: { open: async () => ({ ...response(), stream: (async function* () { reading = true; await new Promise(resolve => { release = resolve }); yield body })() }) } })
  const { job } = await launch(f)
  await until(() => reading)
  const old = path.join(f.root, 'models', 'original-checkpoints')
  await fs.rename(f.category, old)
  const outside = path.join(f.temporary, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, f.category)
  release()
  const done = await settled(f.manager, job.jobId)
  assert.equal(done.state, 'failed')
  assert.ok(['ROOT_CHANGED', 'UNSAFE_PATH'].includes(done.error.code))
  assert.deepEqual(await fs.readdir(outside), [])
  assert.deepEqual(await fs.readdir(old), [])
})

test('atomic promotion does not overwrite a destination that appears at the last instant', async t => {
  const f = await fixture(t, { fs: { ...fs, link: async (source, target) => { await fs.writeFile(target, 'other writer', { flag: 'wx' }); return fs.link(source, target) } } })
  const { job } = await launch(f)
  const done = await settled(f.manager, job.jobId)
  assert.equal(done.state, 'failed'); assert.equal(done.error.code, 'DESTINATION_EXISTS')
  assert.equal(await fs.readFile(path.join(f.category, baseArgs.filename), 'utf8'), 'other writer')
  assert.deepEqual(await fs.readdir(f.category), [baseArgs.filename])
})

test('Stop during the last filesystem check is observed before the promotion commit point', async t => {
  const controller = new AbortController(); let links = 0
  const f = await fixture(t, { fs: { ...fs,
    lstat: async file => { const stat = await fs.lstat(file); if (String(file).endsWith('.partial')) controller.abort('stopped'); return stat },
    link: async (...args) => { links++; return fs.link(...args) },
  } })
  const { job } = await launch(f, baseArgs, { signal: controller.signal })
  const done = await settled(f.manager, job.jobId)
  assert.equal(done.state, 'cancelled'); assert.equal(links, 0)
  assert.deepEqual(await fs.readdir(f.category), [])
})

test('filesystems without safe hardlink promotion fail clearly, with no rename fallback', async t => {
  let renameCalls = 0
  const f = await fixture(t, { fs: { ...fs, link: async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }) }, rename: async () => { renameCalls++ } } })
  const { job } = await launch(f)
  const done = await settled(f.manager, job.jobId)
  assert.equal(done.state, 'failed'); assert.equal(done.error.code, 'PROMOTION_UNSUPPORTED')
  assert.equal(renameCalls, 0); assert.deepEqual(await fs.readdir(f.category), [])
})

test('partial replacement is not deleted or promoted as an owned file', async t => {
  let changedPath
  const f = await fixture(t, { webClient: { open: async () => {
    const names = await fs.readdir(f.category); const partial = names.find(name => name.endsWith('.partial'))
    changedPath = path.join(f.category, partial)
    await fs.unlink(changedPath); await fs.writeFile(changedPath, 'external replacement')
    return response()
  } } })
  const { job } = await launch(f)
  const done = await settled(f.manager, job.jobId)
  assert.equal(done.state, 'failed'); assert.equal(done.error.code, 'PARTIAL_CHANGED')
  assert.match(done.warning, /left untouched/)
  assert.equal(await fs.readFile(changedPath, 'utf8'), 'external replacement')
  await assert.rejects(fs.stat(path.join(f.category, baseArgs.filename)), { code: 'ENOENT' })
})

test('concurrency, queue, duplicate destination, retained jobs, and disposal are bounded', async t => {
  let opens = 0
  const f = await fixture(t, { maxActive: 1, maxQueued: 1, maxJobs: 2, webClient: { open: async () => { opens++; return new Promise(() => {}) } } })
  const first = await launch(f)
  await until(() => opens === 1)
  const duplicate = await f.manager.preview(baseArgs, { owner })
  await assert.rejects(f.manager.start({ previewToken: duplicate.previewToken }, { owner }), { code: 'DESTINATION_BUSY' })
  const second = await launch(f, { ...baseArgs, filename: 'second.gguf' })
  assert.equal(second.job.state, 'queued')
  const third = await f.manager.preview({ ...baseArgs, filename: 'third.gguf' }, { owner })
  await assert.rejects(f.manager.start({ previewToken: third.previewToken }, { owner }), { code: 'DOWNLOAD_LIMIT' })
  assert.equal(opens, 1)
  assert.equal((await f.manager.cancel({ jobId: second.job.jobId }, { owner })).state, 'cancelled')
  await f.manager.dispose()
  assert.equal(f.manager.status({ jobId: first.job.jobId }, { owner }).state, 'cancelled')
  assert.deepEqual(await fs.readdir(f.category), [])
  await assert.rejects(f.manager.preview(baseArgs, { owner }), { code: 'DISPOSED' })
})

test('portable macOS/Windows branches retain static containment and no-clobber checks (simulated on host filesystem)', async t => {
  for (const platform of ['darwin', 'win32']) {
    const f = await fixture(t, { platform })
    const { job } = await launch(f)
    assert.equal((await settled(f.manager, job.jobId)).state, 'completed')
    await assert.rejects(f.manager.preview(baseArgs, { owner }), { code: 'DESTINATION_EXISTS' })
    await fs.unlink(path.join(f.category, baseArgs.filename))
    const outside = path.join(f.temporary, 'outside'); await fs.mkdir(outside)
    await fs.rename(f.category, path.join(f.root, 'models', 'previous')); await fs.symlink(outside, f.category)
    await assert.rejects(f.manager.preview(baseArgs, { owner }), { code: 'UNSAFE_PATH' })
    assert.deepEqual(await fs.readdir(outside), [])
  }
})

test('real public client integration streams model data and closes rejected unconsumed responses; no network is used', async t => {
  for (const rejectPage of [false, true]) {
    const outgoing = []; const incoming = []
    const webClient = createPublicWebClient({ timeoutMs: LIMITS.timeoutMs, maxBytes: LIMITS.maxBytes,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: (options, callback) => {
        outgoing.push(options)
        const request = new EventEmitter()
        request.destroy = () => {}
        request.end = () => queueMicrotask(() => {
          const stream = Readable.from([body]); stream.statusCode = 200
          stream.headers = { 'content-length': String(body.length), 'content-type': rejectPage ? 'text/html' : 'application/octet-stream' }
          stream.socket = { remoteAddress: '93.184.216.34' }; incoming.push(stream); callback(stream)
        })
        return request
      },
    })
    const f = await fixture(t, { webClient })
    const { job } = await launch(f)
    const done = await settled(f.manager, job.jobId)
    assert.equal(done.state, rejectPage ? 'failed' : 'completed')
    assert.equal(outgoing.length, 1); assert.equal(outgoing[0].method, 'GET')
    assert.equal(outgoing[0].headers.Authorization, undefined)
    assert.equal(incoming[0].destroyed, true)
    if (rejectPage) assert.deepEqual(await fs.readdir(f.category), [])
  }
})

test('native availability is rechecked immediately before network admission, including queued jobs', async t => {
  let allowed = true
  const f = await fixture(t, { assertCanStart: async () => { if (!allowed) throw new Error('private export state') } })
  const { job } = await launch(f)
  allowed = false
  const failed = await settled(f.manager, job.jobId)
  assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'DOWNLOAD_UNAVAILABLE')
  assert.doesNotMatch(JSON.stringify(failed), /private export state/)
  assert.equal(f.requests.length, 0); assert.deepEqual(await fs.readdir(f.category), [])

  let queuedAllowed = true, opened = 0
  const queued = await fixture(t, { maxActive: 1, maxQueued: 1,
    assertCanStart: async () => { if (!queuedAllowed) throw new Error('Export is now active') },
    webClient: { open: async () => { opened++; return new Promise(() => {}) } },
  })
  const first = await launch(queued)
  await until(() => opened === 1)
  const second = await launch(queued, { ...baseArgs, filename: 'waiting.gguf' })
  assert.equal(second.job.state, 'queued')
  queuedAllowed = false
  assert.equal(queued.manager.status({ jobId: first.job.jobId }, { owner }).state, 'downloading', 'An already transferring job is not unexpectedly cancelled by the admission check')
  await queued.manager.cancel({ jobId: first.job.jobId }, { owner })
  const secondFailed = await settled(queued.manager, second.job.jobId)
  assert.equal(secondFailed.error.code, 'DOWNLOAD_UNAVAILABLE'); assert.equal(opened, 1)
  assert.deepEqual(await fs.readdir(queued.category), [])
})
