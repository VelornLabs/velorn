'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const { createToolSetupInstaller, CATALOG, LIMITS, allowedUrl } = require('../electron/toolSetupInstaller.cjs')

const OWNER = 'desktop-document-1'
const LM_FILE = 'https://installers.lmstudio.ai/darwin/arm64/0.4.25-1/LM-Studio-0.4.25-1-arm64.dmg'
function dmg(size = 1024) { const value = Buffer.alloc(size, 7); value.write('koly', size - 512); return value }
function response(data = dmg(), overrides = {}) {
  return { status: 200, headers: { 'content-length': String(data.length), 'content-type': 'application/octet-stream' }, body: Readable.from([data]), ...overrides }
}
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-tool-setup-'))
  const downloads = path.join(root, 'Downloads')
  await fs.mkdir(downloads)
  const calls = [], approvals = [], opens = [], guards = [], quarantine = []
  let time = 1000
  const manager = createToolSetupInstaller({ getDownloadsPath: () => downloads,
    optionalSetup: { inspect: async integration => ({ success: true, ...integration, state: 'unavailable', summary: 'Not responding.' }) },
    confirm: async value => { approvals.push(value); return true },
    openPath: async (file, context) => { await context.beforeOpen(); opens.push({ file, context }); return '' },
    assertCanStart: async value => { guards.push(value) },
    markQuarantine: async (file, value) => { quarantine.push({ file, value }) },
    fetch: async (url, options) => { calls.push({ url, ...options }); return response() },
    platform: 'darwin', arch: 'arm64', release: '25.0.0', totalmem: 16 * 1024 ** 3, homeDir: root,
    now: () => time, ...overrides })
  t.after(async () => { await manager.dispose(); await fs.rm(root, { recursive: true, force: true }) })
  return { manager, root, downloads, calls, approvals, opens, guards, quarantine, tick: amount => { time += amount } }
}
async function planned(f, integration = 'comfyui') {
  const plan = await f.manager.plan({ integration }, OWNER)
  assert.equal(plan.success, true, JSON.stringify(plan))
  return plan
}
async function completed(f, plan = null) {
  plan ||= await planned(f)
  const job = await f.manager.download({ planId: plan.planId }, OWNER)
  assert.equal(job.success, true, JSON.stringify(job))
  const limit = Date.now() + 3000
  while (Date.now() < limit) {
    const current = await f.manager.status({ jobId: job.jobId }, OWNER)
    if (current.state !== 'downloading') return current
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Synthetic download did not settle')
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail('Synthetic condition did not settle')
}

test('planning is read-only, paths redacted, metadata only, and tools stay optional', async t => {
  const f = await fixture(t), plan = await planned(f)
  assert.equal(plan.download.canDownload, true)
  assert.equal(plan.download.bytes, 1024)
  assert.match(plan.download.destination, /^Downloads\/Velorn Setup\/Comfy-Desktop-[a-f0-9-]+\.dmg$/)
  assert.equal(JSON.stringify(plan).includes(f.root), false)
  assert.deepEqual(f.calls.map(value => value.method), ['HEAD'])
  assert.equal(f.approvals.length, 0)
  assert.deepEqual(await fs.readdir(f.downloads), [])
  assert.ok(plan.warnings.some(value => /optional/.test(value)))
  assert.ok(plan.steps.some(value => /Standalone/.test(value)))
})

test('download requires explicit native approval, then separate verified OS opening', async t => {
  const f = await fixture(t), plan = await planned(f), job = await completed(f, plan)
  assert.equal(job.state, 'completed', JSON.stringify(job))
  assert.equal(job.canOpen, true)
  assert.equal(f.quarantine.length, 1)
  assert.match(f.quarantine[0].value, /^0083;[a-f0-9]+;Velorn;[a-f0-9-]+$/)
  assert.equal(f.approvals.length, 1)
  assert.equal(f.approvals[0].owner, OWNER)
  assert.equal(f.approvals[0].action, 'download')
  assert.equal(f.approvals[0].bytes, 1024)
  assert.equal(f.opens.length, 0)
  await until(async () => (await fs.readdir(path.join(f.downloads, 'Velorn Setup'))).length === 1)
  const result = await f.manager.open({ jobId: job.jobId }, OWNER)
  assert.equal(result.opened, true)
  assert.equal(result.installed, false)
  assert.deepEqual(f.approvals.map(value => value.action), ['download', 'open'])
  assert.equal(f.opens[0].context.owner, OWNER)
  assert.equal(await fs.readFile(f.opens[0].file).then(value => value.equals(dmg())), true)
  assert.ok(f.guards.some(value => value.action === 'download-background'))
  assert.ok(f.guards.some(value => value.action === 'open-verification'))
})

test('completed status is withheld until partial hardlink cleanup so immediate opening cannot race ctime', async t => {
  let releaseCleanup, unlinkStarted = false
  const waitCleanup = new Promise(resolve => { releaseCleanup = resolve })
  const f = await fixture(t, { fs: { ...fs, unlink: async file => {
    unlinkStarted = true; await waitCleanup; return fs.unlink(file)
  } } })
  const plan = await planned(f), job = await f.manager.download({ planId: plan.planId }, OWNER)
  try {
    await until(() => unlinkStarted)
    const pending = await f.manager.status({ jobId: job.jobId }, OWNER)
    assert.equal(pending.state, 'downloading')
    assert.equal(pending.canOpen, false)
    assert.equal((await f.manager.open({ jobId: job.jobId }, OWNER)).code, 'NOT_COMPLETED')
  } finally { releaseCleanup() }
  await until(async () => (await f.manager.status({ jobId: job.jobId }, OWNER)).state === 'completed')
  assert.equal((await f.manager.open({ jobId: job.jobId }, OWNER)).opened, true)
})

test('declined download retains plan but produces no file or GET', async t => {
  let approved = false
  const f = await fixture(t, { confirm: async () => approved }), plan = await planned(f)
  assert.equal((await f.manager.download({ planId: plan.planId }, OWNER)).code, 'DECLINED')
  assert.deepEqual(f.calls.map(value => value.method), ['HEAD'])
  assert.deepEqual(await fs.readdir(f.downloads), [])
  approved = true
  assert.equal((await completed(f, plan)).state, 'completed')
})

test('missing or failed native confirmation never downloads and errors are sanitized', async t => {
  for (const confirm of [undefined, async () => { throw new Error('/private/password-token') }]) {
    const f = await fixture(t, { confirm }), plan = await planned(f)
    const result = await f.manager.download({ planId: plan.planId }, OWNER)
    assert.equal(result.success, false)
    assert.doesNotMatch(JSON.stringify(result), /password-token/)
    assert.deepEqual(f.calls.map(value => value.method), ['HEAD'])
  }
})

test('expired, foreign, replayed and extra-argument plans are rejected', async t => {
  const f = await fixture(t), plan = await planned(f)
  assert.equal((await f.manager.download({ planId: plan.planId }, 'foreign')).code, 'INVALID_PLAN')
  assert.equal((await f.manager.download({ planId: plan.planId, url: CATALOG.comfyui.source }, OWNER)).code, 'INVALID_REQUEST')
  assert.equal((await f.manager.plan({ integration: 'constructor' }, OWNER)).code, 'INVALID_REQUEST')
  f.tick(LIMITS.planMs + 1)
  assert.equal((await f.manager.download({ planId: plan.planId }, OWNER)).code, 'INVALID_PLAN')
  const current = await planned(f)
  assert.equal((await completed(f, current)).state, 'completed')
  assert.equal((await f.manager.download({ planId: current.planId }, OWNER)).code, 'INVALID_PLAN')
})

test('Windows, Linux, Intel Mac and too-old macOS provide guides without download probes', async t => {
  for (const config of [{ platform: 'win32', arch: 'x64' }, { platform: 'linux', arch: 'x64' },
    { platform: 'darwin', arch: 'x64' }, { platform: 'darwin', release: '21.6.0' }]) {
    const f = await fixture(t, config), plan = await planned(f)
    assert.equal(plan.download.supported, false)
    assert.equal(plan.download.canDownload, false)
    assert.equal(f.calls.length, 0)
    assert.equal(plan.download.sourceUrl, plan.guideUrl)
  }
  const f = await fixture(t, { release: '22.6.0' })
  assert.equal((await planned(f, 'lmstudio')).download.supported, false)
  assert.equal((await planned(f)).download.supported, true)
})

test('working connection or either current/legacy installed Comfy app prevents duplicate download', async t => {
  const ready = await fixture(t, { optionalSetup: { inspect: async () => ({ state: 'ready', success: true }) } })
  assert.equal((await planned(ready)).download.canDownload, false)
  assert.equal(ready.calls.length, 0)
  for (const name of ['Comfy Desktop.app', 'ComfyUI.app', 'LM Studio.app']) {
    const f = await fixture(t)
    const contents = path.join(f.root, 'Applications', name, 'Contents')
    await fs.mkdir(contents, { recursive: true }); await fs.writeFile(path.join(contents, 'Info.plist'), 'fixture')
    const plan = await planned(f, name.startsWith('LM ') ? 'lmstudio' : 'comfyui')
    assert.equal(plan.installation.found, true)
    assert.equal(plan.download.canDownload, false)
    assert.equal(f.calls.length, 0)
  }
})

test('responding service without loaded models, alternate ports, and unknown checks never enable reinstallation', async t => {
  for (const [integration, readiness] of [['lmstudio', { success: true, state: 'needs-model' }],
    ['lmstudio', { success: true, state: 'problem' }], ['comfyui', { success: true, state: 'unavailable', connections: [{ port: 8189 }] }],
    ['comfyui', { success: false, code: 'BUSY' }], ['lmstudio', { success: false, code: 'SETUP_UNAVAILABLE' }]]) {
    const f = await fixture(t, { optionalSetup: { inspect: async () => readiness } }), plan = await planned(f, integration)
    assert.equal(plan.download.canDownload, false)
    assert.equal(f.calls.length, 0)
  }
})

test('LM official redirect resolves to fixed-version source and approved GET uses that URL', async t => {
  const calls = []
  const f = await fixture(t, { fetch: async (url, options) => {
    calls.push({ url, method: options.method })
    return url === CATALOG.lmstudio.source ? response(Buffer.alloc(0), { status: 302, headers: { location: LM_FILE } }) : response()
  } })
  const plan = await planned(f, 'lmstudio')
  assert.equal(plan.download.sourceUrl, LM_FILE)
  assert.equal((await completed(f, plan)).state, 'completed')
  assert.deepEqual(calls, [{ url: CATALOG.lmstudio.source, method: 'HEAD' }, { url: LM_FILE, method: 'HEAD' }, { url: LM_FILE, method: 'GET' }])
})

test('every redirect rejects noncatalog hosts, paths, credentials, schemes, ports and SSRF', async t => {
  const bad = ['http://lmstudio.ai/download/latest/darwin/arm64', 'https://127.0.0.1/file.dmg', 'https://169.254.169.254/latest/meta-data/',
    'https://lmstudio.ai.attacker.example/a.dmg', 'https://user:pass@installers.lmstudio.ai/a.dmg', 'file:///Applications/Evil.app',
    'https://installers.lmstudio.ai:444/darwin/arm64/0.4.25-1/LM-Studio-0.4.25-1-arm64.dmg',
    `${LM_FILE}?token=secret`, 'https://installers.lmstudio.ai/win32/x64/0.4.25-1/LM-Studio-0.4.25-1-x64.exe',
    'https://installers.lmstudio.ai/darwin/arm64/../../evil.dmg']
  for (const location of bad) {
    const calls = []
    const f = await fixture(t, { fetch: async url => { calls.push(url); return response(Buffer.alloc(0), { status: 302, headers: { location } }) } })
    const plan = await planned(f, 'lmstudio')
    assert.equal(plan.download.canDownload, false, location)
    assert.equal(calls.length, 1, location)
    assert.equal(allowedUrl('lmstudio', location), false, location)
  }
})

test('redirect loops and a client that silently auto-followed are denied', async t => {
  for (const fetch of [async () => response(Buffer.alloc(0), { status: 302, headers: { location: CATALOG.lmstudio.source } }),
    async () => response(dmg(), { url: 'https://attacker.example/final.dmg' })]) {
    const f = await fixture(t, { fetch })
    assert.equal((await planned(f, 'lmstudio')).download.canDownload, false)
  }
})

test('unknown, oversized, compressed and text metadata disables download', async t => {
  for (const headers of [{}, { 'content-length': String(LIMITS.maxBytes + 1) }, { 'content-length': '1024', 'content-encoding': 'gzip' },
    { 'content-length': '1024', 'content-type': 'text/html' }, { 'content-length': '1e3' }]) {
    const f = await fixture(t, { fetch: async () => response(dmg(), { headers }) })
    assert.equal((await planned(f)).download.canDownload, false)
    assert.deepEqual(await fs.readdir(f.downloads), [])
  }
})

test('metadata timeout is bounded and does not create folders', async t => {
  const keepalive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepalive))
  const f = await fixture(t, { metadataMs: 20, fetch: async () => new Promise(() => {}) })
  assert.equal((await f.manager.plan({ integration: 'comfyui' }, OWNER)).code, 'TIMEOUT')
  assert.deepEqual(await fs.readdir(f.downloads), [])
})

