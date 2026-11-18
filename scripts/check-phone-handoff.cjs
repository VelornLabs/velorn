/* Standard native/browser WebCrypto interop; synthetic only, no live service. */
'use strict';
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const helper = require('../electron/remoteCompanionHandoff.cjs');
(async () => {
  const source = await fs.readFile(require.resolve('../electron/remoteCompanionHandoff.cjs'));
  const server = http.createServer((req,res) => {
    res.setHeader('Cache-Control','no-store');
    if(req.url === '/helper.js'){res.setHeader('Content-Type','text/javascript');res.end(source);}
    else {res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Synthetic handoff check</title><script src="/helper.js"></script>');}
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const publicKey = await page.evaluate(async()=>{window.fixturePair=await VelornPhoneHandoff.createRequestKey();return fixturePair.publicKey;});
    const requestId='r'.repeat(24),computerId='c'.repeat(32);
    const payload={v:1,requestId,computerId,deviceId:'d'.repeat(32),bundle:{v:1,url:'wss://synthetic.example.test/relay',roomId:'m'.repeat(32),token:'t'.repeat(43),secret:'s'.repeat(43)},nativeToken:'a'.repeat(64)};
    const envelope = await helper.seal({publicKey,payload,requestId,computerId});
    const result=await page.evaluate(async ({envelope,requestId,computerId})=>{
      let exportRejected=false,wrongScopeRejected=false;
      try{await crypto.subtle.exportKey('jwk',fixturePair.privateKey);}catch{exportRejected=true;}
      try{await VelornPhoneHandoff.open({privateKey:fixturePair.privateKey,envelope,requestId:'z'.repeat(24),computerId});}catch{wrongScopeRejected=true;}
      return {payload:await VelornPhoneHandoff.open({privateKey:fixturePair.privateKey,envelope,requestId,computerId}),
        fingerprint:await VelornPhoneHandoff.fingerprint(fixturePair.publicKey),exportRejected,wrongScopeRejected};
    },{envelope,requestId,computerId});
    assert.deepEqual(result.payload,payload);assert.equal(result.fingerprint,await helper.fingerprint(publicKey));
    assert.equal(result.exportRejected,true);assert.equal(result.wrongScopeRejected,true);
    const nativePair=await helper.createRequestKey();
    const reverse=await page.evaluate(async args=>VelornPhoneHandoff.seal(args),{publicKey:nativePair.publicKey,payload,requestId,computerId});
    assert.deepEqual(await helper.open({privateKey:nativePair.privateKey,envelope:reverse,requestId,computerId}),payload);
    console.log('PASS: Chromium/native encrypted handoff in both directions, nonextractable private key, matching fingerprint and rejected wrong scope');
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
