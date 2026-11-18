'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createGuidedCompanion, privateRead, privateWrite, serviceOrigin, validState } = require('../electron/remoteCompanionGuided.cjs');
const { registerMobileCompanionIpc, CHANNELS } = require('../electron/mobileCompanion.cjs');
const handoff = require('../electron/remoteCompanionHandoff.cjs');
const opaque = n => String(n).padStart(32, 'x');
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-guided-native-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const opens = [], calls = [], adapters = [], dialogs = [], events = [], commands = [], revocations = [];
  let setup, approved = false, registered = false, current = true;
  const requests = [], devices = [];
  let requestHook = null, confirmHook = null, adapterStartHook = null, adapterStopHook = null;
  const rememberedDevices = new Set();
  const request = async input => {
    calls.push(structuredClone({ route: input.url.pathname, body: input.body, token: input.token }));
    if (requestHook) { const answer = await requestHook(input); if (answer) return answer; }
    const body = input.body;
    switch (input.url.pathname) {
      case '/account/setup/start': setup = body; return { setupId: setup.setupId, expiresAt: Date.now() + 600000, verificationUrl: 'https://attacker.invalid/' };
      case '/account/setup/status': return { status: registered ? 'complete' : approved ? 'approved' : 'pending', accountDisplayName: 'Test account', expiresAt: Date.now() + 600000, computerId: setup.setupId };
      case '/account/setup/finish': registered = body.approved; return { status: registered ? 'complete' : 'rejected', computerId: registered ? setup.setupId : undefined };
      case '/account/desktop/guided/status': return { computer: { id: setup.setupId, name: setup.name }, requests: structuredClone(requests), devices: structuredClone(devices) };
      case '/account/desktop/guided/presence': return { success: true };
      case '/account/desktop/guided/decision': {
        const i = requests.findIndex(item => item.requestId === body.requestId), item = requests[i];
        if (body.approved) devices.push({ id: body.device.id, roomId: body.device.roomId, name: item.name });
        requests.splice(i, 1); return { success: true, status: body.approved ? 'approved' : 'rejected' };
      }
      case '/account/desktop/guided/disconnect': devices.splice(devices.findIndex(item => item.id === body.deviceId), 1); return { success: true };
      case '/account/desktop/guided/unregister': devices.length = 0; registered = false; return { success: true };
      default: throw Error('Unexpected fixture request');
    }
  };
  const adapterFactory = (options, config) => {
    let enabled = false, paired = false, context, reason = null;
    const adapter = { options, config, resolutions: [], stops: [], starts: 0, mints: 0,
      getStatus: () => ({ enabled, paired, reason, remote: { connected: enabled }, urls: [] }),
      hasRemoteConfiguration: async () => false,
      async start(scope) { adapter.starts++; context = scope; reason = null; enabled = true; paired = rememberedDevices.has(config.configPath); options.onStatus?.(adapter.getStatus()); await adapterStartHook?.(adapter); },
      async stop(nextReason) { reason = nextReason; adapter.stops.push(reason); enabled = false; paired = false; options.onStatus?.(adapter.getStatus()); await adapterStopHook?.(adapter, reason); },
      async pairApprovedDevice({ isCurrent }) { assert.equal(isCurrent(), true); adapter.mints++; paired = true; rememberedDevices.add(config.configPath); return 'a'.repeat(64); },
      publish(scope, value) { if (!enabled) return false; assert.equal(scope, context); adapter.published = value; return true; },
      resolveCommand(scope, id, result) { adapter.resolutions.push({ scope, id, result }); return enabled; },
    };
    adapters.push(adapter); return adapter;
  };
  const config = { statePath: path.join(root, 'state.json'), devicesRoot: path.join(root, 'devices'), configPath: path.join(root, 'legacy.json'),
    openBrowser: async url => opens.push(url), request, adapterFactory, pollMs: 1000000, ...overrides };
  const nativeOptions = { clientRoot: '/synthetic/client', onStatus: value => events.push(value),
    onDeviceRevoked: reason => revocations.push(reason),
    onMessage: () => { throw Error('Protocol3 command reached legacy text callback'); },
    onCommand: async value => { commands.push(value); return { success: true, status: 'accepted' }; } };
  const hub = createGuidedCompanion(nativeOptions, config);
  hub.setGuidedContext({ isCurrent: () => current, confirm: async details => { dialogs.push(details); return confirmHook ? confirmHook(details) : true; } });
  t.after(() => hub.stop('test-finished'));
  const scope = opaque('scope'), snapshot = { protocol: 3, contextId: opaque('context'), available: true, messages: [] };
  await hub.startGuided(scope, snapshot);
  const link = async options => { await hub.beginGuidedSetup('Studio', options); approved = true; await hub.checkGuided(); };
  const addPhone = async (n = 1, extra = {}) => {
    const key = await handoff.createRequestKey();
    const record = { requestId: opaque(n), name: `Phone ${n}`, accountDisplayName: 'Test account', expiresAt: Date.now() + 600000, publicKey: key.publicKey, ...extra };
    requests.push(record); await hub.checkGuided(); return { key, record };
  };
  return { hub, link, addPhone, calls, opens, dialogs, adapters, devices, requests, events, commands, revocations, root, scope, snapshot, config, nativeOptions,
    rememberedDevices, adapterStartHook(fn) { adapterStartHook = fn; }, adapterStopHook(fn) { adapterStopHook = fn; },
    current(value) { current = value; }, requestHook(fn) { requestHook = fn; }, confirmHook(fn) { confirmHook = fn; }, approveSetup(value = true) { approved = value; } };
}
test('private native engine uses the same revocable account lease without changing saved accounts', async t => {
  const f = await fixture(t); await f.link();
  const before = await privateRead(f.config.statePath);
  const lease = await f.hub.fundedLuna.beginTurn();
  const authority = lease.nativeEngineAuthority();
  assert.equal(authority.computerId, before.computer.id);
  assert.equal(authority.token, before.computer.token);
  assert.equal(authority.baseUrl, 'https://connect.velorn.ai/account/desktop/luna/native-test/v1');
  assert.match(authority.accountScope, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(f.hub.getStatus()).includes(authority.token), false);
  assert.deepEqual(await privateRead(f.config.statePath), before);
  assert.equal((await f.hub.fundedLuna.beginTurn()).nativeEngineAuthority().accountScope, authority.accountScope);
  await f.hub.unregisterGuided({ isCurrent: () => true });
  assert.equal(lease.signal.aborted, true);
  assert.throws(() => lease.nativeEngineAuthority());
});
test('registration persists native control before browser open and exposes metadata only', async t => {
  const f = await fixture(t);
  await f.link();
  const saved = await privateRead(path.join(f.root, 'state.json'));
  assert.equal(saved.computer.id.length, 43);
  assert.equal(f.calls[0].token, undefined);
  assert.equal(f.calls[0].body.controlTokenHash, createHash('sha256').update(saved.computer.token).digest('hex'));
  assert.equal(f.opens[0], `https://connect.velorn.ai/account#desktop=${saved.computer.id}`);
  assert.equal(JSON.stringify(f.hub.getStatus()).includes(saved.computer.token), false);
  assert.equal(f.hub.getStatus().guided.registered, true);
  assert.equal(f.dialogs[0].kind, 'account');
  assert.equal((await fs.stat(path.join(f.root, 'state.json'))).mode & 0o777, 0o600);
});

test('computer label migrates without restoring account authority and survives sign-out/restart/rename', async t => {
  const f = await fixture(t); await f.link();
  const linked = await privateRead(f.config.statePath);
  delete linked.computerName;
  const migrated = validState(structuredClone(linked), linked.origin, false);
  assert.equal(migrated.computerName, 'Studio');
  assert.deepEqual(migrated.computer, linked.computer);
  assert.deepEqual(migrated.devices, linked.devices);
  for (const paused of [false, true]) {
    if (paused) await f.hub.stop();
    await f.hub.unregisterGuided({ isCurrent: () => true });
    const signedOut = await privateRead(f.config.statePath);
    assert.equal(signedOut.computerName, paused ? 'Renamed studio' : 'Studio');
    assert.equal(signedOut.computer, null); assert.equal(signedOut.account, null);
    assert.equal(signedOut.setup, null); assert.deepEqual(signedOut.devices, []);
    const restored = createGuidedCompanion(f.nativeOptions, f.config);
    try {
      await restored.getGuidedPreference();
      assert.equal(restored.getStatus().guided.computerName, signedOut.computerName);
      assert.equal(restored.getStatus().guided.registered, false);
      assert.equal(restored.getStatus().enabled, false);
    } finally { await restored.stop(); }
    if (!paused) {
      f.approveSetup(false);
      await f.hub.beginGuidedSetup('Renamed studio');
      assert.equal((await privateRead(f.config.statePath)).computerName, 'Renamed studio');
      f.approveSetup(true); await f.hub.checkGuided();
    }
  }
  const blank = { version: 1, origin: linked.origin, enabled: false, devices: [], computer: null, setup: null, account: null };
  for (const computerName of [undefined, '', 'x'.repeat(81), 'unsafe\nname', { token: 'not-a-name' }]) {
    const safe = validState({ ...blank, computerName }, linked.origin, false);
    assert.equal(safe.computerName, 'My computer');
    assert.equal(safe.computer, null);
  }
});