test('low RAM is a warning, unknown/low disk space prevents downloading', async t => {
  const lowMemory = await fixture(t, { totalmem: 4 * 1024 ** 3 }), plan = await planned(lowMemory)
  assert.equal(plan.download.canDownload, true)
  assert.ok(plan.warnings.some(value => /RAM/.test(value)))
  for (const statfs of [undefined, async () => ({ bavail: 0, bsize: 4096 })]) {
    const f = await fixture(t, { fs: { ...fs, statfs } })
    assert.equal((await planned(f)).download.canDownload, false)
  }
})

test('symlinked download root or setup subdirectory cannot be used', async t => {
  for (const subfolder of [false, true]) {
    const f = await fixture(t), elsewhere = path.join(f.root, 'elsewhere')
    await fs.mkdir(elsewhere)
    if (subfolder) await fs.symlink(elsewhere, path.join(f.downloads, 'Velorn Setup'))
    else { await fs.rmdir(f.downloads); await fs.symlink(elsewhere, f.downloads) }
    assert.equal((await planned(f)).download.canDownload, false)
    assert.deepEqual(await fs.readdir(elsewhere), [])
  }
})

test('root replacement during approval prevents all download writes', async t => {
  let f
  f = await fixture(t, { confirm: async () => {
    await fs.rename(f.downloads, path.join(f.root, 'old-downloads')); await fs.mkdir(f.downloads); return true
  } })
  const plan = await planned(f)
  assert.equal((await f.manager.download({ planId: plan.planId }, OWNER)).code, 'DESTINATION_CHANGED')
  assert.deepEqual(f.calls.map(value => value.method), ['HEAD'])
  assert.deepEqual(await fs.readdir(f.downloads), [])
})

