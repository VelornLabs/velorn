'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { VC_RUNTIME_FILES, engineFolder, isX64Program, findVcRuntimeSource, stageVcRuntime, verifyVcRuntime } = require('../scripts/windows-vc-runtime.cjs')

// The smallest thing that looks like a Windows program file for a given machine.
function program(machine = 0x8664) {
  const data = Buffer.alloc(0x80)
  data.write('MZ', 0, 'latin1'); data.writeUInt32LE(0x40, 0x3c)
  data.write('PE\0\0', 0x40, 'latin1'); data.writeUInt16LE(machine, 0x44)
  return data
}
function folder(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-vc-runtime-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function fill(dir, names = VC_RUNTIME_FILES, data = program()) { fs.mkdirSync(dir, { recursive: true }); for (const name of names) fs.writeFileSync(path.join(dir, name), data); return dir }
function packedApp(root) {
  const resourcesPath = path.join(root, 'resources')
  fill(engineFolder(resourcesPath), ['onnxruntime_binding.node', 'onnxruntime.dll'])
  return resourcesPath
}

test('the list matches what the shipped song engine imports from the Visual C++ runtime', () => {
  // Read the real engine files' import tables. objdump is on Linux and macOS build machines; skip where it is not.
  const dir = path.join(__dirname, '..', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64')
  const needed = new Set()
  for (const name of ['onnxruntime_binding.node', 'onnxruntime.dll']) {
    let listing
    try { listing = execFileSync('objdump', ['-p', path.join(dir, name)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return }
    for (const match of listing.matchAll(/DLL Name:\s*(\S+)/g)) if (/^(msvcp|vcruntime|concrt|vccorlib)\d/i.test(match[1])) needed.add(match[1].toLowerCase())
  }
  if (!needed.size) return
  assert.deepEqual([...needed].sort(), [...VC_RUNTIME_FILES].sort())
})

test('only a 64-bit Windows program file counts', t => {
  const root = folder(t)
  const good = path.join(root, 'good.dll'), wrong = path.join(root, 'x86.dll'), text = path.join(root, 'text.dll')
  fs.writeFileSync(good, program()); fs.writeFileSync(wrong, program(0x14c)); fs.writeFileSync(text, 'not a program')
  assert.equal(isX64Program(good), true)
  assert.equal(isX64Program(wrong), false)
  assert.equal(isX64Program(text), false)
  assert.equal(isX64Program(path.join(root, 'absent.dll')), false)
})

test('the runtime files are copied beside the engine and the package then passes', t => {
  const root = folder(t), resourcesPath = packedApp(root), sourceDir = fill(path.join(root, 'redist'))
  assert.throws(() => verifyVcRuntime({ resourcesPath }), /lacks Visual C\+\+ runtime files[^]*msvcp140\.dll/)
  const target = stageVcRuntime({ resourcesPath, sourceDir })
  assert.equal(target, engineFolder(resourcesPath))
  for (const name of VC_RUNTIME_FILES) assert.equal(isX64Program(path.join(target, name)), true)
  assert.equal(verifyVcRuntime({ resourcesPath }), target)
})

test('a build without the runtime files, or without the engine, stops instead of shipping', t => {
  const root = folder(t), resourcesPath = packedApp(root)
  assert.throws(() => stageVcRuntime({ resourcesPath, sourceDir: null }), /were not found on this build machine/)
  const partial = fill(path.join(root, 'partial'), VC_RUNTIME_FILES.slice(1))
  assert.throws(() => stageVcRuntime({ resourcesPath, sourceDir: partial }), /were not found on this build machine/)
  const x86 = fill(path.join(root, 'x86'), VC_RUNTIME_FILES, program(0x14c))
  assert.throws(() => stageVcRuntime({ resourcesPath, sourceDir: x86 }), /were not found on this build machine/)
  const empty = path.join(root, 'empty-resources')
  assert.throws(() => stageVcRuntime({ resourcesPath: empty, sourceDir: fill(path.join(root, 'redist')) }), /song engine was not found/)
  assert.throws(() => verifyVcRuntime({ resourcesPath: empty }), /song engine is missing/)
  // One file lost after staging is caught by the final check.
  stageVcRuntime({ resourcesPath, sourceDir: path.join(root, 'redist') })
  fs.rmSync(path.join(engineFolder(resourcesPath), 'vcruntime140_1.dll'))
  assert.throws(() => verifyVcRuntime({ resourcesPath }), /vcruntime140_1\.dll/)
})

test('the source is the newest complete Visual Studio redist folder, or the folder named by hand', t => {
  const root = folder(t), studio = path.join(root, 'VS'), redist = path.join(studio, 'VC', 'Redist', 'MSVC')
  fill(path.join(redist, '14.38.33135', 'x64', 'Microsoft.VC143.CRT'))
  const newest = fill(path.join(redist, '14.44.35112', 'x64', 'Microsoft.VC143.CRT'))
  fill(path.join(redist, '14.50.1', 'x64', 'Microsoft.VC143.CRT'), VC_RUNTIME_FILES.slice(2)) // Incomplete: passed over.
  fs.mkdirSync(path.join(redist, 'v143'), { recursive: true })
  const calls = []
  const execFileSyncImpl = (file, args) => { calls.push([file, args]); return `${studio}\r\n` }
  assert.equal(findVcRuntimeSource({ env: { 'ProgramFiles(x86)': path.join(root, 'pf86') }, execFileSyncImpl }), newest)
  assert.match(calls[0][0], /vswhere\.exe$/)
  // No Visual Studio at all.
  assert.equal(findVcRuntimeSource({ env: {}, execFileSyncImpl: () => { throw new Error('ENOENT') } }), null)
  // A folder named by hand wins, and an incomplete one is refused rather than replaced by a guess.
  const byHand = fill(path.join(root, 'hand'))
  const never = () => { throw new Error('must not look further') }
  assert.equal(findVcRuntimeSource({ env: { VELORN_VC_REDIST_DIR: byHand }, execFileSyncImpl: never }), byHand)
  assert.equal(findVcRuntimeSource({ env: { VELORN_VC_REDIST_DIR: path.join(root, 'nothing') }, execFileSyncImpl: never }), null)
})
