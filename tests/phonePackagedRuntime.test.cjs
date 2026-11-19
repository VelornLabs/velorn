'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { desktopPhoneRuntime } = require('../electron/mobileCompanionRuntime.cjs')

const userData = path.resolve('/synthetic/install-profile')
const electronRoot = path.resolve('/synthetic/installation/resources/app.asar/electron')

test('packaged phone runtime is API-only and never resolves private client or legacy configuration', () => {
  const runtime = desktopPhoneRuntime({ isPackaged:true,userData,electronRoot })
  assert.deepEqual(runtime, {
    apiOnly:true, clientRoot:null,
    deviceStorePath:path.join(userData,'mobile-companion-device.json'),
    preferencePath:path.join(userData,'mobile-companion-preference.json'),
    guided:{configPath:null,statePath:path.join(userData,'phone-account.json'),devicesRoot:path.join(userData,'phone-account-devices')},
  })
  assert.equal(JSON.stringify(runtime).includes('velorn-mobile-lab'),false)
  assert.equal(JSON.stringify(runtime).includes('app.asar'),false,'Writable phone state stays outside the read-only application archive')
})

test('development keeps the accepted sibling client and per-profile legacy opt-in', () => {
  const root = path.resolve('/synthetic/projects/velorn-storyboard-lab/electron')
  const runtime = desktopPhoneRuntime({isPackaged:false,userData,electronRoot:root})
  assert.equal(runtime.apiOnly,false)
  assert.equal(runtime.clientRoot,path.resolve(root,'../../velorn-mobile-lab/dist'))
  assert.equal(runtime.guided.configPath,path.join(userData,'remote-companion.json'))
  assert.equal(runtime.guided.statePath,path.join(userData,'phone-account.json'))
})

test('installations never share account/device authority paths', () => {
  const first=desktopPhoneRuntime({isPackaged:true,userData:path.join(userData,'one'),electronRoot})
  const second=desktopPhoneRuntime({isPackaged:true,userData:path.join(userData,'two'),electronRoot})
  for (const field of ['deviceStorePath','preferencePath']) assert.notEqual(first[field],second[field])
  for (const field of ['statePath','devicesRoot']) assert.notEqual(first.guided[field],second.guided[field])
  assert.equal(first.guided.configPath,null)
  assert.equal(second.guided.configPath,null)
})

test('runtime requires explicit packaged state and absolute trusted host paths', () => {
  for (const isPackaged of [undefined,null,0,1,'false','true',{}]) {
    assert.throws(()=>desktopPhoneRuntime({isPackaged,userData,electronRoot}),/runtime paths/)
  }
  for (const bad of [undefined,null,'','relative/profile',23,{}]) {
    assert.throws(()=>desktopPhoneRuntime({isPackaged:true,userData:bad,electronRoot}),/runtime paths/)
    assert.throws(()=>desktopPhoneRuntime({isPackaged:true,userData,electronRoot:bad}),/runtime paths/)
  }
})

test('runtime values are independently constructed and contain no baked credentials or enrollment', () => {
  const options={isPackaged:true,userData,electronRoot}
  const first=desktopPhoneRuntime(options)
  first.guided.statePath='changed by caller'
  assert.equal(desktopPhoneRuntime(options).guided.statePath,path.join(userData,'phone-account.json'))
  assert.deepEqual(Object.keys(desktopPhoneRuntime(options)).sort(),['apiOnly','clientRoot','deviceStorePath','guided','preferencePath'])
  assert.deepEqual(Object.keys(desktopPhoneRuntime(options).guided).sort(),['configPath','devicesRoot','statePath'])
})
