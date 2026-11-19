'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createResultFetch } = require('../electron/resultFetch.cjs')

// A stand-in for Electron's `net`: each request is an emitter the test drives by hand.
function fakeNet() {
  const requests = []
  return { requests, request(options) {
    const request = Object.assign(new EventEmitter(), { options, aborted: false, followed: 0, ended: false,
      abort() { this.aborted = true }, followRedirect() { this.followed++ }, end() { this.ended = true } })
    requests.push(request)
    return request
  } }
}
function answer(request, { status = 200, headers = {}, chunks = [] } = {}) {
  const response = Object.assign(new EventEmitter(), { statusCode: status, headers })
  request.emit('response', response)
  for (const chunk of chunks) response.emit('data', Buffer.from(chunk))
  response.emit('end')
}

test('a result is read even when the server sends a header no browser fetch accepts', async () => {
  // The header that hung Velorn on 2026-11-19: a value with characters above 255.
  const net = fakeNet(), fetchResult = createResultFetch(net)
  const pending = fetchResult('https://maker.example.com/clip.mp4?sig=1', { method: 'GET', redirect: 'manual' })
  const request = net.requests[0]
  assert.deepEqual([request.options.url, request.options.method, request.options.redirect, request.options.credentials, request.ended],
    ['https://maker.example.com/clip.mp4?sig=1', 'GET', 'manual', 'omit', true])
  answer(request, { headers: { 'content-type': 'video/mp4', 'content-disposition': 'attachment; filename="自动生成.mp4"', 'x-many': ['a', 'bÿ中'] }, chunks: ['abc', 'def'] })
  const response = await pending
  assert.deepEqual([response.ok, response.status, response.headers.get('content-type')], [true, 200, 'video/mp4'])
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename=".mp4"')
  assert.equal(response.headers.get('x-many'), 'a, b')
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'abcdef')
})

test('a redirect is handed back unfollowed when asked, and followed otherwise', async () => {
  const net = fakeNet(), fetchResult = createResultFetch(net)
  const manual = fetchResult('https://a.example.com/x', { redirect: 'manual' })
  net.requests[0].emit('redirect', 302, 'GET', 'https://b.example.com/y')
  const moved = await manual
  assert.deepEqual([moved.status, moved.headers.get('location'), net.requests[0].aborted, net.requests[0].followed], [302, 'https://b.example.com/y', true, 0])
  const follow = fetchResult('https://a.example.com/x', {})
  net.requests[1].emit('redirect', 301, 'GET', 'https://b.example.com/y')
  assert.equal(net.requests[1].followed, 1)
  answer(net.requests[1], { chunks: ['ok'] })
  assert.equal(await (await follow).text(), 'ok')
})

test('a failed status is reported, a network error rejects, and a stop ends the request', async () => {
  const net = fakeNet(), fetchResult = createResultFetch(net)
  const gone = fetchResult('https://a.example.com/x', {})
  answer(net.requests[0], { status: 403, chunks: ['expired'] })
  assert.deepEqual([(await gone).ok, (await gone).status], [false, 403])
  const broken = fetchResult('https://a.example.com/x', {})
  net.requests[1].emit('error', new Error('net::ERR_CONNECTION_RESET'))
  await assert.rejects(broken, /ERR_CONNECTION_RESET/)
  const controller = new AbortController()
  const stopped = fetchResult('https://a.example.com/x', { signal: controller.signal })
  controller.abort()
  await assert.rejects(stopped, { name: 'AbortError' })
  assert.equal(net.requests[2].aborted, true)
  const before = new AbortController(); before.abort()
  await assert.rejects(fetchResult('https://a.example.com/x', { signal: before.signal }), { name: 'AbortError' })
})
