/* The same source is served as a browser script; do not add Node-only imports in the factory. */
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('node:crypto').webcrypto);
  } else {
    root.VelornRemoteCrypto = factory(root.crypto);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createApi(crypto) {
  'use strict';

  const VERSION = 1;
  const DOMAIN = 'velorn-remote-companion';
  const SUITE = 'AES-256-GCM/HKDF-SHA-256/HMAC-SHA-256';
  const MAX_PLAINTEXT_BYTES = 1024 * 1024;
  const MAX_CIPHERTEXT_CHARS = Math.ceil((MAX_PLAINTEXT_BYTES + 16) * 4 / 3);
  // A transport must enforce this before JSON.parse, as well as its own queue bounds.
  const MAX_FRAME_BYTES = MAX_CIPHERTEXT_CHARS + 512;
  const MAX_MESSAGES = 0x100000000;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function requireCrypto() {
    if (!crypto || !crypto.subtle || typeof crypto.getRandomValues !== 'function') {
      throw fail('CRYPTO_UNAVAILABLE', 'Secure Web Crypto is unavailable. Use HTTPS or localhost.');
    }
  }

  function encode(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function decode(value, { bytes, maxChars } = {}) {
    if (typeof value !== 'string' || value.length === 0 ||
        value.length > (maxChars || Math.ceil(bytes * 4 / 3)) ||
        !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
      throw fail('INVALID_FRAME', 'Invalid remote encoded value.');
    }
    let binary;
    try {
      binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    } catch {
      throw fail('INVALID_FRAME', 'Invalid remote encoded value.');
    }
    const result = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if ((bytes !== undefined && result.length !== bytes) || encode(result) !== value) {
      throw fail('INVALID_FRAME', 'Invalid remote encoded value.');
    }
    return result;
  }

  function record(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
      throw fail('INVALID_FRAME', 'Invalid remote frame shape.');
    }
  }

  function canonical(parts) {
    return encoder.encode(JSON.stringify(parts));
  }

  function nonce(sequence) {
    const iv = new Uint8Array(12);
    // Each connection and direction has a distinct key. Never reset this counter.
    new DataView(iv.buffer).setUint32(8, sequence, false);
    return iv;
  }

  function createPairingSecret() {
    requireCrypto();
    return encode(crypto.getRandomValues(new Uint8Array(32)));
  }

  function isPairingSecret(secret) {
    try { decode(secret, { bytes: 32 }); return true; } catch { return false; }
  }

  async function createSession({ role, secret } = {}) {
    requireCrypto();
    if (role !== 'desktop' && role !== 'phone') throw fail('INVALID_ROLE', 'Invalid remote endpoint role.');
    let secretBytes;
    try { secretBytes = decode(secret, { bytes: 32 }); } catch {
      throw fail('INVALID_SECRET', 'Pairing requires a randomly generated 32-byte secret.');
    }
    let baseKey;
    try {
      baseKey = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveKey']);
    } finally {
      secretBytes.fill(0);
    }
    const peerRole = role === 'desktop' ? 'phone' : 'desktop';
    const challenge = createPairingSecret();
    const localHello = Object.freeze({ v: VERSION, type: 'hello', role, challenge });
    let phase = 'new';
    let sessionId = null;
    let localProofKey = null;
    let peerProofKey = null;
    let encryptKey = null;
    let decryptKey = null;
    let sendSequence = 0;
    let receiveSequence = 0;
    let tail = Promise.resolve();

    function destroy() {
      phase = 'closed';
      baseKey = localProofKey = peerProofKey = encryptKey = decryptKey = null;
    }

    function ensureOpen() {
      if (phase === 'closed') throw fail('SESSION_CLOSED', 'Remote session is closed. Reconnect with a fresh session.');
    }

    // Serialize cryptographic state transitions, including simultaneous encrypt/decrypt calls.
    // Any protocol/crypto failure is terminal, so queued work cannot reuse a consumed nonce.
    function operation(callback) {
      const result = tail.then(async () => {
        ensureOpen();
        try { return await callback(); } catch (error) { destroy(); throw error; }
      });
      tail = result.catch(() => {});
      return result;
    }

    async function derive(label, sender, algorithm, usages, salt) {
      return crypto.subtle.deriveKey({
        name: 'HKDF', hash: 'SHA-256', salt,
        info: canonical([DOMAIN, VERSION, SUITE, label, sender]),
      }, baseKey, algorithm, false, usages);
    }

    function proofBytes(sender) {
      return canonical([DOMAIN, VERSION, SUITE, 'proof', sender, sessionId]);
    }

    function additionalData(sender, sequence) {
      return canonical([DOMAIN, VERSION, SUITE, 'data', sessionId, sender, sequence]);
    }

    return Object.freeze({
      role,
      get ready() { return phase === 'ready'; },
      get sessionId() { return sessionId; },
      hello() { ensureOpen(); return localHello; },
      acceptHello(peerHello) {
        return operation(async () => {
          if (phase !== 'new') throw fail('INVALID_STATE', 'A connection accepts exactly one remote hello.');
          record(peerHello, ['v', 'type', 'role', 'challenge']);
          if (peerHello.v !== VERSION || peerHello.type !== 'hello' || peerHello.role !== peerRole) {
            throw fail('INVALID_FRAME', 'Invalid remote hello role or version.');
          }
          const peerChallenge = peerHello.challenge;
          decode(peerChallenge, { bytes: 32 });
          if (peerChallenge === challenge) throw fail('AUTH_FAILED', 'Reflected remote challenge.');
          const desktopChallenge = role === 'desktop' ? challenge : peerChallenge;
          const phoneChallenge = role === 'phone' ? challenge : peerChallenge;
          const transcript = canonical([DOMAIN, VERSION, SUITE, 'desktop', desktopChallenge, 'phone', phoneChallenge]);
          const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', transcript));
          sessionId = encode(salt);
          const hmac = { name: 'HMAC', hash: 'SHA-256', length: 256 };
          const aes = { name: 'AES-GCM', length: 256 };
          const keys = await Promise.all([
            derive('proof', role, hmac, ['sign'], salt),
            derive('proof', peerRole, hmac, ['verify'], salt),
            derive('data', role, aes, ['encrypt'], salt),
            derive('data', peerRole, aes, ['decrypt'], salt),
          ]);
          ensureOpen();
          [localProofKey, peerProofKey, encryptKey, decryptKey] = keys;
          const proof = encode(new Uint8Array(await crypto.subtle.sign('HMAC', localProofKey, proofBytes(role))));
          ensureOpen();
          baseKey = localProofKey = null;
          phase = 'proof';
          return Object.freeze({ v: VERSION, type: 'proof', role, sessionId, proof });
        });
      },
      acceptProof(peerProof) {
        return operation(async () => {
          if (phase !== 'proof') throw fail('INVALID_STATE', 'Remote proof is unexpected.');
          record(peerProof, ['v', 'type', 'role', 'sessionId', 'proof']);
          if (peerProof.v !== VERSION || peerProof.type !== 'proof' || peerProof.role !== peerRole || peerProof.sessionId !== sessionId) {
            throw fail('AUTH_FAILED', 'Remote handshake authentication failed.');
          }
          const signature = decode(peerProof.proof, { bytes: 32 });
          const valid = await crypto.subtle.verify('HMAC', peerProofKey, signature, proofBytes(peerRole));
          ensureOpen();
          if (!valid) throw fail('AUTH_FAILED', 'Remote handshake authentication failed.');
          peerProofKey = null;
          phase = 'ready';
          return true;
        });
      },
      encrypt(value) {
        return operation(async () => {
          if (phase !== 'ready') throw fail('NOT_READY', 'Remote peer is not authenticated.');
          const json = JSON.stringify(value);
          if (typeof json !== 'string' || json.length > MAX_PLAINTEXT_BYTES) {
            throw fail('PAYLOAD_TOO_LARGE', 'Remote payload must be bounded JSON.');
          }
          const plaintext = encoder.encode(json);
          if (plaintext.length > MAX_PLAINTEXT_BYTES) throw fail('PAYLOAD_TOO_LARGE', 'Remote payload is too large.');
          if (sendSequence >= MAX_MESSAGES) throw fail('KEY_EXHAUSTED', 'Reconnect before sending more remote data.');
          const seq = sendSequence++;
          const ciphertext = await crypto.subtle.encrypt({
            name: 'AES-GCM', iv: nonce(seq), tagLength: 128, additionalData: additionalData(role, seq),
          }, encryptKey, plaintext);
          ensureOpen();
          return Object.freeze({ v: VERSION, type: 'data', sessionId, role, seq, ciphertext: encode(new Uint8Array(ciphertext)) });
        });
      },
      decrypt(frame) {
        return operation(async () => {
          if (phase !== 'ready') throw fail('NOT_READY', 'Remote peer is not authenticated.');
          record(frame, ['v', 'type', 'sessionId', 'role', 'seq', 'ciphertext']);
          if (frame.v !== VERSION || frame.type !== 'data' || frame.sessionId !== sessionId || frame.role !== peerRole) {
            throw fail('AUTH_FAILED', 'Remote frame belongs to a different connection or direction.');
          }
          const sequence = frame.seq;
          if (!Number.isSafeInteger(sequence) || Object.is(sequence, -0) || sequence < 0 ||
              sequence >= MAX_MESSAGES || sequence !== receiveSequence) {
            throw fail('INVALID_SEQUENCE', 'Remote frame was repeated, missing, or out of order.');
          }
          const ciphertext = decode(frame.ciphertext, { maxChars: MAX_CIPHERTEXT_CHARS });
          if (ciphertext.length < 16 || ciphertext.length > MAX_PLAINTEXT_BYTES + 16) {
            throw fail('INVALID_FRAME', 'Remote ciphertext has an invalid size.');
          }
          let plaintext;
          try {
            plaintext = await crypto.subtle.decrypt({
              name: 'AES-GCM', iv: nonce(sequence), tagLength: 128,
              additionalData: additionalData(peerRole, sequence),
            }, decryptKey, ciphertext);
          } catch {
            throw fail('AUTH_FAILED', 'Remote frame authentication failed.');
          }
          ensureOpen();
          let value;
          try { value = JSON.parse(decoder.decode(plaintext)); } catch {
            throw fail('INVALID_FRAME', 'Remote plaintext is not valid UTF-8 JSON.');
          }
          receiveSequence++;
          return value;
        });
      },
      destroy,
    });
  }

  return Object.freeze({ VERSION, MAX_PLAINTEXT_BYTES, MAX_FRAME_BYTES, MAX_MESSAGES,
    createPairingSecret, isPairingSecret, createSession });
}));
