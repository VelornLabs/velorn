const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const crypto = require('../electron/remoteCompanionCrypto.cjs');

async function handshake(secret = crypto.createPairingSecret(), phoneApi = crypto) {
  const desktop = await crypto.createSession({ role: 'desktop', secret });
  const phone = await phoneApi.createSession({ role: 'phone', secret });
  const desktopHello = desktop.hello();
  const phoneHello = phone.hello();
  const [desktopProof, phoneProof] = await Promise.all([
    desktop.acceptHello(phoneHello), phone.acceptHello(desktopHello),
  ]);
  await Promise.all([desktop.acceptProof(phoneProof), phone.acceptProof(desktopProof)]);
  return { desktop, phone, desktopHello, phoneHello, desktopProof, phoneProof };
}

function changedBase64(value) {
  return (value[0] === 'A' ? 'B' : 'A') + value.slice(1);
}

async function rejectsClosed(session, action, code) {
  await assert.rejects(action, { code });
  assert.equal(session.ready, false);
  assert.throws(() => session.hello(), { code: 'SESSION_CLOSED' });
  await assert.rejects(session.encrypt({ unsafe: true }), { code: 'SESSION_CLOSED' });
}

test('pairing secrets are canonical random 256-bit values, never passphrases', async () => {
  const secrets = new Set(Array.from({ length: 64 }, () => crypto.createPairingSecret()));
  assert.equal(secrets.size, 64);
  for (const secret of secrets) {
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(secret, 'base64url').length, 32);
    assert.equal(crypto.isPairingSecret(secret), true);
  }
  for (const secret of ['', 'short-password', null, 'A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42) + 'B']) {
    assert.equal(crypto.isPairingSecret(secret), false);
    await assert.rejects(crypto.createSession({ role: 'phone', secret }), { code: 'INVALID_SECRET' });
  }
  await assert.rejects(crypto.createSession({ role: 'relay', secret: crypto.createPairingSecret() }), { code: 'INVALID_ROLE' });
});

test('both roles mutually authenticate then exchange private JSON', async () => {
  const { desktop, phone, desktopHello, phoneHello } = await handshake();
  assert.equal(desktop.ready, true);
  assert.equal(phone.ready, true);
  assert.equal(desktop.sessionId, phone.sessionId);
  assert.notEqual(desktopHello.challenge, phoneHello.challenge);
  const payload = { message: 'Private review 🎬', nested: { allowed: true }, values: [null, 42] };
  const frame = await phone.encrypt(payload);
  assert.equal(frame.seq, 0);
  assert.equal(JSON.stringify(frame).includes('Private review'), false);
  assert.deepEqual(await desktop.decrypt(frame), payload);
  assert.deepEqual(await phone.decrypt(await desktop.encrypt({ reply: 'Private response' })), { reply: 'Private response' });
});

