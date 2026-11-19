import test from 'node:test'
import assert from 'node:assert/strict'
import { CONNECTED_AGENT_CONVERSATION_LIMITS as LIMITS, createConnectedAgentConversationStore,
  getConnectedAgentConversationKey, getConnectedAgentChatSelection } from './connectedAgentConversations.mjs'
import { CONNECTED_AGENT_LIMITS, createConnectedAgentHistoryStore, getConnectedAgentHistoryKey, formatConnectedAgentResponse } from './connectedAgentContext.mjs'

function memoryStorage(data = new Map()) {
  return { data, calls: [], getItem(key) { this.calls.push(['get', key]); return this.data.get(key) ?? null },
    setItem(key, value) { this.calls.push(['set', key]); this.data.set(key, value) },
    removeItem(key) { this.calls.push(['remove', key]); this.data.delete(key) } }
}

test('chat selections survive storage reload, switching and detached snapshots', () => {
  const storage = memoryStorage(), store = createConnectedAgentConversationStore({ storage })
  const a = store.create('model-project', 'codex', { model: 'model-a', reasoningEffort: 'low', token: 'do-not-save' })
  store.write('model-project', 'codex', a.activeId, [{ role: 'user', text: 'Old task' }])
  const b = store.create('model-project', 'codex', { model: 'model-b', reasoningEffort: 'high' })
  assert.notEqual(a.activeId, b.activeId)
  assert.deepEqual(b.conversations.find(chat => chat.id === b.activeId).messages, [])
  b.conversations.find(chat => chat.id === a.activeId).selection.model = 'changed-copy'
  const reloaded = createConnectedAgentConversationStore({ storage: memoryStorage(new Map(storage.data)) })
  const selected = reloaded.select('model-project', 'codex', a.activeId).conversations.find(chat => chat.id === a.activeId)
  assert.deepEqual(getConnectedAgentChatSelection(selected), { model: 'model-a', reasoningEffort: 'low' })
  assert.equal(selected.messages[0].text, 'Old task')
  assert.ok(!JSON.stringify([...storage.data]).includes('do-not-save'))
  const local = store.create('model-project', 'lmstudio', { model: 'local-model' })
  assert.equal(local.conversations.at(-1).selection.model, 'local-model')
  assert.equal(store.read('model-project', 'codex').conversations.length, b.conversations.length)
})

test('legacy model recovery uses recorded reply selection and preserves explicit Codex default', () => {
  assert.deepEqual(getConnectedAgentChatSelection({ messages: [{ role: 'assistant', text: 'Done', requestedModel: 'old-model', requestedReasoningEffort: 'low' }] }), { model: 'old-model', reasoningEffort: 'low' })
  assert.deepEqual(getConnectedAgentChatSelection({ selection: { model: '' }, messages: [{ role: 'assistant', requestedModel: 'other' }] }), { model: '' })
  assert.equal(getConnectedAgentChatSelection({ model: 'untrusted', messages: [{ role: 'assistant', text: 'I used model-a' }] }), undefined)
})
const messages = text => [{ role: 'user', text }]
const active = state => state.conversations.find(chat => chat.id === state.activeId)
const actions = storage => storage.calls.filter(([action]) => action !== 'get')
const reload = storage => createConnectedAgentConversationStore({ storage: memoryStorage(storage.data) })

test('verified local ComfyUI display survives true saved-history reload as inert prose only', () => {
  const storage = memoryStorage(), store = createConnectedAgentConversationStore({ storage })
  const initial = store.read('local-display-project', 'codex')
  const formatted = formatConnectedAgentResponse('Connected at **http://127.0.0.1:8000**. Docs https://docs.comfy.org/.', [], {
    allowPublicUrls: true, verifiedComfySetup: { success: true, integration: 'comfyui', state: 'ready', configuredPort: 8000,
      connections: [{ port: 8000, httpBase: 'http://127.0.0.1:8000' }] },
  })
  const saved = store.write('local-display-project', 'codex', initial.activeId, [{ role: 'assistant', ...formatted }])
  const freshStorage = memoryStorage(new Map(storage.data))
  const restored = createConnectedAgentConversationStore({ storage: freshStorage }).read('local-display-project', 'codex')
  assert.deepEqual(active(restored).messages, active(saved).messages)
  assert.equal(active(restored).messages[0].text, 'Connected at **local ComfyUI (127.0.0.1:8000)**. Docs https://docs.comfy.org/.')
  assert.deepEqual(active(restored).messages[0].sourceUrls, ['https://docs.comfy.org/'])
  assert.doesNotMatch(JSON.stringify([...storage.data]), /http:\/\/127|verifiedComfy|configuredPort|connections/)
  const legacy = store.write('local-display-project', 'codex', initial.activeId, [{ role: 'assistant', text: 'Connected at [link omitted].' }])
  assert.equal(active(legacy).messages[0].text, 'Connected at [link omitted].', 'Previously omitted values cannot be reconstructed')
})

