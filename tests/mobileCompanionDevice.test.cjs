const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createDeviceStore } = require('../electron/mobileCompanionDevice.cjs')
test('remembered device is a private nonexpiring digest and can be revoked', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'velorn-device-test-'))
  t.after(() => fs.rm(root,{recursive:true,force:true}))
  const filename = path.join(root,'device.json'); let now = 100
  const store = createDeviceStore(filename,() => now)
  assert.equal(await store.read(),null)
  await store.write({digest:'a'.repeat(64),expiresAt:200,token:'MUST-NOT-BE-SAVED'})
  assert.equal((await fs.stat(filename)).mode & 0o777,0o600)
  assert.equal((await fs.readFile(filename,'utf8')).includes('MUST-NOT'),false)
  assert.equal((await createDeviceStore(filename,() => now).read()).digest,'a'.repeat(64))
  now = 200; assert.equal((await store.read()).expiresAt,null)
  now = Number.MAX_SAFE_INTEGER; assert.equal((await store.read()).version,2)
  now = 100; await store.forget(); assert.equal(await store.read(),null)
  await store.forget()
})

test('legacy unexpired phone credentials remain readable but invalid or expired records do not', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'velorn-device-legacy-'))
  t.after(() => fs.rm(root,{recursive:true,force:true}))
  const filename = path.join(root,'device.json'), store = createDeviceStore(filename,() => 100)
  await fs.writeFile(filename, JSON.stringify({version:1,digest:'b'.repeat(64),expiresAt:200}))
  assert.equal((await store.read()).version,1)
  for (const record of [{version:1,digest:'b'.repeat(64),expiresAt:100}, {version:2,digest:'b'.repeat(64),expiresAt:200}, {version:2,digest:'raw-token',expiresAt:null}]) {
    await fs.writeFile(filename,JSON.stringify(record));assert.equal(await store.read(),null)
  }
  await assert.rejects(store.write({digest:'raw-token'}),/Invalid phone credential/)
})