test('owner/export becoming unavailable during approval prevents any GET', async t => {
  let live = true
  const f = await fixture(t, { assertCanStart: async () => { if (!live) throw Error('sensitive owner') }, confirm: async () => { live = false; return true } })
  const plan = await planned(f)
  assert.equal((await f.manager.download({ planId: plan.planId }, OWNER)).code, 'UNAVAILABLE')
  assert.deepEqual(f.calls.map(value => value.method), ['HEAD'])
})

test('download byte cap, truncation, changed size and invalid DMG all fail closed', async t => {
  for (const getResponse of [() => response(Buffer.alloc(1025), { headers: { 'content-length': '1024' } }),
    () => response(Buffer.alloc(1000), { headers: { 'content-length': '1024' } }), () => response(dmg(2048)), () => response(Buffer.alloc(1024))]) {
    const f = await fixture(t, { fetch: async (_url, { method }) => method === 'HEAD' ? response() : getResponse() })
    const job = await completed(f)
    assert.equal(job.state, 'failed', JSON.stringify(job))
    assert.equal(job.canOpen, false)
    assert.equal((await f.manager.open({ jobId: job.jobId }, OWNER)).code, 'NOT_COMPLETED')
    await until(async () => !(await fs.readdir(path.join(f.downloads, 'Velorn Setup'))).length)
  }
})

