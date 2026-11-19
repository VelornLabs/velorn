'use strict'
// Real isolated native HTTP listener, synthetic device authority and instrumented
// media handles. No desktop process, project, account, or filesystem access.
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { Readable } = require('node:stream')
const { createMobileCompanionServer } = require('../electron/mobileCompanionServer.cjs')

const bytes = Buffer.from('0123456789abcdef')
const id = 'a'.repeat(48)
const route = kind => `/media/${kind}/${id}`
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function until(predicate, message) {
  const deadline = Date.now() + 3000
  while (!predicate() && Date.now() < deadline) await delay(5)
  assert.ok(predicate(), message)
}

async function fixture(t) {
  let remembered = null, token, cookie, base
  const calls = [], plans = { exports: [], audio: [] }, allPlans = [], clients = new Set()
  const scope = { projectKey: '/synthetic/project', conversationId: 'synthetic-chat', session: 'synthetic-renderer' }
  const snapshot = { contextId: 'context-a', available: true, shareReviewMedia: true, messages: [] }
  function plan(kind, options = {}) {
    const value = { ...options, entered: deferred(), release: deferred(), streamCreated: deferred() }
    plans[kind].push(value); allPlans.push(value); return value
  }
  function catalog(kind) {
    return {
      list: async () => [{ id, name: kind === 'audio' ? 'Synthetic.wav' : 'Synthetic.mp4', url: route(kind), downloadUrl: `${route(kind)}/download`, bytes: bytes.length }],
      getStatus: () => ({ state: 'ready', count: 1 }),
      async open() {
        const selected = plans[kind].shift() || { entered: deferred(), release: deferred(), streamCreated: deferred() }
        const record = { kind, selected, closed: false, closeCalls: 0, stream: null, opened: false }
        calls.push(record); selected.record = record; selected.entered.resolve()
        if (selected.blockOpen) await selected.release.promise
        if (selected.openError) throw Error('PRIVATE_SYNTHETIC_PATH /private/file.mp4')
        if (selected.missing) return null
        record.opened = true
        const close = async () => { record.closeCalls++; record.closed = true }
        return {
          size: bytes.length, name: kind === 'audio' ? 'Synthetic.wav' : 'Synthetic.mp4', mime: kind === 'audio' ? 'audio/wav' : 'video/mp4',
          handle: {
            close,
            createReadStream(options) {
              assert.equal(options.autoClose, true)
              if (selected.createError) throw Error('PRIVATE_SYNTHETIC_PATH /private/create.mp4')
              const data = bytes.subarray(options.start, options.end + 1)
              let started = false, finished = false
              const stream = new Readable({
                read() {
                  if (started) return
                  started = true
                  if (selected.streamError) { queueMicrotask(() => this.destroy(Error('PRIVATE_SYNTHETIC_PATH /private/read.mp4'))); return }
                  if (selected.holdStream) this.push(data.subarray(0, 1))
                  else { finished = true; this.push(data); this.push(null) }
                },
                destroy(error, callback) { void close().then(() => callback(error), callback) },
              })
              record.stream = stream
              record.finish = () => { if (!finished && !stream.destroyed) { finished = true; stream.push(data.subarray(1)); stream.push(null) } }
              selected.streamCreated.resolve()
              return stream
            },
          },
        }
      },
    }
  }
  const server = createMobileCompanionServer({ apiOnly: true, port: 0, host: '127.0.0.1', now: () => 100000,
    deviceStore: { read: async () => remembered, write: async value => { remembered = { ...value } }, forget: async () => { remembered = null } },
    onMessage: async () => ({ success: true }), onCommand: async () => ({ success: true }),
    videoCatalog: catalog('exports'), audioCatalog: catalog('audio') })
  function begin(path, { method = 'POST', headers = {}, body = '{}' } = {}) {
    let response, finish
    const result = new Promise(resolve => { finish = resolve })
    const outgoing = http.request(base + path, { method, agent: false,
      headers: { Origin: base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers } }, incoming => {
      response = incoming; const chunks = []
      incoming.on('data', chunk => chunks.push(chunk))
      incoming.on('end', () => finish({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks).toString() }))
      incoming.on('aborted', () => finish({ status: incoming.statusCode, aborted: true, body: Buffer.concat(chunks).toString() }))
      incoming.on('error', () => finish({ status: incoming.statusCode, aborted: true, body: Buffer.concat(chunks).toString() }))
    })
    clients.add(outgoing)
    const closed = new Promise(resolve => outgoing.once('close', () => { clients.delete(outgoing); resolve() }))
    outgoing.on('error', () => finish({ status: null, aborted: true, body: '' }))
    outgoing.end(['GET', 'HEAD'].includes(method) ? undefined : body)
    return { result, async abort() { response?.destroy(); outgoing.destroy(); await closed; await delay(20) } }
  }
  const request = (path, options) => begin(path, options).result
  const state = () => request('/api/state', { headers: { Authorization: `Bearer ${token}` } })
  async function start() {
    base = (await server.start(scope, snapshot)).localUrl
    if (!token) token = await server.pairApprovedDevice()
    const status = await state(); assert.equal(status.status, 200)
    cookie = status.headers['set-cookie'][0].split(';')[0]
  }
  t.after(async () => {
    for (const selected of allPlans) selected.release.resolve()
    for (const client of clients) client.destroy()
    await server.stop(); await delay(10)
  })
  await start()
  return { server, scope, snapshot, plan, calls, begin, request, state, start,
    publish: patch => server.publish(scope, { ...snapshot, ...patch }) }
}

