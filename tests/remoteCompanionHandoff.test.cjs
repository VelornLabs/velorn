const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
const helper = require('../electron/remoteCompanionHandoff.cjs');
const requestId = 'r'.repeat(24), computerId = 'c'.repeat(32);
const payload = {v:1,requestId,computerId,deviceId:'d'.repeat(32),bundle:{v:1,url:'wss://connect.example.test/relay',roomId:'m'.repeat(32),token:'t'.repeat(43),secret:'s'.repeat(43)},nativeToken:'a'.repeat(64)};
let pair, envelope;
test.before(async () => { pair = await helper.createRequestKey(); envelope = await helper.seal({publicKey:pair.publicKey,payload,requestId,computerId}); });
test('RSA private handoff key is nonextractable and successful envelope reveals no plaintext credential', async () => {
  assert.equal(pair.privateKey.extractable,false);
  await assert.rejects(webcrypto.subtle.exportKey('jwk',pair.privateKey));
  assert.deepEqual(await helper.open({privateKey:pair.privateKey,envelope,requestId,computerId}),payload);
  const serialized=JSON.stringify(envelope);
  for(const value of [payload.bundle.token,payload.bundle.secret,payload.nativeToken])assert.ok(!serialized.includes(value));
  assert.match(await helper.fingerprint(pair.publicKey),/^\d{6}$/);
});
test('request, computer, recipient and authenticated ciphertext are bound', async () => {
  const other=await helper.createRequestKey();
  for(const options of [{requestId:'z'.repeat(24)}, {computerId:'q'.repeat(32)}, {privateKey:other.privateKey},
    {envelope:{...envelope,iv:'a'.repeat(16)}}, {envelope:{...envelope,ciphertext:(envelope.ciphertext[0]==='a'?'b':'a')+envelope.ciphertext.slice(1)}}]) {
    await assert.rejects(helper.open({privateKey:pair.privateKey,envelope,requestId,computerId,...options}));
  }
});
test('input key and envelope bounds reject private JWK fields, wrong algorithms and malformed values', async () => {
  for(const key of [{...pair.publicKey,d:'secret'},{...pair.publicKey,alg:'RSA1_5'},{...pair.publicKey,n:'a'.repeat(512)},{...pair.publicKey,key_ops:['decrypt']}]) {
    assert.throws(()=>helper.validatePublicKey(key));
  }
  for(const value of [{...envelope,extra:true},{...envelope,alg:'none'},{...envelope,wrappedKey:envelope.wrappedKey+'='},{...envelope,ciphertext:'a'.repeat(5000)}]) {
    await assert.rejects(helper.open({privateKey:pair.privateKey,envelope:value,requestId,computerId}));
  }
  await assert.rejects(helper.seal({publicKey:pair.publicKey,payload:{...payload,nativeToken:'bad'},requestId,computerId}));
});
test('browser UMD runtime without Buffer and native helper interoperate in both directions', async () => {
  const sandbox={crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,DataView,URL,atob,btoa};
  vm.runInNewContext(fs.readFileSync(require.resolve('../electron/remoteCompanionHandoff.cjs'),'utf8'),sandbox);
  const browser=sandbox.VelornPhoneHandoff;
  assert.equal(await browser.fingerprint(pair.publicKey),await helper.fingerprint(pair.publicKey));
  assert.equal(JSON.stringify(await browser.open({privateKey:pair.privateKey,envelope,requestId,computerId})),JSON.stringify(payload));
  const browserPair=await browser.createRequestKey();
  const browserEnvelope=await browser.seal({publicKey:browserPair.publicKey,payload,requestId,computerId});
  assert.deepEqual(await helper.open({privateKey:browserPair.privateKey,envelope:browserEnvelope,requestId,computerId}),payload);
});
