'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { zstdCompressSync } = require('node:zlib');
const { createNativeBroker: createOwnerBroker } = require('../electron/veloNativeBroker.cjs');
const { createNamespaceProvider } = require('./fixtures/native-namespace-provider.cjs');
const validBody = () => JSON.stringify({ model: 'gpt-6-luna', reasoning: { effort: 'low' }, store: false, stream: true, input: [{ role: 'user', content: 'synthetic' }], tools: [] });
const completed = () => new Response('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n', { headers: { 'content-type': 'text/event-stream', 'set-cookie': 'secret=not-forwarded' } });
async function setup(transport, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-owner-unit-'));
  let reads = 0;
  const broker = await createOwnerBroker({ socketPath: path.join(directory, 'b.sock'), baseUrl: 'https://connect.velorn.ai/account/desktop/luna/native-test/v1',
    getAuthHeaders: async () => { reads++; return { authorization: 'Bearer OWNER_TEST_SECRET', 'x-velorn-computer-id': 'owner-test-computer' }; }, syntheticTransport: transport, ...options });
  return { broker, reads: () => reads };
}
function request(broker, { method = 'GET', route = '/models?client_version=0.165.0', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: broker.socketPath, path: route, method, headers: { authorization: `Bearer ${broker.capability}`, ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() })); response.on('error', reject);
    }); req.on('error', reject); req.end(body);
  });
}
test('route/capability allowlist and owner headers never expose credentials to child', async () => {
  const seen = []; const { broker, reads } = await setup(async (url, options) => { seen.push({ url, options }); return new Response(JSON.stringify({ models: [{ slug: 'gpt-6-luna' }] }), { headers: { 'content-type': 'application/json', 'set-cookie': 'owner-cookie' } }); });
  try {
    assert.equal((await request(broker, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    for (const route of ['/account/api/session', '/responses/compact', '/models?client_version=0.1', '/models?client_version=0.165.0&client_version=0.165.0']) assert.equal((await request(broker, { route })).status, 404);
    const response = await request(broker, { headers: { cookie: 'child-cookie', 'x-velorn-computer-id': 'child-forged' } });
    assert.equal(response.status, 200); assert.equal(response.headers['set-cookie'], undefined); assert(!response.text.includes('OWNER_TEST_SECRET'));
    assert.equal(seen.length, 1); assert.equal(seen[0].options.headers.authorization, 'Bearer OWNER_TEST_SECRET');
    assert.equal(seen[0].options.headers['x-velorn-computer-id'], 'owner-test-computer'); assert.equal(seen[0].options.headers.cookie, undefined);
    assert(!JSON.stringify(seen[0].options.headers).includes(broker.capability)); assert.equal(reads(), 1);
  } finally { await broker.close(); }
  assert(!fs.existsSync(broker.socketPath));
});
test('raw/zstd JSON preserved, unique request IDs, and no implicit identity refresh', async () => {
  const seen = []; const { broker, reads } = await setup(async (url, options) => { seen.push(options); return completed(); });
  const provider = await createNamespaceProvider({ socketPath: broker.socketPath, capability: broker.capability });
  try {
    const raw = validBody();
    assert.equal((await request(broker, { method: 'POST', route: '/responses', body: raw })).status, 200);
    const compressed = await fetch(`${provider.providerUrl}/responses`, { method: 'POST', body: zstdCompressSync(Buffer.from(raw)), headers: { 'content-encoding': 'zstd' } });
    assert.equal(compressed.status, 200); await compressed.text();
    assert.equal(seen.length, 2); assert(seen.every(item => item.body.toString() === raw));
    assert.notEqual(seen[0].headers['Idempotency-Key'], seen[1].headers['Idempotency-Key']); assert.equal(reads(), 1);
    assert.equal(broker.snapshot().fatal, null);
  } finally { await provider.close(); await broker.close(); }
});
test('policy rejects before dispatch and survives non-billable validation errors', async () => {
  let calls = 0; const { broker } = await setup(async () => { calls++; return completed(); });
  try {
    for (const update of [{ model: 'different' }, { reasoning: { effort: 'high' } }, { store: true }, { stream: false }, { service_tier: 'priority' }]) {
      assert.equal((await request(broker, { method: 'POST', route: '/responses', body: JSON.stringify({ ...JSON.parse(validBody()), ...update }) })).status, 400);
    }
    assert.equal((await request(broker, { method: 'POST', route: '/responses', body: validBody(), headers: { 'content-encoding': 'gzip' } })).status, 415);
    assert.equal(calls, 0); assert.equal(broker.snapshot().modelRequests, 0);
    assert.equal((await request(broker, { method: 'POST', route: '/responses', body: validBody() })).status, 200); assert.equal(calls, 1);
  } finally { await broker.close(); }
});
test('ambiguous stream is terminal and never retried automatically', async () => {
  let calls = 0; const { broker } = await setup(async () => { calls++; return new Response('data: {"type":"response.created"}\n\n', { headers: { 'content-type': 'text/event-stream' } }); });
  try {
    await request(broker, { method: 'POST', route: '/responses', body: validBody() });
    assert.equal((await request(broker, { method: 'POST', route: '/responses', body: validBody() })).status, 503);
    assert.equal(calls, 1); assert.equal(broker.snapshot().fatal, 'AMBIGUOUS_STREAM_NO_RETRY');
  } finally { await broker.close(); }
});
test('one active provider request and an explicit test-only cap', async () => {
  let release, entered; const ready = new Promise(resolve => { entered = resolve; });
  const { broker } = await setup(async () => { entered(); await new Promise(resolve => { release = resolve; }); return completed(); }, { maxModelRequests: 1 });
  try {
    const first = request(broker, { method: 'POST', route: '/responses', body: validBody() }); await ready;
    assert.equal((await request(broker, { method: 'POST', route: '/responses', body: validBody() })).status, 409);
    release(); assert.equal((await first).status, 200);
    assert.equal((await request(broker, { method: 'POST', route: '/responses', body: validBody() })).status, 429);
    assert.equal(broker.snapshot().modelRequests, 1);
  } finally { await broker.close(); }
});
test('live origin pin rejects alternate destinations without network use', async () => {
  await assert.rejects(() => createOwnerBroker({ socketPath: '/tmp/velorn-unused-broker.sock', baseUrl: 'https://example.com/account/desktop/luna/native-test/v1', getAuthHeaders: async () => ({}), allowLive: true }));
});
test('close after completed allows next request; stale cleanup cannot release its gate', async () => {
  let calls = 0, oldStream, enterSecond, releaseSecond, oldClosed;
  const secondEntered = new Promise(resolve => { enterSecond = resolve; });
  const oldCleaned = new Promise(resolve => { oldClosed = resolve; });
  const { broker } = await setup(async () => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({ start(controller) {
      oldStream = controller;
      controller.enqueue(Buffer.from('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'));
    } }), { headers: { 'content-type': 'text/event-stream' } });
    enterSecond(); await new Promise(resolve => { releaseSecond = resolve; }); return completed();
  }, { onEvent: event => { if (event.type === 'transport-closed-after-completion') oldClosed(); } });
  try {
    await new Promise((resolve, reject) => {
      const req = http.request({ socketPath: broker.socketPath, path: '/responses', method: 'POST', headers: { authorization: `Bearer ${broker.capability}` } }, response => {
        response.once('data', () => { response.destroy(); resolve(); }); response.on('error', () => {});
      }); req.on('error', reject); req.end(validBody());
    });
    const second = request(broker, { method: 'POST', route: '/responses', body: validBody() }); await secondEntered;
    oldStream.error(Error('Transport ended after durable completed receipt'));
    await oldCleaned; await new Promise(resolve => setImmediate(resolve));
    assert.equal(broker.snapshot().fatal, null);
    assert.equal((await request(broker, { method: 'POST', route: '/responses', body: validBody() })).status, 409);
    assert.equal(calls, 2);
    releaseSecond(); assert.equal((await second).status, 200);
    assert.equal(broker.snapshot().events.filter(event => event.type === 'completed').length, 2);
    assert.equal(broker.snapshot().fatal, null);
  } finally { await broker.close(); }
});
test('pre-completion transport abort remains fatal and cannot dispatch a retry', async () => {
  let calls = 0, rejected;
  const failed = new Promise(resolve => { rejected = resolve; });
  const { broker } = await setup(async (url, { signal }) => {
    calls++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('event: response.created\ndata: {"type":"response.created"}\n\n'));
      signal.addEventListener('abort', () => controller.error(Error('Incomplete transport')), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }, { onEvent: event => { if (event.type === 'ambiguous') rejected(); } });
  try {
    await new Promise((resolve, reject) => {
      const req = http.request({ socketPath: broker.socketPath, path: '/responses', method: 'POST', headers: { authorization: `Bearer ${broker.capability}` } }, response => {
        response.once('data', () => { response.destroy(); resolve(); }); response.on('error', () => {});
      }); req.on('error', reject); req.end(validBody());
    });
    await failed;
    assert.equal((await request(broker, { method: 'POST', route: '/responses', body: validBody() })).status, 503);
    assert.equal(calls, 1); assert.equal(broker.snapshot().fatal, 'AMBIGUOUS_TRANSPORT_NO_RETRY');
  } finally { await broker.close(); }
});
test('a request still uploading its body already owns the admission gate', async () => {
  let calls = 0;
  const { broker } = await setup(async () => { calls++; return completed(); });
  let held;
  try {
    const first = new Promise((resolve, reject) => {
      held = http.request({ socketPath: broker.socketPath, path: '/responses', method: 'POST', headers: { authorization: `Bearer ${broker.capability}` } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      }); held.on('error', reject); held.write(validBody().slice(0, 10));
    });
    while (!broker.snapshot().activeRequest) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await request(broker, { method: 'POST', route: '/responses', body: validBody() })).status, 409);
    assert.equal(calls, 0); held.end(validBody().slice(10)); assert.equal(await first, 200); assert.equal(calls, 1);
  } finally { held?.destroy(); await broker.close(); }
});
test('native v2 trigger and opaque compacted window pass through unchanged on Responses only', async () => {
  const seen = [];
  const event = 'data: {"type":"response.output_item.done","item":{"type":"compaction","id":"cmp_fixture","encrypted_content":"opaque-retained"}}\n\n';
  const terminal = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n';
  const { broker } = await setup(async (url, options) => { seen.push({ url, raw: options.body.toString() }); return new Response(event + terminal, { headers: { 'content-type': 'text/event-stream' } }); });
  try {
    const body = JSON.parse(validBody()); body.input.push({ type: 'compaction_trigger' });
    const raw = JSON.stringify(body);
    const response = await request(broker, { method: 'POST', route: '/responses', body: raw });
    assert.equal(response.status, 200); assert.equal(response.text, event + terminal); assert.equal(seen[0].raw, raw);
    assert(seen[0].url.endsWith('/responses')); assert.equal(broker.snapshot().fatal, null);
    body.input = [{ type: 'compaction', id: 'cmp_fixture', encrypted_content: 'opaque-retained' }, { role: 'user', content: 'Continue' }];
    await request(broker, { method: 'POST', route: '/responses', body: JSON.stringify(body) });
    assert.deepEqual(JSON.parse(seen[1].raw).input, body.input);
    assert.equal((await request(broker, { method: 'POST', route: '/responses/compact', body: raw })).status, 404);
  } finally { await broker.close(); }
});