for (const kind of ['exports', 'audio']) for (const method of ['GET', 'HEAD']) {
  test(`${kind} ${method}: repeated abort during lookup closes handles without starting streams or exhausting media slots`, async t => {
    const f = await fixture(t)
    for (let attempt = 0; attempt < 8; attempt++) {
      const selected = f.plan(kind, { blockOpen: true })
      const pending = f.begin(route(kind), { method, ...(method === 'GET' ? { headers: { Range: 'bytes=0-7' } } : {}) })
      await selected.entered.promise
      await pending.abort()
      assert.equal((await f.state()).status, 200, 'Chat/state remains usable after a media cancellation')
      selected.release.resolve()
      await until(() => selected.record.closed, 'The handle returned after cancellation must be closed')
      assert.equal(Boolean(selected.record.stream), false, 'Never pipe media to an already closed response')
      assert.equal(selected.record.closeCalls, 1)
    }
    const head = await f.request(route(kind), { method: 'HEAD' })
    assert.equal(head.status, 200); assert.equal(head.headers['content-length'], String(bytes.length)); assert.equal(head.body, '')
    const get = await f.request(route(kind), { method: 'GET', headers: { Range: 'bytes=3-7' } })
    assert.equal(get.status, 206); assert.equal(get.body, '34567'); assert.equal(get.headers['content-range'], 'bytes 3-7/16')
    await until(() => f.calls.every(call => !call.opened || call.closed), 'All completed media handles close')
  })
}

test('six pending media opens reserve the shared bound until cancelled lookups return and clean up', async t => {
  const f = await fixture(t), pending = []
  for (let index = 0; index < 6; index++) {
    const kind = index % 2 ? 'audio' : 'exports', selected = f.plan(kind, { blockOpen: true })
    const request = f.begin(route(kind), { method: index % 3 ? 'GET' : 'HEAD' })
    pending.push({ selected, request }); await selected.entered.promise
  }
  assert.equal((await f.request(route('exports'), { method: 'HEAD' })).status, 429)
  assert.equal(f.calls.length, 6, 'Rejected requests cannot start another catalog lookup')
  assert.equal((await f.state()).status, 200)
  await Promise.all(pending.map(({ request }) => request.abort()))
  assert.equal((await f.request(route('audio'), { method: 'HEAD' })).status, 429, 'Cancelled pending work retains its reservation until its handle is cleaned up')
  assert.equal(f.calls.length, 6)
  for (const { selected } of pending) selected.release.resolve()
  await until(() => pending.every(({ selected }) => selected.record.closed), 'Every cancelled lookup handle closes')
  assert.ok(pending.every(({ selected }) => selected.record.stream === null))
  assert.equal((await f.request(route('audio'), { method: 'HEAD' })).status, 200)
  assert.equal((await f.request(route('exports'), { method: 'GET' })).body, bytes.toString())
})

