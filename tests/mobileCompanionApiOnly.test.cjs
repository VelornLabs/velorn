'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createMobileCompanionServer, LIMITS } = require('../electron/mobileCompanionServer.cjs')
const { createDeviceStore } = require('../electron/mobileCompanionDevice.cjs')

function memoryStore() {
  let value = null
  return { async read() { return value }, async write(next) { value = structuredClone(next) }, async forget() { value = null } }
}
const snapshot = (extra = {}) => ({ protocol: 3, contextId: 'current-context', available: true, busy: false,
  provider: 'codex', messages: [], shareReviewMedia: true, ...extra })
function request(status, route, { method = 'POST', value = {}, headers = {}, token } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(`${status.localUrl}${route}`, { method,
      headers: { Origin: status.localUrl, 'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const bytes = Buffer.concat(chunks), text = bytes.toString('utf8')
        let body
        try { body = JSON.parse(text) } catch { body = text }
        resolve({ status: response.statusCode, headers: response.headers, body })
      })
    })
    outgoing.on('error', reject)
    outgoing.end(['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(value))
  })
}
async function fixture(t, options = {}) {
  const commands = [], scope = 'api-only-synthetic-scope'
  let clock = 100000
  const server = createMobileCompanionServer({ apiOnly: true, deviceStore: memoryStore(), now: () => clock,
    onMessage: () => assert.fail('API-only mode cannot accept legacy text messages'),
    onCommand: value => { commands.push(value); return { success: true } },
    networkInterfaces: () => assert.fail('Hosted-only mode must not discover LAN interfaces'), ...options })
  t.after(() => server.stop())
  const status = await server.start(scope, snapshot())
  return { server, status, scope, commands, advance: amount => { clock += amount } }
}

test('API-only configuration requires explicit loopback and native device authority', () => {
  const valid = { apiOnly: true, deviceStore: memoryStore(), onCommand() {}, onMessage() {} }
  assert.doesNotThrow(() => createMobileCompanionServer(valid))
  for (const host of ['0.0.0.0', '192.168.1.2', '127.0.0.2', 'localhost', '::1', null]) {
    assert.throws(() => createMobileCompanionServer({ ...valid, host }), /loopback/)
  }
  for (const deviceStore of [null, {}, { read() {}, write() {} }]) {
    assert.throws(() => createMobileCompanionServer({ ...valid, deviceStore }), /device authority/)
  }
  assert.throws(() => createMobileCompanionServer({ ...valid, onCommand: undefined }), /device authority/)
  for (const apiOnly of [1, 'true', null]) assert.throws(() => createMobileCompanionServer({ ...valid, apiOnly }), /explicit/)
  assert.throws(() => createMobileCompanionServer({ ...valid, apiOnly: false }), /client files/)
})

test('API-only starts without client files and exposes no static UI or browser pairing', async t => {
  const f = await fixture(t, { clientRoot: '/missing/private/mobile-client' })
  assert.equal(f.status.transport, 'loopback-http')
  assert.match(f.status.localUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.ok(f.status.port > 0)
  assert.deepEqual(f.status.urls, [])
  assert.equal(f.status.pairingCode, null)
  assert.equal(f.status.pairingExpiresAt, null)
  assert.equal(f.status.paired, false)
  for (const route of ['/', '/live.html', '/live.js', '/live.css', '/api/pair', '/mcp']) {
    assert.equal((await request(f.status, route, { method: 'GET' })).status, 404, route)
    assert.equal((await request(f.status, route, { value: { code: 'ABCDEFGHIJKL' } })).status, 404, route)
  }
  assert.equal((await request(f.status, '/api/state')).status, 401)
  f.advance(LIMITS.pairingMs + 1)
  // The existing heartbeat boundary is still enforced; a stale context cannot mint credentials.
  await assert.rejects(f.server.pairApprovedDevice(), /no longer current/)
  assert.equal(f.server.getStatus().pairingCode, null)
})

test('native-approved API-only commands keep auth, exact origin, context and duplicate guards', async t => {
  const f = await fixture(t)
  await assert.rejects(f.server.pairApprovedDevice({ isCurrent: () => false }), /no longer current/)
  const token = await f.server.pairApprovedDevice()
  assert.match(token, /^[a-f0-9]{64}$/)
  assert.equal(f.server.getStatus().paired, true)
  assert.equal(f.server.getStatus().pairingCode, null)
  await assert.rejects(f.server.pairApprovedDevice(), /no longer current/)
  assert.equal((await request(f.status, '/api/state', { token: 'b'.repeat(64) })).status, 401)
  assert.equal((await request(f.status, '/api/state', { token, headers: { Origin: 'https://foreign.example' } })).status, 403)
  assert.equal((await request(f.status, '/api/state', { token, headers: { Host: 'localhost:9999' } })).status, 403)
  const state = await request(f.status, '/api/state', { token })
  assert.equal(state.status, 200)
  assert.equal(state.body.transport, 'loopback-http')
  assert.doesNotMatch(JSON.stringify(state.body), new RegExp(token))
  assert.equal((await request(f.status, '/api/message', { token, value: { id: 'old', text: 'ignored' } })).status, 400)
  const command = { id: 'one-command', contextId: 'current-context', kind: 'message', text: 'Inspect the timeline.' }
  assert.equal((await request(f.status, '/api/command', { token, value: { ...command, contextId: 'stale' } })).status, 409)
  assert.equal((await request(f.status, '/api/command', { token, value: command })).status, 202)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.commands.length, 1)
  assert.equal(f.commands[0].scope, f.scope)
  assert.equal((await request(f.status, '/api/command', { token, value: command })).body.duplicate, true)
  assert.equal(f.commands.length, 1)
  assert.equal(f.server.publish('wrong-scope', snapshot()), false)
  assert.equal(f.server.getStatus().enabled, false)
})

