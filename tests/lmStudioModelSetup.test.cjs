'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const { createHash } = require('node:crypto')
const { createLmStudioModelSetup, normalizeModel, allowedDownloadUrl, CONTEXT } = require('../electron/lmStudioModelSetup.cjs')

const OWNER = 'desktop-one', MODEL = { repository: 'publisher/test-GGUF', filename: 'test-Q4_K_M.gguf' }, REVISION = 'a'.repeat(40)
function gguf(size = 512) { const value = Buffer.alloc(size, 7); value.write('GGUF'); value.writeUInt32LE(3, 4); return value }
function response(value, extra = {}) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))
  return { status: 200, headers: { 'content-length': String(data.length), 'content-type': Buffer.isBuffer(value) ? 'application/octet-stream' : 'application/json' }, body: Readable.from([data]), ...extra }
}
async function fixture(t, overrides = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-lm-model-'))
  const lmHome = path.join(home, '.lmstudio'), models = path.join(home, 'models')
  await fs.mkdir(lmHome); await fs.mkdir(models)
  await fs.writeFile(path.join(lmHome, 'settings.json'), JSON.stringify({ downloadsFolder: models }))
  const bytes = gguf(), hash = createHash('sha256').update(bytes).digest('hex')
  const metadata = { id: MODEL.repository, sha: REVISION, private: false, gated: false, cardData: { license: 'apache-2.0' },
    siblings: [{ rfilename: MODEL.filename, size: bytes.length, lfs: { size: bytes.length, sha256: hash } }, { rfilename: 'LICENSE' }] }
  const calls = [], local = [], approvals = [], guards = [], runtimeCalls = []
  let time = 1000, loaded = false
  const modelKey = `${MODEL.repository}/${MODEL.filename}`
  const manager = createLmStudioModelSetup({ getHomePath: () => home, totalmem: () => 16 * 1024 ** 3, now: () => time,
    confirm: async info => { approvals.push(info); return true }, assertCanStart: async context => { guards.push(context) },
    runtime: { inspect: async () => ({ available: true }), startServer: async args => { runtimeCalls.push(['start', args]) },
      listDownloadedModels: async args => { runtimeCalls.push(['list', args]); return [{ type: 'llm', path: modelKey, modelKey, sizeBytes: bytes.length }] } },
    fetchPublic: async (url, options) => { calls.push({ url, options }); return response(url.includes('/api/models/') ? metadata : bytes, { url }) },
    fetchLocal: async (url, options) => {
      local.push({ url, options })
      if (url.endsWith('/load')) { loaded = true; return response({ type: 'llm', status: 'loaded', instance_id: 'instance-one', load_config: { context_length: 32768 } }, { url }) }
      return response({ models: [{ type: 'llm', key: modelKey, size_bytes: bytes.length, max_context_length: 131072,
        loaded_instances: loaded ? [{ id: 'instance-one', config: { context_length: 32768 } }] : [] }] }, { url })
    }, ...overrides })
  t.after(async () => { await manager.dispose(); await fs.rm(home, { recursive: true, force: true }) })
  return { manager, home, lmHome, models, bytes, hash, metadata, calls, local, approvals, guards, runtimeCalls, modelKey,
    file: path.join(models, ...MODEL.repository.split('/'), MODEL.filename), tick: value => { time += value } }
}
async function plan(f) { const result = await f.manager.plan(MODEL, OWNER); assert.equal(result.success, true, JSON.stringify(result)); return result }
async function settle(f, id, state = 'downloading') {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const value = await f.manager.status({ jobId: id }, OWNER)
    if (value.state !== state) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Synthetic setup did not settle')
}
async function download(f, p) { p ||= await plan(f); const result = await f.manager.download({ planId: p.planId }, OWNER); assert.equal(result.success, true, JSON.stringify(result)); return settle(f, result.jobId) }
async function until(fn) { const deadline = Date.now() + 4000; while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 5)) } assert.fail('Fixture condition not reached') }
async function contextFixture(t, options = {}) {
  let f
  const maximum = Object.hasOwn(options, 'maximum') ? options.maximum : 131072
  const actual = Object.hasOwn(options, 'actual') ? options.actual : Math.min(maximum, 32768)
  const echo = Object.hasOwn(options, 'echo') ? options.echo : actual
  const trace = { posts: [], loaded: options.preloaded === true, catalogReads: 0 }
  f = await fixture(t, { fetchLocal: async (url, request) => {
    if (request.method === 'POST') {
      trace.posts.push(JSON.parse(request.body)); trace.loaded = true
      return response({ type: 'llm', status: 'loaded', instance_id: 'context-instance',
        ...(echo === 'omit' ? {} : { load_config: { context_length: echo } }) }, { url })
    }
    trace.catalogReads++
    const finalMaximum = trace.catalogReads > 1 && Object.hasOwn(options, 'finalMaximum') ? options.finalMaximum : maximum
    const instance = { id: 'context-instance', config: { context_length: actual } }
    return response({ models: [{ type: 'llm', key: f.modelKey, size_bytes: f.bytes.length,
      max_context_length: finalMaximum, loaded_instances: trace.loaded ? options.duplicateInstance ? [instance, instance] : [instance] : [] }] }, { url })
  } })
  return Object.assign(f, { trace })
}