test('initial reads are stable, detached, and never write storage', () => {
  const storage = memoryStorage(), store = createConnectedAgentConversationStore({ storage })
  const first = store.read('project', 'codex')
  assert.equal(first.conversations.length, 1)
  assert.equal(active(first).title, 'New chat')
  assert.deepEqual(active(first).messages, [])
  assert.equal(first.persistent, true)
  assert.deepEqual(createConnectedAgentConversationStore({ storage }).read('project', 'codex'), first)
  first.conversations[0].messages.push(...messages('Do not retain caller mutations.'))
  first.conversations[0].title = 'Caller mutation'
  assert.equal(active(store.read('project', 'codex')).title, 'New chat')
  assert.deepEqual(actions(storage), [])
  assert.deepEqual(store.read(null, 'codex'), { activeId: null, conversations: [], persistent: false })
  assert.equal(getConnectedAgentConversationKey('project', 'https://foreign'), null)
})

test('legacy migration preserves the first chat, is idempotent and read-only until an explicit mutation', () => {
  const storage = memoryStorage(), legacy = createConnectedAgentHistoryStore({ storage })
  const old = legacy.write('project', 'codex', [...messages('Review the opening\nThen the ending.'), { role: 'assistant', text: 'The opening is strong.' }])
  const oldKey = getConnectedAgentHistoryKey('project', 'codex')
  storage.calls.length = 0
  const store = createConnectedAgentConversationStore({ storage }), first = store.read('project', 'codex')
  assert.deepEqual(active(first).messages, old)
  assert.equal(active(first).title, 'Review the opening')
  assert.deepEqual(store.read('project', 'codex'), first)
  assert.deepEqual(actions(storage), [])
  assert.equal(storage.data.has(oldKey), true)
  const created = store.create('project', 'codex')
  assert.equal(created.conversations.length, 2)
  assert.equal(created.conversations[0].id, first.activeId)
  assert.deepEqual(created.conversations[0].messages, old)
  assert.deepEqual(active(created).messages, [])
  assert.equal(storage.data.has(oldKey), false)
  assert.deepEqual(actions(storage).map(([action]) => action), ['set', 'remove'])
  assert.deepEqual(reload(storage).read('project', 'codex'), created)
})

test('project, provider, storage profile and object identities are strictly isolated', () => {
  const firstStorage = memoryStorage(), secondStorage = memoryStorage()
  const first = createConnectedAgentConversationStore({ storage: firstStorage }), second = createConnectedAgentConversationStore({ storage: secondStorage })
  const key = '/private/projects/film-A'
  first.write(key, 'codex', first.read(key, 'codex').activeId, messages('Only A and Codex.'))
  assert.deepEqual(active(first.read('/private/projects/film-B', 'codex')).messages, [])
  assert.deepEqual(active(first.read(key, 'lmstudio')).messages, [])
  assert.deepEqual(active(second.read(key, 'codex')).messages, [])
  const handle = { name: 'Same name', path: '/private/handle' }, other = { ...handle }
  const objectChat = first.read(handle, 'codex')
  first.write(handle, 'codex', objectChat.activeId, messages('Object scoped.'))
  assert.equal(active(createConnectedAgentConversationStore({ storage: firstStorage }).read(handle, 'codex')).messages[0].text, 'Object scoped.')
  assert.deepEqual(active(first.read(other, 'codex')).messages, [])
  assert.deepEqual(active(second.read(handle, 'codex')).messages, [])
  assert.equal(first.read(handle, 'codex').persistent, false)
  assert.doesNotMatch([...firstStorage.data.keys(), ...firstStorage.data.values()].join(), /private|Same name|Object scoped/)
  assert.equal(secondStorage.data.size, 0)
})

