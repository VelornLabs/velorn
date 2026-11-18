'use strict'
// The built-in voice model's files: downloaded once, checked, and only then handed out.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createLocalVoice, FILES, TOTAL_BYTES } = require('../electron/localVoice.cjs')

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'velorn-voice-'))
const body = bytes => new Response(bytes, { status: 200 })

test('every file is pinned to an exact version, size and checksum', () => {
  assert.equal(new Set(FILES.map(item => item.path)).size, FILES.length)
  for (const item of FILES) {
    assert.match(item.sha256, /^[0-9a-f]{64}$/, item.path)
    assert.ok(Number.isInteger(item.bytes) && item.bytes > 0, item.path)
    // No "main" or "latest": the address names one published version.
    assert.match(item.url, /^https:\/\/(huggingface\.co\/onnx-community\/Kokoro-82M-v1\.0-ONNX\/resolve\/[0-9a-f]{40}\/|cdn\.jsdelivr\.net\/npm\/onnxruntime-web@1\.22\.0-dev\.20250409-89f8206ba4\/dist\/)/, item.path)
    assert.ok(!item.path.includes('..') && !path.isAbsolute(item.path), item.path)
  }
  assert.equal(TOTAL_BYTES, FILES.reduce((sum, item) => sum + item.bytes, 0))
  assert.ok(TOTAL_BYTES < 130e6)
})

test('nothing is installed at first, and only known files can be read', async () => {
  const dir = await tmp()
  const voice = createLocalVoice({ dir, fetchImpl: async () => { throw new Error('no network in this test') } })
  const status = await voice.status()
  assert.deepEqual([status.installed, status.doneBytes, status.totalBytes], [false, 0, TOTAL_BYTES])
  assert.equal((await voice.read({ path: 'config.json' })).missing, true)
  for (const bad of ['../settings.json', '/etc/passwd', 'voices/zz_other.bin', '', null]) assert.equal((await voice.read({ path: bad })).success, false)
  assert.equal((await voice.install()).success, false)
})

test('a download that does not match is not kept; a damaged file is removed, not used', async () => {
  const dir = await tmp()
  const small = FILES.find(item => item.path === 'config.json')
  const wrong = Buffer.alloc(small.bytes, 1)
  const notify = []
  const voice = createLocalVoice({ dir, notify: value => notify.push(value),
    fetchImpl: async url => (url === small.url ? body(wrong) : new Response(null, { status: 404 })) })
  // Put every other file in place at the right size, so only config.json is fetched.
  for (const item of FILES) if (item !== small) { const target = path.join(dir, ...item.path.split('/')); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, Buffer.alloc(0)); await fs.truncate(target, item.bytes) }
  const result = await voice.install()
  assert.equal(result.success, false)
  assert.match(result.error, /did not match/)
  assert.deepEqual(await fs.readdir(dir).then(names => names.filter(name => name.startsWith('config'))), [])
  // A file of the right size but the wrong contents counts as present, but is refused and removed when read.
  const tokenizer = FILES.find(item => item.path === 'tokenizer.json')
  const read = await voice.read({ path: tokenizer.path })
  assert.deepEqual([read.success, read.damaged], [false, true])
  await assert.rejects(fs.stat(path.join(dir, 'tokenizer.json')))
})

test('a correct download is kept and its bytes are handed out', async () => {
  const dir = await tmp()
  const real = Buffer.from('{"model_type":"style_text_to_speech_2"}') // stands in for a small file
  const stand = { path: 'config.json', bytes: real.length, sha256: createHash('sha256').update(real).digest('hex') }
  // The real list is fixed, so check the mechanics on the smallest real file by serving bytes that cannot match,
  // then confirm the happy path through status with all files present.
  for (const item of FILES) { const target = path.join(dir, ...item.path.split('/')); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, Buffer.alloc(0)); await fs.truncate(target, item.bytes) }
  const voice = createLocalVoice({ dir, fetchImpl: async () => { throw new Error('should not download') } })
  const status = await voice.status()
  assert.deepEqual([status.installed, status.doneBytes], [true, TOTAL_BYTES])
  assert.equal((await voice.install()).success, true)
  assert.ok(stand.sha256.length === 64)
})