test('plan is read-only, pinned exact metadata with license, size and redacted destination', async t => {
  const f = await fixture(t), p = await plan(f)
  assert.equal(p.revision, REVISION); assert.equal(p.bytes, f.bytes.length); assert.equal(p.sha256, f.hash)
  assert.equal(p.license.name, 'apache-2.0'); assert.ok(p.license.url.includes(`/blob/${REVISION}/LICENSE`))
  assert.equal(p.canDownload, true); assert.equal(JSON.stringify(p).includes(f.home), false)
  assert.equal(p.contextTargetTokens, 32768); assert.equal(p.contextPolicy, 'model-capped')
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(row => row.url.includes('/api/models/')))
  assert.deepEqual(await fs.readdir(f.models), []); assert.equal(f.approvals.length, 0); assert.equal(f.local.length, 0)
})

test('strict arguments reject URLs, paths, MLX, shards, traversal and reserved names', () => {
  for (const value of [ { ...MODEL, owner: OWNER }, { ...MODEL, repository: 'https://huggingface.co/a/b' }, { ...MODEL, filename: '../test.gguf' },
    { ...MODEL, filename: 'test-00001-of-00002.gguf' }, { ...MODEL, filename: 'model.safetensors' }, { ...MODEL, filename: 'CON.gguf' } ]) assert.throws(() => normalizeModel(value))
  assert.deepEqual(normalizeModel(MODEL), MODEL)
  assert.equal(normalizeModel({ ...MODEL, filename: `${'a'.repeat(175)}.gguf` }).filename.length, 180)
  assert.throws(() => normalizeModel({ ...MODEL, filename: `${'a'.repeat(176)}.gguf` }))
  assert.throws(() => normalizeModel({ ...MODEL, repository: `${'a'.repeat(80)}/${'b'.repeat(80)}` }))
  assert.equal(allowedDownloadUrl('https://127.0.0.1/test', 'https://huggingface.co/a'), false)
  assert.equal(allowedDownloadUrl('https://cas-bridge.xethub.hf.co/x?X-Amz-Signature=opaque', 'https://huggingface.co/a'), true)
  assert.equal(allowedDownloadUrl('https://us.aws.cdn.hf.co/x?X-Amz-Signature=opaque', 'https://huggingface.co/a'), true)
  for (const url of ['https://us.aws.cdn.hf.co.evil.test/x', 'https://evil.us.aws.cdn.hf.co/x', 'https://us-aws.cdn.hf.co/x', 'https://us.aws.cdn.hf.co:444/x']) {
    assert.equal(allowedDownloadUrl(url, 'https://huggingface.co/a'), false)
  }
})

