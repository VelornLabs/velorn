import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
import { createAssetBrowserStore } from '../src/stores/assetBrowserStore.mjs'

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial)), writes = []
  return { data, writes, getItem: key => data.get(key) ?? null,
    setItem(key, value) { writes.push([key, value]); data.set(key, value) } }
}

function browse(store) {
  const state = store.getState()
  state.setCurrentFolderId('folder-2')
  state.setSearchQuery('portrait')
  state.setExpandedFolderIds(new Set(['folder-1', 'folder-2']))
  state.setScrollTop(345.5)
}

test('browser factory defaults to root grid with independent transient sessions', () => {
  const first = createAssetBrowserStore({ storage: null }), second = createAssetBrowserStore({ storage: null })
  browse(first)
  const state = second.getState()
  assert.equal(state.viewMode, 'grid')
  assert.equal(state.currentFolderId, null)
  assert.equal(state.searchQuery, '')
  assert.equal(state.expandedFolderIds.size, 0)
  assert.equal(state.scrollTop, 0)
  assert.equal(state.projectSession, 0)
})

test('valid grid/list preferences survive a new store while invalid saved values use grid', () => {
  for (const value of ['grid', 'list', 'tiles', '', '{"view":"list"}']) {
    const storage = memoryStorage({ assetsViewMode: value })
    assert.equal(createAssetBrowserStore({ storage }).getState().viewMode, value === 'list' ? 'list' : 'grid')
  }
  const storage = memoryStorage(), first = createAssetBrowserStore({ storage })
  first.getState().setViewMode('list')
  assert.equal(createAssetBrowserStore({ storage }).getState().viewMode, 'list')
  assert.deepEqual(storage.writes, [['assetsViewMode', 'list']])
})

test('only the view preference persists; folder, search, expansion, scroll and session never do', () => {
  const storage = memoryStorage(), store = createAssetBrowserStore({ storage })
  store.getState().setViewMode('list')
  browse(store)
  store.getState().pruneFolders([{ id: 'folder-1' }])
  store.getState().resetProject()
  browse(store)
  assert.deepEqual([...storage.data.entries()], [['assetsViewMode', 'list']])
  assert.equal(storage.writes.length, 1)
  const restarted = createAssetBrowserStore({ storage }).getState()
  assert.equal(restarted.viewMode, 'list')
  assert.equal(restarted.currentFolderId, null)
  assert.equal(restarted.searchQuery, '')
  assert.equal(restarted.expandedFolderIds.size, 0)
  assert.equal(restarted.scrollTop, 0)
  assert.equal(restarted.projectSession, 0)
})

test('view and search setters reject invalid values without losing browse context', () => {
  const storage = memoryStorage(), store = createAssetBrowserStore({ storage })
  browse(store)
  const before = store.getState()
  for (const value of [undefined, null, false, 123, {}, [], 'tiles']) store.getState().setViewMode(value)
  for (const value of [undefined, null, false, 123, {}, []]) store.getState().setSearchQuery(value)
  assert.equal(store.getState(), before)
  assert.equal(store.getState().scrollTop, 345.5)
  assert.deepEqual(storage.writes, [])
})

test('functional updates use current values and navigation resets scroll only when changed', () => {
  const store = createAssetBrowserStore({ storage: null }), state = store.getState()
  state.setViewMode(previous => previous === 'grid' ? 'list' : 'grid')
  state.setCurrentFolderId(previous => previous === null ? 'folder-1' : null)
  state.setSearchQuery(previous => `${previous}dog`)
  state.setExpandedFolderIds(previous => new Set([...previous, 'folder-1']))
  assert.equal(store.getState().viewMode, 'list')
  assert.equal(store.getState().currentFolderId, 'folder-1')
  assert.equal(store.getState().searchQuery, 'dog')
  assert.deepEqual([...store.getState().expandedFolderIds], ['folder-1'])
  for (const [setter, value] of [['setViewMode', 'list'], ['setCurrentFolderId', 'folder-1'], ['setSearchQuery', 'dog']]) {
    state.setScrollTop(75)
    const before = store.getState()
    state[setter](previous => previous)
    state[setter](value)
    assert.equal(store.getState(), before)
  }
  state.setCurrentFolderId('folder-2')
  assert.equal(store.getState().scrollTop, 0)
  state.setScrollTop(75); state.setSearchQuery('cat')
  assert.equal(store.getState().scrollTop, 0)
  state.setScrollTop(75); state.setViewMode('grid')
  assert.equal(store.getState().scrollTop, 0)
})

