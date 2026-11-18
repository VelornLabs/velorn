'use strict';

// Native-only transport. The guided companion supplies its existing credential;
// neither a provider API key nor a desktop token is accepted from the renderer.
const http = require('node:http');
const https = require('node:https');
const { markPreDispatchRefusal } = require('./fundedLunaRecovery.cjs');
const MAX_REQUEST = 24 * 1024 * 1024 + 16 * 1024;
const MAX_RESPONSE = 256 * 1024;
const SERVICE_ERRORS = Object.freeze({ not_eligible: 'LUNA_NOT_ELIGIBLE', allowance_exhausted: 'LUNA_EXHAUSTED',
  busy: 'LUNA_BUSY', rate_limited: 'LUNA_BUSY', request_cancelled: 'CANCELLED',
  unauthorized: 'LUNA_AUTH_REQUIRED', invalid_request: 'LUNA_REQUEST_REJECTED',
  not_configured: 'LUNA_SERVICE_UNAVAILABLE', upstream_unavailable: 'LUNA_SERVICE_UNAVAILABLE',
  storage_unavailable: 'LUNA_SERVICE_UNAVAILABLE', ledger_capacity: 'LUNA_SERVICE_UNAVAILABLE',
  request_already_used: 'LUNA_RESPONSE_UNCERTAIN', request_conflict: 'LUNA_RESPONSE_UNCERTAIN' });
const MESSAGES = Object.freeze({
  CANCELLED: 'Velo request cancelled.',
  LUNA_AUTH_REQUIRED: 'The Velo service rejected this computer’s account connection. Check the Velorn account connection.',
  LUNA_NOT_ELIGIBLE: 'This Velorn account does not have Velo access.',
  LUNA_EXHAUSTED: 'The funded allowance for Velo has been used up.',
  LUNA_BUSY: 'Velo is busy.',
  LUNA_REQUEST_LIMIT: 'This message exceeds the Velo request limit.',
  LUNA_REQUEST_REJECTED: 'Velo could not accept this request. No automatic retry was made. Earlier tools may already have completed.',
  LUNA_SERVICE_UNAVAILABLE: 'The Velo service could not complete the request. No automatic retry was made. Earlier tools may already have completed.',
  LUNA_RESPONSE_UNCERTAIN: 'Velo did not receive a confirmed response. No automatic retry was made; the request may already have been processed. Inspect completed work before continuing.',
  LUNA_INVALID_RESPONSE: 'Velo received an invalid or incomplete response. No automatic retry was made. Earlier tools may already have completed.',
});
const failure = (code = 'LUNA_SERVICE_UNAVAILABLE') => Object.assign(new Error(MESSAGES[code]), { code });

function requestFundedLuna({ url, token, body, signal, allowLocalTest = false }) {
  return new Promise((resolve, reject) => {
    let contents, requestId;
    try {
      if (!(url instanceof URL) || url.username || url.password || url.search || url.hash ||
        !['/account/desktop/luna/status', '/account/desktop/luna/respond'].includes(url.pathname) ||
        !(url.protocol === 'https:' || (allowLocalTest && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) ||
        !/^[A-Za-z0-9_-]{43}$/.test(token || '')) throw failure('LUNA_REQUEST_REJECTED');
      contents = JSON.stringify(body);
      if (!contents || Buffer.byteLength(contents) > MAX_REQUEST) throw failure('LUNA_REQUEST_LIMIT');
      requestId = JSON.parse(contents)?.requestId;
      if (signal?.aborted) throw failure('CANCELLED');
    } catch (error) {
      // A serialization failure can originate in caller-supplied data. Never
      // expose its message, credential-bearing URL, or arbitrary error code.
      reject(failure(Object.hasOwn(MESSAGES, error?.code) ? error.code : 'LUNA_REQUEST_REJECTED')); return;
    }
    let settled = false, deadline;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(deadline);
      if (signal?.aborted) reject(failure('CANCELLED'));
      else if (error) reject(error);
      else resolve(result);
    };
    // Node's HTTP client never follows redirects. The origin comes exclusively
    // from native guided configuration, not a model, prompt, or API response.
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST', signal, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'content-length': Buffer.byteLength(contents) },
    }, response => {
      if (!/^application\/json(?:;|$)/i.test(response.headers['content-type'] || '') ||
          Number(response.headers['content-length'] || 0) > MAX_RESPONSE) {
        finish(failure('LUNA_INVALID_RESPONSE')); response.destroy(); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE) { finish(failure('LUNA_INVALID_RESPONSE')); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('error', () => finish(failure('LUNA_RESPONSE_UNCERTAIN')));
      response.on('aborted', () => finish(failure('LUNA_RESPONSE_UNCERTAIN')));
      response.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200 || result?.ok !== true) {
            // Classification is fixed local text, not retry authority. Only a
            // structured service refusal can identify an account/access issue;
            // an unknown HTTP failure must not imply the account disconnected.
            const knownError = result && !Array.isArray(result) && result.ok === false
              && typeof result.error === 'string' && Object.hasOwn(SERVICE_ERRORS, result.error);
            const error = failure(knownError ? SERVICE_ERRORS[result.error] : 'LUNA_SERVICE_UNAVAILABLE');
            // These exact relay refusals occur before reserving funds or calling
            // the provider. HTTP/JSON errors and ambiguous transport failures
            // never receive this native-only replay authority.
            if (url.pathname === '/account/desktop/luna/respond' && response.statusCode === 429
              && result && !Array.isArray(result) && result.ok === false
              && Object.keys(result).length === 2 && ['busy', 'rate_limited'].includes(result.error)) {
              markPreDispatchRefusal(error, { reason: result.error, requestId,
                retryAfter: response.headers['retry-after'] });
            }
            finish(error); return;
          }
          finish(null, result);
        } catch { finish(failure('LUNA_INVALID_RESPONSE')); }
      });
    });
    deadline = setTimeout(() => { finish(failure('LUNA_RESPONSE_UNCERTAIN')); req.destroy(); }, 75_000);
    deadline.unref?.();
    req.on('error', () => finish(failure('LUNA_RESPONSE_UNCERTAIN')));
    req.end(contents);
  });
}

module.exports = { requestFundedLuna, MAX_REQUEST, MAX_RESPONSE };
