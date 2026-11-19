'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createComfyRouterKeyStore } = require('../electron/comfyRouterKeyStore.cjs')
const { createComfyRouter, MODEL } = require('../electron/comfyRouter.cjs')
const KEY = 'synthetic-router-key-one-never-real', OTHER = 'synthetic-router-key-two-never-real'

// A stand-in for the OS password store: reversible, but never the key in clear text.
function fakeSafeStorage({ available = true, backend = 'gnome_libsecret' } = {}) {
  return { isEncryptionAvailable: () => available, getSelectedStorageBackend: () => backend,
    encryptString: text => Buffer.from(`sealed:${Buffer.from(text).toString('hex')}`),
    decryptString: bytes => { const s = bytes.toString(); if (!s.startsWith('sealed:')) throw new Error('not sealed'); return Buffer.from(s.slice(7), 'hex').toString() } }
}
async function folder(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-router-key-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

test('stores the key encrypted, reads it back, and forgets it', async t => {
  const file = path.join(await folder(t), 'nested', 'comfy-router-key.bin')
  const store = createComfyRouterKeyStore({ safeStorage: fakeSafeStorage(), file, platform: 'linux' })
  assert.equal(store.canRemember(), true)
  assert.equal(await store.load(), '')
  assert.equal(await store.save(KEY), true)
  const onDisk = await fs.readFile(file)
  assert.ok(!onDisk.includes(Buffer.from(KEY)))
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['comfy-router-key.bin'])
  assert.equal(await store.load(), KEY)
  assert.equal(await store.save(OTHER), true)
  assert.equal(await store.load(), OTHER)
  await store.forget(); await store.forget()
  assert.equal(await store.load(), '')
  await assert.rejects(fs.stat(file), { code: 'ENOENT' })
})

test('writes nothing where the computer has no protected store', async t => {
  const dir = await folder(t)
  for (const safeStorage of [fakeSafeStorage({ available: false }), fakeSafeStorage({ backend: 'basic_text' }), fakeSafeStorage({ backend: 'unknown' }), undefined, {}]) {
    const store = createComfyRouterKeyStore({ safeStorage, file: path.join(dir, 'key.bin'), platform: 'linux' })
    assert.equal(store.canRemember(), false)
    assert.equal(await store.save(KEY), false)
    assert.equal(await store.load(), '')
  }
  assert.deepEqual(await fs.readdir(dir), [])
  assert.equal(createComfyRouterKeyStore({ safeStorage: fakeSafeStorage({ backend: 'basic_text' }), file: path.join(dir, 'key.bin'), platform: 'darwin' }).canRemember(), true)
})

test('refuses a plain-text "encryption", bad keys, and unreadable or oversized files', async t => {
  const dir = await folder(t), file = path.join(dir, 'key.bin')
  const leaky = { ...fakeSafeStorage(), encryptString: text => Buffer.from(`sealed:${text}`) }
  await assert.rejects(createComfyRouterKeyStore({ safeStorage: leaky, file, platform: 'linux' }).save(KEY))
  const store = createComfyRouterKeyStore({ safeStorage: fakeSafeStorage(), file, platform: 'linux' })
  for (const bad of ['', 'has space', 'line\nbreak', 'x'.repeat(4097), null]) await assert.rejects(store.save(bad))
  assert.deepEqual(await fs.readdir(dir), [])
  await fs.writeFile(file, 'not sealed at all'); assert.equal(await store.load(), '')
  await fs.writeFile(file, Buffer.alloc(20000, 65)); assert.equal(await store.load(), '')
  await fs.writeFile(file, fakeSafeStorage().encryptString('bad key with spaces')); assert.equal(await store.load(), '')
  assert.throws(() => createComfyRouterKeyStore({ safeStorage: fakeSafeStorage(), file: 'relative.bin' }))
})

// ---- the connection using the store -----------------------------------------
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })
async function connection(t, { safeStorage = fakeSafeStorage(), transport, keyStore } = {}) {
  const storageDir = await folder(t), file = path.join(storageDir, 'comfy-router-key.bin'), requests = []
  const store = keyStore || createComfyRouterKeyStore({ safeStorage, file, platform: 'linux' })
  const options = { storageDir, keyStore: store, getContext: async () => ({ session: 's', projectKey: '/synthetic/project' }), getPolicy: async () => 'ask-cloud',
    confirmSpend: async () => true,
    fetchImpl: async (url, request) => { requests.push({ url, ...request }); return transport ? transport(url, request) : request.method === 'POST' ? response({ request_id: 'job-one', status: 'IN_QUEUE' }, 201) : response({ id: MODEL }) } }
  let manager = createComfyRouter(options)
  t.after(() => manager.dispose())
  return { get manager() { return manager }, file, requests, store, restart() { manager.dispose(); manager = createComfyRouter(options); return manager } }
}

