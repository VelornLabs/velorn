import test from 'node:test'
import assert from 'node:assert/strict'
import {
  WORKFLOW_ORGANIZATION_SETTING_KEY,
  normalizeWorkflowOrganization,
  createWorkflowFolder,
  renameWorkflowFolder,
  removeWorkflowFolder,
  updateWorkflowEntry,
  sortWorkflowLibrary,
  loadWorkflowOrganization,
  updateWorkflowOrganization,
} from '../src/services/workflowLibraryOrganization.mjs'

const empty = () => ({ version: 1, folders: [], entries: {}, sort: 'recent' })
const clone = (value) => value === undefined ? undefined : structuredClone(value)

function bridgeFixture(initial) {
  let stored = clone(initial)
  const calls = []
  const bridge = {
    async getSetting(key) {
      calls.push(['get', key])
      return clone(stored)
    },
    async setSetting(key, value) {
      calls.push(['set', key, clone(value)])
      stored = clone(value)
      return { success: true }
    },
  }
  globalThis.window = { electronAPI: bridge }
  return { bridge, calls, stored: () => clone(stored) }
}

test('missing organization has independent empty defaults without writing', async () => {
  const fixture = bridgeFixture(null)
  assert.deepEqual(await loadWorkflowOrganization(), empty())
  assert.deepEqual(fixture.calls, [['get', WORKFLOW_ORGANIZATION_SETTING_KEY]])
  const first = normalizeWorkflowOrganization(undefined)
  first.folders.push({ id: 'anything', name: 'anything' })
  assert.deepEqual(normalizeWorkflowOrganization(null), empty())
})

test('folder creation, renaming and removal are immutable and only unfile entries', () => {
  const start = empty()
  const created = createWorkflowFolder(start, '  Music videos  ')
  const folderId = created.folders[0].id
  assert.equal(created.folders[0].name, 'Music videos')
  assert.deepEqual(start, empty())
  const assigned = updateWorkflowEntry(created, 'my-workflow:portrait', { favorite: true, folderId })
  const orphan = updateWorkflowEntry(assigned, 'tpl-mcp-not-currently-listed', { folderId })
  const renamed = renameWorkflowFolder(orphan, folderId, 'Music videos 2026')
  assert.equal(renamed.folders[0].name, 'Music videos 2026')
  assert.equal(orphan.folders[0].name, 'Music videos')
  const removed = removeWorkflowFolder(renamed, folderId)
  assert.deepEqual(removed.folders, [])
  assert.deepEqual(removed.entries['my-workflow:portrait'], { favorite: true, folderId: null })
  assert.deepEqual(removed.entries['tpl-mcp-not-currently-listed'], { favorite: false, folderId: null })
  assert.equal(renamed.entries['my-workflow:portrait'].folderId, folderId)
})

test('folder names are bounded, required and unique without case duplicates', () => {
  const created = createWorkflowFolder(empty(), 'Ads')
  assert.throws(() => createWorkflowFolder(created, ' ads '), /already exists/)
  assert.throws(() => createWorkflowFolder(created, ' '), /Enter a folder name/)
  assert.throws(() => createWorkflowFolder(created, 'a'.repeat(81)), /80 characters/)
  assert.throws(() => createWorkflowFolder(created, 'Name\nName'), /control characters/)
  const second = createWorkflowFolder(created, 'Experiments')
  assert.throws(() => renameWorkflowFolder(second, second.folders[1].id, 'ADS'), /already exists/)
  assert.throws(() => renameWorkflowFolder(second, 'not-there', 'New name'), /no longer exists/)
  assert.throws(() => removeWorkflowFolder(second, 'not-there'), /no longer exists/)
  assert.equal(renameWorkflowFolder(created, created.folders[0].id, 'ADS').folders[0].name, 'ADS')
})

test('normalization clones state and retains IDs unavailable from the current catalog', () => {
  const state = {
    ...empty(),
    entries: { 'tpl-mcp-disconnected': { favorite: true, folderId: 'folder-restored-later' } },
  }
  const normalized = normalizeWorkflowOrganization(state)
  assert.deepEqual(normalized, state)
  normalized.entries['tpl-mcp-disconnected'].favorite = false
  assert.equal(state.entries['tpl-mcp-disconnected'].favorite, true)
  assert.deepEqual(sortWorkflowLibrary([], state), [])
  assert.equal(state.entries['tpl-mcp-disconnected'].favorite, true)
  assert.equal(updateWorkflowEntry(state, 'tpl-mcp-disconnected', { favorite: false }).entries['tpl-mcp-disconnected'].folderId, 'folder-restored-later')
})

test('invalid records, newer versions and prototype keys are rejected', () => {
  for (const state of [false, [], 'old JSON', { ...empty(), version: 2 }, { ...empty(), unknown: true },
    { ...empty(), folders: [{ id: 'folder-a', name: 'A' }, { id: 'folder-a', name: 'B' }] },
    { ...empty(), entries: { a: { favorite: 'yes', folderId: null } } },
    { ...empty(), entries: { a: { favorite: true, folderId: null, futureField: true } } },
    { ...empty(), entries: JSON.parse('{"__proto__":{"favorite":true,"folderId":null}}') },
    { ...empty(), sort: 'oldest' },
  ]) assert.throws(() => normalizeWorkflowOrganization(state))
  assert.throws(() => updateWorkflowEntry(empty(), '__proto__', { favorite: true }))
  assert.throws(() => updateWorkflowEntry(empty(), 'good', { favorite: 'true' }))
  assert.throws(() => updateWorkflowEntry(empty(), 'good', { folderId: 'missing' }), /no longer exists/)
  assert.throws(() => updateWorkflowEntry(empty(), 'good', { description: 'not metadata' }), /unsupported fields/)
})

