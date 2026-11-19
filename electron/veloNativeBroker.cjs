'use strict';
// Private preview transport worker. Desktop credentials never reach the engine.
// Runs in bundled Node 24 because compressed native requests require zstd.
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const { zstdDecompressSync } = require('node:zlib');
const TRANSPORT_BYTES = 64 * 1024 * 1024;
const { fetchWithAdmissionWait } = require('./veloAdmissionWait.cjs');

async function createNativeBroker({ socketPath, baseUrl, getAuthHeaders, allowLive = false,
  syntheticTransport, maxModelRequests = null, requestTimeoutMs = 300000, onEvent = () => {},
  admissionTiming, assertAuthorized = () => {} }) {
  const target = new URL(baseUrl);
  assert(target.protocol === 'https:' && !target.username && !target.password && !target.search && !target.hash);
  assert.equal(target.pathname, '/account/desktop/luna/native-test/v1');
  if (allowLive) assert.equal(target.origin, 'https://connect.velorn.ai');
  assert.equal(typeof getAuthHeaders, 'function');
  if (!allowLive) assert.equal(typeof syntheticTransport, 'function', 'Live requests require explicit owner authorization.');
  assert(!allowLive || !admissionTiming, 'Accelerated timing is fixture-only.');
  assert(maxModelRequests === null || Number.isSafeInteger(maxModelRequests) && maxModelRequests > 0);
  assert(!fs.existsSync(socketPath), 'Never replace an existing socket.');
  const capability = crypto.randomBytes(32).toString('hex');
  const transport = syntheticTransport || fetch;
  // Capture one authenticated identity before exposing the socket. No refresh or
  // account switching can occur halfway through a native tool loop.
  const ownerHeaders = Object.freeze({ ...await getAuthHeaders() });
  const events = [], active = new Set();
  let modelRequests = 0, stopped = false, fatal = null, currentFlight = null;
  const emit = value => { events.push(value); try { onEvent(value); } catch {} };
  const deny = (response, status, code) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { code, message: code } }));
  };
  const server = http.createServer(async (request, response) => {
    let dispatched = false, completed = false, waitingStream = false, id, controller;
    const flight = Symbol('owner-provider-request');
    // A settled completion permits the next model step before HTTP EOF. An old
    // request's delayed cleanup must never release a newer request's admission.
    const releaseFlight = () => { if (currentFlight === flight) currentFlight = null; };
    try {
      if (request.headers.authorization !== `Bearer ${capability}`) return deny(response, 401, 'LOCAL_CAPABILITY_REQUIRED');
      await assertAuthorized();
      if (stopped || fatal) return deny(response, 503, 'OWNER_TEST_STOPPED_NO_RETRY');
      const url = new URL(request.url, 'http://localhost');
      const catalog = request.method === 'GET' && url.pathname === '/models'
        && [...url.searchParams.keys()].every(key => key === 'client_version')
        && url.searchParams.getAll('client_version').length === 1
        && url.searchParams.get('client_version') === '0.165.0';
      const model = request.method === 'POST' && request.url === '/responses';
      if (!catalog && !model) return deny(response, 404, 'LOCAL_ROUTE_NOT_ALLOWED');
      if (currentFlight !== null) return deny(response, 409, 'TEST_REQUEST_ALREADY_ACTIVE');
      currentFlight = flight; // Admit before asynchronous body reading begins.
      let body;
      if (model) {
        const chunks = []; let bytes = 0;
        for await (const chunk of request) { bytes += chunk.length; if (bytes > TRANSPORT_BYTES) throw Error('TEST_BODY_TOO_LARGE'); chunks.push(chunk); }
        body = Buffer.concat(chunks);
        const encoding = request.headers['content-encoding'];
        if (encoding && encoding !== 'identity' && encoding !== 'zstd') return deny(response, 415, 'TEST_ENCODING_NOT_SUPPORTED');
        if (encoding === 'zstd') body = zstdDecompressSync(body, { maxOutputLength: TRANSPORT_BYTES });
        let value; try { value = JSON.parse(body); } catch { return deny(response, 400, 'INVALID_JSON'); }
        if (value.model !== 'gpt-6-luna' || value.reasoning?.effort !== 'low'
          || value.store !== false || value.stream !== true
          || value.service_tier != null && value.service_tier !== 'default') return deny(response, 400, 'TEST_MODEL_POLICY_MISMATCH');
        if (maxModelRequests !== null && modelRequests >= maxModelRequests) {
          stopped = true; emit({ type: 'test-bound', modelRequests });
          return deny(response, 429, 'OWNER_TEST_REQUEST_BOUND_REACHED');
        }
        id = crypto.randomUUID(); modelRequests++;
      }
      // Only owner-created headers are sent upstream. Child headers/cookies,
      // URLs and local capability are never forwarded to the public relay.
      assert(ownerHeaders && typeof ownerHeaders === 'object');
      const headers = { ...ownerHeaders, Accept: catalog ? 'application/json' : 'text/event-stream',
        ...(model ? { 'Content-Type': 'application/json', 'Idempotency-Key': id } : {}) };
      controller = new AbortController(); active.add(controller);
      let timeout;
      const armTimeout = () => { clearTimeout(timeout); timeout = setTimeout(() => controller.abort(), requestTimeoutMs); };
      response.once('close', () => { if (!response.writableEnded) controller.abort(); });
      emit({ type: 'request', kind: catalog ? 'catalog' : 'responses', id, bytes: body?.length || 0,
        contentEncoding: request.headers['content-encoding'] || 'identity', modelRequests });
      try {
        dispatched = true;
        const requestUrl = `${target.href}${catalog ? `/models?client_version=0.165.0` : '/responses'}`;
        const upstream = model ? await fetchWithAdmissionWait({ fetchImpl: transport, url: requestUrl, headers, body, signal: controller.signal,
          ...admissionTiming,
          assertAuthorized: async () => { assert(!stopped && !fatal && !response.destroyed); await assertAuthorized(); },
          onAttempt: attempt => { armTimeout(); emit({ type: 'admission-attempt', id, attempt }); },
          onState: progress => {
            // A proven, unadmitted wait is not provider execution time. Comments
            // keep the native SSE connection alive without entering model history.
            clearTimeout(timeout);
            emit({ type: 'admission-progress', id, ...progress });
            if (!response.headersSent) { waitingStream = true; response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); }
            response.write(': velo-admission ' + JSON.stringify(progress) + '\n\nevent: velo.admission\ndata: {"type":"velo.admission"}\n\n');
          } }) : await (await assertAuthorized(), armTimeout(), transport(requestUrl, { method: request.method, headers, body, redirect: 'error', signal: controller.signal }));
        emit({ type: 'http', id, status: upstream.status });
        const contentType = upstream.headers.get('content-type') || 'application/json';
        if (!response.headersSent) response.writeHead(upstream.status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
        if (!upstream.ok) {
          if (model) fatal = 'UPSTREAM_REFUSAL_REQUIRES_OWNER_INSPECTION';
          const errorBody = await upstream.text();
          if (waitingStream) response.end('event: error\ndata: {"type":"error","code":"relay_refused","message":"The pending request could not continue. No action was replayed."}\n\n');
          else response.end(errorBody.slice(0, 65536));
          return;
        }
        if (catalog) {
          const text = await upstream.text();
          assert(Buffer.byteLength(text) <= 2 * 1024 * 1024, 'CATALOG_TOO_LARGE');
          const value = JSON.parse(text);
          assert(Array.isArray(value.models) && value.models.length === 1 && value.models[0].slug === 'gpt-6-luna', 'CATALOG_MISMATCH');
          completed = true; releaseFlight(); response.end(text); return;
        }
        assert(contentType.includes('text/event-stream'), 'EXPECTED_RESPONSE_STREAM');
        let pending = ''; const decoder = new StringDecoder('utf8');
        for await (const chunk of upstream.body) {
          pending += decoder.write(Buffer.from(chunk));
          let newline;
          while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
            if (line.startsWith('data: ')) {
              try {
                const event = JSON.parse(line.slice(6));
                if (event.type === 'response.completed' && !completed) {
                  completed = true; releaseFlight();
                  emit({ type: 'completed', id, usage: event.response?.usage || null });
                }
                if (event.type === 'response.failed' || event.type === 'response.incomplete') fatal = 'UPSTREAM_TERMINAL_FAILURE';
              } catch {}
            }
          }
          if (pending.length > 4 * 1024 * 1024) throw Error('INVALID_EVENT_FRAMING');
          if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal });
        }
        if (!completed) { fatal = 'AMBIGUOUS_STREAM_NO_RETRY'; emit({ type: 'ambiguous', id }); }
        response.end();
      } finally { clearTimeout(timeout); active.delete(controller); }
    } catch {
      if (dispatched && id && !completed) { fatal = 'AMBIGUOUS_TRANSPORT_NO_RETRY'; emit({ type: 'ambiguous', id }); }
      else if (completed && id) emit({ type: 'transport-closed-after-completion', id });
      if (!response.headersSent) deny(response, 502, 'OWNER_BRIDGE_FAILED_NO_RETRY'); else response.destroy();
    } finally { releaseFlight(); }
  });
  server.requestTimeout = requestTimeoutMs;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);
  return { socketPath, capability,
    snapshot: () => ({ modelRequests, stopped, fatal, activeRequest: currentFlight !== null, events: structuredClone(events), liveAuthorized: allowLive }),
    async close() { stopped = true; for (const controller of active) controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert(!fs.existsSync(socketPath), 'Owned socket must be removed on close'); },
  };
}
module.exports = { createNativeBroker };