test('unchanged UMD source runs as a browser script and interoperates with CommonJS', async () => {
  const sandbox = vm.createContext({ crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/remoteCompanionCrypto.cjs'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.VelornRemoteCrypto.createSession, 'function');
  const { desktop, phone } = await handshake(crypto.createPairingSecret(), sandbox.VelornRemoteCrypto);
  assert.deepEqual(await desktop.decrypt(await phone.encrypt({ client: 'browser', unicode: 'こんにちは' })),
    { client: 'browser', unicode: 'こんにちは' });
  assert.equal(JSON.stringify(await phone.decrypt(await desktop.encrypt({ client: 'desktop' }))), '{"client":"desktop"}');
});

test('insecure browser contexts fail explicitly without weak random fallback', async () => {
  const sandbox = vm.createContext({ crypto: { getRandomValues() {} }, TextEncoder, TextDecoder, btoa, atob });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/remoteCompanionCrypto.cjs'), 'utf8'), sandbox);
  assert.throws(() => sandbox.VelornRemoteCrypto.createPairingSecret(), { code: 'CRYPTO_UNAVAILABLE' });
  await assert.rejects(sandbox.VelornRemoteCrypto.createSession({ role: 'phone', secret: crypto.createPairingSecret() }),
    { code: 'CRYPTO_UNAVAILABLE' });
});

test('same challenges with different secrets cannot authenticate', async () => {
  const desktop = await crypto.createSession({ role: 'desktop', secret: crypto.createPairingSecret() });
  const phone = await crypto.createSession({ role: 'phone', secret: crypto.createPairingSecret() });
  const desktopProof = await desktop.acceptHello(phone.hello());
  const phoneProof = await phone.acceptHello(desktop.hello());
  assert.equal(desktopProof.sessionId, phoneProof.sessionId);
  await rejectsClosed(desktop, desktop.acceptProof(phoneProof), 'AUTH_FAILED');
  await rejectsClosed(phone, phone.acceptProof(desktopProof), 'AUTH_FAILED');
});

test('data is forbidden before peer proof, including after hello only', async () => {
  const secret = crypto.createPairingSecret();
  const desktop = await crypto.createSession({ role: 'desktop', secret });
  await rejectsClosed(desktop, desktop.encrypt({ tooSoon: true }), 'NOT_READY');
  const phone = await crypto.createSession({ role: 'phone', secret });
  const secondDesktop = await crypto.createSession({ role: 'desktop', secret });
  await phone.acceptHello(secondDesktop.hello());
  await rejectsClosed(phone, phone.encrypt({ tooSoon: true }), 'NOT_READY');
});

test('hello rejects reflected roles, reflected challenges, extra keys and malformed encodings', async (t) => {
  const variants = [
    ['same role', (hello) => hello, 'INVALID_FRAME'],
    ['reflected challenge', (hello) => ({ ...hello, role: 'phone' }), 'AUTH_FAILED'],
    ['extra property', () => ({ v: 1, type: 'hello', role: 'phone', challenge: crypto.createPairingSecret(), secret: 'leak' }), 'INVALID_FRAME'],
    ['future version', () => ({ v: 2, type: 'hello', role: 'phone', challenge: crypto.createPairingSecret() }), 'INVALID_FRAME'],
    ['padded challenge', () => ({ v: 1, type: 'hello', role: 'phone', challenge: crypto.createPairingSecret() + '=' }), 'INVALID_FRAME'],
    ['short challenge', () => ({ v: 1, type: 'hello', role: 'phone', challenge: 'abcd' }), 'INVALID_FRAME'],
    ['oversized challenge', () => ({ v: 1, type: 'hello', role: 'phone', challenge: 'A'.repeat(1024 * 1024) }), 'INVALID_FRAME'],
  ];
  for (const [name, makeHello, code] of variants) await t.test(name, async () => {
    const session = await crypto.createSession({ role: 'desktop', secret: crypto.createPairingSecret() });
    await rejectsClosed(session, session.acceptHello(makeHello(session.hello())), code);
  });
});

test('proof role binding prevents reflection even when attacker rewrites role', async () => {
  const secret = crypto.createPairingSecret();
  const desktop = await crypto.createSession({ role: 'desktop', secret });
  const phone = await crypto.createSession({ role: 'phone', secret });
  const proof = await desktop.acceptHello(phone.hello());
  await rejectsClosed(desktop, desktop.acceptProof({ ...proof, role: 'phone' }), 'AUTH_FAILED');
});

test('a substituted challenge invalidates both transcript proofs', async () => {
  const secret = crypto.createPairingSecret();
  const desktop = await crypto.createSession({ role: 'desktop', secret });
  const phone = await crypto.createSession({ role: 'phone', secret });
  const desktopProof = await desktop.acceptHello({ ...phone.hello(), challenge: crypto.createPairingSecret() });
  const phoneProof = await phone.acceptHello(desktop.hello());
  assert.notEqual(desktopProof.sessionId, phoneProof.sessionId);
  await rejectsClosed(desktop, desktop.acceptProof(phoneProof), 'AUTH_FAILED');
  await rejectsClosed(phone, phone.acceptProof(desktopProof), 'AUTH_FAILED');
});

test('a saved hello/proof cannot authenticate against a fresh challenge after reconnect', async () => {
  const secret = crypto.createPairingSecret();
  const old = await handshake(secret);
  const fresh = await crypto.createSession({ role: 'desktop', secret });
  await fresh.acceptHello(old.phoneHello);
  assert.notEqual(fresh.sessionId, old.desktop.sessionId);
  await rejectsClosed(fresh, fresh.acceptProof(old.phoneProof), 'AUTH_FAILED');
});

test('duplicate handshakes cannot reset keys or counters', async () => {
  const first = await handshake();
  await rejectsClosed(first.desktop, first.desktop.acceptHello(first.phoneHello), 'INVALID_STATE');
  const second = await handshake();
  await rejectsClosed(second.desktop, second.desktop.acceptProof(second.phoneProof), 'INVALID_STATE');
});

test('tampered ciphertext, tag and metadata are terminal failures', async (t) => {
  const variants = [
    ['ciphertext', (frame) => ({ ...frame, ciphertext: changedBase64(frame.ciphertext) }), 'AUTH_FAILED'],
    ['tag', (frame) => { const bytes = Buffer.from(frame.ciphertext, 'base64url'); bytes[bytes.length - 1] ^= 1; return { ...frame, ciphertext: bytes.toString('base64url') }; }, 'AUTH_FAILED'],
    ['session', (frame) => ({ ...frame, sessionId: crypto.createPairingSecret() }), 'AUTH_FAILED'],
    ['role', (frame) => ({ ...frame, role: 'desktop' }), 'AUTH_FAILED'],
    ['sequence', (frame) => ({ ...frame, seq: 1 }), 'INVALID_SEQUENCE'],
    ['fractional sequence', (frame) => ({ ...frame, seq: 0.5 }), 'INVALID_SEQUENCE'],
    ['negative zero', (frame) => ({ ...frame, seq: -0 }), 'INVALID_SEQUENCE'],
    ['unsafe sequence', (frame) => ({ ...frame, seq: Number.MAX_SAFE_INTEGER + 1 }), 'INVALID_SEQUENCE'],
    ['version', (frame) => ({ ...frame, v: 2 }), 'AUTH_FAILED'],
    ['extra property', (frame) => ({ ...frame, extra: 'ignored?' }), 'INVALID_FRAME'],
    ['padded data', (frame) => ({ ...frame, ciphertext: frame.ciphertext + '=' }), 'INVALID_FRAME'],
    ['missing tag', (frame) => ({ ...frame, ciphertext: 'AAAA' }), 'INVALID_FRAME'],
  ];
  for (const [name, mutate, code] of variants) await t.test(name, async () => {
    const { desktop, phone } = await handshake();
    const frame = await phone.encrypt({ instruction: 'private' });
    await rejectsClosed(desktop, desktop.decrypt(mutate(frame)), code);
    await assert.rejects(desktop.decrypt(frame), { code: 'SESSION_CLOSED' });
  });
});

test('directional keys reject reflection even after sender role is rewritten', async () => {
  const { desktop } = await handshake();
  const frame = await desktop.encrypt({ reflected: true });
  await rejectsClosed(desktop, desktop.decrypt({ ...frame, role: 'phone' }), 'AUTH_FAILED');
});

test('replays and dropped/reordered frames fail closed', async () => {
  const first = await handshake();
  const replay = await first.phone.encrypt('once');
  assert.equal(await first.desktop.decrypt(replay), 'once');
  await rejectsClosed(first.desktop, first.desktop.decrypt(replay), 'INVALID_SEQUENCE');
  const second = await handshake();
  await second.phone.encrypt('dropped');
  const reordered = await second.phone.encrypt('out of order');
  await rejectsClosed(second.desktop, second.desktop.decrypt(reordered), 'INVALID_SEQUENCE');
});

test('fresh connection keys differ and reject old data even with forged session ID', async () => {
  const secret = crypto.createPairingSecret();
  const first = await handshake(secret);
  const second = await handshake(secret);
  assert.notEqual(first.desktop.sessionId, second.desktop.sessionId);
  const oldFrame = await first.phone.encrypt({ same: 'plaintext' });
  const freshFrame = await second.phone.encrypt({ same: 'plaintext' });
  assert.equal(oldFrame.seq, 0);
  assert.equal(freshFrame.seq, 0);
  assert.notEqual(oldFrame.ciphertext, freshFrame.ciphertext);
  await rejectsClosed(second.desktop,
    second.desktop.decrypt({ ...oldFrame, sessionId: second.desktop.sessionId }), 'AUTH_FAILED');
  const third = await handshake(secret);
  await rejectsClosed(third.desktop, third.desktop.decrypt(oldFrame), 'AUTH_FAILED');
});

test('simultaneous encryption/decryption serializes counters without accepting duplicate frames', async () => {
  const { desktop, phone } = await handshake();
  const values = Array.from({ length: 64 }, (_, id) => ({ id }));
  const frames = await Promise.all(values.map((value) => phone.encrypt(value)));
  assert.deepEqual(frames.map((frame) => frame.seq), values.map((value) => value.id));
  assert.equal(new Set(frames.map((frame) => frame.ciphertext)).size, 64);
  assert.deepEqual(await Promise.all(frames.map((frame) => desktop.decrypt(frame))), values);
  const frame = await phone.encrypt('next');
  const results = await Promise.allSettled([desktop.decrypt(frame), desktop.decrypt(frame)]);
  assert.equal(results[0].value, 'next');
  assert.equal(results[1].reason.code, 'INVALID_SEQUENCE');
  assert.equal(desktop.ready, false);
});

test('UTF-8 plaintext and frame sizes are bounded before expensive work', async () => {
  const boundary = await handshake();
  const value = 'A'.repeat(crypto.MAX_PLAINTEXT_BYTES - 2);
  const frame = await boundary.phone.encrypt(value);
  assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= crypto.MAX_FRAME_BYTES);
  assert.equal(await boundary.desktop.decrypt(frame), value);
  const oversized = await handshake();
  await rejectsClosed(oversized.phone, oversized.phone.encrypt(value + 'A'), 'PAYLOAD_TOO_LARGE');
  const multibyte = await handshake();
  await rejectsClosed(multibyte.phone, multibyte.phone.encrypt('🎬'.repeat(crypto.MAX_PLAINTEXT_BYTES / 3)), 'PAYLOAD_TOO_LARGE');
  const incoming = await handshake();
  const normal = await incoming.phone.encrypt(null);
  await rejectsClosed(incoming.desktop, incoming.desktop.decrypt({ ...normal, ciphertext: 'A'.repeat(crypto.MAX_FRAME_BYTES) }), 'INVALID_FRAME');
});

test('destroy invalidates queued and in-flight work and cannot be undone', async () => {
  const { desktop, phone } = await handshake();
  const pending = phone.encrypt({ shouldNotReturn: true });
  phone.destroy();
  await assert.rejects(pending, { code: 'SESSION_CLOSED' });
  phone.destroy();
  desktop.destroy();
  await assert.rejects(desktop.acceptHello({}), { code: 'SESSION_CLOSED' });
  assert.equal(phone.ready, false);
});

test('destroy during actual asynchronous derivation, encryption, or decryption cannot publish success', async (t) => {
  for (const method of ['deriveKey', 'encrypt', 'decrypt']) await t.test(method, async () => {
    let gateEnabled = false;
    let markStarted;
    let release;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const subtle = new Proxy(webcrypto.subtle, {
      get(target, key) {
        const native = target[key].bind(target);
        return async (...args) => {
          const result = await native(...args);
          if (gateEnabled && key === method) { markStarted(); await gate; }
          return result;
        };
      },
    });
    const sandbox = vm.createContext({
      crypto: { subtle, getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
      TextEncoder, TextDecoder, btoa, atob,
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/remoteCompanionCrypto.cjs'), 'utf8'), sandbox);
    const secret = crypto.createPairingSecret();
    let desktop;
    let phone;
    let pending;
    if (method === 'deriveKey') {
      desktop = await crypto.createSession({ role: 'desktop', secret });
      phone = await sandbox.VelornRemoteCrypto.createSession({ role: 'phone', secret });
      gateEnabled = true;
      pending = phone.acceptHello(desktop.hello());
    } else {
      ({ desktop, phone } = await handshake(secret, sandbox.VelornRemoteCrypto));
      gateEnabled = true;
      pending = method === 'encrypt' ? phone.encrypt({ pending: true })
        : phone.decrypt(await desktop.encrypt({ pending: true }));
    }
    await started;
    phone.destroy();
    release();
    await assert.rejects(pending, { code: 'SESSION_CLOSED' });
    assert.equal(phone.ready, false);
    await assert.rejects(phone.encrypt('after destroy'), { code: 'SESSION_CLOSED' });
  });
});

test('unsupported/circular local values never produce a frame and terminate the session', async () => {
  const first = await handshake();
  await rejectsClosed(first.phone, first.phone.encrypt(undefined), 'PAYLOAD_TOO_LARGE');
  const second = await handshake();
  const circular = {}; circular.self = circular;
  await assert.rejects(second.phone.encrypt(circular), TypeError);
  assert.equal(second.phone.ready, false);
});
