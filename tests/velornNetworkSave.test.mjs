// A clip from the Velorn network is saved into the open project once, and only
// when it is what it says it is.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createVelornNetworkSaver } from '../src/services/velornNetworkSave.mjs'

function fixture({ project = { currentProject: { name: 'Beach' }, currentProjectHandle: '/projects/beach' }, busy = false } = {}) {
  const state = { project, assets: [], imported: [], preview: null }
  const save = createVelornNetworkSaver({
    getProject: () => state.project, isBusy: () => busy,
    getAssets: () => ({ assets: state.assets, addAsset: asset => { const made = { id: `asset-${state.assets.length + 1}`, ...asset }; state.assets.push(made); return made }, setPreview: asset => { state.preview = asset.id } }),
    importFile: async (handle, file, category) => { state.imported.push({ handle, name: file.name, type: file.type, size: file.size, category }); return { path: `assets/video/${file.name}` } },
    makeFile: (parts, name, options) => ({ name, type: options.type, size: parts[0].byteLength }),
    resolveAssetUrl: async (handle, asset) => `file://${handle}/${asset.path}` })
  return { state, save }
}
const clip = { jobId: 'job-12345678', filename: 'velorn-network-job-123456.mp4', mimeType: 'video/mp4', bytes: new Uint8Array(2048), hostName: 'Studio 5090', prompt: 'Waves at dusk' }

test('the clip becomes one video asset in the open project', async () => {
  const { state, save } = fixture()
  assert.deepEqual(await save(clip), { success: true, assetId: 'asset-1' })
  assert.deepEqual(state.imported, [{ handle: '/projects/beach', name: 'velorn-network-job-123456.mp4', type: 'video/mp4', size: 2048, category: 'video' }])
  const [asset] = state.assets
  assert.deepEqual({ type: asset.type, source: asset.source, path: asset.path, url: asset.url, network: asset.velornNetwork },
    { type: 'video', source: 'velorn-network', path: 'assets/video/velorn-network-job-123456.mp4', url: 'file:///projects/beach/assets/video/velorn-network-job-123456.mp4', network: { version: 1, jobId: 'job-12345678', hostName: 'Studio 5090', prompt: 'Waves at dusk' } })
  assert.equal(state.preview, 'asset-1')
  // Asked again for the same job: nothing is copied twice.
  assert.deepEqual(await save(clip), { success: true, alreadySaved: true, assetId: 'asset-1' })
  assert.equal(state.imported.length, 1)
})

test('nothing is saved without a project, during an export, or when the clip is not a plain video file', async () => {
  const none = fixture({ project: { currentProject: null, currentProjectHandle: null } })
  assert.equal((await none.save(clip)).needsProject, true)
  const exporting = fixture({ busy: true })
  assert.equal((await exporting.save(clip)).retry, true)
  const { state, save } = fixture()
  for (const bad of [{ filename: '../../outside.mp4' }, { filename: 'velorn-network-x.sh' }, { mimeType: 'text/html' }, { bytes: new Uint8Array(0) }, { jobId: 'x' }])
    assert.equal((await save({ ...clip, ...bad })).success, false)
  assert.equal(state.imported.length + none.state.imported.length + exporting.state.imported.length, 0)
})

test('a picture from the network becomes one image asset, and its name must match what it is', async () => {
  const { state, save } = fixture()
  const picture = { ...clip, filename: 'velorn-network-job-123456.png', mimeType: 'image/png' }
  assert.deepEqual(await save(picture), { success: true, assetId: 'asset-1' })
  assert.deepEqual([state.imported[0].category, state.imported[0].type, state.assets[0].type, state.assets[0].source], ['image', 'image/png', 'image', 'velorn-network'])
  const other = fixture()
  assert.equal((await other.save({ ...clip, mimeType: 'image/png' })).success, false)
  assert.equal((await other.save({ ...picture, mimeType: 'video/mp4' })).success, false)
  assert.equal(other.state.imported.length, 0)
})

test('a song becomes one sound asset with its length, and is not set as the picture preview', async () => {
  const state = { project: { currentProject: { name: 'Beach' }, currentProjectHandle: '/projects/beach' }, assets: [], imported: [], preview: null }
  const save = createVelornNetworkSaver({
    getProject: () => state.project, measureDuration: async url => (url.endsWith('.mp3') ? 211.4 : null),
    getAssets: () => ({ assets: state.assets, addAsset: asset => { const made = { id: `asset-${state.assets.length + 1}`, ...asset }; state.assets.push(made); return made }, setPreview: asset => { state.preview = asset.id } }),
    importFile: async (handle, file, category) => { state.imported.push({ name: file.name, type: file.type, category }); return { path: `assets/audio/${file.name}` } },
    makeFile: (parts, name, options) => ({ name, type: options.type, size: parts[0].byteLength }),
    resolveAssetUrl: async (handle, asset) => `file://${handle}/${asset.path}` })
  const song = { jobId: 'job-87654321', filename: 'velorn-network-job-876543.mp3', mimeType: 'audio/mpeg', bytes: new Uint8Array(4096), hostName: 'Studio 5090', prompt: 'anthemic rock' }
  assert.deepEqual(await save(song), { success: true, assetId: 'asset-1' })
  assert.deepEqual(state.imported, [{ name: 'velorn-network-job-876543.mp3', type: 'audio/mpeg', category: 'audio' }])
  assert.deepEqual([state.assets[0].type, state.assets[0].duration, state.preview], ['audio', 211.4, null])
  // The name and the type must agree: a sound is never taken under a clip's name, or the other way round.
  for (const bad of [{ ...song, jobId: 'job-22222222', filename: 'velorn-network-job-222222.mp4' }, { ...song, jobId: 'job-33333333', mimeType: 'video/mp4' },
    { ...song, jobId: 'job-44444444', filename: 'velorn-network-job-444444.flac' }, { ...song, jobId: 'job-55555555', mimeType: 'audio/wav' }]) {
    assert.equal((await save(bad)).success, false)
  }
  assert.equal(state.assets.length, 1)
})
