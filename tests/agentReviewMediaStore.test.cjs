'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createAgentReviewMediaStore, MAX_FRAME_BYTES, MAX_RETURNED_FRAMES } = require('../electron/agentReviewMediaStore.cjs')

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHacAAAAASUVORK5CYII='
const frame = (overrides = {}) => ({ id: 'review-one', chatId: 'chat-one', turnId: 'turn-one', label: 'Timeline frame',
  capturedAt: 1700000000000, timeSeconds: 3, timelineId: 'timeline-one', dataUrl: PNG, ...overrides })
const manifestPath = root => path.join(root, '.velorn', 'agent-review', 'manifest.json')
const readManifest = async root => JSON.parse(await fs.readFile(manifestPath(root), 'utf8'))
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-durable-review-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'project'), privateDir = path.join(root, 'private')
  await fs.mkdir(project); await fs.mkdir(privateDir)
  return { root, project, externalKeyPath: path.join(privateDir, 'agent-review-key') }
}
async function exportJob(project, overrides = {}) {
  const outputPath = overrides.outputPath || path.join(project, 'renders', 'review.mp4')
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, 'synthetic export fixture, not real user media')
  return { jobId: 'job-one', projectPath: project, owner: 'mcp', status: 'completed', outputPath,
    startedAt: '2026-09-30T12:00:00.000Z', finishedAt: '2026-09-30T12:01:00.000Z',
    origin: { chatId: 'chat-one', turnId: 'turn-one' }, ...overrides }
}

test('fresh store restores conversation-owned stills and exports without persisting image bytes in metadata', async t => {
  const { project } = await temporary(t), store = createAgentReviewMediaStore()
  await store.saveFrame(project, frame())
  const job = await exportJob(project); await store.saveExport(job)
  const manifest = await readManifest(project)
  assert.equal(manifest.frames.length, 1); assert.equal(manifest.exports.length, 1)
  assert.equal(JSON.stringify(manifest).includes('data:image'), false)
  assert.deepEqual(manifest.exports[0].reference, { kind: 'project', path: 'renders/review.mp4' })
  assert.equal(JSON.stringify(manifest).includes(project), false, 'project-owned references stay portable')
  const reopened = createAgentReviewMediaStore()
  assert.deepEqual(await reopened.listFrames(project, { chatId: 'chat-one' }), [frame()])
  assert.deepEqual(await reopened.readFrame(project, 'review-one'), frame())
  assert.deepEqual(await reopened.listFrames(project, { chatId: 'other-chat' }), [])
  assert.deepEqual(await reopened.listFrames(project, { chatId: 'chat-one', turnIds: ['other-turn'] }), [])
  assert.deepEqual(await reopened.listFrames(project, { chatId: 'chat-one', turnIds: [] }), [])
  const [video] = await reopened.listExports(project)
  assert.equal(video.outputPath, job.outputPath); assert.deepEqual(video.origin, job.origin)
  assert.equal(video.persisted, true); assert.equal(video.status, 'completed')
})

test('moving a project restores its internal media from relative paths', async t => {
  const { root, project } = await temporary(t), store = createAgentReviewMediaStore()
  await store.saveFrame(project, frame()); await store.saveExport(await exportJob(project))
  const moved = path.join(root, 'renamed project'); await fs.rename(project, moved)
  const reopened = createAgentReviewMediaStore()
  assert.equal((await reopened.listFrames(moved, { chatId: 'chat-one' }))[0].dataUrl, PNG)
  const [video] = await reopened.listExports(moved)
  assert.equal(video.outputPath, path.join(moved, 'renders', 'review.mp4')); assert.equal(video.projectPath, moved)
})