test('explicit download approval then no-overwrite GGUF/hash import and separate verified load', async t => {
  const f = await fixture(t), job = await download(f)
  assert.equal(job.state, 'completed', JSON.stringify(job)); assert.equal(job.canLoad, true); assert.equal(job.connectionVerified, false)
  assert.equal(job.contextTargetTokens, 32768); assert.equal(job.requestedContextTokens, null); assert.equal(job.modelMaxContextTokens, null)
  assert.equal(job.effectiveContextTokens, null); assert.equal(job.contextVerified, false)
  assert.deepEqual(await fs.readFile(f.file), f.bytes); assert.deepEqual(await fs.readdir(path.dirname(f.file)), [MODEL.filename])
  assert.equal(f.approvals.length, 1); assert.equal(f.approvals[0].destination, f.file); assert.equal(f.approvals[0].action, 'download')
  assert.equal(f.local.length, 0)
  const started = await f.manager.load({ jobId: job.jobId }, OWNER)
  assert.equal(started.state, 'loading'); assert.equal(started.connectionVerified, false)
  const ready = await settle(f, job.jobId, 'loading')
  assert.equal(ready.state, 'ready', JSON.stringify(ready)); assert.equal(ready.connectionVerified, true)
  assert.equal(f.approvals.length, 2); assert.equal(f.approvals[1].action, 'load')
  assert.equal(f.approvals[1].contextTargetTokens, 32768); assert.equal(f.approvals[1].contextPolicy, 'model-capped')
  assert.equal(ready.requestedContextTokens, 32768); assert.equal(ready.modelMaxContextTokens, 131072)
  assert.equal(ready.effectiveContextTokens, 32768); assert.equal(ready.contextVerified, true)
  assert.deepEqual(JSON.parse(f.local.find(row => row.url.endsWith('/load')).options.body), { model: f.modelKey, context_length: 32768, echo_load_config: true })
  assert.ok(f.local.every(row => row.url.startsWith('http://127.0.0.1:1234/api/v1/models')))
  assert.ok(ready.warning.includes('current agent, model and chat are unchanged'))
  assert.match(ready.warning, /not a memory-fit guarantee/)
})

test('context policy requests 32768 or a smaller verified model limit, not the full maximum', async t => {
  assert.equal(CONTEXT.targetTokens, 32768); assert.equal(CONTEXT.maximumMetadataTokens, 1048576)
  for (const maximum of [8192, 16384, 32768, 40960, 131072, 1048576]) {
    const f = await contextFixture(t, { maximum }), job = await download(f)
    await f.manager.load({ jobId: job.jobId }, OWNER)
    const result = await settle(f, job.jobId, 'loading'), expected = Math.min(32768, maximum)
    assert.equal(result.state, 'ready', JSON.stringify(result)); assert.equal(result.contextVerified, true)
    assert.equal(result.contextTargetTokens, 32768); assert.equal(result.modelMaxContextTokens, maximum)
    assert.equal(result.requestedContextTokens, expected); assert.equal(result.effectiveContextTokens, expected)
    assert.deepEqual(f.trace.posts, [{ model: f.modelKey, context_length: expected, echo_load_config: true }])
  }
})

test('missing or invalid maximum context fails before POST instead of falling back to 4096', async t => {
  for (const maximum of [undefined, null, 0, -1, 8192.5, '32768', true, 1048577, Number.MAX_SAFE_INTEGER]) {
    const f = await contextFixture(t, { maximum }), job = await download(f)
    await f.manager.load({ jobId: job.jobId }, OWNER)
    const result = await settle(f, job.jobId, 'loading')
    assert.equal(result.state, 'completed'); assert.equal(result.error.code, 'LM_CONTEXT_UNAVAILABLE', String(maximum))
    assert.equal(result.modelMaxContextTokens, null); assert.equal(result.requestedContextTokens, null)
    assert.equal(result.contextVerified, false); assert.equal(result.connectionVerified, false); assert.deepEqual(f.trace.posts, [])
    assert.match(result.error.message, /no model load was requested/)
  }
})

test('ready requires the exact instance effective context and consistent load echo', async t => {
  for (const options of [{ actual: undefined, echo: 'omit' }, { actual: 4096 }, { actual: 65536 }, { actual: '32768' }, { actual: 131073 },
    { actual: 32768, echo: 4096 }, { actual: 32768, echo: null }, { actual: 32768, echo: undefined },
    { actual: 32768, finalMaximum: 16384 }, { actual: 32768, finalMaximum: undefined }, { duplicateInstance: true }]) {
    const f = await contextFixture(t, options), job = await download(f)
    await f.manager.load({ jobId: job.jobId }, OWNER)
    const result = await settle(f, job.jobId, 'loading')
    assert.equal(result.state, 'completed', JSON.stringify(options)); assert.equal(result.error.code, 'LM_CONTEXT_UNCONFIRMED')
    assert.equal(result.contextVerified, false); assert.equal(result.connectionVerified, false); assert.equal(result.canLoad, false)
    assert.equal(f.trace.posts.length, 1); assert.equal((await f.manager.load({ jobId: job.jobId }, OWNER)).code, 'NOT_LOADABLE')
    assert.match(result.warning, /will not automatically repeat or unload/)
  }
})

