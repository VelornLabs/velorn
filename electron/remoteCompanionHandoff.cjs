'use strict';
// Standard WebCrypto RSA-OAEP/SHA-256 + AES-256-GCM envelope for a one-time
// native-approved phone handoff. https://www.w3.org/TR/WebCryptoAPI/
// This module is also staged for the browser; private keys remain in memory.
(function expose(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('node:crypto').webcrypto);
  else root.VelornPhoneHandoff = factory(root.crypto);
}(typeof globalThis === 'undefined' ? this : globalThis, function createHandoff(crypto) {
  const ALG = 'RSA-OAEP-256+A256GCM', encoder = new TextEncoder();
  const ID = /^[A-Za-z0-9_-]{16,128}$/, TOKEN = /^[A-Za-z0-9_-]{43}$/;
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const failure = () => new Error('The approved phone connection could not be verified. Request a new connection.');
  function bytes(value, length, max = length) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(max * 4 / 3)) throw failure();
    const text = value.replaceAll('-', '+').replaceAll('_', '/');
    let result;
    if (typeof Buffer !== 'undefined') result = new Uint8Array(Buffer.from(text, 'base64'));
    else result = Uint8Array.from(atob(text + '='.repeat((4 - text.length % 4) % 4)), char => char.charCodeAt(0));
    if (result.length < length || result.length > max || encode(result) !== value) throw failure();
    return result;
  }
  function encode(value) {
    const data = new Uint8Array(value);
    const text = typeof Buffer !== 'undefined' ? Buffer.from(data).toString('base64') : btoa(String.fromCharCode(...data));
    return text.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  }
  function validatePublicKey(key) {
    if (!object(key) || Object.keys(key).some(name => !['kty','n','e','alg','ext','key_ops'].includes(name)) ||
        key.kty !== 'RSA' || key.e !== 'AQAB' || (key.alg !== undefined && key.alg !== 'RSA-OAEP-256') ||
        (key.ext !== undefined && key.ext !== true) ||
        (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== 'encrypt'))) throw failure();
    const modulus = bytes(key.n, 384);
    if (modulus[0] < 128 || !(modulus[383] & 1)) throw failure();
    return { kty: 'RSA', n: key.n, e: 'AQAB', alg: 'RSA-OAEP-256', ext: true, key_ops: ['encrypt'] };
  }
  function context(requestId, computerId) {
    if (!ID.test(requestId || '') || !ID.test(computerId || '')) throw failure();
    return encoder.encode(JSON.stringify(['velorn-phone-handoff', 1, requestId, computerId]));
  }
  function validatePayload(payload, requestId, computerId) {
    if (!exact(payload, ['v','requestId','computerId','deviceId','bundle','nativeToken']) || payload.v !== 1 ||
        payload.requestId !== requestId || payload.computerId !== computerId || !ID.test(payload.deviceId || '') ||
        !/^[a-f0-9]{64}$/.test(payload.nativeToken || '')) throw failure();
    const bundle = payload.bundle;
    if (!exact(bundle, ['v','url','roomId','token','secret']) || bundle.v !== 1 || !ID.test(bundle.roomId || '') ||
        !TOKEN.test(bundle.token || '') || !TOKEN.test(bundle.secret || '') || typeof bundle.url !== 'string' || bundle.url.length > 512) throw failure();
    const url = new URL(bundle.url), local = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/relay' ||
        (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && local))) throw failure();
    return payload;
  }
  async function createRequestKey() {
    const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
    return { publicKey: validatePublicKey(await crypto.subtle.exportKey('jwk', pair.publicKey)), privateKey: pair.privateKey };
  }
  async function fingerprint(publicKey) {
    const key = validatePublicKey(publicKey);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([key.kty,key.n,key.e]))));
    const value = new DataView(hash.buffer).getUint32(0, false) % 1_000_000;
    return String(value).padStart(6, '0');
  }
  async function seal({ publicKey, payload, requestId, computerId }) {
    try {
      const aad = context(requestId, computerId), key = validatePublicKey(publicKey);
      validatePayload(payload, requestId, computerId);
      const plaintext = encoder.encode(JSON.stringify(payload)); if (plaintext.length > 2048) throw failure();
      const recipient = await crypto.subtle.importKey('jwk', key, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
      const rawKey = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
      try {
        const aes = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
        const [wrapped, ciphertext] = await Promise.all([
          crypto.subtle.encrypt({ name: 'RSA-OAEP' }, recipient, rawKey),
          crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, aes, plaintext),
        ]);
        return { v: 1, alg: ALG, wrappedKey: encode(wrapped), iv: encode(iv), ciphertext: encode(ciphertext) };
      } finally { rawKey.fill(0); plaintext.fill(0); }
    } catch { throw failure(); }
  }
  async function open({ privateKey, envelope, requestId, computerId }) {
    let rawKey, plaintext;
    try {
      const aad = context(requestId, computerId);
      if (!exact(envelope, ['v','alg','wrappedKey','iv','ciphertext']) || envelope.v !== 1 || envelope.alg !== ALG ||
          privateKey?.type !== 'private' || privateKey.extractable !== false || privateKey.algorithm?.name !== 'RSA-OAEP' ||
          privateKey.algorithm?.modulusLength !== 3072 || privateKey.algorithm?.hash?.name !== 'SHA-256') throw failure();
      const wrapped = bytes(envelope.wrappedKey, 384), iv = bytes(envelope.iv, 12), ciphertext = bytes(envelope.ciphertext, 17, 2064);
      rawKey = new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, wrapped));
      if (rawKey.length !== 32) throw failure();
      const aes = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
      plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, aes, ciphertext));
      return validatePayload(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)), requestId, computerId);
    } catch { throw failure(); }
    finally { rawKey?.fill(0); plaintext?.fill(0); }
  }
  return Object.freeze({ createRequestKey, fingerprint, validatePublicKey, seal, open, ALG });
}));
