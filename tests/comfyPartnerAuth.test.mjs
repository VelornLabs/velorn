import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
// This dependency-free renderer module is ESM in Vite, while package.json stays
// CommonJS for Electron. Load unchanged source explicitly on Node 20 as well.
const { saveComfyPartnerApiKey, clearComfyPartnerApiKey, getComfyPartnerApiKey, validateComfyPartnerApiKey,
  notifyComfyPartnerKeyChanged } = await import(`data:text/javascript,${encodeURIComponent(await readFile(new URL('../src/services/comfyPartnerAuth.js', import.meta.url), 'utf8'))}`)

const original = { window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch, CustomEvent: globalThis.CustomEvent }
const FAKE = 'synthetic-only-not-a-real-key', LOCAL = 'comfystudio-comfy-api-key'
afterEach(() => { for (const [name, value] of Object.entries(original)) value === undefined ? delete globalThis[name] : globalThis[name] = value })
function fixture(api = {}) {
  const storage = new Map(), events = []
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail } }
  globalThis.window = { electronAPI: api, dispatchEvent: event => events.push(event) }
  return { storage, events }
}

test('ordinary successful saves preserve callback helper contract and announce only availability', async () => {
  let writes = 0
  const f = fixture({ setSetting: async (name, value) => { writes++; assert.equal(name, 'comfyApiKeyComfyOrg'); assert.equal(value, FAKE); return { success: true } } })
  assert.deepEqual(await saveComfyPartnerApiKey(` ${FAKE} `), { success: true, hasKey: true })
  assert.equal(writes, 1); assert.equal(f.storage.get(LOCAL), FAKE)
  assert.deepEqual(f.events.map(event => event.detail), [{ hasKey: true }])
  assert.ok(!JSON.stringify(f.events).includes(FAKE))
})

test('native failure or rejection cannot silently save fallback, notify success or expose its raw exception', async () => {
  for (const behavior of [async () => ({ success: false, error: FAKE }), async () => { throw new Error(FAKE) }, async () => undefined]) {
    const f = fixture({ setSetting: behavior }); f.storage.set(LOCAL, 'previous-synthetic-value')
    await assert.rejects(saveComfyPartnerApiKey(FAKE), error => !error.message.includes(FAKE))
    assert.equal(f.storage.get(LOCAL), 'previous-synthetic-value'); assert.deepEqual(f.events, [])
  }
})

test('browser-only save and remove remain explicit and failed storage is not reported saved', async () => {
  const f = fixture()
  await saveComfyPartnerApiKey(FAKE); assert.equal(f.storage.get(LOCAL), FAKE)
  await clearComfyPartnerApiKey(); assert.equal(f.storage.has(LOCAL), false)
  localStorage.setItem = () => { throw new Error(FAKE) }
  await assert.rejects(saveComfyPartnerApiKey(FAKE), error => !error.message.includes(FAKE))
})

test('guided existing-key lookup does not borrow a stale web fallback', async () => {
  const f = fixture({ getSetting: async () => '' }); f.storage.set(LOCAL, FAKE)
  assert.equal(await getComfyPartnerApiKey({ nativeOnly: true }), '')
  window.electronAPI.getSetting = async () => { throw new Error(FAKE) }
  await assert.rejects(getComfyPartnerApiKey({ nativeOnly: true }), error => !error.message.includes(FAKE))
  assert.equal(await getComfyPartnerApiKey(), FAKE, 'Ordinary read compatibility remains unchanged')
})

test('native guided replacement and removal clear stale fallback without copying a key or writing settings again', () => {
  const f = fixture({ setSetting: () => assert.fail('No second unguarded native write') })
  for (const hasKey of [true, false]) {
    f.storage.set(LOCAL, FAKE)
    notifyComfyPartnerKeyChanged(hasKey, { clearLegacy: true })
    assert.equal(f.storage.has(LOCAL), false)
  }
  assert.deepEqual(f.events.map(event => event.detail), [{ hasKey: true }, { hasKey: false }])
})

test('validation aborted at entry performs no credential-bearing fetch', async () => {
  const controller = new AbortController(); controller.abort()
  globalThis.fetch = () => assert.fail('No request after cancellation')
  await assert.rejects(validateComfyPartnerApiKey(FAKE, { signal: controller.signal }), { name: 'AbortError' })
})

test('aborted validation ignores a late successful response and does not probe a fallback endpoint', async () => {
  const controller = new AbortController(); let release, calls = 0
  globalThis.fetch = async () => { calls++; await new Promise(resolve => { release = resolve }); return { ok: true } }
  const pending = validateComfyPartnerApiKey(FAKE, { signal: controller.signal })
  controller.abort(); release()
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(calls, 1)
})

test('validation distinguishes valid, invalid and unknown without returning provider body, exception or key', async () => {
  for (const [status, expected] of [[200, 'valid'], [401, 'invalid'], [403, 'invalid'], [503, 'unknown']]) {
    let calls = 0
    globalThis.fetch = async (url, options) => {
      calls++; assert.ok(url.startsWith('https://api.comfy.org/'))
      assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit')
      return { ok: status === 200, status, text: () => assert.fail('Response content is unnecessary') }
    }
    const result = await validateComfyPartnerApiKey(FAKE)
    assert.equal(result.status, expected); assert.equal(calls, expected === 'unknown' ? 2 : 1)
    assert.ok(!JSON.stringify(result).includes(FAKE))
  }
  globalThis.fetch = async () => { throw new Error(FAKE) }
  const result = await validateComfyPartnerApiKey(FAKE)
  assert.equal(result.status, 'unknown'); assert.ok(!JSON.stringify(result).includes(FAKE))
})