test('missing optional load echo can rely on authoritative exact instance config', async t => {
  const f = await contextFixture(t, { echo: 'omit' }), job = await download(f)
  await f.manager.load({ jobId: job.jobId }, OWNER)
  const result = await settle(f, job.jobId, 'loading')
  assert.equal(result.state, 'ready'); assert.equal(result.effectiveContextTokens, 32768); assert.equal(result.contextVerified, true)
})

test('existing loaded models with small or unknown context stay untouched', async t => {
  for (const actual of [4096, undefined, null, '32768', 131073]) {
    const f = await contextFixture(t, { preloaded: true, actual }), job = await download(f)
    await f.manager.load({ jobId: job.jobId }, OWNER)
    const result = await settle(f, job.jobId, 'loading')
    assert.equal(result.state, 'completed'); assert.equal(result.error.code, actual === 4096 ? 'LM_CONTEXT_TOO_SMALL' : 'LM_CONTEXT_UNAVAILABLE')
    assert.equal(result.contextVerified, false); assert.equal(result.connectionVerified, false)
    assert.deepEqual(f.trace.posts, []); assert.equal(f.trace.loaded, true)
    assert.match(result.error.message, actual === 4096 ? /did not reload or unload/ : /left it loaded and unchanged/)
  }
})

test('sufficient existing instance context is verified without any reload or settings change', async t => {
  const f = await contextFixture(t, { preloaded: true, actual: 65536 }), job = await download(f)
  const settingsBefore = await fs.readFile(path.join(f.lmHome, 'settings.json'), 'utf8')
  await f.manager.load({ jobId: job.jobId }, OWNER)
  const result = await settle(f, job.jobId, 'loading')
  assert.equal(result.state, 'ready'); assert.equal(result.requestedContextTokens, 32768); assert.equal(result.effectiveContextTokens, 65536)
  assert.equal(result.contextVerified, true); assert.deepEqual(f.trace.posts, [])
  assert.equal(await fs.readFile(path.join(f.lmHome, 'settings.json'), 'utf8'), settingsBefore)
})

test('declined confirmation does not consume plan or write any files', async t => {
  let approved = false
  const f = await fixture(t, { confirm: async () => approved }), p = await plan(f)
  assert.equal((await f.manager.download({ planId: p.planId }, OWNER)).code, 'DECLINED')
  assert.deepEqual(await fs.readdir(f.models), [])
  approved = true; assert.equal((await download(f, p)).state, 'completed')
  assert.equal((await f.manager.download({ planId: p.planId }, OWNER)).code, 'PLAN_EXPIRED')
})

test('expired and foreign plan/job ids and arbitrary payload fields are rejected', async t => {
  const f = await fixture(t), p = await plan(f)
  assert.equal((await f.manager.download({ planId: p.planId }, 'other')).code, 'PLAN_EXPIRED')
  f.tick(300001); assert.equal((await f.manager.download({ planId: p.planId }, OWNER)).code, 'PLAN_EXPIRED')
  const job = await download(f)
  assert.equal((await f.manager.cancel({ jobId: job.jobId }, 'other')).code, 'UNKNOWN_JOB')
  assert.equal((await f.manager.load({ jobId: job.jobId, model: 'other' }, OWNER)).code, 'INVALID_ARGUMENTS')
})

test('gated/private, unknown license, unknown hash/size and mutable revisions fail closed', async t => {
  for (const mutate of [j => { j.gated = 'auto' }, j => { j.private = true }, j => { j.cardData.license = 'unknown' },
    j => { delete j.siblings[0].lfs.sha256 }, j => { j.siblings[0].lfs.size = null }, j => { j.sha = 'main' }]) {
    const f = await fixture(t); mutate(f.metadata)
    const p = await f.manager.plan(MODEL, OWNER)
    assert.equal(p.success, false); assert.equal(f.approvals.length, 0)
  }
})