test('legacy global object-key fallback cannot leak into another storage profile', () => {
  const storageA = memoryStorage(), storageB = memoryStorage(), handle = { name: 'Same name' }
  createConnectedAgentHistoryStore({ storage: storageA }).write(handle, 'codex', messages('Private legacy profile.'))
  assert.deepEqual(active(createConnectedAgentConversationStore({ storage: storageB }).read(handle, 'codex')).messages, [])
})

test('create, select, write and exact removal persist independent conversations without changing unrelated keys', () => {
  const storage = memoryStorage(new Map([['unrelated.preference', 'untouched']]))
  const store = createConnectedAgentConversationStore({ storage }), firstId = store.read('project', 'codex').activeId
  store.write('project', 'codex', firstId, messages('First conversation'))
  const second = store.create('project', 'codex'), secondId = second.activeId
  assert.notEqual(secondId, firstId)
  store.write('project', 'codex', secondId, messages('Second conversation'))
  let state = store.select('project', 'codex', firstId)
  assert.equal(active(state).title, 'First conversation')
  assert.equal(reload(storage).read('project', 'codex').activeId, firstId)
  state = store.remove('project', 'codex', secondId)
  assert.equal(state.activeId, firstId)
  assert.equal(state.conversations.length, 1)
  assert.equal(storage.data.get('unrelated.preference'), 'untouched')
  const before = JSON.stringify(state), count = actions(storage).length
  assert.equal(JSON.stringify(store.write('project', 'codex', secondId, messages('Late reply must not recreate.'))), before)
  assert.equal(JSON.stringify(store.select('project', 'codex', 'unknown')), before)
  assert.equal(JSON.stringify(store.remove('project', 'codex', 'unknown')), before)
  assert.equal(actions(storage).length, count)
})

test('deleting the active chat chooses a survivor; deleting last creates a fresh empty chat with no legacy resurrection', () => {
  const storage = memoryStorage()
  createConnectedAgentHistoryStore({ storage }).write('project', 'codex', messages('Legacy conversation'))
  const store = createConnectedAgentConversationStore({ storage }), legacyId = store.read('project', 'codex').activeId
  const created = store.create('project', 'codex')
  assert.equal(store.remove('project', 'codex', created.activeId).activeId, legacyId)
  const removed = store.remove('project', 'codex', legacyId)
  assert.notEqual(removed.activeId, legacyId)
  assert.deepEqual(active(removed).messages, [])
  assert.deepEqual(reload(storage).read('project', 'codex'), removed)
  assert.deepEqual(store.write('project', 'codex', legacyId, messages('Late stale response')), removed)
})

test('all persisted fields are allowlisted and text/title are redacted and bounded', () => {
  const storage = memoryStorage(), store = createConnectedAgentConversationStore({ storage }), id = store.read('project', 'codex').activeId
  const result = store.write('project', 'codex', id, [{ role: 'user', text: 'Review /private/frame.png password=private-value\n' + 'x'.repeat(200),
    requestId: 'private-request', images: ['data:image/png;base64,private'], context: { secret: true }, handle: { path: '/private' } },
  { role: 'assistant', text: 'Helpful reply', shotIds: ['shot-7', '/private/shot'], toolCalls: ['private'] }, { role: 'system', text: 'private-system' }])
  assert.ok(active(result).title.length <= LIMITS.titleCharacters)
  assert.equal(active(result).messages.length, 2)
  assert.deepEqual(active(result).messages[1].shotIds, ['shot-7'])
  const raw = storage.data.get(getConnectedAgentConversationKey('project', 'codex'))
  assert.doesNotMatch(raw, /private-value|\/private|private-request|data:image|context|handle|images|toolCalls|private-system/)
  const loaded = JSON.parse(raw)
  loaded.conversations[0].context = { secret: 'do not expose' }
  loaded.conversations[0].title = '/private/path password=secret'
  loaded.conversations[0].messages[0].images = ['private']
  const isolated = memoryStorage(new Map([[getConnectedAgentConversationKey('project', 'codex'), JSON.stringify(loaded)]]))
  const clean = createConnectedAgentConversationStore({ storage: isolated }).read('project', 'codex')
  assert.doesNotMatch(JSON.stringify(clean), /do not expose|\/private|images/)
  assert.deepEqual(actions(isolated), [])
  clean.conversations[0].messages[1].shotIds.push('caller-mutation')
  assert.deepEqual(active(store.read('project', 'codex')).messages[1].shotIds, ['shot-7'])
})

