'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const path = require('node:path')
const { createLmStudioSetupRuntime, parseRows } = require('../electron/lmStudioSetupRuntime.cjs')
const home = path.resolve('/synthetic/lm-user')
function fixture(outputs = [], overrides = {}) {
  const calls = []
  const runtime = createLmStudioSetupRuntime({ getHomePath: () => home, platform: 'darwin',
    fs: { realpath: async p => p, stat: async () => ({ isFile: () => true, size: 123, mode: 0o100755 }) },
    env: { HOME: '/wrong', PATH: '/untrusted', NODE_OPTIONS: '--require bad', LMS_SERVER_HOST: '0.0.0.0', LM_STUDIO_API_TOKEN: 'private-fixture', HTTPS_PROXY: 'private-fixture' },
    run: (exe, argv, options, callback) => { calls.push({ exe, argv, options }); callback(null, outputs.shift() || '') }, ...overrides })
  return { runtime, calls }
}
const row = (extra = {}) => ({ type: 'llm', modelKey: 'qwen/qwen3-8b', path: 'publisher/repo/model.gguf', sizeBytes: 1024, deviceIdentifier: null, ...extra })
test('inspection is passive and discovers only the standard installed helper', async () => {
  const f = fixture(); assert.equal((await f.runtime.inspect()).available, true); assert.equal(f.calls.length, 0)
  assert.equal((await fixture([], { fs: { realpath: async () => { throw Error('missing') } } }).runtime.inspect()).available, false)
})
test('approved startup requires bind support and uses fixed loopback argv with sanitized environment', async () => {
  const f = fixture(['--bind <address> --port <port>', 'started']); await f.runtime.startServer()
  assert.deepEqual(f.calls[1].argv, ['server', 'start', '--port', '1234', '--bind', '127.0.0.1'])
  assert.equal(f.calls[1].options.shell, false)
  assert.equal(f.calls[1].options.env.HOME, home)
  for (const key of ['NODE_OPTIONS', 'LMS_SERVER_HOST', 'LM_STUDIO_API_TOKEN', 'HTTPS_PROXY']) assert.equal(f.calls[1].options.env[key], undefined)
  const old = fixture(['--port <port>']); await assert.rejects(old.runtime.startServer(), /loopback/); assert.equal(old.calls.length, 1)
})
test('downloaded-model identity comes from local CLI JSON, never display labels or remote devices', async () => {
  const f = fixture([JSON.stringify([row(), row({ deviceIdentifier: 'remote', modelKey: 'remote' })])])
  assert.deepEqual(await f.runtime.listDownloadedModels(), [{ path: 'publisher/repo/model.gguf', modelKey: 'qwen/qwen3-8b', sizeBytes: 1024, type: 'llm' }])
  assert.deepEqual(f.calls[0].argv, ['ls', '--json', '--host', '127.0.0.1', '--port', '1234'])
})
test('server start rechecks native authority after awaited helper inspection and fails closed for async guards', async () => {
  let busy = false, inspected = 0
  const f = fixture(['--bind <address> --port <port>'], { fs: {
    realpath: async p => p, stat: async () => { if (++inspected === 2) busy = true; return { isFile: () => true, size: 123, mode: 0o100755 } },
  } })
  await assert.rejects(f.runtime.startServer({ beforeStart: () => { if (busy) throw Error('export started') } }))
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].argv.at(-1), '--help')
  const asyncGuard = fixture(['--bind --port'])
  await assert.rejects(asyncGuard.runtime.startServer({ beforeStart: async () => {} }))
  assert.equal(asyncGuard.calls.length, 1)
})
test('grouped variants are expanded and checked against the listed exact keys', async () => {
  const f = fixture([JSON.stringify([row({ variants: ['qwen/qwen3-8b@q4'] })]), JSON.stringify([row({ modelKey: 'qwen/qwen3-8b@q4' })])])
  assert.equal((await f.runtime.listDownloadedModels())[0].modelKey, 'qwen/qwen3-8b@q4')
  const bad = fixture([JSON.stringify([row({ variants: ['exact'] })]), JSON.stringify([row({ modelKey: 'wrong' })])])
  await assert.rejects(bad.runtime.listDownloadedModels(), /mismatched/)
})
test('malformed paths, missing identities, invalid JSON and oversized model lists fail closed', async () => {
  for (const value of [null, { models: [] }, [row({ path: '../escape.gguf' })], [row({ path: '/absolute.gguf' })], [row({ modelKey: '' })], [row({ sizeBytes: -1 })]]) assert.throws(() => parseRows(value))
  await assert.rejects(fixture(['not json']).runtime.listDownloadedModels(), /machine-readable/)
  assert.throws(() => parseRows(Array(2049).fill(row())), /unsupported/)
})
test('aborted or failed commands never leak stdout/stderr or start subsequent steps', async () => {
  const aborted = new AbortController(); aborted.abort()
  const f = fixture(); await assert.rejects(f.runtime.startServer({ signal: aborted.signal }), /interrupted/); assert.equal(f.calls.length, 0)
  const fail = fixture([], { run: (_file, _args, _options, callback) => callback(Error('secret output'), 'secret') })
  await assert.rejects(fail.runtime.startServer(), error => !error.message.includes('secret'))
})
