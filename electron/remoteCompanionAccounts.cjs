'use strict';
// Account directory adoption uses an existing relay credential, never a new
// pairing secret. Only native code can read that credential or approve a link.
const http = require('node:http');
const https = require('node:https');
const { readConfig } = require('./remoteCompanionDesktop.cjs');

const MAX_RESPONSE = 32 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && !/[\u0000-\u001f\u007f]/.test(value);
function unavailable() { return new Error('Velorn account requests could not be checked. Try again from Velorn.'); }
function requestJson({ url, token, body, signal }) {
  return new Promise((resolve, reject) => {
    const contents = JSON.stringify(body);
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST', signal,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json',
        'content-length': Buffer.byteLength(contents) },
    }, response => {
      if (response.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(response.headers['content-type'] || '')
        || Number(response.headers['content-length'] || 0) > MAX_RESPONSE) {
        const failure = unavailable(); failure.status = response.statusCode;
        response.destroy(); reject(failure); return;
      }
      let size = 0; const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE) { response.destroy(); reject(unavailable()); return; }
        chunks.push(chunk);
      });
      response.on('error', () => reject(unavailable()));
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(unavailable()); }
      });
    });
    const deadline = setTimeout(() => request.destroy(unavailable()), 10000);
    deadline.unref?.();
    request.on('close', () => clearTimeout(deadline));
    request.on('error', () => reject(unavailable()));
    request.end(contents);
  });
}

async function reviewPhoneAccountRequests({ configPath, allowLocalTest = false,
  confirm, isCurrent = () => true, signal, request = requestJson, now = Date.now }) {
  const config = await readConfig(configPath, allowLocalTest);
  if (!config || typeof confirm !== 'function') throw unavailable();
  const origin = new URL(config.url);
  origin.protocol = origin.protocol === 'wss:' ? 'https:' : 'http:';
  const current = async () => {
    if (signal?.aborted || !isCurrent()) throw unavailable();
    // A native configuration change while a dialog is open invalidates consent.
    const fresh = await readConfig(configPath, allowLocalTest);
    if (!fresh || JSON.stringify(fresh) !== JSON.stringify(config) || signal?.aborted || !isCurrent()) throw unavailable();
  };
  const post = async (route, body) => {
    await current();
    const result = await request({ url: new URL(route, origin), token: config.token, body: { roomId: config.roomId, ...body }, signal });
    await current();
    return result;
  };
  const result = await post('/account/desktop/link-requests', {});
  if (!object(result) || !Array.isArray(result.requests) || result.requests.length > 10) throw unavailable();
  const ids = new Set();
  for (const item of result.requests) {
    if (!object(item) || !/^[A-Za-z0-9_-]{16,128}$/.test(item.requestId || '') || ids.has(item.requestId)
      || !name(item.accountDisplayName) || !name(item.computerName) || !Number.isSafeInteger(item.expiresAt)) throw unavailable();
    ids.add(item.requestId);
  }
  let linked = 0, declined = 0;
  for (const item of result.requests) {
    if (item.expiresAt <= now()) continue;
    await current();
    const approved = await confirm({ accountDisplayName: item.accountDisplayName, computerName: item.computerName }) === true;
    await current();
    if (item.expiresAt <= now()) throw unavailable();
    // A lost decision reply is not automatically retried. The next check shows
    // the authoritative pending list, without replaying an old approval.
    const decision = await post('/account/desktop/link-decision', { requestId: item.requestId, approved });
    if (!object(decision) || decision.success !== true) throw unavailable();
    if (approved) {
      linked++;
      // One room has one account owner. Approval resolves competing requests
      // server-side; do not offer stale approvals from the earlier list.
      break;
    } else declined++;
  }
  return { linked, declined, requestsChecked: result.requests.length };
}
module.exports = { reviewPhoneAccountRequests, requestJson, MAX_RESPONSE };