test('existing model is never overwritten and plan advises reuse', async t => {
  const f = await fixture(t); await fs.mkdir(path.dirname(f.file), { recursive: true }); await fs.writeFile(f.file, 'existing')
  const p = await plan(f); assert.equal(p.canDownload, false)
  assert.equal((await f.manager.download({ planId: p.planId }, OWNER)).code, 'DESTINATION_EXISTS')
  assert.equal(await fs.readFile(f.file, 'utf8'), 'existing')
})

test('changed root during confirmation blocks download without touching other root', async t => {
  let f
  f = await fixture(t, { confirm: async () => { const another = path.join(f.home, 'other'); await fs.mkdir(another); await fs.writeFile(path.join(f.lmHome, 'settings.json'), JSON.stringify({ downloadsFolder: another })); return true } })
  const p = await plan(f), result = await f.manager.download({ planId: p.planId }, OWNER)
  assert.equal(result.code, 'DESTINATION_CHANGED'); assert.deepEqual(await fs.readdir(f.models), []); assert.deepEqual(await fs.readdir(path.join(f.home, 'other')), [])
})

test('symlink destination and settings paths are rejected', async t => {
  const f = await fixture(t), other = path.join(f.home, 'other'); await fs.mkdir(other)
  await fs.symlink(other, path.join(f.models, 'publisher'), 'dir')
  assert.equal((await f.manager.plan(MODEL, OWNER)).code, 'UNSAFE_DESTINATION')
})

test('strict redirect allowlist rejects SSRF and unreviewed auto redirects', async t => {
  for (const url of ['http://127.0.0.1:1234/x', 'https://example.com/model.gguf', 'https://huggingface.co.evil.test/x', 'https://cas-bridge.xethub.hf.co:444/x']) {
    let f
    f = await fixture(t, { fetchPublic: async (source, options) => source.includes('/api/models/') ? response(f.metadata, { url: source })
      : response(Buffer.alloc(0), { status: 302, headers: { location: url } }) })
    const job = await download(f); assert.equal(job.state, 'failed'); assert.equal(job.error.code, 'BLOCKED_SOURCE')
    assert.deepEqual(await fs.readdir(path.dirname(f.file)), [])
  }
})

test('exact observed Hugging Face AWS CDN redirect downloads only the approved hash and size', async t => {
  let f
  const followed = [], cdn = 'https://us.aws.cdn.hf.co/cas-bridge/owned-test-file?X-Amz-Signature=fixture-only'
  f = await fixture(t, { fetchPublic: async (url, options) => {
    followed.push(url)
    if (url.includes('/api/models/')) return response(f.metadata, { url })
    if (url.includes('/resolve/')) return response(Buffer.alloc(0), { status: 302, url, headers: { location: cdn } })
    assert.equal(url, cdn); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual')
    return response(f.bytes, { url })
  } })
  const job = await download(f)
  assert.equal(job.state, 'completed', JSON.stringify(job)); assert.deepEqual(await fs.readFile(f.file), f.bytes)
  assert.equal(followed.filter(url => url === cdn).length, 1)
  assert.equal(JSON.stringify(job).includes('X-Amz'), false)
  assert.equal(JSON.stringify(f.approvals).includes('X-Amz'), false)
})

test('known length, byte cap, hash and GGUF header are enforced', async t => {
  for (const kind of ['length', 'excess', 'hash', 'header']) {
    let f
    f = await fixture(t, { fetchPublic: async url => {
      if (url.includes('/api/models/')) return response(f.metadata, { url })
      const value = kind === 'excess' ? Buffer.concat([f.bytes, Buffer.from('x')]) : kind === 'hash' ? Buffer.alloc(f.bytes.length) : f.bytes
      return response(value, { url, headers: { 'content-length': String(kind === 'length' ? 100 : f.bytes.length) } })
    } })
    if (kind === 'header') { f.bytes.write('NOPE'); f.metadata.siblings[0].lfs.sha256 = createHash('sha256').update(f.bytes).digest('hex') }
    const job = await download(f); assert.equal(job.state, 'failed', kind)
    assert.deepEqual(await fs.readdir(path.dirname(f.file)), [])
  }
})

