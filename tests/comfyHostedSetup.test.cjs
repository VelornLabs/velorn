'use strict'

const test = require('node:test'), assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createComfyHostedSetup, CHANNELS, ENDPOINT, GUIDES, FILE_NAME, LIMITS } = require('../electron/comfyHostedSetup.cjs')
const KEY = 'comfyui-synthetic-private-key-one', OTHER_KEY = 'comfyui-synthetic-private-key-two'
const ROOT = '/synthetic/velorn-user-data', FILE = `${ROOT}/${FILE_NAME}`
const encrypt = value => Buffer.from(`synthetic-encryption:${Buffer.from(value).toString('base64')}`)
const decrypt = value => {
  if (!value.toString().startsWith('synthetic-encryption:')) throw new Error('Private decryption failure')
  return Buffer.from(value.toString().slice('synthetic-encryption:'.length), 'base64').toString()
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const missing = () => Object.assign(new Error('Private missing path'), { code: 'ENOENT' })
function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial).map(([name, value]) => [name, Buffer.from(value)])), calls = []
  const fs = {
    files, calls, beforeWrite: null, failUnlink: false,
    async lstat(name) { calls.push(['lstat', name]); if (!files.has(name)) throw missing(); return { isFile: () => true, isSymbolicLink: () => false, size: files.get(name).length } },
    async open(name, flags, mode) {
      calls.push(['open', name, flags, mode])
      if (flags === 'wx') { if (files.has(name)) throw new Error('Already exists'); files.set(name, Buffer.alloc(0)) }
      else if (!files.has(name)) throw missing()
      let offset = 0
      return {
        stat: async () => ({ isFile: () => true, size: files.get(name).length }),
        read: async (buffer, start, size) => {
          const value = files.get(name), bytesRead = Math.min(size, value.length - offset)
          value.copy(buffer, start, offset, offset + bytesRead); offset += bytesRead; return { bytesRead, buffer }
        },
        writeFile: async value => { calls.push(['write', name, Buffer.from(value)]); await fs.beforeWrite?.(); files.set(name, Buffer.from(value)) },
        sync: async () => { calls.push(['sync', name]) },
        close: async () => { calls.push(['close', name]) },
      }
    },
    renameSync(from, to) { calls.push(['rename', from, to]); if (!files.has(from)) throw missing(); files.set(to, files.get(from)); files.delete(from) },
    unlinkSync(name) { calls.push(['unlinkSync', name]); if (fs.failUnlink) throw new Error(`Private unlink failure ${KEY}`); if (!files.delete(name)) throw missing() },
    async unlink(name) { calls.push(['unlink', name]); if (fs.failUnlink) throw new Error(`Private unlink failure ${KEY}`); if (!files.delete(name)) throw missing() },
  }
  return fs
}
function harness(options = {}) {
  const calls = [], guides = [], handlers = new Map(), fs = options.fs || memoryFs()
  const app = new EventEmitter(); app.getPath = name => { assert.equal(name, 'userData'); return ROOT }
  const contents = new EventEmitter(); contents.mainFrame = {}; contents.isDestroyed = () => false
  const window = new EventEmitter(); window.webContents = contents; window.isDestroyed = () => false
  let currentWindow = window
  const safeStorage = options.safeStorage || { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: encrypt, decryptString: decrypt }
  const host = createComfyHostedSetup({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    app, fs, fsSync: fs, getMainWindow: () => currentWindow, safeStorage, platform: 'linux',
    fetchImpl: async (url, request) => { calls.push({ url, request }); return options.fetchImpl ? options.fetchImpl(url, request) : json({ status: 'active', account: `PRIVATE-ACCOUNT-${KEY}` }) },
    openExternal: async url => { guides.push(url); return options.openExternal?.(url) },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  })
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const invoke = (method, payload, source = event) => handlers.get(CHANNELS[method])(source, payload)
  return { host, app, contents, window, event, invoke, fs, calls, guides, handlers, safeStorage,
    replaceWindow: value => { currentWindow = value } }
}
function noSecrets(result) {
  assert.doesNotMatch(JSON.stringify(result), /comfyui-synthetic-private|PRIVATE-ACCOUNT|Private|synthetic-encryption|user-data|@example/)
}

