import test from 'node:test'
import assert from 'node:assert/strict'
import { createRouterImageImporter } from '../src/services/comfyRouterImport.mjs'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP2kAAAAASUVORK5CYII=', 'base64')
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCVAJk0f//Z', 'base64')

function fixture({ jpeg = false } = {}) {
  let handle = '/synthetic/project', session = 'a', busy = false, status = 'COMPLETED', receipt = true
  let onOutput, onImport, onResolve, urlValue, urlError, preview = null
  const assets = [], calls = { output: 0, writes: 0, marks: 0 }, resolutions = [], updates = [], previews = []
  const filename = `velorn-router-job-1.${jpeg ? 'jpg' : 'png'}`
  const job = () => ({ jobId: 'job-1', status, outputAvailable: status === 'COMPLETED', model: 'synthetic-model' })
  const importer = createRouterImageImporter({
    getApi: () => ({ list: async () => ({ success: true, jobs: [job()] }),
      output: async () => { calls.output++; await onOutput?.(); return { success: true, bytes: new Uint8Array(jpeg ? JPEG : PNG), mimeType: jpeg ? 'image/jpeg' : 'image/png', filename } },
      markImported: async () => { calls.marks++; return { success: receipt } } }),
    getProject: () => ({ currentProject: { id: 'project' }, currentProjectHandle: handle }),
    captureContext: () => ({ session, projectKey: handle }),
    getAssets: () => ({ assets, addAsset: asset => { const value = { ...asset, id: 'asset-1' }; assets.push(value); return value },
      setPreview: asset => { preview = asset; previews.push(asset) },
      updateAssetUrl: (id, url) => { updates.push({ id, url }); const index = assets.findIndex(asset => asset.id === id); assets[index] = { ...assets[index], url } } }),
    isBusy: () => busy,
    importFile: async (root, file, category) => { calls.writes++; await onImport?.(); assert.equal(root, '/synthetic/project'); assert.equal(category, 'images'); return { path: `assets/images/${file.name}`, absolutePath: `${root}/assets/images/${file.name}`, width: 1024, height: 1024 } },
    resolveAssetUrl: async (root, asset) => {
      resolutions.push({ root, asset }); await onResolve?.()
      if (urlError) throw new Error(urlError)
      return urlValue !== undefined ? urlValue : `file://${root}/${asset.path}`
    },
    makeFile: (bytes, name, options) => ({ bytes, name, ...options }),
  })
  return { importer, calls, assets, resolutions, updates, previews, get preview() { return preview }, filename,
    setUrl: v => { urlValue = v }, setUrlError: v => { urlError = v }, onResolve: fn => { onResolve = fn },
    setHandle: v => { handle = v }, setSession: v => { session = v }, setBusy: v => { busy = v }, setStatus: v => { status = v }, setReceipt: v => { receipt = v }, onOutput: fn => { onOutput = fn }, onImport: fn => { onImport = fn } }
}
test('preview is inert; apply uses project-relative assets and repeated import is idempotent', async () => {
  const f = fixture()
  assert.equal((await f.importer('job-1')).previewOnly, true)
  assert.deepEqual(f.calls, { output: 0, writes: 0, marks: 0 })
  assert.equal((await f.importer('job-1', { previewOnly: false })).success, true)
  assert.equal((await f.importer('job-1', { previewOnly: false })).alreadyImported, true)
  assert.equal(f.calls.writes, 1); assert.equal(f.assets.length, 1)
  assert.equal(f.assets[0].path, 'assets/images/velorn-router-job-1.png')
  assert.equal(f.assets[0].routerGeneration.jobId, 'job-1')
  assert.equal(f.assets[0].url, 'file:///synthetic/project/assets/images/velorn-router-job-1.png')
  assert.equal(f.preview.id, f.assets[0].id)
})
test('concurrent imports share a single output request/write', async () => {
  const f = fixture(); let release
  f.onOutput(() => new Promise(resolve => { release = resolve }))
  const first = f.importer('job-1', { previewOnly: false })
  const second = f.importer('job-1', { previewOnly: false })
  await new Promise(resolve => setImmediate(resolve)); release()
  assert.equal((await first).success, true); assert.equal((await second).success, true)
  assert.equal(f.calls.writes, 1)
})
test('project or renderer session changed during download prevents any asset write', async () => {
  for (const change of ['setHandle', 'setSession']) {
    const f = fixture(); f.onOutput(() => f[change]('changed'))
    assert.equal((await f.importer('job-1', { previewOnly: false })).success, false)
    assert.equal(f.calls.writes, 0); assert.equal(f.assets.length, 0)
  }
})
test('project change during copy cannot attach the image to the new project', async () => {
  const f = fixture(); f.onImport(() => f.setHandle('/other'))
  assert.equal((await f.importer('job-1', { previewOnly: false })).success, false)
  assert.equal(f.assets.length, 0)
})
test('export, unfinished jobs, unknown IDs and absent project fail without output download', async () => {
  const f = fixture(); f.setBusy(true)
  assert.equal((await f.importer('job-1', { previewOnly: false })).success, false)
  f.setBusy(false); f.setStatus('IN_PROGRESS')
  assert.equal((await f.importer('job-1', { previewOnly: false })).success, false)
  f.setStatus('COMPLETED')
  assert.equal((await f.importer('unknown', { previewOnly: false })).success, false)
  f.setHandle(null)
  assert.equal((await f.importer('job-1', { previewOnly: false })).success, false)
  assert.equal(f.calls.output, 0)
})
test('native receipt failure does not duplicate an imported asset', async () => {
  const f = fixture(); f.setReceipt(false)
  assert.equal((await f.importer('job-1', { previewOnly: false })).receiptSaved, false)
  assert.equal((await f.importer('job-1', { previewOnly: false })).alreadyImported, true)
  assert.equal(f.calls.writes, 1)
})