test('authenticated profile refresh hydrates old identity without changing account, devices or grants', async t => {
  const f = await fixture(t); await f.link(); await f.addPhone();
  const before = await privateRead(f.config.statePath), calls = f.calls.length, dialogs = f.dialogs.length;
  let account = { displayName: 'Verified Creator', email: 'creator@example.test', emailVerified: true };
  f.requestHook(input => input.url.pathname === '/account/desktop/guided/status' ? {
    computer: { id: before.computer.id, name: before.computer.name }, devices: structuredClone(f.devices), requests: [], account,
  } : null);
  await f.hub.checkGuided();
  assert.deepEqual(f.hub.getStatus().guided.account, account);
  const after = await privateRead(f.config.statePath);
  assert.deepEqual(after.computer, before.computer);
  assert.deepEqual(after.devices, before.devices);
  assert.equal(after.automaticAccountAccess, before.automaticAccountAccess);
  assert.equal(f.dialogs.length, dialogs);
  assert.ok(f.calls.slice(calls).every(call => ['/account/desktop/guided/status', '/account/desktop/guided/presence'].includes(call.route)));
  for (const invalid of [undefined, null, { displayName: 'Attacker', email: 'other@example.test' }, { displayName: 'Attacker', email: 'other@example.test', emailVerified: true, token: 'secret' }, { displayName: 'Attacker', email: 'x\u202e@example.test', emailVerified: true }]) {
    account = invalid; await f.hub.checkGuided();
    assert.deepEqual(f.hub.getStatus().guided.account, after.account);
  }
  account = { displayName: 'Verified Creator' }; await f.hub.checkGuided();
  assert.deepEqual(f.hub.getStatus().guided.account, after.account, 'Name-only session does not erase verified email');
  await f.hub.stop();
  const restored = createGuidedCompanion(f.nativeOptions, f.config); t.after(() => restored.stop());
  await restored.getGuidedPreference();
  assert.deepEqual(restored.getStatus().guided.account, after.account);
});
test('sixteen approved devices survive desktop refresh and restart without replacing original credentials', async t => {
  const f = await fixture(t); await f.link();
  for (let i = 1; i <= 8; i++) await f.addPhone(i);
  const original = (await privateRead(path.join(f.root, 'state.json'))).devices;
  for (let i = 9; i <= 16; i++) await f.addPhone(i);
  await f.hub.checkGuided();
  const full = await privateRead(path.join(f.root, 'state.json'));
  assert.equal(full.devices.length, 16); assert.deepEqual(full.devices.slice(0, 8), original);
  assert.equal(f.hub.getStatus().guided.devices.length, 16);
  assert.ok(f.adapters.every(adapter => adapter.stops.length === 0));
  await f.hub.stop('test-restart');
  const replacement = createGuidedCompanion(f.nativeOptions, f.config);
  t.after(() => replacement.stop('test-finished'));
  replacement.setGuidedContext({ isCurrent: () => true, confirm: async () => { throw Error('Restart must not request new approval'); } });
  await replacement.startGuided(f.scope, f.snapshot); await replacement.checkGuided();
  assert.equal(replacement.getStatus().guided.devices.length, 16);
  assert.deepEqual((await privateRead(path.join(f.root, 'state.json'))).devices, full.devices);
  assert.equal(f.calls.filter(call => call.route.endsWith('/disconnect')).length, 0);
});