test('construction and presence-only status are passive; missing check does not make a request', async () => {
  const h = harness()
  assert.deepEqual(h.fs.calls, []); assert.deepEqual(h.calls, [])
  assert.deepEqual(await h.invoke('status'), { state: 'missing', configured: false, remembered: false, canRemember: true,
    summary: 'No hosted Comfy Cloud key is configured. Enter it only in the private key field.' })
  assert.equal((await h.invoke('check')).state, 'missing')
  assert.equal(h.calls.length, 0); assert.equal(h.fs.files.size, 0)
  h.host.dispose()
})

test('explicit account check uses only fixed readonly endpoint and sanitized active evidence', async () => {
  const h = harness(), result = await h.invoke('check', { key: KEY })
  assert.equal(result.state, 'verified'); assert.equal(result.configured, true); assert.equal(result.remembered, false)
  assert.match(result.summary, /No workflow, upload, generation/); noSecrets(result)
  assert.equal(h.calls.length, 1)
  const { url, request } = h.calls[0]
  assert.equal(url, ENDPOINT); assert.equal(url, 'https://cloud.comfy.org/api/user')
  assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error'); assert.equal(request.credentials, 'omit')
  assert.deepEqual(request.headers, { Accept: 'application/json', 'X-API-Key': KEY }); assert.equal(request.body, undefined)
  assert.equal((await h.invoke('status')).state, 'verified'); assert.equal(h.calls.length, 1)
  assert.equal(h.fs.files.size, 0)
  assert.equal((await h.invoke('clear')).state, 'missing'); assert.equal((await h.invoke('status')).configured, false)
  h.host.dispose()
})

test('only explicit active status verifies; waitlisted and malformed success never adopt a key', async () => {
  for (const [body, state] of [[{ status: 'waitlisted' }, 'waitlisted'], [{ status: 'ACTIVE' }, 'unavailable'],
    [{ status: 'active-ish' }, 'unavailable'], [{ success: true }, 'unavailable'], [[], 'unavailable'], [null, 'unavailable']]) {
    const h = harness({ fetchImpl: async () => json(body) }), result = await h.invoke('check', { key: KEY, remember: true })
    assert.equal(result.state, state); assert.equal(result.configured, false); assert.equal(result.remembered, false)
    assert.equal(h.fs.files.size, 0); assert.equal(h.calls.length, 1); noSecrets(result); h.host.dispose()
  }
})

test('authentication, subscription/rate limit and other failures remain distinct with no reflected body', async () => {
  for (const [status, state] of [[401, 'auth-rejected'], [403, 'auth-rejected'], [429, 'subscription-or-rate-limited'],
    [402, 'unavailable'], [500, 'unavailable'], [302, 'unavailable'], [201, 'unavailable']]) {
    const h = harness({ fetchImpl: async () => json({ error: KEY, email: 'private@example.invalid' }, status) })
    const result = await h.invoke('check', { key: KEY, remember: true })
    assert.equal(result.state, state); noSecrets(result); assert.equal(h.calls.length, 1); assert.equal(h.fs.files.size, 0); h.host.dispose()
  }
  const h = harness({ fetchImpl: async () => { throw new Error(`Private provider ${KEY}`) } })
  const result = await h.invoke('check', { key: KEY }); assert.equal(result.state, 'unavailable'); noSecrets(result); h.host.dispose()
})