test('missing or damaged stills keep reply metadata and explicit unavailable state', async t => {
  const { project } = await temporary(t), store = createAgentReviewMediaStore()
  await store.saveFrame(project, frame())
  const mediaPath = path.join(project, '.velorn', 'agent-review', 'frames', (await readManifest(project)).frames[0].media.file)
  await fs.unlink(mediaPath)
  let [saved] = await store.listFrames(project, { chatId: 'chat-one' })
  assert.equal(saved.unavailable, true); assert.equal(saved.reason, 'file-missing'); assert.equal(saved.turnId, 'turn-one')
  assert.equal(saved.dataUrl, undefined)
  await store.saveFrame(project, frame())
  const original = await fs.readFile(mediaPath); original[40] ^= 1; await fs.writeFile(mediaPath, original)
  saved = await store.readFrame(project, 'review-one')
  assert.equal(saved.unavailable, true); assert.equal(saved.reason, 'file-unavailable')
  assert.equal(await store.readFrame(project, 'review-absent'), null)
})

test('metadata-only listing avoids raster reads and carries missing-file placeholders', async t => {
  const { project } = await temporary(t), store = createAgentReviewMediaStore()
  await store.saveFrame(project, frame())
  const [saved] = await store.listFrames(project, { chatId: 'chat-one', includeData: false })
  assert.equal(saved.dataUrl, undefined); assert.equal(saved.unavailable, undefined); assert.equal(saved.id, 'review-one')
  const mediaPath = path.join(project, '.velorn', 'agent-review', 'frames', (await readManifest(project)).frames[0].media.file)
  await fs.unlink(mediaPath)
  assert.equal((await store.listFrames(project, { chatId: 'chat-one', includeData: false }))[0].unavailable, true)
})

test('missing export keeps a durable unavailable receipt instead of disappearing', async t => {
  const { project } = await temporary(t), store = createAgentReviewMediaStore()
  const job = await exportJob(project); await store.saveExport(job); await fs.unlink(job.outputPath)
  const [saved] = await createAgentReviewMediaStore().listExports(project)
  assert.equal(saved.name, 'review.mp4'); assert.equal(saved.unavailable, true); assert.equal(saved.reason, 'file-missing')
  assert.deepEqual(saved.origin, job.origin); assert.equal(saved.outputPath, job.outputPath)
})

test('concurrent saves across store instances serialize and preserve every receipt', async t => {
  const { project } = await temporary(t), stores = [createAgentReviewMediaStore(), createAgentReviewMediaStore()]
  await Promise.all(Array.from({ length: 24 }, (_, index) => stores[index % 2].saveFrame(project, frame({ id: `review-${index}`, turnId: `turn-${index}` }))))
  const manifest = await readManifest(project)
  assert.equal(manifest.frames.length, 24)
  assert.equal(new Set(manifest.frames.map(item => item.id)).size, 24)
  assert.equal((await fs.readdir(path.join(project, '.velorn', 'agent-review', 'frames'))).length, 1, 'identical thumbnails are content-deduplicated')
  assert.equal((await fs.readdir(path.dirname(manifestPath(project)))).some(name => name.startsWith('.pending-')), false)
})

test('invalid manifest is never reset or overwritten on a subsequent save', async t => {
  const { project } = await temporary(t), store = createAgentReviewMediaStore()
  await store.saveFrame(project, frame())
  const invalid = '{incomplete manifest'; await fs.writeFile(manifestPath(project), invalid)
  await assert.rejects(store.listFrames(project, { chatId: 'chat-one' }), /manifest is unreadable/)
  await assert.rejects(store.saveFrame(project, frame({ id: 'review-two' })), /manifest is unreadable/)
  assert.equal(await fs.readFile(manifestPath(project), 'utf8'), invalid)
})