test('funded Luna transport uses the native computer credential and fences stopped/revoked work', async t => {
  const calls = []; let finish;
  const f = await fixture(t, { lunaRequest: input => {
    calls.push(input);
    if (input.url.pathname.endsWith('/status')) return Promise.resolve({ ok: true, available: true });
    return new Promise(resolve => { finish = resolve; });
  } });
  await assert.rejects(f.hub.fundedLuna.status());
  assert.equal(calls.length, 0);
  await f.link();
  await f.hub.fundedLuna.status();
  const saved = await privateRead(f.config.statePath);
  assert.equal(calls[0].token, saved.computer.token);
  assert.deepEqual(calls[0].body, { computerId: saved.computer.id });
  const pending = f.hub.fundedLuna.respond({ computerId: 'forged', requestId: 'synthetic', input: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[1].body.computerId, saved.computer.id);
  await f.hub.stop();
  assert.equal(calls[1].signal.aborted, true);
  finish({ ok: true, output: [] });
  await assert.rejects(pending);
  await assert.rejects(f.hub.fundedLuna.status());
  assert.equal(calls.length, 2);
});
test('a captured funded turn cannot resume after stop/start even for the same saved computer', async t => {
  let calls = 0;
  const f = await fixture(t, { lunaRequest: async () => { calls++; return { ok: true, available: true }; } });
  await f.link();
  const lease = await f.hub.fundedLuna.beginTurn();
  lease.assertCurrent(); await lease.status(); assert.equal(calls, 1);
  await f.hub.stop();
  assert.equal(lease.signal.aborted, true);
  await f.hub.startGuided(f.scope, f.snapshot);
  assert.throws(() => lease.assertCurrent());
  await assert.rejects(lease.respond({ requestId: 'old-turn' }));
  assert.equal(calls, 1);
  const replacement = await f.hub.fundedLuna.beginTurn();
  replacement.assertCurrent(); await replacement.status(); assert.equal(calls, 2);
});

test('application account signs in without a project or phone opt-in and Velo survives phone pause', async t => {
  const inference = [];
  const f = await fixture(t, { lunaRequest: async input => { inference.push(input); return { ok: true, available: true }; } });
  await f.hub.stop('no-project');
  let owner = true;
  const context = { isCurrent: () => owner, confirm: async detail => { f.dialogs.push(detail); return true; } };
  await f.hub.setAccountContext(context);
  t.after(() => f.hub.setAccountContext(null));
  await f.hub.beginGuidedSetup('Account-only desktop', { accountOnly: true, reauthenticate: true });
  f.approveSetup();
  for (let n = 0; n < 30 && !f.hub.getStatus().guided.registered; n++) { await f.hub.checkGuided(true); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(f.hub.getStatus().guided.registered, true);
  assert.equal(f.hub.getStatus().guided.enabled, false);
  assert.equal(f.hub.getStatus().enabled, false);
  assert.equal(f.dialogs[0].phoneAccess, false);
  assert.equal(f.calls.some(call => call.route.endsWith('/presence') || call.route.endsWith('/decision')), false);
  assert.equal(f.adapters.some(adapter => adapter.starts), false);
  const lease = await f.hub.fundedLuna.beginTurn(); await lease.status();
  assert.equal(inference.length, 1);
  await f.hub.setGuidedPreference(false); await f.hub.stop('desktop-disabled');
  lease.assertCurrent(); assert.equal(lease.signal.aborted, false); await lease.status();
  // Re-reading the same account context must not revoke an in-flight lease.
  await f.hub.setAccountContext(context); lease.assertCurrent();
  owner = false;
  assert.throws(() => lease.assertCurrent());
  await f.hub.setAccountContext(null); assert.equal(lease.signal.aborted, true);
  await assert.rejects(f.hub.fundedLuna.beginTurn());
});

test('independent account pause preserves devices; explicit sign-out and revocation still abort Velo', async t => {
  for (const action of ['sign-out', 'revoked']) {
    const f = await fixture(t, { lunaRequest: async () => ({ ok: true, available: true }) });
    await f.link({ automatic: true }); await f.addPhone();
    const before = await privateRead(f.config.statePath);
    const context = { isCurrent: () => true, confirm: async () => true };
    await f.hub.setAccountContext(context); t.after(() => f.hub.setAccountContext(null));
    const lease = await f.hub.fundedLuna.beginTurn();
    await f.hub.setGuidedPreference(false); await f.hub.stop('desktop-disabled');
    lease.assertCurrent(); await lease.status();
    const paused = await privateRead(f.config.statePath);
    assert.deepEqual(paused.computer, before.computer); assert.deepEqual(paused.devices, before.devices);
    assert.equal(f.devices.length, 1);
    if (action === 'sign-out') {
      await f.hub.unregisterGuided({ accountOnly: true });
      assert.equal(f.hub.getStatus().guided.registered, false);
    } else {
      f.requestHook(input => { if (input.url.pathname.endsWith('/guided/status')) throw Object.assign(Error('revoked'), { status: 403 }); });
      for (let n = 0; n < 30 && !lease.signal.aborted; n++) { await f.hub.checkGuided(true); await new Promise(resolve => setImmediate(resolve)); }
    }
    assert.equal(lease.signal.aborted, true); assert.throws(() => lease.assertCurrent());
    await assert.rejects(lease.respond({ requestId: 'must-not-send' }));
  }
});

test('late account directory response cannot restore identity or devices after project-free sign-out', async t => {
  const f = await fixture(t, { lunaRequest: async () => ({ ok: true, available: true }) });
  await f.link(); await f.addPhone();
  await f.hub.setGuidedPreference(false); await f.hub.stop('desktop-disabled');
  await f.hub.setAccountContext({ isCurrent: () => true, confirm: async () => true });
  t.after(() => f.hub.setAccountContext(null));
  const saved = await privateRead(f.config.statePath);
  let release, started; const began = new Promise(resolve => { started = resolve; });
  f.requestHook(input => {
    if (input.url.pathname.endsWith('/guided/status') && !release) return new Promise(resolve => { release = resolve; started(); });
  });
  const polling = f.hub.checkGuided(true); await began;
  await f.hub.unregisterGuided({ accountOnly: true });
  release({ computer: { id: saved.computer.id, name: saved.computer.name }, devices: saved.devices.map(d => ({id:d.id,name:d.name,roomId:d.config.roomId})), requests: [], account: {displayName:'Old identity'} });
  await polling; await new Promise(resolve => setImmediate(resolve));
  const after = await privateRead(f.config.statePath);
  assert.equal(after.computer, null); assert.equal(after.account, null); assert.deepEqual(after.devices, []);
  assert.equal(f.hub.getStatus().guided.registered, false);
});
test('account control loss and disabled preference abort funded leases before late tool approval', async t => {
  for (const reason of ['account-lost', 'disabled']) {
    const f = await fixture(t, { lunaRequest: async () => ({ ok: true, available: true }) });
    await f.link();
    const lease = await f.hub.fundedLuna.beginTurn();
    if (reason === 'disabled') await f.hub.setGuidedPreference(false);
    else {
      f.requestHook(input => {
        if (input.url.pathname === '/account/desktop/guided/status') throw Object.assign(Error('Synthetic revocation'), { status: 403 });
      });
      await f.hub.checkGuided();
      assert.equal(f.hub.getStatus().guided.phase, 'account-unavailable');
    }
    assert.equal(lease.signal.aborted, true);
    assert.throws(() => lease.assertCurrent());
    await assert.rejects(lease.respond({ requestId: 'late' }));
  }
});
test('verified account display name appears only after consent/completion and survives pause and restart', async t => {
  const f = await fixture(t);
  assert.equal(f.hub.getStatus().guided.account, null);
  f.confirmHook(() => { assert.equal(f.hub.getStatus().guided.account, null); return true; });
  f.requestHook(input => input.url.pathname === '/account/setup/status'
    ? { status: 'approved', accountDisplayName: '  Synthetic Owner  ', email: 'private@example.test', avatar: 'https://private.example/avatar', token: 'private-token', expiresAt: Date.now() + 600000 } : null);
  await f.link();
  assert.deepEqual(f.hub.getStatus().guided.account, { displayName: 'Synthetic Owner' });
  const saved = await privateRead(f.config.statePath);
  assert.deepEqual(saved.account, { displayName: 'Synthetic Owner' });
  assert.equal(saved.setup, null);
  assert.doesNotMatch(JSON.stringify(f.hub.getStatus()), /private@example|private\.example|private-token/);
  await f.hub.stop(); await f.hub.setGuidedPreference(false);
  const replacement = createGuidedCompanion(f.nativeOptions, f.config); t.after(() => replacement.stop());
  assert.equal(await replacement.getGuidedPreference(), false);
  assert.deepEqual(replacement.getStatus().guided.account, { displayName: 'Synthetic Owner' });
  assert.equal(replacement.getStatus().guided.registered, true);
});
test('declined or rejected setup never exposes or persists an account identity', async t => {
  const f = await fixture(t); f.confirmHook(() => false);
  await f.link();
  assert.equal(f.hub.getStatus().guided.account, null);
  assert.equal((await privateRead(f.config.statePath)).account, null);
  assert.equal(f.hub.getStatus().guided.registered, false);
  await f.hub.beginGuidedSetup('Studio');
  f.requestHook(input => input.url.pathname === '/account/setup/status'
    ? { status: 'rejected', accountDisplayName: 'Do not show', expiresAt: Date.now() + 600000 } : null);
  await f.hub.checkGuided();
  assert.equal(f.hub.getStatus().guided.account, null);
  assert.equal((await privateRead(f.config.statePath)).setup, null);
});
test('malformed display names cannot grant setup or leak arbitrary identity fields', async t => {
  for (const accountDisplayName of [undefined, null, {}, [], '', ' '.repeat(4), 'x'.repeat(121), 'bad\nname', '\u202eOwner']) {
    const f = await fixture(t);
    f.requestHook(input => input.url.pathname === '/account/setup/status'
      ? { status: 'approved', accountDisplayName, expiresAt: Date.now() + 600000, email: 'hidden@example.test' } : null);
    await f.link();
    assert.equal(f.hub.getStatus().guided.account, null);
    assert.equal(f.hub.getStatus().guided.registered, false);
    assert.equal(f.dialogs.length, 0);
    assert.equal(f.calls.some(call => call.route.endsWith('/finish')), false);
    assert.doesNotMatch(JSON.stringify(f.hub.getStatus()), /hidden@example/);
  }
});
test('legacy and malformed optional saved identity remain usable but render no fabricated profile', async t => {
  const f = await fixture(t); await f.link(); await f.hub.stop();
  const saved = await privateRead(f.config.statePath);
  for (const account of [undefined, { displayName: 'Synthetic Owner', email: 'hidden@example.test' }, { displayName: 'x'.repeat(121) }, 'Synthetic Owner']) {
    const state = structuredClone(saved);
    if (account === undefined) delete state.account; else state.account = account;
    await privateWrite(f.config.statePath, state);
    const replacement = createGuidedCompanion(f.nativeOptions, f.config); t.after(() => replacement.stop());
    assert.equal(await replacement.getGuidedPreference(), true);
    assert.equal(replacement.getStatus().guided.registered, true);
    assert.equal(replacement.getStatus().guided.account, null);
  }
});
test('lost finish receipt recovers only the account identity that native consent recorded', async t => {
  const f = await fixture(t); let complete = false;
  f.requestHook(input => {
    if (input.url.pathname === '/account/setup/status') return complete
      ? { status: 'complete', computerId: input.body.setupId, accountDisplayName: 'Not trusted recovery data' }
      : { status: 'approved', accountDisplayName: 'Approved Owner', expiresAt: Date.now() + 600000 };
    if (input.url.pathname === '/account/setup/finish') { complete = true; throw Error('Synthetic lost response'); }
  });
  await f.link();
  assert.equal(f.hub.getStatus().guided.account, null);
  assert.deepEqual((await privateRead(f.config.statePath)).setup.confirmedAccount, { displayName: 'Approved Owner' });
  await f.hub.stop();
  const replacement = createGuidedCompanion(f.nativeOptions, f.config); t.after(() => replacement.stop());
  replacement.setGuidedContext({ isCurrent: () => true, confirm: () => assert.fail('Previously confirmed completion does not prompt again') });
  await replacement.startGuided(f.scope, f.snapshot); await replacement.checkGuided();
  assert.deepEqual(replacement.getStatus().guided.account, { displayName: 'Approved Owner' });
  assert.equal(f.calls.filter(call => call.route.endsWith('/finish')).length, 1);
});
test('changed identity during pending setup does not inherit a previous native confirmation', async t => {
  const f = await fixture(t); let name = 'First Owner';
  f.requestHook(input => {
    if (input.url.pathname === '/account/setup/status') return { status: 'approved', accountDisplayName: name, expiresAt: Date.now() + 600000 };
    if (input.url.pathname === '/account/setup/finish') throw Error('Synthetic unconfirmed finish');
  });
  await f.link();
  assert.equal(f.dialogs.length, 1);
  name = 'Second Owner'; f.confirmHook(() => false); await f.hub.checkGuided();
  assert.equal(f.dialogs.length, 2);
  assert.equal(f.dialogs[1].accountDisplayName, 'Second Owner');
  const pending = await privateRead(f.config.statePath);
  assert.equal(pending.setup.confirmed, false);
  assert.equal(pending.setup.confirmedAccount, null);
  assert.equal(pending.account, null);
});
test('unregister removes displayed identity immediately even when the service is unavailable', async t => {
  const f = await fixture(t); await f.link();
  f.requestHook(input => { if (input.url.pathname.endsWith('/unregister')) throw Error('Synthetic offline'); });
  await assert.rejects(f.hub.unregisterGuided());
  assert.equal(f.hub.getStatus().guided.account, null);
  const pending = await privateRead(f.config.statePath);
  assert.equal(pending.account, null);
  assert.ok(pending.computer, 'Recovery authority is retained independently of identity display');
  f.requestHook(null); await f.hub.checkGuided();
  assert.equal(f.hub.getStatus().guided.registered, false);
  assert.equal(f.hub.getStatus().guided.account, null);
});
test('paused native account removal sends only unregister and never resumes device transports', async t => {
  const f = await fixture(t); await f.link(); await f.addPhone();
  await f.hub.stop('desktop-disabled'); await f.hub.setGuidedPreference(false);
  const callCount = f.calls.length, adapterCount = f.adapters.length;
  await f.hub.unregisterGuided({ isCurrent: () => true });
  assert.deepEqual(f.calls.slice(callCount).map(call => call.route), ['/account/desktop/guided/unregister']);
  assert.equal(f.adapters.length, adapterCount);
  assert.ok(f.adapters.every(adapter => !adapter.getStatus().enabled));
  assert.equal(f.hub.getStatus().enabled, false);
  assert.equal(f.hub.getStatus().guided.registered, false);
  assert.equal(f.hub.getStatus().guided.account, null);
  assert.equal(await f.hub.getGuidedPreference(), false);
});
test('paused removal refuses missing/stale native authority and retains recovery state after network failure', async t => {
  const f = await fixture(t); await f.link(); await f.hub.stop(); await f.hub.setGuidedPreference(false);
  const before = await privateRead(f.config.statePath), callCount = f.calls.length;
  await assert.rejects(f.hub.unregisterGuided());
  await assert.rejects(f.hub.unregisterGuided({ isCurrent: () => false }));
  assert.equal(f.calls.length, callCount);
  assert.deepEqual(await privateRead(f.config.statePath), before);
  f.requestHook(input => { if (input.url.pathname.endsWith('/unregister')) throw Error('Synthetic service unavailable'); });
  await assert.rejects(f.hub.unregisterGuided({ isCurrent: () => true }));
  const pending = await privateRead(f.config.statePath);
  assert.deepEqual(pending.computer, before.computer);
  assert.equal(pending.enabled, false);
  assert.equal(pending.unregisterPending, true);
  assert.equal(pending.account, null);
  assert.equal(f.hub.getStatus().enabled, false);
  f.requestHook(null); await f.hub.unregisterGuided({ isCurrent: () => true });
  assert.equal(f.hub.getStatus().guided.registered, false);
});
test('paused administrative request aborts on native stop and late success cannot replace saved authority', async t => {
  const f = await fixture(t); await f.link(); await f.hub.stop(); await f.hub.setGuidedPreference(false);
  let enter, finish, signal;
  const started = new Promise(resolve => { enter = resolve; });
  f.requestHook(input => {
    if (input.url.pathname.endsWith('/unregister')) {
      signal = input.signal; enter(); return new Promise(resolve => { finish = resolve; });
    }
  });
  const removing = f.hub.unregisterGuided({ isCurrent: () => true }); await started;
  await f.hub.stop('renderer-gone'); assert.equal(signal.aborted, true);
  finish({ success: true }); await assert.rejects(removing);
  const pending = await privateRead(f.config.statePath);
  assert.ok(pending.computer);
  assert.equal(pending.unregisterPending, true);
  assert.equal(pending.enabled, false);
  assert.equal(f.hub.getStatus().enabled, false);
});
test('one native account opt-in approves automatic same-account phones but manual requests still ask', async t => {
  const f = await fixture(t); await f.link({ automatic: true });
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.dialogs[0].kind, 'account'); assert.equal(f.dialogs[0].automatic, true);
  const saved = await privateRead(path.join(f.root, 'state.json'));
  assert.equal(saved.automaticAccountAccess, true);
  assert.deepEqual(f.calls.find(call => call.route.endsWith('/presence')).body,
    { computerId: saved.computer.id, state: 'online', automatic: true });
  const first = await f.addPhone(1, { automatic: true }); await f.addPhone(2, { automatic: true });
  assert.equal(f.hub.getStatus().guided.devices.length, 2); assert.equal(f.dialogs.length, 1);
  const decision = f.calls.find(call => call.route.endsWith('/decision'));
  const payload = await handoff.open({ privateKey: first.key.privateKey, envelope: decision.body.envelope,
    requestId: first.record.requestId, computerId: saved.computer.id });
  assert.equal(payload.nativeToken.length, 64);
  await f.addPhone(3);
  assert.equal(f.dialogs.filter(item => item.kind === 'device').length, 1);
  assert.equal(f.hub.getStatus().guided.devices.length, 3);
});
test('existing registrations require one explicit local automatic grant and do not broaden on restart', async t => {
  const f = await fixture(t); await f.link();
  const original = await privateRead(path.join(f.root, 'state.json'));
  assert.notEqual(original.automaticAccountAccess, true);
  assert.equal(f.calls.find(call => call.route.endsWith('/presence')).body.automatic, false);
  await f.addPhone(1, { automatic: true });
  assert.equal(f.hub.getStatus().guided.devices.length, 0);
  assert.equal(f.dialogs.length, 1, 'an unrequested automatic attempt cannot open a native device dialog');
  f.confirmHook(details => details.kind !== 'automatic');
  await f.hub.beginGuidedSetup('Studio', { automatic: true });
  assert.notEqual((await privateRead(path.join(f.root, 'state.json'))).automaticAccountAccess, true);
  f.confirmHook(() => true);
  await f.hub.beginGuidedSetup('Studio', { automatic: true }); await f.hub.checkGuided();
  const granted = await privateRead(path.join(f.root, 'state.json'));
  assert.equal(granted.automaticAccountAccess, true); assert.deepEqual(granted.computer, original.computer);
  assert.equal(f.dialogs.filter(item => item.kind === 'automatic').length, 2);
  await f.hub.stop();
  const replacement = createGuidedCompanion(f.nativeOptions, f.config); t.after(() => replacement.stop());
  replacement.setGuidedContext({ isCurrent: () => true, confirm: async () => { throw Error('Unexpected new native approval'); } });
  await replacement.startGuided(f.scope, f.snapshot); await replacement.checkGuided();
  await replacement.beginGuidedSetup('Studio', { automatic: true });
  assert.equal(replacement.getStatus().guided.automaticAccountAccess, true);
  assert.equal(replacement.getStatus().guided.devices.length, 1);
});
test('Stop preserves the grant but disables automatic polling and startup until explicit enable', async t => {
  const f = await fixture(t); await f.link({ automatic: true });
  await f.hub.stop('desktop-disabled'); await f.hub.setGuidedPreference(false);
  const count = f.calls.length;
  await f.hub.start(f.scope, f.snapshot); await f.hub.checkGuided();
  assert.equal(f.calls.length, count); assert.equal(f.hub.getStatus().guided.enabled, false);
  assert.equal((await privateRead(path.join(f.root, 'state.json'))).automaticAccountAccess, true);
  await f.hub.beginGuidedSetup('Studio', { automatic: true }); await f.hub.checkGuided();
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.hub.getStatus().guided.enabled, true);
  assert.equal(f.calls.at(-1).body.automatic, true);
});
test('an older relay presence404 keeps registration and manual approval without repeated unsupported calls', async t => {
  const f = await fixture(t);
  f.requestHook(input => { if (input.url.pathname.endsWith('/presence')) throw Object.assign(Error('Old relay'), { status: 404 }); });
  await f.link({ automatic: true });
  await f.addPhone(1); await f.hub.checkGuided();
  assert.equal(f.hub.getStatus().guided.registered, true); assert.equal(f.hub.getStatus().guided.enabled, true);
  assert.equal(f.hub.getStatus().guided.automaticAvailable, false);
  assert.equal(f.hub.getStatus().guided.devices.length, 1);
  assert.equal(f.calls.filter(call => call.route.endsWith('/presence')).length, 1);
  assert.equal(f.dialogs.filter(item => item.kind === 'device').length, 1);
  await f.addPhone(2, { automatic: true });
  assert.equal(f.hub.getStatus().guided.devices.length, 1);
  assert.match(f.hub.getStatus().guided.message, /manual phone approval/);
  f.requestHook(null); await f.hub.startGuided(f.scope, f.snapshot); await f.hub.checkGuided();
  assert.equal(f.hub.getStatus().guided.automaticAvailable, true);
  assert.equal(f.hub.getStatus().guided.devices.length, 2);
});
test('Stop during encrypted automatic handoff cannot submit the new phone', async t => {
  let entered, release;
  const sealing = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { handoff: () => ({ ...handoff, async seal(input) {
    await new Promise(resolve => { release = resolve; entered(); }); return handoff.seal(input);
  } }) });
  await f.link({ automatic: true });
  const pending = f.addPhone(1, { automatic: true }); await sealing;
  await f.hub.stop('desktop-disabled'); await f.hub.setGuidedPreference(false); release(); await pending;
  assert.equal(f.calls.some(call => call.route.endsWith('/decision')), false);
  assert.equal(f.adapters[1].getStatus().enabled, false);
  assert.equal(f.dialogs.length, 1);
  assert.equal((await privateRead(path.join(f.root, 'state.json'))).enabled, false);
});
test('canceled automatic requests reconcile their prepared device without stopping account access', async t => {
  for (const status of [403, 404, 409]) {
    const f = await fixture(t); await f.link({ automatic: true }); await f.addPhone(1, { automatic: true });
    f.requestHook(input => {
      if (input.url.pathname.endsWith('/decision')) {
        f.requests.length = 0;
        throw Object.assign(Error('Request expired or revoked'), { status });
      }
    });
    await f.addPhone(2, { automatic: true });
    assert.equal(f.hub.getStatus().guided.enabled, true);
    assert.equal(f.adapters[1].getStatus().enabled, true);
    f.requestHook(null); await f.hub.checkGuided();
    assert.equal(f.hub.getStatus().guided.phase, 'ready');
    assert.equal(f.hub.getStatus().guided.devices.length, 1);
    assert.equal(f.adapters[2].getStatus().enabled, false);
    assert.equal((await privateRead(path.join(f.root, 'state.json'))).devices.length, 1);
  }
});
test('real account control loss still pauses automatic access and all local devices', async t => {
  for (const status of [401, 403, 404]) {
    const f = await fixture(t); await f.link({ automatic: true }); await f.addPhone(1, { automatic: true });
    f.requestHook(input => {
      if (input.url.pathname.endsWith('/status')) throw Object.assign(Error('Account unavailable'), { status });
    });
    await f.hub.checkGuided();
    assert.equal(f.hub.getStatus().guided.phase, 'account-unavailable');
    assert.equal(f.hub.getStatus().guided.enabled, false);
    assert.equal(f.adapters[1].getStatus().enabled, false);
    assert.equal((await privateRead(path.join(f.root, 'state.json'))).enabled, false);
  }
});
test('Stop then explicit Connect resumes the same pending setup and offers native account approval', async t => {
  const f = await fixture(t);
  await f.hub.beginGuidedSetup('Studio');
  const original = await privateRead(path.join(f.root, 'state.json'));
  assert.equal(original.setup.started, true);
  await f.hub.stop('desktop-disabled'); await f.hub.setGuidedPreference(false);
  const callsBefore = f.calls.length;
  await f.hub.startGuided(f.scope, f.snapshot); await f.hub.checkGuided();
  assert.equal(f.calls.length, callsBefore, 'startup alone must not resume paused setup');
  assert.equal(f.dialogs.length, 0);
  await f.link();
  for (let attempt = 0; attempt < 50 && !f.hub.getStatus().guided.registered; attempt++) {
    await f.hub.checkGuided(); await new Promise(resolve => setTimeout(resolve, 5));
  }
  const saved = await privateRead(path.join(f.root, 'state.json'));
  assert.equal(saved.enabled, true);
  assert.equal(saved.computer.id, original.setup.id);
  assert.equal(saved.computer.token, original.setup.token);
  assert.equal(saved.setup, null);
  assert.equal(f.opens[0], f.opens[1]);
  assert.deepEqual(f.calls.filter(item => item.route === '/account/setup/start').map(item => item.body),
    [f.calls[0].body, f.calls[0].body]);
  assert.equal(f.dialogs.filter(item => item.kind === 'account').length, 1);
});
test('Stop during resumed setup request wins over the late response and never reopens browser or approves', async t => {
  const f = await fixture(t);
  await f.hub.beginGuidedSetup('Studio');
  const original = await privateRead(path.join(f.root, 'state.json'));
  await f.hub.stop('desktop-disabled'); await f.hub.setGuidedPreference(false);
  await f.hub.startGuided(f.scope, f.snapshot);
  let finish, entered;
  const opened = new Promise(resolve => { entered = resolve; });
  f.requestHook(input => {
    if (input.url.pathname === '/account/setup/start') return new Promise(resolve => {
      finish = () => resolve({ setupId: input.body.setupId, expiresAt: Date.now() + 600000 }); entered();
    });
  });
  const resume = f.hub.beginGuidedSetup('Studio'); await opened;
  await f.hub.stop('desktop-disabled'); await f.hub.setGuidedPreference(false); finish();
  await assert.rejects(resume);
  const saved = await privateRead(path.join(f.root, 'state.json'));
  assert.equal(saved.enabled, false);
  assert.equal(saved.setup.id, original.setup.id);
  assert.equal(saved.setup.token, original.setup.token);
  assert.equal(f.opens.length, 1);
  assert.equal(f.dialogs.length, 0);
  assert.equal(f.calls.some(item => item.route.endsWith('/finish')), false);
});
test('real native IPC and hub resume browser-approved paused setup with stable owner scope', async t => {
  const f = await fixture(t); await f.hub.stop();
  const handlers = new Map(), events = [], dialogs = [];
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false,
    send: (_channel, value) => events.push(value) });
  const window = { webContents: contents, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  let hub;
  const native = registerMobileCompanionIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    app: new EventEmitter(), getMainWindow: () => window, clientRoot: '/synthetic/client',
    deviceStorePath: path.join(f.root, 'legacy-device.json'), preferencePath: path.join(f.root, 'legacy-preference.json'),
    dialog: { async showMessageBox(_window, details) { dialogs.push(details); return { response: 1 }; } },
    createServer: options => { hub = createGuidedCompanion(options, { ...f.config, pollMs: 20 }); return hub; },
  });
  t.after(() => native.dispose());
  const call = (name, payload) => handlers.get(CHANNELS[name])(event, payload);
  const payload = { scope: f.scope, snapshot: f.snapshot, name: 'Studio' };
  assert.equal((await call('guidedSetup', payload)).success, true);
  const original = await privateRead(path.join(f.root, 'state.json'));
  assert.equal((await call('disable', { scope: f.scope })).success, true);
  assert.equal((await call('preference')).enabled, false);
  assert.equal((await call('attach', { scope: f.scope, snapshot: f.snapshot })).status.enabled, false);
  f.approveSetup();
  assert.equal((await call('guidedSetup', payload)).success, true);
  // Exercise the timer used by the actual app, never the diagnostic tick hook.
  for (let attempt = 0; attempt < 100 && !hub.getStatus().guided.registered; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(hub.getStatus().guided.registered, true);
  let saved = await privateRead(path.join(f.root, 'state.json'));
  for (let attempt = 0; attempt < 50 && !saved.computer; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5)); saved = await privateRead(path.join(f.root, 'state.json'));
  }
  assert.equal(saved.computer.id, original.setup.id);
  assert.equal(saved.computer.token, original.setup.token);
  assert.equal(saved.enabled, true);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, 'Connect this computer to your Velorn account?');
  assert.equal(dialogs[0].checkboxLabel, undefined, 'guided resume does not enable legacy LAN sharing');
  assert.ok(events.some(value => value.type === 'status' && value.status.guided?.registered));
});
test('real native IPC can remove a paused account without restoring sharing or changing legacy preference', async t => {
  const f = await fixture(t); await f.link(); await f.addPhone();
  await f.hub.stop('desktop-disabled'); await f.hub.setGuidedPreference(false);
  const handlers = new Map(), dialogs = [];
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send() {} });
  const window = { webContents: contents, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  let hub;
  const native = registerMobileCompanionIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    app: new EventEmitter(), getMainWindow: () => window, apiOnly: true,
    deviceStorePath: path.join(f.root, 'legacy-device.json'), preferencePath: path.join(f.root, 'legacy-preference.json'),
    dialog: { async showMessageBox(_window, details) { dialogs.push(details); return { response: 1 }; } },
    createServer: options => { hub = createGuidedCompanion(options, f.config); return hub; },
  });
  t.after(() => native.dispose());
  const call = (name, payload) => handlers.get(CHANNELS[name])(event, payload);
  const before = { calls: f.calls.length, adapters: f.adapters.length, opens: f.opens.length };
  assert.equal((await call('attach', { scope: f.scope, snapshot: f.snapshot })).status.enabled, false);
  assert.equal(hub.getStatus().guided.registered, true);
  const result = await call('guidedUnregister', { scope: f.scope });
  assert.equal(result.success, true);
  assert.equal(result.guided.registered, false);
  assert.equal(result.guided.account, null);
  assert.equal(result.status.enabled, false);
  assert.equal((await call('preference')).enabled, false);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, 'Disconnect Velorn account?');
  assert.deepEqual(f.calls.slice(before.calls).map(item => item.route), ['/account/desktop/guided/unregister']);
  assert.equal(f.adapters.length, before.adapters);
  assert.equal(f.opens.length, before.opens);
  assert.ok(f.adapters.every(adapter => !adapter.getStatus().enabled));
  assert.equal((await privateRead(f.config.statePath)).enabled, false);
});
test('real desktop sign-out/switch requires consent, preserves canceled links and opens login only after confirmed unlink', async t => {
  for (const action of ['sign-out', 'switch-account']) for (const approved of [false, true]) await t.test(`${action} approved=${approved}`, async t => {
    const f = await fixture(t); await f.link(); await f.addPhone(); await f.hub.stop();
    const handlers = new Map(), dialogs = [];
    const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send() {} });
    const window = { webContents: contents, isDestroyed: () => false };
    const event = { sender: contents, senderFrame: contents.mainFrame };
    let hub;
    const native = registerMobileCompanionIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
      app: new EventEmitter(), getMainWindow: () => window, apiOnly: true,
      deviceStorePath: path.join(f.root, 'legacy-device.json'), preferencePath: path.join(f.root, 'legacy-preference.json'),
      dialog: { async showMessageBox(_window, details) { dialogs.push(details); return { response: approved ? 1 : 0 }; } },
      createServer: options => { hub = createGuidedCompanion(options, f.config); return hub; },
    });
    t.after(() => native.dispose());
    const call = (name, payload) => handlers.get(CHANNELS[name])(event, payload);
    try {
    assert.equal((await call('attach', { scope: f.scope, snapshot: f.snapshot })).success, true);
    const before = await privateRead(f.config.statePath), opens = f.opens.length, calls = f.calls.length;
    f.approveSetup(false);
    const result = await call('guidedUnregister', { scope: f.scope, action, ...(action === 'switch-account' ? { snapshot: f.snapshot } : {}) });
    assert.equal(result.success, true, result.error);
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].defaultId, 0); assert.equal(dialogs[0].cancelId, 0);
    assert.match(dialogs[0].detail, /allowances are not deleted or changed/);
    const after = await privateRead(f.config.statePath);
    if (!approved) {
      assert.equal(result.cancelled, true);
      assert.deepEqual(after.computer, before.computer); assert.deepEqual(after.devices, before.devices);
      assert.equal(f.opens.length, opens);
      assert.equal(f.calls.slice(calls).some(item => item.route.endsWith('/unregister') || item.route.endsWith('/start')), false);
    } else {
      assert.equal(after.computer, null); assert.deepEqual(after.devices, []);
      if (action === 'sign-out') {
        assert.equal(f.opens.length, opens); assert.equal(after.setup, null);
      } else {
        assert.equal(f.opens.length, opens + 1);
        assert.equal(f.opens.at(-1), `https://connect.velorn.ai/account/login?desktop=${after.setup.id}`);
        assert.notEqual(after.setup.id, before.computer.id);
        assert.equal(after.setup.name, before.computer.name);
        assert.equal(result.status.guided.phase, 'sign-in');
        const routes = f.calls.slice(calls).map(item => item.route);
        assert(routes.indexOf('/account/desktop/guided/unregister') < routes.indexOf('/account/setup/start'));
      }
    }
    } finally { await native.dispose(); }
  });
});

