'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { requestFundedLuna, MAX_REQUEST, MAX_RESPONSE } = require('../electron/fundedLunaTransport.cjs');
const { getPreDispatchRefusal } = require('../electron/fundedLunaRecovery.cjs');

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { url: new URL(`http://127.0.0.1:${server.address().port}/account/desktop/luna/status`),
    token: 't'.repeat(43), body: { computerId: 'c'.repeat(43) }, allowLocalTest: true };
}

test('native request uses only the fixed guided route and bounded JSON response', async t => {
  const options = await fixture(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${'t'.repeat(43)}`);
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.cookie, undefined);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, available: false, model: 'gpt-6-luna', reason: 'not_eligible', remainingMicroUsd: 0 }));
  });
  assert.equal((await requestFundedLuna(options)).available, false);
  for (const update of [{ allowLocalTest: false }, { token: 'bad' }, { url: new URL('http://127.0.0.1/other') },
    { url: new URL(options.url.href + '?token=bad') }, { body: { text: 'x'.repeat(MAX_REQUEST) } }]) {
    await assert.rejects(requestFundedLuna({ ...options, ...update }));
  }
});

test('redirect, private upstream error and oversized result are never surfaced or followed', async t => {
  let count = 0;
  const options = await fixture(t, (req, res) => {
    count++;
    res.writeHead(302, { 'content-type': 'application/json', location: '/account/desktop/luna/respond' });
    res.end('{"error":"private-upstream-error"}');
  });
  await assert.rejects(requestFundedLuna(options), error => error.code === 'LUNA_SERVICE_UNAVAILABLE' && !error.message.includes('private'));
  assert.equal(count, 1);
  const large = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('x'.repeat(MAX_RESPONSE + 1));
  });
  await assert.rejects(requestFundedLuna(large), { code: 'LUNA_INVALID_RESPONSE' });
});

test('service errors have fixed safe categories, never new automatic replay authority', async t => {
  const cases = [
    ['unauthorized', 403, 'LUNA_AUTH_REQUIRED'],
    ['not_eligible', 403, 'LUNA_NOT_ELIGIBLE'],
    ['allowance_exhausted', 402, 'LUNA_EXHAUSTED'],
    ['invalid_request', 400, 'LUNA_REQUEST_REJECTED'],
    ...['not_configured', 'upstream_unavailable', 'storage_unavailable', 'ledger_capacity', 'unknown_private_failure', 'constructor', '__proto__']
      .map(code => [code, 503, 'LUNA_SERVICE_UNAVAILABLE']),
    ...['request_already_used', 'request_conflict'].map(code => [code, 409, 'LUNA_RESPONSE_UNCERTAIN']),
    ['request_cancelled', 409, 'CANCELLED'],
  ];
  for (const [serviceCode, status, code] of cases) {
    let count = 0;
    const options = await fixture(t, (_req, res) => {
      count++;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: serviceCode, detail: 'PRIVATE upstream credential: secret-token' }));
    });
    options.url.pathname = '/account/desktop/luna/respond';
    options.body.requestId = 'synthetic-error-request';
    await assert.rejects(requestFundedLuna(options), error => {
      assert.equal(error.code, code, serviceCode);
      assert.equal(getPreDispatchRefusal(error, options.body.requestId), undefined);
      assert.doesNotMatch(error.message, /PRIVATE|secret-token|unknown_private_failure/);
      assert.equal(error.message.includes(options.token), false);
      assert.deepEqual(Object.keys(error), ['code']);
      if (!['LUNA_AUTH_REQUIRED', 'LUNA_NOT_ELIGIBLE', 'LUNA_EXHAUSTED'].includes(code)) {
        assert.doesNotMatch(error.message, /account|allowance|reconnect/i);
      }
      return true;
    });
    assert.equal(count, 1);
  }
});

test('malformed or inconsistent replies cannot claim an account rejection or leak their body', async t => {
  const cases = [
    { body: 'PRIVATE invalid JSON', code: 'LUNA_INVALID_RESPONSE' },
    { body: '{"ok":', code: 'LUNA_INVALID_RESPONSE' },
    { body: 'PRIVATE non-JSON error', type: 'text/html', status: 403, code: 'LUNA_INVALID_RESPONSE' },
    { body: JSON.stringify({ ok: true, error: 'unauthorized' }), status: 503, code: 'LUNA_SERVICE_UNAVAILABLE' },
    { body: JSON.stringify({ error: 'unauthorized' }), status: 403, code: 'LUNA_SERVICE_UNAVAILABLE' },
    { body: JSON.stringify({ ok: false, error: { private: 'PRIVATE value' } }), code: 'LUNA_SERVICE_UNAVAILABLE' },
    { body: 'null', code: 'LUNA_SERVICE_UNAVAILABLE' },
  ];
  for (const item of cases) {
    const options = await fixture(t, (_req, res) => {
      res.writeHead(item.status || 200, { 'content-type': item.type || 'application/json' });
      res.end(item.body);
    });
    await assert.rejects(requestFundedLuna(options), error => {
      assert.equal(error.code, item.code);
      assert.doesNotMatch(error.message, /PRIVATE|account|allowance|reconnect/i);
      assert.equal(getPreDispatchRefusal(error, 'unused'), undefined);
      return true;
    });
  }
});

test('local serialization failures never expose caller error messages or arbitrary codes', async t => {
  let count = 0;
  const options = await fixture(t, (_req, res) => { count++; res.end(); });
  options.body = { toJSON() { throw Object.assign(Error('PRIVATE serialization credential'), { code: 'PRIVATE_CODE' }); } };
  await assert.rejects(requestFundedLuna(options), error => {
    assert.equal(error.code, 'LUNA_REQUEST_REJECTED');
    assert.doesNotMatch(error.message, /PRIVATE|credential/);
    return true;
  });
  assert.equal(count, 0);
});

test('a lost loopback response is uncertain and is never automatically retried', async t => {
  for (const partial of [false, true]) {
    let count = 0;
    const options = await fixture(t, (_req, res) => {
      count++;
      if (partial) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
        res.write('{"ok":true,"private":"');
        setImmediate(() => res.destroy());
      } else res.destroy();
    });
    options.url.pathname = '/account/desktop/luna/respond';
    options.body.requestId = 'synthetic-lost-response';
    await assert.rejects(requestFundedLuna(options), error => {
      assert.equal(error.code, 'LUNA_RESPONSE_UNCERTAIN');
      assert.doesNotMatch(error.message, /account|allowance|reconnect|private/i);
      assert.equal(getPreDispatchRefusal(error, options.body.requestId), undefined);
      return true;
    });
    assert.equal(count, 1);
  }
});

test('the unchanged 75-second production deadline fails uncertain without retrying a paid request', async t => {
  // Exercise the real module and real loopback HTTP, substituting only its
  // timer in an isolated VM. Production gains no configurable timeout escape.
  const filename = require.resolve('../electron/fundedLunaTransport.cjs');
  const compiled = { exports: {} }, deadlines = [];
  vm.runInNewContext(readFileSync(filename, 'utf8'), {
    module: compiled, exports: compiled.exports, require: createRequire(filename), Buffer, URL,
    setTimeout(callback, milliseconds) {
      deadlines.push(milliseconds);
      return setTimeout(callback, 100);
    },
    clearTimeout,
  }, { filename });
  let count = 0;
  const options = await fixture(t, () => { count++; });
  options.url.pathname = '/account/desktop/luna/respond';
  options.body.requestId = 'synthetic-timeout-request';
  await assert.rejects(compiled.exports.requestFundedLuna(options), error => {
    assert.equal(error.code, 'LUNA_RESPONSE_UNCERTAIN');
    assert.doesNotMatch(error.message, /account|allowance|reconnect/i);
    assert.equal(getPreDispatchRefusal(error, options.body.requestId), undefined);
    return true;
  });
  assert.deepEqual(deadlines, [75_000]);
  assert.equal(count, 1);
});

test('cancellation does not retry or deliver a late funded reply', async t => {
  const controller = new AbortController(); let count = 0, started;
  const pending = new Promise(resolve => { started = resolve; });
  const options = await fixture(t, (req, res) => { count++; started(); });
  const request = requestFundedLuna({ ...options, signal: controller.signal });
  await pending; controller.abort();
  await assert.rejects(request, { code: 'CANCELLED' });
  await assert.rejects(requestFundedLuna({ ...options, signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(count, 1);
});

test('only an exact respond-route HTTP429 pre-dispatch refusal gains native recovery evidence', async t => {
  const cases = [
    { status: 429, body: { ok: false, error: 'busy' }, eligible: true },
    { status: 429, body: { ok: false, error: 'rate_limited' }, eligible: true },
    ...[200, 302, 403, 500, 503].map(status => ({ status, body: { ok: false, error: 'busy' } })),
    { status: 429, body: { error: 'busy' } },
    { status: 429, body: { ok: false, error: 'busy', unknown: 'untrusted' } },
    ...['upstream_unavailable', 'allowance_exhausted', 'request_already_used', 'request_conflict', 'unauthorized', 'request_cancelled']
      .map(error => ({ status: 429, body: { ok: false, error } })),
    { status: 429, body: { ok: false, error: 'busy' }, statusRoute: true },
  ];
  for (const item of cases) {
    const options = await fixture(t, (_req, res) => {
      res.writeHead(item.status, { 'content-type': 'application/json', 'retry-after': '3' });
      res.end(JSON.stringify(item.body));
    });
    if (!item.statusRoute) options.url.pathname = '/account/desktop/luna/respond';
    options.body.requestId = 'synthetic-request-1';
    await assert.rejects(requestFundedLuna(options), error => {
      const receipt = getPreDispatchRefusal(error, options.body.requestId);
      assert.equal(Boolean(receipt), item.eligible === true, JSON.stringify(item));
      if (receipt) {
        assert.deepEqual(receipt, { reason: item.body.error, requestId: options.body.requestId, retryAfterMs: 3000 });
        assert.equal(getPreDispatchRefusal(error, 'different-request'), undefined);
        assert.equal(getPreDispatchRefusal(Object.assign(Error(), error), options.body.requestId), undefined);
        assert.equal(Object.isFrozen(receipt), true);
      }
      return true;
    });
  }
});

test('recovery identity comes from serialized wire bytes, not later body mutation', async t => {
  let options;
  options = await fixture(t, (_req, res) => {
    options.body.requestId = 'later-mutation';
    res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"busy"}');
  });
  options.url.pathname = '/account/desktop/luna/respond'; options.body.requestId = 'sent-identity';
  await assert.rejects(requestFundedLuna(options), error => {
    assert.ok(getPreDispatchRefusal(error, 'sent-identity'));
    assert.equal(getPreDispatchRefusal(error, 'later-mutation'), undefined); return true;
  });
});