test('folder setters normalize missing or invalid identifiers to root', () => {
  const store = createAssetBrowserStore({ storage: null })
  for (const value of [undefined, null, '', false, 0, 25, {}, []]) {
    store.getState().setCurrentFolderId('folder-1')
    store.getState().setScrollTop(80)
    store.getState().setCurrentFolderId(value)
    assert.equal(store.getState().currentFolderId, null)
    assert.equal(store.getState().scrollTop, 0)
  }
})

test('expanded folder sets filter invalid IDs and do not retain caller-owned mutable sets', () => {
  const store = createAssetBrowserStore({ storage: null })
  const source = new Set(['folder-1', 'folder-2', '', null, 2])
  store.getState().setExpandedFolderIds(source)
  source.add('not-adopted')
  assert.deepEqual([...store.getState().expandedFolderIds], ['folder-1', 'folder-2'])
  const before = store.getState()
  for (const value of [undefined, null, [], {}, 'folder-1']) store.getState().setExpandedFolderIds(value)
  assert.equal(store.getState(), before)
  store.getState().setExpandedFolderIds(previous => new Set([...previous, 'folder-3']))
  assert.deepEqual([...store.getState().expandedFolderIds], ['folder-1', 'folder-2', 'folder-3'])
  assert.deepEqual([...before.expandedFolderIds], ['folder-1', 'folder-2'])
})

test('scroll positions remain finite and nonnegative and identical values are no-ops', () => {
  const store = createAssetBrowserStore({ storage: null }), state = store.getState()
  let updates = 0
  const unsubscribe = store.subscribe(() => updates++)
  state.setScrollTop(0)
  assert.equal(updates, 0)
  state.setScrollTop(123.75); state.setScrollTop(123.75)
  assert.equal(updates, 1)
  assert.equal(store.getState().scrollTop, 123.75)
  for (const value of [NaN, Infinity, -Infinity, -40, undefined, null, '200', {}]) {
    state.setScrollTop(200)
    state.setScrollTop(value)
    assert.equal(store.getState().scrollTop, 0)
  }
  const before = updates
  state.setScrollTop(NaN); state.setScrollTop(-1)
  assert.equal(updates, before)
  unsubscribe()
})

test('project reset clears all navigation while preserving view preference and advancing session', () => {
  const storage = memoryStorage(), store = createAssetBrowserStore({ storage })
  store.getState().setViewMode('list')
  for (let session = 1; session <= 2; session++) {
    browse(store)
    store.getState().resetProject()
    const state = store.getState()
    assert.equal(state.viewMode, 'list')
    assert.equal(state.currentFolderId, null)
    assert.equal(state.searchQuery, '')
    assert.equal(state.expandedFolderIds.size, 0)
    assert.equal(state.scrollTop, 0)
    assert.equal(state.projectSession, session)
  }
  assert.deepEqual(storage.writes, [['assetsViewMode', 'list']])
})

test('pruning a removed current folder falls back to root and keeps surviving expansions', () => {
  const store = createAssetBrowserStore({ storage: null })
  browse(store)
  store.getState().pruneFolders([{ id: 'folder-1' }, { id: 'folder-3' }])
  const state = store.getState()
  assert.equal(state.currentFolderId, null)
  assert.equal(state.scrollTop, 0)
  assert.equal(state.searchQuery, 'portrait')
  assert.deepEqual([...state.expandedFolderIds], ['folder-1'])
  assert.equal(state.projectSession, 0)
})

test('pruning unrelated folders preserves location and scroll and valid snapshots are no-ops', () => {
  const store = createAssetBrowserStore({ storage: null })
  browse(store)
  const before = store.getState()
  store.getState().pruneFolders([{ id: 'folder-1' }, { id: 'folder-2' }])
  assert.equal(store.getState(), before)
  store.getState().pruneFolders([{ id: 'folder-2' }])
  assert.equal(store.getState().currentFolderId, 'folder-2')
  assert.equal(store.getState().scrollTop, 345.5)
  assert.deepEqual([...store.getState().expandedFolderIds], ['folder-2'])
  store.getState().pruneFolders(null)
  assert.equal(store.getState().currentFolderId, null)
  assert.equal(store.getState().expandedFolderIds.size, 0)
})