test('cancel stops only the owned transfer and cleans only its partial', async t => {
  let f, streaming = false
  f = await fixture(t, { fetchPublic: async (url, { signal }) => {
    if (url.includes('/api/models/')) return response(f.metadata, { url })
    const body = new Readable({ read() {} }); body.push(f.bytes.subarray(0, 24)); streaming = true
    signal.addEventListener('abort', () => body.destroy(), { once: true })
    return response(f.bytes, { url, body })
  } })
  const p = await plan(f), started = await f.manager.download({ planId: p.planId }, OWNER)
  await until(() => streaming)
  await fs.writeFile(path.join(path.dirname(f.file), 'other.partial'), 'keep')
  const cancelled = await f.manager.cancel({ jobId: started.jobId }, OWNER)
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.canLoad, false)
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['other.partial'])
})

test('final no-clobber commit preserves a file created during transfer', async t => {
  let f
  f = await fixture(t, { fetchPublic: async url => {
    if (url.includes('/api/models/')) return response(f.metadata, { url })
    await fs.writeFile(f.file, 'user file')
    return response(f.bytes, { url })
  } })
  const job = await download(f)
  assert.equal(job.state, 'failed'); assert.equal(await fs.readFile(f.file, 'utf8'), 'user file')
})

test('export/session guard after approval prevents side effects and public errors hide raw details', async t => {
  let busy = false
  const f = await fixture(t, { confirm: async () => { busy = true; return true }, assertCanStart: async () => { if (busy) throw Error('/private/path?secret=abc') } }), p = await plan(f)
  const result = await f.manager.download({ planId: p.planId }, OWNER)
  assert.equal(result.success, false); assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.deepEqual(await fs.readdir(f.models), [])
})

test('changed completed model cannot be loaded', async t => {
  const f = await fixture(t), job = await download(f)
  await fs.writeFile(f.file, Buffer.alloc(f.bytes.length))
  await f.manager.load({ jobId: job.jobId }, OWNER)
  const result = await settle(f, job.jobId, 'loading')
  assert.equal(result.state, 'completed'); assert.equal(result.canLoad, false); assert.equal(result.connectionVerified, false)
  assert.equal(f.local.filter(row => row.options.method === 'POST').length, 0)
})

test('replacement during the final CLI lookup is detected before any model load', async t => {
  let f
  f = await fixture(t, { runtime: { listDownloadedModels: async () => {
    await fs.writeFile(f.file, Buffer.alloc(f.bytes.length))
    return [{ type: 'llm', path: f.modelKey, modelKey: f.modelKey, sizeBytes: f.bytes.length }]
  } } })
  const job = await download(f); await f.manager.load({ jobId: job.jobId }, OWNER)
  const result = await settle(f, job.jobId, 'loading')
  assert.equal(result.error.code, 'MODEL_CHANGED'); assert.equal(result.canLoad, false)
  assert.equal(f.local.filter(row => row.options.method === 'POST').length, 0)
})

test('authentication rejection never starts server or bypasses auth', async t => {
  const f = await fixture(t, { fetchLocal: async () => response({}, { status: 401 }) }), job = await download(f)
  await f.manager.load({ jobId: job.jobId }, OWNER)
  const result = await settle(f, job.jobId, 'loading')
  assert.equal(result.error.code, 'LM_AUTH_REQUIRED'); assert.equal(result.connectionVerified, false)
  assert.equal(f.runtimeCalls.length, 0)
})

test('offline server starts once only after approved load, then exact instance is verified', async t => {
  let f, requests = 0, loaded = false
  f = await fixture(t, { fetchLocal: async (url, options) => {
    if (++requests === 1) throw Error('ECONNREFUSED')
    if (url.endsWith('/load')) { loaded = true; return response({ type: 'llm', status: 'loaded', instance_id: 'local-instance' }, { url }) }
    return response({ models: [{ type: 'llm', key: f.modelKey, size_bytes: f.bytes.length, max_context_length: 32768,
      loaded_instances: loaded ? [{ id: 'local-instance', config: { context_length: 32768 } }] : [] }] }, { url })
  } })
  const job = await download(f); assert.equal(f.runtimeCalls.length, 0)
  await f.manager.load({ jobId: job.jobId }, OWNER)
  assert.equal((await settle(f, job.jobId, 'loading')).state, 'ready')
  assert.equal(f.runtimeCalls.filter(row => row[0] === 'start').length, 1)
})