const refusal = (code = 'rate_limited', extra = {}) => Response.json({ reserved: false, retrySameId: true, error: { code }, ...extra }, {
  status: 429, headers: { 'x-velorn-retry-same-id': '1', 'retry-after': '0.3' } });
function virtualTiming() { let clock = 0; return { now: () => clock, wait: async ms => { clock += ms; } }; }
test('pre-admission retry keeps one logical request, one owner identity and one settled completion', async () => {
  const attempts = []; const { broker, reads } = await setup(async (_url, options) => {
    attempts.push({ key: options.headers['Idempotency-Key'], raw: options.body.toString() });
    return attempts.length < 4 ? refusal() : completed();
  }, { admissionTiming: virtualTiming(), maxModelRequests: 1 });
  try {
    const result = await request(broker, { method: 'POST', route: '/responses', body: validBody() });
    assert.equal(result.status, 200); assert.match(result.text, /velo-admission/); assert.match(result.text, /response.completed/);
    assert.equal(attempts.length, 4); assert(attempts.every(value => value.key === attempts[0].key && value.raw === attempts[0].raw));
    assert.equal(reads(), 1); assert.equal(broker.snapshot().modelRequests, 1); assert.equal(broker.snapshot().fatal, null);
    assert.equal(broker.snapshot().events.filter(value => value.type === 'completed').length, 1);
  } finally { await broker.close(); }
});
test('verified waiting does not consume the provider execution timeout', async () => {
  let calls = 0; const { broker } = await setup(async () => ++calls === 1 ? refusal() : completed(), { requestTimeoutMs: 50, admissionTiming: { tickMs: 20 } });
  try {
    const start = Date.now(); const result = await request(broker, { method: 'POST', route: '/responses', body: validBody() });
    assert(Date.now() - start >= 300); assert.match(result.text, /response.completed/); assert.equal(calls, 2); assert.equal(broker.snapshot().fatal, null);
  } finally { await broker.close(); }
});
test('budget/permission refusal after waiting stops without retrying or exposing raw diagnostics', async () => {
  let calls = 0; const { broker } = await setup(async () => ++calls === 1 ? refusal() : Response.json({ error: { code: 'private-provider-secret' } }, { status: 403 }), { admissionTiming: virtualTiming() });
  try {
    const response = await request(broker, { method: 'POST', route: '/responses', body: validBody() });
    assert.equal(response.status, 200); assert.match(response.text, /relay_refused/); assert(!response.text.includes('private-provider-secret'));
    assert.equal((await request(broker, { method: 'POST', route: '/responses', body: validBody() })).status, 503); assert.equal(calls, 2);
    assert.equal(broker.snapshot().events.filter(value => value.type === 'completed').length, 0);
  } finally { await broker.close(); }
});
test('closing the broker during wait cancels timers and no second dispatch occurs', async () => {
  let calls = 0, waiting; const entered = new Promise(resolve => { waiting = resolve; });
  const { broker } = await setup(async () => { calls++; return refusal(); }, { onEvent: value => { if (value.type === 'admission-progress') waiting(); } });
  const pending = request(broker, { method: 'POST', route: '/responses', body: validBody() }).catch(() => null);
  await entered; await broker.close(); await pending; await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(calls, 1); assert.equal(broker.snapshot().activeRequest, false);
});