test('same-sized installer changes are rejected when metadata supplied an ETag', async t => {
  const f = await fixture(t, { fetch: async (_url, { method }) => response(dmg(), {
    headers: { 'content-length': '1024', etag: method === 'HEAD' ? '"old-version"' : '"new-version"' },
  }) })
  const job = await completed(f)
  assert.equal(job.state, 'failed')
  assert.equal(job.error.code, 'DOWNLOAD_CHANGED')
})

test('quarantine marking is mandatory and failures never promote an openable DMG', async t => {
  for (const markQuarantine of [null, async () => false, async () => { throw Error('/private/xattr-error') }]) {
    const f = await fixture(t, { markQuarantine }), job = await completed(f)
    assert.equal(job.state, 'failed')
    assert.equal(job.error.code, 'QUARANTINE_FAILED')
    assert.equal(job.canOpen, false)
    assert.doesNotMatch(JSON.stringify(job), /private/)
    await until(async () => !(await fs.readdir(path.join(f.downloads, 'Velorn Setup'))).length)
  }
})

test('content or inode changes during quarantine marking are caught before promotion', async t => {
  const f = await fixture(t, { markQuarantine: async file => {
    const handle = await fs.open(file, 'r+'); await handle.write(Buffer.from([42]), 0, 1, 0); await handle.close()
  } }), job = await completed(f)
  assert.equal(job.state, 'failed')
  assert.equal(job.error.code, 'INSTALLER_CHANGED')
  await until(async () => !(await fs.readdir(path.join(f.downloads, 'Velorn Setup'))).length)
})

