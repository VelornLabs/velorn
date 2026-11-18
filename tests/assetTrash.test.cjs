const assert = require('node:assert/strict')
const test = require('node:test')
const { createAssetTrash } = require('../electron/assetTrash.cjs')

const missing = () => Object.assign(new Error('Missing file'), { code: 'ENOENT' })
const info = (changes = {}) => ({ dev: 1n, ino: 2n, mode: 33188n, size: 32n,
  birthtimeMs: 1n, mtimeMs: 2n, ctimeMs: 2n, isFile: () => true, isSymbolicLink: () => false, ...changes })
function fixture(options = {}) {
  const calls = [], files = new Map(), aliases = new Map()
  const api = createAssetTrash({ platform: 'linux', homeDir: '/home/test',
    lstat: async (target, flags) => { calls.push(['lstat', target, flags]); const value = files.get(target); if (!value) throw missing(); return value },
    realpath: async target => { calls.push(['realpath', target]); if (!files.has(target) && !aliases.has(target)) throw missing(); return aliases.get(target) || target },
    trashItem: async target => { calls.push(['trash', target]); files.delete(target) },
    ...options,
  })
  return { ...api, calls, files, aliases, moved: () => calls.filter(call => call[0] === 'trash').map(call => call[1]) }
}

test('only inspected, unchanged regular files are passed to the native Trash operation', async () => {
  const f = fixture(); f.files.set('/media/clip.mp4', info())
  assert.deepEqual(await f.trashAssetFiles({ paths: ['/media/clip.mp4'] }), { success: true, results: [{ path: '/media/clip.mp4', success: true }] })
  assert.deepEqual(f.calls.map(call => call[0]), ['lstat', 'realpath', 'lstat', 'trash'])
  assert.deepEqual(f.calls[0][2], { bigint: true })
})

test('malformed plans, relative paths, URLs, dot traversal and control characters do no work', async () => {
  const f = fixture()
  for (const payload of [null, [], {}, { paths: 'file' }, { paths: [null] }, { paths: ['../clip.mp4'] },
    { paths: ['file:///media/clip.mp4'] }, { paths: ['/media/../clip.mp4'] }, { paths: ['/media/./clip.mp4'] },
    { paths: ['/media/clip\0.mp4'] }, { paths: ['/media/clip\n.mp4'] }, { paths: ['/media/good.mp4', 'relative.mp4'] }]) {
    const result = await f.trashAssetFiles(payload)
    assert.equal(result.success, false); assert.deepEqual(result.results, [])
  }
  assert.deepEqual(f.calls, [])
})

test('whole plans enforce candidate and protected-reference count limits before any I/O', async () => {
  const f = fixture()
  assert.equal((await f.trashAssetFiles({ paths: Array(2001).fill('/media/a') })).success, false)
  assert.equal((await f.trashAssetFiles({ paths: ['/media/a'], protectedPaths: Array(10001).fill('/media/b') })).success, false)
  assert.equal((await f.trashAssetFiles({ paths: ['/media/a'], protectedPaths: 'not an array' })).success, false)
  assert.deepEqual(f.calls, [])
  assert.deepEqual(await f.trashAssetFiles({ paths: [] }), { success: true, results: [] })
})

test('root, home, configured protected folders and their ancestors are rejected lexically', async () => {
  const f = fixture({ protectedPaths: ['/work/project'] })
  for (const target of ['/', '/home', '/home/test', '/home/test/', '/work', '/work/project']) {
    assert.equal((await f.trashAssetFiles({ paths: [target] })).success, false, target)
  }
  assert.deepEqual(f.calls, [])
})

test('directories, target symlinks and special files are refused without invoking Trash', async () => {
  const f = fixture()
  f.files.set('/media/folder', info({ isFile: () => false }))
  f.files.set('/media/link', info({ isSymbolicLink: () => true }))
  f.files.set('/media/device', info({ isFile: () => false }))
  const result = await f.trashAssetFiles({ paths: [...f.files.keys()] })
  assert.equal(result.success, false); assert.equal(result.results.length, 3)
  assert.ok(result.results.every(item => !item.success))
  assert.deepEqual(f.moved(), [])
})

test('symlinked ancestor aliases are rejected rather than resolving and trashing their target', async () => {
  const f = fixture(); f.files.set('/alias/clip.mp4', info()); f.aliases.set('/alias/clip.mp4', '/actual/clip.mp4')
  const result = await f.trashAssetFiles({ paths: ['/alias/clip.mp4'] })
  assert.match(result.results[0].error, /symbolic links/); assert.deepEqual(f.moved(), [])
})