test('unconfirmed accepted load is not retried and never falsely ready', async t => {
  let f, posts = 0
  f = await fixture(t, { fetchLocal: async (url, options) => {
    if (url.endsWith('/load')) { posts++; return response({ type: 'llm', status: 'loaded', instance_id: 'not-in-list' }, { url }) }
    return response({ models: [{ type: 'llm', key: f.modelKey, size_bytes: f.bytes.length, max_context_length: 32768, loaded_instances: [] }] }, { url })
  } })
  const job = await download(f); await f.manager.load({ jobId: job.jobId }, OWNER)
  const result = await settle(f, job.jobId, 'loading')
  assert.equal(result.state, 'completed'); assert.equal(result.canLoad, false); assert.equal(result.connectionVerified, false)
  assert.equal((await f.manager.load({ jobId: job.jobId }, OWNER)).code, 'NOT_LOADABLE'); assert.equal(posts, 1)
})

test('grouped REST row uses exact CLI variant key and verifies returned instance in group', async t => {
  let f, loaded = false, sent
  const variant = 'publisher/test@q4_k_m'
  f = await fixture(t, { runtime: { listDownloadedModels: async () => [{ type: 'llm', path: `${MODEL.repository}/${MODEL.filename}`, modelKey: variant, sizeBytes: f.bytes.length }] },
    fetchLocal: async (url, options) => {
      if (url.endsWith('/load')) { sent = JSON.parse(options.body); loaded = true; return response({ type: 'llm', status: 'loaded', instance_id: 'variant-instance' }, { url }) }
      return response({ models: [{ type: 'llm', key: 'publisher/test', variants: [variant, 'publisher/test@q8'], selected_variant: 'publisher/test@q8', size_bytes: 999, max_context_length: 32768,
        loaded_instances: loaded ? [{ id: 'variant-instance', config: { context_length: 32768 } }] : [] }] }, { url })
    } })
  const job = await download(f); await f.manager.load({ jobId: job.jobId }, OWNER)
  const result = await settle(f, job.jobId, 'loading')
  assert.equal(result.state, 'ready', JSON.stringify(result)); assert.equal(sent.model, variant)
})

test('grouped preloaded instance is ambiguous and is not adopted or unloaded', async t => {
  let f, posts = 0
  const variant = 'publisher/test@q4_k_m'
  f = await fixture(t, { runtime: { listDownloadedModels: async () => [{ type: 'llm', path: `${MODEL.repository}/${MODEL.filename}`, modelKey: variant, sizeBytes: f.bytes.length }] },
    fetchLocal: async (url, options) => {
      if (options.method === 'POST') posts++
      return response({ models: [{ type: 'llm', key: 'publisher/test', variants: [variant], size_bytes: f.bytes.length, max_context_length: 32768,
        loaded_instances: [{ id: 'existing', config: { context_length: 32768 } }] }] }, { url })
    } })
  const job = await download(f); await f.manager.load({ jobId: job.jobId }, OWNER)
  const result = await settle(f, job.jobId, 'loading')
  assert.equal(result.connectionVerified, false); assert.equal(result.error.code, 'LM_IDENTITY_UNAVAILABLE'); assert.equal(posts, 0)
})

test('owner close revokes pending plans and a late approval cannot create a job', async t => {
  let answer
  const f = await fixture(t, { confirm: () => new Promise(resolve => { answer = resolve }) }), p = await plan(f)
  const pending = f.manager.download({ planId: p.planId }, OWNER)
  await until(() => answer); await f.manager.cancelOwner(OWNER); answer(true)
  assert.equal((await pending).code, 'SESSION_CLOSED'); assert.deepEqual(await fs.readdir(f.models), [])
})

test('low disk space and absent/invalid LM settings never infer a writable default', async t => {
  const f = await fixture(t, { fs: { ...fs, statfs: async () => ({ bavail: 0, bsize: 4096 }) } })
  assert.equal((await f.manager.plan(MODEL, OWNER)).code, 'INSUFFICIENT_SPACE')
  const g = await fixture(t); await fs.writeFile(path.join(g.lmHome, 'settings.json'), '{}')
  assert.equal((await g.manager.plan(MODEL, OWNER)).code, 'LM_NOT_CONFIGURED'); assert.deepEqual(await fs.readdir(g.models), [])
})