test('main-frame authority and exact payloads prevent credential, endpoint and action injection', async () => {
  const h = harness()
  for (const method of Object.keys(CHANNELS)) {
    const result = await h.invoke(method, {}, { sender: h.contents, senderFrame: {} })
    assert.deepEqual(Object.keys(result).sort(), ['code', 'success', 'summary']); assert.equal(result.code, 'COMFY_HOSTED_UNAUTHORIZED')
  }
  assert.equal(h.fs.calls.length, 0)
  for (const payload of [null, [], { url: 'https://evil.test' }, { key: '' }, { key: KEY, remember: 'yes' }, { remember: true },
    { key: KEY, extra: 'unknown' }, { key: ` ${KEY}` }, { key: `${KEY}\n` }, { key: 'a'.repeat(LIMITS.key + 1) }]) {
    assert.equal((await h.invoke('check', payload)).code, 'COMFY_HOSTED_INVALID')
  }
  for (const method of ['status', 'clear', 'cancel']) assert.equal((await h.invoke(method, { key: KEY })).code, 'COMFY_HOSTED_INVALID')
  assert.equal(h.calls.length, 0); assert.equal(h.fs.files.size, 0); h.host.dispose()
})

test('remember uses restrictive encrypted atomic file; restart is configured, never verified', async () => {
  const h = harness(), result = await h.invoke('check', { key: KEY, remember: true })
  assert.equal(result.state, 'verified'); assert.equal(result.remembered, true)
  assert.deepEqual([...h.fs.files.keys()], [FILE]); assert.equal(h.fs.files.get(FILE).includes(KEY), false)
  const open = h.fs.calls.find(call => call[0] === 'open' && call[2] === 'wx')
  assert.equal(open[3], 0o600); assert.ok(open[1].startsWith(`${FILE}.`)); assert.ok(open[1].endsWith('.tmp'))
  const rename = h.fs.calls.findIndex(call => call[0] === 'rename'), sync = h.fs.calls.findIndex(call => call[0] === 'sync')
  assert.ok(sync >= 0 && sync < rename)
  h.host.dispose()
  const restarted = harness({ fs: h.fs }), status = await restarted.invoke('status')
  assert.equal(status.state, 'configured'); assert.equal(status.configured, true); assert.equal(status.remembered, true); noSecrets(status)
  assert.equal(restarted.calls.length, 0)
  assert.equal((await restarted.invoke('check', {})).state, 'verified'); assert.equal(restarted.calls[0].request.headers['X-API-Key'], KEY)
  assert.equal((await restarted.invoke('clear')).state, 'missing'); assert.equal(h.fs.files.size, 0)
  restarted.host.dispose()
})

test('Linux weak or unavailable secret storage never persists; session-only mode still works', async () => {
  for (const backend of ['basic_text', 'unknown', undefined]) {
    const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend, encryptString: encrypt, decryptString: decrypt }
    const h = harness({ safeStorage })
    assert.equal((await h.invoke('status')).canRemember, false)
    assert.equal((await h.invoke('check', { key: KEY, remember: true })).code, 'COMFY_HOSTED_STORAGE_UNAVAILABLE')
    assert.equal(h.calls.length, 0)
    assert.equal((await h.invoke('check', { key: KEY })).state, 'verified'); assert.equal(h.fs.files.size, 0)
    h.host.dispose()
  }
})

test('broken, symlink and oversized credential files fail closed without mutation or network', async () => {
  for (const kind of ['corrupt', 'symlink', 'oversized']) {
    const fs = memoryFs({ [FILE]: Buffer.from('private malformed credential') })
    if (kind === 'symlink') fs.lstat = async () => ({ isFile: () => false, isSymbolicLink: () => true, size: 1 })
    if (kind === 'oversized') fs.lstat = async () => ({ isFile: () => true, isSymbolicLink: () => false, size: LIMITS.encrypted + 1 })
    const h = harness({ fs }), result = await h.invoke('status')
    assert.equal(result.state, 'unavailable'); assert.equal(result.configured, false); noSecrets(result)
    assert.equal(h.calls.length, 0); assert.equal(fs.files.size, 1); h.host.dispose()
  }
})

