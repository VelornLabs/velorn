'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { createRemoteCompanionServer, validateConfig, readConfig, validateRequest, MAX_RANGE, MAX_RESPONSE } = require('../electron/remoteCompanionDesktop.cjs');
const { createPairingSecret } = require('../electron/remoteCompanionCrypto.cjs');

const token = () => randomBytes(32).toString('base64url');
const bearer = () => `Bearer ${randomBytes(32).toString('hex')}`;
const mediaId = 'a'.repeat(48);
const configuration = () => ({ version: 1, url: 'wss://connect.example.test/relay', roomId: token(), token: token(), secret: createPairingSecret() });
const decode = response => Buffer.from(response.body, 'base64');
const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-remote-desktop-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(t, { handler, start, noConfig = false, config, localUrl, allowLocalTest = false } = {}) {
  const dir = await temp(t), configPath = path.join(dir, 'remote.secret.json');
  const saved = config || configuration();
  if (!noConfig) await fs.writeFile(configPath, JSON.stringify(saved), { mode: 0o600 });
  const received = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      received.push({ path: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString() });
      if (handler) handler(request, response, received.length);
      else { response.setHeader('Content-Type', 'application/json'); response.end('{"ok":true}'); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const peers = [], statuses = [], localCalls = [];
  let enabled = false, callback, starts = 0;
  const local = {
    getStatus: () => ({ enabled, localUrl: localUrl || `http://127.0.0.1:${port}/` }),
    async start() { enabled = true; const index = ++starts; localCalls.push(['start', index]); if (start) await start(index); callback.onStatus(local.getStatus()); },
    async stop(reason) { enabled = false; localCalls.push(['stop', reason]); callback.onStatus({ ...local.getStatus(), reason }); },
    isCurrentScope: (...args) => ['scope', ...args], publish: (...args) => ['publish', ...args], resolveCommand: (...args) => ['resolve', ...args],
  };
  const adapter = createRemoteCompanionServer({ onStatus: status => statuses.push(status) }, {
    configPath, allowLocalTest,
    localFactory(options) { callback = options; return local; },
    peerFactory(options) {
      const peer = { options, started: 0, closed: 0,
        start() { this.started++; options.onReady(); },
        close() { this.closed++; options.onClose({ reason: 'closed' }); },
      };
      peers.push(peer); return peer;
    },
  });
  t.after(async () => {
    await adapter.stop();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  return { adapter, saved, configPath, peers, statuses, received, localCalls, local, port,
    get request() { return peers.at(-1).options.onRequest; },
    disconnect() { peers.at(-1).options.onClose({ reason: 'disconnected' }); },
    ready() { peers.at(-1).options.onReady(); },
  };
}

test('remote config requires exact known fields, secure URL and random-shape credentials', () => {
  const input = configuration();
  assert.deepEqual(validateConfig(input), input);
  for (const patch of [{ version: 2 }, { secret: 'password' }, { roomId: 'short' }, { phoneToken: token() },
    { url: 'http://connect.example.test/relay' }, { url: 'wss://user:pass@connect.example.test/relay' },
    { url: 'wss://connect.example.test/mcp' }, { url: 'wss://connect.example.test/relay?token=hidden' },
    { url: 'wss://connect.example.test/relay#hidden' }, { url: 'ws://127.0.0.1:8787/relay' }]) {
    assert.throws(() => validateConfig({ ...input, ...patch }));
  }
  assert.equal(validateConfig({ ...input, url: 'ws://127.0.0.1:8787/relay' }, true).url, 'ws://127.0.0.1:8787/relay');
  assert.throws(() => validateConfig({ ...input, url: 'ws://public.example.test/relay' }, true));
});

test('native config read handles missing file and rejects symlink/nonprivate/large/invalid files', async (t) => {
  const dir = await temp(t), file = path.join(dir, 'remote.secret.json'), input = configuration();
  assert.equal(await readConfig(null), null);
  assert.equal(await readConfig(file), null);
  await fs.writeFile(file, JSON.stringify(input), { mode: 0o600 });
  assert.deepEqual(await readConfig(file), input);
  if (process.platform !== 'win32') {
    const link = path.join(dir, 'link');
    await fs.symlink(file, link);
    await assert.rejects(readConfig(link));
    await fs.chmod(file, 0o644);
    await assert.rejects(readConfig(file), /private/);
    await fs.chmod(file, 0o600);
  }
  await fs.writeFile(file, ' '.repeat(8193));
  await assert.rejects(readConfig(file));
  await fs.writeFile(file, '{bad');
  await assert.rejects(readConfig(file));
  await assert.rejects(readConfig(dir));
});

test('route schema rejects arbitrary URLs, IPC/MCP paths, unbounded media and caller cookies', () => {
  for (const request of [
    { method: 'GET', path: 'http://127.0.0.1:19790/mcp' },
    { method: 'POST', path: '/mcp', body: '{}' },
    { method: 'GET', path: '/api/state?url=http://evil.test' },
    { method: 'GET', path: '/api/../private' },
    { method: 'GET', path: '/api/state', headers: { host: 'evil.test' } },
    { method: 'GET', path: '/api/state', headers: { cookie: 'secret' } },
    { method: 'GET', path: '/api/state', headers: { authorization: 'Bearer wrong' } },
    { method: 'GET', path: '/api/state', headers: { authorization: `${bearer()}\r\nX-Evil:yes` } },
    { method: 'GET', path: '/api/state', body: '{}' },
    { method: 'POST', path: '/api/command', body: '[]' },
    { method: 'POST', path: '/api/command', body: '{bad' },
    { method: 'POST', path: '/api/command', body: JSON.stringify({ value: 'x'.repeat(21000) }) },
    { method: 'GET', path: `/media/audio/${mediaId}`, headers: {} },
    { method: 'GET', path: `/media/audio/${mediaId}`, headers: { range: 'bytes=0-' } },
    { method: 'GET', path: `/media/audio/${mediaId}`, headers: { range: `bytes=0-${MAX_RANGE}` } },
    { method: 'GET', path: `/media/audio/${mediaId}`, headers: { range: 'bytes=10-1' } },
    { method: 'GET', path: `/media/audio/${mediaId}`, headers: { range: 'bytes=0-1,2-3' } },
    { method: 'GET', path: `/media/audio/${mediaId}`, headers: { range: 'bytes=9007199254740992-9007199254740993' } },
    { method: 'GET', path: `/media/reviews/${mediaId}/download` },
  ]) assert.throws(() => validateRequest(request), JSON.stringify(request));
  assert.doesNotThrow(() => validateRequest({ method: 'GET', path: `/media/audio/${mediaId}`, headers: { range: `bytes=0-${MAX_RANGE - 1}` } }));
  assert.doesNotThrow(() => validateRequest({ method: 'HEAD', path: `/media/exports/${mediaId}/download` }));
  assert.doesNotThrow(() => validateRequest({ method: 'GET', path: `/media/reviews/${mediaId}` }));
  assert.doesNotThrow(() => validateRequest({ method: 'POST', path: '/api/pair', body: '{"code":"example"}' }));
});

test('API calls reach owned loopback only, normalize origin/JSON and hide private headers', async (t) => {
  const f = await fixture(t, { handler(request, response) {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Set-Cookie', `velorn_media=${'c'.repeat(64)}; HttpOnly`);
    response.setHeader('X-Private', 'not for the phone');
    response.end('{"accepted":true}');
  } });
  await f.adapter.start();
  const auth = bearer();
  const result = await f.request({ method: 'POST', path: '/api/command', headers: { Authorization: auth, 'Content-Type': 'application/json; charset=utf-8' }, body: '{"kind":"preview"}' });
  assert.equal(result.status, 200);
  assert.equal(decode(result).toString(), '{"accepted":true}');
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(result.headers['x-private'], undefined);
  assert.equal(f.received[0].headers.authorization, auth);
  assert.equal(f.received[0].headers.origin, `http://127.0.0.1:${f.port}`);
  assert.equal(f.received[0].headers['content-type'], 'application/json');
  assert.equal(f.received[0].body, '{"kind":"preview"}');
  const blocked = await f.request({ method: 'GET', path: 'http://elsewhere.test' });
  assert.equal(blocked.status, 400);
  assert.equal(f.received.length, 1);
});

test('unowned local listener target is refused, even when peer is authenticated', async (t) => {
  for (const localUrl of ['http://192.168.0.1:5212/', 'http://localhost:5212/', 'http://127.0.0.1:5212/private',
    'https://127.0.0.1:5212/', 'http://user:pass@127.0.0.1:5212/', 'http://127.0.0.1:5212/?x=1']) {
    const f = await fixture(t, { localUrl });
    await f.adapter.start();
    assert.equal((await f.request({ method: 'GET', path: '/api/state' })).status, 503);
    assert.equal(f.received.length, 0);
  }
});

test('media cookie stays native, comes only from successful authenticated state, clears on disconnect', async (t) => {
  const cookie = `velorn_media=${'b'.repeat(64)}`;
  const f = await fixture(t, { handler(request, response) {
    if (request.url === '/api/state') { response.setHeader('Set-Cookie', `${cookie}; HttpOnly; SameSite=Strict`); response.end('{}'); }
    else { response.writeHead(206, { 'Content-Type': 'audio/flac', 'Content-Range': 'bytes 0-3/100', 'Content-Length': 4 }); response.end(Buffer.from([0, 1, 2, 3])); }
  } });
  await f.adapter.start();
  const media = { method: 'GET', path: `/media/audio/${mediaId}`, headers: { range: 'bytes=0-3' } };
  assert.equal((await f.request(media)).status, 401);
  await f.request({ method: 'GET', path: '/api/state', headers: { authorization: bearer() } });
  const response = await f.request(media);
  assert.equal(response.status, 206);
  assert.deepEqual(decode(response), Buffer.from([0, 1, 2, 3]));
  assert.equal(f.received.at(-1).headers.cookie, cookie);
  assert.equal(response.headers['set-cookie'], undefined);
  f.disconnect();
  assert.equal((await f.request(media)).status, 503);
  f.ready();
  assert.equal((await f.request(media)).status, 401);
});

test('different bearer clears previous media cookie, and non-state replies never set it', async (t) => {
  const cookie = `velorn_media=${'d'.repeat(64)}`;
  const f = await fixture(t, { handler(request, response) {
    response.setHeader('Set-Cookie', `${cookie}; HttpOnly`);
    response.end('{}');
  } });
  await f.adapter.start();
  const auth = bearer(), media = { method: 'GET', path: `/media/reviews/${mediaId}` };
  await f.request({ method: 'POST', path: '/api/pair', body: '{}' });
  assert.equal((await f.request(media)).status, 401);
  await f.request({ method: 'GET', path: '/api/state', headers: { authorization: auth } });
  assert.equal((await f.request(media)).status, 200);
  await f.request({ method: 'POST', path: '/api/command', headers: { authorization: bearer() }, body: '{}' });
  assert.equal((await f.request(media)).status, 401);
});

test('redirects are never followed, large known-length response is bounded', async (t) => {
  const f = await fixture(t, { handler(request, response, number) {
    if (number === 1) { response.writeHead(302, { Location: 'http://127.0.0.1:19790/mcp' }); response.end(); }
    else { response.writeHead(200, { 'Content-Length': MAX_RESPONSE + 1 }); response.end('x'); }
  } });
  await f.adapter.start();
  assert.equal((await f.request({ method: 'GET', path: '/api/state' })).status, 502);
  assert.equal((await f.request({ method: 'GET', path: '/api/state' })).status, 502);
  assert.equal(f.received.length, 2);
});

test('streamed response larger than limit is stopped without delivering a partial success', async (t) => {
  const f = await fixture(t, { handler(request, response) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write(Buffer.alloc(MAX_RESPONSE, 'x'));
    response.end('overflow');
  } });
  await f.adapter.start();
  const result = await f.request({ method: 'GET', path: '/api/state' });
  assert.equal(result.status, 502);
  assert.ok(decode(result).length < 1000);
});

test('HEAD media response permits total Content-Length without loading body', async (t) => {
  const f = await fixture(t, { handler(request, response) {
    if (request.url === '/api/state') { response.setHeader('Set-Cookie', `velorn_media=${'e'.repeat(64)}; HttpOnly`); response.end('{}'); }
    else { response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MAX_RESPONSE * 100 }); response.end(); }
  } });
  await f.adapter.start();
  await f.request({ method: 'GET', path: '/api/state', headers: { authorization: bearer() } });
  const result = await f.request({ method: 'HEAD', path: `/media/exports/${mediaId}` });
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-length'], String(MAX_RESPONSE * 100));
  assert.equal(decode(result).length, 0);
});