test('malformed, unknown-version, duplicate-ID and oversized durable data are preserved, not overwritten or migrated over', () => {
  const valid = { version: 1, activeId: 'chat-a', conversations: [{ id: 'chat-a', messages: messages('Saved'), createdAt: 1, updatedAt: 1 }] }
  for (const raw of ['not JSON', 'null', JSON.stringify({ ...valid, version: 99 }), JSON.stringify({ ...valid, activeId: 'missing' }),
    JSON.stringify({ ...valid, conversations: [] }), JSON.stringify({ ...valid, conversations: [...valid.conversations, ...valid.conversations] }),
    JSON.stringify({ ...valid, conversations: [{ ...valid.conversations[0], messages: {} }] }),
    JSON.stringify({ ...valid, conversations: [{ ...valid.conversations[0], messages: [{ role: 'user', text: 42 }] }] }),
    JSON.stringify({ ...valid, conversations: [{ ...valid.conversations[0], messages: [{ role: 'user', text: 'Saved', shotIds: {} }] }] }),
    JSON.stringify({ ...valid, conversations: [{ ...valid.conversations[0], createdAt: null }] }), 'x'.repeat(LIMITS.storedCharacters + 1)]) {
    const key = getConnectedAgentConversationKey('project', 'codex'), oldKey = getConnectedAgentHistoryKey('project', 'codex')
    const storage = memoryStorage(new Map([[key, raw], [oldKey, JSON.stringify({ version: 1, messages: messages('Old legacy') })]]))
    const store = createConnectedAgentConversationStore({ storage }), first = store.read('project', 'codex')
    assert.equal(first.persistent, false)
    assert.match(first.warning, /not been replaced/)
    assert.deepEqual(active(first).messages, [])
    const written = store.write('project', 'codex', first.activeId, messages('New session'))
    assert.equal(active(written).messages[0].text, 'New session')
    store.create('project', 'codex')
    assert.equal(storage.data.get(key), raw)
    assert.equal(storage.data.has(oldKey), true)
    assert.deepEqual(actions(storage), [])
  }
})

test('malformed or oversized legacy history remains intact while new messages use session memory', () => {
  for (const raw of ['bad JSON', JSON.stringify({ version: 2, messages: [] }), JSON.stringify({ version: 1, messages: {} }),
    JSON.stringify({ version: 1, messages: [{ role: 'user', text: 42 }] }), 'x'.repeat(CONNECTED_AGENT_LIMITS.storedCharacters + 1)]) {
    const key = getConnectedAgentHistoryKey('project', 'codex'), storage = memoryStorage(new Map([[key, raw]]))
    const store = createConnectedAgentConversationStore({ storage }), first = store.read('project', 'codex')
    const result = store.write('project', 'codex', first.activeId, messages('Session message'))
    assert.equal(result.persistent, false)
    assert.equal(storage.data.get(key), raw)
    assert.deepEqual(actions(storage), [])
  }
})

test('legacy null-storage string histories migrate only into the matching renderer-session scope', () => {
  const key = 'legacy-session-only-project'
  createConnectedAgentHistoryStore().write(key, 'codex', messages('Existing session conversation'))
  const store = createConnectedAgentConversationStore(), state = store.read(key, 'codex')
  assert.equal(active(state).messages[0].text, 'Existing session conversation')
  assert.equal(state.persistent, false)
  assert.deepEqual(active(store.read(key, 'lmstudio')).messages, [])
  assert.deepEqual(active(createConnectedAgentConversationStore({ storage: memoryStorage() }).read(key, 'codex')).messages, [])
})

test('unreadable storage is not assumed absent, and null-storage sessions survive remount', () => {
  const storage = memoryStorage(); storage.getItem = () => { throw new Error('private failure') }
  const store = createConnectedAgentConversationStore({ storage }), first = store.read('project', 'codex')
  const written = store.write('project', 'codex', first.activeId, messages('Session only'))
  assert.equal(written.persistent, false)
  assert.doesNotMatch(written.warning, /private failure/)
  assert.deepEqual(actions(storage), [])
  assert.deepEqual(createConnectedAgentConversationStore({ storage }).read('project', 'codex'), written)
  const memory = createConnectedAgentConversationStore(), memoryId = memory.read('null-storage-project', 'codex').activeId
  memory.write('null-storage-project', 'codex', memoryId, messages('Renderer memory'))
  assert.equal(active(createConnectedAgentConversationStore().read('null-storage-project', 'codex')).messages[0].text, 'Renderer memory')
})

