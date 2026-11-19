/* Shared Node/browser transport. It never retries application requests. */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) {
    const WebSocket = require('ws');
    module.exports = factory(require('./remoteCompanionCrypto.cjs'), url => new WebSocket(url, {
      perMessageDeflate: false, maxPayload: 1536 * 1024,
    }));
  } else root.VelornRemoteTransport = factory(root.VelornRemoteCrypto, url => new root.WebSocket(url));
}(typeof globalThis !== 'undefined' ? globalThis : this, function factory(crypto, defaultSocket) {
  'use strict';
  const LIMITS = Object.freeze({ frame: 1536 * 1024, queued: 4 * 1024 * 1024, pending: 8,
    request: 32 * 1024, response: 9 * 1024 * 1024, chunk: 128 * 1024, buffered: 2 * 1024 * 1024 });
  const encoder = new TextEncoder();
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const validId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(v);
  const error = (code, message) => Object.assign(new Error(message), { code });
  const unavailable = () => error('REMOTE_DISCONNECTED', 'Connection lost. Delivery may be uncertain; inspect Velorn before resending.');
  function endpoint(value, allowLocalTest) {
    const url = new URL(value);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'wss:' && !(allowLocalTest && local && url.protocol === 'ws:'))
      || url.username || url.password || url.hash || url.search || url.pathname !== '/relay') throw error('INVALID_ENDPOINT', 'Use a secure relay URL.');
    return url.href;
  }
  function createPeer({ role, url, roomId, token, secret, WebSocket, socketFactory,
    onReady, onClose, onRequest, allowLocalTest = false, reconnectMs = 1000, requestTimeoutMs = 45000 } = {}) {
    url = endpoint(url, allowLocalTest);
    if (!['desktop', 'phone'].includes(role) || !validId(roomId) || !validId(token)
      || !crypto.isPairingSecret(secret)) throw error('INVALID_CONFIG', 'Invalid remote connection configuration.');
    const makeSocket = socketFactory || (WebSocket ? value => new WebSocket(value) : defaultSocket);
    let stopped = true, socket = null, session = null, relaySession = null, ready = false, epoch = 0;
    let reconnect = null, deadline = null, attempts = 0, receiveTail = Promise.resolve(), sendTail = Promise.resolve(), queued = 0;
    let sentSince = Date.now(), sentBytes = 0;
    const pending = new Map(), active = new Map(), ignored = new Set();
    function notify(callback, value) { try { callback?.(value); } catch { /* UI cannot grant authority. */ } }
    function cleanRequests() {
      for (const record of pending.values()) { clearTimeout(record.timer); record.remove?.(); record.reject(unavailable()); }
      pending.clear(); ignored.clear();
      for (const record of active.values()) { clearTimeout(record.timer); record.controller.abort(); }
      active.clear();
    }
    function disconnect(reason = 'disconnected') {
      epoch++; ready = false;
      clearTimeout(deadline); deadline = null; clearTimeout(reconnect); reconnect = null;
      session?.destroy(); session = null; relaySession = null;
      const previous = socket; socket = null; cleanRequests();
      sendTail = receiveTail = Promise.resolve(); queued = 0;
      try { previous?.close(1000, 'Connection ended'); } catch { /* Already closed. */ }
      if (previous?.terminate) { const timer = setTimeout(() => previous.terminate(), 1000); timer.unref?.(); }
      notify(onClose, { reason });
      if (!stopped) {
        const wait = Math.min(30000, Math.max(20, reconnectMs) * (2 ** Math.min(attempts++, 5)));
        reconnect = setTimeout(connect, wait); reconnect.unref?.();
      }
    }
    function current(version) { return !stopped && version === epoch && socket?.readyState === 1; }
    function setDeadline(version) {
      clearTimeout(deadline);
      deadline = setTimeout(() => { if (version === epoch) disconnect('handshake-timeout'); }, 15000);
      deadline.unref?.();
    }
    async function raw(value, version) {
      if (!current(version)) throw unavailable();
      const text = JSON.stringify(value);
      const bytes = encoder.encode(text).length;
      if (bytes > LIMITS.frame) throw error('REMOTE_LIMIT', 'Remote frame is too large.');
      // Keep large snapshots below the relay's per-connection abuse limits.
      if (Date.now() - sentSince >= 1000) { sentSince = Date.now(); sentBytes = 0; }
      if (sentBytes + bytes > 3 * 1024 * 1024) {
        await new Promise(resolve => setTimeout(resolve, Math.max(1, 1000 - (Date.now() - sentSince))));
        if (!current(version)) throw unavailable();
        sentSince = Date.now(); sentBytes = 0;
      }
      const began = Date.now();
      while (socket.bufferedAmount > LIMITS.buffered) {
        if (Date.now() - began > 15000) throw unavailable();
        await new Promise(resolve => setTimeout(resolve, 10));
        if (!current(version)) throw unavailable();
      }
      sentBytes += bytes; socket.send(text);
    }
    function send(value, version) {
      const result = sendTail.then(async () => {
        if (!current(version) || !ready) throw unavailable();
        const payload = await session.encrypt(value);
        await raw({ type: 'frame', sessionId: relaySession, payload }, version);
      });
      sendTail = result.catch(() => { if (version === epoch) disconnect('send-failed'); });
      return result;
    }
    async function respond(id, value, version, record) {
      const text = JSON.stringify(value);
      if (typeof text !== 'string' || encoder.encode(text).length > LIMITS.response) throw error('REMOTE_LIMIT', 'Remote response is too large.');
      for (let offset = 0, part = 0; offset < text.length; offset += LIMITS.chunk, part++) {
        if (record.controller.signal.aborted) return;
        await send({ kind: 'response', id, part, last: offset + LIMITS.chunk >= text.length,
          text: text.slice(offset, offset + LIMITS.chunk) }, version);
      }
    }
    function application(value, version) {
      if (!object(value) || !validId(value.id)) throw error('REMOTE_PROTOCOL', 'Invalid remote message.');
      if (value.kind === 'cancel') {
        active.get(value.id)?.controller.abort(); return;
      }
      if (value.kind === 'request') {
        if (role !== 'desktop' || typeof onRequest !== 'function' || active.has(value.id)
          || active.size >= LIMITS.pending || encoder.encode(JSON.stringify(value)).length > LIMITS.request) throw error('REMOTE_PROTOCOL', 'Invalid remote request.');
        const record = { controller: new AbortController(), timer: null };
        record.timer = setTimeout(() => record.controller.abort(), requestTimeoutMs); record.timer.unref?.();
        active.set(value.id, record);
        Promise.resolve().then(() => {
          if (!current(version) || record.controller.signal.aborted) throw unavailable();
          return onRequest(value.input, { signal: record.controller.signal });
        })
          .catch(() => {
            // A handler may already have dispatched an action. Never fabricate
            // a negative HTTP receipt that would invite a duplicate edit.
            if (current(version)) disconnect('delivery-uncertain');
            return null;
          })
          .then(result => current(version) && !record.controller.signal.aborted ? respond(value.id, result, version, record) : undefined)
          .catch(() => { if (version === epoch) disconnect('response-failed'); })
          .finally(() => { clearTimeout(record.timer); if (active.get(value.id) === record) active.delete(value.id); });
        return;
      }
      if (value.kind !== 'response' || role !== 'phone') throw error('REMOTE_PROTOCOL', 'Unexpected remote message.');
      const record = pending.get(value.id);
      if (!record) { if (ignored.has(value.id)) return; throw error('REMOTE_PROTOCOL', 'Unknown remote response.'); }
      if (value.part !== record.part++ || typeof value.text !== 'string' || value.text.length > LIMITS.chunk
        || typeof value.last !== 'boolean') throw error('REMOTE_PROTOCOL', 'Invalid remote response fragment.');
      record.bytes += encoder.encode(value.text).length;
      if (record.bytes > LIMITS.response) throw error('REMOTE_LIMIT', 'Remote response is too large.');
      record.parts.push(value.text);
      if (value.last) {
        const result = JSON.parse(record.parts.join(''));
        pending.delete(value.id); clearTimeout(record.timer); record.remove?.(); record.resolve(result);
      }
    }
    async function receive(text, version) {
      if (!current(version)) return;
      const frame = JSON.parse(text);
      if (frame.type === 'authenticated' && frame.version === 1 && !session) {
        clearTimeout(deadline); deadline = null; return;
      }
      if (frame.type === 'peer-ready' && frame.version === 1 && validId(frame.sessionId) && !session) {
        relaySession = frame.sessionId;
        const next = await crypto.createSession({ role, secret });
        if (!current(version)) { next.destroy(); return; }
        session = next; setDeadline(version);
        await raw({ type: 'frame', sessionId: relaySession, payload: session.hello() }, version); return;
      }
      if (frame.type !== 'frame' || frame.sessionId !== relaySession || !session) throw error('REMOTE_PROTOCOL', 'Unexpected relay message.');
      if (frame.payload?.type === 'hello') {
        const payload = await session.acceptHello(frame.payload);
        await raw({ type: 'frame', sessionId: relaySession, payload }, version); return;
      }
      if (frame.payload?.type === 'proof') {
        await session.acceptProof(frame.payload);
        if (!current(version)) return;
        ready = true; attempts = 0; clearTimeout(deadline); deadline = null;
        notify(onReady); return;
      }
      const value = await session.decrypt(frame.payload);
      if (current(version)) application(value, version);
    }
    function connect() {
      if (stopped) return;
      const version = ++epoch;
      try { socket = makeSocket(url); } catch { disconnect('connect-failed'); return; }
      setDeadline(version);
      socket.addEventListener('open', () => {
        raw({ type: 'authenticate', version: 1, roomId, role, token }, version)
          .catch(() => { if (version === epoch) disconnect('authentication-failed'); });
      });
      socket.addEventListener('message', event => {
        if (version !== epoch) return;
        if (typeof event.data !== 'string' || event.data.length > LIMITS.frame) { disconnect('invalid-frame'); return; }
        const bytes = encoder.encode(event.data).length;
        if (bytes > LIMITS.frame || queued + bytes > LIMITS.queued) { disconnect('receive-limit'); return; }
        queued += bytes;
        receiveTail = receiveTail.then(() => receive(event.data, version)).catch(() => {
          if (version === epoch) disconnect('invalid-frame');
        }).finally(() => { if (version === epoch) queued -= bytes; });
      });
      socket.addEventListener('close', event => {
        if (version !== epoch) return;
        const reason = event.code === 4009 ? 'occupied'
          : event.code === 4003 ? 'authentication-failed' : 'disconnected';
        disconnect(reason);
      });
      socket.addEventListener('error', () => { if (version === epoch) disconnect('connection-error'); });
    }
    function request(input, { signal } = {}) {
      if (!ready || stopped || role !== 'phone') return Promise.reject(unavailable());
      if (signal?.aborted) return Promise.reject(error('ABORTED', 'Request cancelled.'));
      const id = crypto.createPairingSecret(), version = epoch, message = { kind: 'request', id, input };
      if (pending.size >= LIMITS.pending || encoder.encode(JSON.stringify(message)).length > LIMITS.request) return Promise.reject(error('REMOTE_LIMIT', 'Too many or oversized remote requests.'));
      return new Promise((resolve, reject) => {
        const record = { resolve, reject, parts: [], part: 0, bytes: 0, timer: null };
        const cancel = () => {
          if (!pending.delete(id)) return;
          clearTimeout(record.timer); record.remove?.();
          ignored.add(id); if (ignored.size > 64) ignored.delete(ignored.values().next().value);
          reject(error('REMOTE_UNCERTAIN', 'Request ended; delivery may be uncertain. Check the desktop before resending.'));
          void send({ kind: 'cancel', id }, version).catch(() => {});
        };
        record.remove = () => signal?.removeEventListener('abort', cancel);
        record.timer = setTimeout(cancel, requestTimeoutMs); record.timer.unref?.();
        signal?.addEventListener('abort', cancel, { once: true }); pending.set(id, record);
        void send(message, version).catch(() => { /* Disconnect rejects pending requests; never retry. */ });
      });
    }
    return Object.freeze({ start() { if (stopped) { stopped = false; connect(); } },
      close() { stopped = true; disconnect('closed'); }, request, get ready() { return ready; } });
  }
  return Object.freeze({ createPeer, endpoint, LIMITS });
}));