test('aborting or disconnecting cancels in-flight loopback requests', async (t) => {
  const reached = defer();
  const f = await fixture(t, { handler() { reached.resolve(); } });
  await f.adapter.start();
  const controller = new AbortController();
  const pending = f.request({ method: 'GET', path: '/api/state' }, { signal: controller.signal });
  await reached.promise;
  controller.abort();
  assert.ok([502, 503].includes((await pending).status));
  assert.equal((await f.request({ method: 'GET', path: '/api/state' }, { signal: controller.signal })).status, 503);
  f.disconnect();
  assert.equal((await f.request({ method: 'GET', path: '/api/state' })).status, 503);
});

test('missing or malformed remote config leaves LAN running and reports no secret details', async (t) => {
  for (const options of [{ noConfig: true }, { config: { ...configuration(), token: 'private-invalid-value!' } }]) {
    const f = await fixture(t, options);
    await f.adapter.start();
    assert.equal(f.adapter.getStatus().enabled, true);
    assert.equal(f.adapter.getStatus().remote.configured, false);
    assert.equal(f.peers.length, 0);
    assert.equal(JSON.stringify(f.statuses).includes('private-invalid-value!'), false);
    assert.equal(JSON.stringify(f.statuses).includes(f.saved.secret), false);
  }
});

