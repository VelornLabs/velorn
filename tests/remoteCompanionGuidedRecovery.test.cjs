'use strict';

// Real per-device loopback HTTP listeners and private device stores; account
// control and relay peer are synthetic. No external service or model is called.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createGuidedCompanion, privateWrite, privateRead } = require('../electron/remoteCompanionGuided.cjs');
const { createRemoteCompanionServer } = require('../electron/remoteCompanionDesktop.cjs');
const { createMobileCompanionServer, LIMITS } = require('../electron/mobileCompanionServer.cjs');
const { createDeviceStore } = require('../electron/mobileCompanionDevice.cjs');
const { createPairingSecret } = require('../electron/remoteCompanionCrypto.cjs');

const opaque = name => name.padEnd(32, 'x');
async function until(predicate) {
  const began = Date.now();
  while (!predicate()) {
    if (Date.now() - began > 3000) throw Error('Synthetic recovery condition timed out.');
    await delay(5);
  }
}
function request(url, token, route = '/api/state', value = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(`${url}${route}`, { method: 'POST', agent: false,
      headers: { Origin: url, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outgoing.on('error', reject); outgoing.end(JSON.stringify(value));
  });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-guided-recovery-'));
  const origin = 'https://synthetic.invalid', scope = opaque('scope'), deviceId = opaque('device');
  const nativeToken = 'b'.repeat(64), statePath = path.join(root, 'guided.json');
  const devicesRoot = path.join(root, 'devices'), devicePath = path.join(devicesRoot, deviceId, 'device.json');
  const record = { id: deviceId, requestId: opaque('request'), name: 'Synthetic phone', status: 'active',
    phoneToken: opaque('phone-token'), nativeToken,
    config: { version: 1, url: `${origin.replace('https:', 'wss:')}/relay`, roomId: opaque('room'),
      token: opaque('desktop-token'), secret: createPairingSecret() } };
  const saved = { version: 1, origin, enabled: true, setup: null, account: { displayName: 'Synthetic owner' },
    computer: { id: opaque('computer'), token: opaque('computer-token'), name: 'Synthetic computer' },
    automaticAccountAccess: false, devices: [record] };
  await privateWrite(statePath, saved);
  await createDeviceStore(devicePath).write({ digest: createHash('sha256').update(nativeToken).digest('hex') });
  const originalStore = await fs.readFile(devicePath), originalState = await fs.readFile(statePath);
  const snapshot = { protocol: 3, contextId: opaque('context'), available: true, busy: false,
    provider: 'codex', messages: [], shareReviewMedia: false };
  let clock = 100000, authorized = true, current = true, minted = 0;
  const children = [], calls = [], commands = [], revoked = [];
  const hub = createGuidedCompanion({ apiOnly: true,
    onMessage: () => assert.fail('Legacy text must not be dispatched'),
    onCommand: command => { commands.push(command); return { success: true, status: 'accepted' }; },
    onDeviceRevoked: reason => revoked.push(reason),
  }, { origin, statePath, devicesRoot, pollMs: 1000000, now: () => clock,
    request: async input => {
      assert.equal(input.url.origin, origin);
      calls.push(input.url.pathname);
      if (input.url.pathname.endsWith('/status')) return { computer: saved.computer,
        devices: authorized ? [{ id: record.id, name: record.name, roomId: record.config.roomId }] : [], requests: [] };
      if (input.url.pathname.endsWith('/presence')) return { success: true };
      if (input.url.pathname.endsWith('/disconnect')) { authorized = false; return { success: true }; }
      assert.fail('Unexpected synthetic control operation');
    },
    adapterFactory: (options, config) => {
      const child = {};
      child.adapter = createRemoteCompanionServer(options, { ...config,
        localFactory: localOptions => {
          child.local = createMobileCompanionServer({ ...localOptions, now: () => clock });
          return child.local;
        },
        peerFactory: callbacks => ({ start() { callbacks.onReady(); }, close() { callbacks.onClose({ reason: 'closed' }); } }),
      });
      const pair = child.adapter.pairApprovedDevice;
      child.adapter.pairApprovedDevice = (...args) => { minted++; return pair(...args); };
      children.push(child); return child.adapter;
    },
  });
  t.after(async () => { await hub.stop('synthetic-test-finished'); await fs.rm(root, { recursive: true, force: true }); });
  hub.setGuidedContext({ isCurrent: () => current, confirm: () => assert.fail('Remembered recovery must not enroll again') });
  await hub.startGuided(scope, snapshot); await hub.checkGuided();
  await until(() => children.length === 1 && children[0].adapter.getStatus().enabled);
  return { hub, scope, snapshot, nativeToken, statePath, devicePath, originalStore, originalState, children, calls, commands, revoked,
    get minted() { return minted; },
    current(value) { current = value; }, authorize(value) { authorized = value; },
    fresh() { return hub.publish(scope, snapshot, { rendererPublication: true }); },
    expire() { clock += LIMITS.heartbeatMs + 1; return children.at(-1).local.publish(scope, snapshot); },
  };
}

test('guided recovery replaces an expired real listener only after fresh publication and authority, retaining its bearer', async t => {
  const f = await fixture(t), original = f.children[0].adapter.getStatus();
  assert.equal((await request(original.localUrl, f.nativeToken)).status, 200);
  assert.equal((await request(original.localUrl, f.nativeToken, '/api/command', {
    id: opaque('held-command'), contextId: f.snapshot.contextId, kind: 'message', text: 'Synthetic fixture only; no model is called.',
  })).status, 202);
  await until(() => f.commands.length === 1);
  assert.equal(f.commands[0].signal.aborted, false);
  assert.equal(f.expire(), false);
  await until(() => f.commands[0].signal.aborted);
  assert.deepEqual(f.revoked, ['phone-connection-lost']);
  await assert.rejects(request(original.localUrl, f.nativeToken));
  await f.hub.checkGuided();
  assert.equal(f.children.length, 1, 'Directory alone cannot restore a stale renderer');
  f.hub.publish(f.scope, f.snapshot); await f.hub.checkGuided();
  assert.equal(f.children.length, 1, 'Cached native publication does not renew renderer authority');
  assert.equal(f.fresh(), true); await f.hub.checkGuided();
  await until(() => f.children.length === 2 && f.children[1].adapter.getStatus().enabled);
  const restored = f.children[1].adapter.getStatus();
  assert.equal(restored.paired, true); assert.equal(restored.pairingCode, null);
  assert.equal((await request(restored.localUrl, f.nativeToken)).status, 200);
  assert.equal((await request(restored.localUrl, 'c'.repeat(64))).status, 401);
  assert.equal(f.children[0].adapter.getStatus().enabled, false);
  assert.deepEqual(f.revoked, ['phone-connection-lost'], 'Recovery cleanup must not repeatedly revoke native grants');
  assert.deepEqual(await fs.readFile(f.devicePath), f.originalStore);
  assert.deepEqual(await fs.readFile(f.statePath), f.originalState);
  assert.equal(f.minted, 0);
  assert.equal(f.commands.length, 1, 'Recovery must not replay an accepted command');
  assert.equal(f.hub.resolveCommand(f.scope, f.commands[0].id, { success: true, status: 'completed' }), false);
});

test('a revoked saved device is never recreated by the fresh-publication recovery path', async t => {
  const f = await fixture(t), original = f.children[0].adapter.getStatus();
  f.expire(); f.authorize(false); f.fresh(); await f.hub.checkGuided();
  assert.equal(f.children.length, 1); assert.equal(f.children[0].adapter.getStatus().enabled, false);
  assert.equal(f.hub.getStatus().guided.devices.length, 0);
  assert.equal((await privateRead(f.statePath)).devices.length, 0);
  await assert.rejects(request(original.localUrl, f.nativeToken));
  assert.equal(f.minted, 0); assert.equal(f.commands.length, 0);
});

test('real HTTP unpair removes the device store and is not treated as a recoverable stop', async t => {
  const f = await fixture(t), original = f.children[0].adapter.getStatus();
  const response = await request(original.localUrl, f.nativeToken, '/api/unpair');
  assert.equal(response.status, 200);
  await until(() => !f.children[0].adapter.getStatus().enabled);
  f.fresh(); await f.hub.checkGuided();
  assert.equal(f.children.length, 1); assert.equal(f.hub.getStatus().guided.devices.length, 0);
  await assert.rejects(fs.stat(f.devicePath), { code: 'ENOENT' });
  await assert.rejects(request(original.localUrl, f.nativeToken));
  assert.equal(f.minted, 0); assert.equal(f.commands.length, 0);
});

test('missing remembered-device storage fails closed during recovery without minting replacement authority', async t => {
  const f = await fixture(t);
  f.expire(); await createDeviceStore(f.devicePath).forget(); f.fresh(); await f.hub.checkGuided();
  assert.equal(f.children.length, 2); assert.equal(f.children[1].adapter.getStatus().enabled, false);
  assert.equal(f.hub.getStatus().paired, false);
  await f.hub.checkGuided(); assert.equal(f.children.length, 2, 'No fresh heartbeat means no repeated recovery start');
  await assert.rejects(fs.stat(f.devicePath), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(f.statePath), f.originalState);
  assert.equal(f.minted, 0); assert.equal(f.commands.length, 0);
});
