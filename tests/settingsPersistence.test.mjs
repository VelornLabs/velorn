import test from 'node:test'
import assert from 'node:assert/strict'
import { setPexelsApiKey } from '../src/services/pexelsSettings.js'
import { setEditorHotkeys } from '../src/services/editorHotkeys.js'

test('native preference failures are not announced as saved or broadcast as shortcuts', async () => {
  const old = globalThis.window, events = [], writes = []
  globalThis.window = {
    electronAPI: { setSetting: async (key, value) => { writes.push({ key, value }); return { success: false, error: 'Test storage failure' } } },
    dispatchEvent: event => events.push(event),
  }
  try {
    await assert.rejects(setPexelsApiKey('synthetic-key'), /Test storage failure/)
    await assert.rejects(setEditorHotkeys({}), /Test storage failure/)
    assert.deepEqual(writes.map(write => write.key), ['pexelsApiKey', 'editorHotkeys'])
    assert.equal(events.length, 0)
  } finally { globalThis.window = old }
})