test('changed root mid-stream never promotes or deletes a replacement file', async t => {
  let f
  f = await fixture(t, { fetch: async (_url, { method }) => {
    if (method === 'HEAD') return response()
    const body = Readable.from((async function* () {
      const old = path.join(f.root, 'saved-original-downloads')
      await fs.rename(f.downloads, old)
      await fs.mkdir(path.join(f.downloads, 'Velorn Setup'), { recursive: true })
      const partial = (await fs.readdir(path.join(old, 'Velorn Setup'))).find(value => value.endsWith('.partial'))
      await fs.writeFile(path.join(f.downloads, 'Velorn Setup', partial), 'unrelated-replacement')
      yield dmg()
    })())
    return response(dmg(), { body })
  } })
  const job = await completed(f)
  assert.equal(job.state, 'failed')
  assert.equal(job.error.code, 'DESTINATION_CHANGED')
  const files = await fs.readdir(path.join(f.downloads, 'Velorn Setup'))
  assert.equal(files.length, 1)
  assert.equal(await fs.readFile(path.join(f.downloads, 'Velorn Setup', files[0]), 'utf8'), 'unrelated-replacement')
  assert.match(job.warning, /left untouched/)
})

test('atomic promotion never clobbers a destination appearing during download', async t => {
  let f, destination
  f = await fixture(t, { confirm: async value => { destination = value.destination; return true },
    fs: { ...fs, link: async (source, target) => { await fs.writeFile(target, 'existing-user-file', { flag: 'wx' }); return fs.link(source, target) } } })
  const job = await completed(f)
  assert.equal(job.state, 'failed')
  assert.equal(job.error.code, 'DESTINATION_EXISTS')
  assert.equal(await fs.readFile(destination, 'utf8'), 'existing-user-file')
})

test('cancel aborts slow stream and cleans only the owned partial; foreign IDs never work', async t => {
  let gotGet = false
  const f = await fixture(t, { fetch: async (_url, { method }) => {
    if (method === 'HEAD') return response()
    gotGet = true
    return response(dmg(), { body: { [Symbol.asyncIterator]() { return this }, next: () => new Promise(() => {}), return: async () => ({ done: true }) } })
  } })
  const plan = await planned(f), job = await f.manager.download({ planId: plan.planId }, OWNER)
  await until(() => gotGet)
  assert.equal((await f.manager.cancel({ jobId: job.jobId }, 'foreign')).code, 'UNKNOWN_JOB')
  assert.equal((await f.manager.status({ jobId: job.jobId }, 'foreign')).code, 'UNKNOWN_JOB')
  assert.equal((await f.manager.open({ jobId: job.jobId }, 'foreign')).code, 'UNKNOWN_JOB')
  assert.equal((await f.manager.cancel({ jobId: job.jobId }, OWNER)).state, 'cancelled')
  assert.deepEqual(await fs.readdir(path.join(f.downloads, 'Velorn Setup')), [])
})