test('rejected replacement retains prior saved credential but invalidates previous verification', async () => {
  let rejected = false
  const h = harness({ fetchImpl: async () => rejected ? json({ status: 'active' }, 401) : json({ status: 'active' }) })
  await h.invoke('check', { key: KEY, remember: true }); const stored = Buffer.from(h.fs.files.get(FILE))
  rejected = true
  const result = await h.invoke('check', { key: OTHER_KEY, remember: true })
  assert.equal(result.state, 'auth-rejected'); assert.equal(result.configured, true); assert.equal(result.remembered, true)
  assert.deepEqual(h.fs.files.get(FILE), stored); assert.notEqual((await h.invoke('status')).state, 'verified')
  rejected = false
  await h.invoke('check', {}); assert.equal(h.calls.at(-1).request.headers['X-API-Key'], KEY)
  h.host.dispose()
})

test('verified session-only replacement removes old remembered key, preventing resurrection', async () => {
  const h = harness()
  await h.invoke('check', { key: KEY, remember: true })
  const result = await h.invoke('check', { key: OTHER_KEY, remember: false })
  assert.equal(result.state, 'verified'); assert.equal(result.remembered, false); assert.equal(h.fs.files.size, 0)
  await h.invoke('check'); assert.equal(h.calls.at(-1).request.headers['X-API-Key'], OTHER_KEY)
  h.host.dispose()
  const restarted = harness({ fs: h.fs }); assert.equal((await restarted.invoke('status')).state, 'missing'); restarted.host.dispose()
})

test('deadline bounds a fetch that ignores abort without a retry or late key adoption', async () => {
  const reply = deferred(), h = harness({ timeoutMs: 15, fetchImpl: () => reply.promise })
  const result = await h.invoke('check', { key: KEY, remember: true })
  assert.equal(result.state, 'unavailable'); assert.equal(result.configured, false); assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].request.signal.aborted, true)
  reply.resolve(json({ status: 'active' })); await tick()
  assert.equal((await h.invoke('status')).state, 'unavailable'); assert.equal(h.fs.files.size, 0); h.host.dispose()
})

test('deadline includes ignored-signal stream read and cleans up the reader', async () => {
  let cancelled = 0, released = 0
  const h = harness({ timeoutMs: 15, fetchImpl: async () => ({ status: 200, headers: { get: () => null }, body: { getReader: () => ({
    read: () => new Promise(() => {}), cancel: () => { cancelled++ }, releaseLock: () => { released++ },
  }) } }) })
  const result = await h.invoke('check', { key: KEY, remember: true })
  assert.equal(result.state, 'unavailable'); assert.equal(cancelled, 1); assert.equal(released, 1); assert.equal(h.fs.files.size, 0); h.host.dispose()
})

test('response size, malformed JSON and followed redirects never verify or persist', async () => {
  const replies = [
    () => new Response('x', { headers: { 'content-length': `${LIMITS.response + 1}` } }),
    () => new Response('x'.repeat(LIMITS.response + 1)),
    () => new Response('{invalid'),
    () => ({ status: 200, redirected: true, body: { cancel: async () => {} } }),
    () => ({ status: 200, headers: { get: () => null }, text: async () => 'x'.repeat(LIMITS.response + 1) }),
  ]
  for (const fetchImpl of replies) {
    const h = harness({ fetchImpl }), result = await h.invoke('check', { key: KEY, remember: true })
    assert.equal(result.state, 'unavailable'); assert.equal(result.configured, false); assert.equal(h.fs.files.size, 0); h.host.dispose()
  }
})

test('explicit cancellation invalidates pending evidence and blocks late response saves', async () => {
  const reply = deferred(), h = harness({ fetchImpl: () => reply.promise })
  const pending = h.invoke('check', { key: KEY, remember: true }); await tick()
  assert.equal((await h.invoke('cancel')).state, 'missing')
  const result = await pending; assert.equal(result.code, 'COMFY_HOSTED_CANCELLED'); noSecrets(result)
  reply.resolve(json({ status: 'active' })); await tick()
  assert.equal(h.fs.files.size, 0); assert.equal((await h.invoke('status')).state, 'missing'); h.host.dispose()
})