test('a key accepted by Comfy is remembered across a restart without being sent anywhere on launch', async t => {
  const c = await connection(t)
  assert.deepEqual([(await c.manager.status({})).configured, (await c.manager.status({})).canRemember], [false, true])
  const connected = await c.manager.connect({ apiKey: KEY })
  assert.deepEqual([connected.success, connected.remembered, connected.sessionOnly], [true, true, false])
  assert.ok(!JSON.stringify(connected).includes(KEY))
  const manager = c.restart(); c.requests.length = 0
  const status = await manager.status({})
  assert.deepEqual([status.configured, status.remembered, status.sessionOnly], [true, true, false])
  assert.ok(!JSON.stringify(status).includes(KEY))
  assert.equal(c.requests.length, 0)
  const plan = await manager.preview({ prompt: 'A red fox in snow' })
  assert.equal(plan.success, true)
  const sent = await manager.submit({ planId: plan.planId })
  assert.equal(sent.success, true)
  assert.equal(c.requests.at(-1).headers['X-API-Key'], KEY)
})

test('a key Comfy rejects is never stored', async t => {
  const c = await connection(t, { transport: async () => response({ error: 'no' }, 401) })
  assert.equal((await c.manager.connect({ apiKey: KEY })).code, 'COMFY_ROUTER_AUTH')
  await assert.rejects(fs.stat(c.file), { code: 'ENOENT' })
  assert.equal((await c.restart().status({})).configured, false)
})

test('Forget key removes the stored copy, and a new key replaces the old one', async t => {
  const c = await connection(t)
  await c.manager.connect({ apiKey: KEY })
  await c.manager.connect({ apiKey: OTHER })
  assert.equal(await c.store.load(), OTHER)
  const cleared = await c.manager.clear({})
  assert.deepEqual([cleared.success, cleared.configured], [true, false])
  await assert.rejects(fs.stat(c.file), { code: 'ENOENT' })
  assert.equal((await c.restart().status({})).configured, false)
})

test('with no protected store the key works for the session only', async t => {
  const c = await connection(t, { safeStorage: fakeSafeStorage({ backend: 'basic_text' }) })
  const connected = await c.manager.connect({ apiKey: KEY })
  assert.deepEqual([connected.success, connected.remembered, connected.sessionOnly], [true, false, true])
  assert.equal((await c.manager.status({})).canRemember, false)
  await assert.rejects(fs.stat(c.file), { code: 'ENOENT' })
  assert.equal((await c.restart().status({})).configured, false)
})

test('a store that fails does not block connecting, and a failed forget is reported', async t => {
  const broken = { canRemember: () => true, load: async () => { throw new Error('disk') }, save: async () => { throw new Error('disk') }, forget: async () => { throw new Error('disk') } }
  const c = await connection(t, { keyStore: broken })
  const connected = await c.manager.connect({ apiKey: KEY })
  assert.deepEqual([connected.success, connected.remembered], [true, false])
  const cleared = await c.manager.clear({})
  assert.equal(cleared.code, 'COMFY_ROUTER_KEY_STORE')
  assert.equal((await c.manager.status({})).configured, false)
})

test('a refusal of the waiting line is flagged so the screen can explain older keys', async t => {
  const c = await connection(t, { transport: async (_url, request) => request.method === 'POST'
    ? response({ detail: 'no' }, 403, { 'X-Comfy-Error-Type': 'not_enabled' }) : response({ id: MODEL }) })
  await c.manager.connect({ apiKey: KEY })
  const plan = await c.manager.previewCreate({ modelId: 'flux-3-image', choices: { prompt: 'A red fox in snow' } })
  const result = await c.manager.submitCreate({ planId: plan.planId })
  assert.deepEqual([result.success, result.queueNotEnabled, result.diagnostics.errorType], [false, true, 'not_enabled'])
})