test('API-only stored-device restart retains authority without private UI files and unpair revokes it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-api-only-device-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const filename = path.join(root, 'device.json')
  const first = await fixture(t, { deviceStore: createDeviceStore(filename) })
  const token = await first.server.pairApprovedDevice()
  await first.server.stop()
  const next = await fixture(t, { deviceStore: createDeviceStore(filename) })
  assert.equal(next.status.paired, true)
  assert.equal(next.status.pairingCode, null)
  assert.equal((await request(next.status, '/api/state', { token })).status, 200)
  assert.equal((await request(next.status, '/api/unpair', { token })).status, 200)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(next.server.getStatus().enabled, false)
  assert.equal(await createDeviceStore(filename).read(), null)
  const unpaired = await fixture(t, { deviceStore: createDeviceStore(filename) })
  assert.equal((await request(unpaired.status, '/api/state', { token })).status, 401)
})

test('API-only media stays cookie-scoped, range-aware and withdrawn with sharing', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-api-only-media-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const outputPath = path.join(root, 'synthetic.mp4')
  await fs.writeFile(outputPath, '0123456789abcdef')
  const context = { contextId: 'current-context', projectPath: root }
  const videoCatalog = require('../electron/mobileCompanionVideos.cjs').createMobileVideoCatalog({ getContext: () => context,
    getJobs: () => [{ jobId: 'done', status: 'completed', projectPath: root, outputPath }] })
  const f = await fixture(t, { videoCatalog })
  const token = await f.server.pairApprovedDevice()
  const state = await request(f.status, '/api/state', { token })
  const card = state.body.snapshot.videos[0], cookie = state.headers['set-cookie'][0].split(';')[0]
  assert.ok(card)
  assert.equal((await request(f.status, card.url, { method: 'GET' })).status, 401)
  const range = await request(f.status, card.url, { method: 'GET', headers: { Cookie: cookie, Range: 'bytes=2-5' } })
  assert.equal(range.status, 206)
  assert.equal(String(range.body), '2345')
  assert.equal(range.headers['content-range'], 'bytes 2-5/16')
  assert.equal((await request(f.status, card.url, { method: 'GET', headers: { Cookie: cookie, Origin: 'https://foreign.example' } })).status, 403)
  assert.equal(f.server.publish(f.scope, snapshot({ shareReviewMedia: false })), true)
  assert.equal((await request(f.status, card.url, { method: 'GET', headers: { Cookie: cookie } })).status, 410)
})

test('API-only never expires a browser pairing code but still requires a fresh desktop heartbeat', async t => {
  const f = await fixture(t)
  for (let count = 0; count < 20; count++) {
    f.advance(LIMITS.heartbeatMs - 1)
    assert.equal(f.server.publish(f.scope, snapshot()), true)
    assert.equal(f.server.getStatus().pairingCode, null)
    assert.equal(f.server.getStatus().pairingExpiresAt, null)
  }
  const token = await f.server.pairApprovedDevice()
  assert.equal((await request(f.status, '/api/state', { token })).status, 200)
  f.advance(LIMITS.heartbeatMs)
  assert.equal((await request(f.status, '/api/state', { token })).status, 410)
  assert.equal(f.server.getStatus().enabled, false)
})
