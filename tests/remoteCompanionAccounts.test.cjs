'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { reviewPhoneAccountRequests, MAX_RESPONSE } = require('../electron/remoteCompanionAccounts.cjs');
const secret = () => randomBytes(32).toString('base64url');
const item = () => ({ requestId: secret(), accountDisplayName: 'Synthetic owner', computerName: 'Editing computer', expiresAt: Date.now() + 60000 });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-native-account-link-'));
  const configPath = path.join(dir, 'private.json');
  const config = { version: 1, url: 'wss://connect.example.test/relay', roomId: secret(), token: secret(), secret: secret() };
  await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { configPath, config, options: { configPath } };
}
test('adopts existing room with native approval; config and E2E secret never leave desktop', async t => {
  const f = await fixture(t), pending = item(), calls = [];
  const original = await fs.readFile(f.configPath, 'utf8');
  const result = await reviewPhoneAccountRequests({ ...f.options, confirm: async names => {
    assert.deepEqual(names, { accountDisplayName: pending.accountDisplayName, computerName: pending.computerName }); return true;
  }, request: async input => {
    calls.push(input);
    assert.equal(input.url.origin, 'https://connect.example.test');
    assert.equal(input.url.search, ''); assert.equal(input.url.hash, '');
    assert.equal(input.token, f.config.token);
    assert.equal(JSON.stringify(input.body).includes(f.config.secret), false);
    return calls.length === 1 ? { requests: [pending] } : { success: true, status: 'approved' };
  } });
  assert.deepEqual(result, { linked: 1, declined: 0, requestsChecked: 1 });
  assert.equal(calls[0].url.pathname, '/account/desktop/link-requests');
  assert.deepEqual(calls[0].body, { roomId: f.config.roomId });
  assert.equal(calls[1].url.pathname, '/account/desktop/link-decision');
  assert.deepEqual(calls[1].body, { roomId: f.config.roomId, requestId: pending.requestId, approved: true });
  assert.equal(JSON.stringify(result).includes(f.config.token), false);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), original);
});
test('native decline posts false, empty list needs no dialog, expired requests cannot approve', async t => {
  const f = await fixture(t), pending = item(); let decision;
  const result = await reviewPhoneAccountRequests({ ...f.options, confirm: async () => false,
    request: async ({ body }) => body.requestId ? (decision = body, { success: true }) : { requests: [pending] } });
  assert.equal(result.declined, 1); assert.equal(decision.approved, false);
  for (const requests of [[], [{ ...pending, expiresAt: Date.now() - 1 }]]) {
    const next = await reviewPhoneAccountRequests({ ...f.options, confirm: () => { throw Error('No dialog expected'); }, request: async () => ({ requests }) });
    assert.equal(next.linked, 0);
  }
});
test('first approved account resolves this computer without offering stale competing requests', async t => {
  const f = await fixture(t); let dialogs = 0, decisions = 0;
  const result = await reviewPhoneAccountRequests({ ...f.options, confirm: async () => { dialogs++; return true; },
    request: async ({ body }) => body.requestId ? (decisions++, { success: true }) : { requests: [item(), item()] } });
  assert.equal(result.linked, 1); assert.equal(dialogs, 1); assert.equal(decisions, 1);
});
test('stale desktop, abort and changed config after dialog never submit approval', async t => {
  for (const change of ['stale', 'abort', 'config']) {
    const f = await fixture(t), controller = new AbortController(); let current = true, calls = 0;
    await assert.rejects(reviewPhoneAccountRequests({ ...f.options, signal: controller.signal, isCurrent: () => current,
      request: async () => { calls++; return { requests: [item()] }; }, confirm: async () => {
        if (change === 'stale') current = false;
        if (change === 'abort') controller.abort();
        if (change === 'config') await fs.writeFile(f.configPath, JSON.stringify({ ...f.config, token: secret() }));
        return true;
      } }));
    assert.equal(calls, 1);
  }
});
test('invalid and duplicate request metadata is refused before any dialog or decision', async t => {
  const f = await fixture(t), pending = item();
  for (const requests of [null, [pending, pending], [{ ...pending, requestId: '../bad' }],
    [{ ...pending, computerName: 'x'.repeat(121) }], [{ ...pending, accountDisplayName: 'bad\nidentity' }],
    [{ ...pending, expiresAt: 'tomorrow' }], Array.from({ length: 11 }, item)]) {
    let dialogs = 0, calls = 0;
    await assert.rejects(reviewPhoneAccountRequests({ ...f.options, confirm: () => { dialogs++; return true; },
      request: async () => { calls++; return { requests }; } }));
    assert.equal(dialogs, 0); assert.equal(calls, 1);
  }
});
test('failed decision is not retried and private file stays unchanged', async t => {
  const f = await fixture(t); let calls = 0;
  const original = await fs.readFile(f.configPath, 'utf8');
  await assert.rejects(reviewPhoneAccountRequests({ ...f.options, confirm: async () => true,
    request: async () => { if (++calls === 1) return { requests: [item()] }; throw Error('Simulated lost reply'); } }));
  assert.equal(calls, 2); assert.equal(await fs.readFile(f.configPath, 'utf8'), original);
});
test('native HTTP client accepts JSON only; redirects, wrong role, oversized or broken replies do not trigger decisions', async t => {
  const f = await fixture(t); let mode = 'ok', calls = 0;
  const server = http.createServer((req, res) => {
    calls++; assert.equal(req.headers.authorization, `Bearer ${f.config.token}`);
    assert.equal(req.headers.cookie, undefined);
    req.resume();
    if (mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/private' }); res.end(); }
    else if (mode === 'role') { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"invalid_request"}'); }
    else if (mode === 'oversized') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('x'.repeat(MAX_RESPONSE + 1)); }
    else if (mode === 'broken') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('bad json'); }
    else if (mode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('{}'); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"requests":[]}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  f.config.url = `ws://127.0.0.1:${server.address().port}/relay`;
  await fs.writeFile(f.configPath, JSON.stringify(f.config));
  const options = { ...f.options, allowLocalTest: true, confirm: () => { throw Error('Unexpected approval'); } };
  assert.deepEqual(await reviewPhoneAccountRequests(options), { linked: 0, declined: 0, requestsChecked: 0 });
  for (mode of ['redirect', 'role', 'oversized', 'broken', 'html']) {
    const before = calls; await assert.rejects(reviewPhoneAccountRequests(options)); assert.equal(calls, before + 1);
  }
});