test('quota failure keeps latest messages and deletions authoritative across store instances, then retries safely', () => {
  const storage = memoryStorage(), store = createConnectedAgentConversationStore({ storage }), firstId = store.read('project', 'codex').activeId
  store.write('project', 'codex', firstId, messages('Older saved reply'))
  const originalSet = storage.setItem
  storage.setItem = () => { throw new Error('Quota exceeded') }
  const newer = store.write('project', 'codex', firstId, messages('Latest in-memory reply'))
  assert.equal(newer.persistent, false)
  assert.deepEqual(createConnectedAgentConversationStore({ storage }).read('project', 'codex'), newer)
  const deleted = store.remove('project', 'codex', firstId)
  assert.deepEqual(createConnectedAgentConversationStore({ storage }).read('project', 'codex'), deleted)
  assert.deepEqual(store.write('project', 'codex', firstId, messages('Late stale reply')), deleted)
  storage.setItem = originalSet
  const recovered = store.select('project', 'codex', deleted.activeId)
  assert.equal(recovered.persistent, true)
  assert.deepEqual(reload(storage).read('project', 'codex'), recovered)
})

test('legacy remains until destination save succeeds; cleanup failure warns but cannot resurrect deleted history', () => {
  const storage = memoryStorage(), oldKey = getConnectedAgentHistoryKey('project', 'codex')
  createConnectedAgentHistoryStore({ storage }).write('project', 'codex', messages('Legacy'))
  const store = createConnectedAgentConversationStore({ storage }), id = store.read('project', 'codex').activeId
  const originalSet = storage.setItem, originalRemove = storage.removeItem
  storage.setItem = () => { throw new Error('quota') }
  store.write('project', 'codex', id, messages('Updated'))
  assert.equal(storage.data.has(oldKey), true)
  storage.setItem = originalSet
  storage.removeItem = () => { throw new Error('blocked cleanup') }
  const deleted = store.remove('project', 'codex', id)
  assert.equal(deleted.persistent, false)
  assert.equal(storage.data.has(oldKey), true)
  assert.deepEqual(active(reload(storage).read('project', 'codex')).messages, [])
  assert.deepEqual(store.write('project', 'codex', id, messages('Late response')), deleted)
  storage.removeItem = originalRemove
  assert.equal(store.select('project', 'codex', deleted.activeId).persistent, true)
  assert.equal(storage.data.has(oldKey), false)
})

test('the 50-chat bound refuses a new chat without evicting any existing history', () => {
  const storage = memoryStorage(), store = createConnectedAgentConversationStore({ storage })
  for (let index = 1; index < LIMITS.conversations; index++) store.create('project', 'codex')
  const before = store.read('project', 'codex'), count = actions(storage).length
  assert.equal(before.conversations.length, 50)
  assert.equal(new Set(before.conversations.map(chat => chat.id)).size, 50)
  assert.throws(() => store.create('project', 'codex'), { code: 'CONVERSATION_LIMIT' })
  assert.deepEqual(store.read('project', 'codex'), before)
  assert.equal(actions(storage).length, count)
})

test('legacy cleanup retries after reload even when a previous save succeeded but removal failed', () => {
  const storage = memoryStorage(), oldKey = getConnectedAgentHistoryKey('project', 'codex')
  createConnectedAgentHistoryStore({ storage }).write('project', 'codex', messages('Legacy'))
  const store = createConnectedAgentConversationStore({ storage }), id = store.read('project', 'codex').activeId
  storage.removeItem = () => { throw new Error('temporary removal failure') }
  assert.equal(store.write('project', 'codex', id, messages('Updated')).persistent, false)
  assert.equal(storage.data.has(oldKey), true)
  const fresh = reload(storage)
  const removed = fresh.remove('project', 'codex', id)
  assert.equal(removed.persistent, true)
  assert.equal(storage.data.has(oldKey), false)
  assert.deepEqual(active(reload(storage).read('project', 'codex')).messages, [])
})

