'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { setTimeout: delay } = require('node:timers/promises')
const { createPublicWebClient, createResearchReader, isPublicAddress, publicUrl, LIMITS } = require('../electron/agentResearchWeb.cjs')

function transport(responses = [], lookup) {
  const requests = [], lookups = [], streams = []
  return { requests, lookups, streams,
    lookup: async (hostname, options) => {
      lookups.push({ hostname, options })
      return lookup ? lookup(hostname, options) : [{ address: '93.184.216.34', family: 4 }]
    },
    request: (options, callback) => {
      const index = requests.length, spec = responses[index] ?? {}, request = new EventEmitter()
      requests.push({ options, request }); request.destroyed = false
      let response
      request.destroy = error => {
        request.destroyed = true
        response?.destroy(error)
        if (error) queueMicrotask(() => request.emit('error', error))
      }
      request.end = () => queueMicrotask(() => {
        if (request.destroyed || spec.noHeaders) return
        response = new PassThrough()
        response.statusCode = spec.statusCode ?? 200
        response.headers = spec.headers ?? { 'content-type': 'text/plain; charset=utf-8' }
        response.socket = { remoteAddress: spec.remoteAddress ?? '93.184.216.34' }
        streams.push(response)
        callback(response)
        if (!spec.hang) {
          for (const chunk of spec.chunks ?? [spec.body ?? 'Hello world']) if (!response.destroyed) response.write(chunk)
          if (!response.destroyed) response.end()
        }
      })
      return request
    },
  }
}
async function collect(response) {
  const chunks = []
  for await (const chunk of response.stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}
function fixtureClient(handler) {
  const calls = [], returned = []
  return { calls, returned, async open(url, options) {
    calls.push({ url, options })
    const spec = await handler(url, options)
    const raw = spec.body ?? ''
    const iterator = (async function* () { yield Buffer.from(raw) })()
    return { statusCode: spec.statusCode ?? 200, headers: spec.headers ?? { 'content-type': 'application/json' }, finalUrl: spec.finalUrl ?? url,
      stream: { next: () => iterator.next(), return: async () => { returned.push(url); return iterator.return() }, [Symbol.asyncIterator]() { return this } } }
  } }
}

test('public-address classification rejects local, private, metadata, reserved and IPv4-embedded IPv6 ranges', () => {
  for (const address of ['0.0.0.0', '0.2.3.4', '10.1.2.3', '100.64.0.1', '100.100.100.200', '100.127.255.255', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.1',
    '203.0.113.1', '224.1.1.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '168.63.129.16',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:808:808', '::8.8.8.8', '64:ff9b::7f00:1', '64:ff9b:1::a00:1', '100::1',
    '2001::1', '2001:2::1', '2001:20::1', '2001:db8::1', '2002:7f00:1::', '3fff::1', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'fe80::1%lo', 'ff02::1', 'not-an-ip']) {
    assert.equal(isPublicAddress(address), false, address)
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.128.0.1', '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address)
})

test('URL gate rejects credentials, non-HTTPS ports, local names and alternate private-IP spellings before any request', async () => {
  const mock = transport(), client = createPublicWebClient(mock)
  for (const url of ['http://example.com', 'file:///etc/passwd', 'https://name:secret@example.com', 'https://example.com:8443', 'https://localhost',
    'https://anything.local', 'https://metadata.internal', 'https://anything.home.arpa', 'https://127.0.0.1', 'https://2130706433', 'https://0x7f000001',
    'https://0177.0.0.1', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[::ffff:8.8.8.8]', 'https://example.com./',
    'https://example.com\\@127.0.0.1', ' https://example.com', 'https://example.com/\r\nheader', 'https://example.com/' + 'x'.repeat(4096)]) {
    await assert.rejects(client.open(url), error => ['INVALID_URL', 'BLOCKED_URL', 'BLOCKED_ADDRESS'].includes(error.code), url)
  }
  assert.equal(mock.requests.length, 0)
  assert.equal(mock.lookups.length, 0)
  assert.equal(publicUrl('https://EXAMPLE.com:443/path#fragment').href, 'https://example.com/path')
})

test('mixed or malformed DNS answers fail closed, with bounded resolution and no sockets opened', async () => {
  for (const answers of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
    [{ address: '::ffff:8.8.8.8', family: 6 }], [{ address: '8.8.8.8', family: 6 }], Array(33).fill({ address: '8.8.8.8', family: 4 })]) {
    const mock = transport([], () => answers)
    await assert.rejects(createPublicWebClient(mock).open('https://example.com'), { code: 'BLOCKED_ADDRESS' })
    assert.equal(mock.requests.length, 0)
  }
  const broken = transport([], () => { throw new Error('private DNS diagnostics') })
  await assert.rejects(createPublicWebClient(broken).open('https://example.com'), error => error.code === 'DNS_FAILED' && !error.message.includes('private DNS'))
})

