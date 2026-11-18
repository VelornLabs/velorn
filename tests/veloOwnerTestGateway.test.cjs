'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validateOwnerLaunch, readOwnerLaunch, startOwnerTestGateway } = require('../electron/veloOwnerTestGateway.cjs')
const { isolationMode } = require('../electron/veloEngineCandidate.cjs')
const TOKEN = 'a'.repeat(64)
const catalog = { models: [{ slug: 'gpt-6-luna', base_instructions: 'Synthetic protocol fixture, not real model instructions.', supported_reasoning_levels: [{ effort: 'low' }], tool_mode: 'code_mode_only', unknown_preserved: { value: 23 } }] }
const catalogText = JSON.stringify(catalog, null, 2)
function launchValue(now = Date.now()) { return { version: 1, mode: 'owner-metered-test', socketPath: '/bridge/upstream.sock', capability: TOKEN, issuedAt: now,
  expiresAt: now + 600000, preflight: { checkedAt: now, remainingMicroUsd: 262107, model: 'gpt-6-luna', reasoningEffort: 'low' } } }
function files(t, value = launchValue(), cleanup = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-owner-transport-test-'))
  if (cleanup) t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const launchPath = path.join(root, 'launch.json'), stateRoot = path.join(root, 'state')
  fs.writeFileSync(launchPath, JSON.stringify(value), { mode: 0o600 })
  return { root, launchPath, stateRoot, launch: readOwnerLaunch({ launchPath, stateRoot }) }
}
function completed(res) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n') }
async function fixture(t, handler = (_req, res) => completed(res)) {
  const f = files(t, launchValue(), false), calls = [], socket = path.join(f.root, 'upstream.sock')
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    calls.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) })
    if (req.url === '/models?client_version=0.165.0') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(catalogText) }
    else handler(req, res)
  })
  await new Promise(resolve => server.listen(socket, resolve))
  const options = { assertIsolation: () => true, launch: f.launch, requestImpl: (value, callback) => {
    assert.equal(value.socketPath, '/bridge/upstream.sock'); assert.equal(value.hostname, undefined)
    return http.request({ ...value, socketPath: socket }, callback)
  } }
  const gateway = await startOwnerTestGateway(options)
  t.after(async () => { await gateway.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(f.root, { recursive: true, force: true }) })
  return { ...f, calls, gateway, options, server }
}
const post = (gateway, body = '{}', headers = {}, suffix = '/responses') => fetch(gateway.baseUrl + suffix, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, ...headers }, body })