test('clear aborts in-flight recheck, deletes only dedicated hosted key, and prevents resurrection', async () => {
  let reply
  const fs = memoryFs({ [`${ROOT}/settings.json`]: Buffer.from('unrelated Partner and application settings') })
  const h = harness({ fs, fetchImpl: () => reply ? reply.promise : json({ status: 'active' }) })
  await h.invoke('check', { key: KEY, remember: true }); reply = deferred()
  const pending = h.invoke('check'); await tick()
  assert.notEqual((await h.invoke('status')).state, 'verified')
  assert.equal((await h.invoke('clear')).state, 'missing'); assert.equal((await pending).code, 'COMFY_HOSTED_CANCELLED')
  reply.resolve(json({ status: 'active' })); await tick()
  assert.deepEqual([...fs.files.keys()], [`${ROOT}/settings.json`]); h.host.dispose()
})

test('navigation, frame replacement and native destruction invalidate verification and pending work', async () => {
  for (const event of ['navigation', 'frame', 'destroyed']) {
    let reply
    const h = harness({ fetchImpl: () => reply ? reply.promise : json({ status: 'active' }) })
    await h.invoke('check', { key: KEY }); reply = deferred()
    const pending = h.invoke('check', { key: OTHER_KEY, remember: true }); await tick()
    if (event === 'navigation') h.contents.emit('did-start-navigation', {}, 'https://unknown.invalid', false, true)
    if (event === 'destroyed') h.contents.emit('render-process-gone')
    if (event === 'frame') { h.contents.mainFrame = {}; h.event.senderFrame = h.contents.mainFrame; await h.invoke('status') }
    const result = await pending; assert.equal(result.code, 'COMFY_HOSTED_CANCELLED')
    reply.resolve(json({ status: 'active' })); await tick()
    assert.equal((await h.invoke('status')).state, 'configured'); assert.equal(h.fs.files.size, 0); h.host.dispose()
  }
})

test('concurrent checks are rejected instead of replacing or duplicating the first operation', async () => {
  const reply = deferred(), h = harness({ fetchImpl: () => reply.promise })
  const pending = h.invoke('check', { key: KEY }); await tick()
  assert.equal((await h.invoke('check', { key: OTHER_KEY })).code, 'COMFY_HOSTED_BUSY'); assert.equal(h.calls.length, 1)
  reply.resolve(json({ status: 'active' })); assert.equal((await pending).state, 'verified'); h.host.dispose()
})

test('atomic write failure removes temp file and never claims new key remembered', async () => {
  const fs = memoryFs({ [FILE]: encrypt(KEY) }); fs.beforeWrite = () => { throw new Error(`Private write failure ${OTHER_KEY}`) }
  const h = harness({ fs }), result = await h.invoke('check', { key: OTHER_KEY, remember: true })
  assert.equal(result.success, false); assert.equal(result.state, 'unavailable'); assert.equal(result.remembered, true); noSecrets(result)
  assert.deepEqual([...fs.files.keys()], [FILE]); assert.equal(decrypt(fs.files.get(FILE)), KEY); h.host.dispose()
})

test('cancellation during temporary write cannot rename or replace prior remembered key', async () => {
  const gate = deferred(), started = deferred(), fs = memoryFs({ [FILE]: encrypt(KEY) })
  fs.beforeWrite = () => { started.resolve(); return gate.promise }
  const h = harness({ fs }), pending = h.invoke('check', { key: OTHER_KEY, remember: true })
  await started.promise; await h.invoke('cancel'); gate.resolve()
  assert.equal((await pending).code, 'COMFY_HOSTED_CANCELLED')
  assert.equal(decrypt(fs.files.get(FILE)), KEY); assert.equal(fs.calls.filter(call => call[0] === 'rename').length, 0)
  assert.deepEqual([...fs.files.keys()], [FILE]); h.host.dispose()
})