test('synchronous export guard after final temporary-file stat prevents atomic model commit', async t => {
  let exported = false, links = 0
  const f = await fixture(t, { fs: { ...fs,
    lstat: async file => { const stat = await fs.lstat(file); if (String(file).endsWith('.partial') && stat.size === 512) exported = true; return stat },
    link: async (...args) => { links++; return fs.link(...args) },
  }, assertCanCommit: ({ action }) => { assert.equal(action, 'download-commit'); if (exported) throw Error('Export owns resources') } })
  const job = await download(f)
  assert.equal(job.state, 'failed'); assert.equal(links, 0); assert.deepEqual(await fs.readdir(path.dirname(f.file)), [])
})

test('synchronous export guard after final verification close prevents model load', async t => {
  let exported = false
  const f = await fixture(t, { fs: { ...fs, open: async (file, ...args) => {
    const handle = await fs.open(file, ...args)
    return new Proxy(handle, { get(target, key) {
      if (key === 'close') return async () => { await target.close(); if (String(file).endsWith('.gguf')) exported = true }
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value
    } })
  } }, assertCanCommit: ({ action }) => { if (action === 'load-commit' && exported) throw Error('Export owns resources') } })
  const job = await download(f); await f.manager.load({ jobId: job.jobId }, OWNER)
  const result = await settle(f, job.jobId, 'loading')
  assert.equal(result.state, 'completed'); assert.equal(result.connectionVerified, false)
  assert.equal(f.local.filter(row => row.options.method === 'POST').length, 0)
})

test('asynchronous commit guard is rejected instead of silently permitting effects', async t => {
  const f = await fixture(t, { assertCanCommit: async () => {} }), job = await download(f)
  assert.equal(job.state, 'failed'); assert.equal(job.error.code, 'INVALID_COMMIT_GUARD')
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), [])
})

test('terminal download state and next work wait for owned partial cleanup', async t => {
  for (const fails of [false, true]) {
    let f, release, cleaning = false
    const cleanupGate = new Promise(resolve => { release = resolve })
    f = await fixture(t, { fs: { ...fs, unlink: async file => {
      if (String(file).endsWith('.partial')) { cleaning = true; await cleanupGate }
      return fs.unlink(file)
    } }, fetchPublic: async url => url.includes('/api/models/') ? response(f.metadata, { url })
      : fails ? response(Buffer.alloc(0), { status: 302, url, headers: { location: 'https://blocked.example/model.gguf' } })
        : response(f.bytes, { url }) })
    try {
      const p = await plan(f), started = await f.manager.download({ planId: p.planId }, OWNER)
      await until(() => cleaning)
      const pending = await f.manager.status({ jobId: started.jobId }, OWNER)
      assert.equal(pending.state, 'downloading'); assert.equal(pending.canLoad, false)
      assert.equal((await f.manager.load({ jobId: started.jobId }, OWNER)).code, 'NOT_LOADABLE')
      assert.equal((await fs.readdir(path.dirname(f.file))).some(name => name.endsWith('.partial')), true)
      if (fails) {
        const another = await plan(f)
        assert.equal((await f.manager.download({ planId: another.planId }, OWNER)).code, 'BUSY')
      }
      release()
      const result = await settle(f, started.jobId)
      assert.equal(result.state, fails ? 'failed' : 'completed')
      assert.equal((await fs.readdir(path.dirname(f.file))).some(name => name.endsWith('.partial')), false)
    } finally { release() }
  }
})

test('accepted model commit remains completed with warning when partial cleanup fails', async t => {
  const f = await fixture(t, { fs: { ...fs, unlink: async file => {
    if (String(file).endsWith('.partial')) throw Object.assign(Error('fixture cleanup denied'), { code: 'EACCES' })
    return fs.unlink(file)
  } } })
  const job = await download(f)
  assert.equal(job.state, 'completed'); assert.match(job.warning, /model was saved.*cleanup could not finish/)
  assert.deepEqual(await fs.readFile(f.file), f.bytes)
  assert.equal((await f.manager.cancel({ jobId: job.jobId }, OWNER)).state, 'completed')
})
