// Saving a ComfyUI capture into My Workflows: a second save under a name that
// exists is a second workflow unless the person chose to replace, and one can be deleted.
import test from 'node:test'
import assert from 'node:assert/strict'

import fs from 'node:fs'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'

// The real renderer service, run with only its imports and the desktop boundary replaced (as tests/workflowLibraryRenderer.test.mjs does).
const files = new Map()
const source = fs.readFileSync(new URL('../src/services/customWorkflowLibrary.js', import.meta.url), 'utf8').replace(/^import[\s\S]*? from '[^']+'\n/gm, '').replace(/^export /gm, '')
const window = { dispatchEvent() {}, electronAPI: {
  getAppPath: async () => '/data', pathJoin: async (...parts) => parts.join('/'), createDirectory: async () => ({ success: true }),
  listDirectory: async dir => ({ success: true, items: [...files.keys()].filter(name => name.startsWith(dir + '/')).map(name => name.slice(dir.length + 1)) }),
  readFile: async file => files.has(file) ? { success: true, data: files.get(file) } : { success: false },
  writeFile: async (file, data) => { files.set(file, data); return { success: true } },
  deleteFile: async file => { files.delete(file); return { success: true } },
} }
const context = vm.createContext({ window, globalThis: { crypto: { randomUUID } }, CustomEvent: class { constructor(type) { this.type = type } }, console, Date, JSON, Promise, Map, Set, Array, Object, String, Number, Boolean, Error })
const library = vm.runInContext(`${source}\n;({ saveCapturedGraphToLibrary, findCustomLibraryWorkflowsByTitle, updateCustomLibraryWorkflowMetadata, deleteCustomLibraryWorkflow })`, context)
const capture = text => ({ workflowName: 'cats', workflow: { nodes: [{ id: 1 }, { id: 2 }] }, output: { 1: { class_type: 'CLIPTextEncode', inputs: { text } } } })

test('a name that exists is found, replacing keeps the workflow\'s identity and description, and keeping both adds a second', async () => {
  const first = await library.saveCapturedGraphToLibrary(capture('one'), 'My cats')
  assert.equal(first.updated, false); assert.match(first.entry.id, /^my-cats-[0-9a-f-]{36}$/)
  await library.updateCustomLibraryWorkflowMetadata(first.entry.id, { description: 'Soft light, tabby' })
  assert.deepEqual([...(await library.findCustomLibraryWorkflowsByTitle('  my CATS '))].map(entry => entry.id), [first.entry.id])
  assert.equal((await library.findCustomLibraryWorkflowsByTitle('dogs')).length, 0); assert.equal((await library.findCustomLibraryWorkflowsByTitle('')).length, 0)
  // Replace: same id, same file, new graph, description kept.
  const replaced = await library.saveCapturedGraphToLibrary(capture('two'), 'My cats', { replaceId: first.entry.id })
  assert.deepEqual([replaced.updated, replaced.entry.id, files.size], [true, first.entry.id, 1])
  const onDisk = JSON.parse([...files.values()][0])
  assert.deepEqual([onDisk.apiWorkflow['1'].inputs.text, onDisk.description, onDisk.title, onDisk.id], ['two', 'Soft light, tabby', 'My cats', first.entry.id])
  assert.ok(onDisk.updatedAt >= onDisk.savedAt)
  // Keep both: a second workflow under the same name.
  const second = await library.saveCapturedGraphToLibrary(capture('three'), 'My cats')
  assert.equal(second.updated, false); assert.notEqual(second.entry.id, first.entry.id); assert.equal(files.size, 2)
  assert.equal((await library.findCustomLibraryWorkflowsByTitle('My cats')).length, 2)
  await assert.rejects(library.saveCapturedGraphToLibrary(capture('x'), 'My cats', { replaceId: 'not-there' }), /no longer in My Workflows/)
  // Delete one: its file goes, the other stays.
  assert.equal(await library.deleteCustomLibraryWorkflow(first.entry.id), true)
  assert.deepEqual([files.size, [...(await library.findCustomLibraryWorkflowsByTitle('My cats'))].map(entry => entry.id)], [1, [second.entry.id]])
  assert.equal(await library.deleteCustomLibraryWorkflow(first.entry.id), false)
})