test('clear serialized after a temporary write prevents a late remembered key', async () => {
  const gate = deferred(), started = deferred(), fs = memoryFs({ [FILE]: encrypt(KEY) })
  fs.beforeWrite = () => { started.resolve(); return gate.promise }
  const h = harness({ fs }), pending = h.invoke('check', { key: OTHER_KEY, remember: true })
  await started.promise
  const clearing = h.invoke('clear'); await tick(); gate.resolve()
  assert.equal((await pending).code, 'COMFY_HOSTED_CANCELLED')
  assert.equal((await clearing).state, 'missing'); assert.equal(fs.files.size, 0)
  assert.equal(fs.calls.filter(call => call[0] === 'rename').length, 0)
  assert.equal((await h.invoke('status')).configured, false); h.host.dispose()
})

test('failed explicit removal preserves truthful configured state but never old verified state', async () => {
  const h = harness(); await h.invoke('check', { key: KEY, remember: true }); h.fs.failUnlink = true
  const result = await h.invoke('clear'); assert.equal(result.success, false); assert.equal(result.configured, true)
  assert.equal(result.state, 'configured'); assert.equal(result.remembered, true); noSecrets(result)
  h.host.dispose()
})

test('official guide actions accept only fixed enum values and do not inspect credentials or network', async () => {
  const h = harness()
  for (const guide of Object.keys(GUIDES)) assert.deepEqual(await h.invoke('openGuide', { guide }), { success: true, opened: true })
  for (const payload of [{ guide: 'https://evil.invalid' }, { guide: 'cloud', key: KEY }, { guide: '__proto__' }, {}, null]) {
    assert.equal((await h.invoke('openGuide', payload)).code, 'COMFY_HOSTED_INVALID')
  }
  assert.deepEqual(h.guides, Object.values(GUIDES)); assert.equal(h.fs.calls.length, 0); assert.equal(h.calls.length, 0); h.host.dispose()
})

test('native disposal removes IPC/listeners and cancels pending requests without retained evidence', async () => {
  const reply = deferred(), h = harness({ fetchImpl: () => reply.promise })
  const pending = h.invoke('check', { key: KEY, remember: true }); await tick()
  h.host.dispose(); assert.equal(h.handlers.size, 0); assert.equal(h.contents.listenerCount('render-process-gone'), 0)
  assert.equal((await pending).code, 'COMFY_HOSTED_CANCELLED')
  reply.resolve(json({ status: 'active' })); await tick(); assert.equal(h.fs.files.size, 0)
})

test('cancel during initial credential read prevents queued network work and permits later reload', async () => {
  const fs = memoryFs({ [FILE]: encrypt(KEY) }), started = deferred(), gate = deferred(), open = fs.open
  let blocked = false
  fs.open = async (...args) => {
    const handle = await open(...args), read = handle.read
    handle.read = async (...readArgs) => {
      if (!blocked) { blocked = true; started.resolve(); await gate.promise }
      return read(...readArgs)
    }
    return handle
  }
  const h = harness({ fs }), pending = h.invoke('check')
  await started.promise; await h.invoke('cancel'); gate.resolve()
  assert.equal((await pending).code, 'COMFY_HOSTED_CANCELLED'); assert.equal(h.calls.length, 0)
  const status = await h.invoke('status')
  assert.equal(status.state, 'configured'); assert.equal(status.remembered, true)
  assert.equal((await h.invoke('check')).state, 'verified'); assert.equal(h.calls[0].request.headers['X-API-Key'], KEY)
  h.host.dispose()
})

