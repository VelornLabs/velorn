'use strict';
// Outbound-only adapter for the native companion's existing, allowlisted APIs.
// This is not a general HTTP, filesystem, ComfyUI, or MCP proxy.
const http = require('node:http');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { endpoint, createPeer } = require('./remoteCompanionTransport.cjs');
const { isPairingSecret } = require('./remoteCompanionCrypto.cjs');
const MAX_RESPONSE = 6 * 1024 * 1024, MAX_RANGE = 256 * 1024;
// One piece of a phone photo: 256 KiB of picture as base64, plus its small JSON wrapper.
const PHOTO_BODY = 384 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const valid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
function validateConfig(value, allowLocalTest = false) {
  if (!object(value) || value.version !== 1 || !valid(value.roomId) || !valid(value.token)
    || !isPairingSecret(value.secret) || Object.keys(value).some(k => !['version', 'url', 'roomId', 'token', 'secret'].includes(k))) throw new Error('Invalid remote configuration.');
  return { version: 1, url: endpoint(value.url, allowLocalTest), roomId: value.roomId, token: value.token, secret: value.secret };
}
async function readConfig(file, allowLocalTest = false) {
  if (!file) return null;
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8192 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Remote configuration must be a private regular file.');
    const buffer = Buffer.alloc(8193), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) throw new Error('Remote configuration too large.');
    return validateConfig(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')), allowLocalTest);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}
function publicError(status, error) {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' },
    body: Buffer.from(JSON.stringify({ success: false, error })).toString('base64') };
}
function validateRequest(input) {
  if (!object(input) || Object.keys(input).some(key => !['method', 'path', 'headers', 'body'].includes(key))
    || typeof input.path !== 'string' || input.path.length > 180 || !object(input.headers || {})) throw new Error('Invalid request.');
  // Create for the paired phone: its own two API routes and its own result media.
  // The photo route alone may carry one bounded piece of a picture.
  const api = ['/api/pair', '/api/state', '/api/message', '/api/command', '/api/unpair', '/api/create', '/api/create/photo'].includes(input.path);
  const media = /^\/media\/(exports|audio|reviews|create)\/[a-f0-9]{48}(\/download)?$/.exec(input.path);
  const method = input.method;
  if ((!api && !media) || (api && !['POST', ...(input.path === '/api/state' ? ['GET'] : [])].includes(method))
    || (media && !['GET', 'HEAD'].includes(method)) || (media?.[1] === 'reviews' && media[2])) throw new Error('Route not supported.');
  const headers = {};
  for (const [name, value] of Object.entries(input.headers || {})) {
    const lower = name.toLowerCase();
    if (lower in headers || typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Invalid header.');
    if (api && lower === 'authorization' && /^Bearer [a-f0-9]{64}$/.test(value)) headers[lower] = value;
    else if (api && lower === 'content-type' && /^application\/json(?:;\s*charset=utf-8)?$/i.test(value)) continue;
    else if (media && lower === 'range' && /^bytes=\d+-\d+$/.test(value)) headers[lower] = value;
    else throw new Error('Header not supported.');
  }
  if (media && method === 'GET' && media[1] !== 'reviews') {
    const range = /^bytes=(\d+)-(\d+)$/.exec(headers.range || '');
    if (!range || !range.slice(1).every(v => Number.isSafeInteger(Number(v))) || Number(range[2]) < Number(range[1])
      || Number(range[2]) - Number(range[1]) >= MAX_RANGE) throw new Error('A bounded media range is required.');
  }
  const body = input.body === undefined ? '' : input.body;
  if (typeof body !== 'string' || Buffer.byteLength(body) > (input.path === '/api/create/photo' ? PHOTO_BODY : 20 * 1024) || (method !== 'POST' && body)) throw new Error('Invalid request body.');
  if (method === 'POST') { if (!object(JSON.parse(body))) throw new Error('JSON object required.'); headers['content-type'] = 'application/json'; }
  return { method, path: input.path, headers, body, api, media };
}
function createRemoteCompanionServer(options, { configPath, allowLocalTest = false,
  peerFactory = createPeer, localFactory = require('./mobileCompanionServer.cjs').createMobileCompanionServer } = {}) {
  let local, peer = null, generation = 0, cookie = '', bearer = '', configuring = 0, accountReview = null;
  let remote = { configured: false, connected: false, reason: 'not-configured' };
  const requests = new Set();
  const getStatus = () => ({ ...local.getStatus(), remote: { ...remote } });
  function notify() { try { options.onStatus?.(getStatus()); } catch { /* UI status is not authority. */ } }
  function closeRemote(reason) {
    accountReview?.abort();
    generation++; const old = peer; peer = null;
    remote = { ...remote, connected: false, reason }; cookie = ''; bearer = '';
    for (const request of requests) request.destroy(); requests.clear(); old?.close();
  }
  local = localFactory({ ...options, onStatus(status) {
    if (!status.enabled && configuring !== generation) closeRemote(status.reason || 'desktop-unavailable');
    try { options.onStatus?.({ ...status, remote: { ...remote } }); } catch { /* Display only. */ }
  } });
  async function forward(input, { signal } = {}) {
    const version = generation;
    if (signal?.aborted || !local.getStatus().enabled || !remote.connected) return publicError(503, 'DESKTOP_UNAVAILABLE');
    let request;
    try { request = validateRequest(input); } catch { return publicError(400, 'REMOTE_REQUEST_NOT_SUPPORTED'); }
    // The target comes only from the listener we own, never from remote input.
    let target;
    try {
      target = new URL(local.getStatus().localUrl);
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port
        || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error();
    } catch { return publicError(503, 'DESKTOP_UNAVAILABLE'); }
    if (request.api && request.headers.authorization && request.headers.authorization !== bearer) {
      bearer = request.headers.authorization; cookie = '';
    }
    if (request.media && !cookie) return publicError(401, 'MEDIA_AUTH_REQUIRED');
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (result, uncertain = false) => {
        if (finished) return; finished = true; requests.delete(outgoing); signal?.removeEventListener('abort', abort);
        if (uncertain && request.method === 'POST' && request.path !== '/api/state') reject(Object.assign(new Error('The desktop response was lost; delivery may be uncertain.'), { code: 'REMOTE_UNCERTAIN' }));
        else resolve(result);
      };
      const abort = () => outgoing.destroy();
      const outgoing = http.request({ hostname: '127.0.0.1', port: Number(target.port), method: request.method, path: request.path,
        headers: { ...request.headers, origin: target.origin, ...(request.media ? { cookie } : {}),
          ...(request.method === 'POST' ? { 'content-length': Buffer.byteLength(request.body) } : {}) } }, response => {
        const chunks = []; let length = 0;
        const limit = request.media && request.media[1] !== 'reviews' && request.method === 'GET' ? MAX_RANGE : MAX_RESPONSE;
        const contentLength = Number(response.headers['content-length']);
        if (request.method !== 'HEAD' && Number.isFinite(contentLength) && contentLength > limit) { finish(publicError(502, 'DESKTOP_RESPONSE_TOO_LARGE'), true); response.destroy(); outgoing.destroy(); return; }
        response.on('data', chunk => {
          length += chunk.length;
          if (length > limit) { finish(publicError(502, 'DESKTOP_RESPONSE_TOO_LARGE'), true); response.destroy(); outgoing.destroy(); return; }
          chunks.push(chunk);
        });
        response.on('error', () => finish(publicError(502, 'DESKTOP_RESPONSE_UNAVAILABLE'), true));
        response.on('end', () => {
          if (finished) return;
          if (version !== generation || signal?.aborted) { finish(publicError(503, 'DESKTOP_UNAVAILABLE'), true); return; }
          if (response.statusCode >= 300 && response.statusCode < 400) { finish(publicError(502, 'REDIRECT_NOT_SUPPORTED'), true); return; }
          if (request.path === '/api/state' && response.statusCode === 200 && request.headers.authorization === bearer) {
            const found = (response.headers['set-cookie'] || []).map(v => /^(velorn_media=[a-f0-9]{64});/.exec(v)?.[1]).find(Boolean);
            if (found) cookie = found;
          }
          const headers = {};
          for (const name of ['content-type', 'content-length', 'content-range', 'content-disposition', 'accept-ranges']) {
            const value = response.headers[name]; if (typeof value === 'string' && value.length <= 2048) headers[name] = value;
          }
          finish({ status: response.statusCode, headers, body: Buffer.concat(chunks).toString('base64') });
        });
      });
      requests.add(outgoing); signal?.addEventListener('abort', abort, { once: true });
      outgoing.setTimeout(30000, () => outgoing.destroy());
      outgoing.on('error', () => finish(publicError(502, 'DESKTOP_RESPONSE_UNAVAILABLE'), true));
      outgoing.on('close', () => { if (!finished) finish(publicError(502, 'DESKTOP_RESPONSE_UNAVAILABLE'), true); });
      if (signal?.aborted) { outgoing.destroy(); return; }
      outgoing.end(request.body);
    });
  }
  return {
    getStatus, isCurrentScope: (...args) => local.isCurrentScope(...args),
    async hasRemoteConfiguration() { try { return Boolean(await readConfig(configPath, allowLocalTest)); } catch { return false; } },
    async reviewPhoneAccountRequests({ confirm, isCurrent = () => true }) {
      if (accountReview || !local.getStatus().enabled) throw Error('Velorn account review is unavailable.');
      const controller = new AbortController(), version = generation;
      accountReview = controller;
      try {
        return await require('./remoteCompanionAccounts.cjs').reviewPhoneAccountRequests({ configPath, allowLocalTest, confirm,
          signal: controller.signal, isCurrent: () => version === generation && local.getStatus().enabled && isCurrent() });
      } finally { if (accountReview === controller) accountReview = null; }
    },
    publish: (...args) => local.publish(...args), resolveCommand: (...args) => local.resolveCommand(...args),
    pairApprovedDevice: (...args) => local.pairApprovedDevice(...args),
    async start(...args) {
      closeRemote('starting'); const version = generation; configuring = version;
      try {
        await local.start(...args);
        if (version !== generation) return getStatus();
        let config;
        try { config = await readConfig(configPath, allowLocalTest); }
        catch { if (version === generation) { remote = { configured: false, connected: false, reason: 'configuration-error' }; notify(); } return getStatus(); }
        if (version !== generation) return getStatus();
        if (!config) { remote = { configured: false, connected: false, reason: 'not-configured' }; return getStatus(); }
        if (!local.getStatus().enabled) return getStatus();
        remote = { configured: true, connected: false, reason: 'connecting' };
        peer = peerFactory({ role: 'desktop', ...config, allowLocalTest, onRequest: forward,
          onReady() { if (version === generation) { remote = { configured: true, connected: true, reason: 'connected' }; notify(); } },
          onClose({ reason }) { if (version === generation) { cookie = ''; bearer = ''; for (const request of requests) request.destroy(); requests.clear(); remote = { configured: true, connected: false, reason }; notify(); } } });
        peer.start(); notify(); return getStatus();
      } finally { if (configuring === version) configuring = 0; }
    },
    async stop(reason = 'disabled') { closeRemote(reason); await local.stop(reason); return getStatus(); },
  };
}
module.exports = { createRemoteCompanionServer, validateConfig, readConfig, validateRequest, MAX_RESPONSE, MAX_RANGE };