test('TLS requests pin a vetted DNS result, keep certificate validation, and never inherit auth, cookies or a proxy agent', async () => {
  const mock = transport([{ headers: { 'content-type': 'text/plain', 'set-cookie': 'secret=hidden', 'www-authenticate': 'private', etag: 'v1' } }])
  const response = await createPublicWebClient(mock).open('https://example.com/path?q=one#fragment')
  assert.equal(await collect(response), 'Hello world')
  const { options } = mock.requests[0]
  assert.equal(options.hostname, 'example.com'); assert.equal(options.servername, 'example.com')
  assert.equal(options.path, '/path?q=one'); assert.equal(options.port, 443)
  assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true)
  assert.equal(options.autoSelectFamily, false)
  assert.deepEqual(options.headers, { Host: 'example.com', 'User-Agent': 'Velorn-Public-Research/1.0', Accept: '*/*', 'Accept-Encoding': 'identity' })
  const pinned = await new Promise(resolve => options.lookup('example.com', { all: true }, (_error, addresses) => resolve(addresses)))
  assert.deepEqual(pinned, [{ address: '93.184.216.34', family: 4 }])
  assert.equal(mock.lookups.length, 1)
  assert.equal(response.headers['set-cookie'], undefined)
  assert.equal(response.headers['www-authenticate'], undefined)
  assert.equal(response.headers.etag, 'v1')
  assert.ok(mock.requests[0].request.destroyed)
})

test('the socket address must match the approved address; only OS-reported mapped public IPv4 is equivalent', async () => {
  const changed = transport([{ remoteAddress: '127.0.0.1' }])
  await assert.rejects(createPublicWebClient(changed).open('https://example.com'), { code: 'BLOCKED_ADDRESS' })
  const mapped = transport([{ remoteAddress: '::ffff:93.184.216.34' }])
  assert.equal(await collect(await createPublicWebClient(mapped).open('https://example.com')), 'Hello world')
  const ipv6 = transport([{ remoteAddress: '2606:4700:4700::1111' }], () => [{ address: '2606:4700:4700::1111', family: 6 }])
  assert.equal(await collect(await createPublicWebClient(ipv6).open('https://example.com')), 'Hello world')
})

test('each redirect is revalidated and re-resolved, without forwarding cookies or trusting a previous safe host', async () => {
  const good = transport([{ statusCode: 302, headers: { location: 'https://example.org/next', 'set-cookie': 'private' } }, { body: 'Final' }])
  const result = await createPublicWebClient(good).open('https://example.com/start')
  assert.equal(await collect(result), 'Final')
  assert.equal(result.finalUrl, 'https://example.org/next')
  assert.deepEqual(good.lookups.map(item => item.hostname), ['example.com', 'example.org'])
  assert.equal(good.requests[1].options.headers.Cookie, undefined)
  for (const location of ['http://example.org', 'https://127.0.0.1/private', 'https://example.org:8443', 'https://user:pass@example.org', 'file:///secret']) {
    const bad = transport([{ statusCode: 302, headers: { location } }])
    await assert.rejects(createPublicWebClient(bad).open('https://example.com'))
    assert.equal(bad.requests.length, 1)
    assert.equal(bad.streams[0].destroyed, true)
  }
  const rebound = transport([{ statusCode: 302, headers: { location: '/next' } }], (_host, _options) => rebound.lookups.length === 1
    ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '169.254.169.254', family: 4 }])
  await assert.rejects(createPublicWebClient(rebound).open('https://example.com'), { code: 'BLOCKED_ADDRESS' })
  const loop = transport([{ statusCode: 301, headers: { location: '/next' } }, { statusCode: 308, headers: { location: '/again' } }])
  await assert.rejects(createPublicWebClient({ ...loop, maxRedirects: 1 }).open('https://example.com'), { code: 'TOO_MANY_REDIRECTS' })
})