test('normal lifecycle and delegates retain local API, old peer callbacks cannot re-enable after stop', async (t) => {
  const f = await fixture(t);
  await f.adapter.start();
  const first = f.peers[0];
  assert.equal(f.adapter.getStatus().remote.connected, true);
  assert.deepEqual(f.adapter.isCurrentScope('example'), ['scope', 'example']);
  assert.deepEqual(f.adapter.publish('snapshot'), ['publish', 'snapshot']);
  assert.deepEqual(f.adapter.resolveCommand('receipt'), ['resolve', 'receipt']);
  const status = JSON.stringify(f.adapter.getStatus());
  assert.equal(status.includes(f.saved.secret), false);
  assert.equal(status.includes(f.saved.token), false);
  await f.adapter.stop('disabled');
  first.options.onReady();
  first.options.onClose({ reason: 'stale' });
  assert.equal(f.adapter.getStatus().remote.connected, false);
  assert.equal(f.adapter.getStatus().remote.reason, 'disabled');
  await f.adapter.start();
  assert.equal(f.peers.length, 2);
  assert.equal(first.closed, 1);
  assert.equal(f.adapter.getStatus().remote.connected, true);
});

test('stale asynchronous start cannot create another peer after a newer start', async (t) => {
  const blocked = defer();
  const f = await fixture(t, { start(number) { if (number === 1) return blocked.promise; } });
  const firstStart = f.adapter.start();
  await tick();
  await f.adapter.stop('stopped-during-start');
  await f.adapter.start();
  assert.equal(f.peers.length, 1);
  blocked.resolve();
  await firstStart;
  assert.equal(f.peers.length, 1, 'The obsolete start must not replace or duplicate the live peer.');
  assert.equal(f.adapter.getStatus().remote.connected, true);
});

