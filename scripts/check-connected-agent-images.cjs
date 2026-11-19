'use strict'
// Run with Electron, not ELECTRON_RUN_AS_NODE. --live makes exactly one
// subscription-backed image request; all project/import state is disposable.
const { app, nativeImage } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { receiveGeneratedImage } = require('../electron/connectedAgentImages.cjs')
const { sendFullAccessCodex } = require('../electron/connectedAgentFullAccessCodex.cjs')
const { createAgentReviewMediaStore } = require('../electron/agentReviewMediaStore.cjs')
async function main() {
  await app.whenReady()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-image-smoke-'))
  const store = createAgentReviewMediaStore()
  const frames = [], assets = []
  const accept = async (item, options = {}) => {
    const frameJobs = []
    const result = await receiveGeneratedImage(item, { ...options, nativeImage,
      onReview(frame) { frames.push(frame); frameJobs.push(store.saveFrame(root, { ...frame, chatId: 'image-chat', turnId: 'image-turn' })) },
      toolSession: { async callTool(name, args) {
        assert.equal(name, 'import_asset_from_path'); assert.equal(args.category, 'images'); assert.equal(args.asSequence, false)
        const relativePath = `assets/${path.basename(args.path)}`
        await fs.mkdir(path.join(root, 'assets'), { recursive: true })
        await fs.copyFile(args.path, path.join(root, relativePath))
        const image = nativeImage.createFromBuffer(await fs.readFile(path.join(root, relativePath)))
        assert.equal(image.isEmpty(), false)
        const asset = { id: `image-${assets.length + 1}`, name: path.basename(args.path), relativePath, type: 'image', ...image.getSize() }
        assets.push(asset)
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, result: { success: true, asset, savedProject: true } }) }] }
      } },
    })
    await Promise.all(frameJobs)
    return result
  }
  if (process.argv.includes('--live')) {
    const response = await sendFullAccessCodex({ workingDirectory: root, model: 'gpt-6-luna', reasoningEffort: 'low',
      context: '{}', messages: [{ role: 'user', content: 'Integration test: use your native image generation tool exactly once to generate one simple square illustration of a blue circle on a cream background. Do not use shell, web, scripts, ComfyUI, or any other generation method. Do not retry. Velorn will save and show the output automatically. Then give a brief final reply.' }], images: [] },
    { onGeneratedImage: accept, onEvent(event) { if (['status', 'tool'].includes(event.type)) console.log(JSON.stringify(event)) }, timeoutMs: 240000 })
    console.log(JSON.stringify({ reply: response.text }))
  } else {
    const raster = nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 255), { width: 64, height: 64 })
    await accept({ result: raster.toPNG().toString('base64') })
  }
  assert.equal(assets.length, 1); assert.equal(frames.length, 1)
  const restored = await createAgentReviewMediaStore().listFrames(root, { chatId: 'image-chat', turnIds: ['image-turn'] })
  assert.equal(restored.length, 1); assert.equal(restored[0].turnId, 'image-turn'); assert.ok(restored[0].dataUrl)
  assert.equal(nativeImage.createFromDataURL(restored[0].dataUrl).isEmpty(), false)
  console.log(JSON.stringify({ success: true, root, assets, reviewRestored: true }))
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