test('declared and actual byte limits are enforced; HEAD can inspect a larger file without reading it', async () => {
  const declared = transport([{ headers: { 'content-length': '500' } }])
  await assert.rejects(createPublicWebClient(declared).open('https://example.com', { maxBytes: 4 }), { code: 'RESPONSE_TOO_LARGE' })
  const actual = transport([{ chunks: ['abc', 'def'] }])
  const result = await createPublicWebClient(actual).open('https://example.com', { maxBytes: 4 })
  await assert.rejects(collect(result), { code: 'RESPONSE_TOO_LARGE' })
  assert.equal(actual.streams[0].destroyed, true)
  const head = transport([{ headers: { 'content-length': '5000000000' }, body: '' }])
  const metadata = await createPublicWebClient(head).open('https://example.com/file', { method: 'HEAD', maxBytes: 4, timeoutMs: 60000 })
  assert.equal(await collect(metadata), '')
  assert.equal(metadata.headers['content-length'], '5000000000')
  assert.equal(head.requests[0].options.method, 'HEAD')
  await assert.rejects(createPublicWebClient(transport()).open('https://example.com', { method: 'POST' }), { code: 'INVALID_REQUEST' })
})

test('cancellation and total deadlines cover DNS, response headers and stalled bodies, and close owned requests', async () => {
  const controller = new AbortController(), dnsWait = transport([], () => new Promise(() => {}))
  const opening = createPublicWebClient(dnsWait).open('https://example.com', { signal: controller.signal })
  controller.abort()
  await assert.rejects(opening, { code: 'CANCELLED' })
  assert.equal(dnsWait.requests.length, 0)
  const timedDns = transport([], () => new Promise(() => {})), keepDnsAlive = delay(25)
  await assert.rejects(createPublicWebClient({ ...timedDns, timeoutMs: 5 }).open('https://example.com'), { code: 'WEB_TIMEOUT' })
  assert.equal(timedDns.requests.length, 0)
  await keepDnsAlive
  for (const spec of [{ noHeaders: true }, { hang: true }]) {
    const mock = transport([spec]), client = createPublicWebClient({ ...mock, timeoutMs: 10 })
    const operation = client.open('https://example.com').then(collect)
    const keepAlive = delay(30)
    await assert.rejects(operation, { code: 'WEB_TIMEOUT' })
    assert.equal(mock.requests[0].request.destroyed, true)
    await keepAlive
  }
  const pending = transport([{ hang: true }]), cancel = new AbortController()
  const response = await createPublicWebClient(pending).open('https://example.com', { signal: cancel.signal })
  const reading = collect(response); cancel.abort()
  await assert.rejects(reading, { code: 'CANCELLED' })
  const unconsumed = transport([{ hang: true }]), unopened = await createPublicWebClient(unconsumed).open('https://example.com')
  await unopened.stream.return()
  assert.equal(unconsumed.streams[0].destroyed, true)
  assert.equal(unconsumed.requests[0].request.destroyed, true)
  const alreadyCancelled = new AbortController(); alreadyCancelled.abort()
  const notStarted = transport()
  await assert.rejects(createPublicWebClient(notStarted).open('https://example.com', { signal: alreadyCancelled.signal }), { code: 'CANCELLED' })
  assert.equal(notStarted.lookups.length, 0)
})

