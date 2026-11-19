'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { receiveGeneratedImage, MAX_IMAGE_BYTES } = require('../electron/connectedAgentImages.cjs')
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII='
const nativeImage = { createFromBuffer() { return {
  isEmpty: () => false, getSize: () => ({ width: 1024, height: 1024 }),
  resize: () => ({ toJPEG: () => Buffer.from([255,216,255,217]) }),
} } }
const result = body => ({ content: [{ type: 'text', text: JSON.stringify({ success: true, result: body }) }] })
test('completed images import once as single portable project assets and attach bounded previews', async () => {
  const calls = [], frames = []
  const saved = await receiveGeneratedImage({ result: png }, { nativeImage, onReview: frame => frames.push(frame),
    toolSession: { async callTool(name, args) {
      calls.push({ name, args }); assert.equal((await fs.readFile(args.path)).toString('base64'), png)
      return result({ success: true, asset: { id: 'asset-new', name: 'Image' }, savedProject: true })
    } } })
  assert.equal(saved.assetId, 'asset-new'); assert.equal(saved.saved, true)
  assert.equal(calls.length, 1); assert.equal(calls[0].name, 'import_asset_from_path')
  assert.equal(calls[0].args.asSequence, false); assert.equal(calls[0].args.category, 'images')
  assert.equal(calls[0].args.previewOnly, false)
  assert.equal(frames.length, 1); assert.match(frames[0].label, /Generated image/)
  assert.ok(frames[0].dataUrl.length < 1100000)
  await assert.rejects(fs.stat(calls[0].args.path), { code: 'ENOENT' })
})
test('import failures retain a recovery original without retrying or claiming a saved image', async () => {
  let source, calls = 0
  try {
    await assert.rejects(receiveGeneratedImage({ result: png }, { nativeImage, toolSession: { async callTool(name, args) {
      calls++; source = args.path; return { isError: true, content: [] }
    } } }), /Recovery image:/)
    assert.equal(calls, 1); assert.equal((await fs.readFile(source)).toString('base64'), png)
  } finally { if (source) { await fs.unlink(source); await fs.rmdir(path.dirname(source)) } }
})
test('saved-path protocol works without base64 and never removes the Codex original', async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'velorn-image-test-'))
  const source = path.join(directory, 'original.png')
  try {
    await fs.writeFile(source, Buffer.from(png, 'base64'))
    await receiveGeneratedImage({ result: '', savedPath: source }, { nativeImage, toolSession: { async callTool() {
      return result({ asset: { id: 'asset-saved-path' }, savedProject: true })
    } } })
    assert.equal((await fs.readFile(source)).toString('base64'), png)
  } finally { await fs.unlink(source); await fs.rmdir(directory) }
})
test('malformed, empty, unsupported and oversized output cannot trigger an import', async () => {
  for (const data of ['', 'bad!', 'YQ==', 'a'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4)]) {
    await assert.rejects(receiveGeneratedImage({ result: data }, { nativeImage, toolSession: { callTool() { assert.fail('must not import') } } }))
  }
})
test('cancellation and stale project ownership prevent importing a late image', async () => {
  const controller = new AbortController(); controller.abort()
  for (const options of [{ signal: controller.signal }, { isCurrent: () => false }]) {
    await assert.rejects(receiveGeneratedImage({ result: png }, { nativeImage, ...options, toolSession: { callTool() { assert.fail('must not import') } } }), /stopped or its project changed/)
  }
})