test('favorites stay first with name or recent sorting and the input list is unchanged', () => {
  const workflows = [
    { id: 'b', title: 'Workflow 10', updatedAt: 30 },
    { id: 'a', title: 'Workflow 2', updatedAt: 10 },
    { id: 'c', title: 'A favorite', updatedAt: 1 },
    { id: 'd', title: 'Another favorite', updatedAt: 2 },
  ]
  const state = updateWorkflowEntry(updateWorkflowEntry(empty(), 'c', { favorite: true }), 'd', { favorite: true })
  assert.deepEqual(sortWorkflowLibrary(workflows, state).map((entry) => entry.id), ['d', 'c', 'b', 'a'])
  assert.deepEqual(sortWorkflowLibrary(workflows, { ...state, sort: 'name' }).map((entry) => entry.id), ['c', 'd', 'a', 'b'])
  assert.deepEqual(workflows.map((entry) => entry.id), ['b', 'a', 'c', 'd'])
})

test('concurrent updates are serialized and persisted metadata survives a fresh load', async () => {
  const fixture = bridgeFixture(empty())
  let release
  const held = new Promise((resolve) => { release = resolve })
  const realSet = fixture.bridge.setSetting
  let writes = 0
  fixture.bridge.setSetting = async (...args) => {
    if (++writes === 1) await held
    return realSet(...args)
  }
  const first = updateWorkflowOrganization((state) => createWorkflowFolder(state, 'Music videos'))
  const second = updateWorkflowOrganization((state) => updateWorkflowEntry(state, 'my-workflow:portrait', { favorite: true, folderId: state.folders[0].id }))
  const third = updateWorkflowOrganization((state) => ({ ...state, sort: 'name' }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixture.calls.length, 1)
  release()
  await Promise.all([first, second, third])
  const loaded = await loadWorkflowOrganization()
  assert.equal(loaded.folders[0].name, 'Music videos')
  assert.deepEqual(loaded.entries['my-workflow:portrait'], { favorite: true, folderId: loaded.folders[0].id })
  assert.equal(loaded.sort, 'name')
  assert.deepEqual(loaded, fixture.stored())
})

test('a failed native write is reported and does not poison future updates', async () => {
  const fixture = bridgeFixture(empty())
  const realSet = fixture.bridge.setSetting
  fixture.bridge.setSetting = async () => ({ success: false, error: 'Disk is full.' })
  await assert.rejects(updateWorkflowOrganization((state) => createWorkflowFolder(state, 'Unsaved')), /Disk is full/)
  assert.deepEqual(fixture.stored(), empty())
  fixture.bridge.setSetting = realSet
  await updateWorkflowOrganization((state) => createWorkflowFolder(state, 'Saved'))
  assert.deepEqual(fixture.stored().folders.map((folder) => folder.name), ['Saved'])
})

test('missing acknowledgements and rejected settings requests fail visibly', async () => {
  const fixture = bridgeFixture(empty())
  fixture.bridge.setSetting = async () => undefined
  await assert.rejects(updateWorkflowOrganization((state) => ({ ...state, sort: 'name' })), /Could not save/)
  fixture.bridge.setSetting = async () => { throw new Error('Write denied.') }
  await assert.rejects(updateWorkflowOrganization((state) => state), /Could not save.*Write denied/)
  fixture.bridge.getSetting = async () => { throw new Error('Read failed.') }
  await assert.rejects(loadWorkflowOrganization(), /Could not load.*Read failed/)
})

test('unsupported saved data is never overwritten by a later mutation', async () => {
  for (const initial of [{ version: 2 }, { ...empty(), entries: 'broken' }]) {
    const fixture = bridgeFixture(initial)
    await assert.rejects(updateWorkflowOrganization((state) => createWorkflowFolder(state, 'New')))
    assert.deepEqual(fixture.stored(), initial)
    assert.equal(fixture.calls.some(([kind]) => kind === 'set'), false)
  }
})

test('invalid or throwing mutators never clear or save existing organization', async () => {
  const initial = createWorkflowFolder(empty(), 'Existing')
  const fixture = bridgeFixture(initial)
  await assert.rejects(updateWorkflowOrganization(() => undefined), /Nothing was saved/)
  await assert.rejects(updateWorkflowOrganization(() => null), /Nothing was saved/)
  await assert.rejects(updateWorkflowOrganization(() => { throw new Error('Invalid edit.') }), /Invalid edit/)
  assert.deepEqual(fixture.stored(), initial)
  assert.equal(fixture.calls.some(([kind]) => kind === 'set'), false)
})

test('missing desktop bridge reports organization unavailable without other actions', async () => {
  globalThis.window = {}
  await assert.rejects(loadWorkflowOrganization(), /storage is unavailable/)
  await assert.rejects(updateWorkflowOrganization((state) => state), /storage is unavailable/)
  delete globalThis.window
  await assert.rejects(loadWorkflowOrganization(), /storage is unavailable/)
})