test('JPEG import resolves a playable project URL and explicitly previews the new asset', async () => {
  const f = fixture({ jpeg: true })
  const result = await f.importer('job-1', { previewOnly: false })
  assert.equal(result.success, true)
  assert.equal(f.assets[0].type, 'image')
  assert.equal(f.assets[0].path, 'assets/images/velorn-router-job-1.jpg')
  assert.equal(f.assets[0].url, 'file:///synthetic/project/assets/images/velorn-router-job-1.jpg')
  assert.equal(f.preview, f.assets[0]); assert.equal(f.previews.length, 1)
  assert.equal(f.resolutions.length, 1)
})

function seedBrokenAsset(f) {
  f.assets.push({ id: 'old-asset', path: `assets/images/${f.filename}`, absolutePath: `/synthetic/project/assets/images/${f.filename}`,
    type: 'image', isImported: true, url: null, routerGeneration: { version: 1, jobId: 'job-1' } })
}
test('existing missing-URL image is repaired and previewed without download, copying or duplication', async () => {
  const f = fixture({ jpeg: true }); seedBrokenAsset(f)
  assert.equal((await f.importer('job-1')).alreadyImported, true)
  assert.equal(f.resolutions.length, 0, 'Preview-only does not resolve or edit the session URL')
  const result = await f.importer('job-1', { previewOnly: false })
  assert.equal(result.success, true); assert.equal(result.alreadyImported, true); assert.equal(result.assetId, 'old-asset')
  assert.deepEqual(f.calls, { output: 0, writes: 0, marks: 0 })
  assert.equal(f.assets.length, 1); assert.equal(f.updates.length, 1)
  assert.equal(f.preview.url, 'file:///synthetic/project/assets/images/velorn-router-job-1.jpg')
  assert.equal(f.assets[0].path, 'assets/images/velorn-router-job-1.jpg')
})

test('whitespace and non-string legacy URLs are repaired with the same missing-URL rule', async () => {
  for (const value of ['  ', 42, {}]) {
    const f = fixture(); seedBrokenAsset(f); f.assets[0].url = value
    assert.equal((await f.importer('job-1', { previewOnly: false })).success, true)
    assert.equal(f.preview.url, 'file:///synthetic/project/assets/images/velorn-router-job-1.png')
    assert.equal(f.updates.length, 1); assert.deepEqual(f.calls, { output: 0, writes: 0, marks: 0 })
  }
})

test('project/session/export changes during initial URL resolution cannot add or preview the image', async () => {
  for (const change of ['setHandle', 'setSession', 'setBusy']) {
    const f = fixture(); f.onResolve(() => f[change](change === 'setBusy' ? true : 'changed'))
    assert.equal((await f.importer('job-1', { previewOnly: false })).success, false)
    assert.equal(f.assets.length, 0); assert.equal(f.previews.length, 0); assert.equal(f.calls.marks, 0)
  }
})