test('the established first-prompt title survives message-window trimming and reload', () => {
  const storage = memoryStorage(), store = createConnectedAgentConversationStore({ storage }), id = store.read('project', 'codex').activeId
  store.write('project', 'codex', id, messages('Keep this original title'))
  const long = Array.from({ length: CONNECTED_AGENT_LIMITS.messages + 4 }, (_, index) => ({ role: 'user', text: `Later prompt ${index}` }))
  const result = store.write('project', 'codex', id, long)
  assert.equal(active(result).messages.length, CONNECTED_AGENT_LIMITS.messages)
  assert.equal(active(result).title, 'Keep this original title')
  const fresh = reload(storage)
  assert.equal(active(fresh.read('project', 'codex')).title, 'Keep this original title')
  assert.equal(active(fresh.write('project', 'codex', id, messages('Even later prompt'))).title, 'Keep this original title')
})

test('oversized aggregate stays bounded in memory without losing the latest reply, and persists after shrinking', () => {
  const storage = memoryStorage(), store = createConnectedAgentConversationStore({ storage })
  const large = Array.from({ length: 7 }, () => ({ role: 'assistant', text: 'x'.repeat(CONNECTED_AGENT_LIMITS.text), requestedModel: 'm'.repeat(256) }))
  let state = store.read('project', 'codex')
  for (let index = 0; index < 27; index++) {
    if (index) state = store.create('project', 'codex')
    state = store.write('project', 'codex', state.activeId, large)
  }
  assert.equal(state.conversations.length, 27)
  assert.equal(state.persistent, false)
  assert.ok(state.conversations.every(chat => JSON.stringify(chat.messages).length <= CONNECTED_AGENT_LIMITS.historyCharacters))
  assert.deepEqual(createConnectedAgentConversationStore({ storage }).read('project', 'codex'), state)
  assert.ok(storage.data.get(getConnectedAgentConversationKey('project', 'codex')).length <= LIMITS.storedCharacters)
  while (!state.persistent) state = store.remove('project', 'codex', state.conversations[0].id)
  assert.deepEqual(reload(storage).read('project', 'codex'), state)
})

test('source references round-trip as detached display metadata, never research permission', () => {
  const storage = memoryStorage(), store = createConnectedAgentConversationStore({ storage })
  const id = store.read('source-project', 'codex').activeId
  const url = 'https://github.com/public/workflow'
  const sourceUrls = [url]
  const saved = store.write('source-project', 'codex', id, [{ role: 'user', text: `Read ${url}`, sourceUrls, researchEnabled: true }])
  sourceUrls.push('https://github.com/mutated/input')
  assert.deepEqual(active(saved).messages, [{ role: 'user', text: `Read ${url}`, sourceUrls: [url] }])
  active(saved).messages[0].sourceUrls.push('https://github.com/mutated/snapshot')
  const read = store.read('source-project', 'codex')
  assert.deepEqual(active(read).messages[0].sourceUrls, [url])
  active(read).messages[0].sourceUrls.length = 0
  assert.deepEqual(active(store.read('source-project', 'codex')).messages[0].sourceUrls, [url])
  assert.deepEqual(active(reload(storage).read('source-project', 'codex')).messages, [{ role: 'user', text: `Read ${url}`, sourceUrls: [url] }])
  assert.deepEqual(active(store.read('source-project', 'lmstudio')).messages, [])
})