test('HTML is inert bounded text with script/style content omitted and only safe resolved links', async () => {
  const html = '<!doctype html><html><head><title>A &amp; B</title><style>PRIVATE_STYLE</style></head><body>'
    + '<h1>Helpful docs</h1><script>PRIVATE_SCRIPT fetch("https://evil.example")</script><!-- HIDDEN_COMMENT -->'
    + '<p>Hello&nbsp;world &#x1f600; <a href="/guide?a=1&amp;b=2">Read &lt;guide&gt;</a></p>'
    + '<a href="http://example.org">Insecure</a><a href="https://127.0.0.1">Private</a><a href="javascript:alert(1)">JS</a>'
    + '<iframe>HIDDEN_FRAME</iframe><noscript>HIDDEN_NOSCRIPT</noscript><a href="/guide?a=1&amp;b=2">Duplicate</a></body></html>'
  const client = fixtureClient(() => ({ body: html, headers: { 'content-type': 'text/html; charset=UTF-8', 'set-cookie': 'private' } }))
  const result = await createResearchReader({ client }).read({ url: 'https://example.com/docs' })
  assert.equal(result.untrusted, true)
  assert.match(result.notice, /not instructions or permission/)
  assert.equal(result.title, 'A & B')
  assert.match(result.text, /Helpful docs/); assert.match(result.text, /Hello world 😀/)
  assert.doesNotMatch(result.text, /PRIVATE_|HIDDEN_|fetch\(|<script|<style/)
  assert.deepEqual(result.links, [{ title: 'Read <guide>', url: 'https://example.com/guide?a=1&b=2' }])
  assert.equal(client.calls.length, 1, 'no images, scripts, links, or other subresources were fetched')
  assert.equal(client.calls[0].options.maxBytes, LIMITS.responseBytes)
})

test('reader bounds text/links and safely handles malformed HTML without pathological backtracking', async () => {
  const html = '<title>Title</title><p>' + 'x'.repeat(30000) + '</p>'
    + Array.from({ length: 100 }, (_, index) => `<a href="/page-${index}">Page ${index}</a>`).join('') + '<'.repeat(250000)
  const result = await createResearchReader({ client: fixtureClient(() => ({ body: html, headers: { 'content-type': 'text/html' } })) }).read({ url: 'https://example.com' })
  assert.equal(result.text.length, LIMITS.text)
  assert.equal(result.truncated, true)
  assert.equal(result.links.length, LIMITS.links)
  const unclosed = await createResearchReader({ client: fixtureClient(() => ({ body: '<p>Visible</p><script>HIDDEN', headers: { 'content-type': 'text/html' } })) }).read({ url: 'https://example.com' })
  assert.equal(unclosed.text, 'Visible')
})

test('reader refuses unsupported/binary/compressed/oversized responses and closes unread bodies', async () => {
  for (const spec of [{ headers: { 'content-type': 'application/octet-stream' } },
    { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } },
    { headers: { 'content-type': 'text/plain; charset=latin1' } }, { body: Buffer.from([0xc3, 0x28]), headers: { 'content-type': 'text/plain' } },
    { body: 'binary\u0000data', headers: { 'content-type': 'text/plain' } }]) {
    const client = fixtureClient(() => spec)
    await assert.rejects(createResearchReader({ client }).read({ url: 'https://example.com' }), { code: 'UNSUPPORTED_CONTENT' })
    assert.equal(client.returned.length, 1)
  }
  const huge = fixtureClient(() => ({ body: 'x'.repeat(LIMITS.responseBytes + 1), headers: { 'content-type': 'text/plain' } }))
  await assert.rejects(createResearchReader({ client: huge }).read({ url: 'https://example.com' }), { code: 'RESPONSE_TOO_LARGE' })
  assert.ok(huge.returned.length >= 1)
  const denied = fixtureClient(() => ({ statusCode: 403 }))
  await assert.rejects(createResearchReader({ client: denied }).read({ url: 'https://example.com' }), { code: 'HTTP_ERROR' })
  assert.equal(denied.returned.length, 1)
})