test('Connect preserves a setup completed by a status poll already in flight', async t => {
  const f = await fixture(t); await f.hub.beginGuidedSetup('Studio'); await f.hub.stop();
  const saved = await privateRead(path.join(f.root, 'state.json'));
  let releaseStatus, releaseStart, enteredStatus, enteredStart;
  const statusStarted = new Promise(resolve => { enteredStatus = resolve; });
  const startStarted = new Promise(resolve => { enteredStart = resolve; });
  f.requestHook(input => {
    if (input.url.pathname === '/account/setup/status') return new Promise(resolve => {
      releaseStatus = () => resolve({ status: 'approved', accountDisplayName: 'Test account', expiresAt: Date.now() + 600000 }); enteredStatus();
    });
    if (input.url.pathname === '/account/setup/start') return new Promise(resolve => {
      releaseStart = () => resolve({ setupId: saved.setup.id, expiresAt: Date.now() + 600000 }); enteredStart();
    });
  });
  await f.hub.startGuided(f.scope, f.snapshot);
  // The timer is intentionally unref'ed in production; this bounded wait keeps
  // the isolated test alive while waiting for its first scheduled request.
  const keepAlive = setTimeout(() => {}, 2000); t.after(() => clearTimeout(keepAlive));
  await statusStarted;
  const resume = f.hub.beginGuidedSetup('Studio'); await startStarted;
  releaseStatus();
  for (let attempt = 0; attempt < 100 && !f.hub.getStatus().guided.registered; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.hub.getStatus().guided.registered, true);
  releaseStart();
  const result = await resume;
  assert.equal(result.phase, 'ready');
  assert.equal(result.computer.id, saved.setup.id);
  assert.equal(f.opens.length, 1, 'do not reopen sign-in after the native poll completed setup');
  assert.equal(f.dialogs.filter(item => item.kind === 'account').length, 1);
});
test('two phones get isolated loopback listeners, encrypted bearers and independently routed same-ID commands', async t => {
  const f = await fixture(t); await f.link();
  const first = await f.addPhone(1), second = await f.addPhone(2);
  assert.equal(f.hub.getStatus().guided.devices.length, 2);
  assert.equal(f.adapters[0].getStatus().enabled, false);
  for (const adapter of f.adapters.slice(1)) { assert.equal(adapter.options.host, '127.0.0.1'); assert.equal(adapter.options.port, 0); }
  const saved = await privateRead(path.join(f.root, 'state.json'));
  for (const [i, phone] of [first, second].entries()) {
    const decision = f.calls.filter(item => item.route.endsWith('/decision'))[i];
    const payload = await handoff.open({ privateKey: phone.key.privateKey, envelope: decision.body.envelope, requestId: phone.record.requestId, computerId: saved.computer.id });
    assert.equal(payload.deviceId, saved.devices[i].id); assert.equal(payload.nativeToken.length, 64);
    assert.equal(JSON.stringify(decision.body).includes(saved.devices[i].config.secret), false);
  }
  await Promise.all(f.adapters.slice(1).map(adapter => adapter.options.onCommand({ id: 'same-phone-id', kind: 'message', text: 'Hello', scope: f.scope })));
  assert.notEqual(f.commands[0].id, f.commands[1].id);
  for (const command of f.commands) assert.equal(f.hub.resolveCommand(f.scope, command.id, { success: true, status: 'completed' }), true);
  for (const adapter of f.adapters.slice(1)) assert.equal(adapter.resolutions[0].id, 'same-phone-id');
  await f.hub.disconnectGuidedDevice(saved.devices[0].id);
  assert.equal(f.hub.getStatus().paired, true); assert.equal(f.hub.getStatus().enabled, true);
  assert.equal(f.adapters[1].getStatus().enabled, false); assert.equal(f.adapters[2].getStatus().enabled, true);
  // A's disconnect advanced the control generation; B must still be able to
  // signal its own native unpair, not retain an obsolete callback closure.
  f.adapters[2].options.onStatus({ enabled: false, reason: 'unpaired' });
  await f.hub.checkGuided();
  assert.equal(f.adapters[2].getStatus().enabled, false);
  assert.equal(f.hub.getStatus().guided.devices.length, 0);
  assert.ok(f.calls.some(item => item.route.endsWith('/disconnect') && item.body.deviceId === saved.devices[1].id));
});
test('late account consent cannot register after native context replacement', async t => {
  const f = await fixture(t);
  f.confirmHook(() => { f.current(false); return true; });
  await f.link();
  assert.equal(f.calls.some(item => item.route.endsWith('/finish')), false);
});
test('lost approval response is reconciled, never repeated, and restart reuses device credentials', async t => {
  const f = await fixture(t); await f.link();
  let lose = true;
  f.requestHook(input => {
    if (input.url.pathname.endsWith('/decision') && input.body.approved && lose) {
      lose = false;
      const item = f.requests.shift();
      f.devices.push({ id: input.body.device.id, name: item.name, roomId: input.body.device.roomId });
      throw Error('Response lost after applying');
    }
  });
  await f.addPhone(); await f.hub.checkGuided();
  assert.equal(f.calls.filter(item => item.route.endsWith('/decision')).length, 1);
  const before = await privateRead(path.join(f.root, 'state.json'));
  assert.equal(before.devices[0].status, 'active');
  await f.hub.stop();
  await f.hub.startGuided(f.scope, f.snapshot); await f.hub.checkGuided();
  assert.deepEqual(await privateRead(path.join(f.root, 'state.json')), before);
});
test('phone-side revocation closes just its device and logout does not implicitly unregister', async t => {
  const f = await fixture(t); await f.link(); await f.addPhone(1); await f.addPhone(2);
  f.devices.shift(); await f.hub.checkGuided();
  assert.equal(f.hub.getStatus().guided.devices.length, 1);
  assert.equal(f.adapters[1].getStatus().enabled, false);
  assert.equal(f.adapters[2].getStatus().enabled, true);
  await f.hub.stop('app-quit');
  assert.equal((await privateRead(path.join(f.root, 'state.json'))).devices.length, 1);
});
test('disconnect cancels an in-flight new-phone approval without disrupting the other phone', async t => {
  const f = await fixture(t); await f.link(); await f.addPhone(1); await f.addPhone(2);
  let finish, entered;
  const opened = new Promise(resolve => { entered = resolve; });
  f.confirmHook(details => details.kind === 'device' ? new Promise(resolve => { finish = resolve; entered(); }) : true);
  const pending = f.addPhone(3); await opened;
  const id = f.hub.getStatus().guided.devices[0].id;
  await f.hub.disconnectGuidedDevice(id); finish(true); await pending;
  assert.equal(f.calls.filter(item => item.route.endsWith('/decision')).length, 2);
  assert.equal(f.hub.getStatus().guided.devices.length, 1);
  assert.equal(f.adapters[2].getStatus().enabled, true);
});
test('unregister ends local authority before a failed network revoke and never approves a stale phone', async t => {
  const f = await fixture(t); await f.link(); await f.addPhone(1);
  let finish, entered;
  const opened = new Promise(resolve => { entered = resolve; });
  f.confirmHook(details => details.kind === 'device' ? new Promise(resolve => { finish = resolve; entered(); }) : true);
  const pending = f.addPhone(2); await opened;
  f.requestHook(input => { if (input.url.pathname.endsWith('/unregister')) throw Error('Network down'); });
  await assert.rejects(f.hub.unregisterGuided()); finish(true); await pending;
  assert.equal(f.adapters[1].getStatus().enabled, false);
  assert.equal(f.calls.filter(item => item.route.endsWith('/decision')).length, 1);
  const saved = await privateRead(path.join(f.root, 'state.json'));
  assert.equal(saved.unregisterPending, true);
  assert.equal(saved.enabled, false);
  f.requestHook(null); await f.hub.checkGuided();
  assert.equal(f.hub.getStatus().guided.registered, false);
});
test('scope replacement closes every prior listener and starts no revoked device', async t => {
  const f = await fixture(t); await f.link(); await f.addPhone(1); await f.addPhone(2);
  f.devices.shift();
  await f.hub.startGuided(opaque('new-scope'), { ...f.snapshot, contextId: opaque('new-context') });
  await f.hub.checkGuided();
  assert.equal(f.adapters[1].getStatus().enabled, false);
  assert.equal(f.adapters[2].getStatus().enabled, false);
  assert.equal(f.adapters.length, 4);
  assert.equal(f.hub.getStatus().guided.devices.length, 1);
  assert.equal(f.hub.isCurrentScope(f.scope), false);
  assert.equal(f.hub.isCurrentScope(opaque('new-scope')), true);
});
test('rollback404 and authorization errors retain pending unregister credentials without reporting success', async t => {
  for (const status of [404, 401, 403]) {
    const f = await fixture(t); await f.link(); await f.addPhone(1);
    const before = await privateRead(path.join(f.root, 'state.json'));
    f.requestHook(input => {
      if (input.url.pathname.endsWith('/unregister')) throw Object.assign(Error('Unconfirmed removal'), { status });
    });
    await assert.rejects(f.hub.unregisterGuided());
    await f.hub.checkGuided();
    const saved = await privateRead(path.join(f.root, 'state.json'));
    assert.equal(saved.unregisterPending, true);
    assert.equal(saved.enabled, false);
    assert.deepEqual(saved.computer, before.computer);
    assert.deepEqual(saved.devices, before.devices);
    assert.equal(f.hub.getStatus().guided.registered, true);
    assert.equal(f.adapters[1].getStatus().enabled, false);
    assert.doesNotMatch(f.hub.getStatus().guided.message, /Computer disconnected/);
    // A later explicit valid server receipt may complete the same request.
    f.requestHook(null);
    for (let attempt = 0; attempt < 50 && f.hub.getStatus().guided.registered; attempt++) {
      await f.hub.checkGuided(); await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(f.hub.getStatus().guided.registered, false);
  }
});
test('malformed200 unregister replies retain recovery state until success is explicitly true', async t => {
  for (const reply of [{}, { success: false }, { success: 'true' }]) {
    const f = await fixture(t); await f.link();
    const before = await privateRead(path.join(f.root, 'state.json'));
    f.requestHook(input => input.url.pathname.endsWith('/unregister') ? reply : null);
    await assert.rejects(f.hub.unregisterGuided());
    const saved = await privateRead(path.join(f.root, 'state.json'));
    assert.equal(saved.unregisterPending, true);
    assert.deepEqual(saved.computer, before.computer);
    assert.equal(f.hub.getStatus().guided.registered, true);
    f.requestHook(null); await f.hub.checkGuided();
    assert.equal(f.hub.getStatus().guided.registered, false);
  }
});
test('damaged optional guided state does not block older pairing or overwrite that state', async t => {
  const f = await fixture(t); await f.hub.stop();
  const filename = path.join(f.root, 'state.json');
  await privateWrite(filename, { version: 500, content: 'preserve me' });
  const replacement = createGuidedCompanion(f.nativeOptions, f.config);
  t.after(() => replacement.stop());
  replacement.setGuidedContext({ isCurrent: () => true, confirm: async () => true });
  await replacement.start(f.scope, f.snapshot);
  assert.equal(replacement.getStatus().enabled, true);
  assert.equal(replacement.getStatus().guided.phase, 'unavailable');
  assert.deepEqual(await privateRead(filename), { version: 500, content: 'preserve me' });
});
test('starting older pairing cannot silently resume account devices after Stop all sharing', async t => {
  const f = await fixture(t); await f.link(); await f.addPhone(1);
  await f.hub.stop(); await f.hub.setGuidedPreference(false);
  const before = f.adapters.length;
  await f.hub.start(f.scope, f.snapshot); await f.hub.checkGuided();
  assert.equal(f.adapters.length, before);
  assert.equal(f.adapters[0].getStatus().enabled, true);
  assert.equal(f.adapters[1].getStatus().enabled, false);
  assert.equal(f.hub.getStatus().guided.enabled, false);
});
test('private state rejects symlinks and public files; only fixed HTTPS service origins are accepted', async t => {
  const f = await fixture(t); await f.link();
  const filename = path.join(f.root, 'state.json'), link = path.join(f.root, 'symlink');
  await fs.symlink(filename, link); await assert.rejects(privateRead(link));
  await fs.chmod(filename, 0o644); await assert.rejects(privateRead(filename));
  assert.throws(() => serviceOrigin('https://user:password@example.org'));
  assert.throws(() => serviceOrigin('http://example.org', true));
  assert.throws(() => serviceOrigin('https://example.org/path'));
  assert.equal(serviceOrigin('http://127.0.0.1:1234', true), 'http://127.0.0.1:1234');
});

test('stopped device needs a fresh renderer publication and later directory check; healthy devices and credentials survive', async t => {
  const f = await fixture(t); await f.link(); await f.addPhone(1); await f.addPhone(2);
  const previous = f.adapters[1], healthy = f.adapters[2], before = await privateRead(f.config.statePath);
  const message = { id: opaque('command'), scope: f.scope, kind: 'projects' };
  await previous.options.onCommand(message);
  const commandId = f.commands[0].id;
  await previous.stop('desktop-unavailable');
  assert.deepEqual(f.revocations, ['phone-connection-lost']);
  assert.equal(f.hub.resolveCommand(f.scope, commandId, { success: true }), false);
  await f.hub.checkGuided(); await f.hub.checkGuided();
  f.hub.publish(f.scope, { ...f.snapshot }); // Cached native review publication is not freshness.
  await f.hub.checkGuided();
  assert.equal(f.adapters.length, 3);
  assert.equal(previous.getStatus().enabled, false);
  assert.equal(healthy.getStatus().enabled, true);
  f.hub.publish(f.scope, { ...f.snapshot }, { rendererPublication: true });
  await f.hub.checkGuided();
  const replacement = f.adapters[3];
  assert.equal(replacement.getStatus().enabled, true);
  assert.equal(replacement.getStatus().paired, true);
  assert.equal(replacement.mints, 0);
  assert.equal(replacement.config.configPath, previous.config.configPath);
  assert.deepEqual(await privateRead(f.config.statePath), before);
  assert.equal(healthy.starts, 1); assert.deepEqual(healthy.stops, []);
  assert.deepEqual(f.revocations, ['phone-connection-lost']);
  assert.equal(f.commands.length, 1, 'Old requests are not replayed into the replacement');
  assert.equal(f.hub.resolveCommand(f.scope, commandId, { success: true }), false);
});

test('wrong scope, stale context, expired heartbeat and unavailable renderer cannot authorize child recovery', async t => {
  let clock = Date.now();
  const f = await fixture(t, { now: () => clock }); await f.link(); await f.addPhone();
  await f.adapters[1].stop('desktop-unavailable');
  assert.equal(f.hub.publish(opaque('wrong'), f.snapshot, { rendererPublication: true }), false);
  f.current(false);
  assert.equal(f.hub.publish(f.scope, f.snapshot, { rendererPublication: true }), false);
  f.current(true); await f.hub.checkGuided(); assert.equal(f.adapters.length, 2);
  f.hub.publish(f.scope, f.snapshot, { rendererPublication: true }); clock += 30000;
  await f.hub.checkGuided(); assert.equal(f.adapters.length, 2);
  f.hub.publish(f.scope, { ...f.snapshot, available: false }, { rendererPublication: true });
  await f.hub.checkGuided(); assert.equal(f.adapters.length, 2);
  f.hub.publish(f.scope, f.snapshot, { rendererPublication: true });
  await f.hub.checkGuided(); assert.equal(f.adapters.length, 3);
});

test('publication arriving during a held directory request requires another authority request before recovery', async t => {
  const f = await fixture(t); await f.link(); await f.addPhone();
  await f.adapters[1].stop('desktop-unavailable');
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  f.requestHook(input => {
    if (input.url.pathname.endsWith('/status')) return new Promise(resolve => {
      release = () => resolve({ computer: { id: input.body.computerId, name: 'Studio' }, devices: structuredClone(f.devices), requests: [] }); enter();
    });
  });
  const checking = f.hub.checkGuided(); await entered;
  f.hub.publish(f.scope, f.snapshot, { rendererPublication: true });
  release(); await checking; assert.equal(f.adapters.length, 2);
  f.requestHook(null); await f.hub.checkGuided(); assert.equal(f.adapters.length, 3);
});

test('revocation, unpair and account control loss beat a stopped-device recovery', async t => {
  for (const mode of ['revoked', 'unpaired', 'account-loss']) {
    const f = await fixture(t); await f.link(); await f.addPhone();
    await f.adapters[1].stop('desktop-unavailable');
    f.hub.publish(f.scope, f.snapshot, { rendererPublication: true });
    if (mode === 'revoked') f.devices.length = 0;
    if (mode === 'unpaired') await f.adapters[1].stop('unpaired');
    if (mode === 'account-loss') f.requestHook(input => {
      if (input.url.pathname.endsWith('/status')) throw Object.assign(Error('Synthetic authority loss'), { status: 403 });
    });
    await f.hub.checkGuided(); assert.equal(f.adapters.length, 2, mode);
    assert.equal(f.adapters[1].getStatus().enabled, false, mode);
    if (mode !== 'account-loss') assert.equal((await privateRead(f.config.statePath)).devices.length, 0, mode);
    else assert.equal(f.hub.getStatus().guided.enabled, false);
  }
});

test('unpair during a held successful directory/presence response cannot be changed back to active', async t => {
  const f = await fixture(t); await f.link(); await f.addPhone();
  const previous = f.adapters[1]; await previous.stop('desktop-unavailable');
  f.hub.publish(f.scope, f.snapshot, { rendererPublication: true });
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  f.requestHook(input => {
    if (input.url.pathname.endsWith('/presence')) return new Promise(resolve => { release = () => resolve({ success: true }); enter(); });
  });
  const checking = f.hub.checkGuided(); await entered;
  await previous.stop('unpaired'); release(); await checking;
  assert.equal(f.adapters.length, 2);
  assert.equal((await privateRead(f.config.statePath)).devices.length, 0);
});

test('stop, disabled preference, context loss and unpair during asynchronous recovery teardown win', async t => {
  for (const mode of ['stop', 'disabled', 'context', 'unpair', 'revoke']) {
    const f = await fixture(t); await f.link(); await f.addPhone();
    const previous = f.adapters[1]; await previous.stop('desktop-unavailable');
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    f.adapterStopHook((adapter, reason) => {
      if (adapter === previous && reason === 'desktop-reconnecting') return new Promise(resolve => { release = resolve; enter(); });
    });
    f.hub.publish(f.scope, f.snapshot, { rendererPublication: true });
    const checking = f.hub.checkGuided(); await entered;
    if (mode === 'stop') await f.hub.stop('desktop-disabled');
    if (mode === 'disabled') await f.hub.setGuidedPreference(false);
    if (mode === 'context') f.current(false);
    if (mode === 'unpair') await previous.stop('unpaired');
    if (mode === 'revoke') await f.hub.disconnectGuidedDevice(f.devices[0].id);
    release(); await checking;
    assert.equal(f.adapters.length, 2, mode);
    assert.equal(previous.getStatus().enabled, false, mode);
  }
});

test('missing remembered device storage fails closed without minting or presence-only retry', async t => {
  const f = await fixture(t); await f.link(); await f.addPhone();
  const previous = f.adapters[1]; await previous.stop('desktop-unavailable');
  f.rememberedDevices.delete(previous.config.configPath);
  f.hub.publish(f.scope, f.snapshot, { rendererPublication: true });
  await f.hub.checkGuided();
  assert.equal(f.adapters.length, 3);
  assert.equal(f.adapters[2].mints, 0); assert.equal(f.adapters[2].getStatus().enabled, false);
  await f.hub.checkGuided(); assert.equal(f.adapters.length, 3);
  assert.equal(f.adapters.reduce((count, adapter) => count + adapter.mints, 0), 1);
});

test('late start completion after Stop cannot revive a recovering listener or credentials', async t => {
  const f = await fixture(t); await f.link(); await f.addPhone();
  await f.adapters[1].stop('desktop-unavailable');
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  f.adapterStartHook(() => new Promise(resolve => { release = resolve; enter(); }));
  f.hub.publish(f.scope, f.snapshot, { rendererPublication: true });
  const checking = f.hub.checkGuided(); await entered;
  await f.hub.stop('desktop-disabled'); await f.hub.setGuidedPreference(false);
  release(); await checking;
  assert.equal(f.adapters.length, 3);
  assert.equal(f.adapters[2].getStatus().enabled, false);
  assert.equal(f.adapters[2].mints, 0);
  assert.equal(f.hub.getStatus().enabled, false);
});

test('repeated fresh renderer heartbeats do not override unavailable-service recovery backoff', async t => {
  const f = await fixture(t); await f.link(); await f.addPhone();
  await f.adapters[1].stop('desktop-unavailable');
  f.requestHook(input => { if (input.url.pathname.endsWith('/status')) throw Error('Synthetic service unavailable'); });
  f.hub.publish(f.scope, f.snapshot, { rendererPublication: true });
  await f.hub.checkGuided();
  assert.equal(f.hub.getStatus().guided.phase, 'reconnecting');
  const before = f.calls.length;
  for (let index = 0; index < 10; index++) {
    f.hub.publish(f.scope, f.snapshot, { rendererPublication: true });
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(f.calls.length, before);
  assert.equal(f.adapters.length, 2);
});

test('a prepared listener stopped during held approval stays fenced when the device becomes active', async t => {
  const f = await fixture(t); await f.link();
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  f.requestHook(input => {
    if (input.url.pathname.endsWith('/decision')) return new Promise(resolve => {
      release = () => {
        f.devices.push({ id: input.body.device.id, roomId: input.body.device.roomId, name: 'Phone 1' });
        f.requests.length = 0;
        resolve({ success: true, status: 'approved' });
      };
      enter();
    });
  });
  const approving = f.addPhone(); await entered;
  assert.equal((await privateRead(f.config.statePath)).devices[0].status, 'prepared');
  await f.adapters[1].stop('desktop-unavailable');
  release(); await approving; f.requestHook(null);
  await f.hub.checkGuided();
  assert.equal((await privateRead(f.config.statePath)).devices[0].status, 'active');
  assert.equal(f.adapters.length, 2);
  f.hub.publish(f.scope, f.snapshot); await f.hub.checkGuided();
  assert.equal(f.adapters.length, 2);
  f.hub.publish(f.scope, f.snapshot, { rendererPublication: true }); await f.hub.checkGuided();
  assert.equal(f.adapters.length, 3); assert.equal(f.adapters[2].mints, 0);
  assert.equal(f.adapters[2].getStatus().paired, true);
  assert.deepEqual(f.revocations, ['phone-connection-lost']);
});

test('unpair of a prepared device wins over a late successful approval receipt', async t => {
  const f = await fixture(t); await f.link();
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  f.requestHook(input => {
    if (input.url.pathname.endsWith('/decision')) return new Promise(resolve => {
      // Server approval is already visible to the phone, but the desktop has
      // not received its decision receipt and still holds a prepared record.
      f.devices.push({ id: input.body.device.id, roomId: input.body.device.roomId, name: 'Phone 1' });
      f.requests.length = 0;
      release = () => resolve({ success: true, status: 'approved' }); enter();
    });
  });
  const approving = f.addPhone(); await entered;
  assert.equal((await privateRead(f.config.statePath)).devices[0].status, 'prepared');
  await f.adapters[1].stop('unpaired');
  release(); await approving; f.requestHook(null);
  assert.equal((await privateRead(f.config.statePath)).devices[0].status, 'disconnecting');
  f.hub.publish(f.scope, f.snapshot, { rendererPublication: true }); await f.hub.checkGuided();
  assert.equal((await privateRead(f.config.statePath)).devices.length, 0);
  assert.equal(f.devices.length, 0);
  assert.equal(f.adapters.length, 2);
  assert.equal(f.adapters[1].getStatus().enabled, false);
});