test('navigation during initial credential read allows a new document to reload safely', async () => {
  const fs = memoryFs({ [FILE]: encrypt(KEY) }), started = deferred(), gate = deferred(), originalStat = fs.lstat
  let blocked = false
  fs.lstat = async (...args) => {
    if (!blocked) { blocked = true; started.resolve(); await gate.promise }
    return originalStat(...args)
  }
  const h = harness({ fs }), pending = h.invoke('status')
  await started.promise; h.contents.emit('did-start-navigation', {}, 'https://unknown.invalid', false, true); gate.resolve()
  assert.equal((await pending).code, 'COMFY_HOSTED_CANCELLED')
  assert.equal((await h.invoke('status')).state, 'configured'); assert.equal(h.calls.length, 0)
  h.host.dispose()
})

test('credential read remains bounded if the file grows after size checks', async () => {
  const fs = memoryFs({ [FILE]: encrypt(KEY) }), open = fs.open
  fs.open = async (...args) => {
    const handle = await open(...args), stat = handle.stat
    handle.stat = async () => { const result = await stat(); fs.files.set(FILE, Buffer.alloc(LIMITS.encrypted * 3)); return result }
    return handle
  }
  const h = harness({ fs }), status = await h.invoke('status')
  assert.equal(status.state, 'unavailable'); assert.equal(status.configured, false); noSecrets(status); assert.equal(h.calls.length, 0)
  h.host.dispose()
})

test('lost secure storage during verification cannot downgrade to an unprotected remembered save', async () => {
  const reply = deferred(), h = harness({ fetchImpl: () => reply.promise }), pending = h.invoke('check', { key: KEY, remember: true })
  await tick(); h.safeStorage.getSelectedStorageBackend = () => 'basic_text'; reply.resolve(json({ status: 'active' }))
  const result = await pending
  assert.equal(result.code, 'COMFY_HOSTED_STORAGE_UNAVAILABLE'); assert.equal(result.configured, false); assert.equal(result.canRemember, false)
  assert.equal(h.fs.files.size, 0); h.host.dispose()
})

test('cancel invalidates a clear queued behind a cancelled temporary write', async () => {
  const gate = deferred(), started = deferred(), fs = memoryFs({ [FILE]: encrypt(KEY) })
  fs.beforeWrite = () => { started.resolve(); return gate.promise }
  const h = harness({ fs }), pending = h.invoke('check', { key: OTHER_KEY, remember: true })
  await started.promise
  const clearing = h.invoke('clear'); await tick(); await h.invoke('cancel'); gate.resolve()
  assert.equal((await pending).code, 'COMFY_HOSTED_CANCELLED'); assert.equal((await clearing).code, 'COMFY_HOSTED_CANCELLED')
  assert.equal(decrypt(fs.files.get(FILE)), KEY); assert.deepEqual([...fs.files.keys()], [FILE])
  assert.equal((await h.invoke('status')).state, 'configured'); h.host.dispose()
})

test('cancel during initial read prevents a delayed clear from removing remembered credentials', async () => {
  const gate = deferred(), started = deferred(), fs = memoryFs({ [FILE]: encrypt(KEY) }), stat = fs.lstat
  let blocked = false
  fs.lstat = async (...args) => { if (!blocked) { blocked = true; started.resolve(); await gate.promise } return stat(...args) }
  const h = harness({ fs }), clearing = h.invoke('clear')
  await started.promise; await h.invoke('cancel'); gate.resolve()
  assert.equal((await clearing).code, 'COMFY_HOSTED_CANCELLED'); assert.equal(decrypt(fs.files.get(FILE)), KEY)
  assert.equal((await h.invoke('status')).state, 'configured'); assert.equal(h.calls.length, 0); h.host.dispose()
})