test('public source search uses only GitHub repository and Hugging Face model APIs with bounded factual metadata', async () => {
  const client = fixtureClient(url => url.includes('api.github.com') ? { body: JSON.stringify({ items: [
    { full_name: 'owner/project', description: 'A real returned description', html_url: 'https://evil.example' },
    { full_name: 'owner/project', description: 'Duplicate' }, { full_name: '../secret' }, { full_name: 'private/repo', private: true },
    { full_name: 'owner/second', description: 'Second' },
  ], incomplete_results: true }) } : { body: JSON.stringify([{ id: 'org/model', pipeline_tag: 'text-to-image' }, { id: 'bert-base' }, { id: '../secret' }, { id: 'org/model' }]) })
  const result = await createResearchReader({ client }).search({ query: 'video & sound', source: 'all', limit: 3 })
  assert.equal(client.calls.length, 2)
  assert.equal(new URL(client.calls[0].url).pathname, '/search/repositories')
  assert.equal(new URL(client.calls[0].url).searchParams.get('q'), 'video & sound')
  assert.equal(new URL(client.calls[0].url).searchParams.get('per_page'), '3')
  assert.equal(new URL(client.calls[1].url).pathname, '/api/models')
  assert.equal(new URL(client.calls[1].url).searchParams.get('search'), 'video & sound')
  assert.deepEqual(result.results.map(item => item.url), ['https://github.com/owner/project', 'https://huggingface.co/org/model', 'https://github.com/owner/second'])
  assert.equal(result.untrusted, true)
  assert.match(result.scope, /not general web search/)
  assert.match(result.warnings[0], /incomplete/)
  assert.deepEqual(result.errors, [])
  assert.doesNotMatch(JSON.stringify(result), /evil\.example|private\/repo|secret/)
})

test('search returns explicit per-source rate-limit/errors and never fabricates missing results', async () => {
  const client = fixtureClient(url => url.includes('api.github.com') ? { statusCode: 403, headers: { 'x-ratelimit-remaining': '0' } }
    : { body: JSON.stringify([{ id: 'org/public-model' }]) })
  const result = await createResearchReader({ client }).search({ query: 'test' })
  assert.equal(result.results.length, 1)
  assert.deepEqual(result.errors.map(error => [error.source, error.code]), [['github', 'RATE_LIMITED']])
  assert.match(result.errors[0].message, /no account or API key/)
  const malformed = await createResearchReader({ client: fixtureClient(() => ({ body: 'bad private diagnostics' })) }).search({ query: 'test', source: 'github' })
  assert.deepEqual(malformed.results, [])
  assert.equal(malformed.errors[0].code, 'INVALID_RESPONSE')
  assert.doesNotMatch(JSON.stringify(malformed), /private diagnostics/)
  const foreign = await createResearchReader({ client: fixtureClient(() => ({ body: '{"items":[]}', finalUrl: 'https://example.com/api' })) }).search({ query: 'test', source: 'github' })
  assert.equal(foreign.errors[0].code, 'INVALID_RESPONSE')
})

test('reader/search cancellation and malformed inputs cannot start or continue requests', async () => {
  const client = fixtureClient(() => ({ body: '{}' })), reader = createResearchReader({ client }), controller = new AbortController()
  controller.abort()
  await assert.rejects(reader.search({ query: 'test' }, { signal: controller.signal }), { code: 'CANCELLED' })
  await assert.rejects(reader.read({ url: 'https://example.com' }, { signal: controller.signal }), { code: 'CANCELLED' })
  for (const input of [{ query: '' }, { query: 'x'.repeat(201) }, { query: 'x\nsecret' }, { query: 'test', source: 'google' }, { query: 'test', limit: 100 }, { query: 'test', limit: 0 }]) await assert.rejects(reader.search(input), { code: 'INVALID_REQUEST' })
  assert.equal(client.calls.length, 0)
  const during = new AbortController(), cancelling = fixtureClient(() => { during.abort(); return { body: '{"items":[]}' } })
  await assert.rejects(createResearchReader({ client: cancelling }).search({ query: 'test', source: 'github' }, { signal: during.signal }), { code: 'CANCELLED' })
})