test('per-reply requested models persist through reload and chat switches without changing project/provider separation', () => {
  const storage = memoryStorage(), store = createConnectedAgentConversationStore({ storage })
  const firstId = store.read('model-project', 'codex').activeId
  const firstMessages = [...messages('Compare the opening.'), { role: 'assistant', text: 'First choice.', requestedModel: 'gpt-6-astra' },
    { role: 'assistant', text: 'Default choice.', requestedModel: '' }, { role: 'assistant', text: 'Legacy reply.' }]
  const saved = store.write('model-project', 'codex', firstId, firstMessages)
  firstMessages[1].requestedModel = 'mutated-input'
  active(saved).messages[1].requestedModel = 'mutated-result'
  const secondId = store.create('model-project', 'codex').activeId
  store.write('model-project', 'codex', secondId, [{ role: 'assistant', text: 'Custom choice.', requestedModel: 'custom/Exact-ID@revision+variant' }])
  const localId = store.read('model-project', 'lmstudio').activeId
  store.write('model-project', 'lmstudio', localId, [{ role: 'assistant', text: 'Local choice.', requestedModel: 'qwen/qwen3-4b:Q4_K_M' }])
  const first = store.select('model-project', 'codex', firstId)
  assert.deepEqual(active(first).messages.map(message => message.requestedModel), [undefined, 'gpt-6-astra', '', undefined])
  assert.equal(Object.hasOwn(active(first).messages[3], 'requestedModel'), false)
  const fresh = reload(storage)
  assert.deepEqual(fresh.read('model-project', 'codex'), first)
  assert.equal(active(fresh.select('model-project', 'codex', secondId)).messages[0].requestedModel, 'custom/Exact-ID@revision+variant')
  assert.equal(active(fresh.read('model-project', 'lmstudio')).messages[0].requestedModel, 'qwen/qwen3-4b:Q4_K_M')
  assert.deepEqual(active(fresh.read('other-project', 'codex')).messages, [])
  assert.equal(JSON.parse(storage.data.get(getConnectedAgentConversationKey('model-project', 'codex'))).version, 1)
})

test('legacy migration preserves recorded requested models but never derives missing identity from other saved fields', () => {
  const legacyMessages = [{ role: 'user', text: 'Opening?', requestedModel: 'not-user-metadata' },
    { role: 'assistant', text: 'Older reply.', model: 'gpt-6-astra', provider: 'codex' },
    { role: 'assistant', text: 'Recorded default.', requestedModel: '' },
    { role: 'assistant', text: 'Recorded custom.', requestedModel: 'custom/Retained-ID' }]
  const oldKey = getConnectedAgentHistoryKey('model-project', 'codex')
  const raw = JSON.stringify({ version: 1, messages: legacyMessages, model: 'do-not-backfill' })
  const storage = memoryStorage(new Map([[oldKey, raw]])), store = createConnectedAgentConversationStore({ storage })
  const first = store.read('model-project', 'codex')
  const expected = [{ role: 'user', text: 'Opening?' }, { role: 'assistant', text: 'Older reply.' },
    { role: 'assistant', text: 'Recorded default.', requestedModel: '' },
    { role: 'assistant', text: 'Recorded custom.', requestedModel: 'custom/Retained-ID' }]
  assert.deepEqual(active(first).messages, expected)
  assert.equal(Object.hasOwn(active(first).messages[1], 'requestedModel'), false)
  assert.equal(storage.data.get(oldKey), raw)
  assert.deepEqual(actions(storage), [])
  const migrated = store.create('model-project', 'codex')
  assert.deepEqual(migrated.conversations[0].messages, expected)
  assert.equal(storage.data.has(oldKey), false)
  assert.deepEqual(reload(storage).read('model-project', 'codex'), migrated)
})

test('invalid requested model extras are discarded on saved-chat reload without rejecting or rewriting compatible messages', () => {
  const invalid = [null, {}, ['gpt-6-astra'], 7, 'a'.repeat(257), 'https://user:password@host.example/model',
    '/private/model.gguf', '<script>alert(1)</script>', 'sk-01234567890123456789', 'org/model\n']
  const chatMessages = [{ role: 'user', text: 'A prompt.', requestedModel: 'gpt-6-astra' },
    ...invalid.map(requestedModel => ({ role: 'assistant', text: 'Usable reply.', requestedModel })),
    { role: 'assistant', text: 'Legacy unchanged.' }, { role: 'assistant', text: 'Explicit default.', requestedModel: '' }]
  const key = getConnectedAgentConversationKey('model-project', 'codex')
  const raw = JSON.stringify({ version: 1, activeId: 'chat-a', conversations: [{ id: 'chat-a', title: 'A prompt.',
    messages: chatMessages, createdAt: 1, updatedAt: 1 }] })
  const storage = memoryStorage(new Map([[key, raw]]))
  const state = createConnectedAgentConversationStore({ storage }).read('model-project', 'codex')
  assert.equal(state.persistent, true)
  assert.equal(state.warning, undefined)
  assert.equal(active(state).messages.length, chatMessages.length)
  assert.ok(active(state).messages.slice(0, -1).every(message => !Object.hasOwn(message, 'requestedModel')))
  assert.equal(active(state).messages.at(-1).requestedModel, '')
  assert.equal(storage.data.get(key), raw)
  assert.deepEqual(actions(storage), [])
})