test('missing files are successful no-ops but inspection errors retain per-file failures', async () => {
  const f = fixture({ lstat: async target => { if (target.endsWith('missing')) throw missing(); throw Object.assign(new Error('Permission denied'), { code: 'EACCES' }) } })
  const result = await f.trashAssetFiles({ paths: ['/media/missing', '/media/locked'] })
  assert.equal(result.success, false)
  assert.deepEqual(result.results[0], { path: '/media/missing', success: true, missing: true })
  assert.match(result.results[1].error, /Permission denied/)
  assert.deepEqual(f.moved(), [])
})

test('duplicate normalized paths are moved once, with no substring matching', async () => {
  const f = fixture(); f.files.set('/media/clip.mp4', info()); f.files.set('/media/clip.mp4.copy', info({ ino: 3n }))
  const result = await f.trashAssetFiles({ paths: ['/media/clip.mp4', '/media//clip.mp4', '/media/clip.mp4.copy'] })
  assert.equal(result.success, true); assert.equal(result.results.length, 2)
  assert.deepEqual(f.moved(), ['/media/clip.mp4', '/media/clip.mp4.copy'])
})

test('remaining assets protect both exact file paths and paths reached through their aliases', async () => {
  const f = fixture()
  f.files.set('/media/shared.mp4', info()); f.files.set('/media/unique.mp4', info({ ino: 3n }))
  f.aliases.set('/references/shared.mp4', '/media/shared.mp4')
  const result = await f.trashAssetFiles({ paths: ['/media/shared.mp4', '/media/unique.mp4'], protectedPaths: ['/references/shared.mp4'] })
  assert.equal(result.success, false); assert.match(result.results[0].error, /another asset/)
  assert.deepEqual(f.moved(), ['/media/unique.mp4'])
  assert.equal(f.calls[0][0], 'realpath')
})

test('unverifiable remaining-asset paths fail the entire plan before any movement', async () => {
  const f = fixture({ realpath: async () => { throw Object.assign(new Error('Permission denied'), { code: 'EACCES' }) } })
  f.files.set('/media/clip.mp4', info())
  const result = await f.trashAssetFiles({ paths: ['/media/clip.mp4'], protectedPaths: ['/locked/shared.mp4'] })
  assert.equal(result.success, false); assert.deepEqual(result.results, [])
  assert.match(result.error, /No files were moved/); assert.deepEqual(f.moved(), [])
})

test('missing protected references are harmless while direct matching references still protect a path', async () => {
  const f = fixture(); f.files.set('/media/clip.mp4', info())
  assert.equal((await f.trashAssetFiles({ paths: ['/media/clip.mp4'], protectedPaths: ['/missing/old.mp4'] })).success, true)
  const second = await f.trashAssetFiles({ paths: ['/missing/shared.mp4'], protectedPaths: ['/missing/shared.mp4'] })
  assert.equal(second.success, false); assert.match(second.results[0].error, /another asset/)
})

test('file identity changes and replacement directories or links are refused after async inspection', async () => {
  for (const replacement of [info({ ino: 44n }), info({ mtimeMs: 3n }), info({ isFile: () => false }), info({ isSymbolicLink: () => true })]) {
    let reads = 0
    const f = fixture({ lstat: async () => ++reads === 1 ? info() : replacement, realpath: async target => target })
    assert.equal((await f.trashAssetFiles({ paths: ['/media/clip.mp4'] })).success, false)
    assert.deepEqual(f.moved(), [])
  }
})

test('incomplete native file identity fails closed', async () => {
  const f = fixture(); f.files.set('/media/clip.mp4', info({ ino: undefined }))
  assert.match((await f.trashAssetFiles({ paths: ['/media/clip.mp4'] })).results[0].error, /identity/)
  assert.deepEqual(f.moved(), [])
})

test('native Trash rejection never falls back to permanent removal and later files still report outcomes', async () => {
  const moved = []
  const f = fixture({ trashItem: async target => { if (target.endsWith('locked.mp4')) throw new Error('Trash is unavailable'); moved.push(target) } })
  f.files.set('/media/locked.mp4', info()); f.files.set('/media/clip.mp4', info())
  const result = await f.trashAssetFiles({ paths: ['/media/locked.mp4', '/media/clip.mp4'] })
  assert.equal(result.success, false); assert.match(result.results[0].error, /Trash is unavailable/)
  assert.equal(result.results[1].success, true); assert.deepEqual(moved, ['/media/clip.mp4'])
  assert.ok(f.files.has('/media/locked.mp4'))
})