test('one active job and owner cancellation, including approval invalidation', async t => {
  let gotGet = false
  const f = await fixture(t, { fetch: async (_url, { method }) => {
    if (method === 'HEAD') return response()
    gotGet = true
    return response(dmg(), { body: { [Symbol.asyncIterator]() { return this }, next: () => new Promise(() => {}), return: async () => ({ done: true }) } })
  } })
  const p1 = await planned(f), p2 = await planned(f), job = await f.manager.download({ planId: p1.planId }, OWNER)
  assert.equal((await f.manager.download({ planId: p2.planId }, OWNER)).code, 'BUSY')
  await until(() => gotGet)
  await f.manager.cancelOwner(OWNER)
  assert.equal((await f.manager.status({ jobId: job.jobId }, OWNER)).state, 'cancelled')
  assert.equal((await f.manager.download({ planId: p2.planId }, OWNER)).code, 'INVALID_PLAN')
})

test('download timeout and disposal abort outstanding jobs without automatic opening', async t => {
  const f = await fixture(t, { downloadMs: 20, fetch: async (_url, { method }) => method === 'HEAD' ? response() : new Promise(() => {}) })
  const job = await completed(f)
  assert.equal(job.state, 'failed')
  assert.equal(job.error.code, 'TIMEOUT')
  assert.equal(f.opens.length, 0)
  await f.manager.dispose()
  assert.equal((await f.manager.plan({ integration: 'comfyui' }, OWNER)).code, 'DISPOSED')
})

test('open decline, changed file/digest, and OS failure are never reported as installation', async t => {
  let approve = true
  const f = await fixture(t, { confirm: async value => value.action !== 'open' || approve })
  const job = await completed(f)
  approve = false
  assert.equal((await f.manager.open({ jobId: job.jobId }, OWNER)).code, 'DECLINED')
  approve = true
  const folder = path.join(f.downloads, 'Velorn Setup')
  const filename = (await fs.readdir(folder)).find(value => value.endsWith('.dmg'))
  const handle = await fs.open(path.join(folder, filename), 'r+')
  await handle.write(Buffer.from([9]), 0, 1, 0); await handle.close()
  assert.equal((await f.manager.open({ jobId: job.jobId }, OWNER)).code, 'INSTALLER_CHANGED')
  assert.equal((await f.manager.status({ jobId: job.jobId }, OWNER)).canOpen, false)
  assert.equal(f.opens.length, 0)
  const osFail = await fixture(t, { openPath: async () => '/private/error-message' }), j2 = await completed(osFail)
  const result = await osFail.manager.open({ jobId: j2.jobId }, OWNER)
  assert.equal(result.code, 'OPEN_FAILED')
  assert.doesNotMatch(JSON.stringify(result), /private/)
})

test('file replacement during the final native opener guard is detected before OS handoff', async t => {
  let opened = false
  const f = await fixture(t, { openPath: async (file, { beforeOpen }) => {
    // Simulates the controller's last async context guard changing the file.
    await fs.rename(file, `${file}.original`)
    await fs.writeFile(file, dmg())
    await beforeOpen()
    opened = true
    return ''
  } }), job = await completed(f)
  const result = await f.manager.open({ jobId: job.jobId }, OWNER)
  assert.equal(result.code, 'INSTALLER_CHANGED')
  assert.equal(opened, false)
  assert.equal((await f.manager.status({ jobId: job.jobId }, OWNER)).canOpen, false)
})

test('plans are capped, and status/cancel require exactly a job ID', async t => {
  const f = await fixture(t), oldest = await planned(f)
  for (let i = 0; i < LIMITS.plans; i++) await planned(f)
  assert.equal((await f.manager.download({ planId: oldest.planId }, OWNER)).code, 'INVALID_PLAN')
  assert.equal((await f.manager.status({}, OWNER)).code, 'INVALID_REQUEST')
  assert.equal((await f.manager.cancel({ jobId: 'fake', path: '/tmp/elsewhere' }, OWNER)).code, 'INVALID_REQUEST')
})