test('frame IDs, base64, raster type, dimensions, filters and byte bounds are checked', async t => {
  const { project } = await temporary(t), store = createAgentReviewMediaStore()
  for (const change of [{ id: '../escape' }, { chatId: '/other' }, { turnId: 'x/y' }, { capturedAt: NaN }, { timeSeconds: -1 },
    { dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }, { dataUrl: 'data:image/png;base64,YWJj' },
    { dataUrl: `${PNG}!` }, { dataUrl: `data:image/png;base64,${Buffer.alloc(MAX_FRAME_BYTES + 1).toString('base64')}` }]) {
    await assert.rejects(store.saveFrame(project, frame(change)))
  }
  const huge = Buffer.from(PNG.split(',')[1], 'base64'); huge.writeUInt32BE(5000, 16)
  await assert.rejects(store.saveFrame(project, frame({ dataUrl: `data:image/png;base64,${huge.toString('base64')}` })), /dimensions/)
  await assert.rejects(store.listFrames(project, { chatId: '../other' }))
  await assert.rejects(store.listFrames(project, { chatId: 'chat-one', turnIds: Array(101).fill('turn-one') }))
  await assert.rejects(store.readFrame(project, '../manifest.json'))
  await assert.rejects(store.saveFrame(project, frame({ dataUrl: undefined })))
})

test('stored image paths cannot traverse or follow symlinks', async t => {
  const { root, project } = await temporary(t), store = createAgentReviewMediaStore()
  await store.saveFrame(project, frame())
  const manifest = await readManifest(project), imagePath = path.join(project, '.velorn', 'agent-review', 'frames', manifest.frames[0].media.file)
  const outside = path.join(root, 'secret.png'); await fs.rename(imagePath, outside); await fs.symlink(outside, imagePath)
  assert.equal((await store.readFrame(project, 'review-one')).unavailable, true)
  await assert.rejects(store.saveFrame(project, frame()), /regular file/)
  manifest.frames[0].media.file = '../../../../secret.png'; await fs.writeFile(manifestPath(project), JSON.stringify(manifest))
  await assert.rejects(store.listFrames(project, { chatId: 'chat-one' }), /invalid image records/)
})

test('store directories and manifests cannot be redirected with symlinks', async t => {
  const { root, project } = await temporary(t), outside = path.join(root, 'outside'), store = createAgentReviewMediaStore()
  await fs.mkdir(outside); await fs.symlink(outside, path.join(project, '.velorn'))
  await assert.rejects(store.saveFrame(project, frame()), /symbolic links/)
  assert.deepEqual(await fs.readdir(outside), [])
  await fs.unlink(path.join(project, '.velorn')); await store.saveFrame(project, frame())
  const secret = path.join(outside, 'manifest.json'); await fs.rename(manifestPath(project), secret); await fs.symlink(secret, manifestPath(project))
  await assert.rejects(store.saveFrame(project, frame({ id: 'review-two' })), /symbolic links/)
  assert.equal(JSON.parse(await fs.readFile(secret, 'utf8')).frames.length, 1)
})

test('only completed native video records can be saved; ownership cannot be reassigned', async t => {
  const { project } = await temporary(t), store = createAgentReviewMediaStore(), job = await exportJob(project)
  for (const change of [{ status: 'running' }, { jobId: '../bad' }, { finishedAt: 'not a time' }, { origin: { chatId: 'chat-one' } }, { outputPath: 'relative.mp4' }]) {
    await assert.rejects(store.saveExport({ ...job, ...change }))
  }
  await store.saveExport(job)
  await assert.rejects(store.saveExport({ ...job, origin: { chatId: 'chat-other', turnId: 'turn-other' } }), /another conversation/)
  await store.saveFrame(project, frame())
  await assert.rejects(store.saveFrame(project, frame({ chatId: 'chat-other' })), /another conversation/)
})