test('mutating POST whose native receipt is lost rejects uncertain delivery instead of a negative receipt', async (t) => {
  let applied = 0;
  const f = await fixture(t, { handler(request, response) {
    if (request.url === '/api/command') {
      // Stand-in for native action receipt reserved, but response socket lost.
      applied++;
      request.socket.destroy();
    } else response.end('{"receipt":{"id":"sent-once","status":"completed"}}');
  } });
  await f.adapter.start();
  await assert.rejects(f.request({ method: 'POST', path: '/api/command', body: '{"id":"sent-once"}' }),
    error => error.code === 'REMOTE_UNCERTAIN' && /delivery may be uncertain/i.test(error.message));
  assert.equal(applied, 1);
  const state = await f.request({ method: 'POST', path: '/api/state', body: '{}' });
  assert.equal(state.status, 200);
  assert.equal(JSON.parse(decode(state)).receipt.status, 'completed');
  assert.equal(applied, 1, 'Recovery inspection must not resubmit the POST.');
});

test('account review is exclusive, cancels its native HTTP request on stop, and cannot approve a stale dialog', async t => {
  const reached = defer(); let decisions = 0;
  let waitForReply = true;
  const f = await fixture(t, { allowLocalTest: true, handler(request, response) {
    if (request.url.endsWith('/link-decision')) decisions++;
    reached.resolve();
    if (!waitForReply) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ requests: [{ requestId: token(), accountDisplayName: 'Synthetic owner',
        computerName: 'Synthetic computer', expiresAt: Date.now() + 60000 }] }));
    }
  } });
  await fs.writeFile(f.configPath, JSON.stringify({ ...f.saved, url: `ws://127.0.0.1:${f.port}/relay` }));
  await f.adapter.start();
  const pending = f.adapter.reviewPhoneAccountRequests({ confirm: () => { throw Error('Request is not ready'); } });
  const rejection = assert.rejects(pending);
  await reached.promise;
  await assert.rejects(f.adapter.reviewPhoneAccountRequests({ confirm: () => true }));
  await f.adapter.stop('account-review-test');
  await rejection;
  assert.equal(decisions, 0);
  await assert.rejects(f.adapter.reviewPhoneAccountRequests({ confirm: () => true }));
  waitForReply = false;
  await f.adapter.start();
  await assert.rejects(f.adapter.reviewPhoneAccountRequests({ confirm: async () => {
    await f.adapter.stop('while-native-dialog-open'); return true;
  } }));
  assert.equal(decisions, 0);
  assert.equal(f.adapter.getStatus().remote.connected, false);
});