test('pending lookups and active streams share six slots and release capacity on completion or cancellation', async t => {
  const f = await fixture(t), active = [], pending = []
  for (let index = 0; index < 3; index++) {
    const selected = f.plan('audio', { holdStream: true }), request = f.begin(route('audio'), { method: 'GET' })
    active.push({ selected, request }); await selected.streamCreated.promise
  }
  for (let index = 0; index < 3; index++) {
    const selected = f.plan('exports', { blockOpen: true }), request = f.begin(route('exports'), { method: 'HEAD' })
    pending.push({ selected, request }); await selected.entered.promise
  }
  assert.equal((await f.request(route('audio'), { method: 'HEAD' })).status, 429)
  assert.equal((await f.state()).status, 200)
  pending[0].selected.release.resolve()
  assert.equal((await pending[0].request.result).status, 200)
  assert.equal((await f.request(route('exports'), { method: 'HEAD' })).status, 200, 'HEAD completion releases its pending slot')
  await active[0].request.abort()
  await until(() => active[0].selected.record.closed, 'Cancelling an active stream closes its handle')
  assert.equal((await f.request(route('exports'), { method: 'GET', headers: { Range: 'bytes=1-3' } })).body, '123')
  for (const item of active.slice(1)) { item.selected.record.finish(); assert.equal((await item.request.result).body, bytes.toString()) }
  for (const item of pending.slice(1)) { item.selected.release.resolve(); assert.equal((await item.request.result).status, 200) }
  await until(() => f.calls.every(call => !call.opened || call.closed), 'Normal completion releases all handles')
})

test('lookup, range, stream-creation and stream-read failures release admission and never expose native errors', async t => {
  const f = await fixture(t)
  for (const options of [{ missing: true }, { openError: true }]) {
    f.plan('exports', options)
    const missing = await f.request(route('exports'), { method: 'GET' })
    assert.equal(missing.status, 404); assert.doesNotMatch(missing.body, /PRIVATE_SYNTHETIC_PATH|\/private\//)
  }
  const invalid = await f.request(route('exports'), { method: 'GET', headers: { Range: 'bytes=100-200' } })
  assert.equal(invalid.status, 416); assert.equal(invalid.headers['content-range'], 'bytes */16')
  for (const options of [{ createError: true }, { streamError: true }]) {
    const selected = f.plan('exports', options)
    const result = await f.request(route('exports'), { method: 'GET' })
    assert.ok(result.status >= 400 || result.aborted, 'A stream failure cannot return a complete success')
    assert.doesNotMatch(result.body, /PRIVATE_SYNTHETIC_PATH|\/private\//)
    await until(() => selected.record.closed, 'Failed stream setup/read closes the file handle')
  }
  assert.equal((await f.request(route('exports'), { method: 'HEAD' })).status, 200)
  assert.equal((await f.state()).status, 200)
  await until(() => f.calls.every(call => !call.opened || call.closed), 'Error paths release all opened handles')
})

for (const change of [{ shareReviewMedia: false }, { available: false }, { contextId: 'context-b' }]) {
  test(`pending media stays cancelled when authority changes and is restored: ${JSON.stringify(change)}`, async t => {
    const f = await fixture(t), selected = f.plan('exports', { blockOpen: true })
    const pending = f.begin(route('exports'), { method: 'GET' }); await selected.entered.promise
    f.publish(change); f.publish({})
    selected.release.resolve()
    const result = await pending.result
    assert.ok(result.status === 410 || result.aborted, 'Restoring sharing/context cannot revive an earlier media request')
    await until(() => selected.record.closed, 'Withdrawn pending request closes its eventual handle')
    assert.equal(Boolean(selected.record.stream), false)
    assert.equal((await f.request(route('exports'), { method: 'HEAD' })).status, 200)
    assert.equal((await f.state()).status, 200)
  })
}

test('stopping closes active media and discards late opens without affecting a restarted listener', async t => {
  const f = await fixture(t)
  const active = f.plan('audio', { holdStream: true }), activeRequest = f.begin(route('audio'), { method: 'GET' })
  await active.streamCreated.promise
  const held = f.plan('exports', { blockOpen: true }), pending = f.begin(route('exports'), { method: 'GET' })
  await held.entered.promise
  await f.server.stop('synthetic-test-stop')
  await until(() => active.record.closed, 'Stop closes active stream handles')
  assert.ok((await activeRequest.result).aborted)
  await f.start()
  held.release.resolve()
  assert.ok((await pending.result).aborted)
  await until(() => held.record.closed, 'A lookup completing after stop closes its handle')
  assert.equal(Boolean(held.record.stream), false)
  assert.equal((await f.request(route('exports'), { method: 'HEAD' })).status, 200)
  assert.equal((await f.request(route('audio'), { method: 'GET' })).body, bytes.toString())
  assert.equal((await f.state()).status, 200)
})
