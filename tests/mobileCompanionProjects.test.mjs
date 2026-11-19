import test from 'node:test'
import assert from 'node:assert/strict'
import { createMobileProjectController } from '../src/services/mobileCompanionProjects.mjs'
function fixture(options = {}) {
  let dirty = Boolean(options.dirty), revision = 0, saved = 0, opened = []
  const state = { currentProjectHandle: '/synthetic/a', currentProject: { name: 'A' }, defaultProjectsHandle: '/synthetic', recentProjects: [],
    async saveProject() { saved++; if (options.saveFails) return false; dirty = false; if (options.editDuringSave) revision++; return true },
    async openProject(path) { opened.push(path); return {} } }
  let count = 0
  const controller = createMobileProjectController({ getState: () => state, listProjects: async () => [{ name: 'A', path: '/synthetic/a' },{ name: 'B', path: '/synthetic/b' }],
    isDirty: () => dirty, editIdentity: () => revision, uuid: () => `id-${++count}` })
  return { controller, opened, get saved() { return saved } }
}
test('project catalog deduplicates paths and only exports stable opaque identities', async () => {
  const f = fixture(), first = await f.controller.list()
  assert.equal(first.length,2); assert.equal(JSON.stringify(first).includes('/synthetic'),false)
  assert.deepEqual(await f.controller.list(),first)
  await assert.rejects(f.controller.open('/synthetic/b',true,() => true))
  assert.deepEqual(f.opened,[])
})
test('save and open preserves dirty work; failed saves or edits during save block opening', async () => {
  for (const options of [{dirty:true},{dirty:true,saveFails:true},{dirty:true,editDuringSave:true}]) {
    const f = fixture(options), target = (await f.controller.list())[1]
    await assert.rejects(f.controller.open(target.id,false,() => true))
    if (options.saveFails || options.editDuringSave) await assert.rejects(f.controller.open(target.id,true,() => true))
    else await f.controller.open(target.id,true,() => true)
    assert.equal(f.saved,1); assert.equal(f.opened.length,options.saveFails || options.editDuringSave ? 0 : 1)
  }
})
test('stale desktop context prevents opening', async () => {
  const f = fixture(), target = (await f.controller.list())[1]
  await assert.rejects(f.controller.open(target.id,true,() => false)); assert.deepEqual(f.opened,[])
})