test('project/session/export changes during existing URL repair leave the asset untouched', async () => {
  for (const change of ['setHandle', 'setSession', 'setBusy']) {
    const f = fixture(); seedBrokenAsset(f); f.onResolve(() => f[change](change === 'setBusy' ? true : 'changed'))
    assert.equal((await f.importer('job-1', { previewOnly: false })).success, false)
    assert.equal(f.assets[0].url, null); assert.equal(f.updates.length, 0); assert.equal(f.previews.length, 0)
    assert.deepEqual(f.calls, { output: 0, writes: 0, marks: 0 })
  }
})

test('URL resolution failures never register an unpreviewable new asset or claim an old one repaired', async () => {
  for (const existing of [false, true]) {
    for (const failure of ['throw', 'empty']) {
      const f = fixture(); if (existing) seedBrokenAsset(f)
      if (failure === 'throw') f.setUrlError('Synthetic saved image could not be resolved.')
      else f.setUrl('')
      assert.equal((await f.importer('job-1', { previewOnly: false })).success, false)
      assert.equal(f.assets.length, existing ? 1 : 0); assert.equal(f.updates.length, 0); assert.equal(f.previews.length, 0)
      assert.equal(f.calls.marks, 0)
    }
  }
})

test('deleting or relinking an existing asset during URL resolution cannot apply a stale preview URL', async () => {
  for (const change of ['delete', 'relink']) {
    const f = fixture(); seedBrokenAsset(f)
    f.onResolve(() => {
      if (change === 'delete') f.assets.splice(0)
      else f.assets[0] = { ...f.assets[0], path: 'assets/images/changed.jpg' }
    })
    assert.equal((await f.importer('job-1', { previewOnly: false })).success, false)
    assert.equal(f.updates.length, 0); assert.equal(f.previews.length, 0)
    assert.deepEqual(f.calls, { output: 0, writes: 0, marks: 0 })
  }
})

test('a Create sound file is saved under assets/audio with its real length and is not pushed to the preview', async () => {
  const assets = [], previews = [], categories = []
  const audio = (overrides = {}) => createRouterImageImporter({
    getApi: () => ({ list: async () => ({ success: true, jobs: [{ jobId: 'job-9', status: 'COMPLETED', outputAvailable: true, model: 'elevenlabs/eleven_v4', create: true, modelLabel: 'Eleven V4', estimateUsd: 0.01 }] }),
      output: async () => ({ success: true, kind: 'audio', bytes: new Uint8Array(600).fill(7), mimeType: 'audio/mpeg', filename: 'velorn-router-job-9.mp3', ...overrides }),
      markImported: async () => ({ success: true }) }),
    getProject: () => ({ currentProject: { id: 'project' }, currentProjectHandle: '/synthetic/project' }),
    captureContext: () => ({ session: 'a', projectKey: '/synthetic/project' }),
    getAssets: () => ({ assets, addAsset: asset => { const value = { ...asset, id: `asset-${assets.length + 1}` }; assets.push(value); return value }, setPreview: asset => previews.push(asset) }),
    isBusy: () => false,
    importFile: async (root, file, category) => { categories.push(category); return { path: `assets/${category}/${file.name}`, absolutePath: `${root}/assets/${category}/${file.name}` } },
    resolveAssetUrl: async (root, asset) => `file://${root}/${asset.path}`,
    makeFile: (bytes, name, options) => ({ bytes, name, ...options }),
    measureDuration: async url => { assert.equal(url, 'file:///synthetic/project/assets/audio/velorn-router-job-9.mp3'); return 4.25 },
  })
  const saved = await audio()('job-9', { previewOnly: false })
  assert.equal(saved.success, true)
  assert.match(saved.message, /^Audio added/)
  assert.deepEqual(categories, ['audio'])
  assert.deepEqual([assets[0].type, assets[0].duration, assets[0].source, assets[0].routerGeneration.modelLabel], ['audio', 4.25, 'comfy-router', 'Eleven V4'])
  assert.equal(previews.length, 0)
  assets.length = 0
  assert.equal((await audio({ filename: 'velorn-router-job-9.exe' })('job-9', { previewOnly: false })).success, false)
  assert.equal((await audio({ mimeType: 'text/html' })('job-9', { previewOnly: false })).success, false)
  assert.equal(assets.length, 0)
})