test('native-only readStatus is passive, minimized and not an IPC credential surface', async () => {
  const h = harness({ fs: memoryFs({ [FILE]: encrypt(KEY) }) })
  assert.deepEqual(await h.host.readStatus({ isCurrent: () => true }), {
    success: true, integration: 'comfycloud', state: 'configured', configured: true,
  })
  assert.equal(h.calls.length, 0); assert.equal(h.guides.length, 0)
  assert.deepEqual([...h.handlers.keys()].sort(), Object.values(CHANNELS).sort())
  assert.equal(Object.hasOwn(CHANNELS, 'readStatus'), false)
  assert.equal(h.fs.calls.some(call => ['write', 'rename', 'unlinkSync'].includes(call[0])), false)
  h.host.dispose()
})

test('native-only readStatus reports prior explicit account check without repeating it or returning storage details', async () => {
  let status = 200
  const h = harness({ fetchImpl: async () => json({ status: 'active', secret: KEY, email: 'private@example.invalid' }, status) })
  await h.invoke('check', { key: KEY, remember: true })
  const first = await h.host.readStatus({ isCurrent: () => true })
  assert.deepEqual(first, { success: true, integration: 'comfycloud', state: 'verified', configured: true }); noSecrets(first)
  await h.host.readStatus({ isCurrent: () => true }); assert.equal(h.calls.length, 1)
  status = 401; await h.invoke('check')
  assert.deepEqual(await h.host.readStatus({ isCurrent: () => true }), {
    success: true, integration: 'comfycloud', state: 'auth-rejected', configured: true,
  })
  assert.equal(h.calls.length, 2)
  await h.invoke('cancel')
  assert.equal((await h.host.readStatus({ isCurrent: () => true })).state, 'configured'); h.host.dispose()
})

test('native-only readStatus requires a current native caller before any credential initialization', async () => {
  const h = harness({ fs: memoryFs({ [FILE]: encrypt(KEY) }) })
  for (const args of [undefined, {}, { isCurrent: () => false }, { isCurrent: () => { throw new Error(KEY) } }]) {
    assert.deepEqual(await h.host.readStatus(args), { success: false, integration: 'comfycloud', state: 'problem', configured: false })
  }
  assert.equal(h.fs.calls.length, 0); assert.equal(h.calls.length, 0); h.host.dispose()
})

test('native-only readStatus refuses cancelled or changed-document evidence after passive initialization', async () => {
  for (const invalidation of ['caller', 'cancel', 'navigation', 'frame', 'dispose']) {
    const gate = deferred(), started = deferred(), fs = memoryFs({ [FILE]: encrypt(KEY) }), stat = fs.lstat
    fs.lstat = async (...args) => { started.resolve(); await gate.promise; return stat(...args) }
    const h = harness({ fs }); let current = true
    const reading = h.host.readStatus({ isCurrent: () => current }); await started.promise
    if (invalidation === 'caller') current = false
    if (invalidation === 'cancel') await h.invoke('cancel')
    if (invalidation === 'navigation') h.contents.emit('did-start-navigation', {}, 'https://unknown.invalid', false, true)
    if (invalidation === 'frame') h.contents.mainFrame = {}
    if (invalidation === 'dispose') h.host.dispose()
    gate.resolve()
    assert.deepEqual(await reading, { success: false, integration: 'comfycloud', state: 'problem', configured: false })
    assert.equal(h.calls.length, 0); assert.equal(fs.calls.some(call => ['write', 'rename', 'unlinkSync'].includes(call[0])), false)
    h.host.dispose()
  }
})

test('native-only readStatus cannot reuse verified evidence while user account recheck is pending', async () => {
  let gate
  const h = harness({ fetchImpl: () => gate ? gate.promise : json({ status: 'active' }) })
  await h.invoke('check', { key: KEY }); gate = deferred()
  const pending = h.invoke('check'); await tick()
  assert.deepEqual(await h.host.readStatus({ isCurrent: () => true }), {
    success: true, integration: 'comfycloud', state: 'configured', configured: true,
  })
  gate.resolve(json({ status: 'waitlisted' })); await pending
  assert.equal((await h.host.readStatus({ isCurrent: () => true })).state, 'waitlisted')
  assert.equal(h.calls.length, 2); h.host.dispose()
})