test('storage read/write failures and inaccessible default localStorage cannot break browsing', () => {
  const storage = { getItem() { throw new Error('Blocked read') }, setItem() { throw new Error('Quota exceeded') } }
  const store = createAssetBrowserStore({ storage })
  assert.equal(store.getState().viewMode, 'grid')
  assert.doesNotThrow(() => store.getState().setViewMode('list'))
  assert.equal(store.getState().viewMode, 'list')
  browse(store)
  assert.equal(store.getState().currentFolderId, 'folder-2')
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage access denied') } })
    assert.equal(createAssetBrowserStore().getState().viewMode, 'grid')
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  }
})

const assetsSource = fs.readFileSync(new URL('../src/stores/assetsStore.js', import.meta.url), 'utf8')
const clearAction = assetsSource.slice(assetsSource.indexOf('  clearProject: () => {'), assetsSource.indexOf('  loadFromProject: async'))
const removeAction = assetsSource.slice(assetsSource.indexOf('  removeFolder: (folderId) => {'), assetsSource.indexOf('  renameFolder: (folderId, newName) => {'))

// Execute the real lifecycle bodies without importing Electron media loaders.
// The actual UI-import integration is exercised by the isolated panel fixture.
function assetsHarness({ denied = false } = {}) {
  const browser = createAssetBrowserStore({ storage: null }), revoked = [], guarded = []
  let assets = {
    folders: [{ id: 'folder-1', parentId: null }, { id: 'folder-2', parentId: 'folder-1' }, { id: 'folder-3', parentId: null }],
    assets: [{ id: 'parent', folderId: 'folder-1', url: 'blob:parent' },
      { id: 'child', folderId: 'folder-2', url: 'blob:child' },
      { id: 'other', folderId: 'folder-3', url: 'https://example.invalid/other' }],
  }
  const context = vm.createContext({ useAssetBrowserStore: browser,
    get: () => assets, set: patch => { assets = { ...assets, ...(typeof patch === 'function' ? patch(assets) : patch) } },
    URL: { revokeObjectURL: value => revoked.push(value) },
    checkCompoundAssetDeletion: ids => { guarded.push([...ids]); return denied ? { ok: false, reason: 'Referenced compound' } : { ok: true } },
  })
  vm.runInContext(`globalThis.actions = ({${removeAction}\n${clearAction}})`, context)
  return { browser, actions: context.actions, assets: () => assets, revoked, guarded }
}

test('real assets clearProject resets browsing before a new project can reuse folder IDs', () => {
  const h = assetsHarness()
  browse(h.browser); h.browser.getState().setViewMode('list')
  h.actions.clearProject()
  assert.equal(h.browser.getState().currentFolderId, null)
  assert.equal(h.browser.getState().expandedFolderIds.size, 0)
  assert.equal(h.browser.getState().searchQuery, '')
  assert.equal(h.browser.getState().scrollTop, 0)
  assert.equal(h.browser.getState().projectSession, 1)
  assert.equal(h.browser.getState().viewMode, 'list')
  assert.equal(h.assets().assets.length, 0)
  assert.equal(h.assets().folders.length, 0)
  assert.deepEqual(h.revoked, ['blob:parent', 'blob:child'])
})

test('real recursive removeFolder prunes hidden browser state along with removed descendants', () => {
  const h = assetsHarness()
  browse(h.browser)
  assert.equal(h.actions.removeFolder('folder-1').ok, true)
  assert.deepEqual(h.guarded, [['parent', 'child']])
  assert.deepEqual(h.assets().folders.map(folder => folder.id), ['folder-3'])
  assert.deepEqual(h.assets().assets.map(asset => asset.id), ['other'])
  assert.equal(h.browser.getState().currentFolderId, null)
  assert.equal(h.browser.getState().expandedFolderIds.size, 0)
  assert.equal(h.browser.getState().scrollTop, 0)
  assert.equal(h.browser.getState().projectSession, 0)
})

test('blocked or missing-folder deletion leaves browser context and asset data unchanged', () => {
  for (const missing of [false, true]) {
    const h = assetsHarness({ denied: !missing })
    browse(h.browser)
    const browser = h.browser.getState(), assets = h.assets()
    const result = h.actions.removeFolder(missing ? 'missing-folder' : 'folder-1')
    if (!missing) assert.equal(result.ok, false)
    assert.equal(h.browser.getState(), browser)
    assert.equal(h.assets(), assets)
  }
})
