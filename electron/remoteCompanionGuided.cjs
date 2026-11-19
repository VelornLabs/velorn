'use strict';

// Native account enrollment and isolated per-phone transports. The renderer
// receives names/IDs only; this module owns all credentials and native consent.
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { randomBytes, createHash } = require('node:crypto');
const { requestJson } = require('./remoteCompanionAccounts.cjs');
const { requestFundedLuna } = require('./fundedLunaTransport.cjs');
const { requestGpuNetwork } = require('./gpuNetworkTransport.cjs');
const { createRemoteCompanionServer, validateConfig } = require('./remoteCompanionDesktop.cjs');
const { createDeviceStore } = require('./mobileCompanionDevice.cjs');
const { createPairingSecret } = require('./remoteCompanionCrypto.cjs');
const { LIMITS: LOCAL_LIMITS } = require('./mobileCompanionServer.cjs');

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{24,128}$/.test(value);
const label = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value);
const accountName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 120
  && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value) ? value.trim() : null;
function publicAccount(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['displayName', 'email', 'emailVerified'].includes(key))) return null;
  const displayName = accountName(value.displayName);
  const hasEmail = Object.hasOwn(value, 'email') || Object.hasOwn(value, 'emailVerified');
  if (hasEmail && (value.emailVerified !== true || typeof value.email !== 'string' || value.email.length > 254
    || !/^[^\s<>@\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]+@[^\s<>@\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]+\.[^\s<>@\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]+$/u.test(value.email))) return null;
  return displayName ? { displayName, ...(hasEmail ? { email: value.email, emailVerified: true } : {}) } : null;
}
const digest = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const unavailable = () => Error('Phone setup is unavailable. Check the connection and try again in Velorn.');
function serviceOrigin(value = 'https://connect.velorn.ai', allowLocalTest = false) {
  const parsed = new URL(value);
  if (parsed.origin !== value || parsed.username || parsed.password ||
    (parsed.protocol !== 'https:' && !(allowLocalTest && parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname)))) throw unavailable();
  return value;
}
async function privateRead(filename) {
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw unavailable();
    const bytes = Buffer.alloc(256 * 1024 + 1), read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > 256 * 1024) throw unavailable();
    return JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw unavailable(); }
  finally { await handle?.close(); }
}
async function privateWrite(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await fs.chmod(temporary, 0o600); await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function validState(value, origin, allowLocalTest) {
  if (!value || value.version !== 1 || value.origin !== origin || typeof value.enabled !== 'boolean' || !Array.isArray(value.devices) || value.devices.length > 20) throw unavailable();
  if (value.automaticAccountAccess !== undefined && typeof value.automaticAccountAccess !== 'boolean') throw unavailable();
  for (const item of [value.setup, value.computer].filter(Boolean)) {
    if (!id(item.id) || !id(item.token) || !label(item.name)) throw unavailable();
  }
  // This installation's display label is not account authority. Migrate old
  // linked installations and keep the label after credentials are removed.
  value.computerName = (value.computer?.name || value.setup?.name || (label(value.computerName) ? value.computerName : 'My computer')).trim();
  // Identity is optional display metadata, not enrollment authority. Old state
  // stays usable; malformed identity never reaches the renderer or blocks it.
  value.account = value.computer && !value.unregisterPending ? publicAccount(value.account) : null;
  if (value.setup) value.setup.confirmedAccount = value.setup.confirmed === true ? publicAccount(value.setup.confirmedAccount) : null;
  const ids = new Set();
  for (const item of value.devices) {
    if (!id(item.id) || ids.has(item.id) || !id(item.requestId) || !label(item.name) || !['prepared', 'active', 'disconnecting'].includes(item.status)
      || !id(item.phoneToken) || !/^[a-f0-9]{64}$/.test(item.nativeToken || '')) throw unavailable();
    ids.add(item.id); validateConfig(item.config, allowLocalTest);
  }
  return value;
}

function createGuidedCompanion(options, { configPath, statePath, devicesRoot, origin: configuredOrigin,
  allowLocalTest = false, openBrowser, request = requestJson, adapterFactory = createRemoteCompanionServer,
  handoff = () => require('./remoteCompanionHandoff.cjs'), pollMs = 2500, now = Date.now,
  lunaRequest = requestFundedLuna, gpuRequest = requestGpuNetwork } = {}) {
  const origin = serviceOrigin(configuredOrigin, allowLocalTest);
  let state = null, loading = null, saveTail = Promise.resolve(), generation = 0, running = false;
  let scope = null, snapshot = null, timer = null, busy = false, abort = null, context = null;
  let fundedAuthority = new AbortController();
  // Account authority belongs to the main window, not a project or phone
  // listener. Separate leases prevent Stop sharing from cancelling desktop Velo.
  let accountContext = null, accountVersion = null, accountTimer = null;
  let accountAbort = new AbortController();
  let phase = 'idle', message = '', legacyRunning = false, mutating = false, stateUnavailable = false, presenceSupported = null;
  const devices = new Map(), commandRoutes = new Map();
  const recoveries = new Map();
  let rendererRevision = 0, rendererPublishedAt = 0;
  // A packaged installation has no LAN browser client or legacy relay config.
  // Do not even construct that adapter: only approved per-device loopback APIs
  // are needed for the hosted, account-linked connection.
  const legacy = options.apiOnly === true ? {
    getStatus: () => ({ enabled: false, paired: false, urls: [], pairingCode: null, reason: 'disabled' }),
    stop: async () => {}, hasRemoteConfiguration: async () => false,
    reviewPhoneAccountRequests: async () => { throw unavailable(); },
  } : adapterFactory({ ...options, onStatus: status => {
    if (legacyRunning && !status.enabled && !state?.enabled) { running = false; legacyRunning = false; abort?.abort(); clearTimeout(timer); }
    notify();
  } }, { configPath, allowLocalTest });
  async function load() {
    if (state) return state;
    if (!loading) loading = (async () => {
      const saved = statePath ? await privateRead(statePath) : null;
      state = saved ? validState(saved, origin, allowLocalTest) : { version: 1, origin, enabled: false, setup: null, computer: null, account: null, computerName: 'My computer', devices: [] };
      return state;
    })().finally(() => { loading = null; });
    return loading;
  }
  function save() {
    if (!statePath) throw unavailable();
    const value = structuredClone(state);
    const next = saveTail.then(() => privateWrite(statePath, value)); saveTail = next.catch(() => {}); return next;
  }
  const accountLease = version => version !== null && typeof version === 'object';
  const live = version => accountLease(version)
    ? version === accountVersion && !accountAbort.signal.aborted && accountContext?.isCurrent?.() === true
    : running && generation === version && !abort?.signal.aborted && context?.isCurrent?.() === true;
  const assertLive = version => { if (!live(version)) throw unavailable(); };
  function publicState() {
    return { phase, message, registered: Boolean(state?.computer), enabled: state?.enabled === true,
      automaticAccountAccess: state?.automaticAccountAccess === true, automaticAvailable: presenceSupported === true,
      account: state?.computer && !state?.unregisterPending ? publicAccount(state.account) : null,
      computer: state?.computer ? { id: state.computer.id, name: state.computer.name } : null,
      computerName: state?.computerName || 'My computer',
      devices: (state?.devices || []).filter(item => item.status === 'active').map(item => ({ id: item.id, name: item.name,
        connected: devices.get(item.id)?.getStatus().remote?.connected === true })) };
  }
  function getStatus() {
    const old = legacy.getStatus(), statuses = (state?.devices || []).filter(item => item.status === 'active')
      .map(item => devices.get(item.id)?.getStatus()).filter(Boolean);
    const paired = (legacyRunning && old.paired) || statuses.some(item => item.paired);
    return { ...old, enabled: running || (legacyRunning && old.enabled), paired: Boolean(paired), legacyEnabled: legacyRunning,
      ...(legacyRunning ? {} : { pairingCode: null, urls: [], localUrl: null, port: null, reason: running ? null : old.reason }),
      guided: publicState() };
  }
  function notify() { try { options.onStatus?.(getStatus()); } catch {} }
  async function post(route, body, token, version) {
    assertLive(version);
    let result;
    try { result = await request({ url: new URL(route, origin), token, body, signal: accountLease(version) ? accountAbort.signal : abort.signal }); }
    catch (error) { error.guidedRoute = route; throw error; }
    assertLive(version); return result;
  }
  function routeMessage(server, value, callback) {
    const nativeId = random(), entry = { server, originalId: value.id };
    commandRoutes.set(nativeId, entry);
    const cleanup = () => commandRoutes.delete(nativeId);
    value.signal?.addEventListener('abort', cleanup, { once: true });
    return Promise.resolve(callback({ ...value, id: nativeId })).then(result => {
      if (result?.status !== 'accepted') cleanup();
      return result;
    }, error => { cleanup(); throw error; });
  }
  function recoveryCurrent(record, version, recovery) {
    return live(version) && state?.enabled === true && record.status === 'active' && state.devices.includes(record)
      && recoveries.get(record.id) === recovery.fence && recovery.revision > recovery.fence.after
      && now() >= rendererPublishedAt && now() - rendererPublishedAt < LOCAL_LIMITS.heartbeatMs
      && snapshot?.available === true;
  }
  function clearDeviceCommands(device) {
    for (const [key, route] of commandRoutes) if (route.server === device) commandRoutes.delete(key);
  }
  async function startDevice(record, version, mint = false, recovery = null) {
    assertLive(version);
    // Directory presence is not evidence that the renderer is alive. A stopped
    // listener remains fenced until an authorized renderer publishes anew and
    // a subsequent directory request confirms this exact active device.
    if (recoveries.has(record.id) && !recovery) return devices.get(record.id);
    const assertRecovery = () => { if (recovery && !recoveryCurrent(record, version, recovery)) throw unavailable(); };
    assertRecovery();
    if (devices.has(record.id)) return devices.get(record.id);
    const directory = path.join(devicesRoot, record.id), deviceConfig = path.join(directory, 'connection.json');
    await privateWrite(deviceConfig, record.config); assertLive(version); assertRecovery();
    const store = createDeviceStore(path.join(directory, 'device.json'));
    let server;
    server = adapterFactory({ ...options, apiOnly: true, clientRoot: null, host: '127.0.0.1', port: 0, deviceStore: store,
      onMessage: value => routeMessage(server, value, options.onMessage), onCommand: value => routeMessage(server, value, options.onCommand || options.onMessage),
      onStatus: status => {
        if (!running || devices.get(record.id) !== server) return;
        if (status.reason === 'unpaired' && ['active', 'prepared'].includes(record.status) && state.devices.includes(record)) {
          recoveries.delete(record.id);
          record.status = 'disconnecting'; void save().then(() => schedule(0)).catch(() => {});
        } else if (!status.enabled && ['active', 'prepared'].includes(record.status) && state.devices.includes(record)) {
          clearDeviceCommands(server);
          if (!recoveries.has(record.id)) {
            recoveries.set(record.id, { after: rendererRevision });
            // Native review/full-access grants cannot outlive the listener
            // which received them. Ordinary relay reconnects keep it enabled.
            try { options.onDeviceRevoked?.('phone-connection-lost'); } catch {}
          }
        }
        notify();
      } }, { configPath: deviceConfig, allowLocalTest });
    devices.set(record.id, server);
    try {
      await server.start(scope, snapshot); assertLive(version); assertRecovery();
      if (recovery && !server.getStatus().paired) throw unavailable();
      if (mint) record.nativeToken = await server.pairApprovedDevice({ isCurrent: () => live(version) });
      assertLive(version);
      if (recovery) recoveries.delete(record.id);
      return server;
    } catch (error) { if (devices.get(record.id) === server) devices.delete(record.id); await server.stop('guided-start-cancelled'); throw error; }
  }
  async function recoverDevice(record, version, revision) {
    const recovery = { fence: recoveries.get(record.id), revision };
    if (!recovery.fence || !recoveryCurrent(record, version, recovery)) return;
    const previous = devices.get(record.id);
    // Teardown can yield. Disable/revoke/unpair or a lost renderer wins over
    // every later completion, and commands from the old listener are discarded.
    if (previous) {
      clearDeviceCommands(previous);
      await previous.stop('desktop-reconnecting');
      if (!recoveryCurrent(record, version, recovery)) return;
      if (devices.get(record.id) !== previous) return;
      devices.delete(record.id);
    }
    try { await startDevice(record, version, false, recovery); }
    catch (error) {
      if (recoveries.get(record.id) === recovery.fence) recovery.fence.after = rendererRevision;
      throw error;
    }
  }
  async function stopDevice(deviceId, reason) {
    recoveries.delete(deviceId);
    const server = devices.get(deviceId); devices.delete(deviceId);
    clearDeviceCommands(server);
    if (server) { try { options.onDeviceRevoked?.(reason); } catch {} }
    await server?.stop(reason); notify();
  }
  async function confirm(details, version) {
    assertLive(version);
    const currentContext = accountLease(version) ? accountContext : context;
    if (typeof currentContext?.confirm !== 'function') throw unavailable();
    const approved = await currentContext.confirm(details); assertLive(version); return approved === true;
  }
  function readyMessage() {
    if (!state.enabled) return 'Signed in to Velorn. Phone sharing is off; Velo access is independent.';
    if (state.automaticAccountAccess !== true) return 'Choose this computer in My computers on your phone and approve the connection here.';
    return presenceSupported === false ? 'Phone access enabled. This service needs an update for automatic connections; manual phone approval is still available.'
      : 'Phone access enabled. Sign in on your phone with the same account to connect.';
  }
  async function announcePresence(version) {
    if (accountLease(version)) return;
    if (!state.enabled || presenceSupported === false) return;
    try {
      const result = await post('/account/desktop/guided/presence', { computerId: state.computer.id, state: 'online', automatic: state.automaticAccountAccess === true }, state.computer.token, version);
      if (result?.success !== true) throw unavailable();
      presenceSupported = true;
    } catch (error) {
      assertLive(version);
      // A deployed older relay may not have this additive route. Keep its
      // existing pairing/registration and manual approval path intact.
      if (error.status !== 404) throw error;
      presenceSupported = false;
    }
  }
  async function setupTick(version) {
    const setup = state.setup;
    if (!setup || !setup.started || state.computer) return;
    const result = await post('/account/setup/status', { setupId: setup.id }, setup.token, version);
    if (!['pending', 'approved', 'rejected', 'complete'].includes(result?.status)) throw unavailable();
    if (result.status === 'rejected' || (result.status !== 'complete' && result.expiresAt <= now())) {
      phase = 'idle'; message = 'Sign-in expired or was declined. Choose Sign in to start again.';
      state.setup = null; state.account = null; await save(); return;
    }
    if (result.status === 'pending') { phase = 'sign-in'; return; }
    if (result.status === 'complete') {
      if (result.computerId !== setup.id) throw unavailable();
      // Only restore an automatic grant that this native setup confirmed.
      state.automaticAccountAccess = setup.confirmedAutomatic === true;
      state.computer = { id: setup.id, token: setup.token, name: setup.name };
      state.account = setup.confirmed === true ? publicAccount(setup.confirmedAccount) : null;
      state.setup = null; phase = 'ready'; message = readyMessage(); await save(); return;
    }
    const displayName = accountName(result.accountDisplayName);
    if (!displayName) throw unavailable();
    const automatic = setup.automatic === true;
    let approved = setup.confirmed === true && (!automatic || setup.confirmedAutomatic === true)
      && publicAccount(setup.confirmedAccount)?.displayName === displayName;
    if (!approved) {
      // Never reuse confirmation for a different account label or an older
      // pending setup that did not record which identity was shown natively.
      setup.confirmed = false; setup.confirmedAutomatic = false; setup.confirmedAccount = null; state.account = null;
      phase = 'confirm-account'; notify();
      approved = await confirm({ kind: 'account', accountDisplayName: displayName, computerName: setup.name, phoneAccess: setup.phoneAccess !== false, ...(automatic ? { automatic: true } : {}) }, version);
      setup.confirmed = approved; setup.confirmedAutomatic = approved && automatic;
      setup.confirmedAccount = approved ? { displayName } : null; await save(); assertLive(version);
    }
    const finished = await post('/account/setup/finish', { setupId: setup.id, approved }, setup.token, version);
    if (finished.status === 'complete' && finished.computerId === setup.id && approved) {
      state.automaticAccountAccess = setup.confirmedAutomatic === true;
      state.computer = { id: setup.id, token: setup.token, name: setup.name };
      state.account = publicAccount(setup.confirmedAccount);
      state.setup = null; phase = 'ready'; message = readyMessage(); await save();
    } else if (finished.status === 'rejected' && !approved) { state.setup = null; state.account = null; phase = 'idle'; message = 'Account link declined.'; await save(); }
    else throw unavailable();
  }
  async function computerTick(version) {
    const computer = state.computer;
    if (!computer) return;
    if (state.unregisterPending) {
      const result = await post('/account/desktop/guided/unregister', { computerId: computer.id }, computer.token, version);
      // Missing routes during a relay rollback and rejected credentials do not
      // prove deletion. Preserve recovery credentials until an explicit receipt.
      if (result?.success !== true) throw unavailable();
      await completeUnregister(); return;
    }
    const publicationBeforeRequest = rendererRevision;
    const result = await post('/account/desktop/guided/status', { computerId: computer.id }, computer.token, version);
    if (result?.computer?.id !== computer.id || !label(result.computer.name) || !Array.isArray(result.devices) || result.devices.length > 20
      || !Array.isArray(result.requests) || result.requests.length > 20) throw unavailable();
    await announcePresence(version);
    const active = new Map();
    for (const item of result.devices) {
      if (!id(item.id) || !id(item.roomId) || !label(item.name) || active.has(item.id)) throw unavailable();
      active.set(item.id, item);
    }
    const pending = new Set();
    for (const item of result.requests) {
      if (!id(item.requestId) || pending.has(item.requestId) || !label(item.name) || !label(item.accountDisplayName) || !Number.isSafeInteger(item.expiresAt)
        || (item.automatic !== undefined && typeof item.automatic !== 'boolean')) throw unavailable();
      pending.add(item.requestId);
    }
    // Server revocation is authoritative, including while the desktop was off.
    // The authenticated response belongs to this exact computer credential.
    // Legacy servers/malformed optional metadata must not erase a known label,
    // interrupt phone access, or cause a sign-in/account switch.
    const account = publicAccount(result.account);
    const nextAccount = account && (!account.email && state.account?.email ? { ...state.account, displayName: account.displayName } : account);
    if (nextAccount && JSON.stringify(nextAccount) !== JSON.stringify(state.account)) {
      assertLive(version);
      if (state.computer !== computer || state.unregisterPending) throw unavailable();
      // A name-only session must not discard an email already verified for this link.
      state.account = nextAccount;
      await save(); assertLive(version);
    }
    // Account-only polling validates identity/revocation but never opens phone
    // transports, approves enrollment or publishes project presence.
    if (accountLease(version)) { phase = 'ready'; message = readyMessage(); return; }
    for (const record of [...state.devices]) {
      if (record.status === 'disconnecting') {
        await stopDevice(record.id, 'phone-disconnected');
        if (active.has(record.id)) await post('/account/desktop/guided/disconnect', { computerId: computer.id, deviceId: record.id }, computer.token, version);
        state.devices = state.devices.filter(item => item !== record); await save(); continue;
      }
      const found = active.get(record.id);
      if (found && found.roomId === record.config.roomId) {
        if (record.status !== 'active') { record.status = 'active'; await save(); }
        if (recoveries.has(record.id)) await recoverDevice(record, version, publicationBeforeRequest);
        else await startDevice(record, version);
        continue;
      }
      // A lost approval response is reconciled here. Never repost a decision.
      if (record.status === 'prepared' && pending.has(record.requestId)) {
        await stopDevice(record.id, 'approval-unconfirmed'); continue;
      }
      await stopDevice(record.id, 'phone-revoked');
      state.devices = state.devices.filter(item => item !== record); await save();
    }
    for (const item of result.requests) {
      if (item.expiresAt <= now() || state.devices.some(record => record.requestId === item.requestId)) continue;
      // The authenticated control API only labels same-account requests as
      // automatic. An old registration is never silently upgraded locally.
      if (item.automatic === true && (state.automaticAccountAccess !== true || presenceSupported !== true)) continue;
      const fingerprint = await handoff().fingerprint(item.publicKey); assertLive(version);
      let approved = item.automatic === true && state.automaticAccountAccess === true;
      if (!approved) {
        phase = 'approve-phone'; notify();
        approved = await confirm({ kind: 'device', accountDisplayName: item.accountDisplayName, deviceName: item.name,
          computerName: computer.name, fingerprint }, version);
      }
      if (item.expiresAt <= now()) continue;
      if (!approved) { await post('/account/desktop/guided/decision', { computerId: computer.id, requestId: item.requestId, approved: false }, computer.token, version); continue; }
      const relayUrl = new URL('/relay', origin); relayUrl.protocol = relayUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const record = { id: random(), requestId: item.requestId, name: item.name, status: 'prepared', phoneToken: random(), nativeToken: '',
        config: { version: 1, url: relayUrl.href, roomId: random(), token: random(), secret: createPairingSecret() } };
      await startDevice(record, version, true); assertLive(version);
      state.devices.push(record); await save(); assertLive(version);
      const payload = { v: 1, requestId: item.requestId, computerId: computer.id, deviceId: record.id,
        bundle: { v: 1, url: record.config.url, roomId: record.config.roomId, token: record.phoneToken, secret: record.config.secret }, nativeToken: record.nativeToken };
      const envelope = await handoff().seal({ publicKey: item.publicKey, payload, requestId: item.requestId, computerId: computer.id }); assertLive(version);
      const decision = await post('/account/desktop/guided/decision', { computerId: computer.id, requestId: item.requestId, approved: true,
        device: { id: record.id, roomId: record.config.roomId, desktopTokenHash: digest(record.config.token), phoneTokenHash: digest(record.phoneToken) }, envelope }, computer.token, version);
      if (decision?.success !== true || decision.status !== 'approved') throw unavailable();
      // The phone may receive its envelope before this decision receipt. Its
      // explicit unpair while we await that receipt must remain terminal.
      if (record.status === 'prepared') record.status = 'active';
      await save(); assertLive(version);
    }
    phase = 'ready'; message = readyMessage();
  }
  async function completeUnregister() {
    state.computerName = state.computer?.name || state.computerName || 'My computer';
    state.computer = null; state.setup = null; state.account = null; state.devices = []; state.enabled = false; state.automaticAccountAccess = false; delete state.unregisterPending;
    revokeFundedAuthority();
    await save(); phase = 'idle'; message = 'Computer disconnected from the Velorn account.';
  }
  function schedule(delay = pollMs) {
    clearTimeout(timer);
    if (!running) return;
    timer = setTimeout(() => void tick(), delay); timer.unref?.();
  }
  function scheduleAccount(delay = pollMs) {
    clearTimeout(accountTimer);
    if (!live(accountVersion)) return;
    accountTimer = setTimeout(() => void tick(true), delay); accountTimer.unref?.();
  }
  async function tick(accountOnly = false) {
    const reschedule = accountOnly ? scheduleAccount : schedule;
    if (accountOnly ? !live(accountVersion) : !running) return;
    // Sharing's existing poll already performs account maintenance.
    if (busy || mutating || (accountOnly && running && state?.enabled && live(generation))) { reschedule(); return; }
    busy = true; const version = accountOnly ? accountVersion : generation;
    try {
      await load(); assertLive(version);
      if (!state.enabled && !state.unregisterPending && !accountOnly) return;
      await setupTick(version); assertLive(version);
      await computerTick(version); assertLive(version);
    } catch (error) { if (live(version)) {
      const accountRoute = ['/account/desktop/guided/status', '/account/desktop/guided/presence', '/account/desktop/guided/unregister'].includes(error.guidedRoute);
      if ([401, 403, 404].includes(error.status) && state?.computer && accountRoute) {
        state.enabled = false; state.account = null;
        // Cancel paid inference AND a tool approval already waiting locally.
        // Do not change the guided tick generation: its UI error still needs
        // publication, while no old funded turn can continue after reconnect.
        revokeFundedAuthority();
        for (const record of state.devices) await stopDevice(record.id, 'account-unavailable');
        await save().catch(() => {});
        phase = 'account-unavailable'; message = 'Account connection is unavailable. Reconnect from Velorn to continue.';
      } else if ([401, 403, 404].includes(error.status) && state?.setup) {
        state.setup = null; state.account = null; await save().catch(() => {});
        phase = 'idle'; message = 'Sign-in expired. Choose Sign in to start again.';
      } else { phase = 'reconnecting'; message = 'Phone service unavailable. Retrying; no commands will be resent.'; }
    } }
    finally { busy = false; if (live(version)) { notify(); if (phase !== 'account-unavailable' && (accountOnly || state?.enabled || state?.unregisterPending)) reschedule(phase === 'reconnecting' ? Math.max(pollMs, 10000) : pollMs); } }
  }
  async function startShared(nextScope, value, includeLegacy) {
    if (includeLegacy && options.apiOnly === true) throw unavailable();
    if (running || legacyRunning || devices.size) await stop('sharing-replaced');
    const version = ++generation;
    abort?.abort(); abort = new AbortController(); clearTimeout(timer);
    running = true; scope = nextScope; snapshot = value; presenceSupported = null;
    try {
      try { await load(); } catch (error) {
        if (!includeLegacy) throw error;
        stateUnavailable = true; phase = 'unavailable'; message = 'Velorn account settings could not be read. Older pairing is unchanged.';
      }
      assertLive(version);
      if (includeLegacy && !legacyRunning) { await legacy.start(nextScope, value); assertLive(version); legacyRunning = true; }
      // Reconcile authority before starting saved device transports.
      if (!stateUnavailable) phase = state.computer ? 'reconnecting' : state.setup ? 'sign-in' : 'idle';
      notify(); if (!stateUnavailable) schedule(0); return getStatus();
    } catch (error) { await stop('guided-start-failed'); throw error; }
  }
  async function stop(reason = 'disabled') {
    running = false; generation++; abort?.abort(); clearTimeout(timer); timer = null;
    commandRoutes.clear(); recoveries.clear(); const children = [...devices.values()]; devices.clear();
    legacyRunning = false;
    await Promise.all([legacy.stop(reason), ...children.map(server => server.stop(reason))]);
    scope = null; snapshot = null; notify(); return getStatus();
  }
  function cancelWork() {
    generation++; abort?.abort(); abort = new AbortController(); clearTimeout(timer);
    return generation;
  }
  function cancelAccountWork() {
    accountAbort.abort(); accountAbort = new AbortController();
    accountVersion = accountContext ? {} : null; clearTimeout(accountTimer);
    return accountVersion;
  }
  function revokeFundedAuthority() {
    fundedAuthority.abort(); fundedAuthority = new AbortController();
  }
  async function beginFundedTurn({ signal } = {}) {
    await load();
    const version = generation, computer = state.computer, authority = fundedAuthority;
    const accountOwner = accountContext;
    const check = () => {
      const ownerCurrent = accountOwner ? accountOwner === accountContext && accountOwner.isCurrent?.() === true : live(version) && state.enabled;
      if (!ownerCurrent || signal?.aborted || authority.signal.aborted || state.unregisterPending || phase === 'account-unavailable' || !computer || state.computer !== computer) {
        throw Object.assign(new Error('Connect this computer to your Velorn account before using Velo.'), { code: 'LUNA_UNAVAILABLE' });
      }
    };
    check();
    const turnSignal = AbortSignal.any([authority.signal, ...(!accountOwner && abort ? [abort.signal] : []), ...(signal ? [signal] : [])]);
    const request = async (kind, payload, childSignal) => {
      check();
      const result = await lunaRequest({ url: new URL(`/account/desktop/luna/${kind}`, origin),
        token: computer.token, body: { ...payload, computerId: computer.id },
        signal: childSignal ? AbortSignal.any([turnSignal, childSignal]) : turnSignal, allowLocalTest });
      check();
      return result;
    };
    return Object.freeze({ signal: turnSignal, assertCurrent: check,
      // Native-only authority for this private bundled-engine preview. Never
      // exposed through preload/status/IPC, and invalidated by the same lease.
      nativeEngineAuthority: () => {
        check();
        if (origin !== 'https://connect.velorn.ai') throw Error('The private native engine requires the existing Velorn relay.');
        return Object.freeze({
          baseUrl: origin + '/account/desktop/luna/native-test/v1',
          computerId: computer.id, token: computer.token,
          accountScope: require('node:crypto').createHash('sha256').update(origin + '\0' + computer.id).digest('hex'),
        });
      },
      status: ({ signal: childSignal } = {}) => request('status', {}, childSignal),
      respond: (payload, { signal: childSignal } = {}) => request('respond', payload, childSignal) });
  }
  // Velorn network (GPU sharing): one call to the queue as this registered
  // computer. The route is one of a fixed list and the credential never leaves
  // this module.
  async function gpuNetworkRequest(route, payload = {}, { signal } = {}) {
    await load();
    const computer = state.computer, authority = fundedAuthority;
    const check = () => {
      if (!computer || state.computer !== computer || state.unregisterPending || phase === 'account-unavailable' || authority.signal.aborted || signal?.aborted) {
        throw Object.assign(new Error('Sign in to your Velorn account on this computer first.'), { code: 'GPU_NETWORK_SIGNED_OUT', publicMessage: 'Sign in to your Velorn account on this computer first.' });
      }
    };
    check();
    const result = await gpuRequest({ url: new URL(`/account/desktop/gpu/${route}`, origin), token: computer.token,
      body: { ...payload, computerId: computer.id }, signal: signal ? AbortSignal.any([authority.signal, signal]) : authority.signal, allowLocalTest });
    check();
    return result;
  }
  return {
    // Only called by native Velorn network code. No preload/IPC method exposes the credential.
    gpuNetwork: Object.freeze({ request: gpuNetworkRequest, registered: () => Boolean(state?.computer && !state.unregisterPending), computerName: () => state?.computer?.name || state?.computerName || 'My computer' }),
    // Only called by the native connected-agent broker. No preload/IPC method
    // exposes these operations or the saved credential to browser code.
    fundedLuna: Object.freeze({
      beginTurn: beginFundedTurn,
      status: async options => (await beginFundedTurn(options)).status(),
      respond: async (payload, options) => (await beginFundedTurn(options)).respond(payload),
    }),
    getStatus, hasRemoteConfiguration: () => legacy.hasRemoteConfiguration(),
    reviewPhoneAccountRequests: args => legacy.reviewPhoneAccountRequests(args),
    setGuidedContext(value) { context = value; },
    async setAccountContext(value) {
      const changed = accountContext !== value;
      if (changed) {
        accountAbort.abort(); accountAbort = new AbortController();
        accountContext = value; accountVersion = value ? {} : null;
        revokeFundedAuthority(); clearTimeout(accountTimer);
      }
      await load(); if (value && (changed || !accountTimer)) scheduleAccount(0);
    },
    async enableAccountPhone() {
      if (mutating) throw unavailable(); mutating = true;
      try {
        await load(); const version = accountVersion; assertLive(version);
        if (!state.computer || state.unregisterPending) throw unavailable();
        const approved = await confirm({ kind: 'automatic', automatic: true, computerName: state.computer.name }, version);
        if (!approved) return publicState();
        state.enabled = true; state.automaticAccountAccess = true; await save();
        assertLive(version); notify(); return publicState();
      } finally { mutating = false; scheduleAccount(0); }
    },
    async getGuidedPreference() { await load(); return state.enabled || state.unregisterPending === true; },
    async setGuidedPreference(enabled) {
      await load(); state.enabled = enabled === true;
      if (!state.enabled && !accountContext) revokeFundedAuthority();
      await save();
    },
    start: (nextScope, value) => startShared(nextScope, value, true),
    startGuided: (nextScope, value) => startShared(nextScope, value, false),
    stop,
    isCurrentScope(value) { return running && scope === value && context?.isCurrent?.() === true; },
    publish(value, next, { rendererPublication = false } = {}) {
      if (!running || value !== scope || context?.isCurrent?.() !== true) return false;
      if (rendererPublication === true) { rendererRevision++; rendererPublishedAt = now(); }
      snapshot = next;
      if (legacyRunning) legacy.publish(value, next);
      for (const server of devices.values()) server.publish(value, next);
      // Wake only once per loss. Repeated renderer heartbeats must not defeat
      // the existing reconnecting/network-error backoff in tick().
      if (rendererPublication === true && state?.enabled) {
        let wake = false;
        for (const fence of recoveries.values()) if (!fence.woken && rendererRevision > fence.after) {
          fence.woken = true; wake = true;
        }
        if (wake) schedule(0);
      }
      return true;
    },
    resolveCommand(value, requestId, result) {
      const route = commandRoutes.get(requestId);
      if (!route) return legacyRunning ? legacy.resolveCommand(value, requestId, result) : false;
      const resolved = route.server.resolveCommand(value, route.originalId, result);
      if (!result?.success || result.status !== 'accepted') commandRoutes.delete(requestId);
      return resolved;
    },
    async beginGuidedSetup(name, { automatic = false, reauthenticate = false, accountOnly = false } = {}) {
      if (!label(name) || typeof openBrowser !== 'function') throw unavailable();
      if (typeof automatic !== 'boolean' || typeof reauthenticate !== 'boolean') throw unavailable();
      if (mutating) throw unavailable(); mutating = true;
      try {
        await load(); const version = accountOnly ? accountVersion : generation; assertLive(version);
        if (state.computer) {
          if (accountOnly) return publicState();
          if (automatic && state.automaticAccountAccess !== true) {
            const approved = await confirm({ kind: 'automatic', automatic: true, computerName: state.computer.name }, version);
            if (!approved) return publicState();
            state.automaticAccountAccess = true;
          }
          state.enabled = true; await save(); assertLive(version); phase = 'ready'; message = readyMessage(); notify(); return publicState();
        }
        if (!state.setup) { state.setup = { id: random(), token: random(), name: name.trim(), ...(accountOnly ? { phoneAccess: false } : {}) }; state.account = null; if (accountOnly) state.enabled = false; }
        const setup = state.setup;
        state.computerName = setup.name;
        if (automatic) setup.automatic = true;
        const completed = () => {
          assertLive(version);
          if (state.computer?.id === setup.id) return true;
          if (state.setup !== setup) throw unavailable();
          return false;
        };
        // Connect explicitly resumes paused setup. The latch holds new polls;
        // identity checks preserve progress from a poll already in flight.
        if (!accountOnly) state.enabled = true;
        await save(); if (completed()) return publicState();
        const result = await post('/account/setup/start', { setupId: setup.id, controlTokenHash: digest(setup.token), name: setup.name }, undefined, version);
        if (completed()) return publicState();
        if (result?.setupId !== setup.id || !Number.isSafeInteger(result.expiresAt)) throw unavailable();
        setup.expiresAt = result.expiresAt; setup.started = true; await save(); if (completed()) return publicState();
        // Never trust a server-provided browser URL or put any secret in it.
        await openBrowser(reauthenticate ? `${origin}/account/login?desktop=${encodeURIComponent(setup.id)}`
          : `${origin}/account#desktop=${encodeURIComponent(setup.id)}`); if (completed()) return publicState();
        if (phase !== 'confirm-account') {
          phase = 'sign-in'; message = 'Finish signing in in your browser, then approve the account here.';
        }
        notify(); return publicState();
      } finally { mutating = false; if (running) schedule(0); scheduleAccount(0); }
    },
    async disconnectGuidedDevice(deviceId, { accountOnly = false } = {}) {
      if (mutating) throw unavailable(); mutating = true;
      try {
        await load(); assertLive(accountOnly ? accountVersion : generation);
        const record = state.devices.find(item => item.id === deviceId);
        if (!record || !state.computer) throw unavailable();
        // Fence a directory read already in flight so it cannot resurrect the
        // device after the disconnect receipt. Desktop Velo keeps its own lease.
        const phoneVersion = cancelWork();
        const version = accountOnly ? cancelAccountWork() : phoneVersion;
        // Stop local authority even if the service is temporarily unavailable.
        record.status = 'disconnecting'; await save(); assertLive(version); await stopDevice(deviceId, 'phone-disconnected');
        await post('/account/desktop/guided/disconnect', { computerId: state.computer.id, deviceId }, state.computer.token, version);
        state.devices = state.devices.filter(item => item !== record); await save(); notify(); return publicState();
      } finally { mutating = false; if (running) schedule(0); scheduleAccount(0); }
    },
    async unregisterGuided({ isCurrent: administrativeCurrent, accountOnly = false } = {}) {
      if (mutating) throw unavailable(); mutating = true;
      try {
        await load();
        if (accountOnly) {
          assertLive(accountVersion); cancelWork();
          const version = cancelAccountWork(); assertLive(version);
          if (!state.computer) throw unavailable();
          state.unregisterPending = true; state.enabled = false; state.account = null; revokeFundedAuthority();
          await save(); assertLive(version);
          for (const record of state.devices) await stopDevice(record.id, 'computer-disconnected');
          await computerTick(version); assertLive(version); notify(); return publicState();
        }
        if (!running) {
          // Paused settings still permit explicit native account removal. This
          // path never starts a listener, presence, enrollment or phone access.
          if (typeof administrativeCurrent !== 'function' || !administrativeCurrent() || !state.computer) throw unavailable();
          const version = cancelWork(), computer = state.computer;
          const current = () => generation === version && !running && !abort.signal.aborted && administrativeCurrent() === true;
          const assertCurrent = () => { if (!current()) throw unavailable(); };
          assertCurrent(); state.unregisterPending = true; state.enabled = false; state.account = null;
          await save(); assertCurrent();
          const result = await request({ url: new URL('/account/desktop/guided/unregister', origin),
            token: computer.token, body: { computerId: computer.id }, signal: abort.signal });
          assertCurrent();
          if (result?.success !== true) throw unavailable();
          await completeUnregister(); assertCurrent(); notify(); return publicState();
        }
        assertLive(generation);
        if (!state.computer) throw unavailable();
        const version = cancelWork();
        state.unregisterPending = true; state.enabled = false; state.account = null; await save(); assertLive(version);
        for (const record of state.devices) await stopDevice(record.id, 'computer-disconnected');
        await computerTick(version); notify(); return publicState();
      } finally { mutating = false; if (running) schedule(0); scheduleAccount(0); }
    },
    // Explicit tick is for isolated tests, not renderer exposure.
    checkGuided: tick,
  };
}
module.exports = { createGuidedCompanion, privateRead, privateWrite, validState, serviceOrigin };