test('external exports require a durable private signature and exact original file identity', async t => {
  const { root, project, externalKeyPath } = await temporary(t)
  const store = createAgentReviewMediaStore({ externalKeyPath }), outputPath = path.join(root, 'external.mp4')
  const job = await exportJob(project, { outputPath }); await store.saveExport(job)
  assert.equal((await fs.stat(externalKeyPath)).mode & 0o777, 0o600)
  let [saved] = await createAgentReviewMediaStore({ externalKeyPath }).listExports(project)
  assert.equal(saved.outputPath, outputPath); assert.equal(saved.externalAuthorized, true); assert.equal(saved.expectedIdentity.size, (await fs.stat(outputPath)).size)
  const manifest = await readManifest(project)
  manifest.exports[0].origin.turnId = 'other-turn'; await fs.writeFile(manifestPath(project), JSON.stringify(manifest))
  saved = (await store.listExports(project))[0]
  assert.equal(saved.unavailable, true); assert.equal(saved.outputPath, undefined); assert.equal(saved.externalAuthorized, undefined)
  manifest.exports[0].origin.turnId = 'turn-one'; await fs.writeFile(manifestPath(project), JSON.stringify(manifest))
  await fs.rename(outputPath, `${outputPath}.old`); await fs.writeFile(outputPath, 'replacement file')
  saved = (await store.listExports(project))[0]
  assert.equal(saved.unavailable, true); assert.equal(saved.outputPath, undefined)
})

test('external missing files, wrong private keys and copied projects preserve unavailable receipts', async t => {
  const { root, project, externalKeyPath } = await temporary(t), store = createAgentReviewMediaStore({ externalKeyPath })
  const job = await exportJob(project, { outputPath: path.join(root, 'external.mp4') }); await store.saveExport(job)
  const otherKey = path.join(root, 'private', 'wrong-key'); await fs.writeFile(otherKey, Buffer.alloc(32))
  assert.equal((await createAgentReviewMediaStore({ externalKeyPath: otherKey }).listExports(project))[0].unavailable, true)
  const moved = path.join(root, 'moved'); await fs.rename(project, moved)
  assert.equal((await createAgentReviewMediaStore({ externalKeyPath }).listExports(moved))[0].externalAuthorized, true)
  await fs.unlink(job.outputPath)
  const [saved] = await createAgentReviewMediaStore({ externalKeyPath }).listExports(moved)
  assert.equal(saved.unavailable, true); assert.equal(saved.reason, 'file-missing'); assert.equal(saved.name, 'external.mp4')
})

test('unsigned external references and export path traversal never grant access', async t => {
  const { root, project } = await temporary(t), store = createAgentReviewMediaStore()
  const job = await exportJob(project, { outputPath: path.join(root, 'external.mp4') }); await store.saveExport(job)
  assert.equal((await store.listExports(project))[0].externalAuthorized, true)
  assert.equal((await createAgentReviewMediaStore().listExports(project))[0].unavailable, true, 'without a private key only the creating native process may grant access')
  const manifest = await readManifest(project)
  manifest.exports[0].reference = { kind: 'project', path: '../external.mp4' }
  await fs.writeFile(manifestPath(project), JSON.stringify(manifest))
  await assert.rejects(store.listExports(project), /invalid export records/)
})

test('symlinked export files and parent directories never grant access', async t => {
  const { root, project } = await temporary(t), store = createAgentReviewMediaStore(), job = await exportJob(project)
  await store.saveExport(job)
  const moved = path.join(root, 'renders-outside'); await fs.rename(path.dirname(job.outputPath), moved); await fs.symlink(moved, path.dirname(job.outputPath))
  assert.equal((await store.listExports(project))[0].unavailable, true)
  await assert.rejects(store.saveExport(job), /symbolic links/)
})

test('list bounds do not silently evict durable receipts and storage quota rejects explicitly', async t => {
  const { project } = await temporary(t), store = createAgentReviewMediaStore()
  await store.saveFrame(project, frame())
  const manifest = await readManifest(project)
  manifest.frames = Array.from({ length: 2000 }, (_, index) => ({ ...manifest.frames[0], id: `review-${index}` }))
  await fs.writeFile(manifestPath(project), JSON.stringify(manifest))
  assert.equal((await store.listFrames(project, { chatId: 'chat-one', includeData: false })).length, MAX_RETURNED_FRAMES)
  await assert.rejects(store.saveFrame(project, frame({ id: 'review-over-quota' })), /reached its image limit/)
  assert.equal((await readManifest(project)).frames.length, 2000)
})
