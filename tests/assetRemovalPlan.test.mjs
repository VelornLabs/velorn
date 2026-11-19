import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAssetRemovalPlan, describeAssetRemovalPlan, trashAssetRemovalPlan, claimAssetRemoval, assertAssetRemovalAllowsMcp } from '../src/services/assetRemovalPlan.mjs'
import { getAssetRemovalMode, setAssetRemovalMode, ASSET_REMOVAL_MODE_KEY } from '../src/services/assetRemovalPreferences.mjs'

const a = { id: 'a', name: 'A', path: 'assets/video/a.mp4', absolutePath: '/original/a.mp4', playbackCachePath: 'cache/a.mp4', proxyPath: 'proxy/a.mp4', sprite: { spritePath: '/project/thumb/a.jpg' } }
const plan = (assets = [a], assetIds = ['a'], projectRoot = '/project') => buildAssetRemovalPlan({ assets, assetIds, projectRoot })
test('fresh and legacy disk preferences default to keeping files', () => {
  const storage = { getItem: key => key === 'assetsDeleteMode' ? 'disk' : null }
  assert.equal(getAssetRemovalMode(storage), 'project-only')
  assert.equal(getAssetRemovalMode({ getItem() { throw Error('blocked') } }), 'project-only')
})
test('only a newly explicit trash preference enables Trash', () => {
  const data = new Map(), storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) }
  assert.deepEqual(setAssetRemovalMode('trash', storage), { success: true, mode: 'trash' })
  assert.equal(data.get(ASSET_REMOVAL_MODE_KEY), 'trash')
  assert.equal(getAssetRemovalMode(storage), 'trash')
  assert.equal(setAssetRemovalMode('disk', storage).success, false)
  assert.equal(setAssetRemovalMode('project-only', { setItem() { throw Error('quota') } }).success, false)
})
test('inventory covers explicit media/cache files, never the imported original or recursive directories', () => {
  const p = plan()
  assert.deepEqual(p.files.map(f => f.path), ['/project/assets/video/a.mp4', '/project/cache/a.mp4', '/project/proxy/a.mp4', '/project/thumb/a.jpg'])
  assert.ok(p.files.every(f => !f.external))
})
test('shared relative and absolute aliases are protected across all file kinds', () => {
  const p = plan([a, { id: 'b', absolutePath: '/project/assets/video/a.mp4', path: null, proxyPath: 'cache/a.mp4', poster: { posterPath: '/project/thumb/a.jpg' } }])
  assert.deepEqual(p.files.map(f => f.path), ['/project/proxy/a.mp4'])
  assert.equal(p.sharedPaths.length, 3)
  assert.equal(p.protectedPaths.length, 3)
})
test('multiple selected copies deduplicate native targets', () => {
  const p = plan([a, { ...a, id: 'b' }], ['a', 'b', 'a'])
  assert.equal(p.files.length, 4)
  assert.deepEqual(p.assetIds, ['a', 'b'])
})
test('external originals get an explicit warning and complete reviewed path', () => {
  const p = plan([{ id: 'a', absolutePath: '/original/movie.mov' }])
  assert.equal(p.files[0].external, true)
  assert.match(describeAssetRemovalPlan(p), /OUTSIDE.*project folder/)
  assert.match(describeAssetRemovalPlan(p), /\[EXTERNAL\] \/original\/movie.mov/)
})
test('shared-only and in-memory assets require no native file calls', async () => {
  const p = plan([{ id: 'a', url: 'blob:test' }])
  assert.equal(p.files.length, 0)
  assert.match(describeAssetRemovalPlan(p), /Only project entries/)
  assert.equal((await trashAssetRemovalPlan(p, {})).success, true)
})
test('Windows paths normalize separators and protect case aliases', () => {
  const p = plan([{ id: 'a', path: 'assets\\a.mp4' }, { id: 'b', absolutePath: 'c:\\PROJECT\\assets\\A.mp4' }], ['a'], 'C:\\project')
  assert.equal(p.files.length, 0)
  assert.equal(p.sharedPaths.length, 1)
})
for (const path of ['../secret', 'assets/../../secret', 'assets/./a', 'assets//a', 'assets/\0a']) {
  test(`unsafe project-relative path is rejected: ${JSON.stringify(path)}`, () => assert.throws(() => plan([{ id: 'a', path }])))
}
test('legacy absolute asset.path is an exact file with external disclosure, and protects shared references', () => {
  const p = plan([{ id: 'a', path: '/external/original.mp4' }])
  assert.equal(p.files[0].external, true)
  assert.equal(p.files[0].path, '/external/original.mp4')
  const shared = plan([{ id: 'a', absolutePath: '/external/original.mp4' }, { id: 'b', path: '/external/original.mp4' }])
  assert.equal(shared.files.length, 0)
  assert.equal(plan([{ id: 'a', path: 'C:\\External\\original.mp4' }]).files[0].external, true)
})
test('in-flight removal guard survives panel remounts and gates new MCP writes until release', () => {
  const release = claimAssetRemoval()
  assert.equal(typeof release, 'function')
  try {
    assert.equal(claimAssetRemoval(), null)
    assert.doesNotThrow(() => assertAssetRemovalAllowsMcp('get_assets'))
    for (const action of ['open_project', 'import_asset', 'move_clips', 'get_music_generation_status', 'future_action']) assert.throws(() => assertAssetRemovalAllowsMcp(action), { code: 'ASSET_REMOVAL_IN_PROGRESS' })
  } finally { release() }
  assert.doesNotThrow(() => assertAssetRemovalAllowsMcp('open_project'))
  const next = claimAssetRemoval(); assert.equal(typeof next, 'function'); next()
})
test('unresolvable local project or a stale selection fails closed', () => {
  assert.throws(() => plan([a], ['a'], null), /local project/)
  assert.throws(() => plan([a], ['unknown']), /selection changed/)
  assert.throws(() => plan([{ id: 'a', absolutePath: 'file:///some/file' }]), /absolute/)
})
test('dispatch sends precisely the reviewed plan and protected paths', async () => {
  const p = plan()
  let sent
  const response = await trashAssetRemovalPlan(p, { trashAssetFiles: async payload => {
    sent = payload
    return { success: true, results: payload.paths.map(path => ({ path, success: true })) }
  } })
  assert.equal(response.success, true)
  assert.deepEqual(sent, { paths: p.files.map(f => f.path), protectedPaths: [] })
})
test('missing bridge never invokes permanent delete fallback', async () => {
  let deleted = false
  await assert.rejects(trashAssetRemovalPlan(plan(), { deleteFile() { deleted = true } }), /reopen.*updated/)
  assert.equal(deleted, false)
})
test('Windows native-normalized result paths acknowledge the same reviewed file', async () => {
  const p = plan([{ id: 'a', path: 'assets/a.png' }], ['a'], 'C:\\project')
  const result = await trashAssetRemovalPlan(p, { trashAssetFiles: async () => ({ success: true, results: [{ path: 'C:\\project\\assets\\a.png', success: true }] }) })
  assert.equal(result.success, true)
})
test('partial Trash failures explain recovery and preserve project entries', async () => {
  await assert.rejects(trashAssetRemovalPlan(plan(), { trashAssetFiles: async ({ paths }) => ({ success: false, results: [
    { path: paths[0], success: true }, { path: paths[1], success: false, error: 'Permission denied' },
  ] }) }), /1 file\(s\) were moved.*Project entries were kept[\s\S]*Permission denied/)
})
test('missing or mismatched acknowledgement cannot claim success', async () => {
  for (const response of [null, { success: true }, { success: true, results: [{ path: '/not-reviewed', success: true }] }]) {
    await assert.rejects(trashAssetRemovalPlan(plan(), { trashAssetFiles: async () => response }), /Project entries were kept/)
  }
})