test('a missing native Trash utility is not mistaken for a missing asset file', async () => {
  const f = fixture({ trashItem: async () => { throw Object.assign(new Error('Trash utility unavailable'), { code: 'ENOENT' }) } })
  f.files.set('/media/clip.mp4', info())
  const result = await f.trashAssetFiles({ paths: ['/media/clip.mp4'] })
  assert.equal(result.success, false); assert.equal(result.results[0].missing, undefined)
  assert.match(result.results[0].error, /utility unavailable/)
  assert.ok(f.files.has('/media/clip.mp4'))
})

test('separate batches and per-file native moves are serialized, and submitted plans are copied', async () => {
  const pending = [], moved = []
  const f = fixture({ trashItem: async target => { moved.push(target); await new Promise(resolve => pending.push(resolve)) } })
  for (const name of ['a', 'b', 'c']) f.files.set(`/media/${name}`, info())
  const plan = { paths: ['/media/a', '/media/b'] }
  const first = f.trashAssetFiles(plan), second = f.trashAssetFiles({ paths: ['/media/c'] })
  plan.paths[0] = '/media/unreviewed'
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(moved, ['/media/a']); pending.shift()()
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(moved, ['/media/a', '/media/b']); pending.shift()()
  await first; await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(moved, ['/media/a', '/media/b', '/media/c']); pending.shift()()
  assert.equal((await second).success, true)
})

test('macOS uses exact POSIX paths and preserves case-distinct filenames', async () => {
  const f = fixture({ platform: 'darwin', homeDir: '/Users/Test' })
  f.files.set('/Volumes/Media/Clip.mov', info()); f.files.set('/Volumes/Media/clip.mov', info({ ino: 3n }))
  assert.equal((await f.trashAssetFiles({ paths: [...f.files.keys()] })).success, true)
  assert.equal(f.moved().length, 2)
  assert.equal((await f.trashAssetFiles({ paths: ['/Users/Test'] })).success, false)
})

test('Windows accepts drive and UNC files, deduplicating drive casing and separators', async () => {
  const f = fixture({ platform: 'win32', homeDir: 'C:\\Users\\Test' })
  f.files.set('D:\\Media\\clip.mp4', info()); f.files.set('\\\\server\\share\\clip.mp4', info({ ino: 3n }))
  const result = await f.trashAssetFiles({ paths: ['D:\\Media\\clip.mp4', 'd:/media/clip.mp4', '\\\\server\\share\\clip.mp4'] })
  assert.equal(result.success, true); assert.equal(result.results.length, 2)
  assert.deepEqual(f.moved(), ['D:\\Media\\clip.mp4', '\\\\server\\share\\clip.mp4'])
})

test('Windows rejects drive roots, home, incomplete absolute paths, devices, ADS and ambiguous names', async () => {
  const f = fixture({ platform: 'win32', homeDir: 'C:\\Users\\Test' })
  for (const target of ['C:\\', 'C:\\Users', 'c:\\users\\test', '\\\\server\\share\\', '\\Media\\clip.mp4', 'C:clip.mp4',
    '\\\\?\\C:\\Media\\clip.mp4', '\\\\.\\C:\\Media\\clip.mp4', 'C:\\Media\\clip.mp4:stream', 'C:\\Media\\CON',
    'C:\\Media\\clip.mp4.', 'C:\\Media\\clip.mp4 ', 'C:\\Media\\..\\clip.mp4']) {
    assert.equal((await f.trashAssetFiles({ paths: [target] })).success, false, target)
  }
  assert.deepEqual(f.calls, [])
})

test('Windows canonical protected aliases match case-insensitively', async () => {
  const f = fixture({ platform: 'win32', homeDir: 'C:\\Users\\Test' })
  f.files.set('D:\\Media\\clip.mp4', info()); f.aliases.set('D:\\Links\\clip.mp4', 'd:\\media\\CLIP.mp4')
  const result = await f.trashAssetFiles({ paths: ['D:\\Media\\clip.mp4'], protectedPaths: ['D:\\Links\\clip.mp4'] })
  assert.equal(result.success, false); assert.match(result.results[0].error, /another asset/)
  assert.deepEqual(f.moved(), [])
})