test('mode selection requires explicit truthful offline or metered boundaries', () => {
  assert.equal(isolationMode({ offline: true, fixtureOnly: true, network: 'isolated-loopback-only' }), 'offline-fixture')
  assert.equal(isolationMode({ mode: 'owner-metered-test', offline: false, fixtureOnly: false, network: 'isolated-loopback-owner-broker' }), 'owner-metered-test')
  for (const value of [{ offline: true, fixtureOnly: false }, { mode: 'owner-metered-test', offline: true, fixtureOnly: true, network: 'isolated-loopback-owner-broker' }, { mode: 'owner-metered-test', offline: false, fixtureOnly: false, network: 'host' }]) assert.throws(() => isolationMode(value))
})
test('launch rejects extra credentials, wrong model/effort/endpoint, invalid balance and stale expiry', () => {
  const now = Date.now(), value = launchValue(now)
  assert.equal(validateOwnerLaunch(value, now).preflight.reasoningEffort, 'low')
  for (const changes of [{ credential: 'not-allowed' }, { socketPath: '/tmp/other.sock' }, { expiresAt: now }, { expiresAt: now + 600001 }, { issuedAt: now + 6000 }, { capability: 'not-a-capability' }, { preflight: { ...value.preflight, model: 'other' } }, { preflight: { ...value.preflight, reasoningEffort: 'medium' } }, { preflight: { ...value.preflight, remainingMicroUsd: 1000001 } }, { preflight: { ...value.preflight, remainingMicroUsd: -1 } }, { preflight: { ...value.preflight, checkedAt: now - 60001 } }]) assert.throws(() => validateOwnerLaunch({ ...value, ...changes }, now))
})
test('fresh private launch receipt permits exact bounded reopen but no stale/new approval', t => {
  const now = Date.now(), f = files(t, launchValue(now))
  assert.equal(readOwnerLaunch({ ...f, now: () => now + 120000 }).launchSha256, f.launch.launchSha256)
  assert.throws(() => readOwnerLaunch({ ...f, now: () => now + 600000 }))
  const otherState = path.join(f.root, 'never-accepted')
  assert.throws(() => readOwnerLaunch({ ...f, stateRoot: otherState, now: () => now + 60001 }))
  fs.chmodSync(f.launchPath, 0o644)
  assert.throws(() => readOwnerLaunch(f))
})
test('catalog and status never dispatch inference or create a local allowance ledger', async t => {
  const f = await fixture(t)
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'GET')
  assert.equal(fs.readFileSync(f.gateway.catalogPath, 'utf8'), catalogText)
  const status = await f.gateway.status()
  assert.equal(status.balanceSource, 'owner-preflight'); assert.equal(status.balanceIsLive, false)
  assert.equal(status.remainingMicroUsd, 262107); assert.equal(status.fixture, false)
  assert.equal(status.ownerMeteredTest, true); assert.equal(status.available, true)
  assert.equal(JSON.stringify(status).includes(TOKEN), false)
  assert.equal(fs.readdirSync(f.stateRoot).some(name => /ledger|account|grant/.test(name)), false)
})
test('response bridge preserves bytes/content encoding without forwarding caller identity or retrying', async t => {
  const f = await fixture(t), body = Buffer.from('opaque-compressed-test-body')
  const res = await post(f.gateway, body, { 'content-encoding': 'zstd', 'x-client-request-id': 'do-not-forward', 'idempotency-key': 'do-not-forward' })
  assert.equal(res.status, 200); await res.text()
  const call = f.calls.at(-1)
  assert.equal(call.path, '/responses'); assert.deepEqual(call.body, body)
  assert.equal(call.headers['content-encoding'], 'zstd')
  assert.equal(call.headers['x-client-request-id'], undefined); assert.equal(call.headers['idempotency-key'], undefined)
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal((await f.gateway.status()).available, true)
})
test('unapproved routes, cookie/origin, missing capability never reach owner', async t => {
  const f = await fixture(t)
  for (const [headers, suffix] of [[{}, '/responses/compact'], [{ origin: 'https://example.com' }, '/responses'], [{ cookie: 'x=y' }, '/responses'], [{ authorization: 'Bearer wrong' }, '/responses']]) {
    const res = await post(f.gateway, '{}', headers, suffix); assert.equal(res.status, 403, JSON.stringify(headers) + suffix); await res.text()
  }
  const hostStatus = await new Promise((resolve, reject) => {
    const request = http.request(f.gateway.baseUrl + '/responses', { method: 'POST', headers: { host: 'elsewhere.invalid', authorization: `Bearer ${TOKEN}` } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)) })
    request.once('error', reject); request.end('{}')
  })
  assert.equal(hostStatus, 403)
  assert.equal(f.calls.length, 1)
})
test('provider refusal stops future dispatch and persists no-retry across reopen', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":"synthetic"}') })
  const first = await post(f.gateway); assert.equal(first.status, 429); await first.text()
  const next = await post(f.gateway); assert.equal(next.status, 503); await next.text()
  assert.equal((await f.gateway.status()).available, false)
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
  await assert.rejects(startOwnerTestGateway(f.options), /private owner test is unavailable/)
})
test('missing terminal completion is ambiguous and cannot trigger another request', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"type":"response.created"}\n\n') })
  await (await post(f.gateway)).text()
  assert.equal((await f.gateway.status()).available, false)
  assert.equal((await post(f.gateway)).status, 503)
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
})
test('successful completion survives chunk boundaries and reopen with a fresh local port', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"type":"response.com'); res.end('pleted","response":{"status":"completed"}}\n\n')
  })
  await (await post(f.gateway)).text(); const oldPort = f.gateway.baseUrl
  await f.gateway.close()
  const reopened = await startOwnerTestGateway(f.options); t.after(() => reopened.close())
  assert.notEqual(reopened.baseUrl, oldPort)
  assert.equal(reopened.catalogPath, f.gateway.catalogPath)
  assert.equal((await reopened.status()).available, true)
  await (await post(reopened)).text()
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 2)
})
test('expired snapshot refuses new calls rather than claiming a current balance', async t => {
  const f = await fixture(t)
  const expired = { ...f.options, now: () => f.launch.value.expiresAt }
  await assert.rejects(startOwnerTestGateway(expired))
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0)
})
test('client cancellation before terminal completion stops dispatch across reopen', async t => {
  let incomingClosed
  const closed = new Promise(resolve => { incomingClosed = resolve })
  const f = await fixture(t, (_req, res) => {
    res.once('close', incomingClosed)
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"type":"response.created"}\n\n')
  })
  const response = await post(f.gateway), reader = response.body.getReader()
  await reader.read(); await reader.cancel(); await closed
  assert.equal((await f.gateway.status()).available, false)
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
  await assert.rejects(startOwnerTestGateway(f.options))
})
test('settled response.completed permits client close before HTTP EOF without false ambiguity', async t => {
  let incomingClosed
  const closed = new Promise(resolve => { incomingClosed = resolve })
  const f = await fixture(t, (_req, res) => {
    res.once('close', incomingClosed)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"type":"response.completed","response":{"status":"completed"}}\n\n')
  })
  const response = await post(f.gateway), reader = response.body.getReader()
  const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /response.completed/)
  await reader.cancel(); await closed
  assert.equal((await f.gateway.status()).available, true)
  await f.gateway.close()
  const reopened = await startOwnerTestGateway(f.options); t.after(() => reopened.close())
  assert.equal((await reopened.status()).available, true)
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1, 'Reopening must not replay inference')
})
test('preload exposes only fixed native candidate information and renderer uses it', () => {
  const vm = require('node:vm'), exposed = {}, channels = []
  const info = { mode: 'owner-metered-test', paid: true, banner: 'Private engine test · Real Luna Light · Uses existing allowance' }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.js'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value } }, ipcRenderer: { sendSync: channel => { channels.push(channel); return info } } }),
    process: { platform: 'linux' },
  })
  assert.deepEqual(channels, ['engine-candidate:info'])
  assert.equal(exposed.electronAPI.engineCandidateInfo, info)
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  assert.match(main, /event\.returnValue = engineCandidate\.info/)
  const renderer = fs.readFileSync(path.join(__dirname, '../src/main.jsx'), 'utf8')
  assert.match(renderer, /electronAPI\?\.engineCandidateInfo\?\.banner/)
  assert.match(renderer, /Provider status unavailable/)
  const adapter = fs.readFileSync(path.join(__dirname, '../electron/veloEngineCandidate.cjs'), 'utf8')
  assert.match(adapter, /await runCandidateTurn\(/)
  assert.match(adapter, /signal, assertAuthorized, onWaiting/)
  assert.match(adapter, /owner-metered-test-\$\{ownerLaunch\.launchSha256\}/)
})
