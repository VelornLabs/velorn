'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {createMobileCompanionPreference} = require('../electron/mobileCompanionPreference.cjs')

test('phone opt-in persists privately and serializes stop after enable',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-phone-preference-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const file=path.join(root,'phone.json'),store=createMobileCompanionPreference(file)
  assert.equal(await store.read(),false)
  await Promise.all([store.write(true),store.write(false)])
  assert.equal(await store.read(),false)
  await store.write(true)
  assert.equal(await createMobileCompanionPreference(file).read(),true)
  assert.equal((await fs.stat(file)).mode&0o777,0o600)
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{version:1,enabled:true})
})

test('malformed/future preferences report failure rather than enable sharing',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'velorn-phone-preference-invalid-'))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const file=path.join(root,'phone.json'),store=createMobileCompanionPreference(file)
  for(const text of ['broken','{"version":2,"enabled":true}','{"version":1,"enabled":"true"}','x'.repeat(2049)]) {
    await fs.writeFile(file,text);await assert.rejects(store.read())
  }
})
