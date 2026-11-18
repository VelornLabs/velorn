'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
const { recordPictureReview, STILL_BYTES, LIMIT } = require('../electron/agentPictureReview.cjs')
const { recordAudioReview } = require('../electron/agentAudioReview.cjs')
const { createAgentReviewMediaStore } = require('../electron/agentReviewMediaStore.cjs')
const { createMobileStillCatalog } = require('../electron/mobileCompanionStills.cjs')
const result = value => ({ content: [{ type: 'text', text: JSON.stringify({ success: true, result: value }) }] })
// A JPEG as the review store reads one: start marker, a frame header saying
// 1280 x 720, a scan marker, filler, end marker. Not a decodable picture.
const jpeg = (size = 2000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xda]),
  Buffer.alloc(size, 7), Buffer.from([0xff, 0xd9])])
const origin = { chatId: 'chat-one', turnId: 'turn-one' }

function fixture(overrides = {}) {
  const frames = [], read = []
  return { frames, read, run: (name, value, extra = {}) => recordPictureReview({ name, result: result(value), origin, projectPath: '/fixture/project',
    store: { saveFrame: async (projectPath, frame) => { frames.push({ projectPath, ...frame }) } },
    readPicture: async ({ assetId }) => { read.push(assetId); if (assetId === 'broken') throw new Error('unreadable'); return { mimeType: 'image/png', base64: Buffer.from('picture ' + assetId).toString('base64') } },
    toJpeg: async () => jpeg(), now: () => 1794000000000, ...overrides, ...extra }) }
}

test('a picture the agent imported is saved as a still on the reply that imported it', async () => {
  const f = fixture()
  assert.equal(await f.run('import_comfy_router_image', { success: true, assetId: 'asset_1794346137253_a6qcvnnke', jobId: 'job-1' }), 1)
  assert.deepEqual(f.read, ['asset_1794346137253_a6qcvnnke'])
  const frame = f.frames[0]
  assert.deepEqual([frame.projectPath, frame.chatId, frame.turnId, frame.label, frame.capturedAt], ['/fixture/project', 'chat-one', 'turn-one', 'Picture', 1794000000000])
  assert.match(frame.id, /^review-[a-f0-9-]{36}$/)
  assert.match(frame.dataUrl, /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/)
})

test('get_assets with showInChat shows the image assets it was asked for, at most four, by name', async () => {
  const f = fixture()
  const assets = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, type: 'image', name: `shot-${id}.png` })).concat([{ id: 'clip', type: 'video', name: 'clip.mp4' }])
  assert.equal(await f.run('get_assets', { reviewMedia: true, assetIds: ['clip'], pictureAssetIds: ['a', 'b', 'c', 'd', 'e', 'clip', 'missing'], assets }), LIMIT)
  assert.deepEqual(f.read, ['a', 'b', 'c', 'd'])
  assert.deepEqual(f.frames.map(frame => frame.label), ['Picture: shot-a.png', 'Picture: shot-b.png', 'Picture: shot-c.png', 'Picture: shot-d.png'])
  // Without showInChat, an ordinary asset listing attaches nothing.
  const quiet = fixture()
  assert.equal(await quiet.run('get_assets', { assets, pictureAssetIds: ['a'] }), 0)
  assert.deepEqual(quiet.frames, [])
})

test('previews, failures, other tools, unknown turns and unreadable or oversized pictures attach nothing', async () => {
  const f = fixture()
  assert.equal(await f.run('import_comfy_router_image', { previewOnly: true, assetId: 'a' }), 0)
  assert.equal(await f.run('import_comfy_router_image', { success: false, assetId: 'a' }), 0)
  assert.equal(await f.run('generate_create_media', { assetId: 'a' }), 0)
  assert.equal(await f.run('import_comfy_router_image', { assetId: '../../etc/passwd' }), 0)
  assert.equal(await f.run('import_comfy_router_image', { assetId: 'broken' }), 0)
  assert.equal(await f.run('import_comfy_router_image', { assetId: 'a' }, { toJpeg: async () => jpeg(STILL_BYTES) }), 0, 'a copy above the still limit is not saved')
  assert.equal(await f.run('import_comfy_router_image', { assetId: 'a' }, { toJpeg: async () => null }), 0)
  assert.equal(await f.run('import_comfy_router_image', { assetId: 'a' }, { origin: { chatId: 'chat one', turnId: 'turn-one' } }), 0)
  assert.equal(await recordPictureReview({ name: 'import_comfy_router_image', result: { isError: true, content: [] }, origin, projectPath: '/p', store: { saveFrame: async () => {} }, readPicture: async () => ({}), toJpeg: async () => jpeg() }), 0)
  assert.deepEqual(f.frames, [])
})

test('the still reaches the real review history and the phone still list of that reply only', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-picture-review-')); t.after(() => fs.rm(root, { recursive: true, force: true }))
  const store = createAgentReviewMediaStore()
  const saved = await recordPictureReview({ name: 'import_comfy_router_image', result: result({ success: true, assetId: 'asset-kite' }), origin, projectPath: root, store,
    readPicture: async () => ({ mimeType: 'image/png', base64: 'AAAA' }), toJpeg: async () => jpeg(5000) })
  assert.equal(saved, 1)
  const catalog = turnIds => createMobileStillCatalog({ getContext: async () => ({ contextId: 'ctx', projectPath: root, chatId: 'chat-one', turnIds }), store })
  const cards = await catalog(['turn-one']).list()
  assert.equal(cards.length, 1)
  assert.equal(cards[0].label, 'Picture'); assert.equal(cards[0].turnId, 'turn-one'); assert.match(cards[0].url, /^\/media\/reviews\/[a-f0-9]{48}$/)
  assert.deepEqual(await catalog(['turn-two']).list(), [])
})

test('a clip or sound made with a Create model is attached to the reply as a player when it is imported', async () => {
  const bound = [], store = { bindAudio: async (...args) => bound.push(args) }
  await recordAudioReview({ name: 'import_comfy_router_image', result: result({ success: true, assetId: 'asset-clip', jobId: 'job-2' }), origin, projectPath: '/fixture', store })
  assert.deepEqual(bound, [['/fixture', [{ kind: 'asset', id: 'asset-clip' }], origin]])
  await recordAudioReview({ name: 'import_comfy_router_image', result: result({ previewOnly: true, assetId: 'asset-clip' }), origin, projectPath: '/fixture', store })
  assert.equal(bound.length, 1)
})
